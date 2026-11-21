#!/usr/bin/env node
'use strict';
/**
 * test-390a-proxy-expiry.cjs —— B-20261121-043733-390a（P2）代管到期时间按本机时区显示
 *
 * A 未过期（今天 HH:MM）
 * B 跨天（明天 / MM-DD）
 * C 刚过期（active=false，文案仍给本地时钟）
 * D 非法值 → null
 * E 接线静态：owner-review 走 AWBProxyExpiry 且 allActive 与 Date.parse 同源、index 预加载、raw ISO 留在 data-proxy-expires-at
 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const { formatProxyExpiry } = require(path.join(ROOT, 'src', 'renderer', 'proxy-expiry.js'));
const ROWS = [];
const JSON_OUT = process.argv.includes('--json');
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + JSON.stringify(detail)}`);
}
const pad = (n) => String(n).padStart(2, '0');
function localIso(ms) { const d = new Date(ms); return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}T${pad(d.getHours())}:${pad(d.getMinutes())}:00`; }

// A 未过期今天：本地 10:00 构造 today 14:30 到期
{
  const now = new Date(); now.setHours(10, 0, 0, 0);
  const exp = new Date(now); exp.setHours(14, 30, 0, 0);
  const r = formatProxyExpiry(localIso(exp.getTime()), now.getTime());
  check('A 今天未过期 →「今天 14:30」且 active', r && r.label === '今天 14:30' && r.clock === '14:30' && r.active === true, r);
}

// B 跨天：明天 09:30 与 后天/更远
{
  const now = new Date(); now.setHours(23, 0, 0, 0);
  const tomorrow = new Date(now); tomorrow.setDate(tomorrow.getDate() + 1); tomorrow.setHours(9, 30, 0, 0);
  const b1 = formatProxyExpiry(localIso(tomorrow.getTime()), now.getTime());
  check('B1 明天 09:30 →「明天 09:30」', b1 && b1.label === '明天 09:30' && b1.active === true, b1);
  const far = new Date(now); far.setDate(far.getDate() + 5); far.setHours(9, 30, 0, 0);
  const b2 = formatProxyExpiry(localIso(far.getTime()), now.getTime());
  const expect = `${pad(far.getMonth() + 1)}-${pad(far.getDate())} 09:30`;
  check('B2 五天后的 →「MM-DD 09:30」', b2 && b2.label === expect && b2.active === true, { got: b2, expect });
}

// C 刚过期：active=false，时钟仍是本地
{
  const now = new Date(); now.setHours(12, 0, 0, 0);
  const exp = new Date(now); exp.setHours(11, 50, 0, 0);
  const r = formatProxyExpiry(localIso(exp.getTime()), now.getTime());
  check('C 11:50 已过期（12:00 判）→ active=false、clock=11:50', r && r.active === false && r.clock === '11:50', r);
}

// D 非法
check('D 非法值 → null', formatProxyExpiry('not-a-date', Date.now()) === null, {});

// E 静态接线
const src = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'owner-review.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
check('E1 owner-review 使用 AWBProxyExpiry.formatProxyExpiry', src.includes('AWBProxyExpiry.formatProxyExpiry'), {});
check('E2 allActive 与文案同源（expiresMs > Date.now()）', src.includes('expiresMs > Date.now()'), {});
check('E3 过期文案「代管已结束（… 到期）」', src.includes('代管已结束（'), {});
check('E4 data-proxy-expires-at 仍保留原始 ISO', src.includes("setAttribute('data-proxy-expires-at', state.proxyAllExpiresAt)"), {});
check('E5 index.html 在 app.js 前加载 proxy-expiry.js', /<script src="proxy-expiry\.js"><\/script>[\s\S]{0,500}<script src="app\.js"><\/script>/.test(html), {});

const failed = ROWS.filter((r) => !r.ok).length;
if (JSON_OUT) console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed, failed: ROWS.filter((r) => !r.ok).map((r) => r.name), rows: ROWS }, null, 2));
else console.log(`\n${ROWS.length - failed}/${ROWS.length} PASS${failed ? ' · ' + failed + ' FAIL' : ''}`);
process.exit(failed ? 1 : 0);
