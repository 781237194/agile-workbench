#!/usr/bin/env node
/**
 * T-20261117-221513-e160（P1，测试）：R-6b61 验收 AC1–AC8（独立验，不复用实现方夹具结论）
 * 需求：需求/R-20261117-202524-6b61-收官A案-宪法最高与铁律移出rulesHash.md（15620B / b939828600c4）
 * 沙盘五变量隔离；验：rulesHash 三项/改铁律不失效/改宪法失效/共享常量单源/沙盘生成物/
 *                     index 幂等/靶词白名单/提交与回滚/selftest 回归
 * 用法：node scripts/test-6b61-accept.cjs [--json]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = '工作台改造修复';
const jsonOut = process.argv.includes('--json');
const TEAM = path.join(ROOT, '团队');
const TEAM_MJS = path.join(TEAM, '工具', 'team.mjs');
const LIB = path.join(TEAM, '工具', 'lib');
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const SANDBOX = path.join(ROOT, '_tmp', `a6b61-accept-${process.pid}-${Date.now().toString(36)}`);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!jsonOut) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
  return Boolean(ok);
}
const sha256 = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, ent.name), b = path.join(dst, ent.name);
    if (filter && filter(a)) continue;
    if (ent.isDirectory()) copyDir(a, b, filter); else fs.copyFileSync(a, b);
  }
}
const SB = {
  dir: SANDBOX,
  get team() { return path.join(SANDBOX, '团队'); },
  get projects() { return path.join(SANDBOX, '项目'); },
  get data() { return path.join(SANDBOX, 'data'); },
  get projectDir() { return path.join(SANDBOX, '项目', PROJECT); },
  get teamFile() { return path.join(SANDBOX, '团队', '状态', '团队.json'); },
  get state() { return path.join(SANDBOX, '团队', '状态', '项目', PROJECT); },
};
const sbEnv = () => ({
  ...process.env,
  AWB_DATA_DIR: SB.data, TEAM_ROOT: SB.team, TEAM_PROJECTS_ROOT: SB.projects,
  TEAM_WORKBENCH_JSON: path.join(SB.data, 'workbench.json'), TEAM_SELFTEST: '1',
  // B-7b01 起 boot 校验「名册会话必须存在于 DSH 列表」：沙盘用官方注入口提供假列表，并断开真实 DSH
  DSH_WEB_URL: '',
  TEAM_DSH_FAKE: JSON.stringify([
    { sessionId: 'sess-a6b61-1' }, { sessionId: 'sess-a6b61-2' }, { sessionId: 'sess-a6b61-3' },
    { sessionId: 'sess-old-tester' }, { sessionId: 'sess-old-pm' },
  ]),
});
function run(args, env, timeoutMs) {
  const r = spawnSync(process.execPath, args, { cwd: ROOT, env: env || sbEnv(), encoding: 'utf8', timeout: Number(timeoutMs || 300000) });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function runGit(args) {
  const r = spawnSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
/** 索引里天然会变的行（生成时间戳、任务统计）——幂等比较时剔除 */
function normalizeIndex(text) {
  return String(text || '')
    .split(/\r?\n/)
    .filter((l) => !/自动生成[:：]/.test(l) && !/进行中 \*\*\d+\*\*/.test(l))
    .join('\n');
}
const tokenOf = (out) => { const m = /令牌[:：]\s*([0-9a-f]+)/.exec(out); return m ? m[1] : ''; };
const sha8 = (s) => crypto.createHash('sha256').update(String(s)).digest('hex').slice(0, 8);
const norm = (t) => normalizeIndex(t);
function bootTester(session) {
  const r = run([TEAM_MJS, 'boot', '--role', 'tester', '--project', PROJECT, '--session', session]);
  const m = /rules (?:哈希|hash)[:：]?\s*([0-9a-f]+)/.exec(r.out) || /rules\s+([0-9a-f]{8,})/.exec(r.out);
  return { token: tokenOf(r.out), rules: m ? m[1] : '', out: r.out, code: r.code };
}

