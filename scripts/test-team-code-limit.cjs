'use strict';
/**
 * 提案暂存上限回归（B-20261115-152338-9c49）：代码类单文件 64KB → 8MB（默认 8MB，env TEAM_CODE_MAX_BYTES 可覆盖）。
 *
 * 入库版回归：默认只用仓库当前代码（apply 后即含修复），不依赖项目内提案暂存副本。
 * 跑法：node scripts/test-team-code-limit.cjs
 *   apply 前演练可加 --lib-dir <含 roles.mjs/store.mjs 的目录>（覆盖沙盘 lib，仅测试用）。
 * 隔离：复制真实 团队/ 到 _tmp/9c49-code-limit（跳过 锁/邮箱），清 sessionId/activeProject/启动令牌；全程 TEAM_SELFTEST=1。
 * 沙盘团队故意写回历史 config.codeMaxBytes=65536，用来验证「历史配置兼容归一（内存读 8MB、不写盘）」。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
// B-20261116-055303-07b6：沙盘统一入口（唯一临时目录 + 退出清理）
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));
const REAL_TEAM = path.join(ROOT, '团队');
// B-20261116-055303-07b6：沙盘改**唯一临时目录**（固定 _tmp/ 目录并发跑会互相 rm/重建 → EPERM/ENOTEMPTY/MODULE_NOT_FOUND）。
// 每次运行一个新目录 + 退出清理；报告件路径不动。
const SB = mkTempSandbox('9c49-code-limit');
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const PROJECT = '9c49提案沙盘';
const PROJECT_DIR = path.join(PROJECTS, PROJECT);
const STATE = path.join(TEAM, '状态', '项目', PROJECT);
const TOOL = path.join(TEAM, '工具', 'team.mjs');
const BIG = 200 * 1024;

const results = [];
function ok(name, cond, detail) {
  results.push({ name, ok: Boolean(cond), detail: cond ? '' : detail });
  console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : '  ' + JSON.stringify(detail).slice(0, 300)}`);
}
function env(extra = {}) {
  return { ...process.env, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1', ...extra };
}
function run(args, extra = {}) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], { cwd: SB, env: env(extra), encoding: 'utf8', windowsHide: true });
    return { code: 0, stdout: String(out), stderr: '' };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}
function runJson(args, extra = {}) {
  const r = run([...args, '--json'], extra);
  let json = null;
  const text = String(r.stdout || '') + '\n' + String(r.stderr || '');
  for (let i = text.lastIndexOf('{'); i >= 0; i = text.lastIndexOf('{', i - 1)) {
    try { json = JSON.parse(text.slice(i)); break; } catch { /* 继续向前找 JSON */ }
  }
  return { ...r, json };
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const shaFile = (p) => sha(fs.readFileSync(p));
function boot(role) {
  const m = /令牌:\s*([0-9a-f]{24})/.exec(run(['boot', '--role', role, '--project', PROJECT]).stdout);
  return m ? m[1] : '';
}
function copy(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name); const d = path.join(dst, ent.name);
    if (/[\\/](锁|邮箱)([\\/]|$)/.test(s)) continue;
    if (ent.isDirectory()) copy(s, d); else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}
function reviewShowSign(proposalId, prog1Token, pmToken, label) {
  runJson(['show', '--boot', prog1Token, '--proposal', proposalId]);
  const r1 = runJson(['review', '--boot', prog1Token, '--proposal', proposalId, '--verdict', 'approve', '--comments', `${label}：审核通过`]);
  runJson(['show', '--boot', pmToken, '--proposal', proposalId]);
  const r2 = runJson(['review', '--boot', pmToken, '--proposal', proposalId, '--verdict', 'approve', '--comments', `${label}：PM 审核通过`]);
  const s1 = runJson(['sign', '--boot', pmToken, '--proposal', proposalId, '--decision', 'approve', '--note', label]);
  return { r1, r2, s1 };
}

// ---------- 沙盘 ----------
fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
copy(REAL_TEAM, TEAM);
const teamFile = path.join(TEAM, '状态', '团队.json');
const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
for (const m of team.members || []) m.sessionId = '';
team.activeProject = '';
team.config = team.config || {};
team.config.codeMaxBytes = 65536; // 模拟不存在修复时的历史默认
fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');
const startDir = path.join(TEAM, '状态', '启动');
if (fs.existsSync(startDir)) for (const f of fs.readdirSync(startDir)) fs.rmSync(path.join(startDir, f), { force: true });

