'use strict';
/** B-155a 回归：幽灵需求登记/作废 + 同步规则（面板缓存行必须能在工作流里对上或被作废登记）。 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', 'b-155a');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = '幽灵沙盘';
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 260)}`);
  if (!ok) process.exitCode = 1;
}
function run(args, allowFail = false) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
    const t = String(out).trim();
    return JSON.parse(t.slice(t.indexOf('{')));
  } catch (e) {
    const text = String((e && e.stdout) || '') + String((e && e.stderr) || '');
    if (allowFail) { try { return JSON.parse(text.slice(text.indexOf('{'))); } catch { return { ok: false, raw: text.slice(0, 200) }; } }
    throw e;
  }
}
fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true, filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) });
const proj = run(['project', 'add', '--name', PROJECT, '--team-mode', 'fast', '--json']).project;
const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-pm', '--json']);
const stateDir = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
const wfFile = path.join(stateDir, '工作流.json');
const readWf = () => (fs.existsSync(wfFile) ? JSON.parse(fs.readFileSync(wfFile, 'utf8')) : { requirements: {} });
const rowsOf = () => readWf().requirements || {};

// 幽灵 id（只存在于“本地缓存”，工作流没有）
const ghost1 = 'R-20261113-015208-ba18';
const ghost2 = 'R-20261114-144138-550f';

// ① 登记前：工作流 0 行、两个都是幽灵
check('① 登记前工作流无这两条', !rowsOf()[ghost1] && !rowsOf()[ghost2], Object.keys(rowsOf()).length);

// ② register 幽灵1 → 工作流 review + 任务文件
const reg = run(['req', 'register', '--boot', pm.token, '--project', PROJECT, '--id', ghost1, '--title', '敏捷并行协同', '--json'], true);
check('② register 成功且 status=review', reg.ok === true && reg.status === 'review' && rowsOf()[ghost1] && String(rowsOf()[ghost1].status) === 'review', { ok: reg.ok, code: reg.code, row: rowsOf()[ghost1] && rowsOf()[ghost1].status });
check('② 生成需求任务文件', fs.existsSync(path.join(stateDir, '任务', `${ghost1}.json`)), '');
const dup = run(['req', 'register', '--boot', pm.token, '--project', PROJECT, '--id', ghost1, '--title', 'x', '--json'], true);
check('② 重复 register → ALREADY_REGISTERED 且零副作用', dup.ok === false && dup.code === 'ALREADY_REGISTERED', dup.code);

// ③ void 幽灵2（工作流无此行）→ 只登记作废
const voidOnly = run(['req', 'void', '--boot', pm.token, '--project', PROJECT, '--id', ghost2, '--reason', '11-14 需求池录入未登记工作流', '--json'], true);
check('③ 无工作流行也能作废（status=voided）', voidOnly.ok === true && voidOnly.status === 'voided' && voidOnly.hadWorkflowRow === false, { ok: voidOnly.ok, code: voidOnly.code, status: voidOnly.status });
const registry = path.join(SB, '需求', '作废登记.jsonl');
check('③ 作废写入 需求/作废登记.jsonl', fs.existsSync(registry) && fs.readFileSync(registry, 'utf8').includes(ghost2), registry);

// ④ void 已登记的需求 → 工作流置 terminated + 幂等
const voidRow = run(['req', 'void', '--boot', pm.token, '--project', PROJECT, '--id', ghost1, '--reason', '测试作废', '--json'], true);
check('④ 有工作流行作废 → status=terminated', voidRow.ok === true && voidRow.status === 'terminated' && String(rowsOf()[ghost1].status) === 'terminated', { ok: voidRow.ok, row: rowsOf()[ghost1] && rowsOf()[ghost1].status });
const voidAgain = run(['req', 'void', '--boot', pm.token, '--project', PROJECT, '--id', ghost1, '--reason', '再作废', '--json'], true);
check('④ 重复作废 → ALREADY_VOIDED', voidAgain.ok === false && voidAgain.code === 'ALREADY_VOIDED', voidAgain.code);

// ⑤ 同步规则：作废登记里的 id 或 工作流里的 id 必须覆盖所有“缓存行”（本沙盘用两个幽灵 + 一条正常需求模拟）
const normal = run(['req', 'create', '--boot', pm.token, '--project', PROJECT, '--title', '正常需求', '--priority', 'P2', '--acceptance', 'AC', '--json']).requirement;
const cacheIds = [normal.id, ghost1, ghost2];
const wfIds = new Set(Object.keys(rowsOf()).concat(Object.values(rowsOf()).map((r) => String(r.id || ''))));
const voidIds = new Set(fs.readFileSync(registry, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l).requirementId; } catch { return ''; } }));
// 登记口径：在工作流里、或有需求任务文件（req create/register 都会落任务文件）、或在作废登记里。
const hasTask = (id) => fs.existsSync(path.join(stateDir, '任务', id + '.json'));
const unresolved = cacheIds.filter((id) => !wfIds.has(id) && !voidIds.has(id) && !hasTask(id));
check('⑤ 同步规则：每条缓存行要么在工作流、要么在作废登记（未解决=0）', unresolved.length === 0, unresolved);
check('⑤ 作废登记含两条幽灵', voidIds.has(ghost1) && voidIds.has(ghost2), [...voidIds]);

// ⑥ 规则守卫：register 拒绝非法 id 形态
const badId = run(['req', 'register', '--boot', pm.token, '--project', PROJECT, '--id', 'R-bad', '--title', 'x', '--json'], true);
check('⑥ 非法 id → BAD_ID', badId.ok === false && badId.code === 'BAD_ID', badId.code);

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\nB-155a 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
fs.writeFileSync(path.join(SB, 'run-b-155a.json'), JSON.stringify({ passed, failed, results }, null, 2) + '\n', 'utf8');
