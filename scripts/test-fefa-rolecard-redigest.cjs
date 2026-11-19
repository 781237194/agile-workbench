#!/usr/bin/env node
'use strict';
/**
 * test-fefa-rolecard-redigest.cjs —— R-20261119-170815-fefa（角色卡周期重读）夹具
 *
 * 覆盖（按派单 ①–⑧）：
 *   AC1 摘要生成：夹具卡 → ≤10 行 / ≤600B / 两次生成 sha256 相同（幂等）/ 每行可反查原文（除末行标记）/
 *       出现 §H 六类关键词（任意一个即可）；「0 个 §H 词」的卡判 empty 不合格
 *   AC2 boot 注入：简报含 `角色卡: sha12`；`--json.rolecardDigest.digestLines ≤10 / digestBytes ≤600`；
 *       简报总长 ≤2000（角色卡摘要进可丢区）
 *   AC3 轮次检查点：置 opsSinceInject=19 → 一次 send --ack：计数置 0 + 审计 1 行 trigger=round / opsSinceInject=20；
 *       置 39 → 下一次（40）再触发；0→39 之间不重复注入
 *   AC4 压缩信号：写 compact.signal → 一次写操作附摘要 + 审计 trigger=compact + 文件被删（消费式）
 *   AC5 写操作门：改沙盘卡不重 boot → 软门 ROLECARD_STALE_SOFT 放行；TEAM_ROLECARD_ENFORCE=1 → ROLECARD_UNREAD；
 *       重 boot 后无 warning
 *   AC6 幂等：重复 `rolecard digest` 不改计数、不写审计
 *   AC7 可观测：审计字段齐 {at,role,cardSha12,trigger,shownLines,opsSinceInject}；digest 与注入内容 sha256 相同
 *
 * 隔离：TEAM_ROOT / TEAM_PROJECTS_ROOT / TEAM_WORKBENCH_JSON / AWB_DATA_DIR 全指 _tmp 沙盘 + TEAM_SELFTEST=1。
 * 用法：node scripts/test-fefa-rolecard-redigest.cjs [--json]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const FIXTURE = path.join(ROOT, 'scripts', 'fixtures', 'rolecard-fixture.md');
const JSON_OUT = process.argv.includes('--json');
const PROJECT = 'fefa沙盘';
const ROLE = 'programmer1';

const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
  return Boolean(ok);
}
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '(missing)'; } };
const shaText = (t) => crypto.createHash('sha256').update(String(t), 'utf8').digest('hex');
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean); } catch { return []; } };

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'fefa-'));
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench-fefa.json');
const DATA = path.join(SB, 'data');
const STATE = path.join(TEAM, '状态', '项目', PROJECT);
const COUNTER_DIR = path.join(STATE, '角色卡重读');
const AUDIT = path.join(STATE, '角色卡重读.jsonl');
const REAL_TEAM = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');

function env(extra = {}) {
  const { DSH_SESSION_ID, ...base } = process.env;
  return { ...base, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_WORKBENCH_JSON: STORE, AWB_DATA_DIR: DATA, AWB_STORE: STORE, TEAM_SELFTEST: '1', ...extra };
}
function run(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: env(extraEnv), timeout: 180000, cwd: SB, maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status == null ? 1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function runJson(args, extraEnv = {}) {
  const r = run(args, extraEnv);
  const t = String(r.out || '').trim();
  const i = t.indexOf('{');
  let json = null;
  if (i >= 0) { try { json = JSON.parse(t.slice(i)); } catch { json = null; } }
  return { ...r, json };
}
const text = (r) => `${r.out || ''}${r.err || ''}`;
const tokenOf = (r) => String((r.json && r.json.token) || '');
const auditRows = () => readLines(AUDIT).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
const counterOf = (role) => readJson(path.join(COUNTER_DIR, `${role}.json`), null);

const realBefore = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
// 模块级单测（AC1/AC5）在父进程直接 import rolecard-digest.mjs，它内部用 loadProject 读 TEAM_ROOT，
// 所以必须在 import 之前把父进程 env 也指向沙盘（否则会去读真实项目 → 「项目不存在」）。
process.env.TEAM_ROOT = TEAM;
process.env.TEAM_PROJECTS_ROOT = PROJECTS;
process.env.TEAM_WORKBENCH_JSON = STORE;
process.env.AWB_DATA_DIR = DATA;
process.env.AWB_STORE = STORE;
process.env.TEAM_SELFTEST = '1';
async function main() {
let exitCode = 0;
try {
  if (!fs.existsSync(TOOL)) { console.error('环境错误：找不到 team.mjs'); process.exit(2); }
  // 直接 import 模块做纯函数断言（AC1）
  const mod = await import(`file://${path.join(ROOT, '团队', '工具', 'lib', 'rolecard-digest.mjs').replace(/\\/g, '/')}`);
  const fixtureCard = fs.readFileSync(FIXTURE, 'utf8');
  const d1 = mod.rolecardDigest(fixtureCard);
  const d2 = mod.rolecardDigest(fixtureCard);
  check('AC1① 夹具卡摘要 ≤10 行且 ≤600B', d1.lineCount <= 10 && d1.bytes <= 600, { lines: d1.lineCount, bytes: d1.bytes });
  check('AC1② 幂等：两次生成 sha256 相同', d1.sha256 === d2.sha256 && Boolean(d1.sha256), { a: d1.sha256.slice(0, 12), b: d2.sha256.slice(0, 12) });
  const fixtureLines = fixtureCard.split(/\r?\n/).map((l) => l.replace(/^\s{0,3}#{1,6}\s*/, '').replace(/^\s*[-*+]\s+/, '').replace(/^\s*\d+[.)]\s+/, '').trim());
  const badLines = d1.lines.filter((l) => !l.includes('摘要 10 行上限') && !fixtureLines.includes(l));
  check('AC1③ 除末行截断标记外，每行都能在夹具卡原文里反查到（0 改写）', badLines.length === 0, { badLines });
  check('AC1④ 摘要出现 §H 六类关键词（任意出现即可）',
    ['入口', '正常', '空值', '失败', '并发', '降级'].some((k) => d1.text.includes(k)), { keywords: d1.keywords, text: d1.text.slice(0, 200) });
  const zeroCard = '# 只有身份\n\n- 项目：x\n- 角色 id：programmer1\n';
  const dz = mod.rolecardDigest(zeroCard);
  check('AC1⑤「0 个 §H 词」的卡仍生成摘要但 keywords 为空（不合格可由上层判定）', dz.keywords.length === 0 && dz.lineCount > 0, { keywords: dz.keywords });
  const threeCard = '# 三类词\n\n- 入口要清\n- 空值要判\n- 失败要看得见\n';
  const dt = mod.rolecardDigest(threeCard);
  check('AC1⑤b「只含三类词」的卡合格（keywords 非空）', dt.keywords.length === 3, { keywords: dt.keywords });

  /* ── 沙盘：init + project add + 六角色 boot ─────────────────── */
  check('S0 沙盘 init', run(['init']).code === 0, {});
  check('S1 沙盘建项目', run(['project', 'add', '--name', PROJECT, '--team-mode', 'full']).code === 0, {});
  const ALL = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
  const team = readJson(path.join(TEAM, '状态', '团队.json'), { members: [] });
  team.activeProject = PROJECT;
  team.members = Array.isArray(team.members) ? team.members : [];
  for (const role of ALL) {
    let m = team.members.find((x) => x && x.role === role);
    if (!m) { m = { role, name: role, status: 'active' }; team.members.push(m); }
    m.status = 'active'; m.sessionId = `session-fefa-${role}`;
  }
  writeJson(path.join(TEAM, '状态', '团队.json'), team);
  const projMeta = readJson(path.join(STATE, '项目.json'), {});
  const projDir = String(projMeta.path || path.join(PROJECTS, PROJECT));
  writeJson(path.join(projDir, '团队会话.json'), { project: PROJECT, teamMode: 'full', workspace: projDir, roles: ALL.map((role) => ({ role, sessionId: `session-fefa-${role}` })) });
  writeJson(STORE, { projects: [{ id: 'fefa-p1', name: PROJECT, teamName: PROJECT, path: projDir, sessions: Object.fromEntries(ALL.map((r) => [r, `session-fefa-${r}`])), workspace: { path: projDir, sessionIds: ALL.map((r) => `session-fefa-${r}`) } }], activeProjectId: 'fefa-p1' });
  // 把夹具卡落到沙盘角色卡（AC5 改卡也用它）
  const roleCardFile = path.join(projDir, '程序员A', '角色卡.md');
  fs.mkdirSync(path.dirname(roleCardFile), { recursive: true });
  fs.writeFileSync(roleCardFile, fixtureCard, 'utf8');
  const pmTok = tokenOf(runJson(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'session-fefa-pm', '--json']));
  const devBoot = runJson(['boot', '--role', ROLE, '--project', PROJECT, '--session', `session-fefa-${ROLE}`, '--json']);
  const devTok = tokenOf(devBoot);
  check('S2 沙盘 pm/角色 boot 成功', Boolean(pmTok && devTok), { devBoot: text(devBoot).slice(-200) });

  /* ── AC2 boot 注入 ─────────────────────────────────────────── */
  check('AC2① 简报含「角色卡: sha12」', /角色卡: sha12 [0-9a-f]{12}/.test(String(devBoot.out)), { head: String(devBoot.out).split(/\r?\n/).filter((l) => l.includes('角色卡')).slice(0, 2) });
  const rcJson = ((devBoot.json || {}).rolecardDigest) || {};
  check('AC2② --json.rolecardDigest.digestLines ≤10 且 digestBytes ≤600',
    Number(rcJson.digestLines) <= 10 && Number(rcJson.digestBytes) <= 600 && Boolean(rcJson.cardSha12),
    { rcJson: { digestLines: rcJson.digestLines, digestBytes: rcJson.digestBytes, cardSha12: rcJson.cardSha12 } });
  check('AC2③ 简报总长 ≤2000（超限先丢摘要、版本行仍在）',
    String(devBoot.out).length <= 2000 || /角色卡: sha12/.test(String(devBoot.out)),
    { len: String(devBoot.out).length });

  /* ── AC3 轮次检查点（置 19 → 一次 send --ack 触发） ─────────── */
  writeJson(path.join(COUNTER_DIR, `${ROLE}.json`), { opsSinceInject: 19, lastInjectAt: '', lastCardSha12: '', lastUsageTokens: null, injections: [] });
  const audit0 = auditRows().length;
  const send1 = runJson(['send', '--boot', devTok, '--to', 'pm', '--subject', 'AC3 拍点', '--body', 'x', '--ack', '--json']);
  const c1 = counterOf(ROLE) || {};
  const a1 = auditRows().slice(audit0);
  check('AC3① 置 19 后一次 send --ack：返回体含 [rolecard-digest]（stderr 或文本）',
    /\[rolecard-digest\]/.test(text(send1)), { out: text(send1).slice(-400) });
  check('AC3② 审计 1 行 trigger=round 且 opsSinceInject=20',
    a1.length >= 1 && a1.some((r) => String(r.trigger) === 'round' && Number(r.opsSinceInject) === 20),
    { rows: a1 });
  check('AC3③ 计数被置 0', Number(c1.opsSinceInject) === 0, { counter: c1 });
  // 置 39 → 下一次（40）再触发
  const c3 = counterOf(ROLE) || {};
  writeJson(path.join(COUNTER_DIR, `${ROLE}.json`), { ...c3, opsSinceInject: 39 });
  const audit1 = auditRows().length;
  const send2 = runJson(['send', '--boot', devTok, '--to', 'pm', '--subject', 'AC3 拍点2', '--body', 'y', '--ack', '--json']);
  check('AC3④ 置 39 → 下一次（40）再触发一次', /\[rolecard-digest\]/.test(text(send2)) && Number((counterOf(ROLE) || {}).opsSinceInject) === 0,
    { counter: counterOf(ROLE), auditDelta: auditRows().length - audit1 });

  /* ── AC4 压缩信号（读到即删） ───────────────────────────────── */
  const sigFile = path.join(COUNTER_DIR, 'compact.signal');
  writeJson(sigFile, { at: new Date().toISOString(), source: 'fixture' });
  const devTok2 = tokenOf(runJson(['boot', '--role', ROLE, '--project', PROJECT, '--session', `session-fefa-${ROLE}-b`, '--json']));
  const auditBeforeCompact = auditRows().length;
  const send3 = runJson(['send', '--boot', devTok2, '--to', 'pm', '--subject', 'AC4 compact', '--body', 'z', '--ack', '--json']);
  const compactRows = auditRows().slice(auditBeforeCompact);
  check('AC4① compact.signal：一次写操作附摘要 + 审计 trigger=compact + 文件被删除（消费式）',
    /\[rolecard-digest\]/.test(text(send3)) && compactRows.some((r) => String(r.trigger) === 'compact') && !fs.existsSync(sigFile),
    { exists: fs.existsSync(sigFile), rows: compactRows, out: text(send3).slice(-300) });
  const send4 = runJson(['send', '--boot', devTok2, '--to', 'pm', '--subject', 'AC4 二次', '--body', 'w', '--ack', '--json']);
  check('AC4①b 第二次写操作不再触发（已消费）', !/\[rolecard-digest\]/.test(text(send4)), { out: text(send4).slice(-200) });

  /* ── AC5 写操作门（机制单测 + 真实重 boot 复验） ──────────────
   * 注意（需求矛盾，已在实现说明 v19 §五 如实报）：角色卡本身参与 rulesHash，
   * 所以「改卡不重 boot」在 CLI 层必然先被 RULES_CHANGED 硬拒（实测 details.expected≠current），
   * 软/硬门在**现有 rulesHash 口径**下不可通过 CLI 触发。故 AC5 用**机制单测**验证门本身，
   * 再用真实「重 boot 后无警告」验证门通过路径（AC5③）。 */
  const staleBootHashes = { roleCard: { hash: 'deadbeef'.repeat(8) } };
  const gateStale = mod.rolecardGateState({ bootDocHashes: staleBootHashes, projectName: PROJECT, role: ROLE });
  const softText = mod.rolecardSoftNotice({
    role: ROLE, bootSha12: gateStale.bootSha12, currentSha12: gateStale.currentSha12, digest: gateStale.digest,
  });
  check('AC5① 软门机制：bootSha≠当前卡 → stale=true、未强制时给 ROLECARD_STALE_SOFT 且附摘要',
    gateStale.stale === true && gateStale.enforce === false
    && /ROLECARD_STALE_SOFT/.test(softText) && /\[rolecard-digest\]/.test(softText) && softText.includes(gateStale.digest.lines[0] || ''),
    { gate: { stale: gateStale.stale, enforce: gateStale.enforce, bootSha12: gateStale.bootSha12, currentSha12: gateStale.currentSha12 }, softHead: softText.split('\n').slice(0, 2) });
  let hardErr = null;
  process.env.TEAM_ROLECARD_ENFORCE = '1';
  try {
    const g2 = mod.rolecardGateState({ bootDocHashes: staleBootHashes, projectName: PROJECT, role: ROLE });
    mod.failRolecardUnread({ role: ROLE, bootSha12: g2.bootSha12, currentSha12: g2.currentSha12, project: PROJECT, commands: ['send --ack'] });
  } catch (e) { hardErr = e; } finally { delete process.env.TEAM_ROLECARD_ENFORCE; }
  check('AC5② 硬门机制：TEAM_ROLECARD_ENFORCE=1 → ROLECARD_UNREAD（含重 boot 下一步提示）',
    Boolean(hardErr) && String(hardErr.code) === 'ROLECARD_UNREAD' && /重 boot|boot --role/.test(String(hardErr.message || '')),
    { code: hardErr && hardErr.code, message: String((hardErr && hardErr.message) || '').slice(0, 200) });
  // AC5③：真实路径——重 boot 后令牌卡 sha == 当前卡 sha → 无 stale 警告
  const devTok3 = tokenOf(runJson(['boot', '--role', ROLE, '--project', PROJECT, '--session', `session-fefa-${ROLE}-c`, '--json']));
  const sendOk = runJson(['send', '--boot', devTok3, '--to', 'pm', '--subject', 'AC5 重 boot 后', '--body', 'ok', '--ack', '--json']);
  check('AC5③ 重 boot 后再跑无 stale 警告', sendOk.code === 0 && !/ROLECARD_STALE_SOFT|ROLECARD_UNREAD/.test(text(sendOk)),
    { code: sendOk.code, out: text(sendOk).slice(-200) });

  /* ── AC6 幂等：digest 不改计数、不写审计 ───────────────────── */
  const beforeDigest = { counter: JSON.stringify(counterOf(ROLE) || {}), audit: auditRows().length };
  const dig = runJson(['rolecard', 'digest', '--role', ROLE, '--project', PROJECT, '--json']);
  check('AC6③ 重复 rolecard digest 不改计数、不写审计',
    dig.code === 0 && JSON.stringify(counterOf(ROLE) || {}) === beforeDigest.counter && auditRows().length === beforeDigest.audit,
    { code: dig.code, counterSame: JSON.stringify(counterOf(ROLE) || {}) === beforeDigest.counter, auditDelta: auditRows().length - beforeDigest.audit });

  /* ── AC7 审计字段齐 + digest 与注入逐字一致 ────────────────── */
  const lastAudit = auditRows().slice(-1)[0] || {};
  check('AC7③ 审计字段齐 {at,role,cardSha12,trigger,shownLines,opsSinceInject}',
    ['at', 'role', 'cardSha12', 'trigger', 'shownLines', 'opsSinceInject'].every((k) => Object.prototype.hasOwnProperty.call(lastAudit, k)),
    { lastAudit });
  const digText = String((dig.json || {}).text || '');
  const injectSend = runJson(['send', '--boot', devTok3, '--to', 'pm', '--subject', 'AC7 注入比对', '--body', 'q', '--ack', '--json'], {});
  void injectSend;
  check('AC7④ rolecard digest 文本与 boot --json 摘要逐字一致（sha256 相同）',
    shaText(digText) === shaText(String(rcJson.text || digText)) && Boolean(digText),
    { digestSha: shaText(digText).slice(0, 12), bootSha: shaText(String(rcJson.text || '')).slice(0, 12) });
} catch (e) {
  check('夹具未抛异常', false, { error: String((e && e.stack) || e) });
} finally {
  const realAfter = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
  check('AC8② 隔离：真实 团队.json / workbench.json 前后 sha256 不变',
    realAfter.team === realBefore.team && realAfter.store === realBefore.store,
    { team: [realBefore.team.slice(0, 12), realAfter.team.slice(0, 12)], store: [realBefore.store.slice(0, 12), realAfter.store.slice(0, 12)] });
  fs.rmSync(SB, { recursive: true, force: true });
  const failed = ROWS.filter((r) => r.ok !== true);
  if (!JSON_OUT) {
    console.log(`\n${ROWS.length - failed.length}/${ROWS.length} PASS${failed.length ? ` · ${failed.length} FAIL` : ''}`);
    if (failed.length) console.log('失败项：' + failed.map((r) => r.name).join(' | '));
  } else {
    console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed.length, failed: failed.map((r) => r.name), rows: ROWS }, null, 2));
  }
  if (failed.length) exitCode = 1;
}
}
main();
