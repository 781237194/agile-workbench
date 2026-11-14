#!/usr/bin/env node
'use strict';

/**
 * R-20261115-030035-7841 · 独立测试环境沙盘（方案 A：独立 DSH_HOME + 团队根 + 数据目录）
 *
 * 目的：换人/轮换/名册/铁律/消息唤醒/迁移/批量状态等**破坏性或会发真实消息**的测试，
 * 一律在 `.sandbox/<run-id>/` 里跑，生产数据零改动（用运行前后 sha256 比对证明）。
 *
 * 子命令：
 *   seed   --root .sandbox/<id> [--team 团队] [--project 项目/工作台改造修复]
 *          复制团队根到沙盘、清空 members[].sessionId、写 sandbox.json（含真实文件基线哈希）
 *   run    --root .sandbox/<id> -- <命令...>
 *          在隔离环境里执行命令：DSH_HOME / TEAM_ROOT / TEAM_PROJECTS_ROOT / AWB_DATA_DIR 全指向沙盘，
 *          TEAM_SELFTEST=1（唯一有效开关，B-3c03）；路径越界直接 SANDBOX_PATH_OUTSIDE 退出
 *   verify --root .sandbox/<id>
 *          重算真实文件基线：有任何新增/修改 → SANDBOX_LEAK（退出码 4），否则 SANDBOX_OK
 *   clean  --root .sandbox/<id>
 *          仅删除 `--root` 在 .sandbox/ 下的沙盘目录（拒绝删其它路径）
 *
 * 用法示例：
 *   node scripts\sandbox\run.cjs seed --root .sandbox\sb-1
 *   node scripts\sandbox\run.cjs run --root .sandbox\sb-1 -- node -e "console.log(process.env.TEAM_ROOT)"
 *   node scripts\sandbox\run.cjs verify --root .sandbox\sb-1
 *   node scripts\sandbox\run.cjs clean --root .sandbox\sb-1
 *
 * 退出码：0 成功；2 用法/参数错误；3 SANDBOX_PATH_OUTSIDE；4 SANDBOX_LEAK；5 SANDBOX_SOURCE_MISSING；6 SANDBOX_DIRTY_ROSTER
 */
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const SANDBOX_BASE = path.join(ROOT, '.sandbox');
const REAL_TEAM = path.join(ROOT, '团队');
const REAL_DATA = path.join(ROOT, 'data');

function fail(code, message) {
  console.error(`[${code}] ${message}`);
  process.exit(code === 'SANDBOX_PATH_OUTSIDE' ? 3 : code === 'SANDBOX_LEAK' ? 4 : code === 'SANDBOX_SOURCE_MISSING' ? 5 : code === 'SANDBOX_DIRTY_ROSTER' ? 6 : 2);
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args.shift() || '';
  const out = { cmd, root: '', team: '', project: '', track: [], command: [] };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--') { out.command = args.slice(i + 1); break; }
    if (a === '--root') out.root = args[++i] || '';
    else if (a === '--team') out.team = args[++i] || '';
    else if (a === '--project') out.project = args[++i] || '';
    else if (a === '--track') out.track.push(args[++i] || '');
    else if (!out.command.length && !a.startsWith('--')) out.command.push(a);
  }
  return out;
}

function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
  catch { return ''; }
}

function assertInsideSandbox(target) {
  const abs = path.resolve(target);
  const base = SANDBOX_BASE.toLowerCase() + path.sep;
  if (!abs.toLowerCase().startsWith(base)) fail('SANDBOX_PATH_OUTSIDE', `拒绝运行：路径必须位于 ${SANDBOX_BASE} 下（收到 ${abs}）`);
  return abs;
}

function realFilesToTrack(projectDir) {
  const files = [];
  const push = (file) => { if (fs.existsSync(file)) files.push(file); };
  push(path.join(REAL_DATA, 'userdata', 'workbench.json'));
  push(path.join(REAL_TEAM, '状态', '团队.json'));
  const stateDir = path.join(REAL_TEAM, '状态', '项目');
  let names = [];
  try { names = fs.readdirSync(stateDir); } catch { names = []; }
  for (const name of names) {
    if (projectDir && path.basename(projectDir) && name !== path.basename(projectDir)) continue;
    push(path.join(stateDir, name, '工作流.json'));
    push(path.join(stateDir, name, '评审代管.json'));
  }
  return files;
}

function snapshotReal(files) {
  return files.map((file) => ({ file, sha256: sha256File(file), mtimeMs: fs.existsSync(file) ? fs.statSync(file).mtimeMs : 0 }));
}

