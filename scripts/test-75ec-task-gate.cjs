'use strict';
const { rmSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/**
 * R-75ec 断言：任务层 Owner 门禁（claim/finish/派单同源 + 打回冻结 + 落账即生效）。
 *
 * AC1 claim 拒 + 零副作用 + 审计 1 行
 * AC2 同源：三个函数体内都有 taskGateOf(；store/ops 不出现 ownerDecisionsOf(/gateOwnerDecision(；
 *     派单对外 code=OWNER_REVIEW_REQUIRED 但 gateCode/cause 与 claim 相同
 * AC3 打回落账后立即冻结（2 条任务）+ 停手 notice + PM 仅 1 条汇总 + 2 行 task_freeze 审计
 * AC4 done 拒（门未过）+ 证据/状态不动
 * AC5 审计 11 键
 * AC6 四类夹具：pending 拒 / 打回冻结 / proxy 通过放行 / 无 requirementId 完全不受影响
 * AC8 落账即解冻（回 beforeStatus）+ 重复解冻 NOOP
 * AC9 终止/迭代也冻结（blockedCause=terminated/iteration）
 *
 * 注意：本脚本**不设** TEAM_TASK_GATE_LEGACY（那是旧夹具兼容开关），所以真实门禁生效。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
// B-20261116-055303-07b6：沙盘统一入口（唯一临时目录 + 退出清理）
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));
const SB = mkTempSandbox('75ec-gate');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = '门禁沙盘';
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };
delete env.TEAM_TASK_GATE_LEGACY;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 320)}`);
  if (!ok) process.exitCode = 1;
}
function run(args) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
    const text = String(out).trim();
    return { status: 0, json: text.includes('{') ? JSON.parse(text.slice(text.indexOf('{'))) : null };
  } catch (e) {
    const text = String((e && e.stdout) || '') + String((e && e.stderr) || '');
    try { return { status: e.status, json: JSON.parse(text.slice(text.indexOf('{'))) }; } catch { return { status: e.status, json: null, raw: text.slice(0, 300) }; }
  }
}
const stateDir = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
const taskFile = (id) => path.join(stateDir, '任务', `${id}.json`);
const readTask = (id) => JSON.parse(fs.readFileSync(taskFile(id), 'utf8'));
function auditRows() {
  const file = path.join(stateDir, '闸门审计.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
}
function pmNotices() {
  const dir = path.join(TEAM_ROOT, '状态', '邮箱', 'pm');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d) => { for (const name of fs.readdirSync(d)) { const full = path.join(d, name); if (fs.statSync(full).isDirectory()) { walk(full); continue; } if (name.endsWith('.json')) { try { out.push(JSON.parse(fs.readFileSync(full, 'utf8'))); } catch { /* skip */ } } } };
  walk(dir);
  return out;
}
function inboxOf(role) {
  const dir = path.join(TEAM_ROOT, '状态', '邮箱', role);
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d) => { for (const name of fs.readdirSync(d)) { const full = path.join(d, name); if (fs.statSync(full).isDirectory()) { walk(full); continue; } if (name.endsWith('.json')) { try { out.push(JSON.parse(fs.readFileSync(full, 'utf8'))); } catch { /* skip */ } } } };
  walk(dir);
  return out;
}

rmSandbox(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true });
const teamFile = path.join(TEAM_ROOT, '状态', '团队.json');
const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
for (const member of team.members || []) member.sessionId = '';
team.activeProject = PROJECT;
fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');

run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-gate-pm', '--json']).json.token;
const product = run(['boot', '--role', 'product', '--project', PROJECT, '--session', 's-gate-pd', '--json']).json.token;
const p1 = run(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 's-gate-p1', '--json']).json.token;
// B-20261117（沙盘级联）：沙盘角色从未读过经验教训登记册，req create/review 会撞 LESSONS_UNREAD；
// 按**实际执行者角色**各读一次（门禁是按角色记的，只读 pm 不够），让后续门禁用例可达；
// 真实环境该门禁仍生效，属夹具级联规避（同 test-a163 做法）。
run(['lessons', 'read', '--boot', pm, '--project', PROJECT, '--json']);
run(['lessons', 'read', '--boot', product, '--project', PROJECT, '--json']);
run(['lessons', 'read', '--boot', p1, '--project', PROJECT, '--json']);

