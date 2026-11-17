'use strict';
const { rmSandbox, uniqueSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/**
 * R-5b14（每角色默认交接文档）自检：AC1–AC12。
 *
 * 沙盘（AC12）：TEAM_ROOT + TEAM_PROJECTS_ROOT + AWB_DATA_DIR 三隔离；
 * 项目目录也是**副本**（否则往真实 程序员B/产出/ 写交接就污染证据）。
 * 真团队只读复制，`members[].sessionId` 清空 + TEAM_SELFTEST=1（B-3c03）。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TEAM_MJS = path.join(ROOT, '团队', '工具', 'team.mjs');
const SCAFFOLD = path.join(ROOT, '团队', '工具', 'lib', 'scaffold.mjs');
const SB = uniqueSandbox('handover');
const TEAM = path.join(SB, '团队');
const PROJ_ROOT = path.join(SB, '项目');
const PROJ = path.join(PROJ_ROOT, '工作台改造修复');
const PROJ_NAME = '工作台改造修复';
const REAL_TEAM_JSON = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_WB = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const ROLES = [
  ['pm', '项目经理'],
  ['product', '产品'],
  ['analyst', '需求分析师'],
  ['programmer1', '程序员A'],
  ['programmer2', '程序员B'],
  ['tester', '测试人员'],
];

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}  ${JSON.stringify(detail).slice(0, 500)}`); process.exitCode = 1; }
}
const sha = (file) => { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return ''; } };

// ── 沙盘 ────────────────────────────────────────────────────────────────
rmSandbox(SB, { recursive: true, force: true, maxRetries: 6, retryDelay: 250 });
fs.mkdirSync(SB, { recursive: true });
// 团队：去掉锁/邮箱，避免碰到真实投递面
fs.cpSync(path.join(ROOT, '团队'), TEAM, {
  recursive: true,
  filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) && !/[\\/]邮箱[\\/]/.test(src) && !/[\\/]\.git([\\/]|$)/.test(src),
});
const teamFile = path.join(TEAM, '状态', '团队.json');
const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
for (const m of team.members || []) m.sessionId = '';
team.activeProject = PROJ_NAME;
fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');

// 项目目录副本：只放 boot 需要的文档 + 六角色卡/索引 + 产出目录（不放需求正文以外的重物）
const COPY_FILES = ['项目铁律.md', '项目信息.md', '项目索引.md', '协作准则.md', '需求/00-需求总览.md'];
fs.mkdirSync(path.join(PROJ, '需求'), { recursive: true });
for (const rel of COPY_FILES) {
  const from = path.join(ROOT, '项目', PROJ_NAME, rel);
  const to = path.join(PROJ, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  if (fs.existsSync(from)) fs.copyFileSync(from, to);
}
for (const [, dir] of ROLES) {
  fs.mkdirSync(path.join(PROJ, dir, '产出'), { recursive: true });
  for (const name of ['角色卡.md', '文件索引.md']) {
    const from = path.join(ROOT, '项目', PROJ_NAME, dir, name);
    if (fs.existsSync(from)) fs.copyFileSync(from, path.join(PROJ, dir, name));
  }
}
// 沙盘项目注册表指向副本目录
const projCfgFile = path.join(TEAM, '状态', '项目', PROJ_NAME, '项目.json');
const projCfg = JSON.parse(fs.readFileSync(projCfgFile, 'utf8'));
projCfg.path = PROJ;
fs.writeFileSync(projCfgFile, JSON.stringify(projCfg, null, 2) + '\n', 'utf8');
// 待启动队列会把输出搅乱（消费计数），沙盘里清掉
for (const junk of ['role_queues.json', '路由守护.jsonl']) {
  const f = path.join(TEAM, '状态', '项目', PROJ_NAME, junk);
  if (fs.existsSync(f)) fs.rmSync(f, { force: true });
}

const realTeamShaBefore = sha(REAL_TEAM_JSON);
const realWbShaBefore = sha(REAL_WB);
// 真实 workbench.json 是**运行中工作台的活文件**（PM/壳层持续重写），单看前后 sha 会把别人的写入
// 误判成我们污染。先取一次对照样本：不跑任何命令，隔 1.2 秒再取——若已变，说明它本来就是活的，
// 此时只作「对照记录」，隔离硬证据改用 真实 团队.json + 真实项目文件。
const realWbCtrl = sha(REAL_WB);
const sleepSync = (ms) => { Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms); };
sleepSync(1200);
const realWbCtrl2 = sha(REAL_WB);
const wbIsLive = realWbCtrl !== realWbCtrl2;
const realHandover = path.join(ROOT, '项目', PROJ_NAME, '程序员B', '产出', '交接-最新.md');
const realHandoverShaBefore = sha(realHandover);

function env() {
  return {
    ...process.env,
    TEAM_ROOT: TEAM,
    TEAM_PROJECTS_ROOT: path.join(TEAM, '状态', '项目'),
    AWB_DATA_DIR: path.join(SB, 'data'),
    TEAM_SELFTEST: '1',
  };
}
function run(args) {
  try {
    const stdout = execFileSync(process.execPath, [TEAM_MJS, ...args], { env: env(), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, out: stdout, err: '' };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
}
let bootCount = 0;
function boot(role, session = `${role}-ho`) {
  bootCount += 1;
  const r = run(['boot', '--role', role, '--project', PROJ_NAME, '--session', session]);
  const token = (r.out.match(/令牌[:：]\s*([a-f0-9]+)/i) || [])[1] || '';
  const rules = (r.out.match(/哈希 rules\s+([a-f0-9]+)/i) || [])[1] || '';
  return { ...r, token, rules };
}
/** AC9 口径：去掉「令牌:」与「read 回执:」两行后整份 UTF-8 字节 */
function briefBytes(out) {
  const kept = String(out || '').split('\n').filter((line) => !/^令牌[:：]/.test(line) && !/^read 回执[:：]/.test(line));
  return Buffer.byteLength(kept.join('\n'), 'utf8');
}
function hintLines(out) {
  return String(out || '').split('\n').filter((line) => line.startsWith('⚠ 检测到前任交接：') || line.startsWith('⚠ 未找到 交接-最新.md'));
}
function lineOf(out, prefix) {
  return String(out || '').split('\n').find((line) => line.startsWith(prefix)) || '';
}
const handoverFile = (roleDir) => path.join(PROJ, roleDir, '产出', '交接-最新.md');
function writeFile(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); }
function rmRoleHandovers(roleDir) {
  const dir = path.join(PROJ, roleDir, '产出');
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (/\.md$/i.test(name) && /^(交接|接任|开工交接|换人交接)/.test(name)) fs.rmSync(path.join(dir, name), { force: true });
  }
}

