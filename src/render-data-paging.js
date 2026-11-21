'use strict';
/**
 * render-data-paging.js —— R-20261121-204514-e31b（壳渲染层内存治理）纯逻辑：
 *   1) 任务摘要投影/分页（workflow:tasks-summary）
 *   2) 团队邮箱消息分页（messages:page，按项目过滤、不含 body）
 *   3) 工作区目录单层懒加载（files:list 新形态，越界拒绝、禁 .git/node_modules）
 * 只依赖 node:fs / node:path；所有异常带 code，供 IPC 原样返回。
 */

const fs = require('node:fs');
const path = require('node:path');

const TASK_SUMMARY_FIELDS = ['id', 'title', 'status', 'owner', 'priority', 'updatedAt', 'requirementId'];
const TASK_LIMIT_DEFAULT = 500;
const TASK_LIMIT_MAX = 2000;
const MESSAGE_LIMIT_DEFAULT = 50;
const MESSAGE_LIMIT_MAX = 200;
const FILES_LIMIT_DEFAULT = 500;
const FILES_LIMIT_MAX = 500;
const FORBIDDEN_SEGMENTS = new Set(['.git', 'node_modules']);

function codedError(code, message, extra = {}) {
  const error = new Error(message);
  error.code = code;
  Object.assign(error, extra);
  return error;
}

/** 数字参数归一：非法（0/负/非数/超上限）→ 回落默认值，并标记 badArg 供审计。 */
function boundedInt(value, fallback, min, max) {
  const raw = Number(value);
  if (!Number.isFinite(raw) || Math.floor(raw) !== raw || raw < min || raw > max) {
    return { value: fallback, bad: true };
  }
  return { value: raw, bad: false };
}

function taskSummaryOf(task) {
  const src = task && typeof task === 'object' ? task : {};
  const out = {};
  for (const key of TASK_SUMMARY_FIELDS) out[key] = src[key] === undefined || src[key] === null ? '' : String(src[key]);
  return out;
}

/** app:state 仍要挂一条摘要给旧面板用：7 字段 + UI 旧字段 role/requirementId（不携带大字段）。 */
function taskUiSummaryOf(task) {
  const src = task && typeof task === 'object' ? task : {};
  return {
    ...taskSummaryOf(src),
    role: String(src.role || ''),
    requirementId: String(src.requirementId || ''),
    type: String(src.type || '')
  };
}

function buildTasksSummary(tasks, options = {}) {
  const list = Array.isArray(tasks) ? tasks.filter((row) => row && typeof row === 'object') : [];
  const status = String(options.status || '');
  const owner = String(options.owner || '');
  const filtered = list.filter((task) => (!status || String(task.status || '') === status)
    && (!owner || String(task.owner || '') === owner));
  const offsetRaw = Number(options.offset);
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0;
  const limitInfo = boundedInt(options.limit, TASK_LIMIT_DEFAULT, 1, TASK_LIMIT_MAX);
  const page = filtered.slice(offset, offset + limitInfo.value).map(taskSummaryOf);
  return {
    items: page,
    total: filtered.length,
    shown: page.length,
    limit: limitInfo.value,
    offset,
    badArg: limitInfo.bad
  };
}

function safeParseJson(line) {
  try { return JSON.parse(String(line).replace(/^\uFEFF/, '')); } catch { return null; }
}

/**
 * 把若干角色的 messages.jsonl 行解析成消息页。
 * roleLines: [{ role, lines: string[] }]；同一 id 去重（取首个），read 取任一角色 read 事件。
 */
