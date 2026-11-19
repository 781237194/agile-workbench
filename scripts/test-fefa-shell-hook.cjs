#!/usr/bin/env node
'use strict';
/**
 * test-fefa-shell-hook.cjs —— R-fefa 壳层补充（T-20261119-185311-66b4）
 *
 * ① 压缩信号：壳层写 `团队/状态/角色卡重读/compact.signal`（可注入 IPC）→ CLI 读到即删并注入一次（trigger=compact）。
 * ② usage tokens：把 session/list 的 tokenUsage 写进 `团队/状态/项目/<slug>/会话用量.json`，供 CLI usage 闩锁读。
 *
 * 用法：
 *   node scripts/test-fefa-shell-hook.cjs             # 单元 + 静态（快）
 *   node scripts/test-fefa-shell-hook.cjs --electron   # 追加真实壳层（CDP 注入 → CLI 消费 → 审计）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const WANT_ELECTRON = process.argv.includes('--electron');
const OUT = (() => {
  const i = process.argv.indexOf('--out');
  return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-fefa-shell');
})();
const rows = [];
function check(name, ok, detail) {
  let text = ''; try { text = JSON.stringify(detail === undefined ? null : detail); } catch { text = String(detail); }
  rows.push({ name, ok: Boolean(ok), detail: ok ? undefined : text });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : ' :: ' + text.slice(0, 700)));
}
function shaFile(f) { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '-'; } }
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
const hook = require(path.join(ROOT, 'src', 'rolecard-shell-hook.js'));

// ── U 单元 ───────────────────────────────────────────────────────────────
(function unit() {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'fefa-hook-'));
  try {
    const w = hook.writeCompactSignal(sb, { role: 'programmer1', source: 'unit', at: '2026-11-19T10:00:00.000Z' });
    check('U1 压缩信号：写到 团队/状态/角色卡重读/compact.signal（含 role/at/source）',
      Boolean(w.ok) && /角色卡重读/.test(w.file) && /compact\.signal$/.test(w.file), w);
    const read = hook.readCompactSignal(sb);
    check('U1b 信号内容可读且字段齐（at/role/source）',
      Boolean(read.ok && read.payload) && read.payload.role === 'programmer1' && read.payload.source === 'unit' && Boolean(read.payload.at), read.payload);

    const sessions = [
      { sessionId: 's1', projections: { values: { tokenUsage: { uncachedInputTokens: 300001, cacheReadTokens: 5, outputTokens: 7 } } } },
      { sessionId: 's2', projections: { values: {} } },
    ];
    const entries = hook.usageEntriesOfSessions({ sessions, sessionsByRole: { programmer1: 's1', pm: 's2' }, at: '2026-11-19T10:00:00.000Z' });
    check('U2 usage：input=uncachedInputTokens、tokens=三者之和、source=workbench-shell；无 tokenUsage 的角色跳过',
      entries.programmer1 && entries.programmer1.input === 300001 && entries.programmer1.tokens === 300013 && entries.programmer1.source === 'workbench-shell' && !entries.pm,
      entries);
    const psd = path.join(sb, 'psd');
    const wr = hook.writeUsageTrack(psd, entries);
    const onDisk = JSON.parse(fs.readFileSync(wr.file, 'utf8'));
    check('U3 usage 落盘到 会话用量.json（schema 与 session.mjs 一致）',
      wr.ok && onDisk.programmer1 && onDisk.programmer1.tokens === 300013 && onDisk.programmer1.sessionId === 's1', onDisk);
    check('U4 usageFresh：新鲜/过期判定（>24h 视为用量未知）',
      hook.usageFresh({ at: new Date().toISOString() }) === true && hook.usageFresh({ at: '2020-01-01T00:00:00Z' }) === false, null);

    // 压缩标记探测：多种字段形态
    const m1 = hook.compactMarkerOfSession({ sessionId: 'a', projections: { values: { compactionCount: 3 } } });
    const m2 = hook.compactMarkerOfSession({ sessionId: 'b', lastCompactionAt: '2026-11-19T09:00:00Z' });
    const m3 = hook.compactMarkerOfSession({ sessionId: 'c' });
    check('U5 压缩标记探测：compactionCount / lastCompactionAt 均能识别，无字段返回 null',
      m1 && m1.kind === 'count' && m1.count === 3 && m2 && m2.kind === 'at' && m3 === null,
      { m1, m2, m3 });
    check('U6 增量判定：计数/时间前进才算一次压缩，首样本不算',
      hook.detectCompactDelta(null, m1) === false && hook.detectCompactDelta({ kind: 'count', count: 1 }, { kind: 'count', count: 2 }) === true
      && hook.detectCompactDelta({ kind: 'count', count: 2 }, { kind: 'count', count: 2 }) === false
      && hook.detectCompactDelta({ kind: 'at', ms: 1 }, { kind: 'at', ms: 2 }) === true, null);

    // syncSessionSideEffects：一次扫描同时写 usage + 探测到压缩才写 signal
    const sb2 = fs.mkdtempSync(path.join(os.tmpdir(), 'fefa-sync-'));
    const psd2 = path.join(sb2, 'psd');
    const seen = new Map();
    const first = hook.syncSessionSideEffects({
      teamRoot: sb2, projectStateDir: psd2, sessions: [{ sessionId: 's1', projections: { values: { tokenUsage: { uncachedInputTokens: 300001 }, compactionCount: 0 } } }], sessionsByRole: { programmer1: 's1' }, compactSeen: seen, at: '2026-11-19T10:00:00Z',
    });
    check('U7 首轮扫描：写 usage、不写 signal（首样本只记基线）',
      first.usage.wrote === true && first.signals.length === 0 && !fs.existsSync(hook.compactSignalFile(sb2)), first);
    const sessions2 = [{ sessionId: 's1', projections: { values: { tokenUsage: { uncachedInputTokens: 300010 }, compactionCount: 1 } } }];
    const second = hook.syncSessionSideEffects({ teamRoot: sb2, projectStateDir: psd2, sessions: sessions2, sessionsByRole: { programmer1: 's1' }, compactSeen: seen, at: '2026-11-19T10:05:00Z' });
    check('U8 探测到压缩计数前进：写一次 signal（role=programmer1）',
      second.signals.length === 1 && second.signals[0].ok && fs.existsSync(hook.compactSignalFile(sb2))
      && hook.readCompactSignal(sb2).payload.role === 'programmer1', second);
    const third = hook.syncSessionSideEffects({ teamRoot: sb2, projectStateDir: psd2, sessions: sessions2, sessionsByRole: { programmer1: 's1' }, compactSeen: seen, at: '2026-11-19T10:06:00Z' });
    check('U9 同计数重复扫描不重复写（不刷屏）', third.signals.length === 0, third);
    fs.rmSync(sb2, { recursive: true, force: true });
  } finally {
    try { fs.rmSync(sb, { recursive: true, force: true }); } catch { /* ignore */ }
  }
})();

