'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFile } = require('node:child_process');

/**
 * DSH 外部会话引擎适配层。
 *
 * 本文件只实现公开的 HTTP 调用协议，不包含 DSH 或任何旧工作台的源码。
 * 认证材料从本机 DSH 配置读取；绝不写入项目文件、日志或界面。
 */
function b64url(input) {
  return Buffer.from(input).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function readBrowserSecret() {
  const file = path.join(dshHome(), '.credentials.yaml');
  if (!fs.existsSync(file)) throw new Error('找不到 DSH 凭据：' + file);
  const text = fs.readFileSync(file, 'utf8');
  const found = /client-connection\/browser-session[\s\S]{0,300}?secret:\s*([A-Za-z0-9_-]{43})/.exec(text);
  if (!found) throw new Error('找不到 DSH browser-session secret');
  return found[1];
}

function makeCookie(authority, secret) {
  const name = 'dsh-auth-' + b64url(crypto.createHash('sha256').update(authority).digest());
  const now = Date.now();
  const payload = b64url(JSON.stringify({
    version: 1,
    authority,
    issuedAt: now,
    expiresAt: now + 30 * 86400000
  }));
  const key = Buffer.from(secret.replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const sig = b64url(crypto.createHmac('sha256', key).update(payload).digest());
  return { name, value: 'v1.' + payload + '.' + sig };
}

class DshAdapter {
  constructor(baseUrl) {
    this.baseUrl = String(baseUrl || '').replace(/\/+$/, '');
    this.last = {
      configured: Boolean(this.baseUrl),
      online: false,
      checkedAt: null,
      message: this.baseUrl ? '未探测' : '未配置',
      sessions: 0
    };
  }

  statusSync() {
    return { ...this.last, baseUrl: this.baseUrl };
  }

  webCookie() {
    const ctx = this.context();
    return { url: this.baseUrl, name: ctx.cookie.name, value: ctx.cookie.value };
  }

  context() {
    if (!this.baseUrl) {
      const error = new Error('未配置 DSH 地址');
      error.code = 'DSH_NOT_CONFIGURED';
      throw error;
    }
    const url = new URL(this.baseUrl);
    let secret;
    try {
      secret = readBrowserSecret();
    } catch (e) {
      const error = new Error(String(e && e.message || e));
      error.code = 'DSH_AUTH_MISSING';
      throw error;
    }
    return {
      origin: url.origin,
      authority: url.host,
      cookie: makeCookie(url.host, secret)
    };
  }

  async rpc(method, args = {}, options = {}) {
    const timeoutMs = Number(options && options.timeoutMs) > 0 ? Number(options.timeoutMs) : 10000;
    const rpcId = crypto.randomUUID();
    const body = JSON.stringify({
      type: 'client-request',
      rpcId,
      method,
      payload: { args }
    });
    // 每次请求都重新读凭据；401/403 时再铸造一次 cookie 重试一次（DSH 重启/secret 轮换）。
    const send = async () => {
      const { origin, cookie } = this.context();
      let response;
      try {
        response = await fetch(origin + '/api/' + method, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            cookie: cookie.name + '=' + cookie.value
          },
          body,
          signal: AbortSignal.timeout(timeoutMs)
        });
      } catch (cause) {
        const timeout = Boolean(cause && (cause.name === 'TimeoutError' || cause.name === 'AbortError' || cause.code === 'ABORT_ERR'));
        const error = new Error((timeout ? 'DSH 请求超时：' : 'DSH 连接失败：') + String(cause && cause.message || cause).slice(0, 160));
        error.code = timeout ? 'DSH_TIMEOUT' : 'DSH_OFFLINE';
        error.cause = cause;
        throw error;
      }
      let text;
      try {
        text = await response.text();
      } catch (cause) {
        const error = new Error('DSH 响应读取失败：' + String(cause && cause.message || cause).slice(0, 160));
        error.code = 'DSH_OFFLINE';
        error.cause = cause;
        throw error;
      }
      return { response, text };
    };
    let attempt = await send();
    if (attempt.response.status === 401 || attempt.response.status === 403) {
      try {
        attempt = await send();
      } catch { /* 第二次失败沿用第一次的 HTTP 错误码，便于区分凭据与网络 */ }
    }
    const { response, text } = attempt;
    if (!response.ok) {
      const error = new Error('DSH HTTP ' + response.status + ': ' + text.slice(0, 200));
      if (response.status === 401 || response.status === 403) error.code = 'DSH_AUTH_REJECTED';
      else error.code = 'DSH_HTTP_' + response.status;
      throw error;
    }
    let data;
    try { data = JSON.parse(text); } catch {
      const error = new Error('DSH 返回非 JSON');
      error.code = 'DSH_PROTOCOL';
      throw error;
    }
    if (data.type !== 'server-response' || data.rpcId !== rpcId) {
      const error = new Error('DSH 响应信封不匹配');
      error.code = 'DSH_PROTOCOL';
      throw error;
    }
    if (!data.result || data.result.ok !== true) {
      const err = data.result && data.result.error ? data.result.error : data.result;
      const error = new Error('DSH RPC ' + method + ' 失败：' + (err && err.message ? err.message : JSON.stringify(err)));
      error.code = 'DSH_RPC';
      throw error;
    }
    return data.result.value;
  }

  async check(options = {}) {
    if (!this.baseUrl) {
      this.last = { configured: false, online: false, checkedAt: new Date().toISOString(), message: '未配置 DSH 地址', sessions: 0 };
      return this.statusSync();
    }
    const timeoutMs = Number(options && options.timeoutMs) > 0 ? Number(options.timeoutMs) : 8000;
    try {
      const value = await this.rpc('session/list', { _request: {} }, { timeoutMs });
      const items = Array.isArray(value?.items) ? value.items : [];
      this.last = {
        configured: true,
        online: true,
        checkedAt: new Date().toISOString(),
        message: '已连接 DSH · ' + items.length + ' 个会话',
        code: 'OK',
        sessions: items.length
      };
    } catch (e) {
      this.last = {
        configured: true,
        online: false,
        checkedAt: new Date().toISOString(),
        message: String(e.message || e).slice(0, 180),
        code: String(e && e.code || 'DSH_OFFLINE'),
        sessions: 0
      };
    }
    return this.statusSync();
  }

  async listSessions(options = {}) {
    const timeoutMs = Number(options && options.timeoutMs) > 0 ? Number(options.timeoutMs) : 10000;
    const value = await this.rpc('session/list', { _request: {} }, { timeoutMs });
    return Array.isArray(value?.items) ? value.items : [];
  }

  async createWorkspace(projectPath) {
    return this.ensureWorkspace(projectPath);
  }

  /**
   * 绑定/创建 DSH 工作区：workspace/create 按目录幂等。
   * 返回稳定的 {workspaceId, sessionIds, created}，并把 DSH 原始错误码原样抛出
   * （DSH_OFFLINE / DSH_TIMEOUT / DSH_RPC / DSH_PROTOCOL），由调用方决定是否降级。
   */
  async ensureWorkspace(projectPath, options = {}) {
    const target = String(projectPath || '').trim();
    if (!target) {
      const error = new Error('DSH 工作区需要项目目录');
      error.code = 'PROJECT_PATH_REQUIRED';
      throw error;
    }
    const timeoutMs = Number(options && options.timeoutMs) > 0 ? Number(options.timeoutMs) : 10000;
    const value = await this.rpc('workspace/create', { request: { path: target } }, { timeoutMs });
    const workspace = value && (value.workspace || value);
    const workspaceId = workspace && (workspace.workspaceId || workspace.id);
    if (!workspaceId) {
      const error = new Error('DSH 没有返回 workspaceId');
      error.code = 'DSH_PROTOCOL';
      throw error;
    }
    return {
      workspaceId: String(workspaceId),
      sessionIds: Array.isArray(workspace && workspace.sessionIds) ? workspace.sessionIds.map(String) : [],
      created: Boolean(value && value.created),
      path: target
    };
  }

  async createSession({ cwd, title, workspaceId } = {}) {
    if (!cwd && !workspaceId) throw new Error('DSH 会话需要 cwd 或 workspaceId');
    if (cwd && workspaceId) throw new Error('DSH 会话只能传 cwd 或 workspaceId 之一');
    const value = await this.rpc('session/create', {
      request: workspaceId ? { workspaceId } : { cwd }
    });
    const sessionId = value && (value.sessionId || value.id);
    if (!sessionId) throw new Error('DSH 没有返回 sessionId');
    if (title) {
      try { await this.rpc('session/rename', { request: { sessionId, title } }); } catch { /* title optional */ }
    }
    return { ...value, sessionId };
  }

  async prompt(sessionId, text) {
    return this.rpc('session/prompt', {
      request: {
        sessionId,
        content: [{ type: 'text', text }],
        mode: 'queue',
        requestId: crypto.randomUUID()
      }
    });
  }

  async rename(sessionId, title) {
    return this.rpc('session/rename', { request: { sessionId, title } });
  }

  async archiveSession(sessionId) {
    return this.rpc('workspace/archiveSession', {
      // 删除项目/会话时必须先停活动，避免归档后 agent 继续写项目目录。
      request: { sessionId, stopActivity: true }
    });
  }
}

