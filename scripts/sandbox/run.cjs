#!/usr/bin/env node
'use strict';

/**
 * R-20261115-030035-7841 · 独立测试环境沙盘（方案 A：独立 DSH_HOME + 团队根 + 项目快照 + 数据目录）
 *
 * 目的：换人/轮换（session rotate）、名册/角色卡/铁律变更、消息与唤醒、迁移归档、门禁矩阵、
 * 破坏性脚本这 6 类测试，一律在 `.sandbox/<run-id>/` 里跑；真实团队状态与**代码工作树**零改动，
 * 并用「沙盘标记探针 + 真实文件哈希 + git status/HEAD」三重断言证明（AC1/AC2/AC7）。
 *
 * 子命令
 *   seed   --root .sandbox/<id> [--project 名称] [--full]
 *          最小快照（团队.json + 工作流.json + 任务/*.json 三件必带；--full 才整目录复制），
 *          清空 members[].sessionId / activeProject，把项目快照指向沙盘目录（防 rotate 写真实 团队会话.json），
 *          写 sandbox.json（隔离根、真实文件基线、git 基线、沙盘标记）。
 *   run    --root .sandbox/<id> (--case <用例名> | -- <命令...>) [--no-selftest] [--no-wake]
 *          [--in-worktree] [--timeout ms]
 *          在隔离环境执行：四类路径根 + TEAM_WORKBENCH_JSON 全部指向沙盘；剥离真实 DSH/AWB/TEAM 变量。
 *          漏设 TEAM_SELFTEST（--no-selftest）时拒绝「会改状态/发消息」的用例（SANDBOX_SELFTEST_MISSING）。
 *          前后比对 git status/HEAD，代码工作树被改 → SANDBOX_CODE_DIRTY。
 *   verify --root .sandbox/<id> [--strict]
 *          沙盘标记是否漏进真实文件（无条件 FAIL）＋ 真实文件哈希漂移（默认只报告，--strict 判 FAIL）
 *          ＋ git 代码工作树漂移（SANDBOX_CODE_DIRTY）＋ 最小快照三件是否齐（SANDBOX_SNAPSHOT_INCOMPLETE）。
 *   snapshot --root .sandbox/<id>   只读检查最小快照三件。
 *   worktree --root .sandbox/<id>   git worktree 检出独立代码副本（AC7：验代码改动走 worktree）。
 *   clean  [--root .sandbox/<id>] [--all --yes] [--dry-run] [--keep 3]
 *          默认保留策略：失败运行无条件保留 + 最近 N 次成功运行；其余删除。--all 需 --yes 显式确认。
 *   list                            列出 .sandbox 下所有运行目录与状态。
 *
 * 用例（scripts/sandbox/cases/*.cjs）：① rotate 换人 ② 名册/规则变更 ③ 消息与唤醒
 * ④ 迁移/归档 ⑤ 权限门禁 ⑥ 破坏性批量写入。用例入口由 cases/index.json 登记。
 *
 * 退出码
 *   0 成功 ｜ 2 用法 ｜ 3 SANDBOX_PATH_OUTSIDE ｜ 4 SANDBOX_LEAK ｜ 5 SANDBOX_SOURCE_MISSING
 *   6 SANDBOX_DIRTY_ROSTER ｜ 7 SANDBOX_CODE_DIRTY ｜ 8 SANDBOX_SELFTEST_MISSING
 *   9 SANDBOX_SNAPSHOT_INCOMPLETE ｜ 10 SANDBOX_CLEAN_NEEDS_CONFIRM
 */
const { spawnSync } = require('node:child_process');
const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const DEFAULT_SANDBOX_BASE = path.join(ROOT, '.sandbox');
/** 测试钩子：允许把沙盘基目录换成 .sandbox 内的子目录（只在断言脚本里用，绝不指到真实目录）。 */
const SANDBOX_BASE = (() => {
  const raw = String(process.env.SANDBOX_BASE || '').trim();
  if (!raw) return DEFAULT_SANDBOX_BASE;
  const abs = path.resolve(raw);
  const inside = abs.toLowerCase().startsWith(DEFAULT_SANDBOX_BASE.toLowerCase() + path.sep);
  if (!inside) {
    console.error(`[SANDBOX_PATH_OUTSIDE] SANDBOX_BASE 只允许指向 ${DEFAULT_SANDBOX_BASE} 之内：${abs}`);
    process.exit(3);
  }
  return abs;
})();
const CASES_DIR = path.join(__dirname, 'cases');
const REAL_TEAM = path.join(ROOT, '团队');
const REAL_DATA = path.join(ROOT, 'data');
const REAL_WORKBENCH = path.join(REAL_DATA, 'userdata', 'workbench.json');
const REAL_PROJECT_ROOT = path.join(ROOT, '项目');
const DEFAULT_PROJECT = '工作台改造修复';
/** 沙盘伪造的“新会话 id”：既给 rotate 当目标，也当**泄漏探针**——出现在真实文件里就是 LEAK。 */
const SANDBOX_MARKER = 'session-sandbox-probe-0001';
/** 消息探针：沙盘发出的消息正文带它，出现在真实邮箱里就是 LEAK。 */
const MESSAGE_MARKER = 'SANDBOX-MSG-PROBE-7841';
const ROLE_DIRS = {
  pm: '项目经理', product: '产品', analyst: '需求分析师',
  programmer1: '程序员A', programmer2: '程序员B', tester: '测试人员',
};
/** 最小快照三件（AC8）：团队名册 / 工作流 / 任务。 */
const SNAPSHOT_ITEMS = [
  { key: 'roster', label: '团队/状态/团队.json', rel: path.join('团队', '状态', '团队.json') },
  { key: 'workflow', label: '团队/状态/项目/<项目>/工作流.json', rel: path.join('团队', '状态', '项目', '%PROJECT%', '工作流.json') },
  { key: 'tasks', label: '团队/状态/项目/<项目>/任务/*.json', rel: path.join('团队', '状态', '项目', '%PROJECT%', '任务') },
];

