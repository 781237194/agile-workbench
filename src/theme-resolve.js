'use strict';
/**
 * theme-resolve.js —— 主题解析（R-fe90 主题系统 5 档 · 核心纯函数）
 *
 * 设计约束（见需求正文 + 增补卷-fe90-1）：
 *  · 双维度：data-style ∈ {native, tech, anime, glass} × data-theme ∈ {dark, light}
 *  · 合法组合只有 5 个：native-dark / native-light / tech-dark / anime-dark / glass-dark
 *  · 旧的 html[data-theme="light"] 选择器必须继续存在（暖白靠它）→ 本模块只负责算出
 *    {style, theme} 两个属性值，不碰 DOM
 *  · 迁移：dark → native-dark（暗金，老用户保持）、light → native-light（暖白，老用户保持）
 *  · 无值 → tech-dark（新默认）；非法值 → 回落 tech-dark + 一条 console.warn（带输入值与采用值）
 *  · ?theme= 优先于 storage；即使 URL 值非法也要能分辨「URL 生效但回落」与「根本没传」
 *    → 返回值带 source ∈ {url, storage, default} 与 fallback 布尔
 *
 * 本文件零 DOM 依赖，可用 node 直接 import 测试（见 scripts/test-theme-resolve.cjs）。
 */

const STYLES = Object.freeze(['native', 'tech', 'anime', 'glass']);
const THEMES = Object.freeze(['dark', 'light']);

/** 合法组合（只 5 个；tech/anime/glass 的 light 变体一律不实现、不暴露、不进入口） */
const LEGAL_THEME_IDS = Object.freeze(['native-dark', 'native-light', 'tech-dark', 'anime-dark', 'glass-dark']);

/** 新默认（无值时） */
const DEFAULT_THEME_ID = 'tech-dark';

/** 老用户旧值迁移（保持原观感：dark=暗金、light=暖白） */
const LEGACY_THEME_IDS = Object.freeze({ dark: 'native-dark', light: 'native-light' });

/** 入口展示顺序（更多→外观 5 项，文案在 renderer 里） */
const THEME_ORDER = Object.freeze(['native-dark', 'native-light', 'tech-dark', 'anime-dark', 'glass-dark']);

const THEME_NAMES = Object.freeze({
  'native-dark': '暗金',
  'native-light': '暖白',
  'tech-dark': '科技暗',
  'anime-dark': '二次元暗',
  'glass-dark': '玻璃拟态暗',
});

function isLegalThemeId(id) {
  return typeof id === 'string' && LEGAL_THEME_IDS.includes(id);
}

/** 拆 themeId → {style, theme}；非法返回 null（不猜） */
function splitThemeId(id) {
  const s = String(id == null ? '' : id).trim();
  if (!isLegalThemeId(s)) return null;
  const at = s.lastIndexOf('-');
  return { style: s.slice(0, at), theme: s.slice(at + 1) };
}

/** themeId → 写进 DOM 的两个属性（style/theme），非法返回 null */
function themeAttrs(themeId) {
  const parts = splitThemeId(themeId);
  if (!parts) return null;
  return { style: parts.style, theme: parts.theme };
}

/** 从 search 串（'?theme=xxx' 或 'theme=xxx'）取 theme 值；没有则 null（空串也当没传） */
function themeFromSearch(search) {
  const raw = String(search == null ? '' : search);
  const i = raw.indexOf('theme=');
  if (i < 0) return null;
  let value = raw.slice(i + 'theme='.length);
  const amp = value.indexOf('&');
  if (amp >= 0) value = value.slice(0, amp);
  value = value.trim();
  return value === '' ? null : value;
}

/**
 * 核心解析。
 * @param {object} input { storageValue, search }（storageValue 可以是旧值 dark/light）
 * @param {object} [opts] { onWarn(message, detail) }
 * @returns {{themeId:string, style:string, theme:string, source:'url'|'storage'|'default', fallback:boolean}}
 */
function resolveTheme(input, opts) {
  const src = input && typeof input === 'object' ? input : {};
  const options = opts && typeof opts === 'object' ? opts : {};
  const warn = typeof options.onWarn === 'function' ? options.onWarn : null;
  const storageRaw = src.storageValue == null ? '' : String(src.storageValue).trim();
  const urlRaw = themeFromSearch(src.search);

  const adopt = (themeId, source, fallback, from) => {
    if (fallback && warn) {
      warn(`[theme] fallback: 输入「${from}」不是合法主题，已采用「${themeId}」`, { from, adopted: themeId, source });
    }
    const parts = splitThemeId(themeId);
    return { themeId, style: parts.style, theme: parts.theme, source, fallback };
  };

  // ① URL 优先：合法就用；非法也要标 source:'url' + fallback（否则「参数被忽略」会被误判为生效）
  if (urlRaw != null) {
    if (isLegalThemeId(urlRaw)) return adopt(urlRaw, 'url', false, urlRaw);
    const migrated = LEGACY_THEME_IDS[urlRaw];
    if (migrated) return adopt(migrated, 'url', false, urlRaw); // ?theme=light 也当合法旧值
    return adopt(DEFAULT_THEME_ID, 'url', true, urlRaw);
  }

  // ② storage：新值直接认；旧值 dark/light 迁移；非法回落
  if (storageRaw) {
    if (isLegalThemeId(storageRaw)) return adopt(storageRaw, 'storage', false, storageRaw);
    const migrated = LEGACY_THEME_IDS[storageRaw];
    if (migrated) return adopt(migrated, 'storage', false, storageRaw);
    return adopt(DEFAULT_THEME_ID, 'storage', true, storageRaw);
  }

  // ③ 无值 → 新默认
  return adopt(DEFAULT_THEME_ID, 'default', false, '');
}

/** storageValue 是否需要在写回时升级（旧值或非法值 → 应写新值；已是合法新值 → 不需要） */
function shouldMigrateStorage(storageValue) {
  const raw = storageValue == null ? '' : String(storageValue).trim();
  if (!raw) return false;
  return !isLegalThemeId(raw);
}

module.exports = {
  STYLES,
  THEMES,
  LEGAL_THEME_IDS,
  DEFAULT_THEME_ID,
  LEGACY_THEME_IDS,
  THEME_ORDER,
  THEME_NAMES,
  isLegalThemeId,
  splitThemeId,
  themeAttrs,
  themeFromSearch,
  resolveTheme,
  shouldMigrateStorage,
};
