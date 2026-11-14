// R-8514 全员记忆规范 · project 记忆核查（只读，不写记忆库）
//
// 记忆库固定路径（与 dsh-memory-evolve 一致）：
//   <DSH_HOME>/memories/projects/<workspace-key>/MEMORY.md  （project 记忆）
//   <DSH_HOME>/memories/projects/<workspace-key>/TODOS.md   （待办）
// workspace-key = sha1(项目绝对路径).slice(0,12)，与插件 store.js 同算法。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { ROLE_NAMES, ROLE_DIRS } from './roles.mjs';

/** DSH_HOME：优先环境变量（selftest 可指向沙盘），否则用户目录下 .dsh；不硬编码本机路径。 */
export function memoryHome() {
  const dsh = String(process.env.DSH_HOME || '').trim();
  if (dsh) return path.resolve(dsh);
  const home = process.env.USERPROFILE || process.env.HOME || '';
  return path.join(home, '.dsh');
}

export function workspaceKey(projectPath) {
  return crypto.createHash('sha1').update(String(projectPath || '')).digest('hex').slice(0, 12);
}

export function memoryStorePaths(projectPath, home = memoryHome()) {
  const key = workspaceKey(projectPath);
  const dir = path.join(home, 'memories', 'projects', key);
  return { home, key, dir, memory: path.join(dir, 'MEMORY.md'), todos: path.join(dir, 'TODOS.md') };
}

function readEntries(file) {
  if (!fs.existsSync(file)) return [];
  const entries = [];
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
  // MEMORY.md 一条一块，块之间用单独一行 § 分隔；块内一行视为一条记忆。
  for (const block of text.split(/^§\s*$/m)) {
    for (const raw of block.split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      entries.push({ file, line, hash: crypto.createHash('sha1').update(line).digest('hex').slice(0, 12) });
    }
  }
  return entries;
}

/**
 * 角色覆盖判定（复核-v4 P1-2）：
 *  - 英文角色 id 按 token 边界匹配（`pm` 不再命中 `npm`，`programmer1` 不再命中 `programmer10`）；
 *  - 中文角色名 / 角色目录名按精确字符串包含（中文无词边界，用足够长的专名避免歧义）；
 *  - 目录名“产品”过于宽泛（会命中“产品设计/产品评审”），只用“路径段”形式（如 产出 产品/产出/…），
 *    不把裸“产品”当别名，避免按角色抽检假阳性。
 * 不做 line.includes(role) 的裸子串匹配，避免按角色抽检假阳性/假阴性。
 */
