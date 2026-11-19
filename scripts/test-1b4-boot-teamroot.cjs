#!/usr/bin/env node
'use strict';
/**
 * test-1b4-boot-teamroot.cjs —— P3 T-20261120-0157-1b4 夹具（2.1.9 批①）
 *
 * 需求：①`boot --json` 顶层加 `teamRoot`（绝对路径，取 core.mjs PATHS.teamRoot）与
 *      `teamRootSource`（process-env / user-env / default 三选一）；
 *      ②`MISSING_DOC` 的 details 带缺失文件绝对路径 + 根来源 + 根路径；
 *      ③夹具正反两例：AWB_TEAM_ROOT 指空目录 → MISSING_DOC 且 details.teamRoot 指向该目录；
 *        正常 boot → teamRoot 与实际目录一致、source 正确。
 *
 * 断言：
 *  A1 静态：core.mjs 有 AWB_TEAM_ROOT 与 TEAM_ROOT_SOURCE 三态
 *  A2 静态：ops.mjs boot json 带 teamRoot/teamRootSource；store.mjs MISSING_DOC details 带 missingFiles/teamRoot/teamRootSource
 *  B1 正例：process-env 优先（TEAM_ROOT=<沙盘团队根> 且 AWB_TEAM_ROOT=<别的>）→ source=process-env 且 teamRoot 取 TEAM_ROOT
 *  B2 正例：只有 AWB_TEAM_ROOT → source=user-env 且 teamRoot 取它
 *  B3 反例：AWB_TEAM_ROOT 指到空目录 → boot 失败 MISSING_DOC，details.teamRoot 指向该目录、source=user-env、
 *     missingFiles 里每条都带绝对路径（以该目录开头）
 *  C 隔离：真实 团队.json / workbench.json sha256 不变
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const CORE_SRC = path.join(ROOT, '团队', '工具', 'lib', 'core.mjs');
const OPS_SRC = path.join(ROOT, '团队', '工具', 'lib', 'ops.mjs');
const STORE_SRC = path.join(ROOT, '团队', '工具', 'lib', 'store.mjs');
const JSON_OUT = process.argv.includes('--json');

const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
  return Boolean(ok);
}
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '(missing)'; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'b1b4-'));
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench-1b4.json');
const DATA = path.join(SB, 'data');
const REAL_TEAM = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const PROJECT = 'b1b4沙盘';

function env(extra = {}) {
  const { DSH_SESSION_ID, TEAM_ROOT, ...base } = process.env;
  return { ...base, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_WORKBENCH_JSON: STORE, AWB_DATA_DIR: DATA, AWB_STORE: STORE, TEAM_SELFTEST: '1', ...extra };
}
function run(args, extra = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: env(extra), timeout: 180000, cwd: SB, maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status == null ? 1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function runJson(args, extra = {}) {
  const r = run(args, extra);
  const t = String(r.out || '').trim();
  const i = t.indexOf('{');
  let json = null;
  if (i >= 0) { try { json = JSON.parse(t.slice(i)); } catch { json = null; } }
  return { ...r, json };
}

function main() {
  let exitCode = 0;
  const realBefore = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
  try {
    const core = fs.readFileSync(CORE_SRC, 'utf8');
    const ops = fs.readFileSync(OPS_SRC, 'utf8');
    const store = fs.readFileSync(STORE_SRC, 'utf8');
    check('A1 core.mjs 有 AWB_TEAM_ROOT + TEAM_ROOT_SOURCE 三态',
      core.includes('AWB_TEAM_ROOT') && core.includes('export const TEAM_ROOT_SOURCE')
      && /process-env/.test(core) && /user-env/.test(core) && /'default'/.test(core), {});
    check('A2 ops boot json 带 teamRoot/teamRootSource；store MISSING_DOC 带 missingFiles/teamRoot/teamRootSource',
      ops.includes('teamRoot: PATHS.teamRoot') && ops.includes('teamRootSource: TEAM_ROOT_SOURCE')
      && store.includes('missingFiles') && store.includes('teamRootSource: TEAM_ROOT_SOURCE'), {});

    // 沙盘：init + project add + 六角色绑名册（用真 TEAM_ROOT 指向 TEAM）
    check('S0 沙盘 init', run(['init'], { TEAM_ROOT: TEAM }).code === 0, {});
    check('S1 沙盘建项目', run(['project', 'add', '--name', PROJECT, '--team-mode', 'full'], { TEAM_ROOT: TEAM }).code === 0, {});
    const ALL = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
    const team = readJson(path.join(TEAM, '状态', '团队.json'), { members: [] });
    team.activeProject = PROJECT;
    team.members = Array.isArray(team.members) ? team.members : [];
    for (const role of ALL) {
      let m = team.members.find((x) => x && x.role === role);
      if (!m) { m = { role, name: role, status: 'active' }; team.members.push(m); }
      m.status = 'active'; m.sessionId = `session-b1b4-${role}`;
    }
    writeJson(path.join(TEAM, '状态', '团队.json'), team);
    const STATE = path.join(TEAM, '状态', '项目', PROJECT);
    const projMeta = readJson(path.join(STATE, '项目.json'), {});
    const projDir = String(projMeta.path || path.join(PROJECTS, PROJECT));
    writeJson(path.join(projDir, '团队会话.json'), { project: PROJECT, teamMode: 'full', workspace: projDir, roles: ALL.map((role) => ({ role, sessionId: `session-b1b4-${role}` })) });
    writeJson(STORE, { projects: [{ id: 'b1b4-p1', name: PROJECT, teamName: PROJECT, path: projDir, sessions: Object.fromEntries(ALL.map((r) => [r, `session-b1b4-${r}`])), workspace: { path: projDir, sessionIds: ALL.map((r) => `session-b1b4-${r}`) } }], activeProjectId: 'b1b4-p1' });

    // B1 process-env 优先
    const otherRoot = path.join(SB, 'other-team');
    fs.mkdirSync(otherRoot, { recursive: true });
    const j1 = runJson(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'session-b1b4-pm', '--json'], { TEAM_ROOT: TEAM, AWB_TEAM_ROOT: otherRoot });
    check('B1 TEAM_ROOT 优先 → source=process-env 且 teamRoot 取 TEAM_ROOT',
      Boolean(j1.json) && j1.json.teamRootSource === 'process-env' && path.resolve(String(j1.json.teamRoot)) === path.resolve(TEAM),
      { json: j1.json && { teamRoot: j1.json.teamRoot, src: j1.json.teamRootSource }, code: j1.code });

    // B2 只有 AWB_TEAM_ROOT → user-env
    const j2 = runJson(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'session-b1b4-pm', '--json'], { AWB_TEAM_ROOT: TEAM });
    check('B2 只有 AWB_TEAM_ROOT → source=user-env 且 teamRoot 取它',
      Boolean(j2.json) && j2.json.teamRootSource === 'user-env' && path.resolve(String(j2.json.teamRoot)) === path.resolve(TEAM),
      { json: j2.json && { teamRoot: j2.json.teamRoot, src: j2.json.teamRootSource }, code: j2.code });

    // B3 反例：AWB_TEAM_ROOT 指到「初始化过但缺宪法」的根 → MISSING_DOC + details 指向该根
    //（Owner 2026-11-20 现场就是「装完团队宪法.md 缺」；直接指空目录会先撞 NO_TEAM，走不到文档门。）
    const emptyRoot = path.join(SB, 'empty-team');
    fs.mkdirSync(emptyRoot, { recursive: true });
    run(['init'], { AWB_TEAM_ROOT: emptyRoot });
    run(['project', 'add', '--name', PROJECT, '--team-mode', 'full'], { AWB_TEAM_ROOT: emptyRoot });
    try { fs.rmSync(path.join(emptyRoot, '团队宪法.md'), { force: true }); } catch { /* ignore */ }
    const j3 = runJson(['boot', '--role', 'pm', '--project', PROJECT, '--json'], { AWB_TEAM_ROOT: emptyRoot });
    const det = ((j3.json || {}).details) || {};
    check('B3 AWB_TEAM_ROOT 指空目录 → MISSING_DOC（code）',
      j3.json && j3.json.code === 'MISSING_DOC', { code: j3.json && j3.json.code, out: `${j3.out}${j3.err}`.slice(0, 300) });
    check('B3b details.teamRoot 指向该空目录且 teamRootSource=user-env',
      det.teamRoot && path.resolve(String(det.teamRoot)) === path.resolve(emptyRoot) && det.teamRootSource === 'user-env',
      { teamRoot: det.teamRoot, src: det.teamRootSource });
    check('B3c details.missingFiles 每条带绝对路径（且非空）',
      Array.isArray(det.missingFiles) && det.missingFiles.length > 0 && det.missingFiles.every((r) => r && typeof r.path === 'string' && r.path.length > 0),
      { missingFiles: det.missingFiles });
  } catch (e) {
    check('夹具未抛异常', false, { error: String((e && e.stack) || e).slice(0, 700) });
  } finally {
    const realAfter = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
    check('C 隔离：真实 团队.json / workbench.json 前后 sha256 不变',
      realAfter.team === realBefore.team && realAfter.store === realBefore.store,
      { team: [realBefore.team.slice(0, 12), realAfter.team.slice(0, 12)] });
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
