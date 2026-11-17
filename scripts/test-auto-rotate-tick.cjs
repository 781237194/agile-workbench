#!/usr/bin/env node
'use strict';
/**
 * R-fa0e 收尾（T-20261117-195120-3a12）自检：调用者接线的两件事
 *   ① 团队配置 autoRotate={enabled,intervalMs,rotateRounds} 门禁（0/false=关；未到间隔不重入）；
 *   ② 次日 08:00–08:30 **严格按昨夜入队记账**执行（只换昨夜 NIGHT_SILENT/enqueue 的角色，
 *      force→轮次降序→触发早者，**每拍只换 1 个**；昨夜无入队 → 窗口内一个都不换）；
 *   ③ 面板 [data-ar-*] 取数口径（纯函数：state/reason/auditTail/error + [data-ar-summary]）。
 *
 * 沙箱五隔离：AWB_DATA_DIR + TEAM_ROOT + TEAM_PROJECTS_ROOT + TEAM_WORKBENCH_JSON + TEAM_SELFTEST=1；
 * 时间一律 AWB_NOW 注入（不改系统时钟）。跑法：node scripts/test-auto-rotate-tick.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const REAL = path.resolve(__dirname, '..');
const PROJECT = '工作台改造修复';
const ROLE_DIRS = { pm: '项目经理', product: '产品', analyst: '需求分析师', programmer1: '程序员A', programmer2: '程序员B', tester: '测试人员' };
const ROLES = Object.keys(ROLE_DIRS);
const HOUR = 3600 * 1000;
const BASE = path.join(REAL, '_tmp', `fa0e-tick-${process.pid}-${Date.now().toString(36)}`);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 600)}`);
  if (!ok) process.exitCode = 1;
}
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
function fmtAWB(ms) { return new Date(Number(ms) + 8 * HOUR).toISOString().slice(0, 19) + '+08:00'; }
function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, ent.name); const b = path.join(dst, ent.name);
    if (filter && filter(a)) continue;
    if (ent.isDirectory()) copyDir(a, b, filter); else fs.copyFileSync(a, b);
  }
}

function makeSandbox(name, { usage, rounds, config } = {}) {
  const dir = path.join(BASE, name);
  const data = path.join(dir, 'data');
  const team = path.join(dir, '团队');
  const projectDir = path.join(dir, '项目', PROJECT);
  const state = path.join(team, '状态', '项目', PROJECT);
  fs.mkdirSync(path.join(data, 'userdata'), { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  copyDir(path.join(REAL, '团队'), team, (p) => /[\\/]邮箱([\\/]|$)/.test(p) || /[\\/]锁([\\/]|$)/.test(p));
  fs.rmSync(state, { recursive: true, force: true });
  fs.mkdirSync(path.join(state, '任务'), { recursive: true });
  // 名册：假 sessionId
  const roster = readJson(path.join(team, '状态', '团队.json'), { members: [] });
  for (const m of roster.members || []) m.sessionId = `sess-old-${m.role}`;
  roster.activeProject = PROJECT;
  if (config) roster.config = { ...(roster.config || {}), autoRotate: config };
  writeJson(path.join(team, '状态', '团队.json'), roster);
  writeJson(path.join(state, '项目.json'), { name: PROJECT, path: projectDir, teamMode: 'full' });
  writeJson(path.join(state, '工作流.json'), { schema: 2, project: PROJECT, round: 1, requirements: {}, boots: {} });
  if (usage) writeJson(path.join(state, '会话用量.json'), usage);
  if (rounds) writeJson(path.join(state, '会话轮次.json'), rounds);
  // 壳 store 指沙盘项目
  const store = readJson(path.join(REAL, 'data', 'userdata', 'workbench.json'), { projects: [] });
  const project = (store.projects || []).find((p) => p && String(p.teamName || p.name || '') === PROJECT);
  store.projects = [project]; store.activeProjectId = project.id;
  project.path = projectDir; project.workspacePath = projectDir;
  project.sessions = Object.fromEntries(ROLES.map((r) => [r, `sess-old-${r}`]));
  writeJson(path.join(data, 'userdata', 'workbench.json'), store);
  for (const r of ROLES) fs.mkdirSync(path.join(projectDir, ROLE_DIRS[r], '产出'), { recursive: true });
  return {
    dir, data, team, projectDir, state,
    get audit() { return path.join(state, '自动换人.jsonl'); },
    get teamFile() { return path.join(team, '状态', '团队.json'); },
    env(nowMs, extra = {}) {
      return {
        ...process.env, AWB_DATA_DIR: data, TEAM_ROOT: team,
        TEAM_PROJECTS_ROOT: path.join(team, '状态', '项目'),
        TEAM_WORKBENCH_JSON: path.join(data, 'userdata', 'workbench.json'),
        TEAM_SELFTEST: '1', AWB_NOW: fmtAWB(nowMs), ...extra,
      };
    },
    rows() {
      if (!fs.existsSync(this.audit)) return [];
      return fs.readFileSync(this.audit, 'utf8').split(/\r?\n/).filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    },
    sessionOf(role) { return String(((readJson(this.teamFile, { members: [] }).members || []).find((m) => m.role === role) || {}).sessionId || ''); },
  };
}

/** 调一拍（真模块，A 案）。 */
function cycle(sb, nowMs, entry = '团队/工具/lib/auto-rotate.mjs') {
  const boot = [
    'const { pathToFileURL } = require("node:url");',
    '(async () => {',
    `  const mod = await import(pathToFileURL(${JSON.stringify(path.resolve(REAL, entry))}).href);`,
    '  const fn = mod.runAutoRotateCycle;',
    '  const r = await fn(process.env.__AR_PROJECT, { now: Number(process.env.__AR_NOW), source: "self-check" });',
    '  console.log("@@AR@@" + JSON.stringify(r || null));',
    '})().catch((e) => console.log("@@AR@@" + JSON.stringify({ ok: false, error: String((e && e.message) || e) })));',
  ].join('\n');
  const r = spawnSync(process.execPath, ['-e', boot], { cwd: REAL, encoding: 'utf8', timeout: 60000, env: sb.env(nowMs, { __AR_PROJECT: PROJECT, __AR_NOW: String(nowMs) }) });
  const line = String(r.stdout || '').split(/\r?\n/).find((x) => x.includes('@@AR@@'));
  if (!line) return { ok: false, error: String(r.stderr || r.stdout || '').slice(0, 300) };
  try { return JSON.parse(line.split('@@AR@@')[1]); } catch (e) { return { ok: false, error: String(e.message) }; }
}

