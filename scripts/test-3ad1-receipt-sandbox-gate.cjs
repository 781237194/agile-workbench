#!/usr/bin/env node
'use strict';
/**
 * B-20261118-163400-3ad1（P1，B 交叉审计 P1-1）：交接回执沙盘门禁与 rotate 口径统一。
 *
 * 修前：`session handover receipt` 在 TEAM_SELFTEST=1 且未设 TEAM_BOOT_ENFORCE=1 时 tokenRole='selftest'，
 *       白名单只认本人/pm/owner/product→pm ⇒ 沙盘里任何角色落回执必 PERMISSION_DENIED；
 *       而 `session rotate` 沙盘分支直接跳过权限 → 两路口径相反。
 * 修后：receipt 与 rotate 同一套路——沙盘且未 enforce → **显式豁免**（by=sandbox 可审计）；enforce=1 时门禁本体照拦。
 *
 * 断言：
 *   W1 沙盘未 enforce：无 --boot 落回执成功，回执行 by='sandbox'（显式豁免留痕）
 *   W2 口径一致：同一环境（沙盘未 enforce）rotate 也不要求 --boot（两路都放）
 *   W3 enforce=1 无 --boot → BOOT_REQUIRED
 *   W4 enforce=1 非授权角色（programmer1 给 pm 落）→ PERMISSION_DENIED
 *   W5 enforce=1 授权角色（pm 给 programmer1 落）→ 成功且 by='pm'
 *   W6 门禁失败零副作用：拒绝前后 交接回执.jsonl sha 不变
 *   W7 隔离：真实 团队/状态/团队.json 与 data/userdata/workbench.json 前后 sha256 不变
 *
 * 跑法：node scripts/test-3ad1-receipt-sandbox-gate.cjs
 * 产出：AWB_3AD1_OUT（默认 程序员A/产出/证据-3ad1/run-3ad1.json）
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const ROOT = path.resolve(__dirname, '..');
const SB = mkTempSandbox('3ad1');
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench.json');
const TEAM_TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const PROJECT = '3ad1回执沙盘';
const EVID = process.env.AWB_3AD1_OUT ? path.resolve(process.env.AWB_3AD1_OUT) : path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-3ad1');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 400)}`);
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

// ── 沙盘骨架（照 eba2 夹具）
const realTeamFile = path.join(ROOT, '团队', '状态', '团队.json');
const realStoreFile = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const beforeReal = { team: sha(realTeamFile), store: sha(realStoreFile) };

fs.mkdirSync(PROJECTS, { recursive: true });
fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
const teamSrc = readJson(realTeamFile);
for (const m of teamSrc.members || []) m.sessionId = '';
teamSrc.activeProjectId = '';
fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(teamSrc, null, 2) + '\n', 'utf8');
for (const rel of ['团队宪法.md', '项目铁律.md']) {
  const src = path.join(ROOT, '团队', rel);
  if (exists(src)) fs.copyFileSync(src, path.join(TEAM, rel));
}
const protoSrc = path.join(ROOT, '团队', '协议');
if (exists(protoSrc)) fs.cpSync(protoSrc, path.join(TEAM, '协议'), { recursive: true });
fs.cpSync(path.join(ROOT, '团队', '工具'), path.join(TEAM, '工具'), { recursive: true });

const addProject = runJson(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
console.log(`[setup] project add code=${addProject.code}`);

const stateDir = path.join(TEAM, '状态', '项目', PROJECT);
const projPath = path.join(PROJECTS, PROJECT);
const handoverOf = (roleDir) => path.join(projPath, roleDir, '产出', '交接-最新.md');
const writeHandover = (roleDir) => {
  const file = handoverOf(roleDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    `# 交接 · ${roleDir}`, '', '## 【在途任务】', '无在途任务', '', '## 【未闭环事项】', '无',
    '', '## 【最近决策】', '无', '', '## 【建议下一步】', '按交接执行', '', '## 【遗留问题与坑】', '无已知坑', '',
  ].join('\n'), 'utf8');
};
const receiptFile = path.join(stateDir, '交接回执.jsonl');
const receipts = () => (exists(receiptFile) ? fs.readFileSync(receiptFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);

writeHandover('程序员A');
writeHandover('项目经理');

/* W1 沙盘未 enforce：无 --boot 落回执成功，by=sandbox */
{
  const r = runJson(['session', 'handover', 'receipt', '--role', 'programmer1', '--project', PROJECT, '--json']);
  const row = receipts().filter((x) => x.role === 'programmer1').pop() || {};
  check('W1 沙盘未 enforce：无 --boot 落回执成功且 by=sandbox（显式豁免留痕）',
    r.code === 0 && row.by === 'sandbox' && Boolean(row.sha256) && Boolean(row.bytes),
    { code: r.code, row, out: text(r).slice(0, 260) });
}

