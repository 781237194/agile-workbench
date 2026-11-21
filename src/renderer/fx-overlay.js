'use strict';
/**
 * T-77e4：主窗 particles 的透明覆盖窗渲染器。
 * <webview> 是独立合成层，主窗 DOM 里的 #fx-layer（z-index 9600）连接后会被盖住；
 * 本页跑在同尺寸的 transparent BrowserWindow 里，只画粒子，鼠标事件由主进程
 * setIgnoreMouseEvents(true,{forward:true}) 全部透传给主窗。
 * 状态由主窗 fx-layer 推送：{ enabled, count, colors, opacityRange, mode }。
 */
(function () {
  var canvas = document.getElementById('fx-overlay-canvas');
  var ctx = canvas ? canvas.getContext('2d') : null;
  var state = { enabled: false, count: 0, colors: [], opacityRange: [0.15, 0.55], mode: 'full' };
  var parts = [];
  var raf = 0;
  var dpr = Math.max(1, Math.min(2, (window.devicePixelRatio || 1)));
  var W = 0, H = 0;

  function resize() {
    W = Math.max(1, window.innerWidth || 1);
    H = Math.max(1, window.innerHeight || 1);
    if (!canvas) return;
    canvas.width = Math.round(W * dpr);
    canvas.height = Math.round(H * dpr);
    canvas.style.width = W + 'px';
    canvas.style.height = H + 'px';
    if (ctx) ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
  }

  function colorAt(i) {
    var list = state.colors && state.colors.length ? state.colors : ['rgba(120,200,255,0.45)'];
    return list[i % list.length];
  }

  function seed() {
    parts = [];
    var want = state.enabled ? Math.max(0, Math.min(1200, Number(state.count) || 0)) : 0;
    for (var i = 0; i < want; i += 1) {
      var radius = 1.2 + Math.random() * 2.6;
      parts.push({
        x: Math.random() * W,
        y: Math.random() * H,
        r: radius,
        vx: (Math.random() - 0.5) * 0.20,
        vy: -0.06 - Math.random() * 0.30,
        a: 0.12 + Math.random() * 0.38,
        c: colorAt(i)
      });
    }
  }

  function draw() {
    raf = 0;
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, W, H);
    if (!state.enabled || state.mode !== 'full') return;
    for (var i = 0; i < parts.length; i += 1) {
      var p = parts[i];
      p.x += p.vx;
      p.y += p.vy;
      if (p.y < -6) { p.y = H + 6; p.x = Math.random() * W; }
      if (p.x < -6) p.x = W + 6;
      if (p.x > W + 6) p.x = -6;
      ctx.globalAlpha = p.a;
      ctx.fillStyle = p.c;
      ctx.beginPath();
      ctx.arc(p.x, p.y, p.r, 0, Math.PI * 2);
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    raf = window.requestAnimationFrame(draw);
  }

  function apply(next) {
    if (!next || typeof next !== 'object') return;
    state = {
      enabled: next.enabled === true,
      count: Number(next.count) || 0,
      colors: Array.isArray(next.colors) ? next.colors.slice(0, 8).map(String) : [],
      opacityRange: Array.isArray(next.opacityRange) ? next.opacityRange.slice(0, 2).map(Number) : [0.15, 0.55],
      mode: String(next.mode || 'full')
    };
    if (!state.enabled) {
      parts = [];
      if (ctx) ctx.clearRect(0, 0, W, H);
      return;
    }
    seed();
    if (!raf) raf = window.requestAnimationFrame(draw);
  }

  function ready() {
    try {
      if (window.fxOverlay && typeof window.fxOverlay.ready === 'function') window.fxOverlay.ready();
    } catch (e) { /* ignore */ }
  }

  window.addEventListener('resize', function () { resize(); seed(); }, { passive: true });
  window.addEventListener('DOMContentLoaded', ready, { once: true });
  if (document.readyState !== 'loading') ready();
  try {
    if (window.fxOverlay && typeof window.fxOverlay.onState === 'function') {
      window.fxOverlay.onState(apply);
    }
  } catch (e) { /* ignore */ }
  resize();
  if (!raf) raf = window.requestAnimationFrame(draw);
})();
