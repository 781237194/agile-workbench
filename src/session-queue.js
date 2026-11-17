'use strict';
/**
 * R-6bc8（T-20261117-123812-37f5）会话排队可观测 —— 团队侧纯逻辑（无 Electron 依赖，Node 可直接测）。
 *
 * 分工（正文 §5）：
 *   · DSH 侧（插件 host half）只负责「排队数」→ 团队/状态/会话排队.json；
 *   · 团队侧（本文件 + 主进程）负责「四态 / 最近成功投递时间 / 失败与跳过计数」← 团队/状态/项目/<项目>/唤醒.jsonl。
 *
 * 硬口径：
 *   1) 排队数 = queue.filter(i => i.placement === 'queued').length；unknown ≠ 0（显示「—」）；
 *   2) 四态优先级 fail > skip > ok > none，**skipped 优先**（实测 17 行 ok=true + ALREADY_DELIVERED 不得算成功）；
 *   3) 兼容取值：投递时间 = deliveredAt ?? deliverAt ?? at；原因 = reason ?? why；消息 id = messageIds[0] ?? messageId；
 *   4) 积压与失败是两条独立列，互不推算（AC2）。
 */

const SIX_ROLES = ['pm', 'programmer1', 'tester', 'product', 'analyst', 'programmer2'];
const ROLE_LABELS = {
  pm: '项目经理',
  product: '产品设计师',
  analyst: '需求分析师',
  programmer1: '高级程序员 A',
  programmer2: '高级程序员 B',
  tester: '测试人员',
};

const DEFAULT_WINDOW_MS = 24 * 60 * 60 * 1000; // 统计窗口默认最近 24 小时
const DEFAULT_STALE_MS = 120 * 1000; // 快照过期阈值 120 秒
const BACKPRESSURE_THRESHOLD = 3; // 排队 ≥3 才提示

/** skipped 的三种真实取值（正文 §5.3 实测：MERGED_PENDING / ALREADY_DELIVERED / DEBOUNCED）。 */
const SKIP_VALUES = new Set(['MERGED_PENDING', 'ALREADY_DELIVERED', 'DEBOUNCED']);

function toMs(value) {
  const ms = Date.parse(String(value == null ? '' : value));
  return Number.isFinite(ms) ? ms : 0;
}

/** 兼容取值口径：deliveredAt ?? deliverAt ?? at（三者恒有 at 兜底）。 */
function rowAt(row) {
  if (!row || typeof row !== 'object') return 0;
  return toMs(row.deliveredAt || row.deliverAt || row.at);
}

/** 兼容取值口径：reason ?? why ?? ''。 */
function rowReason(row) {
  if (!row || typeof row !== 'object') return '';
  return String(row.reason || row.why || '');
}

/** 「设计内不唤醒」：skipped 非空即算，**不论 ok 真假**（这是本条硬约束）。 */
function rowSkipped(row) {
  if (!row || typeof row !== 'object') return false;
  const skipped = row.skipped;
  if (typeof skipped === 'string' && skipped.trim()) return true;
  if (skipped === true) return true;
  if (String(row.state || '') === 'skipped') return true;
  return SKIP_VALUES.has(rowReason(row).trim().toUpperCase());
}

/**
 * 单行归类：fail > skip > ok > none（与 §5.4 表一致）。
 * 注意顺序：先判 skipped，再判 ok —— ok=true+skipped 必须落 skip。
 */
function classifyRow(row) {
  if (!row || typeof row !== 'object') return 'none';
  if (rowSkipped(row)) return 'skip';
  if (row.ok === false) return 'fail';
  if (row.ok === true) return 'ok';
  return 'none';
}

/** 解析 唤醒.jsonl：坏行跳过并计数（不静默丢，正文边界「异常」）。 */
function parseWakeLog(text) {
  const rows = [];
  let badLines = 0;
  const lines = String(text == null ? '' : text).split(/\r?\n/);
  for (const line of lines) {
    const body = line.trim();
    if (!body) continue;
    try {
      const parsed = JSON.parse(body);
      if (parsed && typeof parsed === 'object') rows.push(parsed);
      else badLines += 1;
    } catch {
      badLines += 1;
    }
  }
  return { rows, badLines };
}

