'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const net = require('node:net');
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
// F-4：其它来源全落空时，才在 127.0.0.1 的这个区间做有界扫描（需求写死 6000–7000）。
const DSH_SCAN_DEFAULT_START = 49152; // P1-4：DSH 随机端口落在 ephemeral 区间，不再写死 6000–7000
const DSH_SCAN_DEFAULT_END = 65535;
const DSH_SCAN_MAX_PROBE_PORTS = 12;
const DSH_DISCOVERY_MAX_LISTENERS = 40; // P1-4：netstat 监听端口候选上限（进程反向匹配失败时兜底）

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
 * 端口文件（`~/.dsh/gui.port` 或等价）：DSH 方便外部程序找到自己时写的纯文本端口。
 * 只接受一个整数端口 / `port=NNNN` / `http://127.0.0.1:NNNN`，别的都当没写。
 */
function parsePortFileText(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return 0;
  const direct = /^(\d{2,5})$/.exec(raw);
  if (direct) {
    const port = Number(direct[1]);
    return port >= 1 && port <= 65535 ? port : 0;
  }
  const kv = /(?:^|[\s,{;"'])(?:port|webPort|web_port)["']?\s*[:=]\s*["']?(\d{2,5})/i.exec(raw);
  if (kv) {
    const port = Number(kv[1]);
    if (port >= 1 && port <= 65535) return port;
  }
  const url = /https?:\/\/(?:127\.0\.0\.1|localhost|\[::1\]):(\d{2,5})/i.exec(raw);
  if (url) {
    const port = Number(url[1]);
    if (port >= 1 && port <= 65535) return port;
  }
  return 0;
}

function dshHomeDirs(env) {
  const list = [];
  const home = String((env && env.DSH_HOME) || process.env.DSH_HOME || '').trim();
  if (home) list.push(home);
  list.push(path.join(os.homedir(), '.dsh'));
  try {
    if (process.env.APPDATA) list.push(path.join(process.env.APPDATA, 'dsh'));
  } catch { /* 忽略 */ }
  const seen = new Set();
  return list.filter((dir) => {
    const key = String(dir || '').toLowerCase();
    if (!key || seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

/** 读端口文件候选：只读已知文件名，不遍历目录，失败一律返回空数组（不抛）。 */
function readDshPortFiles(env, sink) {
  const files = ['gui.port', 'web.port', 'port', 'dsh.port'];
  const found = [];
  const report = (row) => { try { if (Array.isArray(sink)) sink.push(row); } catch { /* 读数不影响发现 */ } };
  const seenPorts = new Set();
  for (const dir of dshHomeDirs(env)) {
    for (const name of files) {
      const file = path.join(dir, name);
      let text;
      try {
        const stat = fs.statSync(file);
        if (!stat.isFile() || stat.size > 4096) { report({ file, exists: true, raw: '', port: 0, note: '不是普通文件或超 4KB' }); continue; }
        text = fs.readFileSync(file, 'utf8');
      } catch { report({ file, exists: false, raw: '', port: 0, note: '缺失' }); continue; }
      const port = parsePortFileText(text);
      if (!port) { report({ file, exists: true, raw: String(text).trim().slice(0, 64), port: 0, note: '无有效端口' }); continue; }
      if (seenPorts.has(port)) { report({ file, exists: true, raw: String(text).trim().slice(0, 64), port, note: '重复端口' }); continue; }
      seenPorts.add(port);
      report({ file, exists: true, raw: String(text).trim().slice(0, 64), port, note: 'ok' });
      found.push({ file, port, baseUrl: 'http://127.0.0.1:' + port, raw: String(text).trim().slice(0, 64) });
    }
  }
  return found;
}

/**
 * DSH 特征校验 #2（F-4）：`/json/version`。
 * 命中口径：正文含 DSH / DeepSeek Harness 标识 → `dsh-json-version`；
 * 只有 `Browser: Electron/x` 不算（别的 Electron 应用也会这么答），交给 `/` 页面特征复核。
 */
function dshVersionSignature(text, json) {
  const body = String(text || '');
  if (/deepseek[\s-]*harness/i.test(body)) return 'dsh-json-version';
  if (/(?:^|[^a-z0-9])dsh(?:[^a-z0-9]|$)/i.test(body)) return 'dsh-json-version';
  if (json && typeof json === 'object') {
    const probe = [json.Browser, json['User-Agent'], json.HttpVersion, json.ProtocolVersion]
      .map((value) => String(value == null ? '' : value)).join(' ');
    if (/deepseek|\bdsh\b/i.test(probe)) return 'dsh-json-version';
    if (/^electron\//i.test(String(json.Browser || ''))) return 'electron-json-version';
  }
  return '';
}

async function probeDshVersion(baseUrl, options = {}) {
  const started = Date.now();
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 800;
  let response;
  let text;
  try {
    response = await fetch(baseUrl + '/json/version', {
      method: 'GET',
      redirect: 'manual',
      headers: { accept: 'application/json,text/plain;q=0.9,*/*;q=0.8' },
      signal: AbortSignal.timeout(timeoutMs)
    });
    text = await response.text();
  } catch (cause) {
    const timeout = Boolean(cause && (cause.name === 'TimeoutError' || cause.name === 'AbortError' || cause.code === 'ABORT_ERR'));
    return {
      ok: false,
      code: timeout ? 'DSH_VERSION_TIMEOUT' : 'DSH_VERSION_OFFLINE',
      signature: '',
      elapsedMs: Date.now() - started,
      message: (timeout ? '探测 /json/version 超时：' : '/json/version 不可用：')
        + String(cause && (cause.cause && cause.cause.message || cause.message) || cause).slice(0, 120)
    };
  }
  const body = String(text || '').slice(0, 4096);
  let json = null;
  try { json = JSON.parse(body); } catch { json = null; }
  const signature = dshVersionSignature(body, json);
  const strong = signature === 'dsh-json-version';
  return {
    ok: strong && response.status === 200,
    code: strong ? 'DSH_VERSION_OK' : (signature ? 'DSH_VERSION_WEAK' : 'DSH_VERSION_NOT_DSH'),
    status: response.status,
    signature,
    weak: Boolean(signature) && !strong,
    elapsedMs: Date.now() - started,
    message: strong
      ? 'DSH 特征匹配（/json/version，' + signature + '）'
      : '不是 DSH（/json/version HTTP ' + response.status + '，' + (signature || '无 DSH 特征') + '）'
  };
}

/** 单个端口的 TCP 连通性探测：只判「有人在听」，不读任何数据。 */
function probeTcpPort(host, port, timeoutMs) {
  return new Promise((resolve) => {
    let settled = false;
    const finish = (open) => {
      if (settled) return;
      settled = true;
      try { socket.destroy(); } catch { /* 忽略 */ }
      resolve(open);
    };
    const socket = net.connect({ host, port });
    socket.setTimeout(timeoutMs, () => finish(false));
    socket.once('connect', () => finish(true));
    socket.once('error', () => finish(false));
  });
}

/**
 * 有界扫描 127.0.0.1 的端口区间（F-4）：先 TCP 判活，再对活端口做 DSH 特征校验。
 * 只在其它来源全部失败时才调用，避免每次唤醒都扫端口。
 */
async function scanLocalPortRange(options = {}) {
  const started = Date.now();
  const start = Number(options.start) > 0 ? Number(options.start) : 6000;
  const end = Number(options.end) > 0 ? Number(options.end) : 7000;
  const concurrency = Number(options.concurrency) > 0 ? Number(options.concurrency) : 64;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 220;
  const budgetMs = Number(options.budgetMs) > 0 ? Number(options.budgetMs) : 4000;
  const maxOpen = Number(options.maxOpen) > 0 ? Number(options.maxOpen) : 24;
  if (!(end >= start)) return { ok: false, code: 'DSH_SCAN_BAD_RANGE', ports: [], elapsedMs: 0 };
  const ports = [];
  let cursor = start;
  let budgetHit = false;
  const worker = async () => {
    while (cursor <= end) {
      if (Date.now() - started > budgetMs) { budgetHit = true; return; }
      const port = cursor++;
      if (await probeTcpPort('127.0.0.1', port, timeoutMs)) {
        ports.push(port);
        if (ports.length >= maxOpen) { budgetHit = true; return; }
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(concurrency * 4, Math.max(1, end - start + 1)) }, worker));
  ports.sort((a, b) => a - b);
  return {
    ok: true,
    code: budgetHit ? 'DSH_SCAN_PARTIAL' : 'DSH_SCAN_OK',
    ports,
    budgetHit,
    elapsedMs: Date.now() - started
  };
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
  // F-4：先验 `/json/version`（DSH 身份最直接的证据），弱特征再回落到 `/` 页面特征。
  const versionProbe = await probeDshVersion(baseUrl, { timeoutMs: Math.min(timeoutMs, 800) });
  if (versionProbe.ok) {
    return {
      ok: true,
      code: 'DSH_PROBE_OK',
      baseUrl,
      status: versionProbe.status,
      signature: versionProbe.signature,
      via: 'json/version',
      acceptedStatus: true,
      versionProbe,
      elapsedMs: Date.now() - started,
      message: 'DSH 特征匹配（/json/version，' + versionProbe.signature + '）'
    };
  }
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
    versionProbe,
    elapsedMs: Date.now() - started,
    bodyPreview: body.replace(/\s+/g, ' ').trim().slice(0, 120),
    message: ok
      ? 'DSH 特征匹配（HTTP ' + response.status + '，' + signature + '）'
      : '不是 DSH（HTTP ' + response.status + '，' + (signature || '无 DSH 特征') + '）'
  };
}

function fileExistsForDiag(file) { try { return fs.existsSync(String(file || "")); } catch { return false; } }
const commandAttempts = [];
/** 测试钩子（默认关闭）：AWB_DSH_COMMAND_STUB = JSON { "powershell.exe": {ok,stdout,stderr,error} }，按 basename 命中。 */
function commandStubFor(file) {
  const rawStub = String((process.env && process.env.AWB_DSH_COMMAND_STUB) || "").trim();
  if (!rawStub) return null;
  let map = null;
  try { map = JSON.parse(rawStub); } catch { return null; }
  if (!map || typeof map !== "object") return null;
  const key = path.basename(String(file || "")).toLowerCase();
  const hit = map[key] || map[String(file || "")] || null;
  if (!hit || typeof hit !== "object") return null;
  return hit;
}
function recordCommandAttempt(file, extra = {}) {
  const row = { file: String(file || ""), exists: fileExistsForDiag(file), ...extra };
  commandAttempts.push(row);
  if (commandAttempts.length > 40) commandAttempts.shift();
  return row;
}
function getCommandAttempts() { return commandAttempts.slice(); }
function resetCommandAttempts() { commandAttempts.length = 0; }
function runCommand(file, args, options = {}) {
  return new Promise((resolve) => {
    const stub = commandStubFor(file);
    if (stub) {
      recordCommandAttempt(file, { stub: true, ok: Boolean(stub.ok), error: String(stub.error || "") });
      resolve({ ok: Boolean(stub.ok), stdout: String(stub.stdout == null ? "" : stub.stdout), stderr: String(stub.stderr == null ? "" : stub.stderr), error: String(stub.error || ""), stub: true });
      return;
    }
    execFile(file, args, {
      windowsHide: true,
      timeout: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 6000,
      maxBuffer: Number(options.maxBuffer) > 0 ? Number(options.maxBuffer) : 8 * 1024 * 1024,
      encoding: 'utf8'
    }, (error, stdout, stderr) => {
      const diagFile = file;
      if (error) recordCommandAttempt(diagFile, { ok: false, error: String(error.message || error), code: String((error && error.code) || "") });
      else recordCommandAttempt(diagFile, { ok: true });
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
  const netstat = String(process.env.AWB_NETSTAT_PATH || "").trim() || windowsSystemPath(path.join("System32", "netstat.exe"));
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
  const powershellCandidates = [
    String(process.env.AWB_POWERSHELL_PATH || "").trim(),
    windowsSystemPath(path.join("System32", "WindowsPowerShell", "v1.0", "powershell.exe")),
    windowsSystemPath(path.join("WindowsPowerShell", "v1.0", "powershell.exe")),
  ].filter(Boolean);
  const script = [
    '[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    '$OutputEncoding = [System.Text.UTF8Encoding]::new($false)',
    "$ErrorActionPreference='SilentlyContinue'",
    '$procs = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId,Name,CommandLine,CreationDate)',
    'ConvertTo-Json -InputObject @($procs) -Depth 4 -Compress'
  ].join('\n');
  const encoded = Buffer.from(script, 'utf16le').toString('base64');
  let result = null;
  let powershellUsed = "";
  const powershellErrors = [];
  for (const candidate of powershellCandidates) {
    const attempt = await runCommand(candidate, [
      "-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-EncodedCommand", encoded
    ], {
      timeoutMs: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 8000,
      maxBuffer: 16 * 1024 * 1024
    });
    if (attempt.ok) { result = attempt; powershellUsed = candidate; break; }
    powershellErrors.push(String(candidate) + "（存在=" + fileExistsForDiag(candidate) + "）：" + String(attempt.error || "失败").slice(0, 120));
    result = result || attempt;
  }
  if (!result || !result.ok) {
    return { ok: false, code: "DSH_PROCESS_QUERY_FAILED", processes: [], error: (powershellErrors.join("；") || "PowerShell 进程查询失败").slice(0, 400), candidates: powershellCandidates.map((file) => ({ file, exists: fileExistsForDiag(file) })) };
  }
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
  const wmic = String(process.env.AWB_WMIC_PATH || "").trim() || windowsSystemPath(path.join("System32", "wbem", "wmic.exe"));
  const result = await runCommand(wmic, [
    'process', 'get', 'ProcessId,ParentProcessId,Name,CommandLine,CreationDate', '/format:list'
  ], {
    timeoutMs: Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 5000,
    maxBuffer: 16 * 1024 * 1024
  });
  const wmicMissing = !fileExistsForDiag(wmic) && !(commandStubFor(wmic));
  if (!result.ok && wmicMissing) {
    // P0-2：Win11 24H2 起 wmic 已移除——缺失不是致命错误，直接走 Get-CimInstance（PowerShell）。
    recordCommandAttempt(wmic, { ok: false, error: "WMIC_MISSING" });
  }
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
  const listenerPorts = (listeners.ok ? listeners.listeners : []).slice(0, 80);
  const diagnostics = {
    netstat: { ok: Boolean(listeners.ok), error: String(listeners.error || "").slice(0, 200) },
    processes: { ok: Boolean(processResult.ok), method: String(processResult.method || ""), error: String(processResult.error || "").slice(0, 240) },
    commandAttempts: getCommandAttempts().slice(-12),
  };
  const listenerSummary = listenerPorts.map((listener) => ({ port: listener.port, pid: listener.pid, baseUrl: listener.baseUrl }));
  return {
    ok: processResult.ok,
    code: errors.length ? 'DSH_PROCESS_PARTIAL' : 'OK',
    method: processResult.method || '',
    processes: dshProcesses.map((proc) => ({ pid: proc.pid, name: proc.name })),
    ports,
    argPorts,
    error: errors.join('；').slice(0, 240),
    listenerPorts: listenerSummary,
    diagnostics,
  };
}

function candidateSourceLabel(source) {
  const labels = {
    explicit: '显式配置',
    saved: '上次保存的地址',
    'env-url': '环境变量 DSH_WEB_URL',
    'env-port': '环境变量端口',
    'port-file': 'DSH 端口文件',
    'process-arg': 'DSH 进程参数',
    'process-port': 'DSH 进程监听端口',
    default: 'DSH 默认端口',
    'range-scan': '临时端口（49152–65535）扫描',
    'netstat-port': 'netstat 监听端口',
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
 * 发现本机 DSH Web 端口（F-4）。解析顺序（前面的优先，命中即用）：
 *   0) 显式配置（dsh.json 里用户 pin 的地址 / DSH_WEB_URL，由 main.js 传入）——有显式配置就不报歧义
 *   1) 上次保存地址（有效就沿用，避免无谓切换）
 *   2) 环境变量 DSH_WEB_URL / DSH_WEB_PORT / DSH_PORT
 *   3) 端口文件（~/.dsh/gui.port 等）
 *   4) DSH 进程参数 `--port`
 *   5) DSH 进程的监听端口（Desktop 用 --port 0，这是主路径）
 *   6) DSH 默认端口
 *   7) 都落空才做有界探测：先保存/默认地址 ±3，再扫 127.0.0.1 的 6000–7000（先 TCP 判活，再验特征）
 * 任何候选都必须通过 DSH 特征校验（`/json/version` 或 `/` 页面特征），绝不「端口活着就当 DSH」。
 * 返回 state：resolved / ambiguous / failed，供 `dsh_endpoint` 事件落账。
 */
async function discoverDshWeb(options = {}) {
  const started = Date.now();
  const probeTimeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 1200;
  const savedBaseUrl = normalizeLocalBaseUrl(options.savedBaseUrl || options.currentBaseUrl || '');
  const env = options.env || process.env;
  const maxCandidates = Number(options.maxCandidates) > 0 ? Number(options.maxCandidates) : DSH_DISCOVERY_MAX_CANDIDATES;
  const explicitBaseUrl = normalizeLocalBaseUrl(options.explicitBaseUrl || '');
  const explicitSource = String(options.explicitSource || 'explicit');
  const scanStart = Number(options.scanRange && options.scanRange.start) > 0 ? Number(options.scanRange.start) : DSH_SCAN_DEFAULT_START;
  const scanEnd = Number(options.scanRange && options.scanRange.end) > 0 ? Number(options.scanRange.end) : DSH_SCAN_DEFAULT_END;

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

  // B-0cbc：端口文件读数同时收「缺失/无端口」明细，失败文案要逐条列（PM ②）。
  const portFileReadout = [];
  const portFiles = options.skipPortFiles
    ? []
    : readDshPortFiles(env, portFileReadout);
  const candidates = [];
  const seen = new Set();
  // B-0cbc（PM ①③）：顺序改为 显式配置 → DSH_WEB_URL/PORT → ~/.dsh/*.port → 上次保存(dsh.json)
  //   → 进程命令行 → 监听端口 → 端口段扫描。上次保存的地址只是**候选**，失效时仍走完整条链。
  if (explicitBaseUrl) addCandidate(candidates, seen, explicitBaseUrl, 'explicit', -1, explicitSource || '显式配置');
  if (env && env.DSH_WEB_URL) addCandidate(candidates, seen, env.DSH_WEB_URL, 'env-url', 1, 'DSH_WEB_URL');
  if (env) {
    for (const key of ['DSH_WEB_PORT', 'DSH_PORT']) {
      if (!env[key]) continue;
      addCandidate(candidates, seen, 'http://127.0.0.1:' + String(env[key]).trim(), 'env-port', 2, key);
    }
  }
  for (const entry of portFiles) {
    addCandidate(candidates, seen, entry.baseUrl, 'port-file', 2, entry.file + ' → ' + entry.raw);
  }
  if (savedBaseUrl) addCandidate(candidates, seen, savedBaseUrl, 'saved', 3, '上次保存（dsh.json）');
  for (const port of processInfo.argPorts || []) {
    addCandidate(candidates, seen, 'http://127.0.0.1:' + port, 'process-arg', 3, 'DSH 进程 --port');
  }
  for (const listener of processInfo.ports || []) {
    addCandidate(candidates, seen, listener.baseUrl, 'process-port', 4, 'pid ' + listener.pid + ' 监听 ' + listener.port);
  }
  // P1-4：进程反向匹配失败/为空时，用 netstat 监听端口兜底（比全端口扫描便宜）。
  const listenerCandidates = (processInfo.listenerPorts || []).slice(0, DSH_DISCOVERY_MAX_LISTENERS);
  for (const listener of listenerCandidates) {
    addCandidate(candidates, seen, listener.baseUrl, "netstat-port", 5, "netstat 监听 " + listener.port + "（pid " + listener.pid + "）");
  }

  addCandidate(candidates, seen, 'http://127.0.0.1:' + DSH_WEB_DEFAULT_PORT, 'default', 5, '默认端口');

  const wave1 = candidates.slice(0, Math.min(DSH_DISCOVERY_MAX_WAVE1, maxCandidates));
  let probes = wave1.length ? await probeCandidates(wave1, probeTimeoutMs) : [];
  let best = pickBestProbe(probes, savedBaseUrl);
  let rangeProbed = false;
  let scan = null;
  const canProbeBeyond = !explicitBaseUrl && options.includeRange !== false;
  if (!best && canProbeBeyond) {
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
  // F-4-7：其它来源全落空，才在 127.0.0.1 的 6000–7000 里做有界扫描（先 TCP 判活，再验 DSH 特征）。
  if (!best && canProbeBeyond && options.includeScan !== false) {
    try {
      scan = await scanLocalPortRange({
        start: scanStart,
        end: scanEnd,
        concurrency: Number(options.scanConcurrency) > 0 ? Number(options.scanConcurrency) : undefined,
        timeoutMs: Number(options.scanConnectTimeoutMs) > 0 ? Number(options.scanConnectTimeoutMs) : undefined,
        budgetMs: Number(options.scanBudgetMs) > 0 ? Number(options.scanBudgetMs) : undefined
      });
    } catch (error) {
      scan = { ok: false, code: 'DSH_SCAN_FAILED', ports: [], error: String(error && error.message || error).slice(0, 160) };
    }
    const openPorts = (scan && Array.isArray(scan.ports) ? scan.ports : [])
      .slice(0, DSH_SCAN_MAX_PROBE_PORTS);
    const before = candidates.length;
    for (const port of openPorts) {
      addCandidate(candidates, seen, 'http://127.0.0.1:' + port, 'range-scan', 9, '扫描 127.0.0.1:' + port + ' 有监听');
    }
    const scanned = candidates.slice(before);
    if (scanned.length) {
      const scannedProbes = await probeCandidates(scanned, probeTimeoutMs);
      probes = probes.concat(scannedProbes);
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
    listenerPorts: (processInfo.listenerPorts || []).map((listener) => listener.port),
    error: 'error' in processInfo ? String(processInfo.error || '').slice(0, 240) : ''
  };
  const portFileSummary = portFiles.map((entry) => ({ file: entry.file, port: entry.port }));
  const valid = probes.filter((probe) => probe.ok).sort((a, b) => a.priority - b.priority);
  const validDistinct = [];
  const validSeen = new Set();
  for (const probe of valid) {
    if (validSeen.has(probe.baseUrl)) continue;
    validSeen.add(probe.baseUrl);
    validDistinct.push(probe);
  }

  // B-0cbc（PM ④）：显式 pin 不可达、但环境变量/端口文件等源探活成功时，**用命中的并提示 pin 已失效**
  // （旧实现直接判失败 → DSH 换端口后工作台永久失联）。没有任何命中才报 DSH_EXPLICIT_UNREACHABLE。
  const pinProbe = explicitBaseUrl ? probes.find((probe) => probe.baseUrl === explicitBaseUrl) : null;
  if (explicitBaseUrl && !validDistinct.some((probe) => probe.baseUrl === explicitBaseUrl) && validDistinct.length) {
    const picked = validDistinct.slice().sort((a, b) => a.priority - b.priority)[0];
    return {
      ok: true, state: 'resolved', code: 'DSH_FOUND_PIN_UNREACHABLE',
      message: '显式配置的地址不可达：' + explicitBaseUrl + '（来源：' + explicitSource + '），已改用探活命中的 '
        + picked.baseUrl + '（来源：' + candidateSourceLabel(picked.source) + '）；建议在设置里重新保存地址',
      baseUrl: picked.baseUrl,
      source: picked.source,
      explicitIgnored: true,
      explicitBaseUrl, explicitSource, savedBaseUrl,
      candidates, probes, valid: validDistinct,
      process: processSummary, portFiles: portFileSummary, portFileReadout,
      probedPorts: probes.map((p) => p.port).filter((p) => Number.isInteger(p) && p > 0),
      shouldPersist: true,
      rangeProbed, scan,
      durationMs: Date.now() - started,
    };
  }
  if (explicitBaseUrl && !validDistinct.some((probe) => probe.baseUrl === explicitBaseUrl)) {
    return {
      ok: false,
      state: 'failed',
      code: 'DSH_EXPLICIT_UNREACHABLE',
      message: '显式配置的 DSH 地址不可达：' + explicitBaseUrl + '（来源：' + explicitSource + '）；请确认 DSH 已启动，或清掉该配置改用自动发现',
      baseUrl: '',
      source: '',
      explicitBaseUrl,
      explicitSource,
      savedBaseUrl,
      candidates,
      probes,
      valid: validDistinct,
      process: processSummary,
      portFiles: portFileSummary,
      rangeProbed,
      scan,
      durationMs: Date.now() - started
    };
  }

  // 歧义（F-4）：没有显式配置且命中多个不同地址 → 不擅自挑一个。
  if (!explicitBaseUrl && validDistinct.length > 1) {
    const listed = validDistinct.slice(0, 6)
      .map((probe) => probe.baseUrl + '（' + candidateSourceLabel(probe.source) + '）')
      .join('、');
    return {
      ok: false,
      state: 'ambiguous',
      code: 'DSH_AMBIGUOUS',
      ambiguous: true,
      message: '发现 ' + validDistinct.length + ' 个疑似 DSH：' + listed
        + '；已保留原地址 ' + (savedBaseUrl || '（未设置）')
        + '。请在工作台里显式指定地址，或只保留一个 DSH 实例',
      baseUrl: '',
      source: '',
      explicitBaseUrl: '',
      savedBaseUrl,
      candidates,
      probes,
      valid: validDistinct,
      process: processSummary,
      portFiles: portFileSummary,
      rangeProbed,
      scan,
      durationMs: Date.now() - started
    };
  }

  if (best) {
    return {
      ok: true,
      state: 'resolved',
      code: 'DSH_FOUND',
      // PM ④：非「上次保存」的源命中（env/端口文件/进程/扫描）由 main 回写 dsh.json。
      shouldPersist: String(best.source || '') !== 'saved',
      probedPorts: Array.from(new Set(probes.map((p) => p.port).filter((p) => Number.isInteger(p) && p > 0))).sort((a, b) => a - b),
      portFileReadout,
      message: '已发现 DSH Web：' + best.baseUrl + '（来源：' + candidateSourceLabel(best.source) + '）',
      baseUrl: best.baseUrl,
      source: best.source,
      explicitBaseUrl,
      savedBaseUrl,
      candidates,
      probes,
      valid: validDistinct,
      process: processSummary,
      portFiles: portFileSummary,
      rangeProbed,
      scan,
      durationMs: Date.now() - started
    };
  }

  // B-0cbc（PM ②）：已探测端口必须**如实全列**（旧实现 slice(0,8) 导致「说 18 个只列 6 个」）。
  const probedSorted = Array.from(new Set(probedPorts)).sort((a, b) => a - b);
  const listedPorts = probedSorted.map((port) => '127.0.0.1:' + port).join('、');
  const reasons = [];
  if (probedSorted.length) reasons.push('已探测 ' + probedSorted.length + ' 个本机端口（' + listedPorts + '），均未返回 DSH 特征');
  else reasons.push(processSummary.error || '没有可探测的本机端口');
  // 各权威源读数：env / 端口文件 / dsh.json / 进程 / 扫描段（PM ②）。
  const envReadout = [
    'DSH_WEB_URL=' + (env && env.DSH_WEB_URL ? String(env.DSH_WEB_URL) : '（未设）'),
    'DSH_WEB_PORT=' + (env && env.DSH_WEB_PORT ? String(env.DSH_WEB_PORT) : '（未设）'),
    'DSH_PORT=' + (env && env.DSH_PORT ? String(env.DSH_PORT) : '（未设）'),
  ].join('；');
  const checkedCount = portFileReadout.length;
  const existedCount = portFileReadout.filter((row) => row.exists).length;
  const portFileReadoutText = checkedCount
    ? '端口文件 查了 ' + checkedCount + ' 个（存在 ' + existedCount + ' 个）'
      + (existedCount ? '：' + portFileReadout.filter((row) => row.exists).map((row) => row.file + '=' + (row.port || row.note)).join('；') : '；全部缺失')
    : '端口文件（已跳过）';
  reasons.push('来源读数：' + envReadout + '；' + portFileReadoutText
    + '；dsh.json 上次地址=' + (savedBaseUrl || '（无）')
    + '；dsh 进程=' + (processSummary.dshProcesses || 0) + ' 个'
    + (processSummary.argPorts && processSummary.argPorts.length ? '（--port ' + processSummary.argPorts.join('/') + '）' : ''));
  if (scan && Array.isArray(scan.ports)) {
    reasons.push(scan.ports.length
      ? '扫描 ' + scanStart + '–' + scanEnd + ' 有 ' + scan.ports.length + ' 个端口在监听但都不是 DSH'
      : '扫描 ' + scanStart + '–' + scanEnd + ' 没有发现监听端口');
  }
  if (portFiles.length) reasons.push('端口文件写了 ' + portFiles.map((entry) => entry.port).join('/') + '，均不可用');
  // B-0cbc（PM ⑤）：失败态给可执行下一步（预填候选 + 如何取端口）。
  const nextHints = [];
  if (portFiles.length) nextHints.push('先试端口文件里写过的 ' + portFiles.map((entry) => 'http://127.0.0.1:' + entry.port).join('、'));
  if (probedSorted.length) nextHints.push('已知本机在用的候选：' + probedSorted.slice(0, 6).map((port) => 'http://127.0.0.1:' + port).join('、'));
  nextHints.push('在 DSH 里查看 设置 → Web/HTTP 端口，或看 DSH 启动命令行里的 --port；把地址填到 工作台 → 设置 → DSH 外部地址 后点「保存并探测」');
  const suffix = (savedBaseUrl ? '；保留原地址 ' + savedBaseUrl : '') + '。下一步：' + nextHints.join('；');
  // P0-2：发现失败时把命令候选路径+存在性写进可读原因（ENOENT 可诊断）。
  const diag = processInfo.diagnostics || {};
  try {
    const att = Array.isArray(diag.commandAttempts) ? diag.commandAttempts : [];
    const parts = [];
    for (const row of att.slice(-6)) parts.push(String(row.file) + "（存在=" + String(row.exists) + "）");
    if (parts.length) reasons.push('诊断：' + parts.join('；'));
    else if (diag.processes && diag.processes.error) reasons.push('诊断：' + String(diag.processes.error));
  } catch { /* 诊断失败不阻断 */ }
  return {
    ok: false,
    state: 'failed',
    code: 'DSH_NOT_FOUND',
    message: '未发现 DSH Web：' + reasons.join('；') + suffix,
    baseUrl: '',
    source: '',
    explicitBaseUrl: '',
    savedBaseUrl,
    candidates,
    probes,
    valid: validDistinct,
    process: processSummary,
    portFiles: portFileSummary,
    portFileReadout,
    // B-0cbc（PM ②⑤）：失败结果也带完整端口清单，界面/夹具与文案同源对账。
    probedPorts: probedSorted,
    rangeProbed,
    scan,
    durationMs: Date.now() - started
  };
}

module.exports = {
  DshAdapter,
  discoverDshWeb,
  probeDshWeb,
  probeDshVersion,
  normalizeLocalBaseUrl,
  isLoopbackBaseUrl,
  dshResponseSignature,
  dshVersionSignature,
  parsePortFileText,
  readDshPortFiles,
  scanLocalPortRange,
  DSH_WEB_DEFAULT_PORT,
  DSH_SCAN_DEFAULT_START,
  DSH_SCAN_DEFAULT_END,
  getCommandAttempts,
  resetCommandAttempts
};
