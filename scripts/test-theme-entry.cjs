'use strict';
/**
 * R-dcb4 主题开关核对（Owner 报「主题开关消失」）
 * 只读源码：确认入口在「更多 → 外观」、可切换、且没在标题栏加独立图标（B-0538）。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
const app = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');

const checks = [];
const push = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail }); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`); };

push('更多菜单里有「外观 / 主题」项（data-more=theme）', /data-more="theme"/.test(html));
push('外观项文案写明当前态与下一态（点击切 X）', /外观：\$\{THEME_NAME\[theme\]\}（点击切\$\{THEME_NAME\[next\]\}）/.test(app));
push('主题应用函数存在（setTheme / applyTheme）', /function setTheme\(|function applyTheme\(/.test(app));
push('主题值会被记住（localStorage 或 store）', /awb\.theme|ui\.theme|THEME_KEY/.test(app) || /awb\.theme/.test(html));
push('标题栏没有独立主题图标（B-0538 约束未破）', !/id="btn-theme"/.test(html) && !/class="[^"]*theme-icon/.test(html));
push('引导第 7 步也写明入口（更多 → 外观）', /更多（⋯）→ 外观/.test(app));

const failed = checks.filter((row) => !row.ok);
console.log(`THEME_CHECK ${JSON.stringify({ ok: failed.length === 0, total: checks.length, failed: failed.length })}`);
process.exit(failed.length === 0 ? 0 : 1);