// ── S 静态接线 ───────────────────────────────────────────────────────────
const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
check('S1 main.js 接线：require hook + dsh:team-status 内调用 syncSessionSideEffects',
  /require\('\.\/rolecard-shell-hook\.js'\)/.test(mainSrc) && /rolecardShellHook\.syncSessionSideEffects\(/.test(mainSrc), null);
check('S2 压缩信号 IPC 仅在沙盘/自检/显式开启时注册（生产不暴露写盘面）',
  /team:compact-signal/.test(mainSrc) && /TEAM_SELFTEST/.test(mainSrc) && /AWB_COMPACT_SIGNAL_ENABLE/.test(mainSrc), null);
check('S3 preload 暴露 compactSignal（渲染层/夹具可用）', /compactSignal:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('team:compact-signal'/.test(preloadSrc), null);
check('S4 usage 写盘节流（30s）+ 只在写了才刷新时间戳', /rolecardUsageSyncedAt < 30000/.test(mainSrc) && /if \(side && side\.usage && side\.usage\.wrote\) rolecardUsageSyncedAt = nowMs;/.test(mainSrc), null);

// ── E 真实壳层（--electron）──────────────────────────────────────────────
async function connect(port) {
  const list = await new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
      let body = ''; res.on('data', (d) => { body += String(d); }); res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject); req.setTimeout(4000, () => req.destroy(new Error('cdp list timeout')));
  });
  const targets = Array.isArray(list) ? list : [];
  const target = targets.find((t) => t && t.webSocketDebuggerUrl && t.type === 'page' && /renderer[\\/]index\.html/.test(String(t.url || '')))
    || targets.find((t) => t && t.webSocketDebuggerUrl && t.type === 'page');
  if (!target) throw new Error('no page target');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('ws open failed')); });
  const evaluate = (expr, ms = 30000) => new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e6);
    const timer = setTimeout(() => reject(new Error('evaluate timeout')), ms);
    const onMsg = (ev) => {
      let msg = null; try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (!msg || msg.id !== id) return;
      clearTimeout(timer); ws.removeEventListener('message', onMsg);
      if (msg.error) reject(new Error(JSON.stringify(msg.error))); else resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
  return { evaluate, close: () => { try { ws.close(); } catch { /* ignore */ } } };
}