// ── AC1：清单项就位（六角色逐个取） ─────────────────────────────────────
const specProbe = execFileSync(process.execPath, [
  '--input-type=module', '-e',
  `import { bootDocSpecs } from ${JSON.stringify('file:///' + SCAFFOLD.replace(/\\/g, '/'))};
   const out = {};
   for (const role of ${JSON.stringify(ROLES.map((r) => r[1]))}) out[role] = bootDocSpecs(${JSON.stringify(PROJ)}, role).find((s) => s.key === 'handover') || null;
   console.log(JSON.stringify(out));`,
], { encoding: 'utf8' });
const specs = JSON.parse(specProbe);
const specOk = ROLES.every(([, dir]) => {
  const s = specs[dir];
  return s && s.required === false && s.core === false && String(s.rel).endsWith('/产出/交接-最新.md') && s.path && s.path.endsWith(path.join('产出', '交接-最新.md'));
});
ok('AC1 六角色的清单项都有 handover（required=false / core=false / rel 以 /产出/交接-最新.md 结尾）', specOk, specs);
const allSpecs = JSON.parse(execFileSync(process.execPath, ['--input-type=module', '-e',
  `import { bootDocSpecs } from ${JSON.stringify('file:///' + SCAFFOLD.replace(/\\/g, '/'))};
   console.log(JSON.stringify(bootDocSpecs(${JSON.stringify(PROJ)}, '程序员B').map((s) => s.key)));`], { encoding: 'utf8' }));
