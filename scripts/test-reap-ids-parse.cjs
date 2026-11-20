'use strict';
/**
 * B-reap-ids 夹具：`team.mjs task reap --ids` 的 id 解析。
 *
 * 缺陷背景（2026-11-20 Owner 要求彻底闭环）：
 *   旧实现 `const ids = asArray(args.ids).map(...)` 把整个 `--ids 'T-a,T-b'` 当一个 id，
 *   于是逗号分隔时两个 id 都不匹配，命令输出「处理 0，变化 0，NOOP 0」且**不报错**——静默无效（最危险）。
 *   同仓库其它命令（如 task done --evidence "a.md,b.md"）就是逗号分隔，这里必须对齐。
 *
 * 本夹具断言（4 条）：
 *   A1 逗号分隔两个存在的 open 任务 → 两条都变 cancelled；
 *   A2 空白分隔两个 → 同样；顺带验证「重复传 --ids（数组）也合并」；
 *   A3 混入一个不存在的 id → 存在的那条仍被 cancel，且输出含 missing 与那个 id（不再静默）；
 *   A4 单 id 旧用法 → 照旧可用。
 *
 * 沙盘：fs.mkdtempSync 独立根，只复制 `团队/工具`（不复制真实 团队/状态，那是 400MB+ 账本），
 *       `team.mjs init` 生成最小团队 → `project add --team-mode full` 生成项目脚手架 →
 *       `boot --role programmer1` 拿令牌 → 直接写 `团队/状态/项目/<P>/任务/<id>.json`。
 * 环境：TEAM_ROOT / TEAM_PROJECTS_ROOT / TEAM_WORKBENCH_JSON / AWB_DATA_DIR / TEAM_SELFTEST=1。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-reap-ids-'));
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TOOL = path.join(TEAM, '工具', 'team.mjs');
const PROJECT = 'reap-ids-沙盘';
const env = {
  ...process.env,
  TEAM_ROOT: TEAM,
  TEAM_PROJECTS_ROOT: PROJECTS,
  TEAM_WORKBENCH_JSON: path.join(SB, 'workbench.json'),
  AWB_DATA_DIR: path.join(SB, 'data'),
  TEAM_SELFTEST: '1',
};
delete env.DSH_SESSION_ID; // 不让宿主会话 id 混进沙盘令牌

const results = [];
function clip(v) {
  return String(typeof v === 'string' ? v : JSON.stringify(v)).replace(/\s+/g, ' ').slice(0, 260);
}
function check(id, name, ok, detail) {
  results.push({ id, name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${name}${ok ? '' : '  ← ' + clip(detail)}`);
  if (!ok) process.exitCode = 1;
}
function run(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
  return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || '') };
}
function runJson(args) {
  const r = run(args);
  try {
    return { ...r, json: JSON.parse(r.stdout) };
  } catch (e) {
    return { ...r, json: null, parseError: String((e && e.message) || e) };
  }
}
function cleanup() {
  if (process.env.AWB_KEEP_SANDBOX) {
    console.log(`\n[AWB_KEEP_SANDBOX=1] 沙盘保留：${SB}`);
    return;
  }
  try { fs.rmSync(SB, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); } catch { /* 清理失败不影响结论 */ }
}

