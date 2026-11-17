/**
 * T-20261117-184114-4358 第二步夹具：30 分钟 skill 提示（可注入时间）+ skip reason + 四要素校验。
 *
 * 沙盘隔离（TEAM_ROOT / TEAM_PROJECTS_ROOT 指 _tmp），断言：
 *   P1 首次 boot → 简报出现「skill 提示」且 skill评估.jsonl 落 1 条 action=prompt；
 *   P2 立刻再 boot（同一注入时间）→ 不再提示（同窗口只一次），日志不增加；
 *   P3 时间推进 31 分钟 → 再次提示，日志 +1（阈值 30 分钟、不真等）；
 *   P4 skill skip 缺 --reason → SKILL_SKIP_REASON_REQUIRED；带 reason → 落 action=skip 行；
 *   P5 skill check 四要素齐全（用仓库真实 programmer1.md）→ ok；
 *   P6 skill check 缺「## 判据」→ SKILL_FORMAT_INCOMPLETE（缺项拒收）；
 *   P7 沙盘外真实 团队/skill/基础流程 未被本脚本改动（sha 前后一致）。
 *
 * 跑法：node scripts/test-bcae-skill-step2.cjs
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
const PROJECT = '沙盘技能2';
const SB = path.join(ROOT, '_tmp', `skillstep2-${process.pid}`);
const SB_TEAM = path.join(SB, '团队');
const SB_PROJECTS = path.join(SB, '项目');
const STATE = path.join(SB_TEAM, '状态', '项目', PROJECT);
const EVAL = path.join(STATE, 'skill评估.jsonl');
const BASE_MS = Date.parse('2026-11-17T20:00:00.000Z');

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
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const evalRows = () => (fs.existsSync(EVAL) ? fs.readFileSync(EVAL, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);

function seed() {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(SB_TEAM, '状态'), { recursive: true });
  fs.mkdirSync(SB_PROJECTS, { recursive: true });
  fs.cpSync(path.join(ROOT, '团队', '工具'), path.join(SB_TEAM, '工具'), { recursive: true });
  fs.cpSync(path.join(ROOT, '团队', 'skill'), path.join(SB_TEAM, 'skill'), { recursive: true });
  for (const f of ['团队宪法.md', '项目铁律.md']) {
    const src = path.join(ROOT, '团队', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(SB_TEAM, f));
  }
  const team = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8'));
  for (const m of team.members || []) { m.sessionId = ''; m.archivedSession = ''; m.replacedBySessionId = ''; m.sessionPrevSessionId = ''; }
  delete team.activeProject;
  fs.writeFileSync(path.join(SB_TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2));
}
function cli(args, envExtra = {}) {
  const env = { ...process.env, TEAM_ROOT: SB_TEAM, TEAM_PROJECTS_ROOT: SB_PROJECTS, TEAM_SELFTEST: '1', ...envExtra };
  try {
    return { ok: true, out: execFileSync(process.execPath, [path.join(SB_TEAM, '工具', 'team.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env }) };
  } catch (e) {
    return { ok: false, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
}
const realSkillBefore = (() => {
  const dir = path.join(ROOT, '团队', 'skill', '基础流程');
  const map = {};
  for (const n of fs.readdirSync(dir)) map[n] = sha(path.join(dir, n));
  return map;
})();

seed();
cli(['project', 'add', '--name', PROJECT, '--team-mode', 'full']);

check('P1 首次 boot → 出现 skill 提示，skill评估.jsonl 落 action=prompt', () => {
  const r = cli(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 's-s2'], { AWB_NOW_MS: String(BASE_MS) });
  assert.ok(r.ok, String(r.out).slice(0, 200) + String(r.err || '').slice(0, 200));
  assert.ok(/skill 提示/.test(r.out), '简报缺 skill 提示');
  const rows = evalRows();
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].action, 'prompt');
  return '提示 + 1 条 prompt';
});

check('P2 同窗口再 boot → 不再提示（日志不增加）', () => {
  const before = evalRows().length;
  const r = cli(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 's-s2'], { AWB_NOW_MS: String(BASE_MS + 5 * 60 * 1000) });
  assert.ok(!/skill 提示/.test(r.out), '5 分钟内又提示了（应只一次）');
  assert.strictEqual(evalRows().length, before);
  return 'cooldown 生效';
});

check('P3 推进 31 分钟 → 再次提示，日志 +1', () => {
  const before = evalRows().length;
  const r = cli(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 's-s2'], { AWB_NOW_MS: String(BASE_MS + 31 * 60 * 1000) });
  assert.ok(/skill 提示/.test(r.out), '到了 30 分钟却没提示');
  assert.strictEqual(evalRows().length, before + 1);
  return '窗口到期 → +1';
});

check('P4 skill skip 缺 reason → 拒；带 reason → 落 action=skip', () => {
  const boot = cli(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 's-s2'], { AWB_NOW_MS: String(BASE_MS + 32 * 60 * 1000) });
  const tok = (boot.out.match(/令牌:\s*([0-9a-f]+)/) || [])[1];
  assert.ok(tok, 'boot token 缺失');
  const before = evalRows().length;
  const bad = cli(['skill', 'skip', '--role', 'programmer1', '--project', PROJECT, '--boot', tok, '--reason', 'x'], { AWB_NOW_MS: String(BASE_MS) });
  assert.ok(/SKILL_SKIP_REASON_REQUIRED/.test(bad.err + bad.out), `单字 reason 应被拒：${bad.out}${bad.err}`);
  const good = cli(['skill', 'skip', '--role', 'programmer1', '--project', PROJECT, '--boot', tok, '--reason', '本轮无新建 skill'], { AWB_NOW_MS: String(BASE_MS) });
  assert.ok(/已跳过/.test(good.out), good.out + good.err);
  const rows = evalRows();
  assert.strictEqual(rows.length, before + 1);
  assert.strictEqual(rows[rows.length - 1].action, 'skip');
  return 'reason 必填 + skip 落盘';
});

check('P5 skill check 四要素齐全（真实 programmer1.md）→ ok', () => {
  const boot = cli(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 's-s2'], { AWB_NOW_MS: String(BASE_MS + 33 * 60 * 1000) });
  const tok = (boot.out.match(/令牌:\s*([0-9a-f]+)/) || [])[1];
  const rel = path.join(SB_TEAM, 'skill', '基础流程', 'programmer1.md');
  const r = cli(['skill', 'check', '--role', 'programmer1', '--project', PROJECT, '--boot', tok, '--file', rel], { AWB_NOW_MS: String(BASE_MS) });
  assert.ok(r.ok, `${r.out}${r.err}`);
  assert.ok(/四要素齐全/.test(r.out), r.out);
  return 'ok';
});

check('P6 skill check 缺「## 判据」→ SKILL_FORMAT_INCOMPLETE（缺项拒收）', () => {
  const boot = cli(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 's-s2'], { AWB_NOW_MS: String(BASE_MS + 34 * 60 * 1000) });
  const tok = (boot.out.match(/令牌:\s*([0-9a-f]+)/) || [])[1];
  const src = fs.readFileSync(path.join(SB_TEAM, 'skill', '基础流程', 'programmer1.md'), 'utf8');
  const broken = src.replace(/## 判据[\s\S]*?(?=\n## )/, '');
  const p = path.join(SB, 'broken-skill.md');
  fs.writeFileSync(p, broken, 'utf8');
  const r = cli(['skill', 'check', '--role', 'programmer1', '--project', PROJECT, '--boot', tok, '--file', p], { AWB_NOW_MS: String(BASE_MS) });
  assert.ok(/SKILL_FORMAT_INCOMPLETE/.test(r.out + r.err), `${r.out}${r.err}`);
  return '缺项拒收';
});

check('P7 真实 团队/skill/基础流程 未被改动（sha 前后一致）', () => {
  const dir = path.join(ROOT, '团队', 'skill', '基础流程');
  const map = {};
  for (const n of fs.readdirSync(dir)) map[n] = sha(path.join(dir, n));
  assert.deepStrictEqual(map, realSkillBefore);
  return Object.keys(map).length + ' 个文件未变';
});

fs.rmSync(SB, { recursive: true, force: true });
const pass = results.filter((r) => r.ok).length;
console.log(`\nSKILL_STEP2 ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
if (pass !== results.length) process.exit(1);
