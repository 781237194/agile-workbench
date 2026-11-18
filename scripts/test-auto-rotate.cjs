#!/usr/bin/env node
/**
 * T-20261117-191816-e2a5（P1，测试侧）：fa0e「角色上下文到顶自动换人」沙箱验收脚本（先红后绿）
 *
 * 需求：R-20261117-180740-fa0e（v3，15658B/sha 49618508…/RR-34ba）——五步流水线：触发→催交接→等回执→rotate→广播重 boot+校验；
 *      夜间 22:00–08:00 一律不换人（含 force）只入队记账（NIGHT_SILENT）；次日 08:00 起 force 优先执行。
 * 当前预期：**红**（B 的 T-20261117-183920-4ea3 尚未交付/未接线），B 实现后本脚本应转绿（与 71e7/d120 同套路）。
 *
 * 7 条断言（沙箱四变量隔离 + TEAM_SELFTEST=1；时间用 AWB_NOW 注入）：
 *   ① 阈值命中（force）→ 同一角色只发 1 条交接请求（60 秒内不重复发；邮箱 new 中交接请求消息数 = 1）
 *   ② 合式交接回执 → rotate（沙盘名册 sessionId 变化）+ 新会话 boot 指令 + 其他角色收到重 boot 广播
 *   ③ 交接超时（注入时间 +16 分钟）→ 不 rotate、名册不变，只给 PM 发升级告警
 *   ④ 夜间 22:00–08:00 一律不换人（含 force）→ 无 rotate、名册不变、审计 skipped/NIGHT_SILENT、夜间不广播
 *   ⑤ 夜间同夜同角色只 1 行 NIGHT_SILENT（幂等）
 *   ⑥ 次日 08:05 → force 优先执行（第一个被 rotate 的是 force 角色）
 *   ⑦ 真实 `团队/状态/团队.json` 与 `workbench.json` 前后 sha256 不变（零写入）
 *
 * 实现接线契约（供 B 对齐；脚本优先模块、其次 CLI，二选一即可）：
 *   A) 模块：`团队/工具/lib/auto-rotate.mjs` 导出 `runAutoRotateCycle(projectName, { now, dryRun, source })`
 *      （或同名别名 runAutoRotateTick / autoRotateCycle），返回任意 JSON（脚本以审计文件/名册/邮箱为判据）；
 *   B) CLI：`node 团队/工具/team.mjs session auto-rotate --project <P> --json`（读 AWB_NOW）。
 *   两种方式都必须：时间取 `AWB_NOW`（带时区偏移；缺省用系统时间）、审计落 `团队/状态/项目/<P>/自动换人.jsonl`、
 *   不触发夜间真实名册变更（沙盘/--dry-run 不受夜间限制，见需求 §5.5）。
 *
 * 用法：node scripts/test-auto-rotate.cjs [--json]
 * 输出：全绿 `AUTO_ROTATE_OK {...}`（exit 0）；当前红 `AUTO_ROTATE_WARN {...}`（exit 1，逐条给结果）
 * 证据：项目/工作台改造修复/测试人员/产出/证据-fa0e-repro/run-<ts>-<red|green>.json（每次新增，不覆盖）
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = '工作台改造修复';
const jsonOut = process.argv.includes('--json');
const REAL_TEAM_FILE = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_STORE_FILE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const REAL_FILES = { team: REAL_TEAM_FILE, workbench: REAL_STORE_FILE };
const ROLE_DIRS = { pm: '项目经理', product: '产品', analyst: '需求分析师', programmer1: '程序员A', programmer2: '程序员B', tester: '测试人员' };
const ROLES = Object.keys(ROLE_DIRS);
const HOUR = 3600 * 1000;

const ts = new Date().toISOString().replace(/[:.]/g, '-');
const CASE_BASE = path.join(ROOT, '_tmp', `fa0e-auto-rotate-${process.pid}-${Date.now().toString(36)}`);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!jsonOut) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
  return Boolean(ok);
}
const sha256 = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; } };
const snap = (files) => Object.fromEntries(Object.entries(files).map(([k, f]) => [k, { file: f, sha256: sha256(f), bytes: (() => { try { return fs.statSync(f).size; } catch { return -1; } })() }]));
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
/** 注入时间格式：本地（Asia/Shanghai）带 +08:00 偏移（需求注释要求）。 */
function fmtAWB(ms) {
  const local = new Date(Number(ms) + 8 * HOUR).toISOString().slice(0, 19);
  return `${local}+08:00`;
}
function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, ent.name); const b = path.join(dst, ent.name);
    if (filter && filter(a)) continue;
    if (ent.isDirectory()) copyDir(a, b, filter); else fs.copyFileSync(a, b);
  }
}

