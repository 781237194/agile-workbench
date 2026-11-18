/**
 * R-6bc8（T-20261117-123812-37f5）会话排队可观测 —— host half 数据通道核心。
 *
 * 职责（只读观测，绝无写侧调用）：
 *   1) 从 DSH `sessionController.state` 采样结果（本模块只吃纯数据，不自己连 DSH）→ 归一化成快照；
 *   2) 排队数 = `queue` 里 `placement === 'queued'` 条数（steering/context 单列 byPlacement，不算积压）；
 *   3) 四态判定 fail > skip > ok > none（skipped 优先，避免 ok=true + ALREADY_DELIVERED 被算成功）；
 *   4) 原子写 `团队/状态/会话排队.json`（复用 json-atomic.cjs 的 tmp→fsync→bak→rename 口径）。
 *
 * 硬边界：不读 DSH 会话压缩存储（内部 zstd 格式，升级即坏）；不调用 sessionController 写侧方法。
 */

import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

// dsh-plugin 的 package.json 是 "type": "module" —— 本文件必须用 ESM。
const require = createRequire(import.meta.url);

const __dirname = path.dirname(new URL(import.meta.url).pathname.replace(/^\/([A-Za-z]:)/, '$1'));
const REPO_ROOT = path.resolve(__dirname, '..', '..');
const jsonAtomic = (() => {
  try { return require(path.join(REPO_ROOT, '团队', '工具', 'lib', 'json-atomic.cjs')); } catch { return null; }
})();

const SNAPSHOT_FILE = '会话排队.json';
// R-6bc8 需求正文 §5.2：快照 ≤64KB 是硬契约（面板/排查工具会整份读入，超大快照有炸内存风险）。
// B-c971：序列化后超限 → 拒写 + 告警（不覆盖上一份可用快照；面板 degraded 不计为解析失败）。
const SNAPSHOT_MAX_BYTES = 65536;
// R-c9ac「插件 host half 快照 v2」：schema 升到 2，**旧字段一个不删**（6bc8 壳层按 schema/at/project/
// staleMs/roles 读取，全部保持原义）；每角色行只新增，不改既有字段语义。
const SNAPSHOT_SCHEMA = 2;
const WRITE_SIDE_METHODS = ['updateQueue', 'prompt', 'cancel', 'selectModel', 'rename', 'fork', 'create', 'openWorkspacePath', 'initializeDefaultModel'];

/** 排队条数：只算 placement==='queued'。 */
function queuedCount(sample) {
  const queue = sample && Array.isArray(sample.queue) ? sample.queue : null;
  if (queue === null) return { known: false, count: null, byPlacement: null };
  const byPlacement = { queued: 0, steering: 0, context: 0 };
  for (const row of queue) {
    const p = String((row && row.placement) || 'queued');
    byPlacement[p] = (byPlacement[p] || 0) + 1;
  }
  return { known: true, count: byPlacement.queued || 0, byPlacement };
}

/**
 * 四态：fail > skip > ok > none（AC1/AC2/AC7）。
 * 行格式兼容：新行 {at, ok, deliveredAt, reason, messageIds, state} / 旧行 {at, ok, deliverAt, why, messageId}。
 */
function wakeStateOf(rows, { now = Date.now(), staleMs = 120000 } = {}) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : [];
  if (!list.length) return { state: 'none', lastOkAt: '', lastAt: '', lastFailAt: '', stale: false };
  const at = (row) => Date.parse(String((row && (row.at || row.deliveredAt || row.deliverAt)) || '')) || 0;
  const pick = (row) => {
    const ok = row.ok === true;
    const skipped = row.skipped === true || row.state === 'skipped' || /^skipped$/i.test(String(row.reason || row.why || ''));
    const failed = !ok && !skipped;
    return { ok, skipped, failed, at: at(row) };
  };
  const parsed = list.map(pick).sort((a, b) => b.at - a.at);
  const lastAtMs = parsed[0] ? parsed[0].at : 0;
  const lastOk = parsed.find((row) => row.ok && row.at);
  const lastOkAt = lastOk ? new Date(lastOk.at).toISOString() : '';
  const lastFail = parsed.find((row) => row.failed && row.at);
  const lastFailAt = lastFail ? new Date(lastFail.at).toISOString() : '';
  const stale = lastAtMs ? (Number(now) - lastAtMs) > Number(staleMs) : false;
  // B-20261117-181420-9688（P1）：四态取**最近一次投递**，不是「窗口内曾失败就 fail」。
  // 同时间戳 tie-break：skip > fail > ok（skip 是设计内不唤醒，语义更强）。
  const TIE_RANK = { skip: 3, fail: 2, ok: 1, none: 0 };
  let latest = 'none';
  let latestAt = -1;
  for (const row of parsed) {
    const kind = row.skipped ? 'skip' : (row.failed ? 'fail' : (row.ok ? 'ok' : 'none'));
    if (row.at > latestAt || (row.at === latestAt && TIE_RANK[kind] > TIE_RANK[latest])) {
      latest = kind;
      latestAt = row.at;
    }
  }
  return { state: latest, lastOkAt, lastAt: lastAtMs ? new Date(lastAtMs).toISOString() : '', lastFailAt, stale };
}

