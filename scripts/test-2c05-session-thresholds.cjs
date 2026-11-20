#!/usr/bin/env node
'use strict';
/**
 * test-2c05-session-thresholds.cjs —— T-20261118-080102-2c05 回归夹具
 *
 * 阈值口径（B-usage-semantics，提交 00dc62e）：六个角色统一 warn=5000000 / force=10000000
 * （= session.mjs 的 SESSION_CUMULATIVE_WARN_DEFAULT / FORCE_DEFAULT，口径＝本会话累计未缓存输入、换人归零）；
 * 换人已改为「只提醒不强制」，到阈值只提醒 + 建议归档，不阻断工作。
 * 阈值必须**单源**（sessionLimitsOf），禁止出现第二套（session usage / 水位提醒 / auto-rotate 候选共用）。
 *
 * 断言（本夹具断言的是「默认阈值本身」，阈值变更时必须同步这里的期望值，判档边界语义不变）：
 *   T1 无项目覆盖时所有角色取 5000000/10000000（PM 不再 2 倍）
 *   T2 判档：9999999 → warn、10000000 → force、4999999 → ok、5000000 → warn
 *   T3 其余角色同口径：tester 5000000 → warn、10000000 → force、4999999 → ok
 *   T4 缺配置回落默认：不存在的项目 / 未配置角色 → 5000000/10000000
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
  ok('T1 无覆盖时 pm 与 tester 均为 5000000/10000000（PM 2 倍已撤销）',
    lim.of('pm').warn === 5000000 && lim.of('pm').force === 10000000
    && lim.of('tester').warn === 5000000 && lim.of('tester').force === 10000000,
    { pm: lim.of('pm'), tester: lim.of('tester') });

  // T2 pm 判档
  const pm = lim.of('pm');
  ok('T2 pm：9999999→warn、10000000→force、4999999→ok、5000000→warn',
    S.usageLevelOf(9999999, pm.warn, pm.force) === 'warn'
    && S.usageLevelOf(10000000, pm.warn, pm.force) === 'force'
    && S.usageLevelOf(4999999, pm.warn, pm.force) === 'ok'
    && S.usageLevelOf(5000000, pm.warn, pm.force) === 'warn',
    { 9999999: S.usageLevelOf(9999999, pm.warn, pm.force), 10000000: S.usageLevelOf(10000000, pm.warn, pm.force), 5100000: S.usageLevelOf(5100000, pm.warn, pm.force) });

  // T3 其余角色不变
  const te = lim.of('tester');
  ok('T3 tester 同口径：5000000→warn、10000000→force、4999999→ok',
    S.usageLevelOf(5000000, te.warn, te.force) === 'warn'
    && S.usageLevelOf(10000000, te.warn, te.force) === 'force'
    && S.usageLevelOf(4999999, te.warn, te.force) === 'ok',
    { te });

  // T4 缺配置回落
  const missing = S.sessionLimitsOf('不存在的项目-x');
  ok('T4 缺配置/未知项目 → 所有角色回落 5000000/10000000',
    missing.of('pm').warn === 5000000 && missing.of('pm').force === 10000000
    && missing.of('tester').warn === 5000000 && missing.of('tester').force === 10000000,
    { pm: missing.of('pm'), tester: missing.of('tester') });

  // T5 auto-rotate 单源 + 按角色判档
  const sameDefaults = AR.DEFAULT_TOKEN_WARN === S.DEFAULT_TOKEN_WARN && AR.DEFAULT_TOKEN_FORCE === S.DEFAULT_TOKEN_FORCE;
  const usage = {
    pm: { tokens: 5100000, at: new Date().toISOString() },
    tester: { tokens: 10100000, at: new Date().toISOString() },
    analyst: { tokens: 5500000, at: new Date().toISOString() },
  };
  const cands = AR.collectCandidates({ now: Date.now(), usage, rounds: {}, memberRoles: ['pm', 'tester', 'analyst'], limitsOf: lim.of });
  const byRole = Object.fromEntries(cands.map((c) => [c.role, c.level]));
  ok('T5 auto-rotate 默认常量与 session 同源；collectCandidates 按角色判档（pm 5100000=warn、tester 10100000=force、analyst 5500000=warn）',
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
  ok('T6b sessionUsage() 返回 thresholds + 每行实际生效 warn/force（pm 5000000/10000000，来源 builtin:cumulative）',
    Boolean(usageRes.thresholds) && Boolean(rowPm)
    && rowPm.warnThreshold === 5000000 && rowPm.forceThreshold === 10000000
    && rowPm.thresholdSource === 'builtin:cumulative',
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