/**
 * 单角色四态汇总（窗口内）。
 * @returns {{state:'fail'|'skip'|'ok'|'none', failCount:number, skipCount:number, okCount:number, lastOkAt:string, lastAt:string, inWindow:number}}
 */
function summarizeRows(rows, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const windowMs = Number(options.windowMs) > 0 ? Number(options.windowMs) : DEFAULT_WINDOW_MS;
  const windowStart = now - windowMs;
  let failCount = 0;
  let skipCount = 0;
  let okCount = 0;
  let inWindow = 0;
  let lastOkMs = 0;
  let lastMs = 0;
  for (const row of Array.isArray(rows) ? rows : []) {
    const at = rowAt(row);
    if (at && at < windowStart) continue; // 窗口外不计
    inWindow += 1;
    if (at > lastMs) lastMs = at;
    const kind = classifyRow(row);
    if (kind === 'fail') failCount += 1;
    else if (kind === 'skip') skipCount += 1;
    else if (kind === 'ok') {
      okCount += 1;
      if (at > lastOkMs) lastOkMs = at;
    }
  }
  const state = failCount > 0 ? 'fail' : (skipCount > 0 ? 'skip' : (okCount > 0 ? 'ok' : 'none'));
  return {
    state,
    failCount,
    skipCount,
    okCount,
    inWindow,
    lastOkAt: lastOkMs ? new Date(lastOkMs).toISOString() : '',
    lastAt: lastMs ? new Date(lastMs).toISOString() : '',
  };
}

/**
 * 快照里的角色条目：插件实际写 roles[]，正文 §5.2 写 roles{}；两种都认。
 * known=false 的条目即便带了数字也按未知处理（禁用 0 代替未知）。
 */
function readSnapshotRoles(snapshot) {
  const map = new Map();
  if (!snapshot || typeof snapshot !== 'object') return map;
  const roles = snapshot.roles;
  const push = (role, entry) => {
    const key = String(role || '').trim();
    if (!key || !entry || typeof entry !== 'object') return;
    const hasNumber = Number.isFinite(Number(entry.queued)) && entry.queued !== null && String(entry.queued) !== '';
    const known = entry.known !== false && hasNumber;
    map.set(key, {
      known,
      queued: known ? Number(entry.queued) : null,
      byPlacement: known && entry.byPlacement && typeof entry.byPlacement === 'object' ? entry.byPlacement : null,
      sessionId: String(entry.sessionId || ''),
    });
  };
  if (Array.isArray(roles)) {
    for (const entry of roles) push(entry && entry.role, entry);
  } else if (roles && typeof roles === 'object') {
    for (const [role, entry] of Object.entries(roles)) push(role, entry);
  }
  return map;
}

/**
 * 快照健康度（AC6 过期降级 + 边界「空值/异常」）。
 * @returns {{degraded:boolean, code:string, reason:string, text:string, lastReadAt:string, ageMs:number}}
 */
function degradationOf(options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const staleMs = Number(options.staleMs) > 0 ? Number(options.staleMs) : DEFAULT_STALE_MS;
  const snapshot = options.snapshot && typeof options.snapshot === 'object' ? options.snapshot : null;
  const snapshotError = String(options.snapshotError || '');
  const build = (degraded, code, reason, at) => ({
    degraded,
    code,
    reason,
    lastReadAt: String(at || ''),
    ageMs: 0,
    text: degraded
      ? `${reason}；最近成功读取：${at || '无'
      }`
      : '',
  });
  if (snapshotError === 'missing' || !snapshot) {
    return build(true, 'missing', '会话排队快照未接入（插件还没写过 团队/状态/会话排队.json）', '');
  }
  if (snapshotError === 'broken') {
    return build(true, 'broken', '会话排队快照解析失败：沿用上一份可用数据', '');
  }
  const at = String(snapshot.at || '');
  const atMs = toMs(at);
  if (!atMs) return build(true, 'bad-at', '会话排队快照的 at 不是 ISO 时间，按过期处理', at);
  const ageMs = Math.max(0, now - atMs);
  if (ageMs > staleMs) {
    return {
      degraded: true,
      code: 'stale',
      reason: `会话排队快照已过期 ${Math.round(ageMs / 1000)} 秒（阈值 ${Math.round(staleMs / 1000)} 秒）`,
      lastReadAt: at,
      ageMs,
      text: `会话排队快照已过期 ${Math.round(ageMs / 1000)} 秒（阈值 ${Math.round(staleMs / 1000)} 秒）；最近成功读取：${at}`,
    };
  }
  return { degraded: false, code: 'ok', reason: '', lastReadAt: at, ageMs, text: '' };
}

