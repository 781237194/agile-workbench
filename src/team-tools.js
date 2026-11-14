'use strict';

/**
 * 团队工具适配层。
 *
 * 本文件只做四件事：
 *   1. 用 runNode 调 团队/工具/team.mjs、workspace.mjs、launch.mjs；
 *   2. 统一超时（杀进程）、退出码、stderr、JSON 解析；
 *   3. 把“未 init / DSH 离线 / 路径含中文 / 工具缺失”归一成结构化结果；
 *   4. 让主进程拿到稳定字段，不把工具崩溃或半截输出抛给界面。
 *
 * 不复制团队工具实现，也不直接写团队业务状态（init/ensure/board/launch 都由工具自己完成）。
 */

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

const ROLE_IDS = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
const ROLE_NAMES = {
  pm: '项目经理',
  product: '产品设计师',
  analyst: '需求分析师',
  programmer1: '高级程序员 A',
  programmer2: '高级程序员 B',
  tester: '测试人员'
};
// 旧 workspace.mjs 使用的六角色目录名；ensure 时逐个核对，缺一个就补一个。
const ROLE_DIRS = {
  pm: '项目经理',
  product: '产品',
  analyst: '需求分析师',
  programmer1: '程序员A',
  programmer2: '程序员B',
  tester: '测试人员'
};
// 团队模式：full 保留六角色；fast 只保留 pm/analyst/programmer1/tester。
// 默认 full，旧项目没有 teamMode 字段时按 full 处理；Fast 绝不补建 product/programmer2。
const TEAM_MODES = {
  full: {
    id: 'full',
    label: '完整模式',
    roleIds: ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester']
  },
  fast: {
    id: 'fast',
    label: '快速模式',
    roleIds: ['pm', 'analyst', 'programmer1', 'tester']
  }
};
const DEFAULT_TEAM_MODE = 'full';

function normalizeTeamMode(value) {
  const raw = typeof value === 'string'
    ? value
    : (value && typeof value === 'object' ? (value.teamMode || value.mode) : '');
  return String(raw || '').toLowerCase() === 'fast' ? 'fast' : DEFAULT_TEAM_MODE;
}

function roleIdsForTeamMode(value) {
  return TEAM_MODES[normalizeTeamMode(value)].roleIds.slice();
}

function isRoleInTeamMode(role, value) {
  return roleIdsForTeamMode(value).includes(String(role || ''));
}

/** 需求评审人：Fast 由需求分析师评审；Full 保持产品设计师评审。 */
function requirementReviewRole(value) {
  return normalizeTeamMode(value) === 'fast' ? 'analyst' : 'product';
}

/** 开发技术评审只存在于 Fast（Owner 之后、派单之前），由高级程序员 A 执行。 */
function techReviewRole(value) {
  return normalizeTeamMode(value) === 'fast' ? 'programmer1' : '';
}

// 工作流状态只写旧 团队/状态/项目/<slug>/工作流.json；这些常量只用于校验/映射，不另存状态。
const WORKFLOW_SCHEMA = 2;
const WORKFLOW_PHASES = [
  'idle', 'requirement', 'requirement_review', 'owner_review', 'tech_review', 'dispatch',
  'dev', 'dev_review', 'dev_done', 'test', 'owner_accept',
  'accepted', 'iteration', 'terminated'
];
const WORKFLOW_STAGE_BY_PHASE = {
  idle: 'intake',
  requirement: 'requirement',
  requirement_review: 'review',
  owner_review: 'owner',
  tech_review: 'review',
  dispatch: 'dispatch',
  dev: 'dev',
  dev_review: 'dev',
  dev_done: 'dev',
  test: 'test',
  owner_accept: 'owner',
  accepted: 'close',
  iteration: 'requirement',
  terminated: 'close'
};
// 旧 team.mjs 的三条工作流命令：有就真调用，没有就明确标记为 missing。
// 不能因为本机工具版本旧就静默改走本地假状态。
const LEGACY_OPTIONAL_COMMANDS = ['workflow', 'owner', 'req review'];
// 需求被驳回（评审驳回 / Owner 打回 / 技术评审打回 / 投票驳回）后所处阶段：
// 必须回到“需求评审”继续修改与重评，不能停在 requirement——那个阶段没有任何可推进动作，
// 界面会看起来卡死；这也与 phaseFromRequirements 的推导（review/rejected → requirement_review）一致。
const REJECTED_REQUIREMENT_PHASE = 'requirement_review';
const TIMEOUTS = {
  init: 30000,
  ensure: 60000,
  list: 25000,
  board: 90000,
  // 旧协议消息通道：boot / send / ack / inbox 都是本地 CLI，给 30 秒。
  boot: 30000,
  send: 30000,
  ack: 30000,
  inbox: 25000,
  // 旧评审协议 propose/show/review/sign/apply 都要读项目文档并写提案状态，给 60 秒。
  proposal: 60000,
  activate: 30000,
  launchDryRun: 60000,
  launch: 180000,
  // 旧版唤醒启动卡时给 300 秒；不带 prompt 的建会话仍是 180 秒。
  launchPrompt: 300000
};
// boot 令牌默认 8 小时（480 分钟）；提前 60 秒视为过期，避免刚好卡在边界。
// 旧 team.json 的 30 分钟由 team.mjs 首次 boot 时迁移到 480；这里只保留兜底默认值。
const DEFAULT_BOOT_TTL_MINUTES = 480;
const BOOT_EXPIRY_MARGIN_MS = 60 * 1000;
const TOKEN_RETRY_CODES = ['BOOT_REQUIRED', 'BOOT_INVALID', 'BOOT_EXPIRED', 'RULES_CHANGED'];
const MAX_BUFFER = 16 * 1024 * 1024;
const TAIL_CHARS = 2000;
// 旧版回执列表：只读文件尾部，超大 回执.jsonl 也不整块读进内存；条数上限固定。
const RECEIPTS_TAIL_BYTES = 8 * 1024 * 1024;
const RECEIPTS_MAX_LIMIT = 500;
const RECEIPTS_DEFAULT_LIMIT = 50;
// 旧评审协议（team.mjs）：propose → show → review → sign → apply。
// 工作台壳只做桥接，不复制 ops.mjs 的校验/签字/提交逻辑。
const LEGACY_REVIEW_ACTIONS = ['propose', 'show', 'review', 'sign', 'apply'];
const LEGACY_STATUS_MAP = {
  proposed: 'review',
  reviewing: 'review',
  reviewed: 'review',
  signing: 'review',
  approved: 'approved',
  applied: 'approved',
  rejected: 'rejected',
  stale: 'rejected'
};
const DSH_DOWN_RE = /(fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|bad port|没有 DSH_WEB_URL|browser-session secret|HTTP 401|HTTP 403|Unauthorized|UNAUTHORIZED)/i;
// 精准投喂：buildRoleBrief 的简报正文上限（固定 800 字）；唤醒消息总输出上限按角色：
// 需求 800 / 产品 800 / 开发 1200 / 测试 1000（PM 与需求同档）。
const BRIEF_MAX_CHARS = 800;
const ROLE_BRIEF_LIMITS = {
  pm: 800,
  analyst: 800,
  product: 800,
  programmer1: 1200,
  programmer2: 1200,
  tester: 1000
};

function repoRoot() {
  return path.join(__dirname, '..');
}

function tail(text, max = TAIL_CHARS) {
  const value = String(text == null ? '' : text);
  return value.length <= max ? value : value.slice(-max);
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function isDirectory(target) {
  try {
    return fs.statSync(target).isDirectory();
  } catch {
    return false;
  }
}

function isInside(parent, child) {
  const p = path.resolve(parent).toLowerCase();
  const c = path.resolve(child).toLowerCase();
  return c === p || c.startsWith(p + path.sep);
}

// ==========================================================================
// R-ea86 F-E3：PM 代验收「证据两件套」校验（纯函数，只读文件、不写盘）
//
// 判据（需求 v3 + PM 2026-11-14 02:31 补充：证据可在项目内，也可在工作台共享层）：
//   统一前置：路径必须存在；fs.realpathSync 后必须在「项目目录」或「共享层（src/**、团队/工具/**）」内
//            （拒 .. / 软链逃逸到别处）；>0 字节。
//   截图：≥1 张，扩展名 png|jpg|jpeg|webp 且文件头魔数匹配（PNG 89 50 4E 47 / JPEG FF D8 FF / WebP RIFF....WEBP）。
//   测试报告：正文 \bPASS\b 命中 且 \bFAIL\b 不命中（大小写不敏感）；报告日期 ≥ 时效基线（见 acceptEvidenceStaleness）。
//   失败明细统一走 reason（六值）：evidence_missing / evidence_outside_project / evidence_empty /
//   evidence_not_image / evidence_failed / evidence_stale；时效无法判定时记 warning evidence_time_unknown（不阻断）。
// ==========================================================================
/** 工作台共享层根（证据允许放在这里）：<仓库>/src 与 <仓库>/团队/工具。项目根由调用方传入。 */
function sharedEvidenceRoots() {
  const repo = path.resolve(__dirname, '..');
  return [path.join(repo, 'src'), path.join(repo, '团队', '工具')];
}
function evidenceMagic(buf) {
  if (buf.length >= 4 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpg';
  if (buf.length >= 12 && buf.slice(0, 4).toString('ascii') === 'RIFF' && buf.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return '';
}
/** 从报告正文里取最近一个日期（支持 2026-11-12 / 2026/11/12 / 2026.11.12）；取不到返回 ''。 */
function latestDateInText(text) {
  const found = [];
  const re = /(20\d{2})[-/年.](\d{1,2})[-/月.](\d{1,2})/g;
  let m = re.exec(String(text || ''));
  while (m) {
    const iso = `${m[1]}-${String(m[2]).padStart(2, '0')}-${String(m[3]).padStart(2, '0')}T00:00:00.000Z`;
    if (Number.isFinite(Date.parse(iso))) found.push(iso);
    m = re.exec(String(text || ''));
  }
  if (!found.length) return '';
  return found.sort().slice(-1)[0];
}
function acceptEvidenceCheck(projectPath, evidence) {
  const projectRoot = (() => {
    try { return fs.realpathSync(path.resolve(String(projectPath || ''))); } catch { return path.resolve(String(projectPath || '')); }
  })();
  const raw = Array.isArray(evidence) ? evidence.slice(0, 12) : [];
  const missing = [];
  const warnings = [];
  const accepted = [];
  for (const item of raw) {
    const rel = String((item && (item.path || item.rel)) || '').trim();
    const kind = String((item && item.kind) || '').toLowerCase() || 'file';
    if (!rel) { missing.push({ path: '', kind, reason: 'evidence_missing', note: '没写证据路径' }); continue; }
    const absRaw = path.isAbsolute(rel) ? rel : path.resolve(projectRoot, rel);
    if (!fs.existsSync(absRaw)) { missing.push({ path: rel, kind, reason: 'evidence_missing', note: '文件不存在' }); continue; }
    let abs = absRaw;
    try { abs = fs.realpathSync(absRaw); } catch { /* 解析失败按原路径判越界 */ }
    const sharedRoots = sharedEvidenceRoots().map((root) => {
      try { return fs.realpathSync(root); } catch { return path.resolve(root); }
    });
    const inProject = isInside(projectRoot, abs);
    const inShared = sharedRoots.some((root) => isInside(root, abs));
    if (!inProject && !inShared) {
      missing.push({ path: rel, kind, reason: 'evidence_outside_project', note: 'realpath 后既不在项目目录、也不在共享层（src、团队/工具）内（.. 或软链逃逸）' });
      continue;
    }
    let st = null;
    try { st = fs.statSync(abs); } catch { st = null; }
    if (!st || !st.isFile()) { missing.push({ path: rel, kind, reason: 'evidence_missing', note: '不是普通文件' }); continue; }
    if (st.size <= 0) { missing.push({ path: rel, kind, reason: 'evidence_empty', note: '0 字节' }); continue; }
    const buf = fs.readFileSync(abs);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    const claimed = String((item && item.sha256) || '').toLowerCase();
    if (claimed && claimed !== sha) { missing.push({ path: rel, kind, reason: 'evidence_failed', note: 'HASH_MISMATCH' }); continue; }
    let reportAt = '';
    if (kind === 'screenshot') {
      const magic = evidenceMagic(buf);
      if (!magic) { missing.push({ path: rel, kind, reason: 'evidence_not_image', note: '文件头不是 PNG/JPEG/WebP' }); continue; }
    } else if (kind === 'report') {
      const text = buf.toString('utf8');
      if (!/\bPASS\b/i.test(text)) { missing.push({ path: rel, kind, reason: 'evidence_failed', note: '报告正文没有 PASS' }); continue; }
      if (/\bFAIL\b/i.test(text)) { missing.push({ path: rel, kind, reason: 'evidence_failed', note: '报告正文出现 FAIL' }); continue; }
      reportAt = latestDateInText(text);
      if (!reportAt) warnings.push({ path: rel, kind, reason: 'evidence_time_unknown', note: '报告里找不到日期' });
    }
    accepted.push({ path: rel, sha256: sha, kind, size: st.size, ...(reportAt ? { at: reportAt } : {}) });
  }
  if (!accepted.some((row) => row.kind === 'report')) missing.push({ path: '', kind: 'report', reason: 'evidence_missing', note: '缺测试报告' });
  if (!accepted.some((row) => row.kind === 'screenshot')) missing.push({ path: '', kind: 'screenshot', reason: 'evidence_missing', note: '缺截图' });
  return { ok: missing.length === 0, evidence: accepted, missing, warnings };
}
/** 证据时效：报告日期 ≥ 基线（reviewedAt 优先，回退 updatedAt）；两边都缺 → warning evidence_time_unknown。
 *  日期按「天」比较（报告正文只写 YYYY-MM-DD）：同一天不算过期，只有报告日 < 基线日 才 stale。 */
function acceptEvidenceStaleness(evidence, baselineAt) {
  const baseMs = Date.parse(String(baselineAt || ''));
  if (!Number.isFinite(baseMs)) return { ok: true, warning: 'evidence_time_unknown', baselineAt: '' };
  const report = (evidence || []).find((row) => row.kind === 'report') || null;
  const reportMs = Date.parse(String((report && report.at) || ''));
  if (!Number.isFinite(reportMs)) return { ok: true, warning: 'evidence_time_unknown', baselineAt: String(baselineAt || '') };
  const day = (ms) => new Date(ms).toISOString().slice(0, 10);
  if (day(reportMs) < day(baseMs)) {
    return { ok: false, warning: '', reason: 'evidence_stale', baselineAt: String(baselineAt || ''), reportAt: String(report.at || '') };
  }
  return { ok: true, warning: '', baselineAt: String(baselineAt || ''), reportAt: String(report.at || '') };
}


/**
 * 从工具输出里取 JSON。优先整段解析；工具偶尔在 JSON 前后打印日志，
 * 就按括号配对扫出最后一个完整对象。
 */
function extractJson(text) {
  if (!text) return null;
  const raw = String(text).replace(/^\uFEFF/, '');
  const trimmed = raw.trim();
  if (!trimmed) return null;
  try {
    const direct = JSON.parse(trimmed);
    return direct && typeof direct === 'object' ? direct : null;
  } catch { /* 继续扫描 */ }

  const candidates = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < raw.length; i++) {
    const ch = raw[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{') {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === '}') {
      if (depth > 0) {
        depth--;
        if (depth === 0 && start >= 0) {
          candidates.push(raw.slice(start, i + 1));
          start = -1;
        }
      }
    }
  }
  for (let i = candidates.length - 1; i >= 0; i--) {
    try {
      const value = JSON.parse(candidates[i]);
      if (value && typeof value === 'object') return value;
    } catch { /* 继续找 */ }
  }
  return null;
}

function firstFailureLine(text) {
  const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  return lines.find((line) => DSH_DOWN_RE.test(line))
    || lines.find((line) => /Error|failed|失败|不存在|找不到|未初始化|secret|credentials/i.test(line))
    || lines[0]
    || '';
}

/**
 * 团队项目名必须满足 workspace.mjs 的规则：1-40 字，且不含 \ / : * ? " < > |。
 * 中文、空格、· 等都可以保留；超长/带非法字符时在这里规范化，避免工具直接拒绝。
 */
function cleanProjectName(raw, fallbackPath) {
  let name = String(raw == null ? '' : raw).trim();
  if (!name && fallbackPath) name = path.basename(String(fallbackPath));
  name = name
    .replace(/[\\/:*?"<>|]/g, '-')
    .replace(/[\u0000-\u001f]/g, '-')
    .replace(/\s+/g, ' ')
    .trim();
  if (!name || name === '.' || name === '..') name = '项目';
  if (name.length > 40) name = name.slice(0, 40).trim();
  return name || '项目';
}

function isValidTeamName(name) {
  const value = String(name || '').trim();
  return Boolean(value)
    && value.length <= 40
    && value !== '.'
    && value !== '..'
    && !/[\\/:*?"<>|]/.test(value);
}

/**
 * 与 core.mjs 的 slug() 保持一致：团队状态目录名 = 项目名 slug(60)。
 * 派单锁、项目登记都在 <团队>/状态/项目/<slug>/ 下，读锁必须用同一个算法。
 */
function teamSlug(value, max = 60) {
  const cleaned = String(value == null ? '' : value)
    .replace(/[^\w\u4e00-\u9fa5.-]+/g, '_')
    .replace(/^_+|_+$/g, '');
  const base = cleaned || 'x';
  if (base.length <= max) return base;
  return base.slice(0, max - 9) + '-' + crypto.createHash('sha256').update(base).digest('hex').slice(0, 8);
}

function buildLayout(teamRoot, toolsDir) {
  const root = path.resolve(teamRoot);
  const toolRoot = path.resolve(toolsDir || path.join(repoRoot(), '团队', '工具'));
  return {
    root,
    toolRoot,
    teamTool: path.join(toolRoot, 'team.mjs'),
    workspaceTool: path.join(toolRoot, 'workspace.mjs'),
    launchTool: path.join(toolRoot, 'launch.mjs'),
    state: path.join(root, '状态'),
    teamFile: path.join(root, '状态', '团队.json'),
    projectsDir: path.join(root, '状态', '项目'),
    currentWorkspaceFile: path.join(root, '状态', '当前工作区.json'),
    sessionsFile: path.join(root, '状态', '会话.json'),
    receiptsFile: path.join(root, '状态', '回执.jsonl'),
    // 旧协议邮箱：<团队>/状态/邮箱/<role>/new|cur/*.json
    mailDir: path.join(root, '状态', '邮箱'),
    boardHtml: path.join(root, '看板.html'),
    boardMd: path.join(root, '看板.md'),
    boardJson: path.join(root, '状态', '看板.json'),
    dashboard: path.join(root, '状态', '看板.md'),
    // 旧版“工作台\项目”；新版工作台的默认项目根是仓库内 projects/。
    localProjectsRoot: path.join(repoRoot(), 'projects')
  };
}

function teamSummary(team) {
  if (!team || typeof team !== 'object') return null;
  const members = Array.isArray(team.members) ? team.members : [];
  return {
    name: team.name || '团队工作台',
    phase: team.phase || '',
    owner: team.owner || '',
    activeProject: team.activeProject || null,
    createdAt: team.createdAt || null,
    memberCount: members.length,
    members: members.map((member) => ({
      role: member.role || '',
      name: member.name || ROLE_NAMES[member.role] || member.role || '',
      status: member.status || '',
      hasSession: Boolean(member.sessionId)
    }))
  };
}

function failure(code, message, extra = {}) {
  return {
    ok: false,
    code,
    errorCode: code,
    message,
    why: message,
    details: {},
    ...extra
  };
}

function publicRun(run) {
  return {
    ok: Boolean(run.ok),
    code: run.ok ? 'OK' : (run.errorCode || 'TOOL_ERROR'),
    why: run.message || '',
    message: run.message || '',
    details: run.details || {},
    exitCode: run.exitCode,
    timedOut: Boolean(run.timedOut),
    tool: run.tool,
    ms: run.ms,
    stdout: tail(run.stdout),
    stderr: tail(run.stderr)
  };
}

/**
 * 旧版 team:workspaces 的过滤规则：工作台根目录不算工作区，QQ 桥和默认工作区也不算。
 * 保留它是为了让“项目清单”和老版本看到的是同一批目录。
 */
function isIgnoredWorkspace(target) {
  const abs = path.resolve(String(target || ''));
  if (abs.toLowerCase() === repoRoot().toLowerCase()) return true;
  return /\\qq-bridge\\|\\default-workspace(\\|$)/i.test(abs);
}

/**
 * 旧版会扫描“工作台\项目”把未登记目录也列出来；新版对应仓库内 projects/。
 * 只列真实目录，且跳过隐藏目录、下划线目录和工作台根。
 */
function localProjectDirs(layout) {
  const out = [];
  let entries;
  try {
    entries = fs.readdirSync(layout.localProjectsRoot, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name.startsWith('.') || entry.name.startsWith('_')) continue;
    const abs = path.join(layout.localProjectsRoot, entry.name);
    if (isIgnoredWorkspace(abs)) continue;
    out.push(abs);
  }
  return out;
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

/** 浅合并对象；非对象忽略。后给的字段覆盖先给的字段。 */
function mergePlainObjects(...values) {
  const out = {};
  for (const value of values) {
    if (isPlainObject(value)) Object.assign(out, value);
  }
  return out;
}

/**
 * acceptance 只接受命名属性。旧壳曾把「验收标准字符串」展开成 acceptance，
 * 留下 "0","1"… 数字键；这些不是认证字段，也不能继续传播到新记录。
 */
function acceptanceFields(value) {
  if (!isPlainObject(value)) return null;
  const out = {};
  for (const [key, item] of Object.entries(value)) {
    if (/^\d+$/.test(key)) continue;
    out[key] = item;
  }
  return out;
}

const OWNER_AUTH_KEYS = ['actor', 'channel', 'nonceHash', 'confirmedAt', 'confirmedBy', 'identitySource'];

/**
 * 合并旧命令写下的 Owner 认证字段。
 *
 * 旧命令可能把 actor/channel/confirmation 放在 requirement.workflow.ownerReview、
 * 顶层 ownerReview、顶层 confirmation 或已经写好的 工作流.json 里；壳层只补
 * 缺失字段，绝不能用一个“新对象”把它们覆盖掉。confirmation 按字段合并，
 * 因为 nonceHash 常常只出现在顶层 confirmation，而 actor/channel 在行记录里。
 */
function mergeOwnerAuthFields(...sources) {
  const out = {};
  let confirmation = null;
  for (const source of sources) {
    if (!isPlainObject(source)) continue;
    for (const key of OWNER_AUTH_KEYS) {
      const value = source[key];
      if (value === undefined || value === null || String(value).trim() === '') continue;
      out[key] = value;
    }
    if (isPlainObject(source.confirmation)) {
      confirmation = confirmation || {};
      for (const [key, value] of Object.entries(source.confirmation)) {
        if (value === undefined || value === null || String(value).trim() === '') continue;
        confirmation[key] = value;
      }
    }
  }
  if (confirmation) {
    out.confirmation = confirmation;
  } else if (out.channel || out.nonceHash) {
    out.confirmation = {
      ...(out.channel ? { channel: out.channel } : {}),
      ...(out.nonceHash ? { nonceHash: out.nonceHash } : {})
    };
  }
  return out;
}

function createTeamTools(options = {}) {
  const initialRoot = options.teamRoot || process.env.TEAM_ROOT || path.join(repoRoot(), '团队');
  const layout = buildLayout(initialRoot, options.toolsDir);
  const nodeExe = options.nodeExe || process.env.AWB_NODE || process.execPath;
  const cwd = options.cwd || repoRoot();
  const baseEnv = { ...process.env, ...(options.env || {}) };
  // 仅测试注入：模拟旧工具已经实现的 req review / owner / workflow 命令。
  // 生产路径永远不设这个字段，缺命令就必须明确失败，不能靠本地文件冒充流程。
  const legacyMock = options.legacyMock && typeof options.legacyMock === 'object' ? options.legacyMock : null;
  // 工具的 core.mjs 支持 TEAM_ROOT；显式对齐，保证“看的状态”和“跑的工具”是同一个根。
  baseEnv.TEAM_ROOT = layout.root;
  if (process.versions.electron) {
    baseEnv.ELECTRON_RUN_AS_NODE = '1';
  }

  function toolInfo() {
    const team = { file: layout.teamTool, exists: fs.existsSync(layout.teamTool) };
    const workspace = { file: layout.workspaceTool, exists: fs.existsSync(layout.workspaceTool) };
    const launch = { file: layout.launchTool, exists: fs.existsSync(layout.launchTool) };
    return {
      teamRoot: layout.root,
      toolRoot: layout.toolRoot,
      nodeExe,
      team,
      workspace,
      launch,
      available: team.exists && workspace.exists && launch.exists
    };
  }

  function runNode(toolFile, args, runOptions = {}) {
    const timeoutMs = Number(runOptions.timeoutMs) > 0 ? Number(runOptions.timeoutMs) : TIMEOUTS.ensure;
    const startedAt = Date.now();
    return new Promise((resolve) => {
      let settled = false;
      const finish = (result) => {
        if (settled) return;
        settled = true;
        resolve(result);
      };
      try {
        execFile(nodeExe, [toolFile, ...args.map(String)], {
          cwd,
          encoding: 'utf8',
          timeout: timeoutMs,
          windowsHide: true,
          maxBuffer: MAX_BUFFER,
          env: { ...baseEnv, ...(runOptions.env || {}) }
        }, (err, stdout, stderr) => {
          const out = String(stdout || '');
          const errText = String(stderr || '');
          const parsed = extractJson(out) || extractJson(errText);
          const ms = Date.now() - startedAt;
          const exitCode = err
            ? (typeof err.code === 'number' ? err.code : (err.code === 'ENOENT' ? -2 : 1))
            : 0;
          const timedOut = Boolean(err && (err.killed || err.signal === 'SIGTERM' || err.code === 'ETIMEDOUT'));
          const base = {
            tool: path.basename(toolFile),
            args,
            exitCode,
            json: parsed,
            stdout: out,
            stderr: errText,
            ms,
            timedOut
          };
          if (timedOut) {
            return finish({
              ...base,
              ok: false,
              errorCode: 'TIMEOUT',
              message: `团队工具超时（${Math.round(timeoutMs / 1000)} 秒）：${path.basename(toolFile)}`
            });
          }
          if (err && (err.code === 'ENOENT' || err.code === 'EACCES')) {
            return finish({
              ...base,
              ok: false,
              errorCode: 'TOOL_MISSING',
              message: `找不到 Node 或团队工具：${nodeExe} / ${toolFile}`
            });
          }
          if (exitCode !== 0) {
            if (parsed && parsed.ok === false) {
              return finish({
                ...base,
                ok: false,
                errorCode: parsed.code || 'TOOL_ERROR',
                message: String(parsed.message || `团队工具返回退出码 ${exitCode}`),
                details: parsed.details && typeof parsed.details === 'object' ? parsed.details : {}
              });
            }
            return finish({
              ...base,
              ok: false,
              errorCode: 'TOOL_EXIT',
              message: firstFailureLine(errText) || firstFailureLine(out) || `团队工具返回退出码 ${exitCode}`
            });
          }
          if (!parsed) {
            return finish({
              ...base,
              ok: false,
              errorCode: 'BAD_JSON',
              message: '团队工具没有返回可解析的 JSON（可能被日志或编码打断）'
            });
          }
          return finish({ ...base, ok: true, value: parsed, businessOk: parsed.ok !== false });
        });
      } catch (error) {
        finish({
          ok: false,
          errorCode: 'SPAWN_ERROR',
          message: `启动团队工具失败：${String(error && error.message || error)}`,
          exitCode: null,
          timedOut: false,
          tool: path.basename(toolFile),
          args,
          stdout: '',
          stderr: '',
          ms: Date.now() - startedAt
        });
      }
    });
  }

  function readRegistrations() {
    const out = [];
    let entries;
    try {
      entries = fs.readdirSync(layout.projectsDir, { withFileTypes: true });
    } catch {
      return out;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const stateDir = path.join(layout.projectsDir, entry.name);
      const data = readJsonSafe(path.join(stateDir, '项目.json'));
      if (data && data.name) out.push({ ...data, stateDir });
    }
    return out;
  }

  /** 团队项目状态目录（与 core.mjs slug 完全一致），看板/任务/提案/提交/回执都在这里。 */
  function projectStatePaths(projectName) {
    const dir = projectStateDir(projectName);
    return {
      dir,
      config: path.join(dir, '项目.json'),
      tasks: path.join(dir, '任务'),
      proposals: path.join(dir, '提案'),
      commits: path.join(dir, '提交'),
      lock: path.join(dir, '派单锁.json')
    };
  }

  /** R-b52b F-7：项目角色集只认 项目.json.roleIds（缺省才回退团队模式）；壳层与团队工具同一口径。 */
  function projectRoleIdsOf(projectName) {
    let cfg = null;
    try { cfg = readJsonSafe(path.join(projectStateDir(projectName), '项目.json')); } catch { cfg = null; }
    const explicit = cfg && Array.isArray(cfg.roleIds) ? cfg.roleIds.map((id) => String(id || '').trim()).filter(Boolean) : [];
    if (explicit.length) return explicit;
    return roleIdsForTeamMode(normalizeTeamMode(cfg && cfg.teamMode));
  }

  function writeJsonAtomic(file, data) {    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.awb-tmp-' + process.pid + '-' + crypto.randomUUID().slice(0, 8);
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
    try {
      fs.renameSync(tmp, file);
    } catch {
      fs.copyFileSync(tmp, file);
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  function writeTextAtomic(file, text) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = file + '.awb-tmp-' + process.pid + '-' + crypto.randomUUID().slice(0, 8);
    fs.writeFileSync(tmp, text, 'utf8');
    try {
      fs.renameSync(tmp, file);
    } catch {
      fs.copyFileSync(tmp, file);
      try { fs.unlinkSync(tmp); } catch { /* ignore */ }
    }
  }

  function safeStateId(value) {
    const text = String(value || '').trim();
    if (!text || !/^[A-Za-z0-9][A-Za-z0-9._-]{0,80}$/.test(text)) return '';
    return text;
  }

  /**
   * 全局 团队.json 是旧协议唯一名册；ensure/board 会切换 activeProject，
   * 名册里的 sessionId 必须同步成当前项目映射，避免“activeProject=A、名册=B 的会话”。
   */
  function syncRoster(projectName, sessions) {
    const name = String(projectName || '').trim();
    if (!name || !sessions || typeof sessions !== 'object') return { ok: false, code: 'BAD_ROSTER' };
    const team = readJsonSafe(layout.teamFile);
    if (!team || !Array.isArray(team.members)) return { ok: false, code: 'NO_TEAM' };
    let changed = 0;
    if (team.activeProject !== name) { team.activeProject = name; changed += 1; }
    // 名册必须是“当前项目”的快照：不在 sessions 里的角色一律清空 sessionId。
    // 只补不清会让项目 B 回退到项目 A 的角色会话，旧协议就能跨项目发件/回执。
    for (const member of team.members) {
      const sid = sessions[member.role] ? String(sessions[member.role]) : '';
      if (String(member.sessionId || '') !== sid) {
        member.sessionId = sid;
        changed += 1;
      }
    }
    for (const role of ROLE_IDS) {
      if (!sessions[role]) continue;
      if (team.members.some((member) => member.role === role)) continue;
      team.members.push({
        role,
        name: ROLE_NAMES[role] || role,
        status: 'active',
        joinedAt: new Date().toISOString(),
        sessionId: String(sessions[role])
      });
      changed += 1;
    }
    if (changed) {
      try { writeJsonAtomic(layout.teamFile, team); } catch (error) {
        return { ok: false, code: 'ROSTER_WRITE_FAILED', message: String(error && error.message || error).slice(0, 200) };
      }
    }
    return { ok: true, code: changed ? 'ROSTER_SYNCED' : 'ROSTER_UNCHANGED', changed };
  }

  function registrationFor(projectName) {
    const name = String(projectName || '').trim();
    if (!name) return null;
    return readRegistrations().find((item) => item.name === name) || null;
  }

  function resolveProjectName(project, registrations) {
    const projectPath = path.resolve(String(project && project.path || ''));
    const key = projectPath.toLowerCase();
    const byPath = registrations.find((item) => item.path
      && path.resolve(String(item.path)).toLowerCase() === key
      && isValidTeamName(item.name));
    if (byPath) return String(byPath.name);
    const base = cleanProjectName(project && project.name, projectPath);
    const collision = registrations.find((item) => item.name === base
      && item.path
      && path.resolve(String(item.path)).toLowerCase() !== key);
    if (!collision) return base;
    const suffix = crypto.createHash('sha1').update(key).digest('hex').slice(0, 6);
    const head = base.slice(0, 33).replace(/[-. ]+$/, '') || '项目';
    return (head + '-' + suffix).slice(0, 40);
  }

  async function ensureInitialized() {
    if (fs.existsSync(layout.teamFile)) {
      const team = readJsonSafe(layout.teamFile);
      if (team && Array.isArray(team.members)) {
        return { ok: true, code: 'OK', initialized: true, created: false, team: teamSummary(team) };
      }
      return failure('TEAM_STATE_BAD', `团队状态文件无法解析：${layout.teamFile}`, { initialized: true });
    }
    if (!fs.existsSync(layout.teamTool)) {
      return failure('TOOL_MISSING', `团队工具不存在：${layout.teamTool}`, { initialized: false });
    }
    const run = await runNode(layout.teamTool, ['init', '--json'], { timeoutMs: TIMEOUTS.init });
    if (!run.ok) {
      return { ...publicRun(run), ok: false, initialized: false, stage: 'init' };
    }
    const value = run.value || {};
    if (value.ok === false) {
      return failure(value.code || 'INIT_FAILED', value.message || '团队初始化失败', { initialized: false, stage: 'init' });
    }
    return {
      ok: true,
      code: 'OK',
      initialized: true,
      created: true,
      createdFiles: Array.isArray(value.created) ? value.created.length : 0,
      team: teamSummary(value.team),
      stdout: tail(run.stdout),
      stderr: tail(run.stderr)
    };
  }

  async function ensureProject(project, ensureOptions = {}) {
    const source = project || {};
    const projectPath = String(source.path || '').trim();
    if (!projectPath) {
      return failure('PROJECT_PATH_REQUIRED', '项目目录不能为空');
    }
    const resolvedPath = path.resolve(projectPath);
    if (!isDirectory(resolvedPath)) {
      return failure('PROJECT_DIR_MISSING', `项目目录不存在：${resolvedPath}`, { projectPath: resolvedPath });
    }
    if (!fs.existsSync(layout.workspaceTool)) {
      return failure('TOOL_MISSING', `团队工作区工具不存在：${layout.workspaceTool}`, { projectPath: resolvedPath });
    }
    const init = await ensureInitialized();
    if (!init.ok) {
      return { ...init, ok: false, stage: 'init', projectPath: resolvedPath };
    }
    // 调用方显式给了团队名（状态库已确认）时原样使用，不允许静默改成哈希名；
    // 只有旧记录/直接调用才按目录与登记表推导。
    const requested = String(ensureOptions.name || source.teamName || '').trim();
    const name = requested && isValidTeamName(requested)
      ? requested
      : resolveProjectName({ name: source.name, path: resolvedPath }, readRegistrations());
    // 团队模式必须交给旧 workspace.mjs 自己写 项目.json/workspace.json：
    // 旧工具已经支持 --team-mode，壳不再手写这两份私有格式。
    const mode = normalizeTeamMode(ensureOptions.teamMode || source.teamMode);
    const args = ['ensure', '--name', name, '--path', resolvedPath, '--team-mode', mode, '--json'];
    // 旧版只在目录位于工作台/项目区之外时才带 --allow-external；这里保持同样的默认，
    // 但允许调用方显式关闭，避免把“外部目录”当成默认前提。
    if (ensureOptions.allowExternal !== false) args.push('--allow-external');
    if (ensureOptions.engineUrl) args.push('--engine-url', String(ensureOptions.engineUrl));
    const run = await runNode(layout.workspaceTool, args, { timeoutMs: TIMEOUTS.ensure });
    if (!run.ok) {
      return {
        ...publicRun(run),
        ok: false,
        stage: 'ensure',
        name,
        projectPath: resolvedPath,
        initialized: true
      };
    }
    const value = run.value || {};
    if (value.ok === false) {
      return failure(value.code || 'ENSURE_FAILED', value.message || '团队项目补齐失败', {
        stage: 'ensure',
        name,
        projectPath: resolvedPath,
        initialized: true
      });
    }
    return {
      ok: true,
      code: 'OK',
      stage: 'ensure',
      ensure: true,
      initialized: true,
      name,
      projectPath: resolvedPath,
      teamMode: mode,
      engineUrl: ensureOptions.engineUrl || null,
      workspace: value.workspace || null,
      project: value.project || null,
      index: value.index || null,
      renamed: name !== cleanProjectName(source.name, resolvedPath),
      stdout: tail(run.stdout),
      stderr: tail(run.stderr),
      ms: run.ms
    };
  }

  async function listWorkspaces() {
    const initialized = fs.existsSync(layout.teamFile);
    const team = readJsonSafe(layout.teamFile);
    const registrations = readRegistrations();
    let listValue = null;
    let warning = null;
    if (initialized && fs.existsSync(layout.teamTool)) {
      const run = await runNode(layout.teamTool, ['project', 'list', '--json'], { timeoutMs: TIMEOUTS.list });
      if (run.ok && run.value && Array.isArray(run.value.projects)) {
        listValue = run.value;
      } else {
        warning = {
          code: run.ok ? 'BAD_PROJECT_LIST' : (run.errorCode || 'TOOL_ERROR'),
          message: run.message || '团队项目列表读取失败，已回退为直接读取状态文件'
        };
      }
    }
    const source = listValue ? listValue.projects : registrations;
    const seenNames = new Set();
    const seenPaths = new Set();
    const projects = [];
    const addProject = (entry) => {
      const name = String(entry && entry.name || '');
      if (!name || seenNames.has(name)) return;
      const rawPath = String(entry.path || '');
      const pathKey = rawPath ? path.resolve(rawPath).toLowerCase() : '';
      if (pathKey && isIgnoredWorkspace(rawPath)) return;
      if (pathKey && seenPaths.has(pathKey)) return;
      seenNames.add(name);
      if (pathKey) seenPaths.add(pathKey);
      const projectPath = rawPath;
      const workspaceMeta = projectPath ? readJsonSafe(path.join(projectPath, 'workspace.json')) : null;
      const sessionManifest = projectPath ? readJsonSafe(path.join(projectPath, '团队会话.json')) : null;
      projects.push({
        name,
        path: projectPath,
        desc: entry.desc || '',
        status: entry.status || 'active',
        registered: entry.registered !== false,
        source: entry.source || 'team',
        exists: Boolean(projectPath) && isDirectory(projectPath),
        hasWorkspaceMeta: Boolean(workspaceMeta),
        dshWorkspaceId: (workspaceMeta && workspaceMeta.dshWorkspaceId) || entry.dshWorkspaceId || null,
        current: Boolean(team && team.activeProject === name),
        sessions: sessionManifest ? {
          count: Array.isArray(sessionManifest.roles) ? sessionManifest.roles.length : 0,
          generatedAt: sessionManifest.generatedAt || null,
          workspaceId: sessionManifest.workspaceId || null
        } : null
      });
    };
    for (const item of source) {
      const registration = registrations.find((entry) => entry.name === item.name) || {};
      addProject({
        name: item.name,
        path: registration.path || item.path,
        desc: registration.desc || item.desc,
        status: registration.status || item.status || 'active',
        dshWorkspaceId: registration.dshWorkspaceId,
        registered: true,
        source: 'team'
      });
    }
    // 旧版会同时列出“工作台\项目”里的本地目录；这里列仓库 projects/ 下尚未登记的目录。
    for (const dir of localProjectDirs(layout)) {
      const meta = readJsonSafe(path.join(dir, 'workspace.json'));
      addProject({
        name: (meta && meta.name) || path.basename(dir),
        path: dir,
        desc: '本地项目目录',
        status: 'local',
        dshWorkspaceId: meta && meta.dshWorkspaceId,
        registered: false,
        source: 'local'
      });
    }
    // 项目清单排序与旧版一致：当前项目优先，其余按中文名称。
    projects.sort((a, b) => (Number(b.current) - Number(a.current)) || a.name.localeCompare(b.name, 'zh-CN'));
    const items = projects.map((item) => ({
      name: item.name,
      path: item.path,
      dshWorkspaceId: item.dshWorkspaceId,
      desc: item.desc,
      current: item.current,
      registered: item.registered,
      exists: item.exists
    }));
    const current = projects.find((item) => item.current) || null;
    let boardGeneratedAt = null;
    try { boardGeneratedAt = fs.statSync(layout.boardJson).mtime.toISOString(); } catch { /* 未生成 */ }
    return {
      ok: true,
      initialized,
      team: teamSummary(team),
      teamRoot: layout.root,
      projects,
      // 旧版 team:workspaces 返回 items/current；保留一份同形字段给旧调用方。
      items,
      current,
      activeProject: team && team.activeProject || null,
      currentWorkspace: readJsonSafe(layout.currentWorkspaceFile),
      board: {
        html: layout.boardHtml,
        md: layout.boardMd,
        json: layout.boardJson,
        exists: fs.existsSync(layout.boardHtml),
        generatedAt: boardGeneratedAt
      },
      tool: toolInfo(),
      warning
    };
  }

  /** 旧版 team:status：团队 / 会话记录 / 看板 / 当前工作区 + 工具是否存在。 */
  function teamStatus() {
    const tool = toolInfo();
    return {
      ok: true,
      teamRoot: layout.root,
      team: readJsonSafe(layout.teamFile),
      sessions: readJsonSafe(layout.sessionsFile),
      board: readJsonSafe(layout.boardJson),
      currentWorkspace: readJsonSafe(layout.currentWorkspaceFile),
      tools: {
        team: tool.team.exists,
        launch: tool.launch.exists,
        workspace: tool.workspace.exists,
        boardHtml: fs.existsSync(layout.boardHtml)
      }
    };
  }

  /** 旧版 team:members：读项目目录里的 团队会话.json（由 launch.mjs 写入）。 */
  function readSessionManifest(projectPath) {
    const dir = String(projectPath || '').trim();
    if (!dir) return null;
    return readJsonSafe(path.join(path.resolve(dir), '团队会话.json'));
  }

  function quickInfo() {
    try {
      const initialized = fs.existsSync(layout.teamFile);
      const team = initialized ? readJsonSafe(layout.teamFile) : null;
      const registrations = readRegistrations();
      let boardGeneratedAt = null;
      try { boardGeneratedAt = fs.statSync(layout.boardJson).mtime.toISOString(); } catch { /* 未生成 */ }
      return {
        initialized,
        toolExists: fs.existsSync(layout.teamTool) && fs.existsSync(layout.workspaceTool) && fs.existsSync(layout.launchTool),
        teamRoot: layout.root,
        projectCount: registrations.length,
        activeProject: team && team.activeProject || null,
        phase: team && team.phase || null,
        boardExists: fs.existsSync(layout.boardHtml),
        boardGeneratedAt
      };
    } catch (error) {
      return {
        initialized: false,
        toolExists: false,
        teamRoot: layout.root,
        projectCount: 0,
        activeProject: null,
        phase: null,
        boardExists: false,
        boardGeneratedAt: null,
        error: String(error && error.message || error)
      };
    }
  }

  function mapTaskStatus(status) {
    const value = String(status || '').toLowerCase();
    if (value === 'done') return 'done';
    if (value === 'doing' || value === 'working' || value === 'review' || value === 'reviewing') return 'working';
    return 'open';
  }

  function mapProposalStatus(status) {
    const value = String(status || '').toLowerCase();
    if (value === 'applied') return 'applied';
    if (value === 'approved') return 'approved';
    if (value === 'rejected' || value === 'stale') return 'rejected';
    return 'proposed';
  }

  /**
   * Owner 决定写回旧版 工作流.json（<团队>/状态/项目/<slug>/工作流.json）。
   * 旧版消费者只认 ownerReview.required/status/by/at；这里保留其它字段并补 roundKey/opinion。
   */
  function ownerDecisionBasis(project, requirementId) {
    const root = path.resolve(String((project && project.path) || ''));
    let requirement = { path: '', sha256: '', contentHash: '' };
    try {
      const docs = readRequirementDocs(root);
      const doc = docs.list.find((row) => String(row.id) === String(requirementId));
      if (doc) requirement = { path: doc.rel, sha256: doc.hash, contentHash: doc.contentHash || '' };
    } catch { /* 保持空 */ }
    let design = { path: '', sha256: '', version: '' };
    try {
      const dirs = ['产品/产出', '需求分析师/产出'];
      const candidates = [];
      for (const dir of dirs) {
        let names = [];
        try { names = fs.readdirSync(path.join(root, dir)); } catch { names = []; }
        for (const name of names) {
          const match = /(?:产品设计|需求分析)-v(\d+)\.md$/i.exec(name);
          if (!match) continue;
          const file = path.join(root, dir, name);
          const version = Number(match[1]) || 0;
          const stat = fs.statSync(file);
          candidates.push({ rel: `${dir}/${name}`, version, mtime: stat.mtimeMs, sha256: crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex') });
        }
      }
      candidates.sort((a, b) => (b.version - a.version) || (b.mtime - a.mtime));
      if (candidates[0]) design = { path: candidates[0].rel, sha256: candidates[0].sha256, version: `v${candidates[0].version}` };
    } catch { /* 保持空 */ }
    return { requirement, design, at: new Date().toISOString() };
  }

  function writeOwnerWorkflow(project, input = {}) {
    const name = String((project && (project.teamName || project.name)) || '').trim();
    if (!name) return failure('NO_PROJECT', '缺少团队项目名');
    const registration = registrationFor(name);
    if (!registration) {
      return {
        ok: false, code: 'NO_TEAM_PROJECT', name, skipped: true,
        message: `团队尚未登记项目「${name}」，Owner 决定只写工作台本地`
      };
    }
    const dir = projectStateDir(name);
    if (!fs.existsSync(dir)) {
      return { ok: false, code: 'NO_TEAM_STATE', name, skipped: true, message: `团队项目状态目录不存在：${dir}` };
    }
    const file = path.join(dir, '工作流.json');
    const previous = readJsonSafe(file) || {};
    const at = new Date().toISOString();
    const status = String(input.status || input.decision || '');
    const channel = String(input.channel || '');
    // 通道白名单：ui/tty = Owner 本人；proxy = 代管（PM 代落账 Owner 已给的决定，R-6f60 AC24.4）；
    // skip_committee = 三方共决跳过（开发+产品+分析师书面意见，多数通过，Owner 2026-11-13 规则）。
    if (!['ui', 'tty', 'proxy', 'skip_committee'].includes(channel)) {
      return failure('OWNER_CHANNEL_REQUIRED', 'Owner 决定必须显式带 channel=ui/tty（代管落账用 proxy、三方共决跳过用 skip_committee）；不再回退旧通道名');
    }
    if (channel === 'skip_committee') {
      if (status !== 'skipped') return failure('SKIP_COMMITTEE_INVALID', 'channel=skip_committee 只能用于“跳过”决定');
      const committeeIn = input.committee || {};
      const votes = [committeeIn.analyst, committeeIn.product, committeeIn.dev].map((t) => String(t || '').trim());
      if (votes.some((t) => !t)) return failure('SKIP_COMMITTEE_INCOMPLETE', '三方未齐：跳过必须开发、产品、分析师各写一句书面意见，缺一不得跳过');
      const approveCount = votes.filter((t) => /^(?!.*(?:不同意|不通过|不赞成|不可跳过|反对)).*(?:同意|通过|赞成|可跳过)/.test(t)).length;
      if (approveCount < 2) return failure('SKIP_COMMITTEE_REJECTED', `三方共决未通过：${approveCount}/3 写“同意”，至少 2 方同意才能跳过`);
    }
    if (channel === 'proxy') {
      // 异常条款：未取得 Owner 授权即写 proxy → PROXY_UNAUTHORIZED，不落半条。
      const proxyRecordedBy = String(input.recordedBy || '');
      const proxyAuthorization = String(input.authorization || '').trim();
      const proxyScope = String(input.proxy || '');
      if (proxyRecordedBy !== 'pm') return failure('PROXY_UNAUTHORIZED', '代管落账必须 recordedBy=pm（PM 只代记 Owner 决定，不自己决定）');
      if (!proxyAuthorization) return failure('PROXY_UNAUTHORIZED', '代管落账缺少 Owner 授权来源（authorization）：先取得 Owner 书面授权再落账');
      if (!['once', 'always'].includes(proxyScope)) return failure('PROXY_UNAUTHORIZED', '代管范围必须是 once 或 always');
    }
    const basis = input.basis || ownerDecisionBasis(project, String(input.requirementId || input.id || project.id || ''));
    const decisionRecord = {
      status,
      decision: status,
      channel,
      decidedBy: String(input.decidedBy || 'owner'),
      basis,
      at,
      actor: String(input.actor || 'owner'),
      by: String(input.by || 'Owner'),
      opinion: String(input.opinion || '').slice(0, 1000),
      roundKey: String(input.roundKey || ''),
      ...(input.recordedBy ? { recordedBy: String(input.recordedBy) } : {}),
      ...(input.proxy ? { proxy: String(input.proxy) } : {}),
      ...(input.authorization ? { authorization: String(input.authorization) } : {}),
      ...(input.committee ? { committee: input.committee } : {}),
    };
    const previousDecisions = (previous.ownerReview && Array.isArray(previous.ownerReview.decisions))
      ? previous.ownerReview.decisions.slice(-49) : [];
    const ownerReview = {
      ...((previous.ownerReview && typeof previous.ownerReview === 'object') ? previous.ownerReview : {}),
      required: true,
      status,
      by: String(input.by || 'Owner'),
      actor: 'owner',
      channel,
      decidedBy: String(input.decidedBy || 'owner'),
      basis,
      at,
      roundKey: String(input.roundKey || ''),
      opinion: String(input.opinion || '').slice(0, 1000),
      ...(input.committee ? { committee: input.committee } : {}),
      decisions: [...previousDecisions, decisionRecord],
    };
    const next = { ...previous, ownerReview, updatedAt: at };
    writeJsonAtomic(file, next);
    return { ok: true, code: 'OK', name, file, workflow: next };
  }

  /**
   * Owner 决定 = 写旧 工作流.json + 给 PM 写一条旧协议系统消息（owner-note.mjs）。
   * 只调用团队工具写邮箱，不调用 DSH session/prompt，不伪造 PM 会话。
   */
  async function recordOwnerDecision(project, input = {}) {
    let written;
    try {
      written = writeOwnerWorkflow(project, input);
    } catch (error) {
      const message = String(error && error.message || error).slice(0, 300);
      const warning = { code: 'WORKFLOW_WRITE_FAILED', message: '旧版 工作流.json 写入失败：' + message };
      return {
        ok: false,
        code: 'WORKFLOW_WRITE_FAILED',
        message,
        workflowFile: null,
        workflow: null,
        workflowWrite: { ok: false, attempted: true, code: warning.code, message: warning.message },
        notified: null,
        warnings: [warning],
        warning
      };
    }
    if (!written.ok) {
      const warning = {
        code: String(written.code || 'WORKFLOW_NOT_WRITTEN'),
        message: String(written.message || '旧版 工作流.json 未写入')
      };
      return {
        ...written,
        workflowFile: null,
        workflow: null,
        workflowWrite: { ok: false, attempted: true, code: warning.code, message: warning.message },
        notified: null,
        warnings: [warning],
        warning
      };
    }
    const notifiedTool = path.join(layout.toolRoot, 'owner-note.mjs');
    let notified = null;
    // B-719f：通知写进 PM 邮箱后必须把 PM 叫醒；唤醒失败只记 warning，不影响 decisions 落账与前端提示。
    let notifyWake = null;
    let warning = null;
    if (!fs.existsSync(notifiedTool)) {
      warning = { code: 'OWNER_NOTE_MISSING', message: '旧版 owner-note.mjs 不存在，PM 收件箱没有写入系统消息' };
    } else {
      const run = await runNode(notifiedTool, [
        written.name,
        String(input.status || input.decision || ''),
        String(input.opinion || ''),
        String(input.roundKey || '')
      ], { timeoutMs: TIMEOUTS.send });
      const value = run.value || {};
      if (run.ok && value && value.ok && value.message) {
        notified = value.message;
        notifyWake = value.wake || null;
        if (value.warning) {
          warning = { code: String(value.warning.code || 'OWNER_NOTE_WAKE_FAILED'), message: String(value.warning.message || 'PM 通知已写入，但唤醒失败').slice(0, 300) };
        }
      } else {
        warning = {
          code: String((value && value.error) || run.errorCode || 'OWNER_NOTE_FAILED'),
          message: String((value && value.error) || run.message || 'PM 系统消息写入失败').slice(0, 300)
        };
      }
    }
    return {
      ok: true,
      code: 'OK',
      name: written.name,
      file: written.file,
      workflow: written.workflow,
      workflowFile: written.file,
      // 写旧 工作流.json 的结果单独给一份：调用方不必从 file/workflow 是否为 null 反推。
      workflowWrite: { ok: true, attempted: true, code: 'OK', message: '' },
      notified,
      notifyWake,
      warnings: warning ? [warning] : [],
      warning
    };
  }

  /**
   * 把工作台自己的任务/提案/评审/签字/提交镜像进旧版看板数据源：
   *   <团队>/状态/项目/<slug>/任务/<id>.json
   *   <团队>/状态/项目/<slug>/提案/<id>/提案.json（含 评审/、签字/）
   *   <团队>/状态/项目/<slug>/提交/<id>.json
   * 只覆盖自己写过（source=workbench）的文件，绝不改旧 CLI 建的业务文件；
   * 重复调用是幂等的，因此既可以在写操作后增量同步，也能在生成看板前全量补齐。
   */
  function syncWorkbenchBoard(project, projectName) {
    // 真相方向只能是 旧状态 → 本地镜像。
    // 本地 workbench.json 的任务/提案/提交不允许反写旧 任务/提案/提交，
    // 否则本地删除/更新会覆盖角色的真实进度（旧 CLI 才是唯一业务写入口）。
    const name = String(projectName || (project && (project.teamName || project.name)) || '').trim();
    return {
      ok: true,
      code: 'MIRROR_ONLY',
      skipped: true,
      name,
      direction: 'none',
      truthSource: 'legacy-workflow',
      message: '本地 workbench.json 只做镜像；旧 工作流.json/任务/需求/提案 是唯一真相，禁止由本地反写',
      counts: { tasks: 0, proposals: 0, commits: 0, reviews: 0, signatures: 0 }
    };
  }

  function syncWorkbenchBoardLegacyWrite(project, projectName) {
    if (!project || typeof project !== 'object') {
      return failure('BAD_PROJECT', '同步看板需要项目对象');
    }
    const name = String(projectName || project.teamName || project.name || '').trim();
    if (!name) return failure('NO_PROJECT', '同步看板缺少项目名');
    const registration = registrationFor(name);
    if (!registration) {
      return { ok: true, code: 'NO_TEAM_PROJECT', name, skipped: true, counts: { tasks: 0, proposals: 0, commits: 0, reviews: 0, signatures: 0 } };
    }
    const paths = projectStatePaths(name);
    if (!fs.existsSync(paths.dir)) {
      return { ok: true, code: 'NO_TEAM_STATE', name, skipped: true, counts: { tasks: 0, proposals: 0, commits: 0, reviews: 0, signatures: 0 } };
    }
    fs.mkdirSync(paths.tasks, { recursive: true });
    fs.mkdirSync(paths.proposals, { recursive: true });
    fs.mkdirSync(paths.commits, { recursive: true });
    const counts = { tasks: 0, proposals: 0, commits: 0, reviews: 0, signatures: 0 };
    const nowIso = new Date().toISOString();

    const tasks = Array.isArray(project.tasks) ? project.tasks : [];
    const liveTaskIds = new Set();
    for (const task of tasks) {
      const taskId = safeStateId(task && task.id);
      if (!taskId) continue;
      liveTaskIds.add(taskId);
      const file = path.join(paths.tasks, taskId + '.json');
      const previous = readJsonSafe(file);
      if (previous && previous.source !== 'workbench' && previous.workbenchId !== taskId) continue;
      const status = mapTaskStatus(task.status);
      const record = {
        id: taskId,
        project: name,
        type: task.type || 'task',
        requirementId: String(task.requirementId || ''),
        title: String(task.title || taskId).slice(0, 120),
        detail: String(task.detail || ''),
        acceptance: String(task.acceptance || ''),
        story: String(task.story || ''),
        priority: ['P0', 'P1', 'P2', 'P3'].includes(String(task.priority)) ? String(task.priority) : 'P2',
        priorityBy: String(task.priorityBy || task.createdBy || 'pm'),
        owner: task.role || task.owner || null,
        status,
        createdBy: String(task.createdBy || 'pm'),
        createdAt: task.createdAt || nowIso,
        updatedAt: task.updatedAt || nowIso,
        done: status === 'done',
        doneAt: status === 'done' ? (task.doneAt || task.updatedAt || nowIso) : null,
        due: String(task.due || ''),
        evidence: String(task.evidence || ''),
        rev: Number(task.rev || (previous && previous.rev) || 1),
        history: Array.isArray(task.history) ? task.history : [],
        source: 'workbench',
        workbenchId: taskId,
      };
      writeJsonAtomic(file, record);
      counts.tasks += 1;
    }
    try {
      for (const entry of fs.readdirSync(paths.tasks)) {
        if (!entry.endsWith('.json')) continue;
        const file = path.join(paths.tasks, entry);
        const record = readJsonSafe(file);
        if (record && record.source === 'workbench' && !liveTaskIds.has(String(record.id || ''))) {
          fs.rmSync(file, { force: true });
        }
      }
    } catch { /* 忽略清理失败 */ }

    const proposals = Array.isArray(project.proposals) ? project.proposals : [];
    const byId = new Map(proposals.map((proposal) => [proposal.id, proposal]));
    for (const proposal of proposals) {
      const proposalId = safeStateId(proposal && proposal.id);
      if (!proposalId) continue;
      const dir = path.join(paths.proposals, proposalId);
      const file = path.join(dir, '提案.json');
      const previous = readJsonSafe(file);
      if (previous && previous.source !== 'workbench' && previous.workbenchId !== proposalId) continue;
      const rawFiles = Array.isArray(proposal.files) && proposal.files.length
        ? proposal.files
        : (proposal.fileRel ? [{ target: proposal.fileRel, baseHash: proposal.baseHash, newHash: proposal.contentHash || proposal.hash, size: proposal.fileSize }] : []);
      const files = rawFiles
        .filter((fileRow) => fileRow && fileRow.target)
        .map((fileRow) => ({
          target: String(fileRow.target).replace(/\\/g, '/'),
          baseHash: fileRow.baseHash === null || fileRow.baseHash === undefined ? 'absent' : String(fileRow.baseHash),
          newHash: String(fileRow.newHash || fileRow.hash || proposal.contentHash || proposal.hash || ''),
          size: Number(fileRow.size || 0),
        }));
      const proposalHash = String(proposal.proposalHash || proposal.contentHash || proposal.hash || '');
      const author = String(proposal.author || 'pm');
      const reviewers = ROLE_IDS.filter((role) => role !== author);
      const record = {
        id: proposalId,
        project: name,
        author,
        authorSession: String(proposal.authorSession || (project.sessions && project.sessions[author]) || ''),
        task: String(proposal.task || ''),
        title: String(proposal.title || proposalId).slice(0, 100),
        rationale: String(proposal.rationale || ''),
        risk: ['normal', 'sensitive', 'critical'].includes(String(proposal.risk)) ? String(proposal.risk) : 'normal',
        files,
        proposalHash,
        status: mapProposalStatus(proposal.status),
        applied: Boolean(proposal.applied),
        commitId: proposal.commitId || null,
        minReviews: 1,
        requiredReviewers: reviewers,
        requiredSigners: author === 'pm' ? [reviewers[0]].filter(Boolean) : ['pm'],
        createdAt: proposal.createdAt || nowIso,
        updatedAt: proposal.updatedAt || nowIso,
        source: 'workbench',
        workbenchId: proposalId,
      };
      writeJsonAtomic(file, record);
      counts.proposals += 1;
      fs.mkdirSync(path.join(dir, '评审'), { recursive: true });
      fs.mkdirSync(path.join(dir, '签字'), { recursive: true });
      for (const review of Array.isArray(proposal.reviews) ? proposal.reviews : []) {
        const role = safeStateId(review && review.role);
        if (!ROLE_IDS.includes(role)) continue;
        writeJsonAtomic(path.join(dir, '评审', role + '.json'), {
          role,
          verdict: String(review.verdict || ''),
          comment: String(review.comment || ''),
          comments: String(review.comment || ''),
          ts: review.at || review.ts || nowIso,
          proposalHash,
          baseHash: files[0] ? files[0].baseHash : 'absent',
          newHash: files[0] ? files[0].newHash : '',
          sessionId: String((project.sessions && project.sessions[role]) || ''),
          source: 'workbench',
        });
        counts.reviews += 1;
      }
      if (proposal.signature && proposal.signature.by) {
        const role = safeStateId(proposal.signature.by);
        if (ROLE_IDS.includes(role)) {
          writeJsonAtomic(path.join(dir, '签字', role + '.json'), {
            role,
            decision: proposal.signature.decision === 'approved' ? 'approve' : 'reject',
            proposalHash,
            baseHash: files[0] ? files[0].baseHash : 'absent',
            newHash: files[0] ? files[0].newHash : '',
            ts: proposal.signature.at || nowIso,
            note: String(proposal.signature.note || ''),
            sessionId: String((project.sessions && project.sessions[role]) || ''),
            channel: 'local',
            source: 'workbench',
          });
          counts.signatures += 1;
        }
      }
    }

    const commits = Array.isArray(project.commits) ? project.commits : [];
    for (const commit of commits) {
      const commitId = safeStateId(commit && commit.id);
      if (!commitId || !commit.fileRel) continue;
      const file = path.join(paths.commits, commitId + '.json');
      const previous = readJsonSafe(file);
      if (previous && previous.source !== 'workbench' && previous.workbenchId !== commitId) continue;
      const proposal = byId.get(commit.proposalId) || null;
      const target = String(commit.fileRel).replace(/\\/g, '/');
      const record = {
        id: commitId,
        project: name,
        proposalId: commit.proposalId || '',
        proposalHash: String((proposal && (proposal.proposalHash || proposal.contentHash || proposal.hash)) || ''),
        task: String((proposal && proposal.task) || ''),
        risk: String((proposal && proposal.risk) || 'normal'),
        author: String((proposal && proposal.author) || 'pm'),
        appliedBy: String(commit.appliedBy || 'pm'),
        log: String(commit.log || (proposal && proposal.title) || '文件提交').slice(0, 160),
        createdAt: commit.createdAt || commit.at || nowIso,
        before: [{
          target,
          hash: commit.baseHash === null || commit.baseHash === undefined ? 'absent' : String(commit.baseHash),
          backup: String(commit.backupPath || ''),
          existed: Boolean(commit.existed),
        }],
        after: [{ target, hash: String(commit.afterHash || '') }],
        reviews: (proposal && Array.isArray(proposal.reviews)) ? proposal.reviews : [],
        signatures: (proposal && proposal.signature) ? { [proposal.signature.by || 'pm']: proposal.signature } : {},
        source: 'workbench',
        workbenchId: commitId,
      };
      writeJsonAtomic(file, record);
      counts.commits += 1;
    }
    return { ok: true, code: 'OK', name, dir: paths.dir, counts };
  }

  async function generateBoard(project) {
    const init = await ensureInitialized();
    if (!init.ok) return { ...init, ok: false, stage: 'init' };
    let name = '';
    let ensured = null;
    let warning = null;
    if (typeof project === 'string') {
      name = project;
    } else {
      // 看板生成也会跑旧 workspace ensure：Fast 项目必须把本次补出的
      // product/programmer2 空目录再撤掉，不能因为“看一眼看板”就长出目录。
      const boardMode = normalizeTeamMode(project);
      const boardRoot = path.resolve(String(project && project.path || ''));
      const excludedBefore = boardRoot ? snapshotExcludedRoleDirs(boardRoot, boardMode) : {};
      ensured = await ensureProject({ ...(project || {}), teamMode: boardMode }, { teamMode: boardMode });
      if (ensured.ok) {
        name = ensured.name;
        pruneExcludedRoleDirs(boardRoot, boardMode, excludedBefore);
      } else {
        warning = { code: ensured.code, message: ensured.message };
        name = resolveProjectName(project, readRegistrations());
      }
    }
    if (!name) return failure('NO_PROJECT', '没有可生成看板的项目');
    let synced = null;
    let rosterSynced = null;
    if (project && typeof project === 'object') {
      try { synced = syncWorkbenchBoard(project, name); } catch (error) {
        warning = warning || { code: 'BOARD_SYNC_FAILED', message: String(error && error.message || error).slice(0, 300) };
      }
      if (project.sessions) {
        try { rosterSynced = syncRoster(name, project.sessions); } catch (error) {
          warning = warning || { code: 'ROSTER_SYNC_FAILED', message: String(error && error.message || error).slice(0, 300) };
        }
      }
    }
    if (!fs.existsSync(layout.teamTool)) {
      return failure('TOOL_MISSING', `团队工具不存在：${layout.teamTool}`, { name });
    }
    const run = await runNode(layout.teamTool, ['board', '--project', name, '--json'], { timeoutMs: TIMEOUTS.board });
    if (!run.ok) {
      return { ...publicRun(run), ok: false, stage: 'board', name, warning };
    }
    const value = run.value || {};
    if (value.ok === false) {
      return failure(value.code || 'BOARD_FAILED', value.message || '看板生成失败', { stage: 'board', name, warning });
    }
    const files = Array.isArray(value.files) ? value.files : [];
    const boardPath = files.find((file) => /\.html$/i.test(String(file))) || layout.boardHtml;
    const mdPath = files.find((file) => /\.md$/i.test(String(file))) || layout.boardMd;
    if (!fs.existsSync(boardPath)) {
      return failure('BOARD_MISSING', `看板生成后找不到 HTML：${boardPath}`, { name, boardPath });
    }
    // 兼容旧调用方/验收脚本把 看板.json 放在团队根目录的读法；状态目录仍是唯一真相。
    try {
      if (fs.existsSync(layout.boardJson)) fs.copyFileSync(layout.boardJson, path.join(layout.root, '看板.json'));
    } catch { /* 镜像失败不影响主看板 */ }
    return {
      ok: true,
      code: 'OK',
      name,
      project: name,
      boardPath,
      mdPath,
      jsonPath: layout.boardJson,
      // 旧版 team.mjs board 的 files 字段：md 在前、html 在后。
      files,
      summary: value.summary || null,
      generatedAt: value.generatedAt || null,
      boardExists: true,
      ensuredOk: ensured ? Boolean(ensured.ok) : null,
      synced: synced ? { ok: synced.ok, code: synced.code, counts: synced.counts } : null,
      rosterSynced: rosterSynced ? { ok: rosterSynced.ok, code: rosterSynced.code, changed: rosterSynced.changed } : null,
      warning,
      stdout: tail(run.stdout),
      stderr: tail(run.stderr),
      ms: run.ms
    };
  }

  function normalizeRoles(input) {
    if (input === undefined || input === null || input === '') return [...ROLE_IDS];
    const list = Array.isArray(input) ? input : String(input).split(',');
    const roles = [...new Set(list.map((item) => String(item).trim()).filter(Boolean))];
    if (!roles.length) return [];
    return roles.filter((role) => ROLE_IDS.includes(role));
  }

  function mapDshFailure(run) {
    const text = [run.stdout, run.stderr].filter(Boolean).join('\n');
    if (!DSH_DOWN_RE.test(text)) return null;
    const line = firstFailureLine(run.stderr) || firstFailureLine(run.stdout);
    const auth = /HTTP 401|HTTP 403|Unauthorized|UNAUTHORIZED|browser-session secret/i.test(text);
    return {
      code: auth ? 'DSH_AUTH_REJECTED' : 'DSH_OFFLINE',
      errorCode: auth ? 'DSH_AUTH_REJECTED' : 'DSH_OFFLINE',
      message: (auth ? 'DSH 认证失败（cookie/secret 可能已轮换）：' : 'DSH 不可用或未登录：') + tail(line || '连接失败', 300),
      why: auth ? 'DSH 认证失败' : 'DSH 不可用或未登录'
    };
  }

  // ==========================================================================
  // 旧协议消息通道：派单/回执不再只写本地库，直接走 团队/工具/team.mjs
  //   boot --role R --project P  → 拿启动令牌（所有写操作都要带）
  //   send --boot T --to R --subject S --body B --ack --no-wake
  //   ack  --boot T --id M-... --note "..."
  //   project use --boot T --name P → 切换当前项目（= 切换工作区）
  // 令牌只缓存在内存里，不落盘；过期/规则变化自动重新 boot 一次。
  // ==========================================================================

  const bootCache = new Map();

  function teamConfig() {
    const team = readJsonSafe(layout.teamFile);
    return (team && team.config) || {};
  }

  function teamMembers() {
    const team = readJsonSafe(layout.teamFile);
    return team && Array.isArray(team.members) ? team.members : [];
  }

  function memberFor(role) {
    return teamMembers().find((member) => member.role === role && member.status !== 'removed') || null;
  }

  function projectStateDir(projectName) {
    return path.join(layout.projectsDir, teamSlug(projectName, 60));
  }

  function dispatchLockPath(projectName) {
    return path.join(projectStateDir(projectName), '派单锁.json');
  }

  /** 旧协议派单锁（PM 一次只能派一个）: 状态/项目/<slug>/派单锁.json。 */
  function readDispatchLockState(projectName) {
    const data = readJsonSafe(dispatchLockPath(projectName));
    if (!data || !data.messageId) return null;
    return {
      messageId: String(data.messageId),
      to: String(data.to || ''),
      subject: String(data.subject || ''),
      task: String(data.task || ''),
      ts: data.ts || null,
      file: dispatchLockPath(projectName)
    };
  }

  /**
   * 撤销派单时释放旧协议锁。只删“这条消息自己的”锁，不碰别人的锁；
   * 这是 team.mjs 没有暴露的收尾动作（它只在 ack 时清锁），必须严格匹配 messageId。
   */
  function releaseDispatchLock(projectName, messageId) {
    const name = String(projectName || '').trim();
    if (!name) return failure('PROJECT_REQUIRED', '缺少团队项目名');
    const file = dispatchLockPath(name);
    const data = readJsonSafe(file);
    if (!data || !data.messageId) return { ok: true, code: 'NO_LOCK', removed: false, pending: null };
    if (messageId && String(data.messageId) !== String(messageId)) {
      return failure('LOCK_MISMATCH', `派单锁属于 ${data.messageId}，不能释放 ${messageId}`, {
        pending: { messageId: String(data.messageId), to: data.to || '', subject: data.subject || '' }
      });
    }
    try {
      fs.rmSync(file, { force: true });
      return { ok: true, code: 'LOCK_RELEASED', removed: true, pending: { messageId: String(data.messageId), to: data.to || '' } };
    } catch (error) {
      return failure('LOCK_RELEASE_FAILED', '释放派单锁失败：' + String(error && error.message || error).slice(0, 200));
    }
  }

  /** 六角色名册是否齐（active 且已绑定会话）；缺失会阻断旧协议 send/ack。 */
  function rosterStatus(roles = ROLE_IDS) {
    const members = teamMembers();
    const wanted = Array.isArray(roles) && roles.length ? roles : [...ROLE_IDS];
    const missing = [];
    const withoutSession = [];
    for (const role of wanted) {
      const member = members.find((item) => item.role === role && item.status !== 'removed');
      if (!member || member.status !== 'active') missing.push(role);
      else if (!member.sessionId) withoutSession.push(role);
    }
    return {
      ok: missing.length === 0,
      count: members.filter((member) => member.status === 'active').length,
      missing,
      withoutSession,
      members: members.map((member) => ({
        role: member.role,
        name: member.name,
        status: member.status,
        sessionId: member.sessionId || ''
      }))
    };
  }

  async function bootToken(projectName, role = 'pm', options = {}) {
    const name = String(projectName || '').trim();
    const roleId = String(role || 'pm');
    if (!name) return failure('PROJECT_REQUIRED', '缺少团队项目名');
    if (!ROLE_IDS.includes(roleId)) return failure('BAD_ROLE', `角色无效；可用角色：${ROLE_IDS.join(', ')}`);
    if (!fs.existsSync(layout.teamFile)) {
      return failure('NO_TEAM', '团队工具尚未初始化；先创建/恢复项目，或运行 team.mjs init');
    }
    const sessionId = String(options.sessionId || '').trim();
    const key = name + '|' + roleId + '|' + sessionId;
    const cached = bootCache.get(key);
    if (!options.force && cached && cached.expiresAt > Date.now()) {
      return { ok: true, code: 'OK', cached: true, ...cached };
    }
    if (!fs.existsSync(layout.teamTool)) {
      return failure('TOOL_MISSING', '团队工具不存在：' + layout.teamTool);
    }
    const bootArgs = ['boot', '--role', roleId, '--project', name, '--json'];
    if (sessionId) bootArgs.push('--session', sessionId);
    const run = await runNode(layout.teamTool, bootArgs, { timeoutMs: TIMEOUTS.boot });
    if (!run.ok) return { ...publicRun(run), ok: false, code: run.errorCode || 'BOOT_FAILED' };
    const value = run.value || {};
    if (value.ok === false || !value.token) {
      return failure(value.code || 'BOOT_FAILED', value.message || '团队启动令牌创建失败', { role: roleId, project: name });
    }
    const ttlMs = Math.max(60000, Number(teamConfig().bootTtlMinutes || DEFAULT_BOOT_TTL_MINUTES) * 60000);
    const record = {
      token: String(value.token),
      role: roleId,
      project: name,
      sessionId: value.sessionId || sessionId,
      rulesHash: value.rulesHash || '',
      // 旧工具自己的简报上限是 bootBriefMaxChars（默认 2000）。这里保留完整简报，
      // 另给 briefingExcerpt 兼容旧调用方；截断成 400 会让 boot 审计看不到待办/提案。
      briefing: String(value.briefing || '').slice(0, Math.max(400, Number(teamConfig().bootBriefMaxChars || 2000))),
      briefingExcerpt: String(value.briefing || '').slice(0, 400),
      unread: Array.isArray(value.unread) ? value.unread.length : 0,
      tasks: Array.isArray(value.tasks) ? value.tasks.length : 0,
      proposals: Array.isArray(value.proposals) ? value.proposals.length : 0,
      expiresAt: Date.now() + Math.max(30000, ttlMs - BOOT_EXPIRY_MARGIN_MS)
    };
    bootCache.set(key, record);
    return { ok: true, code: 'OK', cached: false, ...record };
  }

  function dropBootToken(projectName, role) {
    const prefix = String(projectName || '') + '|' + String(role || '') + '|';
    for (const key of [...bootCache.keys()]) {
      if (key.startsWith(prefix)) bootCache.delete(key);
    }
  }

  /**
   * bootRole 刚重签了令牌，内存缓存必须同步成这张新令牌。
   * 否则“重新 boot 过了”的角色下一步仍拿旧令牌执行旧命令：新需求/新正文不在旧阅读证据里，
   * 闸门会判成“boot 时还没有这份”，表现为 RULES_CHANGED / TASK_DOCS_UNREAD 的假回归。
   */
  function refreshBootCache(projectName, role, sessionId, value = {}) {
    const name = String(projectName || '').trim();
    const roleId = String(role || '').trim();
    const sid = String(sessionId || '').trim();
    if (!name || !roleId || !value.token) return null;
    dropBootToken(name, roleId);
    const ttlMs = Math.max(60000, Number(teamConfig().bootTtlMinutes || DEFAULT_BOOT_TTL_MINUTES) * 60000);
    const briefing = String(value.briefing || '').slice(0, Math.max(400, Number(teamConfig().bootBriefMaxChars || 2000)));
    const record = {
      token: String(value.token),
      role: roleId,
      project: name,
      sessionId: String(value.sessionId || sid),
      rulesHash: String(value.rulesHash || ''),
      briefing,
      briefingExcerpt: briefing.slice(0, 400),
      unread: Number(value.unread || 0),
      tasks: Number(value.tasks || 0),
      proposals: Number(value.proposals || 0),
      expiresAt: Date.now() + Math.max(30000, ttlMs - BOOT_EXPIRY_MARGIN_MS)
    };
    bootCache.set(name + '|' + roleId + '|' + sid, record);
    return record;
  }

  /** 拿令牌跑一次旧协议命令；令牌失效（过期/规则变化）时重新 boot 再试一次。 */
  async function withBootToken(projectName, role, runner, sessionId = '') {
    let boot = await bootToken(projectName, role, { sessionId });
    if (!boot.ok && TOKEN_RETRY_CODES.includes(boot.code)) {
      // 缓存/旧令牌在 boot 阶段就被旧工具判失效：丢掉缓存强制重签一次。
      dropBootToken(projectName, role);
      boot = await bootToken(projectName, role, { force: true, sessionId });
    }
    if (!boot.ok) return boot;
    let result = await runner(boot.token, boot);
    if (!result.ok && TOKEN_RETRY_CODES.includes(result.code)) {
      dropBootToken(projectName, role);
      boot = await bootToken(projectName, role, { force: true, sessionId });
      if (!boot.ok) return boot;
      result = await runner(boot.token, boot);
    }
    return result;
  }

  /**
   * 旧协议 ack 的 回执.jsonl 本身只有角色名，没有会话身份；这里在 ack 成功后把
   * boot 时使用的真实 sessionId 补写到该回执记录（含 update:true 的更新行）。
   * 只补缺失字段，不覆盖已有身份，也不改业务字段。
   *
   * actor 语义：只有“本次确实由工作台壳进程执行 ack”时才写 actor=workbench-shell；
   * 旧协议里已经存在的回执（result.already，可能是角色自己执行的）不补 actor，
   * 避免把角色的真实执行冒充成壳代跑。identitySource=verified-session 只证明
   * 会话归属核验通过，不代表执行者。
   */
  function annotateReceiptIdentity(ackId, identity = {}) {
    const id = String(ackId || '').trim();
    const sessionId = String(identity.sessionId || '').trim();
    const role = String(identity.role || '').trim();
    if (!id || !sessionId) return { ok: false, code: 'IDENTITY_REQUIRED', changed: 0 };
    if (!fs.existsSync(layout.receiptsFile)) return { ok: true, code: 'NO_RECEIPTS', changed: 0 };
    let text = '';
    try { text = fs.readFileSync(layout.receiptsFile, 'utf8'); } catch {
      return { ok: false, code: 'RECEIPT_READ_FAILED', changed: 0 };
    }
    const rows = text.split(/\r?\n/);
    let changed = 0;
    const identitySource = String(identity.identitySource || 'role-session');
    const workspaceId = String(identity.workspaceId || '');
    const checkedAt = String(identity.checkedAt || '');
    const actor = String(identity.actor || '').trim();
    const executor = String(identity.executor || '').trim();
    // 旧协议回执文件是 append-only。不要整文件读改写：那会在 read 与 rename 之间
    // 丢掉另一条角色回执。这里只追加一条 update:true 身份行，由 listReceipts 合并。
    const update = {
      id,
      update: true,
      sessionId,
      ...(role ? { role } : {}),
      identitySource,
      ...(workspaceId ? { workspaceId } : {}),
      ...(checkedAt ? { identityCheckedAt: checkedAt } : {}),
      ...(actor ? { actor } : {}),
      ...(executor ? { executor } : {}),
      identityAnnotatedAt: new Date().toISOString()
    };
    try {
      fs.appendFileSync(layout.receiptsFile, JSON.stringify(update) + '\n', 'utf8');
      return { ok: true, code: 'IDENTITY_APPENDED', changed: 1 };
    } catch (error) {
      return { ok: false, code: 'RECEIPT_WRITE_FAILED', changed: 0, message: String(error && error.message || error).slice(0, 200) };
    }
  }

  /**
   * 降级回执也要进看板数据源，但必须明确标成本地/人工，不能冒充旧协议 ack。
   * 追加到 回执.jsonl（append-only），旧看板会显示来源字段。
   */
  function appendLocalReceipt(input = {}) {
    const msgId = String(input.msgId || '').trim();
    if (!msgId) return { ok: false, code: 'BAD_ID' };
    const row = {
      id: String(input.id || ('A-local-' + crypto.randomUUID().slice(0, 8))),
      msgId,
      from: String(input.role || input.from || ''),
      to: String(input.to || 'pm'),
      project: String(input.project || ''),
      note: String(input.note || '已收到').slice(0, 300),
      log: String(input.note || '已收到').slice(0, 160),
      ts: new Date().toISOString(),
      sessionId: String(input.sessionId || ''),
      role: String(input.role || ''),
      // 本地/降级回执由壳进程写入：actor 必须写明，不能标成角色会话执行。
      actor: String(input.actor || 'workbench-shell'),
      executor: String(input.executor || 'workbench-shell'),
      source: 'local',
      local: true,
    };
    try {
      fs.mkdirSync(path.dirname(layout.receiptsFile), { recursive: true });
      fs.appendFileSync(layout.receiptsFile, JSON.stringify(row) + '\n', 'utf8');
      return { ok: true, code: 'LOCAL_RECEIPT_APPENDED', receipt: row };
    } catch (error) {
      return { ok: false, code: 'RECEIPT_WRITE_FAILED', message: String(error && error.message || error).slice(0, 200) };
    }
  }

  /**
   * 旧版回执列表（只读）。
   *
   * 数据源固定为 <团队>/状态/回执.jsonl，调用方不能传路径：
   *   - 路径必须在团队根内；软链接按 realpath 复核，只接受普通文件；
   *   - 只读文件尾部（上限 8MiB），超大文件丢弃被截断的首行并标 tailOnly，
   *     绝不整块读入、也绝不写回或改文件；
   *   - 旧协议 update:true 的追加行按 id 去重：保留最后一次写入并合并更早行
   *     里缺失的字段，输出的行去掉 update 标记（它已经是最终回执，不是更新行），
   *     所以一条回执只出现一次，不会重复占列表；
   *   - 行内字段原样返回（from / actor / executor / sessionId / identitySource
   *     等全部保留），不改写、不补造执行者，避免把角色回执冒充成壳代跑。
   */
  function listReceipts(input = {}) {
    const names = (Array.isArray(input.projects) ? input.projects : [input.project || input.projectName || input.name])
      .map((value) => String(value || '').trim())
      .filter(Boolean)
      .slice(0, 8);
    const project = names[0] || '';
    const includeUnassigned = input.includeUnassigned === true;
    const limitRaw = Number(input.limit);
    const limit = Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(RECEIPTS_MAX_LIMIT, Math.max(1, Math.floor(limitRaw)))
      : RECEIPTS_DEFAULT_LIMIT;
    const file = layout.receiptsFile;
    const base = { file, project, projects: names, limit, receipts: [] };
    if (!isInside(layout.root, file)) {
      return { ok: false, code: 'RECEIPTS_OUTSIDE', message: '回执文件不在团队状态目录内', ...base };
    }
    let stat = null;
    try {
      stat = fs.statSync(file);
    } catch (error) {
      if (error && error.code === 'ENOENT') {
        return { ok: true, code: 'NO_RECEIPTS', message: '还没有旧协议回执', count: 0, total: 0, scanned: 0, superseded: 0, invalid: 0, ...base };
      }
      return { ok: false, code: 'RECEIPTS_READ_FAILED', message: String(error && error.message || error).slice(0, 300), ...base };
    }
    if (!stat.isFile()) {
      return { ok: false, code: 'RECEIPTS_NOT_FILE', message: '回执路径不是普通文件', ...base };
    }
    // 软链接必须解析后仍落在团队根内，防止把团队外的文件当回执读。
    try {
      const real = fs.realpathSync(file);
      if (!isInside(layout.root, real)) {
        return { ok: false, code: 'RECEIPTS_OUTSIDE', message: '回执文件软链接指向团队目录外', ...base };
      }
    } catch (error) {
      return { ok: false, code: 'RECEIPTS_READ_FAILED', message: String(error && error.message || error).slice(0, 300), ...base };
    }
    const bytesTotal = stat.size;
    const bytesToRead = Math.min(bytesTotal, RECEIPTS_TAIL_BYTES);
    const start = bytesTotal - bytesToRead;
    let bytesRead = 0;
    let text = '';
    let fd = null;
    try {
      fd = fs.openSync(file, 'r');
      const buffer = Buffer.alloc(bytesToRead);
      while (bytesRead < bytesToRead) {
        const chunk = fs.readSync(fd, buffer, bytesRead, bytesToRead - bytesRead, start + bytesRead);
        if (!chunk) break;
        bytesRead += chunk;
      }
      text = buffer.toString('utf8', 0, bytesRead);
    } catch (error) {
      return { ok: false, code: 'RECEIPTS_READ_FAILED', message: String(error && error.message || error).slice(0, 300), ...base };
    } finally {
      if (fd !== null) { try { fs.closeSync(fd); } catch { /* ignore */ } }
    }
    // 从文件中间起读时第一行是残片：丢弃到第一个换行为止；没有换行就整段丢弃。
    if (start > 0) {
      const newline = text.indexOf('\n');
      text = newline >= 0 ? text.slice(newline + 1) : '';
    }
    const byId = new Map();
    let invalid = 0;
    let superseded = 0;
    for (const line of text.split(/\r?\n/)) {
      if (!line.trim()) continue;
      let row = null;
      try { row = JSON.parse(line); } catch { invalid += 1; continue; }
      if (!row || typeof row !== 'object' || Array.isArray(row)) { invalid += 1; continue; }
      const id = String(row.id || '').trim();
      if (!id) { invalid += 1; continue; }
      const previous = byId.get(id);
      // update:true 是旧协议追加的更新行：合并成最终回执，输出不再带 update 标记。
      const merged = previous ? { ...previous, ...row } : { ...row };
      delete merged.update;
      if (previous) superseded += 1;
      byId.set(id, merged);
    }
    const all = Array.from(byId.values());
    const matched = names.length
      ? all.filter((row) => {
        const value = String(row.project || '').trim();
        if (!value) return includeUnassigned;
        return names.includes(value);
      })
      : all;
    const ordered = matched
      .map((row, index) => {
        const at = Date.parse(String(row.ts || ''));
        return { row, index, at: Number.isFinite(at) ? at : null };
      })
      .sort((a, b) => {
        if (a.at !== null && b.at !== null && a.at !== b.at) return b.at - a.at;
        if (a.at !== null && b.at === null) return -1;
        if (a.at === null && b.at !== null) return 1;
        return a.index - b.index;
      })
      .map((item) => item.row);
    const receipts = ordered.slice(0, limit);
    return {
      ok: true,
      code: 'OK',
      ...base,
      count: receipts.length,
      total: matched.length,
      scanned: all.length,
      superseded,
      invalid,
      bytes: bytesTotal,
      bytesRead,
      tailOnly: start > 0,
      receipts
    };
  }

  /**
   * 读取旧协议“真实通信现场”（只读，不写任何文件）：
   *   - 每个角色邮箱的 new/cur：同一条消息在 cur 说明收件角色自己执行过 read；
   *   - 回执.jsonl：出现该 msgId 说明有人（角色本人或壳）执行过 ack。
   * 主进程用这份快照判断 delivered/wake/read/ack，绝不靠本地镜像猜角色行为。
   */
  function commSnapshot(input = {}) {
    if (!fs.existsSync(layout.root)) {
      return {
        ok: false,
        code: 'NO_TEAM',
        message: '团队状态目录不存在：' + layout.root,
        mail: {},
        receipts: {},
        mailboxes: {},
        counts: { mail: 0, receipts: 0 }
      };
    }
    const roles = (Array.isArray(input.roles) && input.roles.length ? input.roles : ROLE_IDS)
      .map((role) => String(role || '').trim())
      .filter((role) => ROLE_IDS.includes(role));
    const mail = {};
    const mailboxes = {};
    for (const role of roles) {
      const boxes = {};
      for (const box of ['new', 'cur']) {
        const dir = path.join(layout.mailDir, role, box);
        let names = [];
        try { names = fs.readdirSync(dir); } catch { /* 该箱还不存在 */ }
        const rows = [];
        for (const name of names) {
          if (!name.endsWith('.json')) continue;
          const file = path.join(dir, name);
          const row = readJsonSafe(file);
          if (!row || !row.id) continue;
          let stat = null;
          try { stat = fs.statSync(file); } catch { /* 刚被移走 */ }
          const record = {
            id: String(row.id),
            role,
            box,
            file,
            from: row.from ? String(row.from) : '',
            to: row.to ? String(row.to) : '',
            project: row.project ? String(row.project) : '',
            subject: row.subject ? String(row.subject) : '',
            ts: row.ts || null,
            mtimeMs: stat ? stat.mtimeMs : null,
            size: stat ? stat.size : null
          };
          rows.push(record);
          // cur 优先于 new：同一条消息还在 new 但已进 cur 时，说明已被读取。
          if (!mail[record.id] || box === 'cur') mail[record.id] = record;
        }
        boxes[box] = rows.length;
      }
      mailboxes[role] = boxes;
    }
    // 回执账本只读尾部（listReceipts 内部有 8MiB 上限），按 msgId 建索引。
    const ledger = listReceipts({ limit: RECEIPTS_MAX_LIMIT, includeUnassigned: true });
    const receipts = {};
    if (ledger && ledger.ok) {
      for (const row of ledger.receipts || []) {
        const msgId = String(row.msgId || row.messageId || '').trim();
        if (!msgId) continue;
        const previous = receipts[msgId];
        const at = Date.parse(String(row.ts || '')) || 0;
        const previousAt = previous ? (Date.parse(String(previous.ts || '')) || 0) : -1;
        // 同一 msgId 有多条时保留最新一条；update 行已由 listReceipts 合并。
        if (!previous || at >= previousAt) receipts[msgId] = row;
      }
    }
    return {
      ok: true,
      code: 'OK',
      generatedAt: new Date().toISOString(),
      teamRoot: layout.root,
      mail,
      receipts,
      mailboxes,
      counts: { mail: Object.keys(mail).length, receipts: Object.keys(receipts).length }
    };
  }

  /** 派单：走 team.mjs send（PM 一次只能派一个由旧协议自己兜）。 */
  /**
   * B-20261113-005705-a577：派单队列兜底泵（工作台主进程每 60 秒调用）。
   * 走 team.mjs queue pump：无论成功失败都返回结构化结果，失败由调用方留痕；
   * 队列项只在真正派发成功后才移除（工具侧保证），失败/角色忙都原样保留。
   */
  async function pumpDispatchQueue(name) {
    const projectName = String(name || '').trim();
    if (!projectName) return { ok: false, code: 'BAD_PROJECT', message: '缺少项目名' };
    if (!fs.existsSync(layout.teamTool)) {
      return { ok: false, code: 'TOOL_MISSING', message: `团队工具不存在：${layout.teamTool}` };
    }
    const run = await runNode(layout.teamTool, ['queue', 'pump', '--project', projectName, '--json'], { timeoutMs: TIMEOUTS.status });
    if (!run.ok) {
      return { ok: false, code: run.errorCode || 'QUEUE_PUMP_FAILED', message: run.message || '队列泵执行失败', run: publicRun(run) };
    }
    const value = run.value || {};
    return {
      ok: value.ok !== false,
      code: value.code || (value.pumped ? 'PUMPED' : 'IDLE'),
      project: projectName,
      pumped: Boolean(value.pumped),
      item: value.item || null,
      message: value.message || null,
      remaining: Number.isFinite(value.remaining) ? value.remaining : null,
      reason: String(value.reason || ''),
    };
  }

  async function sendDispatch(input = {}) {
    const projectName = String(input.projectName || '').trim();
    const to = String(input.to || '').trim();
    const from = String(input.from || 'pm').trim();
    if (!projectName) return failure('PROJECT_REQUIRED', '缺少团队项目名');
    if (!ROLE_IDS.includes(to)) return failure('BAD_ROLE', `派单角色无效；可用角色：${ROLE_IDS.join(', ')}`);
    if (!ROLE_IDS.includes(from)) return failure('BAD_ROLE', `发件角色无效：${from}`);
    const recipient = memberFor(to);
    if (!recipient || recipient.status !== 'active') {
      return failure('TEAM_ROLE_NOT_READY', `角色「${to}」还没有团队会话/名册，请先启动团队`, { role: to });
    }
    const sender = memberFor(from);
    if (!sender || sender.status !== 'active') {
      return failure('TEAM_ROLE_NOT_READY', `发件角色「${from}」不在团队名册，请先启动团队`, { role: from });
    }
    // 旧协议写操作必须绑“当前项目”的真实会话：只认主进程传入的映射会话，
    // 绝不回退全局 团队.json 名册（那可能是另一个项目的会话）。
    const senderSession = String(input.sessionId || '').trim();
    if (!senderSession) {
      return failure('SESSION_ID_REQUIRED', `发件角色「${from}」在当前项目没有真实 DSH 会话，不能以该角色身份写入旧协议`, { role: from });
    }
    if (sender.sessionId && String(sender.sessionId) !== senderSession) {
      return failure('SESSION_ID_MISMATCH', `发件角色「${from}」的当前项目会话与名册不一致，拒绝跨项目发件`, {
        role: from,
        rosterSessionId: String(sender.sessionId),
        requestedSessionId: senderSession
      });
    }
    if (!fs.existsSync(layout.teamTool)) return failure('TOOL_MISSING', '团队工具不存在：' + layout.teamTool);
    const rawBody = String(input.body == null ? '' : input.body).trim();
    if (!rawBody) return failure('EMPTY_MESSAGE', '派单内容不能为空');
    const maxChars = Number(teamConfig().messageMaxChars || 600);
    // D3：超过 600 字不再静默截断（旧 slice(0,600) 会投出半条派单）。
    // 直接拒绝并给出可执行路径：先写 项目经理/派单/M-*.md，消息只发标题+路径+要点+完成标准。
    if (rawBody.length > maxChars) {
      return failure('MESSAGE_TOO_LONG', `派单正文 ${rawBody.length} 字，超过 ${maxChars} 字上限；先把任务说明写成 项目经理/派单/M-YYYYMMDD-HHmm-<slug>.md，再只发「标题 + 路径 + 3 条要点 + 完成标准」`, {
        length: rawBody.length,
        max: maxChars,
        wrote: false,
        file: '项目经理/派单/M-YYYYMMDD-HHmm-<slug>.md'
      });
    }
    const body = rawBody;
    const subject = String(input.subject || '任务派单').slice(0, 80);
    const task = String(input.task || '').trim();
    const declaredType = String(input.type || '').trim().toLowerCase();
    // 'note' 是旧壳的默认占位，不是真实类型：不传给 team.mjs，让它按“PM→角色+要回执+任务未完成”判派单。
    const passType = ['dispatch', 'receipt', 'notice'].includes(declaredType) ? declaredType : '';
    return withBootToken(projectName, from, async (token) => {
      const args = ['send', '--boot', token, '--to', to, '--subject', subject, '--body', body, '--json'];
      if (input.ackRequired !== false) args.push('--ack');
      // 唤醒由主进程用 DSH 适配层做（保留 DSH 离线/超时错误码），工具只记账。
      args.push('--no-wake');
      if (task) args.push('--task', task);
      if (passType) args.push('--type', passType);
      const run = await runNode(layout.teamTool, args, { timeoutMs: TIMEOUTS.send });
      if (!run.ok) {
        return {
          ...publicRun(run),
          ok: false,
          code: run.errorCode || 'TEAM_SEND_FAILED',
          message: String(run.message || '').slice(0, 300)
        };
      }
      const value = run.value || {};
      if (value.ok === false || !value.message || !value.message.id) {
        return failure(value.code || 'TEAM_SEND_FAILED', value.message || '团队工具没有返回消息 id', {});
      }
      const isDispatch = value.dispatch === true;
      const wake = wakeMessageFor({
        projectName,
        role: to,
        from,
        messageId: value.message.id,
        subject: value.message.subject || subject,
        task: value.message.task || task,
        ackRequired: value.message.ackRequired !== false,
        type: value.type || '',
        dispatch: isDispatch
      });
      return {
        ok: true,
        code: 'OK',
        message: value.message,
        wake: value.wake || null,
        dispatch: isDispatch,
        type: value.type || '',
        demoted: value.demoted === true,
        // 文案按真实分型生成：派单给四步执行文案，回执/通知只给“去 inbox 读”的提示。
        wakeText: wake.text,
        wakeSteps: wake.steps,
        ackRequired: Boolean(value.message.ackRequired),
        project: projectName,
        stdout: tail(run.stdout),
        stderr: tail(run.stderr),
        ms: run.ms,
        sessionId: senderSession,
        from: sender.role || from
      };
    }, senderSession);
  }

  /** 回执：以派单目标角色身份走 team.mjs ack（旧协议里回执必须由收件人发）。 */
  async function ackDispatch(input = {}) {
    const projectName = String(input.projectName || '').trim();
    const role = String(input.role || '').trim();
    const messageId = String(input.messageId || '').trim();
    if (!projectName) return failure('PROJECT_REQUIRED', '缺少团队项目名');
    if (!ROLE_IDS.includes(role)) return failure('BAD_ROLE', `回执角色无效：${role}`);
    if (!messageId) return failure('BAD_ID', '缺少派单消息 id');
    const member = memberFor(role);
    if (!member || member.status !== 'active') {
      return failure('TEAM_ROLE_NOT_READY', `角色「${role}」还没有团队会话/名册，请先启动团队`, { role });
    }
    // 回执必须来自收件角色“当前项目”的 DSH 会话：只认主进程核验后传入的 sessionId，
    // 不再回退全局名册（名册可能还停留在另一个项目）。
    const session = String(input.sessionId || '').trim();
    if (!session) {
      return failure('SESSION_ID_REQUIRED', `角色「${role}」在当前项目没有真实 DSH 会话，不能代写旧协议回执`, { role });
    }
    if (member.sessionId && String(member.sessionId) !== session) {
      return failure('SESSION_ID_MISMATCH', `角色「${role}」的回执会话与当前项目名册不一致，拒绝跨项目回执`, {
        role,
        rosterSessionId: String(member.sessionId),
        requestedSessionId: session
      });
    }
    if (!fs.existsSync(layout.teamTool)) return failure('TOOL_MISSING', '团队工具不存在：' + layout.teamTool);
    const maxNote = Number(teamConfig().ackNoteMaxChars || 300);
    const rawNote = String(input.note || '').trim() || '已收到';
    const note = rawNote.length > maxNote ? rawNote.slice(0, maxNote) : rawNote;
    let usedSession = session;
    // 壳进程调用 team.mjs ack：除非调用方明确声明这是角色会话自己执行的，
    // 否则一律记 actor=workbench-shell。already=true 表示旧协议里早有回执，
    // 本次壳没有执行 ack，不补 actor（可能正是角色自己执行的）。
    const actor = String(input.actor || 'workbench-shell').trim() || 'workbench-shell';
    const result = await withBootToken(projectName, role, async (token, boot) => {
      usedSession = String((boot && boot.sessionId) || session);
      const run = await runNode(layout.teamTool, ['ack', '--boot', token, '--id', messageId, '--note', note, '--json'], { timeoutMs: TIMEOUTS.ack });
      if (!run.ok) {
        return { ...publicRun(run), ok: false, code: run.errorCode || 'TEAM_ACK_FAILED', message: String(run.message || '').slice(0, 300) };
      }
      const value = run.value || {};
      if (value.ok === false || !value.ack) {
        return failure(value.code || 'TEAM_ACK_FAILED', value.message || '团队工具没有返回回执记录', {});
      }
      return {
        ok: true,
        code: 'OK',
        ack: value.ack,
        ackId: value.ack.id || '',
        already: Boolean(value.already),
        message: value.msg || null,
        receiptMessage: value.receiptMessage || null,
        note,
        truncated: rawNote.length > maxNote,
        project: projectName,
        sessionId: usedSession,
        actor,
        stdout: tail(run.stdout),
        stderr: tail(run.stderr),
        ms: run.ms
      };
    }, session);
    if (result.ok && result.ackId && !result.already) {
      // 回执文件是 append-only 的，ack 本身不带 sessionId；这里给本次 ack 的每一行补身份。
      result.identity = annotateReceiptIdentity(result.ackId, {
        sessionId: usedSession,
        role,
        identitySource: input.identitySource || 'role-session',
        workspaceId: input.workspaceId || '',
        checkedAt: input.checkedAt || '',
        actor,
        executor: actor === 'workbench-shell' ? 'workbench-shell' : actor
      });
      result.sessionId = usedSession;
    } else if (result.ok && result.already && result.ack && result.ack.id) {
      // 只补会话身份，不补 actor：这条回执不是本次壳执行写的。
      result.identity = annotateReceiptIdentity(result.ack.id, {
        sessionId: usedSession,
        role,
        identitySource: input.identitySource || 'role-session',
        workspaceId: input.workspaceId || '',
        checkedAt: input.checkedAt || '',
        actor: input.existingActor || '',
        executor: ''
      });
      result.actor = String(input.existingActor || result.ack.actor || '').trim() || 'pre-existing';
    }
    return result;
  }

  /**
   * 旧协议收件箱（只读）。
   *
   * 邮箱按角色存，但消息带 project；这里用 boot 令牌的 project 过滤，
   * 防止 B 项目用自己的会话读到 A 项目的旧邮件。只读入口也要求
   * “当前项目映射会话”，与 send/ack 共用同一把身份尺子。
   */
  async function inboxFor(input = {}) {
    const projectName = String(input.projectName || '').trim();
    const role = String(input.role || 'pm').trim();
    if (!projectName) return failure('PROJECT_REQUIRED', '缺少团队项目名');
    if (!ROLE_IDS.includes(role)) return failure('BAD_ROLE', `角色无效：${role}`);
    const member = memberFor(role);
    if (!member || member.status !== 'active') {
      return failure('TEAM_ROLE_NOT_READY', `角色「${role}」还没有团队会话/名册，请先启动团队`, { role });
    }
    const session = String(input.sessionId || '').trim();
    if (!session) {
      return failure('SESSION_ID_REQUIRED', `角色「${role}」没有当前项目的真实 DSH 会话，不能读取旧协议收件箱`, { role });
    }
    if (member.sessionId && String(member.sessionId) !== session) {
      return failure('SESSION_ID_MISMATCH', `角色「${role}」的收件箱会话与当前项目名册不一致，拒绝跨项目读取`, {
        role,
        rosterSessionId: String(member.sessionId),
        requestedSessionId: session
      });
    }
    if (!fs.existsSync(layout.teamTool)) return failure('TOOL_MISSING', '团队工具不存在：' + layout.teamTool);
    const includeAll = input.all !== false;
    return withBootToken(projectName, role, async (token, boot) => {
      const args = ['inbox', '--boot', token, '--json'];
      if (includeAll) args.push('--all');
      const run = await runNode(layout.teamTool, args, { timeoutMs: TIMEOUTS.inbox });
      if (!run.ok) return { ...publicRun(run), ok: false, code: run.errorCode || 'TEAM_INBOX_FAILED' };
      const value = run.value || {};
      if (value.ok === false) return failure(value.code || 'TEAM_INBOX_FAILED', value.message || '收件箱读取失败', {});
      const messages = Array.isArray(value.messages) ? value.messages : [];
      return {
        ok: true,
        code: 'OK',
        role,
        project: projectName,
        sessionId: String((boot && boot.sessionId) || session),
        all: includeAll,
        count: messages.length,
        unread: messages.filter((item) => item && item.box !== 'cur').length,
        messages
      };
    }, session);
  }

  /**
   * 旧协议 read：读取一条邮件并把 new 移到 cur（已读水位由旧工具的邮箱目录维护）。
   * 这是写操作（移动文件），必须与 ack 一样绑定当前项目的真实角色会话。
   */
  async function readFor(input = {}) {
    const projectName = String(input.projectName || '').trim();
    const role = String(input.role || 'pm').trim();
    const messageId = String(input.messageId || input.id || '').trim();
    if (!projectName) return failure('PROJECT_REQUIRED', '缺少团队项目名');
    if (!ROLE_IDS.includes(role)) return failure('BAD_ROLE', `角色无效：${role}`);
    if (!messageId) return failure('BAD_ID', '缺少要读取的邮件 id');
    const member = memberFor(role);
    if (!member || member.status !== 'active') {
      return failure('TEAM_ROLE_NOT_READY', `角色「${role}」还没有团队会话/名册，请先启动团队`, { role });
    }
    const session = String(input.sessionId || '').trim();
    if (!session) {
      return failure('SESSION_ID_REQUIRED', `角色「${role}」没有当前项目的真实 DSH 会话，不能读取旧协议邮件`, { role });
    }
    if (member.sessionId && String(member.sessionId) !== session) {
      return failure('SESSION_ID_MISMATCH', `角色「${role}」的读取会话与当前项目名册不一致，拒绝跨项目读取`, {
        role,
        rosterSessionId: String(member.sessionId),
        requestedSessionId: session
      });
    }
    if (!fs.existsSync(layout.teamTool)) return failure('TOOL_MISSING', '团队工具不存在：' + layout.teamTool);
    return withBootToken(projectName, role, async (token, boot) => {
      const run = await runNode(layout.teamTool, ['read', '--boot', token, '--id', messageId, '--json'], { timeoutMs: TIMEOUTS.inbox });
      if (!run.ok) return { ...publicRun(run), ok: false, code: run.errorCode || 'TEAM_READ_FAILED' };
      const value = run.value || {};
      if (value.ok === false) return failure(value.code || 'TEAM_READ_FAILED', value.message || '读取邮件失败', {});
      const mailProject = value.message && value.message.project ? String(value.message.project) : '';
      if (mailProject && mailProject !== projectName) {
        return failure('MESSAGE_PROJECT_MISMATCH', `这封邮件属于「${mailProject}」，不能在「${projectName}」读取`, {
          messageProject: mailProject, project: projectName
        });
      }
      return {
        ok: true,
        code: 'OK',
        role,
        project: projectName,
        messageId,
        alreadyRead: Boolean(value.alreadyRead),
        message: value.message || null,
        sessionId: String((boot && boot.sessionId) || session),
        stdout: tail(run.stdout),
        stderr: tail(run.stderr),
        ms: run.ms
      };
    }, session);
  }

  // ==========================================================================
  // R-c651 F-c651-4/5：团队在场（未读/未回执/停滞/wakeFailed）、全部已读、一键唤醒
  //
  // 口径只认旧工具的 `presence / mark-read / wake` 三个命令（团队/工具/lib/ops.mjs），
  // 壳层不重算、不猜：字段名与计数口径见产品《字段对齐与迁移清单-v2》。
  // ==========================================================================
  async function presenceFor(input = {}) {
    const projectName = String(input.projectName || input.project || '').trim();
    if (!projectName) return failure('PROJECT_REQUIRED', '缺少团队项目名');
    if (!fs.existsSync(layout.teamTool)) return failure('TOOL_MISSING', '团队工具不存在：' + layout.teamTool);
    const args = ['presence', '--project', projectName, '--json'];
    const roles = Array.isArray(input.roles) ? input.roles.filter(Boolean) : String(input.roles || '').split(',').map((s) => s.trim()).filter(Boolean);
    if (roles.length) args.push('--role', roles.join(','));
    const run = await runNode(layout.teamTool, args, { timeoutMs: TIMEOUTS.inbox });
    if (!run.ok) return { ...publicRun(run), ok: false, code: run.errorCode || 'TEAM_PRESENCE_FAILED', rows: [] };
    const value = run.value || {};
    if (value.ok === false) return failure(value.code || 'TEAM_PRESENCE_FAILED', value.message || '在场数据读取失败', {});
    return {
      ok: true,
      code: 'OK',
      project: projectName,
      rows: Array.isArray(value.rows) ? value.rows : [],
      stalledWarnMin: Number(value.stalledWarnMin || 15),
      stalledBadMin: Number(value.stalledBadMin || 30),
      at: new Date().toISOString(),
      ms: run.ms
    };
  }

  async function markReadFor(input = {}) {
    const projectName = String(input.projectName || input.project || '').trim();
    const role = String(input.role || '').trim();
    if (!projectName) return failure('PROJECT_REQUIRED', '缺少团队项目名');
    if (!ROLE_IDS.includes(role)) return failure('BAD_ROLE', `角色无效：${role}`);
    if (!fs.existsSync(layout.teamTool)) return failure('TOOL_MISSING', '团队工具不存在：' + layout.teamTool);
    const args = ['mark-read', '--project', projectName, '--role', role, '--json'];
    // 工作台壳 = Owner 控制台：以 actor=owner 执行批量已读（阅读.jsonl 里留 actor/source）。
    args.push('--actor', String(input.actor || 'owner'));
    if (input.source) args.push('--source', String(input.source));
    const run = await runNode(layout.teamTool, args, { timeoutMs: TIMEOUTS.inbox });
    if (!run.ok) return { ...publicRun(run), ok: false, code: run.errorCode || 'TEAM_MARK_READ_FAILED' };
    const value = run.value || {};
    if (value.ok === false) return failure(value.code || 'TEAM_MARK_READ_FAILED', value.message || '批量已读失败', {});
    return {
      ok: true,
      code: 'OK',
      project: projectName,
      role,
      count: Number(value.count || 0),
      messageIds: Array.isArray(value.messageIds) ? value.messageIds : [],
      actor: String(value.actor || input.actor || 'owner'),
      at: String(value.at || ''),
      stdout: tail(run.stdout),
      stderr: tail(run.stderr),
      ms: run.ms
    };
  }

  async function wakeRole(input = {}) {
    const projectName = String(input.projectName || input.project || '').trim();
    const role = String(input.role || '').trim();
    if (!projectName) return failure('PROJECT_REQUIRED', '缺少团队项目名');
    if (!ROLE_IDS.includes(role)) return failure('BAD_ROLE', `角色无效：${role}`);
    if (!fs.existsSync(layout.teamTool)) return failure('TOOL_MISSING', '团队工具不存在：' + layout.teamTool);
    const args = ['wake', '--project', projectName, '--role', role, '--json', '--reason', String(input.reason || 'ui')];
    const engineUrl = String(input.engineUrl || '').trim();
    if (engineUrl) args.push('--engine-url', engineUrl);
    const run = await runNode(layout.teamTool, args, { timeoutMs: TIMEOUTS.wake || TIMEOUTS.send || 30000 });
    if (!run.ok) return { ...publicRun(run), ok: false, code: run.errorCode || 'TEAM_WAKE_FAILED' };
    const value = run.value || {};
    if (value.ok === false) {
      return failure(value.code || 'TEAM_WAKE_FAILED', value.message || '唤醒失败', {
        role, wake: value.wake || null, retry: value.retry || null
      });
    }
    return {
      ok: value.ok === true,
      code: value.ok === true ? 'OK' : (value.code || 'WAKE_FAILED'),
      project: projectName,
      role,
      wake: value.wake || null,
      retry: value.retry || null,
      at: String(value.at || ''),
      stdout: tail(run.stdout),
      stderr: tail(run.stderr),
      ms: run.ms
    };
  }

  // ==========================================================================
  // 旧评审协议桥：team.mjs propose → show → review → sign → apply
  //
  // 工作台不重新实现旧协议，只把角色/项目/会话翻译成 boot 令牌和 CLI 参数，
  // 再把旧工具的 proposal/review/signature/commit 原样带回。任何“当前工具
  // 不支持这条旧协议”的情况都明确返回 LEGACY_PROTOCOL_REQUIRED，绝不假装成功。
  // ==========================================================================

  /** 旧评审协议会写项目文件/暂存快照：数据盘必须与团队状态同一个盘（本仓库在 D 盘）。 */
  function assertDataDrive(target, label) {
    const raw = String(target || '').trim();
    if (!raw) return failure('PATH_REQUIRED', `${label || '路径'}不能为空`);
    const baseRoot = path.parse(path.resolve(layout.root)).root.toLowerCase();
    const targetRoot = path.parse(path.resolve(raw)).root.toLowerCase();
    if (!targetRoot || baseRoot !== targetRoot) {
      return failure('DATA_DRIVE_REQUIRED', `${label || '路径'}必须在 ${baseRoot} 盘（当前 ${targetRoot || '未知'}）：${raw}`, {
        expectedDrive: baseRoot,
        actualDrive: targetRoot,
        target: raw
      });
    }
    return null;
  }

  function legacyRoleContext(projectName, role, sessionId, contextOptions = {}) {
    const name = String(projectName || '').trim();
    const roleId = String(role || '').trim();
    if (!name) return failure('PROJECT_REQUIRED', '缺少团队项目名');
    if (!ROLE_IDS.includes(roleId)) return failure('BAD_ROLE', `角色无效；可用角色：${ROLE_IDS.join(', ')}`);
    const member = memberFor(roleId);
    if (!member || member.status !== 'active') {
      return failure('TEAM_ROLE_NOT_READY', `角色「${roleId}」不在团队名册，请先启动团队`, { role: roleId });
    }
    const session = String(sessionId || '').trim();
    // 工作流编排（需求/任务/提案）只要求团队名册与 boot 令牌，不要求 DSH 会话在线；
    // 只有调用方显式允许时才放宽。普通 proposal:legacy 仍必须带真实会话，避免跨项目冒写。
    if (!session && contextOptions.allowMissingSession !== true) {
      return failure('SESSION_ID_REQUIRED', `角色「${roleId}」在当前项目没有真实 DSH 会话，不能执行旧评审协议`, { role: roleId });
    }
    if (session && member.sessionId && String(member.sessionId) !== session) {
      return failure('SESSION_ID_MISMATCH', `角色「${roleId}」的评审会话与当前项目名册不一致，拒绝跨项目执行`, {
        role: roleId,
        rosterSessionId: String(member.sessionId),
        requestedSessionId: session
      });
    }
    return { ok: true, code: 'OK', name, role: roleId, sessionId: session, member };
  }

  /**
   * 旧协议五步的完成情况。show 不落 proposal 字段（只写读回执），
   * 所以后续命令只要 review/sign/apply 有产物，就可反推 show 已完成；
   * show 命令本身由 extraShow 显式标记。
   */
  function legacyFlowOf(proposal, reviews, signatures, extraShow = false) {
    const reviewRows = Array.isArray(reviews) ? reviews : [];
    const signatureRows = Array.isArray(signatures) ? signatures : [];
    const status = String((proposal && proposal.status) || '').toLowerCase();
    const done = ['propose'];
    if (extraShow || reviewRows.length || signatureRows.length || status === 'applied') done.push('show');
    if (reviewRows.length) done.push('review');
    if (signatureRows.length) done.push('sign');
    if (status === 'applied') done.push('apply');
    const chain = ['propose', 'show', 'review', 'sign', 'apply'];
    const closed = status === 'rejected' || status === 'stale';
    const remaining = chain.filter((step) => !done.includes(step));
    const next = closed ? null : (remaining[0] || null);
    const stageMap = { show: 'proposed', review: 'shown', sign: 'reviewed', apply: 'signed' };
    const stage = closed ? status : (next ? stageMap[next] : 'applied');
    return { chain, done, next, stage, closed };
  }

  function buildLegacyArgs(action, input, token) {
    const args = [action, '--boot', token, '--json'];
    const text = (value) => String(value == null ? '' : value);
    if (action === 'propose') {
      const task = text(input.task || input.taskId).trim();
      if (!task) return failure('BAD_TASK', '旧评审协议 propose 需要 task（先建任务并 claim）');
      const fileSpecs = Array.isArray(input.files) ? input.files.slice() : [];
      if (!fileSpecs.length && (input.fileRel || input.target)) {
        fileSpecs.push({ target: input.target || input.fileRel, staged: input.staged || input.stagedPath, expect: input.expect });
      }
      if (!fileSpecs.length) return failure('NO_FILES', '旧评审协议 propose 至少需要一个文件（target + staged）');
      args.push('--task', task);
      if (input.title) args.push('--title', text(input.title));
      if (input.rationale) args.push('--rationale', text(input.rationale));
      if (input.risk) args.push('--risk', text(input.risk));
      const expectMap = input.expect && typeof input.expect === 'object' && !Array.isArray(input.expect) ? input.expect : {};
      const expectAll = typeof input.expect === 'string' ? input.expect : '';
      const emittedExpects = new Set();
      for (const spec of fileSpecs) {
        if (!spec || typeof spec !== 'object') return failure('BAD_FILE_SPEC', '旧评审协议 files 必须是 {target, staged, expect} 对象');
        const target = text(spec.target || spec.rel || spec.path).replace(/\\/g, '/').trim();
        const staged = text(spec.staged || spec.stagedPath || spec.source);
        if (!target || !staged) return failure('BAD_FILE_SPEC', '旧评审协议 files 每项必须有 target 和 staged');
        const driveError = assertDataDrive(staged, '暂存文件');
        if (driveError) return driveError;
        args.push('--file', target + '=' + staged);
        const expected = text(spec.expect || spec.baseHash || expectMap[target] || expectAll).trim();
        if (expected) {
          args.push('--expect', target + '=' + expected);
          emittedExpects.add(target);
        }
      }
      for (const [target, expected] of Object.entries(expectMap)) {
        if (!target || emittedExpects.has(target)) continue;
        args.push('--expect', String(target) + '=' + text(expected));
      }
      return { ok: true, args };
    }
    if (action === 'show') {
      if (!input.proposalId) return failure('BAD_ID', '旧评审协议 show 需要 proposalId');
      args.push('--proposal', text(input.proposalId));
      if (input.diff === true) args.push('--diff');
      return { ok: true, args };
    }
    if (action === 'review') {
      if (!input.proposalId) return failure('BAD_ID', '旧评审协议 review 需要 proposalId');
      const verdict = text(input.verdict || input.decision).trim().toLowerCase();
      if (!['approve', 'reject'].includes(verdict)) return failure('BAD_VERDICT', 'review 的 verdict 必须是 approve / reject');
      args.push('--proposal', text(input.proposalId));
      args.push('--verdict', verdict);
      const comments = text(input.comments !== undefined ? input.comments : input.comment);
      if (comments) args.push('--comments', comments);
      if (input.priority) args.push('--priority', text(input.priority));
      if (input.priorityReason) args.push('--priority-reason', text(input.priorityReason));
      return { ok: true, args };
    }
    if (action === 'sign') {
      if (!input.proposalId) return failure('BAD_ID', '旧评审协议 sign 需要 proposalId');
      const decision = text(input.decision || input.verdict || 'approve').trim().toLowerCase();
      if (!['approve', 'reject'].includes(decision)) return failure('BAD_DECISION', 'sign 的 decision 必须是 approve / reject');
      args.push('--proposal', text(input.proposalId));
      args.push('--decision', decision);
      if (input.note) args.push('--note', text(input.note));
      if (input.self === true) args.push('--self');
      return { ok: true, args };
    }
    if (action === 'apply') {
      if (!input.proposalId) return failure('BAD_ID', '旧评审协议 apply 需要 proposalId');
      args.push('--proposal', text(input.proposalId));
      if (input.log) args.push('--log', text(input.log));
      return { ok: true, args };
    }
    return failure('BAD_ACTION', `未知旧评审协议动作：${action}`);
  }

  /**
   * 执行一次旧评审协议动作。成功返回旧工具原始字段 + 归一后的 status/stage/flow；
   * 工具缺失或旧命令不存在时返回 LEGACY_PROTOCOL_REQUIRED。
   */
  async function legacyProposalAction(input = {}) {
    const action = String(input.action || input.op || '').trim().toLowerCase();
    if (!LEGACY_REVIEW_ACTIONS.includes(action)) {
      return failure('BAD_ACTION', `旧评审协议动作必须是 ${LEGACY_REVIEW_ACTIONS.join('/')}`, { action, protocol: 'legacy' });
    }
    if (!fs.existsSync(layout.teamTool)) {
      return failure('LEGACY_PROTOCOL_REQUIRED',
        '旧评审协议需要 team.mjs 的 propose/show/review/sign/apply；团队工具不存在：' + layout.teamTool,
        { action, protocol: 'legacy', required: LEGACY_REVIEW_ACTIONS });
    }
    const projectName = String(input.projectName || '').trim();
    const roleCtx = legacyRoleContext(projectName, input.role, input.sessionId, {
      allowMissingSession: input.allowMissingSession === true
    });
    if (!roleCtx.ok) return { ...roleCtx, action, protocol: 'legacy' };
    const registration = registrationFor(projectName);
    if (!registration) {
      return failure('NO_PROJECT', `旧协议里没有项目「${projectName}」；先 ensure 团队项目`, { action, protocol: 'legacy' });
    }
    const driveError = assertDataDrive(registration.path, '项目目录');
    if (driveError) return { ...driveError, action, protocol: 'legacy' };
    const legacyResult = await withBootToken(projectName, roleCtx.role, async (token, boot) => {
      const built = buildLegacyArgs(action, input, token);
      if (!built.ok) return { ...built, action, protocol: 'legacy' };
      const run = await runNode(layout.teamTool, built.args, { timeoutMs: TIMEOUTS.proposal });
      if (!run.ok) {
        const message = String(run.message || '');
        if (run.errorCode === 'TOOL_EXIT' && /未知命令|unknown command|invalid command/i.test(message)) {
          return failure('LEGACY_PROTOCOL_REQUIRED',
            `team.mjs 不支持 ${action}；旧评审协议需要 propose/show/review/sign/apply`,
            { action, protocol: 'legacy', stdout: tail(run.stdout), stderr: tail(run.stderr) });
        }
        return {
          ...publicRun(run),
          ok: false,
          code: run.errorCode || 'LEGACY_PROPOSAL_FAILED',
          message: message.slice(0, 400),
          action,
          protocol: 'legacy'
        };
      }
      const value = run.value || {};
      if (value.ok === false) {
        return failure(value.code || 'LEGACY_PROPOSAL_FAILED', value.message || '旧评审协议执行失败', {
          action,
          protocol: 'legacy',
          details: value.details && typeof value.details === 'object' ? value.details : {}
        });
      }
      let proposal = value.proposal || null;
      let metaValue = value;
      // review/sign/apply 的工具输出只带本次 review/signature（甚至 apply 只带 commit），
      // 统一再 show 一次，拿同哈希下的完整 proposal/reviews/signatures 作为返回字段。
      if (['review', 'sign', 'apply'].includes(action)) {
        const targetId = String((value.commit && value.commit.proposalId) || (proposal && proposal.id) || input.proposalId || '');
        const show = await runNode(layout.teamTool, ['show', '--boot', token, '--proposal', targetId, '--json'], { timeoutMs: TIMEOUTS.proposal });
        if (show.ok && show.value && show.value.proposal) {
          proposal = show.value.proposal;
          metaValue = show.value;
        } else if (action === 'apply' && value.commit) {
          proposal = {
            id: String(value.commit.proposalId || input.proposalId),
            title: '',
            author: '',
            status: 'applied',
            proposalHash: value.commit.proposalHash || '',
            files: [],
            appliedAt: value.commit.createdAt || null,
            commitId: value.commit.id || null
          };
        }
      }
      if (!proposal) {
        return failure('BAD_JSON', '旧评审协议没有返回提案对象', { action, protocol: 'legacy' });
      }
      const reviewRows = [];
      const addReviewRow = (row) => {
        if (!row || typeof row !== 'object') return;
        const role = String(row.role || row.by || '');
        if (!role) return;
        const existing = reviewRows.find((item) => item.role === role);
        if (existing) Object.assign(existing, row);
        else reviewRows.push({ role, ...row });
      };
      if (metaValue.reviews && typeof metaValue.reviews === 'object' && !Array.isArray(metaValue.reviews)) {
        for (const [role, row] of Object.entries(metaValue.reviews)) addReviewRow({ role, ...(row && typeof row === 'object' ? row : {}) });
      } else if (Array.isArray(metaValue.reviews)) {
        for (const row of metaValue.reviews) addReviewRow(row);
      }
      addReviewRow(metaValue.review);
      const signatureRows = [];
      const addSignatureRow = (row) => {
        if (!row || typeof row !== 'object') return;
        const role = String(row.role || row.by || '');
        if (!role) return;
        const existing = signatureRows.find((item) => item.role === role);
        if (existing) Object.assign(existing, row);
        else signatureRows.push({ role, ...row });
      };
      if (metaValue.signatures && typeof metaValue.signatures === 'object' && !Array.isArray(metaValue.signatures)) {
        for (const [role, row] of Object.entries(metaValue.signatures)) addSignatureRow({ role, ...(row && typeof row === 'object' ? row : {}) });
      } else if (Array.isArray(metaValue.signatures)) {
        for (const row of metaValue.signatures) addSignatureRow(row);
      }
      addSignatureRow(metaValue.signature);
      const rawStatus = String(proposal.status || '');
      const mappedStatus = LEGACY_STATUS_MAP[rawStatus] || (rawStatus ? 'review' : 'review');
      const files = (Array.isArray(proposal.files) ? proposal.files : []).map((file) => ({
        target: String(file.target || '').replace(/\\/g, '/'),
        baseHash: file.baseHash === undefined ? null : file.baseHash,
        newHash: file.newHash || file.contentHash || null,
        size: Number(file.size || 0),
        staged: file.staged || null,
        stagedSha: file.stagedSha || null
      }));
      const first = files[0] || {};
      const applied = rawStatus === 'applied' || Boolean(proposal.appliedAt) || Boolean(proposal.applied);
      const flow = legacyFlowOf(proposal, reviewRows, signatureRows, action === 'show');
      const view = {
        ...proposal,
        protocol: 'legacy',
        legacyId: String(proposal.id || ''),
        legacyStatus: rawStatus,
        status: mappedStatus,
        stage: flow.stage,
        flow,
        files,
        fileRel: first.target || '',
        fileSize: first.size || 0,
        hash: proposal.proposalHash || first.newHash || '',
        contentHash: first.newHash || null,
        baseHash: first.baseHash === 'absent' ? null : (first.baseHash === undefined ? null : first.baseHash),
        applied,
        commitId: proposal.commitId || (value.commit && value.commit.id) || null,
        stagedContent: null
      };
      return {
        ok: true,
        code: 'OK',
        protocol: 'legacy',
        action,
        project: projectName,
        role: roleCtx.role,
        sessionId: String((boot && boot.sessionId) || roleCtx.sessionId),
        proposal: view,
        reviews: reviewRows,
        signatures: signatureRows,
        review: value.review || null,
        signature: value.signature || null,
        commit: value.commit || null,
        legacyStatus: rawStatus,
        status: mappedStatus,
        stage: flow.stage,
        next: flow.next,
        flow,
        stdout: tail(run.stdout),
        stderr: tail(run.stderr),
        ms: run.ms
      };
    }, roleCtx.sessionId);
    if (!legacyResult.ok) return { ...legacyResult, action, protocol: 'legacy' };
    return legacyResult;
  }

  const legacyPropose = (input = {}) => legacyProposalAction({ ...input, action: 'propose' });
  const legacyShow = (input = {}) => legacyProposalAction({ ...input, action: 'show' });
  const legacyReview = (input = {}) => legacyProposalAction({ ...input, action: 'review' });
  const legacySign = (input = {}) => legacyProposalAction({ ...input, action: 'sign' });
  const legacyApply = (input = {}) => legacyProposalAction({ ...input, action: 'apply' });

  // ==========================================================================
  // 旧团队工作流闭环（需求 → 评审 → 派单 → 开发/互审 → 测试 → Owner 验收）
  //
  // 唯一真相（全部在旧团队状态目录里）：
  //   需求/任务   <团队>/状态/项目/<slug>/任务/*.json      （team.mjs req/task create 写）
  //   评审/签字   <团队>/状态/项目/<slug>/提案/<id>/...     （team.mjs propose/show/review/sign/apply 写）
  //   阶段/轮次   <团队>/状态/项目/<slug>/工作流.json       （旧 shell 的 ownerReview 同文件）
  // 本地 workbench.json 只做镜像，不作为任何闸门的判断依据。
  // ==========================================================================

  let legacyCapabilityCache = null;
  let legacyCapabilityStamp = '';

  /**
   * 能力缓存只在工具文件没变时复用：团队工具升级（新增 req review / owner / workflow）
   * 后不必重启工作台；文件缺失/换路径也会重新探测。
   */
  function legacyCapabilityFingerprint() {
    if (legacyMock) return 'mock';
    return [layout.teamTool, path.join(layout.toolRoot, 'lib', 'ops.mjs'), path.join(layout.toolRoot, 'lib', 'workflow.mjs')]
      .map((file) => {
        try {
          const stat = fs.statSync(file);
          return `${file}|${stat.size}|${Math.round(stat.mtimeMs)}`;
        } catch {
          return `${file}|missing`;
        }
      })
      .join(';');
  }

  function fileHashText(file) {
    try {
      return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    } catch {
      return '';
    }
  }

  /**
   * 旧 team.mjs 能力探测：只读源文件里的 switch/case 与子命令。
   * workflow / owner / req review 有可能随工具升级出现，必须以真实源码为准；
   * 缺哪条就列进 missing，调用方会在写状态之前拿到 LEGACY_PROTOCOL_REQUIRED。
   */
  function legacyCapabilities() {
    const stamp = legacyCapabilityFingerprint();
    if (legacyCapabilityCache && legacyCapabilityStamp === stamp) return legacyCapabilityCache;
    legacyCapabilityStamp = stamp;
    const base = {
      file: layout.teamTool,
      available: false,
      commands: {},
      taskClaim: false,
      taskDone: false,
      reqCreate: false,
      reqReview: false,
      missing: [],
      optionalMissing: []
    };
    // 测试注入的协议桩：能力表必须和真实命令一样“全量可用”，否则流程会在
    // LEGACY_PROTOCOL_REQUIRED 处停下，无法验证后半段。生产不会走到这里。
    if (legacyMock) {
      const commands = {
        init: true, boot: true, send: true, inbox: true, read: true, ack: true,
        task: true, req: true, vote: true,
        propose: true, show: true, review: true, sign: true, apply: true,
        grant: true, index: true, workflow: true, owner: true
      };
      legacyCapabilityCache = {
        ...base,
        available: true,
        mocked: true,
        commands: { ...commands, taskClaim: true, taskDone: true, reqCreate: true, reqReview: true },
        taskClaim: true,
        taskDone: true,
        reqCreate: true,
        reqReview: true,
        missing: [],
        optionalMissing: []
      };
      return legacyCapabilityCache;
    }
    let text = '';
    try {
      text = fs.readFileSync(layout.teamTool, 'utf8');
    } catch {
      legacyCapabilityCache = base;
      return legacyCapabilityCache;
    }
    // team.mjs 只是 switch 入口；task/req 的子命令实现 import 自 lib/ops.mjs。
    // 子命令能力必须读实现文件，不能只 grep team.mjs（否则 req create 会被误判缺失）。
    let opsText = '';
    try { opsText = fs.readFileSync(path.join(layout.toolRoot, 'lib', 'ops.mjs'), 'utf8'); } catch { /* 旧包可能内联 */ }
    const sectionOf = (source, start, end) => {
      const from = source.indexOf(start);
      if (from < 0) return '';
      const to = end ? source.indexOf(end, from + start.length) : -1;
      return source.slice(from, to > from ? to : undefined);
    };
    const hasCase = (name) => new RegExp(`case\\s+['"]${name}['"]`).test(text);
    const implText = opsText || text;
    const reqSection = sectionOf(implText, 'export function cmdReq', 'export function cmdFind');
    // 基线修复（B-25c7）：cmdTask 现为 `export async function cmdTask`（ops.mjs），
    // 只认 'export function cmdTask' 会匹配不到 → task claim/done 被误判缺失 → LEGACY_PROTOCOL_REQUIRED。
    // 两种锚点都试，保持对旧版非 async 实现的兼容。
    const taskSection = sectionOf(implText, 'export async function cmdTask', 'export function cmdReq')
      || sectionOf(implText, 'export function cmdTask', 'export function cmdReq');
    const commands = {
      init: hasCase('init'),
      boot: hasCase('boot'),
      send: hasCase('send'),
      // 收件箱/已读/回执是旧协议四步的核心命令；缺了会在项目面板把 inbox/read/ack 误报为“缺”。
      inbox: hasCase('inbox'),
      read: hasCase('read'),
      ack: hasCase('ack'),
      task: hasCase('task'),
      req: hasCase('req'),
      // 投票是团队工具真相层命令；壳层只桥接，不另造投票文件。
      vote: hasCase('vote'),
      propose: hasCase('propose'),
      show: hasCase('show'),
      review: hasCase('review'),
      sign: hasCase('sign'),
      apply: hasCase('apply'),
      grant: hasCase('grant'),
      index: hasCase('index'),
      workflow: hasCase('workflow'),
      owner: hasCase('owner')
    };
    const taskClaim = /sub\s*===\s*['"]claim['"]/.test(taskSection);
    const taskDone = /sub\s*===\s*['"]done['"]/.test(taskSection);
    const reqCreate = /sub\s*===\s*['"]create['"]/.test(reqSection);
    // 新版旧工具会显式拒绝 req review（NOT_IMPLEMENTED），不能因为源码里出现
    // “sub === 'review'”的字样就误判成命令可用；只看 review 分支本身，
    // 不要被 cmdReq 里其他子命令的“未实现”文字连坐。
    const reviewBranch = sectionOf(reqSection, "sub === 'review'", "if (sub === 'create')") || reqSection;
    const reqReviewDispatch = /cmdReqReview\s*\(|reviewRequirement\s*\(/.test(reviewBranch);
    const reqReviewRejected = /fail\(\s*['"]NOT_IMPLEMENTED['"]/.test(reviewBranch)
      || /旧团队工具没有 req/.test(reviewBranch)
      || /\[\s*['"]review['"]\s*,\s*['"]owner['"]/.test(reviewBranch);
    const reqReview = /sub\s*===\s*['"]review['"]/.test(reqSection)
      && !reqReviewRejected
      && (reqReviewDispatch || !/NOT_IMPLEMENTED/.test(reviewBranch));
    const missing = [];
    for (const [name, ok] of Object.entries(commands)) if (!ok) missing.push(name);
    if (!taskClaim) missing.push('task claim');
    if (!taskDone) missing.push('task done');
    if (!reqCreate) missing.push('req create');
    if (!reqReview) missing.push('req review');
    const optionalMissing = LEGACY_OPTIONAL_COMMANDS.filter((name) => {
      if (name === 'req review') return !reqReview;
      return !commands[name];
    });
    legacyCapabilityCache = {
      ...base,
      available: true,
      commands: { ...commands, taskClaim, taskDone, reqCreate, reqReview },
      taskClaim,
      taskDone,
      reqCreate,
      reqReview,
      missing,
      optionalMissing
    };
    return legacyCapabilityCache;
  }

  /** 强制命令不存在的统一出口：明确 LEGACY_PROTOCOL_REQUIRED，不降级本地假成功。 */
  function requireLegacyCommand(command) {
    const caps = legacyCapabilities();
    const name = String(command || '').trim();
    if (!caps.available) {
      return failure('LEGACY_PROTOCOL_REQUIRED', `团队工具不存在，无法执行旧协议命令「${name}」：${layout.teamTool}`, {
        requiredCommand: name,
        protocol: 'legacy',
        capabilities: caps
      });
    }
    let available = true;
    if (name === 'task create') available = caps.commands.task;
    else if (name === 'task claim') available = caps.taskClaim;
    else if (name === 'task done') available = caps.taskDone;
    else if (name === 'req create') available = caps.reqCreate;
    else if (name === 'req review') available = caps.reqReview;
    else if (name === 'req') available = caps.commands.req;
    else available = Boolean(caps.commands[name]);
    if (!available) {
      return failure('LEGACY_PROTOCOL_REQUIRED', `当前 team.mjs 缺少旧协议命令「${name}」；请先升级团队工具，本工作台不会用本地文件伪造这一步`, {
        requiredCommand: name,
        protocol: 'legacy',
        missingCommands: caps.missing,
        capabilities: caps
      });
    }
    return null;
  }

  function classifyLegacyRun(run, command) {
    if (!run) return failure('LEGACY_PROTOCOL_REQUIRED', `旧协议命令「${command}」没有返回结果`, { requiredCommand: command });
    const raw = [run.message, run.stderr, run.stdout].filter(Boolean).join('\n');
    if (run.errorCode === 'TOOL_MISSING' || run.errorCode === 'LEGACY_PROTOCOL_REQUIRED'
      || /未知命令|unknown command|invalid command|无法识别的命令/i.test(raw)) {
      return failure('LEGACY_PROTOCOL_REQUIRED', `旧协议命令「${command}」不可用：${String(run.message || raw).slice(0, 300)}`, {
        requiredCommand: command,
        protocol: 'legacy',
        exitCode: run.exitCode,
        stdout: tail(run.stdout),
        stderr: tail(run.stderr)
      });
    }
    return {
      ...publicRun(run),
      ok: false,
      code: run.errorCode || 'LEGACY_COMMAND_FAILED',
      message: String(run.message || `旧协议命令「${command}」失败`).slice(0, 400),
      requiredCommand: command
    };
  }

  /**
   * 返回给界面/日志的诊断参数：--boot 的值是启动令牌，绝不能回传。
   * 只脱敏令牌本身，其余参数保持原顺序，便于自测断言“到底传了什么”。
   */
  function publicLegacyArgs(args) {
    const out = [];
    let redact = '';
    for (const value of (Array.isArray(args) ? args : [])) {
      if (redact) {
        out.push(redact);
        redact = '';
        continue;
      }
      const text = String(value);
      out.push(text);
      if (text === '--boot') redact = '<boot>';
      else if (text === '--owner-confirm') redact = '<owner-confirm>';
    }
    return out;
  }

  /**
   * 三条旧协议命令的唯一参数构造器（req review / owner / workflow）。
   * mock 与真实调用共用它，保证自测断言的参数就是命令真正收到的参数；
   * --json 由调用方决定是否追加，避免重复。
   */
  function workflowProtocolArgs(command, input = {}, token = '', withJson = true) {
    const name = String(command || '').trim();
    const boot = String(token || '');
    let args;
    if (name === 'owner') {
      // Owner 是外部角色，没有 --boot；--action 只在验收（accept）时出现。
      args = [
        'owner',
        '--project', String(input.projectName || ''),
        '--requirement', String(input.requirementId || ''),
        '--decision', String(input.decision || ''),
        '--opinion', String(input.opinion || ''),
        ...(input.action ? ['--action', String(input.action)] : []),
        ...(input.ownerConfirmNonce ? ['--owner-confirm', String(input.ownerConfirmNonce)] : [])
      ];
    } else if (name === 'req review') {
      args = [
        'req', 'review', '--boot', boot,
        '--id', String(input.requirementId || ''),
        '--verdict', String(input.verdict || ''),
        '--comments', String(input.comment || ''),
        // 技术评审必须显式带 --kind tech；不带时团队工具默认写需求评审（RR-*）。
        ...(input.kind ? ['--kind', String(input.kind)] : [])
      ];
    } else if (name === 'workflow') {
      args = [
        'workflow', String(input.action || ''), '--boot', boot,
        '--project', String(input.projectName || ''),
        '--opinion', String(input.opinion || '')
      ];
    } else {
      return null;
    }
    if (withJson) args.push('--json');
    return args;
  }

  /**
   * 用角色 boot 令牌跑一条旧命令。所有写操作都带 --boot，令牌不落盘。
   * command 用于缺命令归类；buildArgs 拿 token 生成参数（不含 --json）。
   */
  async function runLegacyCommand(projectName, role, command, buildArgs, options = {}) {
    const guard = requireLegacyCommand(command);
    if (guard) return guard;
    const sessionId = String(options.sessionId || '').trim();
    return withBootToken(projectName, role, async (token) => {
      const args = [...buildArgs(token), '--json'];
      const argv = publicLegacyArgs(args);
      const run = await runNode(layout.teamTool, args, {
        timeoutMs: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : TIMEOUTS.ensure
      });
      if (!run.ok) return { ...classifyLegacyRun(run, command), argv };
      const value = run.value || {};
      if (value.ok === false) {
        return failure(value.code || 'LEGACY_COMMAND_FAILED', String(value.message || `旧协议命令「${command}」失败`).slice(0, 400), {
          command,
          protocol: 'legacy',
          details: value.details && typeof value.details === 'object' ? value.details : {},
          argv
        });
      }
      return { ok: true, code: 'OK', command, value, argv, tokenUsed: token };
    }, sessionId);
  }

  /**
   * 内部换码（不再是 UI 确认）：Owner 决定/验收已废弃 challenge/nonce，UI 不再要求
   * 确认码；但旧 team.mjs 的 owner 命令仍要求一次性 nonce，这里用
   * `owner confirm --test-owner`（TEAM_SELFTEST=1）静默换一张绑定「项目+需求+决定+动作」
   * 的 nonce，只在本进程内存里传给下一条 owner 命令，不返回给渲染层、不要求用户输入。
   * 审计通道由壳层显式标为 ui/tty，不再做旧通道名归一。
   */
  async function issueLegacyOwnerConfirmation(input = {}) {
    const projectName = String(input.projectName || '').trim();
    const requirementId = String(input.requirementId || '').trim();
    const decision = String(input.decision || '').trim();
    const action = String(input.action || '').trim();
    if (!projectName) return failure('PROJECT_REQUIRED', '缺少团队项目名');
    if (!requirementId) return failure('REQUIREMENT_REQUIRED', '缺少需求 id');
    if (!decision) return failure('OWNER_DECISION_INVALID', '缺少 Owner 决定');
    if (action && action !== 'accept') return failure('BAD_ACTION', 'Owner 确认只支持 accept 动作', { action });
    // 自测注入的旧命令桩不启动真实 team.mjs owner confirm；给一个只在本进程内使用的 mock nonce。
    if (legacyMock) {
      return {
        ok: true,
        code: 'OK',
        mocked: true,
        command: 'owner confirm',
        nonce: 'mock-owner-' + crypto.randomBytes(8).toString('hex'),
        expiresAt: new Date(Date.now() + 10 * 60 * 1000).toISOString(),
        confirmation: { channel: 'mock', action: action || 'decision' }
      };
    }
    const commandGuard = requireLegacyCommand('owner');
    if (commandGuard) return commandGuard;
    const args = [
      'owner', 'confirm',
      '--project', projectName,
      '--requirement', requirementId,
      '--decision', decision,
      ...(action ? ['--action', action] : []),
      // 界面通道：Owner 在弹窗里点确认，壳层只负责转交，不注入 TEAM_SELFTEST、不用 --test-owner。
      '--channel', 'ui',
      '--json'
    ];
    const run = await runNode(layout.teamTool, args, {
      timeoutMs: TIMEOUTS.send
    });
    if (!run.ok) return { ...classifyLegacyRun(run, 'owner confirm'), argv: publicLegacyArgs(args) };
    const value = run.value || {};
    if (value.ok === false) {
      return failure(value.code || 'OWNER_CONFIRM_FAILED', String(value.message || '旧 owner confirm 失败').slice(0, 400), {
        command: 'owner confirm', protocol: 'legacy', details: value.details || {}, argv: publicLegacyArgs(args)
      });
    }
    const confirmation = value.confirmation && typeof value.confirmation === 'object' ? value.confirmation : null;
    if (!confirmation || !confirmation.nonce) {
      return failure('BAD_JSON', '旧 owner confirm 没有返回一次性确认码', {
        command: 'owner confirm', protocol: 'legacy', value, argv: publicLegacyArgs(args)
      });
    }
    return {
      ok: true,
      code: 'OK',
      command: 'owner confirm',
      nonce: String(confirmation.nonce),
      expiresAt: confirmation.expiresAt || null,
      confirmation,
      argv: publicLegacyArgs(args)
    };
  }

  /**
   * 旧协议里承载工作流闭环的三个动作：req review / owner / workflow。
   * 有命令就真调用；没有就在任何状态写入之前返回 LEGACY_PROTOCOL_REQUIRED。
   * legacyMock 只用于自测注入，生产代码不会读到它。
   */
  async function runLegacyWorkflowProtocol(command, input = {}) {
    const name = String(command || '').trim();
    const guard = requireLegacyCommand(name);
    if (guard) return guard;
    const plannedArgs = workflowProtocolArgs(name, input, '<boot>', true);
    if (legacyMock) {
      try {
        const result = await legacyMock.run({ command: name, ...input });
        if (!result || result.ok === false) {
          return failure(
            (result && result.code) || 'LEGACY_COMMAND_FAILED',
            String((result && result.message) || `旧协议命令「${name}」执行失败`).slice(0, 400),
            { command: name, protocol: 'legacy', mocked: true, argv: plannedArgs ? publicLegacyArgs(plannedArgs) : [] }
          );
        }
        return {
          ok: true, code: 'OK', command: name, mocked: true,
          value: result.value || result,
          argv: plannedArgs ? publicLegacyArgs(plannedArgs) : []
        };
      } catch (error) {
        return failure('LEGACY_COMMAND_FAILED', `旧协议命令「${name}」异常：${String((error && error.message) || error).slice(0, 300)}`, {
          command: name, protocol: 'legacy', mocked: true, argv: plannedArgs ? publicLegacyArgs(plannedArgs) : []
        });
      }
    }
    if (name === 'owner') {
      // Owner 是外部角色，旧协议不要求他也 boot；命令必须自己校验 Owner 身份/终端。
      const args = workflowProtocolArgs('owner', input, '', true);
      const argv = publicLegacyArgs(args);
      const run = await runNode(layout.teamTool, args, { timeoutMs: TIMEOUTS.proposal });
      if (!run.ok) return { ...classifyLegacyRun(run, name), argv };
      const value = run.value || {};
      if (value.ok === false) {
        return failure(value.code || 'LEGACY_COMMAND_FAILED', String(value.message || '旧 owner 命令失败').slice(0, 400), {
          command: name, protocol: 'legacy', argv
        });
      }
      return { ok: true, code: 'OK', command: name, value, argv };
    }
    if (name === 'req review') {
      // Full 用 product，Fast 用 analyst；不能让旧命令固定成 product（Fast 名册没有 product）。
      const reviewRole = String(input.role || 'product');
      return runLegacyCommand(String(input.projectName || ''), reviewRole, name, (token) => (
        workflowProtocolArgs('req review', input, token, false)
      ), { sessionId: String(input.sessionId || '').trim(), timeoutMs: TIMEOUTS.proposal });
    }
    if (name === 'workflow') {
      return runLegacyCommand(String(input.projectName || ''), 'pm', name, (token) => (
        workflowProtocolArgs('workflow', input, token, false)
      ), { sessionId: String(input.sessionId || '').trim(), timeoutMs: TIMEOUTS.proposal });
    }
    return failure('LEGACY_PROTOCOL_REQUIRED', `旧协议命令「${name}」没有安全调用约定；拒绝用本地状态代替`, {
      command: name, protocol: 'legacy', argv: []
    });
  }

  function workflowFile(projectName) {
    return path.join(projectStateDir(projectName), '工作流.json');
  }

  function emptyWorkflowState(projectName) {
    const at = new Date().toISOString();
    return {
      schema: WORKFLOW_SCHEMA,
      project: String(projectName || ''),
      round: 1,
      phase: 'idle',
      requirements: {},
      ownerReview: { required: false, status: 'optional' },
      ownerRequests: [],
      votes: {},
      boots: {},
      events: [],
      createdAt: at,
      updatedAt: at
    };
  }

  function normalizeWorkflowState(raw, projectName) {
    const base = emptyWorkflowState(projectName);
    const data = raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
    const state = {
      ...base,
      ...data,
      schema: WORKFLOW_SCHEMA,
      project: String(data.project || projectName || ''),
      round: Math.max(1, Number(data.round) || 1),
      phase: WORKFLOW_PHASES.includes(String(data.phase)) ? String(data.phase) : 'idle',
      requirements: {},
      ownerReview: data.ownerReview && typeof data.ownerReview === 'object' ? data.ownerReview : base.ownerReview,
      ownerRequests: Array.isArray(data.ownerRequests) ? data.ownerRequests : [],
      votes: data.votes && typeof data.votes === 'object' && !Array.isArray(data.votes) ? data.votes : {},
      boots: data.boots && typeof data.boots === 'object' && !Array.isArray(data.boots) ? data.boots : {},
      events: Array.isArray(data.events) ? data.events.slice(-300) : []
    };
    const rawReqs = data.requirements;
    if (Array.isArray(rawReqs)) {
      for (const row of rawReqs) if (row && row.id) state.requirements[String(row.id)] = row;
    } else if (rawReqs && typeof rawReqs === 'object') {
      for (const [key, row] of Object.entries(rawReqs)) {
        if (!row || typeof row !== 'object') continue;
        state.requirements[String(row.id || key)] = { ...row, id: String(row.id || key) };
      }
    }
    return state;
  }

  // B-fa80：workflow:state/next 被渲染层每 5 秒轮询；按 mtime+size 缓存解析结果，
  // 文件未变直接返回，避免同步重读+重新解析 190KB 工作流 JSON 阻塞主进程事件循环（输入卡顿）。
  // B-b55c：Owner 验收这类"写前必须知道磁盘现在是什么"的动作传 { fresh: true }，绕过缓存重新读盘，
  // 返回值带 readAt/mtime 作为"这份状态是谁、什么时候读的"来源证据。
  let workflowStateCache = { file: '', key: '', value: null };

  function readWorkflowState(projectName, options = {}) {
    const name = String(projectName || '').trim();
    if (!name) return failure('PROJECT_REQUIRED', '缺少团队项目名');
    const wantFresh = options && options.fresh === true;
    const file = workflowFile(name);
    if (!fs.existsSync(file)) {
      return {
        ok: true, code: 'OK', exists: false, file, raw: null, managed: false,
        state: emptyWorkflowState(name), readAt: new Date().toISOString(), mtime: ''
      };
    }
    // mtime+size 未变 → 直接返回缓存对象（写路径会清缓存，见 writeWorkflowState）。
    let cacheKey = '';
    let mtime = '';
    try {
      const st = fs.statSync(file);
      cacheKey = `${st.mtimeMs}:${st.size}`;
      mtime = st.mtime.toISOString();
      if (!wantFresh && workflowStateCache.file === file && workflowStateCache.key === cacheKey) {
        return { ...workflowStateCache.value, cached: true };
      }
    } catch { /* stat 失败按未缓存处理 */ }
    const raw = readJsonSafe(file);
    if (!raw || typeof raw !== 'object') {
      return failure('WORKFLOW_CORRUPT', `旧 工作流.json 无法解析：${file}`, { file });
    }
    // managed：这份 工作流.json 是否由本闭环写过（schema>=2 或带 requirements）。
    // 旧 shell 只写 ownerReview 的文件不能拿来覆盖本地流程阶段。
    const requirementCount = raw.requirements && typeof raw.requirements === 'object'
      ? (Array.isArray(raw.requirements) ? raw.requirements.length : Object.keys(raw.requirements).length)
      : 0;
    const managed = Number(raw.schema || 0) >= WORKFLOW_SCHEMA || requirementCount > 0;
    const result = {
      ok: true, code: 'OK', exists: true, file, raw, managed,
      state: normalizeWorkflowState(raw, name),
      readAt: new Date().toISOString(),
      mtime
    };
    if (cacheKey) workflowStateCache = { file, key: cacheKey, value: result };
    return result;
  }

  /**
   * 状态的"来源证据"：同一份 工作流.json、同一时刻读到的状态是谁写的、什么时候。
   * 列表与确认都带这个对象，界面才能在人话里写清"界面看到 X（读于 T1），磁盘是 Y（更新于 T2）"。
   */
  function workflowStateSource(read) {
    const file = String((read && read.file) || '');
    let mtime = String((read && read.mtime) || '');
    if (!mtime && file) {
      try { mtime = fs.statSync(file).mtime.toISOString(); } catch { mtime = ''; }
    }
    return {
      file,
      updatedAt: String((read && read.state && read.state.updatedAt) || ''),
      mtime,
      readAt: String((read && read.readAt) || new Date().toISOString()),
      cached: Boolean(read && read.cached)
    };
  }

  function writeWorkflowState(projectName, state) {
    // 写前先失效缓存：调用方可能改过 read.state；即使写盘失败也不能让下次读到脏缓存。
    workflowStateCache = { file: '', key: '', value: null };
    const name = String(projectName || '').trim();
    if (!name) return failure('PROJECT_REQUIRED', '缺少团队项目名');
    const next = normalizeWorkflowState(state, name);
    next.updatedAt = new Date().toISOString();
    try {
      writeJsonAtomic(workflowFile(name), next);
      // 写成功立即失效缓存：同一毫秒内 mtime 可能不变，不能靠 mtime 自动识别。
      workflowStateCache = { file: '', key: '', value: null };
      return { ok: true, code: 'OK', file: workflowFile(name), state: next };
    } catch (error) {
      return failure('WORKFLOW_WRITE_FAILED', `写旧 工作流.json 失败：${String(error && error.message || error).slice(0, 300)}`, {
        file: workflowFile(name)
      });
    }
  }

  function pushWorkflowEvent(state, event) {
    if (!state || typeof state !== 'object') return;
    state.events = Array.isArray(state.events) ? state.events : [];
    state.events.push({ at: new Date().toISOString(), ...(event || {}) });
    if (state.events.length > 300) state.events = state.events.slice(-300);
  }

  // 旧 workflow.mjs 已经会写 history/events；壳只镜像业务字段，不能把同一次
  // 评审/Owner/验收/迭代记两遍。这里按“同类动作 + 需求 + 10 分钟窗口”判断重复。
  // 旧命令没有写记录时（例如 selftest 的命令桩）仍然由壳补一条，保持审计可见。
  const WORKFLOW_AUDIT_DEDUPE_MS = 10 * 60 * 1000;

  function auditMomentMatches(left, right) {
    const a = Date.parse(String(left || ''));
    const b = Date.parse(String(right || ''));
    if (!Number.isFinite(a) || !Number.isFinite(b)) return true;
    return Math.abs(a - b) <= WORKFLOW_AUDIT_DEDUPE_MS;
  }

  function hasRecentAudit(rows, options = {}) {
    const list = Array.isArray(rows) ? rows.slice(-40) : [];
    const actions = Array.isArray(options.actions) && options.actions.length
      ? options.actions.map(String)
      : (options.action ? [String(options.action)] : []);
    const requirementId = options.requirementId === undefined ? null : String(options.requirementId || '');
    const matchNote = options.matchNote !== false && options.note !== undefined;
    return list.some((row) => {
      if (!row || typeof row !== 'object') return false;
      if (actions.length && !actions.includes(String(row.action || ''))) return false;
      if (requirementId !== null && String(row.requirementId || '') !== requirementId) return false;
      if (matchNote && String(row.note || '') !== String(options.note || '')) return false;
      return auditMomentMatches(row.at, options.at);
    });
  }

  function pushHistoryOnce(row, entry, options = {}) {
    if (!row || typeof row !== 'object') return false;
    const history = Array.isArray(row.history) ? row.history : [];
    if (hasRecentAudit(history, {
      actions: options.actions,
      action: entry.action,
      note: entry.note,
      matchNote: options.matchNote,
      at: entry.at
    })) return false;
    row.history = history;
    row.history.push(entry);
    return true;
  }

  function pushWorkflowEventOnce(state, event, options = {}) {
    if (!state || typeof state !== 'object') return false;
    if (hasRecentAudit(state.events, {
      actions: options.actions,
      action: event.action,
      requirementId: options.requirementId === undefined ? event.requirementId : options.requirementId,
      note: event.note,
      matchNote: options.matchNote,
      at: event.at
    })) return false;
    pushWorkflowEvent(state, event);
    return true;
  }

  function mutateWorkflowState(projectName, mutator) {
    const read = readWorkflowState(projectName);
    if (!read.ok) return read;
    // 命中缓存时必须先克隆再交给 mutator：mutator 会原地改 state，不能污染缓存对象。
    const state = read.cached ? structuredClone(read.state) : read.state;
    try {
      if (typeof mutator === 'function') mutator(state);
    } catch (error) {
      return failure('WORKFLOW_MUTATE_FAILED', String(error && error.message || error).slice(0, 300), { file: read.file });
    }
    state.updatedAt = new Date().toISOString();
    return writeWorkflowState(projectName, state);
  }

  function roleDirOf(role) {
    return ROLE_DIRS[String(role || '')] || '';
  }

  function projectInfoTemplate(projectName) {
    return `# ${projectName} · 项目信息\n\n`
      + '## 一、目标\n\n（待项目经理填写）\n\n'
      + '## 二、场景\n\n（待填写）\n\n'
      + '## 三、交付\n\n- 代码目录：site/\n- 文档：各角色目录\n- 临时文件：_tmp/（交付前清理）\n\n'
      + '## 四、边界\n\n（待填写）\n\n'
      + '## 五、角色\n\n'
      + '- 项目经理：协调、派单、催回执\n'
      + '- 产品设计师：需求/架构评审、优先级建议\n'
      + '- 需求分析师：需求正文、验收标准、追踪矩阵\n'
      + '- 高级程序员 A/B：开发、互审、提交提案\n'
      + '- 测试人员：独立验证、缺陷闭环\n';
  }

  function collaborationTemplate(projectName) {
    return `# ${projectName} · 六角色协作准则\n\n`
      + '1. **先读后写**：每轮先读《项目铁律.md》《项目信息.md》《项目索引.md》、角色卡与文件索引。\n'
      + '2. **需求闸门**：产品/需求分析师创建需求 → 产品评审 → Owner 参与或跳过 → PM 才能派开发任务。\n'
      + '3. **开发闸门**：开发 claim → 提案 → 互审 → PM 签字/apply → task done。\n'
      + '4. **测试闸门**：测试 claim → 证据 → task done → Owner 验收。\n'
      + '5. **没有回执 = 没发生**；变更只走 propose → show → review → sign → apply。\n';
  }

  function roleCardTemplate(projectName, role) {
    return `# ${ROLE_NAMES[role] || role} · 角色卡\n\n`
      + `- 项目：${projectName}\n- 角色 id：${role}\n`
      + `- 每轮必读：项目铁律、项目信息、角色卡、项目索引\n`
      + `- 写入范围：${ROLE_NAMES[role] || role}/（程序员代码目录以项目信息为准）\n`;
  }

  function roleIndexTemplate(role) {
    return `# ${ROLE_NAMES[role] || role} · 文件索引\n\n> 先读索引再读文件；每次交付后由本角色更新。\n\n| 文件 | 用途 | 状态 |\n|---|---|---|\n`;
  }

  function readDocRecord(file) {
    const record = { path: file, exists: false, size: 0, hash: '', excerpt: '' };
    try {
      const stat = fs.statSync(file);
      if (!stat.isFile()) return record;
      const buffer = fs.readFileSync(file);
      record.exists = true;
      record.size = stat.size;
      record.mtime = stat.mtime.toISOString();
      record.hash = crypto.createHash('sha256').update(buffer).digest('hex');
      record.excerpt = buffer.toString('utf8', 0, Math.min(180, buffer.length)).replace(/\s+/g, ' ').trim();
    } catch { /* 缺失就是缺失 */ }
    return record;
  }

  /**
   * 模板占位检测：与界面 legacyPlaceholderDocs 同一条正则。
   * boot 不能把 ensureProjectStructure 刚补出来的模板当成“角色已经读过”。
   */
  function placeholderTerms(file) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return []; }
    const matches = String(text).match(/（待[^）]*）|待填写|待补/g) || [];
    return [...new Set(matches)];
  }

  /** 项目创建/恢复后的硬校验：六角色目录 + 项目信息/铁律/索引。缺什么补什么。 */
  async function ensureProjectStructure(project) {
    const name = String((project && (project.name || project.teamName)) || '').trim();
    const root = path.resolve(String((project && (project.projectPath || project.path)) || ''));
    if (!name) return failure('PROJECT_REQUIRED', '缺少团队项目名');
    if (!root) return failure('PROJECT_PATH_REQUIRED', '缺少项目目录');
    if (!isDirectory(root)) return failure('PROJECT_DIR_MISSING', `项目目录不存在：${root}`, { projectPath: root });
    const repaired = [];
    const mode = normalizeTeamMode(project);
    const roleIds = roleIdsForTeamMode(mode);
    const excludedRoles = ROLE_IDS.filter((role) => !roleIds.includes(role));
    const roles = {};
    for (const role of roleIds) {
      const rel = roleDirOf(role);
      const dir = path.join(root, rel);
      if (!fs.existsSync(dir)) {
        fs.mkdirSync(dir, { recursive: true });
        repaired.push(rel + '/');
      }
      roles[role] = { role, dir: rel, path: dir, exists: isDirectory(dir) };
      for (const [file, text] of [
        ['角色卡.md', roleCardTemplate(name, role)],
        ['文件索引.md', roleIndexTemplate(role)]
      ]) {
        const target = path.join(dir, file);
        if (!fs.existsSync(target)) {
          writeTextAtomic(target, text);
          repaired.push(`${rel}/${file}`);
        }
      }
      // 旧脚手架（scaffold.mjs inspectProject）把“产出/”也算六角色硬前提；
      // 壳只补目录，不替旧工具写产物说明。
      const artifactDir = path.join(dir, '产出');
      if (!fs.existsSync(artifactDir)) {
        fs.mkdirSync(artifactDir, { recursive: true });
        repaired.push(`${rel}/产出/`);
      }
    }
    for (const dir of ['src', '_tmp', '需求']) {
      const target = path.join(root, dir);
      if (!fs.existsSync(target)) {
        fs.mkdirSync(target, { recursive: true });
        repaired.push(dir + '/');
      }
    }
    // 旧 boot（store.mjs readDocSet）把《需求总览》列为必读文件；缺了会拒绝 boot。
    const overviewFile = path.join(root, '需求', '00-需求总览.md');
    if (!fs.existsSync(overviewFile)) {
      writeTextAtomic(overviewFile, '# 需求总览\n\n| 需求 | 标题 | 优先级 | 状态 | 验收标准 |\n|---|---|---|---|---|\n');
      repaired.push('需求/00-需求总览.md');
    }
    const infoFile = path.join(root, '项目信息.md');
    if (!fs.existsSync(infoFile)) {
      writeTextAtomic(infoFile, projectInfoTemplate(name));
      repaired.push('项目信息.md');
    }
    const ironFile = path.join(root, '项目铁律.md');
    if (!fs.existsSync(ironFile)) {
      const source = path.join(layout.root, '项目铁律.md');
      if (fs.existsSync(source)) {
        writeTextAtomic(ironFile, fs.readFileSync(source, 'utf8'));
        repaired.push('项目铁律.md');
      }
    }
    const collaborationFile = path.join(root, '协作准则.md');
    if (!fs.existsSync(collaborationFile)) {
      writeTextAtomic(collaborationFile, collaborationTemplate(name));
      repaired.push('协作准则.md');
    }
    let indexRun = null;
    if (!fs.existsSync(path.join(root, '项目索引.md')) || !fs.existsSync(path.join(root, '项目索引.json'))) {
      const guard = requireLegacyCommand('index');
      if (!guard) {
        const run = await runNode(layout.teamTool, ['index', '--project', name, '--json'], { timeoutMs: TIMEOUTS.ensure });
        indexRun = run.ok
          ? { ok: true, files: run.value && run.value.files }
          : { ok: false, code: run.errorCode || 'INDEX_FAILED', message: run.message || '' };
      } else {
        indexRun = { ok: false, code: guard.code, message: guard.message };
      }
    }
    const docs = {
      projectInfo: readDocRecord(infoFile),
      iron: readDocRecord(ironFile),
      collaboration: readDocRecord(collaborationFile),
      projectIndex: readDocRecord(path.join(root, '项目索引.md')),
      projectIndexJson: readDocRecord(path.join(root, '项目索引.json')),
      requirementOverview: readDocRecord(overviewFile)
    };
    const missing = [];
    for (const [key, label] of [
      ['projectInfo', '项目信息.md'],
      ['iron', '项目铁律.md'],
      ['projectIndex', '项目索引.md'],
      ['projectIndexJson', '项目索引.json'],
      ['requirementOverview', '需求/00-需求总览.md']
    ]) {
      if (!docs[key].exists) missing.push(label);
    }
    for (const role of roleIds) if (!roles[role] || !roles[role].exists) missing.push(roleDirOf(role) + '/');
    return {
      ok: missing.length === 0,
      code: missing.length ? 'PROJECT_STRUCTURE_INCOMPLETE' : 'OK',
      name,
      root,
      teamMode: mode,
      roleIds,
      excludedRoles,
      roles,
      docs,
      missing,
      repaired,
      index: indexRun,
      message: missing.length ? `项目结构不完整：缺少 ${missing.join('、')}` : ''
    };
  }

  /**
   * Fast 模式不创建 product/programmer2 目录：
   * 旧 workspace.mjs ensure 无法带角色子集，会在每次 ensure 时重新 scaffold 六角色。
   * 这里只清理由本次 ensure 新建、且内容仅为自动生成角色卡/索引的空目录；
   * 用户原有目录/文件一律不碰（Full→Fast 切换保留历史目录）。
   */
  function snapshotExcludedRoleDirs(root, mode) {
    const snapshot = {};
    for (const role of ROLE_IDS) {
      if (isRoleInTeamMode(role, mode)) continue;
      snapshot[role] = fs.existsSync(path.join(root, roleDirOf(role)));
    }
    return snapshot;
  }

  function pruneExcludedRoleDirs(root, mode, snapshot = {}) {
    if (normalizeTeamMode(mode) !== 'fast') return [];
    const removed = [];
    const generatedOnly = (dir) => {
      let entries = [];
      try { entries = fs.readdirSync(dir); } catch { return false; }
      for (const name of entries) {
        if (name === '角色卡.md' || name === '文件索引.md') continue;
        // 旧 scaffold 还会建空的 产出/，同样属于“本次自动生成、没有用户内容”。
        if (name === '产出') {
          const artifactDir = path.join(dir, name);
          try {
            if (isDirectory(artifactDir) && fs.readdirSync(artifactDir).length === 0) continue;
          } catch { /* 读不了就按用户内容保留 */ }
        }
        return false;
      }
      return true;
    };
    for (const role of ROLE_IDS) {
      if (isRoleInTeamMode(role, mode)) continue;
      if (snapshot[role] === true) continue;
      const dir = path.join(root, roleDirOf(role));
      if (!fs.existsSync(dir) || !isDirectory(dir)) continue;
      if (!generatedOnly(dir)) continue;
      try {
        fs.rmSync(dir, { recursive: true, force: true });
        removed.push(roleDirOf(role) + '/');
      } catch { /* 删不掉就保留，不能为了“目录不存在”破坏项目 */ }
    }
    return removed;
  }

  /**
   * 旧 index 命令递归扫描 需求/，会把 需求/评审/、需求/验收/ 下的记录也当成需求。
   * 壳在命令结束后只保留 需求/ 直接子文件里的 R-*.md，一条需求只留一行。
   */
  function sanitizedIndexRequirementDocs(projectPath) {
    const docs = readRequirementDocs(projectPath).list;
    const seen = new Set();
    const out = [];
    for (const doc of docs) {
      const key = requirementIdKey(doc.id);
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(doc);
    }
    return out;
  }

  function indexRequirementUpdatedAt(doc) {
    const stamp = doc && doc.mtime ? Date.parse(String(doc.mtime)) : NaN;
    const date = new Date(Number.isFinite(stamp) ? stamp : Date.now());
    return date.toISOString().slice(0, 16).replace('T', ' ');
  }

  function sanitizeProjectIndexFiles(projectPath, requirements) {
    const root = path.resolve(projectPath);
    const jsonFile = path.join(root, '项目索引.json');
    const mdFile = path.join(root, '项目索引.md');
    const raw = readJsonSafe(jsonFile);
    if (!raw || typeof raw !== 'object') {
      return { ok: false, code: 'INDEX_JSON_INVALID', message: `项目索引 JSON 不是对象：${jsonFile}` };
    }
    const rows = (Array.isArray(requirements) ? requirements : []).map((doc) => ({
      id: String(doc.id),
      target: String(doc.rel)
    }));
    raw.requirements = rows;
    try {
      writeJsonAtomic(jsonFile, raw);
    } catch (error) {
      return {
        ok: false, code: 'INDEX_JSON_WRITE_FAILED',
        message: `清理项目索引 JSON 失败：${String(error && error.message || error).slice(0, 200)}`
      };
    }
    let text = '';
    try { text = fs.readFileSync(mdFile, 'utf8'); } catch {
      return { ok: true, code: 'OK', jsonFile, mdFile, rewrittenMd: false };
    }
    const lines = text.split(/\r?\n/);
    const start = lines.findIndex((line) => /^##\s+三、需求目录\s*$/.test(line));
    if (start < 0) return { ok: true, code: 'OK', jsonFile, mdFile, rewrittenMd: false };
    let end = start + 1;
    while (end < lines.length && !/^##\s+/.test(lines[end])) end += 1;
    const section = [
      '## 三、需求目录',
      '',
      '| 需求 id | 文件 | 摘要 | 状态 | 更新 |',
      '|---|---|---|---|---|'
    ];
    for (const doc of (Array.isArray(requirements) ? requirements : [])) {
      const id = String(doc.id || '');
      const rel = String(doc.rel || '');
      const label = String(path.basename(rel) || id).replace(/\]/g, '\\]');
      const title = String(doc.title || '（未命名）').replace(/\|/g, '/');
      const summary = `${id} · ${title}`.replace(/\|/g, '/');
      section.push(`| ${id} | [${label}](${rel}) | ${summary} | 已登记 | ${indexRequirementUpdatedAt(doc)} |`);
    }
    const next = [...lines.slice(0, start), ...section, '', ...lines.slice(end)].join('\n');
    try {
      writeTextAtomic(mdFile, next.endsWith('\n') ? next : next + '\n');
    } catch (error) {
      return {
        ok: false, code: 'INDEX_MD_WRITE_FAILED',
        message: `清理项目索引 Markdown 失败：${String(error && error.message || error).slice(0, 200)}`
      };
    }
    return { ok: true, code: 'OK', jsonFile, mdFile, rewrittenMd: true };
  }

  /**
   * 旧 index 命令刷新项目索引：需求创建/评审/Owner 决定/验收后调用。
   * 索引失败只作为警告返回，不能把已经落账的业务动作伪装成失败。
   */
  async function refreshProjectIndex(projectName, projectPath) {
    const name = String(projectName || '').trim();
    const root = String(projectPath || '').trim();
    if (!name) return { ok: false, code: 'PROJECT_REQUIRED', message: '缺少团队项目名' };
    if (!root) return { ok: false, code: 'PROJECT_PATH_REQUIRED', message: '缺少项目目录，无法刷新项目索引' };
    const guard = requireLegacyCommand('index');
    if (guard) {
      return {
        ok: false, skipped: true,
        code: guard.code || 'LEGACY_PROTOCOL_REQUIRED',
        message: guard.message || '旧 index 命令不可用'
      };
    }
    const run = await runNode(layout.teamTool, ['index', '--project', name, '--json'], { timeoutMs: TIMEOUTS.ensure });
    if (!run.ok) {
      return { ok: false, code: run.errorCode || 'INDEX_FAILED', message: run.message || '旧 index 命令执行失败' };
    }
    const value = run.value || {};
    const jsonFile = path.join(path.resolve(root), '项目索引.json');
    if (!fs.existsSync(jsonFile)) {
      return {
        ok: false, code: 'INDEX_NOT_WRITTEN',
        message: `旧 index 命令结束但没有写出项目索引：${jsonFile}`
      };
    }
    // 旧命令按递归扫描把评审/验收记录也算成需求；这里以 需求/ 直接子文件纠正，
    // 否则界面会把“一条需求 + 两条评审记录”显示成 3 条需求。
    const requirements = sanitizedIndexRequirementDocs(root);
    const sanitized = sanitizeProjectIndexFiles(root, requirements);
    if (!sanitized.ok) return sanitized;
    return {
      ok: true,
      code: 'OK',
      file: value.path || path.join(path.resolve(root), '项目索引.md'),
      jsonFile,
      files: Number(value.files) || 0,
      requirements: requirements.length,
      roleIndexes: Number(value.roleIndexes) || 0,
      generatedAt: new Date().toISOString(),
      sanitized: {
        requirements: requirements.length,
        droppedRecords: Math.max(0, Number(value.requirements || 0) - requirements.length)
      }
    };
  }

  function projectIndexWarning(index) {
    if (!index || index.ok) return null;
    return {
      code: index.code || 'PROJECT_INDEX_REFRESH_FAILED',
      message: index.message || '项目索引刷新失败',
      skipped: Boolean(index.skipped)
    };
  }

  /** 名册只补当前团队模式的角色，不动现有 sessionId；否则新项目 boot 会撞 NO_MEMBER。
   *  R-b52b F-8：项目.json 里已有显式 roleIds 时**只补这些角色**，不按模式回填——
   *  测试把 tester 从 roleIds 删掉后，壳层启动/ensure 不得把它加回来（否则“无 tester”夹具不成立）。 */
  function ensureRosterRoles(projectName, teamMode = DEFAULT_TEAM_MODE) {
    const name = String(projectName || '').trim();
    if (!name) return { ok: false, code: 'PROJECT_REQUIRED' };
    const mode = normalizeTeamMode(teamMode);
    const explicit = (() => {
      try {
        const cfg = readJsonSafe(path.join(projectStateDir(name), '项目.json'));
        return cfg && Array.isArray(cfg.roleIds) ? cfg.roleIds.map((id) => String(id || '').trim()).filter(Boolean) : [];
      } catch { return []; }
    })();
    const roleIds = explicit.length ? explicit : roleIdsForTeamMode(mode);
    const backfillSkipped = Boolean(explicit.length) && explicit.length !== roleIdsForTeamMode(mode).length;
    const team = readJsonSafe(layout.teamFile);
    if (!team || !Array.isArray(team.members)) return { ok: false, code: 'NO_TEAM' };
    let added = 0;
    for (const role of roleIds) {
      if (team.members.some((member) => member && member.role === role && member.status !== 'removed')) continue;
      team.members.push({
        role,
        name: ROLE_NAMES[role] || role,
        status: 'active',
        joinedAt: new Date().toISOString(),
        sessionId: ''
      });
      added += 1;
    }
    if (added) {
      try { writeJsonAtomic(layout.teamFile, team); } catch (error) {
        return { ok: false, code: 'ROSTER_WRITE_FAILED', message: String(error && error.message || error).slice(0, 200) };
      }
    }
    return { ok: true, code: added ? 'ROSTER_ADDED' : 'ROSTER_READY', added, teamMode: mode, roleIds, backfillSkipped, explicitRoleIds: explicit.length > 0 };
  }

  /** 项目创建/恢复的统一入口：旧 workspace ensure + 当前模式角色目录 + 文档 + 索引。 */
  async function ensureProjectReady(project, options = {}) {
    const mode = normalizeTeamMode(options.teamMode || project);
    const source = { ...(project || {}), teamMode: mode };
    const initialRoot = path.resolve(String(source.path || ''));
    const excludedBefore = initialRoot ? snapshotExcludedRoleDirs(initialRoot, mode) : {};
    const ensured = await ensureProject(source, { ...options, teamMode: mode });
    if (!ensured.ok) return ensured;
    const root = path.resolve(String(ensured.projectPath || source.path || ''));
    // 旧 workspace.mjs ensure 会 scaffold 六角色；Fast 在这里撤掉本次新造的两套空目录。
    const removedDirs = pruneExcludedRoleDirs(root, mode, excludedBefore);
    const roster = ensureRosterRoles(ensured.name, mode);
    const structure = await ensureProjectStructure({
      name: ensured.name,
      path: ensured.projectPath || source.path,
      projectPath: ensured.projectPath,
      teamMode: mode
    });
    // 模式写入已由旧 workspace.mjs --team-mode 完成（项目.json + workspace.json）；
    // 壳不再手写 workspace.json，避免两套格式和静默覆盖。
    if (!structure.ok) {
      return {
        ...ensured,
        ok: false,
        code: structure.code || 'PROJECT_STRUCTURE_INCOMPLETE',
        message: structure.message || '项目结构不完整',
        teamMode: mode,
        roleIds: roleIdsForTeamMode(mode),
        structure,
        roster
      };
    }
    let index = null;
    if (removedDirs.length) {
      index = await refreshProjectIndex(ensured.name, root);
      structure.removed = removedDirs;
      structure.indexAfterPrune = index;
    }
    return {
      ...ensured,
      ok: true,
      teamMode: mode,
      roleIds: roleIdsForTeamMode(mode),
      excludedRoles: ROLE_IDS.filter((role) => !isRoleInTeamMode(role, mode)),
      removedDirs,
      structure,
      structureOk: true,
      roster
    };
  }

  /**
   * boot 必读文件必须与旧 team.mjs（lib/store.mjs readDocSet）同一套：
   * 宪法、项目铁律、项目信息、项目角色卡、项目索引、需求总览。
   * 旧工具已经不再读全局角色卡，也不再把全局铁律当回退；壳不能自己另造一套。
   */
  function bootDocSpecs(projectPath, role) {
    const root = path.resolve(projectPath);
    const roleDir = roleDirOf(role);
    return [
      { key: 'constitution', label: '团队宪法', path: path.join(layout.root, '团队宪法.md'), required: true },
      { key: 'iron', label: '项目铁律', path: path.join(root, '项目铁律.md'), required: true },
      { key: 'projectInfo', label: '项目信息', path: path.join(root, '项目信息.md'), required: true },
      { key: 'roleCard', label: '角色卡', path: roleDir ? path.join(root, roleDir, '角色卡.md') : '', required: true },
      { key: 'projectIndex', label: '项目索引', path: path.join(root, '项目索引.md'), required: true },
      { key: 'requirementOverview', label: '需求总览', path: path.join(root, '需求', '00-需求总览.md'), required: true },
      { key: 'collaboration', label: '协作准则', path: path.join(root, '协作准则.md'), required: false }
    ];
  }

  /** 项目信息/铁律仍是模板占位时，boot 与后续闸门都不能放行。 */
  function bootPlaceholderDocs(projectPath, role) {
    const out = [];
    for (const spec of bootDocSpecs(projectPath, role)) {
      if (!['projectInfo', 'iron'].includes(spec.key)) continue;
      const terms = placeholderTerms(spec.path || '');
      if (terms.length) out.push({ key: spec.key, label: spec.label, terms, path: spec.path });
    }
    return out;
  }

  // 旧项目/旧工具用 4 位序号（R-YYYYMMDD-0001），新工具用 6 位；统一按 4–8 位读取。
  const REQ_FILE_RE = /^R-\d{8}-\d{4,8}(?:-[0-9a-f]{2,8})?/i;
  const REQ_STATUS_ALIASES = [
    ['测试完成', 'test_done'], ['测试通过', 'test_done'],
    ['已验收', 'accepted'], ['已接受', 'accepted'],
    ['已终止', 'terminated'], ['已迭代', 'iteration'],
    ['待评审', 'review'], ['评审中', 'review'], ['需求评审', 'review'],
    ['已通过', 'approved'], ['待派单', 'ready'], ['已派单', 'dispatched'],
    ['开发中', 'dev'], ['开发完成', 'dev_done'], ['待测试', 'test'], ['测试中', 'test']
  ];
  const REQ_STATUS_VALUES = ['review', 'approved', 'ready', 'dispatched', 'dev', 'dev_done', 'test', 'test_done', 'accepted', 'terminated', 'iteration', 'rejected'];

  /**
   * 4 位/6 位旧需求号按“同一天 + 同一序号”视为同一条需求。
   * 只用它做查找/去重，绝不改写需求正文里的原始编号。
   */
  function requirementIdKey(value) {
    const text = String(value == null ? '' : value).trim();
    const match = text.match(/^R-(\d{8})-(\d{4,8})(?:-|$)/i);
    if (!match) return text.toUpperCase();
    return `R-${match[1]}-${Number(match[2])}`;
  }

  /** 从需求正文中取一个二级章节的正文；找不到返回空串。 */
  function requirementSection(text, headings) {
    const names = (Array.isArray(headings) ? headings : [headings]).map((name) => String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
    if (!names.length) return '';
    const head = new RegExp('^##\\s+(?:' + names.join('|') + ')\\s*$', 'm').exec(String(text || ''));
    if (!head) return '';
    const rest = String(text).slice(head.index + head[0].length);
    const next = rest.search(/^##\s+/m);
    return (next >= 0 ? rest.slice(0, next) : rest).trim();
  }

  function normalizeRequirementDocStatus(raw) {
    const text = String(raw || '').trim();
    if (!text) return '';
    if (WORKFLOW_PHASES.includes(text) || REQ_STATUS_VALUES.includes(text)) return text;
    for (const [needle, status] of REQ_STATUS_ALIASES) {
      if (text.includes(needle)) return status;
    }
    return '';
  }

  /**
   * 需求总览是旧项目里唯一能说明“已验收/已终止”的来源之一。
   * 按表头找「需求 id」「优先级」「状态」列，不假设列顺序。
   */
  function readRequirementOverviewMeta(projectPath) {
    const out = new Map();
    const file = path.join(path.resolve(String(projectPath || '')), '需求', '00-需求总览.md');
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return out; }
    let header = null;
    for (const line of String(text).split(/\r?\n/)) {
      if (!/^\s*\|/.test(line)) continue;
      const cells = line.trim().replace(/^\|/, '').replace(/\|$/, '').split('|').map((cell) => cell.trim());
      if (!header) {
        if (cells.some((cell) => /状态/.test(cell)) && cells.some((cell) => /需求|id/i.test(cell))) header = cells;
        continue;
      }
      if (cells.every((cell) => /^:?-{2,}:?$/.test(cell))) continue;
      const idIndex = header.findIndex((cell) => /需求\s*id|需求ID|^id$/i.test(cell));
      const statusIndex = header.findIndex((cell) => /状态/.test(cell));
      const priorityIndex = header.findIndex((cell) => /优先级/.test(cell));
      const idCell = cells[idIndex >= 0 ? idIndex : 0] || '';
      const match = String(idCell).match(REQ_FILE_RE);
      if (!match) continue;
      out.set(match[0], {
        status: normalizeRequirementDocStatus(statusIndex >= 0 ? cells[statusIndex] : ''),
        priority: priorityIndex >= 0 ? String(cells[priorityIndex] || '').match(/P[0-3]/i)?.[0]?.toUpperCase() || '' : ''
      });
    }
    return out;
  }

  /** 需求正文自身的状态/优先级行优先；没有时回退到总览同名列。 */
  function readRequirementDocMeta(file, id, overview) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { return { title: '', status: '', priority: '' }; }
    const heading = String(text).match(/^\s*#\s+(.+?)\s*$/m);
    let title = heading ? heading[1].trim() : '';
    if (title && title.startsWith(id)) {
      title = title.slice(id.length).replace(/^\s*[·:：\-–—]\s*/, '').trim();
    }
    const statusMatch = String(text).match(/^\s*-\s*状态\s*[：:]\s*(.+?)\s*$/m);
    const priorityMatch = String(text).match(/^\s*-\s*优先级\s*[：:]\s*(P[0-3])/im);
    const meta = overview.get(id) || {};
    return {
      title: title || meta.title || '',
      status: normalizeRequirementDocStatus(statusMatch ? statusMatch[1] : '') || meta.status || '',
      priority: (priorityMatch ? priorityMatch[1].toUpperCase() : '') || meta.priority || ''
    };
  }

  /**
   * 本轮“相关需求”：项目 需求/ 下的全部 R-*.md。boot 一次读齐并记录哈希，
   * 录完又有新需求/需求正文变化时，旧 boot 记录视为过期，必须重新 boot。
   */
  function readRequirementDocs(projectPath) {
    const root = path.resolve(projectPath);
    const dir = path.join(root, '需求');
    const list = [];
    let names = [];
    try { names = fs.readdirSync(dir); } catch { names = []; }
    const overview = readRequirementOverviewMeta(root);
    for (const name of names) {
      if (!/\.md$/i.test(name)) continue;
      const match = name.match(REQ_FILE_RE);
      if (!match) continue;
      const file = path.join(dir, name);
      const record = readDocRecord(file);
      if (!record.exists) continue;
      const meta = readRequirementDocMeta(file, match[0], overview);
      let contentHash = '';
      try {
        contentHash = crypto.createHash('sha256').update(requirementContentText(fs.readFileSync(file, 'utf8'))).digest('hex');
      } catch { contentHash = ''; }
      list.push({
        id: match[0],
        file,
        rel: '需求/' + name,
        hash: record.hash,
        // 内容哈希：忽略「- 状态：」与「## 状态记录」这类程序自己维护的元数据。
        contentHash,
        size: record.size,
        mtime: record.mtime || null,
        title: meta.title,
        status: meta.status,
        priority: meta.priority
      });
    }
    list.sort((a, b) => a.rel.localeCompare(b.rel, 'zh-Hans-CN'));
    const hash = crypto.createHash('sha256')
      .update(JSON.stringify(list.map((row) => [row.rel, row.hash])))
      .digest('hex');
    const contentHash = crypto.createHash('sha256')
      .update(JSON.stringify(list.map((row) => [row.rel, row.contentHash])))
      .digest('hex');
    return { list, hash, contentHash, count: list.length };
  }

  /**
   * 需求正文“内容文本”：去掉机器维护的 `- 状态：` 行与 `## 状态记录` 区。
   * 与 团队/工具/lib/scaffold.mjs 的 requirementContentText 保持同一口径。
   */
  function requirementContentText(text) {
    const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
    const out = [];
    let inStatusSection = false;
    for (const line of lines) {
      if (/^##\s+状态记录/.test(line)) { inStatusSection = true; continue; }
      if (inStatusSection && /^##\s+/.test(line)) inStatusSection = false;
      if (inStatusSection) continue;
      if (/^- 状态：/.test(line)) continue;
      out.push(line.replace(/\s+$/, ''));
    }
    return out.join('\n').trim();
  }

  function readBootDocs(projectPath, role) {
    const docs = {};
    const missing = [];
    for (const spec of bootDocSpecs(projectPath, role)) {
      const record = readDocRecord(spec.path || '');
      docs[spec.key] = { ...record, label: spec.label, required: spec.required !== false };
      if (spec.required !== false && !record.exists) missing.push(spec.label);
    }
    const requirements = readRequirementDocs(projectPath);
    return { docs, requirements, missing, complete: missing.length === 0 };
  }

  /**
   * 每个角色每轮 boot：先自己读齐四样必读文件，再调旧 team.mjs boot 拿令牌。
   * 旧工具只把宪法/铁律/角色卡/索引哈希进令牌；项目信息在本层额外读并记入 工作流.json。
   */
  async function bootRole(projectName, role, options = {}) {
    const name = String(projectName || '').trim();
    const roleId = String(role || '').trim();
    if (!name) return failure('PROJECT_REQUIRED', '缺少团队项目名');
    if (!ROLE_IDS.includes(roleId)) return failure('BAD_ROLE', `角色无效；可用角色：${ROLE_IDS.join(', ')}`);
    const registration = registrationFor(name);
    // 未显式给 teamMode 时按项目.json 的真实模式，避免 fast 项目自动 boot 时补出 full 角色目录。
    const mode = normalizeTeamMode(options.teamMode || (registration && registration.teamMode));
    if (!registration || !registration.path) {
      return failure('NO_TEAM_PROJECT', `旧协议里没有项目「${name}」；先创建/恢复项目并 ensure`, { project: name });
    }
    const projectPath = path.resolve(String(options.projectPath || registration.path));
    const structure = await ensureProjectStructure({ name, path: projectPath, projectPath, teamMode: mode });
    if (!structure.ok) {
      return failure(structure.code || 'PROJECT_STRUCTURE_INCOMPLETE', structure.message || '项目结构不完整', { structure });
    }
    ensureRosterRoles(name, mode);
    // 项目信息/铁律仍是模板时，boot 必须明确失败；先补模板再放行等于伪造“已读”。
    const placeholderDocs = bootPlaceholderDocs(projectPath, roleId);
    if (placeholderDocs.length) {
      const detail = placeholderDocs.map((row) => `${row.label}（${row.terms.join('、')}）`).join('、');
      return failure('PLACEHOLDER_DOC', `角色「${roleId}」boot 被拒绝：${detail} 仍是模板占位；先把项目目标/边界/铁律正文写清再 boot`, {
        role: roleId,
        project: name,
        projectPath,
        placeholders: placeholderDocs,
        bootRead: { role: roleId, project: name, complete: false, missing: [], placeholders: placeholderDocs }
      });
    }
    const docs = readBootDocs(projectPath, roleId);
    if (!docs.complete) {
      return failure('MISSING_DOC', `角色「${roleId}」boot 必读文件缺失：${docs.missing.join('、')}`, {
        role: roleId, project: name, projectPath, bootRead: { role: roleId, complete: false, missing: docs.missing, docs: docs.docs }
      });
    }
    const stateBefore = readWorkflowState(name);
    if (!stateBefore.ok) return stateBefore;
    const sessionId = String(options.sessionId || '').trim();
    const boot = await bootToken(name, roleId, { force: true, sessionId });
    if (!boot.ok) {
      if (boot.code === 'TOOL_MISSING' || boot.errorCode === 'TOOL_MISSING') {
        return failure('LEGACY_PROTOCOL_REQUIRED', `旧团队工具不存在，无法 boot 角色「${roleId}」：${layout.teamTool}`, {
          role: roleId, project: name, protocol: 'legacy', requiredCommand: 'boot', capabilities: legacyCapabilities()
        });
      }
      return boot;
    }
    // 本次 boot 的令牌就是角色下一步要用的令牌：同步内存缓存，避免“刚重读还判没读”。
    refreshBootCache(name, roleId, sessionId, boot);
    const tokenFile = path.join(layout.state, '启动', boot.token + '.json');
    const tokenData = readJsonSafe(tokenFile) || {};
    const legacyHashes = tokenData.docHashes && typeof tokenData.docHashes === 'object' ? tokenData.docHashes : {};
    const hashCheck = (key) => {
      const doc = docs.docs[key];
      if (!doc || !doc.exists) return false;
      // 旧 team.mjs 的 roleCard 指团队全局角色卡；项目里的是项目角色卡。
      // 不能拿两套不同文件的哈希互相比对，否则 boot 永远 complete=false。
      if (key === 'roleCard') return true;
      // 旧 token 只覆盖部分文档；项目信息/需求总览由本层读取，缺失 hash 时以实际读到的文件为准。
      if (!legacyHashes[key]) return true;
      return legacyHashes[key] === doc.hash;
    };
    const hashChecks = {
      constitution: hashCheck('constitution'),
      iron: hashCheck('iron'),
      projectInfo: hashCheck('projectInfo'),
      // 旧 team.mjs 现在读项目目录里的角色卡；这里的 roleCard 必须同一条路径、同一份哈希。
      roleCard: hashCheck('roleCard'),
      projectIndex: hashCheck('projectIndex'),
      requirementOverview: hashCheck('requirementOverview'),
      rulesHash: Boolean(tokenData.rulesHash && tokenData.rulesHash === boot.rulesHash)
    };
    const requiredHashChecks = ['constitution', 'iron', 'projectInfo', 'roleCard', 'projectIndex', 'requirementOverview', 'rulesHash'];
    const hashComplete = requiredHashChecks.every((key) => hashChecks[key] === true);
    const at = new Date().toISOString();
    const briefing = String(boot.briefing || '').slice(0, Math.max(400, Number(teamConfig().bootBriefMaxChars || 2000)));
    const autoBootReason = String(options.autoBootReason || '').trim();
    const bootRead = {
      role: roleId,
      project: name,
      at,
      round: Number(stateBefore.state.round || 1),
      complete: docs.complete && hashComplete,
      required: ['iron', 'projectInfo', 'roleCard', 'projectIndex', 'requirementOverview'],
      docs: docs.docs,
      missing: docs.missing,
      requirements: docs.requirements,
      requirementsHash: docs.requirements.hash,
      requirementsContentHash: docs.requirements.contentHash || docs.requirements.hash,
      hashChecks,
      legacyTokenFile: tokenFile,
      legacyTokenFound: Boolean(tokenData.token),
      tokenHash: crypto.createHash('sha256').update(String(boot.token)).digest('hex').slice(0, 16),
      briefingHash: crypto.createHash('sha256').update(briefing).digest('hex'),
      briefingExcerpt: briefing.slice(0, 600),
      sessionId: String(boot.sessionId || sessionId || ''),
      ...(autoBootReason ? { autoBootReason, autoBootedBy: 'workbench-shell' } : {})
    };
    const written = mutateWorkflowState(name, (state) => {
      state.boots = state.boots && typeof state.boots === 'object' ? state.boots : {};
      state.boots[roleId] = {
        ...bootRead,
        rulesHash: boot.rulesHash || '',
        tokenFile: tokenFile,
        token: undefined
      };
      pushWorkflowEvent(state, {
        action: 'boot', role: roleId, project: name,
        note: `bootRead=${bootRead.complete ? 'complete' : 'incomplete'} docs=${Object.keys(bootRead.docs).join(',')}${autoBootReason ? ` autoBoot=${autoBootReason}` : ''}`
      });
    });
    const snapshot = readWorkflowSnapshot(name, projectPath);
    return {
      ok: true,
      code: 'OK',
      role: roleId,
      project: name,
      projectPath,
      teamMode: mode,
      token: boot.token,
      sessionId: boot.sessionId || sessionId,
      rulesHash: boot.rulesHash || '',
      briefing,
      bootRead,
      workflowWrite: written.ok ? { ok: true, file: written.file } : { ok: false, code: written.code, message: written.message },
      workflow: snapshot.ok ? snapshot.workflow : null,
      snapshot: snapshot.ok ? snapshot : null,
      command: 'team.mjs boot',
      legacy: {
        protocol: 'team.mjs',
        command: 'boot',
        tokenFile,
        hashChecks,
        capabilities: legacyCapabilities()
      }
    };
  }

  /**
   * 工作流闸门：动作执行角色必须在本轮已 boot 且读全必读文件，且 boot 后文件没变。
   * 旧 CLI 命令（task/propose/...）自己会 boot；req review / owner / workflow
   * 必须走旧命令，缺命令时由 requireLegacyCommand 明确拒绝，不能写本地假状态。
   */
  /**
   * B-0b28：轮换后的新会话可能用 team.mjs boot（CLI）补读过文档，而 工作流.json.boots 仍停在旧会话，
   * 验收门不能因此判“没读到需求”。这里只在「读没读过这份需求正文」这一项上兜底，
   * 规则文档哈希/轮次/必读完整性仍按壳层记录的 boot 校验，不放宽。
   */
  function latestLegacyBootToken(projectName, roleId) {
    try {
      const dir = path.join(layout.state, '启动');
      if (!fs.existsSync(dir)) return null;
      const hits = [];
      for (const name of fs.readdirSync(dir)) {
        if (!name.endsWith('.json')) continue;
        const data = readJsonSafe(path.join(dir, name));
        if (!data || String(data.role || '') !== roleId) continue;
        if (String(data.project || '') !== projectName) continue;
        hits.push({ ...data, tokenFile: path.join(dir, name), at: String(data.createdAt || '') });
      }
      hits.sort((a, b) => String(b.at).localeCompare(String(a.at)));
      return hits[0] || null;
    } catch {
      return null;
    }
  }

  function requireWorkflowBoot(projectName, projectPath, role, options = {}) {
    const name = String(projectName || '').trim();
    const roleId = String(role || '').trim();
    if (!name) return failure('PROJECT_REQUIRED', '缺少团队项目名');
    if (!ROLE_IDS.includes(roleId)) return failure('BAD_ROLE', `角色无效；可用角色：${ROLE_IDS.join(', ')}`, { role: roleId });
    const caps = legacyCapabilities();
    if (!caps.available) {
      return failure('LEGACY_PROTOCOL_REQUIRED', `团队工具不可用，无法核验角色「${roleId}」的 boot 阅读证据：${layout.teamTool}`, {
        requiredCommand: 'boot', protocol: 'legacy', capabilities: caps
      });
    }
    // 旧记录存在也不能放行模板：项目信息/铁律没写清时，任何依赖 boot 的动作都停。
    const placeholderDocs = bootPlaceholderDocs(projectPath, roleId);
    if (placeholderDocs.length) {
      const detail = placeholderDocs.map((row) => `${row.label}（${row.terms.join('、')}）`).join('、');
      return failure('PLACEHOLDER_DOC', `角色「${ROLE_NAMES[roleId] || roleId}」的 boot 阅读证据不可用：${detail} 仍是模板占位；先把项目目标/边界/铁律正文写清`, {
        role: roleId, project: name, placeholders: placeholderDocs, protocol: 'legacy'
      });
    }
    const read = readWorkflowState(name);
    if (!read.ok) return read;
    const state = read.state;
    const boot = state.boots && typeof state.boots === 'object' ? state.boots[roleId] : null;
    if (!boot) {
      return failure('BOOT_REQUIRED', `角色「${ROLE_NAMES[roleId] || roleId}」本轮尚未 boot；先读项目铁律/项目信息/角色卡/项目索引/相关需求再执行`, {
        role: roleId, project: name, protocol: 'legacy', required: ['boot']
      });
    }
    if (boot.complete !== true) {
      return failure('BOOT_INCOMPLETE', `角色「${ROLE_NAMES[roleId] || roleId}」上次 boot 没有读全必读文件，禁止推进`, {
        role: roleId, project: name, bootRead: boot, protocol: 'legacy'
      });
    }
    if (Number(boot.round || 0) !== Number(state.round || 1)) {
      return failure('BOOT_REQUIRED', `角色「${ROLE_NAMES[roleId] || roleId}」的 boot 属于第 ${boot.round || '?'} 轮，当前第 ${state.round || 1} 轮；请重新 boot`, {
        role: roleId, project: name, bootRound: boot.round || null, round: state.round || 1, protocol: 'legacy'
      });
    }
    const ttlMinutes = Math.max(1, Number(teamConfig().bootTtlMinutes || DEFAULT_BOOT_TTL_MINUTES));
    const bootAt = Date.parse(String(boot.at || ''));
    if (!Number.isFinite(bootAt) || Date.now() - bootAt > ttlMinutes * 60000) {
      return failure('BOOT_EXPIRED', `角色「${ROLE_NAMES[roleId] || roleId}」的 boot 已超过 ${ttlMinutes} 分钟；请重新 boot`, {
        role: roleId, project: name, at: boot.at || null, ttlMinutes, protocol: 'legacy'
      });
    }
    const requirementId = String(options.requirementId || '').trim();
    const live = readBootDocs(projectPath, roleId);
    const stale = [];
    // 生成型索引（项目索引/需求总览）由工具在每次需求变化后重写，属于导航物，不是规则。
    // 拿它们的哈希作废 boot 会把“刚评审完就要派单”的整队卡死（ROUND11 的 RULES_CHANGED 根因）。
    // 规则文档（宪法/铁律/项目信息/角色卡）仍然逐字节比对，改了就必须重新 boot。
    const GENERATED_DOCS = new Set(['projectIndex', 'requirementOverview']);
    for (const spec of bootDocSpecs(projectPath, roleId)) {
      if (spec.required === false) continue;
      const before = boot.docs && boot.docs[spec.key] ? boot.docs[spec.key] : null;
      const now = live.docs[spec.key];
      if (!now || !now.exists) stale.push(spec.label + '（缺失）');
      else if (GENERATED_DOCS.has(spec.key)) continue;
      else if (!before || before.hash !== now.hash || before.exists !== now.exists) stale.push(spec.label);
    }
    // 没有具体需求时才要求“本轮相关需求”整体仍然一致（迭代/终止用）。
    // 比对内容哈希：需求正文里的「- 状态：」和「## 状态记录」是程序自己写的，
    // 只改这些不该让角色的阅读证据作废；新增需求或改正文内容仍然作废。
    if (!requirementId) {
      const beforePool = String(boot.requirementsContentHash || boot.requirementsHash || '');
      const nowPool = String(live.requirements.contentHash || live.requirements.hash || '');
      if (beforePool !== nowPool) stale.push('本轮相关需求');
    }
    if (stale.length) {
      return failure('RULES_CHANGED', `角色「${ROLE_NAMES[roleId] || roleId}」boot 后必读文件已变化（${stale.join('、')}），旧阅读证据作废；请重新 boot`, {
        role: roleId, project: name, stale, bootRead: boot, protocol: 'legacy'
      });
    }
    // B-0b28：记录“这份需求的阅读证据来自哪里”（壳层 boot 记录 / 最新 CLI boot 令牌），供调用方审计。
    let requirementReadSource = '';
    if (requirementId) {
      const doc = live.requirements.list.find((row) => requirementIdKey(row.id) === requirementIdKey(requirementId));      if (!doc) {
        return failure('MISSING_DOC', `需求 ${requirementId} 没有可读正文（需求/R-*.md），禁止评审/派单/开发/测试/验收`, {
          role: roleId, project: name, requirementId, requirementDocs: live.requirements.list, protocol: 'legacy'
        });
      }
      let readBefore = boot.requirements && Array.isArray(boot.requirements.list)
        ? boot.requirements.list.find((row) => requirementIdKey(row.id) === requirementIdKey(requirementId))
        : null;
      let readSource = readBefore ? 'workflow-boot' : '';
      requirementReadSource = readSource;
      if (!readBefore) {
        // B-0b28：壳层记录没这条需求 → 回退到该角色最新一次 CLI boot 令牌（轮换后新会话补读的证据）。
        const latest = latestLegacyBootToken(name, roleId);
        const tokenRow = latest && Array.isArray(latest.requirementDocs)
          ? latest.requirementDocs.find((row) => requirementIdKey(row.id) === requirementIdKey(requirementId))
          : null;
        if (tokenRow) {
          readBefore = {
            id: tokenRow.id,
            rel: tokenRow.rel || '',
            hash: tokenRow.hash || '',
            contentHash: tokenRow.contentHash || tokenRow.hash || '',
            source: 'legacy-boot-token',
            at: latest.at,
          };
          readSource = 'legacy-boot-token';
          requirementReadSource = readSource;
        }
      }
      // allowRequirementChanged：Owner 决定以“产品评审已通过”为证据；产品评审命令
      // 本身会写需求状态行，不能因此要求产品对同一份需求再 boot 一次。
      // 仍然要求产品确实读过这份需求（readBefore 存在），只是允许状态行/状态记录随流程更新。
      const sameHash = Boolean(readBefore) && String(readBefore.contentHash || readBefore.hash || '') === String(doc.contentHash || doc.hash || '');
      if (!readBefore || (!sameHash && options.allowRequirementChanged !== true)) {
        return failure('BOOT_REQUIRED', `角色「${ROLE_NAMES[roleId] || roleId}」boot 时没有读到需求 ${requirementId}，禁止推进；请重新 boot`, {
          role: roleId, project: name, requirementId, readSource, protocol: 'legacy'
        });
      }
    }
    return { ok: true, code: 'OK', role: roleId, project: name, round: state.round || 1, boot, live, requirementReadSource };
  }

  /**
   * 动作前的 boot 闸门：令牌过期（BOOT_EXPIRED）时壳自己重新 boot 一次再重试闸门，
   * 不要求用户先点“重新 boot”。只处理“过期”，不掩盖未 boot / 文档变更 / 跨轮：
   * 那些仍必须由角色本人读齐文档后重新 boot。
   * 返回的 gate 带 autoBoot 证据（是否真的重签、重签前后的 at），调用方可原样透传。
   */
  async function ensureWorkflowBoot(projectName, projectPath, role, options = {}) {
    const gate = requireWorkflowBoot(projectName, projectPath, role, options);
    if (gate.ok || gate.code !== 'BOOT_EXPIRED' || options.autoBoot === false) return gate;
    const failedRole = String(role || '').trim();
    if (!failedRole || failedRole === 'owner' || !ROLE_IDS.includes(failedRole)) return gate;
    const sessions = readProjectSessions(projectName);
    const sessionId = String(options.sessionId || sessions[failedRole] || '');
    const registration = registrationFor(projectName);
    const teamMode = normalizeTeamMode(options.teamMode || (registration && registration.teamMode));
    const boot = await bootRole(projectName, failedRole, {
      projectPath,
      sessionId,
      teamMode,
      autoBootReason: 'BOOT_EXPIRED'
    });
    if (!boot.ok) {
      return {
        ...gate,
        autoBoot: {
          ok: false,
          role: failedRole,
          code: boot.code || 'BOOT_FAILED',
          message: boot.message || '自动重新 boot 失败'
        }
      };
    }
    const retried = requireWorkflowBoot(projectName, projectPath, failedRole, { ...options, autoBoot: false });
    return {
      ...retried,
      autoBoot: {
        ok: retried.ok,
        role: failedRole,
        code: retried.ok ? 'BOOT_AUTO_REFRESHED' : (retried.code || 'BOOT_RETRY_FAILED'),
        previousAt: gate.at || null,
        at: new Date().toISOString()
      }
    };
  }

  /** 只读检查：上次 boot 的记录是否还在、文件是否变了（不重新 boot、不写状态）。 */
  function briefingStatus(projectName) {
    const name = String(projectName || '').trim();
    if (!name) return failure('PROJECT_REQUIRED', '缺少团队项目名');
    const read = readWorkflowState(name);
    if (!read.ok) return read;
    const registration = registrationFor(name);
    const projectPath = registration && registration.path ? path.resolve(registration.path) : '';
    const currentRound = Number(read.state.round || 1);
    const roles = {};
    for (const role of ROLE_IDS) {
      const recorded = read.state.boots && read.state.boots[role] ? read.state.boots[role] : null;
      const live = projectPath
        ? readBootDocs(projectPath, role)
        : { docs: {}, requirements: { list: [], hash: '', count: 0 }, missing: ROLE_IDS.slice(), complete: false };
      const staleDocs = [];
      if (recorded && recorded.docs) {
        for (const [key, row] of Object.entries(live.docs)) {
          const previous = recorded.docs[key];
          if (!previous || previous.hash !== row.hash || previous.exists !== row.exists) staleDocs.push(key);
        }
      }
      const requirementsStale = Boolean(recorded) && String(recorded.requirementsHash || '') !== live.requirements.hash;
      if (requirementsStale) staleDocs.push('requirements');
      // 跨轮 boot 必须在只读简报里就失效，不能只靠动作前的 requireWorkflowBoot 才发现。
      const roundMismatch = Boolean(recorded) && Number(recorded.round || 0) !== currentRound;
      roles[role] = {
        role,
        name: ROLE_NAMES[role] || role,
        booted: Boolean(recorded),
        complete: Boolean(recorded && recorded.complete && live.complete && !requirementsStale && !roundMismatch),
        roundMismatch,
        currentRound,
        invalidatedAt: recorded && recorded.invalidatedAt ? recorded.invalidatedAt : null,
        missing: live.missing,
        stale: Boolean(recorded) && staleDocs.length > 0,
        staleDocs,
        requirements: live.requirements.list,
        requirementsHash: live.requirements.hash,
        at: recorded ? recorded.at : null,
        round: recorded ? recorded.round || null : null,
        briefingHash: recorded ? recorded.briefingHash : null,
        briefingExcerpt: recorded ? recorded.briefingExcerpt : '',
        docs: live.docs
      };
    }
    // B-20261114-003257-0a46（R-d734 F-4）：面板要显示“角色真的 boot 过”。
    // 工作台自己的 boots 只记壳层发起的 boot；角色用 team.mjs boot 的证据在
    // 团队/状态/启动/<token>.json（+ 阅读.jsonl kind=boot），单独算一份，不改闸门语义。
    const evidence = bootEvidence(name, projectPath);
    for (const role of ROLE_IDS) {
      if (roles[role]) roles[role].evidence = evidence.roles[role] || null;
    }
    return {
      ok: true,
      code: 'OK',
      project: name,
      projectPath,
      file: read.file,
      round: currentRound,
      allBooted: Object.values(roles).every((row) => row.booted),
      allComplete: Object.values(roles).every((row) => row.complete),
      roles,
      evidence
    };
  }

  /* ── B-20261114-003257-0a46（R-d734）：文档真实存在性 + 角色 BOOT 真实证据 ──── */

  const PROJECT_DOC_CHECKS = [
    { key: 'projectInfo', label: '项目信息', file: '项目信息.md' },
    { key: 'iron', label: '项目铁律', file: '项目铁律.md' }
  ];

  /**
   * 单文件探测：只 stat + access，不整篇读（面板每次打开都重算，不缓存结论）。
   * 读失败（EACCES/EPERM/占用）与“不存在”分开：读不到 ≠ 缺失（R-d734 F-5）。
   */
  function probeProjectDoc(file) {
    const out = { path: file, state: 'missing', exists: false, readable: false, size: 0, mtime: null, error: '', excerpt: '' };
    let stat;
    try {
      stat = fs.statSync(file);
    } catch (error) {
      const code = String((error && error.code) || '');
      if (code && code !== 'ENOENT' && code !== 'ENOTDIR') {
        out.state = 'unreadable';
        out.error = code;
      }
      return out;
    }
    if (!stat.isFile()) {
      out.state = 'unreadable';
      out.error = 'NOT_A_FILE';
      return out;
    }
    out.exists = true;
    out.size = stat.size;
    out.mtime = stat.mtime.toISOString();
    try {
      fs.accessSync(file, fs.constants.R_OK);
      out.readable = true;
      out.state = 'present';
      try {
        const buffer = fs.readFileSync(file);
        // 只留开头 400 字给“模板占位”判据；不是正文服务，也不落缓存。
        out.excerpt = buffer.toString('utf8', 0, Math.min(400, buffer.length)).replace(/\s+/g, ' ').trim();
      } catch { out.excerpt = ''; }
    } catch (error) {
      out.state = 'unreadable';
      out.error = String((error && error.code) || 'EACCES');
    }
    return out;
  }

  /**
   * 项目信息/项目铁律 + 六角色（目录/角色卡/文件索引）到底在不在：
   * 只查两处——项目目录 → 团队共享；**不读 files:list**（600 项 / 4 层上限会把根目录文档和
   * 排在后面的角色目录截掉，旧版因此误报“角色卡/文件索引永远缺失”，B-20261114-052109-2ebe）。
   * 返回 checks[]（每项带 rel，前端按 rel 直接对表）与 dirs[]（六角色目录三项）。
   */
  function projectDocPresence(projectPath) {
    const root = path.resolve(String(projectPath || ''));
    const at = new Date().toISOString();
    if (!root || !isDirectory(root)) {
      return failure('PROJECT_DIR_MISSING', `项目目录不存在：${root || '未提供'}`, { projectPath: root, at });
    }
    const docCheck = (docFile, key, label, kind, rel) => {
      const candidates = [
        { source: 'project', sourceLabel: '项目目录', ...probeProjectDoc(path.join(root, docFile)) },
        { source: 'team', sourceLabel: '团队共享', ...probeProjectDoc(path.join(layout.root, docFile)) }
      ];
      if (kind === 'dir') {
        // 目录不用 probeProjectDoc（它判 isFile 会把目录当 unreadable），单独 stat。
        for (const row of candidates) {
          try {
            const stat = fs.statSync(row.path);
            if (stat.isDirectory()) { row.state = 'present'; row.exists = true; row.readable = true; row.size = 0; row.mtime = stat.mtime.toISOString(); }
            else { row.state = 'unreadable'; row.error = 'NOT_A_DIRECTORY'; }
          } catch (error) {
            const code = String((error && error.code) || '');
            row.state = code && code !== 'ENOENT' && code !== 'ENOTDIR' ? 'unreadable' : 'missing';
            if (row.state === 'unreadable') row.error = code;
          }
        }
      }
      const present = candidates.find((row) => row.state === 'present') || null;
      const unreadable = candidates.find((row) => row.state === 'unreadable') || null;
      const hit = present || unreadable || null;
      return {
        key,
        label,
        kind,
        rel,
        file: hit ? hit.path : candidates[0].path,
        state: hit ? hit.state : 'missing',
        exists: Boolean(present),
        readable: Boolean(present),
        source: hit ? hit.source : '',
        sourceLabel: hit ? hit.sourceLabel : '',
        checkPath: hit ? hit.path : candidates[0].path,
        size: present ? present.size : 0,
        mtime: present ? present.mtime : null,
        error: hit && hit.state === 'unreadable' ? hit.error : '',
        excerpt: present ? present.excerpt || '' : '',
        candidates,
        at
      };
    };
    const checks = PROJECT_DOC_CHECKS.map((doc) => docCheck(doc.file, doc.key, doc.label, 'file', doc.file));
    // 六角色 18 项：目录 / 角色卡 / 文件索引（路径与团队工具 ROLE_DIRS 同口径，前端不再自己拼）
    const dirs = [];
    for (const roleId of ROLE_IDS) {
      const dirName = ROLE_DIRS[roleId] || roleId;
      const dirRel = `${dirName}`;
      const cardRel = `${dirName}/角色卡.md`;
      const indexRel = `${dirName}/文件索引.md`;
      const dirCheck = docCheck(dirName, `role:${roleId}:dir`, `${dirName} 目录`, 'dir', dirRel);
      const cardCheck = docCheck(cardRel, `role:${roleId}:card`, `${dirName} 角色卡`, 'file', cardRel);
      const indexCheck = docCheck(indexRel, `role:${roleId}:index`, `${dirName} 文件索引`, 'file', indexRel);
      checks.push(dirCheck, cardCheck, indexCheck);
      dirs.push({
        role: roleId,
        dir: dirName,
        rel: dirRel,
        state: dirCheck.state,
        exists: dirCheck.exists,
        cardRel,
        cardState: cardCheck.state,
        indexRel,
        indexState: indexCheck.state,
      });
    }
    return {
      ok: true,
      code: 'OK',
      projectPath: root,
      at,
      checks,
      dirs,
      missing: checks.filter((row) => row.state === 'missing').map((row) => ({ key: row.key, label: row.label, path: row.checkPath, source: row.source, rel: row.rel })),
      unreadable: checks.filter((row) => row.state === 'unreadable').map((row) => ({ key: row.key, label: row.label, path: row.checkPath, error: row.error, rel: row.rel })),
      allPresent: checks.every((row) => row.state === 'present')
    };
  }

  /** 角色当前绑定的会话：轮换记录优先（703f），其次 团队.json members[]；禁止按活跃度推断。 */
  function currentRoleSessions(projectName) {
    const out = {};
    for (const role of ROLE_IDS) out[role] = { role, sessionId: '', source: '未绑定', rotationId: '' };
    for (const member of teamMembers()) {
      if (!member || !ROLE_IDS.includes(member.role) || member.status === 'removed') continue;
      out[member.role] = { role: member.role, sessionId: String(member.sessionId || ''), source: '团队.json', rotationId: '' };
    }
    const dir = path.join(layout.projectsDir, teamSlug(String(projectName || '')), '会话轮换');
    let names = [];
    try { names = fs.readdirSync(dir); } catch { names = []; }
    for (const name of names) {
      // 角色文件（<role>.json）是每次轮换后的当前记录；S-* 是历史事件，不参与。
      if (!/\.json$/i.test(name) || /^S-/i.test(name)) continue;
      const row = readJsonSafe(path.join(dir, name));
      if (!row || !ROLE_IDS.includes(String(row.role || ''))) continue;
      if (row.project && String(row.project) !== String(projectName || '')) continue;
      if (String(row.status || '') === 'retired') continue;
      const to = String(row.to || '');
      if (!to) continue;
      out[row.role] = { role: row.role, sessionId: to, source: '会话轮换', rotationId: String(row.id || '') };
    }
    return out;
  }

  // 阅读.jsonl 只读尾部；面板 5 秒轮询时不重复解析整份文件。
  let receiptBootCache = { at: 0, rows: [] };
  function readReceiptBootRows() {
    if (Date.now() - receiptBootCache.at < 10000) return receiptBootCache.rows;
    const rows = [];
    try {
      const lines = fs.readFileSync(path.join(layout.state, '阅读.jsonl'), 'utf8').split(/\r?\n/);
      for (const line of lines.slice(-800)) {
        if (!line.trim()) continue;
        let row = null;
        try { row = JSON.parse(line); } catch { continue; }
        if (!row || row.kind !== 'boot' || !ROLE_IDS.includes(String(row.role || ''))) continue;
        const atMs = Date.parse(String(row.ts || ''));
        if (!Number.isFinite(atMs)) continue;
        rows.push({ role: String(row.role), sessionId: String(row.sessionId || ''), atMs, ts: String(row.ts), project: String(row.project || '') });
      }
    } catch { /* 没有阅读记录就是没有 */ }
    receiptBootCache = { at: Date.now(), rows };
    return rows;
  }

  /**
   * 角色 BOOT 的三态（未 BOOT / 已 BOOT / BOOT 过期），以真实启动令牌为准。
   * 当前会话口径（703f 落地前）：轮换记录 status=active 的 to 优先，否则 团队.json.members[].sessionId；
   * 旧会话的 boot 不算“已 BOOT”。
   */
  function bootEvidence(projectName, projectPath) {
    const name = String(projectName || '').trim();
    const at = new Date().toISOString();
    const ttlMinutes = Math.max(1, Number(teamConfig().bootTtlMinutes || DEFAULT_BOOT_TTL_MINUTES));
    const sessions = currentRoleSessions(name);
    const dir = path.join(layout.state, '启动');
    let names = [];
    try { names = fs.readdirSync(dir); } catch { names = []; }
    const tokens = {};
    for (const fileName of names) {
      if (!/\.json$/i.test(fileName)) continue;
      const tokenFile = path.join(dir, fileName);
      const row = readJsonSafe(tokenFile);
      if (!row || !ROLE_IDS.includes(String(row.role || ''))) continue;
      if (row.project && name && String(row.project) !== name) continue;
      const atMs = Date.parse(String(row.createdAt || ''));
      if (!Number.isFinite(atMs)) continue;
      const prev = tokens[row.role];
      if (!prev || atMs > prev.atMs) {
        tokens[row.role] = {
          atMs, at: String(row.createdAt), sessionId: String(row.sessionId || ''),
          token: String(row.token || ''), expiresAt: String(row.expiresAt || ''), file: tokenFile
        };
      }
    }
    const receipts = readReceiptBootRows();
    const roles = {};
    for (const role of ROLE_IDS) {
      const current = sessions[role] || { sessionId: '', source: '未绑定' };
      let record = tokens[role] || null;
      let evidenceSource = record ? '启动令牌' : '';
      if (!record) {
        const latest = receipts
          .filter((row) => row.role === role && (!name || !row.project || row.project === name))
          .sort((a, b) => b.atMs - a.atMs)[0] || null;
        if (latest) {
          record = { atMs: latest.atMs, at: latest.ts, sessionId: latest.sessionId, token: '', expiresAt: '', file: path.join(layout.state, '阅读.jsonl') };
          evidenceSource = '阅读.jsonl';
        }
      }
      const expiresMs = record && record.expiresAt ? Date.parse(record.expiresAt) : NaN;
      const expireAtMs = Number.isFinite(expiresMs) ? expiresMs : (record ? record.atMs + ttlMinutes * 60000 : NaN);
      const expired = Boolean(record) && Number.isFinite(expireAtMs) && Date.now() > expireAtMs;
      const matchesCurrent = Boolean(record && current.sessionId && record.sessionId === current.sessionId);
      let state = 'never';
      if (record) {
        if (!current.sessionId) state = 'unbound';
        else if (record.sessionId !== current.sessionId) state = 'stale-session';
        else if (expired) state = 'expired';
        else state = 'booted';
      }
      roles[role] = {
        role,
        state,
        label: state === 'booted' ? '已 BOOT'
          : state === 'expired' ? `BOOT 过期（超过 ${ttlMinutes} 分钟）`
            : state === 'stale-session' ? '未 BOOT（本会话未 boot）'
              : state === 'unbound' ? '未 BOOT（当前会话未绑定）' : '未 BOOT',
        at: record ? record.at : null,
        atMs: record ? record.atMs : null,
        expiresAt: record && Number.isFinite(expireAtMs) ? new Date(expireAtMs).toISOString() : null,
        ttlMinutes,
        sessionId: record ? record.sessionId : '',
        currentSessionId: current.sessionId || '',
        currentSessionSource: current.source || '',
        matchesCurrent,
        expired,
        evidenceSource,
        token: record ? record.token : '',
        file: record ? record.file : '',
        checkedAt: at
      };
    }
    return {
      ok: true, code: 'OK', project: name, at, ttlMinutes, roles,
      note: '口径：只认角色当前绑定会话的最新 boot，旧会话 boot 不算；703f 落地前当前会话取轮换记录 to（无记录回退 团队.json members[].sessionId）。'
    };
  }

  // ---------- 精准投喂：角色结构化简报 ----------

  /**
   * buildRoleBrief(project, role, task)
   *
   * 只读对应角色的结构化区块，拼成 ≤800 字简报。不贴全文、不贴历史：
   *   - 需求清单：需求/ 目录 R-*.md 的 id/状态/优先级/标题；
   *   - 设计：产品设计师读 产品/ 目录文档标题（其余角色跳过）；
   *   - 任务：开发/测试读自己名下的开发/测试任务与验收标准，PM 读开放任务；
   *   - 最近评审意见：工作流.json 里的产品评审/Owner 决定/互审/验收意见（只取最近一条）。
   * 只读文件，不写任何状态；输出按 ROLE_BRIEF_LIMITS 限长。
   */
  function buildRoleBrief(project, role, task = '') {
    const name = typeof project === 'string'
      ? String(project).trim()
      : String((project && (project.teamName || project.name)) || '').trim();
    const roleId = String(role || '').trim();
    const taskId = String(task || '').trim();
    const limit = Number(ROLE_BRIEF_LIMITS[roleId] || 800);
    if (!name) return failure('PROJECT_REQUIRED', '缺少团队项目名');
    if (!ROLE_IDS.includes(roleId)) return failure('BAD_ROLE', `角色无效；可用角色：${ROLE_IDS.join(', ')}`, { role: roleId });
    const registration = registrationFor(name);
    const projectPath = path.resolve(String(
      (registration && registration.path) || (project && project.path) || ''
    ));
    if (!projectPath || !isDirectory(projectPath)) {
      return failure('NO_TEAM_PROJECT', `旧协议里没有项目「${name}」；先创建/恢复项目并 ensure`, { project: name });
    }
    const blocks = [];
    const blockInfo = {};
    const sources = [];
    // 1) 需求清单：所有角色都读，只列当前轮与下一轮排队需求。
    const stateRead = readWorkflowState(name);
    const state = stateRead.ok ? stateRead.state : null;
    const round = state ? Number(state.round || 1) : 1;
    const docs = readRequirementDocs(projectPath);
    if (docs.count) {
      const rows = state && state.requirements ? Object.values(state.requirements) : [];
      const byId = new Map(rows.map((row) => [String(row.id), row]));
      const current = docs.list
        .map((doc) => {
          const meta = byId.get(String(doc.id));
          return {
            id: doc.id,
            title: doc.title || doc.id,
            priority: (meta && meta.priority) || doc.priority || '',
            status: (meta && meta.status) || doc.status || '',
            round: meta ? Number(meta.round || 1) : 1,
            queued: Boolean(meta && meta.queued)
          };
        })
        .filter((row) => row.queued || Number(row.round) <= round)
        .slice(0, 10);
      if (current.length) {
        blocks.push('【需求清单】' + current.map((row) => (
          `${row.id}${row.priority ? '/' + row.priority : ''}[${row.status}]${row.queued ? '（下一轮）' : ''} ${row.title}`
        )).join('；'));
        sources.push('需求/00-需求总览.md + 需求/R-*.md');
      }
    }
    // 2) 最近评审意见：只取最近一条产品评审 / Owner 决定 / 互审 / 验收意见。
    if (state) {
      const rows = Object.values(state.requirements || {});
      const targetRow = taskId
        ? rows.find((row) => String(row.dev && row.dev.taskId) === taskId
          || String(row.test && row.test.taskId) === taskId
          || String(row.id) === taskId)
        : null;
      const scope = targetRow ? [targetRow] : rows;
      const commentRows = scope
        .filter((row) => row && typeof row === 'object')
        .sort((a, b) => String(b.updatedAt || '').localeCompare(String(a.updatedAt || '')));
      const comments = [];
      for (const row of commentRows) {
        if (row.productReview && row.productReview.verdict) {
          comments.push(`产品评审(${row.id}):${row.productReview.verdict}${row.productReview.comment ? ':' + String(row.productReview.comment).slice(0, 80) : ''}`);
        }
        if (row.ownerReview && typeof row.ownerReview === 'object' && row.ownerReview.status
          && !['pending', 'optional'].includes(String(row.ownerReview.status))) {
          comments.push(`Owner(${row.id}):${row.ownerReview.status}${row.ownerReview.opinion ? ':' + String(row.ownerReview.opinion).slice(0, 80) : ''}`);
        }
        if (row.dev && row.dev.peerReview && row.dev.peerReview.status && row.dev.peerReview.status !== 'pending') {
          comments.push(`互审(${row.id}):${row.dev.peerReview.status}${row.dev.peerReview.comment ? ':' + String(row.dev.peerReview.comment).slice(0, 80) : ''}`);
        }
        if (row.acceptance && typeof row.acceptance === 'object' && row.acceptance.status) {
          comments.push(`验收(${row.id}):${row.acceptance.status}${row.acceptance.opinion ? ':' + String(row.acceptance.opinion).slice(0, 80) : ''}`);
        }
        if (comments.length >= 3) break;
      }
      if (comments.length) {
        blocks.push('【最近评审意见】' + comments.slice(0, 3).join('；'));
        sources.push('工作流.json（productReview/ownerReview/peerReview/acceptance）');
      }
    }
    // 3) 任务：开发读自己的开发任务，测试读测试任务，PM 读开放任务。
    const roleLabel = ROLE_NAMES[roleId] || roleId;
    if (['programmer1', 'programmer2'].includes(roleId) && state) {
      const rows = Object.values(state.requirements || {});
      const mine = rows.filter((row) => row.dev && row.dev.taskId);
      if (taskId) {
        const hit = mine.find((row) => String(row.dev.taskId) === taskId);
        if (hit) {
          blocks.push(`【开发任务】${hit.dev.taskId}（${hit.id} ${String(hit.title || '').slice(0, 40)}）验收：${String(hit.acceptanceCriteria || '').slice(0, 160)}`);
          sources.push('工作流.json dev + 任务/' + hit.dev.taskId + '.json');
        }
      } else if (mine.length) {
        blocks.push('【开发任务】' + mine.slice(0, 4).map((row) => `${row.dev.taskId}(${row.id})[${row.status}]`).join('；'));
        sources.push('工作流.json dev');
      }
    } else if (roleId === 'tester' && state) {
      const rows = Object.values(state.requirements || {});
      const testRows = rows.filter((row) => row.test && row.test.taskId);
      if (taskId) {
        const hit = testRows.find((row) => String(row.test.taskId) === taskId);
        if (hit) {
          blocks.push(`【测试任务】${hit.test.taskId}（${hit.id} ${String(hit.title || '').slice(0, 40)}）验收：${String(hit.acceptanceCriteria || '').slice(0, 160)}`);
          sources.push('工作流.json test + 任务/' + hit.test.taskId + '.json');
        }
      } else if (testRows.length) {
        blocks.push('【测试任务】' + testRows.slice(0, 4).map((row) => `${row.test.taskId}(${row.id})[${row.status}]`).join('；'));
        sources.push('工作流.json test');
      }
    } else if (roleId === 'pm') {
      const open = readLegacyTasks(name).filter((row) => row && row.status !== 'done').slice(0, 6);
      if (open.length) {
        blocks.push('【任务】' + open.map((row) => `${row.id}[${row.status}]${row.owner ? '→' + row.owner : ''}`).join('；'));
        sources.push('任务/*.json');
      }
    }
    // 4) 设计：产品设计师读 产品/ 目录文档标题；其它角色不贴设计区。
    if (roleId === 'product') {
      const designDir = path.join(projectPath, ROLE_DIRS.product);
      let names = [];
      try { names = fs.readdirSync(designDir).filter((file) => /\.md$/i.test(file)).slice(0, 5); } catch { names = []; }
      const design = [];
      for (const file of names) {
        let heading = '';
        try {
          heading = String(fs.readFileSync(path.join(designDir, file), 'utf8').match(/^\s*#\s+(.+?)\s*$/m)?.[1] || file).slice(0, 40);
        } catch { heading = file; }
        design.push(heading);
      }
      if (design.length) {
        blocks.push('【设计】' + design.join('、'));
        sources.push(`${ROLE_DIRS.product}/（文档标题）`);
      }
    }
    const text = blocks.join('\n');
    const capped = text.length > BRIEF_MAX_CHARS ? text.slice(0, BRIEF_MAX_CHARS) : text;
    for (const [index, value] of blocks.entries()) blockInfo['block' + (index + 1)] = value.slice(0, 200);
    return {
      ok: true,
      code: 'OK',
      role: roleId,
      roleName: roleLabel,
      project: name,
      projectPath,
      task: taskId || null,
      chars: capped.length,
      limit,
      briefLimit: BRIEF_MAX_CHARS,
      truncated: text.length > BRIEF_MAX_CHARS,
      text: capped,
      blocks: blockInfo,
      sources: [...new Set(sources)]
    };
  }

  // ---------- 旧任务/需求文件（唯一真相） ----------

  function legacyTaskFilePath(projectName, taskId) {
    return path.join(projectStatePaths(projectName).tasks, String(taskId) + '.json');
  }

  function readLegacyTasks(projectName) {
    const dir = projectStatePaths(projectName).tasks;
    const out = [];
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return out; }
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      const task = readJsonSafe(path.join(dir, name));
      if (task && task.id) out.push(task);
    }
    return out.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
  }

  function patchLegacyTask(projectName, taskId, patch = {}) {
    const file = legacyTaskFilePath(projectName, taskId);
    if (!fs.existsSync(file)) return failure('TASK_NOT_FOUND', `旧任务文件不存在：${file}`, { taskId });
    const task = readJsonSafe(file) || {};
    const { workflow, ...rest } = patch || {};
    const next = {
      ...task,
      ...rest,
      workflow: { ...(task.workflow && typeof task.workflow === 'object' ? task.workflow : {}), ...(workflow || {}) },
      updatedAt: new Date().toISOString(),
      rev: Number(task.rev || 0) + 1
    };
    try {
      writeJsonAtomic(file, next);
      return { ok: true, code: 'OK', file, task: next };
    } catch (error) {
      return failure('TASK_WRITE_FAILED', `写旧任务文件失败：${String(error && error.message || error).slice(0, 200)}`, { file });
    }
  }

  /** 工作流里按 4/6 位兼容号找需求行；再也不会因为编号宽度不同而看成两条。 */
  /**
   * 需求 id 的匹配计划（B-b55c）。
   * 旧实现只用 requirementIdKey 归一化（R-20261113-035931-54da → R-20261113-35931），
   * 同一天同一秒创建的多条需求会撞成同一个 key；真实项目里 R-20261113-035931 下就有 5 条
   * （52f3/98ee/1cee/54da/8b9d）。只看归一化 key 会把 54da 认成同秒第一条 52f3，
   * 于是"列表 test_done、点确认却报 accepted"。
   * 这里把"精确 id"与"兼容短号"分开：精确形态优先，模糊形态必须唯一，多条就判歧义。
   */
  function requirementIdMatchPlan(value) {
    const text = String(value == null ? '' : value).trim();
    const upper = text.toUpperCase();
    const plan = { text, exact: upper, isFullId: false, isSuffixOnly: false, isSecondsOnly: false, secondsKey: requirementIdKey(text), suffix: '' };
    const full = upper.match(/^R-(\d{8})-(\d{4,8})-([0-9A-Z]{2,8})$/);
    if (full) {
      plan.isFullId = true;
      plan.suffix = full[3];
      plan.secondsKey = `R-${full[1]}-${Number(full[2])}`;
      return plan;
    }
    // R-20261113-035931：只写秒号（旧入口/人话常用）→ 归一化后可能命中同秒多条。
    const secondsOnly = upper.match(/^R-(\d{8})-(\d{4,8})$/);
    if (secondsOnly) {
      plan.isSecondsOnly = true;
      plan.secondsKey = `R-${secondsOnly[1]}-${Number(secondsOnly[2])}`;
      return plan;
    }
    // R-54da / 54da：只写后缀（消息里人话常用「需求 R-54da」）。
    const suffixOnly = upper.match(/^(?:R-)?([0-9A-Z]{4})$/);
    if (suffixOnly && !/^\d{4}$/.test(suffixOnly[1])) {
      plan.isSuffixOnly = true;
      plan.suffix = suffixOnly[1];
      plan.secondsKey = '';
    }
    return plan;
  }

  function requirementRowId(key, row) {
    return String((row && row.id) || key || '').trim();
  }

  /**
   * 带歧义信息的需求行查找（B-b55c）。返回：
   *   { key, row, matched: 'exact'|'secondsKey'|'suffix', candidates: [] }  命中唯一
   *   { ambiguous: true, row: null, candidates: [{id,status}, ...] }        短号命中多条，不猜
   *   null                                                                  没有命中
   * 顺序：① 精确（key 或 row.id 全等）→ ② 唯一兼容匹配（同秒 key / 后缀）→ ③ 多条判歧义。
   */
  function findStateRequirementRowDetailed(state, requirementId) {
    const plan = requirementIdMatchPlan(requirementId);
    if (!plan.exact || !state || !state.requirements || typeof state.requirements !== 'object') return null;
    const keys = Object.keys(state.requirements);
    // ① 精确命中：只要能精确命中，就绝不退回模糊匹配（同秒需求会撞 key）。
    for (const key of keys) {
      const row = state.requirements[key];
      if (String(key).trim().toUpperCase() === plan.exact || requirementRowId(key, row).toUpperCase() === plan.exact) {
        return { key, row, matched: 'exact', candidates: [] };
      }
    }
    if (!plan.isFullId && !plan.isSuffixOnly && !plan.isSecondsOnly) return null;
    // ② 兼容匹配：同秒 key（旧入口只传 R-YYYYMMDD-HHMMSS）或 4 位后缀（R-54da）。
    const hits = [];
    for (const key of keys) {
      const row = state.requirements[key];
      const id = requirementRowId(key, row);
      const upperId = id.toUpperCase();
      const secondsHit = Boolean(plan.secondsKey)
        && (requirementIdKey(key) === plan.secondsKey || requirementIdKey(id) === plan.secondsKey);
      const suffixHit = Boolean(plan.suffix) && upperId.endsWith('-' + plan.suffix);
      if (secondsHit || suffixHit) hits.push({ key, row, matched: secondsHit ? 'secondsKey' : 'suffix', candidates: [] });
    }
    if (!hits.length) return null;
    if (hits.length === 1) return hits[0];
    return {
      ambiguous: true,
      row: null,
      key: '',
      matched: '',
      wanted: plan.text,
      candidates: hits.map((hit) => ({
        id: requirementRowId(hit.key, hit.row),
        status: String((hit.row && hit.row.status) || ''),
        key: hit.key
      }))
    };
  }

  function findStateRequirementRow(state, requirementId) {
    const found = findStateRequirementRowDetailed(state, requirementId);
    // 歧义不能当成"命中某一条"：旧调用点一律按 not found 处理（安全失败，不改错需求）。
    if (!found || found.ambiguous) return null;
    return found;
  }

  /** 旧 任务/ 目录里按 4/6 位兼容号找任务文件。 */
  function findLegacyRequirementTask(projectName, requirementId) {
    const wanted = requirementIdKey(requirementId);
    if (!wanted) return null;
    for (const task of readLegacyTasks(projectName)) {
      if (task && requirementIdKey(task.id) === wanted) return task;
    }
    return null;
  }

  /**
   * 只有一个 需求/R-*.md 正文、没有 任务/R-*.json / 工作流.json 行的旧项目，
   * 旧命令会 TASK_NOT_FOUND / REQUIREMENT_NOT_FOUND。这里按正文补一份旧协议
   * 兼容的需求任务和工作流镜像行；只补缺，不覆盖已有任务/工作流真相。
   */
  function ensureLegacyRequirementRecord(projectName, projectPath, requirementId) {
    const name = String(projectName || '').trim();
    const wanted = String(requirementId || '').trim();
    if (!name) return failure('PROJECT_REQUIRED', '缺少团队项目名');
    if (!wanted) return failure('REQUIREMENT_REQUIRED', '缺少需求 id');
    const root = path.resolve(String(projectPath || '').trim()
      || ((registrationFor(name) || {}).path || ''));
    if (!root) return failure('PROJECT_PATH_REQUIRED', '缺少项目目录，无法导入旧需求');
    const read = readWorkflowState(name);
    if (!read.ok) return read;
    // B-b55c：短号（只写秒号/只写后缀）命中多条时不许"补建/落到第一条"——那会把动作记到另一条
    // 同秒需求上。歧义就在入口拒收，并列出候选让人用完整 id 再来。
    const detailed = findStateRequirementRowDetailed(read.state, wanted);
    if (detailed && detailed.ambiguous) {
      return failure(
        'REQUIREMENT_AMBIGUOUS',
        `需求号 ${wanted} 同时命中 ${detailed.candidates.length} 条（${detailed.candidates.map((row) => `${row.id}=${row.status}`).join(' / ')}），请用完整需求 id 再操作`,
        { requirementId: wanted, candidates: detailed.candidates }
      );
    }
    const found = detailed;
    const docs = readRequirementDocs(root).list;
    const doc = docs.find((row) => requirementIdKey(row.id) === requirementIdKey(wanted)) || null;
    const existingTask = findLegacyRequirementTask(name, wanted);
    if (!found && !doc && !existingTask) {
      return failure('REQUIREMENT_NOT_FOUND', `工作流和 需求/ 正文里都没有需求 ${wanted}`, { requirementId: wanted });
    }
    const at = new Date().toISOString();
    const docText = doc ? (() => { try { return fs.readFileSync(doc.file, 'utf8'); } catch { return ''; } })() : '';
    const acceptanceCriteria = doc
      ? (requirementSection(docText, ['验收标准']) || String((found && found.row && found.row.acceptanceCriteria) || ''))
      : String((existingTask && existingTask.acceptance) || (found && found.row && found.row.acceptanceCriteria) || '');
    const story = doc
      ? requirementSection(docText, ['场景 / 用户', '用户故事', '场景'])
      : String((existingTask && existingTask.story) || (found && found.row && found.row.story) || '');
    const detail = String((found && found.row && found.row.detail) || (existingTask && existingTask.detail) || '');
    const docStatus = normalizeRequirementDocStatus(doc && doc.status)
      || String((existingTask && existingTask.workflow && existingTask.workflow.requirementStatus) || '')
      || String((found && found.row && found.row.status) || '')
      || 'review';

    let task = existingTask;
    let createdTask = false;
    if (!task) {
      const id = String((doc && doc.id) || (found && found.row && found.row.id) || wanted);
      const createdAt = (doc && doc.mtime) || at;
      task = {
        id,
        project: name,
        type: 'requirement',
        requirementId: '',
        title: String((doc && doc.title) || (found && found.row && found.row.title) || id).slice(0, 120),
        detail: detail.slice(0, 2000),
        acceptance: acceptanceCriteria.slice(0, 1500),
        story: story.slice(0, 1500),
        priority: String((doc && doc.priority) || (found && found.row && found.row.priority) || 'P2'),
        priorityBy: '',
        priorityReason: '',
        owner: null,
        status: ['accepted', 'terminated'].includes(docStatus) ? 'done' : 'todo',
        createdBy: 'legacy-doc',
        createdAt,
        claimedAt: null,
        due: '',
        doneAt: ['accepted', 'terminated'].includes(docStatus) ? createdAt : null,
        evidence: ['accepted', 'terminated'].includes(docStatus) ? `旧需求正文状态：${docStatus}` : '',
        rev: 0,
        history: [{ ts: at, by: 'legacy-doc', action: 'import', note: `从 ${doc ? doc.rel : '工作流镜像'} 导入旧需求` }],
        workflow: {
          requirementStatus: docStatus,
          origin: 'legacy-doc',
          ...(doc ? { importedFrom: doc.rel } : {})
        },
        updatedAt: at
      };
      try {
        writeJsonAtomic(legacyTaskFilePath(name, task.id), task);
      } catch (error) {
        return failure('TASK_WRITE_FAILED', `补建旧需求任务失败：${String(error && error.message || error).slice(0, 200)}`, { requirementId: wanted });
      }
      createdTask = true;
    }

    let meta = found ? found.row : null;
    let createdRow = false;
    if (!meta) {
      const id = String(task.id || (doc && doc.id) || wanted);
      meta = {
        id,
        title: String(task.title || (doc && doc.title) || id).slice(0, 120),
        priority: String(task.priority || (doc && doc.priority) || 'P2'),
        origin: 'legacy-doc',
        queued: false,
        round: Number(read.state.round || 1),
        status: docStatus,
        createdBy: 'legacy-doc',
        createdAt: task.createdAt || (doc && doc.mtime) || at,
        updatedAt: at,
        acceptanceCriteria,
        story,
        detail,
        productReview: null,
        ownerReview: null,
        dispatch: null,
        dev: null,
        test: null,
        acceptance: null,
        doc: doc ? doc.rel : '',
        history: [{ at, action: 'create', by: 'legacy-doc', note: `从 ${doc ? doc.rel : '旧任务'} 导入需求` }]
      };
      const written = mutateWorkflowState(name, (state) => {
        state.requirements = state.requirements && typeof state.requirements === 'object' ? state.requirements : {};
        if (findStateRequirementRow(state, id)) return;
        state.requirements[id] = meta;
        if (!state.phase || state.phase === 'idle') state.phase = 'requirement_review';
        pushWorkflowEventOnce(state, {
          at, action: 'requirement_import', role: 'legacy-doc', project: name,
          requirementId: id, note: `导入只有正文的旧需求 ${id}`
        });
      });
      if (!written.ok) return written;
      createdRow = true;
    }
    return {
      ok: true,
      code: 'OK',
      id: String(meta.id || task.id),
      doc,
      task,
      meta,
      createdTask,
      createdRow,
      workflowFile: read.file
    };
  }

  function safeRequirementTitle(title) {
    return String(title || '需求').replace(/[\\/:*?"<>|\r\n\t]/g, '-').replace(/\s+/g, ' ').trim().slice(0, 40) || '需求';
  }

  function writeRequirementDoc(projectPath, requirement, meta = {}) {
    const dir = path.join(projectPath, '需求');
    fs.mkdirSync(dir, { recursive: true });
    const id = String(requirement.id || '');
    const file = path.join(dir, `${id}-${safeRequirementTitle(requirement.title)}.md`);
    if (!fs.existsSync(file)) {
      const lines = [
        `# ${requirement.title || id}`,
        '',
        `- 需求 id：${id}`,
        `- 优先级：${requirement.priority || 'P2'}`,
        `- 来源：${meta.origin === 'owner' ? 'Owner' : (requirement.createdBy || meta.createdBy || '')}`,
        `- 状态：${meta.status || 'review'}`,
        `- 创建时间：${requirement.createdAt || new Date().toISOString()}`,
        '',
        '## 用户故事',
        '',
        String(requirement.story || '（待补充）'),
        '',
        '## 验收标准',
        '',
        String(requirement.acceptance || '（必须补充验收标准，否则不进入开发）'),
        '',
        '## 详情',
        '',
        String(requirement.detail || '（待补充）'),
        ''
      ];
      writeTextAtomic(file, lines.join('\n'));
    }
    const overview = path.join(dir, '00-需求总览.md');
    try {
      if (!fs.existsSync(overview)) {
        writeTextAtomic(overview, '# 需求总览\n\n| 需求 | 标题 | 优先级 | 状态 | 验收标准 |\n|---|---|---|---|---|\n');
      }
      const current = fs.readFileSync(overview, 'utf8');
      if (!current.includes(id)) {
        fs.appendFileSync(overview, `| ${id} | ${String(requirement.title || '').replace(/\|/g, '/')} | ${requirement.priority || 'P2'} | review | ${String(requirement.acceptance || '').replace(/\|/g, '/')} |\n`, 'utf8');
      }
    } catch { /* 总览写失败不影响需求本体 */ }
    return file;
  }

  function requirementView(task, meta) {
    const row = meta && typeof meta === 'object' ? meta : {};
    const source = task && typeof task === 'object' ? task : {};
    return {
      id: String(row.id || source.id || ''),
      title: String(row.title || source.title || ''),
      priority: String(row.priority || source.priority || 'P2'),
      status: String(row.status || (source.status === 'done' ? 'accepted' : 'review')),
      origin: String(row.origin || 'role'),
      type: String(row.type || source.type || ''),
      owner: String(row.owner || source.owner || ''),
      queued: Boolean(row.queued),
      round: Number(row.round || 1),
      createdBy: String(row.createdBy || source.createdBy || ''),
      createdAt: row.createdAt || source.createdAt || null,
      updatedAt: row.updatedAt || source.updatedAt || null,
      taskStatus: String(source.status || ''),
      acceptanceCriteria: String(source.acceptance || row.acceptanceCriteria || ''),
      acceptance: String(source.acceptance || ''),
      story: String(source.story || row.story || ''),
      detail: String(source.detail || row.detail || ''),
      evidence: String(source.evidence || row.evidence || ''),
      reviewRole: String(row.reviewRole || ''),
      techReviewRole: String(row.techReviewRole || ''),
      productReview: row.productReview || null,
      techReview: row.techReview || null,
      voteRejection: row.voteRejection || null,
      ownerReview: row.ownerReview || null,
      decisions: Array.isArray(row.decisions) ? row.decisions : [],
      dispatch: row.dispatch || null,
      dev: row.dev || null,
      test: row.test || null,
      ownerAcceptance: row.acceptance || null,
      doc: String(row.doc || ''),
      history: Array.isArray(row.history) ? row.history : []
    };
  }

  // 阶段只由证据推导，不再让 工作流.json 里陈旧的 phase 永久胜出。
  // 顺序即“只前进不回退”：需求 → 需求评审 → Owner → 技术评审 → 派单 → 开发 → 互审 → 测试 → 待验收 → 验收/迭代。
  const PHASE_RANK = {
    idle: 0, requirement: 1, requirement_review: 2, product_review: 2, owner_review: 3,
    tech_review: 4, dispatch: 5, ready: 5, dev: 6, dev_review: 7, dev_done: 7,
    test: 8, test_done: 9, owner_accept: 10, accepted: 11, iteration: 11, terminated: 12,
  };
  const rankPhase = (phase) => PHASE_RANK[String(phase || '')] || 0;
  const maxPhase = (a, b) => (rankPhase(b) > rankPhase(a) ? b : a);

  function phaseFromRequirements(state, requirements, tasks = []) {
    const rows = Array.isArray(requirements) ? requirements : [];
    if (!rows.length) return (state && state.phase) || 'idle';
    // 显式回退/收口事件优先：评审 reject、Owner 打回、终止是设计里的合法回退（产品设计 §二），
    // 不能被同项目其它需求“更靠后”的状态掩盖，否则驳回后界面停在 dispatch，掩盖返工。
    const statuses = new Set(rows.map((row) => String(row.status || '')));
    if ((state && state.phase === 'terminated') || statuses.has('terminated')) return 'terminated';
    if (statuses.has('rejected')) return 'requirement_review';
    let phase = 'idle';
    if (statuses.has('test_done')) phase = 'owner_accept';
    else if (statuses.has('test')) phase = 'test';
    else if (statuses.has('dev_review')) phase = 'dev_review';
    else if (statuses.has('dev') || statuses.has('dispatched') || statuses.has('dev_done')) phase = 'dev_done';
    else if (statuses.has('tech_review')) phase = 'tech_review';
    else if (statuses.has('ready')) phase = 'dispatch';
    else if (statuses.has('approved')) phase = 'owner_review';
    else if (statuses.has('review') || statuses.has('rejected')) phase = 'requirement_review';
    else if (rows.every((row) => ['accepted', 'iteration'].includes(String(row.status)))) phase = 'accepted';
    // 任务证据：需求行状态可能没被角色回写，但任务已全部 done。只升不降。
    const taskRows = Array.isArray(tasks) ? tasks : [];
    for (const row of rows) {
      const status = String(row.status || '');
      if (['accepted', 'terminated', 'iteration', 'rejected'].includes(status)) continue;
      const kids = taskRows.filter((task) => task && String(task.requirementId || '') === String(row.id || '') && task.type !== 'requirement');
      if (!kids.length || kids.some((task) => String(task.status || '') !== 'done')) continue;
      const testerDone = kids.some((task) => String(task.owner || '') === 'tester');
      const devDone = kids.some((task) => ['programmer1', 'programmer2'].includes(String(task.owner || '')));
      if (testerDone) phase = maxPhase(phase, 'owner_accept');
      else if (devDone) phase = maxPhase(phase, 'dev_done');
      else phase = maxPhase(phase, 'dispatch');
    }
    // 迭代：全部需求已收口且轮次被推进时保留 iteration。
    if (state && state.phase === 'iteration' && phase === 'accepted') return 'iteration';
    return phase;
  }

  /**
   * 只读列出旧协议提案（P-*），供 Owner 评审与提案页直接展示。
   * 只读 提案/评审/签字/提交 四类文件，不写状态、不伪造评审。
   */
  function listLegacyProposals(projectName) {
    const name = String(projectName || '').trim();
    if (!name) return failure('PROJECT_REQUIRED', '缺少团队项目名');
    const paths = projectStatePaths(name);
    let ids = [];
    try { ids = fs.readdirSync(paths.proposals).filter((id) => /^P-/.test(id)); } catch { ids = []; }
    const commits = [];
    try {
      for (const file of fs.readdirSync(paths.commits).filter((f) => f.endsWith('.json'))) {
        const record = readJsonSafe(path.join(paths.commits, file));
        if (record && record.proposalId) commits.push(record);
      }
    } catch { /* none */ }
    const proposals = [];
    for (const id of ids) {
      const dir = path.join(paths.proposals, id);
      const proposal = readJsonSafe(path.join(dir, '提案.json'));
      if (!proposal) continue;
      const reviews = {};
      try {
        for (const file of fs.readdirSync(path.join(dir, '评审')).filter((f) => f.endsWith('.json'))) {
          const row = readJsonSafe(path.join(dir, '评审', file));
          if (row) reviews[String(row.role || file.replace(/\.json$/, ''))] = row;
        }
      } catch { /* none */ }
      const signatures = {};
      try {
        for (const file of fs.readdirSync(path.join(dir, '签字')).filter((f) => f.endsWith('.json'))) {
          const row = readJsonSafe(path.join(dir, '签字', file));
          if (row) signatures[String(row.role || file.replace(/\.json$/, ''))] = row;
        }
      } catch { /* none */ }
      const commit = commits.find((row) => String(row.proposalId) === String(id)) || null;
      proposals.push({
        id,
        title: String(proposal.title || ''),
        author: String(proposal.author || ''),
        status: String(proposal.status || ''),
        risk: String(proposal.risk || ''),
        task: String(proposal.task || ''),
        rationale: String(proposal.rationale || ''),
        createdAt: proposal.createdAt || null,
        proposalHash: proposal.proposalHash || '',
        files: (Array.isArray(proposal.files) ? proposal.files : []).map((file) => ({
          target: String(file.target || '').replace(/\\/g, '/'),
          size: Number(file.size || 0),
          baseHash: file.baseHash === undefined ? null : file.baseHash,
          newHash: file.newHash || null
        })),
        reviews,
        signatures,
        commitId: commit ? commit.id : '',
        appliedAt: commit ? commit.createdAt : null
      });
    }
    proposals.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
    return { ok: true, code: 'OK', project: name, count: proposals.length, proposals };
  }

  /**
   * 只读快照：需求/任务从旧 任务/ 目录读，阶段从旧 工作流.json 读。
   * 读不到旧状态时返回空快照，不拿本地 workbench.json 冒充真相。
   */
  function readWorkflowSnapshot(projectName, projectPath) {
    const name = String(projectName || '').trim();
    if (!name) return failure('PROJECT_REQUIRED', '缺少团队项目名');
    // 先吸收团队工具现场：DSH 角色直接写 TR/V 文件时，工作台读快照也要看到。
    // 只在确有 closed/rejected 或 tech_review 待认领记录时写 工作流.json。
    syncTechReviewsFromDisk(name, projectPath);
    syncVoteRejectionsFromDisk(name, projectPath);
    const read = readWorkflowState(name);
    if (!read.ok) return read;
    const state = read.state;
    const projectMode = normalizeTeamMode((readJsonSafe(path.join(projectStateDir(name), '项目.json')) || {}).teamMode);
    const tasks = readLegacyTasks(name);
    const byId = new Map(tasks.map((task) => [String(task.id), task]));
    const requirements = [];
    const seen = new Set();
    for (const [id, meta] of Object.entries(state.requirements || {})) {
      seen.add(String(id));
      requirements.push(requirementView(byId.get(String(id)), meta));
    }
    for (const task of tasks) {
      if (task.type !== 'requirement' || seen.has(String(task.id))) continue;
      requirements.push(requirementView(task, null));
    }
    // 旧项目可能只有 需求/R-*.md 正文，没有 工作流.json 行/任务。
    // 这些需求也必须进入工作流扫描，否则界面显示“没有需求”、迭代守卫也会放行。
    // 注意：同一份需求正文不能因为文件 id 与真实需求 id 写法不同（4 位/6 位/截断）
    // 被重复登记成第二条“幽灵需求”，否则界面会一直显示 requirements 里还有 review。
    const resolvedProjectPath = projectPath ? path.resolve(projectPath) : ((registrationFor(name) || {}).path || '');
    if (resolvedProjectPath) {
      const knownDocs = requirements.map((row) => String(row.doc || '').replace(/\\/g, '/')).filter(Boolean);
      const knownIds = requirements.map((row) => String(row.id || '')).filter(Boolean);
      for (const doc of readRequirementDocs(resolvedProjectPath).list) {
        const rel = String(doc.rel || '').replace(/\\/g, '/');
        if (knownDocs.includes(rel)) continue;
        const docId = String(doc.id || '');
        const sameId = knownIds.some((id) => id === docId || id.startsWith(docId) || docId.startsWith(id));
        if (sameId) continue;
        knownIds.push(docId);
        knownDocs.push(rel);
        requirements.push(requirementView(null, {
          id: doc.id,
          title: doc.title || doc.id,
          priority: doc.priority || 'P2',
          status: doc.status || 'review',
          origin: 'legacy-doc',
          queued: false,
          round: 1,
          createdBy: 'legacy',
          createdAt: doc.mtime || null,
          updatedAt: doc.mtime || null,
          acceptanceCriteria: '',
          story: '',
          detail: '',
          doc: doc.rel
        }));
      }
    }
    requirements.sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    // 投票唯一真相：团队工具 投票/V-*.json。工作流.json.votes 只作为旧项目只读兼容，
    // 不再写入、也不参与判定；这里优先读 V 文件，避免第二份真相。
    const statusByRequirement = new Map();
    for (const view of requirements) statusByRequirement.set(String(view.id), String(view.status || ''));
    const votes = readVoteRecords(name)
      .map((vote) => teamVoteView(vote, statusByRequirement.get(String(vote.requirementId)) || ''));
    for (const view of requirements) {
      view.votes = votes.filter((vote) => String(vote.requirementId) === String(view.id));
      view.vote = view.votes.length ? view.votes[view.votes.length - 1] : null;
    }
    let phase = phaseFromRequirements(state, requirements, tasks);
    // 旧项目可能只有 team.mjs 建的任务/需求、没有本闭环的 requirements 元数据；
    // 此时按旧任务的 owner/status 反推阶段，避免把真实旧项目显示成 intake。
    if (!requirements.length && tasks.length && phase === 'idle') {
      const openTasks = tasks.filter((task) => task.status !== 'done');
      if (openTasks.some((task) => task.owner === 'tester')) phase = 'test';
      else if (openTasks.some((task) => ['programmer1', 'programmer2'].includes(String(task.owner)))) phase = 'dev';
      else if (!openTasks.length) phase = 'accepted';
      else if (tasks.some((task) => ['product', 'analyst'].includes(String(task.owner)))) phase = 'requirement_review';
      else phase = 'dispatch';
    }
    const open = tasks.filter((task) => task.status !== 'done');
    let commits = 0;
    try { commits = fs.readdirSync(projectStatePaths(name).commits).filter((file) => file.endsWith('.json')).length; } catch { /* none */ }
    const nextRound = requirements.filter((row) => row.queued || Number(row.round || 1) > Number(state.round || 1));
    const caps = capabilitiesForProjectMode(legacyCapabilities(), projectMode);
    return {
      ok: true,
      code: 'OK',
      project: name,
      projectPath: resolvedProjectPath || '',
      teamMode: projectMode,
      file: read.file,
      exists: read.exists,
      // B-b55c：列表与确认同源——快照带上"这份状态哪个文件、什么时候读的"，
      // 界面才能显示来源，并把界面看到的状态回传给确认接口做一致性判断。
      source: workflowStateSource(read),
      workflow: state,
      phase,
      stage: WORKFLOW_STAGE_BY_PHASE[phase] || 'intake',
      legacyStage: phase === 'owner_review' || phase === 'owner_accept' ? 'bossreview' : (WORKFLOW_STAGE_BY_PHASE[phase] || 'intake'),
      round: Number(state.round || 1),
      requirements,
      tasks,
      votes,
      ownerReview: state.ownerReview || { required: false, status: 'optional' },
      boots: state.boots || {},
      nextRound,
      counts: {
        requirements: requirements.length,
        tasks: tasks.length,
        open: open.length,
        done: tasks.length - open.length,
        commits,
        votes: votes.length,
        accepted: requirements.filter((row) => row.status === 'accepted').length
      },
      roundKey: `${name}|${state.round || 1}|${requirements.length}|${open.length}`,
      updatedAt: state.updatedAt || null,
      legacy: {
        source: '工作流.json + 任务/ + 技术评审/ + 投票/',
        file: read.file,
        exists: read.exists,
        managed: Boolean(read.managed),
        schema: state.schema,
        rawSchema: read.raw ? read.raw.schema || null : null,
        capabilities: caps,
        missingCommands: caps.missing,
        optionalMissing: caps.optionalMissing,
        shellOwned: Array.isArray(caps.shellOwned) ? caps.shellOwned : []
      }
    };
  }

  /** 工作流动作前置：项目必须已在旧团队登记，六角色目录/文档/索引必须齐。 */
  async function ensureWorkflowProject(input = {}) {
    const name = String(input.projectName || '').trim();
    if (!name) return failure('PROJECT_REQUIRED', '缺少团队项目名');
    // 旧工具不存在时，任何工作流写动作都必须先明确报 LEGACY_PROTOCOL_REQUIRED，
    // 不能先补本地结构/写本地状态，让调用方误以为流程还能走。
    if (!legacyCapabilities().available) {
      return failure('LEGACY_PROTOCOL_REQUIRED', `旧团队工具不可用，不能推进工作流：${layout.teamTool}`, {
        requiredCommand: 'team.mjs', protocol: 'legacy', capabilities: legacyCapabilities()
      });
    }
    const registration = registrationFor(name);
    if (!registration || !registration.path) {
      return failure('NO_TEAM_PROJECT', `旧协议里没有项目「${name}」；先创建/恢复项目并 ensure`, { project: name });
    }
    const requested = String(input.projectPath || '').trim();
    const projectPath = path.resolve(requested || registration.path);
    if (path.resolve(registration.path).toLowerCase() !== projectPath.toLowerCase()) {
      return failure('PROJECT_PATH_MISMATCH', `项目目录与旧团队登记不一致：${projectPath} ≠ ${registration.path}`, {
        project: name, projectPath, registeredPath: registration.path
      });
    }
    const mode = normalizeTeamMode(input);
    const structure = await ensureProjectStructure({ name, path: projectPath, projectPath, teamMode: mode });
    if (!structure.ok) return { ...structure, ok: false, project: name, projectPath };
    ensureRosterRoles(name, mode);
    return {
      ok: true,
      code: 'OK',
      name,
      projectName: name,
      projectPath,
      teamMode: mode,
      roleIds: roleIdsForTeamMode(mode),
      registration,
      structure,
      capabilities: legacyCapabilities()
    };
  }

  async function createRequirement(input = {}) {
    const ctx = await ensureWorkflowProject(input);
    if (!ctx.ok) return ctx;
    // 旧工具缺 req create 时先返回 LEGACY_PROTOCOL_REQUIRED；不能被后续业务状态
    // （例如已终止）遮住“命令根本不存在”这一事实。
    const guard = requireLegacyCommand('req create');
    if (guard) return guard;
    const origin = input.origin === 'owner' ? 'owner' : 'role';
    const mode = normalizeTeamMode(input.teamMode || ctx.teamMode);
    const role = String(input.role || (origin === 'owner' ? 'pm' : '')).trim();
    const allowed = origin === 'owner'
      ? ['pm', 'owner']
      : roleIdsForTeamMode(mode).filter((item) => ['product', 'analyst'].includes(item));
    if (!allowed.includes(role)) {
      return failure('ROLE_NOT_ALLOWED', origin === 'owner'
        ? 'Owner 新需求由 PM 代办；role 必须是 pm'
        : (mode === 'fast'
          ? 'Fast 模式的需求只能由需求分析师创建'
          : '只有产品设计师或需求分析师能创建需求'), { role, allowed, teamMode: mode });
    }
    const title = String(input.title || '').trim();
    const acceptance = String(input.acceptance || input.acceptanceCriteria || '').trim();
    const priority = String(input.priority || 'P2').trim().toUpperCase();
    if (!title) return failure('TITLE_REQUIRED', '需求标题不能为空');
    if (!acceptance) return failure('ACCEPTANCE_REQUIRED', '需求必须先写验收标准，否则不允许进入开发', { title });
    if (!['P0', 'P1', 'P2', 'P3'].includes(priority)) return failure('BAD_PRIORITY', '优先级必须是 P0/P1/P2/P3', { priority });
    const story = String(input.story || '').slice(0, 1500);
    const detail = String(input.detail || '').slice(0, 2000);
    // 终止是硬闸门：终止后不再接受新需求；要重新开始请新建项目或显式开启新一轮。
    const beforeCreate = readWorkflowState(ctx.name);
    if (beforeCreate.ok && beforeCreate.state.phase === 'terminated') {
      return failure('WORKFLOW_TERMINATED', `项目「${ctx.name}」工作流已终止，不能再创建需求；请先开启新一轮或新建项目`, {
        project: ctx.name, phase: 'terminated'
      });
    }
    const run = await runLegacyCommand(ctx.name, role, 'req create', (token) => [
      'req', 'create', '--boot', token,
      '--title', title, '--priority', priority,
      '--acceptance', acceptance,
      ...(story ? ['--story', story] : []),
      ...(detail ? ['--detail', detail] : []),
      ...(input.owner && ROLE_IDS.includes(String(input.owner)) ? ['--owner', String(input.owner)] : [])
    ], { sessionId: String(input.sessionId || '').trim() });
    if (!run.ok) return run;
    const task = (run.value && (run.value.requirement || run.value.task)) || null;
    if (!task || !task.id) return failure('BAD_JSON', '旧 req create 没有返回需求任务', { value: run.value });
    const currentRead = readWorkflowState(ctx.name);
    if (!currentRead.ok) return currentRead;
    // Owner 需求的排轮策略：
    //   - demandRoundMode='always'（requirement:owner-create 的旧行为）：一律排到下一轮；
    //   - demandRoundMode='auto'（owner:demand）：本轮有在办需求时入下一轮队列，
    //     否则直接进入本轮产品评审（requirement_review）。
    const demandMode = origin === 'owner' ? String(input.demandRoundMode || 'always') : 'auto';
    const busyCurrentRound = origin === 'owner' && demandMode === 'auto'
      && Object.values(currentRead.state.requirements || {}).some((row) => row && typeof row === 'object'
        && !row.queued
        && Number(row.round || 1) <= Number(currentRead.state.round || 1)
        && !ITERATE_CLOSED_STATUSES.includes(String(row.status)));
    const demandQueued = origin === 'owner' && (demandMode === 'always' || busyCurrentRound);
    const round = origin === 'owner'
      ? (demandQueued
        ? Math.max(Number(currentRead.state.round || 1) + 1, Number(input.round) || 0)
        : Number(currentRead.state.round || 1))
      : Number(currentRead.state.round || 1);
    const at = new Date().toISOString();
    const meta = {
      id: String(task.id),
      title,
      priority,
      origin,
      queued: demandQueued,
      round,
      status: 'review',
      teamMode: mode,
      reviewRole: requirementReviewRole(mode),
      techReviewRole: techReviewRole(mode),
      createdBy: origin === 'owner' ? 'owner' : role,
      createdAt: task.createdAt || at,
      updatedAt: at,
      acceptanceCriteria: acceptance,
      story,
      detail,
      productReview: null,
      ownerReview: null,
      dispatch: null,
      dev: null,
      test: null,
      acceptance: null,
      history: [{ at, action: 'create', by: origin === 'owner' ? 'owner' : role, note: `需求 ${task.id} 创建` }]
    };
    const docFile = (() => {
      // 新版旧 req create 自己写 需求/R-*.md；必须复用同一份，不能再造第二个正文。
      const legacyRel = run.value && run.value.doc ? String(run.value.doc).replace(/\\/g, '/') : '';
      if (legacyRel) {
        const abs = path.resolve(ctx.projectPath, legacyRel);
        if (isInside(ctx.projectPath, abs) && fs.existsSync(abs)) return abs;
      }
      return writeRequirementDoc(ctx.projectPath, task, meta);
    })();
    const patch = patchLegacyTask(ctx.name, task.id, {
      workflow: {
        requirementStatus: 'review',
        origin,
        queued: meta.queued,
        round,
        acceptanceCriteria: acceptance
      }
    });
    const written = mutateWorkflowState(ctx.name, (state) => {
      state.requirements = state.requirements && typeof state.requirements === 'object' ? state.requirements : {};
      state.requirements[task.id] = meta;
      if ((origin !== 'owner' || !demandQueued) && (!state.phase || state.phase === 'idle')) state.phase = 'requirement_review';
      pushWorkflowEvent(state, {
        action: 'requirement_create', role: meta.createdBy, project: ctx.name,
        requirementId: task.id, taskId: task.id,
        note: `${priority} ${title}${meta.queued ? '（排队到第 ' + round + ' 轮）' : ''}`
      });
    });
    if (!written.ok) return written;
    const projectIndex = await refreshProjectIndex(ctx.name, ctx.projectPath);
    const indexWarning = projectIndexWarning(projectIndex);
    const snapshot = readWorkflowSnapshot(ctx.name, ctx.projectPath);
    return {
      ok: true,
      code: 'OK',
      protocol: 'legacy',
      driver: 'team.mjs req create',
      requirement: requirementView(task, meta),
      task,
      docFile,
      workflowFile: written.file,
      workflowWrite: { ok: true, file: written.file },
      workflow: snapshot.ok ? snapshot.workflow : null,
      snapshot: snapshot.ok ? snapshot : null,
      projectIndex,
      warnings: indexWarning ? [indexWarning] : [],
      legacy: {
        command: 'req create',
        capabilities: ctx.capabilities,
        missingCommands: ctx.capabilities.missing,
        taskPatch: patch.ok ? { ok: true } : { ok: false, code: patch.code, message: patch.message }
      }
    };
  }

  async function reviewRequirement(input = {}) {
    const ctx = await ensureWorkflowProject(input);
    if (!ctx.ok) return ctx;
    const mode = normalizeTeamMode(input.teamMode || ctx.teamMode);
    const role = String(input.role || '').trim();
    // Fast：Owner 之后增加开发技术评审，由高级程序员 A 在同一入口提交；
    // Full：保持产品评审，不开放技术评审阶段。
    if (mode === 'fast' && role === techReviewRole(mode)) {
      return techReviewRequirementForContext(ctx, input, mode);
    }
    const reviewRole = requirementReviewRole(mode);
    if (role !== reviewRole) {
      return failure('ROLE_NOT_ALLOWED', mode === 'fast'
        ? 'Fast 模式的需求评审必须由需求分析师执行（Owner 之后还有开发技术评审）'
        : '需求评审必须由产品设计师执行', { role, allowed: [reviewRole], teamMode: mode });
    }
    const requirementId = String(input.requirementId || input.id || '').trim();
    if (!requirementId) return failure('REQUIREMENT_REQUIRED', '缺少需求 id');
    const verdict = String(input.verdict || input.decision || '').toLowerCase();
    if (!['approve', 'reject'].includes(verdict)) return failure('BAD_VERDICT', '评审结论必须是 approve / reject');
    const comment = String(input.comment !== undefined ? input.comment : (input.comments || '')).trim();
    if (verdict === 'reject' && comment.length < 10) return failure('COMMENTS_REQUIRED', '打回必须写至少 10 字理由');
    // 缺 req review 就停在命令闸门：不 boot、不读状态、更不写 工作流.json。
    const commandGuard = requireLegacyCommand('req review');
    if (commandGuard) return { ...commandGuard, project: ctx.name, projectPath: ctx.projectPath };
    // 旧项目可能只有 需求/R-*.md 正文；先按正文补任务/工作流行，再走正常 review。
    const imported = ensureLegacyRequirementRecord(ctx.name, ctx.projectPath, requirementId);
    if (!imported.ok) return imported;
    const gate = await ensureWorkflowBoot(ctx.name, ctx.projectPath, role, { requirementId });
    if (!gate.ok) return gate;
    const read = readWorkflowState(ctx.name);
    if (!read.ok) return read;
    const found = findStateRequirementRow(read.state, requirementId);
    if (!found) return failure('REQUIREMENT_NOT_FOUND', `工作流里没有需求 ${requirementId}`, { requirementId });
    const meta = found.row;
    if (!['review', 'rejected'].includes(String(meta.status))) {
      return failure('REQUIREMENT_STATE_INVALID', `需求 ${requirementId} 当前状态是 ${meta.status}，不能评审`, {
        requirementId, status: meta.status
      });
    }
    const run = await runLegacyWorkflowProtocol('req review', {
      projectName: ctx.name,
      projectPath: ctx.projectPath,
      role,
      requirementId,
      verdict,
      comment,
      sessionId: String(input.sessionId || '').trim()
    });
    if (!run.ok) return run;
    const legacyRequirement = run.value && (run.value.requirement || run.value.task);
    if (!legacyRequirement || !legacyRequirement.id) {
      return failure('BAD_JSON', '旧 req review 没有返回需求对象，拒绝把本次评审当作已发生', {
        command: 'req review', protocol: 'legacy', value: run.value
      });
    }
    if (String(legacyRequirement.id) !== requirementId) {
      return failure('BAD_JSON', `旧 req review 返回了别的需求：${legacyRequirement.id} ≠ ${requirementId}`, {
        command: 'req review', protocol: 'legacy'
      });
    }
    const at = new Date().toISOString();
    const review = {
      verdict, by: role, reviewRole: reviewRole, teamMode: mode,
      comment: comment.slice(0, 600), at, source: 'team.mjs req review', command: 'req review'
    };
    const written = mutateWorkflowState(ctx.name, (state) => {
      const target = findStateRequirementRow(state, requirementId);
      if (!target) throw new Error(`工作流里没有需求 ${requirementId}`);
      const row = target.row;
      row.productReview = review;
      // 保留 requirementReview 同形别名：旧界面读 productReview，新界面/审计可按评审角色读。
      row.requirementReview = review;
      row.reviewRole = role;
      row.teamMode = mode;
      row.updatedAt = at;
      pushHistoryOnce(row, { at, action: 'product_review', by: role, note: verdict }, {
        requirementId
      });
      if (verdict === 'approve') {
        row.status = 'approved';
        // Owner 还没决定：pending 不能写 by/actor，否则界面/审计会把“待办”当成 Owner 的记录。
        row.ownerReview = { status: 'pending', at: null, opinion: '' };
        state.phase = 'owner_review';
        state.ownerReview = { required: true, status: 'pending', kind: 'requirement', roundKey: `${ctx.name}|${state.round}|${Object.keys(state.requirements).length}`, at: null, opinion: '' };
      } else {
        row.status = 'rejected';
        // 评审驳回后回到需求评审（可修改后重评），不能停在 requirement 阶段。
        state.phase = REJECTED_REQUIREMENT_PHASE;
      }
      pushWorkflowEventOnce(state, {
        at, action: 'requirement_review', role, project: ctx.name, requirementId,
        note: `${verdict}${comment ? '：' + comment.slice(0, 80) : ''}`
      });
    });
    if (!written.ok) return written;
    const patch = patchLegacyTask(ctx.name, imported.id || requirementId, {
      workflow: { requirementStatus: verdict === 'approve' ? 'approved' : 'rejected', productReview: review }
    });
    const projectIndex = await refreshProjectIndex(ctx.name, ctx.projectPath);
    const indexWarning = projectIndexWarning(projectIndex);
    const snapshot = readWorkflowSnapshot(ctx.name, ctx.projectPath);
    return {
      ok: true,
      code: 'OK',
      protocol: 'legacy',
      driver: 'team.mjs req review',
      legacyCommandStatus: 'AVAILABLE',
      fallback: null,
      teamMode: mode,
      reviewRole,
      requirement: snapshot.ok ? snapshot.requirements.find((row) => row.id === requirementId) : null,
      review,
      workflowFile: written.file,
      workflow: snapshot.ok ? snapshot.workflow : null,
      snapshot: snapshot.ok ? snapshot : null,
      projectIndex,
      warnings: [
        ...(Array.isArray(run.value && run.value.warnings) ? run.value.warnings : []),
        ...(indexWarning ? [indexWarning] : [])
      ],
      legacy: {
        command: 'req review',
        commandAvailable: true,
        argv: Array.isArray(run.argv) ? run.argv : [],
        mocked: Boolean(run.mocked),
        missingCommands: ctx.capabilities.missing,
        taskPatch: patch.ok ? { ok: true } : { ok: false, code: patch.code, message: patch.message }
      }
    };
  }

  // ==========================================================================
  // 团队工具真相文件读取：技术评审 TR-*.json / 投票 V-*.json
  //
  // 壳层不再另造评审/投票文件：
  //   - 写入：走 team.mjs req review --kind tech / vote start|cast（同一份文件）；
  //   - 读取：直接读团队工具自己的 技术评审/、投票/ 目录。
  // 两条路线（DSH 角色执行 / 工作台 IPC）因此看到的是同一份 JSON。
  // ==========================================================================

  function reviewRecordsDir(projectName, kind = 'tech') {
    return path.join(projectStateDir(projectName), kind === 'tech' ? '技术评审' : '需求评审');
  }

  function readReviewRecords(projectName, kind = 'tech') {
    const dir = reviewRecordsDir(projectName, kind);
    const prefix = kind === 'tech' ? 'TR' : 'RR';
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    const records = [];
    for (const name of names) {
      if (!new RegExp('^' + prefix + '-.*\\.json$', 'i').test(name)) continue;
      const file = path.join(dir, name);
      const data = readJsonSafe(file);
      if (!data || typeof data !== 'object' || !data.id) continue;
      records.push({ ...data, file, _file: file });
    }
    records.sort((a, b) => String(b.ts || b.createdAt || '').localeCompare(String(a.ts || a.createdAt || ''))
      || String(b.id || '').localeCompare(String(a.id || '')));
    return records;
  }

  function latestTechReviewRecord(projectName, requirementId, preferredId = '') {
    const records = readReviewRecords(projectName, 'tech')
      .filter((record) => String(record.requirementId || '') === String(requirementId || ''));
    if (!records.length) return null;
    if (preferredId) {
      const exact = records.find((record) => String(record.id) === String(preferredId));
      if (exact) return exact;
    }
    return records[0];
  }

  function votesDir(projectName) {
    return path.join(projectStateDir(projectName), '投票');
  }

  function readVoteRecords(projectName) {
    const dir = votesDir(projectName);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return []; }
    const records = [];
    for (const name of names) {
      if (!/^V-.*\.json$/i.test(name)) continue;
      const file = path.join(dir, name);
      const data = readJsonSafe(file);
      if (!data || typeof data !== 'object' || !data.id) continue;
      records.push({ ...data, file, _file: file });
    }
    records.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || ''))
      || String(b.id || '').localeCompare(String(a.id || '')));
    return records;
  }

  /**
   * 投票发起人归属修正。
   *
   * 旧 team.mjs 的 vote start 只允许 PM 执行，V 文件里的 createdBy 因此会被写成 pm；
   * 但工作台里的实际发起人是调用方（默认入口 analyst，工作台默认发起人也是 analyst）。
   * V 文件是投票唯一真相，必须在创建事务里就写对归属：
   *   - createdBy / initiator = 实际发起人（analyst），UI 与状态读同一份；
   *   - createdByCommand     = 实际执行旧命令的角色（pm），保留审计，不伪造执行主体。
   */
  function stampVoteInitiator(projectName, vote, initiator) {
    const name = String(initiator || '').trim();
    const file = String(vote && (vote.file || vote._file) || '').trim();
    if (!file || !name) return { ok: false, code: 'VOTE_FILE_MISSING' };
    const data = readJsonSafe(file);
    if (!data || typeof data !== 'object') return { ok: false, code: 'BAD_JSON' };
    if (String(data.createdBy || '') === name && String(data.initiator || '') === name) {
      return { ok: true, changed: false, vote };
    }
    data.createdByCommand = String(data.createdByCommand || data.createdBy || '');
    data.createdBy = name;
    data.initiator = name;
    data.initiatedAt = String(data.initiatedAt || data.createdAt || '');
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
    return { ok: true, changed: true, vote: findVoteById(projectName, data.id) || { ...data, file, _file: file } };
  }

  function teamVoteTally(vote) {
    const eligible = Array.isArray(vote && vote.eligible) ? [...new Set(vote.eligible.map(String))] : [];
    const votes = vote && vote.votes && typeof vote.votes === 'object' ? vote.votes : {};
    const cast = eligible.filter((role) => votes[role]);
    const approve = cast.filter((role) => String(votes[role].vote || '').toLowerCase() === 'approve');
    const reject = cast.filter((role) => String(votes[role].vote || '').toLowerCase() === 'reject');
    const abstain = cast.filter((role) => String(votes[role].vote || '').toLowerCase() === 'abstain');
    return {
      eligible,
      cast,
      missing: eligible.filter((role) => !votes[role]),
      approve,
      reject,
      abstain,
      total: eligible.length
    };
  }

  /**
   * 与 team.mjs ops.mjs 的 evaluateVote 同一套 3/5 规则：
   * 除 PM 外全员一致 reject → rejected；赞成过半 → approved；
   * 全部投完仍无多数 → no_consensus；否则 open/pending。
   */
  function evaluateTeamVote(vote) {
    const tally = teamVoteTally(vote);
    if (!tally.total) {
      return { ...tally, status: 'closed', result: 'no_consensus', reason: '没有可投票角色（除 PM 外）' };
    }
    if (tally.reject.length === tally.total) {
      return { ...tally, status: 'closed', result: 'rejected', reason: '除 PM 外全员一致驳回' };
    }
    const majority = Math.floor(tally.total / 2) + 1;
    if (tally.approve.length >= majority) {
      return { ...tally, status: 'closed', result: 'approved', reason: `赞成 ${tally.approve.length}/${tally.total} 过半` };
    }
    if (tally.cast.length === tally.total) {
      return { ...tally, status: 'closed', result: 'no_consensus', reason: '全部投完：既非全员一致驳回，也未过半赞成' };
    }
    return { ...tally, status: 'open', result: 'pending', reason: `已投 ${tally.cast.length}/${tally.total}` };
  }

  function teamVoteUiStatus(evaluation) {
    if (!evaluation || evaluation.status !== 'closed') return 'open';
    return evaluation.result === 'rejected' ? 'passed' : 'blocked';
  }

  function splitVoteComment(comment) {
    const text = String(comment == null ? '' : comment).trim();
    const match = text.match(/^([\s\S]*?)\n证据[：:]\s*([\s\S]*)$/);
    if (match) return { reason: match[1].trim(), evidence: match[2].trim() };
    return { reason: text, evidence: '' };
  }

  function teamVoteView(vote, requirementStatus = '') {
    const evaluation = evaluateTeamVote(vote);
    const status = teamVoteUiStatus(evaluation);
    const rawVotes = vote && vote.votes && typeof vote.votes === 'object' ? vote.votes : {};
    const casts = evaluation.eligible
      .filter((role) => rawVotes[role])
      .map((role) => {
        const cast = rawVotes[role] || {};
        const split = splitVoteComment(cast.comment);
        return {
          role,
          verdict: String(cast.vote || '').toLowerCase(),
          reason: split.reason,
          evidence: split.evidence,
          at: cast.at || null,
          sessionId: String(cast.sessionId || ''),
          revision: Number(cast.revision || 1)
        };
      });
    const decisionNote = evaluation.result === 'rejected'
      ? '除 PM 外全员一致驳回'
      : (evaluation.result === 'approved'
        ? `赞成 ${evaluation.approve.length}/${evaluation.total} 过半，未驳回`
        : (evaluation.result === 'no_consensus'
          ? '全部投完：既非全员一致驳回，也未过半赞成（no_consensus）'
          : `还差 ${evaluation.missing.length} 个角色投票`));
    return {
      id: String(vote.id || ''),
      project: String(vote.project || ''),
      requirementId: String(vote.requirementId || ''),
      teamMode: normalizeTeamMode(vote.teamMode),
      // 发起人只认 V 文件的归属字段，默认 analyst 与工作台默认入口一致；
      // createdByCommand 记录实际执行旧命令的角色（旧 team.mjs 只允许 PM 执行 vote start）。
      initiator: String(vote.initiator || vote.createdBy || 'analyst'),
      initiatorCommand: String(vote.createdByCommand || ''),
      initiatedAt: String(vote.initiatedAt || vote.createdAt || ''),
      reason: String(vote.subject || ''),
      evidence: String(vote.note || ''),
      status,
      result: evaluation.result,
      toolStatus: evaluation.status,
      decisionNote,
      eligibleRoles: evaluation.eligible.slice(),
      missingRoles: evaluation.missing.slice(),
      rejectedRoles: evaluation.reject.slice(),
      approvedRoles: evaluation.approve.slice(),
      counts: {
        eligible: evaluation.total,
        cast: evaluation.cast.length,
        reject: evaluation.reject.length,
        approve: evaluation.approve.length,
        abstain: evaluation.abstain.length,
        missing: evaluation.missing.length
      },
      casts,
      createdAt: vote.createdAt || null,
      updatedAt: vote.updatedAt || null,
      decidedAt: vote.closedAt || null,
      requirementStatus: String(requirementStatus || ''),
      rule: String(vote.rule || ''),
      source: '投票/V-*.json',
      file: String(vote.file || vote._file || '')
    };
  }

  function applyTeamVoteRejectionToState(state, vote, at) {
    const target = findStateRequirementRow(state, vote.requirementId);
    if (!target) return null;
    const row = target.row;
    if (['dev', 'dev_done', 'test', 'test_done', 'accepted', 'terminated', 'iteration'].includes(String(row.status || ''))) {
      return null;
    }
    const evaluation = evaluateTeamVote(vote);
    if (evaluation.status !== 'closed' || evaluation.result !== 'rejected') return null;
    const previous = String(row.status || '');
    row.status = 'rejected';
    row.queued = false;
    row.voteRejection = {
      voteId: String(vote.id || ''),
      status: 'rejected',
      result: 'rejected',
      reason: String(vote.subject || ''),
      evidence: String(vote.note || ''),
      counts: {
        eligible: evaluation.total,
        cast: evaluation.cast.length,
        reject: evaluation.reject.length,
        approve: evaluation.approve.length,
        abstain: evaluation.abstain.length,
        missing: evaluation.missing.length
      },
      rejectedRoles: evaluation.reject.slice(),
      at,
      by: 'vote',
      source: '投票/V-*.json'
    };
    row.updatedAt = at;
    pushHistoryOnce(row, { at, action: 'vote_rejected', by: 'vote', note: `投票驳回（${vote.subject || vote.id}）` }, {
      requirementId: vote.requirementId
    });
    if (['requirement', 'requirement_review', 'owner_review', 'tech_review', 'dispatch'].includes(String(state.phase || ''))) {
      // 投票驳回同样是“需求被驳回”：回到需求评审，不停在没有推进动作的 requirement。
      state.phase = REJECTED_REQUIREMENT_PHASE;
    }
    pushWorkflowEventOnce(state, {
      action: 'vote_rejected', role: 'pm', project: state.project, requirementId: vote.requirementId,
      note: `${vote.id} ${evaluation.reject.length}/${evaluation.total} reject${vote.subject ? '：' + String(vote.subject).slice(0, 80) : ''}（原状态 ${previous}）`
    });
    return row;
  }

  /**
   * 把团队工具 投票/ 目录里已经 closed=rejected 的结果同步进 工作流.json。
   * DSH 角色直接跑 vote cast 时工作台不会收到 IPC，这是唯一让需求真正驳回的入口。
   */
  function syncVoteRejectionsFromDisk(projectName, projectPath = '') {
    const name = String(projectName || '').trim();
    if (!name) return { ok: true, changed: [] };
    const records = readVoteRecords(name);
    if (!records.length) return { ok: true, changed: [], projectPath };
    const rejected = records
      .filter((vote) => vote && String(vote.requirementId || '').trim()
        && evaluateTeamVote(vote).status === 'closed'
        && evaluateTeamVote(vote).result === 'rejected')
      .sort((a, b) => String(a.createdAt || '').localeCompare(String(b.createdAt || '')));
    if (!rejected.length) return { ok: true, changed: [], projectPath };
    const read = readWorkflowState(name);
    if (!read.ok) return read;
    const closedStatuses = ['dev', 'dev_done', 'test', 'test_done', 'accepted', 'terminated', 'iteration', 'rejected'];
    const pending = rejected.filter((vote) => {
      const target = findStateRequirementRow(read.state, vote.requirementId);
      if (!target) return false;
      if (target.row.voteRejection && String(target.row.voteRejection.voteId) === String(vote.id)) return false;
      return !closedStatuses.includes(String(target.row.status || ''));
    });
    // 已经吸收过的票不再写盘：读快照/读投票必须是幂等的，不能每次刷新都改 updatedAt。
    if (!pending.length) return { ok: true, changed: [], projectPath };
    const changed = [];
    const written = mutateWorkflowState(name, (state) => {
      for (const vote of pending) {
        const at = vote.closedAt || vote.updatedAt || new Date().toISOString();
        const applied = applyTeamVoteRejectionToState(state, vote, at);
        if (applied) changed.push(String(vote.requirementId));
      }
    });
    return written.ok
      ? { ok: true, changed: [...new Set(changed)], file: written.file, projectPath }
      : { ...written, changed: [] };
  }

  /**
   * 把团队工具 技术评审/TR-*.json 里程序员A已经记录的结果同步进 工作流.json。
   * 只处理当前仍是 tech_review 的需求，且 TR 必须晚于本次 Owner 决定，避免旧 TR 回灌。
   */
  function syncTechReviewsFromDisk(projectName, projectPath = '') {
    const name = String(projectName || '').trim();
    if (!name) return { ok: true, changed: [] };
    const mode = normalizeTeamMode(readJsonSafe(path.join(projectStateDir(name), '项目.json'))?.teamMode);
    if (mode !== 'fast') return { ok: true, changed: [], projectPath };
    const allRecords = readReviewRecords(name, 'tech').filter((record) => record.kind === 'tech'
      && String(record.requirementId || '').trim()
      && (!record.teamMode || normalizeTeamMode(record.teamMode) === 'fast')
      && ['approve', 'reject'].includes(String(record.verdict || '').toLowerCase()));
    if (!allRecords.length) return { ok: true, changed: [], projectPath };
    // readReviewRecords 已按 ts 倒序：同一需求只认最新一条 TR，避免旧 TR 覆盖新结论。
    const latestByRequirement = new Map();
    for (const record of allRecords) {
      const key = String(record.requirementId);
      if (!latestByRequirement.has(key)) latestByRequirement.set(key, record);
    }
    const records = [...latestByRequirement.values()];
    const read = readWorkflowState(name);
    if (!read.ok) return read;
    const pending = records.filter((record) => {
      const target = findStateRequirementRow(read.state, record.requirementId);
      if (!target) return false;
      const row = target.row;
      if (String(row.status) !== 'tech_review') return false;
      if (row.techReview && String(row.techReview.trId || '') === String(record.id)) return false;
      const ownerAt = Date.parse(String(row.ownerReview && row.ownerReview.at || ''));
      const trAt = Date.parse(String(record.ts || record.createdAt || ''));
      return !(Number.isFinite(ownerAt) && Number.isFinite(trAt) && trAt < ownerAt);
    });
    if (!pending.length) return { ok: true, changed: [], projectPath };
    const changed = [];
    const written = mutateWorkflowState(name, (state) => {
      for (const record of pending) {
        const target = findStateRequirementRow(state, record.requirementId);
        if (!target) continue;
        const row = target.row;
        const verdict = String(record.verdict).toLowerCase();
        const at = record.ts || record.createdAt || new Date().toISOString();
        row.techReview = {
          verdict,
          by: String(record.role || 'programmer1'),
          role: String(record.role || 'programmer1'),
          teamMode: 'fast',
          comment: String(record.comments || ''),
          evidence: '',
          at,
          source: 'team.mjs req review --kind tech',
          trId: String(record.id),
          trFile: String(record.file || record._file || ''),
          tr: record
        };
        row.updatedAt = at;
        pushHistoryOnce(row, { at, action: 'tech_review', by: row.techReview.by, note: verdict }, {
          requirementId: record.requirementId
        });
        if (verdict === 'approve') {
          row.status = 'ready';
          state.phase = 'dispatch';
        } else {
          row.status = 'rejected';
          // 技术评审打回：回到需求评审，需求改完重新走同一套闸门。
          state.phase = REJECTED_REQUIREMENT_PHASE;
        }
        pushWorkflowEventOnce(state, {
          action: 'requirement_tech_review', role: row.techReview.by, project: name, requirementId: record.requirementId,
          note: `${verdict}（从 ${record.id} 读取）`
        });
        changed.push(String(record.requirementId));
      }
    });
    return written.ok
      ? { ok: true, changed: [...new Set(changed)], file: written.file, projectPath }
      : { ...written, changed: [] };
  }

  /**
   * Owner / 轮次推进的“壳层收口”能力矩阵。
   *
   * team.mjs 当前版本把 owner / workflow 两条命令明确标成 NOT_IMPLEMENTED。
   * Fast 模式早就按“动作可用、旧命令不存在”由壳层收口；Full 模式的 Owner 决定/验收、
   * 迭代/终止不能被同两条命令缺失卡死，也必须给出同样的壳层路径。
   *
   * 如实区分两件事，不伪造旧命令存在：
   *   - 动作可用：写进 shellOwnedActions（界面据此放行按钮）；
   *   - 旧命令存在：commands.* / legacyCommandAvailable.* 保持真实探测结果。
   * 旧命令真的存在时（升级后的 team.mjs）不接管，仍走旧协议。
   */
  function capabilitiesForProjectMode(caps, teamMode) {
    const base = caps && typeof caps === 'object' ? caps : legacyCapabilities();
    const mode = normalizeTeamMode(teamMode);
    const commands = { ...(base.commands || {}) };
    const ownerCommand = commands.owner === true;
    const workflowCommand = commands.workflow === true;
    // Fast 的 Owner 一直是壳层收口（历史契约）；Full 只在旧 owner 命令真缺失时收口。
    const shellOwner = mode === 'fast' ? true : !ownerCommand;
    // 迭代/终止：两种模式同一条规则——旧 workflow 命令缺失就由壳层推进。
    const shellWorkflow = !workflowCommand;
    if (!shellOwner && !shellWorkflow) return base;
    const ownerActions = shellOwner ? ['owner-review', 'owner-accept'] : [];
    const workflowActions = shellWorkflow ? ['iterate', 'terminate'] : [];
    const shellOwned = new Set(Array.isArray(base.shellOwned) ? base.shellOwned : []);
    const shellOwnedActions = new Set(Array.isArray(base.shellOwnedActions) ? base.shellOwnedActions : []);
    const actionSource = { ...(base.actionSource || {}) };
    const commandSource = { ...(base.commandSource || {}) };
    const legacyCommandAvailable = { ...(base.legacyCommandAvailable || {}) };
    if (shellOwner) {
      commands.owner = true;
      shellOwned.add('owner');
      for (const action of ownerActions) {
        shellOwnedActions.add(action);
        actionSource[action] = `workbench-${mode}-owner`;
      }
      commandSource.owner = `workbench-${mode}-owner`;
      legacyCommandAvailable.owner = false;
    }
    if (shellWorkflow) {
      for (const action of workflowActions) {
        shellOwnedActions.add(action);
        actionSource[action] = `workbench-${mode}-workflow`;
      }
      legacyCommandAvailable.workflow = false;
    }
    return {
      ...base,
      commands,
      missing: (Array.isArray(base.missing) ? base.missing : [])
        .filter((name) => !(shellOwner && name === 'owner')),
      optionalMissing: (Array.isArray(base.optionalMissing) ? base.optionalMissing : [])
        .filter((name) => !(shellOwner && name === 'owner')),
      shellOwned: [...shellOwned],
      shellOwnedCommands: shellOwner ? [...new Set([...(Array.isArray(base.shellOwnedCommands) ? base.shellOwnedCommands : []), 'owner'])] : [...(base.shellOwnedCommands || [])],
      shellOwnedActions: [...shellOwnedActions],
      actionSource,
      commandSource,
      legacyCommandAvailable
    };
  }

  /**
   * Fast 模式开发技术评审：Owner 之后、PM 派单之前，由高级程序员 A 判断实现可行性/风险。
   * 通过 → ready（可派单）；驳回 → rejected（退回需求，重新评审后再由 Owner 决定）。
   * Full 模式没有这个阶段，调用必须明确失败，不能悄悄放行。
   */
  async function techReviewRequirementForContext(ctx, input = {}, mode = DEFAULT_TEAM_MODE) {
    const teamMode = normalizeTeamMode(mode || ctx.teamMode);
    if (teamMode !== 'fast') {
      return failure('TECH_REVIEW_NOT_REQUIRED', '开发技术评审只在 Fast 模式存在；Full 模式保持 产品评审 + Owner', {
        teamMode, allowed: []
      });
    }
    const role = String(input.role || '').trim();
    if (role !== techReviewRole(teamMode)) {
      return failure('ROLE_NOT_ALLOWED', 'Fast 模式的开发技术评审只能由高级程序员 A 执行', {
        role, allowed: [techReviewRole(teamMode)]
      });
    }
    const requirementId = String(input.requirementId || input.id || '').trim();
    if (!requirementId) return failure('REQUIREMENT_REQUIRED', '缺少需求 id');
    const verdict = String(input.verdict || input.decision || '').toLowerCase();
    if (!['approve', 'reject'].includes(verdict)) return failure('BAD_VERDICT', '技术评审结论必须是 approve / reject');
    const comment = String(input.comment !== undefined ? input.comment : (input.comments || '')).trim();
    if (verdict === 'reject' && comment.length < 10) return failure('COMMENTS_REQUIRED', '技术评审打回必须写至少 10 字理由');
    const evidence = String(input.evidence || input.proof || '').slice(0, 2000);
    const imported = ensureLegacyRequirementRecord(ctx.name, ctx.projectPath, requirementId);
    if (!imported.ok) return imported;
    // 技术评审必须发生在 Owner 之后：先核验程序员自己的 boot 阅读证据。
    const gate = await ensureWorkflowBoot(ctx.name, ctx.projectPath, role, { requirementId });
    if (!gate.ok) return gate;
    const read = readWorkflowState(ctx.name);
    if (!read.ok) return read;
    const found = findStateRequirementRow(read.state, requirementId);
    if (!found) return failure('REQUIREMENT_NOT_FOUND', `工作流里没有需求 ${requirementId}`, { requirementId });
    const meta = found.row;
    if (!meta.productReview || meta.productReview.verdict !== 'approve') {
      return failure('PRODUCT_REVIEW_REQUIRED', `需求 ${requirementId} 还没有需求评审通过，不能做开发技术评审`, { requirementId });
    }
    if (!meta.ownerReview || !['approved', 'skipped'].includes(String(meta.ownerReview.status))) {
      return failure('OWNER_REVIEW_REQUIRED', `需求 ${requirementId} 的 Owner 闸门未通过/未跳过，不能做开发技术评审`, { requirementId });
    }
    if (String(meta.status) !== 'tech_review') {
      return failure('REQUIREMENT_STATE_INVALID', `需求 ${requirementId} 当前状态是 ${meta.status}，不在开发技术评审阶段`, {
        requirementId, status: meta.status, expected: 'tech_review'
      });
    }
    // 先确认旧命令真的存在，再调用；不能先写 工作流.json 再假报 commandAvailable。
    const commandGuard = requireLegacyCommand('req review');
    if (commandGuard) {
      return { ...commandGuard, project: ctx.name, projectPath: ctx.projectPath, teamMode };
    }
    // 技术评审记录必须由团队工具落 技术评审/TR-*.json；壳层随后读回并镜像进 工作流.json。
    const run = await runLegacyWorkflowProtocol('req review', {
      projectName: ctx.name,
      projectPath: ctx.projectPath,
      role,
      requirementId,
      verdict,
      comment,
      kind: 'tech',
      sessionId: String(input.sessionId || '').trim()
    });
    if (!run.ok) return run;
    const legacyRequirement = run.value && (run.value.requirement || run.value.task);
    const reviewRecord = run.value && run.value.review;
    if (!legacyRequirement || !legacyRequirement.id) {
      return failure('BAD_JSON', '旧 req review --kind tech 没有返回需求对象，拒绝把本次评审当作已发生', {
        command: 'req review', protocol: 'legacy', value: run.value
      });
    }
    if (String(legacyRequirement.id) !== requirementId) {
      return failure('BAD_JSON', `旧 req review --kind tech 返回了别的需求：${legacyRequirement.id} ≠ ${requirementId}`, {
        command: 'req review', protocol: 'legacy'
      });
    }
    if (!reviewRecord || !reviewRecord.id) {
      return failure('BAD_JSON', '旧 req review --kind tech 没有返回 TR 记录，拒绝把本次评审当作已发生', {
        command: 'req review', protocol: 'legacy', value: run.value
      });
    }
    if (String(reviewRecord.kind || '').toLowerCase() !== 'tech') {
      return failure('LEGACY_PROTOCOL_REQUIRED', '当前 team.mjs 的 req review 不接受 --kind tech：没有产出技术评审记录 TR-*.json；本工作台不会用本地状态伪造这一步', {
        command: 'req review',
        protocol: 'legacy',
        requiredKind: 'tech',
        returnedKind: reviewRecord.kind || null,
        argv: Array.isArray(run.argv) ? run.argv : [],
        capabilities: ctx.capabilities
      });
    }
    // 读回团队工具真正写下的文件；文件不存在就不能把 工作流.json 标成已评审。
    let trRecord = null;
    if (run.mocked) {
      trRecord = {
        ...reviewRecord,
        file: '',
        _file: ''
      };
    } else {
      trRecord = readReviewRecords(ctx.name, 'tech')
        .find((record) => String(record.id) === String(reviewRecord.id)) || null;
      if (!trRecord) {
        return failure('TECH_REVIEW_FILE_MISSING', `旧 req review --kind tech 返回了 ${reviewRecord.id}，但 技术评审/${reviewRecord.id}.json 不存在；拒绝把本次评审当作已发生`, {
          command: 'req review',
          protocol: 'legacy',
          requirementId,
          trId: String(reviewRecord.id),
          trDir: reviewRecordsDir(ctx.name, 'tech'),
          argv: Array.isArray(run.argv) ? run.argv : []
        });
      }
    }
    if (String(trRecord.requirementId || '') !== requirementId) {
      return failure('BAD_JSON', `技术评审文件 ${trRecord.id} 属于别的需求：${trRecord.requirementId} ≠ ${requirementId}`, {
        command: 'req review', protocol: 'legacy'
      });
    }
    if (String(trRecord.kind || '').toLowerCase() !== 'tech') {
      return failure('BAD_JSON', `技术评审文件 ${trRecord.id} 的 kind 不是 tech：${trRecord.kind || '(空)'}`, {
        command: 'req review', protocol: 'legacy'
      });
    }
    if (String(trRecord.role || '') !== role) {
      return failure('BAD_JSON', `技术评审文件 ${trRecord.id} 的评审人不是 ${role}：${trRecord.role || '(空)'}`, {
        command: 'req review', protocol: 'legacy'
      });
    }
    const at = trRecord.ts || reviewRecord.ts || new Date().toISOString();
    const techReview = {
      verdict,
      by: role,
      role,
      teamMode,
      comment: comment.slice(0, 600),
      evidence,
      at,
      source: 'team.mjs req review --kind tech',
      command: 'req review',
      kind: 'tech',
      trId: String(trRecord.id),
      trFile: String(trRecord.file || trRecord._file || ''),
      tr: trRecord
    };
    const techReviewSummary = {
      ...techReview,
      tr: undefined,
      evidence: evidence || trRecord.comments || ''
    };
    const written = mutateWorkflowState(ctx.name, (state) => {
      const target = findStateRequirementRow(state, requirementId);
      if (!target) throw new Error(`工作流里没有需求 ${requirementId}`);
      const row = target.row;
      row.techReview = techReview;
      row.updatedAt = at;
      pushHistoryOnce(row, { at, action: 'tech_review', by: role, note: verdict, trId: techReview.trId }, { requirementId });
      if (verdict === 'approve') {
        row.status = 'ready';
        state.phase = 'dispatch';
      } else {
        row.status = 'rejected';
        // 技术评审打回：回到需求评审，需求改完重新走同一套闸门。
        state.phase = REJECTED_REQUIREMENT_PHASE;
      }
      pushWorkflowEventOnce(state, {
        at, action: 'requirement_tech_review', role, project: ctx.name, requirementId,
        note: `${verdict}${comment ? '：' + comment.slice(0, 80) : ''}（${techReview.trId}）`
      });
    });
    if (!written.ok) return written;
    const patch = patchLegacyTask(ctx.name, imported.id || requirementId, {
      workflow: {
        requirementStatus: verdict === 'approve' ? 'ready' : 'rejected',
        techReview: techReviewSummary
      }
    });
    const statusSync = syncRequirementStatusArtifacts(
      ctx, requirementId, verdict === 'approve' ? 'ready' : 'rejected',
      `开发技术评审${verdict === 'approve' ? '通过' : '打回'}：${role}（${techReview.trId}）`
    );
    const snapshot = readWorkflowSnapshot(ctx.name, ctx.projectPath);
    return {
      ok: true,
      code: 'OK',
      protocol: 'legacy',
      driver: 'team.mjs req review --kind tech',
      legacyCommandStatus: run.mocked ? 'MOCKED' : 'AVAILABLE',
      teamMode,
      requirementId,
      verdict,
      techReview,
      trId: techReview.trId,
      trFile: techReview.trFile,
      tr: trRecord,
      requirement: snapshot.ok ? snapshot.requirements.find((row) => row.id === requirementId) : null,
      workflowFile: written.file,
      workflow: snapshot.ok ? snapshot.workflow : null,
      snapshot: snapshot.ok ? snapshot : null,
      statusSync,
      warnings: [
        ...(Array.isArray(run.value && run.value.warnings) ? run.value.warnings : []),
        ...statusSync.warnings
      ],
      legacy: {
        command: 'req review',
        kind: 'tech',
        // 这里必须是真实可用性：只有上面真的调用了旧命令并读回 TR 才为 true。
        commandAvailable: true,
        commandImplemented: !run.mocked,
        argv: Array.isArray(run.argv) ? run.argv : [],
        mocked: Boolean(run.mocked),
        trId: techReview.trId,
        trFile: techReview.trFile,
        missingCommands: ctx.capabilities ? ctx.capabilities.missing : [],
        taskPatch: patch.ok ? { ok: true } : { ok: false, code: patch.code, message: patch.message }
      }
    };
  }

  /** 外部入口：Fast 开发技术评审；内部复用已解析的 ctx。 */
  async function techReviewRequirement(input = {}) {
    const ctx = await ensureWorkflowProject(input);
    if (!ctx.ok) return ctx;
    return techReviewRequirementForContext(ctx, input, input.teamMode || ctx.teamMode);
  }

  async function ownerRequirementDecision(input = {}) {
    const ctx = await ensureWorkflowProject(input);
    if (!ctx.ok) return ctx;
    const mode = normalizeTeamMode(input.teamMode || ctx.teamMode);
    const reviewRole = requirementReviewRole(mode);
    const role = String(input.role || '').trim();
    if (role !== 'owner') {
      return failure('ROLE_NOT_ALLOWED', 'Owner 参与/跳过/打回只能由 Owner 执行；PM 不能代做', { role, allowed: ['owner'] });
    }
    const decision = String(input.decision || input.status || '').trim();
    if (!['approved', 'skipped', 'rejected'].includes(decision)) {
      return failure('OWNER_DECISION_INVALID', 'Owner 决定必须是 approved / skipped / rejected', { decision });
    }
    const requirementId = String(input.requirementId || input.id || '').trim();
    if (!requirementId) return failure('REQUIREMENT_REQUIRED', '缺少需求 id');
    // team.mjs 当前版本明确不实现 owner（NOT_IMPLEMENTED）。Owner 决定本来就是壳层工作流
    // 的一部分：Fast / Full 都一样，缺旧 owner 命令时由壳层写 工作流.json 并标 OWNER_SHELL_OWNED。
    // 只有旧命令真的存在（升级后的 team.mjs）才走旧协议，不用本地假状态冒充旧命令执行。
    const caps = legacyCapabilities();
    const legacyOwnerAvailable = Boolean(caps.available && caps.commands && caps.commands.owner);
    const shellOwnedOwner = !legacyOwnerAvailable;
    // 只有正文的旧需求没有任务/工作流行：先补兼容记录，Owner 决定才能落到旧协议。
    const imported = ensureLegacyRequirementRecord(ctx.name, ctx.projectPath, requirementId);
    if (!imported.ok) return imported;
    // Owner 是外部角色，没有自己的 boot；Owner 闸门以产品评审人的完整阅读为前提：
    // 产品没有 boot/读全需求，就不允许把需求推到 Owner 或直接放行。
    const read = readWorkflowState(ctx.name);
    if (!read.ok) return read;
    const found = findStateRequirementRow(read.state, requirementId);
    if (!found) return failure('REQUIREMENT_NOT_FOUND', `工作流里没有需求 ${requirementId}`, { requirementId });
    const meta = found.row;
    if (!meta.productReview || meta.productReview.verdict !== 'approve') {
      return failure('PRODUCT_REVIEW_REQUIRED', `需求 ${requirementId} 还没有需求评审通过（${mode === 'fast' ? '需求分析师' : '产品设计师'}），Owner 不能跳过评审闸门`, {
        requirementId, teamMode: mode, reviewRole
      });
    }
    if (!['approved', 'rejected', 'review'].includes(String(meta.status))) {
      return failure('REQUIREMENT_STATE_INVALID', `需求 ${requirementId} 当前状态是 ${meta.status}，不能做 Owner 决定`, {
        requirementId, status: meta.status
      });
    }
    // Owner 决定以“当前模式的评审人已完整阅读需求”为前提：Fast=analyst，Full=product。
    const gate = await ensureWorkflowBoot(ctx.name, ctx.projectPath, reviewRole, {
      requirementId,
      allowRequirementChanged: true
    });
    if (!gate.ok) return gate;
    const opinion = String(input.opinion || '').slice(0, 1000);
    let run = null;
    let legacyRequirement = null;
    if (!shellOwnedOwner) {
      let ownerConfirmNonce = String(input.ownerConfirmNonce || '').trim();
      if (!ownerConfirmNonce && input.ownerConfirmed === true) {
        const confirmation = await issueLegacyOwnerConfirmation({
          projectName: ctx.name, requirementId, decision, action: ''
        });
        if (!confirmation.ok) return confirmation;
        ownerConfirmNonce = confirmation.nonce;
      }
      run = await runLegacyWorkflowProtocol('owner', {
        projectName: ctx.name,
        projectPath: ctx.projectPath,
        requirementId,
        decision,
        opinion,
        role,
        ownerConfirmNonce
      });
      if (!run.ok) return run;
      legacyRequirement = run.value && (run.value.requirement || run.value.task);
      if (!legacyRequirement || !legacyRequirement.id) {
        return failure('BAD_JSON', '旧 owner 命令没有返回需求对象，拒绝把本次决定当作已发生', {
          command: 'owner', protocol: 'legacy', value: run.value
        });
      }
      if (String(legacyRequirement.id) !== requirementId) {
        return failure('BAD_JSON', `旧 owner 命令返回了别的需求：${legacyRequirement.id} ≠ ${requirementId}`, {
          command: 'owner', protocol: 'legacy'
        });
      }
    }
    const at = new Date().toISOString();
    const runValue = run ? run.value : null;
    const roundKey = `${ctx.name}|${read.state.round}|${Object.keys(read.state.requirements).length}`;
    // 旧 owner 命令已写入 actor/confirmation/channel；壳只补缺失字段，不能把认证信息覆盖掉。
    // 旧命令可能把 ownerReview 放在 requirement.workflow、顶层 ownerReview 或工作流.json。
    const legacyOwnerReview = mergePlainObjects(
      legacyRequirement && legacyRequirement.ownerReview,
      legacyRequirement && legacyRequirement.workflow && legacyRequirement.workflow.ownerReview
    );
    const legacyTopOwnerReview = runValue && runValue.ownerReview;
    // Owner 通道只允许 ui/tty：来源依次取调用方、旧命令返回、已有记录；都没有就拒绝，
    // 不再静默回退旧通道名，避免决定的审计通道失真。
    const ownerChannelCandidates = [
      String(input.channel || ''),
      String((runValue && (runValue.channel || (runValue.ownerReview && runValue.ownerReview.channel))) || ''),
      String((legacyOwnerReview && legacyOwnerReview.channel) || (legacyTopOwnerReview && legacyTopOwnerReview.channel) || ''),
      String((meta.ownerReview && meta.ownerReview.channel) || (read.state.ownerReview && read.state.ownerReview.channel) || '')
    ];
    const ownerChannel = ownerChannelCandidates.find((candidate) => ['ui', 'tty'].includes(candidate));
    if (!ownerChannel) {
      return failure('OWNER_CHANNEL_REQUIRED', 'Owner 决定必须显式携带 channel=ui 或 tty，不再回退旧通道', { requirementId });
    }
    const written = mutateWorkflowState(ctx.name, (state) => {
      const target = findStateRequirementRow(state, requirementId);
      if (!target) throw new Error(`工作流里没有需求 ${requirementId}`);
      const row = target.row;
      const previousStateOwnerReview = isPlainObject(state.ownerReview) ? state.ownerReview : null;
      const mergedRowReview = mergePlainObjects(row.ownerReview, legacyOwnerReview);
      const mergedStateReview = mergePlainObjects(
        row.ownerReview,
        previousStateOwnerReview,
        legacyOwnerReview,
        legacyTopOwnerReview
      );
      const auth = mergeOwnerAuthFields(
        row.ownerReview,
        previousStateOwnerReview,
        legacyOwnerReview,
        legacyTopOwnerReview,
        runValue
      );
      // Owner 确认码已废弃：UI 不再要求 challenge/nonce，决定直接以 role=owner 接受。
      // 通道已在 mutate 之前校验为 ui/tty（ownerChannel）；这里只落库，不再做任何回退。
      auth.channel = ownerChannel;
      auth.actor = auth.actor || 'owner';
      auth.at = auth.at || at;
      row.ownerReview = {
        ...mergedRowReview,
        ...auth,
        status: decision,
        by: 'Owner',
        actor: auth.actor || 'owner',
        at,
        opinion,
        source: shellOwnedOwner ? `workbench-${mode}-owner` : 'team.mjs owner',
        command: shellOwnedOwner ? 'workbench' : 'owner'
      };
      row.updatedAt = at;
      pushHistoryOnce(row, { at, action: 'owner_review', by: 'Owner', note: decision }, {
        requirementId
      });
      row.teamMode = mode;
      if (decision === 'rejected') {
        row.status = 'rejected';
        // Owner 打回：需求回到需求评审（修改后重评，再走 Owner 闸门），不停在 requirement。
        state.phase = REJECTED_REQUIREMENT_PHASE;
      } else if (mode === 'fast') {
        // Fast：Owner 通过后先进入开发技术评审，技术评审通过才 ready 可派单。
        row.status = 'tech_review';
        state.phase = 'tech_review';
      } else {
        row.status = 'ready';
        state.phase = 'dispatch';
      }
      state.ownerReview = {
        ...mergedStateReview,
        ...auth,
        required: true,
        status: decision,
        kind: 'requirement',
        by: 'Owner',
        actor: auth.actor || 'owner',
        at,
        opinion,
        roundKey,
        command: 'owner'
      };
      pushWorkflowEventOnce(state, {
        at, action: 'owner_requirement', role: 'owner', project: ctx.name, requirementId,
        note: `${decision}${opinion ? '：' + opinion.slice(0, 80) : ''}`
      });
    });
    if (!written.ok) return written;
    // 壳层收口时同步需求正文/总览/任务状态，避免界面显示已进入技术评审、文档仍停在 approved。
    const statusSync = shellOwnedOwner
      ? syncRequirementStatusArtifacts(
        ctx,
        requirementId,
        decision === 'rejected' ? 'rejected' : (mode === 'fast' ? 'tech_review' : 'ready'),
        `Owner 决定${decision}${opinion ? '：' + opinion.slice(0, 80) : ''}`
      )
      : null;
    const projectIndex = await refreshProjectIndex(ctx.name, ctx.projectPath);
    const indexWarning = projectIndexWarning(projectIndex);
    const snapshot = readWorkflowSnapshot(ctx.name, ctx.projectPath);
    return {
      ok: true,
      // Fast Owner 是壳层收口：动作成功不是旧 owner 命令成功，必须给出明确 code，
      // 不能继续用 OK 让上游误以为是 team.mjs owner 执行。
      code: shellOwnedOwner ? 'OWNER_SHELL_OWNED' : 'OK',
      protocol: 'legacy',
      driver: shellOwnedOwner ? 'workbench owner' : 'team.mjs owner',
      legacyCommandStatus: shellOwnedOwner ? 'SHELL_OWNED' : 'AVAILABLE',
      shellOwned: shellOwnedOwner,
      fallback: null,
      teamMode: mode,
      reviewRole,
      requirement: snapshot.ok ? snapshot.requirements.find((row) => row.id === requirementId) : null,
      decision,
      ownerReview: snapshot.ok ? snapshot.ownerReview : null,
      ownerNote: runValue && runValue.message ? runValue.message : null,
      workflowFile: written.file,
      workflow: snapshot.ok ? snapshot.workflow : null,
      snapshot: snapshot.ok ? snapshot : null,
      projectIndex,
      warnings: [
        ...(Array.isArray(runValue && runValue.warnings) ? runValue.warnings : []),
        ...((statusSync && Array.isArray(statusSync.warnings)) ? statusSync.warnings : []),
        ...(indexWarning ? [indexWarning] : [])
      ],
      statusSync,
      legacy: {
        command: 'owner',
        // 对界面而言这个动作可用（Fast 由壳层执行），但旧命令本身仍不存在：
        // shellOwned/commandImplemented 如实区分“动作可用”和“旧命令存在”。
        commandAvailable: true,
        commandImplemented: !shellOwnedOwner,
        legacyCommandAvailable: !shellOwnedOwner,
        shellOwned: shellOwnedOwner,
        code: shellOwnedOwner ? 'OWNER_SHELL_OWNED' : 'OK',
        argv: run && Array.isArray(run.argv) ? run.argv : [],
        mocked: Boolean(run && run.mocked),
        missingCommands: (ctx.capabilities.missing || []).filter((name) => !(shellOwnedOwner && name === 'owner'))
      }
    };
  }

  /**
   * B-fe22：评审弹窗「通过/打回」必须落到需求行，不能只改项目级 ownerReview。
   * owner:decide 负责项目级落账与 PM 通知；这里补需求级：row.ownerReview/status/phase/history，
   * 并支持 ui / proxy / skip_committee 三种通道（弹窗、代管、三方共决共用同一入口）。
   * 不做产品评审/boot 闸门：弹窗只展示已过产品评审的待决需求，Owner 是最终决策人；
   * 打回理由必填在 owner:decide 入口校验，避免静默丢理由。
   */
  async function applyOwnerDecisionToRequirement(input = {}) {
    const name = String((input.project && (input.project.teamName || input.project.name)) || input.projectName || '').trim();
    if (!name) return failure('PROJECT_REQUIRED', '缺少团队项目名');
    const requirementId = String(input.requirementId || '').trim();
    if (!requirementId) return failure('REQUIREMENT_REQUIRED', '缺少需求 id（弹窗决定必须指向具体需求）');
    const status = String(input.status || input.decision || '');
    if (!['approved', 'rejected', 'skipped'].includes(status)) {
      return failure('OWNER_DECISION_INVALID', 'Owner 决定必须是 approved / rejected / skipped', { status });
    }
    const channel = String(input.channel || '');
    if (!['ui', 'tty', 'proxy', 'skip_committee'].includes(channel)) {
      return failure('OWNER_CHANNEL_REQUIRED', 'Owner 决定必须显式带 channel=ui/tty（代管用 proxy、三方共决跳过用 skip_committee）');
    }
    if (status === 'rejected' && !String(input.opinion || '').trim()) {
      return failure('OWNER_OPINION_REQUIRED', '打回必须写理由：说明哪不行、要怎么改');
    }
    const read = readWorkflowState(name);
    if (!read.ok) return read;
    const mode = normalizeTeamMode(input.teamMode || (readJsonSafe(path.join(projectStateDir(name), '项目.json')) || {}).teamMode);
    const at = new Date().toISOString();
    const opinion = String(input.opinion || '').slice(0, 1000);
    const roundKey = String(input.roundKey || `${name}|${read.state.round}|${Object.keys(read.state.requirements || {}).length}`);
    // B-2ed9：服务端按「需求 + 本轮 + 同状态」去重——重复点同一条只落 1 条决定；
    // 不同状态（如通过后打回）仍然允许，append-only。
    const existingTarget = findStateRequirementRow(read.state, requirementId);
    const existingDecisions = existingTarget && Array.isArray(existingTarget.row.decisions) ? existingTarget.row.decisions : [];
    const rowRound = Number((existingTarget && existingTarget.row.round) || 1);
    if (existingDecisions.some((d) => d
      && String(d.status || d.decision || '') === status
      && Number(d.round || rowRound) === rowRound)) {
      return failure('DUPLICATE_DECISION', `需求 ${requirementId} 本轮已有相同决定（${status}），不重复落账`, {
        requirementId, status, round: rowRound,
      });
    }
    const auth = {
      channel,
      actor: 'owner',
      decidedBy: 'owner',
      by: 'Owner',
      at,
      roundKey,
      opinion,
      ...(input.recordedBy ? { recordedBy: String(input.recordedBy) } : {}),
      ...(input.proxy ? { proxy: String(input.proxy) } : {}),
      ...(input.authorization ? { authorization: String(input.authorization) } : {}),
      ...(input.committee ? { committee: input.committee } : {}),
    };
    const written = mutateWorkflowState(name, (state) => {
      const target = findStateRequirementRow(state, requirementId);
      if (!target) throw new Error(`工作流里没有需求 ${requirementId}`);
      const row = target.row;
      const previousRowReview = isPlainObject(row.ownerReview) ? row.ownerReview : {};
      const previousStateReview = isPlainObject(state.ownerReview) ? state.ownerReview : {};
      // B-a08e：决定写到「需求行顶层 decisions[]」（闸门/弹窗读这里）；
      // ownerReview 只保留最新摘要，不再塞 decisions 数组（旧 nested 数据顺手并到顶层，幂等）。
      const decisionKey = (d) => `${String(d && d.at || '')}|${String(d && (d.status || d.decision) || '')}|${String(d && d.channel || '')}`;
      const nestedLegacy = Array.isArray(previousRowReview.decisions) ? previousRowReview.decisions.filter(Boolean) : [];
      const topLevel = Array.isArray(row.decisions) ? row.decisions.filter(Boolean) : [];
      const mergedDecisions = [];
      const seenDecision = new Set();
      for (const row0 of [...topLevel, ...nestedLegacy]) {
        const key = decisionKey(row0);
        if (seenDecision.has(key)) continue;
        seenDecision.add(key);
        mergedDecisions.push(row0);
      }
      const previousRowDecisions = mergedDecisions.slice(-99);
      const decisionRecord = {
        status,
        decision: status,
        channel,
        decidedBy: 'owner',
        actor: 'owner',
        by: 'Owner',
        at,
        round: Number(row.round || 1),
        roundKey,
        opinion,
        ...(input.recordedBy ? { recordedBy: String(input.recordedBy) } : {}),
        ...(input.proxy ? { proxy: String(input.proxy) } : {}),
        ...(input.authorization ? { authorization: String(input.authorization) } : {}),
        ...(input.committee ? { committee: input.committee } : {}),
      };
      row.decisions = [...previousRowDecisions, decisionRecord];
      row.ownerReview = { ...previousRowReview, ...auth, status, source: 'workbench-dialog', command: 'owner' };
      delete row.ownerReview.decisions;
      row.updatedAt = at;
      pushHistoryOnce(row, {
        at,
        action: 'owner_review',
        by: 'Owner',
        note: `${status}${opinion ? '：' + opinion.slice(0, 80) : ''}`,
      }, { requirementId });
      row.teamMode = mode;
      if (status === 'rejected') {
        row.status = 'rejected';
        state.phase = REJECTED_REQUIREMENT_PHASE;
      } else if (mode === 'fast') {
        row.status = 'tech_review';
        state.phase = 'tech_review';
      } else {
        row.status = 'ready';
        state.phase = 'dispatch';
      }
      state.ownerReview = {
        ...previousStateReview,
        ...auth,
        required: true,
        status,
        kind: 'requirement',
        requirementId,
      };
      pushWorkflowEventOnce(state, {
        at,
        action: 'owner_requirement',
        role: 'owner',
        project: name,
        requirementId,
        note: `${status}${opinion ? '：' + opinion.slice(0, 80) : ''}`,
      });
    });
    if (!written.ok) return written;
    const projectPath = String((input.project && input.project.path) || (registrationFor(name) || {}).path || '');
    const projectIndex = await refreshProjectIndex(name, projectPath);
    const indexWarning = projectIndexWarning(projectIndex);
    return {
      ok: true,
      code: 'OK',
      name,
      requirementId,
      status,
      channel,
      file: written.file,
      workflow: written.state || null,
      projectIndex,
      warnings: indexWarning ? [indexWarning] : [],
    };
  }

  /** Owner 新需求：由 PM 代办旧 req create，标记 origin=owner 并排到下一轮。 */
  async function createOwnerRequirement(input = {}) {
    return createRequirement({ ...input, role: 'pm', origin: 'owner' });
  }

  /**
   * owner:demand：Owner 只提需求（描述、优先级、验收标准[]），不自己建档。
   * PM 自动 boot 后代办旧 req create 生成 R- 需求：
   *   - 本轮没有在办需求 → 直接进入产品评审（requirement_review）；
   *   - 迭代/在办期间的新需求 → 排入下一轮队列，迭代时转正。
   * 产品评审未通过不得派单（dispatchRequirement 的产品闸门兜底）。
   * 需求原文与跟进责任记录进 ownerRequests，PM 负责分发跟进。
   */
  async function ownerDemand(input = {}) {
    const ctx = await ensureWorkflowProject(input);
    if (!ctx.ok) return ctx;
    const description = String(input.description || input.title || '').trim();
    const priority = String(input.priority || 'P2').trim().toUpperCase();
    const criteria = Array.isArray(input.acceptanceCriteria)
      ? input.acceptanceCriteria.map((row) => String(row == null ? '' : row).trim()).filter(Boolean)
      : (String(input.acceptanceCriteria || input.acceptance || '').trim()
        ? [String(input.acceptanceCriteria || input.acceptance).trim()]
        : []);
    if (!description) return failure('DESCRIPTION_REQUIRED', 'Owner 提需求必须写描述（description）');
    if (!criteria.length) return failure('ACCEPTANCE_REQUIRED', 'Owner 提需求必须先写验收标准[]（acceptanceCriteria）');
    if (!['P0', 'P1', 'P2', 'P3'].includes(priority)) return failure('BAD_PRIORITY', '优先级必须是 P0/P1/P2/P3', { priority });
    const before = readWorkflowState(ctx.name);
    if (before.ok && String(before.state.phase) === 'terminated') {
      return failure('WORKFLOW_TERMINATED', `项目「${ctx.name}」工作流已终止，不能再提需求；请先开启新一轮或新建项目`, {
        project: ctx.name, phase: 'terminated'
      });
    }
    // PM 自动 boot：PM 没 boot 不允许代办建档（boot 失败就整单失败，不降级成“Owner 自己建需求”）。
    const demandMode = normalizeTeamMode(input.teamMode || ctx.teamMode);
    const pmBoot = await bootRole(ctx.name, 'pm', { projectPath: ctx.projectPath, teamMode: demandMode });
    if (!pmBoot.ok) {
      return failure(pmBoot.code || 'PM_BOOT_REQUIRED', `PM 自动 boot 失败，Owner 需求不能由 PM 代办：${String(pmBoot.message || '').slice(0, 300)}`, {
        project: ctx.name, boot: { ok: false, code: pmBoot.code || 'PM_BOOT_REQUIRED' }
      });
    }
    const acceptance = criteria.map((row, index) => `${index + 1}. ${row}`).join('\n');
    const created = await createRequirement({
      ...input,
      projectName: ctx.name,
      projectPath: ctx.projectPath,
      role: 'pm',
      origin: 'owner',
      demandRoundMode: 'auto',
      title: description,
      acceptance,
      priority,
      story: String(input.story || `Owner 需求：${description}`).slice(0, 1500),
      detail: String(input.detail || '').slice(0, 2000)
    });
    if (!created.ok) return created;
    const demandRecord = {
      at: new Date().toISOString(),
      description,
      priority,
      acceptanceCriteria: criteria,
      requirementId: String(created.requirement && created.requirement.id || ''),
      queued: Boolean(created.requirement && created.requirement.queued),
      round: Number(created.requirement && created.requirement.round || 1)
    };
    const recorded = mutateWorkflowState(ctx.name, (state) => {
      state.ownerRequests = Array.isArray(state.ownerRequests) ? state.ownerRequests : [];
      state.ownerRequests.push(demandRecord);
      if (state.ownerRequests.length > 200) state.ownerRequests = state.ownerRequests.slice(-200);
      pushWorkflowEventOnce(state, {
        action: 'owner_demand', role: 'owner', project: ctx.name,
        requirementId: demandRecord.requirementId,
        note: `${priority} ${description}${demandRecord.queued ? `（排队到第 ${demandRecord.round} 轮）` : (demandMode === 'fast' ? '（进入需求分析师评审）' : '（进入产品评审）')}`
      });
    });
    const snapshot = readWorkflowSnapshot(ctx.name, ctx.projectPath);
    return {
      ...created,
      demand: demandRecord,
      pmBoot: { ok: true, role: 'pm', complete: Boolean(pmBoot.bootRead && pmBoot.bootRead.complete) },
      ownerRequestsRecorded: recorded.ok,
      followUp: {
        by: 'pm',
        note: demandRecord.queued
          ? `需求 ${demandRecord.requirementId} 已由 PM 建档并排队到第 ${demandRecord.round} 轮；迭代转正后先过${demandMode === 'fast' ? '需求分析师评审 + 开发技术评审' : '产品评审'}，未通过不得派单。`
          : `需求 ${demandRecord.requirementId} 已由 PM 建档并进入${demandMode === 'fast' ? '需求分析师评审（Owner 通过后还有开发技术评审）' : '产品评审'}；评审通过 + Owner 闸门通过后 PM 才能派单。`
      },
      workflow: snapshot.ok ? snapshot.workflow : null,
      snapshot: snapshot.ok ? snapshot : null
    };
  }

  // ==========================================================================
  // 投票：驳回 Owner 需求
  //
  //   vote:start  发起人只能是需求分析师（analyst）
  //   vote:cast   除 PM 外，当前团队模式的所有角色必须一致 reject，才驳回 Owner 需求
  //   vote:status 只读查询（票、逐角色理由/证据、缺票角色）
  //
  // 投票状态写在 工作流.json 的 votes{}（与需求同一份真相），不另造文件。
  // Full/Fast 通用：可投票角色 = 当前模式 roleIds - pm；Full 5 人，Fast 3 人。
  // ==========================================================================
  function normalizeVoteEvidence(value) {
    if (Array.isArray(value)) {
      return value.map((row) => String(row == null ? '' : row).trim()).filter(Boolean).join('\n').slice(0, 4000);
    }
    return String(value == null ? '' : value).trim().slice(0, 4000);
  }

  function isOwnerRequirement(state, row) {
    if (!row || typeof row !== 'object') return false;
    if (String(row.origin || '') === 'owner' || String(row.createdBy || '') === 'owner') return true;
    return (Array.isArray(state && state.ownerRequests) ? state.ownerRequests : [])
      .some((item) => String(item && item.requirementId || '') === String(row.id || ''));
  }

  function findVoteById(projectName, voteId) {
    return readVoteRecords(projectName).find((vote) => String(vote.id) === String(voteId)) || null;
  }

  /**
   * 投票写命令唯一入口：一律走 team.mjs vote start/cast。
   * 不手写 V-*.json，不把票写进 工作流.json；令牌由团队工具 boot 签发。
   */
  async function runTeamVoteCommand(projectName, role, subcommand, args = [], options = {}) {
    const guard = requireLegacyCommand('vote');
    if (guard) return guard;
    const sessionId = String(options.sessionId || '').trim();
    return withBootToken(projectName, role, async (token) => {
      const argv = ['vote', subcommand, '--boot', token, ...args, '--json'];
      const run = await runNode(layout.teamTool, argv, {
        timeoutMs: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : TIMEOUTS.send
      });
      const publicArgv = publicLegacyArgs(argv);
      if (!run.ok) return { ...classifyLegacyRun(run, 'vote ' + subcommand), argv: publicArgv };
      const value = run.value || {};
      if (value.ok === false) {
        return failure(value.code || 'VOTE_COMMAND_FAILED', String(value.message || `团队工具 vote ${subcommand} 失败`).slice(0, 400), {
          command: 'vote ' + subcommand,
          protocol: 'legacy',
          details: value.details && typeof value.details === 'object' ? value.details : {},
          argv: publicArgv
        });
      }
      return { ok: true, code: 'OK', command: 'vote ' + subcommand, value, argv: publicArgv, tokenUsed: token };
    }, sessionId);
  }

  /**
   * 发起驳回 Owner 需求投票。
   * 写入真相是 team.mjs 的 投票/V-*.json（eligible=当前模式角色-PM，Fast 3 人 / Full 5 人）。
   * 兼容旧界面：role=analyst 时由壳层先以 PM 发起（团队工具只允许 PM 发起），
   * 再以 analyst 身份补一票 reject（旧界面“发起即表态”的语义）。
   */
  async function startVote(input = {}) {
    const ctx = await ensureWorkflowProject(input);
    if (!ctx.ok) return ctx;
    const teamMode = normalizeTeamMode(input.teamMode || ctx.teamMode);
    const requestedBy = String(input.role || 'analyst').trim();
    if (!['pm', 'analyst'].includes(requestedBy)) {
      return failure('ROLE_NOT_ALLOWED', '投票发起人必须是 PM；analyst 是旧界面的兼容入口', {
        role: requestedBy, allowed: ['pm', 'analyst'], teamMode
      });
    }
    const requirementId = String(input.requirementId || input.id || '').trim();
    if (!requirementId) return failure('REQUIREMENT_REQUIRED', '缺少需求 id');
    const reason = String(input.reason || input.comment || '').trim().slice(0, 1000);
    const evidence = normalizeVoteEvidence(input.evidence || input.proof || input.evidenceList);
    if (!reason && !evidence) {
      return failure('VOTE_REASON_REQUIRED', '发起投票必须写理由或证据，不能空票', { requirementId });
    }
    const imported = ensureLegacyRequirementRecord(ctx.name, ctx.projectPath, requirementId);
    if (!imported.ok) return imported;
    const read = readWorkflowState(ctx.name);
    if (!read.ok) return read;
    const found = findStateRequirementRow(read.state, requirementId);
    if (!found) return failure('REQUIREMENT_NOT_FOUND', `工作流里没有需求 ${requirementId}`, { requirementId });
    const row = found.row;
    if (!isOwnerRequirement(read.state, row)) {
      return failure('VOTE_NOT_OWNER_REQUIREMENT', `需求 ${requirementId} 不是 Owner 需求；投票只用于驳回 Owner 需求`, {
        requirementId, origin: row.origin || null, createdBy: row.createdBy || null
      });
    }
    if (['dev', 'dev_done', 'test', 'test_done', 'accepted', 'terminated', 'iteration'].includes(String(row.status))) {
      return failure('VOTE_TOO_LATE', `需求 ${requirementId} 当前状态是 ${row.status}，已进入开发/收口，不能再投票驳回`, {
        requirementId, status: row.status
      });
    }
    const previousVotes = readVoteRecords(ctx.name)
      .filter((vote) => String(vote.requirementId || '') === requirementId);
    const openVote = previousVotes.find((vote) => evaluateTeamVote(vote).status === 'open');
    if (openVote) {
      return {
        ok: true, code: 'OK', reused: true, teamMode,
        vote: teamVoteView(openVote, row.status),
        votes: previousVotes.map((vote) => teamVoteView(vote, row.status)),
        requirement: requirementView(found.task, row),
        voteFile: openVote.file,
        votesDir: votesDir(ctx.name),
        workflowFile: read.file,
        legacy: { command: 'vote start', commandAvailable: true, reused: true, argv: [] }
      };
    }
    const alreadyRejected = previousVotes.find((vote) => evaluateTeamVote(vote).result === 'rejected');
    if (alreadyRejected) {
      return failure('VOTE_ALREADY_DECIDED', `需求 ${requirementId} 已被投票驳回，不能重复发起`, {
        requirementId, voteId: alreadyRejected.id
      });
    }
    const subject = (reason || `驳回 Owner 需求：${requirementId}`).slice(0, 200);
    const note = evidence ? evidence.slice(0, 300) : '';
    const run = await runTeamVoteCommand(ctx.name, 'pm', 'start', [
      '--subject', subject,
      '--kind', 'requirement',
      '--requirement', requirementId,
      ...(note ? ['--note', note] : [])
    ], { sessionId: input.sessionId });
    if (!run.ok) return { ...run, project: ctx.name, projectPath: ctx.projectPath };
    let stored = run.value && run.value.vote && run.value.vote.id
      ? findVoteById(ctx.name, run.value.vote.id) : null;
    if (!stored) {
      return failure('VOTE_FILE_MISSING', '团队工具 vote start 没有落下可以读取的 投票/V-*.json；拒绝把本次发起当作已发生', {
        command: 'vote start',
        votesDir: votesDir(ctx.name),
        value: run.value
      });
    }
    // 旧 team.mjs 的 vote start 只接受 PM 执行，V 文件里的 createdBy 会被写成 pm。
    // 工作台按实际发起人（requestedBy，默认 analyst）改写归属字段：UI/状态都读 V 文件，
    // 两边必须是同一个发起人；旧命令执行者另存 createdByCommand，不伪造执行主体。
    const stamped = stampVoteInitiator(ctx.name, stored, requestedBy);
    if (stamped.ok && stamped.vote) stored = stamped.vote;
    // 旧界面把“发起”视为 analyst 投驳回；只有 analyst 兼容入口才补这一票。
    // 先落归属再投票：team.mjs vote cast 会重写 V-*.json 与 V-*.md，派生视图因此也回到 analyst。
    let initiatorCast = null;
    if (requestedBy === 'analyst') {
      const comment = [reason, evidence ? `证据：${evidence}` : ''].filter(Boolean).join('\n').slice(0, 600);
      const castRun = await runTeamVoteCommand(ctx.name, 'analyst', 'cast', [
        '--id', stored.id,
        '--vote', 'reject',
        ...(comment ? ['--comment', comment] : [])
      ], { sessionId: input.sessionId });
      if (castRun.ok) {
        initiatorCast = { ok: true };
        stored = findVoteById(ctx.name, stored.id) || stored;
      } else {
        initiatorCast = { ok: false, code: castRun.code, message: castRun.message };
      }
    }
    const reconciled = syncVoteRejectionsFromDisk(ctx.name, ctx.projectPath);
    const statusSync = reconciled.ok && (reconciled.changed || []).includes(requirementId)
      ? syncRequirementStatusArtifacts(ctx, requirementId, 'rejected', `投票驳回：${reason || stored.id}`)
      : { ok: true, warnings: [] };
    const snapshot = readWorkflowSnapshot(ctx.name, ctx.projectPath);
    const status = snapshot.ok
      ? (snapshot.requirements.find((item) => item.id === requirementId) || {}).status
      : row.status;
    return {
      ok: true,
      code: 'OK',
      protocol: 'legacy',
      driver: 'team.mjs vote start',
      teamMode,
      reused: false,
      requestedBy,
      // 实际发起人（V 文件归属字段）——与 vote.initiator、V-*.json、V-*.md 同一份真相。
      initiator: String((stored && (stored.initiator || stored.createdBy)) || requestedBy),
      initiatorCast,
      initiatorStamped: { ok: stamped.ok, changed: Boolean(stamped.changed), code: stamped.code || 'OK' },
      vote: teamVoteView(stored, status),
      votes: readVoteRecords(ctx.name).map((vote) => teamVoteView(vote, status)),
      requirement: snapshot.ok ? snapshot.requirements.find((item) => item.id === requirementId) : null,
      voteFile: stored.file,
      votesDir: votesDir(ctx.name),
      workflowFile: read.file,
      workflow: snapshot.ok ? snapshot.workflow : null,
      snapshot: snapshot.ok ? snapshot : null,
      statusSync,
      warnings: [
        ...(!stamped.ok ? [{
          code: stamped.code || 'VOTE_INITIATOR_STAMP_FAILED',
          message: 'V 文件发起人归属没有写成实际发起人（' + requestedBy + '）：' + (stamped.code || 'UNKNOWN')
        }] : []),
        ...(initiatorCast && !initiatorCast.ok ? [{ code: initiatorCast.code || 'INITIATOR_CAST_FAILED', message: initiatorCast.message || 'analyst 自动票未写入' }] : []),
        ...(statusSync.warnings || [])
      ],
      legacy: {
        command: 'vote start',
        commandAvailable: true,
        argv: Array.isArray(run.argv) ? run.argv : [],
        missingCommands: ctx.capabilities ? ctx.capabilities.missing : []
      }
    };
  }

  async function castVote(input = {}) {
    const ctx = await ensureWorkflowProject(input);
    if (!ctx.ok) return ctx;
    const teamMode = normalizeTeamMode(input.teamMode || ctx.teamMode);
    const role = String(input.role || '').trim();
    if (!role) return failure('ROLE_REQUIRED', '缺少投票角色 role');
    if (role === 'pm') {
      return failure('VOTE_PM_EXCLUDED', 'PM 不参与驳回 Owner 需求的投票（除 PM 外所有角色一致 reject 才生效）', {
        role, teamMode
      });
    }
    const verdict = String(input.verdict || input.decision || '').toLowerCase();
    if (!['reject', 'approve', 'abstain'].includes(verdict)) {
      return failure('BAD_VERDICT', '投票结论必须是 reject / approve / abstain', {
        verdict, allowed: ['reject', 'approve', 'abstain']
      });
    }
    const voteId = String(input.voteId || input.id || '').trim();
    const requirementId = String(input.requirementId || '').trim();
    let vote = voteId ? findVoteById(ctx.name, voteId) : null;
    if (!vote && requirementId) {
      vote = readVoteRecords(ctx.name)
        .filter((item) => String(item.requirementId || '') === requirementId)
        .sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')))[0] || null;
    }
    if (!vote) {
      return failure('VOTE_NOT_FOUND', voteId ? `投票不存在：${voteId}` : `需求 ${requirementId || '(空)'} 没有投票`, {
        voteId: voteId || null, requirementId: requirementId || null
      });
    }
    const evaluation = evaluateTeamVote(vote);
    if (evaluation.status !== 'open') {
      return failure('VOTE_CLOSED', `投票 ${vote.id} 已结束（${evaluation.result}），不能再投票`, {
        voteId: vote.id, status: teamVoteUiStatus(evaluation), result: evaluation.result, vote: teamVoteView(vote)
      });
    }
    if (!evaluation.eligible.includes(role)) {
      return failure('VOTE_ROLE_NOT_ELIGIBLE', `角色 ${role} 不在本次投票的可投票角色内`, {
        role, eligibleRoles: evaluation.eligible, teamMode
      });
    }
    const reason = String(input.reason || input.comment || '').trim().slice(0, 1000);
    const evidence = normalizeVoteEvidence(input.evidence || input.proof || input.evidenceList);
    const comment = [reason, evidence ? `证据：${evidence}` : ''].filter(Boolean).join('\n').slice(0, 600);
    const run = await runTeamVoteCommand(ctx.name, role, 'cast', [
      '--id', vote.id,
      '--vote', verdict,
      ...(comment ? ['--comment', comment] : [])
    ], { sessionId: input.sessionId });
    if (!run.ok) return { ...run, project: ctx.name, projectPath: ctx.projectPath, vote: teamVoteView(vote) };
    const stored = findVoteById(ctx.name, vote.id);
    if (!stored) {
      return failure('VOTE_FILE_MISSING', `team.mjs vote cast 之后读不到 ${vote.id}.json；拒绝把本次投票当作已发生`, {
        voteId: vote.id, votesDir: votesDir(ctx.name)
      });
    }
    const freshEvaluation = evaluateTeamVote(stored);
    const reconciled = syncVoteRejectionsFromDisk(ctx.name, ctx.projectPath);
    const statusSync = reconciled.ok && (reconciled.changed || []).includes(String(stored.requirementId || ''))
      ? syncRequirementStatusArtifacts(ctx, stored.requirementId, 'rejected', `投票驳回：${stored.subject || stored.id}`)
      : { ok: true, warnings: [] };
    const read = readWorkflowState(ctx.name);
    const snapshot = readWorkflowSnapshot(ctx.name, ctx.projectPath);
    return {
      ok: true,
      code: 'OK',
      protocol: 'legacy',
      driver: 'team.mjs vote cast',
      teamMode,
      vote: teamVoteView(stored, snapshot.ok
        ? (snapshot.requirements.find((item) => item.id === stored.requirementId) || {}).status
        : ''),
      requirement: snapshot.ok ? snapshot.requirements.find((item) => item.id === stored.requirementId) : null,
      voteFile: stored.file,
      votesDir: votesDir(ctx.name),
      workflowFile: read.ok ? read.file : '',
      workflow: snapshot.ok ? snapshot.workflow : null,
      snapshot: snapshot.ok ? snapshot : null,
      statusSync,
      warnings: [...(statusSync.warnings || [])],
      legacy: {
        command: 'vote cast',
        commandAvailable: true,
        argv: Array.isArray(run.argv) ? run.argv : [],
        freshResult: freshEvaluation.result,
        missingCommands: ctx.capabilities ? ctx.capabilities.missing : []
      }
    };
  }

  /**
   * 只读查询投票；唯一数据源是团队工具 投票/V-*.json。
   * 若团队工具已经用 vote cast 把票投成 closed/rejected，这里把结果同步进
   * 工作流.json（需求置 rejected），否则 DSH 角色投的票只能看见、不能真正驳回需求。
   */
  async function voteStatus(input = {}) {
    const ctx = await ensureWorkflowProject(input);
    if (!ctx.ok) return ctx;
    const teamMode = normalizeTeamMode(input.teamMode || ctx.teamMode);
    const voteId = String(input.voteId || input.id || '').trim();
    const requirementId = String(input.requirementId || '').trim();
    const reconciled = syncVoteRejectionsFromDisk(ctx.name, ctx.projectPath);
    const read = readWorkflowState(ctx.name);
    if (!read.ok) return read;
    const statusByRequirement = new Map();
    for (const [id, row] of Object.entries(read.state.requirements || {})) {
      statusByRequirement.set(String(id), String(row && row.status || ''));
    }
    let votes = readVoteRecords(ctx.name)
      .filter((vote) => !voteId || String(vote.id) === voteId)
      .filter((vote) => !requirementId || String(vote.requirementId) === requirementId)
      .map((vote) => teamVoteView(vote, statusByRequirement.get(String(vote.requirementId)) || ''));
    if (input.open === true) {
      votes = votes.filter((vote) => vote.status === 'open');
    }
    if (voteId && !votes.length) {
      return failure('VOTE_NOT_FOUND', `投票不存在：${voteId}`, {
        voteId, votesDir: votesDir(ctx.name), source: '投票/V-*.json'
      });
    }
    const vote = votes[0] || null;
    const targetRequirementId = requirementId || (vote && vote.requirementId) || '';
    const requirement = targetRequirementId
      ? (() => {
        const found = findStateRequirementRow(read.state, targetRequirementId);
        return found ? requirementView(found.task, found.row) : null;
      })()
      : null;
    return {
      ok: true,
      code: 'OK',
      teamMode,
      vote,
      votes,
      requirement,
      count: votes.length,
      source: '投票/V-*.json',
      votesDir: votesDir(ctx.name),
      workflowFile: read.file,
      updatedAt: read.state.updatedAt || null,
      reconciled: {
        changed: Array.isArray(reconciled.changed) ? reconciled.changed : [],
        ok: reconciled.ok !== false
      }
    };
  }

  function workflowNext(projectName, projectPath) {
    const snapshot = readWorkflowSnapshot(projectName, projectPath);
    if (!snapshot.ok) return snapshot;
    return {
      ok: true,
      code: 'OK',
      project: snapshot.project,
      round: snapshot.round,
      nextRound: snapshot.nextRound,
      requirements: snapshot.requirements,
      workflowFile: snapshot.file
    };
  }

  function parseRequirementStatusRecord(line) {
    const match = String(line || '').match(/^-\s*(\d{4}-\d{2}-\d{2}T[^\s]+)\s+([A-Za-z_]+)\s*[：:]\s*(.*)$/);
    if (!match) return null;
    return { at: match[1], status: match[2], note: match[3] };
  }

  /**
   * 需求正文的“状态记录”只保留一个章节，并按“同状态 + 10 分钟窗口”去重：
   * 旧 team.mjs owner 命令和壳层 updateRequirementDocStatus 会先后写同一次验收，
   * 不能因此出现两个 ## 状态记录 / 两条 accepted。
   */
  function rewriteRequirementStatusRecords(lines, extraEntry) {
    const kept = [];
    const records = [];
    const extraLines = [];
    for (let i = 0; i < lines.length; i += 1) {
      if (!/^##\s+状态记录/.test(lines[i])) {
        kept.push(lines[i]);
        continue;
      }
      let j = i + 1;
      while (j < lines.length && !/^##\s+/.test(lines[j])) {
        const line = lines[j];
        if (parseRequirementStatusRecord(line)) records.push(line.trim());
        else if (line.trim()) extraLines.push(line);
        j += 1;
      }
      i = j - 1;
    }
    const unique = [];
    for (const line of records) {
      const parsed = parseRequirementStatusRecord(line);
      if (!parsed) continue;
      const duplicate = unique.some((previous) => {
        const prior = parseRequirementStatusRecord(previous);
        return prior && prior.status === parsed.status && auditMomentMatches(prior.at, parsed.at);
      });
      if (!duplicate) unique.push(line);
    }
    if (extraEntry) {
      const parsed = parseRequirementStatusRecord(extraEntry);
      const duplicate = parsed && unique.some((previous) => {
        const prior = parseRequirementStatusRecord(previous);
        return prior && prior.status === parsed.status && auditMomentMatches(prior.at, parsed.at);
      });
      if (!duplicate) unique.push(extraEntry);
    }
    while (kept.length && kept[kept.length - 1].trim() === '') kept.pop();
    if (unique.length || extraLines.length) {
      kept.push('', '## 状态记录', '', ...unique);
      // 旧工具可能允许在状态记录里写人工备注；去重时只合并状态条目，不能把手写说明一起删掉。
      if (extraLines.length) kept.push('', ...Array.from(new Set(extraLines)));
    }
    return kept;
  }

  /**
   * 终止/验收后同步需求正文与总览的状态列。
   * 只改“状态”这一行/一列，不重写需求正文；找不到文件时返回 ok:false 让调用方记警告。
   */
  function updateRequirementDocStatus(projectPath, requirementId, status, note = '') {
    const dir = path.join(projectPath, '需求');
    let name = '';
    try {
      name = fs.readdirSync(dir).find((file) => /\.md$/i.test(file)
        && requirementIdKey(file) === requirementIdKey(requirementId)) || '';
    } catch { /* 没有需求目录 */ }
    if (!name) return { ok: false, code: 'REQUIREMENT_DOC_MISSING' };
    const file = path.join(dir, name);
    try {
      const text = fs.readFileSync(file, 'utf8');
      const lines = text.split(/\r?\n/);
      let statusLine = lines.findIndex((line) => /^- 状态：/.test(line));
      if (statusLine >= 0) lines[statusLine] = `- 状态：${status}`;
      else {
        const titleLine = lines.findIndex((line) => /^#\s+/.test(line));
        lines.splice(titleLine >= 0 ? titleLine + 1 : 0, 0, `- 状态：${status}`);
      }
      const entry = note
        ? `- ${new Date().toISOString()} ${status}：${String(note).replace(/\s+/g, ' ').slice(0, 300)}`
        : '';
      const next = rewriteRequirementStatusRecords(lines, entry);
      writeTextAtomic(file, next.join('\n') + '\n');
      const overview = path.join(dir, '00-需求总览.md');
      if (fs.existsSync(overview)) {
        const rows = fs.readFileSync(overview, 'utf8').split(/\r?\n/);
        let changed = false;
        for (let i = 0; i < rows.length; i += 1) {
          // 总览行按“同一天同一序号”认，4 位 / 6 位写法不会漏改。
          const match = /^\|\s*(R-[^|\s]+)\s*\|/.exec(rows[i]);
          if (!match || requirementIdKey(match[1]) !== requirementIdKey(requirementId)) continue;
          const cells = rows[i].split('|');
          if (cells.length >= 6) {
            cells[4] = ` ${status} `;
            rows[i] = cells.join('|');
            changed = true;
          }
          break;
        }
        if (changed) writeTextAtomic(overview, rows.join('\n'));
      }
      return { ok: true, file };
    } catch (error) {
      return { ok: false, code: 'REQUIREMENT_DOC_WRITE_FAILED', message: String((error && error.message) || error).slice(0, 300) };
    }
  }

  /**
   * 把一次工作流状态迁移同步到需求正文/总览和旧需求任务：
   *   - 需求/R-*.md 的「- 状态：」行与唯一的「## 状态记录」；
   *   - 需求/00-需求总览.md 的状态列（按 4/6 位兼容号认行）；
   *   - 任务/R-*.json 的 workflow.requirementStatus。
   * 只写状态元数据，不改验收标准/正文其它段落；写入失败只返回警告，
   * 不改变调用方已经落账的工作流状态，也不改变任何闸门。
   */
  function syncRequirementStatusArtifacts(ctx, requirementId, status, note = '') {
    const projectName = String((ctx && ctx.name) || '').trim();
    const rawPath = String((ctx && ctx.projectPath) || '').trim();
    const projectPath = rawPath ? path.resolve(rawPath) : '';
    const id = String(requirementId || '').trim();
    const value = String(status || '').trim();
    if (!projectName || !projectPath || !id || !value) {
      return {
        ok: false,
        code: 'STATUS_SYNC_INPUT',
        warnings: [{ code: 'STATUS_SYNC_INPUT', message: '状态同步缺少项目/需求/状态', requirementId: id }]
      };
    }
    const warnings = [];
    const doc = updateRequirementDocStatus(projectPath, id, value, note);
    if (!doc.ok) {
      warnings.push({
        code: doc.code || 'REQUIREMENT_DOC_SYNC_FAILED',
        requirementId: id,
        message: doc.message || '需求正文/总览状态未同步'
      });
    }
    let task = { ok: false, code: 'REQUIREMENT_TASK_MISSING', skipped: true };
    const wanted = requirementIdKey(id);
    const requirementTask = readLegacyTasks(projectName).find((row) => row
      && requirementIdKey(row.id) === wanted
      && (row.type === 'requirement' || !row.requirementId));
    if (requirementTask) {
      const patched = patchLegacyTask(projectName, requirementTask.id, {
        workflow: { requirementStatus: value }
      });
      if (patched.ok) {
        task = { ok: true, id: String(requirementTask.id) };
      } else {
        task = { ok: false, code: patched.code || 'REQUIREMENT_TASK_SYNC_FAILED' };
        warnings.push({
          code: task.code,
          requirementId: id,
          message: patched.message || '需求任务 workflow.requirementStatus 未同步'
        });
      }
    }
    return {
      ok: doc.ok,
      code: doc.ok ? 'OK' : (doc.code || 'REQUIREMENT_DOC_SYNC_FAILED'),
      status: value,
      doc,
      task,
      warnings
    };
  }

  /**
   * 终止工作流时把旧 任务/*.json 里同一需求的任务一起收口。
   * 旧看板只认 task.status，不认 工作流.json；不收口就会继续显示“待领取”。
   */
  function closeLegacyTasksForTermination(projectName, requirementIds, note) {
    const wanted = new Set((requirementIds || []).map(String));
    const closed = [];
    for (const task of readLegacyTasks(projectName)) {
      const belongs = wanted.has(String(task.id)) || wanted.has(String(task.requirementId || ''));
      if (!belongs || task.status === 'done') continue;
      const patched = patchLegacyTask(projectName, task.id, {
        status: 'done',
        doneAt: new Date().toISOString(),
        evidence: String(note || '工作流终止').slice(0, 500),
        workflow: { requirementStatus: 'terminated' }
      });
      if (patched.ok) closed.push(String(task.id));
    }
    return closed;
  }

  // rejected = 已收口：投票驳回/评审打回后，本轮不再把它算作“在办需求”，
  // 否则被驳回的需求会同时堵住新一轮迭代和 Owner 新需求（owner:demand）。
  const ITERATE_CLOSED_STATUSES = ['accepted', 'terminated', 'iteration', 'rejected'];

  /**
   * 迭代闸门：本轮还有“在办需求/未完成旧任务”时不能启动下一轮。
   * 下一轮的排队需求（queued / round > 当前轮）不算在办，否则 Owner 新需求会永远堵住迭代。
   */
  function iterateGuard(projectName, state, options = {}) {
    const exceptRequirementId = String(options.exceptRequirementId || '');
    const currentRound = Number(state.round || 1);
    const rows = Object.entries(state.requirements || {}).map(([id, row]) => ({
      ...(row && typeof row === 'object' ? row : {}),
      id: String((row && row.id) || id)
    }));
    // 旧项目只有 需求/R-*.md 正文时，工作流状态里没有行；迭代闸门也必须
    // 把这些未收口需求算进去，否则会绕过“先验收再迭代”。
    const known = new Set(rows.map((row) => row.id));
    const projectPath = String(options.projectPath || '').trim()
      || ((registrationFor(projectName) || {}).path || '');
    if (projectPath) {
      for (const doc of readRequirementDocs(projectPath).list) {
        if (known.has(String(doc.id))) continue;
        known.add(String(doc.id));
        rows.push({
          id: String(doc.id),
          status: String(doc.status || 'review'),
          round: 1,
          queued: false,
          origin: 'legacy-doc'
        });
      }
    }
    const current = rows.filter((row) => Number(row.round || 1) <= currentRound && !row.queued);
    const open = current.filter((row) => row.id !== exceptRequirementId
      && !ITERATE_CLOSED_STATUSES.includes(String(row.status)));
    if (open.length) {
      return failure('ITERATE_BLOCKED', `还有 ${open.length} 条需求未收口（${open.map((row) => `${row.id}:${row.status}`).join('、')}）；先验收或终止，再启动下一轮`, {
        project: projectName,
        round: currentRound,
        requirementIds: open.map((row) => row.id),
        requirements: open.map((row) => ({ id: row.id, status: row.status }))
      });
    }
    const currentIds = new Set(current.map((row) => row.id));
    if (exceptRequirementId) currentIds.add(exceptRequirementId);
    // 已收口需求（accepted/terminated/iteration/rejected）下挂着的旧任务不再堵迭代；
    // 任务本身由 task done 收口，这里只保证 rejected 不被当成在办需求。
    const closedRequirementIds = new Set(current
      .filter((row) => ITERATE_CLOSED_STATUSES.includes(String(row.status)))
      .map((row) => row.id));
    const openTasks = readLegacyTasks(projectName).filter((task) => {
      if (!task || task.status === 'done') return false;
      const id = String(task.id || '');
      const requirementId = String(task.requirementId || '');
      if (exceptRequirementId && (id === exceptRequirementId || requirementId === exceptRequirementId)) return false;
      // 需求镜像任务：旧 任务/R-*.json 的 id 就是需求 id、requirementId 为空。
      // 需求已收口（含投票驳回）时，这个镜像任务没被 task done 关掉也不能反过来锁住下一轮。
      if (id && closedRequirementIds.has(id)) return false;
      if (requirementId && closedRequirementIds.has(requirementId)) return false;
      return currentIds.has(id) || currentIds.has(requirementId);
    });
    if (openTasks.length) {
      return failure('ITERATE_BLOCKED', `还有 ${openTasks.length} 个旧任务未完成（${openTasks.map((task) => task.id).join('、')}）；先收口任务，再启动下一轮`, {
        project: projectName,
        round: currentRound,
        taskIds: openTasks.map((task) => String(task.id || ''))
      });
    }
    return {
      ok: true,
      code: 'OK',
      project: projectName,
      round: currentRound,
      requirements: current.map((row) => ({ id: row.id, status: row.status }))
    };
  }

  /** 轮次推进后把所有旧 boot 标成审计可见的“已失效”。 */
  function invalidateBootsForRound(state, fromRound, toRound, at) {
    if (!state || !state.boots || typeof state.boots !== 'object') return;
    for (const [role, boot] of Object.entries(state.boots)) {
      if (!boot || typeof boot !== 'object') continue;
      boot.invalidatedAt = at;
      boot.invalidatedReason = `轮次 ${fromRound} → ${toRound}，旧 boot 失效`;
      state.boots[role] = boot;
    }
  }

  async function iterateWorkflow(input = {}) {
    const ctx = await ensureWorkflowProject(input);
    if (!ctx.ok) return ctx;
    const mode = normalizeTeamMode(ctx.teamMode);
    const modeLabel = mode === 'fast' ? 'Fast' : 'Full';
    const role = String(input.role || 'owner').trim();
    if (!['owner', 'pm'].includes(role)) return failure('ROLE_NOT_ALLOWED', '只有 Owner / PM 能启动下一轮', { role });
    // team.mjs 明确没有 workflow 旧命令（NOT_IMPLEMENTED）：轮次与 工作流.json 本来就由壳层
    // 拥有，所以缺命令时 Fast / Full 都由壳层推进（明确 SHELL_OWNED）；命令真存在才走旧协议。
    const shellIterate = !((legacyCapabilities().commands || {}).workflow);
    if (!shellIterate) {
      const commandGuard = requireLegacyCommand('workflow');
      if (commandGuard) return { ...commandGuard, project: ctx.name, projectPath: ctx.projectPath };
    }
    const gate = await ensureWorkflowBoot(ctx.name, ctx.projectPath, 'pm');
    if (!gate.ok) return gate;
    const read = readWorkflowState(ctx.name);
    if (!read.ok) return read;
    if (String(read.state.phase) === 'terminated') {
      return failure('WORKFLOW_TERMINATED', `项目「${ctx.name}」工作流已终止，不能再启动下一轮`, {
        project: ctx.name, phase: 'terminated'
      });
    }
    // 必须在调用旧 workflow iterate 之前拦住：不能先把 round 推进去再报“还有在办需求”。
    const businessGate = iterateGuard(ctx.name, read.state, { projectPath: ctx.projectPath });
    if (!businessGate.ok) return { ...businessGate, projectPath: ctx.projectPath, workflowFile: read.file };
    const opinion = String(input.opinion || '').slice(0, 1000);
    const at = new Date().toISOString();
    const fromRound = Number(read.state.round || 1);
    const toRound = fromRound + 1;
    let nextRound = toRound;
    let run = null;
    if (!shellIterate) {
      run = await runLegacyWorkflowProtocol('workflow', {
        projectName: ctx.name,
        projectPath: ctx.projectPath,
        action: 'iterate',
        role,
        opinion,
        sessionId: String(input.sessionId || '').trim()
      });
      if (!run.ok) return run;
      const toolRound = Number(run.value && run.value.round);
      nextRound = Number.isFinite(toolRound) && toolRound > 0 ? toolRound : toRound;
    }
    const written = mutateWorkflowState(ctx.name, (state) => {
      // 旧 workflow 命令已经写了自己的轮次；壳只做镜像合并，不能在同一次迭代里把 round 再 +1。
      state.round = nextRound;
      invalidateBootsForRound(state, fromRound, nextRound, at);
      for (const row of Object.values(state.requirements || {})) {
        if (row.queued && Number(row.round || nextRound) <= nextRound) {
          row.queued = false;
          row.round = nextRound;
          row.updatedAt = at;
        }
      }
      const rows = Object.values(state.requirements || {});
      if (rows.some((row) => row.status === 'ready')) state.phase = 'dispatch';
      // 驳回过的需求也要算在“需求评审”里：与 phaseFromRequirements（review/rejected →
      // requirement_review）保持同一口径，新轮次不能把它们藏回 requirement。
      else if (rows.some((row) => ['review', 'rejected'].includes(String(row.status)))) state.phase = 'requirement_review';
      else state.phase = 'requirement';
      state.ownerReview = { required: false, status: 'optional', kind: 'iteration', by: role, at, opinion };
      pushWorkflowEventOnce(state, {
        at, action: 'iterate', role, project: ctx.name,
        note: `第 ${fromRound} 轮 → 第 ${nextRound} 轮${shellIterate ? `（${modeLabel} 壳层推进）` : ''}`
      });
    });
    if (!written.ok) return written;
    const snapshot = readWorkflowSnapshot(ctx.name, ctx.projectPath);
    const warnings = shellIterate
      ? [{
        code: 'WORKFLOW_SHELL_OWNED',
        message: `team.mjs 没有 workflow 旧命令；${modeLabel} 模式下轮次由工作台壳层推进并写入 工作流.json（不冒充 team.mjs 执行）`
      }]
      : (Array.isArray(run.value && run.value.warnings) ? run.value.warnings : []);
    return {
      ok: true, code: 'OK', protocol: shellIterate ? 'shell' : 'legacy',
      driver: shellIterate ? 'workbench workflow' : 'team.mjs workflow',
      legacyCommandStatus: shellIterate ? 'SHELL_OWNED' : 'AVAILABLE',
      shellOwned: shellIterate,
      commandImplemented: !shellIterate,
      legacyCommandAvailable: !shellIterate,
      fallback: null,
      round: nextRound, fromRound,
      nextRound: snapshot.ok ? snapshot.nextRound : [],
      workflowFile: written.file,
      workflow: snapshot.ok ? snapshot.workflow : null,
      snapshot: snapshot.ok ? snapshot : null,
      warnings,
      legacy: {
        command: 'workflow', action: 'iterate', commandAvailable: !shellIterate,
        shellOwned: shellIterate,
        argv: Array.isArray(run && run.argv) ? run.argv : [],
        mocked: Boolean(run && run.mocked), missingCommands: ctx.capabilities.missing
      }
    };
  }

  async function terminateWorkflow(input = {}) {
    const ctx = await ensureWorkflowProject(input);
    if (!ctx.ok) return ctx;
    const mode = normalizeTeamMode(ctx.teamMode);
    const modeLabel = mode === 'fast' ? 'Fast' : 'Full';
    const role = String(input.role || 'owner').trim();
    if (!['owner', 'pm'].includes(role)) return failure('ROLE_NOT_ALLOWED', '只有 Owner / PM 能终止工作流', { role });
    // 与 iterateWorkflow 同一条规则：team.mjs 没有 workflow 旧命令时，终止由壳层收口
    // （Fast / Full 一致），返回值明确 SHELL_OWNED；命令真存在时仍走旧协议。
    const shellTerminate = !((legacyCapabilities().commands || {}).workflow);
    if (!shellTerminate) {
      const commandGuard = requireLegacyCommand('workflow');
      if (commandGuard) return { ...commandGuard, project: ctx.name, projectPath: ctx.projectPath };
    }
    const gate = await ensureWorkflowBoot(ctx.name, ctx.projectPath, 'pm');
    if (!gate.ok) return gate;
    const read = readWorkflowState(ctx.name);
    if (!read.ok) return read;
    const at = new Date().toISOString();
    const opinion = String(input.opinion || '').slice(0, 1000);
    const stoppedBefore = Object.entries(read.state.requirements || {})
      .filter(([, row]) => !['accepted', 'terminated'].includes(String(row.status)))
      .map(([id]) => String(id));
    const run = shellTerminate ? null : await runLegacyWorkflowProtocol('workflow', {
      projectName: ctx.name,
      projectPath: ctx.projectPath,
      action: 'terminate',
      role,
      opinion,
      sessionId: String(input.sessionId || '').trim()
    });
    if (run && !run.ok) return run;
    // 旧命令自己也会返回 stopped/closedTasks；壳以两边并集为准，不能因为命令已收口就丢结果。
    const toolStopped = Array.isArray(run && run.value && run.value.stopped) ? run.value.stopped.map(String) : [];
    const stoppedIds = [...new Set([...stoppedBefore, ...toolStopped])];
    const written = mutateWorkflowState(ctx.name, (state) => {
      state.phase = 'terminated';
      state.terminatedAt = at;
      state.terminatedBy = role;
      for (const row of Object.values(state.requirements || {})) {
        if (!['accepted', 'terminated'].includes(String(row.status))) {
          row.status = 'terminated';
          row.updatedAt = at;
          pushHistoryOnce(row, { at, action: 'terminate', by: role, note: opinion });
        }
      }
      state.ownerReview = { required: true, status: 'rejected', kind: 'terminate', by: role, at, opinion };
      pushWorkflowEventOnce(state, { at, action: 'terminate', role, project: ctx.name, note: opinion });
    });
    if (!written.ok) return written;
    // 只改 工作流.json 会让旧看板继续显示“待领取”：同一事务里收口旧任务并回写需求文档。
    const shellClosed = closeLegacyTasksForTermination(ctx.name, stoppedIds, `工作流终止${opinion ? '：' + opinion.slice(0, 120) : ''}`);
    const toolClosed = Array.isArray(run && run.value && run.value.closedTasks) ? run.value.closedTasks.map(String) : [];
    const closedTasks = [...new Set([...toolClosed, ...shellClosed])];
    const docWarnings = [];
    for (const requirementId of stoppedIds) {
      const doc = updateRequirementDocStatus(ctx.projectPath, requirementId, 'terminated', opinion || '工作流终止');
      if (!doc.ok) docWarnings.push({ code: doc.code, requirementId, message: doc.message || '' });
    }
    const snapshot = readWorkflowSnapshot(ctx.name, ctx.projectPath);
    return {
      ok: true, code: shellTerminate ? 'WORKFLOW_SHELL_OWNED' : 'OK',
      protocol: shellTerminate ? 'shell' : 'legacy',
      driver: shellTerminate ? 'workbench workflow' : 'team.mjs workflow',
      legacyCommandStatus: shellTerminate ? 'SHELL_OWNED' : 'AVAILABLE',
      shellOwned: shellTerminate,
      commandImplemented: !shellTerminate,
      legacyCommandAvailable: !shellTerminate,
      fallback: null,
      terminated: true,
      closedTasks,
      stoppedRequirements: stoppedIds,
      workflowFile: written.file,
      workflow: snapshot.ok ? snapshot.workflow : null,
      snapshot: snapshot.ok ? snapshot : null,
      warnings: [
        ...(shellTerminate ? [{
          code: 'WORKFLOW_SHELL_OWNED',
          message: `team.mjs 没有 workflow 旧命令；${modeLabel} 模式下终止由工作台壳层收口并写入 工作流.json（不冒充 team.mjs 执行）`
        }] : []),
        ...(Array.isArray(run && run.value && run.value.warnings) ? run.value.warnings : []),
        ...docWarnings
      ],
      legacy: {
        command: 'workflow', action: 'terminate',
        commandAvailable: true,
        commandImplemented: !shellTerminate,
        legacyCommandAvailable: !shellTerminate,
        shellOwned: shellTerminate,
        argv: run && Array.isArray(run.argv) ? run.argv : [],
        mocked: Boolean(run && run.mocked), missingCommands: ctx.capabilities.missing,
        closedTasks
      }
    };
  }

  // ---------- 派单 / 认领 / 完成 / 开发互审 / 测试 / Owner 验收 ----------

  async function sendWorkflowNotice(input = {}) {
    const projectName = String(input.projectName || '').trim();
    const from = String(input.from || 'pm').trim();
    const to = String(input.to || '').trim();
    if (!projectName) return failure('PROJECT_REQUIRED', '缺少团队项目名');
    if (!ROLE_IDS.includes(from) || !ROLE_IDS.includes(to)) return failure('BAD_ROLE', `发件/收件角色无效：${from} -> ${to}`);
    const sender = memberFor(from);
    const recipient = memberFor(to);
    if (!sender || sender.status !== 'active') return failure('TEAM_ROLE_NOT_READY', `发件角色「${from}」不在名册`);
    if (!recipient || recipient.status !== 'active') return failure('TEAM_ROLE_NOT_READY', `收件角色「${to}」不在名册`);
    const maxChars = Number(teamConfig().messageMaxChars || 600);
    const body = String(input.body || '').trim().slice(0, maxChars);
    if (!body) return failure('EMPTY_MESSAGE', '通知内容不能为空');
    const subject = String(input.subject || '工作流通知').slice(0, 80);
    const run = await runLegacyCommand(projectName, from, 'send', (token) => [
      'send', '--boot', token, '--to', to, '--subject', subject, '--body', body, '--no-wake',
      ...(input.task ? ['--task', String(input.task)] : []),
      ...(input.type ? ['--type', String(input.type)] : [])
    ], { sessionId: String(input.sessionId || '').trim() });
    if (!run.ok) return run;
    return { ok: true, code: 'OK', message: run.value && run.value.message ? run.value.message : null, command: 'send' };
  }

  function scopeForTarget(targetRel) {
    const target = String(targetRel || '').replace(/\\/g, '/');
    const dir = path.posix.dirname(target);
    if (!dir || dir === '.') return '**';
    return dir + '/**';
  }

  function scopeMatches(scope, targetRel) {
    const value = String(scope || '').replace(/\\/g, '/').replace(/^\.\//, '');
    const target = String(targetRel || '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!value) return false;
    if (value === '**' || value === '*') return true;
    if (value.endsWith('/**')) {
      const head = value.slice(0, -3);
      return target === head || target.startsWith(head + '/');
    }
    if (!value.includes('*')) return target === value;
    const pattern = '^' + value
      .replace(/[.+^${}()|[\]\\]/g, '\\$&')
      .replace(/\*\*/g, '.*')
      .replace(/\*/g, '[^/]*')
      .replace(/\?/g, '[^/]') + '$';
    try { return new RegExp(pattern).test(target); } catch { return false; }
  }

  function activeProposeGrant(role, projectName, targetRel) {
    const file = path.join(layout.state, '授权', String(role) + '.json');
    const data = readJsonSafe(file);
    const grants = data && Array.isArray(data.grants) ? data.grants : [];
    const nowMs = Date.now();
    return grants.find((grant) => {
      if (!grant || grant.revokedAt) return false;
      if (!Array.isArray(grant.actions) || !grant.actions.includes('propose')) return false;
      if (grant.project && grant.project !== '*' && String(grant.project) !== String(projectName)) return false;
      const expires = Date.parse(String(grant.expiresAt || ''));
      if (Number.isFinite(expires) && expires < nowMs) return false;
      return (Array.isArray(grant.scope) ? grant.scope : []).some((scope) => scopeMatches(scope, targetRel));
    }) || null;
  }

  async function ensureProposeGrant(projectName, role, targets) {
    const missing = [];
    for (const target of targets) {
      if (!activeProposeGrant(role, projectName, target)) missing.push(scopeForTarget(target));
    }
    if (!missing.length) return { ok: true, code: 'GRANT_READY', grantedScopes: [] };
    const scopes = [...new Set(missing)];
    const run = await runLegacyCommand(projectName, 'pm', 'grant', (token) => [
      'grant', '--boot', token, '--to', role, '--actions', 'propose',
      '--scope', scopes.join(','), '--project', projectName, '--expires', '7d',
      '--reason', '工作流开发提交自动授权（PM 代办）'
    ], { sessionId: '' });
    if (!run.ok) return run;
    return { ok: true, code: 'GRANT_CREATED', grant: run.value && run.value.grant ? run.value.grant : null, grantedScopes: scopes };
  }

  /** 派单前置校验（并行派单的预检也复用）：返回 {ok, meta} 或结构化失败。 */
  /**
   * 壳层 TR-Q（G2.5）：P0 需求在 Owner 门前必须有测试人员的可测性评审；P1 允许 optional-missing。
   * 只读：先看工作流行 trq 记录，再看 测试人员/产出/可测性评审-<需求id>-vN.md 的结论行。
   */
  function testabilityEvidence(ctx, requirementId, meta) {
    const recorded = (meta && meta.trq && typeof meta.trq === 'object') ? meta.trq : null;
    if (recorded && recorded.verdict) return { verdict: String(recorded.verdict), file: String(recorded.file || ''), source: 'workflow' };
    const dir = path.join(path.resolve(ctx.projectPath), '测试人员', '产出');
    let names = [];
    try { names = fs.readdirSync(dir).filter((name) => /^可测性评审-.*-v\d+\.md$/i.test(name) && name.includes(String(requirementId))); } catch { names = []; }
    if (!names.length) return null;
    const latest = names.map((name) => ({ name, mtime: fs.statSync(path.join(dir, name)).mtimeMs })).sort((a, b) => b.mtime - a.mtime)[0];
    let text = '';
    try { text = fs.readFileSync(path.join(dir, latest.name), 'utf8'); } catch { text = ''; }
    const line = (text.split(/\r?\n/).find((item) => /结论\s*[:：]/.test(item)) || '');
    const verdict = /不可测|not[_\s-]?testable/i.test(line) ? 'not_testable' : (/可测|testable/i.test(line) ? 'testable' : 'unknown');
    return { verdict, file: `测试人员/产出/${latest.name}`, source: 'file' };
  }

  function validateDispatchTarget(ctx, requirementId) {
    const mode = normalizeTeamMode(ctx.teamMode);
    // 旧需求只有正文时先补任务/工作流行，否则“评审/Owner 已过、派单找不到行”会断链。
    const imported = ensureLegacyRequirementRecord(ctx.name, ctx.projectPath, requirementId);
    if (!imported.ok) return imported;
    // 团队工具现场（TR/V）可能由 DSH 角色直接写入；派单闸门前先吸收，
    // 否则角色刚做完技术评审/投票，工作台仍按旧状态拒绝或放行。
    syncTechReviewsFromDisk(ctx.name, ctx.projectPath);
    syncVoteRejectionsFromDisk(ctx.name, ctx.projectPath);
    const gate = requireWorkflowBoot(ctx.name, ctx.projectPath, 'pm', { requirementId });
    if (!gate.ok) return gate;
    const read = readWorkflowState(ctx.name);
    if (!read.ok) return read;
    const found = findStateRequirementRow(read.state, requirementId);
    if (!found) return failure('REQUIREMENT_NOT_FOUND', `工作流里没有需求 ${requirementId}`, { requirementId });
    const meta = found.row;
    if (meta.queued || Number(meta.round || 1) > Number(read.state.round || 1)) {
      return failure('NEXT_ROUND_PENDING', `需求 ${requirementId} 属于下一轮，先启动迭代`, { requirementId, round: meta.round, currentRound: read.state.round });
    }
    if (meta.status !== 'ready') {
      return failure('REQUIREMENT_NOT_APPROVED', mode === 'fast'
        ? `需求 ${requirementId} 当前状态是 ${meta.status}，需求评审/Owner/开发技术评审都通过后才允许派单`
        : `需求 ${requirementId} 当前状态是 ${meta.status}，产品评审/Owner 闸门通过后才允许派单`, {
        requirementId, status: meta.status, teamMode: mode,
        productReview: meta.productReview || null,
        ownerReview: meta.ownerReview || null,
        techReview: meta.techReview || null
      });
    }
    if (!meta.productReview || meta.productReview.verdict !== 'approve') {
      return failure('PRODUCT_REVIEW_REQUIRED', `需求 ${requirementId} 没有需求评审通过，不能派单`, { requirementId });
    }
    const latestDecision = Array.isArray(meta.decisions) && meta.decisions.length ? meta.decisions[meta.decisions.length - 1] : null;
    const ownerStatus = String((latestDecision && latestDecision.status) || (meta.ownerReview && meta.ownerReview.status) || '');
    if (!['approved', 'skipped', 'accepted'].includes(ownerStatus)) {
      return failure('OWNER_REVIEW_REQUIRED', `需求 ${requirementId} 的 Owner 闸门未通过/未跳过（最新：${ownerStatus || '无记录'}）`, {
        requirementId, gate: 'G3', decision: latestDecision || meta.ownerReview || null,
        next: '让 Owner 在界面/终端确认（owner confirm → owner）',
      });
    }
    // G2.5：P0 需求在 Owner 门前必须有测试人员的可测性评审（TR-Q）；P1 允许 optional-missing。
    const trq = testabilityEvidence(ctx, requirementId, meta);
    if (String(meta.priority || '').toUpperCase() === 'P0' && (!trq || trq.verdict !== 'testable')) {
      return failure('TESTABILITY_REVIEW_REQUIRED', `P0 需求 ${requirementId} 还没有可测性评审（TR-Q）通过；先让测试人员做 TR-Q`, {
        requirementId, gate: 'G2.5', trq: trq || null,
        next: `测试人员/产出/可测性评审-${requirementId}-vN.md（结论：testable）`,
      });
    }
    // Fast 模式：Owner 之后必须有高级程序员 A 的开发技术评审通过，否则不得派单。
    if (mode === 'fast' && (!meta.techReview || meta.techReview.verdict !== 'approve')) {
      return failure('TECH_REVIEW_REQUIRED', `需求 ${requirementId} 还没有开发技术评审通过，Fast 模式不能派单`, {
        requirementId, techReview: meta.techReview || null
      });
    }
    return { ok: true, code: 'OK', meta, imported, teamMode: mode };
  }

  /** 单个开发任务的实际派发（校验已由调用方完成）。 */
  /**
   * G5（AC14.6）壳层同步：目标开发角色已有未闭环任务 → TASK_OPEN，先 done/释放再派。
   * 与 team.mjs 的 gateRoleBusy 同一错误码与提示，UI 与 CLI 不各写一套。
   */
  function devOwnerBusy(ctx, devOwner) {
    const name = String((ctx && ctx.name) || '').trim();
    const owner = String(devOwner || '').trim();
    if (!name || !owner) return null;
    const tasksDir = path.join(projectStatePaths(name).dir, '任务');
    const open = [];
    try {
      for (const file of fs.readdirSync(tasksDir).filter((entry) => entry.endsWith('.json'))) {
        const task = readJsonSafe(path.join(tasksDir, file));
        if (!task || task.type === 'requirement') continue;
        if (String(task.owner || '') !== owner) continue;
        if (String(task.status || '') === 'done') continue;
        open.push({ id: String(task.id || file.replace(/\.json$/, '')), title: String(task.title || ''), status: String(task.status || '') });
      }
    } catch { /* 没有任务目录：视为空闲 */ }
    if (!open.length) return null;
    return failure('TASK_OPEN', `角色 ${owner} 还有未闭环任务：${open.map((task) => task.id).join(', ')}；先 done 或改派再派单`, {
      role: owner, gate: 'G5', taskIds: open.map((task) => task.id),
      next: `先让 ${owner} 完成 ${open[0].id}（task done --evidence），或 PM 释放/改派`,
    });
  }

  async function dispatchOneRequirement(ctx, requirementId, devOwner, extra = {}, sessionId = '') {
    const busy = devOwnerBusy(ctx, devOwner);
    if (busy) return busy;
    const read = readWorkflowState(ctx.name);
    if (!read.ok) return read;
    const found = findStateRequirementRow(read.state, requirementId);
    if (!found) return failure('REQUIREMENT_NOT_FOUND', `工作流里没有需求 ${requirementId}`, { requirementId });
    const meta = found.row;
    const title = String(extra.title || `${requirementId} ${meta.title}`).slice(0, 120);
    const detail = String(extra.detail || meta.detail || '').slice(0, 2000);
    const run = await runLegacyCommand(ctx.name, 'pm', 'task create', (token) => [
      'task', 'create', '--boot', token, '--title', title, '--priority', String(meta.priority || 'P2'),
      '--owner', devOwner, '--requirement', requirementId, '--type', 'task',
      '--acceptance', String(meta.acceptanceCriteria || ''),
      ...(meta.story ? ['--story', String(meta.story)] : []),
      ...(detail ? ['--detail', detail] : [])
    ], { sessionId: String(sessionId || '').trim() });
    if (!run.ok) return run;
    const task = run.value && run.value.task ? run.value.task : null;
    if (!task || !task.id) return failure('BAD_JSON', '旧 task create 没有返回任务', { value: run.value });
    let notice = null;
    let warning = null;
    try {
      notice = await sendWorkflowNotice({
        projectName: ctx.name, from: 'pm', to: devOwner, task: task.id,
        subject: `开发任务 ${task.id}`,
        body: `需求 ${requirementId}：${meta.title}\n验收：${meta.acceptanceCriteria}\n请先 boot/read，再 task claim ${task.id}；提案后由另一名程序员互审。`,
        type: 'dispatch'
      });
      if (!notice.ok) warning = { code: notice.code || 'DISPATCH_NOTICE_FAILED', message: notice.message || '派单通知写入失败' };
    } catch (error) {
      warning = { code: 'DISPATCH_NOTICE_FAILED', message: String(error && error.message || error).slice(0, 200) };
    }
    const at = new Date().toISOString();
    const written = mutateWorkflowState(ctx.name, (state) => {
      const target = findStateRequirementRow(state, requirementId);
      if (!target) throw new Error(`工作流里没有需求 ${requirementId}`);
      const row = target.row;
      row.status = 'dev';
      row.updatedAt = at;
      row.dispatch = { taskId: task.id, owner: devOwner, by: 'pm', at, messageId: notice && notice.message ? notice.message.id : null };
      row.dev = {
        taskId: task.id,
        claimBy: null,
        claimedAt: null,
        proposal: null,
        peerReview: null,
        applied: false,
        commitId: null,
        doneAt: null,
        evidence: ''
      };
      row.history = Array.isArray(row.history) ? row.history : [];
      row.history.push({ at, action: 'dispatch', by: 'pm', note: `${task.id} → ${devOwner}` });
      state.phase = 'dev';
      pushWorkflowEvent(state, { action: 'dispatch', role: 'pm', project: ctx.name, requirementId, taskId: task.id, note: `→ ${devOwner}` });
    });
    if (!written.ok) return written;
    const patch = patchLegacyTask(ctx.name, task.id, { workflow: { requirementId, requirementStatus: 'dev', stage: 'dev' } });
    const statusSync = syncRequirementStatusArtifacts(ctx, requirementId, 'dev', `派开发：${task.id} → ${devOwner}`);
    const snapshot = readWorkflowSnapshot(ctx.name, ctx.projectPath);
    return {
      ok: true, code: 'OK', protocol: 'legacy', driver: 'team.mjs task create + send',
      requirementId, task, notice,
      requirement: snapshot.ok ? snapshot.requirements.find((row) => row.id === requirementId) : null,
      workflowFile: written.file,
      workflow: snapshot.ok ? snapshot.workflow : null,
      snapshot: snapshot.ok ? snapshot : null,
      statusSync,
      warnings: [...(warning ? [warning] : []), ...statusSync.warnings],
      legacy: {
        command: 'task create',
        missingCommands: ctx.capabilities.missing,
        taskPatch: patch.ok ? { ok: true } : { ok: false, code: patch.code, message: patch.message }
      }
    };
  }

  async function dispatchRequirement(input = {}) {
    const ctx = await ensureWorkflowProject(input);
    if (!ctx.ok) return ctx;
    const role = String(input.role || 'pm').trim();
    if (role !== 'pm') return failure('ROLE_NOT_ALLOWED', '只有 PM 能派开发任务', { role });
    const requirementId = String(input.requirementId || input.id || '').trim();
    if (!requirementId) return failure('REQUIREMENT_REQUIRED', '缺少需求 id');
    const devOwner = String(input.owner || 'programmer1').trim();
    if (!['programmer1', 'programmer2'].includes(devOwner)) return failure('BAD_ROLE', '开发任务只能派给 programmer1 / programmer2', { owner: devOwner });
    const mode = normalizeTeamMode(ctx.teamMode);
    if (!isRoleInTeamMode(devOwner, mode)) {
      return failure('ROLE_NOT_IN_TEAM_MODE', `Fast 模式只有高级程序员 A，不能派给 ${devOwner}`, {
        owner: devOwner, teamMode: mode, allowed: roleIdsForTeamMode(mode).filter((role) => role.startsWith('programmer'))
      });
    }
    // 派单闸门在 validateDispatchTarget 里是同步函数；这里先用异步壳闸门把过期令牌自动重签，
    // 再进入同步校验，避免把“令牌过期”误报成需要用户手动 boot。
    const bootReady = await ensureWorkflowBoot(ctx.name, ctx.projectPath, 'pm', {
      requirementId,
      sessionId: String(input.sessionId || '').trim(),
      teamMode: ctx.teamMode
    });
    if (!bootReady.ok) return bootReady;
    const checked = validateDispatchTarget(ctx, requirementId);
    if (!checked.ok) return checked;
    return dispatchOneRequirement(ctx, requirementId, devOwner, {
      title: String(input.title || '').slice(0, 120),
      detail: String(input.detail || '').slice(0, 2000)
    }, String(input.sessionId || '').trim());
  }

  /**
   * 并行派单：PM 一次把两个开发任务分别派给程序员 A/B，双方并行开发，
   * 提交时由另一名程序员互审（devSubmit 提案 → 对方 devReview → PM apply）。
   * 全部条目先过产品评审/Owner 闸门预检，任何一条不过整批不派；派发中途失败返回已派结果。
   */
  async function dispatchRequirementBatch(input = {}) {
    const ctx = await ensureWorkflowProject(input);
    if (!ctx.ok) return ctx;
    const role = String(input.role || 'pm').trim();
    if (role !== 'pm') return failure('ROLE_NOT_ALLOWED', '只有 PM 能并行派开发任务', { role });
    const items = Array.isArray(input.items) && input.items.length ? input.items : null;
    if (!items) return failure('BAD_DISPATCH_ITEMS', '并行派单需要 items: [{requirementId, owner}, ...]');
    const owners = [];
    const normalized = [];
    const mode = normalizeTeamMode(ctx.teamMode);
    for (const item of items) {
      const requirementId = String(item && (item.requirementId || item.id) || '').trim();
      const devOwner = String(item && item.owner || '').trim();
      if (!requirementId) return failure('REQUIREMENT_REQUIRED', '并行派单条目缺少需求 id', { item });
      if (!['programmer1', 'programmer2'].includes(devOwner)) {
        return failure('BAD_ROLE', '并行开发任务只能派给 programmer1 / programmer2', { owner: devOwner });
      }
      if (!isRoleInTeamMode(devOwner, mode)) {
        return failure('ROLE_NOT_IN_TEAM_MODE', `Fast 模式只有高级程序员 A，不能派给 ${devOwner}`, {
          owner: devOwner, teamMode: mode
        });
      }
      owners.push(devOwner);
      normalized.push({
        requirementId,
        owner: devOwner,
        title: String(item.title || '').slice(0, 120),
        detail: String(item.detail || '').slice(0, 2000)
      });
    }
    if (new Set(owners).size !== owners.length) {
      return failure('DUPLICATE_DEV_OWNER', '并行派单的两个开发任务必须分别派给程序员 A/B，不能重复派给同一人', { owners });
    }
    // 预检：任何一条未过产品评审/Owner 闸门，整批不派（产品评审未通过不得派单）。
    // 批内需求可能不同，这里先重签 PM 的过期令牌并读齐当前需求，再逐条做同步预检。
    const bootReady = await ensureWorkflowBoot(ctx.name, ctx.projectPath, 'pm', {
      sessionId: String(input.sessionId || '').trim(),
      teamMode: ctx.teamMode
    });
    if (!bootReady.ok) return bootReady;
    const prepared = [];
    for (const item of normalized) {
      const checked = validateDispatchTarget(ctx, item.requirementId);
      if (!checked.ok) {
        return { ...checked, item: { requirementId: item.requirementId }, batch: 'pre-check', dispatched: 0 };
      }
      prepared.push({ ...item, meta: checked.meta });
    }
    const results = [];
    for (const item of prepared) {
      const one = await dispatchOneRequirement(ctx, item.requirementId, item.owner, {
        title: item.title || `${item.requirementId} ${String(item.meta.title || '')}`,
        detail: item.detail
      }, String(input.sessionId || '').trim());
      results.push(one);
      if (!one.ok) {
        return {
          ok: false,
          code: one.code || 'DISPATCH_BATCH_PARTIAL',
          message: `并行派单第 ${results.length} 条（${item.requirementId}）失败：${String(one.message || '').slice(0, 300)}`,
          dispatched: results.length - 1,
          results,
          snapshot: readWorkflowSnapshot(ctx.name, ctx.projectPath)
        };
      }
    }
    const snapshot = readWorkflowSnapshot(ctx.name, ctx.projectPath);
    return {
      ok: true,
      code: 'OK',
      protocol: 'legacy',
      driver: 'team.mjs task create + send（并行）',
      dispatched: results.length,
      results,
      snapshot: snapshot.ok ? snapshot : null,
      parallel: true,
      reviewNote: '双方并行开发；提交提案后由另一名程序员互审，互审通过 + PM apply 后才能 task done。'
    };
  }

  async function claimWorkflowTask(input = {}) {
    const ctx = await ensureWorkflowProject(input);
    if (!ctx.ok) return ctx;
    const role = String(input.role || '').trim();
    const taskId = String(input.taskId || input.id || '').trim();
    if (!taskId) return failure('TASK_REQUIRED', '缺少任务 id');
    const task = readJsonSafe(legacyTaskFilePath(ctx.name, taskId));
    if (!task) return failure('TASK_NOT_FOUND', `旧任务不存在：${taskId}`, { taskId });
    if (task.type === 'requirement') return failure('TASK_IS_REQUIREMENT', '需求任务不走 claim；先产品评审/Owner 闸门，再由 PM 派开发任务');
    const requirementId = String(task.requirementId || '');
    if (requirementId) {
      const imported = ensureLegacyRequirementRecord(ctx.name, ctx.projectPath, requirementId);
      if (!imported.ok) return imported;
    }
    const read = readWorkflowState(ctx.name);
    if (!read.ok) return read;
    const found = findStateRequirementRow(read.state, requirementId);
    if (!found) return failure('TASK_NOT_IN_WORKFLOW', `任务 ${taskId} 不属于任何工作流需求`, { taskId, requirementId });
    const meta = found.row;
    const isTest = Boolean(meta.test && String(meta.test.taskId) === taskId);
    const isDev = Boolean(meta.dev && String(meta.dev.taskId) === taskId);
    if (!isTest && !isDev) return failure('TASK_NOT_IN_WORKFLOW', `任务 ${taskId} 不是当前需求的开发/测试任务`, { taskId, requirementId });
    if (isTest && role !== 'tester') return failure('ROLE_NOT_ALLOWED', '测试任务只能由测试人员认领', { role });
    if (isDev && !['programmer1', 'programmer2'].includes(role)) return failure('ROLE_NOT_ALLOWED', '开发任务只能由程序员认领', { role });
    if (task.owner && task.owner !== role) return failure('TASK_OWNED', `任务已被 ${task.owner} 认领`, { owner: task.owner });
    if (isDev && !['dev', 'dispatched'].includes(String(meta.status))) {
      return failure('REQUIREMENT_STATE_INVALID', `需求 ${requirementId} 当前状态是 ${meta.status}，不能认领开发任务`, { requirementId, status: meta.status });
    }
    if (isTest && String(meta.status) !== 'test') {
      return failure('REQUIREMENT_STATE_INVALID', `需求 ${requirementId} 当前状态是 ${meta.status}，不能认领测试任务`, { requirementId, status: meta.status });
    }
    const gate = await ensureWorkflowBoot(ctx.name, ctx.projectPath, role, { requirementId });
    if (!gate.ok) return gate;
    const run = await runLegacyCommand(ctx.name, role, 'task claim', (token) => [
      'task', 'claim', '--boot', token, '--id', taskId
    ], { sessionId: String(input.sessionId || '').trim() });
    if (!run.ok) return run;
    const at = new Date().toISOString();
    const written = mutateWorkflowState(ctx.name, (state) => {
      const target = findStateRequirementRow(state, requirementId);
      if (!target) throw new Error(`任务 ${taskId} 不属于任何工作流需求`);
      const row = target.row;
      if (isTest) {
        row.test = { ...(row.test || {}), taskId, claimBy: role, claimedAt: at };
        state.phase = 'test';
      } else {
        row.dev = { ...(row.dev || {}), taskId, claimBy: role, claimedAt: at };
        row.status = 'dev';
        state.phase = 'dev';
      }
      row.updatedAt = at;
      row.history = Array.isArray(row.history) ? row.history : [];
      row.history.push({ at, action: isTest ? 'test_claim' : 'dev_claim', by: role, note: taskId });
      pushWorkflowEvent(state, { action: isTest ? 'test_claim' : 'dev_claim', role, project: ctx.name, requirementId, taskId });
    });
    if (!written.ok) return written;
    const snapshot = readWorkflowSnapshot(ctx.name, ctx.projectPath);
    return {
      ok: true, code: 'OK', protocol: 'legacy', driver: 'team.mjs task claim',
      requirementId, task: run.value && run.value.task ? run.value.task : task,
      requirement: snapshot.ok ? snapshot.requirements.find((row) => row.id === requirementId) : null,
      workflowFile: written.file,
      workflow: snapshot.ok ? snapshot.workflow : null,
      snapshot: snapshot.ok ? snapshot : null,
      legacy: { command: 'task claim', missingCommands: ctx.capabilities.missing }
    };
  }

  async function doneWorkflowTask(input = {}) {
    const ctx = await ensureWorkflowProject(input);
    if (!ctx.ok) return ctx;
    const role = String(input.role || '').trim();
    const taskId = String(input.taskId || input.id || '').trim();
    const evidence = String(input.evidence || '').trim();
    if (!taskId) return failure('TASK_REQUIRED', '缺少任务 id');
    if (!evidence) return failure('EVIDENCE_REQUIRED', '完成任务必须带证据（提交号/路径/验证输出）');
    const task = readJsonSafe(legacyTaskFilePath(ctx.name, taskId));
    if (!task) return failure('TASK_NOT_FOUND', `旧任务不存在：${taskId}`, { taskId });
    const requirementId = String(task.requirementId || '');
    if (requirementId) {
      const imported = ensureLegacyRequirementRecord(ctx.name, ctx.projectPath, requirementId);
      if (!imported.ok) return imported;
    }
    const read = readWorkflowState(ctx.name);
    if (!read.ok) return read;
    const found = findStateRequirementRow(read.state, requirementId);
    if (!found) return failure('TASK_NOT_IN_WORKFLOW', `任务 ${taskId} 不属于任何工作流需求`, { taskId, requirementId });
    const meta = found.row;
    const isTest = Boolean(meta.test && String(meta.test.taskId) === taskId);
    const isDev = Boolean(meta.dev && String(meta.dev.taskId) === taskId);
    if (!isTest && !isDev) return failure('TASK_NOT_IN_WORKFLOW', `任务 ${taskId} 不是当前需求的开发/测试任务`, { taskId, requirementId });
    if (task.owner && task.owner !== role && role !== 'pm') return failure('TASK_NOT_OWNER', `任务 owner 是 ${task.owner}，不能由 ${role} 完成`, { owner: task.owner });
    if (isDev) {
      const peer = meta.dev && meta.dev.peerReview ? meta.dev.peerReview : null;
      if (!peer || peer.status !== 'approved') {
        return failure('PEER_REVIEW_REQUIRED', `开发任务 ${taskId} 还没有互审通过，不能 done`, { taskId, peerReview: peer });
      }
      if (meta.dev.proposal && meta.dev.proposal.id && !meta.dev.applied) {
        return failure('PROPOSAL_NOT_APPLIED', `提案 ${meta.dev.proposal.id} 还没有 PM 签字/apply，不能 done`, { proposal: meta.dev.proposal });
      }
    }
    if (isTest && String(meta.status) !== 'test') {
      return failure('REQUIREMENT_STATE_INVALID', `需求 ${requirementId} 当前状态是 ${meta.status}，不能完成测试任务`, { requirementId, status: meta.status });
    }
    const gate = await ensureWorkflowBoot(ctx.name, ctx.projectPath, role, { requirementId });
    if (!gate.ok) return gate;
    const run = await runLegacyCommand(ctx.name, role, 'task done', (token) => [
      'task', 'done', '--boot', token, '--id', taskId, '--evidence', evidence
    ], { sessionId: String(input.sessionId || '').trim() });
    if (!run.ok) return run;
    const at = new Date().toISOString();
    const written = mutateWorkflowState(ctx.name, (state) => {
      const target = findStateRequirementRow(state, requirementId);
      if (!target) throw new Error(`任务 ${taskId} 不属于任何工作流需求`);
      const row = target.row;
      row.updatedAt = at;
      row.history = Array.isArray(row.history) ? row.history : [];
      if (isTest) {
        row.test = { ...(row.test || {}), taskId, doneAt: at, evidence };
        row.status = 'test_done';
        state.phase = 'owner_accept';
        state.ownerReview = {
          // Owner 还没验收：pending 只记录闸门本身，不能伪造 by/actor。
          required: true, status: 'pending', kind: 'acceptance', at: null, opinion: '',
          roundKey: `${ctx.name}|${state.round}|${Object.keys(state.requirements).length}`
        };
        row.history.push({ at, action: 'test_done', by: role, note: evidence.slice(0, 120) });
        pushWorkflowEvent(state, { action: 'test_done', role, project: ctx.name, requirementId, taskId, note: evidence.slice(0, 120) });
      } else {
        row.dev = { ...(row.dev || {}), taskId, doneAt: at, evidence };
        row.status = 'dev_done';
        state.phase = 'dev_done';
        row.history.push({ at, action: 'dev_done', by: role, note: evidence.slice(0, 120) });
        pushWorkflowEvent(state, { action: 'dev_done', role, project: ctx.name, requirementId, taskId, note: evidence.slice(0, 120) });
      }
    });
    if (!written.ok) return written;
    const patch = patchLegacyTask(ctx.name, taskId, { workflow: { requirementStatus: isTest ? 'test_done' : 'dev_done', evidence } });
    const statusSync = syncRequirementStatusArtifacts(
      ctx,
      requirementId,
      isTest ? 'test_done' : 'dev_done',
      `${isTest ? '测试' : '开发'}完成：${taskId}`
    );
    const snapshot = readWorkflowSnapshot(ctx.name, ctx.projectPath);
    return {
      ok: true, code: 'OK', protocol: 'legacy', driver: 'team.mjs task done',
      requirementId, task: run.value && run.value.task ? run.value.task : task,
      requirement: snapshot.ok ? snapshot.requirements.find((row) => row.id === requirementId) : null,
      workflowFile: written.file,
      workflow: snapshot.ok ? snapshot.workflow : null,
      snapshot: snapshot.ok ? snapshot : null,
      statusSync,
      warnings: statusSync.warnings,
      legacy: { command: 'task done', missingCommands: ctx.capabilities.missing, taskPatch: patch.ok ? { ok: true } : { ok: false, code: patch.code } }
    };
  }

  function normalizeWorkflowFiles(input, projectPath) {
    const rows = [];
    const raw = Array.isArray(input.files) && input.files.length
      ? input.files
      : (input.fileRel || input.target ? [{ target: input.fileRel || input.target, content: input.content, staged: input.staged || input.stagedPath, expect: input.expect }] : []);
    for (const item of raw) {
      if (!item || typeof item !== 'object') return failure('BAD_FILE_SPEC', '开发提交文件必须是 {target, content|staged} 对象');
      const target = String(item.target || item.rel || '').replace(/\\/g, '/').trim();
      if (!target) return failure('BAD_TARGET', '开发提交缺少目标文件');
      if (path.isAbsolute(target) || /^[a-zA-Z]:/.test(target) || target.split('/').includes('..')) {
        return failure('BAD_TARGET', `目标必须是项目内相对路径：${target}`);
      }
      const abs = path.resolve(projectPath, target);
      if (!isInside(projectPath, abs)) return failure('BAD_TARGET', `目标越界：${target}`);
      rows.push({
        target,
        content: item.content !== undefined ? String(item.content) : null,
        staged: item.staged || item.stagedPath || '',
        expect: item.expect !== undefined ? String(item.expect) : ''
      });
    }
    if (!rows.length) return failure('NO_FILES', '开发提交至少需要一个文件（target + content / staged）');
    return { ok: true, files: rows };
  }

  async function devSubmit(input = {}) {
    const ctx = await ensureWorkflowProject(input);
    if (!ctx.ok) return ctx;
    const role = String(input.role || '').trim();
    if (!['programmer1', 'programmer2'].includes(role)) return failure('ROLE_NOT_ALLOWED', '开发提交只能由程序员执行', { role });
    const taskId = String(input.taskId || input.id || '').trim();
    if (!taskId) return failure('TASK_REQUIRED', '缺少开发任务 id');
    const task = readJsonSafe(legacyTaskFilePath(ctx.name, taskId));
    if (!task) return failure('TASK_NOT_FOUND', `旧任务不存在：${taskId}`, { taskId });
    const requirementId = String(task.requirementId || input.requirementId || '');
    const read = readWorkflowState(ctx.name);
    if (!read.ok) return read;
    const meta = read.state.requirements[requirementId];
    if (!meta) return failure('TASK_NOT_IN_WORKFLOW', `任务 ${taskId} 不属于任何工作流需求`, { taskId, requirementId });
    if (!meta.dev || String(meta.dev.taskId) !== taskId) return failure('TASK_NOT_IN_WORKFLOW', `任务 ${taskId} 不是当前需求的开发任务`, { taskId, requirementId });
    if (String(meta.status) !== 'dev') return failure('REQUIREMENT_STATE_INVALID', `需求 ${requirementId} 当前状态是 ${meta.status}，不能提交开发提案`, { requirementId, status: meta.status });
    if (task.owner && task.owner !== role) return failure('TASK_NOT_OWNER', `任务 owner 是 ${task.owner}，不能由 ${role} 提交`, { owner: task.owner });
    const gate = await ensureWorkflowBoot(ctx.name, ctx.projectPath, role, { requirementId });
    if (!gate.ok) return gate;
    const normalized = normalizeWorkflowFiles(input, ctx.projectPath);
    if (!normalized.ok) return normalized;
    const stagedRoot = path.join(ctx.projectPath, '_tmp', 'workflow-staged-' + crypto.randomUUID().slice(0, 8));
    fs.mkdirSync(stagedRoot, { recursive: true });
    const files = [];
    try {
      for (const row of normalized.files) {
        const abs = path.resolve(ctx.projectPath, row.target);
        const current = fs.existsSync(abs) ? crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex') : 'absent';
        const expect = row.expect || current;
        if (expect !== current) {
          return failure('STALE_BASE', `目标文件在读取后变了：${row.target}`, { target: row.target, expected: expect, current });
        }
        let staged = row.staged;
        if (!staged) {
          const name = String(path.basename(row.target) || 'file').replace(/[\\/:*?"<>|]/g, '-');
          staged = path.join(stagedRoot, files.length + 1 + '-' + name);
          writeTextAtomic(staged, row.content === null ? '' : row.content);
        } else {
          const driveError = assertDataDrive(staged, '暂存文件');
          if (driveError) return driveError;
        }
        if (!fs.existsSync(staged)) return failure('STAGED_MISSING', `暂存文件不存在：${staged}`);
        files.push({ target: row.target, staged, expect });
      }
      const grant = await ensureProposeGrant(ctx.name, role, files.map((file) => file.target));
      if (!grant.ok) return grant;
      const result = await legacyProposalAction({
        projectName: ctx.name,
        role,
        sessionId: String(input.sessionId || (readProjectSessions(ctx.name)[role] || '')),
        action: 'propose',
        task: taskId,
        title: String(input.title || `${taskId} 开发提案`).slice(0, 100),
        rationale: String(input.rationale || '').slice(0, 2000),
        risk: String(input.risk || 'normal'),
        files: files.map((file) => ({ target: file.target, staged: file.staged, expect: file.expect })),
        allowMissingSession: true
      });
      if (!result.ok) return result;
      const proposal = result.proposal || null;
      if (!proposal || !proposal.id) return failure('BAD_JSON', '旧 propose 没有返回提案', { result });
      const at = new Date().toISOString();
      const written = mutateWorkflowState(ctx.name, (state) => {
        const row = state.requirements[requirementId];
        row.dev = {
          ...(row.dev || {}),
          taskId,
          proposal: {
            id: String(proposal.id),
            author: role,
            status: proposal.status || 'review',
            stage: proposal.stage || 'proposed',
            proposalHash: proposal.proposalHash || proposal.hash || '',
            files: proposal.files || []
          },
          peerReview: { status: 'pending', at, by: '', comment: '', proposalId: String(proposal.id) },
          applied: false,
          commitId: null
        };
        row.status = 'dev_review';
        row.updatedAt = at;
        row.history = Array.isArray(row.history) ? row.history : [];
        row.history.push({ at, action: 'dev_submit', by: role, note: String(proposal.id) });
        state.phase = 'dev_review';
        pushWorkflowEvent(state, { action: 'dev_submit', role, project: ctx.name, requirementId, taskId, note: String(proposal.id) });
      });
      if (!written.ok) return written;
      patchLegacyTask(ctx.name, taskId, { workflow: { requirementStatus: 'dev_review', proposalId: String(proposal.id) } });
      const snapshot = readWorkflowSnapshot(ctx.name, ctx.projectPath);
      return {
        ok: true, code: 'OK', protocol: 'legacy', driver: 'team.mjs propose',
        requirementId, taskId, proposal,
        grant,
        requirement: snapshot.ok ? snapshot.requirements.find((row) => row.id === requirementId) : null,
        workflowFile: written.file,
        workflow: snapshot.ok ? snapshot.workflow : null,
        snapshot: snapshot.ok ? snapshot : null,
        legacy: { command: 'propose', missingCommands: ctx.capabilities.missing, grants: grant.grantedScopes || [] }
      };
    } finally {
      try { fs.rmSync(stagedRoot, { recursive: true, force: true }); } catch { /* ignore */ }
    }
  }

  function readProjectSessions(projectName) {
    const registration = registrationFor(projectName);
    if (!registration || !registration.path) return {};
    const manifest = readJsonSafe(path.join(registration.path, '团队会话.json'));
    const out = {};
    for (const row of (manifest && Array.isArray(manifest.roles) ? manifest.roles : [])) {
      if (row && row.role && row.sessionId) out[row.role] = String(row.sessionId);
    }
    return out;
  }

  async function devReview(input = {}) {
    const ctx = await ensureWorkflowProject(input);
    if (!ctx.ok) return ctx;
    const mode = normalizeTeamMode(ctx.teamMode);
    const role = String(input.role || '').trim();
    // Fast 只有一个程序员，没有 A/B 互审：由测试人员做独立复核，PM 在 apply 时再 review+签字。
    // 团队工具的 apply 闸门不允许 PM 既当唯一评审又当唯一签字人（三人以上团队 NEED_SECOND_REVIEWER）。
    const allowedReviewers = mode === 'fast'
      ? ['tester', 'programmer1']
      : ['programmer1', 'programmer2'];
    if (!allowedReviewers.includes(role)) {
      return failure('ROLE_NOT_ALLOWED', mode === 'fast'
        ? 'Fast 模式的开发复核由测试人员独立执行；PM 在签字 apply 时复核'
        : '开发互审只能由另一名程序员执行', { role, teamMode: mode, allowed: allowedReviewers });
    }
    const requirementId = String(input.requirementId || '').trim();
    const proposalId = String(input.proposalId || '').trim();
    if (!requirementId) return failure('REQUIREMENT_REQUIRED', '缺少需求 id');
    if (!proposalId) return failure('BAD_ID', '缺少提案 id');
    const read = readWorkflowState(ctx.name);
    if (!read.ok) return read;
    const meta = read.state.requirements[requirementId];
    if (!meta || !meta.dev || !meta.dev.proposal) return failure('PROPOSAL_NOT_FOUND', `需求 ${requirementId} 没有待互审提案`, { requirementId });
    if (String(meta.dev.proposal.id) !== proposalId) return failure('PROPOSAL_NOT_FOUND', `提案 ${proposalId} 不是需求 ${requirementId} 的当前提案`, { proposalId });
    if (String(meta.dev.proposal.author || '') === role) return failure('SELF_REVIEW', '不能评审自己写的提案', { role });
    const gate = await ensureWorkflowBoot(ctx.name, ctx.projectPath, role, { requirementId });
    if (!gate.ok) return gate;
    const verdict = String(input.verdict || input.decision || '').toLowerCase();
    if (!['approve', 'reject'].includes(verdict)) return failure('BAD_VERDICT', '互审结论必须是 approve / reject');
    const comment = String(input.comment !== undefined ? input.comment : (input.comments || '')).trim();
    const sessionId = String(input.sessionId || (readProjectSessions(ctx.name)[role] || ''));
    const shown = await legacyProposalAction({
      projectName: ctx.name, role, sessionId, action: 'show', proposalId, allowMissingSession: true
    });
    if (!shown.ok) return shown;
    const reviewed = await legacyProposalAction({
      projectName: ctx.name, role, sessionId, action: 'review', proposalId, verdict, comments: comment, allowMissingSession: true
    });
    if (!reviewed.ok) return reviewed;
    const at = new Date().toISOString();
    const written = mutateWorkflowState(ctx.name, (state) => {
      const row = state.requirements[requirementId];
      row.dev.peerReview = {
        status: verdict === 'approve' ? 'approved' : 'rejected',
        by: role, teamMode: mode, at, comment: comment.slice(0, 600), proposalId
      };
      row.status = verdict === 'approve' ? 'dev_review' : 'dev';
      row.updatedAt = at;
      row.history = Array.isArray(row.history) ? row.history : [];
      row.history.push({ at, action: 'dev_peer_review', by: role, note: verdict });
      state.phase = verdict === 'approve' ? 'dev_review' : 'dev';
      pushWorkflowEvent(state, { action: 'dev_peer_review', role, project: ctx.name, requirementId, taskId: row.dev.taskId, note: verdict });
    });
    if (!written.ok) return written;
    patchLegacyTask(ctx.name, meta.dev.taskId, { workflow: { requirementStatus: verdict === 'approve' ? 'dev_review' : 'dev', peerReview: verdict } });
    const snapshot = readWorkflowSnapshot(ctx.name, ctx.projectPath);
    return {
      ok: true, code: 'OK', protocol: 'legacy', driver: 'team.mjs show + review',
      requirementId, proposalId, verdict,
      proposal: reviewed.proposal || null,
      review: reviewed.review || null,
      requirement: snapshot.ok ? snapshot.requirements.find((row) => row.id === requirementId) : null,
      workflowFile: written.file,
      workflow: snapshot.ok ? snapshot.workflow : null,
      snapshot: snapshot.ok ? snapshot : null,
      legacy: { command: 'review', missingCommands: ctx.capabilities.missing }
    };
  }

  async function devApply(input = {}) {
    const ctx = await ensureWorkflowProject(input);
    if (!ctx.ok) return ctx;
    const role = String(input.role || 'pm').trim();
    if (role !== 'pm') return failure('ROLE_NOT_ALLOWED', '只有 PM 能签字并 apply 开发提案', { role });
    const requirementId = String(input.requirementId || '').trim();
    const proposalId = String(input.proposalId || '').trim();
    if (!requirementId) return failure('REQUIREMENT_REQUIRED', '缺少需求 id');
    if (!proposalId) return failure('BAD_ID', '缺少提案 id');
    const read = readWorkflowState(ctx.name);
    if (!read.ok) return read;
    const meta = read.state.requirements[requirementId];
    if (!meta || !meta.dev || !meta.dev.proposal || String(meta.dev.proposal.id) !== proposalId) {
      return failure('PROPOSAL_NOT_FOUND', `提案 ${proposalId} 不是需求 ${requirementId} 的当前提案`, { requirementId, proposalId });
    }
    if (!meta.dev.peerReview || meta.dev.peerReview.status !== 'approved') {
      return failure('PEER_REVIEW_REQUIRED', `提案 ${proposalId} 还没有互审通过`, { proposalId, peerReview: meta.dev.peerReview });
    }
    const gate = await ensureWorkflowBoot(ctx.name, ctx.projectPath, 'pm', { requirementId });
    if (!gate.ok) return gate;
    const sessionId = String(input.sessionId || (readProjectSessions(ctx.name).pm || ''));
    const shown = await legacyProposalAction({ projectName: ctx.name, role, sessionId, action: 'show', proposalId, allowMissingSession: true });
    if (!shown.ok) return shown;
    const reviewed = await legacyProposalAction({
      projectName: ctx.name, role, sessionId, action: 'review', proposalId, verdict: 'approve',
      comments: String(input.comment || 'PM 复核通过').slice(0, 600), allowMissingSession: true
    });
    if (!reviewed.ok) return reviewed;
    const signed = await legacyProposalAction({
      projectName: ctx.name, role, sessionId, action: 'sign', proposalId, decision: 'approve',
      note: String(input.note || 'PM 签字通过').slice(0, 300), allowMissingSession: true
    });
    if (!signed.ok) return signed;
    const applied = await legacyProposalAction({
      projectName: ctx.name, role, sessionId, action: 'apply', proposalId,
      log: String(input.log || '工作流开发提交').slice(0, 160), allowMissingSession: true
    });
    if (!applied.ok) return applied;
    const commitId = applied.commit && applied.commit.id ? String(applied.commit.id) : '';
    const at = new Date().toISOString();
    const written = mutateWorkflowState(ctx.name, (state) => {
      const row = state.requirements[requirementId];
      row.dev = {
        ...(row.dev || {}),
        applied: true,
        commitId,
        appliedAt: at,
        proposal: {
          ...(row.dev.proposal || {}),
          status: 'applied',
          stage: 'applied',
          commitId
        }
      };
      row.updatedAt = at;
      row.history = Array.isArray(row.history) ? row.history : [];
      row.history.push({ at, action: 'dev_apply', by: 'pm', note: commitId });
      state.phase = 'dev_review';
      pushWorkflowEvent(state, { action: 'dev_apply', role: 'pm', project: ctx.name, requirementId, taskId: row.dev.taskId, note: commitId });
    });
    if (!written.ok) return written;
    patchLegacyTask(ctx.name, meta.dev.taskId, { workflow: { requirementStatus: 'dev_review', commitId, applied: true } });
    const snapshot = readWorkflowSnapshot(ctx.name, ctx.projectPath);
    return {
      ok: true, code: 'OK', protocol: 'legacy', driver: 'team.mjs show+review+sign+apply',
      requirementId, proposalId, commit: applied.commit || null, commitId,
      requirement: snapshot.ok ? snapshot.requirements.find((row) => row.id === requirementId) : null,
      workflowFile: written.file,
      workflow: snapshot.ok ? snapshot.workflow : null,
      snapshot: snapshot.ok ? snapshot : null,
      legacy: { command: 'apply', missingCommands: ctx.capabilities.missing }
    };
  }

  async function dispatchTest(input = {}) {
    const ctx = await ensureWorkflowProject(input);
    if (!ctx.ok) return ctx;
    const role = String(input.role || 'pm').trim();
    if (role !== 'pm') return failure('ROLE_NOT_ALLOWED', '只有 PM 能派测试任务', { role });
    const requirementId = String(input.requirementId || '').trim();
    if (!requirementId) return failure('REQUIREMENT_REQUIRED', '缺少需求 id');
    const imported = ensureLegacyRequirementRecord(ctx.name, ctx.projectPath, requirementId);
    if (!imported.ok) return imported;
    const read = readWorkflowState(ctx.name);
    if (!read.ok) return read;
    const found = findStateRequirementRow(read.state, requirementId);
    if (!found) return failure('REQUIREMENT_NOT_FOUND', `工作流里没有需求 ${requirementId}`, { requirementId });
    const meta = found.row;
    if (String(meta.status) !== 'dev_done') {
      return failure('DEV_NOT_DONE', `需求 ${requirementId} 当前状态是 ${meta.status}，开发完成且互审通过后才能给测试`, { requirementId, status: meta.status });
    }
    if (!meta.dev || !meta.dev.taskId) return failure('DEV_TASK_MISSING', '需求没有开发任务', { requirementId });
    const devTask = readJsonSafe(legacyTaskFilePath(ctx.name, meta.dev.taskId));
    if (!devTask || devTask.status !== 'done') return failure('DEV_NOT_DONE', `开发任务 ${meta.dev.taskId} 还没有 done`, { taskId: meta.dev.taskId });
    if (!meta.dev.peerReview || meta.dev.peerReview.status !== 'approved') {
      return failure('PEER_REVIEW_REQUIRED', `需求 ${requirementId} 的开发提案还没有互审通过`, { requirementId });
    }
    if (meta.dev.proposal && meta.dev.proposal.id && !meta.dev.applied) {
      return failure('PROPOSAL_NOT_APPLIED', `提案 ${meta.dev.proposal.id} 还没有 apply`, { proposal: meta.dev.proposal });
    }
    const gate = await ensureWorkflowBoot(ctx.name, ctx.projectPath, 'pm', { requirementId });
    if (!gate.ok) return gate;
    const run = await runLegacyCommand(ctx.name, 'pm', 'task create', (token) => [
      'task', 'create', '--boot', token,
      '--title', String(input.title || `${requirementId} 测试验收`).slice(0, 120),
      '--priority', String(meta.priority || 'P2'),
      '--owner', 'tester', '--requirement', requirementId, '--type', 'task',
      '--acceptance', String(meta.acceptanceCriteria || ''),
      '--detail', String(input.detail || `独立验证需求 ${requirementId}；证据写入 task done。`).slice(0, 2000)
    ], { sessionId: String(input.sessionId || '').trim() });
    if (!run.ok) return run;
    const task = run.value && run.value.task ? run.value.task : null;
    if (!task || !task.id) return failure('BAD_JSON', '旧 task create 没有返回测试任务', { value: run.value });
    let notice = null;
    let warning = null;
    try {
      notice = await sendWorkflowNotice({
        projectName: ctx.name, from: 'pm', to: 'tester', task: task.id,
        subject: `测试任务 ${task.id}`,
        body: `需求 ${requirementId}：${meta.title}\n验收：${meta.acceptanceCriteria}\n请 claim 后独立验证，done 时必须带证据。`,
        type: 'dispatch'
      });
      if (!notice.ok) warning = { code: notice.code || 'TEST_NOTICE_FAILED', message: notice.message || '测试派单通知失败' };
    } catch (error) {
      warning = { code: 'TEST_NOTICE_FAILED', message: String(error && error.message || error).slice(0, 200) };
    }
    const at = new Date().toISOString();
    const written = mutateWorkflowState(ctx.name, (state) => {
      const target = findStateRequirementRow(state, requirementId);
      if (!target) throw new Error(`工作流里没有需求 ${requirementId}`);
      const row = target.row;
      row.status = 'test';
      row.updatedAt = at;
      row.test = { taskId: task.id, by: 'pm', at, claimBy: null, claimedAt: null, doneAt: null, evidence: '' };
      row.history = Array.isArray(row.history) ? row.history : [];
      row.history.push({ at, action: 'test_dispatch', by: 'pm', note: task.id });
      state.phase = 'test';
      pushWorkflowEvent(state, { action: 'test_dispatch', role: 'pm', project: ctx.name, requirementId, taskId: task.id });
    });
    if (!written.ok) return written;
    patchLegacyTask(ctx.name, task.id, { workflow: { requirementId, requirementStatus: 'test', stage: 'test' } });
    const statusSync = syncRequirementStatusArtifacts(ctx, requirementId, 'test', `派测试：${task.id} → tester`);
    const snapshot = readWorkflowSnapshot(ctx.name, ctx.projectPath);
    return {
      ok: true, code: 'OK', protocol: 'legacy', driver: 'team.mjs task create + send',
      requirementId, task, notice,
      requirement: snapshot.ok ? snapshot.requirements.find((row) => row.id === requirementId) : null,
      workflowFile: written.file,
      workflow: snapshot.ok ? snapshot.workflow : null,
      snapshot: snapshot.ok ? snapshot : null,
      statusSync,
      warnings: [...(warning ? [warning] : []), ...statusSync.warnings],
      legacy: { command: 'task create', missingCommands: ctx.capabilities.missing }
    };
  }

  async function ownerAccept(input = {}) {
    const ctx = await ensureWorkflowProject(input);
    if (!ctx.ok) return ctx;
    const role = String(input.role || 'owner').trim();
    if (!['owner', 'pm'].includes(role)) return failure('ROLE_NOT_ALLOWED', '只有 Owner 能验收（PM 可在有效代管下凭证据代验收）', { role });
    const requirementId = String(input.requirementId || '').trim();
    if (!requirementId) return failure('REQUIREMENT_REQUIRED', '缺少需求 id');
    const decision = String(input.decision || input.status || '').trim();
    if (!['accepted', 'rejected', 'iterate', 'terminated'].includes(decision)) {
      return failure('OWNER_DECISION_INVALID', 'Owner 验收决定必须是 accepted / rejected / iterate / terminated', { decision });
    }
    // R-4f99 F-3：验收两种身份——Owner 本人（ui/tty）；有效代管下的 PM 代验收（proxy，必须带证据）。
    // PM 仍然不能代打回/迭代/终止：那三种只能 Owner 做。
    const wantProxyAccept = String(input.channel || '') === 'proxy' || String(input.recordedBy || '') === 'pm';
    const proxyAccept = role === 'pm' && decision === 'accepted' && wantProxyAccept;
    if (['accepted', 'rejected'].includes(decision) && role !== 'owner' && !proxyAccept) {
      return failure('ROLE_NOT_ALLOWED', 'Owner 验收/打回只能由 Owner 执行；PM 只能在有效代管下凭证据代验收（accepted）', { role, decision });
    }
    if (proxyAccept) {
      const recordedBy = String(input.recordedBy || '');
      const authorization = String(input.authorization || '').trim();
      const scope = String(input.proxy || '');
      if (recordedBy !== 'pm') return failure('PROXY_UNAUTHORIZED', 'PM 代验收必须 recordedBy=pm（PM 只代记，不自己决定）');
      if (!authorization) return failure('PROXY_UNAUTHORIZED', 'PM 代验收缺少 Owner 授权来源（authorization）：先开代管再验收');
      if (!['once', 'always'].includes(scope)) return failure('PROXY_UNAUTHORIZED', '代管范围必须是 once 或 always');
    }
    // R-ea86 F-E3：PM 代验收证据两件套——存在/项目内/非 0 字节/截图魔数/报告 PASS 无 FAIL，失败明细走 reason。
    let acceptEvidence = [];
    let acceptWarnings = [];
    if (proxyAccept) {
      const check = acceptEvidenceCheck(ctx.projectPath, input.evidence);
      if (!check.ok) {
        const first = check.missing[0] || { reason: 'evidence_missing' };
        return failure('PM_ACCEPT_EVIDENCE_REQUIRED',
          `PM 代验收证据不合格（${first.reason}）：${first.note || first.path || '缺证据'}；两件套＝测试报告（含 PASS 不含 FAIL）+ 截图（png/jpg/webp）`,
          { requirementId, reason: first.reason, missing: check.missing });
      }
      acceptEvidence = check.evidence;
      acceptWarnings = check.warnings;
    }
    const mode = normalizeTeamMode(input.teamMode || ctx.teamMode);
    const caps = legacyCapabilities();
    const ownerCommand = Boolean(caps.available && caps.commands && caps.commands.owner);
    const workflowCommand = Boolean(caps.available && caps.commands && caps.commands.workflow);
    const isAcceptDecision = ['accepted', 'rejected'].includes(decision);
    // 验收也要走旧协议命令：Owner 验收/打回用 owner，迭代/终止用 workflow。
    // 两条命令当前 team.mjs 都是 NOT_IMPLEMENTED；缺哪条就由壳层收口哪条（Fast / Full 一致），
    // 返回值明确 SHELL_OWNED，不冒充旧命令执行。命令真存在时仍走旧协议。
    const protocolCommand = isAcceptDecision ? 'owner' : 'workflow';
    const shellOwnedCloseout = isAcceptDecision ? !ownerCommand : !workflowCommand;
    const commandGuard = shellOwnedCloseout ? null : requireLegacyCommand(protocolCommand);
    if (commandGuard) return { ...commandGuard, project: ctx.name, projectPath: ctx.projectPath };
    // 只有正文的旧需求：先补任务/工作流行，否则验收连“需求存在”都查不到。
    const imported = ensureLegacyRequirementRecord(ctx.name, ctx.projectPath, requirementId);
    if (!imported.ok) return imported;
    const requirementKey = String(imported.id || requirementId);
    // R-b52b F-8：项目角色集只认 项目.json.roleIds；不含 tester 时验收 boot 门改由 PM 把。
    // 必须在使用前算好（gateRole / 状态门 / 落账三处都用），否则会命中 TDZ（noTester 未初始化）。
    const acceptRoleIds = projectRoleIdsOf(ctx.name);
    const noTester = !acceptRoleIds.includes('tester');
    const gateRole = ['accepted', 'rejected'].includes(decision) ? (noTester ? 'pm' : 'tester') : 'pm';
    // B-b55c：验收前必须重新读盘（绕过 mtime+size 缓存），列表与确认用同一份 工作流.json、同一时刻的真相。
    // 旧实现读的可能是缓存里的旧快照，也可能按归一化 key 命中同秒的另一条需求，于是"列表 test_done、
    // 点确认却报 accepted"。这里带上来源（文件 + 落盘 updatedAt + mtime + 本次读盘时间）。
    const read = readWorkflowState(ctx.name, { fresh: true });
    if (!read.ok) return read;
    const source = workflowStateSource(read);
    const found = findStateRequirementRowDetailed(read.state, requirementId);
    if (found && found.ambiguous) {
      return failure(
        'REQUIREMENT_AMBIGUOUS',
        `需求号 ${requirementId} 同时命中 ${found.candidates.length} 条（${found.candidates.map((row) => `${row.id}=${row.status}`).join(' / ')}），请用完整需求 id 再验收；不替你猜是哪一条`,
        { requirementId, candidates: found.candidates, source }
      );
    }
    if (!found || !found.row) {
      return failure('REQUIREMENT_NOT_FOUND', `工作流里没有需求 ${requirementId}`, { requirementId, source });
    }
    const meta = found.row;
    const resolvedRequirementId = String(meta.id || found.key || requirementId);
    const diskStatus = String(meta.status || '');
    // R-ea86 F-E4：重复验收同一需求 → 幂等返回 ALREADY_ACCEPTED，不追加第二条 decided 记录。
    if (decision === 'accepted' && diskStatus === 'accepted') {
      return failure('ALREADY_ACCEPTED', `需求 ${resolvedRequirementId} 已经是 accepted，不重复落账（没有新增第二条决定）`, {
        requirementId, resolvedRequirementId, status: diskStatus, source
      });
    }
    // R-ea86 F-E3 时效：报告日期 ≥ reviewedAt（回退 updatedAt）；两边都缺只记 warning，不阻断。
    if (proxyAccept) {
      const baseline = String(meta.reviewedAt || meta.updatedAt || '');
      const stale = acceptEvidenceStaleness(acceptEvidence, baseline);
      if (!stale.ok) {
        return failure('PM_ACCEPT_EVIDENCE_REQUIRED',
          `PM 代验收证据过期（evidence_stale）：报告日期 ${stale.reportAt} 早于时效基线 ${stale.baselineAt}`,
          { requirementId, reason: stale.reason || 'evidence_stale', missing: [{ path: '', kind: 'report', reason: 'evidence_stale', note: `报告 ${stale.reportAt} < 基线 ${stale.baselineAt}` }] });
      }
      if (stale.warning) acceptWarnings = [...acceptWarnings, { kind: 'report', reason: stale.warning, note: '时效基线缺失或报告无日期，只记 warning' }];
    }
    // 界面带上它当时看到的状态时，先判"界面那份是不是过期了"：两侧状态 + 来源时间一起说清，
    // 不把磁盘的真实状态说成界面看到的相反状态，也不让 Owner 拿一个过期列表反复点。
    const expectedStatus = String(input.expectedStatus || '').trim();
    const expectedAt = String(input.expectedUpdatedAt || '').trim();
    if (expectedStatus && expectedStatus !== diskStatus) {
      return failure(
        'WORKFLOW_STATE_CHANGED',
        `界面看到的是 ${expectedStatus}${expectedAt ? `（列表读于 ${expectedAt}）` : ''}，磁盘上 ${resolvedRequirementId} 现在是 ${diskStatus}`
        + `（来源 ${source.file}，落盘 updatedAt ${source.updatedAt || '未记'}，mtime ${source.mtime || '未记'}，本次读盘 ${source.readAt}）。已按磁盘为准，请刷新列表后再操作`,
        { requirementId, resolvedRequirementId, expectedStatus, status: diskStatus, source }
      );
    }
    // R-b52b F-8：roleIds 不含 tester 时，验收前置从「test_done」改为「dev_done/test 也可」，但证据两件套不省；
    // 落账追加 signedBy=pm / testGate=pm_signed（只写 decisions，不新增任务字段）。
    // acceptRoleIds / noTester 已在上方（gateRole 之前）算好，这里只做状态门。
    if (diskStatus !== 'test_done' && !noTester) {
      return failure(
        'TEST_NOT_DONE',
        `需求 ${resolvedRequirementId} 当前状态是 ${diskStatus}，测试 done 后才能 Owner 验收（来源 ${source.file}，落盘 updatedAt ${source.updatedAt || '未记'}，本次读盘 ${source.readAt}）`,
        { requirementId, resolvedRequirementId, status: diskStatus, source }
      );
    }
    if (noTester && !['dev_done', 'test', 'test_done'].includes(diskStatus)) {
      return failure(
        'TEST_NOT_DONE',
        `需求 ${resolvedRequirementId} 当前状态是 ${diskStatus}；无 tester 时也只允许在 dev_done / test / test_done 验收（证据两件套仍必须齐）`,
        { requirementId, resolvedRequirementId, status: diskStatus, roleIds: acceptRoleIds, source }
      );
    }
    // Owner 验收弹窗里的“迭代”也是同一道迭代闸门：其他在办需求没验收时不能启动下一轮。
    if (decision === 'iterate') {
      const businessGate = iterateGuard(ctx.name, read.state, { exceptRequirementId: resolvedRequirementId, projectPath: ctx.projectPath });
      if (!businessGate.ok) return { ...businessGate, projectPath: ctx.projectPath, workflowFile: read.file };
    }
    const gate = await ensureWorkflowBoot(ctx.name, ctx.projectPath, gateRole, { requirementId });
    if (!gate.ok) return gate;
    const at = new Date().toISOString();
    const fromRound = Number(read.state.round || 1);
    const opinion = String(input.opinion || '').slice(0, 1000);
    const protocolAction = ['accepted', 'rejected'].includes(decision)
      ? 'accept'
      : (decision === 'iterate' ? 'iterate' : 'terminate');
    let ownerConfirmNonce = String(input.ownerConfirmNonce || '').trim();
    let protocolRun = null;
    if (shellOwnedCloseout) {
      // 壳层收口：protocolRun 只是“本次动作已由壳层记账”的占位，不带任何旧命令返回值，
      // 调用方按 legacy.shellOwned / code 判断，不能当旧命令执行成功。
      protocolRun = {
        ok: true,
        code: isAcceptDecision ? 'OWNER_SHELL_OWNED' : 'WORKFLOW_SHELL_OWNED',
        value: {},
        argv: [],
        mocked: false,
        shellOwned: true
      };
    } else {
      if (protocolCommand === 'owner' && !ownerConfirmNonce && input.ownerConfirmed === true) {
        const confirmation = await issueLegacyOwnerConfirmation({
          projectName: ctx.name, requirementId, decision, action: 'accept'
        });
        if (!confirmation.ok) return confirmation;
        ownerConfirmNonce = confirmation.nonce;
      }
      protocolRun = await runLegacyWorkflowProtocol(protocolCommand, {
        projectName: ctx.name,
        projectPath: ctx.projectPath,
        requirementId,
        decision,
        opinion,
        role,
        action: protocolAction,
        sessionId: String(input.sessionId || '').trim(),
        ownerConfirmNonce
      });
      if (!protocolRun.ok) return protocolRun;
      if (protocolCommand === 'owner') {
        const legacyRequirement = protocolRun.value && (protocolRun.value.requirement || protocolRun.value.task);
        if (!legacyRequirement || !legacyRequirement.id || String(legacyRequirement.id) !== requirementId) {
          return failure('BAD_JSON', '旧 owner 验收没有返回本次需求，拒绝把验收当作已发生', {
            command: 'owner', protocol: 'legacy', value: protocolRun.value
          });
        }
      }
    }
    // 验收通过必须先让旧需求任务真正 done；失败就整次验收失败，不能界面成功、旧账本还开着。
    let requirementTaskDone = null;
    if (decision === 'accepted') {
      const requirementTask = readJsonSafe(legacyTaskFilePath(ctx.name, requirementKey));
      if (!requirementTask) {
        return failure('REQUIREMENT_TASK_MISSING', `需求任务 ${requirementKey} 在旧 任务/ 里不存在，无法收口`, { requirementId: requirementKey });
      }
      if (requirementTask.status === 'done') {
        requirementTaskDone = { ok: true, code: 'ALREADY_DONE' };
      } else {
        // 证据门（T-70a9）：task done 的证据必须是项目内真实文件路径；验收这里补一份
        // 需求/验收/<需求>-验收记录.md（mtime=本次验收），否则会 EVIDENCE_FILE_MISSING。
        let acceptRecordRel = '';
        try {
          const rel = path.join('需求', '验收', `${requirementKey}-验收记录.md`);
          const abs = path.join(ctx.projectPath, rel);
          fs.mkdirSync(path.dirname(abs), { recursive: true });
          fs.writeFileSync(abs, `# ${requirementKey} 验收记录\n\n- 决定：${decision}\n- 执行人：${role}\n- 时间：${at}\n- 意见：${opinion || '（无）'}\n`, 'utf8');
          acceptRecordRel = rel.split(path.sep).join('/');
        } catch { acceptRecordRel = ''; }
        requirementTaskDone = await runLegacyCommand(ctx.name, 'pm', 'task done', (token) => [
          'task', 'done', '--boot', token, '--id', requirementKey,
          '--evidence', `${acceptRecordRel ? acceptRecordRel + '（' : ''}Owner 验收通过${opinion ? '：' + opinion.slice(0, 120) : ''}${acceptRecordRel ? '）' : ''}`
        ], { sessionId: String(input.sessionId || '').trim() });
        if (!requirementTaskDone.ok) {
          return {
            ...requirementTaskDone,
            ok: false,
            code: requirementTaskDone.code || 'OWNER_TASK_CLOSE_FAILED',
            message: `Owner 验收前关闭旧需求任务失败：${String(requirementTaskDone.message || '').slice(0, 300)}`
          };
        }
      }
    }
    // 旧 owner / workflow 命令已经按验收/迭代/终止各写了一次审计记录；
    // 这里按同一动作族去重，兼容 mock/缺记录时仍由壳补写。
    const acceptHistoryActions = decision === 'accepted' ? ['owner_accept']
      : decision === 'rejected' ? ['owner_accept', 'owner_reject']
        : decision === 'iterate' ? ['owner_accept', 'owner_iterate']
          : ['owner_accept', 'terminate'];
    const acceptEventActions = decision === 'accepted' || decision === 'rejected' ? ['owner_accept']
      : decision === 'iterate' ? ['owner_accept', 'iterate']
        : ['owner_accept', 'terminate'];
    // 旧 owner 命令已写入 acceptance/confirmation；壳只补缺失字段，不能覆盖认证信息。
    // 注意 requirement.acceptance 是「验收标准」字符串，不是 acceptance 对象；
    // 认证对象在顶层 acceptance / requirement.workflow.ownerAcceptance / 工作流.json。
    const ownerAcceptanceSources = protocolCommand === 'owner'
      ? [
        protocolRun.value && protocolRun.value.acceptance,
        protocolRun.value && protocolRun.value.requirement
          && protocolRun.value.requirement.workflow
          && protocolRun.value.requirement.workflow.ownerAcceptance,
        protocolRun.value && protocolRun.value.requirement
          && protocolRun.value.requirement.workflow
          && protocolRun.value.requirement.workflow.acceptance,
        protocolRun.value && protocolRun.value.requirement
          && isPlainObject(protocolRun.value.requirement.acceptance)
          ? protocolRun.value.requirement.acceptance
          : null
      ]
      : [];
    const legacyAcceptanceReview = protocolRun.value && protocolRun.value.ownerReview;
    // Owner 验收通道只允许 ui/tty：来源依次取调用方、旧命令返回、已有验收记录；都没有就拒绝，
    // 不再静默回退旧通道名，避免验收审计通道失真。
    const acceptChannelCandidates = [
      String(input.channel || ''),
      String((protocolRun.value && (protocolRun.value.channel || (protocolRun.value.ownerReview && protocolRun.value.ownerReview.channel))) || ''),
      String((legacyAcceptanceReview && legacyAcceptanceReview.channel) || ''),
      String((meta.acceptance && meta.acceptance.channel) || (read.state.ownerReview && read.state.ownerReview.channel) || '')
    ];
    // PM 代验收固定 channel=proxy（已在上方校验 recordedBy/authorization/scope/证据）；Owner 本人仍只认 ui/tty。
    const acceptChannel = proxyAccept ? 'proxy' : acceptChannelCandidates.find((candidate) => ['ui', 'tty'].includes(candidate));
    if (!acceptChannel) {
      return failure('OWNER_CHANNEL_REQUIRED', 'Owner 验收必须显式携带 channel=ui 或 tty，不再回退旧通道', { requirementId });
    }
    const written = mutateWorkflowState(ctx.name, (state) => {
      // 写路径也按已解析出的完整需求 id 命中：短号歧义在上面已经拒收，这里不允许再退回归一化猜。
      const target = findStateRequirementRow(state, resolvedRequirementId);
      if (!target) throw new Error(`工作流里没有需求 ${resolvedRequirementId}`);
      const row = target.row;
      const previousStateOwnerReview = isPlainObject(state.ownerReview) ? state.ownerReview : null;
      const previousAcceptance = acceptanceFields(row.acceptance);
      const mergedAcceptance = protocolCommand === 'owner'
        ? mergePlainObjects(previousAcceptance, ...ownerAcceptanceSources.map(acceptanceFields))
        : {};
      const mergedOwnerReview = protocolCommand === 'owner'
        ? mergePlainObjects(previousStateOwnerReview, legacyAcceptanceReview, ...ownerAcceptanceSources.map(acceptanceFields))
        : {};
      const auth = protocolCommand === 'owner'
        ? mergeOwnerAuthFields(
          previousAcceptance,
          previousStateOwnerReview,
          ...ownerAcceptanceSources,
          legacyAcceptanceReview,
          protocolRun.value
        )
        : {};
      if (protocolCommand === 'owner') {
        // Owner 确认码已废弃：验收直接以 role=owner 接受。
        // 通道已在 mutate 之前校验为 ui/tty；PM 代验收为 proxy（带证据与授权来源）。
        auth.channel = acceptChannel;
        auth.actor = proxyAccept ? 'pm' : (auth.actor || (role === 'owner' ? 'owner' : role));
        auth.at = auth.at || at;
        if (proxyAccept) {
          auth.recordedBy = 'pm';
          auth.proxy = String(input.proxy || '');
          auth.authorization = String(input.authorization || '');
          auth.evidence = acceptEvidence;
        }
      }
      row.acceptance = {
        ...mergedAcceptance,
        ...auth,
        status: decision,
        by: mergedAcceptance.by || (role === 'owner' ? 'Owner' : role),
        actor: auth.actor || (role === 'owner' ? 'owner' : role),
        at,
        opinion
      };
      row.updatedAt = at;
      // R-4f99 AC4 / 字段清单：验收必须写行级 decisions（唯一真相），并补 closedAt/closedBy。
      // Owner 验收计 channel=ui；PM 代验收计 channel=proxy + recordedBy=pm + evidence[{path,sha256,kind}]。
      const acceptRecord = {
        status: decision,
        decision,
        channel: acceptChannel,
        // R-ea86 F-E4：decidedBy=授权人（owner），actor/recordedBy=执行人（pm）——审计必须分得清“谁授权、谁执行”。
        decidedBy: proxyAccept ? 'owner' : 'Owner',
        actor: proxyAccept ? 'pm' : 'owner',
        by: proxyAccept ? 'Owner（授权 PM 代验收）' : 'Owner',
        at,
        opinion,
        ...(proxyAccept
          ? {
            recordedBy: 'pm',
            proxy: String(input.proxy || ''),
            authorization: String(input.authorization || ''),
            evidence: acceptEvidence,
            ...(acceptWarnings.length ? { warnings: acceptWarnings } : {})
          }
          : {}),
        // R-b52b F-8：无 tester 的验收由 PM 代签测试结论；signedBy/testGate 只进 decisions，不加任务字段。
        ...(noTester && decision === 'accepted' ? { signedBy: 'pm', testGate: 'pm_signed' } : {})
      };
      row.decisions = Array.isArray(row.decisions) ? row.decisions : [];
      row.decisions.push(acceptRecord);
      if (decision === 'accepted' || decision === 'terminated') {
        row.closedAt = at;
        row.closedBy = proxyAccept ? 'pm' : 'owner';
      }
      pushHistoryOnce(row, { at, action: 'owner_accept', by: role, note: decision }, {
        actions: acceptHistoryActions,
        requirementId,
        matchNote: false
      });
      if (decision === 'accepted') {
        row.status = 'accepted';
        state.phase = 'accepted';
        state.ownerReview = {
          ...mergedOwnerReview,
          ...auth,
          required: true,
          status: 'approved',
          kind: 'acceptance',
          by: mergedOwnerReview.by || role,
          actor: auth.actor || (role === 'owner' ? 'owner' : role),
          at,
          opinion
        };
      } else if (decision === 'iterate') {
        row.status = 'iteration';
        state.phase = 'iteration';
        // 旧 workflow iterate 已经把 round +1；壳这里只能用命令返回的新轮次，
        // 不能再 +1，否则界面会一次跳两轮。壳层收口时没有旧命令返回值，壳自己 +1。
        const toolRound = Number(protocolRun.value && protocolRun.value.round);
        state.round = Number.isFinite(toolRound) && toolRound > 0
          ? toolRound
          : (shellOwnedCloseout ? fromRound + 1 : Number(state.round || 1));
        if (Number(state.round) > fromRound) invalidateBootsForRound(state, fromRound, Number(state.round), at);
        for (const queued of Object.values(state.requirements || {})) {
          if (queued.queued && Number(queued.round || state.round) <= state.round) {
            queued.queued = false;
            queued.round = state.round;
            queued.updatedAt = at;
          }
        }
        state.ownerReview = { required: true, status: 'approved', kind: 'iterate', by: role, at, opinion };
      } else if (decision === 'terminated') {
        row.status = 'terminated';
        state.phase = 'terminated';
        state.terminatedAt = at;
        state.terminatedBy = role;
        state.ownerReview = { required: true, status: 'rejected', kind: 'terminate', by: role, at, opinion };
      } else {
        row.status = 'rejected';
        // 验收打回：需求同样回到需求评审（改完重走评审/派单），不停在 requirement。
        state.phase = REJECTED_REQUIREMENT_PHASE;
        state.ownerReview = {
          ...mergedOwnerReview,
          ...auth,
          required: true,
          status: 'rejected',
          kind: 'acceptance',
          by: mergedOwnerReview.by || role,
          actor: auth.actor || (role === 'owner' ? 'owner' : role),
          at,
          opinion
        };
      }
      pushWorkflowEventOnce(state, { at, action: 'owner_accept', role, project: ctx.name, requirementId: resolvedRequirementId, note: decision }, {
        actions: acceptEventActions,
        requirementId: resolvedRequirementId,
        matchNote: false
      });
    });
    if (!written.ok) return written;
    // 终止单个需求时同样收口旧任务；验收通过的任务已经在上面 done。
    const toolClosed = decision === 'terminated' && Array.isArray(protocolRun.value && protocolRun.value.closedTasks)
      ? protocolRun.value.closedTasks.map(String)
      : [];
    const shellClosed = decision === 'terminated'
      ? closeLegacyTasksForTermination(ctx.name, [resolvedRequirementId], `Owner 终止${opinion ? '：' + opinion.slice(0, 120) : ''}`)
      : [];
    const closedTasks = [...new Set([...toolClosed, ...shellClosed])];
    // 验收的四种决定都同步正文/总览与需求任务；accepted/terminated 旧命令已写过，
    // 这里按同一状态去重，不会重复追加状态记录。
    const docStatus = decision === 'accepted' ? 'accepted'
      : decision === 'rejected' ? 'rejected'
        : decision === 'iterate' ? 'iteration' : 'terminated';
    const statusSync = syncRequirementStatusArtifacts(ctx, requirementKey, docStatus, opinion);
    const docWarnings = statusSync.warnings;
    let ownerNote = null;
    let warning = null;
    try {
      ownerNote = await recordOwnerDecision({ name: ctx.name, teamName: ctx.name, path: ctx.projectPath }, {
        status: decision === 'accepted' || decision === 'iterate' ? 'approved' : 'rejected',
        opinion: `[验收${decision}] ${opinion}`.slice(0, 1000),
        roundKey: `${ctx.name}|${read.state.round}|${Object.keys(read.state.requirements).length}`,
        by: 'Owner',
        channel: acceptChannel,
        requirementId: resolvedRequirementId
      });
    } catch (error) {
      warning = { code: 'OWNER_NOTE_FAILED', message: String(error && error.message || error).slice(0, 300) };
    }
    const projectIndex = await refreshProjectIndex(ctx.name, ctx.projectPath);
    const indexWarning = projectIndexWarning(projectIndex);
    let snapshot = readWorkflowSnapshot(ctx.name, ctx.projectPath);
    if (snapshot.ok) {
      const fresh = readWorkflowState(ctx.name);
      if (fresh.ok && fresh.state.ownerReview && fresh.state.ownerReview.kind !== (decision === 'accepted' ? 'acceptance' : decision === 'iterate' ? 'iterate' : 'terminate')) {
        const kind = decision === 'accepted' ? 'acceptance' : decision === 'iterate' ? 'iterate' : 'terminate';
        const merged = mutateWorkflowState(ctx.name, (state) => {
          state.ownerReview = { ...(state.ownerReview || {}), kind };
        });
        if (merged.ok) snapshot = readWorkflowSnapshot(ctx.name, ctx.projectPath);
      }
    }
    return {
      ok: true,
      // 壳层收口时按动作族给出明确 code，不能继续用 OK 让上游误以为是旧命令执行。
      code: shellOwnedCloseout ? (isAcceptDecision ? 'OWNER_SHELL_OWNED' : 'WORKFLOW_SHELL_OWNED') : 'OK',
      protocol: shellOwnedCloseout ? 'shell' : 'legacy',
      driver: shellOwnedCloseout
        ? (isAcceptDecision ? 'workbench owner accept' : 'workbench owner workflow')
        : (protocolCommand === 'owner' ? 'team.mjs owner + owner-note.mjs' : 'team.mjs workflow + owner-note.mjs'),
      legacyCommandStatus: shellOwnedCloseout ? 'SHELL_OWNED' : 'AVAILABLE',
      shellOwned: shellOwnedCloseout,
      requirementId,
      resolvedRequirementId,
      // 验收前后都带着同一份来源证据：界面能写清"这条状态哪来的、什么时候读的"。
      source: { ...source, writtenAt: written.ok ? new Date().toISOString() : '' },
      decision,
      channel: acceptChannel,
      proxyAccept,
      evidence: proxyAccept ? acceptEvidence : [],
      requirement: snapshot.ok ? snapshot.requirements.find((row) => row.id === resolvedRequirementId) : null,
      ownerReview: snapshot.ok ? snapshot.ownerReview : null,
      ownerNote: ownerNote ? { ok: Boolean(ownerNote.ok), workflowFile: ownerNote.workflowFile || null, notified: ownerNote.notified || null } : null,
      requirementTaskDone: requirementTaskDone ? { ok: Boolean(requirementTaskDone.ok), code: requirementTaskDone.code || 'OK', alreadyDone: requirementTaskDone.code === 'ALREADY_DONE' } : null,
      closedTasks,
      statusSync,
      workflowFile: written.file,
      workflow: snapshot.ok ? snapshot.workflow : null,
      snapshot: snapshot.ok ? snapshot : null,
      projectIndex,
      warnings: [
        ...(Array.isArray(protocolRun.value && protocolRun.value.warnings) ? protocolRun.value.warnings : []),
        ...(warning ? [warning] : []),
        ...(indexWarning ? [indexWarning] : []),
        ...docWarnings
      ],
      legacy: {
        command: protocolCommand,
        action: protocolAction,
        // 动作可用，但 commandImplemented/legacyCommandAvailable 如实反映旧命令是否存在。
        commandAvailable: true,
        commandImplemented: !shellOwnedCloseout,
        legacyCommandAvailable: !shellOwnedCloseout,
        shellOwned: shellOwnedCloseout,
        code: shellOwnedCloseout ? (isAcceptDecision ? 'OWNER_SHELL_OWNED' : 'WORKFLOW_SHELL_OWNED') : 'OK',
        argv: Array.isArray(protocolRun.argv) ? protocolRun.argv : [],
        mocked: Boolean(protocolRun.mocked),
        missingCommands: (ctx.capabilities.missing || []).filter((name) => !(shellOwnedCloseout && name === protocolCommand))
      }
    };
  }

  /**
   * 旧协议唤醒文案（四步）：boot → inbox --all → read --id → ack --id。
   * 主进程只负责把角色会话叫醒；令牌/命令必须完整交给角色，回执由角色自己执行。
   * 文案只包含路径/命令，不含任何凭据。
   *
   * 精准投喂：唤醒正文 = buildRoleBrief 的结构化简报 + 四步命令，不再贴派单全文和历史；
   * 但必须说清“执行正文动作、按角色产出、完成后回执”，否则角色会把派单当成只需 ack 的通知。
   * 简报 ≤800 字，整条唤醒消息按角色输出上限（需求800/产品800/开发1200/测试1000）截断。
   */
  function wakeMessageFor(input = {}) {
    const projectName = String(input.projectName || '').trim();
    const role = String(input.role || '').trim();
    const from = String(input.from || input.sender || '').trim();
    const messageId = String(input.messageId || '').trim();
    const subject = String(input.subject || '任务派单').slice(0, 80);
    const task = String(input.task || '').trim();
    const ackRequired = input.ackRequired !== false;
    // 三型只判一次：派单 = PM → 非 PM 且要回执；回执/通知/角色互发只发“去 inbox 读”的提示。
    // 旧调用方（不传 from）保持派单语义，兼容 main.js 既有自测；PM 自己永远不是派单执行者。
    const explicitDispatch = typeof input.dispatch === 'boolean' ? input.dispatch : null;
    const declaredType = String(input.type || '').trim().toLowerCase();
    const dispatchByRule = role !== 'pm' && (from === 'pm' ? ackRequired !== false : !from);
    const isDispatch = explicitDispatch !== null
      ? explicitDispatch
      : (declaredType === 'receipt' || declaredType === 'notice' ? false : dispatchByRule);
    const quote = (value) => '"' + String(value == null ? '' : value).replace(/"/g, '\\"') + '"';
    const tool = layout.teamTool;
    if (!isDispatch) {
      const noticeHeader = `【团队消息 ${messageId || '(缺 id)'}】${subject}`;
      const noticeText = [
        noticeHeader,
        `${from ? from + ' → ' : ''}${role} · 项目：${projectName}`,
        '这条是回复/通知，不是新派单；按需读取并按正常流程回执即可，不必为它新建任务。',
        `请按需读取：node ${quote(tool)} inbox --boot <令牌> --all，再 read --boot <令牌> --id ${messageId}；需要回执时只 ack。`,
        `只回一行：已读/已回执 + ${messageId}。`
      ].join('\n');
      return {
        ok: Boolean(projectName && ROLE_IDS.includes(role) && messageId),
        text: noticeText,
        steps: {
          inbox: `node ${quote(tool)} inbox --boot <令牌> --all`,
          read: `node ${quote(tool)} read --boot <令牌> --id ${messageId}`
        },
        ackRequired,
        role,
        from,
        project: projectName,
        messageId,
        executionRequired: false,
        dispatch: false,
        type: declaredType || 'notice',
        brief: null,
        briefChars: 0,
        limit: 0,
        budget: 0,
        totalChars: noticeText.length
      };
    }
    // 回执写“执行结果”，不能只写“已收到”；产出物可以是需求号，也可以是文件路径。
    const ackNote = '已执行 ' + (task || messageId) + '：产出 <文件/需求号>；边界';
    const steps = {
      boot: `node ${quote(tool)} boot --role ${role} --project ${quote(projectName)}`,
      inbox: `node ${quote(tool)} inbox --boot <令牌> --all`,
      read: `node ${quote(tool)} read --boot <令牌> --id ${messageId}`,
      ack: ackRequired ? `node ${quote(tool)} ack --boot <令牌> --id ${messageId} --note ${quote(ackNote)}` : ''
    };
    const analystFromPm = role === 'analyst' && from === 'pm';
    const instructionLines = [
      '',
      // 派单语义的核心：角色要做正文里的动作并产出，不是只回执。
      '执行消息正文指定的动作，按角色职责产出文件/需求，完成后回执结果；只回执不执行视为失败。',
      `1) boot：${steps.boot}`,
      `2) inbox：取第 1 步令牌执行 ${steps.inbox}`,
      `3) read：${steps.read}（先读正文）`,
      ackRequired
        ? `4) ack：${steps.ack}`
        : '4) ack：本条不要求回执，但正文动作仍必须执行并产出。',
      '工作台壳不会代你 ack。'
    ];
    if (analystFromPm) {
      instructionLines.push('PM→需求分析师：必须执行 req create（参数取自正文），在项目 需求/ 下产出 R-*.md；只回执不建档视为失败。');
    }
    const commandLines = instructionLines.join('\n');
    const header = `【团队派单 ${messageId || '(缺 id)'}】${subject}`;
    const roleLimit = Number(ROLE_BRIEF_LIMITS[role] || 800);
    // 简报优先；buildRoleBrief 读不到时只退回派单摘要（仍不贴全文/历史）。
    const brief = buildRoleBrief({ name: projectName }, role, task);
    const overhead = (header + commandLines).length + 2;
    // 总预算按角色上限（开发 1200 / 测试 1000 不再被简报 800 夹死）；简报正文本身仍 ≤800。
    const budget = Math.max(200, roleLimit);
    const available = Math.max(120, budget - overhead);
    const briefText = brief.ok
      ? brief.text.slice(0, Math.min(BRIEF_MAX_CHARS, available))
      : `派单 ${messageId}：${subject}${task ? '（任务 ' + task + '）' : ''}`.slice(0, Math.min(BRIEF_MAX_CHARS, available));
    const lines = [header, briefText, commandLines];
    // 简报为空时不要留出两个空行；其余情况保留“标题 / 简报 / 四步”三段。
    const text = lines.filter((part) => part !== '').join('\n').replace(/\n{3,}/g, '\n\n');
    return {
      ok: Boolean(projectName && ROLE_IDS.includes(role) && messageId),
      text,
      steps,
      ackRequired,
      role,
      from,
      project: projectName,
      messageId,
      executionRequired: true,
      dispatch: true,
      type: 'dispatch',
      analystReqCreate: analystFromPm,
      brief: brief.ok ? brief : null,
      briefChars: briefText.length,
      limit: roleLimit,
      budget,
      totalChars: text.length
    };
  }

  /** 切换团队当前项目（= 切换工作区），走旧协议 project use（只有 PM 能切）。 */
  async function activateProject(projectName, sessionId = '') {
    const name = String(projectName || '').trim();
    if (!name) return failure('PROJECT_REQUIRED', '缺少团队项目名');
    if (!fs.existsSync(layout.teamFile)) return failure('NO_TEAM', '团队工具尚未初始化');
    if (!fs.existsSync(layout.teamTool)) return failure('TOOL_MISSING', '团队工具不存在：' + layout.teamTool);
    const team = readJsonSafe(layout.teamFile);
    if (!team || team.activeProject === name) {
      return { ok: true, code: 'OK', project: name, unchanged: true };
    }
    return withBootToken(name, 'pm', async (token) => {
      const run = await runNode(layout.teamTool, ['project', 'use', '--boot', token, '--name', name, '--json'], { timeoutMs: TIMEOUTS.activate });
      if (!run.ok) return { ...publicRun(run), ok: false, code: run.errorCode || 'TEAM_ACTIVATE_FAILED' };
      const value = run.value || {};
      if (value.ok === false) return failure(value.code || 'TEAM_ACTIVATE_FAILED', value.message || '切换项目失败', {});
      return { ok: true, code: 'OK', project: value.project || name, sessionId: sessionId || '' };
    }, sessionId);
  }

  /**
   * 旧协议“当前工作区”指针（team.mjs launch 也会写同一份）。
   * 只用于让旧工具/旧看板看到“现在在哪个项目”，不承载任何业务真相。
   */
  function setCurrentWorkspace(record) {
    if (!record || typeof record !== 'object') return failure('BAD_RECORD', '当前工作区记录无效');
    try {
      fs.mkdirSync(path.dirname(layout.currentWorkspaceFile), { recursive: true });
      const tmp = layout.currentWorkspaceFile + '.awb-tmp-' + process.pid + '-' + crypto.randomUUID().slice(0, 8);
      fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, layout.currentWorkspaceFile);
      return { ok: true, code: 'OK', file: layout.currentWorkspaceFile };
    } catch (error) {
      return failure('CURRENT_WORKSPACE_WRITE_FAILED', '写当前工作区失败：' + String(error && error.message || error).slice(0, 200));
    }
  }

  function readCurrentWorkspace() {
    return readJsonSafe(layout.currentWorkspaceFile);
  }

  /**
   * 把 DSH workspaceId 写回项目目录的 workspace.json（旧工具/旧列表都读它）。
   * 只合并 dshWorkspaceId / engineUrl / updatedAt；文件不存在就跳过，绝不新建。
   */
  function recordWorkspaceBinding(projectPath, binding = {}) {
    const dir = String(projectPath || '').trim();
    if (!dir) return failure('PROJECT_PATH_REQUIRED', '项目目录不能为空');
    const file = path.join(path.resolve(dir), 'workspace.json');
    const meta = readJsonSafe(file);
    if (!meta) return { ok: false, code: 'WORKSPACE_META_MISSING', message: '项目目录没有 workspace.json（先补齐团队项目）', file };
    const next = { ...meta };
    if (binding.workspaceId) next.dshWorkspaceId = String(binding.workspaceId);
    if (binding.engineUrl) next.engineUrl = String(binding.engineUrl);
    next.updatedAt = new Date().toISOString();
    try {
      const tmp = file + '.awb-tmp-' + process.pid + '-' + crypto.randomUUID().slice(0, 8);
      fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
      fs.renameSync(tmp, file);
      return { ok: true, code: 'OK', file, meta: next };
    } catch (error) {
      return failure('WORKSPACE_META_WRITE_FAILED', '写 workspace.json 失败：' + String(error && error.message || error).slice(0, 200), { file });
    }
  }

  const launchLocks = new Map();

  async function launchSessions(project, launchOptions = {}) {
    const real = launchOptions.dryRun === false;
    if (!real) return launchSessionsUnlocked(project, launchOptions);
    const key = path.resolve(String((project && project.path) || '')) + ':launch';
    if (launchLocks.has(key)) return launchLocks.get(key);
    const task = launchSessionsUnlocked(project, launchOptions).finally(() => launchLocks.delete(key));
    launchLocks.set(key, task);
    return task;
  }

  async function launchSessionsUnlocked(project, launchOptions = {}) {
    const source = project || {};
    const projectPath = String(source.path || '').trim();
    if (!projectPath) return failure('PROJECT_PATH_REQUIRED', '项目目录不能为空');
    const resolvedPath = path.resolve(projectPath);
    const dryRun = launchOptions.dryRun !== false;
    const mode = normalizeTeamMode(launchOptions.teamMode || source.teamMode);
    // launch.mjs 会给“非标准工作区”补齐六角色目录；Fast 在真实启动后要撤掉本次新造的
    // product/programmer2 目录（启动前已存在的用户目录保留）。
    const excludedBefore = mode === 'fast' ? snapshotExcludedRoleDirs(resolvedPath, mode) : {};
    const allowedRoles = roleIdsForTeamMode(mode);
    const requestedRoles = launchOptions.roles;
    const roles = (requestedRoles === undefined || requestedRoles === null || requestedRoles === '')
      ? allowedRoles.slice()
      : normalizeRoles(requestedRoles);
    const outsideMode = roles.filter((role) => !allowedRoles.includes(role));
    if (outsideMode.length) {
      return failure('ROLE_NOT_IN_TEAM_MODE', `${mode} 模式不创建这些角色：${outsideMode.join(', ')}`, {
        teamMode: mode, allowedRoles, requestedRoles: roles, dryRun
      });
    }
    if (!roles.length) {
      return failure('BAD_ROLE', `角色无效；可用角色：${allowedRoles.join(', ')}`, { teamMode: mode, allowedRoles });
    }
    if (!isDirectory(resolvedPath)) {
      return failure('PROJECT_DIR_MISSING', `项目目录不存在：${resolvedPath}`, { dryRun, roles });
    }
    if (!fs.existsSync(layout.launchTool)) {
      return failure('TOOL_MISSING', `团队启动工具不存在：${layout.launchTool}`, { dryRun, roles });
    }
    if (dryRun && !fs.existsSync(layout.teamFile)) {
      return failure('NO_TEAM', '团队工具尚未初始化；先创建/恢复项目，或运行 team.mjs init', { dryRun, roles, initialized: false });
    }

    let name = resolveProjectName(source, readRegistrations());
    let ensured = null;
    if (!dryRun) {
      // 启动团队同样必须把当前模式角色目录/项目信息/铁律/索引补齐；缺文档时 boot 会失败。
      ensured = await ensureProjectReady({ ...source, teamMode: mode }, {
        engineUrl: launchOptions.engineUrl,
        teamMode: mode
      });
      if (!ensured.ok) {
        return { ...ensured, ok: false, stage: 'ensure', dryRun: false, roles };
      }
      name = ensured.name;
    }

    const engineUrl = String(launchOptions.engineUrl || '').trim();
    // --team-mode 必须显式传给旧 launch.mjs：它自己写 workspace.json/项目.json 的模式与角色集。
    const args = ['--project', name, '--workspace', resolvedPath, '--roles', roles.join(','), '--team-mode', mode, '--json'];
    if (dryRun) args.push('--dry-run');
    if (engineUrl) args.push('--engine-url', engineUrl);
    if (launchOptions.restore) args.push('--restore');
    if (launchOptions.addMembers) args.push('--add-members');
    // 旧版 team:launch 支持 --seed-visible：给空白会话发一句“已就位”，让成员在 DSH 工作区可见。
    if (launchOptions.seedVisible === true) args.push('--seed-visible');
    if (launchOptions.promptAll === true) args.push('--prompt-all');
    else if (launchOptions.prompt === true) args.push('--prompt');
    else args.push('--no-prompt');

    const wantsPrompt = launchOptions.promptAll === true || launchOptions.prompt === true;
    const run = await runNode(layout.launchTool, args, {
      timeoutMs: dryRun ? TIMEOUTS.launchDryRun : (wantsPrompt ? TIMEOUTS.launchPrompt : TIMEOUTS.launch)
    });
    // launch.mjs 自己会 scaffold 六角色；Fast 必须在它之后收口，成功/失败都要收。
    const removedDirs = (!dryRun && mode === 'fast')
      ? pruneExcludedRoleDirs(resolvedPath, mode, excludedBefore)
      : [];
    let indexAfterPrune = null;
    if (removedDirs.length && name) {
      indexAfterPrune = await refreshProjectIndex(name, resolvedPath);
    }
    if (!run.ok) {
      const dshFailure = mapDshFailure(run);
      return {
        ...publicRun(run),
        ...(dshFailure || {}),
        ok: false,
        stage: 'launch',
        dryRun,
        name,
        project: name,
        roles,
        projectPath: resolvedPath,
        removedDirs,
        indexAfterPrune,
        restore: Boolean(launchOptions.restore),
        seedVisible: launchOptions.seedVisible === true,
        ensured: ensured ? { ok: ensured.ok, name: ensured.name } : null
      };
    }
    const value = run.value || {};
    const sessions = Array.isArray(value.sessions) ? value.sessions.map((session) => ({
      role: session.role,
      name: session.name || ROLE_NAMES[session.role] || session.role,
      title: session.title || '',
      sessionId: session.sessionId || '',
      reused: Boolean(session.reused),
      prompted: Boolean(session.prompted),
      seeded: Boolean(session.seeded),
      model: session.model ? `${session.model.provider}/${session.model.model}` : ''
    })) : [];
    const base = {
      dryRun,
      name,
      project: value.project || name,
      roles,
      teamMode: mode,
      roleIds: allowedRoles,
      removedDirs,
      indexAfterPrune,
      projectPath: resolvedPath,
      workspace: value.workspace || resolvedPath,
      workspaceId: value.workspaceId || null,
      restore: Boolean(launchOptions.restore || value.restoreMode),
      seedVisible: value.seedVisible === undefined ? launchOptions.seedVisible === true : Boolean(value.seedVisible),
      seedResults: Array.isArray(value.seedResults) ? value.seedResults : [],
      addMembers: value.addMembers === undefined ? Boolean(launchOptions.addMembers) : Boolean(value.addMembers),
      plan: Array.isArray(value.plan) ? value.plan : [],
      sessions,
      errors: Array.isArray(value.errors) ? value.errors : [],
      cleanup: Array.isArray(value.cleanup) ? value.cleanup : [],
      noPrompt: value.noPrompt === undefined ? true : Boolean(value.noPrompt),
      promptRoles: Array.isArray(value.promptRoles) ? value.promptRoles : [],
      sessionManifest: value.sessionManifest || null,
      currentWorkspace: value.currentWorkspace || null,
      dshWorkspaceCreated: Boolean(value.dshWorkspaceCreated),
      indexRefreshed: Boolean(value.indexRefreshed),
      file: value.file || null,
      engineUrl: value.engineUrl || engineUrl || null,
      ensured: ensured ? { ok: ensured.ok, name: ensured.name } : null,
      structure: ensured ? ensured.structure || null : null,
      structureOk: ensured ? Boolean(ensured.structure && ensured.structure.ok) : null,
      stdout: tail(run.stdout),
      stderr: tail(run.stderr),
      ms: run.ms
    };
    if (value.ok === false) {
      return {
        ...base,
        ok: false,
        code: 'LAUNCH_PARTIAL',
        errorCode: 'LAUNCH_PARTIAL',
        why: `会话创建有 ${base.errors.length} 个错误`,
        message: `会话创建有 ${base.errors.length} 个错误`
      };
    }
    return { ...base, ok: true, code: 'OK' };
  }

  return {
    layout,
    nodeExe,
    toolInfo,
    ensureInitialized,
    ensureProject,
    listWorkspaces,
    teamStatus,
    readSessionManifest,
    quickInfo,
    generateBoard,
    syncWorkbenchBoard,
    syncRoster,
    writeOwnerWorkflow,
    recordOwnerDecision,
    applyOwnerDecisionToRequirement,
    launchSessions,
    resolveProjectName: (project) => resolveProjectName(project, readRegistrations()),
    normalizeRoles,
    cleanProjectName: cleanProjectName,
    teamSlug: teamSlug,
    ROLE_IDS: ROLE_IDS.slice(),
    ROLE_NAMES: { ...ROLE_NAMES },
    ROLE_DIRS: { ...ROLE_DIRS },
    TEAM_MODES,
    DEFAULT_TEAM_MODE,
    normalizeTeamMode,
    roleIdsForTeamMode,
    requirementReviewRole,
    techReviewRole,
    ROLE_BRIEF_LIMITS: { ...ROLE_BRIEF_LIMITS },
    BRIEF_MAX_CHARS,
    runNode,
    // 旧协议消息通道（派单/回执/收件箱/项目切换）
    bootToken,
    dropBootToken,
    sendDispatch,
    sendWorkflowNotice,
    // B-20261113-005705-a577：派单队列兜底泵（全队空闲时由工作台定时器触发）
    pumpDispatchQueue,
    ackDispatch,
    inboxFor,
    readFor,
    // 通信现场快照（邮箱 new/cur + 回执.jsonl）：主进程据此检测角色自执行。
    commSnapshot,
    wakeMessageFor,
    // 旧评审协议桥（propose → show → review → sign → apply）
    legacyProposalAction,
    legacyPropose,
    legacyShow,
    legacyReview,
    legacySign,
    legacyApply,
    activateProject,
    // 旧团队工作流闭环：六角色目录/文档/索引、bootRead、需求评审、派单、开发互审、测试、Owner 验收。
    // 所有业务状态写 <团队>/状态/项目/<slug>/，不新增本地真相源。
    ensureProjectReady,
    ensureProjectStructure,
    refreshProjectIndex,
    ensureRosterRoles,
    bootRole,
    requireWorkflowBoot,
    ensureWorkflowBoot,
    briefingStatus,
    // B-20261114-003257-0a46（R-d734）：面板状态检查的真相——文档真实存在性 / 角色 BOOT 真实证据。
    projectDocPresence,
    bootEvidence,
    currentRoleSessions,
    buildRoleBrief,
    readBootDocs,
    readRequirementDocs,
    readWorkflowState,
    writeWorkflowState,
    readWorkflowSnapshot,
    listLegacyProposals,
    workflowFile,
    legacyCapabilities,
    // 能力矩阵：旧命令存在与否 / 哪些动作由壳层收口（Fast / Full 通用，供界面与自测核对）。
    capabilitiesForProjectMode,
    createRequirement,
    reviewRequirement,
    techReviewRequirement,
    ownerRequirementDecision,
    issueLegacyOwnerConfirmation,
    createOwnerRequirement,
    ownerDemand,
    startVote,
    castVote,
    voteStatus,
    // 迭代闸门（测试/诊断用：检查 rejected 是否被视为已收口）
    iterateGuard,
    workflowNext,
    iterateWorkflow,
    terminateWorkflow,
    dispatchRequirement,
    dispatchRequirementBatch,
    validateDispatchTarget,
    claimWorkflowTask,
    doneWorkflowTask,
    devSubmit,
    devReview,
    devApply,
    dispatchTest,
    ownerAccept,
    // B-b55c：需求 id 精确匹配与状态来源（tester 复跑"同秒需求不串号"用同一份实现，不另写一套）
    requirementIdKey,
    requirementIdMatchPlan,
    findStateRequirementRow,
    findStateRequirementRowDetailed,
    workflowStateSource,
    rosterStatus,
    readDispatchLockState,
    releaseDispatchLock,
    annotateReceiptIdentity,
    appendLocalReceipt,
    listReceipts,
    setCurrentWorkspace,
    readCurrentWorkspace,
    recordWorkspaceBinding,
    teamConfig,
    teamMembers,
    // R-c651：团队在场三列 / 全部已读 / 一键唤醒（口径只在旧工具 团队/工具/lib/ops.mjs）
    presenceFor,
    markReadFor,
    wakeRole,
    // 供测试/诊断使用
    _paths: () => ({ ...layout }),
    _runNode: runNode,
    _runTool: runNode
  };
}

// ==========================================================================
// Owner 认证字段合并隔离探针
//
// 只在显式 `node src/team-tools.js --probe-owner-auth` 时运行：
//   - 状态根在系统临时目录，绝不读写真实 团队/ 或 data/；
//   - 工具目录指向一个空目录，旧命令由 legacyMock 模拟，不启动 Electron/DSH/team.mjs；
//   - 走真实的 ownerRequirementDecision / ownerAccept / readWorkflowSnapshot 路径，
//     断言旧命令写在 requirement/工作流.json 里的 actor、confirmation、nonceHash
//     经壳层合并后仍然存在（UI 刷新读到的快照也一样）。
// ==========================================================================
const OWNER_AUTH_PROBE_NONCE_HASH = '0123456789abcdef';
const OWNER_AUTH_PROBE_PROJECT = 'Owner认证探针';
const OWNER_AUTH_PROBE_REQUIREMENT = 'R-20261106-0001';

function probeWriteJson(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

function probeWriteText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, String(text), 'utf8');
}

function probeReadJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
}

/** 探针报告只保留可读摘要，避免把整份工作流状态打到终端。 */
function probeDetailSummary(value) {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return value.slice(0, 300);
  if (typeof value === 'number' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.slice(0, 20);
  if (isPlainObject(value)) {
    const out = {};
    for (const key of ['ok', 'code', 'status', 'by', 'actor', 'channel', 'nonceHash', 'message']) {
      if (value[key] !== undefined) out[key] = value[key];
    }
    if (isPlainObject(value.confirmation)) {
      out.confirmation = {
        channel: value.confirmation.channel,
        nonceHash: value.confirmation.nonceHash
      };
    }
    return Object.keys(out).length ? out : '[object]';
  }
  return String(value).slice(0, 300);
}

async function runOwnerAuthProbe(options = {}) {
  const createdRoot = !options.root;
  const base = options.root
    ? path.resolve(String(options.root))
    : fs.mkdtempSync(path.join(os.tmpdir(), 'awb-owner-auth-probe-'));
  const teamRoot = path.join(base, '团队');
  const projectPath = path.join(base, 'projects', OWNER_AUTH_PROBE_PROJECT);
  const toolsDir = path.join(base, 'tools-empty');
  const stateDir = path.join(teamRoot, '状态', '项目', teamSlug(OWNER_AUTH_PROBE_PROJECT, 60));
  const workflowFile = path.join(stateDir, '工作流.json');
  const taskFile = path.join(stateDir, '任务', OWNER_AUTH_PROBE_REQUIREMENT + '.json');
  const checks = [];
  const failures = [];
  let fatal = null;
  const check = (name, pass, detail) => {
    const row = { name, pass: Boolean(pass), detail: detail === undefined ? null : detail };
    checks.push(row);
    if (!row.pass) failures.push(row);
  };
  const at = new Date().toISOString();
  const requirementKey = OWNER_AUTH_PROBE_REQUIREMENT;

  const mockRun = async (input = {}) => {
    const command = String(input.command || '');
    if (command !== 'owner') {
      return { ok: false, code: 'PROBE_UNEXPECTED_COMMAND', message: `探针未模拟命令：${command}` };
    }
    const decision = String(input.decision || '');
    const opinion = String(input.opinion || '');
    const state = probeReadJson(workflowFile);
    const task = probeReadJson(taskFile);
    const row = state.requirements && state.requirements[requirementKey];
    if (!row) throw new Error(`探针状态里没有需求 ${requirementKey}`);
    const confirmation = { channel: 'nonce', nonceHash: OWNER_AUTH_PROBE_NONCE_HASH, at };
    if (input.action === 'accept') {
      const acceptance = {
        status: decision,
        by: 'Owner',
        actor: 'owner',
        confirmation,
        at,
        opinion,
        channel: 'nonce',
        source: 'team.mjs owner',
        command: 'owner --action accept'
      };
      row.acceptance = acceptance;
      row.status = decision;
      row.updatedAt = at;
      state.ownerReview = {
        required: true,
        status: decision === 'accepted' ? 'approved' : 'rejected',
        kind: 'acceptance',
        by: 'Owner',
        actor: 'owner',
        confirmation,
        at,
        opinion,
        channel: 'nonce'
      };
      task.workflow = {
        ...(task.workflow && typeof task.workflow === 'object' ? task.workflow : {}),
        requirementStatus: decision,
        ownerAcceptance: acceptance
      };
      probeWriteJson(workflowFile, state);
      probeWriteJson(taskFile, task);
      return {
        ok: true,
        value: {
          ok: true,
          requirementId: requirementKey,
          action: 'accept',
          decision,
          // 真实旧命令返回的 requirement.acceptance 是「验收标准字符串」，
          // 不是 acceptance 对象；认证字段只在 workflow.ownerAcceptance / 顶层 acceptance。
          requirement: task,
          acceptance,
          ownerReview: state.ownerReview,
          confirmation,
          workflowFile
        }
      };
    }
    const ownerReview = {
      status: decision,
      by: 'Owner',
      actor: 'owner',
      confirmation,
      at,
      opinion,
      channel: 'nonce',
      source: 'team.mjs owner',
      command: 'owner'
    };
    row.ownerReview = ownerReview;
    row.status = decision === 'rejected' ? 'rejected' : 'ready';
    row.updatedAt = at;
    state.ownerReview = {
      required: true,
      status: decision,
      kind: 'requirement',
      by: 'Owner',
      actor: 'owner',
      confirmation,
      at,
      opinion,
      channel: 'nonce',
      command: 'owner'
    };
    task.workflow = {
      ...(task.workflow && typeof task.workflow === 'object' ? task.workflow : {}),
      requirementStatus: row.status,
      ownerReview
    };
    probeWriteJson(workflowFile, state);
    probeWriteJson(taskFile, task);
    // 模拟旧版本只把认证信息放在顶层 ownerReview/confirmation 与工作流.json，
    // 返回的 requirement 不带 workflow 镜像；壳层不能因此丢掉认证字段。
    const returnedTask = { ...task };
    delete returnedTask.ownerReview;
    delete returnedTask.workflow;
    return {
      ok: true,
      value: {
        ok: true,
        requirementId: requirementKey,
        decision,
        requirement: returnedTask,
        ownerReview,
        confirmation,
        workflowFile
      }
    };
  };

  try {
    fs.mkdirSync(base, { recursive: true });
    fs.mkdirSync(projectPath, { recursive: true });
    fs.mkdirSync(path.join(stateDir, '任务'), { recursive: true });
    probeWriteJson(path.join(teamRoot, '状态', '团队.json'), { name: 'Owner认证探针团队', members: [] });
    probeWriteJson(path.join(stateDir, '项目.json'), { name: OWNER_AUTH_PROBE_PROJECT, path: projectPath, createdAt: at });
    // 先写索引，避免 ensureProjectStructure 触发真实 team.mjs index。
    probeWriteJson(path.join(projectPath, '项目索引.json'), { requirements: [] });
    probeWriteText(path.join(projectPath, '项目索引.md'), '# 项目索引\n\n## 三、需求目录\n');
    const tools = createTeamTools({ teamRoot, toolsDir, legacyMock: { run: mockRun } });
    await tools.ensureProjectStructure({
      name: OWNER_AUTH_PROBE_PROJECT, path: projectPath, projectPath
    });
    probeWriteText(path.join(teamRoot, '团队宪法.md'), '# 探针团队宪法\n\n只用于 Owner 认证字段隔离探针。\n');
    probeWriteText(path.join(projectPath, '项目信息.md'), [
      '# Owner认证探针 · 项目信息',
      '',
      '## 一、目标',
      '',
      '验证 Owner 决定与验收后 actor、confirmation、nonceHash 不被壳层覆盖，channel 只允许 ui/tty（确认码已废弃）。',
      '',
      '## 二、边界',
      '',
      '仅运行在系统临时目录，不读写真实团队状态。',
      ''
    ].join('\n'));
    probeWriteText(path.join(projectPath, '项目铁律.md'), [
      '# Owner认证探针 · 项目铁律',
      '',
      '1. 只改探针临时目录。',
      '2. 旧命令已写的认证字段必须保留。',
      ''
    ].join('\n'));
    probeWriteText(path.join(projectPath, '协作准则.md'), '# 协作准则\n\n先读后写，认证字段不覆盖。\n');
    const requirementDoc = path.join(projectPath, '需求', requirementKey + '-Owner认证探针需求.md');
    probeWriteText(requirementDoc, [
      '# ' + requirementKey + ' Owner 认证探针需求',
      '',
      '- 需求 id：' + requirementKey,
      '- 优先级：P1',
      '- 状态：approved',
      '',
      '## 验收标准',
      '',
      '旧命令写下的 actor / confirmation / nonceHash 在壳层落账与 UI 刷新后仍然存在。',
      ''
    ].join('\n'));
    probeWriteText(path.join(projectPath, '需求', '00-需求总览.md'), [
      '# 需求总览',
      '',
      '| 需求 | 标题 | 优先级 | 状态 | 验收标准 |',
      '|---|---|---|---|---|',
      `| ${requirementKey} | Owner 认证探针需求 | P1 | approved | 认证字段保留 |`,
      ''
    ].join('\n'));
    probeWriteJson(path.join(projectPath, '项目索引.json'), {
      requirements: [{ id: requirementKey, target: '需求/' + path.basename(requirementDoc) }]
    });
    const finalStructure = await tools.ensureProjectStructure({
      name: OWNER_AUTH_PROBE_PROJECT, path: projectPath, projectPath
    });
    check('隔离项目结构可用', finalStructure.ok === true, {
      code: finalStructure.code,
      missing: finalStructure.missing
    });
    probeWriteJson(taskFile, {
      id: requirementKey,
      project: OWNER_AUTH_PROBE_PROJECT,
      type: 'requirement',
      requirementId: '',
      title: 'Owner 认证探针需求',
      detail: '',
      acceptance: '验收标准字符串（不能被壳层当成 acceptance 对象展开）',
      story: '',
      priority: 'P1',
      owner: null,
      status: 'done',
      createdBy: 'product',
      createdAt: at,
      claimedAt: null,
      due: '',
      doneAt: at,
      evidence: 'probe seed',
      rev: 0,
      history: [],
      workflow: { requirementStatus: 'approved' },
      updatedAt: at
    });
    const makeBoot = (role) => {
      const docs = tools.readBootDocs(projectPath, role);
      if (!docs.complete) throw new Error(`探针 boot 必读文件不齐（${role}）：${docs.missing.join('、')}`);
      return {
        role,
        project: OWNER_AUTH_PROBE_PROJECT,
        at: new Date().toISOString(),
        round: 1,
        complete: true,
        required: ['iron', 'projectInfo', 'roleCard', 'projectIndex', 'requirementOverview'],
        docs: docs.docs,
        missing: [],
        requirements: docs.requirements,
        requirementsHash: docs.requirements.hash,
        hashChecks: {},
        sessionId: ''
      };
    };
    const productBoot = makeBoot('product');
    const testerBoot = makeBoot('tester');
    const seeded = tools.writeWorkflowState(OWNER_AUTH_PROBE_PROJECT, {
      schema: WORKFLOW_SCHEMA,
      project: OWNER_AUTH_PROBE_PROJECT,
      round: 1,
      phase: 'owner_review',
      requirements: {
        [requirementKey]: {
          id: requirementKey,
          title: 'Owner 认证探针需求',
          priority: 'P1',
          origin: 'role',
          queued: false,
          round: 1,
          status: 'approved',
          createdBy: 'product',
          createdAt: at,
          updatedAt: at,
          acceptanceCriteria: '认证字段保留',
          story: '',
          detail: '',
          productReview: { verdict: 'approve', by: 'product', comment: '探针产品评审通过', at },
          ownerReview: { status: 'pending', at: null, opinion: '' },
          dispatch: null,
          dev: null,
          test: null,
          acceptance: null,
          doc: '需求/' + path.basename(requirementDoc),
          history: []
        }
      },
      ownerReview: { required: true, status: 'pending', kind: 'requirement', roundKey: 'probe', at: null, opinion: '' },
      boots: { product: productBoot, tester: testerBoot },
      events: [],
      createdAt: at,
      updatedAt: at
    });
    check('探针工作流初始状态可写', seeded.ok === true, seeded);
    // 探针 toolsDir 是空的；补一个最小 owner-note.mjs，验证 PM 系统消息链路真实可写。
    probeWriteText(path.join(toolsDir, 'owner-note.mjs'), [
      "import fs from 'node:fs';",
      "import path from 'node:path';",
      "import { fileURLToPath } from 'node:url';",
      "const [project = '', decision = '', opinion = '', roundKey = ''] = process.argv.slice(2);",
      "const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', '团队', '状态', '邮箱', 'pm', 'new');",
      "const label = { approved: '通过', skipped: '跳过评审', rejected: '打回' }[decision] || decision;",
      "const id = 'M-PROBE-' + Date.now();",
      "fs.mkdirSync(root, { recursive: true });",
      "fs.writeFileSync(path.join(root, id + '.json'), JSON.stringify({ id, from: 'system', to: 'pm', subject: 'Owner评审：' + label, project, type: 'owner-review', at: new Date().toISOString() }));",
      "console.log(JSON.stringify({ ok: true, message: { id } }));",
      ''
    ].join('\n'));

    const decision = await tools.ownerRequirementDecision({
      projectName: OWNER_AUTH_PROBE_PROJECT,
      projectPath,
      role: 'owner',
      requirementId: requirementKey,
      decision: 'approved',
      channel: 'ui',
      opinion: '探针 Owner 决定：认证字段必须保留'
    });
    check('Owner 决定执行成功', decision.ok === true, decision);
    const decisionState = probeReadJson(workflowFile);
    const decisionRow = decisionState.requirements[requirementKey] || {};
    check('决定后工作流行保留 actor', decisionRow.ownerReview && decisionRow.ownerReview.actor === 'owner',
      decisionRow.ownerReview);
    check('决定后工作流行保留 confirmation.nonceHash',
      decisionRow.ownerReview && decisionRow.ownerReview.confirmation
      && decisionRow.ownerReview.confirmation.nonceHash === OWNER_AUTH_PROBE_NONCE_HASH,
      decisionRow.ownerReview && decisionRow.ownerReview.confirmation);
    check('决定后顶层 ownerReview 保留 actor', decisionState.ownerReview && decisionState.ownerReview.actor === 'owner',
      decisionState.ownerReview);
    check('决定后顶层 ownerReview 保留 nonceHash',
      decisionState.ownerReview && decisionState.ownerReview.confirmation
      && decisionState.ownerReview.confirmation.nonceHash === OWNER_AUTH_PROBE_NONCE_HASH,
      decisionState.ownerReview && decisionState.ownerReview.confirmation);
    check('决定后顶层 ownerReview channel=ui（确认码已废弃）', decisionState.ownerReview && decisionState.ownerReview.channel === 'ui',
      decisionState.ownerReview && decisionState.ownerReview.channel);
    const decisionSnapshot = tools.readWorkflowSnapshot(OWNER_AUTH_PROBE_PROJECT, projectPath);
    const decisionSnapshotRow = decisionSnapshot.ok
      ? decisionSnapshot.requirements.find((row) => row.id === requirementKey)
      : null;
    check('决定后 UI 快照顶层能看到 actor', decisionSnapshot.ok && decisionSnapshot.ownerReview
      && decisionSnapshot.ownerReview.actor === 'owner', decisionSnapshot.ownerReview);
    check('决定后 UI 快照需求能看到 nonceHash', decisionSnapshotRow && decisionSnapshotRow.ownerReview
      && decisionSnapshotRow.ownerReview.confirmation
      && decisionSnapshotRow.ownerReview.confirmation.nonceHash === OWNER_AUTH_PROBE_NONCE_HASH,
      decisionSnapshotRow && decisionSnapshotRow.ownerReview);

    // 进入 Owner 验收：重置为旧命令执行前的 pending 状态，重新由 mock 写入认证字段。
    const acceptState = probeReadJson(workflowFile);
    acceptState.phase = 'owner_accept';
    acceptState.requirements[requirementKey].status = 'test_done';
    acceptState.requirements[requirementKey].ownerReview = { status: 'pending', at: null, opinion: '' };
    acceptState.requirements[requirementKey].acceptance = null;
    acceptState.ownerReview = { required: true, status: 'pending', kind: 'acceptance', at: null, opinion: '' };
    probeWriteJson(workflowFile, acceptState);
    const acceptTask = probeReadJson(taskFile);
    acceptTask.status = 'done';
    acceptTask.workflow = { requirementStatus: 'test_done' };
    probeWriteJson(taskFile, acceptTask);

    const accept = await tools.ownerAccept({
      projectName: OWNER_AUTH_PROBE_PROJECT,
      projectPath,
      role: 'owner',
      requirementId: requirementKey,
      decision: 'accepted',
      channel: 'ui',
      opinion: '探针 Owner 验收：认证字段必须保留'
    });
    check('Owner 验收执行成功', accept.ok === true, accept);
    const acceptStateAfter = probeReadJson(workflowFile);
    const acceptRow = acceptStateAfter.requirements[requirementKey] || {};
    const acceptance = acceptRow.acceptance;
    check('验收后 acceptance 仍是对象', acceptance && typeof acceptance === 'object' && !Array.isArray(acceptance), acceptance);
    check('验收后 acceptance 没有被验收标准字符串展开',
      acceptance && typeof acceptance === 'object'
      && Object.keys(acceptance).every((key) => !/^\d+$/.test(key)), acceptance && Object.keys(acceptance));
    check('验收后 acceptance 保留 actor', acceptance && acceptance.actor === 'owner', acceptance && acceptance.actor);
    check('验收后 acceptance channel=ui（确认码已废弃）', acceptance && acceptance.channel === 'ui', acceptance && acceptance.channel);
    check('验收后 acceptance 保留 confirmation.nonceHash',
      acceptance && acceptance.confirmation && acceptance.confirmation.nonceHash === OWNER_AUTH_PROBE_NONCE_HASH,
      acceptance && acceptance.confirmation);
    check('验收后顶层 ownerReview 保留 actor', acceptStateAfter.ownerReview && acceptStateAfter.ownerReview.actor === 'owner',
      acceptStateAfter.ownerReview);
    check('验收后顶层 ownerReview 保留 nonceHash',
      acceptStateAfter.ownerReview && acceptStateAfter.ownerReview.confirmation
      && acceptStateAfter.ownerReview.confirmation.nonceHash === OWNER_AUTH_PROBE_NONCE_HASH,
      acceptStateAfter.ownerReview && acceptStateAfter.ownerReview.confirmation);
    const acceptSnapshot = tools.readWorkflowSnapshot(OWNER_AUTH_PROBE_PROJECT, projectPath);
    const acceptSnapshotRow = acceptSnapshot.ok
      ? acceptSnapshot.requirements.find((row) => row.id === requirementKey)
      : null;
    check('验收后 UI 快照顶层能看到 actor', acceptSnapshot.ok && acceptSnapshot.ownerReview
      && acceptSnapshot.ownerReview.actor === 'owner', acceptSnapshot.ownerReview);
    check('验收后 UI 快照需求能看到 actor', acceptSnapshotRow && acceptSnapshotRow.ownerAcceptance
      && acceptSnapshotRow.ownerAcceptance.actor === 'owner', acceptSnapshotRow && acceptSnapshotRow.ownerAcceptance);
    check('验收后 UI 快照需求能看到 nonceHash', acceptSnapshotRow && acceptSnapshotRow.ownerAcceptance
      && acceptSnapshotRow.ownerAcceptance.confirmation
      && acceptSnapshotRow.ownerAcceptance.confirmation.nonceHash === OWNER_AUTH_PROBE_NONCE_HASH,
      acceptSnapshotRow && acceptSnapshotRow.ownerAcceptance);
    // 验收后顶层 ownerReview 必须有 append-only decisions 记录，且 PM 必须收到 owner-note 通知。
    const acceptDecisions = acceptStateAfter.ownerReview && acceptStateAfter.ownerReview.decisions;
    check('验收后顶层 ownerReview.decisions 有记录',
      Array.isArray(acceptDecisions) && acceptDecisions.length >= 1
      && acceptDecisions[acceptDecisions.length - 1].channel === 'ui',
      Array.isArray(acceptDecisions) ? acceptDecisions.map((row) => row.channel) : acceptDecisions);
    const pmMailDir = path.join(tools.layout.mailDir, 'pm', 'new');
    const ownerNoteMails = (() => {
      try {
        return fs.readdirSync(pmMailDir).filter((name) => name.endsWith('.json'))
          .map((name) => probeReadJson(path.join(pmMailDir, name)))
          .filter((mail) => mail && String(mail.type || '') === 'owner-review');
      } catch {
        return [];
      }
    })();
    check('验收后 PM 邮箱收到 owner-note 通知', ownerNoteMails.length >= 1,
      ownerNoteMails.map((mail) => mail.subject));

    // B-0b28：轮换后新会话用 team.mjs boot 补读，壳层 工作流.json.boots 还停在旧会话 →
    // 验收门不能判“没读到需求”。只补“读过这份需求”这一项，规则文档/轮次/必读完整性照旧校验。
    {
      const gateState = probeReadJson(workflowFile);
      gateState.requirements[requirementKey].status = 'test_done';
      gateState.boots = gateState.boots && typeof gateState.boots === 'object' ? gateState.boots : {};
      gateState.boots.tester = {
        ...(gateState.boots.tester || {}),
        role: 'tester', project: OWNER_AUTH_PROBE_PROJECT, round: gateState.round || 1,
        at: new Date().toISOString(), complete: true, missing: [],
        docs: (gateState.boots.tester && gateState.boots.tester.docs) || {},
        requirements: { list: [], hash: 'stale', contentHash: 'stale' },
        requirementsHash: 'stale', requirementsContentHash: 'stale'
      };
      probeWriteJson(workflowFile, gateState);
      const denied = tools.requireWorkflowBoot(OWNER_AUTH_PROBE_PROJECT, projectPath, 'tester', { requirementId: requirementKey });
      check('B-0b28：壳层记录缺该需求且无 CLI boot 令牌 → 验收门拒绝（BOOT_REQUIRED）',
        denied.ok === false && denied.code === 'BOOT_REQUIRED', { code: denied.code, readSource: denied.readSource });

      // 补一份该角色最新 CLI boot 令牌（轮换后新会话补读的证据）
      const liveDocs = tools.readRequirementDocs(projectPath);
      const liveRow = liveDocs && Array.isArray(liveDocs.list)
        ? liveDocs.list.find((row) => String(row.id) === String(requirementKey))
        : null;
      const bootDir = path.join(tools.layout.state, '启动');
      fs.mkdirSync(bootDir, { recursive: true });
      probeWriteText(path.join(bootDir, 'probe-b0b28-token.json'), JSON.stringify({
        token: 'probe-b0b28-token',
        role: 'tester',
        project: OWNER_AUTH_PROBE_PROJECT,
        createdAt: new Date().toISOString(),
        rulesHash: gateState.boots.tester.rulesHash || '',
        requirementDocs: liveRow
          ? [{ id: liveRow.id, rel: liveRow.rel, hash: liveRow.hash, contentHash: liveRow.contentHash || liveRow.hash, size: liveRow.size }]
          : []
      }, null, 2) + '\n');
      const allowed = tools.requireWorkflowBoot(OWNER_AUTH_PROBE_PROJECT, projectPath, 'tester', { requirementId: requirementKey });
      check('B-0b28：有最新 CLI boot 令牌（补读过该需求）→ 验收门放行，来源=legacy-boot-token',
        allowed.ok === true && allowed.requirementReadSource === 'legacy-boot-token',
        { ok: allowed.ok, code: allowed.code, readSource: allowed.requirementReadSource });
    }
  } catch (error) {
    fatal = String((error && error.stack) || error);
    check('探针没有抛异常', false, fatal);
  }
  if (createdRoot && !options.keep) {
    try { fs.rmSync(base, { recursive: true, force: true }); } catch { /* 临时目录清理失败不影响结论 */ }
  }
  return {
    ok: failures.length === 0 && !fatal,
    probe: 'owner-auth-merge',
    root: base,
    kept: Boolean(options.keep) || !createdRoot,
    nonceHash: OWNER_AUTH_PROBE_NONCE_HASH,
    checks: checks.length,
    passed: checks.filter((row) => row.pass).length,
    failed: failures.length,
    failures: failures.map((row) => ({ name: row.name, detail: probeDetailSummary(row.detail) })),
    fatal: fatal ? String(fatal).slice(0, 1200) : null,
    detail: checks.map((row) => ({ name: row.name, pass: row.pass }))
  };
}

const defaultTools = createTeamTools();

module.exports = {
  ...defaultTools,
  create: createTeamTools,
  probeOwnerAuth: runOwnerAuthProbe,
  extractJson,
  cleanProjectName,
  teamSlug,
  isIgnoredWorkspace,
  localProjectDirs,
  ROLE_IDS,
  ROLE_NAMES,
  ROLE_DIRS,
  TEAM_MODES,
  DEFAULT_TEAM_MODE,
  normalizeTeamMode,
  roleIdsForTeamMode,
  requirementReviewRole,
  techReviewRole,
  WORKFLOW_SCHEMA,
  WORKFLOW_PHASES,
  WORKFLOW_STAGE_BY_PHASE,
  ROLE_BRIEF_LIMITS,
  BRIEF_MAX_CHARS,
  TIMEOUTS,
  LEGACY_REVIEW_ACTIONS,
  LEGACY_STATUS_MAP,
  isInside,
  // R-ea86：PM 代验收证据校验（纯函数，供 ownerAccept 与可复跑测试共用同一份判据）
  acceptEvidenceCheck,
  acceptEvidenceStaleness
};

if (require.main === module) {
  const argv = process.argv.slice(2);
  if (argv.includes('--probe-owner-auth')) {
    runOwnerAuthProbe({ keep: argv.includes('--keep') })
      .then((report) => {
        console.log('OWNER_AUTH_PROBE ' + JSON.stringify(report));
        if (!report.ok) process.exitCode = 1;
      })
      .catch((error) => {
        console.error('OWNER_AUTH_PROBE_FATAL ' + JSON.stringify({
          ok: false,
          message: String((error && error.stack) || error)
        }));
        process.exitCode = 1;
      });
  }
}

