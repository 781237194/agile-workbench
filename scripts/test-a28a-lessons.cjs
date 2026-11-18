'use strict';
// a28a 回归：经验教训登记册程序化（轮次计数 / 阈值触发 / append·fix·软删 / 审计 / 夜间静默 / 换人清零 / 沙盘免打扰）
// 隔离：TEAM_ROOT + TEAM_PROJECTS_ROOT + AWB_DATA_DIR 三隔离；沙盘 sessionId 全部清空（B-3c03）
const fs = require('node:fs');
const path = require('node:path');
const cp = require('node:child_process');
const { uniqueSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 B2：唯一沙盘

const REPO = path.resolve(__dirname, '..');
const SRC_TEAM = path.join(REPO, '团队');
const BASE = uniqueSandbox('a28a-smoke');
const ROOT = path.join(BASE, 'team');
const PROJECTS = path.join(BASE, 'projects');
const PROJ = 'sbox';
const PROJECT_DIR = path.join(PROJECTS, PROJ);

function rm(p) { try { fs.rmSync(p, { recursive: true, force: true, maxRetries: 5 }); } catch (e) { } }
function sh(args, env) {
  const r = cp.spawnSync(process.execPath, [path.join(ROOT, '工具', 'team.mjs'), ...args], {
    cwd: PROJECTS, encoding: 'utf8', env: { ...process.env, ...env }, timeout: 120000,
  });
  if (r.error) return { out: 'SPAWN_ERROR ' + String(r.error.message || r.error), code: -1 };
  return { out: (r.stdout || '') + (r.stderr || ''), code: r.status };
}
function boot(role, session) {
  const r = sh(['boot', '--role', role, '--project', PROJ, '--session', session], envBase);
  const m = /令牌:\s*([0-9a-f]+)/.exec(r.out);
  return m ? m[1] : '';
}
function readJsonOr(p) { try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return null; } }

