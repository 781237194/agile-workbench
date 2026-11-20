'use strict';
/**
 * B-20261120-230447-3d23 夹具（纯逻辑 + 静态接线）
 * ① 卡片三档：数据齐备→项目名（不出现「未选择工作区」）；activeProjectId 指向不存在→PROJECT_NOT_FOUND；
 *    读失败/存储损坏→错误码 + 保留上次值。
 * ② 根因回归：bind() 里 `$('[data-close-drawer]').forEach` 已修为 `$$`，且全文件不再有 `$(` 接 .forEach 的误用。
 * ③ 接线：refresh 失败写 `APP_STATE_READ_FAILED` 并重绘卡片；renderSidebar 走 AWBWorkspaceCard.view；
 *    index.html 在 app.js 之前引入 workspace-card.js；点项目→selectWorkspace→project:select 写 activeProjectId。
 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const CARD = require(path.join(ROOT, 'src', 'renderer', 'workspace-card.js'));
const APP = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
const HTML = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
const MAIN = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const R = [];
function check(id, title, ok, detail) {
  R.push({ id, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${title}${ok ? '' : '  ← ' + JSON.stringify(detail === undefined ? '' : detail).slice(0, 400)}`);
  if (!ok) process.exitCode = 1;
}
const project = { id: 'P-b98f4eb7', name: '工作台改造修复', workspace: { id: 'ws-1', bound: true } };

// C1 数据齐备
const v1 = CARD.view({ state: { activeProjectId: 'P-b98f4eb7', projects: [project] }, project });
check('C1', '数据齐备 → 显示项目名、无「未选择工作区」、code 为空', v1.nameText === '工作台改造修复' && v1.code === '' && !/未选择工作区/.test(v1.nameText), v1);

// C2 指向不存在
const v2 = CARD.view({ state: { activeProjectId: 'P-dead', projects: [project] }, project: null });
check('C2', 'activeProjectId 指向不存在 → PROJECT_NOT_FOUND，不清空不自动切换', v2.code === 'PROJECT_NOT_FOUND' && /PROJECT_NOT_FOUND/.test(v2.nameText) && /P-dead/.test(v2.metaText) && !/未选择工作区/.test(v2.nameText), v2);

// C3 读失败 + 保留上次值
const lastGood = { nameText: '工作台改造修复', metaText: '团队 工作台改造修复 · DSH ws-1 · 6/6 会话' };
const v3 = CARD.view({ state: null, project: null, lastGood, stateError: { code: 'APP_STATE_READ_FAILED', message: 'ipc down' } });
check('C3', 'app:state 读失败 → APP_STATE_READ_FAILED + 保留上次项目名/meta', v3.code === 'APP_STATE_READ_FAILED' && v3.nameText === '工作台改造修复' && v3.stale === true && /上次/.test(v3.metaText), v3);
const v3b = CARD.view({ state: { activeProjectId: null, projects: [], storeError: { code: 'STORE_CORRUPT', message: 'x' } }, project: null, lastGood });
check('C3b', 'store 损坏 → 显示 STORE_CORRUPT（不用「未选择」冒充）', v3b.code === 'STORE_CORRUPT' && /STORE_CORRUPT/.test(v3b.metaText) && v3b.nameText === '工作台改造修复', v3b);

// C4 根因回归：不再有 `$(` 接 .forEach
const misuse = APP.match(/(?<!\$)\$\([^\n]*\)\.forEach/g) || [];
check('C4', 'app.js 无 `$(...).forEach` 误用（$=querySelector，会抛 TypeError 掐断 bind/render）', misuse.length === 0, misuse);
check('C4b', '抽屉关闭行使用 $$(...)', APP.includes("$$('[data-close-drawer]').forEach"));

// C5 接线
check('C5', 'refresh 失败写 APP_STATE_READ_FAILED 并重绘卡片', APP.includes("stateReadError = { code: 'APP_STATE_READ_FAILED'") && APP.includes('try { renderSidebar(); }'));
check('C6', 'renderSidebar 使用 AWBWorkspaceCard.view，且成功时记住上次值', APP.includes('WorkspaceCardApi.view({ state, project: p') && APP.includes('lastWorkspaceCard = { nameText'));
check('C7', 'index.html 在 app.js 之前引入 workspace-card.js', HTML.indexOf('workspace-card.js') >= 0 && HTML.indexOf('workspace-card.js') < HTML.indexOf('src="app.js"'));
check('C8', '点项目卡片 → selectWorkspace → project:select 写 activeProjectId', APP.includes("$('#project-list')?.addEventListener('click'") && APP.includes('selectWorkspace(item.dataset.project)') && /ipcMain\.handle\('project:select'[\s\S]{0,300}store\.activeProjectId = projectId[\s\S]{0,120}writeStore\(store\)/.test(MAIN));

const pass = R.filter((x) => x.ok).length;
console.log(`\n${pass}/${R.length} PASS`);
