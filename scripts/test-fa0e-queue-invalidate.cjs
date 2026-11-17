#!/usr/bin/env node
'use strict';
/**
 * B-20261118-002301-9cff 夹具：夜间入队项在「入队之后被手换」时必须作废，次日 08:05 不再二次换人。
 *
 * 判据：
 *   ① 入队（夜 23:30）→ 次日窗口前手换（00:05）→ 08:05 窗口不再换该角色，审计留 skipped/ALREADY_ROTATED；
 *      同批另一个未手换的入队角色仍按 force→轮次→时间早执行（每拍 1 个）；
 *   ② 手换发生在**入队之前**（21:30）→ 不作废，窗口仍换该角色（防误杀）；
 *   ③ 手换记录来自 `会话轮换.jsonl` 也生效（source 标注）；
 *   ④ 无手换 → 原行为不变（force 先换）；
 *   ⑤ dryRun → 只返回 invalidated 列表，不写 ALREADY_ROTATED 审计。
 *
 * 隔离：TEAM_ROOT/TEAM_PROJECTS_ROOT/TEAM_WORKBENCH_JSON/TEAM_SELFTEST=1 + 唯一 _tmp 沙盘；时间注入。
 * 跑法：node scripts/test-fa0e-queue-invalidate.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const { mkTempSandbox, rmSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));
const ROLE_DIRS = { pm: '项目经理', product: '产品', analyst: '需求分析师', programmer1: '程序员A', programmer2: '程序员B', tester: '测试人员' };
const ROLES = Object.keys(ROLE_DIRS);
const PROJECT = 'fa0e-queue-sandbox';
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
const atLocal = (dayOffset, h, m) => { const d = new Date(); d.setDate(d.getDate() + dayOffset); d.setHours(h, m, 0, 0); return d.getTime(); };
const NIGHT = (() => { const d = new Date(); d.setHours(23, 30, 0, 0); return d.getTime(); })();
const MORNING = (() => { const d = new Date(); d.setDate(d.getDate() + 1); d.setHours(8, 5, 0, 0); return d.getTime(); })();

function makeSandbox(name, { usage, rounds } = {}) {
  const root = mkTempSandbox(`9cff-${name}`);
  const dir = path.join(root, 'sb');
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
  writeJson(path.join(team, '状态', '团队.json'), { version: 1, activeProject: PROJECT, members, config: { messageMaxChars: 4000, autoRotate: { enabled: true, intervalMs: 0, rotateRounds: 8 } } });
  writeJson(path.join(state, '项目.json'), { name: PROJECT, path: projectDir, teamMode: 'full', roleIds: ROLES });
  writeJson(path.join(state, '工作流.json'), { schema: 2, project: PROJECT, round: 1, requirements: {}, boots: {} });
  writeJson(path.join(data, 'userdata', 'workbench.json'), {
    version: 1, activeProjectId: 'p-9cff',
    projects: [{ id: 'p-9cff', name: PROJECT, teamName: PROJECT, path: projectDir, sessions: Object.fromEntries(ROLES.map((r) => [r, `sess-old-${r}`])), workspace: { path: projectDir, sessionIds: ROLES.map((r) => `sess-old-${r}`) } }],
  });
  if (usage) writeJson(path.join(state, '会话用量.json'), usage);
  if (rounds) writeJson(path.join(state, '会话轮次.json'), rounds);
  for (const r of ROLES) fs.mkdirSync(path.join(projectDir, ROLE_DIRS[r], '产出'), { recursive: true });
  return {
    dir, team, state, projectDir, data,
    get audit() { return path.join(state, '自动换人.jsonl'); },
    get rotDir() { return path.join(state, '会话轮换'); },
    get rotJsonl() { return path.join(state, '会话轮换.jsonl'); },
    rows() {
      if (!fs.existsSync(this.audit)) return [];
      return fs.readFileSync(this.audit, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    },
    env: {
      ...process.env,
      TEAM_ROOT: team, TEAM_PROJECTS_ROOT: path.join(team, '状态', '项目'),
      TEAM_WORKBENCH_JSON: path.join(data, 'userdata', 'workbench.json'),
      TEAM_SELFTEST: '1', __AR_PROJECT: PROJECT,
      __MODULE: path.join(ROOT, '团队', '工具', 'lib', 'auto-rotate.mjs'),
    },
    writeRotRecord(role, atMs, by = 'pm') {
      writeJson(path.join(this.rotDir, `${role}.json`), { id: `S-${role}-9cff`, project: PROJECT, role, from: `sess-old-${role}`, to: `session-manual-${role}-1`, at: new Date(Number(atMs)).toISOString(), by, reason: 'manual rotate (fixture)', mode: 'manual', created: false, status: 'active' });
    },
  };
}

function cycle(sb, nowMs, { dryRun = false } = {}) {
  const boot = [
    'const { pathToFileURL } = require("node:url");',
    '(async () => {',
    '  const mod = await import(pathToFileURL(process.env.__MODULE).href);',
    `  const r = await mod.runAutoRotateCycle(process.env.__AR_PROJECT, { now: ${Number(nowMs)}, dryRun: ${dryRun ? 'true' : 'false'}, source: "9cff-check" });`,
    '  console.log("@@9CFF@@" + JSON.stringify(r === undefined ? null : r));',
    '})().catch((e) => console.log("@@9CFF@@" + JSON.stringify({ ok: false, code: "THROW", error: String((e && (e.code || e.message)) || e) })));',
  ].join('\n');
  const env = { ...sb.env, AWB_NOW: fmtAWB(nowMs) };
  const r = spawnSync(process.execPath, ['-e', boot], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env });
  const line = String(r.stdout || '').split(/\r?\n/).find((x) => x.includes('@@9CFF@@'));
  if (!line) return { entryOk: false, error: String(r.stderr || r.stdout || '').slice(0, 400) };
  try { return { entryOk: true, result: JSON.parse(line.split('@@9CFF@@')[1]) }; } catch (e) { return { entryOk: false, error: String(e.message || e) }; }
}

const usageNight = { analyst: { role: 'analyst', sessionId: 'sess-old-analyst', tokens: 520000, at: new Date(NIGHT).toISOString(), source: 'fixture' } };
const roundsNight = { product: { role: 'product', roundsSinceArchive: 30, updatedAt: new Date(NIGHT).toISOString() } };

/* ── ① 入队后手换 → 次日窗口作废（ALREADY_ROTATED），另一个角色仍换 ── */
{
  const sb = makeSandbox('invalidate', { usage: usageNight, rounds: roundsNight });
  const rn = cycle(sb, NIGHT);
  const enq = sb.rows().filter((r) => String(r.code) === 'NIGHT_QUEUED').map((r) => String(r.role)).sort();
  sb.writeRotRecord('analyst', atLocal(1, 0, 5));   // 次日 00:05 手动换 analyst（窗口之前）
  const rm = cycle(sb, MORNING);
  const rows = sb.rows();
  const already = rows.filter((r) => String(r.code) === 'ALREADY_ROTATED');
  const rotates = rows.filter((r) => String(r.stage) === 'rotate' && String(r.result) !== 'fail').map((r) => String(r.role));
  check('Q1 夜 23:30 入队 analyst(force)+product(rounds)', rn.entryOk && enq.join(',') === 'analyst,product', { entryOk: rn.entryOk, error: rn.error, enq, rows: sb.rows().map((r) => `${r.stage}/${r.code}/${r.role}`) });
  check('Q2 入队后（00:05）手换 analyst → 08:05 窗口写 skipped/ALREADY_ROTATED（含 queuedAt/rotatedAt/source）',
    already.length === 1 && String(already[0].role) === 'analyst' && String(already[0].evidence.rotatedSource) === '会话轮换/<角色>.json'
      && String(already[0].evidence.rotatedAt || '').length > 0 && String(already[0].evidence.queuedAt || '').length > 0,
    { already, rows: rows.map((r) => `${r.stage}/${r.code}/${r.role}`) });
  check('Q3 analyst 未被二次换；product 仍按队列执行（本拍 1 个 rotate）',
    rm.entryOk && !rotates.includes('analyst') && rotates.length === 1 && rotates[0] === 'product',
    { entryOk: rm.entryOk, error: rm.error, rotates, result: rm.result });
}