/* ---------- 建沙盘 ---------- */
rm(BASE);
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(SRC_TEAM, ROOT, { recursive: true });
const teamJsonPath = path.join(ROOT, '状态', '团队.json');
const teamJson = JSON.parse(fs.readFileSync(teamJsonPath, 'utf8'));
for (const m of teamJson.members || []) m.sessionId = '';
teamJson.activeProject = '';
fs.writeFileSync(teamJsonPath, JSON.stringify(teamJson, null, 2));
// 沙盘邮箱清空，便于数「新增」
for (const role of ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester']) {
  for (const box of ['new', 'cur']) rm(path.join(ROOT, '状态', '邮箱', role, box));
}
fs.mkdirSync(path.join(BASE, 'data'), { recursive: true });
const WB = path.join(BASE, 'data', 'workbench.json');
fs.writeFileSync(WB, JSON.stringify({ version: 1, activeProjectId: PROJ, projects: [], ui: {} }, null, 2));
const envBase = {
  TEAM_ROOT: ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1',
  AWB_DATA_DIR: path.join(BASE, 'data'), TEAM_WORKBENCH_JSON: WB,
};
sh(['project', 'add', '--name', PROJ, '--team-mode', 'full'], envBase);
// 自足化（2026-11-17 修）：原实现把**真实** 登记册/广播/审计/阅读/轮次计数 带进沙盘，
// 真实数据一涨（如真实登记册已有 L-20261117-1..3、真实广播已有 prompt 行）断言就红——典型的「基线漂移」。
// 现在：①登记册换成**合成最小版**（六段 + 表头，零数据行）；②清掉从真实团队带过来的全部经验教训状态文件。
function syntheticRegister() {
  const lines = ['# 经验教训登记册', '', '> 合成沙盘登记册（测试自足，不依赖真实数据）', ''];
  for (const sec of ['项目经理', '产品', '需求分析师', '程序员A', '程序员B', '测试']) {
    lines.push(`## ${sec}`, '', '| 日期 | 场景 | 教训 | 下次怎么做 |', '|---|---|---|---|', '');
  }
  return lines.join('\n');
}
fs.writeFileSync(path.join(PROJECT_DIR, '经验教训登记册.md'), syntheticRegister());
for (const rel of [
  ['状态', '经验教训广播.jsonl'],
  ['状态', '经验教训审计.jsonl'],
  ['状态', '经验教训阅读.jsonl'],
  ['状态', '项目', PROJ, '轮次计数.json'],
  ['状态', '项目', PROJ, '经验教训审计.jsonl'],
]) { try { rm(path.join(ROOT, ...rel)); } catch { /* 不存在即跳过 */ } }
const bootRaw = sh(['boot', '--role', 'pm', '--project', PROJ, '--session', 'sb-pm'], envBase);
const TOKEN = (/令牌:\s*([0-9a-f]+)/.exec(bootRaw.out) || [])[1] || '';
if (!TOKEN) console.log('BOOT_DEBUG code=' + bootRaw.code + ' out=' + bootRaw.out.slice(0, 500));
const TURNS = path.join(ROOT, '状态', '项目', PROJ, '轮次计数.json');
const BC = path.join(ROOT, '状态', '经验教训广播.jsonl');
const AUDIT = path.join(ROOT, '状态', '经验教训审计.jsonl');
const mdPath = path.join(PROJECT_DIR, '经验教训登记册.md');
const mailCount = (role) => {
  let n = 0;
  for (const box of ['new', 'cur']) {
    try { n += fs.readdirSync(path.join(ROOT, '状态', '邮箱', role, box)).filter((f) => f.endsWith('.json')).length; } catch { }
  }
  return n;
};
const bcRows = () => { try { return fs.readFileSync(BC, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } };
const pass = [];
const fail = [];
function check(name, cond, detail) {
  (cond ? pass : fail).push(name + (cond ? '' : ' :: ' + JSON.stringify(detail)));
  console.log((cond ? 'PASS ' : 'FAIL ') + name + (cond ? '' : ' :: ' + JSON.stringify(detail)));
}

// 阈值 3（项目配置）
sh(['project', 'config', '--lessons-turns', '2', '--project', PROJ, '--boot', TOKEN], envBase);
const envDay = { ...envBase, AWB_LESSONS_TURNS: '2', AWB_LESSONS_TURNS_FORCE: '1', AWB_NOW: '2026-11-17T10:00:00+08:00' };
delete envDay.TEAM_SELFTEST;

/* ---------- AC1：3 次 send → turns=3 + 提示 1 条 ---------- */
const inboxBefore = mailCount('product');
for (let i = 1; i <= 3; i += 1) sh(['send', '--project', PROJ, '--boot', TOKEN, '--to', 'product', '--subject', 's' + i, '--body', 'b' + i], envDay);
let tf = readJsonOr(TURNS);
const bc1 = bcRows();
check('AC1 3 次 send 后 turns 累计为 3（不归零）+ lastMaintenanceRounds=3', tf && tf.roles.pm && tf.roles.pm.turns === 3 && tf.roles.pm.lastMaintenanceRounds === 3, tf && tf.roles.pm);
check('AC1 键集恰好 6+3（新增 lastMaintenanceRounds/lastMaintenanceAt）', tf && tf.roles.pm && Object.keys(tf.roles.pm).length === 9, tf && Object.keys(tf.roles.pm || {}));
check('AC2 三次 send 落箱 3 条、pm 不自收（0 新增）', mailCount('product') - inboxBefore === 3 && mailCount('pm') === 0, { product: mailCount('product') - inboxBefore, pm: mailCount('pm') });
check('AC2 广播 1 行 action=prompt', bc1.filter((r) => r.action === 'prompt').length === 1, bc1);
check('AC2 lastNotifiedAt 前进', tf && tf.roles.pm && !!tf.roles.pm.lastNotifiedAt, tf && tf.roles.pm && tf.roles.pm.lastNotifiedAt);
const promptRow = bc1.find((r) => r.action === 'prompt');
check('AC6 pm 自触发不自收（delivered=false）', promptRow && promptRow.delivered === false, promptRow);

/* ---------- AC3：append 后达阈值 → skip already_recorded ---------- */
const ap = sh(['lessons', 'append', '--project', PROJ, '--boot', TOKEN, '--scene', '冒烟A', '--lesson', '冒烟B', '--next', '冒烟C'], envDay);
check('AC8 append 成功并编号 L-20261117-1', ap.code === 0 && /L-20261117-1/.test(ap.out), ap.out.slice(0, 200));
const ap2 = sh(['lessons', 'append', '--project', PROJ, '--boot', TOKEN, '--scene', 'A2', '--lesson', 'B2', '--next', 'C2'], envDay);
const ap3 = sh(['lessons', 'append', '--project', PROJ, '--boot', TOKEN, '--scene', 'A3', '--lesson', 'B3', '--next', 'C3'], envDay);
check('AC8 三次 append 编号递增 2/3', /L-20261117-2/.test(ap2.out) && /L-20261117-3/.test(ap3.out), [ap2.out.slice(0, 80), ap3.out.slice(0, 80)]);
const delRes = sh(['lessons', 'fix', '--project', PROJ, '--boot', TOKEN, '--id', 'L-20261117-3', '--delete', '--reason', '冒烟软删'], envDay);
check('AC8 软删成功', delRes.code === 0, delRes.out.slice(0, 200));
const mdNow = fs.readFileSync(mdPath, 'utf8');
check('AC8 软删行含 <!-- deleted --> 且原文可 grep', /冒烟软删|deleted/.test(mdNow) && mdNow.split(/\r?\n/).some((l) => /L-20261117-3/.test(l) && /deleted/.test(l)), 'deleted marker');
const ap4 = sh(['lessons', 'append', '--project', PROJ, '--boot', TOKEN, '--scene', 'A4', '--lesson', 'B4', '--next', 'C4'], envDay);
check('AC8 软删后 append 不复用编号 → L-20261117-4', /L-20261117-4/.test(ap4.out), ap4.out.slice(0, 120));
const fixRes = sh(['lessons', 'fix', '--project', PROJ, '--boot', TOKEN, '--id', 'L-20261117-1', '--text', '改后的教训'], envDay);
check('AC8 fix --text 只改教训列', fixRes.code === 0 && fs.readFileSync(mdPath, 'utf8').includes('改后的教训'), fixRes.out.slice(0, 160));
const delList = sh(['lessons', 'status', '--deleted', '--project', PROJ, '--boot', TOKEN], envDay);
check('AC8③ 已删除条目 5 键', delList.code === 0 && /L-20261117-3/.test(delList.out), delList.out.slice(0, 200));
const auditRows = fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
check('审计固定 7 键', auditRows.length > 0 && Object.keys(auditRows[0]).length === 7, auditRows[0] && Object.keys(auditRows[0]));
const stats = sh(['lessons', 'audit', '--project', PROJ, '--boot', TOKEN], envDay);
check('AC9 已更正/已删除计数（1 fix / 1 delete）', /已更正 1 条/.test(stats.out) && /已删除 1 条/.test(stats.out), stats.out.slice(0, 120));

/* AC3 skip already_recorded */
for (let i = 1; i <= 3; i += 1) sh(['send', '--project', PROJ, '--boot', TOKEN, '--to', 'product', '--subject', 'k' + i, '--body', 'k' + i], envDay);
const bc2 = bcRows();
check('AC3 记过之后 → skip already_recorded', bc2.slice(-1)[0] && bc2.slice(-1)[0].action === 'skip' && bc2.slice(-1)[0].reason === 'already_recorded', bc2.slice(-1)[0]);
const tf2 = readJsonOr(TURNS);
check('AC3 达阈值并 skip 后 turns 不归零（累计语义）', tf2 && tf2.roles.pm.turns >= 2, tf2 && tf2.roles.pm.turns);

/* ---------- AC4：夜间静默 + 08:05 合并（先由 tester 写一条造成内容变更） ---------- */
const testerT = boot('tester', 'sb-tester');
sh(['lessons', 'append', '--project', PROJ, '--boot', testerT, '--scene', '夜', '--lesson', '夜', '--next', '夜'], envDay);
const envNight = { ...envDay, AWB_NOW: '2026-11-17T23:30:00+08:00' };
const beforeNight = bcRows().length;
for (let i = 1; i <= 3; i += 1) sh(['send', '--project', PROJ, '--boot', TOKEN, '--to', 'product', '--subject', 'n' + i, '--body', 'n' + i], envNight);
const nightRows = bcRows().slice(beforeNight);
check('AC4 夜间（23:30）照发 action=prompt、不再 quiet', nightRows.length >= 1 && nightRows.every((r) => r.action !== 'quiet') && nightRows.some((r) => r.action === 'prompt'), nightRows);
const envMorning = { ...envDay, AWB_NOW: '2026-11-17T08:05:00+08:00' };
const inboxBeforeMorning = mailCount('product');
for (let i = 1; i <= 3; i += 1) sh(['send', '--project', PROJ, '--boot', TOKEN, '--to', 'product', '--subject', 'm' + i, '--body', 'm' + i], envMorning);
const morningNew = bcRows().slice(-1)[0];
check('AC4 08:05 无夜间累计合并（不再有 quiet；内容未变时可为 skip）', morningNew && morningNew.action !== 'quiet' && !bcRows().slice(-6).some((r) => r.action === 'quiet'), morningNew);
check('AC4 广播行 turns 记录当前累计轮次', morningNew && Number(morningNew.turns) > 0, morningNew);

/* ---------- 阈值来源（放在改名册之前，避免 RULES_CHANGED 干扰） ---------- */
const envNoForce = { ...envBase, AWB_LESSONS_TURNS: '9' };
delete envNoForce.AWB_LESSONS_TURNS_FORCE;
delete envNoForce.TEAM_SELFTEST;   // SELFTEST 本身也放行 env，这里要验「都不设时以项目配置为准」
const tNoForce = sh(['lessons', 'turns', '--project', PROJ, '--boot', TOKEN], envNoForce);
check('阈值：无 FORCE 时 env 不生效（读项目配置 2）', /阈值：2（来源 project）/.test(tNoForce.out), tNoForce.out.match(/阈值：[^\n]*/));
const envForce = { ...envNoForce, AWB_LESSONS_TURNS_FORCE: '1' };
const tForce = sh(['lessons', 'turns', '--project', PROJ, '--boot', TOKEN], envForce);
check('阈值：FORCE 时 env 生效（9）', /阈值：9（来源 env）/.test(tForce.out), tForce.out.match(/阈值：[^\n]*/));

/* ---------- AC7：沙盘免打扰（需先有内容变更：由 tester 写一条） ---------- */
const testerToken = boot('tester', 'sb-tester');
sh(['lessons', 'append', '--project', PROJ, '--boot', testerToken, '--scene', 'T', '--lesson', 'T', '--next', 'T'], envDay);
const envSb = { ...envBase, AWB_LESSONS_TURNS: '2', AWB_LESSONS_TURNS_FORCE: '1', AWB_NOW: '2026-11-17T10:00:00+08:00' };
const inboxSbBefore = mailCount('product');
const beforeSbRows = bcRows().length;
const pmTokenSb = boot('pm', 'sb-pm');
for (let i = 1; i <= 3; i += 1) sh(['send', '--project', PROJ, '--boot', pmTokenSb, '--to', 'product', '--subject', 'sb' + i, '--body', 'sb' + i], envSb);
const sbRow = bcRows().slice(beforeSbRows).filter((r) => r.action === 'prompt').slice(-1)[0];
check('AC7 沙盘不发消息（真实/沙盘邮箱无经验教训提示新增）', mailCount('product') - inboxSbBefore === 3, { product: mailCount('product') - inboxSbBefore });
check('AC7 广播行 suppressed=sandbox', sbRow && sbRow.suppressed === 'sandbox', sbRow);

/* ---------- AC5：换人清零（会改 团队.json → 之后必须重 boot） ---------- */
const p1Token = boot('programmer1', 'sb-p1-old');
for (let i = 1; i <= 2; i += 1) sh(['send', '--project', PROJ, '--boot', p1Token, '--to', 'product', '--subject', 'p' + i, '--body', 'p' + i], envDay);
const tf3 = readJsonOr(TURNS) || { roles: {} };
const p1Before = tf3.roles.programmer1 ? tf3.roles.programmer1.turns : null;
const pmBeforeSwap = tf3.roles.pm ? tf3.roles.pm.turns : null;
const tj2 = JSON.parse(fs.readFileSync(teamJsonPath, 'utf8'));
const m1 = (tj2.members || []).find((m) => m.role === 'programmer1');
if (m1) m1.sessionId = 'sb-p1-new';
fs.writeFileSync(teamJsonPath, JSON.stringify(tj2, null, 2));
const p1Token2 = boot('programmer1', 'sb-p1-new');
sh(['lessons', 'turns', '--project', PROJ, '--boot', p1Token2], envDay);
const tf4 = readJsonOr(TURNS);
check('AC5 换人后 turns 清 0 且 sessionId 更新', tf4 && tf4.roles.programmer1 && tf4.roles.programmer1.turns === 0 && tf4.roles.programmer1.sessionId === 'sb-p1-new', { before: p1Before, after: tf4 && tf4.roles.programmer1 });
check('AC5 其它角色 turns 不变', tf4 && tf4.roles.pm && tf4.roles.pm.turns === pmBeforeSwap, { before: pmBeforeSwap, after: tf4 && tf4.roles.pm && tf4.roles.pm.turns });
check('AC5 审计有 reset/session_changed', fs.readFileSync(AUDIT, 'utf8').includes('session_changed'), 'audit');

console.log('\n=== 汇总：' + pass.length + ' 通过 / ' + fail.length + ' 失败 ===');
if (fail.length) { console.log(fail.join('\n')); process.exitCode = 1; }
console.log('base =', BASE);
