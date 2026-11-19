#!/usr/bin/env node
'use strict';
/**
 * test-568a-archive-dual-ledger.cjs —— P3 B-20261119-205806-568a 夹具（归档双账一致）
 *
 * 缺陷：`archiveSession`（含 auto 路径）只写归档记录文件 + 清理账（`归档清理.jsonl`），
 * **不写主账 `会话归档.jsonl`** → 「归档发生过」在主账看不见（f32f 事故排查时就踩过：清理账有行、主账缺行）。
 *
 * 要求（派单）：任何 archiveSession 必须同时写两账，两行字段可互相对应（archiveId+sessionId+at）；
 * 只有「旧会话→新会话」的 rotate 才写 nextSessionId/rotatedAt，auto 归档写 null 且 source=auto；
 * 审计写失败显式报错、不许只写一份。
 *
 * 断言：
 *  A 静态：`writeArchiveDualLedger` + `appendJsonlStrict` 存在；archiveSession 里调用它；写失败抛 AUDIT_WRITE_FAILED
 *  B1 auto 归档 → 会话归档.jsonl **+1 行**、归档清理.jsonl **+1 行**
 *  B2 两行 archiveId / sessionId / at 完全一致
 *  B3 主账 source='auto'、nextSessionId=null、rotatedAt=null
 *  B4 手工归档旧会话 → 主账 source='manual'、nextSessionId=null（非 rotate 不写 next）
 *  C 隔离：真实 团队.json / workbench.json sha256 不变
 *
 * 用法：node scripts/test-568a-archive-dual-ledger.cjs [--json]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const ARCHIVE_SRC = path.join(ROOT, '团队', '工具', 'lib', 'session-archive.mjs');
const JSON_OUT = process.argv.includes('--json');
const PROJECT = 'b568a沙盘';

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

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'b568a-'));
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench-b568a.json');
const DATA = path.join(SB, 'data');
const STATE = path.join(TEAM, '状态', '项目', PROJECT);
const LEDGER = path.join(STATE, '会话归档.jsonl');
const CLEANUP = path.join(STATE, '归档清理.jsonl');
const REAL_TEAM = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');

function env() {
  const { DSH_SESSION_ID, ...base } = process.env;
  return { ...base, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_WORKBENCH_JSON: STORE, AWB_DATA_DIR: DATA, AWB_STORE: STORE, TEAM_SELFTEST: '1', TEAM_ARCHIVE_STUB: '0' };
}
function run(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: env(), timeout: 180000, cwd: SB, maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status == null ? 1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

async function main() {
  let exitCode = 0;
  const realBefore = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
  Object.assign(process.env, env());
  try {
    const src = fs.readFileSync(ARCHIVE_SRC, 'utf8');
    check('A1 静态：appendJsonlStrict（写失败抛 AUDIT_WRITE_FAILED）+ writeArchiveDualLedger 存在',
      /function appendJsonlStrict\(/.test(src) && /AUDIT_WRITE_FAILED/.test(src) && /export function writeArchiveDualLedger\(/.test(src), {});
    check('A2 静态：archiveSession 在 clearArchivedRoleState 之后调用 writeArchiveDualLedger',
      (() => {
        const fnStart = src.indexOf('export function archiveSession(');
        const fnEnd = src.indexOf('export function confirmArchive(', fnStart);
        const body = src.slice(fnStart, fnEnd > 0 ? fnEnd : fnStart + 9000);
        const iClear = body.indexOf('clearArchivedRoleState(projectName, role, sessionId, record.id');
        const iLedger = body.indexOf('writeArchiveDualLedger(projectName, {');
        return iClear > 0 && iLedger > iClear;
      })(), {});

    check('S0 沙盘 init', run(['init']).code === 0, {});
    check('S1 沙盘建项目', run(['project', 'add', '--name', PROJECT, '--team-mode', 'full']).code === 0, {});
    const ALL = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
    const team = readJson(path.join(TEAM, '状态', '团队.json'), { members: [] });
    team.activeProject = PROJECT;
    team.members = Array.isArray(team.members) ? team.members : [];
    for (const role of ALL) {
      let m = team.members.find((x) => x && x.role === role);
      if (!m) { m = { role, name: role, status: 'active' }; team.members.push(m); }
      m.status = 'active'; m.sessionId = `session-b568a-${role}`;
    }
    writeJson(path.join(TEAM, '状态', '团队.json'), team);
    const projMeta = readJson(path.join(STATE, '项目.json'), {});
    const projDir = String(projMeta.path || path.join(PROJECTS, PROJECT));
    writeJson(path.join(projDir, '团队会话.json'), { project: PROJECT, teamMode: 'full', workspace: projDir, roles: ALL.map((role) => ({ role, sessionId: `session-b568a-${role}` })) });
    writeJson(STORE, { projects: [{ id: 'b568a-p1', name: PROJECT, teamName: PROJECT, path: projDir, sessions: Object.fromEntries(ALL.map((r) => [r, `session-b568a-${r}`])), workspace: { path: projDir, sessionIds: ALL.map((r) => `session-b568a-${r}`) } }], activeProjectId: 'b568a-p1' });

    const mod = await import(`file://${ARCHIVE_SRC.replace(/\\/g, '/')}`);

    /* ── B1/B2/B3 auto 归档 ─────────────────────────────────── */
    const before = { ledger: readLines(LEDGER).length, cleanup: readLines(CLEANUP).length };
    let err1 = null;
    let rec1 = null;
    try {
      rec1 = mod.archiveSession({
        projectName: PROJECT, role: 'analyst', reason: 'b568a 夹具 auto', auto: true, operator: 'system',
        skipTranscript: true, sessionId: 'session-b568a-analyst-OLD',
      });
    } catch (e) { err1 = e; }
    check('B0 auto 归档旧会话成功（不撞 f32f 当前会话守卫）', Boolean(rec1) && !err1, { code: err1 && err1.code, msg: err1 && String(err1.message).slice(0, 200) });
    const ledger = readLines(LEDGER);
    const cleanup = readLines(CLEANUP);
    check('B1 两账各 +1 行（会话归档.jsonl 与 归档清理.jsonl）',
      ledger.length === before.ledger + 1 && cleanup.length === before.cleanup + 1,
      { before, after: { ledger: ledger.length, cleanup: cleanup.length } });
    const L = ledger[ledger.length - 1] || {};
    const C = cleanup[cleanup.length - 1] || {};
    check('B2 两行 archiveId / sessionId / at 完全一致',
      L.archiveId && L.archiveId === C.archiveId && L.sessionId === C.sessionId && L.at === C.at,
      { ledger: { archiveId: L.archiveId, sessionId: L.sessionId, at: L.at }, cleanup: { archiveId: C.archiveId, sessionId: C.sessionId, at: C.at } });
    check("B3 auto 归档：主账 source='auto'、nextSessionId=null、rotatedAt=null",
      L.source === 'auto' && L.nextSessionId === null && L.rotatedAt === null,
      { source: L.source, nextSessionId: L.nextSessionId, rotatedAt: L.rotatedAt });

    /* ── B4 手工归档旧会话 ─────────────────────────────────── */
    let rec2 = null;
    try {
      rec2 = mod.archiveSession({
        projectName: PROJECT, role: 'tester', reason: 'b568a 夹具手工', auto: false, operator: 'pm',
        skipTranscript: true, sessionId: 'session-b568a-tester-OLD',
      });
    } catch (e) { rec2 = { error: e }; }
    const ledger2 = readLines(LEDGER);
    const L2 = ledger2[ledger2.length - 1] || {};
    check("B4 手工归档：主账 source='manual' 且 nextSessionId=null（非 rotate 不写 next）",
      Boolean(rec2) && !(rec2 && rec2.error) && L2.source === 'manual' && L2.nextSessionId === null,
      { source: L2.source, nextSessionId: L2.nextSessionId, err: rec2 && rec2.error && String(rec2.error.message).slice(0, 160) });
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
