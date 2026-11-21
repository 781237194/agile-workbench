'use strict';

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => Array.from(document.querySelectorAll(sel));

let state = null;
let activeTab = 'overview';
let storeWarned = false;
let modalCtx = null;
let toastTimer = null;
let dshViewFailed = false;
let dshProbeAt = 0;
let guideStep = 0;
let dshReady = false;
let pendingDshFocus = null;
let lastWorkspaceProjectId = null;
// B-230447-3d23：工作区卡片三档——读失败要显码并保留上次成功值；指向不存在的项目不得静默清空。
let stateReadError = null;
let lastWorkspaceCard = null;
let openDrawerName = null;
// boot 过期后要自动重绘，把“已读全/可推进”降级；只用一个定时器，换项目/重新 boot 时重置。
let bootExpiryTimer = null;
// R-b34a R4（T-20261118-172619-c495）：可见性门——隐藏面板/后台窗口不轮询（gate.js 缺失时降级直通，行为不变）。
const R4GateApi = (typeof AWBGate !== 'undefined' && AWBGate) ? AWBGate : null;
// R-b34a R6（T-20261118-175633-18e8）：交互态门——打字/滚动/拖拽期间 gate() 暂停非必要 tick（900ms 静默后恢复）。
try { if (R4GateApi && typeof R4GateApi.installInteraction === 'function') R4GateApi.installInteraction(window); } catch { /* 老环境忽略 */ }
// R-b34a R5（T-20261118-182736-ac7f）：面板骨架便捷入口（同步出现；数据渲染替换后自动消失，另带 1.5s 兜底清理）。
const r5Skeleton = (target, label, rows) => {
  try {
    if (!R4GateApi || typeof R4GateApi.skeleton !== 'function') return null;
    const el = typeof target === 'string' ? $(target) : target;
    if (!el) return null;
    const box = R4GateApi.skeleton(el, { rows: rows || 6, label: label || '加载中…' });
    setTimeout(() => { try { R4GateApi.clearSkeleton(el); } catch { /* ignore */ } }, 4000);
    return box;
  } catch { return null; }
};
const r5ClearSkeleton = (target) => {
  try {
    if (!R4GateApi || typeof R4GateApi.clearSkeleton !== 'function') return 0;
    const el = typeof target === 'string' ? $(target) : target;
    return el ? R4GateApi.clearSkeleton(el) : 0;
  } catch { return 0; }
};

// R-b34a R6 二轮（T-20261118-195240-d7a5）：长任务观测（CDP/夹具读 window.__b34aLongTasks，只读不干预）。
try {
  if (R4GateApi && typeof R4GateApi.observeLongTasks === 'function') window.__b34aLongTasks = R4GateApi.observeLongTasks();
} catch { /* 观测失败不影响功能 */ }
// R6 二轮：连续点击减负——只对「打开即重渲染」的入口做 150ms 抖动门（抽屉开合类按钮不拦，保持原交互语义）。
const R2_CLICK_LAUNCHERS = '#owner-review-entry,#board-launcher,#flow-launcher,#proxy-all-launcher,#btn-team-board-2,#btn-team-board-refresh,#btn-team-board,#btn-team-flow,#btn-team-members,#btn-team-project,#btn-decision-refresh';
document.addEventListener('click', (ev) => {
  try {
    if (!R4GateApi || typeof R4GateApi.clickGate !== 'function') return;
    const raw = ev.target;
    const target = raw && raw.closest ? raw.closest(R2_CLICK_LAUNCHERS) : null;
    if (!target) return;
    const key = 'launcher:' + String(target.id || target.getAttribute('data-win') || target.textContent || '').trim();
    if (!R4GateApi.clickGate(key, 150)) { ev.preventDefault(); ev.stopImmediatePropagation(); }
  } catch { /* 门失败不影响点击 */ }
}, true);
const r4Gate = (fn) => (R4GateApi && typeof R4GateApi.gate === 'function' ? R4GateApi.gate(fn) : fn);
const r4Coalesce = (fn, ms, key) => (R4GateApi && typeof R4GateApi.coalesce === 'function' ? R4GateApi.coalesce(fn, ms, key) : fn);

// R-e31b §5.2：消息默认 50 条 + 可加载更多（messages:page 分页，历史不常驻）。
const msgUi = { extra: [], limit: 30, loading: false, projectId: null };
// R-e31b §5.3：文件面板按目录懒加载——只存当前已加载层的条目（不整树常驻）。
const fileUi = {
  projectId: null,
  expanded: new Set(),
  data: null,
  children: new Map(),
  loaded: new Set(),
  truncated: new Set(),
  byRel: new Map(),
};
// DSH 侧核验结果只对“当前项目”有效；换项目立即作废，避免把上一个项目的 6/6 贴到新项目上。
const liveUi = {
  projectId: null, at: 0, loading: false, error: null,
  items: [], extras: [], duplicates: [], workspace: null,
  ready: null, canRepair: false, missingRoles: [], blankRoles: [], notInWorkspace: []
};
// 团队/DSH 工作区清单（team:workspaces），只读缓存，不写任何状态。
const wsUi = { at: 0, loading: false, data: null, error: null };
// 旧版团队状态（team:status）：看板计数与生成时间；只读。
const teamStatusUi = { at: 0, loading: false, data: null };
// 内嵌团队看板（team:board open:false）：只读 HTML 载入 iframe，切项目不改工作区。
const boardUi = {
  open: false, subjectId: null, subjectName: '', currentProjectId: null,
  data: null, at: 0, loading: false, error: null, framePath: '',
  collapsed: false, maximized: false, zoom: 1, embedError: null
};
// 最近回执：只接受真实 team:receipts；接口缺失就明确标注，不拿本机 messages 或看板计数冒充。
const receiptsUi = { projectId: null, loading: false, data: null, error: null, at: 0, missing: false };
// 派单链路：team:send 的返回只活在本次 IPC；不落盘，刷新/重启后明确显示“未留存”。
// key = projectId|messageId；value = { at, source, wake, warnings }
const dispatchRuns = new Map();
const dispatchUi = { last: null };
// 本次界面内真实 dsh:prompt 返回；不写状态库，只用于“最后唤醒”的界面内补证。
// key = projectId|roleId；value = { at, ok, source, why }
const wakeRuns = new Map();
// Owner 最近一次决定的真实返回（仅本进程内存；刷新即失效，不落盘、不补造）。
const ownerResults = new Map();
let dispatchTicker = null;
// 与主进程 ACK_TTL_MS 一致；只用于界面倒计时，不参与判定。
const ACK_TTL_MS = 10 * 60 * 1000;
// 角色收件箱：旧协议 team:inbox / team:read 不存在时只读本机镜像；
// 本机“已读”是界面浏览标记，不写 团队/状态，也不冒充旧协议 read。
const INBOX_SEEN_KEY = 'awb.inbox.seen.v1';
const INBOX_FILTERS = [
  { id: 'unread', label: '未读' },
  { id: 'read', label: '已读' },
  { id: 'all', label: '全部' }
];
const inboxSeen = new Set();
let inboxSeenLoaded = false;
const inboxUi = {
  projectId: null,
  roleId: 'pm',
  filter: 'unread',
  selectedId: '',
  data: null,
  dataRole: '',
  error: null,
  at: 0,
  loading: false
};

const SOURCE_LABEL = { team: '旧协议', local: '本机降级', 'team-local': '旧协议→本机' };
// R-c651 F-c651-4：团队行三列（未读 / 未回执 / 停滞）与 wakeFailed 红点的界面缓存。
// 只存主进程 team:presence 的返回，不在渲染层重算口径（口径在团队工具 presence 命令里）。
const presenceUi = {
  projectId: null,
  projectName: '',
  at: 0,
  loading: false,
  error: null,
  rows: {},
  stalledWarnMin: 15,
  stalledBadMin: 30,
  busy: {}
};
function presenceRow(roleId) {
  const row = presenceUi.rows[String(roleId || '')];
  return row || null;
}
function presenceCaps() {
  return Boolean(window.workbench && typeof window.workbench.teamPresence === 'function');
}
/** 拉在场数据的统一入口：只有真的重新拉到数据才回调重绘，避免 render→load→render 自激。 */
function ensurePresence(callback) {
  if (!presenceCaps()) return;
  const before = presenceUi.at;
  loadPresence()
    .then(() => { if (presenceUi.at !== before && typeof callback === 'function') callback(); })
    .catch(() => { /* 在场数据拉不到不阻断主界面；错误已记在 presenceUi.error */ });
}
// 一次 DSH 核验结果的有效期；过期后界面退回“本地映射/待核验”，不把旧结果当现在。
const LIVE_TTL_MS = 10 * 60 * 1000;

// R-fe90 主题系统 5 档：清单唯一来源 = src/renderer/theme-manifest.js（index.html 在首帧前同步加载）。
// 这里不复制 5 项表格（F-2「入口/持久化/探针/断言全从这里取，禁止各处写死」）；
// 清单异常时只降级到旧两档行为，不另立第二份真值。
const THEME_MANIFEST = (typeof window !== 'undefined' && window.ThemeManifest) || null;
const THEME_STORAGE_KEY = 'awb.theme';
const THEME_ORDER_APP = (THEME_MANIFEST && Array.isArray(THEME_MANIFEST.THEME_ORDER)) ? THEME_MANIFEST.THEME_ORDER : [];
const THEME_NAME = (THEME_MANIFEST && THEME_MANIFEST.THEME_NAMES) || { dark: '暗金', light: '暖白' };
const TASK_STATUS = { todo: '待办', doing: '进行中', review: '待评审', done: '已完成' };
const OWNER_STATUS = { optional: '未选择', approved: '已通过', skipped: '已跳过', rejected: '已打回', pending: '待审' };
// Owner 是本机外部角色，没有 DSH 会话身份。只有用户点下 Owner（我）按钮后，
// 界面才记录 actor；字符串写明“本机点击”，不把它当成后端身份证明。
const OWNER_CONFIRM_ACTOR = 'owner';
const OWNER_CONFIRM_ACTIONS = new Set(['owner-review', 'owner-accept']);
const ROLE_BLURB = {
  pm: '协调、派单、催回执、维护项目信息与索引。',
  product: '需求评审、流程与架构、优先级建议。',
  analyst: '需求拆解、验收标准、需求追踪。',
  programmer1: '实现、互审、提交与回执。',
  programmer2: '实现、互审、提交与回执。',
  tester: '独立测试、回归、验收报告。'
};

/* ── 团队模式：完整 6 人 / 快速 4 人 ─────────────────────
 * 模式随项目保存到 project.teamMode（后端 fast/full）；渲染层按模式只显示
 * 当前角色。快速模式由后端只建 4 个角色会话，并启用需求分析师评审 +
 * Owner 后的开发技术评审；不删除已有 DSH 会话，也不改许可。
 */
const TEAM_MODES = {
  full: {
    id: 'full',
    label: '完整 6 人',
    short: '完整',
    roleIds: ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'],
    hidden: [],
    note: '保留产品评审与开发互审，六个角色都参与。'
  },
  fast: {
    id: 'fast',
    label: '快速 4 人',
    short: '快速',
    roleIds: ['pm', 'analyst', 'programmer1', 'tester'],
    hidden: ['product', 'programmer2'],
    note: '只显示 PM / 需求分析师 / 程序员A / 测试人员；产品设计师与高级程序员B 隐藏。',
    // Owner 2026-11-18 临时需求：4 人团队暂不可用（展示但不可点击），标识文字写死。
    unavailable: '【暂不可用，工作台三期工程】'
  }
};
/* 团队模式下的界面用词：Fast 不再沿用“六角色 / 产品评审 / 开发互审”，
 * 统一显示 4 人 / 分析师评审 / 技术评审 / 复核。完整模式保持旧称呼。
 * 这里只做文案映射，不改后端字段、命令名或角色身份。 */
const TEAM_MODE_TERMS = {
  full: {
    team: '六角色',
    teamDir: '六角色目录',
    review: '产品评审',
    reviewer: '产品设计师',
    devReview: '开发互审',
    techReview: '开发技术评审'
  },
  fast: {
    team: '4 人',
    teamDir: '4 人角色目录',
    review: '分析师评审',
    reviewer: '需求分析师',
    devReview: '复核',
    techReview: '技术评审'
  }
};

function modeTerms(project) {
  return TEAM_MODE_TERMS[projectTeamMode(project || activeProject())] || TEAM_MODE_TERMS.full;
}

/* Fast 文案兜底映射：静态 HTML / 动态面板里漏改的旧称呼统一收口。
 * 跳过模式选择卡与显式标记的节点，避免把“完整 6 人”的说明也改成 Fast。 */
const FAST_COPY_RULES = [
  [/六角色目录/g, '4 人角色目录'],
  [/六角色会话/g, '4 人会话'],
  [/六角色卡/g, '4 人角色卡'],
  [/六角色/g, '4 人'],
  [/六个角色/g, '4 个角色'],
  [/6 个角色/g, '4 个角色'],
  [/六个 DSH/g, '4 个 DSH'],
  [/六会话/g, '4 个会话'],
  [/产品评审/g, '分析师评审'],
  [/开发技术评审/g, '技术评审'],
  [/开发互审/g, '复核'],
  [/开发复核/g, '复核'],
  [/高级程序员 A/g, '程序员A'],
  [/高级程序员 B/g, '程序员B'],
  [/需求评审/g, '分析师评审'],
  [/互审/g, '复核'],
  [/SIX ROLES/g, '4 ROLES']
];
// 文档正文、文件预览与模式选择卡必须保持原文/原义，不能跟着 Fast 文案替换。
const FAST_COPY_SKIP = 'script,style,textarea,.team-mode-card,.file-preview,#legacy-doc-preview,.markdown-body,[data-mode-copy-keep]';
const fastCopyStore = new WeakMap();
const FAST_COPY_ATTRS = ['title', 'aria-label', 'placeholder', 'alt'];

function localizeFastCopy(value) {
  let out = String(value ?? '');
  if (!out) return out;
  for (const [pattern, replacement] of FAST_COPY_RULES) out = out.replace(pattern, replacement);
  return out;
}

/** 返回按当前 teamMode 处理后的文案；toast / title 等直接字符串走这里。 */
function modeCopyText(value) {
  const raw = String(value ?? '');
  return isQuickTeam() ? localizeFastCopy(raw) : raw;
}

function textCopyEntry(node) {
  const saved = fastCopyStore.get(node);
  if (saved && saved.original !== undefined) return saved;
  return null;
}

function setTextCopyEntry(node, original, mapped) {
  const saved = fastCopyStore.get(node) || {};
  saved.original = original;
  saved.mapped = mapped;
  fastCopyStore.set(node, saved);
}

function clearTextCopyEntry(node) {
  const saved = fastCopyStore.get(node);
  if (!saved) return;
  delete saved.original;
  delete saved.mapped;
  if (!Object.keys(saved).length) fastCopyStore.delete(node);
}

/** 把 Fast 用词应用到 root 内的文本与 title/aria/placeholder；切回完整模式时还原。 */
function applyTeamModeCopy(root = document.body) {
  if (!root || !root.querySelectorAll) return;
  const fast = isQuickTeam();
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, null);
  const nodes = [];
  while (walker.nextNode()) nodes.push(walker.currentNode);
  for (const node of nodes) {
    const parent = node.parentElement;
    if (!parent || parent.closest(FAST_COPY_SKIP)) continue;
    let saved = textCopyEntry(node);
    if (fast) {
      if (saved && node.nodeValue === saved.mapped) continue;
      // 文本节点被复用、内容已变：旧映射作废，按当前文本重新判断。
      if (saved && node.nodeValue !== saved.original) { clearTextCopyEntry(node); saved = null; }
      const original = node.nodeValue;
      const mapped = localizeFastCopy(original);
      if (mapped === original) continue;
      node.nodeValue = mapped;
      setTextCopyEntry(node, original, mapped);
    } else if (saved && node.nodeValue === saved.mapped) {
      node.nodeValue = saved.original;
      clearTextCopyEntry(node);
    }
  }
  for (const el of root.querySelectorAll('*')) {
    if (el.closest(FAST_COPY_SKIP)) continue;
    for (const attr of FAST_COPY_ATTRS) {
      if (!el.hasAttribute(attr)) continue;
      const entry = fastCopyStore.get(el) || {};
      let saved = entry[attr];
      if (fast) {
        if (saved && el.getAttribute(attr) === saved.mapped) continue;
        if (saved && el.getAttribute(attr) !== saved.original) { delete entry[attr]; saved = null; }
        const original = el.getAttribute(attr);
        const mapped = localizeFastCopy(original);
        if (mapped === original) continue;
        el.setAttribute(attr, mapped);
        entry[attr] = { original, mapped };
        fastCopyStore.set(el, entry);
      } else if (saved && el.getAttribute(attr) === saved.mapped) {
        el.setAttribute(attr, saved.original);
        delete entry[attr];
        if (Object.keys(entry).length) fastCopyStore.set(el, entry);
        else fastCopyStore.delete(el);
      }
    }
  }
}

const TEAM_MODE_STORE_KEY = 'awb.teamModes.v1';
const TEAM_MODE_PATH_KEY = 'awb.teamModePaths.v1';

function readJsonStore(key, fallback) {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : fallback;
  } catch { return fallback; }
}

let teamModeStore = readJsonStore(TEAM_MODE_STORE_KEY, Object.create(null));
let teamModePathStore = readJsonStore(TEAM_MODE_PATH_KEY, Object.create(null));

function normalizeTeamMode(value) {
  const raw = String(value || '').trim().toLowerCase();
  if (['fast', 'quick', '4', '4p', 'four'].includes(raw)) return 'fast';
  return 'full';
}

function teamModeDef(modeOrProject) {
  const mode = modeOrProject && typeof modeOrProject === 'object'
    ? projectTeamMode(modeOrProject)
    : normalizeTeamMode(modeOrProject);
  return TEAM_MODES[mode] || TEAM_MODES.full;
}

function projectPathKey(project) {
  return String((project && project.path) || '').replace(/\\/g, '/').toLowerCase();
}

function projectTeamMode(project) {
  if (!project) return 'full';
  if (project.teamMode || project.team_mode) return normalizeTeamMode(project.teamMode || project.team_mode);
  const byId = teamModeStore[String(project.id || '')];
  if (byId) return normalizeTeamMode(byId);
  const byPath = teamModePathStore[projectPathKey(project)];
  if (byPath) return normalizeTeamMode(byPath);
  return 'full';
}

function saveProjectTeamMode(project, mode) {
  if (!project) return 'full';
  const normalized = normalizeTeamMode(mode);
  const idKey = String(project.id || '');
  const pathKey = projectPathKey(project);
  const changed = project.teamMode !== normalized
    || (idKey && teamModeStore[idKey] !== normalized)
    || (pathKey && teamModePathStore[pathKey] !== normalized);
  project.teamMode = normalized;
  if (idKey) teamModeStore[idKey] = normalized;
  if (pathKey) teamModePathStore[pathKey] = normalized;
  if (changed) {
    try { localStorage.setItem(TEAM_MODE_STORE_KEY, JSON.stringify(teamModeStore)); } catch { /* ignore */ }
    try { localStorage.setItem(TEAM_MODE_PATH_KEY, JSON.stringify(teamModePathStore)); } catch { /* ignore */ }
  }
  return normalized;
}

function hydrateTeamModes() {
  if (!state || !Array.isArray(state.projects)) return;
  for (const project of state.projects) {
    if (!project || !project.id) continue;
    if (project.teamMode || project.team_mode) {
      saveProjectTeamMode(project, projectTeamMode(project));
      continue;
    }
    const saved = teamModeStore[String(project.id)] || teamModePathStore[projectPathKey(project)];
    project.teamMode = normalizeTeamMode(saved || 'full');
  }
}

function isQuickTeam(project) {
  return projectTeamMode(project || activeProject()) === 'fast';
}

function teamModeLabel(project) {
  return teamModeDef(project).label;
}

function teamRoleIds(project) {
  const p = project || activeProject();
  const known = new Set((state?.roles || []).map((role) => role.id));
  // R-b52b F-4/AC6：角色集以主进程暴露的 project.roleIds（= 项目.json.roleIds 登记）为准；
  // 没有才退回团队模式定义的固定 4/6。删掉 tester 的项目计数要跟着变 N，不是继续按模式算。
  const explicit = Array.isArray(p && p.roleIds) ? p.roleIds.filter((id) => !known.size || known.has(id)) : [];
  if (explicit.length) return explicit;
  const def = teamModeDef(p);
  const ids = def.roleIds.filter((id) => !known.size || known.has(id));
  return ids.length ? ids : def.roleIds.slice();
}

function teamRoles(project) {
  const p = project || activeProject();
  const ids = new Set(teamRoleIds(p));
  return (state?.roles || []).filter((role) => ids.has(role.id));
}

function teamRoleCount(project) {
  return teamRoleIds(project).length;
}

function hiddenTeamRoles(project) {
  const def = teamModeDef(project || activeProject());
  return def.hidden.map((id) => roleById(id)).filter((role) => role && role.id);
}

/* ── 团队投票：驳回 Owner 需求（真实 vote:start / vote:cast / vote:status） ──
 * 发起人只能是需求分析师；除 PM 外当前模式所有角色都投 reject 才驳回 Owner 需求。
 * 面板只显示后端返回的票、逐角色理由/证据与结果，不在本地造票。
 */
const VOTE_UI_TTL_MS = 15000;
const VOTE_RESULT_LABEL = { open: '进行中', passed: '已驳回', blocked: '未驳回' };
const voteUi = { projectId: null, loading: false, at: 0, data: null, error: null, votes: [] };

function voteIpcAvailable() {
  return Boolean(window.workbench
    && typeof window.workbench.voteStart === 'function'
    && typeof window.workbench.voteCast === 'function'
    && typeof window.workbench.voteStatus === 'function');
}

function voteListForRender(project) {
  if (!project || voteUi.projectId !== project.id) return [];
  return Array.isArray(voteUi.votes) ? voteUi.votes : [];
}

function voteForRequirement(requirementId) {
  return voteListForRender(activeProject()).find((vote) => String(vote.requirementId) === String(requirementId)) || null;
}

function voteResultLabel(vote) {
  return VOTE_RESULT_LABEL[String(vote && vote.status)] || '未读取';
}

function voteRequirementCandidates() {
  return legacyRequirements().filter((req) => {
    const status = String(req.status || '');
    if (req.voteRejection) return false;
    if (['dev', 'dev_done', 'test', 'test_done', 'accepted', 'terminated', 'iteration'].includes(status)) return false;
    return String(req.origin || '') === 'owner' || String(req.createdBy || '') === 'owner';
  });
}

function voteCreateGate(project) {
  if (!project) return { ok: false, reason: '先选择工作区' };
  if (!voteIpcAvailable()) return { ok: false, reason: 'preload 没有 vote:start / vote:cast / vote:status：不能发起或读取投票' };
  if (!teamRoleIds(project).includes('analyst')) return { ok: false, reason: '当前团队模式没有需求分析师，不能发起投票' };
  if (!voteRequirementCandidates().length) return { ok: false, reason: '还没有可投票的 Owner 需求；先由 Owner 向 PM 提需求' };
  return { ok: true, reason: '' };
}

function voteCastGate(vote, roleId) {
  if (!voteIpcAvailable()) return { ok: false, reason: 'preload 没有 vote:cast：不能投票' };
  if (!vote) return { ok: false, reason: '投票不存在' };
  if (String(vote.status) !== 'open') return { ok: false, reason: '投票已结束（' + voteResultLabel(vote) + '）' };
  if (roleId === 'pm') return { ok: false, reason: 'PM 不参与投票' };
  const eligible = Array.isArray(vote.eligibleRoles) ? vote.eligibleRoles : [];
  if (!eligible.includes(roleId)) return { ok: false, reason: '这个角色不在本次投票名单里' };
  if ((vote.casts || []).some((cast) => String(cast.role) === String(roleId))) return { ok: false, reason: '这个角色已经投过票' };
  return { ok: true, reason: '' };
}

async function loadVotes(force = false) {
  const p = activeProject();
  if (!p) {
    voteUi.projectId = null;
    voteUi.votes = [];
    voteUi.data = null;
    voteUi.error = null;
    return null;
  }
  if (!voteIpcAvailable()) {
    voteUi.projectId = p.id;
    voteUi.votes = [];
    voteUi.error = 'preload 没有 vote:status：投票面板只显示不可用原因';
    renderVotes();
    return null;
  }
  if (!force && voteUi.projectId === p.id && Date.now() - voteUi.at < VOTE_UI_TTL_MS) return voteUi.data;
  if (voteUi.loading) return voteUi.data;
  voteUi.loading = true;
  voteUi.projectId = p.id;
  renderVotes();
  try {
    const r = await window.workbench.voteStatus({ projectId: p.id, teamMode: projectTeamMode(p) });
    if (voteUi.projectId !== p.id) return null;
    voteUi.data = r && r.ok !== false ? r : null;
    voteUi.error = r && r.ok === false ? String(r.message || r.code || 'vote:status 失败') : null;
    voteUi.votes = Array.isArray(r && r.votes) ? r.votes : (r && r.vote ? [r.vote] : []);
    voteUi.at = Date.now();
    return r;
  } catch (e) {
    voteUi.error = humanError(e.message);
    voteUi.votes = [];
    voteUi.at = Date.now();
    return null;
  } finally {
    voteUi.loading = false;
    renderVotes();
    renderFlow();
  }
}

function voteCountsMarkup(vote) {
  const counts = vote && vote.counts && typeof vote.counts === 'object' ? vote.counts : {};
  const eligible = Number(counts.eligible) || 0;
  const cast = Number(counts.cast) || 0;
  const reject = Number(counts.reject) || 0;
  const approve = Number(counts.approve) || 0;
  const missing = Number(counts.missing) || 0;
  const resultCls = vote && vote.status === 'passed' ? 'rejected' : (vote && vote.status === 'blocked' ? 'tie' : '');
  return `<div class="vote-counts">
    <span class="vote-count pending"><b>${eligible}</b>可投</span>
    <span class="vote-count approve"><b>${cast}</b>已投</span>
    <span class="vote-count reject"><b>${reject}</b>驳回</span>
    <span class="vote-count abstain"><b>${approve}</b>保留</span>
    <span class="vote-count pending"><b>${missing}</b>待投</span>
    <span class="vote-result ${resultCls}">${esc(voteResultLabel(vote))}</span>
  </div>`;
}

function voteCastRow(vote, roleId) {
  const role = roleById(roleId);
  const cast = (vote.casts || []).find((item) => String(item.role) === String(roleId)) || null;
  if (cast) {
    return `<div class="vote-voter is-cast">
      <span class="vote-voter-name" style="--role-color:${esc(role.color)}">${esc(role.name)}</span>
      <span class="vote-choice ${cast.verdict === 'reject' ? 'reject' : 'approve'}">${cast.verdict === 'reject' ? '驳回' : '保留'}</span>
      <span class="vote-reason" title="${esc(cast.reason || '')}">${esc(cast.reason || '未填写理由')}${cast.evidence ? ' · 证据：' + esc(cast.evidence) : ''}</span>
      <span class="vote-meta">${esc(fmtTime(cast.at) || '时间未记录')}</span>
    </div>`;
  }
  const gate = voteCastGate(vote, roleId);
  return `<div class="vote-voter is-pending">
    <span class="vote-voter-name" style="--role-color:${esc(role.color)}">${esc(role.name)}</span>
    <span class="vote-choice pending">待投</span>
    <span class="vote-cast-form">
      <select class="select vote-choice-select" data-vote-choice aria-label="${esc(role.name)} 的投票选择">
        <option value="reject">驳回</option>
        <option value="approve">保留</option>
      </select>
      <input class="input vote-reason-input" data-vote-reason maxlength="300" placeholder="理由/证据（写入工作流）">
      <button class="ghost small" type="button" data-vote-cast="${esc(vote.id)}" data-vote-role="${esc(roleId)}" ${gate.ok ? '' : 'disabled'} title="${esc(gate.ok ? '调用真实 vote:cast；除 PM 外全员一致驳回才生效' : gate.reason)}">投票</button>
    </span>
    ${gate.ok ? '' : `<span class="vote-gate">${esc(gate.reason)}</span>`}
  </div>`;
}

/**
 * 投票发起人的“实际角色”。
 * team.mjs 的 vote start 只允许 PM 执行，所以从工作台“分析师发起”创建的投票，
 * 记录里的 createdBy 仍是 pm；界面按产品规则展示实际发起角色（需求分析师），
 * 只有无法从首票理由对上分析师时才回退到后端记录的角色。
 */
function voteInitiatorRoleId(vote) {
  const recorded = String((vote && vote.initiator) || '').trim();
  if (recorded && recorded !== 'pm') return recorded;
  const subject = String((vote && vote.reason) || '').trim();
  const analystCast = (vote && Array.isArray(vote.casts) ? vote.casts : [])
    .find((cast) => String((cast && cast.role) || '') === 'analyst');
  const analystReason = String((analystCast && analystCast.reason) || '').trim();
  if (analystCast && subject && (analystReason === subject || analystReason.startsWith(subject))) return 'analyst';
  return recorded || 'analyst';
}

function voteCardMarkup(vote, project) {
  const visible = new Set(teamRoleIds(project));
  const eligible = (Array.isArray(vote.eligibleRoles) ? vote.eligibleRoles : []).filter((id) => visible.has(id));
  const rows = eligible.map((roleId) => voteCastRow(vote, roleId)).join('');
  const req = legacyRequirements().find((row) => String(row.id) === String(vote.requirementId)) || null;
  const resultCls = vote.status === 'passed' ? 'rejected' : (vote.status === 'blocked' ? 'tie' : '');
  const recordedInitiator = String((vote && vote.initiator) || '').trim();
  const initiatorId = voteInitiatorRoleId(vote);
  const initiatorName = roleById(initiatorId).name;
  const initiatorTitle = recordedInitiator && recordedInitiator !== initiatorId
    ? `实际发起角色：${initiatorName}；团队工具 vote start 记录为 ${roleById(recordedInitiator).name}（PM 不投票）`
    : `发起角色：${initiatorName}`;
  return `<article class="vote-card" data-vote-card="${esc(vote.id)}">
    <div class="vote-head">
      <div class="vote-title"><b>驳回投票 · ${esc(vote.requirementId || '未写需求')}</b><span class="vote-id">${esc(vote.id)}</span></div>
      <span class="vote-result ${resultCls}">${esc(voteResultLabel(vote))}</span>
    </div>
    <div class="vote-sub" title="${esc(initiatorTitle)}">发起人：${esc(initiatorName)} · ${esc(fmtTime(vote.createdAt) || '时间未记录')} · ${Number(vote.counts && vote.counts.eligible) || eligible.length} 名非 PM 成员 · ${esc(teamModeDef({ teamMode: vote.teamMode }).label)}</div>
    ${vote.reason ? `<p class="vote-detail">理由：${esc(vote.reason)}</p>` : ''}
    ${vote.evidence ? `<p class="vote-detail">证据：${esc(vote.evidence)}</p>` : ''}
    ${voteCountsMarkup(vote)}
    <div class="vote-voters">${rows || '<div class="empty-row">当前团队模式没有可显示投票角色</div>'}</div>
    <div class="vote-pm">${esc(vote.decisionNote || '除 PM 外全员一致驳回，才驳回 Owner 需求。')}${vote.status === 'passed' ? ' · 已驳回的需求标为可迭代，可重新评审，不是死锁。' : ''}${req ? ` · 需求当前：${esc(legacyReqStatus(req))}` : ''}</div>
  </article>`;
}

function renderVotes() {
  const box = $('#team-vote-panel');
  const summaryEl = $('#vote-summary');
  if (!box) return;
  const p = activeProject();
  if (!p) {
    if (summaryEl) summaryEl.textContent = '';
    box.innerHTML = '<div class="empty-row">先选择工作区。</div>';
    return;
  }
  const votes = voteListForRender(p);
  const gate = voteCreateGate(p);
  if (summaryEl) summaryEl.textContent = voteUi.loading ? '读取中…' : `${votes.length} 项`;
  const intro = `<div class="vote-intro">
    <div><b>驳回 Owner 需求 · 分析师发起</b><p>除 PM 外当前团队模式全员投票；全部投“驳回”才驳回 Owner 需求，任一“保留”即未驳回。票、理由、证据和结果都来自真实 <code>vote:*</code> IPC。</p></div>
    <button class="primary small" type="button" data-vote-new="1" ${gate.ok ? '' : 'disabled'} title="${esc(gate.ok ? '以需求分析师身份发起驳回投票' : gate.reason)}">发起投票</button>
  </div>`;
  const error = voteUi.error ? `<div class="vote-empty">投票读取失败：${esc(voteUi.error)}</div>` : '';
  const loading = voteUi.loading && !votes.length ? '<div class="vote-empty">正在读取投票…</div>' : '';
  const list = votes.length
    ? votes.map((vote) => voteCardMarkup(vote, p)).join('')
    : (voteUi.loading ? '' : '<div class="vote-empty">还没有投票。分析师发起后，这里显示逐角色理由、证据、票数与结果。</div>');
  box.innerHTML = intro + error + loading + list;
}

function openVoteModal(requirementId = '') {
  const p = activeProject();
  if (!p) { openNewProject(); return; }
  const gate = voteCreateGate(p);
  if (!gate.ok) { toast(gate.reason, 'bad'); return; }
  const candidates = voteRequirementCandidates();
  const active = legacyActiveRequirement();
  const preferred = candidates.find((req) => String(req.id) === String(requirementId || (active && active.id) || '')) || candidates[0];
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <label class="field"><span><b>Owner 需求</b></span>
      <select id="vote-req" class="select">${candidates.map((req) => `<option value="${esc(req.id)}" ${preferred && req.id === preferred.id ? 'selected' : ''}>${esc(req.id)} · ${esc(req.title || '未写标题')}（${esc(legacyReqStatus(req))}）</option>`).join('')}</select>
    </label>
    <label class="field"><span><b>发起理由（必填，至少写一条）</b></span><textarea id="vote-reason" class="textarea" maxlength="1000" placeholder="为什么这个 Owner 需求需要被驳回；会写进工作流.json"></textarea></label>
    <label class="field"><span><b>证据（可选，可多行）</b></span><textarea id="vote-evidence" class="textarea" maxlength="2000" placeholder="文件、测试结果、风险；逐角色投票时也可补充"></textarea></label>
    <p class="hint">发起人只能是需求分析师；发起即视为 analyst 投“驳回”。PM 不参与投票。除 PM 外全员一致驳回才生效。</p>
    <div class="modal-error"></div>`;
  openModal({
    title: '发起驳回 Owner 需求投票',
    subtitle: `${p.name} · 除 PM 外全员`,
    icon: '◇',
    body: wrap,
    width: 640,
    actions: [
      { label: '取消', kind: 'ghost', onClick: ({ close }) => close() },
      { label: '发起投票', kind: 'primary', onClick: async ({ close, error }) => {
        try {
          const reqId = wrap.querySelector('#vote-req').value;
          const reason = wrap.querySelector('#vote-reason').value.trim();
          const evidence = wrap.querySelector('#vote-evidence').value.trim();
          if (!reason && !evidence) throw new Error('发起投票必须写理由或证据，不能空票');
          await createVote({ requirementId: reqId, reason, evidence });
          close();
        } catch (e) { error(e.message); }
      } }
    ]
  });
  setTimeout(() => wrap.querySelector('#vote-reason')?.focus(), 40);
}

async function createVote({ requirementId, reason, evidence }) {
  const p = activeProject();
  if (!p) throw new Error('先选择工作区');
  if (!voteIpcAvailable()) throw new Error('preload 没有 vote:start：不能发起投票');
  if (!requirementId) throw new Error('先选择 Owner 需求');
  const r = await window.workbench.voteStart({
    projectId: p.id,
    role: 'analyst',
    requirementId,
    reason: String(reason || '').slice(0, 1000),
    evidence: String(evidence || '').slice(0, 4000),
    teamMode: projectTeamMode(p)
  });
  if (!r || r.ok === false) throw new Error((r && (r.message || r.code)) || '发起投票失败');
  if (r.state) { state = r.state; }
  if (r.snapshot && r.snapshot.ok !== false) {
    legacyUi.workflow = {
      ...(legacyUi.workflow || {}),
      ...r.snapshot,
      phase: legacyDisplayPhase(
        r.snapshot.phase || legacyPhaseFromRequirements(r.snapshot.requirements, r.snapshot.round),
        r.snapshot.requirements
      )
    };
  }
  render();
  await loadVotes(true);
  renderFlow();
  const vote = r.vote || null;
  toast(`投票已发起：${vote ? vote.id : ''} · ${vote && vote.counts ? vote.counts.eligible : 0} 名非 PM 成员`, 'ok');
  return r;
}

async function castVote(voteId, roleId, verdict, reason) {
  const p = activeProject();
  if (!p) throw new Error('先选择工作区');
  if (!voteIpcAvailable()) throw new Error('preload 没有 vote:cast：不能投票');
  if (!['reject', 'approve'].includes(verdict)) throw new Error('先选择驳回 / 保留');
  const r = await window.workbench.voteCast({
    projectId: p.id,
    role: roleId,
    voteId,
    verdict,
    reason: String(reason || '').slice(0, 1000),
    teamMode: projectTeamMode(p)
  });
  if (!r || r.ok === false) throw new Error((r && (r.message || r.code)) || '投票失败');
  if (r.state) { state = r.state; }
  if (r.snapshot && r.snapshot.ok !== false) {
    legacyUi.workflow = {
      ...(legacyUi.workflow || {}),
      ...r.snapshot,
      phase: legacyDisplayPhase(
        r.snapshot.phase || legacyPhaseFromRequirements(r.snapshot.requirements, r.snapshot.round),
        r.snapshot.requirements
      )
    };
  }
  render();
  await loadVotes(true);
  renderFlow();
  const vote = r.vote || null;
  toast(`${roleById(roleId).name} 已投「${verdict === 'reject' ? '驳回' : '保留'}」 · ${voteResultLabel(vote)}`, 'ok');
  return r;
}

/* ── 旧流程：六角色目录、每轮必读、阶段闸门 ───────────────
 * 本区块只做两件事：
 *   ① 把项目内真实文件（files:list / files:read）与旧工作流状态摆出来；
 *   ② boot/必读状态读 workflow:briefing；未 boot、文档变更或后端报错时禁用动作，
 *      不用界面状态补造角色已读/已验收。
 */
const LEGACY_READ_ORDER = [
  { key: 'rules', no: '1', label: '项目铁律', note: '每次第一件：底线、红线、失败即停' },
  { key: 'info', no: '2', label: '项目信息', note: '目标 / 场景 / 交付 / 边界' },
  { key: 'card', no: '3', label: '角色卡', note: '六角色各自的角色卡.md' },
  { key: 'others', no: '4', label: '其他人文档', note: '其他角色目录 / 文件索引' }
];
const LEGACY_PROJECT_DOCS = [
  { key: 'rules', rel: '项目铁律.md', label: '项目铁律', mark: '律', note: '按需避坑（不必每轮读）；项目目录缺失时旧工具会回退团队根' },
  { key: 'info', rel: '项目信息.md', label: '项目信息', mark: '息', note: 'PM 先填写；未写清楚前 PM 不叫其他角色' },
  { key: 'index', rel: '项目索引.md', label: '项目索引', mark: '引', note: '先读索引再找文件；不跳过索引直接 glob/grep' },
  { key: 'overview', rel: '需求/00-需求总览.md', label: '需求总览', mark: '求', note: '当前需求总览；缺它旧 boot 会判必读不完整' },
  { key: 'guide', rel: '协作准则.md', label: '协作准则', mark: '则', note: '六角色协作、启动顺序与文件规则' }
];

const legacyUi = {
  projectId: null,
  loading: false,
  at: 0,
  files: null,
  truncated: false,
  docs: Object.create(null),
  docEpoch: 0,
  docTab: 'rules',
  roleId: 'pm',
  forceQueued: false,
  workflow: null,
  // 当前项目的阶段推导结果（只读）：界面只渲染它，工作流.json.phase 仅作历史提示。
  flowDerive: null,
  briefing: null,
  briefingError: null,
  // B-20261114-003257-0a46（R-d734）：docs:presence 的真实返回（项目信息/铁律存在性 + 来源）。
  presence: null,
  presenceError: null,
  workflowError: null,
  phaseHint: null,
  error: null,
  ipcMissing: [],
  // 本次界面里 workflow:boot 的真实返回（内存证据，刷新即失效；不写盘、不补造）。
  bootEvidence: Object.create(null),
  // 全队 boot 进行中：按钮禁用，避免同角色重复发请求。
  bootingAll: false,
  // 本次界面最近一次 workflow 动作的真实返回摘要：缺命令/文件契约必须留下痕迹，不能只弹“成功”。
  lastAction: null,
  // 本机 Owner 记录：只有用户点下 Owner（我）一次点击按钮，才在这里留下 actor；
  // 它只用于界面显示“谁在本机点击”，不冒充后端返回的身份证明。
  ownerConfirmations: Object.create(null)
};


const ICON_SUN = '<svg viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="2.6"/><path d="M8 1.5v1.8M8 12.7v1.8M1.5 8h1.8M12.7 8h1.8M3.4 3.4l1.3 1.3M11.3 11.3l1.3 1.3M12.6 3.4l-1.3 1.3M4.7 11.3l-1.3 1.3"/></svg>';
const ICON_MOON = '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M13.2 9.6A5.3 5.3 0 0 1 6.4 2.8a5.3 5.3 0 1 0 6.8 6.8Z"/></svg>';

/* ── 基础工具 ─────────────────────────────────────────── */

const esc = (value) => String(value ?? '').replace(/[&<>"']/g, (ch) => ({
  '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;'
}[ch]));

function humanError(value) {
  return String(value ?? '')
    .replace(/^Error invoking remote method '[^']+':\s*(Error:\s*)?/, '')
    .replace(/^Error:\s*/, '')
    .trim();
}

// R-c1ed（卷2 §五）注：这里用 `const` 而不是 `function` 声明——页面里有 `<div id="toast">`，
// 全局函数声明会被同名具名元素盖住（`typeof toast === 'object'`），导致本文件里的 toast() 调用
// 与外部脚本/自动化都调不动。全局词法绑定（const/let）优先于 window 具名属性，故改用 const。
const toast = function toast(message, kind = '') {
  const el = $('#toast');
  if (!el) return;
  const text = modeCopyText(humanError(message));
  // R-c1ed（卷2 §五）：toast 是唯一通知入口——每次自增 [data-toast-count]（压测前后差=0 的载体），
  // 并落 通知审计.jsonl：沙盘（TEAM_SELFTEST=1）下 toast 只落审计，**也必须写一行** suppressed='sandbox'，
  // 否则「没发」与「没记」分不清。
  const api = (typeof window !== 'undefined' && window.workbench) ? window.workbench : {};
  const audit = (suppressed) => {
    try {
      if (typeof api.notifyAudit === 'function') {
        api.notifyAudit({ level: kind || 'info', text, source: 'toast', suppressed });
      }
    } catch { /* 审计失败不影响 toast 本身 */ }
  };
  if (api.sandbox) { audit('sandbox'); return; }
  const nextCount = Number(el.getAttribute('data-toast-count') || 0) + 1;
  el.setAttribute('data-toast-count', String(nextCount));
  el.textContent = text;
  el.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = 'toast' + (kind ? ' ' + kind : '');
  }, kind === 'bad' || kind === 'warn' ? 4200 : 2600);
  audit('');
};

/* ── 主题：双维度 5 档（R-fe90 F-1~F-5）────────────────────────────
 * data-style(native|tech|anime|glass) × data-theme(dark|light)，合法组合 5 个；
 * 旧 html[data-theme="light"] 仍由 style.css 负责（暖白），新样式只挂 data-style。
 * 解析/迁移全走 theme-manifest.js；本段只做「读 DOM / 写 DOM / 持久化 / 同步界面」。
 */

const LAST_THEME = { source: 'default' };

function themeReadStorage() {
  try { return localStorage.getItem(THEME_STORAGE_KEY) || ''; } catch { return ''; }
}

function themeWriteStorage(themeId) {
  try { localStorage.setItem(THEME_STORAGE_KEY, themeId); } catch { /* 隐私模式忽略 */ }
}

function themeResolve(input) {
  if (THEME_MANIFEST && typeof THEME_MANIFEST.resolveTheme === 'function') return THEME_MANIFEST.resolveTheme(input);
  const raw = typeof input === 'string' ? input : ((input && input.storageValue) || '');
  return { themeId: raw || 'tech-dark', style: 'tech', theme: 'dark', source: 'default', fallback: false, reason: 'manifest-missing' };
}

/** 旧口径（light|dark）：看板窗/iframe 只认这两个值，保持兼容（AC4「旧调用点行为不变」） */
function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

/** 新口径：完整 themeId（形如 native-dark / tech-dark，5 个值由清单给出，这里不重复列举） */
function currentThemeId() {
  const el = document.documentElement;
  const id = el.getAttribute('data-theme-id');
  if (id && THEME_ORDER_APP.indexOf(id) >= 0) return id;
  const joined = `${el.getAttribute('data-style') || 'tech'}-${currentTheme()}`;
  return THEME_ORDER_APP.indexOf(joined) >= 0 ? joined : (THEME_ORDER_APP[0] || 'tech-dark');
}

function themeLabel(themeId) {
  const key = themeId || currentThemeId();
  return THEME_NAME[key] || THEME_NAME[currentTheme()] || key;
}

function nextThemeId(themeId) {
  const id = themeId || currentThemeId();
  if (THEME_MANIFEST && typeof THEME_MANIFEST.nextThemeId === 'function') return THEME_MANIFEST.nextThemeId(id);
  return id === 'native-dark' ? 'native-light' : 'native-dark';
}

/* 三层降级的读数口径（F-7；优先级 off > prefers-reduced-motion > full） */
function themeEffectLevel() {
  const raw = document.documentElement.getAttribute('data-effect-level');
  return raw === 'reduced' || raw === 'off' ? raw : 'full';
}

function themeReducedMotion() {
  try { return Boolean(window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch { return false; }
}

function themeLowFx() {
  let low = false;
  try { low = new URLSearchParams(location.search || '').get('lowfx') === '1'; } catch { /* ignore */ }
  return low || themeEffectLevel() !== 'full';
}

/** 当前档位的特效开关（4 项 + mode，供 __themeState() 与降级断言）
 *  R-fe90 F7（卷-2 §一 / §六）：粒子、点击涟漪、移动光晕与降级判定**单点实现在 fx-layer.js**，
 *  本函数只做「档位 → 开关」映射，不再维护第二套特效状态（避免重复渲染与两套真相）。
 *  注：卷-2 §四.5 反例要求「5 档里任一档粒子不可见即不合格」，所以粒子不再只限科技档；
 *      grid=科技、blur=玻璃、bounce=动漫 的主题专属装饰不变。 */
function themeEffects(themeId) {
  const id = themeId || currentThemeId();
  if (window.AWB_FX && typeof window.AWB_FX.effects === 'function') return window.AWB_FX.effects(id);
  // 7a3b §6.3 / AC6：fx 层不可用时不得对外谎报「开着」。
  return { mode: 'off', particles: false, grid: false, blur: false, bounce: false, idle: false, particleCount: 0, fxUnavailable: true };
}
try { window.__awbThemeEffects = themeEffects; } catch { /* ignore */ }

/** 主题状态（F-6 的一部分 + 增补卷-fe90-1 §一.5：source 区分「URL 真生效」与「碰巧等于默认」） */
function themeState() {
  const id = currentThemeId();
  const parts = (THEME_MANIFEST && typeof THEME_MANIFEST.splitThemeId === 'function' && THEME_MANIFEST.splitThemeId(id)) || {};
  return {
    themeId: id,
    style: document.documentElement.getAttribute('data-style') || parts.style || 'tech',
    theme: currentTheme(),
    source: LAST_THEME.source || 'default',
    effects: themeEffects(id),
    // R-fe90 F7：AC13–AC16 的唯一取数口（同步；字段表见 fx-layer.js 文件头）。
    fx: (window.AWB_FX && typeof window.AWB_FX.themeStateFx === 'function')
      ? window.AWB_FX.themeStateFx()
      : { sample: function () { return { ok: false, code: 'FX_LAYER_MISSING' }; } },
    // 卷-2 §六.5：性能兜底自动降级必须能被读到（不静默）
    fxDegraded: (window.AWB_FX && typeof window.AWB_FX.degraded === 'function') ? window.AWB_FX.degraded() : null,
    reducedMotion: themeReducedMotion(),
    lowfx: themeLowFx(),
    effectLevel: themeEffectLevel(),
  };
}

/* ── R-fe90 F7 特效层单点实现：fx-layer.js（#fx-layer = body 直接子元素） ──────────
 * 粒子 / 点击涟漪 / 移动光晕 / 三层降级 / 唯一取数口 __themeState().fx.sample() 都在那边；
 * 本段只留历史调用点的兼容薄壳（AWB_THEME_FX / awbThemeParticleCount / awbThemeFxSync），
 * **不再自己建 canvas**：卷-2 §一.1 要求 #fx-layer 是粒子 canvas 的唯一挂载点。
 */
const AWB_THEME_FX = { canvas: null, ctx: null, parts: [], running: false, idle: false, composite: 'lighter' };

function awbThemeParticleCount() {
  return (window.AWB_FX && typeof window.AWB_FX.particleCount === 'function') ? window.AWB_FX.particleCount() : 0;
}

function awbThemeFxSync() {
  if (window.AWB_FX && typeof window.AWB_FX.sync === 'function') window.AWB_FX.sync();
}

/** R-fe90 F-6 性能探针：rAF 采样 + 主进程真实内存，返回 AC6 需要的四项（fps/p95/dropRate/memMB） */
function themeProbe(ms) {
  const sampleMs = Math.max(300, Math.min(30000, Number(ms) || 5000));
  return new Promise((resolve) => {
    const themeId = currentThemeId();
    const intervals = [];
    let last = 0;
    let raf = 0;
    const start = performance.now();
    const finish = (ts) => {
      const dur = Math.max(1, ts - start);
      const frames = intervals.length;
      const sorted = intervals.slice().sort((a, b) => a - b);
      const p95 = frames >= 20 ? sorted[Math.ceil(0.95 * frames) - 1] : null;
      const drops = intervals.filter((v) => v > 25).length;
      const out = {
        themeId,
        sampleMs,
        frames,
        fps: Math.round((frames / dur) * 1000 * 100) / 100,
        p95FrameMs: p95 == null ? null : Math.round(p95 * 100) / 100,
        dropRate: frames ? Math.round((drops / frames) * 10000) / 100 : 0,
        memMB: null,
        reducedMotion: themeReducedMotion(),
        lowfx: themeLowFx(),
        at: Date.now()
      };
      const metrics = (window.workbench && typeof window.workbench.themeMetrics === 'function')
        ? window.workbench.themeMetrics()
        : Promise.resolve(null);
      Promise.resolve(metrics)
        .then((mem) => { if (mem && Number.isFinite(mem.totalMB)) out.memMB = mem.totalMB; })
        .catch(() => { /* 内存取不到就留 null，不伪造 */ })
        // R-fe90 F7（卷-2 §六.5）：性能兜底自动降级看的是「连续 2 个采样窗口」，
        // 所以每个 __themeProbe 结果都要交回特效层（同时缓存 AC6 四项数字给 fx.sample().perf）。
        .then(() => { try { if (window.AWB_FX && typeof window.AWB_FX.observeProbe === 'function') window.AWB_FX.observeProbe(out); } catch (error) { /* 降级失败不影响探针结果 */ } })
        .then(() => resolve(out));
    };
    const step = (ts) => {
      if (last) intervals.push(ts - last);
      last = ts;
      if (ts - start < sampleMs) { raf = requestAnimationFrame(step); return; }
      cancelAnimationFrame(raf);
      finish(ts);
    };
    raf = requestAnimationFrame(step);
  });
}

function applyThemeState(resolved, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const r = resolved || themeResolve({ storageValue: themeReadStorage(), search: location.search });
  const el = document.documentElement;
  el.setAttribute('data-style', r.style);
  el.setAttribute('data-theme', r.theme);
  el.setAttribute('data-theme-id', r.themeId);
  LAST_THEME.source = r.source || 'default';
  if (options.persist !== false) themeWriteStorage(r.themeId);
  syncThemeUi();
  // F-7：按新档位增删/启停粒子层（科技档才有；非科技档会移除画布）
  try { awbThemeFxSync(); } catch { /* 特效异常不影响换肤 */ }
  // 独立看板窗口与内嵌 iframe 不继承外壳变量：切主题时同步过去，避免“先黑后白”。
  // 5 档要看板窗同时同步 data-style + data-theme（增补卷-fe90-1 §四.1）。
  try {
    if (window.workbench && typeof window.workbench.boardTheme === 'function') {
      window.workbench.boardTheme({ theme: r.theme, style: r.style, themeId: r.themeId }).catch(() => {});
    }
  } catch { /* 看板未打开时忽略 */ }
  if (typeof boardUi !== 'undefined' && boardUi && boardUi.framePath) loadBoardFrame(boardUi.framePath);
  return r;
}

/** 旧调用兼容：applyTheme('dark'|'light'|完整 id)。显式选择，不读 URL 参数 */
function applyTheme(mode) {
  const input = (typeof mode === 'string' && mode) ? mode : themeReadStorage();
  return applyThemeState(themeResolve({ storageValue: input, search: '' }), { persist: true });
}

/** 入口 5 项点击 / 探针调用：按 themeId 显式切换 */
function applyThemeId(themeId) {
  const applied = applyThemeState(themeResolve({ storageValue: themeId, search: '' }), { persist: true });
  toast(`已切换为「${themeLabel(applied.themeId)}」主题`, 'ok');
  return applied;
}

function syncThemeUi() {
  const id = currentThemeId();
  const items = $$('#more-menu [data-theme-id]');
  let checked = 0;
  for (const item of items) {
    const on = item.dataset.themeId === id;
    item.setAttribute('aria-checked', String(on));
    item.classList.toggle('on', on);
    if (on) checked += 1;
  }
  const label = $('#more-menu [data-more="theme"] .mm-text');
  if (label) label.textContent = `外观：${themeLabel(id)}`;
  // 标题栏主题按钮已按 B-0538 移除；保留兼容分支（元素不存在时整段跳过）
  const btn = $('#btn-theme');
  if (btn) {
    const next = nextThemeId(id);
    btn.innerHTML = currentTheme() === 'dark' ? ICON_SUN : ICON_MOON;
    btn.title = `当前：${themeLabel(id)}，点击切换为${themeLabel(next)}`;
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', String(currentTheme() === 'light'));
  }
  return checked;
}

/** 5 档循环切换（菜单点当前项之后也走这里；旧按钮/快捷键同源） */
function toggleTheme() {
  const next = nextThemeId(currentThemeId());
  applyThemeId(next);
  return next;
}

function setThemeMenu(open) {
  const box = $('#more-menu [data-theme-menu]');
  const btn = $('#more-menu [data-more="theme"]');
  if (!box) return;
  box.hidden = !open;
  if (btn) btn.setAttribute('aria-expanded', String(Boolean(open)));
}

function themeMenuItems() {
  return $$('#more-menu [data-theme-menu] [data-theme-id]');
}

function themeMenuFocus(step) {
  const items = themeMenuItems();
  if (!items.length) return;
  const current = items.indexOf(document.activeElement);
  const next = current < 0 ? 0 : (current + step + items.length) % items.length;
  items[next].focus();
}

/* ── R-8947 关闭特效开关（三档 off/low/full）─────────────────────────────
 * 落盘值（workbench.json ui.effectLevel）：'off' | 'reduced' | 'full'
 * DOM 属性（documentElement data-effect-level）：'off' | 'reduced' | 移除
 * —— 选项值（off/low/full）与属性值不同名，AC1 禁止两者混用。 */
const EFFECT_LEVEL_LABEL = { off: '关闭', low: '低特效（关闭粒子与光晕，保留点击涟漪）', full: '完整' };
const EFFECT_ATTR_OF = { off: 'off', low: 'reduced', full: '' };
function effectLevelOfAttr(raw) {
  const v = String(raw || '');
  if (v === 'off') return 'off';
  if (v === 'reduced') return 'low';
  return 'full';
}
function currentEffectOption() {
  return effectLevelOfAttr(document.documentElement.getAttribute('data-effect-level'));
}
/** B-20261118-005604-54e3：顶部红字横幅——点档后「更多」菜单立即收起，行内错误矩形 0×0 看不见，
 *  所以失败必须同时在 #effect-error-banner（role=alert，照 #decision-error-banner 先例）留一份可见文案。 */
function setEffectBanner(text) {
  const msg = text ? String(text) : '';
  EFFECT_ERROR_TEXT = msg;
  const el = $('#effect-error-banner');
  const textEl = $('#effect-error-text');
  if (el) el.hidden = !msg;
  if (textEl) textEl.textContent = msg;
}
let EFFECT_ERROR_TEXT = '';
function setEffectError(text) {
  const msg = text ? String(text) : '';
  const box = $('#more-menu [data-effect-error]');
  if (box) {
    box.hidden = !msg;
    box.textContent = msg;
  }
  setEffectBanner(msg);
}
function paintEffectMenu() {
  const cur = currentEffectOption();
  for (const item of $$('#more-menu [data-effect-menu] [data-effect-option]')) {
    item.setAttribute('aria-checked', String(item.dataset.effectOption === cur));
  }
  const label = $('#more-menu [data-more="effect"] [data-effect-current]');
  // 7a3b §6.1：真实态来自 fx 层（不再只读手动档）；系统减少动画降级时给提示行 + 仍然开启。
  let real = null;
  try { if (window.AWB_FX && typeof window.AWB_FX.mode === 'function') real = window.AWB_FX.mode(); } catch { real = null; }
  const realMode = real && real.level ? String(real.level) : (window.AWB_FX ? 'unknown' : 'unavailable');
  const realBox = $('#more-menu [data-fx-real-mode]');
  if (realBox) {
    realBox.setAttribute('data-fx-real-mode', realMode);
    const text = $('#more-menu [data-fx-real-mode-text]');
    const textOf = realMode === 'unavailable' ? '特效层未加载' : ('真实特效：' + realMode + (real && real.reasons && real.reasons.length ? '（' + real.reasons.join('、') + '）' : ''));
    if (text) text.textContent = textOf; else realBox.textContent = textOf;
  }
  const reducedHint = $('#more-menu [data-fx-reduced-hint]');
  const forceBtn = $('#more-menu [data-fx-force-btn]');
  const forced = Boolean(real && real.forced);
  const forcedHint = $('#more-menu [data-fx-forced-hint]');
  if (forcedHint) forcedHint.hidden = !forced;
  const showHint = realMode === 'reduced' && cur === 'full' && !forced;
  if (reducedHint) reducedHint.hidden = !showHint;
  if (forceBtn) forceBtn.hidden = !showHint;
  if (label) label.textContent = realMode === 'unavailable' ? '特效层未加载' : ((EFFECT_LEVEL_LABEL[cur] || '完整') + (showHint ? '（系统减少动画已降级）' : ''));
  try { bindFxRealState(); } catch { /* ignore */ }
}
try { window.__awbPaintEffectMenu = paintEffectMenu; } catch { /* ignore */ }
function applyEffectOption(opt) {
  const attr = EFFECT_ATTR_OF[opt];
  if (attr === undefined) return false;
  if (attr) document.documentElement.setAttribute('data-effect-level', attr);
  else document.documentElement.removeAttribute('data-effect-level');
  try { if (typeof awbThemeFxSync === 'function') awbThemeFxSync(); } catch { /* 特效异常不影响界面 */ }
  paintEffectMenu();
  return true;
}
async function chooseEffectOption(opt) {
  setEffectError('');
  // 先写盘再改界面：写失败时界面保持原档（AC7 回退），不会停在半套状态。
  const api = window.workbench && window.workbench.setThemeEffectLevel;
  const res = typeof api === 'function' ? await api(opt).catch((e) => ({ ok: false, code: 'EFFECT_LEVEL_WRITE_FAILED', message: String((e && e.message) || e) })) : { ok: false, code: 'EFFECT_LEVEL_UNAVAILABLE' };
  if (!res || res.ok !== true) {
    setEffectError(`特效档位切换失败：${(res && res.code) || 'EFFECT_LEVEL_WRITE_FAILED'}${res && res.message ? `（${res.message}）` : ''}`);
    // 回退到磁盘现状（重新读 IPC），不保留半套界面。
    try {
      const now = await window.workbench.themeEffectLevel();
      applyEffectOption(effectLevelOfAttr(now && now.level));
    } catch { /* ignore */ }
    return false;
  }
  applyEffectOption(opt);
  return true;
}
function setEffectMenu(open) {
  const box = $('#more-menu [data-effect-menu]');
  const btn = $('#more-menu [data-more="effect"]');
  if (!box) return;
  box.hidden = !open;
  if (btn) btn.setAttribute('aria-expanded', String(Boolean(open)));
}


// 7a3b：真实态一键强制 + 特效诊断（菜单内控件，不新增标题栏按钮）。
// 7a3b 补口（AC1⑥）：启动时读取 workbench.json ui.fxForce → 恢复 data-fx-force（重启仍保持）。
async function loadPersistedFxForce() {
  try {
    if (!window.workbench || typeof window.workbench.fxForceGet !== 'function') return;
    const r = await window.workbench.fxForceGet();
    if (!r || r.ok !== true) return;
    if (r.force) {
      document.documentElement.setAttribute('data-fx-force', '1');
      try { if (window.AWB_FX && typeof window.AWB_FX.sync === 'function') window.AWB_FX.sync(); } catch { /* ignore */ }
    } else document.documentElement.removeAttribute('data-fx-force');
    try { if (typeof window.__awbPaintEffectMenu === 'function') window.__awbPaintEffectMenu(); } catch { /* ignore */ }
  } catch { /* 读取失败不阻断界面 */ }
}

function bindFxRealState() {
  const forceBtn = $('#more-menu [data-fx-force-btn]');
  if (forceBtn && !forceBtn.getAttribute('data-bound')) {
    forceBtn.setAttribute('data-bound', '1');
    forceBtn.addEventListener('click', () => {
      document.documentElement.setAttribute('data-fx-force', '1');
      try { if (window.AWB_FX && typeof window.AWB_FX.sync === 'function') window.AWB_FX.sync(); } catch { /* ignore */ }
      paintEffectMenu();
      try { if (window.workbench && typeof window.workbench.fxForceSet === 'function') window.workbench.fxForceSet(true); } catch { /* ignore */ }
    });
  }
  const forceOff = $('#more-menu [data-fx-force-off]');
  if (forceOff && !forceOff.getAttribute('data-bound')) {
    forceOff.setAttribute('data-bound', '1');
    forceOff.addEventListener('click', () => {
      document.documentElement.removeAttribute('data-fx-force');
      try { if (window.AWB_FX && typeof window.AWB_FX.sync === 'function') window.AWB_FX.sync(); } catch { /* ignore */ }
      try { if (window.workbench && typeof window.workbench.fxForceSet === 'function') window.workbench.fxForceSet(false); } catch { /* ignore */ }
      paintEffectMenu();
    });
  }

  const diag = $('#more-menu [data-fx-diag]');
  if (diag && !diag.getAttribute('data-bound')) {
    diag.setAttribute('data-bound', '1');
    diag.addEventListener('toggle', () => {
      if (!diag.open) return;
      let s = null;
      try { if (window.AWB_FX && typeof window.AWB_FX.sample === 'function') s = window.AWB_FX.sample(); } catch { s = null; }
      const body = diag.querySelector('[data-fx-diag-body]');
      if (!body) return;
      if (!s) { body.textContent = '特效层未加载'; return; }
      const perf = (s.perf && typeof s.perf === 'object') ? s.perf : {};
      let dg = null;
      try { if (window.AWB_FX && typeof window.AWB_FX.degraded === 'function') dg = window.AWB_FX.degraded(); } catch { dg = null; }
      body.textContent = 'mode=' + s.mode + ' ｜ reasons=' + ((s.reasons || []).join('、') || '无')
        + ' ｜ 粒子=' + (s.particles || s.particleCount || 0)
        + ' ｜ fps=' + (perf.fps != null ? perf.fps : '—')
        + (dg && dg.steps && dg.steps.length ? ' ｜ 已降级=' + dg.steps.join(',') : '');
    });
  }
  try { loadPersistedFxForce(); } catch { /* ignore */ }
}

// e610：在线升级菜单（版本展示 / 检查 / 一步升级 / 重启提示），不新增标题栏图标。
const UPGRADE_UI = { checking: false, starting: false, info: null, version: null, forceNeeded: false, progress: '', error: '', auto: { enabled: false, intervalMs: 0, timer: 0 } };
function upgradeEl(sel) { return document.querySelector('#more-menu ' + sel); }
function paintUpgrade() {
  const line = upgradeEl('[data-app-version-line]');
  if (line && UPGRADE_UI.version) line.textContent = '当前版本 ' + UPGRADE_UI.version.version + (UPGRADE_UI.version.commit ? ' · ' + UPGRADE_UI.version.commit : '');
  const lbl = upgradeEl('[data-more="upgrade"] .mm-text');
  const info = UPGRADE_UI.info;
  if (lbl) {
    if (!info) lbl.textContent = '检查更新';
    else if (info.state === 'available') lbl.textContent = '可升级：' + info.latest;
    else if (info.state === 'latest') lbl.textContent = '已是最新';
    else if (info.state === 'missing-sha') lbl.textContent = '暂不可升级（源缺校验值）';
    else lbl.textContent = '无法检查更新';
  }
  const st = upgradeEl('[data-upgrade-state]');
  if (st) { st.hidden = !info; st.textContent = info ? String(info.message || '') : ''; st.setAttribute('data-upgrade-state-kind', info ? info.state : ''); }
  const applyBtn = upgradeEl('[data-upgrade-apply]');
  if (applyBtn) applyBtn.hidden = !(info && info.state === 'available');
  // R-20261119：kind=installer 的版本源（重跑安装器升级）暂不走壳层自动应用——隐藏「立即升级」并给可读指引，
  // 避免点了按钮却把 .ps1 当升级包下载（下一版接入安装器重跑流程后再放开）。
  if (info && info.state === 'available' && info.kind === 'installer') {
    if (applyBtn) applyBtn.hidden = true;
    if (st) st.textContent = String(info.message || '有新版本') + '（请重新运行安装脚本完成升级）';
  }
  const err = upgradeEl('[data-upgrade-error]');
  if (err) { err.hidden = !UPGRADE_UI.error; if (UPGRADE_UI.error) err.textContent = UPGRADE_UI.error; }
  // B-d83d（P0）：点「立即升级」必须当场有可见状态；强制原因输入框只在真的需要时展示。
  const prog = upgradeEl('[data-upgrade-progress]');
  if (prog) {
    const text = String(UPGRADE_UI.progress || '');
    prog.hidden = !text;
    if (text) prog.textContent = text;
  }
  const forceLine = upgradeEl('[data-upgrade-force]');
  if (forceLine) forceLine.hidden = UPGRADE_UI.forceNeeded !== true;
  const reasonEl = upgradeEl('[data-upgrade-reason]');
  if (reasonEl && forceLine && !forceLine.hidden && document.activeElement !== reasonEl) {
    try { reasonEl.focus(); } catch { /* ignore */ }
  }
  // e610 AC6：有新版只亮小圆点（非侵入提示），不下载、不安装
  const dot = upgradeEl('[data-upgrade-dot]');
  if (dot) dot.hidden = !(info && info.state === 'available');
  const autoBox = upgradeEl('[data-upgrade-auto]');
  if (autoBox) autoBox.checked = UPGRADE_UI.auto.enabled === true;
  const autoLine = upgradeEl('[data-upgrade-auto-line]');
  if (autoLine) autoLine.hidden = false;
}
async function loadAppVersion() {
  try { if (window.workbench && typeof window.workbench.appVersion === 'function') UPGRADE_UI.version = await window.workbench.appVersion(); } catch { UPGRADE_UI.version = null; }
  paintUpgrade();
}
async function checkUpgrade() {
  if (UPGRADE_UI.checking) return;
  UPGRADE_UI.checking = true; UPGRADE_UI.error = '';
  const st = upgradeEl('[data-upgrade-state]');
  if (st) { st.hidden = false; st.textContent = '正在检查更新…'; }
  try {
    const res = await window.workbench.upgradeCheck(window.__awbUpgradeFeedSource ? { source: window.__awbUpgradeFeedSource } : {});
    UPGRADE_UI.info = res || { state: 'unavailable', message: '无法检查更新' };
  } catch (e) { UPGRADE_UI.info = { state: 'unavailable', message: '无法检查更新：' + String((e && e.message) || e) }; }
  finally {
    UPGRADE_UI.checking = false; paintUpgrade();
    // R-20261119：检查结果必须有全局可见反馈（菜单可能被收起；不能只在菜单内一行）。
    try {
      const info = UPGRADE_UI.info || {};
      if (info.state === 'available') toast('发现新版本 ' + String(info.latest || ''), 'ok');
      else if (info.state === 'latest') toast('已是最新版本', 'ok');
      else toast(String(info.message || '无法检查更新'), 'bad');
    } catch { /* ignore */ }
  }
}
// ── e610 AC6：自动检查（只检查/只提示；绝不自动下载或安装）──────────────────────
async function loadUpgradeAutoPref() {
  try {
    if (window.workbench && typeof window.workbench.upgradeAutoGet === 'function') {
      const res = await window.workbench.upgradeAutoGet();
      UPGRADE_UI.auto.enabled = Boolean(res && res.enabled === true);
      const interval = Number(res && res.intervalMs);
      UPGRADE_UI.auto.intervalMs = Number.isFinite(interval) && interval > 0 ? interval : 30 * 60 * 1000;
    }
  } catch { /* 读取失败按关闭处理 */ }
  scheduleUpgradeAuto();
  paintUpgrade();
}
function scheduleUpgradeAuto() {
  if (UPGRADE_UI.auto.timer) { try { clearInterval(UPGRADE_UI.auto.timer); } catch { /* ignore */ } UPGRADE_UI.auto.timer = 0; }
  if (!UPGRADE_UI.auto.enabled) return;
  const ms = Math.max(1000, Number(UPGRADE_UI.auto.intervalMs) || 30 * 60 * 1000);
  UPGRADE_UI.auto.timer = setInterval(() => { void autoCheckUpgrade(); }, ms);
}
async function autoCheckUpgrade() {
  // 只做「检查」，发现新版只亮小圆点；这里永远不调用 startUpgrade（AC6）。
  if (UPGRADE_UI.checking || UPGRADE_UI.starting) return;
  await checkUpgrade();
}
async function setUpgradeAuto(enabled) {
  const want = enabled === true;
  UPGRADE_UI.auto.enabled = want;
  try {
    if (window.workbench && typeof window.workbench.upgradeAutoSet === 'function') {
      const res = await window.workbench.upgradeAutoSet(want);
      UPGRADE_UI.auto.enabled = Boolean(res && res.enabled === true);
      const interval = Number(res && res.intervalMs);
      if (Number.isFinite(interval) && interval > 0) UPGRADE_UI.auto.intervalMs = interval;
    }
  } catch { UPGRADE_UI.auto.enabled = want; }
  scheduleUpgradeAuto();
  paintUpgrade();
}
async function startUpgrade() {
  // B-d83d（P0 修）：原实现先读隐藏的 [data-upgrade-reason]，空就写隐藏错误并 return → 用户点「立即升级」毫无反应。
  // 新口径：①点击立刻给可见进度/提示；②无 reason 时走非 force 升级（无在跑角色可直接升级）；
  // ③后端明确要求强制原因时才展示并聚焦输入框；④所有错误同时进菜单 + 全局 toast。
  if (UPGRADE_UI.starting) return;
  const info = UPGRADE_UI.info;
  if (!info || info.state !== 'available') {
    UPGRADE_UI.error = '当前没有可升级的版本，请先点「检查更新」';
    UPGRADE_UI.progress = '';
    paintUpgrade();
    toast(UPGRADE_UI.error, 'bad');
    return;
  }
  const reasonEl = upgradeEl('[data-upgrade-reason]');
  const reason = reasonEl ? String(reasonEl.value || '').trim() : '';
  UPGRADE_UI.starting = true;
  UPGRADE_UI.error = '';
  UPGRADE_UI.forceNeeded = false;
  UPGRADE_UI.progress = '正在准备升级…';
  const btn = upgradeEl('[data-upgrade-apply]');
  if (btn) btn.disabled = true;
  paintUpgrade();
  toast('开始升级：正在准备…', 'ok');
  try {
    const res = await window.workbench.upgradeStart({
      latest: info.latest,
      sha256: info.sha256,
      url: info.url,
      force: Boolean(reason),
      reason,
      dryRun: false
    });
    if (!res || res.ok !== true) {
      const code = String((res && res.code) || 'UPGRADE_FAILED');
      const msg = String((res && (res.message || res.code)) || code);
      const needReason = code === 'UPGRADE_FORCE_REASON_REQUIRED' || /强制|原因|角色.*(在跑|运行)/.test(msg);
      UPGRADE_UI.progress = '';
      if (needReason) {
        UPGRADE_UI.forceNeeded = true;
        UPGRADE_UI.error = '有角色在跑任务：请在「强制原因」里填写原因后再点「立即升级」';
        paintUpgrade();
        toast('需要填写强制原因才能升级', 'bad');
        return;
      }
      UPGRADE_UI.error = '升级失败：' + msg;
      paintUpgrade();
      toast(UPGRADE_UI.error, 'bad');
      return;
    }
    const hintText = String(res.restartHint || '请重启后生效');
    UPGRADE_UI.progress = '升级完成：' + hintText;
    const hint = upgradeEl('[data-upgrade-restart-hint]');
    if (hint) { hint.hidden = false; hint.textContent = hintText; }
    await loadAppVersion();
    UPGRADE_UI.info = { ...info, state: 'latest', message: '已升级到 ' + String(res.to || info.latest || '') + '，' + hintText };
    paintUpgrade();
    toast('升级完成：' + hintText, 'ok');
  } catch (e) {
    UPGRADE_UI.progress = '';
    UPGRADE_UI.error = '升级失败：' + String((e && e.message) || e);
    paintUpgrade();
    toast(UPGRADE_UI.error, 'bad');
  } finally {
    UPGRADE_UI.starting = false;
    if (btn) btn.disabled = false;
    paintUpgrade();
  }
}
// R-2de7：更多菜单维护区（干跑→清单→逐字短语→执行；结果区常显错误码与下一步）
function bindMaintPanel() {
  if (bindMaintPanel._bound) return; bindMaintPanel._bound = true;
  const panel = document.querySelector('[data-maint-panel]');
  if (!panel) return;
  const listEl = panel.querySelector('[data-maint-list]');
  const confirmLine = panel.querySelector('[data-maint-confirm-line]');
  const confirmEl = panel.querySelector('[data-maint-confirm]');
  const applyEl = panel.querySelector('[data-maint-apply]');
  const verifyEl = panel.querySelector('[data-maint-verify]');
  const resultEl = panel.querySelector('[data-maint-result]');
  let state = { mode: 'reset', json: null };
  const say = (msg, bad) => { if (!resultEl) return; resultEl.hidden = false; resultEl.textContent = String(msg || ''); resultEl.style.color = bad ? 'var(--bad, #d9534f)' : ''; };
  const renderDryRun = (json, meta = {}) => {
    if (!json) { say('干跑失败：没有拿到清单（看主进程日志）', true); return; }
    state.json = json;
    const items = Array.isArray(json.items) ? json.items : [];
    const lines = items.filter((i) => i.action === 'delete').map((i) => (i.result === 'already' ? '（已无）' : '') + i.path);
    if (listEl) { listEl.hidden = false; listEl.textContent = `[${json.mode}] 待处理 ${lines.length} 项：` + lines.slice(0, 8).join('；') + (lines.length > 8 ? ' …等' : ''); }
    if (confirmLine) confirmLine.hidden = false;
    if (applyEl) applyEl.hidden = false;
    if (verifyEl) verifyEl.hidden = false;
    if (confirmEl) confirmEl.placeholder = json.mode === 'reset' ? '重置' : '彻底卸载';
    const verdict = String(json.verdict || json.result || 'DRY_RUN');
    const logHint = meta && meta.logFile ? ` ｜ 日志：${meta.logFile}（${meta.logBytes}B）` : (meta && meta.logError ? ' ｜ 日志写入失败：' + meta.logError : '');
    say(`干跑完成（未删除任何文件）：判定 ${verdict} · 待处理 ${lines.length} 项 · 确认短语：${json.confirmExpected || (json.mode === 'reset' ? '重置' : '彻底卸载')}${logHint}`);
  };
  const dryRun = async (mode) => {
    state.mode = mode;
    try {
      const r = await window.workbench.maintRun({ mode, dryRun: true });
      if (!r || r.ok === false || !r.json) {
        const why = (r && (r.message || r.stdoutTail || r.stderrTail)) || '';
        say(`干跑失败（code=${(r && r.code) || '?'}）：${why}` + (r && r.logFile ? ` ｜ 日志：${r.logFile}（${r.logBytes}B）` : ''), true);
        return;
      }
      renderDryRun(r.json, r);
    } catch (e) { say('干跑异常：' + String((e && e.message) || e), true); }
  };
  if (panel) panel.addEventListener('click', async (event) => {
    const t = event.target instanceof Element ? event.target.closest('[data-maint]') : null;
    if (t) { await dryRun(t.getAttribute('data-maint')); return; }
    if (event.target.closest('[data-maint-apply]')) {
      const phrase = confirmEl ? String(confirmEl.value || '').trim() : '';
      if (!phrase) { say('先输入确认短语（重置 / 彻底卸载）', true); return; }
      say('执行中…');
      try {
        const r = await window.workbench.maintRun({ mode: state.mode, dryRun: false, confirm: phrase });
        const j = r && r.json;
        if (j && j.verdict === 'CLEAN') say(`完成：${j.mode === 'reset' ? '重置判定：干净' : '卸载判定：干净'}；备份：${j.backupZip || '（无）'}`);
        else say(`未完全干净（code=${(j && j.code) || (r && r.code) || '?'}）：${(j && j.message) || (r && r.stdoutTail) || ''}；可点「运行残留检测」` , true);
        if (verifyEl) verifyEl.hidden = false;
      } catch (e) { say('执行异常：' + String((e && e.message) || e), true); }
      return;
    }
    if (event.target.closest('[data-maint-verify]')) {
      say('检测中…');
      try {
        const r = await window.workbench.maintVerify({ mode: state.mode });
        const j = r && r.json;
        if (j) say(`${j.mode === 'reset' ? '重置判定' : '卸载判定'}：${j.verdict === 'CLEAN' ? '干净' : '有残留（' + j.residueCount + ' 项）'}` + (j.verdict === 'CLEAN' ? '' : '；详见清单'), j.verdict !== 'CLEAN');
        else say(`残留检测失败（code=${(r && r.code) || '?'}）`, true);
      } catch (e) { say('检测异常：' + String((e && e.message) || e), true); }
    }
  });
}

function bindUpgradeMenu() {
  if (bindUpgradeMenu._bound) return; bindUpgradeMenu._bound = true;
  document.addEventListener('click', (event) => {
    const t = event.target instanceof Element ? event.target.closest('[data-more="upgrade"], [data-upgrade-check], [data-upgrade-apply], [data-upgrade-menu]') : null;
    if (!t) return;
    if (t.matches('[data-more="upgrade"]')) { const box = upgradeEl('[data-upgrade-menu]'); if (box) box.hidden = !box.hidden; if (box && !box.hidden) { loadAppVersion(); paintUpgrade(); } return; }
    if (t.matches('[data-upgrade-check]')) { checkUpgrade(); return; }
    if (t.matches('[data-upgrade-apply]')) { startUpgrade(); return; }
  });
  // e610 AC6：自动检查开关（写 ui.autoUpgradeCheck；只影响检查频率，不触发安装）
  document.addEventListener('change', (event) => {
    const target = event.target;
    if (!(target instanceof Element) || !target.matches('[data-upgrade-auto]')) return;
    void setUpgradeAuto(Boolean(target.checked));
  });
  loadAppVersion();
  void loadUpgradeAutoPref();
}
try { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindUpgradeMenu); else bindUpgradeMenu(); } catch { /* ignore */ }
try { if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', bindMaintPanel); else bindMaintPanel(); } catch { /* 维护区不可用不阻断启动 */ }

function activeProject() {
  if (!state) return null;
  return state.projects.find((p) => p.id === state.activeProjectId) || state.projects[0] || null;
}

function roleById(id) {
  const key = String(id || '');
  return (state?.roles || []).find((r) => r.id === key)
    || { id: key || 'unknown', name: key || '未知角色', color: '#999', scope: '' };
}

function sessionEntries(project) {
  const sessions = (project && project.sessions) || {};
  // R-97db（B-190a）：有后端名册快照时以名册为准——归档成员/删工作区后 project.sessions 会残留，
  // 直接数它会让侧栏仍显示「6 人已就绪」（Owner 2026-11-20 实测回归）。
  const rosterIds = Array.isArray(project && project.rosterSessionIds) ? new Set(project.rosterSessionIds) : null;
  return teamRoles(project).map((role) => ({
    role,
    sessionId: rosterIds ? (rosterIds.has(role.id) ? (sessions[role.id] || null) : null) : (sessions[role.id] || null)
  }));
}

function sessionReadyCount(project) {
  return sessionEntries(project).filter((item) => item.sessionId).length;
}

/** 当前项目最近一次 DSH 核验结果；过期、换项目或 DSH 掉线都返回 null。 */
function liveFor(project, allowStale = false) {
  if (!project || !liveUi.projectId || liveUi.projectId !== project.id) return null;
  if (!allowStale && state && state.dsh && state.dsh.configured && !state.dsh.online) return null;
  if (!allowStale && !liveUi.loading && liveUi.at && Date.now() - liveUi.at > LIVE_TTL_MS) return null;
  return liveUi;
}

/** DSH 核验过的“真正可用的角色会话数”；未核验返回 null（界面不能拿本地映射冒充）。 */
function verifiedCount(project) {
  const live = liveFor(project);
  if (!live) return null;
  const ids = new Set(teamRoleIds(project));
  // R-97db（B-190a 打回，PM 2026-11-20 03:37）：**两条分支都必须按名册过滤**。
  // 旧实现 items 分支只数 live.items、兜底分支直接 return live.ready，都不看名册——
  // 而残留的 6 条 sid 仍在 workspace.sessionIds 里（实测 96 条），所以 Owner 截图里的
  // 「6/6 已核验」怎么都不会降。名册口径 = project.rosterSessionIds（后端按 members 里
  // sessionId 非空且未 archived 算出）；没有该字段（旧数据）时保持旧行为，避免误清。
  const rosterIds = Array.isArray(project && project.rosterSessionIds) ? project.rosterSessionIds : null;
  const rosterSet = rosterIds ? new Set(rosterIds) : null;
  const allowed = (role) => ids.has(role) && (!rosterSet || rosterSet.has(role));
  if (Array.isArray(live.items) && live.items.length) {
    return live.items.filter((item) => allowed(item.role) && item.sessionId && item.exists && item.inWorkspace && !item.blank && !item.archived).length;
  }
  if (typeof live.ready !== 'number' || isQuickTeam(project)) return null;
  if (!rosterSet) return live.ready;
  const scoped = [...rosterSet].filter((role) => ids.has(role)).length;
  return Math.min(scoped, live.ready);
}

function liveItemFor(project, roleId) {
  const live = liveFor(project);
  if (!live) return null;
  return (live.items || []).find((item) => item.role === roleId) || null;
}

/**
 * 六角色单行状态：本地映射只是线索，有 DSH 核验结果时以核验为准。
 * 返回 { cls, text, title }。
 */
function sessionState(project, role) {
  const roleId = typeof role === 'string' ? role : role.id;
  const sessionId = project && project.sessions ? project.sessions[roleId] : null;
  if (!sessionId) return { cls: 'missing', text: '待启动', title: '还没有 DSH 会话，点「建团队」创建后启动' };
  const live = liveItemFor(project, roleId);
  if (!live) {
    if (state && state.dsh && state.dsh.online) return { cls: 'unverified', text: '待核验', title: '本地有会话记录；DSH 核验还没返回' };
    return { cls: 'missing', text: 'DSH 未连接', title: 'DSH 离线，无法核验这个会话' };
  }
  if (!live.exists) return { cls: 'missing', text: 'DSH 中找不到', title: '本地记录了会话，但 DSH 里已不存在；点「建团队」补建' };
  if (live.archived) return { cls: 'missing', text: '已归档', title: 'DSH 里这个会话已归档；点「建团队」会补建一个新的角色会话' };
  if (!live.inWorkspace) return { cls: 'mismatch', text: '不在本工作区', title: '会话不在当前项目绑定的 DSH 工作区里' };
  if (live.blank) return { cls: 'blank', text: '待启动', title: '会话还没有首条对话（DSH 左侧可能不显示）；点「建团队」补发就位' };
  if (live.running) return { cls: 'running', text: '运行中', title: 'DSH 会话正在运行' };
  return { cls: 'ready', text: '已就绪', title: '会话已在 DSH 当前工作区里' };
}

function ackRemainMs(project) {
  if (!project || !project.pendingAck) return null;
  const at = Date.parse(project.pendingAckAt || 0);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, at + ACK_TTL_MS - Date.now());
}

/* ── 六会话真实状态：每一项都标来源，没有记录就不补造 ───── */

function dispatchKey(projectId, messageId) {
  return String(projectId || '') + '|' + String(messageId || '');
}

function roleWakeKey(projectId, roleId) {
  return String(projectId || '') + '|' + String(roleId || '');
}

/** 记一条本次界面真实拿到的唤醒结果；不落盘，刷新后“最后唤醒”会退回事件记录。 */
function rememberWake(projectId, roleId, wakeInfo, source) {
  if (!projectId || !roleId || !wakeInfo) return null;
  const entry = {
    at: new Date().toISOString(),
    ok: Boolean(wakeInfo.ok),
    source: source || 'prompt',
    why: String(wakeInfo.why || wakeInfo.code || '')
  };
  wakeRuns.set(roleWakeKey(projectId, roleId), entry);
  return entry;
}

function dshExistence(project, roleId) {
  if (!project) return { key: 'none', label: '无工作区', title: '先选择工作区' };
  const sessionId = (project.sessions || {})[roleId] || '';
  if (!sessionId) return { key: 'missing', label: '无映射', title: '本地没有这个角色的会话映射；先点「建团队」' };
  const live = liveItemFor(project, roleId);
  if (!live) {
    return state && state.dsh && state.dsh.online
      ? { key: 'unverified', label: '待核验', title: '本地有会话映射；dsh:team-status 还没返回核验结果' }
      : { key: 'offline', label: 'DSH 离线', title: 'DSH 未连接，无法确认会话是否还在；不把本地映射当作存在证明' };
  }
  if (!live.exists) return { key: 'missing', label: '不存在', title: '本地有映射，但 DSH 会话列表里已经找不到这个 sessionId' };
  if (live.archived) return { key: 'missing', label: '已归档', title: 'DSH 里这个会话已归档，不能作为当前团队会话' };
  if (!live.inWorkspace) return { key: 'mismatch', label: '不在工作区', title: '会话存在，但不属于当前项目绑定的 DSH 工作区' };
  if (live.blank) return { key: 'blank', label: '存在·空会话', title: '会话存在，但还没有首条对话；DSH 左侧可能不显示' };
  return { key: 'ok', label: '存在', title: 'dsh:team-status 已核验：会话存在且属于当前工作区' };
}

/** 最后唤醒：通信链 comm.wake（持久化）优先；手动 dsh:prompt 事件次之；本次界面返回只作补充。 */
function lastRoleWake(project, roleId) {
  if (!project || !roleId) return { key: 'none', short: '未记录', title: '没有可核验的唤醒记录' };
  const candidates = [];
  for (const message of project.messages || []) {
    if (String(message.to) !== String(roleId)) continue;
    const comm = message.comm && typeof message.comm === 'object' ? message.comm : null;
    const wake = comm && comm.wake;
    if (!wake || !wake.at || !['sent', 'failed', 'skipped'].includes(String(wake.state))) continue;
    candidates.push({
      at: wake.at,
      ok: wake.state === 'sent',
      source: 'dispatch-comm',
      state: String(wake.state),
      why: String(wake.error || wake.reason || wake.code || ''),
      sessionId: String(wake.sessionId || ''),
      messageId: String(message.id || '')
    });
  }
  const events = Array.isArray(project.events) ? project.events : [];
  for (let i = events.length - 1; i >= 0; i -= 1) {
    const text = String((events[i] && events[i].text) || '');
    if (!text.startsWith('唤醒 ' + roleId + '：')) continue;
    candidates.push({ at: events[i].at || null, ok: true, source: 'prompt-event', text });
    break;
  }
  const memory = wakeRuns.get(roleWakeKey(project.id, roleId)) || null;
  if (memory) candidates.push({ ...memory, source: memory.source === 'dispatch' ? 'dispatch-memory' : 'prompt-memory' });
  if (!candidates.length) {
    // 没有唤醒证据时，至少标出最近一次“可能尝试唤醒”的派单时间；明确写结果未记录，不补成功。
    const messages = (project.messages || [])
      .filter((m) => String(m.to) === String(roleId) && (m.recipientSessionId || m.source === 'team') && m.createdAt)
      .slice()
      .sort((a, b) => (Date.parse(b.createdAt || 0) || 0) - (Date.parse(a.createdAt || 0) || 0));
    if (messages.length) {
      const last = messages[0];
      return {
        key: 'unknown',
        short: (fmtTime(last.createdAt) || '时间未记录') + ' · 派单（结果未记录）',
        title: `最近一条发给该角色的派单在 ${fmtTime(last.createdAt) || '时间未记录'}；旧消息没有 comm.wake，这里不补造唤醒成功/失败`
      };
    }
    return {
      key: 'none',
      short: '未记录',
      title: '没有 comm.wake、dsh:prompt 事件或本次界面返回；不补造唤醒成功'
    };
  }
  candidates.sort((a, b) => (Date.parse(b.at || 0) || 0) - (Date.parse(a.at || 0) || 0));
  const latest = candidates[0];
  const sourceText = latest.source === 'dispatch-comm'
    ? '派单唤醒（通信链）'
    : (latest.source === 'dispatch-memory' ? '派单唤醒（本次界面）' : '手动唤醒');
  const stateText = latest.ok
    ? (latest.state === 'sent' || latest.source !== 'dispatch-comm' ? '成功' : '')
    : '失败';
  return {
    key: latest.ok ? 'ok' : 'bad',
    short: (fmtTime(latest.at) || '时间未记录') + ' · ' + sourceText,
    title: `${sourceText} · ${stateText}${latest.at ? ' · ' + latest.at : ''}${latest.sessionId ? ' · 会话 ' + latest.sessionId : ''}${latest.messageId ? ' · 消息 ' + latest.messageId : ''}${latest.why ? ' · ' + latest.why : ''}${latest.text ? ' · ' + latest.text : ''}${latest.source.endsWith('-memory') ? '（刷新即清空）' : ''}`
  };
}

function roleLastReceipt(project, roleId) {
  if (!project || !roleId) return { key: 'none', short: '未记录', title: '没有回执记录' };
  const roleName = roleById(roleId).name;
  const rows = [];
  for (const message of project.messages || []) {
    if (String(message.to) !== String(roleId)) continue;
    const commAck = message.comm && typeof message.comm === 'object' ? message.comm.ack : null;
    if (message.ack) {
      rows.push({
        at: (commAck && commAck.at) || message.ackAt || null,
        key: message.ackSource === 'team' || message.ackSource === 'team-external' ? 'ok' : 'warn',
        actor: String((commAck && commAck.actor) || message.actor || ''),
        by: String((commAck && commAck.by) || ''),
        selfExecuted: Boolean(message.comm && message.comm.selfExecuted && message.comm.selfExecuted.ack),
        source: String(message.ackSource || ''),
        note: String(message.ackNote || ''),
        manual: false,
        perspective: 'actor'
      });
    } else if (message.manualAck) {
      rows.push({
        at: (commAck && commAck.at) || message.manualAckAt || null,
        key: 'manual',
        actor: String((commAck && commAck.actor) || message.actor || 'workbench-shell/manual'),
        by: 'human',
        selfExecuted: false,
        source: 'manual',
        note: String(message.manualAckNote || ''),
        manual: true,
        perspective: 'actor'
      });
    }
  }
  // 也把“这个角色发出的消息收到的回执”算进去，否则 PM 派单收到的回执不会出现在 PM 的最近回执里。
  for (const message of project.messages || []) {
    if (String(message.from) !== String(roleId)) continue;
    const commAck = message.comm && typeof message.comm === 'object' ? message.comm.ack : null;
    if (!message.ack && !message.manualAck) continue;
    rows.push({
      at: (commAck && commAck.at) || message.ackAt || message.manualAckAt || null,
      key: message.ack ? (message.ackSource === 'team' || message.ackSource === 'team-external' ? 'ok' : 'warn') : 'manual',
      actor: String((commAck && commAck.actor) || message.actor || ''),
      by: String((commAck && commAck.by) || ''),
      selfExecuted: Boolean(message.comm && message.comm.selfExecuted && message.comm.selfExecuted.ack),
      source: String(message.ackSource || (message.manualAck ? 'manual' : '')),
      note: String(message.ackNote || message.manualAckNote || ''),
      manual: Boolean(message.manualAck && !message.ack),
      perspective: 'recipient'
    });
  }
  if (receiptsUi.data && receiptsUi.projectId === project.id) {
    for (const row of receiptLedgerRows(receiptsUi.data, project)) {
      const from = String(row.from || '');
      const to = String(row.to || '');
      const fromMatches = from === String(roleId) || from === roleName;
      const toMatches = to === String(roleId) || to === roleName;
      if (!fromMatches && !toMatches) continue;
      const actor = String(row.actor || '');
      const manual = actor === 'workbench-shell/manual' || row.source === 'manual' || row.identitySource === 'manual-confirm';
      rows.push({
        at: row.ts || row.createdAt || null,
        key: manual ? 'manual' : (actor === 'workbench-shell' ? 'shell' : (actor ? 'ok' : 'unknown')),
        actor,
        by: '',
        selfExecuted: Boolean(actor && actor !== 'workbench-shell' && actor !== 'workbench-shell/manual'),
        source: String(row.source || ''),
        note: String(row.log || row.note || ''),
        manual,
        perspective: fromMatches ? 'actor' : 'recipient'
      });
    }
  }
  if (!rows.length) {
    return { key: 'none', short: '无', title: '本机 messages 和已读取的 回执.jsonl 里都没有这个角色的回执记录' };
  }
  rows.sort((a, b) => (Date.parse(b.at || 0) || 0) - (Date.parse(a.at || 0) || 0));
  const latest = rows[0];
  const actorText = latest.actor || 'actor 未记录';
  const actorLabel = latest.selfExecuted || latest.by === 'role'
    ? '角色自己'
    : (latest.actor === 'workbench-shell' || latest.by === 'workbench-shell' ? '壳执行' : '执行者未记录');
  const label = latest.perspective === 'recipient'
    ? (latest.manual ? '收到人工确认（非角色回执）' : '收到回执·' + actorLabel)
    : (latest.manual ? '人工确认（不是角色回执）' : (latest.actor === 'workbench-shell' || latest.selfExecuted ? actorLabel + '回执' : '执行者未记录'));
  return {
    key: latest.key,
    short: (fmtTime(latest.at) || '时间未记录') + ' · ' + label,
    title: `${label}${latest.manual ? '（只写本机，未释放旧协议锁）' : ''} · actor=${actorText}${latest.by ? ' · by=' + latest.by : ''}${latest.source ? ' · 来源 ' + latest.source : ''}${latest.note ? ' · ' + latest.note : ''}`
  };
}

function roleInboxStat(project, roleId) {
  const loaded = Boolean(inboxUi.data && inboxUi.dataRole === roleId && Array.isArray(inboxUi.data.messages));
  if (loaded) {
    const n = inboxUnreadFor(project, roleId);
    return {
      n,
      source: 'team',
      label: '旧协议 new',
      title: `team:inbox 旧协议邮箱未读 ${n} 条（box=new）；这是邮箱水位，不是本机浏览标记`
    };
  }
  // 未展开调试收件箱时，用通信链 comm：delivered=delivered 且 read=pending 才算未读；不拿本机浏览标记冒充。
  const commMessages = (project && Array.isArray(project.messages) ? project.messages : [])
    .filter((m) => String(m.to) === String(roleId) && m.comm && typeof m.comm === 'object');
  if (commMessages.length) {
    const n = commMessages.filter((m) => m.comm.delivered && m.comm.delivered.state === 'delivered'
      && (!m.comm.read || m.comm.read.state !== 'read')).length;
    return {
      n,
      source: 'comm',
      label: '通信链未读',
      title: `通信链本地镜像：${n} 条 delivered=delivered 且 read≠read；不是旧协议邮箱全量未读，展开调试收件箱才读邮箱`
    };
  }
  const n = inboxUnreadFor(project, roleId);
  return {
    n,
    source: 'local',
    label: '本机标记',
    title: `本机浏览标记 ${n} 条；没有通信链 comm，也没有读取旧协议邮箱，不能把它当成角色 read 状态`
  };
}

/** 六角色单卡的五项真实状态；渲染层只读，不写任何状态。 */
function roleStatusSummary(project, roleId) {
  const sessionId = project && project.sessions ? project.sessions[roleId] : null;
  return {
    mapping: {
      label: sessionId ? sessionShort(sessionId) : '无',
      title: sessionId ? String(sessionId) : '本地没有这个角色的会话映射'
    },
    dsh: dshExistence(project, roleId),
    inbox: roleInboxStat(project, roleId),
    receipt: roleLastReceipt(project, roleId),
    wake: lastRoleWake(project, roleId)
  };
}

/**
 * R-c651 F-c651-4：团队行/角色卡共用的「未读 / 未回执 / 停滞」三列 + 一键唤醒 + 全部已读。
 * 数字只来自主进程 team:presence（团队工具 presence 命令）；没载入就写“—”，不补 0 冒充。
 * 旧协议 box=new 另起一列「旧箱」作参考，不并进未读（AC3 判据只看 deliveredAt/readAt）。
 */
function presenceMarkup(roleId, opts = {}) {
  const role = String(roleId || '');
  const row = presenceRow(role);
  const compact = Boolean(opts.compact);
  const loaded = Boolean(row);
  const unread = loaded ? Number(row.unread || 0) : null;
  const ackPending = loaded ? Number(row.ackPending || 0) : null;
  const stalledMin = loaded && row.stalledMin !== null && row.stalledMin !== undefined ? Number(row.stalledMin) : null;
  const legacy = loaded ? Number(row.legacyUnread || 0) : null;
  const wakeFailed = Boolean(loaded && row.wakeFailed);
  const stalledCls = stalledMin === null ? '' : (stalledMin > presenceUi.stalledBadMin ? ' bad' : (stalledMin > presenceUi.stalledWarnMin ? ' warn' : ''));
  const stalledText = stalledMin === null ? '停滞 —' : `停滞 ${stalledMin} 分`;
  const stalledTitle = stalledMin === null
    ? '这个角色还没有可核验的阅读 / 回执 / 唤醒记录，不补造停滞时间'
    : `最后一次活动（阅读 / 回执 / 唤醒）在 ${row.lastActivityAt || '时间未记录'}；>${presenceUi.stalledWarnMin} 分钟黄、>${presenceUi.stalledBadMin} 分钟红`;
  const unreadTitle = loaded
    ? `未读 ${unread} 条＝投递成功（deliveredAt 有值）且没有 readAt；旧协议 box=new 另计「旧箱 ${legacy}」，不并入这个数`
    : '在场数据还没载入（或项目没有团队会话）：这里不显示 0 冒充';
  const ackTitle = loaded
    ? `未回执 ${ackPending} 条＝要回执（--ack）且已读但回执.jsonl 没有该消息的回执记录`
    : '在场数据还没载入';
  const failedTitle = wakeFailed
    ? `唤醒失败（红点）：${row.wakeFailedReason || '原因未记录'}${row.wakeFailedMessageId ? ' · 消息 ' + row.wakeFailedMessageId : ''}${row.wakeFailedAt ? ' · ' + row.wakeFailedAt : ''}`
    : '';
  const busy = presenceUi.busy[role] || '';
  const markDisabled = !loaded || !unread ? 'disabled' : '';
  return `<div class="role-presence${compact ? ' compact' : ''}${wakeFailed ? ' wake-failed' : ''}" data-role="${esc(role)}" data-unread="${loaded ? unread : ''}" data-ack-pending="${loaded ? ackPending : ''}" data-stalled-min="${stalledMin === null ? '' : stalledMin}" data-wake-failed="${wakeFailed ? '1' : '0'}"${wakeFailed ? ` data-wake-failed-message="${esc(row.wakeFailedMessageId || '')}"` : ''}>
      <span class="presence-chip unread${unread ? ' on' : ''}" title="${esc(unreadTitle)}">未读 <b>${unread === null ? '—' : unread}</b></span>
      <span class="presence-chip ack${ackPending ? ' on' : ''}" title="${esc(ackTitle)}">未回执 <b>${ackPending === null ? '—' : ackPending}</b></span>
      <span class="presence-chip stalled${stalledCls}" title="${esc(stalledTitle)}">${esc(stalledText)}</span>
      <span class="presence-chip legacy" title="旧协议 box=new 未读，只作参考分列，不进未读/未回执判据">旧箱 <b>${legacy === null ? '—' : legacy}</b></span>
      ${wakeFailed ? `<span class="presence-failed-dot" title="${esc(failedTitle)}">● 唤醒失败</span>` : ''}
      <span class="presence-actions">
        <button class="ghost small" type="button" data-action="wake-role" data-role="${esc(role)}" ${busy === 'wake' ? 'disabled' : ''} title="立刻给这个角色发一次唤醒；失败会自动排 5/15/30 秒重试，3 次仍失败给 PM 发 wake_failed 并在这里标红点">${busy === 'wake' ? '唤醒中…' : '一键唤醒'}</button>
        <button class="ghost small" type="button" data-action="mark-read" data-role="${esc(role)}" ${markDisabled} ${busy === 'read' ? 'disabled' : ''} title="把这个角色新口径下的未读全部标为已读（写 readAt + 阅读.jsonl kind=read）；旧箱旧消息不动">${busy === 'read' ? '处理中…' : '全部已读'}</button>
      </span>
    </div>`;
}

/** 拉一次在场数据（主进程 → 团队工具 presence）。5 秒内不重复拉，force 强制。 */
async function loadPresence(opts = {}) {
  const p = activeProject();
  if (!p || !presenceCaps()) {
    presenceUi.rows = {};
    presenceUi.projectId = p ? p.id : null;
    presenceUi.error = presenceCaps() ? null : '当前壳层没有 team:presence 接口';
    return presenceUi;
  }
  const fresh = presenceUi.projectId === p.id && (Date.now() - presenceUi.at) < 5000;
  if (!opts.force && (fresh || presenceUi.loading)) return presenceUi;
  presenceUi.loading = true;
  presenceUi.error = null;
  try {
    const result = await window.workbench.teamPresence({ projectId: p.id, project: p.teamName || p.name });
    const rows = Array.isArray(result && result.rows) ? result.rows : [];
    const map = {};
    for (const row of rows) if (row && row.role) map[String(row.role)] = row;
    presenceUi.rows = map;
    presenceUi.stalledWarnMin = Number((result && result.stalledWarnMin) || 15);
    presenceUi.stalledBadMin = Number((result && result.stalledBadMin) || 30);
    presenceUi.projectId = p.id;
    presenceUi.projectName = String((result && result.project) || p.teamName || p.name || '');
    presenceUi.at = Date.now();
    if (result && result.ok === false) presenceUi.error = humanError(String(result.message || result.code || '在场数据读取失败'));
  } catch (error) {
    presenceUi.error = humanError(String((error && error.message) || error));
  } finally {
    presenceUi.loading = false;
  }
  return presenceUi;
}

/** 一键唤醒：只发一次唤醒（后端失败会自行排重试并最终告警），界面把结果原样说出来。 */
async function wakeRoleFromRow(roleId, button) {
  const p = activeProject();
  const role = String(roleId || '');
  if (!p || !role) return;
  const roleInfo = roleById(role);
  if (!(p.sessions || {})[role]) { toast(`「${roleInfo.name}」还没有 DSH 会话，先点「建团队」再唤醒`, 'bad'); return; }
  if (!window.workbench || typeof window.workbench.teamWakeRole !== 'function') { toast('当前壳层没有一键唤醒接口', 'bad'); return; }
  if (presenceUi.busy[role]) return;
  presenceUi.busy[role] = 'wake';
  if (button) { button.disabled = true; button.textContent = '唤醒中…'; }
  try {
    const result = await window.workbench.teamWakeRole({ projectId: p.id, role, reason: 'ui-one-click' });
    const skipped = (result && result.wake && result.wake.skipped) || '';
    if (result && result.ok) {
      toast(`已唤醒「${roleInfo.name}」${skipped === 'MERGED_PENDING' ? '（30 秒唤醒窗口内，已合并，稍后补发一次，不丢）' : ''}`, 'ok');
    } else {
      const why = (result && result.wake && (result.wake.why || result.wake.code)) || (result && (result.message || result.code)) || '未知原因';
      toast(`唤醒「${roleInfo.name}」失败：${why}。已自动排 5/15/30 秒重试；3 次仍失败会给 PM 发 wake_failed，并在本行标红点`, 'bad');
    }
    await loadPresence({ force: true });
    renderTeamSessions();
    renderRoles();
  } catch (error) {
    toast('唤醒失败：' + humanError(String((error && error.message) || error)), 'bad');
  } finally {
    delete presenceUi.busy[role];
    if (button && button.isConnected) { button.disabled = false; button.textContent = '一键唤醒'; }
  }
}

/** 全部已读：清新口径未读（写 readAt + 阅读.jsonl），旧箱旧消息不动。 */
async function markRoleReadFromRow(roleId, button) {
  const p = activeProject();
  const role = String(roleId || '');
  if (!p || !role) return;
  const roleInfo = roleById(role);
  if (!window.workbench || typeof window.workbench.teamMarkRead !== 'function') { toast('当前壳层没有全部已读接口', 'bad'); return; }
  if (presenceUi.busy[role]) return;
  presenceUi.busy[role] = 'read';
  if (button) { button.disabled = true; button.textContent = '处理中…'; }
  try {
    const result = await window.workbench.teamMarkRead({ projectId: p.id, role, actor: 'owner' });
    if (result && result.ok) {
      toast(result.count
        ? `已把「${roleInfo.name}」的 ${result.count} 条未读标为已读（阅读.jsonl 已记 kind=read）`
        : `「${roleInfo.name}」没有新口径下的未读（旧箱旧消息不参与，不冒充已读）`, 'ok');
    } else {
      toast('批量已读失败：' + humanError(String((result && (result.message || result.code)) || '未知原因')), 'bad');
    }
    await loadPresence({ force: true });
    renderTeamSessions();
    renderRoles();
  } catch (error) {
    toast('批量已读失败：' + humanError(String((error && error.message) || error)), 'bad');
  } finally {
    delete presenceUi.busy[role];
    if (button && button.isConnected) { button.disabled = false; button.textContent = '全部已读'; }
  }
}

function fmtRemain(ms) {  const total = Math.max(0, Math.round(Number(ms) / 1000));
  const mm = String(Math.floor(total / 60)).padStart(2, '0');
  const ss = String(total % 60).padStart(2, '0');
  return mm + ':' + ss;
}

function sourceLabel(value) {
  return SOURCE_LABEL[String(value || '')] || '';
}

function sessionShort(sessionId) {
  const text = String(sessionId || '').replace(/^session-/, '');
  return text ? text.slice(0, 10) : '';
}

function currentWorkspaceSession(project) {
  if (!project) return null;
  const sessions = project.sessions || {};
  return sessions.pm || Object.values(sessions).find(Boolean) || null;
}

function roleSessionTitle(project, roleId) {
  // 与主进程 roleTitle()/launch.mjs 一致：DSH 会话标题是「团队·角色」。
  const meta = project && project.sessionMeta ? project.sessionMeta[roleId] : null;
  if (meta && meta.title) return String(meta.title);
  const mapped = project && project.mapping && Array.isArray(project.mapping.sessions)
    ? project.mapping.sessions.find((item) => item.role === roleId)
    : null;
  if (mapped && mapped.title) return String(mapped.title);
  return '团队·' + roleById(roleId).name;
}

function stageById(id) {
  return (state?.stages || []).find((s) => s.id === id) || { id, label: id || '未知' };
}

function ownerLabel(status) {
  return OWNER_STATUS[status] || status || '未选择';
}

/**
 * Owner 状态只做展示与手动入口：不再自动弹窗。
 * 待决定仅在「流程停在 Owner 且本轮还没有 approved/rejected/skipped」时成立。
 */
function ownerState(project) {
  const owner = (project && project.ownerReview) || {};
  const status = String(owner.status || 'optional');
  const pending = Boolean(project && project.stage === 'owner' && (status === 'optional' || status === 'pending'));
  let key = status;
  let label = ownerLabel(status);
  if (pending) {
    key = 'pending';
    label = '待决定';
  } else if (status === 'approved') {
    label = '已通过';
  } else if (status === 'rejected') {
    label = '已打回';
  } else if (status === 'skipped') {
    label = '已跳过';
  } else if (status === 'optional' || status === 'pending') {
    label = '未开始';
  }
  return {
    owner,
    status,
    key,
    label,
    pending,
    opinion: String(owner.opinion || ''),
    at: owner.at || null
  };
}

/**
 * 顶栏 Owner 只显示“需求级”闸门；没有需求时才退回项目级旧状态。
 * 项目级 ownerReview 只写顶层字段，不参与需求派单，不能在顶栏冒充需求结论。
 */
function legacyOwnerHeadline(project) {
  const req = legacyActiveRequirement();
  const view = legacyReqOwnerView(req);
  const projectState = ownerState(project);
  if (req) {
    const reqStatus = String(req.status || '');
    const decided = ['approved', 'skipped', 'rejected'].includes(view.status);
    const pending = reqStatus === 'approved' && !decided;
    let key = decided ? view.status : (pending ? 'pending' : 'optional');
    let label = decided ? view.label : (pending ? '待决定' : '未到');
    const title = `需求级 Owner：${req.id} · ${legacyReqStatus(req)} · ${label}`
      + (view.owner && view.owner.opinion ? ` · 意见：${view.owner.opinion}` : '')
      + (view.owner && view.owner.at ? ` · ${fmtTime(view.owner.at)}` : '')
      + ` ｜ 项目级旧 Owner：${projectState.label}（不参与需求派单）`;
    return {
      ...projectState,
      key,
      label,
      pending,
      requirement: req,
      requirementOwner: view.owner,
      requirementStatus: view.status,
      opinion: (view.owner && view.owner.opinion) || '',
      at: (view.owner && view.owner.at) || '',
      title
    };
  }
  return {
    ...projectState,
    requirement: null,
    title: `还没有需求级 Owner 闸门 · 项目级旧 Owner：${projectState.label}（不参与需求派单）`
  };
}

function ownerResultFor(project) {
  if (!project || !project.id) return null;
  return ownerResults.get(project.id) || null;
}

function ownerNotifiedText(notified) {
  if (!notified) return '';
  if (typeof notified === 'string') return notified;
  const id = notified.id || notified.messageId || '';
  const to = notified.to ? '→ ' + roleById(notified.to).name : '';
  const at = notified.ts || notified.createdAt || '';
  return [id, to, at ? fmtTime(at) : ''].filter(Boolean).join(' · ');
}

function ownerWarningText(warning) {
  if (!warning) return '';
  if (typeof warning === 'string') return warning;
  return [warning.code, warning.message].filter(Boolean).join(' · ');
}

function ownerResultMarkup(entry) {
  if (!entry) return '';
  const warnings = Array.isArray(entry.warnings) ? entry.warnings.filter(Boolean) : [];
  const workflowFile = entry.workflowFile ? String(entry.workflowFile) : '';
  const notified = ownerNotifiedText(entry.notified);
  const missing = [];
  if (!workflowFile) missing.push('workflowFile 未返回');
  if (!notified) missing.push('notified 未返回（PM 未收到系统消息）');
  const bad = warnings.length > 0 || missing.length > 0;
  const warningHtml = warnings.length
    ? `<ul class="owner-warning-list">${warnings.map((warning) => `<li>${esc(ownerWarningText(warning))}</li>`).join('')}</ul>`
    : '<span class="ok">无</span>';
  return `<div class="owner-result-card${bad ? ' is-bad' : ''}">
    <div class="owner-result-lead">
      <span class="badge ${entry.status === 'rejected' ? 'badge-rejected' : (entry.status === 'approved' ? 'badge-approved' : 'muted-badge')}">Owner ${esc(ownerLabel(entry.status))}</span>
      <b>${bad ? '决定已保存，但有告警' : '决定已保存'}</b>
      ${entry.at ? `<time>${esc(fmtTime(entry.at))}</time>` : ''}
    </div>
    <div class="owner-result-row"><span>workflowFile</span>${workflowFile
      ? `<code title="${esc(workflowFile)}">${esc(workflowFile)}</code>`
      : '<b class="bad">未返回</b>'}</div>
    <div class="owner-result-row"><span>actor</span>${entry.actor
      ? `<b class="ok"><code>${esc(entry.actor)}</code>（本机点击）</b>`
      : '<b class="bad">未记录（没有在本机 Owner（我）点击过）</b>'}</div>
    <div class="owner-result-row"><span>notified</span>${notified
      ? `<b class="ok">${esc(notified)}</b>`
      : '<b class="bad">未返回（PM 未收到系统消息）</b>'}</div>
    <div class="owner-result-row"><span>warnings</span><div class="owner-result-warnings">${warningHtml}</div></div>
  </div>`;
}

function rememberOwnerResult(projectId, result, status, actor = '') {
  if (!projectId || !result) return null;
  const entry = {
    status: String((result.ownerReview && result.ownerReview.status) || status || ''),
    workflowFile: result.workflowFile || null,
    notified: result.notified || null,
    warnings: Array.isArray(result.warnings) ? result.warnings : [],
    roundKey: result.roundKey || '',
    // actor 只能来自本机 Owner（我）点击提交，不拿 result 里的 by 冒充执行者。
    actor: String(actor || result.actor || ''),
    at: (result.ownerReview && result.ownerReview.at) || new Date().toISOString()
  };
  ownerResults.set(projectId, entry);
  return entry;
}

function renderOwnerResult(project) {
  const box = $('#owner-result');
  if (!box) return;
  const entry = ownerResultFor(project);
  box.hidden = !entry;
  box.innerHTML = entry ? ownerResultMarkup(entry) : '';
}

function fmtTime(iso) {
  if (!iso) return '';
  const t = new Date(iso);
  if (Number.isNaN(t.getTime())) return '';
  return t.toLocaleString('zh-CN', { month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
}

function fmtSize(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MB';
  if (n >= 1024) return Math.max(1, Math.round(n / 1024)) + ' KB';
  return n + ' B';
}

function emptyView({ mark = '◇', title = '', text = '', action = '' } = {}) {
  return `<div class="view-empty">
    <span class="view-empty-mark" aria-hidden="true">${esc(mark)}</span>
    <h3>${esc(title)}</h3>
    ${text ? `<p>${text}</p>` : ''}
    ${action ? `<div class="view-empty-actions">${action}</div>` : ''}
  </div>`;
}

function makeButton(kind, label, title = '') {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = kind === 'primary' ? 'primary' : 'ghost';
  b.textContent = label;
  if (title) b.title = title;
  return b;
}

function setButtonsBusy(buttons, busy) {
  for (const b of buttons) {
    if (!b) continue;
    if (busy) {
      if (!b.dataset.label) b.dataset.label = b.textContent;
      b.disabled = true;
      if (b.classList.contains('primary')) b.textContent = '处理中…';
    } else {
      b.disabled = false;
      if (b.dataset.label) b.textContent = b.dataset.label;
    }
  }
}

/* ── 弹窗：焦点、遮罩、错误、忙碌 ─────────────────────── */

function closeModal() {
  const ctx = modalCtx;
  const root = $('#modal-root');
  if (root) root.innerHTML = '';
  if (!ctx) return;
  modalCtx = null;
  document.removeEventListener('keydown', ctx.keyHandler, true);
  try {
    if (ctx.lastFocus && ctx.lastFocus.isConnected) ctx.lastFocus.focus();
  } catch { /* ignore */ }
  if (typeof ctx.onClose === 'function') {
    try { ctx.onClose(); } catch { /* ignore */ }
  }
}

function openModal({ title, subtitle = '', icon = '', body, actions = [], width = 520, closable = true, onClose = null }) {
  closeModal();
  const root = $('#modal-root');
  const lastFocus = document.activeElement;
  root.innerHTML = `
    <div class="modal-mask">
      <section class="modal" role="dialog" aria-modal="true" aria-label="${esc(title)}" style="width:min(${Number(width) || 520}px, calc(100vw - 40px))">
        <header class="modal-head">
          ${icon ? `<span class="modal-icon" aria-hidden="true">${esc(icon)}</span>` : ''}
          <div class="modal-head-text">
            <h3>${esc(title)}</h3>
            ${subtitle ? `<p>${esc(subtitle)}</p>` : ''}
          </div>
          ${closable ? '<button class="modal-close" type="button" data-close="1" aria-label="关闭">×</button>' : ''}
        </header>
        <div class="modal-body"></div>
        <footer class="modal-foot"></footer>
      </section>
    </div>`;
  const mask = root.querySelector('.modal-mask');
  const section = root.querySelector('.modal');
  const bodyEl = root.querySelector('.modal-body');
  const foot = root.querySelector('.modal-foot');

  if (typeof body === 'string') bodyEl.innerHTML = body;
  else if (body instanceof Node) bodyEl.appendChild(body);

  const setError = (text) => {
    const clean = humanError(text);
    const box = bodyEl.querySelector('.modal-error');
    if (box) box.textContent = clean;
    else if (clean) toast(clean, 'bad');
  };

  const setBusy = (busy, label) => {
    for (const b of foot.querySelectorAll('button')) {
      if (busy) {
        if (!b.dataset.wasDisabled) b.dataset.wasDisabled = b.disabled ? '1' : '0';
        b.disabled = true;
      } else {
        b.disabled = b.dataset.wasDisabled === '1';
        delete b.dataset.wasDisabled;
      }
    }
    const primary = foot.querySelector('.primary');
    if (primary) {
      if (busy) {
        if (!primary.dataset.label) primary.dataset.label = primary.textContent;
        primary.textContent = label || '处理中…';
      } else if (primary.dataset.label) {
        primary.textContent = primary.dataset.label;
        delete primary.dataset.label;
      }
    }
  };

  const dlg = { close: closeModal, body: bodyEl, foot, error: setError, busy: setBusy, el: section };

  for (const action of actions) {
    const b = document.createElement('button');
    b.type = 'button';
    b.className = action.kind === 'primary' ? 'primary' : 'ghost';
    b.textContent = action.label;
    b.disabled = Boolean(action.disabled);
    if (action.title) b.title = action.title;
    b.addEventListener('click', async () => {
      if (b.disabled || b.dataset.busy === '1') return;
      b.dataset.busy = '1';
      let closed = false;
      const api = {
        close: () => { closed = true; closeModal(); },
        body: bodyEl,
        foot,
        error: setError
      };
      try {
        const ret = action.onClick?.(api);
        if (ret && typeof ret.then === 'function') {
          setBusy(true);
          try { await ret; } finally { if (!closed) setBusy(false); }
        }
      } catch (e) {
        setError(e && e.message ? e.message : String(e));
      } finally {
        delete b.dataset.busy;
      }
    });
    foot.appendChild(b);
  }

  const focusables = () => Array.from(section.querySelectorAll(
    'button:not([disabled]), [href], input:not([disabled]), select:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'
  )).filter((el) => el.offsetParent !== null);

  const keyHandler = (e) => {
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      if (closable) closeModal();
      return;
    }
    if (e.key === 'Tab') {
      const list = focusables();
      if (!list.length) { e.preventDefault(); return; }
      const first = list[0];
      const last = list[list.length - 1];
      if (e.shiftKey && (document.activeElement === first || !section.contains(document.activeElement))) {
        e.preventDefault();
        last.focus();
      } else if (!e.shiftKey && (document.activeElement === last || !section.contains(document.activeElement))) {
        e.preventDefault();
        first.focus();
      }
    }
  };
  document.addEventListener('keydown', keyHandler, true);

  if (closable) {
    root.querySelector('[data-close]')?.addEventListener('click', closeModal);
    mask.addEventListener('click', (e) => { if (e.target === mask) closeModal(); });
  }

  modalCtx = { root, lastFocus, keyHandler, onClose };
  applyTeamModeCopy(root);

  setTimeout(() => {
    if (!section.isConnected) return;
    const first = bodyEl.querySelector('input:not([type="hidden"]):not([disabled]), textarea:not([disabled]), select:not([disabled])');
    const bodyBtn = bodyEl.querySelector('button:not([disabled])');
    const target = first || bodyBtn || foot.querySelector('.primary') || foot.querySelector('button') || section.querySelector('.modal-close');
    try { target?.focus(); } catch { /* ignore */ }
  }, 40);

  return dlg;
}

/* ── 状态读取 ─────────────────────────────────────────── */

function warnStore() {
  if (!state?.storeError || storeWarned) return;
  storeWarned = true;
  toast(state.storeError.fatal
    ? '状态库损坏且没有可用备份，写入已阻止；请先处理 corrupt 文件'
    : '状态库曾损坏，已从备份恢复；请检查最近项目', 'bad');
}

/**
 * preload 整桥缺失时，不能只弹一次 toast 后继续显示“正常空状态”。
 * 这里给持久红色横幅，并禁用会调用 IPC 的入口；按钮不伪装可用。
 */
function renderBridgeAlert() {
  const box = $('#bridge-alert');
  const missing = !window.workbench;
  if (box) {
    box.hidden = !missing;
    if (missing) {
      box.innerHTML = '<b>preload 未加载（IPC 桥不可用）</b><span>项目、团队、六角色目录、boot 与 workflow 动作全部不可用；请先修复 preload 或重新安装。DSH 状态也无法读取，这不是 DSH 离线。</span>';
    } else {
      box.innerHTML = '';
    }
  }
  document.body.classList.toggle('bridge-down', missing);
  if (!missing) return;
  for (const id of ['btn-workspace', 'btn-team-start', 'btn-restore', 'btn-refresh', 'btn-folder-top',
    'btn-empty-new', 'btn-side-new', 'btn-side-restore', 'btn-dsh-config', 'btn-dsh-config-2', 'btn-wc-build',
    'btn-wc-team', 'btn-wc-folder', 'btn-provision', 'btn-project-index', 'btn-open', 'btn-files-refresh',
    'dsh-retry', 'dsh-config-2']) {
    const button = document.getElementById(id);
    if (!button) continue;
    button.disabled = true;
    button.title = 'preload 未加载（IPC 桥不可用）：该入口暂不可用';
  }
  document.querySelectorAll('[data-open-new-project], [data-open-restore], [data-ws-refresh], [data-ws-recover]').forEach((button) => {
    if (!(button instanceof HTMLButtonElement)) return;
    button.disabled = true;
    button.title = 'preload 未加载（IPC 桥不可用）：该入口暂不可用';
  });
  const dshBtn = $('#btn-dsh');
  if (dshBtn) dshBtn.textContent = 'IPC 未加载';
  const detail = $('#dsh-detail');
  if (detail) detail.textContent = 'preload 未加载，无法读取 DSH 状态（不是 DSH 离线）';
  const view = $('#dsh-view');
  if (view && view.getAttribute('src') !== 'about:blank') view.setAttribute('src', 'about:blank');
}

// B-20261119-015113-2443（97db）：团队台/侧栏四态唯一来源＝后端 team:members 的 state 字段；
// 渲染层只做 state→文案映射（AC3：不在渲染层自算 ok/stale）。
let memberStatesCache = null;
async function loadMemberStates(project) {
  if (!project || !window.workbench || typeof window.workbench.teamMembers !== 'function') return null;
  // B-8056（AC②）：读失败**不等于**「无在册成员」——失败时保留上一次成功的行，并把失败码带回渲染层；
  // 空名册只有在后端明确 membersEmpty 且没有被过滤标记时才认。
  const prev = memberStatesCache && memberStatesCache.projectId === project.id ? memberStatesCache : null;
  let res = null;
  try {
    res = await window.workbench.teamMembers({ projectId: project.id });
  } catch (e) {
    return {
      projectId: project.id, at: Date.now(), rows: prev ? prev.rows : null,
      empty: false, rosterFailed: true, rosterErrorCode: 'TEAM_MEMBERS_IPC_FAILED',
      rosterErrorMessage: String((e && e.message) || e), staleAt: prev ? prev.at : 0,
    };
  }
  if (!res || res.ok === false) {
    return {
      projectId: project.id, at: Date.now(), rows: prev ? prev.rows : null,
      empty: false, rosterFailed: true,
      rosterErrorCode: String((res && (res.code || res.errorCode)) || 'TEAM_MEMBERS_FAILED'),
      rosterErrorMessage: String((res && (res.message || res.error)) || ''),
      staleAt: prev ? prev.at : 0,
    };
  }
  const rows = Array.isArray(res.roles) ? res.roles : [];
  return {
    projectId: project.id, at: Date.now(), rows,
    empty: Boolean(res.membersEmpty) && rows.length === 0 && !res.filteredOut,
    filteredOut: Boolean(res.filteredOut),
    filteredReason: String(res.filteredReason || ''),
    memberCount: Number(res.memberCount) || rows.length,
    projectMissing: Boolean(res.projectMissing),
    diagnostics: res.diagnostics || null,
    staleAt: 0,
  };
}
function memberStateOfCache(project, roleId) {
  if (!memberStatesCache || !project || memberStatesCache.projectId !== project.id) return null;
  const row = memberStatesCache.rows.find((item) => String(item.role || '') === String(roleId));
  return row ? String(row.state || '') : null;
}
function memberStateView(stateStr, fallback) {
  const st = String(stateStr || '');
  if (st === 'stale') return { cls: 'stale', text: '已失效（成员已归档）', title: '该角色已归档/成员表已清空，不再显示为就绪', boot: false };
  if (st === 'pending') return { cls: 'pending', text: '待激活', title: '名册有会话，项目映射未对齐（待激活/重新绑定）', boot: true };
  if (st === 'missing') return { cls: 'missing', text: '未就绪（缺会话）', title: '项目映射里有会话，但名册无该成员会话', boot: true };
  if (st === 'ok') return { ...fallback, boot: true };
  return { ...fallback, boot: true };
}

// B-4fdd：启动分段标记（每次启动只报一次；失败静默，不影响业务）。
const startupMarkState = { interactive: false, state: false, screen: false };
function startupMarkBridge(kind) {
  if (startupMarkState[kind]) return;
  startupMarkState[kind] = true;
  const phase = kind === 'interactive' ? 'rendererInteractive' : (kind === 'state' ? 'stateLoaded' : 'firstScreen');
  try {
    if (window.workbench && typeof window.workbench.startupMark === 'function') {
      void window.workbench.startupMark({ phase, at: Date.now() });
    }
  } catch { /* 打点失败不影响启动 */ }
}

// a129（P0 首屏代码分割）：首屏之后才加载评审/池/流程/团队台/用量等 10 个脚本（约 350KB），
// 首屏只解析 boot-prefetch + flow/gate/app 等最小集。加载顺序 = index.html 中 data-lazy-src 出现顺序。
let lazyRendererLoading = null;
function loadLazyRendererScripts() {
  if (lazyRendererLoading) return lazyRendererLoading;
  lazyRendererLoading = (async () => {
    const nodes = Array.from(document.querySelectorAll('script[data-lazy-src]'));
    const loaded = [];
    for (const node of nodes) {
      const src = String(node.getAttribute('data-lazy-src') || '');
      if (!src) continue;
      await new Promise((resolve) => {
        const el = document.createElement('script');
        el.src = src;
        el.async = false;
        el.onload = () => { loaded.push(src); resolve(); };
        el.onerror = () => { loaded.push(src + '?error'); resolve(); };
        (document.body || document.head).appendChild(el);
      });
    }
    // 这些脚本内部已处理「DOMContentLoaded 已过就直接 init」；不要补派 DCL，避免 app.js 的监听重复执行。
    window.__awbLazyScripts = loaded;
    window.__awbLazyLoaded = true;
    try { console.log('[startup] lazy ' + loaded.length + ' scripts loaded'); } catch { /* ignore */ }
    return loaded;
  })();
  return lazyRendererLoading;
}
window.__awbEnsureLazy = loadLazyRendererScripts;

function scheduleLazyRendererScripts() {
  const run = () => { void loadLazyRendererScripts().catch(() => {}); };
  try {
    if (typeof requestIdleCallback === 'function') requestIdleCallback(run, { timeout: 1200 });
    else setTimeout(run, 120);
  } catch { setTimeout(run, 120); }
}

// a514：后台镜像完成后的 refresh 去抖——连续动作会连续触发镜像事件，若每次都整页重渲染，
// 打字（尤其是刚点完评审/验收后）会被周期性重渲染拖慢。交互期（gate.interacting）内直接跳过。
let workflowSideEffectsRefreshTimer = null;
function scheduleWorkflowSideEffectsRefresh() {
  if (workflowSideEffectsRefreshTimer) return;
  workflowSideEffectsRefreshTimer = setTimeout(() => {
    workflowSideEffectsRefreshTimer = null;
    let interacting = false;
    try { interacting = Boolean(window.AWBGate && typeof AWBGate.interacting === 'function' && AWBGate.interacting()); } catch { interacting = false; }
    if (interacting) { scheduleWorkflowSideEffectsRefresh(); return; }
    try { void refresh(); } catch { /* ignore */ }
  }, 1200);
  try { if (workflowSideEffectsRefreshTimer.unref) workflowSideEffectsRefreshTimer.unref(); } catch { /* ignore */ }
}

// a514：后台副作用失败必须可见可重试（不允许乐观成功后无声失败）。
function bindWorkflowSideEffects() {
  const api = window.workbench || {};
  if (typeof api.onWorkflowSideEffects !== 'function') return;
  let banner = null;
  let text = null;
  let retry = null;
  const ensure = () => {
    if (banner) return banner;
    banner = document.createElement('div');
    banner.id = 'awb-side-effect-banner';
    banner.hidden = true;
    banner.style.cssText = 'position:fixed;right:16px;bottom:48px;max-width:440px;z-index:9999;background:#3a1b1b;color:#ffd7d7;border:1px solid #b34242;border-radius:8px;padding:10px 12px;font-size:12px;display:flex;gap:8px;align-items:center;';
    text = document.createElement('span');
    retry = document.createElement('button');
    retry.type = 'button';
    retry.textContent = '重试';
    retry.style.cssText = 'flex:0 0 auto;padding:2px 10px;border-radius:6px;border:1px solid #b34242;background:#5a2323;color:#ffd7d7;cursor:pointer;';
    banner.appendChild(text);
    banner.appendChild(retry);
    document.body.appendChild(banner);
    return banner;
  };
  api.onWorkflowSideEffects((p) => {
    const payload = p || {};
    if (retry) retry.disabled = false;
    if (payload.ok) { if (banner) banner.hidden = true; scheduleWorkflowSideEffectsRefresh(); return; }
    ensure();
    text.textContent = '后台同步失败：' + String(payload.message || '未知原因') + '；本次状态可能尚未反映到本地，可重试。';
    banner.hidden = false;
    retry.onclick = () => {
      if (retry.disabled) return; // a514：重试在途时禁止二次触发（写操作幂等，但不重复排队）
      retry.disabled = true;
      banner.hidden = true;
      try {
        const projectId = (state && (state.activeProjectId || (state.activeProject && state.activeProject.id))) || '';
        void api.workflowSideEffectsRetry({ projectId });
      } catch { /* ignore */ }
    };
  });
}

// a514（PM 040227）：真实窗口打字延迟探针——keydown → 下一帧可见的 p95 + longtask 计数。
// 用法（之后由 CDP 在真窗口调用）：await window.__awbTypingProbe(3000)；返回 {latency, longtask, gateSkipped, verdict}。
window.__awbTypingProbe = function typingProbe(durationMs) {
  const windowMs = Math.max(500, Number(durationMs) || 3000);
  return new Promise((resolve) => {
    const latencies = [];
    const longTasks = [];
    const longTaskDetails = [];
    const started = performance.now();
    let stopped = false;
    const gateStatsBefore = (() => { try { return window.AWBGate && AWBGate.stats ? JSON.parse(JSON.stringify(AWBGate.stats)) : null; } catch { return null; } })();
    const onKey = () => {
      if (stopped) return;
      const t0 = performance.now();
      requestAnimationFrame(() => { if (!stopped) latencies.push(Math.round((performance.now() - t0) * 10) / 10); });
    };
    document.addEventListener('keydown', onKey, true);
    let observer = null;
    try {
      if (typeof PerformanceObserver === 'function') {
        observer = new PerformanceObserver((list) => {
          for (const entry of list.getEntries()) {
            longTasks.push(entry.duration);
            try {
              longTaskDetails.push({
                duration: Math.round(entry.duration * 10) / 10,
                startTime: Math.round((entry.startTime - started) * 10) / 10,
                name: String(entry.name || ''),
                attribution: (Array.isArray(entry.attribution) ? entry.attribution : []).map((a) => ({ name: String(a.name || ''), containerType: String(a.containerType || ''), containerId: String(a.containerId || ''), containerName: String(a.containerName || '') }))
              });
            } catch { /* ignore */ }
          }
        });
        observer.observe({ entryTypes: ['longtask'] });
      }
    } catch { /* 浏览器不支持 longtask 时只报延迟 */ }
    const finish = () => {
      stopped = true;
      try { document.removeEventListener('keydown', onKey, true); } catch { /* ignore */ }
      try { if (observer) observer.disconnect(); } catch { /* ignore */ }
      const gateStatsAfter = (() => { try { return window.AWBGate && AWBGate.stats ? JSON.parse(JSON.stringify(AWBGate.stats)) : null; } catch { return null; } })();
      const gateSkipped = (gateStatsBefore && gateStatsAfter && Number.isFinite(gateStatsBefore.skippedInteraction))
        ? Math.max(0, Number(gateStatsAfter.skippedInteraction) - Number(gateStatsBefore.skippedInteraction)) : null;
      let summary = null;
      try { summary = window.AWBInputLatency ? window.AWBInputLatency.typingVerdict({ latencies, longTasks, gateSkipped }) : null; } catch { summary = null; }
      resolve({
        durationMs: Math.round(performance.now() - started),
        latencies, longTasks, longTaskDetails, gateSkipped,
        summary,
        verdict: summary ? summary.ok : (latencies.length > 0 && Math.max(...latencies) <= 50 && longTasks.every((d) => d <= 100)),
      });
    };
    setTimeout(finish, windowMs);
  });
};

async function refresh() {
  // B-231006-b81a 回归基线诊断：刷新是否真的执行（Owner 报「刷新按钮也失效」）。
  // 只读计数，不参与业务；夹具点击 #btn-refresh 后断言它递增。
  try { window.__refreshCount = Number(window.__refreshCount || 0) + 1; } catch { /* ignore */ }
  if (!window.workbench) {
    renderBridgeAlert();
    toast('preload 没有加载，工作台 API 不可用', 'bad');
    return;
  }
  renderBridgeAlert();
  try {
    // a129：boot-prefetch.js 在 app.js 解析前就发出了 app:state；这里复用同一个 Promise（省一次往返等待）。
    const statePromise = window.__awbStatePromise || window.workbench.state();
    window.__awbStatePromise = null;
    state = await statePromise;
    startupMarkBridge('state');
    stateReadError = null;
    // B-4fdd：首屏不等 team:members（那是第二个 IPC，冷启动白等 100-500ms）；先用缓存/空值渲染，
    // 成员状态到了再补一次重绘（会话行本来就有「本地/已核验」两种态，不会显示错）。
    hydrateTeamModes();
    const __renderStart = performance.now();
    render();
    try { console.log('[startup] render ' + (performance.now() - __renderStart).toFixed(1) + 'ms'); } catch { /* ignore */ }
    // 首屏可用 = 首拉 render 完成并完成一帧（与 dsh:status 的 startup.marks.firstScreenMs 同源）。
    try { requestAnimationFrame(() => requestAnimationFrame(() => startupMarkBridge('screen'))); } catch { /* ignore */ }
    // 首屏已提交渲染：下一拍再加载重脚本（评审/池/流程/团队台/用量），不抢首屏 CPU。
    try { scheduleLazyRendererScripts(); } catch { /* 懒加载失败不影响首屏 */ }
    const current = activeProject();
    if (current) loadLegacyDocs(legacyUi.projectId === current.id);
    const memberProbe = loadMemberStates(current).then((rows) => {
      memberStatesCache = rows;
      try { renderSessions(); renderSidebar(); } catch { /* 补齐失败不影响首屏 */ }
    }).catch(() => { memberStatesCache = null; });
    void memberProbe;
  } catch (e) {
    // B-230447-3d23：读失败不能再只弹 toast 把页面留在「未选择」占位——记错误码并重绘卡片（保留上次值）。
    stateReadError = { code: 'APP_STATE_READ_FAILED', message: String((e && e.message) || e) };
    try { renderSidebar(); } catch { /* 卡片重绘失败不阻断提示 */ }
    toast('读取失败：' + e.message, 'bad');
  }
}

async function applyState(next) {
  if (next && next.state) state = next.state;
  else await refresh();
  hydrateTeamModes();
  render();
  warnStore();
  // R-c72a AC2（批3）：切换项目后需求池必须跟着换数据——池子开着就立即重取并强制重建。
  // 原实现只在「打开池子」时取一次，切项目后 #pool-req-list 仍显示上一个项目的行（实测 50 行、首行仍是 A 项目）。
  // 强制重建（清 signature）：两个项目的行签名可能相同，只靠 signature 差异判断会漏刷；池子关着不重取，打开时 togglePool 本来就会刷新。
  if (poolUi.open) {
    poolUi.signature = '';
    void refreshPool();
  }
}

/* ── 浮层抽屉：项目面板 / 团队台 ─────────────────────── */

function setDrawer(name, opts = {}) {
  const project = $('#project-drawer');
  const team = $('#team-drawer');
  // R-6bc8（T-20261117-152156-85c9）：会话排队是第三个独立抽屉（Owner 打回：不许塞在团队台里）。
  const sessionQueue = $('#session-queue-drawer');
  const mask = $('#drawer-mask');
  if (!project || !team) return;
  const next = name === 'project' || name === 'team' || name === 'session-queue' ? name : null;
  const changed = openDrawerName !== next;
  openDrawerName = next;
  project.hidden = next !== 'project';
  team.hidden = next !== 'team';
  if (sessionQueue) sessionQueue.hidden = next !== 'session-queue';
  const queueBtn = $('#btn-session-queue');
  if (queueBtn) queueBtn.setAttribute('aria-pressed', next === 'session-queue' ? 'true' : 'false');
  if (mask) mask.hidden = !next;
  document.body.classList.toggle('drawer-open', Boolean(next));
  if (next === 'session-queue') {
    if (changed && !opts.keepScroll) $('#session-queue-drawer .drawer-scroll')?.scrollTo({ top: 0 });
    // 面板自己带 8 秒刷新；打开时立刻取一次，打开即有数（不依赖等下一拍）。
    if (typeof window.__sqRefresh === 'function') { void window.__sqRefresh(); }
  }
  if (next === 'project') {
    if (changed && !opts.keepScroll) $('#project-drawer .drawer-scroll')?.scrollTo({ top: 0 });
    loadDshTeamStatus();
    loadLegacyDocs();
  }
  if (next === 'team') {
    if (changed) r5Skeleton('#team-drawer', '团队台加载中…', 8);
    renderTeam();
    loadDshTeamStatus();
    loadTeamStatus();
    loadWorkspaces();
    loadReceipts();
    loadLegacyDocs();
    loadGateAudit();
  }
}

function closeDrawers() {
  setDrawer(null);
}

/* ── 页签切换（项目面板内部） ─────────────────────────── */

function showTab(name, opts = {}) {
  const changed = activeTab !== name;
  activeTab = name;
  $$('#tabs .tab').forEach((b) => {
    const on = b.dataset.tab === name;
    b.classList.toggle('active', on);
    b.setAttribute('aria-selected', String(on));
  });
  $$('.view').forEach((v) => v.classList.toggle('active', v.id === 'view-' + name));
  if (changed && !opts.fromRender && opts.open !== false) setDrawer('project', { keepScroll: true });
  if (name === 'files') loadFiles();
  if (name === 'docs' || name === 'roles' || name === 'flow') loadLegacyDocs();
  if (name === 'flow') { loadGateCheck(); loadGateAudit(); }
  if (name === 'roles') loadDshTeamStatus();
}

/* ── 总渲染 ───────────────────────────────────────────── */

/** 静态 HTML 里的角色清单/标题按 teamMode 更新；其余旧称呼由 applyTeamModeCopy 收口。 */
function renderModeCopyAnchors() {
  const p = activeProject();
  const terms = modeTerms(p);
  const roles = teamRoles(p).map((role) => role.name);
  const hint = $('#empty-role-hint');
  if (hint) hint.textContent = `${terms.teamDir}：${roles.join(' / ')}`;
  const start = $('#btn-team-start');
  if (start) {
    start.title = p
      ? `为当前工作区启动 ${terms.team} DSH 会话（${roles.join(' / ')}）`
      : `启动当前团队模式的 DSH 会话（${roles.join(' / ')}）`;
  }
  const sidebar = $('#sidebar');
  if (sidebar) sidebar.setAttribute('aria-label', `工作区与${terms.team}会话`);
}

function render() {
  if (!state) return;
  hydrateTeamModes();
  // 换项目时丢掉上一个项目的 DSH 核验结果与旧文档缓存，避免“新项目也显示 6/6 / 上一个项目的 boot 证据”。
  const current = activeProject();
  const switchedProjects = current ? legacyUi.projectId !== current.id : legacyUi.projectId !== null;
  if (switchedProjects) resetLegacyUiFor(current ? current.id : null);
  if (liveUi.projectId && liveUi.projectId !== (current && current.id)) {
    liveUi.projectId = null;
    liveUi.at = 0;
    liveUi.items = [];
    liveUi.extras = [];
    liveUi.duplicates = [];
    liveUi.workspace = null;
    liveUi.error = null;
    liveUi.ready = null;
    liveUi.canRepair = false;
    liveUi.missingRoles = [];
    liveUi.blankRoles = [];
    liveUi.notInWorkspace = [];
  }
  const versionEl = $('#version');
  if (versionEl) {
    // 顶栏口径（Owner 2026-11-14 定）：只显示主.次 = v1.0；完整版本留在 data-full-version 与 tooltip，
    // 菜单里那行仍显示完整 1.0.0 · <commit 短号>。
    versionEl.textContent = 'v' + shortAppVersion(state.version);
    versionEl.dataset.fullVersion = String(state.version || '');
    versionEl.title = `应用版本 v${state.version || '—'}（顶栏按主.次显示）`;
  }
  // 2a69 发版：菜单里那行版本号（state.version + state.commit 短号；没有 commit 就只显示版本）。
  const versionLine = $('#more-version-line');
  if (versionLine) {
    const commit = String(state.commit || '').trim();
    versionLine.textContent = `版本 ${state.version || '—'}${commit ? ' · ' + commit : ''}`;
    versionLine.dataset.version = String(state.version || '');
    versionLine.dataset.commit = commit;
    versionLine.title = commit ? `当前版本 ${state.version}（commit ${commit}）` : `当前版本 ${state.version}`;
  }
  // B-4fdd：render 总耗时实测 ~700ms（冷启动首屏最大项）。拆两段：
  //   首屏必需（侧栏/顶栏/会话/DSH 状态）同步画完；下方折叠面板/旧流程/看板入口下一拍补绘。
  const __t = (name, fn) => {
    const t0 = performance.now();
    try { return fn(); } catch (e) { return null; } finally {
      const dt = performance.now() - t0;
      if (dt > 40) { try { console.log('[startup] render.' + name + ' ' + dt.toFixed(0) + 'ms'); } catch { /* ignore */ } }
    }
  };
  __t('sidebar', renderSidebar);
  __t('sessions', renderSessions);
  __t('header', renderHeader);
  __t('dsh', () => renderDsh(state.dsh));
  __t('storeFlag', renderStoreFlag);
  __t('theme', syncThemeUi);
  const __deferred = () => {
    __t('truthStrip', renderTruthStrip);
    __t('overview', renderOverview);
    __t('flow', renderFlow);
    __t('roles', renderRoles);
    __t('team', renderTeam);
    __t('workspacePopover', renderWorkspacePopover);
    __t('boardPanel', renderBoardPanel);
    __t('launchers', renderLaunchers);
    if (current) {
      if (switchedProjects) loadLegacyDocs();
      else __t('legacyPanels', renderLegacyPanels);
    }
    __t('tab', () => showTab(activeTab, { fromRender: true }));
    __t('modeCopy', () => { renderModeCopyAnchors(); applyTeamModeCopy(document.body); });
  };
  // 下一拍补绘；首屏在此之前已经可见（rAF 打点早于这里）。
  try { setTimeout(__deferred, 0); } catch { __deferred(); }
  // Owner 不自动弹窗：顶栏「Owner 待决定」与项目面板的 Owner 卡片就是继续入口。
}

/** 右下角两个浮层入口：有项目才可用；看板走真实 team:board-old。 */
function renderLaunchers() {
  const p = activeProject();
  const board = $('#board-launcher');
  if (board) {
    board.disabled = !p;
    board.title = p ? `打开「${p.name}」的团队看板浮窗：可刷新/折叠/切看板项目` : '先新建或选择一个工作区';
    board.setAttribute('aria-disabled', String(!p));
    board.setAttribute('aria-expanded', String(Boolean(boardUi.open)));
    board.classList.toggle('is-open', Boolean(boardUi.open));
  }
  const flow = $('#flow-launcher');
  if (flow) {
    flow.disabled = !p;
    flow.title = p ? '项目流程图（实时高亮当前阶段）' : '先新建或选择一个工作区';
  }
  const flowBoard = $('#flow-board-open');
  if (flowBoard) flowBoard.disabled = !p;
  const quick = $('#legacy-owner-quick-removed');
  if (quick) {
    const os = p ? legacyOwnerHeadline(p) : null;
    const need = Boolean(os && os.pending);
    const ownerGate = legacyActionCommandGate('owner-review');
    quick.hidden = !need;
    quick.disabled = need && !ownerGate.ok;
    quick.textContent = need ? `Owner 待决定${os.requirement ? ' · ' + os.requirement.id : ''} · 继续` : 'Owner 待决定';
    quick.title = need ? (ownerGate.ok ? '需求级 Owner 还没决定，点这里继续；不会自动弹窗' : ownerGate.reason) : '';
  }
}

function renderStoreFlag() {
  const flag = $('#store-flag');
  if (!flag) return;
  const err = state?.storeError;
  flag.hidden = !err;
  if (!err) return;
  flag.textContent = err.fatal ? '状态库只读' : '状态库已从备份恢复';
  flag.classList.toggle('fatal', Boolean(err.fatal));
  flag.title = err.message || '状态库异常，点击查看';
}

/* ── 左侧工作区：项目 = 工作区，六角色 = 六会话 ─────── */

function renderSidebar() {
  const list = $('#project-list');
  const count = $('#project-count');
  const stats = $('#sidebar-stats');
  const p = activeProject();
  const projects = state.projects || [];
  const verified = p ? verifiedCount(p) : null;
  const ready = p ? sessionReadyCount(p) : 0;
  const roleTotal = p ? teamRoleCount(p) : 6;
  if (count) count.textContent = String(projects.length);
  const missing = projects.filter((item) => item.exists === false);
  const cleanBtn = $('#btn-clean-missing');
  if (cleanBtn) {
    cleanBtn.hidden = !missing.length;
    cleanBtn.textContent = `清理失效项目（${missing.length}）`;
    cleanBtn.title = missing.length
      ? `有 ${missing.length} 个项目的目录已不存在：可一次只移除本机记录（不动磁盘）`
      : '没有失效项目';
  }
  if (stats) {
    stats.textContent = projects.length
      ? `${projects.length} 个工作区 · ${verified === null ? ready + '/' + roleTotal + ' 本地映射' : verified + '/' + roleTotal + ' 已核验'}`
      : '项目 = 工作区 · 会话 = 角色';
  }

  const name = $('#workspace-name');
  const pathEl = $('#workspace-path');
  const stageEl = $('#workspace-stage');
  const meta = $('#workspace-meta');
  const warnEl = $('#workspace-warn');
  const modeEl = $('#workspace-mode');
  const folderBtn = $('#btn-wc-folder');
  const teamBtn = $('#btn-wc-team');
  const buildBtn = $('#btn-wc-build');
  const WorkspaceCardApi = (typeof AWBWorkspaceCard !== 'undefined' && AWBWorkspaceCard) ? AWBWorkspaceCard : null;
  const card = WorkspaceCardApi ? WorkspaceCardApi.view({ state, project: p, lastGood: lastWorkspaceCard, stateError: stateReadError }) : null;
  if (name) name.textContent = card ? card.nameText : (p ? p.name : '未选择工作区');
  if (pathEl) {
    pathEl.textContent = p ? (p.exists === false ? `${p.path} · 目录不存在` : p.path) : '先新建或恢复一个项目';
    pathEl.title = p ? p.path : '';
    pathEl.classList.toggle('path-missing', Boolean(p && p.exists === false));
  }
  if (stageEl) stageEl.textContent = p ? stageById(p.stage).label : '—';
  if (modeEl) {
    modeEl.textContent = p ? teamModeLabel(p) : '完整 6 人';
    modeEl.className = 'badge' + (p && isQuickTeam(p) ? ' badge-skipped' : ' muted-badge');
    modeEl.title = p ? `当前团队模式：${teamModeLabel(p)}；点「建团队」可切换` : '还没有工作区';
  }
  if (meta) {
    const ws = (p && p.workspace) || {};
    const teamName = ws.name || (p && p.teamName) || '';
    const wsId = ws.id || (p && p.dshWorkspaceId) || '';
    const parts = [];
    if (p) {
      parts.push(teamName ? '团队 ' + teamName : '团队未登记');
      parts.push(wsId ? 'DSH ' + String(wsId).slice(0, 18) : (ws.pending ? 'DSH 工作区待重试' : 'DSH 工作区待绑定'));
      parts.push((verified === null ? ready : verified) + '/' + roleTotal + ' 会话' + (verified === null ? '（本地）' : '（DSH 已核验）'));
      parts.push(teamModeLabel(p));
    }
    meta.textContent = card && card.metaText ? card.metaText : (p ? parts.join(' · ') : '');
    if (card && !card.code && p) lastWorkspaceCard = { nameText: card.nameText, metaText: meta.textContent };
    meta.title = p && ws.boundAt ? `工作区绑定于 ${fmtTime(ws.boundAt)}` : '';
  }
  if (warnEl) {
    const ws = (p && p.workspace) || {};
    const live = p ? liveFor(p) : null;
    const notes = [];
    let bad = false;
    // B-230447-3d23：卡片口径的读取错误必须可见（含错误码），不允许用「未选择」冒充「没有项目」。
    if (card && card.code) {
      notes.push(`工作区读取：${card.code}${card.stale ? '（已保留上次数据）' : ''}`);
      bad = true;
    }
    if (p && p.exists === false) { notes.push('项目目录不存在或被移动，DSH 工作区无法绑定。'); bad = true; }
    if (p && ws.lastError && ws.lastError.code) {
      notes.push(`DSH 工作区绑定失败：${ws.lastError.code}${ws.lastError.message ? ' · ' + ws.lastError.message : ''}（切项目或建团队会自动重试）`);
      bad = true;
    }
    // e29f F-4：额外会话（含同一角色多会话）只由侧栏统计那一处统一计数显示，
    // 这里不再重复报数字，避免同一时刻两处数字不同。
    if (live && live.error) { notes.push('DSH 核验失败：' + live.error); bad = true; }
    if (!p && !(card && card.code)) notes.length = 0;
    warnEl.hidden = !notes.length;
    warnEl.textContent = notes.join(' ');
    warnEl.classList.toggle('warn-soft', !bad);
  }
  if (folderBtn) folderBtn.disabled = !p;
  if (teamBtn) teamBtn.disabled = false;
  if (buildBtn) {
    const total = teamRoleCount(p);
    buildBtn.disabled = !p;
    const done = verified === null ? ready : verified;
    buildBtn.textContent = p && done >= total ? '补会话' : (p && ready > 0 ? '补建会话' : '建团队');
    buildBtn.title = p
      ? (done >= total ? `${teamModeLabel(p)}的 ${total} 个角色会话都在；仍可点一次做空会话补发` : `为当前工作区补齐${teamModeLabel(p)}的 ${total} 个角色 DSH 会话`)
      : '先新建或选择工作区';
  }

  if (!list) return;
  if (!projects.length) {
    list.innerHTML = `
      <div class="side-empty">
        <span class="side-empty-mark" aria-hidden="true">◇</span>
        <b>还没有工作区</b>
        <p>一个目录 = 一个项目 = 一个 DSH 工作区。<br>新建后自动生成六角色目录与团队会话。</p>
        <button class="ghost small" type="button" data-open-new-project>＋ 新建工作区</button>
        <button class="link-btn" type="button" data-open-restore>恢复已有目录</button>
      </div>`;
    return;
  }
  list.innerHTML = projects.map((item) => {
    const tasks = Array.isArray(item.tasks) ? item.tasks : [];
    const done = tasks.filter((t) => t.status === 'done').length;
    const active = item.id === (state.activeProjectId || p?.id);
    const isCurrent = Boolean(p && item.id === p.id);
    const itemVerified = isCurrent ? verified : null;
    const itemReady = sessionReadyCount(item);
    const itemTotal = teamRoleCount(item);
    const ws = item.workspace || {};
    const sessionText = itemVerified === null ? `${itemReady}/${itemTotal} 会话` : `${itemVerified}/${itemTotal} 已核验`;
    return `<div class="project-item ${active ? 'active' : ''}${item.exists === false ? ' is-missing' : ''}" data-project="${esc(item.id)}" role="button" tabindex="0" title="${esc(item.path)}" aria-current="${active ? 'true' : 'false'}">
      ${item.exists === false ? `<button class="project-remove" type="button" data-project-remove="${esc(item.id)}" title="项目目录不存在：只移除本机记录">×</button>` : ''}
      <span class="p-top">
        <span class="p-name">${esc(item.name)}</span>
        ${active ? '<span class="p-current">当前</span>' : ''}
        ${item.exists === false ? '<span class="p-missing">目录不存在</span>' : ''}
        ${ws.pending ? '<span class="p-current">工作区待绑定</span>' : ''}
      </span>
      <span class="p-path">${esc(item.path)}</span>
      <span class="p-meta"><span class="p-stage">${esc(stageById(item.stage).label)}</span><span>${sessionText} · ${done}/${tasks.length} 任务</span></span>
    </div>`;
  }).join('');
}

function renderWorkspacePopover() {
  const list = $('#workspace-pop-list');
  const count = $('#workspace-pop-count');
  const dshBox = $('#workspace-pop-dsh');
  if (!list) return;
  const projects = state?.projects || [];
  const p = activeProject();
  const wsData = wsUi.data;
  const teamItems = wsData && Array.isArray(wsData.projects) ? wsData.projects : [];
  const localPaths = new Set(projects.map((item) => String(item.path || '').toLowerCase()));
  const teamOnly = teamItems.filter((item) => item.path && !localPaths.has(String(item.path).toLowerCase()));
  if (count) count.textContent = String(projects.length + teamOnly.length);

  if (dshBox) {
    if (!wsData) {
      dshBox.innerHTML = wsUi.error
        ? `团队/DSH 工作区清单读取失败：${esc(wsUi.error)}`
        : '读取团队 / DSH 工作区清单…（只读）';
    } else {
      const current = wsData.currentWorkspace || null;
      const currentName = String((current && (current.name || current.project)) || wsData.activeProject || '');
      const mine = p ? String(p.teamName || (p.workspace && p.workspace.name) || p.name) : '';
      const mismatch = Boolean(currentName && mine && currentName !== mine);
      dshBox.innerHTML = `DSH 当前工作区：<b>${esc(currentName || '未切换')}</b>`
        + (current && current.dshWorkspaceId ? ` <span class="mono">${esc(String(current.dshWorkspaceId).slice(0, 14))}</span>` : '')
        + (mismatch ? `<br><span class="bad">本机当前项目「${esc(mine)}」不等于 DSH 当前工作区；切换或定位后会同步。</span>` : '')
        + (wsData.ok === false ? `<br>清单降级：${esc(wsData.message || wsData.code || '团队工具不可用')}` : '');
    }
  }

  if (!projects.length && !teamOnly.length) {
    list.innerHTML = '<div class="empty-row">还没有工作区。新建或恢复一个项目后再切换。</div>';
    return;
  }
  const localHtml = projects.map((item) => {
    const active = item.id === (state.activeProjectId || p?.id);
    const itemVerified = active ? verifiedCount(item) : null;
    const ready = sessionReadyCount(item);
    const total = teamRoleCount(item);
    const ws = item.workspace || {};
    return `<button class="ws-item ${active ? 'active' : ''}" type="button" data-project="${esc(item.id)}" aria-current="${active ? 'true' : 'false'}">
      <span class="ws-item-top"><b>${esc(item.name)}</b>${active ? '<span class="p-current">当前</span>' : ''}${ws.pending ? '<span class="ws-item-tag">工作区待绑定</span>' : ''}<span class="ws-item-tag">${esc(teamModeLabel(item))}</span></span>
      <small>${esc(item.path)}</small>
      <span class="ws-item-meta"><span>${esc(stageById(item.stage).label)}</span><span>${itemVerified === null ? ready + '/' + total + ' 会话' : itemVerified + '/' + total + ' 已核验'}</span>${ws.id ? `<span class="ws-item-dsh">ws ${esc(String(ws.id).slice(0, 12))}</span>` : ''}</span>
    </button>`;
  }).join('');
  const teamHtml = teamOnly.map((item) => {
    const name = String(item.name || '');
    const sessions = item.sessions && item.sessions.count ? `${item.sessions.count} 会话` : '会话未记录';
    const desc = item.exists === false ? '目录不存在' : (item.registered ? '团队已登记' : (item.inStore ? '状态库项目' : '本地目录'));
    const title = item.exists === false
      ? `目录不存在：${item.path}`
      : `未登记到本机状态库；点「按名字恢复」会复用已有会话并登记（不新建同名目录）`;
    return `<button class="ws-item is-team" type="button" data-ws-restore="${esc(name)}" ${item.exists === false ? 'disabled' : ''} title="${esc(title)}">
      <span class="ws-item-top"><b>${esc(name)}</b><span class="ws-item-tag">未登记</span></span>
      <small>${esc(item.path || '—')}</small>
      <span class="ws-item-meta"><span>${esc(desc)}</span><span>${esc(sessions)}</span>${item.dshWorkspaceId ? `<span class="ws-item-dsh">ws ${esc(String(item.dshWorkspaceId).slice(0, 12))}</span>` : ''}</span>
    </button>`;
  }).join('');
  list.innerHTML = (projects.length ? `<div class="ws-group-label">本机工作区 <b>${projects.length}</b></div>` : '')
    + localHtml
    + (teamOnly.length ? `<div class="ws-group-label">团队 / DSH 清单里未登记 <b>${teamOnly.length}</b></div>` : '')
    + teamHtml
    + (!teamOnly.length && projects.length ? '<div class="ws-empty-note">团队 / DSH 清单里没有额外工作区。点「刷新清单」重读。</div>' : '');
}

async function loadWorkspaces(force = false) {
  if (!window.workbench || typeof window.workbench.teamWorkspaces !== 'function') return null;
  if (!force && wsUi.data && Date.now() - wsUi.at < 15000) return wsUi.data;
  if (wsUi.loading) return wsUi.data;
  wsUi.loading = true;
  try {
    const r = await window.workbench.teamWorkspaces({ probe: false });
    wsUi.data = r;
    wsUi.at = Date.now();
    wsUi.error = r && r.ok === false ? String(r.message || r.code || '读取失败') : null;
    return r;
  } catch (e) {
    wsUi.error = humanError(e.message);
    return null;
  } finally {
    wsUi.loading = false;
    renderWorkspacePopover();
    const current = activeProject();
    if (state && current) {
      renderOverview();
      renderTeamWorkspace();
      renderSidebar();
      if (boardUi.open) renderBoardPanel();
    }
  }
}

/* ── 六角色会话：侧栏 / 团队台共用 ───────────────────── */

// R-703f AC1：会话用量（只读展示，数据源 团队/状态/项目/<项目>/会话用量.json 经 session:usage）。
// 现状：文件缺失/超 24h → 「会话用量未知 / 阈值 30 万」；有数据 → 「会话用量 X / 阈值 30 万」+ 角色明细。
// B-7009（P1）：缓存键必须含角色（切角色立即刷新，≤2s）；展示对象可切换（默认用量最高）。
let usageUi = { projectId: '', role: '', at: 0, data: null };
const USAGE_ROLE_LABEL = { pm: '项目经理', product: '产品设计师', analyst: '需求分析师', programmer1: '高级程序员 A', programmer2: '高级程序员 B', tester: '测试人员' };
function usageNeedsRefresh(p, role) {
  if (!usageUi || usageUi.projectId !== String(p && p.id || '')) return true;
  if (String(usageUi.role || '') !== String(role || '')) return true;   // 切角色不等 TTL，立即刷新
  return (Date.now() - Number(usageUi.at || 0)) > 15000;
}
function usageCompareMarkup(view) {
  const rows = (view && Array.isArray(view.rows)) ? view.rows : [];
  if (!rows.length) return '';
  const cell = (n) => (Number.isFinite(Number(n)) ? Math.round(Number(n)).toLocaleString('en-US') : '未知');
  return '<span class="usage-compare" data-usage-compare="1">'
    + rows.map((row) => '<span class="usage-compare-row" data-usage-metric="' + esc(row.key) + '">'
      + '<i>' + esc(row.name) + '</i>'
      + '<b data-usage-ui="' + esc(row.ui) + '">' + cell(row.ui) + '</b>'
      + '<s data-usage-native="' + esc(row.native) + '">' + cell(row.native) + '</s>'
      + '<em data-usage-error="' + esc(row.errorPct) + '">' + (row.within5 ? '≤5%' : '>5%') + '</em>'
      + '<u title="' + esc(row.formula) + '">' + esc(row.formula) + '</u>'
      + '</span>').join('')
    + '</span>';
}
async function renderSessionUsage(p) {
  const host = document.getElementById('session-usage');
  const wrap = document.getElementById('session-usage-wrap');
  const showWrap = (on) => { if (wrap) wrap.hidden = !on; };
  if (!host) return;
  if (!p) { host.hidden = true; host.textContent = ''; showWrap(false); return; }
  const api = window.workbench;
  if (!api || typeof api.sessionUsage !== 'function') { host.hidden = true; showWrap(false); return; }
  const projectId = String(p.id || '');
  const role = String(usageUi.projectId === projectId ? (usageUi.role || '') : (usageUi.role || ''));
  let data = usageUi.data;
  if (usageNeedsRefresh(p, role)) {
    try {
      data = await api.sessionUsage({ projectId: p.id, role: role || undefined });
      usageUi = { projectId, role, at: Date.now(), data };
    } catch { data = null; }
  }
  if (!data || data.ok === false) { host.hidden = true; showWrap(false); return; }
  host.hidden = false;
  showWrap(true);
  host.setAttribute('data-session-usage', '1');
  host.setAttribute('data-usage-role', String((data.focus && data.focus.role) || ''));
  host.setAttribute('data-usage-cache-key', String((data.focus && data.focus.cacheKey) || (projectId + '::' + (role || '*'))));
  host.setAttribute('data-usage-tokens', data.topTokens === null ? '' : String(data.topTokens));
  host.setAttribute('data-usage-threshold', String(data.warnThreshold || 5000000));
  host.setAttribute('data-usage-level', String(data.level || 'unknown'));
  const label = String(data.shortLabel || data.label || ('会话用量未知 / 阈值 ' + Math.round((data.warnThreshold || 5000000) / 10000) + ' 万'));
  const fullLabel = String(data.label || label);
  const detailLines = Array.isArray(data.detailLines) ? data.detailLines : [];
  const chips = (data.roles || []).map((row) => '<button type="button" class="usage-chip' + (String((data.focus && data.focus.role) || '') === String(row.role) ? ' active' : '')
    + '" data-usage-role-pick="' + esc(row.role) + '" title="切到 ' + esc(USAGE_ROLE_LABEL[row.role] || row.role) + ' 看它的原生用量">' + esc(USAGE_ROLE_LABEL[row.role] || row.role) + '</button>').join('');
  const detailHtml = detailLines.length
    ? '<div class="usage-detail" data-usage-detail="1" hidden>' + detailLines.map((line) => '<span class="usage-detail-line">' + esc(line) + '</span>').join('') + '</div>'
    : '';
  // P0（Owner 0407）：默认只显示一行紧凑摘要 + 角色 chip；长文案进 tooltip，明细点「明细」才展开。
  host.innerHTML = '<span class="usage-label" data-usage-label="1" title="' + esc(fullLabel) + '">' + esc(label) + '</span>'
    + '<button type="button" class="link-btn usage-detail-toggle" data-usage-detail-toggle="1"' + (detailHtml ? '' : ' hidden') + '>明细</button>'
    + '<span class="usage-chips" data-usage-chips="1">' + chips + '</span>' + detailHtml;
  host.classList.toggle('warn', data.level === 'warn');
  host.classList.toggle('bad', data.level === 'force');
  host.title = '数据来自 团队/状态/项目/' + (data.project || '') + '/会话用量.json（原生 DSH tokenUsage：未缓存输入/缓存读/输出）；'
    + '切角色立即刷新，阈值取 session.mjs 单源';
}

function renderSessions() {
  const box = $('#role-sessions');
  const count = $('#session-count');
  const p = activeProject();
  if (!box) return;
  // B-8056：缓存三态（正常 / 被过滤 / 读取失败）+ 空态分档；顶部计数与列表**同源**（都以 memberStatesCache.rows 为准）。
  const cache = memberStatesCache && p && memberStatesCache.projectId === p.id ? memberStatesCache : null;
  const rosterRows = cache ? cache.rows : null;
  const rosterFailed = Boolean(cache && cache.rosterFailed && !(Array.isArray(rosterRows) && rosterRows.length));
  const rosterFiltered = Boolean(cache && cache.filteredOut);
  const rosterEmpty = Boolean(cache && !rosterFailed && !rosterFiltered && Array.isArray(rosterRows) && rosterRows.length === 0);
  // B-6bb5：真无成员必须同时满足「名册行 0」与「memberCount 0」；仅行被过滤空时不算。
  const trulyEmptyRoster = rosterEmpty && Number(cache && cache.memberCount || 0) === 0;
  const allEntries = sessionEntries(p);
  // B-6e85（P0）：角色行必须来自「在册名册」。旧实现按 sessionEntries（会话映射派生）过滤，
  // 映射为空时 entries=[] → 整个角色区被一句空态文案替换，Owner 看到 0/6 且角色行全消失。
  // 现在：名册有行就按名册逐角色出行，缺映射的行用 roleById 合成，保证 6 个在册角色始终可见。
  const roleById = new Map();
  for (const item of allEntries) if (item && item.role) roleById.set(String(item.role.id), item.role);
  // P0（Owner 0407 真窗口截图 + 测试 I1 未达标）：角色行的事实来源是**在册名册/本模式角色**，
  // 不是 DSH 会话映射。旧实现在 memberStatesCache 不可用（离线/读失败）时退回 allEntries（映射派生），
  // 映射只有 1/6 时就只画出 1 行、映射 0 时整块变空态 —— Owner 看到「6 个在册角色却一行都没有」。
  // 现在：有名册行 → 按名册；无名人册行 → 按本模式角色（teamRoles）兜底，仍然逐角色出行。
  // PM 05:10（M-20261121-051026-0b56c7）：行数只由 teamRoles(p) 定，rosterRows 只取 state；
  // rosterRows=1 也必须出 6 行，只有名册 0 人（allEntries 也为空）才空态。
  const rowOf = new Map((Array.isArray(rosterRows) ? rosterRows : []).map((row) => [String((row && row.role) || ''), row]));
  const roleSkeleton = teamRoles(p) || [];
  const entries = roleSkeleton.length
    ? roleSkeleton.map((role) => ({
      role,
      sessionId: (p && p.sessions && p.sessions[String(role.id || '')]) ? String(p.sessions[String(role.id || '')]) : '',
      stateRow: rowOf.get(String(role.id || '')) || null
    }))
    : allEntries;
  const ready = entries.filter((item) => item.sessionId).length;
  const rosterTotal = cache && Number(cache.memberCount) > 0 ? Number(cache.memberCount) : (Array.isArray(rosterRows) ? rosterRows.length : 0);
  const verifiedFromRows = Array.isArray(rosterRows) && rosterRows.length
    ? rosterRows.filter((row) => String(row.state || '') === 'ok').length
    : null;
  const verified = verifiedFromRows !== null ? verifiedFromRows : (p ? verifiedCount(p) : null);
  const total = rosterTotal || (p ? teamRoleCount(p) : entries.length || 6);
  if (count) {
    // e29f F-3：展示数字只认 DSH 核验（sessionId 全等 + 属于本工作区）；未核验/过期显示「待核验」。
    // B-8056：分母改成「名册行数/列表行来源」同一个数，不再用 teamRoleCount 另算（两处不同源）。
    count.textContent = rosterFailed ? '读取失败' : (verified === null ? '待核验' : `${verified}/${total}`);
    count.title = rosterFailed
      ? `名册读取失败（${(cache && (cache.rosterErrorCode || cache.rosterErrorMessage)) || 'UNKNOWN'}）：显示的是上一次成功读取的结果`
      : (verified === null
        ? `DSH 未核验：本地映射 ${ready}/${total} 只作参考`
        : `DSH 核验 ${verified}/${total}（本地映射 ${ready}/${total}）`);
    count.setAttribute('data-local', `${ready}/${total}`);
    count.setAttribute('data-verified', verified === null ? '0' : '1');
    count.setAttribute('data-roster-failed', rosterFailed ? '1' : '0');
    count.setAttribute('data-roster-filtered', rosterFiltered ? '1' : '0');
  }
  // B-6bb5：离线标记随状态清除，避免恢复后徽标仍挂着上一轮的 data-dsh-offline。
  if (count) count.removeAttribute('data-dsh-offline');
  // AC1：用量展示与团队会话同一块刷新（异步，不阻塞主渲染）
  try { renderSessionUsage(p).catch(() => { /* 用量展示失败不阻断会话渲染 */ }); } catch { /* ignore */ }
  if (!p) {
    box.innerHTML = '<div class="empty-row">先选择工作区；当前团队模式的角色会话会显示在这里。</div>';
    return;
  }
  // B-6bb5（P0）：DSH 离线是独立一档——本地名册可能完好（N 个在册角色），只是 DSH 连不上导致会话列表空。
  // 旧实现把「行被过滤成 0」一律写成「无在册成员」，属于断言性假话，且与徽标「完成 N 人」自相矛盾。
  const dsh = state && state.dsh ? state.dsh : null;
  const dshOffline = Boolean(dsh && dsh.configured && !dsh.online);
  const dshCode = String((dsh && dsh.code) || (dshOffline ? 'DSH_OFFLINE' : ''));
  const dshAddress = String((dsh && dsh.baseUrl) || '');
  // P0（Owner 0407 / 测试 I1）：角色行的渲染抽成函数，离线档也要用它把 6 行画出来，
  // 不许因为「DSH 连不上」就把整块换成一句状态文案。
  const buildRowsHtml = () => entries.map(({ role, sessionId }) => {
    const st = p ? memberStateView(memberStateOfCache(p, role.id), sessionState(p, role)) : { cls: 'missing', text: '未启动', title: '', boot: true };
    const live = p ? liveItemFor(p, role.id) : null;
    const titleMismatch = Boolean(live && live.currentTitle && live.currentTitle !== roleSessionTitle(p, role.id));
    const rowModel = (window.AWBSessionRows && typeof window.AWBSessionRows.rowModel === 'function')
      ? window.AWBSessionRows.rowModel({ role, sessionId })
      : { sub: sessionId ? sessionShort(sessionId) : 'DSH 会话未创建' };
    const sub = rowModel.sub + (titleMismatch ? ' · 标题不一致' : '');
    // AC2b：会话行要有可断言的选中态 data 属性（当前角色会话行标 aria-selected/data-selected=true，
    // 其余 false；会话 id 也落到 data-session-id 上，便于 tester 按 id 断言而不是看样式）。
    const isCurrent = Boolean(sessionId) && Boolean(p) && String((p.sessions && p.sessions[role.id]) || '') === String(sessionId);
    return `<div class="session-row ${sessionId ? '' : 'missing'}" role="button" tabindex="0" data-role-session="${esc(role.id)}"
      data-session-id="${esc(sessionId || '')}" data-selected="${isCurrent ? 'true' : 'false'}" aria-selected="${isCurrent ? 'true' : 'false'}"
      title="${esc(titleMismatch ? `DSH 标题是「${live.currentTitle}」，应为「${roleSessionTitle(p, role.id)}」` : (sessionId ? '打开 ' + role.name + ' 的 DSH 会话操作' : '先建团队'))}">
      <span class="session-dot" style="--role-color:${esc(role.color)}" aria-hidden="true"></span>
      <span class="session-main"><b data-role-name>${esc(role.name)}</b><small>${sub}</small></span>
      <span class="session-state ${st.cls}" title="${esc(st.title)}">${esc(st.text)}</span>
    </div>`;
  }).join('');
  if (rosterFailed) {
    const code = (cache && (cache.rosterErrorCode || cache.rosterErrorMessage)) || 'UNKNOWN';
    box.innerHTML = '<div class="empty-row bad" data-roster-failed="1">名册读取失败（' + esc(String(code)).slice(0, 80) + '）：保留上一次成功读取的会话列表；请稍后重试或检查团队账本</div>';
    return;
  }
  if (dshOffline) {
    // 离线档：N 个在册角色 + 当前离线（错误码）+ 地址 + 重试；绝不出现「无在册成员」。
    // N 取名册行数（rosterTotal），不用 teamRoleCount 兜底——真无成员时如实写 0，不能借项目角色数虚报。
    const offlineN = rosterTotal || entries.length || 0;
    // 先画角色行（按名册/本模式角色），再画离线横幅——两件同时出现，绝不用横幅替换角色区。
    box.innerHTML = buildRowsHtml() + '<div class="empty-row bad" data-dsh-offline="1">' + offlineN + ' 个在册角色；DSH 当前离线（' + esc(dshCode || 'DSH_OFFLINE') + '）· 当前会话映射 ' + ready + '/' + Math.max(offlineN, ready)
      + (dshAddress ? ' · 地址 ' + esc(dshAddress) : '') + '<button class="link-btn" type="button" data-dsh-retry="1">重试连接</button></div>';
    if (count) {
      count.textContent = ready + '/' + Math.max(offlineN, ready);
      count.setAttribute('data-local', ready + '/' + Math.max(offlineN, ready));
      count.setAttribute('data-verified', '0');
      count.setAttribute('data-dsh-offline', '1');
    }
    if (!entries.length) return;
    return;
  }
  if (rosterFiltered) {
    // B-6e85：名册有行就照名册出行；只有真没有任何在册行时才退回空态文案。
    if (!entries.length) {
      const reason = String((cache && cache.filteredReason) || '') === 'archived' ? '成员已归档' : '会话尚未映射';
      box.innerHTML = '<div class="empty-row" data-roster-filtered="1">' + total + ' 个在册角色；' + esc(reason) + '，当前显示 0/' + total
        + '<button class="link-btn" type="button" data-dsh-retry="1">重试连接</button><button class="link-btn" type="button" data-rebind-by-title="1">按标题重绑</button><button class="link-btn" type="button" data-open-new-project>＋ 建团队</button></div>';
      if (count) count.setAttribute('data-roster-filtered', '1');
      return;
    }
  }
  if (rosterEmpty && !trulyEmptyRoster && !entries.length) {
    // 名册还有 N 人、只是行被过滤空：按「会话未映射」处理，不写「无在册成员」。
    box.innerHTML = '<div class="empty-row" data-roster-unmapped="1">' + total + ' 个在册角色；会话尚未映射，当前显示 0/' + total
      + '<button class="link-btn" type="button" data-dsh-retry="1">重试连接</button><button class="link-btn" type="button" data-rebind-by-title="1">按标题重绑</button></div>';
    return;
  }
  if (rosterEmpty) {
    box.innerHTML = '<div class="empty-row" data-roster-empty="1">本工作区无在册成员（团队已归档/成员表已清空）' + '<button class="link-btn" type="button" data-open-new-project>＋ 建团队</button></div>';
    if (count) { count.textContent = '0'; count.setAttribute('data-verified', '0'); }
    return;
  }
  box.innerHTML = buildRowsHtml();
  // B-6e85：0/N 必须说清真实原因（DSH 在线但会话映射缺失/标题不匹配），并给「按标题重绑」入口。
  if (entries.length && (verified === 0 || ready < total)) {
    const mappedN = entries.filter((item) => item.sessionId).length;
    const reasonText = mappedN === 0
      ? `DSH 已连接，但在册 ${total} 个角色在本地会话映射里是 0 个（project.sessions 缺失或标题未匹配），所以显示 0/${total}`
      : `本工作区在册 ${total} 个角色，本地只映射 ${mappedN} 个；未映射的行显示「DSH 会话未创建」`;
    // B-6e85 AC③：逐一列出未匹配角色（名册 id 前 8 位 + DSH 侧标题/会话 id 前 8 位），供 Owner 判断是「名册过期」还是「标题变了」。
    const unmatchedHtml = entries.filter((item) => !item.sessionId).map((item) => {
      const rosterId = String((p.sessions && p.sessions[item.role.id]) || '');
      const live = liveItemFor(p, item.role.id);
      const dshId = String((live && live.sessionId) || '');
      const title = String((live && live.currentTitle) || roleSessionTitle(p, item.role.id));
      return `<span class="session-unmatched" data-unmatched-role="${esc(item.role.id)}">${esc(item.role.name)}：名册 ${rosterId ? esc(rosterId.slice(0, 8)) : '（空）'} · DSH「${esc(title)}」${dshId ? '（' + esc(dshId.slice(0, 8)) + '）' : ''}</span>`;
    }).join('');
    box.insertAdjacentHTML('beforeend', '<div class="session-reason" data-session-reason="1" data-session-reason-code="' + (mappedN === 0 ? 'MAPPING_EMPTY' : 'MAPPING_PARTIAL') + '">'
      + esc(reasonText) + (unmatchedHtml ? '<div class="session-unmatched-list" data-unmatched-list="1">' + unmatchedHtml + '</div>' : '')
      + '<button class="link-btn" type="button" data-rebind-by-title="1">按标题重绑</button></div>');
  }
  // T-5d98：行重绘后补一次绑定状态（推送早于渲染时不会丢）。
  try { if (typeof applyPmIdentityState === 'function') applyPmIdentityState(PM_IDENTITY_LAST || {}); } catch { /* ignore */ }
}

// B-6e85：0/N 时「按标题重绑」入口——只按 DSH 会话标题（团队·角色）匹配，一次写回 project.sessions。
async function rebindSessionsByTitle() {
  const p = activeProject();
  const api = window.workbench;
  if (!p || !api || typeof api.rebindSessions !== 'function') return;
  try {
    const r = await api.rebindSessions({ projectId: p.id });
    if (r && r.ok) {
      try { if (typeof showNotice === 'function') showNotice(`已按标题重绑 ${r.bound}/${r.total} 个角色会话`, 'ok'); } catch { /* ignore */ }
      await refresh();
    } else {
      try { if (typeof showNotice === 'function') showNotice('按标题重绑失败：' + String((r && (r.code || r.message)) || 'DSH_TITLE_NO_MATCH') + '（可在团队台核对会话标题）', 'bad'); } catch { /* ignore */ }
    }
  } catch (e) {
    try { if (typeof showNotice === 'function') showNotice('按标题重绑失败：' + String((e && e.message) || e), 'bad'); } catch { /* ignore */ }
  }
}

function roleSessionStatus(item) {
  const p = activeProject();
  if (!p || !item) return { cls: 'missing', text: '未启动', title: '' };
  return sessionState(p, item.role || item);
}

/**
 * T-5d98（R-fd42）：把主进程推送的 PM 身份绑定状态落到界面。
 * 锚点：行内 data-role-bound-session / data-role-binding-state；错误横幅 #binding-error-banner（不静默）。
 */
let PM_IDENTITY_LAST = null;
function applyPmIdentityState(state) {
  const st = state && typeof state === 'object' ? state : {};
  PM_IDENTITY_LAST = st;
  const mode = String(st.state || '');
  const short = String(st.sessionShort || '');
  const row = document.querySelector('.session-row[data-role-session="pm"]') || document.querySelector('[data-role-row][data-role="pm"]');
  if (row) {
    const bound = row.querySelector('[data-role-bound-session]');
    if (bound) {
      bound.hidden = false;
      const text = mode === 'unreadable' || mode === 'pending_write'
        ? '待写入'
        : (mode === 'pending_activation' ? '已绑定（会话待激活）' : (short ? `已绑定 ${short}` : '已绑定'));
      bound.textContent = text;
    }
    const stateEl = row.querySelector('[data-role-binding-state]');
    if (stateEl) {
      const normalized = mode === 'pending_activation' ? 'pending_activation'
        : (mode === 'ok' ? 'ok' : (mode === 'pending_write' ? 'pending_write' : 'mismatch'));
      stateEl.setAttribute('data-role-binding-state', normalized);
      stateEl.textContent = mode === 'ok' ? '' : (mode === 'pending_activation' ? '待激活' : '待写入');
    }
  }
  const banner = document.querySelector('#binding-error-banner');
  if (banner) {
    const err = String(st.error || '');
    if (err) {
      banner.hidden = false;
      banner.textContent = err;
      banner.setAttribute('data-code', String(st.code || ''));
    } else {
      banner.hidden = true;
      banner.textContent = '';
      banner.removeAttribute('data-code');
    }
  }
  // T-5d98 ②：对齐后**立刻**重算额外会话（workspace-clean 有 5 秒轮询，等它会残留「额外会话 1 个」）。
  if (mode === 'ok') {
    try {
      if (typeof window.__awbRefreshExtraSessions === 'function') window.__awbRefreshExtraSessions();
      else window.dispatchEvent(new CustomEvent('awb:refresh'));
    } catch { /* ignore */ }
    setTimeout(() => {
      try {
        const box = document.querySelector('#extra-sessions');
        const ids = box ? String(box.getAttribute('data-extra-ids') || '') : '';
        console.info('[pm-identity] extra-sessions ids=', ids || '(none)');
      } catch { /* ignore */ }
    }, 300);
  }
}

function renderTeamSessions() {  const box = $('#team-session-list');
  const count = $('#team-session-count');
  const note = $('#team-live-note');
  const p = activeProject();
  if (!box) return;
  if (!p) {
    if (count) count.textContent = '—';
    if (note) note.textContent = '会话状态以 DSH 核验为准；先选择工作区。';
    box.innerHTML = '<div class="empty-row">先新建或选择一个工作区，当前团队模式的角色会话会显示在这里。</div>';
    return;
  }
  const rosterRows = memberStatesCache && memberStatesCache.projectId === p.id ? memberStatesCache.rows : null;
  const rosterEmpty = Boolean(rosterRows && rosterRows.length === 0);
  const allEntries = sessionEntries(p);
  const entries = rosterRows ? allEntries.filter((item) => rosterRows.some((row) => String(row.role || '') === String(item.role.id))) : allEntries;
  const ready = entries.filter((item) => item.sessionId).length;
  const verified = verifiedCount(p);
  const total = teamRoleCount(p);
  const live = liveFor(p);
  const extras = live && Array.isArray(live.extras) ? live.extras.length : 0;
  const dupes = live && Array.isArray(live.duplicates) ? live.duplicates.length : 0;
  if (count) {
    // e29f F-3：6/6 (X/N) 只认 DSH 核验（sessionId 全等 + 属于本工作区）的条数；
    // 未核验/核验过期就显示「待核验」，不能拿本地映射冒充满员。
    count.textContent = rosterEmpty ? '0' : (verified === null ? '待核验' : `${verified}/${total}`);
    count.title = verified === null
      ? `DSH 未核验：本地映射 ${ready}/${total} 只作参考，不计入 ${total} 分母之外的满员判定`
      : `DSH 核验 ${verified}/${total}（本地映射 ${ready}/${total}）`;
    count.setAttribute('data-x', verified === null ? '' : String(verified));
    count.setAttribute('data-n', String(total));
    count.setAttribute('data-verified', verified === null ? '0' : '1');
    count.setAttribute('data-local', `${ready}/${total}`);
  }
  if (note) {
    const wsName = (p.workspace && p.workspace.name) || p.teamName || p.name;
    // e29f F-4：额外会话的提示只在侧栏统计一处显示（workspace-clean.js 统一渲染），
    // 这里不再重复"未映射会话/重复角色会话"数字，避免一处 0 一处 3。
    if (verified !== null) {
      note.textContent = `DSH 核验：${verified}/${total} 在「${wsName}」工作区（${teamModeLabel(p)}）`
        + (live && live.workspace && live.workspace.bound === false ? ' · 工作区未就绪' : '');
    } else if (state.dsh && state.dsh.online) {
      note.textContent = '本地映射已显示；正在向 DSH 核验会话是否存在。';
    } else {
      note.textContent = 'DSH 未连接：只显示本地映射，无法确认会话是否还在 DSH 里。';
    }
  }
  box.innerHTML = entries.map(({ role, sessionId }) => {
    const st = sessionState(p, role);
    const liveItem = liveItemFor(p, role.id);
    const expected = roleSessionTitle(p, role.id);
    const shownTitle = liveItem && liveItem.currentTitle ? liveItem.currentTitle : expected;
    const titleWarn = Boolean(liveItem && liveItem.currentTitle && liveItem.currentTitle !== expected);
    const facts = roleStatusSummary(p, role.id);
    return `<div class="team-session ${sessionId ? '' : 'missing'}">
      <div class="team-session-top">
        <span class="session-dot" style="--role-color:${esc(role.color)}" aria-hidden="true"></span>
        <span class="team-session-main"><b>${esc(role.name)}</b><code title="${esc(sessionId || '')}" data-session-id="${esc(sessionId || '')}">${sessionId ? esc(sessionShort(sessionId)) : '无会话'}</code><small class="team-session-title${titleWarn ? ' warn' : ''}" title="${esc('DSH 标题：' + shownTitle)}">${esc(shownTitle)}</small></span>
        <span class="session-state ${st.cls}" title="${esc(st.title)}">${esc(st.text)}</span>
        <span class="team-session-actions">
          <button type="button" data-role-session="${esc(role.id)}" title="会话操作">操作</button>
          <button type="button" data-role-locate="${esc(role.id)}" ${sessionId ? '' : 'disabled'} title="在 DSH 中定位这个会话">定位</button>
        </span>
      </div>
      <div class="team-session-facts">
        <span class="session-fact"><i>本地映射</i><b class="fact-${sessionId ? 'ok' : 'missing'}" title="${esc(facts.mapping.title)}">${esc(facts.mapping.label)}</b></span>
        <span class="session-fact"><i>DSH 存在</i><b class="fact-${esc(facts.dsh.key)}" title="${esc(facts.dsh.title)}">${esc(facts.dsh.label)}</b></span>
        <span class="session-fact"><i>收件箱未读</i><b class="${facts.inbox.n ? 'fact-warn' : 'fact-muted'}" title="${esc(facts.inbox.title)}">${facts.inbox.n}</b><small>${esc(facts.inbox.label)}</small></span>
        <span class="session-fact"><i>最近回执</i><b class="fact-${esc(facts.receipt.key)}" title="${esc(facts.receipt.title)}">${esc(facts.receipt.short)}</b></span>
        <span class="session-fact"><i>最后唤醒</i><b class="fact-${esc(facts.wake.key)}" title="${esc(facts.wake.title)}">${esc(facts.wake.short)}</b></span>
      </div>
      ${presenceMarkup(role.id)}
    </div>`;
  }).join('');
  ensurePresence(() => { renderTeamSessions(); renderRoles(); });
}

/* ── 团队台：消息、回执、派单 ─────────────────────────── */

// R-b5fc F-4b：角色队列面板（只读派生文件 role_queues.json）。
// 数据源只走 team:role-queues；面板不写任何状态，缺失/损坏/越权都用人话显示。
const roleQueueUi = { projectId: null, data: null, error: null, errorKind: '', viewer: null, at: 0, loading: false };
const ROLE_QUEUE_PRIORITY = { P0: 0, P1: 1, P2: 2, P3: 3 };
const ROLE_QUEUE_ROLE_LABEL = { pm: '项目经理', product: '产品设计师', analyst: '需求分析师', programmer1: '高级程序员 A', programmer2: '高级程序员 B', tester: '测试人员' };
// F-4b 查看者绑定：不固定 role=pm。当前 DSH 会话 → 项目角色映射 → 只看该角色那一队；
// 认不出角色会话时（Owner 控制台 / DSH 未连）按 PM 全量，但把来源标出来，不冒充“当前角色会话”。
const roleQueueViewer = { projectId: '', role: '', source: '', sessionId: '', at: 0 };

function roleQueueRoleForSession(project, sessionId) {
  const sid = String(sessionId || '').trim();
  if (!project || !sid) return '';
  const map = {};
  const meta = project.sessionMeta && typeof project.sessionMeta === 'object' ? project.sessionMeta : {};
  for (const role of Object.keys(meta)) if (meta[role] && meta[role].sessionId) map[role] = String(meta[role].sessionId);
  if (project.sessions && typeof project.sessions === 'object') {
    for (const role of Object.keys(project.sessions)) if (project.sessions[role]) map[role] = String(project.sessions[role]);
  }
  const mapping = project.mapping && Array.isArray(project.mapping.sessions) ? project.mapping.sessions : [];
  for (const row of mapping) if (row && row.role && row.sessionId) map[row.role] = String(row.sessionId);
  const hit = Object.keys(map).find((role) => String(map[role] || '') === sid);
  return hit || '';
}

function roleQueueSessionFromUrl() {
  const view = $('#dsh-view');
  if (!view || typeof view.getURL !== 'function') return '';
  let url = '';
  try { url = String(view.getURL() || ''); } catch { return ''; }
  const found = /session-[0-9a-fA-F]{8}-[0-9a-fA-F-]{8,}/.exec(url) || /session-[0-9a-fA-F]{8,}/.exec(url);
  return found ? found[0] : '';
}

async function roleQueueSessionFromDsh() {
  const view = $('#dsh-view');
  if (!view || typeof view.executeJavaScript !== 'function' || !dshReady) return '';
  try {
    const result = await view.executeJavaScript(`(() => {
      const attr = (el) => el ? String(el.getAttribute('data-session-id') || el.getAttribute('data-sessionid') || '') : '';
      const picked = document.querySelector('[role="treeitem"][aria-selected="true"], [role="option"][aria-selected="true"], [data-session-id][aria-current="true"], [data-session-id][aria-selected="true"]');
      const direct = attr(picked);
      if (direct) return direct;
      const hit = /session-[0-9a-fA-F]{8}-[0-9a-fA-F-]{8,}/.exec(String(location.href || ''));
      return hit ? hit[0] : '';
    })()`, true);
    return String(result || '');
  } catch { return ''; }
}

async function resolveRoleQueueViewer(project, opts = {}) {
  if (!project) { roleQueueViewer.role = ''; roleQueueViewer.source = ''; roleQueueViewer.projectId = ''; return roleQueueViewer; }
  const fresh = roleQueueViewer.at && (Date.now() - roleQueueViewer.at) < 5000;
  if (!opts.force && fresh && roleQueueViewer.projectId === project.id) return roleQueueViewer;
  // 仅测试（--queue-check）用：显式指定查看者会话，生产界面不会设置。
  const forced = window.__awbQueueViewerOverride;
  if (forced && typeof forced === 'object' && forced.role) {
    roleQueueViewer.role = String(forced.role || '');
    roleQueueViewer.sessionId = String(forced.sessionId || '');
    roleQueueViewer.source = 'session';
    roleQueueViewer.projectId = project.id;
    roleQueueViewer.at = Date.now();
    return roleQueueViewer;
  }
  let sessionId = roleQueueSessionFromUrl();
  if (!sessionId) sessionId = await roleQueueSessionFromDsh();
  const role = roleQueueRoleForSession(project, sessionId);
  roleQueueViewer.sessionId = sessionId;
  roleQueueViewer.projectId = project.id;
  roleQueueViewer.at = Date.now();
  if (role) { roleQueueViewer.role = role; roleQueueViewer.source = 'session'; }
  else if (sessionId) { roleQueueViewer.role = ''; roleQueueViewer.source = 'session-unbound'; }
  else { roleQueueViewer.role = 'pm'; roleQueueViewer.source = 'owner-console'; }
  return roleQueueViewer;
}

function roleQueueViewerLabel(viewer) {
  const v = viewer || roleQueueViewer;
  if (v.source === 'session' && v.role) return `当前会话：${ROLE_QUEUE_ROLE_LABEL[v.role] || v.role}（只看本角色）`;
  if (v.source === 'session-unbound') return '当前会话未绑定角色（看不到队列）';
  if (v.source === 'owner-console') return 'Owner 控制台（未识别角色会话，按 PM 全量）';
  return '查看者未识别';
}

function roleQueueCaps() {
  return Boolean(window.workbench && typeof window.workbench.teamRoleQueues === 'function');
}

/** 排序口径（需求写死）：优先级 → 截止日期 → 创建时间；空值排最后，不猜。 */
function roleQueueRows(list) {
  const rank = (row) => (Object.prototype.hasOwnProperty.call(ROLE_QUEUE_PRIORITY, String(row && row.priority)) ? ROLE_QUEUE_PRIORITY[row.priority] : 9);
  const time = (value) => {
    const ms = Date.parse(String(value || ''));
    return Number.isFinite(ms) ? ms : Number.MAX_SAFE_INTEGER;
  };
  return (Array.isArray(list) ? list.slice() : []).sort((a, b) => {
    const byPriority = rank(a) - rank(b);
    if (byPriority) return byPriority;
    const byDue = time(a && a.due) - time(b && b.due);
    if (byDue) return byDue;
    return time(a && a.createdAt) - time(b && b.createdAt);
  });
}

function roleQueueRowHtml(row) {
  const taskId = String((row && row.taskId) || '');
  const requirementId = String((row && row.requirementId) || '');
  const action = String((row && row.action) || '—');
  const status = String((row && row.status) || '—');
  const priority = String((row && row.priority) || '—');
  const evidence = String((row && row.evidencePath) || '');
  return `<tr data-task="${esc(taskId)}" data-requirement="${esc(requirementId)}">
    <td class="rq-p">${esc(priority)}</td>
    <td class="rq-task"><code>${esc(taskId || '—')}</code></td>
    <td class="rq-action">${esc(action)}</td>
    <td class="rq-status">${esc(status)}</td>
    <td class="rq-req"><code>${esc(requirementId || '—')}</code></td>
    <td class="rq-evidence" title="${esc(evidence)}">${evidence ? `<code>${esc(evidence.length > 46 ? evidence.slice(0, 46) + '…' : evidence)}</code>` : '<span class="muted">无</span>'}</td>
  </tr>`;
}

function roleQueuePaintViewer(box) {
  if (!box) return;
  const viewer = roleQueueUi.viewer || roleQueueViewer;
  box.dataset.viewerRole = String(viewer.role || '');
  box.dataset.viewerSource = String(viewer.source || '');
  box.dataset.viewerSession = String(viewer.sessionId || '');
  const badge = $('#role-queue-viewer');
  if (badge) {
    badge.textContent = '查看者：' + roleQueueViewerLabel(viewer).replace(/（.*$/, '');
    badge.className = 'badge muted-badge';
    badge.title = roleQueueViewerLabel(viewer) + (viewer.sessionId ? ` · 会话 ${viewer.sessionId}` : '');
  }
}

function renderRoleQueue() {
  const box = $('#role-queue');
  const meta = $('#role-queue-meta');
  if (!box) return;
  roleQueuePaintViewer(box);
  const p = activeProject();
  if (!p) {
    box.dataset.state = 'empty';
    box.dataset.count = '0';
    box.dataset.reason = '';
    box.innerHTML = '<div class="empty-row">先选择工作区，再看角色队列。</div>';
    if (meta) { meta.textContent = '未加载'; meta.className = 'badge muted-badge'; }
    return;
  }
  if (!roleQueueCaps()) {
    box.dataset.state = 'error';
    box.innerHTML = '<div class="empty-row">当前壳层没有 team:role-queues 接口，队列面板不可用。</div>';
    if (meta) { meta.textContent = '接口缺失'; meta.className = 'badge badge-rejected'; }
    return;
  }
  if (roleQueueUi.error) {
    // F-4b：会话没绑角色不是“读取失败”，用灰字说明；越权与真错误才报红。
    if (roleQueueUi.errorKind === 'unbound') {
      box.dataset.state = 'unbound';
      box.dataset.count = '0';
      box.dataset.reason = 'unbound';
      box.innerHTML = `<div class="empty-row">${esc(roleQueueUi.error)}</div>`;
      if (meta) { meta.textContent = '会话未绑定角色'; meta.className = 'badge muted-badge'; meta.title = roleQueueViewerLabel(roleQueueUi.viewer || roleQueueViewer); }
      return;
    }
    box.dataset.state = 'error';
    box.innerHTML = `<div class="empty-row">${esc(roleQueueUi.error)}</div>`;
    if (meta) { meta.textContent = '读取失败'; meta.className = 'badge badge-rejected'; }
    return;
  }
  const data = roleQueueUi.data;
  if (!data) {
    box.dataset.state = 'loading';
    box.innerHTML = '<div class="empty-row">读取中…</div>';
    if (meta) { meta.textContent = '读取中…'; meta.className = 'badge muted-badge'; }
    return;
  }
  if (data.missing) {
    // 派单 8bfe ①：文件缺失/损坏都按「队列未生成」降级，灰字不报红；解析原文只进 title 与日志。
    const broken = Boolean(data.degraded) || data.code === 'QUEUE_FILE_BROKEN';
    box.dataset.state = 'missing';
    box.dataset.count = '0';
    box.dataset.reason = broken ? 'broken' : 'missing';
    box.dataset.degraded = broken ? '1' : '0';
    box.innerHTML = broken
      ? `<div class="empty-row">队列未生成（文件损坏已忽略）：点「刷新」重试或等队列生成器重建。</div>`
      : `<div class="empty-row">队列未生成（${esc(data.project || p.name)} 还没有 role_queues.json）：等队列生成器跑一次后点「刷新」。</div>`;
    if (meta) {
      meta.textContent = '队列未生成';
      meta.className = 'badge muted-badge';
      meta.title = broken
        ? `role_queues.json 解析失败，已按未生成降级（派生文件可重建）${data.detail ? '：' + data.detail : ''}`
        : 'role_queues.json 不存在（派生文件，由团队工具生成）';
    }
    return;
  }
  const roles = data.roles && typeof data.roles === 'object' ? data.roles : {};
  const keys = Object.keys(roles);
  const total = keys.reduce((sum, key) => sum + (Array.isArray(roles[key]) ? roles[key].length : 0), 0);
  box.dataset.state = 'ready';
  box.dataset.count = String(total);
  box.dataset.reason = '';
  box.dataset.degraded = '0';
  if (meta) {
    meta.textContent = `${total} 条 · ${data.generatedAt ? fmtTime(data.generatedAt) || data.generatedAt : '生成时间未记'}`;
    meta.className = 'badge ' + (total ? 'badge-approved' : 'muted-badge');
    meta.title = `来源 ${(data.source && data.source.path) || '未记'}${data.source && data.source.sha256 ? ' · sha256 ' + String(data.source.sha256).slice(0, 12) : ''}${data.meta && data.meta.teamMode ? ' · 模式 ' + data.meta.teamMode : ''}`;
  }
  if (!keys.length || !total) {
    box.innerHTML = '<div class="empty-row">队列已生成，但当前没有派给角色的活（0 条）。</div>';
    return;
  }
  box.innerHTML = keys.map((role) => {
    const rows = roleQueueRows(roles[role]);
    const label = ROLE_QUEUE_ROLE_LABEL[role] || role;
    return `<div class="rq-group" data-role="${esc(role)}" data-count="${rows.length}">
      <div class="rq-group-head"><b>${esc(label)}</b><code>${esc(role)}</code><span class="rq-count">${rows.length} 条</span></div>
      ${rows.length ? `<table class="rq-table" role="table" aria-label="${esc(label)} 的角色队列">
        <thead><tr><th>优先</th><th>任务</th><th>动作</th><th>状态</th><th>关联需求</th><th>证据路径</th></tr></thead>
        <tbody>${rows.map((row) => roleQueueRowHtml(row)).join('')}</tbody>
      </table>` : '<div class="empty-row">这一队没有活。</div>'}
    </div>`;
  }).join('');
}

async function loadRoleQueue(opts = {}) {
  const p = activeProject();
  if (!p || !roleQueueCaps()) return null;
  if (roleQueueUi.loading) return null;
  const fresh = roleQueueUi.projectId === p.id && (Date.now() - roleQueueUi.at) < 30000;
  if (!opts.force && fresh) return roleQueueUi;
  roleQueueUi.loading = true;
  roleQueueUi.error = null;
  roleQueueUi.errorKind = '';
  try {
    // F-4b：按当前会话角色绑定（不再固定 role=pm）。识别不到角色会话时才走 Owner 控制台全量，并在面板标来源。
    const viewer = await resolveRoleQueueViewer(p, { force: Boolean(opts.force) });
    roleQueueUi.viewer = { role: viewer.role, source: viewer.source, sessionId: viewer.sessionId };
    roleQueueUi.projectId = p.id;
    const payload = { projectId: p.id, sessionId: viewer.sessionId || '' };
    if (viewer.role) payload.role = viewer.role;
    const result = await window.workbench.teamRoleQueues(payload);
    roleQueueUi.at = Date.now();
    if (result && result.ok === false) {
      roleQueueUi.data = null;
      if (result.code === 'QUEUE_SESSION_UNBOUND' || result.code === 'QUEUE_VIEWER_REQUIRED') {
        roleQueueUi.errorKind = 'unbound';
        roleQueueUi.error = `${result.message || '当前会话不是角色会话'}（按 F-4b 只看当前角色会话）`;
      } else if (result.code === 'QUEUE_FORBIDDEN') {
        roleQueueUi.errorKind = 'forbidden';
        roleQueueUi.error = `越权：${result.message || '只能看自己的队列'}`;
      } else {
        roleQueueUi.errorKind = 'read';
        roleQueueUi.error = `队列读取失败：${humanError(String(result.message || result.code || '未知原因'))}`;
      }
    } else {
      roleQueueUi.data = result || null;
    }
  } catch (error) {
    roleQueueUi.data = null;
    roleQueueUi.errorKind = 'read';
    roleQueueUi.error = '队列读取失败：' + humanError(String((error && error.message) || error));
  } finally {
    roleQueueUi.loading = false;
  }
  renderRoleQueue();
  return roleQueueUi;
}

// R-9db6 F-1 / T-d2ee：Owner 决策箱。主入口是主界面右下角 #decision-box 浮层（Owner 2026-11-14 13:15 定），
// 团队台抽屉（#decision-box-drawer）保留作次入口。放入只有 PM 能做（团队工具 decision add），
// Owner 在这里逐条/批量回执（走壳层 team:decision-receipt；通道没接上时只提示、不提交）。
const DECISION_FLOAT_STATE = { data: null, expanded: false, drafts: {}, submitting: 0, error: '', decisions: null };

// 摘要裁剪：app.js 里原先没有 clip60（8a9a 抽屉版引用它 → 读箱一直报 "clip60 is not defined"），这里补上。
function clip60(text, n = 60) {
  const s = String(text || '');
  return s.length > n ? `${s.slice(0, n)}…` : s;
}

async function loadDecisionBox() {
  const drawer = $('#decision-box-drawer');
  const float = $('#decision-box');
  if (!drawer && !float) return null;
  const p = activeProject();
  if (!p) {
    DECISION_FLOAT_STATE.data = null;
    if (float) renderDecisionPill({ unread: 0, open: 0, total: 0, degraded: false });
    if (drawer) {
      drawer.dataset.state = 'empty';
      drawer.innerHTML = '<div class="empty-row">先选择工作区，再看决策箱。</div>';
    }
    return null;
  }
  if (!(window.workbench && typeof window.workbench.teamDecisionBox === 'function')) {
    if (drawer) {
      drawer.dataset.state = 'error';
      drawer.innerHTML = '<div class="empty-row">当前壳层没有 team:decision-box 接口，决策箱不可用。</div>';
    }
    if (float) renderDecisionPill({ degraded: true, message: '当前壳层没有 team:decision-box 接口' });
    return null;
  }
  try {
    const result = await window.workbench.teamDecisionBox({ projectId: p.id });
    renderDecisionBox(result || {});
    renderDecisionFloat(result || {});
    return result;
  } catch (error) {
    const why = humanError(String((error && error.message) || error));
    if (drawer) {
      drawer.dataset.state = 'error';
      drawer.innerHTML = `<div class="empty-row">决策箱读取失败：${esc(why)}</div>`;
    }
    if (float) renderDecisionPill({ degraded: true, message: '决策箱读取失败：' + why });
    return null;
  }
}

/** 收起态胶囊：只显示「决策箱 N」。 */
function renderDecisionPill(data) {
  const box = $('#decision-box');
  if (!box) return;
  const unread = Math.max(0, Number(data.unread || 0));
  box.dataset.unread = String(unread);
  box.dataset.open = String(data.open || 0);
  box.dataset.total = String(data.total || 0);
  box.dataset.degraded = data.degraded ? '1' : '0';
  // R-5016 §二（PM 19:21 约束 + tester 19:30 复核第三写者）：胶囊数字只由
  // refreshOwnerPendingCounts() 从 owner:pending-counts IPC 写；这里不再用 data.unread 覆盖胶囊
  // （否则每次 loadDecisionBox 都会先闪 unread 再被 decisions 覆盖）。
  const pill = $('#decision-box-pill');
  if (pill) {
    pill.title = data.degraded
      ? (data.message || '决策箱读不出来')
      : `需要你拍板 ${data.open || 0} 条（未读 ${unread} 条），点开逐条回执`;
  }
  // T-e2a3：收起态那个圆形按钮上的数字跟着决策箱一起变（同一份后端读数，不做前端自算）。
  syncFloatToggleBadge();
}

/* ── T-e2a3：右下单一可展开悬浮面板（收起态只留一个圆按钮）─────────────────────────
   Owner 2026-11-15 13:28 验收打回「四个入口还是四个胶囊竖排=和以前一样」。
   口径（增补卷-b28f-2 §二/§四）：
     ①收起态是默认：只显示 #side-float-toggle，四行仍在 DOM（CSS display:none），锚点全保留；
     ②点按钮展开 → data-float-expanded="1"，四行从按钮上方展开；再点 / 点外部 / Esc / 点看板或流程行后收起；
     ③展开状态不持久化（刷新回收起态）；
     ④数字优先取 decisionStats()（0b77 的 team:decision-stats，未落地时退回决策箱后端的 unread，
       标 data-float-count-source，说明来源不是前端算的）；无待决时用代管实心/空心点。
     ⑤无障碍：aria-expanded / aria-controls，展开焦点进首行，Esc 回按钮。 */
function floatPanelEl() { return $('#side-float'); }
function floatExpanded() {
  const panel = floatPanelEl();
  return Boolean(panel && panel.getAttribute('data-float-expanded') === '1');
}
function floatToggleEl() { return $('#side-float-toggle'); }
function floatFirstRow() {
  const panel = floatPanelEl();
  if (!panel) return null;
  return [...panel.querySelectorAll('.side-float-row')].find((node) => {
    if (!node || node.disabled) return false;
    const rect = node.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }) || null;
}
function setFloatExpanded(on, options = {}) {
  const panel = floatPanelEl();
  const toggle = floatToggleEl();
  if (!panel || !toggle) return false;
  const next = Boolean(on);
  panel.setAttribute('data-float-expanded', next ? '1' : '0');
  toggle.setAttribute('aria-expanded', next ? 'true' : 'false');
  if (next) {
    syncFloatToggleBadge();
    if (options.focus !== false) {
      const row = floatFirstRow();
      if (row) { try { row.focus({ preventScroll: true }); } catch { /* ignore */ } }
    }
  } else if (options.focusToggle) {
    try { toggle.focus({ preventScroll: true }); } catch { /* ignore */ }
  }
  return next;
}
/**
 * 收起态按钮数字：优先 decisionStats().pending（0b77 的 IPC，未落地就不硬造），
 * 其次决策箱后端返回的 unread（#decision-box[data-unread]，仍来自 team:decision-box IPC）。
 * 两者都没有 / 读到 0 → 不显示数字，只留代管状态点。
 */
async function syncFloatToggleBadge() {
  const toggle = floatToggleEl();
  if (!toggle) return;
  const countEl = toggle.querySelector('[data-float-count]');
  const dotEl = toggle.querySelector('[data-float-proxy-dot]');
  const proxyNode = document.querySelector('[data-or-proxy-all]');
  const proxyState = proxyNode ? String(proxyNode.getAttribute('data-proxy-state') || 'idle') : 'idle';
  if (dotEl) {
    const dot = proxyState === 'active' ? 'active' : (proxyState === 'error' ? 'error' : 'idle');
    dotEl.setAttribute('data-float-proxy-dot', dot);
  }
  let value = null;
  let source = 'none';
  const wb = window.workbench || {};
  if (typeof wb.decisionStats === 'function') {
    try {
      const project = activeProject();
      const result = await wb.decisionStats({ projectId: project ? project.id : '' });
      const pending = Number(result && (result.pending !== undefined ? result.pending : (result.unread !== undefined ? result.unread : NaN)));
      if (Number.isFinite(pending) && pending >= 0) { value = pending; source = 'decision-stats'; }
    } catch { /* 读不到就退回决策箱读数，不静默假装 0 */ }
  }
  if (value === null) {
    const box = $('#decision-box');
    const raw = box ? box.getAttribute('data-unread') : null;
    if (raw !== null && raw !== '' && Number.isFinite(Number(raw)) && !(box && box.getAttribute('data-degraded') === '1')) {
      value = Number(raw);
      source = 'decision-box';
    }
  }
  toggle.setAttribute('data-float-count-source', source);
  if (!countEl) return;
  const n = Number.isFinite(value) ? Math.max(0, Math.round(value)) : 0;
  countEl.textContent = String(n);
  countEl.hidden = n <= 0;
  countEl.setAttribute('data-float-count-value', String(n));
  toggle.setAttribute('aria-label', n > 0
    ? `更多入口（一键代管 / 决策箱 / 团队看板 / 流程），待你回执 ${n} 条`
    : '更多入口：一键代管 / 决策箱 / 团队看板 / 流程');
}
let floatProxyObserver = null;
/**
 * R-c1ed 第一刀：渲染崩溃感知横幅（顶部人话 + 一键重载聊天区）。
 * 主进程监听 render-process-gone / child-process-gone / unresponsive 后推 app:render-crash；
 * 这里只负责「看得见、点得动」，审计与写盘在主进程（团队/状态/项目/<项目>/渲染崩溃.jsonl）。
 */
function initCrashBanner() {
  const wb = window.workbench || {};
  function ensureBanner() {
    let node = document.getElementById('crash-banner');
    if (node) return node;
    node = document.createElement('div');
    node.id = 'crash-banner';
    node.className = 'crash-banner';
    node.setAttribute('data-crash-banner', '1');
    node.hidden = true;
    node.innerHTML = '<b data-crash-title>DSH 渲染进程已崩溃</b>'
      + '<span data-crash-detail></span>'
      + '<button type="button" class="ghost small" data-crash-reload>重载聊天区</button>'
      + '<button type="button" class="ghost small" data-crash-dismiss>先不管</button>';
    if (document.body.firstChild) document.body.insertBefore(node, document.body.firstChild);
    else document.body.appendChild(node);
    node.querySelector('[data-crash-reload]').addEventListener('click', async () => {
      const btn = node.querySelector('[data-crash-reload]');
      // B-2dd3：同一横幅两种用途——内存告警时按钮是「立即回收」，不重载聊天区。
      const memKind = /memory/.test(String(node.getAttribute('data-crash-kind') || ''));
      btn.disabled = true;
      btn.textContent = memKind ? '回收中…' : '重载中…';
      let result = { ok: false };
      try {
        if (memKind) {
          result = typeof wb.memRecycle === 'function' ? await wb.memRecycle() : { ok: false, code: 'IPC_MISSING' };
        } else {
          result = typeof wb.reloadDshView === 'function' ? await wb.reloadDshView() : { ok: false, code: 'IPC_MISSING' };
        }
      } catch { result = { ok: false }; }
      btn.disabled = false;
      if (memKind) {
        btn.textContent = result && result.ok ? '已回收' : '回收失败，点重试';
        node.setAttribute('data-crash-last-reload', result && result.ok ? 'ok' : 'failed');
        if (result && result.ok) setTimeout(() => { node.hidden = true; }, 1600);
      } else {
        btn.textContent = result && result.ok ? '已重载' : '重载失败，点重试';
        node.setAttribute('data-crash-last-reload', result && result.ok ? 'ok' : 'failed');
        if (result && result.ok) setTimeout(() => { node.hidden = true; }, 1200);
      }
    });
    node.querySelector('[data-crash-dismiss]').addEventListener('click', () => { node.hidden = true; });
    return node;
  }
  const show = (row) => {
    const node = ensureBanner();
    const info = row && typeof row === 'object' ? row : {};
    const when = info.at ? String(info.at).slice(0, 19).replace('T', ' ') : '';
    const parts = [
      info.reason ? `原因 ${info.reason}` : '',
      (info.exitCode === null || info.exitCode === undefined) ? '' : `退出码 ${info.exitCode}`
    ].filter(Boolean);
    // B-2dd3：内存阈值告警复用同一横幅，但标题/按钮必须说实话（不能显示「已崩溃」）。
    const memKind = /memory/.test(String(info.kind || ''));
    node.querySelector('[data-crash-title]').textContent = memKind ? '渲染进程内存接近上限' : 'DSH 渲染进程已崩溃';
    node.querySelector('[data-crash-reload]').textContent = memKind ? '立即回收' : '重载聊天区';
    node.querySelector('[data-crash-detail]').textContent = [when, parts.join(' · ')].filter(Boolean).join(' · ') || '（详情已写入审计）';
    node.setAttribute('data-crash-kind', String(info.kind || ''));
    node.setAttribute('data-crash-mem-alert', memKind ? '1' : '0');
    node.hidden = false;
  };
  if (typeof wb.onRenderCrash === 'function') wb.onRenderCrash(show);
  window.__awbCrashBanner = { show };
}

function initFloatToggle() {
  const panel = floatPanelEl();
  const toggle = floatToggleEl();
  if (!panel || !toggle) return false;
  // 默认收起（刷新也不记忆：不写 localStorage/sessionStorage）。
  setFloatExpanded(false, { focus: false });
  toggle.addEventListener('click', (event) => {
    event.preventDefault();
    event.stopPropagation();
    setFloatExpanded(!floatExpanded());
  });
  // 点外部收起（面板里的三块浮层不受影响：它们不是"外部"）。
  document.addEventListener('pointerdown', (event) => {
    if (!floatExpanded()) return;
    const target = event.target;
    if (!(target instanceof Element)) return;
    if (target.closest('#side-float')) return;
    if (target.closest('#decision-box-panel, #flow-panel, #board-panel, .decision-panel')) return;
    setFloatExpanded(false);
  }, true);
  // Esc 收起并回按钮；展开态按 Esc 也把焦点还回去。
  document.addEventListener('keydown', (event) => {
    if (event.key !== 'Escape' || !floatExpanded()) return;
    setFloatExpanded(false, { focusToggle: true });
  });
  // 点「看板 / 流程 / 一键代管」完成跳转后自动收起；决策箱是就地展开自己的面板，保持不变。
  panel.addEventListener('click', (event) => {
    const target = event.target instanceof Element ? event.target : null;
    if (!target) return;
    if (!target.closest('[data-board], [data-flow], [data-or-proxy-all]')) return;
    setTimeout(() => { if (floatExpanded()) setFloatExpanded(false); }, 0);
  });
  // 代管状态点跟随 [data-or-proxy-all][data-proxy-state]（owner-review.js 是唯一写入口）。
  if (typeof MutationObserver === 'function') {
    const proxyNode = document.querySelector('[data-or-proxy-all]');
    if (proxyNode) {
      floatProxyObserver = new MutationObserver(() => { void syncFloatToggleBadge(); });
      floatProxyObserver.observe(proxyNode, { attributes: true, attributeFilter: ['data-proxy-state', 'data-proxy-all-state'] });
    }
  }
  void syncFloatToggleBadge();
  return true;
}

function decisionChoicesOf(item) {
  const opts = Array.isArray(item.options) ? item.options.filter(Boolean) : [];
  return opts.length ? opts : ['通过', '打回', '其他'];
}

/** R-5016 AC3：入箱七要素（source/summary/question/options2-4/defaultChoice/impact/dueAt）；缺项条目不展示。 */
function decisionIsComplete(item) {
  if (!item || !item.id) return false;
  const has = (v) => String(v === undefined || v === null ? '' : v).trim().length > 0;
  const opts = Array.isArray(item.options) ? item.options.filter((o) => String(o || '').trim()) : [];
  return has(item.source && item.source.ref) && has(item.summary) && has(item.question)
    && opts.length >= 2 && opts.length <= 4
    && has(item.defaultChoice) && has(item.impact) && has(item.dueAt);
}

function decisionRowMarkup(item) {
  const st = String(item.status || 'open');
  const isOpen = st === 'open';
  const badge = isOpen
    ? `<span class="badge ${item.readAt ? 'muted-badge' : 'badge-pending'}">${item.readAt ? '已读' : '未读'}</span>`
    : '<span class="badge muted-badge">已回执</span>';
  // B-5d4f：原来这里是个死了的「看来源」按钮（只渲染 data-source-open，没有 click 绑定）——
  // Owner 说没必要用，直接把按钮删掉；source 数据字段保留，改成一行只读文字。
  const src = item.source && item.source.ref
    ? `<span class="muted" data-decision-source="${esc(item.source.ref)}" data-decision-source-kind="${esc(item.source.kind || 'none')}">来源：${esc(item.source.ref)}</span>`
    : '<span class="muted">未记来源</span>';
  const reply = isOpen
    ? `<div class="decision-choices" data-decision-choices>${decisionChoicesOf(item).map((o) => `<button type="button" class="decision-opt" data-decision-opt="${esc(o)}">${esc(o)}</button>`).join('')}</div>
       <div class="decision-reply">
         <input class="decision-opinion" data-decision-opinion maxlength="500" placeholder="意见（≤500 字；选“打回”必填）">
         <button type="button" class="ghost small" data-decision-submit data-decision-submit-state="idle">回执 PM</button>
       </div>`
    : (item.decision && item.decision.choice
      ? `<div class="decision-line decision-decided">已回执：${esc(item.decision.choice)}${item.decision.opinion ? ' ｜ 意见：' + esc(item.decision.opinion) : ''}</div>`
      : '');
  // Owner 2026-11-14 13:55：不要批量勾选，一条一条点（勾选框与底部【回执 PM（N 条）】已整体移除）。
  return `<div class="decision-row${isOpen ? '' : ' done'}" data-decision-item="1" data-decision-id="${esc(item.id)}" data-status="${esc(st)}">
    <div class="decision-head"><b>${esc(item.title || item.id)}</b><code>${esc(item.id)}</code>${badge}</div>
    <div class="decision-line">${esc(clip60(item.summary || '', 60))}</div>
    <div class="decision-line muted">要决定什么：${esc(item.question || '未写')}</div>
    <div class="decision-line muted" data-decision-default>默认项：${esc(item.defaultChoice || '未写')}</div>
    <div class="decision-line muted" data-decision-impact>影响：${esc(item.impact || '未写')}</div>
    <div class="decision-line muted" data-decision-due>截止：${esc(item.dueAt || '未写')}</div>
    ${item.redirect && item.redirect.to
      ? `<div class="decision-line redirect" data-decision-redirect="${esc(item.redirect.to)}">已转投到 ${esc(item.redirect.to)}${item.redirect.reason ? '（' + esc(clip60(item.redirect.reason, 60)) + '）' : ''}</div>`
      : ''}
    ${reply}
    <div class="decision-actions">${src}<span class="muted">放入于 ${esc(fmtTime(item.createdAt) || '未记')}</span></div>
    <div class="decision-error" data-decision-error hidden></div>
  </div>`;
}

/** B-20261116-061156-60ae：「计数有 N、列表被过滤空」时必须给三数说明行（禁止静默）。
 *  total=IPC decisions，shown=实际渲染 open 条数，hidden=total-shown。 */
function decisionHiddenNoteNode(total, shown, hidden) {
  const note = document.createElement('div');
  note.className = 'empty-row decision-hidden-note';
  note.setAttribute('data-decision-total', String(total));
  note.setAttribute('data-decision-shown', String(shown));
  note.setAttribute('data-decision-hidden', String(hidden));
  note.textContent = `共 ${total} 条待决，显示 ${shown} 条，另有 ${hidden} 条历史条目不满足七要素（缺来源/背景/问题/选项/默认项/影响/截止）未展示；补七要素后自动出现`;
  return note;
}

/** 展开态列表（浮层）：与团队台抽屉共用同一份数据，回执控件只在这里给。 */
function renderDecisionFloat(data) {
  // R-c72a F2b/AC3（批3 重写）：#decision-box 的「首屏可交互」锚点由本函数独占——开始渲染置 "0"、
  // 首屏渲染完成置 "1"、渲染抛错保持 "0"（不在 finally 里强行置 1）。关闭浮层不重置；
  // 下次打开由 setDecisionExpanded(true) 重新调用本函数走「0 → 1」，重复打开必须重新计时。
  const __readyBox = document.querySelector("#decision-box");
  if (__readyBox) __readyBox.setAttribute("data-decision-ready", "0");
  const __readyRet = renderDecisionFloatInner(data);
  if (__readyBox) __readyBox.setAttribute("data-decision-ready", "1");
  return __readyRet;
}

function renderDecisionFloatInner(data) {
  DECISION_FLOAT_STATE.data = data || null;
  renderDecisionPill(data || {});
  const list = $('#decision-box-list');
  const unreadEl = $('#decision-box-unread');
  const box = $('#decision-box');
  if (!list) return;
  // B-20261115-162904-f6c0：回执提交中不重绘——自动刷新（fs.watch + 15 秒轮询）会在点选与提交之间
  // 把候选选中态/已填意见整块抹掉，Owner 看到的就是「点了没反应」。提交完成后再统一刷新。
  if (DECISION_FLOAT_STATE.submitting > 0) return;
  const allItems = Array.isArray(data.items) ? data.items : [];
  // R-5016 AC3：缺项条目不展示（后端已拒收；旧条目按展示过滤，不改存储、不迁移）。
  const items = allItems.filter(decisionIsComplete);
  const openCount = items.filter((item) => String(item.status || 'open') === 'open').length;
  const unreadCount = Math.max(0, Number(data.unread || 0));
  if (unreadEl) {
    unreadEl.textContent = `待决 ${unreadCount}`;
    unreadEl.setAttribute('data-unread', String(unreadCount));
    unreadEl.className = 'badge ' + (unreadCount ? 'badge-pending' : 'muted-badge');
  }
  if (box) {
    box.dataset.unread = String(unreadCount);
    box.dataset.open = String(openCount);
    box.dataset.total = String(items.length);
  }
  if (data.degraded) {
    list.innerHTML = `<div class="empty-row">${esc(data.message || '决策箱读不出来（已按空箱显示）')}</div>`;
    return;
  }
  // B-20261116-061156-60ae：不能先返回「暂无待决事项」把被过滤的条目吞掉——
  // 先算好 total/shown/hidden，空列表但 hidden>0 时仍要给出三数说明行（禁止静默）。
  const openShown = items.filter((item) => String(item.status || 'open') === 'open').length;
  const ipcDecisions = Number(DECISION_FLOAT_STATE.decisions);
  const totalDecisions = Math.max(openShown, Number.isFinite(ipcDecisions) && ipcDecisions >= 0 ? ipcDecisions : 0, Number(data.open || 0) || 0);
  const hiddenCount = Math.max(0, totalDecisions - openShown);
  if (!items.length) {
    list.innerHTML = '';
    if (hiddenCount > 0) {
      list.appendChild(document.createElement('div')).className = 'empty-row';
      list.firstChild.textContent = '暂无可展示的待决条目';
      list.appendChild(decisionHiddenNoteNode(totalDecisions, openShown, hiddenCount));
    } else {
      list.innerHTML = '<div class="empty-row">暂无待决事项</div>';
    }
    decisionRestoreDrafts();
    return;
  }
  list.innerHTML = items.map((item) => decisionRowMarkup(item)).join('');
  // PM 19:32 + 项目「禁止静默」口径：缺项历史条目被过滤时必须明说，不能静默隐藏。
  // PM 19:36 第四笔：total 必须 = ownerPendingCounts().decisions（IPC，抽屉顶部同值），
  // shown = 实际渲染的 open 条目数（DOM 可数 [data-decision-item][data-status=open]），hidden = total - shown。
  if (hiddenCount > 0) {
    list.appendChild(decisionHiddenNoteNode(totalDecisions, openShown, hiddenCount));
  }
  // 重绘后把「正在填的草稿」放回去：刷新不该吞掉已选候选与已填意见。
  decisionRestoreDrafts();
}

function renderDecisionBox(data) {
  const box = $('#decision-box-drawer');
  const unread = $('#decision-box-drawer-unread');
  if (!box) return;
  const items = (Array.isArray(data.items) ? data.items : []).filter(decisionIsComplete);
  const openItems = items.filter((item) => String(item.status || 'open') === 'open');
  const unreadCount = Number(data.unread || 0);
  box.dataset.unread = String(unreadCount);
  box.dataset.open = String(openItems.length);
  box.dataset.total = String(items.length);
  // R-5016 §二（PM 2026-11-15 19:21 约束）：抽屉顶部数字 = ownerPendingCounts().decisions，
  // 只由 refreshOwnerPendingCounts() 单源写入；这里不再自算 unread 展示，避免与 IPC 两处打架。
  if (unread) unread.title = `待决由 ownerPendingCounts().decisions 单源提供（未读 ${unreadCount} 条另计）`;
  if (data.degraded) {
    box.dataset.state = 'degraded';
    box.innerHTML = `<div class="empty-row">${esc(data.message || '决策箱读不出来（已按空箱显示）')}</div>`;
    return;
  }
  // B-20261116-061156-60ae：抽屉同样不能空列表吞条目——先算三数，空列表但 hidden>0 仍给说明。
  const openShown2 = openItems.length;
  const ipcDecisions2 = Number(DECISION_FLOAT_STATE.decisions);
  const totalDecisions2 = Math.max(openShown2, Number.isFinite(ipcDecisions2) && ipcDecisions2 >= 0 ? ipcDecisions2 : 0, Number(data.open || 0) || 0);
  const hiddenCount2 = Math.max(0, totalDecisions2 - openShown2);
  if (!items.length) {
    box.dataset.state = 'empty';
    if (hiddenCount2 > 0) {
      box.innerHTML = '<div class="empty-row">暂无可展示的待决条目</div>';
      box.insertAdjacentHTML('beforeend', `<div class="empty-row decision-hidden-note" data-decision-total="${totalDecisions2}" data-decision-shown="${openShown2}" data-decision-hidden="${hiddenCount2}">共 ${totalDecisions2} 条待决，显示 ${openShown2} 条，另有 ${hiddenCount2} 条历史条目不满足七要素未展示；补七要素后自动出现</div>`);
    } else {
      box.innerHTML = '<div class="empty-row">暂无待决事项</div>';
    }
    return;
  }
  box.dataset.state = 'ready';
  box.innerHTML = items.map((item) => {
    const isOpen = String(item.status || 'open') === 'open';
    const badge = isOpen ? '<span class="badge badge-pending">待决</span>' : '<span class="badge muted-badge">已回执</span>';
    const src = item.source && item.source.ref
      ? `<span class="muted" data-decision-source="${esc(item.source.ref)}" data-decision-source-kind="${esc(item.source.kind || 'none')}">来源：${esc(item.source.ref)}</span>`
      : '<span class="muted">未记来源</span>';
    return `<div class="decision-row${isOpen ? '' : ' done'}" data-decision-item="1" data-decision-id="${esc(item.id)}" data-status="${esc(String(item.status || 'open'))}">
      <div class="decision-head"><b>${esc(item.title || item.id)}</b><code>${esc(item.id)}</code>${badge}</div>
      <div class="decision-line">${esc(clip60(item.summary || '', 60))}</div>
      <div class="decision-line muted">要决定什么：${esc(item.question || '未写')}</div>
      <div class="decision-actions">${src}<span class="muted">放入于 ${esc(fmtTime(item.createdAt) || '未记')}</span></div>
    </div>`;
  }).join('');
  // PM 19:36 第四笔：total = ownerPendingCounts().decisions（IPC，与抽屉顶部/胶囊同值）；
  // shown = 实际渲染的 open 条数（DOM [data-decision-item][data-status=open]）；hidden = total - shown。
  // 三数已在本函数开头算好（openShown2/totalDecisions2/hiddenCount2），这里只追加说明行。
  if (hiddenCount2 > 0) {
    // tester 19:36 注记：innerHTML += 会重解析并重建抽屉所有子节点（将来若给行绑事件/草稿状态会丢），
    // 改用 insertAdjacentHTML('beforeend') 只追加。
    box.insertAdjacentHTML('beforeend', `<div class="empty-row decision-hidden-note" data-decision-total="${totalDecisions2}" data-decision-shown="${openShown2}" data-decision-hidden="${hiddenCount2}">共 ${totalDecisions2} 条待决，显示 ${openShown2} 条，另有 ${hiddenCount2} 条历史条目不满足七要素未展示；补七要素后自动出现</div>`);
  }
}

/** 收起/展开浮层（默认收起，只显示胶囊）。 */
function setDecisionExpanded(on) {
  const box = $('#decision-box');
  const panel = $('#decision-box-panel');
  const pill = $('#decision-box-pill');
  if (!box || !panel) return;
  DECISION_FLOAT_STATE.expanded = Boolean(on);
  panel.hidden = !on;
  box.dataset.state = on ? 'expanded' : 'collapsed';
  if (pill) pill.setAttribute('aria-expanded', on ? 'true' : 'false');
  // R-c72a AC3（批3）：关闭浮层不重置 data-decision-ready；重新打开必须重新走「置 0 → 置 1」——
  // 展开时用已加载的同一份数据重跑一次 renderDecisionFloat（数据新鲜度仍由 15s 轮询/fs.watch 保证，不在这里新增取数）。
  if (on) {
    if (DECISION_FLOAT_STATE.data) renderDecisionFloat(DECISION_FLOAT_STATE.data);
    else void loadDecisionBox();
  }
}

function decisionSetError(row, text) {
  const el = row ? row.querySelector('[data-decision-error]') : null;
  if (!el) return;
  el.textContent = text || '';
  el.hidden = !text;
}

/** B-20261115-162904-f6c0：顶部红色横幅——行内错误会被自动刷新/收起面板吞掉，失败必须有持久可见的落点。 */
function decisionSetBanner(text) {
  DECISION_FLOAT_STATE.error = String(text || '');
  const el = $('#decision-error-banner');
  const textEl = $('#decision-error-text');
  if (el) el.hidden = !DECISION_FLOAT_STATE.error;
  if (textEl) textEl.textContent = DECISION_FLOAT_STATE.error || '';
}

/** 草稿：刷新重绘后把「已选候选 + 已填意见」放回去（否则 Owner 点选后一刷新就没了）。 */
function decisionSaveDraft(row) {
  const p = decisionPayloadOf(row);
  if (!p.id) return;
  if (!p.choice && !p.opinion) { delete DECISION_FLOAT_STATE.drafts[p.id]; return; }
  DECISION_FLOAT_STATE.drafts[p.id] = { choice: p.choice, opinion: p.opinion };
}

function decisionRestoreDrafts() {
  const list = $('#decision-box-list');
  if (!list) return;
  for (const row of list.querySelectorAll('.decision-row')) {
    const id = row.getAttribute('data-decision-id') || '';
    const draft = DECISION_FLOAT_STATE.drafts[id];
    if (!draft) continue;
    if (draft.choice) {
      for (const opt of row.querySelectorAll('.decision-opt')) {
        opt.classList.toggle('selected', opt.getAttribute('data-decision-opt') === draft.choice);
      }
    }
    const input = row.querySelector('[data-decision-opinion]');
    if (input && draft.opinion) input.value = draft.opinion;
  }
}

function decisionPayloadOf(row) {
  const chip = row.querySelector('.decision-opt.selected');
  const opinionEl = row.querySelector('[data-decision-opinion]');
  return {
    id: row.getAttribute('data-decision-id') || '',
    choice: chip ? chip.getAttribute('data-decision-opt') : '',
    opinion: opinionEl ? String(opinionEl.value || '').trim() : ''
  };
}

function decisionWhyOf(p) {
  if (!p.choice) return '先点一个候选（通过 / 打回 / 其他）';
  if (p.choice.includes('打回') && !p.opinion) return '选「打回」必须写一句意见';
  if (p.opinion.length > 500) return '意见最多 500 字';
  return '';
}

/**
 * 回执出口：后端 IPC `owner:decision-ack`（程序员B 契约 v2）。
 * preload 实际暴露在 window.workbench.ownerDecisionAck（B 文档写 window.team，这里两个位置都兼容）。
 * 入参 {items:[{id,choice,opinion}]}；单条也走 items 一条，批量一次请求只发一次。
 */
async function decisionAckSend(items) {
  const wb = window.workbench || {};
  const teamNs = window.team || {};
  const fn = (typeof wb.ownerDecisionAck === 'function')
    ? wb.ownerDecisionAck
    : (typeof teamNs.ownerDecisionAck === 'function' ? teamNs.ownerDecisionAck : null);
  if (!fn) {
    return { ok: false, code: 'RECEIPT_BRIDGE_MISSING', message: '壳层还没接上回执通道（owner:decision-ack），这条没有提交，仍是待决' };
  }
  // P0（M-20261114-135253）：主进程用 teamProjectNameOf(payload) 解析项目，必须带 projectId/project，
  // 否则一律 NO_PROJECT（列表能读是因为 loadDecisionBox 传了 projectId）。
  const project = activeProject();
  if (!project || !project.id) {
    return { ok: false, code: 'NO_PROJECT', message: '还没有选择工作区，回执没有提交（仍是待决）' };
  }
  try {
    const out = await fn({ projectId: project.id, project: project.name, items });
    if (!out || out.ok === false) {
      return { ok: false, code: (out && out.code) || 'DECISION_ACK_FAILED', message: (out && out.message) || '后端没有确认这次回执' };
    }
    return out;
  } catch (error) {
    return { ok: false, code: 'DECISION_ACK_FAILED', message: String((error && error.message) || error) };
  }
}

/** 用后端返回的 counts 刷新未读/待决（权威值，不在前端自己猜）。 */
function decisionApplyCounts(counts) {
  if (!counts || typeof counts !== 'object') return;
  const box = $('#decision-box');
  const unread = Math.max(0, Number(counts.unread || 0));
  const open = Math.max(0, Number(counts.open || 0));
  if (box) {
    box.dataset.unread = String(unread);
    box.dataset.open = String(open);
  }
  // R-5016 §二（PM 19:21 约束）：胶囊数字 = ownerPendingCounts().decisions，只由 refreshOwnerPendingCounts() 写；
  // 这里不再把 decisionAckSend 的 unread 写进胶囊（回执瞬间会闪成另一个口径）。
  const unreadEl = $('#decision-box-unread');
  if (unreadEl) {
    unreadEl.textContent = `待决 ${unread}`;
    unreadEl.setAttribute('data-unread', String(unread));
    unreadEl.className = 'badge ' + (unread ? 'badge-pending' : 'muted-badge');
  }
  // 抽屉顶部「待决」同理：只由 IPC decisions 写（tester 2026-11-15 19:25 复核发现的第二写者，已删）。
  const drawer = $('#decision-box-drawer');
  if (drawer) { drawer.dataset.unread = String(unread); drawer.dataset.open = String(open); }
}

/** 一条回执落账后的行内更新（状态与消息 id 都取后端 results[]）。 */
function decisionApplyResult(row, p, result) {
  row.dataset.status = String((result && result.status) || 'answered');
  const badge = row.querySelector('.badge');
  if (badge) { badge.textContent = '已回执'; badge.className = 'badge muted-badge'; }
  row.querySelector('[data-decision-choices]')?.remove();
  row.querySelector('.decision-reply')?.remove();
  const line = document.createElement('div');
  line.className = 'decision-line decision-decided';
  line.setAttribute('data-decision-result', p.id);
  const msgId = result && result.messageId;
  line.textContent = '已回执：' + p.choice + (p.opinion ? ' ｜ 意见：' + p.opinion : '') + (msgId ? ' ｜ 回执消息 ' + msgId : '');
  row.appendChild(line);
  decisionSetError(row, '');
}

function decisionRowById(id) {
  return document.querySelector(`#decision-box-list .decision-row[data-decision-id="${String(id).replace(/"/g, '\\"')}"]`);
}

async function decisionSubmitOne(row) {
  const p = decisionPayloadOf(row);
  const why = decisionWhyOf(p);
  if (why) {
    decisionSetError(row, why);
    decisionSetBanner(why);
    return false;
  }
  const btn = row.querySelector('[data-decision-submit]');
  DECISION_FLOAT_STATE.submitting += 1;
  if (btn) { btn.disabled = true; btn.textContent = '提交中…'; btn.setAttribute('data-decision-submit-state', 'busy'); }
  try {
    const out = await decisionAckSend([{ id: p.id, choice: p.choice, opinion: p.opinion }]);
    if (!out.ok) {
      const text = `没提交成功：${out.message || out.code}（${out.code}）`;
      if (btn) { btn.disabled = false; btn.textContent = '回执 PM'; btn.setAttribute('data-decision-submit-state', 'error'); }
      decisionSetError(row, text);
      decisionSetBanner(text);
      decisionSaveDraft(row); // 草稿保留，排错后可再点一次
      return false;
    }
    const result = (Array.isArray(out.results) ? out.results : []).find((r) => r && r.id === p.id) || null;
    delete DECISION_FLOAT_STATE.drafts[p.id];
    decisionSetBanner('');
    decisionApplyResult(row, p, result);
    decisionApplyCounts(out.counts);
    return true;
  } finally {
    DECISION_FLOAT_STATE.submitting = Math.max(0, DECISION_FLOAT_STATE.submitting - 1);
    if (btn) btn.setAttribute('data-decision-submit-state', 'idle');
    // 提交结束用磁盘真值回填（成功是 answered，失败仍是 open——绝不前端自己标「已回执」）。
    void loadDecisionBox();
  }
}

/** 浮层交互（只绑一次）：胶囊开关、候选选择、单条回执。
 *  Owner 2026-11-14 13:55：去掉批量勾选，一条一条点。 */
function bindDecisionFloat() {
  const box = $('#decision-box');
  if (!box || box.dataset.bound === '1') return;
  box.dataset.bound = '1';
  $('#decision-box-pill')?.addEventListener('click', () => setDecisionExpanded(!DECISION_FLOAT_STATE.expanded));
  $('#decision-box-close')?.addEventListener('click', () => setDecisionExpanded(false));
  $('#decision-error-close')?.addEventListener('click', () => decisionSetBanner(''));
  // B-20261118-005604-54e3：特效失败横幅的「知道了」——只清提示，不改档位（档位已回退到磁盘现状）
  $('#effect-error-close')?.addEventListener('click', () => setEffectError(''));
  // 意见输入也存草稿：自动刷新重绘后不丢已填内容。
  box.addEventListener('input', (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    if (!target.closest('[data-decision-opinion]')) return;
    const row = target.closest('.decision-row');
    if (row) decisionSaveDraft(row);
  });
  box.addEventListener('click', async (event) => {
    const target = event.target;
    if (!target || !target.closest) return;
    const opt = target.closest('.decision-opt');
    if (opt) {
      const row = opt.closest('.decision-row');
      const group = row ? row.querySelector('[data-decision-choices]') : null;
      if (group) group.querySelectorAll('.decision-opt').forEach((b) => b.classList.remove('selected'));
      opt.classList.add('selected');
      const submit = row ? row.querySelector('[data-decision-submit]') : null;
      if (submit) submit.disabled = false;
      decisionSetError(row, '');
      decisionSetBanner('');
      if (row) decisionSaveDraft(row);
      return;
    }
    const one = target.closest('[data-decision-submit]');
    if (one) {
      event.preventDefault(); event.stopPropagation();
      const row = one.closest('.decision-row');
      if (row) await decisionSubmitOne(row);
    }
  });
  setDecisionExpanded(false);
}

// B-e731（P0）：决策箱自动刷新。主进程 fs.watch 决策箱.json → 推送 team:decision-box-changed；
// 界面收到就重取；另加 15 秒可见时低频轮询兜底（窗口隐藏降到 60 秒），手动【刷新】保留。
const DECISION_REFRESH = { bound: false, timer: null, polls: 0, refreshes: 0, source: '', lastAt: 0 };

function decisionRefresh(reason) {
  DECISION_REFRESH.refreshes += 1;
  DECISION_REFRESH.source = String(reason || '');
  DECISION_REFRESH.lastAt = Date.now();
  const box = $('#decision-box');
  if (box) {
    box.dataset.refreshCount = String(DECISION_REFRESH.refreshes);
    box.dataset.refreshSource = DECISION_REFRESH.source;
    box.dataset.refreshAt = new Date().toISOString();
  }
  void refreshOwnerPendingCounts();
  return loadDecisionBox();
}

/** R-5016 §二/AC7（界面侧）：三入口数字只读同一 IPC（owner:pending-counts），界面不得自算；无 IPC 显示「待核验」。
 *  文档写死（产品 19:32 附加项）：收起态浮标 = decisionStats().pending；抽屉顶部与胶囊 = ownerPendingCounts().decisions；
 *  两函数不互调、前端不聚合。 */
async function refreshOwnerPendingCounts() {
  const anchors = {
    decisions: document.getElementById('decision-box-pill'),
    reviews: document.getElementById('owner-review-count'),
    accepts: document.getElementById('accept-badge'),
  };
  const paint = (node, value) => {
    if (!node) return;
    node.setAttribute('data-count', String(value));
    // PM 授权注记 5a（暂不修并写明理由）：胶囊数字位是圆形窄徽标，直接写「待核验」三个字会撑破；
    // 这里保持「·」占位，并把 aria-label/title 换成「待核验」，另两处（评审/验收角标）仍显示文字。
    const textNode = node.id === 'decision-box-pill' ? node.querySelector('#decision-box-count') : node;
    if (textNode && textNode !== node) {
      if (value === '待核验') {
        textNode.textContent = '·';
        node.setAttribute('aria-label', '决策箱：待核验（数字读取不可用）');
        node.title = '待核验：数字读取不可用（owner:pending-counts 不可用）';
      }
    } else if (textNode) {
      textNode.textContent = value === '待核验' ? '待核验' : String(value);
    }
    // PM 授权注记 5b：数字节点缺失时至少保住 data-count 锚点（AC7 断言只认 data-count），并补 title 说明。
    if (!textNode) node.title = `数字节点缺失（data-count=${String(value)}）`;
  };
  const wb = window.workbench || {};
  if (typeof wb.ownerPendingCounts !== 'function') {
    for (const node of Object.values(anchors)) paint(node, '待核验');
    return { ok: false, code: 'IPC_MISSING' };
  }
  let result = null;
  try {
    const project = activeProject();
    result = await wb.ownerPendingCounts({ projectId: project ? project.id : '' });
  } catch { result = null; }
  if (!result || result.ok === false) {
    for (const node of Object.values(anchors)) paint(node, '待核验');
    return { ok: false, code: (result && result.code) || 'PENDING_COUNTS_FAILED' };
  }
  paint(anchors.decisions, Number(result.decisions || 0));
  DECISION_FLOAT_STATE.decisions = Number(result.decisions || 0);
  paint(anchors.reviews, Number(result.reviews || 0));
  paint(anchors.accepts, Number(result.accepts || 0));
  // R-5016 §二（PM 19:21 约束）：抽屉顶部「待决」也 = ownerPendingCounts().decisions（单源）。
  const drawer = document.getElementById('decision-box-drawer-unread');
  if (drawer) {
    drawer.textContent = `待决 ${Number(result.decisions || 0)}`;
    drawer.setAttribute('data-count', String(Number(result.decisions || 0)));
  }
  return result;
}

function bindDecisionAutoRefresh() {
  if (DECISION_REFRESH.bound) return;
  DECISION_REFRESH.bound = true;
  void refreshOwnerPendingCounts();
  const boxEl = $('#decision-box');
  if (boxEl) boxEl.dataset.autoRefreshBound = '1';
  DECISION_REFRESH.watch = typeof ((window.workbench || {}).onDecisionBoxChanged) === 'function';
  if (boxEl) boxEl.dataset.autoRefreshWatch = DECISION_REFRESH.watch ? '1' : '0';
  const wb = window.workbench || {};
  if (typeof wb.onDecisionBoxChanged === 'function') {
    wb.onDecisionBoxChanged((payload) => {
      decisionRefresh('watch:' + String((payload && payload.reason) || ''));
    });
  }
  const schedule = () => {
    const hidden = document.visibilityState === 'hidden';
    const every = hidden ? 60000 : 15000;
    const boxEl2 = $('#decision-box');
    if (boxEl2) boxEl2.dataset.pollInterval = String(every);
    if (DECISION_REFRESH.timer) clearTimeout(DECISION_REFRESH.timer);
    DECISION_REFRESH.timer = setTimeout(() => {
      DECISION_REFRESH.polls += 1;
      const box = $('#decision-box');
      if (box) box.dataset.pollCount = String(DECISION_REFRESH.polls);
      decisionRefresh('poll');
      schedule();
    }, every);
  };
  document.addEventListener('visibilitychange', schedule);
  schedule();
}

/** R-4657：主进程自动收口/撤回后推 auto:accept-changed，池子开着就立刻重取（不轮询）。 */
const AUTO_ACCEPT_REFRESH = { bound: false };
function bindAutoAcceptRefresh() {
  if (AUTO_ACCEPT_REFRESH.bound) return;
  AUTO_ACCEPT_REFRESH.bound = true;
  const wb = window.workbench || {};
  if (typeof wb.onAutoAcceptChanged !== 'function') return;
  wb.onAutoAcceptChanged((payload) => {
    const mask = $('#pool-mask');
    if (mask) mask.dataset.autoAcceptAt = String((payload && payload.at) || '');
    if (poolUi.open) void refreshPool();
    void refreshPoolBadge();
  });
}

// c65a AC5：未走团队通道告警——元素常驻 DOM，仅按状态切 hidden（无该状态时 hidden=true，不删元素）。
async function refreshChannelWarn() {
  const box = document.querySelector('#team-drawer [data-channel-warn]');
  if (!box) return;
  try {
    if (!window.workbench || typeof window.workbench.channelWarn !== 'function') { box.hidden = true; return; }
    const p = activeProject();
    const res = await window.workbench.channelWarn({ projectId: p ? p.id : '' });
    const warn = Boolean(res && res.ok !== false && res.warn);
    box.hidden = !warn;
    box.setAttribute('data-channel-warn-state', warn ? 'warn' : 'idle');
    if (warn) {
      box.textContent = '⚠ 未走团队通道（六问题之④）：近 10 分钟有子代理活动（' + Number(res.subagentCount || 0) + '）但没有团队消息。开机先 team.mjs send，勿用子代理顶替团队会话。';
      const link = document.createElement('button');
      link.type = 'button';
      link.className = 'link-btn';
      link.setAttribute('data-channel-help', '1');
      link.textContent = '如何用团队通道';
      link.addEventListener('click', () => { try { toast('团队通道：team.mjs send/ack/task（PM 开局首条动作）；详见 README「开局引导」与团队宪法第 2 条', 'ok'); } catch { /* ignore */ } });
      box.appendChild(link);
    }
  } catch { box.hidden = true; }
}

function renderTeam() {
  const summary = $('#team-summary');
  const log = $('#team-log');
  const msgSummary = $('#team-msg-summary');  const p = activeProject();
  renderInbox();
  renderTeamSessions();
  renderRoleQueue();
  loadRoleQueue();
  loadDecisionBox();
  renderTeamWorkspace();
  renderBoardSummary();
  renderReceipts();
  renderLegacyTeamGate();
  renderLogFilter();
  renderVotes();
  loadVotes();
  if (!p) {
    if (summary) summary.textContent = '先新建或恢复一个工作区';
    if (msgSummary) msgSummary.textContent = '';
    if (log) log.innerHTML = '<div class="empty-row">还没有工作区。团队台会显示六角色会话、派单与回执。</div>';
    const select = $('#dispatch-role');
    if (select) select.innerHTML = '';
    const from = $('#dispatch-from');
    if (from) from.innerHTML = '';
    const task = $('#dispatch-task');
    if (task) task.innerHTML = '';
    const pendingBox = $('#dispatch-pending');
    if (pendingBox) pendingBox.innerHTML = '';
    const dispatchResult = $('#dispatch-result');
    if (dispatchResult) { dispatchResult.hidden = true; dispatchResult.innerHTML = ''; }
    const send = $('#dispatch-send');
    if (send) {
      send.disabled = true;
      send.title = '先选择工作区；没有真实 DSH 会话不能派单';
    }
    const hint = $('#dispatch-hint');
    if (hint) { hint.textContent = ''; hint.className = 'dispatch-hint'; }
    startAckTicker(null);
    applyTeamModeCopy(document.body);
    return;
  }
  const ready = sessionReadyCount(p);
  const verified = verifiedCount(p);
  const total = teamRoleCount(p);
  const messages = Array.isArray(p.messages) ? p.messages : [];
  // R-e31b：app:state 只下发最近 50 条（messagesTotal 为真值），计数不能再拿数组长度冒充总数。
  const messagesTotal = Number(p.messagesTotal) > messages.length ? Number(p.messagesTotal) : messages.length;
  const pending = messages.find((m) => m.id === p.pendingAck) || null;
  const unacked = messages.filter((m) => !m.ack && m.ackRequired !== false).length;
  const manual = messages.filter((m) => m.manualAck && !m.ack).length;
  if (summary) {
    const liveText = verified === null ? `${ready}/${total} 会话（本地映射）` : `${verified}/${total} 会话（DSH 已核验）`;
    const mutual = messages.filter((m) => m.from !== 'pm' && m.to !== 'pm').length;
    const toPm = messages.filter((m) => m.to === 'pm').length;
    summary.textContent = `${teamModeLabel(p)} · ${liveText} · ${pending ? 'PM 派单 1 条待回执' : '无 PM 派单锁'}`
      + `${unacked ? ` · 共 ${unacked} 条未回执` : ''}`
      + `${manual ? ` · ${manual} 条人工确认（非角色回执）` : ''}`
      + `${mutual ? ` · 角色互发 ${mutual} 条` : ''}`
      + `${toPm ? ` · 发给 PM ${toPm} 条` : ''}`
      + ` · ${messagesTotal} 条消息${messagesTotal > messages.length ? `（显示最近 ${messages.length} 条）` : ''}`;
  }
  if (msgSummary) msgSummary.textContent = messagesTotal ? `${messagesTotal} 条` : '暂无消息';
  renderTeamLog(p);
  renderDispatch(p);
  startAckTicker(p);
  applyTeamModeCopy(document.body);
}

/* ── 最近回执：只认真实 team:receipts，不拿本机消息冒充 ───── */

function receiptsCaps() {
  return Boolean(window.workbench && typeof window.workbench.teamReceipts === 'function');
}

function receiptProjectNames(project) {
  return [...new Set([
    project && project.name,
    project && project.teamName,
    project && project.workspace && project.workspace.name
  ].filter(Boolean).map(String))];
}

function receiptRawRows(result) {
  const buckets = [
    result,
    result && result.receipts,
    result && result.items,
    result && result.receipts && result.receipts.items,
    result && result.data,
    result && result.data && result.data.receipts,
    result && result.data && result.data.items
  ];
  for (const bucket of buckets) if (Array.isArray(bucket)) return bucket;
  return [];
}

/** 旧看板口径：!update、msgId|from 去重、项目过滤含空 project、按时间倒序。 */
function receiptLedgerRows(result, project) {
  const names = receiptProjectNames(project);
  const source = receiptRawRows(result).filter((row) => row && typeof row === 'object'
    && !row.update
    && String(row.msgId || row.messageId || '').trim()
    && (!row.project || names.includes(String(row.project))));
  const byKey = new Map();
  for (const row of source) {
    byKey.set(`${row.msgId || row.messageId}|${row.from || ''}`, row);
  }
  return [...byKey.values()].sort((a, b) => String(b.ts || b.createdAt || '')
    .localeCompare(String(a.ts || a.createdAt || '')));
}

function receiptActorView(row) {
  const actor = String(row.actor || '').trim();
  const executor = String(row.executor || '').trim();
  const identitySource = String(row.identitySource || '').trim();
  const isManual = row.source === 'manual' || identitySource === 'manual-confirm' || actor === 'workbench-shell/manual';
  const isLocal = row.source === 'local' || row.local === true;
  if (isManual) {
    return {
      actor, executor, identitySource, isManual, isLocal, key: 'manual',
      label: '人工确认（不是角色回执）',
      title: '人工确认只写本机 messages，不写 回执.jsonl，也不释放旧协议派单锁；actor=workbench-shell/manual'
    };
  }
  if (actor === 'workbench-shell') {
    return {
      actor, executor, identitySource, isManual, isLocal, key: isLocal ? 'local' : 'shell',
      label: isLocal ? '壳执行 · 本机降级' : '壳执行 · 旧协议 ack',
      title: isLocal
        ? '旧协议不可用时的本机降级回执；执行者是 workbench-shell，不是角色本人'
        : '工作台壳持收件角色会话身份执行旧协议 ack；actor=workbench-shell，不是角色本人'
    };
  }
  if (!actor || actor === 'pre-existing') {
    return {
      actor, executor, identitySource, isManual, isLocal, key: 'unknown',
      label: '执行者未记录',
      title: '旧回执没有 actor 字段：无法证明是角色自己执行还是壳执行；这里不猜、不补写成角色'
    };
  }
  return {
    actor, executor, identitySource, isManual, isLocal, key: 'role',
    label: '角色执行：' + roleById(actor).name,
    title: '回执行自报 actor=' + actor + '；界面只按字段展示，不额外认领'
  };
}

function receiptMarkup(row) {
  const msgId = String(row.msgId || row.messageId || '');
  const from = roleById(row.from).name;
  const to = row.to ? '→ ' + roleById(row.to).name : '';
  const project = String(row.project || '未写项目');
  const note = String(row.log || row.note || '').trim() || '（无备注）';
  const at = String(row.ts || row.createdAt || '');
  const atLabel = fmtTime(at) || (at ? at.replace('T', ' ').slice(0, 16) : '时间未记录');
  const actorView = receiptActorView(row);
  return `<article class="receipt-row" role="listitem" data-receipt-id="${esc(row.id || msgId)}" data-receipt-msg="${esc(msgId)}" data-receipt-actor="${esc(actorView.actor || '')}" data-receipt-executor="${esc(actorView.executor || '')}">
    <div class="receipt-row-head"><b>${esc(from)}</b>${to ? `<span class="receipt-route">${esc(to)}</span>` : ''}<time title="${esc(at)}">${esc(atLabel)}</time></div>
    <div class="receipt-row-meta"><code title="${esc(msgId)}">${esc(msgId || '无消息 ID')}</code><span class="receipt-project" title="${esc(project)}">${esc(project)}</span></div>
    <div class="receipt-exec" title="${esc(actorView.title)}">
      <span class="receipt-actor ${esc(actorView.key)}">${esc(actorView.label)}</span>
      <span>actor <code>${esc(actorView.actor || '未记录')}</code></span>
      <span>executor <code>${esc(actorView.executor || '未记录')}</code></span>
      <span>身份 <code>${esc(actorView.identitySource || '未记录')}</code></span>
    </div>
    <div class="receipt-note">${esc(note)}</div>
  </article>`;
}

function renderManualAcks(project) {
  const box = $('#team-manual-acks');
  if (!box) return;
  const rows = (project && Array.isArray(project.messages) ? project.messages : [])
    .filter((m) => m.manualAck && !m.ack)
    .slice()
    .sort((a, b) => (Date.parse(b.manualAckAt || 0) || 0) - (Date.parse(a.manualAckAt || 0) || 0));
  box.hidden = !rows.length;
  if (!rows.length) { box.innerHTML = ''; return; }
  box.innerHTML = `<div class="manual-acks-head"><b>人工确认 ${rows.length} 条</b><span>本机 messages，不是 回执.jsonl，也不是角色回执</span></div>
    ${rows.slice(0, 20).map((m) => `<article class="manual-ack-row" data-manual-ack="${esc(m.id)}">
      <div class="manual-ack-top"><b>${esc(roleById(m.from).name)} → ${esc(roleById(m.to).name)}</b><span>${esc(m.subject || '任务派单')}</span><time>${esc(fmtTime(m.manualAckAt) || '时间未记录')}</time></div>
      <div class="manual-ack-meta">actor <code>${esc(m.actor || 'workbench-shell/manual')}</code> · executor <code>${esc(m.executor || 'workbench-shell')}</code> · 未释放旧协议锁</div>
      <div class="manual-ack-note">${esc(m.manualAckNote || '（无备注）')}</div>
    </article>`).join('')}`;
}

function renderReceipts() {
  const list = $('#team-receipts-list');
  if (!list) return;
  const p = activeProject();
  try { refreshChannelWarn().catch(() => {}); } catch { /* 告警不阻断渲染 */ }
  renderManualAcks(p);
  const source = $('#team-receipts-source');
  const summary = $('#team-receipts-summary');
  const note = $('#team-receipts-note');
  const refresh = $('#btn-receipts-refresh');
  const caps = receiptsCaps();
  if (refresh) {
    refresh.disabled = receiptsUi.loading || !caps;
    refresh.textContent = receiptsUi.loading ? '读取中…' : '刷新';
    refresh.title = !caps
      ? '当前 preload 没有 teamReceipts；需要主进程暴露 team:receipts 后才能读取'
      : '重新读取真实 team:receipts（回执.jsonl，只读）';
  }
  if (!p) {
    receiptsUi.projectId = null;
    if (source) { source.textContent = '—'; source.className = 'badge muted-badge'; source.title = '先选择工作区'; }
    if (summary) summary.textContent = '';
    if (note) { note.hidden = true; note.innerHTML = ''; }
    list.innerHTML = '<div class="empty-row">先选择一个工作区。</div>';
    return;
  }
  if (receiptsUi.projectId !== p.id) {
    receiptsUi.projectId = p.id;
    receiptsUi.data = null;
    receiptsUi.error = null;
    receiptsUi.at = 0;
    // 切工作区时团队台可能还开着：按新项目重读一次，避免显示上一个项目的回执。
    if (openDrawerName === 'team' && caps) {
      const wanted = p.id;
      setTimeout(() => {
        if (activeProject() && activeProject().id === wanted) loadReceipts();
      }, 0);
    }
  }
  if (source) {
    if (!caps) {
      source.textContent = '接口缺失';
      source.className = 'badge badge-rejected';
      source.title = 'preload 未暴露 teamReceipts；这里不会用本机消息冒充回执';
    } else if (receiptsUi.loading) {
      source.textContent = '读取中…';
      source.className = 'badge muted-badge';
      source.title = '正在调用 team:receipts';
    } else if (receiptsUi.error) {
      source.textContent = '读取失败';
      source.className = 'badge badge-rejected';
      source.title = receiptsUi.error;
    } else {
      source.textContent = 'team:receipts';
      source.className = 'badge ' + (receiptsUi.data ? 'badge-approved' : 'muted-badge');
      source.title = receiptsUi.data
        ? '真实 team:receipts · ' + String(receiptsUi.data.file || '回执.jsonl') + '（只读）'
        : '等待读取真实 team:receipts';
    }
  }
  if (!caps) {
    receiptsUi.missing = true;
    if (summary) summary.textContent = '当前 preload 没有 team:receipts';
    if (note) {
      note.hidden = false;
      note.className = 'team-receipts-note is-bad';
      note.innerHTML = '<b>接口缺失：team:receipts 未暴露</b>'
        + '当前 preload 没有 <code>teamReceipts</code>，团队台读不到真实 <code>回执.jsonl</code>。'
        + '这里不会用本机 <code>messages</code> 或看板计数冒充回执列表。'
        + '<button type="button" class="ghost small" data-receipts-board>打开团队看板（含旧看板回执表）</button>';
    }
    list.innerHTML = '<div class="empty-row">没有真实 team:receipts，不能列出回执；也没有替身数据。</div>';
    return;
  }
  receiptsUi.missing = false;
  if (receiptsUi.loading) {
    if (summary) summary.textContent = '正在读取真实回执账本…';
    if (note) { note.hidden = true; note.innerHTML = ''; }
    list.innerHTML = '<div class="empty-row">读取中…</div>';
    return;
  }
  if (receiptsUi.error) {
    if (summary) summary.textContent = '';
    if (note) {
      note.hidden = false;
      note.className = 'team-receipts-note is-bad';
      note.innerHTML = `<b>team:receipts 读取失败</b>${esc(receiptsUi.error)}；没有回退成本机消息或看板计数。`;
    }
    list.innerHTML = '<div class="empty-row">回执列表读取失败；可点右上角「刷新」重试。</div>';
    return;
  }
  if (!receiptsUi.data) {
    if (summary) summary.textContent = '尚未读取';
    if (note) { note.hidden = true; note.innerHTML = ''; }
    list.innerHTML = '<div class="empty-row">点「刷新」读取当前项目的真实回执。</div>';
    return;
  }
  const all = receiptLedgerRows(receiptsUi.data, p);
  const rows = all.slice(0, 50);
  const noReceipts = receiptsUi.data && receiptsUi.data.code === 'NO_RECEIPTS';
  if (note) { note.hidden = true; note.innerHTML = ''; }
  if (summary) {
    summary.textContent = `最近 ${rows.length} 条${all.length > rows.length ? ` / 去重后 ${all.length} 条` : ''}`
      + ` · ${p.name}${receiptsUi.at ? ' · 读取于 ' + fmtTime(new Date(receiptsUi.at).toISOString()) : ''}`;
  }
  list.innerHTML = rows.length
    ? rows.map(receiptMarkup).join('')
    : `<div class="empty-row">${noReceipts ? '回执账本还不存在（还没有旧协议回执）。' : '当前项目还没有回执。接口是真的，只是账本为空。'}</div>`;
}

async function loadReceipts(opts = {}) {
  const p = activeProject();
  if (!p) { renderReceipts(); return null; }
  if (!receiptsCaps()) {
    receiptsUi.projectId = p.id;
    receiptsUi.missing = true;
    receiptsUi.loading = false;
    receiptsUi.data = null;
    receiptsUi.error = null;
    renderReceipts();
    return null;
  }
  if (receiptsUi.projectId !== p.id) {
    receiptsUi.projectId = p.id;
    receiptsUi.data = null;
    receiptsUi.error = null;
    receiptsUi.at = 0;
  }
  if (!opts.force && receiptsUi.data && Date.now() - receiptsUi.at < 15000) {
    renderReceipts();
    return receiptsUi.data;
  }
  if (receiptsUi.loading) return null;
  const projectId = p.id;
  receiptsUi.loading = true;
  receiptsUi.error = null;
  renderReceipts();
  try {
    const result = await window.workbench.teamReceipts({
      projectId,
      project: p.teamName || p.name,
      includeUnassigned: false,
      limit: 50
    });
    if (receiptsUi.projectId !== projectId) return null;
    if (result && result.ok === false) {
      throw new Error(result.message || result.why || result.code || 'team:receipts 读取失败');
    }
    receiptsUi.data = result || { receipts: [] };
    receiptsUi.at = Date.now();
    receiptsUi.missing = false;
    return result;
  } catch (e) {
    if (receiptsUi.projectId === projectId) {
      receiptsUi.data = null;
      receiptsUi.error = humanError(e.message);
    }
    return null;
  } finally {
    receiptsUi.loading = false;
    if (receiptsUi.projectId === projectId) {
      renderReceipts();
      // 回执账本到了以后刷新每个角色卡的“最近回执”，避免只显示 messages 里的旧结果。
      renderTeamSessions();
      renderRoles();
      renderLegacyTeamGate();
    }
  }
}


function renderTeamWorkspace() {
  const box = $('#team-workspace');
  const badge = $('#team-ws-badge');
  if (!box) return;
  const p = activeProject();
  if (!p) {
    if (badge) { badge.textContent = '—'; badge.className = 'badge'; }
    box.innerHTML = '<div class="empty-row">还没有工作区。</div>';
    return;
  }
  const ws = p.workspace || {};
  const live = liveFor(p);
  const verified = verifiedCount(p);
  const ready = sessionReadyCount(p);
  const total = teamRoleCount(p);
  const teamName = ws.name || p.teamName || '';
  const rows = [];
  const row = (key, value, cls = '', mono = false) => rows.push(
    `<div class="team-workspace-row"><span>${esc(key)}</span>${mono ? `<code class="${cls}" title="${esc(value)}">${esc(value)}</code>` : `<b class="${cls}" title="${esc(value)}">${esc(value)}</b>`}</div>`
  );
  row('项目', p.name);
  row('团队', teamName || '未登记', teamName ? '' : 'warn');
  row('团队模式', teamModeDef(p).label + (isQuickTeam(p) ? ' · 4 人视图' : ''), isQuickTeam(p) ? 'warn' : '');
  row('DSH 工作区', ws.id ? String(ws.id) : (ws.pending ? '待重试绑定' : '未绑定'), ws.id ? '' : 'bad', true);
  row('工作区目录', ws.path || p.path, '', true);
  if (live && live.workspace && live.workspace.id && ws.id && String(live.workspace.id) !== String(ws.id)) {
    row('核验结果', 'DSH 返回 ' + live.workspace.id + '，与本机记录不一致', 'bad', true);
  }
  if (ws.lastError && ws.lastError.code) row('绑定错误', `${ws.lastError.code}${ws.lastError.message ? ' · ' + ws.lastError.message : ''}`, 'bad');
  row('当前团队角色', verified === null ? `${ready}/${total} 本地映射（待 DSH 核验）` : `${verified}/${total} 已核验`, verified === null ? 'warn' : (verified >= total ? 'ok' : 'bad'));
  // e29f F-4：额外会话数字只由侧栏统计那一处显示（同一套口径、同一个数），团队台不再另报一份。
  const cur = wsUi.data && wsUi.data.currentWorkspace;
  if (cur && (cur.name || cur.project)) {
    const curName = String(cur.name || cur.project);
    const mine = String(teamName || p.name);
    row('DSH 当前', curName + (curName === mine ? '（本项目）' : '（不是本项目）'), curName === mine ? '' : 'warn');
  }
  if (badge) {
    badge.textContent = ws.id ? (ws.pending ? '待重试' : '已绑定') : '未绑定';
    badge.className = 'badge' + (ws.id && !ws.pending ? ' badge-approved' : (ws.pending ? ' badge-skipped' : ' badge-rejected'));
  }
  const modeBadge = $('#team-mode-badge');
  if (modeBadge) {
    modeBadge.textContent = teamModeLabel(p);
    modeBadge.className = 'badge' + (isQuickTeam(p) ? ' badge-skipped' : '');
    modeBadge.title = isQuickTeam(p)
      ? '快速团队：只显示 PM / 需求分析师 / 程序员A / 测试人员；产品设计师与高级程序员B 隐藏'
      : '完整团队：六个角色都显示';
  }
  box.innerHTML = rows.join('');
}

function boardCount(source, key) {
  if (!source) return null;
  const value = source[key];
  if (Array.isArray(value)) return value.length;
  if (Number.isFinite(Number(value))) return Number(value);
  return null;
}

function boardMatchesProject(board, project) {
  if (!board || !project) return false;
  const names = [project.name, project.teamName, (project.workspace && project.workspace.name)]
    .filter(Boolean).map(String);
  const boardName = String(board.name || board.project || '');
  return Boolean(boardName && names.includes(boardName));
}

function boardCountsMarkup(counts) {
  const nums = [
    ['需求', counts.requirements], ['任务', counts.tasks],
    ['回执', counts.receipts]
  ];
  if (!nums.some(([, n]) => n !== null)) return '';
  return `<div class="team-board-nums">${nums.map(([label, n]) => `<div class="board-num"><b>${n === null ? '—' : n}</b><span>${label}</span></div>`).join('')}</div>`;
}

/** 团队台摘要：当前项目看板优先；team:status 的全局最后一份看板不冒充当前项目。 */
function renderBoardSummary() {
  const box = $('#team-board-summary');
  const stateEl = $('#team-board-state');
  if (!box) return;
  const p = activeProject();
  if (!p) {
    if (stateEl) stateEl.textContent = '未选择';
    box.innerHTML = '<span class="muted">先选择一个工作区。</span>';
    return;
  }
  const info = state && state.team ? state.team : null;
  if (!info) {
    if (stateEl) stateEl.textContent = '未知';
    box.innerHTML = '<span class="muted">读不到团队状态。</span>';
    return;
  }
  if (info.toolExists === false) {
    if (stateEl) stateEl.textContent = '团队工具缺失';
    box.innerHTML = '<span class="muted">团队工具不可用：旧看板、派单与回执会降级为本机记录。</span>';
    return;
  }
  const own = boardUi.data && (boardUi.subjectId === p.id
    || boardUi.subjectName === p.name
    || boardUi.subjectName === (p.teamName || '')) ? boardUi.data : null;
  const globalBoard = teamStatusUi.data ? teamStatusUi.data.board : null;
  const globalMatches = boardMatchesProject(globalBoard, p);
  const globalName = String((globalBoard && (globalBoard.name || globalBoard.project)) || '');
  const subjectIsCurrent = boardUi.subjectId === p.id
    || boardUi.subjectName === p.name
    || boardUi.subjectName === (p.teamName || '');
  if (boardUi.loading && subjectIsCurrent) {
    if (stateEl) stateEl.textContent = '生成中…';
    box.innerHTML = `<span class="muted">正在按「${esc(boardUi.subjectName || p.name)}」生成看板；生成后这里显示当前项目计数。</span>`;
    return;
  }
  if (boardUi.error && subjectIsCurrent) {
    if (stateEl) stateEl.textContent = '生成失败';
    box.innerHTML = `<span class="bad">看板生成失败：${esc(boardUi.error)}</span>`;
    return;
  }
  if (!own && globalBoard && !globalMatches) {
    if (stateEl) stateEl.textContent = '旧项目看板';
    box.innerHTML = `<span class="muted">team:status 里最后一份看板属于「${esc(globalName || '未知项目')}」，不是当前项目「${esc(p.name)}」。点「打开看板浮窗」或「刷新摘要」会按当前项目重新生成。</span>`;
    return;
  }
  if (!own && !info.boardExists && !globalBoard) {
    if (stateEl) stateEl.textContent = '未生成';
    box.innerHTML = '<span class="muted">还没有生成当前项目的看板；点「打开看板浮窗」会先按当前项目生成一次。</span>';
    return;
  }
  const source = own ? (own.summary || own) : globalBoard;
  const counts = {
    requirements: boardCount(source, 'requirements'),
    tasks: boardCount(source, 'tasks'),
    commits: boardCount(source, 'commits'),
    receipts: boardCount(source, 'receipts'),
    files: boardCount(source, 'files')
  };
  const generatedAt = (own && own.generatedAt) || (globalBoard && globalBoard.generatedAt) || info.boardGeneratedAt || null;
  if (stateEl) stateEl.textContent = own ? '当前项目' : (globalMatches ? '团队状态' : '已生成');
  box.innerHTML = boardCountsMarkup(counts)
    + `<span class="muted">${own ? '计数来自当前项目 team:board（不看 team:status 的全局最后一份）' : '计数来自 team:status；与当前项目同名才显示'}`
    + `${generatedAt ? ' · 生成于 ' + esc(fmtTime(generatedAt)) : ''}`
    + `${own && own.warning ? ' · 告警：' + esc(own.warning.message || own.warning.code || '') : ''}</span>`;
}

/* ── 内嵌团队看板浮窗：打开 / 刷新 / 关闭 / 折叠 / 切看板项目 ── */

function boardSubjectValue() {
  if (boardUi.subjectId) return 'id:' + boardUi.subjectId;
  if (boardUi.subjectName) return 'name:' + boardUi.subjectName;
  return '';
}

function boardPanelMetaHtml(p) {
  if (boardUi.loading) return `<span class="muted">正在按「${esc(boardUi.subjectName || p.name)}」生成看板…</span>`;
  if (boardUi.error) return `<span class="bad">看板生成失败：${esc(boardUi.error)}</span>`;
  if (!boardUi.data) {
    return '<span class="muted">点「刷新」按当前看板项目生成；切项目只切换看板查看，不改工作台当前工作区。</span>';
  }
  const data = boardUi.data;
  const summary = data.summary || {};
  const counts = {
    requirements: boardCount(summary, 'requirements'),
    tasks: boardCount(summary, 'tasks'),
    commits: boardCount(summary, 'commits'),
    receipts: boardCount(summary, 'receipts'),
    files: boardCount(summary, 'files')
  };
  const name = data.name || data.project || boardUi.subjectName || p.name;
  const differs = p && name && name !== p.name && name !== (p.teamName || '');
  return boardCountsMarkup(counts)
    + `<span class="muted">看板项目：<b>${esc(name)}</b>`
    + `${data.generatedAt ? ' · 生成于 ' + esc(fmtTime(data.generatedAt)) : ''}`
    + `${differs ? ` · 只读切换，工作台当前仍是「${esc(p.name)}」` : ''}`
    + `${data.warning ? ' · 告警：' + esc(data.warning.message || data.warning.code || '') : ''}</span>`;
}

/** 看板浮窗的 Owner 警告：待决定 / 已打回 / 看板项目与当前工作区不一致。 */
function boardOwnerNotice(project) {
  if (!project) return null;
  const os = ownerState(project);
  const parts = [];
  let cls = 'warn';
  if (os.pending) {
    cls = 'bad';
    parts.push('<b>Owner 待决定</b>：当前流程停在 Owner，还没有通过 / 打回 / 跳过，Owner 评审不会自动弹窗。');
  } else if (os.status === 'rejected') {
    cls = 'bad';
    parts.push(`<b>Owner 已打回</b>：${esc(os.opinion || '没有写意见')}${os.at ? ` · ${esc(fmtTime(os.at))}` : ''}`);
  }
  const subject = boardUi.subjectName || '';
  const differs = Boolean(subject && subject !== project.name && subject !== (project.teamName || ''));
  if (differs) {
    parts.push(`看板项目「${esc(subject)}」不是当前工作区「${esc(project.name)}」；Owner 状态按当前工作区显示。`);
  }
  if (!parts.length) return null;
  const action = os.pending || os.status === 'rejected'
    ? '<button type="button" class="ghost small" data-board-owner>打开 Owner 评审</button>'
    : '';
  return { cls, html: `<span class="board-owner-text">${parts.join(' ')}</span>${action}` };
}

function renderBoardPanel() {
  const panel = $('#board-panel');
  if (!panel) return;
  const p = activeProject();
  if (boardUi.open && p) {
    const prevProjectId = boardUi.currentProjectId;
    if (!boardUi.subjectName) {
      boardUi.subjectId = p.id;
      boardUi.subjectName = p.name;
    } else if (prevProjectId && prevProjectId !== p.id && boardUi.subjectId === prevProjectId) {
      // 原来跟着上一个当前项目，切工作区后跟到新的当前项目；手动选的其他看板项目不强行切回。
      boardUi.subjectId = p.id;
      boardUi.subjectName = p.name;
      boardUi.data = null;
      boardUi.framePath = '';
      boardUi.error = null;
      boardUi.embedError = null;
    }
    boardUi.currentProjectId = p.id;
  }
  const select = $('#board-panel-project');
  if (select) {
    const options = [];
    const knownNames = new Set();
    for (const item of state?.projects || []) {
      options.push({ value: 'id:' + item.id, label: item.name });
      knownNames.add(item.name);
      if (item.teamName) knownNames.add(String(item.teamName));
    }
    for (const item of (wsUi.data && Array.isArray(wsUi.data.projects) ? wsUi.data.projects : [])) {
      const name = String(item.name || '').trim();
      if (!name || knownNames.has(name)) continue;
      knownNames.add(name);
      options.push({ value: 'name:' + name, label: name + '（团队 / DSH）' });
    }
    if (boardUi.subjectName && !boardUi.subjectId && !knownNames.has(boardUi.subjectName)) {
      options.push({ value: 'name:' + boardUi.subjectName, label: boardUi.subjectName + '（团队登记）' });
    }
    const key = options.map((item) => item.value + '|' + item.label).join('||');
    if (select.dataset.key !== key) {
      select.innerHTML = options.length
        ? options.map((item) => `<option value="${esc(item.value)}">${esc(item.label)}</option>`).join('')
        : '<option value="">没有工作区</option>';
      select.dataset.key = key;
    }
    const value = boardSubjectValue();
    if (value && Array.from(select.options).some((opt) => opt.value === value)) select.value = value;
  }
  const subject = $('#board-panel-subject');
  if (subject) subject.textContent = boardUi.subjectName || (p ? p.name : '—');
  const badge = $('#board-panel-badge');
  if (badge) {
    badge.textContent = boardUi.loading ? '生成中…' : (boardUi.error ? '失败' : (boardUi.data ? '已生成' : '未加载'));
    badge.className = 'badge ' + (boardUi.error ? 'badge-rejected' : (boardUi.data ? 'badge-approved' : 'muted-badge'));
    badge.title = boardUi.error || '';
  }
  const meta = $('#board-panel-meta');
  if (meta) {
    meta.innerHTML = boardPanelMetaHtml(p || { name: '—' })
      + (boardUi.embedError
        ? `<div class="board-panel-embed-warn">内嵌脚本受限：${esc(boardUi.embedError)}；外层折叠 / 放大 / 切项目 / 刷新 / 关闭仍可用。</div>`
        : '');
  }
  const ownerBox = $('#board-panel-owner');
  if (ownerBox) {
    const notice = boardOwnerNotice(p);
    ownerBox.hidden = !notice;
    ownerBox.className = 'board-panel-owner' + (notice ? ' ' + notice.cls : '');
    ownerBox.innerHTML = notice ? notice.html : '';
  }
  const body = $('#board-panel-body');
  if (body) body.hidden = boardUi.collapsed;
  const collapse = $('#board-panel-collapse');
  if (collapse) {
    collapse.textContent = boardUi.collapsed ? '展开' : '折叠';
    collapse.setAttribute('aria-expanded', String(!boardUi.collapsed));
    collapse.title = boardUi.collapsed ? '展开看板内容（保留标题栏与刷新/切项目/关闭）' : '折叠看板内容，只留标题栏';
  }
  const maxBtn = $('#board-panel-max');
  if (maxBtn) {
    maxBtn.textContent = boardUi.maximized ? '还原' : '放大';
    maxBtn.setAttribute('aria-pressed', String(boardUi.maximized));
    maxBtn.title = boardUi.maximized ? '还原看板浮窗大小' : '放大看板浮窗（再点还原）';
  }
  const refreshBtn = $('#board-panel-refresh');
  if (refreshBtn) {
    refreshBtn.disabled = boardUi.loading;
    refreshBtn.textContent = boardUi.loading ? '生成中…' : '刷新';
    refreshBtn.title = boardUi.loading ? '正在按当前看板项目生成看板' : '按当前看板项目重新生成看板';
  }
  const viewBtn = $('#board-panel-view');
  if (viewBtn) viewBtn.disabled = !select || !select.value;
  panel.classList.toggle('is-collapsed', boardUi.collapsed);
  panel.classList.toggle('is-max', boardUi.maximized);
  const frame = $('#board-panel-frame');
  const empty = $('#board-panel-empty');
  if (frame) {
    frame.hidden = !boardUi.framePath;
    frame.style.zoom = String(boardUi.zoom || 1);
  }
  if (empty) {
    empty.hidden = Boolean(boardUi.framePath);
    empty.textContent = !p ? '先选择一个工作区。'
      : (boardUi.error ? '看板读取失败；可点「刷新」重试，或打开独立浮窗。' : '打开后读取当前项目的团队看板。');
  }
  const openBtn = $('#board-panel-open');
  if (openBtn) {
    openBtn.disabled = !boardUi.subjectId;
    openBtn.title = boardUi.subjectId
      ? '打开当前看板项目的独立 BrowserWindow'
      : '这个看板项目还没登记到本机；先在恢复 / 工作区清单登记';
  }
  const note = $('#board-panel-note');
  if (note) {
    const pName = p ? p.name : '';
    const differs = Boolean(p && boardUi.subjectName && boardUi.subjectName !== pName && boardUi.subjectName !== (p.teamName || ''));
    note.textContent = differs
      ? `正在查看「${boardUi.subjectName}」的看板；工作台当前仍是「${pName}」，切工作区请用左上角工作区。`
      : '内嵌只读看板；切项目只切换看板查看，不改工作台当前工作区；独立窗口用其自身按钮关闭/折叠。';
  }
}

function loadBoardFrame(boardPath) {
  const frame = $('#board-panel-frame');
  if (!frame) return;
  if (!boardPath) {
    frame.hidden = true;
    frame.removeAttribute('src');
    return;
  }
  const url = absFileUrl(boardPath) + '?v=' + Date.now() + '&theme=' + currentTheme() + '&style=' + String(currentThemeId()).split('-')[0];
  boardUi.embedError = null;
  frame.hidden = false;
  frame.dataset.boardUrl = url;
  frame.src = url;
  const empty = $('#board-panel-empty');
  if (empty) empty.hidden = true;
}

function boardPanelCounts(data) {
  const summary = (data && data.summary) || data || {};
  return {
    requirements: boardCount(summary, 'requirements'),
    tasks: boardCount(summary, 'tasks'),
    commits: boardCount(summary, 'commits'),
    receipts: boardCount(summary, 'receipts'),
    files: boardCount(summary, 'files')
  };
}

async function loadBoardPanel(opts = {}) {
  const p = activeProject();
  if (!p) { toast('先选择工作区', 'bad'); return null; }
  if (boardUi.loading) return null;
  const subjectName = String(opts.subjectName || boardUi.subjectName || p.name).trim() || p.name;
  if (!opts.force && boardUi.data && boardUi.subjectName === subjectName && Date.now() - boardUi.at < 15000) {
    renderBoardPanel();
    return boardUi.data;
  }
  const local = (state.projects || []).find((item) => item.name === subjectName || item.teamName === subjectName);
  boardUi.currentProjectId = p.id;
  boardUi.subjectName = local ? local.name : subjectName;
  boardUi.subjectId = local ? local.id : null;
  boardUi.loading = true;
  boardUi.error = null;
  renderBoardPanel();
  try {
    if (typeof window.workbench.teamBoard !== 'function') throw new Error('当前 preload 没有 team:board');
    const payload = local ? { projectId: local.id, open: false } : { project: subjectName, open: false };
    const result = await window.workbench.teamBoard(payload);
    if (!result || !result.ok) {
      throw new Error((result && (result.message || result.why || result.code)) || '看板生成失败');
    }
    boardUi.data = result;
    boardUi.at = Date.now();
    boardUi.subjectName = String(result.name || result.project || subjectName);
    boardUi.subjectId = local ? local.id : null;
    boardUi.framePath = String(result.boardPath || '');
    boardUi.error = null;
    boardUi.embedError = null;
    renderBoardPanel();
    renderBoardSummary();
    if (boardUi.open) loadBoardFrame(result.boardPath);
    return result;
  } catch (e) {
    boardUi.data = null;
    boardUi.framePath = '';
    boardUi.embedError = null;
    boardUi.error = humanError(e.message);
    renderBoardPanel();
    renderBoardSummary();
    return null;
  } finally {
    boardUi.loading = false;
    renderBoardPanel();
  }
}

async function boardSwitchSubject(value) {
  const raw = String(value || '').trim();
  if (!raw) return false;
  let name = raw;
  let local = null;
  if (raw.startsWith('id:')) {
    local = (state.projects || []).find((item) => item.id === raw.slice(3)) || null;
    name = local ? local.name : '';
  } else if (raw.startsWith('name:')) {
    name = raw.slice(5);
    local = (state.projects || []).find((item) => item.name === name || item.teamName === name) || null;
  } else {
    local = (state.projects || []).find((item) => item.name === raw || item.teamName === raw) || null;
  }
  if (!name && !local) {
    toast('项目名不能为空', 'bad');
    return false;
  }
  boardUi.subjectId = local ? local.id : null;
  boardUi.subjectName = local ? local.name : name;
  boardUi.data = null;
  boardUi.framePath = '';
  boardUi.error = null;
  boardUi.embedError = null;
  renderBoardPanel();
  const result = await loadBoardPanel({ force: true, subjectName: boardUi.subjectName });
  return Boolean(result);
}

function setBoardCollapsed(collapsed) {
  boardUi.collapsed = Boolean(collapsed);
  renderBoardPanel();
}

function toggleBoardCollapsed() {
  setBoardCollapsed(!boardUi.collapsed);
}

function toggleBoardMaximized() {
  boardUi.maximized = !boardUi.maximized;
  const panel = $('#board-panel');
  if (panel && boardUi.maximized) {
    panel.style.left = '';
    panel.style.top = '';
    panel.style.right = '';
    panel.style.bottom = '';
  }
  renderBoardPanel();
  clampBoardPanel();
}

function setBoardZoom(value) {
  boardUi.zoom = Math.max(0.8, Math.min(1.4, Number(value) || 1));
  renderBoardPanel();
}

async function readBoardFileForEmbed(absPath) {
  const abs = String(absPath || '').trim();
  if (!abs) return { ok: false, why: '空路径' };
  const ext = fileExt(abs);
  const url = absFileUrl(abs);
  try {
    if (FILE_IMAGE_EXT.has(ext)) {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const blob = await res.blob();
      if (blob.size > 8 * 1024 * 1024) throw new Error('图片超过 8 MB，请用系统程序打开');
      const dataUrl = await new Promise((resolve, reject) => {
        const reader = new FileReader();
        reader.onload = () => resolve(String(reader.result || ''));
        reader.onerror = () => reject(reader.error || new Error('图片读取失败'));
        reader.readAsDataURL(blob);
      });
      return { ok: true, kind: 'image', dataUrl };
    }
    if (FILE_MD_EXT.has(ext) || FILE_TEXT_EXT.has(ext)) {
      const res = await fetch(url);
      if (!res.ok) throw new Error('HTTP ' + res.status);
      const text = await res.text();
      if (text.length > 4 * 1024 * 1024) throw new Error('文本超过 4 MB，请用系统程序打开');
      return { ok: true, kind: 'text', text };
    }
    return { ok: false, why: '内嵌看板只预览文本/图片；请到工作台文件页用系统程序打开' };
  } catch (e) {
    return { ok: false, why: humanError(e.message) };
  }
}

/** 只给内嵌看板页面注入的 window.boardWin 兼容层；不伪造 IPC，文件读取走真实 file:///文件页。 */
function createBoardShim() {
  return {
    control(action) {
      const act = String(action || '');
      if (act === 'close') { setBoardPanelOpen(false); return { ok: true }; }
      if (act === 'collapse') { setBoardCollapsed(true); return { ok: true }; }
      if (act === 'expand') { setBoardCollapsed(false); return { ok: true }; }
      if (act === 'maximize') { toggleBoardMaximized(); return { ok: true }; }
      if (act === 'zoom-in') { setBoardZoom(boardUi.zoom + 0.1); return { ok: true }; }
      if (act === 'zoom-out') { setBoardZoom(boardUi.zoom - 0.1); return { ok: true }; }
      return { ok: false, why: 'unsupported' };
    },
    async selectProject(name) {
      const ok = await boardSwitchSubject(String(name || ''));
      return { ok: Boolean(ok) };
    },
    async refresh() {
      const r = await loadBoardPanel({ force: true });
      return { ok: Boolean(r) };
    },
    async openFile(absPath) {
      return readBoardFileForEmbed(absPath);
    }
  };
}

function onBoardFrameLoad() {
  const frame = $('#board-panel-frame');
  if (!frame || !frame.getAttribute('src') || frame.getAttribute('src') === 'about:blank') return;
  try {
    const doc = frame.contentDocument;
    const win = frame.contentWindow;
    if (!doc || !win) throw new Error('无法访问看板文档（file:// 跨域）');
    let style = doc.getElementById('awb-board-embed-style');
    if (!style) {
      style = doc.createElement('style');
      style.id = 'awb-board-embed-style';
      doc.head.appendChild(style);
    }
    style.textContent = [
      '.board-chrome{display:none!important}',
      // 保留看板自己的深色底；只去掉为旧窗口标题栏预留的 padding-top。
      'body{overflow:auto!important;padding-top:0!important}',
      '.board-content{padding-bottom:10px}',
      'header{padding:16px 18px 12px!important}',
      '.cards{padding:0 18px 14px!important;grid-template-columns:repeat(auto-fit,minmax(120px,1fr))!important}',
      'section{margin:0 18px 14px!important;padding:14px!important}',
      'footer{padding:0 18px 16px!important}',
      'table{font-size:11px!important}',
      'th,td{padding:6px 7px!important}'
    ].join('\n');
    const hint = doc.querySelector('.header-hint');
    if (hint) hint.textContent = '切项目只切换看板查看，不改工作台当前工作区';
    win.boardWin = createBoardShim();
    boardUi.embedError = null;
  } catch (e) {
    // 看板本身已经加载出来了；只是 file:// 跨文档脚本注入被拒。不能把整块看板标成“失败”。
    boardUi.embedError = humanError(e.message);
    renderBoardPanel();
  }
}

function setBoardPanelOpen(open) {
  const panel = $('#board-panel');
  if (!panel) return;
  const p = activeProject();
  if (open && !p) { toast('先选择工作区', 'bad'); return; }
  boardUi.open = Boolean(open);
  panel.hidden = !boardUi.open;
  const launcher = $('#board-launcher');
  if (launcher) {
    launcher.setAttribute('aria-expanded', String(boardUi.open));
    launcher.classList.toggle('is-open', boardUi.open);
  }
  if (!boardUi.open) {
    renderBoardPanel();
    return;
  }
  const prevProjectId = boardUi.currentProjectId;
  if (!boardUi.subjectName || (prevProjectId && prevProjectId !== p.id && boardUi.subjectId === prevProjectId)) {
    boardUi.subjectId = p.id;
    boardUi.subjectName = p.name;
    boardUi.data = null;
    boardUi.framePath = '';
    boardUi.error = null;
    boardUi.embedError = null;
  }
  boardUi.currentProjectId = p.id;
  renderBoardPanel();
  loadBoardPanel();
  loadWorkspaces();
  if (boardUi.framePath) {
    const frame = $('#board-panel-frame');
    if (frame && (!frame.getAttribute('src') || frame.getAttribute('src') === 'about:blank' || frame.hidden)) {
      loadBoardFrame(boardUi.framePath);
    }
  }
  clampBoardPanel();
}

function openBoardPanel() {
  setBoardPanelOpen(true);
}

function closeBoardPanel() {
  setBoardPanelOpen(false);
}

function toggleBoardPanel() {
  setBoardPanelOpen(!boardUi.open);
}

function bindBoardPanelDrag() {
  const panel = $('#board-panel');
  const head = $('#board-panel-head');
  if (!panel || !head) return;
  let drag = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button, select, input, a')) return;
    const r = panel.getBoundingClientRect();
    drag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
    panel.classList.add('dragging');
    try { head.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = panel.getBoundingClientRect();
    const left = Math.max(6, Math.min(window.innerWidth - r.width - 6, drag.left + e.clientX - drag.x));
    const top = Math.max(6, Math.min(window.innerHeight - r.height - 6, drag.top + e.clientY - drag.y));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  });
  const stop = () => { drag = null; panel.classList.remove('dragging'); };
  head.addEventListener('pointerup', stop);
  head.addEventListener('pointercancel', stop);
}

function clampBoardPanel() {
  const panel = $('#board-panel');
  if (!panel || panel.hidden || !panel.style.left) return;
  const r = panel.getBoundingClientRect();
  panel.style.left = Math.max(6, Math.min(window.innerWidth - r.width - 6, r.left)) + 'px';
  panel.style.top = Math.max(6, Math.min(window.innerHeight - r.height - 6, r.top)) + 'px';
}

function renderLogFilter() {
  const sel = $('#team-log-filter');
  if (!sel) return;
  const roles = teamRoles(activeProject());
  const key = 'all,pending,' + roles.map((r) => r.id).join(',');
  if (sel.dataset.built !== key) {
    sel.innerHTML = '<option value="all">全部消息</option><option value="pending">只看待回执</option>'
      + roles.map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('');
    sel.dataset.built = key;
  }
  if (!sel.value) sel.value = 'all';
}

function renderTeamLog(p) {
  const box = $('#team-log');
  if (!box || !p) return;
  if (msgUi.projectId !== p.id) { msgUi.projectId = p.id; msgUi.extra = []; msgUi.limit = 30; }
  const allMessages = msgUi.extra.length
    ? msgUi.extra.concat(Array.isArray(p?.messages) ? p.messages : [])
    : (Array.isArray(p?.messages) ? p.messages.slice() : []);
  const visible = new Set(teamRoleIds(p));
  const all = isQuickTeam(p)
    ? allMessages.filter((m) => visible.has(String(m.from || '')) && visible.has(String(m.to || '')))
    : allMessages;
  const filter = ($('#team-log-filter') || {}).value || 'all';
  const messages = all.slice().reverse().filter((m) => {
    if (filter === 'all') return true;
    if (filter === 'pending') return !m.ack && m.ackRequired !== false;
    return m.from === filter || m.to === filter;
  });
  if (!messages.length) {
    box.innerHTML = all.length
      ? '<div class="empty-row">这个筛选下没有消息；切回「全部消息」。</div>'
      : '<div class="empty-row">还没有团队消息。派单后会记录在这里；每次派单只保留一个待回执。</div>';
    return;
  }
  const remain = ackRemainMs(p);
  const ackBlocked = Boolean(p.pendingAck);
  box.innerHTML = messages.slice(0, msgUi.limit).map((m) => {
    const pending = m.id === p.pendingAck;
    const from = roleById(m.from);
    const to = roleById(m.to);
    const noSession = !(p.sessions && p.sessions[m.to]);
    const blockedByOther = ackBlocked && !pending;
    const routeKind = m.from === 'pm' ? 'PM 派单' : (m.to === 'pm' ? '角色 → PM' : '角色互发');
    const src = String(m.source || (m.degraded ? 'local' : ''));
    const ackSrc = String(m.ackSource || '');
    const tags = [];
    tags.push(`<span class="msg-tag route">${esc(routeKind)}</span>`);
    tags.push(src
      ? `<span class="msg-tag ${src === 'team' ? 'team' : 'local'}">来源 ${esc(sourceLabel(src) || src)}</span>`
      : '<span class="msg-tag">来源 未记录</span>');
    if (m.ack) {
      tags.push(`<span class="msg-tag ${ackSrc === 'team' ? 'team' : 'local'}">回执来源 ${esc(sourceLabel(ackSrc) || ackSrc || '未记录')}</span>`);
      tags.push(`<span class="msg-tag">actor ${esc(m.actor || '未记录')}</span>`);
    } else if (m.manualAck) {
      tags.push('<span class="msg-tag warn">人工确认（非角色回执，未释放锁）</span>');
    }
    if (m.ackRequired === false) tags.push('<span class="msg-tag">无需回执</span>');
    else if (!m.ack && !m.manualAck) tags.push('<span class="msg-tag ttl' + (pending && remain !== null && remain <= 0 ? ' expired' : '') + '">待回执</span>');
    if (noSession) tags.push('<span class="msg-tag warn">收件角色无 DSH 会话</span>');
    if (pending && remain !== null) {
      tags.push(`<span class="msg-tag ttl${remain <= 0 ? ' expired' : ''}" data-ack-ttl="1">${remain <= 0 ? '已超时' : '剩余 ' + fmtRemain(remain)}</span>`);
    }
    if (m.taskId) tags.push(`<span class="msg-tag">任务 ${esc(m.taskId)}</span>`);
    const ackText = m.ack
      ? `已回执 · ${esc(sourceLabel(ackSrc) || ackSrc || '来源未记录')} · actor=${esc(m.actor || '未记录')}${m.executor ? ' · executor=' + esc(m.executor) : ''}${m.ackNote ? ' · ' + esc(m.ackNote) : ''}${m.ackAt ? ' · ' + esc(fmtTime(m.ackAt)) : ''}`
      : (m.manualAck
        ? `人工确认（不是角色会话回执，旧协议锁未释放） · actor=${esc(m.actor || 'workbench-shell/manual')}${m.manualAckNote ? ' · ' + esc(m.manualAckNote) : ''}`
        : (pending ? '待回执（回执后释放派单锁）' : (m.ackRequired === false ? '无需回执' : '未回执')));
    return `<article class="team-msg ${pending ? 'pending' : ''}" title="消息 ${esc(m.id || '')} · ${esc(from.name)} → ${esc(to.name)}">
      <div class="team-msg-head">
        <span class="msg-route"><b>${esc(from.name)}</b><span class="arrow">→</span><b>${esc(to.name)}</b><span class="arrow">·</span><span>${esc(m.subject || '任务派单')}</span></span>
        <span>${esc(fmtTime(m.createdAt)) || esc(m.id)}</span>
      </div>
      <div class="team-msg-body">${esc(m.body || '')}</div>
      ${tags.length ? `<div class="msg-tags">${tags.join('')}</div>` : ''}
      ${pipelineMarkup(dispatchSteps(p, m))}
      <div class="team-msg-foot">
        <small>${ackText}</small>
        <span>
          <button type="button" data-msg-inbox="${esc(m.id)}" data-msg-inbox-role="${esc(m.to)}" title="在「${esc(to.name)}」的调试收件箱里查看这条消息（未读/已读、详情、read/ack 入口）">邮箱(调试)</button>
          ${!m.ack && m.ackRequired !== false ? `<button type="button" data-msg-ack="${esc(m.id)}" ${blockedByOther ? 'disabled' : ''} title="${blockedByOther ? '先处理当前待回执，再回执这条' : (pending ? '记录这条派单的回执' : '只有当前待回执（或已超时）的消息能直接回执')}">记录回执</button>` : ''}
          ${pending ? `<button type="button" data-msg-cancel="${esc(m.id)}" title="释放这条派单的锁，不删除消息">撤销派单</button>` : ''}
        </span>
      </div>
    </article>`;
  }).join('');
  box.querySelectorAll('[data-msg-ack]').forEach((b) => {
    const msg = messages.find((m) => m.id === b.dataset.msgAck);
    if (msg) b.addEventListener('click', () => openAckModal(p, msg));
  });
  box.querySelectorAll('[data-msg-cancel]').forEach((b) => b.addEventListener('click', () => cancelPending(p, b.dataset.msgCancel)));
  box.querySelectorAll('[data-msg-inbox]').forEach((b) => b.addEventListener('click', () => openInboxFor(b.dataset.msgInboxRole, b.dataset.msgInbox)));
  // R-e31b §5.2：还有更多（显示数 < 已取到的或 < total）时给「加载更多」，按 messages:page 取下一页，历史不进常驻内存。
  const totalAll = Number(p.messagesTotal) > 0 ? Number(p.messagesTotal) : (p.messages || []).length;
  const loaded = (Array.isArray(p.messages) ? p.messages.length : 0) + msgUi.extra.length;
  if (messages.length > msgUi.limit || loaded < totalAll) {
    const more = document.createElement('button');
    more.type = 'button';
    more.className = 'ghost small';
    more.setAttribute('data-msg-more', '1');
    more.textContent = msgUi.loading ? '加载中…' : '加载更多（已显示 ' + Math.min(messages.length, msgUi.limit) + ' / 共 ' + totalAll + '）';
    more.disabled = Boolean(msgUi.loading);
    more.addEventListener('click', async () => {
      if (msgUi.loading) return;
      msgUi.loading = true;
      try {
        const r = await window.workbench.messagesPage({ projectId: p.id, limit: 50, offset: loaded });
        if (r && r.ok && Array.isArray(r.items)) msgUi.extra = msgUi.extra.concat(r.items);
        msgUi.limit += 30;
      } catch (e) {
        toast('加载更多失败：' + humanError(e.message), 'bad');
      } finally {
        msgUi.loading = false;
        renderTeamLog(activeProject());
      }
    });
    box.appendChild(more);
  }
}
}

function startAckTicker(project) {
  if (dispatchTicker) {
    clearInterval(dispatchTicker);
    dispatchTicker = null;
  }
  if (!project || !project.pendingAck) return;
  const projectId = project.id;
  const tick = () => {
    const current = activeProject();
    if (!current || current.id !== projectId || !current.pendingAck) {
      clearInterval(dispatchTicker);
      dispatchTicker = null;
      return;
    }
    const remain = ackRemainMs(current);
    document.querySelectorAll('[data-ack-ttl]').forEach((el) => {
      const expired = remain !== null && remain <= 0;
      el.textContent = expired ? '已超时' : '剩余 ' + fmtRemain(remain);
      el.classList.toggle('expired', expired);
    });
  };
  tick();
  // R4 结论：保留（纯本地倒计时文本刷新，无 IPC/无读盘，不占主进程）；不纳入可见性门以免暂停后回到旧文本。
  dispatchTicker = setInterval(tick, 1000);
}

async function cancelPending(project, messageId) {
  if (!project) return;
  const msg = (project.messages || []).find((m) => m.id === messageId) || null;
  const label = msg ? `${roleById(msg.to).name} · ${msg.subject || '任务派单'}` : messageId;
  if (!confirm(`撤销这条待回执？\n${label}\n只释放派单锁，消息与回执记录都会保留。`)) return;
  try {
    const r = await window.workbench.teamCancel({ projectId: project.id });
    await applyState(r);
    const warnings = Array.isArray(r.warnings) ? r.warnings : [];
    if (warnings.length) toast('已撤销本机锁；旧协议锁释放失败：' + (warnings[0].message || warnings[0].code), 'bad');
    else toast(r.released && r.released.removed ? '已撤销派单并释放旧协议锁' : '已撤销派单', 'ok');
    loadDshTeamStatus();
  } catch (e) {
    toast('撤销失败：' + e.message, 'bad');
  }
}

/* ── 角色收件箱：六角色 × 未读 / 已读 / 全部 ─────────────── */

/** 当前 preload 到底暴露了哪些收件箱 IPC；缺失就明确提示，绝不假装调用。 */
function inboxCaps() {
  const api = window.workbench || {};
  return {
    inbox: typeof api.teamInbox === 'function',
    read: typeof api.teamRead === 'function',
    ack: typeof api.teamAck === 'function',
    prompt: typeof api.dshPrompt === 'function'
  };
}

function inboxMissingApis() {
  const caps = inboxCaps();
  const missing = [];
  if (!caps.inbox) missing.push('team:inbox');
  if (!caps.read) missing.push('team:read');
  return missing;
}

function loadInboxSeen() {
  if (inboxSeenLoaded) return;
  inboxSeenLoaded = true;
  try {
    const raw = JSON.parse(localStorage.getItem(INBOX_SEEN_KEY) || '[]');
    if (Array.isArray(raw)) for (const key of raw) inboxSeen.add(String(key));
  } catch { /* localStorage 不可用时只用内存标记 */ }
}

function inboxSeenKey(projectId, roleId, messageId) {
  return [projectId || '', roleId || '', messageId || ''].join('|');
}

function inboxIsSeen(projectId, roleId, messageId) {
  if (!messageId) return false;
  loadInboxSeen();
  return inboxSeen.has(inboxSeenKey(projectId, roleId, messageId));
}

/** 本机浏览标记：只写渲染进程 localStorage，不写 团队/状态，也不冒充旧协议 read。 */
function inboxMarkSeen(projectId, roleId, messageId) {
  if (!messageId) return false;
  loadInboxSeen();
  const key = inboxSeenKey(projectId, roleId, messageId);
  if (inboxSeen.has(key)) return false;
  inboxSeen.add(key);
  const keys = Array.from(inboxSeen);
  if (keys.length > 600) for (const old of keys.slice(0, keys.length - 600)) inboxSeen.delete(old);
  try { localStorage.setItem(INBOX_SEEN_KEY, JSON.stringify(Array.from(inboxSeen))); } catch { /* ignore */ }
  return true;
}

/** 团队工具位置：只用于给角色会话的指令里带一条可执行的路径（读不到就留空）。 */
function teamToolPath() {
  const root = state && state.team && state.team.teamRoot ? String(state.team.teamRoot) : '';
  if (!root) return '';
  const sep = root.includes('\\') ? '\\' : '/';
  return root.replace(/[\\/]+$/, '') + sep + '工具' + sep + 'team.mjs';
}

function roleLabel(roleId) {
  const id = String(roleId || '');
  if (id === 'system') return '系统';
  return roleById(id).name;
}

/** 旧协议邮箱里的 messageId；只有本机镜像、没进邮箱的消息返回空串。 */
function inboxMailboxId(message) {
  const teamId = String((message && message.teamMessageId) || '');
  if (teamId) return teamId;
  return message && message.source === 'team' ? String(message.id || '') : '';
}

function inboxAckFields(message) {
  const src = message || {};
  return {
    ackRequired: src.ackRequired !== false,
    ack: Boolean(src.ack),
    ackAt: src.ackAt || null,
    ackNote: String(src.ackNote || ''),
    ackSource: String(src.ackSource || ''),
    manualAck: Boolean(src.manualAck),
    manualAckAt: src.manualAckAt || null,
    manualAckNote: String(src.manualAckNote || '')
  };
}

function inboxAckView(message) {
  if (message.ack) {
    const label = sourceLabel(message.ackSource) || message.ackSource || '来源未记录';
    return { key: 'acked', text: '已回执 · ' + label, cls: 'ok', at: message.ackAt || null, note: message.ackNote || '' };
  }
  if (message.manualAck) {
    return { key: 'manual', text: '人工确认（不是角色回执，旧协议锁未释放）', cls: 'bad', at: message.manualAckAt || null, note: message.manualAckNote || '' };
  }
  if (message.ackRequired === false) return { key: 'none', text: '无需回执', cls: '', at: null, note: '' };
  return { key: 'pending', text: '未回执', cls: 'warn', at: null, note: '' };
}

function inboxRoute(message) {
  if (message.from === 'system') return '系统通知';
  if (message.from === 'pm' && message.to !== 'pm') return 'PM 派单';
  if (message.to === 'pm') return '角色 → PM';
  return '角色互发';
}

function inboxLocalMessage(project, roleId, message) {
  const seen = inboxIsSeen(project.id, roleId, message.id);
  const from = String(message.from || '');
  const to = String(message.to || roleId);
  return {
    ...inboxAckFields(message),
    id: String(message.id || ''),
    mailboxId: inboxMailboxId(message),
    localMirror: true,
    from,
    to,
    subject: String(message.subject || '任务派单'),
    body: String(message.body || ''),
    taskId: String(message.taskId || ''),
    createdAt: message.createdAt || '',
    source: String(message.source || (message.degraded ? 'local' : '')),
    senderSessionId: message.senderSessionId || '',
    route: inboxRoute({ from, to }),
    readState: seen ? 'read' : 'unread',
    readLabel: seen ? '已读（本机浏览标记）' : '未读（本机镜像）',
    readFrom: 'local',
    raw: message
  };
}

/** 旧协议邮箱：只有真的读到 team:inbox 时才走这里；box=cur 即已读。 */
function inboxTeamMessages(project, roleId) {
  const data = inboxUi.data;
  if (!data || !Array.isArray(data.messages) || inboxUi.dataRole !== roleId) return null;
  return data.messages.map((message) => {
    const id = String(message.id || '');
    if (!id) return null;
    const local = (project.messages || []).find((item) => String(item.id) === id
      || (item.teamMessageId && String(item.teamMessageId) === id)) || null;
    const from = String(message.from || '');
    const to = String(message.to || roleId);
    const read = String(message.box || '') === 'cur';
    return {
      ...inboxAckFields(local || { ackRequired: message.ackRequired }),
      id,
      mailboxId: id,
      localMirror: Boolean(local),
      from,
      to,
      subject: String(message.subject || '任务派单'),
      body: String(message.body || ''),
      taskId: String(message.task || ''),
      createdAt: message.ts || message.createdAt || '',
      source: 'team',
      senderSessionId: '',
      route: inboxRoute({ from, to }),
      readState: read ? 'read' : 'unread',
      readLabel: read ? '已读（旧协议 cur）' : '未读（旧协议 new）',
      readFrom: 'team',
      raw: local || message
    };
  }).filter(Boolean).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

/** 该角色收到的消息：读到旧协议邮箱就用邮箱，否则退回本机镜像（并明确标出来源）。 */
function inboxMessagesFor(project, roleId) {
  if (!project || !roleId) return [];
  const localOnly = (project.messages || [])
    .filter((message) => String(message.to) === String(roleId) && message.id)
    .map((message) => inboxLocalMessage(project, roleId, message));
  const team = inboxTeamMessages(project, roleId);
  if (!team) return localOnly.sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
  // 旧协议邮箱是真相；本机有、邮箱里没有的（降级记录）仍然显示，但标成「仅本机」。
  const mailboxIds = new Set(team.map((message) => message.mailboxId || message.id));
  const extras = localOnly
    .filter((message) => !mailboxIds.has(message.id) && !mailboxIds.has(message.mailboxId))
    .map((message) => ({ ...message, onlyLocal: true }));
  return team.concat(extras).sort((a, b) => String(b.createdAt).localeCompare(String(a.createdAt)));
}

function inboxUnreadFor(project, roleId) {
  return inboxMessagesFor(project, roleId).filter((message) => message.readState === 'unread').length;
}

function renderInboxApiNote(project) {
  const note = $('#inbox-api-note');
  const source = $('#inbox-source');
  const missing = inboxMissingApis();
  const teamMode = Boolean(inboxUi.data && inboxUi.dataRole === inboxUi.roleId);
  const hasSession = Boolean(project && (project.sessions || {})[inboxUi.roleId]);
  if (source) {
    source.textContent = teamMode ? '旧协议邮箱' : '本机镜像';
    source.className = 'badge ' + (teamMode ? 'badge-approved' : 'muted-badge');
    source.title = teamMode
      ? '数据来自 team:inbox（旧协议邮箱 new / cur），读取身份 actor=workbench-shell'
      : '数据来自 workbench.json 的 messages 镜像；没有读到旧协议邮箱';
  }
  if (!note) return;
  if (!project) {
    note.hidden = true;
    note.innerHTML = '';
    return;
  }
  note.hidden = false;
  if (missing.length) {
    note.innerHTML = `<b>接口缺失：${missing.map((name) => esc(name)).join(' / ')}</b>`
      + '当前 preload 只有 send / ack / cancel；下面按 <code>workbench.json</code> 的本机消息镜像展示。'
      + '未读/已读是本机浏览标记，不是旧协议 <code>邮箱/&lt;角色&gt;/new→cur</code>，也不会写 <code>团队/状态</code>。'
      + '补齐 IPC 后这里会自动切到旧协议邮箱，不做假调用。';
  } else if (!hasSession) {
    note.innerHTML = `<b>该角色没有 DSH 会话</b>旧协议 <code>team:inbox</code> 需要角色会话身份，现在读不到 `
      + `<code>邮箱/&lt;${esc(inboxUi.roleId)}&gt;/new|cur</code>；下面只显示本机镜像，未读/已读是本机浏览标记，不是邮箱的 new/cur。`;
  } else if (inboxUi.error) {
    note.innerHTML = `<b>旧协议收件箱读取失败</b>${esc(inboxUi.error)}；下面退回本机镜像，未读/已读同样是本机标记。`;
  } else if (teamMode) {
    note.innerHTML = '<b>旧协议邮箱</b>读 <code>邮箱/&lt;角色&gt;/new|cur</code>：未读/已读以 <code>box</code> 为准；'
      + '读取由主进程持该角色会话令牌执行（<code>actor=workbench-shell</code>），不是角色本人 read。'
      + '本机有、邮箱没有的消息标「仅本机」。';
  } else if (inboxUi.loading) {
    note.innerHTML = `<b>读取中</b>正在按「${esc(roleById(inboxUi.roleId).name)}」的会话身份读旧协议邮箱…`;
  } else {
    note.innerHTML = `<b>旧协议邮箱可用</b>还没读取「${esc(roleById(inboxUi.roleId).name)}」的邮箱；点「刷新」读取。`;
  }
}

function renderInboxItem(message) {
  const unread = message.readState === 'unread';
  const ack = inboxAckView(message);
  const tags = [
    `<span class="inbox-tag ${unread ? 'unread' : ''}">${unread ? '未读' : '已读'}</span>`,
    `<span class="inbox-tag ${ack.key === 'acked' ? 'ok' : (ack.key === 'pending' || ack.key === 'manual' ? 'warn' : '')}">${esc(ack.text)}</span>`
  ];
  if (message.source === 'local' || message.source === 'team-local' || message.source === 'degraded') {
    tags.push('<span class="inbox-tag local">本机降级</span>');
  }
  if (message.onlyLocal) tags.push('<span class="inbox-tag local">仅本机（不在邮箱）</span>');
  if (message.ackRequired === false) tags.push('<span class="inbox-tag">无需回执</span>');
  return `<button class="inbox-item${unread ? ' is-unread' : ''}${message.id === inboxUi.selectedId ? ' is-selected' : ''}" type="button" role="option" aria-selected="${message.id === inboxUi.selectedId}" data-inbox-msg="${esc(message.id)}" title="${esc(message.id + ' · ' + message.subject)}">
    <span class="inbox-item-top"><b>${esc(message.subject)}</b><span>${esc(fmtTime(message.createdAt))}</span></span>
    <span class="inbox-item-route">${esc(roleLabel(message.from))} → ${esc(roleLabel(message.to))}</span>
    <span class="inbox-tags">${tags.join('')}</span>
  </button>`;
}

function renderInboxDetail(project, messages) {
  const box = $('#inbox-detail');
  if (!box) return;
  const role = roleById(inboxUi.roleId);
  if (!project) {
    box.innerHTML = '<div class="empty-row">先新建或选择一个工作区。</div>';
    return;
  }
  const message = messages.find((item) => item.id === inboxUi.selectedId) || null;
  if (!message) {
    box.innerHTML = `<div class="inbox-detail-empty">
      <span class="inbox-detail-mark" aria-hidden="true">✉</span>
      <b>${esc(role.name)} 的收件箱</b>
      <p>选一条消息看 from→to、主题、正文、未读/已读、回执和时间。read 由工作台壳持角色会话身份执行（actor=workbench-shell）；「记录回执」由壳执行旧协议 ack（actor=workbench-shell）；「人工确认」只写本机（actor=workbench-shell/manual），不冒充角色回执。</p>
    </div>`;
    return;
  }
  const caps = inboxCaps();
  const sessionId = (project.sessions || {})[inboxUi.roleId] || '';
  const hasSession = Boolean(sessionId);
  const ack = inboxAckView(message);
  const mailboxId = String(message.mailboxId || '');
  // 邮箱的 new/cur 才算“旧协议已读”；本机浏览标记不能当作 read 已执行。
  const protocolRead = message.readFrom === 'team' && message.readState === 'read';
  const canPrompt = hasSession && caps.prompt && Boolean(mailboxId);
  const canRead = caps.read && hasSession && Boolean(mailboxId) && !protocolRead;
  const canAck = hasSession && message.localMirror && !message.onlyLocal && !message.ack && message.ackRequired !== false;
  const promptWhy = !hasSession
    ? '该角色没有 DSH 会话：不能执行 read/ack'
    : (!mailboxId
      ? '这条只在本机镜像里，旧协议邮箱没有对应的 messageId，角色读不到'
      : (!caps.prompt ? 'preload 没有 dshPrompt' : ''));
  const readWhy = !caps.read
    ? 'preload / 主进程没有 team:read：旧协议已读水位写不了'
    : (!hasSession
      ? '该角色没有 DSH 会话：read 需要角色会话身份'
      : (!mailboxId
        ? '这条只在本机镜像里，旧协议邮箱没有对应 messageId，read 不适用'
        : (protocolRead ? '这条在旧协议邮箱里已经是已读（cur）' : '')));
  const ackWhy = !hasSession
    ? '该角色没有 DSH 会话：主进程会拒绝（SESSION_IDENTITY_MISSING）'
    : (message.onlyLocal
      ? '这条不在旧协议邮箱里：只能记本机降级回执，不能当成角色回执；请在团队台消息里处理'
      : (!message.localMirror
        ? '本机镜像里没有这条消息：team:ack 找不到，不能凭空回执'
        : (message.ack ? '这条已经回执' : (message.ackRequired === false ? '这条不要求回执' : ''))));
  const fields = [];
  fields.push(['消息', `<code>${esc(message.id)}</code>${message.mailboxId && message.mailboxId !== message.id ? `<span class="muted"> 邮箱 ${esc(message.mailboxId)}</span>` : ''}`]);
  fields.push(['from → to', `<b>${esc(roleLabel(message.from))}</b><span class="inbox-arrow"> → </span><b>${esc(roleLabel(message.to))}</b>`]);
  fields.push(['时间', `<b>${esc(fmtTime(message.createdAt) || '未记录')}</b>${message.createdAt ? `<span class="muted"> ${esc(String(message.createdAt).replace('T', ' ').slice(0, 19))}</span>` : ''}`]);
  fields.push(['已读', `<b class="${message.readState === 'read' ? 'ok' : 'warn'}">${esc(message.readLabel)}</b>`]);
  fields.push(['回执', `<b class="${ack.cls}">${esc(ack.text)}</b>${ack.at ? `<span class="muted"> ${esc(fmtTime(ack.at))}</span>` : ''}${ack.note ? `<span class="muted"> · ${esc(ack.note)}</span>` : ''}`]);
  fields.push(['来源', `<b>${esc(sourceLabel(message.source) || message.source || '未知')}</b><span class="muted"> · ${esc(message.route)}</span>`]);
  if (message.taskId) fields.push(['任务', `<code>${esc(message.taskId)}</code>`]);
  if (sessionId) fields.push(['角色会话', `<code title="${esc(sessionId)}">${esc(sessionId)}</code>`]);
  const notes = [];
  if (!hasSession) {
    notes.push(`<b>该角色没有 DSH 会话：read / ack 全部禁用。</b>先点「建团队」创建会话；不会用本机记录冒充角色回执。`);
  } else {
    notes.push(`「让角色自己 read/ack」把四步指令发到「${esc(role.name)}」的会话（${esc(sessionShort(sessionId))}），由角色执行。`);
    notes.push('「旧协议 read」由主进程持该角色会话令牌执行（actor=workbench-shell）；「记录回执」走 team:ack，主进程核验 workspace 后由壳执行旧协议 ack（actor=workbench-shell，不是角色本人）。');
  }
  if (!caps.read) notes.push('主进程没有 <code>team:read</code>：旧协议已读水位写不了，「旧协议 read」保持禁用。');
  if (!caps.inbox) notes.push('主进程没有 <code>team:inbox</code>：这里展示的是本机镜像，不是旧协议邮箱。');
  if (message.onlyLocal) notes.push('这条不在旧协议邮箱里（仅本机镜像）：角色 boot/inbox 读不到，read / ack 入口不可用。');
  box.innerHTML = `
    <div class="inbox-detail-head">
      <div><span class="eyebrow">MESSAGE</span><b>${esc(message.subject)}</b></div>
      <span class="badge ${message.readState === 'read' ? 'muted-badge' : 'badge-skipped'}">${message.readState === 'read' ? '已读' : '未读'}</span>
    </div>
    <div class="inbox-fields">
      ${fields.map(([key, html]) => `<div class="inbox-field"><span class="inbox-field-key">${esc(key)}</span><span class="inbox-field-value${key === '回执' ? ' wrap' : ''}">${html}</span></div>`).join('')}
    </div>
    <div class="inbox-body-text">${esc(message.body || '（没有正文）')}</div>
    <div class="inbox-actions">
      <button class="primary small" type="button" data-inbox-prompt ${canPrompt ? '' : 'disabled'} title="${esc(promptWhy || '把 boot / inbox / read / ack 四步发给该角色会话，由角色自己执行')}">让角色自己 read/ack</button>
      <button class="ghost small" type="button" data-inbox-read ${canRead ? '' : 'disabled'} title="${esc(readWhy || '调用 team:read 把消息从 new 移到 cur')}">旧协议 read</button>
      <button class="ghost small" type="button" data-inbox-ack ${canAck ? '' : 'disabled'} title="${esc(ackWhy || '由壳持角色会话身份执行旧协议 ack（actor=workbench-shell），主进程核验 workspace')}">记录回执</button>
    </div>
    <p class="inbox-actions-note${hasSession ? '' : ' bad'}">${notes.join('<br>')}</p>`;
}

/** 收件箱已降级为折叠的调试工具：只有用户展开时才自动读邮箱。 */
function inboxBlockOpen() {
  const block = $('#inbox-block');
  if (!block) return false;
  return block.tagName === 'DETAILS' ? Boolean(block.open) : !block.hidden;
}

function renderInbox() {
  const rolesBox = $('#inbox-roles');
  if (!rolesBox) return;
  const project = activeProject();
  const roles = teamRoles(project);
  if (inboxUi.projectId !== (project ? project.id : null)) {
    inboxUi.projectId = project ? project.id : null;
    inboxUi.selectedId = '';
    inboxUi.data = null;
    inboxUi.dataRole = '';
    inboxUi.error = null;
    inboxUi.at = 0;
    inboxUi.loading = false;
  }
  if (!roles.some((role) => role.id === inboxUi.roleId)) inboxUi.roleId = roles.length ? roles[0].id : 'pm';
  if (!INBOX_FILTERS.some((item) => item.id === inboxUi.filter)) inboxUi.filter = 'unread';
  renderInboxApiNote(project);
  rolesBox.innerHTML = roles.map((role) => {
    const unread = project ? inboxUnreadFor(project, role.id) : 0;
    const active = role.id === inboxUi.roleId;
    return `<button class="inbox-role${active ? ' active' : ''}" type="button" role="tab" aria-selected="${active}" data-inbox-role="${esc(role.id)}" title="${esc(role.name + ' 的收件箱' + (unread ? '：' + unread + ' 条未读' : ''))}">
      <span class="session-dot" style="--role-color:${esc(role.color)}" aria-hidden="true"></span>
      <span>${esc(role.name)}</span>
      ${unread ? `<span class="inbox-badge">${unread}</span>` : ''}
    </button>`;
  }).join('');
  const messages = project ? inboxMessagesFor(project, inboxUi.roleId) : [];
  const counts = {
    unread: messages.filter((message) => message.readState === 'unread').length,
    read: messages.filter((message) => message.readState === 'read').length,
    all: messages.length
  };
  const filters = $('#inbox-filters');
  if (filters) {
    filters.innerHTML = INBOX_FILTERS.map((item) => `<button class="inbox-filter${inboxUi.filter === item.id ? ' active' : ''}" type="button" role="tab" aria-selected="${inboxUi.filter === item.id}" data-inbox-filter="${item.id}">${esc(item.label)} <b>${counts[item.id]}</b></button>`).join('');
  }
  const countEl = $('#inbox-count');
  if (countEl) {
    countEl.textContent = project
      ? `${roleById(inboxUi.roleId).name} · ${messages.length} 条${inboxUi.loading ? ' · 读取中…' : ''}`
      : '';
  }
  const list = $('#inbox-list');
  if (list) {
    if (!project) {
      list.innerHTML = '<div class="empty-row">先新建或选择一个工作区。</div>';
    } else if (!messages.length) {
      const hasSession = Boolean((project.sessions || {})[inboxUi.roleId]);
      const missing = inboxMissingApis();
      const reason = missing.length
        ? '本机镜像（旧协议邮箱 IPC 未暴露）'
        : (hasSession ? '旧协议邮箱' : '本机镜像（该角色没有 DSH 会话，邮箱读不到）');
      list.innerHTML = `<div class="empty-row">「${esc(roleById(inboxUi.roleId).name)}」还没有收到消息。派单后会写进${reason}。</div>`;
    } else {
      const visible = messages.filter((message) => message.id === inboxUi.selectedId
        || (inboxUi.filter === 'all' ? true : message.readState === inboxUi.filter));
      list.innerHTML = visible.length
        ? visible.slice(0, 60).map(renderInboxItem).join('')
        : `<div class="empty-row">${inboxUi.filter === 'unread' ? '没有未读消息。' : '没有已读消息。'}切到「全部」查看。</div>`;
    }
  }
  renderInboxDetail(project, messages);
  // 只有团队台真打开且用户展开“调试收件箱”时才自动读邮箱：team:inbox 会 spawn 旧团队工具，不能在后台空跑。
  const caps = inboxCaps();
  const canLoad = Boolean(project && (project.sessions || {})[inboxUi.roleId]);
  const visible = openDrawerName === 'team' && inboxBlockOpen();
  if (visible && canLoad && caps.inbox && !inboxUi.loading && !inboxUi.error && inboxUi.dataRole !== inboxUi.roleId) {
    const wantedRole = inboxUi.roleId;
    setTimeout(() => {
      if (inboxUi.roleId === wantedRole && !inboxUi.loading && !inboxUi.error && inboxUi.dataRole !== wantedRole) refreshInbox();
    }, 0);
  }
}

function setInboxRole(roleId) {
  const next = String(roleId || '');
  if (!next || next === inboxUi.roleId) return;
  inboxUi.roleId = next;
  inboxUi.selectedId = '';
  inboxUi.data = null;
  inboxUi.dataRole = '';
  inboxUi.error = null;
  inboxUi.at = 0;
  renderInbox();
}

function setInboxFilter(kind) {
  const next = String(kind || '');
  if (!INBOX_FILTERS.some((item) => item.id === next) || next === inboxUi.filter) return;
  inboxUi.filter = next;
  renderInbox();
}

function selectInboxMessage(messageId) {
  const project = activeProject();
  if (!project) return;
  inboxUi.selectedId = String(messageId || '');
  if (inboxUi.selectedId) inboxMarkSeen(project.id, inboxUi.roleId, inboxUi.selectedId);
  renderInbox();
}

/** 收件箱入口：从角色卡 / 团队消息 / 更多菜单进来，定位到指定角色与消息。 */
function openInboxFor(roleId, messageId) {
  const project = activeProject();
  if (!project) { toast('先新建或选择一个工作区', 'bad'); return; }
  const nextRole = String(roleId || inboxUi.roleId || 'pm');
  if (nextRole !== inboxUi.roleId) {
    inboxUi.roleId = nextRole;
    inboxUi.data = null;
    inboxUi.dataRole = '';
    inboxUi.error = null;
    inboxUi.at = 0;
  }
  inboxUi.projectId = project.id;
  inboxUi.selectedId = String(messageId || '');
  if (inboxUi.selectedId) inboxMarkSeen(project.id, inboxUi.roleId, inboxUi.selectedId);
  const block = $('#inbox-block');
  if (block && block.tagName === 'DETAILS') block.open = true;
  setDrawer('team');
  renderInbox();
  try { $('#inbox-block')?.scrollIntoView({ block: 'start', behavior: 'smooth' }); } catch { /* ignore */ }
  // 没有会话时不去调 team:inbox（主进程必定拒绝），页面已经写明原因。
  if (inboxCaps().inbox && (project.sessions || {})[inboxUi.roleId]) refreshInbox();
}

async function refreshInbox() {
  const project = activeProject();
  if (!project) { toast('先选择工作区', 'bad'); return null; }
  const caps = inboxCaps();
  if (!caps.inbox) {
    inboxUi.data = null;
    inboxUi.dataRole = '';
    inboxUi.error = null;
    renderInbox();
    toast('preload 没有 teamInbox：收件箱只能读本机镜像，读不到旧协议邮箱（不假装读到了）', 'bad');
    return null;
  }
  const roleId = inboxUi.roleId;
  if (!(project.sessions || {})[roleId]) {
    // team:inbox 会用该角色会话身份读邮箱；没有会话时主进程必定拒绝，这里不发起假请求。
    inboxUi.data = null;
    inboxUi.dataRole = '';
    inboxUi.error = null;
    renderInbox();
    toast(`「${roleById(roleId).name}」没有 DSH 会话：旧协议邮箱读不到，先建团队；本机镜像仍可看`, 'bad');
    return null;
  }
  if (inboxUi.loading) return null;
  inboxUi.loading = true;
  inboxUi.error = null;
  renderInbox();
  try {
    const result = await window.workbench.teamInbox({ projectId: project.id, role: roleId, all: true });
    if (result && result.ok === false) throw new Error(result.message || result.code || '旧协议收件箱读取失败');
    inboxUi.data = result || null;
    inboxUi.dataRole = roleId;
    inboxUi.at = Date.now();
    return result;
  } catch (e) {
    inboxUi.data = null;
    inboxUi.dataRole = '';
    inboxUi.error = humanError(e.message);
    return null;
  } finally {
    inboxUi.loading = false;
    renderInbox();
    // 邮箱数据到了之后重画角色卡，避免卡片上的未读还停在“本机镜像”的旧数字。
    renderRoles();
  }
}

/** 旧协议 read：必须真要 teamRead 且角色有会话；缺一个就禁用，不写假已读。 */
async function inboxReadNow(project) {
  const p = project || activeProject();
  if (!p) return;
  const caps = inboxCaps();
  const message = inboxMessagesFor(p, inboxUi.roleId).find((item) => item.id === inboxUi.selectedId) || null;
  if (!message) { toast('先在收件箱里选一条消息', 'bad'); return; }
  if (!caps.read) { toast('preload / 主进程没有 teamRead：不能写旧协议已读水位（不会假装已读）', 'bad'); return; }
  if (!(p.sessions || {})[inboxUi.roleId]) { toast('该角色没有 DSH 会话：旧协议 read 需要角色会话身份', 'bad'); return; }
  if (!message.mailboxId) { toast('这条只在本机镜像里，旧协议邮箱没有对应 messageId，read 不适用', 'bad'); return; }
  try {
    const result = await window.workbench.teamRead({ projectId: p.id, role: inboxUi.roleId, messageId: message.mailboxId });
    if (result && result.ok === false) throw new Error(result.message || result.code || '旧协议 read 失败');
    // 真读过之后才落本机浏览标记；邮箱可见时再重读一遍 cur。
    inboxMarkSeen(p.id, inboxUi.roleId, message.id);
    toast(result && result.alreadyRead ? '这条在旧协议邮箱里已经是已读（cur）' : '已按旧协议标记已读（new → cur）', 'ok');
    if (inboxCaps().inbox) await refreshInbox();
    else renderInbox();
  } catch (e) {
    toast('标记已读失败：' + humanError(e.message), 'bad');
  }
}

/** 回执沿用现有 team:ack：主进程核验角色会话与 workspace；无会话时按钮已禁用。 */
function openInboxAck(project) {
  const p = project || activeProject();
  if (!p) return;
  const message = inboxMessagesFor(p, inboxUi.roleId).find((item) => item.id === inboxUi.selectedId) || null;
  if (!message) { toast('先在收件箱里选一条消息', 'bad'); return; }
  if (!(p.sessions || {})[inboxUi.roleId]) { toast('该角色没有 DSH 会话：不能记录旧协议回执（只能人工确认，不是角色回执）', 'bad'); return; }
  if (message.onlyLocal) { toast('这条不在旧协议邮箱里：不能当成角色回执；请在团队台消息里处理', 'bad'); return; }
  if (!message.localMirror) { toast('本机镜像里没有这条消息：team:ack 找不到，不能凭空回执', 'bad'); return; }
  openAckModal(p, message.raw || message);
}

/** 可选路径：把旧协议四步指令发到该角色会话，让角色自己执行；这条路径不代写。 */
function openInboxRolePrompt(project) {
  const p = project || activeProject();
  if (!p) return;
  const message = inboxMessagesFor(p, inboxUi.roleId).find((item) => item.id === inboxUi.selectedId) || null;
  if (!message) { toast('先在收件箱里选一条消息', 'bad'); return; }
  const roleId = inboxUi.roleId;
  const role = roleById(roleId);
  if (!(p.sessions || {})[roleId]) { toast('该角色没有 DSH 会话：不能执行 read/ack', 'bad'); return; }
  if (!message.mailboxId) { toast('这条只在本机镜像里，旧协议邮箱没有对应的 messageId', 'bad'); return; }
  if (typeof window.workbench.dshPrompt !== 'function') { toast('preload 没有 dshPrompt', 'bad'); return; }
  const teamName = String((p.workspace && p.workspace.name) || p.teamName || p.name);
  const tool = teamToolPath();
  const ackLine = message.ack
    ? '3) 本条已经回执过（旧协议已有 ack 记录），只 read 即可，不要重复 ack'
    : (message.ackRequired !== false
      ? `3) 本条要回执：ack --id ${message.mailboxId} --note "已收到 ${message.subject || '任务'} + 边界"`
      : '3) 本条不要求回执：read 完即可，不要额外 ack');
  const text = [
    `【角色收件箱 ${message.mailboxId}】${message.subject}`,
    `${roleLabel(message.from)} → ${role.name} · ${fmtTime(message.createdAt) || '时间未记录'}`,
    '',
    '这是你收件箱里的消息，不是通知。请按旧协议自己执行，不要只回“收到”：',
    `1) ${tool ? `node "${tool}" ` : ''}boot --role ${roleId} --project "${teamName}"`,
    `2) 用 boot 输出的令牌执行 inbox --all，再 read --id ${message.mailboxId}`,
    ackLine,
    `最后只回一行：已回执/已读的角色 + ${message.mailboxId}；不要巡检全队。`
  ].join('\n');
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <p class="member-hint">这段指令会作为一条消息发到「${esc(role.name)}」的 DSH 会话，由角色自己在会话里执行 read / ack。这条路径只发指令、不代写；团队台的「记录回执」则是由工作台壳执行旧协议 ack（<code>actor=workbench-shell</code>），两者不要混为一谈。</p>
    <label class="field"><span><b>发给 ${esc(role.name)} 的指令</b><span class="field-note">可改</span></span><textarea id="inbox-prompt-text" class="textarea" style="min-height:150px;font-family:var(--mono);line-height:1.6"></textarea></label>
    <div class="modal-error"></div>`;
  wrap.querySelector('#inbox-prompt-text').value = text;
  openModal({
    title: '让角色自己执行 read/ack',
    subtitle: `${role.name} · ${message.subject}`,
    icon: '✉',
    body: wrap,
    width: 640,
    actions: [
      { label: '取消', kind: 'ghost', onClick: ({ close }) => close() },
      { label: '发给角色会话', kind: 'primary', onClick: async ({ close, error }) => {
        try {
          const value = wrap.querySelector('#inbox-prompt-text').value.trim();
          if (!value) throw new Error('指令不能为空');
          await window.workbench.dshPrompt({ projectId: p.id, role: roleId, text: value });
          rememberWake(p.id, roleId, { ok: true }, 'prompt');
          close();
          toast(`已把四步指令发给 ${role.name} 的会话；回执以角色自己写 回执.jsonl 为准`, 'ok');
        } catch (e) { error(humanError(e.message)); }
      } }
    ]
  });
}

/* ── 顶栏与主画面状态 ─────────────────────────────────── */

function renderHeader() {
  const p = activeProject();
  const tbName = $('#tb-project');
  const tbPath = $('#tb-project-path');
  const tbStage = $('#tb-stage');
  const tbTeam = $('#tb-team');
  const tbSessions = $('#tb-sessions');
  const stageProject = $('#stage-project');
  const stagePath = $('#stage-path');
  const stageOwner = $('#legacyReviewStage');

  if (!p) {
    if (tbName) tbName.textContent = '未选择工作区';
    if (tbPath) tbPath.textContent = '选择或新建一个项目';
    if (tbStage) tbStage.textContent = '—';
    if (tbTeam) { tbTeam.textContent = '—'; tbTeam.classList.remove('warn'); tbTeam.parentElement.title = '还没有工作区'; }
    if (tbSessions) tbSessions.textContent = '0';
    if (stageProject) stageProject.textContent = '未选择工作区';
    if (stagePath) stagePath.textContent = '选择项目后进入工作区';
    if (stageOwner) {
      stageOwner.textContent = 'Owner —';
      stageOwner.className = 'stage-owner owner-none';
      stageOwner.title = '先选择工作区';
      stageOwner.disabled = true;
    }
    const headerOwner = $('#legacy-owner-btn-removed');
    if (headerOwner) {
      headerOwner.disabled = true;
      headerOwner.title = '先选择工作区；需求级 Owner 闸门在项目面板打开';
    }
    const projectOwnerBadge = $('#project-owner-badge');
    if (projectOwnerBadge) projectOwnerBadge.hidden = true;
  } else {
    const ready = sessionReadyCount(p);
    const verified = verifiedCount(p);
    const sessions = sessionEntries(p).filter((item) => item.sessionId).length;
    const total = teamRoleCount(p);
    const shown = verified === null ? ready : verified;
    const ownerGate = legacyActionCommandGate('owner-review');
    if (tbName) tbName.textContent = p.name;
    if (tbPath) {
      tbPath.textContent = p.exists === false ? `${p.path} · 目录不存在` : p.path;
      tbPath.title = p.path;
    }
    if (tbStage) tbStage.textContent = stageById(p.stage).label;
    if (tbTeam) {
      // e29f F-3：N/N 只认 DSH 核验；未核验就写「待核验」，不拿本地映射凑满员。
      tbTeam.textContent = verified === null ? '待核验' : `${shown}/${total}`;
      tbTeam.setAttribute('data-local', `${ready}/${total}`);
      tbTeam.setAttribute('data-verified', verified === null ? '0' : '1');
      tbTeam.classList.toggle('warn', verified === null || verified < total);
      if (tbTeam.parentElement) {
        tbTeam.parentElement.title = verified === null
          ? `本地会话映射 ${ready}/${total}；DSH 还没核验（点「刷新」或打开团队台）`
          : `DSH 已核验 ${verified}/${total} 在「${(p.workspace && p.workspace.name) || p.teamName || p.name}」工作区；本地映射 ${ready}/${total}；${teamModeLabel(p)}`;
      }
    }
    if (tbSessions) {
      // 降级口径（需求六节「降级」）：未核验时数字写「—」，不写 0 冒充"一个都没有"。
      tbSessions.textContent = verified === null ? '—' : String(verified);
      tbSessions.title = verified === null ? '本地记录的会话数（DSH 未核验，不显示数字）' : 'DSH 工作区里已核验的角色会话数';
    }
    if (stageProject) stageProject.textContent = p.name;
    if (stagePath) {
      stagePath.textContent = p.path;
      stagePath.title = p.path;
    }
    const os = legacyOwnerHeadline(p);
    if (stageOwner) {
      stageOwner.textContent = 'Owner ' + os.label + (os.requirement ? ' · ' + os.requirement.id : '');
      stageOwner.className = 'stage-owner owner-' + os.key + (os.pending ? ' is-action' : '');
      stageOwner.disabled = !ownerGate.ok;
      stageOwner.title = !ownerGate.ok ? ownerGate.reason : (os.pending ? '需求级 Owner 待决定，点击继续' : '点击打开需求级 Owner 闸门')
        + (os.title ? ' · ' + os.title : '');
      stageOwner.setAttribute('aria-label', stageOwner.title);
    }
    const headerOwner = $('#legacy-owner-btn-removed');
    if (headerOwner) {
      headerOwner.disabled = !ownerGate.ok;
      // Fast 的 Owner 决定由后端壳层落账：按钮文案明确“一次点击”，不再因缺 owner 旧命令禁用。
      headerOwner.textContent = isQuickTeam(p) ? 'Owner（我）一次点击' : 'Owner（我）需求决定';
      headerOwner.title = ownerGate.ok
        ? (ownerGate.shellOwned
          ? '后端壳收口（Full / Fast）：一次点击直接调用 requirement:owner，不依赖旧 owner 命令'
          : '打开需求级 Owner 闸门；项目级旧闸门单独标注')
        : ownerGate.reason;
    }
    const projectOwnerBadge = $('#project-owner-badge');
    if (projectOwnerBadge) {
      const projectOs = ownerState(p);
      projectOwnerBadge.hidden = false;
      projectOwnerBadge.textContent = '项目级 Owner ' + projectOs.label;
      projectOwnerBadge.className = 'badge owner-badge badge-' + projectOs.key;
      projectOwnerBadge.title = `旧版项目级 ownerReview（${projectOs.label}）；不参与需求派单。需求级 Owner 请从流程/需求卡片进入。`;
    }
  }

  const actions = $('#project-actions');
  const empty = $('#empty-view');
  const body = $('#overview-body');
  const currentBadge = $('#project-current');
  if (!p) {
    if ($('#project-kicker')) $('#project-kicker').textContent = 'PROJECT';
    if ($('#project-crumb')) $('#project-crumb').textContent = '工作区';
    if ($('#project-name')) $('#project-name').textContent = '还没有项目';
    if ($('#project-path')) {
      $('#project-path').textContent = '新建一个项目，或从左侧选择。';
      $('#project-path').title = '';
      $('#project-path').classList.remove('path-missing');
    }
    if (currentBadge) currentBadge.hidden = true;
    if (actions) actions.hidden = true;
    if (empty) empty.hidden = false;
    if (body) body.hidden = true;
    return;
  }
  if ($('#project-kicker')) $('#project-kicker').textContent = 'PROJECT · ' + stageById(p.stage).label;
  if ($('#project-crumb')) $('#project-crumb').textContent = p.dshWorkspaceId ? '工作区 / DSH 已登记' : '工作区';
  if ($('#project-name')) $('#project-name').textContent = p.name;
  const missingDir = p.exists === false;
  if ($('#project-path')) {
    $('#project-path').textContent = missingDir ? `${p.path} · 目录不存在或被移动` : p.path;
    $('#project-path').title = missingDir ? `项目目录不存在或被移动：${p.path}` : p.path;
    $('#project-path').classList.toggle('path-missing', missingDir);
  }
  if (currentBadge) currentBadge.hidden = false;
  if (actions) actions.hidden = false;
  if (empty) empty.hidden = true;
  if (body) body.hidden = false;
}

/* ── 旧流程：真实文件 / 角色目录 / 必读闸门 ─────────────── */

function legacyFiles() {
  return Array.isArray(legacyUi.files) ? legacyUi.files : [];
}

function legacyFile(rel) {
  const key = String(rel || '').replace(/\\/g, '/');
  return legacyFiles().find((item) => item && item.rel === key) || null;
}

function legacyHas(rel) {
  // B-20261114-003257-0a46（R-d734 F-2/F-3）：项目信息/项目铁律以 docs:presence 的真实文件系统判定为准。
  // files:list 有 600 项 / 4 层上限，本项目 团队/ 与产出目录会先被扫满，根目录文档被截掉会误报“缺失”。
  const check = legacyPresenceCheckByRel(rel);
  if (check) return check.exists === true;
  return Boolean(legacyFile(rel));
}

function legacySize(rel) {
  const check = legacyPresenceCheckByRel(rel);
  if (check) return Number.isFinite(Number(check.size)) ? Number(check.size) : 0;
  const item = legacyFile(rel);
  return item && Number.isFinite(Number(item.size)) ? Number(item.size) : 0;
}

// 文档 key ↔ 相对路径：与后端 PROJECT_DOC_CHECKS 同口径（B-65df：五项必读全部进 presence）
// 注：前两项沿用后端历史 key（projectInfo / iron，团队工具 selftest 第十五轮按它断言）；新增三项 key=index/overview/guide。
const LEGACY_PRESENCE_DOCS = [
  { key: 'projectInfo', rel: '项目信息.md' },
  { key: 'iron', rel: '项目铁律.md' },
  { key: 'index', rel: '项目索引.md' },
  { key: 'overview', rel: '需求/00-需求总览.md' },
  { key: 'guide', rel: '协作准则.md' }
];

/** B-65df AC2：文档缺口唯一取数——只认 docs:presence 的 checks（含六角色目录/角色卡/文件索引）。 */
function legacyPresenceGapRows() {
  const presence = legacyUi.presence;
  if (!presence || !Array.isArray(presence.checks)) return null;
  return presence.checks.filter((row) => row && row.state !== 'present');
}

function legacyPresenceCheck(key) {
  const presence = legacyUi.presence;
  if (!presence || !Array.isArray(presence.checks)) return null;
  return presence.checks.find((row) => row && row.key === key) || null;
}

/**
 * B-20261114-052109-2ebe：docs:presence 现在覆盖「项目信息/铁律 + 六角色目录/角色卡/文件索引」
 * 共 20 项，每项都带 rel。这里按 rel 直接对表——不再像旧版那样只认两个文档 key，
 * 也不再回退 files:list（600 项 / 4 层上限会把后面的角色目录整段截掉，导致角色卡/文件索引永远“缺失”）。
 */
function legacyPresenceCheckByRel(rel) {
  const key = String(rel || '').replace(/\\/g, '/');
  if (!key) return null;
  const presence = legacyUi.presence;
  if (presence && Array.isArray(presence.checks)) {
    const hit = presence.checks.find((row) => row && String(row.rel || '').replace(/\\/g, '/') === key);
    if (hit) return hit;
  }
  const doc = LEGACY_PRESENCE_DOCS.find((item) => item.rel === key);
  return doc ? legacyPresenceCheck(doc.key) : null;
}

// B-e7e6：角色 id → 项目内目录名（与团队工具 ROLE_DIRS 同口径），给“新会话尚未映射 role.dir”兜底。
const ROLE_DIR_FALLBACK = { pm: '项目经理', product: '产品', analyst: '需求分析师', programmer1: '程序员A', programmer2: '程序员B', tester: '测试人员' };
/** 角色目录名：优先 role.dir（团队工具给的真实映射），换人后未映射时用 ROLE_DIR_FALLBACK 兜底。 */
function legacyRoleDirName(role) {
  return (role && role.dir) || ROLE_DIR_FALLBACK[String(role && (role.id || role))] || '';
}
function legacyRoleCardRel(role) {
  // B-e7e6：换人进来的新会话可能还没带上 role.dir；文件其实都在，别把“未映射”显示成“角色卡缺失”。
  const dir = legacyRoleDirName(role);
  return dir ? String(dir) + '/角色卡.md' : '';
}
// B-e7e6：角色卡三态——存在 / 缺失（路径有但文件没有）/ 未就绪（还没映射到目录，通常是新会话未 boot）。
function legacyRoleCardState(role) {
  const rel = legacyRoleCardRel(role);
  if (!rel) return { key: 'unmapped', label: '未就绪（未读角色卡）', rel: '', title: '换人后还没映射到角色目录：点「boot」读角色卡即就绪' };
  if (legacyHas(rel)) return { key: 'ok', label: '存在', rel, title: rel };
  return { key: 'missing', label: '缺失', rel, title: rel };
}

function legacyRoleIndexRel(role) {
  // B 复核（2026-11-14 05:30）：文件索引列也必须走同一份目录兜底，
  // 否则换人后 role.dir 还没映射时，角色卡能兜住、文件索引却仍显示「缺失」。
  const dir = legacyRoleDirName(role);
  return dir ? String(dir) + '/文件索引.md' : '';
}

/**
 * B-20261114-052109-2ebe：角色就绪提示（Owner 2026-11-14 05:24 + 05:26 口径）
 *   ① 文件缺失：角色卡/文件索引在 docs:presence 里 exists=false（真缺才红）；
 *   ② 未 boot：保留提示（文件齐但本会话未读必读），不当作门槛/红字；
 *   ③ boot 过期：**不再提示**（boot 只作记录不作门槛，Owner 05:26 更正：只去掉「过期」，保留「未 boot」）。
 */
function legacyRoleBootHint(role) {
  const cardRel = legacyRoleCardRel(role);
  const indexRel = legacyRoleIndexRel(role);
  const card = cardRel ? legacyPresenceCheckByRel(cardRel) : null;
  const index = indexRel ? legacyPresenceCheckByRel(indexRel) : null;
  const missing = [];
  if (!cardRel) missing.push('角色卡（目录未映射）');
  else if (card && card.exists === false) missing.push(cardRel);
  if (!indexRel) missing.push('文件索引（目录未映射）');
  else if (index && index.exists === false) missing.push(indexRel);
  const boot = legacyBootFor(role.id);
  if (missing.length) {
    return { key: 'missing-file', label: '文件缺失', title: `真缺文件：${missing.join('、')}（docs:presence 判存在性，不看截断清单）`, boot };
  }
  if (!boot.booted) {
    return { key: 'not-booted', label: '未 boot', title: '文件齐但本会话还没 boot（只作记录，不拦推进）：点「boot」读项目铁律/项目信息/角色卡/文件索引', boot };
  }
  // boot 已过期/文档变更：按 Owner 05:26 口径不再提示红字，也不再要求重新 boot，只注明记录时间。
  return { key: 'ready', label: '已 boot', title: `${boot.label}${boot.expired ? '（已过期，只作记录，不影响推进）' : ''}`, boot };
}

function legacyRoleFiles(role) {
  // 同上：目录名走 ROLE_DIR_FALLBACK，换人后未映射也能数到本角色目录里的“其他文档”。
  const dirName = legacyRoleDirName(role);
  if (!dirName) return [];
  const dir = String(dirName) + '/';
  return legacyFiles().filter((item) => item && item.kind === 'file' && String(item.rel || '').startsWith(dir));
}

function legacyRoleOtherDocCount(role) {
  const card = legacyRoleCardRel(role);
  const index = legacyRoleIndexRel(role);
  return legacyRoleFiles(role).filter((item) => item.rel !== card && item.rel !== index).length;
}

function legacyDocumentsReady() {
  const roles = teamRoles(activeProject());
  const rules = legacyHas('项目铁律.md');
  const info = legacyHas('项目信息.md');
  const index = legacyHas('项目索引.md');
  const overview = legacyHas('需求/00-需求总览.md');
  const guide = legacyHas('协作准则.md');
  const dirs = roles.filter((role) => legacyHas(legacyRoleDirName(role))).length;
  const cards = roles.filter((role) => legacyHas(legacyRoleCardRel(role))).length;
  const indexes = roles.filter((role) => legacyHas(legacyRoleIndexRel(role))).length;
  const others = roles.reduce((sum, role) => sum + legacyRoleOtherDocCount(role), 0);
  return { rules, info, index, overview, guide, dirs, cards, indexes, others, total: roles.length };
}

function legacyRequirementsCount() {
  return legacyFiles().filter((item) => item && item.kind === 'file' && /^需求\/R-[^/]+\.md$/i.test(String(item.rel || ''))).length;
}

/**
 * 真实需求数：只认需求 id，且排除 需求/评审/**、需求/验收/** 这些决策记录。
 * 工作流里没有需求时退回“需求/R-*.md 直接子文件”计数，避免把空项目显示成有记录。
 */
function legacyRealRequirementCount() {
  const ids = new Set();
  for (const row of legacyRequirements()) {
    const id = String((row && row.id) || '').trim();
    if (!id) continue;
    const doc = String((row && row.doc) || '').replace(/\\/g, '/');
    if (/^需求\/(评审|验收)\//i.test(doc)) continue;
    ids.add(id);
  }
  if (ids.size) return ids.size;
  return legacyRequirementsCount();
}

function legacyWorkflow() {
  return legacyUi.workflow && legacyUi.workflow.ok !== false ? legacyUi.workflow : null;
}

function legacyPhaseFromRequirements(requirements, round) {
  const rows = Array.isArray(requirements) ? requirements : [];
  // 一条历史需求被终止，不等于整个工作流终止；只有全部需求都收口时才按“全终止/全验收”判断。
  const live = rows.filter((row) => !['accepted', 'terminated', 'iteration'].includes(String(row.status || '')));
  if (!live.length) {
    if (!rows.length) return 'idle';
    if (rows.some((row) => String(row.status) === 'terminated')) return 'terminated';
    const currentRound = Number(round) || Number(rows[0] && rows[0].round) || 1;
    const maxRound = Math.max(...rows.map((row) => Number(row.round) || 1), 1);
    return currentRound > maxRound ? 'requirement' : 'accepted';
  }
  const statuses = new Set(live.map((row) => String(row.status || '')));
  if (statuses.has('test_done')) return 'owner_accept';
  if (statuses.has('test')) return 'test';
  if (statuses.has('dev_review')) return 'dev_review';
  if (statuses.has('dev_done') && !statuses.has('dev')) return 'dev_done';
  if (statuses.has('dev') || statuses.has('dev_done')) return 'dev';
  if (statuses.has('tech_review')) return 'tech_review';
  if (statuses.has('ready')) return 'dispatch';
  if (statuses.has('approved')) return 'owner_review';
  if (statuses.has('review') || statuses.has('rejected')) return 'requirement_review';
  return 'idle';
}

/**
 * 展示阶段：后端在“需求评审打回/投票驳回”后会把 工作流.json 的 phase 写回
 * requirement（team-tools 的评审驳回与投票驳回分支）。这时需求其实还在需求
 * 评审阶段，只是结论为 rejected；界面不能把它显示成普通的 requirement（新建/
 * 待评审），否则被驳回需求看起来像从没评审过。只在确实有 rejected 需求时改，
 * 不覆盖 dev/test/owner 等真实推进阶段。
 */
function legacyDisplayPhase(phase, requirements) {
  const raw = String(phase || '');
  if (raw !== 'requirement') return raw;
  const rows = Array.isArray(requirements) ? requirements : [];
  const hasRejected = rows.some((row) => String((row && row.status) || '') === 'rejected');
  return hasRejected ? 'requirement_review' : raw;
}

function legacyRequirements() {
  const wf = legacyWorkflow();
  return wf && Array.isArray(wf.requirements) ? wf.requirements : [];
}

/** 需求级 Owner 闸门：只有产品评审通过（approved）的需求才等 Owner。 */
function legacyOwnerGateRequirements() {
  return legacyRequirements().filter((req) => String(req.status || '') === 'approved');
}

/**
 * B-dee4：Owner 决定的唯一派生化（decisions[] 末条优先 → 其次 ownerReview.status）。
 * 背景：产品复审/状态推进会重写 ownerReview（status 回到 pending），decisions[] 才是 append-only 真值；
 * 只读 ownerReview 会让 Owner 点过的「通过」在界面上变回「未决定」，甚至两处都看不到（5c19）。
 * 与 owner-review-state.js 的 decisionOf 同口径（那边有就先用那边，保证单一实现）。
 */
function legacyOwnerDecisionOf(req) {
  const state = (typeof window !== 'undefined' && window.OwnerReviewState) ? window.OwnerReviewState : null;
  if (state && typeof state.decisionOf === 'function') return state.decisionOf(req);
  const pick = (value) => {
    const text = String(value === null || value === undefined ? '' : value);
    return ['approved', 'rejected', 'skipped'].includes(text) ? text : '';
  };
  const owner = (req && req.ownerReview && typeof req.ownerReview === 'object') ? req.ownerReview : {};
  const top = (req && Array.isArray(req.decisions)) ? req.decisions.filter(Boolean) : [];
  const legacy = Array.isArray(owner.decisions) ? owner.decisions : [];
  const latest = top.length ? top[top.length - 1] : (legacy.length ? legacy[legacy.length - 1] : null);
  const fromDecision = pick(latest && (latest.status || latest.decision));
  const status = fromDecision || pick(owner.status);
  return {
    status,
    source: fromDecision ? 'decisions' : (status ? 'ownerReview' : 'none'),
    latest: latest || null,
    at: String((latest && latest.at) || owner.at || ''),
    channel: String((latest && latest.channel) || owner.channel || ''),
    recordedBy: String((latest && latest.recordedBy) || owner.recordedBy || ''),
    opinion: String((latest && (latest.opinion || latest.note)) || owner.opinion || '')
  };
}

function legacyReqOwnerView(req) {
  const owner = req && req.ownerReview && typeof req.ownerReview === 'object' ? req.ownerReview : null;
  const decided = legacyOwnerDecisionOf(req);
  if (!owner && !decided.status) return { owner: null, status: 'none', key: 'pending', label: '未决定' };
  const status = decided.status || String((owner && owner.status) || '');
  return {
    owner: owner || { status },
    status: status || 'none',
    key: status || 'optional',
    label: status ? ownerLabel(status) : '未决定',
    source: decided.source,
    at: decided.at || null
  };
}

/**
 * 当前需求：优先取等 Owner 决定的那条，其次取最新一条未收口需求。
 * 用于流程图的 Owner 节点与顶栏提示，避免拿项目级 ownerReview 冒充需求级闸门。
 */
function legacyActiveRequirement() {
  // rejected 也是已收口（投票驳回/评审打回）：不能再被当成“在办需求”占用页头与动作默认值。
  const open = legacyRequirements().filter((req) => !['accepted', 'terminated', 'iteration', 'rejected'].includes(String(req.status || '')));
  if (!open.length) return null;
  const gate = open.find((req) => String(req.status || '') === 'approved');
  if (gate) return gate;
  return open.slice().sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0];
}

/* #region panel-hints-core ──────────────────────────────────────────────
 * R-9fbe / T-20261115-063058-cda1：面板提示分级、账本分叉、boot 口径的唯一判定核心。
 * 约束：本段是纯函数（输入什么就判什么，不读 DOM / legacyUi / state / window），
 *      只允许依赖 esc() 这一个纯工具函数。scripts/test-panel-hints.cjs 直接按
 *      `#region panel-hints-core` / `#endregion panel-hints-core` 抽取本段跑夹具。
 * 标记名 panel-hints-core 被断言脚本依赖，不要改名。
 */

/** 后端确实会拒的错误码白名单：只有命中这里的 topic 才是 block（红），其余一律 warn/info。 */
const PANEL_SEVERITY_BLOCK_CODES = new Set([
  'PLACEHOLDER_DOC',
  'WORKFLOW_TERMINATED',
  'RULES_CHANGED',
  'BOOT_REQUIRED',
  'BOOT_INCOMPLETE',
  'BOOT_EXPIRED',
  'REQUIREMENT_NOT_FOUND',
  'PROJECT_DIR_MISSING',
  'MISSING_DOC',
  'IPC_MISSING',
  'WORKFLOW_STATE_FAILED',
  'WORKFLOW_STATE_CHANGED',
  'OWNER_REVIEW_REQUIRED',
  'DEV_TASKS_UNDONE',
  'TASK_OPEN',
  'LEGACY_PROTOCOL_REQUIRED',
  'PERMISSION_DENIED',
  'PROPOSAL_SCOPE_UNHASHED',
  // R-20261119-140657-a1eb §6.3（T-20261119-141958-16dd）：会话级硬拒——旧会话/不在册的写操作
  // 后端一律零副作用拒绝，界面必须按 block 显示，不能当 warn 放过去让人反复点。
  'SESSION_REPLACED',
  'NOT_IN_ROSTER'
]);

/**
 * 拦截词（block 级专用）：全页只有这一处字符串定义。
 * warn/info 一律走 panelLevelLabel()（「可推进 · 待核验 N 项」/「可推进」），
 * 源码级断言（scripts/test-panel-hints.cjs）按「本串全场只出现一次且落在 block 常量上」校验。
 */
const PANEL_BLOCK_LABEL = '禁止推进';

/** F-9fbe-1：渲染层唯一分级入口，返回 {level,text,action}（外加 id/code 便于断言）。 */
function panelSeverity(topic) {
  const item = topic && typeof topic === 'object' ? topic : {};
  const code = String(item.code || '').trim().toUpperCase();
  // 只有白名单里的错误码才是 block；topic 自己写 level:'block' 也不算（防越权分级）。
  const level = PANEL_SEVERITY_BLOCK_CODES.has(code) ? 'block' : (item.level === 'info' ? 'info' : 'warn');
  const action = item.action && typeof item.action === 'object' ? { ...item.action } : null;
  return {
    id: String(item.id || ''),
    code,
    level,
    text: String(item.text || ''),
    action,
    attrs: String(item.attrs || '')
  };
}

/** 分级 → 人话文案；只有 block 会出现拦截词。 */
function panelLevelLabel(level, count) {
  if (level === 'block') return PANEL_BLOCK_LABEL;
  if (level === 'warn') {
    const n = Math.max(0, Number(count) || 0);
    return n ? `可推进 · 待核验 ${n} 项` : '可推进 · 待核验';
  }
  if (level === 'info') return '可推进 · boot 待核验';
  return '可推进 · 已核验';
}

/** 分级 → 现有配色 class（bad=红 / warn=橙 / muted=灰 / ok=绿）。 */
function panelLevelClass(level) {
  return level === 'block' ? 'bad' : (level === 'warn' ? 'warn' : (level === 'info' ? 'muted' : 'ok'));
}

function panelLevelMark(level) {
  return level === 'block' ? '■' : (level === 'warn' ? '▲' : (level === 'info' ? '●' : '+'));
}

/** 原因行里的动作按钮（只认已接线的 data-legacy-* 锚点，不造新 IPC）。 */
function panelActionMarkup(action) {
  const a = action && typeof action === 'object' ? action : {};
  const kind = String(a.kind || '');
  const value = String(a.value || '');
  const attr = kind === 'go' ? `data-legacy-go="${esc(value)}"`
    : kind === 'doc' ? `data-legacy-doc="${esc(value)}"`
      : kind === 'missing' ? 'data-legacy-missing="1"'
        : kind === 'refresh' ? 'data-legacy-refresh="1"'
          : kind === 'reboot' ? 'data-legacy-reboot="1"'
            : kind === 'ledger' ? 'data-legacy-ledger="1"'
              : kind === 'fix' ? `data-legacy-fix="${esc(value)}"`
                : '';
  if (!attr) return '';
  const title = a.title ? ` title="${esc(a.title)}"` : '';
  return `<button class="ghost small" type="button" ${attr}${title}>${esc(a.label || '处理')}</button>`;
}

/**
 * F-9fbe-2/F-9fbe-3/F-9fbe-6：把「面板事实快照」分级成一个 gate 结果。
 * input 是纯数据（见 legacyGateInput），本函数不读任何全局：
 *   level/label/open/topics（逐条带 data-panel-level）/facts（数字只留属性不给可见文案）/title/detail
 */
function panelGateState(input) {
  const src = input && typeof input === 'object' ? input : {};
  const boot = src.boot && typeof src.boot === 'object' ? src.boot : {};
  const ledger = src.ledger && typeof src.ledger === 'object' ? src.ledger : {};
  const terminated = Boolean(src.terminated);
  const topics = [];
  const add = (topic) => { const row = panelSeverity(topic); topics.push(row); return row; };
  const hasBlock = () => topics.some((row) => row.level === 'block');

  // ① 真阻塞（后端会拒）：preload/IPC、工作流、终止、项目目录、模板占位、必读缺失。
  if (src.hasPreload === false) {
    add({ id: 'preload', code: 'IPC_MISSING', text: 'preload 没有加载：项目文件与 workflow 动作全部不可用', action: { kind: 'refresh', label: '重新读取' } });
  }
  if (src.filesError) {
    add({ id: 'files-error', code: 'FILES_READ_FAILED', text: `项目文件清单读取失败：${src.filesError}`, action: { kind: 'refresh', label: '重试读取' } });
  }
  if (src.workflowError) {
    add({
      id: 'workflow-error',
      code: src.workflowError.code || 'WORKFLOW_STATE_FAILED',
      text: `工作流状态读取失败：${src.workflowError.code || 'WORKFLOW_STATE_FAILED'}`,
      action: { kind: 'refresh', label: '重试读取' }
    });
  } else if (src.workflowPending) {
    add({ id: 'workflow-pending', code: 'WORKFLOW_PENDING', level: 'info', text: '工作流尚未读取：先刷新项目状态', action: { kind: 'refresh', label: '重试读取' } });
  }
  if (terminated) {
    add({ id: 'terminated', code: 'WORKFLOW_TERMINATED', text: src.terminateReason || '工作流已终止：不再接受推进动作' });
  }
  if (src.projectMissing) {
    add({ id: 'project-dir', code: 'PROJECT_DIR_MISSING', text: '项目目录不存在或被移动：先恢复目录再推进', action: { kind: 'refresh', label: '重新检测' } });
  }
  if (src.presenceError) {
    add({
      id: 'presence-error',
      code: 'PRESENCE_FAILED',
      level: 'info',
      text: `文档存在性未核验：${src.presenceError.code || 'PRESENCE_FAILED'}（不判缺失，也不说成齐全）`,
      action: { kind: 'refresh', label: '重试' }
    });
  }
  const placeholders = Array.isArray(src.placeholders) ? src.placeholders.filter(Boolean) : [];
  if (placeholders.length) {
    add({
      id: 'placeholder',
      code: 'PLACEHOLDER_DOC',
      text: `项目信息/项目铁律仍是模板占位：${placeholders.join('、')}`,
      action: src.placeholderDoc ? { kind: 'doc', value: src.placeholderDoc, label: '查看模板占位' } : null
    });
  }
  const missingDocs = Array.isArray(src.missingDocs) ? src.missingDocs.filter(Boolean) : [];
  if (missingDocs.length) {
    add({
      id: 'missing-doc',
      code: 'MISSING_DOC',
      text: `必读文档缺失：${missingDocs.join('、')}`,
      action: { kind: 'missing', label: '打开缺文档清单' }
    });
  }
  if (src.emptyRoles) {
    add({ id: 'no-roles', code: 'NO_ROLES', text: '当前团队模式没有角色定义：先建团队', action: { kind: 'go', value: 'roles', label: '看团队' } });
  }
  const docReadErrors = Array.isArray(src.docReadErrors) ? src.docReadErrors.filter(Boolean) : [];
  if (docReadErrors.length) {
    add({ id: 'doc-read-error', code: 'DOC_READ_FAILED', text: '有必读文档读取失败：界面读不到正文，不代表文件缺失', action: { kind: 'go', value: 'docs', label: '重读文档' } });
  } else if (src.docPendingRead) {
    add({ id: 'doc-pending', code: 'DOC_PENDING', level: 'info', text: '文档正文读取中：读完再判模板占位' });
  }

  // ② 只提示（橙）：boot 未齐/文档变更/round/账本分叉/文件截断/命令缺口。
  if (!boot.known) {
    const code = boot.error && boot.error.code ? String(boot.error.code) : '';
    add({
      id: 'boot-unverified',
      code: 'BRIEFING_UNAVAILABLE',
      level: 'info',
      text: `boot 待核验${code ? `：${code}` : '：后端 briefing 尚未读取'}（不写 0/N，也不当红项）`,
      action: { kind: 'refresh', label: '重试核验' }
    });
  } else {
    if (boot.pending) {
      add({ id: 'boot-pending', code: 'BOOT_PENDING', text: 'boot 未齐：有角色没读全必读（只提示；动作前会自动补 boot）', action: { kind: 'go', value: 'roles', label: '去六角色 boot' } });
    }
    if (boot.stale) {
      add({ id: 'boot-stale', code: 'BOOT_STALE', text: 'boot 之后有必读文档变更（只提示；动作前会重新 boot）', action: { kind: 'go', value: 'roles', label: '重新 boot' } });
    }
    if (boot.roundMismatch) {
      add({ id: 'boot-round', code: 'BOOT_ROUND', text: 'boot 记录属于上一次 round（只提示；动作前会重新 boot）', action: { kind: 'go', value: 'roles', label: '重新 boot' } });
    }
    // F-9fbe-3：TTL 只作橙色 chip，且不得与红字同屏（有 block 时不出现）。
    if (boot.expired && !hasBlock()) {
      add({
        id: 'boot-ttl',
        code: 'BOOT_TTL',
        text: `${boot.expired} 个角色 boot 记录超 TTL（只提示，不拦推进）`,
        attrs: 'data-legacy-expired-summary="1"',
        action: { kind: 'reboot', label: '重新 boot' }
      });
    }
  }
  if (Number(ledger.count) > 0) {
    add({ id: 'ledger-fork', code: 'LEDGER_FORK', text: '账本分叉：旧任务与工作流状态不一致（见下方账本处置行）', action: { kind: 'ledger', label: '看账本处置' } });
  } else if (Number(ledger.inFlight) > 0) {
    add({ id: 'ledger-inflight', code: 'LEDGER_IN_FLIGHT', level: 'info', text: '账本有在途条目：返工在途/任务在办（不计分叉）' });
  }
  if (src.truncated) {
    add({ id: 'truncated', code: 'FILES_TRUNCATED', text: '文件清单已截断（600 项上限）：未列出的不等于缺失' });
  }
  if (src.commandAssumed) {
    add({ id: 'command-assumed', code: 'COMMAND_ASSUMED', text: '旧命令矩阵待核验：按 team.mjs 存在放行基础动作' });
  }
  const commandGaps = Array.isArray(src.commandGaps) ? src.commandGaps.filter(Boolean) : [];
  if (commandGaps.length) {
    add({
      id: 'command-missing',
      code: 'COMMAND_MISSING',
      text: `缺 ${commandGaps.length} 条旧命令：${commandGaps.join('、')}；相关动作已禁用`,
      action: { kind: 'go', value: 'flow', label: '看流程' }
    });
  }
  const commandUnknowns = Array.isArray(src.commandUnknowns) ? src.commandUnknowns.filter(Boolean) : [];
  if (commandUnknowns.length) {
    add({ id: 'command-unknown', code: 'COMMAND_UNKNOWN', text: `旧命令未核验 ${commandUnknowns.length} 条：${commandUnknowns.join('、')}（不写成缺失）` });
  }
  if (src.overviewPlaceholder) {
    add({ id: 'overview-placeholder', code: 'OVERVIEW_PLACEHOLDER', level: 'info', text: '需求总览待首条需求（不挡 boot）' });
  }

  const blocks = topics.filter((row) => row.level === 'block');
  const warns = topics.filter((row) => row.level === 'warn');
  const infos = topics.filter((row) => row.level === 'info');
  const level = blocks.length ? 'block' : (warns.length ? 'warn' : (infos.length ? 'info' : 'ok'));
  const open = blocks.length === 0;
  const label = blocks.length ? panelLevelLabel('block')
    : (warns.length ? panelLevelLabel('warn', warns.length) : (infos.length ? panelLevelLabel('info') : panelLevelLabel('ok')));

  // 补齐入口：把 warn/info 行内的动作去重后放到底部按钮条（F-9fbe-2 的「补齐按钮」）。
  const followUps = [];
  const followSeen = new Set();
  for (const row of [...warns, ...infos]) {
    const action = row.action;
    if (!action || !['go', 'doc', 'missing', 'refresh', 'reboot'].includes(String(action.kind || ''))) continue;
    const key = String(action.kind) + ':' + String(action.value || '');
    if (followSeen.has(key)) continue;
    followSeen.add(key);
    followUps.push(action);
  }

  const bootText = boot.known ? (boot.pending ? 'boot 未齐' : 'boot 已齐/已读') : 'boot 待核验';
  const docText = src.docPendingRead ? '文档读取中'
    : (docReadErrors.length ? '文档读取失败'
      : (missingDocs.length ? '文档待补'
        : (placeholders.length ? '模板占位'
          : (src.hasDocs === false ? '文档 未核验' : '文档已就绪'))));
  const facts = [
    {
      id: 'boot',
      level: boot.known ? (boot.pending ? 'warn' : 'ok') : 'info',
      text: bootText,
      attrs: `data-boot-source="${esc(String(boot.source || 'roles'))}" data-boot-complete="${Number(boot.complete) || 0}" data-boot-total="${Number(boot.total) || 0}" title="boot/已读数字只在顶部「数据真源」条出现一次；N=当前团队角色数（来源：${esc(String(boot.sourceLabel || '团队模式角色'))}）"`
    },
    {
      id: 'docs',
      level: src.docPendingRead ? 'info' : (missingDocs.length || placeholders.length ? 'warn' : (docReadErrors.length ? 'warn' : (src.hasDocs === false ? 'info' : 'ok'))),
      text: docText,
      attrs: `data-missing-doc-count="${missingDocs.length}" title="与缺文档清单 #missing-list 同源（docs:presence 缺口）；数字只在顶部「数据真源」条出现一次"`
    },
    {
      id: 'origin-docs',
      level: placeholders.length ? 'warn' : 'ok',
      text: placeholders.length ? '项目信息/铁律 占位' : '项目信息/铁律 已写实'
    },
    {
      id: 'commands',
      level: src.commandAssumed ? 'warn' : (commandGaps.length || commandUnknowns.length ? 'warn' : 'ok'),
      text: src.commandAssumed ? '旧命令矩阵待核验'
        : (commandGaps.length ? '旧命令有缺口' : (commandUnknowns.length ? '旧命令未核验' : '旧命令齐全'))
    },
    { id: 'phase', level: terminated ? 'block' : 'ok', text: `阶段 ${String(src.phase || '未读取')}` }
  ];

  const title = terminated ? '工作流已终止：不再接受推进'
    : (blocks.length
      ? `${blocks[0].text}${blocks.length > 1 ? `（另有 ${blocks.length - 1} 项阻塞）` : ''} → ${PANEL_BLOCK_LABEL}当前`
      : (warns.length
        ? `${panelLevelLabel('warn', warns.length)}（不影响推进；逐条补齐入口见下）`
        : (infos.length ? `${panelLevelLabel('info')}（不写 0/N，也不当红项）` : '当前必读已核验：六角色 boot 完成，可按角色推进')));
  const detail = blocks.length
    ? '下列阻塞项都是后端真会拒的（<code>PLACEHOLDER_DOC</code> / <code>RULES_CHANGED</code> 等）：先按行内入口处理，界面不绕过、不改 JSON。'
    : `后端 <code>workflow:briefing</code> 与 <code>docs:presence</code> 是唯一真源；橙色/灰色项只提示，动作执行前界面会先补一次真实 boot，后端仍校验阅读证据。当前工作流阶段：<code>${esc(String(src.phase || '未读取'))}</code>。`;
  return {
    level,
    label,
    open,
    terminated,
    phase: String(src.phase || '未读取'),
    blockCount: blocks.length,
    warnCount: warns.length,
    infoCount: infos.length,
    blocks,
    warns,
    infos,
    topics,
    facts,
    followUps,
    title,
    detail,
    bootText,
    docText,
    missingDocCount: missingDocs.length
  };
}

/** gate 结果渲染（纯函数）：根节点与每条原因都带 data-panel-level，供 AC1 直接断言。 */
function panelGateMarkup(gate, options) {
  const g = gate && typeof gate === 'object' ? gate : { topics: [], facts: [], level: 'ok', title: '', detail: '', label: '', followUps: [] };
  const opts = options && typeof options === 'object' ? options : {};
  const level = String(g.level || 'ok');
  const cls = level === 'ok' ? ' ok' : (level === 'warn' ? ' warn' : (level === 'info' ? ' info' : ''));
  const facts = (g.facts || []).map((fact) => {
    const factLevel = String(fact.level || 'ok');
    return `<span class="${panelLevelClass(factLevel)}" data-panel-level="${factLevel}"${fact.attrs ? ' ' + fact.attrs : ''}>${esc(fact.text)}</span>`;
  }).join('');
  const rows = (g.topics || []).map((row) => {
    const rowLevel = String(row.level || 'warn');
    return `<div class="legacy-gate-reason ${panelLevelClass(rowLevel)}" data-panel-level="${rowLevel}" data-panel-topic="${esc(row.id)}" data-panel-code="${esc(row.code)}"${row.attrs ? ' ' + row.attrs : ''}>
      <span class="legacy-gate-reason-mark" aria-hidden="true">${panelLevelMark(rowLevel)}</span>
      <span class="legacy-gate-reason-text">${esc(row.text)}</span>
      ${row.action ? panelActionMarkup(row.action) : ''}
    </div>`;
  }).join('');
  const followUps = (g.followUps || []).map((action) => panelActionMarkup(action)).join('');
  return `<div class="legacy-gate-result${cls}" data-panel-level="${level}" data-gate-open="${g.open ? '1' : '0'}" data-gate-block="${Number(g.blockCount) || 0}" data-gate-warn="${Number(g.warnCount) || 0}" data-gate-info="${Number(g.infoCount) || 0}">
    <span class="legacy-gate-mark" aria-hidden="true">${panelLevelMark(level)}</span>
    <div>
      <b>${esc(g.title || '')}</b>
      <p>${g.detail || ''}</p>
      <div class="legacy-gate-facts">${facts}</div>
      ${rows ? `<div class="legacy-gate-reasons">${rows}</div>` : ''}
      ${opts.actions || followUps ? `<div class="legacy-gate-actions">${opts.actions || ''}${followUps}</div>` : ''}
    </div>
  </div>`;
}

/**
 * 旧算法：只比 工作流.json 状态 × 任务状态（无「重开时间」维度）。
 * 只在快照缺 ledger 字段时由 ledgerViewFromSnapshot 回退调用。
 */
function legacyRequirementLedger(req) {
  const status = String((req && req.status) || '');
  const taskStatus = String((req && req.taskStatus) || '');
  const closed = ['accepted', 'terminated', 'iteration'].includes(status);
  const staleOpen = Boolean(taskStatus && taskStatus !== 'done' && closed);
  const staleDone = Boolean(taskStatus === 'done' && !closed);
  return {
    kind: 'legacy',
    status,
    taskStatus,
    staleOpen,
    staleDone,
    label: staleOpen
      ? `任务 ${taskStatus} · 工作流已${status === 'terminated' ? '终止' : '收口'}，账本未同步（旧判据）`
      : (staleDone ? '任务已完成 · 工作流未收口（旧判据，待后端快照升级）' : '')
  };
}

/**
 * F-9fbe-4：账本分叉唯一取数（快照优先，缺字段才回退旧算法）。
 * input: {hasWorkflow, requirements, ledger, counts}
 * 返回 {known, source:'snapshot'|'legacy'|'none', forks, inFlight, count, inFlightCount, rowsComplete}
 */
function ledgerViewFromSnapshot(input) {
  const src = input && typeof input === 'object' ? input : {};
  const requirements = Array.isArray(src.requirements) ? src.requirements : [];
  const ledger = src.ledger && typeof src.ledger === 'object' ? src.ledger : null;
  const counts = src.counts && typeof src.counts === 'object' ? src.counts : null;
  const view = { known: Boolean(src.hasWorkflow), source: 'none', forks: [], inFlight: [], count: 0, inFlightCount: 0, rowsComplete: true };
  if (!view.known) return view;
  const hasField = (row, key) => Boolean(row) && Object.prototype.hasOwnProperty.call(row, key);
  const hasRowFields = requirements.some((row) => hasField(row, 'ledgerFork') || hasField(row, 'ledgerInFlight'));
  const topForks = ledger && Array.isArray(ledger.forks) ? ledger.forks : null;
  const topInFlight = ledger && Array.isArray(ledger.inFlight) ? ledger.inFlight : null;
  const countForks = counts && Number.isFinite(Number(counts.ledgerForks)) ? Number(counts.ledgerForks) : null;
  const countInFlight = counts && Number.isFinite(Number(counts.ledgerInFlight)) ? Number(counts.ledgerInFlight) : null;
  const snapshotReady = hasRowFields || Boolean(topForks) || Boolean(topInFlight) || countForks !== null;
  if (!snapshotReady) {
    // 快照缺 ledger 字段（旧主进程/旧工具）：回退旧算法，容器照实标 data-ledger-source="legacy"。
    view.source = 'legacy';
    for (const req of requirements) {
      const row = legacyRequirementLedger(req);
      if (row.staleDone || row.staleOpen) view.forks.push({ req, ledger: row });
    }
    view.count = view.forks.length;
    return view;
  }
  view.source = 'snapshot';
  const reqOf = (id) => requirements.find((row) => String((row && row.id) || '') === String(id || '')) || { id: String(id || ''), status: '' };
  if (hasRowFields) {
    for (const req of requirements) {
      if (req && req.ledgerFork) view.forks.push({ req, ledger: ledgerForkRow(req, req.ledgerFork) });
    }
    for (const req of requirements) {
      if (req && req.ledgerInFlight) {
        view.inFlight.push({ req, kind: String(req.ledgerInFlight), reopenedAt: String(req.reopenedAt || ''), taskDoneAt: '' });
      }
    }
  }
  if (!view.forks.length && topForks) {
    for (const fork of topForks) {
      const req = reqOf(fork && fork.requirementId);
      view.forks.push({ req, ledger: ledgerForkRow(req, fork) });
    }
  }
  if (!view.inFlight.length && topInFlight) {
    for (const row of topInFlight) {
      const req = reqOf(row && row.requirementId);
      view.inFlight.push({ req, kind: String((row && row.kind) || ''), reopenedAt: String((row && row.reopenedAt) || ''), taskDoneAt: String((row && row.taskDoneAt) || '') });
    }
  }
  view.count = Math.max(view.forks.length, Number.isFinite(countForks) ? countForks : 0);
  view.inFlightCount = Math.max(view.inFlight.length, Number.isFinite(countInFlight) ? countInFlight : 0);
  view.rowsComplete = view.forks.length >= view.count;
  return view;
}

/** 分叉行文案（不写「任务已完成 · 工作流未收口」这类旧误导口径）。 */
function ledgerForkRow(req, fork) {
  const src = fork && typeof fork === 'object' ? fork : {};
  const kind = String(src.kind || '');
  const status = String((req && req.status) || src.status || '');
  const label = kind === 'dev_ledger_ahead'
    ? '开发任务已全部完成 · 工作流还停在开发前/开发中'
    : (kind === 'test_ledger_ahead'
      ? '测试任务已全部完成 · 工作流还停在开发完成/测试'
      : (kind === 'legacy' ? String(src.label || '任务状态与工作流不一致') : '任务状态与工作流不一致'));
  return {
    kind: kind || 'unknown',
    taskId: String(src.taskId || ''),
    taskDoneAt: String(src.taskDoneAt || ''),
    reopenedAt: String(src.reopenedAt || (req && req.reopenedAt) || ''),
    status,
    label
  };
}

/**
 * F-9fbe-4：单条需求的账本小字（需求卡片 / 行内用）。
 * **只认快照 ledger 字段**（`ledgerFork` / `ledgerInFlight`）：
 *   - `ledgerFork` 非 null → kind='fork'（才算分叉，橙）
 *   - `ledgerInFlight` 非空 → kind='inflight'（返工在途/任务在办，中性，**不计分叉**）
 *   - 行上有字段但都为空 → 账本一致，不出小字
 *   - 行上连字段都没有（旧主进程/旧工具）→ 才回退旧判据，kind='legacy' 且文案自报「旧判据」。
 * 这样旧算法的「任务已完成 · 工作流未收口」不会与真源条的分叉数同屏出现两个口径。
 * 返回 {kind:'fork'|'inflight'|'legacy'|'', level, label, fork}
 */
function ledgerRowNote(req) {
  const row = req && typeof req === 'object' ? req : {};
  const has = (key) => Object.prototype.hasOwnProperty.call(row, key);
  if (row.ledgerFork) {
    const fork = ledgerForkRow(row, row.ledgerFork);
    return { kind: 'fork', level: 'warn', label: fork.label, fork };
  }
  const flight = String(row.ledgerInFlight || '');
  if (flight) {
    const label = flight === 'rework_in_flight'
      ? '返工在途（任务完成时间早于重开时间）· 不计分叉'
      : (flight === 'task_in_progress' ? '任务在办 · 不计分叉' : '账本在途 · 不计分叉');
    return { kind: 'inflight', level: 'info', label, fork: null };
  }
  if (has('ledgerFork') || has('ledgerInFlight')) return { kind: '', level: 'ok', label: '', fork: null };
  // 快照缺 ledger 字段：旧主进程才回退（label 里已自带「旧判据」字样）。
  const legacy = legacyRequirementLedger(row);
  if (!legacy.staleDone && !legacy.staleOpen) return { kind: '', level: 'ok', label: '', fork: null };
  return { kind: 'legacy', level: 'warn', label: legacy.label, fork: null };
}

/** 时间只做截断显示，不引入额外格式化依赖（纯函数，测试可直接跑）。 */
function ledgerWhenText(value) {
  const text = String(value || '');
  if (!text) return '';
  return text.replace('T', ' ').replace(/\.\d+Z?$/, '').replace(/Z$/, '').slice(0, 19);
}

/**
 * F-9fbe-5：处置结果的人话横幅（成功/失败/NOOP 都留痕，失败带错误码；不静默）。
 * 纯函数：只用 esc，抽段断言可直接跑（见 scripts/test-ledger-actions.cjs）。
 */
function ledgerBannerMarkup(banner) {
  if (!banner || typeof banner !== 'object') return '';
  const text = String(banner.text || '');
  if (!text) return '';
  const kind = ['ok', 'bad', 'warn', 'info'].includes(String(banner.kind)) ? String(banner.kind) : 'info';
  const code = String(banner.code || '');
  const mark = kind === 'ok' ? '✓ ' : (kind === 'bad' ? '⚠ ' : '· ');
  return `<div class="legacy-action-warn" data-ledger-banner="1" data-ledger-banner-kind="${kind}" data-ledger-code="${esc(code)}" data-panel-level="${kind === 'ok' ? 'info' : 'warn'}">${mark}${esc(text)}${code ? `（错误码 <code>${esc(code)}</code>）` : ''}</div>`;
}

/**
 * F-9fbe-5：分叉处置行。两个按钮只在后端真有 IPC 时出现；否则行内写清手动命令（壳不自写 JSON）。
 * 按钮不可点时必须带原因：title + 行内说明（data-ledger-disabled）。
 * options: {statusLabel(req), actionAvailable:{taskRelease,requirementReopen},
 *           actionEnabled:{taskRelease,requirementReopen,reason}, banner, projectName}
 */
function ledgerMarkupFromView(view, options) {
  const v = view && typeof view === 'object' ? view : {};
  const opts = options && typeof options === 'object' ? options : {};
  if (!v.known) return '';
  const banner = ledgerBannerMarkup(opts.banner);
  const forks = Array.isArray(v.forks) ? v.forks : [];
  const inFlight = Array.isArray(v.inFlight) ? v.inFlight : [];
  const count = Number(v.count) || 0;
  if (!count && !inFlight.length) return banner;
  const source = v.source === 'legacy' ? 'legacy' : 'snapshot';
  const statusLabel = typeof opts.statusLabel === 'function' ? opts.statusLabel : (req) => String((req && req.status) || '');
  const actions = opts.actionAvailable && typeof opts.actionAvailable === 'object' ? opts.actionAvailable : {};
  // 不可点原因：并发（正在处置）/ 没有 PM 令牌 / 其它由主进程下发的禁用原因。禁用必须写在 title 与行内。
  const enabled = opts.actionEnabled && typeof opts.actionEnabled === 'object' ? opts.actionEnabled : null;
  const whyOf = (key) => {
    if (!enabled) return '';
    if (enabled[key] === true) return '';
    return String(enabled.reason || '按钮已禁用');
  };
  const actionButton = (key, attrs, label, title) => {
    const why = whyOf(key);
    if (why) {
      return `<span class="legacy-ledger-why" data-ledger-disabled="${esc(key)}" title="${esc(`${label} 暂不可点：${why}`)}"><button class="ghost small" type="button" ${attrs} disabled title="${esc(`${title}（暂不可点：${why}）`)}">${label}</button><span class="legacy-ledger-why-text">${esc(why)}</span></span>`;
    }
    return `<button class="ghost small" type="button" ${attrs} title="${esc(title)}">${label}</button>`;
  };
  const level = count ? 'warn' : 'info';
  const projectName = String(opts.projectName || '');
  // 渲染期把项目 id 固化到按钮上：处置行可能在下一次轮询后仍留在 DOM，
  // 而 activeProject() 可能因 store 刷新/点项目触发 reload 而瞬时为 null（测试 v170 复现：先选中项目后仍被挡回）。
  // 取数优先级：① 渲染这份账本用的工作流快照 id（与渲染同源）② 当前项目 ③ 页面 [data-project] 唯一项。
  const ctxProjectId = (() => {
    try {
      const wf = legacyWorkflow();
      if (wf && wf.id) return String(wf.id);
    } catch { /* 忽略 */ }
    try { const ap = activeProject(); if (ap && ap.id) return String(ap.id); } catch { /* 忽略 */ }
    try {
      const nodes = [...document.querySelectorAll('[data-project]')];
      const ids = nodes.map((n) => String(n.getAttribute('data-project') || '')).filter(Boolean);
      const uniq = [...new Set(ids)];
      if (uniq.length === 1) return uniq[0];
    } catch { /* 忽略 */ }
    return '';
  })();
  const projAttr = ctxProjectId ? ` data-ledger-project="${esc(ctxProjectId)}"` : '';
  const head = count
    ? '账本对不上：下列需求的任务状态与工作流不一致；界面只读显示，处置走 team.mjs（不改 JSON）'
    : '账本有在途条目：返工在途/任务在办，不计分叉';
  const rows = forks.map((row) => {
    const req = row.req || {};
    const item = row.ledger || {};
    const doneAt = ledgerWhenText(item.taskDoneAt);
    const reopenedAt = ledgerWhenText(item.reopenedAt);
    const buttons = (actions.taskRelease || actions.requirementReopen)
      ? `<span class="legacy-ledger-actions">${actions.taskRelease && item.taskId ? actionButton('taskRelease', `data-ledger-action="task-release"${projAttr} data-ledger-task="${esc(item.taskId)}" data-ledger-req="${esc(req.id || '')}"`, '收口旧任务', '把旧任务退回未收口（走 team.mjs task release + 审计）') : ''}${actions.requirementReopen ? actionButton('requirementReopen', `data-ledger-action="requirement-reopen"${projAttr} data-ledger-req="${esc(req.id || '')}" data-ledger-task="${esc(item.taskId || '')}"`, '重开需求记录', '把需求记录重开为返工（走 team.mjs req reopen + 审计）') : ''}</span>`
      : `<span class="legacy-ledger-nocmd" data-ledger-no-command="1">本版后端无处置命令，请手动执行 <code>team.mjs task release --project ${esc(projectName)} --id ${esc(item.taskId || '<任务id>')}</code> 或 <code>team.mjs req reopen --project ${esc(projectName)} --requirement ${esc(req.id || '')}</code>（带 --boot 令牌，写审计）</span>`;
    return `<div class="legacy-ledger-row" data-panel-level="warn" data-ledger-fork="${esc(req.id || '')}" data-ledger-status="${esc(item.status || '')}" data-ledger-kind="${esc(item.kind || '')}">
      <code>${esc(req.id || '')}</code><span>${esc(statusLabel(req))}</span><b>${esc(item.label || '')}</b>
      <span class="legacy-ledger-when">${item.taskId ? `任务 <code>${esc(item.taskId)}</code>` : ''}${doneAt ? ` 完成于 ${esc(doneAt)}` : ''}${reopenedAt ? ` · 重开 ${esc(reopenedAt)}` : ''}</span>
      ${buttons}
    </div>`;
  }).join('');
  const inFlightRows = inFlight.map((row) => {
    const req = row.req || {};
    const kind = String(row.kind || '');
    const kindText = kind === 'rework_in_flight' ? '返工在途（任务完成时间早于重开时间）' : (kind === 'task_in_progress' ? '任务在办' : '在途');
    return `<div class="legacy-ledger-row in-flight" data-panel-level="info" data-ledger-inflight="${esc(kind)}">
      <code>${esc(req.id || '')}</code><span>${esc(statusLabel(req))}</span><b>${esc(kindText)}</b><span class="legacy-ledger-when">不计分叉</span>
    </div>`;
  }).join('');
  // F-9fbe-4：在途条数单独成一个 chip（`data-ledger-inflight-count`），
  // 分叉数只用 `data-ledger-count`——两个数字各有出处，在途绝不并进分叉。
  const inFlightListed = inFlight.length;
  const inFlightTotal = Math.max(Number(v.inFlightCount) || 0, inFlightListed);
  const reworkCount = inFlight.filter((row) => String((row && row.kind) || '') === 'rework_in_flight').length;
  const taskCount = inFlightListed - reworkCount;
  const inFlightChip = inFlightTotal
    ? `<span class="legacy-ledger-inflight" data-ledger-inflight-count="${inFlightTotal}" data-ledger-rework-count="${reworkCount}" data-ledger-task-count="${taskCount}" data-panel-level="info">在途 ${inFlightTotal} 条：返工在途 ${reworkCount} · 任务在办 ${taskCount}（不计分叉）</span>`
    : '';
  return `${banner}<div class="legacy-ledger ${level}" data-ledger-source="${source}" data-ledger-count="${count}" data-ledger-inflight="${inFlightTotal}" data-panel-level="${level}">
    <div class="legacy-ledger-head">
      <b>账本核对</b>
      <span>${esc(head)}</span>
      ${inFlightChip}
      <span class="legacy-ledger-source" data-ledger-source-label="${source}">${source === 'snapshot' ? '来源：workflow:state 快照（ledgerFork / ledger.inFlight）' : '来源：旧算法（快照缺 ledger 字段）'}</span>
    </div>
    ${rows}
    ${inFlightRows}
  </div>`;
}

/** 单角色 boot 口径：round 相同 + 非旧会话 + 必读读全 才算「本轮有效」；TTL 过期只提示。 */
function bootRowFrom(context, roleId) {
  const ctx = context && typeof context === 'object' ? context : {};
  const briefing = ctx.briefing || null;
  const briefingRoles = briefing && briefing.roles ? briefing.roles : {};
  const row = roleId && briefingRoles[roleId] ? briefingRoles[roleId] : null;
  const evidence = (row && row.evidence)
    || (briefing && briefing.evidence && briefing.evidence.roles ? briefing.evidence.roles[roleId] : null)
    || null;
  const ttlMinutes = Number(ctx.ttlMinutes) > 0 ? Number(ctx.ttlMinutes) : 480;
  const now = Number.isFinite(Number(ctx.now)) ? Number(ctx.now) : Date.now();
  const currentRound = Number(ctx.round) > 0 ? Number(ctx.round) : null;
  const staleSession = Boolean(evidence && evidence.state === 'stale-session');
  if (!row) {
    return {
      known: Boolean(briefing),
      booted: false,
      complete: false,
      valid: false,
      ready: false,
      stale: false,
      round: null,
      roundMismatch: false,
      staleSession,
      unbound: Boolean(evidence && evidence.state === 'unbound'),
      at: null,
      missing: [],
      expired: false,
      expiresAt: null,
      remainingMs: null,
      ttlMinutes,
      label: evidence ? '已 BOOT' : (briefing ? '未 boot' : '未核验'),
      evidence
    };
  }
  const bootRound = row.round ? Number(row.round) : null;
  // 后端 requireWorkflowBoot 会拒绝跨 round 的 boot；界面同步标出来，但只作提示。
  const roundMismatch = Boolean(bootRound && currentRound && bootRound !== currentRound);
  const bootAtMs = row.at ? Date.parse(String(row.at)) : NaN;
  const expiresAt = Number.isFinite(bootAtMs) ? bootAtMs + ttlMinutes * 60000 : null;
  // B-2e5：boot 记录超 TTL 只作记录/提示，不再当作红项或门槛。
  const expired = Boolean(row.booted) && (!Number.isFinite(bootAtMs) || now > expiresAt);
  const reasons = [];
  if (roundMismatch) reasons.push(`boot 记录属于上一次 round（当前第 ${currentRound} 轮，只提示）`);
  if (expired) reasons.push(Number.isFinite(bootAtMs) ? `boot 记录超 TTL（超过 ${ttlMinutes} 分钟，仅提示）` : 'boot 时间未记录（仅提示）');
  if (row.stale) reasons.push('boot 后文档已变更');
  if (!row.complete) reasons.push('必读未读全');
  if (staleSession) reasons.push('boot 来自旧会话');
  const label = !row.booted ? '未 boot' : (reasons.length ? reasons.join(' · ') : '已 boot / 已读全');
  // 「本轮且有效」：round 相同 + 非旧会话 + 必读读全 + boot 后文档未变；TTL 单独只提示。
  const valid = Boolean(row.booted && row.complete && !row.stale && !roundMismatch && !staleSession);
  return {
    known: true,
    booted: Boolean(row.booted),
    complete: Boolean(row.complete),
    valid,
    ready: valid && !expired,
    stale: Boolean(row.stale),
    round: bootRound,
    roundMismatch,
    staleSession,
    unbound: Boolean(evidence && evidence.state === 'unbound'),
    at: row.at || null,
    missing: Array.isArray(row.missing) ? row.missing : [],
    expired,
    expiresAt,
    remainingMs: expiresAt ? Math.max(0, expiresAt - now) : null,
    ttlMinutes,
    label,
    evidence
  };
}

/** boot 汇总：N = 当前团队角色数；briefing 没取到就写「待核验」，不给出 0/N。 */
function bootSummaryFrom(context) {
  const ctx = context && typeof context === 'object' ? context : {};
  const ids = (Array.isArray(ctx.roleIds) ? ctx.roleIds : []).map((id) => String(id || '')).filter(Boolean);
  const rows = ids.map((id) => ({ roleId: id, boot: bootRowFrom(ctx, id) }));
  const known = Boolean(ctx.briefing);
  const countOf = (predicate) => rows.filter((row) => predicate(row.boot)).length;
  const valid = countOf((boot) => boot.valid);
  return {
    known,
    rows,
    total: rows.length,
    complete: valid,
    valid,
    booted: countOf((boot) => boot.booted),
    stale: countOf((boot) => boot.stale),
    roundMismatch: countOf((boot) => boot.roundMismatch),
    staleSession: countOf((boot) => boot.staleSession),
    expired: countOf((boot) => boot.expired),
    pending: rows.length ? rows.length - valid : 0,
    allBooted: rows.length > 0 && rows.every((row) => row.boot.booted),
    allComplete: known && rows.length > 0 && valid === rows.length,
    source: String(ctx.source || 'roles'),
    sourceLabel: String(ctx.sourceLabel || ''),
    countText: known ? `${valid}/${rows.length}` : '待核验'
  };
}

/** boot 数字唯一显示口：没取到 briefing 时返回「待核验」（绝不返回 0/N）。 */
function bootCountText(summary) {
  const s = summary && typeof summary === 'object' ? summary : {};
  if (!s.known) return '待核验';
  const complete = Number(s.complete) || 0;
  const total = Number(s.total) || 0;
  return `${complete}/${total}`;
}

/** boot 状态文案（不带数字，供目录/团队/流程等第二处引用）。 */
function bootStatusText(summary) {
  const s = summary && typeof summary === 'object' ? summary : {};
  if (!s.known) return 'boot 待核验';
  return s.allComplete ? 'boot 已齐/已读' : 'boot 未齐';
}

/* #endregion panel-hints-core */

/** F-9fbe-4：面板读账本只走这里——快照字段优先，缺字段才回退旧算法。 */
function legacyLedgerView() {
  const wf = legacyWorkflow();
  return ledgerViewFromSnapshot({
    hasWorkflow: Boolean(wf),
    requirements: legacyRequirements(),
    ledger: wf && wf.ledger ? wf.ledger : null,
    counts: wf && wf.counts ? wf.counts : null
  });
}

function legacyLedgerDivergences() {
  return legacyLedgerView().forks;
}

/**
 * F-9fbe-5：处置按钮只在后端真有 IPC 时才出现。
 * R-9fbe / T-ed7：主进程已新增 owner:ledger-close-task / owner:ledger-reopen（preload 名
 * ownerLedgerCloseTask / ownerLedgerReopen）；旧 preload 里的 taskRelease / requirementReopen 仍认。
 */
function legacyLedgerActionAvailable() {
  const wb = window.workbench || null;
  const has = (...names) => names.some((name) => Boolean(wb && typeof wb[name] === 'function'));
  return {
    taskRelease: has('ownerLedgerCloseTask', 'taskRelease'),
    requirementReopen: has('ownerLedgerReopen', 'requirementReopen')
  };
}

/** F-9fbe-5：处置动作的界面状态（并发：点击后按钮立即禁用直到刷新完成；结果横幅不静默）。 */
const ledgerActionUi = { busy: false, busyKey: '', banner: null, lastAt: 0 };

/** 从 IPC 异常里取结构化错误码（主进程 codedError 会把 [CODE] 写进 message）。 */
function ledgerErrorCodeOf(error) {
  const text = String((error && error.message) || error || '');
  const hit = text.match(/\[([A-Z][A-Z0-9_]+)\]/);
  if (hit) return hit[1];
  return String((error && error.code) || '');
}

/**
 * F-9fbe-5：处置按钮三态（没有接口 / 有接口但需要 PM 令牌 / 可点），禁用原因一律给文案。
 * PM 令牌状态来自 workflow:state 的 ledgerActions（主进程只读下发，不含令牌值）。
 */
function legacyLedgerActionState() {
  const ipc = legacyLedgerActionAvailable();
  const wf = legacyWorkflow();
  const meta = wf && wf.ledgerActions && typeof wf.ledgerActions === 'object' ? wf.ledgerActions : null;
  const pm = meta && meta.pmToken && typeof meta.pmToken === 'object' ? meta.pmToken : null;
  const busy = Boolean(ledgerActionUi.busy);
  // 主进程没下发字段时不假装禁用（点下去仍会被主进程复核）；下发了 ok=false 才禁用并给原因。
  const pmOk = pm ? pm.ok !== false : true;
  const reasons = [];
  if (busy) reasons.push('正在处置，等刷新完成');
  if (pm && pm.ok === false) reasons.push(String(pm.reason || '需要 PM 令牌：团队里没有可用的 pm 启动令牌（请 PM 先 boot，或由 PM 处置）'));
  const disabledReason = reasons.join('；');
  const canAct = !busy && pmOk;
  return {
    taskRelease: ipc.taskRelease,
    requirementReopen: ipc.requirementReopen,
    canCloseTask: ipc.taskRelease && canAct,
    canReopen: ipc.requirementReopen && canAct,
    busy,
    pmKnown: Boolean(pm),
    pmOk,
    disabledReason,
    auditFile: meta ? String(meta.auditFile || '') : ''
  };
}

function legacyLedgerMarkup() {
  const view = legacyLedgerView();
  const actions = legacyLedgerActionState();
  return ledgerMarkupFromView(view, {
    statusLabel: legacyReqStatus,
    actionAvailable: { taskRelease: actions.taskRelease, requirementReopen: actions.requirementReopen },
    actionEnabled: {
      taskRelease: actions.canCloseTask,
      requirementReopen: actions.canReopen,
      reason: actions.disabledReason
    },
    banner: ledgerActionUi.banner,
    projectName: (activeProject() && activeProject().name) || ''
  });
}

/** 只重画账本块（概览页 + 流程页同源），不整块重排流程。 */
function ledgerRenderLedgerBlock() {
  const p = activeProject();
  if (!p) return;
  try { renderLegacyGate(p); } catch { /* 概览页没渲染出来时忽略 */ }
  const flowBox = $('#legacy-flow-ledger');
  if (flowBox) flowBox.innerHTML = legacyLedgerMarkup();
}

/** 处置后刷新：强制重绘一次流程（签名没变也要重画），失败退回一次只读重读。 */
async function ledgerRefreshAfterAction() {
  flowRenderUi.projectId = '';
  flowRenderUi.sig = '';
  let ok = false;
  try { ok = await refreshFlowLive(); } catch { ok = false; }
  if (!ok) {
    // 浮窗/抽屉未打开时 refreshFlowLive 会主动跳过；这里退回一次只读重读（仍不写任何文件）。
    try { await loadLegacyDocs(true); } catch { /* 下一次 5 秒轮询会补上，横幅已经在 */ }
  }
  return ok;
}

/**
 * F-9fbe-5：处置失败码 → 人话补齐（错误码原样保留，另给「接下来怎么办」）。
 * 需求 §六「并发/权限/降级」：状态已变、缺 PM 令牌、审计写不进都要说清且零副作用。
 */
function ledgerActionHint(code) {
  const key = String(code || '');
  const table = {
    WORKFLOW_STATE_CHANGED: '账本状态已变化（可能别人先处置了），本次零副作用；面板已刷新，请按最新分叉再处置',
    PM_TOKEN_REQUIRED: '需要 PM 令牌：请让 PM 先 boot，或由 PM 在终端处置；界面不自代签',
    LEDGER_TASK_MISSING: '分叉里没有任务 id，收口不了旧任务；可改用「重开需求记录」',
    LEDGER_AUDIT_UNWRITABLE: '审计目录不可写，已中止，零副作用；先修目录权限再处置',
    LEDGER_AUDIT_FAILED: '命令已执行但审计没落盘，需要人工补录（记录已回放在返回里）',
    LEDGER_IPC_MISSING: '当前 preload 没有处置 IPC，重启工作台或更新版本',
    WORKFLOW_STATE_UNREADABLE: '工作流快照读不出来，先修读取再处置（零副作用）',
    REQUIREMENT_NOT_FOUND: '工作流里没有这条需求，先 req sync 登记',
    REOPEN_NOT_APPLICABLE: '该需求当前状态不适用返工（req reopen 只接受 dev_done / test_done）',
    LEDGER_ACTION_BAD_BUTTON: '按钮标记不完整（没有 data-ledger-action），界面没发起任何命令；刷新面板后重试',
    LEDGER_ACTION_NO_PROJECT: '先在工作区里选中项目，再点处置',
    LEDGER_ACTION_BUSY: '上一次处置还在刷新，等按钮恢复可点再点',
    LEDGER_ACTION_DISABLED: '按钮被禁用（原因见行内说明）：先按原因处理，再处置',
    LEDGER_COMMAND_TIMEOUT: '团队工具命令超时被中止，可能已部分执行：先看 账本处置.jsonl 再决定是否重试'
  };
  return table[key] || '';
}

/**
 * F-9fbe-5：点处置按钮 → 调 owner:ledger-close-task / owner:ledger-reopen。
 * 约定：点击后按钮立即禁用直到刷新完成；失败给人话横幅 + 错误码；成功后重读快照重绘。
 * 处置前 fresh 读在工作主进程做，界面只把当前快照的 status/kind/taskId 当 expect 传过去。
 */
async function ledgerActionRun(button) {
  const wb = window.workbench || null;
  const activeNow = activeProject();
  // 测试 v170 现场：行还在 DOM，但 activeProject() 因 store 刷新短暂为 null → 点一下只报「先选中项目」。
  // 处置按钮在渲染期已把项目 id 固化到 data-ledger-project，优先用它；再退回 activeProject()。
  const datasetEarly = button && button.dataset ? button.dataset : null;
  const attrProjectId = button && typeof button.getAttribute === 'function' ? String(button.getAttribute('data-ledger-project') || '') : '';
  const projectId = String((datasetEarly && datasetEarly.ledgerProject) || attrProjectId || (activeNow && activeNow.id) || '');
  const p = projectId ? (activeNow && String(activeNow.id) === projectId ? activeNow : { id: projectId }) : null;
  // 坑（v169 真窗口 0 效果的根因）：data-ledger-action / -req / -task 只在 HTMLButtonElement.dataset 上，
  // 元素本身没有 ledgerAction/ledgerReq/ledgerTask 属性；以前从元素上读 → kind 恒空 → 只 toast 直接 return，
  // 不进 IPC、不写横幅、分叉不动。断言脚本只做源码正则，抓不到，所以必须从 dataset 读。
  const dataset = button && button.dataset ? button.dataset : null;
  const el = button && typeof button.closest === 'function' ? button : null;
  const kind = String((dataset && dataset.ledgerAction) || '');
  const requirementId = String((dataset && dataset.ledgerReq) || '');
  const taskId = String((dataset && dataset.ledgerTask) || '');
  if (!p || !kind) {
    // F-9fbe-5：失败也必须落到 [data-ledger-banner]（只 toast 等于静默）。
    const code = p ? 'LEDGER_ACTION_BAD_BUTTON' : 'LEDGER_ACTION_NO_PROJECT';
    const text = p
      ? '这个处置按钮没有带 data-ledger-action（按钮标记不完整），界面无法发起处置，没有改任何文件'
      : '账本处置入口不可用：先选中项目';
    ledgerActionUi.banner = { kind: 'bad', text, code };
    ledgerActionUi.lastAt = Date.now();
    try { ledgerRenderLedgerBlock(); } catch { /* 概览页没渲染出来时忽略 */ }
    toast(text, 'bad');
    return;
  }
  if (ledgerActionUi.busy) {
    ledgerActionUi.banner = { kind: 'warn', text: '上一次处置还没刷新完，等面板刷新后再点（本次没有发起任何命令）', code: 'LEDGER_ACTION_BUSY' };
    ledgerActionUi.lastAt = Date.now();
    try { ledgerRenderLedgerBlock(); } catch { /* 概览页没渲染出来时忽略 */ }
    toast('上一次处置还没刷新完，等面板刷新后再点', 'warn');
    return;
  }
  const row = el ? el.closest('[data-ledger-fork]') : null;
  const expect = {
    status: row ? String(row.getAttribute('data-ledger-status') || '') : '',
    ledgerForkKind: row ? String(row.getAttribute('data-ledger-kind') || '') : '',
    taskId
  };
  // 并发：点击后立刻进入 busy，所有处置按钮同时禁用，直到刷新完成。
  ledgerActionUi.busy = true;
  ledgerActionUi.busyKey = `${kind}:${requirementId}`;
  ledgerActionUi.banner = { kind: 'info', text: `正在按团队工具协议处置 ${requirementId}（PM 令牌执行 + append-only 审计）…` };
  ledgerActionUi.lastAt = Date.now();
  ledgerRenderLedgerBlock();
  try {
    const fn = kind === 'task-release'
      ? (wb && (wb.ownerLedgerCloseTask || wb.taskRelease))
      : (wb && (wb.ownerLedgerReopen || wb.requirementReopen));
    if (typeof fn !== 'function') throw new Error('[LEDGER_IPC_MISSING] 当前 preload 没有账本处置 IPC（ownerLedgerCloseTask / ownerLedgerReopen），请重启工作台');
    const res = await fn({
      projectId: p.id,
      requirementId,
      taskId,
      reason: kind === 'task-release' ? '账本分叉处置：旧任务收口（界面发起）' : '账本分叉处置：需求返工重开（界面发起）',
      expect
    }) || {};
    if (res.ok === false) {
      const code = String(res.code || 'LEDGER_ACTION_FAILED');
      const msg = humanError(res.message || res.why || code);
      const hint = ledgerActionHint(code);
      ledgerActionUi.banner = { kind: 'bad', text: `处置失败，界面没有改任何文件：${msg}${hint ? `。${hint}` : ''}`, code };
      toast(`处置失败（${code}）：${msg}`, 'bad');
    } else if (res.noop || res.code === 'LEDGER_ACTION_NOOP') {
      ledgerActionUi.banner = { kind: 'info', text: humanError(res.message || '分叉已不存在（重复点 = NOOP），未重复执行'), code: 'LEDGER_ACTION_NOOP' };
      toast('分叉已不存在，未重复执行（NOOP）', 'ok');
    } else {
      const left = res.ledger && Number.isFinite(Number(res.ledger.forkCount)) ? Number(res.ledger.forkCount) : null;
      const auditFile = res.audit && res.audit.file ? String(res.audit.file) : '';
      const auditName = auditFile ? auditFile.split(/[\\/]/).pop() : '';
      ledgerActionUi.banner = {
        kind: 'ok',
        text: `${humanError(res.message || '处置完成')}${left === null ? '' : `；当前剩余分叉 ${left} 条`}${auditName ? `；审计已追加 ${auditName}` : ''}`
      };
      toast('账本处置完成，正在刷新面板…', 'ok');
    }
  } catch (error) {
    const code = ledgerErrorCodeOf(error);
    const msg = humanError((error && error.message) || error);
    const hint = ledgerActionHint(code);
    ledgerActionUi.banner = { kind: 'bad', text: `处置失败，界面没有改任何文件：${msg}${hint ? `。${hint}` : ''}`, code };
    toast(`处置失败${code ? `（${code}）` : ''}：${msg}`, 'bad');
  } finally {
    // busy 必须在任何异常下复位：刷新失败/渲染失败都不能把按钮永久卡在「正在处置」。
    try { await ledgerRefreshAfterAction(); } catch { /* 刷新失败不影响复位，下一次 5 秒轮询会补上 */ }
    ledgerActionUi.busy = false;
    ledgerActionUi.busyKey = '';
    try { ledgerRenderLedgerBlock(); } catch { /* 概览页/流程页都不在时忽略 */ }
  }
}

function legacyPlaceholderDocs(keys = null) {
  const wanted = Array.isArray(keys) ? new Set(keys) : null;
  const PLACEHOLDER_RE = /（待[^）]*）|待填写|待补/;
  return LEGACY_PROJECT_DOCS.filter((doc) => {
    if (wanted && !wanted.has(doc.key)) return false;
    const entry = legacyDocRecord(doc.rel);
    if (entry && entry.ok) return PLACEHOLDER_RE.test(String(entry.text || ''));
    // 只命中团队共享（项目目录没有）时读不到整篇正文，用后端只读摘录开头 400 字判占位；判不了就当没有。
    const check = legacyPresenceCheck(doc.key);
    if (!check || check.exists !== true || !check.excerpt) return false;
    return PLACEHOLDER_RE.test(String(check.excerpt));
  }).map((doc) => doc.label);
}

/**
 * 只有项目信息/项目铁律的占位会挡 boot（与后端 bootPlaceholderDocs 对齐）。
 * 需求总览的第一行占位会在第一条需求落盘时被重写，不应被说成“文档未就绪/无法推进”。
 */
function legacyBootPlaceholderDocs() {
  return legacyPlaceholderDocs(['rules', 'info']);
}

/** 文档就绪：必要文件齐全 + 六角色目录/角色卡/文件索引齐全 + 没有 boot 阻断占位。 */
function legacyDocReadiness() {
  const ready = legacyDocumentsReady();
  // B-65df AC2：缺口只认 docs:presence（同一取数），不再让 files:list 的 600 项截断参与判定。
  const presenceGaps = legacyPresenceGapRows();
  const missing = [];
  if (presenceGaps) {
    for (const row of presenceGaps) missing.push(row.label || row.rel || row.key || '未命名文档');
  } else {
    if (!ready.rules) missing.push('项目铁律.md');
    if (!ready.info) missing.push('项目信息.md');
    if (!ready.index) missing.push('项目索引.md');
    if (!ready.overview) missing.push('需求/00-需求总览.md');
    if (!ready.guide) missing.push('协作准则.md');
  }
  const bootPlaceholders = legacyBootPlaceholderDocs();
  const overviewPlaceholder = legacyPlaceholderDocs(['overview']).length > 0;
  const rolesOk = ready.total > 0 && ready.dirs === ready.total && ready.cards === ready.total && ready.indexes === ready.total;
  // 文件清单只证明“存在”，模板占位必须等 files:read 正文回来后再判断；否则首帧会误报“已就绪”。
  // 只命中团队共享的文档由 docs:presence 给摘录，不要求 files:read 正文，否则会永远停在“文档读取中”。
  const docsToRead = LEGACY_PROJECT_DOCS.map((doc) => doc.rel).filter((rel) => legacyHas(rel));
  const docReadOk = (rel) => {
    const entry = legacyDocRecord(rel);
    if (entry) return entry.ok === true;
    const check = legacyPresenceCheckByRel(rel);
    return Boolean(check && check.exists === true && check.excerpt);
  };
  const docsRead = docsToRead.length === LEGACY_PROJECT_DOCS.length && docsToRead.every(docReadOk);
  const readErrors = docsToRead.filter((rel) => { const entry = legacyDocRecord(rel); return Boolean(entry && entry.ok === false); });
  const pendingRead = missing.length === 0 && !docsRead && readErrors.length === 0 && docsToRead.length === LEGACY_PROJECT_DOCS.length;
  const ok = missing.length === 0 && bootPlaceholders.length === 0 && rolesOk && !pendingRead && readErrors.length === 0;
  // AC2（B-65df）：「文档待补 N」的 N 必须与 #missing-list 的 data-missing-count 同一个数（都来自 presence 缺口）；
  // 模板占位是另一件事，单独出「模板占位 N」，不混进缺文件数字（否则又会出现 chip 2 / 清单 0）。
  const label = (!legacyUi.files || pendingRead) ? '文档读取中'
    : (readErrors.length ? `文档读取失败 ${readErrors.length}`
      : (missing.length ? `文档待补 ${missing.length}`
        : (bootPlaceholders.length ? `模板占位 ${bootPlaceholders.length}` : '文档已就绪')));
  return {
    ...ready,
    ok,
    pendingRead,
    readErrors,
    missing,
    presenceGaps,
    bootPlaceholders,
    overviewPlaceholder,
    rolesOk,
    label
  };
}

/**
 * boot 有效期与后端 requireWorkflowBoot 保持一致（团队/状态/团队.json → config.bootTtlMinutes）。
 * 渲染层拿不到配置时按后端默认 480 分钟（8 小时）；宁可先显示过期，也不把过期证据标成绿色可推进。
 */
function legacyBootTtlMinutes() {
  const config = teamStatusUi.data && teamStatusUi.data.team && teamStatusUi.data.team.config
    ? teamStatusUi.data.team.config : null;
  const value = Number(config && config.bootTtlMinutes);
  if (!Number.isFinite(value) || value <= 0) return 480;
  return Math.max(1, value);
}

/**
 * F-9fbe-3：boot 分母的唯一取数——当前团队角色数。
 * 名册（团队.json → members[].role）优先，名册缺失退回项目 sessions，再退回团队模式角色定义；
 * 三种来源都会标在 data-boot-source 上，不让「4/6」「0/6」这类口径互相冒充。
 */
function legacyBootRoster(project) {
  const p = project || activeProject();
  const known = new Set((state?.roles || []).map((role) => role.id));
  const projectIds = teamRoleIds(p);
  const team = teamStatusUi.data && teamStatusUi.data.team ? teamStatusUi.data.team : null;
  const members = Array.isArray(team && team.members) ? team.members : [];
  const rosterIds = [...new Set(members
    .map((member) => String((member && (member.role || member.id)) || '').trim())
    .filter(Boolean))];
  if (rosterIds.length) {
    const scoped = projectIds.filter((id) => rosterIds.includes(id) && (!known.size || known.has(id)));
    if (scoped.length) return { ids: scoped, source: 'roster', label: '名册 members' };
    return { ids: projectIds, source: 'roster-partial', label: '名册 members（本项目未对上，按项目角色集合）' };
  }
  const sessions = (p && p.sessions) || {};
  const sessionIds = [...new Set(Object.keys(sessions).filter((id) => (!known.size || known.has(id)) && sessions[id]))];
  if (sessionIds.length) return { ids: sessionIds, source: 'sessions', label: '项目 sessions（名册缺失）' };
  return { ids: projectIds, source: 'roles', label: '团队模式角色定义（名册与 sessions 都缺）' };
}

function legacyBootContext() {
  const wf = legacyWorkflow();
  const roster = legacyBootRoster();
  return {
    briefing: legacyUi.briefing,
    round: wf && Number(wf.round) ? Number(wf.round) : null,
    ttlMinutes: legacyBootTtlMinutes(),
    now: Date.now(),
    roleIds: roster.ids,
    source: roster.source,
    sourceLabel: roster.label
  };
}

function legacyBootFor(roleId) {
  return bootRowFrom(legacyBootContext(), roleId);
}

function legacyBootSummary() {
  const summary = bootSummaryFrom(legacyBootContext());
  // 兼容旧调用：rows 里补回 role 对象（角色卡/团队行仍按 role 渲染）。
  summary.rows = summary.rows.map((row) => ({ ...row, role: roleById(row.roleId) }));
  return summary;
}

/**
 * B-20261114-003257-0a46（R-d734 F-4）：面板显示的 BOOT 三态以真实证据为准：
 * 未 BOOT / 已 BOOT（时间）/ BOOT 过期；旧会话的 boot 不算（stale-session）。
 * 闸门（可推进）仍看工作台自己的 boots，两者分开显示，避免“已 BOOT 却不能推进”被读成矛盾。
 */
function legacyBootDisplay(roleId) {
  const boot = legacyBootFor(roleId);
  const ev = boot.evidence;
  if (!ev) {
    return { key: boot.booted ? 'booted' : 'never', label: boot.label, title: '工作台未记录 boot（workflow:briefing）', at: boot.at, evidence: null };
  }
  const time = ev.at ? fmtTime(ev.at) : '';
  // B-2e5 AC2：boot 记录只作记录，不再把「过期 / 未 boot」写成门槛型红字（令牌概念已移除）。
  const label = ev.state === 'booted' ? `已 BOOT${time ? '（' + time + '）' : ''}`
    : ev.state === 'expired' ? `已 BOOT（记录超 TTL，仅提示）${time ? '（' + time + '）' : ''}`
      : ev.state === 'stale-session' ? '未 BOOT（本会话未 boot，只作记录）'
        : ev.state === 'unbound' ? '未 BOOT（当前会话未绑定，只作记录）'
          : '未 BOOT（只作记录）';
  const title = [
    `证据：${ev.evidenceSource || '启动令牌'}${time ? ' · ' + time : ''}`,
    ev.sessionId ? `boot 会话 ${ev.sessionId}` : '',
    ev.currentSessionId ? `当前会话 ${ev.currentSessionId}（${ev.currentSessionSource || '团队.json'}）` : '当前会话未绑定（团队.json members[].sessionId 为空）',
    ev.state === 'stale-session' ? '旧会话的 boot 不算已 BOOT；用当前会话重新 boot' : '',
    ev.state === 'unbound' ? '团队.json 没有该角色的当前会话：先在团队台把角色绑到会话再 boot' : '',
    ev.state === 'expired' ? `超过 ${ev.ttlMinutes} 分钟（只作记录，不拦推进；要刷新记录可点「重新 boot」）` : '',
    boot.booted ? '' : '工作台动作仍要求 workflow:boot（在本角色卡片点一次 boot）'
  ].filter(Boolean).join('；');
  return { key: ev.state, label, title, at: ev.at, evidence: ev };
}

/** boot 会在 TTL（默认 480 分钟）后过期：到点自动重绘，避免页面一直停在绿色“可推进”。 */
function scheduleBootExpiryTick() {
  if (bootExpiryTimer) {
    clearTimeout(bootExpiryTimer);
    bootExpiryTimer = null;
  }
  if (!state || !legacyUi.briefing) return;
  const now = Date.now();
  let next = Infinity;
  for (const role of teamRoles(activeProject())) {
    const boot = legacyBootFor(role.id);
    if (boot.booted && boot.expiresAt && boot.expiresAt > now) next = Math.min(next, boot.expiresAt);
  }
  if (!Number.isFinite(next)) return;
  // +200ms 避开后端/时钟边界；setTimeout 上限约 24.8 天。
  const wait = Math.min(Math.max(500, next - now + 200), 2147483000);
  bootExpiryTimer = setTimeout(() => {
    bootExpiryTimer = null;
    renderLegacyPanels();
  }, wait);
}

function legacyRoleReady(roleId) {
  return legacyBootFor(roleId).ready;
}

/** 按钮禁用原因：把“未 boot / 过期 / 跨轮 / 文档变更 / 核验不可用”分开写，用户知道下一步点哪。 */
function legacyRoleBootReason(roleId) {
  const role = roleById(roleId);
  const boot = legacyBootFor(roleId);
  if (boot.ready) return '';
  if (legacyUi.briefingError) {
    return `boot 核验不可用（${legacyUi.briefingError.code}）：不能确认 ${role.name} 已读，动作禁用`;
  }
  if (!legacyUi.briefing) return `boot 尚未读取：不能确认 ${role.name} 已读，动作禁用；先刷新必读/流程`;
  if (boot.expired) return `${role.name} 的 ${boot.label}；动作前会先补一次 boot（TTL 只提示，不当作门槛），也可点该角色的「重新 boot」`;
  if (boot.roundMismatch) return `${role.name} 的 ${boot.label}；先重新 boot（后端只认本轮记录）`;
  if (boot.stale) return `${role.name} 的 ${boot.label}；旧阅读证据已作废，先重新 boot`;
  if (!boot.booted) return `${role.name} 未 boot/未读全（workflow:briefing），后端会拒绝该动作，界面先禁用`;
  return `${role.name} 必读未读全（workflow:briefing），后端会拒绝该动作，界面先禁用`;
}

/* ── 每轮 boot 已读证据 / 旧工具能力（只读，不伪造） ─────── */

// 后端 bootRead 的 required 项；与 team-tools 的 bootDocSpecs 对齐（宪法在旧令牌里，单列）。
const LEGACY_BOOT_DOCS = [
  { key: 'iron', label: '项目铁律', rel: '项目铁律.md' },
  { key: 'projectInfo', label: '项目信息', rel: '项目信息.md' },
  { key: 'roleCard', label: '角色卡', rel: '' },
  { key: 'projectIndex', label: '项目索引', rel: '项目索引.md' },
  { key: 'requirementOverview', label: '需求总览', rel: '需求/00-需求总览.md' }
];
// 旧令牌实际参与哈希校验的键；顺序与后端 hashChecks 对齐。
const LEGACY_HASH_LABELS = [
  ['constitution', '宪法'],
  ['iron', '铁律'],
  ['projectInfo', '项目信息'],
  ['roleCard', '角色卡'],
  ['projectIndex', '索引'],
  ['requirementOverview', '需求总览'],
  ['rulesHash', '规则哈希']
];
// 渲染层需要的 preload IPC：缺哪个都要显式列出来，不能把“没接口”伪装成“没状态”。
const LEGACY_IPC = [
  { ipc: 'files:list', fn: 'filesList', label: '六角色目录 / 文件清单' },
  { ipc: 'files:read', fn: 'filesRead', label: '只读文档内容' },
  { ipc: 'workflow:state', fn: 'workflowState', label: '旧工具能力 / 工作流文件' },
  { ipc: 'workflow:next', fn: 'workflowNext', label: '阶段 / 需求 / 阶段' },
  { ipc: 'workflow:briefing', fn: 'workflowBriefing', label: '每次 boot 已读核验' },
  { ipc: 'workflow:boot', fn: 'workflowBoot', label: '角色 boot' },
  { ipc: 'requirement:create', fn: 'requirementCreate', label: '需求创建' },
  { ipc: 'requirement:review', fn: 'requirementReview', label: '产品评审' },
  { ipc: 'requirement:owner', fn: 'requirementOwner', label: 'Owner 需求决定' },
  { ipc: 'requirement:dispatch', fn: 'requirementDispatch', label: 'PM 派单' },
  { ipc: 'task:claim', fn: 'taskClaim', label: '任务认领' },
  { ipc: 'task:done', fn: 'taskDone', label: '任务完成' },
  { ipc: 'dev:submit', fn: 'devSubmit', label: '提交开发产出' },
  { ipc: 'dev:review', fn: 'devReview', label: '开发互审' },
  { ipc: 'dev:apply', fn: 'devApply', label: 'PM 签字 apply' },
  { ipc: 'test:dispatch', fn: 'testDispatch', label: '派测试' },
  { ipc: 'owner:accept', fn: 'ownerAccept', label: 'Owner 验收' },
  { ipc: 'workflow:iterate', fn: 'workflowIterate', label: '迭代下一次' },
  { ipc: 'workflow:terminate', fn: 'workflowTerminate', label: '终止工作流' }
];

function legacyHashShort(hash) {
  const text = String(hash || '');
  return text ? text.slice(0, 10) : '';
}

function legacyShortPath(value) {
  const parts = String(value || '').replace(/\\/g, '/').split('/').filter(Boolean);
  return parts.slice(-2).join('/') || '未记录';
}

function legacyBriefingRow(roleId) {
  const briefing = legacyUi.briefing;
  return briefing && briefing.roles && roleId ? briefing.roles[roleId] : null;
}

function legacyRawBoot(roleId) {
  const raw = legacyUi.workflow && legacyUi.workflow.workflow;
  const boots = raw && raw.boots && typeof raw.boots === 'object' ? raw.boots : null;
  return boots && boots[roleId] ? boots[roleId] : null;
}

function legacyBootEvidence(roleId) {
  const row = legacyBriefingRow(roleId);
  const mem = legacyUi.bootEvidence[roleId] || null;
  const memRead = mem && mem.bootRead ? mem.bootRead : null;
  const rawBoot = legacyRawBoot(roleId);
  // 优先本次界面 boot 返回；刷新后用 工作流.json boots 里的完整记录（含 hashChecks/tokenHash）；
  // briefing 只提供只读核验结果，不能据此补造令牌证据。
  const bootRecord = memRead || rawBoot || null;
  const docs = LEGACY_BOOT_DOCS.map((spec) => {
    const live = row && row.docs ? row.docs[spec.key] : null;
    const recorded = bootRecord && bootRecord.docs ? bootRecord.docs[spec.key] : null;
    const exists = live ? Boolean(live.exists) : (recorded ? Boolean(recorded.exists) : (spec.rel ? legacyHas(spec.rel) : false));
    const hash = (live && live.hash) || (recorded && recorded.hash) || '';
    return {
      key: spec.key,
      label: spec.label,
      exists,
      hash,
      path: (live && live.path) || (recorded && recorded.path) || spec.rel,
      changed: Boolean(row && Array.isArray(row.staleDocs) && row.staleDocs.includes(spec.key)),
      recorded: Boolean(recorded && recorded.exists)
    };
  });
  const checks = bootRecord && bootRecord.hashChecks ? bootRecord.hashChecks : null;
  return {
    boot: legacyBootFor(roleId),
    row,
    mem,
    memRead,
    bootRecord,
    docs,
    checks,
    requirementsStale: Boolean(row && Array.isArray(row.staleDocs) && row.staleDocs.includes('requirements')),
    source: memRead ? '本次界面 workflow:boot 返回'
      : (rawBoot ? '工作流.json boots 记录（含令牌哈希与简报哈希）'
        : (row ? '工作流.json boot 记录（briefing 只读核验）' : '未记录')),
    briefingHash: (row && row.briefingHash) || (bootRecord && bootRecord.briefingHash) || '',
    excerpt: (row && row.briefingExcerpt) || (bootRecord && bootRecord.briefingExcerpt) || (mem && mem.briefing) || ''
  };
}

function legacyEvidenceDocChip(doc) {
  // B-2e5：roleCard 这类「按角色才有路径」的文档在没有 boot 记录时无法判存在，
  // 旧代码一律显示红「缺失」是误报；没有路径可查时写「未记录」，不当红项。
  const unknown = !doc.exists && !String(doc.path || '').trim();
  const state = doc.exists ? (doc.changed ? 'changed' : 'ok') : (unknown ? 'muted' : 'bad');
  const mark = doc.exists ? (doc.changed ? '变更' : '已读') : (unknown ? '未记录' : '缺失');
  const hash = doc.hash ? `<code>${esc(legacyHashShort(doc.hash))}</code>` : (unknown ? '<code>—</code>' : '<code>无哈希</code>');
  return `<span class="legacy-evidence-doc ${state}" title="${esc(doc.path || '该文档按角色路径记录，缺少 boot 记录时无法核对')} · ${doc.exists ? '存在' : (unknown ? '未记录' : '缺失')}${doc.changed ? ' · boot 后已变更' : ''}">${esc(doc.label)} ${mark} ${hash}</span>`;
}

function legacyPanelOldRed() {  // B-2e5 自检用：仅用于「前/后对照」截图（旧口径：未 boot/过期/无简报哈希都算红）。
  return typeof window !== 'undefined' && Boolean(window.__AWB_PANEL_OLD_RED);
}

/**
 * B-2e5（Owner 2026-11-15）：终止文案只在 phase=terminated 时出现，且必须带原因。
 * 不再用「工作流已终止」描述未终止的项目状态。
 */
function legacyTerminateReasonText() {
  const wf = legacyWorkflow() || {};
  if (String(wf.phase || '') !== 'terminated') return '';
  const reason = String(wf.terminateReason || wf.terminatedReason || wf.reason || '').trim();
  return reason ? `已终止（原因：${reason}）` : '已终止（未记录原因）';
}

/** AC4：面板里可点的修复入口（红/警示项点一下直达对应区域）。 */
function bindLegacyFixLinks(root) {
  if (!root) return;
  root.querySelectorAll('[data-legacy-fix]:not([data-bound])').forEach((node) => {
    node.setAttribute('data-bound', '1');
    node.addEventListener('click', () => {
      const checks = root.querySelector('.legacy-evidence-checks');
      if (checks && checks.scrollIntoView) checks.scrollIntoView({ block: 'center' });
      node.classList.add('flash');
      if (typeof toast === 'function') toast('哈希未命中详情：看下方每个角色的「文档哈希」标记（命中/未记录）', 'warn');
    });
  });
  root.querySelectorAll('[data-legacy-terminated]:not([data-bound])').forEach((node) => {
    node.setAttribute('data-bound', '1');
    node.addEventListener('click', () => {
      const target = document.getElementById('legacy-flow-terminate');
      if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center' });
      if (typeof toast === 'function') toast('项目已终止：原因写在 工作流.json（phase=terminated / terminateReason）。要恢复请新建工作区', 'warn');
    });
  });
}

function legacyBootEvidenceMarkup() {
  const roles = teamRoles(activeProject());
  if (!roles.length) return '<div class="empty-row">当前团队模式没有角色定义。</div>';
  let hashFailedRoles = 0;
  let hashIncompleteRoles = 0;
  const cards = roles.map((role) => {
    const ev = legacyBootEvidence(role.id);
    const failed = ev.checks ? LEGACY_HASH_LABELS.filter(([key]) => ev.checks[key] === false).map(([, name]) => name) : [];
    const missing = ev.checks ? LEGACY_HASH_LABELS.filter(([key]) => ev.checks[key] === undefined).map(([, name]) => name) : [];
    if (failed.length) hashFailedRoles += 1;
    if (missing.length) hashIncompleteRoles += 1;
    // 后端 briefing 说 boot 完成，但记录里的令牌哈希有未命中/未记录项：不冒充“校验通过”。
    const oldRed = legacyPanelOldRed();
    const label = failed.length ? `boot 完成 · 哈希未命中（${failed.join('、')}）`
      : (missing.length ? `boot 完成 · 旧记录缺哈希项（${missing.join('、')}）` : ev.boot.label);
    // B-2e5：未 boot / 已过期 / 无简报哈希 都不再算红（只作记录，不拦推进）；只有哈希「未命中」是真问题。
    const cls = failed.length ? 'warn'
      : (oldRed ? (ev.boot.ready ? 'ok' : (ev.boot.expired ? 'bad' : (ev.boot.booted || ev.mem ? 'warn' : 'bad')))
        : (ev.boot.ready ? 'ok' : 'muted'));
    const checkChips = oldRed
      ? (ev.checks
        ? LEGACY_HASH_LABELS.map(([key, name]) => {
          const ok = ev.checks[key];
          const text = ok === true ? '命中' : (ok === false ? '未命中' : '未记录');
          return `<span class="legacy-evidence-check ${ok === true ? 'ok' : (ok === false ? 'bad' : 'muted')}" title="旧启动令牌哈希校验">${esc(name)} ${text}</span>`;
        }).join('')
        : '<span class="legacy-evidence-check muted">没有 boot 返回或工作流 boots 记录，无法核对令牌哈希</span>')
      // AC2：启动令牌哈希不再参与红项判定（只保留文档哈希证据）；文案同步清掉令牌口径。
      : `<span class="legacy-evidence-check muted" data-legacy-token-retired="1" title="B-2e5：启动令牌/过期不再作为红项判定依据">令牌/过期：不作为门槛（已移除）</span>`;
    const tokenLine = oldRed
      ? (ev.bootRecord
        ? `<span>令牌哈希 <code>${esc(ev.bootRecord.tokenHash || '未记录')}</code></span><span>旧令牌文件 ${ev.bootRecord.legacyTokenFound ? '存在' : '<b class="bad">未找到</b>'}</span><span>会话 <code>${esc(String(ev.bootRecord.sessionId || '').slice(0, 12) || '未记录')}</code></span>`
        : (ev.briefingHash ? `<span>简报哈希 <code>${esc(legacyHashShort(ev.briefingHash))}</code></span>` : '<span class="bad">没有 boot 返回与简报哈希</span>'))
      // AC2/AC3：简报哈希只作记录（没有也不红）；终止只在 terminated 时由 legacyTerminateReasonText 给出。
      : `<span data-legacy-briefing-hash="1">简报哈希 ${ev.briefingHash ? `<code>${esc(legacyHashShort(ev.briefingHash))}</code>` : '未记录（不影响推进）'}</span>`
        + (legacyTerminateReasonText() ? `<span class="bad" data-legacy-terminated="1">${esc(legacyTerminateReasonText())}</span>` : '');
    const displayRound = ev.boot.round || (ev.bootRecord && Number(ev.bootRecord.round)) || null;
    const roundText = displayRound
      ? `<span class="${oldRed && ev.boot.roundMismatch ? 'bad' : 'muted'}">boot 阶段 ${displayRound}${ev.boot.roundMismatch ? '（当前记录阶段不同，仅提示）' : ''}</span>`
      : '';
    // R-a1eb §6.2/§6.5（T-20261119-141958-16dd）：名册变了只提示，不阻塞、不要求全员重 boot。
    //  规则哈希只含宪法+角色卡（工具层拆分后），别人换会话不会再走 RULES_CHANGED；
    //  这里把 rosterChangedSinceToken 显示成一条 info 提示，避免使用者把它当成错误红项。
    const rosterHint = ev.bootRecord && ev.bootRecord.rosterChangedSinceToken
      ? `<span class="legacy-evidence-check muted" data-roster-hint="1" title="R-a1eb：名册（members[].sessionId/status）在 boot 之后变过；写操作不受影响，方便时重 boot 一次即可">名册已变更（建议重 boot 一次，不影响写）</span>`
      : '';
    return `<article class="legacy-evidence-card ${cls}">
      <header>
        <span class="legacy-evidence-dot" style="--role-color:${esc(role.color)}"></span>
        <b>${esc(role.name)}</b><code>${esc(role.id)}</code>
        <span class="legacy-evidence-state">${esc(label)}</span>
      </header>
      <p class="legacy-evidence-meta">
        <span>boot 时间 ${esc(ev.boot.at ? fmtTime(ev.boot.at) : '未记录')}</span>
        ${roundText}
        ${rosterHint}
        ${tokenLine}
      </p>
      <div class="legacy-evidence-docs">${ev.docs.map(legacyEvidenceDocChip).join('')}${ev.requirementsStale ? '<span class="legacy-evidence-doc changed" title="boot 后需求目录/需求正文发生变化">当前相关需求 变更</span>' : ''}</div>
      <div class="legacy-evidence-checks">${checkChips}</div>
      <div class="legacy-evidence-source">来源：${esc(ev.source)}${ev.boot.missing && ev.boot.missing.length ? ` · 缺失：${esc(ev.boot.missing.join('、'))}` : ''}</div>
      ${ev.excerpt ? `<details class="legacy-evidence-excerpt"><summary>启动简报原文（后端返回，截断显示）</summary><pre>${esc(String(ev.excerpt).slice(0, 1600))}</pre></details>` : ''}
    </article>`;
  }).join('');
  return `<div class="legacy-evidence">
    <div class="legacy-evidence-head">
      <b>已读证据</b>
      <span>boot 记录取自 <code>工作流.json</code>（workflow:briefing 核验 + boots 记录）；本次界面点过 boot 时追加 workflow:boot 的真实返回。文档哈希来自后端读取；没有证据就写“未记录”，不补造。${hashFailedRoles ? (legacyPanelOldRed()
        ? `<b class="bad">有 ${hashFailedRoles} 个角色的令牌哈希存在未命中项；这不是“读全”的正向证据。</b>`
        : `<b class="warn" data-legacy-fix="hash:${esc('all')}" title="点这里查看文档哈希比对详情">有 ${hashFailedRoles} 个角色的文档哈希未命中（点此查看详情）</b>`) : ''}${hashIncompleteRoles ? `<b>有 ${hashIncompleteRoles} 个角色的旧 boot 记录缺少部分哈希项（旧版本记录），按“未记录”显示。</b>` : ''}</span>
    </div>
    <div class="legacy-evidence-grid">${cards}</div>
  </div>`;
}

/**
 * 旧命令能力矩阵：优先用 workflow:state 返回的 legacy.capabilities。
 * 空项目（还没有需求/工作流）时 workflow:state 会走 local-fallback 并丢掉 legacy；
 * 这时按 team:status 的 team.mjs 存在与否兜底，不能让新项目显示“未读取”而把所有按钮锁死。
 */
function legacyCapabilityFromTeamStatus(data) {
  if (!data) return null;
  const tools = data.tools && typeof data.tools === 'object' ? data.tools : {};
  const root = String(data.teamRoot || '').replace(/\\/g, '/').replace(/\/+$/, '');
  const file = root ? `${root}/团队/工具/team.mjs` : '团队/工具/team.mjs';
  if (tools.team !== true) {
    const caps = {
      available: false,
      source: 'team:status',
      file,
      commands: {},
      missing: ['team.mjs'],
      reqCreate: false,
      reqReview: false,
      note: 'team:status 报告旧团队工具不存在'
    };
    return { caps, legacy: { source: 'team:status', file, capabilities: caps }, assumed: false };
  }
  // team:status 只证明 team.mjs 存在，不返回命令矩阵。空项目的第一轮只需要 boot / req create；
  // 先按存在放行基础动作，矩阵一旦由 workflow:state 返回就立即以真实缺口为准。
  const commandNames = ['boot', 'send', 'inbox', 'read', 'ack', 'task', 'propose', 'show', 'review', 'sign', 'apply', 'grant', 'index', 'workflow', 'owner'];
  const commands = Object.create(null);
  for (const name of commandNames) commands[name] = true;
  const caps = {
    available: true,
    assumed: true,
    matrixKnown: false,
    source: 'team:status',
    file,
    commands,
    missing: [],
    reqCreate: true,
    reqReview: true,
    taskClaim: true,
    taskDone: true,
    note: 'workflow:state 未返回旧命令矩阵；按 team:status 确认 team.mjs 存在放行，真实动作仍以后端返回为准'
  };
  return { caps, legacy: { source: 'team:status', file, capabilities: caps }, assumed: true };
}

function legacyCapabilityData() {
  const legacy = legacyUi.workflow && legacyUi.workflow.legacy ? legacyUi.workflow.legacy : null;
  const caps = legacy && legacy.capabilities ? legacy.capabilities : null;
  if (caps) return { legacy, caps, source: 'workflow', assumed: false };
  const fallback = legacyCapabilityFromTeamStatus(teamStatusUi.data);
  if (fallback) return { legacy: legacy || fallback.legacy, caps: fallback.caps, source: 'team-status', assumed: fallback.assumed };
  return { legacy, caps: null, source: 'none', assumed: false };
}

let legacyTeamStatusProbe = null;
/** 只读 team:status，给“workflow:state 丢掉 legacy”的空项目兜底；不写任何状态。 */
async function legacyProbeTeamStatus(force = false) {
  if (!window.workbench || typeof window.workbench.teamStatus !== 'function') return null;
  if (!force && teamStatusUi.data && Date.now() - teamStatusUi.at < 15000) return teamStatusUi.data;
  if (legacyTeamStatusProbe) return legacyTeamStatusProbe;
  legacyTeamStatusProbe = (async () => {
    try {
      const result = await window.workbench.teamStatus();
      teamStatusUi.data = result || null;
      teamStatusUi.at = Date.now();
      return result;
    } catch {
      return null;
    } finally {
      legacyTeamStatusProbe = null;
    }
  })();
  return legacyTeamStatusProbe;
}

/**
 * 动作 → 旧 team.mjs 命令 / preload IPC。
 * 按钮只在“命令确实存在且 IPC 可调”时启用；缺命令就禁用并说明，点了也不会再出现“能点但必然失败”。
 */
const LEGACY_ACTION_COMMANDS = {
  boot: ['boot'],
  'requirement-create': ['req create'],
  'owner-create': ['req create'],
  'owner-demand': ['req create'],
  'requirement-review': ['req review'],
  'tech-review': ['req review'],
  'owner-review': ['owner'],
  dispatch: ['task create', 'send'],
  'task-claim': ['task claim'],
  'task-done': ['task done'],
  'dev-submit': ['propose', 'grant'],
  'dev-review': ['show', 'review'],
  'dev-apply': ['show', 'review', 'sign', 'apply'],
  'test-dispatch': ['task create', 'send'],
  'owner-accept': ['owner', 'workflow'],
  iterate: ['workflow'],
  terminate: ['workflow']
};
const LEGACY_ACTION_IPC = {
  boot: 'workflowBoot',
  'requirement-create': 'requirementCreate',
  'owner-create': 'requirementOwnerCreate',
  'owner-demand': 'ownerDemand',
  'requirement-review': 'requirementReview',
  'tech-review': 'requirementTechReview',
  'owner-review': 'requirementOwner',
  dispatch: 'requirementDispatch',
  'task-claim': 'taskClaim',
  'task-done': 'taskDone',
  'dev-submit': 'devSubmit',
  'dev-review': 'devReview',
  'dev-apply': 'devApply',
  'test-dispatch': 'testDispatch',
  'owner-accept': 'ownerAccept',
  iterate: 'workflowIterate',
  terminate: 'workflowTerminate'
};

/**
 * 单条旧命令三种状态，只认后端能力矩阵：
 *  - ok：矩阵明确 true；
 *  - missing：矩阵明确 false，或被写进 caps.missing；
 *  - unknown：矩阵没有这条命令（没探测）→ 只能写“未核验”，绝不能写成“缺”。
 * legacyCommandAvailable 保留布尔语义（unknown 仍不可用），但文案必须走三态，不能把 unknown 当 missing。
 */
function legacyCommandState(caps, command) {
  if (!caps || caps.available !== true) return 'unknown';
  const commands = caps.commands || {};
  let value;
  switch (String(command)) {
    case 'task create': value = commands.task; break;
    case 'task claim': value = caps.taskClaim; break;
    case 'task done': value = caps.taskDone; break;
    case 'req create': value = caps.reqCreate; break;
    case 'req review': value = caps.reqReview; break;
    default: value = commands[command];
  }
  if (value === true) return 'ok';
  const missing = Array.isArray(caps.missing) ? caps.missing : [];
  if (value === false || missing.includes(String(command))) return 'missing';
  return 'unknown';
}

function legacyCommandAvailable(caps, command) {
  return legacyCommandState(caps, command) === 'ok';
}

/**
 * Owner 决定/验收由 requirement:owner / owner:accept IPC 落账：旧 owner 命令缺失时，
 * team-tools 会由工作台壳层写 工作流.json（OWNER_SHELL_OWNED），Full / Fast 一致。
 * 因此这两个动作只要求 preload IPC 存在，不再被 team.mjs 的 owner 旧命令挡住。
 */
const SHELL_OWNED_ACTIONS = new Set(['owner-review', 'owner-accept']);

function legacyActionShellOwned(action) {
  return SHELL_OWNED_ACTIONS.has(action);
}

function legacyActionCommandGate(action) {
  const commands = LEGACY_ACTION_COMMANDS[action] || [];
  if (!commands.length) return { ok: true, missing: [], unknown: [], reason: '' };
  const ipcName = LEGACY_ACTION_IPC[action];
  if (!ipcName || !window.workbench || typeof window.workbench[ipcName] !== 'function') {
    return {
      ok: false,
      missing: commands.slice(),
      unknown: [],
      reason: `preload 缺少 ${action} 动作 IPC（${ipcName || '未登记'}）：按钮已禁用，先修复 preload`
    };
  }
  if (legacyActionShellOwned(action)) {
    return { ok: true, missing: [], unknown: [], reason: '', shellOwned: true };
  }
  const { caps } = legacyCapabilityData();
  if (!caps) {
    return {
      ok: false,
      missing: [],
      unknown: commands.slice(),
      reason: '旧命令能力待核验（workflow:state 与 team:status 都还没有返回可用命令矩阵）：按钮暂时禁用，刷新项目状态后重试'
    };
  }
  if (!caps.available) {
    return {
      ok: false,
      missing: commands.slice(),
      unknown: [],
      reason: `旧团队工具不存在（${caps.file || 'team.mjs'}）：${commands.join('、')} 都不可用，按钮已禁用`
    };
  }
  // 壳层动作（如 Fast 的 iterate）由后端自己写状态：矩阵里可能仍显示旧命令缺失，
  // 但动作 IPC 是真的可执行，不能因为 team.mjs 缺命令就把按钮永久禁用。
  const shellOwnedActions = Array.isArray(caps.shellOwnedActions) ? caps.shellOwnedActions : [];
  if (shellOwnedActions.includes(action)) {
    return { ok: true, missing: [], unknown: [], reason: '', shellOwned: true, shellOwnedAction: true };
  }
  const missing = commands.filter((command) => legacyCommandState(caps, command) === 'missing');
  const unknown = commands.filter((command) => legacyCommandState(caps, command) === 'unknown');
  if (missing.length) {
    const unknownNote = unknown.length ? `；另有「${unknown.join('、')}」未核验（不写成缺）` : '';
    return {
      ok: false,
      missing,
      unknown,
      reason: `当前 team.mjs 缺旧命令「${missing.join('、')}」${unknownNote}：按钮已禁用，先升级团队工具；界面不会伪造成功`
    };
  }
  if (unknown.length) {
    return {
      ok: false,
      missing: [],
      unknown,
      reason: `旧命令未核验「${unknown.join('、')}」：能力矩阵没有返回这些命令，按钮暂时禁用；矩阵返回后自动恢复，不写成缺失`
    };
  }
  return { ok: true, missing: [], unknown: [], reason: '' };
}

/* ── 闸门展示（判定只来自 team.mjs / team-tools，壳层不自己判） ─────── */

const GATE_CODE_INFO = {
  REQ_NOT_FINAL: { gate: 'G1', title: '需求未定稿', next: '先补需求正文与验收标准，再执行需求评审' },
  REQ_REVIEW_REQUIRED: { gate: 'G2', title: '缺需求评审通过', next: '先完成需求评审 approve，再开 Owner 门 / 派单' },
  PRODUCT_REVIEW_REQUIRED: { gate: 'G2', title: '缺需求评审通过（legacy 码）', next: '先完成需求评审 approve，再开 Owner 门 / 派单' },
  TESTABILITY_REVIEW_REQUIRED: { gate: 'G2.5', title: '缺可测性评审（TR-Q）', next: '先让测试人员出《可测性评审-<需求id>-vN.md》且结论“可测”，再开 Owner 门' },
  OWNER_REVIEW_REQUIRED: { gate: 'G3', title: '缺 Owner 决定', next: '先让 Owner 在界面/终端落账 approved 或 skipped，再由 PM 派单' },
  OWNER_GATE_NOT_READY: { gate: 'G3', title: 'Owner 门尚未就绪', next: '先补齐需求评审与 Owner 决定，再尝试 Owner 门动作' },
  PRODUCT_DESIGN_REQUIRED: { gate: 'G4', title: '缺产品设计评审 / 签字', next: '先完成设计 propose→review→sign→apply，再派开发' },
  TECH_REVIEW_REQUIRED: { gate: 'G4f', title: '缺技术评审通过', next: '先由程序员A完成技术评审 approve（需求状态 ready），再派单' },
  ROLE_NOT_IN_STAGE: { gate: 'G0', title: '角色不在当前阶段', next: '按当前阶段允许的动作重新派单；Owner 前只允许 TR-Q / 材料补全' },
  ROLE_BUSY: { gate: 'G5', title: '角色有未闭环任务', next: '先完成或释放该角色上一任务 / 派单锁，再派下一个' },
  TASK_OPEN: { gate: 'G5', title: '角色有未闭环任务', next: '先完成或释放该角色上一任务 / 派单锁，再派下一个' },
  TEST_REPORT_REQUIRED: { gate: 'G7', title: '缺测试报告或结论不明确', next: '补《测试报告-vN.md》并写明 PASS/FAIL，再 task done' },
  EVIDENCE_REQUIRED: { gate: 'G8', title: '任务缺少证据', next: '补证据（产出路径 / 验证输出）后再 task done' },
  ITERATION_BLOCKED: { gate: 'G9', title: '迭代 / 终止被拦', next: '先收口全部需求、关闭任务并释放派单锁，再迭代 / 终止' },
  GATE_BYPASS_DENIED: { gate: 'G7', title: '绕过派单入口被拒', next: '从正常入口派单；闸门未满足时不会被唤醒' }
};
const GATE_ACTION_ALIASES = {
  owner: 'owner-review',
  'owner-review': 'owner-review',
  'owner-accept': 'owner-accept',
  review: 'requirement-review',
  'requirement-review': 'requirement-review',
  tech: 'tech-review',
  'tech-review': 'tech-review',
  dispatch: 'dispatch',
  'requirement-dispatch': 'dispatch',
  'test-dispatch': 'test-dispatch',
  'task-claim': 'task-claim',
  'task-done': 'task-done',
  'dev-submit': 'dev-submit',
  'dev-review': 'dev-review',
  'dev-apply': 'dev-apply',
  iterate: 'iterate',
  terminate: 'terminate',
  'workflow-iterate': 'iterate',
  'workflow-terminate': 'terminate'
};

function normalizeGateAction(action) {
  const key = String(action || '').trim();
  return GATE_ACTION_ALIASES[key] || key;
}

function gateInfoFor(code) {
  return GATE_CODE_INFO[String(code || '')] || null;
}

function gateCodeOfError(error) {
  const direct = String((error && error.code) || '').trim();
  if (direct && GATE_CODE_INFO[direct]) return direct;
  const match = String((error && error.message) || '').match(/\[([A-Z][A-Z0-9_]+)\]/);
  return match && GATE_CODE_INFO[match[1]] ? match[1] : '';
}

function normalizeGateEntry(entry, fallbackAction = '') {
  const row = entry && typeof entry === 'object' ? entry : {};
  const rawCode = String(row.code || row.errorCode || '');
  const info = gateInfoFor(rawCode);
  const allowed = row.ok === true || row.allowed === true || row.result === 'pass' || row.result === 'ok'
    || (row.ok === undefined && row.allowed === undefined && !rawCode);
  const missing = Array.isArray(row.missing)
    ? row.missing.map((item) => (typeof item === 'string' ? item : String((item && (item.label || item.code || item.path)) || ''))).filter(Boolean).slice(0, 12)
    : [];
  return {
    action: normalizeGateAction(row.action || row.gateAction || fallbackAction),
    gate: String(row.gate || (info && info.gate) || ''),
    ok: Boolean(allowed),
    code: rawCode,
    title: String(row.title || (info && info.title) || ''),
    message: String(row.message || row.why || ''),
    missing,
    next: String(row.next || row.nextStep || row.hint || (info && info.next) || ''),
    role: String(row.role || row.targetRole || ''),
    requirementId: String(row.requirementId || '')
  };
}

function normalizeGatePayload(raw) {
  const out = {
    available: false, unavailable: false, source: '', interface: '', phase: null,
    allowedActions: null, gates: new Map(), error: '', code: '', at: Date.now()
  };
  if (!raw || typeof raw !== 'object') { out.error = 'gate:check 没有返回对象'; return out; }
  out.source = String(raw.source || raw.driver || '');
  out.interface = String(raw.interface || '');
  out.phase = raw.phase ? String(raw.phase) : null;
  if (raw.code === 'GATE_API_UNAVAILABLE' || raw.missingInterface === true) {
    out.unavailable = true;
    out.code = 'GATE_API_UNAVAILABLE';
    out.error = String(raw.message || 'team.mjs 还没有 gate:check 接口（TODO(接口)）');
    return out;
  }
  const rows = [];
  if (Array.isArray(raw.gates)) rows.push(...raw.gates);
  else if (raw.gates && typeof raw.gates === 'object') {
    for (const [action, entry] of Object.entries(raw.gates)) rows.push({ ...(entry && typeof entry === 'object' ? entry : {}), action: (entry && entry.action) || action });
  }
  if (Array.isArray(raw.checks)) rows.push(...raw.checks);
  if (Array.isArray(raw.results)) rows.push(...raw.results);
  if (raw.action || raw.code) rows.push(raw);
  for (const entry of rows) {
    const norm = normalizeGateEntry(entry);
    if (norm.action) out.gates.set(norm.action, norm);
  }
  if (Array.isArray(raw.allowedActions)) out.allowedActions = raw.allowedActions.map(normalizeGateAction);
  if (!out.gates.size && !out.allowedActions) {
    out.error = String(raw.message || 'gate:check 返回了无法识别的形状（需要 gates[] 或 allowedActions[]）');
    out.code = String(raw.code || 'GATE_API_SHAPE_UNKNOWN');
    return out;
  }
  out.available = true;
  if (raw.ok === false && !out.gates.size) { out.error = String(raw.message || raw.code || '闸门判定失败'); out.code = String(raw.code || ''); }
  return out;
}

const gateUi = { projectId: null, at: 0, loading: false, data: null };
const gateAuditUi = { projectId: null, at: 0, loading: false, data: null };

function gateDataReady() {
  const p = activeProject();
  return Boolean(p && gateUi.projectId === p.id && gateUi.data && gateUi.data.available);
}

/** 返回该动作的后端判定；null = 判定接口未就绪，界面不自行禁用。 */
function gateForAction(action) {
  if (!gateDataReady()) return null;
  const key = normalizeGateAction(action);
  const data = gateUi.data;
  if (data.gates.has(key)) return data.gates.get(key);
  if (Array.isArray(data.allowedActions)) {
    const allowed = data.allowedActions.includes(key);
    return {
      action: key, gate: '', ok: allowed, code: '',
      title: allowed ? '' : '当前阶段不在允许动作列表',
      message: allowed ? '' : 'team.mjs 返回的允许动作不包含该动作',
      missing: [], next: allowed ? '' : `允许动作：${data.allowedActions.join('、') || '（空）'}`,
      role: '', requirementId: ''
    };
  }
  return null;
}

function gateDeniedText(entry) {
  const bits = [];
  if (entry.gate) bits.push(`闸门 ${entry.gate}`);
  if (entry.title) bits.push(entry.title);
  if (Array.isArray(entry.missing) && entry.missing.length) bits.push('缺：' + entry.missing.join('、'));
  if (entry.next) bits.push('下一步：' + entry.next);
  return bits.join(' · ') || entry.message || entry.code || '闸门未满足';
}

async function loadGateCheck(options = {}) {
  const p = activeProject();
  if (!p || !window.workbench || typeof window.workbench.gateCheck !== 'function') return null;
  if (gateUi.loading) return null;
  const force = options.force === true;
  if (!force && gateUi.projectId === p.id && Date.now() - gateUi.at < 8000) return gateUi.data;
  gateUi.loading = true;
  try {
    const req = legacyActiveRequirement();
    const raw = await window.workbench.gateCheck({ projectId: p.id, requirementId: req ? req.id : '' });
    if (!activeProject() || activeProject().id !== p.id) return null;
    gateUi.projectId = p.id;
    gateUi.at = Date.now();
    gateUi.data = normalizeGatePayload(raw);
    renderFlow();
    return gateUi.data;
  } catch (e) {
    gateUi.projectId = p.id;
    gateUi.at = Date.now();
    gateUi.data = normalizeGatePayload({ ok: false, code: 'GATE_API_UNAVAILABLE', message: humanError(e.message), missingInterface: true });
    renderFlow();
    return null;
  } finally {
    gateUi.loading = false;
  }
}

async function loadGateAudit(options = {}) {
  const p = activeProject();
  if (!p || !window.workbench || typeof window.workbench.gateAudit !== 'function') return null;
  if (gateAuditUi.loading) return null;
  const force = options.force === true;
  if (!force && gateAuditUi.projectId === p.id && Date.now() - gateAuditUi.at < 8000) return gateAuditUi.data;
  gateAuditUi.loading = true;
  try {
    const raw = await window.workbench.gateAudit({ projectId: p.id, limit: 20 });
    if (!activeProject() || activeProject().id !== p.id) return null;
    gateAuditUi.projectId = p.id;
    gateAuditUi.at = Date.now();
    gateAuditUi.data = raw;
    renderGateAudit();
    return raw;
  } catch (e) {
    gateAuditUi.data = { ok: false, message: humanError(e.message), items: [] };
    gateAuditUi.projectId = p.id;
    gateAuditUi.at = Date.now();
    renderGateAudit();
    return null;
  } finally {
    gateAuditUi.loading = false;
  }
}

function gateRejectionView(entry, extra = {}) {
  const info = gateInfoFor(entry && entry.code) || {};
  const missing = Array.isArray(entry && entry.missing) ? entry.missing : [];
  return {
    gate: String((entry && entry.gate) || info.gate || ''),
    code: String((entry && entry.code) || ''),
    title: String((entry && entry.title) || info.title || '操作被闸门拒绝'),
    message: String((entry && entry.message) || info.title || ''),
    missing,
    next: String((entry && entry.next) || info.next || ''),
    requirementId: String((entry && entry.requirementId) || ''),
    source: String(extra.source || 'team.mjs / team-tools 返回'),
    attempted: String(extra.attempted || '')
  };
}

function gateRejectionMarkup(view) {
  const missing = view.missing.length
    ? `<ul class="gate-reject-missing">${view.missing.map((item) => `<li>${esc(item)}</li>`).join('')}</ul>`
    : '<p class="gate-reject-empty">后端没有返回缺项清单；以错误消息为准，界面不补造。</p>';
  return `<div class="gate-reject" data-gate-code="${esc(view.code)}" data-gate="${esc(view.gate)}">
    <div class="gate-reject-head">
      <span class="gate-reject-badge">${esc(view.gate || '闸门')}</span>
      <b>${esc(view.title)}</b>
      ${view.code ? `<code>${esc(view.code)}</code>` : ''}
    </div>
    ${view.message && view.message !== view.title ? `<p class="gate-reject-message">${esc(view.message)}</p>` : ''}
    <div class="gate-reject-section"><span>缺什么</span>${missing}</div>
    <div class="gate-reject-section"><span>下一步</span><p>${esc(view.next || '按错误码补齐前置条件后重试；界面不提供 --force。')}</p></div>
    <p class="gate-reject-source">判定来源：${esc(view.source)}${view.attempted ? ` ｜ 尝试动作：${esc(view.attempted)}` : ''}${view.requirementId ? ` ｜ 需求：${esc(view.requirementId)}` : ''}</p>
    <p class="gate-reject-audit">拒绝应由 team.mjs 写入 <code>团队/状态/项目/&lt;项目&gt;/闸门审计.jsonl</code>；下方“闸门审计”面板只读展示，未记录不等于放行。</p>
  </div>`;
}

function showGateRejection(entry, extra = {}) {
  const view = gateRejectionView(entry, extra);
  const wrap = document.createElement('div');
  wrap.innerHTML = gateRejectionMarkup(view);
  openModal({
    title: `闸门拒绝 · ${view.code || view.title}`,
    subtitle: '判定由 team.mjs / team-tools 返回；壳层只展示，不提供绕过入口',
    icon: '⛔',
    width: 640,
    body: wrap,
    actions: [{ label: '知道了', kind: 'primary', onClick: ({ close }) => close() }]
  });
  loadGateAudit({ force: true });
}

/** 在已有弹窗内就地展示闸门拒绝（不叠第二个弹窗）。 */
function renderGateRejectionInto(container, entry, extra = {}) {
  if (!container) return;
  const previous = container.querySelector('.gate-rejection-inline');
  if (previous) previous.remove();
  const view = gateRejectionView(entry, extra);
  const holder = document.createElement('div');
  holder.className = 'gate-rejection-inline';
  holder.innerHTML = gateRejectionMarkup(view);
  container.insertBefore(holder, container.firstChild);
  loadGateAudit({ force: true });
}

function gateErrorView(error, extra = {}) {
  const code = gateCodeOfError(error);
  if (!code) return null;
  const info = gateInfoFor(code) || {};
  const message = humanError(error && error.message).replace(/^\[[A-Z0-9_]+\]\s*/, '');
  return {
    gate: info.gate || '', code, title: info.title || '操作被闸门拒绝',
    message, missing: Array.isArray(error && error.missing) ? error.missing : [],
    next: info.next || '', requirementId: String((error && error.requirementId) || ''),
    source: extra.source || '后端动作返回错误码', attempted: String(extra.attempted || '')
  };
}

/* ── Owner decisions[] 展示（只读；append-only；legacy-unrecorded 灰） ── */

function ownerDecisionLabel(status) {
  const key = String(status || '');
  if (key === 'approved') return '通过';
  if (key === 'skipped') return '跳过';
  if (key === 'rejected') return '打回';
  if (key === 'pending') return '待决定';
  return key || '未记录';
}

function ownerBasisBits(basis) {
  if (!basis || typeof basis !== 'object') return [];
  const bits = [];
  const req = basis.requirement && typeof basis.requirement === 'object' ? basis.requirement : null;
  const design = basis.design && typeof basis.design === 'object' ? basis.design : null;
  if (req) bits.push(`需求 ${req.path || '未记录'}${req.sha256 ? ' · sha256 ' + String(req.sha256).slice(0, 12) : ''}`);
  if (design) bits.push(`设计 ${design.path || '未记录'}${design.version ? ' · ' + design.version : ''}${design.sha256 ? ' · sha256 ' + String(design.sha256).slice(0, 12) : ''}`);
  if (!bits.length && typeof basis === 'string') bits.push(basis);
  return bits;
}

/** decisions[] 优先；没有时给单条旧记录，按 AC-O5 只读标注，不补账。 */
function ownerDecisionRows(req) {
  const top = (req && Array.isArray(req.decisions)) ? req.decisions.filter((row) => row && typeof row === 'object') : [];
  // B-dee4：真值在需求行顶层 decisions[]（R-1cee/B-a08e 已定：ownerReview 只留摘要、不再存 decisions）。
  // 以前这里只看 ownerReview.decisions，导致点过「通过」的需求在「Owner 决定记录」里仍显示「待决定」。
  if (top.length) return { rows: top, source: 'decisions[]', legacy: false, empty: false };
  const owner = req && req.ownerReview && typeof req.ownerReview === 'object' ? req.ownerReview : null;
  if (!owner) return { rows: [], source: '', legacy: false, empty: true };
  const decisions = Array.isArray(owner.decisions)
    ? owner.decisions.filter((row) => row && typeof row === 'object')
    : (owner.decisions && typeof owner.decisions === 'object'
      ? Object.values(owner.decisions).filter((row) => row && typeof row === 'object')
      : []);
  if (decisions.length) return { rows: decisions, source: 'ownerReview.decisions[]', legacy: false, empty: false };
  const status = String(owner.status || '');
  const hasAt = Boolean(owner.at);
  const hasConfirm = Boolean(owner.confirmation);
  // AC-O5：历史（未落账）必须由 team.mjs 显式标记（或决策日志含“Owner 口头”）。
  // 壳层没有日志就不猜：pending 且无 at/confirmation 只写“待决定”，不冒充历史、也不冒充已决定。
  const explicitLegacy = owner.legacy === 'unrecorded' || owner.legacyUnrecorded === true
    || owner.source === 'legacy-unrecorded' || owner.channel === 'legacy-unrecorded';
  const pending = status === 'pending' && !hasAt && !hasConfirm;
  const source = explicitLegacy
    ? '旧单条 ownerReview（历史，未落账）'
    : (pending ? '旧单条 ownerReview（待决定；无 decisions[]）' : '旧单条 ownerReview（无 decisions[]）');
  return { rows: [owner], source, legacy: explicitLegacy, empty: false };
}

function ownerDecisionsMarkup(req, options = {}) {
  const data = ownerDecisionRows(req);
  const compact = options.compact === true;
  if (data.empty) {
    return `<section class="owner-decisions${compact ? ' compact' : ''}">
      <div class="owner-decisions-head"><b>Owner 决定记录</b><span>未记录</span></div>
      <div class="owner-decisions-empty">未记录：这条需求还没有 Owner 决定；界面不补造 decisions[]。</div>
    </section>`;
  }
  const rows = data.rows.map((row) => {
    const status = String(row.status || row.decision || '');
    const channel = String(row.channel || '');
    const channelOk = ['ui', 'tty', 'proxy', 'skip_committee'].includes(channel);
    const channelBad = channel && !channelOk;
    const at = row.at || row.confirmedAt || '';
    const basis = ownerBasisBits(row.basis);
    const opinion = String(row.opinion || '');
    const by = String(row.by || row.actor || '');
    const nonceHash = String(row.nonceHash || (row.confirmation && row.confirmation.nonceHash) || '');
    const cls = data.legacy ? ' legacy-unrecorded' : (channelBad ? ' channel-bad' : '');
    return `<div class="owner-decision${cls}" data-decision-status="${esc(status)}">
      <div class="od-top">
        <span class="od-badge status-${esc(status || 'unknown')}">${esc(ownerDecisionLabel(status))}</span>
        <code class="od-channel ${channelOk ? 'ok' : (channelBad ? 'bad' : '')}" title="channel=ui/tty 为 Owner 本人；proxy=PM 代管；skip_committee=三方共决（均合规）">${esc(channel || 'channel 未记录')}</code>
        ${at ? `<time>${esc(fmtTime(at))}</time>` : '<span class="od-time muted">时间未记录</span>'}
        ${data.legacy ? '<span class="badge badge-skipped">历史（未落账）· 只读</span>' : ''}
        ${channelBad ? '<span class="badge badge-rejected">通道不合规 · 不计验收</span>' : ''}
      </div>
      ${by || nonceHash ? `<div class="od-fields">${by ? `<span>记录人 <code>${esc(by)}</code></span>` : ''}${nonceHash ? `<span>nonceHash <code>${esc(nonceHash.slice(0, 12))}</code></span>` : ''}</div>` : ''}
      ${basis.length ? `<div class="od-basis">依据：${basis.map((item) => `<span>${esc(item)}</span>`).join('')}</div>` : (data.legacy ? '<div class="od-basis">依据：历史记录没有 basis（只读，不补账）</div>' : '')}
      ${opinion ? `<p class="od-opinion">意见：${esc(opinion)}</p>` : ''}
    </div>`;
  }).join('');
  return `<section class="owner-decisions${compact ? ' compact' : ''}">
    <div class="owner-decisions-head"><b>Owner 决定记录</b><span>${data.rows.length} 条 · ${esc(data.source)}</span></div>
    <div class="owner-decisions-list">${rows}</div>
    <p class="owner-decisions-note">只读展示 append-only 记录；channel 只允许 ui / tty，basis 为落账时的需求/设计哈希。旧单条记录不改写、不补账。</p>
  </section>`;
}

/* ── TR-Q（可测性评审）展示：字段由 team.mjs 落库；没有就写未记录 ── */

function legacyTrqFile(req) {
  const files = Array.isArray(legacyUi.files) ? legacyUi.files : [];
  const id = String((req && req.id) || '');
  if (!id) return '';
  const rows = files.filter((file) => file && file.rel && /^测试人员\/产出\/可测性评审-/.test(file.rel));
  const hit = rows.find((file) => file.rel.includes(id)) || null;
  return hit ? hit.rel : '';
}

function legacyTrqView(req) {
  const trq = req && req.trq && typeof req.trq === 'object' ? req.trq : null;
  const fileHint = legacyTrqFile(req);
  if (!trq) {
    return {
      state: 'missing', verdict: '', label: '未记录', file: fileHint,
      detail: fileHint ? '文件存在但需求行没有 trq 记录（待 team.mjs 落库）' : '需求行没有 trq 字段；G2.5 判定由 team.mjs 返回',
      by: '', at: '', hash: '', version: '', missing: []
    };
  }
  const verdict = String(trq.verdict || '');
  const missing = Array.isArray(trq.missing) ? trq.missing.map((item) => String((item && (item.label || item.code)) || item)).filter(Boolean) : [];
  const label = verdict === 'testable' ? '可测'
    : verdict === 'not_testable' ? '不可测'
      : verdict === 'optional-missing' ? 'P1 未做'
        : (verdict || '未记录');
  return {
    state: verdict === 'testable' ? 'testable' : (verdict === 'not_testable' ? 'not_testable' : (verdict === 'optional-missing' ? 'optional' : 'unknown')),
    verdict, label, file: String(trq.file || trq.path || trq.doc || fileHint || ''),
    detail: trq.note || (missing.length ? `缺 ${missing.length} 项` : ''),
    by: String(trq.by || trq.reviewer || ''),
    at: String(trq.at || ''),
    hash: String(trq.requirementHash || trq.hash || ''),
    version: trq.version ? String(trq.version) : '',
    missing
  };
}

/* ── 闸门审计（只读） ─────────────────────────────────────── */

function gateAuditRowMarkup(row) {
  return `<div class="gate-audit-row${row.code ? ' is-deny' : ''}">
    <div class="ga-top">
      <time>${esc(row.at ? fmtTime(row.at) : '时间未记录')}</time>
      <span>${esc(row.role ? roleById(row.role).name : '角色未记录')}</span>
      <code>${esc(row.source || 'source?')}</code>
      <span class="ga-action">${esc(row.action || '动作未记录')}</span>
      ${row.gate ? `<span class="ga-gate">${esc(row.gate)}</span>` : ''}
      ${row.code ? `<code class="ga-code">${esc(row.code)}</code>` : ''}
    </div>
    ${row.missing && row.missing.length ? `<div class="ga-missing">缺：${row.missing.map((item) => esc(item)).join('、')}</div>` : ''}
    ${row.message ? `<div class="ga-message">${esc(row.message)}</div>` : ''}
    ${row.requirementId || row.taskId ? `<div class="ga-ref">${row.requirementId ? '需求 ' + esc(row.requirementId) : ''}${row.taskId ? ' · 任务 ' + esc(row.taskId) : ''}</div>` : ''}
  </div>`;
}

function renderGateAudit() {
  // 同一份只读审计同时渲染到“流程页”和“团队台”两处，避免两套口径。
  const targets = [
    { box: $('#gate-audit'), badge: $('#gate-audit-badge') },
    { box: $('#gate-audit-team'), badge: $('#gate-audit-team-badge') }
  ].filter((item) => item.box);
  if (!targets.length) return;
  const data = gateAuditUi.data;
  let html = '';
  let badgeText = '读取中';
  let badgeCls = 'badge muted-badge';
  let badgeTitle = '';
  if (!data) {
    const hasProject = Boolean(activeProject());
    badgeText = hasProject ? '读取中' : '未选择项目';
    html = `<div class="empty-row">${hasProject ? '读取中…（只读闸门审计）' : '先选择项目：闸门审计按当前项目的团队状态目录读取。'}</div>`;
  } else if (data.ok === false) {
    badgeText = '读取失败';
    badgeCls = 'badge badge-rejected';
    html = `<div class="empty-row">闸门审计不可读：${esc(humanError(data.message || data.code || '未知原因'))}</div>`;
  } else if (!data.exists) {
    badgeText = '未记录';
    html = '<div class="empty-row">未记录：还没有 <code>团队/状态/项目/&lt;项目&gt;/闸门审计.jsonl</code>。接口未写入时不补造；无记录不等于放行。</div>';
  } else {
    const items = Array.isArray(data.items) ? data.items : [];
    badgeText = `${data.total || items.length} 条 · 只读`;
    badgeCls = 'badge badge-skipped';
    badgeTitle = data.file || '';
    html = items.length
      ? `<div class="gate-audit-list">${items.map((row) => gateAuditRowMarkup(row)).join('')}</div>`
      : '<div class="empty-row">审计文件存在，但没有可解析的记录。</div>';
  }
  for (const target of targets) {
    if (target.badge) {
      target.badge.textContent = badgeText;
      target.badge.className = badgeCls;
      target.badge.title = badgeTitle;
    }
    target.box.innerHTML = html;
  }
}


/** 主流程动作的命令缺口汇总：明确缺失和“未核验”分开，只有前者才能写“缺”。 */
const LEGACY_FLOW_ACTIONS = [
  'requirement-create', 'requirement-review', 'owner-review', 'dispatch',
  'dev-submit', 'dev-review', 'dev-apply', 'test-dispatch', 'owner-accept',
  'owner-demand', 'iterate', 'terminate'
];

function legacyFlowCommandGapSummary() {
  const missing = new Set();
  const unknown = new Set();
  for (const action of LEGACY_FLOW_ACTIONS) {
    const gate = legacyActionCommandGate(action);
    for (const command of (gate.missing || [])) missing.add(command);
    for (const command of (gate.unknown || [])) unknown.add(command);
  }
  return { missing: [...missing], unknown: [...unknown] };
}

function legacyFlowCommandGaps() {
  return legacyFlowCommandGapSummary().missing;
}

/**
 * 迭代闸门：只在“全部需求已验收、没有在办需求”时放行。
 * 迭代会让本轮所有角色 boot 失效，不能在没有阶段守卫时一点就作废本轮证据。
 */
function legacyIterateGuard() {
  const wf = legacyWorkflow();
  const phase = wf && wf.phase ? String(wf.phase) : '';
  if (phase === 'terminated') {
    return { ok: false, code: 'terminated', reason: '工作流已终止；先新建项目或重新开始' };
  }
  const commandGate = legacyActionCommandGate('iterate');
  if (!commandGate.ok) {
    return { ok: false, code: 'command-missing', reason: commandGate.reason, commandGate };
  }
  const reqs = legacyRequirements();
  // Owner 新需求带 queued=true 排到下一轮，它不是“在办需求”；迭代正是把它转正的入口。
  // rejected 是已收口（投票驳回/评审打回）：后端 iterateGuard 也把它算收口，界面不能比后端更严，
  // 否则一次通过的驳回投票就会把本轮永久锁死。
  const CLOSED_REQ_STATUSES = ['accepted', 'terminated', 'iteration', 'rejected'];
  const current = reqs.filter((req) => !req.queued);
  const open = current.filter((req) => !CLOSED_REQ_STATUSES.includes(String(req.status || '')));
  if (open.length) {
    const names = open.slice(0, 3).map((req) => `${req.id}（${legacyReqStatus(req)}）`).join('、');
    return {
      ok: false,
      code: 'open-requirements',
      reason: `还有 ${open.length} 条需求在办：${names}${open.length > 3 ? ' 等' : ''}；迭代会让当前 boot 全部作废、在办需求留在旧状态。先完成 Owner 验收，或改用「终止」。`
    };
  }
  if (!reqs.length) {
    return { ok: false, code: 'no-requirements', reason: '还没有需求：先建需求并完成 Owner 验收，验收后才能迭代' };
  }
  const accepted = current.filter((req) => String(req.status || '') === 'accepted').length;
  const rejected = current.filter((req) => String(req.status || '') === 'rejected').length;
  // 本轮唯一需求被投票驳回时没有 accepted：这也是收口（rejected 已由后端确认无在办需求），
  // 允许迭代去释放下一轮需求；否则“投票驳回 → 新需求”必然死锁。
  const closedByRejection = !accepted && rejected > 0
    && current.every((req) => String(req.status || '') === 'rejected');
  if (!accepted && !closedByRejection) {
    return { ok: false, code: 'not-accepted', reason: '还没有已验收需求：迭代只在 Owner 验收通过后可用（当前全部需求被投票驳回时例外）' };
  }
  const placeholders = legacyBootPlaceholderDocs();
  if (placeholders.length) {
    return {
      ok: false,
      code: 'placeholder',
      reason: `项目信息/项目铁律仍有模板占位：${placeholders.join('、')}；先把正文写清再迭代，boot 与推进都会被后端拒绝（PLACEHOLDER_DOC）`
    };
  }
  if (phase !== 'accepted' && !closedByRejection) {
    return {
      ok: false,
      code: 'not-accepted',
      reason: `当前阶段 ${phase || '未读取'}：迭代只在全部需求验收后（accepted）可用；有在办需求先收口`
    };
  }
  // PM 未 boot 不再禁用迭代：执行前会自动补 boot，后端仍校验 PM 的阅读证据。
  return { ok: true, code: 'ok', reason: '' };
}

/** boot 按钮统一状态：过期/文档变更/跨轮都显示“重新 boot”，且只有命令存在时才可点。 */
function legacyBootControl(roleId) {
  const boot = legacyBootFor(roleId);
  const gate = legacyActionCommandGate('boot');
  const disabled = boot.ready || !gate.ok;
  const text = boot.ready ? '已 boot'
    : (boot.booted ? '重新 boot' : 'boot');
  const title = boot.ready
    ? '已 boot / 读全且未过期'
    : (!gate.ok ? gate.reason : `${boot.label}；点击调用 workflow:boot（界面发起不冒充角色本人）`);
  return { boot, gate, disabled, text, title };
}

function legacyBootButtonMarkup(role, className = '') {
  const ctl = legacyBootControl(role.id);
  return `<button${className ? ` class="${esc(className)}"` : ''} type="button" data-legacy-boot="${esc(role.id)}" ${ctl.disabled ? 'disabled' : ''} title="${esc(ctl.title)}">${esc(ctl.text)}</button>`;
}

/**
 * 命令状态只认后端能力矩阵，三种状态，绝不把“没探测”写成“缺”：
 *  - ok：矩阵明确 true；
 *  - missing：矩阵明确 false，或被写进 caps.missing（真正缺失）；
 *  - unknown：矩阵里根本没有这条命令 → 显示“未核验”。
 * 旧协议的 inbox / read / ack 取决于后端能力矩阵是否覆盖：新版矩阵会返回，
 * 旧版矩阵可能没有这三个键。以前按“commands 里没有键 = 缺”渲染，
 * 项目面板因此误报 inbox缺/read缺/ack缺；现在没有数据只写“未核验”。
 */
const LEGACY_MATRIX_COMMANDS = [
  ['boot', 'boot'], ['send', 'send'],
  ['task', 'task'], ['taskClaim', 'task claim'], ['taskDone', 'task done'],
  ['req', 'req'], ['reqCreate', 'req create'], ['reqReview', 'req review'],
  ['propose', 'propose'], ['show', 'show'], ['review', 'review'], ['sign', 'sign'], ['apply', 'apply'],
  ['grant', 'grant'], ['index', 'index'], ['workflow', 'workflow'], ['owner', 'owner']
];
const LEGACY_UNPROBED_COMMANDS = [['inbox', 'inbox'], ['read', 'read'], ['ack', 'ack']];
const LEGACY_DERIVED_COMMANDS = { taskClaim: 'taskClaim', taskDone: 'taskDone', reqCreate: 'reqCreate', reqReview: 'reqReview' };

function legacyCapabilityState(caps, key, label) {
  if (!caps || caps.available !== true) return 'unknown';
  let value;
  if (LEGACY_DERIVED_COMMANDS[key]) value = caps[LEGACY_DERIVED_COMMANDS[key]];
  else if (caps.commands && Object.prototype.hasOwnProperty.call(caps.commands, key)) value = caps.commands[key];
  else value = undefined;
  if (value === true) return 'ok';
  const missing = Array.isArray(caps.missing) ? caps.missing : [];
  if (value === false || missing.includes(label)) return 'missing';
  return 'unknown';
}

function legacyCapabilityUnknownLabels(caps) {
  return [...LEGACY_MATRIX_COMMANDS, ...LEGACY_UNPROBED_COMMANDS]
    .filter(([key, label]) => legacyCapabilityState(caps, key, label) === 'unknown')
    .map(([, label]) => label);
}

function legacyCapabilitiesMarkup() {
  const wb = window.workbench || null;
  const { legacy, caps } = legacyCapabilityData();
  const ipcChips = LEGACY_IPC.map((item) => {
    const ok = Boolean(wb && typeof wb[item.fn] === 'function');
    return `<span class="legacy-cap-chip ${ok ? 'ok' : 'bad'}" title="${esc(item.label)}"><code>${esc(item.ipc)}</code>${ok ? '有' : '缺'}</span>`;
  }).join('');
  let toolBody = '';
  if (!caps) {
    toolBody = `<div class="legacy-cap-missing">正在从 <code>workflow:state</code> / <code>team:status</code> 读取旧命令能力；矩阵返回前按钮不会伪装成可用，也不会把“待核验”写成“齐全”。</div>`;
  } else if (!caps.available) {
    toolBody = `<div class="legacy-cap-missing">旧团队工具不存在：<code>${esc(caps.file || '未返回路径')}</code>。所有旧命令都会明确失败（<code>LEGACY_PROTOCOL_REQUIRED</code>），界面不会显示成功。</div>`;
  } else if (caps.assumed) {
    toolBody = `<div class="legacy-cap-file">team.mjs：<code>${esc(caps.file || '未返回路径')}</code>（来源 <code>team:status</code>）</div>
      <div class="legacy-cap-missing">workflow:state 还没有返回旧命令矩阵；已从 team:status 确认 team.mjs 存在，先放行 boot / 建需求。命令缺口一旦由 workflow:state 返回就立即以真实矩阵为准，动作失败仍以后端返回码为准。</div>`;
  } else {
    const chipOne = ([key, label]) => {
      const state = legacyCapabilityState(caps, key, label);
      const cls = state === 'ok' ? 'ok' : (state === 'missing' ? 'bad' : 'unknown');
      const word = state === 'ok' ? '有' : (state === 'missing' ? '缺' : '未核验');
      const title = state === 'ok'
        ? '后端命令矩阵报告可用'
        : state === 'missing'
          ? '后端命令矩阵报告缺失：对应动作按钮会禁用，后端写状态前会返回 LEGACY_PROTOCOL_REQUIRED'
          : '能力矩阵没有返回这条命令：这里写“未核验”，不显示成缺失，也不伪装成可用';
      return `<span class="legacy-cap-chip ${cls}" title="${esc(title)}"><code>${esc(label)}</code>${word}</span>`;
    };
    const chips = [...LEGACY_MATRIX_COMMANDS, ...LEGACY_UNPROBED_COMMANDS].map(chipOne).join('');
    const missing = Array.isArray(caps.missing) ? caps.missing : [];
    const optional = Array.isArray(caps.optionalMissing) ? caps.optionalMissing : [];
    const unprobed = legacyCapabilityUnknownLabels(caps);
    toolBody = `<div class="legacy-cap-file">team.mjs：<code>${esc(caps.file || '未返回路径')}</code></div>
      <div class="legacy-cap-chips">${chips}</div>
      <p class="legacy-cap-note">缺失命令：${missing.length ? missing.map((name) => `<code>${esc(name)}</code>`).join('、') : '无'}
        ${optional.length ? ` ｜ 可选缺失：${optional.map((name) => `<code>${esc(name)}</code>`).join('、')}` : ''}</p>
      ${unprobed.length ? `<p class="legacy-cap-note">未核验：${unprobed.map((name) => `<code>${esc(name)}</code>`).join('、')}
        ｜ 能力矩阵没有返回这些命令；只写“未核验”，不当作缺失，也不伪装成可用。</p>` : ''}
      <p class="legacy-cap-note">只有 <code>caps.missing</code> 或矩阵明确 <code>false</code> 才写“缺”；矩阵没有返回的命令一律写“未核验”，对应动作按钮暂时禁用，不写成缺失。后端写状态前仍会返回 <code>LEGACY_PROTOCOL_REQUIRED</code>，不会按文件契约伪造成功。</p>`;
  }
  const driver = legacy && legacy.source ? `<div class="legacy-cap-source">工作流来源：<code>${esc(legacy.source)}</code>${legacy.file ? ` · <span class="mono">${esc(legacyShortPath(legacy.file))}</span>` : ''}${legacy.schema ? ` · schema ${esc(String(legacy.schema))}` : ''}</div>` : '';
  return `<div class="legacy-capabilities">
    <div class="legacy-cap-section">
      <div class="legacy-cap-title">preload IPC / 渲染层实际可调</div>
      <div class="legacy-cap-chips">${ipcChips}</div>
    </div>
    <div class="legacy-cap-section">
      <div class="legacy-cap-title">旧团队工具命令</div>
      ${toolBody}
      ${driver}
    </div>
  </div>`;
}

function legacyLastActionMarkup() {
  const last = legacyUi.lastAction;
  if (!last) return '<div class="legacy-last-action-none">本次界面还没有执行 workflow 动作；动作结果会在这里留痕，刷新后只保留后端文件状态。</div>';
  const shellOwned = Boolean(last.shellOwned);
  const missingCommand = Boolean(!shellOwned && (last.contractOnly || (last.command && last.commandAvailable === false)));
  const warnings = Array.isArray(last.warnings) ? last.warnings : [];
  const taskDone = last.requirementTaskDone || null;
  const warnText = warnings.map((row) => `<span class="legacy-action-warn"><code>${esc(row.code || 'WARNING')}</code> ${esc(String(row.message || '').slice(0, 200))}</span>`).join('');
  const cls = (last.ok === false || (taskDone && !taskDone.ok)) ? 'bad' : (missingCommand || warnings.length ? 'warn' : 'ok');
  return `<div class="legacy-last-action ${cls}">
    <div class="legacy-last-action-head">
      <b>最近动作：${esc(last.label || last.action || '未记录')}</b>
      <span class="badge ${(last.ok === false || (taskDone && !taskDone.ok)) ? 'badge-rejected' : (missingCommand ? 'badge-skipped' : 'badge-approved')}">${last.ok === false ? '失败' : (taskDone && !taskDone.ok ? '验收成功 · 旧任务未收口' : (missingCommand ? '旧命令缺失 · 未写状态' : (shellOwned ? '壳层推进 · 已写状态' : '后端返回成功')))}</span>
    </div>
    <p>时间 ${esc(last.at ? fmtTime(last.at) : '未记录')} · code <code>${esc(last.code || '未记录')}</code>${last.driver ? ` · driver <code>${esc(last.driver)}</code>` : ''}</p>
    ${last.actor ? `<p>提交 actor=<code>${esc(last.actor)}</code>（本机点击；不是 DSH 身份证明）</p>` : ''}
    <p>旧命令 ${last.command ? `<code>${esc(last.command)}</code> ${shellOwned ? '<b>不存在；由工作台壳层收口并已写 工作流.json（不冒充 team.mjs）</b>' : (last.commandAvailable === true ? '可用' : last.commandAvailable === false ? '<b class="bad">缺失（后端拒绝，未写状态）</b>' : '未返回可用性')}` : '未返回命令信息'}${last.workflowFile ? ` · 写 <span class="mono">${esc(legacyShortPath(last.workflowFile))}</span>` : ''}</p>
    ${taskDone ? `<p class="${taskDone.ok ? '' : 'bad'}">Owner 验收后旧任务收口：${taskDone.ok
      ? 'task done 成功（旧任务已关闭）'
      : `失败 <code>${esc(taskDone.code)}</code> ${esc(taskDone.message || '旧任务可能仍未关闭')}`}</p>` : ''}
    ${last.projectIndex ? `<p class="${last.projectIndex.ok ? '' : 'bad'}">项目索引刷新：${last.projectIndex.ok
      ? `${last.projectIndex.files} 个文件 · ${legacyRealRequirementCount()} 条需求（只计 需求/R-*.md；评审/验收记录不计） · ${last.projectIndex.roleIndexes} 个角色索引`
      : `失败 <code>${esc(last.projectIndex.code)}</code> ${esc(last.projectIndex.message || '旧 index 命令未完成')}`}</p>` : ''}
    ${warnText}
    ${last.ok === false ? `<p class="bad">${esc(last.message || '后端拒绝执行')}</p>` : ''}
  </div>`;
}

const LEGACY_REQ_STATUS = {
  review: '待需求评审',
  tech_review: '待开发技术评审',
  approved: '待 Owner 决定',
  ready: '待 PM 派单',
  dev: '开发中',
  dev_review: '待互审',
  dev_done: '开发完成',
  test: '测试中',
  test_done: '待 Owner 验收',
  accepted: '已验收',
  iteration: '已转下一次',
  terminated: '已终止',
  rejected: '已打回'
};

function legacyReqStatus(req) {
  const terms = modeTerms();
  const status = String((req && req.status) || 'review');
  let label = LEGACY_REQ_STATUS[status] || status;
  if (status === 'review') label = `待${terms.review}`;
  else if (status === 'tech_review') label = `TR · 待${terms.techReview}`;
  else if (status === 'ready') label = 'ready · 待 PM 派单';
  else if (status === 'dev_review') label = `待${terms.devReview}`;
  // 投票驳回不是死锁：该需求仍可重新走分析师评审，状态直接写“可迭代”。
  if (req && req.voteRejection && status === 'rejected') label = '可迭代 · 待重新评审';
  if (req && req.queued) label += ' · 下一次排队';
  return label;
}

function legacyActorName(id) {
  const value = String(id || '').trim();
  if (!value) return '未记录';
  if (value === 'owner' || value === 'Owner') return 'Owner';
  return roleById(value).name;
}

function legacyActorText(by, extra = '') {
  const actor = String(by || '').trim();
  if (!actor) return '执行者/记录人未记录';
  const name = actor === 'owner' || actor === 'Owner' ? 'Owner' : roleById(actor).name;
  return `${name}（by=${actor}${extra ? ' · ' + extra : ''}）`;
}

function legacyOwnerStatusText(status) {
  const key = String(status || '').toLowerCase();
  if (key === 'approved') return '已通过';
  if (key === 'skipped') return '已跳过';
  if (key === 'rejected') return '已打回';
  if (key === 'accepted') return '已验收';
  if (key === 'iteration') return '转下一次';
  if (key === 'terminated') return '已终止';
  if (key === 'pending' || key === 'optional') return '待决定';
  return key || '未写结论';
}

function legacyOwnerConfirmationKey(requirementId) {
  return `${legacyUi.projectId || ''}|${String(requirementId || '')}`;
}

/** 记录一次“本机 Owner（我）点击后”的动作；只在内存里，刷新即失效。 */
function legacyRememberOwnerConfirmation({ requirementId, kind, at, decision, actor = OWNER_CONFIRM_ACTOR }) {
  const id = String(requirementId || '').trim();
  if (!id) return null;
  const entry = {
    requirementId: id,
    kind: String(kind || ''),
    at: at ? String(at) : '',
    decision: String(decision || ''),
    actor: String(actor || OWNER_CONFIRM_ACTOR),
    confirmedAt: new Date().toISOString()
  };
  legacyUi.ownerConfirmations[legacyOwnerConfirmationKey(id)] = entry;
  return entry;
}

/**
 * 找到与这条后端记录对应的本机确认。
 * 优先按 at 精确匹配；如果后端没回 at，则按需求 + 动作类型退回本次确认记录。
 */
function legacyOwnerConfirmationFor(record, requirementId, kind) {
  const id = String(requirementId || '').trim();
  if (!id) return null;
  const entry = legacyUi.ownerConfirmations[legacyOwnerConfirmationKey(id)];
  if (!entry) return null;
  if (kind && entry.kind && entry.kind !== kind) return null;
  const at = record && record.at ? String(record.at) : '';
  if (at && entry.at && at !== entry.at) return null;
  return entry;
}

function legacyOwnerRecordText(record, label = 'Owner', requirementId = '', kind = '') {
  if (!record || typeof record !== 'object') return `${label} 待 Owner（无记录）`;
  const status = String(record.status || '').trim().toLowerCase();
  if (!status || status === 'pending' || status === 'optional') {
    return `${label} 尚未决定 · 待 Owner（无记录）`;
  }
  const statusLabel = legacyOwnerStatusText(status);
  const by = String(record.by || '').trim();
  const confirmed = legacyOwnerConfirmationFor(record, requirementId, kind);
  const actor = String(record.actor || (confirmed && confirmed.actor) || '').trim();
  // 有结论但没有 actor：不写成“待 Owner”（那会像还没决定），也不补造成 Owner 本人。
  if (!actor) return `${label} ${statusLabel} · 记录人未认证（by=${by || '未记录'}）`;
  return `${label} ${statusLabel} · ${legacyActorText(by, 'actor ' + actor)}${confirmed && !record.actor ? '（本机点击）' : ''}`;
}

/**
 * Owner 记录只写真实字段：
 * - pending 只是产品评审后预写的占位，没有 Owner 决定，不能显示 by=Owner；
 * - 有结论但 actor 未记录时，不补造成 Owner 本人，明确写“记录人未认证”；
 * - 只有本次界面里点下 Owner（我）按钮，才把本机 actor 补在显示层。
 */
function legacyOwnerReviewText(ownerReview, requirementId = '') {
  return legacyOwnerRecordText(ownerReview, 'Owner', requirementId, 'owner');
}


function legacyDocRecord(rel) {
  return rel ? legacyUi.docs[rel] || null : null;
}

function resetLegacyUiFor(projectId) {
  if (bootExpiryTimer) {
    clearTimeout(bootExpiryTimer);
    bootExpiryTimer = null;
  }
  legacyUi.projectId = projectId || null;
  legacyUi.files = null;
  legacyUi.truncated = false;
  legacyUi.docEpoch = (legacyUi.docEpoch || 0) + 1;
  legacyUi.docs = Object.create(null);
  legacyUi.reading = Object.create(null);
  legacyUi.forceQueued = false;
  legacyUi.workflow = null;
  legacyUi.briefing = null;
  legacyUi.briefingError = null;
  legacyUi.presence = null;
  legacyUi.presenceError = null;
  legacyUi.workflowError = null;
  legacyUi.phaseHint = null;
  legacyUi.error = null;
  legacyUi.ipcMissing = [];
  legacyUi.bootEvidence = Object.create(null);
  legacyUi.bootingAll = false;
  legacyUi.lastAction = null;
  legacyUi.at = 0;
}

async function legacyReadDoc(rel) {
  const p = activeProject();
  if (!p || !rel || legacyUi.projectId !== p.id) return null;
  const epoch = legacyUi.docEpoch || 0;
  const file = (legacyUi.files || []).find((row) => row && row.rel === rel);
  const cached = legacyUi.docs[rel];
  // 同一项目里文档被外部改写/动作重写后，文件大小一般会变：缓存大小不一致就重读，
  // 不能拿旧正文继续显示“模板占位”或旧索引。
  if (cached && file && Number.isFinite(Number(file.size)) && Number(file.size) !== Number(cached.size)) {
    delete legacyUi.docs[rel];
  } else if (cached && (cached.ok || cached.error)) {
    return cached;
  }
  if (legacyUi.reading && legacyUi.reading[rel]) return legacyUi.reading[rel];
  if (!legacyUi.reading) legacyUi.reading = Object.create(null);
  const task = (async () => {
    let entry = null;
    try {
      if (!window.workbench || typeof window.workbench.filesRead !== 'function') {
        entry = { ok: false, rel, error: '当前 preload 没有 files:read，无法读取文档', at: Date.now() };
      } else {
        const result = await window.workbench.filesRead({ projectId: p.id, rel });
        entry = {
          ok: true,
          rel,
          kind: result && result.kind ? result.kind : 'text',
          text: String((result && result.text) || ''),
          size: Number(result && result.size) || 0,
          at: Date.now()
        };
      }
    } catch (e) {
      entry = { ok: false, rel, error: humanError(e.message), at: Date.now() };
    }
    if (legacyUi.projectId === p.id && (legacyUi.docEpoch || 0) === epoch) legacyUi.docs[rel] = entry;
    return entry;
  })();
  legacyUi.reading[rel] = task;
  try { return await task; } finally { if (legacyUi.reading[rel] === task) delete legacyUi.reading[rel]; }
}

/** 等首轮 files:list / files:read 收尾；创建项目后据此判断“文档已就绪”，不拿半帧状态下结论。 */
async function legacyWaitForDocs(timeoutMs = 10000) {
  const start = Date.now();
  while ((legacyUi.loading || !legacyUi.files) && Date.now() - start < timeoutMs) {
    await new Promise((resolve) => setTimeout(resolve, 80));
  }
  return Boolean(legacyUi.files);
}

async function loadLegacyDocs(force = false) {
  if (!state) return;
  const p = activeProject();
  if (!p) {
    resetLegacyUiFor(null);
    renderLegacyPanels();
    return;
  }
  if (legacyUi.loading) {
    // 强制刷新撞上进行中的读取：记下来，等当前读取收尾后重跑一遍，避免“点了刷新没反应”。
    if (force) legacyUi.forceQueued = true;
    return;
  }
  if (!force && legacyUi.projectId === p.id && legacyUi.files && Date.now() - legacyUi.at < 30000) {
    renderLegacyPanels();
    return;
  }
  if (legacyUi.projectId !== p.id) {
    resetLegacyUiFor(p.id);
  } else if (force) {
    // 关键：刷新必须清掉正文缓存，否则手改/动作重写后仍显示旧文档（旧“模板占位”会卡住推进）。
    legacyUi.docEpoch = (legacyUi.docEpoch || 0) + 1;
    legacyUi.docs = Object.create(null);
    legacyUi.reading = Object.create(null);
    legacyUi.at = 0;
  }
  // preload 缺口要逐项列出来：缺哪个 IPC 就明说，不能只显示“未核验”让人猜。
  const wb = window.workbench || null;
  const requiredIpc = [
    ['files:list', 'filesList'],
    ['files:read', 'filesRead'],
    ['docs:presence', 'docsPresence'],
    ['workflow:state', 'workflowState'],
    ['workflow:next', 'workflowNext'],
    ['workflow:briefing', 'workflowBriefing'],
    ['workflow:boot', 'workflowBoot']
  ];
  legacyUi.ipcMissing = wb ? requiredIpc.filter(([, name]) => typeof wb[name] !== 'function').map(([ipc]) => ipc) : requiredIpc.map(([ipc]) => ipc);
  if (!wb || typeof wb.filesList !== 'function') {
    legacyUi.error = '当前 preload 没有 files:list，无法读取六角色目录与必读文档；旧命令与 boot 状态同样不可核验';
    renderLegacyPanels();
    return;
  }
  legacyUi.loading = true;
  legacyUi.error = null;
  // 空项目的 workflow:state 可能不返回 legacy.capabilities；先读一次只读 team:status，
  // 让第一帧就能按 team.mjs 存在放行 boot / 建需求，而不是显示“未读取”再锁死按钮。
  if (!legacyCapabilityData().caps) await legacyProbeTeamStatus();
  renderLegacyPanels();
  const wanted = p.id;
  try {
    const listPromise = wb.filesList(p.id);
    const workflowPromise = typeof wb.workflowState === 'function'
      ? wb.workflowState({ projectId: p.id }).catch((e) => ({ ok: false, code: 'WORKFLOW_STATE_FAILED', message: humanError(e.message) }))
      : (typeof wb.workflow === 'function'
        ? wb.workflow({ projectId: p.id }).catch(() => null)
        : Promise.resolve(null));
    const nextPromise = typeof wb.workflowNext === 'function'
      ? wb.workflowNext({ projectId: p.id }).catch((e) => ({ ok: false, code: 'WORKFLOW_NEXT_FAILED', message: humanError(e.message) }))
      : Promise.resolve(null);
    const briefingPromise = typeof wb.workflowBriefing === 'function'
      ? wb.workflowBriefing({ projectId: p.id }).catch((e) => ({ ok: false, code: 'BRIEFING_FAILED', message: humanError(e.message) }))
      : Promise.resolve(null);
    // B-20261114-003257-0a46：项目信息/项目铁律的真实存在性（直达文件系统，不信截断清单）。
    const presencePromise = typeof wb.docsPresence === 'function'
      ? wb.docsPresence({ projectId: p.id }).catch((e) => ({ ok: false, code: 'PRESENCE_FAILED', message: humanError(e.message) }))
      : Promise.resolve(null);
    const [list, workflow, next, briefing, presence] = await Promise.all([listPromise, workflowPromise, nextPromise, briefingPromise, presencePromise]);
    if (!activeProject() || activeProject().id !== wanted) return;
    legacyUi.files = list && Array.isArray(list.files) ? list.files : [];
    legacyUi.truncated = Boolean(list && list.truncated);
    legacyUi.presence = presence && presence.ok !== false && Array.isArray(presence.checks) ? presence : null;
    legacyUi.presenceError = presence && presence.ok === false
      ? { code: presence.code || 'PRESENCE_FAILED', message: presence.message || presence.why || 'docs:presence 读取失败' }
      : null;
    const nextOk = next && next.ok !== false && Array.isArray(next.requirements);
    const stateOk = workflow && workflow.ok !== false;
    if (nextOk || stateOk) {
      const mergedRequirements = nextOk
        ? next.requirements
        : ((stateOk && Array.isArray(workflow.requirements)) ? workflow.requirements : []);
      const rawPhase = (stateOk && workflow.phase)
        ? String(workflow.phase)
        : (nextOk ? legacyPhaseFromRequirements(next.requirements, next.round) : 'idle');
      const merged = {
        ...(stateOk ? workflow : {}),
        ...(nextOk ? next : {}),
        // 后端 snapshot 的 phase 是权威（含迭代/终止决定）；只有在它缺省时才按需求状态反推。
        // 历史需求里有一条 terminated 不能把整个工作流显示成已终止。
        // 评审打回/投票驳回后后端把 phase 写成 requirement：界面按实际阶段显示
        // requirement_review，避免被驳回需求被误读成“还没评审”。
        phase: legacyDisplayPhase(rawPhase, mergedRequirements),
        requirements: mergedRequirements,
        tasks: (stateOk && Array.isArray(workflow.tasks)) ? workflow.tasks : (Array.isArray(p.tasks) ? p.tasks : []),
        round: nextOk && next.round ? next.round : ((stateOk && workflow.round) || 1),
        // workflow:state 里的旧工具能力/文件契约信息必须保留，合并 next 时不能被冲掉。
        legacy: (stateOk && workflow.legacy) || (nextOk && next.legacy) || null
      };
      // B-2e5 AC3：快照偶发把活跃项目判成 terminated（实测 readWorkflowSnapshot 返回 terminated，
      // 而 工作流.json 是 dispatch；旧需求文档被合并成 review 行）。有活跃需求时不得显示已终止：
      // 按活跃需求反推阶段，并把冲突记在快照上供面板提示（中性提示，不是红项）。
      const liveRows = mergedRequirements.filter((row) => row && String(row.status || '')
        && !['accepted', 'terminated', 'iteration', 'rejected'].includes(String(row.status)));
      if (String(merged.phase) === 'terminated' && liveRows.length) {
        merged.phase = legacyPhaseFromRequirements(mergedRequirements, merged.round);
        merged.phaseConflict = { reported: 'terminated', liveRows: liveRows.length, correctedTo: merged.phase };
      }
      const statusKey = (merged.requirements || []).map((row) => String(row.id || '') + ':' + String(row.status || '')).join('|');
      const hint = legacyUi.phaseHint;
      if (hint && Number(hint.round) === Number(merged.round) && hint.statusKey === statusKey) {
        merged.phase = legacyDisplayPhase(hint.phase, merged.requirements);
      }
      // 不再用 p.workflowMirror.phase 覆盖刚读到的 snapshot：那是上次 apply 时的旧镜像，
      // 角色直接写 工作流.json 后它不会更新，会把流程图永久钉在旧阶段。
      legacyUi.workflow = merged;
      // B-410e：首屏/刷新读到的这份工作流也要记「读到时刻」，否则流程面板会显示「刷新时刻未知」。
      try {
        const readAtMs = Date.parse(String((workflow && workflow.readAt) || (next && next.readAt) || ''));
        flowLiveState.refreshedAt = Number.isFinite(readAtMs) ? readAtMs : Date.now();
        flowLiveState.lastError = null;
      } catch { /* 时间戳失败不影响取数 */ }
    } else {
      legacyUi.workflow = null;
    }
    legacyUi.workflowError = (!nextOk && !stateOk)
      ? {
        code: (next && next.code) || (workflow && workflow.code) || 'WORKFLOW_STATE_FAILED',
        message: (next && (next.message || next.why)) || (workflow && (workflow.message || workflow.why)) || '工作流状态读取失败'
      }
      : null;
    legacyUi.briefing = briefing && briefing.ok !== false ? briefing : null;
    if (typeof wb.workflowBriefing !== 'function') {
      legacyUi.briefingError = { code: 'IPC_MISSING', message: '当前 preload 没有 workflow:briefing，无法核验每次 boot / 必读状态' };
    } else if (!briefing) {
      legacyUi.briefingError = { code: 'BRIEFING_MISSING', message: 'workflow:briefing 没有返回结果，boot 证据不可核验' };
    } else if (briefing.ok === false) {
      legacyUi.briefingError = { code: briefing.code || 'BRIEFING_FAILED', message: briefing.message || briefing.why || 'workflow:briefing 读取失败' };
    } else {
      legacyUi.briefingError = null;
    }
    legacyUi.at = Date.now();
    const roles = teamRoles();
    const rels = [
      ...LEGACY_PROJECT_DOCS.map((item) => item.rel),
      ...roles.flatMap((role) => [legacyRoleCardRel(role), legacyRoleIndexRel(role)])
    ].filter((rel) => rel && legacyHas(rel));
    await Promise.all(rels.map((rel) => legacyReadDoc(rel)));
  } catch (e) {
    legacyUi.error = humanError(e.message);
  } finally {
    legacyUi.loading = false;
    renderLegacyPanels();
    if (legacyUi.forceQueued) {
      legacyUi.forceQueued = false;
      setTimeout(() => { loadLegacyDocs(true); }, 0);
    }
  }
}

/**
 * 项目/团队浮层顶部的“真源条”：IPC、旧命令、boot、账本、文档一屏可见。
 * F-9fbe-6：三个数字（boot X/N、文档待补 N、账本分叉 N）全页只在这里出现一次，
 * 其它位置只写状态（已齐/待核验/一致/分叉），不再各算一遍数字。
 */
function legacyTruthMarkup() {
  const wb = window.workbench || null;
  const missing = LEGACY_IPC.filter((item) => !(wb && typeof wb[item.fn] === 'function'));
  const { caps } = legacyCapabilityData();
  const boot = legacyBootSummary();
  const ledger = legacyLedgerView();
  const readiness = legacyDocReadiness();
  const gate = legacyGateState();
  const chip = (cls, text, title, fix, attrs) => `<span class="truth-chip ${cls}" data-panel-level="${cls === 'bad' ? 'block' : (cls === 'warn' ? 'warn' : (cls === 'muted' ? 'info' : 'ok'))}" data-legacy-fix="${esc(fix || '')}" title="${esc(title || '')}"${attrs ? ' ' + attrs : ''}><b>${esc(text)}</b></span>`;
  const rows = [];
  if (!wb) rows.push(chip('bad', 'preload 未加载', 'window.workbench 不存在：所有项目/团队数据不可用'));
  else rows.push(chip('ok', 'preload 已加载', 'preload IPC 桥已加载'));
  rows.push(missing.length
    ? chip('bad', `IPC 缺 ${missing.length}`, `缺少：${missing.map((item) => item.ipc + '（' + item.label + '）').join('、')}`)
    : chip('ok', 'IPC 齐全', LEGACY_IPC.map((item) => item.ipc).join('、')));
  if (!wb || typeof wb.filesList !== 'function') rows.push(chip('bad', 'files:list 缺', '无法读取六角色目录与项目文档'));
  else if (legacyUi.error) rows.push(chip('bad', 'files 读取失败', legacyUi.error));
  else if (legacyUi.loading) rows.push(chip('muted', 'files 读取中', 'files:list / files:read 正在读取'));
  // 这里只报 files:list 的条目数（截断口径），不是「文档待补 N」，两者不能混。
  else if (legacyUi.files) rows.push(chip('ok', `清单 ${legacyFiles().length} 项`, 'files:list 实际返回的条目数；截断时会另标'));
  else rows.push(chip('muted', 'files 未读取', '打开项目面板或刷新后读取'));
  if (!wb || (typeof wb.workflowState !== 'function' && typeof wb.workflow !== 'function')) rows.push(chip('bad', 'workflow 缺', '缺少 workflow:state / workflow:get，无法核验旧工作流'));
  else if (legacyUi.workflow) rows.push(chip('ok', 'workflow 已读', `工作流阶段 ${legacyUi.workflow.phase || '未写'}；来源 工作流.json`));
  else if (legacyUi.workflowError) rows.push(chip('bad', 'workflow 读取失败', `${legacyUi.workflowError.code}：${legacyUi.workflowError.message}`));
  else rows.push(chip('muted', 'workflow 未读取', '等待 workflow:state'));
  if (!wb || typeof wb.workflowBriefing !== 'function') rows.push(chip('bad', 'briefing 缺', '没有 workflow:briefing，每次 boot 证据不可核验'));
  else if (legacyUi.briefingError) rows.push(chip('warn', 'briefing 失败', `${legacyUi.briefingError.code}：${legacyUi.briefingError.message}（boot 只写待核验，不当红项）`));
  else if (legacyUi.briefing) rows.push(chip('ok', 'briefing 已读', '每次 boot / 必读核验来自后端'));
  else rows.push(chip('muted', 'briefing 未读取', '等待 workflow:briefing：boot 只写待核验，不写 0/N'));
  if (!caps) rows.push(chip('muted', '旧命令 待核验', '正在从 workflow:state / team:status 读取旧命令能力；矩阵返回前不显示成“齐全”，也不伪造可用'));
  else if (!caps.available) rows.push(chip('bad', 'team.mjs 缺', caps.file || '旧团队工具不存在：旧命令会明确失败'));
  else if (caps.assumed) rows.push(chip('warn', '旧命令 按 team.mjs 放行', caps.note || 'team:status 确认 team.mjs 存在；命令矩阵待 workflow:state 返回'));
  else if ((caps.missing || []).length) rows.push(chip('warn', `旧命令缺 ${caps.missing.length}`, `缺失：${caps.missing.join('、')}；按文件契约记录时界面会标出`));
  else {
    const unknown = legacyCapabilityUnknownLabels(caps);
    rows.push(unknown.length
      ? chip('warn', `旧命令 未核验 ${unknown.length}`, `能力矩阵没有返回这些命令：${unknown.join('、')}；只写“未核验”，不显示成缺失，也不说成齐全`)
      : chip('ok', '旧命令齐全', (caps.commands ? Object.keys(caps.commands).length : 0) + ' 条命令可用'));
  }
  // F-9fbe-3：boot X/N 的全页唯一出处；briefing 没取到就写「待核验」，绝不写 0/N。
  // N = 当前团队角色数（名册 members 优先，缺失退回 sessions），来源挂 data-boot-source。
  rows.push(chip(
    boot.known ? (boot.allComplete ? 'ok' : 'warn') : 'muted',
    boot.known ? `boot ${bootCountText(boot)}` : 'boot 待核验',
    boot.known
      ? `boot/已读 ${bootCountText(boot)}：只数本轮且有效（round 相同、非旧会话、必读读全）；N=当前团队角色数（来源：${boot.sourceLabel || '团队模式角色'}）。TTL 过期只提示，不拦推进。`
      : `boot 待核验${legacyUi.briefingError ? `（${legacyUi.briefingError.code}）` : ''}：没有 briefing 就不写 0/N，也不当红项；点「重试核验」重新读取。`,
    '',
    `data-boot-source="${esc(boot.source || 'roles')}" data-boot-complete="${Number(boot.complete) || 0}" data-boot-total="${Number(boot.total) || 0}"`
  ));
  // F-9fbe-4/6：账本分叉 N 的全页唯一出处；来源挂 data-ledger-source（snapshot / legacy）。
  const ledgerFix = ledger.count ? 'ledger' : '';
  rows.push(chip(
    ledger.count ? 'warn' : (ledger.known ? 'ok' : 'muted'),
    ledger.count ? `账本分叉 ${ledger.count}` : (ledger.known ? '账本一致' : '账本 未核验'),
    ledger.count
      ? ledger.forks.map(({ req, ledger: row }) => `${req.id}：${row.label}`).join('；')
      : '任务状态与工作流一致；返工在途/任务在办不计分叉',
    ledgerFix,
    `data-ledger-source="${ledger.source === 'legacy' ? 'legacy' : (ledger.known ? 'snapshot' : 'none')}" data-ledger-count="${Number(ledger.count) || 0}" data-ledger-inflight="${Number(ledger.inFlightCount) || 0}"`
  ));
  // F-9fbe-6：文档待补 N 的全页唯一出处，与 #missing-list 的 data-missing-count 同源（docs:presence 缺口）。
  const docChipCls = ((!legacyUi.files && !legacyUi.presence) || readiness.pendingRead) ? 'muted'
    : (readiness.missing.length ? 'bad'
      : (readiness.bootPlaceholders.length ? 'bad' : (readiness.readErrors.length ? 'warn' : 'ok')));
  rows.push(readiness.ok
    ? chip('ok', '文档已就绪', `必要文档齐全，且项目信息/项目铁律不是模板占位；六角色目录 ${readiness.dirs}/${readiness.total}、角色卡 ${readiness.cards}/${readiness.total}、文件索引 ${readiness.indexes}/${readiness.total}`, 'docs', `data-missing-doc-count="${readiness.missing.length}"`)
    : chip(
      docChipCls,
      readiness.label,
      `缺文件：${readiness.missing.join('、') || '无'}；boot 阻断占位：${readiness.bootPlaceholders.join('、') || '无'}；读取失败：${readiness.readErrors.join('、') || '无'}（缺文档清单 #missing-list 与这里同源同数）`,
      'docs',
      `data-missing-doc-count="${readiness.missing.length}"`
    ));
  if (readiness.overviewPlaceholder) rows.push(chip('muted', '需求总览待首条需求', '需求/00-需求总览.md 还是模板表头；第一条需求落盘时会被重写，不挡 boot'));
  if (legacyUi.truncated) rows.push(chip('warn', '文件清单已截断', 'files:list 达到 600 项 / 4 层上限；未列出的文件不能当“缺失”'));
  return `<span class="truth-label">数据真源</span>${rows.join('')}<span class="truth-chip ${panelLevelClass(gate.level)}" data-panel-level="${gate.level}" data-gate-label="1" title="分级结论来自 panelSeverity / panelGateState 单一判定"><b>${esc(gate.label)}</b></span>`;
}

function renderTruthStrip() {
  const box = $('#project-truth');
  if (!box) return;
  const p = activeProject();
  box.innerHTML = p ? legacyTruthMarkup() : '<span class="truth-label">数据真源</span><span class="truth-chip muted"><b>未选择工作区</b></span>';
}

function syncBootAllButtons() {
  const pending = teamRoles(activeProject()).filter((role) => !legacyBootFor(role.id).ready);
  const expired = teamRoles(activeProject()).filter((role) => legacyBootFor(role.id).expired);
  const terminated = Boolean(legacyUi.workflow && legacyUi.workflow.phase === 'terminated');
  const terminateText = legacyTerminateReasonText();
  const gate = legacyActionCommandGate('boot');
  const blocked = !state || !activeProject() || !legacyUi.files || legacyUi.loading
    || legacyUi.bootingAll || terminated || !pending.length || !gate.ok;
  // AC2：过期不再作为门槛/提示口径（只影响“谁还没 boot”的计数），文案不再写「过期」。
  const pendingText = `全队 boot（缺 ${pending.length}）`;
  for (const id of ['legacy-boot-all', 'roles-boot-all', 'team-boot-all']) {
    const button = document.getElementById(id);
    if (!button) continue;
    button.disabled = blocked;
    button.textContent = legacyUi.bootingAll
      ? '正在 boot…'
      : (terminated ? (terminateText || (legacyTerminateReasonText() || '工作流已终止')) : (pending.length ? pendingText : '六角色已 boot'));
    button.title = terminated
      ? `${terminateText || (legacyTerminateReasonText() || '工作流已终止')}：不再接受 boot/推进动作`
      : (legacyUi.bootingAll
        ? '正在依次调用 workflow:boot'
        : (!gate.ok
          ? gate.reason
          : (pending.length
            ? `依次调用 workflow:boot${expired.length ? `；其中 ${expired.length} 个已过期` : ''}：${pending.map((role) => role.name).join('、')}；界面发起不冒充角色本人`
            : '六角色都已 boot/读全且未过期')));
  }
}

/** 一键全队 boot：逐个调用真实 workflow:boot；失败逐角色保留，不把部分成功说成全队读全。 */
async function legacyBootAll(button) {
  if (legacyUi.bootingAll) return;
  const gate = legacyActionCommandGate('boot');
  if (!gate.ok) { toast(gate.reason, 'bad'); return; }
  const roles = teamRoles().filter((role) => !legacyBootFor(role.id).ready);
  if (!roles.length) { toast('六角色都已 boot/读全且未过期', 'ok'); return; }
  legacyUi.bootingAll = true;
  syncBootAllButtons();
  const failures = [];
  try {
    for (let i = 0; i < roles.length; i += 1) {
      const role = roles[i];
      const liveButton = button && button.isConnected ? button : (document.getElementById('legacy-boot-all') || document.getElementById('roles-boot-all'));
      if (liveButton) liveButton.textContent = `boot ${i + 1}/${roles.length} · ${role.name}`;
      try {
        const result = await legacyCallWorkflow('boot', { role: role.id });
        if (!result || result.ok === false) {
          const failure = new Error(`[${(result && result.code) || 'BOOT_FAILED'}] ${(result && (result.message || result.why)) || 'boot 失败'}`);
          failure.code = (result && result.code) || 'BOOT_FAILED';
          throw failure;
        }
        legacyUi.bootEvidence[role.id] = result;
        if (result.state) state = result.state;
        const read = result.bootRead || {};
        if (!read.complete) failures.push(`${role.name}：缺 ${(read.missing || []).join('、') || '必读文件'}`);
      } catch (e) {
        failures.push(`${role.name}：${humanError(e.message)}`);
      }
    }
  } finally {
    legacyUi.bootingAll = false;
  }
  await loadLegacyDocs(true);
  render();
  if (failures.length) {
    toast(`全队 boot 完成，但有 ${failures.length} 个角色未读全：${failures[0]}`, 'bad');
  } else {
    toast(`全队 boot 完成：${roles.length} 个角色都已读全（后端逐角色返回；界面发起不冒充角色本人）`, 'ok');
  }
}

function renderLegacyPanels() {
  if (!state) return;
  renderTruthStrip();
  renderOverview();
  renderLegacyDocs();
  renderRoles();
  renderFlow();
  renderLegacyRequirements();
  renderLegacyTeamGate();
  renderHeader();
  renderVotes();
  renderLaunchers();
  syncBootAllButtons();
  scheduleBootExpiryTick();
  applyTeamModeCopy(document.body);
}

/* ── 总览 ─────────────────────────────────────────────── */

/**
 * F-9fbe-1/F-9fbe-2：面板原因的唯一取数（纯数据），分级交给 panelGateState。
 * 页面各处（gate 结果 / 真源条 / 团队台 / 流程浮窗）都从这里取，不再各算一套红橙。
 */
function legacyGateInput() {
  const wf = legacyWorkflow();
  const boot = legacyBootSummary();
  const readiness = legacyDocReadiness();
  const ledger = legacyLedgerView();
  const command = legacyFlowCommandGapSummary();
  const capability = legacyCapabilityData();
  const project = activeProject();
  const wfError = legacyUi.workflowError;
  const briefingError = legacyUi.briefingError;
  const docKnown = Boolean(legacyUi.files || legacyUi.presence);
  const placeholderDocs = legacyBootPlaceholderDocs();
  const firstPlaceholder = LEGACY_PROJECT_DOCS.find((doc) => placeholderDocs.includes(doc.label)) || null;
  return {
    phase: wf && wf.phase ? String(wf.phase) : (wfError ? '读取失败' : '未读取'),
    hasPreload: Boolean(window.workbench),
    filesError: legacyUi.error ? String(legacyUi.error) : '',
    terminated: Boolean(wf && String(wf.phase) === 'terminated'),
    terminateReason: legacyTerminateReasonText(),
    workflowError: wfError ? { code: wfError.code || 'WORKFLOW_STATE_FAILED', message: wfError.message || '' } : null,
    workflowPending: !legacyUi.workflow && !wfError,
    projectMissing: Boolean(project && project.exists === false),
    presenceError: legacyUi.presenceError
      ? { code: legacyUi.presenceError.code || 'PRESENCE_FAILED', message: legacyUi.presenceError.message || '' }
      : null,
    placeholders: readiness.bootPlaceholders,
    placeholderDoc: firstPlaceholder ? firstPlaceholder.key : '',
    // 文档缺口只在真的读到（files:list 或 docs:presence 有返回）时才算缺失，读不到不能当缺失。
    missingDocs: docKnown ? readiness.missing : [],
    hasDocs: docKnown,
    docPendingRead: !docKnown || readiness.pendingRead,
    docReadErrors: readiness.readErrors,
    overviewPlaceholder: readiness.overviewPlaceholder,
    boot: {
      known: boot.known,
      error: briefingError ? { code: briefingError.code || 'BRIEFING_FAILED', message: briefingError.message || '' } : null,
      pending: boot.pending,
      expired: boot.expired,
      stale: boot.stale,
      roundMismatch: boot.roundMismatch,
      complete: boot.complete,
      total: boot.total,
      source: boot.source,
      sourceLabel: boot.sourceLabel
    },
    ledger: { known: ledger.known, source: ledger.source, count: ledger.count, inFlight: ledger.inFlightCount },
    truncated: Boolean(legacyUi.truncated),
    commandGaps: command.missing,
    commandUnknowns: command.unknown,
    commandAssumed: Boolean(capability.caps && capability.caps.assumed),
    emptyRoles: boot.total === 0
  };
}

/** 分级后的面板状态（全页唯一判定；所有渲染都从这里取红/橙/灰）。 */
function legacyGateState() {
  return panelGateState(legacyGateInput());
}

function legacyGateResultMarkup() {
  return panelGateMarkup(legacyGateState());
}

/** block 原因串（按钮 title / 提示用）：没有阻塞项时返回可推进说明，不出现 block 级措辞。 */
function panelBlockReasonText(gate) {
  const g = gate && typeof gate === 'object' ? gate : {};
  const blocks = Array.isArray(g.blocks) ? g.blocks : [];
  if (!blocks.length) return '当前没有阻塞项：可推进（真实动作仍以后端返回为准）';
  return `${blocks.map((row) => row.text).join('；')}。先按行内入口处理，界面不绕过、不改 JSON。`;
}

function legacyReadStepsMarkup() {
  const ready = legacyDocumentsReady();
  const readiness = legacyDocReadiness();
  const boot = legacyBootSummary();
  const meta = {
    rules: ready.rules ? `存在 · ${fmtSize(legacySize('项目铁律.md'))}` : '缺失',
    info: ready.info ? `存在 · ${fmtSize(legacySize('项目信息.md'))}` : '缺失',
    card: `${ready.cards}/${ready.total} 张角色卡`,
    others: `文件索引 ${ready.indexes}/${ready.total} · 其他 ${ready.others} 份`
  };
  const cls = {
    rules: ready.rules ? 'ok' : 'missing',
    info: ready.info ? 'ok' : 'missing',
    card: ready.cards === ready.total ? 'ok' : (ready.cards ? 'warn' : 'missing'),
    others: ready.indexes === ready.total && ready.others ? 'ok' : ((ready.indexes || ready.others) ? 'warn' : 'missing')
  };
  return `<div class="legacy-read-steps">${LEGACY_READ_ORDER.map((step) => `<article class="legacy-read-step ${cls[step.key]}" data-no="${step.no}">
    <b>${esc(step.label)}</b>
    <p>${esc(step.note)}</p>
    <span class="legacy-read-state">文件 ${esc(meta[step.key])}</span>
    <span class="legacy-read-state ${boot.known ? (boot.allComplete ? '' : 'warn') : 'warn'}">${boot.known ? (boot.allComplete ? '已读 · 已核验' : '已读 · 有未读全') : '已读 · 待核验'}</span>
  </article>`).join('')}</div>
  <div class="legacy-doc-strip" aria-label="项目文档与索引真实状态">
    ${LEGACY_PROJECT_DOCS.map((doc) => {
      const exists = legacyHas(doc.rel);
      return `<span class="legacy-doc-strip-item ${exists ? 'ok' : 'bad'}" title="${esc(doc.rel)}${exists ? ' · ' + fmtSize(legacySize(doc.rel)) : ' · 缺失'}"><b>${esc(doc.label)}</b><code>${esc(doc.rel)}</code>${exists ? '存在' : '缺失'}</span>`;
    }).join('')}
    <span class="legacy-doc-strip-item ${ready.dirs === ready.total ? 'ok' : 'bad'}"><b>六角色目录</b>${ready.dirs}/${ready.total} 存在</span>
    <span class="legacy-doc-strip-item ${ready.indexes === ready.total ? 'ok' : 'bad'}"><b>角色文件索引</b>${ready.indexes}/${ready.total} 存在</span>
    <span class="legacy-doc-strip-item ${readiness.ok ? 'ok' : (readiness.pendingRead ? 'warn' : 'bad')}"><b>文档</b>${readiness.ok ? '已就绪' : (readiness.pendingRead ? '读取中' : '待补')}</span>
  </div>`;
}

/**
 * B-20261114-003257-0a46（R-d734 F-2/F-3/F-5）：项目信息/项目铁律的真实存在性。
 * 每项带 data-check-path / data-exists / data-source；缺失时把两处路径都列进 #missing-list（AC3 可直接断言）。
 */
function legacyDocPresenceMarkup() {
  const presence = legacyUi.presence;
  if (!presence) {
    if (legacyUi.presenceError) {
      return `<div class="legacy-presence legacy-presence-error" data-presence-state="error"><b>文档存在性未核验</b><span>docs:presence 读取失败：<code>${esc(legacyUi.presenceError.code)}</code> ${esc(legacyUi.presenceError.message)}</span></div>`;
    }
    if (!window.workbench || typeof window.workbench.docsPresence !== 'function') {
      return '<div class="legacy-presence legacy-presence-error" data-presence-state="no-ipc"><b>文档存在性未核验</b><span>当前 preload 没有 <code>docs:presence</code>：只能看 files:list（600 项截断时可能误报缺失）。</span></div>';
    }
    return '<div class="legacy-presence" data-presence-state="loading">文档存在性核验中…</div>';
  }
  const at = presence.at ? fmtTime(presence.at) : '';
  const rows = presence.checks.map((row) => {
    const state = row.state === 'present' ? '存在' : (row.state === 'unreadable' ? '无法读取' : '缺失');
    const cls = row.state === 'present' ? 'ok' : (row.state === 'unreadable' ? 'warn' : 'bad');
    const source = row.state === 'present' ? `存在（来源：${row.sourceLabel || row.source}）` : '来源：—';
    return `<div class="legacy-presence-row ${cls}" data-doc-key="${esc(row.key)}" data-exists="${row.state === 'present' ? '1' : '0'}" data-source="${esc(row.source || '')}" data-check-path="${esc(row.checkPath || '')}" title="${esc(row.checkPath || '')}">
      <b>${esc(row.label)}</b>
      <span class="legacy-presence-state">${esc(state)}</span>
      <span class="legacy-presence-source">${esc(source)}</span>
      <code class="legacy-presence-path">${esc(row.checkPath || '')}</code>
      <span class="legacy-presence-at">${esc(at)}</span>
    </div>`;
  }).join('');
  const bad = presence.checks.filter((row) => row.state !== 'present');
  const missingMarkup = bad.length
    ? `<div class="legacy-missing-list" id="missing-list" data-missing-count="${bad.length}">
      <b>缺失 / 读不到的检查路径（按序查两处：项目目录 → 团队共享）</b>
      ${bad.map((row) => (row.candidates || []).map((cand) => `<div class="legacy-missing-row" data-doc-key="${esc(row.key)}" data-check-path="${esc(cand.path)}" data-exists="${cand.state === 'present' ? '1' : '0'}" data-source="${esc(cand.source)}">
        <code>${esc(cand.path)}</code><span>${cand.state === 'present' ? '存在' : (cand.state === 'unreadable' ? '无法读取' + (cand.error ? `（${esc(cand.error)}）` : '') : '不存在')}</span><span>${esc(cand.sourceLabel || cand.source)}</span><span>${esc(at)}</span>
      </div>`).join('')).join('')}
    </div>`
    : '<div class="legacy-missing-list is-empty" id="missing-list" data-missing-count="0"><b>检查路径</b><span>五项必读文档（铁律/信息/索引/需求总览/协作准则）与六角色目录、角色卡、文件索引都命中，无缺失。</span></div>';
  return `<div class="legacy-presence" data-presence-state="${bad.length ? 'missing' : 'ok'}">
    ${rows}
    ${missingMarkup}
    <p class="legacy-presence-note">判定口径：只查项目目录 <code>${esc(presence.projectPath || '')}</code> 与团队共享；任一处存在即算存在并标来源；读不到（权限/占用）不判缺失。每次打开面板重算。</p>
  </div>`;
}

// 验收列表（#accept-list）由 R-4f99 的 owner-review.js 独占实现（单一容器，顶部【验】打开）；
// 0a46（本条）不在这里再渲染第二份，避免同一 id 出现两个容器 —— 见 0a46 实现说明「跨任务边界」。

function renderLegacyGate(project) {
  const box = $('#legacy-gate');
  if (!box) return;
  if (!project) { box.innerHTML = '<div class="empty-row">先选择工作区。</div>'; return; }
  // F-9fbe-1/F-2：红/橙/灰只由 legacyGateState()（panelSeverity 单源）给，页面各块共用一份结论。
  const gate = legacyGateState();
  const terminated = gate.terminated;
  const open = gate.open;
  const pmReady = legacyRoleReady('pm') && !terminated;
  box.innerHTML = legacyReadStepsMarkup() + legacyGateResultMarkup() + legacyLedgerMarkup() + legacyBootEvidenceMarkup();
  // AC4：红项/警示项可点直达（哈希未命中 → 滚到证据区；已终止 → 滚到终止入口并说明原因）。
  bindLegacyFixLinks(box);
  const badge = $('#legacy-gate-badge');
  if (badge) {
    badge.textContent = gate.label;
    badge.setAttribute('data-panel-level', gate.level);
    badge.className = 'badge ' + (gate.level === 'block' ? 'badge-rejected' : (gate.level === 'warn' ? 'badge-skipped' : (gate.level === 'info' ? 'muted-badge' : 'badge-approved')));
    badge.title = gate.topics.length
      ? gate.topics.map((row) => `${row.level === 'block' ? '阻塞' : (row.level === 'warn' ? '待核验' : '提示')}：${row.text}`).join(' / ')
      : '后端 briefing 与 docs:presence 核验通过：没有待处理项。';
  }
  const advanceBadge = $('#legacy-advance-badge');
  if (advanceBadge) {
    advanceBadge.textContent = gate.label;
    advanceBadge.setAttribute('data-panel-level', gate.level);
    advanceBadge.className = 'badge ' + (gate.level === 'block' ? 'badge-rejected' : (gate.level === 'warn' ? 'badge-skipped' : (gate.level === 'info' ? 'muted-badge' : 'badge-approved')));
  }
  const advance = $('#legacy-advance-box');
  if (advance) {
    const ownerDemandGate = legacyActionCommandGate('owner-demand');
    const terminateGate = legacyActionCommandGate('terminate');
    const ownerCreateReady = !terminated && ownerDemandGate.ok;
    // “向 PM 提交需求（Owner）”只在项目开始 / 评审 / 迭代阶段显示。
    const ownerDemandVisible = ['', 'idle', 'requirement', 'requirement_review', 'owner_review', 'iteration']
      .includes(String(legacyUi.workflow && legacyUi.workflow.phase || ''));
    const terminateReady = !terminated && terminateGate.ok;
    const iterateGuard = legacyIterateGuard();
    const iterateReady = iterateGuard.ok;
    const iterateVisibleWhy = ['open-requirements', 'not-accepted', 'no-requirements', 'placeholder'].includes(iterateGuard.code)
      ? iterateGuard.reason : '';
    const ownerCreateWhy = terminated ? (legacyTerminateReasonText() || '工作流已终止')
      : (!ownerDemandGate.ok ? ownerDemandGate.reason
        : (pmReady ? '向 PM 提交需求（Owner）：owner:demand，描述 / 优先级 / 验收标准（可多条），PM 自动 boot 代办建档'
          : 'PM 未 boot；owner:demand 会由后端自动 boot PM 后代办建档'));
    const terminateWhy = terminated ? (legacyTerminateReasonText() || '工作流已终止')
      : (!terminateGate.ok ? terminateGate.reason : (pmReady ? '终止工作流（PM）' : 'PM 未 boot/未读全；点击执行会先自动 boot，再调用 workflow:terminate'));
    // warn/info 不再是门槛：只有 block 才写拦截词并禁用按钮。
    const advanceWhy = open
      ? (gate.warns.length
        ? `${panelLevelLabel('warn', gate.warns.length)}：${gate.warns.map((row) => row.text).join('；')}。这些都不拦推进，动作执行前界面会先补一次真实 boot。`
        : '当前必读已核验；按需求卡片上的动作推进。动作执行前若所需角色未 boot，界面会先补一次真实 boot。')
      : `阻塞项：${gate.blocks.map((row) => row.text).join('；')}。先在团队工具侧处理，界面不绕过、不改 JSON。`;
    advance.innerHTML = `
      <div class="legacy-advance-row">
        <div><b>推进当前</b><p>${advanceWhy}</p></div>
        <button class="primary small" type="button" id="legacy-advance" ${open ? '' : 'disabled'} data-legacy-go="flow" data-panel-level="${gate.level}" title="${open ? '打开旧流程与需求队列' : panelBlockReasonText(gate)}">${open ? '查看当前动作' : PANEL_BLOCK_LABEL}</button>
      </div>
      <div class="legacy-advance-row">
        <div><b>向 PM 提交需求（Owner）</b><p>调用 <code>owner:demand</code>：只提需求描述、优先级、验收标准（每条一行，可多条）；PM 会自动 boot 代办建档，项目开始 / 评审 / 迭代时提交。</p></div>
        <button class="ghost small" type="button" id="legacy-owner-new" ${ownerDemandVisible ? '' : 'hidden'} ${ownerCreateReady ? '' : 'disabled'} data-legacy-req-action="owner-demand" title="${esc(ownerCreateWhy)}">向 PM 提交需求（Owner）</button>
      </div>
      <div class="legacy-advance-row">
        <div><b>迭代 / 终止</b><p>迭代在全部需求验收后可用；当前需求被投票驳回、已无在办需求时也允许收口（否则驳回一次就会锁死当前）。有在办需求时禁用，执行会让当前 boot 全部作废。PM 未 boot 时执行前会自动补 boot。</p></div>
        <span class="legacy-advance-buttons">
          <button class="ghost small" type="button" id="legacy-iterate" ${iterateReady ? '' : 'disabled'} data-legacy-req-action="iterate" title="${esc(iterateGuard.reason || '启动下一次（PM）；执行前会自动补 boot')}">迭代（下一次）</button>
          <button class="ghost small danger" type="button" id="legacy-terminate" ${terminateReady ? '' : 'disabled'} data-legacy-req-action="terminate" title="${esc(terminateWhy)}">终止</button>
        </span>
      </div>
      ${iterateVisibleWhy ? `<p class="legacy-iterate-why">迭代不可用：${esc(iterateVisibleWhy)}</p>` : ''}
      <div class="legacy-missing-list">
        <b>动作来源与边界</b>
        <span><code>workflow:briefing</code>：必读分层与 boot 的真实状态（宪法每轮、铁律按需）；过期、缺文件或文档变更会标出。</span>
        <span><code>workflow:boot</code>：角色 boot；由界面发起时，后端记录 role/session，但“角色本人执行”仍以旧账证据为准，不冒充。</span>
        <span><code>workflow:*</code> 动作：产品评审 / Owner 决定 / 派单 / 开发互审 / 测试 / Owner 验收；旧命令明确缺失才写“缺”，矩阵没返回只写“未核验”，两种情况都禁用按钮并说明，界面不回退本机假成功。</span>
      </div>`;
  }
  // B-20261114-003257-0a46：文档真实存在性（#missing-list 锚点在 legacyDocPresenceMarkup 里）。
  const presenceBox = $('#doc-presence');
  if (presenceBox) presenceBox.innerHTML = legacyDocPresenceMarkup();
}

function legacyRoleTableMarkup(project) {
  const roles = teamRoles(project);
  const sessions = (project && project.sessions) || {};
  return `<table class="legacy-table">
    <thead><tr><th>角色</th><th>目录</th><th>角色卡</th><th>文件索引</th><th>其他文档</th><th>会话</th><th>当前 boot / 必读</th><th>已读证据来源</th><th>打开</th></tr></thead>
    <tbody>${roles.map((role) => {
      const dir = legacyHas(legacyRoleDirName(role));
      const card = legacyHas(legacyRoleCardRel(role));
      const cardState = legacyRoleCardState(role);
      const index = legacyHas(legacyRoleIndexRel(role));
      const others = legacyRoleOtherDocCount(role);
      const session = sessions[role.id];
      const boot = legacyBootFor(role.id);
      const bootDisplay = legacyBootDisplay(role.id);
      const ev = legacyBootEvidence(role.id);
      const evidenceRecord = ev.memRead || ev.bootRecord;
      const evidence = evidenceRecord
        ? `${ev.memRead ? '本次 boot' : '工作流.json boots'}：${evidenceRecord.complete ? '必读齐全' : '有缺失'} · 令牌 ${evidenceRecord.tokenHash || '未记录'}`
        : (ev.row ? `工作流.json：${ev.briefingHash ? '简报 ' + legacyHashShort(ev.briefingHash) : '有记录无简报哈希'}` : '未记录');
      return `<tr>
        <td><span class="legacy-role-id" style="--role-color:${esc(role.color)}">${esc(String(role.name || '?').slice(0, 1))}</span><b>${esc(role.name)}</b><br><code>${esc(role.id)}</code></td>
        <td><code>${esc(legacyRoleDirName(role))}/</code><br><span class="${dir ? 'legacy-cell-ok' : 'legacy-cell-bad'}">目录${dir ? '存在' : '缺失'}</span></td>
        <td class="${cardState.key === 'ok' ? 'legacy-cell-ok' : (cardState.key === 'unmapped' ? 'legacy-cell-warn' : 'legacy-cell-bad')}" title="${esc(cardState.title)}">${esc(cardState.label)}</td>
        <td class="${index ? 'legacy-cell-ok' : 'legacy-cell-bad'}">${index ? '存在' : '缺失'}</td>
        <td class="legacy-cell-dim">${others} 份</td>
        <td>${session ? '<span class="legacy-cell-ok">已映射</span><br><code>' + esc(sessionShort(session)) + '</code>' : '<span class="legacy-cell-warn">未建</span>'}</td>
        <td><span class="${boot.ready ? 'legacy-cell-ok' : 'legacy-cell-warn'}" title="${esc(bootDisplay.title)}">${esc(bootDisplay.label)}</span><br><span class="legacy-cell-dim">${esc(boot.at ? '工作台 ' + fmtTime(boot.at) : '工作台未记录')}</span></td>
        <td class="legacy-cell-dim">${esc(evidence)}</td>
        <td><div class="legacy-table-actions">
          <button type="button" data-legacy-role-card="${esc(role.id)}" title="只读查看 ${esc(legacyRoleCardRel(role))}">角色卡</button>
          <button type="button" data-legacy-role-index="${esc(role.id)}" title="只读查看 ${esc(legacyRoleIndexRel(role))}">索引</button>
          ${legacyBootButtonMarkup(role)}
        </div></td>
      </tr>`;
    }).join('')}</tbody>
  </table>`;
}

function renderLegacyRoleTable(project) {
  const roles = state?.roles || [];
  const ready = legacyDocumentsReady();
  const markup = legacyRoleTableMarkup(project);
  const overview = $('#legacy-role-table');
  const docs = $('#legacy-role-index');
  if (overview) overview.innerHTML = markup;
  if (docs) docs.innerHTML = markup;
  const badge = $('#legacy-role-badge');
  if (badge) {
    const boot = legacyBootSummary();
    // F-9fbe-6：数字只留在顶部真源条；这里只报目录/角色卡/索引（presence 同源）与 boot 状态。
    badge.textContent = `目录 ${ready.dirs}/${ready.total} · 角色卡 ${ready.cards}/${ready.total} · 索引 ${ready.indexes}/${ready.total} · ${bootStatusText(boot)}`;
    badge.className = 'badge ' + (ready.dirs === ready.total && ready.cards === ready.total && ready.indexes === ready.total && boot.allComplete
      ? 'badge-approved'
      : (boot.known ? (boot.allComplete ? 'badge-approved' : 'badge-skipped') : 'muted-badge'));
  }
  const indexBadge = $('#legacy-role-index-badge');
  if (indexBadge) {
    const boot = legacyBootSummary();
    indexBadge.textContent = `${bootStatusText(boot)} · 文件索引 ${ready.indexes}/${ready.total} · 项目索引 ${ready.index ? '存在' : '缺失'}`;
    indexBadge.className = 'badge ' + (boot.allComplete && ready.indexes === ready.total ? 'badge-approved' : 'badge-skipped');
  }
  const summary = $('#legacy-docs-summary');
  if (summary) {
    const boot = legacyBootSummary();
    summary.textContent = `目录 ${ready.dirs}/${ready.total} · 角色卡 ${ready.cards}/${ready.total} · 文件索引 ${ready.indexes}/${ready.total} · 其他文档 ${ready.others} 份 · 项目索引 ${ready.index ? '存在' : '缺失'} · ${bootStatusText(boot)} · ${legacyUi.loading ? '读取中…' : '只读'}`;
  }
}

function legacyDocCardsMarkup() {
  return LEGACY_PROJECT_DOCS.map((doc) => {
    const exists = legacyHas(doc.rel);
    const entry = legacyDocRecord(doc.rel);
    const raw = entry && entry.ok ? String(entry.text || '') : '';
    const excerpt = raw.replace(/^#{1,6}\s*/gm, '').replace(/[>*`_]/g, '').replace(/\s+/g, ' ').trim().slice(0, 180);
    const placeholder = /（待[^）]*）|待填写|待补/.test(raw);
    return `<div class="legacy-doc-card ${exists ? '' : 'is-missing'}">
      <span class="legacy-doc-mark" aria-hidden="true">${esc(doc.mark)}</span>
      <div class="legacy-doc-main">
        <b>${esc(doc.label)}</b>
        <small>${esc(doc.rel)} · ${exists ? '存在 · ' + fmtSize(legacySize(doc.rel)) : '缺失'} · ${esc(doc.note)}</small>
        ${excerpt ? `<p class="legacy-doc-excerpt" title="${esc(raw.slice(0, 400))}">${esc(excerpt)}${raw.length > 180 ? '…' : ''}</p>` : ''}
        ${placeholder ? '<span class="legacy-doc-placeholder" title="文档仍是模板占位；boot 与推进会返回 PLACEHOLDER_DOC，先把正文写清">模板占位</span>' : ''}
      </div>
      <button type="button" data-legacy-doc="${esc(doc.key)}" title="在「必读与目录」中只读打开 ${esc(doc.rel)}">查看</button>
    </div>`;
  }).join('');
}

function renderLegacyDocCards() {
  const box = $('#legacy-doc-cards');
  if (!box) return;
  box.innerHTML = legacyDocCardsMarkup();
}

function renderOverview() {
  const p = activeProject();
  if (!p) return;
  const round = $('#legacy-round');
  if (!round) return;
  const wf = legacyWorkflow() || {};
  const reqs = Array.isArray(wf.requirements) ? wf.requirements : [];
  const tasks = Array.isArray(wf.tasks) ? wf.tasks : (Array.isArray(p.tasks) ? p.tasks : []);
  const done = tasks.filter((task) => task.status === 'done').length;
  const evidence = legacyFlowEvidence(p);
  const os = ownerState({ ...p, ownerReview: wf.ownerReview || p.ownerReview });
  const phaseText = wf.phase ? String(wf.phase) : (legacyUi.workflowError ? '读取失败' : '未读取');
  const pending = evidence.pending;
  const roundKey = wf.roundKey || '—';
  round.innerHTML = `
    <div class="legacy-round-top">
      <h3>${esc(p.name)} · 当前需求</h3>
      <span class="badge ${os.pending ? 'badge-pending' : 'badge-' + os.key}">${esc(phaseText)}</span>
    </div>
    <div class="legacy-round-grid">
      <div class="legacy-fact"><span>工作流阶段</span><b class="gold">${esc(phaseText)}</b><small>workflow:state · roundKey ${esc(String(roundKey).slice(-28))}</small></div>
      <div class="legacy-fact"><span>需求</span><b>${reqs.length}</b><small>已验收 ${esc(String(evidence.accepted))} · 队列见「旧流程」</small></div>
      <div class="legacy-fact"><span>旧任务</span><b>${tasks.length}</b><small>完成 ${done} / ${tasks.length}</small></div>
      <div class="legacy-fact"><span>待回执</span><b class="${pending ? 'warn' : ''}">${pending ? esc(roleById(pending.to).name) : '无'}</b><small>${pending ? 'PM 派单锁 · ' + esc(pending.subject || '未写主题') : '没有 PM 派单锁'}</small></div>
    </div>`;
  renderLegacyGate(p);
  renderLegacyRoleTable(p);
  renderLegacyDocCards();

  const badge = $('#owner-badge');
  if (badge) {
    badge.textContent = '项目级 · ' + os.label;
    badge.className = 'badge ' + (os.key === 'optional' ? 'muted-badge' : 'badge-' + os.key);
    badge.title = `旧版项目级 ownerReview：${os.label}${os.opinion ? ' · ' + os.opinion : ''}；不参与需求派单`;
  }
  const headline = legacyOwnerHeadline(p);
  const req = legacyActiveRequirement();
  const reqOwner = legacyReqOwnerView(req);
  const ownerOpen = $('#legacy-owner-open-removed');
  if (ownerOpen) {
    const ownerGate = legacyActionCommandGate('owner-review');
    ownerOpen.disabled = !ownerGate.ok;
    ownerOpen.textContent = headline.pending ? '继续需求 Owner 决定' : '打开需求 Owner 决定';
    ownerOpen.title = !ownerGate.ok ? ownerGate.reason
      : (req
        ? `需求级 Owner：${req.id} · ${legacyReqStatus(req)} · ${reqOwner.label}；项目级旧闸门不参与派单`
        : '还没有需求；Owner 的参与/跳过发生在产品评审通过后');
  }
  const ownerSummary = $('#owner-summary');
  if (ownerSummary) {
    ownerSummary.textContent = req
      ? `需求级 Owner：${req.id} · ${legacyReqStatus(req)} · ${reqOwner.label}${reqOwner.owner && reqOwner.owner.opinion ? ' · ' + reqOwner.owner.opinion : ''}。项目级旧 Owner（${os.label}）只做历史展示，不参与需求派单。`
      : (legacyRequirements().length
        ? `当前无在办需求（已有 ${legacyRequirements().length} 条需求均已收口）。项目级旧 Owner：${os.label}${os.opinion ? ' · ' + os.opinion : ''}；不参与需求派单。`
        : `还没有需求级 Owner 闸门。项目级旧 Owner：${os.label}${os.opinion ? ' · ' + os.opinion : ''}；不参与需求派单。`);
    ownerSummary.title = ownerSummary.textContent;
  }
  renderOwnerResult(p);
}


function legacyCurrentDoc() {
  const key = String(legacyUi.docTab || 'rules');
  if (key.startsWith('role:') || key.startsWith('index:')) {
    const roleId = key.slice(key.indexOf(':') + 1);
    const role = (state?.roles || []).find((item) => item.id === roleId) || null;
    if (!role) return null;
    const isIndex = key.startsWith('index:');
    return {
      key,
      label: role.name + (isIndex ? ' · 文件索引' : ' · 角色卡'),
      rel: isIndex ? legacyRoleIndexRel(role) : legacyRoleCardRel(role),
      role
    };
  }
  const doc = LEGACY_PROJECT_DOCS.find((item) => item.key === key) || LEGACY_PROJECT_DOCS[0];
  return { key: doc.key, label: doc.label, rel: doc.rel, doc };
}

async function legacyOpenDoc(key) {
  const p = activeProject();
  if (!p || !key) return;
  legacyUi.docTab = key;
  if (key.startsWith('role:') || key.startsWith('index:')) legacyUi.roleId = key.slice(key.indexOf(':') + 1);
  showTab('docs');
  const selection = legacyCurrentDoc();
  if (selection && selection.rel && legacyHas(selection.rel)) await legacyReadDoc(selection.rel);
  renderLegacyDocs();
}

function legacyRoleDirsMarkup(project) {
  const sessions = (project && project.sessions) || {};
  return teamRoles(project).map((role) => {
    const cardRel = legacyRoleCardRel(role);
    const indexRel = legacyRoleIndexRel(role);
    const dir = legacyHas(legacyRoleDirName(role));
    const card = legacyHas(cardRel);
    const cardState = legacyRoleCardState(role);
    const index = legacyHas(indexRel);
    const others = legacyRoleOtherDocCount(role);
    const any = card || index || others > 0 || dir;
    const session = sessions[role.id];
    const boot = legacyBootFor(role.id);
    const bootCtl = legacyBootControl(role.id);
    const ev = legacyBootEvidence(role.id);
    const evidenceRecord = ev.memRead || ev.bootRecord;
    const evidence = evidenceRecord
      ? `${ev.memRead ? '本次 boot' : '工作流.json boots'} ${evidenceRecord.complete ? '必读齐全' : '有缺失'}${evidenceRecord.tokenHash ? ' · 令牌 ' + evidenceRecord.tokenHash : ''}`
      : (ev.row ? `工作流.json ${ev.briefingHash ? '简报 ' + legacyHashShort(ev.briefingHash) : '有 boot 记录'}` : '没有 boot 证据');
    return `<article class="legacy-role-dir ${any ? '' : 'missing'}" style="--role-color:${esc(role.color)}">
      <div class="legacy-role-dir-head">
        <div class="role-chip" style="background:${esc(role.color)}">${esc(String(role.name || '?').slice(0, 1))}</div>
        <b>${esc(role.name)}</b>
        <small>${esc(role.id)}</small>
      </div>
      <div class="legacy-role-dir-path" title="${esc(role.scope || role.dir)}">${esc(legacyRoleDirName(role))}/ <span class="${dir ? 'ok' : 'bad'}">${dir ? '目录存在' : '目录缺失'}</span></div>
      <div class="legacy-role-dir-files">
        <span class="${cardState.key === 'ok' ? 'ok' : (cardState.key === 'unmapped' ? 'warn' : 'bad')}" title="${esc(cardState.title)}">角色卡 ${esc(cardState.label)}</span>
        <span class="${index ? 'ok' : 'bad'}">文件索引 ${index ? '有' : '缺'}</span>
        <span>其他文档 ${others}</span>
        <span class="${boot.ready ? 'ok' : 'warn'}" title="${esc(boot.missing.join('、') || boot.at || '')}">${esc(boot.label)}</span>
      </div>
      <div class="legacy-role-dir-evidence" title="${esc(ev.source)}">${esc(evidence)}</div>
      <div class="legacy-role-dir-foot">
        <span>${session ? '会话 ' + esc(sessionShort(session)) : '无 DSH 会话'}</span>
        <span class="legacy-role-dir-actions">
          <button type="button" data-legacy-boot="${esc(role.id)}" ${bootCtl.disabled ? 'disabled' : ''} title="${esc(bootCtl.title)}">${esc(bootCtl.text)}</button>
          <button type="button" data-legacy-role-card="${esc(role.id)}" title="只读查看 ${esc(cardRel)}">看角色卡</button>
          <button type="button" data-legacy-role-index="${esc(role.id)}" title="只读查看 ${esc(indexRel)}">看文件索引</button>
        </span>
      </div>
    </article>`;
  }).join('');
}

function legacyDocTabsMarkup() {
  const tabs = LEGACY_PROJECT_DOCS.map((doc) => ({
    key: doc.key, label: doc.label, exists: legacyHas(doc.rel), role: false
  }));
  for (const role of teamRoles(activeProject())) {
    tabs.push({ key: 'role:' + role.id, label: role.name, exists: legacyHas(legacyRoleCardRel(role)), role: true, kind: '角色卡' });
  }
  for (const role of teamRoles(activeProject())) {
    tabs.push({ key: 'index:' + role.id, label: role.name, exists: legacyHas(legacyRoleIndexRel(role)), role: true, kind: '文件索引' });
  }
  return tabs.map((tab) => {
    const role = tab.role ? roleById(String(tab.key).slice(String(tab.key).indexOf(':') + 1)) : null;
    const rel = tab.role ? (String(tab.key).startsWith('index:') ? legacyRoleIndexRel(role || {}) : legacyRoleCardRel(role || {})) : '';
    return `<button type="button" role="tab" class="legacy-doc-tab ${legacyUi.docTab === tab.key ? 'active' : ''} ${tab.exists ? '' : 'missing'}" data-legacy-doc-tab="${esc(tab.key)}" aria-selected="${legacyUi.docTab === tab.key ? 'true' : 'false'}" title="${tab.role ? esc(tab.kind) + '：' + esc(rel) : '项目文档'}">${esc(tab.role ? tab.kind + ' · ' + tab.label : tab.label)}</button>`;
  }).join('');
}

/* ── 文档显示层：索引去记录、需求状态记录去重 ─────────────
 * 只改“界面看到的内容”，不回写文件：
 *   ① 项目索引.md 的需求表只保留真实需求行，评审/验收记录不参与需求数；
 *   ② 需求正文出现多个“## 状态记录”时合并成一份，重复记录只显示一次。
 */
function legacyIndexRowInfo(line) {
  const trimmed = String(line || '').trim();
  if (!trimmed.startsWith('|')) return null;
  const cells = trimmed.split('|').map((cell) => cell.trim());
  if (cells.length < 3) return null;
  const id = cells[1].replace(/`/g, '').trim();
  if (!/^R-[0-9A-Za-z_-]+$/i.test(id)) return null;
  // 4 位/6 位同号按同一需求分组：R-YYYYMMDD-0001 与 R-YYYYMMDD-000001 不能各算一条。
  const idMatch = id.match(/^R-(\d{8})-(\d{4,8})(?:-|$)/i);
  const idKey = idMatch ? `R-${idMatch[1]}-${Number(idMatch[2])}` : id.toUpperCase();
  const link = trimmed.match(/\]\(([^)]+)\)/);
  const target = link ? link[1].replace(/\\/g, '/') : '';
  const record = /^需求\/(评审|验收)\//i.test(target);
  return { id: idKey, target, record };
}

function legacyFilterIndexMarkdown(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const groups = new Map();
  const rows = [];
  const drop = new Set();
  let recordRows = 0;
  lines.forEach((line, index) => {
    const info = legacyIndexRowInfo(line);
    if (!info) return;
    // 评审/验收记录按目标路径直接排除（旧索引里它们的首列 id 可能带 -owner-/accept- 后缀）。
    if (info.record) { drop.add(index); recordRows += 1; return; }
    rows.push({ index, id: info.id });
    const group = groups.get(info.id) || { keep: index, rank: 99 };
    // 0 = 真实需求正文（需求/R-*.md）；1 = 其他非记录目标
    const rank = /^需求\/R-[^/]+\.md$/i.test(info.target) ? 0 : 1;
    if (rank < group.rank) {
      group.keep = index;
      group.rank = rank;
    }
    groups.set(info.id, group);
  });
  if (!groups.size) return { text: lines.join('\n'), removed: recordRows, count: 0 };
  // 同一需求只保留一行，优先保留指向真实正文的那一行。
  for (const [id, group] of groups) {
    for (const row of rows) {
      if (row.id === id && row.index !== group.keep) drop.add(row.index);
    }
  }
  let count = 0;
  for (const group of groups.values()) if (group.rank === 0) count += 1;
  return {
    text: lines.filter((_, index) => !drop.has(index)).join('\n').replace(/\n{3,}/g, '\n\n'),
    removed: drop.size,
    count
  };
}

function legacyStatusLineSignature(line) {
  const raw = String(line || '').replace(/^\s*[-*]\s+/, '');
  const statusMatch = raw.match(/\b(approved|accepted|ready|review|rejected|skipped|terminated|iteration)\b/i);
  const status = statusMatch ? statusMatch[1].toLowerCase() : '';
  const core = raw
    .replace(/^\d{4}-\d{2}-\d{2}T[0-9:.+\-Z]+\s*/, '')
    // 去掉“状态：”“Owner accepted：”这类前缀，最多三层；正文里的冒号不动。
    .replace(/^(?:[^：:\n]{1,24}[：:]\s*){1,3}/, '')
    .replace(/[\s"'“”‘’`·，。；、,.;:：!！?？()（）\[\]【】<>《》]/g, '')
    .toLowerCase();
  return { status, core };
}

function legacyDedupeStatusRecords(text) {
  const lines = String(text || '').replace(/\r\n?/g, '\n').split('\n');
  const isStatusHeading = (line) => /^#{2,4}\s*状态记录\s*$/.test(String(line || '').trim());
  const isHeading = (line) => /^#{1,6}\s+\S/.test(String(line || '').trim());
  const isBullet = (line) => /^\s*[-*]\s+/.test(line);
  const starts = [];
  lines.forEach((line, index) => { if (isStatusHeading(line)) starts.push(index); });
  if (!starts.length) return { text: lines.join('\n'), removed: 0 };
  const drop = new Set();
  const merged = [];
  const seen = [];
  let bulletCount = 0;
  for (const start of starts) {
    drop.add(start);
    let end = lines.length;
    for (let i = start + 1; i < lines.length; i += 1) {
      if (isHeading(lines[i])) { end = i; break; }
    }
    for (let i = start + 1; i < end; i += 1) {
      if (!isBullet(lines[i])) continue;
      drop.add(i);
      bulletCount += 1;
      const sig = legacyStatusLineSignature(lines[i]);
      const duplicate = seen.some((row) => row.status === sig.status
        && (row.core === sig.core
          || (row.core.length >= 24 && sig.core.length >= 24
            && (row.core.includes(sig.core) || sig.core.includes(row.core)))));
      if (duplicate) continue;
      seen.push(sig);
      merged.push(lines[i]);
    }
  }
  const first = starts[0];
  lines[first] = [lines[first], ...merged].join('\n');
  return {
    text: lines.filter((_, index) => !drop.has(index) || index === first).join('\n').replace(/\n{3,}/g, '\n\n'),
    removed: Math.max(0, bulletCount - merged.length)
  };
}

/* ── R-f9b1：项目面板「增补卷」区块 + 主正文头部卷清单 ─────────────────────
 * 池详情由 pool-core 渲染；这里补"项目面板能看到/能点开"与"主正文头部清单能正常显示"。
 * 卷字段唯一来自 POOL_CORE.supplementsOf / supplementHeaderMarkup（不在别处再解析）。
 */
function legacySupplementRows() {
  if (!POOL_CORE || typeof POOL_CORE.supplementsOf !== 'function') return [];
  const rows = [];
  for (const req of legacyRequirements()) {
    for (const item of POOL_CORE.supplementsOf(req)) {
      rows.push({ ...item, requirementId: item.requirementId || String(req.id || '') });
    }
  }
  return rows;
}

function legacySupplementPanelMarkup() {
  const rows = legacySupplementRows();
  if (!rows.length) {
    return '<div class="panel-head"><h3>增补卷</h3><span class="badge muted-badge">0 份</span></div>'
      + '<p class="legacy-supplement-empty">本项目当前没有增补卷（需求正文贴线拆分后才会有）。卷不纳入必读清单。</p>';
  }
  const chips = rows.map((row) => '<li>'
    + `<button type="button" class="legacy-supplement-chip"${POOL_CORE.supplementOpenAttrs(row)} title="${esc(row.rel)}">`
    + `${esc(row.name)}<span>${esc(POOL_CORE.supplementMetaLabel(row))}</span></button>`
    + `<span class="legacy-supplement-req mono">${esc(row.requirementId || '—')}</span>`
    + (row.missing ? '<span class="legacy-supplement-warn">缺失</span>' : '')
    + '</li>').join('');
  return `<div class="panel-head"><h3>增补卷（${rows.length}）</h3><span class="badge muted-badge">只读 · 不纳入必读</span></div>`
    + `<ul class="legacy-supplement-list" data-supplement="1" data-supplement-source="panel" data-supplement-count="${rows.length}">${chips}</ul>`
    + '<p class="legacy-supplement-hint">卷是需求正文 16KB 上限的拆分产物：点卷名在界面内只读查看（不改正文），内容以文件为准。</p>';
}

/** 面板里的卷区块挂在「项目必读文档」卡上方（DOM 由 JS 建，不动 index.html 结构）。 */
function legacySupplementHostEnsure() {
  const view = $('#view-docs');
  if (!view) return null;
  let host = $('#legacy-supplements');
  if (host && view.contains(host)) return host;
  host = document.createElement('section');
  host.id = 'legacy-supplements';
  host.className = 'panel legacy-supplement-panel';
  const anchor = view.querySelector('.legacy-doc-panel');
  if (anchor && anchor.parentNode) anchor.parentNode.insertBefore(host, anchor);
  else view.appendChild(host);
  return host;
}

/** 主正文头部卷清单（工具侧拆分时写在标题下方）；没有清单返回 ''（安全降级）。 */
function legacySupplementHeaderMarkup(text) {
  if (!POOL_CORE || typeof POOL_CORE.supplementHeaderMarkup !== 'function') return '';
  return POOL_CORE.supplementHeaderMarkup(text);
}

// 面板卷按钮 / 主正文头部卷按钮：统一在界面内只读查看。
// 池详情与评审材料各自有自己的点击处理（它们 stopPropagation），这里跳过避免重复弹层。
document.addEventListener('click', (event) => {
  const node = event.target instanceof Element ? event.target.closest('[data-supplement-open]') : null;
  if (!node || node.closest('#pool-mask') || node.closest('[data-owner-review-dialog]')) return;
  event.preventDefault();
  void openSupplementViewer(node.dataset.supplementOpen, {
    name: node.dataset.supplementName,
    bytes: node.dataset.supplementBytes,
    sha256: node.dataset.supplementSha,
    requirementId: node.dataset.supplementReq
  });
});

function legacyDocPreviewMarkup(selection, project) {
  if (!selection) return '<div class="legacy-doc-empty">没有可显示的文档。</div>';
  if (!selection.rel) return '<div class="legacy-doc-empty">这个角色没有可读的角色卡路径。</div>';
  if (!legacyHas(selection.rel)) {
    return `<div class="legacy-doc-empty"><b>缺失：${esc(selection.rel)}</b><br>项目目录里没有这个文件。界面不会生成模板或补造内容；旧工具可能回退团队根同名文件，但当前只读接口限定项目目录，不越界读取。</div>`;
  }
  const entry = legacyDocRecord(selection.rel);
  if (!entry) {
    if (!legacyUi.reading || !legacyUi.reading[selection.rel]) {
      legacyReadDoc(selection.rel).then(() => {
        if (activeProject() && activeProject().id === project.id) renderLegacyDocs();
      });
    }
    return '<div class="legacy-doc-empty">读取中…</div>';
  }
  if (!entry.ok) {
    return `<div class="legacy-doc-error">读取失败：${esc(entry.error || '未知错误')}<br>文件：${esc(selection.rel)}</div>`;
  }
  const full = String(entry.text || '');
  const clipped = full.length > 160000;
  let display = clipped ? full.slice(0, 160000) : full;
  let filterNote = '';
  if (selection.rel === '项目索引.md') {
    const filtered = legacyFilterIndexMarkdown(display);
    display = filtered.text;
    filterNote = `<div class="legacy-doc-filter-note">项目索引只显示真实需求 <b>${filtered.count}</b> 条；评审/验收记录不参与需求数${filtered.removed ? `（界面已隐藏 ${filtered.removed} 条记录行）` : ''}。</div>`;
  } else if (/^需求\/R-[^/]+\.md$/i.test(selection.rel)) {
    const deduped = legacyDedupeStatusRecords(display);
    display = deduped.text;
    if (deduped.removed) {
      filterNote = `<div class="legacy-doc-filter-note">需求正文的「状态记录」有 ${deduped.removed} 条重复；界面只显示一次，不改文件。</div>`;
    }
  }
  const body = markdownToHtml(display);
  const supplementHead = legacySupplementHeaderMarkup(display);
  const meta = `${selection.rel} · ${fmtSize(entry.size)} · ${entry.kind === 'markdown' ? 'Markdown' : '文本'}${clipped ? ' · 已截断显示' : ''}`;
  return `<div class="legacy-doc-meta">${esc(meta)}</div>${supplementHead}${filterNote}${body || '<div class="legacy-doc-empty">（空文件）</div>'}`;
}

function renderLegacyDocs() {
  const p = activeProject();
  const dirs = $('#legacy-roles-dirs');
  if (!p) {
    if (dirs) dirs.innerHTML = '<div class="empty-row">先选择工作区。</div>';
    return;
  }
  if (dirs) dirs.innerHTML = legacyRoleDirsMarkup(p);
  renderLegacyRoleTable(p);
  const tabs = $('#legacy-doc-tabs');
  if (tabs) tabs.innerHTML = legacyDocTabsMarkup();
  // R-f9b1：项目面板的「增补卷」区块（项目内所有需求的卷，只读可点开）。
  const supplementHost = legacySupplementHostEnsure();
  if (supplementHost) supplementHost.innerHTML = legacySupplementPanelMarkup();
  const preview = $('#legacy-doc-preview');
  if (preview) preview.innerHTML = legacyDocPreviewMarkup(legacyCurrentDoc(), p);
}

function legacyReqSelect(id, statuses, selectedId) {
  const rows = legacyRequirements().filter((req) => statuses.includes(String(req.status || '')));
  const options = rows.map((req) => `<option value="${esc(req.id)}" ${req.id === selectedId ? 'selected' : ''}>${esc(req.id)} · ${esc(req.title || '')}（${esc(legacyReqStatus(req))}）</option>`).join('');
  return `<select id="${esc(id)}" class="select">${options || '<option value="">没有符合状态的需求</option>'}</select>`;
}

function legacyField(label, control, hint = '') {
  return `<label class="field"><span><b>${esc(label)}</b>${hint ? `<span class="field-note">${esc(hint)}</span>` : ''}</span>${control}</label>`;
}

// 顶栏版本口径（Owner 2026-11-14 定）：只显示主.次 = v1.0；取不到两段就原样返回，保证不显示空。
function shortAppVersion(version) {
  const m = String(version || '').match(/^(\d+)\.(\d+)/);
  return m ? `${m[1]}.${m[2]}` : String(version || '').trim();
}

function legacyRoleOptions(ids, selected) {
  return ids.map((id) => {
    const boot = legacyBootFor(id);
    return `<option value="${esc(id)}" ${id === selected ? 'selected' : ''}>${esc(roleById(id).name)}（${esc(boot.label)}）</option>`;
  }).join('');
}

// ==========================================================================
// T-20261114-093822-c72e：Owner 向 PM 提交需求前的三轮「拷问」（Owner 2026-11-14 09:38、13:1x 校正）。
// 适用范围只到「Owner 给 PM 确认需求」这一步（owner:demand / requirement:owner-create）；
// 后续仍以需求正文 + 产品评审为主，产品/分析师自己建需求（requirement-create）不走拷问。
// 文案与选项全部集中在 NEW_REQ_GRILL 这一个常量里（i18n 口径）：改字只改这里。
// 规则：三轮可在弹窗内分步完成；每轮可选项 / 自填 / 跳过；跳过一律按推荐并在正文标注
// 「按推荐默认」；三轮后生成不超过 15 行的摘要让用户确认；确认后才解锁建单字段并允许提交。
// ==========================================================================
const NEW_REQ_GRILL = {
  title: '先问三步，再交给 PM',
  intro: '答完三步会生成一份摘要，你确认后才真正提交；中途跳过的一律按推荐项写进正文，并标注「按推荐默认」。后续仍按需求正文 + 产品评审推进。',
  stepTemplate: '第 {n} 步 / 共 {total} 步',
  // 作用范围：只有 Owner → PM 提需求的两条入口；产品/分析师建需求不经过这里。
  actions: ['owner-demand', 'owner-create'],
  fieldId: 'legacy-a-grill',
  fieldsWrapId: 'legacy-owner-fields',
  bodyFieldId: 'legacy-a-description',
  rounds: [
    {
      id: 'scope',
      short: '范围',
      title: '当前 · 范围',
      hint: '这次到底做多大？',
      options: [
        { value: 'min', label: '只做这一件事（最小范围）', recommended: true },
        { value: 'plus', label: '顺带把相关的小改动一起做' },
        { value: 'preview', label: '先出一版能看的，细节后面迭代' },
        { value: 'research', label: '先补调研/方案对比，再决定做不做' },
        { value: 'reuse', label: '能复用现成的就不重写' },
      ],
    },
    {
      id: 'accept',
      short: '验收',
      title: '当前 · 验收（谁验 / 算过 / 要什么证据）',
      hint: '谁点头才算过？要留什么证据？',
      options: [
        { value: 'tester', label: '测试人员独立验 + 测试报告与截图', recommended: true },
        { value: 'owner', label: '我自己看一遍就算过（人工验收）' },
        { value: 'product', label: '产品 / 分析师按验收标准抽查' },
        { value: 'auto', label: '自动化断言（脚本自检）通过才算' },
        { value: 'later', label: '先跑通就行，证据后面补' },
      ],
    },
    {
      id: 'boundary',
      short: '边界',
      title: '当前 · 边界（空值 / 并发 / 权限 / 失败降级）',
      hint: '哪些坑必须先写清，不写就不准开工？',
      options: [
        { value: 'all', label: '空值、并发、权限、失败降级都要有结论', recommended: true },
        { value: 'basic', label: '只保空值和失败提示' },
        { value: 'perm', label: '只保权限：不该看的看不到、不该点的点不动' },
        { value: 'race', label: '只保并发：两个人同时点不互相踩' },
        { value: 'none', label: '先不写边界，边做边定' },
      ],
    },
  ],
  buttons: {
    next: '下一次',
    toSummary: '看摘要',
    prev: '上一次',
    skipRound: '这次跳过（按推荐）',
    skipAll: '跳过拷问直接建',
    confirm: '确认摘要',
    edit: '返回修改',
  },
  labels: {
    customLabel: '自填',
    customPlaceholder: '也可以自己写一句（留空就用上面的选项）',
    recommended: '推荐',
    chosen: '你选的',
    defaulted: '按推荐默认（跳过）',
    summaryTitle: 'Owner 需求拷问摘要',
    summaryStep: '三步已答完 · 摘要确认',
    summaryHint: '这段话会写进需求正文；确认后才真正提交给 PM。',
    lockedHint: '先把三步答完（或点「跳过拷问直接建」），下面的需求字段才会解锁。',
    confirmedHint: '摘要已确认：填好需求描述与验收标准，再点【执行】提交给 PM。',
    skippedHint: '已跳过拷问：按推荐项写入正文并标注「按推荐默认」，现在可以提交。',
    needForm: '先把需求描述和验收标准填上，再点【执行】提交。',
    notAnswered: '还没回答三步拷问，也没有跳过拷问',
  },
  maxSummaryLines: 15,
};

let legacyGrillState = null;

function legacyGrillRecommended(round) {
  return round.options.find((o) => o.recommended) || round.options[0] || { value: '', label: '' };
}

function legacyGrillAnswerText(round, ans) {
  if (!ans) return { text: legacyGrillRecommended(round).label, source: NEW_REQ_GRILL.labels.defaulted };
  const custom = String(ans.custom || '').trim();
  const text = custom || String(ans.label || '').trim() || legacyGrillRecommended(round).label;
  const source = ans.skipped ? NEW_REQ_GRILL.labels.defaulted : NEW_REQ_GRILL.labels.chosen;
  return { text, source };
}

/** 摘要正文：逐轮一行（编号交给 <ol>/写进正文时的行号，正文里不重复编号），总行数不超过 maxSummaryLines。 */
function legacyGrillSummaryLines(st) {
  const g = NEW_REQ_GRILL;
  const state = st || legacyGrillState || { answers: {} };
  return g.rounds.map((round) => {
    const picked = legacyGrillAnswerText(round, state.answers ? state.answers[round.id] : null);
    return `${round.short}：${picked.text}（${picked.source}）`;
  });
}

function legacyGrillPanelHtml(st) {
  const g = NEW_REQ_GRILL;
  const total = g.rounds.length;
  const isSummary = st.step > total;
  const stepNo = String(Math.min(st.step, total));
  const stepText = isSummary
    ? g.labels.summaryStep
    : g.stepTemplate.replace('{n}', stepNo).replace('{total}', String(total));
  const head = `<div class="legacy-grill-head"><b>${esc(g.title)}</b>`
    + `<span class="legacy-grill-step" id="legacy-grill-stepno" data-step="${isSummary ? String(total + 1) : stepNo}" data-total="${total}">`
    + `${esc(stepText)}</span></div>`;
  if (st.step <= total) {
    const round = g.rounds[st.step - 1];
    const ans = (st.answers && st.answers[round.id]) || {};
    const opts = round.options.map((o) => `<label class="legacy-grill-opt${o.recommended ? ' recommended' : ''}">`
      + `<input type="radio" name="legacy-grill-opt" value="${esc(o.value)}" data-grill-label="${esc(o.label)}" data-grill-recommended="${o.recommended ? '1' : '0'}"${ans.value === o.value ? ' checked' : ''}>`
      + `<span>${esc(o.label)}${o.recommended ? `<b class="legacy-grill-tag">${esc(g.labels.recommended)}</b>` : ''}</span></label>`).join('');
    return `${head}`
      + `<p class="legacy-form-note" data-grill-q="${esc(round.id)}"><b>${esc(round.title)}</b>　${esc(round.hint)}</p>`
      + opts
      + `<label class="field"><span><b>${esc(g.labels.customLabel)}</b><span class="field-note">${esc(g.labels.customPlaceholder)}</span></span>`
      + `<input id="legacy-grill-custom" class="input" value="${esc(ans.custom || '')}"></label>`
      + '<div class="legacy-grill-bar">'
      + (st.step > 1 ? `<button type="button" class="ghost small" data-grill="prev">${esc(g.buttons.prev)}</button>` : '')
      + `<button type="button" class="ghost small" data-grill="skip-round">${esc(g.buttons.skipRound)}</button>`
      + `<button type="button" class="primary small" data-grill="next">${esc(st.step === total ? g.buttons.toSummary : g.buttons.next)}</button>`
      + `<button type="button" class="ghost small" data-grill="skip-all">${esc(g.buttons.skipAll)}</button>`
      + '</div>';
  }
  const lines = legacyGrillSummaryLines(st);
  return `${head}`
    + `<div class="legacy-grill-summary" id="legacy-grill-summary" data-lines="${lines.length}">`
    + `<p class="legacy-grill-summary-title">${esc(g.labels.summaryTitle)}</p>`
    + `<ol>${lines.map((line) => `<li>${esc(line)}</li>`).join('')}</ol>`
    + `<p class="legacy-grill-summary-hint">${esc(g.labels.summaryHint)}</p></div>`
    + '<div class="legacy-grill-bar">'
    + `<button type="button" class="ghost small" data-grill="edit">${esc(g.buttons.edit)}</button>`
    + `<button type="button" class="primary small" data-grill="confirm">${esc(g.buttons.confirm)}</button>`
    + `<button type="button" class="ghost small" data-grill="skip-all">${esc(g.buttons.skipAll)}</button>`
    + '</div>';
}

/** 面板外壳：靠 <div id="legacy-grill-body"> 就地重绘，避免整块 body 重排导致焦点丢失。 */
function legacyGrillPanelWrap(st) {
  const g = NEW_REQ_GRILL;
  return `<section id="legacy-grill" class="legacy-grill" data-confirmed="${(st && st.confirmed) ? '1' : '0'}" data-mode="${(st && st.mode) || 'ask'}">`
    + `<p class="legacy-grill-intro">${esc(g.intro)}</p>`
    + `<div id="legacy-grill-body">${legacyGrillPanelHtml(st || { step: 1, answers: {} })}</div>`
    + '</section>';
}

function legacyGrillWriteBody(html) {
  const host = document.getElementById('legacy-grill-body');
  if (host) host.innerHTML = html;
}

function legacyGrillReadStep(st) {
  const g = NEW_REQ_GRILL;
  const round = g.rounds[st.step - 1];
  if (!round) return;
  const picked = document.querySelector('#legacy-grill input[name="legacy-grill-opt"]:checked');
  const customEl = document.getElementById('legacy-grill-custom');
  const custom = customEl ? String(customEl.value || '').trim() : '';
  if (picked || custom) {
    st.answers[round.id] = {
      value: picked ? picked.value : 'custom',
      label: picked ? String(picked.dataset.grillLabel || '') : '',
      custom,
      skipped: false,
    };
  } else if (!st.answers[round.id]) {
    st.answers[round.id] = null;
  }
}

function legacyGrillMarkSkipped(st, roundId) {
  const g = NEW_REQ_GRILL;
  const round = g.rounds.find((r) => r.id === roundId);
  if (!round) return;
  const rec = legacyGrillRecommended(round);
  st.answers[round.id] = { value: rec.value, label: rec.label, custom: '', skipped: true };
}

/** 摘要文本块：确认页与正文里用的是同一份（编号按 1. 2. 3.）。 */
function legacyGrillComposeBlock(st) {
  const g = NEW_REQ_GRILL;
  const lines = legacyGrillSummaryLines(st);
  return ['【' + g.labels.summaryTitle + '】', ...lines.map((line, i) => `${i + 1}. ${line}`)].join('\n');
}

/** 打确认标记；摘要先存在状态里，提交那一刻再接到需求正文末尾（不动用户写的首行标题）。 */
function legacyGrillCommitBody(st, mode) {
  const g = NEW_REQ_GRILL;
  if (st) st.block = legacyGrillComposeBlock(st);
  const hidden = document.getElementById(g.fieldId);
  if (hidden) hidden.value = mode === 'skipped' ? 'skipped' : 'confirmed';
  const panel = document.getElementById('legacy-grill');
  if (panel) {
    panel.dataset.confirmed = '1';
    panel.dataset.mode = mode;
  }
}

/** 提交时把已确认的摘要接到正文末尾；没确认就不加任何东西。 */
function legacyGrillAppendSummary(text) {
  const st = legacyGrillState;
  if (!st || !st.confirmed || !st.block) return text;
  const body = String(text || '').trim();
  return body ? `${body}\n\n${st.block}` : st.block;
}

function legacyGrillUnlockFields() {
  const g = NEW_REQ_GRILL;
  const wrap = document.getElementById(g.fieldsWrapId);
  if (wrap) {
    wrap.dataset.locked = '0';
    wrap.querySelectorAll('input,textarea,select,button').forEach((el) => { el.disabled = false; });
  }
  const lockNote = document.getElementById('legacy-grill-locknote');
  if (lockNote) lockNote.hidden = true;
}

/**
 * 挂载三轮拷问：锁住需求字段 → 逐轮问答 → 摘要确认 → 解锁。
 * 只对 NEW_REQ_GRILL.actions（Owner → PM 提需求）挂载；产品/分析师建需求不受影响。
 * ctx = { go: 底部【执行】按钮, runGo: 执行函数, close: 关闭弹窗, error: 红字提示 }
 */
function legacyGrillMount(action, ctx) {
  const panel = document.getElementById('legacy-grill');
  if (!NEW_REQ_GRILL.actions.includes(action) || !panel) return;
  const g = NEW_REQ_GRILL;
  const wrap = document.getElementById(g.fieldsWrapId);
  const setLocked = (locked) => {
    if (!wrap) return;
    wrap.dataset.locked = locked ? '1' : '0';
    wrap.querySelectorAll('input,textarea,select,button').forEach((el) => { el.disabled = locked; });
  };
  // 之前已经确认过（例如表单重绘）就不再问第二遍。
  const hidden = document.getElementById(g.fieldId);
  const already = hidden ? String(hidden.value || '') : '';
  if (already === 'confirmed' || already === 'skipped') {
    panel.dataset.confirmed = '1';
    panel.dataset.mode = already === 'skipped' ? 'skipped' : 'confirm';
    legacyGrillWriteBody(`<p class="legacy-grill-done" data-grill-done="${esc(already)}">${esc(already === 'skipped' ? g.labels.skippedHint : g.labels.confirmedHint)}</p>`);
    setLocked(false);
    if (ctx && ctx.go) ctx.go.disabled = false;
    return;
  }
  legacyGrillState = { step: 1, answers: {}, confirmed: false, mode: 'ask' };
  setLocked(true);
  if (ctx && ctx.go) {
    ctx.go.disabled = true;
    ctx.go.title = g.labels.lockedHint;
  }
  setTimeout(() => {
    const next = document.querySelector('#legacy-grill [data-grill="next"]');
    if (next) next.focus();
  }, 40);
  const rerender = () => legacyGrillWriteBody(legacyGrillPanelHtml(legacyGrillState));
  const finish = (mode) => {
    legacyGrillState.confirmed = true;
    legacyGrillState.mode = mode;
    legacyGrillCommitBody(legacyGrillState, mode);
    legacyGrillUnlockFields();
    if (ctx && ctx.go) {
      ctx.go.disabled = false;
      ctx.go.title = '';
    }
    legacyGrillWriteBody(`<p class="legacy-grill-done" data-grill-done="${esc(mode)}">${esc(mode === 'skipped' ? g.labels.skippedHint : g.labels.confirmedHint)}</p>`);
  };
  panel.addEventListener('click', (event) => {
    const button = event.target && event.target.closest ? event.target.closest('[data-grill]') : null;
    if (!button) return;
    event.preventDefault();
    const kind = button.getAttribute('data-grill');
    const st = legacyGrillState;
    if (!st) return;
    if (kind === 'next') {
      legacyGrillReadStep(st);
      if (!st.answers[g.rounds[st.step - 1].id]) legacyGrillMarkSkipped(st, g.rounds[st.step - 1].id);
      st.step += 1;
      rerender();
      return;
    }
    if (kind === 'skip-round') {
      legacyGrillMarkSkipped(st, g.rounds[st.step - 1].id);
      st.step += 1;
      rerender();
      return;
    }
    if (kind === 'prev') {
      legacyGrillReadStep(st);
      st.step = Math.max(1, st.step - 1);
      rerender();
      return;
    }
    if (kind === 'edit') {
      st.step = 1;
      rerender();
      return;
    }
    if (kind === 'skip-all') {
      g.rounds.forEach((round) => legacyGrillMarkSkipped(st, round.id));
      finish('skipped');
      return;
    }
    if (kind === 'confirm') {
      finish('confirm');
      const form = legacyReadForm();
      if (form.title && form.acceptance) {
        if (ctx && typeof ctx.runGo === 'function') ctx.runGo();
      } else if (ctx && ctx.error) {
        ctx.error(g.labels.needForm);
      }
    }
  });
}

function legacyActionBody(action, req) {
  const terms = modeTerms();
  const selected = req && req.id ? req.id : '';
  const reqAll = legacyRequirements();
  const first = reqAll[0] || null;
  const selectedReq = req || first;
  switch (action) {
    case 'boot': {
      return legacyField('要 boot 的角色', `<select id="legacy-a-role" class="select">${legacyRoleOptions(teamRoleIds(), selectedReq ? 'pm' : 'pm')}</select>`, 'workflow:boot 读齐必读文件并写启动记录；界面发起，不冒充角色本人。快速模式只列当前显示的 4 个角色；后端自动补 boot 不受影响。');
    }
    case 'requirement-create': {
      const createRoles = isQuickTeam() ? ['analyst'] : ['product', 'analyst'];
      return legacyField('创建角色', `<select id="legacy-a-role" class="select">${legacyRoleOptions(createRoles, 'analyst')}</select>`, isQuickTeam()
        ? `只有${terms.reviewer}能建需求；所选角色未 boot 时，后端会先取得该角色 boot 令牌（首次自动 boot）`
        : '只有产品设计师 / 需求分析师能建需求；所选角色未 boot 时，后端会先取得该角色 boot 令牌（首次自动 boot）')
        + legacyField('标题', '<input id="legacy-a-title" class="input" placeholder="例如：首页作品流">')
        + legacyField('验收标准（必填）', '<textarea id="legacy-a-acceptance" class="textarea" placeholder="没有验收标准不允许进入开发"></textarea>')
        + legacyField('优先级', '<select id="legacy-a-priority" class="select"><option>P0</option><option selected>P1</option><option>P2</option><option>P3</option></select>')
        + legacyField('用户故事', '<textarea id="legacy-a-story" class="textarea" placeholder="可选"></textarea>')
        + legacyField('详情', '<textarea id="legacy-a-detail" class="textarea" placeholder="可选"></textarea>');
    }
    case 'owner-create': {
      return `<p class="legacy-form-note">向 PM 提交需求（Owner）：调用 <code>requirement:owner-create</code>，由 PM 代办建档；项目开始 / 评审 / 迭代时提交。PM 未 boot/未读全时，执行前会先自动补 boot。</p>`
        + legacyGrillPanelWrap(legacyGrillState || { step: 1, answers: {} })
        + `<p class="legacy-form-note" id="legacy-grill-locknote">${esc(NEW_REQ_GRILL.labels.lockedHint)}</p>`
        + `<input type="hidden" id="${esc(NEW_REQ_GRILL.fieldId)}" value="">`
        + '<div id="legacy-owner-fields" data-locked="1">'
        + legacyField('需求描述（必填）', '<textarea id="legacy-a-description" class="textarea" placeholder="要做什么、为什么做；第一行会作为需求标题"></textarea>')
        + legacyField('验收标准（必填 · 每条一行，可多条）', '<textarea id="legacy-a-acceptance" class="textarea" placeholder="1. 可验收的行为或结果&#10;2. 另一条标准"></textarea>')
        + legacyField('优先级', '<select id="legacy-a-priority" class="select"><option>P0</option><option selected>P1</option><option>P2</option><option>P3</option></select>')
        + '</div>';
    }
    case 'owner-demand': {
      return `<p class="legacy-form-note">向 PM 提交需求（Owner）：调用 <code>owner:demand</code>，只提需求描述、优先级、验收标准（每条一行，可多条）；PM 会自动 boot 代办建档，当前无在办需求时直接进入${esc(terms.review)}，在办/迭代期间排到下一次。</p>`
        + legacyGrillPanelWrap(legacyGrillState || { step: 1, answers: {} })
        + `<p class="legacy-form-note" id="legacy-grill-locknote">${esc(NEW_REQ_GRILL.labels.lockedHint)}</p>`
        + `<input type="hidden" id="${esc(NEW_REQ_GRILL.fieldId)}" value="">`
        + '<div id="legacy-owner-fields" data-locked="1">'
        + legacyField('需求描述（必填）', '<textarea id="legacy-a-description" class="textarea" placeholder="要做什么、为什么做"></textarea>')
        + legacyField('验收标准（必填 · 每条一行，可多条）', '<textarea id="legacy-a-acceptance" class="textarea" placeholder="1. 可验收的行为或结果&#10;2. 另一条标准"></textarea>')
        + legacyField('优先级', '<select id="legacy-a-priority" class="select"><option>P0</option><option selected>P1</option><option>P2</option><option>P3</option></select>')
        + '</div>';
    }
    case 'requirement-review': {
      const reviewRole = isQuickTeam() ? 'analyst' : 'product';
      return `<p class="legacy-form-note">${isQuickTeam()
        ? `快速团队由${terms.reviewer}评审；通过后进入 Owner。执行前会自动补一次真实 boot，后端仍校验阅读证据。`
        : '产品设计师未 boot/未读全时，执行前会先自动补一次真实 boot，再调用 <code>requirement:review</code>；后端仍校验阅读证据。'}</p>`
        + `<p class="legacy-form-note">本次评审人：<b>${esc(roleById(reviewRole).name)}</b></p>`
        + legacyField('需求', legacyReqSelect('legacy-a-req', ['review', 'rejected'], selected))
        + legacyField('结论', '<select id="legacy-a-verdict" class="select"><option value="approve">通过（进入 Owner 闸门）</option><option value="reject">打回（至少 10 字理由）</option></select>')
        + legacyField('评审意见', '<textarea id="legacy-a-comment" class="textarea" placeholder="打回必须写清原因"></textarea>');
    }
    case 'tech-review': {
      return `<p class="legacy-form-note">快速团队${esc(terms.techReview)}：Owner 通过后、PM 派单前，由程序员A判断实现可行性/风险；通过才 ready 可派单，打回则回到需求。执行前自动补程序员A的 boot，后端仍校验阅读证据。</p>`
        + legacyField('需求', legacyReqSelect('legacy-a-req', ['tech_review'], selected))
        + legacyField('结论', '<select id="legacy-a-verdict" class="select"><option value="approve">通过（可派单）</option><option value="reject">打回（至少 10 字理由）</option></select>')
        + legacyField('技术评审意见', '<textarea id="legacy-a-comment" class="textarea" placeholder="打回必须写清原因"></textarea>')
        + legacyField('证据（可选）', '<textarea id="legacy-a-evidence" class="textarea" placeholder="文件、接口、测试/构建证据；会写入工作流"></textarea>');
    }
    case 'owner-review': {
      const product = legacyBootFor('product');
      return `<p class="legacy-form-note">后端 <code>requirement:owner</code> 会校验需求评审人的阅读证据：当前 ${isQuickTeam() ? `${esc(terms.review)}（兼容 product）` : terms.reviewer} <b class="${product.ready ? 'ok' : 'bad'}">${esc(product.label)}</b>。Owner 是外部角色、不跑 boot；未读全时，执行前会先自动补一次真实 boot，再由后端校验。</p>`
        + legacyField('需求', legacyReqSelect('legacy-a-req', ['approved'], selected))
        + legacyField('Owner 决定', '<select id="legacy-a-decision" class="select"><option value="approved">通过</option><option value="skipped">跳过</option><option value="rejected">打回需求</option></select>')
        + legacyField('Owner 意见', '<textarea id="legacy-a-opinion" class="textarea" placeholder="通过/跳过/打回的理由"></textarea>');
    }
    case 'dispatch': {
      const owners = ['programmer1', 'programmer2'].filter((id) => teamRoleIds().includes(id));
      return legacyField('需求', legacyReqSelect('legacy-a-req', ['ready'], selected))
        + legacyField('开发负责人', `<select id="legacy-a-owner" class="select">${legacyRoleOptions(owners.length ? owners : ['programmer1'], 'programmer1')}</select>`)
        + legacyField('派单说明', '<textarea id="legacy-a-detail" class="textarea" placeholder="目标文件、边界、验收；会写入旧协议消息"></textarea>');
    }
    case 'task-claim': {
      const claimDefault = selectedReq && selectedReq.test && selectedReq.test.taskId ? 'tester' : 'programmer1';
      const claimRoles = teamRoleIds().filter((id) => ['programmer1', 'programmer2', 'tester'].includes(id));
      return legacyField('需求', legacyReqSelect('legacy-a-req', ['dev', 'test'], selected))
        + legacyField('认领角色', `<select id="legacy-a-role" class="select">${legacyRoleOptions(claimRoles, claimDefault)}</select>`);
    }
    case 'task-done': {
      const doneDefault = selectedReq && selectedReq.test && selectedReq.test.taskId ? 'tester' : 'programmer1';
      const doneRoles = teamRoleIds().filter((id) => ['programmer1', 'programmer2', 'tester'].includes(id));
      return legacyField('需求', legacyReqSelect('legacy-a-req', ['dev', 'dev_done', 'test'], selected))
        + legacyField('完成角色', `<select id="legacy-a-role" class="select">${legacyRoleOptions(doneRoles, doneDefault)}</select>`)
        + legacyField('证据（必填）', '<textarea id="legacy-a-evidence" class="textarea" placeholder="提交号 / 文件路径 / 验证输出"></textarea>');
    }
    case 'dev-submit': {
      const submitRoles = teamRoleIds().filter((id) => ['programmer1', 'programmer2'].includes(id));
      return legacyField('需求', legacyReqSelect('legacy-a-req', ['dev'], selected))
        + legacyField('提交角色', `<select id="legacy-a-role" class="select">${legacyRoleOptions(submitRoles, (selectedReq && selectedReq.dev && selectedReq.dev.claimBy) || 'programmer1')}</select>`)
        + legacyField('标题', '<input id="legacy-a-title" class="input" placeholder="可选">')
        + legacyField('目标文件（项目内相对路径）', '<input id="legacy-a-target" class="input" placeholder="site/index.html">')
        + legacyField('暂存内容', '<textarea id="legacy-a-content" class="textarea" placeholder="写入目标文件的完整内容；apply 前只落暂存"></textarea>')
        + legacyField('提交理由', '<textarea id="legacy-a-rationale" class="textarea" placeholder="为什么改、边界、风险"></textarea>')
        + legacyField('风险', '<select id="legacy-a-risk" class="select"><option value="normal">normal</option><option value="sensitive">sensitive</option><option value="critical">critical</option></select>');
    }
    case 'dev-review': {
      const author = selectedReq && selectedReq.dev && selectedReq.dev.proposal ? selectedReq.dev.proposal.author : 'programmer1';
      const reviewer = isQuickTeam() ? 'tester' : (author === 'programmer1' ? 'programmer2' : 'programmer1');
      const reviewRoles = isQuickTeam() ? ['tester'] : ['programmer1', 'programmer2'];
      return legacyField('需求', legacyReqSelect('legacy-a-req', ['dev', 'dev_review'], selected))
        + legacyField(isQuickTeam() ? `${terms.devReview}人（测试人员）` : '互审人', `<select id="legacy-a-role" class="select">${legacyRoleOptions(reviewRoles, reviewer)}</select>`, isQuickTeam() ? `快速团队由测试人员独立${terms.devReview}；PM 在签字 apply 时复核（团队工具不允许 PM 既当唯一评审又当唯一签字人）` : '不能审自己')
        + legacyField('结论', '<select id="legacy-a-verdict" class="select"><option value="approve">通过</option><option value="reject">打回</option></select>')
        + legacyField('复核意见', '<textarea id="legacy-a-comment" class="textarea" placeholder="接口/数据/回归边界"></textarea>');
    }
    case 'dev-apply': {
      return legacyField('需求', legacyReqSelect('legacy-a-req', ['dev', 'dev_review'], selected))
        + legacyField('PM 签字说明', '<textarea id="legacy-a-note" class="textarea" placeholder="复核结论；会走 show → review → sign → apply"></textarea>');
    }
    case 'test-dispatch': {
      return legacyField('需求', legacyReqSelect('legacy-a-req', ['dev_done'], selected))
        + legacyField('测试说明', '<textarea id="legacy-a-detail" class="textarea" placeholder="独立验证范围与证据要求"></textarea>');
    }
    case 'owner-accept': {
      const tester = legacyBootFor('tester');
      const pm = legacyBootFor('pm');
      return `<p class="legacy-form-note">后端 <code>owner:accept</code> 按决定校验不同角色的阅读证据：<b>通过 / 打回</b>需 tester（当前 <b class="${tester.ready ? 'ok' : 'bad'}">${esc(tester.label)}</b>）；<b>转下一次 / 终止</b>需 PM（当前 <b class="${pm.ready ? 'ok' : 'bad'}">${esc(pm.label)}</b>）。未就绪时执行前会自动补一次真实 boot，再由后端校验。</p>`
        + legacyField('需求', legacyReqSelect('legacy-a-req', ['test_done'], selected))
        + legacyField('验收决定', '<select id="legacy-a-decision" class="select"><option value="accepted">通过验收</option><option value="rejected">打回需求</option><option value="iterate">转下一次</option><option value="terminated">终止</option></select>')
        + legacyField('Owner 意见', '<textarea id="legacy-a-opinion" class="textarea" placeholder="验收结论 / 下一次要求"></textarea>');
    }
    case 'iterate': {
      const guard = legacyIterateGuard();
      return `<p class="legacy-form-note">调用 <code>workflow:iterate</code>：阶段 +1，把 queued 的 Owner 新需求释放为当前需求。只有 Owner / PM 能启动下一次。</p>
        <p class="legacy-modal-warn">只在全部需求验收后（accepted）且没有在办需求时可用；当前需求被投票驳回后已无在办需求时也允许收口。执行会让当前角色 boot 全部作废，下一次需要重新 boot。</p>
        ${guard.ok ? '' : `<p class="legacy-modal-warn">当前不可迭代：${esc(guard.reason)}</p>`}`
        + legacyField('说明', '<textarea id="legacy-a-opinion" class="textarea" placeholder="当前收口结论 / 下一次目标"></textarea>');
    }
    case 'terminate': {
      return `<p class="legacy-form-note">调用 <code>workflow:terminate</code>：把工作流标为 terminated，不删除项目目录或本机记录；必须写原因。</p>`
        + legacyField('终止原因', '<textarea id="legacy-a-opinion" class="textarea" placeholder="为什么终止、遗留事项"></textarea>');
    }
    default:
      return '<div class="empty-row">未知动作。</div>';
  }
}

function legacyReadForm() {
  const val = (id) => {
    const el = document.getElementById(id);
    return el ? String(el.value || '').trim() : '';
  };
  return {
    role: val('legacy-a-role'),
    req: val('legacy-a-req'),
    title: val('legacy-a-title'),
    acceptance: val('legacy-a-acceptance'),
    priority: val('legacy-a-priority'),
    story: val('legacy-a-story'),
    detail: val('legacy-a-detail'),
    verdict: val('legacy-a-verdict'),
    comment: val('legacy-a-comment'),
    decision: val('legacy-a-decision'),
    opinion: val('legacy-a-opinion'),
    owner: val('legacy-a-owner'),
    evidence: val('legacy-a-evidence'),
    target: val('legacy-a-target'),
    content: val('legacy-a-content'),
    rationale: val('legacy-a-rationale'),
    risk: val('legacy-a-risk'),
    note: val('legacy-a-note'),
    grill: val(NEW_REQ_GRILL.fieldId),
    description: val('legacy-a-description')
  };
}

async function legacyCallWorkflow(action, payload) {
  const wb = window.workbench || {};
  const map = {
    boot: wb.workflowBoot,
    'requirement-create': wb.requirementCreate,
    'owner-create': wb.requirementOwnerCreate,
    'owner-demand': wb.ownerDemand,
    'requirement-review': wb.requirementReview,
    'tech-review': wb.requirementTechReview,
    'owner-review': wb.requirementOwner,
    dispatch: wb.requirementDispatch,
    'task-claim': wb.taskClaim,
    'task-done': wb.taskDone,
    'dev-submit': wb.devSubmit,
    'dev-review': wb.devReview,
    'dev-apply': wb.devApply,
    'test-dispatch': wb.testDispatch,
    'owner-accept': wb.ownerAccept,
    iterate: wb.workflowIterate,
    terminate: wb.workflowTerminate
  };
  const fn = map[action];
  if (typeof fn !== 'function') throw new Error('当前 preload 缺少动作 IPC：' + action);
  const project = activeProject();
  if (!project) throw new Error('先选择工作区');
  return fn({ projectId: project.id, ...payload });
}

/** 把一次 workflow 动作的真实返回记到界面：缺命令/文件契约/警告不能只活在 toast 里。 */
function legacyRecordAction(action, label, result, error = null) {
  const legacy = result && result.legacy && typeof result.legacy === 'object' ? result.legacy : null;
  const warnings = result && Array.isArray(result.warnings) ? result.warnings : [];
  const missingWarn = warnings.find((row) => String(row && row.code || '').includes('LEGACY_COMMAND_MISSING'));
  const taskDone = result && result.requirementTaskDone && typeof result.requirementTaskDone === 'object'
    ? result.requirementTaskDone : null;
  legacyUi.lastAction = {
    action,
    label,
    at: new Date().toISOString(),
    ok: !error && (!result || result.ok !== false),
    code: error ? String(error.code || 'ACTION_FAILED') : String((result && result.code) || 'OK'),
    message: error ? humanError(error.message) : String((result && (result.message || result.why)) || ''),
    driver: result && result.driver ? String(result.driver) : '',
    shellOwned: Boolean(legacy && legacy.shellOwned),
    command: legacy && legacy.command ? String(legacy.command) : '',
    commandAvailable: legacy && typeof legacy.commandAvailable === 'boolean' ? legacy.commandAvailable : null,
    missingCommands: legacy && Array.isArray(legacy.missingCommands) ? legacy.missingCommands : [],
    warnings,
    // 壳层动作（Fast iterate）确实写了后端状态：不能按“旧命令缺失 · 未写状态”展示。
    contractOnly: Boolean((legacy && legacy.commandAvailable === false && legacy.shellOwned !== true) || missingWarn),
    // 只有本机 Owner（我）按钮点击过的 Owner 动作才写 actor；其他动作仍只认后端返回的 actor。
    actor: OWNER_CONFIRM_ACTIONS.has(action) ? OWNER_CONFIRM_ACTOR : String((result && result.actor) || ''),
    workflowFile: String((result && (result.workflowFile || (result.workflowWrite && result.workflowWrite.file))) || ''),
    // Owner 验收后壳会以 pm 跑旧 task done；失败被外层 ok:true 吞掉时，必须在这里显式留痕。
    requirementTaskDone: taskDone ? {
      ok: taskDone.ok !== false,
      code: String(taskDone.code || (taskDone.ok === false ? 'TASK_DONE_FAILED' : 'OK')),
      message: String(taskDone.message || taskDone.why || '')
    } : null,
    // 后端动作后刷新项目索引的真实结果；没有返回就显示“未返回”，不猜“已刷新”。
    projectIndex: result && result.projectIndex && typeof result.projectIndex === 'object' ? {
      ok: result.projectIndex.ok !== false,
      code: String(result.projectIndex.code || (result.projectIndex.ok === false ? 'INDEX_FAILED' : 'OK')),
      files: Number(result.projectIndex.files) || 0,
      requirements: Number(result.projectIndex.requirements) || 0,
      roleIndexes: Number(result.projectIndex.roleIndexes) || 0,
      message: String(result.projectIndex.message || ''),
      generatedAt: result.projectIndex.generatedAt || null
    } : null
  };
  return legacyUi.lastAction;
}

async function legacyBoot(roleId) {
  if (!roleId) return;
  const gate = legacyActionCommandGate('boot');
  if (!gate.ok) { toast(gate.reason, 'bad'); return; }
  const role = roleById(roleId);
  try {
    const result = await legacyCallWorkflow('boot', { role: roleId });
    if (!result || result.ok === false) {
      const failure = new Error(`[${(result && result.code) || 'BOOT_FAILED'}] ${(result && (result.message || result.why)) || 'boot 失败'}`);
      failure.code = (result && result.code) || 'BOOT_FAILED';
      throw failure;
    }
    // 本次界面的真实 boot 返回：只放内存，作为“已读证据”展示；刷新后回到 briefing 记录。
    legacyUi.bootEvidence[roleId] = result;
    if (result.state) { state = result.state; render(); }
    await loadLegacyDocs(true);
    const read = result.bootRead || {};
    const checks = read.hashChecks || null;
    const failedChecks = checks ? LEGACY_HASH_LABELS.filter(([key]) => !checks[key]).map(([, name]) => name) : [];
    if (!read.complete) {
      toast(`${role.name} boot 返回不完整：缺 ${(read.missing || []).join('、') || '必读文件'}；不能据此推进`, 'bad');
    } else if (failedChecks.length) {
      toast(`${role.name} 已 boot，但旧令牌哈希未命中：${failedChecks.join('、')}；界面按未全部核验显示，不冒充读全`, 'bad');
    } else {
      toast(`${role.name} boot 完成：必读文件齐全，旧令牌哈希全部命中（由界面发起，后端记录 role/session）`, 'ok');
    }
  } catch (e) {
    legacyRecordAction('boot', 'boot · ' + role.name, null, e);
    renderLegacyPanels();
    toast('boot 失败：' + humanError(e.message), 'bad');
  }
}

/**
 * 动作执行前补 boot：只调真实 workflow:boot，不使用界面状态补造“已读”。
 * 命令缺失、boot 失败或 boot 后仍未被后端判为已读时，抛出明确错误，后续动作不执行。
 */
async function legacyEnsureRoleReadyForAction(roleId, actionLabel = '') {
  const id = String(roleId || '').trim();
  if (!id || legacyRoleReady(id)) return false;
  const role = roleById(id);
  const bootGate = legacyActionCommandGate('boot');
  if (!bootGate.ok) {
    throw new Error(`${role.name} 未 boot/未读全；boot 命令不可用（${bootGate.reason}），无法自动补 boot`);
  }
  const result = await legacyCallWorkflow('boot', { role: id });
  if (!result || result.ok === false) {
    const failure = new Error(`[${(result && result.code) || 'BOOT_FAILED'}] ${(result && (result.message || result.why)) || `${role.name} 自动 boot 失败`}`);
    failure.code = (result && result.code) || 'BOOT_FAILED';
    throw failure;
  }
  legacyUi.bootEvidence[id] = result;
  if (result.state) state = result.state;
  await loadLegacyDocs(true);
  if (!legacyRoleReady(id)) {
    throw new Error(`${role.name} 自动 boot 后仍未被后端判为已读全${actionLabel ? `（${actionLabel} 未执行）` : ''}；先看六角色卡的 boot 记录`);
  }
  return true;
}

function legacyRestoreActionForm(form) {
  if (!form) return;
  const fields = ['role', 'req', 'title', 'acceptance', 'priority', 'story', 'detail', 'verdict',
    'comment', 'decision', 'opinion', 'owner', 'evidence', 'target', 'content', 'rationale', 'risk', 'note', 'description', 'grill'];
  for (const key of fields) {
    const el = document.getElementById('legacy-a-' + key);
    if (el && form[key] !== undefined && form[key] !== null) el.value = form[key];
  }
}

/** 旧正文需求（只有 需求/R-*.md）的说明：不承诺成功，只说明后端会按正文解析。 */
function legacyLegacyDocNote(req) {
  if (!req || req.origin !== 'legacy-doc') return '';
  return `<p class="legacy-form-note legacy-legacy-doc-note">这是 <b>旧正文需求</b>（<code>${esc(req.id)}</code>）：只有需求正文，工作流里可能还没有对应行。提交后由后端按正文解析并补建；4 位编号原样保留，界面不会把失败显示成成功。</p>`;
}

function legacyResultRequirement(result, requirementId) {
  const rows = result && result.snapshot && Array.isArray(result.snapshot.requirements)
    ? result.snapshot.requirements : [];
  return rows.find((row) => String(row && row.id) === String(requirementId))
    || (result && result.requirement)
    || null;
}

function legacyOwnerDecisionLabel(action, decision) {
  return action === 'owner-accept'
    ? ({ accepted: '通过验收', rejected: '打回需求', iterate: '转下一次', terminated: '终止' }[decision] || decision)
    : ({ approved: '通过', skipped: '跳过', rejected: '打回需求' }[decision] || decision);
}

/**
 * Owner（我）一次点击按钮：通过/跳过/打回/验收都只点一下。
 * 不再弹确认码输入框，也不调用 owner:challenge / owner:confirm；
 * 直接调用 requirement:owner / owner:accept，标记 ownerConfirmed 交给后端落账。
 */
/**
 * Owner 验收的“通过/打回”在 Fast 也由后端壳层收口（shellOwnedAccept）；
 * “转下一轮/终止”仍要 workflow 旧命令，所以这里只在 accepted/rejected 两个决定上放行。
 */
function legacyOwnerActionGate(action, decision) {
  const gate = legacyActionCommandGate(action);
  if (action === 'owner-accept' && isQuickTeam() && ['accepted', 'rejected'].includes(String(decision))) {
    return { ...gate, ok: true, missing: [], unknown: [], reason: '', shellOwned: true };
  }
  return gate;
}

function legacyOwnerQuickButton(kind, req, decision, label) {
  const action = kind === 'accept' ? 'owner-accept' : 'owner-review';
  const gate = legacyOwnerActionGate(action, decision);
  const processGate = gateForAction(action);
  const decisionValue = String(decision || '').trim();
  let gateDenied = Boolean(processGate && processGate.ok === false);
  // B-3524：G2.5 只拦“通过/开发”；打回/跳过不受可测性评审限制，
  // 否则 not_testable 的需求连“打回”按钮都会被闸门锁死（Owner 实测）。
  if (gateDenied && action === 'owner-review' && decisionValue && decisionValue !== 'approved'
    && String((processGate && processGate.gate) || '') === 'G2.5') {
    gateDenied = false;
  }
  const ready = gate.ok && !gateDenied;
  const shellOwned = gate.shellOwned && (action === 'owner-review' || action === 'owner-accept');
  const why = gateDenied
    ? gateDeniedText(processGate)
    : (!gate.ok
      ? gate.reason
      : (shellOwned
        ? `Owner（我）一次点击：直接调用 ${action === 'owner-accept' ? 'owner:accept' : 'requirement:owner'}；后端壳收口（Full / Fast），不依赖旧 ${action === 'owner-accept' ? 'owner/workflow' : 'owner'} 命令（${label}）`
        : `${label}：一次点击直接调用后端（${action === 'owner-accept' ? 'owner:accept' : 'requirement:owner'}），无需二次确认`));
  const gateNote = gateDenied
    ? `<span class="legacy-req-gate" title="${esc(why)}">闸门 ${esc(processGate.gate || processGate.code || '拒绝')}：${esc(processGate.title || processGate.code || '未满足')}</span>`
    : '';
  const gateBlocked = gateDenied && gate.ok;
  return `<button type="button" class="ghost small owner-click${gateBlocked ? ' gate-blocked' : ''}" data-legacy-owner-click="${esc(kind)}" data-legacy-owner-decision="${esc(decision)}" data-req-id="${esc(req.id)}" ${ready || gateBlocked ? '' : 'disabled'}${gateBlocked ? ' data-gate-blocked="1" data-gate-action="' + esc(action) + '" aria-disabled="true"' : ''} title="${esc(why)}">${esc(label)}</button>${gateNote}`;
}

/**
 * Owner（我）一次点击提交：不弹确认码、不调用 owner:challenge/owner:confirm。
 * 后端返回什么界面就显示什么；所需角色未 boot 时先补一次真实 boot，再由后端校验。
 */
async function legacyOwnerOneClick(kind, reqId, decision, button) {
  const wb = window.workbench || {};
  const needsOwnerAccept = kind === 'accept';
  if ((needsOwnerAccept && typeof wb.ownerAccept !== 'function')
    || (!needsOwnerAccept && typeof wb.requirementOwner !== 'function')) {
    toast(`当前 preload 没有 ${needsOwnerAccept ? 'owner:accept' : 'requirement:owner'}，不能执行 Owner 动作`, 'bad');
    return;
  }
  const reqs = legacyRequirements();
  const req = reqs.find((row) => row.id === reqId);
  if (!req) { toast('找不到需求：' + reqId, 'bad'); return; }
  if (legacyWorkflow() && legacyWorkflow().phase === 'terminated') {
    toast('工作流已终止；不再接受推进动作。需要新项目请重新建工作区。', 'bad');
    return;
  }
  const action = kind === 'accept' ? 'owner-accept' : 'owner-review';
  const gate = legacyOwnerActionGate(action, decision);
  if (!gate.ok) { toast(gate.reason, 'bad'); return; }
  const processGate = gateForAction(action);
  if (processGate && processGate.ok === false) {
    showGateRejection(processGate, { attempted: action, source: 'team.mjs 闸门判定（gate:check）' });
    return;
  }
  const label = action === 'owner-accept' ? 'Owner 验收（一次点击）' : 'Owner 决定（一次点击）';
  const originalText = button ? button.textContent : '';
  if (button) {
    button.disabled = true;
    button.textContent = '提交中…';
  }
  try {
    // 与按钮一致：只在缺命令时失败；所需角色未 boot 时先补一次真实 boot，再执行原动作。
    if (action === 'owner-review') {
      await legacyEnsureRoleReadyForAction(isQuickTeam() ? 'analyst' : 'product', label);
    } else {
      await legacyEnsureRoleReadyForAction(['accepted', 'rejected'].includes(decision) ? 'tester' : 'pm', label);
    }
    const payload = { requirementId: req.id, decision, opinion: '', ownerConfirmed: true, channel: 'ui' };
    const result = await legacyCallWorkflow(action, payload);
    if (!result || result.ok === false) {
      const failure = new Error(`[${(result && result.code) || 'WORKFLOW_FAILED'}] ${(result && (result.message || result.why)) || '后端拒绝执行'}`);
      failure.code = (result && result.code) || 'WORKFLOW_FAILED';
      throw failure;
    }
    legacyRecordAction(action, label, result);
    if (result.state) { state = result.state; render(); }
    if (result.snapshot && result.snapshot.ok !== false) {
      const snapshotPhase = legacyDisplayPhase(
        result.snapshot.phase || legacyPhaseFromRequirements(result.snapshot.requirements, result.snapshot.round),
        result.snapshot.requirements
      );
      legacyUi.phaseHint = {
        phase: snapshotPhase,
        round: result.snapshot.round,
        statusKey: (result.snapshot.requirements || []).map((row) => String(row.id || '') + ':' + String(row.status || '')).join('|')
      };
      legacyUi.workflow = { ...(legacyUi.workflow || {}), ...result.snapshot, phase: snapshotPhase };
    }
    const row = legacyResultRequirement(result, req.id) || {};
    const record = action === 'owner-accept' ? row.ownerAcceptance : row.ownerReview;
    const actor = String((record && record.actor) || OWNER_CONFIRM_ACTOR);
    legacyRememberOwnerConfirmation({
      requirementId: req.id,
      kind: action === 'owner-accept' ? 'accept' : 'owner',
      at: record && record.at,
      decision,
      actor
    });
    await loadLegacyDocs(true);
    loadGateCheck({ force: true });
    loadGateAudit({ force: true });
    toast(`Owner（我）已提交：${legacyOwnerDecisionLabel(action, decision)}（后端返回 ${result.code || 'OK'}）· actor=${actor}（本机点击）`, 'ok');
  } catch (e) {
    legacyRecordAction(action, label, null, e);
    renderLegacyCapabilities();
    const gateView = gateErrorView(e, { attempted: action });
    if (gateView) showGateRejection(gateView);
    else toast(humanError(e.message), 'bad');
  } finally {
    if (button) {
      button.disabled = false;
      button.textContent = originalText;
    }
  }
}

function legacyOwnerSuccessMarkup(action, req, form, result) {
  const decision = String(form.decision || '');
  const decisionLabel = legacyOwnerDecisionLabel(action, decision);
  const row = legacyResultRequirement(result, req.id) || {};
  const record = action === 'owner-accept' ? row.ownerAcceptance : row.ownerReview;
  const actor = String((record && record.actor) || OWNER_CONFIRM_ACTOR);
  const confirmation = (record && record.confirmation) || null;
  const channel = String((record && record.channel) || (confirmation && confirmation.channel) || 'local-confirm');
  const confirmed = legacyOwnerConfirmationFor(
    record,
    req.id,
    action === 'owner-accept' ? 'accept' : 'owner'
  );
  return `<div class="legacy-owner-success" data-owner-confirmed="true" data-owner-actor="${esc(actor)}">
    <div class="legacy-owner-success-head"><b>Owner（我）${esc(action === 'owner-accept' ? '验收' : '决定')}已记录</b><span class="badge badge-approved">已记录</span></div>
    <div class="legacy-confirm-grid">
      <div><span>需求</span><b>${esc(req.id)}</b></div>
      <div><span>决定</span><b>${esc(decisionLabel || '—')}</b></div>
      <div><span>actor</span><b><code>${esc(actor)}</code>（本机点击）</b><small>记录通道：${esc(channel)}</small></div>
      <div><span>确认时间</span><b>${esc(confirmed ? fmtTime(confirmed.confirmedAt) : fmtTime(new Date().toISOString()))}</b></div>
      <div><span>后端返回</span><b>${esc((result && result.code) || 'OK')}</b></div>
    </div>
    <p class="hint">Owner（我）一次点击提交；actor 由后端落账返回，不是 DSH 会话签名。</p>
    <div class="modal-error"></div>
  </div>`;
}

/**
 * Owner 评审材料：四类（需求正文 / 上游产出 / 测试报告 / 最近提交）。
 * 清单来自主进程 owner:materials（带路径、大小、更新时间、版本），单项读取走 owner:material；
 * 缺失写“未记录”，不可读写“不可读（原因）”，不补造内容；1 MB 上限由主进程校验。
 * 历史提案数据保留只读通道（proposal:list / proposal:legacy），界面不再提供入口与摘要。
 */
function ownerMaterialVersionLabel(item) {
  const versions = Array.isArray(item.versions) ? item.versions : [];
  if (versions.length > 1) return `共 ${versions.length} 版 · 默认 v${item.version === null || item.version === undefined ? '—' : item.version}`;
  if (item.version) return `v${item.version}`;
  return '';
}

function ownerMaterialTime(value) {
  if (!value) return '';
  const d = new Date(value);
  if (Number.isNaN(d.getTime())) return String(value);
  return fmtTime(d.toISOString());
}

async function enhanceOwnerReviewModal(dlg, project, req) {
  if (!dlg || !dlg.body || !project) return;
  if (dlg.el) dlg.el.style.width = 'min(960px, calc(100vw - 40px))';
  const box = document.createElement('section');
  box.className = 'owner-materials two-pane';
  box.innerHTML = `
    <div class="owner-materials-head"><b>当前评审材料（只读）</b><span id="owner-material-status">读取中…</span></div>
    <div class="owner-materials-body">
      <div class="owner-materials-list" id="owner-material-list" role="tree" aria-label="评审材料"></div>
      <div class="owner-material-preview-wrap">
        <div class="owner-material-toolbar">
          <span id="owner-material-path">—</span>
          <select id="owner-material-version" class="select" hidden aria-label="切换材料版本"></select>
          <button class="ghost small" id="owner-material-open" type="button" disabled>打开文件</button>
        </div>
        <pre class="owner-material-preview" id="owner-material-preview">选择左侧材料后在这里预览；不会修改任何文件。</pre>
      </div>
    </div>`;
  dlg.body.insertBefore(box, dlg.body.firstChild);
  const list = box.querySelector('#owner-material-list');
  const preview = box.querySelector('#owner-material-preview');
  const status = box.querySelector('#owner-material-status');
  const pathEl = box.querySelector('#owner-material-path');
  const openBtn = box.querySelector('#owner-material-open');
  const versionSel = box.querySelector('#owner-material-version');
  const itemsByKey = new Map();
  let currentRel = '';

  const setOpen = (rel) => {
    currentRel = rel || '';
    openBtn.disabled = !currentRel;
    openBtn.title = currentRel ? '用系统默认程序打开原文件' : '当前材料没有可打开的文件';
  };
  setOpen('');
  openBtn.addEventListener('click', async () => {
    if (!currentRel) return;
    try { await window.workbench.filesOpen({ projectId: project.id, rel: currentRel }); }
    catch (e) { status.textContent = '打开失败：' + humanError(e.message); }
  });

  const showCommit = (item) => {
    setOpen('');
    versionSel.hidden = true;
    pathEl.textContent = `提交 ${item.id}${item.at ? ' · ' + ownerMaterialTime(item.at) : ''}`;
    const files = (item.files || []).join('\n') || '（未记录文件清单）';
    preview.textContent = [
      `${item.id} · ${item.title || '（未写标题）'}`,
      `作者：${item.author || '—'} ｜ 时间：${ownerMaterialTime(item.at) || '—'}`,
      item.note ? `备注：${item.note}` : '',
      '', '提交文件：', files
    ].filter(Boolean).join('\n');
  };

  const showFile = async (rel, label) => {
    setOpen(rel);
    pathEl.textContent = label || rel;
    preview.textContent = '读取中…';
    try {
      const r = await window.workbench.ownerMaterial({ projectId: project.id, rel });
      if (!r || r.ok === false) {
        const code = (r && r.code) || 'MATERIAL_READ_FAILED';
        preview.textContent = `不可读（${code}${r && r.message ? '：' + r.message : ''}）\n\n可以点右上角「打开文件」用系统程序查看；其余材料照常可读。`;
        return;
      }
      const text = String(r.text || '');
      preview.textContent = text || '（空文件）';
    } catch (e) {
      preview.textContent = '不可读（' + humanError(e.message) + '）\n\n可以点右上角「打开文件」用系统程序查看。';
    }
  };

  const selectItem = (button, item) => {
    list.querySelectorAll('.owner-material').forEach((el) => el.classList.toggle('active', el === button));
    box._ownerItem = item;
    if (item.kind === 'commit') { showCommit(item); return; }
    const versions = Array.isArray(item.versions) ? item.versions : [];
    if (versions.length > 1) {
      versionSel.hidden = false;
      versionSel.innerHTML = versions.map((row) => `<option value="${esc(row.rel)}"${row.rel === item.rel ? ' selected' : ''}>${row.version ? 'v' + row.version : row.rel} · ${fmtSize(row.size || 0)}</option>`).join('');
    } else {
      versionSel.hidden = true;
      versionSel.innerHTML = '';
    }
    showFile(item.rel, item.rel);
  };
  versionSel.addEventListener('change', () => {
    const item = box._ownerItem;
    if (!item || !item.kind || item.kind !== 'file') return;
    const rel = versionSel.value;
    const picked = (item.versions || []).find((row) => row.rel === rel);
    if (picked) showFile(rel, `${rel} · ${picked.version ? 'v' + picked.version : ''}`);
  });

  const renderGroup = (group) => {
    const head = `<div class="owner-material-group" data-group="${esc(group.key)}">
      <div class="owner-material-group-head"><b>${esc(group.label)}</b><span class="${group.missing ? 'is-missing' : ''}">${group.missing ? '未记录' : group.items.length + ' 项'}</span></div>`;
    if (group.missing) return `${head}<div class="owner-material-missing">${esc(group.reason || '未记录')}</div></div>`;
    const rows = group.items.map((item, idx) => {
      itemsByKey.set(`${group.key}:${idx}`, item);
      const isCommit = item.kind === 'commit';
      const name = isCommit ? (item.title || item.id) : item.name;
      const meta = [
        item.size ? fmtSize(item.size) : '',
        ownerMaterialTime(item.mtime || item.at),
        ownerMaterialVersionLabel(item),
        isCommit ? item.author : ''
      ].filter(Boolean).join(' · ');
      return `<button type="button" class="owner-material" role="treeitem" data-owner-item="${esc(group.key + ':' + idx)}" title="${esc(item.rel || item.id || '')}">
        <span class="owner-material-name">${esc(name)}</span>
        <span class="owner-material-meta">${esc(meta || '—')}</span>
      </button>`;
    }).join('');
    return `${head}${rows}</div>`;
  };

  try {
    const data = await window.workbench.ownerMaterials({ projectId: project.id, requirementId: req && req.id });
    if (!data || data.ok === false) throw new Error((data && (data.message || data.code)) || '材料清单读取失败');
    const groups = Array.isArray(data.groups) ? data.groups : [];
    list.innerHTML = groups.map(renderGroup).join('') || '<div class="owner-materials-empty">未记录：没有可展示的材料。</div>';
    const missingCount = groups.filter((group) => group.missing).length;
    const trq = req && req.trq && typeof req.trq === 'object' ? req.trq : null;
    const trqText = trq
      ? ` ｜ TR-Q：${trq.verdict || '未记录'}${trq.by ? ' · ' + trq.by : ''}${trq.at ? ' · ' + fmtTime(trq.at) : ''}`
      : '';
    status.textContent = `四类材料 · 缺失 ${missingCount} 类（缺失不补造）${trqText}`;
    const firstButton = list.querySelector('.owner-material');
    if (firstButton) {
      const item = itemsByKey.get(firstButton.dataset.ownerItem);
      if (item) selectItem(firstButton, item);
    }
    list.addEventListener('click', (event) => {
      const button = event.target instanceof Element ? event.target.closest('[data-owner-item]') : null;
      if (!button) return;
      const item = itemsByKey.get(button.dataset.ownerItem);
      if (!item) return;
      selectItem(button, item);
    });
  } catch (e) {
    status.textContent = '材料清单读取失败：' + humanError(e.message);
    list.innerHTML = `<div class="owner-material-missing">不可读（${esc(humanError(e.message))}）：决定区仍可提交；不会补造材料。</div>`;
  }
}

async function legacyActionModal(action, reqId) {
  const terms = modeTerms();
  const reqs = legacyRequirements();
  const selectedReq = reqs.find((row) => row.id === reqId) || null;
  const titles = {
    boot: '角色 boot / 必读分层（宪法每轮、铁律按需）',
    'requirement-create': isQuickTeam() ? `新建需求（${terms.reviewer}）` : '新建需求（产品 / 需求分析师）',
    'owner-create': '向 PM 提交需求（Owner）',
    'owner-demand': '向 PM 提交需求（Owner）',
    'requirement-review': terms.review,
    'tech-review': `${terms.techReview}（快速团队）`,
    'owner-review': 'Owner 决定需求',
    dispatch: 'PM 派发开发任务',
    'task-claim': '认领任务',
    'task-done': '完成任务（必须带证据）',
    'dev-submit': '提交开发产出（内部走旧协议 propose）',
    'dev-review': `${terms.devReview}（旧协议 show + review）`,
    'dev-apply': 'PM 签字并 apply',
    'test-dispatch': 'PM 派测试',
    'owner-accept': 'Owner 验收 / 下一次 / 终止',
    iterate: '启动下一次（迭代）',
    terminate: '终止工作流'
  };
  if (isQuickTeam() && action === 'requirement-review') titles[action] = `${terms.review}（快速团队）`;
  if (!isQuickTeam() && action === 'requirement-review') titles[action] = '产品评审需求';
  if (!titles[action]) { toast('未知动作：' + action, 'bad'); return; }
  if (reqId && !selectedReq && !['boot', 'requirement-create', 'owner-create', 'owner-demand', 'iterate', 'terminate'].includes(action)) {
    toast('找不到需求：' + reqId, 'bad');
    return;
  }
  const commandGate = legacyActionCommandGate(action);
  if (!commandGate.ok) {
    toast(commandGate.reason, 'bad');
    return;
  }
  if (action === 'iterate') {
    const iterateGuard = legacyIterateGuard();
    if (!iterateGuard.ok) { toast(iterateGuard.reason, 'bad'); return; }
  }
  const exempt = new Set(['boot', 'requirement-create', 'owner-create', 'owner-demand', 'iterate', 'terminate']);
  const dlg = openModal({
    title: titles[action],
    subtitle: selectedReq ? `${selectedReq.id} · ${selectedReq.title || ''}` : '动作会调用真实后端 IPC；失败时显示后端错误码，不回退本机假成功。',
    icon: '⤳',
    width: 600,
    body: '<div class="modal-error"></div>',
    actions: []
  });

  const renderForm = (restore = null) => {
    const current = (restore && reqs.find((row) => row.id === restore.req)) || selectedReq;
    dlg.body.innerHTML = legacyLegacyDocNote(current) + legacyActionBody(action, current) + '<div class="modal-error"></div>';
    if (restore) legacyRestoreActionForm(restore);
    dlg.foot.innerHTML = '';
    const cancel = makeButton('ghost', '取消');
    const go = makeButton('primary', OWNER_CONFIRM_ACTIONS.has(action) ? 'Owner（我）执行' : '执行');
    const runGo = async () => {
      const form = legacyReadForm();
      const requirement = reqs.find((row) => row.id === form.req) || selectedReq;
      const reqFor = requirement || {};
      if (!reqFor.id && !exempt.has(action)) { dlg.error('先选择一个需求'); return; }
      // Owner（我）一次点击：不再弹确认码输入框，也不调用 owner:challenge / owner:confirm。
      setButtonsBusy([cancel, go], true);
      const ok = await execute(form, { close: dlg.close, error: dlg.error });
      if (!ok) setButtonsBusy([cancel, go], false);
    };
    cancel.addEventListener('click', () => dlg.close());
    go.addEventListener('click', runGo);
    dlg.foot.append(cancel, go);
    // c72e：新建需求先过三轮拷问；确认摘要（或显式跳过）后才解锁建单字段。
    legacyGrillMount(action, { go, runGo, close: dlg.close, error: dlg.error });
    setTimeout(() => dlg.foot.querySelector('.primary')?.focus(), 30);
    if (action === 'owner-review' && current) {
      const box = document.createElement('div');
      box.className = 'owner-decisions-holder';
      box.innerHTML = ownerDecisionsMarkup(current);
      const errBox = dlg.body.querySelector('.modal-error');
      if (errBox) dlg.body.insertBefore(box, errBox);
      else dlg.body.appendChild(box);
      enhanceOwnerReviewModal(dlg, activeProject(), current);
    }
  };

  const showOwnerSuccess = (reqFor, form, result) => {
    dlg.body.innerHTML = legacyOwnerSuccessMarkup(action, reqFor, form, result);
    dlg.foot.innerHTML = '';
    const close = makeButton('primary', '关闭');
    close.addEventListener('click', () => dlg.close());
    dlg.foot.append(close);
    setTimeout(() => close.focus(), 30);
  };

  const execute = async (form, { close, error } = {}) => {
    const requirement = reqs.find((row) => row.id === form.req) || selectedReq;
    const liveGate = legacyActionCommandGate(action);
    if (!liveGate.ok) { error(liveGate.reason); return false; }
    // 闸门判定来自 team.mjs（gate:check）；壳层只负责展示与阻止明显未满足的动作。
    const processGate = gateForAction(action);
    if (processGate && processGate.ok === false) {
      renderGateRejectionInto(dlg.body, processGate, { attempted: action, source: 'team.mjs 闸门判定（gate:check）' });
      error(gateDeniedText(processGate));
      return false;
    }
    if (action === 'iterate') {
      const iterateGuard = legacyIterateGuard();
      if (!iterateGuard.ok) { error(iterateGuard.reason); return false; }
    }
    if (legacyWorkflow() && legacyWorkflow().phase === 'terminated' && action !== 'boot') {
      error('工作流已终止；不再接受推进动作。需要新项目请重新建工作区。');
      return false;
    }
    let payload = {};
    const reqFor = requirement || {};
    if (action === 'boot') {
      payload = { role: form.role };
    } else if (action === 'requirement-create') {
      payload = { role: form.role, title: form.title, acceptance: form.acceptance, priority: form.priority, story: form.story, detail: form.detail };
    } else if (action === 'owner-create') {
      // 向 PM 提交需求（Owner）：需求描述（首行作标题，全文作详情）+ 优先级 + 验收标准（每条一行，可多条）。
      // c72e：先过三轮拷问（或显式跳过），没有确认标记不提交；摘要接到正文末尾。
      if (form.grill !== 'confirmed' && form.grill !== 'skipped') {
        error(NEW_REQ_GRILL.labels.notAnswered);
        return false;
      }
      const description = legacyGrillAppendSummary(form.description);
      if (!description.trim()) { error('先写需求描述'); return false; }
      const lines = description.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      const acceptanceLines = String(form.acceptance || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (!acceptanceLines.length) { error('验收标准不能为空（每条一行）'); return false; }
      payload = {
        title: lines[0] || 'Owner 需求',
        detail: description.slice(0, 2000),
        acceptance: acceptanceLines.join('\n'),
        priority: form.priority || 'P2'
      };
    } else if (action === 'owner-demand') {
      // 向 PM 提交需求（Owner）：owner:demand 只收描述 / 优先级 / 验收标准[]；
      // PM 自动 boot 与建档都在后端完成，界面只做字段校验。c72e：同样先过三轮拷问。
      if (form.grill !== 'confirmed' && form.grill !== 'skipped') {
        error(NEW_REQ_GRILL.labels.notAnswered);
        return false;
      }
      const description = legacyGrillAppendSummary(form.description);
      const criteria = String(form.acceptance || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (!description.trim()) { error('先写需求描述'); return false; }
      if (!criteria.length) { error('验收标准不能为空（每条一行）'); return false; }
      payload = { description, priority: form.priority || 'P2', acceptanceCriteria: criteria };
    } else if (action === 'requirement-review') {
      payload = { requirementId: reqFor.id, role: isQuickTeam() ? 'analyst' : 'product', verdict: form.verdict, comment: form.comment, teamMode: projectTeamMode(activeProject()) };
    } else if (action === 'tech-review') {
      payload = {
        requirementId: reqFor.id, role: 'programmer1', verdict: form.verdict,
        comment: form.comment, evidence: form.evidence, teamMode: projectTeamMode(activeProject())
      };
    } else if (action === 'owner-review') {
      payload = { requirementId: reqFor.id, decision: form.decision, opinion: form.opinion };
    } else if (action === 'dispatch') {
      payload = { requirementId: reqFor.id, role: 'pm', owner: form.owner, detail: form.detail };
    } else if (action === 'task-claim') {
      payload = { requirementId: reqFor.id, role: form.role, taskId: (reqFor.test && reqFor.test.taskId) || (reqFor.dev && reqFor.dev.taskId) || '' };
    } else if (action === 'task-done') {
      payload = { requirementId: reqFor.id, role: form.role, taskId: (reqFor.test && reqFor.test.taskId) || (reqFor.dev && reqFor.dev.taskId) || '', evidence: form.evidence };
    } else if (action === 'dev-submit') {
      payload = {
        requirementId: reqFor.id, role: form.role, taskId: (reqFor.dev && reqFor.dev.taskId) || '',
        title: form.title, rationale: form.rationale, risk: form.risk,
        files: [{ target: form.target, content: form.content, expect: '' }]
      };
    } else if (action === 'dev-review') {
      payload = {
        requirementId: reqFor.id, role: form.role,
        proposalId: (reqFor.dev && reqFor.dev.proposal && reqFor.dev.proposal.id) || '',
        verdict: form.verdict, comment: form.comment
      };
    } else if (action === 'dev-apply') {
      payload = {
        requirementId: reqFor.id, role: 'pm',
        proposalId: (reqFor.dev && reqFor.dev.proposal && reqFor.dev.proposal.id) || '',
        note: form.note
      };
    } else if (action === 'test-dispatch') {
      payload = { requirementId: reqFor.id, role: 'pm', detail: form.detail };
    } else if (action === 'owner-accept') {
      payload = { requirementId: reqFor.id, decision: form.decision, opinion: form.opinion };
    } else if (action === 'iterate' || action === 'terminate') {
      payload = { role: 'pm', opinion: form.opinion };
    }
    if (OWNER_CONFIRM_ACTIONS.has(action)) {
      // Owner（我）一次点击：不再走 owner:challenge / owner:confirm 确认码流程，
      // 只标记 ownerConfirmed 交给后端落账 actor=owner；界面不伪造确认码。
      payload.ownerConfirmed = true;
    }
    if (!reqFor.id && !exempt.has(action)) {
      error('先选择一个需求');
      return false;
    }
    // 与按钮一致：只在缺命令时失败；所需角色未 boot 时先补一次真实 boot，再执行原动作。
    const neededRoles = [];
    if (action === 'requirement-review') neededRoles.push(isQuickTeam() ? 'analyst' : 'product');
    else if (action === 'tech-review') neededRoles.push('programmer1');
    else if (action === 'owner-review') neededRoles.push(isQuickTeam() ? 'analyst' : 'product');
    else if (action === 'owner-accept') {
      neededRoles.push(['accepted', 'rejected'].includes(String(form.decision)) ? 'tester' : 'pm');
    } else if (action === 'owner-create') {
      neededRoles.push('pm');
    } else if (action === 'owner-demand') {
      // owner:demand 由后端自动 boot PM 并代办建档；界面不重复 boot。
    } else if (payload.role && !['boot', 'requirement-create'].includes(action)) {
      neededRoles.push(payload.role);
    }
    try {
      for (const roleId of [...new Set(neededRoles.filter(Boolean))]) {
        await legacyEnsureRoleReadyForAction(roleId, titles[action]);
      }
      // 第一条需求例外：后端 requirement:create 会先取得所选角色 boot 令牌（首次自动 boot），
      // 界面不重复 boot，避免同一动作两份 boot 记录。
      const result = await legacyCallWorkflow(action, payload);
      if (!result || result.ok === false) {
        const failure = new Error(`[${(result && result.code) || 'WORKFLOW_FAILED'}] ${(result && (result.message || result.why)) || '后端拒绝执行'}`);
        failure.code = (result && result.code) || 'WORKFLOW_FAILED';
        throw failure;
      }
      // 先留痕再刷新：缺命令 / 文件契约 / 警告都必须在界面上留下可读记录。
      legacyRecordAction(action, titles[action], result);
      if (result.state) { state = result.state; render(); }
      if (result.snapshot && result.snapshot.ok !== false) {
        const snapshotPhase = legacyDisplayPhase(
          result.snapshot.phase || legacyPhaseFromRequirements(result.snapshot.requirements, result.snapshot.round),
          result.snapshot.requirements
        );
        legacyUi.phaseHint = {
          phase: snapshotPhase,
          round: result.snapshot.round,
          statusKey: (result.snapshot.requirements || []).map((row) => String(row.id || '') + ':' + String(row.status || '')).join('|')
        };
        legacyUi.workflow = {
          ...(legacyUi.workflow || {}),
          ...result.snapshot,
          phase: snapshotPhase
        };
      }
      if (OWNER_CONFIRM_ACTIONS.has(action)) {
        const row = legacyResultRequirement(result, reqFor.id) || {};
        const record = action === 'owner-accept' ? row.ownerAcceptance : row.ownerReview;
        const actor = String((record && record.actor) || OWNER_CONFIRM_ACTOR);
        legacyRememberOwnerConfirmation({
          requirementId: reqFor.id,
          kind: action === 'owner-accept' ? 'accept' : 'owner',
          at: record && record.at,
          decision: form.decision,
          actor
        });
        if (legacyUi.lastAction) legacyUi.lastAction.actor = actor;
        showOwnerSuccess(reqFor, form, result);
      } else {
        close();
      }
      await loadLegacyDocs(true);
      const warnings = Array.isArray(result.warnings) ? result.warnings : [];
      const missingWarn = warnings.find((row) => String(row && row.code || '').includes('LEGACY_COMMAND_MISSING'));
      const legacyInfo = result.legacy && typeof result.legacy === 'object' ? result.legacy : null;
      const contractOnly = Boolean((legacyInfo && legacyInfo.commandAvailable === false && legacyInfo.shellOwned !== true) || missingWarn);
      const shellOwnedResult = Boolean(legacyInfo && legacyInfo.shellOwned);
      const taskDoneIssue = result.requirementTaskDone && result.requirementTaskDone.ok === false;
      const actorNote = OWNER_CONFIRM_ACTIONS.has(action) ? ` · actor=${OWNER_CONFIRM_ACTOR}（本机点击）` : '';
      if (taskDoneIssue) {
        // 外层 ok:true 但旧 task done 失败：必须让用户看到，不能只在结果对象里躺着。
        toast(`${titles[action]}：验收已记录，但旧任务收口失败（${result.requirementTaskDone.code || 'TASK_DONE_FAILED'}）${result.requirementTaskDone.message ? '：' + result.requirementTaskDone.message : ''}；旧任务可能仍未关闭`, 'bad');
      } else if (shellOwnedResult) {
        // 旧命令缺失但壳层真的写了状态：明确 driver，不冒充 team.mjs 成功。
        toast(`${titles[action]}：旧命令「${legacyInfo.command || 'workflow'}」缺失，已由工作台壳层推进（driver=${result.driver || 'workbench'}，已写 工作流.json；不是 team.mjs 执行）`, 'ok');
      } else if (contractOnly) {
        // 旧命令缺失：明确说“文件契约记录”，不写成旧工具成功。
        toast(`${titles[action]}：旧命令${legacyInfo && legacyInfo.command ? '「' + legacyInfo.command + '」' : ''}缺失，已按旧 工作流.json 文件契约记录（不是旧命令成功）`, 'warn');
      } else if (warnings.length) {
        toast(`${titles[action]}：后端返回成功，但有 ${warnings.length} 条警告（${warnings[0].message || warnings[0].code}）`, 'warn');
      } else {
        toast(`已执行：${titles[action]}（后端返回 ${result.code || 'OK'}）${actorNote}`, 'ok');
      }
      // 状态变了：闸门判定与审计立即重读，按钮态随之恢复/更新（不等 5 秒轮询）。
      loadGateCheck({ force: true });
      loadGateAudit({ force: true });
      return true;
    } catch (e) {
      legacyRecordAction(action, titles[action], null, e);
      renderLegacyCapabilities();
      // 动作后无论成败都重新拉一次判定与审计：成功要恢复按钮，失败要留下闸门记录。
      loadGateCheck({ force: true });
      loadGateAudit({ force: true });
      let message = humanError(e.message);
      if (reqFor.origin === 'legacy-doc' && String(e.code || '').includes('REQUIREMENT_NOT_FOUND')) {
        message += '；该旧需求只有正文，后端尚未补建工作流行。界面不会把这次失败显示成成功。';
      }
      const gateView = gateErrorView(e, { attempted: action });
      if (gateView) {
        renderGateRejectionInto(dlg.body, gateView);
        message = `${gateView.code}：${gateView.title}${gateView.next ? '；下一步：' + gateView.next : ''}`;
      }
      error(message);
      return false;
    }
  };

  renderForm();
  return dlg;
}

function legacyReqButton(action, label, req, role, title, gateRole) {
  // 按钮只按“命令是否存在 + 后端闸门判定”禁用；角色未 boot 不再锁按钮，执行前会自动补一次真实 boot，
  // 后端仍会校验该角色的阅读证据（gateRole 是后端真正校验的角色）。
  const checkRole = gateRole === undefined ? role : gateRole;
  const bootReady = !checkRole || legacyRoleReady(checkRole);
  const commandGate = legacyActionCommandGate(action);
  const processGate = gateForAction(action);
  const gateDenied = Boolean(processGate && processGate.ok === false);
  const ready = commandGate.ok && !gateDenied;
  const autoBoot = checkRole && !bootReady;
  const why = gateDenied
    ? gateDeniedText(processGate)
    : (!commandGate.ok
      ? commandGate.reason
      : (autoBoot
        ? `${roleById(checkRole).name} 未 boot/未读全；点击不会禁用，执行会先自动 boot，再由后端校验（${title || action}）`
        : (title || '调用真实 workflow IPC')));
  const note = gateDenied
    ? `<span class="legacy-req-gate" title="${esc(why)}">闸门 ${esc(processGate.gate || processGate.code || '拒绝')}：${esc(processGate.title || processGate.code || '未满足')}</span>`
    : (!commandGate.ok
      ? ((commandGate.missing || []).length
        ? `<span class="legacy-req-noaction" title="${esc(commandGate.reason)}">命令缺失：${esc(commandGate.missing.join('、'))}</span>`
        : `<span class="legacy-req-noaction" title="${esc(commandGate.reason)}">旧命令未核验：${esc((commandGate.unknown || []).join('、') || '能力待核验')}</span>`)
      : (autoBoot ? `<span class="legacy-req-autoboot" title="${esc(why)}">未 boot · 点击自动 boot</span>` : ''));
  const gateBlocked = gateDenied && commandGate.ok;
  return `<button type="button" class="ghost small${gateBlocked ? ' gate-blocked' : ''}" data-legacy-req-action="${esc(action)}" data-req-id="${esc(req.id)}" ${ready || gateBlocked ? '' : 'disabled'}${gateBlocked ? ' data-gate-blocked="1" data-gate-action="' + esc(action) + '" aria-disabled="true"' : ''} title="${esc(why)}">${esc(label)}</button>${note}`;
}

function legacyReqActions(req) {
  const terms = modeTerms();
  const status = String(req.status || '');
  const dev = req.dev || {};
  const test = req.test || {};
  const buttons = [];
  if (legacyWorkflow() && legacyWorkflow().phase === 'terminated') {
    return '<span class="legacy-req-noaction">工作流已终止：历史需求只读，不再接受评审 / 派单 / 开发 / 测试 / 验收动作</span>';
  }
  const reviewRole = isQuickTeam() ? 'analyst' : 'product';
  if (['review', 'rejected'].includes(status)) {
    if (req.voteRejection) buttons.push(`<span class="legacy-req-chip warn" title="投票驳回：需求仍可重新评审/迭代，不会锁死当前">可迭代</span>`);
    buttons.push(legacyReqButton('requirement-review', req.voteRejection ? '重新评审' : terms.review, req, reviewRole,
      `requirement:review（${isQuickTeam() ? `快速团队由${terms.reviewer}评审；通过后进入 Owner` : terms.reviewer}）`));
  } else if (status === 'approved') {
    // Owner 是外部角色不跑 boot；后端 Owner 闸门以当前模式的评审人阅读证据为前提。
    // Owner（我）一次点击：通过/跳过/打回直接调用后端，不再弹确认码输入框。
    buttons.push(`<span class="legacy-req-chip ok" title="${isQuickTeam() ? 'Fast 后端壳收口：一次点击直接调用 requirement:owner，不依赖旧 owner 命令' : 'Owner（我）一次点击：直接调用 requirement:owner，无需二次确认'}">Owner（我）一次点击</span>`);
    buttons.push(legacyOwnerQuickButton('review', req, 'approved', 'Owner（我）通过'));
    buttons.push(legacyOwnerQuickButton('review', req, 'skipped', 'Owner（我）跳过'));
    buttons.push(legacyOwnerQuickButton('review', req, 'rejected', 'Owner（我）打回'));
    buttons.push(legacyReqButton('owner-review', '写意见再决定…', req, '', isQuickTeam()
      ? 'requirement:owner（Owner 决定；后端校验需求分析师的阅读证据）'
      : 'requirement:owner（Owner 决定；后端校验产品设计师已 boot/读全）', reviewRole));
  } else if (status === 'tech_review') {
    // Fast：Owner 之后、PM 派单之前，由程序员A做技术评审。
    buttons.push(`<span class="legacy-req-chip ok" title="Technical Review：通过后需求状态变为 ready，可派单">TR</span>`);
    buttons.push(legacyReqButton('tech-review', `TR · ${terms.techReview}`, req, 'programmer1',
      `requirement:tech-review（快速团队：程序员A判断实现可行性与风险；通过才 ready 可派单）`));
  } else if (status === 'ready') {
    buttons.push(`<span class="legacy-req-chip ok" title="后端需求状态 ready：技术评审已通过，可派单">ready</span>`);
    buttons.push(legacyReqButton('dispatch', 'PM 派单', req, 'pm',
      isQuickTeam() ? `requirement:dispatch（PM）· ${terms.techReview}已通过` : 'requirement:dispatch（PM）'));
    if (isQuickTeam()) buttons.push(`<span class="legacy-req-chip ok">${esc(terms.techReview)}已通过</span>`);
  } else if (status === 'dev') {
    const owner = dev.claimBy || (req.dispatch && req.dispatch.owner) || 'programmer1';
    if (!dev.claimBy) buttons.push(legacyReqButton('task-claim', '开发认领', req, owner, `task:claim（${roleById(owner).name}）`));
    else if (!dev.proposal) buttons.push(legacyReqButton('dev-submit', '提交开发产出', req, owner, `dev:submit（${roleById(owner).name}）`));
    else if (!dev.peerReview || dev.peerReview.status !== 'approved' || (isQuickTeam() && String(dev.peerReview.by || '') === 'pm')) {
      const author = String((dev.proposal && dev.proposal.author) || owner);
      // Fast 没有程序员B：由测试人员独立复核；PM 在签字 apply 时复核。
      // 团队工具不允许 PM 既当唯一评审又当唯一签字人，所以复核不能只由 PM 做。
      const reviewer = isQuickTeam() ? 'tester' : (author === 'programmer1' ? 'programmer2' : 'programmer1');
      buttons.push(legacyReqButton('dev-review', isQuickTeam() ? `${terms.devReview}（测试人员）` : '互审（' + roleById(reviewer).name + '）', req, reviewer,
        isQuickTeam() ? `dev:review（快速团队由测试人员独立${terms.devReview}；不是程序员A自审；PM 在 apply 时复核并签字）` : `dev:review（${roleById(reviewer).name}）`));
    } else if (!dev.applied) {
      buttons.push(legacyReqButton('dev-apply', 'PM 签字/apply', req, 'pm', 'dev:apply（PM）'));
    } else {
      buttons.push(legacyReqButton('task-done', '完成开发任务', req, owner, `task:done（${roleById(owner).name}）`));
    }
  } else if (status === 'dev_review') {
    const author = String((dev.proposal && dev.proposal.author) || '');
    const reviewer = isQuickTeam() ? 'tester' : (author === 'programmer1' ? 'programmer2' : 'programmer1');
    // Fast：PM 单独复核不满足团队工具的 apply 闸门（PM 不能是唯一评审+唯一签字人），
    // 需要测试人员再独立复核一次；因此 by=pm 时仍显示复核按钮。
    const needsSecondReviewer = isQuickTeam() && String((dev.peerReview && dev.peerReview.by) || '') === 'pm';
    if (!dev.peerReview || dev.peerReview.status !== 'approved' || needsSecondReviewer) {
      buttons.push(legacyReqButton('dev-review', isQuickTeam() ? `${terms.devReview}（测试人员）` : '互审（' + roleById(reviewer).name + '）', req, reviewer,
        isQuickTeam() ? `dev:review（快速团队由测试人员独立${terms.devReview}；不是程序员A自审；PM 在 apply 时复核并签字）` : `dev:review（${roleById(reviewer).name}）`));
    } else if (!dev.applied) {
      buttons.push(legacyReqButton('dev-apply', 'PM 签字/apply', req, 'pm', 'dev:apply（PM）'));
    }
    if (dev.applied) buttons.push(legacyReqButton('task-done', '完成开发任务', req, dev.claimBy || 'programmer1', 'task:done'));
  } else if (status === 'dev_done') {
    buttons.push(legacyReqButton('test-dispatch', '派测试', req, 'pm', 'test:dispatch（PM）'));
    if (!dev.doneAt) buttons.push(legacyReqButton('task-done', '完成开发任务', req, dev.claimBy || 'programmer1', 'task:done'));
  } else if (status === 'test') {
    if (!test.claimBy) buttons.push(legacyReqButton('task-claim', '测试认领', req, 'tester', 'task:claim（测试人员）'));
    buttons.push(legacyReqButton('task-done', '完成测试', req, 'tester', 'task:done（测试人员，必须带证据）'));
  } else if (status === 'test_done') {
    // 后端 ownerAccept：通过/打回校验 tester 的阅读证据；转下一轮/终止校验 PM 的阅读证据。
    // Owner（我）一次点击：验收通过/打回直接调用后端；转下一轮/终止保留表单（需写意见）。
    const testerReady = legacyRoleReady('tester');
    const pmReady = legacyRoleReady('pm');
    buttons.push(`<span class="legacy-req-chip ok" title="${isQuickTeam() ? 'Fast 后端壳收口：验收通过/打回一次点击直接调用 owner:accept，不依赖旧 owner 命令' : 'Owner（我）一次点击：直接调用 owner:accept，无需二次确认'}">Owner（我）一次点击</span>`);
    buttons.push(legacyOwnerQuickButton('accept', req, 'accepted', 'Owner（我）验收通过'));
    buttons.push(legacyOwnerQuickButton('accept', req, 'rejected', 'Owner（我）打回'));
    buttons.push(legacyReqButton('owner-accept', '转下一次 / 终止…', req, '',
      `owner:accept（通过/打回需 tester 已 boot/读全；转下一次/终止需 PM 已 boot/读全。当前 tester ${testerReady ? '就绪' : '未就绪'} · PM ${pmReady ? '就绪' : '未就绪'}；未就绪时执行前自动 boot 对应角色）`,
      ''));
    if (!testerReady || !pmReady) buttons.push('<span class="legacy-req-autoboot">按验收决定自动 boot tester / PM；按钮只在旧命令缺失或未核验时禁用</span>');
  }
  if (!buttons.length) buttons.push('<span class="legacy-req-noaction">已收口 / 无待办动作</span>');
  return buttons.join('');
}

function legacyReqMeta(req) {
  const terms = modeTerms();
  const parts = [];
  const reviewLabel = terms.review;
  const product = req.productReview
    ? `${reviewLabel} ${req.productReview.verdict || '未写'} · ${legacyActorText(req.productReview.by, 'actor ' + (req.productReview.actor || '未记录'))}`
    : `${reviewLabel} 未记录`;
  const owner = req.ownerReview
    ? legacyOwnerReviewText(req.ownerReview, req.id)
    : 'Owner 尚未决定 · 待 Owner（无记录）';
  const dispatch = req.dispatch
    ? `派单 → ${roleById(req.dispatch.owner).name} · ${legacyActorText(req.dispatch.by, 'actor ' + (req.dispatch.actor || '未记录'))} · task=${req.dispatch.taskId || '未写'}`
    : '派单 未记录';
  const tech = req.techReview
    ? `TR · ${terms.techReview} ${req.techReview.verdict || '未写'} · ${legacyActorText(req.techReview.by, 'actor ' + (req.techReview.actor || '未记录'))}${req.techReview.comment ? ' · ' + req.techReview.comment : ''}`
    : (isQuickTeam() ? `TR · ${terms.techReview} 未记录` : '');
  const dev = req.dev ? `开发 ${roleById(req.dev.claimBy || (req.dispatch && req.dispatch.owner) || 'programmer1').name}`
    + `${req.dev.proposal ? ' · 开发产出 ' + req.dev.proposal.id : ' · 未提交开发产出'}`
    + `${req.dev.peerReview ? ` · ${terms.devReview} ` + req.dev.peerReview.status + ' · ' + legacyActorText(req.dev.peerReview.by, 'actor ' + (req.dev.peerReview.actor || '未记录')) : ''}`
    + `${req.dev.applied ? ' · applied ' + (req.dev.commitId || '') : ''}` : '开发 未记录';
  const test = req.test ? `测试 ${req.test.taskId || '未写'}`
    + `${req.test.claimBy ? ' · claim ' + legacyActorText(req.test.claimBy, 'actor 未记录') : ''}`
    + `${req.test.doneAt ? ' · done ' + fmtTime(req.test.doneAt) : ''}` : '测试 未记录';
  const accept = req.ownerAcceptance
    ? legacyOwnerRecordText(req.ownerAcceptance, 'Owner 验收', req.id, 'accept')
    : '验收 未记录';
  const vote = req.voteRejection && String(req.status || '') === 'rejected'
    ? `投票驳回 可迭代 · ${req.voteRejection.reason || req.voteRejection.voteId || '已记录'}${
      req.voteRejection.at ? ' · ' + fmtTime(req.voteRejection.at) : ''}`
    : '';
  parts.push(product, owner, tech, vote, dispatch, dev, test, accept);
  return parts.filter(Boolean);
}

function legacyRequirementCard(req) {
  const priority = req.priority || 'P2';
  const round = req.round || 1;
  const origin = req.origin === 'owner' ? 'Owner 新需求'
    : (req.origin === 'legacy-doc' ? '旧正文需求' : '角色需求');
  const active = legacyActiveRequirement();
  // F-9fbe-4：卡片小字只认快照 ledger 字段（ledgerFork / ledgerInFlight）；
  // 旧算法只在「快照连字段都没有」时回退，且文案自报「旧判据」——
  // 不再无条件拿 workflow.status × taskStatus 给每条需求贴「工作流未收口」（返工在途会被误读成分叉）。
  const ledgerNote = ledgerRowNote(req);
  const ownerView = legacyReqOwnerView(req);
  const ownerChip = String(req.status) === 'approved' && ownerView.status === 'none'
    ? '<span class="legacy-req-chip warn" title="PM 派单要求需求的 ownerReview 为 approved / skipped">Owner 未决定（派单闸门）</span>'
    : '';
  return `<article class="legacy-req ${active && active.id === req.id ? 'is-active' : ''}" data-req-id="${esc(req.id)}">
    <div class="legacy-req-head">
      <div class="legacy-req-title"><b>${esc(req.id)}</b><span>${esc(req.title || '未写标题')}</span></div>
      <div class="legacy-req-badges">
        <span class="badge ${req.status === 'accepted' ? 'badge-approved' : (req.status === 'rejected' || req.status === 'terminated' ? 'badge-rejected' : 'badge-skipped')}">${esc(legacyReqStatus(req))}</span>
        <span class="legacy-req-chip">${esc(priority)}</span>
        <span class="legacy-req-chip">需求</span>
        <span class="legacy-req-chip">${esc(origin)}</span>
        ${req.origin === 'legacy-doc' ? '<span class="legacy-req-chip warn" title="旧编号需求：只有需求正文、没有工作流行；评审 / Owner / 验收会按正文解析并补建行，4 位编号原样保留">旧编号可评审</span>' : ''}
        ${ownerChip}
      </div>
    </div>
    <div class="legacy-req-facts">
      ${legacyReqMeta(req).map((text) => `<span>${esc(text)}</span>`).join('')}
    </div>
    ${ledgerNote.label ? `<div class="legacy-req-ledger ${esc(ledgerNote.kind)}" data-ledger-card="${esc(ledgerNote.kind)}" data-panel-level="${esc(ledgerNote.level)}">${esc(ledgerNote.label)}</div>` : ''}
    <div class="legacy-req-actions">${legacyReqActions(req)}</div>
  </article>`;
}

function syncLegacyGlobalReqButtons(terminated) {
  const pmReady = legacyRoleReady('pm');
  const ownerDemandGate = legacyActionCommandGate('owner-demand');
  const wf = legacyWorkflow();
  // “向 PM 提交需求（Owner）”只在项目开始 / 评审 / 迭代阶段显示；
  // 开发/测试等在办阶段与终止后隐藏，不弹确认码、也不占入口。
  const phase = wf ? String(wf.phase || '') : '';
  const ownerDemandVisible = ['', 'idle', 'requirement', 'requirement_review', 'owner_review', 'iteration'].includes(phase);
  document.querySelectorAll('[data-legacy-req-action="owner-demand"]').forEach((button) => {
    button.hidden = !ownerDemandVisible;
    if (!ownerDemandVisible) return;
    button.disabled = terminated || !ownerDemandGate.ok;
    button.title = terminated ? (legacyTerminateReasonText() || '工作流已终止')
      : (!ownerDemandGate.ok ? ownerDemandGate.reason
        : (pmReady ? '向 PM 提交需求（Owner）· owner:demand 由 PM 自动 boot 代办建档'
          : 'PM 未 boot；owner:demand 会由后端自动 boot PM 后代办建档'));
  });
}

function renderLegacyRequirements() {
  const box = $('#legacy-requirements');
  if (!box) return;
  const badge = $('#legacy-req-badge');
  const wf = legacyWorkflow();
  // 即使 workflow 状态读取失败，也不能让“新建需求”保持可点；命令能力未知时先禁用并说明。
  syncLegacyGlobalReqButtons(Boolean(wf && wf.phase === 'terminated'));
  if (legacyUi.workflowError) {
    box.innerHTML = `<div class="empty-row">工作流状态读取失败：${esc(legacyUi.workflowError.code)} · ${esc(legacyUi.workflowError.message)}</div>`;
    if (badge) { badge.textContent = '读取失败'; badge.className = 'badge badge-rejected'; }
    return;
  }
  if (!wf) {
    box.innerHTML = '<div class="empty-row">工作流状态未读取；点「刷新必读」重试。</div>';
    if (badge) { badge.textContent = '未读取'; badge.className = 'badge muted-badge'; }
    return;
  }
  const reqs = legacyRequirements();
  if (badge) {
    badge.textContent = `${reqs.length} 需求 · phase ${wf.phase || 'idle'}`;
    badge.className = 'badge ' + (['accepted', 'iteration'].includes(wf.phase) ? 'badge-approved' : (wf.phase === 'terminated' ? 'badge-rejected' : 'muted-badge'));
  }
  if (!reqs.length) {
    box.innerHTML = '<div class="empty-row">还没有需求。Owner 点「向 PM 提交需求（Owner）」提需求，由 PM 代办建档；产品 / 需求分析师不再建需求，只做拆解 / 评审。</div>';
  } else {
    box.innerHTML = reqs.slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))).map(legacyRequirementCard).join('');
  }
  syncLegacyGlobalReqButtons(Boolean(wf && wf.phase === 'terminated'));
}

// ── R-1dfb（卷 §六）：团队台活跃度三列 —— 只显示 team:role-activity 的返回值 ─────────────
// 口径：主进程统一算（团队/工具/lib/ops.mjs → computeRoleActivity）+ 5 分钟缓存；
// 渲染层**不读文件、不调 git、不自己推活跃度**（AC5 静态断言），只把返回字段按 HH:MM 显示。
// 刷新：团队台每次渲染调一次；返回 cached 时不再另起定时轮询（沿用团队台既有刷新节奏）。
const LEGACY_ACTIVITY_COLUMNS = [
  { key: 'commit', label: '最近提交', field: 'commitAt', fallbackReason: 'no-submit-record', hint: '团队提交记录（提交/*.json），非 git 代码提交' },
  { key: 'file', label: '最近文件写入', field: 'fileAt', fallbackReason: 'no-write-in-window', hint: '角色目录内文件 max mtime（排除索引/审计/备份/派单生成物）' },
  { key: 'wake', label: '最后成功唤醒', field: 'wakeAt', fallbackReason: 'no-wake-ok', hint: '唤醒.jsonl 里 to=<角色> 且 ok:true 的最后一条' },
  // R-9674（AC5①/②）：第 4 列「最近活动」——时间取 lastActivityAt（HH:MM），摘要取 lastActivityText（textField）。
  // 渲染走自定义分支：单元格＝`<HH:MM> <摘要>`，title 给 ISO + 来源 + 全量摘要（不能靠 field 硬映射，摘要在 field 里没有落点）。
  { key: 'lastActivity', label: '最近活动', field: 'lastActivityAt', textField: 'lastActivityText', sourceField: 'lastActivitySource', fallbackReason: 'no-last-activity', hint: '三源优先级：快照 lastEventAt/lastOkAt → 唤醒.jsonl 最近一条 → 任务 done（主进程算，与 #session-live-summary 同口径）' }
];
// R-9674：最近活动来源中文（title 用）
const LEGACY_ACTIVITY_SOURCE_LABEL = { snapshot: '快照', wake: '唤醒日志', task: '任务', none: '无来源' };
const LEGACY_ACTIVITY_STATE = { roles: {}, readAt: '', cached: false, loading: false, pending: null, error: null, lastCallAt: 0 };

function legacyActivityTimeText(value) {
  const raw = String(value || '').trim();
  if (!raw) return '';
  const ms = Date.parse(raw);
  if (!Number.isFinite(ms)) return '';
  const date = new Date(ms);
  const pad = (n) => String(n).padStart(2, '0');
  const today = new Date();
  const sameDay = date.getFullYear() === today.getFullYear()
    && date.getMonth() === today.getMonth() && date.getDate() === today.getDate();
  return sameDay
    ? `${pad(date.getHours())}:${pad(date.getMinutes())}`
    : `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}`;
}

// 行状态：idle 黄标 / unknown 灰 / active 正常；红标只认后端 escalation 级（返回里没有就不假装）。
function legacyActivityRoleView(roleId) {
  const role = String(roleId || '');
  const row = (LEGACY_ACTIVITY_STATE.roles && LEGACY_ACTIVITY_STATE.roles[role]) || null;
  const verdict = row ? String(row.verdict || '') : '';
  const state = verdict === 'active' ? 'active' : (verdict === 'idle' ? 'idle' : 'unknown');
  const levelRaw = row ? String(row.level || (row.escalated === true ? 'escalate' : 'none')) : 'none';
  const level = ['notice', 'escalate', 'force'].includes(levelRaw) ? levelRaw : 'none';
  const reasons = row && Array.isArray(row.unknownReasons) ? row.unknownReasons.map((item) => String(item)) : [];
  if (!row) reasons.push(LEGACY_ACTIVITY_STATE.error ? `activity-error:${LEGACY_ACTIVITY_STATE.error}` : 'activity-not-loaded');
  const cellClass = (level === 'escalate' || level === 'force')
    ? 'bad'
    : (state === 'idle' ? 'warn' : (state === 'unknown' ? 'muted' : 'ok'));
  const cells = {};
  for (const col of LEGACY_ACTIVITY_COLUMNS) {
    const iso = row ? String(row[col.field] || '') : '';
    // R-9674：声明了 textField 的列走自定义渲染——单元格 = `<HH:MM> <摘要>`，title = ISO + 来源 + 全量摘要
    if (col.textField) {
      const text = legacyActivityTimeText(iso);
      const summary = row ? String(row[col.textField] || '') : '';
      if (text && summary) {
        const src = row ? String(row[col.sourceField] || '') : '';
        cells[col.key] = {
          text: `${text} ${summary}`,
          title: `${col.label}：${iso} · 来源 ${LEGACY_ACTIVITY_SOURCE_LABEL[src] || src || '未知'} · ${summary} · ${col.hint}`,
          cls: cellClass,
        };
        continue;
      }
      const why = new Set([col.fallbackReason]);
      if (state !== 'active') for (const reason of reasons) why.add(reason);
      cells[col.key] = { text: '未知', title: `${col.label}：未知 · ${Array.from(why).join('、')} · ${col.hint}`, cls: cellClass };
      continue;
    }
    const text = legacyActivityTimeText(iso);
    if (text) {
      cells[col.key] = { text, title: `${col.label}：${iso} · ${col.hint}`, cls: cellClass };
      continue;
    }
    const why = new Set([col.fallbackReason]);
    if (state !== 'active') for (const reason of reasons) why.add(reason);
    cells[col.key] = { text: '未知', title: `${col.label}：未知 · ${Array.from(why).join('、')} · ${col.hint}`, cls: cellClass };
  }
  return { state, level, cells, reasons };
}

function legacyActivityPaint() {
  if (typeof document === 'undefined') return;
  const rows = document.querySelectorAll('[data-activity-role]');
  for (const rowEl of rows) {
    const view = legacyActivityRoleView(String(rowEl.dataset.activityRole || ''));
    rowEl.setAttribute('data-activity-state', view.state);
    rowEl.setAttribute('data-activity-level', view.level);
    for (const col of LEGACY_ACTIVITY_COLUMNS) {
      const cell = rowEl.querySelector(`[data-activity-${col.key}]`);
      if (!cell) continue;
      const value = view.cells[col.key];
      cell.textContent = value.text;
      cell.title = value.title;
      cell.className = value.cls;
    }
  }
}

function legacyActivityRefresh(force) {
  const bridge = (typeof window !== 'undefined' && window.workbench)
    ? window.workbench
    : ((typeof window !== 'undefined' && window.api) ? window.api : null);
  if (!bridge || typeof bridge.teamRoleActivity !== 'function') {
    LEGACY_ACTIVITY_STATE.error = 'NO_IPC';
    return Promise.resolve(null);
  }
  if (LEGACY_ACTIVITY_STATE.loading && LEGACY_ACTIVITY_STATE.pending) return LEGACY_ACTIVITY_STATE.pending;
  const hasData = Object.keys(LEGACY_ACTIVITY_STATE.roles || {}).length > 0;
  // 渲染很频繁时最多 3 秒问一次 IPC（主进程侧另有 5 分钟缓存），不引入任何定时器。
  if (!force && hasData && (Date.now() - LEGACY_ACTIVITY_STATE.lastCallAt) < 3000) return Promise.resolve(null);
  const project = (typeof activeProject === 'function') ? activeProject() : null;
  LEGACY_ACTIVITY_STATE.loading = true;
  LEGACY_ACTIVITY_STATE.lastCallAt = Date.now();
  const pending = Promise.resolve(bridge.teamRoleActivity({ projectId: project ? project.id : '', force: Boolean(force) }))
    .then((result) => {
      const res = result || {};
      if (res.ok === false) {
        LEGACY_ACTIVITY_STATE.error = `${res.code || 'ROLE_ACTIVITY_FAILED'}${res.message ? '：' + res.message : ''}`;
        return res;
      }
      LEGACY_ACTIVITY_STATE.error = null;
      LEGACY_ACTIVITY_STATE.roles = (res.roles && typeof res.roles === 'object') ? res.roles : {};
      LEGACY_ACTIVITY_STATE.readAt = String(res.readAt || '');
      LEGACY_ACTIVITY_STATE.cached = Boolean(res.cached);
      return res;
    })
    .catch((error) => {
      LEGACY_ACTIVITY_STATE.error = String((error && error.message) || error).slice(0, 200);
      return null;
    })
    .finally(() => {
      LEGACY_ACTIVITY_STATE.loading = false;
      LEGACY_ACTIVITY_STATE.pending = null;
      legacyActivityPaint();
    });
  LEGACY_ACTIVITY_STATE.pending = pending;
  return pending;
}

// R-c9ac（快照 v2）：团队台行 live 四列——数据源＝会话排队面板模型（window.__sqModel；面板每次重绘广播
// awb:session-queue-model 事件后这里跟着刷新），**不新增轮询通道、不另算口径**：五态/秒表/最近事件/停滞
// 全部取同一份模型 rows[].live，与 #session-live-section 逐字段同口径。
const LEGACY_SQ_LIVE_COLUMNS = [
  { key: 'live', attr: 'data-role-live', label: '五态' },
  { key: 'think', attr: 'data-role-think', label: '思考时长' },
  { key: 'lastEvent', attr: 'data-role-last-event', label: '最近事件' },
  { key: 'stall', attr: 'data-role-stall', label: '停滞' },
];
const LEGACY_SQ_LIVE_LABEL = { approval: '待审批', blocked: '阻塞', thinking: '思考中', queued: '排队', idle: '空闲', unknown: '未接入' };

function legacySqLiveModel() {
  try {
    return (typeof window !== 'undefined' && typeof window.__sqModel === 'function') ? window.__sqModel() : null;
  } catch (e) { return null; }
}

function legacySqLiveViewOf(roleId) {
  const model = legacySqLiveModel();
  const row = (model && Array.isArray(model.rows))
    ? model.rows.find((item) => String((item && item.role) || '') === String(roleId))
    : null;
  const live = (row && row.live && typeof row.live === 'object') ? row.live : null;
  const stateKey = live ? String(live.state || 'unknown') : 'unknown';
  const label = (live && live.stateText) || LEGACY_SQ_LIVE_LABEL[stateKey] || '未接入';
  const stall = Boolean(live && live.stall && live.stall.stall);
  const stallText = (live && live.stall && live.stall.text) ? String(live.stall.text) : '';
  const redish = stateKey === 'approval' || stateKey === 'blocked';
  return {
    live: {
      text: label,
      title: `五态（与 #session-live-section 同口径）：${label}`,
      cls: stateKey === 'unknown' ? 'muted' : (redish ? 'warn' : 'ok'),
    },
    think: {
      text: (live && live.thinkText) || '—',
      title: stateKey === 'thinking'
        ? ((live && live.runningSince) ? `思考开始：${live.runningSince}` : '缺 runningSince：显示「—」，不用当前时间伪造开始时刻')
        : '非 thinking 行显示「—」',
      cls: 'muted',
    },
    lastEvent: {
      text: (live && live.lastEventText) || '—',
      title: (live && live.lastEventAt) ? `最近事件（绝对时间）：${live.lastEventAt}` : '未记录最近事件（显示「—」，不按 0 处理）',
      cls: 'muted',
    },
    stall: {
      text: stall ? 'true' : 'false',
      title: stallText || '停滞判据：now - lastEventAt ≥ 阈值（ui.sessionQueue.stallMs，默认 600000ms）；lastEventAt 缺失或 unknown 不判停滞',
      cls: stall ? 'warn' : 'muted',
    },
  };
}

function legacySqLivePaint() {
  const rows = Array.from(document.querySelectorAll('.legacy-team-row[data-activity-role]'));
  for (const rowEl of rows) {
    const view = legacySqLiveViewOf(rowEl.getAttribute('data-activity-role') || '');
    for (const col of LEGACY_SQ_LIVE_COLUMNS) {
      const cell = rowEl.querySelector(`[${col.attr}]`);
      if (!cell) continue;
      const value = view[col.key];
      cell.textContent = value.text;
      cell.title = value.title;
      cell.className = value.cls;
    }
  }
}

if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
  window.addEventListener('awb:session-queue-model', () => legacySqLivePaint());
}

function renderLegacyTeamGate() {
  const box = $('#team-legacy-gate');
  if (!box) return;
  const p = activeProject();
  const badge = $('#team-legacy-badge');
  const actorBox = $('#team-actor-list');
  if (!p) {
    box.innerHTML = '<div class="empty-row">先选择工作区。</div>';
    if (badge) badge.className = 'badge badge-rejected';
    if (actorBox) actorBox.innerHTML = '<div class="actor-empty">还没有工作区。</div>';
    return;
  }
  const ready = legacyDocumentsReady();
  const sessions = p.sessions || {};
  // 97db AC1（PM M-20261119-040303-c14d7f）：名册全空时团队台「六角色旧行」必须 0 行（团队台 0 行口径）。
  const rosterAllEmptyView = !Array.isArray(memberStatesCache) || memberStatesCache.length === 0;
  const rows = (rosterAllEmptyView ? [] : teamRoles(p)).map((role) => {
    const card = legacyHas(legacyRoleCardRel(role));
    const index = legacyHas(legacyRoleIndexRel(role));
    // B-4baa 顺手修复：v42 三态改造在这里漏了 cardState，团队台整块渲染会报 “cardState is not defined”。
    const cardState = legacyRoleCardState(role);
    const session = sessions[role.id];
    const boot = legacyBootFor(role.id);
    const bootCtl = legacyBootControl(role.id);
    // R-1dfb（卷 §六）：三列值只取 team:role-activity 的返回（缓存里的那份），渲染层不自算；
    // 行上 data-activity-state ∈ idle|active|unknown；红标只认后端 escalation 级（data-activity-level）。
    const act = legacyActivityRoleView(role.id);
    const actCells = LEGACY_ACTIVITY_COLUMNS.map((col) => {
      const cell = act.cells[col.key];
      // R-9674：最近活动列（textField）固定 56px 并 ellipsis，全量摘要只在 title（1280 不横向滚动）
      const extra = col.textField ? ';max-width:56px;overflow:hidden;text-overflow:ellipsis' : '';
      return `<span class="${esc(cell.cls)}" data-activity-${esc(col.key)} style="flex:0 0 auto;min-width:56px;text-align:right;white-space:nowrap${extra}" title="${esc(cell.title)}">${esc(cell.text)}</span>`;
    }).join('');
    // R-c9ac：会话实时四列（[data-role-live]/[data-role-think]/[data-role-last-event]/[data-role-stall]），
    // 与 #session-live-section 同口径；不动既有 data-activity-* 字段。
    const sqLive = legacySqLiveViewOf(role.id);
    const sqLiveCells = LEGACY_SQ_LIVE_COLUMNS.map((col) => {
      const cell = sqLive[col.key];
      return `<span class="${esc(cell.cls)}" ${esc(col.attr)} style="flex:0 0 auto;min-width:52px;text-align:right;white-space:nowrap" title="${esc(cell.title)}">${esc(cell.text)}</span>`;
    }).join('');
    return `<div class="legacy-team-row" data-activity-role="${esc(role.id)}" data-activity-state="${esc(act.state)}" data-activity-level="${esc(act.level)}">
      <span class="legacy-team-dot" style="--role-color:${esc(role.color)}"></span>
      <b>${esc(role.name)}</b>
      <code>${esc(legacyRoleDirName(role))}/</code>
      <span class="${cardState.key === 'ok' ? 'ok' : (cardState.key === 'unmapped' ? 'warn' : 'bad')}" title="${esc(cardState.title)}">角色卡 ${esc(cardState.label)}</span>
      <span class="${index ? 'ok' : 'bad'}">索引 ${index ? '有' : '缺'}</span>
      <span class="${session ? 'ok' : 'warn'}">${session ? '会话已映射' : '无会话'}</span>
      <span class="${boot.ready ? 'ok' : (boot.roundMismatch ? 'warn' : 'muted')}" title="${esc(boot.missing.join('、') || boot.at || '')}">${esc(boot.label)}</span>
      ${actCells}
      ${sqLiveCells}
      <button type="button" class="legacy-boot-mini" data-legacy-boot="${esc(role.id)}" ${bootCtl.disabled ? 'disabled' : ''} title="${esc(bootCtl.title)}">${esc(bootCtl.text)}</button>
    </div>`;
  }).join('');
  // 列头（卷 §六写死文案）；tooltip 明说「提交」是团队提交记录，不是 git 代码提交（卷 §二）。
  const activityHead = `<div class="legacy-team-activity-head" style="display:flex;gap:5px;justify-content:flex-end;padding:0 4px;color:var(--muted);font-size:8px" title="团队提交记录（提交/*.json），非 git 代码提交">${LEGACY_ACTIVITY_COLUMNS.map((col) => `<span data-activity-head="${esc(col.key)}" style="flex:0 0 auto;min-width:56px;text-align:right;white-space:nowrap">${esc(col.label)}</span>`).join('')}</div>`;
  box.innerHTML = `<div class="legacy-read-order">必读分层：<b>团队宪法（唯一最高，每轮） → 项目信息 → 角色卡 → 其他人文档（铁律按需避坑）</b>（角色目录 ${ready.dirs}/${ready.total} · 角色卡 ${ready.cards}/${ready.total} · 文件索引 ${ready.indexes}/${ready.total} · 其他文档 ${ready.others} 份 · 项目索引 ${ready.index ? '有' : '缺'}）</div>
    <div class="legacy-team-docs">${LEGACY_PROJECT_DOCS.map((doc) => `<button type="button" class="${legacyHas(doc.rel) ? 'ok' : 'bad'}" data-legacy-doc="${esc(doc.key)}" title="${esc(doc.rel)} · ${legacyHas(doc.rel) ? '存在' : '缺失'}">${esc(doc.label)} ${legacyHas(doc.rel) ? '有' : '缺'}</button>`).join('')}</div>
    <div class="legacy-team-list">${activityHead}${rows || '<div class="empty-row" data-roster-empty>本工作区无在册成员</div>'}</div>
    <div class="legacy-team-result">${(() => {
      // F-9fbe-1/F-2：团队台红橙与项目面板同一判定（只有 block 才红、才写拦截词）。
      const gate = legacyGateState();
      const shown = gate.topics.filter((row) => row.level !== 'info').slice(0, 3);
      if (!shown.length) {
        return `<b class="ok" data-panel-level="ok">${esc(gate.label)}</b><span>动作执行前会自动补 boot 所需角色；Owner 是外部角色${gate.topics.some((row) => row.id === 'overview-placeholder') ? '；需求总览待首条需求，不挡 boot' : ''}</span>`;
      }
      const text = shown.map((row) => `<b class="${panelLevelClass(row.level)}" data-panel-level="${row.level}" data-panel-topic="${esc(row.id)}">${esc(row.text)}</b>`).join('<span> · </span>');
      const more = gate.topics.filter((row) => row.level !== 'info').length > shown.length
        ? `<span>另有 ${gate.topics.filter((row) => row.level !== 'info').length - shown.length} 项，见项目面板逐条原因。</span>`
        : '<span>逐条补齐入口在项目面板「本轮必读」。</span>';
      return `${text}${more}`;
    })()} <button id="team-boot-all" class="ghost small" type="button" title="依次调用 workflow:boot；界面发起不冒充角色本人">全队 boot</button></div>`;
  // R-1dfb（AC5）：团队台渲染时调一次只读 IPC；返回 cached 时不再另起定时轮询（沿用既有刷新节奏）。
  legacyActivityRefresh();
  if (badge) {
    const gate = legacyGateState();
    badge.textContent = gate.label;
    badge.setAttribute('data-panel-level', gate.level);
    badge.className = 'badge ' + (gate.level === 'block' ? 'badge-rejected' : (gate.level === 'warn' ? 'badge-skipped' : (gate.level === 'info' ? 'muted-badge' : 'badge-approved')));
    badge.title = gate.topics.length
      ? gate.topics.map((row) => `${row.level === 'block' ? '阻塞' : (row.level === 'warn' ? '待核验' : '提示')}：${row.text}`).join(' / ')
      : '团队台与项目面板同一判定：没有待处理项。';
  }

  if (!actorBox) return;
  const wf = legacyWorkflow();
  const wfRows = [];
  for (const req of (wf && Array.isArray(wf.requirements) ? wf.requirements : [])) {
    if (req.productReview) wfRows.push({
      title: `${req.id} · 产品评审`, at: req.productReview.at,
      by: req.productReview.by, actor: req.productReview.actor,
      verdict: req.productReview.verdict, note: req.productReview.comment
    });
    // B-dee4：Owner 评审记录按派生值出（decisions 末条优先）。以前只读 ownerReview.status，
    // 产品复审把 status 重置成 pending 后，Owner 真的点过「通过」的那条在这里就没有记录了。
    const ownerDecided = legacyOwnerDecisionOf(req);
    if (ownerDecided.status) {
      const ownerConfirm = legacyOwnerConfirmationFor(req.ownerReview, req.id, 'owner');
      const latestOwner = ownerDecided.latest || {};
      wfRows.push({
        title: `${req.id} · Owner 评审`, at: ownerDecided.at || null, owner: true,
        by: latestOwner.by || (req.ownerReview && req.ownerReview.by) || 'Owner',
        actor: latestOwner.actor || (req.ownerReview && req.ownerReview.actor) || (ownerConfirm && ownerConfirm.actor) || null,
        verdict: ownerDecided.status, note: ownerDecided.opinion
      });
    }
    if (req.dev && req.dev.peerReview) wfRows.push({
      title: `${req.id} · 开发互审`, at: req.dev.peerReview.at,
      by: req.dev.peerReview.by, actor: req.dev.peerReview.actor,
      verdict: req.dev.peerReview.status, note: req.dev.peerReview.comment
    });
    if (req.ownerAcceptance) {
      const acceptConfirm = legacyOwnerConfirmationFor(req.ownerAcceptance, req.id, 'accept');
      wfRows.push({
        title: `${req.id} · Owner 验收`, at: req.ownerAcceptance.at, owner: true,
        by: req.ownerAcceptance.by,
        actor: req.ownerAcceptance.actor || (acceptConfirm && acceptConfirm.actor) || null,
        verdict: req.ownerAcceptance.status, note: req.ownerAcceptance.opinion
      });
    }
  }
  // 评审记录只取工作流需求侧的评审/验收（历史提案数据只走只读通道，不再并入本列表）。
  const allRows = [...wfRows]
    .filter((row) => row.by || row.actor || row.verdict)
    .sort((a, b) => (Date.parse(b.at || 0) || 0) - (Date.parse(a.at || 0) || 0))
    .slice(0, 8);
  const reviewRows = allRows.map((row) => {
    const by = String(row.by || '未记录');
    const actor = String(row.actor || '');
    // Owner 记录没有真实 actor：不补造成 Owner 本人，按“待 Owner”显示。
    const ownerAwaitingActor = Boolean(row.owner) && !actor;
    const verdictRaw = String(row.verdict || '');
    const verdict = verdictRaw === 'approve' || verdictRaw === 'approved' || verdictRaw === 'accepted' ? '通过'
      : (verdictRaw === 'reject' || verdictRaw === 'rejected' ? '打回'
        : (verdictRaw === 'skipped' ? '跳过' : (verdictRaw || '未写结论')));
    return `<div class="actor-row">
      <div class="actor-row-head"><b>${esc(row.title)}</b><span>${esc(ownerAwaitingActor ? '待 Owner' : legacyActorName(by))} · ${esc(verdict)}</span></div>
      <p>by=<code>${esc(by)}</code> · actor=${actor ? `<code>${esc(actor)}</code>` : (ownerAwaitingActor ? '<span class="actor-missing">待 Owner（真实 actor 未记录）</span>' : '<span class="actor-missing">执行者未记录</span>')}${row.note ? ' · ' + esc(String(row.note).slice(0, 120)) : ''}</p>
    </div>`;
  }).join('');
  let receiptLine = '';
  if (!receiptsCaps()) {
    receiptLine = '<div class="actor-row"><p><b class="actor-missing">team:receipts 缺失</b>：回执无法读取；不拿本机消息或看板计数冒充回执。</p></div>';
  } else if (receiptsUi.data) {
    const count = receiptLedgerRows(receiptsUi.data, p).length;
    receiptLine = `<div class="actor-row"><p>回执账本已读取 ${count} 条（按旧看板口径去重）；逐条 <code>actor</code> / <code>executor</code> / 身份来源见「最近回执」。</p></div>`;
  } else {
    receiptLine = '<div class="actor-row"><p>回执尚未读取；在「最近回执」点刷新，只读 <code>回执.jsonl</code>。</p></div>';
  }
  actorBox.innerHTML = (reviewRows || '<div class="actor-empty">还没有评审记录（工作流需求评审/验收为空；不会补造 actor）。</div>') + receiptLine;
  syncBootAllButtons();
}

/** 总览里的工作区事实：项目 ↔ DSH workspace ↔ 六角色会话，全部来自真实返回。 */
function wsFactsMarkup(p) {
  const ws = p.workspace || {};
  const teamName = ws.name || p.teamName || '';
  const verified = verifiedCount(p);
  const ready = sessionReadyCount(p);
  const live = liveFor(p);
  const wsId = ws.id || '';
  const cur = wsUi.data && wsUi.data.currentWorkspace;
  const curName = String((cur && (cur.name || cur.project)) || '');
  const mine = String(teamName || p.name);
  const facts = [
    {
      k: '团队 / 工作区',
      v: teamName || '未登记团队',
      cls: teamName ? '' : 'warn',
      mono: false,
      title: teamName ? teamName : '团队登记失败或不存在的旧记录；点「同步团队登记」可重试'
    },
    {
      k: 'DSH workspace',
      v: wsId || (ws.pending ? '待重试绑定' : '未绑定'),
      cls: wsId && !ws.pending ? 'ok' : (ws.pending ? 'warn' : 'bad'),
      mono: true,
      title: ws.lastError && ws.lastError.code ? `${ws.lastError.code}：${ws.lastError.message || ''}` : (ws.path || p.path)
    },
    {
      k: '当前团队会话',
      v: verified === null ? `${ready}/${teamRoleCount(p)} 本地映射（待核验）` : `${verified}/${teamRoleCount(p)} 已核验`,
      cls: verified === null ? 'warn' : (verified >= teamRoleCount(p) ? 'ok' : 'bad'),
      mono: false,
      title: verified === null ? '打开团队台或点「刷新」会向 DSH 核验' : `只统计${teamModeLabel(p)}在当前工作区里、能对上的角色会话`
    },
    {
      k: 'DSH 当前工作区',
      v: curName ? (curName === mine ? curName + '（本项目）' : curName) : '未读取',
      cls: !curName ? '' : (curName === mine ? 'ok' : 'warn'),
      mono: false,
      title: curName === mine || !curName ? '旧协议「当前工作区」指针' : `DSH 当前指向「${curName}」，不是本项目「${mine}」`
    }
  ];
  // e29f F-4：额外会话（含同一角色多会话）只在侧栏统计那处显示一个数字；
  // 团队台这张事实表不再另列"未映射会话/重复角色会话"，否则同一时刻会出现两个不同的数。
  return facts.map((f) => `<div class="ws-fact"><span class="k">${esc(f.k)}</span><span class="v ${f.cls}${f.mono ? ' mono' : ''}" title="${esc(f.title || '')}">${esc(f.v)}</span></div>`).join('');
}

function renderTaskList(container, p) {
  if (!container) return;
  const tasks = Array.isArray(p.tasks) ? p.tasks : [];
  if (!tasks.length) {
    container.innerHTML = `<div class="empty-row"><span>还没有任务。先建一个任务，流程才会开始。</span><br><button class="ghost small" type="button" data-open-task>＋ 新建任务</button></div>`;
    return;
  }
  const order = ['todo', 'doing', 'review', 'done'];
  container.innerHTML = tasks.map((t) => {
    const idx = order.indexOf(t.status);
    const next = order[Math.min(order.length - 1, idx + 1)];
    return `<div class="task-row">
      <div class="task-main">
        <div class="task-title">${esc(t.title)}</div>
        <div class="task-meta"><span class="task-role">${esc(roleById(t.role).name)}</span><span class="pri pri-${esc(String(t.priority || '').toLowerCase())}">${esc(t.priority || '—')}</span><span class="task-state status-${esc(t.status)}">${esc(TASK_STATUS[t.status] || t.status)}</span></div>
      </div>
      <div class="task-actions">
        <button class="icon-btn" type="button" data-task-status="${esc(t.id)}" title="推进到「${esc(TASK_STATUS[next] || next)}」">→</button>
        <button class="icon-btn" type="button" data-task-del="${esc(t.id)}" title="删除任务">×</button>
      </div>
    </div>`;
  }).join('');

  container.querySelectorAll('[data-task-status]').forEach((b) => b.addEventListener('click', async () => {
    const task = tasks.find((t) => t.id === b.dataset.taskStatus);
    if (!task) return;
    const next = order[Math.min(order.length - 1, order.indexOf(task.status) + 1)];
    try { await applyState(await window.workbench.updateTask({ projectId: p.id, taskId: task.id, status: next })); }
    catch (e) { toast('推进失败：' + e.message, 'bad'); }
  }));
  container.querySelectorAll('[data-task-del]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('删除这个任务？')) return;
    try { await applyState(await window.workbench.deleteTask({ projectId: p.id, taskId: b.dataset.taskDel })); }
    catch (e) { toast('删除失败：' + e.message, 'bad'); }
  }));
}

/* ── 看板 ─────────────────────────────────────────────── */

function renderBoard() {
  const p = activeProject();
  const board = $('#board');
  const summary = $('#board-summary');
  if (!board) return;
  if (!p) {
    board.classList.add('is-empty');
    if (summary) summary.textContent = '';
    board.innerHTML = emptyView({
      mark: '▦',
      title: '先选择一个项目',
      text: '看板会按「待办 / 进行中 / 待评审 / 已完成」显示当前项目的任务卡。',
      action: '<button class="primary small" type="button" data-open-new-project>＋ 新建项目</button><button class="ghost small" type="button" data-open-restore>恢复已有目录</button>'
    });
    return;
  }
  board.classList.remove('is-empty');
  const tasks = Array.isArray(p.tasks) ? p.tasks : [];
  const count = (status) => tasks.filter((t) => t.status === status).length;
  if (summary) summary.textContent = `任务 ${tasks.length} · 待办 ${count('todo')} · 进行 ${count('doing')} · 待评审 ${count('review')} · 完成 ${count('done')}`;

  const cols = [['todo', '待办'], ['doing', '进行中'], ['review', '待评审'], ['done', '已完成']];
  board.innerHTML = cols.map(([id, label]) => {
    const items = tasks.filter((t) => t.status === id);
    return `<section class="board-col">
      <header class="board-col-head"><b>${label}</b><span>${items.length}</span></header>
      <div class="board-cards">${items.map((t) => `
        <article class="board-card">
          <div class="bc-title">${esc(t.title)}</div>
          <div class="bc-meta"><span>${esc(roleById(t.role).name)}</span><span class="pri pri-${esc(String(t.priority || '').toLowerCase())}">${esc(t.priority || '—')}</span></div>
          <div class="bc-actions">
            ${id !== 'done' ? `<button type="button" data-next="${esc(t.id)}">下一步</button>` : ''}
            <button type="button" data-remove="${esc(t.id)}">删除</button>
          </div>
        </article>`).join('') || `<button class="board-empty" type="button" data-open-task>＋ 添加任务</button>`}</div>
    </section>`;
  }).join('');

  board.querySelectorAll('[data-next]').forEach((b) => b.addEventListener('click', async () => {
    const task = tasks.find((t) => t.id === b.dataset.next);
    if (!task) return;
    const order = ['todo', 'doing', 'review', 'done'];
    const next = order[Math.min(order.length - 1, order.indexOf(task.status) + 1)];
    try { await applyState(await window.workbench.updateTask({ projectId: p.id, taskId: task.id, status: next })); }
    catch (e) { toast('推进失败：' + e.message, 'bad'); }
  }));
  board.querySelectorAll('[data-remove]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('删除这个任务？')) return;
    try { await applyState(await window.workbench.deleteTask({ projectId: p.id, taskId: b.dataset.remove })); }
    catch (e) { toast('删除失败：' + e.message, 'bad'); }
  }));
}

/* ── 旧流程：需求 → 产品评审 → Owner → PM 派单 → 开发互审 → 测试 → Owner 验收 → 迭代/终止 ── */

const LEGACY_FLOW_STEPS = {
  requirement: { label: '需求', owner: '需求分析师', gate: '先读团队宪法（唯一最高优先级）→ 项目信息 → 角色卡 → 其他人文档；铁律按需；未 boot 不写需求' },
  product: { label: '产品评审', owner: '产品设计师', gate: '需求回执到齐后评审；通过之后才进入可测性评审' },
  trq: { label: '可测性评审', owner: '测试人员', gate: 'G2.5：需求评审 approve 后、Owner 之前；只评 AC 可判定性，结论“可测”才开 Owner 门；不写测试计划' },
  owner: { label: 'Owner', owner: 'Owner', gate: '需求评审通过 + TR-Q 可测后，Owner 明确通过/跳过/打回；跳过也要记录，PM 派单只认需求级 ownerReview.decisions' },
  dispatch: { label: 'PM 派单', owner: '项目经理', gate: 'Owner 落账 approved/skipped 且 designs/TR 通过后派单；一次只派一个，等回执' },
  devreview: { label: '开发互审', owner: '程序员 A/B', gate: 'proposal 互审 + 签字；作者不能审自己' },
  test: { label: '测试', owner: '测试人员', gate: '开发回执 + commit；测试独立验证' },
  accept: { label: 'Owner 验收', owner: 'Owner', gate: '测试报告 + 回执；验收后才收口/下一次' },
  closure: { label: '迭代 / 终止', owner: 'Owner / PM', gate: '验收后才收口：迭代把下一次需求转正；终止冻结工作流' }
};
const LEGACY_FLOW_ROWS = [
  ['requirement', 'product', 'trq'],
  ['owner', 'dispatch', 'devreview'],
  ['test', 'accept', 'closure']
];
const LEGACY_FLOW_EDGES = {
  'requirement>product': { pending: '待需求回执', active: '需求评审中' },
  'product>trq': { pending: '待可测性评审', active: '等待测试人员出 TR-Q' },
  'trq>owner': { pending: '待 TR-Q 可测', active: '可测 · 待 Owner' },
  'owner>dispatch': { pending: '待 Owner 落账', active: '等待 Owner 决定' },
  'dispatch>devreview': { pending: '待派发', active: '等待派单回执' },
  'devreview>test': { pending: '待互审', active: '互审中' },
  'test>accept': { pending: '待测试', active: '等待测试报告' },
  'accept>closure': { pending: '待验收', active: '验收后选择迭代/终止' }
};

// 流程图节点到阶段的位置（TR-Q 与 Owner 同在 owner_review，不新增 phase）。
const FLOW_STEP_RANK = {
  requirement: 0, product: 1, trq: 2, owner: 2, dispatch: 3,
  devreview: 4, test: 5, accept: 6, closure: 7
};

function legacyFlowEvidence(project) {
  const wf = legacyWorkflow();
  const requirements = wf && Array.isArray(wf.requirements) ? wf.requirements : [];
  const tasks = wf && Array.isArray(wf.tasks) ? wf.tasks : (Array.isArray(project.tasks) ? project.tasks : []);
  const messages = Array.isArray(project.messages) ? project.messages : [];
  const active = legacyActiveRequirement();
  return {
    requirements,
    requirementCount: requirements.length,
    accepted: requirements.filter((row) => row.status === 'accepted').length,
    tasks,
    phase: wf && wf.phase ? String(wf.phase) : 'idle',
    round: Number(wf && wf.round) || 1,
    counts: (wf && wf.counts) || {},
    // 项目级旧闸门：只用于历史展示，不参与需求派单。
    ownerReview: (wf && wf.ownerReview) || project.ownerReview || {},
    // 需求级闸门：PM 派单真正检查的字段。
    requirement: active,
    requirementOwner: (active && active.ownerReview) || null,
    ownerPending: legacyOwnerGateRequirements().length > 0,
    ledger: legacyLedgerDivergences(),
    pending: messages.find((message) => message.id === project.pendingAck) || null
  };
}

const LEGACY_PHASE_INDEX = {
  idle: 0,
  requirement: 0,
  requirement_review: 1,
  product_review: 1,
  owner_review: 2,
  tech_review: 3,
  dispatch: 3,
  dev: 4,
  dev_review: 4,
  dev_done: 4,
  test: 5,
  test_done: 6,
  owner_accept: 6,
  accepted: 7,
  iteration: 7,
  terminated: 7
};

// 阶段推导顺序（比展示用的八步更细）：只用于“只前进不回退”的单调判定。
const FLOW_PHASE_RANK = {
  idle: 0, requirement: 1, requirement_review: 2, owner_review: 3, tech_review: 4,
  dispatch: 5, dev: 6, dev_done: 7, dev_review: 8, test: 9, test_done: 10,
  owner_accept: 11, accepted: 12, iteration: 13, terminated: 14
};
const FLOW_PHASE_LABEL = {
  idle: '未开始', requirement: '需求', requirement_review: '需求评审', product_review: '需求评审',
  owner_review: 'Owner 闸门', tech_review: '技术评审', dispatch: '待派单', dev: '开发中',
  dev_done: '开发完成', dev_review: '互审', test: '测试中', test_done: '测试完成',
  owner_accept: '待 Owner 验收', accepted: '已验收', iteration: '下一次', terminated: '已终止'
};

/** 后端 workflow:state 的 derivation 是唯一推导结果；缺失时按需求/任务证据就地只读推导。 */
function flowDerivationFrom(wf) {
  const d = (wf && wf.derivation) || null;
  const reqs = wf && Array.isArray(wf.requirements) ? wf.requirements : [];
  const tasks = wf && Array.isArray(wf.tasks) ? wf.tasks : [];
  const sources = d && Array.isArray(d.sources) ? d.sources.slice(0, 6) : [];
  let phase = String((d && d.phase) || (wf && wf.phase) || legacyPhaseFromRequirements(reqs, wf && wf.round) || 'idle');
  let rollback = Boolean(d && d.rollback);
  if (!d) {
    const statuses = new Set(reqs.map((row) => String((row && row.status) || '')));
    const done = tasks.filter((task) => String((task && task.status) || '') === 'done');
    if (reqs.length) sources.push(`需求 ${reqs.length} 条`);
    if (statuses.has('test_done')) sources.push('需求 status=test_done');
    if (tasks.length) sources.push(`任务 done ${done.length}/${tasks.length}`);
    if (statuses.has('rejected')) { rollback = true; sources.push('需求被评审驳回（显式回退）'); }
    if (!sources.length) sources.push('无可用证据，按工作流快照');
  }
  const historyPhase = d && d.historyPhase
    ? String(d.historyPhase)
    : (wf && wf.workflow && wf.workflow.phase ? String(wf.workflow.phase) : null);
  phase = legacyDisplayPhase(phase, reqs);
  return {
    phase,
    rank: FLOW_PHASE_RANK[phase] !== undefined ? FLOW_PHASE_RANK[phase] : 0,
    sources,
    historyPhase,
    historyIgnored: Boolean(historyPhase && historyPhase !== phase),
    rollback,
    at: Date.now()
  };
}

/** 同项目同轮次内只前进不回退；合法回退只认显式事件（reject / Owner 打回 / iterate / terminate）。 */
function mergeFlowDerivation(prev, next, projectId, round) {
  const base = { ...next, projectId, round };
  if (!prev || prev.projectId !== projectId || prev.round !== round) return base;
  if (next.rollback) return base;
  if (next.rank >= prev.rank) return base;
  return { ...prev, sources: next.sources, historyPhase: next.historyPhase, historyIgnored: next.historyIgnored, at: Date.now(), heldBack: true };
}

function flowDerivationMarkup() {
  const p = activeProject();
  const d = legacyUi.flowDerive;
  if (!p || !d || d.projectId !== p.id) return '';
  const label = FLOW_PHASE_LABEL[d.phase] || d.phase;
  const hist = d.historyPhase
    ? ` ｜ 历史 phase：<code>${esc(d.historyPhase)}</code>（仅提示，不参与${d.historyIgnored ? '，已按证据忽略' : ''}）`
    : ' ｜ 工作流.json 无 phase 字段（不是真相来源）';
  const held = d.heldBack ? ' ｜ 当前证据暂未前进，保持已推导阶段' : '';
  return `<span class="flow-derive-dot" aria-hidden="true"></span>推导阶段 <b>${esc(label)}</b>（<code>${esc(d.phase)}</code>） ｜ 推导来源：${esc(d.sources.join('；') || '无可用证据')}${hist}${held}`;
}

function renderFlowDerivation() {
  const markup = flowDerivationMarkup();
  for (const id of ['flow-derive', 'flow-mini-derive']) {
    const el = $('#' + id);
    if (!el) continue;
    el.innerHTML = markup;
    el.hidden = !markup;
  }
}


function legacyFlowStatuses(project) {
  const evidence = legacyFlowEvidence(project);
  const phase = evidence.phase;
  const idx = LEGACY_PHASE_INDEX[phase] !== undefined ? LEGACY_PHASE_INDEX[phase] : 0;
  const trq = legacyTrqView(evidence.requirement);
  const statuses = {};
  for (const key of Object.keys(LEGACY_FLOW_STEPS)) {
    const rank = FLOW_STEP_RANK[key] !== undefined ? FLOW_STEP_RANK[key] : 0;
    statuses[key] = rank < idx ? 'done' : (rank === idx ? 'current' : 'pending');
  }
  // TR-Q 挂在 owner_review 里：有“可测”记录才算完成；不可测当前卡住；
  // 已经越过 Owner 却没有记录，标 missing（历史缺口），不把“没记录”显示成“已完成”。
  if (trq.state === 'testable') statuses.trq = idx >= 2 ? 'done' : 'pending';
  else if (trq.state === 'not_testable') statuses.trq = 'current';
  else if (trq.state === 'optional') statuses.trq = idx >= 2 ? 'done' : 'pending';
  else if (idx >= 3) statuses.trq = 'missing';
  else if (idx === 2) statuses.trq = 'current';
  else statuses.trq = 'pending';
  return { statuses, idx, evidence, trq };
}

function legacyFlowStepText(project, key, idx, status, evidence) {
  const terms = modeTerms(project);
  const reqOwner = evidence.requirementOwner || {};
  const req = evidence.requirement || null;
  const phase = evidence.phase;
  const trq = key === 'trq' ? legacyTrqView(req) : null;
  if (phase === 'terminated') return key === 'closure' ? '已终止' : '已停止';
  if (status === 'done') {
    if (key === 'product') return '评审完成';
    if (key === 'trq') return trq && trq.state === 'testable' ? `可测${trq.version ? ' · v' + trq.version : ''}` : '已过 Owner 门（TR-Q 未记录）';
    if (key === 'owner') return 'Owner 已决定';
    if (key === 'dispatch') return '已派发';
    if (key === 'devreview') return `${terms.devReview}完成`;
    if (key === 'test') return '测试完成';
    if (key === 'accept') return '已验收';
    if (key === 'closure') return '已收口';
    return '已完成';
  }
  if (status === 'pending') return '未到';
  if (key === 'requirement') return phase === 'iteration' ? '当前 · 需求' : '当前 · 需求';
  if (key === 'product') {
    if (req && req.voteRejection && String(req.status) === 'rejected') return '投票驳回 · 可迭代';
    if (req && String(req.status) === 'rejected') return `${terms.review}已打回`;
    return `当前 · ${terms.review}`;
  }
  if (key === 'trq') {
    if (trq && trq.state === 'testable') return `可测${trq.version ? ' · v' + trq.version : ''}`;
    if (trq && trq.state === 'not_testable') return `不可测${trq.missing.length ? ' · 缺 ' + trq.missing.length + ' 项' : ''}`;
    if (trq && trq.state === 'optional') return 'P1 未做（不阻门）';
    if (status === 'missing') return '缺 TR-Q（历史未记录）';
    return trq && trq.file ? '缺记录（文件已存在）' : '缺 TR-Q（未记录）';
  }
  if (key === 'owner') {
    if (reqOwner.status === 'rejected') return 'Owner 已打回需求';
    if (reqOwner.status === 'skipped') return phase === 'tech_review' ? `Owner 已跳过 · 待${terms.techReview}` : 'Owner 已跳过 · 待派单';
    if (reqOwner.status === 'approved') return phase === 'tech_review' ? `Owner 已通过 · 待${terms.techReview}` : 'Owner 已通过 · 待派单';
    if (req && String(req.status) === 'approved') return '待 Owner 决定';
    return '当前 · Owner 闸门';
  }
  if (key === 'dispatch') {
    if (phase === 'tech_review') return '当前 · 待评审';
    if (reqOwner.status === 'rejected') return '需求已打回';
    if (evidence.ownerPending) return '等 Owner 决定';
    if (['approved', 'skipped'].includes(String(reqOwner.status || ''))) {
      return req && String(req.status) === 'ready' ? 'ready · 待派单' : '当前 · 待派单';
    }
    return evidence.pending ? '待回执' : '当前 · 待派单';
  }
  if (key === 'devreview') {
    if (phase === 'dev_review') return `当前 · ${terms.devReview}`;
    if (phase === 'dev_done') return '当前 · 开发完成';
    return '当前 · 开发';
  }
  if (key === 'test') return '当前 · 测试';
  if (key === 'accept') return '待 Owner 验收';
  if (key === 'closure') return phase === 'iteration' ? '已迭代收口' : '待选择：迭代 / 终止';
  return '当前';
}

/* ── 并行泳道（R-cbbd）───────────────────────────────────────────────
 * 纯逻辑（阶段推导/汇总/冲突）在 flow-lanes.js，无 DOM 依赖、可单测；
 * 这里只负责 DOM 与“只重绘变化泳道”。
 */
const FLOW_LANES = window.FlowLanes;
const FLOW_LANE_BUCKETS = FLOW_LANES.BUCKETS;
const FLOW_LANE_TRACK = FLOW_LANES.TRACK;
const FLOW_LANE_STAGE_OF_PHASE = FLOW_LANES.STAGE_OF_PHASE;

function flowLaneInnerMarkup(lane, conflicts) {
  return FLOW_LANES.innerMarkup(lane, conflicts);
}

function flowLaneMarkup(lane, conflicts) {
  return FLOW_LANES.markup(lane, conflicts);
}

const flowLaneUi = { keys: new Map(), summary: '', source: null, panelKey: '' };

/* R-db98：节点式全量状态图（替代泳道多列，最小可用版）。
 * 同一批 lanes + 工作流行 → flow-graph.js 纯字符串渲染；两处容器（团队台/右下角浮窗）共用。
 * 节点图不可用（脚本没加载）时回落到原泳道渲染，保证旧回归不炸。 */
const flowGraphUi = { key: '', panelKey: '' };

function renderFlowGraphBoxes(project, lanes, summary) {
  const graph = window.FlowGraph;
  if (!graph) return false;
  const wf = legacyWorkflow() || {};
  const requirements = Array.isArray(wf.requirements) ? wf.requirements : [];
  flowGraphUi.last = { lanes, summary, wf };
  const key = `${project.id}|${lanes.map((lane) => `${lane.id}:${lane.phase}:${lane.done}/${lane.total}`).join('|')}|${requirements.length}`;
  const box = $('#flow-lanes');
  if (box && flowGraphUi.key !== key) {
    box.innerHTML = graph.markup(lanes, wf, summary);
    box.setAttribute('data-node-count', String(graph.NODES.length));
    box.setAttribute('data-lane-count', String(lanes.length));
    box.setAttribute('data-lane-summary', summary.text);
    flowGraphUi.key = key;
  }
  const panelBox = $('#flow-lanes-panel');
  const panelOpen = !($('#flow-panel') && $('#flow-panel').hidden);
  if (panelBox) {
    // R-db98 v2：流程面板的节点图统一走 #flow-mini（T-090012 已定），这里清空旧容器避免同屏两份图。
    if (panelBox.innerHTML || flowGraphUi.panelKey) {
      panelBox.innerHTML = '';
      panelBox.setAttribute('data-node-count', '0');
      panelBox.setAttribute('data-lane-count', '0');
      flowGraphUi.panelKey = '';
    }
  }
  const mini = $('#flow-lanes-mini');
  if (mini) mini.textContent = `${summary.text}${lanes.length ? ` ｜ ${lanes.length} 条需求` : ''}`;
  return true;
}

/** 右侧【流程】面板内的节点图块：用最近一次 lanes 数据渲染；无数据/无脚本时返回空串。 */
function flowGraphBoardMarkup() {
  const graph = window.FlowGraph;
  const last = flowGraphUi.last;
  if (!graph || !last) return '';
  return `<section class="flow-board-graph" data-flow-board-graph="1">${graph.markup(last.lanes, last.wf, last.summary)}</section>`;
}

/** 渲染泳道：集合变化才重建容器；否则只替换变化泳道的 .flow-lane-inner（未变化泳道零 DOM 操作）。 */
function renderFlowLanes(project) {
  const box = $('#flow-lanes');
  const mini = $('#flow-lanes-mini');
  if (!box) return;
  if (!project) {
    box.innerHTML = '';
    box.setAttribute('data-lane-count', '0');
    box.setAttribute('data-lane-summary', '');
    flowLaneUi.keys = new Map();
    flowLaneUi.summary = '';
    flowLaneUi.source = null;
    if (mini) mini.textContent = '';
    // B-2634：浮窗泳道清空（无项目时不留旧泳道）。
    const panelBoxEmpty = $('#flow-lanes-panel');
    if (panelBoxEmpty) {
      panelBoxEmpty.innerHTML = '';
      panelBoxEmpty.setAttribute('data-lane-count', '0');
      panelBoxEmpty.setAttribute('data-lane-summary', '');
    }
    flowLaneUi.panelKey = '';
    flowGraphUi.key = '';
    flowGraphUi.panelKey = '';
    flowGraphUi.last = null;
    return;
  }
  const lanes = FLOW_LANES.rows(legacyWorkflow() || {}, project, (legacyUi.flowDerive && legacyUi.flowDerive.phase) || '');
  const conflicts = FLOW_LANES.conflicts(lanes);
  const summary = FLOW_LANES.summary(lanes);
  // R-db98：节点式全量状态图优先；脚本缺失时 renderFlowGraphBoxes 返回 false，继续走旧泳道。
  if (renderFlowGraphBoxes(project, lanes, summary)) return;
  const ids = lanes.map((lane) => lane.id);
  const existing = Array.from(box.querySelectorAll('.flow-lane')).map((el) => el.getAttribute('data-lane-id'));
  const sameSet = flowLaneUi.source === project.id
    && existing.length === ids.length
    && ids.every((id, i) => id === existing[i]);
  if (!sameSet) {
    box.innerHTML = FLOW_LANES.containerMarkup(lanes, summary, conflicts);
    flowLaneUi.keys = new Map(lanes.map((lane) => [lane.id, lane.key]));
    flowLaneUi.summary = summary.text;
    flowLaneUi.source = project.id;
  } else {
    for (const lane of lanes) {
      const el = box.querySelector(`.flow-lane[data-lane-id="${CSS.escape(lane.id)}"]`);
      if (!el) continue;
      const conflict = Object.values(conflicts).some((laneIds) => laneIds.includes(lane.id));
      el.classList.toggle('conflict', conflict);
      if (flowLaneUi.keys.get(lane.id) === lane.key) continue; // 签名未变 → 不碰 DOM
      const inner = el.querySelector('.flow-lane-inner');
      if (inner) inner.innerHTML = flowLaneInnerMarkup(lane, conflicts);
      el.setAttribute('data-lane-key', lane.key);
      el.setAttribute('data-lane-phase', lane.phase);
      el.setAttribute('data-lane-bucket', lane.bucket);
      const badge = el.querySelector('.flow-lane-badge');
      if (badge) badge.textContent = (FLOW_LANE_BUCKETS.find((b) => b.key === lane.bucket) || {}).label || '未映射';
      flowLaneUi.keys.set(lane.id, lane.key);
    }
    const sumEl = box.querySelector('[data-flow-lanes-summary]');
    if (sumEl && flowLaneUi.summary !== summary.text) {
      sumEl.textContent = summary.text;
      flowLaneUi.summary = summary.text;
    }
    const inactiveEl = box.querySelector('[data-flow-lanes-inactive]');
    if (inactiveEl) inactiveEl.textContent = summary.inactive;
  }
  box.setAttribute('data-lane-count', String(lanes.length));
  box.setAttribute('data-lane-summary', summary.text);
  if (mini) {
    mini.textContent = `${summary.text}${summary.inactive ? ' ｜ ' + summary.inactive : ''}${lanes.length ? ` ｜ ${lanes.length} 条泳道` : ''}`;
  }
  // B-2634：右下角浮窗接同一批泳道（flow-lanes 只读展示）。浮窗关着只清缓存不建 DOM，省渲染成本。
  const panelBox = $('#flow-lanes-panel');
  if (panelBox) {
    const panelOpen = !($('#flow-panel') && $('#flow-panel').hidden);
    if (!panelOpen) {
      if (flowLaneUi.panelKey) {
        panelBox.innerHTML = '';
        panelBox.setAttribute('data-lane-count', '0');
        panelBox.setAttribute('data-lane-summary', '');
        flowLaneUi.panelKey = '';
      }
    } else {
      const panelKey = `${project.id}|${lanes.length}|${lanes.map((lane) => lane.id + ':' + lane.key).join('|')}`;
      if (flowLaneUi.panelKey !== panelKey) {
        panelBox.innerHTML = FLOW_LANES.containerMarkup(lanes, summary, conflicts);
        panelBox.setAttribute('data-lane-count', String(lanes.length));
        panelBox.setAttribute('data-lane-summary', summary.text);
        flowLaneUi.panelKey = panelKey;
      }
    }
  }
}

function flowMarkup(p) {
  const { statuses, evidence, trq } = legacyFlowStatuses(p);
  const quick = isQuickTeam(p);
  const terms = modeTerms(p);
  const copy = (text) => (quick ? localizeFastCopy(text) : String(text ?? ''));
  const reqOwner = evidence.requirementOwner || {};
  const reqOwnerKey = String(reqOwner.status || '');
  return LEGACY_FLOW_ROWS.map((row) => {
    let html = '';
    row.forEach((key, col) => {
      const step = LEGACY_FLOW_STEPS[key];
      const i = Object.keys(LEGACY_FLOW_STEPS).indexOf(key);
      const status = statuses[key];
      const stepLabel = quick && key === 'product' ? terms.review
        : (quick && key === 'dispatch' && evidence.phase === 'tech_review' ? 'TR'
          : (quick && key === 'devreview' ? terms.devReview : step.label));
      const stepOwner = quick && key === 'product' ? `${terms.reviewer} / PM`
        : (quick && key === 'dispatch' && evidence.phase === 'tech_review' ? '程序员A'
          : (quick && key === 'devreview' ? '测试人员' : step.owner));
      const trqDetail = key === 'trq'
        ? `；TR-Q：${trq.label}${trq.by ? ' · ' + trq.by : ''}${trq.at ? ' · ' + fmtTime(trq.at) : ''}${trq.file ? ' · ' + trq.file : ''}${trq.detail ? ' · ' + trq.detail : ''}`
        : '';
      const stepGate = quick && key === 'product' ? `${terms.review}；通过才进入可测性评审`
        : (quick && key === 'dispatch' && evidence.phase === 'tech_review' ? `Owner 之后由程序员A做${terms.techReview}；通过才 ready 可派单`
          : (quick && key === 'devreview' ? '测试人员独立复核；PM 在签字 apply 时复核；不是程序员A自审' : step.gate + trqDetail));
      let cls = 'flow-node';
      if (status === 'done') cls += ' done';
      if (status === 'current') cls += ' current';
      if (status === 'missing') cls += ' trq-missing';
      if (key === 'product' && (reqOwnerKey === 'rejected' || evidence.phase === 'requirement')) cls += ' rejected';
      if (key === 'trq' && trq.state === 'not_testable') cls += ' rejected';
      if (key === 'owner' && reqOwnerKey === 'rejected') cls += ' rejected';
      if (key === 'closure') {
        cls += ' closure';
        if (evidence.phase === 'terminated') cls += ' rejected';
      }
      const small = legacyFlowStepText(p, key, i, status, evidence);
      const title = `${stepLabel}｜负责：${stepOwner}｜闸门：${stepGate}`;
      html += `<div class="${cls}" data-flow-stage="${esc(key)}" title="${esc(title)}"><span>${esc(stepLabel)}</span><small>${esc(small)}</small></div>`;
      if (col < row.length - 1) {
        const next = row[col + 1];
        const edgeDef = LEGACY_FLOW_EDGES[key + '>' + next] || { pending: '待推进', active: '推进中' };
        let edgeCls = 'flow-edge';
        let label = copy(edgeDef.pending);
        if (key === 'product' && reqOwnerKey === 'rejected') {
          edgeCls += ' done';
          label = `${terms.review}已通过`;
        } else if (key === 'trq' && trq.state === 'testable') {
          edgeCls += ' done';
          label = '可测 · 可开 Owner 门';
        } else if (key === 'trq' && trq.state === 'not_testable') {
          edgeCls += ' rejected';
          label = '不可测 · 退回需求';
        } else if (key === 'owner' && reqOwnerKey === 'rejected') {
          edgeCls += ' rejected';
          label = 'Owner 已打回需求';
        } else if (key === 'owner' && ['approved', 'skipped'].includes(reqOwnerKey)) {
          edgeCls += ' active';
          if (quick && evidence.phase === 'tech_review') {
            label = `待${terms.techReview}`;
          } else {
            label = reqOwnerKey === 'skipped' ? 'Owner 已跳过 · 待派单' : 'Owner 已通过 · 待派单';
          }
        } else if (key === 'owner' && evidence.ownerPending) {
          edgeCls += ' active';
          label = 'Owner 决定后派单';
        } else if (statuses[next] === 'done') {
          edgeCls += ' done';
          label = '已通过';
        } else if (status === 'current' || statuses[next] === 'current') {
          edgeCls += ' active';
          label = copy(edgeDef.active);
        }
        html += `<span class="${edgeCls}" data-flow-edge="${esc(key + '>' + next)}" title="${esc(stepGate)}"><span>${esc(label)}</span></span>`;
      }
    });
    return `<div class="flow-line">${html}</div>`;
  }).join('');
}

function projectOwnerRejected(project) {
  return String((project && project.ownerReview && project.ownerReview.status) || '') === 'rejected';
}

/** 快速 4 人：Owner 评审后显示「技术评审」；分析师发起，除 PM 外全员投票。 */
function quickTechReviewMarkup(p) {
  const terms = modeTerms(p);
  const req = legacyActiveRequirement();
  const status = String((req && req.status) || '');
  const tech = req && req.techReview && typeof req.techReview === 'object' ? req.techReview : null;
  const owner = req ? legacyReqOwnerView(req) : null;
  const reviewRole = isQuickTeam() ? 'analyst' : 'product';
  const techGate = legacyActionCommandGate('tech-review');
  let stateKey = 'pending';
  let stateLabel = '未发起';
  let desc = '';
  let action = '';
  if (!req) {
    const all = legacyRequirements();
    stateKey = 'waiting-requirement';
    if (all.length) {
      stateLabel = '无在办需求';
      desc = `当前没有在办需求（已有 ${all.length} 条需求，均不在当前在办）。需要时由 Owner 向 PM 提新需求；新需求从「迭代（收口后）」开始。`;
    } else {
      stateLabel = '等需求';
      desc = `还没有需求。先由 Owner 向 PM 提需求；Owner 评审通过后，这里进入${terms.techReview}。`;
    }
    action = '<button class="primary small" type="button" data-legacy-req-action="owner-demand" title="调用真实 owner:demand，由 PM 自动建档">Owner 向 PM 提需求</button>';
  } else if (['review', 'rejected'].includes(status) && !(tech && tech.verdict === 'reject')) {
    stateKey = 'waiting-review';
    stateLabel = `等${terms.review}`;
    desc = `需求 ${req.id} 当前「${legacyReqStatus(req)}」。快速团队先走${terms.review}，再进入 Owner；Owner 通过后才进入${terms.techReview}。`;
    action = legacyReqButton('requirement-review', terms.review, req, reviewRole,
      `requirement:review（快速团队由${terms.reviewer}评审）`);
  } else if (!owner || !['approved', 'skipped'].includes(String(owner.status || ''))) {
    stateKey = 'waiting-owner';
    stateLabel = '等 Owner';
    desc = `需求 ${req.id} 当前「${legacyReqStatus(req)}」，Owner ${owner ? owner.label : '未决定'}。Owner 通过/跳过后进入${terms.techReview}。`;
    action = '<button class="ghost small" type="button" data-open-owner title="打开需求级 Owner 闸门；真实 requirement:owner">打开 Owner 评审</button>';
  } else if (status === 'tech_review') {
    stateKey = 'pending';
    stateLabel = 'TR';
    desc = `需求 ${req.id} 的 Owner 闸门已${owner.status === 'skipped' ? '跳过' : '通过'}。由程序员A判断实现可行性/风险；通过才 ready 可派单，打回则回到需求。`;
    action = `<button class="primary small" type="button" data-legacy-req-action="tech-review" data-req-id="${esc(req.id)}" ${techGate.ok ? '' : 'disabled'} title="${esc(techGate.ok ? '调用真实 requirement:tech-review（程序员A）；通过后状态 ready' : techGate.reason)}">TR · 程序员A 提交${terms.techReview}</button>`;
  } else if (status === 'ready') {
    stateKey = 'passed';
    stateLabel = 'ready';
    desc = `需求 ${req.id} 的${terms.techReview}已通过（后端状态 ready），PM 可以派单。`;
    action = legacyReqButton('dispatch', 'PM 派单', req, 'pm', `requirement:dispatch（PM）· ${terms.techReview}已通过`);
  } else if (tech && tech.verdict === 'reject') {
    stateKey = 'rejected';
    stateLabel = '已打回';
    desc = `需求 ${req.id} 的${terms.techReview}被打回${tech.comment ? '：' + tech.comment : '。'} 需要重新${terms.review} / Owner / ${terms.techReview}。`;
    action = legacyReqButton('requirement-review', `重新评审`, req, reviewRole,
      `requirement:review（快速团队由${terms.reviewer}评审）`);
  } else if (['dev', 'dev_review', 'dev_done', 'test', 'test_done', 'accepted', 'iteration'].includes(status)) {
    stateKey = 'passed';
    stateLabel = 'TR 已通过';
    desc = `需求 ${req.id} 已进入「${legacyReqStatus(req)}」，${terms.techReview}已完成。`;
  } else {
    stateKey = 'pending';
    stateLabel = 'TR';
    desc = `需求 ${req.id} 当前「${legacyReqStatus(req)}」；Owner 通过后进入${terms.techReview}。`;
  }
  const techInfo = tech
    ? `<div class="quick-tech-counts">
        <span class="vote-count approve">TR · 评审人 ${esc(roleById(tech.by).name)}</span>
        <span class="vote-count ${tech.verdict === 'approve' ? 'approve' : 'reject'}">${tech.verdict === 'approve' ? '通过 · ready' : '打回'}</span>
        ${tech.comment ? `<span class="vote-count pending">理由：${esc(tech.comment)}</span>` : ''}
        ${tech.evidence ? `<span class="vote-count pending">证据：${esc(tech.evidence)}</span>` : ''}
        ${tech.at ? `<span class="vote-count pending">${esc(fmtTime(tech.at) || tech.at)}</span>` : ''}
      </div>`
    : '';
  return `<section class="quick-tech-panel ${esc(stateKey)}">
    <div class="quick-tech-head">
      <div><span class="eyebrow">QUICK TEAM · TR</span><h3>${esc(terms.techReview)} <span class="badge">${esc(teamModeLabel(p))}</span></h3></div>
      <span class="quick-tech-state">${esc(stateLabel)}</span>
    </div>
    <p class="quick-tech-desc">${esc(desc)}</p>
    ${techInfo}
    <div class="quick-tech-actions">${action}<span class="quick-tech-voters">评审人：程序员A（PM 不参与${esc(terms.techReview)}；Owner 决定已由后端校验）</span></div>
  </section>`;
}

function renderQuickTechReview(p) {
  const box = $('#quick-tech-review');
  if (!box) return;
  if (!p || !isQuickTeam(p)) {
    box.hidden = true;
    box.innerHTML = '';
    return;
  }
  box.hidden = false;
  box.innerHTML = quickTechReviewMarkup(p);
}


/* ── 需求/缺陷池（R-3f0d；R-30e2：行内标题 + 点击详情 + 模糊搜索）──────
 * 纯逻辑（池行构建 / 筛选 / 行与详情 HTML）在 src/renderer/pool-core.js：
 *   - 浏览器：index.html 在 app.js 之前引入，挂 window.POOL_CORE；
 *   - Node  ：scripts/test-pool-30e2.cjs 直接 require 做断言。
 * 这里只负责数据一次性加载（一次 workflowState）、DOM 渲染与键鼠交互。
 * 池数据 = 需求行 + type 为 bug / scenario-bug 的任务；加载后渲染与搜索不再读文件。 */
const POOL_CORE = (typeof window !== 'undefined' && window.POOL_CORE) ? window.POOL_CORE : null;
const poolUi = {
  open: false,
  filter: 'all',
  kindFilter: 'all',
  query: '',
  rows: [],
  signature: '',
  detailId: '',
  lastFetch: 0,
  loading: false,
  // R-c72a F5：虚拟化状态（virtualRows=当前筛选后的需求行，virtual=当前窗口信息）
  virtual: null,
  virtualRows: [],
  virtualRaf: false,
  // R-c72a AC2（批3）：按项目预取的需求行缓存——切项目时先同步换列表，不被 selectProject 的工作区激活拖住。
  byProject: {},
  // 取数序号：并发 refresh 时只让最后一次写回，避免 A/B 两个项目的返回交错覆盖。
  fetchSeq: 0
};
// 既有四个状态键：键名 / 标签 / 计数语义一字不改（R-30e2 §二、F-4）。
const POOL_FILTERS = POOL_CORE ? POOL_CORE.POOL_FILTERS : [
  { key: 'all', label: '全部' },
  { key: 'approved', label: '已通过' },
  { key: 'active', label: '进行中' },
  { key: 'accepted', label: '已验收' }
];
// 新增类型键（F-7）：defect 沿用 poolTypeOf 既有别名，bug / scenario-bug 都归缺陷池。
const POOL_KIND_FILTERS = POOL_CORE ? POOL_CORE.POOL_KIND_FILTERS : [
  { key: 'all', label: '全部类型' },
  { key: 'requirement', label: '需求' },
  { key: 'defect', label: '缺陷' },
  { key: 'scenario-bug', label: '场景缺陷' }
];
/** 类型：默认需求；type/defect 或 D- 前缀为缺陷；type=scenario-bug 为场景缺陷（R-43ad 枚举）。 */
function poolTypeOf(row) {
  if (POOL_CORE) return POOL_CORE.poolTypeOf(row);
  const t = String((row && row.type) || '').toLowerCase();
  if (t === 'scenario-bug') return 'scenario-bug';
  if (t === 'defect' || t === 'bug' || t === '缺陷') return 'defect';
  if (/^D-/i.test(String((row && row.id) || ''))) return 'defect';
  return 'requirement';
}
function poolTypeLabel(row) {
  const t = poolTypeOf(row);
  return t === 'scenario-bug' ? '【场景缺陷】' : t === 'defect' ? '【缺陷】' : '【需求】';
}
function poolTypeBadge(row) {
  const t = poolTypeOf(row);
  const label = t === 'scenario-bug' ? '场景缺陷' : t === 'defect' ? '缺陷' : '需求';
  return `<span class="req-type ${t}" title="${label}">${label}</span>`;
}
/** 池状态桶：需求行沿用 R-3f0d 既有判定；缺陷/场景缺陷任务行按 status 映射（F-1b）。 */
function poolBucket(row) {
  if (POOL_CORE) return POOL_CORE.poolBucket(row);
  const s = String((row && row.status) || '');
  if (['accepted', 'done', 'iteration'].includes(s)) return 'accepted';
  // B-dee4（AC2）：dev_done 归「进行中」，不能再当 other 丢出池。
  if (['dispatched', 'dev', 'dev_review', 'dev_done', 'test', 'test_done'].includes(s)) return 'active';
  if (['approved', 'ready'].includes(s)) return 'approved';
  if (row && row.reviewedAt) return 'approved';
  // B-dee4（AC1/AC2）：Owner 已通过/已跳过的行一律按「已通过」进池（不因 ownerReview 被重置而丢行）。
  const decided = legacyOwnerDecisionOf(row).status;
  if (decided === 'approved' || decided === 'skipped') return 'approved';
  return 'other';
}
function poolEntered(row) {
  if (POOL_CORE) return POOL_CORE.poolEntered(row);
  return poolBucket(row) !== 'other' || !!(row && row.reviewedAt);
}
function poolStatusLabel(row) {
  if (POOL_CORE) return POOL_CORE.poolStatusLabel(row);
  const b = poolBucket(row);
  return b === 'accepted' ? '已验收' : b === 'active' ? '进行中' : b === 'approved' ? '已通过' : '待评审';
}
/** 一次性加载池数据：**单次** workflowState → 需求行 + bug/scenario-bug 任务（F-30e2-1 / F-8）。
 *  之后渲染与搜索只用返回的数组，不再发 IPC、不再读文件。 */
async function poolFetchRows(projectId) {
  // projectId 显式传入时按它取（切项目首帧用目标项目取数，不等 activeProject 切换完成）。
  const pid = String(projectId || ((activeProject() || {}).id) || '');
  if (!pid || !POOL_CORE || !window.workbench || typeof window.workbench.workflowState !== 'function') return null;
  try {
    const wf = await window.workbench.workflowState({ projectId: pid });
    if (!wf || wf.ok === false) return null;
    return POOL_CORE.preparePoolRows(wf);
  } catch { return null; }
}
function poolPanelEnsure() {
  let mask = $('#pool-mask');
  if (mask) return mask;
  mask = document.createElement('div');
  mask.id = 'pool-mask';
  mask.className = 'pool-mask';
  mask.hidden = true;
  mask.innerHTML = `<section class="pool-panel" role="dialog" aria-modal="true" aria-label="需求/缺陷池">
    <header class="pool-head"><b>需求 / 缺陷池</b><span class="pool-sub">评审通过自动入池 · 六人/四人同规则</span><button class="pool-close" id="pool-close" type="button" aria-label="关闭">×</button></header>
    <div class="pool-search-row">
      <input type="search" id="pool-search" class="pool-search" placeholder="搜编号 / 标题 / 负责人 / 状态" aria-label="搜编号 / 标题 / 负责人 / 状态" autocomplete="off" spellcheck="false">
      <button type="button" class="pool-search-clear" id="pool-search-clear" hidden>清空</button>
    </div>
    <div class="pool-kinds" id="pool-kinds" role="group" aria-label="按类型筛选"></div>
    <div class="pool-filters" id="pool-filters" role="group" aria-label="按状态筛选"></div>
    <div class="pool-ghost-bar" id="pool-ghost-bar" hidden>
      <span class="pool-ghost-text" id="pool-ghost-text">有 0 条需求不在工作流里（推不动）</span>
      <input type="text" id="pool-ghost-reason" class="pool-ghost-reason" placeholder="作废原因（必填）" aria-label="作废原因" autocomplete="off">
      <button type="button" class="ghost small" id="pool-ghost-register">一键登记</button>
      <button type="button" class="ghost small" id="pool-ghost-void">一键作废</button>
    </div>
    <div class="pool-accept-bar" id="bug-retract-bar" hidden>
      <span class="pool-accept-text" id="bug-retract-text">可撤回的自动验收 0 条</span>
      <input type="text" id="bug-retract-reason" class="pool-accept-reason" placeholder="撤回原因（可选）" aria-label="撤回原因" autocomplete="off">
      <button type="button" class="ghost small" id="bug-retract-run">撤回自动验收</button>
    </div>
    <div class="pool-cols">
      <section class="pool-col"><h4>需求池 <span class="pool-n" id="pool-req-n">0</span></h4><div class="pool-list" id="pool-req-list"></div></section>
      <section class="pool-col"><h4>缺陷池 <span class="pool-n" id="pool-def-n">0</span></h4><div class="pool-list" id="pool-def-list"></div></section>
    </div>
    <div class="pool-nomatch" id="pool-nomatch" hidden>
      <p class="pool-nomatch-text">没有匹配项</p>
      <div class="pool-nomatch-actions">
        <button type="button" class="ghost small" id="pool-nomatch-clear">清空搜索</button>
        <button type="button" class="ghost small" id="pool-nomatch-reset">重置筛选</button>
      </div>
    </div>
    <p class="pool-foot" id="pool-foot"></p>
  </section>
  <div id="pool-detail-host" class="pool-detail-host" hidden></div>`;
  document.body.appendChild(mask);
  // 事件委托：行点击 / 键盘 / 详情内链接都在 mask 上统一处理，行节点重建时不用重绑。
  mask.addEventListener('click', (e) => {
    if (e.target === mask) { closePool(); return; }
    // R-f9b1：池详情里的增补卷 → 界面内只读查看（排在 .pool-link 之前：
    // 卷按钮也带 pool-link 样式，不能让它走"系统程序打开"，否则界面上读不到内容）。
    const supplementBtn = e.target.closest('[data-supplement-open]');
    if (supplementBtn) {
      e.preventDefault(); e.stopPropagation();
      void openSupplementViewer(supplementBtn.dataset.supplementOpen, {
        name: supplementBtn.dataset.supplementName,
        bytes: supplementBtn.dataset.supplementBytes,
        sha256: supplementBtn.dataset.supplementSha,
        requirementId: supplementBtn.dataset.supplementReq
      });
      return;
    }
    const link = e.target.closest('.pool-link');
    if (link) { e.preventDefault(); e.stopPropagation(); openPoolLink(link); return; }
    // R-4657：撤回按钮只走 IPC（单条 / 批量），不能触发行详情。
    const retractBtn = e.target.closest('[data-bug-retract]');
    if (retractBtn) { e.preventDefault(); e.stopPropagation(); void runBugRetract([retractBtn.dataset.bugRetract]); return; }
    if (e.target.closest('#bug-retract-run')) { e.preventDefault(); e.stopPropagation(); void runBugRetractBatch(); return; }
    if (e.target.closest('#pool-detail-close')) { e.stopPropagation(); closePoolDetail(); return; }
    const row = e.target.closest('.pool-row');
    if (row) { e.stopPropagation(); togglePoolDetail(row.dataset.id); }
  });
  mask.addEventListener('keydown', (e) => {
    if (e.target && e.target.closest && e.target.closest('[data-bug-retract]')) return;
    const row = e.target && e.target.closest ? e.target.closest('.pool-row') : null;
    if (!row) return;
    if (e.key === 'Enter' || e.key === ' ' || e.key === 'Spacebar') {
      e.preventDefault();
      togglePoolDetail(row.dataset.id);
    }
  });
  const search = $('#pool-search');
  if (search) {
    search.addEventListener('input', (e) => { poolUi.query = String(e.target.value || ''); applyPoolFilters(); });
    search.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); clearPoolSearch(); }
      else if (e.key === 'Enter') e.preventDefault();
    });
  }
  $('#pool-search-clear')?.addEventListener('click', () => clearPoolSearch());
  $('#pool-nomatch-clear')?.addEventListener('click', () => clearPoolSearch());
  $('#pool-nomatch-reset')?.addEventListener('click', () => resetPoolFilters());
  $('#pool-close')?.addEventListener('click', closePool);
  // B-a17d AC4：未登记需求的一键登记 / 作废（走 requirement:ghost-* IPC，PM 代办）。
  $('#pool-ghost-register')?.addEventListener('click', () => runPoolGhostAction('register'));
  $('#pool-ghost-void')?.addEventListener('click', () => runPoolGhostAction('void'));
  return mask;
}
/** 未登记需求的批量动作：登记（进工作流 review）/ 作废（写项目根作废登记并从面板剔除）。 */
async function runPoolGhostAction(kind) {
  const rows = (poolUi.rows || []).filter((row) => row.kind === 'requirement' && row.unregistered === true);
  const ids = rows.map((row) => String(row.id)).filter(Boolean);
  if (!ids.length) { toast('当前没有未登记需求', 'warn'); return; }
  const p = activeProject();
  if (!p || !window.workbench) { toast('还没有激活项目', 'warn'); return; }
  const isVoid = kind === 'void';
  let reason = '';
  if (isVoid) {
    const input = $('#pool-ghost-reason');
    reason = String((input && input.value) || '').trim();
    if (!reason) { toast('作废要先填原因（写清为什么作废）', 'warn'); if (input) input.focus(); return; }
  }
  const api = isVoid ? window.workbench.requirementGhostVoid : window.workbench.requirementGhostRegister;
  if (typeof api !== 'function') { toast('当前版本不支持一键处理未登记需求', 'bad'); return; }
  let result = null;
  try {
    result = await api({ projectId: p.id, ids, ...(isVoid ? { reason } : {}) });
  } catch (error) {
    toast(`${isVoid ? '作废' : '登记'}失败：${String((error && error.message) || error).slice(0, 120)}`, 'bad');
    return;
  }
  if (!result || result.ok === false) {
    toast(`${isVoid ? '作废' : '登记'}失败：${String((result && (result.message || result.code)) || '未知错误').slice(0, 120)}`, 'bad');
    return;
  }
  const failed = Array.isArray(result.result && result.result.results)
    ? result.result.results.filter((row) => row && row.ok === false && row.code !== 'ALREADY_VOIDED' && row.code !== 'ALREADY_REGISTERED') : [];
  toast(failed.length
    ? `${isVoid ? '作废' : '登记'}完成：成功 ${ids.length - failed.length} / ${ids.length}，失败 ${failed.length}（${failed[0].code || '未知'}）`
    : `已${isVoid ? '作废' : '登记'} ${ids.length} 条未登记需求`, failed.length ? 'warn' : '');
  await refreshPool();
}
/** R-4657：可撤回的自动验收行（accepted + 未超窗；判定全在 pool-core，不读文件）。 */
function poolRetractableRows(rows) {
  if (!POOL_CORE) return [];
  return (Array.isArray(rows) ? rows : []).filter((row) => row && row.kind !== 'requirement'
    && POOL_CORE.acceptStateOf(row) === 'accepted'
    && POOL_CORE.retractAllowed(row));
}
/** R-4657：批量撤回条（有可撤回行才显示）。 */
function renderBugRetractBar(rows) {
  const bar = $('#bug-retract-bar');
  if (!bar) return;
  const eligible = poolRetractableRows(rows);
  bar.hidden = eligible.length === 0;
  bar.dataset.count = String(eligible.length);
  const text = $('#bug-retract-text');
  if (text) text.textContent = eligible.length
    ? `可撤回的自动验收 ${eligible.length} 条（窗口内）`
    : '';
  const btn = $('#bug-retract-run');
  if (btn) btn.textContent = eligible.length > 1 ? `批量撤回（${eligible.length}）` : '撤回自动验收';
}
/** R-4657：撤回只走 IPC auto:accept-retract；成功后重取池数据（IPC 返回 retracted/failed）。 */
async function runBugRetract(ids) {
  const list = (Array.isArray(ids) ? ids : [ids]).map((id) => String(id || '').trim()).filter(Boolean);
  if (!list.length) { toast('没有可撤回的自动验收', 'warn'); return; }
  const p = activeProject();
  if (!p || !window.workbench || typeof window.workbench.autoAcceptRetract !== 'function') {
    toast('当前版本不支持撤回自动验收', 'bad');
    return;
  }
  if (list.length > 1 && typeof window.confirm === 'function' && !window.confirm(`确定撤回 ${list.length} 条自动验收？`)) return;
  const reasonInput = $('#bug-retract-reason');
  const reason = String((reasonInput && reasonInput.value) || '').trim();
  let result = null;
  try {
    result = await window.workbench.autoAcceptRetract({ projectId: p.id, taskIds: list, reason, role: 'owner' });
  } catch (error) {
    toast(`撤回失败：${String((error && error.message) || error).slice(0, 120)}`, 'bad');
    return;
  }
  if (!result || result.ok === false) {
    toast(`撤回失败：${String((result && (result.message || result.code)) || '未知错误').slice(0, 120)}`, 'bad');
    return;
  }
  const retracted = Array.isArray(result.retracted) ? result.retracted : [];
  const failed = Array.isArray(result.failed) ? result.failed : [];
  toast(failed.length
    ? `撤回完成：成功 ${retracted.length} / ${list.length}，失败 ${failed.length}（${(failed[0] && failed[0].code) || '未知'}）`
    : `已撤回 ${retracted.length} 条自动验收`, failed.length ? 'warn' : '');
  if (reasonInput) reasonInput.value = '';
  await refreshPool();
}
function runBugRetractBatch() {
  return runBugRetract(poolRetractableRows(poolUi.rows).map((row) => row.id));
}
/** 行 HTML：委托纯逻辑模块。行结构固定为 徽标 → 编号 → 标题 → 状态 → 负责人（F-30e2-1）；
 *  本函数体内不含 await / fs 读取 / IPC 调用（F-8 静态断言）。 */
function poolRowMarkup(row) {
  if (POOL_CORE) return POOL_CORE.poolRowMarkup(row);
  const id = String((row && row.id) || '');
  const b = poolBucket(row);
  const who = String((row && (row.owner || row.ownerRole)) || '');
  return `<div class="pool-row" data-id="${esc(id)}" data-bucket="${b}">${poolTypeBadge(row)}<span class="pool-id">${esc(id)}</span><span class="pool-state s-${b}">${poolStatusLabel(row)}</span>${who ? `<span class="pool-who">${esc(who)}</span>` : ''}</div>`;
}
/** 筛选键：首次建 DOM；之后只更新计数与选中态，不重建（AC7④）。 */
function renderPoolChips() {
  const statusBox = $('#pool-filters');
  if (statusBox && statusBox.dataset.built !== '1') {
    statusBox.innerHTML = POOL_FILTERS.map((f) => `<button class="pool-chip" data-filter="${f.key}" type="button">${f.label}<i>0</i></button>`).join('');
    statusBox.dataset.built = '1';
    statusBox.querySelectorAll('.pool-chip').forEach((btn) => btn.addEventListener('click', () => {
      poolUi.filter = btn.dataset.filter;
      if (poolUi.detailId) closePoolDetail(false);
      applyPoolFilters();
    }));
  }
  const kindBox = $('#pool-kinds');
  if (kindBox && kindBox.dataset.built !== '1') {
    kindBox.innerHTML = POOL_KIND_FILTERS.map((f) => `<button class="pool-chip pool-kind-chip" data-kind-filter="${f.key}" type="button">${f.label}<i>0</i></button>`).join('');
    kindBox.dataset.built = '1';
    kindBox.querySelectorAll('.pool-kind-chip').forEach((btn) => btn.addEventListener('click', () => {
      poolUi.kindFilter = btn.dataset.kindFilter;
      if (poolUi.detailId) closePoolDetail(false);
      applyPoolFilters();
    }));
  }
}
/** 只切显示与计数：不重建行节点、不读文件、不发 IPC（F-30e2-6⑤ / AC7④）。 */
function applyPoolFilters() {
  const mask = $('#pool-mask');
  const rows = Array.isArray(poolUi.rows) ? poolUi.rows : [];
  if (!mask || !POOL_CORE) return;
  const state = { status: poolUi.filter, kind: poolUi.kindFilter, query: poolUi.query };
  const visible = POOL_CORE.poolVisibleRows(rows, state);
  const visibleIds = new Set(visible.map((row) => row.id));
  // 缺陷池行数少，沿用 hidden 切换；需求池走虚拟化（按筛选结果重渲窗口）。
  mask.querySelectorAll('#pool-def-list .pool-row').forEach((node) => {
    const on = visibleIds.has(node.dataset.id);
    if (node.hidden === on) node.hidden = !on;
  });
  poolApplyReqVisible(visible.filter((row) => row && row.kind === 'requirement'));
  const counts = POOL_CORE.poolFilterCounts(rows, state);
  const statusBox = $('#pool-filters');
  if (statusBox) {
    statusBox.querySelectorAll('.pool-chip').forEach((btn) => {
      const key = btn.dataset.filter;
      btn.classList.toggle('on', key === poolUi.filter);
      const n = btn.querySelector('i');
      if (n) n.textContent = String((counts.status && counts.status[key]) || 0);
    });
  }
  const kindBox = $('#pool-kinds');
  if (kindBox) {
    kindBox.querySelectorAll('.pool-kind-chip').forEach((btn) => {
      const key = btn.dataset.kindFilter;
      btn.classList.toggle('on', key === poolUi.kindFilter);
      const n = btn.querySelector('i');
      if (n) n.textContent = String((counts.kind && counts.kind[key]) || 0);
    });
  }
  const reqN = visible.filter((row) => row.kind === 'requirement').length;
  const defN = visible.length - reqN;
  if ($('#pool-req-n')) $('#pool-req-n').textContent = String(reqN);
  if ($('#pool-def-n')) $('#pool-def-n').textContent = String(defN);
  const totalReq = rows.filter((row) => row.kind === 'requirement').length;
  const totalDef = rows.length - totalReq;
  const statusLabel = (POOL_FILTERS.find((f) => f.key === poolUi.filter) || {}).label || '全部';
  const kindLabel = (POOL_KIND_FILTERS.find((f) => f.key === poolUi.kindFilter) || {}).label || '全部类型';
  const query = String(poolUi.query || '').trim();
  // B-20261116-095320-410e：池的口径数字挂到 #pool-foot（需求 = 工作流需求行；兜底行单列），
  // 与评审界面 [data-owner-all-total] / 流程面板 [data-flow-total] 同一个 UI3 口径。
  // B-20261116-094215-2ff6②：已完成但未验收的缺陷单独计数（不再混进「已验收」）。
  const scope = (POOL_CORE && typeof POOL_CORE.poolScopeCounts === 'function')
    ? POOL_CORE.poolScopeCounts(rows)
    : { requirement: totalReq, registered: totalReq, fallback: 0, defect: totalDef, accepted: 0, unaccepted: 0, unregistered: 0 };
  const foot = $('#pool-foot');
  if (foot) {
    const unacceptedNote = scope.unaccepted ? `；已完成未验收 ${scope.unaccepted}（不计入已验收）` : '';
    const fallbackNote = scope.fallback ? `；另 ${scope.fallback} 条快照兜底行（单列、不计入口径）` : '';
    foot.textContent = `池内 ${rows.length} 条（需求 ${scope.registered}${fallbackNote} · 缺陷 ${totalDef}），当前显示 ${visible.length} 条${unacceptedNote}；状态：${statusLabel} · 类型：${kindLabel}${query ? ` · 搜索：${query}` : ''}`;
    foot.setAttribute('data-pool-total', String(rows.length));
    foot.setAttribute('data-pool-req', String(scope.registered));
    foot.setAttribute('data-pool-req-all', String(scope.requirement));
    foot.setAttribute('data-pool-fallback', String(scope.fallback || 0));
    foot.setAttribute('data-pool-def', String(totalDef));
    foot.setAttribute('data-pool-accepted', String(scope.accepted || 0));
    foot.setAttribute('data-pool-unaccepted', String(scope.unaccepted || 0));
  }
  const nomatch = $('#pool-nomatch');
  if (nomatch) nomatch.hidden = !(rows.length > 0 && visible.length === 0);
  const clearBtn = $('#pool-search-clear');
  if (clearBtn) clearBtn.hidden = !query;
  // 筛选后详情不能继续指向被筛掉的行（F-30e2-4）。
  if (poolUi.detailId && !visibleIds.has(poolUi.detailId)) closePoolDetail(false);
}
/** 未登记需求条：只有存在未登记需求时才显示（B-a17d AC4）。 */
function renderPoolGhostBar(rows) {
  const bar = $('#pool-ghost-bar');
  if (!bar) return;
  const ghosts = (Array.isArray(rows) ? rows : []).filter((row) => row && row.kind === 'requirement' && row.unregistered === true);
  bar.hidden = ghosts.length === 0;
  const text = $('#pool-ghost-text');
  if (text) {
    text.textContent = ghosts.length
      ? `有 ${ghosts.length} 条需求不在工作流里（面板看得到、流程推不动）：登记进工作流，或作废掉`
      : '';
  }
  const reg = $('#pool-ghost-register');
  const vd = $('#pool-ghost-void');
  if (reg) reg.textContent = ghosts.length > 1 ? `一键登记（${ghosts.length}）` : '一键登记';
  if (vd) vd.textContent = ghosts.length > 1 ? `一键作废（${ghosts.length}）` : '一键作废';
  bar.dataset.count = String(ghosts.length);
}
/** 渲染池子：数据集合变化才重建行节点；筛选/搜索只切 hidden。 */
/* R-c72a F5：需求池虚拟化——≥POOL_VIRTUAL_MIN_ROWS 行时只渲染可视区 ±POOL_VIRTUAL_BUFFER 行。
 * 行高单源 = 容器 #pool-req-list 的 data-row-height（缺省 POOL_VIRTUAL_ROW_H），CSS 用 --pool-row-h 同步。
 * 可视区 DOM 行数上限 = 可视行数 + 2 × 缓冲 + 2 个占位块（占位块 aria-hidden，无 .pool-row）。 */
const POOL_VIRTUAL_ROW_H = 36;
const POOL_VIRTUAL_MIN_ROWS = 200;
const POOL_VIRTUAL_BUFFER = 10;

function poolReqRows() {
  return (Array.isArray(poolUi.rows) ? poolUi.rows : []).filter((row) => row && row.kind === 'requirement');
}
function poolRowHeightPx() {
  const el = $('#pool-req-list');
  const raw = el ? parseInt(el.getAttribute('data-row-height') || '', 10) : NaN;
  return Number.isFinite(raw) && raw > 0 ? raw : POOL_VIRTUAL_ROW_H;
}
function poolVirtualBindScroll() {
  const el = $('#pool-req-list');
  if (!el || el.dataset.virtualBound === '1') return;
  el.dataset.virtualBound = '1';
  el.addEventListener('scroll', () => {
    if (!poolUi.virtual || poolUi.virtualRaf) return;
    poolUi.virtualRaf = true;
    const raf = window.requestAnimationFrame || ((fn) => setTimeout(fn, 16));
    raf(() => { poolUi.virtualRaf = false; poolVirtualPaint(); });
  }, { passive: true });
}
function poolVirtualPaint() {
  const el = $('#pool-req-list');
  const rows = poolUi.virtualRows || [];
  if (!el) return;
  if (!rows.length) {
    poolUi.virtual = null;
    delete el.dataset.virtual;
    el.innerHTML = '<p class="pool-empty">需求池暂无（评审通过后自动入池）</p>';
    return;
  }
  const rowH = poolRowHeightPx();
  // 只在行高真变化时写 CSS 变量：每次写都会让浏览器重算样式，滚动帧里是纯开销。
  if (el.style.getPropertyValue('--pool-row-h') !== rowH + 'px') el.style.setProperty('--pool-row-h', rowH + 'px');
  const viewport = Math.max(el.clientHeight || 0, rowH * 4);
  const top = Math.max(0, el.scrollTop || 0);
  const first = Math.max(0, Math.floor(top / rowH) - POOL_VIRTUAL_BUFFER);
  const last = Math.min(rows.length, Math.ceil((top + viewport) / rowH) + POOL_VIRTUAL_BUFFER);
  const lead = first * rowH;
  const tail = Math.max(0, (rows.length - last) * rowH);
  const leadHtml = lead > 0 ? '<div class="pool-virtual-gap" style="height:' + lead + 'px" aria-hidden="true"></div>' : '';
  const tailHtml = tail > 0 ? '<div class="pool-virtual-gap" style="height:' + tail + 'px" aria-hidden="true"></div>' : '';
  el.innerHTML = leadHtml + rows.slice(first, last).map(poolRowMarkup).join('') + tailHtml;
  poolUi.virtual = { first, last, total: rows.length, rowH };
  el.dataset.virtual = JSON.stringify(poolUi.virtual);
  poolVirtualBindScroll();
}
/** 统一入口：≥ 阈值走虚拟化，否则整块渲染（保持小列表既有行为）。 */
function poolApplyReqVisible(visibleReq) {
  const el = $('#pool-req-list');
  const rows = Array.isArray(visibleReq) ? visibleReq : [];
  if (!el) return;
  if (!el.getAttribute('data-row-height')) el.setAttribute('data-row-height', String(POOL_VIRTUAL_ROW_H));
  if (rows.length >= POOL_VIRTUAL_MIN_ROWS) {
    poolUi.virtualRows = rows;
    poolVirtualPaint();
    return;
  }
  poolUi.virtual = null;
  poolUi.virtualRows = rows;
  delete el.dataset.virtual;
  el.innerHTML = rows.length ? rows.map(poolRowMarkup).join('') : '<p class="pool-empty">需求池暂无（评审通过后自动入池）</p>';
}
function renderPoolReqList() {
  poolApplyReqVisible(poolReqRows());
}
function renderPool() {
  poolPanelEnsure();
  if (!POOL_CORE) {
    const reqList = $('#pool-req-list');
    const defList = $('#pool-def-list');
    if (reqList) reqList.innerHTML = '<p class="pool-empty">池子模块未加载：缺少 renderer/pool-core.js</p>';
    if (defList) defList.innerHTML = '';
    return;
  }
  const rows = Array.isArray(poolUi.rows) ? poolUi.rows : [];
  const signature = POOL_CORE.poolRowsSignature(rows);
  const reqList = $('#pool-req-list');
  const defList = $('#pool-def-list');
  renderPoolGhostBar(rows);
  renderBugRetractBar(rows);
  // 重建条件：数据集合变了、容器缺了、或两列都还没渲染过（空数据首次打开也要出空态文案）。
  const needsRebuild = signature !== poolUi.signature || !reqList || !defList
    || !reqList.childElementCount || !defList.childElementCount;
  if (needsRebuild) {
    const req = rows.filter((row) => row.kind === 'requirement');
    const def = rows.filter((row) => row.kind !== 'requirement');
    if (reqList) renderPoolReqList();
    if (defList) {
      // R5（T-20261118-182736-ac7f）：缺陷列表改用行级差量（同 key 复用节点，不整块 innerHTML 重建）。
      if (R4GateApi && typeof R4GateApi.reconcileReplaceMarkup === 'function') {
        R4GateApi.reconcileReplaceMarkup(defList, def, { keyOf: (row) => String(row.id || ''), markup: poolRowMarkup });
      } else {
        defList.innerHTML = def.length ? def.map(poolRowMarkup).join('') : '<p class="pool-empty">缺陷池暂无（评审通过的缺陷自动入池）</p>';
      }
    }
    poolUi.signature = signature;
    // 详情打开时数据变了：按 data-id 重渲染，不继续显示旧数据（并发边界）。
    if (poolUi.detailId) {
      if (rows.some((row) => row.id === poolUi.detailId)) openPoolDetail(poolUi.detailId);
      else closePoolDetail(false);
    }
  }
  renderPoolChips();
  applyPoolFilters();
}
/** 详情：打开 / 关闭（Esc、关闭按钮、筛选切换都走 closePoolDetail）。 */
function poolRowNode(id) {
  const text = String(id || '').replace(/["\\]/g, '\\$&');
  return document.querySelector(`.pool-row[data-id="${text}"]`);
}
function togglePoolDetail(id) {
  if (!id) return;
  if (poolUi.detailId === id) { closePoolDetail(); return; }
  openPoolDetail(id);
}
function openPoolDetail(id) {
  const row = (poolUi.rows || []).find((item) => item.id === id);
  const host = $('#pool-detail-host');
  if (!row || !host || !POOL_CORE) return;
  host.innerHTML = POOL_CORE.poolDetailMarkup(row);
  host.hidden = false;
  poolUi.detailId = id;
  const mask = $('#pool-mask');
  if (mask) mask.classList.add('detail-open');
  document.querySelectorAll('.pool-row[aria-expanded="true"]').forEach((node) => {
    if (node.dataset.id !== id) node.setAttribute('aria-expanded', 'false');
  });
  const node = poolRowNode(id);
  if (node) node.setAttribute('aria-expanded', 'true');
}
function closePoolDetail(refocus) {
  const host = $('#pool-detail-host');
  const prevId = poolUi.detailId;
  if (host) { host.hidden = true; host.innerHTML = ''; }
  poolUi.detailId = '';
  const mask = $('#pool-mask');
  if (mask) mask.classList.remove('detail-open');
  document.querySelectorAll('.pool-row[aria-expanded="true"]').forEach((node) => node.setAttribute('aria-expanded', 'false'));
  if (refocus !== false && prevId) {
    const node = poolRowNode(prevId);
    if (node && !node.hidden) node.focus();
  }
}
/** 详情里的链接：只读打开（files:open），失败就地提示，不触发整行重开。 */
async function openPoolLink(link) {
  const rel = String((link && link.dataset && link.dataset.poolRel) || '');
  const p = activeProject();
  if (!rel || !p || !window.workbench || typeof window.workbench.filesOpen !== 'function') return;
  try {
    const err = await window.workbench.filesOpen({ projectId: p.id, rel });
    if (err) throw new Error(String(err));
  } catch (error) {
    const note = $('#pool-detail-host .pool-detail-link-note') || $('#pool-detail-host .pool-detail-note');
    if (note) {
      note.hidden = false;
      note.classList.add('pool-detail-link-note');
      note.textContent = `打不开：${rel}（${String((error && error.message) || error).slice(0, 120)}）`;
    }
  }
}

/* ── R-f9b1 增补卷（16KB 拆分产物）可读性 ────────────────────────────────
 * 卷必须"不靠知道路径也能找到、不靠记忆也能引用"：池详情 / 评审材料 / 项目面板 / 主正文头部
 * 四处都能看到 name + 字节 + sha256(12)，点开**在界面里只读看内容**（不是只给一个路径）。
 * 读取只走主进程 files:read：项目内 realpath 校验（防目录穿越）+ 512KB 文本上限，绝不写盘。
 * 卷缺失/读不出 → 明说 SUPPLEMENT_MISSING + 路径，不静默返回半份内容。
 */
async function openSupplementViewer(rel, info) {
  const p = activeProject();
  const meta = info && typeof info === 'object' ? info : {};
  const target = String(rel || meta.rel || '');
  if (!p || !target) { toast('没有可打开的卷', 'warn'); return; }
  const name = String(meta.name || target.split('/').pop() || target);
  const bytes = meta.bytes !== undefined && meta.bytes !== null && String(meta.bytes) !== '' ? Number(meta.bytes) : null;
  const sha = String(meta.sha256 || '');
  const headText = [name, Number.isFinite(bytes) ? fmtSize(bytes) : '字节未记录', sha ? 'sha256 ' + sha.slice(0, 12) : 'sha 未记录'].join(' · ');
  const reqId = String(meta.requirementId || meta.req || '');
  const dlg = openModal({
    title: '增补卷（只读）',
    subtitle: `${headText} · ${target}`,
    icon: '📄',
    width: 820,
    body: `<div class="supplement-viewer" data-supplement-viewer="${esc(target)}" data-supplement="1" data-supplement-name="${esc(name)}" data-supplement-bytes="${Number.isFinite(bytes) ? bytes : ''}" data-supplement-sha="${esc(sha)}" data-supplement-req="${esc(reqId)}">
      <div class="supplement-viewer-head"><b>${esc(name)}</b><span>${esc(Number.isFinite(bytes) ? String(bytes) + ' B' : '字节未记录')}</span><span class="mono">${esc(sha ? 'sha256 ' + sha.slice(0, 12) : 'sha 未记录')}</span>${reqId ? `<span class="mono">所属 ${esc(reqId)}</span>` : ''}</div>
      <p class="supplement-viewer-note">只读查看：卷是主正文的 16KB 拆分产物，不纳入每次必读；这里不修改任何文件。</p>
      <div class="supplement-viewer-doc"></div>
      <pre class="supplement-viewer-body">读取中…</pre>
    </div>`,
    actions: [
      {
        label: '用系统程序打开', kind: 'ghost', onClick: async ({ error: showError }) => {
          try {
            const err = await window.workbench.filesOpen({ projectId: p.id, rel: target });
            if (err) throw new Error(String(err));
          } catch (error) { showError('打开失败：' + humanError(error.message)); }
        }
      },
      { label: '关闭', kind: 'primary', onClick: ({ close }) => close() }
    ]
  });
  const body = dlg && dlg.body ? dlg.body.querySelector('.supplement-viewer-body') : null;
  const docBox = dlg && dlg.body ? dlg.body.querySelector('.supplement-viewer-doc') : null;
  try {
    const r = await window.workbench.filesRead({ projectId: p.id, rel: target, textMaxBytes: 512 * 1024 });
    if (!r || r.ok === false) throw new Error((r && (r.code || r.message)) || '读取失败');
    const text = String(r.text || '');
    if (body) body.textContent = text || '（空文件）';
    if (docBox && POOL_CORE && typeof POOL_CORE.supplementHeaderMarkup === 'function') {
      docBox.innerHTML = POOL_CORE.supplementHeaderMarkup(text, { title: '这份文档头部还列了增补卷' });
    }
  } catch (error) {
    const detail = String((error && error.message) || error).slice(0, 240);
    if (body) {
      body.textContent = `读不到这份卷（SUPPLEMENT_MISSING）：${target}\n${detail}\n\n`
        + '卷可能被删除或改名；主正文与其余材料照常可读，请让 PM/分析师补卷后再验收。';
    }
  }
}

function clearPoolSearch() {
  poolUi.query = '';
  const input = $('#pool-search');
  if (input) input.value = '';
  applyPoolFilters();
}
function resetPoolFilters() {
  poolUi.query = '';
  poolUi.filter = 'all';
  poolUi.kindFilter = 'all';
  const input = $('#pool-search');
  if (input) input.value = '';
  if (poolUi.detailId) closePoolDetail(false);
  applyPoolFilters();
}
async function refreshPool(projectId) {
  const pid = String(projectId || ((activeProject() || {}).id) || '');
  // R-c72a AC2（批3）：不再用 loading 做硬闸（旧闸一旦卡住就永久不再刷新）；改序号，只让最后一次请求写回。
  poolUi.fetchSeq += 1;
  const seq = poolUi.fetchSeq;
  poolUi.loading = true;
  try {
    const rows = await poolFetchRows(pid);
    if (seq !== poolUi.fetchSeq) return;
    if (rows) {
      poolUi.rows = rows;
      poolUi.lastFetch = Date.now();
      if (pid) poolUi.byProject[pid] = rows;
    }
    if (poolUi.open) renderPool();
  } finally {
    if (seq === poolUi.fetchSeq) poolUi.loading = false;
  }
}
async function togglePool(force) {
  const mask = poolPanelEnsure();
  const next = typeof force === 'boolean' ? force : mask.hidden;
  poolUi.open = next;
  mask.hidden = !next;
  if (!next) {
    if (poolUi.detailId) closePoolDetail(false);
    return;
  }
  r5Skeleton('#pool-req-list', '需求池加载中…', 5);
  r5Skeleton('#pool-def-list', '缺陷池加载中…', 5);
  await refreshPool();
  void prefetchPoolRows(); // R-c72a AC2：预取各项目需求行，切项目时先同步换列表
}
/** 预取所有项目的需求行（只读、串行，失败跳过；缓存由每次 refreshPool 覆盖刷新）。 */
async function prefetchPoolRows() {
  const projects = Array.isArray(state && state.projects) ? state.projects : [];
  for (const p of projects) {
    if (!p || !p.id || poolUi.byProject[p.id]) continue;
    const rows = await poolFetchRows(p.id);
    if (Array.isArray(rows)) poolUi.byProject[p.id] = rows;
  }
}
function closePool() {
  const mask = $('#pool-mask');
  if (mask) mask.hidden = true;
  poolUi.open = false;
  if (poolUi.detailId) closePoolDetail(false);
}
async function refreshPoolBadge() {
  if (Date.now() - poolUi.lastFetch < 5000) return;
  const rows = await poolFetchRows();
  if (!rows) return;
  poolUi.rows = rows;
  poolUi.lastFetch = Date.now();
  const n = rows.filter(poolEntered).length;
  const badge = $('#tb-pool');
  if (badge) badge.textContent = String(n);
}

function flowMeta(p) {
  const evidence = legacyFlowEvidence(p);
  const boot = legacyBootSummary();
  const projectOwner = ownerState({ ...p, ownerReview: evidence.ownerReview });
  const req = evidence.requirement;
  const reqOwner = legacyReqOwnerView(req);
  const { caps } = legacyCapabilityData();
  const missing = caps && Array.isArray(caps.missing) ? caps.missing.length : null;
  const closure = evidence.phase === 'terminated' ? '已终止'
    : (['accepted', 'iteration'].includes(evidence.phase) ? '待选择迭代/终止' : '未到');
  const reqText = req
    ? `${poolTypeLabel(req)} ${req.id}（${legacyReqStatus(req)}）· Owner ${reqOwner.label}`
    : '还没有需求';
  // F-9fbe-6：这里只报状态，分叉/待补的具体数字只在顶部真源条出现一次。
  const ledgerText = evidence.ledger.length ? '账本分叉（见处置行）' : '账本一致';
  return `当前 ｜ 阶段：${evidence.phase} ｜ ${bootStatusText(boot)} ｜ 需求 ${evidence.requirementCount}（已验收 ${evidence.accepted}）｜ 当前需求：${reqText} ｜ 任务 ${evidence.tasks.length} ｜ 项目级 Owner：${projectOwner.label}（不参与派单）｜ 收口：${closure} ｜ 待回执：${evidence.pending ? roleById(evidence.pending.to).name : '无'} ｜ 旧命令缺失：${missing === null ? '未知' : missing} ｜ ${ledgerText}`;
}

function renderLegacyCapabilities() {
  const box = $('#legacy-capabilities');
  if (box) box.innerHTML = legacyCapabilitiesMarkup();
  const badge = $('#legacy-cap-badge');
  if (badge) {
    const { caps } = legacyCapabilityData();
    const missing = caps && Array.isArray(caps.missing) ? caps.missing : [];
    const unknown = caps ? legacyCapabilityUnknownLabels(caps) : [];
    if (!caps) {
      badge.textContent = '能力待核验';
      badge.className = 'badge muted-badge';
      badge.title = '正在从 workflow:state / team:status 读取旧命令能力；矩阵返回前不显示为齐全';
    } else if (!caps.available) {
      badge.textContent = '旧工具缺失';
      badge.className = 'badge badge-rejected';
      badge.title = caps.file || 'team.mjs 不存在';
    } else if (caps.assumed) {
      badge.textContent = '团队工具存在 · 矩阵待核验';
      badge.className = 'badge badge-skipped';
      badge.title = caps.note || 'team:status 确认 team.mjs 存在；workflow:state 还没有返回命令矩阵';
    } else if (missing.length) {
      badge.textContent = `缺 ${missing.length} 条旧命令`;
      badge.className = 'badge badge-skipped';
      badge.title = missing.join('、');
    } else if (unknown.length) {
      badge.textContent = `未核验 ${unknown.length}`;
      badge.className = 'badge muted-badge';
      badge.title = `能力矩阵没有探测：${unknown.join('、')}；不显示成缺失，也不当作可用`;
    } else {
      badge.textContent = '旧命令齐全';
      badge.className = 'badge badge-approved';
      badge.title = 'team.mjs 命令矩阵全部可用';
    }
  }
  const lastBox = $('#legacy-last-action');
  if (lastBox) {
    lastBox.innerHTML = legacyLastActionMarkup();
    lastBox.hidden = false;
  }
}

function legacyOwnerPanelMarkup(p) {
  const terms = modeTerms(p);
  const wf = legacyWorkflow() || {};
  const req = legacyActiveRequirement();
  const reqOwner = legacyReqOwnerView(req);
  const reviewRole = isQuickTeam() ? 'analyst' : 'product';
  const reviewReady = legacyRoleReady(reviewRole);
  const reviewBoot = legacyBootFor(reviewRole);
  const reviewLabel = terms.review;
  const ownerReviewGate = legacyActionCommandGate('owner-review');
  const projectOwner = wf.ownerReview || p.ownerReview || {};
  const projectState = ownerState({ ...p, ownerReview: projectOwner });
  const roundKey = wf.roundKey || projectOwner.roundKey || '—';
  const ownerDecided = ['approved', 'skipped', 'rejected'].includes(String(reqOwner.status));
  const ownerConfirm = req ? legacyOwnerConfirmationFor(reqOwner.owner, req.id, 'owner') : null;
  const ownerActor = (reqOwner.owner && String(reqOwner.owner.actor || '').trim())
    || (ownerConfirm && ownerConfirm.actor) || '';
  const ownerActorLocal = Boolean(ownerConfirm && !(reqOwner.owner && reqOwner.owner.actor));
  const ownerBy = reqOwner.owner && String(reqOwner.owner.by || '').trim();
  const ownerRecordFields = ownerDecided
    ? `<span>by=<code>${esc(ownerBy || '未记录')}</code></span>${ownerActor
      ? `<span>actor=<code>${esc(ownerActor)}</code>${ownerActorLocal ? '（本机点击）' : ''}</span>`
      : '<span class="bad">actor=记录人未认证</span>'}`
    : '<span class="warn" title="还没有 Owner 决定记录：可在评审弹窗决定，或继续等待">待 Owner（尚无决定记录）</span>';
  const reqLine = req
    ? `<div class="legacy-owner-req-head"><b>${esc(req.title || '未写标题')}</b><code>${esc(req.id)}</code><span class="badge ${reqOwner.status === 'rejected' ? 'badge-rejected' : (['approved', 'skipped'].includes(reqOwner.status) ? 'badge-approved' : 'badge-skipped')}">Owner ${esc(reqOwner.label)}</span></div>
      <p>需求状态：<b>${esc(legacyReqStatus(req))}</b> · ${esc(reviewLabel)}：${req.productReview ? esc(req.productReview.verdict || '未写结论') + ' · ' + esc(legacyActorText(req.productReview.by, 'actor ' + (req.productReview.actor || '未记录'))) : '未记录'}</p>
      <div class="legacy-owner-fields">${ownerRecordFields}<span>at=${esc(ownerDecided && reqOwner.owner && reqOwner.owner.at ? fmtTime(reqOwner.owner.at) : '未记录')}</span><span class="${reviewReady ? 'ok' : 'warn'}" title="B-2e5：boot 记录只作记录，不再把未 boot 当红项">${esc(roleById(reviewRole).name)}：${esc(reviewBoot.label)}</span></div>
      ${reqOwner.owner && reqOwner.owner.opinion ? `<p>Owner 意见：${esc(reqOwner.owner.opinion)}</p>` : '<p>还没有需求级 Owner 意见；Owner 可参与评审，也可明确跳过。</p>'}
      ${req && String(req.status) === 'approved'
        ? `<div class="legacy-req-actions">
          <span class="legacy-req-chip ok" title="${isQuickTeam() ? 'Fast 后端壳收口：一次点击直接调用 requirement:owner，不依赖旧 owner 命令' : '一次点击直接调用 requirement:owner，无需二次确认'}">Owner（我）一次点击</span>
          ${legacyOwnerQuickButton('review', req, 'approved', 'Owner（我）通过')}
          ${legacyOwnerQuickButton('review', req, 'skipped', 'Owner（我）跳过')}
          ${legacyOwnerQuickButton('review', req, 'rejected', 'Owner（我）打回')}
          <button class="ghost small" type="button" data-legacy-req-action="owner-review" data-req-id="${esc(req.id)}" ${ownerReviewGate.ok ? '' : 'disabled'} title="${!ownerReviewGate.ok ? ownerReviewGate.reason : (reviewReady ? `打开需求 Owner 评审写意见；后端校验 ${roleById(reviewRole).name} 已 boot/读全` : `${roleById(reviewRole).name}未 boot/未读全；点击执行会先自动 boot，再调用 requirement:owner`)}">写意见再决定…</button>
        </div>`
        : (req ? `<p class="hint">只有${esc(reviewLabel)}通过（approved）的需求才进入 Owner 闸门。</p>` : '')}`
    : (legacyRequirements().length
      ? `<p>当前没有在办需求（已有 ${legacyRequirements().length} 条需求，均不在当前在办）。Owner 的“参与 / 跳过”发生在${esc(reviewLabel)}通过之后；新需求从「迭代（收口后）」开始。</p>`
      : `<p>还没有需求。Owner 的“参与 / 跳过”发生在${esc(reviewLabel)}通过之后；先建需求并完成${esc(reviewLabel)}。</p>`);
  return `<div class="legacy-owner-panel">
    <div class="legacy-flow-owner-head"><b>需求级 Owner 闸门：可参与评审 / 也可明确跳过</b><span class="badge badge-${esc(reqOwner.key)}">Owner ${esc(reqOwner.label)}</span></div>
    <div class="legacy-owner-req">${reqLine}</div>
    ${req ? ownerDecisionsMarkup(req, { compact: true }) : ''}
    <div class="legacy-owner-legacy">
      <b>项目级 Owner（旧版）：</b>只写顶层 <code>ownerReview</code>，不写入任何需求的 <code>ownerReview</code>，<b>不参与 PM 派单</b>。当前：${esc(projectState.label)}${projectOwner.at ? ' · ' + esc(fmtTime(projectOwner.at)) : ''} · roundKey <code title="${esc(String(roundKey))}">${esc(String(roundKey).slice(-28))}</code>
      <button class="ghost small" type="button" data-open-owner-legacy title="打开旧版项目级 Owner 评审，界面会再次标注它不参与需求派单">打开旧版项目级评审</button>
    </div>
  </div>`;
}

function renderLegacyFlowExtras(p) {
  const gateBox = $('#legacy-flow-gate');
  if (gateBox) gateBox.innerHTML = legacyGateResultMarkup();
  const ledgerBox = $('#legacy-flow-ledger');
  if (ledgerBox) ledgerBox.innerHTML = legacyLedgerMarkup();
  renderLegacyCapabilities();
  const ownerBox = $('#legacy-flow-owner');
  if (ownerBox) ownerBox.innerHTML = legacyOwnerPanelMarkup(p);
  const actions = $('#legacy-flow-actions');
  if (actions) {
    // F-9fbe-1/F-2：流程页的「推进当前」与项目面板同一分级——只有 block 才禁用并出现拦截词。
    const gateState = legacyGateState();
    const overviewPlaceholder = gateState.topics.some((row) => row.id === 'overview-placeholder');
    const terminated = gateState.terminated;
    const pmReady = legacyRoleReady('pm') && !terminated;
    const canAdvance = gateState.open;
    const iterateGate = legacyActionCommandGate('iterate');
    const shellOwnedIterate = Boolean(iterateGate.shellOwned);
    const terminateGate = legacyActionCommandGate('terminate');
    const ownerDemandGate = legacyActionCommandGate('owner-demand');
    // “向 PM 提交需求（Owner）”只在项目开始 / 评审 / 迭代阶段显示。
    const phase = legacyWorkflow() ? String(legacyWorkflow().phase || '') : '';
    const ownerDemandVisible = ['', 'idle', 'requirement', 'requirement_review', 'owner_review', 'iteration'].includes(phase);
    const missingCommands = [...new Set([
      ...iterateGate.missing, ...terminateGate.missing, ...ownerDemandGate.missing
    ])];
    const unknownCommands = [...new Set([
      ...iterateGate.unknown, ...terminateGate.unknown, ...ownerDemandGate.unknown
    ])];
    const blockedByMissing = [
      ['迭代', iterateGate], ['终止', terminateGate], ['向 PM 提交需求', ownerDemandGate]
    ].filter(([, gate]) => !gate.ok && (gate.missing || []).length).map(([name]) => name);
    const iterateGuard = legacyIterateGuard();
    const iterateReady = iterateGuard.ok;
    const iterateVisibleWhy = ['open-requirements', 'not-accepted', 'no-requirements', 'placeholder'].includes(iterateGuard.code)
      ? iterateGuard.reason : '';
    const terminateReady = !terminated && terminateGate.ok;
    const ownerDemandReady = !terminated && ownerDemandGate.ok;
    const gateData = activeProject() && gateUi.projectId === activeProject().id ? gateUi.data : null;
    // 闸门判定与原因：只展示 team.mjs 返回的结果；接口未就绪就写“待接入”，壳层不自己判。
    const gateReasonParts = [];
    if (gateData && gateData.unavailable) {
      gateReasonParts.push(`<span class="legacy-action-warn">闸门判定待接入：${esc(gateData.error)}（接口约定：<code>gate:check</code> → <code>team-tools.gateCheck</code>，TODO(接口)）</span>`);
    } else if (gateData && gateData.available) {
      const denied = [...gateData.gates.values()].filter((entry) => !entry.ok);
      gateReasonParts.push(`<span class="legacy-action-note">闸门判定：team.mjs 返回 ${gateData.gates.size} 项${denied.length ? ' · 未满足：' + denied.map((entry) => esc(entry.gate || entry.code || entry.action)).join('、') : ' · 全部满足'}</span>`);
    }
    actions.innerHTML = `
      <button class="primary small" type="button" id="legacy-flow-advance" ${canAdvance ? '' : 'disabled'} data-legacy-scroll="requirements" data-panel-level="${gateState.level}" title="${canAdvance ? '跳到需求队列' : panelBlockReasonText(gateState)}">${canAdvance ? '查看当前动作' : PANEL_BLOCK_LABEL}</button>
      <button class="ghost small" type="button" id="legacy-flow-iterate" ${iterateReady ? '' : 'disabled'} data-legacy-req-action="iterate" title="${esc(iterateGuard.reason || '启动下一次（PM）；执行前会自动补 boot')}">迭代（下一次）</button>
      <button class="ghost small danger" type="button" id="legacy-flow-terminate" ${terminateReady ? '' : 'disabled'} data-legacy-req-action="terminate" title="${esc(!terminateGate.ok ? terminateGate.reason : (terminated ? (legacyTerminateReasonText() || '工作流已终止') : (pmReady ? 'workflow:terminate（PM）' : 'PM 未 boot/未读全；点击执行会先自动 boot，再调用 workflow:terminate')))}">终止</button>
      <button class="ghost small" type="button" data-legacy-req-action="owner-demand" ${ownerDemandVisible ? '' : 'hidden'} ${ownerDemandReady ? '' : 'disabled'} title="${esc(!ownerDemandGate.ok ? ownerDemandGate.reason : (terminated ? (legacyTerminateReasonText() || '工作流已终止') : '向 PM 提交需求（Owner）：owner:demand，描述 / 优先级 / 验收标准（可多条），PM 自动 boot 代办建档'))}">向 PM 提交需求（Owner）</button>
      <button class="ghost small" type="button" data-legacy-go="docs">必读与目录</button>
      <button class="ghost small" type="button" data-open-team>团队台 / 派单</button>
      ${gateState.warns.length ? `<span class="legacy-action-note">${esc(panelLevelLabel('warn', gateState.warns.length))}：${esc(gateState.warns.map((row) => row.text).join('；'))}（不拦推进）</span>` : ''}
      ${iterateVisibleWhy ? `<span class="legacy-action-warn">迭代不可用：${esc(iterateVisibleWhy)}</span>` : ''}
      ${overviewPlaceholder ? '<span class="legacy-action-note">需求总览待首条需求：第一条需求落盘时会被重写，不挡 boot。</span>' : ''}
      ${missingCommands.length ? `<span class="legacy-action-warn">当前缺旧命令：${missingCommands.map((name) => `<code>${esc(name)}</code>`).join('、')}；${blockedByMissing.length ? blockedByMissing.join('、') + ' 按钮已禁用，' : ''}先升级团队工具，界面不会伪造成功。${shellOwnedIterate ? '（迭代在 Fast 由工作台壳层推进，不依赖旧 workflow 命令）' : ''}</span>` : ''}
      ${unknownCommands.length ? `<span class="legacy-action-warn">旧命令未核验：${unknownCommands.map((name) => `<code>${esc(name)}</code>`).join('、')}；能力矩阵没有返回这些命令，对应按钮暂时禁用，不写成缺失。</span>` : ''}
      ${gateReasonParts.join('')}
      <span class="legacy-action-note">所有动作调用真实 <code>workflow:*</code> IPC；所需角色未 boot/未读全时，执行前会自动补一次真实 boot，后端仍校验阅读证据；旧命令明确缺失才写“缺”，矩阵没返回只写“未核验”，两种情况都不伪造成功。迭代另需全部需求验收（或被投票驳回收口）且无在办需求。</span>`;
  }
}

/**
 * 流程图实时刷新：只读 workflow:state / workflow:next，不写文件、不重读全部文档。
 * 角色用 team.mjs 直接改文件时，界面最多 5 秒跟上；失败按 2s/5s/10s 退避，隐藏时暂停。
 *
 * B-20261116-095320-410e：面板数据必须能证明「什么时候读的」——
 *   refreshedAt = 最后一次成功读到工作流的时刻（用快照 readAt 优先，其次本机读到的时间）；
 *   超过 60 秒没刷新就 stale=true，界面写「数据可能过期」，不许静默停在旧数字（AC3）。
 */
const flowLiveState = { failures: 0, nextAt: 0, refreshedAt: 0, lastError: null, loading: false };
const FLOW_STALE_AFTER_MS = 60000;

async function refreshFlowLive() {
  const p = activeProject();
  if (!p || !window.workbench) return false;
  if (flowLiveState.loading) return false;
  const flowOpen = !$('#flow-panel')?.hidden;
  if (!flowOpen && openDrawerName !== 'project' && activeTab !== 'flow') return false;
  const wb = window.workbench;
  flowLiveState.loading = true;
  try {
    const [wf, nx] = await Promise.all([
      typeof wb.workflowState === 'function' ? wb.workflowState({ projectId: p.id }).catch(() => null) : null,
      typeof wb.workflowNext === 'function' ? wb.workflowNext({ projectId: p.id }).catch(() => null) : null
    ]);
    if (!wf || wf.ok === false) throw new Error((wf && (wf.message || wf.code)) || 'workflow:state 未返回');
    if (!activeProject() || activeProject().id !== p.id) return false;
    const reqs = nx && nx.ok && Array.isArray(nx.requirements)
      ? nx.requirements
      : (Array.isArray(wf.requirements) ? wf.requirements : []);
    const round = Number((nx && nx.round) || wf.round || 1);
    const derivation = mergeFlowDerivation(
      legacyUi.flowDerive,
      flowDerivationFrom({ ...wf, requirements: reqs, round }),
      p.id,
      round
    );
    legacyUi.flowDerive = derivation;
    const phase = legacyDisplayPhase(derivation.phase, reqs);
    legacyUi.workflow = {
      ...(legacyUi.workflow || {}),
      ...wf,
      phase,
      requirements: reqs,
      tasks: Array.isArray(wf.tasks) ? wf.tasks : ((legacyUi.workflow && legacyUi.workflow.tasks) || []),
      round,
      derivation
    };
    legacyUi.workflowError = null;
    flowLiveState.failures = 0;
    flowLiveState.lastError = null;
    // 数据时间戳：优先用快照自带的读盘时间（readAt，来自团队工具实时读 工作流.json）；
    // 老快照没有 readAt 时退回“本机读到的时刻”，仍可证明刷新节奏。
    const readAtMs = Date.parse(String((wf && wf.readAt) || ''));
    flowLiveState.refreshedAt = Number.isFinite(readAtMs) ? readAtMs : Date.now();
    // R-db98 v2：验收要求「状态变化 5 秒内刷新」；节流 4 秒 + 1 秒心跳，保证最坏 5 秒内命中。
    flowLiveState.nextAt = Date.now() + 4000;
    renderFlow();
    // 闸门判定与审计也只读拉取；接口未就绪时显示“待接入”，不影响流程渲染。
    loadGateCheck();
    loadGateAudit();
    return true;
  } catch (error) {
    flowLiveState.failures += 1;
    flowLiveState.lastError = String((error && (error.message || error.code)) || error || '刷新失败').slice(0, 120);
    const delay = flowLiveState.failures <= 1 ? 2000 : (flowLiveState.failures === 2 ? 5000 : 10000);
    flowLiveState.nextAt = Date.now() + delay;
    // 只读刷新失败不打断界面，也不拿旧值冒充；下次按退避重试，面板上写明「数据可能过期」。
    renderFlow();
    return false;
  } finally {
    flowLiveState.loading = false;
  }
}

/** 1 秒心跳 + 5 秒节流：面板不可见时暂停，重新打开立即刷新一次。
 *  B-410e：主界面「流程」页签（activeTab==='flow'）也算可见——以前只有浮窗/项目抽屉打开才刷新，
 *  流程页停在旧快照上会继续显示「可派单」，而工作流里早已作废/终止。 */
function flowRefreshTick() {
  const p = activeProject();
  const flowOpen = !$('#flow-panel')?.hidden;
  if (!p || (!flowOpen && openDrawerName !== 'project' && activeTab !== 'flow')) { flowLiveState.nextAt = 0; return; }
  if (Date.now() < flowLiveState.nextAt) return;
  // R5（T-20261118-175633-18e8）：首屏先骨架（同步出现，≤200ms 感知），数据到达后由 flow 渲染替换。
  try {
    const board = $('#flow-board');
    if (board && !board.children.length && R4GateApi && typeof R4GateApi.skeleton === 'function') {
      R4GateApi.skeleton(board, { rows: 6, label: '流程图加载中…' });
    }
  } catch { /* 骨架失败不影响刷新 */ }
  refreshFlowLive();
}

/** 主流程面板上次渲染签名：数据没变就不重建大 DOM（5 秒轮询只刷新数据，不重复排版）。 */
const flowRenderUi = { projectId: '', sig: '' };

/** 流程面板内容签名：工作流/需求/任务/boot/闸门审计任一变化才重绘。
 * B-20261113-005026-c447：补 Owner 决定与落账字段。旧签名只有需求行 id/status/updatedAt，
 * Owner 只改 ownerReview（点通过/先跳过、写 decisions）而需求行 status/updatedAt 没动时签名不变 →
 * 右下角流程图不重绘，看起来“点了没反应”。现在把 ownerReview.status、decisions 条数与最近决定时间、
 * 账本分叉条数一起算进签名：判定后 5 秒轮询拿到新数据就会重绘。 */

/** v4 流程面板数据：从工作流 requirements 构建（优先级排序、卡点/冲突/验收人）。
 *  B-20261116-095320-410e：口径与评审界面 / 需求缺陷池同源——
 *   ① 总数只认工作流需求行（registered）；快照兜底行单列（fallbackCount），不计入 total/open/closed；
 *   ② 行状态文案走 review-list-core 的 UI3_STATUS_TEXT（唯一一张表），已作废/已终态的永不显示「可派单」；
 *   ③ 数据带 refreshedAt + stale（超过 60 秒没刷新 → 界面写「数据可能过期」）。
 */
const FLOW_CLOSED_STATUSES = ['accepted', 'done', 'terminated', 'iteration', 'rejected'];
/** 取 UI3 纯逻辑（review-list-core.js 在 app.js 之后加载，这里按调用时惰性取）。 */
function flowUi3() {
  return (typeof window !== 'undefined' && window.ReviewListCore) ? window.ReviewListCore : null;
}
function flowV4Data() {
  const wf = legacyWorkflow() || {};
  const allReqs = Array.isArray(wf.requirements) ? wf.requirements : [];
  const ui3 = flowUi3();
  // 口径：工作流需求行；快照兜底行（task-only / legacy-doc）单列说明，不混进 total/open/closed。
  const isFallback = (r) => (ui3 && typeof ui3.UI3_isFallbackRow === 'function')
    ? ui3.UI3_isFallbackRow(r)
    : Boolean(r && (r.unregistered === true || r.registered === false || r.source === 'task-only' || r.source === 'legacy-doc'));
  const reqs = allReqs.filter((r) => !isFallback(r));
  const fallbackCount = allReqs.length - reqs.length;
  const byId = new Map(reqs.map((r) => [String(r.id), r]));
  const nameOf = (id) => String((byId.get(id) || {}).title || id || '');
  const PRI = { P0: 0, P1: 1, P2: 2, P3: 3 };
  const items = reqs.map((r) => {
    const status = String(r.status || '');
    const decisions = Array.isArray(r.decisions) ? r.decisions : [];
    const acceptEv = [...(Array.isArray(r.history) ? r.history : [])].reverse()
      .find((ev) => ev && (ev.action === 'owner_accept' || ev.action === 'accept'));
    let acceptor = '';
    if (acceptEv) {
      const by = String(acceptEv.by || '');
      acceptor = /pm/i.test(by) && /owner/i.test(by) ? 'PM（Owner 授权）' : (/owner/i.test(by) ? 'Owner' : (by || 'Owner'));
    } else {
      const acc = [...decisions].reverse().find((d) => d && (d.action === 'accept' || d.status === 'accepted'));
      if (acc) {
        const actor = String(acc.actor || '');
        const by = String(acc.decidedBy || acc.by || '');
        acceptor = actor === 'pm' ? 'PM（Owner 授权）' : (actor === 'owner' || /owner/i.test(by) ? 'Owner' : (by || actor || 'PM'));
      }
    }
    let blocker = null;
    if (status === 'rejected') blocker = { reason: '需求评审被驳回', who: '产品设计师' };
    else if (r.trq && r.trq.verdict === 'not_testable') blocker = { reason: 'TR-Q 未通过（不可测）', who: '测试人员' };
    const text = String(r.detail || '') + ' ' + String(r.story || '');
    const deps = []; const conflicts = [];
    const depRe = /依赖[：:]\s*(R-\d{8}-\d{6}-[0-9a-f]{4})/gi;
    let m;
    while ((m = depRe.exec(text))) { const id = m[1]; if (id !== r.id && !deps.some((d) => d.id === id)) deps.push({ id, name: nameOf(id) }); }
    const cflRe = /冲突[：:]\s*(R-\d{8}-\d{6}-[0-9a-f]{4})/gi;
    while ((m = cflRe.exec(text))) { const id = m[1]; if (id !== r.id && !conflicts.some((c) => c.id === id)) conflicts.push({ id, name: nameOf(id) }); }
    const created = Date.parse(r.createdAt || '') || 0;
    const days = created ? Math.max(0, Math.round((Date.now() - created) / 86400000)) : 0;
    const iterations = Array.isArray(r.history) ? r.history.filter((ev) => ev && ev.action === 'iterate').length : 0;
    const closed = FLOW_CLOSED_STATUSES.includes(status);
    // 「可派单」只认 ready 且未作废、未收口（UI3_isDispatchable 是唯一判据）。
    const dispatchable = (ui3 && typeof ui3.UI3_isDispatchable === 'function')
      ? ui3.UI3_isDispatchable(r)
      : (status === 'ready' && r.voided !== true);
    const baseText = (ui3 && typeof ui3.UI3_statusTextOf === 'function')
      ? ui3.UI3_statusTextOf(status)
      : '';
    const statusText = r.voided === true && !closed ? '已作废'
      : (status === 'ready' ? (dispatchable ? '可派单' : '待派单（不可派）') : baseText);
    return {
      id: String(r.id || ''), title: String(r.title || ''), pri: String(r.priority || 'P2').toUpperCase(),
      owner: String(r.owner || r.createdBy || ''), status, statusText, stage: 0,
      updatedAt: String(r.updatedAt || ''), closedAt: String(r.closedAt || ''), round: Number(r.round || wf.round || 1),
      closed, voided: r.voided === true, dispatchable,
      iterationRound: iterations, acceptor, blocker, deps, conflicts,
      elapsed: days ? days + ' 天' : ''
    };
  });
  items.sort((x, y) => (PRI[x.pri] ?? 9) - (PRI[y.pri] ?? 9) || String(y.updatedAt).localeCompare(String(x.updatedAt)));
  const activeStatuses = ['approved', 'ready', 'dispatched', 'dev', 'dev_review', 'test', 'test_done'];
  const active = items.filter((i) => activeStatuses.includes(i.status)).length;
  const closedCount = items.filter((i) => i.closed).length;
  const parallel = [
    { key: 'review-dev', on: items.some((i) => ['approved', 'ready'].includes(i.status)) && items.some((i) => ['dev', 'dev_review'].includes(i.status)), label: '评审 ∥ 开发' },
    { key: 'test-collect', on: items.some((i) => ['test', 'test_done'].includes(i.status)) && items.some((i) => i.status === 'review'), label: '测试 ∥ 下一次收集' }
  ];
  // 六档计数 / 口径数字（与评审弹窗、需求池同一个 UI3_groupCounts）。
  const groupCounts = (ui3 && typeof ui3.UI3_groupCounts === 'function')
    ? ui3.UI3_groupCounts(reqs)
    : { all: reqs.length, registered: reqs.length, fallback: 0, counts: {}, groups: [], open: reqs.length - closedCount, closed: closedCount };
  const freshness = (ui3 && typeof ui3.UI3_flowFreshness === 'function')
    ? ui3.UI3_flowFreshness(flowLiveState.refreshedAt, Date.now(), FLOW_STALE_AFTER_MS)
    : { refreshedAt: '', ageMs: null, stale: true, reason: 'NEVER_REFRESHED', limitMs: FLOW_STALE_AFTER_MS };
  return {
    round: Number(wf.round || 1),
    total: reqs.length,
    registered: reqs.length,
    fallbackCount,
    open: reqs.length - closedCount,
    closed: closedCount,
    active,
    items,
    parallel,
    groupCounts,
    freshness,
    refreshError: flowLiveState.lastError || '',
    refreshedAt: freshness.refreshedAt,
    stale: freshness.stale === true
  };
}

/** 把流程数据的口径数字与新鲜度挂到面板节点上（自检/测试按属性取数，不靠读文案）。
 *  B-410e AC1/AC3：[data-flow-total] 与评审/池同源；[data-flow-refreshed-at]/[data-flow-stale] 是新鲜度契约。 */
function paintFlowDataAnchors(data) {
  const box = data || {};
  const attrs = {
    'data-flow-total': String(box.registered != null ? box.registered : (box.total || 0)),
    'data-flow-open': String(box.open || 0),
    'data-flow-closed': String(box.closed || 0),
    'data-flow-fallback': String(box.fallbackCount || 0),
    'data-flow-refreshed-at': String(box.refreshedAt || ''),
    'data-flow-stale': box.stale ? '1' : '0',
    'data-flow-refresh-error': String(box.refreshError || '')
  };
  for (const sel of ['#flow-mini', '#flow-board', '#flow-meta', '#flow-mini-meta', '#flow-summary']) {
    const node = $(sel);
    if (!node) continue;
    for (const key of Object.keys(attrs)) node.setAttribute(key, attrs[key]);
  }
}

/** 流程数据新鲜度人话：刷新时刻 + 过期提醒（超 60 秒 / 刷新失败都必须写出来，禁止静默）。 */
function flowFreshnessText(data) {
  const box = data || {};
  const at = Number.isFinite(Date.parse(String(box.refreshedAt || ''))) ? fmtTime(box.refreshedAt) : '';
  if (!at) return '｜ 数据刷新时刻未知（可能过期）';
  if (box.stale) {
    const err = box.refreshError ? `；最近一次刷新失败：${box.refreshError}` : '';
    return `｜ ⚠ 数据可能过期（最后刷新 ${at}，超过 60 秒）${err}`;
  }
  return `｜ 数据刷新于 ${at}`;
}

function flowRenderSignature(p) {
  const wf = legacyWorkflow() || {};
  const reqs = Array.isArray(wf.requirements) ? wf.requirements : [];
  const tasks = Array.isArray(wf.tasks) ? wf.tasks : [];
  const boot = legacyBootSummary();
  const gate = gateAuditUi.data
    ? `${gateAuditUi.data.total || 0}:${Array.isArray(gateAuditUi.data.items) ? gateAuditUi.data.items.length : 0}`
    : 'na';
  // 账本分叉（工作流.json 与旧 任务/ 不一致）条数：它变了也要重绘，否则分叉增减看不见。
  let ledgerCount = 0;
  try { ledgerCount = legacyLedgerDivergences().length; } catch { ledgerCount = 0; }
  return JSON.stringify([
    p.id,
    wf.phase || '',
    wf.round || 1,
    legacyUi.workflowError ? legacyUi.workflowError.code : '',
    reqs.map((r) => {
      const owner = r && r.ownerReview && typeof r.ownerReview === 'object' ? r.ownerReview : null;
      const decisions = Array.isArray(owner && owner.decisions) ? owner.decisions : [];
      const lastDecisionAt = decisions.length
        ? String((decisions[decisions.length - 1] && (decisions[decisions.length - 1].at || decisions[decisions.length - 1].confirmedAt)) || '')
        : '';
      const ownerAt = String((owner && owner.at) || '');
      return `${r.id}:${r.status}:${r.updatedAt || ''}:${r.priority || ''}:${owner ? (owner.status || '') : ''}:${decisions.length}:${lastDecisionAt || ownerAt}`;
    }).join('|'),
    tasks.map((t) => `${t.id}:${t.status}:${t.owner || ''}`).join('|'),
    boot.complete, boot.total, boot.allComplete, gate, ledgerCount,
  ]);
}

function renderFlow() {
  const p = activeProject();
  const board = $('#flow-board');
  const meta = $('#flow-meta');
  const summary = $('#flow-summary');
  const mini = $('#flow-mini');
  const miniMeta = $('#flow-mini-meta');
  const projectEl = $('#flow-project');
  if (!board) return;

  if (!p) {
    flowRenderUi.projectId = '';
    flowRenderUi.sig = '';
    paintFlowDataAnchors({ total: 0, registered: 0, open: 0, closed: 0, fallbackCount: 0, refreshedAt: '', stale: true });
    const empty = `<div class="flow-empty">先新建或选择一个项目，旧流程会随阶段与真实记录变化。</div>`;
    board.innerHTML = `<div class="view-empty compact"><span class="view-empty-mark">⇢</span><h3>还没有项目流程</h3><p>新建项目后，需求 → 产品评审 → Owner → PM 派单 → 开发互审 → 测试 → Owner 验收 → 迭代/终止会在这里展开。</p><div class="view-empty-actions"><button class="primary small" type="button" data-open-new-project>＋ 新建项目</button></div></div>`;
    if (meta) meta.textContent = '还没有项目。';
    if (summary) summary.textContent = '';
    if (mini) mini.innerHTML = empty;
    if (miniMeta) miniMeta.textContent = '先选择项目';
    if (projectEl) projectEl.textContent = '未选择项目';
    const capBox = $('#legacy-capabilities');
    if (capBox) capBox.innerHTML = '<div class="empty-row">先选择工作区；旧工具能力与命令缺口在项目加载后读取。</div>';
    const capBadge = $('#legacy-cap-badge');
    if (capBadge) { capBadge.textContent = '待核验'; capBadge.className = 'badge muted-badge'; }
    const capLast = $('#legacy-last-action');
    if (capLast) { capLast.hidden = true; capLast.innerHTML = ''; }
    const ledgerBox = $('#legacy-flow-ledger');
    if (ledgerBox) ledgerBox.innerHTML = '';
    const ownerBox = $('#legacy-flow-owner');
    if (ownerBox) ownerBox.innerHTML = '';
    const flowActions = $('#legacy-flow-actions');
    if (flowActions) flowActions.innerHTML = '';
    renderQuickTechReview(null);
    renderFlowDerivation();
    // 并行泳道：无项目时清空，避免残留上一条项目的泳道。
    renderFlowLanes(null);
    gateAuditUi.data = null;
    gateAuditUi.projectId = null;
    renderGateAudit();
    return;
  }
  // 并行泳道先渲染：每条需求一条泳道 + 项目级汇总；只重绘变化泳道。
  // 5 秒轮询：数据签名未变时直接返回，避免周期性全量重建大 DOM（渲染进程 CPU/内存峰值的主因）。
  // B-410e：口径数字与新鲜度每次都要重算并挂到节点上（签名里带上 refreshedAt/stale，
  // 「数据可能过期」才会随时间翻转；否则签名不变时永远停在旧文案）。
  const v4 = flowV4Data();
  paintFlowDataAnchors(v4);
  const flowText = `${flowMeta(p)}${flowFreshnessText(v4)}`;
  if (meta) meta.textContent = flowText;
  const flowSig = `${flowRenderSignature(p)}|${v4.refreshedAt || ''}|${v4.stale ? 'S' : 'F'}|${v4.refreshError || ''}`;
  // 数据过期（>60 秒没刷新 / 刷新失败）时清掉节流：下一次心跳立刻补一次实时读取，不静默停在旧数字。
  if (v4.stale && !flowLiveState.loading) flowLiveState.nextAt = 0;
  if (flowRenderUi.projectId === p.id && flowRenderUi.sig === flowSig) return;
  flowRenderUi.projectId = p.id;
  flowRenderUi.sig = flowSig;
  renderFlowLanes(p);
  // R-db98 收尾：右侧【流程】面板顶部接入节点图（与团队台/浮窗共用同一份 flow-graph.js），
  // 5 秒轮询命中 flowRefreshTick → renderFlow → 这里的签名变化会重绘。旧 flowMarkup 保留在下方。
  const graphHtml = flowGraphBoardMarkup();
  const markup = `${graphHtml}${flowMarkup(p)}`;
  board.innerHTML = markup;
  // T-20261113-090012 小修：流程面板只保留节点图（#flow-mini 里这份可见）+ 下方明细；
  // 旧泳道/串行小图（产品评审/可测性/Owner/PM派单/开发…）不再默认渲染，避免两套图并存。
  // 节点图脚本缺失时回落到旧小图，保证面板不空。
  if (mini && !$('#flow-panel')?.hidden) {
    if (window.FlowV4) window.FlowV4.render(mini, v4);
    else mini.innerHTML = graphHtml || flowMarkup(p);
    paintFlowDataAnchors(v4);
  }
  renderQuickTechReview(p);
  renderLegacyFlowExtras(p);
  renderLegacyRequirements();
  if (meta) meta.textContent = flowText;
  if (miniMeta) miniMeta.textContent = flowText;
  const boot = legacyBootSummary();
  const flowGate = legacyGateState();
  const activeReq = legacyActiveRequirement();
  const activeOwner = legacyReqOwnerView(activeReq);
  if (summary) summary.textContent = `${bootStatusText(boot)} · ${flowGate.open ? panelLevelLabel('warn', flowGate.warnCount) : flowGate.label} ｜ 需求级 Owner：${activeReq ? `${activeOwner.label} · ${activeReq.id}` : '无在办需求'}`;
  if (projectEl) projectEl.textContent = p.name;
  renderFlowDerivation();
  renderGateAudit();
}


function setFlowPanel(open) {
  const panel = $('#flow-panel');
  const launcher = $('#flow-launcher');
  if (!panel) return;
  panel.hidden = !open;
  launcher?.setAttribute('aria-expanded', String(open));
  if (open) {
    // 打开浮窗时强制重绘一次（隐藏期间按签名跳过，迷你版需要补渲染）。
    flowRenderUi.projectId = '';
    flowRenderUi.sig = '';
    renderFlow();
    // 打开即刷新一次，不等 5 秒节拍；失败会按退避重试。
    flowLiveState.nextAt = 0;
    refreshFlowLive();
  }
}

/* ── 角色与派单 ───────────────────────────────────────── */

function renderRoles() {
  const p = activeProject();
  const grid = $('#roles-grid');
  const summary = $('#roles-summary');
  if (!grid) return;
  if (!p) {
    if (summary) summary.textContent = '';
    grid.innerHTML = emptyView({
      mark: '◉',
      title: '还没有团队',
      text: '先新建工作区，再点顶栏「建团队」创建六个 DSH 角色会话。',
      action: '<button class="primary small" type="button" data-open-new-project>＋ 新建工作区</button>'
    });
    return;
  }
  const taskRoles = new Set((p.tasks || []).map((task) => task.role));
  const sessions = p.sessions || {};
  const visibleRoles = teamRoles(p);
  const ready = visibleRoles.filter((role) => sessions[role.id]).length;
  const verified = verifiedCount(p);
  const docs = legacyDocumentsReady();
  if (summary) {
    const boot = legacyBootSummary();
    summary.textContent = `${teamModeLabel(p)} · 目录 ${docs.dirs}/${docs.total} · 角色卡 ${docs.cards}/${docs.total} · 文件索引 ${docs.indexes}/${docs.total} · 其他文档 ${docs.others} 份 · 项目索引 ${docs.index ? '存在' : '缺失'} · `
      + (verified === null ? `本地会话 ${ready}/${docs.total}（DSH 待核验）` : `DSH 已核验 ${verified}/${docs.total}`)
      + ` · ${bootStatusText(boot)}`;
  }
  grid.innerHTML = visibleRoles.map((role) => {
    const cardRel = legacyRoleCardRel(role);
    const indexRel = legacyRoleIndexRel(role);
    const dir = legacyHas(legacyRoleDirName(role));
    const card = legacyHas(cardRel);
    const cardState = legacyRoleCardState(role);
    const index = legacyHas(indexRel);
    const others = legacyRoleOtherDocCount(role);
    const session = sessions[role.id];
    const st = sessionState(p, role);
    const boot = legacyBootFor(role.id);
    const bootCtl = legacyBootControl(role.id);
    const ev = legacyBootEvidence(role.id);
    // B-2ebe：就绪三态（文件缺失/未 boot/已过期）统一走 legacyRoleBootHint，不再只看 boot 标签。
    const hint = legacyRoleBootHint(role);
    const evidenceRecord = ev.memRead || ev.bootRecord;
    const evidence = evidenceRecord
      ? `${ev.memRead ? '本次 boot' : '工作流.json boots'} ${evidenceRecord.complete ? '必读齐全' : '有缺失'}${evidenceRecord.tokenHash ? ' · 令牌 ' + evidenceRecord.tokenHash : ''}`
      : (ev.row ? `工作流.json ${ev.briefingHash ? '简报 ' + legacyHashShort(ev.briefingHash) : '有记录'}` : '无 boot 证据');
    return `<article class="role-card" style="--role-color:${esc(role.color)}">
      <div class="role-card-head">
        <div class="role-chip" style="background:${esc(role.color)}">${esc(String(role.name || '?').slice(0, 1))}</div>
        <div><h3>${esc(role.name)}</h3><div class="muted">${taskRoles.has(role.id) ? '当前有任务' : '待命'} · ${session ? '有会话' : '无会话'} · <code>${esc(role.id)}</code></div></div>
      </div>
      <p>${esc(ROLE_BLURB[role.id] || '实现、互审、提交与回执。')}</p>
      <div class="role-scope" title="${esc(role.scope)}">${esc(legacyRoleDirName(role))}/ · ${esc(role.scope)} · <span class="${dir ? 'fact-ok' : 'fact-bad'}">目录${dir ? '存在' : '缺失'}</span></div>
      <div class="role-session" title="${esc(session || '')}">${session ? '本地映射 · ' + esc(sessionShort(session)) : '本地映射 · 未创建'}</div>
      <div class="role-live ${st.cls}" title="${esc(st.title)}">${esc(st.text)}</div>
      <div class="role-facts">
        <span><i>角色卡</i><b class="${cardState.key === 'ok' ? 'fact-ok' : (cardState.key === 'unmapped' ? 'fact-warn' : 'fact-bad')}" title="${esc(cardState.title)}">${esc(cardState.label)}</b></span>
        <span><i>文件索引</i><b class="${index ? 'fact-ok' : 'fact-bad'}" title="${esc(indexRel)}">${index ? '存在' : '缺失'}</b></span>
        <span><i>其他文档</i><b class="${others ? 'fact-ok' : 'fact-muted'}">${others}</b><small>份</small></span>
        <span><i>当前 boot</i><b class="fact-${hint.key === 'ready' ? 'ok' : (hint.key === 'missing-file' ? 'bad' : 'warn')}" title="${esc(hint.title)}">${esc(hint.label)}</b></span>
      </div>
      <div class="role-evidence" title="${esc(ev.source)}">${esc(evidence)}</div>
      ${presenceMarkup(role.id, { compact: true })}
      <div class="role-actions">
        <button class="ghost small" type="button" data-legacy-boot="${esc(role.id)}" ${bootCtl.disabled ? 'disabled' : ''} title="${esc(bootCtl.title)}">${esc(bootCtl.text)}</button>
        <button class="ghost small" type="button" data-legacy-role-card="${esc(role.id)}" title="只读查看 ${esc(cardRel)}">角色卡</button>
        <button class="ghost small" type="button" data-legacy-role-index="${esc(role.id)}" title="只读查看 ${esc(indexRel)}">文件索引</button>
        <button class="ghost small" type="button" data-role-session="${esc(role.id)}" title="查看这个角色的会话">会话</button>
        <button class="ghost small" type="button" data-role-message="${esc(role.id)}" title="以这个角色为发件人写团队消息；角色互发不占 PM 派单锁">发消息</button>
      </div>
    </article>`;
  }).join('');

  grid.querySelectorAll('[data-wake-role]').forEach((button) => button.addEventListener('click', () => openWakeModal(button.dataset.wakeRole)));
  ensurePresence(() => { renderRoles(); renderTeamSessions(); });
}

function dispatchTargets(fromId) {
  return teamRoles(activeProject()).filter((role) => role.id !== fromId);
}

/* ── 派单链路：已发送 / 已唤醒 / 已读 / 已回执 / 失败 ─────────
 * 已发送、已回执来自持久化 messages；已唤醒只认本次 team:send 返回；
 * 已读只认已读取的旧协议邮箱 new/cur；没有证据就写“未记录”。 */

function teamInboxBoxFor(project, message) {
  if (!project || !message) return null;
  const toRole = String(message.to || '');
  if (!inboxUi.data || inboxUi.dataRole !== toRole || !Array.isArray(inboxUi.data.messages)) return null;
  const ids = new Set([message.teamMessageId, message.id].filter(Boolean).map(String));
  const row = inboxUi.data.messages.find((item) => ids.has(String(item.id || '')));
  if (!row) return 'absent';
  return String(row.box || '') === 'cur' ? 'read' : 'unread';
}

function dispatchSteps(project, message) {
  const m = message || {};
  const comm = m.comm && typeof m.comm === 'object' ? m.comm : null;
  const delivered = comm && comm.delivered ? comm.delivered : null;
  const wake = comm && comm.wake ? comm.wake : null;
  const read = comm && comm.read ? comm.read : null;
  const ack = comm && comm.ack ? comm.ack : null;
  const run = dispatchRuns.get(dispatchKey(project && project.id, m.id)) || null;
  const steps = [];

  if (delivered && delivered.state === 'delivered') {
    steps.push({ label: '已发送', state: 'ok', text: '旧协议·new', title: `通信链 delivered：已写入旧协议邮箱 new（${delivered.at || '时间未记录'}，by=${delivered.by || '未记录'}）` });
  } else if (delivered && delivered.state === 'local-only') {
    steps.push({ label: '已发送', state: 'bad', text: '失败·仅本机', title: '通信链 delivered=local-only：旧协议未送达，只写本机镜像；不能当成发送成功' });
  } else if (m.source === 'team') {
    steps.push({ label: '已发送', state: 'ok', text: '旧协议', title: '旧消息没有 comm 字段，但 source=team；只按已记录的来源显示' });
  } else if (m.source === 'local' || m.source === 'team-local' || m.degraded) {
    steps.push({ label: '已发送', state: 'bad', text: '失败·仅本机', title: '旧协议未送达，只写了本机降级记录；不能当成发送成功' });
  } else {
    steps.push({ label: '已发送', state: 'unknown', text: '未记录', title: '消息没有 source/comm，无法判断是否走通旧协议' });
  }

  if (wake && wake.state === 'sent') {
    steps.push({ label: '已唤醒', state: 'ok', text: 'dsh.prompt', title: `通信链 wake=sent：${wake.at || '时间未记录'} 由 ${wake.by || 'workbench-shell'} 发送到会话 ${wake.sessionId || '未记录'}` });
  } else if (wake && wake.state === 'failed') {
    steps.push({ label: '已唤醒', state: 'bad', text: '失败·' + (wake.code || 'DSH'), title: `通信链 wake=failed：${wake.error || wake.code || '未给原因'}` });
  } else if (wake && wake.state === 'skipped') {
    steps.push({ label: '已唤醒', state: 'muted', text: '未尝试·无会话', title: '通信链 wake=skipped：主进程记录当时没有 DSH 会话，没有发送 prompt' });
  } else if (run && run.wake) {
    steps.push(run.wake.ok
      ? { label: '已唤醒', state: 'ok', text: '本次界面返回', title: '旧消息没有 comm；本次界面 team:send 返回 wake.ok=true，刷新后不再显示' }
      : { label: '已唤醒', state: 'bad', text: '失败·' + (run.wake.code || 'DSH'), title: '本次界面 team:send 的唤醒失败：' + (run.wake.why || run.wake.code || '未给原因') });
  } else {
    steps.push({ label: '已唤醒', state: 'unknown', text: '未记录', title: '没有 comm.wake，也没有本次界面返回；不补造已唤醒' });
  }

  if (read && read.state === 'read') {
    const byRole = read.by === 'role';
    steps.push({ label: '已读', state: byRole ? 'ok' : 'warn', text: byRole ? '角色 read·cur' : '壳 read·cur', title: `通信链 read=read：${read.at || '时间未记录'} by=${read.by || '未记录'}；${byRole ? '邮箱从 new 移到 cur，是角色自己 read 的证据' : '由工作台壳执行，不是角色本人'}` });
  } else if (read && read.state === 'pending') {
    if (delivered && delivered.state === 'delivered') {
      steps.push({ label: '已读', state: 'warn', text: '未读·new', title: '通信链 read=pending，且 delivered=delivered；邮件还在旧协议邮箱 new，角色尚未 read' });
    } else if (delivered && delivered.state === 'local-only') {
      steps.push({ label: '已读', state: 'muted', text: '不适用·仅本机', title: '仅本机镜像，不在旧协议邮箱里，没有 new/cur 可读' });
    } else {
      steps.push({ label: '已读', state: 'unknown', text: '未记录', title: '通信链 read=pending，但没有可靠的 delivered 证据，不能断言未读' });
    }
  } else {
    const boxState = teamInboxBoxFor(project, m);
    if (boxState === 'read') steps.push({ label: '已读', state: 'ok', text: '旧协议 cur', title: 'team:inbox 读到这条在 cur（角色已 read）' });
    else if (boxState === 'unread') steps.push({ label: '已读', state: 'warn', text: '旧协议 new', title: 'team:inbox 读到这条还在 new（未 read）' });
    else if (boxState === 'absent') steps.push({ label: '已读', state: 'unknown', text: '邮箱未见', title: '已读取的旧协议邮箱里没有这条；可能是仅本机消息，或邮箱已变化' });
    else steps.push({ label: '已读', state: 'unknown', text: '未记录', title: '没有 comm.read；调试收件箱也未读取该角色邮箱，不拿本机浏览标记冒充角色 read' });
  }

  if (ack && ack.state === 'acked') {
    const self = Boolean(comm.selfExecuted && comm.selfExecuted.ack) || ack.by === 'role';
    const actor = String(ack.actor || '');
    const label = self ? '角色自己' : (actor === 'workbench-shell' ? '壳执行' : '执行者未记录');
    steps.push({ label: '已回执', state: self ? 'ok' : 'warn', text: '已回执·' + label, title: `通信链 ack=acked：${ack.at || '时间未记录'} by=${ack.by || '未记录'} actor=${actor || '未记录'} source=${ack.source || '未记录'}` });
  } else if (ack && ack.state === 'manual') {
    steps.push({ label: '已回执', state: 'warn', text: '人工确认·非回执', title: `通信链 ack=manual：by=${ack.by || 'human'} actor=${ack.actor || 'workbench-shell/manual'}；只写本机，不是角色回执，不释放旧协议派单锁` });
  } else if (m.ack) {
    steps.push({ label: '已回执', state: 'ok', text: '已回执·' + (m.actor || 'actor 未记录'), title: 'messages 里 ack=true（旧消息没有 comm）；来源 ' + (m.ackSource || '未记录') + '，actor=' + (m.actor || '未记录') });
  } else if (m.manualAck) {
    steps.push({ label: '已回执', state: 'warn', text: '人工确认·非回执', title: '人工确认 actor=workbench-shell/manual，只写本机，不释放旧协议派单锁' });
  } else if (m.ackRequired === false) {
    steps.push({ label: '已回执', state: 'muted', text: '无需回执', title: '这条消息不要求回执' });
  } else {
    steps.push({ label: '已回执', state: 'warn', text: '待回执', title: '旧协议与 messages 都还没有回执' });
  }

  const failures = [];
  if (delivered && delivered.state === 'local-only') failures.push('旧协议未送达（仅本机）');
  else if (m.source === 'local' || m.source === 'team-local' || m.degraded) failures.push('旧协议失败，仅本机');
  if (m.reason) failures.push(String(m.reason));
  if (wake && wake.state === 'failed') failures.push('唤醒失败');
  if (wake && wake.state === 'skipped') failures.push('未尝试唤醒（无会话）');
  if (run && !wake && run.wake && run.wake.ok === false) failures.push('唤醒失败');
  if (run && Array.isArray(run.warnings) && run.warnings.length) {
    const warning = run.warnings[0];
    failures.push(String((warning && (warning.message || warning.code)) || warning).slice(0, 120));
  }
  steps.push(failures.length
    ? { label: '失败', state: 'bad', text: failures[0], title: failures.join('；') }
    : ((ack && ack.state === 'acked') || m.ack
      ? { label: '失败', state: 'muted', text: '无', title: '已有回执，没有已知失败' }
      : ((ack && ack.state === 'manual') || m.manualAck
        ? { label: '失败', state: 'warn', text: '人工确认·未闭环', title: '只有人工确认，不是角色回执，旧协议锁未释放' }
        : (m.ackRequired === false
          ? { label: '失败', state: 'muted', text: '无', title: '不要求回执，没有已知失败' }
          : { label: '失败', state: 'warn', text: '未闭环', title: '还没有回执；未闭环不等于发送失败' }))));
  return steps;
}

function pipelineMarkup(steps) {
  if (!Array.isArray(steps) || !steps.length) return '';
  return `<div class="msg-pipeline" role="list" aria-label="派单状态链路">${steps.map((step, index) => `${index ? '<span class="pipe-arrow" aria-hidden="true">›</span>' : ''}<span class="pipe-step ${esc(step.state)}" role="listitem" title="${esc(step.title || step.text)}"><i>${esc(step.label)}</i><b>${esc(step.text)}</b></span>`).join('')}</div>`;
}

function dispatchReadiness(project, fromId, roleId) {
  const blockers = [];
  const warnings = [];
  if (!project) return { ok: false, blockers: ['先选择工作区'], warnings };
  if (!fromId || !roleId) return { ok: false, blockers: ['先选择发起与收件角色'], warnings };
  if (fromId === roleId) blockers.push('不能给自己发团队消息');
  const fromSession = (project.sessions || {})[fromId] || '';
  const toSession = (project.sessions || {})[roleId] || '';
  if (!fromSession) blockers.push(`发起角色「${roleById(fromId).name}」没有本地 DSH 会话映射`);
  if (!toSession) blockers.push(`收件角色「${roleById(roleId).name}」没有本地 DSH 会话映射`);
  const checkLive = (sid, id, label) => {
    if (!sid) return;
    const live = liveItemFor(project, id);
    if (!live) return;
    if (!live.exists) blockers.push(`DSH 核验：${label}会话已不存在`);
    else if (live.archived) blockers.push(`DSH 核验：${label}会话已归档`);
    else if (!live.inWorkspace) blockers.push(`DSH 核验：${label}会话不在当前工作区`);
  };
  checkLive(fromSession, fromId, '发起角色');
  checkLive(toSession, roleId, '收件角色');
  if (!blockers.length && state && state.dsh && state.dsh.configured && !state.dsh.online) {
    warnings.push('DSH 当前离线：发送会失败，界面只显示失败，不会伪报成功。');
  }
  return { ok: blockers.length === 0, blockers, warnings };
}

function renderDispatchResult(project) {
  const box = $('#dispatch-result');
  if (!box) return;
  const entry = dispatchUi.last && dispatchUi.last.projectId === (project && project.id) ? dispatchUi.last : null;
  if (!entry) {
    box.hidden = true;
    box.innerHTML = '';
    box.className = 'dispatch-result';
    return;
  }
  box.hidden = false;
  const fromName = roleById(entry.fromId).name;
  const toName = roleById(entry.toId).name;
  const atLabel = fmtTime(entry.at) || '时间未记录';
  const message = entry.messageId
    ? ((project.messages || []).find((m) => String(m.id) === String(entry.messageId)) || entry.messageSnapshot || null)
    : null;
  const steps = message ? dispatchSteps(project, message) : [
    { label: '已发送', state: 'bad', text: '失败', title: entry.error || 'team:send 没有返回消息' },
    { label: '已唤醒', state: 'muted', text: '未发生', title: '发送失败，没有进入唤醒步骤' },
    { label: '已读', state: 'muted', text: '—', title: '没有消息可读' },
    { label: '已回执', state: 'muted', text: '—', title: '没有消息可回执' },
    { label: '失败', state: 'bad', text: entry.error ? String(entry.error).slice(0, 80) : '未返回错误', title: entry.error || '未知失败' }
  ];
  const bad = !entry.ok || steps.some((step) => step.state === 'bad');
  const warnings = Array.isArray(entry.warnings) ? entry.warnings : [];
  const headline = !entry.ok
    ? '上次派单失败'
    : (bad ? '上次派单已发送，但有失败步骤' : '上次派单已发起');
  box.className = 'dispatch-result' + (bad ? ' is-bad' : '');
  box.innerHTML = `<div class="dispatch-result-head">
      <b>${headline}</b>
      <span class="dispatch-route"><b>${esc(fromName)}</b> → <b>${esc(toName)}</b></span>
      <span>${esc(entry.subject || '任务派单')}</span>
      <time>${esc(atLabel)}</time>
    </div>
    ${entry.error ? `<div class="dispatch-result-msg">${esc(entry.error)}</div>` : ''}
    ${pipelineMarkup(steps)}
    ${warnings.length ? `<div class="dispatch-result-msg">告警：${esc(String(warnings[0].message || warnings[0].code || warnings[0]).slice(0, 160))}</div>` : ''}
    <p class="dispatch-result-note">来源 ${esc(entry.source === 'team' ? '旧协议' : '本机降级 / 失败')}；唤醒/已读/失败只记录本次界面真实返回，刷新即清空，不补造历史状态。</p>`;
}

/** 从角色卡直接以该角色为发件人打开派单表单；不改许可，回执仍走团队台入口。 */
function openDispatchFrom(roleId) {
  const p = activeProject();
  if (!p) { openNewProject(); return; }
  setDrawer('team');
  renderTeam();
  const fromSel = $('#dispatch-from');
  if (fromSel) {
    if (!Array.from(fromSel.options).some((opt) => opt.value === roleId)) renderDispatch(p);
    fromSel.value = roleId;
  }
  renderDispatch(p);
  updateDispatchHint(p);
  const subject = $('#dispatch-subject');
  if (subject) subject.focus();
}

function updateDispatchHint(p) {
  const hint = $('#dispatch-hint');
  const send = $('#dispatch-send');
  if (!hint || !p) return;
  const roleId = ($('#dispatch-role') || {}).value || '';
  const fromId = ($('#dispatch-from') || {}).value || 'pm';
  const ackBox = $('#dispatch-ack');
  const needAck = ackBox ? ackBox.checked : true;
  const notes = [];
  let cls = '';
  const toRole = roleById(roleId);
  const pmLock = fromId === 'pm' && roleId !== 'pm' && needAck;
  const ready = dispatchReadiness(p, fromId, roleId);
  if (roleId && fromId === roleId) {
    notes.push('不能给自己发团队消息。');
    cls = 'bad';
  }
  if (!ready.ok) {
    notes.push(...ready.blockers);
    notes.push('没有真实 DSH 会话时派单已禁用：不会写本机降级记录，也不会假装已唤醒。');
    cls = 'bad';
  } else {
    if (pmLock) {
      notes.push('PM 派单：要回执时占用本地单派锁（10 分钟 TTL），一次只能一条。');
    } else if (roleId && fromId === 'pm') {
      notes.push('PM 派单不要回执：不占单派锁。');
    } else if (roleId && fromId !== roleId) {
      notes.push('角色互发 / 发给 PM：不占 PM 单派锁。');
    }
    if (ready.warnings.length) notes.push(...ready.warnings);
    notes.push('当前 boot/已读没有后端核验 IPC：派单仍走真实 team:send，但界面不能把“壳代跑 boot”当成角色自己已开工。');
    if (roleId && fromId !== roleId && (p.sessions || {})[roleId]) {
      notes.push(`发送后会尝试唤醒「${toRole.name}」的会话（${roleSessionTitle(p, roleId)}）；唤醒结果以 team:send 返回为准。`);
    }
    if (!needAck) notes.push('不需要回执：不占派单锁，也不会出现待回执。');
    if (pmLock && p.pendingAck) {
      notes.push('当前已有一条待回执：先等回执或撤销。');
      cls = 'bad';
    }
  }
  if (send) {
    const blockedByLock = Boolean(pmLock && p.pendingAck);
    send.disabled = !ready.ok || blockedByLock;
    send.title = !ready.ok
      ? '没有真实 DSH 会话：派单已禁用'
      : (blockedByLock ? '先处理当前待回执' : '发送后会尝试唤醒收件角色；结果以真实返回为准');
  }
  hint.textContent = notes.join(' ');
  hint.className = 'dispatch-hint' + (cls ? ' ' + cls : '');
}

function renderDispatch(p) {
  const select = $('#dispatch-role');
  if (!select || !p) return;
  const roles = teamRoles(p);
  const fromSel = $('#dispatch-from');
  if (fromSel) {
    // 旧协议 send 支持任意角色发件（含角色→PM、角色互发）；主进程 team:send 已透传 from。
    const prev = fromSel.value && roles.some((role) => role.id === fromSel.value) ? fromSel.value : 'pm';
    fromSel.innerHTML = roles.map((role) => `<option value="${esc(role.id)}">${esc(role.name)}${role.id === 'pm' ? '（PM）' : ''}${(p.sessions || {})[role.id] ? '' : '（无会话）'}</option>`).join('');
    fromSel.value = prev;
  }
  const fromId = (fromSel && fromSel.value) || 'pm';
  const targets = dispatchTargets(fromId);
  const prevTo = select.value;
  select.innerHTML = targets.map((role) => `<option value="${esc(role.id)}">${esc(role.name)}${(p.sessions || {})[role.id] ? '' : '（无会话）'}</option>`).join('');
  select.value = targets.some((role) => role.id === prevTo) ? prevTo : (targets[0] ? targets[0].id : '');
  const taskSel = $('#dispatch-task');
  if (taskSel) {
    const open = (Array.isArray(p.tasks) ? p.tasks : []).filter((task) => task.status !== 'done').slice(0, 40);
    const prevTask = taskSel.value;
    taskSel.innerHTML = '<option value="">不关联任务</option>' + open.map((task) => `<option value="${esc(task.id)}">${esc(task.id)} · ${esc(task.title)}（${esc(roleById(task.role).name)}）</option>`).join('');
    if (prevTask && open.some((task) => task.id === prevTask)) taskSel.value = prevTask;
  }
  updateDispatchHint(p);

  const pending = (p.messages || []).find((m) => m.id === p.pendingAck) || null;
  const box = $('#dispatch-pending');
  if (!box) return;
  if (!pending) {
    box.innerHTML = '<span class="muted">当前没有待回执消息。PM 派单（要回执）才会占本地 10 分钟派单锁；角色互发不占锁。</span>';
    renderDispatchResult(p);
    return;
  }
  const remain = ackRemainMs(p);
  const expired = remain !== null && remain <= 0;
  const ttlText = remain === null ? '无计时' : (expired ? '已超时' : '剩余 ' + fmtRemain(remain));
  box.innerHTML = `<div class="dispatch-wait">
    <div class="dispatch-wait-head"><b>待回执</b><span>${esc(roleById(pending.to).name)}</span><span>·</span><span>${esc(pending.subject || '任务派单')}</span><span class="ttl-chip${expired ? ' expired' : ''}" data-ack-ttl="1">${ttlText}</span></div>
    <div class="muted">${esc(pending.body || '')}</div>
    ${pipelineMarkup(dispatchSteps(p, pending))}
    <div class="dispatch-actions"><button id="dispatch-ack-btn" class="ghost small" type="button">记录回执</button><button id="dispatch-cancel" class="ghost small" type="button">撤销派单</button></div>
    <div class="muted">来源：${esc(sourceLabel(pending.source) || pending.source || '未知')} · 派发于 ${esc(fmtTime(pending.createdAt) || pending.id)}</div>
  </div>`;
  box.querySelector('#dispatch-ack-btn')?.addEventListener('click', () => openAckModal(p, pending));
  box.querySelector('#dispatch-cancel')?.addEventListener('click', () => cancelPending(p, pending.id));
  renderDispatchResult(p);
}

/** 派单：没有真实会话直接禁用；唤醒/失败以 team:send 返回为准，不静默降级。 */
async function sendDispatch(p) {
  if (!p) return;
  if (typeof window.workbench.teamSend !== 'function') {
    toast('preload 没有 teamSend：不能发送，也不会伪造本机记录', 'bad');
    return;
  }
  const fromId = ($('#dispatch-from') || {}).value || 'pm';
  const roleId = ($('#dispatch-role') || {}).value || '';
  if (!roleId) { toast('先选择要发给哪个角色', 'bad'); return; }
  if (roleId === fromId) { toast('不能给自己发团队消息', 'bad'); return; }
  const subject = ($('#dispatch-subject') || {}).value.trim();
  const body = ($('#dispatch-body') || {}).value.trim();
  const taskId = (($('#dispatch-task') || {}).value) || '';
  const needAck = $('#dispatch-ack') ? $('#dispatch-ack').checked : true;
  if (!body) { toast('派单内容不能为空', 'bad'); return; }
  const ready = dispatchReadiness(p, fromId, roleId);
  if (!ready.ok) {
    updateDispatchHint(p);
    toast((ready.blockers[0] || '没有真实 DSH 会话') + '：派单已禁用', 'bad');
    return;
  }
  if (fromId === 'pm' && roleId !== 'pm' && needAck && p.pendingAck) {
    toast('还有一条 PM 派单没回执：先等回执或撤销', 'bad');
    return;
  }
  const btn = $('#dispatch-send');
  setButtonsBusy([btn], true);
  try {
    const r = await window.workbench.teamSend({
      projectId: p.id,
      from: fromId,
      role: roleId,
      subject,
      body,
      taskId,
      ackRequired: needAck
    });
    const subjectEl = $('#dispatch-subject');
    const bodyEl = $('#dispatch-body');
    if (subjectEl) subjectEl.value = '';
    if (bodyEl) bodyEl.value = '';
    const source = r && r.source === 'team' ? 'team' : 'local';
    const wake = r && r.wake ? r.wake : null;
    const warnings = Array.isArray(r && r.warnings) ? r.warnings : [];
    const message = r && r.message ? r.message : null;
    if (message && message.id) {
      dispatchRuns.set(dispatchKey(p.id, message.id), {
        at: new Date().toISOString(),
        source,
        wake,
        warnings
      });
    }
    if (wake) rememberWake(p.id, roleId, wake, 'dispatch');
    dispatchUi.last = {
      projectId: p.id,
      at: new Date().toISOString(),
      ok: source === 'team',
      fromId,
      toId: roleId,
      subject: (message && message.subject) || subject || '任务派单',
      source,
      messageId: message && message.id ? String(message.id) : '',
      messageSnapshot: message,
      wake,
      warnings,
      error: source === 'team' ? '' : String((warnings[0] && (warnings[0].message || warnings[0].code)) || '旧协议未送达，只写本机降级记录')
    };
    await applyState(r);
    renderDispatchResult(activeProject() || p);
    let text = `${roleById(fromId).name} → ${roleById(roleId).name}：`;
    if (source === 'team') {
      text += '已走旧协议';
      if (wake && wake.ok) text += '，已唤醒收件角色';
      else if (wake && (wake.code || wake.why)) text += `，但唤醒失败：${wake.why || wake.code}`;
      else text += '，唤醒结果未返回';
    } else {
      text += '旧协议未送达，仅写本机降级记录（失败）';
    }
    if (needAck && message && message.ackRequired === false) text += '；旧协议未要求回执';
    if (warnings.length) text += `；告警：${warnings[0].message || warnings[0].code}`;
    toast(text, source === 'team' && !warnings.length && (!wake || wake.ok) ? 'ok' : 'bad');
    loadDshTeamStatus({ force: true });
  } catch (e) {
    const reason = humanError(e.message);
    dispatchUi.last = {
      projectId: p.id,
      at: new Date().toISOString(),
      ok: false,
      fromId,
      toId: roleId,
      subject: subject || '任务派单',
      source: 'error',
      messageId: '',
      messageSnapshot: null,
      wake: null,
      warnings: [],
      error: reason
    };
    renderDispatchResult(p);
    toast('发送失败：' + reason, 'bad');
  } finally {
    setButtonsBusy([btn], false);
    // setButtonsBusy 会无条件恢复 enabled；这里按当前会话/锁重新算一次，避免无会话或待回执时按钮又亮。
    const current = activeProject();
    if (current) updateDispatchHint(current);
  }
}


function openAckModal(p, message) {
  const from = roleById(message.from);
  const to = roleById(message.to);
  const hasSession = Boolean(p.sessions && p.sessions[message.to]);
  const needAck = message.ackRequired !== false;
  const manualBefore = message.manualAck
    ? `<p class="hint">已有人工确认：${esc(message.manualAckNote || '')}（${esc(fmtTime(message.manualAckAt) || '')}）</p>`
    : '';
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="member-row"><div><b>${esc(from.name)} → ${esc(to.name)}</b><span class="muted">${esc(message.subject || '任务派单')}</span></div><code>${esc(message.id)}</code></div>
    ${message.body ? `<p class="member-hint">${esc(message.body)}</p>` : ''}
    ${manualBefore}
    <p class="muted">${needAck ? '这条消息要求回执。' : '这条消息没有要求回执。'}不勾人工确认时：工作台壳持收件角色「${esc(to.name)}」的会话身份执行旧协议 ack，回执 <code>actor=workbench-shell</code>（不是角色本人）。勾选人工确认：<code>actor=workbench-shell/manual</code>，只写本机消息，不写 回执.jsonl，也不释放派单锁。</p>
    ${hasSession ? '' : '<p class="hint bad">该角色没有真实 DSH 会话：只能做「人工确认」，旧协议派单锁不会释放。</p>'}
    <label class="check-row"><input type="checkbox" id="ack-manual" ${hasSession ? '' : 'checked disabled'}><span>只做人工确认（不是角色会话回执，不释放派单锁）</span></label>
    <label class="field"><span><b>处理结果</b></span><textarea id="ack-note" class="textarea" maxlength="300" placeholder="角色 + 任务 + 产物/commit + 边界"></textarea></label>
    <div class="modal-error"></div>`;
  openModal({
    title: '记录回执 / 人工确认', subtitle: message.subject, icon: '✓', body: wrap,
    actions: [
      { label: '取消', kind: 'ghost', onClick: ({ close }) => close() },
      { label: '确认', kind: 'primary', onClick: async ({ close, error }) => {
        try {
          const note = wrap.querySelector('#ack-note').value.trim();
          if (!note) throw new Error('回执内容不能为空');
          const manual = Boolean(wrap.querySelector('#ack-manual').checked);
          // 主进程默认拒绝壳代跑旧协议 ack；这里只在用户不勾人工确认时显式授权，actor 会写成 workbench-shell。
          const payload = { projectId: p.id, messageId: message.id, role: message.to, note, manual };
          if (!manual) payload.allowShellAck = true;
          const r = await window.workbench.teamAck(payload);
          await applyState(r);
          close();
          const warnings = Array.isArray(r && r.warnings) ? r.warnings : [];
          if (r && r.source === 'manual') {
            toast('已记录人工确认（不是角色回执，派单锁未释放）', 'bad');
          } else {
            const source = r && r.source === 'team' ? '旧协议' : (r && r.source === 'team-local' ? '旧协议不可用，只记本机' : '本机记录');
            const actor = r && r.actor ? `，actor=${r.actor}` : '';
            toast(`回执已记录（${source}${actor}）${warnings.length ? '；' + (warnings[0].message || warnings[0].code) : ''}`, warnings.length ? 'bad' : 'ok');
          }
          loadDshTeamStatus();
          if (openDrawerName === 'team' && receiptsCaps()) loadReceipts({ force: true });
        } catch (e) { error(e.message); }
      } }
    ]
  });
}

function openWakeModal(roleId) {
  const p = activeProject();
  const role = roleById(roleId);
  if (!p || !p.sessions?.[roleId]) { toast('先点「建团队」创建 DSH 会话', 'bad'); return; }
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <p class="muted" style="margin-bottom:10px">只唤醒一个角色，不群发。默认消息只要求确认任务和边界。</p>
    <label class="field"><span><b>发给 ${esc(role.name)}</b></span><textarea class="textarea" id="wake-text">你是「${esc(role.name)}」。先读项目信息、角色卡和文件索引；只回一行确认：角色 id + 当前任务 + 边界。不要巡检全队。</textarea></label>
    <div class="modal-error"></div>`;
  openModal({
    title: '唤醒角色', subtitle: role.name, icon: '◉', body: wrap, width: 560,
    actions: [
      { label: '取消', kind: 'ghost', onClick: ({ close }) => close() },
      { label: '发送', kind: 'primary', onClick: async ({ close, error }) => {
        try {
          const text = wrap.querySelector('#wake-text').value.trim();
          if (!text) throw new Error('消息不能为空');
          await window.workbench.dshPrompt({ projectId: p.id, role: roleId, text });
          rememberWake(p.id, roleId, { ok: true }, 'prompt');
          close();
          await refresh();
          toast('已唤醒 ' + role.name, 'ok');
        } catch (e) { error(e.message); }
      } }
    ]
  });
}

function openRoleSessionModal(roleId) {
  const p = activeProject();
  if (!p) { openNewProject(); return; }
  const role = roleById(roleId);
  const sessionId = (p.sessions || {})[roleId] || null;
  const liveItem = liveItemFor(p, roleId);
  const expectedTitle = roleSessionTitle(p, roleId);
  const title = (liveItem && liveItem.currentTitle) || expectedTitle;
  const titleMismatch = Boolean(liveItem && liveItem.currentTitle && liveItem.currentTitle !== expectedTitle);
  const st = sessionState(p, role);
  const facts = roleStatusSummary(p, roleId);
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <div class="role-detail">
      <div class="role-detail-row"><span>角色</span><b>${esc(role.name)}</b></div>
      <div class="role-detail-row"><span>工作区</span><b title="${esc(p.path)}">${esc(p.name)}</b></div>
      <div class="role-detail-row"><span>DSH 标题</span><b class="${titleMismatch ? 'bad' : ''}" title="${esc(title)}">${esc(title)}${titleMismatch ? '（应为 ' + esc(expectedTitle) + '）' : ''}</b></div>
      <div class="role-detail-row"><span>会话状态</span><b class="${st.cls}" title="${esc(st.title)}">${esc(st.text)}</b></div>
      <div class="role-detail-row"><span>本地映射</span><code title="${esc(sessionId || '')}">${sessionId ? esc(sessionId) : '未创建'}</code></div>
      <div class="role-detail-row"><span>DSH 存在</span><b class="fact-${esc(facts.dsh.key)}" title="${esc(facts.dsh.title)}">${esc(facts.dsh.label)}</b></div>
      <div class="role-detail-row"><span>收件箱未读</span><b class="${facts.inbox.n ? 'fact-warn' : 'fact-muted'}" title="${esc(facts.inbox.title)}">${facts.inbox.n} 条 · ${esc(facts.inbox.label)}</b></div>
      <div class="role-detail-row"><span>最近回执</span><b class="fact-${esc(facts.receipt.key)}" title="${esc(facts.receipt.title)}">${esc(facts.receipt.short)}</b></div>
      <div class="role-detail-row"><span>最后唤醒</span><b class="fact-${esc(facts.wake.key)}" title="${esc(facts.wake.title)}">${esc(facts.wake.short)}</b></div>
      <div class="role-detail-row"><span>边界</span><b title="${esc(role.scope)}">${esc(role.scope)}</b></div>
    </div>
    <p class="hint">一个会话只对应一个角色。收到“未记录/无”是接口没给证据，不是补造成功；定位会尝试在 DSH 主画面里选中该角色所属工作区的会话。</p>
    <div class="modal-error"></div>`;
  openModal({
    title: '角色会话',
    subtitle: `${p.name} · ${role.name}`,
    icon: '◉',
    body: wrap,
    width: 560,
    actions: [
      { label: '关闭', kind: 'ghost', onClick: ({ close }) => close() },
      { label: '在 DSH 定位', kind: 'ghost', disabled: !sessionId, onClick: async ({ error }) => {
        if (!sessionId) { error('这个角色还没有 DSH 会话'); return; }
        const ok = await locateDshSession(p, sessionId, title);
        if (ok) toast('已切换到 ' + role.name + ' 的 DSH 会话', 'ok');
        else error('DSH 未连接，或 DSH 主画面里还没找到这个会话；可以先「重载 DSH」再试。');
      } },
      { label: sessionId ? '唤醒角色' : '去建团队', kind: 'primary', onClick: ({ close }) => {
        close();
        if (sessionId) openWakeModal(roleId);
        else startTeam($('#btn-team-start'));
      } }
    ]
  });
}

/**
 * 向 DSH 核验六个角色会话（只读）：会话是否还在、是否在本工作区、是否空白、标题是否一致。
 * 结果只缓存给当前项目；界面计数在“已核验”和“本地映射”之间明确区分，不拿本地记录冒充 6/6。
 */
async function loadDshTeamStatus(opts = {}) {
  const p = activeProject();
  if (!p || !state) return null;
  const online = Boolean(state.dsh && state.dsh.online);
  if (!online) {
    renderSessions();
    renderTeamSessions();
    renderHeader();
    renderSidebar();
    return null;
  }
  if (!opts.force && liveUi.projectId === p.id && liveUi.loading) return null;
  if (!opts.force && liveUi.projectId === p.id && liveUi.items.length && Date.now() - liveUi.at < 8000) return liveUi;
  liveUi.projectId = p.id;
  liveUi.loading = true;
  try {
    const r = await window.workbench.dshTeamStatus(p.id);
    if (!liveUi.projectId || liveUi.projectId !== p.id) return null;
    liveUi.items = Array.isArray(r.items) ? r.items : [];
    liveUi.extras = Array.isArray(r.extras) ? r.extras : [];
    liveUi.duplicates = Array.isArray(r.duplicates) ? r.duplicates : [];
    liveUi.workspace = r.workspace || null;
    liveUi.ready = typeof r.ready === 'number' ? r.ready : null;
    liveUi.canRepair = Boolean(r.canRepair);
    liveUi.missingRoles = Array.isArray(r.missingRoles) ? r.missingRoles : [];
    liveUi.blankRoles = Array.isArray(r.blankRoles) ? r.blankRoles : [];
    liveUi.notInWorkspace = Array.isArray(r.notInWorkspace) ? r.notInWorkspace : [];
    liveUi.error = null;
    liveUi.at = Date.now();
    return liveUi;
  } catch (e) {
    liveUi.error = humanError(e.message);
    liveUi.at = Date.now();
    return null;
  } finally {
    liveUi.loading = false;
    // 只重绘依赖会话状态的局部，避免 render() → setDrawer → 再核验的循环。
    const current = activeProject();
    renderSidebar();
    renderSessions();
    renderHeader();
    renderTeamSessions();
    renderTeamWorkspace();
    renderOverview();
    if (current) {
      renderTeamLog(current);
      renderDispatch(current);
      renderTeamWorkspace();
    }
    renderLaunchers();
    r5ClearSkeleton('#team-drawer');
  }
}

/** 旧版团队状态（team:status）：给旧看板摘要提供真实计数与生成时间，只读。 */
async function loadTeamStatus(opts = {}) {
  if (!window.workbench || typeof window.workbench.teamStatus !== 'function') return null;
  if (!opts.force && teamStatusUi.data && Date.now() - teamStatusUi.at < 15000) return teamStatusUi.data;
  if (teamStatusUi.loading) return teamStatusUi.data;
  teamStatusUi.loading = true;
  renderBoardSummary();
  try {
    const r = await window.workbench.teamStatus();
    teamStatusUi.data = r || null;
    teamStatusUi.at = Date.now();
    return r;
  } catch (e) {
    teamStatusUi.data = null;
    return null;
  } finally {
    teamStatusUi.loading = false;
    renderBoardSummary();
    // boot TTL 从 team:status 的 team.config 读取；拿到配置后重算“已过期”，不能继续用 480 分钟默认值。
    if (state && legacyUi.briefing) renderLegacyPanels();
  }
}

async function openMembersModal() {
  const p = activeProject();
  if (!p) { openNewProject(); return; }
  if (typeof window.workbench.teamMembers !== 'function') {
    setDrawer('project');
    showTab('roles');
    return;
  }
  let r;
  try { r = await window.workbench.teamMembers({ projectId: p.id }); }
  catch (e) { toast('读取成员失败：' + e.message, 'bad'); return; }
  const visible = new Set(teamRoleIds(p));
  const roles = (Array.isArray(r?.roles) ? r.roles : []).filter((x) => visible.has(String(x.role || '')));
  const rows = roles.map((x) => {
    const code = String(x.sessionId || '').replace('session-', '');
    return `<div class="member-row">
      <div><b>${esc(x.name || x.role || '角色')}</b><span class="muted">${esc(x.title || x.teamTitle || '')}</span></div>
      <code title="${esc(x.sessionId || '')}">${esc(code ? code.slice(0, 14) : '无会话')}</code>
    </div>`;
  }).join('');
  const body = `
    <p class="member-hint">这里是当前工作区的${esc(teamModeLabel(p))}成员清单。快速团队只显示 4 个角色；被隐藏角色的会话不会出现在清单里。DSH 左侧默认不显示“没有首条对话”的空白会话，需要显示时可在角色页逐个唤醒。</p>
    ${roles.length ? `<div class="member-list">${rows}</div>` : '<div class="empty-row">还没有成员清单；先点顶栏「建团队」创建角色会话。</div>'}
    <div class="modal-error"></div>`;
  openModal({
    title: '团队成员',
    subtitle: `${r?.project || p.name} · ${roles.length} 个角色`,
    icon: '◉',
    body,
    width: 640,
    actions: [
      { label: '去角色页', kind: 'ghost', onClick: ({ close }) => { close(); setDrawer('project'); showTab('roles'); } },
      { label: '关闭', kind: 'primary', onClick: ({ close }) => close() }
    ]
  });
}

/* ── 文件树 ───────────────────────────────────────────── */

const FILE_KIND = {
  md: 'Markdown', markdown: 'Markdown', json: 'JSON', js: 'JavaScript', ts: 'TypeScript',
  py: 'Python', html: 'HTML', htm: 'HTML', css: 'CSS', png: '图片', jpg: '图片', jpeg: '图片',
  gif: '图片', webp: '图片', svg: '矢量图', mp4: '视频', mov: '视频', pdf: 'PDF',
  zip: '压缩包', exe: '程序', txt: '文本', log: '日志'
};

function fileKind(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  return FILE_KIND[ext] || (ext && ext.length < 6 ? ext.toUpperCase() : '文件');
}

function fileIcon(name, isDir) {
  if (isDir) return '▱';
  const ext = String(name || '').split('.').pop().toLowerCase();
  return ({
    md: '◈', markdown: '◈', json: '⌘', js: '◆', ts: '◇', py: '◆', html: '⌁', htm: '⌁',
    css: '⌁', png: '▧', jpg: '▧', jpeg: '▧', gif: '▧', webp: '▧', svg: '▧',
    mp4: '▷', mov: '▷', pdf: '▤', zip: '▣', exe: '▣'
  }[ext] || '·');
}

const FILE_TEXT_EXT = new Set([
  'txt', 'log', 'json', 'jsonc', 'js', 'mjs', 'cjs', 'ts', 'tsx', 'jsx', 'py', 'html', 'htm',
  'css', 'scss', 'less', 'yml', 'yaml', 'xml', 'csv', 'tsv', 'sh', 'ps1', 'bat', 'cmd',
  'java', 'c', 'cpp', 'h', 'hpp', 'go', 'rs', 'sql', 'ini', 'conf', 'toml', 'env', 'gitignore'
]);
const FILE_MD_EXT = new Set(['md', 'markdown', 'mdown', 'mkd']);
const FILE_IMAGE_EXT = new Set(['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'ico', 'avif', 'svg']);
const FILE_PDF_EXT = new Set(['pdf']);

function fileExt(name) {
  const text = String(name || '');
  const dot = text.lastIndexOf('.');
  return dot >= 0 ? text.slice(dot + 1).toLowerCase() : '';
}

/** Windows 绝对路径 → file:// URL；逐段编码，保留盘符冒号。 */
function absFileUrl(absPath) {
  const raw = String(absPath || '').trim().replace(/\\/g, '/');
  if (!raw) return '';
  if (/^[A-Za-z]:\//.test(raw)) {
    return 'file:///' + raw.slice(0, 2) + '/' + raw.slice(3).split('/').map(encodeURIComponent).join('/');
  }
  if (raw.startsWith('//')) {
    return 'file:' + raw.split('/').map(encodeURIComponent).join('/');
  }
  return 'file:///' + raw.split('/').map(encodeURIComponent).join('/');
}

function projectFileUrl(project, rel) {
  const root = (project && project.path) || (fileUi.data && fileUi.data.root) || '';
  if (!root) return '';
  const base = String(root).replace(/[\\/]+$/, '');
  return absFileUrl(base + '\\' + String(rel || '').replace(/\//g, '\\'));
}

function splitTableRow(line) {
  return String(line || '').trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
}

function mdInline(text) {
  let out = esc(text);
  out = out.replace(/!\[([^\]]*)\]\(([^)\s]+)\)/g, (all, alt, href) => {
    if (!/^(https?:|data:image\/)/i.test(href)) return all;
    return `<img alt="${alt}" src="${href}" loading="lazy">`;
  });
  out = out.replace(/\[([^\]]+)\]\(([^)\s]+)\)/g, (all, label, href) => {
    if (!/^(https?:|mailto:)/i.test(href)) return all;
    return `<a href="${href}" target="_blank" rel="noreferrer">${label}</a>`;
  });
  out = out.replace(/`([^`]+)`/g, '<code>$1</code>');
  out = out.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  out = out.replace(/__([^_]+)__/g, '<strong>$1</strong>');
  out = out.replace(/(^|[^*])\*([^*\n]+)\*/g, '$1<em>$2</em>');
  out = out.replace(/(^|[^_])_([^_\n]+)_/g, '$1<em>$2</em>');
  out = out.replace(/~~([^~]+)~~/g, '<del>$1</del>');
  return out;
}

/** 轻量 Markdown 渲染：先转义，再按块拼 HTML；不执行原文中的任何 HTML/脚本。 */
function markdownToHtml(source) {
  const codeBlocks = [];
  let text = String(source || '').replace(/\r\n?/g, '\n');
  text = text.replace(/```([^\n`]*)\n([\s\S]*?)```/g, (all, lang, code) => {
    codeBlocks.push({ lang: String(lang || '').trim(), code });
    return '\n@@MDCODE' + (codeBlocks.length - 1) + '@@\n';
  });
  const lines = text.split('\n');
  const out = [];
  const isBlank = (line) => !String(line).trim();
  const isBlockStart = (line) => /^(#{1,6}\s|>\s?|@@MDCODE\d+@@|(?:[-*+])\s+|\d+\.\s+| {0,3}(?:-{3,}|\*{3,}|_{3,})\s*$)/.test(line);
  let i = 0;
  while (i < lines.length) {
    const line = lines[i];
    if (isBlank(line)) { i++; continue; }
    let m = /^(#{1,6})\s+(.*)$/.exec(line);
    if (m) {
      const level = m[1].length;
      out.push(`<h${level}>${mdInline(m[2].trim())}</h${level}>`);
      i++;
      continue;
    }
    if (/^ {0,3}([-*_])(?:\s*\1){2,}\s*$/.test(line)) { out.push('<hr>'); i++; continue; }
    m = /^@@MDCODE(\d+)@@$/.exec(line);
    if (m) {
      const block = codeBlocks[Number(m[1])] || { lang: '', code: '' };
      const langAttr = block.lang ? ` data-lang="${esc(block.lang)}"` : '';
      out.push(`<pre class="md-code"${langAttr}><code>${esc(block.code.replace(/\n$/, ''))}</code></pre>`);
      i++;
      continue;
    }
    if (/^>\s?/.test(line)) {
      const quote = [];
      while (i < lines.length && /^>\s?/.test(lines[i])) { quote.push(lines[i].replace(/^>\s?/, '')); i++; }
      out.push('<blockquote>' + markdownToHtml(quote.join('\n')) + '</blockquote>');
      continue;
    }
    if (/^(\s*)([-*+])\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^(\s*)([-*+])\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^(\s*)([-*+])\s+/, ''));
        i++;
      }
      out.push('<ul>' + items.map((item) => `<li>${mdInline(item)}</li>`).join('') + '</ul>');
      continue;
    }
    if (/^(\s*)(\d+)\.\s+/.test(line)) {
      const items = [];
      while (i < lines.length && /^(\s*)(\d+)\.\s+/.test(lines[i])) {
        items.push(lines[i].replace(/^(\s*)(\d+)\.\s+/, ''));
        i++;
      }
      out.push('<ol>' + items.map((item) => `<li>${mdInline(item)}</li>`).join('') + '</ol>');
      continue;
    }
    if (line.includes('|') && i + 1 < lines.length && /^\s*\|?\s*:?-{2,}/.test(lines[i + 1])) {
      const header = splitTableRow(line);
      i += 2;
      const rows = [];
      while (i < lines.length && lines[i].includes('|') && !isBlank(lines[i])) { rows.push(splitTableRow(lines[i])); i++; }
      out.push('<div class="md-table-wrap"><table><thead><tr>'
        + header.map((cell) => `<th>${mdInline(cell)}</th>`).join('')
        + '</tr></thead><tbody>'
        + rows.map((row) => `<tr>${header.map((_cell, idx) => `<td>${mdInline(row[idx] || '')}</td>`).join('')}</tr>`).join('')
        + '</tbody></table></div>');
      continue;
    }
    const paragraph = [line];
    i++;
    while (i < lines.length && !isBlank(lines[i]) && !isBlockStart(lines[i])) { paragraph.push(lines[i]); i++; }
    out.push('<p>' + paragraph.map((item) => mdInline(item)).join('<br>') + '</p>');
  }
  return out.join('\n');
}

/** 只走主进程 files:read；不再回退 file://，否则会绕过 realpath 和大小限制。 */
async function readProjectFileForPreview(project, item) {
  const name = item.name || String(item.rel || '').split('/').pop();
  const ext = fileExt(name);
  if (typeof window.workbench.filesRead !== 'function') throw new Error('当前版本没有受控文件读取接口，请用系统程序打开');
  const result = await window.workbench.filesRead({
    projectId: project.id, rel: item.rel,
    textMaxBytes: 512 * 1024, imageMaxBytes: 8 * 1024 * 1024
  });
  if (!result || !result.ok) throw new Error((result && result.message) || '读取失败');
  if (FILE_IMAGE_EXT.has(ext) && result.kind !== 'image') throw new Error('图片格式不受支持或文件损坏');
  return result;
}

async function openFileWithSystem(project, item) {
  const err = await window.workbench.filesOpen({ projectId: project.id, rel: item.rel });
  if (err) throw new Error(err);
}

/** 文件内嵌预览：Markdown/文本显示内容，图片显示图片；保留“用系统程序打开”。 */
function openFilePreview(project, item) {
  if (!project || !item) return;
  const name = item.name || String(item.rel || '').split('/').pop();
  const ext = fileExt(name);
  const kind = FILE_MD_EXT.has(ext) ? 'markdown' : (FILE_IMAGE_EXT.has(ext) ? 'image' : (FILE_TEXT_EXT.has(ext) ? 'text' : 'file'));
  const wrap = document.createElement('div');
  wrap.className = 'file-preview';
  wrap.innerHTML = `
    <div class="file-preview-bar">
      <span class="file-preview-path mono" title="${esc(item.rel)}">${esc(item.rel)}</span>
      <span class="file-preview-meta">${esc(fileKind(name))} · ${esc(fmtSize(item.size || 0))}</span>
      <span class="file-preview-modes" hidden>
        <button type="button" class="active" data-preview-mode="rendered">预览</button>
        <button type="button" data-preview-mode="source">源码</button>
      </span>
    </div>
    <div class="file-preview-stage"><div class="file-preview-loading">读取中…</div></div>
    <p class="file-preview-note">只读预览，不修改文件；需要编辑或外部工具时点下方「用系统程序打开」。</p>
    <div class="modal-error"></div>`;
  const stage = wrap.querySelector('.file-preview-stage');
  const modes = wrap.querySelector('.file-preview-modes');
  let loaded = null;
  let mode = kind === 'markdown' ? 'rendered' : 'source';

  const drawText = () => {
    if (!loaded) return;
    if (mode === 'rendered' && loaded.kind === 'markdown') {
      let display = String(loaded.text || '');
      let note = '';
      const relKey = String(item.rel || '').replace(/\\/g, '/');
      if (relKey === '项目索引.md') {
        const filtered = legacyFilterIndexMarkdown(display);
        display = filtered.text;
        note = `<div class="legacy-doc-filter-note">项目索引只显示真实需求 <b>${filtered.count}</b> 条；评审/验收记录不参与需求数。</div>`;
      } else if (/^需求\/R-[^/]+\.md$/i.test(relKey)) {
        const deduped = legacyDedupeStatusRecords(display);
        display = deduped.text;
        if (deduped.removed) note = `<div class="legacy-doc-filter-note">需求正文的「状态记录」有 ${deduped.removed} 条重复；界面只显示一次，不改文件。</div>`;
      }
      const body = document.createElement('div');
      body.className = 'markdown-body';
      // R-f9b1 F-7⑤：主正文头部若列了增补卷，打开就看得见（name/字节/sha12，可点开）；
      // 没有清单则什么都不插 —— 不报错、不截断正文。
      body.innerHTML = legacySupplementHeaderMarkup(display) + note + markdownToHtml(display);
      stage.replaceChildren(body);
    } else {
      const pre = document.createElement('pre');
      pre.className = 'file-preview-text';
      pre.textContent = String(loaded.text || '');
      stage.replaceChildren(pre);
    }
  };

  const draw = () => {
    if (!loaded) return;
    if (loaded.kind === 'image') {
      const img = new Image();
      img.className = 'file-preview-img';
      img.alt = name;
      img.src = loaded.dataUrl || loaded.src || '';
      img.addEventListener('error', () => {
        stage.innerHTML = '<div class="file-preview-error">图片加载失败；可以用系统程序打开。</div>';
      });
      stage.replaceChildren(img);
      return;
    }
    if (loaded.kind === 'pdf') {
      const frame = document.createElement('iframe');
      frame.className = 'file-preview-frame';
      frame.title = name;
      frame.src = loaded.src || '';
      stage.replaceChildren(frame);
      return;
    }
    if (loaded.kind === 'markdown' || loaded.kind === 'text') {
      const isMarkdown = loaded.kind === 'markdown';
      modes.hidden = !isMarkdown || String(loaded.text || '').length > 300000;
      if (modes.hidden) mode = 'source';
      modes.querySelectorAll('[data-preview-mode]').forEach((b) => {
        b.classList.toggle('active', b.dataset.previewMode === mode);
      });
      drawText();
      return;
    }
    stage.innerHTML = '<div class="file-preview-error">这个文件类型暂不内嵌预览；可以用系统程序打开。</div>';
  };

  modes.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-preview-mode]');
    if (!btn) return;
    mode = btn.dataset.previewMode === 'source' ? 'source' : 'rendered';
    draw();
  });

  openModal({
    title: '文件预览',
    subtitle: item.rel && item.rel !== name
      ? `${item.rel} · ${fileKind(name)} · ${fmtSize(item.size || 0)}`
      : `${fileKind(name)} · ${fmtSize(item.size || 0)}`,
    icon: '▣',
    body: wrap,
    width: 900,
    actions: [
      {
        label: '用系统程序打开', kind: 'ghost', onClick: async ({ error }) => {
          try {
            await openFileWithSystem(project, item);
            toast('已交给系统程序打开', 'ok');
          } catch (e) {
            error('系统程序打开失败：' + humanError(e.message));
          }
        }
      },
      { label: '关闭', kind: 'primary', onClick: ({ close }) => close() }
    ]
  });

  (async () => {
    try {
      loaded = await readProjectFileForPreview(project, item);
      draw();
    } catch (e) {
      stage.innerHTML = `<div class="file-preview-error">预览失败：${esc(humanError(e.message))}<br>可以用下方「用系统程序打开」。</div>`;
    }
  })();
}

function toggleFileDir(rel) {
  if (!rel) return;
  const opening = !fileUi.expanded.has(rel);
  if (!opening) { fileUi.expanded.delete(rel); renderFileTree(); return; }
  fileUi.expanded.add(rel);
  if (fileUi.loaded.has(rel)) { renderFileTree(); return; }
  // R-e31b §5.3：展开时才取这一层（不整树扫描）。
  void loadFileDir(rel).then(() => renderFileTree()).catch((e) => toast('目录读取失败：' + humanError(e.message), 'bad'));
}

async function loadFileDir(rel) {
  const p = activeProject();
  if (!p) return;
  const r = await window.workbench.filesList({ projectId: p.id, dir: rel, limit: 500 });
  if (!r || !r.ok) throw new Error((r && (r.message || r.code)) || '目录读取失败');
  fileUi.loaded.add(rel);
  fileUi.children.set(rel, Array.isArray(r.items) ? r.items : []);
  for (const it of fileUi.children.get(rel)) fileUi.byRel.set(it.rel, it);
  if (r.truncated) fileUi.truncated.add(rel); else fileUi.truncated.delete(rel);
}

async function loadFiles() {
  const p = activeProject();
  const box = $('#files-list');
  const rootEl = $('#files-root');
  const crumb = $('#file-crumb');
  const summary = $('#files-summary');
  if (!box) return;
  if (!p) {
    fileUi.projectId = null;
    fileUi.data = null;
    fileUi.children = new Map();
    fileUi.loaded = new Set();
    fileUi.truncated = new Set();
    fileUi.byRel = new Map();
    fileUi.expanded.clear();
    if (rootEl) rootEl.textContent = '—';
    if (summary) summary.textContent = '';
    if (crumb) crumb.title = '项目根目录';
    box.innerHTML = emptyView({
      mark: '▣',
      title: '选择一个项目',
      text: '文件页显示当前项目的目录树；点文件夹展开，点文件打开内嵌预览，预览里可再用系统程序打开。',
      action: '<button class="primary small" type="button" data-open-new-project>＋ 新建项目</button><button class="ghost small" type="button" data-open-restore>恢复已有目录</button>'
    });
    return;
  }
  if (fileUi.projectId !== p.id) {
    fileUi.projectId = p.id;
    fileUi.expanded.clear();
    fileUi.children = new Map();
    fileUi.loaded = new Set();
    fileUi.truncated = new Set();
    fileUi.byRel = new Map();
  }
  box.innerHTML = '<div class="empty-row">读取中…</div>';
  try {
    const r = await window.workbench.filesList({ projectId: p.id, dir: '', limit: 500 });
    if (!r || !r.ok) throw new Error((r && (r.message || r.code)) || '读取失败');
    fileUi.data = { root: r.root };
    fileUi.children = new Map([['', Array.isArray(r.items) ? r.items : []]]);
    fileUi.loaded = new Set(['']);
    fileUi.truncated = new Set(r.truncated ? [''] : []);
    fileUi.byRel = new Map();
    for (const it of fileUi.children.get('')) fileUi.byRel.set(it.rel, it);
    const root = r.root || p.path;
    if (rootEl) { rootEl.textContent = root; rootEl.title = root; }
    if (crumb) crumb.title = root;
    renderFileTree();
  } catch (e) {
    fileUi.data = null;
    if (summary) summary.textContent = '';
    box.innerHTML = '<div class="file-error"><b>项目目录读取失败</b><span>' + esc(humanError(e.message)) + '</span><button class="ghost small" type="button" data-file-retry>重试</button><button class="ghost small" type="button" data-open-project-folder>打开项目文件夹</button></div>';
  }
}

function renderFileTree() {
  const box = $('#files-list');
  if (!box || !fileUi.data) return;
  const rootItems = fileUi.children.get('') || [];
  const summary = $('#files-summary');
  const loadedCount = Array.from(fileUi.children.values()).reduce((n, arr) => n + (arr ? arr.length : 0), 0);
  if (summary) summary.textContent = '已加载 ' + loadedCount + ' 项';

  const dirSet = new Set();
  for (const arr of fileUi.children.values()) for (const it of arr || []) if (it.isDir) dirSet.add(it.rel);
  for (const rel of Array.from(fileUi.expanded)) if (!dirSet.has(rel)) fileUi.expanded.delete(rel);

  if (!rootItems.length) {
    box.innerHTML = '<div class="file-empty"><span class="file-empty-mark" aria-hidden="true">▱</span><b>项目目录为空</b><p>新建项目会自动生成角色目录、src/、_tmp/ 和项目信息.md。</p><button class="ghost small" type="button" data-open-project-folder>打开项目文件夹</button></div>';
    return;
  }

  const roleDirNames = ['项目经理', '产品', '需求分析师', '程序员A', '程序员B', '测试人员'];
  const build = (parent, depth) => (fileUi.children.get(parent) || []).map((it) => {
    const isDir = Boolean(it.isDir);
    const open = isDir && fileUi.expanded.has(it.rel);
    const dirKind = isDir ? (it.rel === '需求' ? '需求池' : (roleDirNames.includes(it.name) ? '角色目录' : '文件夹')) : '';
    const meta = isDir ? dirKind : fmtSize(it.size || 0) + ' · ' + fileKind(it.name);
    let html = '<div class="file-row' + (isDir ? ' is-dir' : '') + (open ? ' is-open' : '') + '" style="--depth:' + depth + '" data-file-rel="' + esc(it.rel) + '" data-file-kind="' + (isDir ? 'dir' : 'file') + '" tabindex="0" role="' + (isDir ? 'button' : 'link') + '"' + (isDir ? ' aria-expanded="' + open + '"' : '') + ' title="' + esc(it.rel) + '">'
      + '<span class="file-caret" aria-hidden="true">' + (isDir ? (open ? '⌄' : '›') : '') + '</span>'
      + '<span class="file-ico' + (isDir ? ' is-dir' : '') + '" aria-hidden="true">' + esc(fileIcon(it.name, isDir)) + '</span>'
      + '<span class="file-name">' + esc(it.name) + '</span>'
      + '<span class="file-meta">' + esc(meta) + '</span>'
      + '</div>';
    if (isDir && open) {
      const kids = fileUi.children.get(it.rel);
      if (!kids) html += '<div class="file-empty-row" style="--depth:' + (depth + 1) + '">读取中…</div>';
      else html += kids.length ? build(it.rel, depth + 1) : '<div class="file-empty-row" style="--depth:' + (depth + 1) + '">空文件夹</div>';
      if (fileUi.truncated.has(it.rel)) html += '<div class="file-empty-row" style="--depth:' + (depth + 1) + '">该目录条目超过 500，已截断；更多内容请在系统文件夹中查看。</div>';
    }
    return html;
  }).join('');

  let html = build('', 0);
  if (fileUi.truncated.has('')) html += '<div class="file-empty-row">该目录条目超过 500，已截断；更多内容请在系统文件夹中查看。</div>';
  box.innerHTML = html;
}

/* ── 新建 / 恢复 / 任务 / Owner ───────────────────────── */

function projectForm() {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <button type="button" id="np-adopt" class="adopt-entry">
      <span class="adopt-entry-ico" aria-hidden="true">▣</span>
      <span><b>打开已有项目文件夹</b><small>不复制、不移动；目录里需要有 项目信息.md</small></span>
    </button>
    <label class="field"><span><b>项目名称</b></span><input id="np-name" class="input" placeholder="例如：个人作品集" maxlength="60"><div class="hint">一个目录 = 一个项目。</div></label>
    <label class="field"><span><b>团队模式</b></span><select id="np-mode" class="select"><option value="full" selected>完整六角色（PM / 产品 / 需求 / 程序员A / 程序员B / 测试）</option><option value="fast">快速四角色（PM / 需求分析师 / 程序员A / 测试，无产品、无程序员B）</option></select><div class="hint">建项目时就按模式生成目录与协作准则；之后还能在「建团队」里切换（旧目录保留但不计入当前模式）。</div></label>
    <label class="field"><span><b>项目根目录</b></span><div class="form-row"><input id="np-root" class="input" value="${esc(state.defaultRoot || '')}"><button id="np-choose" type="button" class="ghost">选择</button></div><div class="hint">项目会创建在“根目录/项目名”。</div></label>
    <p id="np-preview" class="path-preview"></p>
    <div class="modal-error"></div>`;
  const name = wrap.querySelector('#np-name');
  const root = wrap.querySelector('#np-root');
  const preview = wrap.querySelector('#np-preview');
  const update = () => {
    const n = name.value.trim();
    const r = root.value.trim().replace(/[\\/]+$/, '');
    preview.textContent = n && r ? '将创建：' + r + '\\' + n : '';
  };
  name.addEventListener('input', update);
  root.addEventListener('input', update);
  wrap.querySelector('#np-choose').addEventListener('click', async () => {
    const dir = await window.workbench.chooseDir();
    if (dir) { root.value = dir; update(); }
  });
  return { wrap, name, root, preview, update, mode: wrap.querySelector('#np-mode') };
}

function openNewProject() {
  const f = projectForm();
  const dlg = openModal({
    title: '新建项目', subtitle: '项目目录、六角色和本地数据一次创建', icon: '＋', body: f.wrap, width: 620,
    actions: [
      { label: '取消', kind: 'ghost', onClick: ({ close }) => close() },
      { label: '创建项目', kind: 'primary', onClick: async ({ close, error }) => {
        try {
          const wantedMode = normalizeTeamMode(f.mode && f.mode.value);
          const r = await window.workbench.createProject({ name: f.name.value, root: f.root.value, teamMode: wantedMode });
          close();
          await applyState(r);
          // 创建返回的是目录/状态，不包含文档正文；等文件读完再提示，避免首帧显示“未读取/模板占位”。
          await legacyWaitForDocs();
          await loadLegacyDocs(true);
          await legacyWaitForDocs();
          const readiness = legacyDocReadiness();
          const created = activeProject();
          if (created) {
            if (!created.teamMode) saveProjectTeamMode(created, wantedMode);
            await focusDshWorkspace(created, { notify: true });
          }
          // 放最后：DSH 定位/切换可能自带 toast，创建结果与“文档已就绪”必须是用户看到的最后一条。
          const teamFailed = r.team && !r.team.ok;
          toast(
            teamFailed
              ? '项目已创建，但团队登记失败：' + (r.team.message || r.team.code || '未知原因')
              : (readiness.ok ? '项目已创建 · 文档已就绪' : '项目已创建 · 文档未就绪（缺几项见项目面板顶部「数据真源」条）'),
            teamFailed ? 'error' : 'ok'
          );
        } catch (e) { error(e.message); }
      } }
    ]
  });
  f.update();
  f.wrap.querySelector('#np-adopt').addEventListener('click', async () => {
    const dir = await window.workbench.chooseDir();
    if (!dir) return;
    try {
      const r = await window.workbench.adoptProject({ path: dir });
      await applyState(r);
      dlg.close();
      toast('项目已登记', 'ok');
      const adoptedProject = activeProject();
      if (adoptedProject) await focusDshWorkspace(adoptedProject, { notify: true });
    } catch (e) { dlg.error('恢复失败：' + e.message); }
  });
  setTimeout(() => f.name.focus(), 60);
}

async function openRestoreModal(options = {}) {
  let r;
  try { r = await window.workbench.discoverProjects(); }
  catch (e) { toast('扫描失败：' + e.message, 'bad'); return; }
  const items = r.items || [];
  const initialName = String(options.name || '').trim();
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <p class="hint">本机已登记 ${state.projects.length} 个工作区。团队 / DSH 清单里未登记的目录会显示在左上角「工作区」弹层；恢复成功会自动切到该项目。</p>
    <label class="field"><span><b>按项目名恢复团队</b></span>
      <div class="form-row"><input id="restore-name" class="input" placeholder="例如：个人作品集"><button id="restore-name-go" class="ghost" type="button">按名字恢复</button></div>
      <div class="hint">项目文件夹还在时，复用已有 DSH 会话；不会新建同名目录。</div>
    </label>
    <div class="restore-sep"><span>或从磁盘未登记目录登记</span></div>
    <p class="muted" style="margin-bottom:8px">扫描 <code>${esc(r.root || '')}</code>：找到 <b id="restore-count">${items.length}</b> 个未登记目录。</p>
    <label class="field"><span><b>按项目名筛选</b></span><input id="restore-filter" class="input" placeholder="输入项目名过滤"></label>
    <div id="restore-list" class="restore-list"></div>
    <div class="restore-sep"><span>或恢复已移除的项目记录（_deleted 归档）</span></div>
    <div id="restore-archived" class="restore-archived"><div class="hint">读取归档记录…</div></div>
    <div class="restore-foot">
      <button class="ghost small" id="restore-other" type="button">选择其他目录…</button>
      <button class="link-btn" id="restore-rescan" type="button">重新扫描</button>
    </div>
    <p class="hint">只登记目录，不复制、不覆盖；普通目录请先新建项目。</p>
    <div data-restore-error hidden></div>
    <div class="modal-error"></div>`;
  const dlg = openModal({
    title: '恢复项目', subtitle: '按名字复用团队会话，或从已有目录登记', icon: '♻', body: wrap, width: 640,
    actions: [{ label: '关闭', kind: 'ghost', onClick: ({ close }) => close() }]
  });
  const nameInput = wrap.querySelector('#restore-name');
  if (initialName) nameInput.value = initialName;
  const goBtn = wrap.querySelector('#restore-name-go');
  const restoreByName = async () => {
    const name = nameInput.value.trim();
    if (!name) { dlg.error('请输入项目名'); nameInput.focus(); return; }
    if (typeof window.workbench.teamRestore !== 'function') {
      dlg.error('当前版本不支持按名字恢复；可从下面目录登记');
      return;
    }
    const oldLabel = goBtn.textContent;
    goBtn.disabled = true;
    goBtn.textContent = '恢复中…';
    try {
      const res = await window.workbench.teamRestore({ name });
      if (!res || !res.ok) throw new Error(res?.why || res?.message || res?.code || '恢复失败');
      if (res.projectDir) {
        try { await window.workbench.adoptProject({ path: res.projectDir }); }
        catch { /* 已经登记过就不用再登记 */ }
      }
      await refresh();
      dlg.close();
      const dir = String(res.projectDir || '').toLowerCase();
      const registered = dir ? state.projects.some((p) => String(p.path).toLowerCase() === dir) : false;
      toast(registered ? '已恢复：' + (res.name || name) : '团队会话已恢复，但项目未登记；可用「选择其他目录」登记', registered ? 'ok' : 'bad');
      const restored = activeProject();
      if (registered && restored) await focusDshWorkspace(restored, { notify: true });
    } catch (e) {
      try {
        const bar = wrap.querySelector('[data-restore-error]');
        if (bar) { bar.hidden = false; bar.textContent = '恢复失败：' + String(e && e.message || e); bar.setAttribute('data-code', String((e && e.code) || 'RESTORE_FAILED')); }
      } catch { /* 横幅失败不影响错误提示 */ }
      dlg.error('恢复失败：' + e.message);
    } finally {
      goBtn.disabled = false;
      goBtn.textContent = oldLabel;
    }
  };
  goBtn.addEventListener('click', restoreByName);
  nameInput.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); restoreByName(); }
  });
  const list = wrap.querySelector('#restore-list');
  const filter = wrap.querySelector('#restore-filter');
  const count = wrap.querySelector('#restore-count');
  const renderList = () => {
    const q = filter.value.trim().toLowerCase();
    const shown = items.filter((x) => !q || x.name.toLowerCase().includes(q) || x.path.toLowerCase().includes(q));
    count.textContent = String(shown.length);
    list.innerHTML = shown.map((x) => `<button class="restore-item" type="button" data-restore="${esc(x.path)}"><b>${esc(x.name)}</b><small>${esc(x.path)}</small></button>`).join('')
      || '<div class="empty-row">没有匹配的未登记目录</div>';
  };
  filter.addEventListener('input', renderList);
  renderList();
  const adopt = async (dir) => {
    try {
      const x = await window.workbench.adoptProject({ path: dir });
      await applyState(x);
      dlg.close();
      toast('项目已恢复', 'ok');
      const recovered = activeProject();
      if (recovered) await focusDshWorkspace(recovered, { notify: true });
    } catch (e) { dlg.error('恢复失败：' + e.message); }
  };
  list.addEventListener('click', (e) => {
    const b = e.target.closest('[data-restore]');
    if (b) adopt(b.dataset.restore);
  });
  // 已移除的项目记录：从 团队/状态/项目/_deleted 归档恢复；目录还在走登记，目录不在标失效可重新定位。
  const archivedBox = wrap.querySelector('#restore-archived');
  const loadArchived = async () => {
    if (typeof window.workbench.archivedProjects !== 'function') {
      archivedBox.innerHTML = '<div class="empty-row">当前版本不支持归档恢复</div>';
      return;
    }
    try {
      const data = await window.workbench.archivedProjects();
      const rows = data && Array.isArray(data.items) ? data.items : [];
      archivedBox.innerHTML = rows.map((row) => `<button class="restore-item" type="button" data-restore-archive="${esc(row.archiveName)}">
        <b>${esc(row.name)}</b>
        <small>${esc(row.path || '原目录未记录')} · ${row.dirExists ? '目录存在' : '目录不存在'}${row.archivedAt ? ' · ' + esc(ownerMaterialTime(row.archivedAt)) : ''}</small>
      </button>`).join('') || '<div class="empty-row">还没有归档记录</div>';
    } catch (e) {
      archivedBox.innerHTML = `<div class="empty-row">归档读取失败：${esc(humanError(e.message))}</div>`;
    }
  };
  loadArchived();
  archivedBox.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-restore-archive]');
    if (!b || b.disabled) return;
    b.disabled = true;
    try {
      const res = await window.workbench.restoreArchivedProject({ archiveName: b.dataset.restoreArchive });
      if (!res || res.ok === false) throw new Error((res && (res.message || res.code)) || '恢复失败');
      if (res.needsAdopt) {
        const adopted = await window.workbench.adoptProject({ path: res.path });
        await applyState(adopted);
      } else if (res.state) {
        state = res.state;
        await refresh();
      }
      dlg.close();
      render();
      toast(res.missingDir
        ? '记录已恢复，但原目录不存在：在左栏点该项目用「重新定位」指回真实目录'
        : '已从归档恢复项目记录', res.missingDir ? 'warn' : 'ok');
    } catch (err) {
      b.disabled = false;
      dlg.error('恢复失败：' + humanError(err.message));
    }
  });
  wrap.querySelector('#restore-other').addEventListener('click', async () => {
    const dir = await window.workbench.chooseDir();
    if (dir) await adopt(dir);
  });
  wrap.querySelector('#restore-rescan').addEventListener('click', async () => {
    dlg.close();
    await openRestoreModal();
  });
  setTimeout(() => {
    nameInput.focus();
    if (initialName) nameInput.select();
  }, 50);
}

function taskForm() {
  const p = activeProject();
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <label class="field"><span><b>任务标题</b></span><input id="nt-title" class="input" placeholder="例如：完成首页信息架构" maxlength="120"></label>
    <div class="form-row">
      <label class="field" style="flex:1"><span><b>角色</b></span><select id="nt-role" class="select">${teamRoles(p).map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}</select></label>
      <label class="field" style="flex:0 0 110px"><span><b>优先级</b></span><select id="nt-priority" class="select"><option>P0</option><option selected>P1</option><option>P2</option><option>P3</option></select></label>
    </div>
    <p class="hint">当前项目：${esc(p?.name || '—')}。任务会推进项目阶段；Owner 评审在任务建立后出现。</p>
    <div class="modal-error"></div>`;
  return { wrap, title: wrap.querySelector('#nt-title'), role: wrap.querySelector('#nt-role'), priority: wrap.querySelector('#nt-priority') };
}

function openTaskModal() {
  const p = activeProject();
  if (!p) { openNewProject(); return; }
  const f = taskForm();
  openModal({
    title: '新建任务', subtitle: p.name, icon: '＋', body: f.wrap, width: 560,
    actions: [
      { label: '取消', kind: 'ghost', onClick: ({ close }) => close() },
      { label: '创建任务', kind: 'primary', onClick: async ({ close, error }) => {
        try {
          const title = f.title.value.trim();
          if (!title) throw new Error('任务标题不能为空');
          const r = await window.workbench.createTask({ projectId: p.id, title, role: f.role.value, priority: f.priority.value });
          close();
          await applyState(r);
          toast('任务已创建', 'ok');
        } catch (e) { error(e.message); }
      } }
    ]
  });
  setTimeout(() => f.title.focus(), 50);
}

/**
 * Owner 入口只保留一个“需求级”闸门：有需求时直接列出需求，不再先让用户
 * 在项目级 ownerReview 与需求级 ownerReview 之间猜。项目级旧闸门单独降级入口。
 */
function openOwnerGate() {
  const p = activeProject();
  if (!p) { openNewProject(); return; }
  if (!legacyUi.workflow && !legacyUi.workflowError) {
    loadLegacyDocs(true);
    toast('工作流状态还在读取：稍后再打开 Owner 闸门，界面不会拿项目级字段猜需求结论', 'warn');
    return;
  }
  const gates = legacyOwnerGateRequirements();
  if (gates.length === 1) { legacyActionModal('owner-review', gates[0].id); return; }
  const active = legacyRequirements()
    .filter((req) => !['accepted', 'terminated', 'iteration'].includes(String(req.status || '')))
    .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const terms = modeTerms(p);
  const rows = (gates.length ? gates : active).map((req) => {
    const owner = legacyReqOwnerView(req);
    const reviewRole = isQuickTeam() ? 'analyst' : 'product';
    const reviewLabel = terms.review;
    const reviewReady = legacyRoleReady(reviewRole);
    const can = String(req.status) === 'approved' && reviewReady;
    const why = String(req.status) !== 'approved'
      ? `${reviewLabel}通过（approved）后才进入 Owner 闸门`
      : (reviewReady ? '打开需求级 Owner 决定' : `${roleById(reviewRole).name}未 boot/读全，后端会拒绝 requirement:owner`);
    return `<div class="owner-gate-row">
      <div><b>${esc(req.id)} · ${esc(req.title || '未写标题')}</b>
        <small>${esc(legacyReqStatus(req))} · Owner ${esc(owner.label)} · ${esc(reviewLabel)} ${req.productReview ? esc(req.productReview.verdict || '未写结论') : '未记录'}</small>
      </div>
      <button class="ghost small" type="button" data-owner-gate-req="${esc(req.id)}" ${can ? '' : 'disabled'} title="${esc(why)}">${can ? 'Owner（我）一次点击' : '未到 Owner 闸门'}</button>
    </div>`;
  }).join('');
  const body = `<p class="legacy-modal-warn">这里只列<b>需求级</b> Owner 闸门：决定会写入该需求的 <code>ownerReview</code>，是 PM 派单的前置。下面按钮不会写项目级顶层字段。</p>
    ${rows || '<div class="owner-gate-none">还没有需求。Owner 的“参与 / 跳过”发生在产品评审通过之后。<br>项目级旧闸门不会推动任何需求，仅供历史对照。</div>'}
    <div class="legacy-owner-legacy"><b>项目级 Owner（旧版）：</b>只写顶层 <code>ownerReview</code>，不参与 PM 派单。需要历史对照时再打开。</div>`;
  const dlg = openModal({
    title: 'Owner 需求决定',
    subtitle: `${p.name} · 需求级 Owner 闸门；项目级旧闸门不参与派单`,
    icon: '◉',
    width: 640,
    body,
    actions: [
      { label: '关闭', kind: 'ghost', onClick: ({ close }) => close() }
    ]
  });
  dlg.body.querySelectorAll('[data-owner-gate-req]').forEach((button) => {
    button.addEventListener('click', () => {
      const reqId = button.dataset.ownerGateReq;
      dlg.close();
      legacyActionModal('owner-review', reqId);
    });
  });
}

function openOwnerModal() {
  const p = activeProject();
  if (!p) { openNewProject(); return; }
  const os = ownerState(p);
  const owner = os.owner;
  const tasks = Array.isArray(p.tasks) ? p.tasks : [];
  const dlg = openModal({
    title: '项目级 Owner 评审（旧版）',
    subtitle: `${p.name} · 只写项目顶层 ownerReview，不参与需求派单；需求级 Owner 请从流程/需求卡片进入`,
    icon: '◉',
    width: 600,
    closable: true,
    actions: []
  });

  const submit = async (status, buttons, opinionOverride = null) => {
    const opinion = opinionOverride !== null
      ? String(opinionOverride || '').trim()
      : (dlg.body.querySelector('#ow-opinion')?.value || '').trim();
    setButtonsBusy(buttons, true);
    try {
      // Owner（我）一次点击：不再弹确认码输入框，也不调用 owner:challenge / owner:confirm。
      const result = await window.workbench.ownerDecide({
        projectId: p.id, status, opinion,
        ownerConfirmed: true
      });
      if (!result || result.ok === false) {
        const why = result && (result.why || result.message || result.code);
        dlg.error('保存失败：' + (why || '主进程没有返回有效结果'));
        setButtonsBusy(buttons, false);
        return;
      }
      const entry = rememberOwnerResult(p.id, result, status, OWNER_CONFIRM_ACTOR);
      await applyState(result);
      showResult(result, status);
      const label = status === 'skipped' ? '已跳过当前 Owner 评审'
        : status === 'rejected' ? '已打回，流程回到需求阶段'
          : '已通过 Owner 评审';
      const issues = [];
      if (!entry.workflowFile) issues.push('workflowFile 未返回');
      if (!entry.notified) issues.push('notified 未返回（PM 没有收到系统消息）');
      for (const warning of entry.warnings) {
        const text = ownerWarningText(warning);
        if (text) issues.push(text);
      }
      const actorNote = `；actor=${OWNER_CONFIRM_ACTOR}（本机点击）`;
      if (issues.length) {
        toast(`${label}${actorNote}；但结果有 ${issues.length} 条告警：${issues[0]}`, 'bad');
      } else {
        toast(`${label}${actorNote}；workflowFile 与 PM 通知均已回传`, 'ok');
      }
    } catch (e) {
      dlg.error('保存失败：' + humanError(e.message));
      setButtonsBusy(buttons, false);
    }
  };

  const showDecision = (opinionDraft = null) => {
    const initialOpinion = opinionDraft !== null ? String(opinionDraft || '') : String(owner.opinion || '');
    dlg.body.innerHTML = `
      <p class="muted" style="margin-bottom:10px">看完需求 / 产品更新文档后，写一句判断；可以先把项目文件夹打开对照。Owner（我）按钮一次点击直接提交，无需二次确认。</p>
      <div class="quick-actions" style="margin-top:0;margin-bottom:10px"><button class="ghost small" type="button" id="owner-open-folder">打开项目文件夹</button></div>
      <label class="field"><span><b>Owner 意见</b><span class="field-note">会作为当前决定保存在本地</span></span><textarea id="ow-opinion" class="textarea" maxlength="1000" placeholder="例如：需求边界清楚，通过；或：登录流程缺少异常状态，打回需求。">${esc(initialOpinion)}</textarea></label>
      <p class="hint">“通过”建议写一句意见；“打回”会回到需求阶段。</p>
      <div class="modal-error"></div>`;
    dlg.body.querySelector('#owner-open-folder').addEventListener('click', openProjectFolder);
    dlg.foot.innerHTML = '';
    const back = makeButton('ghost', '返回上一步');
    const reject = makeButton('ghost', 'Owner（我）打回需求');
    const pass = makeButton('primary', 'Owner（我）通过');
    back.addEventListener('click', showChoice);
    reject.addEventListener('click', () => submit('rejected', [back, reject, pass]));
    pass.addEventListener('click', () => submit('approved', [back, reject, pass]));
    dlg.foot.append(back, reject, pass);
    setTimeout(() => dlg.body.querySelector('#ow-opinion')?.focus(), 50);
  };

  const showChoice = () => {
    dlg.body.innerHTML = `
      <p class="legacy-modal-warn">这是<b>旧版项目级 Owner 闸门</b>：只写顶层 <code>ownerReview</code>，<b>不会写入任何需求的 <code>ownerReview</code></b>，也不会让 PM 派单通过。需求级 Owner 决定请从「流程 / 需求卡片」进入。</p>
      <p class="owner-intro">当前不是必审，但需要你明确选择：跳过评审，或看完项目文件后留下意见。意见会作为当前项目级 Owner 决定保存在本地。关闭不会自动弹窗，也不会丢失入口。</p>
      <div class="owner-summary">
        <div><span>当前阶段</span><b>${esc(stageById(p.stage).label)}</b></div>
        <div><span>任务</span><b>${tasks.length} 个（完成 ${tasks.filter((t) => t.status === 'done').length}）</b></div>
        <div><span>Owner 状态</span><b class="${os.pending ? 'bad' : ''}">${esc(os.label)}</b></div>
      </div>
      ${os.opinion ? `<p class="hint">上一次意见：${esc(os.opinion)}${os.at ? ' · ' + esc(fmtTime(os.at)) : ''}</p>` : ''}
      <div class="quick-actions"><button class="ghost small" type="button" id="owner-open-folder">打开项目文件夹</button></div>
      <p class="hint">“通过”需要写一句意见；“打回”会回到需求阶段；再次打开会覆盖当前决定。</p>
      <div class="modal-error"></div>`;
    dlg.body.querySelector('#owner-open-folder').addEventListener('click', openProjectFolder);
    dlg.foot.innerHTML = '';
    const skip = makeButton('ghost', 'Owner（我）跳过');
    const start = makeButton('primary', 'Owner（我）开始评审');
    skip.addEventListener('click', () => submit('skipped', [skip, start]));
    start.addEventListener('click', () => showDecision());
    dlg.foot.append(skip, start);
  };

  /** 决定后不直接关窗：把 workflowFile / notified / warnings 的真实回传摆出来。 */
  const showResult = (result, status) => {
    const entry = ownerResultFor(p) || rememberOwnerResult(p.id, result, status);
    dlg.body.innerHTML = `
      <p class="muted" style="margin-bottom:10px">本地决定已保存；下面是主进程真实回传。没有回传的字段会标“未返回”，不会只报成功。</p>
      ${ownerResultMarkup(entry)}
      <div class="modal-error"></div>`;
    dlg.foot.innerHTML = '';
    const again = makeButton('ghost', '重新评审');
    const close = makeButton('primary', '关闭');
    again.addEventListener('click', showChoice);
    close.addEventListener('click', () => dlg.close());
    dlg.foot.append(again, close);
  };

  showChoice();
  setTimeout(() => dlg.foot.querySelector('.primary')?.focus(), 50);
}

/* ── DSH 适配 ─────────────────────────────────────────── */

// B-f749：webview 与状态同源。记录最后一次同步的地址/在线态 + 最近一次加载失败（URL/错误码）。
const dshViewUi = { lastBaseUrl: '', lastOnline: null };
let dshViewError = null;
// PM 13:41 热修（f749 残留）：记录 webview 真实显示的正文长度。
// 只有「页面真的加载出内容」才允许隐藏「DSH 引擎没有连上」覆盖层；
// 否则 401/空白页会被误判成成功，变成黑屏且无任何提示。
let dshGuestBodyLen = 0;
let dshBodyProbeSeq = 0;
const dshCookieRetry = { at: 0, url: '', count: 0 };
// PM 19:15 热修（Owner：卡到打不了字，随后自重启黑屏）：重载必须有**全局硬闸**。
// 401 页正文很短时会被误判成「页面已出」→ 预算被反复重置 → reload 风暴 → CPU 打满。
const dshReloadCap = { at: 0, count: 0 };
const DSH_RELOAD_CAP_MAX = 6;
const DSH_RELOAD_CAP_WINDOW_MS = 10 * 60 * 1000;
const DSH_COOKIE_RETRY_MAX = 3;
// PM 13:45：导航在途禁止自动重载；同一 baseUrl 的自动重试全局只允许 1 次，之后只能用户手动点。
const dshViewLoad = { starts: 0, stops: 0, loading: false, loadingSince: 0, autoReloads: {} };
const dshNormUrl = (u) => String(u || '').replace(/\/+$/, '');
try { window.__dshViewLoadStats = () => ({ starts: dshViewLoad.starts, stops: dshViewLoad.stops, loading: dshViewLoad.loading, autoReloads: dshViewLoad.autoReloads, bodyLen: dshGuestBodyLen, error: dshViewError }); } catch { /* ignore */ }
/** 优先让主进程读 guest（webview.executeJavaScript 在部分 Electron 版本/时机不可用，会永远测到 0）。 */
async function dshGuestProbe() {
  const api = window.workbench;
  if (api && typeof api.dshGuestProbe === 'function') {
    try {
      const r = await api.dshGuestProbe();
      if (r && r.ok) return r;
    } catch { /* ignore */ }
  }
  return null;
}
function dshAutoReloadAllowed(base) {
  if (!base) return false;
  if (dshViewLoad.loading) return false;
  return !(dshViewLoad.autoReloads[base] > 0);
}
function dshMarkAutoReload(base) {
  if (!base) return;
  dshViewLoad.autoReloads[base] = (dshViewLoad.autoReloads[base] || 0) + 1;
}
/** DSH 重启后 browser-session 密钥可能变化 → 401/空白。重新安装 cookie 并只重试一次。 */
async function retryDshCookieOnce(reason = 'blank') {
  const api = window.workbench;
  if (!api || typeof api.reinstallDshCookie !== 'function') return false;
  const base = String((state && state.dsh && state.dsh.baseUrl) || '');
  if (!base) return false;
  if (dshCookieRetry.url === base && Date.now() - dshCookieRetry.at < 8000) return false;
  // PM 15:45 热修：冷启动首次加载常还没装好 cookie（401/空白），cookie 重试不能被
  // 「同 base 只自动重载 1 次」的闸挡死；改用独立预算（每 base 最多 3 次、间隔 ≥8s）。
  if (dshCookieRetry.url !== base) dshCookieRetry.count = 0;
  if (Date.now() - dshReloadCap.at > DSH_RELOAD_CAP_WINDOW_MS) { dshReloadCap.at = Date.now(); dshReloadCap.count = 0; }
  if (dshReloadCap.count >= DSH_RELOAD_CAP_MAX) {
    try { console.log('[dsh-view] reload-cap reached count=' + dshReloadCap.count); } catch { /* ignore */ }
    return false;
  }
  if ((dshCookieRetry.count || 0) >= DSH_COOKIE_RETRY_MAX) {
    try { console.log('[dsh-view] cookie-retry exhausted count=' + dshCookieRetry.count); } catch { /* ignore */ }
    return false;
  }
  dshCookieRetry.url = base;
  dshCookieRetry.at = Date.now();
  dshCookieRetry.count = (dshCookieRetry.count || 0) + 1;
  dshReloadCap.count += 1;
  try {
    const result = await api.reinstallDshCookie();
    try { console.log('[dsh-view] cookie-retry reason=' + reason + ' ok=' + Boolean(result && result.ok)); } catch { /* ignore */ }
    if (result && result.ok) {
      dshMarkAutoReload(base);
      applyDshViewSrc(true, 'cookie-retry', { auto: true });
      return true;
    }
  } catch { /* ignore */ }
  return false;
}

/**
 * B-f749：唯一 webview 地址/重载函数。
 * - 地址与 status.baseUrl 不同 → 改 src；
 * - force=true（同址离线→在线/点「重载 WebView」）→ reload。
 * - opts.auto=true（状态推送/重试触发的自动动作）受「加载中禁止 + 同 base 只 1 次」闸限制；
 *   用户手动按钮传 auto=false，不受限。
 */
function applyDshViewSrc(force = false, reason = 'src', opts = {}) {
  const view = $('#dsh-view');
  if (!view) return false;
  const base = String((state && state.dsh && state.dsh.baseUrl) || '');
  if (!base) return false;
  const current = String(view.getAttribute('src') || '');
  const normUrl = (u) => String(u || '').replace(/\/+$/, '');
  const same = normUrl(current) === normUrl(base);
  if (same && !force) return false;
  if (opts.auto && !dshAutoReloadAllowed(base)) {
    try { console.log('[dsh-view] auto-' + (same ? 'reload' : 'set-src') + ' skipped reason=' + reason + ' loading=' + dshViewLoad.loading + ' autoUsed=' + Boolean(dshViewLoad.autoReloads[base])); } catch { /* ignore */ }
    return false;
  }
  dshViewFailed = false;
  dshReady = false;
  dshViewError = null;
  try {
    if (same) view.reload();
    else view.setAttribute('src', base);
  } catch {
    try { view.setAttribute('src', base); } catch { /* ignore */ }
  }
  if (opts.auto) dshMarkAutoReload(base);
  try { console.log('[dsh-view] ' + (same ? 'reload' : 'set-src') + ' reason=' + String(reason || 'src') + ' url=' + base + ' auto=' + Boolean(opts.auto)); } catch { /* ignore */ }
  return true;
}

function forceReloadDshView(reason = 'manual') {
  const changed = applyDshViewSrc(true, reason, { auto: false });
  try { renderDsh(state?.dsh); } catch { /* ignore */ }
  return changed;
}

/** 状态变化时保证 webview 指向同一地址：地址变→applyDshViewSrc；同址离线→在线→强制 reload。 */
function syncDshViewWithStatus(dsh) {
  const view = $('#dsh-view');
  if (!view) return;
  const base = String((dsh && dsh.baseUrl) || '');
  const online = Boolean(dsh && dsh.online);
  const prevBase = dshViewUi.lastBaseUrl;
  const prevOnline = dshViewUi.lastOnline;
  dshViewUi.lastBaseUrl = base;
  dshViewUi.lastOnline = online;
  if (!base || !online) return;
  // 地址变化时重置自动重载/cookie 重试预算（A-04/A-05：旧地址的失败次数不能拖累新地址）。
  if (prevBase && prevBase !== base) {
    dshViewLoad.autoReloads = {};
    dshCookieRetry.at = 0;
    dshCookieRetry.url = '';
    dshCookieRetry.count = 0;
  }
  const current = String(view.getAttribute('src') || '');
  if (dshNormUrl(current) !== dshNormUrl(base) || (prevBase && prevBase !== base)) {
    applyDshViewSrc(false, 'status', { auto: true });
    return;
  }
  // 同址从离线恢复：只在加载不在途、且该 base 没自动重试过时 reload，避免状态抖动造成循环。
  if (prevOnline !== true) applyDshViewSrc(true, 'reconnect', { auto: true });
}

function renderDsh(dsh) {
  const pill = $('#btn-dsh');
  const dot = $('#dsh-dot');
  const label = $('#dsh-label');
  const detail = $('#dsh-detail');
  const online = Boolean(dsh && dsh.online);
  const configured = Boolean(dsh && dsh.configured);
  const stateLabel = online ? 'DSH 已连接' : (configured ? 'DSH 离线' : 'DSH 未配置');

  if (pill) {
    pill.innerHTML = `<span class="pill-dot"></span><span>${stateLabel}</span>`;
    pill.classList.toggle('online', online);
    pill.title = dsh?.baseUrl ? `${dsh.baseUrl} · 点击重新检测` : 'DSH 外部引擎状态';
  }
  if (dot) dot.classList.toggle('online', online);
  if (label) label.textContent = online ? 'DSH 已连接' : (configured ? 'DSH 离线' : 'DSH 未配置');
  if (detail) {
    detail.textContent = dsh?.message || '外部会话引擎';
    detail.title = (dsh?.baseUrl || '') + (dsh?.message ? ' · ' + dsh.message : '');
  }

  const off = $('#dsh-off');
  if (off) {
    // PM 16:05（Owner 拍板，最高优先级）：**连上就直接显示原生 DSH 界面，不做任何遮挡**。
    // 覆盖层只在「DSH 本身没连上（online=false）」时出现；不再依据 bodyLen/probe/did-finish 状态判定，
    // 也不允许因为"探针读到 0"把已经加载出来的原生界面盖住（今天多次因此把好页面挡了）。
    // Owner 16:05/16:06 最高优先：连上就直接显示原生 DSH 界面，不做任何判断、不遮挡。
    // 覆盖层只在 online=false **且 webview 还没有成功加载过页面** 时出现；
    // 页面一旦 did-finish，后续探测抖动（DSH 忙时 fetch 偶发失败）绝不能再把主区盖住。
    const showOff = !online && !dshReady;
    off.hidden = !showOff;
    const url = $('#dsh-off-url');
    if (url) {
      if (dshViewError && (dshViewError.code || dshViewError.url)) {
        url.textContent = 'WebView 加载失败：' + String(dshViewError.url || '（地址未知）')
          + ' · 错误码 ' + String(dshViewError.code == null ? '未知' : dshViewError.code)
          + (dshViewError.description ? '（' + dshViewError.description + '）' : '')
          + ' · 可点「重载 WebView」重试';
      } else {
        url.textContent = (dsh?.baseUrl || '地址未配置') + (dsh?.message ? ' · ' + dsh.message : '');
      }
    }
  }
  const modeButton = $('#btn-dsh-mode');
  if (modeButton) {
    modeButton.title = online ? '重载 DSH 主画面' : 'DSH 离线：先启动 DSH Web';
    modeButton.setAttribute('aria-pressed', String(!online));
  }
  syncDshViewWithStatus(dsh);
}

async function probeDsh(force = false, quiet = false) {
  if (!window.workbench) return null;
  if (!force && Date.now() - dshProbeAt < 4000) return state?.dsh || null;
  dshProbeAt = Date.now();
  try {
    const s = await window.workbench.dshStatus();
    if (!state) state = await window.workbench.state();
    state.dsh = s.status;
    renderDsh(s.status);
    return s.status;
  } catch (e) {
    if (!quiet) toast('DSH 检测失败：' + e.message, 'bad');
    return state?.dsh || null;
  }
}

async function initDsh() {
  try {
    const s = await window.workbench.dshStatus();
    state.dsh = s.status;
    renderDsh(s.status);
    applyDshViewSrc(false, 'misc', { auto: true });
  } catch { /* 配置缺失时保留静态文案 */ }
}

async function retryDsh() {
  const btn = $('#dsh-retry');
  if (btn) btn.disabled = true;
  try {
    const status = await probeDsh(true, true);
    if (!status || !status.online) {
      toast('DSH 仍未连接：' + ((status && status.message) || '检查地址或先启动 dsh web'), 'bad');
      return;
    }
    dshViewFailed = false;
    dshReady = false;
    applyDshViewSrc(false, 'misc', { auto: true });
    const view = $('#dsh-view');
    try { view?.reload(); } catch { applyDshViewSrc(true, 'retry-fallback', { auto: false }); }
    renderDsh(state.dsh);
    toast('正在重新连接 DSH', 'ok');
  } catch (e) {
    toast('重试失败：' + e.message, 'bad');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* B-6bb5（P0）：卡片里的「重试连接」——离线→在线一次恢复，不重启。
 * 先 probeDsh（会更新 state.dsh 与 DSH 灯），成功后再 refresh() 重画卡片/会话行；失败把错误码带出来。 */
async function retryDshFromCard(btn) {
  try { window.__dshRetryCalls = Number(window.__dshRetryCalls || 0) + 1; } catch { /* ignore */ }
  if (btn) btn.disabled = true;
  try {
    const status = await probeDsh(true, false);
    if (!status || !status.online) {
      toast('DSH 仍未连接：' + String((status && status.code) || 'DSH_OFFLINE') + ' · ' + ((status && status.message) || '检查地址或先启动 dsh web'), 'bad');
      return;
    }
    toast('DSH 已连接，正在刷新会话…', 'ok');
    await refresh();
    // 并发兜底：初始 dshStatus 可能在重试前发出、重试后才带着「离线」返回；这里再取一次最新状态并重画会话区，
    // 避免「点重试成功但卡片仍停在离线」的竞态（夹具 DSH 离线→恢复即覆盖）。
    try {
      const again = await window.workbench.dshStatus();
      if (again && again.status) { state.dsh = again.status; renderDsh(again.status); renderSessions(); }
    } catch { /* 二次核验失败不阻断主刷新 */ }
    const p = activeProject();
    if (p) { try { await loadDshTeamStatus({ force: true }); } catch { /* 核验失败不阻断卡片恢复 */ } }
  } catch (e) {
    toast('重试失败：' + humanError(e.message), 'bad');
  } finally {
    if (btn) btn.disabled = false;
  }
}

/* ── 会话映射自动跟随（B-405f 补充）：轮换/换人后不用重启工作台 ─────────
 * 以前界面只在启动或手动刷新时读一次 workbench.json；team.mjs session rotate 在
 * 进程外改了映射，左侧就停在 4/6，必须重启。这里每 5 秒只读一次状态：
 * 映射签名变了才重画会话相关区域（不整页 render，保留抽屉与正在填的派单表单）。
 */
const ROSTER_WATCH_MS = 5000;
// R-a1eb（T-20261119-141958-16dd）：名册变化改为「推送优先、轮询兜底」。
//  push  = 壳层 roster-push 合并器发的 team:session-queue-changed(reason='roster')，一批换人只发一次；
//  pending/coalesced = 同步在途时再来的推送只补跑一次（不按角色重复刷新）。
const rosterUi = {
  busy: false,
  pending: false,
  timer: null,
  lastSig: '',
  lastAt: 0,
  pushBound: false,
  pushStats: { events: 0, syncs: 0, pushSyncs: 0, coalesced: 0, coalescedRuns: 0, lastReason: '', lastAt: '' }
};

function rosterSignature(s) {
  const list = s && Array.isArray(s.projects) ? s.projects : [];
  return list.map((p) => `${p.id}:${JSON.stringify(p.sessions || {})}:${JSON.stringify((p.workspace && p.workspace.sessionIds) || [])}`).join('|');
}

async function syncRosterFromDisk(opts = {}) {
  if (!window.workbench || typeof window.workbench.state !== 'function') return false;
  // 合并口径：同步在途时再来的请求只记一次「待补跑」，本次结束后**只补一次**（不按角色/事件重复刷）。
  if (rosterUi.busy) { rosterUi.pending = true; rosterUi.pushStats.coalesced += 1; return false; }
  rosterUi.busy = true;
  // 只读统计：syncs=实际读盘重画的次数（含 5 秒轮询兜底）；pushSyncs=其中由名册推送触发的次数。
  rosterUi.pushStats.syncs += 1;
  if (String(opts.reason || '').startsWith('roster')) rosterUi.pushStats.pushSyncs = (rosterUi.pushStats.pushSyncs || 0) + 1;
  try {
    const next = await window.workbench.state();
    if (!next) return false;
    const before = rosterSignature(state);
    const after = rosterSignature(next);
    if (!opts.force && after === before) return false;
    rosterUi.lastSig = after;
    state = next;
    hydrateTeamModes();
    // 只重画与会话映射相关的区域，避免打断抽屉/表单的输入状态。
    renderSidebar();
    renderSessions();
    renderTeamSessions();
    renderHeader();
    renderOverview();
    renderWorkspacePopover();
    if (openDrawerName === 'project') renderTeamWorkspace();
    if (openDrawerName === 'team') renderTeam();
    if (opts.notify) {
      const p = activeProject();
      toast(`会话映射已更新：${p ? sessionReadyCount(p) + '/' + teamRoleCount(p) : '—'}`, 'ok');
    }
    return true;
  } catch {
    return false;
  } finally {
    rosterUi.busy = false;
    if (rosterUi.pending) {
      rosterUi.pending = false;
      rosterUi.pushStats.coalescedRuns += 1;
      // 补跑一次即可：合并窗口内的 N 次推送已经在这里合成一次同步。
      await syncRosterFromDisk({ ...opts, reason: String(opts.reason || '') + '+pending' }).catch(() => {});
    }
  }
}

function rosterWatchTick() {
  // 只读一次 workbench 状态（JSON 文件），开销很小；不做 document.hidden 跳过，
  // 否则最小化/沙盘窗口里轮换后的映射永远不刷新，Owner 回来还是旧的 4/6。
  const now = Date.now();
  if (now - rosterUi.lastAt < ROSTER_WATCH_MS - 250) return;
  rosterUi.lastAt = now;
  syncRosterFromDisk().catch(() => {});
}

/* R-a1eb（T-20261119-141958-16dd）：名册推送（推一次 → 同步一次）。
 *  通道复用既有 team:session-queue-changed（壳层 roster-push 合并器发 reason='roster'），
 *  不新增 IPC、不改 preload：面板自己也是订阅这条通道，两边各自一次、互不放大。
 *  同步在途时只记一次补跑（见 syncRosterFromDisk），所以「批量换人 N 个角色」只刷新一次。
 */
function requestRosterSync(source) {
  rosterUi.pushStats.lastReason = String(source || 'push');
  rosterUi.pushStats.lastAt = new Date().toISOString();
  rosterUi.lastAt = Date.now();
  syncRosterFromDisk({ reason: String(source || 'push') }).catch(() => {});
}

function bindRosterPush() {
  const bridge = window.workbench;
  if (!bridge || typeof bridge.onSessionQueueChanged !== 'function') return false;
  try {
    bridge.onSessionQueueChanged((payload) => {
      const reason = String((payload && payload.reason) || '');
      // 只接名册推送：会话排队/任务 watch 等由队列面板自管，这里不重复读状态。
      if (reason !== 'roster') return;
      rosterUi.pushStats.events += 1;
      requestRosterSync('roster');
    });
    rosterUi.pushBound = true;
  } catch {
    rosterUi.pushBound = false;
  }
  return rosterUi.pushBound;
}

function startRosterWatch() {
  if (rosterUi.timer) return;
  rosterUi.lastSig = rosterSignature(state);
  rosterUi.lastAt = Date.now();
  // 推送优先（换人后立刻刷新、且只刷一次）；5 秒轮询保留为兜底（通道不可用时行为与旧实现一致）。
  bindRosterPush();
  try { bindWorkflowSideEffects(); } catch { /* 后台失败提示不阻塞首屏 */ }
  rosterUi.timer = setInterval(r4Gate(rosterWatchTick), ROSTER_WATCH_MS);
  // 自测/排查用只读钩子：当前映射签名与侧栏计数。
  window.__teamRoster = {
    sync: (opts) => syncRosterFromDisk(opts || {}),
    sig: () => rosterSignature(state),
    count: () => (document.querySelector('#team-session-count') || {}).textContent || '',
    // 只读统计：推送次数 / 同步次数 / 合并补跑次数（夹具据此断言「一批只刷新一次」）。
    pushStats: () => ({ ...rosterUi.pushStats, pushBound: rosterUi.pushBound, pending: rosterUi.pending }),
  };
  window.__rosterPushStats = window.__teamRoster.pushStats;
}

const dshRefreshUi = { busy: null, pending: false, lastAt: 0 };
const autoRebindUi = { busy: false, lastKey: '', lastAt: 0 };

/** B-33b9 追加：地址切换/重载成功后一次刷新全部（dsh 状态 + 名册 + 映射 + 六角色区）。 */
async function refreshDshEverywhere(reason = 'push') {
  // D1：凭据变化时重置 cookie 重试与自动重载预算，允许新凭据再次自愈。
  if (/credential/i.test(String(reason || ''))) {
    dshCookieRetry.at = 0;
    dshCookieRetry.url = '';
    dshCookieRetry.count = 0;
    dshViewLoad.autoReloads = {};
  }
  if (dshRefreshUi.busy) { dshRefreshUi.pending = true; return dshRefreshUi.busy; }
  dshRefreshUi.busy = (async () => {
    try {
      await refresh();
      try { await probeDsh(true, true); } catch { /* 离线也继续重画 */ }
      const p = activeProject();
      if (p) {
        try { await loadDshTeamStatus({ force: true }); } catch { /* 团队台失败不阻断 */ }
      }
      try { if (window.__teamRoster && typeof window.__teamRoster.sync === 'function') await window.__teamRoster.sync({ reason: String(reason || 'dsh') }); } catch { /* ignore */ }
      try { renderSessions(); renderSidebar(); renderDsh(state?.dsh); } catch { /* ignore */ }
      await maybeAutoRebindByTitle();
      dshRefreshUi.lastAt = Date.now();
      try { window.__dshLastRefreshAt = dshRefreshUi.lastAt; } catch { /* ignore */ }
    } finally {
      dshRefreshUi.busy = null;
      if (dshRefreshUi.pending) {
        dshRefreshUi.pending = false;
        void refreshDshEverywhere(String(reason || '') + '-followup');
      }
    }
  })();
  return dshRefreshUi.busy;
}

/**
 * B-33b9 追加：连上后「映射 0/N」→ 自动按标题重绑，不等用户点按钮。
 * 不依赖 liveFor 本地缓存（团队台 IPC 失败时也要能试）：主进程按 DSH 真实标题精确匹配，
 * 无匹配会返回 DSH_TITLE_NO_MATCH，这里静默留手动入口；同一项目 15s 内只试一次避免刷屏。
 */
async function maybeAutoRebindByTitle() {
  const p = activeProject();
  const api = window.workbench;
  if (!p || !api || typeof api.rebindSessions !== 'function' || !state?.dsh?.online) return;
  const mapped = Object.keys(p.sessions || {}).filter((role) => p.sessions[role]).length;
  const roles = teamRoles(p) || [];
  if (mapped !== 0 || !roles.length) return;
  const key = String(p.id);
  if (autoRebindUi.busy || (autoRebindUi.lastKey === key && Date.now() - autoRebindUi.lastAt < 15000)) return;
  autoRebindUi.busy = true;
  autoRebindUi.lastKey = key;
  autoRebindUi.lastAt = Date.now();
  try {
    const r = await api.rebindSessions({ projectId: p.id });
    if (r && r.ok && Number(r.bound) > 0) {
      try { showNotice('DSH 已连接，自动按标题重绑 ' + r.bound + '/' + r.total + ' 个角色会话', 'ok'); } catch { /* ignore */ }
      await refresh();
      renderSessions();
    }
  } catch { /* 自动重绑失败留手动按钮 */ } finally { autoRebindUi.busy = false; }
}

function bindDshStatusPush() {
  const api = window.workbench;
  if (!api || typeof api.onDshStatusChanged !== 'function') return false;
  try {
    api.onDshStatusChanged((payload) => {
      const reason = String((payload && payload.reason) || 'push');
      void refreshDshEverywhere(reason);
    });
    return true;
  } catch { return false; }
}

async function reloadDshView(opts = {}) {
  const view = $('#dsh-view');
  if (!view) return false;
  dshViewFailed = false;
  dshReady = false;
  dshGuestBodyLen = 0;
  const api = window.workbench;
  let result = null;
  // B-f749（PM 04:47）：必须走主进程 app:reload-dsh（重新发现→cookie→reload→广播），
  // 不能只 view.reload() 重载失效旧 src；IPC 失败才本地 applyDshViewSrc()+reload 兜底。
  if (api && typeof api.reloadDshView === 'function') {
    try {
      result = await api.reloadDshView();
    } catch (error) {
      result = { ok: false, code: 'DSH_RELOAD_FAILED', message: String((error && error.message) || error || '') };
    }
    if (result && result.status) {
      state.dsh = result.status;
      renderDsh(result.status);
    }
  }
  if (!(result && result.ok)) {
    const repointed = applyDshViewSrc(false, 'reload-fallback');
    if (!repointed) {
      try { view.reload(); } catch { /* ignore */ }
    }
  }
  renderDsh(state?.dsh);
  // B-405f 补充：重载聊天区的同时重读会话映射，成员列表/计数一起刷新（不用重启工作台）。
  if (window.__teamRoster && typeof window.__teamRoster.sync === 'function') {
    window.__teamRoster.sync({}).catch(() => {});
  }
  try { await refreshDshEverywhere('reload'); } catch { /* ignore */ }
  if (!opts.quiet) {
    if (result && result.ok) toast('已重载 DSH 主画面', 'ok');
    else toast('重载失败：' + String((result && (result.message || result.code)) || '主进程未返回'), 'bad');
  }
  return Boolean(result && result.ok) || !opts.strict;
}

/**
 * 新建/补建角色会话后，DSH 左侧不会自己长出新会话：
 * 先记下要定位的会话，重载内嵌 DSH，加载完成后由 flushPendingDshFocus 选中。
 */
function reloadDshFor(project, reason = '') {
  if (!project || !state?.dsh?.online) return false;
  const sessionId = currentWorkspaceSession(project);
  pendingDshFocus = {
    projectId: project.id,
    sessionId: sessionId || null,
    title: sessionId ? roleSessionTitle(project, 'pm') : '',
    workspaceName: project.teamName || project.name,
    notify: false,
    reason
  };
  return reloadDshView({ quiet: true });
}

/* DSH 主画面里选会话 = 该项目的工作区成为 DSH 当前工作区。
   不复制 DSH 页面，只对它自己的会话行做一次点击。 */
async function locateDshSession(project, sessionId, title) {
  const view = $('#dsh-view');
  if (!view || !sessionId || !state?.dsh?.online) return false;
  if (!dshReady) return false;
  const payload = JSON.stringify({
    sid: String(sessionId),
    title: String(title || ''),
    projectName: String(project?.teamName || project?.name || ''),
    roleHint: String(title || '').includes('·') ? String(title).split('·').pop().trim() : '',
    short: String(sessionId).replace(/^session-/, '').slice(0, 10)
  });
  try {
    const result = await view.executeJavaScript(`(async () => {
      const cfg = ${payload};
      const norm = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const clickable = (el) => el && (el.closest('button, a, [role="button"], [role="treeitem"], [role="option"]') || el);
      const click = (el) => {
        if (!el) return false;
        const target = clickable(el);
        try { target.click(); return true; } catch { return false; }
      };
      const attrs = ['data-session-id', 'data-sessionid', 'data-session', 'data-id'];
      const nodes = Array.from(document.querySelectorAll('[data-session-id], [data-sessionid], [data-session], [data-id]'));
      const byAttr = nodes.find((el) => attrs.some((name) => el.getAttribute(name) === cfg.sid));
      if (byAttr && click(byAttr)) return { ok: true, by: 'attr' };
      const treeItems = Array.from(document.querySelectorAll('[role="treeitem"], [role="option"]'));
      const byTitle = treeItems.find((el) => {
        const text = norm(el.textContent);
        return text && (text === cfg.title || text.includes(cfg.title));
      });
      if (byTitle && click(byTitle)) return { ok: true, by: 'title' };
      if (cfg.projectName && cfg.roleHint) {
        const byParts = treeItems.find((el) => {
          const text = norm(el.textContent);
          return text.includes(cfg.projectName) && text.includes(cfg.roleHint);
        });
        if (byParts && click(byParts)) return { ok: true, by: 'parts' };
      }
      const candidates = Array.from(document.querySelectorAll('button, a, [role="button"], nav *, aside *'));
      const byShort = candidates.find((el) => {
        const text = norm(el.textContent);
        return cfg.short && text.includes(cfg.short);
      });
      if (byShort && click(byShort)) return { ok: true, by: 'short' };
      const group = treeItems.find((el) => {
        const text = norm(el.textContent);
        return cfg.projectName && (text === cfg.projectName || text.startsWith(cfg.projectName + ' '));
      });
      if (group && click(group)) {
        await new Promise((resolve) => setTimeout(resolve, 450));
        const retry = Array.from(document.querySelectorAll('[role="treeitem"], [role="option"]'))
          .find((el) => norm(el.textContent).includes(cfg.title));
        if (retry && click(retry)) return { ok: true, by: 'group' };
      }
      return { ok: false };
    })()`, true);
    return Boolean(result && result.ok);
  } catch {
    return false;
  }
}

async function locateDshWorkspace(project) {
  const view = $('#dsh-view');
  if (!view || !state?.dsh?.online || !dshReady) return false;
  const names = [...new Set([project?.teamName, project?.name].map((x) => String(x || '').trim()).filter(Boolean))];
  if (!names.length) return false;
  const payload = JSON.stringify(names);
  try {
    const result = await view.executeJavaScript(`(() => {
      const names = ${payload};
      const norm = (value) => String(value || '').replace(/\\s+/g, ' ').trim();
      const clickable = (el) => el && (el.closest('[role="treeitem"], button, a, [role="button"]') || el);
      const click = (el) => { try { clickable(el).click(); return true; } catch { return false; } };
      const rows = Array.from(document.querySelectorAll('[role="treeitem"], button, a'));
      for (const name of names) {
        const row = rows.find((el) => {
          const text = norm(el.textContent);
          return text === name || text.startsWith(name + ' ') || text.startsWith(name + '\\n');
        });
        if (row && click(row)) return { ok: true, name };
      }
      return { ok: false };
    })()`, true);
    return Boolean(result && result.ok);
  } catch {
    return false;
  }
}

async function focusDshWorkspace(project, opts = {}) {
  if (!project) return false;
  lastWorkspaceProjectId = project.id;
  const sessionId = currentWorkspaceSession(project);
  const title = sessionId ? roleSessionTitle(project, 'pm') : '';
  const workspaceName = project.teamName || project.name;

  if (!state?.dsh?.online || !dshReady) {
    pendingDshFocus = { projectId: project.id, sessionId, title, workspaceName, notify: Boolean(opts.notify) };
    if (opts.notify) toast('工作区已切换；DSH 尚未加载，连接后会定位到该工作区', 'ok');
    return false;
  }

  if (!sessionId) {
    const switched = await locateDshWorkspace(project);
    if (opts.notify) {
      toast(switched
        ? `已切换到 DSH 工作区「${workspaceName}」；还没有六角色会话，点「建团队」创建`
        : '工作区已切换；DSH 里还没找到这个工作区，可点「重载 DSH」后再试', switched ? 'ok' : 'bad');
    }
    return switched;
  }

  const role = (state.roles || []).find((r) => project.sessions?.[r.id] === sessionId);
  const fullTitle = role ? roleSessionTitle(project, role.id) : title;
  let ok = await locateDshSession(project, sessionId, fullTitle);
  if (!ok) ok = await locateDshWorkspace(project);
  if (!ok) {
    pendingDshFocus = { projectId: project.id, sessionId, title: fullTitle, workspaceName, notify: Boolean(opts.notify) };
    if (opts.notify) toast('工作区已切换；DSH 里还没找到该会话，可点「重载 DSH」后再试', 'bad');
  } else {
    pendingDshFocus = null;
  }
  return ok;
}

async function flushPendingDshFocus() {
  const pending = pendingDshFocus;
  if (!pending || !dshReady) return;
  const project = (state?.projects || []).find((item) => item.id === pending.projectId) || activeProject();
  if (!project) return;
  pendingDshFocus = null;
  const ok = pending.sessionId
    ? await locateDshSession(project, pending.sessionId, pending.title)
    : await locateDshWorkspace(project);
  if (!ok) pendingDshFocus = pending;
}

async function selectWorkspace(projectId) {
  if (!state || !projectId) return;
  const target = state.projects.find((p) => p.id === projectId);
  if (!target) return;
  setWorkspacePop(false);
  if (projectId === state.activeProjectId) {
    await focusDshWorkspace(target, { notify: true });
    await loadDshTeamStatus({ force: true });
    return;
  }
  // R-c72a AC2/F4（批3）：点击即先换列表——selectProject 内部 activateWorkspace 实测 0.5–0.8s，
  // 等它返回再刷新的话「点了列表还是旧项目」。先用预取缓存同步渲染，没有缓存就按目标项目 id 异步取数，两者都不等 selectProject。
  if (poolUi.open) {
    const cached = poolUi.byProject[projectId];
    if (Array.isArray(cached)) {
      // 先作废在飞的旧项目刷新（fetchSeq++），否则上一个项目的慢返回会把刚换上的列表又盖回去（实测 0.5s 级）。
      poolUi.fetchSeq += 1;
      poolUi.rows = cached;
      poolUi.signature = '';
      renderPool();
      void refreshPool(projectId); // 缓存先上屏，再用目标项目的最新数据覆盖（同一项目，不会闪回）
    } else {
      void refreshPool(projectId);
    }
  }
  try {
    const r = await window.workbench.selectProject(projectId);
    await applyState(r);
    const next = (state.projects || []).find((p) => p.id === projectId) || activeProject();
    const warnings = Array.isArray(r && r.warnings) ? r.warnings : [];
    if (warnings.length) {
      toast(`已切到「${target.name}」；${warnings[0].message || warnings[0].code}`, 'bad');
    }
    // 切项目 = 切工作区：刷新团队/DSH 清单与当前工作区指针，再让 DSH 主画面跟上。
    loadWorkspaces(true);
    if (next) {
      await focusDshWorkspace(next, { notify: !warnings.length });
      await loadDshTeamStatus({ force: true });
    }
  } catch (e) {
    // R-c72a AC2（批3）：列表是按点击先换的，切换真失败时恢复到真实 active 项目，别让「列表已是 B、当前还是 A」留在界面上。
    if (poolUi.open) void refreshPool();
    if (/项目目录不存在|PROJECT_DIR_MISSING|PROJECT_FOLDER_NOT_FOUND|目录已不存在/.test(String(e && e.message || ''))) {
      // 失效项目：点它不是“切换失败”死路，直接给“移除本机记录 / 重新定位”的出口。
      toast(`「${target.name}」目录不存在，已打开清理入口`, 'bad');
      removeProjectRecord(projectId);
      return;
    }
    toast('切换工作区失败：' + humanError(e.message), 'bad');
  }
}

function showDshView(on) {
  // DSH 永远是主画面。保留旧调用形状：只关闭浮层，不交换主场景。
  closeDrawers();
  if (on) {
    applyDshViewSrc(false, 'misc', { auto: true });
    renderDsh(state?.dsh);
  }
}

function setWorkspacePop(open) {
  const pop = $('#workspace-pop');
  const btn = $('#workspace-switch');
  if (!pop || !btn) return;
  if (!open) {
    pop.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    return;
  }
  renderWorkspacePopover();
  pop.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  const r = btn.getBoundingClientRect();
  pop.style.left = Math.max(8, Math.min(r.left, window.innerWidth - 398)) + 'px';
  pop.style.top = Math.round(r.bottom + 6) + 'px';
  // 清单来自团队登记 + DSH 当前工作区，打开时刷新一次（失败只影响这张浮层）。
  loadWorkspaces();
}

function openDshConfig() {
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <label class="field"><span><b>DSH Web 地址</b></span><input id="dsh-url" class="input" value="${esc(state.dsh?.baseUrl || 'http://127.0.0.1:52711')}" placeholder="http://127.0.0.1:52711"></label>
    <p class="hint">DSH 是主画面，这里只配置它的外部地址，不复制 DSH 内部实现。保存后会重新探测、重载主画面，并尝试定位当前工作区的角色会话。</p>
    <div class="dsh-config-state">当前状态：${esc(state.dsh?.online ? '已连接' : (state.dsh?.configured ? '离线' : '未配置'))}${state.dsh?.message ? ' · ' + esc(state.dsh.message) : ''}</div>
    <div class="modal-error"></div>`;
  openModal({
    title: 'DSH 适配器', subtitle: '外部会话引擎地址', icon: '◈', body: wrap, width: 560,
    actions: [
      { label: '取消', kind: 'ghost', onClick: ({ close }) => close() },
      { label: '保存并探测', kind: 'primary', onClick: async ({ close, error }) => {
        try {
          await window.workbench.dshConfigure(wrap.querySelector('#dsh-url').value.trim());
          const s = await window.workbench.dshStatus();
          state.dsh = s.status;
          dshReady = false;
          renderDsh(s.status);
          applyDshViewSrc(false, 'misc', { auto: true });
          close();
          toast(s.status.online ? 'DSH 已连接' : 'DSH 配置已保存，当前未连接', s.status.online ? 'ok' : 'bad');
          const p = activeProject();
          if (p) await focusDshWorkspace(p, { notify: false });
        } catch (e) { error(e.message); }
      } }
    ]
  });
}

/* ── 更多菜单 / 主题 / 成员 / 版本 ────────────────────── */

function syncMoreMenu() {
  const menu = $('#more-menu');
  if (!menu) return;
  menu.querySelectorAll('[data-more="project"], [data-more="team"]').forEach((b) => {
    const current = (b.dataset.more === 'project' && openDrawerName === 'project')
      || (b.dataset.more === 'team' && openDrawerName === 'team');
    b.classList.toggle('is-current', current);
    b.setAttribute('aria-current', current ? 'true' : 'false');
  });
  const p = activeProject();
  menu.querySelectorAll('[data-more="index"], [data-more="folder"], [data-more="team-board"], [data-more="team-board-window"], [data-more="sync"]').forEach((b) => {
    b.disabled = !p;
    b.title = p ? '' : '先新建或选择一个工作区';
  });
  syncThemeUi();
}

// R-bcac：设置页「存储位置」浮层（应用数据目录 / 临时沙盘目录；占用 / 上限 / 上次清理 / 一键清理）。
// 只改「以后写哪里」：不搬已有数据；旧 tmpDir 内容不自动删，由用户点一键清理。
let storagePanelEl = null;
let storagePanelState = null;
function storagePanelNode() {
  if (storagePanelEl && document.body.contains(storagePanelEl)) return storagePanelEl;
  const mask = document.createElement('div');
  mask.setAttribute('data-storage-modal', '1');
  mask.style.cssText = 'position:fixed;inset:0;z-index:9998;background:rgba(0,0,0,.45);display:flex;align-items:center;justify-content:center;';
  const card = document.createElement('div');
  card.setAttribute('data-storage-card', '1');
  card.style.cssText = 'width:min(720px,92vw);max-height:86vh;overflow:auto;background:#161a20;color:#d8dde5;border:1px solid #2a313b;border-radius:12px;padding:18px 20px;box-shadow:0 12px 40px rgba(0,0,0,.5);font-size:13px;line-height:1.6;';
  card.innerHTML = [
    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:10px;">',
    '  <b style="font-size:15px;">存储位置</b><button type="button" data-storage-close="1" style="background:transparent;border:0;color:#9aa4b2;font-size:18px;cursor:pointer;">×</button>',
    '</div>',
    '<div data-storage-error hidden style="margin:0 0 10px;padding:8px 10px;border-radius:8px;background:#3a1616;color:#ffb4b4;border:1px solid #7a2b2b;"></div>',
    '<div style="margin-bottom:10px;"><label style="display:block;color:#9aa4b2;margin-bottom:4px;">应用数据目录（workbench.json / data）</label>',
    '  <input type="text" data-storage-data-dir style="width:100%;box-sizing:border-box;background:#0f1216;color:#d8dde5;border:1px solid #2a313b;border-radius:8px;padding:7px 9px;" /></div>',
    '<div style="margin-bottom:10px;"><label style="display:block;color:#9aa4b2;margin-bottom:4px;">临时沙盘目录（_tmp / 夹具根）</label>',
    '  <input type="text" data-storage-tmp-dir style="width:100%;box-sizing:border-box;background:#0f1216;color:#d8dde5;border:1px solid #2a313b;border-radius:8px;padding:7px 9px;" /></div>',
    '<div data-storage-summary style="margin:10px 0;padding:10px 12px;border-radius:8px;background:#0f1216;border:1px solid #232a33;white-space:pre-wrap;"></div>',
    '<div style="display:flex;gap:8px;justify-content:flex-end;margin-top:12px;">',
    '  <button type="button" data-storage-clean="1" style="background:#2a313b;color:#ffd9a3;border:0;border-radius:8px;padding:7px 12px;cursor:pointer;">一键清理过期沙盘</button>',
    '  <button type="button" data-storage-save="1" style="background:#1f6feb;color:#fff;border:0;border-radius:8px;padding:7px 14px;cursor:pointer;">保存并立即生效</button>',
    '</div>',
    '<div style="margin-top:8px;color:#9aa4b2;font-size:12px;">只改「以后写哪里」，不移动已有数据；旧临时目录内容不自动删除（可用一键清理）。系统盘路径会被拒绝。</div>'
  ].join('');
  mask.appendChild(card);
  mask.addEventListener('click', (event) => { if (event.target === mask) closeStoragePanel(); });
  document.body.appendChild(mask);
  storagePanelEl = mask;
  return mask;
}
function storageFormatBytes(bytes) {
  const n = Number(bytes) || 0;
  if (n >= 1024 * 1024 * 1024) return (n / 1024 / 1024 / 1024).toFixed(2) + ' GB';
  if (n >= 1024 * 1024) return (n / 1024 / 1024).toFixed(1) + ' MB';
  if (n >= 1024) return (n / 1024).toFixed(1) + ' KB';
  return n + ' B';
}
function storagePaint(status) {
  storagePanelState = status;
  const mask = storagePanelNode();
  const cfg = (status && status.settings) || {};
  const guard = (status && status.guard) || {};
  const dataInput = mask.querySelector('[data-storage-data-dir]');
  const tmpInput = mask.querySelector('[data-storage-tmp-dir]');
  if (document.activeElement !== dataInput) dataInput.value = String(cfg.dataDir || '');
  if (document.activeElement !== tmpInput) tmpInput.value = String(cfg.tmpDir || '');
  const limits = guard.limits || {};
  const usage = guard.usage || {};
  const last = (status && status.lastCleanup) || null;
  const lines = [
    '临时沙盘占用：' + storageFormatBytes(usage.bytes) + '（' + Number(usage.files || 0) + ' 文件 / ' + Number(usage.sandboxes || 0) + ' 个沙盘目录）',
    '上限：' + storageFormatBytes(limits.maxBytes) + ' / ' + Number(limits.maxFiles || 0) + ' 文件（使用率 ' + Math.round(Number(usage.ratio || 0) * 100) + '%）',
    last ? ('上次清理：' + String(last.at || '') + '，释放 ' + storageFormatBytes(last.freedBytes) + '，删除 ' + Number(last.removed || 0) + ' 个（' + String(last.reason || '') + '）') : '上次清理：无记录',
    guard.ok === false ? ('⚠ ' + String(guard.message || '临时沙盘超限，请清理或改路径')) : ''
  ].filter(Boolean);
  mask.querySelector('[data-storage-summary]').textContent = lines.join('\n');
  const err = mask.querySelector('[data-storage-error]');
  err.hidden = true;
  err.textContent = '';
  document.querySelectorAll('[data-storage-usage]').forEach((node) => {
    node.textContent = storageFormatBytes(usage.bytes);
  });
  return mask;
}
async function openStoragePanel() {
  try { setMoreMenu(false); } catch { /* ignore */ }
  try {
    const mask = storagePaint(null);
    const status = await window.workbench.storageStatus();
    storagePaint(status);
    // 绑定一次事件（用 dataset 标记防重复绑定）
    const card = mask;
    if (!card.dataset.bound) {
      card.dataset.bound = '1';
      card.addEventListener('click', async (event) => {
        const target = event.target;
        if (target.closest('[data-storage-close]')) { closeStoragePanel(); return; }
        const err = card.querySelector('[data-storage-error]');
        if (target.closest('[data-storage-clean]')) {
          target.disabled = true;
          try {
            const res = await window.workbench.storageClean({ all: true });
            const status2 = await window.workbench.storageStatus();
            storagePaint(status2);
            if (err) { err.hidden = false; err.textContent = '已清理：删除 ' + Number((res && res.removed) || 0) + ' 个，释放 ' + storageFormatBytes((res && res.freedBytes) || 0); }
          } catch (e) {
            if (err) { err.hidden = false; err.textContent = '清理失败：' + String((e && e.message) || e); }
          } finally { target.disabled = false; }
          return;
        }
        if (target.closest('[data-storage-save]')) {
          target.disabled = true;
          try {
            const payload = {
              dataDir: String(card.querySelector('[data-storage-data-dir]').value || '').trim(),
              tmpDir: String(card.querySelector('[data-storage-tmp-dir]').value || '').trim(),
            };
            const saved = await window.workbench.storageSave(payload);
            if (!saved || saved.ok === false) {
              if (err) { err.hidden = false; err.textContent = String((saved && (saved.message || saved.code)) || '保存失败'); }
              return;
            }
            storagePaint(saved.status || await window.workbench.storageStatus());
            if (err) { err.hidden = false; err.textContent = '已保存，立即生效（只影响以后写入；旧数据不移动）'; }
          } catch (e) {
            if (err) { err.hidden = false; err.textContent = '保存失败：' + String((e && e.message) || e); }
          } finally { target.disabled = false; }
          return;
        }
      });
    }
  } catch (e) {
    try { console.warn('[storage] open failed ' + String((e && e.message) || e)); } catch { /* ignore */ }
  }
}
function closeStoragePanel() {
  if (storagePanelEl && storagePanelEl.parentNode) storagePanelEl.parentNode.removeChild(storagePanelEl);
  storagePanelEl = null;
}
try { window.__awbOpenStoragePanel = openStoragePanel; } catch { /* ignore */ }

function setMoreMenu(open) {
  const menu = $('#more-menu');
  const btn = $('#btn-more');
  if (!menu || !btn) return;
  if (!open) {
    menu.hidden = true;
    btn.setAttribute('aria-expanded', 'false');
    return;
  }
  syncMoreMenu();
  menu.hidden = false;
  btn.setAttribute('aria-expanded', 'true');
  const r = btn.getBoundingClientRect();
  const w = menu.offsetWidth || 250;
  menu.style.left = Math.max(8, Math.round(r.right - w)) + 'px';
  menu.style.top = Math.round(r.bottom + 6) + 'px';
  menu.style.right = 'auto';
}

function openVersionModal() {
  const ua = navigator.userAgent || '';
  const electron = (ua.match(/Electron\/([\d.]+)/) || [])[1] || '—';
  const chrome = (ua.match(/Chrome\/([\d.]+)/) || [])[1] || '—';
  const p = activeProject();
  const body = `
    <div class="kv-list">
      <div><span>应用版本</span><b>v${esc(state.version)}</b></div>
      <div><span>Electron</span><b>${esc(electron)}</b></div>
      <div><span>Chromium</span><b>${esc(chrome)}</b></div>
      <div><span>项目</span><b>${state.projects.length} 个${p ? ' · 当前 ' + esc(p.name) : ''}</b></div>
      <div><span>团队工具</span><b>${state.team?.toolExists ? '已就绪' : '缺失（部分团队功能不可用）'}</b></div>
      <div><span>DSH 地址</span><b class="mono">${esc(state.dsh?.baseUrl || '—')}</b></div>
      <div><span>DSH 状态</span><b>${esc(state.dsh?.online ? '已连接' : (state.dsh?.configured ? '离线' : '未配置'))}</b></div>
    </div>
    <div class="kv-list" data-install-warnings>
      <div data-install-warning-empty><span>安装 / MCP 警告</span><b>加载中…</b></div>
    </div>
    <p class="hint">安装结果：<span class="mono">data/install-result.json</span>（warnings[]）；MCP 日志：<span class="mono">~/.dsh/logs/mcp-*.log</span>（MCP 不可用只影响搜索，不影响启动）。</p>
    <p class="hint">DSH 是主画面；项目 = 工作区，会话 = 角色。项目与团队状态保存在本机，不复制 DSH 内部实现。</p>`;
  openModal({
    title: '关于 PM工作台', subtitle: 'PM Workbench · DSH 壳 · 工作区与六角色', icon: 'PM', body, width: 560,
    actions: [{ label: '关闭', kind: 'ghost', onClick: ({ close }) => close() }]
  });
  void loadInstallWarningsIntoModal();
}

/**
 * e379 返工①（AC6③）：把安装结果 warnings[]（含 MCP 自检失败）+ DSH 互通能力写进「关于」面板。
 * 只读，IPC 失败给可读一行，不静默。
 */
async function loadInstallWarningsIntoModal() {
  const box = document.querySelector('[data-install-warnings]');
  if (!box) return;
  let data = null;
  try {
    if (!window.workbench || typeof window.workbench.diagnostics !== 'function') throw new Error('diagnostics IPC 不可用');
    data = await window.workbench.diagnostics();
  } catch (e) {
    if (box.isConnected) {
      box.innerHTML = `<div data-install-warning-empty><span>安装 / MCP 警告</span><b>读取失败：${esc(String((e && e.message) || e))}</b></div>`;
    }
    return;
  }
  if (!box.isConnected) return;
  const rows = Array.isArray(data && data.warnings) ? data.warnings : [];
  const mcp = (data && data.mcp && data.mcp.record) || null;
  const capability = (data && data.capability) || null;
  const parts = [];
  parts.push(`<div><span>DSH 互通能力</span><b>${esc((capability && capability.line) || '未知（尚未探测）')}</b></div>`);
  if (mcp) {
    const state = mcp.ok === true
      ? '正常（initialize 成功）'
      : `失败（${esc(String(mcp.reason || '未知原因'))}）`;
    const log = mcp.logPath ? ` · <span class="mono">${esc(String(mcp.logPath))}</span>` : '';
    parts.push(`<div><span>MCP 安全搜索</span><b data-mcp-status="${mcp.ok === true ? 'ok' : 'fail'}">${state}${log}</b></div>`);
  }
  if (rows.length === 0) {
    parts.push('<div data-install-warning-empty><span>安装 / MCP 警告</span><b>无</b></div>');
  } else {
    parts.push(`<div><span>安装 / MCP 警告</span><b>${rows.length} 条</b></div>`);
    for (const row of rows.slice(-10)) {
      const code = String((row && row.code) || '');
      const isMcp = code.indexOf('MCP_') === 0;
      const log = row && row.log ? `<br><span class="mono">${esc(String(row.log))}</span>` : '';
      parts.push(`<div data-install-warning${isMcp ? ' data-mcp-warning' : ''} data-code="${esc(code)}"><span>${esc(code)}</span><b>${esc(String((row && row.message) || ''))}${log}</b></div>`);
    }
  }
  box.innerHTML = parts.join('');
}

async function openProjectFolder() {
  const p = activeProject();
  if (!p) { toast('先新建或选择一个项目', 'bad'); return; }
  try { await window.workbench.openProject(p.id); }
  catch (e) { toast('打开失败：' + e.message, 'bad'); }
}

async function openProjectIndex() {
  const p = activeProject();
  if (!p) { toast('先新建或选择一个项目', 'bad'); return; }
  try {
    const r = await window.workbench.filesList(p.id);
    const files = r.files || [];
    const target = files.find((f) => f.rel === '项目索引.md')
      || files.find((f) => f.rel === '项目信息.md')
      || files.find((f) => f.name === 'README.md');
    if (!target) { toast('项目根目录没有 项目索引.md / 项目信息.md', 'bad'); return; }
    openFilePreview(p, target);
  } catch (e) { toast('打开失败：' + e.message, 'bad'); }
}

/** 统一刷新：状态库 → DSH 探测 → 工作区清单 → 团队状态 → 会话核验；需要时重载并定位 DSH。 */
async function refreshAll(opts = {}) {
  await refresh();
  await initDsh();
  loadWorkspaces(true);
  loadTeamStatus({ force: true });
  if (openDrawerName === 'team' && receiptsCaps()) loadReceipts({ force: true });
  const p = activeProject();
  if (!p) return;
  if (opts.reloadDsh !== false && state.dsh && state.dsh.online) {
    reloadDshFor(p, 'refresh');
  } else {
    await focusDshWorkspace(p, { notify: false });
  }
  await loadDshTeamStatus({ force: true });
  if (opts.toast) toast('已刷新工作区、团队与 DSH 状态', 'ok');
}

async function runMoreAction(act) {
  setMoreMenu(false);
  const p = activeProject();
  if (act === 'project') setDrawer('project');
  else if (act === 'team') setDrawer('team');
  else if (act === 'inbox') openInboxFor(inboxUi.roleId || 'pm');
  else if (act === 'theme') { setThemeMenu(true); themeMenuFocus(1); }
  else if (act === 'refresh') {
    await refreshAll({ toast: true });
  } else if (act === 'workspaces') {
    await loadWorkspaces(true);
    setWorkspacePop(true);
    const total = state.projects.length;
    const teamCount = wsUi.data && Array.isArray(wsUi.data.projects) ? wsUi.data.projects.length : 0;
    toast(wsUi.error ? '团队清单读取失败：' + wsUi.error : `工作区清单已刷新：本机 ${total} · 团队/DSH ${teamCount}`, wsUi.error ? 'bad' : 'ok');
  } else if (act === 'index') await openProjectIndex();
  else if (act === 'folder') await openProjectFolder();
  else if (act === 'open-project') await openExistingFolder();
  else if (act === 'team-board') openBoardPanel();
  else if (act === 'team-board-window') await openTeamBoardOld();
  else if (act === 'sync') await syncTeamNow();
  else if (act === 'restore') await openRestoreModal();
  else if (act === 'guide') showGuide(true);
  else if (act === 'version') openVersionModal();
}

/** 打开已有项目文件夹：只登记已有目录，不复制、不新建同名目录。 */
async function openExistingFolder() {
  if (typeof window.workbench.adoptProject !== 'function') { toast('当前版本没有恢复 API', 'bad'); return; }
  let dir;
  try { dir = await window.workbench.chooseDir(); }
  catch (e) { toast('选择目录失败：' + humanError(e.message), 'bad'); return; }
  if (!dir) return;
  try {
    const r = await window.workbench.adoptProject({ path: dir });
    await applyState(r);
    const p = activeProject();
    toast('已登记工作区：' + (p ? p.name : dir), 'ok');
    if (p) await focusDshWorkspace(p, { notify: true });
  } catch (e) {
    toast('登记失败：' + humanError(e.message), 'bad');
  }
}

/** 同步团队登记并（重新）绑定 DSH 工作区：真实 team:ensure-project。 */
async function syncTeamNow() {
  const p = activeProject();
  if (!p) { toast('先选择工作区', 'bad'); return; }
  try {
    const r = await window.workbench.teamEnsureProject({ projectId: p.id });
    if (r && r.state) state = r.state;
    render();
    const warnings = Array.isArray(r && r.warnings) ? r.warnings : [];
    const teamCode = r && r.team && !r.team.ok ? (r.team.code || '') : '';
    if (r && r.ensured) {
      toast(`团队登记已同步${warnings.length ? '；' + (warnings[0].message || warnings[0].code) : ''}`, warnings.length ? 'bad' : 'ok');
    } else {
      toast('同步失败：' + (teamCode || (r && (r.code || r.message)) || '团队工具不可用'), 'bad');
    }
    loadWorkspaces(true);
    loadDshTeamStatus({ force: true });
  } catch (e) {
    toast('同步失败：' + humanError(e.message), 'bad');
  }
}

/** 项目记录被移除/重定位后清掉渲染层缓存，避免旧路径继续显示。 */
function forgetProjectCaches(p) {
  if (!p) return;
  delete teamModeStore[String(p.id || '')];
  delete teamModePathStore[projectPathKey(p)];
  try { localStorage.setItem(TEAM_MODE_STORE_KEY, JSON.stringify(teamModeStore)); } catch { /* ignore */ }
  try { localStorage.setItem(TEAM_MODE_PATH_KEY, JSON.stringify(teamModePathStore)); } catch { /* ignore */ }
  voteUi.projectId = null;
  voteUi.votes = [];
  voteUi.data = null;
  voteUi.error = null;
  liveUi.projectId = null;
  liveUi.items = [];
  liveUi.at = 0;
  legacyUi.flowDerive = null;
}

/** 失效项目重新定位：只改本机与团队登记路径，不移动、不删除任何真实文件。 */
async function relocateProjectRecord(p, onDone) {
  if (!p) return false;
  if (typeof window.workbench.relocateProject !== 'function') {
    toast('当前版本不支持重新定位；请升级工作台', 'bad');
    return false;
  }
  const dir = await window.workbench.chooseDir();
  if (!dir) return false;
  try {
    const r = await window.workbench.relocateProject({ projectId: p.id, newPath: dir });
    if (!r || r.ok === false) throw new Error((r && (r.message || r.code)) || '重新定位失败');
    await refresh();
    if (typeof onDone === 'function') onDone();
    toast(`已重新定位到：${dir}${r.teamUpdated ? '' : '（团队登记路径未更新）'}`, r.teamUpdated ? 'ok' : 'warn');
    return true;
  } catch (e) {
    toast('重新定位失败：' + humanError(e.message), 'bad');
    return false;
  }
}

/** 只移除本机项目记录：项目目录、团队登记与角色会话按主进程规则处理；失效目录也能移除。 */
async function removeProjectRecord(projectId) {
  const p = (projectId && (state?.projects || []).find((x) => x.id === projectId)) || activeProject();
  if (!p) { toast('先选择工作区', 'bad'); return; }
  const missing = p.exists === false;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <p class="muted">${missing ? '这个项目的目录已经不存在，请二选一：' : '只移除本机状态库里的项目记录：'}</p>
    <p class="mono hint-path">${esc(p.name)}<br>${esc(p.path)}</p>
    ${missing ? '<p class="legacy-modal-warn">「重新定位」用于目录被移动/改名后指回真实目录；「移除记录」只清本机登记，团队登记归档到 <code>团队/状态/项目/_deleted/</code>，可恢复。</p>' : ''}
    <ul class="hint-list">
      <li>项目目录、文件、角色 DSH 会话都会保留；团队登记会归档，同名重建不会再被哈希。</li>
      <li>想恢复时用「恢复项目」：按名字恢复或从 <code>_deleted</code> 归档记录恢复。</li>
    </ul>
    <div class="modal-error"></div>`;
  openModal({
    title: '移除项目记录',
    subtitle: `${p.name}${missing ? ' · 目录不存在' : ''}`,
    icon: '×',
    body: wrap,
    width: 560,
    actions: [
      { label: '取消', kind: 'ghost', onClick: ({ close }) => close() },
      { label: '重新定位…', kind: 'ghost', onClick: async ({ close }) => {
        close();
        await relocateProjectRecord(p);
      } },
      { label: '移除记录', kind: 'primary', onClick: async ({ close, error }) => {
        try {
          // 目录不存在时不尝试 DSH 会话归档：直接摘本机记录，避免卡在“归档失败”。
          const r = await window.workbench.deleteProjectRecord(
            missing ? { projectId: p.id, archiveSessions: false } : p.id
          );
          if (r && r.state) state = r.state;
          forgetProjectCaches(p);
          close();
          await refresh();
          loadWorkspaces(true);
          render();
          toast('已移除本机记录；项目文件仍在磁盘上，团队登记已归档可恢复', 'ok');
        } catch (e) { error(e.message); }
      } }
    ]
  });
}

/** 批量清理失效项目：列清单 + 二次确认，逐条执行并报告成功/失败数。 */
async function cleanMissingProjects() {
  const missing = (state?.projects || []).filter((x) => x.exists === false);
  if (!missing.length) { toast('没有失效项目', 'ok'); return; }
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <p class="muted">下列 <b>${missing.length}</b> 个项目的目录已不存在；清理只移除本机记录：</p>
    <ul class="hint-list clean-missing-list">${missing.map((x) => `<li><b>${esc(x.name)}</b><small>${esc(x.path)}</small></li>`).join('')}</ul>
    <p class="legacy-modal-warn">真实目录与文件不会被删除；团队登记归档到 <code>团队/状态/项目/_deleted/</code>，可在「恢复项目」里找回。</p>
    <div class="modal-error"></div>`;
  openModal({
    title: '清理失效项目',
    subtitle: `${missing.length} 个项目目录不存在`,
    icon: '×',
    body: wrap,
    width: 640,
    actions: [
      { label: '取消', kind: 'ghost', onClick: ({ close }) => close() },
      { label: `移除 ${missing.length} 个记录`, kind: 'primary', onClick: async ({ close }) => {
        let ok = 0;
        const failed = [];
        for (const p of missing) {
          try {
            await window.workbench.deleteProjectRecord({ projectId: p.id, archiveSessions: false });
            ok += 1;
            forgetProjectCaches(p);
          } catch (e) {
            failed.push(`${p.name}：${humanError(e.message)}`);
          }
        }
        close();
        await refresh();
        loadWorkspaces(true);
        render();
        if (failed.length) toast(`已移除 ${ok} 个，失败 ${failed.length} 个（${failed[0]}）；失败项仍保留`, 'bad');
        else toast(`已移除 ${ok} 个失效项目记录；真实目录与文件未动`, 'ok');
      } }
    ]
  });
}

/* ── 新手引导 ─────────────────────────────────────────── */

const GUIDE_STEPS = [
  {
    target: '#workspace-switch',
    kicker: '第 1 步 / 7',
    title: '新建项目 → 建团队',
    html: '<p>一个目录 = 一个项目 = 一个 DSH 工作区。顶栏左边是当前工作区，点它可切换。</p><ul><li><b>新建项目</b>：填项目名 + 选根目录，创建后自动登记为工作区。</li><li><b>建团队</b>：一次补齐角色会话。完整六人（PM / 产品 / 需求 / 程序员A / 程序员B / 测试）或快速四人（去掉产品与程序员B）。</li></ul><p>团队没建好之前，后面的派单、评审、验收都无从谈起。</p>'
  },
  {
    target: '',
    kicker: '第 2 步 / 7',
    title: '跟项目经理提需求（需求流程）',
    html: '<p>直接在主画面对项目经理说你要什么，不用填表。它会按这条链推进：</p><p><b>提需求 → 需求分析 / 产品评审 → 拆任务派开发 → 测试 → 验收 → 收口</b>。</p><p>示例话术（点按钮只复制，不会替你发送）：</p><p><code>我想做一个个人博客，先帮我理一下需求。</code></p><p><button type="button" class="ghost small" data-guide-copy="我想做一个个人博客，先帮我理一下需求。">复制示例话术</button></p>'
  },
  {
    target: '#btn-board',
    kicker: '第 3 步 / 7',
    title: '流程看板：现在走到哪了',
    html: '<p>点 <b>项目面板</b> 打开浮层，里面有「流程」页：从工作流实时推导出每个需求走到哪一步（提需求 / 评审 / 开发 / 测试 / 验收 / 收口），不靠人记。</p><p>右下角也有 <b>流程</b> 浮窗入口，可以边看边聊。</p>'
  },
  {
    target: '',
    kicker: '第 4 步 / 7',
    title: '在哪审核需求',
    html: '<p>需要你拍板的需求进「<b>更多 → 我的评审</b>」：点条目看「是什么 / 怎么做 / 建议拍板」，再点 <b>通过</b> 或 <b>打回</b>。</p><p>打回必须写一句意见，通过不用。评审通过后才会进入开发。</p>'
  },
  {
    target: '',
    kicker: '第 5 步 / 7',
    title: '在哪验收需求',
    html: '<p>开发测试都做完的需求进「<b>我的验收</b>」浮层：看测试报告与证据，再决定 <b>通过</b> 或 <b>打回</b>。</p><p>验收和评审不是一回事：评审是「要不要做」，验收是「做成没有」。验收通过需求才收口。</p>'
  },
  {
    target: '#metrics',
    kicker: '第 6 步 / 7',
    title: '回收内存解决了什么',
    html: '<p>左下角这行是 CPU / 内存 / GPU 占用。<b>立即回收</b>只在内存涨太快时重载渲染进程（DSH 主画面 + 壳），把内存降下来。</p><p>它 <b>不动任何数据</b>：不改项目、不改会话、不改团队状态；只是把界面重新加载一遍，正在跑的后台任务照常。</p>'
  },
  {
    target: '#btn-more',
    kicker: '第 7 步 / 7',
    title: '调字号 / 调主题',
    html: '<p>字号：标题栏 <b>A-</b> / <b>A+</b>，全局生效并记住。</p><p>主题：<b>更多（⋯）→ 外观</b>，切 <b>暗金</b> / <b>暖白</b>。</p><p>其他：左上角 ◧ 收起工作区侧栏；顶栏可重载 DSH 主画面；这里也能重开这份引导。</p>'
  }
];

function positionGuide() {
  const mask = $('#onboard');
  if (!mask || mask.hidden) return;
  const step = GUIDE_STEPS[guideStep];
  const target = step?.target ? document.querySelector(step.target) : null;
  const tip = $('#ob-tip');
  const ring = $('#ob-ring');
  const arrow = $('#ob-arrow');
  if (!tip) return;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const tw = Math.min(390, vw - 24);
  tip.style.width = tw + 'px';
  const th = tip.offsetHeight || 260;

  if (!target) {
    if (ring) ring.hidden = true;
    if (arrow) arrow.hidden = true;
    tip.style.left = Math.max(12, Math.round((vw - tw) / 2)) + 'px';
    tip.style.top = Math.max(12, Math.round((vh - th) / 2)) + 'px';
    return;
  }
  const r = target.getBoundingClientRect();
  const pad = 5;
  if (ring) {
    ring.hidden = false;
    ring.style.left = Math.round(r.left - pad) + 'px';
    ring.style.top = Math.round(r.top - pad) + 'px';
    ring.style.width = Math.round(r.width + pad * 2) + 'px';
    ring.style.height = Math.round(r.height + pad * 2) + 'px';
  }
  const below = r.bottom + 18 + th < vh - 10;
  const cx = r.left + r.width / 2;
  const left = Math.max(12, Math.min(cx - tw / 2, vw - tw - 12));
  tip.style.left = Math.round(left) + 'px';
  tip.style.top = Math.round(below ? r.bottom + 18 : Math.max(12, r.top - 18 - th)) + 'px';
  if (arrow) {
    arrow.hidden = false;
    arrow.className = 'ob-arrow ' + (below ? 'up' : 'down');
    arrow.style.left = Math.round(Math.max(14, Math.min(cx - 9, vw - 22))) + 'px';
    arrow.style.top = Math.round(below ? r.bottom + 7 : r.top - 15) + 'px';
  }
}

function renderGuide() {
  const step = GUIDE_STEPS[guideStep];
  if (!step) return;
  const kicker = $('#ob-kicker');
  const title = $('#ob-title');
  const progress = $('#ob-progress');
  const body = $('#ob-body');
  const prev = $('#ob-prev');
  const next = $('#ob-next');
  if (kicker) kicker.textContent = step.kicker;
  if (title) title.textContent = step.title;
  if (progress) progress.innerHTML = GUIDE_STEPS.map((_, i) => `<span class="ob-dot${i <= guideStep ? ' on' : ''}"></span>`).join('');
  if (body) body.innerHTML = step.html;
  // 引导里的「复制示例话术」：只复制，绝不替用户发送。
  const copyBtn = body ? body.querySelector('[data-guide-copy]') : null;
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const text = String(copyBtn.getAttribute('data-guide-copy') || '');
      try {
        await navigator.clipboard.writeText(text);
        copyBtn.textContent = '已复制（不会自动发送）';
      } catch { copyBtn.textContent = '复制失败，请手动选中这行文字'; }
    });
  }
  if (prev) prev.disabled = guideStep === 0;
  if (next) next.textContent = guideStep === GUIDE_STEPS.length - 1 ? '完成' : '下一步';
  applyTeamModeCopy($('#onboard') || document.body);
  requestAnimationFrame(positionGuide);
  setTimeout(positionGuide, 80);
}

function showGuide(force = true) {
  let done = false;
  try { done = localStorage.getItem('awb.onboarded') === '1'; } catch { /* ignore */ }
  if (!force && done) return;
  setMoreMenu(false);
  closeModal();
  guideStep = 0;
  const mask = $('#onboard');
  if (!mask) return;
  mask.hidden = false;
  renderGuide();
}

function closeGuide(markDone = true) {
  const mask = $('#onboard');
  if (mask) mask.hidden = true;
  if (markDone) {
    try { localStorage.setItem('awb.onboarded', '1'); } catch { /* ignore */ }
  }
}

/* ── T-b417：路由守护状态（运行中 / 已停止 / 心跳超时，超 3 周期标红） ───── */
let daemonBusy = false;
function daemonPillPaint(pill, s) {
  if (!pill) return;
  const state = String((s && s.state) || 'unknown');
  const label = String((s && s.label) || '守护 —');
  pill.dataset.daemonState = state;
  pill.dataset.daemonBeat = (s && s.beatAgeMs !== null && s.beatAgeMs !== undefined) ? String(Math.round(Number(s.beatAgeMs) / 1000)) : '';
  pill.dataset.daemonPid = s && s.pid ? String(s.pid) : '';
  pill.textContent = label;
  pill.classList.toggle('daemon-stale', state === 'stale');
  pill.title = [
    s && s.detail ? s.detail : '',
    s && s.lastBeatAt ? `最后心跳 ${s.lastBeatAt}` : '',
    s && s.pid ? `pid ${s.pid}` : '',
    s && s.managed ? '本工作台正在管这个守护' : '',
    s && s.error ? s.error : '',
    '点一下刷新',
  ].filter(Boolean).join(' · ');
  pill.setAttribute('aria-label', label + (s && s.detail ? '：' + s.detail : ''));
}
async function tickDaemonStatus() {
  const pill = $('#daemon-pill');
  if (!pill || daemonBusy) return null;
  if (!(window.workbench && typeof window.workbench.teamRouteStatus === 'function')) {
    daemonPillPaint(pill, { state: 'disabled', label: '守护：接口缺失', detail: '当前壳层没有 team:route-status' });
    return null;
  }
  daemonBusy = true;
  try {
    const p = activeProject();
    if (!p) { daemonPillPaint(pill, { state: 'no-project', label: '守护 —', detail: '先选择工作区' }); return null; }
    const s = await window.workbench.teamRouteStatus({ projectId: p.id });
    daemonPillPaint(pill, s || {});
    return s;
  } catch (error) {
    daemonPillPaint(pill, { state: 'error', label: '守护：状态读不到', detail: humanError(String((error && error.message) || error)) });
    return null;
  } finally { daemonBusy = false; }
}

/* ── 顶栏指标与看板切换 ───────────────────────────────── */

let metricsBusy = false;
async function tickMetrics() {
  if (metricsBusy) return; // B-fa80：2 秒一次，慢返回时跳过当前，避免 IPC 堆积
  // 收口指令 B-3：交互期（AWBGate.installInteraction 的 900ms 窗口）内直接 return，不再只判焦点；
  // longtask attribution 指向每 ~2s 的指标/轮询 tick，交互期跑它会制造 >100ms 主线程阻塞。
  try { if (window.AWBGate && typeof AWBGate.interacting === 'function' && AWBGate.interacting()) return; } catch { /* ignore */ }
  // a514：打字（输入框聚焦）时不刷新指标——longtask 归因显示每 ~2s 一次 self/window 长任务。
  try {
    const el = document.activeElement;
    if (el && (/^(input|textarea)$/i.test(String(el.tagName || '')) || el.isContentEditable)) return;
  } catch { /* ignore */ }
  metricsBusy = true;
  try {
    const m = await window.workbench.metrics();
    const metrics = $('#metrics');
    if (!metrics) return;
    const gpuText = m.gpu && Number.isFinite(m.gpu.util) ? `${m.gpu.util}%` : '不可用';
    const gpuMem = m.gpu && Number.isFinite(m.gpu.used) && Number.isFinite(m.gpu.total) ? ` · 显存 ${m.gpu.used}/${m.gpu.total}MB` : '';
    metrics.textContent = `CPU ${m.cpu}% · 内存 ${m.mem}% · GPU ${gpuText}`;
    metrics.title = `本机占用（2 秒刷新，点击立即刷新）\nCPU ${m.cpu}%${m.cpuSource === 'system' ? '（全机）' : '（进程汇总）'} · 内存 ${m.mem}% · GPU ${gpuText}${gpuMem}`;
  } catch { /* ignore */ } finally { metricsBusy = false; }
}

/* ── 事件绑定 ─────────────────────────────────────────── */

function setSidebarHidden(hidden) {
  document.body.classList.toggle('sidebar-hidden', Boolean(hidden));
  const btn = $('#btn-side');
  if (btn) {
    btn.setAttribute('aria-pressed', String(!hidden));
    btn.title = hidden ? '显示左侧工作区栏' : '隐藏左侧工作区栏';
  }
  try { localStorage.setItem('awb.sidebar', hidden ? 'hidden' : 'shown'); } catch { /* ignore */ }
}

async function openTeamBoardOld(projectId) {
  const p = (projectId && (state?.projects || []).find((item) => item.id === projectId)) || activeProject();
  if (!p) { toast('先选择工作区', 'bad'); return; }
  if (projectId && !(state?.projects || []).some((item) => item.id === projectId)) {
    toast('这个看板项目还没登记到本机；先在恢复 / 工作区清单登记', 'bad');
    return;
  }
  try {
    const r = await window.workbench.teamBoardOld({ projectId: p.id, theme: currentTheme(), style: String(currentThemeId()).split('-')[0], themeId: currentThemeId() });
    if (r && r.ok) {
      toast(r.reused ? '团队看板浮窗已置顶（复用已有窗口）' : '已打开旧版团队看板浮窗（置顶）', 'ok');
      loadTeamStatus({ force: true });
    } else {
      toast('旧版看板失败：' + ((r && (r.message || r.why || r.code)) || '未知错误'), 'bad');
    }
  } catch (e) { toast('旧版看板失败：' + humanError(e.message), 'bad'); }
}

// B-231006-b81a：绑定失败隔离——任何单个绑定块抛错都不得连带其它按钮失效。
// 失败同时记控制台与「通知审计」（主进程 notify:audit → 团队/状态/项目/<项目>/通知审计.jsonl），
// 供 Owner 真机排障时定位是哪一块初始化失败（而不是整页按钮静默失效）。
const bindFailures = [];
try { window.__bindFailures = bindFailures; } catch { /* ignore */ }
function auditBindFailure(name, e) {
  const text = `[bind] ${name} 初始化失败：${String((e && e.message) || e)}`;
  bindFailures.push({ at: new Date().toISOString(), block: String(name), message: String((e && e.message) || e), stack: String((e && e.stack) || '').slice(0, 900) });
  try { console.error(text + '\n' + String((e && e.stack) || '')); } catch { /* ignore */ }
  try {
    if (window.workbench && typeof window.workbench.notifyAudit === 'function') {
      window.workbench.notifyAudit({ level: 'error', text, source: 'bind-failure' });
    }
  } catch { /* 审计失败不阻断绑定 */ }
}
function bindBlock(name, fn) {
  try { fn(); } catch (e) { auditBindFailure(name, e); }
}
/** 抽屉关闭：× 与蒙层。独立块 + 幂等标记，bind() 中途抛错时由 boot 的兜底再调一次仍能关闭。 */
function bindPanelControls() {
  $$('[data-close-drawer]').forEach((b) => {
    if (b.dataset.drawerCloseBound === '1') return;
    b.dataset.drawerCloseBound = '1';
    bindBlock('drawer-close:' + String(b.getAttribute('data-close-drawer') || ''), () => b.addEventListener('click', () => setDrawer(null)));
  });
  const mask = $('#drawer-mask');
  if (mask && mask.dataset.drawerMaskBound !== '1') {
    mask.dataset.drawerMaskBound = '1';
    bindBlock('drawer-mask', () => mask.addEventListener('click', () => setDrawer(null)));
  }
}
/** 三个抽屉的入口按钮：各自独立块，单个失败不影响其它入口。 */
function bindPanelOpeners() {
  const pairs = [['#team-pill', 'team'], ['#session-pill', 'team'], ['#btn-board', 'project'], ['#btn-members', 'team'], ['#btn-session-queue', 'session-queue']];
  for (const [sel, name] of pairs) {
    const el = $(sel);
    if (!el || el.dataset.drawerOpenerBound === '1') continue;
    el.dataset.drawerOpenerBound = '1';
    bindBlock('drawer-open:' + sel, () => el.addEventListener('click', () => setDrawer(name)));
  }
}

/** 关键按钮兜底：刷新。Owner 回归基线要求「刷新 / 三个 × / 项目面板」同时可用，
 *  bind() 任意位置抛错时由 boot 的兜底再绑一次（幂等标记，成功路径不会重复绑）。 */
function bindCriticalControls() {
  const btn = $('#btn-refresh');
  if (btn && btn.dataset.refreshBound !== '1') {
    btn.dataset.refreshBound = '1';
    bindBlock('refresh', () => btn.addEventListener('click', async (e) => {
      const target = e.currentTarget;
      if (target) target.disabled = true;
      try { await refreshAll({ toast: true }); } catch (err) { toast('刷新失败：' + humanError(err.message), 'bad'); } finally { if (target) target.disabled = false; }
    }));
  }
}

/** B-6bb5：卡片「重试连接」事件委托（按钮由 renderSessions 动态生成，单次 document 委托即可）。 */
function bindDshRetryDelegation() {
  if (document.body && document.body.dataset.dshRetryBound === '1') return;
  if (document.body) document.body.dataset.dshRetryBound = '1';
  bindBlock('dsh-retry-delegation', () => document.addEventListener('click', (e) => {
    const rebind = e.target instanceof Element ? e.target.closest('[data-rebind-by-title]') : null;
    if (rebind) {
      e.preventDefault();
      if (rebind.disabled) return;
      rebind.disabled = true;
      void rebindSessionsByTitle().finally(() => { rebind.disabled = false; });
      return;
    }
    const btn = e.target instanceof Element ? e.target.closest('[data-dsh-retry]') : null;
    if (!btn) return;
    e.preventDefault();
    void retryDshFromCard(btn);
  }));
}

function bind() {
  // B-fa80：系统占用点击立即刷新（平时 2 秒自动刷新）。
  $('#metrics')?.addEventListener('click', () => { tickMetrics(); });
  // R-9db6：决策箱刷新（只读重拉）
  $('#btn-decision-refresh')?.addEventListener('click', () => { loadDecisionBox(); });
  // T-b417：守护状态点击立即刷新（平时 10 秒刷新）；启动先读一次。
  $('#daemon-pill')?.addEventListener('click', () => { tickDaemonStatus(); });
  tickDaemonStatus();
  // R4 结论：保留 + 降级门——守护状态 10s IPC 只读；后台/隐藏时暂停（gate.js）。
  setInterval(r4Gate(() => { tickDaemonStatus(); }), 10000);
  // R-2a69：F1 由主进程统一接管（焦点在 DSH webview 里也能开引导）。
  if (window.workbench && typeof window.workbench.onGuideOpen === 'function') {
    window.workbench.onGuideOpen(() => { showGuide(true); });
  }
  // 顶栏：工作区切换 + 团队/会话状态
  $('#workspace-switch')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const pop = $('#workspace-pop');
    setWorkspacePop(Boolean(pop?.hidden));
  });
  $('#workspace-pop-list')?.addEventListener('click', (e) => {
    const restore = e.target.closest('[data-ws-restore]');
    if (restore && !restore.disabled) {
      setWorkspacePop(false);
      openRestoreModal({ name: restore.dataset.wsRestore });
      return;
    }
    const item = e.target.closest('[data-project]');
    if (item) selectWorkspace(item.dataset.project);
  });
  bindPanelOpeners();
  $('#legacy-owner-quick-removed')?.addEventListener('click', openOwnerGate);
  $('#legacyReviewStage')?.addEventListener('click', () => {
    if (activeProject()) openOwnerGate();
  });
  $('#btn-workspace')?.addEventListener('click', openNewProject);
  $('#btn-side-new')?.addEventListener('click', openNewProject);
  $('#btn-team-start')?.addEventListener('click', () => startTeam($('#btn-team-start')));
  $('#btn-pool')?.addEventListener('click', () => togglePool());
  // Esc 先收详情（焦点回原行），再收整池；搜索框内的 Esc 已在面板内 stopPropagation 并清空搜索。
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Escape') return;
    if (poolUi.detailId) { closePoolDetail(); return; }
    if (poolUi.open) closePool();
  });
  setTimeout(() => { refreshPoolBadge(); }, 1500);
  $('#btn-restore')?.addEventListener('click', () => openRestoreModal());
  $('#btn-clean-missing')?.addEventListener('click', () => cleanMissingProjects());
  $('#btn-empty-new')?.addEventListener('click', openNewProject);
  $('#btn-side-restore')?.addEventListener('click', () => openRestoreModal());
  bindCriticalControls();
  $('#btn-folder-top')?.addEventListener('click', openProjectFolder);
  $('#metrics')?.addEventListener('click', () => { tickMetrics(); });
  $('#btn-dsh-mode')?.addEventListener('click', () => reloadDshView());
  $('#btn-dsh-off-reload')?.addEventListener('click', () => { void reloadDshView({ quiet: true }); });
  $('#btn-side')?.addEventListener('click', () => setSidebarHidden(!document.body.classList.contains('sidebar-hidden')));
  $('#btn-wc-folder')?.addEventListener('click', openProjectFolder);
  $('#btn-wc-team')?.addEventListener('click', () => setDrawer('team'));
  $('#btn-wc-build')?.addEventListener('click', () => startTeam($('#btn-wc-build')));
  $('#btn-theme')?.addEventListener('click', toggleTheme);
  // 界面字号：A- / A+ / 100% + Ctrl+= / Ctrl+-（0.9–1.5，步进 0.1；值存 workbench.json.ui.zoom，重启恢复）
  (function setupZoomControls() {
    const out = $('#btn-zoom-out');
    const reset = $('#btn-zoom-reset');
    const inc = $('#btn-zoom-in');
    let current = 1;
    const paint = () => { if (reset) reset.textContent = Math.round(current * 100) + '%'; };
    const apply = async (next) => {
      const z = Math.min(1.5, Math.max(0.9, Math.round(Number(next) * 10) / 10));
      try {
        const r = (window.workbench && typeof window.workbench.uiZoomSet === 'function')
          ? await window.workbench.uiZoomSet(z) : null;
        current = (r && Number.isFinite(r.zoom)) ? r.zoom : z;
      } catch { current = z; }
      paint();
    };
    out?.addEventListener('click', () => apply(current - 0.1));
    inc?.addEventListener('click', () => apply(current + 0.1));
    reset?.addEventListener('click', () => apply(1));
    window.addEventListener('keydown', (e) => {
      if (!(e.ctrlKey || e.metaKey) || e.altKey) return;
      if (e.key === '=' || e.key === '+') { e.preventDefault(); apply(current + 0.1); }
      else if (e.key === '-' || e.key === '_') { e.preventDefault(); apply(current - 0.1); }
      else if (e.key === '0') { e.preventDefault(); apply(1); }
    });
    if (window.workbench && typeof window.workbench.uiZoomGet === 'function') {
      window.workbench.uiZoomGet().then((r) => { if (r && Number.isFinite(r.zoom)) { current = r.zoom; paint(); } }).catch(() => {});
    }
    paint();
  })();
  // 内存回收（类 GC，2026-11-13 T-38f0）：徽标每 5 秒刷新；「立即回收」优雅重载；重载后恢复抽屉/滚动
  (function setupMemoryRecycle() {
    const badge = $('#mem-badge');
    const btn = $('#btn-mem-recycle');
    const fmt = (mb) => (!Number.isFinite(Number(mb)) ? '—' : (Number(mb) >= 1024 ? (Number(mb) / 1024).toFixed(2) + 'GB' : Math.round(Number(mb)) + 'MB'));
    let lastMb = null;
    const paint = (data) => {
      if (!badge) return;
      const mb = Number(data && data.mb);
      // 首次采样前/采样失败：有上次值保留并标灰，没有就显示“—”；绝不写 0MB（Owner 实测过 0MB）。
      if (!Number.isFinite(mb) || mb <= 0) {
        badge.textContent = lastMb ? '内存 ' + fmt(lastMb) : '内存 —';
        badge.classList.add('is-unknown');
        badge.title = lastMb
          ? `这次没读到内存，先显示上次的 ${fmt(lastMb)}（会继续每 5 秒重试）`
          : '正在等待第一次内存采样（每 5 秒一次，读到就显示真实 MB）';
        return;
      }
      lastMb = mb;
      badge.classList.remove('is-unknown');
      badge.textContent = '内存 ' + fmt(mb);
      badge.classList.toggle('is-high', Boolean(data && data.thresholdMB && mb >= Number(data.thresholdMB)));
      badge.title = `渲染进程内存 ${fmt(mb)}；当前阈值 ${fmt((data && data.thresholdMB) || 0)}（自适应：基线×2.5，最低 1.8GB、上限 3GB）${Number.isFinite(Number(data && data.baselineMB)) && Number(data.baselineMB) > 0 ? `；基线 ${fmt(data.baselineMB)}` : '；基线待启动满 10 分钟后确定'}；涨得快才自动回收`;
    };
    // 回收前由主进程调用：把当前抽屉/滚动存到 localStorage，重载后恢复（项目选中由 workbench.json 持久化，不丢）。
    window.__awbMemSnapshot = () => {
      const snap = { drawer: typeof openDrawerName === 'string' ? openDrawerName : '', theme: document.documentElement.getAttribute('data-theme') || '', scroll: window.scrollY || 0, at: Date.now() };
      try { localStorage.setItem('awb.memResume', JSON.stringify(snap)); } catch { /* ignore */ }
      return snap;
    };
    try {
      const resume = JSON.parse(localStorage.getItem('awb.memResume') || 'null');
      if (resume) {
        localStorage.removeItem('awb.memResume');
        if (resume.drawer) { try { setDrawer(resume.drawer); } catch { /* ignore */ } }
        if (resume.scroll) { try { window.scrollTo(0, resume.scroll); } catch { /* ignore */ } }
      }
    } catch { /* ignore */ }
    btn?.addEventListener('click', async () => {
      btn.disabled = true;
      try {
        const r = await window.workbench.memRecycle();
        if (r && r.ok) toast(`正在回收内存（回收前 ${fmt(r.beforeMB)}）…`);
        else toast('回收失败：' + String((r && (r.code || r.message)) || '未知原因'), 'bad');
      } catch (e) {
        toast('回收失败：' + humanError((e && e.message) || e), 'bad');
      } finally {
        setTimeout(() => { btn.disabled = false; }, 4000);
      }
    });
    if (window.workbench && typeof window.workbench.onMemStats === 'function') window.workbench.onMemStats(paint);
    // T-5d98（R-fd42）：PM 身份绑定状态——主进程三时机对齐后推送，这里只做展示（失败可见，不静默）。
    if (window.workbench && typeof window.workbench.onPmIdentity === 'function') window.workbench.onPmIdentity(applyPmIdentityState);
    if (window.workbench && typeof window.workbench.pmIdentityGet === 'function') {
      Promise.resolve(window.workbench.pmIdentityGet()).then((s) => { if (s) applyPmIdentityState(s); }).catch(() => {});
    }
    if (window.workbench && typeof window.workbench.onMemRecycleDone === 'function') {
      window.workbench.onMemRecycleDone((d) => { paint({ mb: d && d.after, thresholdMB: (d && d.thresholdMB) || 0, baselineMB: d && d.baselineMB }); toast(`已回收：${fmt(d && d.before)} → ${fmt(d && d.after)}`); });
    }
    if (window.workbench && typeof window.workbench.memStats === 'function') window.workbench.memStats().then(paint).catch(() => {});
  })();
  $('#board-launcher')?.addEventListener('click', toggleBoardPanel);
  // T-e2a3：右下角收成一个可展开按钮（默认收起；点开才露出 一键代管/决策箱/看板/流程 四行）。
  initFloatToggle();
  // R-c1ed 第一刀：渲染崩溃感知——顶部人话横幅 + 一键重载（事件由主进程 app:render-crash 推送）。
  initCrashBanner();
  $('#btn-project-remove')?.addEventListener('click', removeProjectRecord);
  $('#btn-team-board-2')?.addEventListener('click', openBoardPanel);
  $('#btn-team-sync')?.addEventListener('click', syncTeamNow);
  $('#btn-team-board-refresh')?.addEventListener('click', async () => {
    const r = await loadBoardPanel({ force: true });
    if (!boardUi.open && r) renderBoardSummary();
    toast(r ? '已按当前看板项目刷新摘要' : ('看板刷新失败：' + (boardUi.error || '未知错误')), r ? 'ok' : 'bad');
  });
  $('#board-panel-close')?.addEventListener('click', closeBoardPanel);
  $('#board-panel-collapse')?.addEventListener('click', toggleBoardCollapsed);
  $('#board-panel-refresh')?.addEventListener('click', async () => {
    const r = await loadBoardPanel({ force: true });
    toast(r ? '已刷新团队看板' : ('看板刷新失败：' + (boardUi.error || '未知错误')), r ? 'ok' : 'bad');
  });
  $('#board-panel-view')?.addEventListener('click', async () => {
    const select = $('#board-panel-project');
    if (!select || !select.value) { toast('先选择看板项目', 'bad'); return; }
    await boardSwitchSubject(select.value);
  });
  $('#board-panel-open')?.addEventListener('click', () => {
    if (!boardUi.subjectId) { toast('这个看板项目还没登记到本机；先在恢复 / 工作区清单登记', 'bad'); return; }
    openTeamBoardOld(boardUi.subjectId);
  });
  $('#board-panel-project')?.addEventListener('change', async () => {
    const select = $('#board-panel-project');
    if (!select || !select.value) return;
    // 选中即切换看板项目（只读查看），不需要再点一次「查看」；视图不跳转。
    await boardSwitchSubject(select.value);
  });
  $('#board-panel-max')?.addEventListener('click', toggleBoardMaximized);
  $('#board-panel-owner')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-board-owner]')) openOwnerGate();
  });
  $('#board-panel-frame')?.addEventListener('load', onBoardFrameLoad);
  bindBoardPanelDrag();
  $('#flow-board-open')?.addEventListener('click', openBoardPanel);
  $('#btn-ws-refresh')?.addEventListener('click', async () => {
    await loadWorkspaces(true);
    renderWorkspacePopover();
    const n = wsUi.data && Array.isArray(wsUi.data.projects) ? wsUi.data.projects.length : 0;
    toast(wsUi.error ? '团队/DSH 清单读取失败：' + wsUi.error : `已刷新团队/DSH 清单：${n} 个工作区`, wsUi.error ? 'bad' : 'ok');
  });
  $('#team-log-filter')?.addEventListener('change', () => {
    const p = activeProject();
    if (p) renderTeamLog(p);
  });
  $('#btn-receipts-refresh')?.addEventListener('click', () => { loadReceipts({ force: true }); });
  // R-b5fc F-4b：角色队列刷新（只读重拉 role_queues.json）
  $('#btn-queue-refresh')?.addEventListener('click', () => { loadRoleQueue({ force: true }); });
  $('#team-receipts-note')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-receipts-board]')) openBoardPanel();
  });
  $('#inbox-block')?.addEventListener('toggle', () => {
    if (inboxBlockOpen()) renderInbox();
  });

  // 角色收件箱：六角色切换、未读/已读筛选、详情与 read/ack 入口
  $('#inbox-roles')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-inbox-role]');
    if (btn) setInboxRole(btn.dataset.inboxRole);
  });
  $('#inbox-filters')?.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-inbox-filter]');
    if (btn) setInboxFilter(btn.dataset.inboxFilter);
  });
  $('#inbox-list')?.addEventListener('click', (e) => {
    const item = e.target.closest('[data-inbox-msg]');
    if (item) selectInboxMessage(item.dataset.inboxMsg);
  });
  $('#inbox-detail')?.addEventListener('click', (e) => {
    if (e.target.closest('[data-inbox-prompt]')) { openInboxRolePrompt(activeProject()); return; }
    if (e.target.closest('[data-inbox-read]')) { inboxReadNow(activeProject()); return; }
    if (e.target.closest('[data-inbox-ack]')) { openInboxAck(activeProject()); }
  });
  $('#btn-inbox-refresh')?.addEventListener('click', () => { refreshInbox(); });

  // 更多菜单
  $('#btn-more')?.addEventListener('click', (e) => {
    e.stopPropagation();
    const menu = $('#more-menu');
    setMoreMenu(Boolean(menu?.hidden));
    setWorkspacePop(false);
  });
  $('#more-menu')?.addEventListener('click', (e) => {
    // R-8947：点三档之一 → 写盘 + 应用（失败显示 [data-effect-error] 并回退）
    const effectItem = e.target.closest('#more-menu [data-effect-menu] [data-effect-option]');
    if (effectItem) {
      e.stopPropagation();
      const opt = effectItem.dataset.effectOption;
      setEffectMenu(false);
      setMoreMenu(false);
      chooseEffectOption(opt);
      return;
    }
    // 外观子菜单的 5 项：点即切（R-fe90 AC1/AC3；当前项 aria-checked 唯一）
    // B-20261116-122745-dc6f：**必须限定在子菜单里**！applyThemeState 会给 <html> 打
    // data-theme-id（当前档），所以裸写 e.target.closest('[data-theme-id]') 时点「外观」根锚点会
    // 沿祖先链命中 <html>，走进「点主题项」分支：菜单被收起 + 重应用当前档 → 看起来「点不开/没反应」。
    const themeItem = e.target.closest('#more-menu [data-theme-menu] [data-theme-id]');
    if (themeItem) {
      e.stopPropagation();
      const id = themeItem.dataset.themeId;
      setThemeMenu(false);
      setMoreMenu(false);
      applyThemeId(id);
      return;
    }
    const btn = e.target.closest('[data-more]');
    if (!btn || btn.disabled) return;
    e.stopPropagation();
    if (btn.dataset.more === 'storage') {
      // R-bcac：设置页「存储位置」——应用数据目录 / 临时沙盘目录可改，显示占用/上限/上次清理。
      openStoragePanel();
      return;
    }
    if (btn.dataset.more === 'effect') {
      const box = $('#more-menu [data-effect-menu]');
      const willOpen = Boolean(box && box.hidden);
      setEffectMenu(willOpen);
      return;
    }
    // data-more="theme" 是「外观」根锚点（layout-check 的 themeInMoreMenu 依赖它）：点它展开 5 项
    if (btn.dataset.more === 'theme') {
      const box = $('#more-menu [data-theme-menu]');
      const willOpen = Boolean(box && box.hidden);
      setThemeMenu(willOpen);
      if (willOpen) themeMenuFocus(1);
      return;
    }
    // data-more="upgrade"：在线升级子菜单（e610）。不能落到 runMoreAction —— 那里会先收起整个菜单，
    // 导致「检查更新」点了没有任何可见反应（R-20261119 实测）。
    if (btn.dataset.more === 'upgrade') {
      const box = $('#more-menu [data-upgrade-menu]');
      const willOpen = Boolean(box && box.hidden);
      if (box) box.hidden = !willOpen;
      if (willOpen) {
        setMoreMenu(true);
        try { void loadAppVersion(); paintUpgrade(); } catch { /* ignore */ }
      }
      return;
    }
    runMoreAction(btn.dataset.more);
  });
  // 外观子菜单键盘：↑↓ 移动、Esc 收起并回到根锚点（AC5「5 项键盘可全选」）
  $('#more-menu')?.addEventListener('keydown', (e) => {
    const box = $('#more-menu [data-theme-menu]');
    if (!box || box.hidden) return;
    if (e.key === 'ArrowDown') { e.preventDefault(); themeMenuFocus(1); return; }
    if (e.key === 'ArrowUp') { e.preventDefault(); themeMenuFocus(-1); return; }
    if (e.key === 'Escape') {
      e.preventDefault();
      e.stopPropagation();
      setThemeMenu(false);
      $('#more-menu [data-more="theme"]')?.focus();
    }
  });
  document.addEventListener('click', (e) => {
    const menu = $('#more-menu');
    if (menu && !menu.hidden && !e.target.closest('#more-menu') && !e.target.closest('#btn-more')) setMoreMenu(false);
    const pop = $('#workspace-pop');
    if (pop && !pop.hidden && !e.target.closest('#workspace-pop') && !e.target.closest('#workspace-switch')) setWorkspacePop(false);
  });
  $$('[data-win]').forEach((b) => b.addEventListener('click', () => window.workbench.windowControl(b.dataset.win)));
  $('#titlebar')?.addEventListener('dblclick', (e) => {
    if (e.target.closest('button, #metrics')) return;
    window.workbench.windowControl('max');
  });

  // DSH 主画面
  $('#dsh-retry')?.addEventListener('click', retryDsh);
  $('#dsh-config-2')?.addEventListener('click', openDshConfig);
  $('#btn-dsh-config')?.addEventListener('click', openDshConfig);
$('#btn-dsh-pin')?.addEventListener('click', async () => {
  try {
    const r = await window.workbench.dshPin();
    if (r && r.ok) {
      toast('已记住 DSH 地址：' + String(r.baseUrl || ''), 'ok');
      const s = await window.workbench.dshStatus();
      state.dsh = s.status;
      renderDsh(s.status);
    } else {
      toast((r && (r.message || r.code)) || '记住地址失败', 'bad');
    }
  } catch (e) { toast('记住地址失败：' + (e.message || e), 'bad'); }
});
  $('#store-flag')?.addEventListener('click', () => {
    const err = state?.storeError;
    toast(err ? (err.message || '状态库异常') : '状态库正常', err ? 'bad' : 'ok');
  });
  $('#btn-dsh')?.addEventListener('click', async () => {
    const status = await probeDsh(true, false);
    toast(status?.online ? 'DSH 已连接' : 'DSH 未连接：' + ((status && status.message) || '检查地址'), status?.online ? 'ok' : 'bad');
  });

  // 项目面板头 / 视图按钮
  $('#btn-add-task')?.addEventListener('click', openTaskModal);
  $('#btn-task-add-2')?.addEventListener('click', openTaskModal);
  $('#btn-board-add')?.addEventListener('click', openTaskModal);
  $('#btn-task-board')?.addEventListener('click', () => showTab('board'));
  $('#btn-open')?.addEventListener('click', openProjectFolder);
  $('#btn-project-index')?.addEventListener('click', openProjectIndex);
  // 项目终验（R-fb48）：前置检查 → 记忆先快照后清理 → 写终验记录；失败按错误码提示，不吞。
  $('#btn-finalize')?.addEventListener('click', async () => {
    const id = boardUi.currentProjectId;
    if (!id) { toast('先选择一个项目'); return; }
    if (!window.confirm('项目终验：先快照本项目记忆，再清空记忆库中本项目的内容，并写终验记录（不可重复，Owner --force 除外）。继续？')) return;
    try {
      const r = await window.workbench.finalizeRun({ projectId: id });
      const mem = r && r.memory ? r.memory : {};
      toast(`终验完成：${(r && r.record && r.record.finalizedAt) || ''} ｜ 记忆 ${mem.status || '-'}${mem.cleared ? '（已清理）' : '（未清理）'}`);
      if (typeof refreshTeam === 'function') refreshTeam();
    } catch (error) {
      toast(String((error && error.message) || error));
    }
  });
  $('#btn-team-board-old')?.addEventListener('click', openBoardPanel);
  $('#btn-provision')?.addEventListener('click', () => startTeam($('#btn-provision')));
  $('#legacy-owner-btn-removed')?.addEventListener('click', openOwnerGate);
  $('#legacy-owner-open-removed')?.addEventListener('click', openOwnerGate);
  $('#legacy-owner-btn-removed-legacy')?.addEventListener('click', openOwnerModal);
  $('#legacy-owner-flow-removed')?.addEventListener('click', openOwnerGate);
  $('#project-to-team')?.addEventListener('click', () => setDrawer('team'));
  $('#team-to-project')?.addEventListener('click', () => setDrawer('project'));

  // 团队台
  $('#btn-roles-refresh')?.addEventListener('click', async () => {
    const p = activeProject();
    let commNote = '';
    if (p && window.workbench && typeof window.workbench.teamReconcile === 'function') {
      try {
        const r = await window.workbench.teamReconcile({ projectId: p.id });
        if (r && r.state) { state = r.state; render(); }
        else await refresh();
        const changed = r && r.reconcile && Number(r.reconcile.changed);
        commNote = ` · 通信链对账${Number.isFinite(changed) ? '更新 ' + changed + ' 条' : '完成'}`;
      } catch (e) {
        await refresh();
        commNote = ' · 通信链对账失败：' + humanError(e.message);
      }
    } else {
      await refresh();
    }
    await loadDshTeamStatus({ force: true });
    await loadTeamStatus({ force: true });
    const current = activeProject();
    const verified = current ? verifiedCount(current) : null;
    const total = current ? teamRoleCount(current) : 6;
    toast((verified === null
      ? 'DSH 未连接：只显示本地会话映射'
      : `已核验：${verified}/${total} 角色会话在 DSH 工作区里（${current ? teamModeLabel(current) : '完整 6 人'}）`) + commNote, verified === null ? 'bad' : 'ok');
  });
  $('#btn-team-board')?.addEventListener('click', openBoardPanel);
  // 投票：所有按钮都是动态渲染，用文档委托；点击只调用真实 vote:* IPC。
  document.addEventListener('click', async (e) => {
    const target = e.target instanceof Element ? e.target : null;
    if (!target) return;
    const startVote = target.closest('[data-vote-new]');
    if (startVote) {
      e.preventDefault();
      openVoteModal();
      return;
    }
    const castBtn = target.closest('[data-vote-cast]');
    if (castBtn) {
      e.preventDefault();
      if (castBtn.disabled) return;
      const card = castBtn.closest('[data-vote-card]');
      if (!card) return;
      const row = castBtn.closest('.vote-voter') || card;
      const choice = (row.querySelector('[data-vote-choice]') || {}).value || '';
      const reason = String((row.querySelector('[data-vote-reason]') || {}).value || '').trim();
      setButtonsBusy([castBtn], true);
      try {
        await castVote(castBtn.dataset.voteCast, castBtn.dataset.voteRole, choice, reason);
      } catch (err) {
        toast('投票失败：' + humanError(err.message), 'bad');
      } finally {
        if (castBtn.isConnected) setButtonsBusy([castBtn], false);
      }
    }
  });
  $('#btn-team-flow')?.addEventListener('click', () => setFlowPanel(true));
  $('#btn-team-members')?.addEventListener('click', openMembersModal);
  $('#btn-team-project')?.addEventListener('click', () => setDrawer('project'));

  // 文件
  $('#btn-files-refresh')?.addEventListener('click', loadFiles);
  $('.file-toolbar')?.addEventListener('click', (e) => {
    const tool = e.target.closest('[data-file-tool]')?.dataset.fileTool;
    if (!tool) return;
    if (tool === 'refresh') { loadFiles(); return; }
    const data = fileUi.data;
    if (!data) return;
    if (tool === 'expand') {
      // R-e31b：展开只加载当前已加载层的直接子目录（懒加载，不整树）。
      const topDirs = (fileUi.children.get('') || []).filter((x) => x.isDir).map((x) => x.rel);
      fileUi.expanded = new Set(topDirs);
      void Promise.all(topDirs.filter((rel) => !fileUi.loaded.has(rel)).map((rel) => loadFileDir(rel).catch(() => null)))
        .then(() => renderFileTree());
    } else if (tool === 'collapse') fileUi.expanded.clear();
    renderFileTree();
  });
  $('#files-list')?.addEventListener('click', async (e) => {
    if (e.target.closest('[data-file-retry]')) { loadFiles(); return; }
    const row = e.target.closest('[data-file-rel]');
    if (!row) return;
    const rel = row.dataset.fileRel;
    if (row.dataset.fileKind === 'dir') { toggleFileDir(rel); return; }
    const p = activeProject();
    if (!p) return;
    const item = fileUi.byRel.get(rel) || null;
    if (!item) {
      // 懒加载下条目可能来自未加载层：按目录再取一次
      const dirRel = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
      try { if (!fileUi.loaded.has(dirRel)) await loadFileDir(dirRel); } catch { /* ignore */ }
    }
    const full = fileUi.byRel.get(rel) || item;
    if (!full) { toast('文件列表已变化，请刷新后重试', 'bad'); return; }
    openFilePreview(p, full);
  });
  $('#files-list')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target.closest('[data-file-rel]');
    if (!row) return;
    e.preventDefault();
    if (row.dataset.fileKind === 'dir') toggleFileDir(row.dataset.fileRel);
    else row.click();
  });

  // 派单：任意角色可发起（含角色→PM、角色互发）；无会话/降级都会先说明后果再发。
  $('#dispatch-send')?.addEventListener('click', () => sendDispatch(activeProject()));
  $('#dispatch-role')?.addEventListener('change', () => updateDispatchHint(activeProject()));
  $('#dispatch-from')?.addEventListener('change', () => {
    const p = activeProject();
    if (!p) return;
    renderDispatch(p);
    updateDispatchHint(p);
  });
  $('#dispatch-ack')?.addEventListener('change', () => updateDispatchHint(activeProject()));

  // 项目面板页签
  $$('#tabs .tab').forEach((b) => b.addEventListener('click', () => showTab(b.dataset.tab)));

  // 切换工作区 / 六角色会话操作
  $('#project-list')?.addEventListener('click', (e) => {
    const remove = e.target.closest('[data-project-remove]');
    if (remove) {
      e.stopPropagation();
      removeProjectRecord(remove.dataset.projectRemove);
      return;
    }
    const item = e.target.closest('[data-project]');
    if (item) selectWorkspace(item.dataset.project);
  });
  $('#project-list')?.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const item = e.target instanceof Element ? e.target.closest('[data-project]') : null;
    if (!item || e.target.closest('[data-project-remove]')) return;
    e.preventDefault();
    selectWorkspace(item.dataset.project);
  });
  // 旧流程面板：文档 / 角色卡 / 阶段跳转 / 只读刷新（全部只读，不调写接口）
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const go = target.closest('[data-legacy-go]');
    if (go) {
      e.preventDefault();
      setDrawer('project');
      showTab(go.dataset.legacyGo);
      return;
    }
    // R-9fbe：分级原因行/补齐按钮的入口（缺文档清单 / 重读文档 / 重新 boot / 账本处置）。
    const missingLink = target.closest('[data-legacy-missing]');
    if (missingLink) {
      e.preventDefault();
      setDrawer('project');
      showTab('overview');
      const list = document.getElementById('missing-list');
      if (list && list.scrollIntoView) list.scrollIntoView({ block: 'center', behavior: 'smooth' });
      if (typeof toast === 'function') toast(`缺文档清单 #missing-list：${list ? String(list.getAttribute('data-missing-count') || '0') : '0'} 项（与「文档待补」同源）`, 'warn');
      return;
    }
    if (target.closest('[data-legacy-refresh]')) {
      e.preventDefault();
      loadLegacyDocs(true);
      toast('正在重新读取项目文档、boot 记录与工作流（只读）', 'ok');
      return;
    }
    if (target.closest('[data-legacy-reboot]')) {
      e.preventDefault();
      legacyBootAll(target.closest('[data-legacy-reboot]'));
      return;
    }
    const ledgerLink = target.closest('[data-legacy-ledger]');
    if (ledgerLink) {
      e.preventDefault();
      // 处置行在「流程」页：先切到该页再滚过去，否则在概览页点了没反应。
      showTab('flow');
      const box = document.getElementById('legacy-flow-ledger');
      if (box && box.scrollIntoView) box.scrollIntoView({ block: 'center', behavior: 'smooth' });
      toast('账本分叉的处置行在「流程」页 #legacy-flow-ledger；处置走 team.mjs 协议命令（PM 令牌）+ append-only 审计（界面不改 JSON）', 'warn');
      return;
    }
    // R-9fbe F-9fbe-5（T-ed7）：分叉处置按钮 → owner:ledger-close-task / owner:ledger-reopen。
    const ledgerAction = target.closest('[data-ledger-action]');
    if (ledgerAction) {
      e.preventDefault();
      if (ledgerAction.disabled) {
        // 禁用也必须留横幅（只 toast 等于静默）；错误码固定，原因照抄行内/标题里的人话。
        const why = String(ledgerAction.title || '该处置按钮当前不可点（行内已写原因）');
        ledgerActionUi.banner = { kind: 'warn', text: `暂不可点：${why}`, code: 'LEDGER_ACTION_DISABLED' };
        ledgerActionUi.lastAt = Date.now();
        try { ledgerRenderLedgerBlock(); } catch { /* 概览页没渲染出来时忽略 */ }
        toast(why, 'warn');
        return;
      }
      ledgerActionRun(ledgerAction);
      return;
    }
    // R-c651 F-c651-4/5：团队行的「一键唤醒」「全部已读」（口径由主进程 → 团队工具 presence/mark-read/wake 执行）
    const wakeRoleBtn = target.closest('[data-action="wake-role"]');
    if (wakeRoleBtn) {
      e.preventDefault();
      if (wakeRoleBtn.disabled) return;
      wakeRoleFromRow(wakeRoleBtn.dataset.role || '', wakeRoleBtn);
      return;
    }
    const markReadBtn = target.closest('[data-action="mark-read"]');
    if (markReadBtn) {
      e.preventDefault();
      if (markReadBtn.disabled) return;
      markRoleReadFromRow(markReadBtn.dataset.role || '', markReadBtn);
      return;
    }
    if (target.closest('#legacy-boot-all, #roles-boot-all, #team-boot-all, #legacy-gate-reboot')) {
      e.preventDefault();
      legacyBootAll(target.closest('#legacy-boot-all, #roles-boot-all, #team-boot-all, #legacy-gate-reboot'));
      return;
    }
    const bootButton = target.closest('[data-legacy-boot]');
    if (bootButton) {
      e.preventDefault();
      legacyBoot(bootButton.dataset.legacyBoot);
      return;
    }
    const actionButton = target.closest('[data-legacy-req-action]');
    if (actionButton) {
      e.preventDefault();
      if (actionButton.dataset.gateBlocked) {
        const action = actionButton.dataset.legacyReqAction;
        const entry = gateForAction(action) || { action, gate: '', code: '', title: '闸门未满足', missing: [actionButton.title], next: '' };
        showGateRejection(entry, { attempted: action, source: 'team.mjs gates.mjs（gate:check）' });
        return;
      }
      legacyActionModal(actionButton.dataset.legacyReqAction, actionButton.dataset.reqId || '');
      return;
    }
    const ownerClick = target.closest('[data-legacy-owner-click]');
    if (ownerClick) {
      e.preventDefault();
      const action = ownerClick.dataset.legacyOwnerClick === 'accept' ? 'owner-accept' : 'owner-review';
      if (ownerClick.dataset.gateBlocked) {
        const entry = gateForAction(action) || { action, gate: '', code: '', title: '闸门未满足', missing: [ownerClick.title], next: '' };
        showGateRejection(entry, { attempted: action, source: 'team.mjs gates.mjs（gate:check）' });
        return;
      }
      if (ownerClick.disabled) return;
      legacyOwnerOneClick(
        ownerClick.dataset.legacyOwnerClick,
        ownerClick.dataset.reqId || '',
        ownerClick.dataset.legacyOwnerDecision || '',
        ownerClick
      );
      return;
    }
    const scrollTarget = target.closest('[data-legacy-scroll]');
    if (scrollTarget) {
      e.preventDefault();
      const panel = document.getElementById('legacy-requirements');
      if (panel) panel.scrollIntoView({ behavior: 'smooth', block: 'start' });
      return;
    }
    const docButton = target.closest('[data-legacy-doc]');
    if (docButton) {
      e.preventDefault();
      legacyOpenDoc(docButton.dataset.legacyDoc);
      return;
    }
    const docTab = target.closest('[data-legacy-doc-tab]');
    if (docTab) {
      e.preventDefault();
      legacyOpenDoc(docTab.dataset.legacyDocTab);
      return;
    }
    const roleCard = target.closest('[data-legacy-role-card]');
    if (roleCard) {
      e.preventDefault();
      legacyOpenDoc('role:' + roleCard.dataset.legacyRoleCard);
      return;
    }
    const roleIndex = target.closest('[data-legacy-role-index]');
    if (roleIndex) {
      e.preventDefault();
      legacyOpenDoc('index:' + roleIndex.dataset.legacyRoleIndex);
      return;
    }
    if (target.closest('#legacy-refresh, #legacy-refresh-2')) {
      e.preventDefault();
      loadLegacyDocs(true);
      toast('正在重新读取项目文档与六角色目录（只读）', 'ok');
      return;
    }
    if (target.closest('[data-open-owner-legacy]')) {
      e.preventDefault();
      openOwnerModal();
      return;
    }
    if (target.closest('[data-open-owner]')) {
      e.preventDefault();
      openOwnerGate();
      return;
    }
    if (target.closest('[data-open-team]')) {
      e.preventDefault();
      setDrawer('team');
      return;
    }
  });

  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const locate = target.closest('[data-role-locate]');
    if (locate) {
      e.stopPropagation();
      const p = activeProject();
      const roleId = locate.dataset.roleLocate;
      const sessionId = p?.sessions?.[roleId];
      if (!p || !sessionId) { toast('这个角色还没有 DSH 会话', 'bad'); return; }
      locateDshSession(p, sessionId, roleSessionTitle(p, roleId)).then((ok) => {
        toast(ok ? '已定位到 DSH 会话' : 'DSH 未连接，或还没找到该会话', ok ? 'ok' : 'bad');
      });
      return;
    }
    const messageBtn = target.closest('[data-role-message]');
    if (messageBtn) {
      e.stopPropagation();
      openDispatchFrom(messageBtn.dataset.roleMessage);
      return;
    }
    const inboxBtn = target.closest('[data-role-inbox]');
    if (inboxBtn) {
      e.stopPropagation();
      openInboxFor(inboxBtn.dataset.roleInbox);
      return;
    }
    const row = target.closest('[data-role-session]');
    if (row) {
      e.stopPropagation();
      openRoleSessionModal(row.dataset.roleSession);
    }
  });

  // B-7009（P1）：点角色 chip 切换用量展示（清缓存 → 立即重取，≤2s 生效）
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    const chip = target.closest('[data-usage-role-pick]');
    if (!chip) return;
    e.preventDefault();
    const role = String(chip.getAttribute('data-usage-role-pick') || '');
    usageUi = { projectId: usageUi.projectId, role, at: 0, data: null };
    try { renderSessionUsage(activeProject()).catch(() => { /* 切角色失败不阻断 */ }); } catch { /* ignore */ }
  });

  // P0（Owner 0407）：用量「明细」展开/收起（默认折叠，避免长文把角色区挤没）
  document.addEventListener('click', (e) => {
    const t = e.target;
    if (!(t instanceof Element)) return;
    const btn = t.closest('[data-usage-detail-toggle]');
    if (!btn) return;
    e.preventDefault();
    const detail = document.querySelector('#session-usage [data-usage-detail]');
    const wrap = document.getElementById('session-usage-wrap');
    if (!detail) return;
    detail.hidden = !detail.hidden;
    if (wrap) wrap.classList.toggle('detail-open', !detail.hidden);
    btn.textContent = detail.hidden ? '明细' : '收起';
  });

  // 抽屉关闭
  bindPanelControls();
  bindDshRetryDelegation();

  // 六角色行支持键盘打开
  document.addEventListener('keydown', (e) => {
    if (e.key !== 'Enter' && e.key !== ' ') return;
    const row = e.target instanceof Element ? e.target.closest('.session-row[data-role-session]') : null;
    if (!row) return;
    e.preventDefault();
    openRoleSessionModal(row.dataset.roleSession);
  });

  // 空状态 / 通用入口
  document.addEventListener('click', (e) => {
    const target = e.target;
    if (!(target instanceof Element)) return;
    if (target.closest('[data-open-new-project]')) { e.preventDefault(); setWorkspacePop(false); openNewProject(); return; }
    if (target.closest('[data-open-task]')) { e.preventDefault(); openTaskModal(); return; }
    if (target.closest('[data-open-restore]')) { e.preventDefault(); setWorkspacePop(false); openRestoreModal(); return; }
    if (target.closest('[data-open-project-folder]')) { e.preventDefault(); openProjectFolder(); }
  });

  // 流程浮层
  $('#flow-launcher')?.addEventListener('click', () => setFlowPanel($('#flow-panel')?.hidden));
  $('#flow-close')?.addEventListener('click', () => setFlowPanel(false));
  bindFlowDrag();

  // 新手引导
  $('#ob-skip')?.addEventListener('click', () => closeGuide(true));
  $('#ob-prev')?.addEventListener('click', () => {
    if (guideStep > 0) { guideStep--; renderGuide(); }
  });
  $('#ob-next')?.addEventListener('click', () => {
    if (guideStep >= GUIDE_STEPS.length - 1) closeGuide(true);
    else { guideStep++; renderGuide(); }
  });

  // 键盘：Esc 依次关闭菜单 / 工作区浮层 / 抽屉 / 引导 / 流程
  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      const menu = $('#more-menu');
      if (menu && !menu.hidden) { setMoreMenu(false); $('#btn-more')?.focus(); return; }
      const pop = $('#workspace-pop');
      if (pop && !pop.hidden) { setWorkspacePop(false); $('#workspace-switch')?.focus(); return; }
      if (openDrawerName) { setDrawer(null); return; }
      const onboard = $('#onboard');
      if (onboard && !onboard.hidden) { closeGuide(true); return; }
      const panel = $('#flow-panel');
      if (panel && !panel.hidden) { setFlowPanel(false); return; }
      const boardPanel = $('#board-panel');
      if (boardPanel && !boardPanel.hidden) { closeBoardPanel(); return; }
    }
    const menu = $('#more-menu');
    if (menu && !menu.hidden && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      const buttons = $$('#more-menu button:not([disabled])');
      if (!buttons.length) return;
      e.preventDefault();
      const at = buttons.indexOf(document.activeElement);
      const next = e.key === 'ArrowDown'
        ? buttons[(at + 1 + buttons.length) % buttons.length]
        : buttons[(at - 1 + buttons.length) % buttons.length];
      next.focus();
    }
  });

  // 视窗变化：收菜单、夹住浮层、重排引导
  window.addEventListener('resize', () => {
    setMoreMenu(false);
    setWorkspacePop(false);
    clampFlowPanel();
    clampBoardPanel();
    const onboard = $('#onboard');
    if (onboard && !onboard.hidden) positionGuide();
  });

  // DSH webview 事件
  const view = $('#dsh-view');
  if (view) {
    // PM 13:45 诊断：导航计数/时间戳 + webview 控制台转发，用于判断是否我们自己 reload 风暴。
    view.addEventListener('did-start-loading', () => {
      dshViewLoad.starts += 1;
      dshViewLoad.loading = true;
      dshViewLoad.loadingSince = Date.now();
      try { console.log('[dsh-view] did-start-loading #' + dshViewLoad.starts + ' src=' + String(view.getAttribute('src') || '')); } catch { /* ignore */ }
    });
    view.addEventListener('did-stop-loading', () => {
      dshViewLoad.stops += 1;
      dshViewLoad.loading = false;
      try { console.log('[dsh-view] did-stop-loading #' + dshViewLoad.stops + ' starts=' + dshViewLoad.starts + ' elapsedMs=' + Math.max(0, Date.now() - dshViewLoad.loadingSince)); } catch { /* ignore */ }
      // A-07：地址在加载途中变化时，sync 会被 loading 闸挡掉；stop 后补一次同步。
      try {
        const base = String((state && state.dsh && state.dsh.baseUrl) || '');
        const current = String(view.getAttribute('src') || '');
        if (base && state?.dsh?.online && dshNormUrl(current) !== dshNormUrl(base)) syncDshViewWithStatus(state.dsh);
      } catch { /* ignore */ }
    });
    view.addEventListener('console-message', (e) => {
      try { console.log('[dsh-console] level=' + String(e.level) + ' msg=' + String(e.message || '').slice(0, 500)); } catch { /* ignore */ }
    });
    view.addEventListener('did-finish-load', async () => {
      // A-03：先校验 guest 实际 URL；旧页/about:blank 的迟到 finish 不得置 ready、不得采样。
      let loadedUrl = '';
      try { loadedUrl = String(view.getURL() || ''); } catch { loadedUrl = ''; }
      if (!loadedUrl || loadedUrl === 'about:blank') return;
      const expectedBase = String((state && state.dsh && state.dsh.baseUrl) || '');
      if (expectedBase && dshNormUrl(loadedUrl) !== dshNormUrl(expectedBase)) return;
      dshReady = true;
      dshViewFailed = false;
      dshViewError = null;
      if (state) renderDsh(state.dsh);
      // PM 13:58：DSH 进场页 bodyLen 在 0/39 间抖，单次采样会误判；改持续采样 10s，任一次 >0 即撤覆盖层。
      // 一旦成功隐藏，只有新 did-fail-load 才恢复（dshGuestBodyLen 保持 >0，不再被 0 覆盖）。
      const probeSeq = (dshBodyProbeSeq += 1);
      void (async () => {
        let blankStreak = 0;
        let sawBody = false;
        for (let i = 0; i < 20; i += 1) {
          await new Promise((resolve) => setTimeout(resolve, 500));
          if (probeSeq !== dshBodyProbeSeq) return;
          const probe = await dshGuestProbe();
          if (!probe) {
            // 主进程 probe 不可用时不阻塞：did-finish 本身已证明页面加载成功，按 1 字符处理
            dshGuestBodyLen = Math.max(1, dshGuestBodyLen);
            dshViewError = null;
            if (state) renderDsh(state.dsh);
            return;
          }
          const bodyLen = Number(probe.bodyLen) || 0;
          const text = String(probe.body || '');
          // PM 16:03（Owner）：**开机动画期间绝不做 cookie 重试/重载**。
          // DSH 的 splash 是 canvas 动画、正文可能为 0；旧顺序先判 body=0 再判 boot，
          // 会在动画播放中触发重载 → Owner 看到的就是"开机动画没了/被打断"。
          if (probe.boot) {
            blankStreak = 0;
            // 动画页本身有正文（正在启动…/点击画面跳过）时也算「页面已出」：先隐藏覆盖层让 Owner 看动画，
            // 继续等动画自然播完；绝不点跳过、绝不因 body=0 重载。
            if (bodyLen > 0) {
              sawBody = true;
              dshGuestBodyLen = bodyLen;
              dshViewError = null;
              if (state) renderDsh(state.dsh);
            }
            await new Promise((resolve) => setTimeout(resolve, 700));
            continue;
          }
          if (!bodyLen) {
            // body=0 且**不在**开机动画中 → 视为加载异常，触发 cookie 重装重试自愈。
            blankStreak += 1;
            if (blankStreak >= 3) {
              blankStreak = 0;
              void retryDshCookieOnce('blank');
            }
            continue;
          }
          blankStreak = 0;
          if (/authentication required|unauthorized|\b401\b/i.test(text)) {
            void retryDshCookieOnce('blank-401');
            continue;
          }
          dshGuestBodyLen = bodyLen;
          dshViewError = null;
          sawBody = true;
          // PM 19:15：只有**真实界面**（正文 >1000 字）才重置预算；401/错误页正文很短，
          // 旧实现把短正文也当成功 → 预算反复重置 → 无限重载。
          if (bodyLen > 1000) {
            dshViewLoad.autoReloads = {};
            dshCookieRetry.at = 0;
            dshCookieRetry.url = '';
            dshCookieRetry.count = 0;
          }
          if (state) renderDsh(state.dsh);
          return;
        }
        if (probeSeq === dshBodyProbeSeq) {
          // PM 16:05（Owner）：**不再用探针判定把界面判成"空白"**——探针在本机读 guest 不可靠，
          // 会把已经正常显示的原生 DSH 界面判成 DSH_BLANK 并盖上错误层。这里只记日志、不设错误态、不画覆盖层。
          try { console.log('[dsh-view] probe 10s 仍未读到正文（仅日志，不遮挡界面）'); } catch { /* ignore */ }
        }
      })();
      if (pendingDshFocus) await flushPendingDshFocus();
      else {
        const p = activeProject();
        if (p) await focusDshWorkspace(p, { notify: false });
      }
    });
    view.addEventListener('did-fail-load', (e) => {
      try { console.warn('[dsh-view] did-fail-load code=' + String(e.errorCode) + ' desc=' + String(e.errorDescription || '') + ' mainFrame=' + String(e.isMainFrame) + ' url=' + String(e.validatedURL || view.getAttribute('src') || '')); } catch { /* ignore */ }
      if (e.errorCode === -3) { try { console.log('[dsh-view] ERR_ABORTED(-3) 不触发重试（DSH 自己导航/中止）'); } catch { /* ignore */ } return; }
      if (e.isMainFrame === false) return;
      dshReady = false;
      dshViewFailed = true;
      dshGuestBodyLen = 0;
      dshViewError = {
        url: String(e.validatedURL || view.getAttribute('src') || (state?.dsh?.baseUrl) || ''),
        code: e.errorCode,
        description: String(e.errorDescription || '')
      };
      try { console.warn('[dsh-view] did-fail-load url=' + dshViewError.url + ' code=' + dshViewError.code + ' ' + dshViewError.description); } catch { /* ignore */ }
      renderDsh(state?.dsh);
      void retryDshCookieOnce('did-fail');
    });
  }

  // 快捷键：Ctrl/⌘+R 刷新（不整页重载），F1 重开引导
  document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && (e.key === 'r' || e.key === 'R')) {
      e.preventDefault();
      refreshAll({ toast: true });
      return;
    }
    if (e.key === 'F1') {
      e.preventDefault();
      showGuide(true);
      return;
    }
    // R-2a69：引导打开时支持键盘翻页（→/Enter 下一步，← 上一步，Esc 关闭），
    // 鼠标按钮不变；也给自动化截图一个稳定入口。
    const guideMask = $('#onboard');
    if (guideMask && !guideMask.hidden) {
      if (e.key === 'ArrowRight' || e.key === 'Enter') {
        e.preventDefault();
        const next = $('#ob-next');
        if (next) next.click();
        return;
      }
      if (e.key === 'ArrowLeft') {
        e.preventDefault();
        const prev = $('#ob-prev');
        if (prev && !prev.disabled) prev.click();
        return;
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        showGuide(false);
        return;
      }
    }
  });

  // 侧栏显示状态
  let sidebarPref = 'shown';
  try { sidebarPref = localStorage.getItem('awb.sidebar') || 'shown'; } catch { /* ignore */ }
  setSidebarHidden(sidebarPref === 'hidden');
}

function teamModeRoleMarkup(mode, project) {
  const def = TEAM_MODES[normalizeTeamMode(mode)] || TEAM_MODES.full;
  return def.roleIds.map((id) => {
    const role = roleById(id);
    const has = Boolean((project?.sessions || {})[id]);
    return `<span class="team-role-chip" style="--role-color:${esc(role.color)}"><i aria-hidden="true"></i>${esc(role.name)}${has ? '<em>已有</em>' : ''}</span>`;
  }).join('');
}

/** 建团队弹窗：先选模式，再调用真实 dsh:provision；不在这里伪造会话。 */
function openTeamBuildModal(project) {
  const p = project || activeProject();
  if (!p) { openNewProject(); return null; }
  let picked = projectTeamMode(p);
  // Owner 2026-11-18：fast（4 人）暂不可用 → 已存 fast 的项目也先回落到 full，避免「不可点却仍是选中态」。
  if (TEAM_MODES[picked] && TEAM_MODES[picked].unavailable) picked = 'full';
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <p class="team-mode-intro">选择团队模式。模式会保存到项目；以后可再次打开「建团队」切换。</p>
    <div class="team-mode-grid">
      ${Object.values(TEAM_MODES).map((def) => {
    const off = Boolean(def.unavailable);
    return `<button type="button" class="team-mode-card${picked === def.id && !off ? ' active' : ''}${off ? ' is-unavailable' : ''}" data-team-mode-pick="${def.id}" aria-pressed="${picked === def.id && !off ? 'true' : 'false'}"${off ? ' disabled aria-disabled="true"' : ''}>
        <span class="team-mode-card-top"><b>${esc(def.label)}</b><span class="badge">${def.roleIds.length} 人</span></span>
        ${off ? `<span class="team-mode-unavailable" data-team-mode-unavailable="${def.id}">${esc(def.unavailable)}</span>` : ''}
        <span class="team-mode-note">${esc(def.note)}</span>
        <span class="team-mode-roles">${teamModeRoleMarkup(def.id, p)}</span>
        ${def.hidden.length ? `<span class="team-mode-hidden">隐藏：${def.hidden.map((id) => esc(roleById(id).name)).join('、')}</span>` : '<span class="team-mode-hidden">六个角色都显示</span>'}
      </button>`;
  }).join('')}
    </div>
    <p class="team-mode-current">当前项目：<b>${esc(p.name)}</b> · 当前模式：<b id="team-mode-current-label">${esc(teamModeLabel(p))}</b><span id="team-mode-save-state" class="team-mode-save-state">（当前）</span></p>
    <p class="team-mode-tip">快速模式由后端按 project.teamMode=fast 执行：只建 PM / 需求分析师 / 程序员A / 测试人员 4 个会话，需求走分析师评审，Owner 之后增加技术评审。已有会话不会被删除；DSH 不可用时建团队会真实报错，界面不伪造会话。</p>
    <div class="modal-error"></div>`;
  const label = wrap.querySelector('#team-mode-current-label');
  const saveState = wrap.querySelector('#team-mode-save-state');
  const savedMode = projectTeamMode(p);
  const syncPick = () => {
    wrap.querySelectorAll('[data-team-mode-pick]').forEach((card) => {
      const on = card.dataset.teamModePick === picked;
      card.classList.toggle('active', on);
      card.setAttribute('aria-pressed', on ? 'true' : 'false');
    });
    if (label) label.textContent = teamModeLabel({ teamMode: picked });
    if (saveState) {
      const unsaved = picked !== savedMode;
      saveState.textContent = unsaved ? '（未保存，点「开始建团队」生效）' : '（当前）';
      saveState.classList.toggle('pending', unsaved);
    }
  };
  wrap.addEventListener('click', (e) => {
    const card = e.target instanceof Element ? e.target.closest('[data-team-mode-pick]') : null;
    if (!card) return;
    // Owner 2026-11-18：不可用模式（disabled）展示但不可选——双击穿透/程序化点击也当无效。
    if (card.disabled || card.getAttribute('aria-disabled') === 'true') return;
    picked = normalizeTeamMode(card.dataset.teamModePick);
    syncPick();
  });
  const dlg = openModal({
    title: '建团队',
    subtitle: `${p.name} · 选择完整 6 人或快速 4 人`,
    icon: '◈',
    body: wrap,
    width: 660,
    actions: [
      { label: '取消', kind: 'ghost', onClick: ({ close }) => close() },
      { label: '开始建团队', kind: 'primary', onClick: async ({ close, error }) => {
        try {
          await provisionTeamForMode(picked);
          close();
        } catch (e) { error(e.message); }
      } }
    ]
  });
  syncPick();
  return dlg;
}

/** 真实建团队：所有模式都走 dsh:provision；模式只是显示口径。 */
async function provisionTeamForMode(mode) {
  const p = activeProject();
  if (!p) throw new Error('先选择工作区');
  if (!window.workbench || typeof window.workbench.dshProvision !== 'function') {
    throw new Error('preload 没有 dsh:provision：不能建团队，也不会伪造会话');
  }
  const desired = normalizeTeamMode(mode);
  // 先按模式补齐项目结构/协作准则/项目.json，再建会话；否则会出现“4 个会话 + 6 角色目录 + 六角色准则”的混搭。
  if (typeof window.workbench.teamEnsureProject === 'function') {
    const ensured = await window.workbench.teamEnsureProject({ projectId: p.id, teamMode: desired });
    if (ensured && ensured.ok === false) {
      throw new Error(ensured.message || ensured.code || '团队项目结构同步失败');
    }
  }
  const r = await window.workbench.dshProvision({ projectId: p.id, teamMode: desired });
  const warning = Boolean(r && r.ok === false);
  if (warning && r.code !== 'SESSION_BLANK') {
    throw new Error(r.message || r.code || '建团队失败');
  }
  await applyState(r);
  const next = activeProject();
  let savedLabel = '';
  if (next) {
    saveProjectTeamMode(next, desired);
    savedLabel = teamModeLabel(next);
  }
  render();
  const created = Array.isArray(r?.created) ? r.created.length : 0;
  const seeds = Array.isArray(r?.seeds) ? r.seeds.filter((s) => s && s.ok !== false).length : 0;
  const warnings = Array.isArray(r?.warnings) ? r.warnings : [];
  const parts = [];
  if (created > 0) parts.push(`新建 ${created} 个角色会话`);
  if (seeds > 0) parts.push(`补发 ${seeds} 条首次就位`);
  if (!parts.length) parts.push(r?.reused ? '角色会话已存在（已核验）' : '角色会话已存在');
  // “已记录”只在 provision 成功且模式确实写回项目后出现；选择卡片本身只算未保存的选择。
  parts.push(savedLabel ? `团队模式已记录：${savedLabel}` : `模式未写回：${teamModeLabel({ teamMode: desired })}`);
  if (warning && r.code === 'SESSION_BLANK') parts.push('仍有空白会话，可再点一次补发');
  if (warnings.length) parts.push(`${warnings.length} 条非致命告警`);
  toast(parts.join('；'), (warning || warnings.length) ? 'bad' : 'ok');
  const reloaded = (created > 0 || seeds > 0) ? reloadDshFor(next, 'provision') : false;
  await loadDshTeamStatus({ force: true });
  if (next && !reloaded) await focusDshWorkspace(next, { notify: false });
  return r;
}

async function startTeam() {
  const p = activeProject();
  if (!p) { openNewProject(); return; }
  openTeamBuildModal(p);
}

function bindFlowDrag() {
  const panel = $('#flow-panel');
  const head = $('#flow-drag');
  if (!panel || !head) return;
  let drag = null;
  head.addEventListener('pointerdown', (e) => {
    if (e.target.closest('button')) return;
    const r = panel.getBoundingClientRect();
    drag = { x: e.clientX, y: e.clientY, left: r.left, top: r.top };
    panel.classList.add('dragging');
    try { head.setPointerCapture(e.pointerId); } catch { /* ignore */ }
  });
  head.addEventListener('pointermove', (e) => {
    if (!drag) return;
    const r = panel.getBoundingClientRect();
    const left = Math.max(6, Math.min(window.innerWidth - r.width - 6, drag.left + e.clientX - drag.x));
    const top = Math.max(6, Math.min(window.innerHeight - r.height - 6, drag.top + e.clientY - drag.y));
    panel.style.left = left + 'px';
    panel.style.top = top + 'px';
    panel.style.right = 'auto';
    panel.style.bottom = 'auto';
  });
  const stop = () => { drag = null; panel.classList.remove('dragging'); };
  head.addEventListener('pointerup', stop);
  head.addEventListener('pointercancel', stop);
}

function clampFlowPanel() {
  const panel = $('#flow-panel');
  if (!panel || panel.hidden || !panel.style.left) return;
  const r = panel.getBoundingClientRect();
  panel.style.left = Math.max(6, Math.min(window.innerWidth - r.width - 6, r.left)) + 'px';
  panel.style.top = Math.max(6, Math.min(window.innerHeight - r.height - 6, r.top)) + 'px';
}

/* ── 启动 ─────────────────────────────────────────────── */

(async function boot() {
  // R-fe90：URL(?theme=) > localStorage['awb.theme'] > 默认 tech-dark；
  // ?theme= 只影响本次加载、**不持久化**（增补卷-fe90-1 §一.3）；同值不重复写 storage。
  const bootResolved = themeResolve({ storageValue: themeReadStorage(), search: location.search });
  applyThemeState(bootResolved, { persist: bootResolved.source !== 'url' });
  try { /* P0 批（3052）：只读视觉探针——断言读数值而不是只比截图；不写任何状态。 */
/* R-c72a F1：交互预算探针（只记录，不改业务）。mark/measure 用 performance.now，report 走 core 统一判定 + 落盘。
 * 批3（T-20261116-221117-3f77）两条硬口径：
 *  ① 已登记桶只有 click/list/modal/scrollFrame 四个；未登记 case 一律 {ok:false,code:"BAD_CASE"}——
 *     不再有「前缀别名兜底成 click」，否则 list 样本会混进 AC1 的 click 桶并把 p95 带偏（正文 AC2）。
 *  ③ measure 第三参 visibleChange{selector,from,to,atMs}（正文 AC1）；click 桶缺该字段的样本不计入有效样本。
 *     时延一律取 visibleChange.atMs（毫秒整数）：调用方没给 atMs 时由 measure 用本次实测毫秒补上。 */
const AWB_UI_PERF = { marks: new Map(), samples: { click: [], list: [], modal: [], scrollFrame: [] } };
const AWB_UI_PERF_CASES = ["click", "list", "modal", "scrollFrame"];
function awbUiPerfBucket(name) {
  const key = String(name || "").split(":")[0];
  return AWB_UI_PERF_CASES.indexOf(key) >= 0 ? key : null;
}
function awbUiPerfVisible(visibleChange) {
  if (!visibleChange || typeof visibleChange !== "object") return null;
  const selector = String(visibleChange.selector || "");
  const from = visibleChange.from === undefined || visibleChange.from === null ? "" : String(visibleChange.from);
  const to = visibleChange.to === undefined || visibleChange.to === null ? "" : String(visibleChange.to);
  if (!selector || !from || !to) return null;
  const at = Number(visibleChange.atMs);
  return { selector, from, to, atMs: Number.isFinite(at) && at >= 0 ? Math.round(at) : null };
}
// 有效样本：click 桶必须带 visibleChange{selector,from,to,atMs}（AC1）；其余桶只要求是有限非负数值。
function awbUiPerfSampleMs(caseKey, sample) {
  if (!sample || typeof sample !== "object") return null;
  const vc = sample.visibleChange;
  if (caseKey === "click") {
    if (!vc || !vc.selector || !vc.from || !vc.to || !Number.isFinite(Number(vc.atMs))) return null;
    return Number(vc.atMs);
  }
  const ms = Number(sample.ms);
  return Number.isFinite(ms) && ms >= 0 ? ms : null;
}
window.__uiPerf = {
  mark(name) { try { AWB_UI_PERF.marks.set(String(name), performance.now()); } catch (e) {} return true; },
  // 第三参是可选的 visibleChange（不写进签名，保持既有测试锚点 measure(name, startMark) 不变）。
  measure(name, startMark) {
    try {
      const caseKey = awbUiPerfBucket(name);
      if (!caseKey) return null; // 未登记 case 不记样本：调用方必须使用 click/list/modal/scrollFrame
      const key = String(startMark || name);
      if (!AWB_UI_PERF.marks.has(key)) return null;
      const ms = Math.round((performance.now() - AWB_UI_PERF.marks.get(key)) * 1000) / 1000;
      let visibleChange = null;
      if (arguments.length >= 3) {
        visibleChange = awbUiPerfVisible(arguments[2]);
        if (visibleChange && visibleChange.atMs === null) visibleChange.atMs = Math.round(ms);
      }
      AWB_UI_PERF.samples[caseKey].push(visibleChange ? { ms, visibleChange } : { ms });
      return ms;
    } catch (e) { return null; }
  },
  // 只读取数口（给自检/证据核对用，不写盘）：返回该桶样本副本；未登记 case 返回 null。
  samples(caseName) {
    const caseKey = awbUiPerfBucket(caseName);
    return caseKey ? AWB_UI_PERF.samples[caseKey].slice() : null;
  },
  async report(caseName, opts) {
    try {
      if (!window.uiPerfCore) return { ok: false, code: "PROBE_UNAVAILABLE", case: String(caseName || "") };
      const caseKey = awbUiPerfBucket(caseName);
      if (!caseKey) return { ok: false, code: "BAD_CASE", case: String(caseName || ""), allowed: AWB_UI_PERF_CASES.slice() };
      const hintProject = opts && opts.project ? String(opts.project) : "";
      const raw = AWB_UI_PERF.samples[caseKey];
      const valid = [];
      for (const sample of raw) {
        const ms = awbUiPerfSampleMs(caseKey, sample);
        if (ms !== null) valid.push(ms);
      }
      const sum = window.uiPerfCore.summarize(caseKey, valid, opts || {});
      const line = { at: new Date().toISOString(), project: "", case: sum.case, samples: sum.samples, p50: sum.p50, p95: sum.p95, p99: sum.p99, budget: sum.budget, verdict: sum.verdict };
      let written = false;
      try {
        if (window.workbench && typeof window.workbench.uiPerfAppend === "function") {
          const res = await window.workbench.uiPerfAppend({ ...line, project: hintProject });
          written = Boolean(res && res.ok);
          if (res && res.project) line.project = String(res.project);
        }
      } catch (e) { written = false; }
      return { ok: true, written, line, verdict: sum.verdict, probe: "ok", validSamples: valid.length, invalidSamples: raw.length - valid.length };
    } catch (e) { return { ok: false, code: "PROBE_UNAVAILABLE", case: String(caseName || "") }; }
  }
};
window.__themeLook = function () {
  const root = getComputedStyle(document.documentElement);
  const pick = (sel) => { const el = document.querySelector(sel); if (!el) return null; const s = getComputedStyle(el); return { background: s.backgroundColor, backgroundImage: s.backgroundImage, color: s.color, boxShadow: s.boxShadow, backdropFilter: s.backdropFilter || "none" }; };
  const alphaOf = (v) => { const m = /rgba?\(([^)]+)\)/.exec(String(v || "")); if (!m) return 1; const parts = m[1].split(","); return parts.length === 4 ? Number(parts[3]) : 1; };
  const panel = pick(".panel") || {};
  const targets = [".brand-mark", ".primary", ".panel", ".tab.active", ".mm-sub button[aria-checked=\"true\"]"];
  const glowCount = targets.filter((sel) => { const el = document.querySelector(sel); if (!el) return false; return getComputedStyle(el).boxShadow !== "none"; }).length;
  const state = typeof window.__themeState === "function" ? window.__themeState() : {};
  return {
    themeId: state.themeId || "", style: state.style || "", theme: state.theme || "",
    accent: root.getPropertyValue("--theme-accent").trim(), accent2: root.getPropertyValue("--theme-accent-2").trim(),
    glow: root.getPropertyValue("--theme-glow").trim(),
    panelAlpha: alphaOf(root.getPropertyValue("--panel").trim() || panel.background), panelToken: root.getPropertyValue("--panel").trim(), panelBackground: panel.background || "",
    panelBackdrop: panel.backdropFilter || "none",
    brandBackground: (pick(".brand-mark") || {}).backgroundImage || "", brandHasGlow: String((pick(".brand-mark") || {}).boxShadow || "").includes("px"),
    primaryBackground: (pick(".primary") || {}).backgroundImage || "", glowCount,
    bgLayers: (function () { try { var bg = String(getComputedStyle(document.body, "::before").backgroundImage || ""); if (!bg || bg === "none") return 0; var depth = 0, layers = 1; for (var i = 0; i < bg.length; i += 1) { var ch = bg.charAt(i); if (ch === "(") depth += 1; else if (ch === ")") depth -= 1; else if (ch === "," && depth === 0) layers += 1; } return layers; } catch (e) { return 0; } })(),
    bgImage: (function () { try { return String(getComputedStyle(document.body, "::before").backgroundImage).slice(0, 240); } catch (e) { return ""; } })(),
    bgSize: (function () { try { return String(getComputedStyle(document.body, "::before").backgroundSize); } catch (e) { return ""; } })(),
    bgAnimation: (function () { try { return String(getComputedStyle(document.body, "::before").animationDuration || "none"); } catch (e) { return "none"; } })(),
    hoverTransition: (function () { try { const el = document.querySelector(".primary"); return el ? getComputedStyle(el).transitionDuration : ""; } catch (e) { return ""; } })(),
    hoverTiming: (function () { try { const el = document.querySelector(".primary"); return el ? getComputedStyle(el).transitionTimingFunction : ""; } catch (e) { return ""; } })(),
    activeScale: (function () { try { var out = null; var sheets = document.styleSheets; for (var i = 0; i < sheets.length; i += 1) { var rules; try { rules = sheets[i].cssRules; } catch (e) { continue; } for (var k = 0; k < rules.length; k += 1) { var sel = String(rules[k].selectorText || ""); if (/:active/.test(sel) && /scale\(/.test(String(rules[k].style && rules[k].style.transform || ""))) { var m = /scale\(([0-9.]+)\)/.exec(String(rules[k].style.transform)); if (m && String(sel).indexOf(".primary") >= 0) out = Number(m[1]); } } } return out; } catch (e) { return null; } })(),
    bgFilter: (function () { try { return String(getComputedStyle(document.body, "::before").filter || "none"); } catch (e) { return "none"; } })(),
  };
};
window.__themeFx = function () {
  if (window.AWB_FX && typeof window.AWB_FX.describe === 'function') return window.AWB_FX.describe();
  return { particleCount: 0, rMin: 0, rMax: 0, alphaMin: 0, alphaMax: 0, composite: '', canvas: false, running: false, idle: false, effectLevel: '', fx: null };
};
window.__themeState = themeState; window.__themeProbe = themeProbe; } catch { /* ignore */ }
  // R-fe90 F-7：手工降级档来自主进程 ui.effectLevel；读不到按 full（不阻断界面）。
  try {
    const eff = (window.workbench && typeof window.workbench.themeEffectLevel === 'function')
      ? await window.workbench.themeEffectLevel()
      : null;
    if (eff && (eff.level === 'reduced' || eff.level === 'off')) {
      document.documentElement.setAttribute('data-effect-level', eff.level);
    }
  } catch { /* ignore */ }
  // R-fe90 F7：手工档生效后立刻让特效层按新档位重排（否则要等下一次换主题才关粒子）。
  try { awbThemeFxSync(); } catch { /* 特效异常不影响界面 */ }
  // R-8947：初始化菜单选中态，并接收主进程广播（多窗口/看板/webview 同档，AC9）。
  try {
    paintEffectMenu();
    window.addEventListener('awb:effect-level', (ev) => {
      const opt = ev && ev.detail && ev.detail.option;
      if (opt) applyEffectOption(opt);
    });
  } catch { /* ignore */ }
  loadInboxSeen();
  renderBridgeAlert();
  // B-4fdd：先把 DSH 状态检查（握手）发出去，与首屏渲染并行——它原来排在 bind+refresh 之后，
  // 冷启动白等 2-4s 才发第一个握手请求。
  const dshInitPromise = (window.workbench && typeof window.workbench.dshStatus === 'function')
    ? initDsh().catch(() => null)
    : Promise.resolve(null);
  try { requestAnimationFrame(() => requestAnimationFrame(() => startupMarkBridge('interactive'))); } catch { /* ignore */ }
  // B-4fdd：首屏只依赖「state 拉到 + render 一帧」，不等 DOM 绑定；绑定随后补上（静态 DOM，不依赖 state）。
  await refresh();
  warnStore();
  // B-231006-b81a：bind() 任何一块抛错都不许掐断 refresh（否则整页按钮静默失效、卡片停在占位）；
  // 抽屉关闭/入口另走独立块兜底绑定，保证单个初始化失败时三个 × 仍可点。
  bindBlock('bind', bind);
  bindPanelControls();
  bindDshRetryDelegation();
  bindDshStatusPush();
  bindPanelOpeners();
  bindCriticalControls();
  if (!window.workbench) {
    renderBridgeAlert();
    return;
  }
  await dshInitPromise;
  await tickMetrics();
  // R4 结论：保留 + 降级门 + 重合入下一帧——指标 2s 只读 IPC；隐藏/后台暂停（gate.js），同 key 300ms 合并。
  setInterval(r4Coalesce(r4Gate(tickMetrics), 300, 'metrics'), 2000);
  // 流程图/项目面板打开时轮询工作流真相（只读，5 秒节流）；隐藏暂停，失败按 2s/5s/10s 退避。
  // R4 结论：保留 + 降级门 + 300ms 合并（flowRefreshTick 内部已有 5s 节流与隐藏暂停，这里再兜一层）。
  setInterval(r4Coalesce(flowRefreshTick, 300, 'flow'), 1000);
  // B-405f：会话映射自动跟随（rotate/换人后 5 秒内刷新成员列表与计数，不用重启）。
  startRosterWatch();
  // 团队台打开时定期复核会话（只读）；平时不轮询，避免打扰 DSH。
  // R4 结论：保留 + 降级门——45s 只在团队台打开且在线时拉；隐藏/后台暂停。
  setInterval(r4Gate(() => {
    if (!state || !state.dsh || !state.dsh.online) return;
    if (openDrawerName !== 'team') return;
    loadDshTeamStatus({ force: true });
  }), 45000);

  // DSH 就是主画面：不再按旧 awb.mode 在“团队工作台 / DSH”之间交换场景。
  showDshView(true);
  const p = activeProject();
  if (p) {
    await focusDshWorkspace(p, { notify: false });
    await loadDshTeamStatus({ force: true });
  }
  // 团队/DSH 工作区清单与旧看板摘要：只读，失败不影响主画面。
  loadWorkspaces();
  loadTeamStatus();
  // Owner 不自动弹窗：首屏只显示状态与入口，避免打断 DSH 主画面。
})();

// B-2e5 AC4：真源条/证据区的提示项可点直达（文档待补→缺文档清单；账本分叉→证据区；哈希→哈希详情）。
// 用事件委托只绑一次，避免每次渲染重复绑定。
if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', bindTruthFixLinks, { once: true });
} else {
  bindTruthFixLinks();
}

function bindTruthFixLinks() {
  document.addEventListener('click', (event) => {
    const node = event.target && event.target.closest ? event.target.closest('[data-legacy-fix]') : null;
    if (!node) return;
    const kind = String(node.getAttribute('data-legacy-fix') || '');
    if (!kind) return;
    event.preventDefault();
    if (kind === 'docs') {
      const target = document.getElementById('missing-list');
      if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center' });
      if (typeof toast === 'function') toast('缺文档清单：看项目面板「必读与目录」页的 #missing-list（点到具体缺项）', 'warn');
      return;
    }
    if (kind === 'ledger') {
      const target = document.querySelector('.legacy-evidence-checks') || document.querySelector('.legacy-evidence');
      if (target && target.scrollIntoView) target.scrollIntoView({ block: 'center' });
      if (typeof toast === 'function') toast(node.getAttribute('title') || '账本分叉：工作流.json 与旧 任务/ 状态不一致', 'warn');
      return;
    }
    // hash 等其它：滚到证据区
    const checks = document.querySelector('.legacy-evidence-checks');
    if (checks && checks.scrollIntoView) checks.scrollIntoView({ block: 'center' });
    if (typeof toast === 'function') toast(node.getAttribute('title') || '看证据区的哈希详情', 'warn');
  });
}


if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { bindDecisionFloat(); bindDecisionAutoRefresh(); bindAutoAcceptRefresh(); }, { once: true });
} else {
  bindDecisionFloat();
  bindDecisionAutoRefresh();
  bindAutoAcceptRefresh();
}
