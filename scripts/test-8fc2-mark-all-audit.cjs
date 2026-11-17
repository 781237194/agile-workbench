#!/usr/bin/env node
'use strict';
/**
 * test-8fc2-mark-all-audit.cjs —— B-20261117-013448-8fc2 回归夹具
 *
 * 缺陷：`inbox --mark-all-read` 的审计只写 {at,role,kind,project,unread,marked,source}，
 * 不落被清消息 id → B-d672 类「PM 漏收角色答复」事后无法回查「那条到底有没有送到」。
 *
 * 断言（沙盘，真实团队树零写入）：
 *   A1 3 条 pm→analyst 未读消息（沙盘 TEAM_SELFTEST=1，不投递、不自动已读）
 *   A2 mark-all-read 的 JSON 返回带 messageIds，且与发送的 3 个 id 全等
 *   A3 阅读.jsonl 的 mark-all-read 行落 messageIds（集合相等）+ cleared[{id,from,subject}]
 *   A4 事件流 inbox_mark_all_read 带 data.messageIds（同一集合）
 *   A5 审计行不搬正文：cleared 项无 body/text 字段，且不出现消息正文字串
 *   A6 清完后 unread=0（再跑 inbox --json），且重复 mark-all-read 不重复计数（幂等）
 *
 * 隔离：mkTempSandbox + TEAM_ROOT/TEAM_PROJECTS_ROOT/TEAM_WORKBENCH_JSON 全指沙盘 + TEAM_SELFTEST=1。
 * 用法：node scripts/test-8fc2-mark-all-audit.cjs
 * 退出码：0 全过 / 1 有断言失败 / 2 环境错误
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const ROOT = path.resolve(__dirname, '..');
const SB = mkTempSandbox('8fc2');
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench.json');
const TEAM_TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const PROJECT = 'markAll审计沙盘';

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 300)}`);
}
const env = () => ({
  ...process.env,
  TEAM_ROOT: TEAM,
  TEAM_PROJECTS_ROOT: PROJECTS,
  TEAM_WORKBENCH_JSON: STORE,
  TEAM_SELFTEST: '1',
});
function run(args) {
  try {
    return { code: 0, out: String(execFileSync(process.execPath, [TEAM_TOOL, ...args], { encoding: 'utf8', env: env(), timeout: 120000, cwd: SB })) };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
}
function runJson(args) {
  const r = run(args);
  const t = String(r.out || '').trim();
  const i = t.indexOf('{');
  let json = null;
  if (i >= 0) { try { json = JSON.parse(t.slice(i)); } catch { json = null; } }
  return { ...r, json };
}
const readJsonl = (file) => fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);

if (!fs.existsSync(TEAM_TOOL)) { console.error('环境错误：找不到 team.mjs'); process.exit(2); }

// ── 沙盘骨架（清空名册 sessionId，防误投真实会话）
fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
fs.mkdirSync(PROJECTS, { recursive: true });
const teamSrc = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8'));
for (const m of teamSrc.members || []) m.sessionId = '';
teamSrc.activeProjectId = '';
fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(teamSrc, null, 2) + '\n', 'utf8');
for (const rel of ['团队宪法.md', '项目铁律.md']) {
  const src = path.join(ROOT, '团队', rel);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TEAM, rel));
}
for (const dir of ['协议', '模板']) {
  const src = path.join(ROOT, '团队', dir);
  if (fs.existsSync(src)) fs.cpSync(src, path.join(TEAM, dir), { recursive: true });
}
fs.cpSync(path.join(ROOT, '团队', '工具'), path.join(TEAM, '工具'), { recursive: true });

const addProject = runJson(['project', 'add', '--name', PROJECT, '--team-mode', 'fast', '--json']);
if (addProject.code !== 0) { console.error('环境错误：project add 失败 ' + JSON.stringify(addProject).slice(0, 300)); process.exit(2); }
const bootPm = runJson(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-pm-8fc2', '--json']);
const bootAn = runJson(['boot', '--role', 'analyst', '--project', PROJECT, '--session', 's-an-8fc2', '--json']);
const PM = String((bootPm.json && bootPm.json.token) || '');
const AN = String((bootAn.json && bootAn.json.token) || '');
if (!PM || !AN) { console.error('环境错误：boot 未拿到令牌'); process.exit(2); }
run(['lessons', 'read', '--boot', PM, '--project', PROJECT, '--json']);

// ── A1 三条未读消息（直接落「邮箱/analyst/new」，绕开投递自动已读，保证是未读现场）
// 说明：走 send 时沙盘投递会写 deliveredAt 并按「成功自动已读」把消息挪进 cur + readAt，
// mark-all-read 的盘点前提（!readAt）就不成立了；夹具要的是「积压未读」，所以直接造未读件。
const mailNew = path.join(TEAM, '状态', '邮箱', 'analyst', 'new');
fs.mkdirSync(mailNew, { recursive: true });
const sent = [];
const bodies = [];
for (let i = 1; i <= 3; i += 1) {
  const body = `8fc2 审计夹具正文 ${i}（这句话不得进审计行）`;
  bodies.push(body);
  const id = `M-20261118-0140${i}0-8fc2${i}`;
  const ts = new Date(Date.now() - (4 - i) * 60000).toISOString();
  fs.writeFileSync(path.join(mailNew, `${ts.replace(/[:.]/g, '-')}-${id}.json`), JSON.stringify({
    id, from: 'pm', to: 'analyst', subject: `8fc2 消息 ${i}`, body, project: PROJECT,
    task: '', ackRequired: false, type: 'notice', replyTo: '', recipientSessionId: '', ts,
  }, null, 2) + '\n', 'utf8');
  sent.push(id);
}
const inboxBefore = runJson(['inbox', '--boot', AN, '--project', PROJECT, '--all', '--json']);
const unreadBefore = ((inboxBefore.json && inboxBefore.json.messages) || []).filter((m) => !m.readAt);
check('A1 3 条 pm→analyst 未读消息已就位（邮箱 new/ 三件、inbox 全读可见且 readAt 空）',
  unreadBefore.length >= 3 && sent.every((id) => unreadBefore.some((m) => m.id === id)),
  { sent, unread: unreadBefore.length });

// ── A2 mark-all-read
const mark = runJson(['inbox', '--boot', AN, '--project', PROJECT, '--mark-all-read', '--json']);
const ids = (mark.json && mark.json.messageIds) || [];
check('A2 mark-all-read 返回 messageIds，且覆盖本轮 3 个 id',
  mark.code === 0 && mark.json && mark.json.ok === true && Number(mark.json.marked) >= 3
  && sent.every((id) => ids.includes(id)),
  { code: mark.code, marked: mark.json && mark.json.marked, ids });

// ── A3 阅读.jsonl 审计行
const readsFile = path.join(TEAM, '状态', '阅读.jsonl');
const readRows = readJsonl(readsFile).filter((r) => r.kind === 'mark-all-read');
const lastRow = readRows[readRows.length - 1] || null;
const rowIds = (lastRow && lastRow.messageIds) || [];
const cleared = (lastRow && lastRow.cleared) || [];
check('A3 阅读.jsonl 的 mark-all-read 行落 messageIds（含 3 个 id）+ cleared[{id,from,subject}]',
  Boolean(lastRow) && sent.every((id) => rowIds.includes(id))
  && cleared.length === rowIds.length
  && sent.every((id) => cleared.some((c) => c.id === id && c.from === 'pm' && String(c.subject || '').includes('8fc2 消息'))),
  { row: lastRow && { marked: lastRow.marked, ids: rowIds, clearedCount: cleared.length } });

// ── A4 事件流
const eventsFile = path.join(TEAM, '状态', '事件.jsonl');
const evs = readJsonl(eventsFile).filter((e) => e.action === 'inbox_mark_all_read');
const lastEv = evs[evs.length - 1] || null;
const evIds = (lastEv && lastEv.data && lastEv.data.messageIds) || [];
check('A4 事件流 inbox_mark_all_read 带 data.messageIds（同一集合）',
  Boolean(lastEv) && sent.every((id) => evIds.includes(id)), { evIds, at: lastEv && lastEv.at });

// ── A5 审计不搬正文
const rowText = JSON.stringify(lastRow || {});
const leaks = bodies.filter((b) => rowText.includes(b));
const hasBodyField = cleared.some((c) => Object.prototype.hasOwnProperty.call(c, 'body') || Object.prototype.hasOwnProperty.call(c, 'text'));
check('A5 审计行不搬正文（无 body/text 字段、正文串 0 命中）', leaks.length === 0 && hasBodyField === false,
  { leaks, hasBodyField });

// ── A6 清空后 unread=0 + 幂等
const inboxAfter = runJson(['inbox', '--boot', AN, '--project', PROJECT, '--all', '--json']);
const unreadAfter = ((inboxAfter.json && inboxAfter.json.messages) || []).filter((m) => !m.readAt);
const again = runJson(['inbox', '--boot', AN, '--project', PROJECT, '--mark-all-read', '--json']);
const againIds = (again.json && again.json.messageIds) || [];
check('A6 清完后 unread=0；重复 mark-all-read 幂等（marked=0、messageIds 空）',
  unreadAfter.length === 0 && Number(again.json && again.json.marked) === 0 && againIds.length === 0,
  { unreadAfter: unreadAfter.length, againMarked: again.json && again.json.marked, againIds });

const total = passed + failures.length;
const outFile = process.env.AWB_8FC2_OUT
  ? (path.isAbsolute(process.env.AWB_8FC2_OUT) ? process.env.AWB_8FC2_OUT : path.join(ROOT, process.env.AWB_8FC2_OUT))
  : path.join(ROOT, '_tmp', 'run-8fc2.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({ task: 'B-20261117-013448-8fc2', at: new Date().toISOString(), total, pass: passed, red: failures.length, failures }, null, 2) + '\n', 'utf8');
console.log(`\nMARK_ALL_AUDIT ${JSON.stringify({ total, pass: passed, red: failures.length })}`);
console.log('证据：' + outFile);
process.exit(failures.length ? 1 : 0);