/* ── DSH Web 端口自动发现 ───────────────────────────────────────────────
 * DSH Desktop 用 `--port 0` 让系统分配端口，端口不会写进磁盘配置，只会通过
 * Electron IPC 报给桌面壳。工作台必须自己从「DSH 进程 → 监听端口」反推，
 * 再用 HTTP 401/DSH 特征确认；配置/环境变量只是提示，最后才做有界的小范围探测。
 * 绝不扫全端口，也不把任意 localhost HTTP 服务当成 DSH。
 */

const DSH_WEB_DEFAULT_PORT = 52711;
const DSH_DISCOVERY_MAX_CANDIDATES = 20;
const DSH_DISCOVERY_MAX_WAVE1 = 16;
const DSH_DISCOVERY_PROBE_CONCURRENCY = 6;

function normalizeLocalBaseUrl(raw) {
  let text = String(raw == null ? '' : raw).trim();
  if (!text) return '';
  if (!/^https?:\/\//i.test(text)) {
    if (/^\[[0-9a-f:.]+\]:\d+(?:\/|$)/i.test(text) || /^[a-z0-9.-]+:\d+(?:\/|$)/i.test(text)) text = 'http://' + text;
    else return '';
  }
  let url;
  try { url = new URL(text); } catch { return ''; }
  if (!['http:', 'https:'].includes(url.protocol)) return '';
  let host = String(url.hostname || '').toLowerCase();
  if (host === 'localhost' || host === '0.0.0.0') host = '127.0.0.1';
  if (host === '::' || host === '[::]' || host === '::1') host = '[::1]';
  if (host !== '127.0.0.1' && host !== '[::1]') return '';
  const port = Number(url.port);
  if (!Number.isInteger(port) || port < 1 || port > 65535) return '';
  return `${url.protocol}//${host}:${port}`;
}

