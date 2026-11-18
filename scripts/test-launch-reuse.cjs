#!/usr/bin/env node
'use strict';
/**
 * test-launch-reuse.cjs —— B-20261118-080052-207b 回归夹具
 *
 * 缺陷：launch「启动团队」复用条件只看 workspace.sessionIds；未命中就新建并**直接覆盖名册**，
 * 不写轮换记录、不广播、旧会话不标 retired（07:39 PM 被静默换掉）。
 *
 * 断言：
 *   A 三源复用判定（pickReuse）：名册/映射/标题三源，及 archived/cwd 不符的排除
 *   B 轮换记录（buildRotation）：from≠to 才产出；含 retired 标记、jsonl 行、广播清单
 *   C 静态接线：launch.mjs 用 pickReuse/buildRotation，写 会话轮换/<role>.json + 会话轮换.jsonl + session_rotate(by=launch)
 *   D 失败不覆盖名册：轮换记账失败的角色从名册更新里剔除（rosterSkipped）
 *
 * 用法：node scripts/test-launch-reuse.cjs  （可用 AWB_LAUNCH_REUSE_OUT 指定 run.json）
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
let pass = 0;
const results = [];
function ok(name, cond, detail) {
  results.push({ name, ok: Boolean(cond), detail: cond ? '' : detail });
  if (cond) { pass += 1; console.log(`PASS  ${name}`); return; }
  console.log(`FAIL  ${name}  ` + JSON.stringify(detail || {}).slice(0, 300)); process.exitCode = 1;
}

const WS = path.join(ROOT, '项目', '工作台改造修复');
const OTHER = path.join(ROOT, '..', 'other-ws');

(async () => {
const LIB = await import(pathToFileURL(path.join(ROOT, '团队', '工具', 'lib', 'launch-reuse.mjs')).href);
const sess = (id, title, cwd, extra = {}) => ({ sessionId: id, cwd, projections: { values: { title } }, ...extra });

// ── A 三源复用
const baseSessions = [
  sess('s-roster', '团队·项目经理', WS, { archived: false }),
  sess('s-manifest', '团队·产品设计师', WS),
  sess('s-title', '团队·测试人员', WS),
  sess('s-archived', '团队·需求分析师', WS, { archived: true }),
  sess('s-elsewhere', '团队·程序员B', OTHER),
];
const pick = (o) => LIB.pickReuse({ workspace: WS, sessions: baseSessions, workspaceSessionIds: [], ...o });

const p1 = pick({ role: 'pm', title: '团队·项目经理', rosterSessionId: 's-roster', manifestSessionId: '' });
ok('A1 名册 sessionId 在 DSH 且 cwd 匹配、但不在 workspace.sessionIds → 复用（source=roster）',
  p1.sessionId === 's-roster' && p1.source === 'roster' && p1.inWorkspace === false, p1);

const p2 = pick({ role: 'product', title: '团队·产品设计师', rosterSessionId: '', manifestSessionId: 's-manifest' });
ok('A2 名册为空 → 落项目映射（source=manifest）', p2.sessionId === 's-manifest' && p2.source === 'manifest', p2);

const p3 = pick({ role: 'tester', title: '团队·测试人员', rosterSessionId: 's-gone', manifestSessionId: 's-gone2' });
ok('A3 名册/映射均失配 → 落标题（source=title）', p3.sessionId === 's-title' && p3.source === 'title', p3);

const p4 = pick({ role: 'pm', title: '团队·不存在', rosterSessionId: '', manifestSessionId: '' });
ok('A4 三源全无 → source=none（调用方新建）', p4.sessionId === '' && p4.source === 'none', p4);

const p5 = pick({ role: 'analyst', title: '团队·需求分析师', rosterSessionId: 's-archived', manifestSessionId: '' });
ok('A5 名册指向 archived 会话 → 不复用（退回无可用）', p5.sessionId === '' && p5.source === 'none', p5);

const p6 = pick({ role: 'programmer2', title: '团队·程序员B', rosterSessionId: 's-elsewhere', manifestSessionId: '' });
ok('A6 名册会话 cwd 属别的工作区 → 不复用（防串项目）', p6.sessionId === '' && p6.source === 'none', p6);

// ── B 轮换记录
const r1 = LIB.buildRotation({ role: 'pm', from: 'old-1', to: 'new-1', project: 'P', at: '2026-11-18T00:00:00.000Z', members: [{ role: 'pm' }, { role: 'tester' }, { role: 'analyst', status: 'left' }] });
ok('B1 from≠to → 轮换记录完整（by=launch / retired 标记 / jsonl / 广播清单）',
  Boolean(r1) && r1.record.by === 'launch' && r1.record.status === 'active'
  && r1.record.retiredSession.status === 'retired' && r1.record.retiredSession.sessionId === 'old-1'
  && r1.jsonl.from === 'old-1' && r1.jsonl.to === 'new-1'
  && r1.broadcasts.others.includes('tester') && !r1.broadcasts.others.includes('pm') && !r1.broadcasts.others.includes('analyst'),
  r1);

const r2 = LIB.buildRotation({ role: 'pm', from: '', to: 'new-2', project: 'P' });
const r3 = LIB.buildRotation({ role: 'pm', from: 'same', to: 'same', project: 'P' });
ok('B2 首次绑定（无旧 id）/ 复用（from===to）→ 不产出轮换记录', r2 === null && r3 === null, { r2, r3 });

// ── C/D 静态接线
const launchSrc = fs.readFileSync(path.join(ROOT, '团队', '工具', 'launch.mjs'), 'utf8');
ok('C1 launch.mjs 使用 pickReuse + buildRotation（三源判定不再是「只在 sessionIds 里」）',
  /pickReuse\(/.test(launchSrc) && /buildRotation\(/.test(launchSrc)
  && /rosterSessions/.test(launchSrc) && /manifestSessions/.test(launchSrc)
  && !/const activeSessionIds = new Set/.test(launchSrc), {});
ok('C2 新建替换写 会话轮换/<role>.json + 会话轮换.jsonl + 事件 session_rotate（by=launch）',
  /path\.join\(rotateDir, `\$\{rot\.role\}\.json`\)/.test(launchSrc)
  && /'会话轮换\.jsonl'/.test(launchSrc)
  && /action: 'session_rotate'/.test(launchSrc)
  && /role: 'launch'/.test(launchSrc), {});
ok('C3 旧会话标 retired/归档 + 广播（本人 + 其余 active 成员）',
  /workspaceArchiveSession\(\{ sessionId: rot\.from/.test(launchSrc)
  && /broadcast-self/.test(launchSrc) && /broadcast-other/.test(launchSrc), {});
ok('D1 轮换记账失败的角色不写名册（rosterSkipped / rotationFailedRoles）',
  /const rotationFailedRoles/.test(launchSrc) && /if \(rotationFailedRoles\.has\(s\.role\)\) continue;/.test(launchSrc), {});

const report = { task: 'B-20261118-080052-207b', at: new Date().toISOString(), total: pass + (results.length - pass), pass, red: results.length - pass, results };
const outEnv = process.env.AWB_LAUNCH_REUSE_OUT || path.join('_tmp', 'run-launch-reuse.json');
const outFile = path.isAbsolute(outEnv) ? outEnv : path.join(ROOT, outEnv);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`\nLAUNCH_REUSE ${JSON.stringify({ total: report.total, pass: report.pass, red: report.red })}`);
console.log('证据：' + outFile);
process.exit(report.red ? 1 : 0);
})().catch((e) => { console.error('LAUNCH_REUSE_FAILED ' + String((e && e.stack) || e)); process.exit(2); });
