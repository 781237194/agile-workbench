#!/usr/bin/env node
'use strict';
/**
 * test-d8b8-owner-notify-legacy.cjs —— P1 B-20261119-212037-d8b8 夹具
 *
 * 缺陷：legacy 协议（`team.mjs owner`）成功落账后**不发 PM 通知**——通知原来嵌在壳层
 * `ownerRequirementDecision` 内，legacy 直接走 CLI 绕过了它（tester 真窗口：PM 收件箱 0 条、找不到 owner决定通知.jsonl）。
 *
 * 断言：
 *  A. 单一实现（静态）
 *     A1 文案/去重/审计只在 `lib/owner-decision.mjs`（`ownerDecisionPayload` / `ownerDecisionNotifyKey` / `appendOwnerDecisionAudit`）
 *     A2 `ops.mjs → cmdOwner` 在 out 之前调用 `runOwnerDecisionNotify`（legacy 路径接入）
 *     A3 壳层不再自建文案，改调 `team.mjs owner-notify`（与 legacy 同一执行体）
 *  B. 行为（沙盘真实 CLI，走的就是两协议共用的执行体）
 *     B1 `owner-notify` → PM 收件箱 +1 条 system notice（subject 含「Owner 已通过需求 <R>」、body 含需求/决定/轮次/时间/通道）
 *     B2 审计 `owner决定通知.jsonl` 出现 `owner_decision_notified`（记 messageId）
 *     B3 连点第二次 → `deduped:true`、收件箱**仍只 +1**、审计出现 `owner_decision_notify_skipped`
 *     B4 无 `owner_decision_notify_failed`
 *  C. 隔离：真实 团队.json / workbench.json sha256 不变
 *
 * 用法：node scripts/test-d8b8-owner-notify-legacy.cjs [--json]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const OPS_SRC = path.join(ROOT, '团队', '工具', 'lib', 'ops.mjs');
const OD_SRC = path.join(ROOT, '团队', '工具', 'lib', 'owner-decision.mjs');
const SHELL_SRC = path.join(ROOT, 'src', 'team-tools.js');
const JSON_OUT = process.argv.includes('--json');
const PROJECT = 'b8d8沙盘';

const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 720)}`);
  return Boolean(ok);
}
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '(missing)'; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'b8d8-'));
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench-b8d8.json');
const DATA = path.join(SB, 'data');
const STATE = path.join(TEAM, '状态', '项目', PROJECT);
const AUDIT = path.join(STATE, 'owner决定通知.jsonl');
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
function mailsTo(role) {
  const out = [];
  for (const box of ['new', 'cur']) {
    const dir = path.join(TEAM, '状态', '邮箱', role, box);
    try { for (const n of fs.readdirSync(dir)) { if (!n.endsWith('.json')) continue; const row = readJson(path.join(dir, n), null); if (row) out.push(row); } } catch { /* 空箱 */ }
  }
  return out;
}

