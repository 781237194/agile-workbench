#!/usr/bin/env node
'use strict';
/**
 * R-20261118-170937-b34a（T-e2d8 R2）· 热点缓存读取夹具（独立文件，不依赖 B 的 R3/perf-log）。
 *
 * 覆盖：H1 工作流 10 次取 → 1 次读盘；H2 改内容 → 重读且值更新；H3 写后 invalidate → 立即重读；
 *       H4 唤醒.jsonl 只缓存原文、取最后 N 行（追加后重读且 total 增长）；H5 项目索引缓存；
 *       H6 任务目录索引按目录 mtime 短路（新增文件 → 重扫、count 增长）；H7 隔离（真实状态 sha 不变）。
 *
 * 跑法：node scripts/test-b34a-hot-reads.cjs
 * 产出：AWB_B34A_HOT_OUT（默认 程序员A/产出/证据-b34a/run-b34a-hot.json）
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const EVID = process.env.AWB_B34A_HOT_OUT ? path.resolve(process.env.AWB_B34A_HOT_OUT) : path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-b34a');
const perfCache = require(path.join(ROOT, 'src', 'perf-cache.js'));
const { createHotReads } = require(path.join(ROOT, 'src', 'hot-reads.js'));

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 400)}`);
}
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return ''; } };

const realTeamFile = path.join(ROOT, '团队', '状态', '团队.json');
const realStoreFile = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const beforeReal = { team: sha(realTeamFile), store: sha(realStoreFile) };

const SB = path.join(ROOT, '_tmp', `b34a-hot-${process.pid}-${Date.now().toString(36)}`);
const teamRoot = path.join(SB, '团队');
const stateDir = path.join(teamRoot, '状态', '项目', '沙盘项目');
fs.mkdirSync(path.join(stateDir, '任务'), { recursive: true });
fs.mkdirSync(path.join(teamRoot, '状态'), { recursive: true });

const hot = createHotReads({ perfCache, teamRoot, projectStateDir: stateDir });

/* H1/H2/H3 工作流 */
{
  const wf = { schema: 2, requirements: { 'R-1': { status: 'ready' } }, round: 1 };
  fs.writeFileSync(hot.files.workflowFile, JSON.stringify(wf), 'utf8');
  const sources = [];
  for (let i = 0; i < 10; i += 1) sources.push(hot.readWorkflow().source);
  check('H1 工作流 10 次取 → 只有 1 次读盘（其余 cache）',
    sources.filter((s) => s === 'read').length === 1 && sources.filter((s) => s === 'cache').length === 9, { sources });

  wf.requirements['R-1'].status = 'dev_done';
  fs.writeFileSync(hot.files.workflowFile, JSON.stringify(wf), 'utf8');
  const r2 = hot.readWorkflow();
  check('H2 改内容 → 重读且值更新', r2.source === 'read' && r2.value.requirements['R-1'].status === 'dev_done', { source: r2.source });

  hot.invalidateAll();
  check('H3 写后 invalidateAll() → 下一次必重读（防界面停在旧值）', hot.readWorkflow().source === 'read', { source: hot.readWorkflow().source });
}

/* H4 唤醒.jsonl 尾部缓存 */
{
  const rows = Array.from({ length: 50 }, (_, i) => ({ at: `2026-11-18T00:00:${String(i).padStart(2, '0')}Z`, id: `w${i}` }));
  fs.writeFileSync(hot.files.wakeFile, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  const t1 = hot.readWakeTail({ lines: 5 });
  const t2 = hot.readWakeTail({ lines: 5 });
  fs.appendFileSync(hot.files.wakeFile, JSON.stringify({ at: '2026-11-18T00:01:00Z', id: 'w-new' }) + '\n', 'utf8');
  const t3 = hot.readWakeTail({ lines: 5 });
  check('H4 唤醒.jsonl：命中不读盘、只取最后 N 行；追加后重读且 total+1',
    t1.rows.length === 5 && t1.rows[4].id === 'w49' && t2.source === 'cache'
    && t3.source === 'read' && t3.total === 51 && t3.rows[4].id === 'w-new',
    { t1: t1.source, t2: t2.source, t3: { source: t3.source, total: t3.total, last: t3.rows[4] && t3.rows[4].id } });
}

/* H5 项目索引 */
{
  fs.writeFileSync(hot.files.projectIndexFile, JSON.stringify({ projects: [{ name: 'P1' }] }), 'utf8');
  const a = hot.readProjectIndex();
  const b = hot.readProjectIndex();
  check('H5 项目索引缓存：首次 read、再次 cache，值正确',
    a.source === 'read' && b.source === 'cache' && b.value.projects[0].name === 'P1', { a: a.source, b: b.source });
}

/* H6 任务目录索引 */
{
  const dir = hot.files.tasksDir;
  fs.writeFileSync(path.join(dir, 'T-1.json'), '{}', 'utf8');
  fs.writeFileSync(path.join(dir, 'T-2.json'), '{}', 'utf8');
  const a = hot.readTaskIndex();
  const b = hot.readTaskIndex();
  fs.writeFileSync(path.join(dir, 'T-3.json'), '{}', 'utf8');
  const st = fs.statSync(dir);
  const bumped = new Date(st.mtimeMs + 2000);
  fs.utimesSync(dir, bumped, bumped);
  const c = hot.readTaskIndex();
  check('H6 任务目录索引：按目录 mtime 短路；新增文件 → 重扫且 count 增长',
    a.count === 2 && a.source === 'read' && b.source === 'cache' && c.count === 3 && c.source === 'read',
    { a: { count: a.count, source: a.source }, b: b.source, c: { count: c.count, source: c.source } });
}

/* H7 隔离 */
check('H7 隔离：真实 团队/状态/团队.json 与 data/userdata/workbench.json 前后 sha256 不变',
  sha(realTeamFile) === beforeReal.team && sha(realStoreFile) === beforeReal.store && Boolean(beforeReal.team),
  { before: beforeReal, after: { team: sha(realTeamFile), store: sha(realStoreFile) } });

try { fs.rmSync(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
fs.mkdirSync(EVID, { recursive: true });
const report = {
  task: 'T-20261118-172604-e2d8', requirement: 'R-20261118-170937-b34a', batch: 'R2-hot-reads', at: new Date().toISOString(),
  total: passed + failures.length, pass: passed, red: failures.length, failures,
};
const outFile = path.join(EVID, 'run-b34a-hot.json');
fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`\nB34A_HOT_READS ${failures.length === 0 ? 'OK' : 'FAIL'} ${JSON.stringify({ total: report.total, pass: report.pass, red: report.red })}`);
console.log('证据：' + outFile);
process.exit(failures.length ? 1 : 0);
