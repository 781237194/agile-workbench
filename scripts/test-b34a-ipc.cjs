#!/usr/bin/env node
'use strict';
/**
 * test-b34a-ipc.cjs —— R-b34a（T-20261118-172619-c495，B 负责 R3+R4）独立夹具。
 *
 * 2026-11-18 17:39 PM 裁定：B 的断言不再写进 A 的 `scripts/test-b34a-perf.cjs`（A 的 C1–C11 归 A），
 * 迁到本独立脚本；两边各自可独立跑、互不覆盖。
 *
 * 覆盖：
 *   B-R3①–④  src/ipc-coalesce.js：同通道同参数只在途合并、完成后不复用（新鲜度）、参数不同不合并、写通道不合并
 *   B-R3⑤     cacheResultMs>0 才启用「完成后窗口内复用」（显式开关）
 *   B-R3⑥     main.js 接线（ipc-coalesce + perfCache.withIpcTiming）静态
 *   B-R3⑦–⑩  src/perf-log.js（PM 裁定唯一实现）：record 阈值/recent 排序、prune 7 天、API 别名、wrapIpcHandle
 *   B-R4①–③  src/renderer/gate.js：隐藏不执行、coalesce 不缓存隐藏期结果、恢复可见立即执行
 *   B-R4④–⑥  渲染层 11 处 setInterval 盘点 + 可见性门/合并标记 + session-queue-panel 恒 2
 *   B-R4⑦    index.html 先 gate.js 后 app.js
 * 用法：node scripts/test-b34a-ipc.cjs [--out <json>]
 * 退出码：0 全过 / 1 有失败
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ROOT = path.resolve(__dirname, '..');
const OUT_ARG = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(String(process.argv[i + 1])) : ''; })();
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? null : (detail === undefined ? null : detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + JSON.stringify(detail === undefined ? null : detail).slice(0, 500)}`);
  return Boolean(ok);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

(async () => {
  /* ---------- R3：IPC 合并 ---------- */
  const coalesce = require(path.join(ROOT, 'src', 'ipc-coalesce.js'));
  const registered = new Map();
  const fakeHandle = (channel, handler) => { registered.set(channel, handler); };
  const wrapped = coalesce.wrapHandle(fakeHandle, { windowMs: 300 });
  let calls = 0;
  wrapped('team:session-queue', async (payload) => { calls += 1; await sleep(20); return { ok: true, n: calls, arg: payload && payload.p }; });
  const h = registered.get('team:session-queue');
  const r1 = await Promise.all([h({ p: 1 }), h({ p: 1 }), h({ p: 1 })]);
  check('B-R3① 同通道同参数 3 次并发 → 只执行 1 次，后到者复用同一 Promise 结果',
    calls === 1 && r1[0] === r1[1] && r1[0] === r1[2] && r1[0].n === 1, { calls });
  const r2 = await h({ p: 1 });
  check('B-R3② 完成后立即同参再触发 → 重新执行（显式刷新拿新值，默认不复用旧结果）', calls === 2 && r2.n === 2, { calls });
  const r3 = await h({ p: 2 });
  check('B-R3③ 参数不同 → 各执行', calls === 3 && r3.n === 3, { calls });
  let sendCalls = 0;
  wrapped('team:send', async () => { sendCalls += 1; return { ok: true }; });
  const hs = registered.get('team:send');
  await Promise.all([hs({ x: 1 }), hs({ x: 1 })]);
  check('B-R3④ 写通道（team:send）不合并：两次都执行', sendCalls === 2, { sendCalls });
  const cacheReg = new Map();
  let cc = 0;
  coalesce.wrapHandle((c, f) => cacheReg.set(c, f), { windowMs: 300, cacheResultMs: 300 })('team:session-queue', async () => { cc += 1; return cc; });
  const hc = cacheReg.get('team:session-queue');
  await hc({ q: 1 });
  const cached = await hc({ q: 1 });
  check('B-R3⑤ cacheResultMs>0（显式开启）→ 完成后窗口内复用结果', cc === 1 && cached === 1, { cc });
  const mainSrc = read(path.join('src', 'main.js'));
  check('B-R3⑥ main.js 接线：ipc-coalesce 合并包装 + 慢日志计时（perfCache.withIpcTiming）',
    /ipc-coalesce\.js/.test(mainSrc) && /ipcCoalesce\.wrapHandle\(ipcMain\.handle/.test(mainSrc) && /withIpcTiming\(/.test(mainSrc), {});

  /* ---------- R3：perf-log.js（PM 2026-11-18 17:34 裁定唯一实现） ---------- */
  const perfLog = require(path.join(ROOT, 'src', 'perf-log.js'));
  const savedRoot = process.env.TEAM_ROOT;
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'b34a-ipc-'));
  process.env.TEAM_ROOT = path.join(sandbox, '团队');
  try {
    const proj2 = 'perf-log-夹具';
    perfLog.record(proj2, { kind: 'ipc', name: 'slow-x', ms: 120 });
    perfLog.record(proj2, { kind: 'ipc', name: 'fast-x', ms: 5 });
    const rows2 = perfLog.recent(proj2, 10);
    check('B-R3⑦ perf-log.record：≥100ms 落盘、<100ms 丢弃；recent 新的在前',
      rows2.length === 1 && rows2[0].name === 'slow-x' && rows2[0].slow === true && rows2[0].kind === 'ipc', { rows: rows2 });
    const proj3 = 'perf-log-prune';
    const dir3 = perfLog.shardDir(proj3);
    fs.mkdirSync(dir3, { recursive: true });
    const oldDay = new Date(Date.now() - 8 * 24 * 3600 * 1000 + 8 * 3600 * 1000).toISOString().slice(0, 10).replace(/-/g, '');
    const stale = path.join(dir3, '性能-' + oldDay + '.jsonl');
    fs.writeFileSync(stale, '{}\n');
    const removed = perfLog.pruneShards(proj3, Date.now());
    check('B-R3⑧ perf-log.pruneShards：超过 7 天的分片被清理', removed >= 1 && !fs.existsSync(stale), { removed });
    check('B-R3⑨ API 别名与文件头契约一致（logSlow/readPerfRecent/prunePerfShards）',
      typeof perfLog.logSlow === 'function' && typeof perfLog.readPerfRecent === 'function' && typeof perfLog.prunePerfShards === 'function', {});
    const fake = new Map();
    const fakeIpc = { handle: (c, f) => fake.set(c, f) };
    const wrappedOne = perfLog.wrapIpcHandle(fakeIpc, () => proj2);
    fakeIpc.handle('team:fixture-slow', async () => 'ok');
    check('B-R3⑩ perf-log.wrapIpcHandle 替换 handle：后续注册的通道被计时包装',
      wrappedOne === true && fake.has('team:fixture-slow') && typeof fake.get('team:fixture-slow') === 'function',
      { wrappedOne, registered: [...fake.keys()] });
  } finally {
    if (savedRoot === undefined) delete process.env.TEAM_ROOT; else process.env.TEAM_ROOT = savedRoot;
  }

  /* ---------- R4：可见性门 ---------- */
  const gate = require(path.join(ROOT, 'src', 'renderer', 'gate.js'));
  let hidden = true;
  let ran = 0;
  const g = gate.createGate({ hidden: () => hidden });
  g.gate(() => { ran += 1; })();
  const hiddenRan = ran;
  hidden = false;
  g.gate(() => { ran += 1; })();
  check('B-R4① 隐藏时 gate 不执行、可见时执行', hiddenRan === 0 && ran === 1, { hiddenRan, ran });
  hidden = true;
  let coRan = 0;
  const co = g.coalesce(() => { coRan += 1; return coRan; }, 300, 'k');
  await Promise.all([co(), co()]);
  check('B-R4② coalesce 在隐藏时不执行（不缓存隐藏期结果）', coRan === 0, { coRan });
  hidden = false;
  await co();
  check('B-R4③ 恢复可见后立即执行（隐藏期结果未被复用）', coRan === 1, { coRan });

  /* ---------- R4：静态盘点 ---------- */
  const rendererDir = path.join(ROOT, 'src', 'renderer');
  const intervalSites = [];
  for (const f of fs.readdirSync(rendererDir).filter((n) => n.endsWith('.js') && n !== 'gate.js')) {
    read(path.join('src', 'renderer', f)).split(/\r?\n/).forEach((line, idx) => {
      if (/setInterval\(/.test(line) && !/^\s*\/\//.test(line)) intervalSites.push({ file: f, line: idx + 1, text: line.trim() });
    });
  }
  const sqSites = intervalSites.filter((s) => s.file === 'session-queue-panel.js');
  const dispatchTicker = intervalSites.find((s) => s.file === 'app.js' && /dispatchTicker = setInterval/.test(s.text));
  const busyTimer = intervalSites.find((s) => s.file === 'owner-review.js' && /busyTimer = setInterval/.test(s.text));
  const gated = intervalSites.filter((s) => /r4Gate|r4Coalesce|AWBGate|gate\(/.test(s.text));
  check('B-R4④ setInterval 盘点：渲染层业务代码共 11 处（app.js 6 / owner-review 2 / session-queue-panel 2 / workspace-clean 1）',
    intervalSites.length === 11, intervalSites.map((s) => `${s.file}:${s.line}`));
  check('B-R4⑤ session-queue-panel.js setInterval 恒 = 2（c9ac 契约，不得删）', sqSites.length === 2, sqSites);
  check('B-R4⑥ 除 4 处「保留」（dispatchTicker/busyTimer/秒表/降级自检）外全部带可见性门或合并包装',
    gated.length === intervalSites.length - 4 && Boolean(dispatchTicker) && Boolean(busyTimer)
    && !gated.includes(dispatchTicker) && !gated.includes(busyTimer) && sqSites.length === 2,
    { total: intervalSites.length, gated: gated.length });
  const html = read(path.join('src', 'renderer', 'index.html'));
  check('B-R4⑦ index.html 先加载 gate.js 再 app.js',
    html.indexOf('<script src="gate.js"></script>') > 0
    && html.indexOf('<script src="gate.js"></script>') < html.indexOf('<script src="app.js"></script>'), {});

  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = results.filter((r) => !r.ok);
  const payload = {
    task: 'T-20261118-172619-c495', requirement: 'R-20261118-170937-b34a',
    total: results.length, pass: results.length - failed.length, red: failed.length,
    ok: failed.length === 0, at: new Date().toISOString(), checks: results,
  };
  if (OUT_ARG) { try { fs.mkdirSync(path.dirname(OUT_ARG), { recursive: true }); fs.writeFileSync(OUT_ARG, JSON.stringify(payload, null, 2) + '\n', 'utf8'); } catch { /* ignore */ } }
  console.log('');
  for (const f of failed) console.log(`FAILED  ${f.name} :: ${String(JSON.stringify(f.detail)).slice(0, 500)}`);
  console.log(`B34A_IPC ${failed.length ? 'FAIL' : 'OK'} ${JSON.stringify({ total: payload.total, pass: payload.pass, red: payload.red })}`);
  if (OUT_ARG) console.log('证据：' + OUT_ARG);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('B34A_IPC ERROR ' + String((e && e.stack) || e)); process.exit(1); });
