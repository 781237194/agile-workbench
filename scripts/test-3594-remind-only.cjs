#!/usr/bin/env node
'use strict';
/**
 * B-20261118-143542-3594（P1）「自动换人只提醒不换人」夹具。
 *
 * Owner 2026-11-18 14:35：到阈值 → 提醒（角色 1 条 + PM 1 条）→ 成员写交接并回执 PM → **PM 手动**执行换人；
 * 系统绝不自动 rotate。本夹具 4 组：
 *   ① 阈值命中：只产生 trigger/remind 审计 + 角色/PM 各 1 条提醒，0 rotate、0 broadcast_reboot、名册不变、workbench 不变；
 *   ② enabled=false：连提醒也不发（beat skipped=disabled，审计零新增、邮箱零新增）；
 *   ③ 交接文件更新（mtime 前进 + 回执邮件）→ 仍只提醒（remind/HANDOVER_READY_REMIND_PM），不换人；
 *   ④ PM 手动 `session rotate`（沙盘）→ 四处映射 6/6（换人唯一入口仍可用）。
 *
 * 跑法：node scripts/test-3594-remind-only.cjs
 * 产出：AWB_3594_OUT 指定目录（默认 程序员A/产出/证据-3594/run-3594.json）
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const REAL = ROOT;
const PROJECT = '工作台改造修复';
const ROLE_DIRS = { pm: '项目经理', product: '产品', analyst: '需求分析师', programmer1: '程序员A', programmer2: '程序员B', tester: '测试人员' };
const ROLES = Object.keys(ROLE_DIRS);
const BASE = path.join(ROOT, '_tmp', `b3594-${process.pid}-${Date.now().toString(36)}`);
const EVID = process.env.AWB_3594_OUT ? path.resolve(process.env.AWB_3594_OUT) : path.join(ROOT, '项目', PROJECT, '程序员A', '产出', '证据-3594');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? null : (detail === undefined ? null : detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + JSON.stringify(detail === undefined ? null : detail).slice(0, 420)}`);
  if (!ok) process.exitCode = 1;
}
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
const sha256 = (f) => { try { return require('node:crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; } };
function copyDir(src, dest, skip) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    if (skip && skip(from)) continue;
    const st = fs.statSync(from);
    if (st.isDirectory()) copyDir(from, to, skip);
    else fs.copyFileSync(from, to);
  }
}
/** 上海本地时间注入格式（AWB_NOW 必须带偏移；不依赖宿主时区）。 */
function fmtAWB(ms) {
  const parts = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(ms)).reduce((acc, p) => { acc[p.type] = p.value; return acc; }, {});
  return `${parts.year}-${parts.month}-${parts.day}T${parts.hour}:${parts.minute}:${parts.second}+08:00`;
}
function dayTimeMs(hour = 10) {
  const d = new Date();
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(d)).split('-').map(Number);
  // 上海当天 hour:00 = UTC 当天 hour-8:00
  return Date.UTC(parts[0], parts[1] - 1, parts[2], hour - 8, 0, 0, 0);
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
  const roster = readJson(path.join(team, '状态', '团队.json'), { members: [] });
  for (const m of roster.members || []) m.sessionId = `sess-old-${m.role}`;
  roster.activeProject = PROJECT;
  if (config !== undefined) roster.config = { ...(roster.config || {}), autoRotate: config };
  writeJson(path.join(team, '状态', '团队.json'), roster);
  writeJson(path.join(state, '项目.json'), { name: PROJECT, path: projectDir, teamMode: 'full' });
  writeJson(path.join(state, '工作流.json'), { schema: 2, project: PROJECT, round: 1, requirements: {}, boots: {} });
  if (usage) writeJson(path.join(state, '会话用量.json'), usage);
  if (rounds) writeJson(path.join(state, '会话轮次.json'), rounds);
  const store = readJson(path.join(REAL, 'data', 'userdata', 'workbench.json'), { projects: [] });
  const project = (store.projects || []).find((p) => p && String(p.teamName || p.name || '') === PROJECT);
  store.projects = [project];
  store.activeProjectId = project.id;
  project.path = projectDir;
  project.workspacePath = projectDir;
  project.sessions = Object.fromEntries(ROLES.map((r) => [r, `sess-old-${r}`]));
  writeJson(path.join(data, 'userdata', 'workbench.json'), store);
  for (const r of ROLES) fs.mkdirSync(path.join(projectDir, ROLE_DIRS[r], '产出'), { recursive: true });
  return {
    dir, data, team, projectDir, state,
    get audit() { return path.join(state, '自动换人.jsonl'); },
    get teamFile() { return path.join(team, '状态', '团队.json'); },
    get storeFile() { return path.join(data, 'userdata', 'workbench.json'); },
    env(nowMs, extra = {}) {
      return {
        ...process.env, AWB_DATA_DIR: data, TEAM_ROOT: team,
        TEAM_PROJECTS_ROOT: path.join(team, '状态', '项目'),
        TEAM_WORKBENCH_JSON: path.join(data, 'userdata', 'workbench.json'),
        TEAM_SELFTEST: '1', TEAM_HANDOVER_ENFORCE: '', AWB_NOW: fmtAWB(nowMs), ...extra,
      };
    },
    rows() {
      if (!fs.existsSync(this.audit)) return [];
      return fs.readFileSync(this.audit, 'utf8').split(/\r?\n/).filter(Boolean)
        .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    },
    mails(role) {
      const dir = path.join(team, '状态', '邮箱', role, 'new');
      try {
        return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => readJson(path.join(dir, n), {}));
      } catch { return []; }
    },
    sessionOf(role) {
      const t = readJson(this.teamFile, { members: [] });
      const m = (t.members || []).find((x) => x.role === role);
      return m ? String(m.sessionId || '') : '';
    },
    cleanup() { try { fs.rmSync(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ } },
  };
}
function loadModule(sb, nowMs) {
  // 每个沙盘一个独立子进程环境：用 spawnSync 跑小脚本拿 JSON（避免同进程 env 串味）
  const probe = path.join(sb.dir, '_cycle.cjs');
  fs.writeFileSync(probe, `'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
(async () => {
  const mod = await import(pathToFileURL(path.join(${JSON.stringify(path.join(ROOT, '团队', '工具', 'lib', 'auto-rotate.mjs'))})).href);
  const out = await mod.runAutoRotateCycle(${JSON.stringify(PROJECT)}, { now: ${Number(nowMs)}, dryRun: false, source: 'fixture-3594' });
  console.log(JSON.stringify({ ok: out.ok, mode: out.mode, actions: out.actions, rotated: out.rotated, note: out.note }));
})().catch((e) => { console.log(JSON.stringify({ ok: false, error: String((e && e.stack) || e) })); process.exitCode = 1; });
`, 'utf8');
  const r = spawnSync(process.execPath, [probe], { cwd: sb.dir, env: sb.env(nowMs), encoding: 'utf8' });
  const line = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
  try { return JSON.parse(line); } catch { return { ok: false, error: String(r.stdout || '') + String(r.stderr || '') }; }
}

