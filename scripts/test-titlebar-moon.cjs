#!/usr/bin/env node
// B-0538 静态断言：主题「月亮标」已从标题栏收进「更多」下拉，其余标题栏控件仍在、布局自检有硬断言。
// 用法：node scripts/test-titlebar-moon.cjs [--json]
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
const css = fs.readFileSync(path.join(ROOT, 'src/renderer/style.css'), 'utf8');

const checks = [];
const push = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail || '' });
const has = (src, text) => src.includes(text);

push('标题栏不再有 #btn-theme', !has(html, 'id="btn-theme"'));
push('「更多」菜单保留外观项', has(html, 'data-more="theme"') && /外观/.test(html));
push('菜单点击走 runMoreAction(theme)', has(appSrc, "act === 'theme'"));
push('主题切换函数仍可用', has(appSrc, 'function toggleTheme()') && has(appSrc, 'applyTheme(next)'));
push('主题 UI 同步判空（无按钮不报错）', has(appSrc, 'const btn = $(\'#btn-theme\');') && /if \(btn\) \{/.test(appSrc));
push('更多菜单项文案会随主题更新', has(appSrc, '外观：${THEME_NAME[theme]}'));
push('标题栏仍保留更多/立即回收/字号控件', has(html, 'id="btn-more"') && has(html, 'id="btn-mem-recycle"') && has(html, 'id="btn-zoom-out"') && has(html, 'id="btn-zoom-in"'));
push('内存徽标仍在标题栏', has(html, 'id="mem-badge"'));
push('文件夹按钮仍在标题栏', has(html, 'id="btn-folder-top"'));
push('布局自检断言：主题不在标题栏', has(mainSrc, 'themeNotInTitlebar'));
push('布局自检断言：主题在更多菜单', has(mainSrc, 'themeInMoreMenu'));
push('布局自检报告带 themeMovedToMenu', has(mainSrc, 'themeMovedToMenu'));
push('标题栏重叠检查仍在', has(mainSrc, 'titlebarNoOverlap'));
push('代管徽标不压文件夹检查仍在', has(mainSrc, 'proxyNotOverFolder'));
push('样式仍保留 no-drag 与标题栏控件规则', has(css, '#titlebar .titlebar-right button'));

const failed = checks.filter((c) => !c.ok);
const report = { checks: checks.length, failed: failed.length, failures: failed, ok: failed.length === 0 };
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else {
  for (const c of checks) console.log((c.ok ? 'PASS  ' : 'FAIL  ') + c.name + (c.detail ? ' · ' + c.detail : ''));
  console.log(report.ok ? 'TITLEBAR_MOON_OK' : 'TITLEBAR_MOON_FAIL');
}
process.exitCode = report.ok ? 0 : 1;
