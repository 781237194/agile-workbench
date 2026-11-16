'use strict';
/**
 * R-7849 一键代管 · 团队工具侧回归（7 条）。
 * 跑法：node scripts/test-proxy-7849.cjs
 * 隔离：复制 团队/ 到 _tmp/proxy-7849-test，TEAM_ROOT/TEAM_PROJECTS_ROOT 指向沙盘，TEAM_SELFTEST=1。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', 'proxy-7849-test');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TEAM_TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = '代管沙盘';
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 300)}`);
  if (!ok) process.exitCode = 1;
}
function run(args, { allowFail = false, extraEnv = {} } = {}) {
  // lessons 门禁与本测试无关（它查的是「PM 是否读过登记册」，不是代管语义），且沙盘里阅读台账与复制来的
  // 状态容易对不上；用 --channel ui 走 Owner 通道豁免，避免 LESSONS_UNREAD 掩盖真正的代管断言。
  const finalArgs = (
    ((args[0] === 'owner' && args[1] === 'proxy' && args[2] === 'decide') || (args[0] === 'req' && args[1] === 'review'))
    && !args.includes('--channel')
  ) ? [...args, '--channel', 'ui'] : args;
  try {
    const out = execFileSync(process.execPath, [TEAM_TOOL, ...finalArgs], { cwd: SB, env: { ...env, ...extraEnv }, encoding: 'utf8' });
    const text = String(out).trim();
    return JSON.parse(text.slice(text.indexOf('{')));
  } catch (e) {
    const text = String((e && e.stdout) || '') + String((e && e.stderr) || '');
    if (allowFail) { try { return JSON.parse(text.slice(text.indexOf('{'))); } catch { return { ok: false, raw: text.slice(0, 300) }; } }
    throw e;
  }
}
const sha = (v) => crypto.createHash('sha256').update(JSON.stringify(v)).digest('hex');

// ---------- 沙盘 ----------
fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true });
const addRes = run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
const projectPath = addRes.project.path;
const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'sbx-pm', '--json']);
const stateDir = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
// B-20261116-105213-bd22：沙盘补齐经验教训登记册（lessons 门禁在 owner proxy decide 首行会查，缺失报 LESSONS_FILE_MISSING）
const lessonsFile = path.join(projectPath, '经验教训登记册.md');
if (!fs.existsSync(lessonsFile)) {
  fs.mkdirSync(path.dirname(lessonsFile), { recursive: true });
  fs.writeFileSync(lessonsFile, '# 经验教训登记册（沙盘）\n\n## 程序员B\n\n| 日期 | 场景 | 教训 | 下次怎么做 |\n|---|---|---|---|\n', 'utf8');
}
const workflowFile = path.join(stateDir, '工作流.json');
// lessons 门禁：直接把「PM 已读当前版本」写进阅读台账（比跑 lessons read 更确定——
// 复制来的 团队/状态 里带着旧 sha 记录，而 lessons read 依赖 PATHS.teamRoot 与当前文件一致）
{
  const lessonsSha = crypto.createHash('sha256').update(fs.readFileSync(lessonsFile)).digest('hex');
  const readLog = path.join(TEAM_ROOT, '状态', '经验教训阅读.jsonl');
  fs.mkdirSync(path.dirname(readLog), { recursive: true });
  const row = { at: new Date().toISOString(), role: 'pm', sessionId: 'sbx-pm', fileSha: lessonsSha, entries: 0, source: 'sandbox-seed' };
  fs.appendFileSync(readLog, JSON.stringify(row) + '\n', 'utf8');
}
const taskDir = path.join(stateDir, '任务');
const mk = (title) => run(['req', 'create', '--boot', pm.token, '--project', PROJECT, '--title', title, '--priority', 'P0', '--acceptance', 'AC1', '--json']).requirement.id;
const idA = mk('代管需求A');
const idB = mk('代管需求B');
const idC = mk('代管需求C');
const idD = mk('代管需求D');
const now = new Date().toISOString();
const setReq = (id, status, trq) => {
  const wf = fs.existsSync(workflowFile)
    ? JSON.parse(fs.readFileSync(workflowFile, 'utf8'))
    : { schema: 2, project: PROJECT, round: 1, phase: 'dev', requirements: {}, events: [] };
  wf.requirements = wf.requirements || {};
  wf.requirements[id] = { ...(wf.requirements[id] || {}), id, status, ...(trq ? { trq: { verdict: trq } } : {}) };
  wf.updatedAt = now;
  fs.writeFileSync(workflowFile, JSON.stringify(wf, null, 2) + '\n', 'utf8');
  const tf = path.join(taskDir, `${id}.json`);
  const t = JSON.parse(fs.readFileSync(tf, 'utf8'));
  t.status = status;
  t.workflow = t.workflow || {};
  t.workflow.status = status;
  if (trq) { t.workflow.trq = { ...(t.workflow.trq || {}), verdict: trq }; t.trq = { verdict: trq }; }
  fs.writeFileSync(tf, JSON.stringify(t, null, 2) + '\n', 'utf8');
};
setReq(idA, 'test_done', 'testable');
setReq(idB, 'ready');
setReq(idC, 'dev');
setReq(idD, 'accepted');
// 给 A 建一条已完成的测试任务（过「测试 done 才能 Owner 验收」的门）
{
  const mkTask = run(['task', 'create', '--boot', pm.token, '--project', PROJECT, '--title', '代管沙盘测试任务', '--priority', 'P0', '--type', 'task', '--owner', 'tester', '--requirement', idA, '--json'], { allowFail: true });
  const tid = mkTask.task && mkTask.task.id;
  if (tid) {
    const tf = path.join(taskDir, `${tid}.json`);
    const t = JSON.parse(fs.readFileSync(tf, 'utf8'));
    t.status = 'done';
    t.doneAt = now;
    fs.writeFileSync(tf, JSON.stringify(t, null, 2) + '\n', 'utf8');
  }
}
// 过需求评审/技术评审闸门（full 模式：需求评审=产品，技术评审=产品/程序员A）
const prod = run(['boot', '--role', 'product', '--project', PROJECT, '--session', 'sbx-prod', '--json']);
const dev1 = run(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 'sbx-dev1', '--json']);
for (const id of [idA, idB]) {
  run(['req', 'review', '--boot', prod.token, '--project', PROJECT, '--id', id, '--verdict', 'approve', '--kind', 'requirement', '--comments', '沙盘', '--json'], { allowFail: true });
  run(['req', 'review', '--boot', dev1.token, '--project', PROJECT, '--id', id, '--verdict', 'approve', '--kind', 'tech', '--comments', '沙盘', '--json'], { allowFail: true });
}
const reportFile = path.join(projectPath, '测试人员', '产出', '测试报告-v1.md');const shotFile = path.join(projectPath, '测试人员', '产出', 'shot-v1.png');
fs.mkdirSync(path.dirname(reportFile), { recursive: true });
fs.writeFileSync(reportFile, '# 测试报告\nPASS\n', 'utf8');
fs.writeFileSync(shotFile, Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]));
console.log(`沙盘就绪：${SB}（需求 ${idA} / ${idB} / ${idC} / ${idD}）`);

// ① scope=all + 幂等 + expiresAt + 授权原文
const start1 = run(['owner', 'proxy', 'start', '--project', PROJECT, '--scope', 'all', '--authorization', 'Owner 13:42 原文：全部交给 PM 代管', '--json'], { allowFail: true });
check('① scope=all 开启成功', start1.ok === true && start1.record && start1.record.scope === 'all', start1);
check('① 记录带 expiresAt（默认 8h）', Boolean(start1.record && start1.record.expiresAt), start1.record && start1.record.expiresAt);
check('① 记录保留 Owner 授权原文', Boolean(start1.record && String(start1.record.authorization).includes('全部交给 PM 代管')), start1.record && start1.record.authorization);
const start2 = run(['owner', 'proxy', 'start', '--project', PROJECT, '--scope', 'all', '--authorization', 'x', '--json'], { allowFail: true });
check('① 重复 start 幂等', start2.ok === true && start2.idempotent === true, start2);

// ④ 过期 → PROXY_EXPIRED
const expiredAt = new Date(Date.parse(start1.record.expiresAt) + 1000).toISOString();
const expired = run(['owner', 'proxy', 'decide', '--project', PROJECT, '--requirement', idB, '--decision', 'approved', '--opinion', '代记', '--json'], { allowFail: true, extraEnv: { TEAM_PROXY_NOW: expiredAt } });
check('④ 过期后落账 → PROXY_EXPIRED', expired.ok === false && expired.code === 'PROXY_EXPIRED', expired);

// ② 四门槛：B-bd22 之后「代管不得代需求验收」先于证据门生效——四门槛齐/不齐都吃同一个拒绝码
const noEvidence = run(['owner', 'proxy', 'decide', '--project', PROJECT, '--requirement', idA, '--decision', 'accepted', '--action', 'accept', '--opinion', '代验收', '--json'], { allowFail: true });
check('② 代需求验收一律拒（PROXY_ACCEPT_FORBIDDEN）', noEvidence.ok === false && noEvidence.code === 'PROXY_ACCEPT_FORBIDDEN', noEvidence);
check('② 拒绝文案写明「需求验收只能 Owner 本人」', String(noEvidence.message || '').includes('需求验收只能 Owner 本人'), noEvidence.message);

// ②b trq/status 门槛（函数级：直接喂 validateAcceptGates）
const { validateAcceptGates } = require(path.join(ROOT, '团队', '工具', 'lib', 'pm-accept-evidence.mjs'));
const gateRes = validateAcceptGates({ evidence: [{ kind: 'report', path: 'a.md' }], trqVerdict: 'not_testable', requirementStatus: 'dev' });
const gateKinds = gateRes.missing.map((m) => m.kind);
check('② trq/status 门槛生效', gateRes.ok === false && gateKinds.includes('trq') && gateKinds.includes('status'), { gateKinds });

// ③ 项目外路径
const outside = path.join(ROOT, '_tmp', 'outside-7849', 'x.png');
fs.mkdirSync(path.dirname(outside), { recursive: true });
fs.writeFileSync(outside, Buffer.from([0x89, 0x50, 0x4e, 0x47]));
const outRes = run(['owner', 'proxy', 'decide', '--project', PROJECT, '--requirement', idA, '--decision', 'accepted', '--action', 'accept', '--evidence', `${outside}:screenshot`, '--opinion', '代验收', '--json'], { allowFail: true });
check('③ 项目外路径：验收前就已拒（PROXY_ACCEPT_FORBIDDEN，不再进证据门）', outRes.ok === false && outRes.code === 'PROXY_ACCEPT_FORBIDDEN', { code: outRes.code });

// ⑥ B-20261116-105213-bd22（Owner 2026-11-16 10:52 裁定）：**代管也不许代需求验收**——
//    四门槛证据齐也必须 PROXY_ACCEPT_FORBIDDEN、零写入；评审决定代记仍可用（见下方 ⑦）。
const okAccept = run(['owner', 'proxy', 'decide', '--project', PROJECT, '--requirement', idA, '--decision', 'accepted', '--action', 'accept',
  '--evidence', `${path.relative(projectPath, reportFile)}:report`, '--evidence', `${path.relative(projectPath, shotFile)}:screenshot`, '--opinion', '代验收通过', '--json'], { allowFail: true });
check('⑥ 四门槛齐也必须拒：代管不得代需求验收', okAccept.ok === false && okAccept.code === 'PROXY_ACCEPT_FORBIDDEN', { code: okAccept.code });
const wfAfter = JSON.parse(fs.readFileSync(workflowFile, 'utf8'));
const rowA = wfAfter.requirements[idA] || {};
const taskA = JSON.parse(fs.readFileSync(path.join(taskDir, `${idA}.json`), 'utf8'));
const acceptance = rowA.acceptanceRecord || (taskA.workflow && taskA.workflow.acceptanceRecord) || null;
check('⑥ 零写入：没有 acceptanceRecord、status 没被推成 accepted', !acceptance && String(rowA.status) !== 'accepted', { acceptance: Boolean(acceptance), status: rowA.status });
const proxyState = JSON.parse(fs.readFileSync(path.join(stateDir, '评审代管.json'), 'utf8'));
const endedRecords = proxyState.records.filter((row) => row.endedAt && row.endedBy === 'system' && row.endedReason === 'requirement_closed');
check('⑥ 未收口 → 代管不被自动结束', endedRecords.length === 0, endedRecords.length);

// ⑦ 代管仍可代记评审决定（approved）——这条不能被 ⑥ 连带打死
const reviewDecide = run(['owner', 'proxy', 'decide', '--project', PROJECT, '--requirement', idA, '--decision', 'approved', '--opinion', '代记通过', '--json'], { allowFail: true });
check('⑦ 代管代记评审决定仍可用', reviewDecide.ok === true, { code: reviewDecide.code, ok: reviewDecide.ok });

// ⑤ 结束代管后代验收 → PROXY_ACCEPT_FORBIDDEN；已落账不被回溯（B-bd22 后「代验收」不落账，
//    所以这里改为断言「结束代管前后验收记录与决定链都没被改动」——⑦ 刚代记的那条 approved 也必须原样在）
const wfBeforeEnd = JSON.parse(fs.readFileSync(workflowFile, 'utf8'));
const rowBeforeEnd = wfBeforeEnd.requirements[idA] || {};
const before = sha({ acceptanceRecord: rowBeforeEnd.acceptanceRecord || null, decisions: rowBeforeEnd.decisions || [] });
run(['owner', 'proxy', 'end', '--project', PROJECT, '--json'], { allowFail: true });
const afterEnd = run(['owner', 'proxy', 'decide', '--project', PROJECT, '--requirement', idA, '--decision', 'accepted', '--action', 'accept', '--evidence', `${path.relative(projectPath, reportFile)}:report`, '--opinion', '再验收', '--json'], { allowFail: true });
check('⑤ 结束后代验收 → PROXY_ACCEPT_FORBIDDEN', afterEnd.ok === false && afterEnd.code === 'PROXY_ACCEPT_FORBIDDEN', afterEnd.code);
const wfEnd = JSON.parse(fs.readFileSync(workflowFile, 'utf8'));
const rowEnd = wfEnd.requirements[idA] || {};
const taskEnd = JSON.parse(fs.readFileSync(path.join(taskDir, `${idA}.json`), 'utf8'));
const acceptanceEnd = rowEnd.acceptanceRecord || (taskEnd.workflow && taskEnd.workflow.acceptanceRecord) || null;
check('⑤ 结束代管不回溯已落账（记录与决定链 sha 不变）', sha({ acceptanceRecord: acceptanceEnd || null, decisions: rowEnd.decisions || taskEnd.workflow.decisions || [] }) === before, { end: sha({ acceptanceRecord: acceptanceEnd || null, decisions: rowEnd.decisions || [] }), before });

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\nR-7849 代管断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
fs.writeFileSync(path.join(SB, 'run-proxy-7849.json'), JSON.stringify({ at: now, passed, failed, results }, null, 2) + '\n', 'utf8');
if (failed) process.exitCode = 1;
