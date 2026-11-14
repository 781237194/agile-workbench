/**
 * R-bad3 boot 自动化（团队工具侧）
 *
 * 目标：角色在被触达（投递/派单/唤醒）前自动拿到有效 boot 令牌，不让 Owner/PM 手工兜底。
 * 约束（需求 F-bad3-1..8）：
 *  - 触发：rotate / create / rules_changed / stale（本模块统一入口，调用方给 trigger）
 *  - 先 boot 后投递：未成功时由调用方决定 pending_boot 或阻塞
 *  - 单飞：同一 project+role 并发只跑一次（锁 30 秒，后到者 hit 复用）
 *  - 审计：团队/状态/项目/<项目>/自动boot.jsonl，字段形态固定，tokenId 只放前 8 位
 *  - 失败：给 PM 发 type=boot_failed（聚合去重，TEAM_BOOT_FAIL_DEDUPE_MIN 可注入）
 */
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { PATHS, nowIso, ensureDir, readJson, appendLine, exists, hashFile } from './core.mjs';
import { projectStatePaths, loadProject, sendMessage, loadTeam } from './store.mjs';

const LOCK_TTL_SEC = 30;
const DEFAULT_FAIL_DEDUPE_MIN = 10;

function lockFile(project, role) {
  return path.join(PATHS.locks, `boot-${project}-${role}.json`);
}

function auditFile(project) {
  return path.join(projectStatePaths(project).dir, '自动boot.jsonl');
}

function failDedupeFile(project) {
  return path.join(projectStatePaths(project).dir, 'boot失败去重.json');
}

function tokenFiles() {
  try {
    return fs.readdirSync(PATHS.boots).filter((name) => name.endsWith('.json')).map((name) => path.join(PATHS.boots, name));
  } catch { return []; }
}

/** 找该角色在该项目下仍然有效的 boot 令牌（未过期、会话匹配优先）。 */
export function findValidBootToken(project, role, sessionId = '') {
  const now = Date.now();
  let best = null;
  for (const file of tokenFiles()) {
    let row = null;
    try { row = JSON.parse(fs.readFileSync(file, 'utf8')); } catch { continue; }
    if (!row || String(row.role) !== String(role)) continue;
    if (String(row.project || '') !== String(project)) continue;
    const exp = Date.parse(String(row.expiresAt || ''));
    if (!Number.isFinite(exp) || exp <= now) continue;
    if (sessionId && String(row.sessionId || '') && String(row.sessionId) !== String(sessionId)) continue;
    const at = Date.parse(String(row.createdAt || '')) || 0;
    if (!best || at >= best.at) best = { row, file, at };
  }
  if (!best) return null;
  return { token: String(best.row.token || ''), tokenId: String(best.row.token || '').slice(0, 8), rulesHash: String(best.row.rulesHash || ''), file: best.file, sessionId: String(best.row.sessionId || '') };
}

function acquireLock(project, role, sessionId) {
  const file = lockFile(project, role);
  ensureDir(path.dirname(file));
  const now = Date.now();
  if (exists(file)) {
    const cur = readJson(file, null);
    const at = Date.parse(String((cur && cur.at) || '')) || 0;
    if (cur && now - at < LOCK_TTL_SEC * 1000) {
      return { ok: false, holder: cur, file };
    }
  }
  fs.writeFileSync(file, JSON.stringify({ key: `${project}|${role}`, owner: String(sessionId || ''), at: nowIso(), ttlSec: LOCK_TTL_SEC }, null, 2) + '\n', 'utf8');
  return { ok: true, file };
}

function releaseLock(file) {
  try { fs.rmSync(file, { force: true }); } catch { /* ignore */ }
}

function currentRulesHash() {
  try {
    return hashFile(path.join(PATHS.teamRoot, '团队宪法.md'));
  } catch { return ''; }
}

function docsReadList(role) {
  try {
    const team = loadTeam();
    const member = (team.members || []).find((m) => m && String(m.role) === String(role));
    const dir = (member && member.dir) || '';
    return ['项目铁律.md', '项目信息.md', `${dir ? dir + '/' : ''}角色卡.md`, '协作索引/项目索引.md'.replace('协作索引/', '')];
  } catch { return ['项目铁律.md', '项目信息.md']; }
}

function recordAudit(project, row) {
  try { appendLine(auditFile(project), JSON.stringify(row)); } catch { /* 审计失败不阻断 */ }
}

function alertPmOnce(project, { role, trigger, why, sessionId }) {
  const key = `${role}|${trigger}`;
  const now = Date.now();
  let dedupe = {};
  try { dedupe = readJson(failDedupeFile(project), {}) || {}; } catch { dedupe = {}; }
  const winMs = Math.max(0, Number(process.env.TEAM_BOOT_FAIL_DEDUPE_MIN || DEFAULT_FAIL_DEDUPE_MIN)) * 60 * 1000;
  const last = Number(dedupe[key] || 0);
  if (last && now - last < winMs) return { sent: false, dedupeKey: key, windowMin: winMs / 60000 };
  dedupe[key] = now;
  try { fs.writeFileSync(failDedupeFile(project), JSON.stringify(dedupe, null, 2) + '\n', 'utf8'); } catch { /* ignore */ }
  try {
    sendMessage({
      from: 'system', to: 'pm', type: 'boot_failed', project,
      subject: `自动 boot 失败：${role}（${trigger}）`,
      body: `角色 ${role} 在 ${trigger} 触发时自动 boot 失败：${String(why || '未知').slice(0, 300)}\n会话：${sessionId || '-'}\n处理：检查 团队/状态/项目/${project}/自动boot.jsonl，修好后重试或在界面点「重试」。`,
      ackRequired: false,
    });
  } catch { /* 告警失败不阻断 */ }
  return { sent: true, dedupeKey: key, windowMin: winMs / 60000 };
}

