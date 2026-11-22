/*
 * fx-sprite.js —— 星光粒子 sprite 唯一实现（T-20261122-195601-4855 AC①）
 *
 * 为什么单独成文件：此前壳层 fx-layer.js 的 buildSprite 与覆盖窗 fx-overlay.js 的 buildStar
 * 是两份独立实现，参数/缩放/透明度稍有不一致，Owner 看到「连 DSH 前」与「连上后」两层观感不同。
 * 现在两边都只调用本模块：11×11 画布、四芒星 polygon（亮核 + 横/纵十字光芒、边缘锐利），
 * 同主题同 DPR 下两层 sprite 的 alpha 网格逐像素同形（夹具 scripts/test-4855-shared-sprite.cjs）。
 *
 * 浏览器：<script src="fx-sprite.js"></script> 后使用 window.AWBFxSprite
 * Node（仅纯逻辑/夹具）：require('./fx-sprite.js') → { SIZE, VERSION, build, alphaGrid, rgbOf }
 */
(function (root, factory) {
  'use strict';
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.AWBFxSprite = factory();
}(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // 11×11：奇数边便于「中心像素对齐」，也是 AC② 抽样比较的网格尺寸。
  var SIZE = 11;
  var VERSION = 'fx-sprite/1 11x11 four-point star';

  function clamp255(v) { return Math.max(0, Math.min(255, Math.round(Number(v) || 0))); }

  /** 颜色归一：支持 [r,g,b] / {r,g,b} / '#rrggbb' / 'rgb(...)' / 'rgba(...)'。 */
  function rgbOf(value) {
    if (Array.isArray(value) && value.length >= 3) {
      return [clamp255(value[0]), clamp255(value[1]), clamp255(value[2])];
    }
    if (value && typeof value === 'object') {
      return [clamp255(value.r), clamp255(value.g), clamp255(value.b)];
    }
    var text = String(value == null ? '' : value);
    var m = text.match(/rgba?\(\s*([\d.]+)\s*[,\s]\s*([\d.]+)\s*[,\s]\s*([\d.]+)/i);
    if (m) return [clamp255(m[1]), clamp255(m[2]), clamp255(m[3])];
    var hex = text.match(/^#([0-9a-f]{3}|[0-9a-f]{6})$/i);
    if (hex) {
      var h = hex[1];
      if (h.length === 3) h = h[0] + h[0] + h[1] + h[1] + h[2] + h[2];
      return [parseInt(h.slice(0, 2), 16), parseInt(h.slice(2, 4), 16), parseInt(h.slice(4, 6), 16)];
    }
    return [255, 255, 255];
  }

  /** 生成一颗预渲染精灵（11×11 canvas）。每档颜色只建一次，供两边 drawImage 复用。 */
  function build(value) {
    var rgb = rgbOf(value);
    var canvas = document.createElement('canvas');
    canvas.width = SIZE;
    canvas.height = SIZE;
    var ctx = canvas.getContext('2d');
    if (!ctx) return canvas;
    var center = SIZE / 2;
    var text = rgb[0] + ',' + rgb[1] + ',' + rgb[2];
    // 实心星形填充（不做径向渐变）：11×11 缩到 2–3.5px 时，实心才能让四尖端在像素网格上留下可读的十字；
    // 中心再叠一次亮核，形成「亮核 + 横/纵光芒」的星光。四角在星形外，保持全透明（非圆点）。
    ctx.fillStyle = 'rgba(' + text + ',0.92)';
    var outer = center;
    var inner = outer * 0.4;
    ctx.beginPath();
    for (var i = 0; i < 8; i += 1) {
      var ang = -Math.PI / 2 + i * (Math.PI / 4);
      var r = i % 2 === 0 ? outer : inner;
      var x = center + Math.cos(ang) * r;
      var y = center + Math.sin(ang) * r;
      if (i === 0) ctx.moveTo(x, y); else ctx.lineTo(x, y);
    }
    ctx.closePath();
    ctx.fill();
    // 亮核：缩到几 px 时仍读成「一点星光」，而不是灰点/圆点。
    ctx.fillStyle = 'rgba(' + text + ',1)';
    ctx.beginPath();
    ctx.arc(center, center, 2.2, 0, Math.PI * 2);
    ctx.fill();
    return canvas;
  }

  /** 11×11 alpha 网格（0–255，行优先），供夹具逐像素比较两边是否同形。 */
  function alphaGrid(value) {
    var canvas = build(value);
    var ctx = canvas.getContext('2d');
    if (!ctx || typeof ctx.getImageData !== 'function') return null;
    var data = ctx.getImageData(0, 0, SIZE, SIZE).data;
    var out = [];
    for (var i = 0; i < SIZE * SIZE; i += 1) out.push(data[i * 4 + 3]);
    return out;
  }

  return { SIZE: SIZE, VERSION: VERSION, rgbOf: rgbOf, build: build, alphaGrid: alphaGrid };
}));
