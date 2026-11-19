#!/usr/bin/env node
'use strict';
/**
 * test-a1eb-ruleshash-split.cjs —— R-20261119-140657-a1eb（T-20261119-141943-0cda）夹具
 *
 * 覆盖（工具层）：
 *   AC1 换一人不废他人：六角色都 boot → 只换 programmer1
 *        ① programmer1 旧令牌写 → SESSION_REPLACED
 *        ② 其余 5 角色 send + task claim 各 1 次全部成功，且**不出现 RULES_CHANGED**
 *        ③ 写命令 stderr 给 rosterChangedSinceToken=true（仅提示，不阻断）
 *   AC2 批量只广播一次：session rotate --batch --roles programmer1,programmer2
 *        ① 名册变更.jsonl：batch 汇总行恰好 1 行 + 每角色 1 行
 *        ② 一次广播：每个收件人邮箱里 kind=system 且含两角色名的消息恰好 1 条
 *        ③ BQ 恰好 2 条
 *        ④ 返回 {broadcast:1, bootPending:2}
 *   AC3 旧会话写入被拒：旧令牌 send / req write / task done → 三个 SESSION_REPLACED，
 *        且 团队.json / 邮箱目录 / 工作流.json / 文档登记.jsonl 前后 sha256 不变（拒绝路径零写入）
 *   AC7 可观测：名册变更.jsonl 的 batch 行字段齐（batchId/roles/by/at/rosterVersionBefore/After）；
 *        boot --json 含 rulesHash/rosterVersion 前 12 位
 *   隔离：四根 env 全指沙盘；真实 团队.json / data/userdata/workbench.json 前后 sha256 不变
 *
 * 用法：node scripts/test-a1eb-ruleshash-split.cjs [--json]
 * 退出码：0 全过 / 1 有断言失败 / 2 环境错误
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const JSON_OUT = process.argv.includes('--json');
const PROJECT = 'a1eb-名册拆分';
const ROLES = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];

const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
  return Boolean(ok);
}
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '(missing)'; } };
const shaDir = (dir) => {
  // 目录指纹：递归 (相对路径 + 内容 sha) 排序后再 sha（邮箱/任务目录用）
  try {
    const rows = [];
    const walk = (d) => {
      for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
        const p = path.join(d, ent.name);
        if (ent.isDirectory()) walk(p);
        else rows.push(`${path.relative(dir, p).replace(/\\/g, '/')}:${sha(p)}`);
      }
    };
    walk(dir);
    return crypto.createHash('sha256').update(rows.sort().join('|')).digest('hex');
  } catch (e) { return `(missing:${(e && e.message) || e})`; }
};
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
const jsonl = (f) => {
  try { return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
};

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'a1eb-'));
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench-a1eb.json');
const DATA = path.join(SB, 'data');
const STATE = path.join(TEAM, '状态', '项目', PROJECT);
const TEAM_FILE = path.join(TEAM, '状态', '团队.json');
const ROSTER_AUDIT = path.join(STATE, '名册变更.jsonl');
const BOOT_QUEUE = path.join(STATE, '待启动队列.json');
const MAIL = path.join(TEAM, '状态', '邮箱');
const REAL_TEAM_FILE = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');

function env(extra = {}) {
  // 关键：清掉宿主 DSH_SESSION_ID——否则 `boot` 的 sessionOf() 会把**当前代理会话**当成本角色会话写进令牌，
  // 夹具里就永远命中 SESSION_REPLACED（真实生产里两者本来就一致，夹具必须显式 --session）。
  const { DSH_SESSION_ID, ...base0 } = process.env;
  const base = {
    ...base0,
    TEAM_ROOT: TEAM,
    TEAM_PROJECTS_ROOT: PROJECTS,
    TEAM_WORKBENCH_JSON: STORE,
    AWB_DATA_DIR: DATA,
    AWB_STORE: STORE,
    TEAM_SELFTEST: '1',
    TEAM_BOOT_ENFORCE: '',
    TEAM_ROSTER_DSH_ENFORCE: '',
    TEAM_HANDOVER_ENFORCE: '',
    TEAM_ROTATE_HANDOVER_TEXT: '',
    TEAM_HANDOVER_REQUIRED: '',
  };
  return { ...base, ...extra };
}
function run(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: env(extraEnv), timeout: 180000, cwd: SB });
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
const text = (r) => String(r.out || '') + String(r.err || '');
const tokenOf = (r) => {
  const direct = String((r.json && (r.json.token || (r.json.boot && r.json.boot.token))) || '');
  if (direct) return direct;
  const m = /令牌[:：]\s*([0-9a-f]{8,})/i.exec(String(r.out || ''));
  return m ? m[1] : '';
};
const rosterOf = (role) => String(((readJson(TEAM_FILE, { members: [] }).members || []).find((m) => m && m.role === role) || {}).sessionId || '');
const mailsOf = (role) => {
  const out = [];
  for (const box of ['new', 'cur']) {
    const dir = path.join(MAIL, role, box);
    try {
      for (const n of fs.readdirSync(dir)) {
        if (!n.endsWith('.json')) continue;
        const row = readJson(path.join(dir, n), null);
        if (row) out.push(row);
      }
    } catch { /* 空箱 */ }
  }
  return out;
};

