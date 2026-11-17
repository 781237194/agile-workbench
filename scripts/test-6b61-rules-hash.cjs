/**
 * T-20261117-211434-34e6（R-6b61-A）夹具：rulesHash 三项 / 铁律降级 / 提示面文案。
 *
 * 断言：
 *   G1 rulesHash 只含 constitution / roleCard / teamConfig（源码块内无 iron），且三项齐备；
 *   G2 boot 必读规格：核心 3 件（宪法/项目信息/角色卡），铁律 core:false 且不在「必读-核心已读」；
 *   G3 沙盘实测：改 **项目铁律** → 哈希 rules 不变，旧令牌仍可 send（不 RULES_CHANGED）；
 *   G4 沙盘实测：改 **团队宪法** → 哈希 rules 变化（令牌失效路径仍有效）；
 *   G5 提示面文案：dispatch/launch/team-tools/renderer/ops 里不再有「每轮都读 / 每轮必读 / 每次必读」旧口径；
 *   G6 提示面文案正向：dispatch 与 launch 都写明「团队宪法（唯一最高」；
 *   G7 铁律文档措辞：项目铁律与团队范本都不再说「改本文件→全员令牌失效」。
 *
 * 跑法：node scripts/test-6b61-rules-hash.cjs
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
const PROJECT = '沙盘6b61';
const SB = path.join(ROOT, '_tmp', `rh6b61-${process.pid}`);
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
const read = (p) => fs.readFileSync(p, 'utf8');

function seed() {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(SB_TEAM, '状态'), { recursive: true });
  fs.mkdirSync(SB_PROJECTS, { recursive: true });
  fs.cpSync(path.join(ROOT, '团队', '工具'), path.join(SB_TEAM, '工具'), { recursive: true });
  for (const f of ['团队宪法.md', '项目铁律.md', '协作准则.md', '团队宪法.md']) {
    const src = path.join(ROOT, '团队', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(SB_TEAM, f));
  }
  const team = JSON.parse(read(path.join(ROOT, '团队', '状态', '团队.json')));
  for (const m of team.members || []) { m.sessionId = ''; m.archivedSession = ''; m.replacedBySessionId = ''; m.sessionPrevSessionId = ''; }
  delete team.activeProject;
  fs.writeFileSync(path.join(SB_TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2));
}
function cli(args) {
  const env = { ...process.env, TEAM_ROOT: SB_TEAM, TEAM_PROJECTS_ROOT: SB_PROJECTS, TEAM_SELFTEST: '1' };
  try {
    return { ok: true, out: execFileSync(process.execPath, [path.join(SB_TEAM, '工具', 'team.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env }) };
  } catch (e) {
    return { ok: false, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
}
const bootHash = (out) => (String(out).match(/哈希 rules\s+([0-9a-f]+)/) || [])[1] || '';
const bootToken = (out) => (String(out).match(/令牌:\s*([0-9a-f]+)/) || [])[1] || '';

check('G1 rulesHash 只含 constitution / roleCard / teamConfig（无 iron）', () => {
  const src = read(path.join(ROOT, '团队', '工具', 'lib', 'store.mjs'));
  const m = src.match(/const rulesHash = sha256\(JSON\.stringify\(\{([\s\S]*?)\}\)\);/);
  assert.ok(m, '没找到 rulesHash 计算块');
  const body = m[1];
  for (const key of ['constitution', 'roleCard', 'teamConfig']) assert.ok(new RegExp(`\\b${key}:`).test(body), `缺 ${key}`);
  assert.ok(!/\biron\s*:/.test(body), 'rulesHash 里仍有 iron');
  assert.ok(!/iron/i.test(body), 'rulesHash 块内出现 iron 字样');
  return '三项齐备 / 无 iron';
});

check('G2 boot 必读规格：核心 3 件，铁律 core:false', () => {
  const src = read(path.join(ROOT, '团队', '工具', 'lib', 'scaffold.mjs'));
  const m = src.match(/export function bootDocSpecs\([\s\S]*?\n\}/);
  assert.ok(m, '没找到 bootDocSpecs');
  const body = m[0];
  const iron = body.match(/key: 'iron'[\s\S]{0,160}/);
  assert.ok(iron, '缺 iron 规格');
  assert.ok(/core: false/.test(iron[0]), `iron 仍 core:true：${iron[0]}`);
  const coreKeys = [...body.matchAll(/key: '(\w+)'[\s\S]{0,120}?core: true/g)].map((x) => x[1]);
  assert.strictEqual(coreKeys.length, 3, `core 应 3 件，实际 ${coreKeys.length}：${coreKeys.join(',')}`);
  return `core=${coreKeys.join('/')}`;
});

// 沙盘实测
seed();
const add = cli(['project', 'add', '--name', PROJECT, '--team-mode', 'full']);
assert.ok(/项目已建/.test(add.out), `项目未建：${add.out.slice(0, 200)}${add.err || ''}`);
const b1 = cli(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 's-6b61']);
const h1 = bootHash(b1.out);
const t1 = bootToken(b1.out);
assert.ok(h1 && t1, `首次 boot 缺哈希/令牌：${b1.out.slice(0, 200)}${b1.err || ''}`);

let ironHash = '';
let tokenStillWorks = false;
check('G3 改项目铁律 → 哈希 rules 不变，旧令牌仍可 send（不 RULES_CHANGED）', () => {
  const ironPath = path.join(SB_PROJECTS, PROJECT, '项目铁律.md');
  assert.ok(fs.existsSync(ironPath), '沙盘项目没有 项目铁律.md');
  fs.appendFileSync(ironPath, `\n- 夹具追加：改动铁律 ${Date.now()}（不应让令牌失效）\n`, 'utf8');
  const b2 = cli(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 's-6b61']);
  ironHash = bootHash(b2.out);
  assert.ok(ironHash, '二次 boot 缺哈希');
  assert.strictEqual(ironHash, h1, `改铁律后 rulesHash 变了：${h1} → ${ironHash}`);
  const send = cli(['send', '--role', 'programmer1', '--project', PROJECT, '--boot', t1, '--to', 'tester', '--subject', '改铁律后发送', '--body', '夹具']);
  tokenStillWorks = send.ok && /已发送/.test(send.out);
  assert.ok(tokenStillWorks, `旧令牌失效了：${send.out}${send.err || ''}`);
  return `hash 不变 ${h1.slice(0, 8)} + send ok`;
});

check('G4 改团队宪法 → 哈希 rules 变化（失效路径仍有效）', () => {
  const cons = path.join(SB_TEAM, '团队宪法.md');
  fs.appendFileSync(cons, `\n<!-- 夹具追加：${Date.now()} -->\n`, 'utf8');
  const b3 = cli(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 's-6b61']);
  const h3 = bootHash(b3.out);
  assert.ok(h3, '三次 boot 缺哈希');
  assert.notStrictEqual(h3, ironHash, '改宪法后 rulesHash 居然没变');
  return `${ironHash.slice(0, 8)} → ${h3.slice(0, 8)}`;
});

check('G5 提示面不再有「每轮都读 / 每轮必读 / 每次必读」旧口径', () => {
  const files = ['团队/工具/lib/dispatch.mjs', '团队/工具/launch.mjs', 'src/team-tools.js', 'src/renderer/app.js', '团队/工具/lib/ops.mjs'];
  const hits = [];
  for (const rel of files) {
    const text = read(path.join(ROOT, rel));
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      const t = line.trim();
      if (t.startsWith('//') || t.startsWith('*') || t.startsWith('/*')) return;
      if (/不纳入|不必|按需|旧流程|不当/.test(line)) return;
      if (/每轮都读|每轮必读|每次必读/.test(line)) hits.push(`${rel}:${i + 1}: ${line.trim().slice(0, 80)}`);
    });
  }
  assert.deepStrictEqual(hits, [], `仍有旧口径：\n${hits.join('\n')}`);
  return `${files.length} 个文件 0 命中`;
});

check('G6 dispatch 与 launch 都写「宪法唯一最高」', () => {
  for (const rel of ['团队/工具/lib/dispatch.mjs', '团队/工具/launch.mjs']) {
    const text = read(path.join(ROOT, rel));
    assert.ok(/唯一最高/.test(text), `${rel} 缺「唯一最高」表述`);
  }
  return '两处正向文案在';
});

check('G7 铁律文档不再说「改本文件→全员令牌失效」', () => {
  const bad = [];
  for (const rel of ['项目/工作台改造修复/项目铁律.md', '团队/项目铁律.md']) {
    const text = read(path.join(ROOT, rel));
    if (/改本文件\s*→\s*\*\*全员令牌失效/.test(text)) bad.push(rel);
    if (/才在 `rulesHash` 里/.test(text)) bad.push(`${rel}（旧 iron 表述）`);
  }
  assert.deepStrictEqual(bad, [], `旧措辞仍在：${bad.join('、')}`);
  return '两处措辞已更正';
});

fs.rmSync(SB, { recursive: true, force: true });
const pass = results.filter((r) => r.ok).length;
console.log(`\nRULE_HASH_6B61 ${JSON.stringify({ total: results.length, pass, red: results.length - pass, ironHashStable: Boolean(ironHash), tokenStillWorks })}`);
if (pass !== results.length) process.exit(1);
