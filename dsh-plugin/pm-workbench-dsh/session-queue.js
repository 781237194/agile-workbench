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
 * 组装快照：roles[] 每项 { role, sessionId, known, queued, byPlacement, state, lastOkAt, lastAt, stale }。
 * samples: { [role]: { sessionId, state } }，state 即 sessionController.state 的返回（可 null/未知）。
 * wakes: { [role]: rows[] }，来自 唤醒.jsonl 投影（由壳层/插件采集）。
 */
function buildSnapshot({ project, samples = {}, wakes = {}, now = Date.now(), staleMs = 120000, running = null } = {}) {
  const roles = Object.keys(samples);
  const rows = roles.map((role) => {
    const sample = samples[role] || {};
    const q = queuedCount(sample.state);
    const w = wakeStateOf(wakes[role], { now, staleMs });
    return {
      role: String(role),
      sessionId: String(sample.sessionId || ''),
      known: q.known === true && Boolean(sample.sessionId),
      queued: q.known ? q.count : null,
      byPlacement: q.byPlacement || null,
      state: w.state,
      lastOkAt: w.lastOkAt,
      lastAt: w.lastAt,
      stale: w.stale || q.known !== true,
    };
  });
  return {
    schema: 1,
    at: new Date(Number(now) || Date.now()).toISOString(),
    project: String(project || ''),
    staleMs: Number(staleMs) || 120000,
    running: running && typeof running === 'object' ? { active: Boolean(running.active), queue: running.queue === null ? null : Number(running.queue) || 0 } : null,
    roles: rows,
  };
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
  WRITE_SIDE_METHODS,
  queuedCount,
  wakeStateOf,
  buildSnapshot,
  snapshotPath,
  writeSnapshot,
  writeSideHits,
};
