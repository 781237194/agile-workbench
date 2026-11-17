#!/usr/bin/env node
/**
 * T-20261117-210825-6010（P1，测试）：R-bcae 技能机制独立验收（新项目/GitHub 下载用户视角）
 *
 * 需求：需求/R-20261117-183032-bcae-团队技能固化.md（15548B / sha 4c908386c0b7）
 * 验 7 件：①boot 必读 skill 索引 ②30 分钟提示 + skip 必带 reason + append-only
 *          ③四要素校验 ④防篡改钩子 ⑤新项目分发（6 主题模板 + 清单 sha）⑥CLI ⑦真实零写入
 * 用法：node scripts/test-bcae-skill-accept.cjs [--json]
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
const SKILL_DIR = path.join(TEAM, 'skill', '基础流程');
const MANIFEST = path.join(SKILL_DIR, 'skill-manifest.json');
const TPL_DIR = path.join(TEAM, '工具', '模板', 'skill');
const SKILL_LIST = path.join(TEAM, '状态', '技能清单.json');
const STATE = path.join(TEAM, '状态', '项目', PROJECT);
const TEAM_MJS = path.join(TEAM, '工具', 'team.mjs');
const ROLE_SKILLS = ['pm.md', 'product.md', 'analyst.md', 'programmer1.md', 'programmer2.md', 'tester.md'];
const TOPIC_TPL = ['mission-and-receipt', 'boot-and-rules', 'evidence-and-acceptance', 'wake-and-dispatch', 'sandbox-isolation', 'handover-and-rotate'];
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const SANDBOX = path.join(ROOT, '_tmp', `bcae-skill-${process.pid}-${Date.now().toString(36)}`);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!jsonOut) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
  return Boolean(ok);
}
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
const snapDir = (dir) => { const out = {}; if (!fs.existsSync(dir)) return out; for (const f of fs.readdirSync(dir)) { const p = path.join(dir, f); if (fs.statSync(p).isFile()) out[f] = sha(p); } return out; };
const run = (args, env, cwd = ROOT) => {
  const r = spawnSync(process.execPath, args, { cwd, env: env || process.env, encoding: 'utf8', timeout: 180000 });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
};

async function main() {
  const realBefore = { skill: snapDir(SKILL_DIR), state: snapDir(STATE), list: sha(SKILL_LIST), manifest: sha(MANIFEST) };
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(path.join(SANDBOX, 'data'), { recursive: true });
  fs.mkdirSync(path.join(SANDBOX, '项目'), { recursive: true });
  // 沙盘团队：复制登记册/规则/模板（排除 邮箱/锁/备份/状态项目），sessionId 全清
  const sbTeam = path.join(SANDBOX, '团队');
  (function copyDir(src, dst, filter) {
    fs.mkdirSync(dst, { recursive: true });
    for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
      const a = path.join(src, ent.name), b = path.join(dst, ent.name);
      if (filter && filter(a)) continue;
      if (ent.isDirectory()) copyDir(a, b, filter); else fs.copyFileSync(a, b);
    }
  })(TEAM, sbTeam, (p) => /[\\/]邮箱([\\/]|$)/.test(p) || /[\\/]锁([\\/]|$)/.test(p) || /[\\/]备份([\\/]|$)/.test(p) || /[\\/]状态[\\/]项目([\\/]|$)/.test(p));
  fs.mkdirSync(path.join(sbTeam, '状态', '项目'), { recursive: true });
  fs.mkdirSync(path.join(sbTeam, '状态', '邮箱'), { recursive: true });
  const roster = readJson(path.join(sbTeam, '状态', '团队.json'), { members: [] });
  for (const m of (roster.members || [])) m.sessionId = `sess-old-${m.role}`;
  roster.activeProject = PROJECT;
  writeJson(path.join(sbTeam, '状态', '团队.json'), roster);
  const sbEnv = {
    ...process.env, AWB_DATA_DIR: path.join(SANDBOX, 'data'),
    TEAM_ROOT: sbTeam, TEAM_PROJECTS_ROOT: path.join(SANDBOX, '项目'),
    TEAM_WORKBENCH_JSON: path.join(SANDBOX, 'data', 'workbench.json'), TEAM_SELFTEST: '1',
  };
  const addProj = run([TEAM_MJS, 'project', 'add', '--name', PROJECT, '--team-mode', 'full', '--by', 'owner'], sbEnv);
  const bootR = run([TEAM_MJS, 'boot', '--role', 'tester', '--project', PROJECT, '--session', 'sess-bcae-accept'], sbEnv);
  const token = (() => { const m = /令牌[:：]\s*([0-9a-f]+)/.exec(bootR.out); return m ? m[1] : ''; })();

  // ① 分发面：6 角色 skill + 索引 + manifest，且 sha 与清单一致（GitHub 用户解包即可用）
  const manifest = readJson(MANIFEST, null);
  const files = (manifest && manifest.files) || {};
  const shaMismatch = Object.keys(files).filter((rel) => sha(path.join(SKILL_DIR, rel)) !== files[rel]);
  check('① 基础流程 skill 已随仓库分发：6 角色 skill + 00-索引 + manifest，且每个文件 sha 与清单一致',
    Boolean(manifest) && ROLE_SKILLS.every((f) => fs.existsSync(path.join(SKILL_DIR, f))) && fs.existsSync(path.join(SKILL_DIR, '00-索引.md')) && shaMismatch.length === 0,
    { manifestExists: Boolean(manifest), missing: ROLE_SKILLS.filter((f) => !fs.existsSync(path.join(SKILL_DIR, f))), shaMismatch });

  // ② AC6：公共模板目录 + 6 个主题模板
  const tplExists = fs.existsSync(TPL_DIR);
  const tplFiles = tplExists ? fs.readdirSync(TPL_DIR).filter((f) => f.endsWith('.md')) : [];
  const topicHit = TOPIC_TPL.filter((t) => tplFiles.some((f) => f.includes(t)));
  // PM 2026-11-17 21:49 裁定（M-20261117-214942-df5cae）：ac6 口径变更——接受 6 个**角色快照**模板
  // （analyst/pm/product/programmer1/programmer2/tester），不再要求 6 个主题名；按「现状为基准」判过并留痕。
  const roleSnap = ['analyst', 'pm', 'product', 'programmer1', 'programmer2', 'tester'];
  const roleHit = roleSnap.filter((r) => tplFiles.some((f) => f === `${r}.md`));
  check('② AC6 公共模板 `团队/工具/模板/skill/` 含 6 个模板（按 PM 裁定：6 个角色快照即可；主题名形态亦接受）',
    tplExists && (roleHit.length === 6 || topicHit.length === 6),
    { tplDirExists: tplExists, tplFiles, matchedTopics: topicHit, matchedRoles: roleHit, ruling: 'M-20261117-214942-df5cae：AC6 按现状（角色快照）判通过' });

  // ③ AC5：模板锁定清单 + skill verify + skill template write 三件（用沙盘有效令牌，避免「无效令牌也报非 BAD_ACTION」的假绿）
  check('③ AC5 锁定清单 `团队/状态/技能清单.json` 存在', fs.existsSync(SKILL_LIST), { path: path.relative(ROOT, SKILL_LIST).replace(/\\/g, '/') });
  const vfy = token ? run([TEAM_MJS, 'skill', 'verify', '--role', 'tester', '--project', PROJECT, '--boot', token], sbEnv) : { code: -1, out: '', err: 'NO_TOKEN' };
  check('③b AC5 `skill verify` 子命令可用（篡改检出入口）',
    Boolean(token) && !/BAD_ACTION|只支持 status/.test(vfy.err + vfy.out),
    { token: Boolean(token), code: vfy.code, out: vfy.out.slice(0, 160), err: vfy.err.slice(0, 200) });
  const tplCmd = token ? run([TEAM_MJS, 'skill', 'template', 'write', '--role', 'tester', '--project', PROJECT, '--boot', token], sbEnv) : { code: -1, out: '', err: 'NO_TOKEN' };
  check('③c AC5 `skill template write` 唯一写入入口存在',
    Boolean(token) && !/BAD_ACTION|只支持 status/.test(tplCmd.err + tplCmd.out),
    { token: Boolean(token), code: tplCmd.code, out: tplCmd.out.slice(0, 160), err: tplCmd.err.slice(0, 200) });

  // ④ 防篡改钩子：npm run test:skill 四个脚本（真跑）
  const hooks = ['scripts/skill-check.cjs', 'scripts/test-bcae-skill-tamper.cjs', 'scripts/test-bcae-skill-boot.cjs', 'scripts/test-bcae-skill-step2.cjs'];
  const hookRuns = hooks.map((h) => ({ h, ...run([h], process.env) }));
  check('④ 防篡改钩子：skill-check + tamper + boot + step2 四个自检全部 exit 0',
    hookRuns.every((r) => r.code === 0),
    { runs: hookRuns.map((r) => ({ script: r.h, code: r.code, tail: (r.out + r.err).trim().split(/\r?\n/).slice(-2).join(' | ').slice(0, 160) })) });

  // ⑤ CLI：status / skip（缺 reason 拒、有 reason 写 append-only）/ check（缺段拒、合格过）
  check('⑤ 新会话 boot 成功且简报含 skill 索引行（boot 必读集成）',
    bootR.code === 0 && Boolean(token) && /skill[:：]/.test(bootR.out) && /00-索引\.md/.test(bootR.out),
    { bootCode: bootR.code, projectAdd: addProj.code, skillLine: (bootR.out.split(/\r?\n/).find((l) => /skill[:：]/.test(l)) || '').slice(0, 200), bootErr: bootR.err.slice(0, 200) });
  const status = token ? run([TEAM_MJS, 'skill', 'status', '--role', 'tester', '--project', PROJECT, '--boot', token], sbEnv) : { code: -1, out: '', err: 'NO_TOKEN' };
  check('⑤b `skill status` 可用（exit 0）', status.code === 0, { code: status.code, out: status.out.slice(0, 160), err: status.err.slice(0, 160) });
  const skipNoReason = token ? run([TEAM_MJS, 'skill', 'skip', '--role', 'tester', '--project', PROJECT, '--boot', token], sbEnv) : { code: 0, out: '', err: '' };
  check('⑤c `skill skip` 缺 --reason 必须拒（SKILL_SKIP_REASON_REQUIRED）',
    skipNoReason.code !== 0 && /SKILL_SKIP_REASON_REQUIRED/.test(skipNoReason.err + skipNoReason.out),
    { code: skipNoReason.code, err: skipNoReason.err.slice(0, 200) });
  const evalFile = path.join(SANDBOX, '团队', '状态', '项目', PROJECT, 'skill评估.jsonl');
  const before = fs.existsSync(evalFile) ? fs.readFileSync(evalFile, 'utf8').split(/\r?\n/).filter(Boolean).length : 0;
  const skipOk = token ? run([TEAM_MJS, 'skill', 'skip', '--role', 'tester', '--project', PROJECT, '--boot', token, '--reason', '验收测试跳过'], sbEnv) : { code: -1, out: '', err: 'NO_TOKEN' };
  const after = fs.existsSync(evalFile) ? fs.readFileSync(evalFile, 'utf8').split(/\r?\n/).filter(Boolean).length : 0;
  const lastRow = (() => { try { const ls = fs.readFileSync(evalFile, 'utf8').split(/\r?\n/).filter(Boolean); return JSON.parse(ls[ls.length - 1]); } catch { return null; } })();
  check('⑤d `skill skip --reason` 成功且 append-only 落 skill评估.jsonl（行数 +1，含 reason）',
    skipOk.code === 0 && after === before + 1 && String((lastRow && lastRow.reason) || '').includes('验收测试跳过'),
    { code: skipOk.code, before, after, lastRow, err: skipOk.err.slice(0, 200) });

  // ⑥ 四要素校验（skill check --file）
  const badFile = path.join(SANDBOX, 'bad-skill.md');
  fs.writeFileSync(badFile, '# 标题\n\n## 适用场景\n场景\n\n## 步骤\n1. a\n', 'utf8');   // 缺判据/反例
  const chkBad = token ? run([TEAM_MJS, 'skill', 'check', '--role', 'tester', '--project', PROJECT, '--boot', token, '--file', badFile], sbEnv) : { code: 0, out: '', err: '' };
  check('⑥ `skill check --file` 对缺段文件拒收（SKILL_FORMAT_INCOMPLETE）',
    chkBad.code !== 0 && /SKILL_FORMAT_INCOMPLETE|缺项|缺/.test(chkBad.err + chkBad.out),
    { code: chkBad.code, out: chkBad.out.slice(0, 200), err: chkBad.err.slice(0, 200) });
  const goodFile = path.join(SKILL_DIR, 'tester.md');
  const chkGood = token ? run([TEAM_MJS, 'skill', 'check', '--role', 'tester', '--project', PROJECT, '--boot', token, '--file', goodFile], sbEnv) : { code: -1, out: '', err: 'NO_TOKEN' };
  check('⑥b `skill check --file` 对仓库内合格 skill 通过（exit 0）',
    chkGood.code === 0,
    { code: chkGood.code, out: chkGood.out.slice(0, 200), err: chkGood.err.slice(0, 200) });

  // ⑦ 真实零写入
  const realAfter = { skill: snapDir(SKILL_DIR), state: snapDir(STATE), list: sha(SKILL_LIST), manifest: sha(MANIFEST) };
  const same = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  check('⑦ 真实 团队/skill 与 团队/状态 关键文件 sha 前后不变（沙盘零写入）',
    same(realBefore.skill, realAfter.skill) && realBefore.list === realAfter.list && realBefore.manifest === realAfter.manifest,
    { skillChanged: Object.keys(realBefore.skill).filter((k) => realBefore.skill[k] !== realAfter.skill[k]), list: [realBefore.list.slice(0, 12), realAfter.list.slice(0, 12)], manifestSame: realBefore.manifest === realAfter.manifest });

  // ⑧ AC10 自检入口（提交 95952ca）：skill check --selftest 免令牌可跑、首行 SKILL_CHECK_OK、九条断言全过
  const selftest = run([TEAM_MJS, 'skill', 'check', '--selftest'], process.env);
  const selftestJson = (() => {
    const m = /SKILL_CHECK_OK\s*(\{[\s\S]*\})/.exec(selftest.out);
    try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
  })();
  const checks = (selftestJson && selftestJson.checks) || [];
  check('⑧ AC10 自检入口 `skill check --selftest` 可用：首行 SKILL_CHECK_OK、九条 AC 断言全过、声明零写入真实状态',
    selftest.code === 0 && /^\s*SKILL_CHECK_OK/.test(selftest.out.trim()) && checks.length >= 9 && checks.every((c) => c && c.ok === true)
    && Boolean(selftestJson && selftestJson.realBefore),
    { code: selftest.code, checks: checks.map((c) => `${c.ac}:${c.ok}`), tail: selftest.out.trim().split(/\r?\n/).slice(-2) });

  // ⑨ AC2：boot 必读 9→10，含 skill 索引项（读沙盘 工作流.json 的 boots[role].docs）
  const wf = readJson(path.join(sbTeam, '状态', '项目', PROJECT, '工作流.json'), null)
    || readJson(path.join(SANDBOX, '项目', PROJECT, '工作流.json'), null);
  const boots = (wf && wf.boots) || {};
  const bootDocs = Object.values(boots).map((b) => Object.keys((b && b.docs) || {})).filter((k) => k.length);
  const tenDocs = bootDocs.length > 0 && bootDocs.every((k) => k.length === 10);
  const hasSkillKey = bootDocs.length > 0 && bootDocs.every((k) => k.some((x) => /skill/i.test(x)));
  check('⑨ AC2 boot 必读 9→10：每角色 docs 恰 10 项且含 skill 索引项',
    tenDocs && hasSkillKey,
    { bootRoles: Object.keys(boots).length, sampled: bootDocs.slice(0, 2), tenDocs, hasSkillKey, wfPath: path.join(sbTeam, '状态', '项目', PROJECT, '工作流.json') });

  // ⑩ AC3/AC4/AC8（提交 ee3b311）：独立复跑实现方夹具 test-bcae-ac348.cjs（7 条：盘点先行/四条件/PM 提示去重）
  const ac348 = run([path.join(ROOT, 'scripts', 'test-bcae-ac348.cjs')], process.env);
  const ac348Json = (() => {
    const m = /BCAE_AC348\s*(\{.*\})/.exec(ac348.out);
    try { return m ? JSON.parse(m[1]) : null; } catch { return null; }
  })();
  check('⑩ AC3/AC4/AC8 独立复跑：盘点先行（SKILL_INVENTORY_REQUIRED）/四条件（ARGS+REASON）/PM 提示按 sessionId 去重（ac348 7/7）',
    ac348.code === 0 && Boolean(ac348Json) && ac348Json.pass === ac348Json.total && ac348Json.red === 0,
    { code: ac348.code, ac348Json, tail: (ac348.out + ac348.err).trim().split(/\r?\n/).slice(-2) });

  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ignore */ }
  return finish(realBefore, realAfter);
}

