#!/usr/bin/env node
/**
 * R-6bc8（T-37f5）接线片回归：插件 host half 用假 ctx.sessionController 采一次快照，
 * 断言 会话排队.json 落盘、排队=3、未知≠0、四态与 byPlacement 正确、且只读（写侧 0 调用）。
 *
 * 跑法：node scripts/test-sq-collect.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));
const PLUGIN = await import(pathToFileURL(path.join(ROOT, 'dsh-plugin', 'pm-workbench-dsh', 'index.js')).href);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? '' : String(JSON.stringify(detail)).slice(0, 500) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 500)}`);
  if (!ok) process.exitCode = 1;
}

const SB = mkTempSandbox('sq-collect');
const teamRoot = path.join(SB, '团队');
const stateDir = path.join(teamRoot, '状态');
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, '团队.json'), JSON.stringify({
  members: [
    { role: 'analyst', sessionId: 's-analyst' },
    { role: 'tester', sessionId: 's-tester' },
    { role: 'pm', sessionId: '' },
  ],
  activeProject: '沙盘',
}, null, 2) + '\n', 'utf8');
const now = Date.now();
fs.writeFileSync(path.join(stateDir, '唤醒.jsonl'), [
  { at: new Date(now - 60000).toISOString(), to: 'analyst', ok: true, reason: 'wake' },
  // B-20261117-181420-9688（P1）：tester 先失败、再跳过、**最近一条成功** —— 四态必须判 ok，
  // 不能再像旧实现那样「窗口内曾失败一次就永久 fail」。
  { at: new Date(now - 40000).toISOString(), to: 'tester', ok: false, reason: 'WAKE_FAILED' },
  { at: new Date(now - 20000).toISOString(), to: 'tester', ok: false, skipped: true, reason: 'skipped' },
  { at: new Date(now - 10000).toISOString(), to: 'tester', ok: true, reason: 'wake' },
].map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');

const calls = { state: 0, writeSide: 0 };
const fakeCtx = {
  sessionController: {
    state: async (req) => {
      calls.state += 1;
      if (String(req && req.sessionId) === 's-analyst') {
        return { active: true, running: true, queue: [
          { placement: 'queued' }, { placement: 'queued' }, { placement: 'queued' },
          { placement: 'steering' }, { placement: 'context' },
        ] };
      }
      return null;
    },
    updateQueue: () => { calls.writeSide += 1; },
    prompt: () => { calls.writeSide += 1; },
    cancel: () => { calls.writeSide += 1; },
  },
};

const out = await PLUGIN.collectSessionQueueSnapshot(fakeCtx, { teamRoot, staleMs: 120000 }, now);
check('① collectSessionQueueSnapshot 成功并返回写入文件', out.ok === true && String(out.file).endsWith(path.join('团队', '状态', '会话排队.json')), out);

const disk = JSON.parse(fs.readFileSync(path.join(stateDir, '会话排队.json'), 'utf8'));
const analyst = disk.roles.find((row) => row.role === 'analyst') || {};
const tester = disk.roles.find((row) => row.role === 'tester') || {};
check('② analyst 排队=3、byPlacement steering=1/context=1、state=ok',
  analyst.queued === 3 && analyst.byPlacement && analyst.byPlacement.steering === 1 && analyst.byPlacement.context === 1 && analyst.state === 'ok',
  analyst);
check('③ 9688：tester 先失败→跳过→最近一条 ok → state=ok（不再「曾失败就永久 fail」）', tester.state === 'ok', tester);
check('④ pm 无 sessionId → known=false、queued=null（面板显示 —，不是 0）', (disk.roles.find((row) => row.role === 'pm') || {}).known === false && (disk.roles.find((row) => row.role === 'pm') || {}).queued === null, disk.roles.find((row) => row.role === 'pm'));
check('⑤ 只读：sessionController.state 被调用，写侧方法 0 调用', calls.state >= 2 && calls.writeSide === 0, calls);
check('⑥ 快照顶层字段齐全且 schema 升到 2（schema/at/project/staleMs/roles 旧字段一个不删）', disk.schema === 2 && Boolean(disk.at) && disk.staleMs === 120000 && Array.isArray(disk.roles) && disk.roles.length === 3 && Object.prototype.hasOwnProperty.call(disk, 'project'), { schema: disk.schema, roles: disk.roles.length });

// 静态：插件 inject 含 sessionController + ctx.effect 定时器
const idx = fs.readFileSync(path.join(ROOT, 'dsh-plugin', 'pm-workbench-dsh', 'index.js'), 'utf8');
check('⑦ 插件 inject=[tools,sessionController]、ctx.effect 定时采集、卸载 clearInterval',
  idx.includes("inject = ['tools', 'sessionController']") && idx.includes('collectSessionQueueSnapshot') && idx.includes('clearInterval(timer)'),
  { inject: idx.includes("'sessionController'") });

// AC5 静态：实现里写侧方法 0 命中、.zstd 0 命中
const writeSide = ['updateQueue', 'prompt', 'cancel', 'selectModel', 'rename', 'fork', 'create'];
const hits = writeSide.filter((m) => new RegExp(`\\.${m}\\s*\\(`).test(idx));
check('⑧ AC5① 插件实现里写侧方法调用 0 命中', hits.length === 0, hits);
check('⑨ AC5② 插件实现里 .zstd 0 命中', !idx.includes('.zstd'));

// ── c9ac（快照 v2）：schema 2 + 新字段 + 未知不冒充 + 通道升级（订阅去抖 / 兜底全等不写） ──
const pmRow = disk.roles.find((row) => row.role === 'pm') || {};
check('⑩ 已知行保留旧字段并带新字段（active/running/pendingInput/cursor/runningSince/lastEventAt）',
  ['role', 'sessionId', 'known', 'queued', 'byPlacement', 'state', 'lastOkAt', 'lastAt'].every((k) => Object.prototype.hasOwnProperty.call(analyst, k))
  && typeof analyst.active === 'boolean' && typeof analyst.running === 'boolean' && Array.isArray(analyst.pendingInput)
  && Object.prototype.hasOwnProperty.call(analyst, 'cursor') && Object.prototype.hasOwnProperty.call(analyst, 'runningSince')
  && typeof analyst.lastEventAt === 'string',
  analyst);
check('⑪ 未知行（pm）known=false、queued===null，且不写 running/runningSince/lastEventAt（禁 0/false 冒充）',
  pmRow.known === false && pmRow.queued === null
  && !Object.prototype.hasOwnProperty.call(pmRow, 'running')
  && !Object.prototype.hasOwnProperty.call(pmRow, 'runningSince')
  && !Object.prototype.hasOwnProperty.call(pmRow, 'lastEventAt'),
  pmRow);

const SQ = await import(pathToFileURL(path.join(ROOT, 'dsh-plugin', 'pm-workbench-dsh', 'session-queue.js')).href);
const t0 = Date.now();
// 注意：applyStateFrame 原地改 entry，连续三次要各取快照值，否则后一步会覆盖前一步的断言字段。
const e0 = SQ.applyStateFrame({}, { cursor: 1, active: true, running: false, queue: [], pendingInput: ['approval'] }, t0);
const e0s = { running: e0.running, since: e0.runningSince };
const e1 = SQ.applyStateFrame({ ...e0 }, { cursor: 1, active: true, running: true, queue: [], pendingInput: ['approval'] }, t0 + 1000);
const e1s = { running: e1.running, since: e1.runningSince, pendingInput: e1.pendingInput };
const e2 = SQ.applyStateFrame({ ...e1 }, { cursor: 1, active: false, running: false, queue: [], pendingInput: [] }, t0 + 2000);
const e2s = { running: e2.running, since: e2.runningSince };
// 行级契约：known 行即使没有边沿（插件重启/首次采样），runningSince 也必须显式 null（不回填 at）。
const rowNoEdge = SQ.roleRowOf({ role: 'pm', sessionId: 's-x', state: { queue: [], running: false }, wake: { state: 'none', lastOkAt: '', lastAt: '', stale: false } });
check('⑫ runningSince 只在 false→true 边沿写 ISO、true→false 清空（null）；无变沿未知则不冒充；pendingInput 原样保留',
  e0s.running === false && (e0s.since === undefined || e0s.since === null)
  && e1s.running === true && typeof e1s.since === 'string' && Date.parse(e1s.since) === t0 + 1000
  && e2s.running === false && e2s.since === null
  && rowNoEdge.running === false && rowNoEdge.runningSince === null
  && JSON.stringify(e1.state.pendingInput) === '["approval"]'
  && JSON.stringify(rowNoEdge.pendingInput) === '[]',
  { e0: e0s, e1: e1s, e2: e2s, rowNoEdge: { running: rowNoEdge.running, runningSince: rowNoEdge.runningSince } });

check('⑬ 兜底「除 at 外全等 → 不写盘」比较键忽略 at、内容变化能识别；index.js 兜底 60s + skipIfUnchanged',
  SQ.snapshotEqualsExceptAt({ at: 'A', roles: [{ role: 'pm' }] }, { at: 'B', roles: [{ role: 'pm' }] }) === true
  && SQ.snapshotEqualsExceptAt({ at: 'A', roles: [{ role: 'pm' }] }, { at: 'A', roles: [{ role: 'pm', queued: 1 }] }) === false
  && idx.includes('skipIfUnchanged: source === \'fallback\'')
  && idx.includes('fallbackIntervalMs) || 60000')
  && idx.includes('AbortController'),
  { sameIgnoringAt: SQ.snapshotEqualsExceptAt({ at: 'A', roles: [] }, { at: 'B', roles: [] }) });

// ⑭ 通道升级：observeState 帧 → 去抖合并写一次（落盘 ≤1s）；卸载 abort 后不再写。
const SB2 = mkTempSandbox('sq-live');
const teamRoot2 = path.join(SB2, '团队');
const stateDir2 = path.join(teamRoot2, '状态');
fs.mkdirSync(stateDir2, { recursive: true });
fs.writeFileSync(path.join(stateDir2, '团队.json'), JSON.stringify({
  members: [{ role: 'analyst', sessionId: 's-live' }], activeProject: '沙盘',
}, null, 2) + '\n', 'utf8');
let pendingFrame = null;
let frameWaiter = null;
const pushFrame = (frame) => { if (frameWaiter) { const resolve = frameWaiter; frameWaiter = null; resolve(frame) } else { pendingFrame = frame } };
const cleanups = [];
const liveCtx = {
  sessionController: {
    state: async () => ({ cursor: 1, active: true, running: false, queue: [{ placement: 'queued' }, { placement: 'queued' }], pendingInput: ['approval'] }),
    observeState: async (req, signal) => (async function* stream() {
      while (!signal.aborted) {
        if (pendingFrame) { const frame = pendingFrame; pendingFrame = null; yield frame; continue }
        const frame = await new Promise((resolve) => {
          frameWaiter = resolve;
          const timer = setTimeout(() => { frameWaiter = null; resolve(null) }, 20);
          signal.addEventListener('abort', () => { clearTimeout(timer); resolve(null) }, { once: true });
        });
        if (frame) yield frame;
        else if (signal.aborted) return;
      }
    })(),
  },
  effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') cleanups.push(cleanup); return () => {} },
  tools: { register: () => ({}) },
};
PLUGIN.apply(liveCtx, { teamRoot: teamRoot2, staleMs: 120000, debounceMs: 50, fallbackIntervalMs: 100000 });
const snapFile2 = path.join(stateDir2, '会话排队.json');
const waitFor = async (predicate, timeoutMs = 3000) => {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    try { if (predicate()) return true } catch { /* 快照还没写完 */ }
    await new Promise((r) => setTimeout(r, 25));
  }
  return false;
};
pushFrame({ cursor: 2, active: true, running: true, queue: [{ placement: 'queued' }], pendingInput: [] });
const gotFrame = await waitFor(() => {
  const snap = JSON.parse(fs.readFileSync(snapFile2, 'utf8'));
  return snap.roles && snap.roles[0] && snap.roles[0].queued === 1;
});
const liveSnap = gotFrame ? JSON.parse(fs.readFileSync(snapFile2, 'utf8')) : {};
const liveRow = (liveSnap.roles && liveSnap.roles[0]) || {};
check('⑭ observeState 帧 → 去抖合并后写盘（schema 2、queued 取帧值、running=true 带 runningSince、cursor 跟随）',
  gotFrame && liveSnap.schema === 2 && liveRow.queued === 1 && liveRow.running === true
  && typeof liveRow.runningSince === 'string' && liveRow.cursor === 2 && typeof liveRow.lastEventAt === 'string',
  { gotFrame, schema: liveSnap.schema, row: liveRow });