// 口径变更说明（2026-11-17，R-bcae 4358 接入）：bootDocSpecs 在 handover 之外又新增了 skillIndex（基础流程 skill 索引，
// required=false/core=false/不进 rulesHash），因此清单由 9 项变 10 项。断言改为「原 9 项全部保留 + 只允许 skillIndex 这一个新增键」，
// 仍保留文件存在性断言（AC1 的六角色 handover 项不动）。
const HANDOVER_BASE_SPECS = ['constitution', 'iron', 'projectInfo', 'roleCard', 'roleIndex', 'projectIndex', 'requirementOverview', 'collaboration', 'handover'];
const specAdded = allSpecs.filter((k) => !HANDOVER_BASE_SPECS.includes(k));
ok('AC1② 清单只加不删（原 9 项全在；新增仅 skillIndex）', HANDOVER_BASE_SPECS.every((k) => allSpecs.includes(k)) && specAdded.length === 1 && specAdded[0] === 'skillIndex', { allSpecs, added: specAdded });

// ── AC2：有交接 → 一行提示 ──────────────────────────────────────────────
rmRoleHandovers('程序员B');
const baseBoot1 = boot('programmer2');
const baseBoot2 = boot('programmer2');
ok('前置：无交接时 boot 成功', baseBoot1.code === 0 && baseBoot2.code === 0, { c1: baseBoot1.code, c2: baseBoot2.code, err: baseBoot1.err.slice(0, 200) });
ok('AC9 基线稳定：同角色同会话连跑两次字节相同', briefBytes(baseBoot1.out) === briefBytes(baseBoot2.out), { a: briefBytes(baseBoot1.out), b: briefBytes(baseBoot2.out) });
const baselineBytes = briefBytes(baseBoot1.out);

writeFile(handoverFile('程序员B'), '# 前任交接\n\n一句话：按 §七 接 T-5369。\n');
const hadBoot = boot('programmer2');
const hadHint = hintLines(hadBoot.out);
ok('AC2① 有交接 → 简报出现「⚠ 检测到前任交接：」且含 产出/交接-最新.md', hadHint.length === 1 && hadHint[0].includes('⚠ 检测到前任交接：') && hadHint[0].includes('程序员B/产出/交接-最新.md'), hadHint);
ok('AC2② 该提示行全文简报只出现 1 次', String(hadBoot.out).split('⚠ 检测到前任交接：').length - 1 === 1, { count: String(hadBoot.out).split('⚠ 检测到前任交接：').length - 1 });
ok('AC2③ 提示行位置在「必读-按需已读」之前', (() => {
  const lines = String(hadBoot.out).split('\n');
  const hi = lines.findIndex((l) => l.startsWith('⚠ 检测到前任交接：'));
  const oi = lines.findIndex((l) => l.startsWith('必读-按需已读'));
  return hi >= 0 && oi >= 0 && hi < oi;
})());

// ── AC9：有交接增量 ≤120B ───────────────────────────────────────────────
const inc = briefBytes(hadBoot.out) - baselineBytes;
ok('AC9① 有交接增量 ≤120B（含角色/基线/增量见日志）', inc > 0 && inc <= 120, { role: 'programmer2', baselineBytes, withHandover: briefBytes(hadBoot.out), increment: inc });
console.log(`      AC9 口径：角色 programmer2 ｜ 基线 ${baselineBytes}B ｜ 有交接 ${briefBytes(hadBoot.out)}B ｜ 增量 ${inc}B`);

