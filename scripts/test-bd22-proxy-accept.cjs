'use strict';
const { rmSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/**
 * B-20261116-105213-bd22 自检：需求验收只能 Owner 本人（代管不得代需求验收）。
 *
 * 四条（对齐派单）：
 *   ① 有代管时 PM 代需求验收 → PROXY_ACCEPT_FORBIDDEN（文案含「需求验收只能 Owner 本人」）
 *   ② 无代管时同样拒 → PROXY_ACCEPT_FORBIDDEN
 *   ③ Owner 本人通道照旧：owner --action accept 不被新门挡（走到 Owner 确认码这步 → OWNER_CONFIRM_REQUIRED）
 *   ④ 缺陷验收不受影响：task accept --as pm 照旧可用
 *
 * 隔离：复制 团队/ 到 _tmp/bd22-proxy-accept，TEAM_ROOT/TEAM_PROJECTS_ROOT 指沙盘，TEAM_SELFTEST=1。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', 'bd22-proxy-accept');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TEAM_TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = 'bd22沙盘';
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 300)}`);
  if (!ok) process.exitCode = 1;
}
function run(args, { allowFail = false } = {}) {
  try {
    const out = execFileSync(process.execPath, [TEAM_TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
    const text = String(out).trim();
    return JSON.parse(text.slice(text.indexOf('{')));
  } catch (e) {
    const text = String((e && e.stdout) || '') + String((e && e.stderr) || '');
    if (allowFail) { try { return JSON.parse(text.slice(text.indexOf('{'))); } catch { return { ok: false, raw: text.slice(0, 400) }; } }
    throw e;
  }
}

// ── 沙盘 ────────────────────────────────────────────────────────────────
rmSandbox(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true });
const addRes = run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
const projectPath = addRes.project.path;
const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'bd22-pm', '--json']);
const prod = run(['boot', '--role', 'product', '--project', PROJECT, '--session', 'bd22-prod', '--json']);

// lessons 门禁：直接写「PM 已读当前版本」台账（否则所有 owner proxy decide 都被 LESSONS_UNREAD 挡住）
const lessonsFile = path.join(projectPath, '经验教训登记册.md');
if (!fs.existsSync(lessonsFile)) {
  fs.mkdirSync(path.dirname(lessonsFile), { recursive: true });
  fs.writeFileSync(lessonsFile, '# 经验教训登记册（沙盘）\n\n## 程序员B\n\n| 日期 | 场景 | 教训 | 下次怎么做 |\n|---|---|---|---|\n', 'utf8');
}
{
  const lessonsSha = crypto.createHash('sha256').update(fs.readFileSync(lessonsFile)).digest('hex');
  const readLog = path.join(TEAM_ROOT, '状态', '经验教训阅读.jsonl');
  fs.mkdirSync(path.dirname(readLog), { recursive: true });
  fs.appendFileSync(readLog, JSON.stringify({ at: new Date().toISOString(), role: 'pm', sessionId: 'bd22-pm', fileSha: lessonsSha, entries: 0, source: 'sandbox-seed' }) + '\n', 'utf8');
}

const mkReq = (title) => run(['req', 'create', '--boot', pm.token, '--project', PROJECT, '--title', title, '--priority', 'P0', '--acceptance', 'AC1', '--json']).requirement.id;
const idA = mkReq('bd22 需求A');
const idB = mkReq('bd22 需求B');
for (const id of [idA, idB]) {
  run(['req', 'review', '--boot', prod.token, '--project', PROJECT, '--id', id, '--verdict', 'approve', '--kind', 'requirement', '--comments', '沙盘', '--channel', 'ui', '--json'], { allowFail: true });
}
const evidenceArgs = ['--evidence', '测试人员/产出/T-bd22-报告.md:report'];
fs.mkdirSync(path.join(projectPath, '测试人员', '产出'), { recursive: true });
fs.writeFileSync(path.join(projectPath, '测试人员', '产出', 'T-bd22-报告.md'), '# 测试报告\nPASS\n', 'utf8');
fs.writeFileSync(path.join(projectPath, '测试人员', '产出', 'T-bd22-截图.png'), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), 'binary');

// ── ② 无代管时拒 ───────────────────────────────────────────────────────
const noProxy = run(['owner', 'proxy', 'decide', '--project', PROJECT, '--requirement', idA, '--decision', 'accepted', '--action', 'accept', '--opinion', '代验收', '--channel', 'ui', '--json'], { allowFail: true });
check('② 无代管时代需求验收 → PROXY_ACCEPT_FORBIDDEN', noProxy.ok === false && noProxy.code === 'PROXY_ACCEPT_FORBIDDEN', noProxy);
check('② 文案：需求验收只能 Owner 本人', String(noProxy.message || '').includes('需求验收只能 Owner 本人'), noProxy.message);

// ── ① 有代管时也拒 ─────────────────────────────────────────────────────
const start = run(['owner', 'proxy', 'start', '--project', PROJECT, '--scope', 'all', '--authorization', 'Owner 2026-11-16 10:52 原文：需求必须由我验收', '--json'], { allowFail: true });
check('① 代管已开启（前置）', start.ok === true, start);
const withProxy = run(['owner', 'proxy', 'decide', '--project', PROJECT, '--requirement', idA, '--decision', 'accepted', '--action', 'accept', ...evidenceArgs, '--opinion', '代验收', '--channel', 'ui', '--json'], { allowFail: true });
check('① 有代管时代需求验收 → PROXY_ACCEPT_FORBIDDEN', withProxy.ok === false && withProxy.code === 'PROXY_ACCEPT_FORBIDDEN', withProxy);

// 零写入：工作流里该需求没被推成 accepted、也没有 proxy 决定
const wfFile = path.join(TEAM_ROOT, '状态', '项目', PROJECT, '工作流.json');
const rowA = (JSON.parse(fs.readFileSync(wfFile, 'utf8')).requirements || {})[idA] || {};
check('① 零写入：status 未被推成 accepted、无 channel=proxy 的决定',
  String(rowA.status) !== 'accepted' && !(rowA.decisions || []).some((row) => String(row.channel || '') === 'proxy'),
  { status: rowA.status, decisions: (rowA.decisions || []).length });

// ── ③ Owner 本人通道照旧（不被新门挡）──────────────────────────────────
const ownerAccept = run(['owner', '--project', PROJECT, '--requirement', idA, '--action', 'accept', '--decision', 'accepted', ...evidenceArgs, '--opinion', 'Owner 验收', '--channel', 'ui', '--json'], { allowFail: true });
check('③ Owner 本人验收不被新门挡（错误码不是 PROXY_ACCEPT_FORBIDDEN，而是走到后续门）',
  ownerAccept.ok === true || ['OWNER_CONFIRM_REQUIRED', 'REQUIREMENT_STATE_INVALID', 'TEST_NOT_DONE'].includes(String(ownerAccept.code)),
  { code: ownerAccept.code, ok: ownerAccept.ok });

// ── ④ 缺陷验收不受影响（task accept --as pm）────────────────────────────
const bug = run(['task', 'create', '--boot', pm.token, '--project', PROJECT, '--title', 'bd22 缺陷单', '--priority', 'P1', '--type', 'bug', '--acceptance', 'AC1', '--repro', '沙盘复现步骤', '--detail', '沙盘', '--json'], { allowFail: true });
check('④ 缺陷单已建（前置）', bug.ok !== false, bug);
const bugId = (bug.task && bug.task.id) || bug.id || '';
if (bugId) {
  // 任务先 claim 再 done，才能走验收
  run(['task', 'claim', '--boot', pm.token, '--project', PROJECT, '--id', bugId, '--json'], { allowFail: true });
  run(['task', 'done', '--boot', pm.token, '--project', PROJECT, '--id', bugId, '--evidence', '测试人员/产出/T-bd22-报告.md', '--result', '沙盘缺陷修复完成', '--json'], { allowFail: true });
  const defectAccept = run(['task', 'accept', '--boot', pm.token, '--project', PROJECT, '--task', bugId, '--as', 'pm', '--decision', 'accepted', '--opinion', '沙盘缺陷验收', '--evidence', '测试人员/产出/T-bd22-报告.md:report', '--evidence', '测试人员/产出/T-bd22-截图.png:screenshot', '--json'], { allowFail: true });
  check('④ 缺陷验收 task accept --as pm 照旧可用（不要求代管）', defectAccept.ok === true, { code: defectAccept.code, ok: defectAccept.ok });
} else {
  check('④ 缺陷验收 task accept --as pm 照旧可用（不要求代管）', false, bug);
}

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\nB-bd22 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
const evidDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-bd22');
fs.mkdirSync(evidDir, { recursive: true });
fs.writeFileSync(path.join(evidDir, 'run-bd22.log'), `pass=${passed} fail=${failed} exit=${process.exitCode || 0}\n`, 'utf8');
