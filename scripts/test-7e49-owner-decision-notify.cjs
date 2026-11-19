#!/usr/bin/env node
'use strict';
/**
 * test-7e49-owner-decision-notify.cjs —— P1 缺陷 B-20261119-165125-7e49 夹具
 *
 * 缺陷：Owner 在界面点「通过/跳过/打回」→ 决定落账（decisions/ownerReview/status/events 都写了），
 * 但**不发消息、不唤醒、无回执** → PM 只能靠轮询发现（今晚多次「验收消息迟到/重复」都与此有关）。
 *
 * 断言：
 *  A. 接线（静态，读 src/team-tools.js）
 *     A1 新增 notifyOwnerDecisionToPm（唯一入口）
 *     A2 去重常量 5 分钟 + 去重键含 project|requirement|round
 *     A3 审计码 owner_decision_notify_failed 存在（失败不阻断落账）
 *     A4 调用点在 `if (!written.ok) return written;` **之后**（落账是硬要求、通知是软要求）
 *     A5 通知用 `--to pm --type notice`（且带 requirementId/决定/轮次/时间）
 *     A6 返回值带 ownerDecisionNotify（可观测）
 *  B. 通道（行为，沙盘真实 CLI）
 *     B1 pm 令牌 `send --to pm --type notice` 能落库并返回 messageId（通知通道可用）
 *     B2 第二次发送也成功（team.mjs 层不做 5 分钟去重，去重归壳层；这条防「以为 CLI 会去重」的误判）
 *  C. 隔离：真实 团队/状态/团队.json、data/userdata/workbench.json sha256 前后不变
 *
 * 用法：node scripts/test-7e49-owner-decision-notify.cjs [--json]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const SRC = path.join(ROOT, 'src', 'team-tools.js');
const JSON_OUT = process.argv.includes('--json');
const PROJECT = 'b7e49沙盘';

const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
  return Boolean(ok);
}
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '(missing)'; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'b7e49-'));
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench-b7e49.json');
const DATA = path.join(SB, 'data');
const STATE = path.join(TEAM, '状态', '项目', PROJECT);
const REAL_TEAM = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');

function env() {
  const { DSH_SESSION_ID, ...base } = process.env;
  return { ...base, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_WORKBENCH_JSON: STORE, AWB_DATA_DIR: DATA, AWB_STORE: STORE, TEAM_SELFTEST: '1' };
}
function run(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: env(), timeout: 180000, cwd: SB, maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status == null ? 1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function runJson(args) {
  const r = run(args);
  const t = String(r.out || '').trim();
  const i = t.indexOf('{');
  let json = null;
  if (i >= 0) { try { json = JSON.parse(t.slice(i)); } catch { json = null; } }
  return { ...r, json };
}
const text = (r) => `${r.out || ''}${r.err || ''}`;
const tokenOf = (r) => String((r.json && r.json.token) || '');
function mailsOf(role) {
  const out = [];
  for (const box of ['new', 'cur']) {
    const dir = path.join(TEAM, '状态', '邮箱', role, box);
    try {
      for (const n of fs.readdirSync(dir)) { if (!n.endsWith('.json')) continue; const row = readJson(path.join(dir, n), null); if (row) out.push(row); }
    } catch { /* 空箱 */ }
  }
  return out;
}

