'use strict';
/**
 * theme-manifest.js —— 主题清单唯一来源（R-20261116-063521-fe90 · F-2）
 *
 * 设计约束（见需求正文 §四 F-2 / §八-4，及增补卷-fe90-1 §二）：
 *  · 双维度：data-style ∈ {native, tech, anime, glass} × data-theme ∈ {dark, light}
 *  · 合法组合**只有 5 个**：native-dark / native-light / tech-dark / anime-dark / glass-dark
 *  · 旧 `html[data-theme="light"]` 选择器必须继续存在（暖白靠它）→ 本模块只算 {style, theme}，
 *    不碰 DOM、不写盘、不读 location（首帧脚本与 app.js 各自把 storage/search 传进来）
 *  · 迁移：dark → native-dark（暗金保持）、light → native-light（暖白保持）；无值 → tech-dark
 *  · 非法值 → 回落 tech-dark，`fallback:true` 且 `reason` 含输入原值，一次解析只 warn 一次
 *  · `?theme=` 优先于 storage，但**不持久化**（由调用方按 source==='url' 决定不写 storage）
 *
 * 可直接被 node `import()`/`require()`：模块顶层不访问 document/window，
 * 只在末尾把清单挂到全局对象（浏览器里就是 window），供 `<script>` 与 CDP 使用。
 */

const STYLES = Object.freeze(['native', 'tech', 'anime', 'glass']);
const THEME_MODES = Object.freeze(['dark', 'light']);

/** 5 个主题（顺序即「更多 → 外观」菜单顺序） */
const THEMES = Object.freeze([
  Object.freeze({ id: 'native-dark', style: 'native', theme: 'dark', label: '暗金', desc: '现有深色：暗底 + 金色点缀' }),
  Object.freeze({ id: 'native-light', style: 'native', theme: 'light', label: '暖白', desc: '唯一浅色：米白底 + 暖金' }),
  Object.freeze({ id: 'tech-dark', style: 'tech', theme: 'dark', label: '科技暗', desc: '冷蓝霓虹 + 网格底纹（默认）' }),
  Object.freeze({ id: 'anime-dark', style: 'anime', theme: 'dark', label: '二次元暗', desc: '高明度渐变 + 圆角大字' }),
  Object.freeze({ id: 'glass-dark', style: 'glass', theme: 'dark', label: '玻璃拟态暗', desc: '毛玻璃面板 + 柔光' }),
]);

/** 新默认（无值时） */
const DEFAULT_THEME_ID = 'tech-dark';

/** 合法 id（由清单派生，禁止在别处再写一份） */
const LEGAL_THEME_IDS = Object.freeze(THEMES.map((t) => t.id));

/** 入口顺序 */
const THEME_ORDER = Object.freeze(THEMES.map((t) => t.id));

/** id → 中文名 */
const THEME_NAMES = Object.freeze(THEMES.reduce((acc, t) => {
  acc[t.id] = t.label;
  return acc;
}, {}));

/** 老用户旧值迁移（保持原观感：dark=暗金、light=暖白） */
const LEGACY_THEME_IDS = Object.freeze({ dark: 'native-dark', light: 'native-light' });

function isLegalThemeId(id) {
  return typeof id === 'string' && LEGAL_THEME_IDS.indexOf(id) >= 0;
}

/** 取清单项（非法返回 null，不猜） */
function themeEntry(id) {
  const key = typeof id === 'string' ? id : '';
  for (const t of THEMES) if (t.id === key) return t;
  return null;
}

/** themeId → {style, theme}；非法返回 null */
function splitThemeId(id) {
  const entry = themeEntry(typeof id === 'string' ? id.trim() : id);
  return entry ? { style: entry.style, theme: entry.theme } : null;
}

/** themeId → 写进 DOM 的两个属性（style/theme）；非法返回 null */
function themeAttrs(themeId) {
  const parts = splitThemeId(themeId);
  if (!parts) return null;
  return { style: parts.style, theme: parts.theme };
}

/** 从 search 串（'?theme=xxx' / 'theme=xxx'）取 theme 值；没有则 null（空串也当没传） */
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
 * @param {object|string} input {storageValue, search}；传字符串视同 {storageValue: <字符串>}
 * @param {object} [opts] {onWarn(message, detail)}
 * @returns {{themeId:string, style:string, theme:string,
 *            source:'url'|'storage'|'default', fallback:boolean, reason:string}}
 */
