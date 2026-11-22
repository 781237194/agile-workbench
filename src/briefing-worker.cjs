'use strict';
/**
 * T-ff27：briefingStatus 专用 worker。
 * 主线程只收发结果；6 角色文档哈希/工作流读取等同步重活在这个线程里做。
 * 复用主进程 env（AWB_TEAM_ROOT/TEAM_ROOT/...），不写任何状态（briefingStatus 只读）。
 */
const { parentPort } = require('node:worker_threads');
const teamTools = require('./team-tools.js');

let busy = false;
parentPort.on('message', (msg) => {
  const id = Number(msg && msg.id) || 0;
  const teamName = String(msg && msg.teamName || '');
  if (!id) return;
  if (busy) {
    parentPort.postMessage({ id, ok: false, code: 'BRIEFING_WORKER_BUSY', message: 'worker 仍在处理上一条 briefing' });
    return;
  }
  busy = true;
  try {
    const raw = teamTools.briefingStatus(teamName);
    parentPort.postMessage({ id, ok: true, raw });
  } catch (error) {
    parentPort.postMessage({ id, ok: false, code: 'BRIEFING_WORKER_FAILED', message: String((error && error.message) || error).slice(0, 500) });
  } finally {
    busy = false;
  }
});