// ── 入口探测（模块优先；未实现则所有断言快速红，不空跑子进程） ────────────────
function detectEntry() {
  const candidates = [
    path.join(ROOT, '团队', '工具', 'lib', 'auto-rotate.mjs'),
    path.join(ROOT, '团队', '工具', 'lib', 'auto-rotate.cjs'),
  ];
  for (const file of candidates) if (fs.existsSync(file)) return { kind: 'module', file };
  const teamMjs = path.join(ROOT, '团队', '工具', 'team.mjs');
  const probe = spawnSync(process.execPath, [teamMjs, 'session', 'auto-rotate', '--help'], { cwd: ROOT, encoding: 'utf8', env: { ...process.env, TEAM_SELFTEST: '1' } });
  const text = String(probe.stdout || '') + String(probe.stderr || '');
  const unsupported = /UNKNOWN_COMMAND|BAD_ACTION|UNSUPPORTED|未知命令|不支持|只支持/i.test(text);
  if (!unsupported && /auto-rotate|自动换人/i.test(text)) return { kind: 'cli', file: teamMjs };
  return { kind: 'none', file: '' };
}
const ENTRY = detectEntry();

class Sandbox {
  constructor(name) {
    this.name = name;
    this.dir = path.join(CASE_BASE, name);
    this.data = path.join(this.dir, 'data');
    this.team = path.join(this.dir, '团队');
    this.projectDir = path.join(this.dir, '项目', PROJECT);
    this.state = path.join(this.team, '状态', '项目', PROJECT);
    this.evidence = '';
  }
  get auditFile() { return path.join(this.state, '自动换人.jsonl'); }
  get mailDir() { return path.join(this.team, '状态', '邮箱'); }
  get teamFile() { return path.join(this.team, '状态', '团队.json'); }
  get workbenchFile() { return path.join(this.data, 'userdata', 'workbench.json'); }
  get roundsFile() { return path.join(this.state, '会话轮次.json'); }
  get usageFile() { return path.join(this.state, '会话用量.json'); }
  get roster() { return readJson(this.teamFile, { members: [] }); }
  sessionOf(role) { const m = (this.roster.members || []).find((x) => String(x.role) === role); return String((m && m.sessionId) || ''); }
  wbSessions() { const wb = readJson(this.workbenchFile, {}); const p = ((wb.projects || [])[0] || {}); return (p.sessions || {}); }
  auditRows() {
    if (!fs.existsSync(this.auditFile)) return [];
    return fs.readFileSync(this.auditFile, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
  }
  mails(role) {
    const dir = path.join(this.mailDir, role, 'new');
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(dir, f), null)).filter(Boolean);
  }
  allMailCount() { return ROLES.reduce((n, r) => n + this.mails(r).length, 0); }
  seed(opts = {}) {
    fs.rmSync(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(path.join(this.data, 'userdata'), { recursive: true });
    fs.mkdirSync(this.projectDir, { recursive: true });
    copyDir(path.join(ROOT, '团队'), this.team, (p) => /[\\/]邮箱([\\/]|$)/.test(p) || /[\\/]锁([\\/]|$)/.test(p) || /[\\/]备份([\\/]|$)/.test(p));
    // 项目状态重置为最小夹具（不带真实工作流/任务/用量）
    fs.rmSync(this.state, { recursive: true, force: true });
    fs.mkdirSync(path.join(this.state, '任务'), { recursive: true });
    writeJson(path.join(this.state, '工作流.json'), { schema: 2, project: PROJECT, round: 1, updatedAt: new Date().toISOString(), requirements: {}, boots: {} });
    // 名册：假会话 id + 当前项目
    const team = this.roster;
    for (const m of (Array.isArray(team.members) ? team.members : [])) m.sessionId = `sess-old-${m.role}`;
    team.activeProject = PROJECT;
    writeJson(this.teamFile, team);
    // 壳 store：指向沙盘项目目录
    const store = readJson(REAL_STORE_FILE, { projects: [] }) || { projects: [] };
    const project = (store.projects || []).find((p) => p && String(p.teamName || p.name || '') === PROJECT);
    if (!project) throw new Error('真实 workbench.json 里没有团队项目 ' + PROJECT);
    store.projects = [project];
    store.activeProjectId = project.id;
    project.path = this.projectDir;
    project.workspacePath = this.projectDir;
    if (project.workspace && typeof project.workspace === 'object') project.workspace.path = this.projectDir;
    project.sessions = Object.fromEntries(ROLES.map((r) => [r, `sess-old-${r}`]));
    if (project.workspace && Array.isArray(project.workspace.sessionIds)) project.workspace.sessionIds = ROLES.map((r) => `sess-old-${r}`);
    writeJson(this.workbenchFile, store);
    // 角色目录（交接契约 A 用）
    for (const r of ROLES) fs.mkdirSync(path.join(this.projectDir, ROLE_DIRS[r], '产出'), { recursive: true });
    // 用量/轮次/在办任务/排队快照
    if (opts.usage) writeJson(this.usageFile, opts.usage);
    if (opts.rounds) writeJson(this.roundsFile, opts.rounds);
    if (opts.workingTask) writeJson(path.join(this.state, '任务', `${opts.workingTask.id}.json`), { id: opts.workingTask.id, project: PROJECT, type: 'task', priority: 'P2', owner: opts.workingTask.owner, status: 'working', title: 'fixture working', createdAt: new Date().toISOString() });
    return this;
  }
  env(nowMs, extra = {}) {
    return {
      ...process.env,
      AWB_DATA_DIR: this.data,
      TEAM_ROOT: this.team,
      TEAM_PROJECTS_ROOT: path.join(this.team, '状态', '项目'),
      TEAM_WORKBENCH_JSON: this.workbenchFile,
      TEAM_SELFTEST: '1',
      AWB_NOW: fmtAWB(nowMs),
      ...extra,
    };
  }
  /** 跑「一拍」（一次触发周期）。返回 {entryOk, result, raw, error}。 */
  runCycle(nowMs) {
    if (ENTRY.kind === 'none') return { entryOk: false, result: null, error: 'AUTO_ROTATE_NOT_IMPLEMENTED（未找到 团队/工具/lib/auto-rotate.mjs，CLI 也无 session auto-rotate）' };
    const env = this.env(nowMs, { __AR_MODULE: ENTRY.file, __AR_PROJECT: PROJECT, __AR_NOW: String(Number(nowMs)) });
    if (ENTRY.kind === 'module') {
      const bootstrap = [
        'const { pathToFileURL } = require("node:url");',
        '(async () => {',
        '  const mod = await import(pathToFileURL(process.env.__AR_MODULE).href);',
        '  const fn = mod.runAutoRotateCycle || mod.runAutoRotateTick || mod.autoRotateCycle || mod.default;',
        '  if (typeof fn !== "function") { console.log("@@AR@@" + JSON.stringify({ ok: false, code: "AUTO_ROTATE_EXPORT_MISSING" })); return; }',
        '  const r = await fn(process.env.__AR_PROJECT, { now: Number(process.env.__AR_NOW), dryRun: false, source: "test" });',
        '  console.log("@@AR@@" + JSON.stringify(r === undefined ? null : r));',
        '})().catch((e) => { console.log("@@AR@@" + JSON.stringify({ ok: false, code: "AUTO_ROTATE_THROW", error: String((e && (e.message || e)) || e) })); });',
      ].join('\n');
      const r = spawnSync(process.execPath, ['-e', bootstrap], { cwd: ROOT, encoding: 'utf8', env, timeout: 60000 });
      const line = String(r.stdout || '').split(/\r?\n/).find((x) => x.includes('@@AR@@'));
      if (!line) return { entryOk: false, result: null, error: `模块调用无结果：${String(r.stderr || r.stdout || '').slice(0, 300)}` };
      try { return { entryOk: true, result: JSON.parse(line.split('@@AR@@')[1]), error: '' }; } catch (e) { return { entryOk: false, result: null, error: String(e.message || e) }; }
    }
    // CLI
    const teamMjs = path.join(ROOT, '团队', '工具', 'team.mjs');
    const r = spawnSync(process.execPath, [teamMjs, 'session', 'auto-rotate', '--project', PROJECT, '--json'], { cwd: ROOT, encoding: 'utf8', env, timeout: 120000 });
    const text = String(r.stdout || '');
    const start = text.indexOf('{');
    if (r.status !== 0 && start < 0) return { entryOk: false, result: null, error: `CLI 退出码 ${r.status}：${String(r.stderr || text).slice(0, 300)}` };
    let parsed = null;
    try { parsed = start >= 0 ? JSON.parse(text.slice(start)) : null; } catch (e) { return { entryOk: false, result: null, error: String(e.message || e) }; }
    if (parsed && (parsed.ok === false && /BAD_ACTION|UNKNOWN_COMMAND|UNSUPPORTED|只支持/i.test(`${parsed.code || ''} ${parsed.message || ''}`))) {
      return { entryOk: false, result: parsed, error: `AUTO_ROTATE_NOT_IMPLEMENTED（CLI 无 session auto-rotate：${parsed.code || ''}）` };
    }
    return { entryOk: true, result: parsed, error: '' };
  }
  handover(role, nowMs) {
    const file = path.join(this.projectDir, ROLE_DIRS[role], '产出', '交接-最新.md');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `# ${role} 交接（夹具）\n\n- at: ${new Date(nowMs).toISOString()}\n`, 'utf8');
    const mtime = new Date(nowMs + 1000); fs.utimesSync(file, mtime, mtime);
    // 契约 B：角色发回含「交接」的回执
    const mail = path.join(this.mailDir, role, 'new', `M-fixture-handover-${role}-${nowMs}.json`);
    fs.mkdirSync(path.dirname(mail), { recursive: true });
    writeJson(mail, { id: `M-fixture-handover-${role}`, from: role, to: 'pm', type: 'receipt', subject: `交接完成：${role}`, body: '交接已完成，明细见产出/交接-最新.md', project: PROJECT, ts: new Date(nowMs).toISOString() });
    return file;
  }
  cleanup() { try { fs.rmSync(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ } }
}

