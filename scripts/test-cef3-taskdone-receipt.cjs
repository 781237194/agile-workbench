'use strict';
/**
 * B-20261115-064801-cef3 断言：task done 假失败——createdBy 不在团队时完成回执 NO_RECIPIENT。
 *
 * AC1 createdBy 不是团队成员 → 回执回退 pm（与 createdBy=system 同口径），不再 NO_RECIPIENT；
 * AC2 notify 失败降级为 warnings、不改 command 退出码，任务与需求照常落库；
 * AC3 路由守护自动建的任务（createdBy=route-daemon）done 后 PM 能收到完成回执；
 * AC4 断言覆盖：createdBy=route-daemon → done 返回 ok:true + warning 而非 ok:false。
 *
 * 沙盘：_tmp/cef3（TEAM_ROOT + TEAM_PROJECTS_ROOT 双隔离 + TEAM_SELFTEST=1 + 清空 sessionId）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', 'cef3');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = '回执收件人沙盘';
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 340)}`);
  if (!ok) process.exitCode = 1;
}
function run(args) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
    const text = String(out).trim();
    const idx = text.indexOf('{');
    return { status: 0, json: idx >= 0 ? JSON.parse(text.slice(idx)) : null, text };
  } catch (e) {
    const stdout = String((e && e.stdout) || '');
    const idx = stdout.indexOf('{');
    return { status: e.status, json: idx >= 0 ? JSON.parse(stdout.slice(idx)) : null, text: stdout + String((e && e.stderr) || '') };
  }
}

fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true, filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) });
const teamFile = path.join(TEAM_ROOT, '状态', '团队.json');
const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
for (const member of team.members || []) member.sessionId = '';
team.activeProject = PROJECT;
fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');

run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-cef3-pm', '--json']).json.token;
const p2 = run(['boot', '--role', 'programmer2', '--project', PROJECT, '--session', 's-cef3-p2', '--json']).json.token;
const tester = run(['boot', '--role', 'tester', '--project', PROJECT, '--session', 's-cef3-t', '--json']).json.token;

const stateDir = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
const taskDir = path.join(stateDir, '任务');
fs.mkdirSync(taskDir, { recursive: true });
const evidenceFile = path.join(SB, 'evidence-demo.md');
fs.writeFileSync(evidenceFile, '# 完成证据（夹具）\n\n用于 task done 证据门。\n', 'utf8');

function seedTask(id, { createdBy, owner = 'programmer2', requirementId = '', status = 'working' }) {
  const row = {
    id, project: PROJECT, type: requirementId ? 'task' : 'bug', requirementId, title: `夹具任务 ${id}`,
    detail: '夹具：验证完成回执收件人解析', acceptance: '', repro: '', priority: 'P2', priorityBy: 'pm', priorityReason: '',
    owner, status, createdBy, createdAt: new Date().toISOString(),
    claimedAt: new Date().toISOString(), due: '', doneAt: null, evidence: '', rev: 0, history: [], workflow: {},
  };
  fs.writeFileSync(path.join(taskDir, `${id}.json`), JSON.stringify(row, null, 2) + '\n', 'utf8');
  return row;
}
function mailCount(role) {
  let total = 0;
  for (const box of ['cur', 'new']) {
    const dir = path.join(TEAM_ROOT, '状态', '邮箱', role, box);
    if (!fs.existsSync(dir)) continue;
    try {
      for (const name of fs.readdirSync(dir)) {
        try {
          const msg = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
          if (String(msg.subject || '').startsWith('完成回执')) total += 1;
        } catch { /* 跳过坏文件 */ }
      }
    } catch { /* 目录不可读 */ }
  }
  return total;
}

// ── AC4 / AC1：createdBy=route-daemon（不在团队）→ ok:true + warning，回执给 PM ──
const T_DAEMON = 'B-20261115-300001-aa01';
seedTask(T_DAEMON, { createdBy: 'route-daemon' });
const mailBefore = mailCount('pm');
const done1 = run(['task', 'done', '--boot', p2, '--project', PROJECT, '--id', T_DAEMON, '--evidence', '证据文件 evidence-demo.md（夹具）', '--json']);
check('④ createdBy=route-daemon → task done ok:true（旧实现 ok:false/NO_RECIPIENT）',
  done1.status === 0 && done1.json && done1.json.ok === true, { status: done1.status, code: done1.json && done1.json.code });
