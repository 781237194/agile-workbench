#!/usr/bin/env node
'use strict';
/**
 * B-20261117-214907-6f23 夹具②：返工期（iteration）不再冻结 + 派单不再静默降级 + 返工后 claim 正常。
 *
 * 判据（PM 2026-11-18 00:31 单）：
 *   ① req iterate 后：该需求未完成任务**不再 blocked**（无 TASK_FROZEN），审计有 task_unfreeze/OWNER_ITERATION；
 *   ② iteration 下 PM `send --ack --task` **不再被静默降级为通知**：返回显式门禁码（G2/G3），
 *      且收件箱没有落一条 demoted 通知；
 *   ③ 返工正常路径：产品重评 approve + Owner 重批 → claim 成功（返工期任务可 claim）；
 *   ④ terminate 仍冻结（回归不放松）。
 *
 * 隔离：TEAM_ROOT/TEAM_PROJECTS_ROOT/TEAM_SELFTEST=1 + 唯一 _tmp 沙盘；真实 团队.json 零写入。
 * 跑法：node scripts/test-6f23-iteration-dispatch.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const { mkTempSandbox, rmSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));
const SB = mkTempSandbox('6f23-dispatch');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = '6f23派单沙盘';
const REAL_TEAM_FILE = path.join(ROOT, '团队', '状态', '团队.json');
const sha = (f) => { try { return require('node:crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; } };
const realBefore = sha(REAL_TEAM_FILE);
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };
delete env.TEAM_TASK_GATE_LEGACY;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 700)}`);
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
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}
function mailsOf(role) {
  const out = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      if (fs.statSync(full).isDirectory()) { walk(full); continue; }
      if (name.endsWith('.json')) { try { out.push(JSON.parse(fs.readFileSync(full, 'utf8'))); } catch { /* skip */ } }
    }
  };
  walk(path.join(TEAM_ROOT, '状态', '邮箱', role));
  return out;
}

fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true });
const teamFile = path.join(TEAM_ROOT, '状态', '团队.json');
const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
for (const m of team.members || []) m.sessionId = '';
team.activeProject = PROJECT;
fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');

run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'd-pm', '--json']).json.token;
const product = run(['boot', '--role', 'product', '--project', PROJECT, '--session', 'd-pd', '--json']).json.token;
const p1 = run(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 'd-p1', '--json']).json.token;
for (const t of [pm, product, p1]) run(['lessons', 'read', '--boot', t, '--project', PROJECT, '--json']);

const req = run(['req', 'create', '--boot', product, '--project', PROJECT, '--title', '返工派单需求', '--priority', 'P1', '--acceptance', 'AC', '--json']).json.requirement.id;
run(['req', 'review', '--boot', product, '--project', PROJECT, '--id', req, '--verdict', 'approve', '--comments', '空值：拒绝；异常：记录；权限：拒绝；并发：冲突；降级：提示；模式：同口径', '--json']);
// 先建"旧任务"（打回时会被冻结），再 Owner 打回 → iterate 验证解冻
const oldTask = run(['task', 'create', '--boot', pm, '--project', PROJECT, '--type', 'task', '--title', '返工前旧任务', '--priority', 'P1', '--detail', '夹具', '--owner', 'programmer1', '--requirement', req, '--json']).json.task.id;
const nonce = (run(['owner', 'confirm', '--project', PROJECT, '--requirement', req, '--decision', 'rejected', '--test-owner', '--json']).json || {});
const nonceV = nonce.nonce || (nonce.confirmation && nonce.confirmation.nonce) || '';
run(['owner', '--project', PROJECT, '--requirement', req, '--decision', 'rejected', '--opinion', '返工：补边界后重做', '--owner-confirm', nonceV, '--json']);
const frozenBefore = readTask(oldTask);
const iter = run(['req', 'iterate', '--boot', pm, '--project', PROJECT, '--id', req, '--reason', '返工重做', '--json']);
const oldAfter = readTask(oldTask);
const audits = auditRows();
check('① 打回后任务先被冻结（blocked/OWNER_REJECTED）', String(frozenBefore.status) === 'blocked' && String(frozenBefore.blockedCause) === 'rejected',
  { status: frozenBefore.status, cause: frozenBefore.blockedCause });
check('①b req iterate 成功 → 旧任务**不再 blocked**（解冻回原状态，审计 task_unfreeze/OWNER_ITERATION）',
  iter.json && iter.json.ok === true && String(oldAfter.status) !== 'blocked' && !oldAfter.blockedCause
    && audits.some((r) => r.action === 'task_unfreeze' && r.code === 'OWNER_ITERATION' && r.taskId === oldTask),
  { status: oldAfter.status, cause: oldAfter.blockedCause, audits: audits.filter((r) => /task_(freeze|unfreeze)/.test(String(r.action))).map((r) => `${r.action}/${r.code}/${r.taskId}`) });

