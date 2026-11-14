#!/usr/bin/env node
// web-search-safe —— 安全版 Web Search / Fetch MCP server（stdio，零第三方依赖）。
//
// 随 dsh-pm-workbench 套装分发，默认由套装 cordis.patch.yml 的 mcp-web-search-safe 行启动。
// 只暴露两个只读工具：
//   - web_search：查网络用语/梗/事实性问题；默认走 Bing RSS，不把查询词发广告网络以外的地方。
//   - web_fetch ：只允许 http/https；禁 URL 内嵌凭据、禁 localhost/内网/链路本地地址，
//                 先做 DNS 解析并检查全部结果，手动跟随重定向（每一跳重校验），响应体按字节限量。
// 不暴露任何本地文件、命令执行、写操作。协议：MCP stdio（换行分隔 JSON-RPC 2.0）。
//
// 可用环境变量（都不含密钥）：
//   WEB_SEARCH_SAFE_TIMEOUT_MS  单次请求超时，默认 20000
//   WEB_SEARCH_SAFE_MAX_BYTES   单次响应上限，默认 524288
import dns from 'node:dns/promises';
import net from 'node:net';
import process from 'node:process';

const SERVER_NAME = 'web-search-safe';
const SERVER_VERSION = '1.0.0';
const PROTOCOL_VERSION = '2024-11-05';
const TIMEOUT_MS = Number(process.env.WEB_SEARCH_SAFE_TIMEOUT_MS || 20000);
const MAX_BYTES = Number(process.env.WEB_SEARCH_SAFE_MAX_BYTES || 512 * 1024);
const UA = 'dsh-pm-workbench-web-search-safe/1.0 (+https://github.com/781237194/agile-workbench)';

const TOOLS = [
  {
    name: 'web_search',
    description: '联网搜索（只读）：返回标题/链接/摘要候选，用于查网络用语、梗、事实性问题。',
    inputSchema: {
      type: 'object',
      properties: { query: { type: 'string', description: '搜索词，最多 300 字' } },
      required: ['query'],
    },
  },
  {
    name: 'web_fetch',
    description: '抓取 http(s) 网页正文（只读）：禁止内网/本机地址，返回纯文本前若干字符。',
    inputSchema: {
      type: 'object',
      properties: { url: { type: 'string', description: '要抓取的 http(s) URL' } },
      required: ['url'],
    },
  },
];

const PRIVATE_V4 = [
  [/^10\./, '10/8'],
  [/^127\./, '127/8'],
  [/^169\.254\./, '169.254/16'],
  [/^172\.(1[6-9]|2\d|3[01])\./, '172.16/12'],
  [/^192\.168\./, '192.168/16'],
  [/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./, '100.64/10'],
  [/^0\./, '0/8'],
];

function log(msg) {
  process.stderr.write(`[web-search-safe] ${msg}\n`);
}

function send(payload) {
  process.stdout.write(JSON.stringify(payload) + '\n');
}

function result(id, value) {
  send({ jsonrpc: '2.0', id, result: value });
}

function error(id, code, message) {
  send({ jsonrpc: '2.0', id, error: { code, message } });
}

function textResult(text, isError = false) {
  return { content: [{ type: 'text', text: String(text) }], ...(isError ? { isError: true } : {}) };
}

function cleanQuery(raw) {
  let q = String(raw ?? '');
  q = q.replace(/\[CQ:[^\]]*\]/g, ' ');
  q = q.replace(/[\u0000-\u001f\u007f]/g, ' ');
  q = q.replace(/\s+/g, ' ').trim();
  return q.slice(0, 300);
}

function stripTags(html) {
  return String(html)
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1')
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)))
    .replace(/\s+/g, ' ')
    .trim();
}

function decodeEntities(text) {
  return String(text)
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(Number(n)));
}

