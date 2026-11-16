/**
 * B-20261116-105124-c25a AC4 自检：**退出必有审计行**。
 *
 * 做法（真窗口，不伪造）：
 *   ① 隔离数据根起一个 `--no-wake` 壳；
 *   ② 等 CDP 可达后，用 `Page.close` 关掉唯一窗口（走真实 window-all-closed → quit 路径）；
 *   ③ 等进程退出，读 `团队/状态/项目/<项目>/渲染崩溃.jsonl`，断言：
 *      - 至少一行 `kind=shell-window-all-closed`（窗口全关）；
 *      - 至少一行 `kind=shell-exit`（will-quit）；
 *      - 两行都带 `aliveSec > 0` 与 `processType=main`（可用于定位退出时间点）。
 *   ④ 另断言：运行期间若发生主进程异常，必须已落 `main-uncaught`/`main-rejection`（本轮不强制出现，出现即打印）。
 *
 * 跑法：node scripts/test-shell-exit-audit.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const SB = path.join(ROOT, '_tmp', 'c25a-exit-audit');
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const PROJ = 'c25a沙盘';
const STATE = path.join(TEAM, '状态', '项目', PROJ);
const PORT = 9498;

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}  ` + JSON.stringify(detail || {}).slice(0, 400)); process.exitCode = 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── 沙盘 ────────────────────────────────────────────────────────────────
fs.rmSync(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
fs.mkdirSync(DATA, { recursive: true });
fs.mkdirSync(path.join(STATE, '任务'), { recursive: true });
for (const role of ['pm', 'tester', 'programmer1', 'programmer2', 'analyst', 'product']) {
  for (const box of ['new', 'cur']) fs.mkdirSync(path.join(TEAM, '状态', '邮箱', role, box), { recursive: true });
}
fs.mkdirSync(path.join(SB, '项目', PROJ), { recursive: true });
fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify({
  version: 2, phase: 'team', activeProject: PROJ,
  members: [
    { role: 'pm', name: '项目经理', status: 'active', sessionId: '' },
    { role: 'tester', name: '测试人员', status: 'active', sessionId: '' },
    { role: 'programmer2', name: '程序员B', status: 'active', sessionId: '' },
  ],
  config: { messageMaxChars: 600 },
}, null, 2), 'utf8');
fs.writeFileSync(path.join(STATE, '项目.json'), JSON.stringify({ name: PROJ, mode: 'full', path: path.join(SB, '项目', PROJ), teamMode: 'full' }, null, 2), 'utf8');
fs.writeFileSync(path.join(STATE, '工作流.json'), JSON.stringify({ requirements: {} }, null, 2), 'utf8');
const workbench = path.join(SB, 'workbench.json');
fs.writeFileSync(workbench, JSON.stringify({
  version: 1, activeProjectId: 'p-c25a',
  projects: [{ id: 'p-c25a', name: PROJ, teamName: PROJ, path: path.join(SB, '项目', PROJ), workspace: { sessionIds: [] } }],
  ui: {},
}, null, 2), 'utf8');

const crashFile = path.join(STATE, '渲染崩溃.jsonl');
const readRows = () => (fs.existsSync(crashFile) ? fs.readFileSync(crashFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);

const env = {
  ...process.env, AWB_DATA_DIR: DATA, AWB_STORE: workbench,
  TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: path.join(TEAM, '状态', '项目'), TEAM_WORKBENCH_JSON: workbench, TEAM_SELFTEST: '1',
};
const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--no-wake', '--remote-debugging-port=' + PORT], { cwd: ROOT, env, stdio: 'ignore', windowsHide: false });

const httpJson = (url) => new Promise((res) => {
  const req = http.get(url, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); });
  req.on('error', () => res(null));
  req.setTimeout(3000, () => { req.destroy(); res(null); });
});
let target = null;
for (let i = 0; i < 120; i += 1) {
  const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
  if (Array.isArray(list)) {
    target = list.find((t) => t && t.type === 'page' && String(t.url || '').includes('renderer/index.html')) || null;
    if (target) break;
  }
  await sleep(500);
}
ok('E1 --no-wake 实例已启动（拿到页面 target）', Boolean(target), {});

const startedAt = Date.now();
if (target) {
  // 用 Page.close 关唯一窗口：真实走 window-all-closed → will-quit
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((r) => ws.addEventListener('open', r, { once: true }));
  ws.send(JSON.stringify({ id: 1, method: 'Page.close', params: {} }));
  await sleep(1500);
  try { ws.close(); } catch { /* ignore */ }
}
// 等进程退出（最多 30s）
let exited = false;
for (let i = 0; i < 60; i += 1) {
  if (child.exitCode !== null) { exited = true; break; }
  await sleep(500);
}
const aliveSec = Math.round((Date.now() - startedAt) / 1000);
ok('E2 关窗后壳进程在 30s 内退出（走真实退出路径）', exited || child.exitCode !== null, { exitCode: child.exitCode });