function isLoopbackBaseUrl(raw) {
  return Boolean(normalizeLocalBaseUrl(raw));
}

function dshResponseSignature(status, body) {
  const text = String(body || '');
  if (/dsh web authentication required/i.test(text)) return 'dsh-web-auth';
  if (/<title[^>]*>\s*deepseek\s+harness\b/i.test(text)) return 'dsh-title';
  if (/\bname=["']dsh-(?:app|web)["']/i.test(text)) return 'dsh-meta';
  if (status === 401 && /\bdsh\b/i.test(text)) return 'dsh-401';
  return '';
}

/**
 * 只探测一个本机地址的 `/`：401 + DSH 特征、或 200 + DSH 页面特征才算成功。
 * 404/空响应/普通 HTTP 服务（例如 63607 的 ego-cast worker）都会被拒绝。
 */
async function probeDshWeb(rawUrl, options = {}) {
  const started = Date.now();
  const baseUrl = normalizeLocalBaseUrl(rawUrl);
  if (!baseUrl) {
    return {
      ok: false,
      code: 'DSH_PROBE_NON_LOCAL',
      baseUrl: '',
      elapsedMs: Date.now() - started,
      message: '不是本机 http(s) 地址：' + String(rawUrl || '').slice(0, 120)
    };
  }
  const timeoutMs = Number(options && options.timeoutMs) > 0 ? Number(options.timeoutMs) : 1200;
  let response;
  let text;
  try {
    response = await fetch(baseUrl + '/', {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'text/html,application/json;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    text = await response.text();
  } catch (cause) {
    const timeout = Boolean(cause && (cause.name === 'TimeoutError' || cause.name === 'AbortError' || cause.code === 'ABORT_ERR'));
    return {
      ok: false,
      code: timeout ? 'DSH_PROBE_TIMEOUT' : 'DSH_PROBE_OFFLINE',
      baseUrl,
      elapsedMs: Date.now() - started,
      message: (timeout ? '探测超时：' : '连接失败：') + String(cause && (cause.cause && cause.cause.message || cause.message) || cause).slice(0, 160)
    };
  }
  const body = String(text || '').slice(0, 8192);
  const signature = dshResponseSignature(response.status, body);
  const acceptedStatus = response.status === 200 || response.status === 401 || response.status === 403;
  const ok = Boolean(signature) && acceptedStatus;
  return {
    ok,
    code: ok ? 'DSH_PROBE_OK' : 'DSH_PROBE_NOT_DSH',
    baseUrl,
    status: response.status,
    signature,
    acceptedStatus,
    elapsedMs: Date.now() - started,
    bodyPreview: body.replace(/\s+/g, ' ').trim().slice(0, 120),
    message: ok
      ? 'DSH 特征匹配（HTTP ' + response.status + '，' + signature + '）'
      : '不是 DSH（HTTP ' + response.status + '，' + (signature || '无 DSH 特征') + '）'
  };
}

function runCommand(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(file, args, {
      windowsHide: true,
      timeout: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 6000,
      maxBuffer: Number(options.maxBuffer) > 0 ? Number(options.maxBuffer) : 8 * 1024 * 1024,
      encoding: 'utf8'
    }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: String(stdout == null ? '' : stdout),
        stderr: String(stderr == null ? '' : stderr),
        error: error ? String(error.message || error) : ''
      });
    });
  });
}

