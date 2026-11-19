#!/usr/bin/env node
'use strict';
/**
 * test-d1bf-ac45-verify.cjs —— R-d1bf / TR-Q 两条非阻断的**独立**验收夹具（B 侧，2026-11-19）。
 * A 的工具层实现：4c515da/ae464a1（AWB_WAKE_FAIL 一次性注入、retryOf 关联、AWB_NOW_MS/clock、trigger 字段）。
 * 本夹具不复制 A 的 test-d1bf-wake-timer-zero，而是用自己的沙盘独立验：
 *   AC5：AWB_WAKE_FAIL=1 注入 → 首行 ok:false（带 id/messageId）→ 400ms 重试成功行 retryOf=首行 id、同 messageId、
 *        trigger='event'；该消息唤醒行 ≤3、无 timer 行；返回体带 retryOf。
 *   AC4①：计时写死「wakeWithGuard 返回时刻 − 唤醒行 at ≤2000ms」（行 at 由 appendWakeLog 同源写入）。
 *   隔离：全部 %TEMP% 沙盘（TEAM_ROOT/TEAM_PROJECTS_ROOT/TEAM_SELFTEST），真实 团队/状态 零写入（sha 前后比对）。
 * 用法：node scripts/test-d1bf-ac45-verify.cjs [--out <dir>]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TEAM = path.join(ROOT, '团队');
const TOOL = path.join(TEAM, '工具', 'team.mjs');
const OPS_SRC = path.join(TEAM, '工具', 'lib', 'ops.mjs');
const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-d1bf-ac45'); })();
const rows = [];
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
function check(name, ok, detail) { rows.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail }); console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : ' :: ' + String(JSON.stringify(detail)).slice(0, 500))); }
function runNode(args, env) { const r = spawnSync(process.execPath, args, { encoding: 'utf8', timeout: 120000, env: { ...process.env, ...env } }); return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') }; }
function readJsonl(file) { try { return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } }
function realStateSig() {
  const base = path.join(TEAM, '状态', '项目');
  const out = [];
  try {
    for (const d of fs.readdirSync(base, { withFileTypes: true })) {
      if (!d.isDirectory()) continue;
      const f = path.join(base, d.name, '唤醒.jsonl');
      out.push(f + ':' + (fs.existsSync(f) ? sha(fs.readFileSync(f)) : 'MISSING'));
    }
  } catch { /* ignore */ }
  return out.join('|');
}

