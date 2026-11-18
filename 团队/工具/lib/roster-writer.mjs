/**
 * roster-writer.mjs —— 团队名册（团队/状态/团队.json → members[].sessionId）**唯一写入口**
 *
 * 缺陷：B-20261118-083150-4b2f（P1，fa0e 补丁 A；产品复核 产品/产出/评估复核-三需求联动-20261118.md §五 步骤 1+2）
 * 背景：2026-11-18 08:02 旧代码副本的 auto-rotate 生成假 id `session-auto-tester-*` 并写进名册——
 *       根因是名册 sessionId 有多套写者（session rotate / auto-rotate / launch / migrate），
 *       auto-rotate 自建第二套 rotate（无令牌/不查交接/不写 BQ/workbench 裸写）。
 *
 * 本模块的职责（与 AC-W1～W7 一一对应）：
 *   · 唯一赋值点：`setMemberSession()` / `applyMemberSession()` / `pushRosterMember()`（W1 静态清单只命中本文件）
 *   · 写前校验：目标 sessionId 格式 + 形态自检（LEGACY_SESSION_ID_REFUSED）+ DSH 存在性（SESSION_NOT_IN_DSH），
 *     任何一项不过 → **零写入**（W2/W7）
 *   · 写四处映射：团队.json / 项目 团队会话.json / workbench.projects[].sessions /
 *     workbench.projects[].workspace.sessionIds（workbench 走 json-atomic，W4）
 *   · 记账：会话轮换/<角色>.json + S-*.json + 会话轮换.jsonl + 名册变更.jsonl（统一格式，W3）
 *   · 待启动队列（BQ）+ 广播其余 active 成员重 boot + 事件 session_rotate（两路径同判，W3）
 *   · withLock('_team') 防并发丢更新（W8；与 mutateTeam 同一把锁）
 *   · 写后 60 秒存在性兜底校验（不成立 → 审计 1 行 + 告警 PM，W7）
 *
 * 沙盘/自检口径：
 *   · `TEAM_SELFTEST=1` 时默认**跳过 DSH 存在性校验**（与 TEAM_LESSONS_ENFORCE / TEAM_BOOT_ENFORCE 同一套路）；
 *   · 要验门禁本体用 `TEAM_ROSTER_DSH_ENFORCE=1`（配合 `TEAM_DSH_FAKE` 注入会话列表）；
 *   · `offline`（session rotate --offline）同样跳过存在性校验，但**不跳过**格式/旧副本自检。
 *
 * 交接判据（W5）：`checkRotateHandover()` 是唯一判据——内部固定调用 session.mjs 的 `validateHandover()`
 * （4 个必填【】小节 + 遗留坑红标），不再各写一套（旧 auto-rotate 只看 mtime / 邮件关键词）。
 */
import fs from 'node:fs';
import path from 'node:path';
import {
  PATHS, fail, nowIso, ensureDir, appendLine, appendEvent, withLock, stamp, readJson, exists, sha256,
} from './core.mjs';
import { loadTeam, saveTeam, projectStatePaths, loadProject, projectTeamMode, getMember, sendMessage } from './store.mjs';
import { ROLE_NAMES } from './roles.mjs';
import { writeJsonAtomic, updateJsonAtomic } from './json-atomic.mjs';

/* ── 常量 ────────────────────────────────────────────────────────────── */

/** 合法会话 id 形态（与 session.mjs 的 --session 校验同一口径）。 */
export const SESSION_ID_RE = /^session-[A-Za-z0-9-]+$/;
/** 旧副本形态指纹（08:02 事故）：`session-auto-<角色>-<base36>`。 */
export const LEGACY_SESSION_RE = /^session-auto-[a-z0-9]+(?:[-_.][a-z0-9]+)*$/i;
/** 统一记账文件名（项目状态目录）。 */
export const ROSTER_AUDIT_NAME = '名册变更.jsonl';
/** 写后 60 秒存在性兜底待校验清单。 */
export const POST_CHECK_NAME = '名册变更待校验.json';
export const POST_CHECK_TTL_MS = 60000;
/** 与 mutateTeam 同一把锁：名册所有写入串行化（W8）。 */
export const ROSTER_LOCK_KEY = '_team';
export const ROSTER_LOCK_OPTS = { role: 'system', sessionId: 'system', ttlMs: 15000, waitMs: 5000, reason: 'roster write（唯一写入口）' };
/** source 枚举：谁发起这次换人（写进统一记账，便于「这一行是谁改的」一 Command 回答）。 */
export const ROSTER_SOURCES = ['session-rotate', 'auto-rotate', 'launch', 'rebind', 'add-member', 'system'];

/* ── 路径 ────────────────────────────────────────────────────────────── */

export function workbenchFilePath() {
  const env = String(process.env.TEAM_WORKBENCH_JSON || '').trim();
  if (env) return path.resolve(env);
  return path.join(PATHS.workspace, 'data', 'userdata', 'workbench.json');
}
export function rosterAuditPath(projectName) {
  return path.join(projectStatePaths(projectName).dir, ROSTER_AUDIT_NAME);
}
export function rotateLedgerPath(projectName) {
  return path.join(projectStatePaths(projectName).dir, '会话轮换.jsonl');
}
export function rotateRecordDir(projectName) {
  return path.join(projectStatePaths(projectName).dir, '会话轮换');
}
export function postCheckPath(projectName) {
  return path.join(projectStatePaths(projectName).dir, POST_CHECK_NAME);
}