function windowsSystemPath(relative) {
  const root = process.env.SystemRoot || process.env.windir || 'C:\\Windows';
  return path.join(root, relative);
}

/**
 * netstat 只取本机监听，返回 PID，不读取连接内容。
 * 只接受 127.0.0.1 / 0.0.0.0 / :: / ::1 绑定，其他网卡地址一律忽略。
 */
async function listWindowsListeners(options = {}) {
  if (process.platform !== 'win32') {
    return { ok: false, code: 'DSH_PLATFORM_UNSUPPORTED', listeners: [], error: '当前平台不支持读取监听端口' };
  }
  const netstat = windowsSystemPath(path.join('System32', 'netstat.exe'));
  const result = await runCommand(netstat, ['-ano', '-p', 'TCP'], {
    timeoutMs: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 5000
  });
  if (!result.ok) {
    return { ok: false, code: 'DSH_NETSTAT_FAILED', listeners: [], error: result.error || 'netstat 执行失败' };
  }
  const byPort = new Map();
  const lines = result.stdout.split(/\r?\n/);
  for (const line of lines) {
    const match = /^\s*TCP\s+(\S+):(\d+)\s+\S+\s+(\S+)\s+(\d+)\s*$/i.exec(line);
    if (!match) continue;
    if (!/LISTEN/i.test(match[3])) continue;
    let address = String(match[1] || '').trim();
    if (address.startsWith('[') && address.endsWith(']')) address = address.slice(1, -1);
    if (address === '') continue;
    if (!['127.0.0.1', '0.0.0.0', '::', '::1'].includes(address)) continue;
    const port = Number(match[2]);
    const pid = Number(match[4]);
    if (!Number.isInteger(port) || port < 1 || port > 65535) continue;
    if (!Number.isInteger(pid) || pid < 1) continue;
    const ipv6 = address === '::' || address === '::1';
    const baseUrl = ipv6 ? 'http://[::1]:' + port : 'http://127.0.0.1:' + port;
    const entry = { port, pid, address, baseUrl };
    const previous = byPort.get(port);
    // 同一端口双栈监听时优先 127.0.0.1；无法确认时保留先看到的。
    if (!previous || (address === '127.0.0.1' && previous.address !== '127.0.0.1') || (address === '::1' && previous.address === '::')) {
      byPort.set(port, entry);
    }
  }
  return { ok: true, code: 'OK', listeners: Array.from(byPort.values()) };
}