function resolveTheme(input, opts) {
  const src = typeof input === 'string'
    ? { storageValue: input, search: '' }
    : (input && typeof input === 'object' ? input : {});
  const options = opts && typeof opts === 'object' ? opts : {};
  const warn = typeof options.onWarn === 'function' ? options.onWarn : null;

  const storageRaw = src.storageValue == null ? '' : String(src.storageValue).trim();
  const urlRaw = themeFromSearch(src.search);

  const adopt = (themeId, source, fallback, from) => {
    const parts = splitThemeId(themeId) || { style: 'tech', theme: 'dark' };
    const reason = fallback
      ? `输入「${from}」不是合法主题（来源 ${source}），已采用「${themeId}」`
      : '';
    if (fallback) {
      const message = `[theme] fallback: 输入「${from}」→ 采用「${themeId}」（来源 ${source}）`;
      if (warn) warn(message, { from, adopted: themeId, source });
      else if (typeof console !== 'undefined' && console && typeof console.warn === 'function') console.warn(message);
    }
    return { themeId, style: parts.style, theme: parts.theme, source, fallback, reason };
  };

  // ① URL 优先：合法直接用；非法也标 source:'url' + fallback（否则「参数被忽略」会被误判为生效）
  if (urlRaw != null) {
    if (isLegalThemeId(urlRaw)) return adopt(urlRaw, 'url', false, urlRaw);
    const migrated = LEGACY_THEME_IDS[urlRaw];
    if (migrated) return adopt(migrated, 'url', false, urlRaw); // ?theme=light 也当合法旧值
    return adopt(DEFAULT_THEME_ID, 'url', true, urlRaw);
  }

  // ② storage：合法新值直接认；旧值迁移；非法回落
  if (storageRaw) {
    if (isLegalThemeId(storageRaw)) return adopt(storageRaw, 'storage', false, storageRaw);
    const migrated = LEGACY_THEME_IDS[storageRaw];
    if (migrated) return adopt(migrated, 'storage', false, storageRaw);
    return adopt(DEFAULT_THEME_ID, 'storage', true, storageRaw);
  }

  // ③ 无值 → 新默认（老用户不会被强行换肤：dark/light 已在 ② 迁移）
  return adopt(DEFAULT_THEME_ID, 'default', false, '');
}

/** storageValue 是否需要在写回时升级（旧值/非法值 → 写新值；已是合法新值 → 不写） */
function shouldMigrateStorage(storageValue) {
  const raw = storageValue == null ? '' : String(storageValue).trim();
  if (!raw) return false;
  return !isLegalThemeId(raw);
}

/** 按 id 取下一个主题（5 档循环；非法当默认） */
function nextThemeId(themeId) {
  const from = isLegalThemeId(themeId) ? themeId : DEFAULT_THEME_ID;
  const at = THEME_ORDER.indexOf(from);
  return THEME_ORDER[(at + 1) % THEME_ORDER.length];
}

/** 入口渲染用的最小清单（渲染层不重复写死 5 项文案） */
function themeMenuItems() {
  return THEMES.map((t) => ({ id: t.id, label: t.label, desc: t.desc }));
}

const themeManifestApi = {
  STYLES,
  THEME_MODES,
  THEMES,
  DEFAULT_THEME_ID,
  LEGAL_THEME_IDS,
  THEME_ORDER,
  THEME_NAMES,
  LEGACY_THEME_IDS,
  isLegalThemeId,
  themeEntry,
  splitThemeId,
  themeAttrs,
  themeFromSearch,
  resolveTheme,
  shouldMigrateStorage,
  nextThemeId,
  themeMenuItems,
};

// —— 浏览器侧可达性（增补卷-fe90-1 §二）：同一份清单挂到全局，`__themeResolve` 与 node import
//    走的是同一个函数，返回值逐字段相等（含 reason/source/fallback）。
//    这里只用 globalThis，顶层不读 document / window，node 直接 import 不会报错。
if (typeof globalThis !== 'undefined' && globalThis) {
  globalThis.ThemeManifest = themeManifestApi;
  globalThis.__themeResolve = resolveTheme;
}

// —— Node 侧导出（逐名赋值，保证 node --experimental 的 ESM 命名导入也能取到）
if (typeof module === 'object' && module && module.exports) {
  module.exports.STYLES = STYLES;
  module.exports.THEME_MODES = THEME_MODES;
  module.exports.THEMES = THEMES;
  module.exports.DEFAULT_THEME_ID = DEFAULT_THEME_ID;
  module.exports.LEGAL_THEME_IDS = LEGAL_THEME_IDS;
  module.exports.THEME_ORDER = THEME_ORDER;
  module.exports.THEME_NAMES = THEME_NAMES;
  module.exports.LEGACY_THEME_IDS = LEGACY_THEME_IDS;
  module.exports.isLegalThemeId = isLegalThemeId;
  module.exports.themeEntry = themeEntry;
  module.exports.splitThemeId = splitThemeId;
  module.exports.themeAttrs = themeAttrs;
  module.exports.themeFromSearch = themeFromSearch;
  module.exports.resolveTheme = resolveTheme;
  module.exports.shouldMigrateStorage = shouldMigrateStorage;
  module.exports.nextThemeId = nextThemeId;
  module.exports.themeMenuItems = themeMenuItems;
}
