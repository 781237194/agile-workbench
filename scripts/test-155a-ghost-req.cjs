'use strict';
/**
 * B-155a / B-a17d 回归：幽灵需求（工作流没有行的需求）的登记 / 作废 / 同步。
 *
 * 覆盖（任务 B-20261115-045103-a17d）：
 *   AC1 作废登记有消费者：readWorkflowSnapshot 剔除已作废 id，且不得用需求任务文件把同 id 造回 review；
 *   AC2 批量入口：req register / req void 支持 --ids 与 --from-file（一条命令处理多条）；
 *   AC3 双向同步断言：req sync 的 0 违规 + 壳层与团队工具读同一份登记；
 *   AC5 落点：<项目根>/需求/作废登记.jsonl（带 project 字段），不落仓库根、不污染 git status。
 *
 * 沙盘：_tmp/b-155a，TEAM_ROOT + TEAM_PROJECTS_ROOT 双隔离 + TEAM_SELFTEST=1 + 清空 sessionId（B-3c03）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
// B-20261116-055303-07b6：沙盘统一入口（唯一临时目录 + 退出清理）
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));
const SB = mkTempSandbox('b-155a');
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
const readJsonl = (file) => (fs.existsSync(file)
  ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
  : []);

fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true, filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) });
// 沙盘绝不能带真实 sessionId（B-3c03：否则 send/唤醒会打到真实会话）
const teamFile = path.join(TEAM_ROOT, '状态', '团队.json');
const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
for (const member of team.members || []) member.sessionId = '';
team.activeProject = '';
fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');

const proj = run(['project', 'add', '--name', PROJECT, '--team-mode', 'fast', '--json']).project;
const projectDir = String(proj.path || '');
const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-pm', '--json']);
const stateDir = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
const wfFile = path.join(stateDir, '工作流.json');
const taskFile = (id) => path.join(stateDir, '任务', `${id}.json`);
const registryFile = path.join(projectDir, '需求', '作废登记.jsonl');
const readWf = () => (fs.existsSync(wfFile) ? JSON.parse(fs.readFileSync(wfFile, 'utf8')) : { requirements: {} });
const rowsOf = () => readWf().requirements || {};

// 幽灵 id（只存在于“本地缓存”/任务文件，工作流没有行）
const ghostReg1 = 'R-20261113-015208-ba18';
const ghostReg2 = 'R-20261114-144138-550f';
const ghostVoid1 = 'R-20261113-000757-4720';
const ghostVoid2 = 'R-20261113-004109-68f7';
const ghostVoid3 = 'R-20261113-043814-bb1e';

// ① 登记前：工作流 0 行
check('① 登记前工作流无这些 id', [ghostReg1, ghostReg2, ghostVoid1].every((id) => !rowsOf()[id]), Object.keys(rowsOf()).length);

// ② 单条 register → review + 需求任务文件
const reg = run(['req', 'register', '--boot', pm.token, '--project', PROJECT, '--id', ghostReg1, '--title', '敏捷并行协同', '--json'], true);
check('② register 成功且 status=review', reg.ok === true && reg.status === 'review' && String((rowsOf()[ghostReg1] || {}).status) === 'review', { ok: reg.ok, code: reg.code });
check('② 生成需求任务文件', fs.existsSync(taskFile(ghostReg1)), '');
const dup = run(['req', 'register', '--boot', pm.token, '--project', PROJECT, '--id', ghostReg1, '--title', 'x', '--json'], true);
check('② 重复 register → ALREADY_REGISTERED 零副作用', dup.ok === false && dup.code === 'ALREADY_REGISTERED', dup.code);

// ③ AC2 批量 register（--ids）
const batchReg = run(['req', 'register', '--boot', pm.token, '--project', PROJECT, '--ids', `${ghostReg2},R-20261114-001010-2742`, '--json'], true);
check('③ 批量 register --ids 处理 2 条', batchReg.ok === true && batchReg.batch === true && batchReg.total === 2 && batchReg.okCount === 2, { code: batchReg.code, total: batchReg.total, okCount: batchReg.okCount });
check('③ 批量登记的 id 都进 review', [ghostReg2, 'R-20261114-001010-2742'].every((id) => String((rowsOf()[id] || {}).status) === 'review'), Object.keys(rowsOf()).length);

// ④ AC5 void（工作流无行）落 项目根/需求/作废登记.jsonl，带 project 字段
const voidOnly = run(['req', 'void', '--boot', pm.token, '--project', PROJECT, '--id', ghostVoid1, '--reason', '11-13 需求池录入未登记工作流', '--json'], true);
check('④ 无工作流行也能作废（status=voided）', voidOnly.ok === true && voidOnly.status === 'voided' && voidOnly.hadWorkflowRow === false, { ok: voidOnly.ok, code: voidOnly.code, status: voidOnly.status });
check('④ 落点是 项目根/需求/作废登记.jsonl', voidOnly.registry === registryFile && fs.existsSync(registryFile), { got: voidOnly.registry, want: registryFile });
const regRows = readJsonl(registryFile);
check('④ 登记行带 project 字段', regRows.length > 0 && regRows.every((row) => String(row.project || '') === PROJECT), regRows.slice(0, 2));
check('④ 不在仓库根写 需求/（不污染 git status）', !fs.existsSync(path.join(SB, '需求')), path.join(SB, '需求'));

// ⑤ AC2 批量 void（--from-file）
const specFile = path.join(SB, 'void-spec.jsonl');
fs.writeFileSync(specFile, [
  JSON.stringify({ id: ghostVoid2, reason: '需求池录入未登记（批量）' }),
  JSON.stringify({ id: ghostVoid3, reason: '需求池录入未登记（批量）' }),
].join('\n') + '\n', 'utf8');
const batchVoid = run(['req', 'void', '--boot', pm.token, '--project', PROJECT, '--from-file', specFile, '--json'], true);
check('⑤ 批量 void --from-file 处理 2 条', batchVoid.ok === true && batchVoid.total === 2 && batchVoid.okCount === 2, { code: batchVoid.code, total: batchVoid.total });
check('⑤ 批量作废都写进登记', [ghostVoid2, ghostVoid3].every((id) => readJsonl(registryFile).some((row) => String(row.requirementId) === id)), readJsonl(registryFile).map((row) => row.requirementId));

// ⑥ 幂等
const voidAgain = run(['req', 'void', '--boot', pm.token, '--project', PROJECT, '--id', ghostVoid1, '--reason', '再作废', '--json'], true);
check('⑥ 重复作废 → ALREADY_VOIDED', voidAgain.ok === false && voidAgain.code === 'ALREADY_VOIDED', voidAgain.code);

// ⑦ 有工作流行作废 → terminated
const voidRow = run(['req', 'void', '--boot', pm.token, '--project', PROJECT, '--id', ghostReg1, '--reason', '测试作废', '--json'], true);
check('⑦ 有工作流行作废 → status=terminated', voidRow.ok === true && voidRow.status === 'terminated' && String((rowsOf()[ghostReg1] || {}).status) === 'terminated', { ok: voidRow.ok, row: (rowsOf()[ghostReg1] || {}).status });

// ⑧ AC1 快照消费：作废 id 不得再出现在 requirements（也不得被任务文件造回）
const tools = require(path.join(ROOT, 'src', 'team-tools.js')).create({ teamRoot: TEAM_ROOT });
const snap = tools.readWorkflowSnapshot(PROJECT, projectDir);
const snapIds = new Set(snap.requirements.map((row) => String(row.id)));
check('⑧ 快照不含已作废 id（工作流无行的幽灵）', ![ghostVoid1, ghostVoid2, ghostVoid3].some((id) => snapIds.has(id)), [...snapIds].filter((id) => [ghostVoid1, ghostVoid2, ghostVoid3].includes(id)));
check('⑧ 快照不含已作废 id（有工作流行 → 仍显示但 status=terminated）', (() => {
  const row = snap.requirements.find((item) => item.id === ghostReg1);
  return Boolean(row) && row.status === 'terminated' && row.voided === true;
})(), snap.requirements.find((item) => item.id === ghostReg1));
check('⑧ 快照 counts.voided = 登记条数', Number(snap.counts && snap.counts.voided) === readJsonl(registryFile).length, { counts: snap.counts && snap.counts.voided, file: readJsonl(registryFile).length });

// ⑨ 未登记标记：只有任务文件、工作流没有行、也没作废 → unregistered=true
const ghostTaskId = 'R-20261115-070707-ffff';
fs.mkdirSync(path.join(stateDir, '任务'), { recursive: true });
fs.writeFileSync(taskFile(ghostTaskId), JSON.stringify({
  id: ghostTaskId, project: PROJECT, type: 'requirement', requirementId: '', title: '未登记幽灵',
  detail: '', acceptance: '', story: '', priority: 'P2', priorityBy: 'pm', priorityReason: '',
  owner: null, status: 'open', createdBy: 'pm', createdAt: new Date().toISOString(), claimedAt: null,
  due: '', doneAt: null, evidence: '', rev: 0, history: [], workflow: { requirementStatus: 'review' }
}, null, 2) + '\n', 'utf8');
const snap2 = tools.readWorkflowSnapshot(PROJECT, projectDir);
const ghostRow = snap2.requirements.find((row) => row.id === ghostTaskId) || null;
check('⑨ 未登记需求出现在快照并带标记', Boolean(ghostRow) && ghostRow.unregistered === true && ghostRow.registered === false, ghostRow);
check('⑨ 未登记清单与计数', Number(snap2.counts && snap2.counts.unregistered) === 1
  && Array.isArray(snap2.unregistered) && snap2.unregistered.length === 1 && snap2.unregistered[0].id === ghostTaskId, snap2.unregistered);

// ⑩ 壳层与团队工具读同一份登记（口径一致，AC3）
const voidedApi = run(['req', 'voided', '--boot', pm.token, '--project', PROJECT, '--json'], true);
const shellReg = tools.readRequirementVoidRegistry(projectDir);
check('⑩ 壳层/工具 读同一份登记（路径+id 集合一致）', voidedApi.registry === shellReg.file
  && JSON.stringify([...voidedApi.ids].sort()) === JSON.stringify([...shellReg.ids].sort()), { api: voidedApi.ids, shell: shellReg.ids });

// ⑪ AC3 双向同步断言：req sync 0 违规
const sync = run(['req', 'sync', '--boot', pm.token, '--project', PROJECT, '--json'], true);
check('⑪ req sync 0 违规', sync.ok === true && Array.isArray(sync.violations) && sync.violations.length === 0, sync.violations);
check('⑪ req sync 的未登记提醒只报这一条夹具', Array.isArray(sync.ghosts) && sync.ghosts.length === 1 && sync.ghosts[0].id === ghostTaskId, sync.ghosts);

// ⑫ 规则守卫：非法 id
const badId = run(['req', 'register', '--boot', pm.token, '--project', PROJECT, '--id', 'R-bad', '--title', 'x', '--json'], true);
check('⑫ 非法 id → BAD_ID', badId.ok === false && badId.code === 'BAD_ID', badId.code);

// ⑬ 权限：非 PM/需求/产品（fast 模式只有 programmer1）不能作废/登记
const p1 = run(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 's-p1', '--json'], true);
const p1void = run(['req', 'void', '--boot', p1.token, '--project', PROJECT, '--id', ghostTaskId, '--reason', '越权', '--json'], true);
check('⑬ programmer1 作废 → PERMISSION_DENIED', p1void.ok === false && p1void.code === 'PERMISSION_DENIED', p1void.code);

const passed = results.filter((row) => row.ok).length;
const failed = results.filter((row) => !row.ok).length;
console.log(`\nB-155a/B-a17d 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
fs.writeFileSync(path.join(SB, 'run-b-155a.json'), JSON.stringify({ passed, failed, results }, null, 2) + '\n', 'utf8');
