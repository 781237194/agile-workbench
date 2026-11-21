#!/usr/bin/env node
'use strict';
/**
 * test-740a-sandbox-guard.cjs —— T-20261121-124254-740a 沙盘写盘治理
 *
 * A 超限拒绝：体积超 maxBytes / 文件数超 maxFiles → SANDBOX_LIMIT_EXCEEDED（退出码 2）+ 提示 prune
 * B 正常退出自清：子进程 acquire 后正常退出 → 目录已删
 * C 强杀回收：子进程 acquire 后被 SIGKILL，下次 acquire 按 stale 清扫回收
 * D 审计两行：沙盘审计.jsonl 含 sandbox_prune + sandbox_prune_done
 * E 证据静态检查：产出目录内不得出现 _tmp/ 路径（检查脚本自身可运行）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const ROWS = [];
const JSON_OUT = process.argv.includes('--json');
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 500)}`);
}
const SANDBOX_ROOT_BASE = process.env.AWB_SANDBOX_ROOT || 'D:/awb-sandbox/tmp';
fs.mkdirSync(SANDBOX_ROOT_BASE, { recursive: true });
const ROOT_DIR = fs.mkdtempSync(path.join(SANDBOX_ROOT_BASE, 'sg740a-'));
const GUARD = path.join(ROOT, 'scripts', 'sandbox-guard.cjs');
const CHILD = path.join(ROOT_DIR, 'child.cjs');
fs.writeFileSync(CHILD, `'use strict';
const guard = require(${JSON.stringify(GUARD)});
const root = process.env.SG_ROOT;
let r;
try { r = guard.acquire('kid', { root }); } catch (e) { console.error(String(e.code || 'SANDBOX_GUARD_FAILED') + ': ' + String(e.message || e)); process.exit(2); }
console.log('DIR=' + r.dir);
if (process.env.SG_FILL === '1') require('node:fs').writeFileSync(require('node:path').join(r.dir, 'big.bin'), Buffer.alloc(Number(process.env.SG_FILL_BYTES || 4096)));
if (process.env.SG_HANG === '1') setTimeout(() => {}, 15000);
`, 'utf8');

function runChild(env, wait = 20000) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [CHILD], { env: { ...process.env, SG_ROOT: ROOT_DIR, TEMP: ROOT_DIR, TMP: ROOT_DIR, TMPDIR: ROOT_DIR, ...env }, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '';
    child.stdout.on('data', (d) => { out += String(d); });
    child.stderr.on('data', (d) => { out += String(d); });
    const timer = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* ignore */ } }, wait);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code, signal, out }); });
  });
}

(async () => {
  // A 超限拒绝（maxBytes 极小）
  {
    const r = await runChild({ AWB_SANDBOX_MAX_BYTES: '1', AWB_SANDBOX_MAX_FILES: '1000000', SG_FILL: '1', SG_FILL_BYTES: '4096' });
    check('A 超限拒绝：退出码 2 + SANDBOX_LIMIT_EXCEEDED + 提示 prune',
      r.code === 2 && /SANDBOX_LIMIT_EXCEEDED/.test(r.out) && /prune/.test(r.out), { code: r.code, out: r.out.slice(-400) });
  }

  // B 正常退出自清
  {
    const r = await runChild({ AWB_SANDBOX_MAX_BYTES: String(64 * 1024 * 1024) });
    const dir = (r.out.match(/DIR=(.+)/) || [])[1] || '';
    check('B 正常退出自清：目录已删除', r.code === 0 && dir && !fs.existsSync(dir), { code: r.code, dir, exists: dir ? fs.existsSync(dir) : null, out: r.out.slice(-200) });
  }

  // C 强杀后下次启动回收
  {
    const r = await runChild({ AWB_SANDBOX_MAX_BYTES: String(64 * 1024 * 1024), SG_FILL: '1', SG_FILL_BYTES: '2048', SG_HANG: '1' }, 1500);
    const killedDir = (r.out.match(/DIR=(.+)/) || [])[1] || '';
    const stillThere = killedDir ? fs.existsSync(killedDir) : false;
    await new Promise((res) => setTimeout(res, 150));
    const r2 = await runChild({ AWB_SANDBOX_MAX_BYTES: String(64 * 1024 * 1024), AWB_SANDBOX_STALE_MS: '50' });
    check('C 强杀残留 → 下次启动按 stale 清扫回收',
      r.signal === 'SIGKILL' && stillThere && r2.code === 0 && !fs.existsSync(killedDir), { signal: r.signal, killedDir, stillThere, code2: r2.code, existsAfter: killedDir ? fs.existsSync(killedDir) : null });
  }

  // D 审计两行
  {
    const file = path.join(path.dirname(ROOT_DIR), '沙盘审计.jsonl');
    let rows = [];
    try { rows = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch { rows = []; }
    const prune = rows.filter((x) => x.event === 'sandbox_prune').length;
    const done = rows.filter((x) => x.event === 'sandbox_prune_done').length;
    check('D 审计两行：sandbox_prune + sandbox_prune_done', prune >= 1 && done >= 1, { prune, done, file });
  }

  // E 证据静态检查脚本可运行（真实仓库扫一遍，不要求 0 命中时只提示）
  {
    const r = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'check-no-sandbox-paths-in-evidence.cjs')], { encoding: 'utf8', timeout: 60000 });
    check('E 证据静态检查脚本可运行（exit 0 或 1，有明确输出）', r.status === 0 || r.status === 1, { status: r.status, out: String(r.stdout || '').slice(-200) });
  }

  try { fs.rmSync(ROOT_DIR, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = ROWS.filter((r) => !r.ok).length;
  if (JSON_OUT) console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed, failed: ROWS.filter((r) => !r.ok).map((r) => r.name), rows: ROWS }, null, 2));
  else console.log(`\n${ROWS.length - failed}/${ROWS.length} PASS${failed ? ' · ' + failed + ' FAIL' : ''}`);
  process.exit(failed ? 1 : 0);
})();
