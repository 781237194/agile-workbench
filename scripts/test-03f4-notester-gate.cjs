#!/usr/bin/env node
'use strict';
/**
 * test-03f4-notester-gate.cjs —— B-20261115-195612-03f4 回归夹具
 *
 * 缺陷：`ownerTestGate` 的第二道门（REQ_HAS_OPEN_TASKS）在 noTester 分支完全不执行——
 * `const noTester = !acceptRoleIds.includes('tester')` 为真时直接赋 testGate{ok:true,mode:'pm_signed'}，
 * 不调用 ownerTestGate，于是「无 tester 项目 + 需求名下还有 open 子任务」也能被验收放行。
 *
 * 本夹具断言（沙盘 fast 项目，去掉 tester 角色）：
 *   AC1 需求名下 1 条 open 开发任务 → Owner 验收被拒 REQ_HAS_OPEN_TASKS，且零副作用；
 *   AC2 该任务 done → 验收放行，仍保留 mode=pm_signed / signedBy=pm（b52b F-8 语义不回退）；
 *   AC2 代签路径（PM 代验收）两件套证据门仍在：缺证据 → PM_ACCEPT_EVIDENCE_REQUIRED；齐 → 放行；
 *   AC4 代码证据：同一函数 requirementOpenTasksGate() 在 noTester 分支与 ownerTestGate 内两处调用。
 *   （AC3 有 tester 的 full 项目回归由 scripts/test-c98e-req-open-tasks.cjs 承担，单独跑。）
 *
 * 隔离：mkTempSandbox + TEAM_ROOT/TEAM_PROJECTS_ROOT/TEAM_WORKBENCH_JSON 全指向沙盘 + TEAM_SELFTEST=1。
 * 用法：node scripts/test-03f4-notester-gate.cjs
 * 退出码：0 全过 / 1 有断言失败 / 2 环境错误
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const ROOT = path.resolve(__dirname, '..');
const SB = mkTempSandbox('03f4');
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench.json');
const TEAM_TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const OPS = path.join(ROOT, '团队', '工具', 'lib', 'ops.mjs');
const PROJECT = '无tester验收门沙盘';

let passed = 0;
const failures = [];
const records = [];
function check(name, ok, detail) {
  records.push({ name, ok, detail: ok ? '' : detail });
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 300)}`);
}
function env() {
  return {
    ...process.env,
    TEAM_ROOT: TEAM,
    TEAM_PROJECTS_ROOT: PROJECTS,
    TEAM_WORKBENCH_JSON: STORE,
    TEAM_SELFTEST: '1',
  };
}
function run(args) {
  try {
    const out = execFileSync(process.execPath, [TEAM_TOOL, ...args], { encoding: 'utf8', env: env(), timeout: 120000, cwd: SB });
    return { code: 0, out: String(out), err: '' };
  } catch (error) {
    return { code: error.status == null ? 1 : error.status, out: String(error.stdout || ''), err: String(error.stderr || '') };
  }
}
function runJson(args) {
  const r = run(args);
  const t = String(r.out || '').trim();
  const i = t.indexOf('{');
  let json = null;
  if (i >= 0) { try { json = JSON.parse(t.slice(i)); } catch { json = null; } }
  return { ...r, json };
}
const text = (r) => String(r.out || '') + String(r.err || '');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');

if (!fs.existsSync(TEAM_TOOL)) { console.error('环境错误：找不到 team.mjs'); process.exit(2); }

// ── 沙盘骨架（团队.json 清空 sessionId + 宪法/铁律/协议/工具）
fs.mkdirSync(PROJECTS, { recursive: true });
fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
const teamSrc = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8'));
for (const m of teamSrc.members || []) { m.sessionId = ''; }
teamSrc.activeProjectId = '';
fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(teamSrc, null, 2) + '\n', 'utf8');
for (const rel of ['团队宪法.md', '项目铁律.md']) {
  const src = path.join(ROOT, '团队', rel);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TEAM, rel));
}
const protoSrc = path.join(ROOT, '团队', '协议');
if (fs.existsSync(protoSrc)) fs.cpSync(protoSrc, path.join(TEAM, '协议'), { recursive: true });
fs.cpSync(path.join(ROOT, '团队', '工具'), path.join(TEAM, '工具'), { recursive: true });

// ── 建 fast 项目 + 三角色 boot（tester 必须在裁剪前 boot）
const addProject = runJson(['project', 'add', '--name', PROJECT, '--team-mode', 'fast', '--json']);
check('S0 沙盘 fast 项目登记', addProject.code === 0, { code: addProject.code, out: text(addProject).slice(0, 300) });
const bootPm = runJson(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-pm-03f4', '--json']);
const bootAn = runJson(['boot', '--role', 'analyst', '--project', PROJECT, '--session', 's-an-03f4', '--json']);
const bootTe = runJson(['boot', '--role', 'tester', '--project', PROJECT, '--session', 's-te-03f4', '--json']);
const tokenOf = (r) => String((r.json && r.json.token) || '');
check('S1 三角色 boot + 取到令牌', bootPm.code === 0 && bootAn.code === 0 && bootTe.code === 0 && Boolean(tokenOf(bootPm)) && Boolean(tokenOf(bootAn)),
  { pm: bootPm.code, an: bootAn.code, te: bootTe.code });
const PM = tokenOf(bootPm);
const AN = tokenOf(bootAn);
const TE = tokenOf(bootTe);

// ── 裁掉 tester 角色（模拟 noTester 项目）
const projectFile = path.join(TEAM, '状态', '项目', PROJECT, '项目.json');
const pj = JSON.parse(fs.readFileSync(projectFile, 'utf8'));
const beforeRoles = (pj.roleIds || []).slice();
pj.roleIds = (pj.roleIds || []).filter((r) => r !== 'tester');
fs.writeFileSync(projectFile, JSON.stringify(pj, null, 2) + '\n', 'utf8');
check('S2 项目已裁掉 tester（noTester 现场成立）', !pj.roleIds.includes('tester') && beforeRoles.length > 0, { before: beforeRoles, after: pj.roleIds });

// ── 夹具路径与两件套证据（报告 + 截图）
const stateDir = path.join(TEAM, '状态', '项目', PROJECT);
const taskDir = path.join(stateDir, '任务');
const wfFile = path.join(stateDir, '工作流.json');
const projPath = path.join(PROJECTS, PROJECT);
const reportAbs = path.join(projPath, '测试人员', '产出', '验收报告.md');
const shotAbs = path.join(projPath, '测试人员', '产出', '验收截图.png');
fs.mkdirSync(path.dirname(reportAbs), { recursive: true });
fs.writeFileSync(reportAbs, '# 验收报告\n\nPASS\n', 'utf8');
fs.writeFileSync(shotAbs, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
const relReport = path.relative(projPath, reportAbs);
const relShot = path.relative(projPath, shotAbs);

/** 造一条可验收需求：test_done + Owner 决定 approved + 需求/技术评审 approve（可选 trq=testable） */
function prepRequirement(title, { trqTestable = false } = {}) {
  const createReq = runJson(['req', 'create', '--boot', PM, '--project', PROJECT, '--title', title, '--priority', 'P0', '--acceptance', 'AC', '--json']);
  const id = String((createReq.json && createReq.json.requirement && createReq.json.requirement.id) || '');
  if (!/^R-/.test(id)) return { id: '', createReq };
  const wf = JSON.parse(fs.readFileSync(wfFile, 'utf8'));
  wf.requirements = wf.requirements || {};
  wf.requirements[id] = {
    ...(wf.requirements[id] || {}), id, title, status: 'test_done',
    decisions: [{ status: 'approved', channel: 'ui', by: 'Owner', at: new Date().toISOString() }],
    ...(trqTestable ? { trq: { verdict: 'testable', at: new Date().toISOString() } } : {}),
  };
  fs.writeFileSync(wfFile, JSON.stringify(wf, null, 2) + '\n', 'utf8');
  const mirrorFile = path.join(taskDir, `${id}.json`);
  const mirror = JSON.parse(fs.readFileSync(mirrorFile, 'utf8'));
  mirror.status = 'test_done';
  mirror.workflow = { ...(mirror.workflow || {}), status: 'test_done', decisions: wf.requirements[id].decisions };
  fs.writeFileSync(mirrorFile, JSON.stringify(mirror, null, 2) + '\n', 'utf8');
  run(['req', 'review', '--boot', AN, '--project', PROJECT, '--id', id, '--verdict', 'approve', '--kind', 'requirement', '--comments', '沙盘需求评审', '--json']);
  run(['req', 'review', '--boot', TE, '--project', PROJECT, '--id', id, '--verdict', 'approve', '--kind', 'tech', '--comments', '沙盘技术评审', '--json']);
  return { id, createReq };
}

