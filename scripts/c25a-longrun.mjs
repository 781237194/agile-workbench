/**
 * c25a AC3 长跑器（AC2 也靠它抓真退出）。
 *
 * 每次运行：隔离沙盘 → 起 `--no-wake` 壳 → 等 N 分钟 → 若自行退出则记录退出时刻与审计行；
 * 未退出则到点优雅关闭（Page.close → window-all-closed → will-quit）并记录。
 * 输出：项目/工作台改造修复/程序员B/产出/证据-c25a/longrun-<N>.json
 *
 * 跑法：node scripts/c25a-longrun.mjs --run 1 --minutes 35
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const argOf = (name, fallback) => {
  const hit = process.argv.find((a) => a.startsWith(`--${name}=`)) || '';
  if (hit) return hit.split('=').slice(1).join('=');
  const idx = process.argv.indexOf(`--${name}`);
  return idx >= 0 && process.argv[idx + 1] ? process.argv[idx + 1] : fallback;
};
const RUN = Number(argOf('run', '1'));
const MINUTES = Number(argOf('minutes', '35'));
const PORT = 9500 + RUN;
const SB = path.join(ROOT, '_tmp', `c25a-run${RUN}`);
const TEAM = path.join(SB, '团队');
const PROJ = `c25a-run${RUN}`;
const STATE = path.join(TEAM, '状态', '项目', PROJ);
const DATA = path.join(SB, 'data');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// AC3 长跑必须让壳里的 webview 有「能加载的页面」：真 DSH 在沙盘里不可达，webview 会一直
// ERR_ABORTED 并触发渲染进程崩溃（c25a 现场正是这么来的）。这里起一个最小静态服务当 DSH 替身，
// 把 DSH_WEB_URL 指过去，长跑才测的是「壳自身稳定性」而不是「DSH 不可达导致的崩溃」。
const STUB_PORT = 9700 + RUN;
const stubServer = http.createServer((_req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end('<!doctype html><meta charset="utf-8"><title>c25a-dsh-stub</title><body>stub</body>');
});
await new Promise((resolve) => stubServer.listen(STUB_PORT, '127.0.0.1', resolve));

// ── 沙盘 ────────────────────────────────────────────────────────────────
fs.rmSync(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
fs.cpSync(path.join(ROOT, '团队'), TEAM, { recursive: true });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(path.join(STATE, '任务'), { recursive: true });
const teamFile = path.join(TEAM, '状态', '团队.json');
const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
team.activeProject = PROJ;
team.members = (team.members || []).map((m) => ({ ...m, sessionId: '' }));
fs.writeFileSync(teamFile, JSON.stringify(team, null, 2), 'utf8');
const projectDir = path.join(SB, '项目', PROJ);
const workbench = path.join(SB, 'workbench.json');
fs.writeFileSync(path.join(STATE, '项目.json'), JSON.stringify({ name: PROJ, mode: 'full', teamMode: 'full', path: projectDir }, null, 2), 'utf8');
fs.writeFileSync(path.join(STATE, '工作流.json'), JSON.stringify({ requirements: {} }, null, 2), 'utf8');
fs.writeFileSync(workbench, JSON.stringify({
  version: 1, activeProjectId: `p-${RUN}`,
  projects: [{ id: `p-${RUN}`, name: PROJ, teamName: PROJ, path: projectDir, workspace: { sessionIds: [] } }],
  ui: {},
}, null, 2), 'utf8');

const crashFile = path.join(STATE, '渲染崩溃.jsonl');
const readRows = () => (fs.existsSync(crashFile) ? fs.readFileSync(crashFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
// c25a ②：--no-wake 的「不写邮箱」要能量化——统计沙盘邮箱里的消息 json 数（跑前基线 → 跑后）
const countMailbox = () => {
  let n = 0;
  const mailRoot = path.join(TEAM, '状态', '邮箱');
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of entries) {
      if (ent.isDirectory()) walk(path.join(dir, ent.name));
      else if (ent.name.endsWith('.json')) n += 1;
    }
  };
  let roles = [];
  try { roles = fs.readdirSync(mailRoot, { withFileTypes: true }).filter((e) => e.isDirectory()); } catch { roles = []; }
  for (const role of roles) walk(path.join(mailRoot, role.name));
  return n;
};
const mailboxCountBefore = countMailbox();

// ── 起实例 ──────────────────────────────────────────────────────────────
const env = {
  ...process.env, AWB_DATA_DIR: DATA, AWB_STORE: workbench,
  DSH_WEB_URL: `http://127.0.0.1:${STUB_PORT}/`,
  TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: path.join(TEAM, '状态', '项目'), TEAM_WORKBENCH_JSON: workbench, TEAM_SELFTEST: '1',
};
const startedAt = new Date();
// 把壳的 stdout/stderr 落本地日志：AC2 要「哪个定时器/事件退的」，必须看 [win-ctl]/[win-close]/[shell-audit] 原文。
const runLogPath = path.join(SB, 'run.log');
const runLog = fs.openSync(runLogPath, 'a');
const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--no-wake', '--remote-debugging-port=' + PORT], { cwd: ROOT, env, stdio: ['ignore', runLog, runLog], windowsHide: false });
let childExit = null;
child.on('exit', (code, signal) => { childExit = { code, signal, at: new Date() }; });

const httpJson = (url) => new Promise((res) => {
  const req = http.get(url, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); });
  req.on('error', () => res(null));
  req.setTimeout(3000, () => { req.destroy(); res(null); });
});

// 等 CDP 起（最多 90s）
let upAt = null;
for (let i = 0; i < 180; i += 1) {
  const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
  if (Array.isArray(list) && list.some((t) => t && t.type === 'page')) { upAt = new Date(); break; }
  if (childExit) break;
  await sleep(500);
}

// 盯到目标时长：期间每 30s 看一次进程是否自行退出
const deadline = Date.now() + MINUTES * 60 * 1000;
let earlyExit = null;
while (Date.now() < deadline) {
  if (childExit) { earlyExit = childExit; break; }
  await sleep(30000);
}
const beforeCloseRows = readRows();
// 到点优雅关闭（若已自行退出则跳过）
let graceful = false;
if (!childExit) {
  const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
  const target = Array.isArray(list) ? list.find((t) => t && t.type === 'page') : null;
  if (target) {
    try {
      const ws = new WebSocket(target.webSocketDebuggerUrl);
      await new Promise((r) => ws.addEventListener('open', r, { once: true }));
      ws.send(JSON.stringify({ id: 1, method: 'Page.close', params: {} }));
      await sleep(2000);
      try { ws.close(); } catch { /* ignore */ }
    } catch { /* 关不掉就强杀，但会标 graceful=false */ }
  }
  for (let i = 0; i < 40; i += 1) { if (childExit) break; await sleep(500); }
  graceful = Boolean(childExit);
  if (!childExit) { try { child.kill(); } catch { /* ignore */ } await sleep(1500); }
}
const endedAt = new Date();
const minutesRan = Number(((endedAt - startedAt) / 60000).toFixed(2));
const rows = readRows();
// c25a ②（PM 2026-11-16 12:07）：30 分钟长跑必须能证明「--no-wake 四不」——
// 邮箱零新增 + 唤醒.jsonl 无新增（或全 suppressed=no-wake），所以把这两组数一起落进证据。
// （countMailbox 已在起进程之前定义并取过基线 mailboxCountBefore）
const wakeFile = path.join(STATE, '唤醒.jsonl');
const wakeRows = (() => {
  try {
    return fs.readFileSync(wakeFile, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
})();
const wakeSuppressedAll = wakeRows.every((row) => String(row && row.suppressed || '') === 'no-wake');
const summary = {
  run: RUN, project: PROJ, startedAt: startedAt.toISOString(), cdpUpAt: upAt ? upAt.toISOString() : '',
  endedAt: endedAt.toISOString(), minutesRan, graceful,
  selfExited: Boolean(earlyExit), exitCode: childExit ? childExit.code : null, exitSignal: childExit ? childExit.signal : null,
  auditRowsBeforeClose: beforeCloseRows.map((r) => r.kind),
  auditRowsAfterClose: rows.map((r) => r.kind),
  crashKinds: rows.map((r) => ({ kind: r.kind, reason: String(r.reason || '').slice(0, 120), stack: String(r.stack || '').slice(0, 300), aliveSec: r.aliveSec })),
  mailboxCount: countMailbox(),
  mailboxNew: countMailbox() - mailboxCountBefore,
  wakeRows: wakeRows.length,
  wakeAllSuppressedNoWake: wakeRows.length ? wakeSuppressedAll : true,
  logFile: runLogPath,
  pass30: minutesRan >= 30,
};
const evidDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-c25a');
fs.mkdirSync(evidDir, { recursive: true });
fs.writeFileSync(path.join(evidDir, `longrun-${RUN}.json`), JSON.stringify(summary, null, 2) + '\n', 'utf8');
console.log(`LONGRUN run=${RUN} minutes=${minutesRan} pass30=${summary.pass30} selfExited=${summary.selfExited} kinds=${summary.auditRowsAfterClose.join('|')}`);
process.exit(0);
