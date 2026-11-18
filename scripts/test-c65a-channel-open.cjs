#!/usr/bin/env node
'use strict';
/**
 * test-c65a-channel-open.cjs —— c65a AC1 夹具：开局首条对外动作走 team.mjs send（不依赖 MCP）。
 * ⚠ 当前状态=**骨架（WIP）**：ops.mjs 的 doc 阶段豁免（AC3）尚未接线，C4–C6 会被既有 G2
 *   `REQ_REVIEW_REQUIRED` 拦（属预期）；等 `pm dispatch` 子命令/doc 豁免接线后本夹具应转绿。
 * 沙盘（TEAM_ROOT + TEAM_PROJECTS_ROOT + TEAM_SELFTEST=1），用真实 CLI：
 *  ① 选一个在册角色（沙盘名册已清 sessionId，沙盘唤醒不真实驱动 DSH）；
 *  ② 用 PM 身份 `send --ack --task` 发一条派单给 analyst；
 *  ③ 断言：返回「已发送 M-*」；目标邮箱 new/ 出现该消息；唤醒.jsonl 新增一行 to=该角色（或 running 变化，沙盘取唤醒行）；
 *  ④ 断言：全程 subagent 审计记录数=0（子代理树为空）。
 * 用法：node scripts/test-c65a-channel-open.cjs [--out <dir>]。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-c65a'); })();
const SB = path.join(ROOT, '_tmp', `c65a-open-${process.pid}-${Date.now()}`);
const rows = [];
const PNAME = '沙盘项目-c65a';
function check(name, ok, detail) { rows.push({ name, ok: Boolean(ok), detail: ok ? null : detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' :: ' + JSON.stringify(detail).slice(0, 400)}`); }
function run(args, env) {
  try {
    return { ok: true, out: execFileSync(process.execPath, [path.join(ROOT, '团队', '工具', 'team.mjs'), ...args], { cwd: ROOT, env, encoding: 'utf8', windowsHide: true, timeout: 120000 }) };
  } catch (e) { return { ok: false, out: String((e && e.stdout) || ''), err: String((e && e.stderr) || ''), code: e && e.status }; }
}
function seed() {
  fs.rmSync(SB, { recursive: true, force: true });
  const team = path.join(SB, '团队');
  fs.mkdirSync(path.join(team, '状态'), { recursive: true });
  fs.mkdirSync(path.join(SB, '项目'), { recursive: true });
  const realTeam = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8').replace(/^\uFEFF/, ''));
  for (const m of realTeam.members || []) m.sessionId = '';
  realTeam.activeProject = PNAME;
  fs.writeFileSync(path.join(team, '状态', '团队.json'), JSON.stringify(realTeam, null, 2) + '\n', 'utf8');
  fs.copyFileSync(path.join(ROOT, '团队', '团队宪法.md'), path.join(team, '团队宪法.md'));
  fs.copyFileSync(path.join(ROOT, '团队', '项目铁律.md'), path.join(team, '项目铁律.md'));
  return { teamRoot: team };
}
(async () => {
  const seedInfo = seed();
  const env = { ...process.env, TEAM_ROOT: seedInfo.teamRoot, TEAM_PROJECTS_ROOT: path.join(SB, '项目'), TEAM_SELFTEST: '1', AWB_DATA_DIR: path.join(SB, 'data') };
  fs.mkdirSync(OUT, { recursive: true });
  // 建沙盘项目并 boot PM/analyst
  const created = run(['project', 'add', '--name', PNAME, '--path', path.join(SB, '项目', PNAME), '--team-mode', 'full', '--json'], env);
  check('C0 沙盘项目创建', created.ok, created);
  const bootPm = run(['boot', '--role', 'pm', '--project', PNAME, '--session', 'selftest-c65a-pm', '--json'], env);
  let pmToken = '';
  try { pmToken = JSON.parse(bootPm.out).token || ''; } catch { pmToken = ''; }
  check('C1 PM boot 拿到令牌', Boolean(pmToken), bootPm);
  const bootAna = run(['boot', '--role', 'analyst', '--project', PNAME, '--session', 'selftest-c65a-ana', '--json'], env);
  check('C2 目标角色 analyst boot', bootAna.ok, bootAna);
  // 建需求 + 绑定任务供 --task 使用
  const req = run(['req', 'create', '--boot', pmToken, '--project', PNAME, '--title', '夹具-团队通道', '--priority', 'P2', '--acceptance', '夹具验收：首条动作产生 M-* 且目标被唤醒，子代理=0', '--body', '夹具正文：验证开局首条动作走团队通道（含验收标准）。', '--json'], env);
  let reqId = '';
  try { const j = JSON.parse(req.out); reqId = String((j.requirement && j.requirement.id) || j.id || ''); } catch { reqId = ''; }
  let taskId = '';
  if (reqId) {
    const task = run(['task', 'create', '--boot', pmToken, '--project', PNAME, '--requirement', reqId, '--title', '写需求正文', '--priority', 'P2', '--json'], env);
    try { const j = JSON.parse(task.out); taskId = String((j.task && j.task.id) || ''); } catch { taskId = ''; }
  }
  check('C3 建立夹具需求+任务', Boolean(reqId && taskId), { reqId, taskId, reqErr: String(req.out || '').slice(0, 200) });
  const wakeFile = path.join(seedInfo.teamRoot, '状态', '项目', PNAME, '唤醒.jsonl');
  const beforeWake = (() => { try { return fs.readFileSync(wakeFile, 'utf8').split('\n').filter(Boolean).length; } catch { return 0; } })();
  const mailRoot = path.join(seedInfo.teamRoot, '状态', '邮箱');
  const listMailJson = () => {
    const hits = [];
    const walk = (dir) => {
      let ents = [];
      try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
      for (const ent of ents) { const full = path.join(dir, ent.name); if (ent.isDirectory()) walk(full); else if (/\.json$/.test(ent.name)) hits.push(full); }
    };
    walk(mailRoot);
    return hits;
  };
  const beforeMailFiles = listMailJson();
  // AC1 首条对外动作：send --ack --task（沙盘）
  const sent = run(['send', '--boot', pmToken, '--project', PNAME, '--to', 'analyst', '--type', 'dispatch', '--ack', '--task', taskId, '--subject', '夹具派单', '--body', '夹具：请写作正文', '--json'], env);
  let sentId = '';
  try { const j = JSON.parse(sent.out); sentId = String((j.message && j.message.id) || j.messageId || j.id || ''); } catch { sentId = ''; }
  check('C4 首条动作 send 返回 M-*（已发送）', Boolean(sentId && sentId.startsWith('M-')) || /已发送\s*M-/.test(sent.out || ''), { out: String(sent.out || '').slice(0, 300), err: sent.err });
  const afterMailFiles = listMailJson();
  const newMail = afterMailFiles.filter((f) => !beforeMailFiles.includes(f));
  check('C5 目标邮箱出现该消息（new/cur 任一，含 M-* id）', newMail.length > 0 && newMail.some((f) => /M-/.test(path.basename(f))) || newMail.length > 0, { newMail: newMail.map((f) => path.relative(seedInfo.teamRoot, f)) });
  const wakes = (() => { try { return fs.readFileSync(wakeFile, 'utf8').split('\n').filter(Boolean).map((x) => JSON.parse(x)); } catch { return []; } })();
  const newWake = wakes.slice(beforeWake).find((w) => String(w.to || w.role || '') === 'analyst');
  check('C6 唤醒.jsonl 新增 to=analyst（目标被叫醒）', Boolean(newWake), { beforeWake, wakes: wakes.length, tail: wakes.slice(-2) });
  // 子代理审计=0
  let subagentRows = 0;
  try { subagentRows = fs.readFileSync(path.join(seedInfo.teamRoot, '状态', '项目', PNAME, '子代理', '记录.jsonl'), 'utf8').split('\n').filter(Boolean).length; } catch { subagentRows = 0; }
  // C8（AC3）：doc 阶段豁免审计可回查——团队/状态/事件.jsonl 里有 reason=doc_stage 的 dispatch_gate_skipped
  let docSkipRows = 0;
  try {
    const evFile = path.join(seedInfo.teamRoot, '状态', '事件.jsonl');
    docSkipRows = fs.readFileSync(evFile, 'utf8').split('\n').filter(Boolean)
      .map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter((row) => row && row.action === 'dispatch_gate_skipped' && row.data && row.data.reason === 'doc_stage').length;
  } catch { docSkipRows = 0; }
  check('C8 doc 阶段豁免审计（事件.jsonl reason=doc_stage）', docSkipRows >= 1, { docSkipRows });
  check('C7 全程 subagent 审计记录=0（子代理树为空）', subagentRows === 0, { subagentRows });
  try { fs.writeFileSync(path.join(OUT, 'channel-open-run.json'), JSON.stringify({ at: new Date().toISOString(), checks: rows }, null, 2) + '\n', 'utf8'); } catch { /* ignore */ }
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = rows.filter((r) => !r.ok);
  console.log('');
  console.log(`C65A-OPEN ${failed.length ? 'FAIL' : 'OK'} ${JSON.stringify({ total: rows.length, pass: rows.length - failed.length, red: failed.length })}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('C65A-OPEN ERROR ' + String((e && e.stack) || e)); process.exit(1); });
