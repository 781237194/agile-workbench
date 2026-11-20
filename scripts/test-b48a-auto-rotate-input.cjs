'use strict';
/**
 * 夹具：B-20261120-121307-b48a —— auto-rotate 判档口径对齐 session.mjs
 *
 * 缺陷：`collectCandidates` 用 `row.tokens`（累计**含缓存读**，pm 现盘 12.6 亿）比阈值 →
 *       长会话恒判 force；且 WARN_ONLY/交接请求文案把阈值写死 30/50 万，与实际 500 万/1000 万不一致。
 *
 * 断言：
 *   A1 真实 pm 量级（tokens 12.6 亿 + input 457 万）→ 不判 force（无候选）
 *   A2 input 510 万 → warn；A3 input 1010 万 → force
 *   A4 无 input 字段（旧数据）→ 回落 tokens 判档（1010 万 → force，rawTokens 保留）
 *   A5 项目覆盖（warn 100 万/force 200 万）+ input 210 万 → force（覆盖优先）
 *   B1 交接请求正文用传入的实际阈值（500 万/1000 万），不出现 300000/500000
 *   B2 源码断言：判档取 row.input、文案取 item.warn/item.force（无 ${DEFAULT_TOKEN_WARN} 硬编码）
 *   B3 真实 会话用量.json：pm 按 input 判「非 force」
 *   C  隔离：真实 团队.json / workbench.json sha256 不变
 *
 * 跑法：node scripts/test-b48a-auto-rotate-input.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-b48a-'));
const results = [];
function check(id, name, ok, detail) {
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${name}${ok ? '' : '  ← ' + String(JSON.stringify(detail === undefined ? '' : detail)).slice(0, 320)}`);
  if (!ok) process.exitCode = 1;
}
function sha(file) { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16); } catch { return '(missing)'; } }

(async () => {
  const realTeam = path.join(ROOT, '团队', '状态', '团队.json');
  const realWb = path.join(ROOT, 'data', 'userdata', 'workbench.json');
  const before = { team: sha(realTeam), wb: sha(realWb) };

  // 模块 import 前把 PATHS 指到一次性沙盘（auto-rotate/session 在 import 时解析 TEAM_ROOT）
  process.env.TEAM_ROOT = path.join(SB, '团队');
  process.env.TEAM_PROJECTS_ROOT = path.join(SB, '项目');
  process.env.TEAM_WORKBENCH_JSON = path.join(SB, 'workbench.json');
  process.env.AWB_DATA_DIR = path.join(SB, 'data');
  process.env.TEAM_SELFTEST = '1';
  fs.mkdirSync(path.join(SB, '团队'), { recursive: true });

  const ar = await import(pathToFileURL(path.join(ROOT, '团队', '工具', 'lib', 'auto-rotate.mjs')).href);
  const sess = await import(pathToFileURL(path.join(ROOT, '团队', '工具', 'lib', 'session.mjs')).href);
  const now = Date.now();
  const at = new Date(now).toISOString();
  const limits = { warn: 5000000, force: 10000000 };
  const pick = (usage, limitsOf = () => limits) => ar.collectCandidates({ now, usage, rounds: {}, memberRoles: ['analyst'], limitsOf });

  // A1 真实 pm 量级：tokens 12.6 亿（含缓存读）+ input 457 万 → ok，无候选
  {
    const c = pick({ analyst: { tokens: 1263350916, input: 4572284, at } });
    check('A1', 'tokens 12.6 亿 + input 457 万 → 不判 force/warn（无候选）', Array.isArray(c) && c.length === 0, { c });
  }
  // A2 input 510 万 → warn
  {
    const c = pick({ analyst: { tokens: 1263350916, input: 5100000, at } });
    check('A2', 'input 5,100,000 → warn（判档值取 input，不是 tokens）', c.length === 1 && c[0].level === 'warn' && c[0].tokens === 5100000, { c });
  }
  // A3 input 1010 万 → force
  {
    const c = pick({ analyst: { tokens: 300000, input: 10100000, at } });
    check('A3', 'input 10,100,000 → force（即使 tokens 很小也按 input 判）', c.length === 1 && c[0].level === 'force' && c[0].tokens === 10100000, { c });
  }
  // A4 无 input → 回落 tokens
  {
    const c = pick({ analyst: { tokens: 10100000, at } });
    check('A4', '无 input 字段（旧数据）→ 回落 tokens 判档：10,100,000 → force 且 rawTokens 保留', c.length === 1 && c[0].level === 'force' && c[0].tokens === 10100000 && c[0].rawTokens === 10100000, { c });
  }
  // A5 项目覆盖优先
  {
    const c = pick({ analyst: { tokens: 1, input: 2100000, at } }, () => ({ warn: 1000000, force: 2000000 }));
    check('A5', '项目 项目.json → sessionLimits 覆盖（warn 100 万/force 200 万）+ input 210 万 → force', c.length === 1 && c[0].level === 'force' && c[0].warn === 1000000 && c[0].force === 2000000, { c });
  }
  // B1 交接请求正文用实际阈值
  {
    const body = ar.handoverRequestBody({ role: 'analyst', level: 'force', kind: 'usage', tokens: 10100000, rounds: null, deadlineIso: '2026-11-20T13:00:00Z', projectName: 'p', warn: 5000000, force: 10000000 });
    check('B1', '交接请求正文写实际阈值（5000000/10000000），不出现写死的 300000/500000',
      body.includes('force 10000000') && body.includes('warn 5000000')
      && !body.includes('warn 300000') && !body.includes('force 500000'), { body: body.slice(0, 200) });
  }
  // B2 源码断言：判档取 row.input、文案取 item.warn/item.force
  {
    const src = fs.readFileSync(path.join(ROOT, '团队', '工具', 'lib', 'auto-rotate.mjs'), 'utf8');
    const okInput = src.includes('const inputTokens = Number(row.input)') && src.includes('usageLevelOf(judged, roleWarn, roleForce)');
    const okMsg = src.includes('item.warn || DEFAULT_TOKEN_WARN') && src.includes('item.force || DEFAULT_TOKEN_FORCE');
    const noHard = !src.includes('${DEFAULT_TOKEN_WARN}') && !src.includes('${DEFAULT_TOKEN_FORCE}');
    check('B2', '源码：判档取 row.input（判据 judged）+ 文案取 item.warn/item.force + 无 ${DEFAULT_TOKEN_*} 硬编码', okInput && okMsg && noHard, { okInput, okMsg, noHard });
  }
  // B3 真实数据：pm 按 input 判「非 force」
  {
    const file = path.join(ROOT, '团队', '状态', '项目', '工作台改造修复', '会话用量.json');
    let row = null;
    try { row = JSON.parse(fs.readFileSync(file, 'utf8')).pm || null; } catch { row = null; }
    if (!row) {
      check('B3', '真实 会话用量.json 存在 pm 行（缺失则跳过，不算失败）', true, { skipped: true });
    } else {
      const lim = sess.sessionLimitsOf('工作台改造修复').of('pm');
      const judged = Number.isFinite(Number(row.input)) && Number(row.input) > 0 ? Number(row.input) : Number(row.tokens);
      const level = sess.usageLevelOf(judged, lim.warn, lim.force);
      const oldLevel = sess.usageLevelOf(Number(row.tokens), lim.warn, lim.force);
      check('B3', '真实数据：pm 按 input 判档 ≠ force（旧口径 tokens 会判 force）',
        level !== 'force' && oldLevel === 'force', { input: row.input, tokens: row.tokens, judged, level, oldLevel, lim });
    }
  }
  // C 隔离
  {
    const after = { team: sha(realTeam), wb: sha(realWb) };
    check('C', '隔离：真实 团队.json / workbench.json sha256 前后不变', before.team === after.team && before.wb === after.wb, { before, after });
  }

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} PASS`);
  try { fs.rmSync(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* 清理失败不影响结论 */ }
})();