const realBefore = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
let exitCode = 0;
try {
  if (!fs.existsSync(SRC)) { console.error('环境错误：找不到 src/team-tools.js'); process.exit(2); }
  const src = fs.readFileSync(SRC, 'utf8');

  /* ── A 接线（静态） ─────────────────────────────────────────── */
  check('A1 新增 notifyOwnerDecisionToPm（唯一通知入口）',
    (src.match(/function notifyOwnerDecisionToPm\(/g) || []).length === 1, { count: (src.match(/notifyOwnerDecisionToPm\(/g) || []).length });
  check('A2 去重：5 分钟窗口 + 键含 project|requirement|round',
    /OWNER_DECISION_NOTIFY_DEDUPE_MS = 5 \* 60 \* 1000/.test(src)
    && /const key = `\$\{projectName\}\|\$\{requirementId\}\|\$\{round\}`/.test(src),
    { hasConst: /OWNER_DECISION_NOTIFY_DEDUPE_MS/.test(src) });
  check('A3 失败审计码 owner_decision_notify_failed 存在（落账不被阻断）',
    (src.match(/owner_decision_notify_failed/g) || []).length >= 1, { count: (src.match(/owner_decision_notify_failed/g) || []).length });
  {
    const fnStart = src.indexOf('async function ownerRequirementDecision(input = {}) {');
    const writeOk = src.indexOf('if (!written.ok) return written;', fnStart);
    const call = src.indexOf('ownerDecisionNotify = await notifyOwnerDecisionToPm(', fnStart);
    check('A4 调用点位于「落账成功」之后（落账硬要求、通知软要求）',
      fnStart >= 0 && writeOk > fnStart && call > writeOk, { fnStart, writeOk, call });
  }
  check('A5 通知用 --to pm --type notice 且正文带需求/决定/轮次/时间',
    /'--to', 'pm', '--type', 'notice'/.test(src)
    && /需求：\$\{requirementId\}/.test(src) && /轮次：\$\{round\}/.test(src) && /时间：\$\{at\}/.test(src),
    { hasToPm: /'--to', 'pm'/.test(src), hasType: /'--type', 'notice'/.test(src) });
  check('A6 返回值新增 ownerDecisionNotify（可观测）',
    src.includes('ownerDecisionNotify,') && src.includes('let ownerDecisionNotify = null;'), {});

  /* ── B 通道（行为） ─────────────────────────────────────────── */
  check('S0 沙盘 init', run(['init']).code === 0, {});
  check('S1 沙盘建项目', run(['project', 'add', '--name', PROJECT, '--team-mode', 'full']).code === 0, {});
  const ALL = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
  const team = readJson(path.join(TEAM, '状态', '团队.json'), { members: [] });
  team.activeProject = PROJECT;
  team.members = Array.isArray(team.members) ? team.members : [];
  for (const role of ALL) {
    let m = team.members.find((x) => x && x.role === role);
    if (!m) { m = { role, name: role, status: 'active' }; team.members.push(m); }
    m.status = 'active'; m.sessionId = `session-b7e49-${role}`;
  }
  writeJson(path.join(TEAM, '状态', '团队.json'), team);
  const projMeta = readJson(path.join(STATE, '项目.json'), {});
  const projDir = String(projMeta.path || path.join(PROJECTS, PROJECT));
  writeJson(path.join(projDir, '团队会话.json'), { project: PROJECT, teamMode: 'full', workspace: projDir, roles: ALL.map((role) => ({ role, sessionId: `session-b7e49-${role}` })) });
  writeJson(STORE, { projects: [{ id: 'b7e49-p1', name: PROJECT, teamName: PROJECT, path: projDir, sessions: Object.fromEntries(ALL.map((r) => [r, `session-b7e49-${r}`])), workspace: { path: projDir, sessionIds: ALL.map((r) => `session-b7e49-${r}`) } }], activeProjectId: 'b7e49-p1' });
  const pmTok = tokenOf(runJson(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'session-b7e49-pm', '--json']));
  check('S2 沙盘 pm boot 成功', Boolean(pmTok), {});
  const subj = 'Owner 已通过需求 R-20261119-999999-0001';
  const body = '需求：R-20261119-999999-0001\n决定：通过（approved）｜ 轮次：1 ｜ 时间：2026-11-19T12:00:00.000Z ｜ 通道：ui\n下一步：需求已放行，可按当前模式派单。';
  // B-7e49：必须用 notify（发件人固定 system）——send 在 to===令牌角色 时直接 SELF_SEND 拒绝
  const send1 = runJson(['notify', '--boot', pmTok, '--to', 'pm', '--type', 'notice', '--subject', subj, '--body', body, '--json']);
  const mail1 = mailsOf('pm').filter((m) => String(m.subject || '') === subj);
  check('B1 notify 通道（from=system）能给 pm 落 notice 并返回 messageId',
    send1.code === 0 && Boolean((((send1.json || {}).message) || {}).id) && mail1.length === 1,
    { code: send1.code, count: mail1.length, out: text(send1).slice(0, 300) });
  check('B1b 落库消息 type=notice 且带正文四要素',
    mail1.length === 1 && String(mail1[0].type || '') === 'notice' && /需求：/.test(String(mail1[0].body || '')) && /轮次：/.test(String(mail1[0].body || '')),
    { mail: mail1[0] && { type: mail1[0].type, subject: mail1[0].subject, body: String(mail1[0].body || '').slice(0, 120) } });
  const subj2 = 'Owner 已通过需求 R-20261119-999999-0001（第二次）';
  const send2 = runJson(['notify', '--boot', pmTok, '--to', 'pm', '--type', 'notice', '--subject', subj2, '--body', body, '--json']);
  const mail2 = mailsOf('pm').filter((m) => String(m.subject || '') === subj2);
  check('B2 第二次 notify 同样落库（team.mjs 层不做 5 分钟去重，去重归壳层）',
    send2.code === 0 && mail2.length === 1,
    { code: send2.code, count: mail2.length });
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
