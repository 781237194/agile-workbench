'use strict';
const { rmSandbox, uniqueSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/**
 * B-20261116-071224-9300 断言：团队根统一解析（环境隔离优先）。
 * - 静态：src/main.js 中旧表达式（layout.teamRoot||TEAM_ROOT）0 命中；resolveTeamRoot 调用点 ≥22。
 * - 运行：复制 团队 为「基线 A」与「沙盘 B」；以 TEAM_ROOT=B 起隔离实例 8 秒——
 *   B 的采样分片新增（说明写沙盘），A 的分片数量/总字节/最新 mtime 全不变（说明没回写「基线」）。
 * 注：真实 团队 正被 Owner 实例实时写分片，无法作为「不变」基线；A 副本代表旧代码会选中的目标。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = '工作台改造修复';
const SB = uniqueSandbox('9300');
const DATA = path.join(SB, 'data');
const A = path.join(SB, 'A-团队');
const B = path.join(SB, 'B-团队');
const PORT = Number(process.env.AWB_9300_PORT || 9435);
let pass = 0; let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}  ${JSON.stringify(detail).slice(0, 240)}`); process.exitCode = 1; }
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function shards(team) {
  const dir = path.join(team, '状态', '项目', PROJECT);
  let list = [];
  try { list = fs.readdirSync(dir).filter((f) => /^渲染内存-.*\.jsonl$/.test(f)).map((f) => path.join(dir, f)); } catch { return { count: 0, bytes: 0, mtime: 0, files: [] }; }
  const st = list.map((f) => fs.statSync(f));
  return { count: list.length, bytes: st.reduce((a, b) => a + b.size, 0), mtime: Math.max(0, ...st.map((s) => s.mtimeMs)), files: list };
}
function httpJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
  });
}

// ---------- 静态断言 ----------
const src = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const oldForms = [
  "(teamTools && teamTools.layout && teamTools.layout.teamRoot) || process.env.TEAM_ROOT",
  "(teamTools.layout && teamTools.layout.root) || process.env.TEAM_ROOT",
  "teamTools.layout.root + '",
];
const hitOld = oldForms.map((x) => (src.split(x).length - 1)).reduce((a, b) => a + b, 0);
ok('静态：旧「layout 优先于 TEAM_ROOT」表达式 0 命中', hitOld === 0, { hitOld });
const callSites = (src.match(/resolveTeamRoot\(\)/g) || []).length;
ok('静态：resolveTeamRoot 调用点 ≥22（含 1 处误计定义也无妨）', callSites >= 22, { callSites });
ok('静态：解析器 env 优先级 AWB_TEAM_ROOT > TEAM_ROOT', /AWB_TEAM_ROOT \|\| process\.env\.TEAM_ROOT/.test(src), null);

// ---------- 运行断言 ----------
rmSandbox(SB, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
fs.cpSync(path.join(ROOT, '团队'), A, { recursive: true, filter: (s) => !/[\\/]锁([\\/]|$)/.test(s) && !/[\\/]邮箱[\\/]/.test(s) });
fs.cpSync(A, B, { recursive: true });
for (const team of [A, B]) {
  const tile = path.join(team, '状态', '团队.json');
  const t = JSON.parse(fs.readFileSync(tile, 'utf8'));
  for (const m of t.members || []) m.sessionId = '';
  t.activeProject = PROJECT;
  fs.writeFileSync(tile, JSON.stringify(t, null, 2) + '\n', 'utf8');
}
// B 先清空分片，保证「新增」可判
for (const f of shards(B).files) fs.rmSync(f, { force: true });
const aBefore = shards(A);
const bBefore = shards(B);

fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
const realStore = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'userdata', 'workbench.json'), 'utf8'));
const project = (realStore.projects || []).find((p) => String(p.teamName || p.name || '') === PROJECT);
if (!project) throw new Error('no project');
realStore.projects = [{ ...project }];
realStore.activeProjectId = realStore.projects[0].id;
fs.writeFileSync(path.join(DATA, 'userdata', 'workbench.json'), JSON.stringify(realStore, null, 2) + '\n', 'utf8');

const env = { ...process.env, AWB_DATA_DIR: DATA, TEAM_ROOT: B, TEAM_PROJECTS_ROOT: path.join(B, '状态', '项目'), TEAM_WORKBENCH_JSON: path.join(DATA, 'userdata', 'workbench.json'), TEAM_SELFTEST: '1' };
const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], { cwd: ROOT, env, stdio: 'ignore', windowsHide: false });
(async () => {
  try {
    let target = null;
    for (let i = 0; i < 100 && !target; i += 1) {
      const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
      target = Array.isArray(list) ? list.find((x) => x && x.type === 'page' && String(x.url || '').includes('renderer/index.html')) : null;
      if (!target) await sleep(300);
    }
    ok('隔离实例已启动（renderer 可连）', Boolean(target), { port: PORT });
    if (target) await sleep(9000);
    const aAfter = shards(A);
    const bAfter = shards(B);
    ok('基线 A 分片三项不变（数量/总字节/最新 mtime）', aAfter.count === aBefore.count && aAfter.bytes === aBefore.bytes && aAfter.mtime === aBefore.mtime, { aBefore, aAfter });
    ok('沙盘 B 分片有新增（写入落到 TEAM_ROOT）', bAfter.count > bBefore.count || bAfter.bytes > bBefore.bytes, { bBefore, bAfter });
    fs.mkdirSync(path.join(ROOT, '项目', PROJECT, '程序员B', '产出', '证据-9300'), { recursive: true });
    fs.writeFileSync(path.join(ROOT, '项目', PROJECT, '程序员B', '产出', '证据-9300', 'run-9300.json'), JSON.stringify({ pass, fail, aBefore, aAfter, bBefore, bAfter }, null, 2) + '\n', 'utf8');
  } finally {
    try { child.kill(); } catch { /* */ }
  }
  console.log(`\nB-9300 断言：${pass} 通过 / ${fail} 失败`);
})().catch((e) => { console.error('RUN_FAILED', (e && e.stack) || e); process.exitCode = 1; });
