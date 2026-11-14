import fs from 'node:fs';
import path from 'node:path';
import { projectStatePaths } from './store.mjs';
import { nowIso, ensureDir, jsonOut, textOut, fail, readJson } from './core.mjs';

const FILE = '评审代管.json';
const CLOSED_STATUSES = new Set(['accepted', 'terminated', 'rejected']);
const SCOPES = new Set(['once', 'always', 'all']);

/** 项目内非终态需求 id（scope=all 的覆盖目标）。 */
function nonTerminalRequirementIds(projectName) {
  let wf = null;
  try { wf = readJson(path.join(projectStatePaths(projectName).dir, '工作流.json'), null); } catch { wf = null; }
  const reqs = (wf && wf.requirements) || {};
  const rows = Array.isArray(reqs) ? reqs : Object.values(reqs);
  return rows
    .filter((row) => row && row.id && !CLOSED_STATUSES.has(String(row.status || '')))
    .map((row) => String(row.id));
}
const DEFAULT_TTL_MS = Math.max(1, Number(process.env.TEAM_PROXY_TTL_HOURS || 8)) * 3600 * 1000;

/** R-7849：代管时钟可注入（沙盘造过期/未过期），默认真实时间。 */
function nowMs() {
  const raw = String(process.env.TEAM_PROXY_NOW || '').trim();
  if (raw) {
    const parsed = Date.parse(raw);
    if (!Number.isNaN(parsed)) return parsed;
    const num = Number(raw);
    if (Number.isFinite(num)) return num;
  }
  return Date.now();
}

function proxyFile(projectName) {
  return path.join(projectStatePaths(projectName).dir, FILE);
}

function readState(projectName) {
  const file = proxyFile(projectName);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return { file, records: Array.isArray(raw.records) ? raw.records : [] };
  } catch {
    return { file, records: [] };
  }
}

function writeState(projectName, records) {
  const file = proxyFile(projectName);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ records, updatedAt: nowIso() }, null, 2) + '\n', 'utf8');
  return file;
}

function recordExpiry(record) {
  const at = String((record && record.expiresAt) || '');
  const ms = Date.parse(at);
  return Number.isNaN(ms) ? 0 : ms;
}

/** R-7849：记录是否过期（过期即 PROXY_EXPIRED，不再是有效代管）。 */
export function isProxyExpired(record, at = nowMs()) {
  const exp = recordExpiry(record);
  return Boolean(exp) && at > exp;
}

/** 有效（未结束且未过期）的代管记录；给落账前判权用。 */
export function assertProxyUsable(record, { requirementId = '' } = {}) {
  if (!record) {
    fail('PROXY_UNAUTHORIZED', `需求 ${requirementId || '(未知)'} 当前没有未结束的代管授权：先在评审弹窗点「全部交 PM 代管」，或 owner proxy start --scope all`, { requirementId });
  }
  if (record.endedAt) {
    fail('PROXY_UNAUTHORIZED', '代管已结束，不能再代落账；需要请 Owner 重新开启', { requirementId, endedAt: record.endedAt });
  }
  if (isProxyExpired(record)) {
    fail('PROXY_EXPIRED', `代管已于 ${record.expiresAt} 过期（默认 8 小时），过期后不再代落账；请 Owner 重新开启`, {
      requirementId, expiresAt: record.expiresAt, scope: record.scope,
    });
  }
  if (!String(record.authorization || '').trim()) {
    fail('PROXY_UNAUTHORIZED', '代管记录缺少 Owner 授权来源（authorization），不能代落账', { requirementId });
  }
  return record;
}

export function proxyStatus(projectName) {
  const state = readState(projectName);
  const actives = state.records.filter((row) => !row.endedAt);
  const active = actives.slice(-1)[0] || null;
  return {
    project: projectName,
    file: state.file,
    scope: active ? active.scope : null,
    requirementId: active ? active.requirementId : '',
    startedAt: active ? active.startedAt : '',
    endedAt: active ? active.endedAt : '',
    expiresAt: active ? String(active.expiresAt || '') : '',
    expired: active ? isProxyExpired(active) : false,
    activeCount: actives.length,
    active,
    actives,
    history: state.records,
  };
}