function buildMessagesPage(roleLines, options = {}) {
  const project = String(options.project || '');
  const limitInfo = boundedInt(options.limit, MESSAGE_LIMIT_DEFAULT, 1, MESSAGE_LIMIT_MAX);
  const offsetRaw = Number(options.offset);
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0;
  const readIds = new Set();
  const byId = new Map();
  const groups = Array.isArray(roleLines) ? roleLines : [];
  for (const group of groups) {
    const lines = group && Array.isArray(group.lines) ? group.lines : [];
    for (const line of lines) {
      const row = safeParseJson(line);
      if (!row) continue;
      if (String(row.type || '') === 'event' || row.event) {
        const event = String(row.event || '');
        if (event === 'read' && row.refId) readIds.add(String(row.refId));
        continue;
      }
      if (project && String(row.project || '') && String(row.project) !== project) continue;
      const id = String(row.id || '');
      if (!id || byId.has(id)) continue;
      byId.set(id, {
        id,
        from: String(row.from || ''),
        to: String(row.to || ''),
        subject: String(row.subject || ''),
        at: String(row.at || row.ts || row.deliveredAt || ''),
        read: Boolean(row.read) || readIds.has(id),
        hasTask: Boolean(String(row.task || '')),
        seq: Number(row.seq) || 0
      });
    }
  }
  // 第二轮补 read：read 事件可能出现在扫描到该消息之后的角色文件里。
  for (const row of byId.values()) if (readIds.has(row.id)) row.read = true;
  const all = Array.from(byId.values()).sort((a, b) => {
    if (a.at !== b.at) return b.at.localeCompare(a.at);
    return (b.seq || 0) - (a.seq || 0) || b.id.localeCompare(a.id);
  });
  const items = all.slice(offset, offset + limitInfo.value).map(({ seq, ...rest }) => rest);
  return {
    items,
    total: all.length,
    offset,
    limit: limitInfo.value,
    badArg: limitInfo.bad
  };
}

function normalizeRelDir(dir) {
  return String(dir === undefined || dir === null ? '' : dir).replace(/\\/g, '/').replace(/^\.\/+/, '').replace(/\/+$/, '');
}

function assertDirSegmentsSafe(normalized) {
  const raw = String(normalized || '');
  if (!raw) return [];
  if (path.isAbsolute(raw) || /^[A-Za-z]:/.test(raw)) {
    throw codedError('FILES_DIR_OUTSIDE', '只允许工作区根内的相对目录', { dir: raw });
  }
  const segments = raw.split('/').filter(Boolean);
  for (const segment of segments) {
    if (segment === '..' || FORBIDDEN_SEGMENTS.has(segment)) {
      throw codedError('FILES_DIR_OUTSIDE', `目录越界或禁止访问：${segment}`, { dir: raw });
    }
  }
  return segments;
}

function isInsideRoot(rootReal, targetReal) {
  const root = String(rootReal || '').toLowerCase();
  const target = String(targetReal || '').toLowerCase();
  return Boolean(root && target && (target === root || target.startsWith(root + path.sep)));
}

/**
 * 单层目录懒加载。返回 {items:[{name,isDir,size,mtime}],dir,truncated,count,limit}。
 * 越界/禁止目录抛 FILES_DIR_OUTSIDE；目录不存在抛 FILES_DIR_NOT_FOUND。
 * 读取前先做路径校验，越界路径一次 readdir 都不做。
 */
