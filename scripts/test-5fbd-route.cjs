'use strict';
/** R-5fbd 回归：守护 ready 分支（F-5fbd-1）+ 候选只认当前轮（交叉审查裁决 1）。纯函数级，直接 import planForRow。 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const modUrl = pathToFileURL(path.join(ROOT, '团队', '工具', 'lib', 'route-daemon.mjs')).href;
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 260)}`);
  if (!ok) process.exitCode = 1;
}
const baseRow = (over = {}) => ({ id: 'R-20261115-010000-aaaa', status: 'ready', deliveryRound: 1, trq: { verdict: 'testable' }, decisions: [], ...over });
const carrier = (over = {}) => ({ id: 'T-1', type: 'task', owner: 'programmer1', status: 'open', requirementId: 'R-20261115-010000-aaaa', workflow: { round: 1 }, ...over });
const appr = [{ status: 'approved', channel: 'ui', at: '2026-11-15T00:00:00Z' }];

(async () => {
  const { planForRow, isCurrentRound, carrierOf } = await import(modUrl);

  // ① trq 不可测
  const p1 = planForRow(baseRow({ trq: { verdict: 'not_testable' } }), { tasks: [], projectPath: ROOT, mode: 'full' });
  check('① ready + trq=not_testable → skip:trq_not_testable', p1.skip === 'trq_not_testable', p1);

  // ② trq 未评 → 叫 tester 做 TR-Q
  const p2 = planForRow(baseRow({ trq: {} }), { tasks: [], projectPath: ROOT, mode: 'full' });
  check('② ready + 无 TR-Q → tester/trq', p2.role === 'tester' && p2.action === 'trq', p2);

  // ③ 无决定 → PM decide 或 gateBlocked（G2.5），不得叫开发
  const p3 = planForRow(baseRow(), { tasks: [carrier()], projectPath: ROOT, mode: 'full' });
  check('③ ready + decisions=[] → 不叫开发（pm decide 或 gateBlocked）', p3.action !== 'develop', p3);

  // ④ 决定 rejected → rework
  const p4 = planForRow(baseRow({ decisions: [{ status: 'rejected', at: '2026-11-15T00:00:00Z' }] }), { tasks: [carrier()], projectPath: ROOT, mode: 'full' });
  check('④ ready + rejected → rework', p4.action === 'rework' && p4.role === 'programmer1', p4);

  // ⑤ 决定 approved + 当前轮载体 → 叫开发（不再 already_decided）
  const p5 = planForRow(baseRow({ decisions: appr }), { tasks: [carrier()], projectPath: ROOT, mode: 'full' });
  check('⑤ ready + approved + 载体 → develop（G3）', p5.action === 'develop' && p5.role === 'programmer1' && p5.gate === 'G3', p5);

  // ⑥ 决定 approved + 无载体 → skip:no_carrier_task + alertPm
  const p6 = planForRow(baseRow({ decisions: appr }), { tasks: [], projectPath: ROOT, mode: 'full' });
  check('⑥ ready + approved + 无载体 → skip:no_carrier_task + alertPm', p6.skip === 'no_carrier_task' && p6.alertPm === true, p6);

  // ⑦ 未知决定 → skip:unknown_decision + alertPm（不猜、不叫开发）
  const p7 = planForRow(baseRow({ decisions: [{ status: 'pending', at: '2026-11-15T00:00:00Z' }] }), { tasks: [carrier()], projectPath: ROOT, mode: 'full' });
  check('⑦ 未知决定 → skip:unknown_decision + alertPm', p7.skip === 'unknown_decision' && p7.alertPm === true, p7);

  // ⑧ 轮次过滤：旧轮任务不算载体（裁决 1）
  const oldRound = carrier({ workflow: { round: 0 } });
  const p8 = planForRow(baseRow({ decisions: appr }), { tasks: [oldRound], projectPath: ROOT, mode: 'full' });
  check('⑧ 旧轮载体不计入 → skip:no_carrier_task', p8.skip === 'no_carrier_task', p8);
  check('⑧ isCurrentRound：缺 round 视为当前轮', isCurrentRound(baseRow(), { workflow: {} }) === true, isCurrentRound(baseRow(), { workflow: {} }));
  check('⑧ carrierOf 带行过滤后返回空（旧轮）', carrierOf('R-20261115-010000-aaaa', [oldRound], baseRow()) === '', carrierOf('R-20261115-010000-aaaa', [oldRound], baseRow()));

  // ⑨ 双模式：fast 也能走到 develop（评审人不同不影响本分支）
  const p9 = planForRow(baseRow({ decisions: appr }), { tasks: [carrier()], projectPath: ROOT, mode: 'fast' });
  check('⑨ fast 模式 ready+approved+载体 → develop', p9.action === 'develop', p9);

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nR-5fbd 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
  require('node:fs').writeFileSync(path.join(ROOT, '_tmp', 'run-5fbd.json'), JSON.stringify({ passed, failed, results }, null, 2) + '\n', 'utf8');
})();
