'use strict';
/**
 * B-20261116-062204-89c6 断言：PM 问 Owner 必须走 owner_ask（消息通道强制）+ 审计 + 反向不误拦。
 * 沙盘：复制真实 团队 -> _tmp/89c6/团队（清 sessionId、去锁/邮箱），TEAM_SELFTEST=1。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TEAM_MJS = path.join(ROOT, '团队', '工具', 'team.mjs');
const SB = path.join(ROOT, '_tmp', '89c6');
const TEAM = path.join(SB, '团队');
const PROJECT = '工作台改造修复';
const STATE = path.join(TEAM, '状态', '项目', PROJECT);
const OWNER_MAIL = path.join(TEAM, '状态', '邮箱', 'owner');
const AUDIT = path.join(STATE, '决策收口.jsonl');
const BOX = path.join(STATE, '决策箱.json');

let pass = 0; let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}  ${JSON.stringify(detail).slice(0, 300)}`); process.exitCode = 1; }
}
function env() { return { ...process.env, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: path.join(TEAM, '状态', '项目'), TEAM_SELFTEST: '1', AWB_DECISION_MISS_MINUTES: '0' }; }
function run(args) {
  try { return { code: 0, out: execFileSync(process.execPath, [TEAM_MJS, ...args], { env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status == null ? -1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
}
function inboxCount() {
  try { return fs.readdirSync(path.join(OWNER_MAIL, 'new')).filter((f) => f.endsWith('.json')).length; } catch { return 0; }
}
function auditRows() { try { return fs.readFileSync(AUDIT, 'utf8').split(/\r?\n/).filter(Boolean).map(JSON.parse); } catch { return []; } }

fs.rmSync(SB, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
fs.cpSync(path.join(ROOT, '团队'), TEAM, { recursive: true, filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) && !/[\\/]邮箱[\\/]/.test(src) });
const team = JSON.parse(fs.readFileSync(path.join(TEAM, '状态', '团队.json'), 'utf8'));
for (const m of team.members || []) m.sessionId = '';
team.activeProject = PROJECT;
fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
fs.mkdirSync(path.join(OWNER_MAIL, 'new'), { recursive: true });
fs.mkdirSync(path.join(OWNER_MAIL, 'cur'), { recursive: true });

const pmBoot = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'pm-test']);
const pmToken = (pmBoot.out.match(/令牌[:：]\s*([a-f0-9]+)/i) || [])[1] || '';
const testerBoot = run(['boot', '--role', 'tester', '--project', PROJECT, '--session', 'tester-test']);
const testerToken = (testerBoot.out.match(/令牌[:：]\s*([a-f0-9]+)/i) || [])[1] || '';
ok('沙盘 boot pm/tester', Boolean(pmToken && testerToken), { pm: pmToken.slice(0, 8), tester: testerToken.slice(0, 8) });

const before = inboxCount();
const r1 = run(['send', '--project', PROJECT, '--boot', pmToken, '--to', 'owner', '--subject', '口径要不要改？', '--body', '失败 2 项 的口径要不要改？']);
ok('AC1 PM 未标 owner_ask 问 Owner → 拒 OWNER_ASK_REQUIRES_TYPE', r1.code !== 0 && /OWNER_ASK_REQUIRES_TYPE/.test(r1.out), r1.out.slice(0, 200));
ok('AC1 零写入：owner 邮箱条数不变', inboxCount() === before, { before, after: inboxCount() });
ok('AC6 被拒写 rejected_type 审计行', auditRows().some((row) => row.action === 'rejected_type' && row.code === 'OWNER_ASK_REQUIRES_TYPE'), auditRows().slice(-2));

const testerMail = path.join(TEAM, '状态', '邮箱', 'tester');
const countTester = () => { try { let n = 0; for (const sub of ['new', 'cur']) { const d = path.join(testerMail, sub); if (fs.existsSync(d)) n += fs.readdirSync(d).filter((f) => f.endsWith('.json')).length; } return n; } catch { return 0; } };
const testerBefore = countTester();
const r2 = run(['send', '--project', PROJECT, '--boot', pmToken, '--to', 'tester', '--subject', '问 Owner：口径要不要改？', '--body', '失败 2 项 的口径要不要改？', '--type', 'owner_ask']);
ok('AC2 --type owner_ask 正常投递', r2.code === 0, r2.out.slice(0, 200));
const testerAfter = countTester();
ok('AC2 owner_ask 投递到收件人邮箱（+1）', testerAfter === testerBefore + 1, { testerBefore, testerAfter });
const r3 = run(['decision', 'miss', '--project', PROJECT, '--boot', pmToken]);
ok('AC2 漏箱扫描执行成功', r3.code === 0, r3.out.slice(0, 200));
const box = (() => { try { return JSON.parse(fs.readFileSync(BOX, 'utf8')); } catch { return null; } })();
const missItems = ((box && box.items) || []).filter((row) => row && row.missBox === true);
ok('AC2 owner_ask 自动入箱（missBox 占位）', missItems.length >= 1, { misses: missItems.length, boxItems: (box && box.items || []).length });

const r4 = run(['send', '--project', PROJECT, '--boot', testerToken, '--to', 'pm', '--subject', '提问', '--body', '要不要补一条断言？']);
ok('AC3 反向：非 PM 角色不被这条拦', r4.code === 0, r4.out.slice(0, 200));
const r5 = run(['send', '--project', PROJECT, '--boot', pmToken, '--to', 'tester', '--subject', '示例说明', '--body', '注意：要不要只是举例说明，不构成问句']);
ok('AC3 反向：PM 正常说明含「要不要」但不带问号 → 不误拦', r5.code === 0, r5.out.slice(0, 200));

console.log(`\nB-89c6 断言：${pass} 通过 / ${fail} 失败`);
fs.mkdirSync(path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-89c6'), { recursive: true });
fs.writeFileSync(path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-89c6', 'run-89c6.log'), `pass=${pass} fail=${fail}\n`, 'utf8');