async function runElectron() {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'fefa-e2e-'));
  let child = null; let cdp = null;
  const teamDir = path.join(sb, '团队');
  const projectsDir = path.join(sb, '项目');
  const dataDir = path.join(sb, 'data');
  const project = '沙盘fefa';
  const projDir = path.join(projectsDir, project);
  const env = {
    ...process.env,
    TEAM_ROOT: teamDir, TEAM_PROJECTS_ROOT: projectsDir,
    TEAM_WORKBENCH_JSON: path.join(dataDir, 'workbench.json'), AWB_DATA_DIR: dataDir,
    TEAM_SELFTEST: '1', AWB_START_HIDDEN: '1', AWB_ROUTE_DAEMON: 'off',
    // 隔离：本机全局可能有 AWB_TEAM_ROOT（resolveTeamRoot 优先读它）→ 沙盘必须显式清掉，否则会写真实团队状态。
    AWB_TEAM_ROOT: '',
  };
  const run = (args, extra = {}) => {
    const r = spawnSync(process.execPath, [path.join(ROOT, '团队', '工具', 'team.mjs'), ...args], { cwd: ROOT, env: { ...env, ...extra }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    return { code: r.status, out: String(r.stdout || '') + String(r.stderr || ''), stdout: String(r.stdout || '') };
  };
  const j = (s) => { const i = s.indexOf('{'); return i >= 0 ? JSON.parse(s.slice(i)) : null; };
  try {
    run(['init', '--json']);
    run(['project', 'create', '--name', project, '--dir', projDir, '--json']);
    const signalFile = hook.compactSignalFile(teamDir);
    const port = 19971 + Math.floor(Math.random() * 200);
    child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + port], {
      cwd: ROOT, env, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
    });
    child.stdout.on('data', () => {}); child.stderr.on('data', () => {});
    let out = '';
    child.stdout.on('data', (c) => { out += String(c || ''); });
    const deadline = Date.now() + 60000;
    while (Date.now() < deadline) { try { cdp = await connect(port); break; } catch { await sleep(500); } }
    check('E0 真实壳层启动（CDP 可连 + 注入 IPC 已注册）', Boolean(cdp) && /\[compact-signal\] injectable IPC registered/.test(out), out.slice(-400));
    if (!cdp) return;
    for (let i = 0; i < 120; i += 1) {
      const ready = await cdp.evaluate('document.readyState === "complete" && Boolean(window.workbench && window.workbench.compactSignal)');
      if (ready === true) break;
      await sleep(400);
    }
    check('E1 启动后不压缩 → 不写 compact.signal（不造假）', !fs.existsSync(signalFile), { signalFile });

    const injected = await cdp.evaluate('(async () => { try { return await window.workbench.compactSignal({ role: "programmer1", source: "e2e", at: "2026-11-19T10:00:00.000Z" }); } catch (e) { return { threw: String((e && e.message) || e) }; } })()');
    check('E2 注入一次压缩信号 → 文件出现（role/at 正确）',
      Boolean(injected && injected.ok) && fs.existsSync(signalFile)
      && (() => { try { const p = JSON.parse(fs.readFileSync(signalFile, 'utf8')); return p.role === 'programmer1' && p.at === '2026-11-19T10:00:00.000Z'; } catch { return false; } })(),
      injected);

    // CLI 消费：task claim 是计数触发点；读到 signal → 删除 + 注入一次 [rolecard-digest]（trigger=compact）。
    // 注意：A 侧当前只把该行打进**人类文本**（--json 返回体没有 rolecardDigest 字段，属 A 的 CLI 侧缺口，
    // TR-Q 缺项 7 要求 --json 同源）——本单只验壳层链路，所以用人类文本断言并在回执里如实报该缺口。
    const pmTok = (j(run(['boot', '--role', 'pm', '--project', project, '--session', 'session-fefa-pm', '--json']).stdout) || {}).token;
    const p1Tok = (j(run(['boot', '--role', 'programmer1', '--project', project, '--session', 'session-fefa-p1', '--json']).stdout) || {}).token;
    const task = j(run(['task', 'create', '--boot', pmTok, '--title', 'fefa 消费验证', '--priority', 'P1', '--owner', 'programmer1', '--json']).stdout);
    const taskId = task && task.task && task.task.id;
    const claim = run(['task', 'claim', '--boot', p1Tok, '--id', taskId]);
    const hasDigestLine = /\[rolecard-digest\]/.test(claim.out);
    check('E3 CLI 读到压缩信号：返回体含 [rolecard-digest] 且信号文件被删除（消费式）',
      hasDigestLine && !fs.existsSync(signalFile), { hasDigestLine, signalExists: fs.existsSync(signalFile), tail: claim.out.slice(-500) });
    const auditFile = path.join(teamDir, '状态', '项目', project, '角色卡重读.jsonl');
    const auditRows = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
    const compactRow = auditRows.filter((r) => r && r.trigger === 'compact').pop();
    check('E4 审计 角色卡重读.jsonl 有 trigger=compact 行（字段 at/role/cardSha12/shownLines）',
      Boolean(compactRow) && Boolean(compactRow.at) && compactRow.role === 'programmer1' && 'cardSha12' in compactRow && 'shownLines' in compactRow, compactRow || auditRows.slice(-2));
  } finally {
    try { if (cdp) cdp.close(); } catch { /* ignore */ }
    try { if (child && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ }
    try { await sleep(150); if (child) child.kill(); } catch { /* ignore */ }
    try { fs.rmSync(sb, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

(async () => {
  if (WANT_ELECTRON) await runElectron();
  else console.log('SKIP  E1–E4 真实壳层（加 --electron 跑完整链路）');
  const pass = rows.filter((r) => r.ok).length;
  const fail = rows.length - pass;
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'test-fefa-shell-hook.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      head: (() => { try { return spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(); } catch { return ''; } })(),
      task: 'T-20261119-185311-66b4', electron: WANT_ELECTRON, pass, fail, total: rows.length, rows,
    }, null, 2), 'utf8');
  } catch { /* ignore */ }
  console.log(`\n${pass}/${rows.length} PASS${fail ? ` · ${fail} FAIL` : ''}`);
  process.exit(fail ? 1 : 0);
})();
