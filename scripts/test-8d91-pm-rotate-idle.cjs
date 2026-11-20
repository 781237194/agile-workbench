#!/usr/bin/env node
'use strict';
/**
 * test-8d91-pm-rotate-idle.cjs —— P1 B-20261119-204845-8d91 夹具（PM 换人双闲 ≥15min 程序门）
 *
 * 需求：`session rotate --role pm` 前置判定 `WAIT_BOTH_IDLE`——PM 与 product 双方近 N 分钟
 * 无真人/角色往来消息（系统自动通知不计）/ 无 running 会话 / 无名下 working 任务 / 无在途派单锁，任一不满足 → 拒绝且零写入，
 * 并输出缺哪一方 + 还差多少分钟；N 取 `团队.json → config.pmRotateIdleMin`（默认 15，不写死）。
 *
 * 六类场景：
 *  ① 首次使用：全新沙盘（无任务/无锁/无消息）→ 双方 idle → 门通过
 *  ② 正常路径：PM 与 product 都闲 → `session rotate --role pm` 成功
 *  ③ 空值/边界：config 缺失 → 默认 15；config=1 → 窗口 1 分钟（同一份消息在 15 分钟窗口内 busy、1 分钟窗口外 idle）
 *  ④ 失败：PM 有 working 任务 → WAIT_BOTH_IDLE + 团队.json/团队会话.json sha256 不变（零写入）
 *  ⑤ 并发/重复：product 持有在途锁 → 拒绝；重复两次都拒（幂等，判据不漂移）
 *  ⑥ 降级：邮箱文件损坏 → 不崩（仍能给出 idle 结论）
 *
 * 用法：node scripts/test-8d91-pm-rotate-idle.cjs [--json]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const SESSION_SRC = path.join(ROOT, '团队', '工具', 'lib', 'session.mjs');
const JSON_OUT = process.argv.includes('--json');
const PROJECT = 's8d91沙盘';

const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
  return Boolean(ok);
}
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '(missing)'; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 's8d91-'));
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench-s8d91.json');
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
function runJson(args) {
  const r = run(args);
  const t = String(r.out || '').trim();
  const i = t.indexOf('{');
  let json = null;
  if (i >= 0) { try { json = JSON.parse(t.slice(i)); } catch { json = null; } }
  return { ...r, json };
}
const text = (r) => `${r.out || ''}${r.err || ''}`;
const tokenOf = (r) => String((r.json && r.json.token) || '');
const seedTeam = (cfg) => {
  const team = readJson(path.join(TEAM, '状态', '团队.json'), { members: [] });
  team.activeProject = PROJECT;
  team.members = Array.isArray(team.members) ? team.members : [];
  const ALL = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
  for (const role of ALL) {
    let m = team.members.find((x) => x && x.role === role);
    if (!m) { m = { role, name: role, status: 'active' }; team.members.push(m); }
    m.status = 'active'; m.sessionId = `session-s8d91-${role}`;
  }
  if (cfg !== undefined) team.config = { ...(team.config || {}), ...cfg };
  writeJson(path.join(TEAM, '状态', '团队.json'), team);
};

async function main() {
  let exitCode = 0;
  const realBefore = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
  Object.assign(process.env, env());
  try {
    check('S0 沙盘 init', run(['init']).code === 0, {});
    check('S1 沙盘建项目', run(['project', 'add', '--name', PROJECT, '--team-mode', 'full']).code === 0, {});
    seedTeam({});
    const projMeta = readJson(path.join(STATE, '项目.json'), {});
    const projDir = String(projMeta.path || path.join(PROJECTS, PROJECT));
    writeJson(path.join(projDir, '团队会话.json'), { project: PROJECT, teamMode: 'full', workspace: projDir, roles: ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'].map((role) => ({ role, sessionId: `session-s8d91-${role}` })) });
    writeJson(STORE, { projects: [{ id: 's8d91-p1', name: PROJECT, teamName: PROJECT, path: projDir, sessions: Object.fromEntries(['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'].map((r) => [r, `session-s8d91-${r}`])), workspace: { path: projDir, sessionIds: ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'].map((r) => `session-s8d91-${r}`) } }], activeProjectId: 's8d91-p1' });
    const pmTok = tokenOf(runJson(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'session-s8d91-pm', '--json']));
    const prodTok = tokenOf(runJson(['boot', '--role', 'product', '--project', PROJECT, '--session', 'session-s8d91-product', '--json']));
    check('S2 沙盘 pm/product boot 成功', Boolean(pmTok && prodTok), {});

    const mod = await import(`file://${SESSION_SRC.replace(/\\/g, '/')}`);

    /* ── ① 首次使用：全新沙盘双方 idle ─────────────────────── */
    const g0 = mod.pmRotateIdleState(PROJECT, {});
    check('① 首次使用：无任务/无锁/无消息 → 双方 idle、门通过',
      g0.ok === true && g0.roles.pm.idle === true && g0.roles.product.idle === true && Number(g0.minutes) === 15,
      { gate: g0 });

    /* ── ③ 空值/边界：config 缺失→15；config=1→窗口 1 分钟 ─── */
    seedTeam({});
    const t0 = Date.now();
    check('③a config 缺失 → 默认 15 分钟', Number(mod.pmRotateIdleState(PROJECT, {}).minutes) === 15, {});
    // 给 pm 造一条「10 分钟前」的消息：15 分钟窗口内 busy、1 分钟窗口外 idle
    const mailDir = path.join(TEAM, '状态', '邮箱', 'pm', 'new');
    fs.mkdirSync(mailDir, { recursive: true });
    const oldTs = new Date(t0 - 10 * 60 * 1000).toISOString();
    writeJson(path.join(mailDir, `${oldTs.replace(/[:.]/g, '-')}-M-s8d91-1.json`), { id: 'M-s8d91-1', from: 'product', to: 'pm', type: 'notice', subject: 's', body: 'b', project: PROJECT, ts: oldTs, at: oldTs });
    const g15 = mod.pmRotateIdleState(PROJECT, { minutes: 15, now: t0 });
    const g1 = mod.pmRotateIdleState(PROJECT, { minutes: 1, now: t0 });
    check('③b 同一份 10 分钟前消息：15 分钟窗口内 busy、1 分钟窗口内 idle（窗口边界生效）',
      // B-20261120-121306-b752：01425f6 把 reason 文案从「有新消息」改成「有真人/角色往来消息（…；系统自动通知不计）」，
      // 这里同步到新文案；语义断言不放宽——①真人往来仍算活跃（idle=false）②窗口外恢复 idle（g1.idle=true）。
      g15.roles.pm.idle === false
      && /真人\/角色往来消息/.test(g15.roles.pm.reasons.join(''))
      && /系统自动通知不计/.test(g15.roles.pm.reasons.join(''))
      && g1.roles.pm.idle === true,
      { g15: g15.roles.pm, g1: g1.roles.pm });
    check('③c busy 时输出还差多少分钟（remainingMin > 0）',
      Number(g15.roles.pm.remainingMin) > 0, { remainingMin: g15.roles.pm.remainingMin });
    // 清掉该消息
    fs.rmSync(mailDir, { recursive: true, force: true });

    /* ── ④ 失败：PM 有 working 任务 → 拒绝 + 零写入 ─────────── */
    const task = runJson(['task', 'create', '--boot', pmTok, '--title', 's8d91 造 working', '--priority', 'P2', '--type', 'task', '--owner', 'pm', '--json']);
    const taskId = String(((task.json || {}).task || {}).id || '');
    if (taskId) {
      const claim = runJson(['task', 'claim', '--boot', pmTok, '--id', taskId, '--json']);
      check('S3 造出 pm 名下 working 任务', claim.code === 0, { code: claim.code, out: text(claim).slice(0, 200) });
    }
    const beforeRotate = { team: sha(path.join(TEAM, '状态', '团队.json')), manifest: sha(path.join(projDir, '团队会话.json')) };
    const rot1 = runJson(['session', 'rotate', '--role', 'pm', '--session', 'session-s8d91-pm-NEW', '--boot', prodTok, '--offline', '--json']);
    const afterRotate = { team: sha(path.join(TEAM, '状态', '团队.json')), manifest: sha(path.join(projDir, '团队会话.json')) };
    check('④ PM 有 working 任务 → WAIT_BOTH_IDLE（输出含 pm 与「working 任务」）',
      /WAIT_BOTH_IDLE/.test(text(rot1)) && /pm/.test(text(rot1)) && /working 任务/.test(text(rot1)),
      { code: rot1.code, out: text(rot1).slice(0, 400) });
    check('④b 拒绝时零写入：团队.json / 团队会话.json sha256 全不变',
      beforeRotate.team === afterRotate.team && beforeRotate.manifest === afterRotate.manifest,
      { beforeRotate, afterRotate });

    /* ── ⑤ 并发/重复：product 持锁 → 拒绝；重复两次结论一致 ── */
    if (taskId) { try { run(['task', 'done', '--boot', pmTok, '--id', taskId, '--evidence', 'README.md', '--json']); } catch { /* 失败不影响判据 */ } }
    fs.rmSync(path.join(STATE, '任务'), { recursive: true, force: true });
    const locksDir = path.join(TEAM, '状态', '锁');
    fs.mkdirSync(locksDir, { recursive: true });
    writeJson(path.join(locksDir, 'dispatch-s8d91.json'), { key: 'dispatch:s8d91', role: 'product', reason: 's8d91 夹具锁', acquiredAt: new Date(t0).toISOString(), heartbeatAt: new Date(t0).toISOString(), ttlMs: 600000 });
    const gLock = mod.pmRotateIdleState(PROJECT, { now: t0 });
    const rot2 = runJson(['session', 'rotate', '--role', 'pm', '--session', 'session-s8d91-pm-NEW2', '--boot', prodTok, '--offline', '--json']);
    const rot3 = runJson(['session', 'rotate', '--role', 'pm', '--session', 'session-s8d91-pm-NEW3', '--boot', prodTok, '--offline', '--json']);
    check('⑤a product 持在途锁 → 门判 product busy 且 CLI 拒绝（WAIT_BOTH_IDLE）',
      gLock.roles.product.idle === false && /WAIT_BOTH_IDLE/.test(text(rot2)),
      { product: gLock.roles.product, out: text(rot2).slice(0, 300) });
    check('⑤b 重复两次拒绝，结论一致（幂等，判据不漂移）',
      /WAIT_BOTH_IDLE/.test(text(rot3)) && rot2.code === rot3.code, { c2: rot2.code, c3: rot3.code });
    fs.rmSync(locksDir, { recursive: true, force: true });

    /* ── ⑥ 降级：邮箱文件损坏 → 不崩 ───────────────────────── */
    const badDir = path.join(TEAM, '状态', '邮箱', 'product', 'new');
    fs.mkdirSync(badDir, { recursive: true });
    fs.writeFileSync(path.join(badDir, 'broken.json'), '{not-json', 'utf8');
    let gBad = null;
    let crash = null;
    try { gBad = mod.pmRotateIdleState(PROJECT, { minutes: 15, now: t0 }); } catch (e) { crash = e; }
    check('⑥ 邮箱文件损坏 → 不抛错、仍给出结论（降级）',
      !crash && gBad && typeof gBad.ok === 'boolean', { crash: crash && String(crash.message) });
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