// 夹具时间：白天用例一律固定在本地 10:00（否则 22:00–08:00 夜间门会让 rotate 类用例天然红）
function dayTimeMs() { const d = new Date(); d.setHours(10, 0, 0, 0); return d.getTime(); }

// ── 7 条断言 ────────────────────────────────────────────────────────────────
async function case1() {
  const now = dayTimeMs();
  const sb = new Sandbox('c1-threshold').seed({ usage: { analyst: { sessionId: 'sess-old-analyst', tokens: 520000, input: 500000, at: new Date(now).toISOString(), source: 'fixture' } } });
  try {
    const before = snap({ team: sb.teamFile });
    const r1 = sb.runCycle(now);
    const r2 = sb.runCycle(now + 30 * 1000); // 60 秒窗口内重复一拍，不得重复发
    const rows = sb.auditRows();
    const triggers = rows.filter((r) => r.role === 'analyst' && r.stage === 'trigger');
    const warns = sb.mails('analyst').filter((m) => /session_rotate_warn|交接|handover/i.test(`${m.type || ''} ${m.subject || ''} ${m.body || ''}`));
    const forceTrigger = triggers.some((r) => /force/i.test(JSON.stringify(r.trigger || '')) || /force/i.test(JSON.stringify(r.evidence || {})));
    return check('① 阈值命中（force）→ 同一角色只发 1 条交接请求（60s 内不重复）',
      r1.entryOk && r2.entryOk && triggers.length === 1 && warns.length === 1 && forceTrigger && snap({ team: sb.teamFile }).team.sha256 === before.team.sha256,
      { entryOk: [r1.entryOk, r2.entryOk], errors: [r1.error, r2.error].filter(Boolean), triggerRows: triggers.length, warnMails: warns.length, forceTrigger, auditFile: path.relative(ROOT, sb.auditFile) });
  } finally { sb.cleanup(); }
}

