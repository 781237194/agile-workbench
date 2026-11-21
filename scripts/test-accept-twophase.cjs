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

  try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = ROWS.filter((r) => !r.ok).length;
  if (JSON_OUT) console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed, failed: ROWS.filter((r) => !r.ok).map((r) => r.name), rows: ROWS }, null, 2));
  else console.log(`\n${ROWS.length - failed}/${ROWS.length} PASS${failed ? ' · ' + failed + ' FAIL' : ''}`);
  process.exit(failed ? 1 : 0);
})();