const EXIT = {
  USAGE: 2, PATH_OUTSIDE: 3, LEAK: 4, SOURCE_MISSING: 5, DIRTY_ROSTER: 6,
  CODE_DIRTY: 7, SELFTEST_MISSING: 8, SNAPSHOT_INCOMPLETE: 9, CLEAN_NEEDS_CONFIRM: 10,
};

function fail(code, message, details = {}) {
  // 打印统一带 SANDBOX_ 前缀（退出码见上表），便于日志检索
  const label = code === 'USAGE' ? 'USAGE' : (code.startsWith('SANDBOX_') ? code : `SANDBOX_${code}`);
  console.error(`[${label}] ${message}`);
  if (Object.keys(details).length) console.error(JSON.stringify(details, null, 2));
  process.exit(EXIT[code] || EXIT.USAGE);
}

function emit(payload) {
  console.log(JSON.stringify(payload, null, 2));
}

function parseArgs(argv) {
  const args = argv.slice(2);
  const cmd = args.shift() || '';
  const out = { cmd, root: '', project: '', case: '', command: [], full: false, strict: false, assertCode: false, noSelftest: false, noWake: false, inWorktree: false, all: false, yes: false, dryRun: false, keep: 3, timeout: 120000 };
  for (let i = 0; i < args.length; i += 1) {
    const a = args[i];
    if (a === '--') { out.command = args.slice(i + 1); break; }
    switch (a) {
      case '--root': out.root = args[++i] || ''; break;
      case '--project': out.project = args[++i] || ''; break;
      case '--case': out.case = args[++i] || ''; break;
      case '--full': out.full = true; break;
      case '--strict': out.strict = true; break;
      case '--assert-code': out.assertCode = true; break;
      case '--no-selftest': out.noSelftest = true; break;
      case '--no-wake': out.noWake = true; break;
      case '--in-worktree': out.inWorktree = true; break;
      case '--all': out.all = true; break;
      case '--yes': out.yes = true; break;
      case '--dry-run': out.dryRun = true; break;
      case '--keep': out.keep = Math.max(0, Number(args[++i] || 3)); break;
      case '--timeout': out.timeout = Math.max(1000, Number(args[++i] || 120000)); break;
      default: if (!a.startsWith('--') && !out.command.length) out.command.push(a); break;
    }
  }
  return out;
}

/* ───────────────────────── 通用工具 ───────────────────────── */

function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return ''; }
}

function exists(p) {
  try { fs.accessSync(p); return true; } catch { return false; }
}

function readJson(file, fallback = null) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return fallback; }
}

function writeJsonAtomic(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp-${process.pid}-${Date.now()}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, file);
}

function rel(target) {
  return path.relative(ROOT, target);
}

function assertInsideSandbox(target) {
  const abs = path.resolve(target);
  const base = SANDBOX_BASE.toLowerCase() + path.sep;
  if (!abs.toLowerCase().startsWith(base)) fail('PATH_OUTSIDE', `拒绝运行：路径必须位于 ${SANDBOX_BASE} 下（收到 ${abs}）`, { target: abs });
  return abs;
}

function listDir(dir) {
  try { return fs.readdirSync(dir, { withFileTypes: true }); } catch { return []; }
}

/** 递归收集文本文件（泄漏探针只扫文本状态，避免读二进制大文件）。 */
function walkTextFiles(dir, out = [], limit = 20000) {
  for (const entry of listDir(dir)) {
    if (out.length >= limit) break;
    const file = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (['node_modules', '.git', '.sandbox', '_archive', '备份'].includes(entry.name)) continue;
      walkTextFiles(file, out, limit);
    } else if (/\.(json|jsonl|md|cjs|mjs)$/i.test(entry.name)) {
      out.push(file);
    }
  }
  return out;
}

/* ───────────────────────── git（代码工作树隔离，AC1/AC7） ───────────────────────── */

function gitSnapshot(cwd = ROOT) {
  const run = (args) => {
    const r = spawnSync('git', args, { cwd, encoding: 'utf8', windowsHide: true });
    return { ok: r.status === 0, out: String(r.stdout || '').replace(/\r\n/g, '\n'), err: String(r.stderr || '') };
  };
  const head = run(['rev-parse', 'HEAD']);
  const status = run(['status', '--porcelain']);
  return {
    cwd,
    isRepo: head.ok,
    head: head.ok ? head.out.trim() : '',
    headShort: head.ok ? head.out.trim().slice(0, 7) : '',
    status: status.ok ? status.out.split('\n').filter(Boolean) : [],
  };
}

function diffStatus(before, after) {
  const b = new Set(before);
  const a = new Set(after);
  return {
    added: after.filter((line) => !b.has(line)),
    removed: before.filter((line) => !a.has(line)),
  };
}