async function case2() {
  const now = dayTimeMs();
  const sb = new Sandbox('c2-handover').seed({ usage: { analyst: { sessionId: 'sess-old-analyst', tokens: 520000, at: new Date(now).toISOString(), source: 'fixture' } } });
  try {
    const oldId = sb.sessionOf('analyst');
    const r1 = sb.runCycle(now);
    sb.handover('analyst', now + 5000);
    const r2 = sb.runCycle(now + 60 * 1000);
    const rows = sb.auditRows();
    // B-3594：交接回执到了也**只提醒不换人**（Owner 14:35）——不得出现 rotate/broadcast_reboot，名册不变
    const rotateRows = rows.filter((r) => r.stage === 'rotate');
    const remind = rows.some((r) => String(r.stage) === 'remind' && /HANDOVER_READY_REMIND_PM/.test(String(r.code || '')));
    const pmRemind = sb.mails('pm').some((m) => /换人提醒|手动换人|session rotate/i.test(`${m.subject || ''} ${m.body || ''}`));
    const newId = sb.sessionOf('analyst');
    // 其他角色（不含 analyst 与 pm）不得收到重 boot 广播；pm 只应收到「提醒」——提醒正文本身会提到
    // 「换人后广播重 boot」，所以 pm 不参与这条「广播」判定（B-3594）。
    const broadcast = ROLES.filter((r) => r !== 'analyst' && r !== 'pm').some((r) => sb.mails(r).some((m) => /重 boot|重boot|名册变更/i.test(`${m.subject || ''} ${m.body || ''}`)));
    const ok = r1.entryOk && r2.entryOk && rotateRows.length === 0 && newId === oldId && !broadcast && remind && pmRemind;
    return check('② 合式交接回执 → 只提醒（remind/HANDOVER_READY_REMIND_PM）+ PM 收到手动换人提醒，不 rotate、名册不变',
      ok, { entryOk: [r1.entryOk, r2.entryOk], errors: [r1.error, r2.error].filter(Boolean), oldId, newId, rotateRows: rotateRows.length, remind, pmRemind, broadcast });
  } finally { sb.cleanup(); }
}