function readRaw(file) {
  try { return fs.readFileSync(file); } catch { return null; }
}
function shaOfRaw(buf) { return buf ? sha256(buf) : ''; }
function shaOfFile(file) { return shaOfRaw(readRaw(file)); }
function appendJsonl(file, row) {
  ensureDir(path.dirname(file));
  appendLine(file, JSON.stringify(row));
}
function isoOf(now) {
  if (now === null || now === undefined || now === '') return nowIso();
  const ms = typeof now === 'number' ? now : Date.parse(String(now));
  return Number.isFinite(ms) ? new Date(ms).toISOString() : nowIso();
}

/* ── 纯函数：唯一的成员赋值/入册入口（W1 静态清单据此断言） ─────────────── */

/** 给一个 member 对象写 sessionId（可带额外字段）。**唯一的 `.sessionId =` 落点**。 */
export function applyMemberSession(member, sessionId, extra = {}) {
  if (!member || typeof member !== 'object') return null;
  member.sessionId = String(sessionId === undefined || sessionId === null ? '' : sessionId);
  for (const [k, v] of Object.entries(extra || {})) {
    if (v !== undefined) member[k] = v;
  }
  return member;
}

/** 名册里按角色写 sessionId（launch / ops / rotate 的统一入口）；角色不存在返回 null。 */
export function setMemberSession(team, role, sessionId, extra = {}) {
  const member = getMember(team, role) || (Array.isArray(team && team.members)
    ? team.members.find((m) => m && String(m.role) === String(role)) || null
    : null);
  if (!member) return null;
  return applyMemberSession(member, sessionId, extra);
}

/** 新增成员（唯一 `members.push` 落点）。 */
export function pushRosterMember(team, member) {
  if (!team || !member) return null;
  if (!Array.isArray(team.members)) team.members = [];
  team.members.push(member);
  return member;
}

/* ── 写前校验（格式 / 旧副本 / DSH 存在性） ────────────────────────────── */

export function isLegacySessionId(sessionId) {
  return LEGACY_SESSION_RE.test(String(sessionId || '').trim());
}

/** 告警 PM：名册写入被拒（不静默）。失败不阻断原始错误抛出。 */
function alertPm({ projectName, role, reason, code, sessionId, source, by }) {
  try {
    sendMessage({
      from: 'system', to: 'pm', project: projectName || '', type: 'escalation',
      subject: `名册写入被拒：${code}`,
      body: `名册写入被拒（${code}）：角色 ${role || '-'}，目标会话 ${sessionId || '(空)'}，来源 ${source || '-'}，操作人 ${by || '-'}。\n`
        + `原因：${String(reason || '').slice(0, 200)}\n名册未改动（零写入）。请确认是否旧代码副本仍在运行（08:02 事故形态）。`,
    });
  } catch { /* PM 不可达不阻断拒绝本身 */ }
}

/**
 * 统一拒绝路径（P2-4 复核）：所有「写前不过」都走这里——写 1 行审计 + 告警 PM，再抛错。
 * 零写入由调用点保证（本函数只记账/告警，不碰名册）。
 */
function refuse({ projectName, role, sessionId = '', source = 'system', by = 'system', code, why, details = {} }) {
  try {
    appendJsonl(rosterAuditPath(projectName), {
      at: nowIso(), event: 'roster_write_refused', result: 'refused', code,
      project: projectName, role, from: '', to: String(sessionId || ''), by, source,
      reason: String(why || '').slice(0, 200), rosterSha256: shaOfFile(PATHS.team),
    });
  } catch { /* 记账失败不掩盖拒绝 */ }
  alertPm({ projectName, role, reason: why, code, sessionId, source, by });
  fail(code, `名册写入被拒（${code}）：${why}；名册未改动（零写入）`, { role, project: projectName, source, sessionId, ...details });
}

/**
 * 写前形态自检（W7）：目标 id 形如 `session-auto-*`，或进程里仍注入着 `__AR_NEW_SESSION` → 拒写。
 * 零写入；写 1 行统一记账（result=refused）+ 告警 PM。
 */
export function assertSessionWritable({ projectName, role, sessionId, source = 'system', by = 'system' }) {
  const id = String(sessionId || '').trim();
  if (!id) {
    refuse({ projectName, role, sessionId: id, source, by, code: 'BAD_SESSION', why: '目标会话 id 为空：名册不写空会话' });
  }
  if (!SESSION_ID_RE.test(id)) {
    refuse({ projectName, role, sessionId: id, source, by, code: 'BAD_SESSION', why: `会话 id 格式不对：${id}（要求 ${SESSION_ID_RE}）` });
  }
  const injected = String(process.env.__AR_NEW_SESSION || '').trim();
  const refusals = [];
  if (isLegacySessionId(id)) refusals.push({ code: 'LEGACY_SESSION_ID_REFUSED', why: `目标会话 id 命中旧副本形态（session-auto-*）：${id}` });
  if (injected) refusals.push({ code: 'LEGACY_SESSION_ID_REFUSED', why: `检测到 __AR_NEW_SESSION 注入（旧副本入口，已废）：${injected}` });
  if (!refusals.length) return id;
  const hit = refusals[0];
  refuse({
    projectName, role, sessionId: id, source, by, code: hit.code,
    why: refusals.map((r) => r.why).join('；'),
    details: { reasons: refusals, hint: '08:02 事故形态：旧代码副本仍在生成 session-auto-* 假会话 id。不要重新启用 __AR_NEW_SESSION。' },
  });
  return id;
}

/**
 * DSH 存在性校验（W2）：目标会话必须在 DSH 会话列表里。
 * 返回 { checked, exists, code, why }；不存在时由调用方决定拒绝。
 */
