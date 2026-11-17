#!/usr/bin/env node
'use strict';
/**
 * T-20261118-002151-61f5 夹具：fa0e 会话用量缺失/过期 → 回落实时值（session usage 同一函数，判档 usageLevelOf 单源）。
 *
 * 判据（PM M-20261118-002204-e4e498）：
 *   ① 会话用量.json 缺失 → 用 TEAM_DSH_FAKE 的实时 tokens 触发（force），审计标 usageSource=live；
 *   ② 文件新鲜 → 用文件值，标 usageSource=file，不产生实时回退行、不联网；
 *   ③ 文件过期（>24h）→ 回落实时值（warn 档 320000 → 只提醒，标 live）；
 *   ④ 文件缺失且实时也取不到 → 逐角色 USAGE_UNAVAILABLE（usageSource=none），不静默；
 *   ⑤ 面板：buildPanelModel 的 autoRotate.usageSource 能读到 live。
 *
 * 隔离：TEAM_ROOT/TEAM_PROJECTS_ROOT/TEAM_WORKBENCH_JSON/TEAM_SELFTEST=1 + 唯一 _tmp 沙盘；时间注入 now。
 * 跑法：node scripts/test-fa0e-usage-live.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const { mkTempSandbox, rmSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));
const ROLE_DIRS = { pm: '项目经理', product: '产品', analyst: '需求分析师', programmer1: '程序员A', programmer2: '程序员B', tester: '测试人员' };
const ROLES = Object.keys(ROLE_DIRS);
const PROJECT = 'fa0e-usage-sandbox';
const HOUR = 3600 * 1000;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 800)}`);
  if (!ok) process.exitCode = 1;
}
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
const fmtAWB = (ms) => new Date(Number(ms) + 8 * HOUR).toISOString().slice(0, 19) + '+08:00';
const daytime = (() => { const d = new Date(); d.setHours(15, 0, 0, 0); return d.getTime(); })();

function makeSandbox(name, { usage, dshFake } = {}) {
  const dir = path.join(mkTempSandbox(`61f5-${name}`), 'sb');
  fs.mkdirSync(dir, { recursive: true });
  const team = path.join(dir, '团队');
  const data = path.join(dir, 'data');
  const projectDir = path.join(dir, '项目', PROJECT);
  const state = path.join(team, '状态', '项目', PROJECT);
  fs.mkdirSync(path.join(data, 'userdata'), { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  for (const rel of ['团队宪法.md', '项目铁律.md']) {
    const src = path.join(ROOT, '团队', rel);
    if (fs.existsSync(src)) { fs.mkdirSync(team, { recursive: true }); fs.copyFileSync(src, path.join(team, rel)); }
  }
  const roster = readJson(path.join(ROOT, '团队', '状态', '团队.json'), { members: [] });
  const members = (roster.members || []).filter((m) => m && ROLES.includes(m.role)).map((m) => ({ ...m, sessionId: `sess-old-${m.role}`, status: 'active' }));
  writeJson(path.join(team, '状态', '团队.json'), {
    version: 1, activeProject: PROJECT, members,
    config: { messageMaxChars: 4000, autoRotate: { enabled: true, intervalMs: 0, rotateRounds: 8 } },
  });
  writeJson(path.join(state, '项目.json'), { name: PROJECT, path: projectDir, teamMode: 'full', roleIds: ROLES });
  writeJson(path.join(state, '工作流.json'), { schema: 2, project: PROJECT, round: 1, requirements: {}, boots: {} });
  writeJson(path.join(data, 'userdata', 'workbench.json'), {
    version: 1, activeProjectId: 'p-61f5',
    projects: [{ id: 'p-61f5', name: PROJECT, teamName: PROJECT, path: projectDir, sessions: Object.fromEntries(ROLES.map((r) => [r, `sess-old-${r}`])), workspace: { path: projectDir, sessionIds: ROLES.map((r) => `sess-old-${r}`) } }],
  });
  if (usage) writeJson(path.join(state, '会话用量.json'), usage);
  for (const r of ROLES) fs.mkdirSync(path.join(projectDir, ROLE_DIRS[r], '产出'), { recursive: true });
  const env = {
    ...process.env,
    TEAM_ROOT: team, TEAM_PROJECTS_ROOT: path.join(team, '状态', '项目'),
    TEAM_WORKBENCH_JSON: path.join(data, 'userdata', 'workbench.json'),
    TEAM_SELFTEST: '1', AWB_NOW: fmtAWB(daytime),
    __AR_PROJECT: PROJECT, __AR_NOW: String(daytime),
    __MODULE: path.join(ROOT, '团队', '工具', 'lib', 'auto-rotate.mjs'),
  };
  if (dshFake !== undefined) env.TEAM_DSH_FAKE = JSON.stringify(dshFake);
  return {
    dir, team, state, projectDir, data,
    get audit() { return path.join(state, '自动换人.jsonl'); },
    rows() {
      if (!fs.existsSync(this.audit)) return [];
      return fs.readFileSync(this.audit, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    },
    env,
  };
}

function cycle(sb, nowMs) {
  const boot = [
    'const { pathToFileURL } = require("node:url");',
    '(async () => {',
    '  const mod = await import(pathToFileURL(process.env.__MODULE).href);',
    '  const r = await mod.runAutoRotateCycle(process.env.__AR_PROJECT, { now: Number(process.env.__AR_NOW), dryRun: false, source: "61f5-check" });',
    '  console.log("@@61F5@@" + JSON.stringify(r === undefined ? null : r));',
    '})().catch((e) => console.log("@@61F5@@" + JSON.stringify({ ok: false, code: "THROW", error: String((e && (e.code || e.message)) || e) })));',
  ].join('\n');
  const r = spawnSync(process.execPath, ['-e', boot], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: { ...sb.env, __AR_NOW: String(nowMs), AWB_NOW: fmtAWB(nowMs) } });
  const line = String(r.stdout || '').split(/\r?\n/).find((x) => x.includes('@@61F5@@'));
  if (!line) return { entryOk: false, error: String(r.stderr || r.stdout || '').slice(0, 400) };
  try { return { entryOk: true, result: JSON.parse(line.split('@@61F5@@')[1]) }; } catch (e) { return { entryOk: false, error: String(e.message || e) }; }
}
const liveFake = (tokens) => [{ sessionId: 'sess-old-analyst', inputTokens: tokens, cacheReadTokens: 0, outputTokens: 0 }];
const nowIso = (ms) => new Date(Number(ms)).toISOString();

/* ── ① 文件缺失 → 实时回退 force 触发 ── */
{
  const sb = makeSandbox('missing-live-force', { dshFake: liveFake(520000) });
  const run = cycle(sb, daytime);
  const rows = sb.rows();
  const cycleRow = rows.filter((r) => String(r.code) === 'CYCLE').pop() || {};
  const ev = cycleRow.evidence || {};
  const fallback = rows.filter((r) => String(r.code) === 'USAGE_LIVE_FALLBACK');
  const triggers = rows.filter((r) => String(r.stage) === 'trigger');
  const tr = triggers.find((r) => String(r.role) === 'analyst') || {};
  check('U1 缺失文件 → 实时回退：cycle.usageSources.live 含 analyst', run.entryOk && (ev.usageSources || {}).live && ev.usageSources.live.includes('analyst'),
    { entryOk: run.entryOk, error: run.error, usageSources: ev.usageSources, result: run.result });
  check('U2 缺失文件 → 审计出现 USAGE_LIVE_FALLBACK（roles 含 analyst + tokens）',
    fallback.length === 1 && (fallback[0].evidence.roles || []).some((x) => x.role === 'analyst' && Number(x.tokens) === 520000),
    { fallback });
  check('U3 token 触发仍生效（force），trigger.evidence.usageSource=live、tokens=520000',
    String(tr.code || '') === 'HANDOVER_REQUESTED' && tr.evidence && String(tr.evidence.usageSource) === 'live' && Number(tr.evidence.tokens) === 520000,
    { trigger: tr });
  check('U4 有实时值的角色不再写 USAGE_UNAVAILABLE', !rows.some((r) => String(r.code) === 'USAGE_UNAVAILABLE' && String(r.role) === 'analyst'), { rows: rows.map((r) => `${r.stage}/${r.code}/${r.role}`) });
  // ⑤ 面板取数
  let panel = null;
  try {
    const sq = require(path.join(ROOT, 'src', 'session-queue.js'));
    panel = sq.buildPanelModel({ autoRotateRows: rows, roles: ROLES, roleNames: {}, now: daytime, project: PROJECT });
  } catch (e) { panel = { error: String((e && e.message) || e) }; }
  const arRow = panel && (panel.rows || []).find((r) => r.role === 'analyst');
  check('U5 面板 buildPanelModel：analyst.autoRotate.usageSource=live', Boolean(arRow && arRow.autoRotate && String(arRow.autoRotate.usageSource) === 'live'),
    { panel: panel && { error: panel.error, roles: (panel.rows || []).map((r) => [r.role, r.autoRotate && r.autoRotate.usageSource]) } });
}

