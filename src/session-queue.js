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
// B-20261118-085825-0950：一次唤醒失败后的重试窗口（默认 90s，可配 AWB_SQ_RETRY_WINDOW_MS）。
// 窗口内最新一条 fail 判「重试中」（黄），窗口外或连续 ≥2 条失败才判 fail（红）。
const DEFAULT_RETRY_WINDOW_MS = 90 * 1000;
// R-6bc8 §5.2：快照硬上限 64KB（B-c971：壳层读过大的快照会整份读入内存，必须拒读/降级）。
const SNAPSHOT_MAX_BYTES = 65536;
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
 *
 * B-20261117-181420-9688（P1，Owner 截图验收）：四态必须取**最近一次投递的结果**，
 * 不能「窗口内曾失败一次就永久 fail」——实测六角色最近一次全是 ok=true，但 5/6 显示 fail，
 * 就因为旧实现用了 some(failed)。现在：
 *   · state = 按 deliveredAt??deliverAt??at 降序第一条的归类（同时间戳 tie-break：skip > fail > ok）；
 *   · failCount/skipCount/okCount 继续按窗口计数，**与状态彻底分离**（计数不影响四态）；
 *   · 另给 lastAt/lastOkAt/lastFailAt 供面板显示「最近失败时间」。
 *
 * @returns {{state:'fail'|'skip'|'ok'|'none', failCount:number, skipCount:number, okCount:number, lastOkAt:string, lastAt:string, lastFailAt:string, inWindow:number, latestKind:string}}
 */
