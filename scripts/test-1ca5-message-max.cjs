#!/usr/bin/env node
'use strict';
/**
 * B-20261118-163238-1ca5（P2）：messageMaxChars 非法值导致消息长度上限失效（NaN）或全量误拒（负数）。
 *
 * 修前（store.mjs sendMessage）：`const max = Number(team.config.messageMaxChars || 600)`：
 *   · 'abc' → NaN → `body.length > NaN` 恒 false ⇒ **上限形同不存在**（700 字照发）；
 *   · -5    → 任何非空正文都 > -5 ⇒ **所有消息被拒**。
 * 修后：`Number.isFinite(raw) && raw > 0 ? floor(raw) : 600`。
 *
 * 断言（四例 + 合法值不回归 + 隔离）：
 *   M1 缺失 → 600 上限（600 字可发 / 601 字 MESSAGE_TOO_LONG）
 *   M2 0    → 回落 600（同上）
 *   M3 'abc'（NaN）→ 回落 600（同上；修前此例 601 字会照发）
 *   M4 -5（负数）→ 回落 600（同上；修前此例 600 字会被拒）
 *   M5 合法值 800 → 700 字可发、900 字被拒（不得被回落成 600）
 *   M6 隔离：真实 团队/状态/团队.json 与 data/userdata/workbench.json 前后 sha256 不变
 *
 * 注意：team.config 进 rulesHash（{constitution,iron,roleCard,teamConfig}）——每次改配置后必须重新 boot
 * 拿新令牌，否则测到的是 RULES_CHANGED 而不是长度门（本夹具首版即踩此坑）。
 *
 * 跑法：node scripts/test-1ca5-message-max.cjs
 * 产出：AWB_1CA5_OUT（默认 程序员A/产出/证据-1ca5/run-1ca5.json）
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const ROOT = path.resolve(__dirname, '..');
const SB = mkTempSandbox('1ca5');
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench.json');
const TEAM_TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const PROJECT = '1ca5消息上限沙盘';
const EVID = process.env.AWB_1CA5_OUT ? path.resolve(process.env.AWB_1CA5_OUT) : path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-1ca5');
const TEAM_FILE = path.join(TEAM, '状态', '团队.json');
const SENDER = 'programmer1';
const SENDER_DIR = '程序员A';

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 420)}`);
}
const baseEnv = (extra = {}) => ({
  ...process.env,
  TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_WORKBENCH_JSON: STORE, TEAM_SELFTEST: '1',
  ...extra,
});
function run(args, extra = {}) {
  try {
    const out = execFileSync(process.execPath, [TEAM_TOOL, ...args], { encoding: 'utf8', env: baseEnv(extra), timeout: 120000, cwd: SB });
    return { code: 0, out: String(out), err: '' };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
}
function runJson(args, extra = {}) {
  const r = run(args, extra);
  const t = String(r.out || '').trim();
  const i = t.indexOf('{');
  let json = null;
  if (i >= 0) { try { json = JSON.parse(t.slice(i)); } catch { json = null; } }
  return { ...r, json };
}
const text = (r) => String(r.out || '') + String(r.err || '');
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return ''; } };
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const exists = (p) => fs.existsSync(p);

if (!exists(TEAM_TOOL)) { console.error('环境错误：找不到 team.mjs'); process.exit(2); }

const realTeamFile = path.join(ROOT, '团队', '状态', '团队.json');
const realStoreFile = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const beforeReal = { team: sha(realTeamFile), store: sha(realStoreFile) };

// ── 沙盘骨架
fs.mkdirSync(PROJECTS, { recursive: true });
fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
const teamSrc = readJson(realTeamFile);
for (const m of teamSrc.members || []) m.sessionId = '';
teamSrc.activeProjectId = '';
fs.writeFileSync(TEAM_FILE, JSON.stringify(teamSrc, null, 2) + '\n', 'utf8');
for (const rel of ['团队宪法.md', '项目铁律.md']) {
  const src = path.join(ROOT, '团队', rel);
  if (exists(src)) fs.copyFileSync(src, path.join(TEAM, rel));
}
const protoSrc = path.join(ROOT, '团队', '协议');
if (exists(protoSrc)) fs.cpSync(protoSrc, path.join(TEAM, '协议'), { recursive: true });
fs.cpSync(path.join(ROOT, '团队', '工具'), path.join(TEAM, '工具'), { recursive: true });

const addProject = runJson(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);

let token = '';
const bootSender = () => {
  const r = runJson(['boot', '--role', SENDER, '--project', PROJECT, '--session', 's-p1-1ca5', '--json']);
  token = String((r.json && r.json.token) || '');
  return { code: r.code, token: token ? 'ok' : 'missing', out: text(r).slice(0, 200) };
};
const firstBoot = bootSender();
console.log(`[setup] project add=${addProject.code} boot=${firstBoot.code} token=${firstBoot.token}`);

/** 改配置 → 重新 boot（config 进 rulesHash） */
const setMax = (value) => {
  const team = readJson(TEAM_FILE);
  team.config = team.config && typeof team.config === 'object' ? team.config : {};
  if (value === undefined) delete team.config.messageMaxChars;
  else team.config.messageMaxChars = value;
  fs.writeFileSync(TEAM_FILE, JSON.stringify(team, null, 2) + '\n', 'utf8');
  return bootSender();
};
const sendBody = (n) => runJson(['send', '--boot', token, '--to', 'pm', '--subject', '1ca5 探针', '--body', 'a'.repeat(n), '--json']);