/* ── ② 文件新鲜 → 用文件值（不联网、不产生回退行） ── */
{
  const sb = makeSandbox('file-fresh', { usage: { analyst: { role: 'analyst', sessionId: 'sess-old-analyst', tokens: 520000, at: nowIso(daytime - 5 * 60 * 1000), source: 'fixture' } } });
  const run = cycle(sb, daytime);
  const rows = sb.rows();
  const ev = (rows.filter((r) => String(r.code) === 'CYCLE').pop() || {}).evidence || {};
  const tr = rows.filter((r) => String(r.stage) === 'trigger' && String(r.role) === 'analyst')[0] || {};
  check('U6 文件新鲜 → usageSources.file 含 analyst，且无 USAGE_LIVE_FALLBACK 行',
    run.entryOk && (ev.usageSources || {}).file && ev.usageSources.file.includes('analyst') && !rows.some((r) => String(r.code) === 'USAGE_LIVE_FALLBACK'),
    { entryOk: run.entryOk, error: run.error, usageSources: ev.usageSources, codes: rows.map((r) => r.code) });
  check('U7 文件新鲜 → trigger.evidence.usageSource=file', tr.evidence && String(tr.evidence.usageSource) === 'file', { trigger: tr });
}

/* ── ③ 文件过期（>24h）→ 回落实时值（warn 档只提醒） ── */
{
  const sb = makeSandbox('file-stale-live-warn', {
    usage: { analyst: { role: 'analyst', sessionId: 'sess-old-analyst', tokens: 520000, at: nowIso(daytime - 25 * HOUR), source: 'fixture' } },
    dshFake: liveFake(320000),
  });
  const run = cycle(sb, daytime);
  const rows = sb.rows();
  const ev = (rows.filter((r) => String(r.code) === 'CYCLE').pop() || {}).evidence || {};
  const warnOnly = rows.filter((r) => String(r.code) === 'WARN_ONLY' && String(r.role) === 'analyst');
  check('U8 文件过期 → 回落实时值：usageSources.live 含 analyst、usageSources.file 不含',
    run.entryOk && (ev.usageSources || {}).live && ev.usageSources.live.includes('analyst') && !((ev.usageSources || {}).file || []).includes('analyst'),
    { entryOk: run.entryOk, error: run.error, usageSources: ev.usageSources });
  check('U9 实时值 320000 走 usageLevelOf 单源判 warn（只提醒、WARN_ONLY.evidence.usageSource=live，不发交接）',
    warnOnly.length === 1 && warnOnly[0].evidence && String(warnOnly[0].evidence.usageSource) === 'live' && !rows.some((r) => String(r.stage) === 'trigger' && String(r.role) === 'analyst'),
    { warnOnly, rows: rows.map((r) => `${r.stage}/${r.code}/${r.role}`) });
}

