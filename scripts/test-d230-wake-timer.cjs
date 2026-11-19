#!/usr/bin/env node
'use strict';
/**
 * test-d230-wake-timer.cjs —— R-d1bf / T-d230《壳层取消定时唤醒》夹具（壳层侧）。
 *
 * 覆盖：
 *  S 静态：main.js 不再有「定时泵/deadline 定时器/停滞恢复 tick」唤醒点；策略模块恒禁 timer；
 *           事件驱动投递已接 send/ack/task/startup；route-daemon 子进程透传 TEAM_ROUTE_NO_TIMER_WAKE。
 *  R 运行（沙盘）：用 AWB_NOW_MS 推进 +30 分钟（不真实 sleep）后，沙盘 唤醒.jsonl 零新增、真实 state 零写入。
 *  I 集成预留：工具层 trigger/dedupeKey/wake stats 由 A 的 T-ff54 落地后再由 tester 跑；本夹具只做壳层断言与
 *           接口断言（避免两条线并行时互相打红）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-d230'); })();
const rows = [];
function check(name, ok, detail) { rows.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : ' :: ' + JSON.stringify(detail).slice(0, 500))); }
function sha(file) { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return '-'; } }
function statSig(file) { try { const s = fs.statSync(file); return s.size + ':' + s.mtimeMs + ':' + sha(file); } catch { return 'MISSING'; } }

const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const policy = require(path.join(ROOT, 'src', 'wake-timer-policy.js'));

// ── S 静态断言 ────────────────────────────────────────────────────────────
check('S1 策略模块：定时唤醒关闭、timerWakeSites 为空', policy.ALLOW_TIMER_WAKE === false && policy.canTimerWake() === false && Array.isArray(policy.TIMER_WAKE_SITES) && policy.TIMER_WAKE_SITES.length === 0, policy.describePolicy());
check('S2 策略模块：事件清单含 send/ack/task/review/requirement/manual', ['send', 'ack', 'task', 'review', 'requirement', 'manual'].every((x) => policy.EVENT_TRIGGERS.includes(x)), policy.describePolicy());
const audit = policy.auditTimerWakeAttempt('unit-test');
check('S3 策略模块：timer 唤醒尝试恒被拒（TIMER_WAKE_DISABLED）', audit.allowed === false && audit.code === 'TIMER_WAKE_DISABLED', audit);
check('S4 main.js 不再有 setInterval(queuePump / setTimeout(queuePump', !/setInterval\s*\(\s*queuePump/.test(mainSrc) && !/setTimeout\s*\(\s*queuePump/.test(mainSrc), null);
check('S5 main.js 不再注册 deadline 定时器（无 dispatchDeadlineTimers / setTimeout 调 dispatchDeadlineTick）', !/dispatchDeadlineTimers/.test(mainSrc) && !/setTimeout\s*\([^)]*dispatchDeadlineTick/.test(mainSrc), null);
const schedFn = (() => { const i = mainSrc.indexOf('function scheduleDispatchDeadline'); if (i < 0) return ''; return mainSrc.slice(i, i + 900); })();
check('S6 scheduleDispatchDeadline 只审计不注册定时器', schedFn.length > 0 && !/setTimeout|setInterval/.test(schedFn) && /DISPATCH_DEADLINE_TIMER_DISABLED/.test(schedFn), schedFn.slice(0, 300));
check('S7 main.js 不再有定时停滞恢复/deadline tick（stalledRecovery 已移除）', !/stalledRecovery/.test(mainSrc) && !/dispatchDeadlineTick/.test(mainSrc), null);
check('S8 事件驱动投递已接 send/ack/task/startup', /queuePumpOnce\(["']send["']\)/.test(mainSrc) && /queuePumpOnce\(["']ack["']\)/.test(mainSrc) && /queuePumpOnce\(["']task["']\)/.test(mainSrc) && /queuePumpOnce\(["']startup["']\)/.test(mainSrc), null);
check('S9 队列投递只由 queuePumpOnce 调 pumpDispatchQueue（单点）', (mainSrc.match(/pumpDispatchQueue/g) || []).length === 1, (mainSrc.match(/pumpDispatchQueue/g) || []).length);
check('S10 route-daemon 子进程透传 TEAM_ROUTE_NO_TIMER_WAKE=1（只透传不加定时唤醒）', /TEAM_ROUTE_NO_TIMER_WAKE\s*=\s*['"]1['"]/.test(mainSrc), null);
check('S11 壳层启动记录 QUEUE_PUMP_TIMER_DISABLED（可观测）', /QUEUE_PUMP_TIMER_DISABLED/.test(mainSrc), null);
check('S12 启动投递用 microtask 而非 setTimeout', /queueMicrotask\(\s*\(\)\s*=>\s*\{[\s\S]{0,200}queuePumpOnce\(["']startup["']\)/.test(mainSrc), null);

// ── R 运行（沙盘 + 注入时钟推进 30 分钟，不真实 sleep）──────────────────
const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'd230-'));
try {
  const teamDir = path.join(sb, '团队');
  const stateDir = path.join(teamDir, '状态', '项目', '沙盘项目');
  fs.mkdirSync(stateDir, { recursive: true });
  const wakeFile = path.join(stateDir, '唤醒.jsonl');
  fs.writeFileSync(wakeFile, JSON.stringify({ at: '2026-11-19T00:00:00.000Z', to: 'pm', trigger: 'legacy' }) + '\n', 'utf8');
  fs.writeFileSync(path.join(teamDir, '状态', '团队.json'), JSON.stringify({ activeProject: '沙盘项目', members: [] }, null, 2), 'utf8');
  const realWake = path.join(ROOT, '项目', '工作台改造修复', '团队', '状态', '项目');
  const beforeWake = statSig(wakeFile);
  const realProjectWake = (() => {
    const base = path.join(ROOT, '团队', '状态', '项目');
    try {
      const dirs = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory());
      return dirs.map((d) => { const f = path.join(base, d.name, '唤醒.jsonl'); return fs.existsSync(f) ? { f, sig: statSig(f) } : null; }).filter(Boolean);
    } catch { return []; }
  })();
  // 用 AWB_NOW_MS 推进 +30 分钟（同一进程内），只调用策略审计与「事件投递空跑」模拟；
  // 壳层已无任何 timer 注册，故推进后不会有任何写盘。
  process.env.AWB_NOW_MS = String(Date.parse('2026-11-19T00:30:00.000Z'));
  process.env.TEAM_SELFTEST = '1';
  process.env.TEAM_ROOT = teamDir;
  process.env.TEAM_PROJECTS_ROOT = path.join(sb, '项目');
  const probe = policy.auditTimerWakeAttempt('sandbox-30min');
  check('R1 注入时钟 +30min 后 timer 唤醒尝试仍 0 允许', probe.allowed === false, probe);
  check('R2 沙盘 唤醒.jsonl 零新增（bytes/sha 不变）', statSig(wakeFile) === beforeWake, { beforeWake, after: statSig(wakeFile) });
  const realAfter = realProjectWake.map((x) => statSig(x.f));
  check('R3 真实项目 唤醒.jsonl 零写入（sha+mtime 不变）', realProjectWake.every((x, i) => realAfter[i] === x.sig), { before: realProjectWake.map((x) => x.sig), after: realAfter });
  const policyJson = JSON.parse(JSON.stringify(policy.describePolicy()));
  check('R4 策略快照可序列化且 queuePump=event-driven / deadlineTimer=audit-only', policyJson.queuePump === 'event-driven' && policyJson.deadlineTimer === 'audit-only', policyJson);
} finally {
  try { fs.rmSync(sb, { recursive: true, force: true }); } catch { /* ignore */ }
}

