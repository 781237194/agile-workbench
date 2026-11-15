#!/usr/bin/env node
'use strict';

/**
 * R-4657 缺陷验收自动化 · 断言脚本（T-20261115-104736-3abe）
 *
 * 约束：
 *   - 纯 Node + 沙盘夹具；执行路径只碰 证据-3abe/sandbox/**；
 *   - 真实项目只跑 --plan（dry-run）与 --run 拒绝，前后 sha256/mtime 全等；
 *   - 覆盖 AC1–AC9：计划零写入、七组互斥、12 键审计、撤回窗口两侧、开关、池标签、IPC/静态锚点。
 *
 * 用法：node scripts/test-auto-accept-4657.cjs
 * 退出码：0 全部通过；1 有失败。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const EVIDENCE_DIR = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-3abe');
const SANDBOX = path.join(EVIDENCE_DIR, 'sandbox');
const PROJECT_NAME = '沙盘-4657';
const TEAM_ROOT = path.join(SANDBOX, '团队');
const PROJECT_ROOT = path.join(SANDBOX, '项目', PROJECT_NAME);
const STATE_DIR = path.join(TEAM_ROOT, '状态', '项目', PROJECT_NAME);
const TASK_DIR = path.join(STATE_DIR, '任务');
const STORE_FILE = path.join(SANDBOX, 'workbench.json');
const AUDIT_FILE = path.join(STATE_DIR, '自动验收.jsonl');
const CLI = path.join(ROOT, 'scripts', 'auto-accept.cjs');

const REAL_TEAM_ROOT = path.join(ROOT, '团队');
const REAL_STATE_DIR = path.join(REAL_TEAM_ROOT, '状态', '项目', '工作台改造修复');
const REAL_TASKS = path.join(REAL_STATE_DIR, '任务');
const REAL_WORKFLOW = path.join(REAL_STATE_DIR, '工作流.json');
const REAL_TEAM = path.join(REAL_TEAM_ROOT, '状态', '团队.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const REAL_AUDIT = path.join(REAL_STATE_DIR, '自动验收.jsonl');

const T = {
  NO_EVIDENCE: 'B-20261115-000001-0001',
  REPORT_MISSING: 'B-20261115-000002-0002',
  REPORT_NO_PASS: 'B-20261115-000003-0003',
  REPORT_HAS_FAIL: 'B-20261115-000004-0004',
  SCREENSHOT_MISSING: 'B-20261115-000005-0005',
  BAD_IMAGE: 'B-20261115-000006-0006',
  OK1: 'B-20261115-000007-0007',
  OK2: 'B-20261115-000008-0008',
  ALREADY: 'B-20261115-000009-0009',
  DIR_OK: 'B-20261115-000010-000a',
  NOT_DONE: 'B-20261115-000011-000b',
  NON_BUG: 'T-20261115-000012-000c'
};
const DONE_BUG_IDS = [
  T.NO_EVIDENCE, T.REPORT_MISSING, T.REPORT_NO_PASS, T.REPORT_HAS_FAIL,
  T.SCREENSHOT_MISSING, T.BAD_IMAGE, T.OK1, T.OK2, T.ALREADY, T.DIR_OK
];
const RETRACT_REASONS = ['retracted', 'retract_window_expired', 'retract_not_found', 'retract_noop'];
const SKIP_REASONS = [
  'no_evidence', 'report_missing', 'report_no_pass', 'report_has_fail',
  'screenshot_missing', 'bad_image', 'already_closed', 'evidence_empty',
  'read_failed', 'switch_off', 'state_changed', 'duplicate'
];

const results = [];
const logLines = [];
let evidenceText = '';
const auto = require(CLI);

function log(line) {
  const text = String(line);
  logLines.push(text);
  evidenceText += text + '\n';
  process.stdout.write(text + '\n');
}

function record(id, name, ok, detail) {
  results.push({
    id,
    name,
    ok: Boolean(ok),
    detail: detail === undefined ? '' : String(detail).slice(0, 800)
  });
  if (!ok) log(`FAIL  ${id} ${name}${detail === undefined ? '' : ' · ' + String(detail).slice(0, 300)}`);
}

function check(id, name, ok, detail) {
  record(id, name, ok, detail);
  return Boolean(ok);
}

function rmrf(target) {
  const resolved = path.resolve(target);
  if (!resolved.startsWith(path.resolve(EVIDENCE_DIR) + path.sep)) {
    throw new Error(`拒绝删除证据目录以外的路径：${resolved}`);
  }
  fs.rmSync(resolved, { recursive: true, force: true });
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function writeText(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function sha256(buffer) {
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

function sha256File(file) {
  return fs.existsSync(file) ? sha256(fs.readFileSync(file)) : null;
}

function taskSnapshots() {
  const out = {};
  let names = [];
  try { names = fs.readdirSync(TASK_DIR); } catch { return out; }
  for (const name of names) {
    if (!name.endsWith('.json') || /\.(bak|tmp)/i.test(name)) continue;
    const file = path.join(TASK_DIR, name);
    out[name] = {
      sha: sha256File(file),
      mtimeMs: fs.statSync(file).mtimeMs,
      json: JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''))
    };
  }
  return out;
}

function treeSha() {
  const snap = taskSnapshots();
  const aggregate = sha256(Buffer.from(Object.keys(snap).sort().map((name) => `${name}:${snap[name].sha}`).join('\n'), 'utf8'));
  return { aggregate, count: Object.keys(snap).length };
}

function readTasks() {
  const out = {};
  for (const name of fs.readdirSync(TASK_DIR)) {
    if (!name.endsWith('.json') || /\.(bak|tmp)/i.test(name)) continue;
    const json = JSON.parse(fs.readFileSync(path.join(TASK_DIR, name), 'utf8').replace(/^\uFEFF/, ''));
    if (json && json.id) out[json.id] = { file: path.join(TASK_DIR, name), json, sha: sha256File(path.join(TASK_DIR, name)) };
  }
  return out;
}

function auditRows() {
  if (!fs.existsSync(AUDIT_FILE)) return [];
  return fs.readFileSync(AUDIT_FILE, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => {
    try { return JSON.parse(line); } catch { return { __bad: line }; }
  });
}

function childEnv(sandbox, extra) {
  const env = { ...process.env };
  delete env.TEAM_ROOT;
  delete env.TEAM_PROJECTS_ROOT;
  delete env.AWB_STORE;
  delete env.AWB_DATA_DIR;
  delete env.TEAM_SELFTEST;
  delete env.AWB_AUTO_ACCEPT_RETRACT_HOURS;
  if (sandbox) {
    env.TEAM_ROOT = TEAM_ROOT;
    env.TEAM_PROJECTS_ROOT = SANDBOX;
    env.AWB_STORE = STORE_FILE;
    env.TEAM_SELFTEST = '1';
  }
  return { ...env, ...(extra || {}) };
}

function runCli(args, options = {}) {
  const sandbox = options.sandbox !== false;
  const argv = [CLI, ...args];
  if (!argv.includes('--json')) argv.push('--json');
  const result = spawnSync(process.execPath, argv, {
    cwd: ROOT,
    env: childEnv(sandbox, options.env),
    encoding: 'utf8',
    timeout: 120000,
    windowsHide: true
  });
  const lines = String(result.stdout || '').trim().split(/\r?\n/).filter(Boolean);
  let json = null;
  try { json = JSON.parse(lines[lines.length - 1] || 'null'); } catch { json = null; }
  return {
    command: `node scripts/auto-accept.cjs ${args.join(' ')}`,
    status: result.status,
    stdout: String(result.stdout || ''),
    stderr: String(result.stderr || ''),
    json,
    sandbox
  };
}

function seedStore(options = {}) {
  const projectAuto = Object.prototype.hasOwnProperty.call(options, 'projectAuto') ? options.projectAuto : null;
  const globalAuto = Object.prototype.hasOwnProperty.call(options, 'globalAuto') ? options.globalAuto : true;
  writeJson(STORE_FILE, {
    version: 1,
    activeProjectId: 'P-4657-sandbox',
    projects: [{
      id: 'P-4657-sandbox',
      name: PROJECT_NAME,
      teamName: PROJECT_NAME,
      path: PROJECT_ROOT,
      autoAcceptBugs: projectAuto
    }],
    ui: { autoAcceptBugs: globalAuto }
  });
}

function taskBase(id, evidenceFiles, extra = {}) {
  return {
    id,
    project: PROJECT_NAME,
    type: 'bug',
    requirementId: '',
    title: `沙盘夹具 ${id}`,
    detail: 'R-4657 断言夹具',
    acceptance: '',
    story: '',
    priority: 'P2',
    priorityBy: 'pm',
    priorityReason: '',
    owner: 'programmer1',
    status: 'done',
    createdBy: 'tester',
    createdAt: '2026-11-15T00:00:00.000Z',
    claimedAt: '2026-11-15T00:00:00.000Z',
    due: '',
    doneAt: '2026-11-15T00:10:00.000Z',
    evidence: '',
    rev: 1,
    history: [],
    evidenceFiles,
    ...extra
  };
}

function ev(relPath, kind = 'file') {
  return { path: relPath, scope: 'project', kind, size: 0, mtime: '2026-11-15T00:00:00.000Z', sha256: '' };
}

function seedSandbox() {
  rmrf(SANDBOX);
  fs.mkdirSync(TASK_DIR, { recursive: true });
  writeJson(path.join(STATE_DIR, '项目.json'), {
    name: PROJECT_NAME,
    path: PROJECT_ROOT,
    teamMode: 'full',
    createdAt: '2026-11-15T00:00:00.000Z'
  });
  seedStore();

  const png = Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==',
    'base64'
  );
  const reportPass = '# 测试报告\n\n2026-11-15\n\n结论：PASS\n';
  const reportNoPass = '# 测试报告\n\n2026-11-15\n\n结论：待补\n';
  const reportFail = '# 测试报告\n\n2026-11-15\n\n结论：PASS\n\n备注：FAIL\n';
  writeText(path.join(PROJECT_ROOT, '证据', 'report-pass.md'), reportPass);
  writeText(path.join(PROJECT_ROOT, '证据', 'report-no-pass.md'), reportNoPass);
  writeText(path.join(PROJECT_ROOT, '证据', 'report-fail.md'), reportFail);
  writeText(path.join(PROJECT_ROOT, '证据', 'notes.log'), '运行日志，没有结论\n');
  fs.writeFileSync(path.join(PROJECT_ROOT, '证据', 'shot.png'), png);
  fs.writeFileSync(path.join(PROJECT_ROOT, '证据', 'fake.png'), Buffer.from('this is not a png\n', 'utf8'));
  writeText(path.join(PROJECT_ROOT, '证据', 'bundle', 'report.md'), reportPass);
  fs.writeFileSync(path.join(PROJECT_ROOT, '证据', 'bundle', 'shot.png'), png);
  writeText(path.join(PROJECT_ROOT, '证据', 'bundle', 'notes.txt'), '目录里的随手记录（没有 PASS）\n');

  const tasks = [
    taskBase(T.NO_EVIDENCE, []),
    taskBase(T.REPORT_MISSING, [ev('证据/shot.png')]),
    taskBase(T.REPORT_NO_PASS, [ev('证据/report-no-pass.md'), ev('证据/shot.png')]),
    taskBase(T.REPORT_HAS_FAIL, [ev('证据/report-fail.md'), ev('证据/shot.png')]),
    taskBase(T.SCREENSHOT_MISSING, [ev('证据/report-pass.md'), ev('证据/notes.log')]),
    taskBase(T.BAD_IMAGE, [ev('证据/report-pass.md'), ev('证据/fake.png')]),
    taskBase(T.OK1, [ev('证据/report-pass.md'), ev('证据/shot.png')]),
    taskBase(T.OK2, [ev('证据/report-pass.md'), ev('证据/shot.png')]),
    taskBase(T.ALREADY, [ev('证据/report-pass.md'), ev('证据/shot.png')], {
      acceptanceRecord: {
        status: 'accepted',
        by: 'owner',
        channel: 'ui',
        at: '2026-11-15T00:20:00.000Z',
        evidence: [{ path: '证据/report-pass.md', sha256: 'x'.repeat(64), kind: 'report' }],
        testReport: '证据/report-pass.md'
      }
    }),
    taskBase(T.DIR_OK, [ev('证据/bundle', 'dir')]),
    taskBase(T.NOT_DONE, [ev('证据/report-pass.md'), ev('证据/shot.png')], { status: 'working', doneAt: null }),
    {
      id: T.NON_BUG,
      project: PROJECT_NAME,
      type: 'task',
      title: '普通开发任务（不进缺陷池）',
      status: 'done',
      owner: 'programmer1',
      createdAt: '2026-11-15T00:00:00.000Z',
      doneAt: '2026-11-15T00:10:00.000Z',
      evidenceFiles: [ev('证据/report-pass.md'), ev('证据/shot.png')],
      rev: 1,
      history: []
    }
  ];
  for (const task of tasks) writeJson(path.join(TASK_DIR, task.id + '.json'), task);
}

function auditKeysOk(row) {
  return row && typeof row === 'object' && JSON.stringify(Object.keys(row)) === JSON.stringify([
    'at', 'project', 'taskId', 'type', 'rule', 'result', 'reason',
    'evidence', 'testReport', 'partialMissing', 'batch', 'operator'
  ]);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 1. --plan：只算不写 + 七组互斥 + 计数等式
 * ══════════════════════════════════════════════════════════════════════════ */
