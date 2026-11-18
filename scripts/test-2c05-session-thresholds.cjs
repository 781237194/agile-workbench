#!/usr/bin/env node
'use strict';
/**
 * test-2c05-session-thresholds.cjs —— T-20261118-080102-2c05 回归夹具
 *
 * Owner 口径（2026-11-18 08:00）：**PM 允许到 2 倍阈值才换人**——pm warn=600000 / force=1000000；
 * 其余五个角色维持 warn=300000 / force=500000。阈值必须**单源**（sessionLimitsOf），
 * 禁止出现第二套（session usage / 水位提醒 / auto-rotate 候选共用）。
 *
 * 断言：
 *   T1 配置就位：项目 项目.json → sessionLimits.pm = {600000,1000000}；其余角色取默认
 *   T2 pm 判档：999999 → warn、1000000 → force、550000 → ok（**不是 force**，也还没到 60 万 warn）
 *   T3 其余角色不变：tester 300000 → warn、500000 → force、299999 → ok
 *   T4 缺配置回落默认：不存在的项目 / 未配置角色 → 300000/500000
 *   T5 auto-rotate 单源：DEFAULT_TOKEN_* === session 的默认值；collectCandidates 接受 limitsOf 且按角色判档
 *   T6 `session usage` 的 JSON 行内带 thresholds/warnThreshold/forceThreshold；人类输出带「预警/强制」列
 *
 * 用法：node scripts/test-2c05-session-thresholds.cjs   （AWB_2C05_OUT 指定 run.json）
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = '工作台改造修复';
let pass = 0;
const results = [];
function ok(name, cond, detail) {
  results.push({ name, ok: Boolean(cond) });
  if (cond) { pass += 1; console.log(`PASS  ${name}`); return; }
  console.log(`FAIL  ${name}  ` + JSON.stringify(detail || {}).slice(0, 300)); process.exitCode = 1;
}

(async () => {
  const S = await import(pathToFileURL(path.join(ROOT, '团队', '工具', 'lib', 'session.mjs')).href);
  const AR = await import(pathToFileURL(path.join(ROOT, '团队', '工具', 'lib', 'auto-rotate.mjs')).href);

  // T1
  const lim = S.sessionLimitsOf(PROJECT);
  ok('T1 项目配置 sessionLimits.pm = {warn:600000, force:1000000}；tester 取默认',
    lim.of('pm').warn === 600000 && lim.of('pm').force === 1000000
    && lim.of('tester').warn === 300000 && lim.of('tester').force === 500000,
    { pm: lim.of('pm'), tester: lim.of('tester') });

  // T2 pm 判档
  const pm = lim.of('pm');
  ok('T2 pm：999999→warn、1000000→force、550000→ok（不是 force）',
    S.usageLevelOf(999999, pm.warn, pm.force) === 'warn'
    && S.usageLevelOf(1000000, pm.warn, pm.force) === 'force'
    && S.usageLevelOf(550000, pm.warn, pm.force) === 'ok',
    { 999999: S.usageLevelOf(999999, pm.warn, pm.force), 1000000: S.usageLevelOf(1000000, pm.warn, pm.force), 550000: S.usageLevelOf(550000, pm.warn, pm.force) });

  // T3 其余角色不变
  const te = lim.of('tester');
  ok('T3 tester 不变：300000→warn、500000→force、299999→ok',
    S.usageLevelOf(300000, te.warn, te.force) === 'warn'
    && S.usageLevelOf(500000, te.warn, te.force) === 'force'
    && S.usageLevelOf(299999, te.warn, te.force) === 'ok',
    { te });

  // T4 缺配置回落
  const missing = S.sessionLimitsOf('不存在的项目-x');
  ok('T4 缺配置/未知项目 → pm 仍是代码级 2 倍（600000/1000000），其余角色回落 300000/500000',
    missing.of('pm').warn === 600000 && missing.of('pm').force === 1000000
    && missing.of('tester').warn === 300000 && missing.of('tester').force === 500000,
    { pm: missing.of('pm'), tester: missing.of('tester') });

  // T5 auto-rotate 单源 + 按角色判档
  const sameDefaults = AR.DEFAULT_TOKEN_WARN === S.DEFAULT_TOKEN_WARN && AR.DEFAULT_TOKEN_FORCE === S.DEFAULT_TOKEN_FORCE;
  const usage = {
    pm: { tokens: 999999, at: new Date().toISOString() },
    tester: { tokens: 500000, at: new Date().toISOString() },
    analyst: { tokens: 350000, at: new Date().toISOString() },
  };
  const cands = AR.collectCandidates({ now: Date.now(), usage, rounds: {}, memberRoles: ['pm', 'tester', 'analyst'], limitsOf: lim.of });
  const byRole = Object.fromEntries(cands.map((c) => [c.role, c.level]));
  ok('T5 auto-rotate 默认常量与 session 同源；collectCandidates 按角色判档（pm 999999=warn、tester 500000=force、analyst 350000=warn）',
    sameDefaults && byRole.pm === 'warn' && byRole.tester === 'force' && byRole.analyst === 'warn',
    { sameDefaults, byRole });

  // T6 usage 输出带 thresholds
  const src = fs.readFileSync(path.join(ROOT, '团队', '工具', 'lib', 'session.mjs'), 'utf8');
  ok('T6 session usage 输出含 thresholds 字段与「预警/强制」列（人类输出可读实际生效值）',
    /thresholds: \{ defaults: \{ warn, force \}, overrides: limits\.overrides \}/.test(src)
    && /warnThreshold: rowWarn, forceThreshold: rowForce/.test(src)
    && /预警\/强制/.test(src), {});
  const usageRes = await S.sessionUsage({ projectName: PROJECT });
  const rowPm = (usageRes.rows || []).find((r) => r.role === 'pm') || null;
  ok('T6b sessionUsage() 返回 thresholds + 每行实际生效 warn/force（pm 600000/1000000）',
    Boolean(usageRes.thresholds) && Boolean(rowPm)
    && rowPm.warnThreshold === 600000 && rowPm.forceThreshold === 1000000
    && rowPm.thresholdSource === 'project.sessionLimits',
    { thresholds: usageRes.thresholds, pmRow: rowPm && { warn: rowPm.warnThreshold, force: rowPm.forceThreshold, src: rowPm.thresholdSource } });

  const report = { task: 'T-20261118-080102-2c05', at: new Date().toISOString(), total: results.length, pass, red: results.length - pass, results };
  const outEnv = process.env.AWB_2C05_OUT || path.join('_tmp', 'run-2c05.json');
  const outFile = path.isAbsolute(outEnv) ? outEnv : path.join(ROOT, outEnv);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`\nSESSION_THRESHOLDS ${JSON.stringify({ total: report.total, pass: report.pass, red: report.red })}`);
  console.log('证据：' + outFile);
  process.exit(report.red ? 1 : 0);
})().catch((e) => { console.error('SESSION_THRESHOLDS_FAILED ' + String((e && e.stack) || e)); process.exit(2); });
