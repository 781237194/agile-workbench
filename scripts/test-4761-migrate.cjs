/**
 * B-20261117-011143-d5f9（R-20261116-193349-4761）迁移包 CLI 回归
 * 沙盘假仓库（_tmp/4761-migrate-*）：
 *  ① export 默认 dry-run 零写入；--yes 生成 manifest + 包文件
 *  ② import 校验清单：清单被篡改 → MANIFEST_MISMATCH；目标已存在 → MIGRATION_EXISTS；--force 先备份再覆盖
 *  ③ rebind 默认 dry-run 打印 diff 零写入；--yes 才改 项目.json/workbench.json/项目信息.md
 *  ④ rebind-sessions 默认 dry-run；--yes 清空/重绑 sessionId（pending）
 *  ⑤ migrate-check 五步
 * 跑法：node scripts/test-4761-migrate.cjs
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, '团队', '工具', 'migrate.mjs');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 400)}`);
  if (!ok) process.exitCode = 1;
}
function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8' });
    return { code: 0, stdout, json: safeJson(stdout) };
  } catch (e) {
    return { code: e.status || 1, stdout: String(e.stdout || ''), stderr: String(e.stderr || ''), json: safeJson(String(e.stdout || '')) };
  }
}
function safeJson(text) { try { return JSON.parse(text.slice(text.indexOf('{'))); } catch { return null; } }
function mk(p, content = '') { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, content); }

const SB = mkTempSandbox('4761-migrate');
const REPO = path.join(SB, 'repo');
const PROJ = '迁移演示项目';
const projDir = path.join(REPO, '项目', PROJ);
const stateDir = path.join(REPO, '团队', '状态', '项目', PROJ);
mk(path.join(projDir, '需求', 'R-1.md'), '# 需求\n');
mk(path.join(projDir, '程序员A', '产出', 'a.md'), '# 产出\n');
mk(path.join(projDir, '项目信息.md'), '根目录：D:/old/path/项目\n');
mk(path.join(stateDir, '项目.json'), JSON.stringify({ name: PROJ, path: 'D:/old/path/项目', dshWorkspaceId: 'ws-old' }, null, 2));
mk(path.join(stateDir, '工作流.json'), JSON.stringify({ requirements: {} }, null, 2));
mk(path.join(stateDir, '任务', 'T-1.json'), JSON.stringify({ id: 'T-1', status: 'done' }, null, 2));
mk(path.join(stateDir, '任务', '.keep'), '');
mk(path.join(projDir, '_backup', 'noise.txt'), 'noise');
mk(path.join(projDir, '_tmp-x', 'noise2.txt'), 'noise');
mk(path.join(REPO, '团队', '状态', '团队.json'), JSON.stringify({
  version: 2,
  members: ['pm', 'analyst', 'product', 'programmer1', 'programmer2', 'tester'].map((r) => ({ role: r, name: r, sessionId: `sess-${r}`, status: 'active' })),
}, null, 2));
mk(path.join(REPO, 'data', 'userdata', 'workbench.json'), JSON.stringify({
  version: 1, projects: [{ name: PROJ, id: 'p1', path: 'D:/old/path/项目', dshWorkspaceId: 'ws-old', workspace: { id: 'ws-old', path: 'D:/old/path/项目', name: PROJ, engineUrl: 'http://127.0.0.1:1' } }],
}, null, 2));

const OUT = path.join(SB, 'pack');

// ① export
const help = run(['help']);
check('help 列出 5 个命令', /export/.test(help.stdout) && /rebind-sessions/.test(help.stdout) && /migrate-check/.test(help.stdout), help.stdout.slice(0, 200));
const expDry = run(['export', '--root', REPO, '--project', PROJ, '--out', OUT, '--json']);
check('① export 默认 dry-run、零写入', expDry.code === 0 && expDry.json && expDry.json.dryRun === true && !fs.existsSync(OUT), expDry.json || expDry.stderr);
const exp = run(['export', '--root', REPO, '--project', PROJ, '--out', OUT, '--yes', '--json']);
const manifest = fs.existsSync(path.join(OUT, 'manifest.json')) ? JSON.parse(fs.readFileSync(path.join(OUT, 'manifest.json'), 'utf8')) : null;
check('① export --yes 生成清单+包', exp.code === 0 && Boolean(manifest) && manifest.kind === 'pm-workbench-migration' && (manifest.files || []).length >= 4, manifest && manifest.files.length);
const noise = (manifest && manifest.files || []).filter((f) => /_backup|_tmp-x/.test(f.rel));
check('① export 默认排除噪音（_backup/_tmp*）', noise.length === 0, noise);

// ② import
const impDry = run(['import', '--root', REPO, '--project', PROJ, '--out', OUT, '--json']);
check('② import 默认 dry-run', impDry.code === 0 && impDry.json && impDry.json.dryRun === true, impDry.json);
const impExists = run(['import', '--root', REPO, '--project', PROJ, '--out', OUT, '--yes', '--json']);
check('② 目标已存在 → MIGRATION_EXISTS(exit 2)', impExists.code === 2 && impExists.json && impExists.json.code === 'MIGRATION_EXISTS', impExists.json || impExists.stderr);
// 篡改包内一文件 → MANIFEST_MISMATCH
const anyFile = path.join(OUT, '包', 'project', manifest.files.find((f) => f.scope === 'project').rel);
fs.appendFileSync(anyFile, '\n篡改\n');
const impTampered = run(['import', '--root', REPO, '--project', PROJ, '--out', OUT, '--yes', '--json']);
check('② 清单被篡改 → MANIFEST_MISMATCH(exit 2)', impTampered.code === 2 && impTampered.json && impTampered.json.code === 'MANIFEST_MISMATCH', impTampered.json || impTampered.stderr);
// 还原后 --force 导入到新仓库（备份旧目录）
const restore = fs.readFileSync(anyFile, 'utf8').replace(/\n篡改\n$/, '');
fs.writeFileSync(anyFile, restore);
const REPO2 = path.join(SB, 'repo2');
fs.cpSync(REPO, REPO2, { recursive: true });
const impForce = run(['import', '--root', REPO2, '--project', PROJ, '--out', OUT, '--yes', '--force', '--json']);
check('② --force 先备份再覆盖', impForce.code === 0 && impForce.json && Boolean(impForce.json.backup && fs.existsSync(impForce.json.backup)), impForce.json || impForce.stderr);

// ③ rebind
const wbBefore = fs.readFileSync(path.join(REPO, 'data', 'userdata', 'workbench.json'), 'utf8');
const rebindDry = run(['rebind', '--root', REPO, '--project', PROJ, '--to', 'E:/new/root', '--json']);
check('③ rebind 默认 dry-run 打印 diff、零写入', rebindDry.code === 0 && rebindDry.json && rebindDry.json.dryRun === true && (rebindDry.json.diffs || []).length >= 2
  && fs.readFileSync(path.join(REPO, 'data', 'userdata', 'workbench.json'), 'utf8') === wbBefore, rebindDry.json);
const rebind = run(['rebind', '--root', REPO, '--project', PROJ, '--to', 'E:/new/root', '--yes', '--json']);
const pjAfter = JSON.parse(fs.readFileSync(path.join(stateDir, '项目.json'), 'utf8'));
const wbAfter = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'userdata', 'workbench.json'), 'utf8'));
check('③ rebind --yes 改 项目.json path', rebind.code === 0 && pjAfter.path === 'E:/new/root', pjAfter);
check('③ rebind --yes 改 workbench.json 的 path/workspace.path', wbAfter.projects[0].path === 'E:/new/root' && wbAfter.projects[0].workspace.path === 'E:/new/root', wbAfter.projects[0]);
check('③ rebind --yes 改 项目信息.md 盘符路径', fs.readFileSync(path.join(projDir, '项目信息.md'), 'utf8').includes('E:/new/root'), fs.readFileSync(path.join(projDir, '项目信息.md'), 'utf8').slice(0, 80));

// ④ rebind-sessions
const rsDry = run(['rebind-sessions', '--root', REPO, '--json']);
check('④ rebind-sessions 默认 dry-run', rsDry.code === 0 && rsDry.json && rsDry.json.dryRun === true, rsDry.json);
const rs = run(['rebind-sessions', '--root', REPO, '--session', 'pm=new-pm,tester=', '--yes', '--json']);
const teamAfter = JSON.parse(fs.readFileSync(path.join(REPO, '团队', '状态', '团队.json'), 'utf8'));
const byRole = Object.fromEntries(teamAfter.members.map((m) => [m.role, m.sessionId]));
check('④ rebind-sessions --yes 按映射重绑/清空 pending', rs.code === 0 && byRole.pm === 'new-pm' && byRole.tester === '' && byRole.analyst === '', { byRole, changes: rs.json && rs.json.changes });

// ⑤ migrate-check
const chk = run(['migrate-check', '--root', REPO, '--project', PROJ, '--json']);
check('⑤ migrate-check 五步 PASS', chk.code === 0 && chk.json && chk.json.ok === true && (chk.json.steps || []).length === 5, chk.json);

const passed = results.filter((r) => r.ok).length;
console.log(`\nB-4761 迁移包断言：${passed}/${results.length} PASS`);
if (process.env.TEAM_SB_KEEP !== '1') fs.rmSync(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
else console.log('[keep] ' + SB);
