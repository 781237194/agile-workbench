#!/usr/bin/env node
'use strict';
/**
 * test-cfca-maintenance.cjs —— R-cfca（T-20261118-103529-ef3c）合并维护提醒回归夹具
 * AC1 类型/标题；AC2 边界 19/20/21 + 幂等 + 累计后再发；AC5 正文两问两命令 ≤600；
 * AC6 skill skip 三处留痕 + reason 必填零副作用；AC7 夜间不特例。沙盘隔离，真实状态零写入。
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const { execFileSync } = require('node:child_process');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const ROOT = path.resolve(__dirname, '..');
const SB = mkTempSandbox('cfca');
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TEAM_TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const PROJECT = 'cfca沙盘';

let pass = 0;
const results = [];
function ok(name, cond, detail) {
  results.push({ name, ok: Boolean(cond) });
  if (cond) { pass += 1; console.log('PASS  ' + name); return; }
  console.log('FAIL  ' + name + '  ' + JSON.stringify(detail || {}).slice(0, 320)); process.exitCode = 1;
}
const env = () => ({ ...process.env, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' });

(async () => {
  fs.mkdirSync(path.join(TEAM, '状态', '项目', PROJECT), { recursive: true });
  fs.mkdirSync(PROJECTS, { recursive: true });
  const teamSrc = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8'));
  for (const m of teamSrc.members || []) m.sessionId = '';
  teamSrc.activeProjectId = '';
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(teamSrc, null, 2) + '\n', 'utf8');
  // 沙盘补齐团队级文档（boot 会校验「团队宪法」等必读）
  for (const rel of ['团队宪法.md', '项目铁律.md']) {
    const src = path.join(ROOT, '团队', rel);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TEAM, rel));
  }
  for (const d of ['协议', '模板']) {
    const src = path.join(ROOT, '团队', d);
    if (fs.existsSync(src)) fs.cpSync(src, path.join(TEAM, d), { recursive: true });
  }
  const add = execFileSync(process.execPath, [TEAM_TOOL, 'project', 'add', '--name', PROJECT, '--team-mode', 'fast', '--json'], { env: env(), encoding: 'utf8', cwd: SB });
  ok('沙盘项目建立', /"ok":\s*true/.test(add), add.slice(0, 200));

  const stDir = path.join(TEAM, '状态', '项目', PROJECT);
  const registry = path.join(PROJECTS, PROJECT, '经验教训登记册.md');
  fs.mkdirSync(path.dirname(registry), { recursive: true });
  fs.writeFileSync(registry, '# 登记册\n\n## 高级程序员 A\n\n- L-1 场景A｜教训A｜下一步A\n', 'utf8');
  // 「有变更才发」门的退化判据：审计行增长（登记册 minimal 版解析为 broken，fileSha 路径不走）。
  const auditFile = path.join(TEAM, '状态', '经验教训审计.jsonl');
  const touchAudit = () => fs.appendFileSync(auditFile, JSON.stringify({ at: new Date().toISOString(), role: 'programmer1', action: 'append', note: 'fixture' }) + '\n');
  touchAudit();
  const turnsFile = path.join(stDir, '轮次计数.json');
  const setTurns = (n, extra = {}) => {
    fs.writeFileSync(turnsFile, JSON.stringify({
      version: 1, project: PROJECT,
      roles: { programmer1: { turns: n, lastAt: new Date().toISOString(), sessionId: '', lastNotifiedAt: null, lastNoticeSha: null, lastMaintenanceRounds: null, lastMaintenanceAt: null, ...extra } },
    }, null, 2) + '\n', 'utf8');
  };
  setTurns(0);

  const L = await import(pathToFileURL(path.join(ROOT, '团队', '工具', 'lib', 'lessons.mjs')).href);
  const sent = [];
  const sendNotice = (msg) => { sent.push(msg); return { ok: true, messageId: 'M-test-' + sent.length }; };
  const nowAt = (h) => ({ at: new Date(`2026-11-18T${String(h).padStart(2, '0')}:30:00.000+08:00`), localHour: h });
  // bumpSeen 按 commit|role|actionType 去重：每次拍换一个计数动作，避免测试自己被去重
  const ACTIONS = ['send', 'ack', 'task done', 'req review'];
  let actIdx = 0;
  let commitIdx = 0;
  const bump = (opts = {}) => {
    // bumpSeen 按 commit|role|actionType 去重：每次拍开一个新业务事务，模拟真实命令边界
    if (typeof L.beginBusinessCommit === 'function') L.beginBusinessCommit('cfca-' + (commitIdx += 1));
    return L.bumpTurns({
    stateDir: stDir, teamRoot: TEAM, role: 'programmer1',
    actionType: opts.actionType || ACTIONS[(actIdx += 1) % ACTIONS.length],
    projectName: PROJECT, projectDir: path.join(PROJECTS, PROJECT),
    sendNotice, configPath: path.join(stDir, '项目.json'),
    now: opts.now || nowAt(14), ...opts,
  });
  };

  // AC2① turns=19 → 不发
  setTurns(18);
  let r = bump();
  ok('AC2① turns=19 → 0 条', r.turns === 19 && r.prompt && r.prompt.action === 'none' && sent.length === 0, { turns: r.turns, prompt: r.prompt, sent: sent.length });

  // AC2③ turns=20 → 不发（严格大于阈值）
  setTurns(19); fs.appendFileSync(registry, '- L-2 场景B｜教训B｜下一步B\n');
  r = bump();
  ok('AC2③ turns=20 → 0 条（严格大于阈值才发）', r.turns === 20 && r.prompt && r.prompt.action === 'none' && sent.length === 0, { turns: r.turns, prompt: r.prompt, sent: sent.length });

  // AC2② turns=21 + 登记册变更（审计行增长）→ 1 条
  setTurns(20); fs.appendFileSync(registry, '- L-3 场景C｜教训C｜下一步C\n'); touchAudit();
  r = bump();
  const msg = sent[0] || null;
  ok('AC2② turns=21 → 1 条', r.turns === 21 && r.prompt.action === 'prompt' && sent.length === 1, { turns: r.turns, prompt: r.prompt, sent: sent.length });
  ok('AC1 类型/标题 = maintenance_prompt + 第 21 轮', Boolean(msg) && msg.type === 'maintenance_prompt' && /^维护提醒：skill 与经验教训（第 21 轮）$/.test(String(msg.subject || '')), msg);
  ok('AC5 正文含两问两命令且 ≤600 字',
    Boolean(msg) && /skill/.test(msg.body) && /经验教训/.test(msg.body) && /skill skip --reason/.test(msg.body) && /lessons read/.test(msg.body) && String(msg.body).length <= 600,
    { len: msg ? String(msg.body).length : 0 });

  const after = JSON.parse(fs.readFileSync(turnsFile, 'utf8')).roles.programmer1;
  ok('累计：发后 turns 不归零、lastMaintenanceRounds=21', after.turns === 21 && after.lastMaintenanceRounds === 21, after);

  // AC2④ 连续计数动作（22/23，期间不改登记册/不加审计）→ 仍只有 1 条，lastMaintenanceRounds 不变
  const before = sent.length;
  bump(); bump();
  const after2 = JSON.parse(fs.readFileSync(turnsFile, 'utf8')).roles.programmer1;
  ok('AC2④ 连续 2 次计数动作（turns 22→23，无变更）→ 不发第二条且 lastMaintenanceRounds 仍 21',
    sent.length === before && after2.turns === 23 && after2.lastMaintenanceRounds === 21,
    { sent: sent.length, turns: after2.turns, lm: after2.lastMaintenanceRounds });

  // AC2⑤ turns=22 + 登记册再变（审计行增长）→ 再 1 条（累计递增）
  setTurns(21); fs.appendFileSync(registry, '- L-4 场景D｜教训D｜下一步D\n'); touchAudit();
  r = bump();
  ok('AC2⑤ turns=22 + 登记册再变 → 再 1 条（第 22 轮）', r.turns === 22 && sent.length === 2 && /第 22 轮/.test(String(sent[1].subject || '')), { turns: r.turns, sent: sent.length, subject: sent[1] && sent[1].subject });

  // AC7① 夜间 23:30 照发
  setTurns(23); fs.appendFileSync(registry, '- L-5 场景E｜教训E｜下一步E\n'); touchAudit();
  const nightBefore = sent.length;
  r = bump({ now: nowAt(23) });
  ok('AC7① 23:30 turns=24 → 照发（无夜间静默）', Boolean(r.prompt) && r.prompt.action === 'prompt' && sent.length === nightBefore + 1, { prompt: r.prompt, sent: sent.length });

  // AC6 skill skip：三处留痕 + reason 必填零副作用
  const broadcast = path.join(TEAM, '状态', '经验教训广播.jsonl');
  const maint = path.join(stDir, '维护评估.jsonl');
  const skillEval = path.join(stDir, 'skill评估.jsonl');
  const count = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).length : 0);
  const run = (args) => {
    try { return { code: 0, out: String(execFileSync(process.execPath, [TEAM_TOOL, ...args], { env: env(), encoding: 'utf8', cwd: SB })) }; }
    catch (e) { return { code: e.status == null ? 1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
  };
  let token = '';
  const bootOut = run(['boot', '--role', 'programmer1', '--project', PROJECT, '--json']);
  try { token = String(JSON.parse(bootOut.out.slice(bootOut.out.indexOf('{'))).token || ''); } catch { token = ''; }
  ok('AC6 前置：沙盘 boot 拿到令牌', Boolean(token), { code: bootOut.code, out: bootOut.out.slice(-160) });
  // 计数基线在 boot 之后取：boot 本身会写一条 skill 评估 prompt 行（既有行为，不属本次 skip）。
  const b0 = count(broadcast), m0 = count(maint), s0 = count(skillEval);
  const skip = run(['skill', 'skip', '--boot', token, '--reason', '已评估', '--json']);
  ok('AC6① skill skip → 三处各增 1 行', skip.code === 0 && count(broadcast) === b0 + 1 && count(maint) === m0 + 1 && count(skillEval) === s0 + 1,
    { code: skip.code, b: [b0, count(broadcast)], m: [m0, count(maint)], s: [s0, count(skillEval)], out: skip.out.slice(-200) });

  const b1 = count(broadcast), m1 = count(maint), s1 = count(skillEval);
  const bad = run(['skill', 'skip', '--boot', token, '--json']);
  ok('AC6② 无 reason → SKILL_SKIP_REASON_REQUIRED 且三处零新增',
    bad.code !== 0 && /SKILL_SKIP_REASON_REQUIRED/.test(bad.out) && count(broadcast) === b1 && count(maint) === m1 && count(skillEval) === s1,
    { code: bad.code, out: bad.out.slice(-200) });
  const blank = run(['skill', 'skip', '--boot', token, '--reason', '   ', '--json']);
  ok('AC6③ 空白 reason 同样被拒', blank.code !== 0 && /SKILL_SKIP_REASON_REQUIRED/.test(blank.out), { code: blank.code, out: blank.out.slice(-120) });
  const maintRow = fs.readFileSync(maint, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)).pop();
  ok('AC6 维护评估.jsonl 字段齐（role/rounds/reason/action）',
    maintRow && maintRow.role === 'programmer1' && Number.isFinite(Number(maintRow.rounds)) && maintRow.reason === '已评估' && maintRow.action === 'skip', maintRow);

  fs.rmSync(SB, { recursive: true, force: true });
  const report = { task: 'T-20261118-103529-ef3c', at: new Date().toISOString(), total: results.length, pass, red: results.length - pass, results };
  const outEnv = process.env.AWB_CFCA_OUT || path.join('_tmp', 'run-cfca.json');
  const outFile = path.isAbsolute(outEnv) ? outEnv : path.join(ROOT, outEnv);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`\nCFCA_MAINTENANCE ${JSON.stringify({ total: report.total, pass: report.pass, red: report.red })}`);
  console.log('证据：' + outFile);
  process.exit(report.red ? 1 : 0);
})().catch((e) => { console.error('CFCA_FIXTURE_FAILED ' + String((e && e.stack) || e)); process.exit(2); });