const IDENT_CHARS = 'A-Za-z0-9_-';
const CJK_CHARS = '\\u4e00-\\u9fff';
function escapeRe(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
export function roleMatcher(role) {
  const id = String(role || '');
  if (!id) return () => true;
  const idRe = new RegExp(`(?<![${IDENT_CHARS}])${escapeRe(id)}(?![${IDENT_CHARS}])`, 'i');
  const dir = ROLE_DIRS[role] || '';
  const aliases = [ROLE_NAMES[role] || '', dir === '产品' ? '' : dir].filter(Boolean);
  // 目录作为路径段命中（前面不能紧贴中文/标识符，避免“热产品/”这种普通词组误判）。
  const dirPathRe = dir
    ? new RegExp(`(?<![${CJK_CHARS}${IDENT_CHARS}])${escapeRe(dir)}/`)
    : null;
  return (line) => {
    const text = String(line || '');
    if (idRe.test(text)) return true;
    if (dirPathRe && dirPathRe.test(text)) return true;
    return aliases.some((alias) => text.includes(alias));
  };
}

/**
 * 警告级 lint（R-8b9d）：条目超长、同任务重复过多只提示，不阻断；--strict 才失败。
 * 规则固定，不开放自定义阈值，避免“每人一套标准”。
 */
export const LINT_MAX_ENTRY_CHARS = 300;
export const LINT_MAX_TASK_REPEAT = 3;
const TASK_ID_RE = /\b([TBR]-\d{8}-\d{6}-[0-9a-z]{4,8})\b/gi;

export function lintMemoryEntries(entries) {
  const warnings = [];
  for (const e of entries || []) {
    const len = String((e && e.line) || '').length;
    if (len > LINT_MAX_ENTRY_CHARS) {
      warnings.push({
        code: 'ENTRY_TOO_LONG', hash: e.hash, length: len, max: LINT_MAX_ENTRY_CHARS,
        message: `条目 ${e.hash} 长度 ${len} 字，超过 ${LINT_MAX_ENTRY_CHARS} 字（建议拆成 1 条进展 + 详情文档）`,
      });
    }
  }
  const firstSeen = new Map();
  const counts = new Map();
  for (const e of entries || []) {
    const ids = new Set((String((e && e.line) || '').match(TASK_ID_RE) || []));
    for (const id of ids) {
      const key = String(id).toLowerCase();
      if (!firstSeen.has(key)) firstSeen.set(key, String(id));
      counts.set(key, (counts.get(key) || 0) + 1);
    }
  }
  for (const [key, count] of counts) {
    if (count > LINT_MAX_TASK_REPEAT) {
      const taskId = firstSeen.get(key) || key;
      warnings.push({
        code: 'DUPLICATE_TASK', taskId, count, max: LINT_MAX_TASK_REPEAT,
        message: `任务 ${taskId} 在记忆里出现 ${count} 次，超过 ${LINT_MAX_TASK_REPEAT} 次（同任务只留最新 1 条，历史归档）`,
      });
    }
  }
  return {
    ok: warnings.length === 0,
    warnings,
    rules: { maxEntryChars: LINT_MAX_ENTRY_CHARS, maxTaskRepeat: LINT_MAX_TASK_REPEAT },
  };
}

/**
 * 只读核查：按任务 id/角色查 project 记忆。
 * required=true（P0）且未命中 → code=MEMORY_MISSING；非 P0 未命中 → MEMORY_ABSENT_WARN（只告警）。
 * 给了 role 时，found 必须同时满足“任务命中 + 角色覆盖命中”（复核-v4 P1-2）。
 * 记忆库不可读时 readable=false，命令不默认通过（unknown 降级人工抽检）。
 */
export function memoryCheck({ projectPath, taskId = '', role = '', required = false, home = memoryHome() }) {
  const store = memoryStorePaths(projectPath, home);
  const readable = fs.existsSync(store.memory);
  const all = readEntries(store.memory);
  const taskKey = String(taskId || '').toLowerCase();
  const roleHit = roleMatcher(role);
  const taskEntries = taskKey ? all.filter((e) => e.line.toLowerCase().includes(taskKey)) : all;
  const entries = role ? taskEntries.filter((e) => roleHit(e.line)) : taskEntries;
  // 角色覆盖参与判定：给了 role 就以“任务命中且属于该角色”的条目为准。
  const found = entries.length > 0;
  const missing = [];
  if (!readable) missing.push(`记忆库不可读：${store.memory}（按 unknown 降级，不默认通过）`);
  else if (!found) {
    if (!taskKey) missing.push(role ? `缺少 ${role} 的 project 记忆` : '缺少 project 记忆');
    else if (!taskEntries.length) missing.push(`缺少含任务 ${taskId} 的 project 记忆`);
    else missing.push(`任务 ${taskId} 有记忆，但没有 ${role || '(未指定角色)'} 的条目（按角色覆盖抽检）`);
  }
  return {
    ok: found || !required,
    project: path.basename(String(projectPath || '')),
    taskId: String(taskId || ''),
    role: String(role || ''),
    required: Boolean(required),
    found,
    readable,
    missing,
    entries,
    lint: lintMemoryEntries(all),
    store: { key: store.key, dir: store.dir, memory: store.memory, todos: store.todos },
    code: found ? 'OK' : (required ? 'MEMORY_MISSING' : 'MEMORY_ABSENT_WARN'),
    checkedAt: new Date().toISOString(),
  };
}
