// B-4226 回归：需求 iteration（返工轮）不再是死结
//  ① 任务门（gates.mjs taskGateOf）：iteration 行只由「最新 Owner 决定是否绑当前正文」决定；terminated/rejected 仍拦（AC②④）
//  ② 产品重评通过（ops.mjs cmdReqReview）的状态推进：iteration 归一到「重做轮起点 approved」，落 approved/ready（AC①）
//  ③ 界面分组（review-list-core）：iteration 不归已收口、归进行中（AC③）
// 用法：node scripts/test-4226-iteration-gate.cjs（纯本地，不写任何状态）
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log('PASS  ' + name); }
  else { fails.push({ name, detail }); console.log('FAIL  ' + name + ' · ' + JSON.stringify(detail)); }
};

(async () => {
  // ── ① 任务门
  const gates = await import(pathToFileURL(path.join(ROOT, '团队', '工具', 'lib', 'gates.mjs')).href);
  const H = 'sha-当前正文';
  const curDecision = (status) => ({ status, decision: status, channel: 'ui', at: '2026-11-17T00:00:00Z', basis: { requirement: { sha256: H } } });
  const task = { id: 'T-20261117-000000-aaaa', requirementId: 'R-20261116-063521-fe90' };
  const rowOf = (status, decisions) => ({ id: 'R-20261116-063521-fe90', status, requirementHash: H, decisions: decisions || [] });

  const iterApproved = gates.taskGateOf({ task, row: rowOf('iteration', [curDecision('approved')]) });
  check('① iteration + Owner 已按当前正文批准 → 任务门放行（不再 TASK_GATE_NOT_APPROVED）', iterApproved === null, iterApproved);

  const iterNoDecision = gates.taskGateOf({ task, row: rowOf('iteration', []) });
  check('① iteration + 无 Owner 决定 → 仍拦（cause=missing，不误放）',
    Boolean(iterNoDecision && iterNoDecision.code === 'TASK_GATE_NOT_APPROVED' && iterNoDecision.cause === 'missing'), iterNoDecision);

  const iterStaleRejected = gates.taskGateOf({ task, row: rowOf('iteration', [{ status: 'rejected', decision: 'rejected', basis: { requirement: { sha256: 'sha-旧正文' } } }]) });
  check('① iteration + Owner 只拒过旧正文 → 仍拦（旧决定不算数）',
    Boolean(iterStaleRejected && iterStaleRejected.code === 'TASK_GATE_NOT_APPROVED'), iterStaleRejected);

  const terminatedApproved = gates.taskGateOf({ task, row: rowOf('terminated', [curDecision('approved')]) });
  check('④ terminated 即使有当前正文批准 → 仍拦（拦截不回归）',
    Boolean(terminatedApproved && terminatedApproved.code === 'TASK_GATE_NOT_APPROVED' && terminatedApproved.cause === 'rejected'), terminatedApproved);

  const rejectedRejected = gates.taskGateOf({ task, row: rowOf('rejected', [{ status: 'rejected', decision: 'rejected', basis: { requirement: { sha256: H } } }]) });
  check('④ rejected 行 → 仍拦（拦截不回归）',
    Boolean(rejectedRejected && rejectedRejected.code === 'TASK_GATE_NOT_APPROVED' && rejectedRejected.cause === 'rejected'), rejectedRejected);

  // ── ② 重评通过的状态推进：从 ops.mjs 抽取真实实现片段执行（不重写判据）
  const opsSrc = fs.readFileSync(path.join(ROOT, '团队', '工具', 'lib', 'ops.mjs'), 'utf8');
  const rankStart = opsSrc.indexOf('const REQUIREMENT_STATUS_RANK = {');
  const rankEnd = opsSrc.indexOf('};', rankStart) + 2;
  const rankBlock = opsSrc.slice(rankStart, rankEnd);
  const fnStart = opsSrc.indexOf('function statusRank(status) {');
  const fnEnd = opsSrc.indexOf('function ownerDecisionList', fnStart);
  const helpers = opsSrc.slice(fnStart, fnEnd);
  const reviewBaseLine = (opsSrc.match(/const reviewBase = currentStatus === 'iteration' \? 'approved' : currentStatus;/) || [])[0];
  const nextLine = (opsSrc.match(/nextStatus = keepForwardStatus\(reviewBase, decisionFresh \? 'ready' : 'approved'\);/) || [])[0];
  const techLine = (opsSrc.match(/nextStatus = keepForwardStatus\(\['rejected', 'iteration'\]\.includes\(currentStatus\) \? 'approved' : currentStatus, 'ready'\);/) || [])[0];
  check('② ops.mjs 已含 iteration 归一实现（reviewBase + keepForwardStatus）', Boolean(reviewBaseLine && nextLine));
  check('② ops.mjs 技术评审路径也归一 iteration', Boolean(techLine));
  if (reviewBaseLine && nextLine) {
    const sim = new Function('currentStatus', 'decisionFresh',
      rankBlock + '\n' + helpers + '\n' + reviewBaseLine + '\n' + nextLine + '\nreturn nextStatus;');
    const cases = [
      ['iteration', false, 'approved'],   // 产品按新正文重评通过（Owner 还没重批）→ 回「等你决定」
      ['iteration', true, 'ready'],       // Owner 已按同一正文批过 → 直接 ready
      ['rejected', false, 'approved'],
      ['approved', false, 'approved'],
      ['dev', false, 'dev'],              // 既有「只前进」不回归
      ['test_done', false, 'test_done'],
      ['terminated', false, 'terminated'], // 终止不回退
    ];
    const bad = [];
    for (const [cur, fresh, want] of cases) {
      let got = null;
      try { got = sim(cur, fresh); } catch (e) { got = 'ERR:' + String((e && e.message) || e); }
      if (got !== want) bad.push({ cur, fresh, want, got });
    }
    check('② 重评状态推进：iteration→approved/ready，其余只前进不回归（7 例）', bad.length === 0, bad);
  }

  // ── ③ 界面分组（review-list-core）
  const RL = require(path.join(ROOT, 'src', 'renderer', 'review-list-core.js'));
  check('③ review-list-core：iteration → 进行中（不再已收口）',
    RL.groupOf({ id: 'R-x', status: 'iteration' }).group === 'running'
    && !Array.from(RL.STATUS_GROUP.closed).includes('iteration'));
  check('③ 收口态回归：accepted/terminated/rejected 仍归已收口',
    ['accepted', 'terminated', 'rejected'].every((s) => RL.groupOf({ id: 'R-y', status: s }).group === 'closed'));

  console.log('\nB-4226 断言：' + pass + '/' + (pass + fails.length) + ' PASS');
  if (fails.length) { console.log(JSON.stringify(fails, null, 2)); process.exit(1); }
})().catch((e) => {
  console.error('ERR ' + ((e && e.stack) || e));
  process.exit(2);
});