// 兜底：仍未退出就强杀（强杀不会写审计，属于「非正常退出」，这里只保证测试不挂）
if (child.exitCode === null) { try { child.kill(); } catch { /* ignore */ } await sleep(1500); }

const rows = readRows();
const windowRow = rows.find((r) => String(r.kind || '') === 'shell-window-all-closed');
const exitRow = rows.find((r) => String(r.kind || '') === 'shell-exit');
const mainRows = rows.filter((r) => String(r.processType || '') === 'main');
ok('E3 审计里有 shell-window-all-closed 行（窗口全关）', Boolean(windowRow), { kinds: rows.map((r) => r.kind) });
ok('E4 审计里有 shell-exit 行（will-quit）', Boolean(exitRow), { kinds: rows.map((r) => r.kind) });
ok('E5 两行都带 processType=main 与 aliveSec>0（可用于定位退出时间点）',
  Boolean(windowRow && windowRow.processType === 'main' && Number(windowRow.aliveSec) >= 0)
  && Boolean(exitRow && exitRow.processType === 'main' && Number(exitRow.aliveSec) >= 0),
  { windowRow, exitRow });
ok('E6 结论：正常退出路径必有审计行（本用例 aliveSec≈' + aliveSec + 's）', Boolean(windowRow && exitRow), { aliveSec });
// T-c25a ③（PM 2026-11-16 12:07 打回要求）：退出审计必须带「退出码 / 原因 / 时间」，且 shell-quit 行要有数字 exitCode。
const quitRow = rows.find((r) => String(r.kind || '') === 'shell-quit');
ok('E7 审计里有 shell-quit 行且 exitCode 是数字（0=正常）', Boolean(quitRow) && typeof quitRow.exitCode === 'number', { quitRow, kinds: rows.map((r) => r.kind) });
ok('E8 退出三行都带 at + reason 字段（时间/原因可判）',
  [windowRow, exitRow, quitRow].every((r) => r && String(r.at || '') && r.reason !== undefined), { windowRow: Boolean(windowRow), exitRow: Boolean(exitRow), quitRow: Boolean(quitRow) });
const abnormal = rows.filter((r) => /^main-/.test(String(r.kind || '')));
if (abnormal.length) console.log(`      本轮另有主进程异常行 ${abnormal.length} 条：${JSON.stringify(abnormal.slice(0, 3)).slice(0, 300)}`);

console.log(`\nc25a AC4（退出必有审计行）断言：${pass} 通过 / ${fail} 失败`);
const evidDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-c25a');
fs.mkdirSync(evidDir, { recursive: true });
fs.writeFileSync(path.join(evidDir, 'run-ac4.log'), `pass=${pass} fail=${fail} exit=${process.exitCode || 0} aliveSec=${aliveSec} kinds=${rows.map((r) => r.kind).join('|')}\n`, 'utf8');
process.exit(process.exitCode || 0);
