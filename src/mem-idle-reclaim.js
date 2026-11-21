'use strict';
/**
 * mem-idle-reclaim.js —— R-e31b 内存预算（T-20261121-221005-f0d1）纯逻辑：
 *   - 失焦 60s + 壳+guest 合计 >1.5GB 的回收判定
 *   - DSH guest 输入框/滚动位置快照与恢复脚本（不重载壳，尽量保留状态）
 * 只依赖 Electron 注入的接口；本模块不 require electron，Node 可直接单测。
 */

const DEFAULT_IDLE_MS = 60000;
const DEFAULT_THRESHOLD_MB = 1536;
const MIN_RECLAIM_COOLDOWN_MS = 5 * 60000;

function positiveNumber(value, fallback) {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

/**
 * 失焦回收判定：
 * 返回 {reclaim, reason, idleMs, thresholdMB}
 * - 只在未聚焦、连续失焦 >= idleMs、总内存 > thresholdMB 时触发
 * - 同一失焦周期只回收一次（episodeReclaimed）；回窗/聚焦后由调用方复位
 */
function decideIdleReclaim(input = {}) {
  const now = Number(input.now) || Date.now();
  const focused = Boolean(input.focused);
  const totalMB = Number(input.totalMB);
  const idleMs = positiveNumber(input.idleMs, DEFAULT_IDLE_MS);
  const thresholdMB = positiveNumber(input.thresholdMB, DEFAULT_THRESHOLD_MB);
  const unfocusedSince = Number(input.unfocusedSince) || 0;
  const episodeReclaimed = Boolean(input.episodeReclaimed);
  const lastReclaimAt = Number(input.lastReclaimAt) || 0;
  const cooldownMs = positiveNumber(input.cooldownMs, MIN_RECLAIM_COOLDOWN_MS);
  if (focused) return { reclaim: false, reason: 'focused', idleMs, thresholdMB };
  if (!unfocusedSince) return { reclaim: false, reason: 'no-unfocused-since', idleMs, thresholdMB };
  if (episodeReclaimed) return { reclaim: false, reason: 'already-reclaimed-episode', idleMs, thresholdMB };
  if (now - unfocusedSince < idleMs) return { reclaim: false, reason: 'not-idle-long-enough', idleMs, thresholdMB };
  if (lastReclaimAt && now - lastReclaimAt < cooldownMs) return { reclaim: false, reason: 'cooldown', idleMs, thresholdMB };
  if (!Number.isFinite(totalMB) || totalMB <= thresholdMB) return { reclaim: false, reason: 'below-threshold', idleMs, thresholdMB, totalMB: Number.isFinite(totalMB) ? totalMB : null };
  return { reclaim: true, reason: 'idle-over-threshold', idleMs, thresholdMB, totalMB, idleForMs: now - unfocusedSince };
}

/** 在 DSH guest 里执行：记录活跃输入框文本/选区、滚动位置（window + 最大可滚动容器）与当前地址。 */
function captureScript() {
  return `(() => {
    const out = { href: String(location.href || ''), title: String(document.title || '') };
    const ae = document.activeElement || null;
    const editable = ae && (ae.tagName === 'TEXTAREA' || ae.tagName === 'INPUT' || ae.isContentEditable);
    if (editable) {
      out.composer = {
        id: String(ae.id || ''), name: String(ae.getAttribute('name') || ''),
        placeholder: String(ae.getAttribute('placeholder') || ''),
        tag: String(ae.tagName || ''), contentEditable: Boolean(ae.isContentEditable),
        text: String(ae.isContentEditable ? ae.innerText : ae.value || ''),
        selectionStart: Number(ae.selectionStart || 0), selectionEnd: Number(ae.selectionEnd || 0)
      };
    }
    out.scrollX = Number(window.scrollX || 0);
    out.scrollY = Number(window.scrollY || 0);
    try {
      const nodes = Array.from(document.querySelectorAll('*')).slice(0, 6000);
      const candidates = [];
      for (const el of nodes) {
        if (!el || el.scrollHeight <= el.clientHeight + 8) continue;
        if (!(el.scrollTop > 0 || el.scrollLeft > 0)) continue;
        candidates.push({
          score: el.scrollHeight * el.clientHeight,
          tag: String(el.tagName || ''), id: String(el.id || ''),
          cls: String(el.className || '').slice(0, 120),
          top: Number(el.scrollTop) || 0, left: Number(el.scrollLeft) || 0
        });
      }
      candidates.sort((a, b) => b.score - a.score);
      out.scrollables = candidates.slice(0, 6);
      if (out.scrollables.length) out.scrollContainer = out.scrollables[0];
    } catch { /* 忽略 */ }
    return out;
  })()`;
}

function restoreScript(state) {
  const safe = state && typeof state === 'object' ? state : {};
  return `(() => {
    const saved = ${JSON.stringify(safe)};
    const findEditable = () => {
      const c = saved.composer || null;
      if (c) {
        let el = null;
        if (c.id) el = document.getElementById(c.id);
        if (!el && c.name) el = document.querySelector('[name="' + String(c.name).replace(/"/g, '\\\\"') + '"]');
        if (!el && c.placeholder) {
          const ph = String(c.placeholder).replace(/"/g, '\\\\"');
          el = document.querySelector('textarea[placeholder="' + ph + '"],input[placeholder="' + ph + '"]');
        }
        if (!el && c.tag) {
          const list = Array.from(document.querySelectorAll(String(c.tag).toLowerCase()));
          el = list.find((x) => (x.isContentEditable === Boolean(c.contentEditable)) || x.tagName === c.tag) || null;
        }
        if (el) return el;
      }
      const all = Array.from(document.querySelectorAll('textarea,input,[contenteditable="true"]'));
      return all.find((x) => x.offsetParent !== null) || all[0] || null;
    };
    const setValue = (el, value) => {
      if (!el) return false;
      try {
        if (el.isContentEditable) {
          if (el.innerText !== value) { el.innerText = value; el.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: 'insertText', data: value })); }
          return true;
        }
        const proto = el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype : HTMLInputElement.prototype;
        const setter = Object.getOwnPropertyDescriptor(proto, 'value');
        if (setter && setter.set) setter.set.call(el, value); else el.value = value;
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
        try { if (saved.composer && Number.isFinite(saved.composer.selectionStart)) el.setSelectionRange(saved.composer.selectionStart, saved.composer.selectionEnd); } catch {}
        return true;
      } catch { return false; }
    };
    let restoredComposer = false;
    if (saved.composer && saved.composer.text) restoredComposer = setValue(findEditable(), String(saved.composer.text));
    try { window.scrollTo(Number(saved.scrollX) || 0, Number(saved.scrollY) || 0); } catch {}
    let restoredScroll = false;
    const targets = Array.isArray(saved.scrollables) && saved.scrollables.length
      ? saved.scrollables : (saved.scrollContainer ? [saved.scrollContainer] : []);
    const findScrollTarget = (c) => {
      let el = null;
      if (c.id) el = document.getElementById(c.id);
      if (!el && c.cls) { try { el = document.querySelector('.' + String(c.cls).trim().split(/\\s+/)[0]); } catch {} }
      if (!el && c.tag) el = Array.from(document.querySelectorAll(String(c.tag || 'div').toLowerCase())).find((x) => x.scrollHeight > x.clientHeight + 8) || null;
      return el;
    };
    const applyScroll = () => {
      try {
        window.scrollTo(Number(saved.scrollX) || 0, Number(saved.scrollY) || 0);
        for (const c of targets) {
          const el = findScrollTarget(c);
          if (!el) continue;
          el.scrollTop = Number(c.top) || 0;
          el.scrollLeft = Number(c.left) || 0;
          restoredScroll = true;
        }
      } catch {}
    };
    for (const ms of [0, 350, 900, 1800, 3000]) { try { setTimeout(applyScroll, ms); } catch {} }
    applyScroll();
    return { ok: true, restoredComposer, restoredScroll, href: String(location.href || '') };
  })()`;
}

module.exports = {
  DEFAULT_IDLE_MS,
  DEFAULT_THRESHOLD_MB,
  MIN_RECLAIM_COOLDOWN_MS,
  decideIdleReclaim,
  captureScript,
  restoreScript
};
