'use strict';
/** R-bad3 回归：boot 自动化（单飞 / 复用 / 审计字段 / 失败告警去重）。 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', 'bad3-autoboot');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TEAM_TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = 'boot沙盘';
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 280)}`);
  if (!ok) process.exitCode = 1;
}
function run(args, allowFail = false) {
  try {
    const out = execFileSync(process.execPath, [TEAM_TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
    const t = String(out).trim();
    return JSON.parse(t.slice(t.indexOf('{')));
  } catch (e) {
    const text = String((e && e.stdout) || '') + String((e && e.stderr) || '');
    if (allowFail) { try { return JSON.parse(text.slice(text.indexOf('{'))); } catch { return { ok: false, raw: text.slice(0, 200) }; } }
    throw e;
  }
}
const auditRows = () => {
  const f = path.join(TEAM_ROOT, '状态', '项目', PROJECT, '自动boot.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};
const pmMessages = () => {
  const dir = path.join(TEAM_ROOT, '状态', '邮箱', 'pm');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      if (!name.endsWith('.json')) continue;
      try { out.push(JSON.parse(fs.readFileSync(full, 'utf8'))); } catch { /* ignore */ }
    }
  };
  walk(dir);
  return out;
};

fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true });
run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);

// ① 首次自动 boot：leader + booted
const b1 = run(['auto-boot', '--project', PROJECT, '--role', 'programmer1', '--session', 's-1', '--trigger', 'create', '--json']);
check('① 首次 auto-boot 成功且是 leader', b1.ok === true && b1.booted === true && b1.singleFlight === 'leader', b1);
const rows1 = auditRows();
const r1 = rows1[0] || {};
const requiredFields = ['at', 'role', 'sessionId', 'trigger', 'ok', 'why', 'tokenId', 'rulesHash', 'durationMs', 'docsRead', 'reused', 'skippedByHash', 'duringTask', 'singleFlight'];
const missingFields = requiredFields.filter((k) => !(k in r1));
check('① 审计字段齐全（14 个，含 duringTask 驼峰）', missingFields.length === 0, missingFields);
check('① 审计 tokenId 只有前 8 位、不写令牌全文', String(r1.tokenId || '').length === 8 && !JSON.stringify(r1).includes(b1.tokenId + 'x'), r1.tokenId);
check('① 审计 docsRead 是已读文件数组、leader 不重复读', Array.isArray(r1.docsRead) && r1.docsRead.length > 0 && r1.reused === false, r1.docsRead);

// ② 第二次：复用有效令牌，跳过读取
const b2 = run(['auto-boot', '--project', PROJECT, '--role', 'programmer1', '--session', 's-1', '--trigger', 'stale', '--json']);
check('② 已有有效令牌 → 复用不重跑（reused/skippedByHash）', b2.ok === true && b2.booted === false && b2.reused === true, b2);
const r2 = auditRows().slice(-1)[0] || {};
check('② 复用时 skippedByHash=true 且 docsRead 为空', r2.skippedByHash === true && Array.isArray(r2.docsRead) && r2.docsRead.length === 0, { skippedByHash: r2.skippedByHash, docsRead: r2.docsRead });

