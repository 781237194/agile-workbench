/**
 * c25a ②自检：**自检型退出（app.exit）也必须留下审计行**。
 *
 * 背景（PM 2026-11-16 13:06）：app.exit() 绕过 before-quit/will-quit，退出码会「零审计行」，
 * 正是「壳提前退出但审计无记录」的候选路径。修复后所有调用改走 exitWithAudit()，
 * 先写 shell-exit-code（含退出码与来源）再 app.exit。
 *
 * 本用例用 `--theme-shots`（最轻的自检模式，约 30 秒）验证：
 *   ① 沙盘 渲染崩溃.jsonl 里必须有 kind=shell-exit-code 的行；
 *   ② 该行 exitCode 是数字，reason 非空；
 *   ③ 同时仍有 shell-quit 行（正常收尾链没被破坏）。
 *
 * 跑法：node scripts/test-exit-audit-code.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const ROOT = process.cwd();
const SB = path.join(ROOT, '_tmp', 'c25a-exitcode-selftest');
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const PROJ = 'c25a-exitcode';
const STATE = path.join(TEAM, '状态', '项目', PROJ);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}  ` + JSON.stringify(detail || {}).slice(0, 400)); process.exitCode = 1; }
}

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
  version: 1, activeProjectId: 'p-exitcode',
  projects: [{ id: 'p-exitcode', name: PROJ, teamName: PROJ, path: projectDir, workspace: { sessionIds: [] } }],
  ui: {},
}, null, 2), 'utf8');

const env = {
  ...process.env,
  AWB_DATA_DIR: DATA, AWB_STORE: workbench,
  TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: path.join(TEAM, '状态', '项目'),
  TEAM_WORKBENCH_JSON: workbench, TEAM_SELFTEST: '1',
  AWB_THEME_DATA: path.join(SB, 'theme-data'),
};
const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--theme-shots'], { cwd: ROOT, env, stdio: 'ignore' });
let exit = null;
child.on('exit', (code, signal) => { exit = { code, signal }; });
for (let i = 0; i < 240 && !exit; i += 1) await sleep(500);

const crashFile = path.join(STATE, '渲染崩溃.jsonl');
const rows = fs.existsSync(crashFile)
  ? fs.readFileSync(crashFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
  : [];
const codeRow = rows.find((r) => String(r.kind || '') === 'shell-exit-code');
const quitRow = rows.find((r) => String(r.kind || '') === 'shell-quit');

ok('X1 --theme-shots 进程已结束（拿得到退出码）', Boolean(exit), { exit });
ok('X2 自检型退出写入了 shell-exit-code 行（修复前为 0 行）', Boolean(codeRow), { kinds: rows.map((r) => r.kind) });
ok('X3 shell-exit-code 行带数字 exitCode 与非空 reason', Boolean(codeRow) && typeof codeRow.exitCode === 'number' && String(codeRow.reason || '').length > 0, { codeRow });
ok('X4 同一轮仍有 shell-quit 行（正常收尾链未被破坏）', Boolean(quitRow), { quitRow });

console.log(`\nc25a ②自检（自检型退出必有审计行）：${pass} 通过 / ${fail} 失败`);
const evidDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-c25a');
fs.mkdirSync(evidDir, { recursive: true });
fs.writeFileSync(path.join(evidDir, 'run-exitcode.log'), `pass=${pass} fail=${fail} exit=${process.exitCode || 0} exitCode=${exit ? exit.code : 'null'} kinds=${rows.map((r) => r.kind).join('|')}\n`, 'utf8');
process.exit(process.exitCode || 0);
