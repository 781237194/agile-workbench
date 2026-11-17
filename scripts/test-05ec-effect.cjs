/**
 * R-8947（T-20261117-214109-05ec）自检：关闭特效开关三档（off/low/full）+ 持久化 + 主题/动效联动 + layout-check 不回归。
 *
 * 断言：
 *   E1 第一次 --effect-check（干净档）全绿：AC1 入口不越界、AC2 三档选中态/文案、AC3 500ms 内生效（degrade off/full、粒子/网格）、
 *      AC5 写盘正确（ui.effectLevel / .bak 原子写 / 幂等 changed:false / 绕过界面传 abc → EFFECT_LEVEL_INVALID 且 sha 不变）、截图 1 张；
 *   E2 第二次同数据根启动（重启恢复）：启动即 off（属性/菜单/degrade），且收尾复位 full；
 *   E3 真实 data/userdata/workbench.json 前后 sha256 不变（隔离零污染）；
 *   E4 layout-check 不回归：1280/1680/2560 三宽 themeInMoreMenu / titlebarNoOverlap / titlebarButtonsInView / themeNotInTitlebar 全 true。
 *
 * 跑法：node scripts/test-05ec-effect.cjs   （会起 3 次 Electron 真窗口，约 1 分钟）
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');

const ROOT = (() => {
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, '团队', '工具', 'team.mjs'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('找不到仓库根');
})();
const sha = (f) => (fs.existsSync(f) ? crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex') : 'missing');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const SB = path.join(ROOT, '_tmp', `effect-05ec-${process.pid}`);
const DATA = path.join(SB, 'data');
const OUT1 = path.join(SB, 'out1');
const OUT2 = path.join(SB, 'out2');
const LAYOUT_DATA = path.join(SB, 'layout');
const LAYOUT_OUT = path.join(SB, 'layout-out');
const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS  ${name}${detail ? `  ${detail}` : ''}`);
  } catch (e) {
    results.push({ name, ok: false, error: String((e && e.message) || e) });
    console.log(`FAIL  ${name}\n      ${String((e && e.message) || e).split('\n')[0]}`);
  }
}
function run(flag, env) {
  try {
    return { ok: true, out: execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', flag], { cwd: ROOT, encoding: 'utf8', timeout: 300000, env: { ...process.env, ...env } }) };
  } catch (e) {
    return { ok: false, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}
fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(SB, { recursive: true });
const realBefore = sha(REAL_STORE);

const run1 = run('--effect-check', { AWB_EFFECT_DATA: DATA, AWB_EFFECT_OUT: OUT1 });

check('E1 首跑 --effect-check：EFFECT_OK 且报告 ok:true（AC1/AC2/AC3/AC5 全绿）', () => {
  assert.ok(run1.ok, `退出非 0：${String(run1.out).slice(-500)}`);
  assert.ok(/EFFECT_OK/.test(run1.out), '未输出 EFFECT_OK');
  const rep = JSON.parse(fs.readFileSync(path.join(OUT1, 'effect-report.json'), 'utf8'));
  assert.strictEqual(rep.ok, true, `有断言未过：${JSON.stringify(rep.checks.filter((c) => !c.ok).map((c) => c.name))}`);
  assert.ok(rep.checks.length >= 9, `断言数不足 ${rep.checks.length}`);
  assert.ok(fs.existsSync(rep.shot) && fs.statSync(rep.shot).size > 1000, '截图证据缺失');
  return `${rep.checks.length} 断言 + 截图 ${rep.shot.split(path.sep).pop()}`;
});

const run2 = run('--effect-check', { AWB_EFFECT_DATA: DATA, AWB_EFFECT_OUT: OUT2 });

check('E2 同数据根二次启动（重启恢复 AC4③）：启动即 off 且收尾复位 full', () => {
  assert.ok(run2.ok && /EFFECT_OK/.test(run2.out), `二次启动未过：${String(run2.out).slice(-400)}`);
  const rep = JSON.parse(fs.readFileSync(path.join(OUT2, 'effect-report.json'), 'utf8'));
  assert.strictEqual(rep.startLevel, 'off', `启动档不是 off：${rep.startLevel}`);
  assert.strictEqual(rep.ok, true, '重启恢复断言未过');
  const store = JSON.parse(fs.readFileSync(path.join(DATA, 'workbench.json'), 'utf8'));
  assert.strictEqual(String((store.ui && store.ui.effectLevel) || ''), 'full', '收尾未复位 full');
  return 'off 恢复 + 复位 full';
});

check('E3 隔离：真实 data/userdata/workbench.json sha256 前后不变', () => {
  assert.strictEqual(sha(REAL_STORE), realBefore, '真实 workbench.json 被改写');
  return '零污染';
});

const layout = run('--layout-check', { AWB_LAYOUT_DATA: LAYOUT_DATA, AWB_LAYOUT_OUT: LAYOUT_OUT });

check('E4 layout-check 四断言三宽全绿（themeInMoreMenu/titlebarNoOverlap/titlebarButtonsInView/themeNotInTitlebar）', () => {
  assert.ok(layout.ok && /LAYOUT_OK/.test(layout.out), 'layout-check 未过');
  const rep = JSON.parse(fs.readFileSync(path.join(LAYOUT_OUT, 'layout-report.json'), 'utf8'));
  const keys = ['themeInMoreMenu', 'titlebarNoOverlap', 'titlebarButtonsInView', 'themeNotInTitlebar'];
  for (const r of rep.results || []) {
    for (const k of keys) assert.strictEqual(r.metrics.checks[k], true, `${r.size} 宽 ${k} 未通过`);
  }
  return `${(rep.results || []).length} 宽 × 4 断言`;
});

fs.rmSync(SB, { recursive: true, force: true });
const pass = results.filter((r) => r.ok).length;
console.log(`\nEFFECT_05EC ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
if (pass !== results.length) process.exit(1);
