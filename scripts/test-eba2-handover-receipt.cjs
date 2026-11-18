#!/usr/bin/env node
'use strict';
/**
 * test-eba2-handover-receipt.cjs —— R-20261118-143558-eba2 回归夹具
 *
 * 口径（Owner 2026-11-18 14:35）：到阈值只提醒 → 本人写交接并落回执 → PM 核对后手动换人；
 * PM 自己的换人由产品执行（产品令牌只能换 pm）；换人前必须校验回执 sha == 磁盘交接文件。
 *
 * 断言（沙盘 full 项目，TEAM_SELFTEST=1 + TEAM_BOOT_ENFORCE=1 + TEAM_HANDOVER_ENFORCE=1）：
 *   S1 三角色 boot 拿到令牌
 *   S2 产品给普通角色落回执 → PERMISSION_DENIED（产品只能为 PM 落回执）
 *   S3 程序员1 自己落回执 → ok，回执行含 bytes/sha256
 *   S4 PM 换程序员1（有效回执）→ 成功，审计 actorRole=pm、receiptId 一致
 *   S5 PM 换程序员1 但无回执 → HANDOVER_RECEIPT_REQUIRED(no_receipt)，零副作用（团队.json sha 不变、无新轮换记录）
 *   S6 PM 自己换自己 → PERMISSION_DENIED
 *   S7 产品换普通角色 → PERMISSION_DENIED
 *   S8 产品换 PM：无回执 → HANDOVER_RECEIPT_REQUIRED(no_receipt)，零副作用
 *   S9 产品换 PM：落回执后改交接文件 → HANDOVER_RECEIPT_REQUIRED(sha_mismatch)，零副作用
 *   S10 重新落回执 → 产品换 PM 成功，审计 by=product、receiptId 一致
 *
 * 隔离：mkTempSandbox + TEAM_ROOT/TEAM_PROJECTS_ROOT/TEAM_WORKBENCH_JSON 全指向沙盘。
 * 用法：node scripts/test-eba2-handover-receipt.cjs
 * 退出码：0 全过 / 1 有失败 / 2 环境错误
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const ROOT = path.resolve(__dirname, '..');
const SB = mkTempSandbox('eba2');
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench.json');
const TEAM_TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const PROJECT = 'eba2回执换人沙盘';

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 400)}`);
}
function env(extra = {}) {
  return {
    ...process.env,
    TEAM_ROOT: TEAM,
    TEAM_PROJECTS_ROOT: PROJECTS,
    TEAM_WORKBENCH_JSON: STORE,
    TEAM_SELFTEST: '1',
    TEAM_BOOT_ENFORCE: '1',
    TEAM_HANDOVER_ENFORCE: '1',
    ...extra,
  };
}
function run(args, extra = {}) {
  try {
    const out = execFileSync(process.execPath, [TEAM_TOOL, ...args], { encoding: 'utf8', env: env(extra), timeout: 120000, cwd: SB });
    return { code: 0, out: String(out), err: '' };
  } catch (error) {
    return { code: error.status == null ? 1 : error.status, out: String(error.stdout || ''), err: String(error.stderr || '') };
  }
}
function runJson(args, extra = {}) {
  const r = run(args, extra);
  const t = String(r.out || '').trim();
  const i = t.indexOf('{');
  let json = null;
  if (i >= 0) { try { json = JSON.parse(t.slice(i)); } catch { json = null; } }
  return { ...r, json };
}
const text = (r) => String(r.out || '') + String(r.err || '');
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const exists = (p) => fs.existsSync(p);

if (!exists(TEAM_TOOL)) { console.error('环境错误：找不到 team.mjs'); process.exit(2); }

// ── 沙盘骨架
fs.mkdirSync(PROJECTS, { recursive: true });
fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
const teamSrc = readJson(path.join(ROOT, '团队', '状态', '团队.json'));
for (const m of teamSrc.members || []) m.sessionId = '';
teamSrc.activeProjectId = '';
fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(teamSrc, null, 2) + '\n', 'utf8');
for (const rel of ['团队宪法.md', '项目铁律.md']) {
  const src = path.join(ROOT, '团队', rel);
  if (exists(src)) fs.copyFileSync(src, path.join(TEAM, rel));
}
const protoSrc = path.join(ROOT, '团队', '协议');
if (exists(protoSrc)) fs.cpSync(protoSrc, path.join(TEAM, '协议'), { recursive: true });
fs.cpSync(path.join(ROOT, '团队', '工具'), path.join(TEAM, '工具'), { recursive: true });

const addProject = runJson(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
check('S0 沙盘 full 项目登记', addProject.code === 0, { code: addProject.code, out: text(addProject).slice(0, 300) });

const boot = (role, sid) => runJson(['boot', '--role', role, '--project', PROJECT, '--session', sid, '--json']);
const bPm = boot('pm', 's-pm-eba2');
const bPro = boot('product', 's-product-eba2');
const bP1 = boot('programmer1', 's-p1-eba2');
const tokenOf = (r) => String((r.json && r.json.token) || '');
const PM = tokenOf(bPm);
const PRO = tokenOf(bPro);
const P1 = tokenOf(bP1);
check('S1 pm/product/programmer1 三令牌', Boolean(PM) && Boolean(PRO) && Boolean(P1), { pm: bPm.code, product: bPro.code, p1: bP1.code });

const stateDir = path.join(TEAM, '状态', '项目', PROJECT);
const projPath = path.join(PROJECTS, PROJECT);
const handoverOf = (roleDir) => path.join(projPath, roleDir, '产出', '交接-最新.md');
const writeHandover = (roleDir, note) => {
  const file = handoverOf(roleDir);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, [
    `# 交接 · ${roleDir}`,
    '',
    '## 【在途任务】',
    note || '无在途任务',
    '',
    '## 【未闭环事项】',
    '无',
    '',
    '## 【最近决策】',
    '无',
    '',
    '## 【建议下一步】',
    '按交接执行',
    '',
    '## 【遗留问题与坑】',
    '无已知坑',
    '',
  ].join('\n'), 'utf8');
  return file;
};
const receiptFile = path.join(stateDir, '交接回执.jsonl');
const receipts = () => (exists(receiptFile) ? fs.readFileSync(receiptFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
const rotations = () => {
  const dir = path.join(stateDir, '会话轮换');
  if (!exists(dir)) return [];
  return fs.readdirSync(dir).filter((f) => /^S-.*\.json$/.test(f));
};
const teamJson = path.join(TEAM, '状态', '团队.json');

// S2 产品给普通角色落回执 → 拒绝
fs.mkdirSync(projPath, { recursive: true });
writeHandover('程序员A');
const r2 = runJson(['session', 'handover', 'receipt', '--boot', PRO, '--role', 'programmer1', '--project', PROJECT, '--json']);
check('S2 产品给普通角色落回执被拒（PERMISSION_DENIED）', r2.code !== 0 && /PERMISSION_DENIED/.test(text(r2)), { code: r2.code, out: text(r2).slice(0, 300) });

// S3 程序员1 自己落回执
const r3 = runJson(['session', 'handover', 'receipt', '--boot', P1, '--role', 'programmer1', '--project', PROJECT, '--json']);
const recP1 = receipts().filter((r) => r.role === 'programmer1').pop();
const handSha = sha(handoverOf('程序员A'));
check('S3 程序员1 落回执成功且 sha==磁盘', r3.code === 0 && Boolean(recP1) && recP1.sha256 === handSha && recP1.bytes === fs.statSync(handoverOf('程序员A')).size,
  { code: r3.code, rec: recP1 && { bytes: recP1.bytes, sha: String(recP1.sha256).slice(0, 12) }, fileSha: handSha.slice(0, 12) });

// S4 PM 换程序员1（有效回执）
const beforeRot4 = rotations().length;
const r4 = runJson(['session', 'rotate', '--boot', PM, '--role', 'programmer1', '--project', PROJECT, '--offline', '--session', 'session-eba2-p1-new', '--reason', 'eba2 夹具：PM 换普通角色', '--json']);
const rotFile4 = rotations().filter((f) => f !== 'S-placeholder').map((f) => path.join(stateDir, '会话轮换', f));
let recRot4 = null;
for (const f of rotFile4) { try { const j = readJson(f); if (j.role === 'programmer1' && j.to === 'session-eba2-p1-new') recRot4 = j; } catch { /* ignore */ } }
check('S4 PM 换程序员1 成功且审计 actorRole=pm/receiptId 一致',
  r4.code === 0 && Boolean(recRot4) && recRot4.by === 'pm' && recRot4.actorRole === 'pm' && recRot4.receiptId === recP1.id && recRot4.handoverSha256 === handSha,
  { code: r4.code, out: text(r4).slice(0, 300), rot: recRot4 && { by: recRot4.by, actor: recRot4.actorRole, receiptId: recRot4.receiptId } });

