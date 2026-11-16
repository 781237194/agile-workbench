#!/usr/bin/env node
'use strict';
/**
 * test-theme-manifest.cjs —— R-fe90 第 2 块（入口与持久化）断言
 *
 * 覆盖：
 *  · F-2 清单单源（5 项 / 默认 tech-dark / THEMES 字段完整）
 *  · 增补卷 §二：`resolveTheme` 两条路径（node import 与全局 __themeResolve）逐字段相等，含 reason
 *  · 增补卷 §三②：三套被禁浅色各产一条 warn，共 3 条，消息同时含输入值与采用值
 *  · AC3③：src/renderer/** + src/main.js + src/preload.js 里三词 0 命中
 *  · F-3/F-4 静态接线：首帧脚本走清单、入口 5 项锚点齐全、`?theme=` 不持久化、看板窗同步 data-style
 *
 * 运行：node scripts/test-theme-manifest.cjs   退出码 0=全过
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MANIFEST = path.join(ROOT, 'src', 'renderer', 'theme-manifest.js');
const LEGACY_ENTRY = path.join(ROOT, 'src', 'theme-resolve.js');
const APP = path.join(ROOT, 'src', 'renderer', 'app.js');
const INDEX = path.join(ROOT, 'src', 'renderer', 'index.html');
const MAIN = path.join(ROOT, 'src', 'main.js');
const PRELOAD = path.join(ROOT, 'src', 'preload.js');
const BANNED = /(tech-light|anime-light|glass-light)/;

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 300)}`);
}
const read = (p) => fs.readFileSync(p, 'utf8');

for (const p of [MANIFEST, LEGACY_ENTRY, APP, INDEX, MAIN, PRELOAD]) {
  if (!fs.existsSync(p)) { console.error(`环境错误：缺文件 ${path.relative(ROOT, p)}`); process.exit(2); }
}

const M = require(MANIFEST);
const L = require(LEGACY_ENTRY);

/** 递归列出目录下所有文件（跳过 node_modules/_tmp/_backup） */
function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (['node_modules', '_tmp', '_backup', '.git'].includes(ent.name)) continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(full, out);
    else out.push(full);
  }
  return out;
}

// S1 清单 5 项且 id 集合精确
const IDS = ['native-dark', 'native-light', 'tech-dark', 'anime-dark', 'glass-dark'];
check('S1 THEMES 恰好 5 项且 id 集合精确',
  M.THEMES.length === 5 && IDS.every((id) => M.THEMES.some((t) => t.id === id)) && new Set(M.THEMES.map((t) => t.id)).size === 5,
  M.THEMES.map((t) => t.id));

// S2 每项都有 style/theme/label，且只有 native-light 是浅色
check('S2 每项有 style/theme/label；浅色只有 native-light',
  M.THEMES.every((t) => ['native', 'tech', 'anime', 'glass'].includes(t.style) && ['dark', 'light'].includes(t.theme) && String(t.label || '').length > 0)
  && M.THEMES.filter((t) => t.theme === 'light').map((t) => t.id).join(',') === 'native-light',
  M.THEMES);

// S3 默认 = tech-dark；清单里没有浅色变体 id
check('S3 DEFAULT_THEME_ID=tech-dark 且清单不含被禁浅色 id',
  M.DEFAULT_THEME_ID === 'tech-dark' && M.THEMES.every((t) => !BANNED.test(t.id)),
  M.DEFAULT_THEME_ID);

// S4 单一实现：legacy 入口与清单入口导出逐字段相等
check('S4 src/theme-resolve.js 与 theme-manifest.js 是同一份实现（逐字段相等）',
  JSON.stringify(L.LEGAL_THEME_IDS) === JSON.stringify(M.LEGAL_THEME_IDS)
  && JSON.stringify(L.THEME_ORDER) === JSON.stringify(M.THEME_ORDER)
  && JSON.stringify(L.THEME_NAMES) === JSON.stringify(M.THEME_NAMES)
  && JSON.stringify(L.resolveTheme({ storageValue: 'dark', search: '?theme=glass-dark' }))
     === JSON.stringify(M.resolveTheme({ storageValue: 'dark', search: '?theme=glass-dark' })),
  { legacy: L.LEGAL_THEME_IDS, manifest: M.LEGAL_THEME_IDS });