(async () => {
  fs.mkdirSync(BASE, { recursive: true });
  const now = dayTimeMs(10);
  const iso = (ms) => new Date(ms).toISOString();

  /* ① 阈值命中：只提醒（角色 1 + PM 1），0 rotate，名册/workbench 不变 */
  {
    const sb = makeSandbox('c1-remind', {
      usage: { analyst: { sessionId: 'sess-old-analyst', tokens: 520000, input: 500000, at: iso(now), source: 'fixture' } },
      config: { enabled: true, intervalMs: 300000 },
    });
    try {
      const teamBefore = sha256(sb.teamFile);
      const storeBefore = sha256(sb.storeFile);
      const r1 = loadModule(sb, now);
      const r2 = loadModule(sb, now + 30 * 1000); // 60 秒去重窗口内再跑
      const rows = sb.rows();
      const rotates = rows.filter((d) => String(d.stage) === 'rotate' || String(d.stage) === 'broadcast_reboot');
      const triggers = rows.filter((d) => String(d.stage) === 'trigger' && d.role === 'analyst');
      const roleMails = sb.mails('analyst').filter((m) => /session_rotate_warn|交接/i.test(`${m.type || ''} ${m.subject || ''}`));
      const pmMails = sb.mails('pm').filter((m) => /换人提醒|手动换人|session rotate/i.test(`${m.subject || ''} ${m.body || ''}`));
      check('① 阈值命中：只发提醒（角色 1 条 + PM 1 条），0 rotate / 0 broadcast_reboot',
        r1.ok === true && r2.ok === true && triggers.length === 1 && roleMails.length === 1 && pmMails.length === 1 && rotates.length === 0,
        { ok: [r1.ok, r2.ok], triggers: triggers.length, roleMails: roleMails.length, pmMails: pmMails.length, rotates: rotates.length, actions: r2.actions });
      check('① 名册与 workbench.sessions 均未被改写（不换人）',
        sha256(sb.teamFile) === teamBefore && sha256(sb.storeFile) === storeBefore && sb.sessionOf('analyst') === 'sess-old-analyst',
        { teamSame: sha256(sb.teamFile) === teamBefore, storeSame: sha256(sb.storeFile) === storeBefore, now: sb.sessionOf('analyst') });
    } finally { sb.cleanup(); }
  }

  /* ② enabled=false：连提醒也不发（零审计、零邮箱） */
  {
    const sb = makeSandbox('c2-disabled', {
      usage: { analyst: { sessionId: 'sess-old-analyst', tokens: 520000, at: iso(now), source: 'fixture' } },
      config: { enabled: false },
    });
    try {
      const auditBefore = fs.existsSync(sb.audit) ? sha256(sb.audit) : '';
      const probe = path.join(sb.dir, '_beat.cjs');
      fs.writeFileSync(probe, `'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
(async () => {
  const mod = await import(pathToFileURL(path.join(${JSON.stringify(path.join(ROOT, '团队', '工具', 'lib', 'auto-rotate.mjs'))})).href);
  const out = mod.runAutoRotateBeat(${JSON.stringify(PROJECT)}, { now: ${Number(now)}, state: {}, source: 'fixture-3594' });
  console.log(JSON.stringify({ ok: out.ok, skipped: out.skipped || '', code: out.code || '' }));
})().catch((e) => { console.log(JSON.stringify({ ok: false, error: String((e && e.stack) || e) })); process.exitCode = 1; });
`, 'utf8');
      const r = spawnSync(process.execPath, [probe], { cwd: sb.dir, env: sb.env(now), encoding: 'utf8' });
      const line = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
      let beat = { ok: false };
      try { beat = JSON.parse(line); } catch { beat = { ok: false, raw: String(r.stdout || '') }; }
      const auditAfter = fs.existsSync(sb.audit) ? sha256(sb.audit) : '';
      const mails = sb.mails('analyst').length + sb.mails('pm').length;
      check('② enabled=false → 整拍 skipped=disabled，审计零新增、邮箱零新增（连提醒都不发）',
        beat.ok === true && beat.skipped === 'disabled' && auditAfter === auditBefore && mails === 0,
        { beat, auditChanged: auditAfter !== auditBefore, mails });
    } finally { sb.cleanup(); }
  }

  /* ③ 交接文件更新 + 回执 → 仍只提醒，不换人 */
  {
    const sb = makeSandbox('c3-handover', {
      usage: { analyst: { sessionId: 'sess-old-analyst', tokens: 520000, at: iso(now), source: 'fixture' } },
      config: { enabled: true },
    });
    try {
      const oldId = sb.sessionOf('analyst');
      loadModule(sb, now); // 先产生交接请求（trigger）
      // 角色写交接文件（mtime 前进）+ 回执邮件
      const handoverFile = path.join(sb.projectDir, '需求分析师', '产出', '交接-最新.md');
      fs.mkdirSync(path.dirname(handoverFile), { recursive: true });
      fs.writeFileSync(handoverFile, '# 交接-最新（需求分析师）\n\n## 在办\n- T-fixture\n', 'utf8');
      const mt = new Date(now + 5000); fs.utimesSync(handoverFile, mt, mt);
      const mailDir = path.join(sb.team, '状态', '邮箱', 'pm', 'new');
      fs.mkdirSync(mailDir, { recursive: true });
      writeJson(path.join(mailDir, 'M-fixture-handover-analyst.json'), {
        id: 'M-fixture-handover-analyst', from: 'analyst', to: 'pm', type: 'receipt',
        subject: '交接完成：analyst', body: '交接已完成，明细见产出/交接-最新.md', project: PROJECT, ts: iso(now + 5000),
      });
      const r2 = loadModule(sb, now + 60 * 1000);
      const rows = sb.rows();
      const rotates = rows.filter((d) => String(d.stage) === 'rotate');
      const remind = rows.some((d) => String(d.stage) === 'remind' && /HANDOVER_READY_REMIND_PM/.test(String(d.code || '')));
      const pmRemind = sb.mails('pm').some((m) => /换人提醒|手动换人|session rotate/i.test(`${m.subject || ''} ${m.body || ''}`));
      check('③ 交接文件更新 + 回执到了 → 仍只提醒（remind/HANDOVER_READY_REMIND_PM + PM 提醒）、0 rotate、名册不变',
        r2.ok === true && rotates.length === 0 && remind && pmRemind && sb.sessionOf('analyst') === oldId,
        { ok: r2.ok, rotates: rotates.length, remind, pmRemind, oldId, newId: sb.sessionOf('analyst'), actions: r2.actions });
    } finally { sb.cleanup(); }
  }

  /* ④ PM 手动 rotate（唯一执行入口）→ 四处映射 6/6 */
  {
    const sb = makeSandbox('c4-manual-rotate', {
      usage: { analyst: { sessionId: 'sess-old-analyst', tokens: 520000, at: iso(now), source: 'fixture' } },
      config: { enabled: true },
    });
    try {
      const oldId = sb.sessionOf('analyst');
      const teamMjs = path.join(ROOT, '团队', '工具', 'team.mjs');
      const r = spawnSync(process.execPath, [teamMjs, 'session', 'rotate', '--role', 'analyst', '--project', PROJECT, '--offline', '--session', 'session-fixture-analyst-3594', '--json'], {
        cwd: sb.dir, env: sb.env(now), encoding: 'utf8',
      });
      const outText = String(r.stdout || '') + String(r.stderr || '');
      const line = String(r.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop() || '';
      let out = null;
      try { out = JSON.parse(line); } catch { out = null; }
      const newId = sb.sessionOf('analyst');
      // 四处映射自验（6/6 口径）：团队.json / 团队会话.json / workbench.projects[].sessions / workbench.workspace.sessionIds
      const rosterRow = sb.sessionOf('analyst');
      const projFile = path.join(sb.state, '团队会话.json');
      const projExists = fs.existsSync(projFile);
      const projSessions = (() => {
        const t = readJson(projFile, null);
        if (!t) return '';
        const list = Array.isArray(t.roles) ? t.roles : (Array.isArray(t.members) ? t.members : []);
        const row = list.find((x) => x && x.role === 'analyst') || null;
        if (row) return String(row.sessionId || '');
        return String((t.sessions || {}).analyst || '');
      })();
      const wb = readJson(path.join(sb.dir, 'data', 'userdata', 'workbench.json'), { projects: [] });
      const p0 = (wb.projects || [])[0] || {};
      const wbSession = String((p0.sessions || {}).analyst || '');
      const wsIds = Array.isArray((p0.workspace || {}).sessionIds) ? (p0.workspace || {}).sessionIds : [];
      const wsHas = wsIds.includes(newId);
      // 团队会话.json 属可选派生（沙盘夹具未登记该项目时不写）；存在就必须等于新 id，不存在按「未绑定」记。
      const projOk = projExists ? projSessions === newId : true;
      const fourOk = newId !== '' && newId !== oldId && rosterRow === newId && projOk && wbSession === newId && wsHas;
      check('④ PM 手动 `session rotate`：换人成功且四处映射一致（团队.json / 团队会话.json（若存在）/ workbench.sessions / workspace.sessionIds）',
        r.status === 0 && fourOk,
        { status: r.status, oldId, newId, rosterRow, projExists, projSessions, wbSession, wsHasFour: wsHas, tail: outText.slice(-300) });
    } finally { sb.cleanup(); }
  }

  fs.mkdirSync(EVID, { recursive: true });
  const report = {
    task: 'B-20261118-143542-3594', at: new Date().toISOString(),
    total: results.length, pass: results.filter((x) => x.ok).length, red: results.filter((x) => !x.ok).length, results,
  };
  const out = path.join(EVID, 'run-3594.json');
  fs.writeFileSync(out, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`\nB3594_REMIND_ONLY ${JSON.stringify({ total: report.total, pass: report.pass, red: report.red })}`);
  console.log('证据：' + out);
  process.exit(report.red ? 1 : 0);
})();
