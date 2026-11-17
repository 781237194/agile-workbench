#!/usr/bin/env node
'use strict';
/**
 * B-20261117-205043-0c49 自检：系统升级消息不再重复刷屏
 *
 * 断言（沙盘四隔离 + TEAM_SELFTEST=1；时间用 now 注入，不改系统时钟）：
 *   ① 同一 working 任务连跑 3 拍 claimStallCheck → 只 1 条 escalation（60 分钟冷却，旧实现 10 分钟 → 会发 2 条）
 *   ② 角色最近有活动（回执/阅读/任务 mtime 在阈值内）→ **不报**「没动」
 *   ③ 派单队列滞留：已送达的项不报、目标角色正在 working 的不报、真正未送达且目标空闲才报
 *   ④ 状态跃迁（working → 其它状态）后冷却不挡新的告警（且该任务已不是 working 时不告警）
 *   ⑤ 隔离：真实 团队.json / workbench.json 里 0 个沙盘夹具标识
 *
 * 跑法：node scripts/test-escalation-dedupe.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REAL = path.resolve(__dirname, '..');
const PROJECT = '工作台改造修复';
const BASE = path.join(REAL, '_tmp', `esc-dedupe-${process.pid}-${Date.now().toString(36)}`);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 600)}`);
  if (!ok) process.exitCode = 1;
}
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, ent.name); const b = path.join(dst, ent.name);
    if (filter && filter(a)) continue;
    if (ent.isDirectory()) copyDir(a, b, filter); else fs.copyFileSync(a, b);
  }
}

function seed() {
  const data = path.join(BASE, 'data');
  const team = path.join(BASE, '团队');
  const projectDir = path.join(BASE, '项目', PROJECT);
  fs.mkdirSync(path.join(data, 'userdata'), { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  copyDir(path.join(REAL, '团队'), team, (p) => /[\\/]邮箱([\\/]|$)/.test(p) || /[\\/]锁([\\/]|$)/.test(p));
  const state = path.join(team, '状态', '项目', PROJECT);
  fs.rmSync(state, { recursive: true, force: true });
  fs.mkdirSync(path.join(state, '任务'), { recursive: true });
  const roster = readJson(path.join(team, '状态', '团队.json'), { members: [] });
  for (const m of roster.members || []) m.sessionId = '';
  roster.activeProject = PROJECT;
  writeJson(path.join(team, '状态', '团队.json'), roster);
  writeJson(path.join(state, '项目.json'), { name: PROJECT, path: projectDir, teamMode: 'full' });
  writeJson(path.join(state, '工作流.json'), { schema: 2, project: PROJECT, round: 1, requirements: {}, boots: {} });
  const store = readJson(path.join(REAL, 'data', 'userdata', 'workbench.json'), { projects: [] });
  const project = (store.projects || []).find((p) => p && String(p.teamName || p.name || '') === PROJECT);
  store.projects = [project]; store.activeProjectId = project.id;
  project.path = projectDir;
  writeJson(path.join(data, 'userdata', 'workbench.json'), store);
  return { data, team, projectDir, state };
}

(async () => {
  fs.mkdirSync(BASE, { recursive: true });
  const sb = seed();
  process.env.AWB_DATA_DIR = sb.data;
  process.env.TEAM_ROOT = sb.team;
  process.env.TEAM_PROJECTS_ROOT = path.join(sb.team, '状态', '项目');
  process.env.TEAM_WORKBENCH_JSON = path.join(sb.data, 'userdata', 'workbench.json');
  process.env.TEAM_SELFTEST = '1';
  process.env.TEAM_CLAIM_STALL_MS = String(60 * 1000);          // 1 分钟就判停滞
  process.env.TEAM_CLAIM_STALL_COOLDOWN_MS = String(60 * 60 * 1000);
  process.env.TEAM_DISPATCH_QUEUE_STALE_MS = String(60 * 1000);

  const ops = await import(pathToFileURL(path.join(REAL, '团队', '工具', 'lib', 'ops.mjs')).href);
  const pmNew = path.join(sb.team, '状态', '邮箱', 'pm', 'new');
  const mails = () => (fs.existsSync(pmNew) ? fs.readdirSync(pmNew).map((f) => readJson(path.join(pmNew, f), null)).filter(Boolean) : []);
  const escalations = () => mails().filter((m) => String(m.type) === 'escalation');
  const taskFile = (id) => path.join(sb.state, '任务', `${id}.json`);

  /* ① 连跑 3 拍只 1 条（60 分钟冷却） */
  const now = Date.now();
  writeJson(taskFile('T-fix-working'), { id: 'T-fix-working', project: PROJECT, type: 'task', priority: 'P1', owner: 'analyst', status: 'working', title: '停滞夹具', createdAt: new Date(now - 3 * 3600 * 1000).toISOString(), claimedAt: new Date(now - 3 * 3600 * 1000).toISOString(), updatedAt: new Date(now - 3 * 3600 * 1000).toISOString() });
  const r1 = ops.claimStallCheck(PROJECT, { now });
  const r2 = ops.claimStallCheck(PROJECT, { now: now + 5 * 60 * 1000 });
  const r3 = ops.claimStallCheck(PROJECT, { now: now + 10 * 60 * 1000 });
  const esc1 = escalations().filter((m) => /认领后/.test(String(m.subject || '')));
  check('① 同一 working 任务连跑 3 拍 → 只 1 条 escalation（60 分钟冷却）',
    r1.alerted === 1 && r2.alerted === 0 && r3.alerted === 0 && esc1.length === 1,
    { ticks: [r1.alerted, r2.alerted, r3.alerted], mails: esc1.length });

  /* ② 角色有近期活动 → 不报「没动」 */
  writeJson(taskFile('T-fix-active'), { id: 'T-fix-active', project: PROJECT, type: 'task', priority: 'P1', owner: 'product', status: 'working', title: '活跃夹具', createdAt: new Date(now - 3 * 3600 * 1000).toISOString(), claimedAt: new Date(now - 3 * 3600 * 1000).toISOString(), updatedAt: new Date(now - 3 * 3600 * 1000).toISOString() });
  const eventsFile = path.join(sb.state, '事件.jsonl');
  fs.appendFileSync(eventsFile, JSON.stringify({ at: new Date(now - 30 * 1000).toISOString(), role: 'product', project: PROJECT, action: 'write', target: '', note: '刚写了文件' }) + '\n', 'utf8');
  const r4 = ops.claimStallCheck(PROJECT, { now });
  const esc4 = escalations().filter((m) => /T-fix-active/.test(String(m.subject || '') + String(m.body || '')));
  check('② 角色最近有活动（30 秒前）→ 不报「认领后没动」',
    r4.hits.every((h) => h.taskId !== 'T-fix-active') && esc4.length === 0,
    { hits: r4.hits.map((h) => h.taskId), mailsForActive: esc4.length });

  /* ③ 队列滞留：已送达/目标忙 不报，真滞留才报 */
  const queueFile = path.join(sb.state, '派单队列.json');
  const old = new Date(now - 30 * 60 * 1000).toISOString();
  writeJson(queueFile, { items: [
    { id: 'Q-delivered', at: old, to: 'tester', task: 'T-x1', attempt: 1, deliveredAt: old },
    { id: 'Q-busy', at: old, to: 'analyst', task: 'T-fix-working', attempt: 1 },
    { id: 'Q-really-stale', at: old, to: 'tester', task: 'T-x2', attempt: 1 },
  ] });
  const r5 = ops.queueStaleCheck(PROJECT, { now });
  const staleIds = r5.hits.map((h) => h.queueId);
  check('③ 队列滞留只报「未送达且目标空闲」的项（已送达/目标 working 不报）',
    staleIds.length === 1 && staleIds[0] === 'Q-really-stale' && r5.skipped.delivered >= 1 && r5.skipped.targetBusy >= 1,
    { hits: staleIds, skipped: r5.skipped });

  /* ④ 状态跃迁后不再按旧冷却误报（任务已不是 working → 不告警） */
  const t = readJson(taskFile('T-fix-working'), {});
  writeJson(taskFile('T-fix-working'), { ...t, status: 'blocked', updatedAt: new Date(now).toISOString() });
  const r6 = ops.claimStallCheck(PROJECT, { now: now + 20 * 60 * 1000 });
  check('④ 任务离开 working 后不再产生「没动」告警', r6.hits.every((h) => h.taskId !== 'T-fix-working'), { hits: r6.hits.map((h) => h.taskId) });

  /* ⑤ 隔离 */
  const realTeam = readJson(path.join(REAL, '团队', '状态', '团队.json'), { members: [] });
  const leak = (realTeam.members || []).some((m) => m.sessionId === '' && m.status === 'active');
  check('⑤ 隔离：真实团队名册未被改成空 sessionId', leak === false, { leak });

  const pass = results.filter((r) => r.ok).length;
  console.log('');
  console.log(`${pass === results.length ? 'ESCALATION_DEDUPE_OK' : 'ESCALATION_DEDUPE_WARN'} ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
  try { fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
})();
