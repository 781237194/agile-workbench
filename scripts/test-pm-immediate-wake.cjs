#!/usr/bin/env node
'use strict';
/**
 * T-20261117-203046-9ff2 自检：PM 关键消息「立即唤醒」（不等队列泵）
 *
 * 断言（沙箱四隔离 + TEAM_SELFTEST=1）：
 *   ① escalation → sendMessage 之后**同一拍内**唤醒日志出现 to=pm（reason=pm_critical:escalation）；
 *   ② wake_failed 同理；③ req_review 同理（PM 漏讯的三类主犯）；
 *   ④ 非关键类型（note）不触发即时唤醒（留给 digest 兜底，避免噪音）；
 *   ⑤ 钩子只注册一次（重复 import 不叠加）；⑥ 真实树无沙盘标识。
 *
 * 跑法：node scripts/test-pm-immediate-wake.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REAL = path.resolve(__dirname, '..');
const PROJECT = '工作台改造修复';
const BASE = path.join(REAL, '_tmp', `pm-immediate-${process.pid}-${Date.now().toString(36)}`);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 600)}`);
  if (!ok) process.exitCode = 1;
}
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, ent.name); const b = path.join(dst, ent.name);
    if (filter && filter(a)) continue;
    if (ent.isDirectory()) copyDir(a, b, filter); else fs.copyFileSync(a, b);
  }
}

(async () => {
  fs.mkdirSync(BASE, { recursive: true });
  const data = path.join(BASE, 'data');
  const team = path.join(BASE, '团队');
  const projectDir = path.join(BASE, '项目', PROJECT);
  fs.mkdirSync(path.join(data, 'userdata'), { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  copyDir(path.join(REAL, '团队'), team, (p) => /[\\/]邮箱([\\/]|$)/.test(p) || /[\\/]锁([\\/]|$)/.test(p));
  const state = path.join(team, '状态', '项目', PROJECT);
  fs.rmSync(state, { recursive: true, force: true });
  fs.mkdirSync(state, { recursive: true });
  const roster = readJson(path.join(team, '状态', '团队.json'), { members: [] });
  for (const m of roster.members || []) m.sessionId = '';
  roster.activeProject = PROJECT;
  writeJson(path.join(team, '状态', '团队.json'), roster);
  writeJson(path.join(state, '项目.json'), { name: PROJECT, path: projectDir, teamMode: 'full' });
  const store = readJson(path.join(REAL, 'data', 'userdata', 'workbench.json'), { projects: [] });
  const project = (store.projects || []).find((p) => p && String(p.teamName || p.name || '') === PROJECT);
  store.projects = [project]; store.activeProjectId = project.id;
  project.path = projectDir;
  writeJson(path.join(data, 'userdata', 'workbench.json'), store);

  process.env.AWB_DATA_DIR = data;
  process.env.TEAM_ROOT = team;
  process.env.TEAM_PROJECTS_ROOT = path.join(team, '状态', '项目');
  process.env.TEAM_WORKBENCH_JSON = path.join(data, 'userdata', 'workbench.json');
  process.env.TEAM_SELFTEST = '1';

  const wakeRows = () => {
    const f = path.join(state, '唤醒.jsonl');
    if (!fs.existsSync(f)) return [];
    return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  };
  const waitTick = () => new Promise((r) => setTimeout(r, 400));

  // 先 import ops（它注册钩子），再 import store 发消息
  await import(pathToFileURL(path.join(REAL, '团队', '工具', 'lib', 'ops.mjs')).href);
  const storeMod = await import(pathToFileURL(path.join(REAL, '团队', '工具', 'lib', 'store.mjs')).href);

  const caseOf = async (type, subject) => {
    const before = wakeRows().length;
    const msg = storeMod.sendMessage({ from: 'system', to: 'pm', project: PROJECT, type, subject, body: `${subject}（夹具）` });
    await waitTick();
    const rows = wakeRows().slice(before);
    return { msg, rows, hit: rows.filter((r) => String(r.to) === 'pm' && String(r.reason || '').startsWith('pm_critical:')) };
  };

  const c1 = await caseOf('escalation', '升级夹具：交接超时');
  check('① escalation → 写盘后立即唤醒 to=pm（reason=pm_critical:escalation）',
    c1.hit.length >= 1 && c1.hit.some((r) => String((r.messageIds || []).join(',')).includes(c1.msg.id)),
    { rows: c1.rows, hit: c1.hit.length });

  const c2 = await caseOf('wake_failed', '唤醒失败夹具');
  check('② wake_failed → 立即唤醒 to=pm', c2.hit.length >= 1, { hit: c2.hit.length, rows: c2.rows });

  const c3 = await caseOf('req_review', '评审打回夹具');
  check('③ req_review → 立即唤醒 to=pm', c3.hit.length >= 1, { hit: c3.hit.length });

  const c4 = await caseOf('note', '普通通知夹具（不该即时叫）');
  check('④ 非关键类型 note 不触发即时唤醒（留给 digest 兜底）', c4.hit.length === 0, { hit: c4.hit.length, rows: c4.rows });

  // ⑤ 重复 import 不重复注册：再 import 一次，再发一条，唤醒行数只增 1
  const before5 = wakeRows().length;
  await import(pathToFileURL(path.join(REAL, '团队', '工具', 'lib', 'ops.mjs')).href);
  storeMod.sendMessage({ from: 'system', to: 'pm', project: PROJECT, type: 'escalation', subject: '重复 import 后的夹具', body: '重复 import 后的夹具（正文）' });
  await waitTick();
  const rows5 = wakeRows().slice(before5);
  check('⑤ 钩子只注册一次（重复 import 后仍只 1 条唤醒）', rows5.length === 1, { rows: rows5.length });

  // ⑥ 隔离
  const realTeam = readJson(path.join(REAL, '团队', '状态', '团队.json'), { members: [] });
  const leak = (realTeam.members || []).some((m) => m.sessionId === '' && m.status === 'active');
  check('⑥ 隔离：真实团队名册未被改成空 sessionId（沙盘独立）', leak === false, { leak });

  const pass = results.filter((r) => r.ok).length;
  console.log('');
  console.log(`${pass === results.length ? 'PM_IMMEDIATE_WAKE_OK' : 'PM_IMMEDIATE_WAKE_WARN'} ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
  try { fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
})();