/**
 * 面板模型：六角色 × （排队数 / 四态 / 失败数 / 跳过数 / 最近成功投递时间）+ 降级原因。
 */
function buildPanelModel(options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const windowMs = Number(options.windowMs) > 0 ? Number(options.windowMs) : DEFAULT_WINDOW_MS;
  const staleMs = Number(options.staleMs) > 0 ? Number(options.staleMs) : DEFAULT_STALE_MS;
  const roles = Array.isArray(options.roles) && options.roles.length ? options.roles.map(String) : SIX_ROLES.slice();
  const roleNames = options.roleNames && typeof options.roleNames === 'object' ? options.roleNames : {};
  const snapshot = options.snapshot && typeof options.snapshot === 'object' ? options.snapshot : null;
  const wake = Array.isArray(options.wakeRows)
    ? { rows: options.wakeRows, badLines: Number(options.badLines) || 0 }
    : parseWakeLog(options.wakeText);

  const wakeByRole = new Map();
  for (const row of wake.rows) {
    const role = String((row && row.to) || '').trim();
    if (!role) continue;
    if (!wakeByRole.has(role)) wakeByRole.set(role, []);
    wakeByRole.get(role).push(row);
  }

  const snapRoles = readSnapshotRoles(snapshot);
  const rows = roles.map((role) => {
    const entry = snapRoles.get(role) || null;
    const summary = summarizeRows(wakeByRole.get(role) || [], { now, windowMs });
    return {
      role,
      name: String(roleNames[role] || ROLE_LABELS[role] || role),
      known: Boolean(entry && entry.known),
      queued: entry && entry.known ? entry.queued : null,
      byPlacement: entry ? entry.byPlacement : null,
      sessionId: entry ? entry.sessionId : '',
      state: summary.state,
      failCount: summary.failCount,
      skipCount: summary.skipCount,
      okCount: summary.okCount,
      lastOkAt: summary.lastOkAt,
      lastAt: summary.lastAt,
    };
  });

  const health = degradationOf({ snapshot, snapshotError: options.snapshotError, now, staleMs });
  return {
    ok: true,
    project: String(options.project || (snapshot && snapshot.project) || ''),
    at: snapshot ? String(snapshot.at || '') : '',
    host: snapshot ? String(snapshot.host || '') : '',
    windowMs,
    staleMs,
    degraded: health.degraded,
    stale: health.degraded,
    banner: health,
    badLines: wake.badLines,
    rows,
    backpressure: backpressureHint((rows.find((row) => row.role === 'pm') || {}).queued),
  };
}

/** 背压提示：排队 ≥3 才有节点（<3 时节点不存在，不是隐藏）；只提示、不阻断派单。 */
function backpressureHint(queued, threshold = BACKPRESSURE_THRESHOLD) {
  const min = Number.isFinite(Number(threshold)) ? Number(threshold) : BACKPRESSURE_THRESHOLD;
  const n = Number(queued);
  if (queued === null || queued === undefined || queued === '' || !Number.isFinite(n) || n < min) {
    return { show: false, count: null, text: '' };
  }
  return { show: true, count: n, text: `对方排队 ${n} 条，先别连发` };
}

module.exports = {
  SIX_ROLES,
  ROLE_LABELS,
  DEFAULT_WINDOW_MS,
  DEFAULT_STALE_MS,
  BACKPRESSURE_THRESHOLD,
  SKIP_VALUES,
  rowAt,
  rowReason,
  rowSkipped,
  classifyRow,
  parseWakeLog,
  summarizeRows,
  readSnapshotRoles,
  degradationOf,
  buildPanelModel,
  backpressureHint,
};
