'use strict';
/**
 * R-c4c7（T-20261115-195024-5369）· 团队收件箱实时面板的数据层（纯 Node，可在无 Electron 下单测）。
 *
 * 口径（增补卷 §二）：一期只算「团队邮箱 状态/邮箱/<role>/new 条数」+「role_queues.json 里 status=pending 条数」；
 * **不含 DSH 运行时队列**（那是 sessionController 的服务，二期）。
 *
 * 硬性约束：
 * - **零轮询**：只有文件事件（fs.watch）去抖后才重算；渲染层只在「首屏」与「重新聚焦且距上次事件 >10s」各拉一次。
 *   唯一例外＝降级兜底：watch 失效后才启用 30s 递归 setTimeout（**不是 setInterval**，且计入 degradedCount）。
 * - **只读**：不写邮箱、不 ack、不 read；唯一写是 `收件箱监听.jsonl` 的 degraded/recovered 审计。
 * - **不读 body**：最新 3 条只取 from/subject/ts。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROLE_IDS = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
const ROLE_DIRS = {
  pm: '项目经理', product: '产品', analyst: '需求分析师', programmer1: '程序员A', programmer2: '程序员B', tester: '测试人员',
};
const ROLE_NAMES = {
  pm: '项目经理', product: '产品设计师', analyst: '需求分析师', programmer1: '高级程序员 A', programmer2: '高级程序员 B', tester: '测试人员',
};
const LATEST_N = 3;
const DEFAULT_DEBOUNCE_MS = 300;
const DEFAULT_FALLBACK_MS = 30000;
// B-20261116-114813-c7a1：未降级态的存在性核对间隔（30s）。AC3 口径：这是唯一新增的「非事件驱动」读取，
// 只 stat 邮箱根目录（不读文件内容），并计入 state().healthChecks 便于审计。
const DEFAULT_HEALTH_MS = 30000;

function readDirEntries(dir) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    if (error && (error.code === 'ENOENT' || error.code === 'ENOTDIR')) return null;
    try { console.warn('[mailbox] readdir failed: ' + JSON.stringify({ dir, code: (error && error.code) || '' })); } catch { /* ignore */ }
    return null;
  }
}