(async () => {
  const opsSrc = fs.readFileSync(OPS_SRC, 'utf8');
  // ── S 静态：TR-Q 两条的实现锚点存在 ─────────────────────────────
  check('S1 ops 有 AWB_WAKE_FAIL 沙盘一次性注入钩子', /AWB_WAKE_FAIL/.test(opsSrc) && /awbWakeFailConsumed/.test(opsSrc), null);
  check('S2 ops 唤醒行生成 id 且重试写 retryOf', /retryOf/.test(opsSrc) && /appendWakeLog/.test(opsSrc), null);
  check('S3 ops 唤醒行写 trigger（event/manual/legacy 词表）', /trigger/.test(opsSrc) && /'event'/.test(opsSrc), null);
  check('S4 唤醒判定走可注入时钟 readNowMs/clock.mjs', fs.existsSync(path.join(TEAM, '工具', 'lib', 'clock.mjs')) && /readNowMs/.test(opsSrc), null);

  // ── 沙盘 ──────────────────────────────────────────────────────────
  const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'd1bf-ac45-'));
  const TEAM_ROOT = path.join(SB, '团队');
  const PROJ_ROOT = path.join(SB, '项目');
  fs.mkdirSync(PROJ_ROOT, { recursive: true });
  const env = { TEAM_ROOT, AWB_TEAM_ROOT: TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJ_ROOT, TEAM_SELFTEST: '1', AWB_DATA_DIR: path.join(SB, 'data') };
  const realBefore = realStateSig();
  const projectName = 'd1bf-ac45';
  try {
    const initRun = runNode([TOOL, 'init'], env);
    const addRun = runNode([TOOL, 'project', 'add', '--name', projectName, '--team-mode', 'fast'], env);
    check('S0 沙盘 init + 项目注册', initRun.code === 0 && addRun.code === 0, { init: initRun.code, add: addRun.code, tail: (initRun.err + addRun.err).slice(-300) });
    const projectsDir = path.join(TEAM_ROOT, '状态', '项目');
    let stateDir = '';
    if (fs.existsSync(projectsDir)) {
      for (const e of fs.readdirSync(projectsDir, { withFileTypes: true })) {
        if (e.isDirectory() && fs.existsSync(path.join(projectsDir, e.name, '项目.json'))) { stateDir = path.join(projectsDir, e.name); break; }
      }
    }
    check('S1 找到沙盘项目状态目录', Boolean(stateDir), { projectsDir });
    const wakeFile = stateDir ? path.join(stateDir, '唤醒.jsonl') : path.join(SB, 'missing.jsonl');
    const baseRows = readJsonl(wakeFile).length;

    // ── AC5 + AC4①：wakeWithGuard 注入一次失败 → 400ms 重试成功 ─────────
    const probe = path.join(SB, 'ac45-probe.mjs');
    fs.writeFileSync(probe, [
      `import { wakeWithGuard } from ${JSON.stringify('file:///' + OPS_SRC.replace(/\\/g, '/'))};`,
      'const project = process.env.AWB_AC45_PROJECT || "";',
      'const t0 = Date.now();',
      "const r = await wakeWithGuard({ project, to: 'programmer1', msg: { id: 'M-AC45-1', kind: 'notice', from: 'pm', to: 'programmer1', subject: 'AC45 验签' }, isDispatch: true, reason: 'ac45-fixture' });",
      "console.log('AC45 ' + JSON.stringify({ r, t0, t1: Date.now() }));",
    ].join('\n'), 'utf8');
    const run = runNode([probe], { ...env, AWB_AC45_PROJECT: projectName, AWB_WAKE_FAIL: '1' });
    const line = run.out.split(/\r?\n/).find((l) => l.startsWith('AC45 '));
    let probeOut = null;
    if (line) { try { probeOut = JSON.parse(line.slice(5)); } catch { probeOut = null; } }
    check('AC5-0 探针返回可解析（无崩溃）', Boolean(probeOut), { err: run.err.slice(-400), out: run.out.slice(-400) });
    const wakeRows = readJsonl(wakeFile);
    const msgRows = wakeRows.filter((r) => r && ((Array.isArray(r.messageIds) && r.messageIds.includes('M-AC45-1')) || r.messageId === 'M-AC45-1'));
    const failRow = msgRows.find((r) => r.ok === false);
    const okRow = msgRows.find((r) => r.ok === true && r.retryOf);
    check('AC5-1 首行失败行：ok:false + 有 id + messageId=M-AC45-1', Boolean(failRow && failRow.id && failRow.messageId === 'M-AC45-1' && failRow.trigger === 'event'), { failRow, msgRows: msgRows.length });
    check('AC5-2 重试成功行：retryOf=首行 id、同 messageId、trigger=event', Boolean(okRow && failRow && okRow.retryOf === failRow.id && (okRow.messageId === 'M-AC45-1' || (Array.isArray(okRow.messageIds) && okRow.messageIds.includes('M-AC45-1'))) && okRow.trigger === 'event'), { okRow, failRowId: failRow && failRow.id });
    check('AC5-3 该消息唤醒行 ≤3 且无 timer 行', msgRows.length >= 1 && msgRows.length <= 3 && wakeRows.every((r) => r.trigger !== 'timer'), { msgRows: msgRows.length, triggers: wakeRows.map((r) => r.trigger) });
    check('AC5-4 返回体带 retryOf（与首行 id 一致）', Boolean(probeOut && probeOut.r && probeOut.r.retryOf && failRow && probeOut.r.retryOf === failRow.id), { retryOf: probeOut && probeOut.r && probeOut.r.retryOf, failId: failRow && failRow.id });
    const atMs = okRow ? Date.parse(String(okRow.time || okRow.at || '')) : NaN;
    const elapsed = okRow && Number.isFinite(atMs) ? atMs - Number(probeOut.t0) : null;
    check('AC4-1 唤醒行 at 在 wakeWithGuard 返回前 2s 内（send 返回→行时间 ≤2000ms）', Number.isFinite(elapsed) && elapsed >= -2000 && elapsed <= 2000, { elapsed, at: okRow && (okRow.time || okRow.at), t0: probeOut && probeOut.t0, t1: probeOut && probeOut.t1 });
    check('AC4-2 整体返回 ≤2s（含 400ms 一次性重试）', Boolean(probeOut) && Number(probeOut.t1) - Number(probeOut.t0) <= 2000, probeOut && { ms: Number(probeOut.t1) - Number(probeOut.t0) });

    // ── 真实状态零写入 ───────────────────────────────────────────────
    const realAfter = realStateSig();
    check('I1 真实 团队/状态/项目 唤醒日志零写入（sha 前后一致）', realBefore === realAfter, { changed: true });
    const failed = rows.filter((r) => !r.ok);
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'd1bf-ac45-run.json'), JSON.stringify({ at: new Date().toISOString(), checks: rows, wakeRows: msgRows }, null, 2) + '\n', 'utf8');
    console.log('\nD1BF-AC45 ' + (failed.length ? 'FAIL' : 'OK') + ' ' + JSON.stringify({ total: rows.length, pass: rows.length - failed.length, red: failed.length }));
    console.log('证据：' + path.join(OUT, 'd1bf-ac45-run.json'));
    process.exitCode = failed.length ? 1 : 0;
  } catch (e) {
    check('运行未抛错', false, String((e && e.stack) || e).slice(0, 600));
    console.log('\nD1BF-AC45 FAIL');
    process.exitCode = 1;
  } finally {
    try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
  }
})().catch((e) => { console.error('D1BF-AC45 ERROR ' + String((e && e.stack) || e)); process.exit(1); });