export async function checkSessionInDsh({ sessionId, engineUrl = '', dshList = null }) {
  const id = String(sessionId || '');
  const sandbox = String(process.env.TEAM_SELFTEST || '') === '1';
  const enforce = String(process.env.TEAM_ROSTER_DSH_ENFORCE || '') === '1';
  if (sandbox && !enforce) return { checked: false, exempt: 'sandbox', exists: null, code: '', why: '沙盘（TEAM_SELFTEST=1）跳过 DSH 存在性校验；门禁本体用 TEAM_ROSTER_DSH_ENFORCE=1' };
  let list = dshList;
  if (!list) {
    try {
      const mod = await import('./session.mjs');
      list = await mod.listDshSessions(engineUrl);
    } catch (e) {
      return { checked: true, exists: null, code: 'DSH_UNAVAILABLE', why: String((e && e.message) || e) };
    }
  }
  if (!list || list.ok !== true) {
    return { checked: true, exists: null, code: 'DSH_UNAVAILABLE', why: String((list && list.why) || 'DSH 不可达') };
  }
  const existsNow = (list.items || []).some((it) => String((it && it.sessionId) || '') === id);
  return { checked: true, exists: existsNow, code: existsNow ? '' : 'SESSION_NOT_IN_DSH', why: '', total: (list.items || []).length };
}

/* ── 写四处映射（锁内，W4/W8） ─────────────────────────────────────────── */

/**
 * 项目目录解析：登记过的项目取 项目.json 的 path（唯一真相）；
 * 未登记项目（沙盘夹具常见，没有 项目.json）**不猜目录**——返回 registered:false，
 * 调用方跳过「团队会话.json」这一处派生映射（写审计注明），其余三处照写。
 */
function resolveProjectDir(projectName) {
  try {
    const project = loadProject(projectName);
    return { dir: project.path, registered: true, mode: projectTeamMode(project), source: '项目.json', why: '' };
  } catch (e) {
    return { dir: '', registered: false, mode: 'full', source: 'unregistered', why: String((e && e.message) || e) };
  }
}

/**
 * 写前快照（用于失败回滚）：记录四处映射文件的原文，供 restoreRosterSnapshot 判断「是否我们写的」。
 * 必须在 applyRosterMaps 之前调用，这样即使 applyRosterMaps 中途抛错也能回滚已写出的那几份。
 */
export function captureRosterSnapshot({ projectName }) {
  const info = resolveProjectDir(projectName);
  const manifestFile = info.dir ? path.join(info.dir, '团队会话.json') : null;
  const workbenchFile = workbenchFilePath();
  return {
    projectPath: info.dir,
    projectRegistered: info.registered,
    projectMode: info.mode,
    projectWhy: info.why,
    manifestFile,
    manifestSkipped: manifestFile ? '' : `项目未登记（无 项目.json）：团队会话.json 未写（${info.why}）`,
    workbenchFile,
    before: { team: readRaw(PATHS.team), manifest: manifestFile ? readRaw(manifestFile) : null, workbench: readRaw(workbenchFile) },
    // P1-3 复核：回滚必须知道「这些文件原来就不存在」——否则中途失败会留下只含 1 行的 团队会话.json（check 0/N）。
    existed: {
      team: exists(PATHS.team),
      manifest: manifestFile ? exists(manifestFile) : false,
      workbench: exists(workbenchFile),
    },
    wrote: {},
    oldId: '',
    teamRoster: '',
  };
}

/**
 * 写四处映射（锁内，W4/W8）。
 * 返回快照（含 oldId/teamRoster/wrote；`into` 传入同一对象时，中途抛错也保留已写出的 sha）。
 */
