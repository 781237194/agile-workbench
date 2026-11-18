/**
 * B-20261116-202315-dd67 自检：G5 TASK_OPEN 不把已验收（accepted）/已取消（cancelled）算未闭环。
 *
 * 覆盖（与任务 acceptance 逐条对应）：
 *   S1  accepted×32 + 本次派单自身(working)          → 放行（excludeTaskIds 自指豁免，且 missing 不出现自身 id）
 *   S2  accepted×32 + 另一条 working（非自指）        → 拦截，missing 只列那一条、不列 accepted 的
 *   S3  accepted×32 + open×1                        → 拦截并只列 open 那条
 *   S4  名下仅剩 accepted/done/cancelled             → 放行（本单核心）
 *   S5  只有 open                                    → 仍拦截（旧行为不退化）
 *   S6  只有 working 且非自指                         → 仍拦截（旧行为不退化）
 *   S7  ops.mjs 派单侧确实传了 excludeTaskIds（taskId + requirementId），S1 的口径才有落点
 *   S8  真实任务库：programmer2 名下未闭环条数与「非终态」逐条对得上（现查，不写死数字）
 *
 * 跑法：node scripts/test-dd67-g5-closed.cjs
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

// B-f62d 修 import：原实现 `const ROOT = process.cwd()` + `import('file:///' + 拼上盘符反斜杠路径)`——
// 在 Windows 上 cwd 不是仓库根、或把盘符反斜杠路径直接拼进 file:// 前缀，都会在 import 阶段失败（脚本跑不起来）。
// 改为「__dirname 上溯 + pathToFileURL」，从任意目录调用都能跑。
const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, '团队', '工具', 'lib');
const PROJ = path.join(ROOT, '团队', '状态', '项目', '工作台改造修复');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('PASS  ' + name); }
  else { fail += 1; console.log('FAIL  ' + name + '  ' + JSON.stringify(detail === undefined ? {} : detail).slice(0, 600)); process.exitCode = 1; }
}

function task(id, status, extra) {
  return Object.assign({ id, owner: 'programmer2', status, title: 'T-' + id, updatedAt: '2026-11-16T12:00:00.000Z' }, extra || {});
}
function acceptedBulk(n) {
  const list = [];
  for (let i = 0; i < n; i += 1) list.push(task('B-accepted-' + i, 'accepted'));
  return list;
}
function idsOf(gate) {
  return ((gate && gate.taskIds) || []).slice().sort();
}
function missingText(gate) {
  return ((gate && gate.missing) || []).join(' | ');
}

(async () => {
  const gates = await import(pathToFileURL(path.join(LIB, 'gates.mjs')).href);
  ok('S0 gates 导出 CLOSED_TASK_STATUSES / taskIsClosed / gateRoleBusy',
    Array.isArray(gates.CLOSED_TASK_STATUSES) && typeof gates.taskIsClosed === 'function' && typeof gates.gateRoleBusy === 'function', {});
  // B-f62d：终态集合现为 4 项（done/accepted/cancelled/terminated）——旧断言写 3 项会红。
  ok('S0b 终态集合正好是 done/accepted/cancelled/terminated',
    JSON.stringify(gates.CLOSED_TASK_STATUSES) === JSON.stringify(['done', 'accepted', 'cancelled', 'terminated']), gates.CLOSED_TASK_STATUSES);

  // S1：accepted×32 + 本次派单自身（working，自指豁免）→ 放行
  const selfId = 'T-self-working';
  const s1tasks = acceptedBulk(32).concat([task(selfId, 'working')]);
  const s1 = gates.gateRoleBusy({ role: 'programmer2', tasks: s1tasks, excludeTaskIds: [selfId] });
  ok('S1 accepted×32 + 自身 working → 放行', s1 === null, s1);
  ok('S1b 放行时错误信息里不出现自身 id / accepted id',
    s1 === null || (missingText(s1).indexOf(selfId) < 0 && missingText(s1).indexOf('B-accepted-') < 0), s1);

  // S2：accepted×32 + 另一条 working（非自指）→ 拦截且只列那一条
  const otherWorking = 'T-other-working';
  const s2tasks = acceptedBulk(32).concat([task(selfId, 'working'), task(otherWorking, 'working')]);
  const s2 = gates.gateRoleBusy({ role: 'programmer2', tasks: s2tasks, excludeTaskIds: [selfId] });
  ok('S2 accepted×32 + 另一条 working → 拦截(TASK_OPEN)', !!s2 && s2.code === 'TASK_OPEN', s2);
  ok('S2b missing 只列那一条 working，不列 accepted', JSON.stringify(idsOf(s2)) === JSON.stringify([otherWorking]), idsOf(s2));

  // S3：accepted×32 + open×1 → 拦截且只列 open
  const openId = 'T-only-open';
  const s3tasks = acceptedBulk(32).concat([task(openId, 'open')]);
  const s3 = gates.gateRoleBusy({ role: 'programmer2', tasks: s3tasks, excludeTaskIds: [selfId] });
  ok('S3 accepted×32 + open×1 → 拦截(TASK_OPEN)', !!s3 && s3.code === 'TASK_OPEN', s3);
  ok('S3b missing 只列 open 那条，不列 accepted', JSON.stringify(idsOf(s3)) === JSON.stringify([openId]), idsOf(s3));

  // S4：名下仅剩 accepted/done/cancelled/terminated → 放行（本单核心；B-f62d 起含 terminated）
  const s4tasks = acceptedBulk(32).concat([
    task('T-done-1', 'done'), task('T-cancelled-1', 'cancelled'), task('T-terminated-1', 'terminated'),
  ]);
  const s4 = gates.gateRoleBusy({ role: 'programmer2', tasks: s4tasks, excludeTaskIds: ['T-self-working'] });
  ok('S4 仅接受/完成/取消/终止混排 → 放行', s4 === null, s4);
  ok('S4b terminated 也算终态（taskIsClosed({status}) true、working false）',
    gates.taskIsClosed({ status: 'terminated' }) === true && gates.taskIsClosed({ status: 'cancelled' }) === true
    && gates.taskIsClosed({ status: 'working' }) === false);

  // S5/S6：真办中的状态仍挡（不退化）
  const s5 = gates.gateRoleBusy({ role: 'programmer2', tasks: [task('T-open-reg', 'open')], excludeTaskIds: ['T-x'] });
  ok('S5 只有 open → 仍拦截', !!s5 && s5.code === 'TASK_OPEN', s5);
  const s6 = gates.gateRoleBusy({ role: 'programmer2', tasks: [task('T-working-reg', 'working')], excludeTaskIds: ['T-x'] });
  ok('S6 只有 working 且非自指 → 仍拦截', !!s6 && s6.code === 'TASK_OPEN', s6);
  // blocked 仍不占名额（R-75ec 旧口径不退化）
  const s6b = gates.gateRoleBusy({ role: 'programmer2', tasks: [task('T-blocked', 'blocked')], excludeTaskIds: [] });
  ok('S6b 只有 blocked → 放行（R-75ec 旧口径保持）', s6b === null, s6b);

  // S7：派单侧确实传 excludeTaskIds（taskId + requirementId）
  const ops = fs.readFileSync(path.join(LIB, 'ops.mjs'), 'utf8');
  ok('S7 ops.mjs 派单传 excludeTaskIds: [taskId, requirementId]',
    /excludeTaskIds:\s*\[taskId,\s*requirementId\]\.filter\(Boolean\)/.test(ops), {});

  // S8：真实任务库现查（不写死数字）：programmer2 名下「非终态」条数 = gateRoleBusy 报的条数
  const taskDir = path.join(PROJ, '任务');
  const all = fs.readdirSync(taskDir).filter((f) => f.endsWith('.json')).map((f) => JSON.parse(fs.readFileSync(path.join(taskDir, f), 'utf8')));
  const mine = all.filter((t) => t.owner === 'programmer2');
  const closed = new Set(gates.CLOSED_TASK_STATUSES);
  const expectOpen = mine.filter((t) => !closed.has(String(t.status)) && String(t.status) !== 'blocked');
  const realGate = gates.gateRoleBusy({ role: 'programmer2', tasks: all, excludeTaskIds: [] });
  const realCount = realGate ? (realGate.taskIds || []).length : 0;
  ok('S8 真实库：非终态条数 = G5 报的未闭环条数（' + expectOpen.length + '）',
    realCount === expectOpen.length, { realCount, expectOpen: expectOpen.length });
  const acceptedStillCounted = expectOpen.some((t) => String(t.status) === 'accepted');
  ok('S8b 真实库里 accepted 一条都没被算进未闭环', acceptedStillCounted === false, {});

  console.log('\n===== ' + (fail === 0 ? 'ALL PASS' : 'FAILED') + ' pass=' + pass + ' fail=' + fail + ' =====');
  console.log('真实：programmer2 名下 ' + mine.length + ' 条，其中非终态 ' + expectOpen.length + ' 条（' + expectOpen.map((t) => t.id + '/' + t.status).join(', ') + '）');
})().catch((e) => { console.error('THROW', e && e.stack || e); process.exitCode = 1; });
