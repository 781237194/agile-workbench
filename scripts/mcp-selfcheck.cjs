#!/usr/bin/env node
'use strict';
/**
 * e379 AC6：MCP 安全搜索自检 CLI（安装器/复验共用）
 *
 * 用法：
 *   node scripts/mcp-selfcheck.cjs [--repo <安装目录>] [--data <数据目录>] [--node <node/electron>]
 *                                  [--timeout 5000] [--json] [--strict] [--quiet] [--no-persist]
 *
 * 行为：
 *   1) 按 `dsh-plugin/cordis.patch.yml` 的 mcp-web-search-safe 行（command/args/env）真实拉一次 initialize；
 *   2) 失败写 `~/.dsh/logs/mcp-<ts>.log`（command/args/errno/stderr 前 500 字）并落 `<data>/mcp-selfcheck.json`；
 *   3) 把 warning 合并进 `<data>/install-result.json → warnings[]`（安装器在安装期直接引用这里的结果）；
 *   4) 默认 **exit 0**（失败不阻断安装/启动），只有 `--strict` 才以非 0 退出。
 *
 * 夹具可复现「PATH 无 node」：`--node node` + 清空 PATH → errno=ENOENT；或 `--node <不存在的路径>`。
 * 日志目录可用 `DSH_HOME` 指向沙盘（夹具必设，避免污染真实 ~/.dsh/logs）。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const mod = require(path.join(ROOT, 'src', 'mcp-selfcheck.js'));

function argOf(argv, name, fallback) {
  const i = argv.indexOf(name);
  if (i >= 0 && i + 1 < argv.length) return argv[i + 1];
  return fallback;
}
function flagOf(argv, name) {
  return argv.includes(name);
}

(async () => {
  const argv = process.argv.slice(2);
  const repoRoot = path.resolve(argOf(argv, '--repo', ROOT));
  const dataDir = path.resolve(argOf(argv, '--data', path.join(repoRoot, 'data')));
  const nodePath = argOf(argv, '--node', '');
  const timeoutMs = Number(argOf(argv, '--timeout', '0')) || undefined;
  const persist = !flagOf(argv, '--no-persist');
  const asJson = flagOf(argv, '--json');
  const quiet = flagOf(argv, '--quiet');
  const strict = flagOf(argv, '--strict');

  const record = await mod.runMcpSelfCheck({
    repoRoot,
    dataDir,
    nodePath: nodePath || undefined,
    timeoutMs,
    persist
  });

  if (record.warning && persist) {
    mod.mergeInstallWarnings(dataDir, [{
      ...record.warning,
      detail: { ...record.warning.detail, source: 'mcp-selfcheck-cli' }
    }]);
  }

  const line = record.ok
    ? 'MCP 自检：正常（initialize 成功，' + record.elapsedMs + 'ms）'
    : 'MCP 自检：失败（' + String(record.reason) + (record.errno ? ' / ' + record.errno : '') + '）'
      + (record.logPath ? '；日志 ' + record.logPath : '')
      + '；已记 warning（不阻断）';

  if (!quiet) console.log(line);
  if (asJson) {
    console.log(JSON.stringify({
      ok: record.ok,
      at: record.at,
      reason: record.reason,
      errno: record.errno,
      exitCode: record.exitCode,
      command: record.command,
      args: record.args,
      logPath: record.logPath,
      file: mod.selfCheckPath(dataDir),
      warning: record.warning
    }));
  }
  if (strict && !record.ok) process.exitCode = 1;
})().catch((error) => {
  console.error('MCP_SELFCHECK_FAILED ' + String((error && error.message) || error).slice(0, 300));
  if (fs.existsSync(path.join(ROOT, 'src', 'mcp-selfcheck.js'))) process.exitCode = process.argv.includes('--strict') ? 2 : 0;
});
