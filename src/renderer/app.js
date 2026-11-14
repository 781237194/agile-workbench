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
let openDrawerName = null;
// boot 过期后要自动重绘，把“已读全/可推进”降级；只用一个定时器，换项目/重新 boot 时重置。
let bootExpiryTimer = null;

const fileUi = { projectId: null, expanded: new Set(), data: null };
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

const THEME_NAME = { dark: '暗金', light: '暖白' };
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
    note: '只显示 PM / 需求分析师 / 程序员A / 测试人员；产品设计师与高级程序员B 隐藏。'
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
  { key: 'rules', no: '1', label: '项目铁律', note: '每轮第一件：底线、红线、失败即停' },
  { key: 'info', no: '2', label: '项目信息', note: '目标 / 场景 / 交付 / 边界' },
  { key: 'card', no: '3', label: '角色卡', note: '六角色各自的角色卡.md' },
  { key: 'others', no: '4', label: '其他人文档', note: '其他角色目录 / 文件索引' }
];
const LEGACY_PROJECT_DOCS = [
  { key: 'rules', rel: '项目铁律.md', label: '项目铁律', mark: '律', note: '每轮必读；项目目录缺失时旧工具会回退团队根' },
  { key: 'info', rel: '项目信息.md', label: '项目信息', mark: '息', note: 'PM 先填写；未写清楚前 PM 不叫其他角色' },
  { key: 'index', rel: '项目索引.md', label: '项目索引', mark: '引', note: '先读索引再找文件；不跳过索引直接 glob/grep' },
  { key: 'overview', rel: '需求/00-需求总览.md', label: '需求总览', mark: '求', note: '本轮需求总览；缺它旧 boot 会判必读不完整' },
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
  ownerConfirmations: Object.create(null),
  // 旧协议提案只读镜像：直接读 team.mjs 的 提案/，不再要求先手动 show。
  legacyProposals: [],
  proposalsProjectId: null,
  proposalsAt: 0,
  proposalsLoading: false
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

function toast(message, kind = '') {
  const el = $('#toast');
  if (!el) return;
  el.textContent = modeCopyText(humanError(message));
  el.className = 'toast show' + (kind ? ' ' + kind : '');
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    el.className = 'toast' + (kind ? ' ' + kind : '');
  }, kind === 'bad' || kind === 'warn' ? 4200 : 2600);
}

function currentTheme() {
  return document.documentElement.getAttribute('data-theme') === 'light' ? 'light' : 'dark';
}

function applyTheme(mode) {
  const theme = mode === 'light' ? 'light' : 'dark';
  document.documentElement.setAttribute('data-theme', theme);
  try { localStorage.setItem('awb.theme', theme); } catch { /* ignore */ }
  syncThemeUi();
  // 独立看板窗口与内嵌 iframe 不继承外壳变量：切主题时同步过去，避免“先黑后白”。
  try {
    if (window.workbench && typeof window.workbench.boardTheme === 'function') {
      window.workbench.boardTheme({ theme }).catch(() => {});
    }
  } catch { /* 看板未打开时忽略 */ }
  if (typeof boardUi !== 'undefined' && boardUi && boardUi.framePath) loadBoardFrame(boardUi.framePath);
}

function syncThemeUi() {
  const theme = currentTheme();
  const next = theme === 'dark' ? 'light' : 'dark';
  const btn = $('#btn-theme');
  if (btn) {
    btn.innerHTML = theme === 'dark' ? ICON_SUN : ICON_MOON;
    btn.title = `当前：${THEME_NAME[theme]}，点击切换为${THEME_NAME[next]}`;
    btn.setAttribute('aria-label', btn.title);
    btn.setAttribute('aria-pressed', String(theme === 'light'));
  }
  const label = $('#more-menu [data-more="theme"] .mm-text');
  if (label) label.textContent = `外观：${THEME_NAME[theme]}（点击切${THEME_NAME[next]}）`;
}

