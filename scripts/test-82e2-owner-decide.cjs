#!/usr/bin/env node
'use strict';
/**
 * test-82e2-owner-decide.cjs —— B-20261120-230446-82e2（P1）Owner 决定「已落账却报失败」夹具
 *
 * 真调用入口：`src/team-tools.js → applyOwnerDecisionToRequirement`（与 owner:decide IPC 同一执行体）。
 * 断言：
 *  ① 不抛异常，返回 ok:true 且 decided:true；
 *  ② 需求行 decisions **净 +1**（ownerReview 同步 approved）；
 *  ③ 通知 PM 失败时：ownerDecisionNotify.ok=false + 有 code，warnings 里标注「决定已生效，但通知 PM 失败」；
 *  ④ 渲染层文案：成功路径含「已生效；附：通知 PM 失败 code=」；未知错误不再断言「现在还不能提交」。
 *
 * 用法：node scripts/test-82e2-owner-decide.cjs [--json]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');
const SB = fs.mkdtempSync(path.join(os.tmpdir(), '82e2-owner-'));
const TEAM = path.join(SB, '团队');
const PNAME = '82e2项目';
const REQ = 'R-20261120-999999-82e2';
const PROJ_DIR = path.join(SB, '项目区', PNAME);
const STORE = path.join(SB, 'data', 'userdata', 'workbench.json');
const STATE = path.join(TEAM, '状态', '项目', '82e2项目');
const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
}
function seed(withTools) {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  fs.mkdirSync(STATE, { recursive: true });
  fs.mkdirSync(PROJ_DIR, { recursive: true });
  fs.mkdirSync(path.join(SB, 'data', 'userdata'), { recursive: true });
  if (withTools) {
    try { fs.symlinkSync(path.join(ROOT, '团队', '工具'), path.join(TEAM, '工具'), 'junction'); } catch { /* 已存在 */ }
  }
  fs.writeFileSync(path.join(STATE, '项目.json'), JSON.stringify({ name: PNAME, path: PROJ_DIR, teamMode: 'full' }, null, 2));
  fs.writeFileSync(path.join(STATE, '工作流.json'), JSON.stringify({
    schema: 2, project: PNAME, phase: 'requirement_review', round: 1, events: [],
    requirements: { [REQ]: { id: REQ, title: '82e2 夹具需求', status: 'review', round: 1, decisions: [], ownerReview: null } },
    ownerReview: {},
  }, null, 2));
  fs.writeFileSync(STORE, JSON.stringify({
    version: 1, activeProjectId: 'P-82e2',
    projects: [{ id: 'P-82e2', name: PNAME, teamName: PNAME, path: PROJ_DIR, teamMode: 'full', sessions: {}, requirements: [], sessionMeta: {} }],
    ui: {},
  }, null, 2));
}

async function main() {
  // 环境必须在 require src/team-tools.js 之前指向沙盘（模块内 PATHS/layout 在 import 时解析）。
  Object.assign(process.env, {
    TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: path.join(SB, '项目区'), TEAM_WORKBENCH_JSON: STORE,
    AWB_DATA_DIR: path.join(SB, 'data'), AWB_STORE: STORE, TEAM_SELFTEST: '1',
  });
  seed(true);
  const teamTools = require(path.join(ROOT, 'src', 'team-tools.js'));
  const tools = teamTools.create({ teamRoot: TEAM });
  const project = { id: 'P-82e2', name: PNAME, teamName: PNAME, path: PROJ_DIR };
  const decisionsOf = () => {
    try {
      const wf = JSON.parse(fs.readFileSync(path.join(STATE, '工作流.json'), 'utf8'));
      const row = wf.requirements && wf.requirements[REQ];
      return Array.isArray(row && row.decisions) ? row.decisions.length : -1;
    } catch { return -1; }
  };
  const before = decisionsOf();
  let result = null;
  let thrown = null;
  try {
    result = await tools.applyOwnerDecisionToRequirement({
      project, projectName: PNAME, requirementId: REQ, status: 'approved',
      opinion: '夹具：Owner 点通过', channel: 'ui', by: 'Owner', roundKey: PNAME + '|1|1',
    });
  } catch (error) { thrown = error; }
  const after = decisionsOf();
  check('① 真调用入口不抛异常（旧实现 ReferenceError: ownerDecisionNotify is not defined）', !thrown, { error: thrown && String(thrown.message || thrown) });
  check('①b 返回 ok:true 且 decided:true（落账后不再被整体报失败）',
    Boolean(result && result.ok === true && result.decided === true), result && { ok: result.ok, code: result.code, decided: result.decided });
  check('② 需求行 decisions 净 +1（旧值 ' + before + ' → ' + after + '）', before >= 0 && after === before + 1, { before, after });
  const notify = (result && result.ownerDecisionNotify) || null;
  check('③ 通知失败时给出 ownerDecisionNotify.ok=false + code（本项目 sandbox 无 pm 令牌 → 必然失败，属预期路径）',
    Boolean(notify && notify.ok === false && notify.code), notify);
  const warnings = (result && Array.isArray(result.warnings)) ? result.warnings : [];
  check('③b warnings 明确写「决定已生效，但通知 PM 失败」',
    warnings.some((w) => /决定已生效/.test(String(w && w.message || ''))), warnings);
  check('③c notifyFailed 标记为 true（供界面拼「已通过（附：通知 PM 失败 code=X）」）',
    Boolean(result && result.notifyFailed === true), result && result.notifyFailed);

  const ui = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'owner-review.js'), 'utf8');
  check('④ 成功文案含「已生效；附：通知 PM 失败 code=」', /已生效；附：通知 PM 失败 code=/.test(ui), {});
  check('④b 未知错误不再断言「现在还不能提交」（改成先刷新核对）',
    /提交结果未确认：决定可能已落账/.test(ui) && !/title = hint \|\| detail \|\| '现在还不能提交这个决定'/.test(ui), {});

  try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* 沙盘清理失败不阻断结论 */ }
  const failed = ROWS.filter((r) => !r.ok).length;
  if (JSON_OUT) console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed, failed: ROWS.filter((r) => !r.ok).map((r) => r.name), rows: ROWS }, null, 2));
  else console.log(`\n${ROWS.length - failed}/${ROWS.length} PASS${failed ? ' · ' + failed + ' FAIL' : ''}`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('FIXTURE_FAILED', String((e && e.stack) || e)); process.exit(1); });
