#!/usr/bin/env node
'use strict';
/**
 * test-a1eb-shell-roster-push.cjs —— R-a1eb / T-20261119-141958-16dd（壳层侧）夹具。
 *
 * 覆盖：
 *  U 单元（纯 Node，无 Electron）：src/roster-push.js 的名册签名口径（role/sessionId/status 三字段）、
 *    事件合并（静默窗口内 N 次落盘 → 1 次推送）、签名未变不推、maxWait 兜底、读失败不推、seed 基线、dispose。
 *  S 静态接线：main.js 建 watch + 一次广播（notifySessionQueueChanged('roster')）+ 可观测日志 + live-check 统计；
 *    app.js 只接 reason='roster'、在途只补跑一次（rosterUi.pending）+ __rosterPushStats 钩子 +
 *    SESSION_REPLACED/NOT_IN_ROSTER 进 block 码表；team-tools.js 会话级终态码不重试 + boot 记录带 rosterVersion；
 *    preload 无新增通道（复用既有 team:session-queue-changed，证明不改协议）。
 *  E 隔离集成（--electron）：沙盘 AWB_DATA_DIR+TEAM_ROOT 起真实壳层，3 次快速写名册 → 恰好 1 次推送；
 *    渲染层 __rosterPushStats 断言 events=1 / pushSyncs=1 / coalescedRuns=0；真实 团队/状态/团队.json 零写入。
 *
 * 用法：
 *   node scripts/test-a1eb-shell-roster-push.cjs              # 单元 + 静态（快）
 *   node scripts/test-a1eb-shell-roster-push.cjs --electron    # 追加真实壳层隔离集成
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const WANT_ELECTRON = process.argv.includes('--electron');
const OUT = (() => {
  const i = process.argv.indexOf('--out');
  const dir = i > 0 && process.argv[i + 1]
    ? path.resolve(process.argv[i + 1])
    : path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-a1eb-shell');
  return dir;
})();

const rows = [];
const skipped = [];
function check(name, ok, detail) {
  let text = '';
  try { text = JSON.stringify(detail === undefined ? null : detail); } catch { text = String(detail); }
  rows.push({ name, ok: Boolean(ok), detail: ok ? undefined : text });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : ' :: ' + text.slice(0, 600)));
}
function skip(name, detail) {
  skipped.push({ name, detail });
  console.log('SKIP  ' + name + ' :: ' + String(detail || ''));
}
function sha(file) { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return '-'; } }
function read(rel) { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return ''; } }

const lib = require(path.join(ROOT, 'src', 'roster-push.js'));
const mainSrc = read('src/main.js');
const appSrc = read('src/renderer/app.js');
const teamToolsSrc = read('src/team-tools.js');
const preloadSrc = read('src/preload.js');

const MEMBERS = [
  { role: 'pm', sessionId: 'session-a0000001', status: 'active', name: '项目经理' },
  { role: 'product', sessionId: 'session-a0000002', status: 'active', name: '产品设计师' },
  { role: 'analyst', sessionId: 'session-a0000003', status: 'active', name: '需求分析师' },
  { role: 'programmer1', sessionId: 'session-a0000004', status: 'active', name: '程序员A' },
  { role: 'programmer2', sessionId: 'session-a0000005', status: 'active', name: '程序员B' },
  { role: 'tester', sessionId: 'session-a0000006', status: 'active', name: '测试人员' },
];
const teamOf = (members) => ({ activeProject: '沙盘项目', members: members.map((m) => ({ ...m })) });

// ── U 单元 ────────────────────────────────────────────────────────────────
(function unit() {
  // U1 签名口径 = 需求 §6.1：sha256(JSON(members.map(m => ({role, sessionId, status}))))
  const expectPayload = MEMBERS.map((m) => ({ role: m.role, sessionId: m.sessionId, status: m.status }));
  const expectSig = crypto.createHash('sha256').update(JSON.stringify(expectPayload)).digest('hex');
  check('U1 名册签名与需求 §6.1 口径逐字节一致（role/sessionId/status 三字段）', lib.rosterSignature(teamOf(MEMBERS)) === expectSig, { got: lib.rosterSignature(teamOf(MEMBERS)), want: expectSig });

  // U2 只有三字段参与：昵称/备注/bootedAt 变化不改变签名；sessionId / status 变化要变
  const renamed = teamOf(MEMBERS.map((m) => ({ ...m, name: m.name + '（改名）', note: 'x', bootedAt: '2026-11-19T00:00:00.000Z' })));
  check('U2a 昵称/备注/bootedAt 变化不触发（不在三字段内）', lib.rosterSignature(renamed) === expectSig, null);
  const rotated = teamOf(MEMBERS.map((m) => (m.role === 'programmer1' ? { ...m, sessionId: 'session-b0000001' } : m)));
  check('U2b sessionId 变化触发', lib.rosterSignature(rotated) !== expectSig, null);
  const archived = teamOf(MEMBERS.map((m) => (m.role === 'tester' ? { ...m, status: 'archived' } : m)));
  check('U2c status 变化触发', lib.rosterSignature(archived) !== expectSig, null);
  const noStatus = { members: MEMBERS.map(({ status, ...rest }) => rest) };
  check('U2d 缺 status 视为 active（与签名口径一致）', lib.rosterSignature(noStatus) === expectSig, null);

  // 假时钟/假定时器：按 due 时间顺序执行，不真实等待
  function fakeClock() {
    let nowMs = 0;
    let seq = 0;
    const timers = [];
    return {
      now: () => nowMs,
      setTimeout: (fn, ms) => { const id = { id: ++seq, due: nowMs + Math.max(0, Number(ms) || 0), fn }; timers.push(id); return id; },
      clearTimeout: (id) => { const i = timers.indexOf(id); if (i >= 0) timers.splice(i, 1); },
      advance: (ms) => {
        const target = nowMs + Math.max(0, Number(ms) || 0);
        for (;;) {
          const due = timers.filter((t) => t.due <= target).sort((a, b) => a.due - b.due || a.id - b.id)[0];
          if (!due) break;
          timers.splice(timers.indexOf(due), 1);
          nowMs = due.due;
          try { due.fn(); } catch { /* 夹具内不吞真实错误：下面断言会暴露 */ }
        }
        nowMs = target;
      },
      pending: () => timers.length,
    };
  }

  // U3 合并：静默窗口内 6 次事件 → 1 次推送，并正确列出变化角色
  {
    const clock = fakeClock();
    let current = teamOf(MEMBERS);
    const emitted = [];
    const ctl = lib.createRosterPushController({
      readTeam: () => current,
      emit: (info) => emitted.push(info),
      now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      quietMs: 250, maxWaitMs: 1200,
    });
    ctl.seed(current);
    // 模拟“批量换人”：3 次落盘（每次改 2 个角色），事件在 120ms 内密集到达
    current = teamOf(MEMBERS.map((m) => (['programmer1', 'programmer2'].includes(m.role) ? { ...m, sessionId: m.sessionId + 'x' } : m)));
    ctl.poke();
    clock.advance(40);
    current = teamOf(MEMBERS.map((m) => (['programmer1', 'programmer2', 'tester'].includes(m.role) ? { ...m, sessionId: m.sessionId + 'y' } : m)));
    ctl.poke();
    clock.advance(40);
    ctl.poke();
    clock.advance(300); // 越过静默窗口（最后一次事件 + quietMs）
    check('U3a 合并窗口内 3 次事件只推 1 次', emitted.length === 1, { emitted: emitted.length, stats: ctl.stats() });
    check('U3b 推送列出真正变化的角色（programmer1/programmer2/tester）', emitted.length === 1 && ['programmer1', 'programmer2', 'tester'].every((r) => emitted[0].roles.includes(r)), emitted[0] && emitted[0].roles);
    const stats = ctl.stats();
    check('U3c 统计：fileEvents=3 / broadcast=1 / collapsedEvents≥1', stats.fileEvents === 3 && stats.broadcast === 1 && stats.collapsedEvents >= 1, stats);
    // U4 签名未变（内容重复写）不推
    ctl.poke();
    clock.advance(400);
    check('U4 名册内容未变的事件不再推送（skippedUnchanged=1）', emitted.length === 1 && ctl.stats().skippedUnchanged === 1, ctl.stats());
  }

  // U5 maxWait：持续写入也会在 maxWait 内 flush（不会无限推迟）
  {
    const clock = fakeClock();
    let current = teamOf(MEMBERS);
    const emitted = [];
    const ctl = lib.createRosterPushController({
      readTeam: () => current,
      emit: (info) => emitted.push(info),
      now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
      quietMs: 250, maxWaitMs: 1200,
    });
    ctl.seed(current);
    for (let i = 0; i < 10; i += 1) {
      current = teamOf(MEMBERS.map((m) => (m.role === 'pm' ? { ...m, sessionId: 'session-c' + i } : m)));
      ctl.poke();
      clock.advance(180); // 每 180ms 一次，短于 quiet 的 250ms，但累计超过 maxWait
    }
    check('U5a 持续写入仍在 maxWait 内 flush（不无限推迟）', emitted.length >= 1, { emitted: emitted.length, stats: ctl.stats() });
    check('U5b 10 次事件合并后推送次数远小于事件数（≤3）', ctl.stats().broadcast <= 3, ctl.stats());
  }

  // U6 读失败不推（宁可下次再来，也不拿空名册推）
  {
    const clock = fakeClock();
    const ctl = lib.createRosterPushController({
      readTeam: () => { throw new Error('injected read failure'); },
      emit: () => { throw new Error('emit must not be called'); },
      now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    });
    ctl.seed(teamOf(MEMBERS));
    ctl.poke();
    clock.advance(300);
    check('U6 名册读失败：不推送、只记 readFailed', ctl.stats().readFailed === 1 && ctl.stats().broadcast === 0, ctl.stats());
  }

  // U7 seed 基线：建 watch 时的名册不算变化
  {
    const clock = fakeClock();
    let current = teamOf(MEMBERS);
    const emitted = [];
    const ctl = lib.createRosterPushController({
      readTeam: () => current,
      emit: (info) => emitted.push(info),
      now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    });
    ctl.seed(current);
    ctl.poke();
    clock.advance(300);
    check('U7 建 watch 后「与基线相同」的事件不推（避免启动即刷一次）', emitted.length === 0 && ctl.stats().skippedUnchanged === 1, ctl.stats());
  }

  // U8 dispose 后不再接事件
  {
    const clock = fakeClock();
    const ctl = lib.createRosterPushController({
      readTeam: () => teamOf(MEMBERS), emit: () => {}, now: clock.now, setTimeout: clock.setTimeout, clearTimeout: clock.clearTimeout,
    });
    ctl.seed(teamOf(MEMBERS));
    ctl.dispose();
    check('U8 dispose 后 poke 不再排队（DISPOSED）', ctl.poke().code === 'DISPOSED' && ctl.pending() === false, ctl.poke());
  }
})();