function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  applyTheme(next);
  toast(`已切换为「${THEME_NAME[next]}」主题`, 'ok');
}

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
  return teamRoles(project).map((role) => ({
    role,
    sessionId: sessions[role.id] || null
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
  if (Array.isArray(live.items) && live.items.length) {
    return live.items.filter((item) => ids.has(item.role) && item.sessionId && item.exists && item.inWorkspace && !item.blank && !item.archived).length;
  }
  // 后端 ready 是六角色总数；快速模式只在没有逐角色清单时才退回它，并拒绝把隐藏角色算进来。
  if (typeof live.ready === 'number' && !isQuickTeam(project)) return live.ready;
  return null;
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
  if (live.blank) return { cls: 'blank', text: '待启动', title: '会话还没有第一轮对话（DSH 左侧可能不显示）；点「建团队」补发就位' };
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
  if (live.blank) return { key: 'blank', label: '存在·空会话', title: '会话存在，但还没有第一轮对话；DSH 左侧可能不显示' };
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

async function refresh() {
  if (!window.workbench) {
    renderBridgeAlert();
    toast('preload 没有加载，工作台 API 不可用', 'bad');
    return;
  }
  renderBridgeAlert();
  try {
    state = await window.workbench.state();
    hydrateTeamModes();
    render();
    const current = activeProject();
    if (current) loadLegacyDocs(legacyUi.projectId === current.id);
  } catch (e) {
    toast('读取失败：' + e.message, 'bad');
  }
}

async function applyState(next) {
  if (next && next.state) state = next.state;
  else await refresh();
  hydrateTeamModes();
  render();
  warnStore();
}

/* ── 浮层抽屉：项目面板 / 团队台 ─────────────────────── */

function setDrawer(name, opts = {}) {
  const project = $('#project-drawer');
  const team = $('#team-drawer');
  const mask = $('#drawer-mask');
  if (!project || !team) return;
  const next = name === 'project' || name === 'team' ? name : null;
  const changed = openDrawerName !== next;
  openDrawerName = next;
  project.hidden = next !== 'project';
  team.hidden = next !== 'team';
  if (mask) mask.hidden = !next;
  document.body.classList.toggle('drawer-open', Boolean(next));
  if (next === 'project') {
    if (changed && !opts.keepScroll) $('#project-drawer .drawer-scroll')?.scrollTo({ top: 0 });
    loadDshTeamStatus();
    loadLegacyDocs();
  }
  if (next === 'team') {
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
  if (name === 'proposals') renderProposals();
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
  if (versionEl) versionEl.textContent = 'v' + state.version;
  renderSidebar();
  renderSessions();
  renderHeader();
  renderTruthStrip();
  renderOverview();
  renderFlow();
  renderRoles();
  renderTeam();
  renderDsh(state.dsh);
  renderStoreFlag();
  renderWorkspacePopover();
  renderBoardPanel();
  renderLaunchers();
  syncThemeUi();
  // 旧流程面板：换项目已在上方清空缓存，这里只发一次文件读取；同一项目只重绘。
  if (current) {
    if (switchedProjects) loadLegacyDocs();
    else renderLegacyPanels();
  }
  showTab(activeTab, { fromRender: true });
  renderModeCopyAnchors();
  applyTeamModeCopy(document.body);
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
  if (name) name.textContent = p ? p.name : '未选择工作区';
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
    meta.textContent = p ? parts.join(' · ') : 'DSH workspace · 待建团队';
    meta.title = p && ws.boundAt ? `工作区绑定于 ${fmtTime(ws.boundAt)}` : '';
  }
  if (warnEl) {
    const ws = (p && p.workspace) || {};
    const live = p ? liveFor(p) : null;
    const notes = [];
    let bad = false;
    if (p && p.exists === false) { notes.push('项目目录不存在或被移动，DSH 工作区无法绑定。'); bad = true; }
    if (p && ws.lastError && ws.lastError.code) {
      notes.push(`DSH 工作区绑定失败：${ws.lastError.code}${ws.lastError.message ? ' · ' + ws.lastError.message : ''}（切项目或建团队会自动重试）`);
      bad = true;
    }
    // e29f F-4：额外会话（含同一角色多会话）只由侧栏统计那一处统一计数显示，
    // 这里不再重复报数字，避免同一时刻两处数字不同。
    if (live && live.error) { notes.push('DSH 核验失败：' + live.error); bad = true; }
    if (!p) notes.length = 0;
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
let sessionUsageCache = { projectId: '', at: 0, data: null };
async function renderSessionUsage(p) {
  const host = document.getElementById('session-usage');
  if (!host) return;
  if (!p) { host.hidden = true; host.textContent = ''; return; }
  const api = window.workbench;
  if (!api || typeof api.sessionUsage !== 'function') { host.hidden = true; return; }
  let data = sessionUsageCache.data;
  if (sessionUsageCache.projectId !== p.id || (Date.now() - sessionUsageCache.at) > 15000) {
    try {
      data = await api.sessionUsage({ projectId: p.id });
      sessionUsageCache = { projectId: p.id, at: Date.now(), data };
    } catch { data = null; }
  }
  if (!data || data.ok === false) { host.hidden = true; return; }
  host.hidden = false;
  host.setAttribute('data-session-usage', '1');
  host.setAttribute('data-usage-tokens', data.topTokens === null ? '' : String(data.topTokens));
  host.setAttribute('data-usage-threshold', String(data.warnThreshold || 300000));
  host.setAttribute('data-usage-level', String(data.level || 'unknown'));
  const label = String(data.label || ('会话用量未知 / 阈值 ' + Math.round((data.warnThreshold || 300000) / 10000) + ' 万'));
  const detail = (data.roles || []).slice(0, 3).map((row) => row.role + ':' + (row.stale ? '未知' : Math.round(row.tokens / 1000) + 'k')).join(' · ');
  host.textContent = label + (detail ? ('（' + detail + '）') : '');
  host.classList.toggle('warn', data.level === 'warn');
  host.classList.toggle('bad', data.level === 'force');
  host.title = '会话用量来自 团队/状态/项目/' + (data.project || '') + '/会话用量.json；阈值 ' + Math.round((data.warnThreshold || 300000) / 10000) + ' 万（session usage --set 可造数）';
}

function renderSessions() {
  const box = $('#role-sessions');
  const count = $('#session-count');
  const p = activeProject();
  if (!box) return;
  const entries = sessionEntries(p);
  const ready = entries.filter((item) => item.sessionId).length;
  const verified = p ? verifiedCount(p) : null;
  const total = p ? teamRoleCount(p) : entries.length || 6;
  if (count) {
    // e29f F-3：展示数字只认 DSH 核验（sessionId 全等 + 属于本工作区）；未核验/过期显示「待核验」。
    // 本地映射不再冒充展示数字，但保留在 data-local 上（5 秒跟随外部轮换的用例靠它核对）。
    count.textContent = verified === null ? '待核验' : `${verified}/${total}`;
    count.title = verified === null
      ? `DSH 未核验：本地映射 ${ready}/${total} 只作参考`
      : `DSH 核验 ${verified}/${total}（本地映射 ${ready}/${total}）`;
    count.setAttribute('data-local', `${ready}/${total}`);
    count.setAttribute('data-verified', verified === null ? '0' : '1');
  }
  // AC1：用量展示与团队会话同一块刷新（异步，不阻塞主渲染）
  try { renderSessionUsage(p).catch(() => { /* 用量展示失败不阻断会话渲染 */ }); } catch { /* ignore */ }
  if (!p) {
    box.innerHTML = '<div class="empty-row">先选择工作区；当前团队模式的角色会话会显示在这里。</div>';
    return;
  }
  box.innerHTML = entries.map(({ role, sessionId }) => {
    const st = p ? sessionState(p, role) : { cls: 'missing', text: '未启动', title: '' };
    const live = p ? liveItemFor(p, role.id) : null;
    const titleMismatch = Boolean(live && live.currentTitle && live.currentTitle !== roleSessionTitle(p, role.id));
    const sub = sessionId
      ? esc(sessionShort(sessionId)) + (titleMismatch ? ' · 标题不一致' : '')
      : 'DSH 会话未创建';
    // AC2b：会话行要有可断言的选中态 data 属性（当前角色会话行标 aria-selected/data-selected=true，
    // 其余 false；会话 id 也落到 data-session-id 上，便于 tester 按 id 断言而不是看样式）。
    const isCurrent = Boolean(sessionId) && Boolean(p) && String((p.sessions && p.sessions[role.id]) || '') === String(sessionId);
    return `<div class="session-row ${sessionId ? '' : 'missing'}" role="button" tabindex="0" data-role-session="${esc(role.id)}"
      data-session-id="${esc(sessionId || '')}" data-selected="${isCurrent ? 'true' : 'false'}" aria-selected="${isCurrent ? 'true' : 'false'}"
      title="${esc(titleMismatch ? `DSH 标题是「${live.currentTitle}」，应为「${roleSessionTitle(p, role.id)}」` : (sessionId ? '打开 ' + role.name + ' 的 DSH 会话操作' : '先建团队'))}">
      <span class="session-dot" style="--role-color:${esc(role.color)}" aria-hidden="true"></span>
      <span class="session-main"><b>${esc(role.name)}</b><small>${sub}</small></span>
      <span class="session-state ${st.cls}" title="${esc(st.title)}">${esc(st.text)}</span>
    </div>`;
  }).join('');
}

function roleSessionStatus(item) {
  const p = activeProject();
  if (!p || !item) return { cls: 'missing', text: '未启动', title: '' };
  return sessionState(p, item.role || item);
}

function renderTeamSessions() {
  const box = $('#team-session-list');
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
  const entries = sessionEntries(p);
  const ready = entries.filter((item) => item.sessionId).length;
  const verified = verifiedCount(p);
  const total = teamRoleCount(p);
  const live = liveFor(p);
  const extras = live && Array.isArray(live.extras) ? live.extras.length : 0;
  const dupes = live && Array.isArray(live.duplicates) ? live.duplicates.length : 0;
  if (count) {
    // e29f F-3：6/6 (X/N) 只认 DSH 核验（sessionId 全等 + 属于本工作区）的条数；
    // 未核验/核验过期就显示「待核验」，不能拿本地映射冒充满员。
    count.textContent = verified === null ? '待核验' : `${verified}/${total}`;
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

// R-9db6 F-1：Owner 决策箱（只读列表）。放入只有 PM 能做（团队工具 decision add），
// 回执走团队工具 decision ack；界面这边先把「待决 / 已回执 / 空 / 损坏」四态与未读计数显示清楚。
async function loadDecisionBox() {
  const box = $('#decision-box');
  if (!box) return null;
  const p = activeProject();
  if (!p) {
    box.dataset.state = 'empty';
    box.innerHTML = '<div class="empty-row">先选择工作区，再看决策箱。</div>';
    return null;
  }
  if (!(window.workbench && typeof window.workbench.teamDecisionBox === 'function')) {
    box.dataset.state = 'error';
    box.innerHTML = '<div class="empty-row">当前壳层没有 team:decision-box 接口，决策箱不可用。</div>';
    return null;
  }
  try {
    const result = await window.workbench.teamDecisionBox({ projectId: p.id });
    renderDecisionBox(result || {});
    return result;
  } catch (error) {
    box.dataset.state = 'error';
    box.innerHTML = `<div class="empty-row">决策箱读取失败：${esc(humanError(String((error && error.message) || error)))}</div>`;
    return null;
  }
}

function renderDecisionBox(data) {
  const box = $('#decision-box');
  const unread = $('#decision-box-unread');
  if (!box) return;
  const items = Array.isArray(data.items) ? data.items : [];
  const openItems = items.filter((item) => String(item.status || 'open') === 'open');
  const unreadCount = Number(data.unread || 0);
  box.dataset.unread = String(unreadCount);
  box.dataset.open = String(openItems.length);
  box.dataset.total = String(items.length);
  if (unread) {
    unread.textContent = `待决 ${unreadCount}`;
    unread.setAttribute('data-unread', String(unreadCount));
    unread.className = 'badge ' + (unreadCount ? 'badge-pending' : 'muted-badge');
    unread.title = `待决 ${openItems.length} 条，其中未读 ${unreadCount} 条`;
  }
  if (data.degraded) {
    box.dataset.state = 'degraded';
    box.innerHTML = `<div class="empty-row">${esc(data.message || '决策箱读不出来（已按空箱显示）')}</div>`;
    return;
  }
  if (!items.length) {
    box.dataset.state = 'empty';
    box.innerHTML = '<div class="empty-row">暂无待决事项</div>';
    return;
  }
  box.dataset.state = 'ready';
  box.innerHTML = items.map((item) => {
    const isOpen = String(item.status || 'open') === 'open';
    const badge = isOpen ? '<span class="badge badge-pending">待决</span>' : '<span class="badge muted-badge">已回执</span>';
    const src = item.source && item.source.ref
      ? `<button type="button" class="ghost small" data-source-open="${esc(item.source.ref)}" data-source-kind="${esc(item.source.kind || 'none')}">看来源</button>`
      : '<span class="muted">未记来源</span>';
    return `<div class="decision-row${isOpen ? '' : ' done'}" data-decision-id="${esc(item.id)}" data-status="${esc(String(item.status || 'open'))}">
      <div class="decision-head"><b>${esc(item.title || item.id)}</b><code>${esc(item.id)}</code>${badge}</div>
      <div class="decision-line">${esc(clip60(item.summary || '', 60))}</div>
      <div class="decision-line muted">要决定什么：${esc(item.question || '未写')}</div>
      <div class="decision-actions">${src}<span class="muted">放入于 ${esc(fmtTime(item.createdAt) || '未记')}</span></div>
    </div>`;
  }).join('');
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
      + ` · ${messages.length} 条消息`;
  }
  if (msgSummary) msgSummary.textContent = messages.length ? `${messages.length} 条` : '暂无消息';
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
    ['需求', counts.requirements], ['任务', counts.tasks], ['提案', counts.proposals],
    ['提交', counts.commits], ['回执', counts.receipts], ['文件', counts.files]
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
    proposals: boardCount(source, 'proposals'),
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
    proposals: boardCount(summary, 'proposals'),
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
    parts.push('<b>Owner 待决定</b>：本轮流程停在 Owner，还没有通过 / 打回 / 跳过，Owner 评审不会自动弹窗。');
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
  const url = absFileUrl(boardPath) + '?v=' + Date.now() + '&theme=' + currentTheme();
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
    proposals: boardCount(summary, 'proposals'),
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
  const allMessages = Array.isArray(p?.messages) ? p.messages : [];
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
  box.innerHTML = messages.slice(0, 30).map((m) => {
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

// 文档 key ↔ 相对路径：与后端 PROJECT_DOC_CHECKS 同口径。
const LEGACY_PRESENCE_DOCS = [
  { key: 'projectInfo', rel: '项目信息.md' },
  { key: 'iron', rel: '项目铁律.md' }
];

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

function legacyReqOwnerView(req) {
  const owner = req && req.ownerReview && typeof req.ownerReview === 'object' ? req.ownerReview : null;
  if (!owner) return { owner: null, status: 'none', key: 'pending', label: '未决定' };
  const status = String(owner.status || '');
  return {
    owner,
    status: status || 'none',
    key: status || 'optional',
    label: status ? ownerLabel(status) : '未决定'
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

/** 工作流状态与旧 任务/ 的账本是否分叉；只显示，不替后端同步。 */
function legacyRequirementLedger(req) {
  const status = String((req && req.status) || '');
  const taskStatus = String((req && req.taskStatus) || '');
  const closed = ['accepted', 'terminated', 'iteration'].includes(status);
  const staleOpen = Boolean(taskStatus && taskStatus !== 'done' && closed);
  const staleDone = Boolean(taskStatus === 'done' && !closed);
  return {
    status,
    taskStatus,
    staleOpen,
    staleDone,
    label: staleOpen
      ? `旧任务 ${taskStatus} · 工作流已${status === 'terminated' ? '终止' : '收口'}，账本未同步`
      : (staleDone ? '旧任务 done · 工作流未收口' : '')
  };
}

function legacyLedgerDivergences() {
  return legacyRequirements()
    .map((req) => ({ req, ledger: legacyRequirementLedger(req) }))
    .filter((row) => row.ledger.staleOpen || row.ledger.staleDone);
}

function legacyLedgerMarkup() {
  const rows = legacyLedgerDivergences();
  if (!rows.length) return '';
  return `<div class="legacy-ledger">
    <div class="legacy-ledger-head">
      <b>账本分叉 ${rows.length} 条</b>
      <span><code>工作流.json</code> 与旧 <code>任务/</code> 状态不一致；界面只如实显示，不替后端把旧任务改成已关闭或已领取。</span>
    </div>
    ${rows.map(({ req, ledger }) => `<div class="legacy-ledger-row">
      <code>${esc(req.id)}</code><span>${esc(legacyReqStatus(req))}</span><b>${esc(ledger.label)}</b>
    </div>`).join('')}
  </div>`;
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
 * 需求总览的第一行占位会在第一条需求落盘时被重写，不应被说成“文档未就绪/禁止推进”。
 */
function legacyBootPlaceholderDocs() {
  return legacyPlaceholderDocs(['rules', 'info']);
}

/** 文档就绪：必要文件齐全 + 六角色目录/角色卡/文件索引齐全 + 没有 boot 阻断占位。 */
function legacyDocReadiness() {
  const ready = legacyDocumentsReady();
  const missing = [];
  if (!ready.rules) missing.push('项目铁律.md');
  if (!ready.info) missing.push('项目信息.md');
  if (!ready.index) missing.push('项目索引.md');
  if (!ready.overview) missing.push('需求/00-需求总览.md');
  if (!ready.guide) missing.push('协作准则.md');
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
  return {
    ...ready,
    ok,
    pendingRead,
    readErrors,
    missing,
    bootPlaceholders,
    overviewPlaceholder,
    rolesOk,
    label: (!legacyUi.files || pendingRead) ? '文档读取中'
      : (readErrors.length ? `文档读取失败 ${readErrors.length}` : (ok ? '文档已就绪' : `文档待补 ${missing.length + bootPlaceholders.length}`))
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

function legacyBootFor(roleId) {
  const briefing = legacyUi.briefing;
  const row = briefing && briefing.roles && roleId ? briefing.roles[roleId] : null;
  // B-20261114-003257-0a46（R-d734 F-4）：角色真实 boot 证据（启动令牌/阅读记录），只用于显示，不改闸门。
  const evidence = (row && row.evidence)
    || (briefing && briefing.evidence && briefing.evidence.roles ? briefing.evidence.roles[roleId] : null)
    || null;
  const wf = legacyWorkflow();
  const currentRound = wf && Number(wf.round) ? Number(wf.round) : null;
  const ttlMinutes = legacyBootTtlMinutes();
  if (!row) {
    return {
      known: Boolean(briefing),
      booted: false,
      complete: false,
      stale: false,
      round: null,
      roundMismatch: false,
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
  // 后端 requireWorkflowBoot 会拒绝跨轮 boot；这里同步显示，避免界面说“可推进”而动作被拒。
  const roundMismatch = Boolean(bootRound && currentRound && bootRound !== currentRound);
  const bootAtMs = row.at ? Date.parse(String(row.at)) : NaN;
  const expiresAt = Number.isFinite(bootAtMs) ? bootAtMs + ttlMinutes * 60000 : null;
  // 后端对“没有有效 boot 时间”同样按 BOOT_EXPIRED 拒绝，界面不能把它当可复用。
  const expired = Boolean(row.booted) && (!Number.isFinite(bootAtMs) || Date.now() > expiresAt);
  const reasons = [];
  if (roundMismatch) reasons.push(`boot 属于第 ${bootRound} 轮（当前第 ${currentRound} 轮）`);
  if (expired) reasons.push(Number.isFinite(bootAtMs) ? `boot 已过期（超过 ${ttlMinutes} 分钟）` : 'boot 时间未记录');
  if (row.stale) reasons.push('boot 后文档已变更');
  if (!row.complete) reasons.push('必读未读全');
  const label = !row.booted ? '未 boot'
    : (reasons.length ? reasons.join(' · ') + ' · 需重新 boot' : '已 boot / 已读全');
  return {
    known: true,
    booted: Boolean(row.booted),
    complete: Boolean(row.complete),
    ready: Boolean(row.complete && !row.stale && !roundMismatch && !expired),
    stale: Boolean(row.stale),
    round: bootRound,
    roundMismatch,
    at: row.at || null,
    missing: Array.isArray(row.missing) ? row.missing : [],
    expired,
    expiresAt,
    remainingMs: expiresAt ? Math.max(0, expiresAt - Date.now()) : null,
    ttlMinutes,
    label,
    evidence
  };
}

function legacyBootSummary() {
  const rows = teamRoles(activeProject()).map((role) => ({ role, boot: legacyBootFor(role.id) }));
  return {
    known: Boolean(legacyUi.briefing),
    rows,
    booted: rows.filter((row) => row.boot.booted).length,
    complete: rows.filter((row) => row.boot.ready).length,
    stale: rows.filter((row) => row.boot.stale).length,
    roundMismatch: rows.filter((row) => row.boot.roundMismatch).length,
    expired: rows.filter((row) => row.boot.expired).length,
    allBooted: rows.length > 0 && rows.every((row) => row.boot.booted),
    allComplete: rows.length > 0 && rows.every((row) => row.boot.ready),
    total: rows.length
  };
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
  const label = ev.state === 'booted' ? `已 BOOT${time ? '（' + time + '）' : ''}`
    : ev.state === 'expired' ? `BOOT 过期${time ? '（' + time + '）' : ''}`
      : ev.state === 'stale-session' ? '未 BOOT（本会话未 boot）'
        : ev.state === 'unbound' ? '未 BOOT（当前会话未绑定）'
          : '未 BOOT';
  const title = [
    `证据：${ev.evidenceSource || '启动令牌'}${time ? ' · ' + time : ''}`,
    ev.sessionId ? `boot 会话 ${ev.sessionId}` : '',
    ev.currentSessionId ? `当前会话 ${ev.currentSessionId}（${ev.currentSessionSource || '团队.json'}）` : '当前会话未绑定（团队.json members[].sessionId 为空）',
    ev.state === 'stale-session' ? '旧会话的 boot 不算已 BOOT；用当前会话重新 boot' : '',
    ev.state === 'unbound' ? '团队.json 没有该角色的当前会话：先在团队台把角色绑到会话再 boot' : '',
    ev.state === 'expired' ? `超过 ${ev.ttlMinutes} 分钟，后端按 BOOT_EXPIRED 拒绝，需重新 boot` : '',
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
  if (boot.expired) return `${role.name} 的 ${boot.label}；后端会拒绝该动作，先点该角色的「重新 boot」或「全队 boot」`;
  if (boot.roundMismatch) return `${role.name} 的 ${boot.label}；后端会拒绝跨轮动作，先重新 boot`;
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
  { ipc: 'workflow:next', fn: 'workflowNext', label: '阶段 / 需求 / 轮次' },
  { ipc: 'workflow:briefing', fn: 'workflowBriefing', label: '每轮 boot 已读核验' },
  { ipc: 'workflow:boot', fn: 'workflowBoot', label: '角色 boot' },
  { ipc: 'requirement:create', fn: 'requirementCreate', label: '需求创建' },
  { ipc: 'requirement:review', fn: 'requirementReview', label: '产品评审' },
  { ipc: 'requirement:owner', fn: 'requirementOwner', label: 'Owner 需求决定' },
  { ipc: 'requirement:dispatch', fn: 'requirementDispatch', label: 'PM 派单' },
  { ipc: 'task:claim', fn: 'taskClaim', label: '任务认领' },
  { ipc: 'task:done', fn: 'taskDone', label: '任务完成' },
  { ipc: 'dev:submit', fn: 'devSubmit', label: '开发提交提案' },
  { ipc: 'dev:review', fn: 'devReview', label: '开发互审' },
  { ipc: 'dev:apply', fn: 'devApply', label: 'PM 签字 apply' },
  { ipc: 'test:dispatch', fn: 'testDispatch', label: '派测试' },
  { ipc: 'owner:accept', fn: 'ownerAccept', label: 'Owner 验收' },
  { ipc: 'workflow:iterate', fn: 'workflowIterate', label: '迭代下一轮' },
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
  const state = doc.exists ? (doc.changed ? 'changed' : 'ok') : 'bad';
  const mark = doc.exists ? (doc.changed ? '变更' : '已读') : '缺失';
  const hash = doc.hash ? `<code>${esc(legacyHashShort(doc.hash))}</code>` : '<code>无哈希</code>';
  return `<span class="legacy-evidence-doc ${state}" title="${esc(doc.path)} · ${doc.exists ? '存在' : '缺失'}${doc.changed ? ' · boot 后已变更' : ''}">${esc(doc.label)} ${mark} ${hash}</span>`;
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
    const label = failed.length ? `boot 完成 · 哈希未命中（${failed.join('、')}）`
      : (missing.length ? `boot 完成 · 旧记录缺哈希项（${missing.join('、')}）` : ev.boot.label);
    const cls = failed.length ? 'warn' : (ev.boot.ready ? 'ok' : (ev.boot.expired ? 'bad' : (ev.boot.booted || ev.mem ? 'warn' : 'bad')));
    const checkChips = ev.checks
      ? LEGACY_HASH_LABELS.map(([key, name]) => {
        const ok = ev.checks[key];
        const text = ok === true ? '命中' : (ok === false ? '未命中' : '未记录');
        return `<span class="legacy-evidence-check ${ok === true ? 'ok' : (ok === false ? 'bad' : 'muted')}" title="旧启动令牌哈希校验">${esc(name)} ${text}</span>`;
      }).join('')
      : '<span class="legacy-evidence-check muted">没有 boot 返回或工作流 boots 记录，无法核对令牌哈希</span>';
    const tokenLine = ev.bootRecord
      ? `<span>令牌哈希 <code>${esc(ev.bootRecord.tokenHash || '未记录')}</code></span><span>旧令牌文件 ${ev.bootRecord.legacyTokenFound ? '存在' : '<b class="bad">未找到</b>'}</span><span>会话 <code>${esc(String(ev.bootRecord.sessionId || '').slice(0, 12) || '未记录')}</code></span>`
      : (ev.briefingHash ? `<span>简报哈希 <code>${esc(legacyHashShort(ev.briefingHash))}</code></span>` : '<span class="bad">没有 boot 返回与简报哈希</span>');
    const displayRound = ev.boot.round || (ev.bootRecord && Number(ev.bootRecord.round)) || null;
    const roundText = displayRound
      ? `<span class="${ev.boot.roundMismatch ? 'bad' : ''}">boot 轮次 ${displayRound}${ev.boot.roundMismatch ? '（当前轮次不同，需重新 boot）' : ''}</span>`
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
        ${tokenLine}
      </p>
      <div class="legacy-evidence-docs">${ev.docs.map(legacyEvidenceDocChip).join('')}${ev.requirementsStale ? '<span class="legacy-evidence-doc changed" title="boot 后需求目录/需求正文发生变化">本轮相关需求 变更</span>' : ''}</div>
      <div class="legacy-evidence-checks">${checkChips}</div>
      <div class="legacy-evidence-source">来源：${esc(ev.source)}${ev.boot.missing && ev.boot.missing.length ? ` · 缺失：${esc(ev.boot.missing.join('、'))}` : ''}</div>
      ${ev.excerpt ? `<details class="legacy-evidence-excerpt"><summary>启动简报原文（后端返回，截断显示）</summary><pre>${esc(String(ev.excerpt).slice(0, 1600))}</pre></details>` : ''}
    </article>`;
  }).join('');
  return `<div class="legacy-evidence">
    <div class="legacy-evidence-head">
      <b>已读证据</b>
      <span>boot 记录取自 <code>工作流.json</code>（workflow:briefing 核验 + boots 记录）；本次界面点过 boot 时追加 workflow:boot 的真实返回。文档哈希来自后端读取；没有证据就写“未记录”，不补造。${hashFailedRoles ? `<b class="bad">有 ${hashFailedRoles} 个角色的令牌哈希存在未命中项；这不是“读全”的正向证据。</b>` : ''}${hashIncompleteRoles ? `<b>有 ${hashIncompleteRoles} 个角色的旧 boot 记录缺少部分哈希项（旧版本记录），按“未记录”显示。</b>` : ''}</span>
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
    const channelOk = ['ui', 'tty'].includes(channel);
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
        <code class="od-channel ${channelOk ? 'ok' : (channelBad ? 'bad' : '')}" title="channel 只允许 ui / tty">${esc(channel || 'channel 未记录')}</code>
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
      reason: `还有 ${open.length} 条需求在办：${names}${open.length > 3 ? ' 等' : ''}；迭代会让本轮 boot 全部作废、在办需求留在旧轮。先完成 Owner 验收，或改用「终止」。`
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
    return { ok: false, code: 'not-accepted', reason: '还没有已验收需求：迭代只在 Owner 验收通过后可用（本轮全部需求被投票驳回时例外）' };
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
  iteration: '已转下一轮',
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
  if (req && req.queued) label += ' · 下一轮排队';
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
  if (key === 'iteration') return '转下一轮';
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
      const statusKey = (merged.requirements || []).map((row) => String(row.id || '') + ':' + String(row.status || '')).join('|');
      const hint = legacyUi.phaseHint;
      if (hint && Number(hint.round) === Number(merged.round) && hint.statusKey === statusKey) {
        merged.phase = legacyDisplayPhase(hint.phase, merged.requirements);
      }
      // 不再用 p.workflowMirror.phase 覆盖刚读到的 snapshot：那是上次 apply 时的旧镜像，
      // 角色直接写 工作流.json 后它不会更新，会把流程图永久钉在旧阶段。
      legacyUi.workflow = merged;
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
      legacyUi.briefingError = { code: 'IPC_MISSING', message: '当前 preload 没有 workflow:briefing，无法核验每轮 boot / 必读状态' };
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

/** 项目/团队浮层顶部的“真源条”：IPC、旧命令、boot、账本分叉一屏可见。 */
function legacyTruthMarkup() {
  const wb = window.workbench || null;
  const missing = LEGACY_IPC.filter((item) => !(wb && typeof wb[item.fn] === 'function'));
  const { caps } = legacyCapabilityData();
  const boot = legacyBootSummary();
  const ledger = legacyLedgerDivergences();
  const readiness = legacyDocReadiness();
  const chip = (cls, text, title) => `<span class="truth-chip ${cls}" title="${esc(title || '')}"><b>${esc(text)}</b></span>`;
  const rows = [];
  if (!wb) rows.push(chip('bad', 'preload 未加载', 'window.workbench 不存在：所有项目/团队数据不可用'));
  else rows.push(chip('ok', 'preload 已加载', 'preload IPC 桥已加载'));
  rows.push(missing.length
    ? chip('bad', `IPC 缺 ${missing.length}`, `缺少：${missing.map((item) => item.ipc + '（' + item.label + '）').join('、')}`)
    : chip('ok', 'IPC 齐全', LEGACY_IPC.map((item) => item.ipc).join('、')));
  if (!wb || typeof wb.filesList !== 'function') rows.push(chip('bad', 'files:list 缺', '无法读取六角色目录与项目文档'));
  else if (legacyUi.error) rows.push(chip('bad', 'files 读取失败', legacyUi.error));
  else if (legacyUi.loading) rows.push(chip('muted', 'files 读取中', 'files:list / files:read 正在读取'));
  else if (legacyUi.files) rows.push(chip('ok', `文件 ${legacyFiles().length}`, 'files:list 实际返回的条目；截断时会另标'));
  else rows.push(chip('muted', 'files 未读取', '打开项目面板或刷新后读取'));
  if (!wb || (typeof wb.workflowState !== 'function' && typeof wb.workflow !== 'function')) rows.push(chip('bad', 'workflow 缺', '缺少 workflow:state / workflow:get，无法核验旧工作流'));
  else if (legacyUi.workflow) rows.push(chip('ok', 'workflow 已读', `工作流阶段 ${legacyUi.workflow.phase || '未写'}；来源 工作流.json`));
  else if (legacyUi.workflowError) rows.push(chip('bad', 'workflow 读取失败', `${legacyUi.workflowError.code}：${legacyUi.workflowError.message}`));
  else rows.push(chip('muted', 'workflow 未读取', '等待 workflow:state'));
  if (!wb || typeof wb.workflowBriefing !== 'function') rows.push(chip('bad', 'briefing 缺', '没有 workflow:briefing，每轮 boot 证据不可核验'));
  else if (legacyUi.briefingError) rows.push(chip('bad', 'briefing 失败', `${legacyUi.briefingError.code}：${legacyUi.briefingError.message}`));
  else if (legacyUi.briefing) rows.push(chip('ok', 'briefing 已读', '每轮 boot / 必读核验来自后端'));
  else rows.push(chip('muted', 'briefing 未读取', '等待 workflow:briefing'));
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
  const bootText = `boot ${boot.complete}/${boot.total}${boot.expired ? ` · 过期 ${boot.expired}` : ''}`;
  rows.push(chip(boot.allComplete ? 'ok' : (boot.expired ? 'bad' : (boot.booted ? 'warn' : 'bad')), bootText, `六角色可用 boot：${boot.complete}/${boot.total}；${boot.expired ? boot.expired + ' 个已过期（后端会拒绝推进）；' : ''}${boot.stale ? boot.stale + ' 个文档变更后需重新 boot；' : ''}${boot.roundMismatch ? boot.roundMismatch + ' 个跨轮 boot；' : ''}`));
  rows.push(chip(ledger.length ? 'bad' : 'ok', ledger.length ? `账本分叉 ${ledger.length}` : '账本一致', ledger.length ? ledger.map(({ req, ledger: row }) => `${req.id}：${row.label}`).join('；') : '工作流.json 与旧 任务/ 状态一致'));
  rows.push(readiness.ok
    ? chip('ok', '文档已就绪', `必要文档齐全，且项目信息/项目铁律不是模板占位；六角色目录 ${readiness.dirs}/${readiness.total}、角色卡 ${readiness.cards}/${readiness.total}、文件索引 ${readiness.indexes}/${readiness.total}`)
    : chip((!legacyUi.files || readiness.pendingRead) ? 'muted' : 'bad', readiness.label, `缺文件：${readiness.missing.join('、') || '无'}；boot 阻断占位：${readiness.bootPlaceholders.join('、') || '无'}；读取失败：${readiness.readErrors.join('、') || '无'}`));
  if (readiness.overviewPlaceholder) rows.push(chip('muted', '需求总览待首条需求', '需求/00-需求总览.md 还是模板表头；第一条需求落盘时会被重写，不挡 boot'));
  if (legacyUi.truncated) rows.push(chip('warn', '文件清单已截断', 'files:list 达到 600 项 / 4 层上限；未列出的文件不能当“缺失”'));
  return `<span class="truth-label">数据真源</span>${rows.join('')}`;
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
  const gate = legacyActionCommandGate('boot');
  const blocked = !state || !activeProject() || !legacyUi.files || legacyUi.loading
    || legacyUi.bootingAll || terminated || !pending.length || !gate.ok;
  const pendingText = expired.length
    ? `全队 boot（过期 ${expired.length}${pending.length > expired.length ? ' · 缺 ' + (pending.length - expired.length) : ''}）`
    : `全队 boot（缺 ${pending.length}）`;
  for (const id of ['legacy-boot-all', 'roles-boot-all', 'team-boot-all']) {
    const button = document.getElementById(id);
    if (!button) continue;
    button.disabled = blocked;
    button.textContent = legacyUi.bootingAll
      ? '正在 boot…'
      : (terminated ? '工作流已终止' : (pending.length ? pendingText : '六角色已 boot'));
    button.title = terminated
      ? '工作流已终止：不再接受 boot/推进动作'
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

function legacyGateResultMarkup() {
  const ready = legacyDocumentsReady();
  // “其他文档 0 份”是新项目常态，不是缺一项；就绪分母只算 8 个必要项。
  const checks = [
    ready.rules, ready.info, ready.index, ready.overview, ready.guide,
    ready.dirs === ready.total, ready.cards === ready.total, ready.indexes === ready.total
  ];
  const readyCount = checks.filter(Boolean).length;
  const readyTotal = checks.length;
  const boot = legacyBootSummary();
  const readiness = legacyDocReadiness();
  const placeholders = readiness.bootPlaceholders;
  const overviewPlaceholder = readiness.overviewPlaceholder;
  const commandSummary = legacyFlowCommandGapSummary();
  const commandGaps = commandSummary.missing;
  const commandUnknowns = commandSummary.unknown;
  const capability = legacyCapabilityData();
  const commandUnknown = Boolean(capability.caps && capability.caps.assumed);
  const expired = boot.expired;
  const wf = legacyWorkflow();
  const phase = wf && wf.phase ? String(wf.phase) : '未读取';
  const terminated = phase === 'terminated';
  const placeholderBlocked = placeholders.length > 0;
  const bootBlocked = !boot.allComplete;
  const blockReasons = [];
  if (bootBlocked) {
    blockReasons.push(expired
      ? `${expired} 个角色 boot 已过期`
      : `六角色 boot/已读 ${boot.complete}/${boot.total}`);
  }
  if (placeholderBlocked) blockReasons.push(`项目信息/项目铁律仍是模板占位：${placeholders.join('、')}`);
  const open = !terminated && !bootBlocked && !placeholderBlocked;
  const warn = open && (commandGaps.length > 0 || commandUnknowns.length > 0);
  const firstPlaceholder = LEGACY_PROJECT_DOCS.find((doc) => placeholders.includes(doc.label));
  const actions = [];
  if (expired) actions.push(`<button class="ghost small" type="button" id="legacy-gate-reboot" title="依次重新 boot 已过期角色；界面发起不冒充角色本人">重新 boot（过期 ${expired}）</button>`);
  if (placeholderBlocked && firstPlaceholder) actions.push(`<button class="ghost small" type="button" data-legacy-doc="${esc(firstPlaceholder.key)}" title="打开第一份模板占位文档；先把正文写清再推进">查看模板占位</button>`);
  if (bootBlocked && !expired) actions.push('<button class="ghost small" type="button" data-legacy-go="roles" title="到六角色卡逐角色 boot">去六角色 boot</button>');
  const title = terminated
    ? '工作流已终止：不再接受推进'
    : (open
      ? (commandGaps.length
        ? `本轮必读已核验，但缺 ${commandGaps.length} 条旧命令：可推进的部分仍可用，相关动作已禁用`
        : (commandUnknowns.length
          ? `本轮必读已核验，但旧命令 ${commandUnknowns.length} 条未核验：相关动作暂时禁用，不写成缺失`
          : '本轮必读已核验：六角色 boot 完成，可按角色推进'))
      : `${blockReasons.join('；')} → 禁止推进本轮`);
  const detail = terminated
    ? '工作流阶段：<code>terminated</code>。迭代/终止/新需求按钮已禁用；历史需求、评审与回执只读保留。'
    : (open
      ? `后端 <code>workflow:briefing</code> 记录六角色 boot 完成且必读文件齐全；执行动作前若所需角色未 boot，界面会先补一次真实 boot，后端仍校验该角色的阅读证据；Owner 是外部角色、不跑 boot。当前工作流阶段：<code>${esc(phase)}</code>。${overviewPlaceholder ? ' 需求总览仍是模板表头：第一条需求落盘时会被重写，不挡 boot。' : ''}${commandUnknown ? ' 旧命令矩阵尚未由 workflow:state 返回；当前按 team:status 的 team.mjs 存在放行基础动作，真实执行以后端返回为准。' : ''}${commandGaps.length ? ` 当前 team.mjs 缺旧命令：${commandGaps.map((name) => `<code>${esc(name)}</code>`).join('、')}；对应动作按钮已禁用，不能把“有缺口”显示成全绿。` : ''}${commandUnknowns.length ? ` 旧命令未核验：${commandUnknowns.map((name) => `<code>${esc(name)}</code>`).join('、')}；能力矩阵没有返回这些命令，对应按钮暂时禁用，不写成缺失。` : ''}`
      : `${expired ? `有 ${expired} 个角色的 boot 已过期（默认 ${legacyBootTtlMinutes()} 分钟），后端会按 <code>BOOT_EXPIRED</code> 拒绝推进；点下方「重新 boot」或到六角色卡逐角色重新 boot。` : ''}${placeholderBlocked ? ` ${placeholders.map((name) => `<code>${esc(name)}</code>`).join('、')} 仍是模板占位；boot 与推进都会被后端拒绝（<code>PLACEHOLDER_DOC</code>），先把项目目标/边界/铁律正文写清。` : ''}${bootBlocked && !expired ? ` 六角色 boot ${boot.booted}/${boot.total}，可用 ${boot.complete}/${boot.total}；缺哪个角色先点该角色的 boot。` : ''}${boot.stale ? ` 有 ${boot.stale} 个角色在 boot 后文档变更，需重新 boot。` : ''}${boot.roundMismatch ? ` 有 ${boot.roundMismatch} 个角色的 boot 属于上一轮，需重新 boot。` : ''}${legacyUi.briefingError ? ` boot 核验不可用：${legacyUi.briefingError.code}。` : (legacyUi.briefing ? '' : ' 后端 briefing 尚未读取。')}`);
  return `<div class="legacy-gate-result ${open ? (warn ? 'warn' : 'ok') : ''}">
    <span class="legacy-gate-mark" aria-hidden="true">${open ? (warn ? '▲' : '●') : '■'}</span>
    <div>
      <b>${title}</b>
      <p>${detail}</p>
      <div class="legacy-gate-facts">
        <span class="${boot.allComplete ? (warn ? 'warn' : 'ok') : 'bad'}">boot/已读 ${boot.complete}/${boot.total}</span>
        <span class="${readiness.ok ? 'ok' : (readiness.pendingRead ? 'warn' : 'bad')}">${esc(readiness.label)} · 文件 ${readyCount}/${readyTotal}</span>
        <span class="${expired ? 'bad' : 'ok'}">已过期 ${expired} 个角色</span>
        ${readiness.bootPlaceholders.length ? `<span class="bad">项目信息/铁律占位 ${readiness.bootPlaceholders.length}</span>` : '<span class="ok">项目信息/铁律已写实</span>'}
        ${overviewPlaceholder ? '<span class="warn">需求总览待首条需求</span>' : ''}
        <span class="${commandUnknown ? 'warn' : (commandGaps.length || commandUnknowns.length ? 'warn' : 'ok')}">${commandUnknown ? '旧命令 矩阵待核验' : (commandGaps.length ? '缺旧命令 ' + commandGaps.length + (commandUnknowns.length ? ' · 未核验 ' + commandUnknowns.length : '') : (commandUnknowns.length ? '旧命令 未核验 ' + commandUnknowns.length : '旧命令齐全'))}</span>
        <span class="${boot.stale ? 'bad' : 'ok'}">文档变更 ${boot.stale} 个角色</span>
        <span class="${terminated ? 'bad' : 'ok'}">阶段 <code>${esc(phase)}</code></span>
      </div>
      ${actions.length ? `<div class="legacy-gate-actions">${actions.join('')}</div>` : ''}
    </div>
  </div>`;
}

/** 数据缺口 / IPC 缺口 / 文件截断：一律显式列出，不藏在“未核验”里。 */
function legacyIssueMarkup() {
  const rows = [];
  if (!window.workbench) {
    rows.push(['bad', 'preload 没有加载：window.workbench 不存在，项目文件、boot 证据与 workflow 动作全部不可用。']);
  } else if (legacyUi.ipcMissing.length) {
    rows.push(['bad', `preload 缺少 IPC：${legacyUi.ipcMissing.map((ipc) => `<code>${esc(ipc)}</code>`).join('、')}；缺失功能保持“不可核验”，不会显示成功。`]);
  }
  if (legacyUi.error) rows.push(['bad', `读取失败：${esc(legacyUi.error)}`]);
  if (legacyUi.briefingError) rows.push(['bad', `boot 核验不可用：<code>${esc(legacyUi.briefingError.code)}</code> ${esc(legacyUi.briefingError.message)}`]);
  if (legacyUi.workflowError) rows.push(['bad', `工作流状态读取失败：<code>${esc(legacyUi.workflowError.code)}</code> ${esc(legacyUi.workflowError.message)}`]);
  if (legacyUi.truncated) rows.push(['warn', 'files:list 返回已截断（600 项 / 4 层上限）；未列出的角色目录可能只是没扫到，不能当成“缺失”下结论。']);
  const ready = legacyDocumentsReady();
  const missingDocs = [];
  if (!ready.rules) missingDocs.push('项目铁律.md');
  if (!ready.info) missingDocs.push('项目信息.md');
  if (!ready.index) missingDocs.push('项目索引.md');
  if (!ready.overview) missingDocs.push('需求/00-需求总览.md');
  if (!ready.guide) missingDocs.push('协作准则.md');
  if (missingDocs.length) rows.push(['warn', `项目文档缺失：${missingDocs.map((name) => `<code>${esc(name)}</code>`).join('、')}。界面不生成模板、不补造内容。`]);
  const placeholders = legacyBootPlaceholderDocs();
  if (placeholders.length) rows.push(['bad', `项目信息/项目铁律仍是模板占位：${placeholders.map((name) => `<code>${esc(name)}</code>`).join('、')}。boot 与推进都会被后端拒绝（<code>PLACEHOLDER_DOC</code>）；先把项目目标/边界/铁律正文写清。`]);
  const overviewPlaceholder = legacyPlaceholderDocs(['overview']).length > 0;
  if (overviewPlaceholder) rows.push(['warn', '需求/00-需求总览.md 还是模板表头；它不影响 boot，第一条需求落盘时会被重写为真实需求表。']);
  if (!rows.length) return '';
  return `<div class="legacy-issues">${rows.map(([kind, text]) => `<p class="legacy-issue ${kind}">${text}</p>`).join('')}</div>`;
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
    <span class="legacy-read-state ${boot.allComplete ? '' : 'warn'}">${boot.known ? '已读 ' + boot.complete + '/' + boot.total : '已读 · 未核验'}</span>
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
    : '<div class="legacy-missing-list is-empty" id="missing-list" data-missing-count="0"><b>检查路径</b><span>项目信息、项目铁律两处都命中，无缺失。</span></div>';
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
  const boot = legacyBootSummary();
  const terminated = Boolean(legacyUi.workflow && legacyUi.workflow.phase === 'terminated');
  const placeholders = legacyBootPlaceholderDocs();
  const overviewPlaceholder = legacyPlaceholderDocs(['overview']).length > 0;
  const commandSummary = legacyFlowCommandGapSummary();
  const commandGaps = commandSummary.missing;
  const commandUnknowns = commandSummary.unknown;
  const commandUnknown = Boolean(legacyCapabilityData().caps && legacyCapabilityData().caps.assumed);
  const expired = boot.expired;
  const placeholderBlocked = placeholders.length > 0;
  const open = boot.allComplete && !terminated && !placeholderBlocked;
  const warn = open && (commandGaps.length > 0 || commandUnknowns.length > 0);
  const pmReady = legacyRoleReady('pm') && !terminated;
  box.innerHTML = legacyIssueMarkup() + legacyReadStepsMarkup() + legacyGateResultMarkup() + legacyLedgerMarkup() + legacyBootEvidenceMarkup();
  const badge = $('#legacy-gate-badge');
  if (badge) {
    const blocks = [];
    if (!boot.allComplete) blocks.push(expired ? `boot 已过期 ${expired}` : '未 boot/未读');
    if (placeholderBlocked) blocks.push(`项目信息/铁律占位 ${placeholders.length}`);
    badge.textContent = terminated ? '工作流已终止'
      : (open
        ? (commandGaps.length
          ? `可推进 · 缺命令 ${commandGaps.length}${commandUnknowns.length ? ` · 未核验 ${commandUnknowns.length}` : ''}`
          : (commandUnknowns.length ? `可推进 · 未核验 ${commandUnknowns.length}` : '已 boot/已读 · 可推进'))
        : `${blocks.join(' · ')} · 禁止推进`);
    badge.className = 'badge ' + (terminated || !open ? 'badge-rejected' : (warn ? 'badge-skipped' : 'badge-approved'));
    badge.title = legacyUi.briefingError
      ? `boot 核验不可用：${legacyUi.briefingError.code} · ${legacyUi.briefingError.message}`
      : (legacyUi.briefing
        ? `briefing：boot ${boot.booted}/${boot.total}，可用 ${boot.complete}/${boot.total}，已过期 ${expired} 个角色${placeholders.length ? `，项目信息/铁律仍有占位 ${placeholders.length} 份（禁止推进）` : ''}${overviewPlaceholder ? '，需求总览待首条需求（不挡 boot）' : ''}${commandUnknown ? '，旧命令矩阵待核验' : (commandGaps.length ? `，缺旧命令 ${commandGaps.join('、')}` : (commandUnknowns.length ? `，旧命令未核验 ${commandUnknowns.join('、')}` : ''))}`
        : 'workflow:briefing 尚未读取');
  }
  const advanceBadge = $('#legacy-advance-badge');
  if (advanceBadge) {
    advanceBadge.textContent = open
      ? (commandGaps.length
        ? `可推进（缺命令 ${commandGaps.length}${commandUnknowns.length ? ` · 未核验 ${commandUnknowns.length}` : ''}）`
        : (commandUnknowns.length ? `可推进（未核验 ${commandUnknowns.length}）` : '可按角色推进'))
      : '禁止推进';
    advanceBadge.className = 'badge ' + (open ? (warn ? 'badge-skipped' : 'badge-approved') : 'badge-rejected');
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
    const ownerCreateWhy = terminated ? '工作流已终止'
      : (!ownerDemandGate.ok ? ownerDemandGate.reason
        : (pmReady ? '向 PM 提交需求（Owner）：owner:demand，描述 / 优先级 / 验收标准（可多条），PM 自动 boot 代办建档'
          : 'PM 未 boot；owner:demand 会由后端自动 boot PM 后代办建档'));
    const terminateWhy = terminated ? '工作流已终止'
      : (!terminateGate.ok ? terminateGate.reason : (pmReady ? '终止工作流（PM）' : 'PM 未 boot/未读全；点击执行会先自动 boot，再调用 workflow:terminate'));
    const advanceWhy = open
      ? (commandGaps.length
        ? `缺 ${commandGaps.length} 条旧命令；可用动作仍以后端返回为准。`
        : (commandUnknowns.length
          ? `旧命令 ${commandUnknowns.length} 条未核验；对应动作暂时禁用，能力矩阵返回后自动恢复（不写成缺失）。`
          : '六角色已 boot/读全；按需求卡片上的动作推进。动作执行前若所需角色未 boot，界面会先补一次真实 boot。'))
      : `${placeholderBlocked ? `项目信息/项目铁律仍有模板占位：${placeholders.join('、')}；先写清正文。` : ''}${expired ? `有 ${expired} 个角色 boot 已过期；后端会拒绝推进，先点「重新 boot」。` : ''}${!boot.allComplete && !expired ? '未 boot / 未读的角色不能推进；先在六角色卡或团队台点 boot。' : ''}`;
    advance.innerHTML = `
      <div class="legacy-advance-row">
        <div><b>推进本轮</b><p>${advanceWhy}</p></div>
        <button class="primary small" type="button" id="legacy-advance" ${open ? '' : 'disabled'} data-legacy-go="flow" title="${open ? '打开旧流程与需求队列' : (placeholderBlocked ? '项目信息/铁律占位：禁止推进，先写清正文' : (expired ? 'boot 已过期：先重新 boot' : '六角色未全部 boot/读全'))}">${open ? '查看本轮动作' : '禁止推进'}</button>
      </div>
      <div class="legacy-advance-row">
        <div><b>向 PM 提交需求（Owner）</b><p>调用 <code>owner:demand</code>：只提需求描述、优先级、验收标准（每条一行，可多条）；PM 会自动 boot 代办建档，项目开始 / 评审 / 迭代时提交。</p></div>
        <button class="ghost small" type="button" id="legacy-owner-new" ${ownerDemandVisible ? '' : 'hidden'} ${ownerCreateReady ? '' : 'disabled'} data-legacy-req-action="owner-demand" title="${esc(ownerCreateWhy)}">向 PM 提交需求（Owner）</button>
      </div>
      <div class="legacy-advance-row">
        <div><b>迭代 / 终止</b><p>迭代在全部需求验收后可用；本轮需求被投票驳回、已无在办需求时也允许收口（否则驳回一次就会锁死本轮）。有在办需求时禁用，执行会让本轮 boot 全部作废。PM 未 boot 时执行前会自动补 boot。</p></div>
        <span class="legacy-advance-buttons">
          <button class="ghost small" type="button" id="legacy-iterate" ${iterateReady ? '' : 'disabled'} data-legacy-req-action="iterate" title="${esc(iterateGuard.reason || '启动下一轮（PM）；执行前会自动补 boot')}">迭代（下一轮）</button>
          <button class="ghost small danger" type="button" id="legacy-terminate" ${terminateReady ? '' : 'disabled'} data-legacy-req-action="terminate" title="${esc(terminateWhy)}">终止</button>
        </span>
      </div>
      ${iterateVisibleWhy ? `<p class="legacy-iterate-why">迭代不可用：${esc(iterateVisibleWhy)}</p>` : ''}
      <div class="legacy-missing-list">
        <b>动作来源与边界</b>
        <span><code>workflow:briefing</code>：每轮必读/boot 的真实状态；过期、缺文件或文档变更会标出。</span>
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
    <thead><tr><th>角色</th><th>目录</th><th>角色卡</th><th>文件索引</th><th>其他文档</th><th>会话</th><th>本轮 boot / 必读</th><th>已读证据来源</th><th>打开</th></tr></thead>
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
        <td><span class="${boot.ready ? 'legacy-cell-ok' : (bootDisplay.key === 'booted' ? 'legacy-cell-warn' : 'legacy-cell-bad')}" title="${esc(bootDisplay.title)}">${esc(bootDisplay.label)}</span><br><span class="legacy-cell-dim">${esc(boot.at ? '工作台 ' + fmtTime(boot.at) : '工作台未记录')}</span></td>
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
    badge.textContent = `目录 ${ready.dirs}/${ready.total} · 角色卡 ${ready.cards}/${ready.total} · 索引 ${ready.indexes}/${ready.total} · boot ${boot.complete}/${boot.total}${boot.expired ? ` · 过期 ${boot.expired}` : ''}`;
    badge.className = 'badge ' + (ready.dirs === ready.total && ready.cards === ready.total && ready.indexes === ready.total && boot.allComplete ? 'badge-approved' : (boot.expired ? 'badge-rejected' : 'badge-skipped'));
  }
  const indexBadge = $('#legacy-role-index-badge');
  if (indexBadge) {
    const boot = legacyBootSummary();
    indexBadge.textContent = `boot ${boot.complete}/${boot.total}${boot.expired ? ` · 过期 ${boot.expired}` : ''} · 文件索引 ${ready.indexes}/${ready.total} · 项目索引 ${ready.index ? '存在' : '缺失'}`;
    indexBadge.className = 'badge ' + (boot.allComplete && ready.indexes === ready.total ? 'badge-approved' : 'badge-rejected');
  }
  const summary = $('#legacy-docs-summary');
  if (summary) {
    const boot = legacyBootSummary();
    summary.textContent = `目录 ${ready.dirs}/${ready.total} · 角色卡 ${ready.cards}/${ready.total} · 文件索引 ${ready.indexes}/${ready.total} · 其他文档 ${ready.others} 份 · 项目索引 ${ready.index ? '存在' : '缺失'} · boot ${boot.complete}/${boot.total}${boot.expired ? ` · 过期 ${boot.expired}` : ''} · ${legacyUi.loading ? '读取中…' : '只读'}`;
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
      <h3>${esc(p.name)} · 当前轮</h3>
      <span class="badge ${os.pending ? 'badge-pending' : 'badge-' + os.key}">第 ${Number(wf.round) || 1} 轮 · ${esc(phaseText)}</span>
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
        <span class="${boot.ready ? 'ok' : 'bad'}" title="${esc(boot.missing.join('、') || boot.at || '')}">${esc(boot.label)}</span>
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
  const meta = `${selection.rel} · ${fmtSize(entry.size)} · ${entry.kind === 'markdown' ? 'Markdown' : '文本'}${clipped ? ' · 已截断显示' : ''}`;
  return `<div class="legacy-doc-meta">${esc(meta)}</div>${filterNote}${body || '<div class="legacy-doc-empty">（空文件）</div>'}`;
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

function legacyRoleOptions(ids, selected) {
  return ids.map((id) => {
    const boot = legacyBootFor(id);
    return `<option value="${esc(id)}" ${id === selected ? 'selected' : ''}>${esc(roleById(id).name)}（${esc(boot.label)}）</option>`;
  }).join('');
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
        + legacyField('需求描述（必填）', '<textarea id="legacy-a-description" class="textarea" placeholder="要做什么、为什么做；第一行会作为需求标题"></textarea>')
        + legacyField('验收标准（必填 · 每条一行，可多条）', '<textarea id="legacy-a-acceptance" class="textarea" placeholder="1. 可验收的行为或结果&#10;2. 另一条标准"></textarea>')
        + legacyField('优先级', '<select id="legacy-a-priority" class="select"><option>P0</option><option selected>P1</option><option>P2</option><option>P3</option></select>');
    }
    case 'owner-demand': {
      return `<p class="legacy-form-note">向 PM 提交需求（Owner）：调用 <code>owner:demand</code>，只提需求描述、优先级、验收标准（每条一行，可多条）；PM 会自动 boot 代办建档，本轮无在办需求时直接进入${esc(terms.review)}，在办/迭代期间排到下一轮。</p>`
        + legacyField('需求描述（必填）', '<textarea id="legacy-a-description" class="textarea" placeholder="要做什么、为什么做"></textarea>')
        + legacyField('验收标准（必填 · 每条一行，可多条）', '<textarea id="legacy-a-acceptance" class="textarea" placeholder="1. 可验收的行为或结果&#10;2. 另一条标准"></textarea>')
        + legacyField('优先级', '<select id="legacy-a-priority" class="select"><option>P0</option><option selected>P1</option><option>P2</option><option>P3</option></select>');
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
        + legacyField('提案标题', '<input id="legacy-a-title" class="input" placeholder="可选">')
        + legacyField('目标文件（项目内相对路径）', '<input id="legacy-a-target" class="input" placeholder="site/index.html">')
        + legacyField('暂存内容', '<textarea id="legacy-a-content" class="textarea" placeholder="写入目标文件的完整内容；apply 前只落暂存"></textarea>')
        + legacyField('提案理由', '<textarea id="legacy-a-rationale" class="textarea" placeholder="为什么改、边界、风险"></textarea>')
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
      return `<p class="legacy-form-note">后端 <code>owner:accept</code> 按决定校验不同角色的阅读证据：<b>通过 / 打回</b>需 tester（当前 <b class="${tester.ready ? 'ok' : 'bad'}">${esc(tester.label)}</b>）；<b>转下一轮 / 终止</b>需 PM（当前 <b class="${pm.ready ? 'ok' : 'bad'}">${esc(pm.label)}</b>）。未就绪时执行前会自动补一次真实 boot，再由后端校验。</p>`
        + legacyField('需求', legacyReqSelect('legacy-a-req', ['test_done'], selected))
        + legacyField('验收决定', '<select id="legacy-a-decision" class="select"><option value="accepted">通过验收</option><option value="rejected">打回需求</option><option value="iterate">转下一轮</option><option value="terminated">终止</option></select>')
        + legacyField('Owner 意见', '<textarea id="legacy-a-opinion" class="textarea" placeholder="验收结论 / 下一轮要求"></textarea>');
    }
    case 'iterate': {
      const guard = legacyIterateGuard();
      return `<p class="legacy-form-note">调用 <code>workflow:iterate</code>：轮次 +1，把 queued 的 Owner 新需求释放到当前轮。只有 Owner / PM 能启动下一轮。</p>
        <p class="legacy-modal-warn">只在全部需求验收后（accepted）且没有在办需求时可用；本轮需求被投票驳回后已无在办需求时也允许收口。执行会让本轮角色 boot 全部作废，下一轮需要重新 boot。</p>
        ${guard.ok ? '' : `<p class="legacy-modal-warn">当前不可迭代：${esc(guard.reason)}</p>`}`
        + legacyField('说明', '<textarea id="legacy-a-opinion" class="textarea" placeholder="本轮收口结论 / 下一轮目标"></textarea>');
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
    'comment', 'decision', 'opinion', 'owner', 'evidence', 'target', 'content', 'rationale', 'risk', 'note', 'description'];
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
    ? ({ accepted: '通过验收', rejected: '打回需求', iterate: '转下一轮', terminated: '终止' }[decision] || decision)
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
 * Owner 评审材料：五类（需求正文 / 上游产出 / 提案 / 测试报告 / 最近提交）。
 * 清单来自主进程 owner:materials（带路径、大小、更新时间、版本），单项读取走 owner:material；
 * 缺失写“未记录”，不可读写“不可读（原因）”，不补造内容；1 MB 上限由主进程校验。
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
    <div class="owner-materials-head"><b>本轮评审材料（只读）</b><span id="owner-material-status">读取中…</span></div>
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

  const showProposal = (item) => {
    setOpen('');
    versionSel.hidden = true;
    pathEl.textContent = `提案 ${item.id}（团队状态目录 · 只读摘要）`;
    const reviews = (item.reviews || []).map((row) => `${roleById(row.role).name}：${row.verdict || '—'}${row.comment ? ' · ' + row.comment : ''}`).join('\n') || '（暂无评审）';
    const files = (item.files || []).map((file) => file.target || file).filter(Boolean).join('\n') || '（无文件）';
    preview.textContent = [
      `${item.id} · ${item.title || ''}`,
      `作者：${item.author || '—'} ｜ 状态：${item.status || '—'} ｜ 风险：${item.risk || '—'}`,
      item.at ? `创建：${ownerMaterialTime(item.at)}` : '',
      '', '涉及文件：', files, '', '理由：', item.rationale || '（未写）', '', '评审：', reviews
    ].filter((line) => line !== null).join('\n');
  };

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
    if (item.kind === 'proposal') { showProposal(item); return; }
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
      const isProposal = item.kind === 'proposal';
      const isCommit = item.kind === 'commit';
      const name = isProposal || isCommit ? (item.title || item.id) : item.name;
      const meta = [
        item.size ? fmtSize(item.size) : '',
        ownerMaterialTime(item.mtime || item.at),
        ownerMaterialVersionLabel(item),
        isProposal ? item.status : '',
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
    status.textContent = `五类材料 · 缺失 ${missingCount} 类（缺失不补造）${trqText}`;
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
    boot: '角色 boot / 每轮必读',
    'requirement-create': isQuickTeam() ? `新建需求（${terms.reviewer}）` : '新建需求（产品 / 需求分析师）',
    'owner-create': '向 PM 提交需求（Owner）',
    'owner-demand': '向 PM 提交需求（Owner）',
    'requirement-review': terms.review,
    'tech-review': `${terms.techReview}（快速团队）`,
    'owner-review': 'Owner 决定需求',
    dispatch: 'PM 派发开发任务',
    'task-claim': '认领任务',
    'task-done': '完成任务（必须带证据）',
    'dev-submit': '开发提交提案（旧协议 propose）',
    'dev-review': `${terms.devReview}（旧协议 show + review）`,
    'dev-apply': 'PM 签字并 apply',
    'test-dispatch': 'PM 派测试',
    'owner-accept': 'Owner 验收 / 下一轮 / 终止',
    iterate: '启动下一轮（迭代）',
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
    cancel.addEventListener('click', () => dlg.close());
    go.addEventListener('click', async () => {
      const form = legacyReadForm();
      const requirement = reqs.find((row) => row.id === form.req) || selectedReq;
      const reqFor = requirement || {};
      if (!reqFor.id && !exempt.has(action)) { dlg.error('先选择一个需求'); return; }
      // Owner（我）一次点击：不再弹确认码输入框，也不调用 owner:challenge / owner:confirm。
      setButtonsBusy([cancel, go], true);
      const ok = await execute(form, { close: dlg.close, error: dlg.error });
      if (!ok) setButtonsBusy([cancel, go], false);
    });
    dlg.foot.append(cancel, go);
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
      const description = String(form.description || '').trim();
      if (!description) { error('先写需求描述'); return false; }
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
      // PM 自动 boot 与建档都在后端完成，界面只做字段校验。
      const description = String(form.description || '').trim();
      const criteria = String(form.acceptance || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
      if (!description) { error('先写需求描述'); return false; }
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
    if (req.voteRejection) buttons.push(`<span class="legacy-req-chip warn" title="投票驳回：需求仍可重新评审/迭代，不会锁死本轮">可迭代</span>`);
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
    else if (!dev.proposal) buttons.push(legacyReqButton('dev-submit', '提交提案', req, owner, `dev:submit（${roleById(owner).name}）`));
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
    buttons.push(legacyReqButton('owner-accept', '转下一轮 / 终止…', req, '',
      `owner:accept（通过/打回需 tester 已 boot/读全；转下一轮/终止需 PM 已 boot/读全。当前 tester ${testerReady ? '就绪' : '未就绪'} · PM ${pmReady ? '就绪' : '未就绪'}；未就绪时执行前自动 boot 对应角色）`,
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
    + `${req.dev.proposal ? ' · 提案 ' + req.dev.proposal.id : ' · 未提交提案'}`
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
  const ledger = legacyRequirementLedger(req);
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
        <span class="legacy-req-chip">第 ${round} 轮</span>
        <span class="legacy-req-chip">${esc(origin)}</span>
        ${req.origin === 'legacy-doc' ? '<span class="legacy-req-chip warn" title="旧编号需求：只有需求正文、没有工作流行；评审 / Owner / 验收会按正文解析并补建行，4 位编号原样保留">旧编号可评审</span>' : ''}
        ${ownerChip}
      </div>
    </div>
    <div class="legacy-req-facts">
      ${legacyReqMeta(req).map((text) => `<span>${esc(text)}</span>`).join('')}
    </div>
    ${ledger.label ? `<div class="legacy-req-ledger">${esc(ledger.label)}；界面不替后端同步旧任务状态。</div>` : ''}
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
    button.title = terminated ? '工作流已终止'
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
    badge.textContent = `第 ${Number(wf.round) || 1} 轮 · ${reqs.length} 需求 · phase ${wf.phase || 'idle'}`;
    badge.className = 'badge ' + (['accepted', 'iteration'].includes(wf.phase) ? 'badge-approved' : (wf.phase === 'terminated' ? 'badge-rejected' : 'muted-badge'));
  }
  if (!reqs.length) {
    box.innerHTML = '<div class="empty-row">还没有需求。Owner 点「向 PM 提交需求（Owner）」提需求，由 PM 代办建档；产品 / 需求分析师不再建需求，只做拆解 / 评审。</div>';
  } else {
    box.innerHTML = reqs.slice().sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || ''))).map(legacyRequirementCard).join('');
  }
  syncLegacyGlobalReqButtons(Boolean(wf && wf.phase === 'terminated'));
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
  const rows = teamRoles(p).map((role) => {
    const card = legacyHas(legacyRoleCardRel(role));
    const index = legacyHas(legacyRoleIndexRel(role));
    // B-4baa 顺手修复：v42 三态改造在这里漏了 cardState，团队台整块渲染会报 “cardState is not defined”。
    const cardState = legacyRoleCardState(role);
    const session = sessions[role.id];
    const boot = legacyBootFor(role.id);
    const bootCtl = legacyBootControl(role.id);
    return `<div class="legacy-team-row">
      <span class="legacy-team-dot" style="--role-color:${esc(role.color)}"></span>
      <b>${esc(role.name)}</b>
      <code>${esc(legacyRoleDirName(role))}/</code>
      <span class="${cardState.key === 'ok' ? 'ok' : (cardState.key === 'unmapped' ? 'warn' : 'bad')}" title="${esc(cardState.title)}">角色卡 ${esc(cardState.label)}</span>
      <span class="${index ? 'ok' : 'bad'}">索引 ${index ? '有' : '缺'}</span>
      <span class="${session ? 'ok' : 'warn'}">${session ? '会话已映射' : '无会话'}</span>
      <span class="${boot.ready ? 'ok' : (boot.expired || boot.roundMismatch ? 'bad' : (boot.booted ? 'warn' : 'bad'))}" title="${esc(boot.missing.join('、') || boot.at || '')}">${esc(boot.label)}</span>
      <button type="button" class="legacy-boot-mini" data-legacy-boot="${esc(role.id)}" ${bootCtl.disabled ? 'disabled' : ''} title="${esc(bootCtl.title)}">${esc(bootCtl.text)}</button>
    </div>`;
  }).join('');
  box.innerHTML = `<div class="legacy-read-order">每轮必读：<b>铁律 → 项目信息 → 角色卡 → 其他人文档</b>（角色目录 ${ready.dirs}/${ready.total} · 角色卡 ${ready.cards}/${ready.total} · 文件索引 ${ready.indexes}/${ready.total} · 其他文档 ${ready.others} 份 · 项目索引 ${ready.index ? '有' : '缺'}）</div>
    <div class="legacy-team-docs">${LEGACY_PROJECT_DOCS.map((doc) => `<button type="button" class="${legacyHas(doc.rel) ? 'ok' : 'bad'}" data-legacy-doc="${esc(doc.key)}" title="${esc(doc.rel)} · ${legacyHas(doc.rel) ? '存在' : '缺失'}">${esc(doc.label)} ${legacyHas(doc.rel) ? '有' : '缺'}</button>`).join('')}</div>
    <div class="legacy-team-list">${rows}</div>
    <div class="legacy-team-result">${(() => {
      const boot = legacyBootSummary();
      const placeholders = legacyBootPlaceholderDocs();
      const overviewPlaceholder = legacyPlaceholderDocs(['overview']).length > 0;
      const commandSummary = legacyFlowCommandGapSummary();
      const commandGaps = commandSummary.missing;
      const commandUnknowns = commandSummary.unknown;
      if (legacyUi.briefingError) return `<b class="bad">boot 核验不可用</b><span>${esc(legacyUi.briefingError.code)} · ${esc(legacyUi.briefingError.message)}</span>`;
      if (!boot.allComplete) {
        const expiredText = boot.expired ? `已过期 ${boot.expired} 个角色；点该行「重新 boot」或下方「全队 boot」。` : '缺哪个角色就直接点该行的 boot。';
        return `<b class="bad">${boot.expired ? 'boot 已过期 · 禁止推进' : '未 boot / 未读 · 禁止推进'}</b><span>boot ${boot.complete}/${boot.total}；${expiredText}</span>`;
      }
      if (placeholders.length) {
        return `<b class="bad">项目信息/铁律占位 · 禁止推进</b><span>${esc(placeholders.join('、'))} 仍是模板；boot 与推进会返回 PLACEHOLDER_DOC，先把正文写清。${commandGaps.length ? `缺旧命令：${esc(commandGaps.join('、'))}。` : ''}${commandUnknowns.length ? `旧命令未核验：${esc(commandUnknowns.join('、'))}（不写成缺失）。` : ''}</span>`;
      }
      if (commandGaps.length) {
        return `<b class="warn">六角色已 boot / 读全（有命令缺口）</b><span>缺旧命令：${esc(commandGaps.join('、'))}；对应动作已禁用，动作执行前会自动补 boot 所需角色。${overviewPlaceholder ? ' 需求总览待首条需求，不挡 boot。' : ''}</span>`;
      }
      if (commandUnknowns.length) {
        return `<b class="warn">六角色已 boot / 读全（旧命令未核验）</b><span>旧命令未核验：${esc(commandUnknowns.join('、'))}；能力矩阵没有返回这些命令，对应动作暂时禁用，不写成缺失。${overviewPlaceholder ? ' 需求总览待首条需求，不挡 boot。' : ''}</span>`;
      }
      return `<b class="ok">六角色已 boot / 读全 · 可按角色推进</b><span>动作执行前会自动补 boot 所需角色；Owner 是外部角色${overviewPlaceholder ? '；需求总览待首条需求，不挡 boot' : ''}</span>`;
    })()} <button id="team-boot-all" class="ghost small" type="button" title="依次调用 workflow:boot；界面发起不冒充角色本人">全队 boot</button></div>`;
  if (badge) {
    const boot = legacyBootSummary();
    const placeholders = legacyBootPlaceholderDocs();
    const overviewPlaceholder = legacyPlaceholderDocs(['overview']).length > 0;
    const commandSummary = legacyFlowCommandGapSummary();
    const commandGaps = commandSummary.missing;
    const commandUnknowns = commandSummary.unknown;
    const commandUnknown = Boolean(legacyCapabilityData().caps && legacyCapabilityData().caps.assumed);
    const terminated = Boolean(legacyUi.workflow && legacyUi.workflow.phase === 'terminated');
    const placeholderBlocked = placeholders.length > 0;
    const open = boot.allComplete && !terminated && !placeholderBlocked;
    const warn = open && (commandGaps.length > 0 || commandUnknowns.length > 0);
    const blocks = [];
    if (!boot.allComplete) blocks.push(boot.expired ? `boot 已过期 ${boot.expired}` : '未 boot/未读');
    if (placeholderBlocked) blocks.push(`项目信息/铁律占位 ${placeholders.length}`);
    badge.textContent = terminated ? '工作流已终止'
      : (open
        ? (commandGaps.length
          ? `可推进 · 缺命令 ${commandGaps.length}${commandUnknowns.length ? ` · 未核验 ${commandUnknowns.length}` : ''}`
          : (commandUnknowns.length ? `可推进 · 未核验 ${commandUnknowns.length}` : '已 boot/已读 · 可推进'))
        : `${blocks.join(' · ')} · 禁止推进`);
    badge.className = 'badge ' + (terminated || !open ? 'badge-rejected' : (warn ? 'badge-skipped' : 'badge-approved'));
    badge.title = legacyUi.briefingError
      ? `boot 核验不可用：${legacyUi.briefingError.code} · ${legacyUi.briefingError.message}`
      : (legacyUi.briefing
        ? `briefing：boot ${boot.booted}/${boot.total}，可用 ${boot.complete}/${boot.total}，已过期 ${boot.expired} 个角色${placeholders.length ? `，项目信息/铁律仍有占位 ${placeholders.length} 份（禁止推进）` : ''}${overviewPlaceholder ? '，需求总览待首条需求（不挡 boot）' : ''}${commandUnknown ? '，旧命令矩阵待核验' : (commandGaps.length ? `，缺旧命令 ${commandGaps.join('、')}` : (commandUnknowns.length ? `，旧命令未核验 ${commandUnknowns.join('、')}` : ''))}`
        : 'workflow:briefing 尚未读取');
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
    if (req.ownerReview) {
      const ownerStatus = String(req.ownerReview.status || '').toLowerCase();
      // pending 只是产品评审后预写的占位（by=Owner、at=null），没有 Owner 决定，不能当成真实记录。
      if (['approved', 'skipped', 'rejected'].includes(ownerStatus)) {
        const ownerConfirm = legacyOwnerConfirmationFor(req.ownerReview, req.id, 'owner');
        wfRows.push({
          title: `${req.id} · Owner 评审`, at: req.ownerReview.at, owner: true,
          by: req.ownerReview.by,
          actor: req.ownerReview.actor || (ownerConfirm && ownerConfirm.actor) || null,
          verdict: req.ownerReview.status, note: req.ownerReview.opinion
        });
      }
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
  const reviews = [];
  for (const proposal of Array.isArray(p.proposals) ? p.proposals : []) {
    for (const review of Array.isArray(proposal.reviews) ? proposal.reviews : []) {
      reviews.push({ proposal, review });
    }
  }
  reviews.sort((a, b) => (Date.parse(b.review.at || 0) || 0) - (Date.parse(a.review.at || 0) || 0));
  const localRows = reviews.map(({ proposal, review }) => ({
    title: proposal.title || proposal.id || '未命名提案', at: review.at,
    by: review.by || review.role, actor: review.actor || review.executor,
    verdict: review.verdict || review.decision, note: review.comment
  }));
  const allRows = [...wfRows, ...localRows]
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
  actorBox.innerHTML = (reviewRows || '<div class="actor-empty">还没有评审记录（工作流需求/本机提案都为空；不会补造 actor）。</div>') + receiptLine;
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
  requirement: { label: '需求', owner: '需求分析师', gate: '先读铁律 → 项目信息 → 角色卡 → 其他人文档；未 boot 不写需求' },
  product: { label: '产品评审', owner: '产品设计师', gate: '需求回执到齐后评审；通过之后才进入可测性评审' },
  trq: { label: '可测性评审', owner: '测试人员', gate: 'G2.5：需求评审 approve 后、Owner 之前；只评 AC 可判定性，结论“可测”才开 Owner 门；不写测试计划' },
  owner: { label: 'Owner', owner: 'Owner', gate: '需求评审通过 + TR-Q 可测后，Owner 明确通过/跳过/打回；跳过也要记录，PM 派单只认需求级 ownerReview.decisions' },
  dispatch: { label: 'PM 派单', owner: '项目经理', gate: 'Owner 落账 approved/skipped 且 designs/TR 通过后派单；一次只派一个，等回执' },
  devreview: { label: '开发互审', owner: '程序员 A/B', gate: 'proposal 互审 + 签字；作者不能审自己' },
  test: { label: '测试', owner: '测试人员', gate: '开发回执 + commit；测试独立验证' },
  accept: { label: 'Owner 验收', owner: 'Owner', gate: '测试报告 + 回执；验收后才收口/下一轮' },
  closure: { label: '迭代 / 终止', owner: 'Owner / PM', gate: '验收后才收口：迭代把下一轮需求转正；终止冻结工作流' }
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
  owner_accept: '待 Owner 验收', accepted: '已验收', iteration: '下一轮', terminated: '已终止'
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
  const held = d.heldBack ? ' ｜ 本轮证据暂未前进，保持已推导阶段' : '';
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
  if (key === 'requirement') return phase === 'iteration' ? '当前 · 第 ' + evidence.round + ' 轮' : '当前 · 需求';
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
  if (key === 'closure') return phase === 'iteration' ? '已迭代 · 第 ' + evidence.round + ' 轮' : '待选择：迭代 / 终止';
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
      desc = `当前没有在办需求（已有 ${all.length} 条需求，均不在本轮在办）。需要时由 Owner 向 PM 提新需求；新一轮从「迭代（下一轮）」开始。`;
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


/* ── 需求/缺陷池（R-3f0d）──────────────────────────────────────────── */
const poolUi = { open: false, filter: 'all', rows: [], lastFetch: 0, loading: false };
const POOL_FILTERS = [
  { key: 'all', label: '全部' },
  { key: 'approved', label: '已通过' },
  { key: 'active', label: '进行中' },
  { key: 'accepted', label: '已验收' }
];
/** 类型：默认需求；type/defect 或 D- 前缀为缺陷（复用工作流 requirementId/type）。 */
function poolTypeOf(row) {
  const t = String((row && row.type) || '').toLowerCase();
  if (t === 'defect' || t === 'bug' || t === '缺陷') return 'defect';
  if (/^D-/i.test(String((row && row.id) || ''))) return 'defect';
  return 'requirement';
}
function poolTypeLabel(row) { return poolTypeOf(row) === 'defect' ? '【缺陷】' : '【需求】'; }
function poolTypeBadge(row) {
  const t = poolTypeOf(row);
  return `<span class="req-type ${t}" title="${t === 'defect' ? '缺陷' : '需求'}">${t === 'defect' ? '缺陷' : '需求'}</span>`;
}
/** 评审通过判定：draft/review/rejected 之外，或已有 reviewedAt。 */
function poolBucket(row) {
  const s = String((row && row.status) || '');
  if (['accepted', 'done', 'iteration'].includes(s)) return 'accepted';
  if (['dispatched', 'dev', 'dev_review', 'test', 'test_done'].includes(s)) return 'active';
  if (['approved', 'ready'].includes(s)) return 'approved';
  if (row && row.reviewedAt) return 'approved';
  return 'other';
}
function poolEntered(row) { return poolBucket(row) !== 'other' || !!(row && row.reviewedAt); }
function poolStatusLabel(row) {
  const b = poolBucket(row);
  return b === 'accepted' ? '已验收' : b === 'active' ? '进行中' : b === 'approved' ? '已通过' : '待评审';
}
async function poolFetchRows() {
  const p = activeProject();
  if (!p || !window.workbench || typeof window.workbench.workflowState !== 'function') return null;
  try {
    const wf = await window.workbench.workflowState({ projectId: p.id });
    if (!wf || wf.ok === false) return null;
    return Array.isArray(wf.requirements) ? wf.requirements : [];
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
    <div class="pool-filters" id="pool-filters"></div>
    <div class="pool-cols">
      <section class="pool-col"><h4>需求池 <span class="pool-n" id="pool-req-n">0</span></h4><div class="pool-list" id="pool-req-list"></div></section>
      <section class="pool-col"><h4>缺陷池 <span class="pool-n" id="pool-def-n">0</span></h4><div class="pool-list" id="pool-def-list"></div></section>
    </div>
    <p class="pool-foot" id="pool-foot"></p>
  </section>`;
  document.body.appendChild(mask);
  mask.addEventListener('click', (e) => { if (e.target === mask) closePool(); });
  $('#pool-close')?.addEventListener('click', closePool);
  return mask;
}
function poolRowMarkup(row) {
  const id = String((row && row.id) || '');
  const b = poolBucket(row);
  const who = String((row && (row.owner || row.ownerRole)) || '');
  return `<div class="pool-row" data-id="${esc(id)}" data-bucket="${b}">${poolTypeBadge(row)}<span class="pool-id">${esc(id)}</span><span class="pool-state s-${b}">${poolStatusLabel(row)}</span>${who ? `<span class="pool-who">${esc(who)}</span>` : ''}</div>`;
}
function renderPool() {
  poolPanelEnsure();
  const entered = (poolUi.rows || []).filter(poolEntered);
  const visible = entered.filter((r) => poolUi.filter === 'all' || poolBucket(r) === poolUi.filter);
  const req = visible.filter((r) => poolTypeOf(r) === 'requirement');
  const def = visible.filter((r) => poolTypeOf(r) === 'defect');
  const filters = $('#pool-filters');
  if (filters) {
    filters.innerHTML = POOL_FILTERS.map((f) => {
      const n = f.key === 'all' ? entered.length : entered.filter((r) => poolBucket(r) === f.key).length;
      return `<button class="pool-chip${poolUi.filter === f.key ? ' on' : ''}" data-filter="${f.key}" type="button">${f.label}<i>${n}</i></button>`;
    }).join('');
    filters.querySelectorAll('.pool-chip').forEach((btn) => btn.addEventListener('click', () => { poolUi.filter = btn.dataset.filter; renderPool(); }));
  }
  const reqList = $('#pool-req-list');
  const defList = $('#pool-def-list');
  if (reqList) reqList.innerHTML = req.length ? req.map(poolRowMarkup).join('') : '<p class="pool-empty">需求池暂无（评审通过后自动入池）</p>';
  if (defList) defList.innerHTML = def.length ? def.map(poolRowMarkup).join('') : '<p class="pool-empty">缺陷池暂无（评审通过的缺陷自动入池）</p>';
  if ($('#pool-req-n')) $('#pool-req-n').textContent = String(req.length);
  if ($('#pool-def-n')) $('#pool-def-n').textContent = String(def.length);
  if ($('#pool-foot')) {
    const allReq = entered.filter((r) => poolTypeOf(r) === 'requirement').length;
    const allDef = entered.filter((r) => poolTypeOf(r) === 'defect').length;
    const label = (POOL_FILTERS.find((f) => f.key === poolUi.filter) || {}).label || '全部';
    $('#pool-foot').textContent = `池内 ${entered.length} 条（需求 ${allReq} · 缺陷 ${allDef}）；筛选：${label}`;
  }
}
async function refreshPool() {
  if (poolUi.loading) return;
  poolUi.loading = true;
  try {
    const rows = await poolFetchRows();
    if (rows) { poolUi.rows = rows; poolUi.lastFetch = Date.now(); }
    if (poolUi.open) renderPool();
  } finally { poolUi.loading = false; }
}
async function togglePool(force) {
  const mask = poolPanelEnsure();
  const next = typeof force === 'boolean' ? force : mask.hidden;
  poolUi.open = next;
  mask.hidden = !next;
  if (next) await refreshPool();
}
function closePool() {
  const mask = $('#pool-mask');
  if (mask) mask.hidden = true;
  poolUi.open = false;
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
  const ledgerText = evidence.ledger.length ? `账本分叉 ${evidence.ledger.length} 条` : '账本一致';
  return `第 ${evidence.round} 轮 ｜ 阶段：${evidence.phase} ｜ boot/已读 ${boot.complete}/${boot.total} ｜ 需求 ${evidence.requirementCount}（已验收 ${evidence.accepted}）｜ 当前需求：${reqText} ｜ 任务 ${evidence.tasks.length} ｜ 项目级 Owner：${projectOwner.label}（不参与派单）｜ 收口：${closure} ｜ 待回执：${evidence.pending ? roleById(evidence.pending.to).name : '无'} ｜ 旧命令缺失：${missing === null ? '未知' : missing} ｜ ${ledgerText}`;
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
    : '<span class="bad">待 Owner（尚无决定记录）</span>';
  const reqLine = req
    ? `<div class="legacy-owner-req-head"><b>${esc(req.title || '未写标题')}</b><code>${esc(req.id)}</code><span class="badge ${reqOwner.status === 'rejected' ? 'badge-rejected' : (['approved', 'skipped'].includes(reqOwner.status) ? 'badge-approved' : 'badge-skipped')}">Owner ${esc(reqOwner.label)}</span></div>
      <p>需求状态：<b>${esc(legacyReqStatus(req))}</b> · ${esc(reviewLabel)}：${req.productReview ? esc(req.productReview.verdict || '未写结论') + ' · ' + esc(legacyActorText(req.productReview.by, 'actor ' + (req.productReview.actor || '未记录'))) : '未记录'}</p>
      <div class="legacy-owner-fields">${ownerRecordFields}<span>at=${esc(ownerDecided && reqOwner.owner && reqOwner.owner.at ? fmtTime(reqOwner.owner.at) : '未记录')}</span><span class="${reviewReady ? 'ok' : 'bad'}">${esc(roleById(reviewRole).name)}：${esc(reviewBoot.label)}</span></div>
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
      ? `<p>当前没有在办需求（已有 ${legacyRequirements().length} 条需求，均不在本轮在办）。Owner 的“参与 / 跳过”发生在${esc(reviewLabel)}通过之后；新一轮从「迭代（下一轮）」开始。</p>`
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
  const gate = $('#legacy-flow-gate');
  if (gate) gate.innerHTML = legacyIssueMarkup() + legacyGateResultMarkup();
  const ledgerBox = $('#legacy-flow-ledger');
  if (ledgerBox) ledgerBox.innerHTML = legacyLedgerMarkup();
  renderLegacyCapabilities();
  const ownerBox = $('#legacy-flow-owner');
  if (ownerBox) ownerBox.innerHTML = legacyOwnerPanelMarkup(p);
  const actions = $('#legacy-flow-actions');
  if (actions) {
    const boot = legacyBootSummary();
    const placeholders = legacyBootPlaceholderDocs();
    const overviewPlaceholder = legacyPlaceholderDocs(['overview']).length > 0;
    const terminated = Boolean(legacyWorkflow() && legacyWorkflow().phase === 'terminated');
    const pmReady = legacyRoleReady('pm') && !terminated;
    const canAdvance = boot.allComplete && !terminated && !placeholders.length;
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
      <button class="primary small" type="button" id="legacy-flow-advance" ${canAdvance ? '' : 'disabled'} data-legacy-scroll="requirements" title="${canAdvance ? '跳到需求队列' : (terminated ? '工作流已终止' : (placeholders.length ? '项目信息/铁律占位：禁止推进，先写清正文' : '六角色未全部 boot/读全（或已过期）'))}">${canAdvance ? '查看本轮动作' : '禁止推进'}</button>
      <button class="ghost small" type="button" id="legacy-flow-iterate" ${iterateReady ? '' : 'disabled'} data-legacy-req-action="iterate" title="${esc(iterateGuard.reason || '启动下一轮（PM）；执行前会自动补 boot')}">迭代（下一轮）</button>
      <button class="ghost small danger" type="button" id="legacy-flow-terminate" ${terminateReady ? '' : 'disabled'} data-legacy-req-action="terminate" title="${esc(!terminateGate.ok ? terminateGate.reason : (terminated ? '工作流已终止' : (pmReady ? 'workflow:terminate（PM）' : 'PM 未 boot/未读全；点击执行会先自动 boot，再调用 workflow:terminate')))}">终止</button>
      <button class="ghost small" type="button" data-legacy-req-action="owner-demand" ${ownerDemandVisible ? '' : 'hidden'} ${ownerDemandReady ? '' : 'disabled'} title="${esc(!ownerDemandGate.ok ? ownerDemandGate.reason : (terminated ? '工作流已终止' : '向 PM 提交需求（Owner）：owner:demand，描述 / 优先级 / 验收标准（可多条），PM 自动 boot 代办建档'))}">向 PM 提交需求（Owner）</button>
      <button class="ghost small" type="button" data-legacy-go="docs">必读与目录</button>
      <button class="ghost small" type="button" data-open-team>团队台 / 派单</button>
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
 */
const flowLiveState = { failures: 0, nextAt: 0 };

async function refreshFlowLive() {
  const p = activeProject();
  if (!p || !window.workbench) return false;
  const flowOpen = !$('#flow-panel')?.hidden;
  if (!flowOpen && openDrawerName !== 'project') return false;
  const wb = window.workbench;
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
    // R-db98 v2：验收要求「状态变化 5 秒内刷新」；节流 4 秒 + 1 秒心跳，保证最坏 5 秒内命中。
    flowLiveState.nextAt = Date.now() + 4000;
    renderFlow();
    // 闸门判定与审计也只读拉取；接口未就绪时显示“待接入”，不影响流程渲染。
    loadGateCheck();
    loadGateAudit();
    return true;
  } catch (error) {
    flowLiveState.failures += 1;
    const delay = flowLiveState.failures <= 1 ? 2000 : (flowLiveState.failures === 2 ? 5000 : 10000);
    flowLiveState.nextAt = Date.now() + delay;
    // 只读刷新失败不打断界面，也不拿旧值冒充；下次按退避重试。
    return false;
  }
}

/** 1 秒心跳 + 5 秒节流：面板不可见时暂停，重新打开立即刷新一次。 */
function flowRefreshTick() {
  const p = activeProject();
  const flowOpen = !$('#flow-panel')?.hidden;
  if (!p || (!flowOpen && openDrawerName !== 'project')) { flowLiveState.nextAt = 0; return; }
  if (Date.now() < flowLiveState.nextAt) return;
  refreshFlowLive();
}

/** 主流程面板上次渲染签名：数据没变就不重建大 DOM（5 秒轮询只刷新数据，不重复排版）。 */
const flowRenderUi = { projectId: '', sig: '' };

/** 流程面板内容签名：工作流/需求/任务/boot/闸门审计任一变化才重绘。
 * B-20261113-005026-c447：补 Owner 决定与落账字段。旧签名只有需求行 id/status/updatedAt，
 * Owner 只改 ownerReview（点通过/先跳过、写 decisions）而需求行 status/updatedAt 没动时签名不变 →
 * 右下角流程图不重绘，看起来“点了没反应”。现在把 ownerReview.status、decisions 条数与最近决定时间、
 * 账本分叉条数一起算进签名：判定后 5 秒轮询拿到新数据就会重绘。 */

/** v4 流程面板数据：从工作流 requirements 构建（优先级排序、卡点/冲突/验收人）。 */
/** 已收口状态：与 legacyActiveRequirement 同口径（验收/完成/终止/迭代/驳回）；流程图默认只看未收口。 */
const FLOW_CLOSED_STATUSES = ['accepted', 'done', 'terminated', 'iteration', 'rejected'];
function flowV4Data() {
  const wf = legacyWorkflow() || {};
  const reqs = Array.isArray(wf.requirements) ? wf.requirements : [];
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
    return {
      id: String(r.id || ''), title: String(r.title || ''), pri: String(r.priority || 'P2').toUpperCase(),
      owner: String(r.owner || r.createdBy || ''), status, statusText: '', stage: 0,
      updatedAt: String(r.updatedAt || ''), round: Number(r.round || wf.round || 1),
      closed: FLOW_CLOSED_STATUSES.includes(status),
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
    { key: 'test-collect', on: items.some((i) => ['test', 'test_done'].includes(i.status)) && items.some((i) => i.status === 'review'), label: '测试 ∥ 下一轮收集' }
  ];
  return { round: Number(wf.round || 1), total: items.length, open: items.length - closedCount, closed: closedCount, active, items, parallel };
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
  const flowSig = flowRenderSignature(p);
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
    if (window.FlowV4) window.FlowV4.render(mini, flowV4Data());
    else mini.innerHTML = graphHtml || flowMarkup(p);
  }
  renderQuickTechReview(p);
  renderLegacyFlowExtras(p);
  renderLegacyRequirements();
  const text = flowMeta(p);
  if (meta) meta.textContent = text;
  if (miniMeta) miniMeta.textContent = text;
  const boot = legacyBootSummary();
  const activeReq = legacyActiveRequirement();
  const activeOwner = legacyReqOwnerView(activeReq);
  if (summary) summary.textContent = `boot/已读 ${boot.complete}/${boot.total} · ${boot.allComplete ? '可按角色推进' : '禁止推进'} ｜ 需求级 Owner：${activeReq ? `${activeOwner.label} · ${activeReq.id}` : '无在办需求'}`;
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
      + ` · boot ${boot.complete}/${boot.total}${boot.expired ? ` · 过期 ${boot.expired}` : ''}`;
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
        <div><h3>${esc(role.name)}</h3><div class="muted">${taskRoles.has(role.id) ? '本轮有任务' : '待命'} · ${session ? '有会话' : '无会话'} · <code>${esc(role.id)}</code></div></div>
      </div>
      <p>${esc(ROLE_BLURB[role.id] || '实现、互审、提交与回执。')}</p>
      <div class="role-scope" title="${esc(role.scope)}">${esc(legacyRoleDirName(role))}/ · ${esc(role.scope)} · <span class="${dir ? 'fact-ok' : 'fact-bad'}">目录${dir ? '存在' : '缺失'}</span></div>
      <div class="role-session" title="${esc(session || '')}">${session ? '本地映射 · ' + esc(sessionShort(session)) : '本地映射 · 未创建'}</div>
      <div class="role-live ${st.cls}" title="${esc(st.title)}">${esc(st.text)}</div>
      <div class="role-facts">
        <span><i>角色卡</i><b class="${cardState.key === 'ok' ? 'fact-ok' : (cardState.key === 'unmapped' ? 'fact-warn' : 'fact-bad')}" title="${esc(cardState.title)}">${esc(cardState.label)}</b></span>
        <span><i>文件索引</i><b class="${index ? 'fact-ok' : 'fact-bad'}" title="${esc(indexRel)}">${index ? '存在' : '缺失'}</b></span>
        <span><i>其他文档</i><b class="${others ? 'fact-ok' : 'fact-muted'}">${others}</b><small>份</small></span>
        <span><i>本轮 boot</i><b class="fact-${hint.key === 'ready' ? 'ok' : (hint.key === 'missing-file' ? 'bad' : 'warn')}" title="${esc(hint.title)}">${esc(hint.label)}</b></span>
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
    notes.push('本轮 boot/已读没有后端核验 IPC：派单仍走真实 team:send，但界面不能把“壳代跑 boot”当成角色自己已开工。');
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
    <p class="member-hint">这里是当前工作区的${esc(teamModeLabel(p))}成员清单。快速团队只显示 4 个角色；被隐藏角色的会话不会出现在清单里。DSH 左侧默认不显示“没有第一轮对话”的空白会话，需要显示时可在角色页逐个唤醒。</p>
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

/* ── 提案 ─────────────────────────────────────────────── */

const PROTOCOL_STEPS = ['propose', 'show', 'review', 'sign', 'apply'];

function proposalIsLegacy(proposal) {
  return Boolean(proposal && (proposal.protocol === 'legacy' || proposal.legacyId));
}

function legacyProposalOrder(proposal) {
  const x = proposal || {};
  const stage = String(x.stage || '').toLowerCase();
  const legacyStatus = String(x.legacyStatus || '').toLowerCase();
  const status = String(x.status || '').toLowerCase();
  const rank = { proposed: 1, shown: 2, reviewed: 3, review: 3, signed: 4, approved: 4, applied: 5 };
  let order = rank[stage] || 0;
  order = Math.max(order, rank[legacyStatus] || 0, rank[status] || 0);
  if (Array.isArray(x.reviews) && x.reviews.length) order = Math.max(order, 3);
  if (x.signature) order = Math.max(order, 4);
  if (x.applied) order = Math.max(order, 5);
  return Math.max(1, Math.min(5, order));
}

function legacyProposalSteps(proposal) {
  const order = legacyProposalOrder(proposal);
  return PROTOCOL_STEPS.map((key, index) => {
    const step = index + 1;
    return {
      key,
      state: step <= order ? 'ok' : (step === order + 1 ? 'current' : 'unknown'),
      text: step <= order ? '已执行' : (step === order + 1 ? '当前' : '待执行'),
      title: `旧协议 ${key}：${step <= order ? '已执行' : (step === order + 1 ? '当前阶段' : '尚未执行')}；真相在 team.mjs，界面只读镜像`
    };
  });
}

function legacyProposalStageText(proposal) {
  const x = proposal || {};
  const legacyStatus = String(x.legacyStatus || '').toLowerCase();
  const status = String(x.status || '').toLowerCase();
  if (legacyStatus === 'rejected' || status === 'rejected') return '已拒绝';
  const labels = ['已提案', '已展示', '已评审', '已签字', '已应用'];
  return labels[legacyProposalOrder(x) - 1] || '状态未记录';
}

function proposalLocalSteps(proposal) {
  const x = proposal || {};
  const reviews = Array.isArray(x.reviews) ? x.reviews : [];
  const signed = Boolean(x.signature);
  return [
    { key: 'propose', text: x.createdAt ? '已创建' : '未记录', state: x.createdAt ? 'ok' : 'unknown', title: '工作台 proposal:create 写入本地库；不是旧协议 propose' },
    { key: 'show', text: '本地详情', state: 'local', title: '本页直接展示本地提案详情；没有调用旧协议 show' },
    { key: 'review', text: reviews.length ? `${reviews.length} 条评审` : '待评审', state: reviews.length ? 'ok' : 'warn', title: '工作台 proposal:review 写本地 reviews；不是旧协议 review' },
    { key: 'sign', text: signed ? (x.signature.decision === 'approved' ? '已签通过' : '已签拒绝') : '未签字', state: signed ? 'ok' : 'warn', title: '工作台 proposal:sign 写本地 signature；不是旧协议 sign' },
    { key: 'apply', text: x.applied ? '已应用' : '未应用', state: x.applied ? 'ok' : 'muted', title: '工作台 proposal:apply 写文件并备份；不是旧协议 apply' }
  ];
}

function renderProposalProtocol(proposals) {  const box = $('#proposal-protocol');
  if (!box) return;
  const items = Array.isArray(proposals) ? proposals : [];
  const legacy = items.filter(proposalIsLegacy).length;
  const local = items.length - legacy;
  const head = legacy
    ? `<b>旧协议镜像 ${legacy} 条 · 本地提案 ${local} 条。</b><span>标「旧协议」的卡片来自 team.mjs 的 propose→show→review→sign→apply；标「本地」的卡片不是旧协议。</span>`
    : `<b>当前没有旧协议镜像；下面 ${local} 条是本地提案，不是旧协议 propose/show/review/sign/apply。</b><span>旧协议五步在本页未观测，不把本地评审/签字/应用回填成旧协议状态。</span>`;
  box.innerHTML = `<div class="protocol-head">${head}</div>
    <div class="protocol-steps">${PROTOCOL_STEPS.map((step) => `<span class="protocol-step" title="旧协议 ${step}：有「旧协议」镜像卡片时按卡片 stage 显示；没有镜像就标未观测"><i>${step}</i><b>${legacy ? '见卡片' : '未观测'}</b></span>`).join('<span class="local-arrow" aria-hidden="true">›</span>')}</div>
    <p class="protocol-note">${legacy
      ? '「旧协议」卡片的状态来自 team.mjs 提案文件的只读镜像（proposal:legacy），本地 <code>proposal:*</code> 不能改它们；点卡片里的「刷新旧协议状态」才会重新 show。'
      : '旧协议状态没有只读接口，所以五个旧阶段统一标“未观测”，不把本地评审/签字/应用回填成旧协议回执。本地 proposal:* 会在应用前备份原文件。'}</p>`;
}

function legacyProposalView(item) {
  const reviews = Object.entries(item.reviews || {}).map(([role, row]) => ({
    role,
    verdict: row && row.verdict ? row.verdict : 'unknown',
    comment: String((row && (row.comments || row.comment)) || '').slice(0, 600)
  }));
  const signatures = Object.entries(item.signatures || {});
  const pmSig = signatures.find(([role]) => role === 'pm');
  const applied = Boolean(item.commitId);
  const legacyStatus = String(item.status || '').toLowerCase();
  const status = applied ? 'applied'
    : legacyStatus === 'rejected' ? 'rejected'
      : (signatures.length && signatures.every(([, row]) => row && row.decision === 'approve')) || legacyStatus === 'approved' ? 'approved'
        : 'review';
  const stage = applied ? 'applied'
    : status === 'approved' ? 'signed'
      : reviews.length ? 'reviewed' : 'proposed';
  return {
    id: item.id,
    legacyId: item.id,
    protocol: 'legacy',
    legacyStatus,
    status,
    stage,
    title: item.title || item.id,
    author: item.author || 'pm',
    hash: item.proposalHash || '',
    fileRel: (item.files && item.files[0] && item.files[0].target) || '',
    fileSize: (item.files && item.files[0] && item.files[0].size) || 0,
    files: item.files || [],
    reviews,
    signature: pmSig ? { decision: pmSig[1].decision === 'approve' ? 'approved' : 'rejected', note: String(pmSig[1].note || '') } : null,
    applied,
    commitId: item.commitId || '',
    createdAt: item.createdAt || '',
    rationale: item.rationale || '',
    risk: item.risk || 'normal'
  };
}

/** 旧协议提案只读列表：打开提案页/切项目时自动拉一次，失败不影响本地提案。 */
async function loadLegacyProposals(force = false) {
  const p = activeProject();
  if (!p || !window.workbench || typeof window.workbench.proposalList !== 'function') return;
  if (legacyUi.proposalsLoading) return;
  if (!force && legacyUi.proposalsProjectId === p.id && Date.now() - legacyUi.proposalsAt < 12000) return;
  legacyUi.proposalsLoading = true;
  try {
    const r = await window.workbench.proposalList({ projectId: p.id });
    if (!activeProject() || activeProject().id !== p.id) return;
    legacyUi.proposalsProjectId = p.id;
    legacyUi.proposalsAt = Date.now();
    legacyUi.legacyProposals = (r && r.ok && Array.isArray(r.proposals))
      ? r.proposals.map(legacyProposalView)
      : [];
    renderProposals();
  } catch {
    legacyUi.legacyProposals = [];
  } finally {
    legacyUi.proposalsLoading = false;
  }
}

function renderProposals() {
  const p = activeProject();
  const box = $('#proposals-list');
  const summary = $('#proposal-summary');
  if (!box) return;
  if (!p) {
    renderProposalProtocol([]);
    if (summary) summary.textContent = '';
    box.innerHTML = emptyView({
      mark: '✎',
      title: '先选择一个项目',
      text: '提案会绑定项目内真实文件，评审和 PM 签字后才允许应用。',
      action: '<button class="primary small" type="button" data-open-new-project>＋ 新建项目</button>'
    });
    return;
  }
  const localItems = Array.isArray(p.proposals) ? p.proposals : [];
  // 旧协议提案自动并入：不需要先点一次 show 才能看到；失败只影响这一块。
  const legacyItems = (legacyUi.proposalsProjectId === p.id ? legacyUi.legacyProposals : [])
    .filter((x) => !localItems.some((y) => y.id === x.id));
  const items = [...legacyItems, ...localItems];
  renderProposalProtocol(items);
  const legacyCount = items.filter(proposalIsLegacy).length;
  if (legacyUi.proposalsProjectId !== p.id || Date.now() - legacyUi.proposalsAt > 12000) loadLegacyProposals();
  if (summary) {
    summary.textContent = items.length
      ? `${items.length} 个提案 · ${items.filter((x) => x.status === 'review').length} 个待处理`
        + (legacyCount ? ` · ${legacyCount} 个旧协议镜像` : ' · 全部为本地提案')
      : '';
  }
  if (!items.length) {
    box.innerHTML = emptyView({
      mark: '✎',
      title: '还没有本地提案或旧协议镜像',
      text: '本地提案绑定项目内真实文件，应用前会先备份；旧协议提案只有调用 proposal:legacy 后才会镜像到这里。',
      action: '<button class="primary small" type="button" data-open-proposal>＋ 新提案</button>'
    });
    return;
  }
  const labels = { review: '评审中', approved: '已通过', rejected: '已拒绝' };
  box.innerHTML = items.map((x) => {
    const legacy = proposalIsLegacy(x);
    const steps = legacy ? legacyProposalSteps(x) : proposalLocalSteps(x);
    const stageText = legacy ? legacyProposalStageText(x) : (labels[x.status] || x.status);
    return `
    <article class="proposal-card${legacy ? ' is-legacy' : ''}" data-proposal-protocol="${legacy ? 'legacy' : 'local'}">
      <div class="proposal-head"><h3>${esc(x.title)}</h3><span class="badge ${legacy ? 'legacy-badge' : ''}">${legacy ? '旧协议 · ' : ''}${esc(stageText)}</span></div>
      <div class="proposal-meta">${legacy ? '旧协议镜像' : '本地提案'} · 作者：${esc(roleById(x.author).name)} · ${esc(x.id)} · ${esc(String(x.hash || '').slice(0, 10) || '—')}</div>
      <div class="proposal-file">${esc(x.fileRel)} · ${x.fileSize} B</div>
      <div class="proposal-reviews">${(x.reviews || []).map((r) => `${esc(roleById(r.role).name)}：${r.verdict === 'approve' ? '通过' : '拒绝'} · ${esc(r.comment)}`).join('<br>') || '暂无评审'}<br>${x.signature ? `PM 签字：${x.signature.decision === 'approved' ? '通过' : '拒绝'}${x.signature.note ? ' · ' + esc(x.signature.note) : ''}` : '未签字'}${x.applied ? `<br>已应用：${esc(x.commitId || '提交未记录')}` : ''}</div>
      <div class="proposal-local-flow${legacy ? ' is-legacy' : ''}" title="${legacy ? '旧协议镜像：propose/show/review/sign/apply 状态来自 team.mjs' : '以下五步是工作台本地 proposal:* 状态，不是旧协议 propose/show/review/sign/apply'}">
        <span class="local-flag${legacy ? ' legacy' : ''}">${legacy ? '旧协议' : '本地'}</span>
        ${steps.map((step) => `<span class="local-step ${step.state}" title="${esc(step.title)}"><i>${step.key}</i>${esc(step.text)}</span>`).join('<span class="local-arrow" aria-hidden="true">›</span>')}
      </div>
      <div class="proposal-actions">
        ${legacy
          ? `<button class="ghost" type="button" data-proposal-legacy-show="${esc(x.legacyId || x.id)}" ${(p.sessions || {}).pm ? '' : 'disabled'} title="${(p.sessions || {}).pm ? '用 PM 会话调用 proposal:legacy show，重新读取 team.mjs 状态；失败会明说' : 'PM 没有 DSH 会话，不能调用旧协议 show'}">刷新旧协议状态</button><span class="proposal-note">只读镜像；评审/签字/应用必须走 team.mjs（proposal:legacy），本地 proposal:* 不能改</span>`
          : `${x.status === 'review' ? '<button class="ghost" type="button" data-proposal-review="' + esc(x.id) + '">评审</button>' : ''}
        ${!x.signature && x.status === 'review' && (x.reviews || []).some((r) => r.verdict === 'approve') ? '<button class="ghost" type="button" data-proposal-sign="' + esc(x.id) + '">PM 签字</button>' : ''}
        ${x.status === 'approved' && x.stagedContent !== null && !x.applied ? '<button class="primary small" type="button" data-proposal-apply="' + esc(x.id) + '">应用提案</button>' : ''}
        ${x.applied ? '<button class="ghost" type="button" data-proposal-rollback="' + esc(x.id) + '">回滚</button>' : ''}`}
      </div>
    </article>`;
  }).join('');

  box.querySelectorAll('[data-proposal-review]').forEach((b) => b.addEventListener('click', () => openReviewModal(b.dataset.proposalReview)));
  box.querySelectorAll('[data-proposal-sign]').forEach((b) => b.addEventListener('click', () => openSignModal(b.dataset.proposalSign)));
  box.querySelectorAll('[data-proposal-apply]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('应用提案并写入文件？会先备份原文件。')) return;
    try {
      await applyState(await window.workbench.proposalApply({ projectId: p.id, proposalId: b.dataset.proposalApply }));
      renderProposals();
      toast('提案已应用', 'ok');
    } catch (e) { toast('应用失败：' + e.message, 'bad'); }
  }));
  box.querySelectorAll('[data-proposal-rollback]').forEach((b) => b.addEventListener('click', async () => {
    if (!confirm('回滚这次提交？')) return;
    try {
      await applyState(await window.workbench.proposalRollback({ projectId: p.id, proposalId: b.dataset.proposalRollback }));
      renderProposals();
      toast('已回滚', 'ok');
    } catch (e) { toast('回滚失败：' + e.message, 'bad'); }
  }));
  box.querySelectorAll('[data-proposal-legacy-show]').forEach((b) => b.addEventListener('click', () => refreshLegacyProposal(b.dataset.proposalLegacyShow)));
}

/** 旧协议 show：只读刷新 team.mjs 状态并镜像；失败原样报错，不回退成本地成功。 */
async function refreshLegacyProposal(proposalId) {
  const p = activeProject();
  if (!p) return;
  const role = 'pm';
  const sessionId = (p.sessions || {})[role] || '';
  if (!sessionId) { toast('PM 没有 DSH 会话：不能调用旧协议 show', 'bad'); return; }
  const api = window.workbench && (window.workbench.proposalLegacyShow || window.workbench.proposalLegacy);
  if (typeof api !== 'function') { toast('preload 没有 proposal:legacy：读不到旧协议状态', 'bad'); return; }
  try {
    const r = await api({ projectId: p.id, action: 'show', role, sessionId, proposalId });
    if (r && r.ok === false) throw new Error(r.message || r.code || '旧协议 show 失败');
    if (r && r.state) { state = r.state; render(); } else { await refresh(); }
    renderProposals();
    const stage = String((r && (r.stage || (r.proposal && r.proposal.stage))) || '');
    toast('旧协议状态已刷新' + (stage ? '：' + stage : ''), 'ok');
  } catch (e) {
    toast('旧协议状态刷新失败：' + humanError(e.message), 'bad');
  }
}

function openProposalModal() {
  const p = activeProject();
  if (!p) { openNewProject(); return; }
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <label class="field"><span><b>标题</b></span><input id="pr-title" class="input" placeholder="例如：首页信息架构提案"></label>
    <div class="form-row">
      <label class="field" style="flex:1"><span><b>作者角色</b></span><select id="pr-author" class="select">${teamRoles(p).map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}</select></label>
      <label class="field" style="flex:1"><span><b>项目内文件</b></span><input id="pr-file" class="input" placeholder="例如 产品/方案.md"></label>
    </div>
    <label class="field"><span><b>新内容（可选）</b></span><textarea id="pr-content" class="textarea" placeholder="填写后会作为待应用内容；PM 签字后可 apply，原文件先备份"></textarea></label>
    <p class="hint">文件可以已存在，也可以由新内容创建；只允许当前项目内路径。</p>
    <div class="modal-error"></div>`;
  openModal({
    title: '新提案', subtitle: p.name, icon: '✎', body: wrap, width: 600,
    actions: [
      { label: '取消', kind: 'ghost', onClick: ({ close }) => close() },
      { label: '创建提案', kind: 'primary', onClick: async ({ close, error }) => {
        try {
          const payload = { projectId: p.id, title: wrap.querySelector('#pr-title').value, author: wrap.querySelector('#pr-author').value, fileRel: wrap.querySelector('#pr-file').value };
          const content = wrap.querySelector('#pr-content').value;
          if (content) payload.content = content;
          const r = await window.workbench.proposalCreate(payload);
          await applyState(r);
          close();
          renderProposals();
          toast('提案已创建', 'ok');
        } catch (e) { error(e.message); }
      } }
    ]
  });
}

function openReviewModal(proposalId) {
  const p = activeProject();
  const proposal = (p?.proposals || []).find((x) => x.id === proposalId);
  if (!p || !proposal) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <label class="field"><span><b>评审角色</b></span><select id="rv-role" class="select">${teamRoles(p).filter((r) => r.id !== proposal.author).map((r) => `<option value="${esc(r.id)}">${esc(r.name)}</option>`).join('')}</select></label>
    <label class="field"><span><b>结论</b></span><select id="rv-verdict" class="select"><option value="approve">通过</option><option value="reject">拒绝</option></select></label>
    <label class="field"><span><b>理由</b></span><textarea id="rv-comment" class="textarea" maxlength="600" placeholder="必须写具体理由"></textarea></label>
    <div class="modal-error"></div>`;
  openModal({
    title: '评审提案', subtitle: proposal.title, icon: '◈', body: wrap, width: 570,
    actions: [
      { label: '取消', kind: 'ghost', onClick: ({ close }) => close() },
      { label: '提交评审', kind: 'primary', onClick: async ({ close, error }) => {
        try {
          const r = await window.workbench.proposalReview({ projectId: p.id, proposalId, role: wrap.querySelector('#rv-role').value, verdict: wrap.querySelector('#rv-verdict').value, comment: wrap.querySelector('#rv-comment').value });
          await applyState(r);
          close();
          renderProposals();
          toast('评审已记录', 'ok');
        } catch (e) { error(e.message); }
      } }
    ]
  });
}

function openSignModal(proposalId) {
  const p = activeProject();
  const proposal = (p?.proposals || []).find((x) => x.id === proposalId);
  if (!p || !proposal) return;
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <label class="field"><span><b>签字决定</b></span><select id="sg-decision" class="select"><option value="approved">通过</option><option value="rejected">拒绝</option></select></label>
    <label class="field"><span><b>备注</b></span><textarea id="sg-note" class="textarea" maxlength="500"></textarea></label>
    <div class="modal-error"></div>`;
  openModal({
    title: 'PM 签字', subtitle: proposal.title, icon: '✎', body: wrap, width: 540,
    actions: [
      { label: '取消', kind: 'ghost', onClick: ({ close }) => close() },
      { label: '签字', kind: 'primary', onClick: async ({ close, error }) => {
        try {
          const r = await window.workbench.proposalSign({ projectId: p.id, proposalId, decision: wrap.querySelector('#sg-decision').value, note: wrap.querySelector('#sg-note').value });
          await applyState(r);
          close();
          renderProposals();
          toast('签字已记录', 'ok');
        } catch (e) { error(e.message); }
      } }
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
      body.innerHTML = note + markdownToHtml(display);
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
  if (fileUi.expanded.has(rel)) fileUi.expanded.delete(rel);
  else fileUi.expanded.add(rel);
  renderFileTree();
  const row = Array.from(document.querySelectorAll('[data-file-rel]')).find((el) => el.dataset.fileRel === rel);
  try { row?.focus(); } catch { /* ignore */ }
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
  }
  box.innerHTML = '<div class="empty-row">读取中…</div>';
  try {
    const r = await window.workbench.filesList(p.id);
    if (!r || !r.ok) throw new Error((r && r.error) || '读取失败');
    fileUi.data = r;
    const root = r.root || p.path;
    if (rootEl) { rootEl.textContent = root; rootEl.title = root; }
    if (crumb) crumb.title = root;
    renderFileTree();
  } catch (e) {
    fileUi.data = null;
    if (summary) summary.textContent = '';
    box.innerHTML = `<div class="file-error"><b>项目目录读取失败</b><span>${esc(humanError(e.message))}</span><button class="ghost small" type="button" data-file-retry>重试</button></div>`;
  }
}

function renderFileTree() {
  const box = $('#files-list');
  const data = fileUi.data;
  if (!box || !data) return;
  const items = data.files || [];
  const dirs = items.filter((x) => x.kind === 'dir');
  const files = items.filter((x) => x.kind !== 'dir');
  const summary = $('#files-summary');
  if (summary) summary.textContent = `${dirs.length} 个文件夹 · ${files.length} 个文件`;

  const dirSet = new Set(dirs.map((x) => x.rel));
  for (const rel of Array.from(fileUi.expanded)) if (!dirSet.has(rel)) fileUi.expanded.delete(rel);

  if (!items.length) {
    box.innerHTML = `<div class="file-empty"><span class="file-empty-mark" aria-hidden="true">▱</span><b>项目目录为空</b><p>新建项目会自动生成角色目录、src/、_tmp/ 和项目信息.md。</p><button class="ghost small" type="button" data-open-project-folder>打开项目文件夹</button></div>`;
    return;
  }

  const children = new Map();
  for (const it of items) {
    const rel = String(it.rel || '');
    const parent = rel.includes('/') ? rel.slice(0, rel.lastIndexOf('/')) : '';
    if (!children.has(parent)) children.set(parent, []);
    children.get(parent).push(it);
  }
  for (const arr of children.values()) {
    arr.sort((a, b) => {
      const ad = a.kind === 'dir' ? 0 : 1;
      const bd = b.kind === 'dir' ? 0 : 1;
      if (ad !== bd) return ad - bd;
      return String(a.name).localeCompare(String(b.name), 'zh-CN');
    });
  }

  const build = (parent, depth) => (children.get(parent) || []).map((it) => {
    const isDir = it.kind === 'dir';
    const open = isDir && fileUi.expanded.has(it.rel);
    const roleDirNames = ['项目经理', '产品', '需求分析师', '程序员A', '程序员B', '测试人员'];
    const dirKind = isDir ? (it.rel === '需求' ? '需求池' : (roleDirNames.includes(it.name) ? '角色目录' : '文件夹')) : '';
    const meta = isDir ? dirKind : `${fmtSize(it.size || 0)} · ${fileKind(it.name)}`;
    let html = `<div class="file-row${isDir ? ' is-dir' : ''}${open ? ' is-open' : ''}" style="--depth:${depth}" data-file-rel="${esc(it.rel)}" data-file-kind="${isDir ? 'dir' : 'file'}" tabindex="0" role="${isDir ? 'button' : 'link'}"${isDir ? ` aria-expanded="${open}"` : ''} title="${esc(it.rel)}">
      <span class="file-caret" aria-hidden="true">${isDir ? (open ? '⌄' : '›') : ''}</span>
      <span class="file-ico${isDir ? ' is-dir' : ''}" aria-hidden="true">${esc(fileIcon(it.name, isDir))}</span>
      <span class="file-name">${esc(it.name)}</span>
      <span class="file-meta">${esc(meta)}</span>
    </div>`;
    if (isDir && open) {
      const kids = children.get(it.rel) || [];
      html += kids.length ? build(it.rel, depth + 1) : `<div class="file-empty-row" style="--depth:${depth + 1}">空文件夹</div>`;
    }
    return html;
  }).join('');

  let html = build('', 0);
  if (items.length >= 600) html += '<div class="file-empty-row">只显示前 600 项，更多内容请在系统文件夹中查看。</div>';
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
              : (readiness.ok ? '项目已创建 · 文档已就绪' : `项目已创建 · ${readiness.label}`),
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
      const label = status === 'skipped' ? '已跳过本轮 Owner 评审'
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
      <label class="field"><span><b>Owner 意见</b><span class="field-note">会作为本轮决定保存在本地</span></span><textarea id="ow-opinion" class="textarea" maxlength="1000" placeholder="例如：需求边界清楚，通过；或：登录流程缺少异常状态，打回需求。">${esc(initialOpinion)}</textarea></label>
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
      <p class="owner-intro">本轮不是必审，但需要你明确选择：跳过评审，或看完项目文件后留下意见。意见会作为本轮项目级 Owner 决定保存在本地。关闭不会自动弹窗，也不会丢失入口。</p>
      <div class="owner-summary">
        <div><span>当前阶段</span><b>${esc(stageById(p.stage).label)}</b></div>
        <div><span>任务</span><b>${tasks.length} 个（完成 ${tasks.filter((t) => t.status === 'done').length}）</b></div>
        <div><span>Owner 状态</span><b class="${os.pending ? 'bad' : ''}">${esc(os.label)}</b></div>
      </div>
      ${os.opinion ? `<p class="hint">上一轮意见：${esc(os.opinion)}${os.at ? ' · ' + esc(fmtTime(os.at)) : ''}</p>` : ''}
      <div class="quick-actions"><button class="ghost small" type="button" id="owner-open-folder">打开项目文件夹</button></div>
      <p class="hint">“通过”需要写一句意见；“打回”会回到需求阶段；再次打开会覆盖本轮决定。</p>
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
    const showOff = !online || dshViewFailed;
    off.hidden = !showOff;
    const url = $('#dsh-off-url');
    if (url) url.textContent = (dsh?.baseUrl || '地址未配置') + (dsh?.message ? ' · ' + dsh.message : '');
  }
  const modeButton = $('#btn-dsh-mode');
  if (modeButton) {
    modeButton.title = online ? '重载 DSH 主画面' : 'DSH 离线：先启动 DSH Web';
    modeButton.setAttribute('aria-pressed', String(!online));
  }
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

function applyDshViewSrc() {
  const view = $('#dsh-view');
  const base = state?.dsh?.baseUrl;
  if (!view || !base) return;
  const current = view.getAttribute('src') || '';
  if (!current || current === 'about:blank' || current !== base) {
    dshViewFailed = false;
    view.setAttribute('src', base);
  }
}

async function initDsh() {
  try {
    const s = await window.workbench.dshStatus();
    state.dsh = s.status;
    renderDsh(s.status);
    applyDshViewSrc();
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
    applyDshViewSrc();
    const view = $('#dsh-view');
    try { view?.reload(); } catch { applyDshViewSrc(); }
    renderDsh(state.dsh);
    toast('正在重新连接 DSH', 'ok');
  } catch (e) {
    toast('重试失败：' + e.message, 'bad');
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
const rosterUi = { busy: false, timer: null, lastSig: '', lastAt: 0 };

function rosterSignature(s) {
  const list = s && Array.isArray(s.projects) ? s.projects : [];
  return list.map((p) => `${p.id}:${JSON.stringify(p.sessions || {})}:${JSON.stringify((p.workspace && p.workspace.sessionIds) || [])}`).join('|');
}

async function syncRosterFromDisk(opts = {}) {
  if (!window.workbench || typeof window.workbench.state !== 'function' || rosterUi.busy) return false;
  rosterUi.busy = true;
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

function startRosterWatch() {
  if (rosterUi.timer) return;
  rosterUi.lastSig = rosterSignature(state);
  rosterUi.lastAt = Date.now();
  rosterUi.timer = setInterval(rosterWatchTick, ROSTER_WATCH_MS);
  // 自测/排查用只读钩子：当前映射签名与侧栏计数。
  window.__teamRoster = {
    sync: (opts) => syncRosterFromDisk(opts || {}),
    sig: () => rosterSignature(state),
    count: () => (document.querySelector('#team-session-count') || {}).textContent || '',
  };
}

function reloadDshView(opts = {}) {
  const view = $('#dsh-view');
  if (!view) return false;
  dshViewFailed = false;
  dshReady = false;
  try { view.reload(); } catch { applyDshViewSrc(); }
  renderDsh(state?.dsh);
  // B-405f 补充：重载聊天区的同时重读会话映射，成员列表/计数一起刷新（不用重启工作台）。
  if (window.__teamRoster && typeof window.__teamRoster.sync === 'function') {
    window.__teamRoster.sync({}).catch(() => {});
  }
  if (!opts.quiet) toast('已重载 DSH 主画面', 'ok');
  return true;
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
    applyDshViewSrc();
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
          applyDshViewSrc();
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
    <p class="hint">DSH 是主画面；项目 = 工作区，会话 = 角色。项目与团队状态保存在本机，不复制 DSH 内部实现。</p>`;
  openModal({
    title: '关于 PM工作台', subtitle: 'PM Workbench · DSH 壳 · 工作区与六角色', icon: 'PM', body, width: 560,
    actions: [{ label: '关闭', kind: 'ghost', onClick: ({ close }) => close() }]
  });
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
  else if (act === 'theme') toggleTheme();
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
  if (metricsBusy) return; // B-fa80：2 秒一次，慢返回时跳过本轮，避免 IPC 堆积
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
    const r = await window.workbench.teamBoardOld({ projectId: p.id, theme: currentTheme() });
    if (r && r.ok) {
      toast(r.reused ? '团队看板浮窗已置顶（复用已有窗口）' : '已打开旧版团队看板浮窗（置顶）', 'ok');
      loadTeamStatus({ force: true });
    } else {
      toast('旧版看板失败：' + ((r && (r.message || r.why || r.code)) || '未知错误'), 'bad');
    }
  } catch (e) { toast('旧版看板失败：' + humanError(e.message), 'bad'); }
}

function bind() {
  // B-fa80：系统占用点击立即刷新（平时 2 秒自动刷新）。
  $('#metrics')?.addEventListener('click', () => { tickMetrics(); });
  // R-9db6：决策箱刷新（只读重拉）
  $('#btn-decision-refresh')?.addEventListener('click', () => { loadDecisionBox(); });
  // T-b417：守护状态点击立即刷新（平时 10 秒刷新）；启动先读一次。
  $('#daemon-pill')?.addEventListener('click', () => { tickDaemonStatus(); });
  tickDaemonStatus();
  setInterval(() => { tickDaemonStatus(); }, 10000);
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
  $('#team-pill')?.addEventListener('click', () => setDrawer('team'));
  $('#session-pill')?.addEventListener('click', () => setDrawer('team'));

  // 顶栏操作
  $('#btn-board')?.addEventListener('click', () => setDrawer('project'));
  $('#btn-members')?.addEventListener('click', () => setDrawer('team'));
  $('#legacy-owner-quick-removed')?.addEventListener('click', openOwnerGate);
  $('#legacyReviewStage')?.addEventListener('click', () => {
    if (activeProject()) openOwnerGate();
  });
  $('#btn-workspace')?.addEventListener('click', openNewProject);
  $('#btn-side-new')?.addEventListener('click', openNewProject);
  $('#btn-team-start')?.addEventListener('click', () => startTeam($('#btn-team-start')));
  $('#btn-pool')?.addEventListener('click', () => togglePool());
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && poolUi.open) closePool(); });
  setTimeout(() => { refreshPoolBadge(); }, 1500);
  $('#btn-restore')?.addEventListener('click', () => openRestoreModal());
  $('#btn-clean-missing')?.addEventListener('click', () => cleanMissingProjects());
  $('#btn-empty-new')?.addEventListener('click', openNewProject);
  $('#btn-side-restore')?.addEventListener('click', () => openRestoreModal());
  $('#btn-refresh')?.addEventListener('click', async (e) => {
    const btn = e.currentTarget;
    if (btn) btn.disabled = true;
    try {
      await refreshAll({ toast: true });
    } catch (err) {
      toast('刷新失败：' + humanError(err.message), 'bad');
    } finally { if (btn) btn.disabled = false; }
  });
  $('#btn-folder-top')?.addEventListener('click', openProjectFolder);
  $('#metrics')?.addEventListener('click', () => { tickMetrics(); });
  $('#btn-dsh-mode')?.addEventListener('click', () => reloadDshView());
  $('#btn-dsh-off-reload')?.addEventListener('click', () => reloadDshView());
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
    if (window.workbench && typeof window.workbench.onMemRecycleDone === 'function') {
      window.workbench.onMemRecycleDone((d) => { paint({ mb: d && d.after, thresholdMB: (d && d.thresholdMB) || 0, baselineMB: d && d.baselineMB }); toast(`已回收：${fmt(d && d.before)} → ${fmt(d && d.after)}`); });
    }
    if (window.workbench && typeof window.workbench.memStats === 'function') window.workbench.memStats().then(paint).catch(() => {});
  })();
  $('#board-launcher')?.addEventListener('click', toggleBoardPanel);
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
    const btn = e.target.closest('[data-more]');
    if (!btn || btn.disabled) return;
    e.stopPropagation();
    runMoreAction(btn.dataset.more);
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

  // 提案 / 文件
  $('#btn-proposal-add')?.addEventListener('click', openProposalModal);
  $('#btn-files-refresh')?.addEventListener('click', loadFiles);
  $('.file-toolbar')?.addEventListener('click', (e) => {
    const tool = e.target.closest('[data-file-tool]')?.dataset.fileTool;
    if (!tool) return;
    if (tool === 'refresh') { loadFiles(); return; }
    const data = fileUi.data;
    if (!data) return;
    if (tool === 'expand') fileUi.expanded = new Set((data.files || []).filter((x) => x.kind === 'dir').map((x) => x.rel));
    else if (tool === 'collapse') fileUi.expanded.clear();
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
    const item = (fileUi.data?.files || []).find((x) => x.rel === rel);
    if (!item) { toast('文件列表已变化，请刷新后重试', 'bad'); return; }
    openFilePreview(p, item);
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

  // 抽屉关闭
  $$('[data-close-drawer]').forEach((b) => b.addEventListener('click', () => setDrawer(null)));
  $('#drawer-mask')?.addEventListener('click', () => setDrawer(null));

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
    if (target.closest('[data-open-proposal]')) { e.preventDefault(); openProposalModal(); return; }
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
    view.addEventListener('did-finish-load', async () => {
      dshReady = true;
      dshViewFailed = false;
      if (state) renderDsh(state.dsh);
      if (pendingDshFocus) await flushPendingDshFocus();
      else {
        const p = activeProject();
        if (p) await focusDshWorkspace(p, { notify: false });
      }
    });
    view.addEventListener('did-fail-load', (e) => {
      if (e.errorCode === -3) return;
      if (e.isMainFrame === false) return;
      dshReady = false;
      dshViewFailed = true;
      renderDsh(state?.dsh);
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
  const wrap = document.createElement('div');
  wrap.innerHTML = `
    <p class="team-mode-intro">选择团队模式。模式会保存到项目；以后可再次打开「建团队」切换。</p>
    <div class="team-mode-grid">
      ${Object.values(TEAM_MODES).map((def) => `<button type="button" class="team-mode-card${picked === def.id ? ' active' : ''}" data-team-mode-pick="${def.id}" aria-pressed="${picked === def.id ? 'true' : 'false'}">
        <span class="team-mode-card-top"><b>${esc(def.label)}</b><span class="badge">${def.roleIds.length} 人</span></span>
        <span class="team-mode-note">${esc(def.note)}</span>
        <span class="team-mode-roles">${teamModeRoleMarkup(def.id, p)}</span>
        ${def.hidden.length ? `<span class="team-mode-hidden">隐藏：${def.hidden.map((id) => esc(roleById(id).name)).join('、')}</span>` : '<span class="team-mode-hidden">六个角色都显示</span>'}
      </button>`).join('')}
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
  if (seeds > 0) parts.push(`补发 ${seeds} 条首轮就位`);
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
  let savedTheme = 'dark';
  try { savedTheme = localStorage.getItem('awb.theme') || 'dark'; } catch { /* ignore */ }
  applyTheme(savedTheme);
  loadInboxSeen();
  bind();
  renderBridgeAlert();
  await refresh();
  warnStore();
  if (!window.workbench) {
    renderBridgeAlert();
    return;
  }
  await initDsh();
  await tickMetrics();
  setInterval(tickMetrics, 2000);
  // 流程图/项目面板打开时轮询工作流真相（只读，5 秒节流）；隐藏暂停，失败按 2s/5s/10s 退避。
  setInterval(flowRefreshTick, 1000);
  // B-405f：会话映射自动跟随（rotate/换人后 5 秒内刷新成员列表与计数，不用重启）。
  startRosterWatch();
  // 团队台打开时定期复核会话（只读）；平时不轮询，避免打扰 DSH。
  setInterval(() => {
    if (!state || !state.dsh || !state.dsh.online) return;
    if (openDrawerName !== 'team') return;
    loadDshTeamStatus({ force: true });
  }, 45000);

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
