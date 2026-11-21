'use strict';
// T-77e4：透明覆盖窗专用 preload（不暴露 workbench 业务 API）。
const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('fxOverlay', {
  ready: () => ipcRenderer.send('fx:overlay-ready'),
  onState: (handler) => {
    if (typeof handler !== 'function') return;
    ipcRenderer.on('fx:overlay-state', (_event, state) => {
      try { handler(state || {}); } catch { /* ignore */ }
    });
  }
});