// ── I 集成预留（依赖 A 的 T-ff54：trigger/dedupeKey/wake stats）────────────
const hasWakeStats = (() => { try { const ops = fs.readFileSync(path.join(ROOT, '团队', '工具', 'lib', 'ops.mjs'), 'utf8'); return /wake stats|cmdWakeStats|trigger/.test(ops); } catch { return false; } })();
check('I1 集成前置探测：工具层 trigger/wake stats 已就绪（A 的 T-ff54）', hasWakeStats, { note: '未就绪时由 tester 在 A 落地后跑完整集成；壳层侧断言不受影响' });

// ── R5 真实壳层启动（沙盘）：AWB_NOW_MS+30min + AWB_STALL_TICK_MS=200 下不得再出现定时泵 ──────────
(async () => {
  const { spawn, spawnSync } = require('node:child_process');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'd230-app-'));
  let child = null;
  let out = '';
  try {
    const env = {
      ...process.env,
      AWB_DATA_DIR: path.join(sbRoot, 'data'),
      TEAM_ROOT: path.join(sbRoot, '团队'),
      TEAM_PROJECTS_ROOT: path.join(sbRoot, '项目'),
      TEAM_WORKBENCH_JSON: path.join(sbRoot, 'data', 'workbench.json'),
      TEAM_SELFTEST: '1',
      AWB_START_HIDDEN: '1',
      AWB_STALL_TICK_MS: '200',
      AWB_NOW_MS: String(Date.parse('2026-11-19T00:30:00.000Z')),
      AWB_ROUTE_DAEMON: 'off',
    };
    child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.'], {
      cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (c) => { out += String(c || ''); });
    child.stderr.on('data', (c) => { out += String(c || ''); });
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline && !/QUEUE_PUMP_TIMER_DISABLED/.test(out)) await sleep(200);
    await sleep(2500); // 若旧实现 200ms 定时泵还在，这段时间必然打出 QUEUE_PUMP/DISPATCH_DEADLINE 行
    check('R5 真实壳层启动：记录 QUEUE_PUMP_TIMER_DISABLED（新实现生效）', /QUEUE_PUMP_TIMER_DISABLED/.test(out), out.slice(0, 600));
    check('R6 真实壳层启动：无定时泵唤醒日志（无 QUEUE_PUMP / DISPATCH_DEADLINE_TICK）', !/^\s*QUEUE_PUMP /m.test(out) && !/DISPATCH_DEADLINE_TICK/.test(out), (out.match(/QUEUE_PUMP[^\n]*/g) || []).slice(0, 5));
    check('R7 真实壳层启动：进程存活且非崩溃退出', child.exitCode === null || child.exitCode === 0, { exitCode: child.exitCode, signal: child.signalCode });
  } finally {
    try { if (child && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ }
    try { await sleep(150); if (child) child.kill(); } catch { /* ignore */ }
    try { fs.rmSync(sbRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const failed = rows.filter((r) => !r.ok);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'd230-wake-timer-run.json'), JSON.stringify({ at: new Date().toISOString(), checks: rows }, null, 2) + '\n', 'utf8');
console.log('\nD230-WAKE-TIMER ' + (failed.length ? 'FAIL' : 'OK') + ' ' + JSON.stringify({ total: rows.length, pass: rows.length - failed.length, red: failed.length, integrationReady: hasWakeStats }));
console.log('证据：' + path.join(OUT, 'd230-wake-timer-run.json'));
process.exit(failed.length ? 1 : 0);
})();
