#!/usr/bin/env node
'use strict';
/**
 * 静态断言夹具（T-20261118-195239-0d3b AC8③）：慢 IPC 可查 + perf:recent 注册 + data-perf-log 锚点。
 *
 * 断言（全部静态读源码，不启动 Electron）：
 *   S1 perf-log.js 提供 perf:recent 只读 IPC（文本含 'perf:recent'）
 *   S2 main.js 真的注册了它（perfCache.registerPerfIpc(...) 调用，且用 rawIpcHandle 避免重复计时）
 *   S3 preload.js 暴露 perfRecent → ipcRenderer.invoke('perf:recent', ...)
 *   S4 index.html 有 [data-perf-log] 锚点 + 加载 perf-log-anchor.js
 *   S5 perf-log-anchor.js 通过 perfRecent 取数并写 data-perf-log-count/last
 * 跑法：node scripts/test-0d3b-ac8.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return ''; } };

let pass = 0; let fail = 0;
const ok = (cond, name, detail) => { if (cond) { pass += 1; console.log(`PASS ${name}`); } else { fail += 1; console.log(`FAIL ${name} :: ${JSON.stringify(detail || {})}`); } };

const perfLog = read('src/perf-log.js');
const mainJs = read('src/main.js');
const preload = read('src/preload.js');
const indexHtml = read('src/renderer/index.html');
const anchor = read('src/renderer/perf-log-anchor.js');

ok(/perf:recent/.test(perfLog), 'S1 perf-log.js 提供 perf:recent 只读 IPC', {});
ok(/registerPerfIpc\(rawIpcHandle/.test(mainJs), 'S2 main.js 用 rawIpcHandle 注册 perf:recent（不重复计时）', {});
ok(/perfRecent:\s*\(payload\)\s*=>\s*ipcRenderer\.invoke\('perf:recent'/.test(preload), 'S3 preload 暴露 perfRecent → perf:recent', {});
ok(/data-perf-log/.test(indexHtml), 'S4a index.html 有 [data-perf-log] 锚点', {});
ok(/perf-log-anchor\.js/.test(indexHtml), 'S4b index.html 加载 perf-log-anchor.js', {});
ok(/perfRecent|workbench\.perf\b/.test(anchor) && /data-perf-log-count/.test(anchor) && /data-perf-log-last/.test(anchor),
  'S5 锚点脚本用 perf:recent 取数并写 count/last', {});

console.log(`\nAC8_PERF_LOG ${pass}/${pass + fail} PASS`);
process.exitCode = fail === 0 ? 0 : 1;
