'use strict';
/**
 * e379：DSH 互通能力探针（只读）
 *
 * 目的：安装/首启后确认「本机 DSH 是否支持只读 session/list」——这是团队角色会话可被
 * 工作台驱动的前提。探测结果落 `data/dsh-capability.json`，并在主进程日志打印一句
 * 「DSH 互通能力：有/无」，缺能力时提示升级 DSH，而不是静默失败。
 *
 * 字段（与需求 ③ 对齐）：{ok, method, httpStatus, sessionsCount, dshVersion, at, error?}
 */
const fs = require('node:fs');
const path = require('node:path');

const CAPABILITY_FILE = 'dsh-capability.json';
const METHOD = 'session/list';

function capabilityPath(dataDir) {
  return path.join(String(dataDir || ''), CAPABILITY_FILE);
}

function writeCapability(dataDir, record) {
  const target = capabilityPath(dataDir);
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

function readCapability(dataDir) {
  try {
    const raw = fs.readFileSync(capabilityPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 朴素的只读 HTTP GET（不用全局 fetch：主进程里 Electron/undici 的 fetch 在部分环境
 * 会出现「status=200 但 body 读空」，版本探测不能因此静默留空）。
 * 返回 {status, body, error}，永不抛错。
 */
function httpGetText(url, options = {}) {
  const timeoutMs = Number(options.timeoutMs) > 0 ? Number(options.timeoutMs) : 3000;
  const maxBytes = Number(options.maxBytes) > 0 ? Number(options.maxBytes) : 2 * 1024 * 1024;
  const headers = { accept: 'text/html,application/xhtml+xml', connection: 'close' };
  if (options.cookie) headers.cookie = String(options.cookie);
  return new Promise((resolve) => {
    let settled = false;
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      resolve(payload);
    };
    let lib;
    try {
      lib = new URL(url).protocol === 'https:' ? require('node:https') : require('node:http');
    } catch (error) {
      finish({ status: 0, body: '', error: 'URL 非法：' + String((error && error.message) || error).slice(0, 80) });
      return;
    }
    let request;
    try {
      request = lib.get(url, { headers }, (response) => {
        const chunks = [];
        let size = 0;
        response.on('data', (chunk) => {
          size += chunk.length;
          if (size <= maxBytes) chunks.push(chunk);
        });
        response.on('end', () => {
          finish({ status: Number(response.statusCode) || 0, body: Buffer.concat(chunks).toString('utf8'), error: null });
        });
        response.on('error', (error) => finish({ status: Number(response.statusCode) || 0, body: '', error: String((error && error.message) || error) }));
      });
    } catch (error) {
      finish({ status: 0, body: '', error: String((error && error.message) || error) });
      return;
    }
    request.setTimeout(timeoutMs, () => {
      try { request.destroy(new Error('timeout')); } catch { /* ignore */ }
      finish({ status: 0, body: '', error: 'timeout' });
    });
    request.on('error', (error) => finish({ status: 0, body: '', error: String((error && error.message) || error) }));
  });
}

/**
 * e379 AC7③：从 DSH 实际取版本号（不写死）。
 *
 * 来源优先级：
 *   1) DSH Web 页面 `window.__DSH_BOOT__` 里的 `release:{version,commit}`（本机实测 DSH 0.2.2-rc.3 有此项）；
 *   2) 兼容个别构建把版本放在别处的 `"version":"x.y.z"`（取第一个语义化版本）。
 * 失败只返回 error，**不抛错**、不阻断探针（AC7②要求失败不阻断启动）。
 *
 * @param {{baseUrl?:string, cookie?:{name:string,value:string}|string, timeoutMs?:number}} opts
 */
async function detectDshVersion(opts = {}) {
  const baseUrl = String(opts.baseUrl || '').replace(/\/+$/, '');
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 3000;
  if (!baseUrl) return { version: '', commit: '', source: '', error: 'DSH 地址未配置' };
  let cookieHeader = '';
  if (opts.cookie && typeof opts.cookie === 'object' && opts.cookie.name) {
    cookieHeader = String(opts.cookie.name) + '=' + String(opts.cookie.value);
  } else if (typeof opts.cookie === 'string') {
    cookieHeader = opts.cookie;
  }
  const page = await httpGetText(baseUrl + '/', { cookie: cookieHeader, timeoutMs });
  if (page.error) {
    return {
      version: '',
      commit: '',
      source: '',
      error: (page.error === 'timeout' ? '读取 DSH 版本超时' : '读取 DSH 版本失败：') + String(page.error).slice(0, 120)
    };
  }
  const html = String(page.body || '');
  const release = /"release"\s*:\s*\{([^}]*)\}/.exec(html);
  if (release) {
    const version = /"version"\s*:\s*"([^"]{1,40})"/.exec(release[1]);
    const commit = /"commit"\s*:\s*"([^"]{1,40})"/.exec(release[1]);
    if (version) {
      return { version: version[1], commit: commit ? commit[1] : '', source: 'page-release', status: page.status };
    }
  }
  const loose = /"version"\s*:\s*"(\d[0-9A-Za-z.\-]{1,30})"/.exec(html);
  if (loose) return { version: loose[1], commit: '', source: 'page-version', status: page.status };
  return {
    version: '',
    commit: '',
    source: '',
    status: page.status,
    error: page.status === 200
      ? 'DSH 页面未找到版本号（release.version；正文 ' + html.length + ' 字'
        + (cookieHeader ? '' : '；未带登录 cookie') + '）'
      : 'DSH 页面 HTTP ' + page.status
  };
}