function main() {
  // ---------- 沙盘骨架 ----------
  fs.mkdirSync(PROJECTS, { recursive: true });
  fs.cpSync(path.join(ROOT, '团队', '工具'), path.join(TEAM, '工具'), { recursive: true });
  const init = run(['init']);
  if (init.status !== 0) throw new Error(`init 失败：${init.stdout}${init.stderr}`);
  const add = run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--dir', path.join(PROJECTS, PROJECT), '--json']);
  if (add.status !== 0) throw new Error(`project add 失败：${add.stdout}${add.stderr}`);
  const boot = runJson(['boot', '--role', 'programmer1', '--project', PROJECT, '--json']);
  const token = (boot.json && (boot.json.token || (boot.json.boot && boot.json.boot.token))) || '';
  if (!token) throw new Error(`boot 未拿到令牌：${boot.stdout}${boot.stderr}`);

  // ---------- 任务 fixtures（直接写 任务/<id>.json 最省事、零 CLI 副作用） ----------
  const stateDir = path.join(TEAM, '状态', '项目', PROJECT);
  const taskDir = path.join(stateDir, '任务');
  fs.mkdirSync(taskDir, { recursive: true });
  const now = new Date().toISOString();
  function writeTask(id) {
    const row = {
      id, project: PROJECT, type: 'task', requirementId: '',
      title: `夹具任务 ${id}`, detail: 'README 夹具', acceptance: 'AC',
      priority: 'P3', priorityBy: 'pm', priorityReason: '',
      owner: null, status: 'open', createdBy: 'pm',
      createdAt: now, claimedAt: null, due: '', doneAt: null,
      evidence: '', rev: 1, history: [], workflow: { round: 1 },
    };
    fs.writeFileSync(path.join(taskDir, `${id}.json`), JSON.stringify(row, null, 2) + '\n', 'utf8');
  }
  const T1 = 'T-20261120-b001';
  const T2 = 'T-20261120-b002';
  const T3 = 'T-20261120-b003';
  const T4 = 'T-20261120-b004';
  const T5 = 'T-20261120-b005';
  const T6 = 'T-20261120-b006';
  const T7 = 'T-20261120-b007';
  const T8 = 'T-20261120-b008';
  const GHOST = 'T-20261120-dead'; // 从不创建：A3 用它验 missing 必须显式报
  for (const id of [T1, T2, T3, T4, T5, T6, T7, T8]) writeTask(id);
  const readStatus = (id) => {
    try { return JSON.parse(fs.readFileSync(path.join(taskDir, `${id}.json`), 'utf8')).status; } catch { return '(文件缺失)'; }
  };
  const cancelArgs = (idsArgs, reason) => ['task', 'reap', '--boot', token, '--project', PROJECT, ...idsArgs, '--reason', reason, '--json'];

  // ---------- A1 逗号分隔 ----------
  {
    const r = runJson(cancelArgs(['--ids', `${T1},${T2}`], '夹具 A1：逗号分隔'));
    const rows = (r.json && r.json.rows) || [];
    const ok = r.status === 0 && r.json && rows.length === 2
      && rows.every((x) => x.action === 'cancelled')
      && readStatus(T1) === 'cancelled' && readStatus(T2) === 'cancelled';
    check('A1', '逗号分隔两个 open 任务 → 两条都 cancelled', ok, { status: r.status, stdout: r.stdout, stderr: r.stderr, t1: readStatus(T1), t2: readStatus(T2) });
  }

  // ---------- A2 空白分隔（并顺带验证重复 --ids 合并） ----------
  {
    const r = runJson(cancelArgs(['--ids', `${T3}    ${T4}`], '夹具 A2：空白分隔'));
    const rows = (r.json && r.json.rows) || [];
    const okSpace = r.status === 0 && r.json && rows.length === 2
      && rows.every((x) => x.action === 'cancelled')
      && readStatus(T3) === 'cancelled' && readStatus(T4) === 'cancelled';
    // 重复传 --ids（parseArgs 会给数组）也要合并、去重且保序
    const r2 = runJson(cancelArgs(['--ids', T5, '--ids', T6], '夹具 A2：重复 --ids'));
    const rows2 = (r2.json && r2.json.rows) || [];
    const okRepeat = r2.status === 0 && r2.json && rows2.length === 2
      && rows2.every((x) => x.action === 'cancelled')
      && readStatus(T5) === 'cancelled' && readStatus(T6) === 'cancelled'
      && Array.isArray(r2.json.requestedIds) && r2.json.requestedIds.length === 2;
    check('A2', '空白分隔两个 → 都 cancelled；重复 --ids 也合并（去重保序）', okSpace && okRepeat, {
      space: { status: r.status, stdout: r.stdout, t3: readStatus(T3), t4: readStatus(T4) },
      repeat: { status: r2.status, stdout: r2.stdout, t5: readStatus(T5), t6: readStatus(T6) },
    });
  }

  // ---------- A3 混入不存在的 id：必须显式 missing ----------
  {
    // 人类文本口径（不 --json）：stdout 必须含 missing 与该 id
    const human = run(['task', 'reap', '--boot', token, '--project', PROJECT, '--ids', `${T7},${GHOST}`, '--reason', '夹具 A3：混入不存在 id']);
    // JSON 口径（再跑一次：T7 已是 cancelled → noop；missing 仍必须报）
    const r = runJson(cancelArgs(['--ids', `${T7},${GHOST}`], '夹具 A3：混入不存在 id（json）'));
    const text = `${human.stdout}${human.stderr}`;
    const missing = (r.json && r.json.missing) || [];
    const rows = (r.json && r.json.rows) || [];
    const ok = human.status === 0
      && /missing/i.test(text) && text.includes(GHOST)
      && readStatus(T7) === 'cancelled'
      && r.status === 0 && r.json && missing.includes(GHOST)
      && rows.every((x) => x.id !== GHOST);
    check('A3', '混入不存在 id → 存在的仍 cancel，且输出/返回含 missing 与该 id', ok, {
      humanStatus: human.status, humanOut: human.stdout, jsonStatus: r.status, json: r.json, stderr: r.stderr,
    });
  }

  // ---------- A4 单 id 旧用法 ----------
  {
    const r = runJson(cancelArgs(['--ids', T8], '夹具 A4：单 id 旧用法'));
    const rows = (r.json && r.json.rows) || [];
    const ok = r.status === 0 && r.json && rows.length === 1 && rows[0].id === T8 && rows[0].action === 'cancelled'
      && readStatus(T8) === 'cancelled'
      && Array.isArray(r.json.requestedIds) && r.json.requestedIds.length === 1 && r.json.requestedIds[0] === T8
      && Array.isArray(r.json.missing) && r.json.missing.length === 0;
    check('A4', '单 id 旧用法 → 照旧 cancelled（requestedIds=[id]、missing=[]）', ok, { status: r.status, stdout: r.stdout, stderr: r.stderr });
  }
}

try {
  main();
} catch (e) {
  check('SETUP', '沙盘/前置失败', false, String((e && e.message) || e));
} finally {
  const passed = results.filter((r) => r.ok).length;
  console.log(`\n${passed}/4 PASS`);
  cleanup();
}