/* ── ② 手换在入队之前但不足 24h（21:30）→ 24h 兜底作废（AC③ 不换两次）；超 24h 才不作废 ── */
{
  const sb = makeSandbox('before-enqueue', { usage: usageNight, rounds: roundsNight });
  sb.writeRotRecord('analyst', atLocal(0, 21, 30));   // 入队（23:30）之前、但距窗口不足 24h
  const rn = cycle(sb, NIGHT);
  const rm = cycle(sb, MORNING);
  const rows = sb.rows();
  const already = rows.filter((r) => String(r.code) === 'ALREADY_ROTATED');
  const rotates = rows.filter((r) => String(r.stage) === 'rotate' && String(r.result) !== 'fail').map((r) => String(r.role));
  check('Q4 手换在入队之前但不足 24h → 24h 兜底作废（reason=within-24h），analyst 不再被换',
    rn.entryOk && rm.entryOk && already.length === 1 && String(already[0].role) === 'analyst'
      && String(already[0].evidence.reason) === 'within-24h' && !rotates.includes('analyst'),
    { entryOk: [rn.entryOk, rm.entryOk], already, rotates, codes: rows.map((r) => r.code) });
}
{
  const sb = makeSandbox('before-enqueue-old', { usage: usageNight, rounds: roundsNight });
  sb.writeRotRecord('analyst', atLocal(-2, 21, 30));   // 入队之前且超过 24h
  const rn = cycle(sb, NIGHT);
  const rm = cycle(sb, MORNING);
  const rows = sb.rows();
  const rotates = rows.filter((r) => String(r.stage) === 'rotate' && String(r.result) !== 'fail').map((r) => String(r.role));
  check('Q4b 手换在入队之前且超过 24h → 不作废：窗口仍换 analyst（force 先），无 ALREADY_ROTATED',
    rn.entryOk && rm.entryOk && rotates[0] === 'analyst' && !rows.some((r) => String(r.code) === 'ALREADY_ROTATED'),
    { entryOk: [rn.entryOk, rm.entryOk], rotates, codes: rows.map((r) => r.code) });
}