/**
 * 确保角色拿到有效 boot 令牌（单飞 + 审计 + 失败告警）。
 * @returns {{ok:boolean, booted:boolean, reused:boolean, tokenId:string, singleFlight:'leader'|'hit', durationMs:number, why:string}}
 */
export function ensureBooted({ project, role, sessionId = '', trigger = 'stale', duringTask = '' } = {}) {
  const startedAt = Date.now();
  const base = { at: nowIso(), project, role, sessionId: String(sessionId || ''), trigger, duringTask: String(duringTask || '') };
  // 1) 已有有效令牌：复用（哈希未变，跳过读取）
  const existing = findValidBootToken(project, role, sessionId);
  if (existing) {
    const durationMs = Date.now() - startedAt;
    recordAudit(project, {
      ...base, ok: true, why: '', tokenId: existing.tokenId, rulesHash: existing.rulesHash || currentRulesHash(),
      durationMs, docsRead: [], reused: true, skippedByHash: true, singleFlight: 'leader', booted: false,
    });
    return { ok: true, booted: false, reused: true, tokenId: existing.tokenId, singleFlight: 'leader', durationMs, why: '' };
  }
  // 2) 单飞：抢不到锁就等 400ms 再看令牌（后到者 hit 复用）
  const lock = acquireLock(project, role, sessionId);
  if (!lock.ok) {
    const deadline = Date.now() + 2000;
    while (Date.now() < deadline) {
      const got = findValidBootToken(project, role, sessionId);
      if (got) {
        const durationMs = Date.now() - startedAt;
        recordAudit(project, {
          ...base, ok: true, why: '', tokenId: got.tokenId, rulesHash: got.rulesHash || currentRulesHash(),
          durationMs, docsRead: [], reused: true, skippedByHash: true, singleFlight: 'hit', booted: false,
        });
        return { ok: true, booted: false, reused: true, tokenId: got.tokenId, singleFlight: 'hit', durationMs, why: '' };
      }
      const wait = Date.now() + 100;
      while (Date.now() < wait) { /* spin */ }
    }
    const durationMs = Date.now() - startedAt;
    recordAudit(project, { ...base, ok: false, why: 'single_flight_wait_timeout', tokenId: '', rulesHash: currentRulesHash(), durationMs, docsRead: [], reused: false, skippedByHash: false, singleFlight: 'hit', booted: false });
    return { ok: false, booted: false, reused: false, tokenId: '', singleFlight: 'hit', durationMs, why: 'single_flight_wait_timeout' };
  }
  try {
    // 3) 真正执行 boot（子进程调用本工具 boot 命令，避免复制必读逻辑）
    const tool = path.join(PATHS.teamRoot, '工具', 'team.mjs');
    let out = '';
    let ok = true;
    let why = '';
    try {
      out = execFileSync(process.execPath, [tool, 'boot', '--role', role, '--project', project, ...(sessionId ? ['--session', sessionId] : []), '--json'], {
        encoding: 'utf8', env: { ...process.env, TEAM_AUTO_BOOT: '1' }, timeout: 120000,
      });
    } catch (e) {
      ok = false;
      out = String((e && e.stdout) || '');
      why = String((e && (e.stderr || e.message)) || e).slice(0, 300);
    }
    let parsed = null;
    const at = String(out).trim().indexOf('{');
    if (at >= 0) { try { parsed = JSON.parse(String(out).trim().slice(at)); } catch { parsed = null; } }
    if (parsed && parsed.ok === false) { ok = false; why = String(parsed.code || parsed.message || why); }
    const token = parsed && parsed.token ? String(parsed.token) : ((findValidBootToken(project, role, sessionId) || {}).token || '');
    const tokenId = token.slice(0, 8);
    const durationMs = Date.now() - startedAt;
    const alert = ok ? null : alertPmOnce(project, { role, trigger, why, sessionId });
    recordAudit(project, {
      ...base, ok, why, tokenId, rulesHash: currentRulesHash(), durationMs,
      docsRead: ok ? docsReadList(role) : [], reused: false, skippedByHash: false, singleFlight: 'leader', booted: ok,
      ...(alert ? { dedupeKey: alert.dedupeKey, alertSent: alert.sent } : {}),
    });
    return { ok, booted: ok, reused: false, tokenId, singleFlight: 'leader', durationMs, why };
  } finally {
    releaseLock(lock.file);
  }
}

/** CLI 入口：node team.mjs auto-boot --project P --role R [--session S] [--trigger stale] [--json] */
export function cmdAutoBoot(args) {
  const project = String(args.project || '').trim();
  const role = String(args.role || '').trim();
  if (!project) throw new Error('需要 --project');
  if (!role) throw new Error('需要 --role');
  loadProject(project);
  const result = ensureBooted({
    project, role,
    sessionId: String(args.session || ''),
    trigger: String(args.trigger || 'stale'),
    duringTask: String(args['during-task'] || ''),
  });
  if (args.json) process.stdout.write(JSON.stringify({ ok: result.ok, ...result }) + '\n');
  else process.stdout.write(`${result.ok ? '已确保 boot' : '自动 boot 失败'}：${role}（${result.singleFlight}）${result.why ? ' ｜ ' + result.why : ''}\n`);
  if (!result.ok) process.exitCode = 1;
}