/**
 * git status 行 → 是否「沙盘自己能写出来的路径」。
 * 沙盘写的东西全在 .sandbox/_tmp/data/项目/团队状态 里（且多数已被 .gitignore 覆盖）；
 * 其它被改动的 src/scripts/docs 只可能是**别的角色在同时编辑共享工作树**（本项目多角色并行），
 * 不能算沙盘污染 —— 这类差异只作 external 提示，--strict 时才判 FAIL。
 */
const SANDBOX_OWNED_RE = /(^|\/)(\.sandbox|_tmp|data|项目|团队\/状态)(\/|$)/i;
function splitCodeDiff(diff) {
  const owned = [];
  const external = [];
  for (const line of [...diff.added, ...diff.removed]) {
    const file = line.replace(/^[ \t]*[A-Z?!]{1,2}[ \t]+/, '').replace(/^"|"$/g, '').replace(/\\/g, '/');
    (SANDBOX_OWNED_RE.test(file) ? owned : external).push(line);
  }
  return { owned, external };
}

/* ───────────────────────── 真实文件基线（生产零改动证明） ───────────────────────── */

function realTrackedFiles(meta) {
  const files = [];
  const push = (file) => { if (file && exists(file)) files.push(file); };
  push(REAL_WORKBENCH);
  push(path.join(REAL_TEAM, '状态', '团队.json'));
  push(path.join(REAL_TEAM, '状态', '会话.json'));
  const projectName = (meta && meta.project) || DEFAULT_PROJECT;
  push(path.join(REAL_TEAM, '状态', '项目', projectName, '工作流.json'));
  push(path.join(REAL_TEAM, '状态', '项目', projectName, '评审代管.json'));
  push(path.join(REAL_PROJECT_ROOT, projectName, '团队会话.json'));
  return files;
}

function snapshotReal(files) {
  return files.map((file) => ({ file, sha256: sha256File(file), mtimeMs: exists(file) ? fs.statSync(file).mtimeMs : 0 }));
}

/** 泄漏探针：真实文件里出现沙盘标记 = 数据漏到生产（无条件 FAIL，不受 --strict 影响）。 */
function leakScan(meta) {
  const markers = [SANDBOX_MARKER];
  const hits = [];
  const files = realTrackedFiles(meta);
  const mailbox = path.join(REAL_TEAM, '状态', '邮箱');
  for (const dir of listDir(mailbox)) {
    if (!dir.isDirectory()) continue;
    for (const box of ['new', 'cur']) walkTextFiles(path.join(mailbox, dir.name, box), files, 4000);
  }
  for (const file of files) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    for (const marker of markers) {
      if (text.includes(marker)) hits.push({ file: rel(file), marker });
    }
    if (text.includes(MESSAGE_MARKER)) hits.push({ file: rel(file), marker: MESSAGE_MARKER });
  }
  return hits;
}

/* ───────────────────────── 最小快照（AC8） ───────────────────────── */

function snapshotCheck(root, meta) {
  const projectName = meta.project;
  const rows = SNAPSHOT_ITEMS.map((item) => {
    const target = path.join(root, item.rel.replace('%PROJECT%', projectName));
    if (item.key === 'tasks') {
      const count = listDir(target).filter((e) => e.isFile() && /\.json$/i.test(e.name)).length;
      return { key: item.key, label: item.label, count, ok: count > 0, path: rel(target) };
    }
    return { key: item.key, label: item.label, ok: exists(target), path: rel(target) };
  });
  return { ok: rows.every((row) => row.ok), items: rows };
}

/* ───────────────────────── 环境隔离 ───────────────────────── */

function sandboxEnv(meta, { noSelftest = false, noWake = false } = {}) {
  const env = {};
  // 先剥离所有可能把子进程带回真实实例的变量（真实 DSH_SESSION_ID/DSH_WEB_URL/AWB_*/TEAM_* 都是漏点）。
  for (const [key, value] of Object.entries(process.env)) {
    if (/^(TEAM_|AWB_|DSH_SESSION|DSH_PROFILE|DSH_WEB_URL)/i.test(key)) continue;
    env[key] = value;
  }
  env.DSH_HOME = meta.env.DSH_HOME;
  env.DSH_PROFILE = 'sandbox';
  env.DSH_PROFILE_DIR = path.join(meta.env.DSH_HOME, 'profiles', 'sandbox');
  env.TEAM_ROOT = meta.env.TEAM_ROOT;
  env.TEAM_PROJECTS_ROOT = meta.env.TEAM_PROJECTS_ROOT;
  env.TEAM_WORKBENCH_JSON = meta.env.TEAM_WORKBENCH_JSON;
  env.AWB_DATA_DIR = meta.env.AWB_DATA_DIR;
  env.AWB_STORE = meta.env.TEAM_WORKBENCH_JSON;
  env.SANDBOX_ROOT = meta.root;
  env.SANDBOX_PROJECT = meta.project;
  env.SANDBOX_MARKER = SANDBOX_MARKER;
  env.SANDBOX_MESSAGE_MARKER = MESSAGE_MARKER;
  if (!noSelftest) env.TEAM_SELFTEST = '1';
  if (noWake) env.TEAM_NO_WAKE = '1';
  return env;
}