/**
 * 开启代管（R-7849）：scope=once|always|all；all 覆盖项目内所有非终态需求（requirementId='*'）。
 * - 新增 expiresAt（默认 startedAt + 8h，可用记录/环境变量覆盖）；
 * - 幂等：同 scope+需求已有未结束且未过期的记录 → 不新建，只更新 updatedAt，返回 idempotent:true。
 */
export function startProxy({ projectName, requirementId, scope = 'once', authorization = '', by = 'owner', recordedBy = 'pm', ttlHours = 0 }) {
  const sc = String(scope || 'once').toLowerCase();
  if (!SCOPES.has(sc)) fail('PROXY_SCOPE_INVALID', 'scope 只能是 once / always / all', { scope: sc });
  const state = readState(projectName);
  const at = nowMs();
  const ttlMs = (Number(ttlHours) > 0 ? Number(ttlHours) : DEFAULT_TTL_MS / 3600000) * 3600000;
  const startedAt = new Date(at).toISOString();
  const expiresAt = new Date(at + ttlMs).toISOString();
  const makeRecord = (targetId) => ({
    id: `PX-${startedAt.replace(/[-:TZ.]/g, '').slice(0, 14)}-${Math.random().toString(16).slice(2, 6)}`,
    scope: sc,
    requirementId: targetId,
    startedAt,
    expiresAt,
    startedBy: by,
    authorization: authorization || 'Owner 在评审弹窗点击代管',
    recordedBy,
    endedAt: null,
    endedBy: null,
    endedReason: '',
  });
  // R-7849 ②：scope=all 不再写一条 '*' 记录，而是给「项目内所有非终态需求」各写一条，
  // 这样需求收口时能精确结束它自己那条（僵尸治理），all 也不会因为一条收口就整锅失效。
  if (sc === 'all') {
    const ids = nonTerminalRequirementIds(projectName);
    if (!ids.length) fail('PROXY_NO_TARGET', '项目里没有非终态需求，无需开代管', { project: projectName });
    const created = [];
    for (const id of ids) {
      const exists = state.records.find((row) => !row.endedAt
        && String(row.scope) === 'all'
        && String(row.requirementId) === String(id)
        && !isProxyExpired(row, at));
      if (exists) {
        exists.authorization = authorization || exists.authorization || '';
        exists.updatedAt = nowIso();
        continue;
      }
      const record = makeRecord(String(id));
      state.records.push(record);
      created.push(record);
    }
    writeState(projectName, state.records);
    const first = created[0] || state.records.filter((row) => !row.endedAt && String(row.scope) === 'all').slice(-1)[0] || null;
    return { ok: true, idempotent: created.length === 0, record: first, created, covered: ids.length };
  }
  const targetId = String(requirementId || '').trim();
  if (!targetId) fail('PROXY_REQUIREMENT_REQUIRED', '非 all 代管需要需求 id', { scope: sc });
  const active = state.records.find((row) => !row.endedAt
    && String(row.requirementId) === targetId
    && !isProxyExpired(row, at));
  if (active) {
    active.scope = sc;
    active.authorization = authorization || active.authorization || '';
    active.updatedAt = nowIso();
    writeState(projectName, state.records);
    return { ok: true, idempotent: true, record: active };
  }
  const record = makeRecord(targetId);
  state.records.push(record);
  writeState(projectName, state.records);
  return { ok: true, idempotent: false, record };
}

/** 结束代管（幂等）：已结束时再结束返回 idempotent:true，不报错。 */
export function endProxy({ projectName, requirementId = '', by = 'owner', reason = '' }) {
  const state = readState(projectName);
  let changed = 0;
  for (const row of state.records) {
    if (row.endedAt) continue;
    if (requirementId && String(row.requirementId) !== String(requirementId) && String(row.scope) !== 'all') continue;
    row.endedAt = nowIso();
    row.endedBy = by;
    row.endedReason = reason || '';
    changed += 1;
  }
  if (changed) writeState(projectName, state.records);
  return { ok: true, idempotent: changed === 0, ended: changed, status: proxyStatus(projectName) };
}

