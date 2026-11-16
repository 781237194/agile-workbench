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
 * 全局作用域纪律（P0 教训，PM 2026-11-16 10:19 硬规矩）：
 *  · 本文件与 app.js / review-list-core.js 等**共用浏览器全局作用域**，顶层 `const/let` 撞名会让
 *    后加载的脚本整份 SyntaxError（b6d855a 事故：THEME_ORDER / api 各撞一次）。
 *  · 因此本文件所有顶层标识符统一加无人使用的 `TMF_` / `tmf` 前缀；请勿再引入无前缀的顶层 const。
 *  · 对外只暴露两个全局：`globalThis.ThemeManifest`（清单 API）与 `globalThis.__themeResolve`（同函数）。
 *  · 自检：`node scripts/test-renderer-load.cjs`（把 index.html 的脚本按加载顺序合并编译，撞名即红）。
 *
 * 可直接被 node `import()` / `require()`：模块顶层不碰 DOM、不读浏览器存储（值由调用方传进来）。
 */

const TMF_STYLES = Object.freeze(['native', 'tech', 'anime', 'glass']);
const TMF_MODES = Object.freeze(['dark', 'light']);

/** 5 个主题（顺序即「更多 → 外观」菜单顺序） */
const TMF_THEMES = Object.freeze([
  Object.freeze({ id: 'native-dark', style: 'native', theme: 'dark', label: '暗金', desc: '现有深色：暗底 + 金色点缀' }),
  Object.freeze({ id: 'native-light', style: 'native', theme: 'light', label: '暖白', desc: '唯一浅色：米白底 + 暖金' }),
  Object.freeze({ id: 'tech-dark', style: 'tech', theme: 'dark', label: '科技暗', desc: '冷蓝霓虹 + 网格底纹（默认）' }),
  Object.freeze({ id: 'anime-dark', style: 'anime', theme: 'dark', label: '二次元暗', desc: '高明度渐变 + 圆角大字' }),
  Object.freeze({ id: 'glass-dark', style: 'glass', theme: 'dark', label: '玻璃拟态暗', desc: '毛玻璃面板 + 柔光' }),
]);

/** 新默认（无值时） */
const TMF_DEFAULT_THEME_ID = 'tech-dark';

/** 合法 id（由清单派生，禁止在别处再写一份） */
const TMF_LEGAL_IDS = Object.freeze(TMF_THEMES.map((t) => t.id));

/** 入口顺序 */
const TMF_ORDER = Object.freeze(TMF_THEMES.map((t) => t.id));

/** id → 中文名 */
const TMF_NAMES = Object.freeze(TMF_THEMES.reduce((acc, t) => {
  acc[t.id] = t.label;
  return acc;
}, {}));

/** 老用户旧值迁移（保持原观感：dark=暗金、light=暖白） */
// B-20261116-122745-c4cf：Owner 2026-11-16 拍板「打开默认科技风」——旧值 dark 也迁到 tech-dark；
// light 仍迁 native-light（暖白保持）。手动切回暗金的入口（菜单 5 项）不动。
const TMF_LEGACY_IDS = Object.freeze({ dark: 'tech-dark', light: 'native-light' });

function tmfIsLegal(id) {
  return typeof id === 'string' && TMF_LEGAL_IDS.indexOf(id) >= 0;
}

/** 取清单项（非法返回 null，不猜） */
function tmfEntry(id) {
  const key = typeof id === 'string' ? id : '';
  for (const t of TMF_THEMES) if (t.id === key) return t;
  return null;
}

/** themeId → {style, theme}；非法返回 null */
function tmfSplit(id) {
  const entry = tmfEntry(typeof id === 'string' ? id.trim() : id);
  return entry ? { style: entry.style, theme: entry.theme } : null;
}

/** themeId → 写进 DOM 的两个属性（style/theme）；非法返回 null */
function tmfAttrs(themeId) {
  const parts = tmfSplit(themeId);
  if (!parts) return null;
  return { style: parts.style, theme: parts.theme };
}

