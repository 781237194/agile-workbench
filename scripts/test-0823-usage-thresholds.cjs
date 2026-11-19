#!/usr/bin/env node
'use strict';
/**
 * test-0823-usage-thresholds.cjs —— B-20261120-020530-0823 夹具
 *
 * 背景（Owner 2026-11-20 02:0x 截图）：六角色会话显示「会话用量 375.7 万 / 阈值 30 万」，
 * 根因是 `src/main.js → session:usage` 把 warn=300000 / force=500000 写死，没按角色取
 * `团队/工具/lib/session.mjs → sessionLimitsOf().of(role)`（pm 该 60/100 万、项目可覆盖）。
 *
 * 断言：
 *   A 纯逻辑（src/usage-threshold.js）
 *     A1 pm 50 万 + pm 阈值(60/100万) → ok（旧实现会判 force，这就是 bug）
 *     A2 programmer1 50 万 + (30/50万) → force（边界 >=）
 *     A3 项目覆盖 40/70 万时同一 50 万 → warn（不再恒 force）
 *     A4 缺文件 / 超过 24h → unknown，且不回落任何写死阈值
 *     A5 label 不混排：含「最高：」「其阈值」「倍」，格式固定
 *     A6 severity：任一 force → force；无 force 有 warn → warn；全 ok → ok
 *   B 接线（src/main.js 静态）
 *     B1 session:usage 内**不再出现** 300000/500000 字面量阈值
 *     B2 引入 UsageThreshold 纯模块并调用 classifyUsage
 *     B3 通过动态 import session.mjs 取 sessionLimitsOf（单源）
 *     B4 import 失败路径存在降级（limitsError / limitsReady），不是静默写死
 *   C 单源一致性（真读 session.mjs）
 *     C1 pm 的 warn/force 严格大于其余角色（当前 60/100 万 vs 30/50 万）
 *     C2 传入项目 sessionLimits 覆盖时，of(role) 返回覆盖值
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const U = require(path.join(ROOT, 'src', 'usage-threshold.js'));
const rows = [];
const check = (name, ok, detail) => {
  let text = ''; try { text = JSON.stringify(detail === undefined ? null : detail); } catch { text = String(detail); }
  rows.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' :: ' + String(text).slice(0, 400)}`);
};

const PM = { warn: 600000, force: 1000000 };
const DEV = { warn: 300000, force: 500000 };
const base = { missing: false, stale: false };

// ── A 纯逻辑 ─────────────────────────────────────────────
check('A1 pm 50 万 / pm 阈值 60-100 万 → ok（旧实现按 30 万会误判 force）',
  U.classifyUsage({ ...base, tokens: 500000, limits: PM }).level === 'ok',
  U.classifyUsage({ ...base, tokens: 500000, limits: PM }));

check('A2 程序员A 50 万 / 30-50 万 → force（>= 边界）',
  U.classifyUsage({ ...base, tokens: 500000, limits: DEV }).level === 'force',
  U.classifyUsage({ ...base, tokens: 500000, limits: DEV }));

check('A2b 程序员A 49.9 万 / 30-50 万 → warn',
  U.classifyUsage({ ...base, tokens: 499000, limits: DEV }).level === 'warn', {});

check('A3 项目覆盖 40-70 万时同一 50 万 → warn',
  U.classifyUsage({ ...base, tokens: 500000, limits: { warn: 400000, force: 700000 } }).level === 'warn', {});

check('A4 缺文件 → unknown / USAGE_FILE_MISSING',
  (() => { const r = U.classifyUsage({ ...base, missing: true, tokens: 1e9, limits: DEV }); return r.level === 'unknown' && r.why === 'USAGE_FILE_MISSING'; })(), {});

check('A4b 超过 24h → unknown / USAGE_STALE',
  (() => { const r = U.classifyUsage({ ...base, stale: true, tokens: 1e9, limits: DEV }); return r.level === 'unknown' && r.why === 'USAGE_STALE'; })(), {});

check('A4c 阈值不可用 → unknown / LIMITS_UNAVAILABLE（绝不回落写死值）',
  (() => { const r = U.classifyUsage({ ...base, tokens: 3757000, limits: { warn: null, force: null } }); return r.level === 'unknown' && r.why === 'LIMITS_UNAVAILABLE'; })(), {});

const label = U.usageLabel({ role: 'programmer1', tokens: 3757000, warn: 300000, level: 'force' }, (n) => Math.round(n / 10000) + ' 万');
check('A5 label 不混排：含角色/其阈值/倍数/去向',
  /会话用量最高：programmer1/.test(label) && /其阈值 30 万/.test(label) && /已超 12\.5 倍/.test(label) && /需换人/.test(label),
  { label });

check('A6 severity 取最严重档',
  U.severityOf(['ok', 'warn', 'unknown']) === 'warn' && U.severityOf(['ok', 'force', 'warn']) === 'force' && U.severityOf(['ok']) === 'ok' && U.severityOf(['unknown', 'unknown']) === 'unknown',
  {});

// ── B 接线（静态） ───────────────────────────────────────
const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const handlerStart = mainSrc.indexOf("ipcMain.handle('session:usage'");
const handlerEnd = handlerStart < 0 ? -1 : mainSrc.indexOf("ipcMain.handle('owner:ledger-close-task'", handlerStart);
const handler = handlerStart >= 0 && handlerEnd > handlerStart ? mainSrc.slice(handlerStart, handlerEnd) : '';
check('B0 找到 session:usage 处理器', handler.length > 200, { len: handler.length });
check('B1 处理器内不再出现写死 300000/500000',
  handler.length > 0 && !/\b(300000|500000)\b/.test(handler.replace(/\/\/[^\n]*/g, '')),
  { found: (handler.match(/\b(300000|500000)\b/g) || []).slice(0, 3) });
