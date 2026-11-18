'use strict';
/**
 * 97db 返工补口（T-20261119-025312-f3aaba）：恢复/工作区测试钩子（纯逻辑单源，壳层与夹具共用）。
 * 环境变量：
 *   AWB_DSH_BASE_URL   覆盖 DSH Web 地址（tester 用本地 mock DSH 验恢复四段）
 *   AWB_WORKSPACE_MOCK = fail | ok | reuse
 *     fail  → 注入「工作区创建失败」（验 AC5 顶部横幅 + missing=['workspace'] + 半恢复不落账）
 *     ok    → 工作区创建成功桩（不出网，验 AC4 record/workspace 段）
 *     reuse → 工作区复用成功桩（验已有工作区被复用）
 * 只有显式设置才生效；生产不设这两个变量时行为完全不变。
 */
const WORKSPACE_MOCK_MODES = ['fail', 'ok', 'reuse'];

function workspaceMockOf(env = process.env) {
  const mode = String((env && env.AWB_WORKSPACE_MOCK) || '').trim().toLowerCase();
  const dshBaseUrl = String((env && env.AWB_DSH_BASE_URL) || '').trim();
  return { workspaceMock: WORKSPACE_MOCK_MODES.includes(mode) ? mode : '', dshBaseUrl };
}

/** 返回工作区阶段结果；mode='' 时返回 null 表示「走真实路径」。 */
function mockWorkspaceResult({ mode, project, current } = {}) {
  if (!WORKSPACE_MOCK_MODES.includes(String(mode || ''))) return null;
  const projectPath = String((project && project.path) || '');
  const workspaceId = (current && current.id) || 'ws-mock';
  const name = (project && (project.teamName || project.name)) || 'mock-workspace';
  if (mode === 'fail') {
    return {
      ok: false,
      code: 'WORKSPACE_CREATE_FAILED',
      message: 'AWB_WORKSPACE_MOCK=fail（注入：工作区创建失败）',
      workspace: current || null,
      engineUrl: 'mock://dsh',
      mock: true
    };
  }
  return {
    ok: true,
    code: mode === 'reuse' ? 'WORKSPACE_REUSED_MOCK' : 'WORKSPACE_CREATED_MOCK',
    workspaceId,
    workspace: {
      id: workspaceId,
      path: projectPath,
      name,
      engineUrl: 'mock://dsh',
      bound: true,
      pending: false,
      created: mode === 'ok',
      sessionIds: Array.isArray(current && current.sessionIds) ? current.sessionIds : []
    },
    created: mode === 'ok',
    sessionIds: Array.isArray(current && current.sessionIds) ? current.sessionIds : [],
    engineUrl: 'mock://dsh',
    mock: true
  };
}

module.exports = { WORKSPACE_MOCK_MODES, workspaceMockOf, mockWorkspaceResult };
