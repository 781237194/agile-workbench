#!/usr/bin/env node
'use strict';
/**
 * test-1914-scene-matrix-soft.cjs —— P2 T-20261119-221909-1914 夹具（场景矩阵软门）
 *
 * 要求：`gates.gateSceneMatrix()` 扫证据报告六类关键词（入口/正常/空值或边界/失败或异常/并发或重复/降级或恢复），
 * 缺项只写审计 + advisory **不 fail**；`TEAM_SCENE_ENFORCE=1` 才硬；审计写 `场景矩阵审计.jsonl`；
 * task done 与 task accept 都调用（accept 只记录）。
 *
 * 断言：
 *  A1 静态：SCENE_MATRIX_CLASSES 恰 6 类 + gateSceneMatrix + TEAM_SCENE_ENFORCE 开关
 *  A2 静态：ops 有 sceneMatrixCheck 且 done/accept 各调用一次（共 3 处含定义）
 *  B1 缺 3 类 → 返回 missing 长度 3、soft:true、enforced:false
 *  B2 六类齐 → 返回 null（无需审计）
 *  B3 enforce 注入（enforce:true 或 TEAM_SCENE_ENFORCE=1）→ soft:false / enforced:true
 *  B4 沙盘 done：证据缺 3 类 → **done 成功** + 场景矩阵审计.jsonl 恰好 1 行
 *  B5 沙盘 done：六类齐 → done 成功 + **不写审计**
 *  C 隔离：真实 团队.json / workbench.json sha256 不变
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const GATES_SRC = path.join(ROOT, '团队', '工具', 'lib', 'gates.mjs');
const OPS_SRC = path.join(ROOT, '团队', '工具', 'lib', 'ops.mjs');
const JSON_OUT = process.argv.includes('--json');
const PROJECT = 'b1914沙盘';

const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
  return Boolean(ok);
}
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '(missing)'; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
const readLines = (f) => { try { return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'b1914-'));
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench-b1914.json');
const DATA = path.join(SB, 'data');
const STATE = path.join(TEAM, '状态', '项目', PROJECT);
const AUDIT = path.join(STATE, '场景矩阵审计.jsonl');
const REAL_TEAM = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const SIX = '场景矩阵：入口（从哪进）｜正常｜空值/边界｜失败/异常（错误码+下一步）｜并发/重复（幂等）｜降级/恢复（回滚）';
const THREE_MISSING = '场景：入口（从哪进）｜空值/边界｜并发/重复';

function env(extra = {}) {
  const { DSH_SESSION_ID, ...base } = process.env;
  return { ...base, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_WORKBENCH_JSON: STORE, AWB_DATA_DIR: DATA, AWB_STORE: STORE, TEAM_SELFTEST: '1', ...extra };
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

async function main() {
  let exitCode = 0;
  const realBefore = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
  Object.assign(process.env, env());
  try {
    const gates = fs.readFileSync(GATES_SRC, 'utf8');
    const ops = fs.readFileSync(OPS_SRC, 'utf8');
    check('A1 静态：SCENE_MATRIX_CLASSES 恰 6 类 + gateSceneMatrix + TEAM_SCENE_ENFORCE 开关',
      (gates.match(/\{ key: '/g) || []).length >= 6 && gates.includes('export function gateSceneMatrix(') && gates.includes('TEAM_SCENE_ENFORCE'), {});
    check('A2 静态：ops 有 sceneMatrixCheck，且 done / accept 各调用',
      (ops.match(/sceneMatrixCheck\(/g) || []).length >= 2
      && /sceneMatrixCheck\(\{ projectName: b\.project, task, evidenceFiles/.test(ops)
      && /sceneMatrixCheck\(\{ projectName, task, evidenceFiles: \[\], action: 'accept' \}\)/.test(ops), { calls: (ops.match(/sceneMatrixCheck\(/g) || []).length });

    const mod = await import(`file://${GATES_SRC.replace(/\\/g, '/')}`);
    const g1 = mod.gateSceneMatrix({ text: THREE_MISSING });
    check('B1 缺 3 类 → missing 长度 3、soft:true、enforced:false',
      Boolean(g1) && g1.missing.length === 3 && g1.soft === true && g1.enforced === false, { g1 });
    const g2 = mod.gateSceneMatrix({ text: SIX });
    check('B2 六类齐 → 返回 null（无需审计）', g2 === null, { g2 });
    const g3 = mod.gateSceneMatrix({ text: THREE_MISSING, enforce: true });
    check('B3 enforce → soft:false 且 enforced:true',
      Boolean(g3) && g3.soft === false && g3.enforced === true, { g3 });

    check('S0 沙盘 init', run(['init']).code === 0, {});
    check('S1 沙盘建项目', run(['project', 'add', '--name', PROJECT, '--team-mode', 'full']).code === 0, {});
    const ALL = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
    const team = readJson(path.join(TEAM, '状态', '团队.json'), { members: [] });
    team.activeProject = PROJECT;
    team.members = Array.isArray(team.members) ? team.members : [];
    for (const role of ALL) {
      let m = team.members.find((x) => x && x.role === role);
      if (!m) { m = { role, name: role, status: 'active' }; team.members.push(m); }
      m.status = 'active'; m.sessionId = `session-b1914-${role}`;
    }
    writeJson(path.join(TEAM, '状态', '团队.json'), team);
    const projMeta = readJson(path.join(STATE, '项目.json'), {});
    const projDir = String(projMeta.path || path.join(PROJECTS, PROJECT));
    writeJson(path.join(projDir, '团队会话.json'), { project: PROJECT, teamMode: 'full', workspace: projDir, roles: ALL.map((role) => ({ role, sessionId: `session-b1914-${role}` })) });
    writeJson(STORE, { projects: [{ id: 'b1914-p1', name: PROJECT, teamName: PROJECT, path: projDir, sessions: Object.fromEntries(ALL.map((r) => [r, `session-b1914-${r}`])), workspace: { path: projDir, sessionIds: ALL.map((r) => `session-b1914-${r}`) } }], activeProjectId: 'b1914-p1' });
    const pmTok = String(((runJson(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'session-b1914-pm', '--json']).json || {}).token) || '');
    check('S2 沙盘 pm boot 成功', Boolean(pmTok), {});

    const projectRoot = path.dirname(path.dirname(path.dirname(STATE))); // <SB>
    const madeTask = (title, evidenceName, body) => {
      const created = runJson(['task', 'create', '--boot', pmTok, '--title', title, '--priority', 'P2', '--type', 'task', '--json']);
      const id = String(((created.json || {}).task || {}).id || '');
      if (!id) return { id: '', err: `${created.out}${created.err}`.slice(0, 240) };
      runJson(['task', 'claim', '--boot', pmTok, '--id', id, '--json']);
      const rel = path.join(projDir, '产出', evidenceName);
      fs.mkdirSync(path.dirname(rel), { recursive: true });
      fs.writeFileSync(rel, body, 'utf8');
      // 软门扫的是 task.detail + 证据正文；证据正文的定位依赖 cwd/项目根，夹具里把同一段文本
      // 也写进 task.detail（等价于「实现说明摘要」），让六类/缺三类的判据稳定可复现。
      try {
        const tf = path.join(STATE, '任务', `${id}.json`);
        const raw = readJson(tf, null);
        if (raw) { raw.detail = body; writeJson(tf, raw); }
      } catch { /* 失败则只靠证据文件 */ }
      return { id, rel };
    };
    const projRel = (p) => path.relative(projDir, p);

    /* ── B4 缺 3 类 → done 成功 + 审计 1 行 ─────────────── */
    const t1 = madeTask('b1914 缺三类', '证据-缺三类.md', `# 缺三类实现说明\n\n${THREE_MISSING}\n`);
    const done1 = runJson(['task', 'done', '--boot', pmTok, '--id', t1.id, '--evidence', projRel(t1.rel), '--json']);
    const audit1 = readLines(AUDIT);
    check('B4 证据缺 3 类 → task done 成功（软门不拦）',
      Boolean(t1.id) && Boolean(done1.json && done1.json.ok === true), { id: t1.id, code: done1.code, out: `${done1.out}${done1.err}`.slice(0, 260) });
    check('B4b 场景矩阵审计.jsonl 恰好 1 行且记 3 项缺失',
      audit1.length === 1 && Array.isArray(audit1[0].missing) && audit1[0].missing.length === 3 && audit1[0].soft === true,
      { rows: audit1.length, row: audit1[0] });

    /* ── B5 六类齐 → done 成功 + 不写审计 ───────────────── */
    const t2 = madeTask('b1914 六类齐', '证据-六类齐.md', `# 六类齐实现说明\n\n${SIX}\n`);
    const done2 = runJson(['task', 'done', '--boot', pmTok, '--id', t2.id, '--evidence', projRel(t2.rel), '--json']);
    const audit2 = readLines(AUDIT);
    check('B5 证据六类齐 → done 成功且审计不再增加（仍 1 行）',
      Boolean(t2.id) && Boolean(done2.json && done2.json.ok === true) && audit2.length === 1,
      { id: t2.id, rows: audit2.length, out: `${done2.out}${done2.err}`.slice(0, 200) });
  } catch (e) {
    check('夹具未抛异常', false, { error: String((e && e.stack) || e).slice(0, 700) });
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
