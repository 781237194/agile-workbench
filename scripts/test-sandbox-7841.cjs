#!/usr/bin/env node
'use strict';

/**
 * R-20261115-030035-7841 · 独立测试环境沙盘 · 断言（AC1–AC8）
 *
 * 跑法：node scripts\test-sandbox-7841.cjs
 * 覆盖：
 *   AC1 隔离成立（rotate+发消息破坏性跑 → 真实数据零改动 + 代码工作树 git status/HEAD 不变 + 沙盘确有变更）
 *   AC2 可重复（同一用例两轮独立沙盘结果一致，真实数据仍不变）
 *   AC3 覆盖清单（第四节 6 类各 1 例跑通）
 *   AC4 启动成本（从零到可跑 ≤3 分钟，一键、无需手改配置）
 *   AC5 防漏路径（路径越界/漏 TEAM_SELFTEST/真实根注入均被拒）
 *   AC6 文档可用（docs/测试环境.md 存在且含变量表/禁止事项/B-3c03/清理与最小快照）
 *   AC7 默认禁改代码（改工作树 → SANDBOX_CODE_DIRTY；走 git worktree → 通过且主工作树干净）
 *   AC8 清理保留 + 最小快照（5 次记录 → 保留最近 3 次成功 + 失败保留；三件齐；再启动可读；--all 需确认）
 *
 * 约定：全部沙盘都在 .sandbox/ 下；脚本结束删除自己造的目录，不碰其他人的沙盘。
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CLI = path.join(ROOT, 'scripts', 'sandbox', 'run.cjs');
const PROJECT = '工作台改造修复';
const BASE = path.join(ROOT, '.sandbox');
const OUT_DIR = path.join(ROOT, '项目', PROJECT, '程序员A', '产出', '证据-7841');

let total = 0;
let failed = 0;
const rows = [];
const acRows = {};
const created = [];

function check(name, ok, detail, ac) {
  total += 1;
  if (!ok) failed += 1;
  rows.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail, ac: ac || '' });
  if (ac) {
    acRows[ac] = acRows[ac] || { total: 0, failed: 0, items: [] };
    acRows[ac].total += 1;
    if (!ok) acRows[ac].failed += 1;
    acRows[ac].items.push({ name, ok: Boolean(ok) });
  }
  console.log((ok ? 'PASS ' : 'FAIL ') + (ac ? `[${ac}] ` : '') + name + (detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 240)));
}

/** 从 stdout 里取最后一个完整 JSON 对象（CLI 用缩进块输出；用例用单行 JSON）。 */
function parseLastJson(text) {
  const lines = String(text || '').split(/\r?\n/);
  let best = null;
  for (let i = 0; i < lines.length; i += 1) {
    if (lines[i] !== '{') continue;
    for (let j = i; j < lines.length; j += 1) {
      if (lines[j] !== '}') continue;
      try { best = JSON.parse(lines.slice(i, j + 1).join('\n')); i = j; break; } catch { /* 继续找真正的收尾括号 */ }
    }
  }
  if (best) return best;
  for (const line of lines) {
    if (!line.trim().startsWith('{')) continue;
    try { return JSON.parse(line); } catch { /* next */ }
  }
  return null;
}

function cli(args, extraEnv = {}) {
  const startedAt = Date.now();
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd: ROOT, encoding: 'utf8', windowsHide: true, env: { ...process.env, ...extraEnv }, maxBuffer: 32 * 1024 * 1024 });
  const stdout = String(r.stdout || '');
  const stderr = String(r.stderr || '');
  const json = parseLastJson(stdout);
  let parsed = null;
  for (const line of stdout.split(/\r?\n/)) {
    if (!line.startsWith('{')) continue;
    try { const doc = JSON.parse(line); if (doc && doc.case) parsed = doc; } catch { /* next */ }
  }
  return { status: r.status === null ? 1 : r.status, stdout, stderr, json, caseResult: parsed, durationMs: Date.now() - startedAt };
}

function rmDir(dir) {
  fs.rmSync(dir, { recursive: true, force: true });
}

