'use strict';
/**
 * e379 AC6：MCP 安全搜索行（cordis.patch.yml 的 mcp-web-search-safe）自检 + 可读告警
 *
 * 背景：DSH 的 mcp-client 行启动失败时只回 `server is disconnected`，没有 stderr、没有 warning，
 * 用户只能看到「搜索不可用」。这里用**与 patch 行同一套 command/args/env** 真实拉一次 MCP 握手
 * （initialize → result/error），拿到 errno / 退出码 / stderr 前 500 字，落可读日志：
 *
 *   ~/.dsh/logs/mcp-<ts>.log        人读明细（command/args/errno/stderr 摘要）
 *   <data>/mcp-selfcheck.json       机器读结果（面板/复验用）
 *
 * 失败**不阻断**安装与启动，只把一条 warning 给到安装结果（data/install-result.json）与设置页。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');

const SELFCHECK_FILE = 'mcp-selfcheck.json';
const INSTALL_RESULT_FILE = 'install-result.json';
const DEFAULT_SCRIPT_REL = path.join('dsh-plugin', 'mcp', 'web-search-safe.js');
const DEFAULT_TIMEOUT_MS = 5000;
const STDERR_CHARS = 500;

function dshHomeDir(env = process.env) {
  const home = String(env.DSH_HOME || '').trim();
  if (home) return home;
  return path.join(os.homedir(), '.dsh');
}

function mcpLogsDir(env = process.env) {
  return path.join(dshHomeDir(env), 'logs');
}

function stampForFile(date) {
  const d = date instanceof Date ? date : new Date();
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}${p(d.getSeconds())}`;
}

/**
 * 与 dsh-plugin/cordis.patch.yml 的 mcp-web-search-safe 行保持同源：
 *   command = $DSH_WEB_SEARCH_SAFE_NODE || process.execPath
 *   args    = [$DSH_WEB_SEARCH_SAFE_SCRIPT || <仓库>/dsh-plugin/mcp/web-search-safe.js]
 *   env     = { ELECTRON_RUN_AS_NODE: 1 }
 */
function buildSelfCheckPlan(options = {}) {
  const repoRoot = String(options.repoRoot || path.resolve(__dirname, '..'));
  const env = options.env || process.env;
  const command = String(options.nodePath || env.DSH_WEB_SEARCH_SAFE_NODE || process.execPath || 'node');
  const script = String(
    options.scriptPath || env.DSH_WEB_SEARCH_SAFE_SCRIPT || path.join(repoRoot, DEFAULT_SCRIPT_REL)
  );
  return {
    command,
    args: [script],
    script,
    cwd: repoRoot,
    env: { ...env, ELECTRON_RUN_AS_NODE: '1' }
  };
}

function initializeFrame() {
  return JSON.stringify({
    jsonrpc: '2.0',
    id: 1,
    method: 'initialize',
    params: {
      protocolVersion: '2024-11-05',
      capabilities: {},
      clientInfo: { name: 'pm-workbench-mcp-selfcheck', version: '1' }
    }
  }) + '\n';
}

function writeLog(env, payload) {
  const dir = mcpLogsDir(env);
  const file = path.join(dir, 'mcp-' + stampForFile(new Date()) + '.log');
  try {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(file, payload, 'utf8');
    return file;
  } catch {
    return '';
  }
}

function logBody(record) {
  const lines = [
    '# MCP 安全搜索自检失败（web-search-safe）',
    'at: ' + record.at,
    'reason: ' + String(record.reason || ''),
    'command: ' + String(record.command || ''),
    'args: ' + JSON.stringify(record.args || []),
    'cwd: ' + String(record.cwd || ''),
    'script: ' + String(record.script || ''),
    'errno: ' + String(record.errno || '—'),
    'exitCode: ' + (record.exitCode === null || typeof record.exitCode === 'undefined' ? '—' : String(record.exitCode)),
    'elapsedMs: ' + String(record.elapsedMs || 0),
    '',
    'stderr（前 ' + STDERR_CHARS + ' 字）:',
    String(record.stderr || '（空）'),
    '',
    'stdout（前 ' + STDERR_CHARS + ' 字）:',
    String(record.stdout || '（空）'),
    '',
    'next: 安装器/工作台已把这条写进 data/install-result.json 的 warnings[]；',
    '      界面：更多菜单 → 关于 PM工作台 → 安装 / MCP 警告。',
    ''
  ];
  return lines.join('\n');
}

