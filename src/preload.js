'use strict';

const { contextBridge, ipcRenderer } = require('electron');

// 看板浮窗复用同一个 preload，但只暴露旧版看板脚本认识的 window.boardWin。
// main.js 创建看板 BrowserWindow 时通过 additionalArguments 传入 --awb-board。
const IS_BOARD_WINDOW = process.argv.includes('--awb-board');

if (IS_BOARD_WINDOW) {
  contextBridge.exposeInMainWorld('boardWin', {
    control: (action) => ipcRenderer.invoke('team:board-control', action),
    refresh: () => ipcRenderer.invoke('team:board-refresh'),
    openFile: (filePath) => ipcRenderer.invoke('team:board-file', { path: String(filePath || '') }),
    selectProject: (project) => ipcRenderer.invoke('team:board-select-project', project)
  });
} else {
  contextBridge.exposeInMainWorld('workbench', {
    state: () => ipcRenderer.invoke('app:state'),
    version: () => ipcRenderer.invoke('app:version'),
    metrics: () => ipcRenderer.invoke('system:metrics'),
    filesList: (projectId) => ipcRenderer.invoke('files:list', projectId),
    // 只读文件预览：文本/Markdown/图片，主进程做路径越界与大小上限校验。
    filesRead: (payload) => ipcRenderer.invoke('files:read', payload),
    filesOpen: (payload) => ipcRenderer.invoke('files:open', payload),
    chooseDir: () => ipcRenderer.invoke('app:choose-dir'),
    createProject: (payload) => ipcRenderer.invoke('project:create', payload),
    selectProject: (projectId) => ipcRenderer.invoke('project:select', projectId),
    openProject: (projectId) => ipcRenderer.invoke('project:open', projectId),
    discoverProjects: () => ipcRenderer.invoke('project:discover'),
    adoptProject: (payload) => ipcRenderer.invoke('project:adopt', payload),
    deleteProjectRecord: (projectId) => ipcRenderer.invoke('project:delete-record', projectId),
    // 失效项目：重新定位（只改本机/团队登记路径）、归档记录列表与恢复。
    relocateProject: (payload) => ipcRenderer.invoke('project:relocate', payload),
    archivedProjects: () => ipcRenderer.invoke('project:archived'),
    restoreArchivedProject: (payload) => ipcRenderer.invoke('project:restore-archived', payload),
    // Owner 评审材料：五类清单（只读）与单项读取；缺失/不可读如实返回。
    ownerMaterials: (payload) => ipcRenderer.invoke('owner:materials', payload),
    ownerMaterial: (payload) => ipcRenderer.invoke('owner:material', payload),
    // 项目终验（R-fb48）：前置检查 → 记忆先快照后清理 → 写终验记录；PM/Owner 可用。
    finalizeRun: (payload) => ipcRenderer.invoke('finalize:run', payload),
    finalizeStatus: (payload) => ipcRenderer.invoke('finalize:status', payload),
    // 闸门判定透传（team.mjs/team-tools 判定，壳层只展示）与只读闸门审计。
    gateCheck: (payload) => ipcRenderer.invoke('gate:check', payload),
    gateAudit: (payload) => ipcRenderer.invoke('gate:audit', payload),
    // 主题联动：独立看板窗口按当前主题更新 data-theme。
    boardTheme: (payload) => ipcRenderer.invoke('team:board-theme', payload),
    createTask: (payload) => ipcRenderer.invoke('task:create', payload),
    updateTask: (payload) => ipcRenderer.invoke('task:update', payload),
    deleteTask: (payload) => ipcRenderer.invoke('task:delete', payload),
    // 团队：旧版 IPC 形状（status/members/workspaces/workspaceCreate/launch/restore/board）全部保留。
    teamStatus: () => ipcRenderer.invoke('team:status'),
    teamMembers: (payload) => ipcRenderer.invoke('team:members', payload),
    // R-c651：团队在场三列（未读/未回执/停滞）+ wakeFailed 红点；全部已读；一键唤醒。
    teamPresence: (payload) => ipcRenderer.invoke('team:presence', payload),
    // R-b5fc F-4b：角色队列面板（只读 role_queues.json；PM 看全量、角色只看自己）。
    teamRoleQueues: (payload) => ipcRenderer.invoke('team:role-queues', payload),
    // T-b417：路由守护状态（只读：运行中/已停止/心跳超时）。
    teamRouteStatus: (payload) => ipcRenderer.invoke('team:route-status', payload),
    // R-9db6 F-1：Owner 决策箱（只读：未读计数 + 逐条列表）。
    teamDecisionBox: (payload) => ipcRenderer.invoke('team:decision-box', payload),
    teamMarkRead: (payload) => ipcRenderer.invoke('team:mark-read', payload),
    teamWakeRole: (payload) => ipcRenderer.invoke('team:wake-role', payload),
    teamWorkspaces: (payload) => ipcRenderer.invoke('team:workspaces', payload),
    teamWorkspaceCreate: (payload) => ipcRenderer.invoke('team:workspace:create', payload),
    teamEnsureProject: (payload) => ipcRenderer.invoke('team:ensure-project', payload),
    teamLaunch: (payload) => ipcRenderer.invoke('team:launch', payload),
    teamRestore: (payload) => ipcRenderer.invoke('team:restore', payload),
    teamOpenProject: (payload) => ipcRenderer.invoke('team:open-project', payload),
    teamBoard: (payload) => ipcRenderer.invoke('team:board', payload),
    teamBoardProject: (payload) => ipcRenderer.invoke('team:board-project', payload),
    teamBoardOld: (projectId) => ipcRenderer.invoke('team:board-old', projectId),
    workflow: (payload) => ipcRenderer.invoke('workflow:get', payload),
    workflowOwner: (payload) => ipcRenderer.invoke('workflow:owner', payload),
    // 旧团队工作流闭环：阶段/需求/轮次/boot 都读 团队/状态/项目/<slug>/。
    workflowState: (payload) => ipcRenderer.invoke('workflow:state', payload),
    workflowBoot: (payload) => ipcRenderer.invoke('workflow:boot', payload),
    workflowBriefing: (payload) => ipcRenderer.invoke('workflow:briefing', payload),
    // B-20261114-003257-0a46：项目信息/项目铁律真实存在性（直达文件系统，不信截断清单）。
    docsPresence: () => ipcRenderer.invoke('docs:presence'),
    workflowNext: (payload) => ipcRenderer.invoke('workflow:next', payload),
    workflowIterate: (payload) => ipcRenderer.invoke('workflow:iterate', payload),
    workflowTerminate: (payload) => ipcRenderer.invoke('workflow:terminate', payload),
    requirementCreate: (payload) => ipcRenderer.invoke('requirement:create', payload),
    requirementOwnerCreate: (payload) => ipcRenderer.invoke('requirement:owner-create', payload),
    // Owner 提需求：描述 + 优先级 + 验收标准[]；PM 自动 boot 并建档 R-，进入当前模式的需求评审。
    ownerDemand: (payload) => ipcRenderer.invoke('owner:demand', payload),
    requirementReview: (payload) => ipcRenderer.invoke('requirement:review', payload),
    // Fast 模式：Owner 之后的开发技术评审（高级程序员 A）。
    requirementTechReview: (payload) => ipcRenderer.invoke('requirement:tech-review', payload),
    // 投票：vote:start/vote:cast/vote:status；发起人 analyst，除 PM 外所有角色一致 reject 才驳回 Owner 需求。
    voteStart: (payload) => ipcRenderer.invoke('vote:start', payload),
    voteCast: (payload) => ipcRenderer.invoke('vote:cast', payload),
    voteStatus: (payload) => ipcRenderer.invoke('vote:status', payload),
    requirementOwner: (payload) => ipcRenderer.invoke('requirement:owner', payload),
    requirementDispatch: (payload) => ipcRenderer.invoke('requirement:dispatch', payload),
    // 并行派单：PM 一次把两个开发任务分别派给程序员 A/B。
    requirementDispatchBatch: (payload) => ipcRenderer.invoke('requirement:dispatch-batch', payload),
    taskClaim: (payload) => ipcRenderer.invoke('task:claim', payload),
    taskDone: (payload) => ipcRenderer.invoke('task:done', payload),
    devSubmit: (payload) => ipcRenderer.invoke('dev:submit', payload),
    devReview: (payload) => ipcRenderer.invoke('dev:review', payload),
    devApply: (payload) => ipcRenderer.invoke('dev:apply', payload),
    testDispatch: (payload) => ipcRenderer.invoke('test:dispatch', payload),
    ownerAccept: (payload) => ipcRenderer.invoke('owner:accept', payload),
    teamSend: (payload) => ipcRenderer.invoke('team:send', payload),
    // 旧协议收件箱/已读水位：按当前项目角色会话读取，主进程做 sessionId 核验。
    teamInbox: (payload) => ipcRenderer.invoke('team:inbox', payload),
    teamRead: (payload) => ipcRenderer.invoke('team:read', payload),
    // 旧版回执列表：只读 回执.jsonl，按项目过滤 + 最近 N 条；主进程做路径/大小/update 去重。
    teamReceipts: (payload) => ipcRenderer.invoke('team:receipts', payload),
    teamAck: (payload) => ipcRenderer.invoke('team:ack', payload),
    teamCancel: (payload) => ipcRenderer.invoke('team:cancel', payload),
    // 六会话通信链：delivered / wake / read / ack 四段状态，含“角色自己执行”的检测结果。
    teamComm: (payload) => ipcRenderer.invoke('team:comm', payload),
    teamReconcile: (payload) => ipcRenderer.invoke('team:reconcile', payload),
    proposalCreate: (payload) => ipcRenderer.invoke('proposal:create', payload),
    proposalReview: (payload) => ipcRenderer.invoke('proposal:review', payload),
    proposalSign: (payload) => ipcRenderer.invoke('proposal:sign', payload),
    proposalApply: (payload) => ipcRenderer.invoke('proposal:apply', payload),
    proposalRollback: (payload) => ipcRenderer.invoke('proposal:rollback', payload),
    // 旧评审协议桥：team.mjs propose → show → review → sign → apply。
    // 工具缺失时返回 {ok:false, code:'LEGACY_PROTOCOL_REQUIRED'}，不静默降级成本地单文件提案。
    proposalLegacy: (payload) => ipcRenderer.invoke('proposal:legacy', payload),
    // 只读列出旧协议提案：Owner 评审、提案页直接展示，不需要先手动 show。
    proposalList: (payload) => ipcRenderer.invoke('proposal:list', payload),
    proposalLegacyPropose: (payload) => ipcRenderer.invoke('proposal:legacy', { ...(payload || {}), action: 'propose' }),
    proposalLegacyShow: (payload) => ipcRenderer.invoke('proposal:legacy', { ...(payload || {}), action: 'show' }),
    proposalLegacyReview: (payload) => ipcRenderer.invoke('proposal:legacy', { ...(payload || {}), action: 'review' }),
    proposalLegacySign: (payload) => ipcRenderer.invoke('proposal:legacy', { ...(payload || {}), action: 'sign' }),
    proposalLegacyApply: (payload) => ipcRenderer.invoke('proposal:legacy', { ...(payload || {}), action: 'apply' }),
    ownerDecide: (payload) => ipcRenderer.invoke('owner:decide', payload),
    // R-f8e1 B 清单数据源（只读 团队/状态/项目/<项目>/需求建议点.json）与打回通知（type=review_reject）。
    ownerSuggestions: (payload) => ipcRenderer.invoke('owner:suggestions', payload),
    ownerRejectNotify: (payload) => ipcRenderer.invoke('owner:reject-notify', payload),
    // R-4f99 PM 代验收证据校验（存在性 + sha256，不写文件）。
    ownerEvidenceCheck: (payload) => ipcRenderer.invoke('owner:evidence-check', payload),
    ownerReviewData: (payload) => ipcRenderer.invoke('owner:review-data', payload),
    ownerProxyStatus: (payload) => ipcRenderer.invoke('owner:proxy-status', payload),
    ownerProxyStart: (payload) => ipcRenderer.invoke('owner:proxy-start', payload),
    ownerProxyEnd: (payload) => ipcRenderer.invoke('owner:proxy-end', payload),
    // Owner 确认码已废弃：决定/验收直接以 role=owner 执行。
    // 以下两个 IPC 仅为兼容旧界面保留，返回固定占位值，后端不再校验确认码。
    ownerChallenge: (payload) => ipcRenderer.invoke('owner:challenge', payload),
    ownerConfirm: (payload) => ipcRenderer.invoke('owner:confirm', payload),
    dshStatus: () => ipcRenderer.invoke('dsh:status'),
    // 手动重新发现本机 DSH Web 端口；返回结构化结果，界面不新增假按钮。
    dshRediscover: () => ipcRenderer.invoke('dsh:rediscover'),
    dshConfigure: (baseUrl) => ipcRenderer.invoke('dsh:configure', baseUrl),
    dshProvision: (payload) => ipcRenderer.invoke('dsh:provision', payload),
    dshTeamStatus: (projectId) => ipcRenderer.invoke('dsh:team-status', projectId),
    // R-20261114-001014-e29f：工作区绑定残留（额外会话）的计划/清理/清理历史；清理只解绑不删会话。
    // 703f AC1：会话用量（只读，数据源 团队/状态/项目/<项目>/会话用量.json）
    sessionUsage: (payload) => ipcRenderer.invoke('session:usage', payload),
    workspacePlan: (payload) => ipcRenderer.invoke('workspace:plan', payload),
    workspaceClean: (payload) => ipcRenderer.invoke('workspace:clean', payload),
    workspaceHistory: (payload) => ipcRenderer.invoke('workspace:history', payload),
    dshPrompt: (payload) => ipcRenderer.invoke('dsh:prompt', payload),
    windowControl: (action) => ipcRenderer.invoke('window:control', action),
    // 界面字号（Electron zoom factor）：读取/设置，值由主进程持久化到 workbench.json.ui.zoom。
    uiZoomGet: () => ipcRenderer.invoke('ui:zoom-get'),
    uiZoomSet: (zoom) => ipcRenderer.invoke('ui:zoom-set', zoom),
    // 内存回收（类 GC）：当前值 / 立即回收 / 采样推送 / 回收完成推送
    memStats: () => ipcRenderer.invoke('mem:stats-get'),
    memRecycle: () => ipcRenderer.invoke('mem:recycle'),
    // R-2a69：F1 新手引导（主进程统一接管 F1，转发到这里；焦点在 DSH webview 里也能触发）。
    onGuideOpen: (cb) => { const fn = () => { try { cb(); } catch { /* ignore */ } }; ipcRenderer.on('guide:open', fn); return () => ipcRenderer.removeListener('guide:open', fn); },
    onMemStats: (cb) => { const fn = (_e, data) => { try { cb(data); } catch { /* ignore */ } }; ipcRenderer.on('mem:stats', fn); return () => ipcRenderer.removeListener('mem:stats', fn); },
    onMemRecycleDone: (cb) => { const fn = (_e, data) => { try { cb(data); } catch { /* ignore */ } }; ipcRenderer.on('mem:recycle-done', fn); return () => ipcRenderer.removeListener('mem:recycle-done', fn); }
  });
}
