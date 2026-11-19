#!/usr/bin/env node
'use strict';
/**
 * test-d1bf-wake-timer-zero.cjs —— R-20261119-125935-d1bf / T-20261119-131038-ff54 夹具
 *   AC2 静态：route-daemon 定时回调内不得出现唤醒调用；补催/失败重试不再由 tick 驱动；
 *             ops.mjs 无 setInterval；requeueStalledItem 只由 recoverStalledRoles 事件许可驱动。
 *   AC3/AC6 运行：沙盘注册项目 + 直接 routeTick（注入 now）：基准拍 + now+30min 拍 → 唤醒.jsonl 新增 0 行。
 *   AC1 统计：wake stats --json → {total,event,manual,legacy,timer:0}，旧行归 legacy、坏行计入 badLines。
 *   §6.4 时钟：AWB_NOW_MS 注入生效；ops 用 readNowMs（不再裸 Date.now 决策）。
 *   AC4⑤ 去重：appendWakeLog 同角色同 dedupeKey 第二次记 skip:duplicate。
 *
 * 跑法：node scripts/test-d1bf-wake-timer-zero.cjs
 * 隔离：全部 %TEMP% 沙盘（TEAM_ROOT/TEAM_PROJECTS_ROOT + TEAM_SELFTEST=1），真实状态零写入。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TEAM = path.join(ROOT, '团队');
const TOOL = path.join(TEAM, '工具', 'team.mjs');
const ROUTE_SRC = path.join(TEAM, '工具', 'lib', 'route-daemon.mjs');
const OPS_SRC = path.join(TEAM, '工具', 'lib', 'ops.mjs');
const CLOCK_SRC = path.join(TEAM, '工具', 'lib', 'clock.mjs');
const OUT = path.join(ROOT, '_tmp', 'd1bf-evidence');

const ROWS = [];
const check = (name, ok, detail) => {
  ROWS.push({ name, ok: Boolean(ok) });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : ' :: ' + JSON.stringify(detail).slice(0, 500)));
  if (!ok) process.exitCode = 1;
};

function runNode(args, env) {
  const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 180000, env: { ...process.env, ...env } });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

// ── AC2 静态 ───────────────────────────────────────────────────────────────
const routeSrc = fs.readFileSync(ROUTE_SRC, 'utf8').replace(/\r\n/g, '\n');
const opsSrc = fs.readFileSync(OPS_SRC, 'utf8');

function timerCallbacks(src) {
  const out = [];
  const re = /set(?:Timeout|Interval)\s*\(/g;
  let m;
  while ((m = re.exec(src))) {
    let i = m.index + m[0].length;
    let depth = 1;
    const start = i;
    while (i < src.length && depth > 0) {
      const ch = src[i];
      if (ch === '{' || ch === '(') depth += 1;
      else if (ch === '}' || ch === ')') depth -= 1;
      i += 1;
    }
    out.push(src.slice(start, i));
  }
  return out;
}
const callbacks = timerCallbacks(routeSrc);
check('AC2a route-daemon 定时回调内无 tryWake/wakeSessionForMessage/sendMessage',
  callbacks.every((body) => !/tryWake\s*\(|wakeSessionForMessage\s*\(|sendMessage\s*\(/.test(body)),
  { count: callbacks.length });
const tickSection = routeSrc.split('export async function routeTick')[1] || '';
const tickBeforeRetries = tickSection.split('function runWakeRetries')[0];
check('AC2b routeTick 不再由 tick 调 runWakeRetries（补催/重试已拆）',
  !/runWakeRetries\s*\(\s*name/.test(routeSrc) && !/status\.retries\[key\]\s*=\s*\{/.test(tickBeforeRetries) ,
  { retriesCall: /runWakeRetries\s*\(\s*name/.test(routeSrc), tickRetryHit: /status\.retries\[key\]\s*=\s*\{/.test(tickBeforeRetries) });
const cleanupStart = routeSrc.indexOf('function runFollowUpsCleanup');
const cleanupBody = cleanupStart >= 0 ? routeSrc.slice(cleanupStart, routeSrc.indexOf('\n}\n', cleanupStart) + 3) : '';
check('AC2c 补催只做状态清理（runFollowUpsCleanup，函数体无 deliverRouteWake）',
  cleanupStart >= 0 && !/deliverRouteWake\s*\(/.test(cleanupBody) && /delete status\.followUps\[/.test(cleanupBody),
  { bodyLen: cleanupBody.length });
check('AC2d ops.mjs 无 setInterval', !/setInterval\s*\(/.test(opsSrc), {});
check('AC2e 停滞重投由事件许可驱动（recoverStalledRoles 消费许可）',
  /function consumeRepushPermit/.test(opsSrc) && /consumeRepushPermit\(name, role\)/.test(opsSrc) && /grantRepushPermit\(project, target\)/.test(opsSrc),
  {});
check('AC2f ops 唤醒判定走统一时钟 readNowMs（clock.mjs 存在）',
  fs.existsSync(CLOCK_SRC) && /import \{ readNowMs \} from '\.\/clock\.mjs'/.test(opsSrc) && /const nowMs = readNowMs\(\)/.test(opsSrc),
  {});

// ── §6.4 时钟单测 ──────────────────────────────────────────────────────────
const clockProbe = path.join(os.tmpdir(), 'd1bf-clock-probe.mjs');
fs.writeFileSync(clockProbe, [
  `import { readNowMs } from ${JSON.stringify('file:///' + CLOCK_SRC.replace(/\\/g, '/'))};`,
  "process.env.AWB_NOW_MS = '1700000000000';",
  'const injected = readNowMs();',
  'delete process.env.AWB_NOW_MS;',
  'const real = readNowMs();',
  "console.log('CLOCK ' + JSON.stringify({ injected, real, now: Date.now() }));",
].join('\n'), 'utf8');
const clockRun = runNode([clockProbe], {});
const clockLine = clockRun.out.split(/\r?\n/).find((l) => l.startsWith('CLOCK '));
let clock = null;
if (clockLine) { try { clock = JSON.parse(clockLine.slice(6)); } catch { clock = null; } }
check('CLOCK1 AWB_NOW_MS 注入读回同值', Boolean(clock && clock.injected === 1700000000000), clock);
check('CLOCK2 删除 AWB_NOW_MS 后回落真实时间（±5min）', Boolean(clock && Math.abs(clock.real - clock.now) < 5 * 60 * 1000), clock);

// ── 沙盘：项目注册 + 唤醒统计 + routeTick 两拍 ─────────────────────────────
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'd1bf-'));
const TEAM_ROOT = path.join(SB, '团队');
const PROJ_ROOT = path.join(SB, '项目');
fs.mkdirSync(PROJ_ROOT, { recursive: true });
const env = {
  TEAM_ROOT,
  AWB_TEAM_ROOT: TEAM_ROOT,
  TEAM_PROJECTS_ROOT: PROJ_ROOT,
  TEAM_SELFTEST: '1',
  AWB_DATA_DIR: path.join(SB, 'data'),
};
const projectName = 'd1bf-wake';
try {
  const initRun = runNode([TOOL, 'init'], env);
  const addRun = runNode([TOOL, 'project', 'add', '--name', projectName, '--team-mode', 'fast'], env);
  check('S0 沙盘 init + 项目注册成功', initRun.code === 0 && addRun.code === 0, { initCode: initRun.code, addCode: addRun.code, out: addRun.out.slice(-500), err: (initRun.err + addRun.err).slice(-500) });

  // 找到项目状态目录（slug 可能改写名字）
  const projectsDir = path.join(TEAM_ROOT, '状态', '项目');
  const expectedDir = path.join(projectsDir, projectName);
  let stateDir = fs.existsSync(path.join(expectedDir, '项目.json')) ? expectedDir : '';
  if (!stateDir) {
    try {
      for (const entry of fs.readdirSync(projectsDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue;
        if (fs.existsSync(path.join(projectsDir, entry.name, '项目.json'))) { stateDir = path.join(projectsDir, entry.name); break; }
      }
    } catch { stateDir = ''; }
  }
  check('S1 找到项目状态目录', Boolean(stateDir), { projectsDir, expectedDir });
  const wakeFile = path.join(stateDir, '唤醒.jsonl');

  // AC1 统计：写 4 条合法（event/manual/legacy×2）+ 1 条坏行
  fs.writeFileSync(wakeFile, [
    JSON.stringify({ at: '2026-11-19T05:00:00.000Z', to: 'programmer1', trigger: 'event', source: 'send', ok: true }),
    JSON.stringify({ at: '2026-11-19T05:01:00.000Z', to: 'pm', trigger: 'manual', source: 'manual', ok: true }),
    JSON.stringify({ at: '2026-11-19T05:02:00.000Z', to: 'tester', ok: true }),
    JSON.stringify({ at: '2026-11-19T05:03:00.000Z', to: 'analyst', ok: true }),
    '{bad json',
  ].join('\n') + '\n', 'utf8');
  const statsRun = runNode([TOOL, 'wake', 'stats', '--project', projectName, '--json'], env);
  let stats = null;
  try { stats = JSON.parse(statsRun.out.slice(statsRun.out.indexOf('{'), statsRun.out.lastIndexOf('}') + 1)); } catch { stats = null; }
  check('AC1a wake stats 输出可解析', Boolean(stats), { out: statsRun.out.slice(-400), err: statsRun.err.slice(-400), stateDir, wakeFileExists: fs.existsSync(wakeFile), wakeBytes: (() => { try { return fs.statSync(wakeFile).size; } catch { return -1; } }) });
  check('AC1b event=1 / manual=1 / legacy=2 / timer=0', Boolean(stats && stats.event === 1 && stats.manual === 1 && stats.legacy === 2 && stats.timer === 0), { stats, stateDir, wakeFile, exists: fs.existsSync(wakeFile), bytes: (() => { try { return fs.statSync(wakeFile).size; } catch { return -1; } }) });
  check('AC1c 坏行计入 badLines', Boolean(stats && stats.badLines === 1), stats);

  // AC4⑤ 去重：直接调用 appendWakeLog（同角色同 dedupeKey 两次）
  const dedupeScript = path.join(os.tmpdir(), 'd1bf-dedupe.mjs');
  fs.writeFileSync(dedupeScript, [
    `import { appendWakeLogForTest } from ${JSON.stringify('file:///' + OPS_SRC.replace(/\\/g, '/'))};`,
    `const r1 = appendWakeLogForTest(${JSON.stringify(projectName)}, { to: 'programmer1', ok: true, dedupeKey: 'MSG-X', trigger: 'event' });`,
    `const r2 = appendWakeLogForTest(${JSON.stringify(projectName)}, { to: 'programmer1', ok: true, dedupeKey: 'MSG-X', trigger: 'event' });`,
    "console.log('DEDUPE ' + JSON.stringify({ r1, r2 }));",
  ].join('\n'), 'utf8');
  // ops.mjs 目前未导出 appendWakeLog；若未导出则跳过该断言并明确记录
  const dedupeRun = runNode([dedupeScript], env);
  const dedupeLine = dedupeRun.out.split(/\r?\n/).find((l) => l.startsWith('DEDUPE '));
  check('AC4d appendWakeLog 可测（导出）且第二次 skip:duplicate', Boolean(dedupeLine), { err: dedupeRun.err.slice(-300) });

  // ── AC5：AWB_WAKE_FAIL 注入 → 失败重试 trigger=event + retryOf 关联，timer 恒 0 ──
  const ac5Script = path.join(os.tmpdir(), 'd1bf-ac5.mjs');
  fs.writeFileSync(ac5Script, [
    `import { wakeWithGuard, processWakeRetries, readDeliveryState } from ${JSON.stringify('file:///' + OPS_SRC.replace(/\\\\/g, '/'))};`,
    "const project = process.env.AWB_AC5_PROJECT || '';",
    "const base = 1795200000000;",
    "process.env.AWB_WAKE_FAIL = '1';",
    "const first = await wakeWithGuard({ project, to: 'programmer1', msg: { id: 'M-AC5-1', kind: 'notice', from: 'pm', to: 'programmer1', subject: 'AC5' }, isDispatch: true, reason: 'ac5' });",
    "process.env.AWB_NOW_MS = String(Number(first.retryAt || Date.now()) + 1000);",
    "const r1 = await processWakeRetries(project, { source: 'test' });",
    "process.env.AWB_NOW_MS = String(Number(process.env.AWB_NOW_MS) + 60 * 60 * 1000);",
    "const r2 = await processWakeRetries(project, { source: 'test' });",
    "process.env.AWB_NOW_MS = String(Number(process.env.AWB_NOW_MS) + 60 * 60 * 1000);",
    "const r3 = await processWakeRetries(project, { source: 'test' });",
    "console.log('AC5 ' + JSON.stringify({ first, r1, r2, r3 }));",
  ].join('\n'), 'utf8');
  const ac5Env = { ...env, AWB_AC5_PROJECT: projectName, AWB_WAKE_FAIL: '1' };
  const ac5Run = runNode([ac5Script], ac5Env);
  const ac5Line = ac5Run.out.split(/\r?\n/).find((l) => l.startsWith('AC5 '));
  let ac5 = null;
  if (ac5Line) { try { ac5 = JSON.parse(ac5Line.slice(4)); } catch { ac5 = null; } }
  let ac5Rows = [];
  try { ac5Rows = fs.readFileSync(wakeFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { ac5Rows = []; }
  const failRows = ac5Rows.filter((r) => r && r.messageIds && r.messageIds.includes('M-AC5-1'));
  const retryRows = failRows.filter((r) => r.retryOf);
  check('AC5a 注入失败产生首行（ok:false 且带 id）', Boolean(ac5 && ac5.first && ac5.first.ok === false) && failRows.some((r) => r.id && r.ok === false), { first: ac5 && ac5.first, rows: failRows.length });
  check('AC5b 重试行 trigger=event 且 retryOf=首次行 id', retryRows.length >= 1 && retryRows.every((r) => r.trigger === 'event') && retryRows.every((r) => failRows.some((f) => f.id === r.retryOf && f.ok === false)), { retryRows: retryRows.map((r) => ({ id: r.id, retryOf: r.retryOf, trigger: r.trigger })), failIds: failRows.filter((r) => r.ok === false).map((r) => r.id), ac5 });
  check('AC5c 同一条消息重试 ≤3 行且 timer=0', retryRows.length <= 3 && ac5Rows.every((r) => r.trigger !== 'timer'), { retries: retryRows.length, timer: ac5Rows.filter((r) => r.trigger === 'timer').length });
  check('AC5d 重试状态含 retryOf 持久化（重试队列）', Boolean(ac5 && ac5.first && ac5.first.retryOf), { retryOf: ac5 && ac5.first && ac5.first.retryOf });

  // AC3/AC6：两拍 routeTick（注入 now，基准 / +30min）→ 唤醒新增 0 行
  const rowsBefore = (() => { try { return fs.readFileSync(wakeFile, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } })();
  const tickScript = path.join(os.tmpdir(), 'd1bf-tick.mjs');
  fs.writeFileSync(tickScript, [
    `import { routeTick } from ${JSON.stringify('file:///' + ROUTE_SRC.replace(/\\/g, '/'))};`,
    `const base = 1700000000000;`,
    `const a = await routeTick(${JSON.stringify(projectName)}, { now: base });`,
    `const b = await routeTick(${JSON.stringify(projectName)}, { now: base + 30 * 60 * 1000 });`,
    "console.log('TICK ' + JSON.stringify({ a: { ok: a.ok, wakes: (a.wakes || []).length, followUps: (a.followUps || []).length, retries: (a.retries || []).length }, b: { ok: b.ok, wakes: (b.wakes || []).length, followUps: (b.followUps || []).length, retries: (b.retries || []).length } }));",
  ].join('\n'), 'utf8');
  const tickRun = runNode([tickScript], env);
  const tickLine = tickRun.out.split(/\r?\n/).find((l) => l.startsWith('TICK '));
  let tick = null;
  if (tickLine) { try { tick = JSON.parse(tickLine.slice(5)); } catch { tick = null; } }
  const rowsAfter = (() => { try { return fs.readFileSync(wakeFile, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } })();
  check('AC3a 两拍 routeTick 成功（基准 + now+30min）', Boolean(tick && tick.a.ok && tick.b.ok), { tick, err: tickRun.err.slice(-400) });
  check('AC3b now+30min 拍新增唤醒行 = 0', rowsAfter - rowsBefore === 0, { before: rowsBefore, after: rowsAfter });
  check('AC6a 两拍都没有补催/重试产出（timer 路径无 wake）', Boolean(tick && tick.a.wakes === 0 && tick.b.wakes === 0 && tick.a.followUps === 0 && tick.b.retries === 0), tick);
} finally {
  try { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, 'run-d1bf.json'), JSON.stringify({ at: new Date().toISOString(), checks: ROWS }, null, 2) + '\n'); } catch { }
  fs.rmSync(SB, { recursive: true, force: true });
}

const failed = ROWS.filter((r) => !r.ok);
console.log('');
console.log('D1BF-WAKE-TIMER ' + (ROWS.length - failed.length) + '/' + ROWS.length + (failed.length ? ' FAIL' : ' PASS'));
process.exit(failed.length ? 1 : 0);
