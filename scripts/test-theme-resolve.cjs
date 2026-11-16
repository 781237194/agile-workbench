#!/usr/bin/env node
'use strict';
/**
 * test-theme-resolve.cjs —— R-fe90 主题解析纯函数断言（AC1/AC2/AC3 的可测部分）
 * 运行：node scripts/test-theme-resolve.cjs   退出码 0=全过
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MOD = path.join(ROOT, 'src', 'theme-resolve.js');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 240)}`);
}

if (!fs.existsSync(MOD)) {
  console.error('环境错误：找不到 src/theme-resolve.js');
  process.exit(2);
}
const T = require(MOD);

// S1 常量：合法组合恰好 5 个且集合精确
check('S1 合法组合恰好 5 个且集合精确',
  T.LEGAL_THEME_IDS.length === 5
  && ['native-dark', 'native-light', 'tech-dark', 'anime-dark', 'glass-dark'].every((id) => T.LEGAL_THEME_IDS.includes(id)),
  T.LEGAL_THEME_IDS);

// S2 被禁变体一律非法（tech/anime/glass 的 light）
const banned = ['tech-light', 'anime-light', 'glass-light', 'minimal-dark', 'cyber-dark', '', null, undefined, 'native', 'dark '];
check('S2 被禁/非法 id 全部判非法', banned.every((id) => !T.isLegalThemeId(id)), banned.map((id) => [id, T.isLegalThemeId(id)]));

// S3 默认值：无值 → tech-dark，source=default，不回落
const r3 = T.resolveTheme({ storageValue: '', search: '' });
check('S3 无值 → tech-dark / source=default / fallback=false',
  r3.themeId === 'tech-dark' && r3.source === 'default' && r3.fallback === false, r3);

// S4 Owner 2026-11-16 拍板：老用户 dark 也迁到 tech-dark（打开默认科技风），并打一条 [theme] migrate 日志
const migrateLogs = [];
const r4 = T.resolveTheme({ storageValue: 'dark' }, { onMigrate: (m, d) => migrateLogs.push({ m, d }) });
check('S4 storage=dark → tech-dark（旧值迁移到科技风）+ migrate 日志含旧值/新值',
  r4.themeId === 'tech-dark' && r4.source === 'storage' && r4.fallback === false
  && migrateLogs.length === 1 && /\[theme\] migrate/.test(migrateLogs[0].m)
  && migrateLogs[0].d.from === 'dark' && migrateLogs[0].d.to === 'tech-dark',
  { r4, migrateLogs });

// S4b URL 旧值同样迁移：?theme=dark → tech-dark（且 source=url，能区分「参数被忽略」）
const r4b = T.resolveTheme({ search: '?theme=dark' }, { onMigrate: () => {} });
check('S4b ?theme=dark → tech-dark（source=url）',
  r4b.themeId === 'tech-dark' && r4b.source === 'url' && r4b.fallback === false, r4b);

// S5 老用户 light → native-light（暖白保持）
const r5 = T.resolveTheme({ storageValue: 'light' });
check('S5 storage=light → native-light（暖白保持）', r5.themeId === 'native-light' && r5.source === 'storage' && r5.fallback === false, r5);

// S6 合法新值直接认
const r6 = T.resolveTheme({ storageValue: 'glass-dark' });
check('S6 storage=glass-dark 直接认', r6.themeId === 'glass-dark' && r6.source === 'storage' && r6.fallback === false, r6);

// S7 非法值回落 + 一条 warn（含输入值与采用值）
const warns = [];
const r7 = T.resolveTheme({ storageValue: 'tech-light' }, { onWarn: (msg, detail) => warns.push({ msg, detail }) });
check('S7 非法 storage → 回落 tech-dark + fallback=true',
  r7.themeId === 'tech-dark' && r7.fallback === true && r7.source === 'storage', r7);
check('S8 回落时只 warn 一次，且消息含输入值与采用值',
  warns.length === 1 && warns[0].msg.includes('tech-light') && warns[0].msg.includes('tech-dark'), warns);

// S9 URL 合法值生效，source=url
const r9 = T.resolveTheme({ storageValue: 'light', search: '?theme=anime-dark' });
check('S9 ?theme=anime-dark 覆盖 storage，source=url', r9.themeId === 'anime-dark' && r9.source === 'url' && r9.fallback === false, r9);

// S10 关键假绿点：?theme=tech-light 与「没传参数」结果同为主题 id，但 source 必须可区分
const rBadUrl = T.resolveTheme({ storageValue: 'light', search: '?theme=tech-light' });
const rNoUrl = T.resolveTheme({ storageValue: 'light', search: '' });
check('S10 非法 URL 回落 tech-dark 且 source=url/fallback=true（可与「未传参」区分）',
  rBadUrl.themeId === 'tech-dark' && rBadUrl.source === 'url' && rBadUrl.fallback === true, rBadUrl);
check('S11 同一输入不传 URL 时仍是 storage（tech-light 假绿防护）',
  rNoUrl.themeId === 'native-light' && rNoUrl.source === 'storage' && rNoUrl.fallback === false, rNoUrl);

// S12 URL 里的旧值也认（?theme=light → native-light）
const r12 = T.resolveTheme({ storageValue: 'tech-dark', search: '?theme=light' });
check('S12 ?theme=light（旧值）→ native-light', r12.themeId === 'native-light' && r12.source === 'url', r12);

// S13 URL 解析边界：其他参数、空值、尾随 &
check('S13 themeFromSearch 边界',
  T.themeFromSearch('?theme=') === null
  && T.themeFromSearch('?a=1&theme=glass-dark&b=2') === 'glass-dark'
  && T.themeFromSearch('theme=native-dark&x=1') === 'native-dark'
  && T.themeFromSearch('?other=1') === null
  && T.themeFromSearch('') === null,
  [T.themeFromSearch('?theme='), T.themeFromSearch('?a=1&theme=glass-dark&b=2'), T.themeFromSearch('theme=native-dark&x=1')]);

// S14 拆解：5 个合法 id 的 style/theme 与旧 data-theme 语义一致（light 只 native 一个）
const parts = T.LEGAL_THEME_IDS.map((id) => T.splitThemeId(id));
check('S14 5 个合法 id 都能拆出 style×theme',
  parts.every(Boolean) && parts.filter((p) => p.theme === 'light').length === 1
  && parts.find((p) => p.theme === 'light').style === 'native',
  parts);

// S15 themeAttrs 与 splitThemeId 逐字段相等；非法返回 null
const attrs = T.themeAttrs('glass-dark');
check('S15 themeAttrs 与 splitThemeId 同源，非法返回 null',
  attrs && attrs.style === 'glass' && attrs.theme === 'dark' && T.themeAttrs('tech-light') === null, attrs);

// S16 迁移判定：旧值/非法值需写回，合法新值不用
check('S16 shouldMigrateStorage 口径',
  T.shouldMigrateStorage('dark') === true
  && T.shouldMigrateStorage('light') === true
  && T.shouldMigrateStorage('tech-light') === true
  && T.shouldMigrateStorage('tech-dark') === false
  && T.shouldMigrateStorage('') === false,
  ['dark', 'light', 'tech-light', 'tech-dark', ''].map((v) => [v, T.shouldMigrateStorage(v)]));

// S17 入口顺序覆盖全部 5 个合法 id（不重复、不遗漏、不含被禁变体）
const order = T.THEME_ORDER;
check('S17 入口顺序 = 5 个合法 id（不重不漏、无被禁变体）',
  order.length === 5 && new Set(order).size === 5
  && order.every((id) => T.isLegalThemeId(id))
  && order.every((id) => id.indexOf('light') < 0 || id === 'native-light'),
  order);

// S18 每个合法 id 都有中文名（入口文案与状态文案用）
check('S18 5 个 id 都有中文名', T.THEME_ORDER.every((id) => typeof T.THEME_NAMES[id] === 'string' && T.THEME_NAMES[id].length > 0), T.THEME_NAMES);

// S19 纯函数：不读 DOM / 不写盘（源码静态检查）
const src = fs.readFileSync(MOD, 'utf8');
check('S19 零 DOM 依赖、零写盘（可 node 直接 import）',
  !/document\./.test(src) && !/window\./.test(src) && !/localStorage/.test(src) && !/fs\.(write|append|rm|unlink)/.test(src),
  { document: /document\./.test(src), window: /window\./.test(src), fsWrite: /fs\.(write|append|rm|unlink)/.test(src) });

// S20 幂等：同一输入连续解析结果逐字段相等
const a = T.resolveTheme({ storageValue: 'dark', search: '?theme=glass-dark' });
const b = T.resolveTheme({ storageValue: 'dark', search: '?theme=glass-dark' });
check('S20 幂等（同输入两次结果逐字段相等）', JSON.stringify(a) === JSON.stringify(b), { a, b });

console.log(`\ntheme-resolve 断言：${passed}/${passed + failures.length} PASS`);
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exit(1); }
process.exit(0);