function testPlan() {
  const before = taskSnapshots();
  const beforeTree = treeSha();
  const plan = runCli(['--project', PROJECT_NAME, '--plan', '--once']);
  const after = taskSnapshots();
  const afterTree = treeSha();
  const json = plan.json || {};
  const unchanged = Object.keys(before).every((name) => after[name] && after[name].sha === before[name].sha)
    && Object.keys(after).every((name) => before[name] && before[name].sha === after[name].sha);

  log(`plan: exit=${plan.status} total=${json.total} groups=${JSON.stringify(json.groups)}`);
  check('AC6-01', '--plan 退出码 0、mode=plan、ok=true', plan.status === 0 && json.ok === true && json.mode === 'plan', `exit=${plan.status} json=${JSON.stringify(json).slice(0, 200)}`);
  check('AC6-02', '--plan 夹具总数=10（10 条 done bug；working / task 不计入）', json.total === DONE_BUG_IDS.length, `total=${json.total}`);
  check('AC6-03', '七组互斥：每个失败夹具只命中一组', json.groups
    && json.groups.no_evidence === 1
    && json.groups.report_missing === 1
    && json.groups.report_no_pass === 1
    && json.groups.report_has_fail === 1
    && json.groups.screenshot_missing === 1
    && json.groups.bad_image === 1
    && json.groups.accepted === 3, JSON.stringify(json.groups));
  check('AC6-04', '其它组：already_closed=1（手工已验收），其余 0', json.groups
    && json.groups.already_closed === 1
    && ['evidence_empty', 'read_failed', 'switch_off', 'state_changed', 'duplicate'].every((key) => Number(json.groups[key] || 0) === 0), JSON.stringify(json.groups));
  check('AC6-05', '计数等式：七组 + 其它组 = 总数', json.countCheck && json.countCheck.groupsSum === json.total && json.countCheck.ok === true, JSON.stringify(json.countCheck));
  check('AC6-06', 'needEvidence 每条带 {id,reason} 且 reason 在白名单', Array.isArray(json.needEvidence)
    && json.needEvidence.length === 7
    && json.needEvidence.every((row) => row && row.id && SKIP_REASONS.includes(row.reason)), JSON.stringify(json.needEvidence).slice(0, 400));
  const reasonOf = (id) => (json.needEvidence || []).find((row) => row.id === id);
  check('AC6-07', 'reason 取 F-4657-2 首个失败项（六组夹具逐条核对）',
    reasonOf(T.NO_EVIDENCE)?.reason === 'no_evidence'
    && reasonOf(T.REPORT_MISSING)?.reason === 'report_missing'
    && reasonOf(T.REPORT_NO_PASS)?.reason === 'report_no_pass'
    && reasonOf(T.REPORT_HAS_FAIL)?.reason === 'report_has_fail'
    && reasonOf(T.SCREENSHOT_MISSING)?.reason === 'screenshot_missing'
    && reasonOf(T.BAD_IMAGE)?.reason === 'bad_image',
    JSON.stringify([T.NO_EVIDENCE, T.REPORT_MISSING, T.REPORT_NO_PASS, T.REPORT_HAS_FAIL, T.SCREENSHOT_MISSING, T.BAD_IMAGE].map((id) => reasonOf(id))));
  check('AC1-PLAN', 'closeable 只含三条齐全夹具（含目录展开）',
    Array.isArray(json.closeable) && json.closeable.length === 3
    && [T.OK1, T.OK2, T.DIR_OK].every((id) => json.closeable.includes(id)), JSON.stringify(json.closeable));
  check('AC6-08', '--plan 不改任务文件（逐文件 sha 全等）', unchanged, `count=${beforeTree.count}`);
  check('AC6-09', '--plan 不写 自动验收.jsonl', !fs.existsSync(AUDIT_FILE), AUDIT_FILE);
  check('AC4-05', '--plan 不写任务 acceptedAt/acceptanceRecord', after[T.OK1 + '.json'].json.acceptanceRecord === undefined && after[T.OK1 + '.json'].json.acceptedAt === undefined, '');
  check('AC9-LOG', '--plan 的 JSON 只输出一行可解析对象', plan.stdout.trim().split(/\r?\n/).filter(Boolean).length === 1, plan.stdout.slice(0, 120));
}