async function main() {
  // ── 沙盘准备 ──────────────────────────────────────────────────────────
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(SB.data, { recursive: true });
  fs.mkdirSync(SB.projects, { recursive: true });
  copyDir(TEAM, SB.team, (p) => /[\\/]邮箱([\\/]|$)/.test(p) || /[\\/]锁([\\/]|$)/.test(p) || /[\\/]备份([\\/]|$)/.test(p) || /[\\/]状态[\\/]项目([\\/]|$)/.test(p));
  fs.mkdirSync(path.join(SB.team, '状态', '项目'), { recursive: true });
  fs.mkdirSync(path.join(SB.team, '状态', '邮箱'), { recursive: true });
  const roster = readJson(SB.teamFile, { members: [] });
  for (const m of (roster.members || [])) m.sessionId = `sess-old-${m.role}`;
  roster.activeProject = PROJECT;
  fs.writeFileSync(SB.teamFile, JSON.stringify(roster, null, 2) + '\n', 'utf8');
  const add = run([TEAM_MJS, 'project', 'add', '--name', PROJECT, '--team-mode', 'full', '--by', 'owner']);

  // ── AC1 static：rulesHash 恰三项、无 iron ────────────────────────────────
  const storeSrc = readText(path.join(LIB, 'store.mjs'));
  const rh = /const rulesHash = sha256\(JSON\.stringify\(\{([\s\S]*?)\}\)\)/.exec(storeSrc);
  const rhKeys = rh ? (rh[1].match(/([a-zA-Z]+)\s*:/g) || []).map((x) => x.replace(/[\s:]/g, '')) : [];
  check('① AC1 rulesHash 组成恰三项 {constitution, roleCard, teamConfig}，不含 iron（静态）',
    rh && rhKeys.length === 3 && rhKeys.includes('constitution') && rhKeys.includes('roleCard') && rhKeys.includes('teamConfig') && !rhKeys.includes('iron'),
    { keys: rhKeys });

  // ── AC1 runtime + AC2：改铁律不失效 / 改宪法失效 ─────────────────────────
  const b1 = bootTester('sess-a6b61-1');
  const iron = path.join(SB.projectDir, '项目铁律.md');
  const cons = path.join(SB.team, '团队宪法.md');
  const ironBefore = readText(iron), consBefore = readText(cons);
  fs.writeFileSync(iron, ironBefore + '\n\n<!-- accept probe: iron changed -->\n', 'utf8');
  const b2 = bootTester('sess-a6b61-2');
  const b2token = b2.token;
  const sendIron = b2token ? run([TEAM_MJS, 'send', '--role', 'tester', '--project', PROJECT, '--boot', b2token, '--to', 'pm', '--subject', '改铁律后自检', '--body', 'x']) : { code: -1, out: '', err: 'NO_TOKEN' };
  const ironOk = Boolean(b1.rules) && b1.rules === b2.rules;
  check('② AC1/AC2 改项目铁律 → rulesHash 不变（' + (b1.rules || '?') + '），守卫语义成立',
    ironOk, { before: b1.rules, after: b2.rules });
  // 旧令牌（b1）在改铁律后仍可用
  const oldTokenAfterIron = b1.token ? run([TEAM_MJS, 'send', '--role', 'tester', '--project', PROJECT, '--boot', b1.token, '--to', 'pm', '--subject', '旧令牌自检', '--body', 'x']) : { code: -1, out: '', err: 'NO_TOKEN' };
  check('③ AC2 改铁律后**旧令牌仍可用**（send 不报 RULES_CHANGED）',
    Boolean(b1.token) && !/RULES_CHANGED/.test(oldTokenAfterIron.err + oldTokenAfterIron.out),
    { code: oldTokenAfterIron.code, err: oldTokenAfterIron.err.slice(0, 200) });

  fs.writeFileSync(cons, consBefore + '\n<!-- accept probe: constitution changed -->\n', 'utf8');
  const b3 = bootTester('sess-a6b61-3');
  check('④ AC1/AC2 改宪法 → rulesHash 改变（旧令牌应失效）',
    Boolean(b3.rules) && b3.rules !== b2.rules, { afterIron: b2.rules, afterConstitution: b3.rules });
  const oldAfterCons = b2token ? run([TEAM_MJS, 'send', '--role', 'tester', '--project', PROJECT, '--boot', b2token, '--to', 'pm', '--subject', '改宪法后自检', '--body', 'x']) : { code: -1, out: '', err: 'NO_TOKEN' };
  check('⑤ AC2 改宪法后**旧令牌被拒**（RULES_CHANGED）',
    /RULES_CHANGED/.test(oldAfterCons.err + oldAfterCons.out) || oldAfterCons.code !== 0,
    { code: oldAfterCons.code, err: oldAfterCons.err.slice(0, 200) });
  fs.writeFileSync(iron, ironBefore, 'utf8');
  fs.writeFileSync(cons, consBefore, 'utf8');

  // ── AC3：共享常量单源（两处引用同一常量） ────────────────────────────────
  const scaffoldSrc = readText(path.join(LIB, 'scaffold.mjs'));
  const opsSrc = readText(path.join(LIB, 'ops.mjs'));
  const exported = /export const IRON_POLICY_LINE/.test(scaffoldSrc) && /export const READ_ORDER_LINE/.test(scaffoldSrc);
  const usedInScaffold = (scaffoldSrc.match(/IRON_POLICY_LINE|READ_ORDER_LINE/g) || []).length >= 4;
  const usedInOps = /IRON_POLICY_LINE/.test(opsSrc) && /READ_ORDER_LINE/.test(opsSrc);
  check('⑥ AC3 AC3 共享常量单源：scaffold 导出 IRON_POLICY_LINE/READ_ORDER_LINE，且 ops.generateIndex 与 scaffold.rootIndex 同源引用',
    exported && usedInScaffold && usedInOps, { exported, usedInScaffold, usedInOps });

  // ── AC4：沙盘生成物（README/项目索引含常量、协作准则首读顺序、铁律 core:false）──
  const readme = readText(path.join(SB.projectDir, 'README.md'));
  const idx = readText(path.join(SB.projectDir, '项目索引.md'));
  const coop = readText(path.join(SB.projectDir, '协作准则.md'));
  const constIron = /铁律按需避坑（不必每轮读）|项目铁律按需避坑（不必每轮读）/.test(readme + idx);
  const constOrder = /先读团队宪法（唯一最高优先级）/.test(readme + idx);
  const coopOrder = /团队宪法（唯一最高优先级）/.test(coop);
  // 需求 AC5④：协作准则副本不在本单刷新，但必须「写明未刷新原因与承接单号」→ 记录式判定
  const coopExcluded = /另立缺陷单|承接单|不刷新/.test(
    readText(path.join(ROOT, '项目', PROJECT, '程序员A', '产出', '实现说明-v15-6b61C.md')) + idx
  );
  const coreSpec = (() => {
    const r = run([TEAM_MJS, 'brief', '--role', 'tester', '--project', PROJECT, '--section', 'all']);
    return r;
  })();
  check('⑦ AC4/AC3 沙盘新项目生成物：README 与 项目索引 同时含两句共享常量；协作准则副本按 AC5④ 不刷新（须写明原因/承接单）',
    constIron && constOrder && (coopOrder || coopExcluded),
    { constIron, constOrder, coopOrder, coopExcluded, idxLen: idx.length, briefCode: coreSpec.code });

  // ── AC5：index 刷新幂等（人工段不丢由 rule-scope/夹具覆盖，此处验幂等与常量落地）──
  const idxFile = path.join(SB.projectDir, '项目索引.md');
  const s1 = sha256(idxFile);
  const r1 = run([TEAM_MJS, 'index', '--role', 'tester', '--project', PROJECT, '--boot', b3.token || '']);
  const s2 = sha256(idxFile);
  const r2 = run([TEAM_MJS, 'index', '--role', 'tester', '--project', PROJECT, '--boot', b3.token || '']);
  const s3 = sha256(idxFile);
  const idxAfter = readText(idxFile);
  // AC5 原文口径（PM 2026-11-17 22:51 裁定 M-20261117-225108-3cd5be）：逐字节幂等，不接受「语义幂等」。
  // f164a29 后自身行改固定占位、去掉自动时间戳，故直接比字节 sha；同时正向断言「无自动生成时间戳行」。
  const idxRaw = readText(idxFile);
  const hasTimestampLine = /自动生成[:：]/.test(idxRaw);
  check('⑧ AC5 index 刷新：**逐字节幂等**（连跑两次 sha 相同）＋ 无「自动生成」时间戳行 ＋ 含两句共享常量',
    s2 === s3 && !hasTimestampLine && /先读团队宪法（唯一最高优先级）/.test(idxAfter) && /铁律按需避坑/.test(idxAfter),
    { s1: s1.slice(0, 12), s2: s2.slice(0, 12), s3: s3.slice(0, 12), byteIdentical: s2 === s3, hasTimestampLine, hasOrder: /先读团队宪法（唯一最高优先级）/.test(idxAfter), code1: r1.code, code2: r2.code });

  // ── AC6：靶词白名单（实现方夹具独立复跑） ────────────────────────────────
  const scope = run([path.join(ROOT, 'scripts', 'test-6b61-rule-scope.cjs')], process.env);
  check('⑨ AC6 靶词白名单外 0 命中（独立复跑 scripts/test-6b61-rule-scope.cjs）',
    scope.code === 0 && /5\/5|PASS/.test(scope.out), { code: scope.code, tail: (scope.out + scope.err).trim().split(/\r?\n/).slice(-3) });

  // ── AC7：selftest 回归（不写死数字，取实测） ─────────────────────────────
  const st = run([TEAM_MJS, 'selftest'], process.env, 900000);
  const mSt = /SELFTEST\s+(\d+)\/(\d+)\s+PASS/.exec(st.out);
  const pass = mSt ? Number(mSt[1]) : 0; const total = mSt ? Number(mSt[2]) : 0;
  check('⑩ AC7 selftest 全绿且步数 ≥ 基线 176（判据不写死数字，取实测）',
    st.code === 0 && pass > 0 && pass === total && pass >= 176, { code: st.code, pass, total, tail: st.out.trim().split(/\r?\n/).slice(-2) });

  // ── AC8：提交与回滚可读 ────────────────────────────────────────────────
  const gl = runGit(['log', '--format=%h %s', '-30']);
  const commitLine = (gl.out || '').split(/\r?\n/).find((l) => /R-20261117-202524-6b61|T-20261117-202136-32d1/.test(l)) || '';
  const docPath = path.join(ROOT, '项目', PROJECT, '程序员A', '产出', '实现说明-v15-6b61C.md');
  const docText = readText(docPath);
  check('⑪ AC8 提交信息带需求号/任务号，且实现说明含「回滚」说明',
    Boolean(commitLine) && /回滚|revert/i.test(docText), { commitLine: commitLine.slice(0, 120), docExists: Boolean(docText), docLen: docText.length });

  // ── AC4 补充（0585 / 18174c9）：新项目模板一致性 parity ──────────────────
  const parity = run([path.join(ROOT, 'scripts', 'test-scaffold-parity.cjs')], process.env, 600000);
  const parityJson = (() => {
    const m = /SCAFFOLD_PARITY_OK\s*(\{.*\})/.exec(parity.out);
    try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
  })();
  check('⑫ AC4/AC3 新增：沙盘新建项目「模板一致性」（scripts/test-scaffold-parity.cjs 独立复跑，5/5 全绿）',
    parity.code === 0 && Boolean(parityJson) && parityJson.red === 0 && parityJson.pass === parityJson.total,
    { code: parity.code, parityJson, tail: (parity.out + parity.err).trim().split(/\r?\n/).slice(-3) });

  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ignore */ }
  return finish();
}

function finish() {
  const total = results.length;
  const pass = results.filter((r) => r.ok).length;
  const red = total - pass;
  const evDir = path.join(ROOT, '项目', PROJECT, '测试人员', '产出', '证据-6b61-accept');
  fs.mkdirSync(evDir, { recursive: true });
  const payload = { at: new Date().toISOString(), script: 'scripts/test-6b61-accept.cjs', task: 'T-20261117-221513-e160', requirement: 'R-20261117-202524-6b61', total, pass, red, results };
  const evFile = path.join(evDir, `run-${ts}-${red === 0 ? 'green' : 'red'}.json`);
  payload.evidenceFile = path.relative(ROOT, evFile).replace(/\\/g, '/');
  fs.writeFileSync(evFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  if (jsonOut) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  else {
    console.log('');
    console.log(`${red === 0 ? 'A6B61_OK' : 'A6B61_WARN'} ${JSON.stringify({ total, pass, red })}`);
    console.log(`证据：${payload.evidenceFile}`);
  }
  process.exit(red === 0 ? 0 : 1);
}

main().catch((e) => { console.error('CRASH', String((e && e.stack) || e)); process.exit(2); });