const addProj = runJson(['project', 'add', '--name', PROJECT, '--team-mode', 'full']);
ok('沙盘项目建立', Boolean(addProj.json && addProj.json.ok), addProj.json || (addProj.stdout + addProj.stderr).slice(0, 300));
let pm = boot('pm');
ok('pm boot', Boolean(pm), pm);
const roster = runJson(['roster', 'add', '--boot', pm, '--role', 'programmer2', '--name', '程序员B', '--force']);
ok('沙盘补 programmer2 名册（已在名册视为就绪）', Boolean(roster.json && (roster.json.ok || roster.json.code === 'ROLE_EXISTS')), roster.json || roster.stderr.slice(0, 200));
pm = boot('pm');
const prog1 = boot('programmer1');
const prog2 = boot('programmer2');
ok('三角色令牌齐', Boolean(pm && prog1 && prog2), { pm: Boolean(pm), prog1: Boolean(prog1), prog2: Boolean(prog2) });
const grant = runJson(['grant', '--boot', pm, '--to', 'programmer2', '--actions', 'propose', '--scope', '**', '--project', PROJECT, '--expires', '2026-11-22', '--reason', '9c49 沙盘提案授权']);
ok('PM 给 programmer2 授权 propose', Boolean(grant.json && grant.json.ok), grant.json || grant.stderr.slice(0, 200));
const task = runJson(['task', 'create', '--boot', pm, '--title', '9c49 沙盘：大文件提案链', '--type', 'task', '--owner', 'programmer2', '--priority', 'P1', '--project', PROJECT]);
const taskId = task.json && task.json.task ? task.json.task.id : '';
ok('沙盘任务建立', Boolean(taskId), task.json || task.stderr.slice(0, 200));
const claim = runJson(['task', 'claim', '--boot', prog2, '--id', taskId]);
ok('programmer2 认领任务', Boolean(claim.json && claim.json.ok), claim.json || claim.stderr.slice(0, 200));

// 设置完成后的稳定基线（之后断言 团队.json 不再变化）
const teamShaBefore = shaFile(teamFile);

// ---------- 沙盘基线：历史 config=65536（兼容归一测试输入；旧代码复现见 dev 沙盘日志） ----------
fs.mkdirSync(path.join(PROJECT_DIR, '产出'), { recursive: true });
const target = path.join(PROJECT_DIR, '产出', 'big-artifact.bin');
fs.writeFileSync(target, Buffer.alloc(BIG, 0x41));
const baseHash = shaFile(target);
const staged1 = path.join(SB, 'staged1.bin');
fs.writeFileSync(staged1, Buffer.alloc(BIG, 0x42));
const newHash1 = shaFile(staged1);
const rawCfg = Number((JSON.parse(fs.readFileSync(teamFile, 'utf8')).config || {}).codeMaxBytes);
ok('沙盘基线：历史 config.codeMaxBytes=65536（兼容归一的输入）', rawCfg === 65536, rawCfg);

// ---------- 入库版：沙盘复制仓库当前代码（apply 后即含修复）；--lib-dir 仅供 apply 前演练 ----------
const libOverride = (() => { const i = process.argv.indexOf('--lib-dir'); return i >= 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : ''; })();
if (libOverride) {
  for (const f of ['roles.mjs', 'store.mjs']) fs.copyFileSync(path.join(libOverride, f), path.join(TEAM, '工具', 'lib', f));
  console.log('[info] 已用 --lib-dir 覆盖沙盘 lib：' + libOverride);
}

