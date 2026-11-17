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
  if (options.keep !== true && !keepByEnv) {
    process.on('exit', () => { rmSandbox(dir); });
  }
  return dir;
}

/**
 * B-07b6 A 阶段：统一清理助手（rmSync 重试 + 退避）。
 *
 * Windows 删除目录时，目录内文件可能仍被刚退出的子进程/杀毒/索引服务持有 →
 * `rmdir` 返回 EPERM/ENOTEMPTY，`fs.rmSync` 默认只试一次就抛，脚本随即失败；
 * 而固定沙盘 `_tmp/<名字>` 一旦残留，下一个人再跑必失败（已三次挡住复核）。
 *
 * 用法：把 `fs.rmSync(SB, { recursive: true, force: true })`
 *       换成 `rmSandbox(SB)`（等价语义 + 10 次重试/150ms 退避）；
 *       需要额外选项时传第二参（会与默认重试参数合并，显式值优先）。
 */
function rmSandbox(target, opts) {
  const options = {
    recursive: true,
    force: true,
    maxRetries: 10,
    retryDelay: 150,
    ...(opts && typeof opts === 'object' ? opts : {}),
  };
  try {
    fs.rmSync(target, options);
    return true;
  } catch (error) {
    // 清理失败不改变测试结论：调用方若真要断言「删干净了」，自己再 stat 一次。
    if (options.throwOnFail) throw error;
    return false;
  }
}

/**
 * B-07b6 B 阶段：给「固定沙盘目录」脚本一个唯一目录（并发安全，不改报告件路径）。
 *
 * 背景：B1 名单里 16 个脚本把沙盘写死在 `_tmp/<名字>`（或 项目/…/_tmp/<名字>），
 * 多个角色同时跑会互相 rm/重建 → EPERM/ENOTEMPTY。mkTempSandbox 用的是 mkdtemp 后缀，
 * 路径不可预测、不便对照；uniqueSandbox 用「<名字>-<pid>-<时间戳36进制>」，可读且唯一。
 *
 * 用法：把 `const SB = path.join(ROOT, '_tmp', 'x')` 换成 `const SB = uniqueSandbox('x')`；
 *       项目内沙盘传 { root: path.join(REPO, '项目', '<项目名>') }。
 *       opts.keep=true 保留目录（排障用）；opts.prefix 覆盖默认名字。
 */
function uniqueSandbox(name, opts) {
  const options = opts && typeof opts === 'object' ? opts : {};
  const root = options.root ? path.resolve(String(options.root)) : REPO_ROOT;
  const base = path.join(root, '_tmp');
  fs.mkdirSync(base, { recursive: true });
  const prefix = String(options.prefix || name || 'sandbox').replace(/[^\w.-]+/g, '-').replace(/^-+|-+$/g, '') || 'sandbox';
  const stem = `${prefix}-${process.pid}-${Date.now().toString(36)}`;
  let dir = path.join(base, stem);
  let n = 1;
  while (fs.existsSync(dir)) { dir = path.join(base, `${stem}-${n}`); n += 1; }
  fs.mkdirSync(dir, { recursive: true });
  if (process.env.TEAM_SB_PROBE === '1') console.log('[sb] ' + dir); // 并发排障：打印本次唯一沙盘
  const keepByEnv = process.env.TEAM_SB_KEEP === '1'; // 取证：保留沙盘（跑完需自行清理）
  if (options.keep !== true) {
    process.on('exit', () => { rmSandbox(dir); });
  }
  return dir;
}

module.exports = { mkTempSandbox, rmSandbox, uniqueSandbox, REPO_ROOT };
