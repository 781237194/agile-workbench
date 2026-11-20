'use strict';
/**
 * 98ea：CDN 诊断分类（纯函数 + 带重定向链的 https 下载），供 release-verify C4 使用与夹具直测。
 */
const https = require('node:https');
const http = require('node:http');

const CDN_HINTS = {
  CDN_DNS_FAIL: 'DNS 解析失败：检查本机 DNS/代理；企业网常见于 raw.githubusercontent.com 被拦。可改用镜像或设置 HTTPS_PROXY，或先 --skip-cdn 并记录原因。',
  CDN_REDIRECT_UNREACHABLE: 'CDN 301 跳转到 raw.githubusercontent.com 后不可达（跳转链见 redirects）：多为网络/代理限制；设置 HTTPS_PROXY 或在能访问 GitHub raw 的网络重试，或 --skip-cdn 并记录原因。',
  CDN_NETWORK_BLOCKED: '连接被重置/拒绝（ECONNRESET/ECONNREFUSED）：多为网络策略或本地代理未生效；检查代理与防火墙后重试。',
  CDN_TLS_FAILED: 'TLS 证书校验失败：检查系统时间、根证书或企业代理的中间人证书；不要用 --insecure 绕过发版校验。',
  CDN_TIMEOUT: 'CDN 下载超时：网络慢或被限速；可稍后重试或改用镜像（jsDelivr 回源 raw.githubusercontent 可能很慢）。',
  CDN_HTTP_ERROR: 'CDN 返回非 200：先确认版本 tag 存在、路径 URL 编码正确；404 时检查 发布/pm-workbench-<版本>.zip 是否已提交并打 tag。',
  CDN_SHA_MISMATCH: 'CDN 下载到的包与本地 sha256 不一致：不是网络问题——包内容不一致（缓存/旧 tag/被篡改），必须查清来源，不要重试掩盖。',
  CDN_BAD_RESPONSE: 'CDN 返回空响应/非 zip：多为错误页被当成包；检查 URL 与镜像配置。',
  CDN_OK: '',
};

function classifyNetworkError(error, { stage = '', redirects = [] } = {}) {
  const message = String((error && error.message) || error || '');
  const code = String((error && error.code) || '') || (/HTTP_TIMEOUT/.test(message) ? 'HTTP_TIMEOUT' : '');
  let category = 'CDN_NETWORK_BLOCKED';
  if (/HTTP_TIMEOUT|ETIMEDOUT|timed? ?out/i.test(message) || code === 'ETIMEDOUT') category = 'CDN_TIMEOUT';
  else if (/ENOTFOUND|EAI_AGAIN|getaddrinfo/i.test(message + ' ' + code)) category = 'CDN_DNS_FAIL';
  else if (/CERT|SSL|TLS|SELF_SIGNED|UNABLE_TO_VERIFY/i.test(message + ' ' + code)) category = 'CDN_TLS_FAILED';
  else if (/ECONNRESET|ECONNREFUSED|EPIPE|EHOSTUNREACH|ENETUNREACH|socket hang up/i.test(message + ' ' + code)) category = 'CDN_NETWORK_BLOCKED';
  if (stage === 'redirect' && (category === 'CDN_NETWORK_BLOCKED' || category === 'CDN_TIMEOUT' || category === 'CDN_DNS_FAIL')) {
    category = 'CDN_REDIRECT_UNREACHABLE';
  }
  return { category, code: code || category, hint: CDN_HINTS[category] || '', detail: { stage, redirects: redirects.slice(0, 8), message: message.slice(0, 300) } };
}

