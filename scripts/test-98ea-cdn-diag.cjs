#!/usr/bin/env node
'use strict';
/**
 * test-98ea-cdn-diag.cjs —— B-20261121-004458-98ea（P3）release-verify 的 CDN 诊断分类夹具
 *
 * A. 纯分类：ENOTFOUND/ECONNRESET/ETIMEDOUT/CERT/带跳转链的失败 → 各自 category + hint
 * B. 只比内容：HTTP 404 → CDN_HTTP_ERROR；空 body → CDN_BAD_RESPONSE；sha 不同 → CDN_SHA_MISMATCH；一致 → ok
 * C. 真断面：本地 mock CDN 301 → 不可达 port（模拟 jsDelivr→raw.githubusercontent 被拦）
 *    → httpGetWithRedirects 抛错且带 redirects；分类必须是 CDN_REDIRECT_BLOCKED + 提示里能看到 raw/代理
 * D. 真断面：mock 200 + 正确字节 → cdnVerdict ok；mock 200 + 同长度不同字节 → CDN_SHA_MISMATCH（同 size 换内容）
 *
 * 用法：node scripts/test-98ea-cdn-diag.cjs [--json]
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const net = require('node:net');
const crypto = require('node:crypto');
const ROOT = path.resolve(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');
const { cdnVerdict, classifyNetworkError, httpGetWithRedirects } = require(path.join(ROOT, 'scripts', 'cdn-diagnose.cjs'));
const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
function err(message, code) { const e = new Error(message); if (code) e.code = code; return e; }
async function freePort() {
  return new Promise((resolve) => {
    const s = net.createServer();
    s.once('error', () => resolve(0));
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => resolve(p)); });
  });
}
function serve(handler) {
  return new Promise((resolve) => {
    const server = http.createServer(handler);
    server.on('error', () => resolve(null));
    server.listen(0, '127.0.0.1', () => resolve(server));
  });
}

function unitSection() {
  const cases = [
    ['ENOTFOUND 原生 DNS 失败', err('getaddrinfo ENOTFOUND cdn.jsdelivr.net', 'ENOTFOUND'), {}, 'CDN_DNS_FAILED'],
    ['ECONNRESET 直连失败', err('read ECONNRESET', 'ECONNRESET'), {}, 'CDN_NETWORK_BLOCKED'],
    ['HTTP_TIMEOUT', err('HTTP_TIMEOUT'), {}, 'CDN_TIMEOUT'],
    ['CERT 失败', err('unable to verify the first certificate', 'UNABLE_TO_VERIFY_LEAF_SIGNATURE'), {}, 'CDN_TLS_FAILED'],
    ['跳转后 ECONNRESET → REDIRECT_BLOCKED', err('read ECONNRESET', 'ECONNRESET'), { stage: 'redirect', redirects: [{ from: 'https://cdn.jsdelivr.net/x', status: 301, to: 'https://raw.githubusercontent.com/y' }] }, 'CDN_REDIRECT_BLOCKED'],
  ];
  for (const [name, e, opts, want] of cases) {
    const got = classifyNetworkError(e, opts);
    check('A ' + name + ' → ' + want + '（hint 非空）', got.category === want && Boolean(got.hint), got);
  }
  check('A6 内容不一致不走网络分类（同大小不同内容 → CDN_SHA_MISMATCH）',
    cdnVerdict({ status: 200, bodyLength: 4096, localSha: sha(Buffer.from('A'.repeat(4096))), downloadedSha: sha(Buffer.from('B'.repeat(4096))) }).category === 'CDN_SHA_MISMATCH', {});
  check('A7 404 → CDN_HTTP_ERROR', cdnVerdict({ status: 404, bodyLength: 120, localSha: 'x', downloadedSha: 'y' }).category === 'CDN_HTTP_ERROR', {});
  check('A8 空 body → CDN_BAD_RESPONSE', cdnVerdict({ status: 200, bodyLength: 0, localSha: 'x', downloadedSha: '' }).category === 'CDN_BAD_RESPONSE', {});
  check('A9 成功 → CDN_OK', cdnVerdict({ status: 200, bodyLength: 10, localSha: 'x', downloadedSha: 'x' }).ok === true, {});
}

async function liveSection() {
  const body = Buffer.from('PK-FAKE-CDN-BODY-98EA');
  const goodSha = sha(body);
  const closedPort = await freePort();
  // C：301 → 不可达端口
  const redirectServer = await serve((req, res) => {
    res.writeHead(301, { location: `http://127.0.0.1:${closedPort}/raw.zip` });
    res.end();
  });
  if (redirectServer) {
    const port = redirectServer.address().port;
    let caught = null;
    try {
      await httpGetWithRedirects(`http://127.0.0.1:${port}/cdn.zip`, { timeout: 4000 });
    } catch (e) { caught = e; }
    check('C1 301→不可达：抛错且带 redirects 链', Boolean(caught) && Array.isArray(caught.redirects) && caught.redirects.length === 1, { error: caught && String(caught.message), redirects: caught && caught.redirects });
    const diag = cdnVerdict({ error: caught || new Error('missing'), redirects: (caught && caught.redirects) || [] });
    check('C2 分类必须是 CDN_REDIRECT_BLOCKED（不是裸 ECONNRESET）', diag.category === 'CDN_REDIRECT_BLOCKED', diag);
    check('C3 提示含 raw.githubusercontent 与代理/网络说明', /raw\.githubusercontent/.test(diag.hint) && /代理|网络/.test(diag.hint), { hint: diag.hint });
    await new Promise((r) => redirectServer.close(r));
  } else {
    check('C0 mock 重定向服务启动', false, {});
  }

  // D：200 正确内容 / 同大小不同内容
  const okServer = await serve((req, res) => { res.writeHead(200, { 'content-type': 'application/zip' }); res.end(body); });
  if (okServer) {
    const port = okServer.address().port;
    const res = await httpGetWithRedirects(`http://127.0.0.1:${port}/pm-workbench-x.zip`, { timeout: 4000 });
    const diag = cdnVerdict({ status: res.status, bodyLength: res.body.length, localSha: goodSha, downloadedSha: sha(res.body), redirects: res.redirects });
    check('D1 200 + 正确字节 → CDN_OK', diag.ok === true, diag);
    const badDiag = cdnVerdict({ status: 200, bodyLength: body.length, localSha: sha(Buffer.from('X'.repeat(body.length))), downloadedSha: sha(res.body) });
    check('D2 同长度不同内容 → CDN_SHA_MISMATCH（内容问题不当网络问题重试）', badDiag.category === 'CDN_SHA_MISMATCH', badDiag);
    await new Promise((r) => okServer.close(r));
  } else {
    check('D0 mock 200 服务启动', false, {});
  }
}

(async () => {
  unitSection();
  await liveSection();
  const failed = ROWS.filter((r) => !r.ok).length;
  if (JSON_OUT) console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed, failed: ROWS.filter((r) => !r.ok).map((r) => r.name), rows: ROWS }, null, 2));
  else console.log(`\n${ROWS.length - failed}/${ROWS.length} PASS${failed ? ' · ' + failed + ' FAIL' : ''}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FIXTURE_FAILED', String((e && e.stack) || e)); process.exit(2); });