/** 调一拍（beat：配置门禁 + 间隔）。 */
function beat(sb, nowMs, stateObj) {
  const file = path.join(sb.dir, 'beat-state.json');
  writeJson(file, stateObj);
  const boot = [
    'const { pathToFileURL } = require("node:url");',
    'const fs = require("node:fs");',
    '(async () => {',
    `  const mod = await import(pathToFileURL(${JSON.stringify(path.resolve(REAL, '团队/工具/lib/auto-rotate.mjs'))}).href);`,
    `  const box = JSON.parse(fs.readFileSync(${JSON.stringify(file)}, "utf8") || "{}");`,
    '  const r = mod.runAutoRotateBeat(process.env.__AR_PROJECT, { now: Number(process.env.__AR_NOW), state: box, source: "self-check" });',
    `  fs.writeFileSync(${JSON.stringify(file)}, JSON.stringify(box));`,
    '  console.log("@@AR@@" + JSON.stringify({ ok: Boolean(r && r.ok), skipped: r && r.skipped, mode: r && r.result && r.result.mode, rotated: r && r.result && r.result.rotated }));',
    '})().catch((e) => console.log("@@AR@@" + JSON.stringify({ ok: false, error: String((e && e.message) || e) })));',
  ].join('\n');
  const r = spawnSync(process.execPath, ['-e', boot], { cwd: REAL, encoding: 'utf8', timeout: 60000, env: sb.env(nowMs, { __AR_PROJECT: PROJECT, __AR_NOW: String(nowMs) }) });
  const line = String(r.stdout || '').split(/\r?\n/).find((x) => x.includes('@@AR@@'));
  if (!line) return { ok: false, error: String(r.stderr || r.stdout || '').slice(0, 300) };
  try { return JSON.parse(line.split('@@AR@@')[1]); } catch (e) { return { ok: false, error: String(e.message) }; }
}

