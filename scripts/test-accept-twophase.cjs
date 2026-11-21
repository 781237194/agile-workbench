#!/usr/bin/env node
'use strict';
/**
 * test-accept-twophase.cjs —— PM M-20261121-155451 两段式验收（三条不变量）
 * A 第一段：UI 验收只入队并立即返回 pending（不阻塞）
 * B 幂等：同需求+轮次+决定重复提交返回同一 queuedId，不产生第二条
 * C 回放：applyPendingAcceptances 成功后队列 state=applied（重启回放同一入口）
 * D 失败重试：应用失败 ≥3 次写 failed + 审计（不丢任务，不重复验收）
 * E 提示文案：owner-review 对 pending 明确写「后台同步中」
 * F 接线：main.js appReady 预热段调用 applyPendingAcceptances（重启回放）
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const ROOT = path.resolve(__dirname, '..');
const SANDBOX = process.env.AWB_SANDBOX_ROOT || 'D:/awb-sandbox/tmp';
fs.mkdirSync(SANDBOX, { recursive: true });
const SB = fs.mkdtempSync(path.join(SANDBOX, 'twophase-'));
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const PROJECT = '工作台改造修复';
const PROJ = path.join(PROJECTS, PROJECT);
const WF = path.join(TEAM, '状态', '项目', PROJECT, '工作流.json');
const STORE = path.join(SB, 'workbench.json');
fs.mkdirSync(path.dirname(WF), { recursive: true });
fs.mkdirSync(path.join(PROJ, '需求'), { recursive: true });
fs.writeFileSync(WF, JSON.stringify({ round: 2, requirements: {}, boots: {} }, null, 2) + '\n', 'utf8');
fs.writeFileSync(path.join(path.dirname(WF), '项目.json'), JSON.stringify({ name: PROJECT, path: PROJ, teamMode: 'full' }, null, 2), 'utf8');
fs.writeFileSync(STORE, JSON.stringify({ version: 1, projects: [], ui: {} }, null, 2), 'utf8');
Object.assign(process.env, {
  TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_WORKBENCH_JSON: STORE,
  AWB_TEAM_ROOT: TEAM, AWB_DATA_DIR: path.join(SB, 'data'), TEAM_SELFTEST: '1', AWB_NOW_MS: '',
});
const teamTools = require(path.join(ROOT, 'src', 'team-tools.js')).create({ teamRoot: TEAM, projectRoot: PROJECTS });
const ROWS = [];
const JSON_OUT = process.argv.includes('--json');
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 600)}`);
}
(async () => {
  const reqId = 'R-20261121-1701-a514';
  const baseInput = () => ({ projectName: PROJECT, requirementId: reqId, decision: 'accepted', opinion: '沙盘', channel: 'ui', role: 'owner' });

  // A 入队 + 立即返回
  const first = await teamTools.ownerAccept(baseInput());
  const queueDir = path.join(path.dirname(WF), '验收待应用');
  const queuedFiles = fs.existsSync(queueDir) ? fs.readdirSync(queueDir).filter((n) => n.endsWith('.json')) : [];
  const journal = path.join(path.dirname(WF), '验收决定.jsonl');
  const journalText = fs.existsSync(journal) ? fs.readFileSync(journal, 'utf8') : '';
  check('A 第一段：pending=true + 队列文件 + 审计 queued', first.ok === true && first.pending === true && first.code === 'OWNER_ACCEPT_QUEUED' && queuedFiles.length === 1 && /acceptance_queued/.test(journalText), { first, queuedFiles });

  // B 幂等：重复提交合并
  const second = await teamTools.ownerAccept(baseInput());
  const queuedAfter = fs.existsSync(queueDir) ? fs.readdirSync(queueDir).filter((n) => n.endsWith('.json')) : [];
  check('B 幂等：重复提交返回同一 queuedId、队列不增', second.pending === true && String(second.queuedId) === String(first.queuedId) && queuedAfter.length === 1, { second, queuedAfter });

  // C 回放成功 → applied
  const applied = await teamTools.applyPendingAcceptances(PROJECT, PROJ, { retries: 2, applyOverride: async () => ({ ok: true, code: 'OK' }) });
  const queueFile = path.join(queueDir, queuedAfter[0]);
  const queuedRow = JSON.parse(fs.readFileSync(queueFile, 'utf8'));
  const journalAfter = fs.readFileSync(journal, 'utf8');
  check('C 回放：state=applied + 审计 acceptance_applied', applied.ok === true && queuedRow.state === 'applied' && /acceptance_applied/.test(journalAfter), { applied, state: queuedRow.state });

  // D 失败重试：新建一条 pending，应用恒失败 → failed + attempts≥3 + 审计失败
  const third = await teamTools.ownerAccept({ ...baseInput(), requirementId: 'R-20261121-1702-b514' });
  const appliedFail = await teamTools.applyPendingAcceptances(PROJECT, PROJ, { retries: 3, applyOverride: async () => ({ ok: false, code: 'APPLY_BOOM', message: 'boom' }) });
  const failFile = fs.readdirSync(queueDir).map((n) => path.join(queueDir, n)).find((p) => {
    try { return JSON.parse(fs.readFileSync(p, 'utf8')).requirementId === 'R-20261121-1702-b514'; } catch { return false; }
  });
  const failRow = failFile ? JSON.parse(fs.readFileSync(failFile, 'utf8')) : {};
  const journalFail = fs.readFileSync(journal, 'utf8');
  check('D 失败重试：failed + attempts≥3 + 审计 apply_failed', appliedFail.ok === true && failRow.state === 'failed' && Number(failRow.attempts) >= 3 && /acceptance_apply_failed/.test(journalFail), { appliedFail, failRow: { state: failRow.state, attempts: failRow.attempts } });

  // E 提示文案
  const renderer = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'owner-review.js'), 'utf8');
  check('E 提示文案：pending 写「后台同步中」且不写「已完成」', /pendingSync/.test(renderer) && /后台同步中/.test(renderer) && !/验收已完成/.test(renderer), {});

  // F 接线：main.js appReady 回放
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  check('F 接线：main.js 预热段调用 applyPendingAcceptances', /applyPendingAcceptances\(projectNow\.teamName/.test(mainSrc), {});

  // G 队列三态：新队列项 state 必须是 pending（不是旧值 queued）
  const freshQueued = await teamTools.ownerAccept({ ...baseInput(), requirementId: 'R-20261121-1705-e514' });
  const freshRowFile = path.join(queueDir, freshQueued.queuedId + '.json');
  const pendingRow = JSON.parse(fs.readFileSync(freshRowFile, 'utf8'));
  check('G 队列三态：新入队 state=pending', pendingRow.state === 'pending', { state: pendingRow.state });
  await teamTools.applyPendingAcceptances(PROJECT, PROJ, { retries: 1, applyOverride: async () => ({ ok: true, code: 'OK' }) });

  // H failed 点击原地重试：制造 failed 行 → 再点同一需求 → retrying=true、attempts+1、state 回 pending
  {
    const retryReq = 'R-20261121-1703-c514';
    const queued = await teamTools.ownerAccept({ ...baseInput(), requirementId: retryReq });
    await teamTools.applyPendingAcceptances(PROJECT, PROJ, { retries: 1, applyOverride: async () => ({ ok: false, code: 'APPLY_BOOM', message: 'boom' }) });
    const rowFile = fs.readdirSync(queueDir).map((n) => path.join(queueDir, n)).find((p) => {
      try { return JSON.parse(fs.readFileSync(p, 'utf8')).requirementId === retryReq; } catch { return false; }
    });
    const failedRow = rowFile ? JSON.parse(fs.readFileSync(rowFile, 'utf8')) : {};
    const clicked = await teamTools.ownerAccept({ ...baseInput(), requirementId: retryReq });
    const afterRow = rowFile ? JSON.parse(fs.readFileSync(rowFile, 'utf8')) : {};
    const journalText2 = fs.readFileSync(journal, 'utf8');
    check('H failed 点击原地重试：retrying + attempts+1 + state 回 pending + 审计 acceptance_retry',
      failedRow.state === 'failed' && clicked.retrying === true && Number(afterRow.attempts) === Number(failedRow.attempts || 0) + 1 && afterRow.state === 'pending' && /acceptance_retry/.test(journalText2),
      { failedRow: { state: failedRow.state, attempts: failedRow.attempts }, clicked: { retrying: clicked.retrying, code: clicked.code }, afterRow: { state: afterRow.state, attempts: afterRow.attempts } });
    // 收尾：让队列进入 applied，避免影响后续
    await teamTools.applyPendingAcceptances(PROJECT, PROJ, { retries: 1, applyOverride: async () => ({ ok: true, code: 'OK' }) });
  }

  // I W2：回放遇到 ALREADY_ACCEPTED → 补齐工件后 applied + acceptance_backfill 审计
  {
    const alreadyReq = 'R-20261121-1704-d514';
    await teamTools.ownerAccept({ ...baseInput(), requirementId: alreadyReq });
    const appliedAlready = await teamTools.applyPendingAcceptances(PROJECT, PROJ, { retries: 1, applyOverride: async () => ({ ok: false, code: 'ALREADY_ACCEPTED', message: 'already' }) });
    const rowFile = fs.readdirSync(queueDir).map((n) => path.join(queueDir, n)).find((p) => {
      try { return JSON.parse(fs.readFileSync(p, 'utf8')).requirementId === alreadyReq; } catch { return false; }
    });
    const row = rowFile ? JSON.parse(fs.readFileSync(rowFile, 'utf8')) : {};
    const journalText3 = fs.readFileSync(journal, 'utf8');
    check('I ALREADY_ACCEPTED 回放：标 applied + acceptance_backfill 审计', appliedAlready.ok === true && row.state === 'applied' && /acceptance_backfill/.test(journalText3), { applied: appliedAlready, state: row.state });
  }

  // J applied 才早退：同需求再点 → ALREADY_ACCEPTED（pending=false）
  {
    const clicked = await teamTools.ownerAccept({ ...baseInput(), requirementId: 'R-20261121-1704-d514' });
    check('J applied 早退：ALREADY_ACCEPTED 且 pending=false', clicked.code === 'ALREADY_ACCEPTED' && clicked.pending === false && clicked.applied === true, { clicked: { code: clicked.code, pending: clicked.pending } });
  }

  // K W1/W3 静态接线：验收不再二次写/二次读；评审索引改 scheduleIndexRefresh
  {
    const src = fs.readFileSync(path.join(ROOT, 'src', 'team-tools.js'), 'utf8');
    const acceptStart = src.indexOf('async function ownerAcceptCommit');
    const acceptEnd = src.indexOf('function failure(', acceptStart);
    const acceptSlice = acceptStart >= 0 ? src.slice(acceptStart, acceptEnd > acceptStart ? acceptEnd : acceptStart + 120000) : '';
    const decisionStart = src.indexOf('async function ownerRequirementDecision');
    const decisionEnd = src.indexOf('async function ', decisionStart + 10);
    const decisionSlice = decisionStart >= 0 ? src.slice(decisionStart, decisionEnd) : '';
    check('K1 验收 ui 路径不再二次全量写（skipWorkflowWrite）', /skipWorkflowWrite:\s*uiAcceptance/.test(acceptSlice) && /if \(!uiAcceptance\) \{/.test(acceptSlice), {});
    check('K2 评审索引改后台队列（无同步 refreshProjectIndex）', /scheduleIndexRefresh\(ctx\.name, ctx\.projectPath\)/.test(decisionSlice) && !/await refreshProjectIndex\(ctx\.name, ctx\.projectPath\)/.test(decisionSlice), {});
  }

  try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = ROWS.filter((r) => !r.ok).length;
  if (JSON_OUT) console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed, failed: ROWS.filter((r) => !r.ok).map((r) => r.name), rows: ROWS }, null, 2));
  else console.log(`\n${ROWS.length - failed}/${ROWS.length} PASS${failed ? ' · ' + failed + ' FAIL' : ''}`);
  process.exit(failed ? 1 : 0);
})();