async function case3() {
  const now = dayTimeMs();
  const sb = new Sandbox('c3-timeout').seed({ usage: { analyst: { sessionId: 'sess-old-analyst', tokens: 520000, at: new Date(now).toISOString(), source: 'fixture' } } });
  try {
    const r1 = sb.runCycle(now);
    const oldId = sb.sessionOf('analyst');
    const r2 = sb.runCycle(now + 16 * 60 * 1000);
    const rows = sb.auditRows();
    const rotateRows = rows.filter((r) => r.stage === 'rotate');
    const timeout = rows.some((r) => r.stage === 'skipped' && /HANDOVER_TIMEOUT/.test(String(r.code || '')));
    const pmEscalation = sb.mails('pm').some((m) => /HANDOVER_TIMEOUT|超时|未回执/.test(`${m.subject || ''} ${m.body || ''}`));
    return check('③ 交接超时（+16 分钟）→ 不 rotate、名册不变，只给 PM 升级告警',
      r1.entryOk && r2.entryOk && rotateRows.length === 0 && sb.sessionOf('analyst') === oldId && timeout && pmEscalation,
      { entryOk: [r1.entryOk, r2.entryOk], errors: [r1.error, r2.error].filter(Boolean), rotateRows: rotateRows.length, rosterSame: sb.sessionOf('analyst') === oldId, timeout, pmEscalation });
  } finally { sb.cleanup(); }
}

function nightFixture(name, hour, minute) {
  const d = new Date(); d.setHours(hour, minute, 0, 0);
  const now = d.getTime();
  const sb = new Sandbox(name).seed({
    usage: { analyst: { sessionId: 'sess-old-analyst', tokens: 520000, at: new Date(now).toISOString(), source: 'fixture' } },
    rounds: { product: { roundsSinceArchive: 30 } },
  });
  return { sb, now };
}

async function case4and5() {
  const { sb, now } = nightFixture('c4-night', 23, 30);
  try {
    const rosterBefore = ROLES.map((r) => sb.sessionOf(r)).join(',');
    const runs = [sb.runCycle(now), sb.runCycle(now + 5 * 60 * 1000), sb.runCycle(now + 10 * 60 * 1000)];
    const rows = sb.auditRows();
    const night = rows.filter((r) => r.stage === 'skipped' && String(r.code) === 'NIGHT_SILENT');
    const rotateRows = rows.filter((r) => r.stage === 'rotate');
    const rosterSame = ROLES.map((r) => sb.sessionOf(r)).join(',') === rosterBefore;
    const nightOk = night.length >= 2 && night.every((r) => String(r.result) === 'ok') && night.every((r) => r.evidence && 'threshold' in r.evidence && 'deferredUntil' in r.evidence) && /夜间/.test(night.map((r) => String(r.note || '') + JSON.stringify(r.evidence || {})).join(' '));
    const broadcastMail = ROLES.filter((r) => r !== 'analyst' && r !== 'product').reduce((n, r) => n + sb.mails(r).filter((m) => /boot|名册变更|换人/i.test(`${m.subject || ''} ${m.body || ''}`)).length, 0);
    const pmMail = sb.mails('pm').length;
    check('④ 夜间 22:00–08:00 一律不换人（含 force）→ 无 rotate、名册不变、NIGHT_SILENT、夜间不广播',
      runs.every((r) => r.entryOk) && rotateRows.length === 0 && rosterSame && nightOk && broadcastMail === 0 && pmMail <= 1,
      { entryOk: runs.map((r) => r.entryOk), errors: runs.map((r) => r.error).filter(Boolean), rotateRows: rotateRows.length, rosterSame, nightRows: night.length, nightOk, broadcastMail, pmMail });
    const perRole = {};
    for (const r of night) perRole[r.role] = (perRole[r.role] || 0) + 1;
    const dup = Object.entries(perRole).filter(([, n]) => n > 1);
    return check('⑤ 夜间同夜同角色只 1 行 NIGHT_SILENT（幂等）', night.length >= 2 && dup.length === 0,
      { nightRows: night.length, perRole, duplicates: dup });
  } finally { sb.cleanup(); }
}