function writeChildTask(id, status) {
  const nowIso = new Date().toISOString();
  const row = {
    id, project: PROJECT, type: 'task', requirementId: reqId1,
    title: 'noTester 未闭环开发任务', detail: '夹具', acceptance: 'AC',
    priority: 'P1', priorityBy: 'pm', priorityReason: '', owner: 'programmer1', status,
    createdBy: 'pm', createdAt: nowIso, claimedAt: nowIso, due: '',
    doneAt: status === 'done' ? nowIso : null, evidence: '', rev: 0, history: [], workflow: { round: 1 },
  };
  const f = path.join(taskDir, `${id}.json`);
  fs.writeFileSync(f, JSON.stringify(row, null, 2) + '\n', 'utf8');
  return f;
}
function ownerAccept(opinion) {
  const conf = runJson(['owner', 'confirm', '--project', PROJECT, '--requirement', reqId1, '--decision', 'accepted', '--action', 'accept', '--test-owner', '--json']);
  const nonce = String((conf.json && conf.json.confirmation && conf.json.confirmation.nonce) || '');
  const acc = runJson(['owner', '--project', PROJECT, '--requirement', reqId1, '--decision', 'accepted', '--action', 'accept',
    '--evidence', `${relReport}:report`, '--evidence', `${relShot}:screenshot`, '--opinion', opinion, '--owner-confirm', nonce, '--json']);
  return { conf, nonce, acc };
}