function assertEnvInsideSandbox(env, root) {
  const keys = ['DSH_HOME', 'TEAM_ROOT', 'TEAM_PROJECTS_ROOT', 'TEAM_WORKBENCH_JSON', 'AWB_DATA_DIR', 'DSH_PROFILE_DIR'];
  const bad = keys.filter((key) => !String(env[key] || '').toLowerCase().startsWith(root.toLowerCase()));
  if (bad.length) fail('PATH_OUTSIDE', `隔离变量必须指向沙盘：${bad.map((k) => `${k}=${env[k] || '(空)'}`).join(' ')}`, { bad });
  if (String(env.DSH_WEB_URL || '').trim()) fail('PATH_OUTSIDE', `沙盘不得继承 DSH_WEB_URL（会打到真实实例）：${env.DSH_WEB_URL}`);
  if (String(env.DSH_SESSION_ID || '').trim()) fail('PATH_OUTSIDE', `沙盘不得继承 DSH_SESSION_ID（会绑到真实会话）：${env.DSH_SESSION_ID}`);
}

/* ───────────────────────── seed ───────────────────────── */

function copyIfExists(src, dst) {
  if (!exists(src)) return false;
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  return true;
}

function seed(args) {
  if (!args.root) fail('USAGE', 'seed 需要 --root .sandbox/<id>');
  const root = assertInsideSandbox(args.root);
  const projectName = args.project || DEFAULT_PROJECT;
  const realTeamJson = path.join(REAL_TEAM, '状态', '团队.json');
  if (!exists(realTeamJson)) fail('SOURCE_MISSING', `团队名册不存在：${realTeamJson}`);
  const startedAt = Date.now();

  fs.rmSync(root, { recursive: true, force: true });
  fs.mkdirSync(root, { recursive: true });

  const srcProjectState = path.join(REAL_TEAM, '状态', '项目', projectName);
  if (!exists(srcProjectState)) fail('SOURCE_MISSING', `项目状态目录不存在：${srcProjectState}`);
  const srcProjectJson = path.join(srcProjectState, '项目.json');
  if (!exists(srcProjectJson)) fail('SOURCE_MISSING', `项目登记不存在：${srcProjectJson}`);

  const dstTeam = path.join(root, '团队');
  const dstState = path.join(dstTeam, '状态');
  const dstProjectState = path.join(dstState, '项目', projectName);
  const dstProjectDir = path.join(root, '项目', projectName);
  fs.mkdirSync(dstProjectState, { recursive: true });
  fs.mkdirSync(dstProjectDir, { recursive: true });

  if (args.full) {
    // 兼容旧行为：整目录复制（含历史邮箱/备份），仅排查问题时用。
    fs.cpSync(REAL_TEAM, dstTeam, { recursive: true, force: true });
  } else {
    // 团队宪法：boot 必读（缺了 MISSING_DOC），且是规则哈希的一部分。
    copyIfExists(path.join(REAL_TEAM, '团队宪法.md'), path.join(dstTeam, '团队宪法.md'));
    copyIfExists(path.join(REAL_TEAM, '流程.md'), path.join(dstTeam, '流程.md'));
    // 最小快照三件 + 运行必需（项目登记/评审代管/决策箱）。
    copyIfExists(realTeamJson, path.join(dstState, '团队.json'));
    copyIfExists(path.join(srcProjectState, '项目.json'), path.join(dstProjectState, '项目.json'));
    for (const file of ['工作流.json', '评审代管.json', '决策箱.json']) {
      copyIfExists(path.join(srcProjectState, file), path.join(dstProjectState, file));
    }
    const tasksSrc = path.join(srcProjectState, '任务');
    const tasksDst = path.join(dstProjectState, '任务');
    fs.mkdirSync(tasksDst, { recursive: true });
    let taskCopied = 0;
    for (const entry of listDir(tasksSrc)) {
      if (!entry.isFile() || !/\.json$/i.test(entry.name)) continue;
      fs.copyFileSync(path.join(tasksSrc, entry.name), path.join(tasksDst, entry.name));
      taskCopied += 1;
    }
    // 空运行目录（团队级）
    for (const dir of ['启动', '锁', '授权']) fs.mkdirSync(path.join(dstState, dir), { recursive: true });
    // 空运行目录（项目级）
    for (const dir of ['需求评审', '会话轮换', '会话归档', '提交', '备份']) {
      fs.mkdirSync(path.join(dstProjectState, dir), { recursive: true });
    }
  }

  // 项目最小文档（两种模式都要；boot 必读，只读快照，不含产出/证据大目录）
  for (const file of ['项目铁律.md', '项目信息.md', '项目索引.md', '协作准则.md', 'README.md']) {
    copyIfExists(path.join(REAL_PROJECT_ROOT, projectName, file), path.join(dstProjectDir, file));
  }
  for (const entry of listDir(path.join(REAL_PROJECT_ROOT, projectName, '需求'))) {
    if (!entry.isFile() || !/\.md$/i.test(entry.name)) continue;
    copyIfExists(path.join(REAL_PROJECT_ROOT, projectName, '需求', entry.name), path.join(dstProjectDir, '需求', entry.name));
  }
  for (const dirName of Object.values(ROLE_DIRS)) {
    fs.mkdirSync(path.join(dstProjectDir, dirName, '产出'), { recursive: true });
    for (const file of ['角色卡.md', '文件索引.md']) {
      copyIfExists(path.join(REAL_PROJECT_ROOT, projectName, dirName, file), path.join(dstProjectDir, dirName, file));
    }
  }
  fs.mkdirSync(path.join(dstProjectDir, 'site'), { recursive: true });
  for (const dir of ['启动', '锁', '授权']) fs.mkdirSync(path.join(dstState, dir), { recursive: true });

  // 1) 名册：清 sessionId / activeProject（B-3c03 第二道保险：否则 send 会按名册找到真实会话）
  const teamJson = path.join(dstState, '团队.json');
  if (!exists(teamJson)) fail('SOURCE_MISSING', `沙盘名册复制失败：${teamJson}`);
  const roster = readJson(teamJson, {}) || {};
  roster.members = (Array.isArray(roster.members) ? roster.members : []).map((member) => ({ ...member, sessionId: '' }));
  // activeProject 指回沙盘项目：rotate 只有“活跃项目”才写 团队.json 名册（session.mjs applyMaps），
  // 指回后四处映射（团队.json / 团队会话.json / workbench sessions / sessionIds）全在沙盘内，断言才完整；
  // 真实隔离靠「sessionId 全清空」，名册里没有会话就唤不到任何真人（B-3c03 教训）。
  roster.activeProject = projectName;
  writeJsonAtomic(teamJson, roster);
  const dirty = (roster.members || []).filter((member) => String(member.sessionId || '').trim());
  if (dirty.length) fail('DIRTY_ROSTER', `沙盘名册仍有 sessionId：${dirty.map((m) => m.role).join(',')}`);

  // 2) 项目登记：path 指向沙盘快照（否则 rotate 会把 团队会话.json 写进真实项目目录——实测泄漏）
  const projectJson = path.join(dstProjectState, '项目.json');
  if (exists(projectJson)) {
    const project = readJson(projectJson, {}) || {};
    project.originalPath = project.path || '';
    project.path = dstProjectDir;
    delete project.dshWorkspaceId;
    writeJsonAtomic(projectJson, project);
  }
  // 沙盘 workbench.json（rotate 的“第三/四处映射”写这里；TEAM_WORKBENCH_JSON 指向它）
  const wbFile = path.join(root, 'data', 'userdata', 'workbench.json');
  if (exists(REAL_WORKBENCH)) {
    const real = readJson(REAL_WORKBENCH, {}) || {};
    const project = (real.projects || []).find((p) => p.name === projectName) || {};
    writeJsonAtomic(wbFile, {
      version: real.version || 1,
      activeProjectId: '',
      projects: [{
        name: projectName,
        path: dstProjectDir,
        sessions: Object.fromEntries(Object.keys(project.sessions || {}).map((role) => [role, ''])),
        workspace: { sessionIds: [] },
      }],
      ui: {},
    });
  } else {
    writeJsonAtomic(wbFile, { version: 1, activeProjectId: '', projects: [], ui: {} });
  }
  // 邮箱/启动/锁目录
  const mailbox = path.join(dstState, '邮箱');
  for (const member of roster.members) {
    for (const box of ['new', 'cur']) fs.mkdirSync(path.join(mailbox, member.role, box), { recursive: true });
  }
  for (const dir of ['启动', '锁', '授权', '项目']) fs.mkdirSync(path.join(dstState, dir), { recursive: true });
  fs.mkdirSync(path.join(root, 'dsh'), { recursive: true });

  // 3) 基线：真实文件哈希 + git 代码工作树 + 最小快照
  const tracked = realTrackedFiles({ project: projectName });
  const baseline = snapshotReal(tracked);
  const codeBaseline = gitSnapshot(ROOT);
  const meta = {
    schema: 2,
    id: path.basename(root),
    createdAt: new Date().toISOString(),
    root,
    project: projectName,
    sourceTeam: REAL_TEAM,
    sourceProjectDir: path.join(REAL_PROJECT_ROOT, projectName),
    snapshot: args.full ? 'full' : 'minimal',
    marker: SANDBOX_MARKER,
    messageMarker: MESSAGE_MARKER,
    env: {
      DSH_HOME: path.join(root, 'dsh'),
      TEAM_ROOT: dstTeam,
      TEAM_PROJECTS_ROOT: dstProjectState,
      TEAM_WORKBENCH_JSON: wbFile,
      AWB_DATA_DIR: path.join(root, 'data'),
      TEAM_SELFTEST: '1',
    },
    counts: { tasks: listDir(path.join(dstProjectState, '任务')).filter((e) => e.isFile()).length },
    baseline,
    codeBaseline,
    runs: [],
  };
  const snap = snapshotCheck(root, meta);
  if (!snap.ok) {
    writeJsonAtomic(path.join(root, 'sandbox.json'), meta);
    fail('SNAPSHOT_INCOMPLETE', '最小快照不齐（团队.json / 工作流.json / 任务/*.json）', { snapshot: snap });
  }
  writeJsonAtomic(path.join(root, 'sandbox.json'), meta);
  emit({
    ok: true,
    code: 'SANDBOX_SEEDED',
    root: rel(root),
    project: projectName,
    snapshot: { mode: meta.snapshot, tasks: meta.counts.tasks, items: snap.items },
    sessionIdsCleared: true,
    tracked: baseline.length,
    codeBaseline: { head: codeBaseline.headShort, dirty: codeBaseline.status.length },
    durationMs: Date.now() - startedAt,
  });
}

