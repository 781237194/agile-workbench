#!/usr/bin/env node
'use strict';
/**
 * test-usage-threshold-semantics.cjs —— B-usage-semantics 夹具
 * （Owner 2026-11-20 11:2x 报：「会话用量最高: pm 455.4 万（其阈值 30 万），已超 15.2 倍 → 需换人」）
 *
 * 根因：`sessionLimitsOf()` 的默认阈值 30 万 / 50 万是「**单次上下文预算**」量级，
 * 而实际比较的是「**本会话累计未缓存输入**」（pm 已 4,565,584，跑了两天）→ 任何活过一天的会话必然「超 15 倍」。
 * 这不是误算，是口径与阈值不匹配。
 *
 * 修法（本夹具锁住）：
 *   ① 默认阈值改「单会话累计预算」量级：warn 500 万 / force 1000 万，六个角色统一
 *      （`sessionLimitsOf().of(role)`，单源）；项目 `项目.json → sessionLimits` 覆盖机制不变且优先。
 *   ② 文案说清口径：本会话累计未缓存输入（换人归零）→ 建议换人（不再是「需换人」的硬判决）。
 *
 * 口径说明：`usageLevelOf()` 的缺省形参仍是 30/50 万刻度（selftest 的「>= 即到档」边界断言依赖它），
 * 它**不是**生产生效阈值——生产一律显式传 `sessionLimitsOf()` 的值。D1 断言把这个刻意区分钉住。
 *
 * 隔离：只写 os.tmpdir() 下的临时沙盘（TEAM_ROOT / TEAM_PROJECTS_ROOT / TEAM_WORKBENCH_JSON / AWB_DATA_DIR
 * 全指沙盘），只**读**仓库源码；不联网、不写真实团队状态。退出即删沙盘（AWB_KEEP_SANDBOX=1 可保留排查）。
 *
 * 用法：node scripts/test-usage-threshold-semantics.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const rows = [];
const check = (name, ok, detail) => {
  let text = '';
  try { text = JSON.stringify(detail === undefined ? null : detail); } catch { text = String(detail); }
  rows.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' :: ' + String(text).slice(0, 400)}`);
};

const fmt = (n) => `${Math.round(Number(n) / 10000)} 万`;
// 与 src/main.js → session:usage 里 label 的同一套替换（B3 用它复算目标文案）
const panelWording = (s) => s
  .replace(/^会话用量最高：\S+\s+/, '本会话累计输入 ')
  .replace('（其阈值 ', '（换人归零，其阈值 ')
  .replace('需换人', '建议换人');

const U = require(path.join(ROOT, 'src', 'usage-threshold.js'));

// ── 沙盘（只放 项目.json 覆盖，驱动 sessionLimitsOf） ───────────────────
const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-usage-sem-'));
const PROJECT = '沙盘用量语义';        // 无覆盖 → 走默认（累计预算 500 万/1000 万）
const PROJECT_OVERRIDE = '沙盘用量覆盖'; // 覆盖为 100 万/200 万 → 5,100,000 应判 force

function seedProject(name, cfg) {
  const dir = path.join(sandbox, '状态', '项目', name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, '项目.json'), JSON.stringify({ name, ...cfg }, null, 2), 'utf8');
}
seedProject(PROJECT, {});
seedProject(PROJECT_OVERRIDE, { sessionLimits: { pm: { warn: 1000000, force: 2000000 } } });

process.env.TEAM_ROOT = sandbox;
process.env.TEAM_PROJECTS_ROOT = path.join(sandbox, '项目');
process.env.TEAM_WORKBENCH_JSON = path.join(sandbox, 'workbench.json');
process.env.AWB_DATA_DIR = path.join(sandbox, 'data');

(async () => {
  try {
    const S = await import(pathToFileURL(path.join(ROOT, '团队', '工具', 'lib', 'session.mjs')).href);
    const ROLES = await import(pathToFileURL(path.join(ROOT, '团队', '工具', 'lib', 'roles.mjs')).href);
    const sessionSrc = fs.readFileSync(path.join(ROOT, '团队', '工具', 'lib', 'session.mjs'), 'utf8');
    const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');

    const limits = S.sessionLimitsOf(PROJECT);
    const overLimits = S.sessionLimitsOf(PROJECT_OVERRIDE);
    const pm = limits.of('pm');
    const level = (tokens, lim) => S.usageLevelOf(tokens, lim.warn, lim.force);

    // ── A 阈值语义（纯函数 + 单源） ──────────────────────────────────────
    const roleList = Object.keys(ROLES.ROLE_NAMES);
    const allUnified = roleList.every((role) => {
      const lim = limits.of(role);
      return Number(lim.warn) === 5000000 && Number(lim.force) === 10000000;
    });
    check('A0 六角色默认阈值统一＝本会话累计预算 500 万/1000 万（单源 sessionLimitsOf）',
      roleList.length === 6 && allUnified, { roles: roleList.map((r) => [r, limits.of(r)]) });

    const ownerPm = 4565584; // Owner 2026-11-20 11:2x 面板上的 pm 累计未缓存输入
    check('A1 pm 累计 4,565,584 → 默认阈值下 level 不得为 force（实测 ok：455.7 万 < 500 万）',
      level(ownerPm, pm) !== 'force', { level: level(ownerPm, pm), pm });
    check('A1b pm 累计 4,565,584 实为 ok（不是 warn/force：旧 30 万阈值会判 force）',
      level(ownerPm, pm) === 'ok', { level: level(ownerPm, pm), pm });

    check('A2 累计 5,100,000 → warn', level(5100000, pm) === 'warn', { level: level(5100000, pm), pm });
    check('A3 累计 10,100,000 → force', level(10100000, pm) === 'force', { level: level(10100000, pm), pm });

    const overPm = overLimits.of('pm');
    check('A4 项目 项目.json → sessionLimits 覆盖为 100 万/200 万时，5,100,000 → force（覆盖优先）',
      Number(overPm.warn) === 1000000 && Number(overPm.force) === 2000000 && level(5100000, overPm) === 'force',
      { over: overPm, level: level(5100000, overPm) });

    // 边界 `>=`：tokens===阈值即到档，阈值−1 不算
    check('A5 边界语义 `>=`：4,999,999=ok / 5,000,000=warn / 9,999,999=warn / 10,000,000=force',
      level(4999999, pm) === 'ok' && level(5000000, pm) === 'warn'
      && level(9999999, pm) === 'warn' && level(10000000, pm) === 'force',
      { 4999999: level(4999999, pm), 5000000: level(5000000, pm), 9999999: level(9999999, pm), 10000000: level(10000000, pm) });

    check('A6 阈值不会被 0/空值污染（of() 永远给正数，缺项回落累计预算）',
      Number(limits.of('不存在角色').warn) === 5000000 && Number(limits.of('不存在角色').force) === 10000000,
      { unknownRole: limits.of('不存在角色') });

    // ── B 壳层文案（口径说清：本会话累计输入 / 换人归零 / 建议换人） ────────
    const hStart = mainSrc.indexOf("ipcMain.handle('session:usage'");
    const hEnd = hStart < 0 ? -1 : mainSrc.indexOf("ipcMain.handle('owner:ledger-close-task'", hStart);
    const handler = hStart >= 0 && hEnd > hStart ? mainSrc.slice(hStart, hEnd) : '';
    check('B0 找到 session:usage 处理器', handler.length > 200, { len: handler.length });
    check('B1 label 说清口径：含「本会话累计输入」「换人归零」「建议换人」，且保留「累计含缓存读 … 仅作参考」',
      handler.includes('本会话累计输入') && handler.includes('换人归零') && handler.includes('建议换人')
      && handler.includes('累计含缓存读') && handler.includes('仅作参考'), { len: handler.length });
    check('B2 三处固定替换仍在（模板片段契约，漂移即红）',
      handler.includes(".replace(/^会话用量最高：\\S+\\s+/, '本会话累计输入 ')")
      && handler.includes(".replace('（其阈值 ', '（换人归零，其阈值 ')")
      && handler.includes(".replace('需换人', '建议换人')"), {});

    const labelForce = U.usageLabel({ role: 'pm', tokens: 10100000, warn: 5000000, level: 'force' }, fmt);
    const labelOk = U.usageLabel({ role: 'pm', tokens: ownerPm, warn: pm.warn, level: 'ok' }, fmt);
    check('B3 usageLabel 模板三处片段未漂移（否则 B2 的替换会静默失效）',
      /^会话用量最高：pm /.test(labelForce) && labelForce.includes('（其阈值 ') && labelForce.includes('→ 需换人'),
      { labelForce });
    check('B4 变换后＝目标文案：本会话累计输入 X（换人归零，其阈值 Y），已超 N 倍 → 建议换人',
      (() => {
        const t = panelWording(labelForce);
        return t.startsWith('本会话累计输入 1010 万（换人归零，其阈值 500 万）')
          && /已超 2\.0 倍 → 建议换人$/.test(t) && !t.includes('会话用量最高') && !t.includes('需换人');
      })(), { got: panelWording(labelForce) });
    check('B5 Owner 那条真实数据：label 变成「本会话累计输入 457 万（换人归零，其阈值 500 万），未超阈值」',
      (() => {
        const t = panelWording(labelOk);
        return t === '本会话累计输入 457 万（换人归零，其阈值 500 万），未超阈值';
      })(), { got: panelWording(labelOk) });

    // ── C 工具侧口径文案 + 默认常量 ─────────────────────────────────────
    check('C1 session.mjs 判定/提示文案说清口径（本会话累计未缓存输入 + 换人归零）',
      (sessionSrc.match(/本会话累计未缓存输入/g) || []).length >= 2
      && sessionSrc.includes('换人归零'), {
        hits: (sessionSrc.match(/本会话累计未缓存输入/g) || []).length,
      });
    check('C2 默认常量单源：SESSION_CUMULATIVE_WARN_DEFAULT=500 万 / FORCE=1000 万，且 OF(role) 用它',
      Number(S.SESSION_CUMULATIVE_WARN_DEFAULT) === 5000000
      && Number(S.SESSION_CUMULATIVE_FORCE_DEFAULT) === 10000000
      && Number(limits.defaults.warn) === 5000000 && Number(limits.defaults.force) === 10000000,
      { warn: S.SESSION_CUMULATIVE_WARN_DEFAULT, force: S.SESSION_CUMULATIVE_FORCE_DEFAULT, defaults: limits.defaults });
    check('C3 提醒路径判定值＝row.input（未缓存输入），不是累计含缓存读的 row.tokens',
      /const judged = Number\.isFinite\(inputTokens\) && inputTokens > 0 \? inputTokens : tokens;/.test(sessionSrc)
      && /usageLevelOf\(judged, warnThreshold, forceThreshold\)/.test(sessionSrc), {});

    // ── D 刻意保留的纯函数刻度（非生产生效阈值） ─────────────────────────
    check('D1 usageLevelOf 缺省形参仍是 30/50 万刻度（selftest 边界断言依赖；生产一律显式传 sessionLimitsOf）',
      S.usageLevelOf(299999) === 'ok' && S.usageLevelOf(300000) === 'warn'
      && S.usageLevelOf(500000) === 'force' && Number(S.DEFAULT_TOKEN_WARN) === 300000
      && Number(S.DEFAULT_TOKEN_FORCE) === 500000,
      { DEFAULT_TOKEN_WARN: S.DEFAULT_TOKEN_WARN, DEFAULT_TOKEN_FORCE: S.DEFAULT_TOKEN_FORCE });
  } finally {
    if (String(process.env.AWB_KEEP_SANDBOX || '') !== '1') {
      try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* ignore */ }
    } else {
      console.log(`沙盘保留：${sandbox}`);
    }
  }
  const pass = rows.filter((r) => r.ok).length;
  console.log(`\n${pass}/${rows.length} PASS`);
  process.exit(pass === rows.length ? 0 : 1);
})().catch((e) => {
  console.error('USAGE_SEMANTICS_FAILED ' + String((e && e.stack) || e));
  process.exit(2);
});