// ---------- PM 要求③：历史 config=65536 兼容归一（loadTeam 读 8MB；saveTeam 后仍 65536） ----------
function probeShim(extra = {}) {
  try {
    const out = execFileSync(process.execPath, ['-e', "(async()=>{const fs=require('node:fs');const crypto=require('node:crypto');const {pathToFileURL}=require('node:url');const store=process.env.STORE_PATH;const teamFile=process.env.TEAM_FILE;const sha=(p)=>crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');const before=sha(teamFile);const mod=await import(pathToFileURL(store).href);const t=mod.loadTeam();const loaded=Number(t.config&&t.config.codeMaxBytes);mod.saveTeam(t);const after=sha(teamFile);const raw=Number((JSON.parse(fs.readFileSync(teamFile,'utf8')).config||{}).codeMaxBytes);console.log(JSON.stringify({ok:true,loadedCodeMaxBytes:loaded,fileCodeMaxBytes:raw,teamFileUnchanged:before===after,envOverride:process.env.TEAM_CODE_MAX_BYTES||'',defaultCodeMaxBytes:mod.DEFAULT_CODE_MAX_BYTES,legacyCodeMaxBytes:mod.LEGACY_CODE_MAX_BYTES}));})().catch((e)=>{console.error(String((e&&e.message)||e));process.exit(1)})"], {
      cwd: SB,
      env: env({ STORE_PATH: path.join(TEAM, '工具', 'lib', 'store.mjs'), TEAM_FILE: teamFile, ...extra }),
      encoding: 'utf8', windowsHide: true,
    });
    const m = /\{[\s\S]*\}/.exec(String(out));
    return m ? JSON.parse(m[0]) : null;
  } catch (e) {
    return { error: String(e.stdout || e.message).slice(0, 300) };
  }
}
function probeSingleSource() {
  const code = "(async()=>{const fs=require('node:fs');const path=require('node:path');const {pathToFileURL}=require('node:url');const dir=process.env.LIB_DIR;const roles=await import(pathToFileURL(path.join(dir,'roles.mjs')).href);const store=await import(pathToFileURL(path.join(dir,'store.mjs')).href);console.log(JSON.stringify({rolesDefault:roles.DEFAULT_CODE_MAX_BYTES,storeDefault:store.DEFAULT_CODE_MAX_BYTES,rolesLegacy:roles.LEGACY_CODE_MAX_BYTES,storeLegacy:store.LEGACY_CODE_MAX_BYTES,limits:roles.LIMITS.codeMaxBytes}));})().catch(e=>{console.error(String((e&&e.message)||e));process.exit(1)})";
  try {
    const out = execFileSync(process.execPath, ['-e', code], { env: env({ LIB_DIR: path.join(TEAM, '工具', 'lib') }), encoding: 'utf8', windowsHide: true });
    const m = /\{[\s\S]*\}/.exec(String(out));
    return m ? JSON.parse(m[0]) : null;
  } catch (e) { return { error: String(e.stdout || e.message).slice(0, 300) }; }
}
const shim1 = probeShim();
ok('兼容归一：旧 config=65536 时 loadTeam 读出 8MB', Boolean(shim1 && shim1.loadedCodeMaxBytes === 8 * 1024 * 1024), shim1);
ok('修复标记：store 导出 DEFAULT_CODE_MAX_BYTES=8MB 与 LEGACY_CODE_MAX_BYTES=65536', Boolean(shim1 && shim1.defaultCodeMaxBytes === 8 * 1024 * 1024 && shim1.legacyCodeMaxBytes === 65536), shim1);
const single = probeSingleSource();
ok('常量单源（T-f79c）：roles/store 的 DEFAULT/LEGACY 相等，且 LIMITS.codeMaxBytes 引用同一常量', Boolean(single && single.rolesDefault === single.storeDefault && single.rolesLegacy === single.storeLegacy && single.limits === 8 * 1024 * 1024), single);
ok('兼容归一：saveTeam 后团队.json 仍是 65536（不落盘，无 RULES_CHANGED）', Boolean(shim1 && shim1.fileCodeMaxBytes === 65536 && shim1.teamFileUnchanged === true), shim1);
ok('兼容归一：探针全程不改 团队.json', shaFile(teamFile) === teamShaBefore, { now: shaFile(teamFile), before: teamShaBefore });
const shim2 = probeShim({ TEAM_CODE_MAX_BYTES: '1048576' });
ok('env 覆盖：TEAM_CODE_MAX_BYTES=1MB 时 loadTeam 读 1MB', Boolean(shim2 && shim2.loadedCodeMaxBytes === 1048576), shim2);

const p1 = runJson(['propose', '--boot', prog2, '--project', PROJECT, '--task', taskId, '--file', `产出/big-artifact.bin=${staged1}`, '--expect', `产出/big-artifact.bin=${baseHash}`]);
const pid1 = p1.json && p1.json.proposal ? p1.json.proposal.id : '';
ok('修复后：>64KB 提案成功（不再 STAGED_TOO_BIG）', Boolean(pid1), p1.json || (p1.stderr + p1.stdout).slice(0, 300));
const pj1 = pid1 ? JSON.parse(fs.readFileSync(path.join(STATE, '提案', pid1, '提案.json'), 'utf8')) : null;
const f1 = pj1 && pj1.files && pj1.files[0];
ok('提案表记录字节数（files[].size > 64KB）', Boolean(f1 && Number(f1.size) >= BIG), f1 && { size: f1.size });
ok('propose 不改 团队.json（无 RULES_CHANGED）', shaFile(teamFile) === teamShaBefore, {});