function readJson(file) {
  try {
    return JSON.parse(String(fs.readFileSync(file, 'utf8')).replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function safeReadJson(file) {
  try { return readJson(file); } catch { return null; }
}

/** 名册里的显示名（缺名册/缺成员 → ROLE_DIRS 兜底，roleId 不变） */
function memberNames(teamRoot) {
  const names = {};
  const team = safeReadJson(path.join(teamRoot, '状态', '团队.json'));
  const members = (team && Array.isArray(team.members)) ? team.members : [];
  for (const member of members) {
    const id = String((member && member.role) || '');
    if (!id) continue;
    const name = String((member && member.name) || '').trim();
    if (name) names[id] = name;
  }
  return names;
}

/** 行集合按 团队.json 名册（full 六行 / fast 四行）；名册缺失退回固定六角色 */
function roleIdsFromTeam(teamRoot) {
  const team = safeReadJson(path.join(teamRoot, '状态', '团队.json'));
  const members = (team && Array.isArray(team.members)) ? team.members : [];
  const active = members
    .filter((member) => String((member && member.status) || 'active') === 'active')
    .map((member) => String((member && member.role) || ''))
    .filter((role) => ROLE_IDS.includes(role));
  return active.length ? ROLE_IDS.filter((role) => active.includes(role)) : ROLE_IDS.slice();
}

/** 邮箱 new 目录现状：条数 + 最新 3 条（**只取 from/subject/ts，不读 body**） */
function readMailboxRole(teamRoot, roleId) {
  const dir = path.join(teamRoot, '状态', '邮箱', roleId, 'new');
  const entries = readDirEntries(dir);
  const result = { dir, dirMissing: entries === null, mailNew: 0, mailLatest: [], parseErrors: 0 };
  if (!entries) return result;
  const files = entries.filter((entry) => entry.isFile() && /\.json$/i.test(entry.name)).map((entry) => entry.name);
  files.sort((a, b) => (a < b ? 1 : a > b ? -1 : 0)); // 文件名前缀是 ISO 时间戳 → 倒序即最新在前
  result.mailNew = files.length;
  for (const name of files.slice(0, LATEST_N)) {
    const data = readJson(path.join(dir, name));
    if (!data) { result.parseErrors += 1; continue; }
    result.mailLatest.push({
      file: name,
      at: String(data.ts || ''),
      from: String(data.from || ''),
      subject: String(data.subject || '').slice(0, 120),
      ackRequired: Boolean(data.ackRequired),
    });
  }
  return result;
}

/** 任务队列：roles.<role>.queue[] 里 status=pending 的条数 + 最新 3 条 */
function readRoleQueues(stateDir) {
  const file = path.join(stateDir, 'role_queues.json');
  const raw = safeReadJson(file);
  const out = { file, exists: Boolean(raw), generatedAt: String((raw && raw.generatedAt) || ''), roles: {} };
  if (!raw) return out;
  const roles = (raw && raw.roles && typeof raw.roles === 'object') ? raw.roles : {};
  for (const [roleId, value] of Object.entries(roles)) {
    const queue = (value && Array.isArray(value.queue)) ? value.queue.filter(Boolean) : [];
    const pending = queue.filter((row) => String((row && row.status) || '') === 'pending');
    pending.sort((a, b) => String((b && b.createdAt) || '').localeCompare(String((a && a.createdAt) || '')));
    out.roles[roleId] = {
      queuePending: pending.length,
      queueLatest: pending.slice(0, LATEST_N).map((row) => ({
        taskId: String((row && row.taskId) || ''),
        action: String((row && row.action) || ''),
        priority: String((row && row.priority) || ''),
        createdAt: String((row && row.createdAt) || ''),
      })),
    };
  }
  return out;
}

/** 生成一份快照（只读）。stateDir = 团队/状态/项目/<slug>/ */
function buildSnapshot({ teamRoot, stateDir, projectName = '', roleIds = ROLE_IDS, extra = {} } = {}) {
  const names = memberNames(teamRoot);
  const queues = readRoleQueues(stateDir);
  const roles = {};
  let totalMail = 0;
  let totalQueue = 0;
  let parseErrors = 0;
  for (const roleId of roleIds) {
    const mailbox = readMailboxRole(teamRoot, roleId);
    const queue = queues.roles[roleId] || { queuePending: 0, queueLatest: [] };
    totalMail += mailbox.mailNew;
    totalQueue += queue.queuePending;
    parseErrors += mailbox.parseErrors;
    roles[roleId] = {
      roleId,
      roleName: names[roleId] || ROLE_DIRS[roleId] || roleId,
      mailNew: mailbox.mailNew,
      mailLatest: mailbox.mailLatest,
      queuePending: queue.queuePending,
      queueLatest: queue.queueLatest,
      dirMissing: mailbox.dirMissing,
      parseErrors: mailbox.parseErrors,
      lastChangeAt: '',
    };
  }
  let busiest = null;
  for (const roleId of roleIds) {
    const row = roles[roleId];
    const backlog = row.mailNew + row.queuePending;
    if (!busiest || backlog > busiest.count) busiest = { roleId, roleName: row.roleName, count: backlog, mailNew: row.mailNew, queuePending: row.queuePending };
  }
  return {
    at: new Date().toISOString(),
    project: projectName,
    scope: 'mailbox+queue',
    roles,
    totals: { mail: totalMail, queue: totalQueue, all: totalMail + totalQueue },
    total: totalMail + totalQueue,
    busiestRole: busiest && busiest.count > 0 ? busiest : null,
    parseErrors,
    queueGeneratedAt: queues.generatedAt,
    queueMissing: !queues.exists,
    ...extra,
  };
}

/**
 * 主进程 watch 管理器。
 * watch 目标：
 *   ①`<teamRoot>/状态/邮箱` **递归**监听（Windows/macOS 支持）；文件级新增/改名、角色目录被 rename 都能收到事件；
 *     若运行环境不支持递归 watch，则退化为「邮箱根目录 + 六角色 new/cur 共 13 个非递归 watch」。
 *   ②项目状态目录（只认 `role_queues.json` 事件）。
 * 健康判定（不轮询）：**只在本进程收到事件/兜底 tick 时**用 stat/readdir 核对——某个「上次还在」的 new 目录
 * 消失即视为监听失效 → 降级；目录回来后重建 watcher + 补齐数据 + 写 recovered 审计。
 */
function createMailboxWatcher(options = {}) {
  const {
    teamRoot,
    stateDir,
    projectName = '',
    roleIds = ROLE_IDS,
    debounceMs = DEFAULT_DEBOUNCE_MS,
    fallbackMs = DEFAULT_FALLBACK_MS,
    auditFile = '',
    logger = console,
  } = options;

  const watchers = new Map(); // key -> FSWatcher
  const failures = new Map(); // key -> reason
  const timers = { debounce: null, fallback: null, health: null };
  // B-20261116-114813-c7a1：**未降级态**的轻量存在性核对间隔（默认 30s，自检可用 AWB_MAILBOX_HEALTH_MS 调小）。
  // 唯一原因：邮箱根目录整体 rename 不在监听树内产生事件 → 以前只能等下一次事件，面板静默停旧值。
  const healthMs = Math.max(500, Number(options.healthMs || process.env.AWB_MAILBOX_HEALTH_MS || DEFAULT_HEALTH_MS) || DEFAULT_HEALTH_MS);
  let healthChecks = 0;
  let lastHealthAt = '';
  let rootVanished = false;
  let snapshot = null;
  let started = false;
  let degraded = false;
  let degradedCount = 0;
  let degradedReason = '';
  let lastError = '';
  let changeSeq = 0;
  let listeners = [];
  let knownNewDirs = null; // roleId -> bool（上次核对时 new 目录是否存在）
  const missingDirs = new Set(); // 降级原因：这些角色的 new 目录消失了（回来才允许恢复）
  let lastEventAt = 0;
  let lastSignature = '';

  const warn = (message) => { try { logger.warn(message); } catch { /* ignore */ } };

  const audit = (action, reason) => {
    if (!auditFile) return;
    try {
      fs.mkdirSync(path.dirname(auditFile), { recursive: true });
      fs.appendFileSync(auditFile, JSON.stringify({
        at: new Date().toISOString(),
        action,
        reason: String(reason || '').slice(0, 200),
        backlog: snapshot ? snapshot.total : null,
      }) + '\n', 'utf8');
    } catch (error) {
      warn('[mailbox] audit failed: ' + String((error && error.message) || error).slice(0, 160));
    }
  };

  const newDirOf = (roleId) => path.join(teamRoot, '状态', '邮箱', roleId, 'new');

  const emit = (reason) => {
    if (!snapshot) return null;
    snapshot.source = reason;
    for (const listener of listeners) {
      try { listener(snapshot); } catch { /* 单个订阅者异常不影响其它 */ }
    }
    return snapshot;
  };

  const recompute = (reason = 'watch') => {
    let next;
    try {
      next = buildSnapshot({ teamRoot, stateDir, projectName, roleIds });
    } catch (error) {
      lastError = String((error && error.message) || error).slice(0, 200);
      warn('[mailbox] snapshot failed: ' + lastError);
      return snapshot;
    }
    lastEventAt = Date.now();
    next.degraded = degraded;
    next.degradedCount = degradedCount;
    next.degradedReason = degradedReason;
    next.lastSuccessAt = new Date().toISOString();
    next.fallbackMs = fallbackMs;
    next.lastError = lastError;
    next.changeSeq = ++changeSeq;
    next.source = reason;
    // 去重：Windows 一次写入常连发 rename+change 两条事件，若数据没变就不重复推送（避免事件噪声）。
    const signature = JSON.stringify({
      roles: roleIds.map((roleId) => {
        const row = next.roles[roleId];
        return [roleId, row.mailNew, row.queuePending, row.mailLatest.map((item) => item.file), row.queueLatest.map((item) => item.taskId), row.dirMissing];
      }),
      queueGeneratedAt: next.queueGeneratedAt,
      degraded: next.degraded,
      degradedCount: next.degradedCount,
    });
    knownNewDirs = {};
    for (const roleId of roleIds) knownNewDirs[roleId] = !next.roles[roleId].dirMissing;
    if (signature === lastSignature && reason !== 'initial' && reason !== 'recovered' && reason !== 'degraded') {
      return snapshot; // 数据没变：不刷新 at、不推送
    }
    lastSignature = signature;
    snapshot = next;
    return emit(reason);
  };

  const scheduleRecompute = (reason) => {
    clearTimeout(timers.debounce);
    timers.debounce = setTimeout(() => { timers.debounce = null; recompute(reason); }, Math.max(50, Number(debounceMs) || DEFAULT_DEBOUNCE_MS));
    if (timers.debounce && typeof timers.debounce.unref === 'function') timers.debounce.unref();
  };

  const enterDegraded = (reason) => {
    lastError = String(reason || '').slice(0, 200);
    if (degraded) return;
    degraded = true;
    degradedCount += 1;
    degradedReason = lastError;
    warn('[mailbox] degraded: ' + degradedReason);
    recompute('degraded');
    audit('degraded', reason);
    scheduleFallback();
  };

  const leaveDegraded = () => {
    if (!degraded) return;
    degraded = false;
    degradedReason = '';
    audit('recovered', 'watch reattached');
    recompute('recovered');
  };

  const onWatchError = (key) => (error) => {
    failures.set(key, 'WATCH_ERROR ' + String((error && (error.code || error.message)) || error).slice(0, 120));
    const watcher = watchers.get(key);
    watchers.delete(key);
    try { watcher.close(); } catch { /* ignore */ }
    enterDegraded(failures.get(key));
    scheduleFallback();
  };

  const attachMailboxWatch = () => {
    if (watchers.has('mailbox')) return true;
    const root = path.join(teamRoot, '状态', '邮箱');
    try {
      const watcher = fs.watch(root, { recursive: true }, (_event, filename) => {
        // 事件到达即核对目录存在性（用**事件前**的 knownNewDirs 判「原本还在的目录不见了」）——
        // 这一步只在本进程收到事件时做，不是轮询。
        checkHealth();
        if (degraded) reattach();
        scheduleRecompute('watch');
      });
      watcher.on('error', onWatchError('mailbox'));
      watchers.set('mailbox', watcher);
      failures.delete('mailbox');
      return true;
    } catch (error) {
      const code = String((error && error.code) || '');
      failures.set('mailbox', 'WATCH_FAIL ' + code);
      if (code === 'ENOENT' || code === 'ENOTDIR') return false; // 邮箱还没建：等事件/兜底再试
      if (code === 'ERR_FEATURE_UNAVAILABLE_ON_PLATFORM' || /recursive/i.test(String((error && error.message) || ''))) {
        return attachFallbackWatches();
      }
      enterDegraded(failures.get('mailbox'));
      return false;
    }
  };

  /** 递归 watch 不可用时的退化方案：邮箱根 + 六角色 new/cur（13 个非递归 watch） */
  const attachFallbackWatches = () => {
    const targets = [{ key: 'mailbox-root', dir: path.join(teamRoot, '状态', '邮箱') }];
    for (const roleId of roleIds) {
      for (const box of ['new', 'cur']) targets.push({ key: `mail:${roleId}:${box}`, dir: path.join(teamRoot, '状态', '邮箱', roleId, box) });
    }
    let ok = false;
    for (const { key, dir } of targets) {
      if (watchers.has(key)) { ok = true; continue; }
      try {
        const watcher = fs.watch(dir, () => scheduleRecompute('watch'));
        watcher.on('error', onWatchError(key));
        watchers.set(key, watcher);
        failures.delete(key);
        ok = true;
      } catch (error) {
        failures.set(key, 'WATCH_FAIL ' + String((error && error.code) || ''));
      }
    }
    if (!ok) enterDegraded('NO_WATCH_AVAILABLE');
    return ok;
  };

  const attachQueueWatch = () => {
    if (watchers.has('queue')) return true;
    try {
      const watcher = fs.watch(stateDir, (_event, filename) => {
        const changed = String(filename || '');
        if (changed && !changed.startsWith('role_queues.json')) return;
        scheduleRecompute('watch');
      });
      watcher.on('error', onWatchError('queue'));
      watchers.set('queue', watcher);
      failures.delete('queue');
      return true;
    } catch (error) {
      const code = String((error && error.code) || '');
      failures.set('queue', 'WATCH_FAIL ' + code);
      if (code !== 'ENOENT' && code !== 'ENOTDIR') enterDegraded(failures.get('queue'));
      return false;
    }
  };

  /** 只在「收到事件」后核对：某个上次还在的 new 目录消失 / 邮箱根消失 → 监听失效 */
  const checkHealth = () => {
    // c7a1：事件路径也顺便核一次根目录（rename 后若有其他事件到达，可立刻降级，不必等 30s）
    let rootExists = true;
    try { fs.statSync(path.join(teamRoot, '状态', '邮箱')); } catch { rootExists = false; }
    if (!rootExists) {
      rootVanished = true;
      for (const key of ['mailbox', 'mailbox-root']) {
        const watcher = watchers.get(key);
        if (watcher) { try { watcher.close(); } catch { /* ignore */ } watchers.delete(key); }
      }
      enterDegraded('ROOT_VANISHED 邮箱根目录不存在（疑似整体 rename）');
      scheduleFallback();
      return;
    }
    if (!knownNewDirs) return;
    const vanished = [];
    for (const roleId of roleIds) {
      if (!knownNewDirs[roleId]) continue;
      if (!fs.existsSync(newDirOf(roleId))) vanished.push(roleId);
    }
    if (vanished.length) {
      for (const roleId of vanished) missingDirs.add(roleId);
      enterDegraded('DIR_VANISHED ' + vanished.join(','));
      scheduleFallback();
    }
  };

  const scheduleFallback = () => {
    if (timers.fallback) return;
    const tick = () => {
      timers.fallback = null;
      try {
        // 降级兜底：唯一允许的「周期性」动作，且只在 degraded 期间存在
        recompute('fallback');
        reattach();
      } catch (error) {
        lastError = String((error && error.message) || error).slice(0, 200);
      }
      if (degraded) {
        timers.fallback = setTimeout(tick, fallbackMs);
        if (timers.fallback && typeof timers.fallback.unref === 'function') timers.fallback.unref();
      }
    };
    timers.fallback = setTimeout(tick, fallbackMs);
    if (timers.fallback && typeof timers.fallback.unref === 'function') timers.fallback.unref();
  };

  const reattach = () => {
    attachMailboxWatch();
    attachQueueWatch();
    let stillBad = false;
    for (const [key, reason] of failures.entries()) {
      if (reason === 'ENOENT') continue; // 尚未创建不算坏
      if (!watchers.has(key)) stillBad = true;
    }
    for (const roleId of roleIds) {
      if (knownNewDirs && knownNewDirs[roleId] && !fs.existsSync(newDirOf(roleId))) stillBad = true;
    }
    for (const roleId of Array.from(missingDirs)) {
      if (fs.existsSync(newDirOf(roleId))) missingDirs.delete(roleId);
      else stillBad = true;
    }
    // c7a1：根目录整体 rename 后恢复——根回来了才允许解除降级
    if (rootVanished) {
      let rootBack = true;
      try { fs.statSync(path.join(teamRoot, '状态', '邮箱')); } catch { rootBack = false; }
      if (rootBack) rootVanished = false;
      else stillBad = true;
    }
    if (!stillBad && degraded) leaveDegraded();
  };

  /**
   * B-20261116-114813-c7a1：**未降级态**的轻量存在性核对（默认 30s 一次 stat 邮箱根目录）。
   * 背景：邮箱根目录整体 rename 不在监听树内产生事件，旧实现只能等下一次子目录事件，面板会静默停在旧数字。
   * 边界（AC3）：只 stat，不读文件内容；降级期间由 fallback（30s 递归重算+重建）接手，这里不重复跑；都是 setTimeout 链，不是 setInterval。
   */
  const scheduleHealthCheck = () => {
    if (!started || timers.health) return;
    timers.health = setTimeout(() => {
      timers.health = null;
      if (!started) return;
      if (!degraded) {
        const root = path.join(teamRoot, '状态', '邮箱');
        let exists = true;
        try { fs.statSync(root); } catch { exists = false; }
        healthChecks += 1;
        lastHealthAt = new Date().toISOString();
        if (!exists) {
          rootVanished = true;
          // 旧 watcher 挂在已消失的 inode 上：先关掉，恢复时由 reattach() 重建
          for (const key of ['mailbox', 'mailbox-root']) {
            const watcher = watchers.get(key);
            if (watcher) { try { watcher.close(); } catch { /* ignore */ } watchers.delete(key); }
          }
          enterDegraded('ROOT_VANISHED 邮箱根目录不存在（疑似整体 rename）');
        }
      }
      scheduleHealthCheck();
    }, healthMs);
    if (timers.health && typeof timers.health.unref === 'function') timers.health.unref();
  };

  const start = () => {
    if (started) return snapshot;
    started = true;
    attachMailboxWatch();
    attachQueueWatch();
    recompute('initial');
    scheduleHealthCheck();
    return snapshot;
  };

  const stop = () => {
    started = false;
    clearTimeout(timers.debounce);
    clearTimeout(timers.fallback);
    clearTimeout(timers.health);
    timers.debounce = null;
    timers.fallback = null;
    timers.health = null;
    for (const watcher of watchers.values()) { try { watcher.close(); } catch { /* ignore */ } }
    watchers.clear();
  };

  return {
    start,
    stop,
    recompute,
    getSnapshot: () => snapshot,
    getLastEventAt: () => lastEventAt,
    subscribe: (listener) => {
      if (typeof listener !== 'function') return () => {};
      listeners.push(listener);
      return () => { listeners = listeners.filter((item) => item !== listener); };
    },
    state: () => ({
      started,
      degraded,
      degradedCount,
      degradedReason,
      lastError,
      lastSuccessAt: snapshot ? snapshot.lastSuccessAt : '',
      watched: Array.from(watchers.keys()),
      failures: Object.fromEntries(failures),
      roles: roleIds,
      stateDir,
      // c7a1：AC3 的「新增读取频次」口径 —— 30s 一次 stat 邮箱根，只 stat 不读内容
      healthCheckMs: healthMs,
      healthChecks,
      lastHealthAt,
      rootVanished,
    }),
  };
}

module.exports = {
  ROLE_IDS,
  ROLE_DIRS,
  ROLE_NAMES,
  LATEST_N,
  DEFAULT_DEBOUNCE_MS,
  DEFAULT_FALLBACK_MS,
  memberNames,
  roleIdsFromTeam,
  readMailboxRole,
  readRoleQueues,
  buildSnapshot,
  createMailboxWatcher,
};
