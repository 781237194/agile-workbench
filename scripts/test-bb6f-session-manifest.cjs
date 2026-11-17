/**
 * B-20261117-210352-bb6f 夹具：PM 身份对齐同步第四处映射（项目/团队会话.json）。
 *
 * 断言：
 *   U1 文件缺失 → SESSION_MANIFEST_MISSING（不静默当成功）
 *   U2 JSON 坏 → SESSION_MANIFEST_INVALID
 *   U3 roles 里没有 pm → SESSION_MANIFEST_NO_PM
 *   U4 pm 已是目标会话 → ok 且 changed=false（幂等，不重写）
 *   U5 pm 不同 → 写回：pm 变为新会话、generatedAt 更新、其它角色原样、JSON 合法
 *   U6 写盘是 tmp+rename：写后不残留 .tmp-* 文件
 *   U7 空 sessionId → PM_SESSION_EMPTY（绝不把 pm 写成空）
 *   U8 真实项目 团队会话.json 与名册 pm 一致（对齐后四处口径的第四处不再漂移）
 *
 * 跑法：node scripts/test-bb6f-session-manifest.cjs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const ROOT = (() => {
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, '团队', '工具', 'team.mjs'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('找不到仓库根');
})();
const { syncTeamSessionManifest, sessionManifestPath } = require(path.join(ROOT, 'src', 'pm-identity-session-map.js'));
const SB = path.join(ROOT, '_tmp', `bb6f-${process.pid}`);
const FILE = path.join(SB, '团队会话.json');

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
const roles = (pm) => ([
  { role: 'pm', sessionId: pm },
  { role: 'product', sessionId: 'session-prod' },
  { role: 'programmer1', sessionId: 'session-p1' },
]);
const seed = (pm, extra = {}) => {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(SB, { recursive: true });
  fs.writeFileSync(FILE, JSON.stringify({ project: '沙盘', generatedAt: '2026-11-17T00:00:00.000Z', roles: roles(pm), ...extra }, null, 2) + '\n', 'utf8');
};

check('U1 缺文件 → SESSION_MANIFEST_MISSING', () => {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(SB, { recursive: true });
  const r = syncTeamSessionManifest(SB, 'session-new');
  assert.strictEqual(r.ok, false);
  assert.strictEqual(r.code, 'SESSION_MANIFEST_MISSING');
  return r.code;
});

check('U2 坏 JSON → SESSION_MANIFEST_INVALID', () => {
  fs.writeFileSync(FILE, '{ bad json', 'utf8');
  const r = syncTeamSessionManifest(SB, 'session-new');
  assert.strictEqual(r.code, 'SESSION_MANIFEST_INVALID');
  return r.code;
});

check('U3 roles 无 pm → SESSION_MANIFEST_NO_PM', () => {
  fs.writeFileSync(FILE, JSON.stringify({ roles: [{ role: 'tester', sessionId: 'session-t' }] }, null, 2), 'utf8');
  const r = syncTeamSessionManifest(SB, 'session-new');
  assert.strictEqual(r.code, 'SESSION_MANIFEST_NO_PM');
  return r.code;
});

check('U4 pm 已是目标 → changed=false（幂等）', () => {
  seed('session-pm-new');
  const r = syncTeamSessionManifest(SB, 'session-pm-new');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.changed, false);
  return 'ok/changed=false';
});

check('U5 pm 不同 → 写回新会话、generatedAt 更新、其它角色原样、JSON 合法', () => {
  seed('session-pm-old');
  const before = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  const r = syncTeamSessionManifest(SB, 'session-pm-new');
  assert.strictEqual(r.ok, true);
  assert.strictEqual(r.changed, true);
  const after = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.strictEqual(after.roles.find((x) => x.role === 'pm').sessionId, 'session-pm-new');
  assert.strictEqual(after.roles.find((x) => x.role === 'product').sessionId, 'session-prod');
  assert.strictEqual(after.roles.find((x) => x.role === 'programmer1').sessionId, 'session-p1');
  assert.notStrictEqual(after.generatedAt, before.generatedAt);
  assert.strictEqual(r.path === undefined, true); // 返回结构里用 file
  assert.strictEqual(path.basename(r.file), '团队会话.json');
  return `${String(r.from).slice(0, 8)}→${String(r.to).slice(0, 8)}，其它角色未动`;
});

check('U6 tmp+rename：写后不残留 .tmp-* 文件', () => {
  const leftovers = fs.readdirSync(SB).filter((n) => n.includes('.tmp-'));
  assert.deepStrictEqual(leftovers, []);
  return '无 tmp 残留';
});

check('U7 空 sessionId → PM_SESSION_EMPTY（不写空）', () => {
  seed('session-pm-old');
  const r = syncTeamSessionManifest(SB, '   ');
  assert.strictEqual(r.code, 'PM_SESSION_EMPTY');
  const after = JSON.parse(fs.readFileSync(FILE, 'utf8'));
  assert.strictEqual(after.roles.find((x) => x.role === 'pm').sessionId, 'session-pm-old');
  return r.code;
});

check('U8 真实项目：团队会话.json 的 pm 与名册一致（第四处不再漂移）', () => {
  const projectPath = path.join(ROOT, '项目', '工作台改造修复');
  const team = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8'));
  const rosterPm = String(((team.members || []).find((m) => String(m.role) === 'pm') || {}).sessionId || '');
  const manifestFile = sessionManifestPath(projectPath);
  assert.ok(fs.existsSync(manifestFile), '团队会话.json 不存在');
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const pmRow = (manifest.roles || []).find((r) => String(r.role) === 'pm') || {};
  assert.strictEqual(String(pmRow.sessionId || ''), rosterPm, `名册 pm=${rosterPm.slice(0, 10)} 团队会话.json=${String(pmRow.sessionId || '').slice(0, 10)}`);
  return 'pm 一致';
});

fs.rmSync(SB, { recursive: true, force: true });
const pass = results.filter((r) => r.ok).length;
console.log(`\nBB6F_SESSION_MAP ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
if (pass !== results.length) process.exit(1);
