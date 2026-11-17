const { rmSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
// 认领硬门端到端（CLI 真跑）：沙盘造一条超时未认领单 → 真跑 team.mjs send --ack --task → 断言被拒且任务文件字节不变。
// 隔离：TEAM_ROOT 复制到 _tmp（清空 sessionId）+ TEAM_SELFTEST=1（沙盘不真唤醒；--no-wake 开关已删除），绝不碰真实团队状态。
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', 'claim-gate-e2e-' + Date.now().toString(36));
const TEAM = path.join(SB, '团队');
const PROJECT = '工作台改造修复';
const TEAM_MJS = path.join(ROOT, '团队', '工具', 'team.mjs');

fs.mkdirSync(TEAM, { recursive: true });

// 1) 沙盘团队：只复制团队.json（名册+项目注册），清空 sessionId 防误唤醒；项目状态目录整份复制（含任务/工作流）
const realTeam = path.join(ROOT, '团队');
fs.mkdirSync(path.join(TEAM, '状态', '项目'), { recursive: true });
const teamJson = JSON.parse(fs.readFileSync(path.join(realTeam, '状态', '团队.json'), 'utf8'));
for (const m of (teamJson.members || [])) delete m.sessionId;
fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(teamJson, null, 2), 'utf8');
// boot 必读：团队宪法 + 项目铁律 + PM 角色卡（沙盘只复制缺了就会被 MISSING_DOC 挡）
for (const rel of ['团队宪法.md', '项目铁律.md', '项目经理/角色卡.md', '项目经理/项目信息.md']) {
  const from = path.join(realTeam, rel);
  if (fs.existsSync(from)) {
    const to = path.join(TEAM, rel);
    fs.mkdirSync(path.dirname(to), { recursive: true });
    fs.copyFileSync(from, to);
  }
}
// 沙盘要带 工具/ 子树：send 的 auto-boot 会拼 <teamRoot>/工具/team.mjs，缺了会 MODULE_NOT_FOUND（e2e-4 曾因此成弱断言）
fs.cpSync(path.join(realTeam, '工具'), path.join(TEAM, '工具'), { recursive: true });
const srcProj = path.join(realTeam, '状态', '项目', PROJECT);
const dstProj = path.join(TEAM, '状态', '项目', PROJECT);
fs.cpSync(srcProj, dstProj, { recursive: true });
// 沙盘不继承真实「在途派单」运行态：真实守护进程会持续生成 PM→programmer1 的派单锁/队列，
// 复制进沙盘后 send 会先被 PM_DISPATCH_PENDING 挡住（认领门根本走不到）。这三件是易变运行态、不是本用例夹具。
for (const rel of ['派单锁.json', '派单队列.json', '派单队列滞留.json']) {
  fs.rmSync(path.join(dstProj, rel), { force: true });
}
// 沙盘里只留 2 条任务：一条超时未认领（programmer2 名下）、一条待派给 programmer2 的新单
const taskDir = path.join(dstProj, '任务');
for (const f of fs.readdirSync(taskDir)) fs.rmSync(path.join(taskDir, f), { force: true });
const NOW = Date.now();
const T0 = new Date(NOW - 45 * 60000).toISOString();
const overdue = {
  id: 'T-CLAIM-E2E-OVERDUE', project: PROJECT, type: 'task', status: 'open', owner: 'programmer2',
  title: '端到端：超时未认领单', createdAt: T0, dispatchedAt: T0, dispatchedBy: 'pm', claimRequired: true, priority: 'P1',
};
const fresh = {
  id: 'T-CLAIM-E2E-NEW', project: PROJECT, type: 'task', status: 'open', owner: '',
  title: '端到端：待派新单', createdAt: new Date(NOW).toISOString(), priority: 'P1',
};
fs.writeFileSync(path.join(taskDir, overdue.id + '.json'), JSON.stringify(overdue, null, 2), 'utf8');
fs.writeFileSync(path.join(taskDir, fresh.id + '.json'), JSON.stringify(fresh, null, 2), 'utf8');

const env = {
  ...process.env, ELECTRON_RUN_AS_NODE: '1', TEAM_ROOT: TEAM,
  TEAM_PROJECTS_ROOT: path.join(SB, '项目'), TEAM_WORKBENCH_JSON: path.join(SB, 'workbench.json'), TEAM_SELFTEST: '1',
};
const run = (args) => {
  try {
    const out = execFileSync(process.execPath, [TEAM_MJS, ...args], { env, encoding: 'utf8', timeout: 60000 });
    return { code: 0, out };
  } catch (error) {
    return { code: error.status === undefined ? -1 : error.status, out: String((error.stdout || '') + (error.stderr || '')) };
  }
};

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log('PASS  ' + name); }
  else { fails.push({ name, detail: detail === undefined ? null : detail }); console.log('FAIL  ' + name + ' · ' + JSON.stringify(detail)); }
};

