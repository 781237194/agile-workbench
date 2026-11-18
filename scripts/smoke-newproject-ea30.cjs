#!/usr/bin/env node
'use strict';
/**
 * 上线前风险烟测（Owner 2026-11-18 22:51：担心模板改动导致「新项目面板/boot 异常」）：
 *
 * 真实走一遍新项目链路（全部在 _tmp 沙盘，不碰真实团队/项目）：
 *   ① 复制真实 团队/状态 + 团队宪法 + 项目铁律 到沙盘（模拟新用户环境）
 *   ② `team.mjs project add --name 冒烟新项目` → 用 scaffold 真实生成新项目（六卡/铁律/索引）
 *   ③ 断言：六张角色卡 + 项目铁律 + 索引等关键文件存在，且含现行工作流六条款（验收/代管/工装安全/测量窗口/文档维护/skill 升版）
 *   ④ 断言：`boot --role pm` 与 `boot --role analyst` 都能成功（= 新项目 boot 不异常；缺文件会 MISSING_DOC）
 *   ⑤ 记录 project add / boot 的真实 stdout、断言结果，产出 JSON 供 Owner/PM 复核
 *
 * 跑法：node scripts/smoke-newproject-ea30.cjs
 * 产出：项目/工作台改造修复/程序员A/产出/证据-ea30/smoke-newproject.json
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const EV = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-ea30');
const SB = path.join(ROOT, '_tmp', `smoke-ea30-${process.pid}-${Date.now().toString(36)}`);
const PROJ = '冒烟新项目';
const ROLES = ['项目经理', '产品', '需求分析师', '程序员A', '程序员B', '测试人员'];
const KEYWORDS = ['验收', '代管', '工装安全', '测量窗口', '文档维护', 'skill 升版'];
const results = [];
const ok = (cond, name, detail) => { results.push({ name, ok: Boolean(cond), detail: cond ? undefined : detail }); console.log(`${cond ? 'PASS' : 'FAIL'}  ${name}${cond ? '' : ' · ' + JSON.stringify(detail)}`); if (!cond) process.exitCode = 1; };

function run(args, env) {
  const r = spawnSync(process.execPath, [path.join(ROOT, '团队', '工具', 'team.mjs'), ...args], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 180000,
  });
  return { status: r.status, stdout: String(r.stdout || '').trim(), stderr: String(r.stderr || '').trim() };
}
function copyDir(src, dst) { fs.mkdirSync(dst, { recursive: true }); for (const e of fs.readdirSync(src, { withFileTypes: true })) { const a = path.join(src, e.name); const b = path.join(dst, e.name); if (e.isDirectory()) copyDir(a, b); else fs.copyFileSync(a, b); } }

function main() {
  fs.mkdirSync(EV, { recursive: true });
  const TEAM = path.join(SB, '团队');
  // 新项目必须落在「团队区」内（ops.mjs PROJECT_OUTSIDE 校验），所以放到沙盘 团队/项目区/。
  const PROJROOT = path.join(TEAM, '项目区');
  const PROJDIR = path.join(PROJROOT, PROJ);
  fs.mkdirSync(PROJDIR, { recursive: true });
  // ① 沙盘团队：状态 + 宪法 + 项目铁律（不复制邮箱/锁，避免污染）
  copyDir(path.join(ROOT, '团队', '状态'), path.join(TEAM, '状态'));
  fs.rmSync(path.join(TEAM, '状态', '邮箱'), { recursive: true, force: true });
  fs.rmSync(path.join(TEAM, '状态', '锁'), { recursive: true, force: true });
  for (const f of ['团队宪法.md', '项目铁律.md']) {
    const src = path.join(ROOT, '团队', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TEAM, f));
  }
  const env = { ...process.env, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: path.join(TEAM, '状态', '项目'), TEAM_SELFTEST: '1', ELECTRON_RUN_AS_NODE: '1' };

  // ② project add（真实生成）
  const add = run(['project', 'add', '--name', PROJ, '--dir', PROJDIR], env);
  ok(add.status === 0, '① project add 成功（新项目真实生成）', { status: add.status, stderr: add.stderr.slice(-400) });
  const projDir = path.join(PROJROOT, PROJ);
  ok(fs.existsSync(projDir), '② 项目目录存在', { projDir });

  // ③ 六卡 + 铁律 + 条款
  const cardMiss = [];
  for (const dir of ROLES) {
    const p = path.join(projDir, dir, '角色卡.md');
    const t = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    const miss = KEYWORDS.filter((k) => t.indexOf(k) < 0);
    if (!t || miss.length) cardMiss.push({ dir, bytes: Buffer.byteLength(t), miss });
  }
  ok(cardMiss.length === 0, '③ 六张新角色卡存在且含六条款', cardMiss);
  const ironPath = path.join(projDir, '项目铁律.md');
  const iron = fs.existsSync(ironPath) ? fs.readFileSync(ironPath, 'utf8') : '';
  ok(/工装安全/.test(iron) && /skill 升版/.test(iron), '④ 新项目铁律含工装安全/skill 升版', { bytes: Buffer.byteLength(iron) });
  ok(fs.existsSync(path.join(projDir, '项目信息.md')) && fs.existsSync(path.join(projDir, '需求', 'README.md')), '⑤ 项目信息/需求池等关键文件齐全', {});

  // ④ boot（新项目 boot 不异常）
  const bootPm = run(['boot', '--role', 'pm', '--project', PROJ, '--session', 'smoke-pm'], env);
  ok(bootPm.status === 0 && /令牌/.test(bootPm.stdout + bootPm.stderr), '⑥ boot pm 成功（新项目 boot 不异常）', { status: bootPm.status, tail: (bootPm.stdout + bootPm.stderr).slice(-400) });
  const bootAna = run(['boot', '--role', 'analyst', '--project', PROJ, '--session', 'smoke-ana'], env);
  ok(bootAna.status === 0, '⑦ boot analyst 成功（含子代理/结构化输出契约）', { status: bootAna.status, tail: (bootAna.stdout + bootAna.stderr).slice(-400) });
  // 新项目索引
  ok(fs.existsSync(path.join(projDir, '项目索引.md')), '⑧ 新项目索引生成', {});

  const out = {
    at: new Date().toISOString(), head: (() => { try { return require('node:child_process').execFileSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).trim(); } catch { return ''; } })(),
    sandbox: path.relative(ROOT, SB), project: PROJ,
    projectAdd: { status: add.status, tail: add.stdout.slice(-500) },
    bootPm: { status: bootPm.status, tail: bootPm.stdout.slice(-300) },
    bootAnalyst: { status: bootAna.status, tail: bootAna.stdout.slice(-300) },
    results, pass: results.every((r) => r.ok),
  };
  fs.writeFileSync(path.join(EV, 'smoke-newproject.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
  console.log(`\nSMOKE_NEWPROJECT ${results.filter((r) => r.ok).length}/${results.length} PASS → 证据-ea30/smoke-newproject.json`);
  if (process.env.SMOKE_KEEP === '1') { console.log('KEEP_SANDBOX ' + SB); return; }
  try { fs.rmSync(SB, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* ignore */ }
}

try { main(); } catch (e) { console.error('SMOKE_FAILED ' + String((e && e.message) || e)); process.exitCode = 2; }
