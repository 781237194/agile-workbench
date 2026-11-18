'use strict';
/**
 * accept-prof.cjs —— B-20261118-211237-9ded 打点：验收路径里「读证/哈希/大 JSON/目录扫描」各段耗时。
 * 用真实团队状态的**只读副本**（沙盘 TEAM_ROOT + 需求目录副本）测 team-tools 快照/状态读取，
 * 不写真实团队状态。用法：node _tmp/accept-prof.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = 'D:/deepseek/agile-workbench';
const PNAME = '工作台改造修复';
const SB = path.join(ROOT, '_tmp', 'accept-prof-' + process.pid);
const TEAM = path.join(SB, '团队');
const PROJ_STATE = path.join(TEAM, '状态', '项目', PNAME);
const PROJ_ROOT = path.join(SB, '项目', PNAME);

function cp(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.cpSync(src, dst, { recursive: true, force: true });
}
function time(label, fn) {
  const t0 = process.hrtime.bigint();
  let out;
  try { out = fn(); } catch (e) { out = { __error: String((e && e.message) || e) }; }
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  return { label, ms: Math.round(ms * 10) / 10, out };
}
(async () => {
  fs.rmSync(SB, { recursive: true, force: true });
  // 1) 沙盘团队：团队.json（清 sessionId）+ 项目状态 + 项目根（需求正文/项目信息等）
  cp(path.join(ROOT, '团队', '状态', '团队.json'), path.join(TEAM, '状态', '团队.json'));
  cp(path.join(ROOT, '团队', '状态', '项目', PNAME), PROJ_STATE);
  cp(path.join(ROOT, '项目', PNAME, '需求'), path.join(PROJ_ROOT, '需求'));
  for (const name of ['项目信息.md', '项目铁律.md', '项目索引.md']) {
    try { cp(path.join(ROOT, '项目', PNAME, name), path.join(PROJ_ROOT, name)); } catch { /* ignore */ }
  }
  // 团队必读文档（ensureWorkflowProject 可能读）
  for (const name of ['团队宪法.md', '项目铁律.md']) {
    try { cp(path.join(ROOT, '团队', name), path.join(TEAM, name)); } catch { /* ignore */ }
  }
  process.env.TEAM_ROOT = TEAM;
  process.env.TEAM_PROJECTS_ROOT = path.join(SB, '项目');
  process.env.TEAM_SELFTEST = '1';
  process.env.TEAM_WORKBENCH_JSON = path.join(SB, 'workbench.json');
  const teamTools = require(path.join(ROOT, 'src', 'team-tools.js'));

  const rows = [];
  rows.push(time('readWorkflowState(workflow 1.5MB, fresh=false)', () => teamTools.readWorkflowState(PNAME)));
  rows.push(time('readWorkflowState(workflow 1.5MB, fresh=true)', () => teamTools.readWorkflowState(PNAME, { fresh: true })));
  rows.push(time('readLegacyTasks(任务目录扫描)', () => teamTools.readLegacyTasks(PNAME)));
  rows.push(time('readRequirementDocs(需求目录哈希)', () => teamTools.readRequirementDocs(PROJ_ROOT)));
  rows.push(time('readWorkflowSnapshot(验收门快照)', () => teamTools.readWorkflowSnapshot(PNAME, PROJ_ROOT)));
  rows.push(time('readWorkflowSnapshot(第二次，缓存未启用)', () => teamTools.readWorkflowSnapshot(PNAME, PROJ_ROOT)));

  const taskDir = path.join(PROJ_STATE, '任务');
  const reqDir = path.join(PROJ_ROOT, '需求');
  const counts = {
    taskFiles: fs.existsSync(taskDir) ? fs.readdirSync(taskDir).filter((n) => n.endsWith('.json')).length : 0,
    reqFiles: fs.existsSync(reqDir) ? fs.readdirSync(reqDir).filter((n) => n.endsWith('.md')).length : 0,
    workflowBytes: (() => { try { return fs.statSync(path.join(PROJ_STATE, '工作流.json')).size; } catch { return 0; } })(),
  };
  const report = { at: new Date().toISOString(), counts, rows: rows.map((r) => ({ label: r.label, ms: r.ms, ok: !(r.out && (r.out.__error || r.out.ok === false)) })) };
  const outFile = path.join(ROOT, '项目', PNAME, '程序员B', '产出', '证据-accept-latency', 'accept-prof.json');
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
  for (const r of report.rows) console.log(`${String(r.ms).padStart(8)}ms  ${r.label}${r.ok ? '' : '  (失败)'}`);
  console.log('counts', JSON.stringify(counts));
  console.log('证据：' + outFile);
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
})().catch((e) => { console.error('PROF ERROR ' + String((e && e.stack) || e)); process.exit(1); });