/** 把一条（或多条）warning 合并进 data/install-result.json（不存在就创建，按 code+at 去重）。 */
function mergeInstallWarnings(dataDir, warnings) {
  if (!dataDir) return { ok: false, code: 'NO_DATA_DIR' };
  const list = (Array.isArray(warnings) ? warnings : [warnings]).filter(Boolean);
  const target = path.join(String(dataDir), INSTALL_RESULT_FILE);
  let current = null;
  try {
    current = JSON.parse(fs.readFileSync(target, 'utf8'));
  } catch {
    current = null;
  }
  const base = current && typeof current === 'object' && !Array.isArray(current) ? current : {};
  const merged = Array.isArray(base.warnings) ? base.warnings.slice() : [];
  const seen = new Set(merged.map((item) => String((item && item.code) || '') + '@' + String((item && item.at) || '')));
  for (const warn of list) {
    const row = {
      code: String(warn.code || 'WARNING'),
      message: String(warn.message || '').slice(0, 400),
      at: String(warn.at || new Date().toISOString()),
      ...(warn.log ? { log: String(warn.log) } : {}),
      ...(warn.detail ? { detail: warn.detail } : {})
    };
    const key = row.code + '@' + row.at;
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(row);
  }
  // 只保留最近 50 条，避免无限增长。
  const trimmed = merged.slice(-50);
  const next = { ...base, warnings: trimmed, warningsUpdatedAt: new Date().toISOString() };
  if (!Array.isArray(base.warnings)) next.source = base.source || 'workbench';
  try {
    fs.mkdirSync(String(dataDir), { recursive: true });
    const tmp = target + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(next, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, target);
    return { ok: true, file: target, warnings: trimmed };
  } catch (error) {
    return { ok: false, code: 'INSTALL_RESULT_WRITE_FAILED', message: String((error && error.message) || error).slice(0, 200) };
  }
}

