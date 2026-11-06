// DSH 会话小客户端：用桌面版浏览器会话 cookie 调 /api/session/*
// 仅本机回环；密钥只从 ~/.dsh/.credentials.yaml 读，不打印。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';

function b64url(v) {
  return Buffer.from(v).toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function dshHome() {
  return process.env.DSH_HOME || path.join(os.homedir(), '.dsh');
}

function readSecret() {
  const raw = fs.readFileSync(path.join(dshHome(), '.credentials.yaml'), 'utf8');
  const m = /client-connection\/browser-session[\s\S]{0,300}?secret:\s*([A-Za-z0-9_-]{43})/.exec(raw);
  if (!m) throw new Error('找不到 browser-session secret（.credentials.yaml）');
  return m[1];
}

function mintCookie(authority, secret) {
  const name = 'dsh-auth-' + b64url(crypto.createHash('sha256').update(authority).digest());
  const now = Date.now();
  const body = b64url(JSON.stringify({ version: 1, authority, issuedAt: now, expiresAt: now + 30 * 86400000 }));
  const key = Buffer.from(String(secret).replace(/-/g, '+').replace(/_/g, '/'), 'base64');
  const sig = b64url(crypto.createHmac('sha256', key).update(body).digest());
  return { name, value: 'v1.' + body + '.' + sig };
}

function baseUrl() {
  const env = process.env.DSH_WEB_URL || '';
  if (env) return env.replace(/\/+$/, '');
  throw new Error('没有 DSH_WEB_URL；请在 DSH 会话里运行，或设 DSH_WEB_URL=http://127.0.0.1:<port>');
}

export class DshClient {
  constructor(base = baseUrl()) {
    const u = new URL(base);
    this.base = u.origin;
    this.authority = u.host;
    this.cookie = mintCookie(this.authority, readSecret());
  }

  async rpc(method, args = {}) {
    const rpcId = crypto.randomUUID();
    const body = JSON.stringify({ type: 'client-request', rpcId, method, payload: { args } });
    const res = await fetch(`${this.base}/api/${method}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', cookie: `${this.cookie.name}=${this.cookie.value}` },
      body,
    });
    const text = await res.text();
    if (!res.ok) throw new Error(`HTTP ${res.status} ${method}: ${text.slice(0, 300)}`);
    let json;
    try { json = JSON.parse(text); } catch { throw new Error(`非 JSON 响应 ${method}: ${text.slice(0, 200)}`); }
    if (json.type !== 'server-response' || json.rpcId !== rpcId) throw new Error(`响应信封不匹配 ${method}`);
    const r = json.result;
    if (!r || r.ok !== true) {
      const err = r && r.error ? r.error : r;
      const e = new Error(`RPC ${method} 失败：${err && err.message ? err.message : JSON.stringify(err)}`);
      e.code = err && err.code;
      e.details = err && err.details;
      throw e;
    }
    return r.value;
  }

  list() { return this.rpc('session/list', { _request: {} }); }
  create({ cwd, workspaceId, agentPreset, sessionId } = {}) {
    if (cwd && workspaceId) throw new Error('session.create 只能传 cwd 或 workspaceId 之一');
    return this.rpc('session/create', {
      request: {
        ...(cwd ? { cwd } : {}),
        ...(workspaceId ? { workspaceId } : {}),
        ...(agentPreset ? { agentPreset } : {}),
        ...(sessionId ? { sessionId } : {}),
      },
    });
  }
  workspaceCreate({ path }) {
    if (!path) throw new Error('workspace.create 需要目录 path');
    return this.rpc('workspace/create', { request: { path } });
  }
  workspaceArchiveSession({ sessionId, stopActivity = false } = {}) {
    if (!sessionId) throw new Error('workspace.archiveSession 需要 sessionId');
    return this.rpc('workspace/archiveSession', { request: { sessionId, stopActivity: Boolean(stopActivity) } });
  }
  workspaceUnarchiveSession({ sessionId } = {}) {
    if (!sessionId) throw new Error('workspace.unarchiveSession 需要 sessionId');
    return this.rpc('workspace/unarchiveSession', { request: { sessionId } });
  }
  modelCatalog() { return this.rpc('session/modelCatalog', {}); }
  selectModel({ sessionId, provider, model, reasoningEffort }) {
    return this.rpc('session/selectModel', {
      request: {
        sessionId, provider, model,
        ...(reasoningEffort ? { reasoningEffort } : {}),
      },
    });
  }
  projections({ sessionId }) {
    return this.rpc('session/projections', { request: { sessionId } });
  }
  prompt({ sessionId, text, mode = 'queue', requestId = crypto.randomUUID() }) {
    return this.rpc('session/prompt', {
      request: {
        sessionId,
        content: [{ type: 'text', text }],
        mode,
        requestId,
      },
    });
  }
  rename({ sessionId, title }) { return this.rpc('session/rename', { request: { sessionId, title } }); }
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const cmd = args[0] || 'list';
  const c = new DshClient();
  const out = await (async () => {
    if (cmd === 'list') return c.list();
    if (cmd === 'create') return c.create({ cwd: args[1] || process.cwd() });
    if (cmd === 'prompt') return c.prompt({ sessionId: args[1], text: args.slice(2).join(' ') });
    throw new Error('用法：node dsh-session.mjs list|create [cwd]|prompt <sessionId> <text>');
  })();
  console.log(JSON.stringify(out, null, 2));
}