check('① 回执收件人回退 pm（receiptTo=pm）', done1.json && done1.json.receiptTo === 'pm', done1.json && done1.json.receiptTo);
check('④ 带 RECEIPT_RECIPIENT_FALLBACK 警告（不是失败）',
  done1.json && Array.isArray(done1.json.warnings) && done1.json.warnings.some((w) => w.code === 'RECEIPT_RECIPIENT_FALLBACK'),
  done1.json && done1.json.warnings);
check('① 任务照常落库 done', (() => {
  const row = JSON.parse(fs.readFileSync(path.join(taskDir, `${T_DAEMON}.json`), 'utf8'));
  return row.status === 'done' && Boolean(row.doneAt);
})(), {});
check('③ PM 收到完成回执', mailCount('pm') > mailBefore, { before: mailBefore, after: mailCount('pm') });

// ── AC1：createdBy=system 仍是 pm（老口径不回退）──
const T_SYSTEM = 'B-20261115-300002-aa02';
seedTask(T_SYSTEM, { createdBy: 'system' });
const done2 = run(['task', 'done', '--boot', p2, '--project', PROJECT, '--id', T_SYSTEM, '--evidence', '证据文件 evidence-demo.md（夹具）', '--json']);
check('① createdBy=system → 回执给 pm 且无回退警告',
  done2.status === 0 && done2.json.receiptTo === 'pm' && !done2.json.warnings.some((w) => w.code === 'RECEIPT_RECIPIENT_FALLBACK'),
  done2.json && { to: done2.json.receiptTo, warnings: done2.json.warnings });

// ── AC1：createdBy=历史角色名（已不存在）→ 回退 pm ──
const T_OLD_ROLE = 'B-20261115-300003-aa03';
seedTask(T_OLD_ROLE, { createdBy: 'programmer9' });
const done3 = run(['task', 'done', '--boot', p2, '--project', PROJECT, '--id', T_OLD_ROLE, '--evidence', '证据文件 evidence-demo.md（夹具）', '--json']);
check('① createdBy 是历史角色名（非成员）→ 回退 pm',
  done3.status === 0 && done3.json.receiptTo === 'pm' && done3.json.ok === true,
  done3.json && { to: done3.json.receiptTo, code: done3.json.code });

// ── AC2：notify 失败降级 warnings、不改退出码；任务照常落库 ──
// 注意：不能改 团队.json（成员状态变化会让 boot 令牌 RULES_CHANGED 失效）；
// 这里把 PM 邮箱目录换成同名文件，让写邮件路径 ENOTDIR，制造真实的通知失败。
const T_NOTIFY_FAIL = 'B-20261115-300005-aa05';
seedTask(T_NOTIFY_FAIL, { createdBy: 'route-daemon' });
const pmMailDir = path.join(TEAM_ROOT, '状态', '邮箱', 'pm');
const pmMailBackup = path.join(SB, 'pm-mail-backup');
try { fs.cpSync(pmMailDir, pmMailBackup, { recursive: true }); } catch { /* 没有邮件目录也能测 */ }
fs.rmSync(pmMailDir, { recursive: true, force: true });
fs.mkdirSync(path.dirname(pmMailDir), { recursive: true });
fs.writeFileSync(pmMailDir, 'blocked-for-test', 'utf8');
const done4 = run(['task', 'done', '--boot', p2, '--project', PROJECT, '--id', T_NOTIFY_FAIL, '--evidence', '证据文件 evidence-demo.md（夹具）', '--json']);
check('② PM 不可达时 task done 仍 ok:true + 退出码 0（不再假失败）',
  done4.status === 0 && done4.json && done4.json.ok === true, { status: done4.status, code: done4.json && done4.json.code });
check('② 通知失败记进 warnings（RECEIPT_*）',
  done4.json && Array.isArray(done4.json.warnings) && done4.json.warnings.some((w) => String(w.code).startsWith('RECEIPT_')),
  done4.json && done4.json.warnings);
check('② 任务照常落库 done（通知失败不影响落库）', (() => {
  const row = JSON.parse(fs.readFileSync(path.join(taskDir, `${T_NOTIFY_FAIL}.json`), 'utf8'));
  return row.status === 'done' && Boolean(row.doneAt);
})(), {});
// 还原邮箱目录，避免影响后续人工复跑
fs.rmSync(pmMailDir, { force: true });
try { fs.cpSync(pmMailBackup, pmMailDir, { recursive: true }); } catch { fs.mkdirSync(pmMailDir, { recursive: true }); }

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\nB-cef3 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
fs.writeFileSync(path.join(SB, 'run-cef3.json'), JSON.stringify({ passed, failed, results }, null, 2) + '\n', 'utf8');