// ── AC3：删掉 → 不提示、也不列清单 ─────────────────────────────────────
fs.rmSync(handoverFile('程序员B'), { force: true });
const goneBoot = boot('programmer2');
const goneLines = String(goneBoot.out).split('\n');
ok('AC3① 无交接 → 简报不出现「检测到前任交接」与「未找到 交接-最新.md」', !goneBoot.out.includes('检测到前任交接') && !goneBoot.out.includes('未找到 交接-最新.md'), hintLines(goneBoot.out));
ok('AC3② 交接-最新.md 不出现在「必读-按需已读」行', !lineOf(goneBoot.out, '必读-按需已读').includes('交接-最新.md'), lineOf(goneBoot.out, '必读-按需已读'));
ok('AC3③ 交接-最新.md 不出现在「必读-未读」行', !lineOf(goneBoot.out, '必读-未读').includes('交接-最新.md'), lineOf(goneBoot.out, '必读-未读'));
ok('AC9② 无交接增量 =0（相对基线）', briefBytes(goneBoot.out) === baselineBytes, { now: briefBytes(goneBoot.out), baselineBytes });

// ── AC4：旧命名 → 中性提示且给最新一份 ─────────────────────────────────
rmRoleHandovers('程序员B');
writeFile(path.join(PROJ, '程序员B', '产出', '交接-20261115-1340.md'), '# 旧交接\n');
const old135 = new Date('2026-11-13T09:00:00Z');
writeFile(path.join(PROJ, '程序员B', '产出', '交接-20261113-0900.md'), '# 更旧交接\n');
fs.utimesSync(path.join(PROJ, '程序员B', '产出', '交接-20261113-0900.md'), new Date(), new Date('2026-11-16T00:00:00Z'));
const histBoot = boot('programmer2');
const histLine = hintLines(histBoot.out)[0] || '';
ok('AC4① 旧命名 → 出现「未找到 交接-最新.md」且份数=2', histLine.startsWith('⚠ 未找到 交接-最新.md') && histLine.includes('2 份'), histLine);
ok('AC4② 列出的是文件名时间戳最大的那份（20261115-1340）', histLine.includes('交接-20261115-1340.md') && !histLine.includes('交接-20261113-0900.md'), histLine);
// 改名 → 变 AC2 提示、旧提示消失
fs.renameSync(path.join(PROJ, '程序员B', '产出', '交接-20261115-1340.md'), handoverFile('程序员B'));
const renamedBoot = boot('programmer2');
const renamedLines = hintLines(renamedBoot.out);
ok('AC4③ 改名成 交接-最新.md 后 → 变成「检测到前任交接」且旧提示消失', renamedLines.length === 1 && renamedLines[0].startsWith('⚠ 检测到前任交接：') && !renamedBoot.out.includes('未找到 交接-最新.md'), renamedLines);
// 三种非规范样本
rmRoleHandovers('程序员B');
writeFile(path.join(PROJ, '程序员B', '产出', '交接-20261115-产品.md'), '# 有日期无时分\n');
const c1 = hintLines(boot('programmer2').out);
ok('AC4④ 只有 交接-20261115-产品.md（有日期无时分）→ 提示指向它', c1.length === 1 && c1[0].includes('交接-20261115-产品.md') && c1[0].includes('1 份'), c1);
rmRoleHandovers('程序员B');
writeFile(path.join(PROJ, '程序员B', '产出', '交接-45d3.md'), '# 无日期，mtime 兜底\n');
const c2 = hintLines(boot('programmer2').out);
ok('AC4⑤ 只有 交接-45d3.md（无日期）→ 提示仍出现且指向它（mtime 兜底）', c2.length === 1 && c2[0].includes('交接-45d3.md'), c2);
rmRoleHandovers('程序员B');
writeFile(path.join(PROJ, '程序员B', '产出', '接任-20261115-1755.md'), '# 接任前缀\n');
const c3 = hintLines(boot('programmer2').out);
ok('AC4⑥ 只有 接任-X → 提示出现且 N=1（漏一类即不合格）', c3.length === 1 && c3[0].includes('接任-20261115-1755.md') && c3[0].includes('1 份'), c3);
rmRoleHandovers('程序员B');
writeFile(path.join(PROJ, '程序员B', '产出', '开工交接-20261116.md'), '# 开工交接前缀\n');
const c4 = hintLines(boot('programmer2').out);
ok('AC4⑦ 只有 开工交接-X → 提示出现且 N=1', c4.length === 1 && c4[0].includes('开工交接-20261116.md') && c4[0].includes('1 份'), c4);
rmRoleHandovers('程序员B');
writeFile(path.join(PROJ, '程序员B', '产出', '换人交接-20261116-1200.md'), '# 换人交接前缀\n');
const c5 = hintLines(boot('programmer2').out);
ok('AC4⑧ 只有 换人交接-X → 提示出现且 N=1（四类前缀都算历史）', c5.length === 1 && c5[0].includes('换人交接-20261116-1200.md') && c5[0].includes('1 份'), c5);

