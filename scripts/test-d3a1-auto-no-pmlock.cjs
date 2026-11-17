/**
 * B-20261117-114457-d3a1 回归：自动重派（队列泵）不得占用 PM 派单锁。
 * 断言：
 *  ①自动重派（ops.pumpDispatchQueue）投递成功；
 *  ②自动重派后 派单锁.json 不存在（不占 PM 锁）；
 *  ③审计行 result=auto_dispatch / code=SOURCE_AUTO / source=auto，且消息标 source=auto；
 *  ④随后 PM 正式 send（--ack --task）成功，不透 PM_DISPATCH_PENDING；
 *  ⑤真实 data/userdata/workbench.json 未被本脚本改写（沙盘隔离）。
 * 跑法：node scripts/test-d3a1-auto-no-pmlock.cjs
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? '' : String(JSON.stringify(detail)).slice(0, 500) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 500)}`);
  if (!ok) process.exitCode = 1;
}

(async () => {
  const SB = mkTempSandbox('d3a1');
  const TEAM_ROOT = path.join(SB, '团队');
  const PROJECTS = path.join(SB, '项目');
  // 注意：project add 会把项目名中的空格规范成下划线（目录名），夹具项目名不能带空格，
  // 否则手写的 派单队列.json 与 pump 读取的目录不是同一个（曾导致 pump 返回 reason=EMPTY）。
  const PROJECT = 'd3a1-sandbox';
  const TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
  const env = {
    ...process.env,
    TEAM_ROOT,
    TEAM_PROJECTS_ROOT: PROJECTS,
    TEAM_SELFTEST: '1',
    TEAM_WORKBENCH_JSON: path.join(SB, 'data', 'userdata', 'workbench.json'),
  };
  fs.mkdirSync(path.join(SB, 'data', 'userdata'), { recursive: true });
  fs.mkdirSync(PROJECTS, { recursive: true });
  fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true, filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) });
  const teamFile = path.join(TEAM_ROOT, '状态', '团队.json');
  const teamData = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
  for (const m of teamData.members || []) {
    m.sessionId = '';
    m.status = 'active';
    m.active = true;
  }
  delete teamData.activeProject;
  fs.writeFileSync(teamFile, JSON.stringify(teamData, null, 2) + '\n', 'utf8');
  for (const [k, v] of Object.entries(env)) process.env[k] = v;

  const realStore = path.join(ROOT, 'data', 'userdata', 'workbench.json');
  const fp = (f) => { try { const st = fs.statSync(f); return `${st.size}:${st.mtimeMs}`; } catch { return 'missing'; } };
  const realStoreBefore = fp(realStore);

  const runCli = (args) => {
    const out = execFileSync(process.execPath, [TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
    const text = String(out).trim();
    return JSON.parse(text.slice(text.indexOf('{')));
  };
  runCli(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
  const stateDir = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
  const taskDir = path.join(stateDir, '任务');
  fs.mkdirSync(taskDir, { recursive: true });
  const lockFile = path.join(stateDir, '派单锁.json');
  const auditFile = path.join(stateDir, '派单投递审计.jsonl');

  // 夹具：一条过期队列项（自动重派候选）+ 绑定任务
  const oldIso = new Date(Date.now() - 20 * 60 * 1000).toISOString();
  const taskId = 'B-d3a1-fixture';
  fs.writeFileSync(path.join(taskDir, taskId + '.json'), JSON.stringify({
    id: taskId, project: PROJECT, type: 'bug', title: 'd3a1 夹具', owner: 'analyst',
    status: 'working', priority: 'P2', claimedAt: oldIso, updatedAt: oldIso,
  }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(stateDir, '派单队列.json'), JSON.stringify({
    items: [{
      id: 'Q-STALL-analyst-' + taskId, project: PROJECT, to: 'analyst', task: taskId, at: oldIso,
      attempt: 1, reason: 'stalled_role', from: 'pm', subject: '空闲重派', body: '自动重派正文',
      ackRequired: true, sessionId: '',
    }],
  }, null, 2) + '\n', 'utf8');

  const ops = await import('file:///' + path.join(ROOT, '团队', '工具', 'lib', 'ops.mjs').replace(/\\/g, '/') + '?v=' + Date.now());
  const pump = await ops.pumpDispatchQueue(PROJECT, { role: '', source: 'tick' });
  const lockAfterPump = fs.existsSync(lockFile) ? JSON.parse(fs.readFileSync(lockFile, 'utf8')) : null;
  const audit = fs.existsSync(auditFile)
    ? fs.readFileSync(auditFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
    : [];
  const autoRow = audit.find((row) => row.code === 'SOURCE_AUTO' && row.source === 'auto');

  check('① 自动重派投递成功', pump && pump.ok !== false && pump.pumped !== false, pump);
  check('② 自动重派未写 PM 派单锁', lockAfterPump === null, lockAfterPump);
  // PM 2026-11-17 12:48 改批：不扩 DELIVERY_RESULTS 枚举，用 code/source 区分自动通道（result 仍是 delivered）
  check('③ 投递审计记录自动通道（result=delivered / code=SOURCE_AUTO / source=auto）', Boolean(autoRow)
    && autoRow.code === 'SOURCE_AUTO' && autoRow.source === 'auto' && autoRow.result === 'delivered',
  { autoRow: autoRow || null, auditRows: audit.length, auditFile, allResults: audit.map((r) => r.result) });

  // ④ 随后 PM 正式派单必须成功（不被 PM_DISPATCH_PENDING 挡）
  const pmBoot = runCli(['boot', '--role', 'pm', '--project', PROJECT, '--json']);
  const pmToken = pmBoot && pmBoot.token
    ? String(pmBoot.token)
    : (pmBoot && pmBoot.boot && pmBoot.boot.token ? String(pmBoot.boot.token) : '');
  let pmSend = { ok: false, code: 'NO_BOOT_TOKEN' };
  if (pmToken) {
    try {
      pmSend = runCli(['send', '--boot', pmToken, '--project', PROJECT, '--to', 'analyst',
        '--subject', 'PM 正式派单', '--body', '自动重派后 PM 必须能派', '--ack', '--task', taskId, '--json']);
    } catch (e) {
      pmSend = { ok: false, code: 'CLI_THROW', message: String(e && e.message || e).slice(0, 200) };
    }
  }
  check('④ 自动重派后 PM 正式 send 成功（无 PM_DISPATCH_PENDING）',
    pmSend && pmSend.ok === true && !/PM_DISPATCH_PENDING/.test(String(pmSend.code || '')), pmSend);
  check('⑤ 真实 workbench.json 未被本脚本改写', fp(realStore) === realStoreBefore,
    { before: realStoreBefore, after: fp(realStore) });

  const passed = results.filter((r) => r.ok).length;
  console.log(`\nB-d3a1 自动重派不占 PM 锁断言：${passed}/${results.length} PASS`);
  fs.rmSync(path.join(SB), { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
})();
