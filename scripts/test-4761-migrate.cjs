/**
 * B-20261117-130603-b0ea 回归（4761 迁移包 AC 15 项返工）
 * 覆盖 AC1（范围/名册/workbench/清单名）、AC2③（--no-evidence）、AC3（三错误码）、
 * AC5（rebind-sessions 三种语义 + stale_session 审计）、AC6①（固定五步）、AC7②（清单键名）。
 * 跑法：node scripts/test-4761-migrate.cjs
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');
const crypto = require('node:crypto');
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
// 换机目标根（用真实沙盘项目目录，保证 rebind 后项目仍可见，migrate-check 才能 boot）
const TO = projDir.replace(/\\/g, '/');
mk(path.join(projDir, '需求', 'R-1.md'), '# 需求\n');
mk(path.join(projDir, '程序员A', '产出', 'a.md'), '# 产出\n');
mk(path.join(projDir, '程序员A', '产出', '证据-x', '01.png'), 'png');
mk(path.join(projDir, '项目信息.md'), '根目录：D:/old/path/项目\n');
mk(path.join(stateDir, '项目.json'), JSON.stringify({ name: PROJ, path: 'D:/old/path/项目', dshWorkspaceId: 'ws-old' }, null, 2));
mk(path.join(stateDir, '工作流.json'), JSON.stringify({ requirements: {}, boots: Object.fromEntries(['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'].map((r) => [r, { at: new Date().toISOString() }])) }, null, 2));
mk(path.join(stateDir, '任务', 'T-1.json'), JSON.stringify({ id: 'T-1', status: 'done' }, null, 2));
mk(path.join(projDir, '_backup', 'noise.txt'), 'noise');
mk(path.join(projDir, '_tmp-x', 'noise2.txt'), 'noise');
// 名册基于真实 team.json 派生（保留 version/config 等 boot 依赖字段），只替换 members 与 activeProject
{
  const realTeam = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8'));
  realTeam.members = ['pm', 'analyst', 'product', 'programmer1', 'programmer2', 'tester']
    .map((r) => ({ role: r, name: r, sessionId: `sess-${r}`, status: 'active' }));
  delete realTeam.activeProject;
  mk(path.join(REPO, '团队', '状态', '团队.json'), JSON.stringify(realTeam, null, 2) + '\n');
}
mk(path.join(REPO, 'data', 'userdata', 'workbench.json'), JSON.stringify({
  version: 1, projects: [{ name: PROJ, id: 'p1', path: 'D:/old/path/项目', dshWorkspaceId: 'ws-old', workspace: { id: 'ws-old', path: 'D:/old/path/项目', name: PROJ, engineUrl: 'http://127.0.0.1:1' } }],
}, null, 2));

// migrate-check 需要真实团队工具（沙盘假仓库也要能跑 CLI）：复制 团队/工具、协议、宪法/铁律 + 六角色卡（boot 必读），
// 这些只用于让 CLI 能跑，不参与导出计数（export 只打 项目/<P> 与 团队/状态/项目/<P> + 名册/workbench）。
fs.cpSync(path.join(ROOT, '团队', '工具'), path.join(REPO, '团队', '工具'), { recursive: true });
fs.cpSync(path.join(ROOT, '团队', '协议'), path.join(REPO, '团队', '协议'), { recursive: true });
for (const f of ['团队宪法.md', '项目铁律.md']) {
  const src = path.join(ROOT, '团队', f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(REPO, '团队', f));
}
// 项目级必读：项目铁律.md / 项目索引.md / 需求/00-需求总览.md（boot 规格按项目目录读，缺即 MISSING_DOC）
{
  for (const rel of ['项目铁律.md', '项目索引.md', path.join('需求', '00-需求总览.md')]) {
    const src = path.join(ROOT, '项目', '工作台改造修复', rel);
    if (fs.existsSync(src)) mk(path.join(projDir, rel), fs.readFileSync(src, 'utf8'));
    else mk(path.join(projDir, rel), '# ' + rel + '\n');
  }
}
for (const [role, dir] of [['pm', '项目经理'], ['product', '产品'], ['analyst', '需求分析师'], ['programmer1', '程序员A'], ['programmer2', '程序员B'], ['tester', '测试人员']]) {
  const src = path.join(ROOT, '项目', '工作台改造修复', dir, '角色卡.md');
  if (fs.existsSync(src)) mk(path.join(projDir, dir, '角色卡.md'), fs.readFileSync(src, 'utf8'));
}
const OUT = path.join(SB, 'pack');
const diskCount = (() => {
  let n = 0;
  const walk = (d) => { for (const e of fs.readdirSync(d, { withFileTypes: true })) { const f = path.join(d, e.name); if (e.isDirectory()) walk(f); else n += 1; } };
  walk(projDir); walk(stateDir);
  return n;
})();
const noiseCount = 2;
const expectItems = diskCount - noiseCount + 2; // + 名册 + workbench

// ① export 范围/清单名/键名（AC1、AC7②）
const help = run(['help']);
check('help 列出五命令 + --no-evidence/--clear', ['export', 'import', 'rebind', 'rebind-sessions', 'migrate-check', '--no-evidence', '--clear'].every((k) => help.stdout.includes(k)), help.stdout.slice(0, 300));
const expDry = run(['export', '--root', REPO, '--project', PROJ, '--out', OUT, '--json']);
check('① export 默认 dry-run 零写入', expDry.code === 0 && expDry.json && expDry.json.dryRun === true && !fs.existsSync(OUT), expDry.json);
const exp = run(['export', '--root', REPO, '--project', PROJ, '--out', OUT, '--yes', '--json']);
const mfFile = path.join(OUT, '迁移清单.json');
const mf = fs.existsSync(mfFile) ? JSON.parse(fs.readFileSync(mfFile, 'utf8')) : null;
check('① 包根清单名为 迁移清单.json', exp.code === 0 && Boolean(mf), { mfFile, code: exp.code });
check('① 清单条目数=磁盘文件-噪音+名册+workbench', mf && mf.items.length === expectItems, { items: mf && mf.items.length, expectItems, diskCount });
const keyBad = (mf && mf.items || []).filter((it) => ['path', 'bytes', 'sha256'].some((k) => !(k in it)));
check('① 清单条目键 path/bytes/sha256 齐全（AC7②）', keyBad.length === 0, keyBad.slice(0, 2));
check('① 名册随包（团队/状态/团队.json）', (mf && mf.items || []).some((it) => it.path === '团队/状态/团队.json'), (mf && mf.items || []).map((i) => i.path));
check('① workbench 登记随包（data/userdata/workbench.json）', (mf && mf.items || []).some((it) => it.path === 'data/userdata/workbench.json'), (mf && mf.items || []).map((i) => i.path));
const noise = (mf && mf.items || []).filter((f) => /_backup|_tmp-x/.test(f.path));
check('① 默认排除噪音（_backup/_tmp*）', noise.length === 0, noise.map((f) => f.path));

// ② --no-evidence（AC2③）
const OUT2 = path.join(SB, 'pack-noev');
run(['export', '--root', REPO, '--project', PROJ, '--out', OUT2, '--yes', '--no-evidence', '--json']);
const mf2 = fs.existsSync(path.join(OUT2, '迁移清单.json')) ? JSON.parse(fs.readFileSync(path.join(OUT2, '迁移清单.json'), 'utf8')) : null;
const ev = (mf2 && mf2.items || []).filter((f) => /产出\/证据-/.test(f.path));
check('② --no-evidence 包内不含 产出/证据-*', exp.code === 0 && Boolean(mf2) && ev.length === 0, ev.map((f) => f.path));

// ③ 三错误码（AC3）
const restore = (f, content) => fs.writeFileSync(f, content, 'utf8');
const pickOne = mf.items.find((it) => it.scope === 'project' && it.path.endsWith('/a.md'));
const oneFile = path.join(OUT, '包', pickOne.path);
const orig = fs.readFileSync(oneFile, 'utf8');
fs.appendFileSync(oneFile, '\n改1字节\n');
const impHash = run(['import', '--root', REPO, '--project', PROJ, '--out', OUT, '--yes', '--json']);
check('③ 改包内 1 件 → MIGRATION_HASH_MISMATCH', impHash.code === 2 && impHash.json && impHash.json.code === 'MIGRATION_HASH_MISMATCH', impHash.json || impHash.stderr);
restore(oneFile, orig);
const delFile = path.join(OUT, '包', pickOne.path);
const delContent = fs.readFileSync(delFile, 'utf8');
fs.rmSync(delFile, { force: true });
const impMissing = run(['import', '--root', REPO, '--project', PROJ, '--out', OUT, '--yes', '--json']);
check('③ 删 1 件 → MIGRATION_MISSING', impMissing.code === 2 && impMissing.json && impMissing.json.code === 'MIGRATION_MISSING', impMissing.json || impMissing.stderr);
restore(delFile, delContent);
fs.renameSync(mfFile, mfFile + '.bak');
const impNoManifest = run(['import', '--root', REPO, '--project', PROJ, '--out', OUT, '--yes', '--json']);
check('③ 删清单 → MIGRATION_MANIFEST_MISSING', impNoManifest.code === 2 && impNoManifest.json && impNoManifest.json.code === 'MIGRATION_MANIFEST_MISSING', impNoManifest.json || impNoManifest.stderr);
fs.renameSync(mfFile + '.bak', mfFile);
// 目标已存在 / --force 备份
const impExists = run(['import', '--root', REPO, '--project', PROJ, '--out', OUT, '--yes', '--json']);
check('③ 目标已存在 → MIGRATION_EXISTS(exit 2)', impExists.code === 2 && impExists.json && impExists.json.code === 'MIGRATION_EXISTS', impExists.json);
const REPO2 = path.join(SB, 'repo2');
fs.cpSync(REPO, REPO2, { recursive: true });
const impForce = run(['import', '--root', REPO2, '--project', PROJ, '--out', OUT, '--yes', '--force', '--json']);
check('③ --force 先备份再覆盖', impForce.code === 0 && impForce.json && Boolean(impForce.json.backup && fs.existsSync(impForce.json.backup)), impForce.json || impForce.stderr);
const teamAfterImport = JSON.parse(fs.readFileSync(path.join(REPO2, '团队', '状态', '团队.json'), 'utf8'));
check('① 名册导入后落在 团队/状态/团队.json', (teamAfterImport.members || []).length === 6, (teamAfterImport.members || []).length);

// ④ rebind（AC4）——保持原断言
const wbBefore = fs.readFileSync(path.join(REPO, 'data', 'userdata', 'workbench.json'), 'utf8');
const rebindDry = run(['rebind', '--root', REPO, '--project', PROJ, '--to', TO, '--json']);
check('④ rebind 默认 dry-run 零写入', rebindDry.code === 0 && rebindDry.json && rebindDry.json.dryRun === true && (rebindDry.json.diffs || []).length >= 2
  && fs.readFileSync(path.join(REPO, 'data', 'userdata', 'workbench.json'), 'utf8') === wbBefore, rebindDry.json);
const rebind = run(['rebind', '--root', REPO, '--project', PROJ, '--to', TO, '--yes', '--json']);
const pjAfter = JSON.parse(fs.readFileSync(path.join(stateDir, '项目.json'), 'utf8'));
const wbAfter = JSON.parse(fs.readFileSync(path.join(REPO, 'data', 'userdata', 'workbench.json'), 'utf8'));
check('④ rebind --yes 改 项目.json/workbench/项目信息.md', rebind.code === 0 && pjAfter.path === TO
  && wbAfter.projects[0].path === TO && wbAfter.projects[0].workspace.path === TO
  && fs.readFileSync(path.join(projDir, '项目信息.md'), 'utf8').includes(TO), { pjAfter, wb: wbAfter.projects[0] });

// ⑥ migrate-check 固定五步（AC6①）——放在 rebind 之后（目标根用真实沙盘目录）：
// 且 ④ 会改项目 path、⑤ 会清空 sessionId，放在后面会让 boot 失败（顺序问题非实现问题）。
// 此时 项目.json path 仍是导入时的原值（未 rebind），migrate-check 的 boot 可直接跑。
// ⑥ migrate-check 固定五步（AC6①）
const chk = run(['migrate-check', '--root', REPO, '--project', PROJ, '--out', OUT, '--json']);
const stepNames = (chk.json && chk.json.steps || []).map((s) => s.name);
check('⑥ migrate-check 五步固定（项目可见/六角色boot/无旧根/回环/自检）', chk.code === 0 && chk.json && chk.json.ok === true
  && stepNames.length === 5
  && stepNames[0].includes('项目可见') && stepNames[1].includes('boot') && stepNames[2].includes('旧根')
  && stepNames[3].includes('ack') && stepNames[4].includes('自检'), chk.json || chk.stderr);


// ⑤ rebind-sessions 三语义 + stale_session 审计（AC5）
const teamFile = path.join(REPO, '团队', '状态', '团队.json');
const rolesOf = () => Object.fromEntries(JSON.parse(fs.readFileSync(teamFile, 'utf8')).members.map((m) => [m.role, m.sessionId]));
const before = rolesOf();
const rsRoleDry = run(['rebind-sessions', '--root', REPO, '--project', PROJ, '--role', 'pm', '--session', 'new-pm', '--json']);
check('⑤ rebind-sessions --role 默认 dry-run', rsRoleDry.code === 0 && rsRoleDry.json && rsRoleDry.json.dryRun === true, rsRoleDry.json);
const rsRole = run(['rebind-sessions', '--root', REPO, '--project', PROJ, '--role', 'pm', '--session', 'new-pm', '--yes', '--json']);
const afterRole = rolesOf();
check('⑤ --role pm --session 新：只改 pm，其余五条不变', rsRole.code === 0 && afterRole.pm === 'new-pm'
  && ['analyst', 'product', 'programmer1', 'programmer2', 'tester'].every((r) => afterRole[r] === before[r]), { afterRole, before });
const wakeFile = path.join(stateDir, '唤醒.jsonl');
const staleRows = fs.existsSync(wakeFile) ? fs.readFileSync(wakeFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).filter((r) => r.reason === 'stale_session') : [];
check('⑤ 写 唤醒.jsonl reason=stale_session 审计', staleRows.length >= 1, staleRows.slice(0, 2));
const rsClearDry = run(['rebind-sessions', '--root', REPO, '--project', PROJ, '--clear', '--json']);
check('⑤ --clear 是布尔（不吞后续参数）+ dry-run', rsClearDry.code === 0 && rsClearDry.json && rsClearDry.json.dryRun === true, rsClearDry.json);
const rsClear = run(['rebind-sessions', '--root', REPO, '--project', PROJ, '--clear', '--yes', '--json']);
const afterClear = JSON.parse(fs.readFileSync(teamFile, 'utf8')).members;
check('⑤ --clear 后六条 sessionId 空且 pending', rsClear.code === 0 && afterClear.every((m) => m.sessionId === '' && m.sessionPending === true), afterClear.map((m) => [m.role, m.sessionId, m.sessionPending]));


// ⑦ zip 单文件包（F1/F2/F3/AC1）：export --out <zip> → 包根 迁移清单.json；import --zip 还原
const ZIP = path.join(SB, 'pack.zip');
const expZip = run(['export', '--root', REPO, '--project', PROJ, '--out', ZIP, '--yes', '--json']);
check('⑦ export --out <zip> 生成 zip 单文件包', expZip.code === 0 && fs.existsSync(ZIP) && fs.statSync(ZIP).size > 0
  && expZip.json && expZip.json.zip === true && expZip.json.totals && expZip.json.totals.files === expZip.json.files && expZip.json.files > 0, expZip.json || expZip.stderr);
// import --zip 到干净目标根（复制工具后删掉项目数据）
const REPO3 = path.join(SB, 'repo3');
fs.cpSync(REPO, REPO3, { recursive: true });
fs.rmSync(path.join(REPO3, '项目', PROJ), { recursive: true, force: true });
fs.rmSync(path.join(REPO3, '团队', '状态', '项目', PROJ), { recursive: true, force: true });
const impZip = run(['import', '--zip', ZIP, '--root', REPO3, '--project', PROJ, '--yes', '--json']);
check('⑦ import --zip 校验清单并落地（路径/条目数一致）',
  impZip.code === 0 && impZip.json && impZip.json.files === expZip.json.files
  && (fs.existsSync(path.join(REPO3, '项目', PROJ, '需求')) && fs.readdirSync(path.join(REPO3, '项目', PROJ, '需求')).some((f) => f.startsWith('R-1'))),
  impZip.json || impZip.stderr);

// ⑧ ad04 护栏：对真实仓库根执行 rebind/rebind-sessions 必须被拒且真实名册零改动
const REAL_TEAM_FILE = path.join(ROOT, '团队', '状态', '团队.json');
const shaOf = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const realShaBefore = shaOf(REAL_TEAM_FILE);
const liveRebind = run(['rebind', '--root', ROOT, '--project', '护栏反例项目', '--to', 'X:/fake', '--yes', '--json']);
check('⑧ 对真实仓库根 rebind 被拒（MIGRATION_LIVE_ROOT_REFUSED，exit 2）',
  liveRebind.code === 2 && liveRebind.json && liveRebind.json.code === 'MIGRATION_LIVE_ROOT_REFUSED', liveRebind.json || liveRebind.stderr);
const liveRs = run(['rebind-sessions', '--root', ROOT, '--project', '护栏反例项目', '--role', 'pm', '--session', 'hack', '--yes', '--json']);
check('⑧ 对真实仓库根 rebind-sessions 被拒（MIGRATION_LIVE_ROOT_REFUSED，exit 2）',
  liveRs.code === 2 && liveRs.json && liveRs.json.code === 'MIGRATION_LIVE_ROOT_REFUSED', liveRs.json || liveRs.stderr);
check('⑧ 真实名册 sha256 前后不变（零写入）', shaOf(REAL_TEAM_FILE) === realShaBefore, { before: realShaBefore, after: shaOf(REAL_TEAM_FILE) });
const passed = results.filter((r) => r.ok).length;
console.log(`\nB-4761（b0ea 返工）断言：${passed}/${results.length} PASS`);
if (process.env.TEAM_SB_KEEP !== '1') fs.rmSync(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
else console.log('[keep] ' + SB);
