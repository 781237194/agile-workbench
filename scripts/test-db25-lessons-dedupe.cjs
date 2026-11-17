#!/usr/bin/env node
'use strict';
/**
 * test-db25-lessons-dedupe.cjs —— B-20261117-082019-db25 回归夹具
 *
 * 缺陷：`lessons append` 对同内容仍追加新行 → 登记册重复条目 + 审计噪声。
 * 修法：append 前按规范化文本（scene/lesson/next 三格，去空白/折叠连续空白/还原转义竖线）在本段内去重；
 *      命中 → noop：不写行、不写审计、文件 sha 不变，只回 skipped=1；turns 语义不变。
 *
 * 断言（沙盘项目 + 真实 CLI）：
 *   N1 首次 append → 写入 1 行，fileSha 变化，返回 wrote:true
 *   N2 同内容再 append → ok、noop:true、skipped:1、wrote:false，**文件 sha 与上一步相同**
 *   N3 审计行数不变（重复不写审计）
 *   N4 只差空白/多空格 → 仍判重复（规范化生效）
 *   N5 不同内容 → 正常追加新行（去重不误伤）
 *   N6 登记册里同内容条目只有 1 条（按行统计）
 *
 * 隔离：mkTempSandbox + TEAM_ROOT/TEAM_PROJECTS_ROOT/TEAM_WORKBENCH_JSON + TEAM_SELFTEST=1。
 * 用法：node scripts/test-db25-lessons-dedupe.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const ROOT = path.resolve(__dirname, '..');
const SB = mkTempSandbox('db25');
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench.json');
const TEAM_TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const PROJECT = '经验教训去重沙盘';

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); return; }
  fail += 1; console.log(`FAIL  ${name}  ` + JSON.stringify(detail || {}).slice(0, 300)); process.exitCode = 1;
}
const env = () => ({ ...process.env, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_WORKBENCH_JSON: STORE, TEAM_SELFTEST: '1' });
function runJson(args) {
  let out = '';
  try { out = String(execFileSync(process.execPath, [TEAM_TOOL, ...args], { encoding: 'utf8', env: env(), timeout: 120000, cwd: SB })); }
  catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }
  const i = out.indexOf('{');
  let json = null;
  if (i >= 0) { try { json = JSON.parse(out.slice(i)); } catch { json = null; } }
  return { out, json };
}
const sha = (p) => (fs.existsSync(p) ? crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex') : 'missing');

if (!fs.existsSync(TEAM_TOOL)) { console.error('环境错误：找不到 team.mjs'); process.exit(2); }

// 沙盘
fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
fs.mkdirSync(PROJECTS, { recursive: true });
const teamSrc = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8'));
for (const m of teamSrc.members || []) m.sessionId = '';
teamSrc.activeProjectId = '';
fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(teamSrc, null, 2) + '\n', 'utf8');
for (const rel of ['团队宪法.md', '项目铁律.md']) {
  const src = path.join(ROOT, '团队', rel);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TEAM, rel));
}
for (const d of ['协议', '模板']) {
  const s = path.join(ROOT, '团队', d);
  if (fs.existsSync(s)) fs.cpSync(s, path.join(TEAM, d), { recursive: true });
}
fs.cpSync(path.join(ROOT, '团队', '工具'), path.join(TEAM, '工具'), { recursive: true });

const add = runJson(['project', 'add', '--name', PROJECT, '--team-mode', 'fast', '--json']);
if (!add.json) { console.error('环境错误：project add 失败 ' + add.out.slice(0, 300)); process.exit(2); }
const boot = runJson(['boot', '--role', 'analyst', '--project', PROJECT, '--session', 's-an-db25', '--json']);
const T = String((boot.json && boot.json.token) || '');
if (!T) { console.error('环境错误：boot 无令牌 ' + boot.out.slice(0, 300)); process.exit(2); }

const lessonsFile = path.join(PROJECTS, PROJECT, '经验教训登记册.md');
const auditFile = path.join(TEAM, '状态', '经验教训审计.jsonl');
const auditLines = () => (fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').split(/\r?\n/).filter(Boolean).length : 0);
const scene = 'db25 夹具场景';
const lesson = '同内容不应重复入册';
const next = 'append 前按规范化文本去重';

// N1 首次
const a1 = runJson(['lessons', 'append', '--boot', T, '--project', PROJECT, '--scene', scene, '--lesson', lesson, '--next', next, '--json']);
const sha1 = sha(lessonsFile);
ok('N1 首次 append 写入（wrote:true / 文件 sha 变化）',
  a1.json && a1.json.ok === true && a1.json.wrote === true && sha1 !== 'missing', { json: a1.json, sha1: String(sha1).slice(0, 8) });

// N2 同内容再 append
const auditBefore = auditLines();
const a2 = runJson(['lessons', 'append', '--boot', T, '--project', PROJECT, '--scene', scene, '--lesson', lesson, '--next', next, '--json']);
const sha2 = sha(lessonsFile);
ok('N2 同内容再 append → noop/skipped:1/wrote:false 且文件 sha 不变',
  a2.json && a2.json.ok === true && a2.json.noop === true && a2.json.skipped === 1 && a2.json.wrote === false && sha2 === sha1,
  { json: a2.json, shaSame: sha2 === sha1 });

// N3 审计行数不变
ok('N3 重复 append 不写审计（审计行数不变）', auditLines() === auditBefore, { before: auditBefore, after: auditLines() });

// N4 只差首尾/多余空白 → 仍判重复（规范化只折叠连续空白，不改字面）
const a3 = runJson(['lessons', 'append', '--boot', T, '--project', PROJECT, '--scene', `  ${scene}   `, '--lesson', `${lesson}   `, '--next', `  ${next}`, '--json']);
ok('N4 仅首尾/多余空白差异 → 仍判重复（规范化生效）',
  a3.json && a3.json.noop === true && sha(lessonsFile) === sha1, { json: a3.json });

// N5 不同内容 → 正常追加
const a4 = runJson(['lessons', 'append', '--boot', T, '--project', PROJECT, '--scene', scene, '--lesson', '另一条不同的教训', '--next', '另一条不同的下一步', '--json']);
ok('N5 不同内容 → 正常追加（去重不误伤）',
  a4.json && a4.json.ok === true && a4.json.wrote === true && sha(lessonsFile) !== sha1, { json: a4.json });

// N6 同内容行只 1 条
const text = fs.readFileSync(lessonsFile, 'utf8');
const sameCount = text.split(/\r?\n/).filter((line) => line.includes(lesson) && !/deleted/.test(line)).length;
ok('N6 登记册里同内容条目仅 1 条', sameCount === 1, { sameCount });

fs.rmSync(SB, { recursive: true, force: true });
console.log(`\nLESSONS_DEDUPE ${JSON.stringify({ total: pass + fail, pass, fail })}`);
process.exit(fail ? 1 : 0);