/* ══════════════════════════════════════════════════════════════════════════
 * 2. --run：收口 + 12 键审计 + 幂等
 * ══════════════════════════════════════════════════════════════════════════ */
function testRun() {
  const before = taskSnapshots();
  const first = runCli(['--project', PROJECT_NAME, '--run', '--once']);
  const json = first.json || {};
  const tasks = readTasks();
  log(`run: exit=${first.status} closed=${json.closed && json.closed.length} wrote=${json.wrote}`);

  check('AC1-01', '--run 退出码 0、closed=3、wrote=3', first.status === 0 && json.ok === true && Array.isArray(json.closed) && json.closed.length === 3 && json.wrote === 3, JSON.stringify({ exit: first.status, closed: json.closed, wrote: json.wrote }));
  const record = tasks[T.OK1] && tasks[T.OK1].json.acceptanceRecord;
  check('AC1-02', 'accepted 记录：status/by/channel/rule 齐',
    record && record.status === 'accepted' && record.by === 'system' && record.channel === 'auto' && record.rule === 'R-4657/v1', JSON.stringify(record).slice(0, 300));
  check('AC1-03', 'accepted 记录：evidence[] 非空且每项 sha256 为 64 位', Array.isArray(record && record.evidence)
    && record.evidence.length >= 1
    && record.evidence.every((row) => row && row.path && /^[0-9a-f]{64}$/.test(String(row.sha256)) && row.kind), JSON.stringify(record && record.evidence).slice(0, 300));
  check('AC1-04', 'accepted 记录：testReport 是 {path,sha256,at} 对象', record && record.testReport
    && record.testReport.path && /^[0-9a-f]{64}$/.test(String(record.testReport.sha256)) && record.testReport.at, JSON.stringify(record && record.testReport));
  check('AC1-05', 'accepted 记录：criteria[] 为判据快照（kind 推断 + partialMissing）', Array.isArray(record && record.criteria)
    && record.criteria.some((row) => row.key === 'kind_inference')
    && record.criteria.some((row) => row.key === 'partial_missing'), JSON.stringify(record && record.criteria && record.criteria.map((row) => row.key)));
  check('AC1-06', '任务行 acceptedAt/acceptedBy 写入，status 未被改写', tasks[T.OK1].json.acceptedAt && tasks[T.OK1].json.acceptedBy === 'system' && tasks[T.OK1].json.status === 'done', JSON.stringify({ acceptedAt: tasks[T.OK1].json.acceptedAt, acceptedBy: tasks[T.OK1].json.acceptedBy, status: tasks[T.OK1].json.status }));
  check('AC1-07', '目录证据被展开后收口（kind=dir 夹具 accepted）', tasks[T.DIR_OK].json.acceptanceRecord && tasks[T.DIR_OK].json.acceptanceRecord.status === 'accepted', JSON.stringify(tasks[T.DIR_OK].json.acceptanceRecord || {}).slice(0, 200));
  check('AC2-01', '缺截图夹具未被收口', !tasks[T.SCREENSHOT_MISSING].json.acceptanceRecord, '');
  check('AC3-01', 'FAIL 夹具未被收口', !tasks[T.REPORT_HAS_FAIL].json.acceptanceRecord, '');
  check('AC4-01', '不可达/缺报告夹具未被收口', !tasks[T.REPORT_MISSING].json.acceptanceRecord && !tasks[T.NO_EVIDENCE].json.acceptanceRecord, '');
  check('AC1-08', '只写任务文件，不写 工作流.json（沙盘 fixture 无 工作流.json 且未被创建）', !fs.existsSync(path.join(STATE_DIR, '工作流.json')), '');

  const rows = auditRows();
  log(`audit: rows=${rows.length}`);
  check('AC9-01', '审计 jsonl 存在且每行固定 12 键', rows.length >= 10 && rows.every(auditKeysOk), `rows=${rows.length}`);
  const acceptedRows = rows.filter((row) => row.result === 'accepted');
  check('AC1-09', '审计 accepted 行 3 条、batch=manual、operator=null、reason=null', acceptedRows.length === 3
    && acceptedRows.every((row) => row.batch === 'manual' && row.operator === null && row.reason === null), JSON.stringify(acceptedRows.map((row) => ({ id: row.taskId, reason: row.reason, batch: row.batch }))));
  check('AC9-02', 'accepted 行：evidence 非空、testReport 非空对象', acceptedRows.every((row) => Array.isArray(row.evidence) && row.evidence.length > 0 && row.testReport && row.testReport.path && row.testReport.sha256 && row.testReport.at), '');
  const skipRows = rows.filter((row) => row.result === 'skip');
  check('AC9-03', 'skip 行：reason 白名单、evidence=[]、testReport=null、operator=null', skipRows.length >= 7
    && skipRows.every((row) => SKIP_REASONS.includes(row.reason) && Array.isArray(row.evidence) && row.evidence.length === 0 && row.testReport === null && row.operator === null), JSON.stringify(skipRows.map((row) => row.reason)));
  check('AC6-10', 'reason 无旧 evidence_ 前缀', rows.every((row) => !String(row.reason || '').startsWith('evidence_')), '');
  check('AC9-04', '审计行 project/taskId/type/rule 固定', rows.every((row) => row.project === PROJECT_NAME && row.taskId && row.type === 'bug' && row.rule === 'R-4657/v1'), '');

  // 幂等：再跑一次只 skip(already_closed)，不重复收口
  const second = runCli(['--project', PROJECT_NAME, '--run', '--once']);
  const secondTasks = readTasks();
  const acceptedAfterSecond = auditRows().filter((row) => row.result === 'accepted').length;
  check('AC7-01', '第二次 --run 不新增 accepted（幂等）', second.status === 0 && second.json && second.json.closed.length === 0 && acceptedAfterSecond === 3, `closed=${second.json && second.json.closed.length}, acceptedRows=${acceptedAfterSecond}`);
  check('AC7-02', '第二次 --run 对已收口任务写 skip(already_closed)', second.json && second.json.skipped.some((row) => row.id === T.OK1 && row.reason === 'already_closed'), JSON.stringify(second.json && second.json.skipped).slice(0, 400));
  check('AC7-03', '幂等不改已收口任务文件', secondTasks[T.OK1].sha === tasks[T.OK1].sha, '');

  // 写后 plan：closeable 归零
  const replay = runCli(['--project', PROJECT_NAME, '--plan', '--once']);
  check('AC5-PLAN', '收口后 --plan closeable=0、accepted=0', replay.json && replay.json.closeable.length === 0 && Number(replay.json.groups.accepted || 0) === 0, JSON.stringify(replay.json && replay.json.groups));

  // 未修改的夹具保持原 sha（AC2/AC3/AC4 的“任务文件未改”）
  check('AC2-02', '缺件/FAIL/不可达夹具在 --run 后仍未被改写', [T.SCREENSHOT_MISSING, T.REPORT_HAS_FAIL, T.REPORT_MISSING, T.NO_EVIDENCE, T.BAD_IMAGE].every((id) => secondTasks[id].sha === before[id + '.json'].sha), '');
  return { first, second };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3. --retract：窗口内/外、重复、环境变量、审计快照
 * ══════════════════════════════════════════════════════════════════════════ */
function testRetract() {
  const tasks = readTasks();
  const ok1At = tasks[T.OK1].json.acceptanceRecord.at;
  const ok2At = tasks[T.OK2].json.acceptanceRecord.at;
  const dirAt = tasks[T.DIR_OK].json.acceptanceRecord.at;
  const insideNow = new Date(Date.parse(ok1At) + 1000).toISOString();
  const outsideNow = new Date(Date.parse(ok2At) + 10000).toISOString();
  const dirNow = new Date(Date.parse(dirAt) + 1000).toISOString();

  const inside = runCli(['--project', PROJECT_NAME, '--retract', T.OK1, '--retract-hours', '0.001', '--now', insideNow, '--reason', '自动验收误判，Owner 撤回']);
  const afterInside = readTasks();
  log(`retract inside: exit=${inside.status} retracted=${inside.json && inside.json.retracted.length}`);
  check('AC7-04', '窗口内撤回（--retract-hours 0.001）成功且退出码 0', inside.status === 0 && inside.json && inside.json.ok === true && inside.json.retracted.length === 1, JSON.stringify(inside.json).slice(0, 300));
  check('AC7-05', '撤回写 retractedAt/retractedBy，acceptanceRecord.status=retracted', afterInside[T.OK1].json.acceptanceRecord.status === 'retracted'
    && afterInside[T.OK1].json.acceptanceRecord.retractedAt && afterInside[T.OK1].json.acceptanceRecord.retractedBy === 'owner', JSON.stringify(afterInside[T.OK1].json.acceptanceRecord));

  const retractRows = auditRows().filter((row) => row.result === 'retract');
  const ok1RetractRow = retractRows.find((row) => row.taskId === T.OK1 && row.reason === 'retracted');
  const ok1AcceptedRow = auditRows().find((row) => row.taskId === T.OK1 && row.result === 'accepted');
  check('AC9-05', 'retract 行 12 键、reason=retracted、operator=owner', auditKeysOk(ok1RetractRow) && ok1RetractRow.reason === 'retracted' && ok1RetractRow.operator === 'owner', JSON.stringify(ok1RetractRow || {}).slice(0, 300));
  check('AC9-06', 'retract 行复制原 accepted 的 evidence/testReport', ok1RetractRow && JSON.stringify(ok1RetractRow.evidence) === JSON.stringify(ok1AcceptedRow && ok1AcceptedRow.evidence) && JSON.stringify(ok1RetractRow.testReport) === JSON.stringify(ok1AcceptedRow && ok1AcceptedRow.testReport), '');

  const repeat = runCli(['--project', PROJECT_NAME, '--retract', T.OK1, '--now', insideNow]);
  check('AC7-06', '重复撤回 → RETRACT_NOOP 且退出码 1', repeat.status === 1 && repeat.json && repeat.json.failed.some((row) => row.id === T.OK1 && row.code === 'RETRACT_NOOP'), JSON.stringify(repeat.json && repeat.json.failed));

  const ok2Before = readTasks()[T.OK2].sha;
  const expired = runCli(['--project', PROJECT_NAME, '--retract', T.OK2, '--retract-hours', '0.001', '--now', outsideNow]);
  const ok2After = readTasks()[T.OK2];
  check('AC7-07', '超窗撤回 → RETRACT_WINDOW_EXPIRED 且零副作用', expired.status === 1
    && expired.json && expired.json.failed.some((row) => row.id === T.OK2 && row.code === 'RETRACT_WINDOW_EXPIRED')
    && ok2After.sha === ok2Before && ok2After.json.acceptanceRecord.status === 'accepted', JSON.stringify(expired.json && expired.json.failed));

  const envRetract = runCli(['--project', PROJECT_NAME, '--retract', T.DIR_OK, '--now', dirNow], {
    env: { AWB_AUTO_ACCEPT_RETRACT_HOURS: '0.001' }
  });
  check('AC7-08', '撤回窗口环境变量 AWB_AUTO_ACCEPT_RETRACT_HOURS 可注入（窗口内成功）', envRetract.status === 0 && envRetract.json && envRetract.json.retracted.some((row) => row.id === T.DIR_OK), JSON.stringify(envRetract.json).slice(0, 300));

  const expiredRows = auditRows().filter((row) => row.reason === 'retract_window_expired');
  check('AC9-07', '超窗撤回也写 retract 审计（reason=retract_window_expired）', expiredRows.length >= 1 && expiredRows.every(auditKeysOk), `rows=${expiredRows.length}`);
}

/* ══════════════════════════════════════════════════════════════════════════
 * 3b. tick 去重：同进程连续两次相同状态不写审计
 * ══════════════════════════════════════════════════════════════════════════ */
function testTickDedupe() {
  const context = auto.resolveProjectContext({ teamRoot: TEAM_ROOT, storeFile: STORE_FILE, projectName: PROJECT_NAME });
  const lastState = new Map();
  const before = auditRows().length;
  const first = auto.run(context, { allowRealProject: true, batch: 'live', lastState, now: new Date() });
  const mid = auditRows().length;
  const second = auto.run(context, { allowRealProject: true, batch: 'live', lastState, now: new Date() });
  const after = auditRows().length;
  log(`tick dedupe: audit rows ${before} -> ${mid} -> ${after}`);
  check('AC7-10', '连续两次 tick 相同状态只写 0 行审计（lastState 去重）', second.closed.length === 0 && after === mid, `before=${before} mid=${mid} after=${after}`);
  check('AC7-11', '第一次 tick 确实写入审计（去重不是不写）', mid > before, `before=${before} mid=${mid}`);
  return { first, second };
}

/* ══════════════════════════════════════════════════════════════════════════
 * 4. 开关（AC8）+ 单元（duplicate / ROLE_NOT_ALLOWED / 复用 acceptEvidenceCheck）
 * ══════════════════════════════════════════════════════════════════════════ */
function testSwitches() {
  // 单元测试：duplicate（60 秒幂等键）与 ROLE_NOT_ALLOWED 在写之前
  const context = auto.resolveProjectContext({ teamRoot: TEAM_ROOT, storeFile: STORE_FILE, projectName: PROJECT_NAME });
  const ok1Entry = {
    task: JSON.parse(fs.readFileSync(path.join(TASK_DIR, T.OK1 + '.json'), 'utf8')),
    file: path.join(TASK_DIR, T.OK1 + '.json')
  };
  // OK1 已被撤回；换成 DIR_OK 也不适合，直接构造一个未收口的合格任务对象做纯函数判据。
  const synthetic = {
    task: taskBase('B-20261115-999999-9999', [ev('证据/report-pass.md'), ev('证据/shot.png')]),
    file: path.join(TASK_DIR, 'B-20261115-999999-9999.json')
  };
  const dup = auto.decideTask(context, synthetic, { seen: new Map([['B-20261115-999999-9999', { atMs: Date.now() }]]) });
  check('AC7-09', '60 秒幂等键命中 → duplicate', dup.reason === 'duplicate', dup.reason);
  const role = auto.retract(context, { taskIds: [T.OK2], operator: 'tester', allowRealProject: true });
  check('AC8-01', '撤回只允许 Owner/PM → ROLE_NOT_ALLOWED', role.ok === false && role.code === 'ROLE_NOT_ALLOWED', JSON.stringify(role).slice(0, 200));

  // 项目级 false 覆盖全局 true
  seedStore({ projectAuto: false, globalAuto: true });
  const before = treeSha();
  const projectOff = runCli(['--project', PROJECT_NAME, '--run', '--once']);
  const after = treeSha();
  check('AC8-02', '项目级 autoAcceptBugs=false 覆盖全局 true → 全部 skip(switch_off)', projectOff.status === 0
    && projectOff.json && projectOff.json.groups.switch_off === DONE_BUG_IDS.length
    && projectOff.json.closed.length === 0, JSON.stringify(projectOff.json && projectOff.json.groups));
  check('AC8-03', '开关关闭零写任务文件', before.aggregate === after.aggregate, `${before.aggregate} vs ${after.aggregate}`);
  const offRows = auditRows().filter((row) => row.reason === 'switch_off');
  check('AC8-04', 'switch_off 审计行 12 键且 operator=null', offRows.length >= DONE_BUG_IDS.length && offRows.slice(-DONE_BUG_IDS.length).every(auditKeysOk), `rows=${offRows.length}`);

  // 全局 false + 项目级 null → 同样关闭
  seedStore({ projectAuto: null, globalAuto: false });
  const globalOff = runCli(['--project', PROJECT_NAME, '--plan', '--once']);
  check('AC8-05', '全局 autoAcceptBugs=false + 项目 null → switch_off', globalOff.json && globalOff.json.groups.switch_off === DONE_BUG_IDS.length, JSON.stringify(globalOff.json && globalOff.json.groups));

  // 默认关：ui.autoAcceptBugs 缺失（undefined）不得当开
  writeJson(STORE_FILE, {
    version: 1,
    activeProjectId: 'P-4657-sandbox',
    projects: [{ id: 'P-4657-sandbox', name: PROJECT_NAME, teamName: PROJECT_NAME, path: PROJECT_ROOT, autoAcceptBugs: null }],
    ui: {}
  });
  const defaultOff = runCli(['--project', PROJECT_NAME, '--plan', '--once']);
  check('AC8-14', 'ui.autoAcceptBugs 缺失 → 默认关（switch_off=总数、accepted=0）',
    defaultOff.json && defaultOff.json.groups.switch_off === DONE_BUG_IDS.length && Number(defaultOff.json.groups.accepted || 0) === 0,
    JSON.stringify(defaultOff.json && defaultOff.json.groups));
  seedStore();
}

/* ══════════════════════════════════════════════════════════════════════════
 * 5. 池 UI（动态 pool-core）+ 源码锚点 + IPC + 复用
 * ══════════════════════════════════════════════════════════════════════════ */
function testPoolAndAnchors() {
  const core = require(path.join(ROOT, 'src', 'renderer', 'pool-core.js'));
  const now = Date.now();
  const acceptedRow = {
    id: 'B-UI-ACCEPTED', type: 'bug', status: 'done', title: '已收口缺陷',
    evidenceFiles: [ev('证据/report-pass.md'), ev('证据/shot.png')],
    acceptanceRecord: { status: 'accepted', at: new Date(now - 1000).toISOString(), evidence: [], testReport: { path: 'x', sha256: 'y', at: 'z' } }
  };
  const pendingRow = { id: 'B-UI-PENDING', type: 'bug', status: 'done', title: '缺截图', evidenceFiles: [ev('证据/report-pass.md')] };
  const pendingEmptyRow = { id: 'B-UI-PENDING-EMPTY', type: 'bug', status: 'done', title: '无证据', evidenceFiles: [] };
  const retractedRow = { id: 'B-UI-RETRACTED', type: 'bug', status: 'done', title: '已撤回', acceptanceRecord: { status: 'retracted', at: new Date(now - 1000).toISOString() } };
  const oldRow = { id: 'B-UI-OLD', type: 'bug', status: 'done', title: '超窗', acceptanceRecord: { status: 'accepted', at: new Date(now - 25 * 3600 * 1000).toISOString() } };
  const requirementRow = { id: 'R-UI-1', type: 'requirement', status: 'approved', title: '需求' };
  const rows = core.preparePoolRows({
    requirements: [requirementRow],
    tasks: [acceptedRow, pendingRow, pendingEmptyRow, retractedRow, oldRow],
    autoAccept: { retractHours: 24 }
  });
  const byId = Object.fromEntries(rows.map((row) => [row.id, row]));
  const markup = {
    accepted: core.poolRowMarkup(byId['B-UI-ACCEPTED']),
    pending: core.poolRowMarkup(byId['B-UI-PENDING']),
    pendingEmpty: core.poolRowMarkup(byId['B-UI-PENDING-EMPTY']),
    retracted: core.poolRowMarkup(byId['B-UI-RETRACTED']),
    old: core.poolRowMarkup(byId['B-UI-OLD']),
    requirement: core.poolRowMarkup(byId['R-UI-1'])
  };

  check('AC5-01', '池行 accepted：data-accept-state=accepted、data-accept-missing=none、文案「已验收」', markup.accepted.includes('data-accept-state="accepted"')
    && markup.accepted.includes('data-accept-missing="none"') && markup.accepted.includes('>已验收<'), markup.accepted.slice(0, 260));
  check('AC5-02', '池行 pending：data-accept-state=pending、data-accept-missing=screenshot、无撤回按钮', markup.pending.includes('data-accept-state="pending"')
    && markup.pending.includes('data-accept-missing="screenshot"') && !markup.pending.includes('data-bug-retract'), markup.pending.slice(0, 260));
  check('AC2-UI', '池行无证据：data-accept-missing=report（取 F-4657-2 首个缺件）', markup.pendingEmpty.includes('data-accept-missing="report"'), markup.pendingEmpty.slice(0, 220));
  check('AC5-03', '池行 retracted：data-accept-state=retracted、文案「已撤回」', markup.retracted.includes('data-accept-state="retracted"')
    && markup.retracted.includes('>已撤回<') && !markup.retracted.includes('data-bug-retract'), markup.retracted.slice(0, 260));
  check('AC5-04', '撤回按钮只在 accepted 且未超窗出现（[data-bug-retract]）', markup.accepted.includes(`data-bug-retract="B-UI-ACCEPTED"`) && !markup.old.includes('data-bug-retract'), markup.old.slice(0, 200));
  check('AC5-05', '需求行不带 data-accept-state（只挂缺陷行）', !markup.requirement.includes('data-accept-state'), '');
  check('AC5-06', 'pool-core 导出 acceptStateOf/acceptMissingOf/retractAllowed', ['acceptStateOf', 'acceptMissingOf', 'retractAllowed'].every((key) => typeof core[key] === 'function'), '');
  const recentAt = new Date(now - 1000).toISOString();
  const windowRow = { id: 'B-UI-WINDOW', type: 'bug', status: 'done', acceptanceRecord: { status: 'accepted', at: recentAt }, retractHours: 0.001 };
  check('AC5-07', 'retractAllowed 窗口计算可覆盖（0.001h 内 true / 外 false）', core.retractAllowed(windowRow, { now, retractHours: 0.001 }) === true
    && core.retractAllowed(windowRow, { now: now + 5000, retractHours: 0.001 }) === false, `${core.retractAllowed(windowRow, { now, retractHours: 0.001 })} / ${core.retractAllowed(windowRow, { now: now + 5000, retractHours: 0.001 })}`);

  const autoSrc = fs.readFileSync(CLI, 'utf8');
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const poolSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'pool-core.js'), 'utf8');
  const runHandler = mainSrc.slice(mainSrc.indexOf("ipcMain.handle('auto:accept-run'"), mainSrc.indexOf("ipcMain.handle('auto:accept-retract'"));

  check('AC8-06', 'IPC 三通道存在：auto:accept-plan / run / retract', ["auto:accept-plan", "auto:accept-run", "auto:accept-retract"].every((channel) => mainSrc.includes(`ipcMain.handle('${channel}'`)), '');
  check('AC8-07', 'auto:accept-run 渲染层必拒（AUTO_REQUIRES_SYSTEM）且不调用执行函数', runHandler.includes('AUTO_REQUIRES_SYSTEM') && !runHandler.includes('autoAccept.run('), runHandler.slice(0, 220));
  check('AC8-08', 'preload 暴露 plan/run/retract 与变更订阅', ['autoAcceptPlan', 'autoAcceptRun', 'autoAcceptRetract', 'onAutoAcceptChanged'].every((key) => preloadSrc.includes(key)), '');
  check('AC1-10', '复用 acceptEvidenceCheck（不自造第二套证据判定）', autoSrc.includes('acceptEvidenceCheck') && autoSrc.includes('evidenceChecker()(context.projectPath'), '');
  check('AC1-11', 'watch 300ms + tick 30000ms 常量与主进程接线', auto.WATCH_DEBOUNCE_MS === 300 && auto.DEFAULT_TICK_MS === 30000
    && mainSrc.includes('WATCH_DEBOUNCE_MS') && mainSrc.includes('DEFAULT_TICK_MS') && mainSrc.includes('AWB_AUTO_ACCEPT_TICK_MS'), '');
  check('AC5-08', 'UI 锚点源码级存在：data-accept-state / data-accept-missing / data-bug-retract / #bug-retract-bar', poolSrc.includes('data-accept-state')
    && poolSrc.includes('data-accept-missing') && poolSrc.includes('data-bug-retract')
    && appSrc.includes('bug-retract-bar') && appSrc.includes('autoAcceptRetract'), '');
  check('AC8-09', '撤回只走 IPC（app.js 调 autoAcceptRetract，不直接写文件）', appSrc.includes('window.workbench.autoAcceptRetract') && !appSrc.includes("ipcRenderer"), '');
  check('AC8-10', '开关键名：ui.autoAcceptBugs + projects[].autoAcceptBugs（null=继承）', autoSrc.includes('ui.autoAcceptBugs')
    && autoSrc.includes("hasOwnProperty.call(entry, 'autoAcceptBugs')") && autoSrc.includes('projectRaw = null'), '');
  check('AC8-11', 'workflow:state 下发 autoAccept 配置（池子拿 retractHours）', mainSrc.includes('autoAccept: autoAcceptUiConfig()')
    && mainSrc.includes('retractHours: autoAccept.resolveRetractHours({})'), '');
  check('AC8-12', '主进程真实项目默认不自动执行（须 AWB_AUTO_ACCEPT_ALLOW_REAL=1）', mainSrc.includes('AWB_AUTO_ACCEPT_ALLOW_REAL')
    && mainSrc.includes('AUTO_ACCEPT_SKIP 真实项目默认不自动执行'), '');
  check('AC8-13', '主进程每轮解析开关（项目级 false 覆盖全局，null 继承）', mainSrc.includes('settings: autoAccept.resolveAutoAcceptSettings(store, project')
    && mainSrc.includes('settings: autoAccept.resolveAutoAcceptSettings(store, project, projectPath, teamName)'), '');
  check('AC9-08', '审计 12 键常量固定（脚本与 CLI 同源）', auto.AUDIT_KEYS.length === 12 && Object.keys(auto.AUDIT_KEYS).join(',') === '0,1,2,3,4,5,6,7,8,9,10,11', auto.AUDIT_KEYS.join(','));
}