function main() {
  let exitCode = 0;
  const realBefore = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
  try {
    const ops = fs.readFileSync(OPS_SRC, 'utf8');
    const od = fs.readFileSync(OD_SRC, 'utf8');
    const shell = fs.readFileSync(SHELL_SRC, 'utf8');

    /* ── A 单一实现（静态） ─────────────────────────────────── */
    check('A1 文案/去重/审计只在 lib/owner-decision.mjs（唯一实现）',
      od.includes('export function ownerDecisionPayload(') && od.includes('export function ownerDecisionNotifyKey(') && od.includes('export function appendOwnerDecisionAudit('),
      {});
    {
      const ownerStart = ops.indexOf('export async function cmdOwner(args)');
      const callIdx = ops.indexOf('await runOwnerDecisionNotify(', ownerStart);
      const outIdx = ops.indexOf('`Owner ${label}', ownerStart);
      check('A2 cmdOwner 在 out 之前调用 runOwnerDecisionNotify（legacy 路径接入）',
        ownerStart >= 0 && callIdx > ownerStart && outIdx > callIdx, { ownerStart, callIdx, outIdx });
    }
    // B-316f：两处返回体都必须带 ownerDecisionNotify（可观测性一致）
    {
      const ownerStart = ops.indexOf('export async function cmdOwner(args)');
      const opsOut = ops.slice(ownerStart);
      const shellFn = shell.indexOf('async function ownerRequirementDecision(input = {}) {');
      const shellBody = shell.slice(shellFn, shellFn + 30000);
      // 判据：cmdOwner 里 `let ownerDecisionNotify = null` 之后 3000 字符内出现字段 `ownerDecisionNotify,`（即 out 的 json 里带了它）
      const defIdx = opsOut.indexOf('let ownerDecisionNotify = null');
      check('A4 ops.mjs → cmdOwner 返回体含 ownerDecisionNotify（legacy CLI 可观测）',
        defIdx > 0 && /^\s+ownerDecisionNotify,\s*$/m.test(opsOut.slice(defIdx, defIdx + 3000)),
        { defIdx, tail: opsOut.slice(defIdx, defIdx + 900).slice(-400) });
      check('A5 src/team-tools.js → ownerRequirementDecision 返回体含 ownerDecisionNotify（壳层 legacy 分支）',
        /ownerDecisionNotify,/.test(shellBody), {});
    }
    check('A3 壳层不再自建文案，改调 team.mjs owner-notify',
      shell.includes("'owner-notify'") && !shell.includes("'notify', '--boot', token, '--to', 'pm', '--type', 'notice', '--subject', subject"), {});

    /* ── 沙盘 ───────────────────────────────────────────────── */
    check('S0 沙盘 init', run(['init']).code === 0, {});
    check('S1 沙盘建项目', run(['project', 'add', '--name', PROJECT, '--team-mode', 'full']).code === 0, {});
    const ALL = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
    const team = readJson(path.join(TEAM, '状态', '团队.json'), { members: [] });
    team.activeProject = PROJECT;
    team.members = Array.isArray(team.members) ? team.members : [];
    for (const role of ALL) {
      let m = team.members.find((x) => x && x.role === role);
      if (!m) { m = { role, name: role, status: 'active' }; team.members.push(m); }
      m.status = 'active'; m.sessionId = `session-b8d8-${role}`;
    }
    writeJson(path.join(TEAM, '状态', '团队.json'), team);
    const projMeta = readJson(path.join(STATE, '项目.json'), {});
    const projDir = String(projMeta.path || path.join(PROJECTS, PROJECT));
    writeJson(path.join(projDir, '团队会话.json'), { project: PROJECT, teamMode: 'full', workspace: projDir, roles: ALL.map((role) => ({ role, sessionId: `session-b8d8-${role}` })) });
    writeJson(STORE, { projects: [{ id: 'b8d8-p1', name: PROJECT, teamName: PROJECT, path: projDir, sessions: Object.fromEntries(ALL.map((r) => [r, `session-b8d8-${r}`])), workspace: { path: projDir, sessionIds: ALL.map((r) => `session-b8d8-${r}`) } }], activeProjectId: 'b8d8-p1' });
    const pmTok = tokenOf(runJson(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'session-b8d8-pm', '--json']));
    check('S2 沙盘 pm boot 成功', Boolean(pmTok), {});
    const reqId = 'R-20261119-999999-d8b8';

    /* ── B 行为：共用执行体 ─────────────────────────────────── */
    const mailBefore = mailsTo('pm').length;
    const n1 = runJson(['owner-notify', '--boot', pmTok, '--project', PROJECT, '--requirement', reqId, '--status', 'approved', '--round', '1', '--opinion', 'd8b8 夹具', '--channel', 'ui', '--json']);
    const mailAfter = mailsTo('pm');
    const notices = mailAfter.filter((m) => String(m.subject || '').includes('Owner 已通过需求') && String(m.body || '').includes(reqId));
    check('B1 owner-notify → PM 收件箱 +1 条 system notice（含需求/决定/轮次/时间/通道）',
      mailAfter.length === mailBefore + 1 && notices.length === 1
      && String(notices[0].from || '') === 'system' && String(notices[0].type || '') === 'notice'
      && /轮次：1/.test(String(notices[0].body || '')) && /通道：ui/.test(String(notices[0].body || '')),
      { before: mailBefore, after: mailAfter.length, subjects: notices.map((m) => m.subject), body: notices[0] && String(notices[0].body || '').slice(0, 160) });
    // B-8235：壳层不得再有任何「第二套实现」的符号（去重常量/内存 Map/审计写/自有通知函数/审计 action 字面量）
    {
      const shellDup = ['OWNER_DECISION_NOTIFY_DEDUPE_MS', 'ownerDecisionNotifySeen', 'appendOwnerDecisionAudit', 'notifyOwnerDecisionToPm', 'lastNotifiedAtFromAudit', 'owner_decision_notified', 'owner_decision_notify_failed'];
      const found = shellDup.filter((k) => shell.includes(k));
      check('A6 壳层 0 处第二套实现符号（去重常量/Map/审计写/自有通知函数/审计 action）', found.length === 0, { found });
      check('A7 壳层唯一路径＝调 owner-notify 且复用返回的 notify 字段',
        /'owner-notify'/.test(shell) && /notifyRun\.value\.notify|value && notifyRun\.value\.notify/.test(shell) && /ownerDecisionNotify = \(notifyRun/.test(shell), {});
    }
    check('B1b owner-notify 的 --json 返回体带 notify（ok + messageId 可观测）',
      Boolean((n1.json || {}).notify) && ((n1.json || {}).notify.ok === true || (n1.json || {}).notify.deduped === true),
      { json: n1.json && { ok: n1.json.ok, notify: n1.json.notify } });
    const audit1 = readLines(AUDIT);
    check('B2 审计 owner决定通知.jsonl 记 owner_decision_notified（带 messageId）',
      audit1.some((r) => r.action === 'owner_decision_notified' && String(r.messageId || '').startsWith('M-')),
      { actions: audit1.map((r) => r.action) });
    const n2 = runJson(['owner-notify', '--boot', pmTok, '--project', PROJECT, '--requirement', reqId, '--status', 'approved', '--round', '1', '--opinion', 'd8b8 夹具第二次', '--channel', 'ui', '--json']);
    const mailAfter2 = mailsTo('pm');
    const audit2 = readLines(AUDIT);
    check('B3 连点第二次 → 去重（收件箱仍只 +1，审计出现 owner_decision_notify_skipped）',
      mailAfter2.length === mailBefore + 1
      && audit2.some((r) => r.action === 'owner_decision_notify_skipped')
      && /deduped|去重/.test(text(n2)),
      { after2: mailAfter2.length, actions: audit2.map((r) => r.action), out: text(n2).slice(0, 240) });
    check('B4 全程无 owner_decision_notify_failed',
      !audit2.some((r) => r.action === 'owner_decision_notify_failed'), { actions: audit2.map((r) => r.action) });
    void n1;
  } catch (e) {
    check('夹具未抛异常', false, { error: String((e && e.stack) || e).slice(0, 700) });
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
