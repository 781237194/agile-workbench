'use strict';
const { rmSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/**
 * B-20261116-092803-8181 断言：team.mjs task show 不再恒抛 INTERNAL。
 *   AC1 存在任务可读（--json 时 stdout 恰好一行 JSON）；AC2 不存在 → TASK_NOT_FOUND（不是 INTERNAL）；
 *   附带：缺 --id → BAD_ID；task list 不受影响（回归）。
 * 沙盘：复制真实 团队 -> _tmp/taskshow/团队（清 sessionId、去锁/邮箱），TEAM_SELFTEST=1，不碰真实状态。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TEAM_MJS = path.join(ROOT, '团队', '工具', 'team.mjs');
const SB = path.join(ROOT, '_tmp', 'taskshow');
const TEAM = path.join(SB, '团队');
const PROJECT = '工作台改造修复';
const TASKS = path.join(TEAM, '状态', '项目', PROJECT, '任务');

let pass = 0; let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}  ${JSON.stringify(detail).slice(0, 400)}`); process.exitCode = 1; }
}
function env() { return { ...process.env, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: path.join(TEAM, '状态', '项目'), TEAM_SELFTEST: '1' }; }
function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [TEAM_MJS, ...args], { env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}
function lines(s) { return String(s || '').replace(/\r/g, '').trimEnd().split('\n').filter((x) => x !== ''); }

// —— 沙盘 ——
rmSandbox(SB, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
fs.cpSync(path.join(ROOT, '团队'), TEAM, {
  recursive: true,
  filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) && !/[\\/]邮箱[\\/]/.test(src) && !/[\\/]\.git([\\/]|$)/.test(src),
});
const teamFile = path.join(TEAM, '状态', '团队.json');
const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
for (const m of team.members || []) m.sessionId = '';   // 沙盘绝不能带真实 sessionId（B-3c03 教训）
team.activeProject = PROJECT;
fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');

const boot = run(['boot', '--role', 'programmer2', '--project', PROJECT, '--session', 'taskshow-test']);
const token = (boot.stdout.match(/令牌[:：]\s*([a-f0-9]+)/i) || [])[1] || '';
ok('S0 沙盘 boot 拿到令牌', Boolean(token), { code: boot.code, head: boot.stdout.slice(0, 120) });
if (!token) { console.log('\n沙盘 boot 失败，后续断言无法执行'); process.exit(1); }

const allIds = fs.readdirSync(TASKS).filter((f) => f.endsWith('.json')).map((f) => f.replace(/\.json$/, ''));
const bugId = (() => {
  for (const id of allIds) {
    try { const t = JSON.parse(fs.readFileSync(path.join(TASKS, id + '.json'), 'utf8')); if (t.type === 'bug') return id; } catch { /* 跳过坏文件 */ }
  }
  return allIds[0];
})();
ok('S1 沙盘里存在可测任务', Boolean(bugId), { tasks: allIds.length });

// —— AC1-1：存在任务可读（非 json 格式化 JSON） ——
const r1 = run(['task', 'show', '--project', PROJECT, '--boot', token, '--id', bugId]);
let parsed1 = null;
try { parsed1 = JSON.parse(r1.stdout); } catch { parsed1 = null; }
ok('AC1① 存在任务：退出码 0', r1.code === 0, { code: r1.code, stderr: r1.stderr.slice(0, 200) });
ok('AC1② 存在任务：stdout 是可解析的任务 JSON 且 id 命中', Boolean(parsed1) && parsed1.id === bugId, { id: parsed1 && parsed1.id, want: bugId });
ok('AC1③ 存在任务：不再出现 INTERNAL', !/INTERNAL|is not defined/.test(r1.stdout + r1.stderr), { err: r1.stderr.slice(0, 200) });

// —— AC1-2：--json 恰好一行 ——
const r2 = run(['task', 'show', '--project', PROJECT, '--boot', token, '--id', bugId, '--json']);
let parsed2 = null;
try { parsed2 = JSON.parse(r2.stdout.trim()); } catch { parsed2 = null; }
ok('AC1④ --json：退出码 0', r2.code === 0, { code: r2.code, stderr: r2.stderr.slice(0, 200) });
ok('AC1⑤ --json：stdout 恰好一行', lines(r2.stdout).length === 1 && r2.stdout.includes('\n'), { lines: lines(r2.stdout).length });
ok('AC1⑥ --json：结构为 {ok:true,task} 且 task.id 命中', Boolean(parsed2) && parsed2.ok === true && parsed2.task && parsed2.task.id === bugId, parsed2 && { ok: parsed2.ok, id: parsed2.task && parsed2.task.id });

// —— AC2：任务不存在 → TASK_NOT_FOUND，不是 INTERNAL ——
const missingId = 'T-20261101-000000-zzzz';
const r3 = run(['task', 'show', '--project', PROJECT, '--boot', token, '--id', missingId]);
const flat3 = r3.stdout + r3.stderr;
ok('AC2① 不存在：退出码非 0', r3.code !== 0, { code: r3.code });
ok('AC2② 不存在：明确码 TASK_NOT_FOUND', /TASK_NOT_FOUND/.test(flat3), { head: flat3.slice(0, 200) });
ok('AC2③ 不存在：不是 INTERNAL / 不是 ReferenceError', !/INTERNAL|is not defined/.test(flat3), { head: flat3.slice(0, 200) });
ok('AC2④ 不存在：错误信息里带上了请求的任务 id', flat3.includes(missingId), { head: flat3.slice(0, 200) });

// —— 附带：缺 --id → BAD_ID ——
const r4 = run(['task', 'show', '--project', PROJECT, '--boot', token]);
const flat4 = r4.stdout + r4.stderr;
ok('A1 缺 --id：返回 BAD_ID 而非 INTERNAL', r4.code !== 0 && /BAD_ID/.test(flat4) && !/INTERNAL/.test(flat4), { code: r4.code, head: flat4.slice(0, 200) });

// —— 回归：task list 仍可用 ——
const r5 = run(['task', 'list', '--project', PROJECT, '--boot', token]);
ok('R1 回归：task list 仍可用（退出码 0）', r5.code === 0 && /任务（/.test(r5.stdout), { code: r5.code, head: r5.stdout.slice(0, 120) });

console.log(`\nB-8181 断言：${pass} 通过 / ${fail} 失败`);
const evidDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-8181');
fs.mkdirSync(evidDir, { recursive: true });
fs.writeFileSync(path.join(evidDir, 'run-8181.log'), `task=${bugId} pass=${pass} fail=${fail} exit=${process.exitCode || 0}\n`, 'utf8');