/**
 * 把一帧 `sessionController.state`（或 observeState 推送的替换帧）合进 live 条目。
 * - runningSince：**只在 running false→true 边沿**写 ISO；true→false 清空（null）；重启后允许缺失
 *   （不回填 at —— 回填等于伪造「何时开始跑」）。
 * - lastEventAt：最近一次会话状态替换（首帧 / cursor 前进）。
 * - 拿不到 state（null）→ 只标 state=null，**不写** running/lastEventAt（未知不冒充）。
 */
function applyStateFrame(entry, state, ts = Date.now()) {
  const item = entry && typeof entry === 'object' ? entry : {};
  const at = new Date(Number(ts) || Date.now()).toISOString();
  if (!state || typeof state !== 'object') { item.state = null; return item; }
  const wasRunning = item.running === true;
  const running = state.running === true;
  if (running && !wasRunning) item.runningSince = at;
  else if (!running && wasRunning) item.runningSince = null;
  item.running = running;
  const cursor = state.cursor === undefined ? null : state.cursor;
  if (cursor !== item.cursor || !item.lastEventAt) item.lastEventAt = at;
  item.cursor = cursor;
  item.state = state;
  return item;
}

/**
 * 单角色行（schema 2）。未知（无 sessionId / state 为 null / queue===null）时：
 * 只给 role/sessionId/known/queued(null)/byPlacement(null)/state/lastOkAt/lastAt/stale，
 * **不写** queued 数字、running、runningSince、lastEventAt（禁 0/false 冒充「已知」）。
 */
function roleRowOf({ role, sessionId, state, wake, runningSince, lastEventAt }) {
  const q = queuedCount(state);
  const known = q.known === true && Boolean(sessionId);
  const row = {
    role: String(role),
    sessionId: String(sessionId || ''),
    known,
    queued: known ? q.count : null,
    byPlacement: known ? (q.byPlacement || null) : null,
    state: wake.state,
    lastOkAt: wake.lastOkAt,
    lastAt: wake.lastAt,
    stale: Boolean(wake.stale) || !known,
  };
  if (!known) return row;
  const st = state && typeof state === 'object' ? state : {};
  row.active = st.active === true;
  row.running = st.running === true;
  row.pendingInput = Array.isArray(st.pendingInput) ? st.pendingInput.slice(0, 20).map(String) : [];
  row.cursor = st.cursor === undefined ? null : st.cursor;
  // runningSince：只在 running 为真时有意义；缺失就 null（重启后允许缺失，不用 at 回填）
  row.runningSince = row.running ? (runningSince ? String(runningSince) : null) : null;
  if (lastEventAt) row.lastEventAt = String(lastEventAt);
  return row;
}

/**
 * schema 2 快照组装（纯函数，供自检与夹具直接调用）。
 * live: { [role]: { sessionId, state, cursor?, runningSince?, lastEventAt? } } —— 由订阅帧/兜底采样维护。
 * wakes: { [role]: rows[] }；degraded: observeState 不可用/抛错时如实记录的原因（不静默）。
 */
function buildLiveSnapshot({ project, teamRoot, live = {}, wakes = {}, now = Date.now(), staleMs = 120000, degraded = null, running = null } = {}) {
  const entries = live instanceof Map ? Array.from(live.entries()) : Object.entries(live || {});
  const rows = entries.map(([role, raw]) => {
    const item = raw && typeof raw === 'object' ? raw : {};
    const wake = wakeStateOf(wakes[role], { now, staleMs });
    return roleRowOf({
      role, sessionId: item.sessionId, state: item.state, wake,
      runningSince: item.runningSince, lastEventAt: item.lastEventAt,
    });
  });
  const snapshot = {
    schema: SNAPSHOT_SCHEMA,
    at: new Date(Number(now) || Date.now()).toISOString(),
    project: String(project || ''),
    staleMs: Number(staleMs) || 120000,
    degraded: degraded && typeof degraded === 'object'
      ? { ...degraded, lastAttemptAt: String(degraded.lastAttemptAt || new Date(Number(now) || Date.now()).toISOString()) }
      : null,
    roles: rows,
  };
  if (teamRoot) snapshot.teamRoot = String(teamRoot);
  if (running && typeof running === 'object') {
    snapshot.running = { active: Boolean(running.active), queue: running.queue === null ? null : Number(running.queue) || 0 };
  }
  return snapshot;
}