function parseWmicProcessList(text) {
  const processes = [];
  const blocks = String(text || '').replace(/\r/g, '').split(/\n\s*\n+/);
  for (const block of blocks) {
    const record = {};
    for (const line of block.split('\n')) {
      const match = /^([A-Za-z]+)=(.*)$/.exec(line);
      if (match) record[match[1]] = match[2];
    }
    const pid = Number(record.ProcessId);
    if (!Number.isInteger(pid) || pid < 1) continue;
    processes.push({
      pid,
      ppid: Number(record.ParentProcessId) || 0,
      name: String(record.Name || ''),
      commandLine: String(record.CommandLine || ''),
      createdAt: String(record.CreationDate || '')
    });
  }
  return processes;
}

async function listWindowsProcessesViaPowershell(options = {}) {
  const powershell = windowsSystemPath(path.join('WindowsPowerShell', 'v1.0', 'powershell.exe'));
  const script = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    "$ErrorActionPreference='SilentlyContinue'",
    '$procs = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate)',
    'ConvertTo-Json -InputObject @($procs) -Depth 4 -Compress'
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  const result = await runCommand(powershell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-EncodedCommand', encoded
  ], {
    timeoutMs: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 8000,
    maxBuffer: 16 * 1024 * 1024
  });
  if (!result.ok) {
    return { ok: false, code: 'DSH_PROCESS_QUERY_FAILED', processes: [], error: result.error || 'PowerShell 进程查询失败' };
  }
  const text = result.stdout.trim();
  let parsed;
  try {
    parsed = JSON.parse(text);
  } catch {
    const arrayStart = text.indexOf('[');
    const arrayEnd = text.lastIndexOf(']');
    const objectStart = text.indexOf('{');
    const objectEnd = text.lastIndexOf('}');
    try {
      if (arrayStart >= 0 && arrayEnd > arrayStart) parsed = JSON.parse(text.slice(arrayStart, arrayEnd + 1));
      else if (objectStart >= 0 && objectEnd > objectStart) parsed = JSON.parse(text.slice(objectStart, objectEnd + 1));
    } catch { parsed = null; }
  }
  if (!parsed) return { ok: false, code: 'DSH_PROCESS_QUERY_FAILED', processes: [], error: '进程查询返回非 JSON' };
  const rows = Array.isArray(parsed) ? parsed : [parsed];
  const processes = rows.map((row) => ({
    pid: Number(row && row.ProcessId),
    ppid: Number(row && row.ParentProcessId) || 0,
    name: String(row && row.Name || ''),
    commandLine: String(row && row.CommandLine || ''),
    createdAt: String(row && row.CreationDate || '')
  })).filter((row) => Number.isInteger(row.pid) && row.pid > 0);
  return { ok: true, code: 'OK', processes, method: 'powershell' };
}

async function listWindowsProcesses(options = {}) {
  if (process.platform !== 'win32') {
    return { ok: false, code: 'DSH_PLATFORM_UNSUPPORTED', processes: [], error: '当前平台不支持读取进程' };
  }
  const wmic = windowsSystemPath(path.join('System32', 'wbem', 'wmic.exe'));
  const result = await runCommand(wmic, [
    'process', 'get', 'ProcessId,ParentProcessId,Name,CommandLine,CreationDate', '/format:list'
  ], {
    timeoutMs: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 5000,
    maxBuffer: 16 * 1024 * 1024
  });
  if (result.ok) {
    const processes = parseWmicProcessList(result.stdout);
    if (processes.length) return { ok: true, code: 'OK', processes, method: 'wmic' };
  }
  const fallback = await listWindowsProcessesViaPowershell(options);
  if (fallback.ok) return { ...fallback, wmicError: result.error || '' };
  return {
    ok: false,
    code: 'DSH_PROCESS_QUERY_FAILED',
    processes: [],
    error: (result.error ? 'wmic: ' + result.error + '；' : '') + (fallback.error || '进程查询失败')
  };
}