export function applyRosterMaps({
  projectName, role, newSessionId, oldId = '', memberExtra = {}, failAt = '', now = null, manifestExtra = {},
}, into = null) {
  const name = String(projectName || '');
  const roleId = String(role || '');
  if (!name) fail('NO_PROJECT', '需要项目名');
  if (!roleId) fail('BAD_ROLE', '需要角色');
  const project = resolveProjectDir(name);
  const wbFile = workbenchFilePath();
  const manifestFile = project.dir ? path.join(project.dir, '团队会话.json') : null;
  const snap = into || {
    projectPath: project.dir, projectRegistered: project.registered, projectMode: project.mode,
    manifestFile, workbenchFile: wbFile,
    manifestSkipped: manifestFile ? '' : `项目未登记（无 项目.json）：团队会话.json 未写（${project.why}）`,
    before: { team: readRaw(PATHS.team), manifest: manifestFile ? readRaw(manifestFile) : null, workbench: readRaw(wbFile) },
    wrote: {}, oldId: '', teamRoster: '',
  };
  snap.manifestFile = manifestFile;
  snap.workbenchFile = wbFile;
  if (!manifestFile) snap.manifestSkipped = `项目未登记（无 项目.json）：团队会话.json 未写（${project.why}）`;
  if (!snap.before) snap.before = { team: readRaw(PATHS.team), manifest: manifestFile ? readRaw(manifestFile) : null, workbench: readRaw(wbFile) };
  if (!snap.existed) snap.existed = { team: exists(PATHS.team), manifest: manifestFile ? exists(manifestFile) : false, workbench: exists(wbFile) };
  return withLock(ROSTER_LOCK_KEY, { ...ROSTER_LOCK_OPTS, reason: `roster write：${roleId}@${name}` }, () => {
    const team = loadTeam();
    // 团队.json 是全局名册（单一 activeProject 镜像）：非活跃项目不写它，避免污染当前项目映射。
    const activeProject = String(team.activeProject || '') === name;
    let teamRoster = activeProject ? 'updated' : 'skipped（非活跃项目，团队.json 是当前项目镜像）';
    let actualOldId = String(oldId || '');
    if (activeProject) {
      const member = getMember(team, roleId);
      if (!member) fail('BAD_ROLE', `团队名册没有角色：${roleId}`);
      actualOldId = String(member.sessionId || oldId || '');
      // ↓ 唯一的名册赋值点（AC-W1）
      setMemberSession(team, roleId, newSessionId, memberExtra);
      if (failAt === 'afterTeam') fail('ROTATE_INJECTED_FAIL', '注入失败：团队.json 写入前');
      saveTeam(team);
      snap.wrote.team = shaOfFile(PATHS.team);
    }
    snap.oldId = actualOldId;
    snap.teamRoster = teamRoster;
    if (manifestFile) {
      const manifest = readJson(manifestFile, null)
        || { project: name, teamMode: project.mode, workspace: project.dir, roles: [] };
      manifest.roles = Array.isArray(manifest.roles) ? manifest.roles : [];
      let row = manifest.roles.find((r) => r && String(r.role) === roleId);
      if (!row) {
        // P3-3 复核：缺行时沿用旧实现的显示名（ROLE_NAMES），别把中文名写成 role id
        row = { role: roleId, name: ROLE_NAMES[roleId] || roleId, title: `团队·${ROLE_NAMES[roleId] || roleId}`, sessionId: newSessionId, reused: false, model: '' };
        manifest.roles.push(row);
      } else {
        row.sessionId = newSessionId;
      }
      manifest.generatedAt = isoOf(now);
      Object.assign(manifest, manifestExtra || {});
      if (failAt === 'afterManifest') fail('ROTATE_INJECTED_FAIL', '注入失败：团队会话.json 写入前');
      writeJsonAtomic(manifestFile, manifest, { case: 'roster-rotate', allowedRoots: [project.dir], project: name });
      snap.wrote.manifest = shaOfFile(manifestFile);
    } else if (failAt === 'afterManifest') {
      fail('ROTATE_INJECTED_FAIL', '注入失败：团队会话.json 写入前');
    }

    if (failAt === 'afterWorkbench') fail('ROTATE_INJECTED_FAIL', '注入失败：workbench.json 写入前');
    // workbench 走 json-atomic 的锁内读改写（AC-W4：不得裸写）
    updateJsonAtomic(wbFile, (wb) => {
      wb.projects = Array.isArray(wb.projects) ? wb.projects : [];
      let wp = wb.projects.find((p) => p && (p.name === name || (project.dir && p.path === project.dir)));
      if (!wp) {
        wp = { name, path: project.dir || '', sessions: {}, workspace: { sessionIds: [] } };
        wb.projects.push(wp);
      }
      wp.sessions = (wp.sessions && typeof wp.sessions === 'object') ? wp.sessions : {};
      wp.sessions[roleId] = newSessionId;
      wp.workspace = (wp.workspace && typeof wp.workspace === 'object') ? wp.workspace : {};
      wp.workspace.sessionIds = Array.isArray(wp.workspace.sessionIds) ? wp.workspace.sessionIds.map(String) : [];
      const drop = new Set([String(actualOldId || ''), String(oldId || '')].filter(Boolean));
      wp.workspace.sessionIds = wp.workspace.sessionIds.filter((sid) => !drop.has(String(sid)) || String(sid) === String(newSessionId));
      if (!wp.workspace.sessionIds.includes(newSessionId)) wp.workspace.sessionIds.push(newSessionId);
      wp.sessionMeta = (wp.sessionMeta && typeof wp.sessionMeta === 'object') ? wp.sessionMeta : {};
      wp.sessionMeta[roleId] = { ...(wp.sessionMeta[roleId] || {}), updatedAt: isoOf(now) };
      return wb;
      // 沙盘/自检的 workbench 文件名可被 TEAM_WORKBENCH_JSON 改（如 workbench-2e6b.json），
      // 白名单按「该文件所在目录」放行——与「只允许写这个 workbench」等价，不扩大敏感面。
    }, { case: 'roster-rotate', project: name, allowedRoots: [path.dirname(wbFile)] });
    snap.wrote.workbench = shaOfFile(wbFile);
    snap.activeProject = activeProject;
    return snap;
  });
}

/**
 * 失败回滚：只回滚「当前内容 == 我们写出去的那份」的文件（不覆盖并发写者的新改动）。
 * - 原本不存在、被本次新建的文件（典型：项目还没有 团队会话.json）→ 删掉，不留「只有 1 行」的半成品（P1-3）；
 * - 返回 {restored, removed, skipped, full}：`full=false` 表示**部分回滚**，调用方必须审计 + 告警 PM（P1-2）。
 */
export function restoreRosterSnapshot({ projectName, snap }) {
  if (!snap || !snap.wrote) return { restored: [], removed: [], skipped: [], full: true };
  const restored = [];
  const removed = [];
  const skipped = [];
  return withLock(ROSTER_LOCK_KEY, { ...ROSTER_LOCK_OPTS, reason: `roster rollback@${projectName}` }, () => {
    const targets = [
      ['team', PATHS.team],
      ['manifest', snap.manifestFile],
      ['workbench', snap.workbenchFile],
    ];
    for (const [key, file] of targets) {
      if (!file) continue;
      const raw = snap.before ? snap.before[key] : null;
      const wantSha = snap.wrote ? snap.wrote[key] : '';
      const existed = snap.existed ? snap.existed[key] !== false : true;
      const nowSha = shaOfFile(file);
      if (!wantSha) { skipped.push({ key, why: '本次未写出该文件，不回滚' }); continue; }
      if (nowSha && nowSha !== wantSha) { skipped.push({ key, why: '文件已被其它写者改动，不回滚', nowSha, wantSha }); continue; }
      try {
        if (!existed) {
          // 原本没有 → 删掉本次新建的那份
          if (nowSha) fs.rmSync(file, { force: true });
          removed.push(key);
          continue;
        }
        if (!raw) { skipped.push({ key, why: '没有写入前快照，无法回滚' }); continue; }
        const tmp = `${file}.rollback-${process.pid}-${Date.now().toString(36)}`;
        ensureDir(path.dirname(file));
        fs.writeFileSync(tmp, raw);
        fs.renameSync(tmp, file);
        restored.push(key);
      } catch (e) {
        skipped.push({ key, why: String((e && e.message) || e) });
      }
    }
    // 「本次没写出该文件」不算部分回滚失败；只有真写出却回不去的才算
    const realSkips = skipped.filter((s) => !/本次未写出/.test(String(s.why || '')));
    return { restored, removed, skipped, full: realSkips.length === 0 };
  });
}

