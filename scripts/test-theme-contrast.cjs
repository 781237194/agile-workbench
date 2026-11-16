#!/usr/bin/env node
'use strict';
/**
 * test-theme-contrast.cjs —— R-fe90 F-8 / AC10：5 档主题对比度表
 *
 * 取数：直接解析 `src/renderer/style.css` 的四个主题 token 块（唯一来源，不另抄一份色板）：
 *   · `:root{…}`                                   → native-dark（暗金）
 *   · `html[data-theme="light"]{…}`                → native-light（暖白）
 *   · `html[data-style="tech"][data-theme="dark"]`  → tech-dark（科技）
 *   · `html[data-style="anime"][data-theme="dark"]` → anime-dark（二次元）
 *   · `html[data-style="glass"][data-theme="dark"]` → glass-dark（玻璃拟态）
 *
 * 判据（AC10）：正文（--text）对背景（--bg）≥ 4.5:1；次要（--muted）≥ 3:1；accent（--gold）上压文字 ≥ 4.5:1。
 * 玻璃拟态按「最差背景两端」取更差算。**半透明面板（alpha<1）必须做 alpha 合成**（2026-11-17 修）：
 *   · 常态：面板叠加在自身 --bg 上（真实观感，列「正文/面板(常态)」）
 *   · 最差：面板叠加在纯白上（面板背后是浅色内容时的最差情况，列「白底」）
 *   · 判定值 bodyWorst = min(正文/背景, 白底)  —— 即 AC10 的「两端取更差」；
 *     旧版忽略 alpha、把 `rgba(255,255,255,.10)` 当实色白，导致「常态 13.33 / 白底 1.12」两种读数被
 *     混成一个假的 1.12（面板侧读数既非观感也非最差），故现拆成两列并把判定锚到白底。
 *
 * 退出码：0=全部达标；1=不达标；2=取数失败。
 * 用法：node scripts/test-theme-contrast.cjs [--json]
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const CSS = path.join(ROOT, 'src', 'renderer', 'style.css');
const THRESH = { body: 4.5, secondary: 3, onAccent: 4.5 };

if (!fs.existsSync(CSS)) { console.error('环境错误：找不到 src/renderer/style.css'); process.exit(2); }
const css = fs.readFileSync(CSS, 'utf8');

/** 取一个选择器块里的自定义属性（第一个匹配块） */
function blockOf(selector) {
  const at = css.indexOf(selector);
  if (at < 0) return null;
  const open = css.indexOf('{', at);
  const close = css.indexOf('}', open);
  if (open < 0 || close < 0) return null;
  const body = css.slice(open + 1, close);
  const vars = {};
  for (const m of body.matchAll(/--([\w-]+)\s*:\s*([^;]+);/g)) vars[m[1]] = m[2].trim();
  return vars;
}

const THEMES = [
  { id: 'native-dark', label: '暗金', block: blockOf(':root {'), introduced: false },
  { id: 'native-light', label: '暖白', block: blockOf('html[data-theme="light"]'), introduced: false },
  { id: 'tech-dark', label: '科技暗', block: blockOf('html[data-style="tech"][data-theme="dark"]'), introduced: true },
  { id: 'anime-dark', label: '二次元暗', block: blockOf('html[data-style="anime"][data-theme="dark"]'), introduced: true },
  { id: 'glass-dark', label: '玻璃拟态暗', block: blockOf('html[data-style="glass"][data-theme="dark"]'), introduced: true },
];

/** #rgb / #rrggbb / rgb(a) → { rgb:[r,g,b], alpha }（**保留 alpha**：半透明面板要按合成算） */
function parseColor(raw) {
  const v = String(raw || '').trim();
  let m = /^#([0-9a-f]{3})$/i.exec(v);
  if (m) return { rgb: m[1].split('').map((c) => parseInt(c + c, 16)), alpha: 1 };
  m = /^#([0-9a-f]{6})$/i.exec(v);
  if (m) return { rgb: [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)), alpha: 1 };
  m = /^rgba?\(\s*([\d.]+)\s*,\s*([\d.]+)\s*,\s*([\d.]+)\s*(?:[,/]\s*([\d.]+)\s*)?\)/i.exec(v);
  if (m) return { rgb: [Number(m[1]), Number(m[2]), Number(m[3])].map((n) => Math.round(n)), alpha: m[4] === undefined ? 1 : Number(m[4]) };
  return null;
}

/** 把前景色按 alpha 叠加到不透明背景上（sRGB 直插，够用且与 CSS 观感一致） */
function composite(fg, bg) {
  if (fg.alpha >= 1) return fg.rgb;
  return fg.rgb.map((c, i) => Math.round(c * fg.alpha + bg[i] * (1 - fg.alpha)));
}

