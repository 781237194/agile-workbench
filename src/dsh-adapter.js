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
// d637（P1）：权威源先探，命中即短路；探测并发从 6 提到 32（本机 loopback 探测，QPS 不是瓶颈）。
const DSH_DISCOVERY_PROBE_CONCURRENCY = 32;
const DSH_QUICK_PROBE_TIMEOUT_MS = 700;   // 权威源（显式/env/端口文件/上次保存）单探上限
const DSH_SCAN_CONCURRENCY = 96;         // 扫描并发（≥32）
const DSH_SCAN_CONNECT_TIMEOUT_MS = 180;  // 扫描单探 TCP 超时（≤250ms）
const DSH_SCAN_BUDGET_MS = 1800;          // 扫描总预算（冷启动 ≤2s 的前提）
const DSH_SCAN_PRIORITY_SPAN = 16;        // 历史端口 ±16 先扫
const DSH_SCAN_MAX_OPEN = 6;
// F-4：其它来源全落空时，才在 127.0.0.1 的这个区间做有界扫描（需求写死 6000–7000）。
const DSH_SCAN_DEFAULT_START = 49152; // P1-4：DSH 随机端口落在 ephemeral 区间，不再写死 6000–7000
const DSH_SCAN_DEFAULT_END = 65535;
const DSH_SCAN_MAX_PROBE_PORTS = 12;
const DSH_DISCOVERY_MAX_LISTENERS = 40; // P1-4：netstat 监听端口候选上限（进程反向匹配失败时兜底）
// B-33b9（P0 DSH 地址自愈）：监听端口枚举 + 特征校验的总预算。
// 口径来源=任务卡 AC①②：netstat ≤300ms、探活并发 ≤8/超时 400ms、发现链总预算 ≤1.5s。
// 不再扫 49152–65535 全段（Owner 现场：真正端口 55263 从未被探测过）。
const DSH_NETSTAT_BUDGET_MS = 300;
const DSH_LISTENER_PROBE_CONCURRENCY = 8;
const DSH_LISTENER_PROBE_TIMEOUT_MS = 250;
const DSH_LISTENER_BUDGET_MS = 1500;
const DSH_LISTENER_MAX_CANDIDATES = 40;
// 只探「最像 DSH」的前 N 个监听端口（按端口大小排序，DSH 随机端口通常在 10000+）。
// 16 个 = 8 并发 × 2 波，单候选用例硬上限 620ms → 最坏 ~1.24s，满足发现链 ≤1.5s，
// 同时避免在启动事件循环抖动时把全部 40+ 个系统端口都等一遍（实测会拖到 4–5s）。
const DSH_LISTENER_MAX_PROBE = 16;

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
    const timer = setTimeout(() => finish(false), Math.max(50, Number(timeoutMs) || 250));
    function finish(open) {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      try { socket.destroy(); } catch { /* 忽略 */ }
      resolve(open);
    }
    const socket = net.connect({ host, port });
    socket.setTimeout(Math.max(50, Number(timeoutMs) || 250), () => finish(false));
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
  const concurrency = Number(options.concurrency) > 0 ? Number(options.concurrency) : DSH_SCAN_CONCURRENCY;
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : DSH_SCAN_CONNECT_TIMEOUT_MS;
  const budgetMs = Number(options.budgetMs) > 0 ? Number(options.budgetMs) : DSH_SCAN_BUDGET_MS;
  const maxOpen = Number(options.maxOpen) > 0 ? Number(options.maxOpen) : DSH_SCAN_MAX_OPEN;
  // d637：①历史端口 ±span 先扫（上次保存 / env / 默认端口周围）；②其余从 end 往下扫（ephemeral 端口就近分配，
  // 51234 这种靠上的端口第一批就命中，换端口后不用等整段扫完）。
  const priority = Array.isArray(options.priorityPorts) ? options.priorityPorts : [];
  if (!(end >= start)) return { ok: false, code: 'DSH_SCAN_BAD_RANGE', ports: [], elapsedMs: 0 };
  const visited = new Set();
  const queue = [];
  const push = (port) => {
    if (!Number.isInteger(port) || port < start || port > end || visited.has(port)) return;
    visited.add(port);
    queue.push(port);
  };
  for (const port of priority) push(Number(port));
  for (let port = end; port >= start; port -= 1) push(port);
  const ports = [];
  let cursor = 0;
  let budgetHit = false;
  let openLimitHit = false;
  const worker = async () => {
    while (cursor < queue.length) {
      if (Date.now() - started > budgetMs) { budgetHit = true; return; }
      const port = queue[cursor++];
      if (await probeTcpPort('127.0.0.1', port, timeoutMs)) {
        ports.push(port);
        if (ports.length >= maxOpen) { openLimitHit = true; return; }
      }
    }
  };
  const workers = Math.max(1, Math.min(concurrency, queue.length || 1));
  await Promise.all(Array.from({ length: workers }, worker));
  ports.sort((a, b) => a - b);
  return {
    ok: true,
    code: budgetHit ? 'DSH_SCAN_PARTIAL' : 'DSH_SCAN_OK',
    ports,
    budgetHit,
    openLimitHit,
    scannedPorts: Math.min(cursor, queue.length),
    concurrency: workers,
    connectTimeoutMs: timeoutMs,
    priorityPorts: priority.slice(0, 64),
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

function addCandidate(candidates, seen, rawUrl, source, priority, evidence, extra) {
  const baseUrl = normalizeLocalBaseUrl(rawUrl);
  if (!baseUrl || seen.has(baseUrl)) return false;
  seen.add(baseUrl);
  let port = 0;
  try { port = Number(new URL(baseUrl).port) || 0; } catch { /* 已校验 */ }
  candidates.push({ baseUrl, port, source, priority, evidence: String(evidence || ''), ...(extra && typeof extra === 'object' ? extra : {}) });
  return true;
}

async function probeCandidates(candidates, timeoutMs, concurrency, deadline) {
  const results = new Array(candidates.length);
  const limit = Number(concurrency) > 0 ? Number(concurrency) : DSH_DISCOVERY_PROBE_CONCURRENCY;
  const hardDeadline = Number(deadline) > 0 ? Number(deadline) : 0;
  let cursor = 0;
  let skipped = 0;
  const worker = async () => {
    while (cursor < candidates.length) {
      // B-33b9：发现链总预算硬闸——到点后未探的候选直接跳过，不能把首屏拖到 2s+。
      if (hardDeadline && Date.now() >= hardDeadline) { skipped += 1; cursor += 1; continue; }
      const index = cursor++;
      const candidate = candidates[index];
      const timeout = hardDeadline ? Math.max(120, Math.min(timeoutMs, hardDeadline - Date.now())) : timeoutMs;
      // B-33b9：先做 TCP 判活（250ms 级、可中断），死端口不再发 HTTP——
      // Windows 上对「被防火墙丢弃」的端口发 fetch 会卡 5s，AbortSignal 也救不回首屏。
      let host = '127.0.0.1';
      try { host = String(new URL(candidate.baseUrl).hostname || '127.0.0.1').replace(/^\[|\]$/g, ''); } catch { /* 用默认 */ }
      const tcpOpen = candidate.port > 0 ? await probeTcpPort(host, candidate.port, Math.min(250, timeout)) : true;
      if (!tcpOpen) {
        results[index] = { ...candidate, ok: false, code: 'DSH_PROBE_TCP_CLOSED', elapsedMs: 0, message: '端口未监听' };
        continue;
      }
      // HTTP 特征校验也加硬闸：某些系统服务 TCP 能连但永不回 HTTP，fetch 的超时在 Windows 上
      // 偶尔要 5s 才生效——这里用 Promise.race 保证单候选 ≤2×timeout+120ms 一定返回。
      const hardProbeMs = Math.max(200, timeout * 2 + 120);
      const probe = await Promise.race([
        probeDshWeb(candidate.baseUrl, { timeoutMs: timeout }),
        new Promise((resolve) => setTimeout(() => resolve({
          ok: false,
          code: 'DSH_PROBE_HARD_TIMEOUT',
          baseUrl: candidate.baseUrl,
          elapsedMs: hardProbeMs,
          message: '特征校验超过 ' + hardProbeMs + 'ms（已跳过）'
        }), hardProbeMs))
      ]);
      results[index] = { ...candidate, ...probe };
    }
  };
  const workers = Array.from({ length: Math.min(limit, candidates.length) }, worker);
  // B-33b9：调用方可能用 Promise.race 到点取快照——把「已完成结果」实时挂在 promise 上，
  // 这样即使个别候选的 fetch 卡住，也能拿到先探到的命中（真 DSH 通常在第一批里）。
  const done = Promise.all(workers).then(() => results.filter(Boolean));
  done.liveResults = results;
  return done;
}

/**
 * B-33b9 AC⑤：进程发现以 netstat 的 PID 列为主证据。
 * - 命中监听端口时：pid→端口 明确（Electron 形态也能定位），不再出现「dsh 进程=0 个」；
 * - 未命中时：如实写「未能识别 DSH 进程（形态：Electron/未知）」，并给出监听端口数量。
 */
function processInfoFromListeners(listenerInfo, hitProbe) {
  const listeners = (listenerInfo && Array.isArray(listenerInfo.listeners)) ? listenerInfo.listeners : [];
  const hit = hitProbe || null;
  const hitPid = hit && hit.pid ? Number(hit.pid) : 0;
  const ports = hit ? [{ port: Number(hit.port) || 0, pid: hitPid, baseUrl: hit.baseUrl }] : [];
  const identified = Boolean(hit);
  const form = identified ? 'Electron/netstat' : (listeners.length ? 'Electron/监听端口' : '未知');
  return {
    ok: Boolean(listenerInfo && listenerInfo.ok),
    code: identified ? 'OK' : (listenerInfo && listenerInfo.ok ? 'DSH_PROCESS_NOT_IDENTIFIED' : 'DSH_NETSTAT_FAILED'),
    method: 'netstat',
    processes: [],
    dshProcesses: 0,
    identified,
    form,
    ports,
    argPorts: [],
    listenerPorts: listeners,
    error: listenerInfo && listenerInfo.error ? String(listenerInfo.error).slice(0, 240) : '',
    message: identified
      ? '已从 netstat 监听端口识别 DSH：pid ' + hitPid + ' 监听 ' + hit.port
      : '未能识别 DSH 进程（形态：' + form + '），已取到 ' + listeners.length + ' 个本机监听端口'
  };
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
  // B-33b9：发现链总预算（默认 1.5s）——首屏前只做「监听端口枚举 + 特征校验」。
  const totalBudgetMs = Number(options.totalBudgetMs) > 0 ? Number(options.totalBudgetMs) : DSH_LISTENER_BUDGET_MS;
  const deadline = started + totalBudgetMs;
  const scanStart = Number(options.scanRange && options.scanRange.start) > 0 ? Number(options.scanRange.start) : DSH_SCAN_DEFAULT_START;
  const scanEnd = Number(options.scanRange && options.scanRange.end) > 0 ? Number(options.scanRange.end) : DSH_SCAN_DEFAULT_END;

  // d637（P1）：先把「权威源」（显式/env/端口文件/上次保存）建出来并**单独先探一轮**：
  //   任一命中 → 直接短路，不跑进程发现（netstat/powershell 很贵）也不扫描（scanAttempts=0）。
  const stats = {
    startedAt: started,
    quickCandidates: 0,
    quickProbeMs: 0,
    quickHit: false,
    listenerMs: 0,
    listenerCount: 0,
    listenerProbes: 0,
    listenerSkipped: 0,
    listenerHit: false,
    listenerBudgetHit: false,
    totalBudgetMs,
    processMs: 0,
    processSkipped: false,
    waveProbeMs: 0,
    rangeProbeMs: 0,
    listenerProbeMs: 0,
    listenerWaveMs: 0,
    scanAttempts: 0,
    scanPorts: 0,
    scanElapsedMs: 0,
    scanConcurrency: 0,
    scanConnectTimeoutMs: 0,
    probeTimeoutMs
  };
  // B-0cbc：端口文件读数同时收「缺失/无端口」明细，失败文案要逐条列（PM ②）。
  const portFileReadout = [];
  const portFiles = options.skipPortFiles
    ? []
    : readDshPortFiles(env, portFileReadout);
  const candidates = [];
  const seen = new Set();
  // B-0cbc（PM ①③）：权威源顺序 显式配置 → DSH_WEB_URL/PORT → ~/.dsh/*.port → 上次保存(dsh.json)。
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
  const quickCandidates = candidates.slice();
  stats.quickCandidates = quickCandidates.length;
  const quickStarted = Date.now();
  let probes = quickCandidates.length
    ? await probeCandidates(quickCandidates, Math.min(probeTimeoutMs, DSH_QUICK_PROBE_TIMEOUT_MS))
    : [];
  stats.quickProbeMs = Date.now() - quickStarted;
  let best = pickBestProbe(probes, savedBaseUrl);
  stats.quickHit = Boolean(best);
  let processInfo = { ok: false, code: 'DSH_PROCESS_SKIPPED', processes: [], ports: [], argPorts: [], error: best ? '权威源已命中，跳过进程发现' : '已跳过进程发现' };
  let listenerInfo = { ok: false, code: best ? 'DSH_LISTENER_SKIPPED' : 'DSH_LISTENER_PENDING', listeners: [], error: '' };
  if (best) {
    stats.processSkipped = true;
  } else {
    // B-33b9 AC①：先做「本机监听端口枚举」（netstat ≤300ms），这是主路径；
    // 它比 wmic/PowerShell 进程查询便宜得多，Electron 形态也能拿到 pid→端口。
    if (options.skipListenerProbe !== true) {
      const listenerStarted = Date.now();
      const remain = Math.max(0, deadline - Date.now());
      try {
        const waitMs = Math.max(200, Math.min(DSH_NETSTAT_BUDGET_MS + 400, remain || DSH_NETSTAT_BUDGET_MS));
        listenerInfo = await Promise.race([
          listWindowsListeners({ timeoutMs: Math.max(120, Math.min(DSH_NETSTAT_BUDGET_MS, remain || DSH_NETSTAT_BUDGET_MS)) }),
          new Promise((resolve) => setTimeout(() => resolve({
            ok: false,
            code: 'DSH_NETSTAT_TIMEOUT',
            listeners: [],
            error: 'netstat 超过 ' + waitMs + 'ms 未返回（已跳过，后台重试）'
          }), waitMs))
        ]);
      } catch (error) {
        listenerInfo = { ok: false, code: 'DSH_NETSTAT_FAILED', listeners: [], error: String(error && error.message || error).slice(0, 200) };
      }
      stats.listenerMs = Date.now() - listenerStarted;
      stats.listenerCount = Array.isArray(listenerInfo.listeners) ? listenerInfo.listeners.length : 0;
      if (!listenerInfo.ok) stats.listenerError = String(listenerInfo.error || 'netstat 不可用').slice(0, 200);
    }
    // B-33b9：监听端口按「像 DSH 的程度」排序——DSH 的随机端口通常在 10000+，
    // 135/445/5040 这类系统端口排后面，避免 1.5s 预算被系统端口吃掉、真端口没探到。
    const listenerRank = (listener) => (Number(listener.port) >= 10000 ? 2 : (Number(listener.port) >= 1024 ? 1 : 0));
    const orderedListeners = (listenerInfo.listeners || [])
      .sort((a, b) => listenerRank(b) - listenerRank(a) || Number(b.port) - Number(a.port))
      .slice(0, DSH_LISTENER_MAX_PROBE);
    // B-33b9（PM 04:04 优化）：先探 3–5 个「最可疑」候选（≥10000 端口降序，DSH 55263 通常在前 3），
    // 命中即停；未命中再探其余监听端口。把冷启动命中从 ~1.7s 压到 ≤1.2s。
    let listenerProbeCount = 0;
    let probedListenerPorts = 0;
    let bestListener = null;
    const addListenerWave = async (list, concurrency, label) => {
      const wave = [];
      for (const listener of list) {
        const before = candidates.length;
        addCandidate(candidates, seen, listener.baseUrl, 'netstat-port', 4, 'netstat 监听 ' + listener.port + '（pid ' + listener.pid + '）', { pid: listener.pid });
        if (candidates.length > before) wave.push(candidates[candidates.length - 1]);
      }
      if (!wave.length || Date.now() >= deadline) return;
      const started = Date.now();
      const remain = Math.max(180, deadline - Date.now());
      const result = await probeCandidates(wave, Math.min(DSH_LISTENER_PROBE_TIMEOUT_MS, remain), concurrency, deadline);
      probes = probes.concat(result);
      listenerProbeCount += wave.length;
      probedListenerPorts += result.length;
      stats[label + 'Ms'] = Date.now() - started;
      stats[label + 'Count'] = wave.length;
      const picked = pickBestProbe(probes, savedBaseUrl);
      if (picked) bestListener = picked;
    };
    await addListenerWave(orderedListeners.slice(0, 4), 4, 'listenerTier1');
    if (!bestListener) {
      await addListenerWave(orderedListeners.slice(4), DSH_LISTENER_PROBE_CONCURRENCY, 'listenerTier2');
    }
    stats.listenerProbes = listenerProbeCount;
    stats.listenerSkipped = Math.max(0, orderedListeners.length - probedListenerPorts);
    best = bestListener;
    stats.listenerHit = Boolean(best && best.source === 'netstat-port');
    stats.listenerBudgetHit = Date.now() >= deadline;
    if (best) {
      // 命中即用 netstat 的 pid→端口 作为进程证据（AC⑤：不再报「dsh 进程=0 个」）。
      processInfo = processInfoFromListeners(listenerInfo, best);
      stats.processSkipped = true;
    } else if (!options.skipProcessDiscovery) {
      const processStarted = Date.now();
      try {
        processInfo = await collectDshProcessInfo({
          timeoutMs: Number(options.processTimeoutMs) > 0
            ? Number(options.processTimeoutMs)
            : Math.max(400, Math.min(1200, deadline - Date.now()))
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
      stats.processMs = Date.now() - processStarted;
    } else {
      stats.processSkipped = true;
    }
  }
  // 进程/netstat/默认端口候选只在权威源落空时才加（命中就完全不查进程）。
  if (!best) {
    for (const port of processInfo.argPorts || []) {
      addCandidate(candidates, seen, 'http://127.0.0.1:' + port, 'process-arg', 3, 'DSH 进程 --port');
    }
    for (const listener of processInfo.ports || []) {
      addCandidate(candidates, seen, listener.baseUrl, 'process-port', 4, 'pid ' + listener.pid + ' 监听 ' + listener.port);
    }
    for (const listener of (processInfo.listenerPorts || []).slice(0, DSH_DISCOVERY_MAX_LISTENERS)) {
      addCandidate(candidates, seen, listener.baseUrl, 'netstat-port', 5, 'netstat 监听 ' + listener.port + '（pid ' + listener.pid + '）');
    }
    addCandidate(candidates, seen, 'http://127.0.0.1:' + DSH_WEB_DEFAULT_PORT, 'default', 5, '默认端口');
  }
  let rangeProbed = false;
  let scan = null;
  const canProbeBeyond = !explicitBaseUrl && options.includeRange !== false;
  if (!best) {
    // 已探过的监听端口不重复探；只探进程参数/默认端口等新增候选。
    const wave1 = candidates.filter((candidate) => candidate.source !== 'netstat-port')
      .slice(0, Math.min(DSH_DISCOVERY_MAX_WAVE1, maxCandidates));
    if (wave1.length) {
      const waveStarted = Date.now();
      probes = probes.concat(await probeCandidates(wave1, probeTimeoutMs));
      stats.waveProbeMs = Date.now() - waveStarted;
      best = pickBestProbe(probes, savedBaseUrl);
    }
  }
  if (!best && canProbeBeyond) {
    rangeProbed = true;
    const before = candidates.length;
    addRangeCandidates(candidates, seen, savedBaseUrl, 3, maxCandidates);
    addRangeCandidates(candidates, seen, 'http://127.0.0.1:' + DSH_WEB_DEFAULT_PORT, 3, maxCandidates);
    const range = candidates.slice(before);
    if (range.length) {
      const rangeStarted = Date.now();
      const rangeProbes = await probeCandidates(range, probeTimeoutMs);
      probes = probes.concat(rangeProbes);
      stats.rangeProbeMs = Date.now() - rangeStarted;
      best = pickBestProbe(probes, savedBaseUrl);
    }
  }
  // B-33b9 AC①④：全段扫描（49152–65535）**默认关闭**，只保留显式 legacy 开关；
  // 生产路径改为「监听端口枚举 + 特征校验」，端口来源是 netstat 列表而非 1.6 万个端口。
  if (!best && canProbeBeyond && options.includeScan === true) {
    // d637：优先扫「历史端口 ±16」（上次保存/env/端口文件/默认端口），再退全段（倒序）。
    const priorityPorts = [];
    const pushAround = (basePort) => {
      const port = Number(basePort) || 0;
      if (!(port > 0)) return;
      for (let delta = -DSH_SCAN_PRIORITY_SPAN; delta <= DSH_SCAN_PRIORITY_SPAN; delta += 1) {
        const p = port + delta;
        if (p >= scanStart && p <= scanEnd && !priorityPorts.includes(p)) priorityPorts.push(p);
      }
    };
    const portOfBaseUrl = (baseUrl) => { try { return Number(new URL(normalizeLocalBaseUrl(baseUrl)).port) || 0; } catch { return 0; } };
    pushAround(portOfBaseUrl(savedBaseUrl));
    if (env && env.DSH_WEB_URL) pushAround(portOfBaseUrl(env.DSH_WEB_URL));
    for (const entry of portFiles) pushAround(entry.port);
    pushAround(DSH_WEB_DEFAULT_PORT);
    stats.scanAttempts += 1;
    try {
      scan = await scanLocalPortRange({
        start: scanStart,
        end: scanEnd,
        priorityPorts,
        concurrency: Number(options.scanConcurrency) > 0 ? Number(options.scanConcurrency) : undefined,
        timeoutMs: Number(options.scanConnectTimeoutMs) > 0 ? Number(options.scanConnectTimeoutMs) : undefined,
        budgetMs: Number(options.scanBudgetMs) > 0 ? Number(options.scanBudgetMs) : undefined
      });
    } catch (error) {
      scan = { ok: false, code: 'DSH_SCAN_FAILED', ports: [], error: String(error && error.message || error).slice(0, 160) };
    }
    stats.scanPorts = Number(scan && scan.scannedPorts) || 0;
    stats.scanElapsedMs = Number(scan && scan.elapsedMs) || 0;
    stats.scanConcurrency = Number(scan && scan.concurrency) || 0;
    stats.scanConnectTimeoutMs = Number(scan && scan.connectTimeoutMs) || 0;
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
    identified: Boolean(processInfo.identified),
    form: String(processInfo.form || ''),
    message: String(processInfo.message || ''),
    ports: (processInfo.ports || []).map((listener) => listener.port),
    argPorts: (processInfo.argPorts || []).slice(),
    listenerPorts: (processInfo.listenerPorts || []).map((listener) => listener.port),
    error: 'error' in processInfo ? String(processInfo.error || '').slice(0, 240) : ''
  };
  // B-33b9 AC⑤：监听端口是 pid→端口的权威证据（Electron 形态也能命中）。
  const listenerSummary = (listenerInfo.listeners || []).map((listener) => ({ port: listener.port, pid: listener.pid, baseUrl: listener.baseUrl })).slice(0, DSH_DISCOVERY_MAX_LISTENERS);
  const processDiscovery = {
    ...processSummary,
    listenerCount: listenerSummary.length,
    netstatOk: Boolean(listenerInfo.ok),
    netstatError: String(listenerInfo.error || '').slice(0, 200)
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
      process: processSummary, processDiscovery, listeners: listenerSummary,
      portFiles: portFileSummary, portFileReadout,
      probedPorts: probes.map((p) => p.port).filter((p) => Number.isInteger(p) && p > 0),
      shouldPersist: true,
      rangeProbed, scan,
      stats,
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
      processDiscovery,
      listeners: listenerSummary,
      portFiles: portFileSummary,
      rangeProbed,
      scan,
      stats,
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
      processDiscovery,
      listeners: listenerSummary,
      portFiles: portFileSummary,
      rangeProbed,
      scan,
      stats,
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
      processDiscovery,
      listeners: listenerSummary,
      portFiles: portFileSummary,
      rangeProbed,
      scan,
      stats,
      durationMs: Date.now() - started
    };
  }

  // B-0cbc（PM ②）：已探测端口必须**如实全列**（旧实现 slice(0,8) 导致「说 18 个只列 6 个」）。
  const probedSorted = Array.from(new Set(probedPorts)).sort((a, b) => a - b);
  const listedPorts = probedSorted.map((port) => '127.0.0.1:' + port).join('、');
  const listenerCount = listenerSummary.length;
  const checkedCount = portFileReadout.length;
  const existedCount = portFileReadout.filter((row) => row.exists).length;
  const portFileReadoutText = checkedCount
    ? '端口文件 查了 ' + checkedCount + ' 个（存在 ' + existedCount + ' 个）'
      + (existedCount ? '：' + portFileReadout.filter((row) => row.exists).map((row) => row.file + '=' + (row.port || row.note)).join('；') : '；全部缺失')
    : '端口文件（已跳过）';
  // B-33b9 AC⑤⑥：不再出现「dsh 进程=0 个」；进程形态由 netstat 的 pid→端口 证据给出。
  const processReadout = processSummary.identified
    ? '进程识别：已从 netstat 定位 DSH（pid ' + (processSummary.ports || []).join('/') + '，形态 ' + (processSummary.form || 'Electron') + '）'
    : '进程识别：未能识别 DSH 进程（形态：' + (processSummary.form || '未知') + '），netstat 监听端口 ' + listenerCount + ' 个';
  const details = [];
  if (probedSorted.length) details.push('已探测 ' + probedSorted.length + ' 个本机端口（' + listedPorts + '），均未返回 DSH 特征');
  if (listenerInfo.ok) details.push('监听端口枚举：' + listenerCount + ' 个（耗时 ' + stats.listenerMs + 'ms，探测 ' + stats.listenerProbes + ' 个）');
  else details.push('监听端口枚举失败：' + String(listenerInfo.error || 'netstat 不可用').slice(0, 160));
  details.push('来源读数：' + [
    'DSH_WEB_URL=' + (env && env.DSH_WEB_URL ? String(env.DSH_WEB_URL) : '（未设）'),
    'DSH_WEB_PORT=' + (env && env.DSH_WEB_PORT ? String(env.DSH_WEB_PORT) : '（未设）'),
    'DSH_PORT=' + (env && env.DSH_PORT ? String(env.DSH_PORT) : '（未设）'),
  ].join('；') + '；' + portFileReadoutText + '；dsh.json 上次地址=' + (savedBaseUrl || '（无）') + '；' + processReadout
    + (processSummary.argPorts && processSummary.argPorts.length ? '（--port ' + processSummary.argPorts.join('/') + '）' : ''));
  if (scan && Array.isArray(scan.ports)) {
    details.push(scan.ports.length
      ? '扫描 ' + scanStart + '–' + scanEnd + ' 有 ' + scan.ports.length + ' 个端口在监听但都不是 DSH'
      : '扫描 ' + scanStart + '–' + scanEnd + ' 没有发现监听端口');
  }
  if (portFiles.length) details.push('端口文件写了 ' + portFiles.map((entry) => entry.port).join('/') + '，均不可用');
  // AC⑥：失败时人话三段式（默认视图 ≤3 行），技术明细留在 details/--json。
  const lastKnownBaseUrl = savedBaseUrl || explicitBaseUrl || '';
  const line1 = listenerInfo.ok
    ? '已检查 ' + listenerCount + ' 个监听端口，命中 0'
    : '已检查 0 个监听端口（netstat 不可用：' + String(listenerInfo.error || '未知错误').slice(0, 60) + '）';
  const line2 = lastKnownBaseUrl
    ? '最近一次地址 ' + lastKnownBaseUrl + ' 现在不通'
    : '没有可用的上次地址';
  const nextHints = [];
  if (portFiles.length) nextHints.push('先试端口文件里写过的 ' + portFiles.map((entry) => 'http://127.0.0.1:' + entry.port).join('、'));
  if (listenerCount) nextHints.push('在「设置 → 诊断」里从本机 ' + listenerCount + ' 个监听端口中选 DSH 的真实端口');
  nextHints.push('重启 DSH 后点「手动重新发现」，或把 DSH 地址填到 工作台 → 设置 → DSH 外部地址 后保存');
  const line3 = '下一步：' + nextHints.slice(0, 2).join('；');
  const diagnosticLines = [line1, line2, line3];
  const message = line1 + '；' + line2 + '；' + line3 + '。技术明细见 --json / 诊断展开区';
  // P0-2：发现失败时把命令候选路径+存在性写进可读原因（ENOENT 可诊断）。
  const diag = processInfo.diagnostics || {};
  try {
    const att = Array.isArray(diag.commandAttempts) ? diag.commandAttempts : [];
    const parts = [];
    for (const row of att.slice(-6)) parts.push(String(row.file) + "（存在=" + String(row.exists) + "）");
    if (parts.length) details.push('诊断：' + parts.join('；'));
    else if (diag.processes && diag.processes.error) details.push('诊断：' + String(diag.processes.error));
  } catch { /* 诊断失败不阻断 */ }
  return {
    ok: false,
    state: 'failed',
    code: 'DSH_NOT_FOUND',
    message,
    diagnosticLines,
    details,
    baseUrl: '',
    source: '',
    explicitBaseUrl: '',
    savedBaseUrl,
    candidates,
    probes,
    valid: validDistinct,
    process: processSummary,
    processDiscovery,
    listeners: listenerSummary,
    portFiles: portFileSummary,
    portFileReadout,
    // B-0cbc（PM ②⑤）：失败结果也带完整端口清单，界面/夹具与文案同源对账。
    probedPorts: probedSorted,
    rangeProbed,
    scan,
    stats,
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
  listWindowsListeners,
  collectDshProcessInfo,
  processInfoFromListeners,
  DSH_LISTENER_PROBE_CONCURRENCY,
  DSH_LISTENER_PROBE_TIMEOUT_MS,
  DSH_LISTENER_BUDGET_MS,
  DSH_WEB_DEFAULT_PORT,
  DSH_SCAN_DEFAULT_START,
  DSH_SCAN_DEFAULT_END,
  getCommandAttempts,
  resetCommandAttempts
};
