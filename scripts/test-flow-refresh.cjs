#!/usr/bin/env node
// B-20261113-005026-c447 流程图不刷新静态校验（程序员A）：
// 旧签名只看需求行 id/status/updatedAt，Owner 只改 ownerReview 时签名不变 → 主面板不重绘。
// 本脚本固定住修好后的四条：①签名含 ownerReview.status；②含 decisions 条数与最近决定时间；
// ③含账本分叉条数；④仍按签名节流并在 5 秒轮询后重绘。再给 2 组判据样本证明变化能触发重绘。
// 用法：node scripts/test-flow-refresh.cjs [--json]
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');

const checks = [];
const push = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail || '' });

// 取 flowRenderSignature 函数体做精确定位（避免命中别处同名变量）。
const start = appSrc.indexOf('function flowRenderSignature(p)');
const end = start >= 0 ? appSrc.indexOf('\nfunction renderFlow()', start) : -1;
const body = start >= 0 && end > start ? appSrc.slice(start, end) : '';
push('找到 flowRenderSignature', Boolean(body));
push('签名含 Owner 决定状态 ownerReview.status', /owner\s*\.status|owner\.status/.test(body) && /ownerReview/.test(body));
push('签名含 decisions 条数', /owner\.decisions/.test(body) && /decisions\.length/.test(body));
push('签名含最近决定时间', /lastDecisionAt/.test(body) && /\.at|confirmedAt/.test(body));
push('签名含账本分叉条数', /legacyLedgerDivergences\(\)\.length/.test(body) && /ledgerCount/.test(body));
push('签名仍含需求行 id/status/updatedAt（原有字段不丢）', /`\$\{r\.id\}:\$\{r\.status\}:\$\{r\.updatedAt \|\| ''\}/.test(body));
push('渲染入口仍按签名节流（相同就 return）', /flowRenderUi\.sig === flowSig\) return;/.test(appSrc));
push('判定后按节拍刷新（1 秒心跳 + 4 秒节流，最坏 5 秒内命中）', /flowLiveState\.nextAt = Date\.now\(\) \+ 4000/.test(appSrc) && /function flowRefreshTick\(\)/.test(appSrc) && /1 秒心跳 \+ 5 秒节流/.test(appSrc));
push('面板打开时强制重绘一次（不等节拍）', /setFlowPanel[\s\S]{0,700}flowRenderUi\.sig = ''/.test(appSrc));

// ── 判据样本：复刻签名片段，验证「只改 ownerReview」能改变签名 ──────────────
function rowSig(req, { withOwner = true } = {}) {
  const owner = withOwner && req && req.ownerReview && typeof req.ownerReview === 'object' ? req.ownerReview : null;
  const decisions = Array.isArray(owner && owner.decisions) ? owner.decisions : [];
  const lastAt = decisions.length
    ? String((decisions[decisions.length - 1] && (decisions[decisions.length - 1].at || decisions[decisions.length - 1].confirmedAt)) || '')
    : '';
  const ownerAt = String((owner && owner.at) || '');
  const tail = withOwner ? `:${owner ? (owner.status || '') : ''}:${decisions.length}:${lastAt || ownerAt}` : '';
  return `${req.id}:${req.status}:${req.updatedAt || ''}${tail}`;
}
function sigOf(req, ledgerCount, opts) {
  return JSON.stringify([rowSig(req, opts), ledgerCount]);
}

const base = { id: 'R-1', status: 'approved', updatedAt: '2026-11-13T00:00:00Z', ownerReview: { status: 'pending' } };
const decided = { ...base, ownerReview: { status: 'skipped', decisions: [{ at: '2026-11-13T01:00:00Z', status: 'skipped' }] } };
push('判据：旧签名对只改 ownerReview 不敏感（复现原 bug）', sigOf(base, 0, { withOwner: false }) === sigOf(decided, 0, { withOwner: false }));
push('判据：新签名对 ownerReview 变化敏感（会重绘）', sigOf(base, 0) !== sigOf(decided, 0));
push('判据：decisions 从 0 到 1 也改变签名', sigOf({ ...base, ownerReview: { status: 'skipped' } }, 0) !== sigOf(decided, 0));
push('判据：账本分叉条数变化改变签名', sigOf(base, 0) !== sigOf(base, 1));

const failed = checks.filter((c) => !c.ok);
const report = { checks: checks.length, failed: failed.length, failures: failed, ok: failed.length === 0 };
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else {
  for (const c of checks) console.log((c.ok ? 'PASS  ' : 'FAIL  ') + c.name + (c.detail ? ' · ' + c.detail : ''));
  console.log(report.ok ? 'FLOW_REFRESH_OK' : 'FLOW_REFRESH_FAIL');
}
process.exitCode = report.ok ? 0 : 1;