/** 从 search 串（'?theme=xxx' / 'theme=xxx'）取 theme 值；没有则 null（空串也当没传） */
function tmfFromSearch(search) {
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
function tmfResolveTheme(input, opts) {
  const src = typeof input === 'string'
    ? { storageValue: input, search: '' }
    : (input && typeof input === 'object' ? input : {});
  const options = opts && typeof opts === 'object' ? opts : {};
  const warn = typeof options.onWarn === 'function' ? options.onWarn : null;
  // c4cf：旧值迁移要留一条可查日志（含旧值/新值），只打一次，避免每次解析刷屏。
  const migrateLog = options.onMigrate || null;
  const migratedSeen = new Set();
  const noteMigrate = (from, to, source) => {
    const key = String(from) + '>' + String(to) + '@' + source;
    if (migratedSeen.has(key)) return;
    migratedSeen.add(key);
    const message = `[theme] migrate: 旧值「${from}」→ 新值「${to}」（来源 ${source}）`;
    if (typeof migrateLog === 'function') migrateLog(message, { from, to, source });
    else if (typeof console !== 'undefined' && console && typeof console.info === 'function') console.info(message);
  };

  const storageRaw = src.storageValue == null ? '' : String(src.storageValue).trim();
  const urlRaw = tmfFromSearch(src.search);

  const adopt = (themeId, source, fallback, from) => {
    const parts = tmfSplit(themeId) || { style: 'tech', theme: 'dark' };
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
    if (tmfIsLegal(urlRaw)) return adopt(urlRaw, 'url', false, urlRaw);
    const migrated = TMF_LEGACY_IDS[urlRaw];
    if (migrated) { noteMigrate(urlRaw, migrated, 'url'); return adopt(migrated, 'url', false, urlRaw); } // ?theme=light 也当合法旧值
    return adopt(TMF_DEFAULT_THEME_ID, 'url', true, urlRaw);
  }

  // ② storage：合法新值直接认；旧值迁移；非法回落
  if (storageRaw) {
    if (tmfIsLegal(storageRaw)) return adopt(storageRaw, 'storage', false, storageRaw);
    const migrated = TMF_LEGACY_IDS[storageRaw];
    if (migrated) { noteMigrate(storageRaw, migrated, 'storage'); return adopt(migrated, 'storage', false, storageRaw); }
    return adopt(TMF_DEFAULT_THEME_ID, 'storage', true, storageRaw);
  }

  // ③ 无值 → 新默认（老用户不会被强行换肤：dark/light 已在 ② 迁移）
  return adopt(TMF_DEFAULT_THEME_ID, 'default', false, '');
}

/** storageValue 是否需要在写回时升级（旧值/非法值 → 写新值；已是合法新值 → 不写） */
function tmfShouldMigrate(storageValue) {
  const raw = storageValue == null ? '' : String(storageValue).trim();
  if (!raw) return false;
  return !tmfIsLegal(raw);
}

/** 按 id 取下一个主题（5 档循环；非法当默认） */
function tmfNextId(themeId) {
  const from = tmfIsLegal(themeId) ? themeId : TMF_DEFAULT_THEME_ID;
  const at = TMF_ORDER.indexOf(from);
  return TMF_ORDER[(at + 1) % TMF_ORDER.length];
}

/** 入口渲染用的最小清单（渲染层不重复写死 5 项文案） */
function tmfMenuItems() {
  return TMF_THEMES.map((t) => ({ id: t.id, label: t.label, desc: t.desc }));
}

/** 对外 API（唯一导出对象；名字用 themeManifestApi，避免与其它脚本撞顶层 const） */
const themeManifestApi = {
  STYLES: TMF_STYLES,
  THEME_MODES: TMF_MODES,
  THEMES: TMF_THEMES,
  DEFAULT_THEME_ID: TMF_DEFAULT_THEME_ID,
  LEGAL_THEME_IDS: TMF_LEGAL_IDS,
  THEME_ORDER: TMF_ORDER,
  THEME_NAMES: TMF_NAMES,
  LEGACY_THEME_IDS: TMF_LEGACY_IDS,
  isLegalThemeId: tmfIsLegal,
  themeEntry: tmfEntry,
  splitThemeId: tmfSplit,
  themeAttrs: tmfAttrs,
  themeFromSearch: tmfFromSearch,
  resolveTheme: tmfResolveTheme,
  shouldMigrateStorage: tmfShouldMigrate,
  nextThemeId: tmfNextId,
  themeMenuItems: tmfMenuItems,
};

// —— 浏览器侧可达性（增补卷-fe90-1 §二）：同一份清单挂到全局，`__themeResolve` 与 node import
//    走的是同一个函数，返回值逐字段相等（含 reason/source/fallback）。
//    这里只用 globalThis，顶层不读 document / window，node 直接 import 不会报错。
if (typeof globalThis !== 'undefined' && globalThis) {
  globalThis.ThemeManifest = themeManifestApi;
  globalThis.__themeResolve = tmfResolveTheme;
}

// —— Node 侧导出（逐名赋值：既保证 require()，也让 `import()` 的命名导出可用）
if (typeof module === 'object' && module && module.exports) {
  module.exports.STYLES = TMF_STYLES;
  module.exports.THEME_MODES = TMF_MODES;
  module.exports.THEMES = TMF_THEMES;
  module.exports.DEFAULT_THEME_ID = TMF_DEFAULT_THEME_ID;
  module.exports.LEGAL_THEME_IDS = TMF_LEGAL_IDS;
  module.exports.THEME_ORDER = TMF_ORDER;
  module.exports.THEME_NAMES = TMF_NAMES;
  module.exports.LEGACY_THEME_IDS = TMF_LEGACY_IDS;
  module.exports.isLegalThemeId = tmfIsLegal;
  module.exports.themeEntry = tmfEntry;
  module.exports.splitThemeId = tmfSplit;
  module.exports.themeAttrs = tmfAttrs;
  module.exports.themeFromSearch = tmfFromSearch;
  module.exports.resolveTheme = tmfResolveTheme;
  module.exports.shouldMigrateStorage = tmfShouldMigrate;
  module.exports.nextThemeId = tmfNextId;
  module.exports.themeMenuItems = tmfMenuItems;
}