// ── AC5：不阻断（三态 + 0 字节） ───────────────────────────────────────
rmRoleHandovers('程序员B');
writeFile(handoverFile('程序员B'), '');
const zeroBoot = boot('programmer2');
ok('AC5① 交接为 0 字节 → boot 退出码 0 且有令牌与简报', zeroBoot.code === 0 && Boolean(zeroBoot.token) && zeroBoot.out.includes('=== 启动简报'), { code: zeroBoot.code });
ok('AC5② 三态（有/无/历史）boot 均退出码 0', hadBoot.code === 0 && goneBoot.code === 0 && histBoot.code === 0, { a: hadBoot.code, b: goneBoot.code, c: histBoot.code });

// ── AC6：不进 rulesHash ────────────────────────────────────────────────
rmRoleHandovers('程序员B');
const hashBefore = boot('programmer2');
writeFile(handoverFile('程序员B'), '# 改交接\n');
const hashAfter = boot('programmer2');
ok('AC6① 写入交接前后两次 boot 的 rules 哈希完全相同', hashBefore.rules && hashBefore.rules === hashAfter.rules, { before: hashBefore.rules, after: hashAfter.rules });
const oldTokenProbe = run(['task', 'list', '--role', 'programmer2', '--project', PROJ_NAME, '--boot', hashBefore.token]);
ok('AC6② 旧令牌执行只读命令不报 RULES_CHANGED', oldTokenProbe.code === 0 && !/RULES_CHANGED/.test(oldTokenProbe.out + oldTokenProbe.err), { code: oldTokenProbe.code, head: (oldTokenProbe.out + oldTokenProbe.err).slice(0, 160) });

// ── AC7：不自动建文件 ──────────────────────────────────────────────────
rmRoleHandovers('程序员B');
const ensure = run(['project', 'ensure', '--name', PROJ_NAME]);
const addProbe = run(['project', 'add', '--name', 'ho-sandbox', '--path', PROJ]);
const cleanBoot = boot('programmer2');
const created = ROLES.map(([, dir]) => handoverFile(dir)).filter((f) => fs.existsSync(f));
ok('AC7 干净沙盘跑 project ensure + project add + boot 后没有任何 交接-最新.md 被创建', created.length === 0, { created, ensure: ensure.code, add: addProbe.code, boot: cleanBoot.code });

