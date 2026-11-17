/**
 * B-20261117-181529-7b49 夹具：`req create` 必须同时建工作流行（否则面板/评审静默消失）。
 *
 * 断言：
 *   R1 沙盘 pm 建需求 → exit 0；
 *   R2 工作流.json requirements 里出现该 id，status=review（新需求默认相位）；
 *   R3 返回体带 workflowRow 路径且文件存在；
 *   R4 req list 能看到该需求（面板数据源）；
 *   R5 清理行后再建一条新需求，行数增量各 +1（不依赖旧行、不覆盖已有行）。
 *
 * 跑法：node scripts/test-7b49-req-create-row.cjs
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
const PROJECT = '沙盘7b49';
const SB = path.join(ROOT, '_tmp', `r7b49-${process.pid}`);
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
const env = () => ({ ...process.env, TEAM_ROOT: SB_TEAM, TEAM_PROJECTS_ROOT: SB_PROJECTS, TEAM_SELFTEST: '1' });
function cli(args) {
  try {
    const out = execFileSync(process.execPath, [path.join(SB_TEAM, '工具', 'team.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 180000, env: env() });
    const text = String(out);
    const idx = text.indexOf('{');
    return { ok: true, out: text, json: idx >= 0 ? JSON.parse(text.slice(idx)) : null };
  } catch (e) {
    const text = String(e.stdout || '');
    let json = null; try { const idx = text.indexOf('{'); json = idx >= 0 ? JSON.parse(text.slice(idx)) : null; } catch { json = null; }
    return { ok: false, out: text, err: String(e.stderr || ''), json };
  }
}
const wfFile = () => path.join(SB_TEAM, '状态', '项目', PROJECT, '工作流.json');
const wfRows = () => {
  const j = JSON.parse(fs.readFileSync(wfFile(), 'utf8'));
  return (j.requirements || j.state && j.state.requirements || {});
};

// 沙盘
fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(path.join(SB_TEAM, '状态'), { recursive: true });
fs.mkdirSync(SB_PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队', '工具'), path.join(SB_TEAM, '工具'), { recursive: true });
for (const f of ['团队宪法.md', '项目铁律.md', '经验教训登记册.md']) {
  const src = path.join(ROOT, '团队', f);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(SB_TEAM, f));
}
const team = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8'));
for (const m of team.members || []) { m.sessionId = ''; m.archivedSession = ''; m.replacedBySessionId = ''; m.sessionPrevSessionId = ''; }
delete team.activeProject;
fs.writeFileSync(path.join(SB_TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2));
assert.ok(cli(['project', 'add', '--name', PROJECT, '--team-mode', 'full']).ok, '沙盘 project add 失败');
const boot = cli(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-7b49']);
const token = (String(boot.out).match(/令牌:\s*([0-9a-f]+)/) || [])[1];
assert.ok(token, `沙盘 boot 失败：${boot.out.slice(0, 200)}${boot.err || ''}`);
cli(['lessons', 'read', '--role', 'pm', '--project', PROJECT, '--boot', token]); // 经验教训门（有登记册时要求先读）

let first = null;
check('R1 req create（pm）exit 0', () => {
  first = cli(['req', 'create', '--role', 'pm', '--project', PROJECT, '--boot', token, '--title', '夹具需求一', '--priority', 'P2', '--json']);
  assert.ok(first.ok, `${String(first.out || '').slice(0, 300)}${first.err || ''}`);
  assert.ok(first.json && first.json.ok === true);
  return first.json.requirement.id;
});

check('R2 工作流行已建：status=review', () => {
  const id = String(first.json.requirement.id);
  const rows = wfRows();
  const row = Object.values(rows).find((r) => r && String(r.id || '') === id);
  assert.ok(row, `工作流没有 ${id} 的行（keys=${Object.keys(rows).slice(0, 5)}）`);
  assert.strictEqual(row.status, 'review');
  assert.strictEqual(String(row.title || ''), '夹具需求一');
  return `status=${row.status}`;
});

check('R3 返回体 workflowRow 路径存在', () => {
  assert.ok(first.json.workflowRow && fs.existsSync(first.json.workflowRow), '缺 workflowRow 或文件不存在');
  return 'workflowRow 有';
});

check('R4 req list 可见该需求', () => {
  const r = cli(['req', 'list', '--role', 'pm', '--project', PROJECT, '--boot', token, '--json']);
  assert.ok(r.ok, String(r.out).slice(0, 200));
  const id = String(first.json.requirement.id);
  assert.ok((r.json.requirements || []).some((x) => String(x.id) === id), 'req list 里没有新需求');
  return 'list 可见';
});

check('R5 再建一条：行数 +1 且互不覆盖', () => {
  const before = Object.keys(wfRows()).length;
  const second = cli(['req', 'create', '--role', 'pm', '--project', PROJECT, '--boot', token, '--title', '夹具需求二', '--priority', 'P2', '--json']);
  assert.ok(second.ok, String(second.out).slice(0, 300));
  const after = wfRows();
  assert.strictEqual(Object.keys(after).length, before + 1, '行数未按 +1 增长');
  const id1 = String(first.json.requirement.id);
  const id2 = String(second.json.requirement.id);
  assert.strictEqual(String(Object.values(after).find((r) => String(r.id) === id1).title), '夹具需求一');
  assert.strictEqual(String(Object.values(after).find((r) => String(r.id) === id2).title), '夹具需求二');
  return `${before} → ${Object.keys(after).length}`;
});

fs.rmSync(SB, { recursive: true, force: true });
const pass = results.filter((r) => r.ok).length;
console.log(`\nR7B49_REQ_ROW ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
if (pass !== results.length) process.exit(1);
