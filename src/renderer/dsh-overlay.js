'use strict';
/**
 * f749：DSH 覆盖层显隐的纯判定（PM 13:41 热修口径，A 复核后抽成可测函数）。
 * 规则：
 *  - 只有 guest 真的加载出正文（ready && bodyLen>0）、且没有 fail/error 时才允许隐藏覆盖层；
 *  - body=0/401/空白、did-fail、dshViewError 任一成立 → 覆盖层必须可见；
 *  - online 探测滞后不能把已出内容的页面压成「黑屏+已连接」。
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AWBDshOverlay = api;
})(typeof window !== 'undefined' ? window : globalThis, function () {
  function overlayState(input = {}) {
    const online = Boolean(input.online);
    const failed = Boolean(input.failed);
    const hasError = Boolean(input.hasError);
    const ready = Boolean(input.ready);
    const bodyLen = Number(input.bodyLen);
    const hasBody = ready && Number.isFinite(bodyLen) && bodyLen > 0;
    const loadedOk = hasBody && !failed && !hasError;
    // body=0/加载中/失败/错误任一成立都必须显示覆盖层，不能因 online=true 就藏起来。
    const showOff = !loadedOk && (!online || failed || hasError || !hasBody);
    return { loadedOk, showOff };
  }
  return { overlayState };
});
