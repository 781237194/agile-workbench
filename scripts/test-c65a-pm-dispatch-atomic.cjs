#!/usr/bin/env node
'use strict';
/**
 * test-c65a-pm-dispatch-atomic.cjs —— c65a AC2 原子派单模块夹具（T-20261119-021319-59e0）。
 * 沙盘（TEAM_ROOT+TEAM_PROJECTS_ROOT+TEAM_WORKBENCH_JSON+TEAM_SELFTEST），真实 CLI：
 *  A) 纯逻辑：aggregateMissing 聚合/去重；
 *  B) 失败一次列全：fast 项目派给不在模式里的 programmer2 → boot 目标失败 + dispatch-check 未放行 → missing≥2，
 *     且目标邮箱 **零写入**（不产生 M-*）；
 *  C) 正常路径：full 项目派给 analyst → 自动 boot 自己/目标 + lessons + dispatch-check(go/go_degraded) + send
 *     → 恰好一条 M-*（目标邮箱新增 1 封且 messageId 以 M- 开头）。
 * 用法：node scripts/test-c65a-pm-dispatch-atomic.cjs [--out <dir>]。
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', `c65a-atomic-${process.pid}-${Date.now()}`);
const TEAM = path.join(SB, '团队');
const PROJ = path.join(SB, '项目');
const WB = path.join(SB, 'workbench.json');
const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-c65a'); })();
const rows = [];
const P_FULL = '原子项目-full';
const P_FAST = '原子项目-fast';
function check(name, ok, detail) { rows.push({ name, ok: Boolean(ok), detail: ok ? null : detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' :: ' + JSON.stringify(detail).slice(0, 400)}`); }
function cli(args, env) {
  try {
    return { ok: true, out: execFileSync(process.execPath, [path.join(ROOT, '团队', '工具', 'team.mjs'), ...args], { cwd: ROOT, env, encoding: 'utf8', windowsHide: true, timeout: 120000 }) };
  } catch (e) { return { ok: false, out: String((e && e.stdout) || ''), err: String((e && e.stderr) || ''), code: e && e.status }; }
}
function mailCount(env, role) {
  const d = path.join(TEAM, '状态', '邮箱', role);
  let n = 0;
  for (const box of ['new', 'cur']) { try { n += fs.readdirSync(path.join(d, box)).length; } catch { /* ignore */ } }
  return n;
}
function seed() {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  fs.mkdirSync(PROJ, { recursive: true });
  const team = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8').replace(/^\uFEFF/, ''));
  for (const m of team.members || []) m.sessionId = '';
  team.activeProject = P_FULL;
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  for (const f of ['团队宪法.md', '项目铁律.md']) { try { fs.copyFileSync(path.join(ROOT, '团队', f), path.join(TEAM, f)); } catch { /* ignore */ } }
  const env = { ...process.env, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJ, TEAM_WORKBENCH_JSON: WB, TEAM_SELFTEST: '1' };
  const full = cli(['project', 'add', '--name', P_FULL, '--path', path.join(PROJ, P_FULL), '--team-mode', 'full', '--json'], env);
  const fast = cli(['project', 'add', '--name', P_FAST, '--path', path.join(PROJ, P_FAST), '--team-mode', 'fast', '--json'], env);
  return { env, full, fast };
}
(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const mod = await import(pathToFileURL(path.join(ROOT, '团队', '工具', 'lib', 'pm-dispatch-atomic.mjs')).href);
  // A) 纯逻辑
  const agg = mod.aggregateMissing({
    bootSelf: { ok: false, json: { code: 'BOOT_FAILED_X' } },
    lessons: { ok: false, json: { code: 'LESSONS_UNREAD' } },
    bootTarget: { ok: false, json: { code: 'BAD_ROLE' } },
    dispatchCheck: { ok: true, json: { verdict: 'blocked', reasons: ['目标未 boot'], numbers: { booted: false, lockBy: 'M-1' } } },
  });
  check('A1 aggregateMissing 聚合五类缺项且去重', agg.length >= 4 && new Set(agg).size === agg.length, agg);
  check('A2 missing 含目标 boot 失败与派单锁', agg.some((x) => x.includes('目标 boot 失败')) && agg.some((x) => x.includes('派单锁被占用')), agg);
  // 种子
  const seedInfo = seed();
  check('S0 沙盘项目创建（full+fast）', seedInfo.full.ok && seedInfo.fast.ok, { full: seedInfo.full.out && seedInfo.full.out.slice(0, 200), fast: seedInfo.fast.out && seedInfo.fast.out.slice(0, 200) });
  const env = seedInfo.env;
  // B) 失败一次列全（fast 模式没有 programmer2）
  const before = mailCount(env, 'programmer2');
  const failRes = mod.runPmDispatchAtomic({ project: P_FAST, to: 'programmer2', subject: '夹具-失败路径', body: '夹具：该角色不在 fast 模式', env });
  check('B1 失败返回 ok:false 且 missing≥2（一次列全）', failRes.ok === false && Array.isArray(failRes.missing) && failRes.missing.length >= 2, failRes.missing);
  check('B2 失败零派单写入（目标邮箱未新增）', mailCount(env, 'programmer2') === before, { before, after: mailCount(env, 'programmer2') });
  // C) 正常路径
  const beforeC = mailCount(env, 'analyst');
  const okRes = mod.runPmDispatchAtomic({ project: P_FULL, to: 'analyst', subject: '夹具-正常派单', body: '夹具：原子派单正常路径', env });
  check('C1 正常路径 ok:true 且产出一条 M-*', okRes.ok === true && /^M-/.test(String(okRes.messageId || '')), { ok: okRes.ok, messageId: okRes.messageId, missing: okRes.missing });
  check('C2 目标邮箱恰好新增 1 封', mailCount(env, 'analyst') === beforeC + 1, { beforeC, after: mailCount(env, 'analyst') });
  const checks = okRes.checks || {};
  check('C3 五步均有结果（bootSelf/lessons/bootTarget/dispatchCheck/send）', Boolean(checks.bootSelf && checks.lessons && checks.bootTarget && checks.dispatchCheck && checks.send), Object.keys(checks));
  const verdict = checks.dispatchCheck && checks.dispatchCheck.json && checks.dispatchCheck.json.verdict;
  check('C4 dispatch-check 放行为 go/go_degraded', ['go', 'go_degraded'].includes(String(verdict)), { verdict });
  try { fs.writeFileSync(path.join(OUT, 'pm-dispatch-atomic-run.json'), JSON.stringify({ at: new Date().toISOString(), checks: rows }, null, 2) + '\n', 'utf8'); } catch { /* ignore */ }
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = rows.filter((r) => !r.ok);
  console.log('');
  console.log(`C65A-ATOMIC ${failed.length ? 'FAIL' : 'OK'} ${JSON.stringify({ total: rows.length, pass: rows.length - failed.length, red: failed.length })}`);
  console.log('证据：' + path.join(OUT, 'pm-dispatch-atomic-run.json'));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('C65A-ATOMIC ERROR ' + String((e && e.stack) || e)); process.exit(1); });