// ② iteration 下派单：不再静默降级为通知（应有显式门禁码，且收件箱没有 demoted 通知）
const reworkTask = run(['task', 'create', '--boot', pm, '--project', PROJECT, '--type', 'task', '--title', '返工任务', '--priority', 'P1', '--detail', '夹具', '--requirement', req, '--json']).json.task.id;
const sendBefore = run(['send', '--boot', pm, '--project', PROJECT, '--to', 'programmer1', '--subject', '返工派单-未重批', '--body', '夹具正文', '--ack', '--task', reworkTask, '--json']);
const noticeLanded = mailsOf('programmer1').some((m) => String(m.subject || '').includes('返工派单-未重批'));
const sendJson = sendBefore.json || {};
check('② iteration 未重批时派单 → 显式门禁码（非静默 demoted），且收件箱没有落通知',
  sendJson.ok === false && Boolean(sendJson.code) && sendJson.demoted !== true && noticeLanded === false,
  { code: sendJson.code, demoted: sendJson.demoted, noticeLanded, status: sendBefore.status, raw: sendBefore.raw });

// claim 未重批：被 G3 拒（不是 TASK_FROZEN —— 冻结死锁已解）
const claimBlocked = run(['task', 'claim', '--boot', p1, '--project', PROJECT, '--id', reworkTask, '--json']);
const claimCode = String((claimBlocked.json && claimBlocked.json.code) || '');
check('②b 未重批 claim → TASK_GATE_NOT_APPROVED（不再因 blocked 报 TASK_FROZEN）',
  claimBlocked.json && claimBlocked.json.ok === false && claimCode === 'TASK_GATE_NOT_APPROVED',
  { code: claimCode, json: claimBlocked.json });

// ③ 返工正常路径：产品重评 → Owner 重批 → claim 成功
const review2 = run(['req', 'review', '--boot', product, '--project', PROJECT, '--id', req, '--verdict', 'approve', '--comments', '空值：拒绝；异常：记录；权限：拒绝；并发：冲突；降级：提示；模式：同口径', '--owner-opinion-ack', '采纳：返工按意见重评', '--json']);
const nonce2 = (run(['owner', 'confirm', '--project', PROJECT, '--requirement', req, '--decision', 'approved', '--test-owner', '--json']).json || {});
const n2 = nonce2.nonce || (nonce2.confirmation && nonce2.confirmation.nonce) || '';
const owner2 = run(['owner', '--project', PROJECT, '--requirement', req, '--decision', 'approved', '--opinion', '重批通过', '--owner-confirm', n2, '--json']);
const claimOk = run(['task', 'claim', '--boot', p1, '--project', PROJECT, '--id', reworkTask, '--json']);
check('③ 产品重评 + Owner 重批 → 返工任务 claim 成功（返工期任务可正常 claim）',
  review2.json && review2.json.ok === true && owner2.json && owner2.json.ok === true && claimOk.json && claimOk.json.ok === true,
  { review2: review2.json && review2.json.code, owner2: owner2.json && owner2.json.code, claim: claimOk.json && (claimOk.json.code || 'ok') });

// ④ terminate 仍冻结（回归）
const termReq = run(['req', 'create', '--boot', product, '--project', PROJECT, '--title', '终止回归需求', '--priority', 'P1', '--acceptance', 'AC', '--json']).json.requirement.id;
run(['req', 'review', '--boot', product, '--project', PROJECT, '--id', termReq, '--verdict', 'approve', '--comments', '空值：拒绝；异常：记录；权限：拒绝；并发：冲突；降级：提示；模式：同口径', '--json']);
const termTask = run(['task', 'create', '--boot', pm, '--project', PROJECT, '--type', 'task', '--title', '终止任务', '--priority', 'P1', '--detail', 'x', '--requirement', termReq, '--json']).json.task.id;
run(['req', 'terminate', '--boot', pm, '--project', PROJECT, '--id', termReq, '--reason', '回归终止', '--json']);
const termAfter = readTask(termTask);
check('④ terminate 仍冻结（blockedCause=terminated）', String(termAfter.status) === 'blocked' && String(termAfter.blockedCause) === 'terminated',
  { status: termAfter.status, cause: termAfter.blockedCause });

const realAfter = sha(REAL_TEAM_FILE);
check('⑤ 真实 团队.json sha256 不变（沙盘零写入）', Boolean(realBefore) && realBefore === realAfter, { before: realBefore.slice(0, 12), after: realAfter.slice(0, 12) });

const total = results.length;
const pass = results.filter((x) => x.ok).length;
const evDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-6f23');
fs.mkdirSync(evDir, { recursive: true });
const evFile = path.join(evDir, `dispatch-run-${new Date().toISOString().replace(/[:.]/g, '-')}-${total - pass === 0 ? 'green' : 'red'}.json`);
fs.writeFileSync(evFile, JSON.stringify({ task: 'B-20261117-214907-6f23', kind: 'iteration-dispatch', at: new Date().toISOString(), total, pass, red: total - pass, results }, null, 2) + '\n', 'utf8');
console.log(`\n6F23_DISPATCH_${total - pass === 0 ? 'OK' : 'RED'} ${JSON.stringify({ total, pass, red: total - pass })}`);
console.log(`证据：${evFile}`);
if (process.env.AWB_KEEP_SANDBOX !== '1') { try { rmSandbox(SB); } catch { /* ignore */ } }
