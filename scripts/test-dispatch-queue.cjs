#!/usr/bin/env node
const { rmSandbox, uniqueSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/**
 * B-20261115-143112-bbf6（P1）断言：派单队列「吞单」三件套
 *   ① 锁/占用解除后 60 秒内必投递（泵一次即达）；② 滞留 >5 分钟向 PM escalation（10 分钟去重）；
 *   ③ 换人后旧会话队列项改投新会话或作废并留审计；④ 队列空时无副作用。
 *
 * 跑法：node scripts/test-dispatch-queue.cjs
 * 环境：自建沙盘 项目/工作台改造修复/_tmp/dispatch-queue-sandbox（TEAM_ROOT + TEAM_PROJECTS_ROOT + TEAM_SELFTEST=1），
 *       不碰真实团队邮箱与真实项目数据。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const TEAM_MJS = path.join(REPO, '团队', '工具', 'team.mjs');
const SANDBOX = uniqueSandbox('dispatch-queue-sandbox', { root: path.join(REPO, '项目', '工作台改造修复') }); // B-07b6 B：唯一沙盘（并发安全）
const TEAM_ROOT = path.join(SANDBOX, '团队');
const PROJECTS_ROOT = path.join(SANDBOX, '项目');
const PROJECT = '队列沙盘';
const STATE = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
const QUEUE = path.join(STATE, '派单队列.json');
const QUEUE_ARCHIVE = path.join(STATE, '派单队列归档.jsonl');
const EVENTS = path.join(TEAM_ROOT, '状态', '事件.jsonl');
const MAIL = path.join(TEAM_ROOT, '状态', '邮箱');

let pass = 0; let fail = 0;
const failures = []; const results = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; results.push({ name, ok: true }); }
  else { fail += 1; failures.push({ name, detail: String(detail).replace(/\s+/g, ' ').slice(0, 240) }); results.push({ name, ok: false, detail }); }
}
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n', 'utf8'); };
function env() { return { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS_ROOT, TEAM_SELFTEST: '1' }; }
function run(args) {
  try { return { code: 0, stdout: execFileSync(process.execPath, [TEAM_MJS, ...args], { env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status == null ? -1 : e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }; }
}
function runJson(args) { const r = run([...args, '--json']); let j = null; try { j = JSON.parse(r.stdout); } catch { j = null; } return { ...r, json: j }; }
function events() { try { return fs.readFileSync(EVENTS, 'utf8').split(/\r?\n/).filter(Boolean).map((s) => JSON.parse(s)); } catch { return []; } }
function mailOf(role) {
  const out = [];
  for (const box of ['new', 'cur']) {
    const dir = path.join(MAIL, role, box);
    let names = [];
    try { names = fs.readdirSync(dir); } catch { continue; }
    for (const n of names) { const m = readJson(path.join(dir, n)); if (m) out.push(m); }
  }
  return out;
}
const queueItems = () => (readJson(QUEUE, { items: [] }).items || []);
function item(over = {}) {
  return { id: `Q-test-${Math.random().toString(16).slice(2, 8)}`, at: new Date().toISOString(), from: 'pm', to: 'programmer1', subject: '测试派单：队列吞单复现', body: '这是队列项正文，用来复现「队列挂着不投递」', task: '', sessionId: 'session-pm-live', ...over };
}

// ---------- 沙盘 ----------
rmSandbox(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, '团队'), { recursive: true });
fs.mkdirSync(path.join(SANDBOX, '项目'), { recursive: true });
ok('沙盘 init', /团队已初始化/.test(run(['init']).stdout));
ok('沙盘项目建立', /项目已建/.test(run(['project', 'add', '--name', PROJECT, '--team-mode', 'full']).stdout));
// 名册：给 pm / programmer1 配活会话（沙盘才有的固定串，和真实会话无关）
const teamFile = path.join(TEAM_ROOT, '状态', '团队.json');
const team = readJson(teamFile, { members: [] });
for (const m of team.members || []) {
  if (m.role === 'pm') { m.sessionId = 'session-pm-live'; m.status = 'active'; }
  if (m.role === 'programmer1') { m.sessionId = 'session-dev1-live'; m.status = 'active'; }
}
writeJson(teamFile, team);
const bootOut = run(['boot', '--role', 'pm', '--project', PROJECT]);
const tm = /令牌:\s*([0-9a-f]{24})/.exec(bootOut.stdout);
const pmToken = tm ? tm[1] : '';
ok('pm boot 拿到令牌', Boolean(pmToken), bootOut.stdout.slice(0, 120));

// ---------- T6 队列空：无副作用 ----------
const empty = runJson(['queue', 'pump', '--project', PROJECT]);
ok('队列空 → pumped=false / EMPTY', empty.code === 0 && empty.json && empty.json.pumped === false && String(empty.json.reason) === 'EMPTY', JSON.stringify(empty.json && empty.json.reason));
ok('队列空 → 不产生 escalation', mailOf('pm').filter((m) => m.type === 'escalation').length === 0, String(mailOf('pm').length));

// ---------- T2 滞留 >5 分钟 + 角色忙 → escalation（10 分钟去重）----------
writeJson(QUEUE, { items: [item({ id: 'Q-stale-1', at: new Date(Date.now() - 6 * 60 * 1000).toISOString() })], updatedAt: new Date().toISOString() });
const busy = runJson(['task', 'create', '--boot', pmToken, '--title', '占住 programmer1', '--priority', 'P2', '--type', 'task', '--owner', 'programmer1']);
ok('造一条 working 任务占住目标角色', Boolean(busy.json && busy.json.task && busy.json.task.status === 'working'), JSON.stringify(busy.json && busy.json.task && busy.json.task.status));
const pumpBlocked = runJson(['queue', 'pump', '--project', PROJECT]);
ok('角色忙 → 不投递（blocked）', pumpBlocked.code === 0 && pumpBlocked.json && pumpBlocked.json.pumped === false, JSON.stringify(pumpBlocked.json && { p: pumpBlocked.json.pumped, r: pumpBlocked.json.reason }));
const esc1 = mailOf('pm').filter((m) => m.type === 'escalation' && /派单队列滞留/.test(String(m.subject || '')));
ok('滞留 >5 分钟 → PM 收到 escalation（含滞留分钟）', esc1.length === 1 && /\d+ 分钟/.test(String(esc1[0].subject)), JSON.stringify(esc1.map((m) => m.subject)));
ok('escalation 正文带队列项/目标角色', /Q-stale-1/.test(String(esc1[0] && esc1[0].body)) && /programmer1/.test(String(esc1[0] && esc1[0].body)), String(esc1[0] && esc1[0].body).slice(0, 120));
ok('审计写 dispatch_queue_stale_alert', events().some((e) => e.action === 'dispatch_queue_stale_alert' && String(e.target) === 'Q-stale-1'), '缺事件');
run(['queue', 'pump', '--project', PROJECT]);
ok('10 分钟内重复泵 → 不重复告警', mailOf('pm').filter((m) => m.type === 'escalation' && /派单队列滞留/.test(String(m.subject || ''))).length === 1, '重复告警');

// ---------- T1/T3 占用解除 → 一次泵即达（60 秒内必达）----------
const tasksDir = path.join(STATE, '任务');
const taskFile = fs.readdirSync(tasksDir).map((n) => path.join(tasksDir, n)).find((f) => readJson(f, {}).owner === 'programmer1');
const t = readJson(taskFile, {});
t.status = 'done'; t.doneAt = new Date().toISOString();
writeJson(taskFile, t);
const pump2 = runJson(['queue', 'pump', '--project', PROJECT]);
ok('占用解除 → 队列项被投递', pump2.code === 0 && pump2.json && pump2.json.pumped === true, JSON.stringify(pump2.json && { p: pump2.json.pumped, r: pump2.json.reason }));
ok('投递后队列清空', queueItems().length === 0, JSON.stringify(queueItems().map((i) => i.id)));
const devMail = mailOf('programmer1').filter((m) => String(m.subject || '').includes('队列吞单复现'));
ok('目标角色收到派单（含正文）', devMail.length === 1 && String(devMail[0].body).includes('复现「队列挂着不投递」'), JSON.stringify(devMail.map((m) => m.subject)));
ok('投递写派单锁（messageId/to/task）', Boolean(readJson(path.join(STATE, '派单锁.json'), null)), '无锁文件');
ok('审计写 dispatch_pump', events().some((e) => e.action === 'dispatch_pump' && String(e.target) === String(devMail[0] && devMail[0].id)), '缺 dispatch_pump 事件');

// ---------- T4 换人：旧 sessionId → 改投新会话 ----------
writeJson(QUEUE, { items: [item({ id: 'Q-rotate-1', at: new Date().toISOString(), sessionId: 'session-pm-old' })], updatedAt: new Date().toISOString() });
const recon = runJson(['queue', 'reconcile', '--project', PROJECT, '--reason', 'rotate:pm']);
ok('换人后旧会话项 → 改投新会话', recon.code === 0 && recon.json && recon.json.rebased.length === 1 && queueItems()[0].sessionId === 'session-pm-live', JSON.stringify(recon.json && { r: recon.json.rebased, q: queueItems()[0] && queueItems()[0].sessionId }));
ok('审计写 dispatch_queue_session_rebased', events().some((e) => e.action === 'dispatch_queue_session_rebased' && String(e.target) === 'Q-rotate-1'), '缺事件');
// 对齐后泵能投递（不再因旧会话永久悬挂）
const pump3 = runJson(['queue', 'pump', '--project', PROJECT]);
ok('对齐后的项可正常投递', pump3.code === 0 && pump3.json && pump3.json.pumped === true, JSON.stringify(pump3.json && pump3.json.reason));

// ---------- T5 目标角色不在名册 → discarded + 归档 + 审计 ----------
writeJson(QUEUE, { items: [item({ id: 'Q-ghost-1', to: 'tester', at: new Date().toISOString() })], updatedAt: new Date().toISOString() });
const recon2 = runJson(['queue', 'reconcile', '--project', PROJECT, '--reason', 'tester-left']);
ok('目标角色不在名册 → discarded', recon2.code === 0 && recon2.json && recon2.json.discarded.length === 1 && queueItems().length === 0, JSON.stringify(recon2.json && recon2.json.discarded));
const archiveRows = fs.existsSync(QUEUE_ARCHIVE) ? fs.readFileSync(QUEUE_ARCHIVE, 'utf8').split(/\r?\n/).filter(Boolean).map((s) => JSON.parse(s)) : [];
ok('作废项整条落 派单队列归档.jsonl（可回滚）', archiveRows.some((r) => r.action === 'discard' && r.item && r.item.id === 'Q-ghost-1'), `归档 ${archiveRows.length} 行`);
ok('审计写 dispatch_queue_discarded', events().some((e) => e.action === 'dispatch_queue_discarded' && String(e.target) === 'Q-ghost-1'), '缺事件');

// ---------- 报告 ----------
const report = { at: new Date().toISOString(), task: 'B-20261115-143112-bbf6', pass, fail, failures, results };
const outFile = path.join(REPO, '项目', '工作台改造修复', '_tmp', 'dispatch-queue-run.json');
fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`\n=== B-bbf6 派单队列断言：${pass} 通过 / ${fail} 失败 ===`);
for (const f of failures) console.log(`✗ ${f.name}  ${f.detail}`);
console.log(`报告：${outFile}`);
process.exit(fail ? 1 : 0);