function isDshHelperProcess(commandLine) {
  const cmd = String(commandLine || '');
  if (/--type=(?:gpu-process|renderer|utility|zygote|crashpad|ppapi)/i.test(cmd)) return true;
  if (/dsh-subprocess-local[\\/]+lib[\\/]+runner\.js/i.test(cmd)) return true;
  if (/ego-cast-worker|ptc-runtime-node|dsh-session-log-export/i.test(cmd)) return true;
  return false;
}

function isDshProcess(proc) {
  const name = String(proc && proc.name || '').trim();
  const cmd = String(proc && proc.commandLine || '');
  if (!name && !cmd) return false;
  if (isDshHelperProcess(cmd)) return false;
  const nameMatch = /^(?:deepseek[ -]?harness(?:\.exe)?|dsh(?:\.exe)?|dsh-web(?:\.exe)?)$/i.test(name);
  const cmdMatch = /dsh-desktop-host|[\\/]@deepseek-ai[\\/]dsh(?:[\\/]|\s|$)|[\\/]dsh[\\/](?:bin|lib)[\\/]|(?:^|[\\/ ])dsh(?:\.exe)?(?:\s|$)/i.test(cmd);
  return nameMatch || cmdMatch;
}

function extractPortsFromCommandLine(commandLine) {
  const ports = new Set();
  const text = String(commandLine || '');
  const add = (value) => {
    const port = Number(value);
    if (Number.isInteger(port) && port >= 1 && port <= 65535) ports.add(port);
  };
  for (const pattern of [
    /(?:^|\s)--(?:web-)?port(?:=|\s+)(\d{1,5})(?=\s|$)/gi,
    /(?:^|\s)-p(?:=|\s+)(\d{1,5})(?=\s|$)/gi,
    /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{1,5})/gi
  ]) {
    let match;
    while ((match = pattern.exec(text)) !== null) add(match[1]);
  }
  return Array.from(ports);
}

async function collectDshProcessInfo(options = {}) {
  if (process.platform !== 'win32') {
    return {
      ok: false,
      code: 'DSH_PLATFORM_UNSUPPORTED',
      method: '',
      processes: [],
      ports: [],
      argPorts: [],
      error: '当前平台不支持读取 DSH 进程/监听端口'
    };
  }
  const [listeners, processResult] = await Promise.all([
    listWindowsListeners(options),
    listWindowsProcesses(options)
  ]);
  const allProcesses = processResult.ok ? processResult.processes : [];
  const dshProcesses = allProcesses.filter(isDshProcess);
  dshProcesses.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  const pidOrder = new Map(dshProcesses.map((proc, index) => [proc.pid, index]));
  const pids = new Set(dshProcesses.map((proc) => proc.pid));
  const ports = (listeners.ok ? listeners.listeners : [])
    .filter((listener) => pids.has(listener.pid))
    .sort((a, b) => {
      const ai = pidOrder.has(a.pid) ? pidOrder.get(a.pid) : 9999;
      const bi = pidOrder.has(b.pid) ? pidOrder.get(b.pid) : 9999;
      return ai - bi || a.port - b.port;
    });
  const argPorts = [];
  const seenArgs = new Set();
  for (const proc of dshProcesses) {
    for (const port of extractPortsFromCommandLine(proc.commandLine)) {
      if (seenArgs.has(port)) continue;
      seenArgs.add(port);
      argPorts.push(port);
    }
  }
  const errors = [];
  if (!listeners.ok) errors.push(listeners.error || '监听端口读取失败');
  if (!processResult.ok) errors.push(processResult.error || '进程读取失败');
  return {
    ok: processResult.ok,
    code: errors.length ? 'DSH_PROCESS_PARTIAL' : 'OK',
    method: processResult.method || '',
    processes: dshProcesses.map((proc) => ({ pid: proc.pid, name: proc.name })),
    ports,
    argPorts,
    error: errors.join('；').slice(0, 240)
  };
}

