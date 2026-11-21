'use strict';
/**
 * T-20261122-052652-77e4（P1 连接后粒子不可见）：静态接线夹具。
 * 真实连接态截图/点击穿透需要真窗口；这里锁死实现结构，防回归：
 * 1) #fx-layer 仍在 body 直接子节点、z-index 9600（离线页主窗 canvas 兜底）；
 * 2) 覆盖窗 transparent + frame:false + parent 主窗 + ignoreMouseEvents(forward)；
 * 3) 主窗 fx-layer 推送 overlayState，在线时由 app.js 置 __awbFxOverlayOnline；
 * 4) 覆盖窗只画粒子，透明背景，不加载 DSH 页面；
 * 5) __fxLayerEvidence 可取 computed z-index/position/elementFromPoint。
 */
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const R = [];
function check(name, fn) { try { fn(); R.push(true); console.log(`PASS ${name}`); } catch (e) { R.push(false); console.log(`FAIL ${name}: ${String((e && e.message) || e)}`); } }
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

check('主窗 #fx-layer 仍 body 直接子节点 + z-index 9600', () => {
  const html = read('src/renderer/index.html');
  const css = read('src/renderer/style.css');
  assert.match(html, /<div id="fx-layer"/);
  assert.match(css, /#fx-layer\s*\{[^}]*z-index:\s*9600/s);
});
check('覆盖窗：transparent/frame:false/parent/ignoreMouseEvents(forward)', () => {
  const main = read('src/main.js');
  assert.match(main, /transparent:\s*true/);
  assert.match(main, /frame:\s*false/);
  assert.match(main, /parent:\s*mainWindow/);
  assert.match(main, /setIgnoreMouseEvents\(true,\s*\{\s*forward:\s*true\s*\}\)/);
});
check('在线时 app.js 才启用覆盖窗粒子', () => {
  const app = read('src/renderer/app.js');
  assert.match(app, /__awbFxOverlayOnline\s*=\s*online/);
  assert.match(app, /notifyOverlay/);
  const fx = read('src/renderer/fx-layer.js');
  assert.match(fx, /W\.__awbFxOverlayOnline === true/);
});
check('覆盖窗只画粒子、不加载 DSH 页面', () => {
  const html = read('src/renderer/fx-overlay.html');
  const js = read('src/renderer/fx-overlay.js');
  assert.match(html, /fx-overlay-canvas/);
  assert.doesNotMatch(js, /#dsh-view|dsh-off|src\s*=\s*["']http/i);
  assert.match(js, /requestAnimationFrame/);
});
check('在线且覆盖窗就绪时壳内停止绘制（失败/离线回退）', () => {
  const fx = read('src/renderer/fx-layer.js');
  assert.match(fx, /overlayOwns/);
  assert.match(fx, /clearCanvas\(\)/);
  assert.match(fx, /stopLoop\(\)/);
  assert.match(fx, /__awbFxOverlayReady/);
  const preload = read('src/preload.js');
  assert.match(preload, /onFxOverlayReady/);
});
check('覆盖窗 focus/blur 与 metrics 已接线', () => {
  const main = read('src/main.js');
  assert.match(main, /mainWindow\.on\('blur'/);
  assert.match(main, /mainWindow\.on\('focus'/);
  assert.match(main, /function fxOverlayMetrics\(/);
  assert.match(main, /metrics:\s*fxOverlayMetrics\(\)/);
  assert.match(main, /fx:overlay-benchmark/);
  const preload = read('src/preload.js');
  assert.match(preload, /fxOverlayBenchmark/);
});
check('层级证据取数口已暴露', () => {
  const fx = read('src/renderer/fx-layer.js');
  assert.match(fx, /function layerEvidence\(/);
  assert.match(fx, /elementFromPoint/);
  assert.match(fx, /__fxLayerEvidence\s*=\s*layerEvidence/);
});
const failed = R.filter((v) => !v).length;
console.log(`FX_OVERLAY_STATIC ${R.length - failed}/${R.length} PASS`);
if (failed) process.exitCode = 1;