/** 兜底采样「除 at 外与上一份全等 → 不写盘」的比较键（c9ac 要求：3 分钟静置 ≤2 次写）。 */
function snapshotContentKey(snapshot) {
  if (!snapshot || typeof snapshot !== 'object') return '';
  const { at, ...rest } = snapshot;
  try { return JSON.stringify(rest); } catch { return ''; }
}
function snapshotEqualsExceptAt(a, b) {
  const ka = snapshotContentKey(a);
  return Boolean(ka) && ka === snapshotContentKey(b);
}

/**
 * 组装快照（R-6bc8 旧入口，保留导出）：samples 即一次性采样的结果，
 * 内部转成 live 形态后走 schema 2 组装（字段只增不减）。
 */
function buildSnapshot({ project, samples = {}, wakes = {}, now = Date.now(), staleMs = 120000, running = null } = {}) {
  const live = new Map();
  for (const [role, raw] of Object.entries(samples || {})) {
    const item = raw && typeof raw === 'object' ? raw : {};
    const entry = { sessionId: item.sessionId, state: item.state };
    live.set(role, applyStateFrame(entry, item.state, now));
  }
  return buildLiveSnapshot({ project, live: live.size ? Object.fromEntries(live) : {}, wakes, now, staleMs, running });
}

function snapshotPath(teamRoot) {
  const root = teamRoot ? path.resolve(String(teamRoot)) : path.join(REPO_ROOT, '团队');
  return path.join(root, '状态', SNAPSHOT_FILE);
}

/** 原子写快照；无 json-atomic 时退化为 tmp+rename（同样不直写目标文件）。
 * B-c971：写前按 §5.2 的 64KB 硬上限校验——超限直接拒写（保留上一份），并打一条告警。 */
function writeSnapshot(teamRoot, snapshot, opts = {}) {
  const file = opts.file || snapshotPath(teamRoot);
  const text = JSON.stringify(snapshot, null, 2) + '\n';
  const bytes = Buffer.byteLength(text, 'utf8');
  if (bytes > SNAPSHOT_MAX_BYTES) {
    const payload = { file, bytes, limit: SNAPSHOT_MAX_BYTES, code: 'SNAPSHOT_TOO_LARGE' };
    console.warn('SESSION_QUEUE_SNAPSHOT_TOO_LARGE ' + JSON.stringify(payload));
    return { ...payload, via: 'skipped', skipped: true };
  }
  fs.mkdirSync(path.dirname(file), { recursive: true });
  if (jsonAtomic && typeof jsonAtomic.writeJsonAtomic === 'function') {
    jsonAtomic.writeJsonAtomic(file, snapshot, { case: 'sessionQueueSnapshot', ...(opts.atomicOpts || {}) });
    return { file, via: 'json-atomic', bytes };
  }
  const tmp = `${file}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, text, 'utf8');
  fs.renameSync(tmp, file);
  return { file, via: 'rename', bytes };
}

/** 静态度量：写侧方法命中数（AC5①），供自检与 CI 用。 */
function writeSideHits(files) {
  const hits = [];
  for (const file of files || []) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const method of WRITE_SIDE_METHODS) {
      const re = new RegExp(`\\.${method}\\s*\\(`, 'g');
      const n = (text.match(re) || []).length;
      if (n) hits.push({ file, method, count: n });
    }
  }
  return hits;
}

export {
  SNAPSHOT_FILE,
  SNAPSHOT_MAX_BYTES,
  SNAPSHOT_SCHEMA,
  WRITE_SIDE_METHODS,
  queuedCount,
  wakeStateOf,
  applyStateFrame,
  roleRowOf,
  buildLiveSnapshot,
  snapshotContentKey,
  snapshotEqualsExceptAt,
  buildSnapshot,
  snapshotPath,
  writeSnapshot,
  writeSideHits,
};