/* ───────────────────────── 用例 ───────────────────────── */

function loadCaseRegistry() {
  const file = path.join(CASES_DIR, 'index.json');
  const doc = readJson(file, null);
  if (!doc || !Array.isArray(doc.cases)) fail('USAGE', `用例登记表缺失或损坏：${file}`);
  return doc;
}

function resolveCase(name) {
  const registry = loadCaseRegistry();
  const row = registry.cases.find((c) => c.name === name);
  if (!row) fail('USAGE', `未登记的用例：${name}（可用：${registry.cases.map((c) => c.name).join(', ')}）`);
  const file = path.join(CASES_DIR, row.file);
  if (!exists(file)) fail('SOURCE_MISSING', `用例文件不存在：${file}`);
  return { ...row, path: file };
}

/* ───────────────────────── run ───────────────────────── */

function updateMeta(root, mutate) {
  const file = path.join(root, 'sandbox.json');
  const meta = readJson(file, null);
  if (!meta) fail('USAGE', `沙盘未 seed：${file}`);
  mutate(meta);
  writeJsonAtomic(file, meta);
  return meta;
}

function run(args) {
  if (!args.root) fail('USAGE', 'run 需要 --root .sandbox/<id>');
  const root = assertInsideSandbox(args.root);
  const meta = readJson(path.join(root, 'sandbox.json'), null);
  if (!meta) fail('USAGE', `沙盘未 seed：${path.join(root, 'sandbox.json')}`);

  let caseRow = null;
  let command = [];
  let label = '';
  if (args.case) {
    caseRow = resolveCase(args.case);
    command = [process.execPath, caseRow.path];
    label = caseRow.name;
  } else if (args.command.length) {
    command = args.command;
    label = command.slice(0, 3).join(' ');
  } else {
    fail('USAGE', 'run 需要 --case <用例名> 或 -- <命令...>');
  }

  // AC5：漏设 TEAM_SELFTEST 时，拒绝跑“会改状态/发消息”的用例（会真发消息的用例必须双保险）。
  const needsSelftest = caseRow ? caseRow.needsSelftest !== false : true;
  if (needsSelftest && args.noSelftest) {
    emit({ ok: false, code: 'SANDBOX_SELFTEST_MISSING', case: label, hint: '会改状态/发消息的用例必须 TEAM_SELFTEST=1（去掉 --no-selftest）；只读命令可加 --no-selftest' });
    process.exit(EXIT.SELFTEST_MISSING);
  }

  const env = sandboxEnv(meta, { noSelftest: args.noSelftest, noWake: args.noWake });
  assertEnvInsideSandbox(env, root);

  const cwd = args.inWorktree ? path.join(root, 'code') : ROOT;
  if (args.inWorktree && !exists(cwd)) fail('USAGE', `worktree 不存在：${cwd}（先跑 worktree --root ${rel(root)}）`);

  const gitBefore = gitSnapshot(ROOT);
  const startedAt = Date.now();
  const child = spawnSync(command[0], command.slice(1), { cwd, env, encoding: 'utf8', timeout: args.timeout, windowsHide: true, maxBuffer: 32 * 1024 * 1024 });
  const durationMs = Date.now() - startedAt;
  process.stdout.write(String(child.stdout || ''));
  process.stderr.write(String(child.stderr || ''));
  const gitAfter = gitSnapshot(ROOT);

  // AC7：代码工作树必须干净且 HEAD 不变（沙盘隔离的是数据，代码仍是同一工作树）
  const codeDiff = diffStatus(gitBefore.status, gitAfter.status);
  const headChanged = gitBefore.head !== gitAfter.head;
  const split = splitCodeDiff(codeDiff);
  const codeDirty = headChanged || split.owned.length > 0;

  const result = (() => {
    const text = String(child.stdout || '').trim();
    const lastLine = text.split(/\r?\n/).pop() || '';
    for (const candidate of [lastLine, text]) {
      try { return JSON.parse(candidate); } catch { /* 继续 */ }
    }
    return null;
  })();

  const record = {
    runId: `R-${Date.now().toString(36)}-${crypto.randomBytes(2).toString('hex')}`,
    case: label,
    category: caseRow ? caseRow.category : '',
    at: new Date().toISOString(),
    durationMs,
    exitCode: child.status === null ? 1 : child.status,
    ok: (child.status === 0) && !codeDirty,
    codeDirty,
    git: { before: gitBefore.headShort, after: gitAfter.headShort, added: codeDiff.added, removed: codeDiff.removed, sandboxOwned: split.owned, external: split.external },
    result,
    stdoutTail: String(child.stdout || '').trim().split(/\r?\n/).slice(-40).join('\n'),
    stderrTail: String(child.stderr || '').trim().split(/\r?\n/).slice(-20).join('\n'),
  };
  updateMeta(root, (doc) => { doc.runs = (doc.runs || []).concat([record]); });

  /**
   * 稳定结果（AC2 可重复的对外契约）：只保留「用例名 + 每项断言是否通过」。
   * 两次跑的路径/时间戳/pid/计数都会变（例如邮箱里累计的探针条数），不能进这个对象；
   * 测试的复测脚本按 `result` 深度相等判「同一输入同一输出」。
   */
  const stableResult = {
    ok: record.ok,
    case: label,
    category: record.category,
    checks: (result && Array.isArray(result.checks) ? result.checks : []).map((row) => ({ name: String(row.name || ''), ok: Boolean(row.ok) })),
  };

  if (codeDirty) {
    emit({ ok: false, code: 'SANDBOX_CODE_DIRTY', runId: record.runId, case: label, git: record.git, hint: '沙盘里禁止直接改工作树源码；验代码改动请用 worktree --root <id> 后 run --in-worktree' });
    process.exit(EXIT.CODE_DIRTY);
  }
  emit({ ok: record.ok, code: record.ok ? 'SANDBOX_RUN_OK' : 'SANDBOX_CASE_FAILED', runId: record.runId, case: label, exitCode: record.exitCode, durationMs, git: { head: gitAfter.headShort, statusClean: gitAfter.status.length === 0, sandboxOwned: split.owned, external: split.external }, result: stableResult });
  process.exit(record.ok ? 0 : 1);
}

