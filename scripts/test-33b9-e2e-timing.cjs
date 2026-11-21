'use strict';
/**
 * B-33b9（PM 04:41）：地址变化后端到端上线分段。
 * 无 GUI 也能测的两段：①发现链（netstat 监听端口→特征校验） ②握手（DshAdapter.check 538 会话）
 * 都直连真实 DSH 55263；渲染层推送/刷新在 app.js 已加 __dshLastRefreshAt 打点，起真窗口时读取。
 * 3 次样本，分段均落 证据-33b9-20261121/e2e-timing.json。
 */
const fs = require('node:fs');
const path = require('node:path');
const adapter = require(path.resolve(__dirname, '..', 'src', 'dsh-adapter.js'));

(async () => {
  const samples = [];
  for (let i = 1; i <= 3; i += 1) {
    const t0 = Date.now();
    const discovery = await adapter.discoverDshWeb({
      env: {}, savedBaseUrl: 'http://127.0.0.1:65533', skipPortFiles: true, skipProcessDiscovery: true,
      probeTimeoutMs: 250, totalBudgetMs: 1500
    });
    const discoveryMs = Date.now() - t0;
    const t1 = Date.now();
    const status = await new adapter.DshAdapter(discovery.baseUrl).check({ timeoutMs: 3000 });
    const handshakeMs = Date.now() - t1;
    samples.push({
      run: i,
      baseUrl: discovery.baseUrl,
      source: discovery.source,
      discoveryMs,
      handshakeMs,
      totalMs: discoveryMs + handshakeMs,
      online: Boolean(status && status.online),
      sessions: status && status.sessions
    });
  }
  // 渲染层推送/IPC 为同步 send + 一次 refresh，不能在没有窗口时伪造数字；如实标注为「未测（无 GUI）」。
  const pushEstimate = null;
  const pass = samples.every((s) => s.online && /:55263$/.test(String(s.baseUrl)) && s.totalMs <= 3000);
  const out = { at: new Date().toISOString(), samples, pushEstimate, note: 'pushEstimate=null：本机可用内存不足，未起真窗口；渲染层打点 window.__dshLastRefreshAt 已就绪', pass };
  const dir = path.resolve(__dirname, '..', '项目', '工作台改造修复', '程序员A', '产出', '证据-33b9-20261121');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'e2e-timing.json'), JSON.stringify(out, null, 2) + '\n', 'utf8');
  for (const s of samples) console.log('run ' + s.run + ' · source=' + s.source + ' · discovery=' + s.discoveryMs + 'ms · handshake=' + s.handshakeMs + 'ms · total=' + s.totalMs + 'ms · online=' + s.online + ' · ' + s.baseUrl);
  console.log((pass ? 'E2E_TIMING_PASS' : 'E2E_TIMING_FAIL') + ' (3/3 ≤3000ms)');
  process.exitCode = pass ? 0 : 1;
})().catch((e) => { console.error('EX', (e && e.stack) || e); process.exitCode = 1; });
