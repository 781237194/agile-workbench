#!/usr/bin/env node
'use strict';
/**
 * test-6c35-pm-rotate-idle.cjs —— P1 B-20261120-110351-6c35 + B-20261120-121345-f25d 夹具
 *                                   （PM 换人静默门：只认本人发出的消息）
 *
 * 缺陷演进：
 *   1) c35：`session.mjs → pmRotateIdleState()` 旧口径把「收到的系统通知」也算成 PM 活跃——
 *      路由泵 wake 摘要 / 名册变更广播 / 认领停滞提醒每条都是 from=system，投一条就把 15 分钟倒计时重置。
 *   2) f25d（PM 2026-11-20 12:13 实测）：只排除 system 还不够——PM 收到别人的 ack/回执也重置倒计时，
 *      而「收到」不等于 PM 在干活。口径最终定为：**只有本人发出的消息算活跃**（扫全队邮箱取 from===role）。
 * 不变：running 会话 / working 任务 / 在途派单锁三条硬判据。
 *
 * 断言（5 条）：
 *  A1 pm 邮箱只有 from=system、2 分钟前的通知 → pm idle === true（系统通知不算活跃）
 *  A2 pm 收到 from=product、2 分钟前的消息（自己没发）→ pm idle === true（收到的不算活跃）
 *  A3 pm 1 分钟前给 product 发过消息（落在 product 邮箱）→ pm idle === false 且 reason 含「本人发出过消息」
 *  A4 30 分钟前本人发出 + 新收到的角色/系统消息 → pm idle === true（窗口 + 来源两重过滤）
 *  A5 给 pm 派一个 status=working 的任务 → pm idle === false（tasks 硬判据未被削弱）
 *
 * 为什么每条断言起子进程：`团队/工具/lib/core.mjs` 的 PATHS 在 import 时解析 TEAM_ROOT /
 * TEAM_PROJECTS_ROOT，同一进程里换沙盘不生效（import 缓存）→ 必须 env 指沙盘 + 子进程跑。
 *
 * 用法：node scripts/test-6c35-pm-rotate-idle.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const SESSION_SRC = path.join(ROOT, '团队', '工具', 'lib', 'session.mjs');
const REAL_TEAM = path.join(ROOT, '团队', '状态', '团队.json');
const PROJECT = '沙盘6c35';
const MARK = '@@6c35@@';
const MIN = 60 * 1000;

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-6c35-'));
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench.json');
const DATA = path.join(SB, 'data');
const MAIL_NEW = path.join(TEAM, '状态', '邮箱', 'pm', 'new');
const TASK_DIR = path.join(TEAM, '状态', '项目', PROJECT, '任务');

const ROWS = [];
function check(id, title, ok, detail) {
  ROWS.push({ id, ok: Boolean(ok) });
  if (ok) console.log(`PASS  ${id} ${title}`);
  else console.log(`FAIL  ${id} ${title} · ${String(JSON.stringify(detail)).slice(0, 900)}`);
  return Boolean(ok);
}

function childEnv() {
  const { DSH_SESSION_ID, ...base } = process.env;
  return {
    ...base,
    TEAM_ROOT: TEAM,
    TEAM_PROJECTS_ROOT: PROJECTS,
    TEAM_WORKBENCH_JSON: STORE,
    AWB_DATA_DIR: DATA,
    TEAM_SELFTEST: '1',
  };
}

function childScript() {
  const url = pathToFileURL(SESSION_SRC).href;
  return `
const { pathToFileURL } = require('node:url');
(async () => {
  const mod = await import(${JSON.stringify(url)});
  const st = mod.pmRotateIdleState(${JSON.stringify(PROJECT)});
  const pm = (st && st.roles && st.roles.pm) || {};
  process.stdout.write(${JSON.stringify(MARK)} + JSON.stringify({
    ok: st && st.ok,
    minutes: st && st.minutes,
    idle: pm.idle === true,
    reasons: pm.reasons || [],
    lastActivityAt: pm.lastActivityAt || '',
    remainingMin: pm.remainingMin,
  }) + '\\n');
})().catch((e) => {
  process.stdout.write(${JSON.stringify(MARK)} + JSON.stringify({ error: String((e && e.stack) || e) }) + '\\n');
});
`;
}

/** 子进程里 import session.mjs 后调 pmRotateIdleState(PROJECT)（默认 now/roles）。 */
function probe() {
  const r = spawnSync(process.execPath, ['-e', childScript()], {
    encoding: 'utf8', env: childEnv(), timeout: 120000, cwd: SB, maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = String(r.stdout || '');
  const stderr = String(r.stderr || '');
  const line = stdout.split(/\r?\n/).find((l) => l.startsWith(MARK)) || '';
  let data = null;
  if (line) { try { data = JSON.parse(line.slice(MARK.length)); } catch { data = null; } }
  return { code: r.status == null ? 1 : r.status, data, stdout, stderr, child: line || stdout.slice(0, 200) };
}

function detailOf(p) {
  return { code: p.code, data: p.data, stderr: p.stderr.slice(-400) };
}

/** 沙盘最小结构：团队.json 用真实骨架（loadTeam 要 version+members），只改 activeProject。 */
function seedTeam() {
  let team = null;
  try { team = JSON.parse(fs.readFileSync(REAL_TEAM, 'utf8').replace(/^\uFEFF/, '')); } catch { team = null; }
  if (!team || !team.version || !Array.isArray(team.members)) {
    team = { version: 1, name: '6c35 沙盘', phase: 'team', createdAt: new Date().toISOString(), members: [], config: {} };
  }
  team.activeProject = PROJECT;
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
}

let seq = 0;
function putMail(from, minutesAgo, subject, opts = {}) {
  const to = String(opts.to || 'pm');
  const boxOwner = String(opts.boxOwner || to);
  const box = String(opts.box || 'new');
  const dir = path.join(TEAM, '状态', '邮箱', boxOwner, box);
  fs.mkdirSync(dir, { recursive: true });
  seq += 1;
  const ts = new Date(Date.now() - minutesAgo * MIN).toISOString();
  const file = path.join(dir, `${ts.replace(/[:.]/g, '-')}-M-6c35-${seq}.json`);
  fs.writeFileSync(file, JSON.stringify({ ts, at: ts, from, to, type: 'notice', subject, body: subject, project: PROJECT }, null, 2) + '\n', 'utf8');
  return { file, ts };
}

function clearMail() {
  fs.rmSync(path.join(TEAM, '状态', '邮箱'), { recursive: true, force: true });
}

function putWorkingTask() {
  fs.mkdirSync(TASK_DIR, { recursive: true });
  const task = {
    id: 'T-6c35-working', type: 'task', title: '夹具：pm 名下 working 任务', detail: '仅用于触发 tasks 硬判据',
    owner: 'pm', status: 'working', priority: 'P2', createdAt: new Date().toISOString(), claimedAt: new Date().toISOString(),
  };
  const file = path.join(TASK_DIR, 'T-6c35-working.json');
  fs.writeFileSync(file, JSON.stringify(task, null, 2) + '\n', 'utf8');
  return file;
}

function main() {
  try {
    seedTeam();

    /* ── A1：系统通知不算活跃 ─────────────────────────────── */
    clearMail();
    const sys = putMail('system', 2, '路由泵 wake 摘要（系统自动通知）');
    const p1 = probe();
    check('A1', '只有 from=system、2 分钟前的系统通知 → pm idle === true（系统通知不算活跃）',
      Boolean(p1.data) && !p1.data.error && p1.data.idle === true,
      { ...detailOf(p1), mail: sys.file });

    /* ── A2：收到的角色消息不算活跃（B-f25d 新口径） ────────── */
    const received = putMail('product', 2, '产品：接任包已更新，请确认');
    const p2 = probe();
    check('A2', 'pm 收到 from=product、2 分钟前的消息（自己没发）→ pm idle === true（收到的不算活跃）',
      Boolean(p2.data) && !p2.data.error && p2.data.idle === true,
      { ...detailOf(p2), mail: received.file });

    /* ── A3：本人发出的消息算活跃（落对方邮箱也要能扫到） ───── */
    clearMail();
    const sent = putMail('pm', 1, 'pm：给产品的派单回执', { to: 'product', boxOwner: 'product' });
    const p3 = probe();
    const reasons3 = (p3.data && Array.isArray(p3.data.reasons)) ? p3.data.reasons.join(' | ') : '';
    check('A3', 'pm 1 分钟前给 product 发过消息（落在 product 邮箱）→ pm idle === false 且 reason 含「本人发出过消息」',
      Boolean(p3.data) && !p3.data.error && p3.data.idle === false && /本人发出过消息/.test(reasons3),
      { ...detailOf(p3), mail: sent.file, reasons: reasons3 });

    /* ── A4：本人旧消息超出窗口 + 新收到的角色/系统消息 → 仍空闲 ── */
    clearMail();
    const oldSent = putMail('pm', 30, 'pm：30 分钟前发出的旧消息', { to: 'product', boxOwner: 'product' });
    putMail('product', 2, '产品：2 分钟前的回复（pm 收到）');
    putMail('system', 2, '名册变更广播（系统自动通知）');
    const p4 = probe();
    check('A4', '30 分钟前本人发出 + 新收到的角色/系统消息 → pm idle === true（窗口与来源两重过滤）',
      Boolean(p4.data) && !p4.data.error && p4.data.idle === true,
      { ...detailOf(p4), mail: oldSent.file });

    /* ── A5：tasks 硬判据未被削弱 ──────────────────────────── */
    clearMail();
    const taskFile = putWorkingTask();
    const p5 = probe();
    const reasons5 = (p5.data && Array.isArray(p5.data.reasons)) ? p5.data.reasons.join(' | ') : '';
    check('A5', '给 pm 派 status=working 任务 → pm idle === false（tasks 硬判据未被削弱）',
      Boolean(p5.data) && !p5.data.error && p5.data.idle === false && /working 任务/.test(reasons5),
      { ...detailOf(p5), task: taskFile, reasons: reasons5 });
  } catch (e) {
    check('E0', '夹具未抛异常', false, { error: String((e && e.stack) || e) });
  } finally {
    fs.rmSync(SB, { recursive: true, force: true });
  }

  const passed = ROWS.filter((r) => r.ok === true).length;
  console.log(`\n${passed}/${ROWS.length} PASS`);
  if (passed < ROWS.length) process.exitCode = 1;
}

main();