/* ══════════════════════════════════════════════════════════════════════════
 * 6. 真实项目：--plan 零写入 + --run 拒绝
 * ══════════════════════════════════════════════════════════════════════════ */
function realTaskNames() {
  return fs.readdirSync(REAL_TASKS).filter((name) => name.endsWith('.json')).sort();
}
function realTaskAggregate() {
  return sha256(Buffer.from(
    realTaskNames().map((name) => `${name}:${sha256File(path.join(REAL_TASKS, name))}`).join('\n'),
    'utf8'
  ));
}

function testRealProject() {
  const statOf = (file) => {
    if (!fs.existsSync(file)) return { exists: false, sha: null, mtimeMs: null, size: 0 };
    const stat = fs.statSync(file);
    return { exists: true, sha: sha256File(file), mtimeMs: stat.mtimeMs, size: stat.size };
  };
  const before = {
    workflow: statOf(REAL_WORKFLOW),
    team: statOf(REAL_TEAM),
    store: statOf(REAL_STORE),
    audit: statOf(REAL_AUDIT),
    taskCount: realTaskNames().length,
    taskDirSha: realTaskAggregate()
  };
  const plan = runCli(['--project', '工作台改造修复', '--plan', '--once'], { sandbox: false });
  const after = {
    workflow: statOf(REAL_WORKFLOW),
    team: statOf(REAL_TEAM),
    store: statOf(REAL_STORE),
    audit: statOf(REAL_AUDIT),
    taskCount: realTaskNames().length,
    taskDirSha: realTaskAggregate()
  };
  const same = (left, right) => left.exists === right.exists && left.sha === right.sha && left.mtimeMs === right.mtimeMs && left.size === right.size;
  const workflowSame = same(before.workflow, after.workflow);
  const teamSame = same(before.team, after.team);
  const storeSame = same(before.store, after.store);
  const auditSame = same(before.audit, after.audit);
  const tasksSame = before.taskDirSha === after.taskDirSha && before.taskCount === after.taskCount;

  const shaReport = [
    'R-4657 真实项目 dry-run sha256 对比（auto-accept --plan --json）',
    `时间：${new Date().toISOString()}`,
    `命令：${plan.command}`,
    `退出码：${plan.status}`,
    `计划：total=${plan.json && plan.json.total} groups=${JSON.stringify(plan.json && plan.json.groups)}`,
    '',
    `[工作流.json] exists=${before.workflow.exists} size=${before.workflow.size} mtimeMs=${before.workflow.mtimeMs}`,
    `  before ${before.workflow.sha}`,
    `  after  ${after.workflow.sha}`,
    `  equal  ${workflowSame}`,
    '',
    `[团队.json] exists=${before.team.exists} size=${before.team.size} mtimeMs=${before.team.mtimeMs}`,
    `  before ${before.team.sha}`,
    `  after  ${after.team.sha}`,
    `  equal  ${teamSame}`,
    '',
    `[workbench.json] exists=${before.store.exists} size=${before.store.size} mtimeMs=${before.store.mtimeMs}`,
    `  before ${before.store.sha}`,
    `  after  ${after.store.sha}`,
    `  equal  ${storeSame}`,
    '',
    `[任务/*.json 聚合] count=${before.taskCount} → ${after.taskCount}`,
    `  before ${before.taskDirSha}`,
    `  after  ${after.taskDirSha}`,
    `  equal  ${tasksSame}`,
    '',
    `[自动验收.jsonl] existsBefore=${before.audit.exists} existsAfter=${after.audit.exists}`,
    `  before ${before.audit.sha}`,
    `  after  ${after.audit.sha}`,
    `  equal  ${auditSame}`,
    '',
    `结论：${workflowSame && teamSame && storeSame && tasksSame && auditSame ? '全等（真实项目零写入）' : '不等（FAIL）'}`,
    '',
    '[外部实例写入说明（不是 --plan/--run 造成；事故升级 M-20261115-111355-0090d5）]',
    '2026-11-15 11:03:00 一个外部启动的真实工作台实例（electron.exe PID 371772，--user-data-dir=data/userdata）',
    '加载本轮 main.js；11:03:08 自动收口 5 条真实 bug（b55c/2ebe/f6ee/1358/b2e5），',
    '并在 11:03:08–11:13:31 持续写真实 自动验收.jsonl（最终 241330B / sha256 2486c5a09dae2bc1d82850079881667916a3566366b343cd5c5d81db6ebe19a0）。',
    `当前自动验收.jsonl：${before.audit.exists ? `${before.audit.size}B / ${before.audit.sha}` : '不存在'}`,
    '本报告 before/after 是同一 --plan 窗口内的快照；若出现跨 11:03 的 sha 差异，归因于该外部实例，不是 auto-accept --plan / --run 命令。'
  ].join('\n') + '\n';
  writeText(path.join(EVIDENCE_DIR, 'real-dryrun-sha.txt'), shaReport);

  log(`real plan: exit=${plan.status} total=${plan.json && plan.json.total} taskFiles=${before.taskCount}`);
  check('AC6-11', '真实项目 --plan 退出码 0 且计数等式成立', plan.status === 0 && plan.json && plan.json.ok === true && plan.json.countCheck && plan.json.countCheck.ok === true, `exit=${plan.status} total=${plan.json && plan.json.total}`);
  check('AC8-15', '真实项目开关缺失 → plan 全部 switch_off、accepted=0（默认关）', plan.json
    && Number(plan.json.groups.switch_off || 0) === Number(plan.json.total)
    && Number(plan.json.groups.accepted || 0) === 0, JSON.stringify(plan.json && plan.json.groups));
  check('AC6-12', '真实 dry-run：工作流.json sha/mtime 全等', workflowSame, `${before.workflow.sha} vs ${after.workflow.sha}`);
  check('AC6-13', '真实 dry-run：团队.json sha/mtime 全等', teamSame, `${before.team.sha} vs ${after.team.sha}`);
  check('AC6-14', '真实 dry-run：workbench.json sha/mtime 全等', storeSame, `${before.store.sha} vs ${after.store.sha}`);
  check('AC6-15', '真实 dry-run：任务/*.json 前后全等', tasksSame, `${before.taskDirSha} vs ${after.taskDirSha}`);
  check('AC6-16', '真实 dry-run：自动验收.jsonl 不存在或前后全等', auditSame, `exists=${after.audit.exists}`);

  // 真实项目 --run 必须拒绝
  const refusal = runCli(['--project', '工作台改造修复', '--run', '--once'], { sandbox: false });
  const afterRefusal = {
    workflow: statOf(REAL_WORKFLOW),
    team: statOf(REAL_TEAM),
    store: statOf(REAL_STORE),
    audit: statOf(REAL_AUDIT),
    taskDirSha: realTaskAggregate(),
    taskCount: realTaskNames().length
  };
  log(`real run refusal: exit=${refusal.status} code=${refusal.json && refusal.json.code}`);
  check('AC6-17', '真实项目 --run 被拒绝（AUTO_ACCEPT_REAL_PROJECT_READ_ONLY）', refusal.status === 1
    && refusal.json && refusal.json.ok === false && refusal.json.code === 'AUTO_ACCEPT_REAL_PROJECT_READ_ONLY', JSON.stringify(refusal.json).slice(0, 260));
  check('AC6-18', '真实项目 --run 零副作用（工作流/团队/workbench/任务 sha 全等）', afterRefusal.workflow.sha === before.workflow.sha
    && afterRefusal.team.sha === before.team.sha
    && afterRefusal.store.sha === before.store.sha
    && afterRefusal.taskDirSha === before.taskDirSha
    && afterRefusal.taskCount === before.taskCount
    && afterRefusal.audit.sha === before.audit.sha, '');
}