/* ───────────────────────── verify ───────────────────────── */

function verify(args) {
  if (!args.root) fail('USAGE', 'verify 需要 --root .sandbox/<id>');
  const root = assertInsideSandbox(args.root);
  const meta = readJson(path.join(root, 'sandbox.json'), null);
  if (!meta) fail('USAGE', `沙盘未 seed：${path.join(root, 'sandbox.json')}`);

  const now = snapshotReal((meta.baseline || []).map((row) => row.file));
  const drift = [];
  for (let i = 0; i < now.length; i += 1) {
    const before = (meta.baseline || [])[i];
    const after = now[i];
    if (!before || !after) continue;
    if (before.sha256 !== after.sha256 || Number(before.mtimeMs) !== Number(after.mtimeMs)) {
      drift.push({
        file: rel(after.file),
        before: { sha256: String(before.sha256).slice(0, 12), mtimeMs: before.mtimeMs },
        after: { sha256: String(after.sha256).slice(0, 12), mtimeMs: after.mtimeMs },
      });
    }
  }
  const leaks = leakScan(meta);
  const gitNow = gitSnapshot(ROOT);
  const base = meta.codeBaseline || { head: '', status: [] };
  const codeDiff = diffStatus(base.status || [], gitNow.status);
  const split = splitCodeDiff(codeDiff);
  const headChanged = base.head !== gitNow.head;
  // 硬判：HEAD 变了 / 出现沙盘自有路径（.sandbox|_tmp|data|项目|团队状态）被改动。
  // 软判：其它 src/scripts/docs 改动可能是别的角色在并行编辑共享工作树（external），
  //        默认只报告；--assert-code（AC7 用）或 --strict 时判 FAIL。
  const codeDirty = headChanged || split.owned.length > 0 || ((args.assertCode || args.strict) && split.external.length > 0);
  const externalDirty = split.external.length > 0;
  const snap = snapshotCheck(root, meta);

  const payload = {
    ok: true,
    code: 'SANDBOX_OK',
    checked: now.length,
    marker: SANDBOX_MARKER,
    leaks,
    drift,
    driftNote: '真实工作台/团队实例运行时会周期性写 workbench.json、团队.json，mtime/sha 漂移默认只报告（噪声）；泄漏以沙盘标记为准，--strict 时漂移也判 FAIL。',
    git: {
      head: gitNow.headShort,
      baselineHead: String(base.head || '').slice(0, 7),
      added: codeDiff.added,
      removed: codeDiff.removed,
      sandboxOwned: split.owned,
      external: split.external,
      clean: gitNow.status.length === 0,
      externalNote: '共享工作树里 src/scripts/docs 的改动可能来自其它角色（本项目多角色并行），默认只报告；--strict 时才判 SANDBOX_CODE_DIRTY。',
    },
    snapshot: snap,
  };

  if (leaks.length) { payload.ok = false; payload.code = 'SANDBOX_LEAK'; emit(payload); process.exit(EXIT.LEAK); }
  if (args.strict && drift.length) { payload.ok = false; payload.code = 'SANDBOX_LEAK'; payload.strict = true; emit(payload); process.exit(EXIT.LEAK); }
  if (codeDirty) { payload.ok = false; payload.code = 'SANDBOX_CODE_DIRTY'; if (args.assertCode || args.strict) payload.strict = true; emit(payload); process.exit(EXIT.CODE_DIRTY); }
  if (!snap.ok) { payload.ok = false; payload.code = 'SANDBOX_SNAPSHOT_INCOMPLETE'; emit(payload); process.exit(EXIT.SNAPSHOT_INCOMPLETE); }
  emit(payload);
}

