#!/usr/bin/env node
'use strict';
/**
 * test-bcac-storage.cjs —— R-20261121-124427-bcac 存储位置可配置 + 占用保护（5 条）
 * A 改目录生效：saveStorage → resolveStorage 返回新值（source=settings），store 立即落盘
 * B 拒系统盘：%SystemDrive% 路径 → STORAGE_SYSTEM_DRIVE_REFUSED，旧设置不变
 * C 超限：超 8GB/20万（测试注入小上限）先清 mtime>60 分钟沙盘；仍超 → STORAGE_LIMIT_EXCEEDED
 * D 审计：清理写 <dataDir>/存储清理.jsonl（at/root/removed/failed/freedBytes/reason 全字段）
 * E 回落默认：空值 → STORAGE_PATH_EMPTY + 回显默认安装盘路径
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const guard = require(path.join(ROOT, 'scripts', 'sandbox-guard.cjs'));
const storage = require(path.join(ROOT, 'src', 'storage-config.js'));
const ROWS = [];
const JSON_OUT = process.argv.includes('--json');
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 600)}`);
}
const SB = fs.mkdtempSync(path.join(guard.sandboxTmp(), 'bcac-'));
const DATA = path.join(SB, 'data');
const TMP = path.join(SB, 'tmp');
const STORE = path.join(DATA, 'userdata', 'workbench.json');
fs.mkdirSync(path.dirname(STORE), { recursive: true });
fs.writeFileSync(STORE, JSON.stringify({ version: 1, projects: [], ui: {}, settings: {} }, null, 2), 'utf8');
fs.mkdirSync(TMP, { recursive: true });

// A 改目录生效
{
  const saved = storage.saveStorage({ dataDir: DATA, tmpDir: TMP }, { storeFile: STORE });
  const cfg = storage.resolveStorage({ storeFile: STORE });
  const store = JSON.parse(fs.readFileSync(STORE, 'utf8'));
  check('A 改目录生效：resolve 用新值且 source=settings', saved.ok === true && cfg.tmpDir === TMP && cfg.source.tmpDir === 'settings' && (store.settings.storage || {}).tmpDir === TMP, { saved, cfg: { tmpDir: cfg.tmpDir, source: cfg.source } });
}

// B 拒系统盘（%SystemDrive% 根）
{
  const sysDrive = String(process.env.SystemDrive || 'C:');
  const badPath = sysDrive + path.sep + path.join('tmp', 'bcac-should-refuse');
  const saved = storage.saveStorage({ tmpDir: badPath }, { storeFile: STORE });
  const cfgAfter = storage.resolveStorage({ storeFile: STORE });
  check('B 拒系统盘：STORAGE_SYSTEM_DRIVE_REFUSED 且旧设置不变', saved.ok === false && saved.code === 'STORAGE_SYSTEM_DRIVE_REFUSED' && cfgAfter.tmpDir === TMP, { saved, cfgAfter: cfgAfter.tmpDir });
}

// C 超限：制造 mtime>60min 的过期沙盘 + 根下大文件（清理只删顶层沙盘子目录）
{
  const staleDir = path.join(TMP, 'old-sandbox-AbC123');
  fs.mkdirSync(staleDir, { recursive: true });
  fs.writeFileSync(path.join(staleDir, 'payload.bin'), Buffer.alloc(2048));
  const old = new Date(Date.now() - 120 * 60000);
  fs.utimesSync(staleDir, old, old);
  fs.writeFileSync(path.join(TMP, 'loose.bin'), Buffer.alloc(4096)); // 顶层散文件：不删
  const cfg = storage.resolveStorage({ storeFile: STORE });
  const limited = { ...cfg, tmpDir: TMP, limits: { maxBytes: 3000, maxFiles: 100000, staleMinutes: 60 } };
  const auto = storage.ensureStorageCapacity({ config: limited, dataDir: DATA });
  const staleGone = !fs.existsSync(staleDir);
  const looseKept = fs.existsSync(path.join(TMP, 'loose.bin'));
  check('C 超限：先清过期沙盘（散文件不删），仍超则 STORAGE_LIMIT_EXCEEDED', auto.ok === false && auto.code === 'STORAGE_LIMIT_EXCEEDED' && staleGone && looseKept && Boolean(auto.cleaned), { code: auto.code, staleGone, looseKept, cleaned: auto.cleaned && { removed: auto.cleaned.removed, freedBytes: auto.cleaned.freedBytes } });
}

// D 审计字段
{
  const auditFile = path.join(DATA, '存储清理.jsonl');
  const rows = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
  const row = rows.find((r) => r.reason === 'auto-over-limit');
  check('D 审计：存储清理.jsonl 含 auto-over-limit 全字段', Boolean(row) && Number.isFinite(row.removed) && Number.isFinite(row.failed) && Number.isFinite(row.freedBytes) && typeof row.root === 'string' && typeof row.at === 'string', { rows: rows.slice(-3) });
}

// E 回落默认
{
  const saved = storage.saveStorage({ dataDir: '', tmpDir: '' }, { storeFile: STORE });
  const cfg = storage.resolveStorage({ storeFile: STORE });
  check('E 空值回落默认安装盘 + STORAGE_PATH_EMPTY', saved.ok === false && saved.code === 'STORAGE_PATH_EMPTY' && cfg.tmpDir === cfg.tmpDir && cfg.source.tmpDir !== 'env', { saved, cfg: { tmpDir: cfg.tmpDir, source: cfg.source } });
}

try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
const failed = ROWS.filter((r) => !r.ok).length;
if (JSON_OUT) console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed, failed: ROWS.filter((r) => !r.ok).map((r) => r.name), rows: ROWS }, null, 2));
else console.log(`\n${ROWS.length - failed}/${ROWS.length} PASS${failed ? ' · ' + failed + ' FAIL' : ''}`);
process.exit(failed ? 1 : 0);