// S5 两条路径（require 与全局 __themeResolve）逐字段相等
const viaGlobal = typeof globalThis.__themeResolve === 'function' ? globalThis.__themeResolve('anime-dark') : null;
check('S5 全局 __themeResolve 与模块 resolveTheme 逐字段相等（含 reason/source/fallback）',
  viaGlobal && JSON.stringify(viaGlobal) === JSON.stringify(M.resolveTheme('anime-dark')),
  { viaGlobal, viaModule: M.resolveTheme('anime-dark') });

// S6 三套被禁浅色逐个回落 + reason 含输入原值
const bannedInputs = ['tech-light', 'anime-light', 'glass-light'];
const bannedResults = bannedInputs.map((v) => M.resolveTheme(v));
check('S6 resolveTheme(三套被禁浅色) 全部回落 tech-dark 且 fallback=true/reason 含原值',
  bannedResults.every((r, i) => r.themeId === 'tech-dark' && r.fallback === true && String(r.reason).includes(bannedInputs[i])),
  bannedResults);

// S7 三例各一条 warn，共 3 条，消息同时含输入值与采用值（卷 §三②）
const warns = [];
const warned = bannedInputs.map((v) => M.resolveTheme(v, { onWarn: (msg) => warns.push(msg) }));
check('S7 三例共 3 条 warn，且每条同时含输入值与采用值',
  warns.length === 3
  && warns.every((msg, i) => msg.includes(bannedInputs[i]) && msg.includes('tech-dark') && msg.includes('[theme] fallback'))
  && warned.every((r) => r.fallback === true),
  warns);

// S8 合法值不 warn、不回落
const quiet = [];
const okRes = M.resolveTheme({ storageValue: 'glass-dark' }, { onWarn: (m) => quiet.push(m) });
check('S8 合法值 fallback=false / reason 为空 / 不 warn',
  okRes.fallback === false && okRes.reason === '' && quiet.length === 0, { okRes, quiet });

// S9 URL > storage，且非法 URL 可区分（假绿防护）
const urlWin = M.resolveTheme({ storageValue: 'native-light', search: '?theme=anime-dark' });
const urlBad = M.resolveTheme({ storageValue: 'native-light', search: '?theme=tech-light' });
check('S9 URL 优先；非法 URL 回落但 source=url/fallback=true（与未传参可区分）',
  urlWin.themeId === 'anime-dark' && urlWin.source === 'url'
  && urlBad.themeId === 'tech-dark' && urlBad.source === 'url' && urlBad.fallback === true
  && M.resolveTheme({ storageValue: 'native-light', search: '' }).themeId === 'native-light',
  { urlWin, urlBad });

// S10 5 档循环：每档连走 5 步回到自身，且途经 5 个不同 id
const cycle = IDS.map((id) => {
  const seen = [];
  let cur = id;
  for (let i = 0; i < 5; i += 1) { seen.push(cur); cur = M.nextThemeId(cur); }
  return { start: id, back: cur === id, unique: new Set(seen).size };
});
check('S10 nextThemeId 5 档循环（5 步回到自身、途经 5 个不同 id）',
  cycle.every((c) => c.back && c.unique === 5), cycle);

// S11 AC3③：三词在渲染层/主进程/preload 0 命中
const scanDirs = [path.join(ROOT, 'src', 'renderer')];
const files = [];
for (const d of scanDirs) walk(d, files);
files.push(MAIN, PRELOAD);
const hits = [];
for (const f of files) {
  const text = read(f);
  const lines = text.split('\n');
  lines.forEach((line, i) => { if (BANNED.test(line)) hits.push(`${path.relative(ROOT, f)}:${i + 1}`); });
}
check('S11 AC3③ 三词在 src/renderer/** + src/main.js + src/preload.js 0 命中', hits.length === 0, hits.slice(0, 10));