if (pid1) {
  const flow = reviewShowSign(pid1, prog1, pm, 'B-9c49 大文件提案');
  ok('review（programmer1/pm）通过', Boolean(flow.r1.json && flow.r1.json.ok !== false && flow.r2.json && flow.r2.json.ok !== false), { r1: flow.r1.json, r2: flow.r2.json });
  ok('sign（pm）通过', Boolean(flow.s1.json && flow.s1.json.ok !== false), flow.s1.json || flow.s1.stderr.slice(0, 200));
  const apply = runJson(['apply', '--boot', pm, '--proposal', pid1, '--log', '9c49 沙盘大文件 apply']);
  ok('apply 成功', Boolean(apply.json && apply.json.ok !== false), apply.json || apply.stderr.slice(0, 200));
  ok('apply 后目标文件 = 提案 newHash', shaFile(target) === newHash1, { now: shaFile(target), expect: newHash1 });
  const commitId = apply.json && (apply.json.commitId || (apply.json.commit && apply.json.commit.id));
  const backupFile = commitId ? path.join(STATE, '备份', commitId, '产出', 'big-artifact.bin') : '';
  ok('apply 生成回滚备份（= baseHash）', Boolean(backupFile && fs.existsSync(backupFile) && shaFile(backupFile) === baseHash), { commitId, backupFile });

  // ---------- 回滚：故意在写入后失败，验证自动回滚 ----------
  const base2 = shaFile(target);
  const staged2 = path.join(SB, 'staged2.bin');
  fs.writeFileSync(staged2, Buffer.alloc(BIG, 0x43));
  const p2 = runJson(['propose', '--boot', prog2, '--project', PROJECT, '--task', taskId, '--file', `产出/big-artifact.bin=${staged2}`, '--expect', `产出/big-artifact.bin=${base2}`]);
  const pid2 = p2.json && p2.json.proposal ? p2.json.proposal.id : '';
  ok('回滚用例：第二提案建立', Boolean(pid2), p2.json || p2.stderr.slice(0, 200));
  if (pid2) {
    reviewShowSign(pid2, prog1, pm, 'B-9c49 回滚用例');
    const applyFail = runJson(['apply', '--boot', pm, '--proposal', pid2, '--log', '回滚演练', '--fail-after-backup']);
    ok('回滚用例：apply 按预期失败', applyFail.code !== 0 || (applyFail.json && applyFail.json.ok === false), { code: applyFail.code, json: applyFail.json });
    ok('回滚用例：目标文件恢复原内容', shaFile(target) === base2, { now: shaFile(target), expect: base2 });
    const events = fs.readFileSync(path.join(TEAM, '状态', '事件.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
    const rollbackEvt = events.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      .filter((e) => e.action === 'rollback' && String(e.target) === pid2);
    ok('回滚用例：事件留痕 action=rollback 且 ROLLED_BACK', rollbackEvt.length > 0 && /ROLLED_BACK/.test(String(rollbackEvt[rollbackEvt.length - 1].result)), rollbackEvt.slice(-1));
  }
}

// ---------- 小文件路径不回归 ----------
const smallTarget = path.join(PROJECT_DIR, '产出', 'small-note.txt');
fs.writeFileSync(smallTarget, 'v1\n');
const smallBase = shaFile(smallTarget);
const smallStaged = path.join(SB, 'small-staged.txt');
fs.writeFileSync(smallStaged, 'v2（小文件路径回归）\n');
const p3 = runJson(['propose', '--boot', prog2, '--project', PROJECT, '--task', taskId, '--file', `产出/small-note.txt=${smallStaged}`, '--expect', `产出/small-note.txt=${smallBase}`]);
const pid3 = p3.json && p3.json.proposal ? p3.json.proposal.id : '';
ok('小文件提案仍可用（不回归）', Boolean(pid3), p3.json || p3.stderr.slice(0, 200));

// ---------- env 覆盖：TEAM_CODE_MAX_BYTES 可配 ----------
const targetEnv = path.join(PROJECT_DIR, '产出', 'env-artifact.bin');
fs.writeFileSync(targetEnv, Buffer.alloc(BIG, 0x44));
const envBase = shaFile(targetEnv);
const envStaged = path.join(SB, 'env-staged.bin');
fs.writeFileSync(envStaged, Buffer.alloc(BIG, 0x45));
const envProbe = runJson(['propose', '--boot', prog2, '--project', PROJECT, '--task', taskId, '--file', `产出/env-artifact.bin=${envStaged}`, '--expect', `产出/env-artifact.bin=${envBase}`], { TEAM_CODE_MAX_BYTES: '100000' });
ok('env TEAM_CODE_MAX_BYTES 生效（100000 时 200KB 被拒，max=100000）', /STAGED_TOO_BIG/.test(envProbe.stdout + envProbe.stderr) && /100000/.test(envProbe.stdout + envProbe.stderr), (envProbe.stdout + envProbe.stderr).slice(0, 300));

// ---------- 汇总 ----------
const pass = results.filter((r) => r.ok).length;
const fail = results.length - pass;
const evidDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-b9c49');
fs.mkdirSync(evidDir, { recursive: true });
fs.writeFileSync(path.join(evidDir, 'proposal-large-file-run.json'), JSON.stringify({ at: new Date().toISOString(), task: 'B-20261115-152338-9c49', pass, fail, results }, null, 2) + '\n', 'utf8');
console.log(`\n=== B-9c49 提案暂存上限断言：${pass} 通过 / ${fail} 失败 ===`);
for (const r of results) if (!r.ok) console.log(`✗ ${r.name}  ${JSON.stringify(r.detail).slice(0, 300)}`);
process.exit(fail ? 1 : 0);