// ── 需求 1（AC1/AC2 主路径）
const prep1 = prepRequirement('noTester 验收门需求');
const reqId1 = prep1.id;
check('S3 req create 成功（noTester 项目）', prep1.createReq.code === 0 && /^R-/.test(reqId1), { code: prep1.createReq.code, out: text(prep1.createReq).slice(0, 300), reqId1 });

// AC1：需求名下 1 条 open 开发任务 → 验收必须被拒（REQ_HAS_OPEN_TASKS），零副作用
const CHILD = 'T-20261115-195612-dev1';
const childFile = writeChildTask(CHILD, 'open');
const wfShaBefore = sha(wfFile);
const eventsFile = path.join(stateDir, '事件.jsonl');
const eventsBefore = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8') : '';
const shot1 = ownerAccept('noTester 有 open 任务时验收');
const t1 = text(shot1.acc);
const eventsAfter = fs.existsSync(eventsFile) ? fs.readFileSync(eventsFile, 'utf8') : '';
const newEvents = eventsAfter.slice(eventsBefore.length);
check('AC1① noTester + 需求名下 open 任务 → 验收被拒 REQ_HAS_OPEN_TASKS',
  shot1.acc.code !== 0 && /REQ_HAS_OPEN_TASKS/.test(t1), { code: shot1.acc.code, out: t1.slice(0, 400) });
check('AC1② 拒收信息列出该任务 id', /REQ_HAS_OPEN_TASKS/.test(t1) && t1.includes(CHILD), { out: t1.slice(0, 400) });
check('AC1③ 拒收零副作用：工作流.json sha 不变', sha(wfFile) === wfShaBefore, { before: wfShaBefore.slice(0, 16), after: sha(wfFile).slice(0, 16) });
check('AC1④ 拒收零副作用：未写 accept_test_gate_pm_signed 事件', !newEvents.includes('accept_test_gate_pm_signed'), { added: newEvents.slice(0, 200) });
check('AC1⑤ 子任务仍是 open（未被验收动作改动）', JSON.parse(fs.readFileSync(childFile, 'utf8')).status === 'open', null);

// AC2：把该任务 done → 验收放行；mode=pm_signed 语义保留
const childRow = JSON.parse(fs.readFileSync(childFile, 'utf8'));
childRow.status = 'done';
childRow.doneAt = new Date().toISOString();
fs.writeFileSync(childFile, JSON.stringify(childRow, null, 2) + '\n', 'utf8');
const shot2 = ownerAccept('noTester 任务收口后验收');
const wfAfter = JSON.parse(fs.readFileSync(wfFile, 'utf8'));
const rowAfter = wfAfter.requirements[reqId1] || {};
const decisions = Array.isArray(rowAfter.decisions) ? rowAfter.decisions : [];
const accDecision = decisions.filter((d) => d && (d.status === 'accepted' || d.decision === 'accepted')).slice(-1)[0] || {};
check('AC2① 任务 done 后 noTester 验收放行', shot2.acc.code === 0 && shot2.acc.json && shot2.acc.json.ok === true,
  { code: shot2.acc.code, out: text(shot2.acc).slice(0, 400) });