function candidateSourceLabel(source) {
  const labels = {
    saved: '上次保存的地址',
    'env-url': '环境变量 DSH_WEB_URL',
    'env-port': '环境变量端口',
    'process-arg': 'DSH 进程参数',
    'process-port': 'DSH 进程监听端口',
    default: 'DSH 默认端口',
    range: '小范围探测'
  };
  return labels[source] || source;
}

function addCandidate(candidates, seen, rawUrl, source, priority, evidence) {
  const baseUrl = normalizeLocalBaseUrl(rawUrl);
  if (!baseUrl || seen.has(baseUrl)) return false;
  seen.add(baseUrl);
  let port = 0;
  try { port = Number(new URL(baseUrl).port) || 0; } catch { /* 已校验 */ }
  candidates.push({ baseUrl, port, source, priority, evidence: String(evidence || '') });
  return true;
}

async function probeCandidates(candidates, timeoutMs) {
  const results = new Array(candidates.length);
  let cursor = 0;
  const worker = async () => {
    while (cursor < candidates.length) {
      const index = cursor++;
      const candidate = candidates[index];
      const probe = await probeDshWeb(candidate.baseUrl, { timeoutMs });
      results[index] = { ...candidate, ...probe };
    }
  };
  const workers = Array.from({ length: Math.min(DSH_DISCOVERY_PROBE_CONCURRENCY, candidates.length) }, worker);
  await Promise.all(workers);
  return results.filter(Boolean);
}

function pickBestProbe(probes, savedBaseUrl) {
  const valid = probes.filter((probe) => probe.ok).sort((a, b) => a.priority - b.priority);
  if (!valid.length) return null;
  if (savedBaseUrl) {
    const saved = valid.find((probe) => probe.baseUrl === savedBaseUrl);
    if (saved) return saved;
  }
  return valid[0];
}

function addRangeCandidates(candidates, seen, centerBaseUrl, span, maxCandidates) {
  const center = normalizeLocalBaseUrl(centerBaseUrl);
  if (!center || candidates.length >= maxCandidates) return;
  let centerPort;
  try { centerPort = Number(new URL(center).port); } catch { return; }
  for (let delta = -span; delta <= span; delta += 1) {
    if (delta === 0 || candidates.length >= maxCandidates) continue;
    const port = centerPort + delta;
    if (port < 1 || port > 65535) continue;
    addCandidate(candidates, seen, 'http://127.0.0.1:' + port, 'range', 10, '围绕 ' + centerPort + ' 的 ±' + span);
  }
}

/**
 * 发现本机 DSH Web 端口。顺序：
 *   1) 当前保存地址（有效就直接沿用，避免无谓切换）
 *   2) 环境变量（只作为提示，不覆盖显式 pin 的判断在 main.js）
 *   3) DSH 进程参数 `--port`
 *   4) DSH 进程的监听端口（Desktop 用 --port 0，这是主路径）
 *   5) DSH 默认端口
 *   6) 只有全部失败后，才对保存端口/默认端口做 ±3 的有界探测
 */