function caseOf(label, value, { okLen = 600, tooLongLen = 601 } = {}) {
  const boot = setMax(value);
  const rOk = sendBody(okLen);
  const rLong = sendBody(tooLongLen);
  const tooLongBlocked = rLong.code !== 0 && /MESSAGE_TOO_LONG/.test(text(rLong));
  check(`${label}：${okLen} 字可发、${tooLongLen} 字返回 MESSAGE_TOO_LONG`,
    boot.code === 0 && rOk.code === 0 && tooLongBlocked,
    { boot, okCode: rOk.code, longCode: rLong.code, longOut: text(rLong).slice(0, 200), okOut: text(rOk).slice(0, 160) });
  return { value, okLen, tooLongLen, okCode: rOk.code, longCode: rLong.code };
}

const results = [];
results.push({ case: 'M1 缺失', ...caseOf('M1 缺失', undefined) });
results.push({ case: 'M2 0', ...caseOf('M2 0', 0) });
results.push({ case: "M3 'abc'（NaN，修前上限失效）", ...caseOf("M3 'abc'（NaN，修前上限失效）", 'abc') });
results.push({ case: 'M4 -5（修前所有消息被拒）', ...caseOf('M4 -5（修前所有消息被拒）', -5) });

// M5 合法值 800：700 字必须可发（不得回落成 600），900 字被拒
const m5boot = setMax(800);
const m5ok = sendBody(700);
const m5long = sendBody(900);
check('M5 合法值 800：700 字可发、900 字被拒（合法配置行为不变）',
  m5boot.code === 0 && m5ok.code === 0 && m5long.code !== 0 && /MESSAGE_TOO_LONG/.test(text(m5long)),
  { boot: m5boot, okCode: m5ok.code, longCode: m5long.code, longOut: text(m5long).slice(0, 160) });

// M6 隔离：真实状态零写入
const afterReal = { team: sha(realTeamFile), store: sha(realStoreFile) };
check('M6 隔离：真实 团队/状态/团队.json 与 data/userdata/workbench.json 前后 sha256 不变',
  afterReal.team === beforeReal.team && afterReal.store === beforeReal.store && Boolean(beforeReal.team),
  { before: beforeReal, after: afterReal });

try { fs.rmSync(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
fs.mkdirSync(EVID, { recursive: true });
const report = {
  task: 'B-20261118-163238-1ca5', at: new Date().toISOString(),
  total: passed + failures.length, pass: passed, red: failures.length, failures,
  cases: results,
  isolation: { realTeamUnchanged: sha(realTeamFile) === beforeReal.team, realStoreUnchanged: sha(realStoreFile) === beforeReal.store },
};
const outFile = path.join(EVID, 'run-1ca5.json');
fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`\nMESSAGE_MAX_CHARS ${failures.length === 0 ? 'OK' : 'FAIL'} ${JSON.stringify({ total: report.total, pass: report.pass, red: report.red })}`);
console.log('证据：' + outFile);
process.exit(failures.length ? 1 : 0);
