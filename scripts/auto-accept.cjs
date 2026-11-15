#!/usr/bin/env node
'use strict';

/**
 * R-4657 · 缺陷验收自动化（单源）
 *
 * 一句话：`type=bug` 且 `status=done` 的任务，证据两件套（含 PASS 无 FAIL 的测试报告 +
 * 魔数合法的截图）齐了，就自动写任务级 `acceptanceRecord`；不满足只写审计，不改任务文件。
 *
 * 单源约定：
 *   - 判据、kind 推断、证据校验、审计写入、撤回窗口全部在本文件；
 *   - 主进程 watch/tick/IPC 用 `createAutoAcceptRunner()` / `run()`，CLI 用同一个 `run()`；
 *   - 证据合格判定复用 `src/team-tools.js → acceptEvidenceCheck()`，不新写第二套 PASS/FAIL 判法。
 *
 * 安全约定（TR-Q②）：
 *   - 开关口径 v2（PM 裁决 M-20261115-111430-7e9ecf ③）：全局 `ui.autoAcceptBugs` 不再单独生效，
 *     仅 `projects[].autoAcceptBugs === true` 才开；null/undefined/false 一律关；
 *     真实（非沙盘）项目仍须显式 `AWB_AUTO_ACCEPT_ALLOW_REAL=1` 才允许主进程自动执行。
 *   - 真实项目只允许 `--plan`（dry-run）；`--run` / `--retract` 必须用 TEAM_ROOT / TEAM_PROJECTS_ROOT
 *     指向沙盘，否则返回 `AUTO_ACCEPT_REAL_PROJECT_READ_ONLY`；
 *   - 主进程内部路径只有在「沙盘或 AWB_AUTO_ACCEPT_ALLOW_REAL=1」门通过后才传 allowRealProject:true；
 *     CLI 永不传（真实项目 --run/--retract 一律拒绝）。
 *
 * CLI 用法：
 *   node scripts/auto-accept.cjs --project <名> [--plan|--dry-run] [--json]
 *   node scripts/auto-accept.cjs --project <名> --run --once [--json]
 *   node scripts/auto-accept.cjs --project <名> --retract <id[,id]> [--reason <文本>] [--retract-hours <n>]
 *        [--operator owner|pm] [--now <ISO>] [--json]
 *   其他：--team-root <dir> --store <file> --watch --batch live|first-scan|manual
 *
 * 退出码（派单口径）：0=成功（含 dry-run）；1=校验/执行失败；2=用法或环境/IO 错误。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const DEFAULT_TEAM_ROOT = path.join(ROOT, '团队');
const DEFAULT_PROJECTS_ROOT = path.join(ROOT, '项目');
const RULE = 'R-4657/v1';
const DEFAULT_RETRACT_HOURS = 24;
const WATCH_DEBOUNCE_MS = 300;
const DEFAULT_TICK_MS = 30000;
const DUPLICATE_TTL_MS = 60 * 1000;
const MAX_EVIDENCE_ENTRIES = 40;
const MAX_DIR_DEPTH = 3;
const MAX_DIR_FILES = 80;
const MAX_TEXT_BYTES = 2 * 1024 * 1024;
const MAX_TASK_BYTES = 4 * 1024 * 1024;

/** AC6 七组（含成功码 accepted）；F-4657-2 的 reason 取第一个失败项。 */
const GROUP_REASONS = Object.freeze([
  'no_evidence', 'report_missing', 'report_no_pass', 'report_has_fail',
  'screenshot_missing', 'bad_image', 'accepted'
]);
/** 其它 skip（不含七组）。 */
const OTHER_REASONS = Object.freeze([
  'already_closed', 'evidence_empty', 'read_failed', 'switch_off', 'state_changed', 'duplicate'
]);
/** 撤回原因白名单（IPC 错误码为大写同名）。 */
const RETRACT_REASONS = Object.freeze([
  'retracted', 'retract_window_expired', 'retract_not_found', 'retract_noop'
]);
const ALLOWED_SKIP_REASONS = new Set([...GROUP_REASONS.filter((r) => r !== 'accepted'), ...OTHER_REASONS]);
const ALLOWED_RETRACT_REASONS = new Set(RETRACT_REASONS);
/** AC9：每行固定 12 键，不按 result 删键。 */
const AUDIT_KEYS = Object.freeze([
  'at', 'project', 'taskId', 'type', 'rule', 'result', 'reason',
  'evidence', 'testReport', 'partialMissing', 'batch', 'operator'
]);

const REPORT_EXT_RE = /\.(md|markdown|txt|log)$/i;
const IMAGE_EXT_RE = /\.(png|jpe?g|webp)$/i;
const TASK_ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]{0,100}$/;

/* ── 小工具 ─────────────────────────────────────────────────────────────── */

function asText(value) {
  return value === null || value === undefined ? '' : String(value);
}

function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

let cachedEvidenceCheck = null;
/** 复用既有证据判定（不重写 PASS/FAIL/魔数）。 */
function evidenceChecker() {
  if (typeof cachedEvidenceCheck === 'function') return cachedEvidenceCheck;
  const mod = require(path.join(ROOT, 'src', 'team-tools.js'));
  if (!mod || typeof mod.acceptEvidenceCheck !== 'function') {
    const error = new Error('acceptEvidenceCheck() 不可用：src/team-tools.js 未导出该函数');
    error.code = 'ACCEPT_EVIDENCE_CHECK_MISSING';
    throw error;
  }
  cachedEvidenceCheck = mod.acceptEvidenceCheck;
  return cachedEvidenceCheck;
}