function seedRoot(name, extraEnv = {}) {
  const dir = path.join(BASE, name);
  created.push(dir);
  rmDir(dir);
  const r = cli(['seed', '--root', dir, '--project', PROJECT], extraEnv);
  return { dir, r };
}

function runCase(dir, caseName, extra = [], extraEnv = {}) {
  created.push(dir);
  return cli(['run', '--root', dir, '--case', caseName, ...extra], extraEnv);
}

function gitStatus() {
  const r = spawnSync('git', ['status', '--porcelain'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  return String(r.stdout || '').replace(/\r\n/g, '\n').split('\n').filter(Boolean);
}
function gitHead() {
  const r = spawnSync('git', ['rev-parse', 'HEAD'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  return String(r.stdout || '').trim();
}

/* ───────────── AC1：隔离成立（rotate + 发消息破坏性跑） ───────────── */
console.log('\n=== AC1 隔离成立：rotate + 发消息的破坏性跑');
const realWorkbench = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const realRoster = path.join(ROOT, '团队', '状态', '团队.json');
const realMailPm = path.join(ROOT, '团队', '状态', '邮箱', 'pm');
const realBefore = {
  workbench: fs.existsSync(realWorkbench) ? fs.statSync(realWorkbench).size : 0,
  rosterHash: fs.existsSync(realRoster) ? require('node:crypto').createHash('sha256').update(fs.readFileSync(realRoster)).digest('hex') : '',
  head: gitHead(),
  status: gitStatus(),
};

const ac1 = seedRoot('t7841-ac1');
check('seed 返回 SANDBOX_SEEDED', ac1.r.status === 0 && ac1.r.json && ac1.r.json.code === 'SANDBOX_SEEDED', ac1.r.json && { durationMs: ac1.r.json.durationMs, tasks: ac1.r.json.snapshot && ac1.r.json.snapshot.tasks }, 'AC1');
check('seed 清空名册 sessionId（sessionIdsCleared=true）', Boolean(ac1.r.json && ac1.r.json.sessionIdsCleared === true), null, 'AC1');
check('最小快照三件齐（团队.json / 工作流.json / 任务）', Boolean(ac1.r.json && ac1.r.json.snapshot && ac1.r.json.snapshot.items && ac1.r.json.snapshot.items.every((row) => row.ok)), ac1.r.json && ac1.r.json.snapshot, 'AC1');

const meta1 = JSON.parse(fs.readFileSync(path.join(ac1.dir, 'sandbox.json'), 'utf8'));
check('sandbox.json 记录 6 个隔离变量且都指向沙盘', ['DSH_HOME', 'TEAM_ROOT', 'TEAM_PROJECTS_ROOT', 'TEAM_WORKBENCH_JSON', 'AWB_DATA_DIR'].every((key) => String(meta1.env[key] || '').toLowerCase().startsWith(ac1.dir.toLowerCase())) && meta1.env.TEAM_SELFTEST === '1', meta1.env, 'AC1');
check('sandbox.json 记录 git 代码基线（HEAD + status）', Boolean(meta1.codeBaseline && meta1.codeBaseline.head && Array.isArray(meta1.codeBaseline.status)), { head: meta1.codeBaseline && meta1.codeBaseline.head.slice(0, 7), dirty: (meta1.codeBaseline && meta1.codeBaseline.status || []).length }, 'AC1');

const rot = runCase(ac1.dir, '01-rotate');
check('破坏性用例①rotate 在沙盘跑通', rot.status === 0 && rot.caseResult && rot.caseResult.ok === true, rot.caseResult && { rosterChanged: rot.caseResult.rosterChanged, rotationRecord: rot.caseResult.rotationRecord }, 'AC1');
const msg = runCase(ac1.dir, '03-message');
check('破坏性用例③发消息在沙盘跑通', msg.status === 0 && msg.caseResult && msg.caseResult.ok === true, msg.caseResult && { delivered: msg.caseResult.deliveredToSandboxMailbox }, 'AC1');

const sandboxRoster = JSON.parse(fs.readFileSync(path.join(ac1.dir, '团队', '状态', '团队.json'), 'utf8'));
const sandboxP2 = (sandboxRoster.members || []).find((member) => member.role === 'programmer2');
check('沙盘内确实发生了变更（名册 programmer2 = 沙盘标记会话）', Boolean(sandboxP2 && sandboxP2.sessionId === meta1.marker), { sessionId: sandboxP2 && sandboxP2.sessionId }, 'AC1');

const verify1 = cli(['verify', '--root', ac1.dir]);
check('verify 生产零改动：无探针泄漏（SANDBOX_OK）', verify1.status === 0 && verify1.json && verify1.json.code === 'SANDBOX_OK' && Array.isArray(verify1.json.leaks) && verify1.json.leaks.length === 0, verify1.json && { drift: verify1.json.drift && verify1.json.drift.length, leaks: verify1.json.leaks }, 'AC1');
check('verify 同时确认最小快照三件仍齐', Boolean(verify1.json && verify1.json.snapshot && verify1.json.snapshot.ok), verify1.json && verify1.json.snapshot, 'AC1');
check('verify 报告 git 代码工作树未动（added/removed 都空）', Boolean(verify1.json && verify1.json.git && verify1.json.git.added.length === 0 && verify1.json.git.removed.length === 0), verify1.json && verify1.json.git, 'AC1');

const realAfterStatus = gitStatus();
check('代码工作树 git status 不变（逐行一致）', JSON.stringify(realBefore.status) === JSON.stringify(realAfterStatus), { before: realBefore.status.length, after: realAfterStatus.length }, 'AC1');
check('代码工作树 HEAD 不变', realBefore.head === gitHead(), { before: realBefore.head.slice(0, 7), after: gitHead().slice(0, 7) }, 'AC1');
const wbText = fs.existsSync(realWorkbench) ? fs.readFileSync(realWorkbench, 'utf8') : '';
check('真实 workbench.json 不含沙盘标记（rotate 的映射没漏）', !wbText.includes(meta1.marker), { checked: realWorkbench }, 'AC1');
check('真实 团队.json 不含沙盘标记', !fs.readFileSync(realRoster, 'utf8').includes(meta1.marker), null, 'AC1');
const realPmHits = fs.existsSync(realMailPm) ? fs.readdirSync(realMailPm, { withFileTypes: true }).filter((e) => e.isDirectory()).flatMap((e) => fs.readdirSync(path.join(realMailPm, e.name))).filter((f) => { try { return fs.readFileSync(path.join(realMailPm, 'new', f), 'utf8').includes(meta1.messageMarker); } catch { return false; } }) : [];
check('真实 pm 邮箱不含沙盘消息探针（B-3c03 类事故不复现）', realPmHits.length === 0, { hits: realPmHits.slice(0, 3) }, 'AC1');

/* ───────────── AC2：可重复（两轮独立沙盘结果一致） ───────────── */
console.log('\n=== AC2 可重复：同一用例两轮独立沙盘');
const a1 = seedRoot('t7841-rep-a');
const a1run = runCase(a1.dir, '01-rotate');
const b1 = seedRoot('t7841-rep-b');
const b1run = runCase(b1.dir, '01-rotate');
function stableResult(doc) {
  if (!doc) return null;
  return { ok: doc.ok, case: doc.case, category: doc.category, rosterChanged: doc.rosterChanged, rotationRecord: doc.rotationRecord, workbenchMapped: doc.workbenchMapped };
}
check('两轮 seed 都成功', a1.r.status === 0 && b1.r.status === 0, null, 'AC2');
check('两轮同用例都跑通', a1run.status === 0 && b1run.status === 0, { a: a1run.status, b: b1run.status }, 'AC2');
check('两轮结果一致（同输入同输出）', JSON.stringify(stableResult(a1run.caseResult)) === JSON.stringify(stableResult(b1run.caseResult)), { a: stableResult(a1run.caseResult), b: stableResult(b1run.caseResult) }, 'AC2');
const verifyA = cli(['verify', '--root', a1.dir]);
const verifyB = cli(['verify', '--root', b1.dir]);
check('两轮 verify 都判生产零改动', verifyA.status === 0 && verifyB.status === 0 && verifyA.json.leaks.length === 0 && verifyB.json.leaks.length === 0, null, 'AC2');
check('重复跑之后真实 workbench.json 仍无沙盘标记', !(fs.existsSync(realWorkbench) ? fs.readFileSync(realWorkbench, 'utf8') : '').includes(meta1.marker), null, 'AC2');

/* ───────────── AC3：覆盖清单（六类各 1 例） ───────────── */
console.log('\n=== AC3 覆盖清单：第四节六类各 1 例');
const registry = JSON.parse(fs.readFileSync(path.join(ROOT, 'scripts', 'sandbox', 'cases', 'index.json'), 'utf8'));
const sixCases = registry.cases.filter((row) => /^[①②③④⑤⑥]/.test(row.category));
check('用例登记表覆盖六类', sixCases.length >= 6, { cases: sixCases.map((row) => row.name) }, 'AC3');
const ac3Rows = [];
for (const row of sixCases) {
  const sb = seedRoot(`t7841-ac3-${row.name}`);
  const r = runCase(sb.dir, row.name);
  const v = cli(['verify', '--root', sb.dir]);
  const ok = r.status === 0 && r.caseResult && r.caseResult.ok === true && v.status === 0;
  ac3Rows.push({ case: row.name, category: row.category, ok, exitCode: r.status, verify: v.json && v.json.code });
  check(`第${row.category.slice(0, 1)} 类「${row.category.slice(1)}」用例跑通且隔离成立`, ok, { exitCode: r.status, verify: v.json && v.json.code, failed: (r.caseResult && r.caseResult.checks || []).filter((c) => !c.ok).map((c) => c.name) }, 'AC3');
}

/* ───────────── AC4：启动成本 ≤3 分钟 ───────────── */
console.log('\n=== AC4 启动成本');
const t0 = Date.now();
const ac4 = seedRoot('t7841-ac4');
const ac4run = runCase(ac4.dir, '01-rotate');
const ac4TotalMs = Date.now() - t0;
check('从零到可跑（seed + 一条用例）≤ 180 秒', ac4TotalMs <= 180000 && ac4.r.status === 0 && ac4run.status === 0, { seedMs: ac4.r.json && ac4.r.json.durationMs, runMs: ac4run.durationMs, totalMs: ac4TotalMs }, 'AC4');
check('一键无需手工改配置（seed 自己写 sandbox.json 的隔离变量）', Boolean(ac4.r.json && ac4.r.json.code === 'SANDBOX_SEEDED'), null, 'AC4');

/* ───────────── AC5：防漏路径 ───────────── */
console.log('\n=== AC5 防漏路径');
const outsideSeed = cli(['seed', '--root', path.join(ROOT, '团队', 'sb-outside-probe')]);
check('seed 路径越界被拒（SANDBOX_PATH_OUTSIDE / 退出码 3）', outsideSeed.status === 3 && /SANDBOX_PATH_OUTSIDE/.test(outsideSeed.stderr + outsideSeed.stdout), { status: outsideSeed.status }, 'AC5');
check('越界 seed 没在真实 团队/ 下建出目录', !fs.existsSync(path.join(ROOT, '团队', 'sb-outside-probe')), null, 'AC5');

const noSelftest = runCase(ac4.dir, '01-rotate', ['--no-selftest']);
check('漏设 TEAM_SELFTEST 时拒绝跑会改状态的用例（SANDBOX_SELFTEST_MISSING / 退出码 8）', noSelftest.status === 8 && noSelftest.json && noSelftest.json.code === 'SANDBOX_SELFTEST_MISSING', { status: noSelftest.status, code: noSelftest.json && noSelftest.json.code }, 'AC5');

// 模拟“调用方自己把 TEAM_ROOT 指到真实团队”：篡改 sandbox.json 后再 run，必须被路径守卫拒
const tamperDir = path.join(BASE, 't7841-ac5-tamper');
created.push(tamperDir);
rmDir(tamperDir);
fs.cpSync(ac4.dir, tamperDir, { recursive: true, force: true });
const tamperMeta = JSON.parse(fs.readFileSync(path.join(tamperDir, 'sandbox.json'), 'utf8'));
tamperMeta.env.TEAM_ROOT = path.join(ROOT, '团队');
fs.writeFileSync(path.join(tamperDir, 'sandbox.json'), JSON.stringify(tamperMeta, null, 2) + '\n', 'utf8');
const tampered = runCase(tamperDir, '01-rotate');
check('TEAM_ROOT 被改成真实团队时 run 拒绝（SANDBOX_PATH_OUTSIDE / 退出码 3）', tampered.status === 3 && /SANDBOX_PATH_OUTSIDE/.test(tampered.stderr + tampered.stdout), { status: tampered.status }, 'AC5');

const envProbe = cli(['run', '--root', ac4.dir, '--', process.execPath, '-e', 'console.log(JSON.stringify({session:process.env.DSH_SESSION_ID||"",web:process.env.DSH_WEB_URL||"",team:process.env.TEAM_ROOT,selftest:process.env.TEAM_SELFTEST,wb:process.env.TEAM_WORKBENCH_JSON}))']);
let envDoc = null;
for (const line of String(envProbe.stdout || '').split(/\r?\n/)) {
  if (!line.includes('"selftest"')) continue;
  try { envDoc = JSON.parse(line); } catch { /* next */ }
}
check('子进程不继承真实 DSH_SESSION_ID / DSH_WEB_URL', Boolean(envDoc && envDoc.session === '' && envDoc.web === ''), envDoc, 'AC5');
check('子进程隔离变量全在沙盘内', Boolean(envDoc && envDoc.team && envDoc.team.toLowerCase().startsWith(ac4.dir.toLowerCase()) && envDoc.wb && envDoc.wb.toLowerCase().startsWith(ac4.dir.toLowerCase()) && envDoc.selftest === '1'), envDoc, 'AC5');

/* ───────────── AC6：文档可用 ───────────── */
console.log('\n=== AC6 文档可用');
const docFile = path.join(ROOT, 'docs', '测试环境.md');
const docText = fs.existsSync(docFile) ? fs.readFileSync(docFile, 'utf8') : '';
check('docs/测试环境.md 存在且非空', docText.length > 800, { bytes: docText.length }, 'AC6');
const docMust = ['一条命令', '隔离变量', 'TEAM_WORKBENCH_JSON', 'TEAM_SELFTEST', 'B-3c03', '清理', '最小快照', '禁止', 'SANDBOX_CODE_DIRTY', 'worktree'];
check('文档含一条命令/变量表/禁止事项/B-3c03/清理与最小快照/代码隔离', docMust.every((key) => docText.includes(key)), { missing: docMust.filter((key) => !docText.includes(key)) }, 'AC6');

/* ───────────── AC7：默认禁改代码 ───────────── */
console.log('\n=== AC7 默认禁改代码 + worktree');
const ac7 = seedRoot('t7841-ac7');
const dirtyProbe = path.join(ROOT, 'scripts', '_t7841-code-dirty-probe.cjs');
fs.writeFileSync(dirtyProbe, '// 沙盘断言用：故意弄脏主工作树\n', 'utf8');
const dirtyVerify = cli(['verify', '--root', ac7.dir]);
check('在沙盘里改工作树源码 → SANDBOX_CODE_DIRTY（退出码 7）', dirtyVerify.status === 7 && dirtyVerify.json && dirtyVerify.json.code === 'SANDBOX_CODE_DIRTY', { status: dirtyVerify.status, added: dirtyVerify.json && dirtyVerify.json.git && dirtyVerify.json.git.added }, 'AC7');
rmDir(dirtyProbe);
const cleanVerify = cli(['verify', '--root', ac7.dir]);
check('恢复工作树后 verify 回到 SANDBOX_OK', cleanVerify.status === 0 && cleanVerify.json && cleanVerify.json.code === 'SANDBOX_OK', { status: cleanVerify.status }, 'AC7');

const wt = cli(['worktree', '--root', ac7.dir]);
check('worktree 子命令能检出独立代码副本（AC7 合规路径）', wt.status === 0 && wt.json && wt.json.code === 'SANDBOX_WORKTREE_READY', { status: wt.status, code: wt.json && wt.json.code, head: wt.json && wt.json.head }, 'AC7');
const wtHead = wt.json && wt.json.head;
if (wtHead) {
  const statusBefore = gitStatus();
  const wtFile = path.join(ac7.dir, 'code', 'src', '_t7841-worktree-probe.js');
  fs.mkdirSync(path.dirname(wtFile), { recursive: true });
  fs.writeFileSync(wtFile, '// 在 worktree 里改代码，主工作树必须仍然干净\n', 'utf8');
  const wtRun = cli(['run', '--root', ac7.dir, '--in-worktree', '--', process.execPath, '-e', `console.log(JSON.stringify({ok:true,cwd:process.cwd()}))`]);
  const statusAfter = gitStatus();
  check('在 worktree 里改代码后 run 通过（主工作树不受影响）', wtRun.status === 0 && wtRun.json && wtRun.json.code === 'SANDBOX_RUN_OK', { status: wtRun.status, code: wtRun.json && wtRun.json.code }, 'AC7');
  check('worktree 改动没有污染主工作树（git status 逐行一致）', JSON.stringify(statusBefore) === JSON.stringify(statusAfter), { before: statusBefore.length, after: statusAfter.length }, 'AC7');
  check('主工作树 HEAD 不变', gitHead() === realBefore.head, { head: gitHead().slice(0, 7) }, 'AC7');
}

/* ───────────── AC8：清理保留 + 最小快照 + 再启动 + --all ───────────── */
console.log('\n=== AC8 清理保留 + 最小快照 + 再启动 + --all');
// 用独立基目录（.sandbox 内）跑保留策略，避免 clean 扫到别人/其它用例的沙盘目录
const ac8Base = path.join(BASE, '_t7841-ac8base');
created.push(ac8Base);
rmDir(ac8Base);
fs.mkdirSync(ac8Base, { recursive: true });
const ac8Dirs = [];
for (let i = 1; i <= 5; i += 1) {
  const dir = path.join(ac8Base, `t7841-ac8-${i}`);
  const seeded = cli(['seed', '--root', dir, '--project', PROJECT], { SANDBOX_BASE: ac8Base });
  ac8Dirs.push({ i, dir, seedOk: seeded.status === 0 });
  // 前 4 次成功（跑 07-restart 只读用例），第 5 次故意失败
  const r = cli(['run', '--root', dir, '--case', i === 5 ? '99-fail' : '07-restart'], { SANDBOX_BASE: ac8Base });
  ac8Dirs[ac8Dirs.length - 1].runOk = r.status === 0;
  ac8Dirs[ac8Dirs.length - 1].caseResult = r.caseResult;
}
check('造出 5 次运行记录（4 成功 + 1 失败）', ac8Dirs.every((row) => row.seedOk) && ac8Dirs.filter((row) => row.runOk).length === 4, ac8Dirs.map((row) => ({ i: row.i, runOk: row.runOk })), 'AC8');

const listBefore = cli(['list'], { SANDBOX_BASE: ac8Base });
check('list 能列出 5 个运行目录并标出失败运行', (listBefore.json.sandboxes || []).length === 5 && (listBefore.json.sandboxes || []).some((row) => row.failed), (listBefore.json.sandboxes || []), 'AC8');

const plan = cli(['clean', '--dry-run'], { SANDBOX_BASE: ac8Base });
const planDrop = (plan.json && plan.json.wouldDelete || []);
check('clean --dry-run 先给计划（不删任何东西）', plan.status === 0 && Array.isArray(plan.json.wouldDelete) && planDrop.length === 1 && ac8Dirs.every((row) => fs.existsSync(row.dir)), { wouldDelete: planDrop }, 'AC8');

const cleaned = cli(['clean'], { SANDBOX_BASE: ac8Base });
const kept = (cleaned.json && cleaned.json.keep || []);
const deleted = (cleaned.json && cleaned.json.deleted || []);
check('执行 clean 后只剩最近 3 次成功 + 失败保留（共 4 个目录）', kept.length === 4 && deleted.length === 1, { kept: kept.map((row) => row.id), deleted }, 'AC8');
check('失败运行被无条件保留', kept.some((row) => /t7841-ac8-5/.test(row.id) && row.failed), kept, 'AC8');
check('保留目录的最小快照三件齐（团队.json / 工作流.json / 任务）', kept.every((row) => row.snapshotOk), kept, 'AC8');
check('最近 3 次成功保留的是最新三次（ac8-2/3/4）', ['t7841-ac8-2', 't7841-ac8-3', 't7841-ac8-4'].every((name) => kept.some((row) => row.id === name)), kept.map((row) => row.id), 'AC8');

const keptDir = path.join(ac8Base, 't7841-ac8-4');
const restart = cli(['run', '--root', keptDir, '--case', '07-restart'], { SANDBOX_BASE: ac8Base });
check('用保留目录再启动一次沙盘成功（能读到需求/任务，非空壳）', restart.status === 0 && restart.caseResult && restart.caseResult.ok === true && restart.caseResult.requirements > 0 && restart.caseResult.tasks > 0, restart.caseResult && { requirements: restart.caseResult.requirements, tasks: restart.caseResult.tasks, docs: restart.caseResult.requirementDocs }, 'AC8');

// --all 必须显式确认：用另一个独立基目录，避免误删其它沙盘
const allBase = path.join(BASE, '_t7841-allbase');
created.push(allBase);
rmDir(allBase);
fs.mkdirSync(allBase, { recursive: true });
const all1 = cli(['seed', '--root', path.join(allBase, 'x1')], { SANDBOX_BASE: allBase });
const all2 = cli(['seed', '--root', path.join(allBase, 'x2')], { SANDBOX_BASE: allBase });
check('独立基目录下可建两个沙盘（给 --all 断言用）', all1.status === 0 && all2.status === 0, { a: all1.status, b: all2.status }, 'AC8');
const allNoConfirm = cli(['clean', '--all'], { SANDBOX_BASE: allBase });
check('clean --all 不带 --yes 直接拒（SANDBOX_CLEAN_NEEDS_CONFIRM / 退出码 10）且零删除', allNoConfirm.status === 10 && allNoConfirm.json && allNoConfirm.json.code === 'SANDBOX_CLEAN_NEEDS_CONFIRM' && fs.existsSync(path.join(allBase, 'x1')) && fs.existsSync(path.join(allBase, 'x2')), { status: allNoConfirm.status, code: allNoConfirm.json && allNoConfirm.json.code }, 'AC8');
const allYes = cli(['clean', '--all', '--yes'], { SANDBOX_BASE: allBase });
check('clean --all --yes 才清全部', allYes.status === 0 && allYes.json && allYes.json.code === 'SANDBOX_CLEANED_ALL' && !fs.existsSync(path.join(allBase, 'x1')), { status: allYes.status, deleted: allYes.json && allYes.json.deleted }, 'AC8');

/* ───────────── 收尾 ───────────── */
for (const dir of created) rmDir(dir);
// worktree 注册表清理（否则 git 会记住已删除的 worktree 路径）
spawnSync('git', ['worktree', 'prune'], { cwd: ROOT, encoding: 'utf8', windowsHide: true });

const acSummary = Object.fromEntries(Object.entries(acRows).map(([ac, row]) => [ac, { total: row.total, failed: row.failed, ok: row.failed === 0 }]));
const payload = {
  requirement: 'R-20261115-030035-7841',
  at: new Date().toISOString(),
  cmd: 'node scripts\\test-sandbox-7841.cjs',
  cwd: ROOT,
  total,
  failed,
  ok: failed === 0,
  ac: acSummary,
  timing: { seedMs: ac4.r.json && ac4.r.json.durationMs, ac4TotalMs },
  ac3: ac3Rows,
  git: { head: gitHead(), statusLines: gitStatus().length },
  results: rows,
};
fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'result-v115.json'), JSON.stringify(payload, null, 2) + '\n', 'utf8');

console.log('\n=== 汇总');
for (const [ac, row] of Object.entries(acSummary)) console.log(`${row.ok ? 'PASS' : 'FAIL'} ${ac}：${row.total} 项，失败 ${row.failed}`);
console.log(`\n合计 ${total} 项，失败 ${failed} 项；AC4 实测 ${ac4TotalMs}ms；证据：项目/${PROJECT}/程序员A/产出/证据-7841/result-v115.json`);
if (!failed) console.log('SANDBOX_7841_OK');
process.exit(failed ? 1 : 0);