function buildFilesPage(input = {}, io = {}) {
  const fsApi = io.fs || fs;
  const root = String(input.root || '');
  if (!root) throw codedError('FILES_ROOT_MISSING', '缺少工作区根目录');
  let rootReal = '';
  try { rootReal = fsApi.realpathSync.native ? fsApi.realpathSync.native(root) : fsApi.realpathSync(root); } catch {
    throw codedError('FILES_ROOT_MISSING', '工作区根目录不存在：' + root);
  }
  const normalized = normalizeRelDir(input.dir);
  const segments = assertDirSegmentsSafe(normalized);
  const target = path.resolve(rootReal, ...segments);
  if (!isInsideRoot(rootReal, target)) throw codedError('FILES_DIR_OUTSIDE', '只允许工作区根内的相对目录', { dir: normalized });
  let targetReal = '';
  try { targetReal = fsApi.realpathSync.native ? fsApi.realpathSync.native(target) : fsApi.realpathSync(target); } catch {
    throw codedError('FILES_DIR_NOT_FOUND', '目录不存在：' + (normalized || '.'), { dir: normalized || '.' });
  }
  if (!isInsideRoot(rootReal, targetReal)) throw codedError('FILES_DIR_OUTSIDE', '目录越界（符号链接指向工作区外）', { dir: normalized });
  let stat = null;
  try { stat = fsApi.statSync(targetReal); } catch { stat = null; }
  if (!stat || !stat.isDirectory()) throw codedError('FILES_DIR_NOT_FOUND', '不是目录：' + (normalized || '.'), { dir: normalized || '.' });
  const limitInfo = boundedInt(input.limit, FILES_LIMIT_DEFAULT, 1, FILES_LIMIT_MAX);
  let entries = [];
  try { entries = fsApi.readdirSync(targetReal, { withFileTypes: true }); } catch {
    throw codedError('FILES_DIR_UNREADABLE', '目录读取失败：' + (normalized || '.'), { dir: normalized || '.' });
  }
  const items = [];
  for (const entry of entries) {
    const name = String(entry.name || '');
    if (!name || FORBIDDEN_SEGMENTS.has(name)) continue;
    const full = path.join(targetReal, name);
    let itemStat = null;
    try {
      if (entry.isSymbolicLink && entry.isSymbolicLink()) {
        const real = fsApi.realpathSync.native ? fsApi.realpathSync.native(full) : fsApi.realpathSync(full);
        if (!isInsideRoot(rootReal, real)) continue;
        itemStat = fsApi.statSync(real);
      } else {
        itemStat = fsApi.statSync(full);
      }
    } catch { continue; }
    if (!itemStat) continue;
    items.push({
      name,
      rel: normalized ? normalized + '/' + name : name,
      isDir: itemStat.isDirectory(),
      size: itemStat.isDirectory() ? 0 : itemStat.size,
      mtime: itemStat.mtime instanceof Date ? itemStat.mtime.toISOString() : ''
    });
  }
  items.sort((a, b) => (a.isDir === b.isDir ? a.name.localeCompare(b.name, 'zh-CN') : (a.isDir ? -1 : 1)));
  const truncated = items.length > limitInfo.value;
  return {
    items: items.slice(0, limitInfo.value),
    dir: normalized || '.',
    truncated,
    count: items.length,
    limit: limitInfo.value,
    badArg: limitInfo.bad
  };
}

/**
 * 把 project.messages（本地镜像数组）投影成分页结果：at 倒序、items 不含 body。
 * 三字段映射：read=Boolean(msg.read||msg.readAt)，hasTask=Boolean(msg.taskId||msg.task||msg.ackRequired)。
 */
function buildLocalMessagesPage(messages, options = {}) {
  const list = Array.isArray(messages) ? messages.filter((row) => row && typeof row === 'object') : [];
  const limitInfo = boundedInt(options.limit, MESSAGE_LIMIT_DEFAULT, 1, MESSAGE_LIMIT_MAX);
  const offsetRaw = Number(options.offset);
  const offset = Number.isFinite(offsetRaw) && offsetRaw >= 0 ? Math.floor(offsetRaw) : 0;
  const all = list.slice().sort((a, b) => String((b && b.at) || '').localeCompare(String((a && a.at) || '')));
  const items = all.slice(offset, offset + limitInfo.value).map((msg) => ({
    id: String(msg.id || ''),
    from: String(msg.from || ''),
    to: String(msg.to || ''),
    subject: String(msg.subject || ''),
    at: String(msg.at || ''),
    read: Boolean(msg.read || msg.readAt),
    hasTask: Boolean(msg.taskId || msg.task || msg.ackRequired)
  }));
  return {
    items,
    total: all.length,
    offset,
    limit: limitInfo.value,
    badArg: limitInfo.bad
  };
}

/** 序列化字节数（用于夹具做改造前后对比，不参与运行时）。 */
function jsonBytes(value) {
  try { return Buffer.byteLength(JSON.stringify(value) || '', 'utf8'); } catch { return 0; }
}

module.exports = {
  TASK_SUMMARY_FIELDS,
  TASK_LIMIT_DEFAULT,
  TASK_LIMIT_MAX,
  MESSAGE_LIMIT_DEFAULT,
  MESSAGE_LIMIT_MAX,
  FILES_LIMIT_DEFAULT,
  FILES_LIMIT_MAX,
  boundedInt,
  codedError,
  taskSummaryOf,
  taskUiSummaryOf,
  buildTasksSummary,
  buildMessagesPage,
  buildLocalMessagesPage,
  buildFilesPage,
  jsonBytes
};
