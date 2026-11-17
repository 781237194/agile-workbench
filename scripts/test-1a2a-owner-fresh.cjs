#!/usr/bin/env node
'use strict';
/**
 * test-1a2a-owner-fresh.cjs —— B-20261117-095558-1a2a 回归夹具（评审弹窗「新鲜决定被误判过期」）
 *
 * 现场（ad44）：决定 basis.requirement.sha256 = 1a618bd0（= 磁盘正文），但行上 requirementHash 是更旧的 RR 值
 * 1211a8a3 → 渲染层拿后者当「当前正文」，把刚落账的决定判成「上一版已过期」，还留在【等你决定】，
 * 点通过再报 DUPLICATE_DECISION。
 *
 * 本夹具断言：
 *   N1 修复口径：docSha256=当前正文、requirementHash=旧 RR 值，决定 basis=当前正文 → 判「当前」（不再报过期）
 *   N2 由 N1 派生：该行 isPending=false、decidedStatusOf=approved（不再列在【等你决定】）
 *   N3 反例（AC⑤）：正文真被改过（docSha256≠basis）→ 仍判旧版本、仍需重新决定
 *   N4 contentHash 口径：basis.contentHash = docContentHash 时也算当前
 *   N5 老数据兼容：行上没有 docSha256（老快照）→ 退回 requirementHash 判据，行为不变
 *   N6 AC④ 静态：ops.mjs 的 Owner 决定 history 写入 by 用 `proxyMode ? 'pm' : 'Owner'`（代记记 pm）
 *   N7 静态：team-tools 需求行快照带上 `docSha256`（从磁盘扫描的正文 hash）
 *
 * 跑法：node scripts/test-1a2a-owner-fresh.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ORS = require(path.join(ROOT, 'src', 'renderer', 'owner-review-state.js'));
const OPS = path.join(ROOT, '团队', '工具', 'lib', 'ops.mjs');
const TEAM_TOOLS = path.join(ROOT, 'src', 'team-tools.js');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); return; }
  fail += 1; console.log(`FAIL  ${name}  ` + JSON.stringify(detail || {}).slice(0, 400)); process.exitCode = 1;
}

const DISK = 'd'.repeat(64);      // 当前磁盘正文
const RR_OLD = 'r'.repeat(64);    // 行上旧的 RR 值
const NEWER = 'n'.repeat(64);     // 正文又被改过
const dec = (sha, content) => ({
  status: 'approved', decision: 'approved', channel: 'proxy', actor: 'pm', at: '2026-11-17T01:03:23.238Z', opinion: '通过，按建议改颗粒度',
  basis: { requirement: { path: '需求/R-x.md', ...(sha ? { sha256: sha } : {}), ...(content ? { contentHash: content } : {}) } },
});
const rowOf = (extra = {}, decisions = [dec(DISK)]) => ({
  id: 'R-x', status: 'ready',
  ownerReview: { status: 'approved', at: '2026-11-17T01:03:23.238Z', opinion: 'x', channel: 'proxy', recordedBy: 'pm', stale: false },
  decisions, ...extra,
});

// N1/N2：决定性修复——行上 requirementHash 是旧的，但 docSha256 是当前正文
const freshRow = rowOf({ docSha256: DISK, requirementHash: RR_OLD, docContentHash: '', contentHash: RR_OLD });
ok('N1 docSha256=当前正文（行上 requirementHash 是旧 RR 值）→ 决定判「当前版本」（不再报过期）',
  ORS.isDecisionCurrent(dec(DISK), freshRow) === true, { current: ORS.currentDocHashOf(freshRow).slice(0, 8) });
ok('N2 派生：该行 isPending=false、decidedStatusOf=approved（不再列在【等你决定】）',
  ORS.isPending(freshRow) === false && ORS.decidedStatusOf(freshRow) === 'approved',
  { isPending: ORS.isPending(freshRow), decided: ORS.decidedStatusOf(freshRow) });

// N3：反例——正文真被改过，必须仍需重新决定
const staleRow = rowOf({ docSha256: NEWER, requirementHash: RR_OLD });
ok('N3 正文真改过（docSha256≠决定 basis）→ 仍判旧版本、仍需重新决定（AC⑤ 不破）',
  ORS.isDecisionCurrent(dec(DISK), staleRow) === false && ORS.isPending(staleRow) === true,
  { current: ORS.isDecisionCurrent(dec(DISK), staleRow), isPending: ORS.isPending(staleRow) });

// N4：contentHash 口径
const CH = 'c'.repeat(64);
const contentRow = rowOf({ docSha256: DISK, docContentHash: CH, requirementHash: RR_OLD });
ok('N4 basis.contentHash = docContentHash → 判当前（两条口径任一命中即可）',
  ORS.isDecisionCurrent(dec('', CH), contentRow) === true, {});

// N5：老快照（没有 docSha256）退回 requirementHash 判据，行为不变
const legacyRow = rowOf({ requirementHash: DISK }, [dec(DISK)]);
ok('N5 老快照无 docSha256 → 退回 requirementHash 判据，仍判当前（向后兼容）',
  ORS.isDecisionCurrent(dec(DISK), legacyRow) === true, { current: ORS.currentDocHashOf(legacyRow).slice(0, 8) });

// N6：AC④ 静态——代记 history 记 pm
const opsSrc = fs.readFileSync(OPS, 'utf8');
ok('N6 ops.mjs 的 Owner 决定 history 写入 by 用 `proxyMode ? \'pm\' : \'Owner\'`（代记记 pm，与 decisions 一致）',
  /by:\s*proxyMode\s*\?\s*'pm'\s*:\s*'Owner'/.test(opsSrc), {});

// N7：静态——快照带 docSha256（磁盘正文 hash）
const ttSrc = fs.readFileSync(TEAM_TOOLS, 'utf8');
ok('N7 team-tools 需求行快照从磁盘正文回填 docSha256（渲染层据此判「当前正文」）',
  /view\.docSha256\s*=\s*String\(liveDoc\.hash/.test(ttSrc), {});

console.log(`\nOWNER_DECISION_FRESH ${JSON.stringify({ total: pass + fail, pass, fail })}`);
process.exit(fail ? 1 : 0);
