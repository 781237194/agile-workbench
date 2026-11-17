#!/usr/bin/env node
'use strict';
/**
 * B-20261117-213547-e6c9 夹具：sq-check 强制隔离（三条断言）
 *
 * ① 缺隔离变量：`prepareSqCheckSandbox({})` 必须抛 `SQ_CHECK_NOT_ISOLATED`（不许回退真实路径）；
 * ② 真实状态不被写：调用前后 真实 `项目/工作台改造修复/团队会话.json` 与 `团队/状态/团队.json` 的 sha256 相等；
 * ③ 正常隔离：给出沙盘 teamRoot/storeFile + sandboxProjectDir 时 prepareSqCheckSandbox 正常返回，
 *    沙盘目录被创建，且 store 里的项目路径已被改指沙盘（不指向真实 项目/）。
 *
 * 说明：完整的 28 条 sq-check 功能断言需要 Electron 真窗口，本脚本不含；
 * 用 `node scripts/run-electron.cjs . --sq-check` 单独跑（结果另见其输出 SESSION_QUEUE_CHECK_OK）。
 *
 * 跑法：node scripts/test-sq-check-isolation.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const SQ = require(path.join(ROOT, 'src', 'sq-check.js'));
const PROJECT = '工作台改造修复';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 500)}`);
  if (!ok) process.exitCode = 1;
}
const sha256 = (f) => {
  try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; }
};

const realManifest = path.join(ROOT, '项目', PROJECT, '团队会话.json');
const realTeamFile = path.join(ROOT, '团队', '状态', '团队.json');

/* ① 缺隔离变量 → fail fast */
{
  let threw = null;
  try { SQ.prepareSqCheckSandbox({}); } catch (e) { threw = e; }
  check('① 缺隔离变量（无 teamRoot/storeFile）→ 抛 SQ_CHECK_NOT_ISOLATED，不回退真实路径',
    Boolean(threw) && /SQ_CHECK_NOT_ISOLATED/.test(String(threw && threw.message)),
    { threw: threw ? String(threw.message).slice(0, 200) : null });
}

/* ①b 指向真实树 → 同样拒绝 */
{
  let threw = null;
  try {
    SQ.prepareSqCheckSandbox({ teamRoot: path.join(ROOT, '团队'), storeFile: path.join(ROOT, 'data', 'userdata', 'workbench.json') });
  } catch (e) { threw = e; }
  check('①b teamRoot/storeFile 指向真实 团队/ → 同样抛 SQ_CHECK_NOT_ISOLATED',
    Boolean(threw) && /SQ_CHECK_NOT_ISOLATED/.test(String(threw && threw.message)),
    { threw: threw ? String(threw.message).slice(0, 200) : null });
}

/* ② 真实状态前后 sha 不变（包括跑一次正常隔离准备） */
{
  const before = { manifest: sha256(realManifest), team: sha256(realTeamFile) };
  const sandbox = path.join(ROOT, '_tmp', `sq-iso-${process.pid}-${Date.now().toString(36)}`);
  const teamRoot = path.join(sandbox, '团队');
  const storeFile = path.join(sandbox, 'userdata', 'workbench.json');
  let prepared = null;
  try {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    // 造一份最小沙盘 store（沿用真实项目的 name，验证路径改指）
    const realStore = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'userdata', 'workbench.json'), 'utf8'));
    const proj = (realStore.projects || []).find((p) => p && String(p.teamName || p.name || '') === PROJECT) || (realStore.projects || [])[0];
    fs.writeFileSync(storeFile, JSON.stringify({ projects: [proj], activeProjectId: proj.id }, null, 2), 'utf8');
    prepared = SQ.prepareSqCheckSandbox({ teamRoot, storeFile, sandboxProjectDir: path.join(sandbox, '项目') });
  } catch (e) {
    prepared = { error: String((e && e.message) || e) };
  }
  const after = { manifest: sha256(realManifest), team: sha256(realTeamFile) };
  check('② 正常隔离准备后，真实 团队会话.json / 团队.json 的 sha256 不变（真实树零写入）',
    before.manifest === after.manifest && before.team === after.team && before.manifest !== '',
    { before, after, prepared: prepared && prepared.error ? prepared : 'ok' });
  // 顺便核 store 已被改指沙盘
  let storedPath = '';
  try {
    const s = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
    storedPath = String(((s.projects || [])[0] || {}).path || '');
  } catch { storedPath = ''; }
  check('③ 沙盘 store 里的项目路径已改指沙盘（不含真实 项目/ 前缀）',
    storedPath.includes(path.join('_tmp', 'sq-iso')) || (storedPath && !storedPath.startsWith(path.join(ROOT, '项目'))),
    { storedPath, sandbox });
  try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
}

/* ③ 功能断言入口存在（28 条真断言需 Electron，见文件头说明） */
check('③b runSqCheck 导出存在（功能断言入口；真跑用 run-electron.cjs --sq-check）',
  typeof SQ.runSqCheck === 'function', { type: typeof SQ.runSqCheck });

const pass = results.filter((r) => r.ok).length;
console.log('');
console.log(`${pass === results.length ? 'SQ_CHECK_ISOLATION_OK' : 'SQ_CHECK_ISOLATION_WARN'} ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