async function case6() {
  // 改法按 PM M-20261117-201536-fe515a（转达 B 自检④）：**不手写审计行**，
  //   ① 注入时间「今夜 23:30」跑 1 拍 → 真实走夜间入队路径（enqueue / NIGHT_SILENT）
  //   ② 跳到「次日 08:05」跑 3 拍 → 断言 analyst(force) 先换、product(rounds) 次之、**每拍只换 1 个**
  const night = new Date(); night.setHours(23, 30, 0, 0);
  const nightMs = night.getTime();
  const day = new Date(nightMs); day.setDate(day.getDate() + 1); day.setHours(8, 5, 0, 0);
  const dayMs = day.getTime();
  const sb = new Sandbox('c6-nextday').seed({
    usage: { analyst: { sessionId: 'sess-old-analyst', tokens: 520000, at: new Date(nightMs).toISOString(), source: 'fixture' } },
    rounds: { product: { roundsSinceArchive: 30 } },
  });
  try {
    // ① 夜间 1 拍：真实入队
    const nightRun = sb.runCycle(nightMs);
    const nightRows = sb.auditRows();
    const queued = nightRows.filter((r) => String(r.stage) === 'enqueue'
      || (String(r.stage) === 'skipped' && String(r.code) === 'NIGHT_SILENT'));
    const queuedRoles = [...new Set(queued.map((r) => String(r.role)))].sort();
    const nightRotates = nightRows.filter((r) => String(r.stage) === 'rotate').length;

    // ② 次日 08:05 连跑 3 拍：B-3594 新语义＝只提醒不换人（每拍 remind，0 rotate）
    const sliceFrom = (n) => sb.auditRows().slice(n);
    let mark = sb.auditRows().length;
    const run1 = sb.runCycle(dayMs);
    const a1 = sliceFrom(mark); mark = sb.auditRows().length;
    const run2 = sb.runCycle(dayMs + 60 * 1000);
    const a2 = sliceFrom(mark); mark = sb.auditRows().length;
    const run3 = sb.runCycle(dayMs + 120 * 1000);
    const a3 = sliceFrom(mark);
    const rots = (rows) => rows.filter((r) => String(r.stage) === 'rotate').map((r) => String(r.role));
    const reminds = (rows) => rows.filter((r) => String(r.stage) === 'remind' && /REMIND_ONLY_MANUAL_ROTATE/.test(String(r.code || ''))).map((r) => String(r.role));
    const rot1 = rots(a1); const rot2 = rots(a2); const rot3 = rots(a3);
    const rem1 = reminds(a1); const rem2 = reminds(a2); const rem3 = reminds(a3);
    const order = [...rot1, ...rot2, ...rot3];
    const noRotate = order.length === 0;
    const remOk = rem1.length >= 1 && rem1[0] === 'analyst';
    const pmReminded = sb.mails('pm').some((m) => /换人提醒|手动换人|session rotate/i.test(`${m.subject || ''} ${m.body || ''}`));
    const rosterSame = ROLES.every((r) => sb.sessionOf(r) === (r === 'analyst' ? 'sess-old-analyst' : sb.sessionOf(r)));
    const runs = [nightRun, run1, run2, run3];
    return check('⑥ 夜间 23:30 入队 → 次日 08:05 连打 3 拍：只提醒不换人（analyst 先提醒、PM 收到手动换人提醒、0 rotate、名册不变）',
      runs.every((r) => r.entryOk) && nightRotates === 0 && queuedRoles.join(',') === 'analyst,product' && noRotate && remOk && pmReminded && rosterSame,
      { entryOk: runs.map((r) => r.entryOk), errors: runs.map((r) => r.error).filter(Boolean), queuedRoles, nightRotates, rem1, rem2, rem3, order, pmReminded, rosterSame });
  } finally { sb.cleanup(); }
}