/* ── ③ 手换记录来自 会话轮换.jsonl 也生效 ── */
{
  const sb = makeSandbox('jsonl-source', { usage: usageNight, rounds: roundsNight });
  const rn = cycle(sb, NIGHT);
  const at = new Date(atLocal(1, 3, 0)).toISOString();
  fs.mkdirSync(path.dirname(sb.rotJsonl), { recursive: true });
  fs.appendFileSync(sb.rotJsonl, JSON.stringify({ at, project: PROJECT, role: 'analyst', from: 'sess-old-analyst', to: 'session-manual-analyst-j', reason: 'manual-jsonl', by: 'pm', mode: 'manual', created: false }) + '\n', 'utf8');
  const rm = cycle(sb, MORNING);
  const already = sb.rows().filter((r) => String(r.code) === 'ALREADY_ROTATED');
  check('Q5 会话轮换.jsonl 的手换记录同样作废入队项（source 标 会话轮换.jsonl）',
    rn.entryOk && rm.entryOk && already.length === 1 && String(already[0].evidence.rotatedSource) === '会话轮换.jsonl',
    { entryOk: [rn.entryOk, rm.entryOk], already });
}

/* ── ④ 无手换 → 原行为不变（analyst force 先换，每拍 1 个） ── */
{
  const sb = makeSandbox('no-manual', { usage: usageNight, rounds: roundsNight });
  const rn = cycle(sb, NIGHT);
  const rm = cycle(sb, MORNING);
  const rows = sb.rows();
  const rotates = rows.filter((r) => String(r.stage) === 'rotate' && String(r.result) !== 'fail').map((r) => String(r.role));
  check('Q6 未手换 → 窗口仍按 force 优先换 analyst（无 ALREADY_ROTATED）',
    rn.entryOk && rm.entryOk && rotates.length === 1 && rotates[0] === 'analyst' && !rows.some((r) => String(r.code) === 'ALREADY_ROTATED'),
    { entryOk: [rn.entryOk, rm.entryOk], rotates, codes: rows.map((r) => r.code) });
}

/* ── ⑤ dryRun → 只返回 invalidated，不写 ALREADY_ROTATED 审计 ── */
{
  const sb = makeSandbox('dryrun', { usage: usageNight, rounds: roundsNight });
  const rn = cycle(sb, NIGHT);
  sb.writeRotRecord('analyst', atLocal(1, 0, 5));
  const before = sb.rows().length;
  const rd = cycle(sb, MORNING, { dryRun: true });
  const after = sb.rows().length;
  const invalidated = (rd.result && rd.result.invalidated) || [];
  check('Q7 dryRun：返回 invalidated=[analyst]、零写入（审计行数不变）',
    rn.entryOk && rd.entryOk && invalidated.includes('analyst') && after === before,
    { entryOk: [rn.entryOk, rd.entryOk], invalidated, before, after, result: rd.result });
}

const total = results.length;
const pass = results.filter((x) => x.ok).length;
const evDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-9cff');
fs.mkdirSync(evDir, { recursive: true });
const evFile = path.join(evDir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${total - pass === 0 ? 'green' : 'red'}.json`);
fs.writeFileSync(evFile, JSON.stringify({ task: 'B-20261118-002301-9cff', at: new Date().toISOString(), total, pass, red: total - pass, results }, null, 2) + '\n', 'utf8');
console.log(`\n9CFF_${total - pass === 0 ? 'OK' : 'RED'} ${JSON.stringify({ total, pass, red: total - pass })}`);
console.log(`证据：${evFile}`);
