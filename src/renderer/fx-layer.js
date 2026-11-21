/* ============================================================================
 * R-fe90 F7 · 特效层（#fx-layer）= 粒子 / 点击涟漪 / 移动光晕 + 唯一取数口
 * ----------------------------------------------------------------------------
 * 规范来源：需求正文 F-7 + AC13–AC16；增补卷-fe90-2 §一/§二/§三/§四/§五/§六
 * （卷优先于正文）。要点：
 *   §一.1 容器唯一：#fx-layer 是 document.body 的**直接子元素**，是全站粒子 canvas /
 *         点击涟漪 / 移动光晕的唯一挂载点；容器 CSS 常驻 pointer-events:none
 *         （不许在正常态改 auto，否则全屏 fixed 层会吃掉工作台所有点击）。
 *   §一.2 层级：position:fixed + z-index 数值 9600；#dsh-view 的计算 z-index 是 auto，
 *         **auto 按 0 视同**；再要求 #dsh-view 到 body 的祖先链上无隔离属性
 *         （transform/filter/isolation/will-change/contain/opacity<1）。
 *   §一.3 可断言锚点：data-fx-layer="on"、data-fx-mode ∈ {full,reduced,off}。
 *   §一.4 命中证明：elementFromPoint 会跳过 pointer-events:none 的元素 —— 所以采样时
 *         **临时**把容器 pointerEvents 置 auto → 25 点采样 → **立即复位**，并断言复位后
 *         计算值回到 none（写进 fx.sample().hitTest.pointerEventsAfter）。
 *   §六   降级三档：off > prefers-reduced-motion / ui.effectLevel=reduced > full；
 *         降级后主题名与可切性不减少；玻璃拟态在降级态退化为不透明（style.css 的
 *         html[data-fx-level="reduced|off"] 规则）；失焦/后台 pause（不跳变）。
 *   §六.5 自动降级：__themeProbe 连续 2 个窗口 fps<55 或 dropRate≥2% → 先关粒子、
 *         再关移动光晕（点击反馈始终保留），原因写进 __themeState().fxDegraded（不静默）。
 *
 * 粒子口径（2026-11-17 Owner 追加要求，覆盖旧「大直径凑 3% 覆盖率」口径）：
 *   · 数量按**面积密度**：densityPerMpx 默认 150–190 颗/百万像素（1920×1080 ≈ 311–394）；
 *   · 单颗**小**：直径 2–3px（不再用大光斑反推覆盖率）；
 *   · 颜色跟皮肤：深色档取 `--theme-accent`、浅色档（暖白）取 `--text`（深色+低透明），
 *     每颗带色相 ±hueJitterDeg、亮度 ±lightnessJitter 抖动，透明度 0.2–0.45；
 *   · 旧「可见像素占比 ≥3%」这一条由 PM 改卷；本文件照旧**同时**给出
 *     count / minDiameterPx / maxDiameterPx 与 pixelRatioPct 两套口径，供按新口径复算。
 *
 * ----------------------------------------------------------------------------
 * __themeState().fx.sample()（同步；AC13–AC16 的唯一取数口 / README 式契约）
 * 顶层：
 *   ok         boolean   取数是否成功（false=PROBE_UNAVAILABLE，判不合格）
 *   at         number    采样时刻（Date.now，ms）
 *   grid       number    固定 8（卷 §四.3 写死的 8×8 网格）
 *   ratioPct   number    全画布「与背景亮度差 ≥15」的像素占比（百分比 0–100）
 *   centerCells number   中央 50%（cellX∈[2,5]、cellY∈[2,5]，共 16 格）中「至少 1 个
 *                        像素亮度差 ≥15」的格子数
 *   bgLum      number    背景亮度（0–255；取主题 --bg token 的 WCAG 相对亮度近似）
 *   particles  { count, configCount, minDiameterPx, maxDiameterPx, radiusPx,
 *                densityPerMpx, distinctColors, opacityRange:[min,max],
 *                maxBrightnessDelta, pixelRatioPct, centerCells, composite,
 *                color, colorSource, paletteSize, canvas:{w,h,ok}, attr }
 *              count=实际渲染粒子数（也写在 canvas 的 data-fx-particles 上）；
 *              min/maxDiameterPx=单颗直径（CSS px，新口径 2–3）；densityPerMpx=面积密度；
 *              distinctColors=去重后的颜色数（>1 才算「不是一片同色块」）；
 *              opacityRange=单颗不透明度上下限（0.2–0.45）；maxBrightnessDelta=实测最大
 *              亮度差（0–255）；pixelRatioPct 同顶层 ratioPct（旧口径，留着待复算）。
 *   clicks     { count, p95Ms, sizePx, sizeRangePx, minDiameterPx, opacityRange:[min,max],
 *                maxBrightnessPct, lastAt, invisible, samples }
 *              p95Ms=点击事件（捕获阶段 performance.now）→ [data-fx-click] 首帧可见
 *              的 p95（AC13 ≤120）；sizePx=本次涟漪直径（Owner 口径 48–56，默认 52）；
 *              minDiameterPx=涟漪元素直径最小值（AC13 ≥48，改小尺寸后仍不得低于 48）；
 *              opacityRange=涟漪描边不透明度上下限；maxBrightnessPct=涟漪描边相对背景的
 *              亮度差百分比（AC13 ≥10%）。
 *   move       { count, p95Ms, sizePx, sizeRangePx, opacityRange, configuredOpacityRange,
 *                maxDistancePx, visible, samples }
 *              p95Ms=mousemove → rAF 跟随更新位置的 p95（AC14 ≤80）；sizePx=本次光晕直径
 *              （Owner 口径 24–30）；opacityRange=实际不透明度（配置区间 0.15–0.25）；
 *              maxDistancePx=光晕中心与光标坐标的最大距离（CSS px，AC14 ≤64）。
 *   hitTest    { points[{x,y,hit,node}], hitCount, ratio, pointerEventsAfter,
 *                sampledWith:'temp-auto', webviewRect, windowSize, layer:{ parentIsBody,
 *                position, zIndex, zIndexNumeric, dshViewZIndex, dshViewZIndexNumeric,
 *                isolationChain[], stackingOk } }
 *              AC16：hitCount ≥23（25 点）且 pointerEventsAfter==='none' 且
 *              layer.stackingOk=true。
 *   degrade    { level, reasons[], paused, pausedReason, effectLevelAttr, fxModeAttr }
 *              level ∈ full|reduced|off；reasons 逐条写「为什么降级」；paused=失焦/后台暂停。
 *   perf       { fps, p95FrameMs, dropRate, memMB, frames, sampleMs, at, source }
 *              AC6 四项；优先用最近一次 __themeProbe 的结果（source='themeProbe'），
 *              否则用本层滚动帧间隔统计（source='rolling'）；memMB 由主进程
 *              app.getAppMetrics() 经 preload IPC 取，取不到记 null（不编数）。
 *   fxDegraded { active, steps[], reason, at }  §六.5 自动降级（不静默）。
 * 单位：直径/距离=CSS px；时延=ms；占比=百分比（0–100）；亮度差=0–255 通道值。
 *
 * ----------------------------------------------------------------------------
 * 全局作用域纪律（B-20261116-101950-212b）：整份文件包在 IIFE 里，**顶层零声明**，
 * 只向 window 暴露一个命名空间 `AWB_FX`；app.js 只通过 window.AWB_FX 调用。
 * ========================================================================== */
