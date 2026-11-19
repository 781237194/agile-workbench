#!/usr/bin/env node
'use strict';
/**
 * test-f32f-archive-current-guard.cjs —— P1 B-20261119-203542-f32f 夹具
 *
 * 事故（2026-11-19 20:33:29）：`task done` 轮次达 10 → `ops.mjs` 调 `archiveSession({auto:true})` **未传 sessionId**
 * → 默认归档 `currentSessionOf(role)` = **当前在岗会话** → `clearArchivedRoleState(archivedIsCurrent=true)`
 * 清空名册/manifest/workbench 三处绑定 → `session check` 5/6 → **全体 send 被 SESSION_MAP_INCONSISTENT 拦**
 * （PM 20:33–20:34 三次派单失败）。证据：`归档清理.jsonl` 20:33:29Z 行 `archivedSessionId==currentSessionId`、
 * `clearsRoleBinding:true`、`steps.roster.changed:true`；而 `会话归档.jsonl` **缺**该行（另见实现说明「可观测缺口」）。
 *
 * 断言：
 *   A. 接线（静态）
 *     A1 session-archive.mjs 新增 replacementSessionId 参数
 *     A2 守卫错误码 ARCHIVE_CURRENT_NEEDS_REPLACEMENT 存在且含「先 session rotate」下一步
 *     A3 守卫位于「重复归档守卫」之后、清理之前（写盘前）
 *     A4 ops.mjs 自动归档分支新增 archiveBlocked，且 import 了 currentSessionOf
 *   B. 行为（沙盘模块级，真实 archiveSession）
 *     B1 归档当前在岗会话且无替代会话 → 抛 ARCHIVE_CURRENT_NEEDS_REPLACEMENT（不是别的码）
 *     B2 该次失败**零副作用**：团队.json / 团队会话.json / workbench.json 三份 sha256 不变
 *     B3 显式给 replacementSessionId → 不再抛 ARCHIVE_CURRENT_NEEDS_REPLACEMENT
 *     B4 归档「旧会话」（sessionId ≠ 当前）→ 不再抛 ARCHIVE_CURRENT_NEEDS_REPLACEMENT
 *   C. 隔离：真实 团队/状态/团队.json、data/userdata/workbench.json sha256 前后不变
 *
 * 用法：node scripts/test-f32f-archive-current-guard.cjs [--json]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const ARCHIVE_SRC = path.join(ROOT, '团队', '工具', 'lib', 'session-archive.mjs');
const OPS_SRC = path.join(ROOT, '团队', '工具', 'lib', 'ops.mjs');
const JSON_OUT = process.argv.includes('--json');
const PROJECT = 'f32f沙盘';

const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
  return Boolean(ok);
}
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '(missing)'; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'f32f-'));
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench-f32f.json');
const DATA = path.join(SB, 'data');
const STATE = path.join(TEAM, '状态', '项目', PROJECT);
const REAL_TEAM = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');

function env() {
  const { DSH_SESSION_ID, ...base } = process.env;
  return { ...base, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_WORKBENCH_JSON: STORE, AWB_DATA_DIR: DATA, AWB_STORE: STORE, TEAM_SELFTEST: '1' };
}
function run(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: env(), timeout: 180000, cwd: SB, maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status == null ? 1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

async function main() {
  let exitCode = 0;
  const realBefore = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
  // 模块级要读沙盘：先设父进程 env（PATHS 在 import 时解析）
  Object.assign(process.env, env());
  try {
    const arch = fs.readFileSync(ARCHIVE_SRC, 'utf8');
    const ops = fs.readFileSync(OPS_SRC, 'utf8');

    /* ── A 接线 ─────────────────────────────────────────────── */
    check('A1 session-archive.mjs 新增 replacementSessionId 参数', /replacementSessionId = ''/.test(arch), {});
    check('A2 守卫码 ARCHIVE_CURRENT_NEEDS_REPLACEMENT 存在且带「先 session rotate」下一步',
      arch.includes("ARCHIVE_CURRENT_NEEDS_REPLACEMENT") && /session rotate --role \$\{role\}/.test(arch), {});
    {
      const dupIdx = arch.indexOf('pendingUnrotated && !force');
      const guardIdx = arch.indexOf('ARCHIVE_CURRENT_NEEDS_REPLACEMENT');
      const clearFnIdx = arch.indexOf('function clearArchivedRoleState');
      check('A3 守卫位于重复归档守卫之后、clearArchivedRoleState 之前（写盘前零副作用）',
        dupIdx > 0 && guardIdx > dupIdx && (clearFnIdx < 0 || guardIdx < clearFnIdx), { dupIdx, guardIdx, clearFnIdx });
    }
    check('A4 ops.mjs 自动归档分支新增 archiveBlocked 且 import 了 currentSessionOf',
      ops.includes('archiveBlocked') && /ROUNDS_MAX, currentSessionOf \} from '\.\/session-archive\.mjs'/.test(ops), {});

    /* ── 沙盘 ───────────────────────────────────────────────── */
    check('S0 沙盘 init', run(['init']).code === 0, {});
    check('S1 沙盘建项目', run(['project', 'add', '--name', PROJECT, '--team-mode', 'full']).code === 0, {});
    const ALL = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
    const team = readJson(path.join(TEAM, '状态', '团队.json'), { members: [] });
    team.activeProject = PROJECT;
    team.members = Array.isArray(team.members) ? team.members : [];
    for (const role of ALL) {
      let m = team.members.find((x) => x && x.role === role);
      if (!m) { m = { role, name: role, status: 'active' }; team.members.push(m); }
      m.status = 'active'; m.sessionId = `session-f32f-${role}`;
    }
    writeJson(path.join(TEAM, '状态', '团队.json'), team);
    const projMeta = readJson(path.join(STATE, '项目.json'), {});
    const projDir = String(projMeta.path || path.join(PROJECTS, PROJECT));
    writeJson(path.join(projDir, '团队会话.json'), { project: PROJECT, teamMode: 'full', workspace: projDir, roles: ALL.map((role) => ({ role, sessionId: `session-f32f-${role}` })) });
    writeJson(STORE, { projects: [{ id: 'f32f-p1', name: PROJECT, teamName: PROJECT, path: projDir, sessions: Object.fromEntries(ALL.map((r) => [r, `session-f32f-${r}`])), workspace: { path: projDir, sessionIds: ALL.map((r) => `session-f32f-${r}`) } }], activeProjectId: 'f32f-p1' });

    const mod = await import(`file://${ARCHIVE_SRC.replace(/\\/g, '/')}`);
    const teamFile = path.join(TEAM, '状态', '团队.json');
    const manifestFile = path.join(projDir, '团队会话.json');
    const wbFile = STORE;
    const snap = () => ({ team: sha(teamFile), manifest: sha(manifestFile), wb: sha(wbFile) });
    const before = snap();

    /* ── B1/B2 归档当前会话且无替代 → 拒绝且零副作用 ─────────── */
    let err1 = null;
    try { mod.archiveSession({ projectName: PROJECT, role: 'programmer1', reason: 'f32f 夹具：归档当前会话', auto: true, operator: 'system', skipTranscript: true }); } catch (e) { err1 = e; }
    const after1 = snap();
    check('B1 归档当前在岗会话且未给替代会话 → ARCHIVE_CURRENT_NEEDS_REPLACEMENT',
      Boolean(err1) && String(err1.code) === 'ARCHIVE_CURRENT_NEEDS_REPLACEMENT',
      { code: err1 && err1.code, message: String((err1 && err1.message) || '').slice(0, 240) });
    check('B2 该次拒绝零副作用：团队.json / 团队会话.json / workbench.json 三份 sha256 全不变',
      JSON.stringify(before) === JSON.stringify(after1), { before, after: after1 });

    /* ── B3 显式替代会话 → 不再抛该码 ─────────────────────────── */
    let err3 = null;
    try {
      mod.archiveSession({
        projectName: PROJECT, role: 'programmer2', reason: 'f32f 夹具：带替代会话', auto: true, operator: 'system',
        skipTranscript: true, replacementSessionId: 'session-f32f-replacement',
      });
    } catch (e) { err3 = e; }
    check('B3 显式 replacementSessionId → 不再抛 ARCHIVE_CURRENT_NEEDS_REPLACEMENT',
      !err3 || String(err3.code) !== 'ARCHIVE_CURRENT_NEEDS_REPLACEMENT',
      { code: err3 && err3.code, message: String((err3 && err3.message) || '').slice(0, 200) });

    /* ── B4 归档旧会话（≠ 当前）→ 不抛该码 ───────────────────── */
    let err4 = null;
    try {
      mod.archiveSession({
        projectName: PROJECT, role: 'analyst', reason: 'f32f 夹具：归档旧会话', auto: true, operator: 'system',
        skipTranscript: true, sessionId: 'session-f32f-analyst-OLD',
      });
    } catch (e) { err4 = e; }
    check('B4 归档旧会话（sessionId ≠ 当前）→ 不抛 ARCHIVE_CURRENT_NEEDS_REPLACEMENT',
      !err4 || String(err4.code) !== 'ARCHIVE_CURRENT_NEEDS_REPLACEMENT',
      { code: err4 && err4.code, message: String((err4 && err4.message) || '').slice(0, 200) });
  } catch (e) {
    check('夹具未抛异常', false, { error: String((e && e.stack) || e) });
  } finally {
    const realAfter = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
    check('C 隔离：真实 团队.json / workbench.json 前后 sha256 不变',
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
}
main();