/** 需求收口（accepted/terminated/rejected）→ 自动结束该需求的未结束代管（PM 追加的僵尸治理）。 */
export function autoEndProxyForClosedRequirement(projectName, requirementId, status) {
  if (!CLOSED_STATUSES.has(String(status || ''))) return { ok: true, ended: 0, skipped: true };
  const state = readState(projectName);
  let ended = 0;
  for (const row of state.records) {
    if (row.endedAt) continue;
    if (String(row.requirementId) !== String(requirementId)) continue;
    row.endedAt = nowIso();
    row.endedBy = 'system';
    row.endedReason = 'requirement_closed';
    ended += 1;
  }
  if (ended) writeState(projectName, state.records);
  return { ok: true, ended, reason: 'requirement_closed' };
}

/** 全量清扫：把已收口需求上仍挂着的代管结束掉（修今天 11 条僵尸）。 */
export function sweepClosedProxies(projectName) {
  const state = readState(projectName);
  const workflow = (() => {
    try {
      return readJson(path.join(projectStatePaths(projectName).dir, '工作流.json'), null);
    } catch { return null; }
  })();
  const reqs = (workflow && workflow.requirements) || {};
  const statusOf = (id) => {
    const rows = Array.isArray(reqs) ? reqs : Object.values(reqs);
    const hit = rows.find((row) => row && String(row.id || '') === String(id));
    return hit ? String(hit.status || '') : '';
  };
  let ended = 0;
  for (const row of state.records) {
    if (row.endedAt) continue;
    const status = statusOf(row.requirementId);
    if (!CLOSED_STATUSES.has(status)) continue;
    row.endedAt = nowIso();
    row.endedBy = 'system';
    row.endedReason = 'requirement_closed';
    ended += 1;
  }
  if (ended) writeState(projectName, state.records);
  return { ok: true, ended, sweptClosed: ended };
}

export function activeProxyFor(projectName, requirementId) {
  const state = readState(projectName);
  const id = String(requirementId || '');
  const matches = state.records.filter((row) => !row.endedAt
    && (String(row.requirementId) === id || String(row.scope) === 'all'));
  return matches.slice(-1)[0] || null;
}

export function cmdOwnerProxy(args) {
  const action = String((args._ && args._[2]) || 'status').toLowerCase();
  const projectName = String(args.project || '');
  if (!projectName) throw new Error('需要 --project');
  if (action === 'status') {
    const r = proxyStatus(projectName);
    const human = [
      `评审代管 · ${projectName}`,
      `当前：${r.scope ? `${r.scope} · ${r.requirementId}` : '未开启'}${r.expiresAt ? ` ｜ 到期 ${r.expiresAt}` : ''}${r.expired ? ' ｜ 已过期' : ''}`,
      `活跃记录：${r.activeCount} 条 ｜ 历史：${r.history.length} 条`,
    ].join('\n');
    if (args.json) jsonOut(r);
    else textOut(human);
    return;
  }
  if (action === 'start') {
    const r = startProxy({
      projectName,
      requirementId: String(args.requirement || ''),
      scope: String(args.scope || 'once'),
      authorization: String(args.authorization || ''),
      by: String(args.by || 'owner'),
      ttlHours: Number(args['ttl-hours'] || 0),
    });
    if (args.json) jsonOut(r);
    else textOut(`已开启代管：${r.record.scope === 'all' ? '全部非终态需求' : r.record.requirementId}（${r.record.scope}，到期 ${r.record.expiresAt}）${r.idempotent ? '（已生效，幂等）' : ''}`);
    return;
  }
  if (action === 'end') {
    const r = endProxy({ projectName, requirementId: String(args.requirement || ''), by: String(args.by || 'owner'), reason: String(args.reason || '') });
    if (args.json) jsonOut(r);
    else textOut(`已结束代管：${r.ended} 条${r.idempotent ? '（本来就没开，幂等）' : ''}`);
    return;
  }
  if (action === 'sweep') {
    const r = sweepClosedProxies(projectName);
    if (args.json) jsonOut(r);
    else textOut(`已清理已收口需求的僵尸代管：${r.ended} 条`);
    return;
  }
  throw new Error('owner proxy 只支持 status | start | end | sweep');
}