(function () {
  'use strict';

  var W = typeof window !== 'undefined' ? window : null;
  var D = typeof document !== 'undefined' ? document : null;
  if (!W || !D) return;

  var LAYER_ID = 'fx-layer';
  var CANVAS_ID = 'awb-theme-particles';
  var GRID = 8;                 // §四.3 写死 8×8
  var BRIGHT_DELTA = 15;        // §四.3 亮度差阈值（0–255）
  var MAX_SAMPLES = 60;         // p95 样本上限（30 次点击/移动足够）
  var IDLE_AFTER_MS = 3000;     // 无输入 3 秒 → idle（AC7）
  var BG_FALLBACK = [21, 23, 29];
  var COLOR_RGB_FALLBACK = [79, 209, 255];

  /* ── 单一配置对象（Owner 还会微调：AWB_FX.config 即本对象的引用）──────────────
   * 改完调用 AWB_FX.sync({ reseed: true }) 让新参数立刻生效；不需要改代码。
   */
  var FX_CONFIG = {
    particle: {
      diameterPx: [2, 3],          // 单颗直径（CSS px，整数档）—— Owner：压到 2–3px
      densityPerMpx: [150, 190],   // 每百万像素多少颗（1920×1080 ≈ 311–394 颗）
      opacity: [0.2, 0.45],        // 单颗不透明度上下限
      hueJitterDeg: 12,            // 色相抖动 ±12°
      lightnessJitter: 0.1,        // 亮度抖动 ±10%
      hueSteps: 4,                 // 抖动量化档数（保证 distinctColors > 1 且可数）
      lightnessSteps: 3,
      opacitySteps: 4,
      maxCount: 2000               // 安全上限（?particles= 也夹在这里）
    },
    click: {
      sizePx: [52],              // 涟漪直径（Owner：48–56，默认 52；AC13 要求 ≥48）
      minDiameterPx: 48,         // 硬下限（任何取值都不许低于它，否则 AC13 直接红）
      opacity: [0.5, 0.9],       // 涟漪描边的不透明度上下限（动画首帧取上限）
      lifeMs: 780,               // 节点存活时间（动画 + 余量）
      fadeMs: 620                // 扩散动画时长
    },
    move: {
      sizePx: [24, 30],          // 移动光晕直径（Owner：压到 24–30px，别再是一坨大光斑）
      opacity: [0.15, 0.25],     // 光晕不透明度上下限
      blurPx: 0,                 // 额外的模糊半径一律不启用（尺寸已小，模糊会撑视觉尺寸）
      hideMs: 120                // 离开/失焦后移除时限（AC14 ≤200ms）
    },
    idleAfterMs: IDLE_AFTER_MS,
    degrade: {
      fpsMin: 40,              // T-dd65：55→40，连续 3 个越线窗口才自动降级
      dropRateMax: 2,
      windows: 3,
      recoverWindows: 2,       // T-dd65：连续 2 个健康窗口即恢复（原来 6）
      healthyFpsMin: 55,       // 健康窗口判据：focused+visible 且 fps≥55、drop≤2（滞回，避免抖动）
      healthyDropRateMax: 2,
      degradeMove: false       // T-dd65：粒子的自动降级不再连带关移动光晕（move 独立）
    }
  };

  // __themeState().fx.sample 必须是可调用属性，但 __themeState() 的返回值还要能被
  // Electron executeJavaScript / structuredClone 序列化（函数不能克隆）。
  // 解法：sample 只挂在原型上 —— 调用照旧是 fx.sample()，序列化只看自有可枚举属性。
  var FX_SAMPLE_PROTO = Object.freeze({ sample: sample });

  function now() { return (W.performance && typeof W.performance.now === 'function') ? W.performance.now() : Date.now(); }

  var S = {
    mode: 'full',
    reasons: [],
    layer: null,
    canvas: null,
    ctx: null,
    buckets: [],
    parts: [],
    palette: [],
    cfg: null,
    seedKey: '',
    raf: 0,
    running: false,
    idle: false,
    lastInput: 0,
    lastFrame: 0,
    lastDraw: 0,
    bound: false,
    paused: false,
    pausedReason: '',
    clicks: { count: 0, latencies: [], diameters: [], lastAt: 0, invisible: 0, sizePx: null, opacity: null },
    move: { count: 0, latencies: [], maxDistancePx: 0, el: null, hideTimer: 0, pending: null, sizePx: null, opacity: null },
    perf: { intervals: [], lastProbe: null, memMB: null, lastMemAt: 0 },
    degraded: { healthyWindows: 0, particles: false, move: false, reason: '', at: 0, badWindows: 0, skippedHidden: 0, lastSkipAt: 0, lastRecoverAt: 0, lastRecoverReason: '' },
    // 诊断用：记录每次 pause/resume，方便自检看出「为什么粒子停了」（不参与渲染）
    pauseLog: []
  };

  /* ── 小工具 ─────────────────────────────────────────────────────────── */

  function clamp(n, lo, hi) { return n < lo ? lo : (n > hi ? hi : n); }

  function p95(list) {
    if (!list || !list.length) return null;
    var sorted = list.slice().sort(function (a, b) { return a - b; });
    var idx = Math.ceil(0.95 * sorted.length) - 1;
    if (idx < 0) idx = 0;
    return Math.round(sorted[idx] * 100) / 100;
  }

  function parseColor(raw) {
    var text = String(raw || '').trim();
    if (!text) return null;
    var m = /^#([0-9a-f]{3})$/i.exec(text);
    if (m) {
      return [parseInt(m[1][0] + m[1][0], 16), parseInt(m[1][1] + m[1][1], 16), parseInt(m[1][2] + m[1][2], 16)];
    }
    m = /^#([0-9a-f]{6})$/i.exec(text);
    if (m) {
      return [parseInt(m[1].slice(0, 2), 16), parseInt(m[1].slice(2, 4), 16), parseInt(m[1].slice(4, 6), 16)];
    }
    m = /^rgba?\(([^)]+)\)$/i.exec(text);
    if (m) {
      var parts = m[1].split(/[,/]/).map(function (v) { return Number(String(v).trim()); });
      if (parts.length >= 3 && parts.slice(0, 3).every(function (v) { return isFinite(v); })) {
        return [clamp(Math.round(parts[0]), 0, 255), clamp(Math.round(parts[1]), 0, 255), clamp(Math.round(parts[2]), 0, 255)];
      }
    }
    return null;
  }

  function lumOf(rgb) { return 0.2126 * rgb[0] + 0.7152 * rgb[1] + 0.0722 * rgb[2]; }

  function cssVarRgb(name) {
    try { return parseColor(W.getComputedStyle(D.documentElement).getPropertyValue(name)); }
    catch (e) { return null; }
  }

  function bgColor() { return cssVarRgb('--bg') || BG_FALLBACK; }

  /** rgb → hsl（h:0–360, s/l:0–1） */
  function rgbToHsl(rgb) {
    var r = rgb[0] / 255;
    var g = rgb[1] / 255;
    var b = rgb[2] / 255;
    var max = Math.max(r, g, b);
    var min = Math.min(r, g, b);
    var l = (max + min) / 2;
    var h = 0;
    var s = 0;
    if (max !== min) {
      var d = max - min;
      s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
      if (max === r) h = (g - b) / d + (g < b ? 6 : 0);
      else if (max === g) h = (b - r) / d + 2;
      else h = (r - g) / d + 4;
      h *= 60;
    }
    return { h: h, s: s, l: l };
  }

  /** hsl → rgb（0–255 整数） */
  function hslToRgb(h, s, l) {
    h = ((h % 360) + 360) % 360;
    var c = (1 - Math.abs(2 * l - 1)) * s;
    var hp = h / 60;
    var x = c * (1 - Math.abs((hp % 2) - 1));
    var r1 = 0;
    var g1 = 0;
    var b1 = 0;
    if (hp < 1) { r1 = c; g1 = x; } else if (hp < 2) { r1 = x; g1 = c; } else if (hp < 3) { g1 = c; b1 = x; } else if (hp < 4) { g1 = x; b1 = c; } else if (hp < 5) { r1 = x; b1 = c; } else { r1 = c; b1 = x; }
    var m = l - c / 2;
    return [
      clamp(Math.round((r1 + m) * 255), 0, 255),
      clamp(Math.round((g1 + m) * 255), 0, 255),
      clamp(Math.round((b1 + m) * 255), 0, 255)
    ];
  }

  /**
   * 皮肤取色（Owner：不能自己写死十六进制，要从主题变量取）：
   *  · 深色档：主色 = --theme-accent（科技青 / 暗金 / 动漫粉 / 玻璃蓝），lighter 叠加发光；
   *  · 浅色档（暖白 native-light）：主色 = --text（深色字色）+ source-over，深色低透明；
   *  · 两档都额外带上 --theme-accent 的少量混色，避免整屏一片同色。
   */
  function themeParticles() {
    var light = String(D.documentElement.getAttribute('data-theme') || 'dark') === 'light';
    var accent = cssVarRgb('--theme-accent') || COLOR_RGB_FALLBACK;
    var text = cssVarRgb('--text') || [235, 240, 245];
    if (light) {
      return { rgb: text, secondary: accent, composite: 'source-over', isLight: true, colorSource: '--text' };
    }
    return { rgb: accent, secondary: text, composite: 'lighter', isLight: false, colorSource: '--theme-accent' };
  }

  /* ── 容器 / 画布 ─────────────────────────────────────────────────────── */

  function ensureLayer() {
    var el = D.getElementById(LAYER_ID);
    if (!el) {
      el = D.createElement('div');
      el.id = LAYER_ID;
      el.setAttribute('aria-hidden', 'true');
    }
    // §一.1：#fx-layer 必须是 body 直接子元素，层级稳定（不插在别的容器里）。
    if (el.parentElement !== D.body) D.body.appendChild(el);
    el.setAttribute('data-fx-layer', 'on');
    if (!el.getAttribute('data-fx-mode')) el.setAttribute('data-fx-mode', S.mode);
    S.layer = el;
    return el;
  }

  function ensureCanvas() {
    var layer = ensureLayer();
    var c = D.getElementById(CANVAS_ID);
    if (!c) {
      c = D.createElement('canvas');
      c.id = CANVAS_ID;
      c.setAttribute('aria-hidden', 'true');
    }
    if (c.parentElement !== layer) layer.insertBefore(c, layer.firstChild);
    if (!c.getAttribute('data-fx-particles')) c.setAttribute('data-fx-particles', '0');
    if (S.canvas !== c || !S.ctx) {
      S.canvas = c;
      try { S.ctx = c.getContext('2d'); } catch (e) { S.ctx = null; }
    }
    return c;
  }

  function resizeCanvas() {
    var c = ensureCanvas();
    var layer = ensureLayer();
    var w = Math.max(1, Math.round(layer.clientWidth || W.innerWidth || 1));
    var h = Math.max(1, Math.round(layer.clientHeight || W.innerHeight || 1));
    if (c.width !== w) c.width = w;
    if (c.height !== h) c.height = h;
    return c;
  }

  function clearCanvas() {
    if (!S.ctx || !S.canvas) return;
    try {
      S.ctx.setTransform(1, 0, 0, 1, 0, 0);
      S.ctx.clearRect(0, 0, S.canvas.width, S.canvas.height);
    } catch (e) { /* ignore */ }
  }

  /** 面积密度 → 粒子数（?particles= 可覆盖，上限 maxCount） */
  function particlePlan(w, h) {
    var cfg = FX_CONFIG.particle;
    var areaMpx = Math.max(0.0001, (w * h) / 1000000);
    var lo = Number(cfg.densityPerMpx[0]);
    var hi = Number(cfg.densityPerMpx[1]);
    if (!isFinite(lo)) lo = 150;
    if (!isFinite(hi)) hi = lo;
    var density = lo + Math.random() * Math.max(0, hi - lo);
    var count = Math.round(areaMpx * density);
    var override = null;
    try {
      var raw = new URLSearchParams((W.location && W.location.search) || '').get('particles');
      if (raw != null && raw !== '') override = Number(raw);
    } catch (e) { /* ignore */ }
    if (override != null && isFinite(override)) count = Math.round(override);
    count = clamp(count, 0, Math.max(0, Math.round(Number(cfg.maxCount) || 2000)));
    return { count: count, densityPerMpx: Math.round((count / areaMpx) * 10) / 10, areaMpx: Math.round(areaMpx * 1000) / 1000 };
  }

  function particleCount() { return particlePlan(1, 1).count === 0 ? 0 : (S.cfg ? S.cfg.count : 0); }

  /* ── 粒子：小直径 + 面积密度 + 皮肤色抖动（Owner 2026-11-17 口径） ─────────── */

  /** 由配置生成调色板（hue × lightness × opacity 量化），并预渲染每档 sprite */
  function buildPalette(base, themeConf) {
    var cfg = FX_CONFIG.particle;
    var hsl = rgbToHsl(base.rgb);
    var secondaryHsl = themeConf.secondary ? rgbToHsl(themeConf.secondary) : null;
    var hueSteps = Math.max(1, Math.round(Number(cfg.hueSteps) || 4));
    var lightSteps = Math.max(1, Math.round(Number(cfg.lightnessSteps) || 3));
    var opSteps = Math.max(1, Math.round(Number(cfg.opacitySteps) || 4));
    var opLo = Number(cfg.opacity[0]);
    var opHi = Number(cfg.opacity[1]);
    if (!isFinite(opLo)) opLo = 0.2;
    if (!isFinite(opHi)) opHi = 0.45;
    var hueJitter = Number(cfg.hueJitterDeg) || 0;
    var lightJitter = Number(cfg.lightnessJitter) || 0;
    var palette = [];
    var seen = {};
    for (var hi = 0; hi < hueSteps; hi += 1) {
      var hueT = hueSteps === 1 ? 0 : (hi / (hueSteps - 1)) * 2 - 1;
      for (var li = 0; li < lightSteps; li += 1) {
        var lightT = lightSteps === 1 ? 0 : (li / (lightSteps - 1)) * 2 - 1;
        // 每个色相档交替向 --theme-accent / --text 混一点，避免整屏同色
        var hueBase = hsl.h + hueT * hueJitter;
        if (secondaryHsl && hueSteps > 1 && hi % 2 === 1) {
          hueBase = hiveMixHue(hsl.h, secondaryHsl.h, 0.25) + hueT * hueJitter;
        }
        var lightBase = hsl.l * (1 + lightT * lightJitter);
        var rgb = hslToRgb(hueBase, clamp(hsl.s, 0.15, 1), clamp(lightBase, 0.05, 0.95));
        for (var oi = 0; oi < opSteps; oi += 1) {
          var alpha = opSteps === 1 ? (opLo + opHi) / 2 : opLo + (opHi - opLo) * (oi / (opSteps - 1));
          alpha = Math.round(alpha * 1000) / 1000;
          var css = 'rgba(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ',' + Math.round(alpha * 100) / 100 + ')';
          if (seen[css]) continue;
          seen[css] = true;
          palette.push({ rgb: rgb, alpha: alpha, css: css, sprite: buildSprite(rgb) });
        }
      }
    }
    if (!palette.length) {
      palette.push({ rgb: base.rgb, alpha: (opLo + opHi) / 2, css: 'rgba(' + base.rgb[0] + ',' + base.rgb[1] + ',' + base.rgb[2] + ',' + ((opLo + opHi) / 2).toFixed(2) + ')', sprite: buildSprite(base.rgb) });
    }
    return palette;
  }

  function hiveMixHue(a, b, t) {
    var diff = ((b - a + 540) % 360) - 180;
    return a + diff * t;
  }

  /** 单颗 sprite：8×8 画布上的软圆点（缩到 2–3px 时边缘自然柔化） */
  function buildSprite(rgb) {
    var size = 8;
    var c = D.createElement('canvas');
    c.width = size;
    c.height = size;
    var ctx = c.getContext('2d');
    if (!ctx) return c;
    var center = size / 2;
    var radius = center - 0.5;
    var grad = ctx.createRadialGradient(center, center, 0, center, center, radius);
    var text = rgb[0] + ',' + rgb[1] + ',' + rgb[2];
    grad.addColorStop(0, 'rgba(' + text + ',1)');
    grad.addColorStop(0.55, 'rgba(' + text + ',0.85)');
    grad.addColorStop(1, 'rgba(' + text + ',0)');
    ctx.fillStyle = grad;
    ctx.beginPath();
    ctx.arc(center, center, radius, 0, Math.PI * 2);
    ctx.fill();
    return c;
  }

  function seedParticles(canvas, plan, themeConf) {
    var w = canvas.width;
    var h = canvas.height;
    var cfg = FX_CONFIG.particle;
    var palette = buildPalette(themeConf, themeConf);
    var rawD = cfg.diameterPx || [2, 3];
    var dLo = Math.max(1, Math.round(Number(rawD[0]) || 2));
    var dHi = Math.max(dLo, Math.round(Number(rawD[1]) || dLo));
    S.palette = palette;
    S.buckets = palette.map(function () { return []; });
    var parts = [];
    var n = plan.count;
    var cols = Math.max(1, Math.round(Math.sqrt(n * (w / Math.max(1, h)))));
    if (cols > Math.max(1, n)) cols = Math.max(1, n);
    var rows = Math.max(1, Math.ceil(n / cols));
    var cellW = w / cols;
    var cellH = h / rows;
    for (var i = 0; i < n; i += 1) {
      var col = i % cols;
      var row = Math.floor(i / cols);
      var jx = 0.12 + Math.random() * 0.76;
      var jy = 0.12 + Math.random() * 0.76;
      var p = {
        x: col * cellW + jx * cellW,
        y: row * cellH + jy * cellH,
        d: dLo + Math.floor(Math.random() * (dHi - dLo + 1)),
        vx: (Math.random() - 0.5) * 0.18,
        vy: (Math.random() - 0.5) * 0.18,
        bucket: Math.floor(Math.random() * palette.length)
      };
      parts.push(p);
      S.buckets[p.bucket].push(p);
    }
    S.parts = parts;
    var alphas = palette.map(function (item) { return item.alpha; });
    var sizes = parts.map(function (item) { return item.d; });
    S.cfg = {
      count: n,
      minDiameterPx: sizes.length ? Math.min.apply(null, sizes) : dLo,
      maxDiameterPx: sizes.length ? Math.max.apply(null, sizes) : dHi,
      radiusPx: sizes.length ? Math.round((sizes.reduce(function (a, b) { return a + b; }, 0) / sizes.length / 2) * 100) / 100 : dLo / 2,
      densityPerMpx: plan.densityPerMpx,
      areaMpx: plan.areaMpx,
      paletteSize: palette.length,
      distinctColors: palette.length,
      opacityRange: [Math.min.apply(null, alphas), Math.max.apply(null, alphas)],
      composite: themeConf.composite,
      color: 'rgb(' + themeConf.rgb[0] + ',' + themeConf.rgb[1] + ',' + themeConf.rgb[2] + ')',
      colorSource: themeConf.colorSource,
      paletteSample: palette.slice(0, 6).map(function (item) { return item.css; })
    };
    if (S.canvas) S.canvas.setAttribute('data-fx-particles', String(n));
  }

  function ensureParticles() {
    var c = resizeCanvas();
    var themeConf = themeParticles();
    var plan = particlePlan(c.width, c.height);
    var key = [c.width, c.height, plan.count, themeConf.composite, themeConf.rgb.join(',')].join('|');
    if (key === S.seedKey && S.parts.length === plan.count) return;
    S.seedKey = key;
    if (!plan.count) {
      S.parts = [];
      S.buckets = [];
      S.palette = [];
      S.cfg = null;
      if (S.canvas) S.canvas.setAttribute('data-fx-particles', '0');
      clearCanvas();
      return;
    }
    seedParticles(c, plan, themeConf);
  }

  function drawParticles() {
    var ctx = S.ctx;
    var canvas = S.canvas;
    if (!ctx || !canvas || !S.parts.length) return;
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.globalCompositeOperation = (S.cfg && S.cfg.composite) || 'source-over';
    for (var bi = 0; bi < S.buckets.length; bi += 1) {
      var list = S.buckets[bi];
      if (!list.length) continue;
      var sprite = S.palette[bi] && S.palette[bi].sprite;
      if (!sprite) continue;
      for (var i = 0; i < list.length; i += 1) {
        var p = list[i];
        p.x += p.vx;
        p.y += p.vy;
        if (p.x < -4) p.x = canvas.width + 4;
        if (p.x > canvas.width + 4) p.x = -4;
        if (p.y < -4) p.y = canvas.height + 4;
        if (p.y > canvas.height + 4) p.y = -4;
        ctx.drawImage(sprite, p.x - p.d / 2, p.y - p.d / 2, p.d, p.d);
      }
    }
  }

  /* ── 降级档位：off > prefers-reduced-motion / effectLevel=reduced > full ── */

  function computeMode() {
    // 7a3b §6.1：应用级强制开关优先级最高（菜单仍然开启 / ?motion=1 / data-fx-force=1）。
    var forced = false;
    try { forced = new URLSearchParams((W.location && W.location.search) || '').get('motion') === '1'; } catch (e) { /* ignore */ }
    if (!forced) { try { forced = String(W.AWB_FX_FORCE_MOTION) === '1'; } catch (e) { /* ignore */ } }
    if (!forced) { try { forced = String(D.documentElement.getAttribute('data-fx-force') || '') === '1'; } catch (e) { /* ignore */ } }
    if (forced) return { level: 'full', reasons: ['forced:true'], forced: true };
    var level = String(D.documentElement.getAttribute('data-effect-level') || 'full');
    var reasons = [];
    var lowfx = false;
    try { lowfx = new URLSearchParams((W.location && W.location.search) || '').get('lowfx') === '1'; } catch (e) { /* ignore */ }
    var reduce = false;
    try { reduce = Boolean(W.matchMedia && W.matchMedia('(prefers-reduced-motion: reduce)').matches); } catch (e) { /* ignore */ }
    if (level === 'off' || lowfx) {
      reasons.push(level === 'off' ? 'effectLevel=off' : 'lowfx=1');
      return { level: 'off', reasons: reasons };
    }
    if (level === 'reduced') reasons.push('effectLevel=reduced');
    if (reduce) reasons.push('prefers-reduced-motion:reduce');
    return { level: reasons.length ? 'reduced' : 'full', reasons: reasons };
  }

  function degradedInfo() {
    var steps = [];
    if (S.degraded.particles) steps.push('particles');
    if (S.degraded.move) steps.push('move');
    return {
      active: steps.length > 0,
      steps: steps,
      reason: S.degraded.reason || '',
      at: S.degraded.at || null,
      lastRecoverAt: S.degraded.lastRecoverAt || null,
      lastRecoverReason: S.degraded.lastRecoverReason || '',
      // T-dd65：自动采样的跳过统计与窗口计数（隐藏/未聚焦不参与降级判定）。
      skippedHidden: S.degraded.skippedHidden || 0,
      lastSkipAt: S.degraded.lastSkipAt || null,
      badWindows: S.degraded.badWindows || 0,
      healthyWindows: S.degraded.healthyWindows || 0,
      windows: Number(FX_CONFIG.degrade.windows) || 3,
      recoverWindows: Number(FX_CONFIG.degrade.recoverWindows) || 2
    };
  }

  /** T-dd65：自动采样门——隐藏/未聚焦/暂停时不采样，避免把 20–30fps 的后台 rAF 当性能问题降级。 */
  function samplingAllowed() {
    try {
      if (S.paused) return false;
      if (D.hidden || D.visibilityState === 'hidden') return false;
      if (typeof D.hasFocus === 'function' && !D.hasFocus()) return false;
      return true;
    } catch (e) { return false; }
  }

  function samplingState() {
    var focused = null;
    try { focused = (typeof D.hasFocus === 'function') ? Boolean(D.hasFocus()) : null; } catch (e) { focused = null; }
    return {
      allowed: samplingAllowed(),
      focused: focused,
      hidden: Boolean(D.hidden),
      visibility: String(D.visibilityState || ''),
      paused: Boolean(S.paused),
      pausedReason: S.pausedReason || '',
      skippedHidden: S.degraded.skippedHidden || 0
    };
  }

  /**
   * T-dd65：自动采样唯一入口（loop 自采样与 __themeProbe 都走这里）。
   * 隐藏/未聚焦/暂停 → 跳过并计数，不喂 evaluateDegrade（否则后台 20–30fps 会被误判降级）。
   * 显式 AWB_FX.evaluateDegrade 供自检/夹具使用，不受此门限制。
   */
  function autoSample(perf, source) {
    if (!samplingAllowed()) {
      S.degraded.skippedHidden = (S.degraded.skippedHidden || 0) + 1;
      S.degraded.lastSkipAt = Date.now();
      return { skipped: true, reason: 'hidden-or-unfocused', state: samplingState() };
    }
    evaluateDegrade(perf, source || 'auto');
    return { skipped: false, state: samplingState() };
  }

  /* ── 循环 ───────────────────────────────────────────────────────────── */

  function startLoop() {
    if (S.running) return;
    S.running = true;
    S.lastFrame = 0;
    S.lastDraw = 0;
    S.raf = W.requestAnimationFrame(loop);
  }

  function stopLoop() {
    if (S.raf) {
      try { W.cancelAnimationFrame(S.raf); } catch (e) { /* ignore */ }
      try { W.clearTimeout(S.raf); } catch (e) { /* ignore */ }
    }
    S.raf = 0;
    S.running = false;
    S.lastFrame = 0;
  }

  function loop(ts) {
    S.raf = 0;
    if (!S.running) return;
    if (S.lastFrame) {
      var gap = ts - S.lastFrame;
      if (gap > 0 && gap < 500) {
        S.perf.intervals.push(gap);
        if (S.perf.intervals.length > 240) S.perf.intervals.shift();
      }
    }
    S.lastFrame = ts;
    // 7a3b §6.2 / AC3：自采样接线（≥2s 且样本足够才参与统计；不调用 __themeProbe）。
    // T-dd65：隐藏/未聚焦/暂停时 autoSample 直接跳过，不产生降级判定。
    try {
      var perfNow = Date.now();
      if (S.mode === 'full' && S.perf.intervals.length >= 60 && (!S.perf.selfAt || perfNow - S.perf.selfAt >= 2000)) {
        S.perf.selfAt = perfNow;
        autoSample(rollingPerf(), 'rolling');
      }
    } catch (e) { /* 自采样异常不影响绘制 */ }
    S.idle = (Date.now() - S.lastInput) > FX_CONFIG.idleAfterMs;
    var minGap = S.idle ? (1000 / 30) : 0;   // 无输入 3 秒后 ≤30fps（AC7）
    if (S.move.pending) applyMovePending();
    if (S.parts.length && (!S.lastDraw || (ts - S.lastDraw) >= minGap)) {
      S.lastDraw = ts;
      drawParticles();
    }
    if (S.running) {
      // AC2 归因（T-32a3）：空闲且无粒子时不跟高刷 rAF 空转（实测 ~155 次/秒、造成 GC/长任务），
      // 降为 30fps 的 setTimeout；有粒子或非空闲仍走 rAF 保动画质量。
      if (S.idle && !S.parts.length) {
        S.raf = W.setTimeout(function () {
          S.raf = 0;
          if (!S.running) return;
          loop(W.performance && W.performance.now ? W.performance.now() : Date.now());
        }, 33);
      } else {
        S.raf = W.requestAnimationFrame(loop);
      }
    }
  }

  /* ── 点击涟漪（AC13）────────────────────────────────────────────────── */

  /** 从配置区间取一个数（[a] 或 [a,b]） */
  function pickInRange(range, fallback) {
    var lo = Number(range && range[0]);
    var hi = Number(range && range.length > 1 ? range[1] : range && range[0]);
    if (!isFinite(lo)) lo = fallback;
    if (!isFinite(hi)) hi = lo;
    if (hi < lo) { var tmp = lo; lo = hi; hi = tmp; }
    return Math.round((lo + Math.random() * (hi - lo)) * 100) / 100;
  }

  function spawnRipple(x, y) {
    var t0 = now();
    var layer = ensureLayer();
    var cfg = FX_CONFIG.click || {};
    // AC13 硬下限：涟漪直径 ≥48px（取值区间是 [48,56]，默认 52）
    var minPx = Math.max(48, Number(cfg.minDiameterPx) || 48);
    var size = Math.max(minPx, Math.round(pickInRange(cfg.sizePx, 52)));
    var opLo = Number(cfg.opacity && cfg.opacity[0]);
    var opHi = Number(cfg.opacity && cfg.opacity[1]);
    if (!isFinite(opLo)) opLo = 0.5;
    if (!isFinite(opHi)) opHi = 0.9;
    var el = D.createElement('span');
    el.setAttribute('data-fx-click', '');
    el.setAttribute('aria-hidden', 'true');
    el.style.left = x + 'px';
    el.style.top = y + 'px';
    el.style.width = size + 'px';
    el.style.height = size + 'px';
    el.style.marginLeft = (-size / 2) + 'px';
    el.style.marginTop = (-size / 2) + 'px';
    el.style.setProperty('--fx-click-size', size + 'px');
    el.style.setProperty('--fx-click-opacity-max', String(Math.round(opHi * 100) / 100));
    el.style.setProperty('--fx-click-opacity-mid', String(Math.round(((opLo + opHi) / 2) * 100) / 100));
    el.style.setProperty('--fx-click-fade', Math.max(120, Math.round(Number(cfg.fadeMs) || 620)) + 'ms');
    el.style.setProperty('--fx-ripple-color', 'var(--theme-accent, #4fd1ff)');
    var ring = D.createElement('i');
    el.appendChild(ring);
    layer.appendChild(el);
    var rect = el.getBoundingClientRect();
    var dia = Math.max(rect.width, rect.height);
    if (dia > 0) {
      S.clicks.diameters.push(dia);
      if (S.clicks.diameters.length > MAX_SAMPLES) S.clicks.diameters.shift();
    }
    S.clicks.sizePx = size;
    S.clicks.opacity = [Math.round(opLo * 100) / 100, Math.round(opHi * 100) / 100];
    S.clicks.count += 1;
    S.clicks.lastAt = Date.now();
    var raf = W.requestAnimationFrame(function () {
      var r2 = el.getBoundingClientRect();
      var visible = false;
      try {
        var opacity = Number(W.getComputedStyle(el).opacity || '0');
        visible = r2.width > 0 && r2.height > 0 && opacity > 0;
      } catch (e) { visible = false; }
      if (visible) {
        S.clicks.latencies.push(now() - t0);   // 「点击事件 → 首帧可见」的时延（AC13 ≤120ms）
        if (S.clicks.latencies.length > MAX_SAMPLES) S.clicks.latencies.shift();
      } else {
        S.clicks.invisible += 1;
      }
    });
    W.setTimeout(function () {
      try { W.cancelAnimationFrame(raf); } catch (e) { /* ignore */ }
      if (el.parentElement) el.parentElement.removeChild(el);
    }, Math.max(300, Math.round(Number(cfg.lifeMs) || 780)));
  }

  function clickBrightnessPct() {
    var accent = cssVarRgb('--theme-accent') || COLOR_RGB_FALLBACK;
    var delta = Math.abs(lumOf(accent) - lumOf(bgColor()));
    return Math.round((delta / 255) * 1000) / 10;
  }

  /* ── 移动光晕（AC14）────────────────────────────────────────────────── */

  function ensureMoveEl() {
    if (S.move.el && S.move.el.parentElement) return S.move.el;
    var layer = ensureLayer();
    var cfg = FX_CONFIG.move || {};
    // Owner 口径：光晕直径压到 24–30px、透明度 0.15–0.25；颜色与粒子同源（主题变量）。
    var size = Math.max(8, Math.round(pickInRange(cfg.sizePx, 28)));
    var opLo = Number(cfg.opacity && cfg.opacity[0]);
    var opHi = Number(cfg.opacity && cfg.opacity[1]);
    if (!isFinite(opLo)) opLo = 0.15;
    if (!isFinite(opHi)) opHi = 0.25;
    var opacity = Math.round((opLo + Math.random() * Math.max(0, opHi - opLo)) * 1000) / 1000;
    var themeConf = themeParticles();
    var rgb = themeConf.rgb;
    var el = D.createElement('span');
    el.setAttribute('data-fx-move', '');
    el.setAttribute('aria-hidden', 'true');
    el.style.left = '0px';
    el.style.top = '0px';
    el.style.width = size + 'px';
    el.style.height = size + 'px';
    el.style.setProperty('--fx-move-size', size + 'px');
    el.style.setProperty('--fx-move-opacity', String(opacity));
    el.style.setProperty('--fx-move-color', 'rgb(' + rgb[0] + ',' + rgb[1] + ',' + rgb[2] + ')');
    layer.appendChild(el);
    S.move.el = el;
    S.move.sizePx = size;
    S.move.opacity = opacity;
    return el;
  }

  function applyMovePending() {
    var pending = S.move.pending;
    if (!pending) return;
    S.move.pending = null;
    var el = ensureMoveEl();
    el.setAttribute('data-fx-hidden', '0');
    var size = el.offsetWidth || Number(FX_CONFIG.move.diameterPx) || 96;
    el.style.transform = 'translate3d(' + (pending.x - size / 2) + 'px,' + (pending.y - size / 2) + 'px,0)';
    var rect = el.getBoundingClientRect();
    var cx = rect.left + rect.width / 2;
    var cy = rect.top + rect.height / 2;
    var dist = Math.sqrt((cx - pending.x) * (cx - pending.x) + (cy - pending.y) * (cy - pending.y));
    if (dist > S.move.maxDistancePx) S.move.maxDistancePx = dist;
    S.move.latencies.push(now() - pending.t0);   // mousemove → rAF 跟随更新（AC14 ≤80ms）
    if (S.move.latencies.length > MAX_SAMPLES) S.move.latencies.shift();
    S.move.count += 1;
  }

  function hideMoveEl() {
    var el = S.move.el;
    if (!el) return;
    S.move.pending = null;
    el.setAttribute('data-fx-hidden', '1');
    if (S.move.hideTimer) { try { W.clearTimeout(S.move.hideTimer); } catch (e) { /* ignore */ } }
    S.move.hideTimer = W.setTimeout(function () {
      if (el.parentElement) el.parentElement.removeChild(el);
      if (S.move.el === el) S.move.el = null;
      el.setAttribute('data-fx-move', '');
    }, Math.max(30, Math.round(Number(FX_CONFIG.move.hideMs) || 120)));
  }

  function onMouseMove(event) {
    S.lastInput = Date.now();
    var moveOn = S.mode === 'full' && !S.degraded.move;
    if (!moveOn) {
      if (S.move.el) hideMoveEl();
      return;
    }
    var x = Number(event.clientX);
    var y = Number(event.clientY);
    if (!isFinite(x) || !isFinite(y)) return;
    ensureMoveEl();
    S.move.pending = { x: x, y: y, t0: now() };
  }

  /* ── 暂停 / 恢复：失焦、后台（不跳变） ───────────────────────────────── */

  function logPause(action, reason) {
    try {
      S.pauseLog.push({ at: Date.now(), action: action, reason: String(reason || ''), hidden: Boolean(D.hidden) });
      if (S.pauseLog.length > 20) S.pauseLog.shift();
    } catch (e) { /* ignore */ }
  }

  function pause(reason) {
    var wasPaused = S.paused;
    S.paused = true;
    S.pausedReason = String(reason || '');
    // 即使已经处于暂停态，也要把移动光晕收掉（AC14 要求失焦 200ms 内移除）
    hideMoveEl();
    stopLoop();
    if (!wasPaused) logPause('pause', S.pausedReason);
  }

  function resume() {
    if (!S.paused) return;
    S.paused = false;
    S.pausedReason = '';
    S.lastInput = Date.now();
    logPause('resume', '');
    if (S.mode !== 'off') startLoop();
  }

  /* ── 输入绑定（只绑一次）────────────────────────────────────────────── */

  function bindInput() {
    if (S.bound) return;
    S.bound = true;
    var touch = function () { S.lastInput = Date.now(); };
    W.addEventListener('mousemove', onMouseMove, true);
    W.addEventListener('mousedown', touch, true);
    W.addEventListener('keydown', touch, true);
    W.addEventListener('wheel', touch, { capture: true, passive: true });
    W.addEventListener('click', function (event) {
      S.lastInput = Date.now();
      if (S.mode === 'off') return;     // §六.4 off 三者全关（点击反馈也不画）
      var x = Number(event.clientX);
      var y = Number(event.clientY);
      if (!isFinite(x) || !isFinite(y)) return;
      spawnRipple(x, y);
    }, true);
    // 离开窗口（鼠标移出视口）→ 200ms 内淡出并移除光晕
    W.addEventListener('mouseout', function (event) {
      if (!event.relatedTarget && !event.toElement) hideMoveEl();
    }, true);
    W.addEventListener('blur', function () { pause('blur'); }, true);
    W.addEventListener('focus', function () { resume(); }, true);
    D.addEventListener('visibilitychange', function () {
      if (D.hidden || D.visibilityState === 'hidden') pause('hidden');
      else resume();
    });
    W.addEventListener('resize', function () {
      S.seedKey = '';
      if (S.mode === 'full' && !S.degraded.particles) { try { ensureParticles(); } catch (e) { /* ignore */ } }
    }, { passive: true });
    try {
      var mq = W.matchMedia ? W.matchMedia('(prefers-reduced-motion: reduce)') : null;
      if (mq) {
        var onChange = function () { sync(); };
        if (typeof mq.addEventListener === 'function') mq.addEventListener('change', onChange);
        else if (typeof mq.addListener === 'function') mq.addListener(onChange);
      }
    } catch (e) { /* ignore */ }
  }

  /* ── 应用档位 ───────────────────────────────────────────────────────── */

  /** 7a3b §6.3：诊断日志（渲染层 → 主进程 append data/fx.jsonl；失败静默不影响渲染）。 */
  var DIAG_LOG = [];
  function pushDiag(row) {
    try {
      DIAG_LOG.push(row);
      if (DIAG_LOG.length > 100) DIAG_LOG.shift();
    } catch (e) { /* ignore */ }
  }
  function logFxDiag(row) {
    pushDiag(row);
    try {
      if (W.workbench && typeof W.workbench.fxLog === 'function') W.workbench.fxLog(row).catch(function () { /* ignore */ });
    } catch (e) { /* 写盘失败不影响渲染 */ }
  }

  function sync(opts) {
    var options = opts && typeof opts === 'object' ? opts : {};
    var computed = computeMode();
    S.mode = computed.level;
    S.reasons = computed.reasons;
    var layer = ensureLayer();
    layer.setAttribute('data-fx-layer', 'on');
    layer.setAttribute('data-fx-mode', S.mode);
    try { D.documentElement.setAttribute('data-fx-level', S.mode); } catch (e) { /* ignore */ }
    var particlesOn = S.mode === 'full' && !S.degraded.particles;
    var moveOn = S.mode === 'full' && !S.degraded.move;
    if (!moveOn && S.move.el) hideMoveEl();
    if (!particlesOn) {
      S.parts = [];
      S.buckets = [];
      S.palette = [];
      S.cfg = null;
      S.seedKey = '';
      if (S.canvas) {
        clearCanvas();
        S.canvas.setAttribute('data-fx-particles', '0');
      }
    } else if (!options.keepSeed) {
      try { ensureParticles(); } catch (e) { /* 画布异常不影响主题 */ }
    }
    // T-77e4：覆盖窗已就绪且 DSH 在线时，壳内画布被 webview 盖住只会白耗 CPU/GPU → 停画并清空；
    // 覆盖窗创建失败/离线/降级时 overlayOwns=false，壳内照常绘制（降级兜底）。
    var overlayOwns = Boolean(particlesOn && W.__awbFxOverlayReady === true && W.__awbFxOverlayOnline === true);
    if (overlayOwns && S.canvas) {
      clearCanvas();
      S.canvas.setAttribute('data-fx-particles', '0');
    }
    if (S.mode === 'off' || overlayOwns) stopLoop();
    else if (!S.paused) startLoop();
    try {
      logFxDiag({
        ts: new Date().toISOString(),
        mode: S.mode,
        reasons: S.reasons.slice(),
        particles: S.canvas ? Number(S.canvas.getAttribute('data-fx-particles') || 0) : 0,
        canvasDisplay: S.canvas ? String((W.getComputedStyle && W.getComputedStyle(S.canvas).display) || '') : 'none',
        source: 'sync'
      });
    } catch (e) { /* 诊断失败不影响渲染 */ }
    try { notifyOverlay(); } catch (e) { /* 覆盖窗不可用时主窗画布仍兜底 */ }
    return { level: S.mode, reasons: S.reasons.slice() };
  }

  /* ── T-77e4：透明覆盖窗状态 + 连接态层级证据（不改主画布） ─────────────── */
  function overlayState() {
    var cfg = S.cfg || {};
    return {
      mode: S.mode,
      count: S.parts.length,
      colors: Array.isArray(cfg.paletteSample) ? cfg.paletteSample.slice(0, 6).map(String) : [],
      opacityRange: Array.isArray(cfg.opacityRange) ? cfg.opacityRange.slice(0, 2) : [0.15, 0.55],
      degraded: Boolean(S.degraded.particles),
      paused: Boolean(S.paused),
      enabled: S.mode === 'full' && !S.degraded.particles && !S.paused && S.parts.length > 0 && W.__awbFxOverlayOnline === true
    };
  }
  function notifyOverlay() {
    if (!W.workbench || typeof W.workbench.fxOverlayState !== 'function') return;
    try { W.workbench.fxOverlayState(overlayState()); } catch (e) { /* ignore */ }
  }
  /** 连接态层级证据：computed z-index/position、中心 elementFromPoint、webview 几何。 */
  function layerEvidence() {
    var layer = S.layer || D.getElementById('fx-layer');
    var webview = D.getElementById('dsh-view');
    var center = { x: Math.round((W.innerWidth || 0) / 2), y: Math.round((W.innerHeight || 0) / 2) };
    var hit = null;
    try { hit = D.elementFromPoint(center.x, center.y); } catch (e) { hit = null; }
    var styleOf = function (node) {
      if (!node || !W.getComputedStyle) return null;
      var cs = W.getComputedStyle(node);
      var r = node.getBoundingClientRect ? node.getBoundingClientRect() : null;
      return {
        id: String(node.id || ''), tag: String(node.tagName || '').toLowerCase(),
        zIndex: String(cs.zIndex || ''), position: String(cs.position || ''),
        display: String(cs.display || ''), visibility: String(cs.visibility || ''),
        rect: r ? { x: Math.round(r.x), y: Math.round(r.y), w: Math.round(r.width), h: Math.round(r.height) } : null
      };
    };
    return {
      at: Date.now(),
      viewport: { w: W.innerWidth, h: W.innerHeight },
      layer: styleOf(layer),
      layerIsBodyChild: Boolean(layer && layer.parentElement === D.body),
      webview: styleOf(webview),
      webviewSrc: webview ? String(webview.getAttribute('src') || '') : '',
      elementFromPoint: hit ? { id: String(hit.id || ''), tag: String(hit.tagName || '').toLowerCase(), className: String(hit.className || '') } : null,
      canvas: S.canvas ? { w: S.canvas.width, h: S.canvas.height, particles: Number(S.canvas.getAttribute('data-fx-particles') || 0) } : null,
      overlay: overlayState(),
      mode: S.mode
    };
  }

  /* ── 采样：粒子可见度（AC15 / 卷 §四.3） ──────────────────────────────── */

  function measureParticles() {
    var bg = bgColor();
    var bgLum = lumOf(bg);
    var out = {
      ratioPct: 0,
      centerCells: 0,
      maxDelta: 0,
      pixels: 0,
      brightPixels: 0,
      bgLum: Math.round(bgLum * 100) / 100,
      canvasW: 0,
      canvasH: 0,
      ok: true
    };
    var c = S.canvas;
    if (!c || !S.ctx || !c.width || !c.height) { out.ok = false; return out; }
    var data = null;
    try { data = S.ctx.getImageData(0, 0, c.width, c.height).data; } catch (e) {
      out.ok = false;
      return out;
    }
    var w = c.width;
    var h = c.height;
    out.canvasW = w;
    out.canvasH = h;
    out.pixels = w * h;
    if (!S.parts.length) return out;             // 无粒子：可见度 0（AC15 判不合格/或降级不算）
    var cfg = S.cfg || { composite: 'source-over' };
    var additive = cfg.composite === 'lighter';
    var cellW = w / GRID;
    var cellH = h / GRID;
    var cells = new Array(GRID * GRID);
    for (var k = 0; k < cells.length; k += 1) cells[k] = false;
    var maxDelta = 0;
    var bright = 0;
    var bgR = bg[0];
    var bgG = bg[1];
    var bgB = bg[2];
    for (var y = 0; y < h; y += 1) {
      var cellY = Math.min(GRID - 1, Math.floor(y / cellH));
      var rowBase = y * w;
      for (var x = 0; x < w; x += 1) {
        var idx = (rowBase + x) * 4;
        var alpha = data[idx + 3];
        if (alpha === 0) continue;
        var af = alpha / 255;
        var r;
        var g;
        var b;
        if (additive) {
          r = bgR + af * data[idx];
          g = bgG + af * data[idx + 1];
          b = bgB + af * data[idx + 2];
          if (r > 255) r = 255;
          if (g > 255) g = 255;
          if (b > 255) b = 255;
        } else {
          r = bgR * (1 - af) + data[idx] * af;
          g = bgG * (1 - af) + data[idx + 1] * af;
          b = bgB * (1 - af) + data[idx + 2] * af;
        }
        var lum = 0.2126 * r + 0.7152 * g + 0.0722 * b;
        var delta = lum > bgLum ? lum - bgLum : bgLum - lum;
        if (delta > maxDelta) maxDelta = delta;
        if (delta >= BRIGHT_DELTA) {
          bright += 1;
          var cellX = Math.min(GRID - 1, Math.floor(x / cellW));
          cells[cellY * GRID + cellX] = true;
        }
      }
    }
    var centerCells = 0;
    for (var cy = 2; cy <= 5; cy += 1) {
      for (var cx = 2; cx <= 5; cx += 1) {
        if (cells[cy * GRID + cx]) centerCells += 1;
      }
    }
    out.maxDelta = Math.round(maxDelta * 10) / 10;
    out.brightPixels = bright;
    out.ratioPct = Math.round((bright / out.pixels) * 100000) / 1000;  // 百分比，3 位小数
    out.centerCells = centerCells;
    return out;
  }

  /* ── 采样：层级 + 命中测试（AC16 / 卷 §一.2、§一.4） ───────────────────── */

  function layerInfo() {
    var layer = ensureLayer();
    var cs = W.getComputedStyle(layer);
    var dsh = D.getElementById('dsh-view');
    var dshCs = dsh ? W.getComputedStyle(dsh) : null;
    var zRaw = String(cs.zIndex || '');
    var zNum = /^-?\d+$/.test(zRaw) ? Number(zRaw) : null;
    var dshZRaw = dshCs ? String(dshCs.zIndex || 'auto') : 'auto';
    var dshZNum = /^-?\d+$/.test(dshZRaw) ? Number(dshZRaw) : 0;   // auto 按 0（卷 §一.2）
    var chain = [];
    var node = dsh ? dsh.parentElement : null;
    var guard = 0;
    while (node && node !== D.documentElement && guard < 40) {
      guard += 1;
      var s = W.getComputedStyle(node);
      var flags = [];
      if (s.transform && s.transform !== 'none') flags.push('transform');
      if (s.filter && s.filter !== 'none') flags.push('filter');
      if (s.isolation === 'isolate') flags.push('isolation');
      if (s.willChange && /transform|filter|opacity|perspective|isolation/.test(String(s.willChange))) flags.push('will-change:' + s.willChange);
      if (s.contain && s.contain !== 'none') flags.push('contain:' + s.contain);
      if (s.opacity !== '' && Number(s.opacity) < 1) flags.push('opacity:' + s.opacity);
      if (flags.length) {
        chain.push({
          node: node.id ? ('#' + node.id) : String(node.className || node.tagName || '').slice(0, 60),
          flags: flags
        });
      }
      node = node.parentElement;
    }
    var parentIsBody = layer.parentElement === D.body;
    var position = cs.position;
    var stackingOk = parentIsBody && position === 'fixed' && zNum !== null && zNum > dshZNum && chain.length === 0;
    return {
      parentIsBody: parentIsBody,
      position: position,
      zIndex: zRaw,
      zIndexNumeric: zNum,
      dshViewZIndex: dshZRaw,
      dshViewZIndexNumeric: dshZNum,
      isolationChain: chain,
      stackingOk: stackingOk
    };
  }

  function hitTest() {
    var layer = ensureLayer();
    var dsh = D.getElementById('dsh-view');
    var rect = null;
    if (dsh && typeof dsh.getBoundingClientRect === 'function') rect = dsh.getBoundingClientRect();
    if (!rect || !rect.width || !rect.height) {
      rect = { left: 0, top: 0, width: W.innerWidth || 1, height: W.innerHeight || 1 };
    }
    var coords = [];
    for (var i = 0; i < 5; i += 1) {
      for (var j = 0; j < 5; j += 1) {
        coords.push({
          x: Math.round(rect.left + rect.width * (0.1 + 0.8 * (i / 4))),
          y: Math.round(rect.top + rect.height * (0.1 + 0.8 * (j / 4)))
        });
      }
    }
    var points = [];
    var hitCount = 0;
    var prevInline = layer.style.pointerEvents;
    // §一.4：临时 auto → 采样 → 复位（elementFromPoint 会跳过 pointer-events:none 的元素）
    layer.style.pointerEvents = 'auto';
    void layer.offsetWidth;                                  // 强制样式/布局刷新
    void W.getComputedStyle(layer).pointerEvents;
    try {
      for (var k = 0; k < coords.length; k += 1) {
        var p = coords[k];
        var el = null;
        try { el = D.elementFromPoint(p.x, p.y); } catch (e) { el = null; }
        var hit = Boolean(el && (el === layer || layer.contains(el)));
        if (hit) hitCount += 1;
        points.push({
          x: p.x,
          y: p.y,
          hit: hit,
          node: el ? (el.id ? ('#' + el.id) : String(el.tagName || '').toLowerCase()) : null
        });
      }
    } finally {
      layer.style.pointerEvents = prevInline;                // 复位（常驻 none 不许被改成 auto）
    }
    var after = String(W.getComputedStyle(layer).pointerEvents || '');
    return {
      points: points,
      hitCount: hitCount,
      ratio: Math.round((hitCount / points.length) * 1000) / 10,
      pointerEventsAfter: after,
      sampledWith: 'temp-auto',
      method: 'document.elementFromPoint（elementsFromPoint 同样被 pointer-events:none 过滤，不得替代）',
      webviewRect: {
        left: Math.round(rect.left),
        top: Math.round(rect.top),
        width: Math.round(rect.width),
        height: Math.round(rect.height)
      },
      windowSize: { w: W.innerWidth || 0, h: W.innerHeight || 0 },
      layer: layerInfo()
    };
  }

  /* ── 采样：性能（AC6；缓存 __themeProbe 结果 + 本层滚动统计）───────────── */

  function rollingPerf() {
    var out = { fps: null, p95FrameMs: null, dropRate: null, frames: 0, sampleMs: 0, at: null, source: 'none' };
    var iv = S.perf.intervals;
    if (!iv.length) return out;
    var sum = 0;
    var drops = 0;
    for (var i = 0; i < iv.length; i += 1) {
      sum += iv[i];
      if (iv[i] > 25) drops += 1;
    }
    var sorted = iv.slice().sort(function (a, b) { return a - b; });
    var idx = Math.ceil(0.95 * sorted.length) - 1;
    if (idx < 0) idx = 0;
    out.frames = iv.length;
    out.sampleMs = Math.round(sum);
    out.fps = Math.round((iv.length / Math.max(1, sum)) * 1000 * 100) / 100;
    out.p95FrameMs = Math.round(sorted[idx] * 100) / 100;
    out.dropRate = Math.round((drops / iv.length) * 10000) / 100;
    out.at = Date.now();
    out.source = 'rolling';
    return out;
  }

  function perfSummary() {
    var out = rollingPerf();
    var probe = S.perf.lastProbe;
    if (probe) {
      out.fps = probe.fps;
      out.p95FrameMs = probe.p95FrameMs;
      out.dropRate = probe.dropRate;
      out.frames = probe.frames || out.frames;
      out.sampleMs = probe.sampleMs || out.sampleMs;
      out.at = probe.at || out.at;
      out.source = 'themeProbe';
    }
    out.memMB = (S.perf.memMB != null) ? S.perf.memMB : (probe && probe.memMB != null ? probe.memMB : null);
    out.memAt = S.perf.lastMemAt || null;
    return out;
  }

  /**
   * 7a3b §6.2 + T-dd65：降级判定单源。
   * - 自动路径（loop 自采样 / __themeProbe）先过 autoSample 的可见性门，隐藏/未聚焦不参与判定；
   * - 连续 3 个越线窗口才降级粒子（fpsMin 40）；粒子的降级不再连带关 move；
   * - 连续 2 个健康窗口（focused+visible、fps≥55、drop≤2）→ 清降级、恢复粒子、写 lastRecoverAt。
   * 显式调用本函数（自检/夹具）不受可见性门限制。
   */
  function evaluateDegrade(perf, source) {
    if (!perf || typeof perf !== 'object') return;
    var fps = Number(perf.fps);
    var drop = Number(perf.dropRate);
    var cfg = FX_CONFIG.degrade || {};
    var fpsMin = Number(cfg.fpsMin);
    var dropMax = Number(cfg.dropRateMax);
    var windows = Math.max(1, Math.round(Number(cfg.windows) || 3));
    var recoverWindows = Math.max(1, Math.round(Number(cfg.recoverWindows) || 2));
    var healthyFpsMin = Number(cfg.healthyFpsMin);
    var healthyDropMax = Number(cfg.healthyDropRateMax);
    if (!isFinite(fpsMin)) fpsMin = 40;
    if (!isFinite(dropMax)) dropMax = 2;
    if (!isFinite(healthyFpsMin)) healthyFpsMin = 55;
    if (!isFinite(healthyDropMax)) healthyDropMax = 2;
    var hasFps = isFinite(fps);
    var hasDrop = isFinite(drop);
    var bad = (hasFps && fps < fpsMin) || (hasDrop && drop >= dropMax);
    if (bad) {
      S.degraded.healthyWindows = 0;
      S.degraded.badWindows = (S.degraded.badWindows || 0) + 1;
      if (S.degraded.badWindows >= windows && S.mode === 'full') {
        if (!S.degraded.particles) {
          S.degraded.particles = true;
        } else if (cfg.degradeMove === true && !S.degraded.move) {
          // 仅当显式允许时才连带降 move（T-dd65 默认 false：move 不随 particles 降）。
          S.degraded.move = true;
        }
        S.degraded.at = Date.now();
        S.degraded.reason = '连续 ' + windows + ' 个' + (source === 'rolling' ? '自采样' : '__themeProbe')
          + '窗口越线（fps=' + fps + '、dropRate=' + drop + '）→ 按 T-dd65 仅自动降级粒子；'
          + '移动光晕与点击反馈保留（卷-2 §六.5）';
        S.degraded.badWindows = 0;
        pushDiag({ at: Date.now(), action: 'degrade', source: source || 'rolling', steps: degradedInfo().steps, fps: fps, dropRate: drop });
        sync({ keepSeed: true });
      }
      return;
    }
    // 健康窗口：必须 focused+visible（自动路径已由 autoSample 保证）且 fps≥55、drop≤2；
    // 连续 2 个后恢复（T-dd65：原 6 窗 + 只恢复 move 再恢复 particles 的串行逻辑改为一次恢复）。
    var healthy = (!hasFps || fps >= healthyFpsMin) && (!hasDrop || drop <= healthyDropMax);
    if (!healthy) { S.degraded.healthyWindows = 0; return; }
    if (!S.degraded.particles && !S.degraded.move) return;
    S.degraded.healthyWindows = (S.degraded.healthyWindows || 0) + 1;
    if (S.degraded.healthyWindows < recoverWindows) return;
    S.degraded.healthyWindows = 0;
    var restored = [];
    if (S.degraded.move) { S.degraded.move = false; restored.push('move'); }
    if (S.degraded.particles) { S.degraded.particles = false; restored.push('particles'); }
    S.degraded.reason = '已恢复（连续 ' + recoverWindows + ' 个健康窗口；恢复 ' + restored.join('+') + '）';
    S.degraded.at = Date.now();
    S.degraded.lastRecoverAt = Date.now();
    S.degraded.lastRecoverReason = '已恢复（' + restored.join('+') + '）';
    pushDiag({ at: Date.now(), action: 'recover', source: source || 'rolling', restored: restored.join('+'), reason: '已恢复', lastRecoverAt: S.degraded.lastRecoverAt });
    sync({ keepSeed: false });
  }

  function observeProbe(result) {
    if (!result || typeof result !== 'object') return;
    var fps = Number(result.fps);
    var p95 = result.p95FrameMs == null ? null : Number(result.p95FrameMs);
    var drop = Number(result.dropRate);
    var mem = result.memMB == null ? null : Number(result.memMB);
    S.perf.lastProbe = {
      fps: isFinite(fps) ? fps : null,
      p95FrameMs: p95 != null && isFinite(p95) ? p95 : null,
      dropRate: isFinite(drop) ? drop : null,
      memMB: mem != null && isFinite(mem) ? mem : null,
      frames: Number(result.frames) || 0,
      sampleMs: Number(result.sampleMs) || 0,
      at: Date.now()
    };
    if (mem != null && isFinite(mem)) { S.perf.memMB = mem; S.perf.lastMemAt = Date.now(); }
    // T-dd65：自动路径统一走 autoSample（隐藏/未聚焦不参与降级判定）。
    autoSample({ fps: isFinite(fps) ? fps : null, dropRate: isFinite(drop) ? drop : null }, 'themeProbe');
  }

  /* ── 对外：唯一取数口 + 状态 ────────────────────────────────────────── */

  function sample() {
    var vis = measureParticles();
    var hit = hitTest();
    var perf = perfSummary();
    var cfg = S.cfg || {};
    return {
      ok: true,
      at: Date.now(),
      grid: GRID,
      ratioPct: vis.ratioPct,
      centerCells: vis.centerCells,
      bgLum: vis.bgLum,
      particles: {
        count: S.parts.length,
        configCount: cfg.count || 0,
        minDiameterPx: cfg.minDiameterPx || 0,
        maxDiameterPx: cfg.maxDiameterPx || 0,
        radiusPx: cfg.radiusPx || 0,
        densityPerMpx: cfg.densityPerMpx == null ? null : cfg.densityPerMpx,
        areaMpx: cfg.areaMpx == null ? null : cfg.areaMpx,
        distinctColors: cfg.distinctColors || 0,
        paletteSize: cfg.paletteSize || 0,
        opacityRange: cfg.opacityRange || [0, 0],
        maxBrightnessDelta: vis.maxDelta,
        pixelRatioPct: vis.ratioPct,
        centerCells: vis.centerCells,
        composite: cfg.composite || '',
        color: cfg.color || '',
        colorSource: cfg.colorSource || '',
        paletteSample: cfg.paletteSample || [],
        canvas: S.canvas ? { w: vis.canvasW, h: vis.canvasH, ok: vis.ok } : null,
        attr: S.canvas ? String(S.canvas.getAttribute('data-fx-particles') || '') : ''
      },
      clicks: {
        count: S.clicks.count,
        p95Ms: p95(S.clicks.latencies),
        sizePx: S.clicks.sizePx,
        sizeRangePx: (FX_CONFIG.click && FX_CONFIG.click.sizePx) ? FX_CONFIG.click.sizePx.slice() : [52],
        minDiameterPx: S.clicks.diameters.length ? Math.round(Math.min.apply(null, S.clicks.diameters) * 100) / 100 : null,
        opacityRange: S.clicks.opacity || [0, 0],
        maxBrightnessPct: clickBrightnessPct(),
        lastAt: S.clicks.lastAt || null,
        invisible: S.clicks.invisible,
        samples: S.clicks.latencies.length
      },
      move: {
        count: S.move.count,
        p95Ms: p95(S.move.latencies),
        sizePx: S.move.sizePx,
        sizeRangePx: (FX_CONFIG.move && FX_CONFIG.move.sizePx) ? FX_CONFIG.move.sizePx.slice() : [28],
        opacityRange: S.move.opacity == null ? [0, 0] : [S.move.opacity, S.move.opacity],
        configuredOpacityRange: (FX_CONFIG.move && FX_CONFIG.move.opacity) ? FX_CONFIG.move.opacity.slice() : [0.15, 0.25],
        maxDistancePx: Math.round(S.move.maxDistancePx * 100) / 100,
        visible: Boolean(S.move.el),
        samples: S.move.latencies.length
      },
      hitTest: hit,
      degrade: {
        level: S.mode,
        reasons: S.reasons.slice(),
        paused: S.paused,
        pausedReason: S.pausedReason,
        running: S.running,
        pauseLog: S.pauseLog.slice(),
        effectLevelAttr: String(D.documentElement.getAttribute('data-effect-level') || ''),
        fxModeAttr: S.layer ? String(S.layer.getAttribute('data-fx-mode') || '') : '',
        sampling: samplingState()
      },
      perf: perf,
      fxDegraded: degradedInfo(),
      config: FX_CONFIG
    };
  }

  function themeStateFx() {
    var out = Object.create(FX_SAMPLE_PROTO);
    Object.assign(out, {
      mode: S.mode,
      level: S.mode,
      reasons: S.reasons.slice(),
      clickCount: S.clicks.count,
      moveVisible: Boolean(S.move.el),
      particleCount: S.parts.length,
      layerId: S.layer ? S.layer.id : '',
      layerIsBodyChild: Boolean(S.layer && S.layer.parentElement === D.body),
      paused: S.paused,
      idle: S.idle,
      fxDegraded: degradedInfo()
    });
    return out;
  }

  function effects(themeId) {
    var on = S.mode === 'full';
    return {
      mode: S.mode,
      particles: Boolean(on && !S.degraded.particles),
      grid: Boolean(on && themeId === 'tech-dark'),
      blur: Boolean(on && themeId === 'glass-dark'),
      bounce: Boolean(on && themeId === 'anime-dark'),
      idle: S.idle,
      particleCount: S.parts.length
    };
  }

  function describe() {
    var cfg = S.cfg || {};
    var alphas = S.palette.length ? S.palette.map(function (p) { return p.alpha; }) : [0];
    return {
      particleCount: S.parts.length,
      diameterMin: cfg.minDiameterPx || 0,
      diameterMax: cfg.maxDiameterPx || 0,
      rMin: cfg.minDiameterPx ? cfg.minDiameterPx / 2 : 0,
      rMax: cfg.maxDiameterPx ? cfg.maxDiameterPx / 2 : 0,
      alphaMin: Math.min.apply(null, alphas),
      alphaMax: Math.max.apply(null, alphas),
      composite: cfg.composite || '',
      canvas: Boolean(S.canvas && S.canvas.parentElement === S.layer),
      running: S.running,
      idle: S.idle,
      effectLevel: S.mode,
      config: FX_CONFIG,
      fx: themeStateFx()
    };
  }

  /** 自检用：清零点击/移动统计（不影响渲染与主题），让「本次交互」的数字可单独取 */
  function resetStats() {
    var moveEl = S.move.el;
    var hideTimer = S.move.hideTimer;
    S.clicks = { count: 0, latencies: [], diameters: [], lastAt: 0, invisible: 0, sizePx: null, opacity: null };
    S.move = {
      count: 0, latencies: [], maxDistancePx: 0, el: moveEl, hideTimer: hideTimer,
      pending: null, sizePx: S.move.sizePx, opacity: S.move.opacity
    };
    return { clicks: 0, move: 0 };
  }

  /**
   * T-dd65：手动清降级（自检/夹具用；生产恢复走 evaluateDegrade 的 2 健康窗）。
   * 清 flags 后 sync 重新播种；返回清前状态，便于断言。
   */
  function resetDegraded() {
    var before = degradedInfo();
    S.degraded.particles = false;
    S.degraded.move = false;
    S.degraded.reason = '';
    S.degraded.at = 0;
    S.degraded.badWindows = 0;
    S.degraded.healthyWindows = 0;
    sync({ keepSeed: false });
    return { before: before, after: degradedInfo() };
  }

  /** 改配置：浅合并后重播种（Owner 微调用，不用改代码） */
  function setConfig(patch) {
    if (patch && typeof patch === 'object') {
      Object.keys(patch).forEach(function (key) {
        var value = patch[key];
        if (value && typeof value === 'object' && !Array.isArray(value) && FX_CONFIG[key] && typeof FX_CONFIG[key] === 'object' && !Array.isArray(FX_CONFIG[key])) {
          Object.keys(value).forEach(function (sub) { FX_CONFIG[key][sub] = value[sub]; });
        } else {
          FX_CONFIG[key] = value;
        }
      });
    }
    S.seedKey = '';
    if (S.mode === 'full' && !S.degraded.particles) { try { ensureParticles(); } catch (e) { /* ignore */ } }
    return FX_CONFIG;
  }

  function init() {
    ensureLayer();
    ensureCanvas();
    bindInput();
    S.lastInput = Date.now();
    sync();
  }

  try { init(); } catch (error) { /* 特效层失效不影响主题与界面 */ }

  W.AWB_FX = {
    version: 'fe90-f7/2',
    init: init,
    sync: sync,
    sample: sample,
    themeStateFx: themeStateFx,
    overlayState: overlayState,
    layerEvidence: layerEvidence,
    notifyOverlay: notifyOverlay,
    describe: describe,
    effects: effects,
    particleCount: particleCount,
    observeProbe: observeProbe,
    evaluateDegrade: evaluateDegrade,
    autoSample: autoSample,
    samplingAllowed: samplingAllowed,
    samplingState: samplingState,
    resetDegraded: resetDegraded,
    diag: function () { return { rows: DIAG_LOG.slice(), degraded: degradedInfo(), perf: rollingPerf(), sampling: samplingState() }; },
    resetStats: resetStats,
    layerInfo: layerInfo,
    hitTest: hitTest,
    config: FX_CONFIG,
    setConfig: setConfig,
    mode: function () { return { level: S.mode, reasons: S.reasons.slice(), forced: S.reasons.indexOf('forced:true') >= 0 }; },
    degraded: degradedInfo
  };
  try { W.__fxLayerEvidence = layerEvidence; } catch (e) { /* ignore */ }
  // T-77e4：覆盖窗就绪/关闭时切换壳内绘制；状态订阅晚于创建时用一次 status 补齐。
  try {
    if (W.workbench && typeof W.workbench.onFxOverlayReady === 'function') {
      W.workbench.onFxOverlayReady(function (payload) {
        W.__awbFxOverlayReady = Boolean(payload && payload.ready === true);
        try { sync(); } catch (e) { /* ignore */ }
      });
    }
    if (W.workbench && typeof W.workbench.fxOverlayStatus === 'function') {
      W.workbench.fxOverlayStatus().then(function (status) {
        W.__awbFxOverlayReady = Boolean(status && status.ready === true);
        try { sync(); } catch (e) { /* ignore */ }
      }).catch(function () { /* ignore */ });
    }
  } catch (e) { /* ignore */ }
})();
