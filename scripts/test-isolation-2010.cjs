/**
 * B-20261117-230147-2010 通用隔离夹具：layout / queue / owner 三个界面自检入口
 * 都必须「快照沙盘 + 真实树零写入」，且隔离校验失败时 fail fast（不自建第二套隔离）。
 *
 * 断言：
 *   I1 缺隔离拒绝（通用）：prepareSqCheckSandbox 收到真实 团队/ 或 项目/ 下路径 → 抛 SQ_CHECK_NOT_ISOLATED；
 *   I2 store 路径改指：沙盘内 projects[].path / workspace.path 全部改指沙盘项目目录；
 *   I3 三入口接线（静态）：main.js 里 layout 与 queue 都设 AWB_STORE+TEAM_ROOT+TEAM_PROJECTS_ROOT，
 *      owner 设 AWB_STORE+TEAM_ROOT；layout 复用 prepareSqCheckSandbox（不另造隔离）；
 *   I4 layout-check 实跑：exit 0（LAYOUT_OK）且真实 团队/状态/团队.json 与 项目/<P>/团队会话.json sha 前后不变；
 *   I5 queue-check 实跑：真实 团队.json 与项目 团队会话.json sha 前后不变；
 *   I6 owner-check 实跑：真实 团队.json、项目 团队会话.json、真实 workbench.json sha 前后不变。
 *
 * 跑法：node scripts/test-isolation-2010.cjs   （会起 Electron 窗口，约 1–2 分钟）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');

const ROOT = (() => {
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, '团队', '工具', 'team.mjs'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('找不到仓库根');
})();
const sha = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : 'missing');
const REAL_TEAM = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const PROJ_DIRS = (() => {
  try { return fs.readdirSync(path.join(ROOT, '项目'), { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch { return []; }
})();
const snapshotReal = () => ({
  team: sha(REAL_TEAM),
  store: sha(REAL_STORE),
  sessions: Object.fromEntries(PROJ_DIRS.map((n) => [n, sha(path.join(ROOT, '项目', n, '团队会话.json'))])),
});
const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS  ${name}${detail ? `  ${detail}` : ''}`);
  } catch (e) {
    results.push({ name, ok: false, error: String((e && e.message) || e) });
    console.log(`FAIL  ${name}\n      ${String((e && e.message) || e).split('\n')[0]}`);
  }
}
const SB = path.join(ROOT, '_tmp', `iso-2010-${process.pid}`);
fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(SB, { recursive: true });
const sq = require(path.join(ROOT, 'src', 'sq-check.js'));

check('I1 缺隔离拒绝：真实 团队/ 或 项目/ 路径 → SQ_CHECK_NOT_ISOLATED', () => {
  let threw = '';
  try {
    sq.prepareSqCheckSandbox({
      storeFile: path.join(ROOT, 'data', 'userdata', 'workbench.json'),
      teamRoot: path.join(ROOT, '团队'),
      sandboxProjectDir: path.join(SB, '项目'),
    });
  } catch (e) { threw = String((e && e.message) || e); }
  assert.ok(/SQ_CHECK_NOT_ISOLATED/.test(threw), `没有拒绝真实路径：${threw}`);
  return '拒绝';
});

check('I2 store 路径改指：projects[].path 全部落在沙盘项目目录', () => {
  const storeFile = path.join(SB, 'workbench.json');
  fs.copyFileSync(REAL_STORE, storeFile);
  const projRoot = path.join(SB, '项目');
  sq.prepareSqCheckSandbox({
    storeFile,
    teamRoot: path.join(SB, '团队'),
    fallbackStoreFile: REAL_STORE,
    sandboxProjectDir: projRoot,
  });
  const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  assert.ok(Array.isArray(store.projects) && store.projects.length, 'store 无项目');
  for (const p of store.projects) {
    assert.ok(String(p.path || '').startsWith(projRoot), `path 未改指：${p.path}`);
    if (p.workspace && p.workspace.path) assert.ok(String(p.workspace.path).startsWith(projRoot), `workspace.path 未改指：${p.workspace.path}`);
  }
  return `${store.projects.length} 项目`;
});

check('I3 三入口隔离接线（main.js 静态）', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const layoutStart = src.indexOf('if (IS_LAYOUT_CHECK) {');
  const sqStart = src.indexOf('if (IS_SQ_CHECK) {');
  assert.ok(layoutStart > 0 && sqStart > layoutStart, '找不到 layout/sql 隔离块');
  const layoutBlock = src.slice(layoutStart, sqStart);
  assert.ok(/AWB_STORE/.test(layoutBlock) && /TEAM_ROOT/.test(layoutBlock) && /TEAM_PROJECTS_ROOT/.test(layoutBlock), 'layout 隔离三变量不全');
  assert.ok(/prepareSqCheckSandbox/.test(layoutBlock), 'layout 未复用 prepareSqCheckSandbox');
  const queueBlock = src.slice(src.indexOf('if (IS_QUEUE_CHECK) {'), src.indexOf('// B-20261117-230147-2010'));
  for (const k of ['AWB_STORE', 'TEAM_ROOT', 'TEAM_PROJECTS_ROOT']) assert.ok(queueBlock.includes(k), `queue 缺 ${k}`);
  assert.ok(/if \(IS_OWNER_CHECK\)/.test(src), '缺 owner 块');
  assert.ok(/OWNER_CHECK_DATA, 'workbench.json'/.test(src) && /ownerSandboxTeamRoot/.test(src), 'owner 未设 AWB_STORE/TEAM_ROOT');
  return 'layout/queue/owner 三处';
});

function runCheck(flag, dataEnv, outEnv) {
  const env = { ...process.env, [dataEnv]: path.join(SB, dataEnv.toLowerCase()) };
  if (outEnv) env[outEnv] = path.join(SB, 'out-' + flag);
  return execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', flag], { cwd: ROOT, encoding: 'utf8', timeout: 300000, env });
}

check('I4 layout-check 实跑：LAYOUT_OK 且真实状态 sha 不变', () => {
  const before = snapshotReal();
  const out = runCheck('--layout-check', 'AWB_LAYOUT_DATA', 'AWB_LAYOUT_OUT');
  assert.ok(/LAYOUT_OK/.test(String(out)), 'layout 未输出 LAYOUT_OK');
  const after = snapshotReal();
  assert.deepStrictEqual(after, before, '真实状态被改写');
  return 'sha 全不变';
});

check('I5 queue-check 实跑：真实状态 sha 不变', () => {
  const before = snapshotReal();
  const out = runCheck('--queue-check', 'AWB_QUEUE_DATA');
  assert.ok(/QUEUE_CHECK|QUEUE_OK|queue/i.test(String(out)), 'queue-check 输出异常');
  const after = snapshotReal();
  assert.deepStrictEqual(after, before, '真实状态被改写');
  return 'sha 全不变';
});

check('I6 owner-check 实跑：真实 团队.json/团队会话/workbench sha 不变', () => {
  const before = snapshotReal();
  const out = runCheck('--owner-check', 'AWB_OWNER_DATA');
  assert.ok(/OWNER/.test(String(out)), 'owner-check 输出异常');
  const after = snapshotReal();
  assert.deepStrictEqual(after, before, '真实状态被改写');
  return 'sha 全不变';
});

fs.rmSync(SB, { recursive: true, force: true });
const pass = results.filter((r) => r.ok).length;
console.log(`\nISO_2010 ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
if (pass !== results.length) process.exit(1);
