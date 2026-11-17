#!/usr/bin/env node
'use strict';
/**
 * test-owner-decision-fresh.cjs —— 缺陷 B-20261117-100603-9dc0 + B-20261117-012703-f2c0 自检
 *
 * 口径：壳层必须和 CLI 的 G3 用**同一份**「Owner 决定是否绑当前正文」判定。
 *   ① 当前正文版本优先取磁盘真实哈希（readRequirementDocs：hash=文件 sha256），
 *      取不到才回退到行字段（requirementHash / requirementReview.requirementHash）；
 *   ② 有决定但 basis 与当前正文不等 → stale（壳层验收必须拒）；决定绑当前正文 → fresh；
 *      完全没有决定 / 两侧都没有版本信息 → 不判 stale（历史兼容，不新增硬门）；
 *   ③ 接线：ownerAccept（验收）与 reqReview（产品重评）都必须调用这一份判定，不许第二份实现。
 *
 * 纯函数 + 真实磁盘文档（只读，不写任何状态），运行：node scripts/test-owner-decision-fresh.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const TT = require(path.join(ROOT, 'src', 'team-tools.js'));
const PROJECT = path.join(ROOT, '项目', '工作台改造修复');
const REQ_ID = 'R-20261117-110507-6bc8';

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 320)}`);
}
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

// ── S1 磁盘版本：真需求正文的 sha256 必须与 currentRequirementDocVersion 取到的一致
const docName = fs.readdirSync(path.join(PROJECT, '需求')).find((name) => name.startsWith(REQ_ID));
const diskSha = sha256(path.join(PROJECT, '需求', docName));
const version = TT.currentRequirementDocVersion(PROJECT, REQ_ID);
check('S1 当前正文版本取磁盘真实 sha256（source=disk，与文件哈希逐位相等）',
  version.source === 'disk' && version.sha256 === diskSha && Boolean(version.contentHash),
  { version, diskSha });

// ── S2 决定绑当前正文 → fresh
const freshRow = {
  id: REQ_ID,
  requirementHash: diskSha,
  decisions: [{ status: 'approved', at: '2026-11-17T05:00:00.000Z', basis: { requirement: { sha256: diskSha } } }],
};
const fresh = TT.ownerDecisionStaleness(PROJECT, REQ_ID, freshRow);
check('S2 决定绑当前正文 → stale=false（reason=fresh）',
  fresh.stale === false && fresh.reason === 'fresh' && fresh.decisionSha === diskSha, fresh);

// ── S3 正文改过后（basis 是旧 hash）→ stale，且报出两侧 hash 供界面说明
const staleRow = {
  id: REQ_ID,
  requirementHash: diskSha,
  decisions: [{ status: 'approved', at: '2026-11-16T05:00:00.000Z', basis: { requirement: { sha256: 'OLDHASH_0000' } } }],
};
const stale = TT.ownerDecisionStaleness(PROJECT, REQ_ID, staleRow);
check('S3 决定绑旧正文 → stale=true（decisionSha=旧值、version.sha256=当前值）',
  stale.stale === true && stale.reason === 'stale' && stale.decisionSha === 'OLDHASH_0000' && stale.version.sha256 === diskSha, stale);

// ── S4 没有决定 → 不判 stale（历史无 decisions 的行不被新硬门误拦）
const noDecision = TT.ownerDecisionStaleness(PROJECT, REQ_ID, { id: REQ_ID, decisions: [] });
check('S4 没有决定 → stale=false（reason=no-decision，不新增硬门）',
  noDecision.stale === false && noDecision.reason === 'no-decision', noDecision);

// ── S5 决定与行都没有版本信息 → 不判 stale（无法证明失效就不拦，避免老数据全红）
const noVersion = TT.ownerDecisionStaleness(path.join(ROOT, '_tmp', 'no-such-project'), 'R-none', { id: 'R-none', decisions: [{ status: 'approved' }] });
check('S5 两侧都取不到版本 → stale=false（reason=no-version，不拿空值判失效）',
  noVersion.stale === false && noVersion.reason === 'no-version', noVersion);

// ── S6 contentHash 兜底：basis 只有 contentHash 且与当前内容哈希相等 → fresh
const byContent = TT.ownerDecisionStaleness(PROJECT, REQ_ID, {
  id: REQ_ID,
  decisions: [{ status: 'approved', basis: { requirement: { contentHash: version.contentHash } } }],
});
check('S6 basis 只带 contentHash 且与当前内容哈希相等 → fresh（兼容旧决定字段）',
  byContent.stale === false && byContent.reason === 'fresh', byContent);

// ── S7 接线断言（静态）：验收与产品重评必须调用同一份判定
const src = fs.readFileSync(path.join(ROOT, 'src', 'team-tools.js'), 'utf8');
const acceptIdx = src.indexOf('OWNER_DECISION_STALE');
const acceptCall = /if \(decision === 'accepted'\) \{\s*\n\s*const freshness = ownerDecisionStaleness\(/.test(src);
check('S7① ownerAccept 验收前调用 ownerDecisionStaleness（decision=accepted 分支）',
  acceptIdx > 0 && acceptCall, { hasErrorCode: acceptIdx > 0, acceptCall });
const reviewCall = /const ownerState = ownerDecisionStaleness\(ctx\.projectPath, requirementId, row\);/.test(src);
const keepMark = src.includes('product_review_keep_owner_decision');
check('S7② 产品重评 approve 分支调用同一份判定，决定新鲜时不抹回 pending（写历史标记）',
  reviewCall && keepMark, { reviewCall, keepMark });
const singleSource = (src.match(/function ownerDecisionStaleness\(/g) || []).length === 1
  && (src.match(/ownerDecisionStaleness\(/g) || []).length >= 3;
check('S7③ 判定只有一份实现（function 定义 1 处、调用点 ≥2）',
  singleSource, { defs: (src.match(/function ownerDecisionStaleness\(/g) || []).length, calls: (src.match(/ownerDecisionStaleness\(/g) || []).length });

// ── S8 真实行回归：真实工作流里的末条决定与当前正文的关系按同一判据给出（只读，不改数据）
const WF = path.join(ROOT, '团队', '状态', '项目', '工作台改造修复', '工作流.json');
const wf = JSON.parse(fs.readFileSync(WF, 'utf8'));
const realRow = (wf.requirements || {})[REQ_ID] || null;
const realStale = realRow ? TT.ownerDecisionStaleness(PROJECT, REQ_ID, realRow) : null;
check('S8 真实需求行跑得通（返回 reason ∈ fresh/stale/no-decision/no-version）',
  Boolean(realStale) && ['fresh', 'stale', 'no-decision', 'no-version'].includes(realStale.reason),
  realStale && { reason: realStale.reason, stale: realStale.stale });

console.log(`\n壳层决定-正文绑定自检：${passed}/${passed + failures.length} PASS`);
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exit(1); }
process.exit(0);
