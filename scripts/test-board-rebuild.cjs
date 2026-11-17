#!/usr/bin/env node
'use strict';
/**
 * test-board-rebuild.cjs —— 缺陷 B-20261117-133419-6543 自检（验收后看板后台重建）
 *
 * 口径：
 *   ① schedule() 立即返回（不 await generateBoard）——这是把 939ms~3.4s 挪出主链路的关键；
 *   ② 同一项目在去抖窗口内连点 N 次 → 只重建 1 次（coalesced 计数留痕，不丢信息）；
 *   ③ 重建成功/失败都回调 onDone（失败不静默，主进程据此写审计 + 广播）；
 *   ④ 没有项目名 / 没有 generateBoard 实现 → 明确不排队（不假装成功）；
 *   ⑤ 不同项目各自排队、互不合并。
 *
 * 纯逻辑（注入 generateBoard / 定时器 / 时钟），只读；运行：node scripts/test-board-rebuild.cjs
 */
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const { createBoardRebuild, projectNameOf } = require(path.join(ROOT, 'src', 'board-rebuild.js'));

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 320)}`);
}
const tick = (ms = 0) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // ── S1 schedule 立即返回（同步、不等 generateBoard）
  let calls = 0;
  let release = null;
  const slow = createBoardRebuild({
    debounceMs: 5,
    generateBoard: async () => { calls += 1; await new Promise((r) => { release = r; }); return { ok: true, boardPath: 'x.html' }; },
    onDone: () => {},
  });
  const t0 = Date.now();
  const sched = slow.schedule({ teamName: '慢项目' }, 'owner-accept');
  const syncMs = Date.now() - t0;
  check('S1 schedule() 立即返回（同步耗时 < 20ms，不等 generateBoard）',
    sched.queued === true && syncMs < 20 && calls === 0, { syncMs, calls, sched });
  await tick(30);
  check('S1b 去抖窗口后确实开始重建（generateBoard 被调用 1 次）', calls === 1, { calls });
  if (release) release();
  await tick(20);

  // ── S2 同项目连点合并
  let mergeCalls = 0;
  const done = [];
  const merged = createBoardRebuild({
    debounceMs: 40,
    generateBoard: async () => { mergeCalls += 1; return { ok: true }; },
    onDone: (p) => done.push(p),
  });
  merged.schedule({ teamName: 'A' }, 'owner-accept');
  merged.schedule({ teamName: 'A' }, 'owner-accept');
  merged.schedule({ teamName: 'A' }, 'owner-reject');
  const pendingAfter = merged.pendingNames();
  await tick(90);
  check('S2 同项目连点 3 次 → 只重建 1 次（coalesced=2，pending 只有 1 个）',
    mergeCalls === 1 && done.length === 1 && done[0].coalesced === 2 && pendingAfter.length === 1,
    { mergeCalls, done: done.map((d) => ({ ok: d.ok, coalesced: d.coalesced })), pendingAfter });

  // ── S3 失败不静默：onDone 收到 ok=false + message
  const failPayloads = [];
  const failing = createBoardRebuild({
    debounceMs: 5,
    generateBoard: async () => { throw new Error('磁盘只读'); },
    onDone: (p) => failPayloads.push(p),
  });
  failing.schedule({ teamName: 'B' }, 'owner-accept');
  await tick(40);
  check('S3 重建抛错 → onDone 收到 ok=false 且 message 有内容（不静默）',
    failPayloads.length === 1 && failPayloads[0].ok === false && /磁盘只读/.test(failPayloads[0].message),
    failPayloads);

  // ── S4 无项目名 / 无生成器 → 明确不排队
  const noProject = createBoardRebuild({ generateBoard: async () => ({ ok: true }) });
  const noGen = createBoardRebuild({});
  check('S4 没有项目名 → queued=false/NO_PROJECT；没有 generateBoard → NO_GENERATOR',
    noProject.schedule('', 'x').queued === false && noProject.schedule('', 'x').code === 'NO_PROJECT'
    && noGen.schedule({ teamName: 'C' }, 'x').code === 'NO_GENERATOR',
    { a: noProject.schedule('', 'x'), b: noGen.schedule({ teamName: 'C' }, 'x') });
  check('S4b projectNameOf 兼容字符串对象并优先 teamName',
    projectNameOf('  X  ') === 'X' && projectNameOf({ name: 'n', teamName: 't' }) === 't' && projectNameOf(null) === '',
    { a: projectNameOf('  X  '), b: projectNameOf({ name: 'n', teamName: 't' }) });

  // ── S5 不同项目互不合并
  const perProject = [];
  const multi = createBoardRebuild({
    debounceMs: 30,
    generateBoard: async (p) => { perProject.push(projectNameOf(p)); return { ok: true }; },
    onDone: () => {},
  });
  multi.schedule({ teamName: 'P1' }, 'x');
  multi.schedule({ teamName: 'P2' }, 'x');
  await tick(80);
  check('S5 两个项目各自重建一次（不互相合并）',
    perProject.length === 2 && perProject.sort().join(',') === 'P1,P2', perProject);

  // ── S6 统计快照
  const stats = multi.stats();
  check('S6 stats 给出 scheduled/runs/ok/failed/pending/debounceMs',
    stats.scheduled === 2 && stats.runs === 2 && stats.ok === 2 && stats.failed === 0 && stats.pending === 0 && stats.debounceMs === 30,
    stats);

  console.log(`\n看板后台重建自检：${passed}/${passed + failures.length} PASS`);
  if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exit(1); }
  process.exit(0);
})();