function summarizeRows(rows, options = {}) {
  const now = Number.isFinite(Number(options.now)) ? Number(options.now) : Date.now();
  const windowMs = Number(options.windowMs) > 0 ? Number(options.windowMs) : DEFAULT_WINDOW_MS;
  // B-20261118-085825-0950：重试窗口——一次唤醒失败后在窗口内算「重试中」（黄），不是 fail（红）。
  const envRetry = Number(process.env.AWB_SQ_RETRY_WINDOW_MS);
  const retryWindowMs = Number(options.retryWindowMs) > 0
    ? Number(options.retryWindowMs)
    : (Number.isFinite(envRetry) && envRetry > 0 ? envRetry : DEFAULT_RETRY_WINDOW_MS);
  const windowStart = now - windowMs;
  const TIE_RANK = { skip: 3, fail: 2, ok: 1, none: 0 };
  let failCount = 0;
  let skipCount = 0;
  let okCount = 0;
  let inWindow = 0;
  let lastOkMs = 0;
  let lastMs = 0;
  let lastFailMs = 0;
  let latest = null; // { at, kind, row }
  for (const row of Array.isArray(rows) ? rows : []) {
    const at = rowAt(row);
    if (at && at < windowStart) continue; // 窗口外不计
    inWindow += 1;
    if (at > lastMs) lastMs = at;
    const kind = classifyRow(row);
    if (kind === 'fail') {
      failCount += 1;
      if (at > lastFailMs) lastFailMs = at;
    } else if (kind === 'skip') {
      skipCount += 1;
    } else if (kind === 'ok') {
      okCount += 1;
      if (at > lastOkMs) lastOkMs = at;
    }
    // 「最近一次投递」：时间新的优先；同一时间戳按 skip > fail > ok 定序（skip 是设计内不唤醒，语义更强）。
    if (!latest || at > latest.at || (at === latest.at && TIE_RANK[kind] > TIE_RANK[latest.kind])) {
      latest = { at, kind, row };
    }
  }
  let state = latest ? latest.kind : 'none';
  // B-20261118-085825-0950：fail 的「重试中」降级判据（只看状态，**不动计数**）：
  //   · 最新一条 fail 且距 now < retryWindowMs → retry（一次尝试失败、后端已排 60s 重试，用户不该看到闪红）；
  //   · 连续 ≥2 条 fail（按时间倒序的最近两条都是 fail）→ 立即 fail（重试也没救回来）；
  //   · 窗口外 → fail。
  // 旧日志没有 retried 字段时同样按窗口判（正文 §5(d)），有 retried===true 只是补充证据。
  let consecutiveFails = 0;
  let retryUntilAt = '';
  if (latest && latest.kind === 'fail') {
    const recent = (Array.isArray(rows) ? rows : [])
      .filter((row) => { const at = rowAt(row); return at && at >= windowStart; })
      .sort((a, b) => rowAt(b) - rowAt(a));
    for (const row of recent) {
      if (classifyRow(row) !== 'fail') break;
      consecutiveFails += 1;
    }
    const withinRetry = consecutiveFails < 2 && Number.isFinite(latest.at) && latest.at > 0 && (now - latest.at) < retryWindowMs;
    if (withinRetry) {
      state = 'retry';
      retryUntilAt = new Date(latest.at + retryWindowMs).toISOString();
    }
  }
  return {
    state,
    failCount,
    skipCount,
    okCount,
    inWindow,
    latestKind: latest ? latest.kind : 'none',
    consecutiveFails,
    retryWindowMs,
    retryUntilAt,
    lastOkAt: lastOkMs ? new Date(lastOkMs).toISOString() : '',
    lastAt: lastMs ? new Date(lastMs).toISOString() : '',
    lastFailAt: lastFailMs ? new Date(lastFailMs).toISOString() : '',
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
      // R-c9ac：快照 v2 每角色新增字段（**只增不改**；未知时保持 null/空，不写 false/0 冒充已知）。
      active: known && entry.active === true,
      running: known && entry.running === true,
      pendingInput: known && Array.isArray(entry.pendingInput) ? entry.pendingInput.map((v) => String(v)) : [],
      runningSince: known && entry.runningSince ? String(entry.runningSince) : '',
      lastEventAt: known && entry.lastEventAt ? String(entry.lastEventAt) : '',
      cursor: known && entry.cursor !== undefined && entry.cursor !== null && entry.cursor !== '' ? entry.cursor : null,
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
  // B-c971①：超过需求 §5.2 的 64KB 硬上限 → 不读入、不按解析失败；单独给 oversize 文案。
  if (snapshotError === 'oversize') {
    return build(true, 'oversize', '会话排队快照超过 64KB 硬上限，已拒绝整份读取（写入侧应拒写超限快照，检查插件 writer 输出）', '');
  }
  // B-c971②：首份即坏（无上一份可用快照）时，之前落进「未接入 missing」文案；现在先判 broken，
  // 并按「有没有上一份可用快照」区分「沿用上一份」与「损坏（解析失败）」两种文案。
  if (snapshotError === 'broken') {
    return build(
      true,
      'broken',
      snapshot ? '会话排队快照解析失败：沿用上一份可用数据' : '会话排队快照损坏（解析失败），暂无可用快照；请检查插件 writer 输出',
      '',
    );
  }
  if (snapshotError === 'missing' || !snapshot) {
    return build(true, 'missing', '会话排队快照未接入（插件还没写过 团队/状态/会话排队.json）', '');
  }
  // B-20261117-180718-9229：插件自己报告的采集异常优先——它比「未接入/过期」更具体，
  // 面板要能区分「未配置 teamRoot」「采集失败」「写盘失败」，不能只显示「未接入」两个字。
  const pluginDegraded = snapshot.degraded && typeof snapshot.degraded === 'object' ? snapshot.degraded : null;
  if (pluginDegraded && pluginDegraded.code) {
    const code = String(pluginDegraded.code);
    const message = String(pluginDegraded.message || '插件采集异常');
    const lastAttemptAt = String(pluginDegraded.lastAttemptAt || '');
    const lastSuccessAt = String(snapshot.at || '');
    return {
      degraded: true,
      code,
      reason: message,
      lastReadAt: lastSuccessAt,
      ageMs: 0,
      text: `插件采集异常（${code}）：${message}；最近尝试：${lastAttemptAt || '未记'}`
        + `；上次成功：${lastSuccessAt || '无'}。修复：检查 DSH 插件配置 teamRoot（应为 …/团队 目录，需存在 状态/ 子目录）。`,
    };
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
 * R-fa0e（T-20261117-195120-3a12）§六：自动换人只读汇总 → 面板 [data-ar-*] 的取数口径。
 * 只读 `团队/状态/项目/<项目>/自动换人.jsonl`，不写任何状态；任何解析失败都降级为「无记录」，不抛。
 * state 六值：idle / warn / pending_handover / rotating / rebooting / failed。
 */
function readAutoRotateSummary({ auditRows, now } = {}) {
  const rows = Array.isArray(auditRows) ? auditRows.filter(Boolean) : [];
  const at = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const todayKey = new Date(at + 8 * 3600 * 1000).toISOString().slice(0, 10);   // 上海本地日期
  const dayLocal = (iso) => {
    const ms = Date.parse(String(iso || ''));
    return Number.isFinite(ms) ? new Date(ms + 8 * 3600 * 1000).toISOString().slice(0, 10) : '';
  };
  const today = rows.filter((row) => dayLocal(row.at) === todayKey);
  const rotatedToday = today.filter((row) => String(row.stage) === 'rotate' && String(row.result) !== 'fail');
  const failedToday = today.filter((row) => String(row.result) === 'fail' || String(row.stage) === 'failed'
    || (String(row.stage) === 'skipped' && String(row.code) === 'HANDOVER_TIMEOUT' && String(row.result) !== 'ok'));
  const byRole = {};
  // B-20261118-002151-61f5：用量来源（file=会话用量.json / live=实时回退 / none=都取不到）→ 面板 data-ar-usage。
  const usageByRole = {};
  for (const row of rows) {
    const ev = row && row.evidence && typeof row.evidence === 'object' ? row.evidence : {};
    if (ev.usageSources && typeof ev.usageSources === 'object') {
      for (const r of ev.usageSources.none || []) usageByRole[String(r)] = 'none';
      for (const r of ev.usageSources.file || []) usageByRole[String(r)] = 'file';
      for (const r of ev.usageSources.live || []) usageByRole[String(r)] = 'live';
    }
    if (row && row.role && ev.usageSource) usageByRole[String(row.role)] = String(ev.usageSource);
  }
  for (const row of rows) {
    const role = String(row.role || '');
    if (!role) continue;
    const stage = String(row.stage || '');
    const code = String(row.code || '');
    const item = byRole[role] || { last: null, pending: false, rotating: false, rebooting: false, failed: '', reason: '', state: 'idle' };
    item.last = row;
    if (stage === 'trigger') { item.pending = true; item.state = 'pending_handover'; item.reason = `已发交接请求，等回执（${String(row.at || '').slice(11, 16)}）`; }
    if (stage === 'rotate') { item.pending = false; item.state = 'rotating'; item.reason = String(row.note || '已换人'); }
    if (stage === 'broadcast_reboot') { item.rebooting = true; item.reason = String(row.note || '已广播重 boot'); }
    if (stage === 'skipped' && code === 'NIGHT_SILENT') { item.state = 'warn'; item.reason = '夜间静默（22–08）未换人'; }
    if (stage === 'enqueue') { item.state = 'warn'; item.reason = `已入队次日 08:00 执行（${String(row.evidence && row.evidence.level || '')}）`; }
    if (stage === 'skipped' && code === 'HANDOVER_TIMEOUT') { item.state = 'failed'; item.failed = 'HANDOVER_TIMEOUT'; item.reason = '交接超时：不换人，已升级 PM'; }
    if (String(row.result) === 'fail') { item.state = 'failed'; item.failed = code || 'rotate_failed'; }
    byRole[role] = item;
  }
  const out = {};
  for (const [role, item] of Object.entries(byRole)) {
    out[role] = {
      state: item.state || 'idle',
      reason: item.reason || '',
      auditTail: item.last ? `${String(item.last.stage || '')} · ${String(item.last.at || '')}` : '',
      error: item.failed || '',
      usageSource: usageByRole[role] || '',
    };
  }
  // 只有 cycle 行（role 为空）时也要把用量来源带出来，面板才不会对空角色丢字段。
  for (const [role, src] of Object.entries(usageByRole)) {
    if (out[role]) out[role].usageSource = src;
    else out[role] = { state: 'idle', reason: '', auditTail: '', error: '', usageSource: src };
  }
  return {
    byRole: out,
    rotatedToday: rotatedToday.length,
    failedToday: failedToday.length,
    summary: `今日自动换人 ${rotatedToday.length} 次 / 失败 ${failedToday.length} 次`,
  };
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
  const autoRotate = readAutoRotateSummary({ auditRows: options.autoRotateRows, now });
  // R-c9ac：停滞阈值（options.stallMs 优先；否则从 options.ui.sessionQueue.stallMs 热读；非法回落默认并标记 invalid）。
  const stallCfg = (Number.isFinite(Number(options.stallMs)) && Number(options.stallMs) > 0)
    ? { stallMs: Number(options.stallMs), invalid: Boolean(options.stallInvalid), raw: options.stallMs, reason: 'options' }
    : stallMsOf(options.ui);
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
      // R-c9ac：快照 v2 实时状态（五态 / 秒表 / 最近事件 / 停滞）——渲染层与团队台行同口径
      live: liveRowOf(entry, { now, stallMs: stallCfg.stallMs }),
      state: summary.state,
      failCount: summary.failCount,
      skipCount: summary.skipCount,
      okCount: summary.okCount,
      lastOkAt: summary.lastOkAt,
      lastAt: summary.lastAt,
      // B-20261117-181420-9688：最近失败时间（展示用；计数与四态分离，失败数不再决定状态）
      lastFailAt: summary.lastFailAt || '',
      // R-fa0e（3a12）§六：自动换人字段（无记录时 state=idle、审计尾为空，不伪造）
      autoRotate: autoRotate.byRole[role] || { state: 'idle', reason: '', auditTail: '', error: '', usageSource: '' },
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
    // R-c9ac：本次生效的停滞阈值（面板热读 ui.sessionQueue.stallMs；非法回落默认并给可见提示）
    live: { stallMs: stallCfg.stallMs, stallInvalid: Boolean(stallCfg.invalid), defaultStallMs: DEFAULT_STALL_MS, source: stallCfg.reason },
    backpressure: backpressureHint((rows.find((row) => row.role === 'pm') || {}).queued),
    // R-fa0e（3a12）§六：团队台只读汇总 [data-ar-summary]
    autoRotate: { summary: autoRotate.summary, rotatedToday: autoRotate.rotatedToday, failedToday: autoRotate.failedToday },
  };
}

/* ───────── R-c9ac：快照 v2 —— 五态 / 秒表 / 最近事件 / 停滞（纯逻辑，渲染层与团队台行共用口径） ───────── */

// 五态优先级（**写死，不许换序**）：
//   approval（pendingInput 含 approval）> blocked（含 question/other）> thinking（running===true）
//   > queued（非 running 且 queued>0）> idle；known:false 或快照缺失/过期 → unknown（未接入）。
const LIVE_STATE_LABEL = {
  approval: '待审批',
  blocked: '阻塞',
  thinking: '思考中',
  queued: '排队',
  idle: '空闲',
  unknown: '未接入',
};
const DEFAULT_STALL_MS = 600000; // 10 分钟：now - lastEventAt >= stallMs 判停滞
// 快照 5 秒无更新 / watch 不可用 → 面板降级（R-c9ac 口径）。
const PUSH_STALE_MS = 5000;

/** pendingInput 归一：小写、去空、去重，最多 20 个（快照最多写 20）。 */
function pendingInputOf(entry) {
  const list = entry && Array.isArray(entry.pendingInput) ? entry.pendingInput : [];
  const out = [];
  for (const raw of list) {
    const key = String(raw == null ? '' : raw).trim().toLowerCase();
    if (!key || out.includes(key)) continue;
    out.push(key);
    if (out.length >= 20) break;
  }
  return out;
}

/** 五态判定（未知不冒充：known!==true 一律 unknown）。 */
function liveStateOf(entry) {
  if (!entry || entry.known !== true) return 'unknown';
  const pending = pendingInputOf(entry);
  if (pending.includes('approval')) return 'approval';
  if (pending.includes('question') || pending.includes('other')) return 'blocked';
  if (entry.running === true) return 'thinking';
  if (Number(entry.queued) > 0) return 'queued';
  return 'idle';
}

/**
 * 停滞阈值热读：`ui.sessionQueue.stallMs`（默认 600000；非法回落 600000 并给出 invalid 供面板提示）。
 * @returns {{ stallMs:number, invalid:boolean, raw:*, reason:string }}
 */
function stallMsOf(ui) {
  const box = ui && typeof ui === 'object' ? ui.sessionQueue : null;
  const raw = box && typeof box === 'object' ? box.stallMs : (box === undefined ? undefined : box);
  const n = Number(raw);
  if (raw === undefined || raw === null || raw === '') return { stallMs: DEFAULT_STALL_MS, invalid: false, raw, reason: 'default' };
  if (!Number.isFinite(n) || n <= 0) return { stallMs: DEFAULT_STALL_MS, invalid: true, raw, reason: 'invalid' };
  return { stallMs: n, invalid: false, raw, reason: 'configured' };
}

/**
 * 停滞判定：lastEventAt 缺失不判停滞；unknown 行不判停滞。
 * @returns {{ stall:boolean, minutes:number|null, text:string, ageMs:number|null }}
 */
function stallOf({ now, lastEventAt, stallMs, state } = {}) {
  const base = { stall: false, minutes: null, text: '', ageMs: null };
  if (String(state || '') === 'unknown') return base;
  const at = Date.parse(String(lastEventAt || ''));
  if (!Number.isFinite(at)) return base;
  const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const threshold = Number(stallMs) > 0 ? Number(stallMs) : DEFAULT_STALL_MS;
  const ageMs = Math.max(0, ts - at);
  if (ageMs < threshold) return { ...base, ageMs };
  const minutes = Math.floor(ageMs / 60000);
  return { stall: true, minutes, text: `停滞 ${minutes} 分`, ageMs };
}

/** 秒表文本：thinking 行 mm:ss（按 runningSince 起算）；非 thinking 或缺 runningSince 一律「—」。 */
function thinkTextOf(entry, now) {
  const state = liveStateOf(entry);
  if (state !== 'thinking') return '—';
  const since = Date.parse(String((entry && entry.runningSince) || ''));
  if (!Number.isFinite(since)) return '—';
  const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const elapsed = Math.max(0, ts - since);
  const minutes = Math.floor(elapsed / 60000);
  const seconds = Math.floor((elapsed % 60000) / 1000);
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

/** 相对时间文本（最近事件列）；不可解析 → 「—」。 */
function relativeTimeText(iso, now) {
  const ms = Date.parse(String(iso || ''));
  if (!Number.isFinite(ms)) return '—';
  const ts = Number.isFinite(Number(now)) ? Number(now) : Date.now();
  const diff = Math.max(0, ts - ms);
  if (diff < 60 * 1000) return '刚刚';
  if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
  if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
  return `${Math.floor(diff / 86400000)} 天前`;
}

/** byPlacement 的 title 文本：必须同时含 queued/steering/context 三个数（未知给「—」）。 */
function byPlacementTitleOf(byPlacement) {
  const box = byPlacement && typeof byPlacement === 'object' ? byPlacement : null;
  const pick = (key) => {
    if (!box) return '—';
    const n = Number(box[key]);
    return Number.isFinite(n) ? String(n) : '—';
  };
  const q = pick('queued');
  const s = pick('steering');
  const c = pick('context');
  return `queued=${q} steering=${s} context=${c}`;
}

/**
 * 单角色 live 视图（buildPanelModel 的 rows[].live）。
 * 字段全部来自快照 v2；stall 用传入阈值计算（渲染层若要热读阈值，可自行用 stallOf 重算）。
 */
function liveRowOf(entry, { now, stallMs } = {}) {
  const state = liveStateOf(entry);
  const merged = {
    state,
    stateText: LIVE_STATE_LABEL[state] || LIVE_STATE_LABEL.unknown,
    known: Boolean(entry && entry.known === true),
    active: entry && entry.known === true ? entry.active === true : null,
    running: entry && entry.known === true ? entry.running === true : null,
    pendingInput: pendingInputOf(entry),
    queued: entry && entry.known === true ? Number(entry.queued) : null,
    byPlacement: entry && entry.byPlacement ? entry.byPlacement : null,
    byPlacementTitle: byPlacementTitleOf(entry && entry.byPlacement),
    runningSince: String((entry && entry.runningSince) || ''),
    lastEventAt: String((entry && entry.lastEventAt) || ''),
    cursor: entry && entry.cursor !== undefined ? entry.cursor : null,
    thinkText: thinkTextOf(entry, now),
    lastEventText: relativeTimeText(entry && entry.lastEventAt, now),
  };
  merged.stall = stallOf({ now, lastEventAt: merged.lastEventAt, stallMs, state });
  return merged;
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
  SNAPSHOT_MAX_BYTES,
  BACKPRESSURE_THRESHOLD,
  SKIP_VALUES,
  // R-c9ac：快照 v2（五态 / 停滞 / 秒表 / 相对时间 / byPlacement 文案）
  LIVE_STATE_LABEL,
  DEFAULT_STALL_MS,
  PUSH_STALE_MS,
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
  pendingInputOf,
  liveStateOf,
  stallMsOf,
  stallOf,
  thinkTextOf,
  relativeTimeText,
  byPlacementTitleOf,
  liveRowOf,
};