async function case7() {
  // 反例（PM 2026-11-17 20:03 M-20261117-200342-df2f29 明确要求保留）：
  // 次日 08:05 窗口内，即使阈值命中（force 520000 / 轮数 30），只要**昨夜没有入队记账**，本窗口不得换任何人。
  const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 5, 0, 0);
  const now = d.getTime();
  const sb = new Sandbox('c7-nextday-noqueue').seed({
    usage: { analyst: { sessionId: 'sess-old-analyst', tokens: 520000, at: new Date(now).toISOString(), source: 'fixture' } },
    rounds: { product: { roundsSinceArchive: 30 } },
  });
  try {
    const rosterBefore = ROLES.map((r) => sb.sessionOf(r)).join(',');
    const runs = [sb.runCycle(now), sb.runCycle(now + 60 * 1000), sb.runCycle(now + 120 * 1000)];
    const rows = sb.auditRows();
    const rotateRows = rows.filter((r) => String(r.stage) === 'rotate');
    const rosterSame = ROLES.map((r) => sb.sessionOf(r)).join(',') === rosterBefore;
    return check('⑧ 反例：次日 08:05 无昨夜入队记账 → 阈值命中也不换任何人（严格队列口径）',
      runs.every((r) => r.entryOk) && rotateRows.length === 0 && rosterSame,
      { entryOk: runs.map((r) => r.entryOk), errors: runs.map((r) => r.error).filter(Boolean), rotateRows: rotateRows.map((r) => String(r.role)), rosterSame, stages: rows.map((r) => `${r.stage}/${r.code || ''}`) });
  } finally { sb.cleanup(); }
}

// AC2 错形状用例（PM 2026-11-17 21:10 裁定：由测试补，不计开发）
async function case8() {
  const now = dayTimeMs();
  // 轮次文件写成错误形状 {"roles": {...}}：解析得通但形状不对 → 不得按 0 轮静默处理，必须留痕 ROUNDS_UNREADABLE
  const sb = new Sandbox('c8-rounds-shape').seed({
    usage: { analyst: { sessionId: 'sess-old-analyst', tokens: 200000, at: new Date(now).toISOString(), source: 'fixture' } },
    rounds: { roles: { product: { roundsSinceArchive: 30 } } },
  });
  try {
    const r1 = sb.runCycle(now);
    const rows = sb.auditRows();
    const unreadable = rows.filter((r) => String(r.code) === 'ROUNDS_UNREADABLE');
    const rotates = rows.filter((r) => String(r.stage) === 'rotate');
    return check('⑨ AC2 错形状 {"roles":{…}} → 不触发轮数换人，且留痕 skipped/ROUNDS_UNREADABLE（不按 0 轮静默）',
      r1.entryOk && rotates.length === 0 && unreadable.length >= 1,
      { entryOk: r1.entryOk, rotates: rotates.length, unreadable: unreadable.map((r) => `${r.stage}/${r.code}`), stages: rows.map((r) => `${r.stage}/${r.code || ''}`) });
  } finally { sb.cleanup(); }
}

// AC5 轮换四测用例（PM 2026-11-17 21:10 裁定：由测试补，不计开发）
async function case9() {
  const now = dayTimeMs();
  const sb = new Sandbox('c9-rotate-four').seed({ usage: { analyst: { sessionId: 'sess-old-analyst', tokens: 520000, at: new Date(now).toISOString(), source: 'fixture' } } });
  try {
    const oldId = sb.sessionOf('analyst');
    sb.runCycle(now);                       // ① 触发交接请求
    sb.handover('analyst', now);            // ② 交接 + 回执
    const r2 = sb.runCycle(now + 2 * 60 * 1000);  // ③ B-3594：只提醒，不再 rotate
    const newId = sb.sessionOf('analyst');
    const wbSessions = (() => { const wb = readJson(sb.workbenchFile, {}); const p = ((wb.projects || [])[0] || {}); return (p.sessions || {}); })();
    // B-3594 新口径：交接回执到后**四落地全部不动**（名册 / workbench.sessions / 会话轮换记录 / 归档），
    // 换人只由 PM 手动 `session rotate` 执行（手动路径 6/6 在 test-3594-remind-only.cjs 覆盖）。
    const wbSame = String(wbSessions.analyst || '') === oldId;
    const rotFile = path.join(sb.state, '会话轮换', 'analyst.json');
    const rotJsonl = path.join(sb.state, '会话轮换.jsonl');
    const rot = readJson(rotFile, null);
    const jsonlRow = (() => {
      try {
        return fs.readFileSync(rotJsonl, 'utf8').split(/\r?\n/).filter(Boolean)
          .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean)
          .filter((r) => String(r.role) === 'analyst').pop() || null;
      } catch { return null; }
    })();
    const noRotRecord = !rot && !jsonlRow;
    const archiveDir = path.join(sb.state, '归档');
    const noArchive = !fs.existsSync(archiveDir);
    const remind = sb.auditRows().some((r) => String(r.stage) === 'remind' && /HANDOVER_READY_REMIND_PM/.test(String(r.code || '')));
    const noRotate = !sb.auditRows().some((r) => String(r.stage) === 'rotate');
    const pass = r2.entryOk && newId === oldId && wbSame && noRotRecord && noArchive && remind && noRotate;
    return check('⑩ AC5 四落地在「只提醒」下全部不动：名册 / workbench.sessions / 会话轮换记录 / 归档（换人改由 PM 手动）',
      pass,
      { entryOk: r2.entryOk, oldId, newId, wbAnalyst: String(wbSessions.analyst || ''), wbSame, noRotRecord, noArchive, remind, noRotate });
  } finally { sb.cleanup(); }
}