function isPrivateIp(ip) {
  if (net.isIPv4(ip)) {
    return PRIVATE_V4.some(([re, label]) => {
      if (re.test(ip)) return label;
      return false;
    }) || /^224\./.test(ip) || /^2(3\d|4\d|5[0-5])\./.test(ip);
  }
  if (net.isIPv6(ip)) {
    const lower = ip.toLowerCase();
    if (lower === '::1' || lower === '::') return 'loopback';
    if (/^f[cd]/.test(lower)) return 'fc00::/7';
    if (/^fe[89ab]/.test(lower)) return 'fe80::/10';
    const mapped = lower.match(/^::ffff:(\d+\.\d+\.\d+\.\d+)$/);
    if (mapped) return isPrivateIp(mapped[1]);
    return false;
  }
  return false;
}

function parseTargetUrl(raw) {
  let url;
  try {
    url = new URL(String(raw || '').trim());
  } catch {
    throw new Error('URL 不合法');
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') throw new Error('只允许 http/https');
  if (url.username || url.password) throw new Error('URL 不允许内嵌凭据');
  const host = url.hostname.toLowerCase().replace(/\.$/, '');
  if (!host) throw new Error('缺少主机名');
  if (host === 'localhost' || host.endsWith('.local') || host.endsWith('.internal')) {
    throw new Error(`拒绝访问内网主机：${host}`);
  }
  if (net.isIP(host) && isPrivateIp(host)) throw new Error(`拒绝访问内网地址：${host}`);
  const port = url.port ? Number(url.port) : url.protocol === 'https:' ? 443 : 80;
  if (port !== 80 && port !== 443 && (port < 1024 || port > 65535)) {
    throw new Error(`拒绝访问非常用端口：${port}`);
  }
  return url;
}

async function assertPublicHost(url) {
  const host = url.hostname;
  if (net.isIP(host)) return;
  let addresses = [];
  try {
    addresses = await dns.lookup(host, { all: true, verbatim: true });
  } catch (err) {
    throw new Error(`域名解析失败：${host}（${err.code || err.message}）`);
  }
  if (!addresses.length) throw new Error(`域名无解析结果：${host}`);
  for (const { address } of addresses) {
    const reason = isPrivateIp(address);
    if (reason) throw new Error(`拒绝访问内网地址：${host} → ${address}（${reason}）`);
  }
}

async function readLimited(response) {
  if (!response.body) return '';
  const reader = response.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > MAX_BYTES) {
      chunks.push(value);
      try {
        await reader.cancel();
      } catch {}
      break;
    }
    chunks.push(value);
  }
  const buffer = Buffer.concat(chunks.map((c) => Buffer.from(c)));
  return new TextDecoder('utf-8', { fatal: false }).decode(buffer.slice(0, MAX_BYTES));
}

async function safeFetch(rawUrl) {
  let url = parseTargetUrl(rawUrl);
  for (let hop = 0; hop <= 5; hop += 1) {
    await assertPublicHost(url);
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
    let response;
    try {
      response = await fetch(url, {
        method: 'GET',
        redirect: 'manual',
        headers: { 'user-agent': UA, accept: 'text/html,application/xhtml+xml,text/plain,*/*;q=0.5' },
        signal: controller.signal,
      });
    } finally {
      clearTimeout(timer);
    }
    const status = response.status;
    if (status >= 300 && status < 400) {
      const location = response.headers.get('location');
      if (!location) throw new Error(`重定向缺少 Location（${status}）`);
      url = parseTargetUrl(new URL(location, url).href);
      continue;
    }
    if (!response.ok) throw new Error(`抓取失败：HTTP ${status}`);
    const contentType = String(response.headers.get('content-type') || '');
    const body = await readLimited(response);
    const text = /html|xml/i.test(contentType) ? stripTags(body) : body.trim();
    return { url: url.href, status, contentType, raw: body, text };
  }
  throw new Error('重定向层数过多');
}