function readJsonFile(file) {
  try {
    return { ok: true, value: JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')) };
  } catch (error) {
    return { ok: false, error };
  }
}

function readJsonIfExists(file) {
  if (!file || !fs.existsSync(file)) return null;
  const read = readJsonFile(file);
  return read.ok ? read.value : null;
}

function sha256Buffer(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(file) {
  return sha256Buffer(fs.readFileSync(file));
}

function realpathLower(target) {
  const resolved = path.resolve(asText(target));
  try { return fs.realpathSync.native(resolved).toLowerCase(); } catch { /* 目录不存在 */ }
  try { return fs.realpathSync(resolved).toLowerCase(); } catch { /* 再退一步 */ }
  return resolved.toLowerCase();
}

function isInsidePath(parent, child) {
  const p = realpathLower(parent);
  const c = realpathLower(child);
  return Boolean(p && c && (c === p || c.startsWith(p + path.sep)));
}

function nowIso() {
  return new Date().toISOString();
}

function toDate(value) {
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? null : value;
  if (value === null || value === undefined || value === '') return new Date();
  const ms = Date.parse(String(value));
  return Number.isFinite(ms) ? new Date(ms) : null;
}

function defaultByKey(key) {
  switch (key) {
    case 'at': return nowIso();
    case 'project': return '';
    case 'taskId': return '';
    case 'type': return 'bug';
    case 'rule': return RULE;
    case 'result': return '';
    case 'reason': return null;
    case 'evidence': return [];
    case 'testReport': return null;
    case 'partialMissing': return [];
    case 'batch': return 'manual';
    case 'operator': return null;
    default: return null;
  }
}

/* ── 路径 / 项目上下文 ─────────────────────────────────────────────────── */

function teamRootOf(options = {}) {
  const explicit = options.teamRoot || process.env.TEAM_ROOT || '';
  return path.resolve(asText(explicit) || DEFAULT_TEAM_ROOT);
}

function projectsRootOf(options = {}) {
  const explicit = options.projectsRoot || process.env.TEAM_PROJECTS_ROOT || '';
  return path.resolve(asText(explicit) || DEFAULT_PROJECTS_ROOT);
}

function storeFileOf(options = {}) {
  if (options.storeFile) return path.resolve(asText(options.storeFile));
  if (process.env.AWB_STORE) return path.resolve(process.env.AWB_STORE);
  const dataDir = process.env.AWB_DATA_DIR ? path.resolve(process.env.AWB_DATA_DIR) : path.join(ROOT, 'data');
  return path.join(dataDir, 'userdata', 'workbench.json');
}

function readStoreFile(file) {
  if (!file || !fs.existsSync(file)) {
    return { ok: true, missing: true, store: { version: 1, activeProjectId: null, projects: [], ui: {} } };
  }
  try {
    const store = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    if (!store || !Array.isArray(store.projects)) throw new Error('缺少 projects 数组');
    return { ok: true, missing: false, store };
  } catch (error) {
    return { ok: false, missing: false, store: { version: 1, activeProjectId: null, projects: [], ui: {} }, error };
  }
}

function listStateDirs(teamRoot) {
  const dir = path.join(teamRoot, '状态', '项目');
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
  return entries
    .filter((entry) => entry.isDirectory() && entry.name !== '_deleted')
    .map((entry) => path.join(dir, entry.name));
}

function pickStateDir(teamRoot, projectName) {
  const name = asText(projectName).trim();
  if (!name) return '';
  const direct = path.join(teamRoot, '状态', '项目', name);
  if (fs.existsSync(direct)) return direct;
  for (const dir of listStateDirs(teamRoot)) {
    const config = readJsonIfExists(path.join(dir, '项目.json')) || {};
    if (asText(config.name) === name || path.basename(dir) === name) return dir;
  }
  return '';
}

/**
 * 自动验收开关解析（开关口径 v2，PM 裁决 M-20261115-111430-7e9ecf ③）：
 *   - 全局开关不再单独生效：`ui.autoAcceptBugs` 即使为 true 也不启动自动验收（只保留为只读/诊断字段）；
 *   - 只有项目级显式 true 才开：`projects[].autoAcceptBugs === true`（布尔 true，字符串不算）；
 *   - 语义：null / undefined / false 一律视为关；true 才开。
 * 本函数是纯函数、不缓存：主进程每轮重读，配置改动实时生效（不要在启动时缓存结果）。
 */
function resolveAutoAcceptSettings(store, storeProject, projectPath, projectName) {
  const ui = isPlainObject(store && store.ui) ? store.ui : {};
  // 历史字段：仍解析出来供设置页/诊断展示，但不参与 effective 判定（全局开关不再单独生效）。
  const globalRaw = ui.autoAcceptBugs;
  const globalOn = globalRaw === true || globalRaw === 1 || globalRaw === 'true' || globalRaw === '1';
  let entry = storeProject;
  if (!entry && store && Array.isArray(store.projects)) {
    entry = store.projects.find((row) => (row && row.path && isInsidePath(projectPath, row.path))
      || asText(row && (row.teamName || row.name)) === asText(projectName)) || null;
  }
  let projectRaw = null;
  if (entry && Object.prototype.hasOwnProperty.call(entry, 'autoAcceptBugs')) {
    const value = entry.autoAcceptBugs;
    if (value === true) projectRaw = true;
    else if (value === false) projectRaw = false;
    else projectRaw = null;
  }
  // 口径 v2：只有项目级显式 true 才开；全局 true / 项目级 null / undefined / false 一律关。
  const effective = projectRaw === true;
  const source = effective ? 'project' : (projectRaw === false ? 'project_off' : (globalOn ? 'global_ignored' : 'off'));
  return { global: globalOn, project: projectRaw, effective, globalIgnored: globalOn && projectRaw !== true, source };
}

function resolveRetractHours(options = {}) {
  const raw = options.retractHours !== undefined && options.retractHours !== null && options.retractHours !== ''
    ? options.retractHours
    : (process.env.AWB_AUTO_ACCEPT_RETRACT_HOURS !== undefined
      ? process.env.AWB_AUTO_ACCEPT_RETRACT_HOURS
      : DEFAULT_RETRACT_HOURS);
  const hours = Number(raw);
  return Number.isFinite(hours) && hours >= 0 ? hours : DEFAULT_RETRACT_HOURS;
}

/**
 * 解析项目上下文：团队根、状态目录、项目根、开关、撤回窗口。
 * 只读；不建目录、不写任何文件。
 */
function resolveProjectContext(options = {}) {
  const teamRoot = teamRootOf(options);
  const projectsRoot = projectsRootOf(options);
  const storeFile = storeFileOf(options);
  const storeRead = readStoreFile(storeFile);
  const store = storeRead.store;
  let projectName = asText(options.projectName || options.project).trim();
  let stateDir = options.stateDir ? path.resolve(asText(options.stateDir)) : '';
  let storeProject = null;

  if (!stateDir && projectName) stateDir = pickStateDir(teamRoot, projectName);
  if (!stateDir && !projectName) {
    storeProject = store.projects.find((row) => row && row.id === store.activeProjectId)
      || store.projects.find(Boolean) || null;
    if (storeProject) {
      projectName = asText(storeProject.teamName || storeProject.name).trim();
      stateDir = pickStateDir(teamRoot, projectName);
      if (!stateDir && storeProject.path) {
        for (const dir of listStateDirs(teamRoot)) {
          const config = readJsonIfExists(path.join(dir, '项目.json')) || {};
          if (config.path && isInsidePath(config.path, storeProject.path) && isInsidePath(storeProject.path, config.path)) {
            stateDir = dir;
            projectName = asText(config.name || projectName);
            break;
          }
        }
      }
    }
  }

  if (!stateDir || !fs.existsSync(stateDir)) {
    return {
      ok: false,
      code: 'AUTO_ACCEPT_PROJECT_NOT_FOUND',
      message: `找不到团队项目状态目录：${projectName || '(未指定项目)'}`,
      teamRoot,
      projectsRoot,
      storeFile,
      projectName
    };
  }

  const config = readJsonIfExists(path.join(stateDir, '项目.json')) || {};
  projectName = asText(config.name || projectName || path.basename(stateDir)).trim();
  if (!storeProject && Array.isArray(store.projects)) {
    storeProject = store.projects.find((row) => row && (
      (row.path && config.path && isInsidePath(row.path, config.path) && isInsidePath(config.path, row.path))
      || asText(row.teamName || row.name) === projectName
    )) || null;
  }
  let projectPath = asText(config.path || (storeProject && storeProject.path)).trim();
  if (!projectPath) projectPath = path.join(projectsRoot, projectName);
  projectPath = path.resolve(projectPath);

  const settings = resolveAutoAcceptSettings(store, storeProject, projectPath, projectName);
  const retractHours = resolveRetractHours(options);
  return {
    ok: true,
    projectName,
    projectPath,
    stateDir: path.resolve(stateDir),
    teamRoot,
    projectsRoot,
    storeFile,
    store,
    storeError: storeRead.ok ? null : { code: 'AUTO_ACCEPT_STORE_UNREADABLE', message: asText(storeRead.error && storeRead.error.message).slice(0, 200) },
    settings,
    retractHours
  };
}

/**
 * 执行/撤回的写入门：没有把 TEAM_ROOT / TEAM_PROJECTS_ROOT 指到沙盘，就只能 dry-run。
 * 主进程内部显式传 allowRealProject=true（生产自动收口），CLI 永不传。
 */
function assertCanWrite(context, options = {}) {
  if (options.allowRealProject === true) return { ok: true };
  const sandboxEnv = asText(process.env.TEAM_ROOT || process.env.TEAM_PROJECTS_ROOT).trim();
  if (!sandboxEnv) {
    return {
      ok: false,
      code: 'AUTO_ACCEPT_REAL_PROJECT_READ_ONLY',
      message: '真实项目只允许 --plan（dry-run）；执行必须用 TEAM_ROOT/TEAM_PROJECTS_ROOT 指向沙盘'
    };
  }
  const realTeamRoot = realpathLower(DEFAULT_TEAM_ROOT);
  const teamRoot = realpathLower(context.teamRoot);
  const stateDir = realpathLower(context.stateDir);
  if (realTeamRoot && (teamRoot === realTeamRoot || isInsidePath(realTeamRoot, stateDir))) {
    return {
      ok: false,
      code: 'AUTO_ACCEPT_REAL_PROJECT_READ_ONLY',
      message: '团队状态目录仍指向真实 团队/：只允许 --plan；执行请把 TEAM_ROOT 指向沙盘'
    };
  }
  if (!isInsidePath(teamRoot, stateDir)) {
    return {
      ok: false,
      code: 'AUTO_ACCEPT_REAL_PROJECT_READ_ONLY',
      message: '项目状态目录不在 TEAM_ROOT 沙盘内：拒绝执行'
    };
  }
  return { ok: true };
}

/* ── 任务读取 ──────────────────────────────────────────────────────────── */

function taskDirOf(context) {
  return path.join(context.stateDir, '任务');
}

function loadBugTasks(context) {
  const taskDir = taskDirOf(context);
  let names = [];
  try { names = fs.readdirSync(taskDir); } catch (error) {
    return {
      ok: false,
      code: 'AUTO_ACCEPT_NO_TASK_DIR',
      message: `任务目录不可读：${taskDir}（${asText(error && error.message).slice(0, 120)}）`,
      taskDir
    };
  }
  const tasks = [];
  for (const name of names) {
    if (!name.endsWith('.json') || /\.(bak|tmp)/i.test(name)) continue;
    const file = path.join(taskDir, name);
    let stat;
    try { stat = fs.statSync(file); } catch { continue; }
    if (!stat.isFile() || stat.size > MAX_TASK_BYTES) continue;
    let raw;
    try { raw = fs.readFileSync(file); } catch { continue; }
    let task;
    try { task = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')); } catch { continue; }
    if (!task || !task.id || asText(task.type) !== 'bug') continue;
    tasks.push({
      task,
      file,
      raw,
      sha256: sha256Buffer(raw),
      mtimeMs: stat.mtimeMs,
      size: stat.size
    });
  }
  tasks.sort((left, right) => asText(left.task.id).localeCompare(asText(right.task.id)));
  return { ok: true, tasks, taskDir };
}

/* ── 证据展开 / kind 推断 ──────────────────────────────────────────────── */

function inferEvidenceKind(filePath, declaredKind) {
  const declared = asText(declaredKind).toLowerCase();
  if (declared === 'report' || declared === 'screenshot') return declared;
  if (declared === 'dir' || declared === 'directory') return 'dir';
  const name = asText(filePath);
  if (REPORT_EXT_RE.test(name)) return 'report';
  if (IMAGE_EXT_RE.test(name)) return 'screenshot';
  return 'file';
}

function sharedEvidenceRoots() {
  return [path.join(ROOT, 'src'), path.join(ROOT, '团队', '工具')];
}

function evidenceRootsOf(projectPath) {
  return [projectPath, ...sharedEvidenceRoots()];
}

/**
 * evidenceFiles[].scope：project → 项目根；workspace → 仓库根。
 * 历史任务里 workspace 证据（src/**、团队/工具/**）若一律按项目根解析会误报不可达。
 */
function evidenceBaseOf(context, scope) {
  return asText(scope).toLowerCase() === 'workspace' ? ROOT : context.projectPath;
}

function isAllowedEvidencePath(context, abs, scope) {
  const roots = asText(scope).toLowerCase() === 'workspace' ? [ROOT] : evidenceRootsOf(context.projectPath);
  return roots.some((root) => {
    if (!fs.existsSync(root)) return false;
    return isInsidePath(root, abs);
  });
}

function walkDir(dir, depth, out) {
  if (depth > MAX_DIR_DEPTH || out.length >= MAX_DIR_FILES) return;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  names.sort();
  for (const name of names) {
    if (name.startsWith('.')) continue;
    const abs = path.join(dir, name);
    let stat;
    try { stat = fs.statSync(abs); } catch { continue; }
    if (stat.isDirectory()) walkDir(abs, depth + 1, out);
    else if (stat.isFile()) out.push(abs);
    if (out.length >= MAX_DIR_FILES) return;
  }
}

function relOf(projectPath, abs) {
  return path.relative(projectPath, abs).replace(/\\/g, '/');
}

/**
 * 历史 `evidenceFiles` 全是 kind=file；目录要先展开再按扩展名推断 kind。
 * 返回 { files, partialMissing, truncated }；不可达/越界路径进 partialMissing。
 */
function expandEvidenceFiles(context, task) {
  const declared = Array.isArray(task.evidenceFiles) ? task.evidenceFiles.slice(0, MAX_EVIDENCE_ENTRIES) : [];
  const files = [];
  const partialMissing = [];
  const seen = new Set();
  const pushFile = (abs, declaredKind, rel) => {
    const key = realpathLower(abs);
    if (!key || seen.has(key)) return;
    seen.add(key);
    files.push({
      abs,
      rel: rel || relOf(context.projectPath, abs),
      kind: inferEvidenceKind(abs, declaredKind),
      declaredKind: asText(declaredKind).toLowerCase()
    });
  };
  for (const item of declared) {
    const rel = asText(item && (item.path || item.rel || item.file)).trim();
    if (!rel) { partialMissing.push(''); continue; }
    const scope = asText(item && item.scope).toLowerCase();
    const base = evidenceBaseOf(context, scope);
    const abs = path.isAbsolute(rel) ? path.resolve(rel) : path.resolve(base, rel);
    let stat;
    try { stat = fs.statSync(abs); } catch { partialMissing.push(rel); continue; }
    if (!isAllowedEvidencePath(context, abs, scope)) {
      partialMissing.push(rel);
      continue;
    }
    if (stat.isDirectory()) {
      const out = [];
      walkDir(abs, 1, out);
      if (!out.length) { partialMissing.push(rel); continue; }
      for (const file of out) pushFile(file, '', relOf(context.projectPath, file));
    } else if (stat.isFile()) {
      pushFile(abs, asText(item && item.kind), rel);
    } else {
      partialMissing.push(rel);
    }
  }
  return { files, partialMissing, truncated: declared.length >= MAX_EVIDENCE_ENTRIES };
}

function evidenceMagic(buffer) {
  if (buffer.length >= 4 && buffer[0] === 0x89 && buffer[1] === 0x50 && buffer[2] === 0x4e && buffer[3] === 0x47) return 'png';
  if (buffer.length >= 3 && buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff) return 'jpg';
  if (buffer.length >= 12 && buffer.slice(0, 4).toString('ascii') === 'RIFF' && buffer.slice(8, 12).toString('ascii') === 'WEBP') return 'webp';
  return '';
}

function readHeadBytes(file, size) {
  const fd = fs.openSync(file, 'r');
  try {
    const buffer = Buffer.alloc(size);
    const read = fs.readSync(fd, buffer, 0, size, 0);
    return buffer.subarray(0, read);
  } finally {
    try { fs.closeSync(fd); } catch { /* ignore */ }
  }
}

function probeEvidence(files) {
  const reports = [];
  const screenshots = [];
  const emptyReportPaths = [];
  const emptyScreenshotPaths = [];
  const readErrors = [];
  const badImages = [];
  for (const file of files) {
    let stat;
    try { stat = fs.statSync(file.abs); } catch { continue; }
    if (file.kind === 'report') {
      if (stat.size <= 0) { emptyReportPaths.push(file.rel); continue; }
      let text = '';
      try {
        text = fs.readFileSync(file.abs).subarray(0, MAX_TEXT_BYTES).toString('utf8');
      } catch (error) {
        readErrors.push({ path: file.rel, message: asText(error && error.message).slice(0, 160) });
        continue;
      }
      reports.push({ ...file, pass: /\bPASS\b/i.test(text), fail: /\bFAIL\b/i.test(text) });
    } else if (file.kind === 'screenshot') {
      if (stat.size <= 0) { emptyScreenshotPaths.push(file.rel); continue; }
      let magic = '';
      try {
        magic = evidenceMagic(readHeadBytes(file.abs, 16));
      } catch (error) {
        readErrors.push({ path: file.rel, message: asText(error && error.message).slice(0, 160) });
        continue;
      }
      if (!magic) badImages.push(file.rel);
      screenshots.push({ ...file, magic });
    }
  }
  return { reports, screenshots, emptyReportPaths, emptyScreenshotPaths, readErrors, badImages };
}

/* ── 判据（F-4657-2 顺序） ──────────────────────────────────────────────── */

/**
 * 判一个 bug 任务的 reason。返回 { eligible, reason, report, screenshot,
 * evidenceItems, partialMissing, criteria }。
 * eligible=false 表示不在扫描集合里（非 bug / 非 done）。
 */
function decideTask(context, entry, options = {}) {
  const task = entry.task;
  const base = {
    eligible: false,
    reason: '',
    report: null,
    screenshot: null,
    evidenceItems: [],
    partialMissing: [],
    criteria: [],
    kindInference: [],
    acceptanceRecord: null
  };
  if (!task || asText(task.type) !== 'bug') return base;
  if (asText(task.status) !== 'done') return base;
  base.eligible = true;

  const record = isPlainObject(task.acceptanceRecord) ? task.acceptanceRecord : null;
  base.acceptanceRecord = record;
  // 口径 v2：effective 只有「项目级显式 true」才为 true（全局开关不再单独生效）。
  if (context.settings && context.settings.effective === false) {
    base.reason = 'switch_off';
    return base;
  }
  const recordStatus = asText(record && record.status).toLowerCase();
  if (recordStatus === 'accepted' || recordStatus === 'retracted') {
    base.reason = 'already_closed';
    return base;
  }

  const declared = Array.isArray(task.evidenceFiles) ? task.evidenceFiles.filter(Boolean) : [];
  if (!declared.length) {
    base.reason = 'no_evidence';
    return base;
  }

  const expanded = expandEvidenceFiles(context, task);
  base.partialMissing = expanded.partialMissing;
  base.kindInference = expanded.files.map((file) => ({ path: file.rel, kind: file.kind }));
  const probe = probeEvidence(expanded.files);

  if (probe.readErrors.length) {
    base.reason = 'read_failed';
    base.readErrors = probe.readErrors;
    return base;
  }
  if (!probe.reports.length) {
    base.reason = probe.emptyReportPaths.length ? 'evidence_empty' : 'report_missing';
    return base;
  }
  if (probe.reports.some((report) => report.fail)) {
    base.reason = 'report_has_fail';
    return base;
  }
  if (!probe.reports.some((report) => report.pass)) {
    base.reason = 'report_no_pass';
    return base;
  }
  const validScreenshots = probe.screenshots.filter((row) => row.magic);
  if (!validScreenshots.length) {
    base.reason = probe.badImages.length ? 'bad_image' : (probe.emptyScreenshotPaths.length ? 'evidence_empty' : 'screenshot_missing');
    return base;
  }

  const duplicateKey = asText(task.id);
  const nowMs = (toDate(options.now) || new Date()).getTime();
  if (options.seen instanceof Map && options.seen.has(duplicateKey)) {
    const last = options.seen.get(duplicateKey);
    if (last && Number.isFinite(Number(last.atMs)) && nowMs - Number(last.atMs) < DUPLICATE_TTL_MS) {
      base.reason = 'duplicate';
      return base;
    }
  }

  // 只把「合格报告 + 合法截图」交给 acceptEvidenceCheck：
  // 目录里可能混有 .log/.txt（同被推断为 report）但没有 PASS，不能因此把合格证据拖成失败。
  const validReports = probe.reports.filter((row) => row.pass && !row.fail);
  const report = validReports[0] || probe.reports[0];
  const screenshot = validScreenshots[0];
  base.report = report;
  base.screenshot = screenshot;
  base.evidenceItems = [
    ...validReports.slice(0, 3).map((row) => ({ path: row.rel, kind: 'report' })),
    { path: screenshot.rel, kind: 'screenshot' }
  ];
  base.criteria = [
    { key: 'type_bug', ok: true },
    { key: 'status_done', ok: true },
    { key: 'evidence_nonempty', ok: true, count: declared.length },
    { key: 'kind_inference', ok: true, files: base.kindInference.slice(0, 20), truncated: expanded.truncated },
    { key: 'report_pass', ok: true, path: report.rel },
    { key: 'screenshot_magic', ok: true, path: screenshot.rel, magic: screenshot.magic },
    { key: 'acceptance_record_empty', ok: !record || recordStatus !== 'accepted' },
    { key: 'partial_missing', ok: base.partialMissing.length === 0, paths: base.partialMissing }
  ];
  base.reason = 'accepted';
  return base;
}

/* ── 审计 jsonl ────────────────────────────────────────────────────────── */

function auditFileOf(context) {
  return path.join(context.stateDir, '自动验收.jsonl');
}

function normalizeAuditRow(row) {
  const out = {};
  for (const key of AUDIT_KEYS) {
    out[key] = Object.prototype.hasOwnProperty.call(row, key) ? row[key] : defaultByKey(key);
  }
  return out;
}

function appendAuditRow(context, row) {
  const clean = normalizeAuditRow(row);
  const file = auditFileOf(context);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.appendFileSync(file, JSON.stringify(clean) + '\n', 'utf8');
  return clean;
}

function auditSkip(context, taskId, reason, batch, extra = {}) {
  const code = ALLOWED_SKIP_REASONS.has(reason) ? reason : 'read_failed';
  return appendAuditRow(context, {
    at: nowIso(),
    project: context.projectName,
    taskId,
    type: 'bug',
    rule: RULE,
    result: 'skip',
    reason: code,
    evidence: [],
    testReport: null,
    partialMissing: Array.isArray(extra.partialMissing) ? extra.partialMissing : [],
    batch: batch || 'manual',
    operator: null
  });
}

/* ── 写任务（原子 + 并发校验） ─────────────────────────────────────────── */

function writeJsonAtomic(file, value) {
  const dir = path.dirname(file);
  const tmp = path.join(dir, `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
  try {
    fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, file);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

function writeTaskOrRestore(entry, nextTask, nextBytes) {
  const tmp = path.join(path.dirname(entry.file), `.${path.basename(entry.file)}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
  fs.writeFileSync(tmp, nextBytes, 'utf8');
  try {
    fs.renameSync(tmp, entry.file);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/** 字节级原子写（撤回失败时恢复原文件，保持原格式/字节不变）。 */
function writeBytesAtomic(file, buffer) {
  const tmp = path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid}-${crypto.randomBytes(3).toString('hex')}`);
  fs.writeFileSync(tmp, buffer);
  try {
    fs.renameSync(tmp, file);
  } finally {
    try { if (fs.existsSync(tmp)) fs.unlinkSync(tmp); } catch { /* ignore */ }
  }
}

/* ── plan ──────────────────────────────────────────────────────────────── */

function emptyGroups() {
  const groups = {};
  for (const reason of [...GROUP_REASONS, ...OTHER_REASONS]) groups[reason] = 0;
  return groups;
}

function baseResult(mode, context, options = {}) {
  return {
    ok: true,
    mode,
    project: context.projectName,
    projectPath: context.projectPath,
    stateDir: context.stateDir,
    auditFile: auditFileOf(context),
    total: 0,
    groups: emptyGroups(),
    closeable: [],
    needEvidence: [],
    partialWarning: [],
    closed: [],
    skipped: [],
    retracted: [],
    failed: [],
    wrote: 0,
    batch: options.batch || 'manual',
    settings: context.settings,
    retractHours: context.retractHours,
    sandbox: {
      teamRoot: context.teamRoot,
      realProjectReadOnly: options.allowRealProject !== true
    },
    generatedAt: nowIso()
  };
}

/**
 * dry-run：只算不写。返回 closeable / needEvidence / partialWarning / groups。
 * 不创建 自动验收.jsonl、不改任务文件。
 */
function plan(context, options = {}) {
  const result = baseResult('plan', context, options);
  const loaded = loadBugTasks(context);
  if (!loaded.ok) return { ...result, ok: false, code: loaded.code, message: loaded.message, taskDir: loaded.taskDir };
  const entries = loaded.tasks.filter((entry) => asText(entry.task.status) === 'done');
  result.total = entries.length;
  const seen = new Map();
  for (const entry of entries) {
    const decision = decideTask(context, entry, { now: options.now, seen });
    const id = asText(entry.task.id);
    const reason = decision.reason || 'read_failed';
    result.groups[reason] = (result.groups[reason] || 0) + 1;
    if (reason === 'accepted') {
      result.closeable.push(id);
      if (decision.partialMissing.length) {
        result.partialWarning.push({ id, partialMissing: decision.partialMissing });
      }
    } else {
      result.needEvidence.push({ id, reason });
      result.skipped.push({ id, reason });
      if (decision.partialMissing.length) {
        result.partialWarning.push({ id, reason, partialMissing: decision.partialMissing });
      }
    }
  }
  const groupSum = Object.values(result.groups).reduce((sum, value) => sum + Number(value || 0), 0);
  result.countCheck = { groupsSum: groupSum, total: result.total, ok: groupSum === result.total };
  result.wrote = 0;
  return result;
}

/* ── run ───────────────────────────────────────────────────────────────── */

function mapEvidenceCheckReason(check) {
  const missing = Array.isArray(check && check.missing) ? check.missing : [];
  for (const item of missing) {
    const reason = asText(item && item.reason);
    if (reason === 'evidence_empty') return 'evidence_empty';
    if (reason === 'evidence_not_image') return 'bad_image';
    if (reason === 'evidence_failed') {
      return /FAIL/i.test(asText(item && item.note)) ? 'report_has_fail' : 'report_no_pass';
    }
    if (reason === 'evidence_missing' && asText(item && item.kind) === 'report') return 'report_missing';
    if (reason === 'evidence_missing' && asText(item && item.kind) === 'screenshot') return 'screenshot_missing';
  }
  return 'read_failed';
}

/**
 * 执行一轮：满足判据的 bug 任务写 acceptanceRecord + acceptedAt/acceptedBy；
 * 每个任务写一行 12 键审计（同状态 60 秒内不重复写，避免 tick 刷屏）。
 */
function run(context, options = {}) {
  const gate = assertCanWrite(context, options);
  if (!gate.ok) {
    return {
      ...baseResult('run', context, options),
      ok: false,
      code: gate.code,
      message: gate.message,
      wrote: 0
    };
  }
  const result = baseResult('run', context, options);
  const loaded = loadBugTasks(context);
  if (!loaded.ok) return { ...result, ok: false, code: loaded.code, message: loaded.message, taskDir: loaded.taskDir };
  const entries = loaded.tasks.filter((entry) => asText(entry.task.status) === 'done');
  result.total = entries.length;
  const seen = options.seen instanceof Map ? options.seen : new Map();
  const lastState = options.lastState instanceof Map ? options.lastState : new Map();
  const batch = options.batch || 'manual';
  const now = toDate(options.now) || new Date();

  /** tick 去重：同一 task 的 reason 没变就不写审计（状态变化才写），避免 30 秒刷屏。 */
  const writeSkipIfChanged = (taskId, reason, partialMissing) => {
    if (lastState.get(taskId) === reason) return false;
    try {
      auditSkip(context, taskId, reason, batch, { partialMissing });
      lastState.set(taskId, reason);
      return true;
    } catch (error) {
      result.failed.push({ id: taskId, code: 'AUDIT_WRITE_FAILED', message: asText(error && error.message).slice(0, 200) });
      return false;
    }
  };

  for (const entry of entries) {
    const id = asText(entry.task.id);
    const decision = decideTask(context, entry, { now, seen });
    const reason = decision.reason || 'read_failed';
    if (reason !== 'accepted') {
      result.groups[reason] = (result.groups[reason] || 0) + 1;
      result.skipped.push({ id, reason });
      result.needEvidence.push({ id, reason });
      if (decision.partialMissing.length) {
        result.partialWarning.push({ id, reason, partialMissing: decision.partialMissing });
      }
      writeSkipIfChanged(id, reason, decision.partialMissing);
      continue;
    }

    const check = evidenceChecker()(context.projectPath, decision.evidenceItems);
    if (!check.ok) {
      const mapped = mapEvidenceCheckReason(check);
      result.groups[mapped] = (result.groups[mapped] || 0) + 1;
      result.skipped.push({ id, reason: mapped });
      result.needEvidence.push({ id, reason: mapped });
      writeSkipIfChanged(id, mapped, decision.partialMissing);
      continue;
    }
    const reportRow = (check.evidence || []).find((row) => asText(row.kind) === 'report') || null;
    if (!reportRow) {
      result.groups.report_missing = (result.groups.report_missing || 0) + 1;
      result.skipped.push({ id, reason: 'report_missing' });
      result.needEvidence.push({ id, reason: 'report_missing' });
      writeSkipIfChanged(id, 'report_missing', decision.partialMissing);
      continue;
    }
    let reportAt = asText(reportRow.at);
    if (!reportAt) {
      try {
        const reportAbs = path.isAbsolute(reportRow.path) ? reportRow.path : path.resolve(context.projectPath, reportRow.path);
        reportAt = fs.statSync(reportAbs).mtime.toISOString();
      } catch { reportAt = nowIso(); }
    }
    const at = nowIso();
    const record = {
      status: 'accepted',
      by: 'system',
      channel: 'auto',
      rule: RULE,
      at,
      evidence: (check.evidence || []).map((row) => ({ path: row.path, sha256: row.sha256, kind: row.kind })),
      testReport: { path: reportRow.path, sha256: reportRow.sha256, at: reportAt },
      criteria: decision.criteria,
      partialMissing: decision.partialMissing
    };
    const nextTask = {
      ...entry.task,
      acceptanceRecord: record,
      acceptedAt: at,
      acceptedBy: 'system',
      updatedAt: at,
      rev: Number(entry.task.rev || 0) + 1,
      workflow: {
        ...(isPlainObject(entry.task.workflow) ? entry.task.workflow : {}),
        acceptanceRecord: record
      }
    };
    // 并发保护：写前 fresh 读；与判定时字节不一致 → state_changed，零副作用。
    let freshSha = '';
    try { freshSha = sha256File(entry.file); } catch { freshSha = ''; }
    if (freshSha !== entry.sha256) {
      result.groups.state_changed = (result.groups.state_changed || 0) + 1;
      result.skipped.push({ id, reason: 'state_changed' });
      result.needEvidence.push({ id, reason: 'state_changed' });
      writeSkipIfChanged(id, 'state_changed', decision.partialMissing);
      continue;
    }
    const nextBytes = JSON.stringify(nextTask, null, 2) + '\n';
    try {
      writeTaskOrRestore(entry, nextTask, nextBytes);
    } catch (error) {
      result.groups.read_failed = (result.groups.read_failed || 0) + 1;
      result.failed.push({ id, code: 'TASK_WRITE_FAILED', message: asText(error && error.message).slice(0, 200) });
      continue;
    }
    try {
      appendAuditRow(context, {
        at,
        project: context.projectName,
        taskId: id,
        type: 'bug',
        rule: RULE,
        result: 'accepted',
        reason: null,
        evidence: record.evidence,
        testReport: record.testReport,
        partialMissing: decision.partialMissing,
        batch,
        operator: null
      });
    } catch (error) {
      // 审计写失败不落账：把任务文件恢复成判定前字节。
      try { writeTaskOrRestore(entry, null, entry.raw.toString('utf8')); } catch { /* 恢复失败写 failed */ }
      result.groups.read_failed = (result.groups.read_failed || 0) + 1;
      result.failed.push({ id, code: 'AUDIT_WRITE_FAILED', message: asText(error && error.message).slice(0, 200) });
      continue;
    }
    result.groups.accepted = (result.groups.accepted || 0) + 1;
    result.closed.push({ id, testReport: record.testReport, evidenceCount: record.evidence.length });
    seen.set(id, { atMs: now.getTime() });
    lastState.set(id, 'accepted');
  }

  result.wrote = result.closed.length;
  const groupSum = Object.values(result.groups).reduce((sum, value) => sum + Number(value || 0), 0);
  result.countCheck = { groupsSum: groupSum, total: result.total, ok: groupSum === result.total };
  result.ok = result.failed.length === 0;
  return result;
}

/* ── retract ───────────────────────────────────────────────────────────── */

/**
 * 撤回自动验收：窗口内把 acceptanceRecord.status 改成 retracted；
 * 超窗/不存在/重复撤回零副作用；成功/失败都写一行 retract 审计。
 */
function retract(context, options = {}) {
  const result = {
    ...baseResult('retract', context, options),
    ok: true,
    code: 'OK',
    retracted: [],
    failed: [],
    wrote: 0
  };
  const gate = assertCanWrite(context, options);
  if (!gate.ok) return { ...result, ok: false, code: gate.code, message: gate.message };
  const operator = asText(options.operator || 'owner').toLowerCase();
  if (operator !== 'owner' && operator !== 'pm') {
    return { ...result, ok: false, code: 'ROLE_NOT_ALLOWED', message: `撤回只允许 Owner 或 PM（收到 ${operator || '(空)'}）` };
  }
  const taskIds = (Array.isArray(options.taskIds) ? options.taskIds : [])
    .map((id) => asText(id).trim())
    .filter(Boolean);
  const uniqueIds = [...new Set(taskIds)];
  if (!uniqueIds.length) {
    return { ...result, ok: false, code: 'AUTO_ACCEPT_BAD_ARGS', message: '撤回需要至少一个 taskId' };
  }
  const now = toDate(options.now) || new Date();
  const nowMs = now.getTime();
  const hours = resolveRetractHours(context.retractHours !== undefined ? { retractHours: context.retractHours } : {});
  const windowMs = hours * 3600 * 1000;
  const batch = options.batch || 'manual';
  const reasonText = asText(options.reason).slice(0, 300);

  for (const id of uniqueIds) {
    if (!TASK_ID_RE.test(id)) {
      result.failed.push({ id, code: 'RETRACT_NOT_FOUND', message: '任务 id 形态非法' });
      continue;
    }
    const file = path.join(taskDirOf(context), id + '.json');
    if (!fs.existsSync(file)) {
      result.failed.push({ id, code: 'RETRACT_NOT_FOUND', message: '任务文件不存在' });
      try {
        appendAuditRow(context, {
          at: nowIso(), project: context.projectName, taskId: id, type: 'bug', rule: RULE,
          result: 'retract', reason: 'retract_not_found', evidence: [], testReport: null,
          partialMissing: [], batch, operator
        });
      } catch { /* 审计失败不改变失败原因 */ }
      continue;
    }
    let raw;
    try { raw = fs.readFileSync(file); } catch (error) {
      result.failed.push({ id, code: 'RETRACT_NOT_FOUND', message: asText(error && error.message).slice(0, 160) });
      continue;
    }
    let task;
    try { task = JSON.parse(raw.toString('utf8').replace(/^\uFEFF/, '')); } catch { task = null; }
    if (!task || asText(task.type) !== 'bug') {
      result.failed.push({ id, code: 'RETRACT_NOT_FOUND', message: '不是缺陷任务' });
      continue;
    }
    const record = isPlainObject(task.acceptanceRecord) ? task.acceptanceRecord : null;
    const recordStatus = asText(record && record.status).toLowerCase();
    if (recordStatus !== 'accepted') {
      result.failed.push({ id, code: 'RETRACT_NOOP', message: `没有可撤回的自动验收记录（当前 ${recordStatus || '无记录'}）` });
      try {
        appendAuditRow(context, {
          at: nowIso(), project: context.projectName, taskId: id, type: 'bug', rule: RULE,
          result: 'retract', reason: 'retract_noop',
          evidence: Array.isArray(record && record.evidence) ? record.evidence : [],
          testReport: (record && record.testReport) || null,
          partialMissing: [], batch, operator
        });
      } catch { /* ignore */ }
      continue;
    }
    const acceptedMs = Date.parse(asText(record.at));
    if (!Number.isFinite(acceptedMs) || nowMs - acceptedMs > windowMs) {
      result.failed.push({ id, code: 'RETRACT_WINDOW_EXPIRED', message: `已超过撤回窗口（${hours} 小时）` });
      try {
        appendAuditRow(context, {
          at: nowIso(), project: context.projectName, taskId: id, type: 'bug', rule: RULE,
          result: 'retract', reason: 'retract_window_expired',
          evidence: Array.isArray(record.evidence) ? record.evidence : [],
          testReport: record.testReport || null,
          partialMissing: [], batch, operator
        });
      } catch { /* ignore */ }
      continue;
    }
    const at = nowIso();
    const nextRecord = {
      ...record,
      status: 'retracted',
      retractedAt: at,
      retractedBy: operator,
      retractReason: reasonText
    };
    const nextTask = {
      ...task,
      acceptanceRecord: nextRecord,
      retractedAt: at,
      retractedBy: operator,
      updatedAt: at,
      rev: Number(task.rev || 0) + 1,
      workflow: {
        ...(isPlainObject(task.workflow) ? task.workflow : {}),
        acceptanceRecord: nextRecord
      }
    };
    try {
      writeJsonAtomic(file, nextTask);
    } catch (error) {
      result.failed.push({ id, code: 'RETRACT_WRITE_FAILED', message: asText(error && error.message).slice(0, 200) });
      continue;
    }
    try {
      appendAuditRow(context, {
        at,
        project: context.projectName,
        taskId: id,
        type: 'bug',
        rule: RULE,
        result: 'retract',
        reason: 'retracted',
        evidence: Array.isArray(record.evidence) ? record.evidence : [],
        testReport: record.testReport || null,
        partialMissing: [],
        batch,
        operator
      });
    } catch (error) {
      try { writeBytesAtomic(file, raw); } catch { /* ignore */ }
      result.failed.push({ id, code: 'AUDIT_WRITE_FAILED', message: asText(error && error.message).slice(0, 200) });
      continue;
    }
    result.retracted.push({ id, at, retractedBy: operator });
  }
  result.wrote = result.retracted.length;
  result.ok = result.failed.length === 0;
  result.code = result.ok ? 'OK' : (result.failed[0] && result.failed[0].code) || 'RETRACT_FAILED';
  return result;
}

/* ── watch / tick（主进程与 CLI --watch 共用） ──────────────────────────── */

function createAutoAcceptRunner(options = {}) {
  const resolveContext = typeof options.resolveContext === 'function'
    ? options.resolveContext
    : (() => options.context || null);
  const tickMs = Math.max(1000, Number(options.tickMs) || DEFAULT_TICK_MS);
  const debounceMs = Math.max(50, Number(options.debounceMs) || WATCH_DEBOUNCE_MS);
  const seen = new Map();
  const lastState = new Map();
  let watcher = null;
  let watchDir = '';
  let debounceTimer = null;
  let tickTimer = null;
  let running = false;
  let stopped = false;

  const log = (message) => {
    if (typeof options.log === 'function') {
      try { options.log(message); } catch { /* ignore */ }
    }
  };

  const scanNow = async (batch) => {
    if (stopped || running) return null;
    running = true;
    try {
      const context = resolveContext();
      if (!context) return null;
      if (context.ok === false) return { ok: false, code: context.code, message: context.message };
      const result = run(context, {
        allowRealProject: options.allowRealProject === true,
        batch: batch || 'live',
        seen,
        lastState,
        now: new Date()
      });
      if (typeof options.onResult === 'function') {
        try { options.onResult(result); } catch { /* callback 自身异常忽略 */ }
      }
      return result;
    } catch (error) {
      const message = `AUTO_ACCEPT_ERROR ${asText(error && (error.stack || error.message || error)).slice(0, 300)}`;
      log(message);
      return { ok: false, code: 'AUTO_ACCEPT_ERROR', message };
    } finally {
      running = false;
    }
  };

  const ensureWatch = () => {
    if (stopped) return;
    let context = null;
    try { context = resolveContext(); } catch { context = null; }
    if (!context || context.ok === false) return;
    const dir = path.join(context.stateDir, '任务');
    if (watcher && watchDir === dir) return;
    if (watcher) {
      try { watcher.close(); } catch { /* ignore */ }
      watcher = null;
      watchDir = '';
    }
    try {
      watcher = fs.watch(dir, (_event, filename) => {
        if (filename && !asText(filename).endsWith('.json')) return;
        if (debounceTimer) clearTimeout(debounceTimer);
        debounceTimer = setTimeout(() => {
          debounceTimer = null;
          void scanNow('live');
        }, debounceMs);
        if (debounceTimer && typeof debounceTimer.unref === 'function') debounceTimer.unref();
      });
      watcher.on('error', () => {
        try { if (watcher) watcher.close(); } catch { /* ignore */ }
        watcher = null;
        watchDir = '';
      });
      watchDir = dir;
    } catch (error) {
      log(`AUTO_ACCEPT_WATCH_FAIL ${asText(error && error.message).slice(0, 160)}`);
    }
  };

  const start = () => {
    if (stopped) return;
    const initialDelay = Math.max(0, Number(options.initialDelayMs) || 0);
    if (initialDelay > 0) {
      const timer = setTimeout(() => {
        ensureWatch();
        void scanNow(options.batchStart || 'first-scan');
      }, initialDelay);
      if (typeof timer.unref === 'function') timer.unref();
    } else {
      ensureWatch();
      void scanNow(options.batchStart || 'first-scan');
    }
    tickTimer = setInterval(() => {
      ensureWatch();
      void scanNow('live');
    }, tickMs);
    if (tickTimer && typeof tickTimer.unref === 'function') tickTimer.unref();
  };

  const stop = () => {
    stopped = true;
    if (debounceTimer) clearTimeout(debounceTimer);
    if (tickTimer) clearInterval(tickTimer);
    debounceTimer = null;
    tickTimer = null;
    if (watcher) { try { watcher.close(); } catch { /* ignore */ } }
    watcher = null;
    watchDir = '';
  };

  return {
    start,
    stop,
    scanNow,
    status: () => ({ running, stopped, tickMs, debounceMs, watchDir, watches: Boolean(watcher) })
  };
}

/* ── CLI ───────────────────────────────────────────────────────────────── */

const EXIT_OK = 0;
const EXIT_FAIL = 1;
const EXIT_USAGE = 2;

const USAGE = [
  'R-4657 缺陷验收自动化 CLI',
  '',
  '用法：',
  '  node scripts/auto-accept.cjs --project <名> [--plan|--dry-run] [--json]',
  '  node scripts/auto-accept.cjs --project <名> --run --once [--json]',
  '  node scripts/auto-accept.cjs --project <名> --retract <id[,id]> [--reason <文本>] [--json]',
  '',
  '选项：',
  '  --plan / --dry-run        只算不写（默认）',
  '  --run                     执行（只允许沙盘；真实项目拒绝）',
  '  --retract <ids>           撤回自动验收（窗口内）',
  '  --retract-hours <n>       撤回窗口小时数（默认 24；也可用 AWB_AUTO_ACCEPT_RETRACT_HOURS）',
  '  --reason <文本>           撤回原因（写任务 retractReason，不进审计 reason 白名单键）',
  '  --operator owner|pm       撤回人（默认 owner）',
  '  --now <ISO>               指定“当前时间”（测试用）',
  '  --once                    单次执行（默认就是单次；与 --watch 互斥）',
  '  --watch                   常驻：watch 300ms 防抖 + tick 30000ms 轮询',
  '  --team-root <dir>         团队根（沙盘用；等价 TEAM_ROOT）',
  '  --store <file>            本地状态库（只读开关/项目列表；等价 AWB_STORE）',
  '  --batch <值>              live | first-scan | manual',
  '  --json                    只输出 JSON',
  '  --help                    显示本帮助',
  '',
  '退出码：0=成功（含 dry-run）；1=校验/执行失败；2=用法或环境/IO 错误。'
].join('\n');

function parseArgs(argv) {
  const args = {
    mode: 'plan',
    project: '',
    teamRoot: '',
    store: '',
    stateDir: '',
    retractIds: [],
    retractHours: null,
    reason: '',
    operator: 'owner',
    now: '',
    json: false,
    once: false,
    watch: false,
    batch: '',
    help: false
  };
  const takeValue = (index, token) => {
    const eq = token.indexOf('=');
    if (eq >= 0) return { value: token.slice(eq + 1), next: index };
    const next = index + 1;
    if (next >= argv.length) return { error: `缺少参数值：${token}` };
    return { value: argv[next], next };
  };
  for (let i = 0; i < argv.length; i += 1) {
    const token = argv[i];
    if (!token) continue;
    if (!token.startsWith('--')) return { error: `不认识的参数：${token}` };
    const name = token.split('=')[0];
    if (name === '--help' || name === '-h') { args.help = true; continue; }
    if (name === '--json') { args.json = true; continue; }
    if (name === '--plan' || name === '--dry-run') { args.mode = 'plan'; continue; }
    if (name === '--run') { args.mode = 'run'; continue; }
    if (name === '--once') { args.once = true; continue; }
    if (name === '--watch') { args.watch = true; continue; }
    if (name === '--retract') {
      const got = takeValue(i, token);
      if (got.error) return got;
      i = got.next;
      args.mode = 'retract';
      args.retractIds = String(got.value).split(/[,\s]+/).map((item) => item.trim()).filter(Boolean);
      continue;
    }
    if (name === '--retract-hours') {
      const got = takeValue(i, token);
      if (got.error) return got;
      i = got.next;
      const hours = Number(got.value);
      if (!Number.isFinite(hours) || hours < 0) return { error: `--retract-hours 需要非负数字：${got.value}` };
      args.retractHours = hours;
      continue;
    }
    if (name === '--project' || name === '--team-root' || name === '--store' || name === '--state-dir'
      || name === '--reason' || name === '--operator' || name === '--now' || name === '--batch') {
      const got = takeValue(i, token);
      if (got.error) return got;
      i = got.next;
      args[name === '--project' ? 'project'
        : name === '--team-root' ? 'teamRoot'
          : name === '--store' ? 'store'
            : name === '--state-dir' ? 'stateDir'
              : name === '--reason' ? 'reason'
                : name === '--operator' ? 'operator'
                  : name === '--now' ? 'now' : 'batch'] = String(got.value);
      continue;
    }
    return { error: `不认识的参数：${token}` };
  }
  if (args.mode === 'retract' && !args.retractIds.length) return { error: '--retract 需要至少一个 taskId' };
  if (args.once && args.watch) return { error: '--once 与 --watch 不能同时使用' };
  if (args.watch && args.mode !== 'run') return { error: '--watch 只能配合 --run（常驻自动收口）；dry-run 请用默认 --plan' };
  if (args.operator && !['owner', 'pm'].includes(args.operator.toLowerCase())) return { error: `--operator 只能是 owner / pm：${args.operator}` };
  return { args };
}

function contextOptions(args) {
  return {
    projectName: args.project,
    teamRoot: args.teamRoot || undefined,
    projectsRoot: undefined,
    storeFile: args.store || undefined,
    stateDir: args.stateDir || undefined,
    retractHours: args.retractHours === null ? undefined : args.retractHours
  };
}

function printHuman(result) {
  const lines = [];
  const mode = asText(result.mode || 'plan');
  if (result.ok === false) {
    lines.push(`失败：${result.code || 'AUTO_ACCEPT_FAILED'} ${result.message || ''}`.trim());
  } else if (mode === 'plan') {
    lines.push(`计划（dry-run）：${result.project} 共 ${result.total} 条 done 缺陷`);
    lines.push(`分组：${GROUP_REASONS.map((reason) => `${reason}=${result.groups[reason] || 0}`).join(' · ')}`);
    const others = OTHER_REASONS.filter((reason) => Number(result.groups[reason] || 0) > 0)
      .map((reason) => `${reason}=${result.groups[reason]}`);
    if (others.length) lines.push(`其它：${others.join(' · ')}`);
    lines.push(`可收口 ${result.closeable.length} 条${result.closeable.length ? '：' + result.closeable.join(', ') : ''}`);
    if (result.partialWarning.length) lines.push(`部分证据不可达 ${result.partialWarning.length} 条（见 JSON partialWarning）`);
    lines.push('dry-run 不写任务文件、不写审计 jsonl。');
  } else if (mode === 'run') {
    lines.push(`执行完成：收口 ${result.closed.length} 条，跳过 ${result.skipped.length} 条，失败 ${result.failed.length} 条`);
    if (result.closed.length) lines.push(`已收口：${result.closed.map((row) => row.id).join(', ')}`);
    if (result.failed.length) lines.push(`失败：${result.failed.map((row) => `${row.id}(${row.code})`).join(', ')}`);
    lines.push(`审计：${result.auditFile}`);
  } else {
    lines.push(`撤回完成：成功 ${result.retracted.length} 条，失败 ${result.failed.length} 条`);
    if (result.retracted.length) lines.push(`已撤回：${result.retracted.map((row) => row.id).join(', ')}`);
    if (result.failed.length) lines.push(`失败：${result.failed.map((row) => `${row.id}(${row.code})`).join(', ')}`);
  }
  process.stdout.write(lines.join('\n') + '\n');
}

async function main(argv) {
  const parsed = parseArgs(argv);
  if (parsed.error) {
    process.stderr.write(parsed.error + '\n\n' + USAGE + '\n');
    return EXIT_USAGE;
  }
  const args = parsed.args;
  if (args.help) {
    process.stdout.write(USAGE + '\n');
    return EXIT_OK;
  }

  const makeContext = () => resolveProjectContext(contextOptions(args));
  const context = makeContext();
  if (!context.ok) {
    const payload = { ok: false, mode: args.mode, code: context.code, message: context.message };
    if (args.json) process.stdout.write(JSON.stringify(payload) + '\n');
    else printHuman(payload);
    return EXIT_USAGE;
  }

  if (args.watch) {
    const runner = createAutoAcceptRunner({
      resolveContext: makeContext,
      tickMs: Number(process.env.AWB_AUTO_ACCEPT_TICK_MS) || DEFAULT_TICK_MS,
      debounceMs: WATCH_DEBOUNCE_MS,
      allowRealProject: false,
      batchStart: 'first-scan',
      onResult: (result) => {
        if (args.json) process.stdout.write(JSON.stringify(result) + '\n');
        else printHuman(result);
      },
      log: (message) => process.stderr.write(message + '\n')
    });
    runner.start();
    return new Promise((resolve) => {
      const stop = () => { runner.stop(); resolve(EXIT_OK); };
      process.on('SIGINT', stop);
      process.on('SIGTERM', stop);
    });
  }

  const now = args.now ? toDate(args.now) : new Date();
  if (args.now && !now) {
    process.stderr.write(`--now 不是合法时间：${args.now}\n`);
    return EXIT_USAGE;
  }

  let result;
  try {
    if (args.mode === 'retract') {
      result = retract(context, {
        taskIds: args.retractIds,
        reason: args.reason,
        operator: args.operator,
        allowRealProject: false,
        batch: args.batch || 'manual',
        now
      });
    } else if (args.mode === 'run') {
      result = run(context, {
        allowRealProject: false,
        batch: args.batch || 'manual',
        now
      });
    } else {
      result = plan(context, { batch: args.batch || 'manual', now });
    }
  } catch (error) {
    const payload = {
      ok: false,
      mode: args.mode,
      code: asText(error && error.code) || 'AUTO_ACCEPT_IO_ERROR',
      message: asText(error && error.message).slice(0, 300)
    };
    if (args.json) process.stdout.write(JSON.stringify(payload) + '\n');
    else printHuman(payload);
    return EXIT_USAGE;
  }

  if (args.json) process.stdout.write(JSON.stringify(result) + '\n');
  else printHuman(result);

  if (result.ok === false) {
    if (result.code === 'AUTO_ACCEPT_REAL_PROJECT_READ_ONLY') return EXIT_FAIL;
    if (result.mode === 'retract' || result.mode === 'run') return EXIT_FAIL;
    return EXIT_USAGE;
  }
  if (args.mode === 'retract' || args.mode === 'run') return result.failed.length ? EXIT_FAIL : EXIT_OK;
  return EXIT_OK;
}

module.exports = {
  RULE,
  GROUP_REASONS,
  OTHER_REASONS,
  RETRACT_REASONS,
  ALLOWED_SKIP_REASONS,
  AUDIT_KEYS,
  DEFAULT_RETRACT_HOURS,
  WATCH_DEBOUNCE_MS,
  DEFAULT_TICK_MS,
  resolveProjectContext,
  resolveAutoAcceptSettings,
  resolveRetractHours,
  inferEvidenceKind,
  expandEvidenceFiles,
  decideTask,
  plan,
  run,
  /** 需求正文里的函数名：单源实现。 */
  autoAcceptBugTasks: run,
  retract,
  createAutoAcceptRunner,
  auditFileOf,
  resolveStoreFile: storeFileOf,
  assertCanWrite
};

if (require.main === module) {
  main(process.argv.slice(2))
    .then((code) => { process.exitCode = code; })
    .catch((error) => {
      process.stderr.write(`AUTO_ACCEPT_FATAL ${asText(error && (error.stack || error.message || error))}\n`);
      process.exitCode = EXIT_USAGE;
    });
}