/* ── 记账 + BQ + 广播 + 事件（两路径同判，W3） ─────────────────────────── */

/** 广播：本人去新会话 boot + 其余 active 成员重 boot。每个收件人最多重试 3 次，失败写审计（不静默）。 */
export function broadcastReboot({ projectName, role, oldId, newSessionId, reason = '', source = 'roster-rotate', now = null }) {
  const at = isoOf(now);
  const result = { self: false, others: [], failed: [], attempts: 0 };
  const members = (() => {
    try { return (loadTeam().members || []); } catch { return []; }
  })();
  const send = (to, subject, body) => {
    for (let i = 0; i < 3; i += 1) {
      result.attempts += 1;
      try {
        sendMessage({ from: 'system', to, project: projectName, type: 'notice', subject, body });
        return true;
      } catch (e) {
        if (i === 2) result.failed.push({ to, why: String((e && (e.message || e.code)) || e) });
      }
    }
    return false;
  };
  result.self = send(role, `已换人：请在新会话 boot（${role}）`,
    `本角色会话已轮换：${oldId || '未记录'} → ${newSessionId}。\n`
    + `请在新会话执行：node 团队\\工具\\team.mjs boot --role ${role} --project ${projectName} --session ${newSessionId}\n`
    + `原因：${reason || '未写原因'}（来源 ${source}）。`);
  const seen = new Set([String(role)]);
  for (const m of members) {
    if (!m || !m.role) continue;
    if (seen.has(String(m.role))) continue;
    if (m.status && m.status !== 'active') continue;
    seen.add(String(m.role));
    const ok = send(m.role, '名册变更：请重 boot（换人后旧令牌已失效）',
      `${role} 已换人（${oldId || '未记录'} → ${newSessionId}），团队名册变更使全员旧令牌失效。\n`
      + `请执行：node 团队\\工具\\team.mjs boot --role ${m.role} --project ${projectName}`);
    if (ok) result.others.push(String(m.role));
  }
  if (result.failed.length) {
    try {
      appendJsonl(rosterAuditPath(projectName), {
        at, event: 'broadcast_failed', result: 'fail', code: 'REBOOT_BROADCAST_PARTIAL',
        project: projectName, role, to: newSessionId, by: 'system', source,
        reason: `重 boot 广播部分失败：${result.failed.map((f) => `${f.to}(${f.why})`).join('；')}`.slice(0, 300),
        failed: result.failed,
      });
    } catch { /* 审计失败不掩盖广播结果 */ }
  }
  return result;
}

/**
 * 收尾：写轮换记录 + 会话轮换.jsonl + 名册变更.jsonl + BQ + 广播 + 事件。
 * 返回 { record, recordId, bootPending, broadcast }。
 */
