'use strict';
/**
 * B-33b9 / PM 04:09：把「在册名册 → 角色行」的纯逻辑从 app.js 抽出，供假 DOM 夹具直测。
 *
 * 判定口径（PM 定）：角色行的事实来源是**在册名册**（团队.json members），与 DSH 在线/离线无关；
 *   - 名册有行 → 按名册逐角色出行；本地无映射的行 sessionId 为空（界面显示「DSH 会话未创建」）；
 *   - 名册为空但本模式有角色 → 按本模式角色兜底出行；
 *   - 名册真 0 人且本模式无角色 → 返回空数组（才允许空态）。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AWBSessionRows = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this), function () {
  function shortSessionId(raw) {
    return String(raw || '').replace(/^session-/, '').slice(0, 10);
  }

  /**
   * @param {{rosterRows?:Array<{role:string,name?:string,state?:string}>, localRoles?:Array<{id:string,name?:string,color?:string}>,
   *          sessions?:Object<string,string>, allEntries?:Array, roleById?:Map<string,object>}} input
   * @returns {Array<{role:{id:string,name:string,color?:string}, sessionId:string}>}
   */
  function buildRosterEntries(input = {}) {
    const rosterRows = Array.isArray(input.rosterRows) ? input.rosterRows : [];
    const localRoles = Array.isArray(input.localRoles) ? input.localRoles : [];
    const sessions = input.sessions && typeof input.sessions === 'object' ? input.sessions : {};
    const allEntries = Array.isArray(input.allEntries) ? input.allEntries : [];
    const roleById = input.roleById instanceof Map ? input.roleById : new Map();
    const rosterRowOf = new Map(rosterRows.map((row) => [String((row && row.role) || ''), row]));
    const roleKey = (role) => String((role && (role.id != null ? role.id : role.role)) || '');
    const lookupRole = (roleId, name) => roleById.get(String(roleId))
      || localRoles.find((role) => roleKey(role) === String(roleId))
      || { id: String(roleId || ''), name: String(name || roleId || ''), color: '#888' };
    // 行数只由本模式角色决定（rosterRows 只作状态来源）；名册 1 行也不能只画 1 行。
    if (localRoles.length) {
      return localRoles.map((role) => {
        const roleId = roleKey(role);
        return { role: lookupRole(roleId, role.name), sessionId: String(sessions[roleId] || ''), stateRow: rosterRowOf.get(roleId) || null };
      });
    }
    if (rosterRows.length) {
      return rosterRows.map((row) => {
        const roleId = String((row && row.role) || '');
        return { role: lookupRole(roleId, row && row.name), sessionId: String(sessions[roleId] || ''), stateRow: row };
      });
    }
    return allEntries.slice();
  }

  /** 单行展示模型：未创建会话必须写「DSH 会话未创建」，不能留空/只说待启动。 */
  function rowModel(entry = {}) {
    const role = entry.role || {};
    const sessionId = String(entry.sessionId || '');
    return {
      roleId: String(role.id || ''),
      name: String(role.name || role.id || ''),
      color: String(role.color || '#888'),
      sessionId,
      sub: sessionId ? shortSessionId(sessionId) : 'DSH 会话未创建'
    };
  }

  /** 假 DOM/静态断言用：只输出角色名 + 会话子文案，不依赖真实 DOM 与状态样式。 */
  function renderRowsMarkup(entries = []) {
    return entries.map((entry) => {
      const row = rowModel(entry);
      return '<div class="session-row' + (row.sessionId ? '' : ' missing') + '" data-role-session="' + row.roleId + '" data-session-id="' + row.sessionId + '">'
        + '<span class="session-main"><b data-role-name>' + row.name + '</b><small>' + row.sub + '</small></span></div>';
    }).join('');
  }

  return { buildRosterEntries, rowModel, renderRowsMarkup, shortSessionId };
});