check('AC2② 仍保留 mode=pm_signed（b52b F-8 语义不回退）',
  String(accDecision.testGate || (rowAfter.acceptanceRecord && rowAfter.acceptanceRecord.testGate) || '') === 'pm_signed',
  { testGate: accDecision.testGate });
check('AC2③ 代签通道字段不变：signedBy=pm、decidedBy=owner、actor=pm',
  accDecision.signedBy === 'pm' && accDecision.decidedBy === 'owner' && accDecision.actor === 'pm',
  { signedBy: accDecision.signedBy, decidedBy: accDecision.decidedBy, actor: accDecision.actor });
check('AC2④ 需求行落为 accepted 且带验收记录',
  ['accepted', 'done'].includes(String(rowAfter.status || '')) && decisions.length > 0,
  { status: rowAfter.status, decisions: decisions.length });

// AC2（代签路径证据门）：bd22 起需求验收只能 Owner 本人（代管不得代验收），
// 所以「两件套证据」只能在插件/壳层代签路径验证——这里做两条回归断言：
//   ① 代验收仍被 PROXY_ACCEPT_FORBIDDEN 硬拦（本修复没有顺带放开代验收通道）；
//   ② 代签两件套证据门与 signedBy/testGate 的插件实现仍在（静态证据，本修复未触碰）。
const prep2 = prepRequirement('noTester 代签证据门需求', { trqTestable: true });
const reqId2 = prep2.id;
const proxyStart = runJson(['owner', 'proxy', 'start', '--project', PROJECT, '--requirement', reqId2, '--scope', 'once', '--json']);
check('AC2⑤ 代管开启成功（once）', proxyStart.code === 0, { code: proxyStart.code, out: text(proxyStart).slice(0, 300) });
const proxyAccept = runJson(['owner', 'proxy', 'decide', '--boot', PM, '--project', PROJECT, '--requirement', reqId2, '--decision', 'accepted', '--action', 'accept',
  '--evidence', `${relReport}:report`, '--evidence', `${relShot}:screenshot`, '--opinion', '代验收尝试', '--json']);
check('AC2⑥ 代验收仍被 PROXY_ACCEPT_FORBIDDEN 硬拦（bd22 口径未因本修复放开）',
  proxyAccept.code !== 0 && /PROXY_ACCEPT_FORBIDDEN/.test(text(proxyAccept)),
  { code: proxyAccept.code, out: text(proxyAccept).slice(0, 300) });
const toolsSrc = fs.readFileSync(path.join(ROOT, 'src', 'team-tools.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
check('AC2⑦ 代签两件套证据门仍在插件/壳层（PM_ACCEPT_EVIDENCE_REQUIRED + 报告≥1/截图≥1）',
  /PM_ACCEPT_EVIDENCE_REQUIRED/.test(toolsSrc) && /报告≥1/.test(mainSrc) && /截图≥1/.test(mainSrc),
  { tools: /PM_ACCEPT_EVIDENCE_REQUIRED/.test(toolsSrc), main: /报告≥1/.test(mainSrc) });
check('AC2⑧ noTester 代签字段的插件实现仍在（testGate: pm_signed）',
  /testGate:\s*'pm_signed'/.test(toolsSrc), null);

// ── AC4：代码证据——同一函数名两处调用点（noTester 分支 + ownerTestGate 内）
const opsSrc = fs.readFileSync(OPS, 'utf8');
const callCount = (opsSrc.match(/requirementOpenTasksGate\(/g) || []).length;
check('AC4① requirementOpenTasksGate 定义 + 两处调用（共 ≥3 次出现）', callCount >= 3, { callCount });
check('AC4② noTester 分支调用同一函数',
  /if \(noTester\) \{[\s\S]{0,800}?requirementOpenTasksGate\(projectName, requirementId\)/.test(opsSrc), null);
check('AC4③ ownerTestGate 内也调用同一函数（有 tester 路径）',
  /const openGate = requirementOpenTasksGate\(projectName, requirementId, children\);/.test(opsSrc), null);

const total = passed + failures.length;
console.log(`\nB-03f4 断言：${passed}/${total} PASS${failures.length ? `，${failures.length} 待修` : ''}`);
const evidDir = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-03f4');
fs.mkdirSync(evidDir, { recursive: true });
fs.writeFileSync(path.join(evidDir, 'run-03f4.json'), JSON.stringify({ at: new Date().toISOString(), sandbox: SB, project: PROJECT, requirements: [reqId1, reqId2], passed, total, results: records }, null, 2) + '\n', 'utf8');
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exit(1); }
process.exit(0);