/* ───────────────────────── worktree（AC7） ───────────────────────── */

function worktree(args) {
  if (!args.root) fail('USAGE', 'worktree 需要 --root .sandbox/<id>');
  const root = assertInsideSandbox(args.root);
  const meta = readJson(path.join(root, 'sandbox.json'), null);
  if (!meta) fail('USAGE', `沙盘未 seed：${path.join(root, 'sandbox.json')}`);
  const codeDir = path.join(root, 'code');
  if (exists(codeDir)) {
    const info = gitSnapshot(codeDir);
    emit({ ok: true, code: 'SANDBOX_WORKTREE_EXISTS', worktree: rel(codeDir), head: info.headShort });
    return;
  }
  const base = gitSnapshot(ROOT);
  if (!base.isRepo) fail('USAGE', '当前工作树不是 git 仓库，无法建 worktree');
  const r = spawnSync('git', ['worktree', 'add', '--detach', codeDir, base.head], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  if (r.status !== 0) fail('USAGE', `git worktree add 失败：${String(r.stderr || '').trim()}`, { stderr: String(r.stderr || '') });
  updateMeta(root, (doc) => { doc.codeWorktree = codeDir; });
  emit({ ok: true, code: 'SANDBOX_WORKTREE_READY', worktree: rel(codeDir), head: base.headShort });
}

/* ───────────────────────── snapshot ───────────────────────── */

function snapshotCmd(args) {
  if (!args.root) fail('USAGE', 'snapshot 需要 --root .sandbox/<id>');
  const root = assertInsideSandbox(args.root);
  const meta = readJson(path.join(root, 'sandbox.json'), null);
  if (!meta) fail('USAGE', `沙盘未 seed：${path.join(root, 'sandbox.json')}`);
  const snap = snapshotCheck(root, meta);
  emit({ ok: snap.ok, code: snap.ok ? 'SANDBOX_SNAPSHOT_OK' : 'SANDBOX_SNAPSHOT_INCOMPLETE', root: rel(root), items: snap.items });
  if (!snap.ok) process.exit(EXIT.SNAPSHOT_INCOMPLETE);
}

/* ───────────────────────── clean（AC8 保留策略） ───────────────────────── */

function listSandboxes() {
  return listDir(SANDBOX_BASE).filter((e) => e.isDirectory()).map((e) => {
    const root = path.join(SANDBOX_BASE, e.name);
    const meta = readJson(path.join(root, 'sandbox.json'), null);
    const runs = (meta && Array.isArray(meta.runs)) ? meta.runs : [];
    const failed = runs.some((run) => !run.ok) || Boolean(meta && meta.failed);
    const last = runs.length ? runs[runs.length - 1] : null;
    const mtime = (() => { try { return fs.statSync(root).mtimeMs; } catch { return 0; } })();
    return {
      id: e.name,
      root,
      createdAt: meta ? String(meta.createdAt || '') : '',
      runs: runs.length,
      failed,
      ok: Boolean(last && last.ok) && !failed,
      lastRunAt: last ? String(last.at || '') : '',
      mtimeMs: mtime,
      hasMeta: Boolean(meta),
    };
  }).sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)) || a.mtimeMs - b.mtimeMs);
}

