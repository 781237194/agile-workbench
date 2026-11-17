/**
 * T-20261117-132340-30e0 换机链路端到端（机器A export zip → 机器B import → init → 注册 → rebind → rebind-sessions）
 * 断言：名册/workbench 随包迁移、rebind 五处、engineUrl 保留、pending 不伪造、其余五角色不变、归档字段、迁移审计。
 * 跑法：node scripts/test-4761-machine.cjs
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, '团队', '工具', 'migrate.mjs');
const TEAM_TOOL_SRC = path.join(ROOT, '团队');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 400)}`);
  if (!ok) process.exitCode = 1;
}
function runRoot(root, args) {
  const env = { ...process.env, TEAM_ROOT: path.join(root, '团队'), TEAM_PROJECTS_ROOT: path.join(root, '项目'), TEAM_SELFTEST: '1', TEAM_WORKBENCH_JSON: path.join(root, 'data', 'userdata', 'workbench.json') };
  const tool = args[0] === 'migrate' ? CLI : path.join(root, '团队', '工具', 'team.mjs');
  const a = args[0] === 'migrate' ? [...args.slice(1), '--root', root] : args;
  try {
    const out = execFileSync(process.execPath, [tool, ...a, '--json'], { cwd: root, env, encoding: 'utf8' });
    const s = String(out).trim();
    try { return { code: 0, json: JSON.parse(s.slice(s.indexOf('{'))) }; } catch { return { code: 0, raw: s.slice(0, 200) }; }
  } catch (e) { return { code: e.status || 1, stderr: String(e.stderr || '').slice(0, 300), json: (() => { try { return JSON.parse(String(e.stdout || '').slice(String(e.stdout || '').indexOf('{'))); } catch { return null; } })() }; }
}
function mk(p, content = '') { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }
function buildMachine(root, projName, paths) {
  // 程序侧：真实工具/协议/宪法/铁律（换机后程序由 git/安装包带来）
  for (const sub of ['工具', '协议']) fs.cpSync(path.join(TEAM_TOOL_SRC, sub), path.join(root, '团队', sub), { recursive: true });
  for (const f of ['团队宪法.md', '项目铁律.md']) {
    const src = path.join(TEAM_TOOL_SRC, f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(root, '团队', f));
  }
  const realTeam = JSON.parse(fs.readFileSync(path.join(TEAM_TOOL_SRC, '状态', '团队.json'), 'utf8'));
  realTeam.members = ['pm', 'analyst', 'product', 'programmer1', 'programmer2', 'tester']
    .map((r) => ({ role: r, name: r, sessionId: `sess-${r}`, status: 'active' }));
  delete realTeam.activeProject;
  mk(path.join(root, '团队', '状态', '团队.json'), JSON.stringify(realTeam, null, 2) + '\n');
  const P = path.join(root, '项目', projName);
  mk(path.join(P, '需求', 'R-1.md'), '# 需求\n');
  mk(path.join(P, '项目信息.md'), `根目录：${paths.proj.replace(/\\/g, '/')}\n数据根：${paths.data.replace(/\\/g, '/')}\n`);
  for (const [role, dir] of [['pm', '项目经理'], ['product', '产品'], ['analyst', '需求分析师'], ['programmer1', '程序员A'], ['programmer2', '程序员B'], ['tester', '测试人员']]) {
    const src = path.join(ROOT, '项目', '工作台改造修复', dir, '角色卡.md');
    mk(path.join(P, dir, '角色卡.md'), fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : '# 角色卡\n');
  }
  for (const rel of ['项目铁律.md', '项目索引.md', path.join('需求', '00-需求总览.md')]) {
    const src = path.join(ROOT, '项目', '工作台改造修复', rel);
    mk(path.join(P, rel), fs.existsSync(src) ? fs.readFileSync(src, 'utf8') : '# 占位\n');
  }
  const St = path.join(root, '团队', '状态', '项目', projName);
  mk(path.join(St, '项目.json'), JSON.stringify({ name: projName, path: paths.proj, dshWorkspaceId: 'ws-old' }, null, 2));
  mk(path.join(St, '工作流.json'), JSON.stringify({ requirements: {}, boots: Object.fromEntries(['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'].map((r) => [r, { at: new Date().toISOString() }])) }, null, 2));
  mk(path.join(St, '任务', 'T-1.json'), JSON.stringify({ id: 'T-1', status: 'done' }, null, 2));
  mk(path.join(root, 'data', 'userdata', 'workbench.json'), JSON.stringify({
    version: 1, projects: [{ name: projName, path: paths.proj, workspacePath: paths.proj, dshWorkspaceId: 'ws-old', workspace: { id: 'ws-old', path: paths.proj, name: projName, engineUrl: 'http://127.0.0.1:60000', bound: true, pending: false } }],
  }, null, 2));
  return { P, St };
}

const SB = mkTempSandbox('4761-machine');
const PROJ = '迁移演示项目';
const A = path.join(SB, 'A');
const B = path.join(SB, 'B');
buildMachine(A, PROJ, { proj: path.join(A, '项目', PROJ), data: path.join(A, 'data') });
const packZip = path.join(SB, 'pack.zip');
const exp = runRoot(A, ['migrate', 'export', '--project', PROJ, '--out', packZip, '--yes']);
check('换机A export zip 成功', exp.code === 0 && fs.existsSync(packZip), exp.json || exp.stderr);
buildMachine(B, PROJ, { proj: path.join(B, '项目', PROJ), data: path.join(B, 'data') });
// 清掉 B 的项目数据（模拟空机器），只留程序
fs.rmSync(path.join(B, '项目', PROJ), { recursive: true, force: true });
fs.rmSync(path.join(B, '团队', '状态', '项目', PROJ), { recursive: true, force: true });
const imp = runRoot(B, ['migrate', 'import', '--zip', packZip, '--project', PROJ, '--yes']);
check('换机B import zip 成功', imp.code === 0 && imp.json && imp.json.files > 0, imp.json || imp.stderr);
const teamB = JSON.parse(fs.readFileSync(path.join(B, '团队', '状态', '团队.json'), 'utf8'));
check('B 名册随包迁移（6 成员）', (teamB.members || []).length === 6, (teamB.members || []).length);
const wbB = JSON.parse(fs.readFileSync(path.join(B, 'data', 'userdata', 'workbench.json'), 'utf8'));
check('B workbench 随包迁移', (wbB.projects || []).length === 1, wbB.projects && wbB.projects.length);
// init + 注册 + rebind
runRoot(B, ['init']);
runRoot(B, ['project', 'add', '--name', PROJ, '--dir', path.join(B, '项目', PROJ), '--team-mode', 'full']);
const toB = path.join(B, '项目', PROJ).replace(/\\/g, '/');
const rb = runRoot(B, ['migrate', 'rebind', '--project', PROJ, '--to', toB, '--yes']);
const pjB = JSON.parse(fs.readFileSync(path.join(B, '团队', '状态', '项目', PROJ, '项目.json'), 'utf8'));
const wbB2 = JSON.parse(fs.readFileSync(path.join(B, 'data', 'userdata', 'workbench.json'), 'utf8'));
const row = wbB2.projects[0];
check('rebind 五处：项目.json path + workbench path/workspacePath/workspace.path 指向 B', rb.code === 0
  && pjB.path === toB && row.path === toB && row.workspacePath === toB && row.workspace.path === toB, { pjB: pjB.path, row });
check('rebind 不伪造 DSH id（dshWorkspaceId/workspace.id 置空+pending）',
  pjB.dshWorkspaceId === '' && pjB.workspacePending === true && row.workspace.id === '' && row.workspace.pending === true && row.workspace.bound === false,
  { pj: pjB, ws: row.workspace });
check('engineUrl 保留不被改写（F4④ 边界）', row.workspace.engineUrl === 'http://127.0.0.1:60000', row.workspace.engineUrl);
check('项目信息.md 已重写为新根且无旧根残留', fs.readFileSync(path.join(B, '项目', PROJ, '项目信息.md'), 'utf8').includes(toB), fs.readFileSync(path.join(B, '项目', PROJ, '项目信息.md'), 'utf8').slice(0, 120));
// rebind-sessions：单角色 + F5 归档/审计
const before = Object.fromEntries(JSON.parse(fs.readFileSync(path.join(B, '团队', '状态', '团队.json'), 'utf8')).members.map((m) => [m.role, m.sessionId]));
const rs = runRoot(B, ['migrate', 'rebind-sessions', '--project', PROJ, '--role', 'pm', '--session', 'new-pm', '--yes']);
const afterMembers = JSON.parse(fs.readFileSync(path.join(B, '团队', '状态', '团队.json'), 'utf8')).members;
const after = Object.fromEntries(afterMembers.map((m) => [m.role, m.sessionId]));
check('F5① 其余五角色不变、只改 pm', rs.code === 0 && after.pm === 'new-pm'
  && ['analyst', 'product', 'programmer1', 'programmer2', 'tester'].every((r) => after[r] === before[r]), { before, after });
const pmRow = afterMembers.find((m) => m.role === 'pm');
check('F5② 归档字段 archivedSession/replacedBySessionId', pmRow.archivedSession === before.pm && pmRow.replacedBySessionId === 'new-pm', pmRow);
const auditFile = path.join(B, '团队', '状态', '项目', PROJ, '迁移审计.jsonl');
check('F5③ 迁移审计.jsonl 落盘', fs.existsSync(auditFile) && fs.readFileSync(auditFile, 'utf8').includes('new-pm'), fs.existsSync(auditFile));
const wakeFile = path.join(B, '团队', '状态', '项目', PROJ, '唤醒.jsonl');
const stale = fs.existsSync(wakeFile) ? fs.readFileSync(wakeFile, 'utf8').split(/\r?\n/).filter(Boolean).filter((l) => l.includes('stale_session')) : [];
check('F5③ 旧会话 stale_session 审计', stale.length >= 1, stale.length);

const passed = results.filter((r) => r.ok).length;
console.log(`\nB-4761 换机链路断言：${passed}/${results.length} PASS`);
if (process.env.TEAM_SB_KEEP !== '1') fs.rmSync(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
else console.log('[keep] ' + SB);
