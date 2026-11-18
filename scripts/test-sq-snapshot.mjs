#!/usr/bin/env node
/**
 * R-6bc8（T-20261117-123812-37f5）host half 数据通道回归：
 *   ① 排队数只算 placement==='queued'（3 queued + 2 steering + 1 context → queued=3，byPlacement 明细）；
 *   ② 四态 fail > skip > ok > none：四组夹具各判一次（skipped 优先于 ok）；
 *   ③ AC2 积压≠失败：queued=3 且无 fail 行（有 ok/skip）→ state ∈ {ok,skip} 且不得 fail；
 *   ④ AC7 无记录 → state=none、lastOkAt 空；旧行格式（deliverAt/why/messageId）可识别；
 *   ⑤ AC4 未知≠0：queue===null → known=false、queued=null；
 *   ⑥ AC6 过期降级：at 10 分钟前 → stale=true；
 *   ⑦ AC5 自身零写：实现文件里写侧方法 0 命中、字符串 .zstd 0 命中；
 *   ⑧ 快照原子写落盘 + 字段齐全（at/roles[]/queue/byPlacement/lastOkAt/staleMs）。
 *
 * 跑法：node scripts/test-sq-snapshot.cjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const ROOT = path.resolve(__dirname, '..');
const SQ = await import(pathToFileURL(path.join(ROOT, 'dsh-plugin', 'pm-workbench-dsh', 'session-queue.js')).href);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? '' : String(JSON.stringify(detail)).slice(0, 500) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 500)}`);
  if (!ok) process.exitCode = 1;
}
const now = Date.now();
const row = (patch) => ({ at: new Date(now - 30 * 1000).toISOString(), ok: false, ...patch });

// ① 排队数：只算 queued
const sample = { queue: [
  { id: 'm1', placement: 'queued' }, { id: 'm2', placement: 'queued' }, { id: 'm3', placement: 'queued' },
  { id: 'm4', placement: 'steering' }, { id: 'm5', placement: 'context' },
] };
const q = SQ.queuedCount(sample);
check('① 排队数只算 placement=queued（3），byPlacement 明细 steer=1/context=1', q.known === true && q.count === 3 && q.byPlacement.steering === 1 && q.byPlacement.context === 1, q);

// ② 四态
// B-20261118-085825-0950：单条窗口内失败判 retry，所以 fail 用「两条连续失败（时间不同）」夹具验。
const stFail = SQ.wakeStateOf([
  row({ ok: true, at: new Date(now - 60 * 1000).toISOString() }),
  row({ ok: false, at: new Date(now - 20 * 1000).toISOString(), reason: 'WAKE_FAILED' }),
  row({ ok: false, at: new Date(now - 10 * 1000).toISOString(), reason: 'WAKE_FAILED' }),
], { now });
const stSkip = SQ.wakeStateOf([row({ ok: true }), row({ ok: false, skipped: true, reason: 'skipped' })], { now });
const stOk = SQ.wakeStateOf([row({ ok: true }), row({ ok: true })], { now });
const stNone = SQ.wakeStateOf([], { now });
check('② 四态 fail > skip > ok > none（skip 优先于 ok，fail 优先于 skip）',
  stFail.state === 'fail' && stSkip.state === 'skip' && stOk.state === 'ok' && stNone.state === 'none',
  { fail: stFail.state, skip: stSkip.state, ok: stOk.state, none: stNone.state });

// ③ AC2 积压≠失败
const stBacklog = SQ.wakeStateOf([row({ ok: true }), row({ ok: false, skipped: true })], { now });
check('③ AC2 积压≠失败：queued=3 + 有 ok/skip 无 fail → state ∈ {ok,skip} 不得 fail',
  ['ok', 'skip'].includes(stBacklog.state) && q.count === 3, { state: stBacklog.state, queued: q.count });

// ④ AC7 无记录 + 旧行兼容
const stLegacy = SQ.wakeStateOf([{ at: new Date(now - 20 * 1000).toISOString(), ok: true, deliverAt: new Date(now - 20 * 1000).toISOString(), why: '', messageId: 'M-1' }], { now });
const rolesNoRows = SQ.buildSnapshot({ project: 'P', samples: { analyst: { sessionId: 's1', state: { queue: [] } } }, wakes: {}, now });
check('④ AC7 无记录 → state=none、lastOkAt 空；旧行（deliverAt/why/messageId）仍识别为 ok',
  stLegacy.state === 'ok' && rolesNoRows.roles[0].state === 'none' && rolesNoRows.roles[0].lastOkAt === '',
  { legacy: stLegacy.state, noRows: rolesNoRows.roles[0] });

// ⑤ AC4 未知≠0
const unknown = SQ.buildSnapshot({ project: 'P', samples: { analyst: { sessionId: '', state: null } }, wakes: {}, now });
check('⑤ AC4 未知≠0：sessionId/state 缺失 → known=false 且 queued=null（面板据此显示 —）',
  unknown.roles[0].known === false && unknown.roles[0].queued === null, unknown.roles[0]);

// ⑥ AC6 过期降级
const oldRows = [row({ at: new Date(now - 10 * 60 * 1000).toISOString(), ok: true })];
const stStale = SQ.wakeStateOf(oldRows, { now, staleMs: 120000 });
check('⑥ AC6 快照/行 10 分钟前 → stale=true（面板 data-sq-degraded）', stStale.stale === true, stStale);

// ⑦ AC5 自身零写（静态）
const implFiles = [
  path.join(ROOT, 'dsh-plugin', 'pm-workbench-dsh', 'session-queue.js'),
  path.join(ROOT, 'dsh-plugin', 'pm-workbench-dsh', 'index.js'),
];
const hits = SQ.writeSideHits(implFiles);
const zstdHits = implFiles.filter((f) => fs.readFileSync(f, 'utf8').includes('.zstd'));
check('⑦ AC5① 实现里对 sessionController 写侧方法调用 0 命中', hits.length === 0, hits);
check('⑦ AC5② 实现代码里字符串 .zstd 0 命中', zstdHits.length === 0, zstdHits);

// ⑧ 快照原子写 + 字段齐全
const SB = mkTempSandbox('sq-snapshot');
const teamRoot = path.join(SB, '团队');
const snap = SQ.buildSnapshot({
  project: '沙盘', now,
  samples: { analyst: { sessionId: 's-a', state: { queue: [{ placement: 'queued' }, { placement: 'queued' }, { placement: 'queued' }, { placement: 'context' }] } } },
  wakes: { analyst: [row({ ok: true }), row({ ok: false, skipped: true })] },
});
const written = SQ.writeSnapshot(teamRoot, snap);
const disk = JSON.parse(fs.readFileSync(written.file, 'utf8'));
check('⑧ 快照原子写落盘（团队/状态/会话排队.json）且字段齐全（at/roles[]/queued/byPlacement/staleMs）',
  written.file.endsWith(path.join('团队', '状态', SQ.SNAPSHOT_FILE)) && disk.schema === 2 && Array.isArray(disk.roles)
  && typeof disk.staleMs === 'number' && disk.roles[0].queued === 3 && disk.roles[0].byPlacement.context === 1,
  { file: written.file, via: written.via, disk: disk.roles && disk.roles[0] });

// ⑨ B-c971①：需求 §5.2 的 64KB 硬保护——超限拒写（磁盘上一份保留），并回 SNAPSHOT_TOO_LARGE 告警载荷。
const bytesBefore = fs.statSync(written.file).size;
const hugeSnapshot = { schema: 1, at: new Date(now).toISOString(), project: '沙盘', roles: [{ role: 'pm', note: 'x'.repeat(70000) }] };
const hugeResult = SQ.writeSnapshot(teamRoot, hugeSnapshot);
check('⑨ B-c971 快照 >64KB → 拒写（skipped / code=SNAPSHOT_TOO_LARGE / 磁盘上一份未被覆盖）',
  hugeResult.skipped === true && hugeResult.code === 'SNAPSHOT_TOO_LARGE'
  && hugeResult.bytes > SQ.SNAPSHOT_MAX_BYTES && hugeResult.limit === SQ.SNAPSHOT_MAX_BYTES
  && fs.statSync(written.file).size === bytesBefore,
  { result: hugeResult, diskBytes: fs.statSync(written.file).size, bytesBefore });
const rewrite = SQ.writeSnapshot(teamRoot, snap);
check('⑨ B-c971 超限拒写后正常快照仍可写（护栏不粘滞）', rewrite.skipped !== true && fs.statSync(written.file).size > 0, rewrite);

const passed = results.filter((r) => r.ok).length;
console.log(`\nR-6bc8 host half 数据通道断言：${passed}/${results.length} PASS`);
const evDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-37f5');
fs.mkdirSync(evDir, { recursive: true });
fs.writeFileSync(path.join(evDir, 'run-sq-snapshot.json'), JSON.stringify({ at: new Date().toISOString(), total: results.length, passed, results }, null, 2) + '\n', 'utf8');
