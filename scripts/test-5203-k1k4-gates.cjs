#!/usr/bin/env node
'use strict';
/**
 * test-5203-k1k4-gates.cjs —— P0 修单 K1+K4（T-20261119-165257-5203，Owner 已采纳）夹具
 *
 * 三处被今天实际绊过的闸门问题：
 *   K1① G4 soft/hard 语义统一：gateDesign 只表达「有没有证据」（无证据 soft:true / 有证据缺签字 soft:false），
 *        是否阻断由 项目.json.gates 决定（auto 只审计、hard 才拒、off 跳过）。
 *   K1② G3 豁免：`type=task` 的编写/设计类任务，在需求仍处评审阶段（review/approved）不被 Owner 落账门自锁。
 *   K1③ G8：编写类任务（已完成未结单）不算「子任务证据」，不因此把 ready 需求判成跳步。
 *   K4 设计类任务不被 G4 自锁（isAuthoringTask → 派单闸门不硬拦）。
 *
 * 纯函数级断言（不写任何状态），另加两条真实 CLI 断面：
 *   - `task create --type task --title 编写…` 后 `task claim` 不被 G3 拦（沙盘）
 *   - 净树 selftest 由收尾命令单独跑（本夹具不含）
 *
 * 用法：node scripts/test-5203-k1k4-gates.cjs [--json]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const GATES = path.join(ROOT, '团队', '工具', 'lib', 'gates.mjs');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const JSON_OUT = process.argv.includes('--json');
const PROJECT = 'k1k4沙盘';

const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
  return Boolean(ok);
}
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'k1k4-'));
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench-k1k4.json');
const DATA = path.join(SB, 'data');
const STATE = path.join(TEAM, '状态', '项目', PROJECT);

function env() {
  const { DSH_SESSION_ID, ...base } = process.env;
  return { ...base, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_WORKBENCH_JSON: STORE, AWB_DATA_DIR: DATA, AWB_STORE: STORE, TEAM_SELFTEST: '1' };
}
function run(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: env(), timeout: 180000, cwd: SB, maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status == null ? 1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function runJson(args) {
  const r = run(args);
  const t = String(r.out || '').trim();
  const i = t.indexOf('{');
  let json = null;
  if (i >= 0) { try { json = JSON.parse(t.slice(i)); } catch { json = null; } }
  return { ...r, json };
}
const text = (r) => `${r.out || ''}${r.err || ''}`;
const tokenOf = (r) => String((r.json && r.json.token) || '');

async function main() {
  let exitCode = 0;
  try {
    if (!fs.existsSync(GATES)) { console.error('环境错误：找不到 gates.mjs'); process.exit(2); }
    const g = await import(`file://${GATES.replace(/\\/g, '/')}`);

    /* ── K1① G4 soft/hard 语义统一 ───────────────────────────── */
    const emptyProj = path.join(SB, 'proj-empty');
    fs.mkdirSync(path.join(emptyProj, '产品', '产出'), { recursive: true });
    fs.mkdirSync(path.join(emptyProj, '需求分析师', '产出'), { recursive: true });
    const g4none = g.gateDesign({ projectPath: emptyProj, mode: 'full', task: null });
    check('K1①a 无设计产物：gateDesign 返回 soft:true（是否阻断交给 gates 配置）',
      Boolean(g4none) && g4none.soft === true && String(g4none.gate) === 'G4', { g4: g4none });
    // 有产物但无签字 → soft:false（硬缺陷，与配置无关）
    fs.writeFileSync(path.join(emptyProj, '产品', '产出', '02-产品设计-v1.md'), '# 设计\n\n结论：待签字\n', 'utf8');
    const g4sig = g.gateDesign({ projectPath: emptyProj, mode: 'full', task: null });
    check('K1①b 有产物缺签字：gateDesign 返回 soft:false（硬缺陷，不受 gates 配置影响）',
      Boolean(g4sig) && g4sig.soft === false && String(g4sig.code) === 'PRODUCT_DESIGN_REQUIRED' && /签字/.test(String(g4sig.missing)),
      { g4: g4sig });
    // fast 模式：先造需求分析产物，才会走到「有证据缺 tech approve」这条硬返回
    fs.writeFileSync(path.join(emptyProj, '需求分析师', '产出', '需求分析-v1.md'), '# 需求分析\n\n结论：可测\n', 'utf8');
    const g4fast = g.gateDesign({ projectPath: emptyProj, mode: 'fast', task: null });
    check('K1①c fast 模式缺技术评审 approve：soft:false + TECH_REVIEW_REQUIRED',
      Boolean(g4fast) && g4fast.soft === false && String(g4fast.code) === 'TECH_REVIEW_REQUIRED', { g4: g4fast });
    const cfg = g.gateConfig({ gates: {} });
    check('K1①d 默认配置 productDesign=hard（无配置时硬门）', String(cfg.productDesign) === 'hard', { cfg });

    /* ── K1② G3 对编写/设计类任务的豁免 ──────────────────────── */
    const authoringTask = { id: 'T-auth', type: 'task', title: '编写需求正文 v5', detail: '按产品评审意见修订正文', requirementId: 'R-1' };
    const devTask = { id: 'T-dev', type: 'task', title: '实现台账列表', detail: '改 ops.mjs', requirementId: 'R-1' };
    check('K1②a isAuthoringTask：编写类 → true，实现类 → false',
      g.isAuthoringTask(authoringTask) === true && g.isAuthoringTask(devTask) === false,
      { auth: g.isAuthoringTask(authoringTask), dev: g.isAuthoringTask(devTask) });
    check('K1②b isRequirementReviewStage：review/approved → true，ready/dev → false',
      g.isRequirementReviewStage('review') && g.isRequirementReviewStage('approved')
      && !g.isRequirementReviewStage('ready') && !g.isRequirementReviewStage('dev'), {});
    const gateReview = g.taskGateOf({ task: authoringTask, row: { id: 'R-1', status: 'review' } });
    check('K1②c 编写类任务 + 需求 review 阶段 → G3 放行（null）', gateReview === null, { gate: gateReview });
    const gateApproved = g.taskGateOf({ task: authoringTask, row: { id: 'R-1', status: 'approved' } });
    check('K1②d 编写类任务 + 需求 approved 阶段 → G3 放行', gateApproved === null, { gate: gateApproved });
    const gateReady = g.taskGateOf({ task: authoringTask, row: { id: 'R-1', status: 'ready' } });
    check('K1②e 编写类任务但需求已 ready → 不豁免（仍按 Owner 落账判）',
      Boolean(gateReady) && String(gateReady.gateCode) === 'TASK_GATE_NOT_APPROVED', { gate: gateReady });
    const gateDev = g.taskGateOf({ task: devTask, row: { id: 'R-1', status: 'review' } });
    check('K1②f 非编写类任务（实现）→ 不豁免',
      Boolean(gateDev) && String(gateDev.gateCode) === 'TASK_GATE_NOT_APPROVED', { gate: gateDev });
    const gateNoRow = g.taskGateOf({ task: authoringTask, row: null });
    check('K1②g 需求行缺失（脏数据）→ 仍拒 TASK_GATE_REQUIREMENT_MISSING（不放行）',
      Boolean(gateNoRow) && String(gateNoRow.code) === 'TASK_GATE_REQUIREMENT_MISSING', { gate: gateNoRow });

    /* ── K1③ G8：编写类任务不算子任务证据 ───────────────────── */
    const readyRow = { id: 'R-1', status: 'ready' };
    const authoringKid = { id: 'T-doc', type: 'task', title: '编写需求正文', requirementId: 'R-1', status: 'working', owner: 'analyst' };
    const devKid = { id: 'T-impl', type: 'task', title: '实现功能', requirementId: 'R-1', status: 'working', owner: 'programmer1' };
    check('K1③a 需求 ready + 只有编写类未结单子任务 → 不判跳步（null）',
      g.detectPhaseJump({ row: readyRow, tasks: [authoringKid] }) === null,
      { jump: g.detectPhaseJump({ row: readyRow, tasks: [authoringKid] }) });
    check('K1③b 需求 ready + 开发子任务未开工 → **仍判跳步**（保护不被放宽）',
      Boolean(g.detectPhaseJump({ row: { id: 'R-1', status: 'test_done' }, tasks: [devKid] })), {});
    check('K1③c 需求 accepted（合法终态）→ 不判跳步',
      g.detectPhaseJump({ row: { id: 'R-1', status: 'accepted' }, tasks: [devKid] }) === null, {});

    /* ── K4 设计类任务不被 G4 自锁（派单闸门条件） ───────────── */
    check('K4a 设计类任务命中 isAuthoringTask（产品设计/技术方案/规范/说明书）',
      g.isAuthoringTask({ type: 'task', title: '产品设计-v3' })
      && g.isAuthoringTask({ type: 'task', title: '写技术方案' })
      && g.isAuthoringTask({ type: 'task', detail: '输出规范文档' })
      && g.isAuthoringTask({ type: 'task', title: '编写说明书' }), {});
    check('K4b 非 task 类型（bug/requirement）不误判为编写类',
      !g.isAuthoringTask({ type: 'bug', title: '编写逻辑有 bug' })
      && !g.isAuthoringTask({ type: 'requirement', title: '编写需求正文' }), {});

    /* ── 真实 CLI 断面：编写类任务 claim 不被 G3 拦 ──────────── */
    check('S0 沙盘 init', run(['init']).code === 0, {});
    check('S1 沙盘建项目', run(['project', 'add', '--name', PROJECT, '--team-mode', 'full']).code === 0, {});
    const ALL = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
    const team = readJson(path.join(TEAM, '状态', '团队.json'), { members: [] });
    team.activeProject = PROJECT;
    team.members = Array.isArray(team.members) ? team.members : [];
    for (const role of ALL) {
      let m = team.members.find((x) => x && x.role === role);
      if (!m) { m = { role, name: role, status: 'active' }; team.members.push(m); }
      m.status = 'active'; m.sessionId = `session-k1k4-${role}`;
    }
    writeJson(path.join(TEAM, '状态', '团队.json'), team);
    const projMeta = readJson(path.join(STATE, '项目.json'), {});
    const projDir = String(projMeta.path || path.join(PROJECTS, PROJECT));
    writeJson(path.join(projDir, '团队会话.json'), { project: PROJECT, teamMode: 'full', workspace: projDir, roles: ALL.map((role) => ({ role, sessionId: `session-k1k4-${role}` })) });
    writeJson(STORE, { projects: [{ id: 'k1k4-p1', name: PROJECT, teamName: PROJECT, path: projDir, sessions: Object.fromEntries(ALL.map((r) => [r, `session-k1k4-${r}`])), workspace: { path: projDir, sessionIds: ALL.map((r) => `session-k1k4-${r}`) } }], activeProjectId: 'k1k4-p1' });
    const pmTok = tokenOf(runJson(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'session-k1k4-pm', '--json']));
    const anaTok = tokenOf(runJson(['boot', '--role', 'analyst', '--project', PROJECT, '--session', 'session-k1k4-analyst', '--json']));
    check('S2 沙盘 pm/analyst boot 成功', Boolean(pmTok && anaTok), {});
    // 造需求（req create）+ 编写类任务挂需求号 + 需求处 review 阶段
    const reqCreate = runJson(['req', 'create', '--boot', pmTok, '--title', 'K1K4 夹具需求', '--priority', 'P1', '--acceptance', 'x', '--json']);
    const reqId = String((((reqCreate.json || {}).requirement) || ((reqCreate.json || {}).task) || {}).id || '');
    check('S3 沙盘建需求', Boolean(reqId), { out: text(reqCreate).slice(0, 260) });
    const authoring = runJson(['task', 'create', '--boot', pmTok, '--title', '编写需求正文 v1', '--priority', 'P1', '--type', 'task', '--requirement', reqId, '--json']);
    const authId = String(((authoring.json || {}).task || {}).id || '');
    check('S4 编写类任务挂需求号创建成功', Boolean(authId), { out: text(authoring).slice(0, 260) });
    const claim = runJson(['task', 'claim', '--boot', anaTok, '--id', authId, '--json']);
    check('S5 编写类任务 claim 不被 G3 拦（需求未落账也应放行）',
      claim.code === 0 && !/TASK_GATE_NOT_APPROVED|OWNER_REVIEW_REQUIRED/.test(text(claim)),
      { code: claim.code, out: text(claim).slice(0, 400) });
  } catch (e) {
    check('夹具未抛异常', false, { error: String((e && e.stack) || e) });
  } finally {
    fs.rmSync(SB, { recursive: true, force: true });
    const failed = ROWS.filter((r) => r.ok !== true);
    if (!JSON_OUT) {
      console.log(`\n${ROWS.length - failed.length}/${ROWS.length} PASS${failed.length ? ` · ${failed.length} FAIL` : ''}`);
      if (failed.length) console.log('失败项：' + failed.map((r) => r.name).join(' | '));
    } else {
      console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed.length, failed: failed.map((r) => r.name), rows: ROWS }, null, 2));
    }
    if (failed.length) exitCode = 1;
  }
}
main();
void ROOT;
