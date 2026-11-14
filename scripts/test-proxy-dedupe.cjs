#!/usr/bin/env node
// B-20261113-014634-0cdd 代管记录去重静态校验（程序员A）：
// 现象：连点「全部交 PM 代管」时，同一需求在 评审代管.json 里出现多组 active 记录。
// 本脚本固定住修好后的四条：①按 requirementId upsert（有 active 就更新，不新增）；
// ②批量/单条走同一函数；③返回去重视图 active（每需求最多一条未结束）；④ended 历史不动。
// 再用判据样本复刻 upsert 算法：连点 3 次后每需求仍只有 1 条 active，历史条数不删。
// 用法：node scripts/test-proxy-dedupe.cjs [--json]
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const start = mainSrc.indexOf("ipcMain.handle('owner:proxy-start'");
const end = start >= 0 ? mainSrc.indexOf("ipcMain.handle('owner:proxy-end'", start) : -1;
const handler = start >= 0 && end > start ? mainSrc.slice(start, end) : '';

const checks = [];
const push = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail || '' });

push('找到 owner:proxy-start handler', Boolean(handler));
push('按 requirementId 收集未结束记录', /const actives = data\.records\.filter\(\(row\) => row\.requirementId === requirementId && !row\.endedAt\)/.test(handler));
push('有 active 就更新、不新增（upsert）', /if \(keep\) \{[\s\S]{0,240}keep\.scope = scope/.test(handler) && /else \{\s*const row = \{/.test(handler));
push('存量全局收敛：每次开代管都按需求收敛成一条', /const seenActive = new Set\(\)/.test(handler) && /for \(const row of byNewest\)/.test(handler));
push('重复 active 标 endedBy=dedupe 而不删除', /row\.endedAt = at/.test(handler) && /row\.endedBy = 'dedupe'/.test(handler));
push('保留 updatedAt 最新的一条', /String\(b\.updatedAt \|\| b\.startedAt \|\| ''\)\.localeCompare/.test(handler) && /\[0\]/.test(handler));
push('历史 ended 记录不删不重写（只跳过）', /if \(row\.endedAt\) continue;/.test(handler) && !/data\.records = data\.records\.filter/.test(handler));
push('返回去重视图 active', /const active = data\.records\.filter\(\(row\) => !row\.endedAt\)/.test(handler) && /active, started, count/.test(handler));
push('返回 deduped 计数', /deduped, warnings/.test(handler) && /deduped\.push\(row\.requirementId\)/.test(handler));
push('批量与单条同一条路径（先合并成 requirementIds 再循环）', /const requirementIds = Array\.isArray\(p\.requirementIds\)/.test(handler) && /for \(const requirementId of requirementIds\)/.test(handler));

// ── 判据样本：复刻 handler 的 upsert + 全局收敛算法 ────────────────────────
function upsert(records, requirementIds, at, authorization) {
  const list = records.map((r) => ({ ...r }));
  const deduped = [];
  for (const requirementId of requirementIds) {
    const actives = list.filter((row) => row.requirementId === requirementId && !row.endedAt);
    const keep = actives.length
      ? actives.slice().sort((a, b) => String(b.updatedAt || b.startedAt || '').localeCompare(String(a.updatedAt || a.startedAt || '')))[0]
      : null;
    if (keep) { keep.scope = 'always'; keep.authorization = authorization; keep.updatedAt = at; }
    else list.push({ scope: 'always', requirementId, startedAt: at, updatedAt: at, endedAt: null });
  }
  const seen = new Set();
  const byNewest = list.slice().sort((a, b) => String(b.updatedAt || b.startedAt || '').localeCompare(String(a.updatedAt || a.startedAt || '')));
  for (const row of byNewest) {
    if (row.endedAt) continue;
    if (seen.has(row.requirementId)) { row.endedAt = at; row.endedBy = 'dedupe'; deduped.push(row.requirementId); }
    else seen.add(row.requirementId);
  }
  return { records: list, deduped, active: list.filter((r) => !r.endedAt) };
}
const activeCount = (list, id) => list.filter((r) => r.requirementId === id && !r.endedAt).length;

let db = { records: [] };
for (const t of ['2026-11-13T01:00:00Z', '2026-11-13T01:00:05Z', '2026-11-13T01:00:10Z']) {
  db = upsert(db.records, ['R-99ff', 'R-b417'], t, '连点测试');
}
push('判据：连点 3 次后每个需求只有 1 条 active', activeCount(db.records, 'R-99ff') === 1 && activeCount(db.records, 'R-b417') === 1, `99ff=${activeCount(db.records, 'R-99ff')} b417=${activeCount(db.records, 'R-b417')}`);
push('判据：连点 3 次总记录数仍是 2 条（不追加）', db.records.length === 2, '实际 ' + db.records.length);

// 历史遗留：同一需求已有 3 条 active（旧 bug 留下的）
let legacy = { records: [
  { requirementId: 'R-99ff', startedAt: '2026-11-13T00:00:00Z', updatedAt: '2026-11-13T00:00:00Z', endedAt: null, scope: 'once' },
  { requirementId: 'R-99ff', startedAt: '2026-11-13T00:01:00Z', updatedAt: '2026-11-13T00:05:00Z', endedAt: null, scope: 'once' },
  { requirementId: 'R-99ff', startedAt: '2026-11-13T00:02:00Z', updatedAt: '2026-11-13T00:02:00Z', endedAt: null, scope: 'once' },
  { requirementId: 'R-99ff', startedAt: '2026-11-13T00:03:00Z', updatedAt: '2026-11-13T00:03:00Z', endedAt: '2026-11-13T00:04:00Z', scope: 'once' },
] };
const beforeHistory = legacy.records.filter((r) => r.endedAt).length;
const fixed = upsert(legacy.records, ['R-99ff'], '2026-11-13T01:00:00Z', '修复历史重复');
push('判据：历史遗留 3 条 active 合并成 1 条', activeCount(fixed.records, 'R-99ff') === 1, '实际 ' + activeCount(fixed.records, 'R-99ff'));
push('判据：只保留 updatedAt 最新的一条（保留其原 startedAt 00:01）', fixed.records.filter((r) => !r.endedAt)[0].startedAt === '2026-11-13T00:01:00Z', '实际 ' + fixed.records.filter((r) => !r.endedAt)[0].startedAt);
push('判据：已有 ended 历史条数不变', fixed.records.filter((r) => r.endedAt).length >= beforeHistory && beforeHistory === 1);
push('判据：合并记录不删除（总数不变）', fixed.records.length === legacy.records.length);
push('判据：两个需求互不影响', (() => {
  const r = upsert([{ requirementId: 'R-a', startedAt: 't0', updatedAt: 't0', endedAt: null }, { requirementId: 'R-b', startedAt: 't0', updatedAt: 't0', endedAt: null }], ['R-a'], 't1', 'x');
  return activeCount(r.records, 'R-a') === 1 && activeCount(r.records, 'R-b') === 1 && r.deduped.length === 0;
})());
push('判据：不在本次 ids 里的历史重复也会被收敛（存量自愈）', (() => {
  const r = upsert([
    { requirementId: 'R-x', startedAt: 't0', updatedAt: 't0', endedAt: null },
    { requirementId: 'R-x', startedAt: 't1', updatedAt: 't1', endedAt: null },
  ], [], 't2', 'x');
  return r.active.length === 1 && r.deduped.length === 1;
})());

const failed = checks.filter((c) => !c.ok);
const report = { checks: checks.length, failed: failed.length, failures: failed, ok: failed.length === 0 };
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else {
  for (const c of checks) console.log((c.ok ? 'PASS  ' : 'FAIL  ') + c.name + (c.detail ? ' · ' + c.detail : ''));
  console.log(report.ok ? 'PROXY_DEDUPE_OK' : 'PROXY_DEDUPE_FAIL');
}
process.exitCode = report.ok ? 0 : 1;
