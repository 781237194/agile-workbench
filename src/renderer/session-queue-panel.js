'use strict';
/**
 * R-6bc8（T-20261117-123812-37f5）会话排队可观测 —— 渲染层（只读展示）。
 *
 * 三件事分开显示，互不推算（正文 §一/§六）：
 *   ① 排队数（DSH 会话 placement='queued' 条数；未知显示「—」，不显示 0）；
 *   ② 四态 fail|skip|ok|none（团队侧 唤醒.jsonl 归类，skipped 优先于 ok）；
 *   ③ 失败数 / 跳过数两列独立 + 最近成功投递时间。
 * 外加背压提示：某角色排队 ≥3 时，PM 派单入口出现 [data-backpressure-hint]（<3 时节点不存在）。
 *
 * 本文件只调 window.workbench.teamSessionQueue（主进程只读汇总），不读文件、不写任何状态。
 */
(() => {
  const PANEL_ID = 'session-queue-panel';
  const ROWS_ID = 'session-queue-rows';
  const BANNER_ID = 'session-queue-banner';
  const META_ID = 'session-queue-meta';
  const REFRESH_MS = 8000;
  const BACKPRESSURE_THRESHOLD = 3;

  const state = { model: null, error: '', busy: false, timer: null, mounted: false };

  const STATE_LABEL = { fail: '失败（真的没送出去）', skip: '跳过（设计内不唤醒）', ok: '成功', none: '无记录' };

  const el = (id) => document.getElementById(id);
  const node = (tag, className, text) => {
    const item = document.createElement(tag);
    if (className) item.className = className;
    if (text !== undefined && text !== null) item.textContent = String(text);
    return item;
  };

  /** 相对时间（纯展示）；不可解析返回空串。 */
  function fmtRel(iso, now) {
    const ms = Date.parse(String(iso || ''));
    if (!Number.isFinite(ms)) return '';
    const diff = Math.max(0, (Number(now) || Date.now()) - ms);
    if (diff < 60 * 1000) return '刚刚';
    if (diff < 60 * 60 * 1000) return `${Math.floor(diff / 60000)} 分钟前`;
    if (diff < 24 * 60 * 60 * 1000) return `${Math.floor(diff / 3600000)} 小时前`;
    return `${Math.floor(diff / 86400000)} 天前`;
  }

  function renderRows() {
    const host = el(ROWS_ID);
    if (!host) return;
    const model = state.model || { rows: [], degraded: true };
    host.textContent = '';
    const now = Date.now();
    for (const row of model.rows || []) {
      const line = node('div', 'sq-row');
      line.setAttribute('data-sq-row', '1');
      line.setAttribute('data-role', String(row.role || ''));
      line.setAttribute('data-sq-known', row.known ? 'true' : 'false');

      line.appendChild(node('span', 'sq-role', row.name || row.role || ''));

      // 排队数：未知一律「—」，绝不显示 0（AC4）
      const queued = node('span', 'sq-queued', row.known ? String(row.queued) : '—');
      queued.setAttribute('data-sq-queued', '1');
      queued.setAttribute('data-sq-known', row.known ? 'true' : 'false');
      queued.title = row.known
        ? `排队 ${row.queued} 条（placement=queued）`
        : '未知：DSH 会话未取到或该角色还没有会话（未知不等于 0）';
      line.appendChild(queued);

      const stateChip = node('span', 'sq-state sq-state-' + String(row.state || 'none'), String(row.state || 'none'));
      stateChip.setAttribute('data-sq-state', '1');
      stateChip.title = STATE_LABEL[String(row.state || 'none')] || '';
      line.appendChild(stateChip);

      const fail = node('span', 'sq-fail', String(Number(row.failCount) || 0));
      fail.setAttribute('data-sq-fail-count', '1');
      fail.title = '窗口内唤醒失败数（真的没送出去）';
      line.appendChild(fail);

      const skip = node('span', 'sq-skip', String(Number(row.skipCount) || 0));
      skip.setAttribute('data-sq-skip-count', '1');
      skip.title = '窗口内跳过数（设计内不唤醒，不计失败也不计成功）';
      line.appendChild(skip);

      const lastOk = node('span', 'sq-last-ok', row.lastOkAt ? fmtRel(row.lastOkAt, now) : '无记录');
      lastOk.setAttribute('data-sq-last-ok', '1');
      lastOk.title = row.lastOkAt ? `最近成功投递：${row.lastOkAt}` : '窗口内没有成功投递记录';
      line.appendChild(lastOk);

      host.appendChild(line);
    }
    if (!host.childNodes.length) {
      const empty = node('div', 'sq-empty', '还没有角色行（等主进程汇总）');
      host.appendChild(empty);
    }
  }

  function renderBanner() {
    const panel = el(PANEL_ID);
    const banner = el(BANNER_ID);
    const meta = el(META_ID);
    const model = state.model || {};
    const degraded = Boolean(model.degraded || state.error);
    if (panel) {
      panel.setAttribute('data-sq-degraded', degraded ? 'true' : 'false');
      // B-20261117-180718-9229：降级原因要能被断言/自诊断（未配置 teamRoot / 采集失败 / 写盘失败…）
      panel.setAttribute('data-sq-reason', degraded ? String((state.error ? 'PANEL_ERROR' : ((model.banner && model.banner.code) || ''))) : '');
    }
    if (banner) {
      const text = state.error
        ? `会话排队面板读取失败：${state.error}`
        : (model.banner && model.banner.text) || '';
      banner.textContent = text;
      banner.hidden = !degraded || !text;
    }
    if (meta) {
      const at = String(model.at || '');
      if (state.error) meta.textContent = '读取失败';
      else if (!at) meta.textContent = model.degraded ? '未接入' : '未加载';
      else meta.textContent = `${fmtRel(at, Date.now())} · ${at}`;
      meta.title = [
        model.snapshotFile ? `快照：${model.snapshotFile}` : '',
        model.wakeFile ? `唤醒日志：${model.wakeFile}` : '',
        `窗口：${Math.round((Number(model.windowMs) || 0) / 3600000)} 小时`,
        `坏行：${Number(model.badLines) || 0}`,
      ].filter(Boolean).join('\n');
    }
  }

  /** 背压：排队 ≥3 时在派单入口挂提示节点；<3 时把节点整个删掉（不是隐藏）。 */
  function paintBackpressure() {
    const entry = document.querySelector('[data-dispatch-entry]');
    if (!entry) return;
    const select = el('dispatch-role');
    const role = select ? String(select.value || '') : '';
    const model = state.model || {};
    const row = (model.rows || []).find((item) => String(item.role) === role) || null;
    const count = row && row.known ? Number(row.queued) : NaN;
    const show = Number.isFinite(count) && count >= BACKPRESSURE_THRESHOLD;
    let hint = entry.querySelector('[data-backpressure-hint]');
    if (!show) {
      if (hint) hint.remove();
      return;
    }
    const text = `对方排队 ${count} 条，先别连发`;
    if (!hint) {
      hint = node('div', 'sq-backpressure');
      hint.setAttribute('data-backpressure-hint', '1');
      hint.setAttribute('role', 'status');
      entry.insertBefore(hint, entry.firstChild);
    }
    hint.textContent = text;
    hint.title = '只提示、不阻断派单；对方正在处理，连发只会让排队更长';
  }

  function render() {
    renderRows();
    renderBanner();
    paintBackpressure();
  }

  async function refresh() {
    if (state.busy) return state.model;
    state.busy = true;
    try {
      const api = window.workbench && window.workbench.teamSessionQueue;
      if (typeof api !== 'function') {
        state.error = '主进程通道未注册（team:session-queue）';
        state.model = null;
      } else {
        const model = await api({});
        if (model && model.ok) {
          state.model = model;
          state.error = '';
        } else {
          state.error = String((model && model.message) || (model && model.code) || '未知错误');
          state.model = model && Array.isArray(model.rows) ? model : null;
        }
      }
    } catch (error) {
      state.error = String((error && error.message) || error).slice(0, 200);
    } finally {
      state.busy = false;
    }
    render();
    return state.model;
  }

  function mount() {
    if (state.mounted) return;
    state.mounted = true;
    render();
    refresh();
    if (state.timer) clearInterval(state.timer);
    state.timer = setInterval(() => {
      // 团队台收起时不跑（省一次 IPC）；本面板现在在独立抽屉里（R-6bc8 返工：不再挂团队台）。
      const drawer = el('session-queue-drawer');
      if (drawer && drawer.hidden) return;
      refresh();
    }, REFRESH_MS);
    const openBtn = el('btn-session-queue');
    if (openBtn) openBtn.addEventListener('click', () => setTimeout(refresh, 150));
    const roleSelect = el('dispatch-role');
    if (roleSelect) roleSelect.addEventListener('change', paintBackpressure);
    const reload = el('btn-queue-refresh');
    if (reload) reload.addEventListener('click', () => setTimeout(refresh, 400));
  }

  // 自检钩子（--sq-check 用；只读刷新 + 读当前模型，不写任何状态）
  window.__sqRefresh = refresh;
  window.__sqModel = () => state.model;

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
