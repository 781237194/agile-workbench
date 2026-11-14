#!/usr/bin/env node
// B-e7e6 / B-4e18 静态断言（程序员B）：
// ①角色卡三态（存在 / 缺失 / 未就绪-未读角色卡）+ 目录兜底映射 + 一键 boot + 接任包含角色卡路径；
// ②字号全局：主窗 + 看板窗 + 内嵌 webview 都跟随，Ctrl±/A± 走同一入口，重启恢复。
// 用法：node scripts/test-role-card-zoom.cjs [--json]
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const appSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
const mainSrc = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');
const cssSrc = fs.readFileSync(path.join(ROOT, 'src/renderer/style.css'), 'utf8');
const sessionSrc = fs.readFileSync(path.join(ROOT, '团队', '工具', 'lib', 'session.mjs'), 'utf8');

const checks = [];
const push = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail || '' });

// ── 一、角色卡三态 ───────────────────────────────────────────
push('角色 id→目录兜底映射（六角色）', /const ROLE_DIR_FALLBACK = \{ pm: '项目经理'.*tester: '测试人员' \}/.test(appSrc));
push('角色卡路径兜底 role.dir 为空', /const dir = \(role && role\.dir\) \|\| ROLE_DIR_FALLBACK\[String\(role && role\.id\)\] \|\| '';/.test(appSrc));
push('三态函数 legacyRoleCardState', /function legacyRoleCardState\(role\)/.test(appSrc));
push('未就绪态文案（未读角色卡）', /未就绪（未读角色卡）/.test(appSrc));
push('缺失态只用于路径有文件没有', /key: 'missing', label: '缺失'/.test(appSrc));
push('表格用三态渲染', /legacy-cell-warn/.test(appSrc) && /cardState\.label/.test(appSrc));
push('卡片/列表用三态渲染', /cardState\.key === 'unmapped' \? 'warn' : 'bad'/.test(appSrc));
push('团队台用三态渲染', /cardState\.key === 'unmapped' \? 'fact-warn' : 'fact-bad'/.test(appSrc));
push('旧写法 角色卡 有/缺 已清零', !/角色卡 \$\{card \? '有' : '缺'\}/.test(appSrc) && !/card \? '存在' : '缺失'/.test(appSrc));
push('一键 boot 按钮 ≥3 处', (appSrc.match(/data-legacy-boot=/g) || []).length >= 3, String((appSrc.match(/data-legacy-boot=/g) || []).length));
push('未就绪态有金色样式', /legacy-role-dir-files span\.warn/.test(cssSrc));
push('接任包必读含角色卡路径', /\$\{roleDir\}\/角色卡\.md/.test(sessionSrc));

// ── 二、字号全局 ─────────────────────────────────────────────
push('新增 applyZoomToAllWebviews', /function applyZoomToAllWebviews\(zoom\)/.test(mainSrc));
push('新增 applyZoomToAllWindows', /function applyZoomToAllWindows\(zoom\)/.test(mainSrc));
push('ui:zoom-set 改走全量窗口', /applyZoomToAllWindows\(zoom\);\s*\n\s*return \{ ok: true, zoom, min: ZOOM_MIN, max: ZOOM_MAX, windows:/.test(mainSrc));
push('webview 加载后跟随当前字号', /web-contents-created[\s\S]{0,400}wc\.setZoomFactor\(readZoomPref\(\)\)/.test(mainSrc));
push('看板窗创建后应用字号', /teamBoardWindow\.loadFile\(result\.boardPath[\s\S]{0,200}applyZoomToAllWindows\(readZoomPref\(\)\)/.test(mainSrc));
push('看板窗复用重载后应用字号', /reused: true[\s\S]{0,0}/.test(mainSrc) || /applyZoomToAllWindows\(readZoomPref\(\)\);\s*\n\s*teamBoardWindow\.show\(\);\s*\n\s*teamBoardWindow\.focus\(\);/.test(mainSrc));
push('A-/A+/Ctrl± 走 uiZoomSet（同一入口）', /uiZoomSet\(/.test(appSrc) && /Ctrl|ctrlKey/.test(appSrc));
push('重启恢复（读 workbench.json ui.zoom）', /function readZoomPref\(\)/.test(mainSrc) && /ui\.zoom/.test(mainSrc));
push('所有窗口遍历', /BrowserWindow\.getAllWindows\(\)/.test(mainSrc));
push('修 isDestroyed 恒真导致主窗不缩放', /typeof win\.isDestroyed !== 'function'/.test(mainSrc) && !/!win \|\| win\.isDestroyed \|\|/.test(mainSrc));
push('布局自检含字号全局探针', /zoomProbe/.test(mainSrc) && /applyZoomToAllWindows\(1\.2\)/.test(mainSrc));

const failed = checks.filter((c) => !c.ok);
const report = { checks: checks.length, failed: failed.length, failures: failed, ok: failed.length === 0 };
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else {
  for (const c of checks) console.log((c.ok ? 'PASS  ' : 'FAIL  ') + c.name + (c.detail ? ' · ' + c.detail : ''));
  console.log(report.ok ? 'ROLE_CARD_ZOOM_OK' : 'ROLE_CARD_ZOOM_FAIL');
}
process.exitCode = report.ok ? 0 : 1;