export async function finalizeRoster({
  projectName, role, from = '', to, mode = 'auto', created = false, reason = '', by = 'system', source = 'session-rotate',
  recordExtra = {}, jsonlExtra = {}, eventExtra = {}, bootQueue = true, offline = false, broadcast = true, now = null,
  activeProject = true,
}) {
  const name = String(projectName || '');
  const at = isoOf(now);
  const recordId = `S-${stamp()}`;
  const dir = rotateRecordDir(name);
  ensureDir(dir);
  const roleFile = path.join(dir, `${role}.json`);
  const historyFile = path.join(dir, `${recordId}.json`);
  const previous = (() => { try { return readJson(roleFile, null); } catch { return null; } })();

  const record = {
    id: recordId, project: name, role, from, to, at, by, reason,
    status: 'active', mode, created, retiredAt: null, source,
    ...(recordExtra || {}),
  };
  if (previous && previous.id && previous.id !== recordId) {
    record.previous = { id: previous.id, from: previous.from || '', to: previous.to || '', status: 'retired', retiredAt: at };
    try {
      const prevHistory = path.join(dir, `${previous.id}.json`);
      const prevRow = readJson(prevHistory, null);
      if (prevRow) writeJsonAtomic(prevHistory, { ...prevRow, status: 'retired', retiredAt: at }, { case: 'roster-rotate', project: name });
    } catch { /* 历史文件缺失不阻断轮换 */ }
  }
  // ① 先把轮换记录落盘：任何失败都在「已广播/BQ」之前暴露，避免「名册已回滚但已通知全员重 boot」这种假消息。
  writeJsonAtomic(roleFile, record, { case: 'roster-rotate', project: name });
  writeJsonAtomic(historyFile, record, { case: 'roster-rotate', project: name });

  // ② BQ：新会话登记待启动项并尝试拉起一次（旧 auto-rotate 缺这一段）
  let bootPending = null;
  if (bootQueue) {
    try {
      const mod = await import('./session.mjs');
      bootPending = await mod.queueBootForRole({
        projectName: name, role, sessionId: to,
        reason: `${source}:${reason || '未写原因'}`, offline,
      });
    } catch (e) {
      bootPending = { queued: false, why: String((e && e.message) || e) };
    }
  }
  // ③ 广播：本人 + 其余 active 成员（旧 session rotate 缺这一段）。
  // 非活跃项目（团队.json 未改）不广播——否则全队收到「名册变更请重 boot」，但 rulesHash 其实没变（P2-5 复核）。
  const bcast = (broadcast && activeProject)
    ? broadcastReboot({ projectName: name, role, oldId: from, newSessionId: to, reason, source, now })
    : { self: false, others: [], failed: [], skipped: broadcast ? 'inactive-project' : 'asker-disabled' };
  // ④ 记录回填 BQ/广播结果（版本号不变；只在有内容时多写一次）
  if (bootPending || (bcast && bcast.others && bcast.others.length)) {
    if (bootPending) record.bootPending = bootPending;
    if (bcast && Array.isArray(bcast.others)) record.broadcastTo = bcast.others;
    try {
      writeJsonAtomic(roleFile, record, { case: 'roster-rotate', project: name });
      writeJsonAtomic(historyFile, record, { case: 'roster-rotate', project: name });
    } catch { /* 回填失败不改变「换人已成事实」；审计行仍记 bootQueued/broadcastTo */ }
  }

  // 会话轮换.jsonl（两条路径同一行格式：from/to/mode/created/by/source）
  try {
    appendJsonl(rotateLedgerPath(name), {
      at, project: name, role, from, to, reason, by, mode, created, source, id: recordId,
      ...(jsonlExtra || {}),
    });
  } catch { /* 记账失败不影响换人；审计行仍带 from/to */ }

  // 名册变更.jsonl（统一审计：一行回答「这行名册是谁、什么时候、为什么改的」）
  try {
    appendJsonl(rosterAuditPath(name), {
      at, event: 'roster_rotate', result: 'ok',
      // 非活跃项目不写团队.json → 名册其实没变，不能记 ROSTER_UPDATED（P2-5 复核）
      code: activeProject ? 'ROSTER_UPDATED' : 'ROSTER_SKIPPED_INACTIVE_PROJECT',
      project: name, role, from, to, by, source, mode, created, reason: String(reason || '').slice(0, 200),
      recordId, rosterSha256: shaOfFile(PATHS.team),
      rosterWritten: Boolean(activeProject),
      bootQueued: Boolean(bootPending && bootPending.queued), broadcastTo: bcast && bcast.others,
    });
  } catch { /* 同上 */ }

  try {
    appendEvent({
      role: by, sessionId: to, action: 'session_rotate', project: name, target: role,
      note: `${from || '(无)'} → ${to}（${reason || '未写原因'}｜${source}）`,
      data: { from, to, by, source, mode, created, ...(eventExtra || {}) },
    });
  } catch { /* 事件失败不阻断换人 */ }

  return { record, recordId, bootPending, broadcast: bcast, roleFile, historyFile: path.join(dir, `${recordId}.json`) };
}

/* ── 写后 60 秒存在性兜底（W7） ─────────────────────────────────────────── */

export function queueRosterPostCheck({ projectName, role, sessionId, at = null }) {
  const file = postCheckPath(projectName);
  const items = (() => {
    try {
      const data = readJson(file, null);
      return data && Array.isArray(data.items) ? data.items : [];
    } catch { return []; }
  })().filter((it) => it && !(String(it.sessionId) === String(sessionId) && String(it.role || '') === String(role || '')));
  items.push({ role: String(role || ''), sessionId: String(sessionId || ''), at: isoOf(at), checkedAt: null });
  ensureDir(path.dirname(file));
  writeJsonAtomic(file, { items: items.slice(-50), updatedAt: isoOf(at) }, { case: 'roster-post-check', project: projectName });
  return { file, items };
}

/** 扫待校验项：超过 60 秒仍查不到 → 审计 1 行 + 告警 PM；查到则移除。`skipDsh` 用于离线（--offline）场景。 */
export async function sweepRosterPostChecks({ projectName, now = Date.now(), engineUrl = '', dshList = null, skipDsh = false }) {
  const file = postCheckPath(projectName);
  const data = (() => { try { return readJson(file, null); } catch { return null; } })();
  const items = data && Array.isArray(data.items) ? data.items : [];
  if (!items.length) return { checked: 0, missing: [], kept: 0, items: [] };
  const nowMs = typeof now === 'number' ? now : Date.parse(String(now));
  const keep = [];
  const missing = [];
  const resolved = [];
  for (const it of items) {
    const atMs = Date.parse(String(it.at || ''));
    if (!Number.isFinite(atMs) || (Number.isFinite(nowMs) ? nowMs : Date.now()) - atMs < POST_CHECK_TTL_MS) { keep.push(it); continue; }
    if (skipDsh) { keep.push(it); continue; }                            // 离线（--offline）：不联网，保留待下次
    const chk = await checkSessionInDsh({ sessionId: it.sessionId, engineUrl, dshList });
    if (chk.checked === false) { keep.push(it); continue; }             // 沙盘/不可校验：保留待下次
    if (chk.exists === null) { keep.push(it); continue; }               // DSH 不可达：保留
    if (chk.exists === true) { resolved.push(it); continue; }
    missing.push(it);
  }
  if (missing.length) {
    for (const it of missing) {
      try {
        appendJsonl(rosterAuditPath(projectName), {
          at: nowIso(), event: 'roster_post_check', result: 'fail', code: 'ROSTER_SESSION_MISSING',
          project: projectName, role: it.role, to: it.sessionId, by: 'system', source: 'post-check',
          reason: `写后 ${Math.round(POST_CHECK_TTL_MS / 1000)} 秒兜底校验：名册指向的会话在 DSH 仍不存在（${it.sessionId}）`,
        });
      } catch { /* 审计失败不掩盖告警 */ }
      alertPm({
        projectName, role: it.role, source: 'post-check', by: 'system',
        code: 'ROSTER_SESSION_MISSING', sessionId: it.sessionId,
        reason: `写后 60 秒兜底校验失败：名册指向的会话在 DSH 不存在（换人时刻 ${it.at}）`,
      });
    }
  }
  if (keep.length !== items.length) {
    ensureDir(path.dirname(file));
    writeJsonAtomic(file, { items: keep, updatedAt: nowIso() }, { case: 'roster-post-check', project: projectName });
  }
  return { checked: items.length - keep.length, missing, resolved, kept: keep.length, items: keep };
}