// S5 无回执换人 → 拒绝且零副作用（换一个从未落过回执的角色：tester）
writeHandover('测试人员');
const beforeTeamSha = sha(teamJson);
const beforeRot = rotations().length;
const r5 = runJson(['session', 'rotate', '--boot', PM, '--role', 'tester', '--project', PROJECT, '--offline', '--session', 'session-eba2-te-new', '--json']);
check('S5 无回执 → HANDOVER_RECEIPT_REQUIRED(no_receipt) 零副作用',
  r5.code !== 0 && /HANDOVER_RECEIPT_REQUIRED/.test(text(r5)) && /no_receipt/.test(text(r5)) && sha(teamJson) === beforeTeamSha && rotations().length === beforeRot,
  { code: r5.code, out: text(r5).slice(0, 300) });

// S6 PM 换自己 → 拒绝
const r6 = runJson(['session', 'rotate', '--boot', PM, '--role', 'pm', '--project', PROJECT, '--offline', '--session', 'session-eba2-pm-new', '--json']);
check('S6 PM 自换被拒（PERMISSION_DENIED）', r6.code !== 0 && /PERMISSION_DENIED/.test(text(r6)), { code: r6.code, out: text(r6).slice(0, 300) });

// S7 产品换普通角色 → 拒绝
const r7 = runJson(['session', 'rotate', '--boot', PRO, '--role', 'programmer1', '--project', PROJECT, '--offline', '--session', 'session-eba2-p1-new3', '--json']);
check('S7 产品换普通角色被拒（PERMISSION_DENIED）', r7.code !== 0 && /PERMISSION_DENIED/.test(text(r7)), { code: r7.code, out: text(r7).slice(0, 300) });