function finish(realBefore, realAfter) {
  const total = results.length;
  const pass = results.filter((r) => r.ok).length;
  const red = total - pass;
  const evDir = path.join(ROOT, '项目', PROJECT, '测试人员', '产出', '证据-bcae-skill-accept');
  fs.mkdirSync(evDir, { recursive: true });
  const payload = { at: new Date().toISOString(), script: 'scripts/test-bcae-skill-accept.cjs', task: 'T-20261117-210825-6010', requirement: 'R-20261117-183032-bcae', total, pass, red, results, realFiles: { before: realBefore, after: realAfter } };
  const evFile = path.join(evDir, `run-${ts}-${red === 0 ? 'green' : 'red'}.json`);
  payload.evidenceFile = path.relative(ROOT, evFile).replace(/\\/g, '/');
  fs.writeFileSync(evFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  if (jsonOut) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  else {
    console.log('');
    console.log(`${red === 0 ? 'BCAE_SKILL_OK' : 'BCAE_SKILL_WARN'} ${JSON.stringify({ total, pass, red })}`);
    console.log(`证据：${payload.evidenceFile}`);
  }
  process.exit(red === 0 ? 0 : 1);
}

main().catch((e) => { console.error('CRASH', String((e && e.stack) || e)); process.exit(2); });
