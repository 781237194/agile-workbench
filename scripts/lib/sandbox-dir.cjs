'use strict';
/**
 * B-20261116-055303-07b6：测试脚本沙盘统一入口。
 *
 * 背景：多个测试脚本把沙盘固定在 `_tmp/<名字>`，两人同时跑就互相 rm/重建：
 * 报 EPERM/ENOTEMPTY（Windows 上文件仍被占用）或复制到一半被打断后 MODULE_NOT_FOUND。
 * 约定：所有需要「目录型沙盘」的脚本都用 mkTempSandbox('<脚本短名>')，
 * 每次运行一个**唯一临时目录**，进程退出自动清理；报告件（_tmp/run-*.json 等）路径不变。
 *
 * 用法：
 *   const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));
 *   const SB = mkTempSandbox('c98e');            // → <repo>/_tmp/c98e-XXXXXX
 *   const SB2 = mkTempSandbox('x', { keep: true }); // 保留目录（排障用）
 */
const fs = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..', '..');

function mkTempSandbox(name, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const root = options.root ? path.resolve(String(options.root)) : REPO_ROOT;
  const base = path.join(root, '_tmp');
  fs.mkdirSync(base, { recursive: true });
  const prefix = String(name || 'sandbox').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'sandbox';
  const dir = fs.mkdtempSync(path.join(base, prefix + '-'));
  if (options.keep !== true) {
    process.on('exit', () => {
      try { fs.rmSync(dir, { recursive: true, force: true }); } catch { /* 退出清理失败不改变测试结论 */ }
    });
  }
  return dir;
}

module.exports = { mkTempSandbox, REPO_ROOT };
