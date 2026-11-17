'use strict';
/**
 * B-20261117-074103-75e9：打开文件夹的去重/节流（唯一实现，壳层 project:open 与 files:open 共用）。
 *
 * 现象：工作台「文件夹」按钮每点一次就 `shell.openPath` 一次 → 同一目录堆 19 个资源管理器窗口。
 * 口径（AC）：
 *   ① 同一路径 3 秒内重复触发 → 只开一个（throttle）；
 *   ② 该路径 5 分钟内已开过 → 不再新开，尽力聚焦已有窗口（focus 回调可选，失败不影响返回值）；
 *   ③ 首次点击行为不变（真调 openPath）；
 *   ④ stats() 暴露 opened/deduped/focused 计数，供自检断言「连点 5 次窗口数不增加」。
 *
 * 纯逻辑 + 注入：openPath / now / focus 都可注入，便于夹具在不弹窗口的情况下验证。
 */

const DEFAULT_DEDUPE_MS = 3000;
const DEFAULT_RECENT_MS = 5 * 60 * 1000;

function normalizeKey(target) {
  return String(target || '').trim().replace(/[\\/]+$/, '').replace(/\\/g, '/').toLowerCase();
}

function createFolderOpener(options = {}) {
  const {
    openPath,
    focus = null,
    now = () => Date.now(),
    dedupeMs = DEFAULT_DEDUPE_MS,
    recentMs = DEFAULT_RECENT_MS,
    maxEntries = 64,
  } = options;
  if (typeof openPath !== 'function') throw new Error('createFolderOpener 需要 openPath');
  const recent = new Map(); // key -> { at, path }
  const stats = { opened: 0, deduped: 0, focused: 0, throttleHits: 0, alreadyOpenHits: 0, focusFailed: 0 };

  function remember(key, target) {
    recent.delete(key);
    recent.set(key, { at: now(), path: String(target) });
    while (recent.size > maxEntries) {
      const oldest = recent.keys().next().value;
      recent.delete(oldest);
    }
  }

  /** 打开（或去重）。返回值：{ ok, opened, deduped, reason, path } */
  async function open(target) {
    const key = normalizeKey(target);
    if (!key) return { ok: false, opened: false, deduped: false, reason: 'empty-path', path: '' };
    const prev = recent.get(key);
    const age = prev ? (now() - prev.at) : Infinity;
    if (prev && age < dedupeMs) {
      stats.deduped += 1;
      stats.throttleHits += 1;
      return { ok: true, opened: false, deduped: true, reason: 'throttle', path: String(target), ageMs: age };
    }
    if (prev && age < recentMs) {
      stats.deduped += 1;
      stats.alreadyOpenHits += 1;
      let focused = false;
      if (typeof focus === 'function') {
        try { focused = await focus(String(target)) === true; } catch { focused = false; }
      }
      if (focused) stats.focused += 1; else stats.focusFailed += 1;
      remember(key, target);
      return { ok: true, opened: false, deduped: true, reason: 'already-open', focused, path: String(target), ageMs: age };
    }
    // 首次 / 超过 5 分钟：真开
    remember(key, target);
    stats.opened += 1;
    try {
      const r = await openPath(String(target));
      // shell.openPath 返回 '' 表示成功，非空字符串是错误信息（Electron 口径）
      if (typeof r === 'string' && r) return { ok: false, opened: true, deduped: false, reason: 'open-failed', message: r, path: String(target) };
      return { ok: true, opened: true, deduped: false, reason: 'opened', path: String(target) };
    } catch (error) {
      return { ok: false, opened: true, deduped: false, reason: 'open-threw', message: String((error && error.message) || error), path: String(target) };
    }
  }

  const statsOf = () => ({ ...stats, recentSize: recent.size, dedupeMs, recentMs });

  return { open, stats: statsOf, _reset: () => { recent.clear(); Object.keys(stats).forEach((k) => { stats[k] = 0; }); } };
}

module.exports = { createFolderOpener, normalizeKey, DEFAULT_DEDUPE_MS, DEFAULT_RECENT_MS };
