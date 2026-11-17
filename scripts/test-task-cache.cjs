#!/usr/bin/env node
'use strict';
/**
 * test-task-cache.cjs —— 缺陷 B-20261117-093837-02e9 自检（任务目录扫描缓存）
 *
 * 口径：
 *   ① 同一目录签名重复读 → 命中缓存（stats.hits 增长）且结果与全量扫描逐字节一致；
 *   ② 新增/删除任务文件会改目录 mtime → 签名变化 → 自动失效（不吃旧数据）；
 *   ③ 显式 invalidateTaskCache 后必失效（写路径 patchLegacyTask 已接）；
 *   ④ TTL 兜底：AWB_TASK_CACHE_TTL_MS=0 时永不命中（子进程验证，防「缓存关不掉」）；
 *   ⑤ 命中耗时显著低于全量扫描（同进程对比，量化 02e9 的收益）。
 *
 * 只写 _tmp 沙盘；运行：node scripts/test-task-cache.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TT = require(path.join(ROOT, 'src', 'team-tools.js'));
const SB = path.join(ROOT, '_tmp', `task-cache-${process.pid}`);
const PNAME = '缓存沙盘';
const TASKS = path.join(SB, '团队', '状态', '项目', PNAME, '任务');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 320)}`);
}

fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(TASKS, { recursive: true });
const TOTAL = 300;
for (let i = 0; i < TOTAL; i += 1) {
  const id = `T-cache-${String(i).padStart(4, '0')}`;
  fs.writeFileSync(path.join(TASKS, id + '.json'), JSON.stringify({
    id, title: `任务 ${i}`, status: 'open', createdAt: new Date(2026, 0, 1, 0, 0, i % 60).toISOString(),
  }) + '\n', 'utf8');
}

const tools = TT.create({ teamRoot: path.join(SB, '团队') });
TT.resetTaskCache();

// ── S1 首次未命中 / 二次命中，且结果一致
const t1 = Date.now();
const rows1 = tools.readLegacyTasks(PNAME);
const firstMs = Date.now() - t1;
const t2 = Date.now();
const rows2 = tools.readLegacyTasks(PNAME);
const secondMs = Date.now() - t2;
const stats1 = TT.taskCacheStats;
check('S1 首次扫描未命中、二次命中（misses=1 / hits=1）',
  stats1.misses === 1 && stats1.hits === 1 && rows1.length === TOTAL, { misses: stats1.misses, hits: stats1.hits, rows: rows1.length });
check('S1b 缓存结果与全量扫描逐字节一致（顺序也一致）',
  JSON.stringify(rows1) === JSON.stringify(rows2) && rows1.map((r) => r.id).join(',') === rows2.map((r) => r.id).join(','),
  { same: JSON.stringify(rows1) === JSON.stringify(rows2) });
check('S1c 命中耗时显著低于全量扫描（≤ 一半）', secondMs <= Math.max(2, firstMs / 2),
  { firstMs, secondMs });

// ── S2 新增任务文件 → 目录签名变化 → 自动失效并看到新任务
fs.writeFileSync(path.join(TASKS, 'T-cache-new.json'), JSON.stringify({ id: 'T-cache-new', title: '新增', status: 'open', createdAt: '2026-01-02T00:00:00.000Z' }) + '\n', 'utf8');
const rows3 = tools.readLegacyTasks(PNAME);
check('S2 新增任务文件后自动失效（misses=2）并看到新任务',
  TT.taskCacheStats.misses === 2 && rows3.length === TOTAL + 1 && rows3.some((r) => r.id === 'T-cache-new'),
  { misses: TT.taskCacheStats.misses, rows: rows3.length });

// ── S3 显式失效
tools.readLegacyTasks(PNAME); // 先命中一次
tools.invalidateTaskCache(PNAME);
tools.readLegacyTasks(PNAME);
check('S3 invalidateTaskCache 后必失效（invalidations≥1 且随后 misses 增长）',
  TT.taskCacheStats.invalidations >= 1 && TT.taskCacheStats.misses === 3,
  { invalidations: TT.taskCacheStats.invalidations, misses: TT.taskCacheStats.misses });

// ── S4 TTL 兜底：环境变量置 0 → 永不命中
const child = spawnSync(process.execPath, ['-e', `
const path=require('node:path');
const fs=require('node:fs');
const TT=require(${JSON.stringify(path.join(ROOT, 'src', 'team-tools.js'))});
const tools=TT.create({teamRoot:${JSON.stringify(path.join(SB, '团队'))}});
tools.readLegacyTasks(${JSON.stringify(PNAME)});
tools.readLegacyTasks(${JSON.stringify(PNAME)});
console.log(JSON.stringify({hits:TT.taskCacheStats.hits,misses:TT.taskCacheStats.misses,ttl:TT.TASK_CACHE_TTL_MS}));
`], { encoding: 'utf8', env: { ...process.env, AWB_TASK_CACHE_TTL_MS: '0' } });
let childOut = null;
try { childOut = JSON.parse(String(child.stdout || '').trim().split(/\r?\n/).pop()); } catch { childOut = null; }
check('S4 AWB_TASK_CACHE_TTL_MS=0 → 永不命中（hits=0/misses=2/ttl=0）',
  Boolean(childOut) && childOut.hits === 0 && childOut.misses === 2 && childOut.ttl === 0, childOut);

// ── S5 原地改写（同大小、目录 mtime 不变）在 TTL 内按缓存处理：这是刻意的 2s 上限
const target = path.join(TASKS, 'T-cache-0001.json');
const before = fs.readFileSync(target, 'utf8');
const sameSize = before.replace(/"title":"[^"]*"/, '"title":"原地改写"');
fs.writeFileSync(target, sameSize.length === before.length ? sameSize : before, 'utf8');
const rows5 = tools.readLegacyTasks(PNAME);
check('S5 TTL 内原地改写按缓存返回（验证上限=TTL，不是永久陈旧）',
  TT.TASK_CACHE_TTL_MS === 2000 && rows5.length === TOTAL + 1, { ttl: TT.TASK_CACHE_TTL_MS, rows: rows5.length });

// ── S6 调用方拿到的是数组副本（push 不会污染缓存）
const rows6 = tools.readLegacyTasks(PNAME);
rows6.push({ id: 'MUTATED' });
const rows7 = tools.readLegacyTasks(PNAME);
check('S6 命中返回数组副本（调用方 push 不影响后续读）',
  !rows7.some((r) => r.id === 'MUTATED'), { rows: rows7.length });

// ── S7 需求正文缓存：命中后写一份正文（tmp+rename 会改目录 mtime）→ 重新读到新内容
const PROJ = path.join(SB, '项目', PNAME);
const DOC_DIR = path.join(PROJ, '需求');
fs.mkdirSync(DOC_DIR, { recursive: true });
const docFile = path.join(DOC_DIR, 'R-20260101-000001-abcd-缓存验证.md');
const writeDoc = (body) => {
  const tmp = docFile + '.tmp-' + process.pid;
  fs.writeFileSync(tmp, `# 缓存验证\n\n## 验收标准\n\n${body}\n`, 'utf8');
  fs.renameSync(tmp, docFile);
};
writeDoc('第一版正文');
const docs1 = tools.readRequirementDocs(PROJ);
const docs2 = tools.readRequirementDocs(PROJ);
writeDoc('第二版正文：内容改过');
const docs3 = tools.readRequirementDocs(PROJ);
const hashOf = (docs) => (docs.list.find((row) => row.id === 'R-20260101-000001-abcd') || {}).contentHash || '';
check('S7 需求正文：首次+缓存命中一致，改了正文后 hash 变（目录 mtime 失效生效）',
  docs1.list.length === docs2.list.length && hashOf(docs1) === hashOf(docs2) && Boolean(hashOf(docs3)) && hashOf(docs3) !== hashOf(docs1),
  { first: hashOf(docs1).slice(0, 12), cached: hashOf(docs2).slice(0, 12), after: hashOf(docs3).slice(0, 12) });

fs.rmSync(SB, { recursive: true, force: true });
console.log(`\n任务扫描缓存自检：${passed}/${passed + failures.length} PASS`);
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exit(1); }
process.exit(0);