/** 从适配器安全取 webCookie（未配置/无凭据时返回 null，不抛）。 */
function safeWebCookie(adapter) {
  try {
    if (!adapter || typeof adapter.webCookie !== 'function') return null;
    const cookie = adapter.webCookie();
    return cookie && cookie.name ? cookie : null;
  } catch {
    return null;
  }
}

/**
 * 探测一次并落盘。永不抛错：失败也写 {ok:false,error}，供面板/诊断读取。
 * @param {{adapter:{listSessions:Function,baseUrl?:string,webCookie?:Function}, dataDir:string, timeoutMs?:number, dshVersion?:string, detectVersion?:boolean}} opts
 */
async function probeDshCapability(opts = {}) {
  const adapter = opts.adapter;
  const dataDir = String(opts.dataDir || '');
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 8000;
  const at = new Date().toISOString();
  const base = {
    ok: false,
    method: METHOD,
    httpStatus: null,
    sessionsCount: 0,
    dshVersion: String(opts.dshVersion || ''),
    dshVersionSource: '',
    dshVersionError: null,
    at,
    error: null,
  };
  // e379 AC7③：dshVersion 从 DSH 实际取（页面 release.version）；取不到留空并记 dshVersionError。
  let versionInfo = { version: base.dshVersion, commit: '', source: base.dshVersion ? 'provided' : '', error: null };
  if (!versionInfo.version && adapter && adapter.baseUrl) {
    versionInfo = await detectDshVersion({
      baseUrl: adapter.baseUrl,
      cookie: safeWebCookie(adapter),
      timeoutMs: Math.min(timeoutMs, 5000)
    });
  }
  const versionFields = {
    dshVersion: String(versionInfo.version || ''),
    dshVersionSource: String(versionInfo.source || ''),
    dshVersionError: versionInfo.error ? String(versionInfo.error).slice(0, 200) : null,
    ...(versionInfo.commit ? { dshCommit: String(versionInfo.commit) } : {})
  };
  let record;
  try {
    if (!adapter || typeof adapter.listSessions !== 'function') {
      record = { ...base, ...versionFields, error: 'DSH 适配器未就绪（无法调用 session/list）' };
    } else {
      const items = await adapter.listSessions({ timeoutMs });
      record = {
        ...base,
        ...versionFields,
        ok: true,
        httpStatus: 200,
        sessionsCount: Array.isArray(items) ? items.length : 0,
      };
    }
  } catch (e) {
    record = {
      ...base,
      ...versionFields,
      httpStatus: Number(e && e.httpStatus) > 0 ? Number(e.httpStatus) : null,
      error: String((e && e.message) || e || 'DSH_NOT_AVAILABLE').slice(0, 300),
    };
  }
  if (dataDir) writeCapability(dataDir, record);
  return record;
}

/** 供日志/简报使用的一句话摘要。 */
function capabilityLine(record) {
  if (!record) return 'DSH 互通能力：未知（尚未探测）';
  const version = String(record.dshVersion || '').trim();
  const versionText = version ? '，DSH ' + version : '';
  if (record.ok) {
    return `DSH 互通能力：有（${METHOD} 返回 ${record.sessionsCount} 个会话${versionText}）`;
  }
  const why = String(record.error || '未知原因').slice(0, 120);
  return `DSH 互通能力：无（${why}${versionText}）；请升级 DSH 到支持只读 ${METHOD} 的版本`;
}

module.exports = {
  CAPABILITY_FILE,
  METHOD,
  capabilityPath,
  writeCapability,
  readCapability,
  detectDshVersion,
  probeDshCapability,
  capabilityLine,
};
