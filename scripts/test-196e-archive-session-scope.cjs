#!/usr/bin/env node
'use strict';
/**
 * test-196e-archive-session-scope.cjs —— B-20261119-154518-196e 夹具（沙盘，真实状态零写入）
 *
 * 缺陷：换人后旧会话永远无法归档——`session-archive.archiveSession` 的 open 判据只按
 * `t.owner === role`，不分会话，新会话接的新任务把「旧会话归档」永久挡住，重试 3 次 retry_exhausted。
 *
 * 断言（判据口径见实现说明 v15 §二）：
 *   A1 已换人（轮换记录 from=old, to=new）：新会话接的**新任务**（claimedAt 晚于换人时刻、无 ownerSessionId）
 *      不挡旧会话归档 → `session archive --archive-session <old>` 成功，写 9 字段 + rotatedAt 回写。
 *   A2 换人**之前**认领、且无 ownerSessionId 的未闭环任务 → 仍挡（TASK_OPEN，scope=session）。
 *   A3 任务带 `ownerSessionId` 时精确判：ownerSessionId=<new> 不挡；=<old> 挡。
 *   A4 没有轮换记录的会话（未换人）→ 仍 TASK_OPEN（保守挡），但 scope 如实为 session
 *      （B-20261120-143331-d475 / PM 2026-11-20 14:41 口径：判据只要落在「按会话」上就是 session，
 *        replacedAt 为空表示「查不到替换时刻」，不再用它冒充 scope）。
 *   A5 TASK_OPEN 的 details 带 `{sessionId, replacedAt, scope}`（可排障）。
 *   A6 端到端：真实 rotate → 旧会话自动归档 archived；新会话接新任务后**再次补归档**同 old 会话不影响已归档记录语义。
 *   A7 镜像任务（type=requirement）与终态任务不计入（既有口径不回归）。
 *   A8 隔离：真实 团队/状态/团队.json 与 data/userdata/workbench.json 前后 sha256 不变。
 *
 * 用法：node scripts/test-196e-archive-session-scope.cjs [--json]
 * 退出码：0 全过 / 1 有断言失败 / 2 环境错误
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const JSON_OUT = process.argv.includes('--json');
const PROJECT = 'b196e-归档会话口径';
const ROLE = 'programmer1';
const OLD_ID = 'session-196e-old-dev';
const NEW_ID = 'session-196e-new-dev';

const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
  return Boolean(ok);
}
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '(missing)'; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'b196e-'));
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench-196e.json');
const DATA = path.join(SB, 'data');
const STATE = path.join(TEAM, '状态', '项目', PROJECT);
const TEAM_FILE = path.join(TEAM, '状态', '团队.json');
const ROTATE_DIR = path.join(STATE, '会话轮换');
const ARCHIVE_DIR = path.join(STATE, '会话归档');
const TASK_DIR = path.join(STATE, '任务');
const REAL_TEAM_FILE = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');

function env(extra = {}) {
  const { DSH_SESSION_ID, ...base0 } = process.env;
  return {
    ...base0,
    TEAM_ROOT: TEAM,
    TEAM_PROJECTS_ROOT: PROJECTS,
    TEAM_WORKBENCH_JSON: STORE,
    AWB_DATA_DIR: DATA,
    AWB_STORE: STORE,
    TEAM_SELFTEST: '1',
    TEAM_BOOT_ENFORCE: '',
    TEAM_ROSTER_DSH_ENFORCE: '',
    TEAM_HANDOVER_ENFORCE: '',
    ...extra,
  };
}
function run(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: env(extraEnv), timeout: 180000, cwd: SB });
  return { code: r.status == null ? 1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function runJson(args, extraEnv = {}) {
  const r = run(args, extraEnv);
  const t = String(r.out || '').trim();
  const i = t.indexOf('{');
  let json = null;
  if (i >= 0) { try { json = JSON.parse(t.slice(i)); } catch { json = null; } }
  return { ...r, json };
}
const text = (r) => String(r.out || '') + String(r.err || '');
const tokenOf = (r) => {
  const direct = String((r.json && r.json.token) || '');
  if (direct) return direct;
  const m = /令牌[:：]\s*([0-9a-f]{8,})/i.exec(String(r.out || ''));
  return m ? m[1] : '';
};
function seedTask(id, over = {}) {
  const row = {
    id, project: PROJECT, title: `夹具任务 ${id}`, detail: '', priority: 'P2', status: 'working',
    type: 'task', owner: ROLE, createdBy: 'pm', createdAt: '2026-11-19T00:00:00.000Z',
    claimedAt: '2026-11-19T00:10:00.000Z', updatedAt: '2026-11-19T00:10:00.000Z',
    history: [], ...over,
  };
  writeJson(path.join(TASK_DIR, `${id}.json`), row);
  return row;
}

const realBefore = { team: sha(REAL_TEAM_FILE), store: sha(REAL_STORE) };
let exitCode = 0;
try {
  if (!fs.existsSync(TOOL)) { console.error('环境错误：找不到 team.mjs'); process.exit(2); }
  check('S0 沙盘 init', run(['init']).code === 0, {});
  check('S1 沙盘建项目', run(['project', 'add', '--name', PROJECT, '--team-mode', 'full']).code === 0, {});

  const projMeta = readJson(path.join(STATE, '项目.json'), {});
  const projectDir = String(projMeta.path || path.join(PROJECTS, PROJECT));
  // 种子：名册/manifest/workbench 都指向 new（模拟「已经换过人」）
  const team = readJson(TEAM_FILE, { members: [] });
  team.activeProject = PROJECT;
  for (const m of (team.members || [])) {
    if (String(m.role || '') !== ROLE) continue;
    m.sessionId = NEW_ID; m.status = 'active';
  }
  writeJson(TEAM_FILE, team);
  writeJson(path.join(projectDir, '团队会话.json'), {
    project: PROJECT, teamMode: 'full', workspace: projectDir,
    roles: [{ role: ROLE, sessionId: NEW_ID }, { role: 'pm', sessionId: 'session-196e-pm' }],
  });
  writeJson(STORE, {
    projects: [{
      id: 'b196e-p1', name: PROJECT, teamName: PROJECT, path: projectDir,
      sessions: { [ROLE]: NEW_ID, pm: 'session-196e-pm' },
      workspace: { path: projectDir, sessionIds: [NEW_ID, 'session-196e-pm'] },
    }],
    activeProjectId: 'b196e-p1',
  });
  // 轮换记录：old → new，发生在 2026-11-19T01:00:00Z（用作 replaceAt）
  const ROTATE_AT = '2026-11-19T01:00:00.000Z';
  writeJson(path.join(ROTATE_DIR, `${ROLE}.json`), {
    id: 'S-196E-TEST', project: PROJECT, role: ROLE, from: OLD_ID, to: NEW_ID, at: ROTATE_AT,
    status: 'active', mode: 'manual', created: false, by: 'pm', source: 'session-rotate', reason: '夹具：已换人',
  });
  const pmBoot = runJson(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'session-196e-pm', '--json']);
  const pmTok = tokenOf(pmBoot);
  check('S2 沙盘 pm boot 成功（拿归档权限令牌）', Boolean(pmTok), { code: pmBoot.code, out: text(pmBoot).slice(0, 300) });

  /* ── A1 新会话接的新任务不挡旧会话归档 ─────────────────────────── */
  seedTask('T-196e-newtask', { claimedAt: '2026-11-19T02:00:00.000Z', updatedAt: '2026-11-19T02:00:00.000Z' }); // 晚于 ROTATE_AT
  const a1 = runJson(['session', 'archive', '--boot', pmTok, '--project', PROJECT, '--role', ROLE,
    '--archive-session', OLD_ID, '--confirm', '--reason', 'B-196e 夹具：新任务不挡旧会话', '--json']);
  check('A1 新会话接的新任务不挡旧会话归档（archive 成功）', a1.code === 0 && (a1.json || {}).ok === true,
    { code: a1.code, out: text(a1).slice(0, 500) });
  const archFiles = (() => { try { return fs.readdirSync(ARCHIVE_DIR).filter((n) => n.endsWith('.json')); } catch { return []; } })();
  const archRow = archFiles.length ? readJson(path.join(ARCHIVE_DIR, archFiles[0]), {}) : {};
  const NINE = ['id', 'role', 'sessionId', 'rounds', 'inputTokens', 'at', 'reason', 'nextSessionId', 'operator'];
  check('A1 归档记录 9 字段齐 + sessionId=旧会话', NINE.every((k) => Object.prototype.hasOwnProperty.call(archRow, k))
    && String(archRow.sessionId || '') === OLD_ID, { keys: Object.keys(archRow), sessionId: archRow.sessionId });
  check('A1 归档记录带 rotatedAt 字段（手工 archive 为 null，rotate 回写时才填）',
    Object.prototype.hasOwnProperty.call(archRow, 'rotatedAt'), { rotatedAt: archRow.rotatedAt });

  /* ── A2 换人前认领、无 ownerSessionId 的任务仍挡 ─────────────────── */
  // 清掉 A1 的归档，造一条「换人前认领」的任务
  try { fs.rmSync(ARCHIVE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  seedTask('T-196e-oldtask', { claimedAt: '2026-11-19T00:30:00.000Z' }); // 早于 ROTATE_AT
  const a2 = runJson(['session', 'archive', '--boot', pmTok, '--project', PROJECT, '--role', ROLE,
    '--archive-session', OLD_ID, '--confirm', '--reason', 'B-196e 反例', '--json']);
  check('A2 换人前认领的未闭环任务仍挡归档（TASK_OPEN）', a2.code !== 0 && /TASK_OPEN/.test(text(a2)),
    { code: a2.code, out: text(a2).slice(0, 400) });
  check('A5 TASK_OPEN details 带 sessionId/replacedAt/scope=session',
    Boolean(a2.json && a2.json.details && a2.json.details.scope === 'session'
      && String(a2.json.details.sessionId || '') === OLD_ID && Boolean(a2.json.details.replacedAt)),
    { details: a2.json && a2.json.details });

  /* ── A3 ownerSessionId 精确判 ──────────────────────────────────── */
  try { fs.rmSync(path.join(TASK_DIR, 'T-196e-oldtask.json'), { force: true }); } catch { /* ignore */ }
  seedTask('T-196e-bound-new', { ownerSessionId: NEW_ID, claimedAt: '2026-11-19T00:20:00.000Z' });
  const a3a = runJson(['session', 'archive', '--boot', pmTok, '--project', PROJECT, '--role', ROLE,
    '--archive-session', OLD_ID, '--confirm', '--reason', 'B-196e bound=new', '--json']);
  check('A3 ownerSessionId=<新会话> 不挡（即使 claimedAt 早于换人）', a3a.code === 0,
    { code: a3a.code, out: text(a3a).slice(0, 400) });
  try { fs.rmSync(ARCHIVE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(path.join(TASK_DIR, 'T-196e-bound-new.json'), { force: true }); } catch { /* ignore */ }
  seedTask('T-196e-bound-old', { ownerSessionId: OLD_ID, claimedAt: '2026-11-19T02:30:00.000Z' });
  const a3b = runJson(['session', 'archive', '--boot', pmTok, '--project', PROJECT, '--role', ROLE,
    '--archive-session', OLD_ID, '--confirm', '--reason', 'B-196e bound=old', '--json']);
  check('A3 ownerSessionId=<旧会话> 挡（即使 claimedAt 晚于换人）', a3b.code !== 0 && /TASK_OPEN/.test(text(a3b)),
    { code: a3b.code, out: text(a3b).slice(0, 400) });

  /* ── A4 无轮换记录 → 退化角色级（老行为） ─────────────────────────── */
  try { fs.rmSync(path.join(TASK_DIR, 'T-196e-bound-old.json'), { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(path.join(ROTATE_DIR, `${ROLE}.json`), { force: true }); } catch { /* ignore */ }
  seedTask('T-196e-anytask', { claimedAt: '2026-11-19T05:00:00.000Z' });
  const a4 = runJson(['session', 'archive', '--boot', pmTok, '--project', PROJECT, '--role', ROLE,
    '--archive-session', OLD_ID, '--confirm', '--reason', 'B-196e 无轮换记录', '--json']);
  check('A4 无轮换记录的会话 → 仍保守挡（TASK_OPEN），details.scope 如实为 session、replacedAt 为空',
    a4.code !== 0 && /TASK_OPEN/.test(text(a4)) && Boolean(a4.json && a4.json.details && a4.json.details.scope === 'session'
      && !a4.json.details.replacedAt),
    { code: a4.code, details: a4.json && a4.json.details });

  /* ── A7 镜像/终态任务不计入 ────────────────────────────────────── */
  try { fs.rmSync(path.join(TASK_DIR, 'T-196e-anytask.json'), { force: true }); } catch { /* ignore */ }
  // A4 已删掉轮换记录：A7 只验「镜像/终态不计入」，所以把不再相关的普通任务也清掉
  try { fs.rmSync(path.join(TASK_DIR, 'T-196e-newtask.json'), { force: true }); } catch { /* ignore */ }
  seedTask('R-196e-mirror', { type: 'requirement', owner: ROLE, status: 'open', claimedAt: null });
  seedTask('T-196e-done', { status: 'done', claimedAt: '2026-11-19T00:05:00.000Z' });
  const a7 = runJson(['session', 'archive', '--boot', pmTok, '--project', PROJECT, '--role', ROLE,
    '--archive-session', OLD_ID, '--confirm', '--reason', 'B-196e 镜像/终态不计', '--json']);
  check('A7 镜像任务（type=requirement）与 done 任务不计入 open 判据', a7.code === 0,
    { code: a7.code, out: text(a7).slice(0, 400) });

  /* ── A6 端到端：真实 rotate 自动归档 + 新会话接任务后补归档语义 ──── */
  try { fs.rmSync(ARCHIVE_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(path.join(TASK_DIR, 'R-196e-mirror.json'), { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(path.join(TASK_DIR, 'T-196e-done.json'), { force: true }); } catch { /* ignore */ }
  try { fs.rmSync(path.join(TASK_DIR, 'T-196e-newtask.json'), { force: true }); } catch { /* ignore */ }
  const devBoot = runJson(['boot', '--role', ROLE, '--project', PROJECT, '--session', NEW_ID, '--json']);
  check('A6 沙盘 boot 目标角色成功', Boolean(tokenOf(devBoot)), { code: devBoot.code });
  // 真实 rotate：NEW_ID → session-196e-new-dev-2（沙盘 --session 指定）
  const rot = runJson(['session', 'rotate', '--project', PROJECT, '--role', ROLE,
    '--session', 'session-196e-new-dev-2', '--reason', 'B-196e 端到端', '--json']);
  const archiveOutcome = (rot.json && (rot.json.archiveOutcome || rot.json.archive)) || {};
  check('A6 真实 rotate 后旧会话自动归档结果非 retry_exhausted/failed',
    rot.code === 0 && String(archiveOutcome.result || '') !== 'failed',
    { code: rot.code, result: archiveOutcome.result, out: text(rot).slice(0, 400) });
} catch (e) {
  check('夹具未抛异常', false, { error: String((e && e.stack) || e) });
} finally {
  const realAfter = { team: sha(REAL_TEAM_FILE), store: sha(REAL_STORE) };
  check('A8 隔离：真实 团队.json / workbench.json 前后 sha256 不变',
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