// ③ 单飞：同角色并发两路 → 只出现 1 条 leader
fs.rmSync(path.join(TEAM_ROOT, '状态', '项目', PROJECT, '自动boot.jsonl'), { force: true });
const tokenDir = path.join(TEAM_ROOT, '状态', '启动');
if (fs.existsSync(tokenDir)) for (const n of fs.readdirSync(tokenDir)) if (n.includes('programmer2') || true) { try { const j = JSON.parse(fs.readFileSync(path.join(tokenDir, n), 'utf8')); if (j.role === 'programmer2') fs.rmSync(path.join(tokenDir, n)); } catch { /* ignore */ } }
const spawnOne = () => spawn(process.execPath, [TEAM_TOOL, 'auto-boot', '--project', PROJECT, '--role', 'programmer2', '--session', 's-2', '--trigger', 'stale', '--json'], { cwd: SB, env });
const p1 = spawnOne();
const p2 = spawnOne();
Promise.all([new Promise((res) => p1.on('exit', res)), new Promise((res) => p2.on('exit', res))]).then(() => {
  const rows = auditRows().filter((row) => row.role === 'programmer2');
  const leaders = rows.filter((row) => row.singleFlight === 'leader').length;
  const hits = rows.filter((row) => row.singleFlight === 'hit').length;
  check('③ 单飞：并发两路只有 1 条 leader，其余 hit', leaders === 1 && hits >= 1, { leaders, hits, rows: rows.map((x) => ({ s: x.singleFlight, ok: x.ok })) });

  // ④ 失败告警 + 去重：未知角色 boot 必然失败
  const f1 = run(['auto-boot', '--project', PROJECT, '--role', 'no-such-role', '--session', 's-x', '--trigger', 'stale', '--json'], true);
  const failRows = auditRows().filter((row) => row.role === 'no-such-role');
  check('④ 失败 → 审计 ok=false 且带 why', f1.ok === false && failRows.length >= 1 && Boolean(failRows[0].why), { f1: f1.ok, failRows: failRows.length });
  const boots1 = pmMessages().filter((m) => m.type === 'boot_failed').length;
  check('④ 失败给 PM 发 boot_failed（1 条）', boots1 === 1, boots1);
  run(['auto-boot', '--project', PROJECT, '--role', 'no-such-role', '--session', 's-x', '--trigger', 'stale', '--json'], true);
  const boots2 = pmMessages().filter((m) => m.type === 'boot_failed').length;
  check('④ 同 dedupeKey 再次失败不重复发（窗口内仍 1 条）', boots2 === 1, boots2);

  // ── ⑤ B-5989：四类触发归因（trigger 不再恒 stale）──────────────────────
  // auto-boot.mjs 是 ESM，本脚本是 CJS：用子进程探针跑（env 带 TEAM_ROOT）。
  const AUTO_URL = require('node:url').pathToFileURL(path.join(TEAM_ROOT, '工具', 'lib', 'auto-boot.mjs')).href;
  function askAutoBoot(code) {
    const out = execFileSync(process.execPath, ['--input-type=module', '-e', `import * as m from '${AUTO_URL}';\n${code}`], { cwd: SB, env, encoding: 'utf8' });
    const text = String(out).trim();
    return JSON.parse(text.slice(text.indexOf('{')));
  }
  const mapping = askAutoBoot(`console.log(JSON.stringify({
    rotate: m.triggerForBoot('session_rotate'),
    create: m.triggerForBoot('project_create'),
    rules_changed: m.triggerForBoot('rules_hash'),
    stale: m.triggerForBoot('expired'),
    unknown: m.triggerForBoot('whatever'),
  }));`);
  check('⑤ triggerForBoot 映射：rotate/create/rules_changed/stale 四类', mapping.rotate === 'rotate' && mapping.create === 'create' && mapping.rules_changed === 'rules_changed' && mapping.stale === 'stale', mapping);
  check('⑤ 表外原因落 stale（不伪造归因）', mapping.unknown === 'stale', mapping.unknown);

  // create：新项目 + 从未 boot 过的角色 → 派单触发自动 boot，归因 create
  const FRESH = 'boot新建沙盘';
  run(['project', 'add', '--name', FRESH, '--team-mode', 'fast', '--json']);
  const freshPm = run(['boot', '--role', 'pm', '--project', FRESH, '--session', 'fb-pm', '--json']).token;
  const freshTask = run(['task', 'create', '--boot', freshPm, '--project', FRESH, '--type', 'task', '--title', '自动boot夹具任务', '--priority', 'P2', '--detail', '夹具', '--owner', 'programmer1', '--json'], true);
  const freshTaskId = freshTask && freshTask.task && freshTask.task.id;
  run(['send', '--boot', freshPm, '--project', FRESH, '--to', 'programmer1', '--subject', '派单夹具', '--body', '夹具派单', '--ack', '--task', freshTaskId || '', '--json'], true);
  const freshAudit = path.join(TEAM_ROOT, '状态', '项目', FRESH, '自动boot.jsonl');
  const freshRows = fs.existsSync(freshAudit) ? fs.readFileSync(freshAudit, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line)) : [];
  check('⑤ e2e create：新项目派单 → 自动boot.jsonl 记 trigger=create',
    freshRows.some((row) => row.role === 'programmer1' && row.trigger === 'create'), freshRows.map((row) => `${row.role}:${row.trigger}`));
  check('⑤ e2e create：boot 事件也带 autoBootTrigger=create', (() => {
    const evFile = path.join(TEAM_ROOT, '状态', '事件.jsonl');
    if (!fs.existsSync(evFile)) return false;
    const rows = fs.readFileSync(evFile, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
    return rows.some((row) => String(row.action) === 'boot' && row.project === FRESH && row.data && row.data.autoBoot === true && row.data.autoBootTrigger === 'create');
  })(), {});

  // ⑥ 推断：rules_changed / rotate / stale / create（夹具写令牌文件 + 名册会话）
  const bootsDir = path.join(TEAM_ROOT, '状态', '启动');
  fs.mkdirSync(bootsDir, { recursive: true });
  // 沙盘是从真实团队复制的，boots 里可能有该角色的真实令牌：先清掉，夹具才可判。
  for (const name of fs.readdirSync(bootsDir)) {
    if (!name.endsWith('.json')) continue;
    try {
      const row = JSON.parse(fs.readFileSync(path.join(bootsDir, name), 'utf8'));
      if (String(row.role || '') === 'programmer2') fs.rmSync(path.join(bootsDir, name), { force: true });
    } catch { /* 坏文件跳过 */ }
  }
  const writeToken = (role, { sessionId = '', rulesHash = '' } = {}) => {
    fs.writeFileSync(path.join(bootsDir, `fake-${role}.json`), JSON.stringify({ project: PROJECT, role, sessionId, rulesHash, token: 'fake', expiresAt: new Date(Date.now() + 3600000).toISOString() }, null, 2) + '\n', 'utf8');
  };
  const curHash = askAutoBoot('console.log(JSON.stringify({ h: m.currentRulesHash() }));').h;
  const infer = (role, sessionId) => askAutoBoot(`console.log(JSON.stringify({ t: m.inferBootTrigger('${PROJECT}','${role}','${sessionId}') }));`).t;
  // 名册会话（沙盘是从真实团队复制的，未清空 sessionId）——夹具按名册值构造，避免误落 rotate 分支。
  const rosterFile = path.join(TEAM_ROOT, '状态', '团队.json');
  const roster = JSON.parse(fs.readFileSync(rosterFile, 'utf8'));
  const boundOf = (role) => String(((roster.members || []).find((m) => m.role === role) || {}).sessionId || '');
  const p2Bound = boundOf('programmer2');
  const testerBound = boundOf('tester');
  writeToken('programmer2', { sessionId: p2Bound, rulesHash: 'deadbeef' });
  check('⑥ 推断 rules_changed：有历史令牌但 rules 哈希不符', infer('programmer2', p2Bound) === 'rules_changed', infer('programmer2', p2Bound));
  writeToken('programmer2', { sessionId: 's-old', rulesHash: curHash });
  const teamFile = rosterFile;
  const teamNow = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
  for (const member of teamNow.members || []) if (member.role === 'programmer2') member.sessionId = 's-new';
  fs.writeFileSync(teamFile, JSON.stringify(teamNow, null, 2) + '\n', 'utf8');
  check('⑥ 推断 rotate：令牌会话 ≠ 名册当前会话', infer('programmer2', 's-new') === 'rotate', infer('programmer2', 's-new'));
  for (const member of teamNow.members || []) if (member.role === 'programmer2') member.sessionId = 's-old';
  fs.writeFileSync(teamFile, JSON.stringify(teamNow, null, 2) + '\n', 'utf8');
  check('⑥ 推断 stale：令牌在、哈希对、会话同 → stale', infer('programmer2', 's-old') === 'stale', infer('programmer2', 's-old'));
  check('⑥ 推断 create：从来没有令牌 → create', infer('tester', testerBound) === 'create', infer('tester', testerBound));

  // ⑦ 回执链路：自动 boot 令牌 + 派单消息
  check('⑦ 回执链路：自动boot.jsonl 记 tokenId + 派单消息落盘', (() => {
    const tokenOk = freshRows.some((row) => row.role === 'programmer1' && String(row.tokenId || '').length === 8);
    const boxes = ['new', 'cur'];
    const mails = boxes.flatMap((box) => {
      const dir = path.join(TEAM_ROOT, '状态', '邮箱', 'programmer1', box);
      if (!fs.existsSync(dir)) return [];
      return fs.readdirSync(dir).map((n) => { try { return JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8')); } catch { return null; } }).filter(Boolean);
    });
    return tokenOk && mails.some((m) => String(m.subject || '').includes('派单夹具'));
  })(), {});

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nR-bad3 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
  fs.writeFileSync(path.join(SB, 'run-bad3.json'), JSON.stringify({ passed, failed, results }, null, 2) + '\n', 'utf8');
});
