/**
 * B-20261117-195929-7d73 夹具：普通 send 默认唤醒（R-45c7 AC1）+ 合并唤醒仅限 to=pm 非派单 + --no-wake 必须审计。
 *
 * 沙盘隔离（TEAM_ROOT / TEAM_PROJECTS_ROOT 指向 _tmp），不碰真实团队。
 * 断言：
 *   A 普通 send（不带 --wake/--ack）→ 唤醒日志出现收件人 reason=default、ok=true（不再「只投递」）；
 *   B1 非 PM 目标通知 + 合并窗口 60s → 不合并（无 MERGED_PENDING）；
 *   B2 to=pm 通知 + 合并窗口 60s → 合并（MERGED_PENDING）——合并仅限 to=pm 且非派单；
 *   B3 PM 派单（--ack --task）到角色 + 合并窗口 → 不合并（派单一律立即唤醒）；
 *   C --no-wake → 不产生唤醒行，且事件日志出现 wake_suppressed 审计。
 *
 * 跑法：node scripts/test-7d73-default-wake.cjs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
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
const PROJECT = '沙盘唤醒';
const SB = path.join(ROOT, '_tmp', `wake7d73-${process.pid}`);
const SB_TEAM = path.join(SB, '团队');
const SB_PROJECTS = path.join(SB, '项目');

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

function seed() {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(SB_TEAM, '状态'), { recursive: true });
  fs.mkdirSync(SB_PROJECTS, { recursive: true });
  fs.cpSync(path.join(ROOT, '团队', '工具'), path.join(SB_TEAM, '工具'), { recursive: true });
  for (const f of ['团队宪法.md', '项目铁律.md']) {
    const src = path.join(ROOT, '团队', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(SB_TEAM, f));
  }
  const team = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8'));
  for (const m of team.members || []) { m.sessionId = ''; m.archivedSession = ''; m.replacedBySessionId = ''; m.sessionPrevSessionId = ''; }
  delete team.activeProject;
  fs.writeFileSync(path.join(SB_TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2));
}

function env(extra = {}) {
  return { ...process.env, TEAM_ROOT: SB_TEAM, TEAM_PROJECTS_ROOT: SB_PROJECTS, TEAM_SELFTEST: '1', ...extra };
}
function cli(args, extraEnv = {}) {
  return execFileSync(process.execPath, [path.join(SB_TEAM, '工具', 'team.mjs'), ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 180000, env: env(extraEnv),
  });
}
const wakeRows = () => {
  const f = path.join(SB_TEAM, '状态', '项目', PROJECT, '唤醒.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};
const eventRows = () => {
  const dir = path.join(SB_TEAM, '状态', '项目', PROJECT);
  const out = [];
  for (const name of ['事件.jsonl', '审计.jsonl']) {
    const f = path.join(dir, name);
    if (!fs.existsSync(f)) continue;
    out.push(...fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { const j = JSON.parse(l); return { ...j, __file: name }; } catch { return null; } }).filter(Boolean));
  }
  return out;
};

seed();
cli(['project', 'add', '--name', PROJECT, '--team-mode', 'full']);
const bootPm = cli(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-wake-pm']);
const pmTok = (bootPm.match(/令牌:\s*([0-9a-f]+)/) || [])[1];
const bootTester = cli(['boot', '--role', 'tester', '--project', PROJECT, '--session', 's-wake-tester']);
const testerTok = (bootTester.match(/令牌:\s*([0-9a-f]+)/) || [])[1];
assert.ok(pmTok && testerTok, '沙盘 boot 失败');

// A 普通 send 默认唤醒
check('A 普通 send（无 --wake/--ack）→ 收件人 reason=default ok=true', () => {
  const before = wakeRows().length;
  const r = cli(['send', '--role', 'pm', '--project', PROJECT, '--boot', pmTok, '--to', 'tester', '--subject', '普通通知A', '--body', '继续做评测']);
  assert.ok(/已发送/.test(r), r.slice(0, 200));
  const rows = wakeRows().slice(before);
  const hit = rows.find((row) => String(row.to) === 'tester' && String(row.reason) === 'default');
  assert.ok(hit, `没有 tester reason=default 唤醒行：${JSON.stringify(rows.map((x) => [x.to, x.reason, x.ok, x.skipped]))}`);
  assert.strictEqual(hit.ok, true);
  return `${hit.skipped || 'delivered'} ok=true reason=default`;
});

// B1 非 PM 目标：合并窗口内也不合并
check('B1 合并窗口 60s + 目标 tester → 不合并（无 MERGED_PENDING）', () => {
  const before = wakeRows().length;
  cli(['send', '--role', 'pm', '--project', PROJECT, '--boot', pmTok, '--to', 'tester', '--subject', '通知B1', '--body', 'x'], { TEAM_WAKE_DEBOUNCE_MS: '60000' });
  cli(['send', '--role', 'pm', '--project', PROJECT, '--boot', pmTok, '--to', 'tester', '--subject', '通知B1b', '--body', 'y'], { TEAM_WAKE_DEBOUNCE_MS: '60000' });
  const rows = wakeRows().slice(before);
  assert.ok(rows.every((row) => String(row.skipped || '') !== 'MERGED_PENDING'), JSON.stringify(rows.map((x) => [x.to, x.skipped])));
  return '两拍都立即唤醒';
});

// B2 to=pm：合并仅限 to=pm 非派单 → 窗口内合并
check('B2 合并窗口 60s + 目标 pm（非派单）→ 合并（MERGED_PENDING）', () => {
  const before = wakeRows().length;
  cli(['send', '--role', 'tester', '--project', PROJECT, '--boot', testerTok, '--to', 'pm', '--subject', '通知B2', '--body', 'x'], { TEAM_WAKE_DEBOUNCE_MS: '60000' });
  cli(['send', '--role', 'tester', '--project', PROJECT, '--boot', testerTok, '--to', 'pm', '--subject', '通知B2b', '--body', 'y'], { TEAM_WAKE_DEBOUNCE_MS: '60000' });
  const rows = wakeRows().slice(before).filter((row) => String(row.to) === 'pm');
  assert.ok(rows.some((row) => String(row.skipped || '') === 'MERGED_PENDING'), JSON.stringify(rows.map((x) => [x.skipped, x.pending])));
  return 'to=pm 被合并（符合口径）';
});

// B3 PM 派单：即使窗口内也立即唤醒
check('B3 PM 派单（--ack --task）+ 合并窗口 → 不合并（派单立即唤醒）', () => {
  const cr = cli(['task', 'create', '--role', 'pm', '--project', PROJECT, '--boot', pmTok, '--title', '沙盘派单任务', '--priority', 'P2']);
  const tid = (cr.match(/T-\d{8}-\d{6}-[0-9a-f]{4}/) || [])[0];
  assert.ok(tid, `task create 失败：${cr.slice(0, 120)}`);
  const before = wakeRows().length;
  cli(['send', '--role', 'pm', '--project', PROJECT, '--boot', pmTok, '--to', 'tester', '--task', tid, '--ack', '--subject', '派单B3', '--body', 'z'], { TEAM_WAKE_DEBOUNCE_MS: '60000' });
  const rows = wakeRows().slice(before).filter((row) => String(row.to) === 'tester');
  assert.ok(rows.length >= 1, '没有 tester 唤醒行');
  assert.ok(rows.every((row) => String(row.skipped || '') !== 'MERGED_PENDING'), JSON.stringify(rows.map((x) => [x.skipped])));
  return '派单不合并';
});

// C 静默开关已被 Owner 删除（selftest 有 NO_WAKE_REMOVED 断言）：传了必须拒且零唤醒
check('C --no-wake 仍被拒（NO_WAKE_REMOVED，Owner 10:19 删开关），且零唤醒行', () => {
  const beforeWake = wakeRows().length;
  let err = '';
  try {
    cli(['send', '--role', 'pm', '--project', PROJECT, '--boot', pmTok, '--to', 'tester', '--subject', '静默C', '--body', 'n', '--no-wake']);
  } catch (e) { err = String(e.stdout || '') + String(e.stderr || ''); }
  assert.ok(/NO_WAKE_REMOVED/.test(err), `未返回 NO_WAKE_REMOVED：${err.slice(0, 200)}`);
  const added = wakeRows().slice(beforeWake).filter((row) => String(row.to) === 'tester');
  assert.strictEqual(added.length, 0, `被拒的发送仍产生唤醒：${JSON.stringify(added.map((x) => x.reason))}`);
  return 'NO_WAKE_REMOVED + 零唤醒';
});

fs.rmSync(SB, { recursive: true, force: true });
const pass = results.filter((r) => r.ok).length;
console.log(`\nDEFAULT_WAKE ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
if (pass !== results.length) process.exit(1);