for (const cleanup of cleanups) { try { cleanup() } catch { /* 卸载清理失败不判红 */ } }

// ⑮ observeState 不可用/抛错 → 退回 60s state() 兜底，并在快照 degraded 里如实记原因（不静默）。
const SB3 = mkTempSandbox('sq-degraded');
const teamRoot3 = path.join(SB3, '团队');
const stateDir3 = path.join(teamRoot3, '状态');
fs.mkdirSync(stateDir3, { recursive: true });
fs.writeFileSync(path.join(stateDir3, '团队.json'), JSON.stringify({
  members: [{ role: 'analyst', sessionId: 's-deg' }], activeProject: '沙盘',
}, null, 2) + '\n', 'utf8');
const degCleanups = [];
const degCtx = {
  // 故意不给 observeState：模拟 DSH 版本不支持该只读流
  sessionController: {
    state: async () => ({ cursor: 5, active: true, running: false, queue: [{ placement: 'queued' }], pendingInput: [] }),
  },
  effect: (fn) => { const cleanup = fn(); if (typeof cleanup === 'function') degCleanups.push(cleanup); return () => {} },
  tools: { register: () => ({}) },
};
PLUGIN.apply(degCtx, { teamRoot: teamRoot3, staleMs: 120000, debounceMs: 50, fallbackIntervalMs: 100000 });
const snapFile3 = path.join(stateDir3, '会话排队.json');
const gotDegraded = await waitFor(() => {
  const snap = JSON.parse(fs.readFileSync(snapFile3, 'utf8'));
  return snap.degraded && snap.degraded.code === 'SQ_OBSERVE_UNAVAILABLE';
});
const degSnap = gotDegraded ? JSON.parse(fs.readFileSync(snapFile3, 'utf8')) : {};
check('⑮ observeState 不可用 → 兜底 state() 仍出快照，且 degraded 如实记 SQ_OBSERVE_UNAVAILABLE（不静默）',
  gotDegraded && degSnap.schema === 2 && degSnap.degraded.code === 'SQ_OBSERVE_UNAVAILABLE'
  && typeof degSnap.degraded.message === 'string' && degSnap.roles[0].known === true && degSnap.roles[0].queued === 1,
  { gotDegraded, degraded: degSnap.degraded, row: degSnap.roles && degSnap.roles[0] });
for (const cleanup of degCleanups) { try { cleanup() } catch { /* 卸载清理失败不判红 */ } }
const passed = results.filter((r) => r.ok).length;
console.log(`\nR-6bc8 接线片断言：${passed}/${results.length} PASS`);
const evDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-37f5');
fs.mkdirSync(evDir, { recursive: true });
fs.writeFileSync(path.join(evDir, 'run-sq-collect.json'), JSON.stringify({ at: new Date().toISOString(), total: results.length, passed, results, snapshot: disk }, null, 2) + '\n', 'utf8');
