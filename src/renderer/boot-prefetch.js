/**
 * boot-prefetch.js —— B-20261121-015830-a129（P0 首屏代码分割）
 * 在 app.js（957KB）解析之前：
 *   ① 提前发起 app:state 预取（并行 IO，app.js 直接复用同一个 Promise）；
 *   ② 在 DOM 可用后立刻上报 rendererInteractive（骨架可见即交互就绪）；
 *   ③ 出错静默，绝不阻塞 app.js 启动。
 */
(function () {
  'use strict';
  // a129：首屏错误收集（夹具据此断言没有白屏/脚本异常）。
  window.__awbBootErrors = window.__awbBootErrors || [];
  try { window.addEventListener('error', (e) => { try { window.__awbBootErrors.push(String((e && e.message) || e)); } catch { /* ignore */ } }); } catch { /* ignore */ }
  try {
    if (window.workbench && typeof window.workbench.state === 'function') {
      window.__awbStatePromise = Promise.resolve().then(() => window.workbench.state()).catch((error) => {
        window.__awbStateError = String((error && error.message) || error);
        return null;
      });
    }
  } catch { /* ignore */ }

  function markInteractive() {
    try {
      if (window.workbench && typeof window.workbench.startupMark === 'function') {
        void window.workbench.startupMark({ phase: 'rendererInteractive', at: Date.now(), from: 'boot-prefetch' });
      }
    } catch { /* ignore */ }
  }
  try {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', () => requestAnimationFrame(() => markInteractive()), { once: true });
    } else {
      requestAnimationFrame(() => markInteractive());
    }
  } catch { /* ignore */ }
})();