// S12 index.html：首帧脚本走清单（不复制第二份 5 项表）、默认三属性齐
const indexHtml = read(INDEX);
check('S12 index.html 首帧脚本走清单 + 默认 data-style/data-theme/data-theme-id 齐',
  indexHtml.includes('src="theme-manifest.js"')
  && /<html[^>]*data-style="tech"[^>]*data-theme="dark"[^>]*data-theme-id="tech-dark"/.test(indexHtml)
  && indexHtml.includes('ThemeManifest') && indexHtml.includes('resolveTheme('),
  { hasScript: indexHtml.includes('src="theme-manifest.js"') });

// S13 入口锚点：data-more="theme" 唯一、子菜单容器在、5 项 id 精确
const themeIdAttrs = [...indexHtml.matchAll(/<button[^>]*data-theme-id="([^"]+)"/g)].map((m) => m[1]);
const menuItems = themeIdAttrs.filter((id) => IDS.includes(id));
check('S13 入口：data-more="theme" 1 处、[data-theme-menu] 在、5 项 data-theme-id 精确',
  (indexHtml.match(/data-more="theme"/g) || []).length === 1
  && indexHtml.includes('data-theme-menu')
  && menuItems.length === 5
  && new Set(menuItems).size === 5
  && IDS.every((id) => menuItems.includes(id))
  && themeIdAttrs.filter((id) => id.endsWith('-light')).join(',') === 'native-light',
  { themeIdAttrs, menuItems });

// S14 app.js 不复制清单（不存在「5 个 id 写在同一行」的表），且走 manifest API + 暴露 __themeState
const appCode = read(APP);
const tableCopies = appCode.split('\n').filter((line) => IDS.filter((id) => line.includes(id)).length >= 4);
check('S14 app.js 无 5 个 id 的清单副本（单源），且暴露 __themeState',
  tableCopies.length === 0 && appCode.includes('window.__themeState = themeState') && appCode.includes('ThemeManifest'),
  tableCopies.slice(0, 3));

// S15 ?theme= 不持久化：boot 按 source 决定 persist
check('S15 ?theme= 不持久化（boot 用 persist: source!=="url"）',
  appCode.includes("persist: bootResolved.source !== 'url'"), null);

// S16 看板窗同步 data-style + data-theme（主进程两处）
const mainCode = read(MAIN);
check('S16 main.js 看板窗同步 data-style 与 data-theme（IPC 与开窗 query 两处）',
  mainCode.includes('e.dataset.style=') && mainCode.includes('query: { theme, style: boardStyle }'),
  { datasetStyle: mainCode.includes('e.dataset.style=') });

// S17 preload 只透传 payload（不按旧两值过滤，否则 5 档被截断）
const preloadCode = read(PRELOAD);
check('S17 preload.boardTheme 原样透传 payload（不过滤成 light/dark）',
  /boardTheme:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('team:board-theme',\s*payload\)/.test(preloadCode),
  null);

// S18 清单零 DOM 读取（可 node import；只允许写全局，不读 document/window）
check('S18 manifest 顶层不读 document/window/localStorage（可 node import）',
  !/document\./.test(read(MANIFEST)) && !/window\./.test(read(MANIFEST)) && !/localStorage/.test(read(MANIFEST)),
  { doc: /document\./.test(read(MANIFEST)), win: /window\./.test(read(MANIFEST)) });

// S19 全局作用域纪律（P0 教训）：顶层 const/let/class 一律 TMF_/tmf/themeManifest 前缀
const manifestSrc = read(MANIFEST);
const topDecls = [...manifestSrc.matchAll(/^(?:const|let|class)\s+([A-Za-z_$][\w$]*)/gm)].map((m) => m[1]);
const badDecls = topDecls.filter((n) => !/^(TMF_|tmf|themeManifest)/.test(n));
check('S19 manifest 顶层声明全带 TMF_/tmf/themeManifest 前缀（不污染全局作用域）',
  badDecls.length === 0, { topDecls, badDecls });

console.log(`\ntheme-manifest 断言：${passed}/${passed + failures.length} PASS`);
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exit(1); }
process.exit(0);
