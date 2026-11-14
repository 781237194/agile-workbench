'use strict';
/** B-37ea（续）：真实 2a69 形态行的 iterate 路径——iterationRound=1 / deliveryRound=null / gateInvalidatedAt=null 也要能验收、不判重复。 */
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

  // 真实 2a69 形态：round=1、iterationRound=1、deliveryRound=null、gateInvalidatedAt=null，
  // 只有 iterationAt（返工时刻）与更早的旧 rejected/approved 决定。
  const row = {
    id: 'R-2a69',
    status: 'iteration',
    round: 1,
    iterationRound: 1,
    deliveryRound: null,
    gateInvalidatedAt: null,
    iterationAt: '2026-11-15T02:00:00.000Z',
    decisions: [
      { status: 'rejected', channel: 'ui', by: 'Owner', at: '2026-11-14T20:00:00.000Z', opinion: '旧打回' },
      { status: 'approved', channel: 'ui', by: 'Owner', at: '2026-11-14T21:00:00.000Z' },
    ],
    ownerReview: { status: 'rejected', at: '2026-11-14T20:00:00.000Z' },
  };

  check('① 旧决定全部早于 iterationAt → 无“当前有效决定”（不挡验收）', latestValidOwnerDecision(row) === null, latestValidOwnerDecision(row));
  check('② 不得回落 legacy ownerReview（旧 rejected 不借壳复活）', latestValidOwnerDecision(row) === null, latestValidOwnerDecision(row));
  check('③ currentDeliveryRound 对 null deliveryRound 也能返回 >=1', currentDeliveryRound(row) >= 1, currentDeliveryRound(row));

  // 壳层去重口径复算：同样的 2a69 行，新 approved 必须放行（非重复）
  const rowObj = row;
  const rowRound = Math.max(Number(rowObj.deliveryRound) || 0, Number(rowObj.iterationRound) || 0, Number(rowObj.round) || 1, 1);
  const gateMs = Date.parse(String(rowObj.gateInvalidatedAt || ''));
  const iterMs = Date.parse(String(rowObj.iterationAt || ''));
  const cutList = [gateMs, iterMs].filter((n) => Number.isFinite(n) && n > 0);
  const cutoff = cutList.length ? Math.max(...cutList) : NaN;
  const stillValid = (d) => {
    const at = Date.parse(String((d && (d.at || d.decidedAt)) || ''));
    if (!Number.isFinite(at) || !Number.isFinite(cutoff)) return true;
    return at >= cutoff;
  };
  const isDup = (list, status) => list.some((d) => d && String(d.status) === status && Number(d.round || rowRound) === rowRound && stillValid(d));
  check('④ 2a69 真实行：新 approved 不再被判重复', isDup(row.decisions, 'approved') === false, { rowRound, cutoff: String(cutoff) });
  check('④ 新 rejected 会新增（不被自身空轮拦截）', isDup(row.decisions, 'rejected') === false, { rowRound });

  // ⑤ 反向：同轮、晚于 cutoff 的同状态决定仍算重复（防重复点击）
  const fresh = { status: 'approved', at: '2026-11-15T02:10:00.000Z', round: rowRound };
  check('⑤ 本轮已 approve 后重复 approve 仍判重复', isDup([...row.decisions, fresh], 'approved') === true, { rowRound });

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nB-37ea(续) 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
})();