/* ── 交接判据（W5）：唯一入口，内部固定 validateHandover() ───────────────── */

/**
 * 换人前的交接判定（两条路径都调它）。
 * 判据固定＝session.mjs 的 validateHandover()（4 个必填【】小节 + 遗留坑红标），
 * 不再各写一套（旧 auto-rotate 只看文件 mtime / 邮件关键词）。
 * 沙盘可用 `TEAM_ROTATE_HANDOVER_TEXT` 注入同一段文本，用于验证「两路径同判」。
 */
export async function checkRotateHandover({ projectName, role, sessionId = '', text = '' }) {
  let mod;
  try { mod = await import('./session.mjs'); } catch (e) {
    return { ok: false, code: 'HANDOVER_JUDGE_UNAVAILABLE', missingRequired: [], emptyRequired: [], redFlags: [], why: String((e && e.message) || e) };
  }
  let body = String(text || '');
  if (!body && String(process.env.TEAM_SELFTEST || '') === '1') body = String(process.env.TEAM_ROTATE_HANDOVER_TEXT || '');
  let source = body ? 'injected' : 'generated';
  if (!body) {
    try {
      body = String(mod.buildHandover({ projectName, role, sessionId }).text || '');
    } catch (e) {
      return { ok: false, code: 'HANDOVER_BUILD_FAILED', missingRequired: [], emptyRequired: [], redFlags: [], why: String((e && e.message) || e) };
    }
  }
  const v = mod.validateHandover(body);
  return {
    ok: Boolean(v.ok),
    code: v.ok ? '' : 'HANDOVER_INCOMPLETE',
    missingRequired: v.missingRequired || [],
    emptyRequired: v.emptyRequired || [],
    redFlags: v.redFlags || [],
    source,
    bytes: Buffer.byteLength(body, 'utf8'),
  };
}

/* ── 主入口：两条换人路径都只调它（W1/W2/W3/W7/W8） ─────────────────────── */

/**
 * 换人（名册侧唯一入口）。
 * - 写前校验：格式 + 旧副本形态 + DSH 存在性（任一不过 → 零写入）
 * - 写四处映射（withLock('_team')；workbench 走 json-atomic）
 * - beforeFinalize（可选）：调用方的其它事务步骤（邮件归档/任务会话指向/派单锁/一致性闸门）；
 *   抛错即触发映射回滚（只回滚本次写出的那份）
 * - 收尾：轮换记录 + 两个账本 + BQ + 广播 + 事件
 */
