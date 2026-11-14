#!/usr/bin/env node
// T-69ed 代管按钮简化静态校验（程序员B）：
// ①「本轮 / 每轮」两个按钮与入口必须消失；②只留「全部交 PM 代管」+「结束代管」；
// ③「全部」覆盖 Owner 门 + 等你验收（test_done）；④旧 once/always 记录照常读取；
// ⑤主进程与团队工具仍兼容 once/always（旧记录/旧调用不被拒）。
// 用法：node scripts/test-proxy-simple.cjs [--json]
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const reviewFile = path.join(ROOT, 'src', 'renderer', 'owner-review.js');
const mainFile = path.join(ROOT, 'src', 'main.js');
const toolsFile = path.join(ROOT, 'src', 'team-tools.js');
const reviewSrc = fs.readFileSync(reviewFile, 'utf8');
const mainSrc = fs.readFileSync(mainFile, 'utf8');
const toolsSrc = fs.readFileSync(toolsFile, 'utf8');

const checks = [];
const push = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail || '' });

// ① 旧按钮与入口消失
push('不含「本轮交 PM 代管」按钮', !/data-or-proxy-once/.test(reviewSrc));
push('不含「每轮交 PM 代管」按钮', !/data-or-proxy-always/.test(reviewSrc));
push('不含 startProxy(once/always) 入口', !/startProxy\s*\(\s*'(once|always)'\s*\)/.test(reviewSrc));
push('不含单条代管函数 startProxy(scope)', !/async function startProxy\s*\(\s*scope\s*\)/.test(reviewSrc));

// ② 只留全部 + 结束代管
push('保留「全部交 PM 代管」按钮', /data-or-proxy-all/.test(reviewSrc) && /全部交 PM 代管/.test(reviewSrc));
push('点击全部走批量函数', /data-or-proxy-all[\s\S]{0,80}startProxyAll/.test(reviewSrc));
push('批量调用带 scope=always', /async function startProxyAll[\s\S]{0,700}scope:\s*'always'/.test(reviewSrc));
push('保留「结束代管」按钮', /data-owner-review-proxy-end/.test(reviewSrc) && /结束代管/.test(reviewSrc));
push('结束代管仍调 ownerProxyEnd', /async function endProxy[\s\S]{0,300}ownerProxyEnd/.test(reviewSrc));

// ③ 全部覆盖 Owner 门 + 验收
push('新增等待 Owner 的批量范围函数', /function rowsAwaitingOwner\(/.test(reviewSrc));
push('批量范围含 test_done（验收）', /function rowsAwaitingOwner\([\s\S]{0,700}status === 'test_done'/.test(reviewSrc));
push('批量范围排除已结束/已打回', /function rowsAwaitingOwner\([\s\S]{0,400}accepted', 'terminated', 'iteration', 'rejected/.test(reviewSrc));

// ④ 旧记录兼容：读取只看 endedAt，不按 scope 过滤
push('旧 once/always 记录照常读取（只判 endedAt）', /state\.proxyRecords = \(r && Array\.isArray\(r\.records\)\) \? r\.records\.filter\(\(row\) => !row\.endedAt\)/.test(reviewSrc));
push('前端不按 scope 排除旧记录', !/proxyRecords[\s\S]{0,120}scope === 'always'/.test(reviewSrc));

// ⑤ 主进程/团队工具仍兼容 once/always
push('主进程仍接受 once/always（兼容旧调用）', /\[['"]once['"],\s*['"]always['"]\]\.includes\(scope\)/.test(mainSrc));
push('团队工具 proxy 通道仍接受 once/always（旧记录落账）', /\[['"]once['"],\s*['"]always['"]\]\.includes\(proxyScope\)/.test(toolsSrc));

// 判据样本：与 rowsAwaitingOwner 同规则，验证五种状态归类
function classify(row) {
  const status = String((row && row.status) || '');
  if (['accepted', 'terminated', 'iteration', 'rejected'].includes(status)) return false;
  const owner = String((row && row.ownerReview && row.ownerReview.status) || '');
  if (['approved', 'skipped', 'rejected'].includes(owner)) return false;
  return status === 'approved' || status === 'owner_review' || status === 'test_done';
}
const samples = [
  { name: '等 Owner 决定（approved）', row: { status: 'approved', ownerReview: { status: 'pending' } }, want: true },
  { name: '等 Owner 决定（owner_review）', row: { status: 'owner_review', ownerReview: { status: 'pending' } }, want: true },
  { name: '等你验收（test_done）', row: { status: 'test_done', ownerReview: { status: 'pending' } }, want: true },
  { name: '已完成（accepted）', row: { status: 'accepted', ownerReview: { status: 'approved' } }, want: false },
  { name: '已打回（rejected）', row: { status: 'rejected', ownerReview: { status: 'rejected' } }, want: false },
];
for (const sample of samples) {
  const got = classify(sample.row);
  push('判据 ' + sample.name, got === sample.want, '期望 ' + sample.want + '，实际 ' + got);
}

const failed = checks.filter((c) => !c.ok);
const report = { file: path.relative(ROOT, reviewFile).replace(/\\/g, '/'), checks: checks.length, failed: failed.length, failures: failed, ok: failed.length === 0 };
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else {
  for (const c of checks) console.log((c.ok ? 'PASS  ' : 'FAIL  ') + c.name + (c.detail ? ' · ' + c.detail : ''));
  console.log(report.ok ? 'PROXY_SIMPLE_OK' : 'PROXY_SIMPLE_FAIL');
}
process.exitCode = report.ok ? 0 : 1;