function cdnVerdict({ status = 0, bodyLength = 0, localSha = '', downloadedSha = '', redirects = [], error = null } = {}) {
  if (error) {
    const cls = classifyNetworkError(error, { stage: redirects.length ? 'redirect' : 'request', redirects });
    return { ok: false, ...cls };
  }
  if (status < 200 || status >= 300) {
    return { ok: false, category: 'CDN_HTTP_ERROR', code: 'CDN_HTTP_' + status, hint: CDN_HINTS.CDN_HTTP_ERROR, detail: { status, redirects: redirects.slice(0, 8) } };
  }
  if (!bodyLength) {
    return { ok: false, category: 'CDN_BAD_RESPONSE', code: 'CDN_EMPTY_BODY', hint: CDN_HINTS.CDN_BAD_RESPONSE, detail: { status, redirects: redirects.slice(0, 8) } };
  }
  if (!localSha || !downloadedSha) {
    return { ok: false, category: 'CDN_BAD_RESPONSE', code: 'CDN_SHA_UNAVAILABLE', hint: CDN_HINTS.CDN_BAD_RESPONSE, detail: { status } };
  }
  if (downloadedSha !== localSha) {
    return { ok: false, category: 'CDN_SHA_MISMATCH', code: 'CDN_SHA_MISMATCH', hint: CDN_HINTS.CDN_SHA_MISMATCH, detail: { status, localSha, downloadedSha } };
  }
  return { ok: true, category: 'CDN_OK', code: '', hint: '', detail: { status, downloadedSha } };
}

/** 带重定向链的 GET（记录 301/302 目标，便于把 raw.githubusercontent 这类跳转失败分类出来）。 */
function httpGetWithRedirects(url, { headers = {}, timeout = 45000, follow = 5 } = {}) {
  const redirects = [];
  const once = (target, left) => new Promise((resolve, reject) => {
    // 生产只走 https；夹具用本地 http mock 模拟 301→不可达，所以按协议选模块。
    const mod = String(target).startsWith('http://') ? http : https;
    let req;
    try {
      req = mod.get(target, { headers }, (res) => {
        if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && left > 0) {
          res.resume();
          const next = new URL(res.headers.location, target).toString();
          redirects.push({ from: target, status: res.statusCode, to: next });
          resolve(once(next, left - 1));
          return;
        }
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers, redirects: redirects.slice() }));
      });
    } catch (error) {
      error.redirects = redirects.slice();
      reject(error);
      return;
    }
    req.on('error', (error) => { error.redirects = redirects.slice(); reject(error); });
    req.setTimeout(timeout, () => { const error = new Error('HTTP_TIMEOUT'); error.code = 'HTTP_TIMEOUT'; error.redirects = redirects.slice(); req.destroy(error); });
  });
  return once(url, follow);
}

/**
 * --cdn-fallback github（PM 015009）：CDN 不可达时用 GitHub Release asset 的 sha 作替代校验。
 * 绝不「静默当 PASS」：返回 category=CDN_FALLBACK_GITHUB + 明确 hint，调用方必须把 fallback 打进 C4/C7 detail。
 */
function cdnFallbackVerdict({ cdn = null, fallback = '', githubSha = '', localSha = '' } = {}) {
  if (String(fallback) !== 'github') {
    return { ok: false, category: 'CDN_NO_FALLBACK', code: 'CDN_FALLBACK_UNSUPPORTED', hint: 'CDN 失败且未指定 --cdn-fallback github（不会静默当 PASS）。', detail: { cdnCategory: cdn && cdn.category } };
  }
  if (!githubSha) {
    return { ok: false, category: 'CDN_NO_FALLBACK', code: 'CDN_FALLBACK_UNAVAILABLE', hint: 'CDN 失败，GitHub asset 也没有可用 sha（先确认 C3 通过）。', detail: { cdnCategory: cdn && cdn.category } };
  }
  if (!localSha || githubSha !== localSha) {
    return { ok: false, category: 'CDN_SHA_MISMATCH', code: 'CDN_FALLBACK_SHA_MISMATCH', hint: '回退 GitHub asset 后 sha 仍与本地不一致：内容问题，不要重试掩盖。', detail: { githubSha, localSha } };
  }
  return {
    ok: true,
    category: 'CDN_FALLBACK_GITHUB',
    code: 'CDN_FALLBACK_OK',
    hint: 'CDN 不可达，已按 --cdn-fallback github 改用 Release asset 校验（CDN 渠道本身未验证，必须在发布记录里写明原因）。',
    detail: { cdnCategory: cdn && cdn.category, cdnCode: cdn && cdn.code, githubSha, localSha },
  };
}

module.exports = { CDN_HINTS, classifyNetworkError, cdnVerdict, cdnFallbackVerdict, httpGetWithRedirects };
