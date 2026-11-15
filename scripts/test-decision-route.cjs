#!/usr/bin/env node
/**
 * R-20261115-121354-5016（P0，工具侧 T-c984）断言：
 *   ① routeOwnerAsk 四规则分流 + ruleId 可复算（AC1/AC2）
 *   ② 七要素缺项拒收、零副作用（AC3）
 *   ③ guard 转投：保留原码 + redirect + 决策收口.jsonl 审计；COPY_CODE_NAME 不转投不写审计（AC5）
 *   ④ 漏箱检测 D-…-MISS + 日报（AC6）
 *   ⑤ ownerPendingCounts 三入口同源互斥（AC7）
 *   ⑥ 历史零迁移（AC8）
 *
 * 跑法：node scripts/test-decision-route.cjs
 * 环境：自建沙盘 项目/工作台改造修复/_tmp/decision-route-sandbox（TEAM_ROOT + TEAM_PROJECTS_ROOT + TEAM_SELFTEST=1）。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const TEAM_MJS = path.join(REPO, '团队', '工具', 'team.mjs');
const SANDBOX = path.join(REPO, '项目', '工作台改造修复', '_tmp', 'decision-route-sandbox');
const TEAM_ROOT = path.join(SANDBOX, '团队');
const PROJECTS_ROOT = path.join(SANDBOX, '项目');
const PROJECT = '收口沙盘';
const STATE = path.join(TEAM_ROOT, '状态', '项目', PROJECT);
const BOX = path.join(STATE, '决策箱.json');
const AUDIT = path.join(STATE, '决策收口.jsonl');
const WF = path.join(STATE, '工作流.json');

let pass = 0; let fail = 0;
const failures = []; const results = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; results.push({ name, ok: true }); }
  else { fail += 1; failures.push({ name, detail: String(detail).replace(/\s+/g, ' ').slice(0, 240) }); results.push({ name, ok: false, detail }); }
}
const readJson = (f, d = null) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, o) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2) + '\n', 'utf8'); };
const auditRows = () => (fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, 'utf8').split(/\r?\n/).filter(Boolean).map((s) => JSON.parse(s)) : []);
const boxItems = () => ((readJson(BOX, { items: [] }).items) || []);
function env(extra = {}) { return { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS_ROOT, TEAM_SELFTEST: '1', ...extra }; }
function run(args, extra = {}) {
  try { return { code: 0, stdout: execFileSync(process.execPath, [TEAM_MJS, ...args], { env: env(extra), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) }; }
  catch (e) { return { code: e.status == null ? -1 : e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') }; }
}
function runJson(args, extra = {}) { const r = run([...args, '--json'], extra); let j = null; try { j = JSON.parse(r.stdout); } catch { j = null; } return { ...r, json: j }; }

// ---------- 沙盘 ----------
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, '团队'), { recursive: true });
fs.mkdirSync(path.join(SANDBOX, '项目'), { recursive: true });
ok('沙盘 init', /团队已初始化/.test(run(['init']).stdout));
ok('沙盘项目建立', /项目已建/.test(run(['project', 'add', '--name', PROJECT, '--team-mode', 'full']).stdout));
const boot = () => { const m = /令牌:\s*([0-9a-f]{24})/.exec(run(['boot', '--role', 'pm', '--project', PROJECT]).stdout); return m ? m[1] : ''; };
const pmToken = boot();
ok('pm boot 拿到令牌', Boolean(pmToken));
// 工作流夹具：一条 test_done（待验收）+ 两条评审未决（ownerReview pending）
const now = new Date().toISOString();
const WF_FIXTURE = {
  schema: 2, project: PROJECT, round: 1, phase: 'owner_review', events: [],
  requirements: {
    'R-20261115-160000-aaaa': { id: 'R-20261115-160000-aaaa', title: '待验收夹具', status: 'test_done', round: 1, ownerReview: { status: 'pending' }, createdAt: now, updatedAt: now, priority: 'P1' },
    'R-20261115-160001-bbbb': { id: 'R-20261115-160001-bbbb', title: '评审未决A', status: 'approved', round: 1, ownerReview: { status: 'pending' }, createdAt: now, updatedAt: now, priority: 'P1' },
    'R-20261115-160002-cccc': { id: 'R-20261115-160002-cccc', title: '评审未决B', status: 'owner_review', round: 1, ownerReview: { status: 'pending' }, createdAt: now, updatedAt: now, priority: 'P1' },
  },
};
writeJson(WF, WF_FIXTURE);

// ---------- AC1/AC2 四类分流 + 规则可复算（用子进程 import 纯函数，CJS 里不能顶层 await）----------
function routeCases(payload) {
  const script = `
import { routeOwnerAsk } from ${JSON.stringify(require('node:url').pathToFileURL(path.join(REPO, '团队', '工具', 'lib', 'decision-route.mjs')).href)};
const asks = ${JSON.stringify(payload)};
const out = asks.map((a) => { const r = routeOwnerAsk(a); return { target: r.target, ruleId: r.ruleId }; });
console.log(JSON.stringify(out));
`;
  const stdout = execFileSync(process.execPath, ['--input-type=module', '-e', script], { encoding: 'utf8' });
  return JSON.parse(stdout.trim().split(/\r?\n/).pop());
}
const cases = [
  ['取舍类 → decision_box', { kind: '取舍', question: '这批要不要回滚' }, 'decision_box', 'R-DECISION-KIND'],
  ['代点通过 → review_dialog', { question: '我替他点通过可以吗' }, 'review_dialog', 'R-REVIEW-INTENT'],
  ['test_done 确认 → accept_list', { requirementStatus: 'test_done', action: '验收', question: '这条能确认吗' }, 'accept_list', 'R-ACCEPT-STATE'],
  ['无匹配 → decision_box', { question: '下周排期放哪天合适' }, 'decision_box', 'R-DEFAULT'],
];
const routed = routeCases(cases.map(([, ask]) => ask));
cases.forEach(([label, , target, ruleId], i) => {
  ok(`AC1 ${label}`, routed[i] && routed[i].target === target && routed[i].ruleId === ruleId, JSON.stringify(routed[i]));
});
// AC2 稳定 + 可复算
const ten = routeCases(Array.from({ length: 10 }, () => ({ kind: '取舍', question: '继续还是停' })));
ok('AC2 同一 ask 调 10 次结果稳定', new Set(ten.map((x) => JSON.stringify(x))).size === 1, `${new Set(ten.map((x) => JSON.stringify(x))).size} 种结果`);
const changed = routeCases([{ kind: '取舍', question: '这个要不要通过' }, { kind: '取舍', question: '继续还是停', requirementStatus: 'test_done', action: '确认' }]);
ok('AC2 改意图词 → target 变', changed[0] && changed[0].target === 'review_dialog', JSON.stringify(changed[0]));
ok('AC2 改需求状态 → target 变', changed[1] && changed[1].target === 'accept_list', JSON.stringify(changed[1]));
const cliSrc = fs.readFileSync(path.join(REPO, '团队', '工具', 'lib', 'decision-cli.mjs'), 'utf8');
ok('AC2 入箱 CLI 无 --target/--to 入口', /DECISION_TARGET_FORBIDDEN/.test(cliSrc) && /args\.target !== undefined/.test(cliSrc), '缺拦截');

// ---------- AC3 七要素缺项拒收（零副作用）----------
const full = {
  'source-kind': 'message', 'source-ref': 'M-20261115-000000-test01', summary: '背景一句话', question: '选哪个方案',
  options: 'A,B', default: 'A', impact: 'Owner', due: '2026-11-17T00:00:00Z',
};
const beforeCount = boxItems().length;
let missingOk = 0;
for (const key of ['source-kind', 'summary', 'question', 'options', 'default', 'impact', 'due']) {
  const args = { ...full }; delete args[key];
  const argv = ['decision', 'add', '--boot', pmToken, '--project', PROJECT, '--title', '缺项夹具'];
  for (const [k, v] of Object.entries(args)) argv.push('--' + k, v);
  const r = runJson(argv);
  const miss = r.json && String(r.json.code) === 'DECISION_FIELDS_INCOMPLETE';
  if (miss) missingOk += 1; else failures.push({ name: `AC3 缺 ${key}`, detail: String(r.json && r.json.code) + String(r.stderr || '').slice(0, 60) });
}
ok('AC3 七要素逐一缺失均 DECISION_FIELDS_INCOMPLETE', missingOk === 7, `${missingOk}/7`);
ok('AC3 缺项零副作用（决策箱条目数不变）', boxItems().length === beforeCount, `${beforeCount}→${boxItems().length}`);

// ---------- 正例：七要素齐 → 入箱 + route 审计 ----------
const addRes = runJson(['decision', 'add', '--boot', pmToken, '--project', PROJECT, '--title', '取舍：这批要不要回滚', '--kind', '取舍', '--source-kind', 'message', '--source-ref', 'M-20261115-000000-test02', '--summary', '背景：线上刚回滚过一版', '--question', '继续还是停', '--options', '继续,停,观察一天', '--default', '观察一天', '--impact', 'Owner 与测试', '--due', '2026-11-17T00:00:00Z']);
ok('正例：七要素齐 → 入箱成功', addRes.code === 0 && addRes.json && addRes.json.ok === true && addRes.json.target === 'decision_box', JSON.stringify(addRes.json && { c: addRes.json.code, t: addRes.json.target }));
const item = boxItems().find((row) => row.id === (addRes.json && addRes.json.item && addRes.json.item.id));
ok('F-4 入箱新增字段齐全', Boolean(item && item.impact && item.dueAt && item.defaultChoice && item.ruleId && item.origin && item.missBox === false), JSON.stringify(item && { i: item.impact, d: item.dueAt, dc: item.defaultChoice, r: item.ruleId }));
ok('F-10 route 审计一行（9 键）', (() => { const rows = auditRows().filter((r) => r.action === 'route' && r.askId === (item && item.id)); return rows.length === 1 && Object.keys(rows[0]).length === 9; })(), JSON.stringify(auditRows().length));

// ---------- AC5 guard 转投 ----------
const guardBefore = auditRows().length;
const reviewRes = runJson(['decision', 'add', '--boot', pmToken, '--project', PROJECT, '--title', '这条评审能不能通过', '--kind', '取舍', '--source-kind', 'message', '--source-ref', 'M-20261115-000000-test03', '--summary', '背景', '--question', '要打回吗', '--options', 'A,B', '--default', 'A', '--impact', 'Owner', '--due', '2026-11-17T00:00:00Z']);
const reviewDetails = (reviewRes.json && reviewRes.json.details) || {};
ok('AC5 评审动作 → 原码 DECISION_REVIEW_ACTION_FORBIDDEN 保留', String(reviewRes.json && reviewRes.json.code) === 'DECISION_REVIEW_ACTION_FORBIDDEN', JSON.stringify(reviewRes.json && reviewRes.json.code));
ok('AC5 带 redirect.to=review_dialog + anchor', Boolean(reviewDetails.redirect && reviewDetails.redirect.to === 'review_dialog' && reviewDetails.redirect.anchor === '#owner-review'), JSON.stringify(reviewDetails.redirect));
const redirectRows = auditRows().filter((r) => r.action === 'redirect');
ok('AC5 转投写 决策收口.jsonl action=redirect（含原码）', redirectRows.some((r) => r.code === 'DECISION_REVIEW_ACTION_FORBIDDEN' && r.target === 'review_dialog'), JSON.stringify(redirectRows.map((r) => r.code)));
// 范围类：来源需求未收口
const scopeRes = runJson(['decision', 'add', '--boot', pmToken, '--project', PROJECT, '--title', '复盘：某需求', '--kind', '口径', '--source-kind', 'requirement', '--source-ref', 'R-20261115-160001-bbbb', '--summary', '背景', '--question', '这个口径怎么定', '--options', 'A,B', '--default', 'A', '--impact', 'Owner', '--due', '2026-11-17T00:00:00Z']);
ok('AC5 范围类 → DECISION_SCOPE_FORBIDDEN + redirect', String(scopeRes.json && scopeRes.json.code) === 'DECISION_SCOPE_FORBIDDEN' && Boolean(scopeRes.json && scopeRes.json.details && scopeRes.json.details.redirect), JSON.stringify(scopeRes.json && scopeRes.json.code));
// 命名冲突：不转投、不写审计
const auditBeforeCopy = auditRows().length;
const copyRes = runJson(['decision', 'add', '--boot', pmToken, '--project', PROJECT, '--title', 'R-20261114-141252-e717 复盘', '--kind', '口径', '--source-kind', 'message', '--source-ref', 'M-20261115-000000-test04', '--summary', '背景', '--question', '口径怎么定', '--options', 'A,B', '--default', 'A', '--impact', 'Owner', '--due', '2026-11-17T00:00:00Z']);
ok('AC5 命名冲突 → DECISION_COPY_CODE_NAME 且无 redirect', String(copyRes.json && copyRes.json.code) === 'DECISION_COPY_CODE_NAME' && !(copyRes.json && copyRes.json.details && copyRes.json.details.redirect), JSON.stringify(copyRes.json && copyRes.json.code));
ok('AC5 命名冲突不写 redirect/reject 审计行', auditRows().length === auditBeforeCopy, `${auditBeforeCopy}→${auditRows().length}`);
ok('AC5 已转投的提示语含「已转投到」', /已转投到/.test(String(reviewRes.json && reviewRes.json.message)), String(reviewRes.json && reviewRes.json.message).slice(0, 80));

// ---------- AC7 三入口同源互斥 ----------
// 再塞 2 条 open（让决策箱 open = 3）
for (const n of [1, 2]) {
  run(['decision', 'add', '--boot', pmToken, '--project', PROJECT, '--title', `口径：第${n}条`, '--kind', '口径', '--source-kind', 'message', '--source-ref', `M-20261115-000000-x0${n}`, '--summary', '背景', '--questions', 'x', '--question', '问题', '--options', 'A,B', '--default', 'A', '--impact', 'Owner', '--due', '2026-11-17T00:00:00Z']);
}
const counts = runJson(['decision', 'counts', '--project', PROJECT]);
const boxOpen = boxItems().filter((r) => String(r.status) === 'open').length;
ok('AC7 counts 决策箱数 == 决策箱 open 条目数', Boolean(counts.json && counts.json.decisions === boxOpen), JSON.stringify(counts.json && { d: counts.json.decisions, open: boxOpen }));
ok('AC7 评审待评估 = 2（两条 ownerReview=pending）', Boolean(counts.json && counts.json.reviews === 2), JSON.stringify(counts.json && counts.json.reviews));
ok('AC7 待验收 = 1（test_done 未验收）', Boolean(counts.json && counts.json.accepts === 1), JSON.stringify(counts.json && counts.json.accepts));
ok('AC7 三桶互斥（test_done 那条不计进 reviews）', Boolean(counts.json && counts.json.reviews === 2 && counts.json.accepts === 1));
ok('AC7 返回界面锚点契约', Boolean(counts.json && counts.json.anchor && counts.json.anchor.accepts === '#accept-badge[data-count]'), JSON.stringify(counts.json && counts.json.anchor));

// ---------- AC6 漏箱检测 + 日报 ----------
const missMinutes = 30;
// 造一条 PM 发出的 owner_ask 消息（PM 2026-11-15 有条件确认①：漏箱只认登记类型 owner_ask，不看标题），再改成 2 小时前
const sent = run(['send', '--boot', pmToken, '--to', 'programmer1', '--subject', '拍板：这批要不要回滚', '--body', '要不要现在回滚，还是观察一天？请你拍板', '--type', 'owner_ask']);
ok('造 1 条 PM owner_ask 消息（类型已登记）', sent.code === 0, (sent.stderr || sent.stdout).slice(0, 120));
// 反例：标题写「拍板」但类型是 notice → 不得计入（不再靠标题猜）
const decoy = run(['send', '--boot', pmToken, '--to', 'programmer1', '--subject', '拍板：仅标题有拍板字样的通知', '--body', '要不要都不重要，这只是个通知', '--type', 'notice']);
ok('造 1 条标题含「拍板」但 type=notice 的反例', decoy.code === 0, (decoy.stderr || decoy.stdout).slice(0, 120));
const mailDirs = ['new', 'cur'].map((box) => path.join(TEAM_ROOT, '状态', '邮箱', 'programmer1', box));
const mailFiles = mailDirs.flatMap((dir) => (fs.existsSync(dir) ? fs.readdirSync(dir).map((n) => path.join(dir, n)) : []));
let msgFile = null;
for (const f of mailFiles) { const m = readJson(f, {}); if (m && String(m.subject || '').includes('要不要回滚')) { msgFile = f; break; } }
ok('找到刚发的拍板问句消息文件', Boolean(msgFile), `候选 ${mailFiles.length} 个`);
if (msgFile) {
  const m = readJson(msgFile, {});
  m.ts = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
  writeJson(msgFile, m);
}
const missRes = runJson(['decision', 'miss', '--project', PROJECT, '--now', new Date().toISOString(), '--minutes', String(missMinutes)]);
ok('AC6/P0① 漏箱判据写明（criterion=message.type=owner_ask）', Boolean(missRes.json && /owner_ask/.test(String(missRes.json.criterion))), JSON.stringify(missRes.json && missRes.json.criterion));
ok('AC6/P0① 反例（标题含拍板但 type=notice）不计入候选', Boolean(missRes.json && missRes.json.candidates === 1), JSON.stringify(missRes.json && missRes.json.candidates));
// PM 15:35 裁决条件①：观察清单（未标类型但像拍板）——列出来、不计漏箱、不补录
ok('观察清单：未标类型的 PM 消息进 observation（count=1）', Boolean(missRes.json && missRes.json.observation && missRes.json.observation.count === 1), JSON.stringify(missRes.json && missRes.json.observation && missRes.json.observation.count));
ok('观察清单条目带 messageId + 标题前 40 字', Boolean(missRes.json && (missRes.json.observation.items || []).some((x) => /^M-\d{8}-\d{6}-[0-9a-f]+$/.test(String(x.messageId)) && String(x.subject).length <= 40)), JSON.stringify(missRes.json && missRes.json.observation.items && missRes.json.observation.items[0]));
ok('观察清单不计入漏箱（totalMiss 仍为 1，仅 MISS 占位）', Boolean(missRes.json && missRes.json.totalMiss === 1), JSON.stringify(missRes.json && missRes.json.totalMiss));
const missItem = boxItems().find((row) => row.missBox === true);
ok('AC6 漏箱 → 生成 D-…-MISS 占位', Boolean(missItem && /-MISS$/.test(String(missItem.id)) && missItem.status === 'open'), JSON.stringify(missItem && missItem.id));
ok('AC6 占位字段 missBox/ruleId/source', Boolean(missItem && missItem.missBox === true && missItem.ruleId === 'R-MISS' && missItem.source && missItem.source.kind === 'message'), JSON.stringify(missItem && { r: missItem.ruleId }));
ok('AC6 miss 审计 action=miss', auditRows().some((r) => r.action === 'miss' && r.code === 'DECISION_MISS'), '缺 miss 审计');
const dateText = new Date().toISOString().slice(0, 10).replace(/-/g, '');
const reportFile = path.join(STATE, `漏箱-${dateText}.md`);
ok('AC6 日报 漏箱-YYYYMMDD.md 存在且计数 ≥1', fs.existsSync(reportFile) && /当日漏箱：1|当日漏箱：\d+/.test(fs.readFileSync(reportFile, 'utf8')), reportFile);
const missRes2 = runJson(['decision', 'miss', '--project', PROJECT, '--now', new Date().toISOString(), '--minutes', String(missMinutes)]);
ok('AC6 幂等：重复扫 → 不再补录', Boolean(missRes2.json && missRes2.json.missed.length === 0), JSON.stringify(missRes2.json && missRes2.json.missed));
ok('AC6 幂等：skip(already_missed)', Boolean(missRes2.json && (missRes2.json.skipped || []).some((x) => x.reason === 'already_missed')), JSON.stringify(missRes2.json && missRes2.json.skipped));

// ---------- AC8 历史零迁移 ----------
// 用工作流夹具里的三条 + 已有决策箱条目做前后对照（本条实现未迁移任何历史条目）
const wfAfter = readJson(WF, { requirements: {} });
const statusesBefore = ['R-20261115-160000-aaaa', 'R-20261115-160001-bbbb', 'R-20261115-160002-cccc'].map((id) => (wfAfter.requirements[id] || {}).status);
ok('AC8 工作流三条历史状态未变', JSON.stringify(statusesBefore) === JSON.stringify(['test_done', 'approved', 'owner_review']), JSON.stringify(statusesBefore));

// ---------- 报告 ----------
const report = { at: new Date().toISOString(), task: 'T-20261115-131211-c984', rule: 'R-5016/v1', pass, fail, failures, results };
const outFile = path.join(REPO, '项目', '工作台改造修复', '_tmp', 'decision-route-run.json');
fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`\n=== R-5016 工具侧断言：${pass} 通过 / ${fail} 失败 ===`);
for (const f of failures) console.log(`✗ ${f.name}  ${f.detail}`);
console.log(`报告：${outFile}`);
process.exit(fail ? 1 : 0);
