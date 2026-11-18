#!/usr/bin/env node
'use strict';
/**
 * R-20261118-170937-b34a · T-20261118-172604-e2d8（R1+R2）性能夹具（剧本骨架，随实现分批判长）。
 *
 * 覆盖（对应需求 §七 AC1 / AC8 + §6.2 / §6.4）：
 *   C1 AC1①：同一文件连取 10 次 → 只有 1 次真读盘（其余 source='cache'）
 *   C2 AC1②：改内容后再取 → 重读 1 次且值更新
 *   C3 AC1③：只改 mtime 不改 size → 也重读（mtime/size 双保险）
 *   C4 截断（size 变小）→ rebuilt=1 并重建缓存
 *   C5 写后失效：invalidate() → 下一次必重读（防「界面不更新」）
 *   C6 超上限不缓存：maxBytes 很小时 cached=false（该 key 不缓存）
 *   C7 解析失败：保留上一份缓存 + parseError（不清空、不抛）
 *   C8 慢操作日志：recordPerf 落 `性能-YYYYMMDD.jsonl`（沙盘 TEAM_ROOT 内），readPerfRecent 倒序可查
 *   C9 IPC 计时包装：慢 handler（>阈值）产生 kind='ipc' 日志，快 handler 不产生；模板原样返回
 *   C10 静态接线：main.js 全部 ipcMain.handle 经 withIpcTiming 包装；writeStore 写前调 perfCache.invalidate
 *   C11 隔离：真实 团队/状态/团队.json 与 data/userdata/workbench.json 前后 sha256 不变
 *
 * 跑法：node scripts/test-b34a-perf.cjs
 * 产出：AWB_B34A_OUT（默认 程序员A/产出/证据-b34a/run-b34a.json）
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const EVID = process.env.AWB_B34A_OUT ? path.resolve(process.env.AWB_B34A_OUT) : path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-b34a');
const pc = require(path.join(ROOT, 'src', 'perf-cache.js'));
const MAIN = path.join(ROOT, 'src', 'main.js');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 400)}`);
}
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return ''; } };
const since = (ms) => new Promise((r) => setTimeout(r, ms));

const realTeamFile = path.join(ROOT, '团队', '状态', '团队.json');
const realStoreFile = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const beforeReal = { team: sha(realTeamFile), store: sha(realStoreFile) };

const SB = path.join(ROOT, '_tmp', `b34a-${process.pid}-${Date.now().toString(36)}`);
const teamRoot = path.join(SB, '团队');
const projDir = path.join(teamRoot, '状态', '项目', '沙盘项目');
const dataDir = path.join(SB, 'data');
fs.mkdirSync(projDir, { recursive: true });
fs.mkdirSync(dataDir, { recursive: true });
const PROJECT = '沙盘项目';

(async () => {
  /* C1–C3 缓存命中/失效（真文件、真 mtime） */
  {
    const file = path.join(dataDir, 'workbench.json');
    fs.writeFileSync(file, JSON.stringify({ projects: [{ id: 'p1', name: 'A' }], activeProjectId: 'p1' }), 'utf8');
    const sources = [];
    for (let i = 0; i < 10; i += 1) sources.push(pc.getJsonFile(file).source);
    check('C1 AC1①：连取 10 次只有 1 次真读盘（其余 source=cache）',
      sources.filter((s) => s === 'read').length === 1 && sources.filter((s) => s === 'cache').length === 9,
      { sources });

    fs.writeFileSync(file, JSON.stringify({ projects: [{ id: 'p1', name: 'B' }], activeProjectId: 'p1' }), 'utf8');
    const r2 = pc.getJsonFile(file);
    check('C2 AC1②：改内容后再取 → 重读 1 次且值更新',
      r2.source === 'read' && r2.value.projects[0].name === 'B', { source: r2.source, name: r2.value && r2.value.projects[0].name });

    // 只改 mtime 不改 size：内容等长替换（A→C 同长度），mtime 显式前移
    const same = JSON.stringify({ projects: [{ id: 'p1', name: 'C' }], activeProjectId: 'p1' });
    fs.writeFileSync(file, same, 'utf8');
    const st = fs.statSync(file);
    const future = new Date(st.mtimeMs + 5000);
    fs.utimesSync(file, future, future);
    const r3 = pc.getJsonFile(file);
    check('C3 AC1③：只改 mtime 不改 size → 也重读（双保险）',
      r3.source === 'read' && r3.value.projects[0].name === 'C', { source: r3.source, size: r3.size });
  }

  /* C4 截断重建 */
  {
    const file = path.join(dataDir, 'trunc.json');
    fs.writeFileSync(file, JSON.stringify({ items: Array.from({ length: 50 }, (_, i) => i) }), 'utf8');
    pc.getJsonFile(file);
    fs.writeFileSync(file, JSON.stringify({ items: [1] }), 'utf8');
    const r = pc.getJsonFile(file);
    check('C4 文件被截断（size 变小）→ source=rebuilt 且 rebuilt=1',
      r.rebuilt === 1 && r.source === 'rebuilt' && r.value.items.length === 1, { source: r.source, rebuilt: r.rebuilt });
  }

  /* C5 写后失效 */
  {
    const file = path.join(dataDir, 'invalidate.json');
    fs.writeFileSync(file, JSON.stringify({ v: 1 }), 'utf8');
    pc.getJsonFile(file);
    const hit = pc.getJsonFile(file);
    pc.invalidate(file);
    const after = pc.getJsonFile(file);
    check('C5 写后失效：invalidate() → 下一次必重读（防界面停在旧值）',
      hit.source === 'cache' && after.source === 'read', { hit: hit.source, after: after.source });
  }

  /* C6 超上限不缓存 */
  {
    const file = path.join(dataDir, 'big.txt');
    fs.writeFileSync(file, 'x'.repeat(4096), 'utf8');
    const r1 = pc.getTextFile(file, { maxBytes: 1024 });
    const r2 = pc.getTextFile(file, { maxBytes: 1024 });
    check('C6 单值超上限（>maxBytes）不缓存：两次都 source=read 且 cached=false',
      r1.source === 'read' && r1.cached === false && r2.source === 'read' && r2.cached === false,
      { r1: r1.source, r2: r2.source });
  }

  /* C7 解析失败保留上份缓存 */
  {
    const file = path.join(dataDir, 'broken.json');
    fs.writeFileSync(file, JSON.stringify({ ok: 1 }), 'utf8');
    pc.getJsonFile(file);
    fs.writeFileSync(file, '{ not json', 'utf8');
    const r = pc.getJsonFile(file);
    check('C7 解析失败 → 保留上一份缓存 + parseError=true（不清空、不抛）',
      r.parseError === true && r.source === 'cache' && r.value && r.value.ok === 1, { source: r.source, value: r.value });
  }

  /* C8 慢日志 */
  {
    const r = pc.recordPerf({ teamRoot, projectName: PROJECT, kind: 'read', name: 'workflow.json', ms: 137, bytes: 1518400 });
    await since(5);
    const r2 = pc.recordPerf({ teamRoot, projectName: PROJECT, kind: 'ipc', name: 'flow:get', ms: 210 });
    const recent = pc.readPerfRecent(teamRoot, PROJECT, 20);
    const names = recent.rows.map((x) => `${x.kind}:${x.name}`);
    check('C8 慢日志：落 性能-YYYYMMDD.jsonl（沙盘内）且 readPerfRecent 倒序可查',
      r.ok && r2.ok && fs.existsSync(r.file) && /性能-\d{8}\.jsonl$/.test(r.file)
      && recent.rows.length >= 2 && names[0] === 'ipc:flow:get',
      { file: r.file, names });
  }

  /* C9 IPC 计时包装 */
  {
    const slow = pc.withIpcTiming('demo:slow', async () => { const t = Date.now(); while (Date.now() - t < 120) { /* busy */ } return 42; },
      { projectNameOf: () => PROJECT, teamRootOf: () => teamRoot });
    const fast = pc.withIpcTiming('demo:fast', async () => 7, { projectNameOf: () => PROJECT, teamRootOf: () => teamRoot });
    const before = pc.readPerfRecent(teamRoot, PROJECT, 200).rows.length;
    const v1 = await slow({});
    const v2 = await fast({});
    await since(10);
    const after = pc.readPerfRecent(teamRoot, PROJECT, 200).rows;
    const slowRows = after.filter((x) => x.name === 'demo:slow');
    const fastRows = after.filter((x) => x.name === 'demo:fast');
    check('C9 IPC 计时：慢 handler 产生 kind=ipc 日志、快 handler 不产生，返回值原样',
      v1 === 42 && v2 === 7 && after.length > before && slowRows.length === 1 && fastRows.length === 0,
      { after: after.length, before, slowRows: slowRows.length, fastRows: fastRows.length });
  }

  /* C10 静态接线 */
  {
    const text = fs.readFileSync(MAIN, 'utf8');
    const wrapped = /ipcMain\.handle\s*=\s*\(channel, handler\)\s*=>\s*rawIpcHandle\(channel, \(typeof handler === 'function'\s*\n?\s*\? perfCache\.withIpcTiming\(/.test(text)
      || (/rawIpcHandle/.test(text) && /perfCache\.withIpcTiming\(channel/.test(text));
    const invalidated = /perfCache\.invalidate\(storeFile\(\)\)/.test(text);
    check('C10 静态接线：所有 ipcMain.handle 经 withIpcTiming 包装；writeStore 写前 invalidate 缓存',
      wrapped && invalidated, { wrapped, invalidated });
  }

  /* C11 隔离 */
  check('C11 隔离：真实 团队/状态/团队.json 与 data/userdata/workbench.json 前后 sha256 不变',
    sha(realTeamFile) === beforeReal.team && sha(realStoreFile) === beforeReal.store && Boolean(beforeReal.team),
    { before: beforeReal, after: { team: sha(realTeamFile), store: sha(realStoreFile) } });

  try { fs.rmSync(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
  fs.mkdirSync(EVID, { recursive: true });
  const report = {
    task: 'T-20261118-172604-e2d8', requirement: 'R-20261118-170937-b34a', at: new Date().toISOString(),
    total: passed + failures.length, pass: passed, red: failures.length, failures,
    cacheStats: pc.cacheStats(),
  };
  const outFile = path.join(EVID, 'run-b34a.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`\nB34A_PERF ${failures.length === 0 ? 'OK' : 'FAIL'} ${JSON.stringify({ total: report.total, pass: report.pass, red: report.red })}`);
  console.log('证据：' + outFile);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error('CRASH', (e && e.stack) || e); process.exit(1); });
