#!/usr/bin/env node
'use strict';
/**
 * test-6c35-pm-rotate-idle.cjs —— P1 B-20261120-110351-6c35 夹具（PM 换人静默门排除系统自动通知）
 *
 * 缺陷：`session.mjs → pmRotateIdleState()` 旧口径把「收到的系统通知」也算成 PM 活跃——
 *       路由泵 wake 摘要 / 名册变更广播 / 认领停滞提醒每条都是 from=system，投一条就把
 *       15 分钟倒计时重置 → 换完 5 个角色后产品给 PM 换人反复被 WAIT_BOTH_IDLE 拒。
 * 修复：邮箱扫描跳过 `from === 'system'`；running 会话 / working 任务 / 在途派单锁三条硬判据不变。
 *
 * 断言（4 条）：
 *  A1 沙盘 pm 邮箱只有 from=system、2 分钟前的通知 → pm idle === true（系统通知不算活跃）
 *  A2 再放一条 from=product、2 分钟前的消息 → pm idle === false（真往来算活跃）
 *  A3 只留 30 分钟前的 from=product 旧消息 + 新系统通知 → pm idle === true
 *  A4 给 pm 派一个 status=working 的任务 → pm idle === false（tasks 硬判据未被削弱）
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
function putMail(from, minutesAgo, subject) {
  fs.mkdirSync(MAIL_NEW, { recursive: true });
  seq += 1;
  const ts = new Date(Date.now() - minutesAgo * MIN).toISOString();
  const file = path.join(MAIL_NEW, `${ts.replace(/[:.]/g, '-')}-M-6c35-${seq}.json`);
  fs.writeFileSync(file, JSON.stringify({ ts, at: ts, from, to: 'pm', type: 'notice', subject, body: subject, project: PROJECT }, null, 2) + '\n', 'utf8');
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

    /* ── A2：真人/角色往来照旧算活跃 ───────────────────────── */
    const real = putMail('product', 2, '产品：接任包已更新，请确认');
    const p2 = probe();
    check('A2', '再放 from=product、2 分钟前的消息 → pm idle === false（真往来算活跃）',
      Boolean(p2.data) && !p2.data.error && p2.data.idle === false,
      { ...detailOf(p2), mail: real.file });

    /* ── A3：旧消息超出窗口 + 新系统通知 → 仍空闲 ──────────── */
    clearMail();
    const oldMsg = putMail('product', 30, '产品：30 分钟前的旧往来');
    putMail('system', 2, '名册变更广播（系统自动通知）');
    const p3 = probe();
    check('A3', '只留 30 分钟前 from=product 旧消息 + 新系统通知 → pm idle === true',
      Boolean(p3.data) && !p3.data.error && p3.data.idle === true,
      { ...detailOf(p3), mail: oldMsg.file });

    /* ── A4：tasks 硬判据未被削弱 ──────────────────────────── */
    clearMail();
    const taskFile = putWorkingTask();
    const p4 = probe();
    const reasons = (p4.data && Array.isArray(p4.data.reasons)) ? p4.data.reasons.join(' | ') : '';
    check('A4', '给 pm 派 status=working 任务 → pm idle === false（tasks 硬判据未被削弱）',
      Boolean(p4.data) && !p4.data.error && p4.data.idle === false && /working 任务/.test(reasons),
      { ...detailOf(p4), task: taskFile, reasons });
  } catch (e) {
    check('E0', '夹具未抛异常', false, { error: String((e && e.stack) || e) });
  } finally {
    fs.rmSync(SB, { recursive: true, force: true });
  }

  const passed = ROWS.filter((r) => r.ok === true).length;
  console.log(`\n${passed}/4 PASS`);
  if (passed < 4) process.exitCode = 1;
}

main();
