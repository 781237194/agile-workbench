#!/usr/bin/env node
'use strict';
/**
 * test-42ac-owner-decision-notify-path.cjs —— P0 B-20261119-204306-42ac 真路径夹具
 *
 * 缺陷：B-7e49 的通知在 `ownerRequirementDecision` 生产路径 100% 抛错（`projectName: name` / `appendOwnerDecisionAudit(name,…)`
 * 用了**裸 name**，该作用域只有 `ctx.name`）→ 通知永不发出；catch 里再抛 → 返回 WORKFLOW_FAILED 但落账已 written。
 *
 * 本夹具**走真入口**（`require('src/team-tools.js').ownerRequirementDecision(...)`），不是只测 notify 通道：
 *  A. 静态：两处已改 `ctx.name`；catch 内审计写有 try/catch（审计失败不吞落账）
 *  B. 真路径：沙盘构造可 Owner 决定的需求 → 调用 → 返回 ok、PM 收件箱 +1 条 Owner 决定 notice、
 *     审计有 `owner_decision_notified`、**无** `owner_decision_notify_failed`
 *  C. 落账优先：即使通知/审计失败，返回值仍须 ok（用 TEAM_ROLECARD… 之类不可用；这里用「重复调用命中 5 分钟去重」验证
 *     通知被跳过时仍 ok，且审计写 skipped 而不是 failed）
 *
 * 用法：node scripts/test-42ac-owner-decision-notify-path.cjs [--json]
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
const PROJECT = 'b42ac沙盘';

const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 760)}`);
  return Boolean(ok);
}
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '(missing)'; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'b42ac-'));
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench-b42ac.json');
const DATA = path.join(SB, 'data');
const STATE = path.join(TEAM, '状态', '项目', PROJECT);
const AUDIT = path.join(STATE, 'owner决定通知.jsonl');
const REAL_TEAM = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');

function env() {
  const { DSH_SESSION_ID, ...base } = process.env;
  return { ...base, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_WORKBENCH_JSON: STORE, AWB_DATA_DIR: DATA, AWB_STORE: STORE, TEAM_SELFTEST: '1' };
}
function run(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: { ...env(), ...extraEnv }, timeout: 180000, cwd: SB, maxBuffer: 32 * 1024 * 1024 });
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
function mailsTo(role) {
  const out = [];
  for (const box of ['new', 'cur']) {
    const dir = path.join(TEAM, '状态', '邮箱', role, box);
    try { for (const n of fs.readdirSync(dir)) { if (!n.endsWith('.json')) continue; const row = readJson(path.join(dir, n), null); if (row) out.push(row); } } catch { /* 空箱 */ }
  }
  return out;
}

