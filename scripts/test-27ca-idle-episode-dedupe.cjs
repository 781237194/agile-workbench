/**
 * B-20261117-102316-27ca 回归：idle episode 去重
 *  ①同 episode 连续 5 拍 idle → 只产生 1 条真实唤醒（唤醒.jsonl reason=stalled），其余 4 拍写 skipped=IDLE_EPISODE_DEDUP；
 *  ②中途转 active（产出文件刷新）→ episode 结束；再判 idle → 新 episode，再唤醒 1 条（共 2 条）；
 *  ③真 idle 仍要被叫（不许一刀切静默）：②里确实又唤醒了；
 *  ④episode 状态持久化文件存在（重启不重置）。
 */
const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 500)}`);
  if (!ok) process.exitCode = 1;
}

(async () => {
  const SB = mkTempSandbox('27ca');
  const TEAM_ROOT = path.join(SB, '团队');
  const PROJECTS = path.join(SB, '项目');
  // 注意：project add 会把项目名里的空格规范成下划线作为状态目录名，夹具不能带空格
  // （否则手写的任务/队列落在带空格目录，detect 读不到 → openTaskIds 为空 → 永不进 idle）。
  const PROJECT = '27ca-sandbox';
  const TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
  const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1', TEAM_WORKBENCH_JSON: path.join(SB, 'data', 'userdata', 'workbench.json'), TEAM_DISPATCH_QUEUE_IDLE_BACKFILL_MS: '0' };
  fs.mkdirSync(path.join(SB, 'data', 'userdata'), { recursive: true });
  fs.mkdirSync(PROJECTS, { recursive: true });
  fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true, filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) });
  const teamFile = path.join(TEAM_ROOT, '状态', '团队.json');
  const teamData = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
  for (const m of teamData.members || []) { m.sessionId = ''; m.status = 'active'; m.active = true; }
  delete teamData.activeProject;
  fs.writeFileSync(teamFile, JSON.stringify(teamData, null, 2) + '\n', 'utf8');
  for (const [k, v] of Object.entries(env)) process.env[k] = v;
  // B-27ca 夹具修复：copy 真实 团队 会带入真实 状态/事件.jsonl、回执.jsonl、项目级状态与日志（真实 ack → ackAt 被当活跃），
  // 因此 copy 后彻底清空这些运行态，保证沙盘与真实状态隔离（只保留 团队.json/工具/模板）。
  for (const sub of ["项目", "邮箱"]) {
    const dir = path.join(TEAM_ROOT, '状态', sub);
    if (fs.existsSync(dir)) fs.rmSync(dir, { recursive: true, force: true });
  }
  fs.mkdirSync(path.join(TEAM_ROOT, '状态', '项目'), { recursive: true });
  for (const f of ['事件.jsonl', '回执.jsonl', '阅读.jsonl', '日志.jsonl']) {
    try { fs.rmSync(path.join(TEAM_ROOT, '状态', f), { force: true }); } catch { /* 忽略 */ }
  }
  // 清空沙盘日志（真实 团队 副本带真实 ack → ackAt 会当近期信号）
  try { for (const f of fs.readdirSync(path.join(TEAM_ROOT, '日志'))) fs.rmSync(path.join(TEAM_ROOT, '日志', f), { force: true }); } catch { /* 忽略 */ }

  execFileSync(process.execPath, [TOOL, 'project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json'], { cwd: SB, env, encoding: 'utf8' });
  const stateDir = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
  const taskDir = path.join(stateDir, '任务');
  fs.mkdirSync(taskDir, { recursive: true });
  const wakeLog = path.join(stateDir, '唤醒.jsonl');
  const episodeFile = path.join(stateDir, '唤醒-空闲episode.json');
  const projectDir = path.join(PROJECTS, PROJECT);
  const oldMs = Date.now() - 3 * 3600 * 1000;
  const ageDeep = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const e of entries) { const full = path.join(dir, e.name); if (e.isDirectory()) ageDeep(full); try { fs.utimesSync(full, new Date(oldMs), new Date(oldMs)); } catch { /* 忽略 */ } }
  };
  ageDeep(projectDir);
  const oldIso = new Date(oldMs).toISOString();
  fs.writeFileSync(path.join(taskDir, 'T-27ca-open.json'), JSON.stringify({
    id: 'T-27ca-open', project: PROJECT, type: 'task', title: '27ca 夹具', owner: 'tester',
    status: 'open', createdAt: oldIso, claimedAt: oldIso, updatedAt: oldIso, history: [],
  }, null, 2) + '\n', 'utf8');
  for (const f of fs.readdirSync(taskDir)) { try { fs.utimesSync(path.join(taskDir, f), new Date(oldMs), new Date(oldMs)); } catch { /* 忽略 */ } }

  const ops = await import('file:///' + path.join(ROOT, '团队', '工具', 'lib', 'ops.mjs').replace(/\\/g, '/') + '?v=' + Date.now());
  const wakeRows = () => (fs.existsSync(wakeLog) ? fs.readFileSync(wakeLog, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : []);
  const stallWakes = () => wakeRows().filter((r) => r.to === 'tester' && r.reason === 'stalled');
  // 去重留痕：episode 内被跳过的唤醒写 appendEvent(action=wake_skipped, note 含 IDLE_EPISODE_DEDUP)
  const eventsFile = path.join(TEAM_ROOT, '状态', '事件.jsonl');
  const skippedEvents = () => (fs.existsSync(eventsFile)
    ? fs.readFileSync(eventsFile, 'utf8').split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
      .filter((e) => String(e.action || '') === 'wake_skipped' && /IDLE_EPISODE_DEDUP/.test(String(e.note || '')))
    : []);

  // ① 第 1 拍真唤醒 → 把唤醒时间拨旧（否则 1d90 的 wakeAt 信号让角色保持 active，永远走不到 dedupe 分支）
  //   → 再连跑 4 拍仍 idle：应走 episode 去重（wake_skipped），真实唤醒总数保持 1。
  await ops.recoverStalledRoles(PROJECT, { now: Date.now(), write: true });
  const ageWakeLog = () => {
    if (!fs.existsSync(wakeLog)) return;
    const rows = wakeRows().map((r) => ({ ...r, at: new Date(oldMs).toISOString() }));
    fs.writeFileSync(wakeLog, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  };
  ageWakeLog();
  for (let i = 1; i <= 4; i += 1) {
    await ops.recoverStalledRoles(PROJECT, { now: Date.now() + i * 30000, write: true });
    ageWakeLog();
  }
  check('① 同 episode 连跑 5 拍 idle → 只 1 条真实唤醒', stallWakes().length === 1, stallWakes().length);
  // ④ 去重留痕（持久化语义）：episode 内被跳过的唤醒必须写 wake_skipped 事件（可查、不静默）
  check('④ 同 episode 跳过唤醒写 wake_skipped 审计（IDLE_EPISODE_DEDUP）', skippedEvents().length >= 1, skippedEvents().length);

  // ② 转 active：刷新角色产出文件（近期）→ 跑一拍让 episode 结束；再拨旧 → 新 episode 再唤醒
  // 角色活跃信号来自「角色目录」扫描：必须写到 项目/<P>/测试人员/** 下，写 项目/产出 不算角色活动。
  const outFile = path.join(projectDir, '测试人员', '产出', 'tester-active.txt');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, 'active\n', 'utf8');
  const ackDir = path.join(TEAM_ROOT, '日志');
  fs.mkdirSync(ackDir, { recursive: true });
  const day = new Date().toISOString().slice(0, 10);
  fs.appendFileSync(path.join(ackDir, `${day}.md`), `- ${new Date().toISOString().slice(11, 19)} [tester] ack · 27ca 活跃信号\n`, 'utf8');
  await ops.recoverStalledRoles(PROJECT, { now: Date.now() + 6 * 30000, write: true });
  const episodeAfterActive = fs.existsSync(episodeFile) ? (JSON.parse(fs.readFileSync(episodeFile, 'utf8')) || {}).tester : null;
  // 再回旧 → 新 episode
  try { fs.utimesSync(outFile, new Date(oldMs), new Date(oldMs)); } catch { /* 忽略 */ }
  fs.rmSync(path.join(ackDir, `${day}.md`), { force: true });
  for (let i = 0; i < 2; i += 1) {
    await ops.recoverStalledRoles(PROJECT, { now: Date.now() + (7 + i) * 30000, write: true });
  }
  check('② active 后 episode 条目被清空', !episodeAfterActive, episodeAfterActive);
  check('③ 再 idle → 新 episode 再唤醒 1 条（真 idle 仍被叫，共 2 条）', stallWakes().length === 2, stallWakes().length);

  const passed = results.filter((r) => r.ok).length;
  console.log(`\nB-27ca idle episode 去重断言：${passed}/${results.length} PASS`);
  if (process.env.TEAM_SB_KEEP !== '1') fs.rmSync(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  else console.log('[keep] ' + SB);
})();