function seed(args) {
  if (!args.root) fail('USAGE', 'seed 需要 --root .sandbox/<id>');
  const root = assertInsideSandbox(args.root);
  const team = path.resolve(args.team || REAL_TEAM);
  const projectDir = args.project ? path.resolve(args.project) : path.join(ROOT, '项目', '工作台改造修复');
  if (!fs.existsSync(team)) fail('SANDBOX_SOURCE_MISSING', `团队源不存在：${team}`);
  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });
  const dstTeam = path.join(root, '团队');
  fs.cpSync(team, dstTeam, { recursive: true, force: true });
  // 1) 清空名册 sessionId（第二道保险）
  const teamJson = path.join(dstTeam, '状态', '团队.json');
  if (fs.existsSync(teamJson)) {
    const doc = JSON.parse(fs.readFileSync(teamJson, 'utf8').replace(/^\uFEFF/, ''));
    doc.members = (Array.isArray(doc.members) ? doc.members : []).map((member) => ({ ...member, sessionId: '' }));
    fs.writeFileSync(teamJson, JSON.stringify(doc, null, 2) + '\n', 'utf8');
  }
  // 2) 二次校验：名册里不允许残留真实 sessionId
  if (fs.existsSync(teamJson)) {
    const doc = JSON.parse(fs.readFileSync(teamJson, 'utf8'));
    const dirty = (doc.members || []).filter((member) => String(member.sessionId || '').trim());
    if (dirty.length) fail('SANDBOX_DIRTY_ROSTER', `沙盘名册仍有 sessionId：${dirty.map((m) => m.role).join(',')}`);
  }
  // 3) 沙盘数据/DSH_HOME/项目根
  fs.mkdirSync(path.join(root, 'data', 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(root, 'dsh'), { recursive: true });
  fs.mkdirSync(path.join(root, '团队', '状态', '项目'), { recursive: true });
  // 4) 真实文件基线（verify 用来证明“生产零改动”）
  const tracked = realFilesToTrack(projectDir).concat(args.track.map((file) => path.resolve(file)).filter(Boolean));
  const baseline = snapshotReal(tracked);
  const meta = {
    schema: 1,
    id: path.basename(root),
    createdAt: new Date().toISOString(),
    root,
    sourceTeam: team,
    projectDir,
    env: {
      DSH_HOME: path.join(root, 'dsh'),
      TEAM_ROOT: path.join(root, '团队'),
      TEAM_PROJECTS_ROOT: path.join(root, '团队', '状态', '项目'),
      AWB_DATA_DIR: path.join(root, 'data'),
      TEAM_SELFTEST: '1',
    },
    baseline,
  };
  fs.writeFileSync(path.join(root, 'sandbox.json'), JSON.stringify(meta, null, 2) + '\n', 'utf8');
  console.log(JSON.stringify({ ok: true, code: 'SANDBOX_SEEDED', root, sessionIdsCleared: true, tracked: baseline.length }, null, 2));
}

function readMeta(root) {
  const file = path.join(root, 'sandbox.json');
  if (!fs.existsSync(file)) fail('USAGE', `沙盘未 seed：${file}`);
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function run(args) {
  if (!args.root) fail('USAGE', 'run 需要 --root .sandbox/<id>');
  if (!args.command.length) fail('USAGE', 'run 需要 -- <命令...>');
  const root = assertInsideSandbox(args.root);
  const meta = readMeta(root);
  const env = {
    ...process.env,
    ...meta.env,
    TEAM_SELFTEST: '1',
  };
  // 防止外部环境变量把路径带回真实根
  for (const key of ['DSH_HOME', 'TEAM_ROOT', 'TEAM_PROJECTS_ROOT', 'AWB_DATA_DIR']) {
    if (!String(env[key] || '').toLowerCase().startsWith(root.toLowerCase())) fail('SANDBOX_PATH_OUTSIDE', `${key} 必须指向沙盘：${env[key]}`);
  }
  const child = spawnSync(args.command[0], args.command.slice(1), { cwd: ROOT, env, stdio: 'inherit', windowsHide: false });
  process.exit(child.status === null ? 1 : child.status);
}

function verify(args) {
  if (!args.root) fail('USAGE', 'verify 需要 --root .sandbox/<id>');
  const root = assertInsideSandbox(args.root);
  const meta = readMeta(root);
  const now = snapshotReal(meta.baseline.map((row) => row.file));
  const leaked = [];
  for (let i = 0; i < now.length; i += 1) {
    const before = meta.baseline[i];
    const after = now[i];
    if (!before || !after) continue;
    if (before.sha256 !== after.sha256 || Number(before.mtimeMs) !== Number(after.mtimeMs)) {
      leaked.push({ file: path.relative(ROOT, after.file), before: { sha256: before.sha256.slice(0, 12), mtimeMs: before.mtimeMs }, after: { sha256: after.sha256.slice(0, 12), mtimeMs: after.mtimeMs } });
    }
  }
  if (leaked.length) {
    console.log(JSON.stringify({ ok: false, code: 'SANDBOX_LEAK', leaked }, null, 2));
    process.exit(4);
  }
  console.log(JSON.stringify({ ok: true, code: 'SANDBOX_OK', checked: now.length }, null, 2));
}

function clean(args) {
  if (!args.root) fail('USAGE', 'clean 需要 --root .sandbox/<id>');
  const root = assertInsideSandbox(args.root);
  if (root === path.resolve(SANDBOX_BASE)) fail('USAGE', '拒绝删除 .sandbox 根目录本身');
  if (!fs.existsSync(root)) { console.log(JSON.stringify({ ok: true, code: 'SANDBOX_ALREADY_GONE', root }, null, 2)); return; }
  fs.rmSync(root, { recursive: true, force: true });
  console.log(JSON.stringify({ ok: true, code: 'SANDBOX_CLEANED', root }, null, 2));
}

const args = parseArgs(process.argv);
if (args.cmd === 'seed') seed(args);
else if (args.cmd === 'run') run(args);
else if (args.cmd === 'verify') verify(args);
else if (args.cmd === 'clean') clean(args);
else fail('USAGE', '用法：node scripts\\sandbox\\run.cjs <seed|run|verify|clean> --root .sandbox\\<id> [-- 命令]');
