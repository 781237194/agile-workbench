'use strict';
/**
 * PM 04:09（低内存必交）：假 DOM 夹具证明「名册→角色行」纯逻辑在离线/缓存缺失时仍出 6 行。
 *
 * 直接 require src/renderer/session-rows.js（Node 可测），用最小假 DOM 容器接收 markup：
 *   - 名册 6 人 + memberStatesCache=null → 6 行、5 行显示「DSH 会话未创建」；
 *   - 名册 0 人但本模式 6 角色 → 仍 6 行（只有名册真 0 人才允许空态）；
 *   - 真 0 人且无角色 → 空（才允许空态）；
 *   - 额外静态断言：app.js 使用该纯函数、index.html 在 app.js 之前加载。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ROWS = require(path.join(ROOT, 'src', 'renderer', 'session-rows.js'));
const LOCAL_ROLES = [
  { id: 'pm', name: '项目经理', color: '#d8a84e' },
  { id: 'product', name: '产品设计师', color: '#7eb6ff' },
  { id: 'analyst', name: '需求分析师', color: '#9d8cff' },
  { id: 'programmer1', name: '高级程序员 A', color: '#64d7b0' },
  { id: 'programmer2', name: '高级程序员 B', color: '#58c7c9' },
  { id: 'tester', name: '测试人员', color: '#e39b8e' }
];
const R = [];
function check(id, name, ok, detail) {
  R.push({ id, name, ok: Boolean(ok) });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + id + ' ' + name + (detail === undefined ? '' : '  ← ' + JSON.stringify(detail).slice(0, 700)));
}
/** 最小假 DOM：只认 innerHTML，够断言「容器里是否真有 6 行」。 */
function fakeDom() {
  const el = { tagName: 'DIV', innerHTML: '', textContent: '' };
  Object.defineProperty(el, 'innerHTML', {
    get() { return this._html || ''; },
    set(value) { this._html = String(value || ''); this.textContent = this._html.replace(/<[^>]+>/g, ''); }
  });
  return el;
}
function renderInto(container, entries) { container.innerHTML = ROWS.renderRowsMarkup(entries); return container; }
function countRows(html) { return (String(html).match(/data-role-session="/g) || []).length; }
function countNames(html) { return LOCAL_ROLES.filter((role) => String(html).includes('>' + role.name + '<') || String(html).includes(role.name)).length; }
function countMissing(html) { return (String(html).match(/DSH 会话未创建/g) || []).length; }

// O1：memberStatesCache=null（离线/读失败），名册只有 1 行 → 仍按本模式 6 角色出 6 行。
const rosterOne = [{ role: 'pm', name: '项目经理', state: 'missing' }];
const entries1 = ROWS.buildRosterEntries({ rosterRows: rosterOne, localRoles: LOCAL_ROLES, sessions: { pm: 'session-abc123456' }, allEntries: [] });
const box1 = renderInto(fakeDom(), entries1);
check('F1', '缓存缺失（memberStatesCache=null）+ 名册仅 1 行 → 容器 6 行', entries1.length === 6 && countRows(box1.innerHTML) === 6, { entries: entries1.length, rows: countRows(box1.innerHTML) });
check('F2', '6 行都含角色名（项目经理…测试人员）', countNames(box1.innerHTML) === 6, { names: countNames(box1.innerHTML) });
const subs1 = entries1.map((entry) => ROWS.rowModel(entry).sub);
check('F3', '未建会话的 5 行显示「DSH 会话未创建」，已映射行显示短 id', subs1.filter((s) => s === 'DSH 会话未创建').length === 5 && subs1.filter((s) => /abc123456/.test(s)).length === 1, { subs: subs1 });
check('F4', '假 DOM textContent 也含 6 个角色名 + 5 个「DSH 会话未创建」', countNames(box1.textContent) === 6 && countMissing(box1.textContent) === 5, { text: box1.textContent.slice(0, 240) });

// O2：名册缓存为空数组（DSH 离线时 memberStatesCache 可能为空/失败）→ 仍按本模式 6 角色出行。
const entries2 = ROWS.buildRosterEntries({ rosterRows: [], localRoles: LOCAL_ROLES, sessions: {}, allEntries: [] });
const box2 = renderInto(fakeDom(), entries2);
check('F5', '名册缓存空数组 + 本模式 6 角色 → 仍 6 行、全部 DSH 会话未创建', entries2.length === 6 && countRows(box2.innerHTML) === 6 && countMissing(box2.innerHTML) === 6, { rows: countRows(box2.innerHTML), missing: countMissing(box2.innerHTML) });

// O3：名册直读 6 行（无本模式角色缓存）→ 按名册中文名出行。
const rosterSix = LOCAL_ROLES.map((role) => ({ role: role.id, name: role.name, state: 'missing' }));
const entries3 = ROWS.buildRosterEntries({ rosterRows: rosterSix, localRoles: [], sessions: {}, allEntries: [] });
const box3 = renderInto(fakeDom(), entries3);
check('F6', '名册直读 6 人（无本地角色缓存）→ 6 行且名字来自名册', entries3.length === 6 && countRows(box3.innerHTML) === 6 && countNames(box3.innerHTML) === 6, { rows: countRows(box3.innerHTML), names: countNames(box3.innerHTML) });

// O4：名册真 0 人 + 无角色 → 才允许空态。
const entries4 = ROWS.buildRosterEntries({ rosterRows: [], localRoles: [], sessions: {}, allEntries: [] });
const box4 = renderInto(fakeDom(), entries4);
check('F7', '名册真 0 人且无角色 → 空（只有这种情况允许空态）', entries4.length === 0 && countRows(box4.innerHTML) === 0, { entries: entries4.length, rows: countRows(box4.innerHTML) });

// 静态接线：app.js 必须使用纯函数；index.html 必须在 app.js 之前加载。
const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
const indexPath = path.join(ROOT, 'src', 'renderer', 'index.html');
const indexSrc = fs.readFileSync(indexPath, 'utf8');
const used = /AWBSessionRows\.buildRosterEntries/.test(appSrc) && /AWBSessionRows\.rowModel/.test(appSrc);
const order = /<script src="session-rows\.js"><\/script>[\s\S]*<script src="app\.js"><\/script>/.test(indexSrc);
check('F8', 'app.js 用纯函数（buildRosterEntries/rowModel），index.html 在 app.js 之前加载', used && order, { used, order });

console.log('\n' + R.filter((x) => x.ok).length + '/' + R.length + ' PASS');
process.exitCode = R.some((x) => !x.ok) ? 1 : 0;