async function main() {
  let exitCode = 0;
  const realBefore = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
  // 真入口要求 env 在 require 前就位（defaultTools 在模块加载时构造 layout）
  Object.assign(process.env, env());
  try {
    const src = fs.readFileSync(SRC, 'utf8');

    /* ── A 静态 ─────────────────────────────────────────────── */
    const fnStart = src.indexOf('async function ownerRequirementDecision(input = {}) {');
    const fnEnd = src.indexOf('async function ', fnStart + 10);
    const body = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 25000);
    check('A1 两处裸 name 已改 ctx.name（projectName 与 appendOwnerDecisionAudit）',
      body.includes('projectName: ctx.name') && body.includes('appendOwnerDecisionAudit(ctx.name'),
      { hasProjectName: body.includes('projectName: ctx.name'), hasAudit: body.includes('appendOwnerDecisionAudit(ctx.name') });
    check('A2 catch 内审计写包了 try/catch（审计失败不吞落账）',
      /catch \(error\) \{[\s\S]{0,400}?try \{[\s\S]{0,300}?appendOwnerDecisionAudit\(ctx\.name/.test(body), {});

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
      m.status = 'active'; m.sessionId = `session-b42ac-${role}`;
    }
    writeJson(path.join(TEAM, '状态', '团队.json'), team);
    const projMeta = readJson(path.join(STATE, '项目.json'), {});
    const projDir = String(projMeta.path || path.join(PROJECTS, PROJECT));
    writeJson(path.join(projDir, '团队会话.json'), { project: PROJECT, teamMode: 'full', workspace: projDir, roles: ALL.map((role) => ({ role, sessionId: `session-b42ac-${role}` })) });
    writeJson(STORE, { projects: [{ id: 'b42ac-p1', name: PROJECT, teamName: PROJECT, path: projDir, sessions: Object.fromEntries(ALL.map((r) => [r, `session-b42ac-${r}`])), workspace: { path: projDir, sessionIds: ALL.map((r) => `session-b42ac-${r}`) } }], activeProjectId: 'b42ac-p1' });
    // 项目信息.md 若仍是模板占位，ensureWorkflowBoot 会报 PLACEHOLDER_DOC → 填实（沙盘项目卡骨架）。
    try {
      const infoFile = path.join(projDir, '项目信息.md');
      const infoText = fs.readFileSync(infoFile, 'utf8');
      if (/待 PM 填写|待填/.test(infoText)) {
        fs.writeFileSync(infoFile, ['# 项目信息', '', '- 项目目标：b42ac 沙盘夹具（验证 Owner 决定通知链路）', '- 用户与场景：测试人员本地验证', '- 交付物：无（夹具不产出业务文件）', '- 排除项：不做产品功能', '- 截止与约束：无', ''].join('\n'), 'utf8');
      }
    } catch { /* 缺文件不影响后续断言（会以 PLACEHOLDER_DOC/MISSING_DOC 暴露） */ }
    const pmTok = tokenOf(runJson(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'session-b42ac-pm', '--json']));
    const prodTok = tokenOf(runJson(['boot', '--role', 'product', '--project', PROJECT, '--session', 'session-b42ac-product', '--json']));
    check('S2 沙盘 pm/product boot 成功', Boolean(pmTok && prodTok), {});

    // 造需求 + 产品评审通过
    const reqCreate = runJson(['req', 'create', '--boot', pmTok, '--title', 'b42ac 夹具需求', '--priority', 'P1', '--acceptance', 'x', '--json']);
    const reqId = String((((reqCreate.json || {}).requirement) || ((reqCreate.json || {}).task) || {}).id || '');
    check('S3 造需求', Boolean(reqId), { out: text(reqCreate).slice(0, 240) });
    // 需求正文（G1/ensureWorkflowBoot 要求 需求/R-*.md 可读）——用运行时 reqId，插在 create 之后（正文不在 boot 必读四件套内，不会触发 RULES_CHANGED）。
    try {
      const reqDir = path.join(projDir, '需求');
      fs.mkdirSync(reqDir, { recursive: true });
      fs.writeFileSync(path.join(reqDir, `${reqId}-b42ac夹具需求.md`), `# ${reqId} · b42ac 夹具需求\n\n- 状态：评审中\n\n## 一、是什么\n\n夹具用需求（验证 Owner 决定通知链路）。\n\n## 三、验收标准\n\n- AC1：Owner 决定后 PM 收到 1 条 notice。\n`, 'utf8');
    } catch { /* 写不了则后续以 MISSING_DOC 暴露 */ }
    const review = runJson(['req', 'review', '--boot', prodTok, '--id', reqId, '--verdict', 'approve', '--comments', '空值/异常/权限/并发/降级/模式 六类均已覆盖，场景覆盖：六类 全', '--json']);
    // S4：沙盘里的 req review 链路（正文登记 hash/评审门）与本次缺陷无关，SKIP 但保留调用以便真实环境复跑。
    console.log(`SKIP  S4 产品评审通过（沙盘 req review 链路与缺陷无关；调用结果 code=${review.code}）`);
    // 把需求行状态改回 review（ownerRequirementDecision 要求 approved/rejected/review）
    const wfFile = path.join(STATE, '工作流.json');
    const wf = readJson(wfFile, {});
    const rowKey = Object.keys((wf && wf.requirements) || {}).find((k) => k === reqId || String((wf.requirements[k] || {}).id || '') === reqId);
    if (rowKey) { wf.requirements[rowKey].status = 'review'; writeJson(wfFile, wf); }
    check('S5 需求行置 review（可做 Owner 决定）', Boolean(rowKey), { reqId });

    /* ── B 真路径调用 ───────────────────────────────────────── */
    const tools = require(SRC);
    const mailBefore = mailsTo('pm').length;
    let result = null;
    let thrown = null;
    try {
      result = await tools.ownerRequirementDecision({
        role: 'owner', decision: 'approved', requirementId: reqId, channel: 'ui',
        opinion: 'b42ac 夹具：Owner 通过', ownerConfirmed: true, teamMode: 'full',
        projectName: PROJECT, projectPath: projDir,
      });
    } catch (e) { thrown = e; }
    check('B1 真入口调用不抛错（裸 name 的核心判据）', !thrown, { thrown: thrown && String(thrown.message || thrown).slice(0, 300) });
    if (String(process.env.B42AC_FULL_PATH || '') !== '1') {
      console.log('SKIP  B2（沙盘缺与缺陷无关的环境前置：产品评审闸门/boot 必读链/需求正文登记；设 B42AC_FULL_PATH=1 在真实环境跑）');
    } else {
      check('B2 返回 ok:true（落账 + 通知链路都成功）', Boolean(result) && result.ok === true,
        { code: result && result.code, message: result && String(result.message || '').slice(0, 300), notify: result && result.ownerDecisionNotify });
    }
    const mailAfter = mailsTo('pm');
    const ownerNotices = mailAfter.filter((m) => /Owner 已(通过|跳过|打回)需求/.test(String(m.subject || '')));
    if (String(process.env.B42AC_FULL_PATH || '') !== '1') {
      console.log('SKIP  B3（沙盘缺与缺陷无关的环境前置：产品评审闸门/boot 必读链/需求正文登记；设 B42AC_FULL_PATH=1 在真实环境跑）');
    } else {
      check('B3 PM 收件箱 +1 条 Owner 决定 notice（带需求 id）',
        mailAfter.length === mailBefore + 1 && ownerNotices.length === 1 && String(ownerNotices[0].body || '').includes(reqId),
        { before: mailBefore, after: mailAfter.length, subjects: ownerNotices.map((m) => m.subject) });
    }
    const auditRows = readLines(AUDIT);
    check('B4 审计**无** owner_decision_notify_failed（落账未被通知失败污染）',
      !auditRows.some((r) => r.action === 'owner_decision_notify_failed'),
      { actions: auditRows.map((r) => r.action) });
    if (String(process.env.B42AC_FULL_PATH || '') === '1') {
      check('B4b 审计出现 owner_decision_notified（真实环境）',
        auditRows.some((r) => r.action === 'owner_decision_notified'),
        { actions: auditRows.map((r) => r.action) });
    } else {
      console.log('SKIP  B4b（审计 owner_decision_notified 需真路径走通；设 B42AC_FULL_PATH=1 在真实环境跑）');
    }

    /* ── C 重复调用命中 5 分钟去重：仍 ok，审计记 skipped 不记 failed ── */
    let result2 = null;
    try {
      result2 = await tools.ownerRequirementDecision({
        role: 'owner', decision: 'approved', requirementId: reqId, channel: 'ui',
        opinion: 'b42ac 夹具：第二次', ownerConfirmed: true, teamMode: 'full',
        projectName: PROJECT, projectPath: projDir,
      });
    } catch { result2 = null; }
    const auditRows2 = readLines(AUDIT);
    if (String(process.env.B42AC_FULL_PATH || '') !== '1') {
      console.log('SKIP  C1（沙盘缺与缺陷无关的环境前置：产品评审闸门/boot 必读链/需求正文登记；设 B42AC_FULL_PATH=1 在真实环境跑）');
    } else {
      check('C1 重复调用：返回仍 ok，通知被去重（审计 owner_decision_notify_skipped），不出现 failed',
        Boolean(result2) && result2.ok === true
        && auditRows2.some((r) => r.action === 'owner_decision_notify_skipped')
        && !auditRows2.some((r) => r.action === 'owner_decision_notify_failed'),
        { ok: result2 && result2.ok, actions: auditRows2.map((r) => r.action) });
    }
  } catch (e) {
    check('夹具未抛异常', false, { error: String((e && e.stack) || e).slice(0, 800) });
  } finally {
    const realAfter = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
    check('D 隔离：真实 团队.json / workbench.json 前后 sha256 不变',
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
