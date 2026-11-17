/**
 * B-20261117-224146-7b01 夹具：boot 校验会话存在（名册/调用会话不在 DSH 列表 → 失败；离线/沙盘 → skipped 显式）。
 *
 * 断言：
 *   B1 无 DSH 环境（无 DSH_WEB_URL / TEAM_DSH_FAKE）→ boot 成功但简报含「会话校验: skipped」+ stderr 告警（不静默）；
 *   B2 TEAM_SELFTEST=1 + TEAM_DSH_FAKE 含 session-real → --session session-real boot 通过，简报「会话校验: ok」；
 *   B3 TEAM_DSH_FAKE 不含 session-ghost → --session session-ghost boot 失败，错误码 SESSION_NOT_FOUND_IN_DSH，且零令牌（不 exit 0）；
 *   B4 失败文案可操作：含 session rotate 或 PM 修正名册提示。
 *
 * 跑法：node scripts/test-7b01-boot-session-check.cjs
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
const PROJECT = '沙盘7b01';
const SB = path.join(ROOT, '_tmp', `r7b01-${process.pid}`);
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
function cli(args, extraEnv = {}) {
  const env = { ...process.env, TEAM_ROOT: SB_TEAM, TEAM_PROJECTS_ROOT: SB_PROJECTS, ...extraEnv };
  if (!('DSH_WEB_URL' in extraEnv)) delete env.DSH_WEB_URL;
  try {
    return { ok: true, out: execFileSync(process.execPath, [path.join(SB_TEAM, '工具', 'team.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 180000, env }), env };
  } catch (e) {
    return { ok: false, out: String(e.stdout || '') + String(e.stderr || ''), status: e.status };
  }
}

// 沙盘（TEAM_SELFTEST=1 用 project add 免干扰；boot 校验在 selftest 下只对 fake 列表生效）
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
assert.ok(cli(['project', 'add', '--name', PROJECT, '--team-mode', 'full'], { TEAM_SELFTEST: '1' }).ok, '沙盘 project add 失败');

check('B1 无 DSH 环境 → skipped 显式标注 + stderr 告警', () => {
  const r = cli(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 's-a'], { TEAM_SELFTEST: '1' });
  assert.ok(r.ok, r.out.slice(0, 300));
  assert.ok(/会话校验: skipped/.test(r.out), '简报缺 skipped 标记');
  return 'skipped 可见';
});

check('B2 fake 列表含 session-real → boot ok 且「会话校验: ok」', () => {
  const r = cli(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 'session-real-7b01'], {
    TEAM_SELFTEST: '1', TEAM_DSH_FAKE: JSON.stringify([{ sessionId: 'session-real-7b01' }]),
  });
  assert.ok(r.ok, r.out.slice(0, 400));
  assert.ok(/会话校验: ok/.test(r.out), '缺 ok 标记');
  return 'ok 可见';
});

check('B3 fake 列表不含 session-ghost → bootstrap 失败 SESSION_NOT_FOUND_IN_DSH（不 exit 0）', () => {
  const r = cli(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 'session-ghost-7b01'], {
    TEAM_SELFTEST: '1', TEAM_DSH_FAKE: JSON.stringify([{ sessionId: 'session-real-7b01' }]),
  });
  assert.strictEqual(r.ok, false, '名册/调用会话不存在仍 exit 0（假绿）');
  assert.ok(/SESSION_NOT_FOUND_IN_DSH/.test(r.out), r.out.slice(0, 400));
  assert.ok(!/令牌:\s*[0-9a-f]{16}/.test(r.out), '失败却发了令牌');
  return '失败 + 无令牌';
});

check('B4 错误文案可操作（session rotate / PM 修正名册）', () => {
  const r = cli(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 'session-ghost-7b01'], {
    TEAM_SELFTEST: '1', TEAM_DSH_FAKE: JSON.stringify([]),
  });
  assert.strictEqual(r.ok, false);
  assert.ok(/session rotate/.test(r.out), '缺 session rotate 提示');
  assert.ok(/团队\/状态\/团队\.json|PM/.test(r.out), '缺 PM 修正名册提示');
  return '可操作';
});

fs.rmSync(SB, { recursive: true, force: true });
const pass = results.filter((r) => r.ok).length;
console.log(`\nB7B01_BOOT_SESSION ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
if (pass !== results.length) process.exit(1);