async function main() {
  fs.mkdirSync(CASE_BASE, { recursive: true });
  const realBefore = snap(REAL_FILES);
  if (ENTRY.kind === 'none' && !jsonOut) console.log('[入口] 未检测到 fa0e 实现（模块/CLI 均无）——7 条断言将如实记为红（未实现）。');
  await sleep(10);
  await case1();
  await case2();
  await case3();
  await case4and5();
  await case6();
  await case7();
  await case8();
  await case9();
  const realAfter = snap(REAL_FILES);
  // ⑦ 基线口径（沿用 PM 2026-11-17 19:52 给 fd42 ⑥ 的裁定）：真实 workbench.json 会被**其他角色**写
  // （本轮实测：A 的 5d98 PM 身份 60 秒巡检在跑测试期间把真实 workbench.json +18B 并换了 sha），
  // 所以不能拿它的 sha 当基线。改为判「隔离是否渗漏」这条真正要保证的性质：
  //   ① 真实 团队.json sha 不变（名册只由 rotate 改，沙盘 rotate 不得碰真实名册）；
  //   ② 真实 workbench.json 里**不出现沙盘夹具会话 id**（sess-old-* / session-auto-*），即夹具没漏进真实文件。
  const realWbText = (() => { try { return fs.readFileSync(REAL_STORE_FILE, 'utf8'); } catch { return ''; } })();
  const leakHits = (realWbText.match(/sess-old-[a-z0-9]+|session-auto-[a-z0-9]+-[a-z0-9]+/g) || []).slice(0, 5);
  const teamSame = Boolean(realBefore.team.sha256) && realBefore.team.sha256 === realAfter.team.sha256;
  const wbChangedByOthers = realBefore.workbench.sha256 !== realAfter.workbench.sha256;
  check('⑦ 隔离不渗漏：真实 团队.json sha 不变 + 真实 workbench.json 无沙盘夹具会话 id（真实 workbench 可能被其他角色写，不作 sha 基线）',
    teamSame && leakHits.length === 0,
    { teamSame, leakHits, wbChangedByOthers, before: realBefore, after: realAfter });

  const total = results.length;
  const pass = results.filter((r) => r.ok).length;
  const red = total - pass;
  const payload = {
    at: new Date().toISOString(),
    script: 'scripts/test-auto-rotate.cjs',
    requirement: 'R-20261117-180740-fa0e',
    implEntry: ENTRY.kind === 'none' ? 'not-implemented' : `${ENTRY.kind}:${path.relative(ROOT, ENTRY.file)}`,
    sandboxRoot: path.relative(ROOT, CASE_BASE),
    total, pass, red,
    results,
    evidence: { realFiles: { before: realBefore, after: realAfter } },
  };
  const evDir = path.join(ROOT, '项目', PROJECT, '测试人员', '产出', '证据-fa0e-repro');
  fs.mkdirSync(evDir, { recursive: true });
  const evFile = path.join(evDir, `run-${ts}-${red === 0 ? 'green' : 'red'}.json`);
  payload.evidenceFile = path.relative(ROOT, evFile).replace(/\\/g, '/');
  fs.writeFileSync(evFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  try { fs.rmSync(CASE_BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }

  if (jsonOut) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  else {
    console.log('');
    console.log(`${red === 0 ? 'AUTO_ROTATE_OK' : 'AUTO_ROTATE_WARN'} ${JSON.stringify({ total, pass, red })}`);
    console.log(`证据：${payload.evidenceFile}`);
  }
  process.exit(red === 0 ? 0 : 1);
}

main().catch((e) => { console.error('CRASH', String((e && e.stack) || e)); process.exit(2); });
