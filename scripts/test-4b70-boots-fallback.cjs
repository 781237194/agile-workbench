#!/usr/bin/env node
'use strict';
/**
 * B-20261116-135639-4b70 夹具：requireWorkflowBoot 的「boots 存在但过旧」也要走回退。
 *
 * 判据（PM 2026-11-18 单；AC1–AC4）：
 *   A. boots 缺失 + 有 CLI boot（阅读.jsonl）→ 按 CLI boot 放行（既有行为不回归）
 *   B. boots 存在但 docs 哈希与磁盘不一致（旧快照）+ 有**更新**的 CLI boot（哈希=磁盘）→
 *      **按 CLI boot 放行**（AC1），返回 bootSource 标注「壳层记录过期回退」、cliFallback.staleFor=0
 *   C. boots 过旧 + 无 CLI boot（或 CLI 更旧）→ RULES_CHANGED，但 staleReason=stale_boot_record，
 *      提示区分「记录过期→重 boot 即可」（AC2）
 *   D. 文档真被改（boots 与最新 CLI boot 都记旧哈希、磁盘已变）→ RULES_CHANGED，
 *      staleReason=documents_changed，提示「先重新阅读再 boot」（AC2/AC4 仍拦）
 *   E. boots 新鲜 → 放行（state.boots）
 *
 * 隔离：TEAM_ROOT 沙盘（只复制 团队/工具 + 团队宪法.md，不碰真实状态）；真实 团队.json 零写入。
 * 跑法：node scripts/test-4b70-boots-fallback.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const { mkTempSandbox, rmSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const SB = mkTempSandbox('4b70');
const TEAM = path.join(SB, '团队');
const PROJECT = '4b70回退沙盘';
const PROJECT_PATH = path.join(SB, '项目', PROJECT);
const ROLE = 'programmer2';
const REAL_TEAM_FILE = path.join(ROOT, '团队', '状态', '团队.json');
const shaFile = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; } };
const realBefore = shaFile(REAL_TEAM_FILE);
const shaText = (s) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const write = (f, s) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, s, 'utf8'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// 沙盘团队：只复制工具 + 宪法（避免复制几百 MB 真实状态）
fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(TEAM, { recursive: true });
fs.cpSync(path.join(ROOT, '团队', '工具'), path.join(TEAM, '工具'), { recursive: true });
fs.copyFileSync(path.join(ROOT, '团队', '团队宪法.md'), path.join(TEAM, '团队宪法.md'));
write(path.join(TEAM, '状态', '团队.json'), JSON.stringify({
  version: 1, activeProject: PROJECT,
  members: ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'].map((r) => ({ role: r, name: r, sessionId: '', status: 'active' })),
  config: { messageMaxChars: 600 },
}, null, 2) + '\n');
fs.mkdirSync(path.join(TEAM, '状态', '项目'), { recursive: true });
fs.mkdirSync(path.join(TEAM, '状态', '邮箱'), { recursive: true });

// 项目文档（bootDocSpecs 的六项必读；项目信息/铁律不得是模板占位）
const DOC_FILES = {
  constitution: path.join(TEAM, '团队宪法.md'),
  iron: path.join(PROJECT_PATH, '项目铁律.md'),
  projectInfo: path.join(PROJECT_PATH, '项目信息.md'),
  roleCard: path.join(PROJECT_PATH, '程序员B', '角色卡.md'),
  projectIndex: path.join(PROJECT_PATH, '项目索引.md'),
  requirementOverview: path.join(PROJECT_PATH, '需求', '00-需求总览.md'),
};
const DOC_LABELS = {
  constitution: '团队宪法', iron: '项目铁律', projectInfo: '项目信息', roleCard: '角色卡',
  projectIndex: '项目索引', requirementOverview: '需求总览',
};
function writeDocs(stamp) {
  write(DOC_FILES.constitution, fs.readFileSync(path.join(ROOT, '团队', '团队宪法.md'), 'utf8') + `\n<!-- ${stamp} -->\n`);
  write(DOC_FILES.iron, `# 项目铁律\n\n本轮回归夹具专用铁律正文（${stamp}）。\n`);
  write(DOC_FILES.projectInfo, `# 项目信息\n\n4b70 夹具项目：验证 boots 过旧回退（${stamp}）。\n`);
  write(DOC_FILES.roleCard, `# 程序 B 角色卡\n\n负责实现与回归（${stamp}）。\n`);
  write(DOC_FILES.projectIndex, `# 项目索引\n\n夹具索引 ${stamp}\n`);
  write(DOC_FILES.requirementOverview, `# 需求总览\n\n夹具需求总览 ${stamp}\n`);
}
const currentDocHashes = () => Object.fromEntries(Object.entries(DOC_FILES).map(([k, f]) => [k, { hash: shaFile(f), exists: true }]));

// 沙盘项目状态目录（工作流.json 路径由壳层 teamSlug 决定）
const { create, teamSlug } = require(path.join(ROOT, 'src', 'team-tools.js'));
const STATE_DIR = path.join(TEAM, '状态', '项目', teamSlug(PROJECT, 60));
fs.mkdirSync(STATE_DIR, { recursive: true });
const READS = path.join(TEAM, '状态', '阅读.jsonl');

const tools = create({ teamRoot: TEAM });
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 800)}`);
  if (!ok) process.exitCode = 1;
}
function writeWorkflow(boots) {
  write(path.join(STATE_DIR, '工作流.json'), JSON.stringify({ schema: 2, project: PROJECT, round: 1, phase: 'idle', requirements: {}, boots: boots || {} }, null, 2) + '\n');
}
function writeReads(rows) {
  write(READS, rows.map((r) => JSON.stringify(r)).join('\n') + (rows.length ? '\n' : ''));
}
function cliBootRow({ ts, hashes, complete = true, round = 1 }) {
  return { at: ts, ts, kind: 'boot', role: ROLE, project: PROJECT, sessionId: 's-4b70', completed: complete, round, docHashes: hashes };
}
function shellBoot({ hashes, at, complete = true, round = 1 }) {
  return { role: ROLE, project: PROJECT, at, round, complete, docs: hashes, rulesHash: '', source: 'workflow-boot' };
}
const gate = () => tools.requireWorkflowBoot(PROJECT, PROJECT_PATH, ROLE);
const days = (n) => new Date(Date.now() + n * 86400000).toISOString();

async function main() {
  // 场景 A：boots 缺失 + CLI boot 新鲜
  writeDocs('A');
  const hA = currentDocHashes();
  writeWorkflow({});
  writeReads([cliBootRow({ ts: days(-1), hashes: hA })]);
  const rA = gate();
  check('A. boots 缺失 + CLI boot → 回退 CLI 放行（既有行为不回归）',
    rA.ok === true && String(rA.bootSource || '').includes('阅读.jsonl'),
    { code: rA.code, bootSource: rA.bootSource, stale: rA.stale, message: rA.message });

  // 场景 B：boots 过旧（旧哈希）+ 更新的 CLI boot（当前哈希）→ 按 CLI boot 放行
  const oldHashes = Object.fromEntries(Object.entries(hA).map(([k, v]) => [k, { hash: shaText('OLD-' + k), exists: true }]));
  writeWorkflow({ [ROLE]: shellBoot({ hashes: oldHashes, at: days(-2) }) });
  writeReads([cliBootRow({ ts: days(-1), hashes: hA })]);
  const rB = gate();
  check('B. boots 存在但过旧 + 更新的 CLI boot → 按 CLI boot 放行（AC1）',
    rB.ok === true && String(rB.bootSource || '').includes('壳层记录过期回退'),
    { code: rB.code, bootSource: rB.bootSource, cliFallback: rB.cliFallback, stale: rB.stale, message: rB.message });
  check('B2. 回退证据：cliFallback.staleFor=0（CLI 记录与磁盘一致）',
    rB.ok === true && rB.cliFallback && Number(rB.cliFallback.staleFor) === 0,
    { cliFallback: rB.cliFallback });

  // 场景 C：boots 过旧 + 无 CLI boot → 记录过期提示
  writeWorkflow({ [ROLE]: shellBoot({ hashes: oldHashes, at: days(-2) }) });
  writeReads([]);
  const rC = gate();
  check('C. boots 过旧 + 无 CLI boot → RULES_CHANGED，但提示「记录过期，重 boot 即可」（AC2）',
    rC.ok === false && rC.code === 'RULES_CHANGED' && rC.staleReason === 'stale_boot_record'
      && /重 boot 一次即可/.test(String(rC.hint || '')) && !/先重新阅读/.test(String(rC.hint || '')),
    { code: rC.code, staleReason: rC.staleReason, hint: rC.hint, message: rC.message });

  // 场景 D：文档真被改（boots 与最新 CLI 都记旧哈希）→ 仍拦，提示「先重新阅读」
  writeDocs('D');
  const hD = currentDocHashes();
  const hOldD = Object.fromEntries(Object.entries(hD).map(([k, v]) => [k, { hash: shaText('OLDD-' + k), exists: true }]));
  writeWorkflow({ [ROLE]: shellBoot({ hashes: hOldD, at: days(-2) }) });
  writeReads([cliBootRow({ ts: days(-1), hashes: hOldD })]);
  const rD = gate();
  check('D. 文档真被改（boots 与 CLI 都记旧哈希）→ RULES_CHANGED，提示「先重新阅读」（AC2/AC4）',
    rD.ok === false && rD.code === 'RULES_CHANGED' && rD.staleReason === 'documents_changed'
      && /先重新阅读/.test(String(rD.hint || '')),
    { code: rD.code, staleReason: rD.staleReason, hint: rD.hint, stale: rD.stale, message: rD.message });
  check('D2. 两种提示文案确实不同（记录过期 ≠ 文档被改）', String(rC.hint) !== String(rD.hint), { staleHint: rC.hint, changedHint: rD.hint });

  // 场景 E：boots 新鲜 → 放行（本夹具不铺需求池，置 poolComparable=false 跳过「本轮相关需求」比对）
  writeDocs('E');
  const hE = currentDocHashes();
  writeWorkflow({ [ROLE]: { ...shellBoot({ hashes: hE, at: new Date().toISOString() }), poolComparable: false } });
  writeReads([]);
  const rE = gate();
  check('E. boots 新鲜 → 放行（state.boots）',
    rE.ok === true && String(rE.bootSource || '') === 'state.boots',
    { code: rE.code, bootSource: rE.bootSource, message: rE.message });

  const realAfter = shaFile(REAL_TEAM_FILE);
  check('F. 真实 团队.json sha256 不变（沙盘零写入）', Boolean(realBefore) && realBefore === realAfter, { before: realBefore.slice(0, 12), after: realAfter.slice(0, 12) });

  const total = results.length;
  const pass = results.filter((x) => x.ok).length;
  const evDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-4b70');
  fs.mkdirSync(evDir, { recursive: true });
  const evFile = path.join(evDir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${total - pass === 0 ? 'green' : 'red'}.json`);
  fs.writeFileSync(evFile, JSON.stringify({ task: 'B-20261116-135639-4b70', at: new Date().toISOString(), total, pass, red: total - pass, results }, null, 2) + '\n', 'utf8');
  console.log(`\nB4B70_${total - pass === 0 ? 'OK' : 'RED'} ${JSON.stringify({ total, pass, red: total - pass })}`);
  console.log(`证据：${evFile}`);
  if (process.env.AWB_KEEP_SANDBOX !== '1') { try { rmSandbox(SB); } catch { /* ignore */ } }
}

main().catch((e) => { console.error('CRASH', String((e && e.stack) || e)); process.exit(2); });
