// 认领门自检（T-20261116-124658-303e）—— 五组夹具：边界 / 升级 / 幂等 / 硬门零写 / 认领后不误拦
// 全部在沙盘跑（TEAM_ROOT 指向 _tmp），不碰真实团队状态。
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', 'claim-watch-' + Date.now().toString(36));
const TEAM = path.join(SB, '团队');
const PROJECT = '沙盘认领门';
const TASKS = path.join(TEAM, '状态', '项目', PROJECT, '任务');

fs.mkdirSync(TASKS, { recursive: true });
fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify({ version: 1, members: [], projects: [] }, null, 2), 'utf8');
process.env.TEAM_ROOT = TEAM;
process.env.TEAM_PROJECTS_ROOT = path.join(SB, '项目');
process.env.TEAM_WORKBENCH_JSON = path.join(SB, 'workbench.json');
process.env.TEAM_SELFTEST = '1';
process.env.TEAM_CLAIM_OVERDUE_MIN = '10';
process.env.TEAM_CLAIM_STALLED_MIN = '30';

const CW = require(path.join(ROOT, '团队', '工具', 'lib', 'claim-watch.mjs'));

let pass = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('PASS  ' + name); }
  else { fails.push({ name, detail: detail === undefined ? null : detail }); console.log('FAIL  ' + name + (detail === undefined ? '' : ' · ' + JSON.stringify(detail))); }
}
const MIN = 60000;
const T0 = Date.parse('2026-11-16T12:00:00.000Z');
const at = (min) => new Date(T0 - min * MIN).toISOString();

function seedTask(id, { owner = 'programmer2', status = 'open', dispatchedMinAgo = 0, claimedMinAgo = null } = {}) {
  const task = {
    id, project: PROJECT, type: 'task', status, owner,
    title: id + ' 夹具', createdAt: at(120), dispatchedAt: at(dispatchedMinAgo), dispatchedBy: 'pm', claimRequired: true,
  };
  if (claimedMinAgo !== null) task.claimedAt = at(claimedMinAgo);
  fs.writeFileSync(path.join(TASKS, id + '.json'), JSON.stringify(task, null, 2), 'utf8');
  return task;
}

// ── 组 1 边界：9 分 59 秒不标、10 分钟整标（边界归超时）
seedTask('T-EDGE-09', { dispatchedMinAgo: 9, claimedMinAgo: null });
const edge9 = CW.claimStateOf(JSON.parse(fs.readFileSync(path.join(TASKS, 'T-EDGE-09.json'), 'utf8')), T0 - 1 * MIN); // 10min0s
const s9 = CW.claimStateOf({ id: 'x', status: 'open', owner: 'p', dispatchedAt: at(9), claimRequired: true }, T0 - 10 * 1000);
const s9b = CW.claimStateOf({ id: 'x', status: 'open', owner: 'p', dispatchedAt: at(10), claimRequired: true }, T0);
check('组1 边界：9分59秒仍 pending、满10分钟转 overdue（边界归超时）',
  s9.state === 'pending' && s9b.state === 'overdue' && s9b.ageMin === 10,
  { at9m59: s9, at10m: s9b, edge9: edge9.state });

// ── 组 2 升级：30 分钟转 stalled（同时仍是 overdue 语义），并写升级审计
seedTask('T-UP-30', { dispatchedMinAgo: 31 });
const scanStalled = CW.scanClaims(PROJECT, { now: T0, write: true });
const upTask = JSON.parse(fs.readFileSync(path.join(TASKS, 'T-UP-30.json'), 'utf8'));
check('组2 升级：≥30 分钟标 claimStalled + claimLevel=stalled，并进 stalled 列表',
  upTask.claimStalled === true && upTask.claimLevel === 'stalled' && scanStalled.stalled.some((r) => r.id === 'T-UP-30'),
  { claimLevel: upTask.claimLevel, stalled: scanStalled.stalled.map((r) => r.id) });

// ── 组 3 幂等：同一状态再扫一次不重复写、审计只多一行
const auditPath = path.join(TEAM, '状态', '项目', PROJECT, '认领升级.jsonl');
const lines1 = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).length : 0;
const scanAgain = CW.scanClaims(PROJECT, { now: T0 + 1000, write: true });
const lines2 = fs.existsSync(auditPath) ? fs.readFileSync(auditPath, 'utf8').trim().split('\n').filter(Boolean).length : 0;
check('组3 幂等：重复扫 written=0、审计行数不变',
  scanAgain.written.length === 0 && lines1 === lines2 && lines1 > 0,
  { firstScanWritten: scanStalled.written.length, secondWritten: scanAgain.written.length, lines1, lines2 });

// ── 组 4 硬门：同角色名下有 claimOverdue → 拒派，且零写入
const before = fs.readFileSync(path.join(TASKS, 'T-UP-30.json'), 'utf8');
const gate = CW.dispatchGateFor(PROJECT, 'programmer2', T0);
const after = fs.readFileSync(path.join(TASKS, 'T-UP-30.json'), 'utf8');
check('组4 硬门：DISPATCH_CLAIM_OVERDUE 拒派、带 taskId/ageMin，任务文件零写入',
  gate.ok === false && gate.code === 'DISPATCH_CLAIM_OVERDUE' && gate.owner === 'programmer2'
  && before === after && /T-UP-30|T-EDGE-09/.test(gate.taskId),
  { gate, unchanged: before === after });

// ── 组 5 认领后不误拦：claimedAt 一落，同一角色立刻放行
const t5 = JSON.parse(fs.readFileSync(path.join(TASKS, 'T-UP-30.json'), 'utf8'));
t5.claimedAt = at(0);
t5.status = 'working';
fs.writeFileSync(path.join(TASKS, 'T-UP-30.json'), JSON.stringify(t5, null, 2), 'utf8');
const gateAfterClaim = CW.dispatchGateFor(PROJECT, 'programmer2', T0);
const summary = CW.claimSummary(PROJECT, T0);
check('组5 认领后不误拦：gate.ok=true，且 status 汇总行格式固定',
  gateAfterClaim.ok === true && /^认领门：待认领 \d+ · 超时 \d+ · 升级 \d+$/.test(summary),
  { gateAfterClaim, summary });


// ── 组 6 需求镜像行不算派单：type=requirement / id 以 R- 开头的行天然没有 claimedAt，必须跳过
const mirror = { id: 'R-20261116-101010-abcd', type: 'requirement', status: 'approved', owner: 'analyst', dispatchedAt: at(600), claimRequired: true };
const mirror2 = { id: 'T-20261116-101011-abce', type: 'task', status: 'open', owner: 'analyst', dispatchedAt: at(600), claimRequired: true };
check('组6 镜像行豁免：type=requirement 与 R- 前缀不参与认领门（真数据 3 条需求行曾被误打标），普通 task 仍判 stalled',
  CW.needsClaim(mirror) === false && CW.needsClaim(mirror2) === true && CW.claimStateOf(mirror, T0).state === 'none',
  { mirror: CW.needsClaim(mirror), task: CW.needsClaim(mirror2) });
fs.rmSync(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log('\n认领门自检：' + pass + '/' + (pass + fails.length) + ' PASS');
if (fails.length) { console.log(JSON.stringify(fails, null, 2)); process.exit(1); }
