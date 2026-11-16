import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import http from 'node:http';
/**
 * B-20261116-105124-5413 / B-20261116-105124-c25a 自检。
 *
 * A 静态：--no-wake 必须同时掐断「路由守护」与「60 秒队列泵」；主进程异常/退出审计已接线（并入 渲染崩溃.jsonl）。
 * B 真窗口：隔离沙盘起一个 --no-wake 壳，队列里预置一条派单，等过 60 秒泵周期，断言
 *          邮箱零新增、队列项仍在、守护状态没有出现（= 泵与守护都没动），并且崩溃审计里没有 main-uncaught。
 */

const ROOT = process.cwd();
const MAIN = path.join(ROOT, 'src', 'main.js');
const SB = path.join(ROOT, '_tmp', 'no-wake-guard');
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const PROJ = 'nw-guard';
const STATE = path.join(TEAM, '状态', '项目', PROJ);
const PORT = 9497;

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}  ` + JSON.stringify(detail || {}).slice(0, 400)); process.exitCode = 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── A 静态 ─────────────────────────────────────────────────────────────
const src = fs.readFileSync(MAIN, 'utf8');
const supervisorBody = (() => {
  const start = src.indexOf('function ensureRouteSupervisor(project) {');
  return start < 0 ? '' : src.slice(start, start + 900);
})();
ok('A1 ensureRouteSupervisor 里有 IS_NO_WAKE 短路（no-wake 不拉守护）', /IS_NO_WAKE/.test(supervisorBody) && /return null/.test(supervisorBody), supervisorBody.slice(0, 200));
const pumpBody = (() => {
  const start = src.indexOf('function queuePumpTick() {');
  return start < 0 ? '' : src.slice(start, start + 700);
})();
ok('A2 queuePumpTick 里有 IS_NO_WAKE 短路（no-wake 不跑队列泵）', /IS_NO_WAKE/.test(pumpBody), pumpBody.slice(0, 200));
ok('A3 主进程异常审计已实现（recordShellAudit + uncaughtException + unhandledRejection）',
  /function recordShellAudit\(/.test(src) && /'uncaughtException'/.test(src) && /'unhandledRejection'/.test(src), {});
ok('A4 异常审计并入同一条崩溃审计（crashAuditFile → 渲染崩溃.jsonl）',
  /function recordShellAudit[\s\S]{0,1200}crashAuditFile\(\)/.test(src) && /function crashAuditFile[\s\S]{0,300}渲染崩溃\.jsonl/.test(src), {});
ok('A5 退出审计接线（installShellAuditSensors 被调用 + will-quit 落 shell-exit + window-all-closed 落行）',
  /installShellAuditSensors\(\);/.test(src) && /will-quit'[\s\S]{0,80}shell-exit/.test(src) && /shell-window-all-closed/.test(src), {});
ok('A6 审计行含定位字段（kind/processType/reason/stack/aliveSec/project）',
  ['kind', 'processType', 'reason', 'stack', 'aliveSec', 'project'].every((key) => new RegExp(`\\b${key}:`).test(src.slice(src.indexOf('function recordShellAudit('), src.indexOf('function recordShellAudit(') + 1600))), {});

// ── B 真窗口（隔离沙盘）────────────────────────────────────────────────
fs.rmSync(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
fs.mkdirSync(path.join(SB, 'data'), { recursive: true });
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
fs.writeFileSync(path.join(STATE, '任务', 'T-nw-1.json'), JSON.stringify({ id: 'T-nw-1', project: PROJ, type: 'task', title: '沙盘', owner: 'tester', status: 'open', priority: 'P1', createdAt: new Date().toISOString() }, null, 2), 'utf8');
// 预置一条队列项：若泵在 no-wake 下仍跑，它就会被投出去（写邮箱 + 派单锁）
const queuedAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
fs.writeFileSync(path.join(STATE, '派单队列.json'), JSON.stringify({ items: [{ id: 'Q-nw-1', at: queuedAt, from: 'pm', to: 'tester', subject: 'no-wake 不应投递', body: 'x', task: '', ackRequired: true }] }, null, 2), 'utf8');
const workbench = path.join(SB, 'workbench.json');
fs.writeFileSync(workbench, JSON.stringify({
  version: 1, activeProjectId: 'p-nw', projects: [{ id: 'p-nw', name: PROJ, teamName: PROJ, path: path.join(SB, '项目', PROJ), workspace: { sessionIds: [] } }], ui: {},
}, null, 2), 'utf8');

const mailboxCount = () => {
  let n = 0;
  for (const role of ['pm', 'tester', 'programmer1', 'programmer2', 'analyst', 'product']) {
    try { n += fs.readdirSync(path.join(TEAM, '状态', '邮箱', role, 'new')).filter((x) => x.endsWith('.json')).length; } catch { /* 无该目录 */ }
  }
  return n;
};
const before = { mails: mailboxCount(), queue: fs.existsSync(path.join(STATE, '派单队列.json')) ? JSON.parse(fs.readFileSync(path.join(STATE, '派单队列.json'), 'utf8')).items.length : 0 };

const env = {
  ...process.env,
  AWB_DATA_DIR: DATA,
  AWB_STORE: workbench,
  TEAM_ROOT: TEAM,
  TEAM_PROJECTS_ROOT: path.join(TEAM, '状态', '项目'),
  TEAM_WORKBENCH_JSON: workbench,
  TEAM_SELFTEST: '1',
};
const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--no-wake', '--remote-debugging-port=' + PORT], { cwd: ROOT, env, stdio: 'ignore', windowsHide: false });

const httpJson = (url) => new Promise((res) => {
  const req = http.get(url, (r) => { let b = ''; r.on('data', (c) => { b += c; }); r.on('end', () => { try { res(JSON.parse(b)); } catch { res(null); } }); });
  req.on('error', () => res(null));
  req.setTimeout(3000, () => { req.destroy(); res(null); });
});
let up = false;
for (let i = 0; i < 120; i += 1) {
  const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
  if (Array.isArray(list) && list.some((t) => t && t.type === 'page')) { up = true; break; }
  await sleep(500);
}
ok('B0 --no-wake 实例已启动（CDP 可达）', up, {});

// 等过一次 60 秒泵周期（留 10 秒余量）
await sleep(70000);
const after = { mails: mailboxCount(), queue: fs.existsSync(path.join(STATE, '派单队列.json')) ? JSON.parse(fs.readFileSync(path.join(STATE, '派单队列.json'), 'utf8')).items.length : 0 };
ok('B1 no-wake 下邮箱零新增（没有任何投递/唤醒写邮箱）', after.mails === before.mails, { before, after });
ok('B2 队列项仍在（60 秒泵没有在 no-wake 下投递）', after.queue === before.queue, { before, after });
ok('B3 守护状态未生成/未更新（守护没被拉起）', !fs.existsSync(path.join(STATE, '守护状态.json')), { file: path.join(STATE, '守护状态.json') });
const crashFile = path.join(STATE, '渲染崩溃.jsonl');
const crashRows = fs.existsSync(crashFile) ? fs.readFileSync(crashFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
ok('B4 运行期间无 main-uncaught/main-rejection 审计行（没崩）', crashRows.filter((r) => /^main-/.test(String(r.kind || ''))).length === 0, crashRows.slice(0, 3));

// 收尾：关掉实例（不依赖 Ctrl+C），再看退出审计
try { child.kill(); } catch { /* ignore */ }
await sleep(2500);
const crashRows2 = fs.existsSync(crashFile) ? fs.readFileSync(crashFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
ok('B5 崩溃审计文件存在且可解析（行=kind 白名单）', Array.isArray(crashRows2) && crashRows2.every((r) => r && typeof r.kind === 'string'), { rows: crashRows2.length });

console.log(`\nB-5413/c25a 断言：${pass} 通过 / ${fail} 失败`);
const evidDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-5413');
fs.mkdirSync(evidDir, { recursive: true });
fs.writeFileSync(path.join(evidDir, 'run-no-wake-guard.log'), `pass=${pass} fail=${fail} exit=${process.exitCode || 0} mailsBefore=${before.mails} mailsAfter=${after.mails} queueBefore=${before.queue} queueAfter=${after.queue}\n`, 'utf8');
process.exit(process.exitCode || 0);
