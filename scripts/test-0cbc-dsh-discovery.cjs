#!/usr/bin/env node
'use strict';
/**
 * test-0cbc-dsh-discovery.cjs —— B-20261120-181746-0cbc（P1）DSH 端口发现链夹具（五条）
 *
 *  ①仅 env（DSH_WEB_URL）→ 探活成功、source=env-url、shouldPersist=true
 *  ②仅端口文件（<沙盘 DSH_HOME>/gui.port）→ 探活成功、source=port-file
 *  ③旧地址失效 + 新端口在 env → 仍能发现；显式 pin 失效但 env 命中 → DSH_FOUND_PIN_UNREACHABLE
 *  ④全源缺失：文案必须列出**全部**已探测端口 + 各权威源读数 + 可执行下一步
 *  ⑤文案里的端口清单数量与 result.probedPorts 完全一致（不再「说 18 个只列 6 个」）
 *
 * 全部走真实 HTTP 假 DSH（/json/version 返回含 DeepSeek Harness 的正文），不碰真实 DSH。
 * 用法：node scripts/test-0cbc-dsh-discovery.cjs [--json]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const ROOT = path.resolve(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');
const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
}
const { discoverDshWeb } = require(path.join(ROOT, 'src', 'dsh-adapter.js'));

function fakeDsh() {
  return new Promise((resolve) => {
    const server = http.createServer((req, res) => {
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ Browser: 'Electron/30', Engine: 'DeepSeek Harness 1.0', ProtocolVersion: '1.3' }));
    });
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }));
  });
}
function deadPort() {
  return new Promise((resolve) => {
    const s = http.createServer(() => {});
    s.listen(0, '127.0.0.1', () => { const port = s.address().port; s.close(() => resolve(port)); });
  });
}
const baseOpts = { skipProcessDiscovery: true, includeRange: false, includeScan: false, timeoutMs: 900 };

async function main() {
  const sandbox = fs.mkdtempSync(path.join(os.tmpdir(), 'c0bc-dsh-'));
  const dshHome = path.join(sandbox, 'dsh-home');
  fs.mkdirSync(dshHome, { recursive: true });
  const emptyEnv = { DSH_HOME: dshHome };
  const live = await fakeDsh();
  const dead = await deadPort();
  try {
    /* ① 仅 env */
    const r1 = await discoverDshWeb({ ...baseOpts, env: { ...emptyEnv, DSH_WEB_URL: 'http://127.0.0.1:' + live.port }, savedBaseUrl: '' });
    check('①仅 env：探活成功且 source=env-url、shouldPersist=true',
      r1.ok && r1.source === 'env-url' && r1.baseUrl === 'http://127.0.0.1:' + live.port && r1.shouldPersist === true
      && (r1.probedPorts || []).includes(live.port), r1);

    /* ② 仅端口文件 */
    fs.writeFileSync(path.join(dshHome, 'gui.port'), String(live.port) + '\n', 'utf8');
    const r2 = await discoverDshWeb({ ...baseOpts, env: { ...emptyEnv }, savedBaseUrl: '' });
    check('②仅 gui.port：探活成功且 source=port-file',
      r2.ok && r2.source === 'port-file' && r2.baseUrl === 'http://127.0.0.1:' + live.port, r2);
    check('②b 端口文件读数：存在且记为 ok', Array.isArray(r2.portFileReadout)
      && r2.portFileReadout.some((row) => String(row.file).endsWith('gui.port') && row.exists === true && Number(row.port) === live.port), r2.portFileReadout);
    fs.rmSync(path.join(dshHome, 'gui.port'), { force: true });

    /* ③ 旧地址失效 + 新端口在 env */
    const deadBase = 'http://127.0.0.1:' + dead;
    const r3 = await discoverDshWeb({ ...baseOpts, env: { ...emptyEnv, DSH_WEB_URL: 'http://127.0.0.1:' + live.port }, savedBaseUrl: deadBase });
    check('③上次保存失效 + env 新端口：仍能发现（source=env-url）',
      r3.ok && r3.source === 'env-url' && r3.baseUrl === 'http://127.0.0.1:' + live.port, r3);
    const r3b = await discoverDshWeb({ ...baseOpts, env: { ...emptyEnv, DSH_WEB_URL: 'http://127.0.0.1:' + live.port }, savedBaseUrl: deadBase, explicitBaseUrl: deadBase, explicitSource: 'dsh.json pin' });
    check('③b 显式 pin 失效但 env 命中：DSH_FOUND_PIN_UNREACHABLE（不再永久失联）',
      r3b.ok && r3b.code === 'DSH_FOUND_PIN_UNREACHABLE' && r3b.baseUrl === 'http://127.0.0.1:' + live.port && r3b.shouldPersist === true, r3b);

    /* ④ 全源缺失：文案 */
    const r4 = await discoverDshWeb({ ...baseOpts, env: { ...emptyEnv }, savedBaseUrl: deadBase });
    const msg4 = String(r4.message || '');
    check('④全源缺失：判定失败且码为 DSH_NOT_FOUND', r4.ok === false && r4.code === 'DSH_NOT_FOUND', { code: r4.code, ok: r4.ok });
    check('④b 文案列出全部已探测端口（含上次保存的失效端口）',
      /已探测 \d+ 个本机端口（[^）]+）/.test(msg4) && msg4.includes('127.0.0.1:' + dead), msg4.slice(0, 400));
    check('④c 文案带各权威源读数（env/端口文件/dsh.json/进程）',
      /来源读数：/.test(msg4) && /DSH_WEB_URL=（未设）/.test(msg4) && /端口文件/.test(msg4) && /dsh\.json 上次地址=/.test(msg4) && /dsh 进程=/.test(msg4), msg4.slice(0, 600));
    check('④d 文案给可执行下一步（如何取端口 / 保存并探测）',
      /下一步：/.test(msg4) && /设置 → Web\/HTTP 端口/.test(msg4) && /保存并探测/.test(msg4), msg4.slice(-360));

    /* ⑤ 端口清单数量一致 */
    const m = /已探测 (\d+) 个本机端口（([^）]+)）/.exec(msg4);
    const listed = m ? m[2].split('、').filter(Boolean).map((s) => Number(String(s).replace('127.0.0.1:', ''))) : [];
    const probed = Array.isArray(r4.probedPorts) ? r4.probedPorts.slice().sort((a, b) => a - b) : [];
    check('⑤文案「已探测 N 个」与列出的端口数一致',
      Boolean(m) && Number(m[1]) === listed.length && listed.length === probed.length, { said: m && m[1], listed, probed });
    check('⑤b 文案列出的端口与 result.probedPorts 逐个相等（去重升序）',
      listed.length > 0 && JSON.stringify(listed.slice().sort((a, b) => a - b)) === JSON.stringify(probed), { listed, probed });
  } finally {
    live.server.close();
    try { fs.rmSync(sandbox, { recursive: true, force: true }); } catch { /* 忽略 */ }
  }
  const failed = ROWS.filter((r) => !r.ok).length;
  if (JSON_OUT) console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed, failed: ROWS.filter((r) => !r.ok).map((r) => r.name), rows: ROWS }, null, 2));
  else console.log(`\n${ROWS.length - failed}/${ROWS.length} PASS${failed ? ' · ' + failed + ' FAIL' : ''}`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('FIXTURE_FAILED', String((e && e.stack) || e)); process.exit(1); });