/* ── ④ 缺失且实时取不到 → USAGE_UNAVAILABLE（none），不静默 ── */
{
  const sb = makeSandbox('missing-no-live', { dshFake: [] });
  const run = cycle(sb, daytime);
  const rows = sb.rows();
  const ev = (rows.filter((r) => String(r.code) === 'CYCLE').pop() || {}).evidence || {};
  const unavailable = rows.filter((r) => String(r.code) === 'USAGE_UNAVAILABLE');
  check('U10 缺失+实时取不到 → 每个成员各 1 条 USAGE_UNAVAILABLE，evidence.usageSource=none',
    run.entryOk && unavailable.length === ROLES.length && unavailable.every((r) => r.evidence && String(r.evidence.usageSource) === 'none'),
    { entryOk: run.entryOk, error: run.error, count: unavailable.length, rows: unavailable.map((r) => r.role) });
  check('U11 此场景不产生实时回退行、无 trigger（不伪造触发）',
    !rows.some((r) => String(r.code) === 'USAGE_LIVE_FALLBACK') && !rows.some((r) => String(r.stage) === 'trigger')
    && (ev.usageSources || { live: [] }).live.length === 0,
    { usageSources: ev.usageSources, codes: rows.map((r) => r.code) });
}

const total = results.length;
const pass = results.filter((x) => x.ok).length;
const evDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-61f5');
fs.mkdirSync(evDir, { recursive: true });
const evFile = path.join(evDir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${total - pass === 0 ? 'green' : 'red'}.json`);
fs.writeFileSync(evFile, JSON.stringify({ task: 'T-20261118-002151-61f5', at: new Date().toISOString(), total, pass, red: total - pass, results }, null, 2) + '\n', 'utf8');
console.log(`\nFA0E_USAGE_LIVE_${total - pass === 0 ? 'OK' : 'RED'} ${JSON.stringify({ total, pass, red: total - pass })}`);
console.log(`证据：${evFile}`);
