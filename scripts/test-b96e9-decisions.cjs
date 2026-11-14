'use strict';
/** B-96e9 回归：复审时同状态决定不再误判重复 + 旧 rejected 不再挡住验收（按 gateInvalidatedAt/deliveryRound 口径）。 */
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 260)}`);
  if (!ok) process.exitCode = 1;
}
(async () => {
  const mod = await import('file:///' + path.join(ROOT, '团队', '工具', 'lib', 'lifecycle.mjs').replace(/\\/g, '/'));
  const { latestValidOwnerDecision, currentDeliveryRound } = mod;
  check('① 导出 latestValidOwnerDecision / currentDeliveryRound', typeof latestValidOwnerDecision === 'function' && typeof currentDeliveryRound === 'function', Object.keys(mod).filter((k) => /Decision|Round/.test(k)));

  const oldRejected = { status: 'rejected', at: '2026-11-15T00:00:00.000Z' };
  const newApproved = { status: 'approved', at: '2026-11-15T01:00:00.000Z' };
  const row1 = { decisions: [oldRejected, newApproved], gateInvalidatedAt: '2026-11-15T00:30:00.000Z', deliveryRound: 2, ownerReview: { status: 'rejected', at: oldRejected.at } };
  const latest1 = latestValidOwnerDecision(row1);
  check('② 旧 rejected 早于 gateInvalidatedAt → 取到新 approved（验收不再被挡）', latest1 && latest1.status === 'approved', latest1);

  const row2 = { decisions: [newApproved], deliveryRound: 3, round: 1 };
  check('③ 轮次口径：deliveryRound 优先', currentDeliveryRound(row2) === 3, currentDeliveryRound(row2));
  check('③ 缺 deliveryRound 回退 round；都缺按 1', currentDeliveryRound({ round: 2 }) === 2 && currentDeliveryRound({}) === 1, [currentDeliveryRound({ round: 2 }), currentDeliveryRound({})]);

  const row3 = { decisions: [oldRejected, oldRejected], gateInvalidatedAt: '2026-11-15T02:00:00.000Z' };
  check('④ 全部决定都被失效 → 返回 null（不再沿用旧 rejected 拦验收）', latestValidOwnerDecision(row3) === null, latestValidOwnerDecision(row3));

  // ⑤ 去重口径：同状态但落在旧轮/失效前 → 不算重复（模拟壳层判据）
  const gateMs = Date.parse('2026-11-15T00:30:00.000Z');
  const round = 2;
  const dupCheck = (d) => String(d.status) === 'approved'
    && Number(d.round || round) === round
    && (!Number.isFinite(Date.parse(String(d.at))) || !gateMs || Date.parse(String(d.at)) >= gateMs);
  const tooOld = { status: 'approved', at: '2026-11-15T00:00:00.000Z', round: 1 };
  const current = { status: 'approved', at: '2026-11-15T01:00:00.000Z', round: 2 };
  check('⑤ 旧轮/失效前的同状态决定不算重复', dupCheck(tooOld) === false && dupCheck(current) === true, { tooOld: dupCheck(tooOld), current: dupCheck(current) });

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nB-96e9 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
})();