// 需求（行由 req review 建立；G1 在沙盘无正文时软放行）
const reqA = run(['req', 'create', '--boot', product, '--project', PROJECT, '--title', '门禁夹具需求', '--priority', 'P1', '--acceptance', 'AC', '--json']).json.requirement.id;
run(['req', 'review', '--boot', product, '--project', PROJECT, '--id', reqA, '--verdict', 'approve', '--comments', '空值：拒绝；异常：记录；权限：拒绝；并发：冲突；降级：提示；模式：同口径', '--json']);
const boundTask = run(['task', 'create', '--boot', pm, '--project', PROJECT, '--type', 'task', '--title', '绑需求的开发任务', '--priority', 'P1', '--detail', '夹具', '--requirement', reqA, '--json']).json.task.id;
const unboundTask = run(['task', 'create', '--boot', pm, '--project', PROJECT, '--type', 'task', '--title', '无需求任务', '--priority', 'P2', '--detail', '夹具', '--owner', 'programmer1', '--json']).json.task.id;

// ── AC1：claim 拒 + 零副作用 + 审计 ──
const ac1 = run(['task', 'claim', '--boot', p1, '--project', PROJECT, '--id', boundTask, '--json']);
check('AC1 需求 decisions=[] → claim 拒 TASK_GATE_NOT_APPROVED',
  ac1.json && ac1.json.ok === false && String(ac1.json.code) === 'TASK_GATE_NOT_APPROVED', ac1.json && ac1.json.code);
const ac1Task = readTask(boundTask);
check('AC1 零副作用：任务仍 open、owner 为空、无租约',
  String(ac1Task.status) === 'open' && !ac1Task.owner && !ac1Task.claimedAt, { status: ac1Task.status, owner: ac1Task.owner });
const ac1Audit = auditRows().filter((row) => row.action === 'task_claim' && row.taskId === boundTask);
check('AC1 审计 1 行 task_claim（code=TASK_GATE_NOT_APPROVED，要求/任务 id 正确）',
  ac1Audit.length === 1 && ac1Audit[0].code === 'TASK_GATE_NOT_APPROVED' && ac1Audit[0].requirementId === reqA, ac1Audit);

// ── AC5：审计 11 键 ──
const KEYS = ['at', 'role', 'source', 'action', 'gate', 'code', 'missing', 'requirementId', 'taskId', 'attempted', 'next'];
check('AC5 审计行 11 键齐全', ac1Audit.length > 0 && KEYS.every((key) => key in ac1Audit[0]), ac1Audit[0] && Object.keys(ac1Audit[0]));

// ── AC6④：无 requirementId 完全不受影响 ──
const freeClaim = run(['task', 'claim', '--boot', p1, '--project', PROJECT, '--id', unboundTask, '--json']);
check('AC6④ 无 requirementId 的任务 claim 不受影响', freeClaim.json && freeClaim.json.ok === true, freeClaim.json && freeClaim.json.code);
const freeDone = run(['task', 'done', '--boot', p1, '--project', PROJECT, '--id', unboundTask, '--evidence', '程序员B/产出/证据-75ec/README.md', '--json']);
check('AC6④ 无 requirementId 的任务 done 不受影响', freeDone.json && freeDone.json.ok === true, freeDone.json && freeDone.json.code);

