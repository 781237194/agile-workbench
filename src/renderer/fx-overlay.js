'use strict';
/**
 * T-77e4：主窗 particles 的透明覆盖窗渲染器。
 * <webview> 是独立合成层，主窗 DOM 里的 #fx-layer（z-index 9600）连接后会被盖住；
 * 本页跑在同尺寸的 transparent BrowserWindow 里，只画粒子，鼠标事件由主进程
 * setIgnoreMouseEvents 全部透传给主窗。
 * 状态由主窗 fx-layer 推送：{ enabled, count, colors, opacityRange, mode }。
 *
 * 2026-11-22（T-20261122-190253-6c78）：与壳内共用「四芒星光」观感——
 * sprite 为 16×16 预渲染四芒星（亮核+横/纵十字光芒），每档颜色只建一次；
 * 单颗直径 1.5–3px，逐颗相位闪烁（0.6–1.0 正弦 globalAlpha），不再画软圆气泡。
 */
(function () {
  var canvas = document.getElementById('fx-overlay-canvas');
  var ctx = canvas ? canvas.getContext('2d') : null;
  var state = { enabled: false, count: 0, colors: [], opacityRange: [0.15, 0.55], mode: 'full' };
  var parts = [];
  var sprites = {};
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

  /** rgba()/rgb() 字符串 → {r,g,b,a}；解析失败回退主题蓝。 */
  function parseColor(css) {
    var m = String(css || '').match(/rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)(?:\s*,\s*([\d.]+))?\s*\)/i);
    if (!m) return { r: 120, g: 200, b: 255, a: 0.45 };
    return { r: Math.round(Number(m[1]) || 0), g: Math.round(Number(m[2]) || 0), b: Math.round(Number(m[3]) || 0), a: m[4] === undefined ? 1 : Math.max(0, Math.min(1, Number(m[4]) || 0)) };
  }

  /** 16×16 预渲染四芒星：亮核 + 横/纵十字光芒，边缘锐利；每档颜色只建一次。 */
  function buildStar(rgb) {
    var size = 10;
    var c = document.createElement('canvas');
    c.width = size;
    c.height = size;
    var g = c.getContext('2d');
    if (!g) return c;
    var center = size / 2;
    var text = rgb.r + ',' + rgb.g + ',' + rgb.b;
    var grad = g.createRadialGradient(center, center, 0, center, center, center);
    grad.addColorStop(0, 'rgba(' + text + ',1)');
    grad.addColorStop(0.55, 'rgba(' + text + ',1)');
    grad.addColorStop(0.8, 'rgba(' + text + ',0.6)');
    grad.addColorStop(1, 'rgba(' + text + ',0)');
    g.fillStyle = grad;
    var outer = center - 0.5;
    var inner = outer * 0.4;
    g.beginPath();
    for (var i = 0; i < 8; i += 1) {
      var ang = -Math.PI / 2 + i * (Math.PI / 4);
      var r = i % 2 === 0 ? outer : inner;
      var x = center + Math.cos(ang) * r;
      var y = center + Math.sin(ang) * r;
      if (i === 0) g.moveTo(x, y); else g.lineTo(x, y);
    }
    g.closePath();
    g.fill();
    g.fillStyle = 'rgba(' + text + ',1)';
    g.beginPath();
    g.arc(center, center, 2.0, 0, Math.PI * 2);
    g.fill();
    return c;
  }

  function spriteAt(css) {
    var key = String(css);
    if (!sprites[key]) sprites[key] = buildStar(parseColor(key));
    return sprites[key];
  }

  function seed() {
    parts = [];
    sprites = {};
    var want = state.enabled ? Math.max(0, Math.min(1200, Number(state.count) || 0)) : 0;
    var lo = state.opacityRange[0] >= 0 ? Number(state.opacityRange[0]) : 0.15;
    var hi = state.opacityRange[1] >= 0 ? Number(state.opacityRange[1]) : 0.55;
    for (var i = 0; i < want; i += 1) {
      var css = colorAt(i);
      parts.push({
        x: Math.random() * W,
        y: Math.random() * H,
        // 与壳内同一口径：核心直径 1.5–3px、十字光芒外延 2.4×。
        d: Math.round((1.5 + Math.random() * 1.5) * 2) / 2,
        // 运动与壳内一致（随机漂移，不统一向上）；亮度只由全局闪烁决定（与壳内 sprite 满 alpha 对齐）。
        vx: (Math.random() - 0.5) * 0.18,
        vy: (Math.random() - 0.5) * 0.18,
        ph: Math.random() * Math.PI * 2,
        fq: 0.0011 + Math.random() * 0.0017,
        c: css
      });
    }
  }

  function draw() {
    raf = 0;
    if (!ctx || !canvas) return;
    ctx.clearRect(0, 0, W, H);
    if (!state.enabled || state.mode !== 'full') return;
    // 与壳内同口径：加色混合（lighter）+ 默认平滑，避免小 sprite 采样出现块状伪影；亮度只做 0.6–1.0 相位闪烁。
    ctx.globalCompositeOperation = 'lighter';
    var nowMs = performance.now();
    for (var i = 0; i < parts.length; i += 1) {
      var p = parts[i];
      p.x += p.vx;
      p.y += p.vy;
      if (p.y < -6) { p.y = H + 6; p.x = Math.random() * W; }
      if (p.x < -6) p.x = W + 6;
      if (p.x > W + 6) p.x = -6;
      var sprite = spriteAt(p.c);
      // 逐颗相位闪烁：0.6–1.0 正弦 globalAlpha（与壳内同一公式，不再乘颜色 alpha）。
      ctx.globalAlpha = 0.8 + 0.2 * Math.sin(nowMs * p.fq + p.ph);
      // 与壳内完全同一几何：sprite 直接按核心直径 d（1.5–3px）绘制，不多倍放大，避免覆盖窗看起来比开机层更「胖/像气泡」。
      var drawD = p.d;
      ctx.drawImage(sprite, p.x - drawD / 2, p.y - drawD / 2, drawD, drawD);
    }
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    raf = window.requestAnimationFrame(draw);
  }

  /** 诊断/验收用强制一帧：同步 setState+seed+draw，供真窗口截图抢在主进程周期状态推送之前。 */
  window.__fxOverlayForce = function (next) {
    try { apply(next); draw(); return window.__fxOverlayStats(); } catch (e) { return { error: String((e && e.message) || e) }; }
  };

  /** 只读取数口（诊断/验收用）：不改变绘制。 */
  window.__fxOverlayStats = function () {    var ds = parts.map(function (p) { return p.d; });
    return {
      enabled: state.enabled,
      mode: state.mode,
      count: parts.length,
      sprites: Object.keys(sprites).length,
      minDiameterPx: ds.length ? Math.min.apply(null, ds) : 0,
      maxDiameterPx: ds.length ? Math.max.apply(null, ds) : 0,
      canvas: canvas ? { w: canvas.width, h: canvas.height } : null
    };
  };

  function apply(next) {
    if (!next || typeof next !== 'object') return;
    state = {
      enabled: next.enabled === true,
      count: Number(next.count) || 0,
      colors: Array.isArray(next.colors) ? next.colors.slice(0, 48).map(String) : [],
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