const realBefore = { team: sha(REAL_TEAM_FILE), store: sha(REAL_STORE) };
let exitCode = 0;
try {
  if (!fs.existsSync(TOOL)) { console.error('环境错误：找不到 team.mjs'); process.exit(2); }
  check('S0 沙盘 init', run(['init']).code === 0, {});
  check('S1 沙盘建项目（full 六角色）', run(['project', 'add', '--name', PROJECT, '--team-mode', 'full']).code === 0, {});

  // 种子：六角色名册会话 + 项目映射 + workbench
  const team = readJson(TEAM_FILE, { members: [] });
  team.activeProject = PROJECT;
  for (const role of ROLES) {
    let m = (team.members || []).find((x) => x && x.role === role);
    if (!m) { m = { role, name: role, status: 'active', joinedAt: new Date().toISOString() }; team.members.push(m); }
    m.sessionId = `session-a1eb-${role}-v1`;
    m.status = 'active';
  }
  writeJson(TEAM_FILE, team);
  const projMeta = readJson(path.join(STATE, '项目.json'), {});
  const projectDir = String(projMeta.path || path.join(PROJECTS, PROJECT));
  writeJson(path.join(projectDir, '团队会话.json'), {
    project: PROJECT, teamMode: 'full', workspace: projectDir, generatedAt: new Date().toISOString(),
    roles: ROLES.map((role) => ({ role, name: role, title: `团队·${role}`, sessionId: `session-a1eb-${role}-v1`, reused: false, model: '' })),
  });
  writeJson(STORE, {
    projects: [{
      id: 'a1eb-p1', name: PROJECT, teamName: PROJECT, path: projectDir,
      sessions: Object.fromEntries(ROLES.map((r) => [r, `session-a1eb-${r}-v1`])),
      workspace: { path: projectDir, sessionIds: ROLES.map((r) => `session-a1eb-${r}-v1`) },
    }],
    activeProjectId: 'a1eb-p1',
  });
  const mapCheck = runJson(['session', 'check', '--project', PROJECT, '--json']);
  check('S2 沙盘四处映射 6/6（夹具就绪）',
    mapCheck.code === 0 && (mapCheck.json || {}).ok === true && String((mapCheck.json || {}).ratio || '') === '6/6',
    { code: mapCheck.code, ratio: (mapCheck.json || {}).ratio, out: text(mapCheck).slice(0, 300) });

  // 六角色 boot（拿旧令牌；此时名册 rosterVersion = V1）
  const tokens = {};
  const bootJsons = {};
  for (const role of ROLES) {
    const r = runJson(['boot', '--role', role, '--project', PROJECT, '--session', `session-a1eb-${role}-v1`, '--json']);
    tokens[role] = tokenOf(r);
    bootJsons[role] = r.json || null;
  }
  check('S3 六角色 boot 成功', ROLES.every((r) => Boolean(tokens[r])), { tokens: Object.fromEntries(Object.entries(tokens).map(([k, v]) => [k, String(v).slice(0, 8)])) });
  check('S4 boot --json 含两哈希前 12 位（AC7）+ rosterChangedSinceToken 字段',
    ROLES.every((r) => {
      const j = bootJsons[r] || {};
      return String(j.rulesHashShort || '').length === 12 && String(j.rosterVersionShort || '').length === 12
        && typeof j.rosterChangedSinceToken === 'boolean';
    }),
    { pm: (bootJsons.pm || {}).rulesHashShort, roster: (bootJsons.pm || {}).rosterVersionShort });

  // 为每个角色各建一个任务（AC1② 要 task claim 各 1 次）
  const taskIds = {};
  for (const role of ROLES) {
    const t = runJson(['task', 'create', '--boot', tokens.pm, '--title', `a1eb 夹具任务 ${role}`, '--priority', 'P1', '--owner', role, '--json']);
    taskIds[role] = String((t.json && (t.json.task && t.json.task.id || t.json.id)) || '');
    if (!taskIds[role]) check(`S5 task create for ${role}`, false, { out: text(t).slice(0, 300) });
  }
  check('S5 六角色各建一个任务', ROLES.every((r) => Boolean(taskIds[r])), { taskIds });

  /* ── AC1：只换 programmer1，其余 5 角色令牌不受影响 ─────────────────── */
  const rosterBefore = sha(TEAM_FILE);
  const rotate = runJson(['session', 'rotate', '--project', PROJECT, '--role', 'programmer1',
    '--session', 'session-a1eb-programmer1-v2', '--reason', 'AC1 只换一人', '--json']);
  check('AC1① 单角色 rotate 成功', rotate.code === 0 && (rotate.json || {}).ok === true, { code: rotate.code, out: text(rotate).slice(0, 400) });
  check('AC1① 名册确实改了 programmer1', rosterOf('programmer1') === 'session-a1eb-programmer1-v2', { current: rosterOf('programmer1') });

  // ② 其余 5 角色：send + task claim 各 1 次，全部成功且无 RULES_CHANGED
  const others = ROLES.filter((r) => r !== 'programmer1');
  const sendResults = {};
  const claimResults = {};
  for (const role of others) {
    // 收件人不能是自己（SELF_SEND），pm 发给 tester，其余发给 pm
    const to = role === 'pm' ? 'tester' : 'pm';
    sendResults[role] = run(['send', '--boot', tokens[role], '--to', to, '--subject', `AC1② ${role} 写操作`, '--body', '换人后其余角色令牌应仍可用']);
    claimResults[role] = run(['task', 'claim', '--id', taskIds[role], '--boot', tokens[role]]);
  }
  const noRulesChanged = others.every((r) => !/RULES_CHANGED/.test(text(sendResults[r]) + text(claimResults[r])));
  check('AC1② 其余 5 角色 send 全部成功（无 RULES_CHANGED）',
    others.every((r) => sendResults[r].code === 0) && noRulesChanged,
    { codes: Object.fromEntries(others.map((r) => [r, sendResults[r].code])), sample: text(sendResults[others[0]]).slice(0, 300) });
  check('AC1② 其余 5 角色 task claim 全部成功（无 RULES_CHANGED）',
    others.every((r) => claimResults[r].code === 0),
    { codes: Object.fromEntries(others.map((r) => [r, claimResults[r].code])), sample: text(claimResults[others[0]]).slice(0, 300) });
  check('AC1② 未出现 SESSION_REPLACED / RULES_CHANGED（他人换人不阻塞我）',
    others.every((r) => !/SESSION_REPLACED|RULES_CHANGED/.test(text(sendResults[r]) + text(claimResults[r]))), {});

  // ① programmer1 旧令牌写 → SESSION_REPLACED
  const oldDevSend = run(['send', '--boot', tokens.programmer1, '--to', 'pm', '--subject', 'AC1① 旧会话', '--body', '应被 SESSION_REPLACED 拒']);
  check('AC1① programmer1 旧令牌写 → SESSION_REPLACED',
    oldDevSend.code !== 0 && /SESSION_REPLACED/.test(text(oldDevSend)),
    { code: oldDevSend.code, out: text(oldDevSend).slice(0, 400) });

  // ③ rosterChangedSinceToken 提示（stderr，不阻断）
  const noticeRole = others.find((r) => /rosterChangedSinceToken/.test(text(sendResults[r])));
  check('AC1③ 写命令给 rosterChangedSinceToken=true 提示（仅提示、不阻断）',
    Boolean(noticeRole) && sendResults[noticeRole].code === 0,
    { role: noticeRole, err: noticeRole ? sendResults[noticeRole].err.slice(0, 300) : '' });

  /* ── AC3：旧会话写入被拒且零写入 ─────────────────────────────────────── */
  const before3 = {
    team: sha(TEAM_FILE),
    mail: shaDir(MAIL),
    wf: sha(path.join(STATE, '工作流.json')),
    docs: sha(path.join(STATE, '文档登记.jsonl')),
  };
  const oldTok = tokens.programmer1;
  const a3send = run(['send', '--boot', oldTok, '--to', 'pm', '--subject', 'AC3 send', '--body', 'x']);
  const a3req = run(['req', 'write', '--boot', oldTok, '--requirement', 'R-20261119-140657-a1eb', '--file', 'x.md']);
  const a3done = run(['task', 'done', '--id', taskIds.programmer1, '--boot', oldTok, '--evidence', 'x.md']);
  check('AC3 旧令牌 send/req write/task done 三次全部 SESSION_REPLACED',
    /SESSION_REPLACED/.test(text(a3send)) && /SESSION_REPLACED/.test(text(a3req)) && /SESSION_REPLACED/.test(text(a3done)),
    { send: text(a3send).slice(0, 200), req: text(a3req).slice(0, 200), done: text(a3done).slice(0, 200) });
  check('AC3 拒绝路径零写入（团队.json / 邮箱 / 工作流.json / 文档登记.jsonl sha256 全不变）',
    sha(TEAM_FILE) === before3.team && shaDir(MAIL) === before3.mail
    && sha(path.join(STATE, '工作流.json')) === before3.wf && sha(path.join(STATE, '文档登记.jsonl')) === before3.docs,
    {
      team: [before3.team.slice(0, 12), sha(TEAM_FILE).slice(0, 12)],
      mail: [before3.mail.slice(0, 12), shaDir(MAIL).slice(0, 12)],
      wf: [before3.wf.slice(0, 12), sha(path.join(STATE, '工作流.json')).slice(0, 12)],
      docs: [before3.docs.slice(0, 12), sha(path.join(STATE, '文档登记.jsonl')).slice(0, 12)],
    });

  /* ── AC2：批量换人只广播一次 ────────────────────────────────────────── */
  const auditsBefore = jsonl(ROSTER_AUDIT).length;
  const mailBefore = Object.fromEntries(ROLES.map((r) => [r, mailsOf(r).length]));
  // 批量前先给两个角色落新会话映射（沙盘用 --sessions 指定）
  const batch = runJson(['session', 'rotate', '--project', PROJECT, '--batch',
    '--roles', 'programmer1,programmer2',
    '--sessions', 'programmer1=session-a1eb-programmer1-v3,programmer2=session-a1eb-programmer2-v3',
    '--reason', 'AC2 批量换人', '--json']);
  check('AC2 批量 rotate 命令成功', batch.code === 0 && (batch.json || {}).ok === true, { code: batch.code, out: text(batch).slice(0, 500) });
  const bj = batch.json || {};
  check('AC2④ 返回 {broadcast:1, bootPending:2}', Number(bj.broadcast) === 1 && Number(bj.bootPending) === 2, { broadcast: bj.broadcast, bootPending: bj.bootPending });
  check('AC2 名册一次事务写入：两角色 sessionId 同时更新',
    rosterOf('programmer1') === 'session-a1eb-programmer1-v3' && rosterOf('programmer2') === 'session-a1eb-programmer2-v3',
    { p1: rosterOf('programmer1'), p2: rosterOf('programmer2') });
  const newAuditRows = jsonl(ROSTER_AUDIT).slice(auditsBefore);
  const batchRows = newAuditRows.filter((r) => r && r.event === 'roster_rotate_batch');
  const roleRows = newAuditRows.filter((r) => r && r.event === 'roster_rotate');
  check('AC2① 名册变更.jsonl：batch 汇总行恰好 1 行 + 每角色 1 行（共 2 行）',
    batchRows.length === 1 && roleRows.length === 2
    && ['programmer1', 'programmer2'].every((r) => roleRows.some((x) => x.role === r)),
    { batchRows: batchRows.length, roleRows: roleRows.map((x) => x.role) });
  check('AC7 batch 汇总行字段齐（batchId/roles/by/at/rosterVersionBefore/After）',
    Boolean(batchRows[0] && batchRows[0].batchId && Array.isArray(batchRows[0].roles) && batchRows[0].roles.length === 2
      && batchRows[0].by && batchRows[0].at && batchRows[0].rosterVersionBefore && batchRows[0].rosterVersionAfter),
    { row: batchRows[0] });
  // ② 每个收件人：**一次批量广播**恰好 1 条（subject 含「批量换人」且含两角色名）
  const broadcastHits = {};
  for (const role of ROLES) {
    broadcastHits[role] = mailsOf(role)
      .filter((m) => String(m.from || '') === 'system')
      .filter((m) => /批量换人/.test(String(m.subject || '')) && /programmer1/.test(String(m.subject || '') + String(m.body || '')) && /programmer2/.test(String(m.subject || '') + String(m.body || '')))
      .map((m) => m.subject);
  }
  const broadcastCounts = Object.fromEntries(Object.entries(broadcastHits).map(([r, v]) => [r, v.length]));
  check('AC2② 一次广播：每个收件人邮箱里「批量换人」系统消息恰好 1 条（含两角色名）',
    ROLES.every((r) => broadcastCounts[r] === 1), { broadcastCounts, broadcastHits, mailBefore });
  // ③ BQ 恰好 2 条（新会话）
  const bq = readJson(BOOT_QUEUE, { items: [] });
  const bqRoles = (bq.items || []).map((x) => String(x.role || ''));
  check('AC2③ BQ 恰好 2 条（programmer1/programmer2）',
    (bq.items || []).length === 2 && ['programmer1', 'programmer2'].every((r) => bqRoles.includes(r)),
    { items: (bq.items || []).map((x) => ({ role: x.role, id: x.id })) });
  // 批量后：未参与批量的角色仍然可用（换人不废他人，再次验证）
  const afterBatchSend = run(['send', '--boot', tokens.tester, '--to', 'pm', '--subject', 'AC2 批量后 tester 仍可写', '--body', 'ok']);
  check('AC2 批量换人后未参与者令牌仍可用（无 RULES_CHANGED）',
    afterBatchSend.code === 0 && !/RULES_CHANGED/.test(text(afterBatchSend)), { code: afterBatchSend.code, out: text(afterBatchSend).slice(0, 200) });
} catch (e) {
  check('夹具未抛异常', false, { error: String((e && e.stack) || e) });
} finally {
  // 隔离：真实状态零写入
  const realAfter = { team: sha(REAL_TEAM_FILE), store: sha(REAL_STORE) };
  check('S9 隔离：真实 团队.json / workbench.json 前后 sha256 不变',
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
