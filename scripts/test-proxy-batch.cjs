#!/usr/bin/env node
// B-20261113-004955-5f62 批量代管静态校验（程序员A）：
// 「全部交 PM 代管」原来批量永远失败：前端传 requirementIds 数组，主进程只读单数 requirementId，
// 取到空串 → BAD_REQUIREMENT。本脚本按行扫源码，固定住修好后的四条：
// ①主进程兼容数组并逐条写记录 + 每条一条事件 + 返回 records/started；
// ②前端批量带 requirementIds + scope=always，成功后提示「已开代管 N 条」；
// ③徽标扣掉已代管项、顶部显示「PM 代管中 M 条」、列表项标「已托管」；
// ④loadData 先取代管记录再算徽标（顺序反了徽标就扣不掉）。
// 用法：node scripts/test-proxy-batch.cjs [--json]
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const reviewSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'owner-review.js'), 'utf8');

const checks = [];
const push = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail || '' });

// ── ① 主进程：数组兼容 + 逐条写 + 逐条事件 + 返回 ──────────────────────────
const handlerStart = mainSrc.indexOf("ipcMain.handle('owner:proxy-start'");
const handlerEnd = mainSrc.indexOf("ipcMain.handle('owner:proxy-end'", handlerStart);
const handler = handlerStart >= 0 && handlerEnd > handlerStart ? mainSrc.slice(handlerStart, handlerEnd) : '';
push('主进程 owner:proxy-start 存在', Boolean(handler));
push('主进程读数组 requirementIds', /Array\.isArray\(p\.requirementIds\)/.test(handler));
push('主进程仍兼容单数 requirementId（旧调用不破）', /p\.requirementId/.test(handler));
push('数组去重 + 去空', /new Set\(p\.requirementIds\.map/.test(handler) && /filter\(Boolean\)/.test(handler));
push('逐条遍历 requirementIds', /for \(const requirementId of requirementIds\)/.test(handler));
push('已存在的活跃记录更新 scope/authorization/updatedAt',
  /const actives = data\.records\.filter/.test(handler)
  && /keep\.scope = scope/.test(handler)
  && /keep\.updatedAt = at/.test(handler));
push('不存在的需求新增一条记录', /data\.records\.push\(row\)/.test(handler));
push('每条需求写一条事件', /for \(const row of started\) addEvent\(/.test(handler));
push('更新 updatedAt 后落盘', /data\.updatedAt = at;[\s\S]{0,80}writeOwnerProxy\(project, data\)/.test(handler));
push('返回 records 与 started/count（含 warnings）', /return \{ ok: true, records: data\.records, active, started, count: started\.length, deduped, warnings \}/.test(handler));
push('事件落盘：状态库 writeStore（失败不阻断）', /try \{ writeStore\(store\); \} catch/.test(handler));
push('缺 id 时报 BAD_REQUIREMENT 而不是静默成功', /BAD_REQUIREMENT/.test(handler));

// ── ② 前端：批量传数组 + always + 提示条数 ────────────────────────────────
push('批量调用传 requirementIds 数组', /ownerProxyStart\(\{[\s\S]{0,200}requirementIds:\s*ids/.test(reviewSrc));
push('批量调用 scope=always', /async function startProxyAll[\s\S]{0,900}scope:\s*'always'/.test(reviewSrc));
push('批量范围含 Owner 门与等你验收', /function rowsAwaitingOwner\([\s\S]{0,600}status === 'test_done'/.test(reviewSrc));
push('成功提示「已开代管 N 条」', /已开代管 \$\{count\} 条/.test(reviewSrc));
push('提示条插到 head 的父节点（原先抛 NotFoundError 把成功当失败）', /card\.insertBefore\(box, head\.nextSibling\)/.test(reviewSrc));
push('结束代管后立刻刷新徽标与列表', /await window\.workbench\.ownerProxyEnd[\s\S]{0,260}updateBadge\(\);[\s\S]{0,60}renderDialog\(\);/.test(reviewSrc));

// ── ③ 徽标 / 顶部 / 列表标 ───────────────────────────────────────────────
push('徽标扣掉已代管项', /const proxiedCount = rows\.filter\(\(row\) => isProxied\(row\)\)\.length/.test(reviewSrc)
  && /const count = Math\.max\(0, rows\.length - proxiedCount\)/.test(reviewSrc));
push('顶部显示「PM 代管中 M 条」', /proxy\.textContent = `PM 代管中 \$\{count\} 条`/.test(reviewSrc));
push('顶部徽标带 data-proxy-count 便于断言', /setAttribute\('data-proxy-count'/.test(reviewSrc));
push('列表项标「已托管」', /proxyActive \? status \+ ' · 已托管'/.test(reviewSrc));
push('看板项带 data-proxied 标记', /if \(proxyActive\) item\.setAttribute\('data-proxied', '1'\)/.test(reviewSrc));
push('待评估清单排除已托管项', /const evalRows = pendingRowsList\.filter\(\(row\) => !isProxied\(row\)\)/.test(reviewSrc));

// ── ④ 顺序：先取代管记录再算徽标 ─────────────────────────────────────────
push('loadData 先 updateProxyBadge 再 updateBadge',
  /await updateProxyBadge\(\);[\s\S]{0,40}updateBadge\(\);/.test(reviewSrc));

// ── 判据样本：与 updateBadge 同规则，验证扣减与下限 ─────────────────────
function badgeCount(pendingIds, proxiedIds) {
  const proxied = pendingIds.filter((id) => proxiedIds.includes(id)).length;
  return Math.max(0, pendingIds.length - proxied);
}
const samples = [
  { name: '两条待评估都在代管中 → 0 条', want: 0, got: badgeCount(['b417', '99ff'], ['b417', '99ff']) },
  { name: '一条代管一条没代管 → 1 条', want: 1, got: badgeCount(['b417', '99ff'], ['99ff']) },
  { name: '代管记录比待评估多也不出现负数', want: 0, got: badgeCount(['b417'], ['b417', '99ff']) },
  { name: '没有代管记录 → 原样计数', want: 2, got: badgeCount(['b417', '99ff'], []) },
];
for (const sample of samples) push('判据 ' + sample.name, sample.got === sample.want, '期望 ' + sample.want + '，实际 ' + sample.got);

const failed = checks.filter((c) => !c.ok);
const report = { checks: checks.length, failed: failed.length, failures: failed, ok: failed.length === 0 };
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else {
  for (const c of checks) console.log((c.ok ? 'PASS  ' : 'FAIL  ') + c.name + (c.detail ? ' · ' + c.detail : ''));
  console.log(report.ok ? 'PROXY_BATCH_OK' : 'PROXY_BATCH_FAIL');
}
process.exitCode = report.ok ? 0 : 1;