check('B2 处理器调用 UsageThreshold.classifyUsage（单一判定源）',
  /UsageThreshold\.classifyUsage/.test(handler) && /require\('\.\/usage-threshold\.js'\)/.test(mainSrc), {});
check('B3 通过动态 import session.mjs 取 sessionLimitsOf（单源阈值）',
  /sessionLimitsOf/.test(handler) && /import\(/.test(handler) && /lib['"],\s*['"]session\.mjs|session\.mjs/.test(handler), {});
check('B4 import 失败有降级（limitsError/limitsReady），不是静默写死',
  /limitsError/.test(handler) && /limitsReady/.test(handler) && /limitsFor\(/.test(handler), {});

// ── C 单源一致性（真读 session.mjs） ─────────────────────
(async () => {
  // 造一个沙盘团队根，只放 session.mjs 需要的 项目.json 覆盖，验证 of(role) 生效
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-0823-'));
  try {
    const slug = '工作台改造修复';
    const dir = path.join(sandbox, '状态', '项目', slug);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, '项目.json'), JSON.stringify({ name: slug, sessionLimits: { programmer2: { warn: 400000, force: 700000 } } }, null, 2), 'utf8');
    process.env.TEAM_ROOT = sandbox;
    const mod = await import(pathToFileURL(path.join(ROOT, '团队', '工具', 'lib', 'session.mjs')).href);
    const limits = mod.sessionLimitsOf(slug);
    const pm = limits.of('pm');
    const dev = limits.of('programmer1');
    const over = limits.of('programmer2');
    check('C1 默认阈值全体一致 = 30/50 万（PM 2× 已在 2026-11-20 c60ee64 按 Owner 指令移除）',
      Number(pm.warn) === Number(dev.warn) && Number(pm.force) === Number(dev.force),
      { pm, dev });
    check('C2 项目 项目.json → sessionLimits 覆盖生效',
      Number(over.warn) === 400000 && Number(over.force) === 700000,
      { over });
    check('C3 默认阈值等于规范（普通角色 30/50 万）',
      Number(dev.warn) === 300000 && Number(dev.force) === 500000, { dev });
  } finally {
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const pass = rows.filter((r) => r.ok).length;
  console.log(`\n${pass}/${rows.length} PASS`);
  process.exit(pass === rows.length ? 0 : 1);
})();