async function discoverDshWeb(options = {}) {
  const started = Date.now();
  const probeTimeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 1200;
  const savedBaseUrl = normalizeLocalBaseUrl(options.savedBaseUrl || options.currentBaseUrl || '');
  const env = options.env || process.env;
  const maxCandidates = Number(options.maxCandidates) > 0 ? Number(options.maxCandidates) : DSH_DISCOVERY_MAX_CANDIDATES;

  let processInfo;
  if (options.skipProcessDiscovery) {
    processInfo = { ok: false, code: 'DSH_PROCESS_SKIPPED', processes: [], ports: [], argPorts: [], error: '已跳过进程发现' };
  } else {
    try {
      processInfo = await collectDshProcessInfo({
        timeoutMs: Number(options.processTimeoutMs) > 0 ? Number(options.processTimeoutMs) : undefined
      });
    } catch (error) {
      processInfo = {
        ok: false,
        code: 'DSH_PROCESS_QUERY_FAILED',
        processes: [],
        ports: [],
        argPorts: [],
        error: String(error && error.message || error).slice(0, 240)
      };
    }
  }

  const candidates = [];
  const seen = new Set();
  if (savedBaseUrl) addCandidate(candidates, seen, savedBaseUrl, 'saved', 0, '当前 dsh.json');
  if (env && env.DSH_WEB_URL) addCandidate(candidates, seen, env.DSH_WEB_URL, 'env-url', 1, 'DSH_WEB_URL');
  if (env) {
    for (const key of ['DSH_WEB_PORT', 'DSH_PORT']) {
      if (!env[key]) continue;
      addCandidate(candidates, seen, 'http://127.0.0.1:' + String(env[key]).trim(), 'env-port', 2, key);
    }
  }
  for (const port of processInfo.argPorts || []) {
    addCandidate(candidates, seen, 'http://127.0.0.1:' + port, 'process-arg', 3, 'DSH 进程 --port');
  }
  for (const listener of processInfo.ports || []) {
    addCandidate(candidates, seen, listener.baseUrl, 'process-port', 4, 'pid ' + listener.pid + ' 监听 ' + listener.port);
  }
  addCandidate(candidates, seen, 'http://127.0.0.1:' + DSH_WEB_DEFAULT_PORT, 'default', 5, '默认端口');

  const wave1 = candidates.slice(0, Math.min(DSH_DISCOVERY_MAX_WAVE1, maxCandidates));
  let probes = wave1.length ? await probeCandidates(wave1, probeTimeoutMs) : [];
  let best = pickBestProbe(probes, savedBaseUrl);
  let rangeProbed = false;
  if (!best && options.includeRange !== false) {
    rangeProbed = true;
    const before = candidates.length;
    addRangeCandidates(candidates, seen, savedBaseUrl, 3, maxCandidates);
    addRangeCandidates(candidates, seen, 'http://127.0.0.1:' + DSH_WEB_DEFAULT_PORT, 3, maxCandidates);
    const range = candidates.slice(before);
    if (range.length) {
      const rangeProbes = await probeCandidates(range, probeTimeoutMs);
      probes = probes.concat(rangeProbes);
      best = pickBestProbe(probes, savedBaseUrl);
    }
  }

  const probedPorts = probes.map((probe) => probe.port).filter((port) => Number.isInteger(port) && port > 0);
  const processSummary = {
    ok: Boolean(processInfo.ok),
    method: processInfo.method || '',
    dshProcesses: (processInfo.processes || []).length,
    ports: (processInfo.ports || []).map((listener) => listener.port),
    argPorts: (processInfo.argPorts || []).slice(),
    error: 'error' in processInfo ? String(processInfo.error || '').slice(0, 240) : ''
  };

  if (best) {
    return {
      ok: true,
      code: 'DSH_FOUND',
      message: '已发现 DSH Web：' + best.baseUrl + '（来源：' + candidateSourceLabel(best.source) + '）',
      baseUrl: best.baseUrl,
      source: best.source,
      savedBaseUrl,
      candidates,
      probes,
      process: processSummary,
      rangeProbed,
      durationMs: Date.now() - started
    };
  }

  const list = probedPorts.slice(0, 8).join('/');
  const reason = probedPorts.length
    ? '已探测 ' + probedPorts.length + ' 个本机端口（' + list + '），均未返回 401/DSH 特征'
    : (processSummary.error || '没有可探测的本机端口');
  const suffix = savedBaseUrl ? '；保留原地址 ' + savedBaseUrl : '';
  return {
    ok: false,
    code: 'DSH_NOT_FOUND',
    message: '未发现 DSH Web：' + reason + suffix,
    baseUrl: '',
    source: '',
    savedBaseUrl,
    candidates,
    probes,
    process: processSummary,
    rangeProbed,
    durationMs: Date.now() - started
  };
}

module.exports = {
  DshAdapter,
  discoverDshWeb,
  probeDshWeb,
  normalizeLocalBaseUrl,
  isLoopbackBaseUrl,
  dshResponseSignature
};
