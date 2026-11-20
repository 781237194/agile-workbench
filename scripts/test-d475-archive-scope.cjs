#!/usr/bin/env node
'use strict';
/**
 * test-d475-archive-scope.cjs — B-20261120-143331-d475（P1）夹具 4：旧会话归档的「按会话」判据
 *
 * PM 口径修正 2026-11-20 14:41 §二（实测缺陷：任务 ownerSessionId 已 stamp 成新会话，归档旧会话仍报 TASK_OPEN/scope=role）：
 *   ①任务归属**先按 task.ownerSessionId 精确比**；非空且 ≠ 被归档会话 → 不阻；
 *   ②ownerSessionId 为空才按 claimedAt||createdAt 与轮换时刻比；判不了才保守算该会话；
 *   ③details.scope 如实为 session，replacedAt 取「会话轮换/<角色>.json 的 from→at」。
 * 另：`session archive` 以前只认 --archive-session，写 --session 会被静默忽略并退回当前会话 —— 本夹具同时验证别名。
 *
 * 用法：node scripts/test-d475-archive-scope.cjs [--json]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const JSON_OUT = process.argv.includes('--json');
const PROJECT = 's475arch沙盘';
const ROLES = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
const HANDOVER = [
  '## 【在途任务】无在途任务。',
  '## 【未闭环事项】无。',
  '## 【最近决策】无。',
  '## 【建议下一步】先 boot。',
  '## 【遗留问题与坑】无已知坑。',
].join('\n');

const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
  return Boolean(ok);
}
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '(missing)'; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
const jsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 's475arch-'));
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench.json');
const DATA = path.join(SB, 'data');
const STATE = path.join(TEAM, '状态', '项目', PROJECT);
const REAL_TEAM = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');

function env(extra = {}) {
  const { DSH_SESSION_ID, AWB_TEAM_ROOT, ...base } = process.env;
  return {
    ...base, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_WORKBENCH_JSON: STORE,
    AWB_DATA_DIR: DATA, AWB_STORE: STORE, TEAM_SELFTEST: '1', TEAM_ROTATE_HANDOVER_TEXT: HANDOVER, ...extra,
  };
}
function run(args, extra = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: env(extra), cwd: SB, timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
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
const text = (r) => `${r.out || ''}${r.err || ''}`;
const codeOf = (r) => String((r.json && r.json.code) || '');
const tokenOf = (r) => String(((r.json || {}).token) || '');

async function main() {
  let exitCode = 0;
  const realBefore = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
  let projDir = '';
  try {
    Object.assign(process.env, env());
    check('S0 沙盘 init', run(['init']).code === 0, {});
    check('S1 沙盘建项目', run(['project', 'add', '--name', PROJECT, '--team-mode', 'full']).code === 0, {});
    const team = readJson(path.join(TEAM, '状态', '团队.json'), { members: [] });
    team.activeProject = PROJECT;
    team.members = ROLES.map((role) => ({ role, name: role, status: 'active', sessionId: `session-ar-${role}` }));
    writeJson(path.join(TEAM, '状态', '团队.json'), team);
    const at = new Date().toISOString();
    writeJson(path.join(TEAM, '状态', '会话排队.json'), { schema: 2, at, project: PROJECT, staleMs: 120000, degraded: null, roles: [{ role: 'pm', sessionId: 'session-ar-pm', running: false }, { role: 'product', sessionId: 'session-ar-product', running: false }] });
    const projMeta = readJson(path.join(STATE, '项目.json'), {});
    projDir = String(projMeta.path || path.join(PROJECTS, PROJECT));
    writeJson(path.join(projDir, '团队会话.json'), { project: PROJECT, teamMode: 'full', workspace: projDir, roles: ROLES.map((role) => ({ role, sessionId: `session-ar-${role}` })) });
    writeJson(STORE, {
      projects: [{
        id: 'ar-p1', name: PROJECT, teamName: PROJECT, path: projDir,
        sessions: Object.fromEntries(ROLES.map((r) => [r, `session-ar-${r}`])),
        workspace: { path: projDir, sessionIds: ROLES.map((r) => `session-ar-${r}`) },
      }], activeProjectId: 'ar-p1',
    });
    const pmTok0 = tokenOf(runJson(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'session-ar-pm', '--json']));
    const prodTok = tokenOf(runJson(['boot', '--role', 'product', '--project', PROJECT, '--session', 'session-ar-product', '--json']));
    check('S2 沙盘 pm/product boot 成功', Boolean(pmTok0 && prodTok), {});

    // 换人前造一条 pm 在办任务（rotate 会把它 stamp 成新会话 —— 正是 0ec1 形态）
    const created = runJson(['task', 'create', '--boot', pmTok0, '--title', '换人前余留任务（0ec1 形态）', '--priority', 'P2', '--type', 'task', '--owner', 'pm', '--json']);
    const taskA = String(((created.json || {}).task || {}).id || '');
    check('A1 造出 pm 在办任务', created.code === 0 && Boolean(taskA), { code: created.code, out: text(created).slice(0, 200) });

    // 轮换 1：product 带 Owner 授权 pm → new1（会把 taskA 的 ownerSessionId stamp 成 new1）
    const rot1 = runJson(['session', 'rotate', '--role', 'pm', '--session', 'session-ar-pm-new1', '--owner-authorized', '--reason', 'Owner 授权：归档判据夹具 1', '--boot', prodTok, '--offline', '--json'], { TEAM_BOOT_ENFORCE: '1' });
    const rot1At = String((rot1.json || {}).at || '');
    const taskAfter1 = readJson(path.join(STATE, '任务', `${taskA}.json`), {});
    check('A2 轮换 1 成功，且 taskA 的 ownerSessionId 已被 stamp 成新会话（0ec1 形态）',
      rot1.code === 0 && String(taskAfter1.ownerSessionId) === 'session-ar-pm-new1', { code: rot1.code, ownerSessionId: taskAfter1.ownerSessionId, out: text(rot1).slice(0, 300) });

    // 归档旧会话 0：用 **--session** 写法（PM/Owner 自然写法；旧实现会被静默忽略）
    const pmTok1 = tokenOf(runJson(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'session-ar-pm-new1', '--json']));
    const beforeArchive = { team: sha(path.join(TEAM, '状态', '团队.json')) };
    const arch1 = runJson(['session', 'archive', '--role', 'pm', '--session', 'session-ar-pm', '--confirm', '--boot', pmTok1, '--project', PROJECT, '--json']);
    check('A3 归档「已被 stamp 的旧会话」成功：--session 别名生效且按 ownerSessionId 精确比（不再 TASK_OPEN）',
      arch1.code === 0 && !/TASK_OPEN/.test(text(arch1)), { code: arch1.code, out: text(arch1).slice(0, 600) });
    const archRow1 = readJson(path.join(STATE, '会话归档.jsonl'), null);
    const archList1 = jsonl(path.join(STATE, '会话归档.jsonl'));
    check('A4 归档记录指向的是被归档的旧会话（session-ar-pm），不是当前在岗会话',
      archList1.some((r) => r && String(r.sessionId || '') === 'session-ar-pm'),
      { rows: archList1.map((r) => ({ id: r.id, role: r.role, sessionId: r.sessionId })) });

    // 轮换 2：new1 → new2（force：窗口期内），供「无 ownerSessionId 的遗留任务」场景使用
    const rot2 = runJson(['session', 'rotate', '--role', 'pm', '--session', 'session-ar-pm-new2', '--owner-authorized', '--reason', 'Owner 授权：归档判据夹具 2', '--boot', prodTok, '--offline', '--force', '--json'], { TEAM_BOOT_ENFORCE: '1' });
    const rot2At = String((rot2.json || {}).at || '');
    check('A5 轮换 2 成功（new1 → new2，--force 过窗口期）', rot2.code === 0 && Boolean(rot2At), { code: rot2.code, out: text(rot2).slice(0, 300) });

    // 造「无 ownerSessionId 且 createdAt 早于轮换 2」的遗留任务（模拟历史任务；rotate 只 stamp 当时存在的任务）
    const legacy = runJson(['task', 'create', '--boot', prodTok, '--title', '遗留无会话绑定任务', '--priority', 'P2', '--type', 'task', '--owner', 'pm', '--json']);
    const taskB = String(((legacy.json || {}).task || {}).id || '');
    const taskBFile = path.join(STATE, '任务', `${taskB}.json`);
    const taskBRow = readJson(taskBFile, null);
    if (taskBRow) {
      delete taskBRow.ownerSessionId;
      taskBRow.createdAt = new Date(Date.parse(rot2At) - 60000).toISOString();
      taskBRow.claimedAt = null;
      writeJson(taskBFile, taskBRow);
    }
    const taskBCheck = readJson(taskBFile, {});
    check('A6 造出「无 ownerSessionId + createdAt 早于轮换 2」的遗留在办任务',
      Boolean(taskB) && !taskBCheck.ownerSessionId && String(taskBCheck.createdAt) < rot2At,
      { id: taskB, ownerSessionId: taskBCheck.ownerSessionId, createdAt: taskBCheck.createdAt, rot2At });

    // 归档 new1：必须被它挡住，且 details.scope 如实为 session、replacedAt = 轮换 2 的时刻
    const pmTok2 = tokenOf(runJson(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'session-ar-pm-new2', '--json']));
    const arch2 = runJson(['session', 'archive', '--role', 'pm', '--session', 'session-ar-pm-new1', '--confirm', '--boot', pmTok2, '--project', PROJECT, '--json']);
    const d2 = (arch2.json || {}).details || {};
    check('A7 遗留任务（无绑定、早于轮换）→ 旧会话 new1 归档被阻 TASK_OPEN', codeOf(arch2) === 'TASK_OPEN', { code: codeOf(arch2), details: d2 });

    check('A8 details.scope 如实为 session（不再误报 role）', String(d2.scope || '') === 'session', { details: d2 });
    check('A9 details.replacedAt = 轮换 2 的时刻（会话轮换/pm.json 的 from→at）',
      Boolean(rot2At) && String(d2.replacedAt || '') === rot2At, { replacedAt: d2.replacedAt, rot2At });
    check('A10 details.sessionId = 被归档的旧会话（new1），tasks 只列遗留任务', String(d2.sessionId || '') === 'session-ar-pm-new1' && Array.isArray(d2.tasks) && d2.tasks.includes(taskB), { details: d2 });

    // 归档失败必须零写入：不得新增 new1 的归档记录
    const archRowsAfter = jsonl(path.join(STATE, '会话归档.jsonl'));
    check('A11 归档被阻时零写入：会话归档.jsonl 里没有 new1 的记录',
      !archRowsAfter.some((r) => r && String(r.sessionId || '') === 'session-ar-pm-new1'),
      { rows: archRowsAfter.map((r) => r.sessionId) });
    void beforeArchive;
    void archRow1;
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
      console.log(`\n${ROWS.length - failed.length}/${ROWS.length} PASS${failed.length ? ' · ' + failed.length + ' FAIL' : ''}`);
      if (failed.length) console.log('失败项：' + failed.map((r) => r.name).join(' | '));
    } else {
      console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed.length, failed: failed.map((r) => r.name), rows: ROWS }, null, 2));
    }
    if (failed.length) exitCode = 1;
  }
  process.exit(exitCode);
}
main();
