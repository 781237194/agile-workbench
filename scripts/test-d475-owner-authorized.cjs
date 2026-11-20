#!/usr/bin/env node
'use strict';
/**
 * test-d475-owner-authorized.cjs — B-20261120-143331-d475（P1）夹具：换人闲时门的 Owner 授权绕过通道
 *
 * 需求（Owner 2026-11-20 14:3x 口径）：绕行缺口不堵、保留后门，但要正式通道 + 审计。
 *   ①`session rotate --owner-authorized --reason <≤200 字>`（仅 pm/owner；不带 → 完全走默认门）
 *   ②轮换记录 / 会话轮换.jsonl / 名册变更.jsonl / 专用审计（owner授权换人.jsonl）四处写
 *     bypass=OWNER_AUTHORIZED_SKIP_IDLE_GATE + reason + by + at
 *   ③默认门不变：不带参数仍判双方闲 15 分钟；14 分 59 秒不换（AWB_NOW_MS 可测）
 *   ④缺 reason / reason 超长 / 无权限 → 拒绝且零写入
 *
 * 用法：node scripts/test-d475-owner-authorized.cjs [--json]
 * 隔离：全部在 os.tmpdir() 沙盘（TEAM_ROOT/TEAM_PROJECTS_ROOT/TEAM_WORKBENCH_JSON/AWB_DATA_DIR/TEAM_SELFTEST=1），
 *      真实 团队.json / workbench.json 前后 sha256 必须不变。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const SESSION_SRC = path.join(ROOT, '团队', '工具', 'lib', 'session.mjs');
const JSON_OUT = process.argv.includes('--json');
const PROJECT = 's475沙盘';
const BYPASS = 'OWNER_AUTHORIZED_SKIP_IDLE_GATE';

const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
  return Boolean(ok);
}
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '(missing)'; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
const jsonlRows = (f) => {
  try {
    return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
};

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 's475-'));
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench.json');
const DATA = path.join(SB, 'data');
const STATE = path.join(TEAM, '状态', '项目', PROJECT);
const REAL_TEAM = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const ROLES = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
const HANDOVER_TEXT = [
  '# === 接任包 · pm ===',
  // 注意：validateHandover 的 emptyRequired 判据要求「【小节】」与正文**同一行**（【在途任务】([^\n]*) 非空）
  '## 【在途任务】无在途任务。',
  '## 【未闭环事项】无。',
  '## 【最近决策】无。',
  '## 【建议下一步】先 boot 再干活。',
  '## 【遗留问题与坑】无已知坑。',
].join('\n');

function env(extra = {}) {
  const { DSH_SESSION_ID, AWB_TEAM_ROOT, ...base } = process.env;
  return {
    ...base,
    TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_WORKBENCH_JSON: STORE,
    AWB_DATA_DIR: DATA, AWB_STORE: STORE, TEAM_SELFTEST: '1',
    TEAM_ROTATE_HANDOVER_TEXT: HANDOVER_TEXT,
    ...extra,
  };
}
function run(args, extra = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: env(extra), timeout: 180000, cwd: SB, maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status == null ? 1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function runJson(args, extra = {}) {
  const r = run(args, extra);
  const t = String(r.out || '').trim();
  const i = t.indexOf('{');
  let json = null;
  if (i >= 0) { try { json = JSON.parse(t.slice(i)); } catch { json = null; } }
  return { ...r, json };
}
const text = (r) => `${r.out || ''}${r.err || ''}`;
const tokenOf = (r) => String((r.json && r.json.token) || '');
const codeOf = (r) => String((r.json && r.json.code) || '');

const seedTeam = () => {
  const team = readJson(path.join(TEAM, '状态', '团队.json'), { members: [] });
  team.activeProject = PROJECT;
  team.members = Array.isArray(team.members) ? team.members : [];
  for (const role of ROLES) {
    let m = team.members.find((x) => x && x.role === role);
    if (!m) { m = { role, name: role, status: 'active' }; team.members.push(m); }
    m.status = 'active'; m.sessionId = `session-475-${role}`;
  }
  team.config = { ...(team.config || {}) };
  delete team.config.pmRotateIdleMin;   // 默认 15 分钟（不写死阈值）
  writeJson(path.join(TEAM, '状态', '团队.json'), team);
};
const seedQueue = (opts = {}) => {
  const file = path.join(TEAM, '状态', '会话排队.json');
  const at = new Date(Number(opts.at) || Date.now()).toISOString();
  const roles = ['pm', 'product'].map((role) => ({
    role, sessionId: `session-475-${role}`, known: true, queued: 0, state: 'ok', stale: false, active: true,
    running: opts.runningRole === role, runningSince: null, pendingInput: [], lastEventAt: at,
  }));
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify({ schema: 2, at, project: PROJECT, staleMs: 120000, degraded: null, roles }, null, 2) + '\n', 'utf8');
};
/** 造一条「pm 本人发出」的邮件（活跃判据只看本人发出）。 */
const seedPmMail = (tsMs, id = 'M-475-1') => {
  const dir = path.join(TEAM, '状态', '邮箱', 'product', 'new');
  fs.mkdirSync(dir, { recursive: true });
  const ts = new Date(tsMs).toISOString();
  writeJson(path.join(dir, `${ts.replace(/[:.]/g, '-')}-${id}.json`), {
    id, from: 'pm', to: 'product', type: 'notice', subject: 's475', body: 'b', project: PROJECT, ts, at: ts,
  });
};