// S8 产品换 PM：无回执 → 拒绝零副作用
writeHandover('项目经理', 'PM 交接 v1');
const beforeTeamSha8 = sha(teamJson);
const beforeRot8 = rotations().length;
const r8 = runJson(['session', 'rotate', '--boot', PRO, '--role', 'pm', '--project', PROJECT, '--offline', '--session', 'session-eba2-pm-new2', '--json']);
check('S8 产品换 PM 无回执 → HANDOVER_RECEIPT_REQUIRED(no_receipt) 零副作用',
  r8.code !== 0 && /no_receipt/.test(text(r8)) && sha(teamJson) === beforeTeamSha8 && rotations().length === beforeRot8,
  { code: r8.code, out: text(r8).slice(0, 300) });

// S9 落回执后改交接文件 → sha_mismatch
const r9rec = runJson(['session', 'handover', 'receipt', '--boot', PM, '--role', 'pm', '--project', PROJECT, '--json']);
writeHandover('项目经理', 'PM 交接 v2（回执后改动）');
const beforeTeamSha9 = sha(teamJson);
const r9 = runJson(['session', 'rotate', '--boot', PRO, '--role', 'pm', '--project', PROJECT, '--offline', '--session', 'session-eba2-pm-new3', '--json']);
check('S9 回执后改文件 → sha_mismatch 零副作用',
  r9rec.code === 0 && r9.code !== 0 && /sha_mismatch/.test(text(r9)) && sha(teamJson) === beforeTeamSha9,
  { code: r9.code, out: text(r9).slice(0, 300) });

// S10 重新落回执 → 产品换 PM 成功，审计 by=product
const r10rec = runJson(['session', 'handover', 'receipt', '--boot', PM, '--role', 'pm', '--project', PROJECT, '--json']);
const pmSha = sha(handoverOf('项目经理'));
const recPm = receipts().filter((r) => r.role === 'pm').pop();
const r10 = runJson(['session', 'rotate', '--boot', PRO, '--role', 'pm', '--project', PROJECT, '--offline', '--session', 'session-eba2-pm-final', '--reason', 'eba2 夹具：产品换 PM', '--json']);
let recRot10 = null;
for (const f of rotations()) { try { const j = readJson(path.join(stateDir, '会话轮换', f)); if (j.role === 'pm' && j.to === 'session-eba2-pm-final') recRot10 = j; } catch { /* ignore */ } }
check('S10 产品换 PM 成功且 by=product/receiptId 一致',
  r10rec.code === 0 && r10.code === 0 && Boolean(recRot10) && recRot10.by === 'product' && recRot10.actorRole === 'product' && recRot10.receiptId === recPm.id && recRot10.handoverSha256 === pmSha,
  { code: r10.code, out: text(r10).slice(0, 300), rot: recRot10 && { by: recRot10.by, actor: recRot10.actorRole, receipt: recRot10.receiptId } });

// 汇总
console.log(`\nEBA2-HANDOVER-RECEIPT ${failures.length === 0 ? 'PASS' : 'FAIL'} ${passed}/${passed + failures.length}`);
if (failures.length) { console.log(JSON.stringify(failures.slice(0, 5), null, 2)); process.exit(1); }
process.exit(0);