function clean(args) {
  if (args.root) {
    const root = assertInsideSandbox(args.root);
    if (root === path.resolve(SANDBOX_BASE)) fail('USAGE', '拒绝删除 .sandbox 根目录本身');
    if (!exists(root)) { emit({ ok: true, code: 'SANDBOX_ALREADY_GONE', root: rel(root) }); return; }
    fs.rmSync(root, { recursive: true, force: true });
    emit({ ok: true, code: 'SANDBOX_CLEANED', root: rel(root) });
    return;
  }
  const rows = listSandboxes();
  if (args.all) {
    if (!args.yes) {
      emit({ ok: false, code: 'SANDBOX_CLEAN_NEEDS_CONFIRM', wouldDelete: rows.map((row) => row.id), hint: '清全部需显式 --all --yes' });
      process.exit(EXIT.CLEAN_NEEDS_CONFIRM);
    }
    if (args.dryRun) { emit({ ok: true, code: 'SANDBOX_CLEAN_PLAN', mode: 'all', wouldDelete: rows.map((row) => row.id) }); return; }
    for (const row of rows) fs.rmSync(row.root, { recursive: true, force: true });
    emit({ ok: true, code: 'SANDBOX_CLEANED_ALL', deleted: rows.map((row) => row.id) });
    return;
  }
  // 保留策略：失败无条件保留；成功按创建时间保留最近 N 次，其余删除。
  const successes = rows.filter((row) => !row.failed);
  const failures = rows.filter((row) => row.failed);
  const keepCount = Math.max(0, args.keep);
  const keep = successes.slice(Math.max(0, successes.length - keepCount));
  const drop = successes.slice(0, Math.max(0, successes.length - keepCount));
  const kept = rows.filter((row) => failures.includes(row) || keep.includes(row));
  if (args.dryRun) {
    emit({ ok: true, code: 'SANDBOX_CLEAN_PLAN', keep: kept.map((row) => ({ id: row.id, failed: row.failed })), wouldDelete: drop.map((row) => row.id) });
    return;
  }
  for (const row of drop) fs.rmSync(row.root, { recursive: true, force: true });
  const snapshots = kept.map((row) => {
    const meta = readJson(path.join(row.root, 'sandbox.json'), null);
    const snap = meta ? snapshotCheck(row.root, meta) : { ok: false, items: [] };
    return { id: row.id, failed: row.failed, snapshotOk: snap.ok };
  });
  emit({ ok: true, code: 'SANDBOX_CLEANED', keep: snapshots, deleted: drop.map((row) => row.id), policy: `keep-last-${keepCount}-success + keep-all-failed` });
}

/* ───────────────────────── list ───────────────────────── */

function list() {
  emit({ ok: true, code: 'SANDBOX_LIST', root: rel(SANDBOX_BASE), sandboxes: listSandboxes().map((row) => ({ id: row.id, runs: row.runs, failed: row.failed, ok: row.ok, createdAt: row.createdAt })) });
}

/* ───────────────────────── main ───────────────────────── */

const args = parseArgs(process.argv);
switch (args.cmd) {
  case 'seed': seed(args); break;
  case 'run': run(args); break;
  case 'verify': verify(args); break;
  case 'worktree': worktree(args); break;
  case 'snapshot': snapshotCmd(args); break;
  case 'clean': clean(args); break;
  case 'list': list(); break;
  default:
    fail('USAGE', '用法：node scripts\\sandbox\\run.cjs <seed|run|verify|snapshot|worktree|clean|list> --root .sandbox\\<id> [--case 用例 | -- 命令]');
}
