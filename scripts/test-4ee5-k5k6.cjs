#!/usr/bin/env node
'use strict';
/**
 * test-4ee5-k5k6.cjs —— P0 修单 T-20261119-165248-4ee5（六人流程评估 K5+K6，Owner 已采纳）
 *
 * 覆盖五条：
 *  ① K5-finalize：`finalizePrecheck` 只认「type=dispatch && from=pm && 未回执」——
 *     回执/通知里带「派单」二字不再被当未闭环派单（旧实现 8 条误判、卡终验）。
 *  ② K5-presence：`ackPending` 排除 from===to（自己发给自己不算未回执）。
 *  ③ K5-lastActivity：`lastActivityAtOf` 计「角色产出目录 mtime + 当前会话转录 mtime」，
 *     长任务不再被 claimStallCheck 误报；告警正文注明判据/依据。
 *  ④ K6-派单锁：按 to 拆分——同角色串行仍拒、跨角色可并行、全局在途上限 2；
 *     单人锁保持旧文件格式（既有夹具/自检不受影响），多人锁写 schema:2。
 *  ⑤ 静态：上限常量单源（dispatch-check 导出、ops 引用）、文案注明依据、briefing 多锁文案。
 *
 * 全部在隔离沙盘（TEAM_ROOT/TEAM_PROJECTS_ROOT/TEAM_WORKBENCH_JSON/AWB_DATA_DIR 全指 _tmp + TEAM_SELFTEST=1）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const TEAM_TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const LIB = path.join(ROOT, '团队', '工具', 'lib');
const OUT = (() => {
  const i = process.argv.indexOf('--out');
  return i > 0 && process.argv[i + 1]
    ? path.resolve(process.argv[i + 1])
    : path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-4ee5');
})();

const rows = [];
function check(name, ok, detail) {
  let text = '';
  try { text = JSON.stringify(detail === undefined ? null : detail); } catch { text = String(detail); }
  rows.push({ name, ok: Boolean(ok), detail: ok ? undefined : text });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : ' :: ' + text.slice(0, 700)));
}
const imp = (rel) => import(pathToFileURL(path.join(LIB, rel)).href);

const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'k5k6-'));
const teamDir = path.join(sb, '团队');
const projectsDir = path.join(sb, '项目');
const dataDir = path.join(sb, 'data');
const PROJECT = '沙盘项目';
const projDir = path.join(projectsDir, PROJECT);
// 模块级调用（finalize/ops 的纯函数）在**本进程**读 PATHS，所以必须先改本进程 env（不只给子进程）。
Object.assign(process.env, {
  TEAM_ROOT: teamDir,
  TEAM_PROJECTS_ROOT: projectsDir,
  TEAM_WORKBENCH_JSON: path.join(dataDir, 'workbench.json'),
  AWB_DATA_DIR: dataDir,
  TEAM_SELFTEST: '1',
  TEAM_CLAIM_STALL_MS: '1000',
  AWB_ROUTE_DAEMON: 'off',
});
const env = { ...process.env };
function run(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [TEAM_TOOL, ...args], { cwd: ROOT, env: { ...env, ...extraEnv }, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const stdout = String(r.stdout || '');
  const stderr = String(r.stderr || '');
  let json = null;
  const start = stdout.indexOf('{');
  if (start >= 0) { try { json = JSON.parse(stdout.slice(start)); } catch { json = null; } }
  return { code: r.status, stdout, stderr, json, out: stdout + stderr };
}
const stateDir = (name) => path.join(teamDir, '状态', '项目', name);
// 项目 slug 与项目名一致（沙盘项目）；若工具改 slug 规则，读目录反查一次。
function projectStateDirOf(name) {
  const base = path.join(teamDir, '状态', '项目');
  const direct = path.join(base, name);
  if (fs.existsSync(direct)) return direct;
  try {
    for (const d of fs.readdirSync(base)) {
      const cfg = path.join(base, d, '项目.json');
      if (fs.existsSync(cfg)) { try { if (JSON.parse(fs.readFileSync(cfg, 'utf8')).name === name) return path.join(base, d); } catch { /* ignore */ } }
    }
  } catch { /* ignore */ }
  return direct;
}
const jsonl = (file) => {
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  } catch { return []; }
};
const writeMsg = (role, box, msg) => {
  const dir = path.join(teamDir, '状态', '邮箱', role, box);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${msg.id || 'M-' + Date.now()}-${Math.random().toString(16).slice(2, 8)}.json`), JSON.stringify(msg, null, 2) + '\n', 'utf8');
};

(async () => {
  let psd = '';
  try {
    // ── 0) 沙盘真实团队（init + project create + roster add）──────────────────
    const init = run(['init', '--json']);
    check('S0 team.mjs init 成功（沙盘真实团队）', Boolean(init.json && init.json.ok), init.out.slice(0, 300));
    const proj = run(['project', 'create', '--name', PROJECT, '--dir', projDir, '--json']);
    check('S0b project create 成功', Boolean(proj.json && proj.json.ok), proj.out.slice(0, 300));
    psd = projectStateDirOf(PROJECT);
    const pmBoot = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'session-k5-pm', '--json']);
    const pmTok = pmBoot.json && pmBoot.json.token;
    for (const role of ['product', 'programmer2', 'analyst', 'tester']) run(['roster', 'add', '--role', role, '--boot', pmTok, '--force', '--reason', 'K5K6 夹具', '--json']);
    const roster = run(['roster', 'list', '--json']);
    const memberRoles = roster.json && Array.isArray(roster.json.members) ? roster.json.members.map((m) => m.role) : [];
    check('S0c 名册含 k5k6 需要的角色', ['pm', 'programmer1', 'programmer2', 'analyst', 'tester'].every((r) => memberRoles.includes(r)), memberRoles);

    // ── ① K5-finalize ──────────────────────────────────────────────────────
    const finalize = await imp('finalize.mjs');
    // 清空邮箱（沙盘），再按四种消息 seed
    try { fs.rmSync(path.join(teamDir, '状态', '邮箱'), { recursive: true, force: true }); } catch { /* ignore */ }
    const dA = { id: 'M-K5-DISP', from: 'pm', to: 'programmer1', type: 'dispatch', subject: '派单：真派单', body: 'x', ackRequired: true, ts: new Date().toISOString() };
    writeMsg('programmer1', 'new', dA);
    writeMsg('pm', 'new', { id: 'M-K5-RCPT', from: 'programmer1', to: 'pm', type: 'receipt', subject: '回执: 派单 M-K5-DISP 已读', body: 'x', ts: new Date().toISOString() });
    writeMsg('programmer1', 'new', { id: 'M-K5-NOTICE', from: 'system', to: 'programmer1', type: 'notice', subject: '派单锁提醒：锁已释放', body: 'x', ts: new Date().toISOString() });
    const dD = { id: 'M-K5-DONE', from: 'pm', to: 'tester', type: 'dispatch', subject: '派单：已回执的那条', body: 'x', ackRequired: true, ts: new Date().toISOString() };
    writeMsg('tester', 'new', dD);
    fs.appendFileSync(path.join(teamDir, '状态', '回执.jsonl'), JSON.stringify({ at: new Date().toISOString(), id: 'A-K5-1', msgId: dD.id, from: 'tester', role: 'tester' }) + '\n', 'utf8');
    const pre = finalize.finalizePrecheck(PROJECT);
    const ids = (pre.dispatches || []).map((d) => d.id);
    check('F1 finalize 只认真派单：只命中 type=dispatch && from=pm 且未回执的那条',
      ids.length === 1 && ids[0] === dA.id, { ids, dispatches: pre.dispatches });
    check('F1b 含「派单」二字的回执/通知不再被计入（旧实现误判 8 条）',
      !ids.includes('M-K5-RCPT') && !ids.includes('M-K5-NOTICE'), ids);
    check('F1c 已回执的 dispatch 不计入未闭环', !ids.includes(dD.id), ids);

    // ── ② K5-presence：from===to 不算未回执 ────────────────────────────────
    try { fs.rmSync(path.join(teamDir, '状态', '邮箱'), { recursive: true, force: true }); } catch { /* ignore */ }
    const ops = await imp('ops.mjs');
    const readAt = new Date().toISOString();
    writeMsg('pm', 'new', { id: 'M-K5-SELF', from: 'pm', to: 'pm', type: 'notice', subject: '自己发自己', body: 'x', ackRequired: true, deliveredAt: readAt, readAt, ts: readAt });
    writeMsg('programmer1', 'new', { id: 'M-K5-SELF2', from: 'programmer1', to: 'programmer1', type: 'notice', subject: '自己发自己2', body: 'x', ackRequired: true, deliveredAt: readAt, readAt, ts: readAt });
    const presSelf = ops.presenceFor(PROJECT, { roles: ['pm', 'programmer1'] }) || [];
    const pmRow = presSelf.find((r) => r.role === 'pm') || {};
    const devRow = presSelf.find((r) => r.role === 'programmer1') || {};
    check('F2 from===to 不计未回执（pm→pm / programmer1→programmer1 都是 0）',
      pmRow.ackPending === 0 && devRow.ackPending === 0, { pm: pmRow.ackPending, dev: devRow.ackPending });
    writeMsg('programmer1', 'new', { id: 'M-K5-REAL', from: 'pm', to: 'programmer1', type: 'dispatch', subject: '真派单', body: 'x', ackRequired: true, deliveredAt: readAt, readAt, ts: readAt });
    const presReal = (ops.presenceFor(PROJECT, { roles: ['programmer1'] }) || [])[0] || {};
    check('F2b 别人发来的未回执仍然计数（不放过真待办）', presReal.ackPending === 1, { ackPending: presReal.ackPending, ids: presReal.ackPendingIds });

    // ── ③ K5-lastActivity：产出目录 + 会话转录 ─────────────────────────────
    const devBoot = run(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 'session-k5-p1', '--json']);
    const devTok = devBoot.json && devBoot.json.token;
    const pmTok2 = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'session-k5-pm', '--json']).json.token;
    // 绑定四映射（roster/boot 不会自动写 members[].sessionId）：用 batch rotate 落一次（六个项目角色都要一致）
    const sessionIds = {
      pm: 'session-k5-pm', product: 'session-k5-pr', analyst: 'session-k5-an',
      programmer1: 'session-k5-p1', programmer2: 'session-k5-p2', tester: 'session-k5-t',
    };
    run(['session', 'rotate', '--batch', '--project', PROJECT, '--roles', Object.keys(sessionIds).join(','),
      '--sessions', Object.entries(sessionIds).map(([r, id]) => `${r}=${id}`).join(','),
      '--offline', '--reason', 'K5 夹具', '--json'], { TEAM_ROTATE_HANDOVER_TEXT: '【在途任务】无\n【未闭环事项】无\n【最近决策】无\n【建议下一步】无\n【遗留问题与坑】无已知坑' });
    // 造一条 working 任务（owner=programmer1）
    const task = run(['task', 'create', '--boot', pmTok2, '--title', 'K5 长任务', '--priority', 'P1', '--owner', 'programmer1', '--json']);
    const taskId = task.json && task.json.task && task.json.task.id;
    run(['task', 'claim', '--boot', devTok, '--id', taskId, '--json']);
    // 把任务「最后变化」拨旧：既拨 mtime，也改 updatedAt/claimedAt（lastActivity 会读这两个字段，
    // 只拨 mtime 不够——那会让"任务文件刚被写过"仍算在动，测不到新信号）。
    const taskFile = path.join(psd, '任务', `${taskId}.json`);
    const old = new Date(Date.now() - 30 * 60 * 1000);
    try {
      const taskObj = JSON.parse(fs.readFileSync(taskFile, 'utf8'));
      taskObj.updatedAt = old.toISOString();
      taskObj.claimedAt = old.toISOString();
      fs.writeFileSync(taskFile, JSON.stringify(taskObj, null, 2) + '\n', 'utf8');
      fs.utimesSync(taskFile, old, old);
    } catch { /* ignore */ }
    // 产出目录写一个"刚刚"的文件
    const outDir = path.join(projDir, '程序员A', '产出');
    fs.mkdirSync(outDir, { recursive: true });
    const outFile = path.join(outDir, '长任务中间产物.md');
    fs.writeFileSync(outFile, '# 中间产物\n', 'utf8');
    fs.utimesSync(outFile, new Date(), new Date());
    const now = Date.now();
    const activityOut = ops.lastActivityAtOf(PROJECT, { role: 'programmer1', taskId });
    check('F3 产出目录最近写入被计入 lastActivity（> 任务旧 mtime）', activityOut > now - 5 * 60 * 1000, { activityOut: new Date(activityOut).toISOString(), now: new Date(now).toISOString() });
    // 会话转录：写一个"刚刚"的转录文件（项目状态 会话转录/<sid>.json）
    const trDir = path.join(psd, '会话转录');
    fs.mkdirSync(trDir, { recursive: true });
    const trFile = path.join(trDir, 'session-k5-p1.json');
    fs.writeFileSync(trFile, JSON.stringify({ session: 'session-k5-p1', turns: [] }, null, 2), 'utf8');
    const activityTr = (() => {
      try { fs.utimesSync(trFile, new Date(), new Date()); fs.utimesSync(outFile, old, old); return ops.lastActivityAtOf(PROJECT, { role: 'programmer1', taskId }); } catch { return 0; }
    })();
    check('F3b 会话转录 mtime 被计入 lastActivity（即使产出目录是旧的）', activityTr > now - 5 * 60 * 1000, { activityTr: activityTr ? new Date(activityTr).toISOString() : '' });
    // 两路都旧 → claimStallCheck 应告警，且文案注明依据
    fs.utimesSync(trFile, old, old);
    const stall = ops.claimStallCheck(PROJECT, { now: Date.now() });
    check('F3c 两路都旧时仍会告警（不因新增信号而漏报）', (stall.hits || []).some((h) => h.taskId === taskId), { stallMs: stall.stallMs, hits: stall.hits });
    const mailboxRows = (role) => {
      const out = [];
      for (const box of ['new', 'cur']) {
        const dir = path.join(teamDir, '状态', '邮箱', role, box);
        let names = [];
        try { names = fs.readdirSync(dir); } catch { continue; }
        for (const n of names) {
          if (!n.endsWith('.json')) continue;
          try { out.push(JSON.parse(fs.readFileSync(path.join(dir, n), 'utf8'))); } catch { /* ignore */ }
        }
      }
      return out;
    };
    const escalation = mailboxRows('pm')
      .filter((m) => m && m.type === 'escalation' && /认领后/.test(String(m.subject || '')) && String(m.body || '').includes(taskId))
      .pop();
    check('F4 告警正文注明判据/依据（六路信号 + 取最新时间）',
      Boolean(escalation) && /判据 \/ 依据：/.test(String(escalation.body)) && /会话转录/.test(String(escalation.body)) && /产出目录/.test(String(escalation.body)),
      escalation ? String(escalation.body).slice(0, 240) : 'no escalation');

    // ── ④ K6 派单锁按 to 拆分 ──────────────────────────────────────────────
    const lockFile = path.join(psd, '派单锁.json');
    try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ }
    const p2Boot = run(['boot', '--role', 'programmer2', '--project', PROJECT, '--session', 'session-k5-p2', '--json']).json.token;
    const anBoot = run(['boot', '--role', 'analyst', '--project', PROJECT, '--session', 'session-k5-an', '--json']).json.token;
    const p2Send = run(['send', '--boot', pmTok2, '--to', 'programmer2', '--subject', 'K6 派单给 p2', '--body', 'x', '--ack', '--json']);
    check('K1 跨角色用例起点：给 programmer2 派单成功', Boolean(p2Send.json && p2Send.json.ok && p2Send.json.dispatch === true), p2Send.out.slice(0, 300));
    const lockRaw1 = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    check('K2 单人锁保持旧文件格式（无 schema/locks，兼容既有夹具）', !lockRaw1.locks && !lockRaw1.schema && Boolean(lockRaw1.messageId), Object.keys(lockRaw1));
    const sameRole = run(['send', '--boot', pmTok2, '--to', 'programmer2', '--subject', '同角色再来一条', '--body', 'x', '--ack', '--json']);
    check('K3 同角色串行仍拒（PM_DISPATCH_PENDING）', Boolean(sameRole.json) && sameRole.json.code === 'PM_DISPATCH_PENDING', { code: sameRole.json && sameRole.json.code });
    const dcP2 = run(['dispatch-check', '--boot', pmTok2, '--project', PROJECT, '--to', 'programmer2', '--json']);
    check('K4 dispatch-check：锁指向自己 → blocked', Boolean(dcP2.json) && dcP2.json.verdict === 'blocked' && /派单锁在/.test(JSON.stringify(dcP2.json.reasons || [])), { verdict: dcP2.json && dcP2.json.verdict, reasons: dcP2.json && dcP2.json.reasons });
    const dcAn = run(['dispatch-check', '--boot', pmTok2, '--project', PROJECT, '--to', 'analyst', '--json']);
    check('K5 dispatch-check：别的角色持锁不挡我（跨角色并行）',
      Boolean(dcAn.json) && dcAn.json.verdict !== 'blocked', { verdict: dcAn.json && dcAn.json.verdict, reasons: dcAn.json && dcAn.json.reasons });
    const crossSend = run(['send', '--boot', pmTok2, '--to', 'analyst', '--subject', 'K6 跨角色并行', '--body', 'x', '--ack', '--json']);
    check('K6 跨角色可并行：analyst 第二条在途成功', Boolean(crossSend.json && crossSend.json.ok && crossSend.json.dispatch === true), crossSend.out.slice(0, 300));
    const lockRaw2 = JSON.parse(fs.readFileSync(lockFile, 'utf8'));
    check('K7 两条在途时写 schema:2 + locks（按角色槽位）', lockRaw2.schema === 2 && lockRaw2.locks && Boolean(lockRaw2.locks.programmer2) && Boolean(lockRaw2.locks.analyst), Object.keys(lockRaw2));
    const third = run(['send', '--boot', pmTok2, '--to', 'tester', '--subject', '全局上限', '--body', 'x', '--ack', '--json']);
    check('K8 全局在途上限 2：第三条被拒（PM_DISPATCH_GLOBAL_LIMIT）', Boolean(third.json) && third.json.code === 'PM_DISPATCH_GLOBAL_LIMIT', { code: third.json && third.json.code, details: third.json && third.json.details });
    const briefing = run(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 'session-k5-p1', '--json']);
    const briefText = String((briefing.json && briefing.json.briefing) || '');
    check('K9 boot 简报多锁文案可读（N 条在途（上限 2））', /派单锁: 2 条在途（上限 2）/.test(briefText), briefText.split(/\r?\n/).filter((l) => /派单锁/.test(l)).join(' | '));
    // 释放一条：走 finalize precheck（只读）验证锁结构变更未打断终验前置
    const cleanup = finalize.finalizePrecheck(PROJECT);
    check('K10 finalize precheck 仍可用（不被锁结构变更打断）', Boolean(cleanup) && typeof cleanup.ok === 'boolean', { ok: cleanup && cleanup.ok });

    // ── ⑤ 静态单源 ─────────────────────────────────────────────────────────
    const opsSrc = fs.readFileSync(path.join(LIB, 'ops.mjs'), 'utf8');
    const dcSrc = fs.readFileSync(path.join(LIB, 'dispatch-check.mjs'), 'utf8');
    const finSrc = fs.readFileSync(path.join(LIB, 'finalize.mjs'), 'utf8');
    check('S1 上限常量单源：dispatch-check 导出、ops 引用（ops 内无 `= 2` 字面量常量）',
      /export const DISPATCH_LOCK_MAX_INFLIGHT = 2;/.test(dcSrc) && /import \{[^}]*DISPATCH_LOCK_MAX_INFLIGHT[^}]*\} from '\.\/dispatch-check\.mjs'/.test(opsSrc) && !/const DISPATCH_LOCK_MAX_INFLIGHT = 2;/.test(opsSrc), null);
    check('S2 finalize 用落盘字段 type（不是只认 kind）且判 from=pm',
      /msg\.type \|\| msg\.kind/.test(finSrc) && /from !== 'pm'/.test(finSrc), null);
    check('S3 presence 过滤 from===to', /String\(row\.msg\.from \|\| ''\) !== String\(row\.msg\.to \|\| ''\)/.test(opsSrc), null);
    check('S4 lastActivity 有两路新信号（产出目录 dirLatestMs + 会话转录 transcriptCandidateFiles）',
      /dirLatestMs/.test(opsSrc) && /transcriptCandidateFiles\(/.test(opsSrc) && /roleCurrentSessionId\(/.test(opsSrc), null);
  } finally {
    try { fs.rmSync(sb, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const pass = rows.filter((r) => r.ok).length;
  const fail = rows.length - pass;
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'test-4ee5-k5k6.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      head: (() => { try { return spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(); } catch { return ''; } })(),
      task: 'T-20261119-165248-4ee5', pass, fail, total: rows.length, rows,
    }, null, 2), 'utf8');
  } catch { /* ignore */ }
  console.log(`\n${pass}/${rows.length} PASS${fail ? ` · ${fail} FAIL` : ''}`);
  process.exit(fail ? 1 : 0);
})();
