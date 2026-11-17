/**
 * T-20261117-211833-7a30 AC3 最终口径夹具（PM 2026-11-17 21:36）：
 *   rotateRounds 默认 8、上限 10；配置 >10 **fail fast**（AUTO_ROTATE_CONFIG_INVALID，不静默回落）；
 *   轮次触发审计写「本轮 N/10（归零即归档）」；计数器语义不变（ROUNDS_MAX 仍 10）。
 *
 * 断言：
 *   R1 缺省 → 8；R2 显式 7 → 7；R3 显式 10 → 10（上限内可用）；
 *   R4 11 → 抛 AUTO_ROTATE_CONFIG_INVALID（details 带 max=10/default=8）；
 *   R5 ROUNDS_MAX 仍是 10（未改计数器语义）；
 *   R6 auto-rotate 源码里轮次触发审计含「轮次 N/ROUNDS_MAX（归零即归档）」文案。
 *
 * 跑法：node scripts/test-a4c7-rotate-config.cjs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert');

const ROOT = (() => {
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, '团队', '工具', 'team.mjs'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('找不到仓库根');
})();
const LIB = path.join(ROOT, '团队', '工具', 'lib');
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

(async () => {
  const auto = await import('file:///' + path.join(LIB, 'auto-rotate.mjs').replace(/\\/g, '/'));
  const archive = await import('file:///' + path.join(LIB, 'session-archive.mjs').replace(/\\/g, '/'));
  const cfgOf = (raw) => auto.autoRotateConfigOf({ config: { autoRotate: raw } });

  check('R1 缺省 rotateRounds = 8', () => {
    assert.strictEqual(cfgOf({}).rotateRounds, 8);
    return '8';
  });
  check('R2 显式 7 → 7', () => {
    assert.strictEqual(cfgOf({ rotateRounds: 7 }).rotateRounds, 7);
    return '7';
  });
  check('R3 显式 10（上限）→ 10', () => {
    assert.strictEqual(cfgOf({ rotateRounds: 10 }).rotateRounds, 10);
    return '10';
  });
  check('R4 11 → fail fast AUTO_ROTATE_CONFIG_INVALID（含 max/default）', () => {
    let err = null;
    try { cfgOf({ rotateRounds: 11 }); } catch (e) { err = e; }
    assert.ok(err, '没有抛错（静默回落了）');
    assert.strictEqual(err.code, 'AUTO_ROTATE_CONFIG_INVALID');
    assert.strictEqual(err.details.max, 10);
    assert.strictEqual(err.details.default, 8);
    return err.code;
  });
  check('R5 ROUNDS_MAX 仍为 10（计数器语义未改）', () => {
    assert.strictEqual(archive.ROUNDS_MAX, 10);
    return '10';
  });
  check('R6 轮次触发审计含「归零即归档」与 /ROUNDS_MAX', () => {
    const src = fs.readFileSync(path.join(LIB, 'auto-rotate.mjs'), 'utf8');
    assert.ok(/归零即归档/.test(src), '审计文案缺「归零即归档」');
    assert.ok(/轮次 \$\{item\.rounds\}\/\$\{ROUNDS_MAX\}/.test(src), '审计文案缺 N/ROUNDS_MAX');
    return '文案在';
  });

  // B-220423-4355（PM 推荐 B 案）：sched 侧不崩——>10 clamp 到 10 且 reasons 带 CONFIG_CLAMPED。
  const sched = await import('file:///' + path.join(LIB, 'sched-advice.mjs').replace(/\\/g, '/'));
  check('R7 sched 纯函数：rotateRounds=11 → clamp 10 + CONFIG_CLAMPED；10 正常', () => {
    const bad = sched.buildSchedAdvice({ now: Date.now(), project: 'x', rotateRounds: 11, tasks: [], taskSourceAvailable: true });
    assert.strictEqual(bad.ok, true, 'sched 不应崩/不 ok');
    assert.strictEqual(bad.rotateRounds, 10);
    assert.ok(/CONFIG_CLAMPED/.test(String(bad.configWarning || '')), '缺 configWarning');
    assert.ok(bad.roles.every((r) => r.reasons.some((x) => /CONFIG_CLAMPED/.test(x))), 'reasons 里缺 CONFIG_CLAMPED');
    const good = sched.buildSchedAdvice({ now: Date.now(), project: 'x', rotateRounds: 10, tasks: [], taskSourceAvailable: true, queue: null });
    assert.strictEqual(good.ok, true);
    assert.strictEqual(good.rotateRounds, 10);
    assert.strictEqual(good.configWarning, '');
    return '11→clamp 10+告警 / 10 正常';
  });

  check('R8 CLI：sched advice --rotate-rounds 11 exit 0 且带 CONFIG_CLAMPED；10 正常', () => {
    const { execFileSync } = require('node:child_process');
    const team = path.join(ROOT, '团队', '工具', 'team.mjs');
    const run = (extra) => {
      try {
        return { code: 0, out: execFileSync(process.execPath, [team, 'sched', 'advice', '--project', '工作台改造修复', '--json', ...extra], { encoding: 'utf8', timeout: 120000 }) };
      } catch (e) { return { code: e.status == null ? 1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') }; }
    };
    const bad = run(['--rotate-rounds', '11']);
    assert.strictEqual(bad.code, 0, '11 应正常返回（只读建议不崩）');
    assert.ok(/CONFIG_CLAMPED/.test(bad.out), bad.out.slice(0, 300));
    const good = run(['--rotate-rounds', '10']);
    assert.strictEqual(good.code, 0);
    assert.ok(!/CONFIG_CLAMPED/.test(good.out), '10 不应告警');
    return 'CLI clamp+告警 / 不崩';
  });

  const pass = results.filter((r) => r.ok).length;
  console.log(`\nA4C7_ROTATE_CFG ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
  if (pass !== results.length) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