/* W2 口径一致：同一环境 rotate 也不要求 --boot */
{
  const r = runJson(['session', 'rotate', '--role', 'programmer1', '--project', PROJECT, '--offline', '--session', 'session-3ad1-p1-new', '--json']);
  check('W2 口径一致：沙盘未 enforce 时 rotate 同样不需要 --boot（两条路径都放）',
    r.code === 0, { code: r.code, out: text(r).slice(0, 300) });
}

/* W3 enforce=1 无 --boot → BOOT_REQUIRED（门禁本体可强制） */
{
  const r = runJson(['session', 'handover', 'receipt', '--role', 'programmer1', '--project', PROJECT, '--json'], { TEAM_BOOT_ENFORCE: '1' });
  check('W3 enforce=1 无 --boot → BOOT_REQUIRED（门禁本体可强制）',
    r.code !== 0 && /BOOT_REQUIRED/.test(text(r)), { code: r.code, out: text(r).slice(0, 260) });
}

/* W4 enforce=1 非授权角色 → PERMISSION_DENIED 且零副作用 */
{
  const bootP1 = runJson(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 's-p1-3ad1', '--json']);
  const token = String((bootP1.json && bootP1.json.token) || '');
  const before = sha(receiptFile);
  const r = runJson(['session', 'handover', 'receipt', '--boot', token, '--role', 'pm', '--project', PROJECT, '--json'], { TEAM_BOOT_ENFORCE: '1' });
  check('W4 enforce=1 非授权角色（programmer1 给 pm 落回执）→ PERMISSION_DENIED 且零副作用',
    r.code !== 0 && /PERMISSION_DENIED/.test(text(r)) && sha(receiptFile) === before,
    { code: r.code, out: text(r).slice(0, 260), changed: sha(receiptFile) !== before });
}

/* W5 enforce=1 授权角色（pm 给 programmer1 落）→ 成功且 by=pm */
{
  const bootPm = runJson(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-pm-3ad1', '--json']);
  const token = String((bootPm.json && bootPm.json.token) || '');
  const r = runJson(['session', 'handover', 'receipt', '--boot', token, '--role', 'programmer1', '--project', PROJECT, '--json'], { TEAM_BOOT_ENFORCE: '1' });
  const row = receipts().filter((x) => x.role === 'programmer1').pop() || {};
  check('W5 enforce=1 授权角色（pm 给 programmer1 落回执）→ 成功且 by=pm',
    r.code === 0 && row.by === 'pm', { code: r.code, row, out: text(r).slice(0, 260) });
}

/* W6 门禁失败零副作用：W3/W4 已完成前后比对，这里再取整体回执条数 */
{
  const rows = receipts();
  check('W6 门禁失败零副作用：回执条数恰为 2（W1 sandbox + W5 pm），W3 无令牌与 W4 越权均未落行',
    rows.length === 2 && rows.every((x) => ['sandbox', 'pm'].includes(String(x.by))),
    { count: rows.length, rows: rows.map((x) => ({ role: x.role, by: x.by })) });
}

/* W7 隔离：真实状态零写入 */
{
  const afterReal = { team: sha(realTeamFile), store: sha(realStoreFile) };
  check('W7 隔离：真实 团队/状态/团队.json 与 data/userdata/workbench.json 前后 sha256 不变',
    afterReal.team === beforeReal.team && afterReal.store === beforeReal.store && Boolean(beforeReal.team),
    { before: beforeReal, after: afterReal });
}

try { fs.rmSync(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
fs.mkdirSync(EVID, { recursive: true });
const report = {
  task: 'B-20261118-163400-3ad1', at: new Date().toISOString(),
  total: passed + failures.length, pass: passed, red: failures.length, failures,
  isolation: { realTeamUnchanged: sha(realTeamFile) === beforeReal.team, realStoreUnchanged: sha(realStoreFile) === beforeReal.store },
};
const outFile = path.join(EVID, 'run-3ad1.json');
fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`\nRECEIPT_SANDBOX_GATE ${failures.length === 0 ? 'OK' : 'FAIL'} ${JSON.stringify({ total: report.total, pass: report.pass, red: report.red })}`);
console.log('证据：' + outFile);
process.exit(failures.length ? 1 : 0);