function readInstallResult(dataDir) {
  if (!dataDir) return null;
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(String(dataDir), INSTALL_RESULT_FILE), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

function selfCheckPath(dataDir) {
  return path.join(String(dataDir || ''), SELFCHECK_FILE);
}

function writeSelfCheck(dataDir, record) {
  if (!dataDir) return false;
  const target = selfCheckPath(dataDir);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

function readSelfCheck(dataDir) {
  try {
    const parsed = JSON.parse(fs.readFileSync(selfCheckPath(dataDir), 'utf8'));
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 真实拉起 MCP server 做一次 initialize 握手。永不抛错：失败也返回完整记录（含可读日志路径）。
 * @param {{repoRoot?:string,dataDir?:string,env?:object,nodePath?:string,scriptPath?:string,timeoutMs?:number,persist?:boolean,logsDir?:string}} options
 */
async function runMcpSelfCheck(options = {}) {
  const started = Date.now();
  const env = options.env || process.env;
  const plan = buildSelfCheckPlan(options);
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DEFAULT_TIMEOUT_MS;
  const record = {
    ok: false,
    at: new Date().toISOString(),
    reason: '',
    command: plan.command,
    args: plan.args,
    cwd: plan.cwd,
    script: plan.script,
    errno: '',
    exitCode: null,
    signal: '',
    stdout: '',
    stderr: '',
    elapsedMs: 0,
    logPath: '',
    warning: null
  };

  if (!fs.existsSync(plan.script)) {
    record.reason = 'SCRIPT_MISSING';
    record.errno = 'ENOENT';
    record.stderr = 'MCP 脚本不存在：' + plan.script;
  } else {
    await new Promise((resolve) => {
      let settled = false;
      let child = null;
      let stdout = '';
      let stderr = '';
      const finish = (patch) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        Object.assign(record, patch);
        try { if (child && !child.killed) child.kill(); } catch { /* ignore */ }
        resolve();
      };
      const timer = setTimeout(() => finish({ reason: 'TIMEOUT' }), timeoutMs);
      try {
        child = spawn(plan.command, plan.args, { cwd: plan.cwd, env: plan.env, stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
      } catch (error) {
        finish({ reason: 'SPAWN_ERROR', errno: String((error && error.code) || 'SPAWN_FAILED'), stderr: String((error && error.message) || error) });
        return;
      }
      child.on('error', (error) => finish({
        reason: 'SPAWN_ERROR',
        errno: String((error && error.code) || 'SPAWN_FAILED'),
        stderr: String((error && error.message) || error)
      }));
      child.on('close', (code, signal) => finish({
        reason: 'EXITED',
        exitCode: typeof code === 'number' ? code : null,
        signal: String(signal || '')
      }));
      child.stdout.on('data', (chunk) => {
        stdout += String(chunk);
        if (/"result"\s*:/.test(stdout)) finish({ ok: true });
        else if (/"error"\s*:/.test(stdout)) finish({ reason: 'MCP_ERROR_RESPONSE' });
      });
      child.stderr.on('data', (chunk) => { stderr += String(chunk); });
      try {
        child.stdin.write(initializeFrame());
      } catch (error) {
        finish({ reason: 'STDIN_WRITE_FAILED', stderr: String((error && error.message) || error) });
      }
    });
  }

  record.elapsedMs = Date.now() - started;
  record.stdout = String(record.stdout || '').slice(0, STDERR_CHARS);
  record.stderr = String(record.stderr || '').slice(0, STDERR_CHARS);
  if (!record.ok) {
    const reasonText = {
      SPAWN_ERROR: '启动失败（' + (record.errno || 'SPAWN_FAILED') + '）',
      EXITED: '进程提前退出（退出码 ' + String(record.exitCode) + '）',
      TIMEOUT: timeoutMs + 'ms 内没有响应 initialize',
      MCP_ERROR_RESPONSE: 'MCP 返回 error（initialize 失败）',
      SCRIPT_MISSING: '脚本缺失',
      STDIN_WRITE_FAILED: '无法写入 stdin'
    }[record.reason] || String(record.reason || '未知原因');
    record.logPath = writeLog(env, logBody(record));
    const stderrHint = record.stderr ? '；stderr：' + record.stderr.replace(/\s+/g, ' ').slice(0, 120) : '';
    record.warning = {
      code: record.reason === 'SPAWN_ERROR' ? 'MCP_START_FAILED' : 'MCP_UNREADABLE',
      message: 'MCP 安全搜索（web-search-safe）' + reasonText + stderrHint
        + (record.logPath ? '；详情见 ' + record.logPath : ''),
      at: record.at,
      log: record.logPath,
      detail: {
        command: record.command,
        args: record.args,
        errno: record.errno,
        exitCode: record.exitCode,
        reason: record.reason
      }
    };
  }
  if (options.persist !== false) writeSelfCheck(options.dataDir, record);
  return record;
}

module.exports = {
  SELFCHECK_FILE,
  INSTALL_RESULT_FILE,
  DEFAULT_SCRIPT_REL,
  DEFAULT_TIMEOUT_MS,
  STDERR_CHARS,
  dshHomeDir,
  mcpLogsDir,
  buildSelfCheckPlan,
  initializeFrame,
  runMcpSelfCheck,
  mergeInstallWarnings,
  readInstallResult,
  selfCheckPath,
  writeSelfCheck,
  readSelfCheck
};