async function webSearch(query) {
  const q = cleanQuery(query);
  if (!q) throw new Error('搜索词为空');
  const url = `https://www.bing.com/search?format=rss&count=10&q=${encodeURIComponent(q)}`;
  const { raw } = await safeFetch(url);
  const items = [...raw.matchAll(/<item>([\s\S]*?)<\/item>/gi)].slice(0, 6);
  const rows = items.map((m, index) => {
    const block = m[1];
    const title = stripTags((block.match(/<title>([\s\S]*?)<\/title>/i) || [, ''])[1]);
    const link = decodeEntities((block.match(/<link>([\s\S]*?)<\/link>/i) || [, ''])[1]).trim();
    const desc = stripTags((block.match(/<description>([\s\S]*?)<\/description>/i) || [, ''])[1]);
    return `${index + 1}. ${title}\n   ${link}\n   ${desc.slice(0, 200)}`;
  });
  if (!rows.length) {
    const plain = stripTags(raw).slice(0, 1200);
    return `没有解析到 RSS 结果，原始内容摘要：\n${plain}`;
  }
  return `搜索「${q}」共 ${rows.length} 条：\n\n${rows.join('\n\n')}`;
}

async function webFetch(rawUrl) {
  const { url, status, contentType, text } = await safeFetch(rawUrl);
  const body = text.slice(0, 5000);
  if (!body) return `HTTP ${status}，响应为空（${contentType || '未知类型'}）：${url}`;
  return `抓取 ${url}（HTTP ${status}，${contentType || '未知类型'}），正文前 ${body.length} 字符：\n\n${body}`;
}

async function handleCall(id, params) {
  const name = params?.name;
  const args = params?.arguments || {};
  try {
    if (name === 'web_search') {
      result(id, textResult(await webSearch(args.query)));
      return;
    }
    if (name === 'web_fetch') {
      result(id, textResult(await webFetch(args.url)));
      return;
    }
    result(id, textResult(`未知工具：${name}`, true));
  } catch (err) {
    const message = err?.name === 'AbortError' ? '请求超时' : err?.message || String(err);
    result(id, textResult(`${name} 失败：${message}`, true));
  }
}

/** 尚未返回的异步调用：stdin 关闭时先等它们写完再退出，避免"调用还没回包就 exit"。 */
const pending = new Set();

function handle(message) {
  if (!message || typeof message !== 'object') return;
  const { id, method, params } = message;
  if (method === undefined) return; // response/notification 不处理
  if (id === undefined || id === null) {
    if (method === 'notifications/initialized') return;
    return;
  }
  switch (method) {
    case 'initialize':
      result(id, {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: SERVER_NAME, version: SERVER_VERSION },
      });
      return;
    case 'ping':
      result(id, {});
      return;
    case 'tools/list':
      result(id, { tools: TOOLS });
      return;
    case 'tools/call': {
      const task = handleCall(id, params).finally(() => pending.delete(task));
      pending.add(task);
      return;
    }
    default:
      error(id, -32601, `未实现的方法：${method}`);
  }
}

let buffer = '';
process.stdin.setEncoding('utf8');
process.stdin.on('data', (chunk) => {
  buffer += chunk;
  let index = buffer.indexOf('\n');
  while (index >= 0) {
    const line = buffer.slice(0, index).trim();
    buffer = buffer.slice(index + 1);
    if (line) {
      try {
        handle(JSON.parse(line));
      } catch (err) {
        log(`无法解析的输入：${err.message}`);
      }
    }
    index = buffer.indexOf('\n');
  }
});
process.stdin.on('end', async () => {
  const rest = buffer.trim();
  if (rest) {
    try {
      handle(JSON.parse(rest));
    } catch {}
  }
  if (pending.size) {
    try {
      await Promise.allSettled([...pending]);
    } catch {}
  }
  // 等 stdout 把最后一条回包刷出去再退出（管道场景容易被截断）。
  process.stdout.write('', () => process.exit(0));
});
process.on('uncaughtException', (err) => log(`未捕获异常：${err?.stack || err}`));