function daytimeBase() { const d = new Date(); d.setHours(15, 0, 0, 0); return d.getTime(); }
function atNight(hour, minute) { const d = new Date(); d.setHours(hour, minute, 0, 0); return d.getTime(); }
function nextMorning(hour, minute) { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(hour, minute, 0, 0); return d.getTime(); }

(async () => {
  fs.mkdirSync(BASE, { recursive: true });
  const usage = (now) => ({ analyst: { sessionId: 'sess-old-analyst', tokens: 520000, at: new Date(now).toISOString(), source: 'fixture' } });
  const ROUNDS_LIMIT = Number(process.env.__AR_ROUNDS_LIMIT || process.env.TEAM_AUTO_ROTATE_ROUNDS || 20); // a4c7 默认 8 时也可跑：夹具轮数=limit+10
  const rounds = { product: { roundsSinceArchive: ROUNDS_LIMIT + 10 } };

  /* ① 配置门禁：enabled=false → 整拍跳过，审计零新增 */
  {
    const night = atNight(23, 30);
    const sb = makeSandbox('c1-disabled', { usage: usage(night), rounds, config: { enabled: false } });
    const before = sb.rows().length;
    const r = beat(sb, night, {});
    check('① autoRotate.enabled=false → 调用者整拍跳过（skipped=disabled），审计零新增',
      r.ok === true && r.skipped === 'disabled' && sb.rows().length === before, { r, rows: sb.rows().length, before });
  }

  /* ② 间隔门禁：intervalMs 未到 → skipped=interval；到了才真跑 */
  {
    const night = atNight(23, 40);
    const sb = makeSandbox('c2-interval', { usage: usage(night), rounds, config: { enabled: true, intervalMs: 300000 } });
    const first = beat(sb, night, { lastAt: 0, busy: false });
    const second = beat(sb, night + 60 * 1000, { lastAt: night, busy: false });
    const third = beat(sb, night + 6 * 60 * 1000, { lastAt: night, busy: false });
    check('② 配置 intervalMs 门禁：5 分钟内再拍 skipped=interval；超过间隔才执行',
      first.ok === true && !first.skipped && second.ok === true && second.skipped === 'interval' && third.ok === true && !third.skipped,
      { first, second, third });
  }

  /* ③ 夜间只入队（cycle/enqueue/skipped 三类审计都在，无 rotate） */
  {
    const night = atNight(23, 50);
    const sb = makeSandbox('c3-night', { usage: usage(night), rounds });
    const r1 = cycle(sb, night);
    const r2 = cycle(sb, night + 5 * 60 * 1000);
    const rows = sb.rows();
    // T-f35b①：cycle/enqueue 是调度层事件（event 字段），不再占用换人 stage 枚举；断言两者都兼容。
    const hasCycle = rows.some((x) => x.event === 'cycle' || x.stage === 'cycle');
    const nightRows = rows.filter((x) => x.stage === 'skipped' && x.code === 'NIGHT_SILENT');
    const enqueueRows = rows.filter((x) => x.event === 'enqueue' || x.stage === 'enqueue');
    const rotateRows = rows.filter((x) => x.stage === 'rotate');
    const perRole = {};
    for (const x of nightRows) perRole[x.role] = (perRole[x.role] || 0) + 1;
    const deferred = nightRows.every((x) => String((x.evidence || {}).deferredUntil || '') && /夜间静默/.test(String(x.reason || '')));
    check('③ 夜间两拍：只入队（cycle+enqueue+skipped/NIGHT_SILENT），无 rotate、每角色仅 1 行、deferredUntil 有值',
      r1.ok === true && r2.ok === true && hasCycle && enqueueRows.length >= 2 && rotateRows.length === 0
      && nightRows.length === 2 && Object.values(perRole).every((n) => n === 1) && deferred,
      { ok: [r1.ok, r2.ok], hasCycle, enqueue: enqueueRows.length, nightRows: nightRows.length, perRole, rotateRows: rotateRows.length, deferred });
  }

  /* ④ 次日严格队列：只换昨夜入队角色，force 优先，每拍只换 1 个 */
  {
    const night = atNight(23, 55);
    const sb = makeSandbox('c4-nextday-queue', { usage: usage(night), rounds });
    cycle(sb, night);                                   // 夜间入队：analyst(force) + product(rounds)
    const morning = nextMorning(8, 5);
    const r1 = cycle(sb, morning);
    const afterFirst = sb.rows().filter((x) => x.stage === 'rotate');
    const r2 = cycle(sb, morning + 5 * 60 * 1000);
    const afterSecond = sb.rows().filter((x) => x.stage === 'rotate');
    const r3 = cycle(sb, morning + 10 * 60 * 1000);
    const afterThird = sb.rows().filter((x) => x.stage === 'rotate');
    check('④ 次日严格队列：第 1 拍只换 force（analyst）1 个、第 2 拍换 product、第 3 拍不再换',
      r1.ok === true && afterFirst.length === 1 && afterFirst[0].role === 'analyst'
      && r2.ok === true && afterSecond.length === 2 && afterSecond[1].role === 'product'
      && r3.ok === true && afterThird.length === 2,
      { r1: r1.rotated, first: afterFirst.map((x) => x.role), r2: r2.rotated, second: afterSecond.map((x) => x.role), third: afterThird.map((x) => x.role) });
  }

  /* ⑤ 昨夜无入队 → 次日窗口一个都不换（严格口径） */
  {
    const morning = nextMorning(8, 6);
    const sb = makeSandbox('c5-empty-queue', { usage: usage(morning), rounds });
    const r1 = cycle(sb, morning);
    const r2 = cycle(sb, morning + 5 * 60 * 1000);
    const rotateRows = sb.rows().filter((x) => x.stage === 'rotate');
    check('⑤ 昨夜无入队记账 → 08:00–08:30 窗口不执行任何命中（0 个 rotate）',
      r1.ok === true && r2.ok === true && rotateRows.length === 0 && /无入队/.test(String(r1.note || '') + String(r2.note || '')),
      { r1note: r1.note, r2note: r2.note, rotateRows: rotateRows.length });
  }

  /* ⑥ 面板 [data-ar-*] 取数（纯函数，不启窗口） */
  {
    const S = require(path.join(REAL, 'src', 'session-queue.js'));
    const now = Date.parse('2026-11-17T20:10:00.000Z');
    const model = S.buildPanelModel({
      roles: ['pm', 'analyst', 'product'], roleNames: {}, now,
      snapshot: { at: new Date(now).toISOString(), roles: [] }, wakeRows: [],
      autoRotateRows: [
        { at: new Date(now - 3 * HOUR).toISOString(), stage: 'enqueue', code: 'NIGHT_QUEUED', role: 'analyst', evidence: { level: 'force' } },
        { at: new Date(now - 2 * HOUR).toISOString(), stage: 'trigger', code: 'HANDOVER_REQUESTED', role: 'product' },
        { at: new Date(now - 90 * 60 * 1000).toISOString(), stage: 'skipped', code: 'HANDOVER_TIMEOUT', role: 'product', note: '超时' },
        { at: new Date(now - 60 * 60 * 1000).toISOString(), stage: 'rotate', result: 'ok', role: 'analyst', note: '已换人：a → b' },
      ],
    });
    const arOf = (role) => (model.rows.find((r) => r.role === role) || {}).autoRotate || {};
    check('⑥ 面板字段：analyst=rotating + 审计尾、product=failed/HANDOVER_TIMEOUT、pm=idle 不伪造',
      arOf('analyst').state === 'rotating' && /已换人/.test(arOf('analyst').reason) && /rotate/.test(arOf('analyst').auditTail)
      && arOf('product').state === 'failed' && arOf('product').error === 'HANDOVER_TIMEOUT'
      && arOf('pm').state === 'idle' && arOf('pm').auditTail === '', { analyst: arOf('analyst'), product: arOf('product'), pm: arOf('pm') });
    check('⑥b [data-ar-summary] 文案：今日自动换人 N 次 / 失败 M 次', /今日自动换人\s*1\s*次\s*\/\s*失败\s*1\s*次/.test(String(model.autoRotate.summary)), model.autoRotate);
  }

  /* ⑦ AC3 红线：角色有在办任务（working）→ 不换人、不发交接请求，只留 SKIPPED_BY_WORKING_TASK */
  {
    const now = daytimeBase();
    const sb = makeSandbox('c7-working', { usage: usage(now), rounds });
    writeJson(path.join(sb.state, '任务', 'T-fixture-working.json'), { id: 'T-fixture-working', project: PROJECT, type: 'task', priority: 'P1', owner: 'analyst', status: 'working', title: '在办夹具', createdAt: new Date(now).toISOString() });
    const r1 = cycle(sb, now);
    const r2 = cycle(sb, now + 5 * 60 * 1000);
    const rows = sb.rows();
    const skipped = rows.filter((x) => String(x.code) === 'SKIPPED_BY_WORKING_TASK' && String(x.role) === 'analyst');
    const triggerRows = rows.filter((x) => String(x.stage) === 'trigger' && String(x.role) === 'analyst');
    const rotateRows = rows.filter((x) => String(x.stage) === 'rotate');
    const sessionSame = sb.sessionOf('analyst') === 'sess-old-analyst';
    check('⑦ AC3 红线：有在办任务 → 不换人/不发交接请求，只记 SKIPPED_BY_WORKING_TASK',
      r1.ok === true && r2.ok === true && skipped.length >= 1 && triggerRows.length === 0 && rotateRows.length === 0 && sessionSame
      && /在办任务/.test(String(skipped[0].note || '')),
      { r1ok: r1.ok, skipped: skipped.length, trigger: triggerRows.length, rotate: rotateRows.length, sessionSame, note: skipped[0] && skipped[0].note });
  }

  /* ⑧ T-f35b③：60 秒内重复请求 → 审计写 ALREADY_IN_FLIGHT（不阻断、不发第二条请求） */
  {
    const now = daytimeBase();
    const sb = makeSandbox('c8-already-in-flight', { usage: usage(now) });
    const r1 = cycle(sb, now);
    const r2 = cycle(sb, now + 5 * 1000);
    const rows = sb.rows();
    const inFlight = rows.filter((x) => String(x.code) === 'ALREADY_IN_FLIGHT');
    const triggers = rows.filter((x) => String(x.stage) === 'trigger');
    check('⑧ 60 秒内重复请求 → 记 ALREADY_IN_FLIGHT（只 1 条 trigger，不重复发）',
      r1.ok === true && r2.ok === true && inFlight.length === 1 && inFlight[0].role === 'analyst' && triggers.length === 1,
      { inFlight: inFlight.length, triggers: triggers.length, r2actions: r2.actions });
  }

  const pass = results.filter((r) => r.ok).length;
  console.log('');
  console.log(`${pass === results.length ? 'AUTO_ROTATE_TICK_OK' : 'AUTO_ROTATE_TICK_WARN'} ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
  try { fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
})();