/* ══════════════════════════════════════════════════════════════════════════
 * 7. 汇总与证据
 * ══════════════════════════════════════════════════════════════════════════ */
function main() {
  fs.mkdirSync(EVIDENCE_DIR, { recursive: true });
  log('R-4657 自动验收断言开始');
  seedSandbox();
  const planBefore = treeSha();
  testPlan();
  // 重复计划零写入的树哈希（testPlan 内部已断言，这里留证据）
  log(`plan tree sha: ${planBefore.aggregate}`);
  const runResult = testRun();
  testRetract();
  testTickDedupe();
  testSwitches();
  testPoolAndAnchors();
  testRealProject();

  const snapshot = {
    generatedAt: new Date().toISOString(),
    sandbox: SANDBOX,
    taskDir: TASK_DIR,
    auditFile: AUDIT_FILE,
    tasks: Object.fromEntries(Object.entries(readTasks()).map(([id, row]) => [id, {
      status: row.json.status,
      acceptanceStatus: row.json.acceptanceRecord ? row.json.acceptanceRecord.status : null,
      acceptedBy: row.json.acceptedBy || null,
      evidenceFiles: Array.isArray(row.json.evidenceFiles) ? row.json.evidenceFiles.map((file) => `${file.path}#${file.kind}`) : [],
      sha: row.sha
    }])),
    auditRows: auditRows(),
    cli: {
      plan: runCli(['--project', PROJECT_NAME, '--plan', '--once']).json,
      run: runResult.first.json
    }
  };
  writeJson(path.join(EVIDENCE_DIR, 'sandbox-snapshot.json'), snapshot);

  const passed = results.filter((row) => row.ok).length;
  const failed = results.length - passed;
  const summary = {
    script: 'scripts/test-auto-accept-4657.cjs',
    task: 'T-20261115-104736-3abe',
    generatedAt: new Date().toISOString(),
    total: results.length,
    passed,
    failed,
    ok: failed === 0,
    assertions: results,
    artifacts: {
      sandbox: SANDBOX,
      snapshot: path.join(EVIDENCE_DIR, 'sandbox-snapshot.json'),
      realDryRunSha: path.join(EVIDENCE_DIR, 'real-dryrun-sha.txt'),
      auditFile: AUDIT_FILE
    }
  };
  writeJson(path.join(EVIDENCE_DIR, 'auto-accept-result.json'), summary);
  writeText(path.join(EVIDENCE_DIR, 'auto-accept.log'), evidenceText
    + `\n合计 ${passed}/${results.length} 通过，失败 ${failed} 条\n`);
  log(`合计 ${passed}/${results.length} 通过，失败 ${failed} 条`);
  if (failed) {
    for (const row of results.filter((item) => !item.ok)) log(`  FAIL ${row.id} ${row.name} · ${row.detail}`);
    process.exitCode = 1;
  } else {
    log('AUTO_ACCEPT_4657_OK');
    process.exitCode = 0;
  }
}

main();