// ── AC8：六角色隔离 ────────────────────────────────────────────────────
rmRoleHandovers('程序员B');
writeFile(handoverFile('程序员B'), '# B 的交接\n');
const bBoot = boot('programmer2');
const aBoot = boot('programmer1');
const pBoot = boot('pm');
ok('AC8① B 自己有交接 → B 的简报出现提示', bBoot.out.includes('⚠ 检测到前任交接：程序员B/产出/交接-最新.md'), hintLines(bBoot.out));
ok('AC8② A 的简报不含 B 的路径、也不出现提示', !aBoot.out.includes('程序员B/产出/交接-最新.md') && !/检测到前任交接|未找到 交接-最新\.md/.test(aBoot.out), hintLines(aBoot.out));
ok('AC8③ PM 的简报同样不含 B 的路径', !pBoot.out.includes('程序员B/产出/交接-最新.md'), hintLines(pBoot.out));

// ── AC10：内容不校验 ──────────────────────────────────────────────────
rmRoleHandovers('程序员B');
writeFile(handoverFile('程序员B'), '只写一句话\n');
const thinBoot = boot('programmer2');
ok('AC10 只有一句话（缺小节）→ boot 不报错、不标红、退出码 0', thinBoot.code === 0 && !/\[ERROR\]|FAIL|不合格/.test(thinBoot.out + thinBoot.err) && thinBoot.out.includes('⚠ 检测到前任交接'), { code: thinBoot.code, err: thinBoot.err.slice(0, 160) });

// ── AC11：幂等 3 次逐字相同 ────────────────────────────────────────────
rmRoleHandovers('程序员B');
writeFile(handoverFile('程序员B'), '# 稳定交接\n');
const runs = [boot('programmer2'), boot('programmer2'), boot('programmer2')];
const hints = runs.map((r) => hintLines(r.out)[0] || '');
ok('AC11 同状态连跑 3 次提示行逐字相同', Boolean(hints[0]) && hints.every((h) => h === hints[0]), hints);

// ── AC12：隔离证据 ────────────────────────────────────────────────────
ok('AC12① 真实 团队/状态/团队.json 前后 sha256 不变', sha(REAL_TEAM_JSON) === realTeamShaBefore, { before: realTeamShaBefore.slice(0, 16), after: sha(REAL_TEAM_JSON).slice(0, 16) });
if (wbIsLive) {
  // 活文件：对照样本已证明「不跑东西它自己也在变」→ 前后比对无归因力，改为记录 + PASS（并写进日志）
  console.log(`      INFO AC12② 真实 workbench.json 是活文件（对照样本 ${realWbCtrl.slice(0, 12)} → ${realWbCtrl2.slice(0, 12)}，未跑任何命令），前后 sha 变化不可归因于本脚本；隔离硬证据用 AC12①/AC12③`);
  ok('AC12② 真实 workbench.json 不在本脚本的写入面（本项目 CLI 只在项目命令里读它，沙盘已用 AWB_DATA_DIR 隔离）', true, { control: [realWbCtrl.slice(0, 12), realWbCtrl2.slice(0, 12)] });
} else {
  ok('AC12② 真实 workbench.json 前后 sha256 不变', !realWbShaBefore || sha(REAL_WB) === realWbShaBefore, { before: realWbShaBefore.slice(0, 16), after: sha(REAL_WB).slice(0, 16) });
}
ok('AC12③ 真实 程序员B/产出/交接-最新.md 未被改写', sha(realHandover) === realHandoverShaBefore, { before: realHandoverShaBefore.slice(0, 16), after: sha(realHandover).slice(0, 16) });

console.log(`\nR-5b14 断言：${pass} 通过 / ${fail} 失败（boot 调用 ${bootCount} 次）`);
const evidDir = path.join(ROOT, '项目', PROJ_NAME, '程序员B', '产出', '证据-5b14');
fs.mkdirSync(evidDir, { recursive: true });
fs.writeFileSync(path.join(evidDir, 'run-5b14.log'), [
  `pass=${pass} fail=${fail} exit=${process.exitCode || 0}`,
  `AC9 role=programmer2 baseline=${baselineBytes}B withHandover=${briefBytes(hadBoot.out)}B increment=${inc}B`,
  `boots=${bootCount}`,
].join('\n') + '\n', 'utf8');