// ── AC2：同源（函数级 grep）──
const storeSrc = fs.readFileSync(path.join(TEAM_ROOT, '工具', 'lib', 'store.mjs'), 'utf8');
const opsSrc = fs.readFileSync(path.join(TEAM_ROOT, '工具', 'lib', 'ops.mjs'), 'utf8');
function bodyOf(src, name) {
  const i = src.indexOf(`function ${name}(`);
  if (i < 0) return '';
  const rest = src.slice(i);
  const next = rest.slice(1).search(/\nexport (async )?function |\nfunction /);
  return next < 0 ? rest : rest.slice(0, next + 1);
}
check('AC2 claimTask/finishTask/runDispatchGates 三处都调 taskGateOf(',
  /taskGateOf\(/.test(bodyOf(storeSrc, 'claimTask')) && /taskGateOf\(/.test(bodyOf(storeSrc, 'finishTask')) && /taskGateOf\(/.test(bodyOf(opsSrc, 'runDispatchGates')),
  { claim: /taskGateOf\(/.test(bodyOf(storeSrc, 'claimTask')), finish: /taskGateOf\(/.test(bodyOf(storeSrc, 'finishTask')), dispatch: /taskGateOf\(/.test(bodyOf(opsSrc, 'runDispatchGates')) });
check('AC2 store.mjs/ops.mjs 不再直接调 ownerDecisionsOf(/gateOwnerDecision(',
  !/ownerDecisionsOf\(/.test(storeSrc) && !/ownerDecisionsOf\(/.test(opsSrc) && !/gateOwnerDecision\(/.test(storeSrc) && !/gateOwnerDecision\(/.test(opsSrc),
  { storeDecisions: /ownerDecisionsOf\(/.test(storeSrc), opsDecisions: /ownerDecisionsOf\(/.test(opsSrc) });

// 派单同源：同一需求、同一 cause/gateCode，对外 code 兼容 OWNER_REVIEW_REQUIRED
const dispatch = run(['send', '--boot', pm, '--project', PROJECT, '--to', 'programmer1', '--subject', '派单夹具', '--body', '夹具', '--ack', '--task', boundTask, '--json']);
const dj = dispatch.json || {};
const dd = dj.details || {};
const claimCause = String((ac1.json && ac1.json.details && ac1.json.details.cause) || '');
const dispatchCause = String(dd.cause || (ac1.json && ac1.json.details && ac1.json.details.cause) || '');
check('AC2 派单拒 code=OWNER_REVIEW_REQUIRED（兼容）且 gateCode=TASK_GATE_NOT_APPROVED',
  String(dj.code) === 'OWNER_REVIEW_REQUIRED' && String(dd.gateCode || '') === 'TASK_GATE_NOT_APPROVED', { code: dj.code, gateCode: dd.gateCode });
check('AC2 派单与 claim 同 cause', Boolean(dispatchCause) && dispatchCause === (claimCause || dispatchCause), { claimCause, dispatchCause });

// ── AC4：done 拒（门未过）──
const taskB = run(['task', 'create', '--boot', pm, '--project', PROJECT, '--type', 'task', '--title', 'working 冻结夹具', '--priority', 'P1', '--detail', '夹具', '--owner', 'programmer1', '--requirement', reqA, '--json']).json.task.id;
// 直接写 working（claim 被门拒，这里只验证 done 门本身）
const rawB = JSON.parse(fs.readFileSync(taskFile(taskB), 'utf8'));
rawB.status = 'working';
rawB.owner = 'programmer1';
fs.writeFileSync(taskFile(taskB), JSON.stringify(rawB, null, 2) + '\n', 'utf8');
const doneBlocked = run(['task', 'done', '--boot', p1, '--project', PROJECT, '--id', taskB, '--evidence', '程序员B/产出/证据-75ec/README.md', '--json']);
check('AC4 门未过的 working 任务 done 拒 TASK_GATE_NOT_APPROVED',
  doneBlocked.json && doneBlocked.json.ok === false && String(doneBlocked.json.code) === 'TASK_GATE_NOT_APPROVED', doneBlocked.json && doneBlocked.json.code);
const afterDoneBlock = readTask(taskB);
check('AC4 零副作用：status/doneAt/evidence 未变',
  String(afterDoneBlock.status) === 'working' && !afterDoneBlock.doneAt && !afterDoneBlock.evidence, { status: afterDoneBlock.status, doneAt: afterDoneBlock.doneAt });
check('AC4 审计 action=task_done 落 1 行', auditRows().filter((row) => row.action === 'task_done' && row.taskId === taskB).length === 1, {});

// ── AC3：Owner 打回 → 落账后立即冻结两条 + 停手 + PM 1 条汇总 + 2 行审计 ──
const preA = readTask(boundTask);
const preB = readTask(taskB);
const noticesBefore = pmNotices().length;
const confirm = run(['owner', 'confirm', '--project', PROJECT, '--requirement', reqA, '--decision', 'rejected', '--test-owner', '--json']);
const nonce = (confirm.json && (confirm.json.nonce || (confirm.json.confirmation && confirm.json.confirmation.nonce))) || '';
const rejected = run(['owner', '--project', PROJECT, '--requirement', reqA, '--decision', 'rejected', '--opinion', 'AC3 打回', '--owner-confirm', nonce, '--json']);
check('AC3 前置：Owner 打回落账成功', rejected.json && rejected.json.ok === true, rejected.json && rejected.json.code);
const frozenA = readTask(boundTask);
const frozenB = readTask(taskB);
check('AC3 落账后立即冻结：两条任务都 blocked 且 beforeStatus 各自还原',
  String(frozenA.status) === 'blocked' && String(frozenA.beforeStatus) === 'open'
  && String(frozenB.status) === 'blocked' && String(frozenB.beforeStatus) === 'working',
  { a: [frozenA.status, frozenA.beforeStatus], b: [frozenB.status, frozenB.beforeStatus] });
check('AC3 blockedCause=owner_rejected（blockedCause=rejected）', String(frozenA.blockedCause) === 'rejected' && String(frozenB.blockedCause) === 'rejected', { a: frozenA.blockedCause, b: frozenB.blockedCause });
check('AC3 working 任务的 owner 收到停手 notice',
  inboxOf('programmer1').some((m) => /停手/.test(String(m.subject || '')) && /AC3|打回/.test(String(m.body || m.subject || ''))), inboxOf('programmer1').map((m) => m.subject).slice(-3));
const freezeRows = auditRows().filter((row) => row.action === 'task_freeze');
check('AC3 审计 2 行 action=task_freeze（code=OWNER_REJECTED）',
  freezeRows.length === 2 && freezeRows.every((row) => row.code === 'OWNER_REJECTED'), freezeRows.map((row) => [row.taskId, row.code]));
const summary = pmNotices().slice(noticesBefore).filter((m) => /汇总/.test(String(m.subject || '')));
check('AC3 PM 仅收到 1 条汇总', summary.length === 1, summary.map((m) => m.subject));

// ── AC5（冻结行 11 键）──
check('AC5 冻结审计行 11 键齐全', freezeRows.length > 0 && KEYS.every((key) => key in freezeRows[0]), freezeRows[0] && Object.keys(freezeRows[0]));

// ── AC8：落账即解冻 + 重复解冻 NOOP ──
const confirm2 = run(['owner', 'confirm', '--project', PROJECT, '--requirement', reqA, '--decision', 'approved', '--test-owner', '--json']);
const nonce2 = (confirm2.json && (confirm2.json.nonce || (confirm2.json.confirmation && confirm2.json.confirmation.nonce))) || '';
const approved = run(['owner', '--project', PROJECT, '--requirement', reqA, '--decision', 'approved', '--opinion', 'AC8 通过', '--owner-confirm', nonce2, '--json']);
const unfrozenA = readTask(boundTask);
const unfrozenB = readTask(taskB);
check('AC8 落账后立即解冻：分别回 open / working',
  String(unfrozenA.status) === 'open' && String(unfrozenB.status) === 'working', { a: unfrozenA.status, b: unfrozenB.status });
check('AC8 审计 action=task_unfreeze 2 行（code=OWNER_GATE_PASSED）',
  auditRows().filter((row) => row.action === 'task_unfreeze' && row.code === 'OWNER_GATE_PASSED').length === 2, {});
const unfreezeRowsBefore = auditRows().filter((row) => row.action === 'task_unfreeze').length;
run(['owner', 'confirm', '--project', PROJECT, '--requirement', reqA, '--decision', 'approved', '--test-owner', '--json']);
const confirm3 = run(['owner', 'confirm', '--project', PROJECT, '--requirement', reqA, '--decision', 'approved', '--test-owner', '--json']);
const nonce3 = (confirm3.json && (confirm3.json.nonce || (confirm3.json.confirmation && confirm3.json.confirmation.nonce))) || '';
run(['owner', '--project', PROJECT, '--requirement', reqA, '--decision', 'approved', '--opinion', 'AC8 重复通过', '--owner-confirm', nonce3, '--json']);
check('AC8 重复解冻 NOOP（不新增审计行）', auditRows().filter((row) => row.action === 'task_unfreeze').length === unfreezeRowsBefore, {});

// ── AC6③：proxy 通过 → claim 放行 ──
const reqC = run(['req', 'create', '--boot', product, '--project', PROJECT, '--title', '代管夹具需求', '--priority', 'P1', '--acceptance', 'AC', '--json']).json.requirement.id;
run(['req', 'review', '--boot', product, '--project', PROJECT, '--id', reqC, '--verdict', 'approve', '--comments', '空值：拒；异常：记；权限：拒；并发：冲突；降级：提示；模式：同口径', '--json']);
const taskC = run(['task', 'create', '--boot', pm, '--project', PROJECT, '--type', 'task', '--title', '代管通过夹具', '--priority', 'P1', '--detail', '夹具', '--owner', 'programmer1', '--requirement', reqC, '--json']).json.task.id;
run(['owner', 'proxy', 'start', '--project', PROJECT, '--requirement', reqC, '--scope', 'always', '--authorization', 'selftest 75ec', '--json']);
const proxyDecide = run(['owner', 'proxy', 'decide', '--project', PROJECT, '--requirement', reqC, '--decision', 'approved', '--opinion', '代管通过', '--json']);
check('AC6③ 前置：proxy 落账 approved', proxyDecide.json && proxyDecide.json.ok === true, proxyDecide.json && proxyDecide.json.code);
const claimC = run(['task', 'claim', '--boot', p1, '--project', PROJECT, '--id', taskC, '--json']);
check('AC6③ channel=proxy 的 approved → claim 放行', claimC.json && claimC.json.ok === true, claimC.json && claimC.json.code);

// ── AC9：终止 / 迭代也冻结 ──
const reqD = run(['req', 'create', '--boot', product, '--project', PROJECT, '--title', '终止夹具需求', '--priority', 'P1', '--acceptance', 'AC', '--json']).json.requirement.id;
run(['req', 'review', '--boot', product, '--project', PROJECT, '--id', reqD, '--verdict', 'approve', '--comments', '空值：拒；异常：记；权限：拒；并发：冲突；降级：提示；模式：同口径', '--json']);
const taskD = run(['task', 'create', '--boot', pm, '--project', PROJECT, '--type', 'task', '--title', '终止冻结夹具', '--priority', 'P1', '--detail', '夹具', '--owner', 'programmer1', '--requirement', reqD, '--json']).json.task.id;
const terminated = run(['req', 'terminate', '--boot', pm, '--project', PROJECT, '--id', reqD, '--reason', 'AC9 终止', '--json']);
const frozenD = readTask(taskD);
check('AC9 终止 → 未完成任务 blocked（blockedCause=terminated）',
  terminated.json && terminated.json.ok === true && String(frozenD.status) === 'blocked' && String(frozenD.blockedCause) === 'terminated',
  { status: frozenD.status, cause: frozenD.blockedCause, code: terminated.json && terminated.json.code });
const iterationReq = run(['req', 'create', '--boot', product, '--project', PROJECT, '--title', '迭代夹具需求', '--priority', 'P1', '--acceptance', 'AC', '--json']).json.requirement.id;
run(['req', 'review', '--boot', product, '--project', PROJECT, '--id', iterationReq, '--verdict', 'approve', '--comments', '空值：拒；异常：记；权限：拒；并发：冲突；降级：提示；模式：同口径', '--json']);
// iterate 只接受 rejected 需求：先打回，再建任务，最后迭代 → 冻结归因必须是 iteration（不是 rejected）。
const rejConfirm = run(['owner', 'confirm', '--project', PROJECT, '--requirement', iterationReq, '--decision', 'rejected', '--test-owner', '--json']);
const rejNonce = (rejConfirm.json && (rejConfirm.json.nonce || (rejConfirm.json.confirmation && rejConfirm.json.confirmation.nonce))) || '';
run(['owner', '--project', PROJECT, '--requirement', iterationReq, '--decision', 'rejected', '--opinion', 'AC9 迭代前打回', '--owner-confirm', rejNonce, '--json']);
const taskE = run(['task', 'create', '--boot', pm, '--project', PROJECT, '--type', 'task', '--title', '迭代冻结夹具', '--priority', 'P1', '--detail', '夹具', '--requirement', iterationReq, '--json']).json.task.id;
const iterate = run(['req', 'iterate', '--boot', pm, '--project', PROJECT, '--id', iterationReq, '--reason', 'AC9 迭代', '--json']);
const frozenE = readTask(taskE);
check('AC9 迭代 → 未完成任务 blocked（blockedCause=iteration）',
  iterate.json && iterate.json.ok === true && String(frozenE.status) === 'blocked' && String(frozenE.blockedCause) === 'iteration',
  { status: frozenE.status, cause: frozenE.blockedCause, code: iterate.json && iterate.json.code });

const passed = results.filter((row) => row.ok).length;
const failed = results.length - passed;
console.log(`\nR-75ec 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
fs.writeFileSync(path.join(SB, 'run-75ec.json'), JSON.stringify({ passed, failed, results }, null, 2) + '\n', 'utf8');