// ── S 静态接线 ────────────────────────────────────────────────────────────
check('S1 main.js：名册 watch 用 roster-push 合并器（require + createRosterPushController）',
  /require\(['"]\.\/roster-push['"]\)/.test(mainSrc) && /createRosterPushController\(/.test(mainSrc), null);
check('S2 main.js：只认名册本体（团队.json，tmp/其它状态文件不触发）',
  /changed !== '团队\.json'/.test(mainSrc), null);
check('S3 main.js：一次 emit = 一次广播（notifySessionQueueChanged(\'roster\') 只出现一次）',
  (mainSrc.match(/notifySessionQueueChanged\('roster'\)/g) || []).length === 1, (mainSrc.match(/notifySessionQueueChanged\('roster'\)/g) || []).length);
check('S4 main.js：可观测（[roster-push] 日志、watch/广播/错误事件、live-check 统计 rosterPush）',
  /\[roster-push\]/.test(mainSrc) && /event: 'watch'/.test(mainSrc) && /event: 'broadcast'/.test(mainSrc) && /rosterPush: rosterPushStatsOf\(\)/.test(mainSrc), null);
check('S5 app.js：只接 reason=\'roster\' 推送（其它推送交队列面板，不重复读状态）',
  /reason !== 'roster'/.test(appSrc) && /bindRosterPush\(\)/.test(appSrc), null);
check('S6 app.js：同步在途只补跑一次（pending/coalesced）',
  /rosterUi\.pending = true/.test(appSrc) && /coalescedRuns \+= 1/.test(appSrc) && /startsWith\('roster'\)/.test(appSrc), null);
check('S7 app.js：只读统计钩子 __rosterPushStats（events/syncs/pushSyncs/coalesced）',
  /window\.__rosterPushStats/.test(appSrc) && /pushSyncs/.test(appSrc) && /coalescedRuns/.test(appSrc), null);
check('S8 app.js：SESSION_REPLACED / NOT_IN_ROSTER 进 block 码表（界面按硬拒显示）',
  /'SESSION_REPLACED',\s*\n\s*'NOT_IN_ROSTER'/.test(appSrc) && /PANEL_SEVERITY_BLOCK_CODES/.test(appSrc), null);
check('S9 app.js：boot 记录里的 rosterChangedSinceToken 只作 info 提示（data-roster-hint，不判红）',
  /data-roster-hint="1"/.test(appSrc) && /rosterChangedSinceToken/.test(appSrc), null);
check('S10 team-tools.js：会话级终态码单独一张表 + 不重试',
  /const SESSION_FATAL_CODES = \['SESSION_REPLACED', 'NOT_IN_ROSTER'\]/.test(teamToolsSrc)
  && /SESSION_FATAL_CODES\.includes\(result\.code\)[\s\S]{0,400}retryable: false/.test(teamToolsSrc), null);
check('S11 team-tools.js：boot 令牌/记录带 rosterVersion + rosterChangedSinceToken（旧工具缺省不伪造）',
  /rosterVersion: String\(value\.rosterVersion \|\| ''\)/.test(teamToolsSrc)
  && /rosterVersion: String\(boot\.rosterVersion \|\| ''\)/.test(teamToolsSrc)
  && /rosterChangedSinceToken: Boolean\(boot\.rosterChangedSinceToken\)/.test(teamToolsSrc), null);
check('S12 preload.js：没有新增通道（复用既有 team:session-queue-changed，协议不变）',
  !/roster/i.test(preloadSrc), null);
// 自检：本夹具只允许按 PID 回收自己 spawn 的进程（P0 e923：绝不按进程名批量杀）。
// 注意：这里用字符串拼接引用命令名，避免「检查语句本身」被自己的正则命中（自指假红）。
{
  const KILL_CLI = 'task' + 'kill';
  const BATCH_FLAG = String.fromCharCode(47) + 'IM';
  const selfSrc = fs.readFileSync(__filename, 'utf8');
  const codeLines = selfSrc.split(/\r?\n/).filter((line) => {
    const t = line.trim();
    return t.includes(KILL_CLI) && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('/*');
  });
  const bad = codeLines.filter((line) => !line.includes(String.fromCharCode(47) + 'PID') || line.includes(BATCH_FLAG));
  check('S13 夹具自身只按 /PID 回收进程（无按名批量杀）', codeLines.length > 0 && bad.length === 0, { codeLines, bad });
}

// ── E 隔离集成（--electron）─────────────────────────────────────────────
async function runElectron() {
  const { spawn, spawnSync } = require('node:child_process');
  const http = require('node:http');
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const sbRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'a1eb-shell-'));
  let child = null;
  let out = '';
  try {
    const dataDir = path.join(sbRoot, 'data');
    const teamDir = path.join(sbRoot, '团队');
    const projDir = path.join(sbRoot, '项目');
    fs.mkdirSync(path.join(teamDir, '状态'), { recursive: true });
    fs.mkdirSync(dataDir, { recursive: true });
    const rosterFile = path.join(teamDir, '状态', '团队.json');
    const writeRoster = (members) => {
      // 原子写（tmp+rename），和工具层落盘方式一致
      const tmp = rosterFile + '.tmp';
      fs.writeFileSync(tmp, JSON.stringify(teamOf(members), null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, rosterFile);
    };
    writeRoster(MEMBERS);
    const storeFile = path.join(dataDir, 'workbench.json');
    fs.writeFileSync(storeFile, JSON.stringify({
      projects: [{
        id: 'sandbox-project',
        name: '沙盘项目',
        path: path.join(projDir, '沙盘项目'),
        teamName: '沙盘项目',
        teamMode: 'full',
        sessions: Object.fromEntries(MEMBERS.map((m) => [m.role, m.sessionId])),
        workspace: { sessionIds: MEMBERS.map((m) => m.sessionId) },
        messages: [],
        events: []
      }],
      activeProjectId: 'sandbox-project',
      ui: {}
    }, null, 2), 'utf8');
    // 真实树零写入基线
    const realRoster = path.join(ROOT, '团队', '状态', '团队.json');
    const realBefore = { sha: sha(realRoster) };
    const PORT = 19371 + Math.floor(Math.random() * 200);
    const env = {
      ...process.env,
      AWB_DATA_DIR: dataDir,
      TEAM_ROOT: teamDir,
      TEAM_PROJECTS_ROOT: projDir,
      TEAM_WORKBENCH_JSON: storeFile,
      TEAM_SELFTEST: '1',
      AWB_START_HIDDEN: '1',
      AWB_ROUTE_DAEMON: 'off',
      AWB_SQ_PUSH_DISABLE: '0',
      AWB_ROSTER_PUSH_QUIET_MS: '250',
      AWB_ROSTER_PUSH_MAX_WAIT_MS: '1200',
    };
    child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], {
      cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', (c) => { out += String(c || ''); });
    child.stderr.on('data', (c) => { out += String(c || ''); });
    const deadline = Date.now() + 45000;
    while (Date.now() < deadline && !/\[roster-push\] \{"event":"watch"/.test(out)) await sleep(200);
    check('E1 真实壳层：名册 watch 已建立（[roster-push] event=watch）', /\[roster-push\] \{"event":"watch"/.test(out), out.slice(-800));
    await sleep(2500); // 让启动期的名册同步（shell → 团队.json）先落完，之后再测合并
    const broadcastsOf = (text) => (text.match(/\[roster-push\] \{"event":"broadcast"[^\n]*/g) || []);
    const beforeCount = broadcastsOf(out).length;
    // 批处理现场：3 次快速落盘（每次换 2 个角色的会话），模拟批量 rotate 的多次写盘
    let seq = MEMBERS.map((m) => ({ ...m }));
    for (let i = 1; i <= 3; i += 1) {
      seq = seq.map((m) => (['programmer1', 'programmer2'].includes(m.role) ? { ...m, sessionId: 'session-e' + i + m.role.slice(-1) } : m));
      writeRoster(seq);
      await sleep(60);
    }
    await sleep(2600);
    const afterLines = broadcastsOf(out);
    check('E2 3 次快速落盘 → 恰好新增 1 次推送（批量合并生效）', afterLines.length === beforeCount + 1, {
      before: beforeCount, after: afterLines.length,
      lines: afterLines.slice(-4)
    });
    if (afterLines.length) {
      const last = (() => { try { return JSON.parse(afterLines[afterLines.length - 1].replace(/^\[roster-push\]\s*/, '')); } catch { return null; } })();
      check('E3 推送内容列出变化的角色（programmer1/programmer2）',
        Boolean(last) && Array.isArray(last.roles) && ['programmer1', 'programmer2'].every((r) => last.roles.includes(r)), last);
    } else {
      check('E3 推送内容列出变化的角色（programmer1/programmer2）', false, '无广播行');
    }
    // 渲染层：推送一次 → 同步一次（CDP 读只读钩子）
    let pushStats = null;
    try {
      const list = await new Promise((resolve, reject) => {
        const req = http.get(`http://127.0.0.1:${PORT}/json/list`, (res) => {
          let body = '';
          res.on('data', (d) => { body += String(d); });
          res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
        });
        req.on('error', reject);
        req.setTimeout(5000, () => { req.destroy(new Error('cdp list timeout')); });
      });
      const targets = Array.isArray(list) ? list : [];
      // 主窗是本地 file:// 页面（不是 http），所以不能按 http 前缀筛：优先 page，排除 devtools。
      const target = targets.find((t) => t && t.webSocketDebuggerUrl && t.type === 'page' && !/^devtools:/i.test(String(t.url || '')))
        || targets.find((t) => t && t.webSocketDebuggerUrl && t.type === 'page')
        || targets.find((t) => t && t.webSocketDebuggerUrl);
      if (!target) throw new Error('no page target: ' + JSON.stringify(targets.map((t) => ({ type: t.type, url: String(t.url || '').slice(0, 80) }))));
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('ws open failed')); });
      const evaluate = (expr, ms = 15000) => new Promise((resolve, reject) => {
        const id = Math.floor(Math.random() * 1e6);
        const timer = setTimeout(() => reject(new Error('evaluate timeout')), ms);
        const onMsg = (ev) => {
          let msg = null;
          try { msg = JSON.parse(String(ev.data)); } catch { return; }
          if (!msg || msg.id !== id) return;
          clearTimeout(timer);
          ws.removeEventListener('message', onMsg);
          if (msg.error) reject(new Error(JSON.stringify(msg.error)));
          else resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
        };
        ws.addEventListener('message', onMsg);
        ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
      });
      pushStats = await evaluate('(typeof window.__rosterPushStats === "function" ? window.__rosterPushStats() : null)');
      try { ws.close(); } catch { /* ignore */ }
    } catch (error) {
      check('E4 渲染层钩子可读（__rosterPushStats）', false, String((error && error.message) || error));
    }
    if (pushStats) {
      check('E4 渲染层：1 次推送 → 1 次名册同步（events=1 / pushSyncs=1）',
        Number(pushStats.events) === 1 && Number(pushStats.pushSyncs) === 1, pushStats);
      check('E5 渲染层：没有按角色重复刷新（coalescedRuns=0、syncs ≤ 2）',
        Number(pushStats.coalescedRuns) === 0 && Number(pushStats.syncs) <= 2, pushStats);
    } else if (!rows.some((r) => r.name.startsWith('E4'))) {
      check('E4 渲染层：1 次推送 → 1 次名册同步（events=1 / pushSyncs=1）', false, '未取到 __rosterPushStats');
    }
    check('E6 隔离：真实 团队/状态/团队.json 零写入（sha 不变）', sha(realRoster) === realBefore.sha, { before: realBefore.sha, after: sha(realRoster) });
    check('E7 壳层存活（非崩溃退出）', child.exitCode === null || child.exitCode === 0, { exitCode: child.exitCode, signal: child.signalCode });
  } finally {
    try { if (child && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ }
    try { await sleep(150); if (child) child.kill(); } catch { /* ignore */ }
    try { fs.rmSync(sbRoot, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

(async () => {
  if (WANT_ELECTRON) await runElectron();
  else skip('E1–E7 隔离集成（真实壳层）', '本次未加 --electron；单元+静态已覆盖，完整验收请加 --electron');
  const pass = rows.filter((r) => r.ok).length;
  const fail = rows.length - pass;
  try {
    fs.mkdirSync(OUT, { recursive: true });
    const report = {
      generatedAt: new Date().toISOString(),
      head: (() => { try { return require('node:child_process').execSync('git rev-parse --short HEAD', { cwd: ROOT }).toString().trim(); } catch { return ''; } })(),
      task: 'T-20261119-141958-16dd',
      requirement: 'R-20261119-140657-a1eb',
      electron: WANT_ELECTRON,
      pass, fail, total: rows.length, skipped: skipped.length, rows, skippedRows: skipped,
    };
    fs.writeFileSync(path.join(OUT, 'test-a1eb-shell-roster-push.json'), JSON.stringify(report, null, 2), 'utf8');
  } catch { /* 报告写不出不影响退出码 */ }
  console.log(`\n${pass}/${rows.length} PASS${fail ? ` · ${fail} FAIL` : ''}`);
  process.exit(fail ? 1 : 0);
})();