// 2) 沙盘 PM boot（拿令牌）
const boot = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'session-e2e-claim']);
const token = (String(boot.out).match(/[0-9a-f]{16,}/g) || []).pop() || '';
check('e2e-1 沙盘 PM boot 拿到令牌', Boolean(token), { code: boot.code, tail: String(boot.out).slice(-160) });
if (!token) console.log('BOOT_OUT <<' + String(boot.out).slice(0, 500) + '>>');
// 沙盘先读经验教训（lessons 门禁会挡派单，先过门才能测到认领门）
const lessons = run(['lessons', 'read', '--role', 'pm', '--project', PROJECT, '--boot', token]);
check('e2e-1b 沙盘 lessons read 通过（否则 LESSONS_UNREAD 会先挡）', /LESSONS_UNREAD/.test(lessons.out) === false, { code: lessons.code, tail: String(lessons.out).slice(-160) });

// 3) 真跑派单：应被认领门拒（DISPATCH_CLAIM_OVERDUE），且两条任务文件字节不变
const before = {
  overdue: fs.readFileSync(path.join(taskDir, overdue.id + '.json'), 'utf8'),
  fresh: fs.readFileSync(path.join(taskDir, fresh.id + '.json'), 'utf8'),
};
const send = run(['send', '--role', 'pm', '--project', PROJECT, '--boot', token, '--to', 'programmer2',
  '--subject', '端到端派单', '--body', '这是一条应被认领门拒掉的派单', '--ack', '--task', fresh.id]);
const after = {
  overdue: fs.readFileSync(path.join(taskDir, overdue.id + '.json'), 'utf8'),
  fresh: fs.readFileSync(path.join(taskDir, fresh.id + '.json'), 'utf8'),
};
check('e2e-2 派单被硬拒：输出含 DISPATCH_CLAIM_OVERDUE 且非零退出',
  /DISPATCH_CLAIM_OVERDUE/.test(send.out) && send.code !== 0,
  { code: send.code, tail: String(send.out).slice(-200) });
check('e2e-3 零写入：两条任务文件派单前后逐字节相同',
  before.overdue === after.overdue && before.fresh === after.fresh,
  { overdueSame: before.overdue === after.overdue, freshSame: before.fresh === after.fresh });

// 4) 认领后再派：应放行（不再被拦），证明门只看未认领
const claimed = JSON.parse(after.overdue);
claimed.claimedAt = new Date().toISOString();
claimed.status = 'working';
fs.writeFileSync(path.join(taskDir, overdue.id + '.json'), JSON.stringify(claimed, null, 2), 'utf8');
const send2 = run(['send', '--role', 'pm', '--project', PROJECT, '--boot', token, '--to', 'programmer2',
  '--subject', '端到端派单2', '--body', '认领后应放行', '--ack', '--task', fresh.id]);
check('e2e-4 认领后放行：不再报 DISPATCH_CLAIM_OVERDUE，且派单链路本身没坏（无 MODULE_NOT_FOUND）',
  !/DISPATCH_CLAIM_OVERDUE/.test(send2.out) && !/MODULE_NOT_FOUND/.test(send2.out),
  { code: send2.code, tail: String(send2.out).slice(-200) });

// 5) PM 手工清标（claim clear）：把超时单重新打标后清掉，任务行不再带 claim* 字段、且写 cleared 审计
const reFlag = JSON.parse(fs.readFileSync(path.join(taskDir, overdue.id + '.json'), 'utf8'));
reFlag.claimOverdue = true; reFlag.claimLevel = 'overdue'; reFlag.claimOverdueMin = 45;
fs.writeFileSync(path.join(taskDir, overdue.id + '.json'), JSON.stringify(reFlag, null, 2), 'utf8');
const clear = run(['claim', 'clear', '--role', 'pm', '--project', PROJECT, '--boot', token, '--id', overdue.id, '--reason', 'e2e_manual']);
const afterClear = JSON.parse(fs.readFileSync(path.join(taskDir, overdue.id + '.json'), 'utf8'));
check('e2e-5 claim clear 手工清标：任务行 claimOverdue/claimLevel 已清、输出可解析',
  clear.code === 0 && !('claimOverdue' in afterClear) && !('claimLevel' in afterClear) && /已清|本来就干净/.test(clear.out),
  { code: clear.code, tail: String(clear.out).slice(-160), keys: Object.keys(afterClear).filter((k) => k.startsWith('claim')) });

rmSandbox(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log('\n认领门端到端：' + pass + '/' + (pass + fails.length) + ' PASS');
if (fails.length) { console.log(JSON.stringify(fails, null, 2)); process.exit(1); }
