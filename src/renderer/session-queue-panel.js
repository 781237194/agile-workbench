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
 * R-c9ac（本单）：新增「会话实时状态」区（#session-live-section，六行 [data-live-row]）——
 *   快照 v2 每角色：五态（approval > blocked > thinking > queued > idle，未知=unknown）、
 *   思考秒表（mm:ss，只在本区有 thinking 行且抽屉可见时走字）、最近事件（相对时间 + title 绝对时间）、
 *   placement=queued 计数、known、byPlacement 三档（title 含三数）、停滞（now-lastEventAt ≥ 阈值，阈值热读
 *   ui.sessionQueue.stallMs，默认 600000，非法回落并给可见提示）。
 *
 * 硬约束（测试直接断言）：本文件只有两个周期定时器（思考秒表 + 降级自检），各配清理；
 * 不使用逐帧回调；行锚点 [data-live-row] 与旧 [data-sq-row] 严格分开。
 *
 * 本文件只调 window.workbench.teamSessionQueue / window.workbench.state（只读），不读文件、不写任何状态。
 */
(() => {
  const PANEL_ID = 'session-queue-panel';
  const ROWS_ID = 'session-queue-rows';
  const BANNER_ID = 'session-queue-banner';
  const META_ID = 'session-queue-meta';
  const LIVE_ROWS_ID = 'session-live-rows';
  const LIVE_PUSH_ID = 'session-live-push';
  const LIVE_STALL_HINT_ID = 'session-live-stall-hint';
  const BACKPRESSURE_THRESHOLD = 3;
  // R-c9ac：秒表 1 秒；快照 5 秒无更新 / watch 不可用 → 降级自检
  const STOPWATCH_MS = 1000;
  const DEGRADE_MS = 5000;
  const PUSH_STALE_MS = 5000;
  const DEFAULT_STALL_MS = 600000;

  const state = {
    model: null,
    error: '',
    busy: false,
    timer: null,       // 秒表（只在「抽屉可见且有 thinking 行」时存在）
    watchTimer: null,  // 降级自检（5 秒）
    mounted: false,
    stallMs: DEFAULT_STALL_MS,
    stallInvalid: false,
    stallRaw: undefined,
    lastModelAt: 0,
    pushApiBound: false,
  };

  const STATE_LABEL = { fail: '失败（真的没送出去）', retry: '重试中（一次失败已排重试，先别看红）', skip: '跳过（设计内不唤醒，细分见 hover）', ok: '成功', none: '无记录' };
  // B-20261118-090620-6e39：skip 细分（团队侧 session-queue.js 归一成 merged/dedupe/debounced/sandbox 四类）
  const SKIP_SHORT = { merged: '已合并', dedupe: '已去重', debounced: '去抖', sandbox: '沙盘跳过', other: '跳过' };
  const SKIP_LABEL = {
    merged: '已合并（合并窗口内，不重复唤醒）',
    dedupe: '已送达（去重，同一条已投过）',
    debounced: '去抖（窗口内合并，未单独唤醒）',
    sandbox: '沙盘跳过（沙盘根不驱动真实会话）',
    other: '跳过（其它设计内原因）',
  };
  // R-fa0e（3a12）§六：自动换人六态（[data-ar-state]）
  const AR_STATE_LABEL = { idle: '空闲', warn: '预警/已入队', pending_handover: '等交接回执', rotating: '正在换人', rebooting: '已广播重 boot', failed: '失败' };
  // R-c9ac：五态中文文案（写死；unknown=未接入）
  const LIVE_LABEL = { approval: '待审批', blocked: '阻塞', thinking: '思考中', queued: '排队', idle: '空闲', unknown: '未接入' };

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

  /** 最近事件：相对时间（不可解析 → 「—」）；title 用绝对时间。 */
  function relEventText(iso, now) {
    const text = fmtRel(iso, now);
    return text || '—';
  }

  /** 秒表文本：thinking 且 runningSince 可解析 → mm:ss；其余/缺 runningSince → 「—」。 */
  function thinkTextOf(live, now) {
    if (!live || live.state !== 'thinking') return '—';
    const since = Date.parse(String(live.runningSince || ''));
    if (!Number.isFinite(since)) return '—';
    const elapsed = Math.max(0, (Number(now) || Date.now()) - since);
    const minutes = Math.floor(elapsed / 60000);
    const seconds = Math.floor((elapsed % 60000) / 1000);
    return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  }

  /** 停滞：unknown / lastEventAt 缺失不判；now-lastEventAt >= 阈值 → true + 「停滞 N 分」。 */
  function stallOf(live, now, stallMs) {
    const base = { stall: false, minutes: null, text: '' };
    if (!live || live.state === 'unknown') return base;
    const at = Date.parse(String(live.lastEventAt || ''));
    if (!Number.isFinite(at)) return base;
    const threshold = Number(stallMs) > 0 ? Number(stallMs) : DEFAULT_STALL_MS;
    const ageMs = Math.max(0, (Number(now) || Date.now()) - at);
    if (ageMs < threshold) return base;
    const minutes = Math.floor(ageMs / 60000);
    return { stall: true, minutes, text: `停滞 ${minutes} 分` };
  }

  /** byPlacement 三档 title：必须同时含 queued/steering/context 三个数（未知「—」）。 */
  function byPlacementTitleOf(byPlacement) {
    const box = byPlacement && typeof byPlacement === 'object' ? byPlacement : null;
    const pick = (key) => {
      if (!box) return '—';
      const n = Number(box[key]);
      return Number.isFinite(n) ? String(n) : '—';
    };
    return `queued=${pick('queued')} steering=${pick('steering')} context=${pick('context')}`;
  }

  /** 阈值热读：ui.sessionQueue.stallMs（默认 600000；非法回落并给可见提示）。失败不打断面板。 */
  async function readHotStallMs() {
    const bridge = window.workbench;
    if (!bridge || typeof bridge.state !== 'function') return;
    try {
      const store = await bridge.state();
      const ui = store && store.ui;
      const box = ui && typeof ui === 'object' ? ui.sessionQueue : null;
      const raw = box && typeof box === 'object' ? box.stallMs : undefined;
      const n = Number(raw);
      if (raw === undefined || raw === null || raw === '') {
        state.stallMs = DEFAULT_STALL_MS;
        state.stallInvalid = false;
        state.stallRaw = raw;
        return;
      }
      if (!Number.isFinite(n) || n <= 0) {
        state.stallMs = DEFAULT_STALL_MS;
        state.stallInvalid = true;
        state.stallRaw = raw;
        return;
      }
      state.stallMs = n;
      state.stallInvalid = false;
      state.stallRaw = raw;
    } catch (error) {
      // 读不到 store：保持上次阈值，不把面板打成错误
    }
  }

  /**
   * 推送状态：优先模型里的 push（壳层下发：{state:'push'|'degraded', at, reason}）；
   * 壳层没下发时——有推送订阅 → push；完全没有推送通道 → degraded（watch 不可用，按口径降级）。
   */
  function pushStateOf(model, now) {
    const p = model && model.push && typeof model.push === 'object' ? model.push : null;
    const declared = p && typeof p.state === 'string' ? String(p.state) : '';
    const at = p ? String(p.at || p.lastPushAt || '') : '';
    if (declared) {
      // c9ac §6.6④：降级只认**通道健康**（watch 不可用/被停用），不拿「快照 at 超过 5 秒」当降级——
      // 插件在静置时本来就会 60s 才写一次（去抖+全等不写），拿 at 判 stale 会让健康通道永久假降级并触发轮询。
      const st = declared === 'degraded' ? 'degraded' : 'push';
      return { state: st, at, reason: String(p.reason || ''), staleMs: Number.isFinite(Date.parse(at)) ? Math.max(0, now - Date.parse(at)) : 0 };
    }
    if (state.pushApiBound) return { state: 'push', at: String(state.lastModelAt ? new Date(state.lastModelAt).toISOString() : ''), reason: '' };
    return { state: 'degraded', at: '', reason: 'push_unavailable' };
  }

  function liveOf(row) {
    const live = row && row.live && typeof row.live === 'object' ? row.live : null;
    if (live) return live;
    return {
      state: 'unknown', stateText: LIVE_LABEL.unknown, known: false,
      queued: null, byPlacement: null, runningSince: '', lastEventAt: '', cursor: null,
      pendingInput: [], active: null, running: false,
    };
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

      // B-20261118-085825-0950：retry（重试中）显示中文，其余状态保持原英文值（旧断言依赖）
      // B-6e39：skip 的细分不塞进 [data-sq-state] 文本（旧断言按 'skip' 文本断言），另加一个原因 chip。
      const rowState = String(row.state || 'none');
      const skipReason = String(row.skipReason || '');
      const stateText = rowState === 'retry' ? '重试中' : rowState;
      const stateChip = node('span', 'sq-state sq-state-' + rowState, stateText);
      stateChip.setAttribute('data-sq-state', '1');
      stateChip.title = rowState === 'skip'
        ? `${SKIP_LABEL[skipReason] || STATE_LABEL.skip}${row.skipDetail ? '（' + row.skipDetail + '）' : ''}`
        : (STATE_LABEL[rowState] || '');
      line.appendChild(stateChip);
      if (rowState === 'skip') {
        // 面板据此断言「黄点不红」与细分原因（四类之一，未知落 other）
        const reasonChip = node('span', 'sq-skip-reason', SKIP_SHORT[skipReason] || '跳过');
        reasonChip.setAttribute('data-sq-skip-reason', skipReason || 'other');
        reasonChip.setAttribute('data-sq-skip-tone', 'warn');
        reasonChip.title = `${SKIP_LABEL[skipReason] || STATE_LABEL.skip}${row.skipDetail ? '（' + row.skipDetail + '）' : ''}`;
        line.setAttribute('data-sq-skip-reason', skipReason || 'other');
        line.appendChild(reasonChip);
      }

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

      // R-fa0e（3a12）§六：自动换人只读字段（六值 state 挂在行上 → [data-ar-state][data-role]）
      const ar = row.autoRotate || {};
      const arState = String(ar.state || 'idle');
      line.setAttribute('data-ar-state', arState);
      // B-20261118-002151-61f5：用量来源（file=会话用量.json / live=实时回退 / none=取不到）只读展示
      if (ar.usageSource) line.setAttribute('data-ar-usage', String(ar.usageSource));
      const arBox = node('div', 'sq-ar');
      const arChip = node('span', 'sq-ar-chip sq-ar-' + arState, `自动换人：${AR_STATE_LABEL[arState] || arState}`);
      arChip.setAttribute('data-ar-state', arState);
      if (ar.usageSource === 'live') arChip.title = '本轮 token 判档来自实时回退（会话用量.json 缺失或超 24h）';
      arBox.appendChild(arChip);
      if (ar.reason) {
        const reasonEl = node('span', 'sq-ar-reason', String(ar.reason));
        reasonEl.setAttribute('data-ar-reason', '1');
        arBox.appendChild(reasonEl);
      }
      if (ar.auditTail) {
        const tail = node('span', 'sq-ar-tail', String(ar.auditTail));
        tail.setAttribute('data-ar-audit-tail', '1');
        tail.title = '最近一条自动换人审计（stage · at）';
        arBox.appendChild(tail);
      }
      if (ar.error) {
        const err = node('span', 'sq-ar-error', String(ar.error));
        err.setAttribute('data-ar-error', '1');
        arBox.appendChild(err);
      }
      line.appendChild(arBox);

      host.appendChild(line);
    }
    if (!host.childNodes.length) {
      const empty = node('div', 'sq-empty', '还没有角色行（等主进程汇总）');
      host.appendChild(empty);
    }
  }

  /** R-c9ac：六行实时状态（[data-live-row]，绝不带 data-sq-row）。 */
  function renderLive() {
    const host = el(LIVE_ROWS_ID);
    if (!host) return;
    const model = state.model || { rows: [] };
    const now = Date.now();
    const stallMs = state.stallMs;
    host.textContent = '';
    for (const row of model.rows || []) {
      const live = liveOf(row);
      const stateKey = String(live.state || 'unknown');
      const line = node('div', 'sq-live-row');
      line.setAttribute('data-live-row', '1');
      line.setAttribute('data-role', String(row.role || ''));
      line.setAttribute('data-live-state', stateKey);
      const stall = stallOf(live, now, stallMs);
      if (stall.stall) line.className = 'sq-live-row stall';

      line.appendChild(node('span', 'sq-live-role', row.name || row.role || ''));

      const liveEl = node('span', 'sq-live-state', LIVE_LABEL[stateKey] || LIVE_LABEL.unknown);
      liveEl.setAttribute('data-sq-live', '1');
      liveEl.title = `五态优先级：approval > blocked > thinking > queued > idle；未接入=unknown。当前 pendingInput=${(live.pendingInput || []).join('/') || '—'}，running=${live.running === true ? 'true' : (live.running === false ? 'false' : '—')}`;
      line.appendChild(liveEl);

      const think = node('span', 'sq-live-meta sq-live-num', thinkTextOf(live, now));
      think.setAttribute('data-sq-think', '1');
      think.title = stateKey === 'thinking'
        ? (live.runningSince ? `思考开始：${live.runningSince}` : '缺 runningSince：显示「—」，不用当前时间伪造开始时刻')
        : '非 thinking 行显示「—」';
      line.appendChild(think);

      const lastEvent = node('span', 'sq-live-meta', relEventText(live.lastEventAt, now));
      lastEvent.setAttribute('data-sq-last-event', '1');
      lastEvent.title = live.lastEventAt ? `最近事件（绝对时间）：${live.lastEventAt}` : '未记录最近事件（显示「—」，不按 0 处理）';
      line.appendChild(lastEvent);

      // 只数 placement=queued：未知「—」，不显示 0
      const queuedEl = node('span', 'sq-live-num', live.queued === null || live.queued === undefined ? '—' : String(live.queued));
      queuedEl.setAttribute('data-live-queued', '1');
      queuedEl.title = `只数 placement=queued（steering/context 单列：${byPlacementTitleOf(live.byPlacement)}）`;
      line.appendChild(queuedEl);

      const knownEl = node('span', 'sq-live-num', live.known ? 'true' : 'false');
      knownEl.setAttribute('data-live-known', '1');
      knownEl.title = live.known ? 'DSH 会话可用（取到 queue 与状态帧）' : '未知：没有会话或取不到 queue（未知不等于 0）';
      line.appendChild(knownEl);

      const bypEl = node('span', 'sq-live-num', live.byPlacement ? byPlacementTitleOf(live.byPlacement) : '—');
      bypEl.setAttribute('data-sq-byplacement', '1');
      bypEl.title = byPlacementTitleOf(live.byPlacement);
      line.appendChild(bypEl);

      const stallEl = node('span', 'sq-live-num', stall.stall ? 'true' : 'false');
      stallEl.setAttribute('data-sq-stall', '1');
      stallEl.title = `停滞判据：now - lastEventAt ≥ ${stallMs}ms（ui.sessionQueue.stallMs）；lastEventAt 缺失或 unknown 不判停滞`;
      line.appendChild(stallEl);

      const stallText = node('span', 'sq-live-stall-text', stall.text || '');
      stallText.setAttribute('data-sq-stall-text', '1');
      line.appendChild(stallText);

      host.appendChild(line);
    }
    if (!host.childNodes.length) {
      host.appendChild(node('div', 'sq-empty', '还没有角色行（等主进程汇总快照 v2）'));
    }
    paintPush();
    paintStallHint();
  }

  function paintPush() {
    const chip = el(LIVE_PUSH_ID);
    if (!chip) return;
    const push = pushStateOf(state.model || {}, Date.now());
    const degraded = push.state === 'degraded';
    chip.setAttribute('data-sq-push', degraded ? 'degraded' : 'push');
    chip.textContent = degraded ? '推送：降级（5 秒自检）' : '推送：实时';
    const okAt = String((state.model && state.model.at) || '');
    chip.title = degraded
      ? `推送降级：${push.reason === 'push_unavailable' ? '壳层推送通道未接入（watch 不可用）' : (push.reason === 'push_stale' ? '超过 5 秒没有推送更新' : (push.reason || '未知原因'))}；最近成功读取：${okAt || '无记录'}`
      : `推送正常（最近更新：${okAt || '无记录'}）`;
    chip.className = 'badge ' + (degraded ? 'badge-skipped' : 'muted-badge');
  }

  function paintStallHint() {
    const hint = el(LIVE_STALL_HINT_ID);
    if (!hint) return;
    if (!state.stallInvalid) {
      hint.hidden = true;
      hint.textContent = '';
      hint.removeAttribute('data-sq-stall-invalid');
      return;
    }
    hint.hidden = false;
    hint.setAttribute('data-sq-stall-invalid', '1');
    hint.textContent = `停滞阈值非法（${String(state.stallRaw)}）→ 已回落 ${DEFAULT_STALL_MS} 毫秒`;
    hint.title = 'ui.sessionQueue.stallMs 必须是正数（毫秒）；非法值按 600000 处理并在面板提示，不静默使用。';
  }

  function renderBanner() {
    const panel = el(PANEL_ID);
    const banner = el(BANNER_ID);
    const meta = el(META_ID);
    const model = state.model || {};
    const now = Date.now();
    // R-fa0e（3a12）§六：团队台只读汇总 [data-ar-summary]
    const arSummary = document.querySelector('[data-ar-summary]');
    if (arSummary) {
      const ar = model.autoRotate || {};
      arSummary.textContent = String(ar.summary || '今日自动换人 0 次 / 失败 0 次');
      arSummary.title = '自动换人只读汇总（数据源：团队/状态/项目/<项目>/自动换人.jsonl）';
    }
    const snapshotDegraded = Boolean(model.degraded || state.error);
    const push = pushStateOf(model, now);
    const pushDegraded = push.state === 'degraded';
    const degraded = snapshotDegraded || pushDegraded;
    if (panel) {
      panel.setAttribute('data-sq-degraded', degraded ? 'true' : 'false');
      // B-20261117-180718-9229：降级原因要能被断言/自诊断（未配置 teamRoot / 采集失败 / 写盘失败…）
      panel.setAttribute('data-sq-reason', degraded
        ? String(state.error ? 'PANEL_ERROR' : ((pushDegraded && !snapshotDegraded ? 'PUSH_DEGRADED' : '') || (model.banner && model.banner.code) || 'PUSH_DEGRADED'))
        : '');
    }
    if (banner) {
      // 黄条单一写者：快照降级文案 + 推送降级文案（含最近成功时间）
      const snapshotText = state.error
        ? `会话排队面板读取失败：${state.error}`
        : (model.banner && model.banner.text) || '';
      const okAt = String(model.at || '');
      const okRel = okAt ? fmtRel(okAt, now) : '';
      const pushText = pushDegraded
        ? (push.reason === 'push_unavailable'
          ? `推送通道未接入（watch 不可用）→ 已退化为 ${Math.round(DEGRADE_MS / 1000)} 秒自检；最近成功：${okRel || '无记录'}`
          : (/^live-check/.test(String(push.reason || ''))
            ? `推送通道降级（自检模拟 watch 不可用）→ 已退化为 ${Math.round(DEGRADE_MS / 1000)} 秒自检；最近成功：${okRel || '无记录'}`
            : `推送超过 ${Math.round(PUSH_STALE_MS / 1000)} 秒无更新 → 已退化为 ${Math.round(DEGRADE_MS / 1000)} 秒自检；最近成功：${okRel || '无记录'}`))
        : '';
      const text = [snapshotText, pushText].filter(Boolean).join('；');
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
        `停滞阈值：${state.stallMs}ms${state.stallInvalid ? '（非法值已回落）' : ''}`,
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

  /** T-20261117-211833-7a30（R-a4c7）AC5②：调度建议行（只读；锚点 data-sched-*，追加在既有抽屉里，不新建容器层级）。 */
  function renderSched() {
    const host = el(ROWS_ID);
    if (!host) return;
    let box = el('session-queue-sched');
    if (!box) {
      box = node('div', 'sq-sched');
      box.id = 'session-queue-sched';
      host.parentNode.insertBefore(box, host.nextSibling);
    }
    box.textContent = '';
    const adv = state.model && state.model.sched;
    if (!adv || !Array.isArray(adv.roles) || !adv.roles.length) {
      box.setAttribute('data-sched-empty', '1');
      box.textContent = '调度建议：暂无（队列表未接入或项目未就绪）';
      return;
    }
    box.removeAttribute('data-sched-empty');
    box.setAttribute('data-sched-at', String(adv.at || ''));
    for (const row of adv.roles) {
      const line = node('div', 'sq-sched-row');
      line.setAttribute('data-sched-role', String(row.role || ''));
      line.setAttribute('data-sched-available', row.available === false ? 'false' : 'true');
      line.setAttribute('data-sched-advice', String(row.decision || ''));
      line.setAttribute('data-sched-level', String(row.level || ''));
      line.setAttribute('data-sched-reason', (row.reasons || []).join('；'));
      line.title = String(row.nextAction || '');
      line.appendChild(node('span', 'sq-sched-role', row.role || ''));
      line.appendChild(node('span', 'sq-sched-decision', row.decision || ''));
      line.appendChild(node('span', 'sq-sched-action', row.nextAction || ''));
      box.appendChild(line);
    }
  }

  function drawerVisible() {
    const drawer = el('session-queue-drawer');
    return Boolean(drawer) && drawer.hidden !== true;
  }

  function hasThinkingRow(model) {
    const rows = model && Array.isArray(model.rows) ? model.rows : [];
    return rows.some((row) => liveOf(row).state === 'thinking');
  }

  /** 秒表：只在「抽屉可见且有 thinking 行」时启动；收起/无 thinking 立即 clearInterval。 */
  function syncStopwatch() {
    const need = drawerVisible() && hasThinkingRow(state.model);
    if (need && !state.timer) {
      state.timer = setInterval(() => {
        if (!drawerVisible() || !hasThinkingRow(state.model)) { syncStopwatch(); return; }
        renderLive();
      }, STOPWATCH_MS);
      return;
    }
    if (!need && state.timer) {
      clearInterval(state.timer);
      state.timer = null;
    }
  }

  function stopTimers() {
    if (state.timer) { clearInterval(state.timer); state.timer = null; }
    if (state.watchTimer) { clearInterval(state.watchTimer); state.watchTimer = null; }
  }

  /** 模型变化 → 重绘两区 + 通知团队台行（事件，不新增轮询通道）。 */
  function render() {
    renderRows();
    renderSched();
    renderLive();
    renderBanner();
    paintBackpressure();
    syncStopwatch();
    try {
      window.dispatchEvent(new CustomEvent('awb:session-queue-model', { detail: { at: Date.now() } }));
    } catch { /* 老浏览器/无 CustomEvent 时忽略（不是功能缺口） */ }
  }

  async function refresh() {
    if (state.busy) return state.model;
    state.busy = true;
    try {
      // 阈值热读（每次刷新读一次 ui.sessionQueue.stallMs；不另起定时器）
      await readHotStallMs();
      const api = window.workbench && window.workbench.teamSessionQueue;
      if (typeof api !== 'function') {
        state.error = '主进程通道未注册（team:session-queue）';
        state.model = null;
      } else {
        const model = await api({});
        if (model && model.ok) {
          state.model = model;
          state.error = '';
          state.lastModelAt = Date.now();
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

  /** 推送订阅（壳层提供则用；没有就退化为降级自检，不新增轮询通道）。 */
  function bindPush() {
    const bridge = window.workbench;
    if (!bridge || typeof bridge.onSessionQueueChanged !== 'function') return;
    try {
      bridge.onSessionQueueChanged(() => {
        state.lastModelAt = Date.now();
        refresh();
      });
      state.pushApiBound = true;
    } catch { state.pushApiBound = false; }
  }

  function mount() {
    if (state.mounted) return;
    state.mounted = true;
    render();
    refresh();
    bindPush();
    if (state.watchTimer) clearInterval(state.watchTimer);
    // 降级自检：只在抽屉可见时工作；推送降级/超过 5 秒没新模型 → 主动拉一次（兜底，不是第二条数据通道）
    state.watchTimer = setInterval(() => {
      if (!drawerVisible()) return;
      const push = pushStateOf(state.model || {}, Date.now());
      // 零轮询：推送健康时这里只重绘（秒表/停滞），**不**去拉快照（拉快照＝隐藏轮询）；
      // 只有通道降级或还没有模型时才主动拉（这就是 §6.6④ 允许的降级轮询）。
      if (push.state === 'degraded' || !state.lastModelAt) { refresh(); return; }
      renderLive();
    }, DEGRADE_MS);
    const openBtn = el('btn-session-queue');
    if (openBtn) {
      openBtn.addEventListener('click', () => setTimeout(() => { refresh(); syncStopwatch(); }, 150));
    }
    const closeBtn = document.querySelector('[data-close-drawer="session-queue"]');
    if (closeBtn) closeBtn.addEventListener('click', () => syncStopwatch());
    const roleSelect = el('dispatch-role');
    if (roleSelect) roleSelect.addEventListener('change', paintBackpressure);
    const reload = el('btn-queue-refresh');
    if (reload) reload.addEventListener('click', () => setTimeout(refresh, 400));
    if (typeof window !== 'undefined' && typeof window.addEventListener === 'function') {
      window.addEventListener('pagehide', stopTimers);
    }
  }

  // 自检钩子（--sq-check / --live-check 用；只读刷新 + 读当前模型，不写任何状态）
  window.__sqRefresh = refresh;
  window.__sqModel = () => state.model;
  window.__sqLive = () => ({
    stallMs: state.stallMs,
    stallInvalid: state.stallInvalid,
    push: pushStateOf(state.model || {}, Date.now()),
    stopwatch: Boolean(state.timer),
    watching: Boolean(state.watchTimer),
    pushApiBound: state.pushApiBound,
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', mount, { once: true });
  else mount();
})();
