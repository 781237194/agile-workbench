/* B-20261120-230447-3d23 · 工作区卡片「选中/错误」纯逻辑（无 DOM，可 Node 直测）。
 * 背景：`app:state` 数据完好而卡片显示「未选择」的真实原因不在取值链，而在渲染层 bind() 抛异常
 * （`$('[data-close-drawer]').forEach`，$ 是 querySelector）→ refresh/render 整段没跑，页面停在 HTML 占位。
 * 本模块只负责「卡片文字」的三档口径（齐备 / 指向不存在 / 读取失败），与 B-8056 名册空态三档对齐：
 *   - 数据齐备：显示项目名，不出现「未选择工作区」；
 *   - activeProjectId 指向不存在的项目：显示 PROJECT_NOT_FOUND，不静默清空/自动切换；
 *   - app:state 读失败或 store 损坏：显示错误码，并保留上次成功渲染的值（stale=true）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AWBWorkspaceCard = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  function view(input) {
    const src = input && typeof input === 'object' ? input : {};
    const state = src.state && typeof src.state === 'object' ? src.state : null;
    const project = src.project && typeof src.project === 'object' ? src.project : null;
    const lastGood = src.lastGood && typeof src.lastGood === 'object' && src.lastGood.nameText ? src.lastGood : null;
    const directErr = src.stateError && typeof src.stateError === 'object' ? src.stateError : null;
    const storeErr = state && state.storeError && typeof state.storeError === 'object' ? state.storeError : null;
    const err = directErr || storeErr;
    if (err) {
      const code = String(err.code || (directErr ? 'APP_STATE_READ_FAILED' : 'STORE_READ_FAILED'));
      const keep = lastGood ? `；显示上次数据（${lastGood.nameText}）` : '';
      return {
        nameText: lastGood ? lastGood.nameText : '工作区读取失败',
        metaText: `读取失败（${code}）${keep}`,
        code,
        stale: Boolean(lastGood),
        bad: true
      };
    }
    const projects = state && Array.isArray(state.projects) ? state.projects : null;
    if (!projects) {
      return { nameText: lastGood ? lastGood.nameText : '工作区读取中…', metaText: lastGood ? lastGood.metaText : '正在读取本机工作区数据', code: lastGood ? 'APP_STATE_PENDING' : '', stale: Boolean(lastGood), bad: false };
    }
    const activeId = String((state && (state.activeProjectIdRaw || state.activeProjectId)) || '');
    const missingFlag = Boolean(state && state.activeProjectMissing === true);
    if (missingFlag || (projects.length && activeId && !projects.some((p) => p && String(p.id) === activeId))) {
      return {
        nameText: '指向的项目不存在（PROJECT_NOT_FOUND）',
        metaText: `activeProjectId=${activeId}；未自动清空或切换，请从左侧重新选择项目`,
        code: 'PROJECT_NOT_FOUND',
        stale: Boolean(lastGood),
        bad: true
      };
    }
    if (!project) {
      return projects.length
        ? { nameText: '未选择工作区', metaText: '请在左侧选择一个项目', code: '', stale: false, bad: false }
        : { nameText: '还没有工作区', metaText: '先新建或恢复一个项目', code: '', stale: false, bad: false };
    }
    return { nameText: String(project.name || ''), metaText: '', code: '', stale: false, bad: false };
  }
  return { view };
});