export async function rotateRoster({
  projectName, role, newSessionId, mode = 'auto', created = false, reason = '', by = 'system', source = 'session-rotate',
  expectedOldId = '', memberExtra = {}, recordExtra = {}, jsonlExtra = {}, eventExtra = {}, manifestExtra = {},
  dshList = null, engineUrl = '', offline = false, checkDsh = true,
  bootQueue = true, broadcast = true, failAt = '', now = null, dryRun = false, beforeFinalize = null,
}) {
  const name = String(projectName || '');
  const roleId = String(role || '');
  if (!name) fail('NO_PROJECT', '需要项目名');
  if (!roleId) fail('BAD_ROLE', '需要角色');
  if (!ROSTER_SOURCES.includes(String(source))) {
    fail('ROSTER_SOURCE_UNKNOWN', `未知的名册变更来源：${source}（允许 ${ROSTER_SOURCES.join('/')}）`, { source, allowed: ROSTER_SOURCES });
  }
  const target = assertSessionWritable({ projectName: name, role: roleId, sessionId: newSessionId, source, by });
  // 写后 60 秒兜底校验的清扫点之一（另一个在 auto-rotate 每拍）：换人前后都把过期待校验项收掉，不积压。
  // --offline 不联网（sweep 只保留待校验项，不尝试 DSH）。
  try { await sweepRosterPostChecks({ projectName: name, engineUrl, skipDsh: offline }); } catch { /* 兜底清扫失败不阻断本次换人 */ }
  // 新旧相同：零写入先判（读名册现值 + 调用方给的期望旧 id）。
  // 注意：团队.json 是「当前项目」的镜像——只有本项目是 activeProject 时，名册值才是本角色的真相，
  // 非活跃项目拿它比对会把别的项目的会话误当成本角色现值（假 SESSION_SAME）。
  const currentOld = (() => {
    try {
      const team = loadTeam();
      if (String(team.activeProject || '') !== name) return '';
      return String((getMember(team, roleId) || {}).sessionId || '');
    } catch { return ''; }
  })();
  if (String(expectedOldId || '') && String(expectedOldId) === target) {
    fail('SESSION_SAME', `新旧会话相同：${target}；名册未改动（零写入）`, { role: roleId, project: name, sessionId: target, source });
  }
  if (currentOld && currentOld === target) {
    fail('SESSION_SAME', `新旧会话相同：${target}（名册已是该会话）；名册未改动（零写入）`, { role: roleId, project: name, sessionId: target, source });
  }
  if (dryRun) {
    return { ok: true, dryRun: true, project: name, role: roleId, from: '', to: target, mode, created, reason, by, source };
  }
  // 写前 DSH 存在性校验（W2）：不通过 → 零写入。
  // 沙盘/--offline 默认豁免，但 `TEAM_ROSTER_DSH_ENFORCE=1` 表示「门禁本体强制」——豁免让位于强制。
  // `created=true`（刚由 createTeamSession 真建）不再查列表：调用方手里的 DSH 列表是**建会话之前**拍的快照
  // （P1-1 复核：旧实现会把刚建好的新会话判成不存在 → 生产自动建会话换人 100% 失败）；存在性由写后 60 秒兜底负责。
  const dshEnforce = String(process.env.TEAM_ROSTER_DSH_ENFORCE || '') === '1';
  let dshCheck = { checked: false, exempt: offline ? 'offline' : 'skipped', exists: null, code: '' };
  if (created) {
    dshCheck = { checked: false, exempt: 'created', exists: null, code: '', why: '刚由 DSH create 建出的会话：不做建会话前快照比对，存在性由写后 60 秒兜底' };
  } else if (checkDsh && (!offline || dshEnforce)) {
    dshCheck = await checkSessionInDsh({ sessionId: target, engineUrl, dshList });
    if (dshCheck.checked === true && dshCheck.exists === false) {
      refuse({
        projectName: name, role: roleId, sessionId: target, source, by, code: 'SESSION_NOT_IN_DSH',
        why: `目标会话在 DSH 不存在：${target}`,
        details: { dshCheck },
      });
    }
    if (dshCheck.checked === true && dshCheck.exists === null && mode === 'manual') {
      refuse({
        projectName: name, role: roleId, sessionId: target, source, by, code: 'DSH_UNAVAILABLE',
        why: `无法校验指定会话（DSH 不可达：${dshCheck.why || '未知'}）`,
        details: { dshCheck },
      });
    }
  }
  let snap = null;
  try {
    // 快照先取：applyRosterMaps 中途抛错（如注入失败）也能回滚已写出的那几份
    snap = captureRosterSnapshot({ projectName: name });
    applyRosterMaps({ projectName: name, role: roleId, newSessionId: target, oldId: String(expectedOldId || ''), memberExtra, failAt, now, manifestExtra }, snap);
    const oldId = String(snap.oldId || '');
    let hookExtra = {};
    if (typeof beforeFinalize === 'function') {
      hookExtra = (await beforeFinalize({ projectName: name, role: roleId, oldId, newId: target, mapResult: snap })) || {};
    }
    const fin = await finalizeRoster({
      projectName: name, role: roleId, from: oldId, to: target, mode, created, reason, by, source,
      recordExtra: { ...(recordExtra || {}), ...(hookExtra.recordExtra || {}) },
      jsonlExtra: { ...(jsonlExtra || {}), ...(hookExtra.jsonlExtra || {}) },
      eventExtra: { ...(eventExtra || {}), ...(hookExtra.eventExtra || {}) },
      bootQueue, offline, broadcast, now,
      activeProject: snap.activeProject !== false,
    });
    try { queueRosterPostCheck({ projectName: name, role: roleId, sessionId: target, at: now }); } catch { /* 兜底登记失败不阻断换人 */ }
    return {
      ok: true, project: name, role: roleId, oldId, newId: target, mode, created, reason, by, source,
      recordId: fin.recordId, record: fin.record, bootPending: fin.bootPending, broadcast: fin.broadcast,
      teamRoster: snap.teamRoster, dshCheck,
    };
  } catch (e) {
    let rollback = null;
    if (snap) {
      try {
        rollback = restoreRosterSnapshot({ projectName: name, snap });
        e.details = { ...(e.details || {}), rollback };
      } catch (err) {
        rollback = { restored: [], removed: [], skipped: [], full: false, error: String((err && err.message) || err) };
        e.details = { ...(e.details || {}), rollback };
      }
    }
    try {
      appendJsonl(rosterAuditPath(name), {
        at: nowIso(), event: 'roster_write_failed', result: 'fail', code: String((e && e.code) || 'ROSTER_WRITE_FAILED'),
        project: name, role: roleId, from: snap ? String(snap.oldId || '') : '', to: target, by, source,
        reason: String((e && e.message) || e).slice(0, 200),
        rollback: rollback ? { full: rollback.full, restored: rollback.restored, removed: rollback.removed, skipped: rollback.skipped } : null,
      });
    } catch { /* 记账失败不掩盖原始错误 */ }
    // P1-2 复核：部分回滚必须显式暴露（不许在错误里写「已回滚」了事）——单独审计一行 + 告警 PM。
    if (rollback && rollback.full === false) {
      try {
        appendJsonl(rosterAuditPath(name), {
          at: nowIso(), event: 'roster_rollback_partial', result: 'fail', code: 'ROSTER_ROLLBACK_PARTIAL',
          project: name, role: roleId, from: snap ? String(snap.oldId || '') : '', to: target, by, source,
          reason: `部分回滚：${(rollback.skipped || []).map((x) => `${x.key}(${x.why})`).join('；')}`.slice(0, 300),
          rollback,
        });
      } catch { /* ignore */ }
      alertPm({
        projectName: name, role: roleId, sessionId: target, source, by,
        code: 'ROSTER_ROLLBACK_PARTIAL',
        reason: `换人失败且回滚不完整（${(rollback.skipped || []).map((x) => x.key).join('/')}）：四处映射可能不一致，请跑 session check 并人工确认`,
      });
    }
    throw e;
  }
}

export default { rotateRoster, applyRosterMaps, finalizeRoster, checkRotateHandover, setMemberSession, applyMemberSession, pushRosterMember };