function luminance([r, g, b]) {
  const f = (c) => {
    const s = c / 255;
    return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * f(r) + 0.7152 * f(g) + 0.0722 * f(b);
}

function ratio(a, b) {
  const la = luminance(a);
  const lb = luminance(b);
  const hi = Math.max(la, lb);
  const lo = Math.min(la, lb);
  return (hi + 0.05) / (lo + 0.05);
}

const rows = [];
const failures = [];
for (const t of THEMES) {
  if (!t.block) { failures.push(`${t.id}: 取不到 token 块（选择器或变量名变了）`); continue; }
  const bgP = parseColor(t.block.bg);
  const panelP = parseColor(t.block.panel);
  const textP = parseColor(t.block.text);
  const mutedP = parseColor(t.block.muted);
  const goldP = parseColor(t.block.gold);
  if (!bgP || !panelP || !textP || !mutedP || !goldP) {
    failures.push(`${t.id}: 变量缺失或颜色格式无法解析（需要 --bg/--panel/--text/--muted/--gold）`);
    continue;
  }
  const bg = bgP.rgb;
  const text = textP.rgb;
  const muted = mutedP.rgb;
  const gold = goldP.rgb;
  // 面板两种背景：常态＝叠加在自身 --bg；最差＝叠加在纯白（面板背后是浅色内容）
  const panelNormal = composite(panelP, bg);
  const panelWorst = composite(panelP, [255, 255, 255]);
  const onBg = ratio(text, bg);
  const onPanelNormal = ratio(text, panelNormal);
  const onPanelWorst = ratio(text, panelWorst);
  const secondary = ratio(muted, bg);
  // accent 是「文字/图标色」（本项目 --gold 实际用途是文字、描边、导轨，不是按钮底色），
  // 所以判据取「accent 作为文字压在背景上」；另附「深底字压在 accent 上」的读数供参考。
  const accentAsText = ratio(gold, bg);
  const onAccent = ratio(bg, gold);
  // AC10「两端取更差」：玻璃/半透明面板的判定值 = min(正文/背景, 正文/最差背景)
  const bodyWorst = Math.min(onBg, onPanelWorst);
  const row = {
    id: t.id, label: t.label,
    panelRaw: t.block.panel,
    panelAlpha: panelP.alpha,
    bodyOnBg: Number(onBg.toFixed(2)),
    bodyOnPanelNormal: Number(onPanelNormal.toFixed(2)),
    bodyOnPanelWorst: Number(onPanelWorst.toFixed(2)),
    bodyWorst: Number(bodyWorst.toFixed(2)),
    secondaryOnBg: Number(secondary.toFixed(2)),
    accentAsText: Number(accentAsText.toFixed(2)),
    textOnAccent: Number(onAccent.toFixed(2)),
    introduced: t.introduced,
  };
  const bad = [];
  if (bodyWorst < THRESH.body) bad.push(`正文最差 ${bodyWorst.toFixed(2)} < ${THRESH.body}`);
  if (secondary < THRESH.secondary) bad.push(`次要 ${secondary.toFixed(2)} < ${THRESH.secondary}`);
  if (accentAsText < THRESH.onAccent) bad.push(`accent 文字 ${accentAsText.toFixed(2)} < ${THRESH.onAccent}`);
  row.bad = bad;
  rows.push(row);
}

const asJson = process.argv.includes('--json');
if (asJson) {
  console.log(JSON.stringify({ ok: failures.length === 0 && rows.every((r) => r.bad.length === 0), rows, failures }, null, 2));
} else {
  console.log('主题对比度表（WCAG 2.x，比率：1.0 无对比 → 21 最强；半透明面板按 alpha 合成）');
  console.log('主题            | 正文/背景 | 正文/面板(常态) | 白底(最差) | 判定值 | 次要/背景 | accent文字 | 深底字/acc底 | 判定');
  console.log('----------------|-----------|-----------------|------------|--------|-----------|------------|--------------|------');
  for (const r of rows) {
    const verdict = r.bad.length === 0 ? '达标' : '不达标：' + r.bad.join('；');
    console.log(`${r.label.padEnd(7)}(${r.id})`.padEnd(16) + '|' +
      ` ${String(r.bodyOnBg).padStart(9)} | ${String(r.bodyOnPanelNormal).padStart(15)} | ${String(r.bodyOnPanelWorst).padStart(10)} | ${String(r.bodyWorst).padStart(6)} |` +
      ` ${String(r.secondaryOnBg).padStart(9)} | ${String(r.accentAsText).padStart(10)} | ${String(r.textOnAccent).padStart(12)} | ${verdict}`);
  }
  console.log('');
  console.log(`阈值：正文 ≥ ${THRESH.body}（判定值＝min(正文/背景, 白底)）、次要 ≥ ${THRESH.secondary}、accent 文字 ≥ ${THRESH.onAccent}`);
  const translucent = rows.filter((r) => r.panelAlpha < 1);
  if (translucent.length) {
    console.log('半透明面板读数：' + translucent.map((r) => `${r.id} alpha=${r.panelAlpha} 常态=${r.bodyOnPanelNormal} 白底=${r.bodyOnPanelWorst}`).join('；'));
    console.log('（旧版把 alpha 忽略、把 rgba(255,255,255,.10) 当实色白，只得到假的 1.12；现拆成两列，判定锚到白底最差）');
  }
}

const badRows = rows.filter((r) => r.bad.length > 0);
if (failures.length) { console.error('取数失败：'); for (const f of failures) console.error('  ' + f); process.exit(2); }
if (badRows.length) {
  console.error(`\n不达标 ${badRows.length} 档：${badRows.map((r) => r.id).join('、')}`);
  process.exit(1);
}
console.log('\n对比度：5 档全部达标（含玻璃按两端最差算）');
process.exit(0);