async function main() {
  let exitCode = 0;
  const realBefore = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
  const recordFile = path.join(STATE, '会话轮换', 'pm.json');
  const ledgerFile = path.join(STATE, '会话轮换.jsonl');
  const rosterAuditFile = path.join(STATE, '名册变更.jsonl');
  const bypassAuditFile = path.join(STATE, 'owner授权换人.jsonl');
  const manifestFile = null; // 由 projDir 决定
  let projDir = '';
  const snap = () => ({ team: sha(path.join(TEAM, '状态', '团队.json')), manifest: sha(path.join(projDir, '团队会话.json')), store: sha(STORE) });
  try {
    Object.assign(process.env, env());
    check('S0 沙盘 init', run(['init']).code === 0, {});
    check('S1 沙盘建项目', run(['project', 'add', '--name', PROJECT, '--team-mode', 'full']).code === 0, {});
    seedTeam();
    seedQueue();
    const projMeta = readJson(path.join(STATE, '项目.json'), {});
    projDir = String(projMeta.path || path.join(PROJECTS, PROJECT));
    writeJson(path.join(projDir, '团队会话.json'), { project: PROJECT, teamMode: 'full', workspace: projDir, roles: ROLES.map((role) => ({ role, sessionId: `session-475-${role}` })) });
    writeJson(STORE, {
      projects: [{
        id: 's475-p1', name: PROJECT, teamName: PROJECT, path: projDir,
        sessions: Object.fromEntries(ROLES.map((r) => [r, `session-475-${r}`])),
        workspace: { path: projDir, sessionIds: ROLES.map((r) => `session-475-${r}`) },
      }], activeProjectId: 's475-p1',
    });
    const pmTok = tokenOf(runJson(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'session-475-pm', '--json']));
    const prodTok = tokenOf(runJson(['boot', '--role', 'product', '--project', PROJECT, '--session', 'session-475-product', '--json']));
    check('S2 沙盘 pm/product boot 成功', Boolean(pmTok && prodTok), { pm: Boolean(pmTok), product: Boolean(prodTok) });

    const mod = await import(`file://${SESSION_SRC.replace(/\\/g, '/')}`);
    const g0 = mod.pmRotateIdleState(PROJECT, {});
    check('① 全新沙盘：默认门=15 分钟且双方 idle', g0.ok === true && Number(g0.minutes) === 15, { gate: g0.roles });

    /* ── ③ 默认门不变：14 分 59 秒不换、15 分整放行（AWB_NOW_MS 可测） ── */
    const base = Date.now();
    seedPmMail(base - (15 * 60 * 1000 - 1000), 'M-475-1459');   // 14 分 59 秒前
    const g1459 = mod.pmRotateIdleState(PROJECT, { now: base });
    check('③a 14 分 59 秒：门判 busy，remainingSec=1（不四舍五入凑够 15 分钟）',
      g1459.roles.pm.idle === false && Number(g1459.roles.pm.remainingSec) === 1, { pm: g1459.roles.pm });
    const rot1459 = runJson(['session', 'rotate', '--role', 'pm', '--session', 'session-475-pm-b1459', '--boot', pmTok, '--offline', '--json'], { AWB_NOW_MS: String(base) });
    check('③b 14 分 59 秒调 CLI（不带 --owner-authorized）→ WAIT_BOTH_IDLE 拒绝',
      codeOf(rot1459) === 'WAIT_BOTH_IDLE', { code: codeOf(rot1459), out: text(rot1459).slice(0, 240) });
    // 15 分钟整：不再算「近 15 分钟内」，放行（模块级判据，避免真的换人）
    fs.rmSync(path.join(TEAM, '状态', '邮箱', 'product'), { recursive: true, force: true });   // 清掉 14:59 那条，避免两条消息叠加
    seedPmMail(base - 15 * 60 * 1000, 'M-475-1500');
    const g1500 = mod.pmRotateIdleState(PROJECT, { now: base });
    check('③c 15 分钟整：门判 idle（边界严格小于）', g1500.roles.pm.idle === true, { pm: g1500.roles.pm });
    fs.rmSync(path.join(TEAM, '状态', '邮箱', 'product'), { recursive: true, force: true });

    /* ── ④ 拒绝分支：缺 reason / 超长 / 无权限 / 无令牌 → 零写入 ── */
    seedPmMail(Date.now() - 60 * 1000, 'M-475-busy');   // 让 pm 处于 busy，证明绕过是「确有门要绕」
    const beforeRefuse = snap();
    const rNoReason = runJson(['session', 'rotate', '--role', 'pm', '--session', 'session-475-pm-x1', '--owner-authorized', '--boot', pmTok, '--offline', '--json'], { TEAM_BOOT_ENFORCE: '1' });
    check('④a 缺 --reason → BYPASS_REASON_REQUIRED', codeOf(rNoReason) === 'BYPASS_REASON_REQUIRED', { code: codeOf(rNoReason), out: text(rNoReason).slice(0, 300) });
    const rTooLong = runJson(['session', 'rotate', '--role', 'pm', '--session', 'session-475-pm-x2', '--owner-authorized', '--reason', 'x'.repeat(201), '--boot', pmTok, '--offline', '--json'], { TEAM_BOOT_ENFORCE: '1' });
    check('④b --reason 超 200 字 → BYPASS_REASON_TOO_LONG', codeOf(rTooLong) === 'BYPASS_REASON_TOO_LONG', { code: codeOf(rTooLong), out: text(rTooLong).slice(0, 300) });
    const rProduct = runJson(['session', 'rotate', '--role', 'pm', '--session', 'session-475-pm-x3', '--owner-authorized', '--reason', '产品试图绕门', '--boot', prodTok, '--offline', '--json'], { TEAM_BOOT_ENFORCE: '1' });
    check('④c 产品令牌用 --owner-authorized → PERMISSION_DENIED（仅 pm/owner）', codeOf(rProduct) === 'PERMISSION_DENIED', { code: codeOf(rProduct), out: text(rProduct).slice(0, 300) });
    const rNoBoot = runJson(['session', 'rotate', '--role', 'pm', '--session', 'session-475-pm-x4', '--owner-authorized', '--reason', '无令牌', '--offline', '--json'], { TEAM_BOOT_ENFORCE: '1' });
    check('④d 无 boot 令牌 → BOOT_REQUIRED', codeOf(rNoBoot) === 'BOOT_REQUIRED', { code: codeOf(rNoBoot), out: text(rNoBoot).slice(0, 240) });
    const afterRefuse = snap();
    check('④e 四种拒绝全部零写入：团队.json / 团队会话.json / workbench.json sha256 不变',
      beforeRefuse.team === afterRefuse.team && beforeRefuse.manifest === afterRefuse.manifest && beforeRefuse.store === afterRefuse.store,
      { beforeRefuse, afterRefuse });

    /* ── ② 正向：pm 忙也能换（显式 Owner 授权），四处留审计 ── */
    const gBusy = mod.pmRotateIdleState(PROJECT, {});
    check('②a 前置：此刻默认门确实会拒（pm busy），证明绕过不是空转', gBusy.ok === false, { pm: gBusy.roles.pm });
    const REASON = 'Owner 2026-11-20 14:3x 授权：PM 与产品窗口归零，显式跳过闲时门（夹具）';
    // 人类输出走 dry-run（零写入、且在真换人之前——换人后旧令牌会被 SESSION_REPLACED 挡）；
    // --json 模式只打 JSON，人类文本判据必须另跑一次。
    const humanOut = run(['session', 'rotate', '--role', 'pm', '--session', 'session-475-pm-dry', '--owner-authorized', '--reason', REASON, '--boot', pmTok, '--offline', '--dry-run'], { TEAM_BOOT_ENFORCE: '1' });
    check('②d 人类输出点名「将按 Owner 授权跳过」/bypass 码/reason（dry-run 零写入）',
      text(humanOut).includes(BYPASS) && /将按 Owner 授权跳过/.test(text(humanOut)) && text(humanOut).includes('Owner 2026-11-20 14:3x 授权'),
      { out: text(humanOut).slice(0, 600) });
    const rot = runJson(['session', 'rotate', '--role', 'pm', '--session', 'session-475-pm-new', '--owner-authorized', '--reason', REASON, '--boot', pmTok, '--offline', '--json'], { TEAM_BOOT_ENFORCE: '1' });
    check('②b --owner-authorized + pm 令牌 → 换人成功（默认门被显式跳过）',
      rot.code === 0 && String((rot.json || {}).from || '') === 'session-475-pm' && String((rot.json || {}).to || '') === 'session-475-pm-new',
      { code: rot.code, json: { from: (rot.json || {}).from, to: (rot.json || {}).to }, out: text(rot).slice(0, 400) });
    check('②c JSON idleGate 以「跳过」形状暴露（skipped=true + bypass 码）',
      Boolean(rot.json && rot.json.idleGate && rot.json.idleGate.skipped === true && rot.json.idleGate.bypass === BYPASS && rot.json.idleGate.reason === REASON),
      { idleGate: rot.json && rot.json.idleGate });
    // 人类输出走 dry-run（零写入）：--json 模式只打 JSON，人类文本判据必须另跑一次
    const rec = readJson(recordFile, null);
    check('②e 轮换记录 会话轮换/pm.json 带 bypass/bypassReason/bypassBy/bypassAt',
      Boolean(rec && rec.bypass === BYPASS && rec.bypassReason === REASON && rec.bypassBy === 'pm' && rec.bypassAt),
      { record: rec && { bypass: rec.bypass, bypassReason: rec.bypassReason, bypassBy: rec.bypassBy, bypassAt: rec.bypassAt } });
    const ledgerRows = jsonlRows(ledgerFile);
    const ledgerLast = ledgerRows[ledgerRows.length - 1] || {};
    check('②f 会话轮换.jsonl 末行带四处字段',
      ledgerLast.bypass === BYPASS && ledgerLast.bypassReason === REASON && ledgerLast.bypassBy === 'pm' && Boolean(ledgerLast.bypassAt),
      { last: ledgerLast });
    const auditRows = jsonlRows(rosterAuditFile).filter((r) => r && r.event === 'roster_rotate' && r.role === 'pm');
    const auditLast = auditRows[auditRows.length - 1] || {};
    check('②g 名册变更.jsonl 的 roster_rotate 行带四处字段',
      auditLast.bypass === BYPASS && auditLast.bypassReason === REASON && auditLast.bypassBy === 'pm' && Boolean(auditLast.bypassAt),
      { last: auditLast });
    const bypassRows = jsonlRows(bypassAuditFile);
    const bypassRow = bypassRows[bypassRows.length - 1] || {};
    check('②h 专用审计 owner授权换人.jsonl 落一行（event/bypass/reason/by/at/from/to）',
      bypassRows.length === 1 && bypassRow.event === 'owner_authorized_rotate' && bypassRow.bypass === BYPASS
      && bypassRow.reason === REASON && bypassRow.by === 'pm' && Boolean(bypassRow.at)
      && bypassRow.from === 'session-475-pm' && bypassRow.to === 'session-475-pm-new',
      { rows: bypassRows });

    const teamRow = (readJson(path.join(TEAM, '状态', '团队.json'), {}).members || []).find((m) => m && m.role === 'pm') || {};
    const manifestRow = ((readJson(path.join(projDir, '团队会话.json'), {}).roles) || []).find((r) => r && r.role === 'pm') || {};
    check('②i 换人真生效：团队.json 与 团队会话.json 的 pm 都指向新会话',
      String(teamRow.sessionId) === 'session-475-pm-new' && String(manifestRow.sessionId) === 'session-475-pm-new',
      { team: teamRow.sessionId, manifest: manifestRow.sessionId });

    /* ── ⑤ 不带参数仍走默认门（同一会话、换目标再试一次也必须拒） ── */
    seedPmMail(Date.now() - 30 * 1000, 'M-475-busy2');
    seedQueue();
    const plain = runJson(['session', 'rotate', '--role', 'pm', '--session', 'session-475-pm-y1', '--boot', prodTok, '--offline', '--force', '--json'], { TEAM_BOOT_ENFORCE: '1' });
    check('⑤ 不带 --owner-authorized → 默认门照旧拒（WAIT_BOTH_IDLE），后门不因参数存在而松动',
      codeOf(plain) === 'WAIT_BOTH_IDLE', { code: codeOf(plain), out: text(plain).slice(0, 300) });
  } catch (e) {
    check('夹具未抛异常', false, { error: String((e && e.stack) || e) });
  } finally {
    const realAfter = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
    check('C 隔离：真实 团队.json / workbench.json 前后 sha256 不变',
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
  process.exit(exitCode);
}
main();
