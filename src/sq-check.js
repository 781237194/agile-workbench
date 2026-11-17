'use strict';
/**
 * R-6bc8（T-20261117-123812-37f5）会话排队面板自检（--sq-check）
 *
 * 口径（AC1–AC7，正文 §七）：
 *   AC1 四态 fail > skip > ok > none（夹具逐条），同一角色混合时 fail 且失败/跳过各自计数；
 *   AC2 积压 ≠ 失败：queued=3 + 只有 ok/skip → 不得 fail；再补 1 条 ok=false → fail 而 queued 仍为 3；
 *   AC3 背压：排队=3 → [data-backpressure-hint] 存在且文案含「排队 3 条」「先别连发」；=2 → 节点不存在；
 *   AC4 未知 ≠ 0：known:false → 「—」且 data-sq-known="false"，文本不为 0；
 *   AC6 过期降级：快照 at 改到 10 分钟前 → data-sq-degraded="true" + 黄条含原因；恢复新鲜后消失；
 *   AC7 无记录 + 旧行兼容（deliverAt/why/messageId）。
 *   另加边界：快照缺失（未接入）、快照坏 JSON（沿用上一份）；沙盘只读与真实文件隔离断言。
 *
 * 隔离：AWB_DATA_DIR / TEAM_ROOT / AWB_STORE 全部指进 .sq-check-data 沙盘（main.js 已设）；
 *      真实 团队/状态/项目/<项目>/唤醒.jsonl 只做「没被碰过」的 sha/mtime 断言，不读不写。
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const READ_PANEL = `(() => {
  const panel = document.getElementById('session-queue-panel');
  const txt = (node) => (node ? String(node.textContent || '').trim() : '');
  const rows = Array.from(document.querySelectorAll('[data-sq-row]')).map((row) => {
    const queuedCell = row.querySelector('[data-sq-queued]');
    const stateCell = row.querySelector('[data-sq-state]');
    const failCell = row.querySelector('[data-sq-fail-count]');
    const skipCell = row.querySelector('[data-sq-skip-count]');
    const lastOkCell = row.querySelector('[data-sq-last-ok]');
    return {
      role: row.dataset.role || '',
      queued: txt(queuedCell),
      known: queuedCell ? String(queuedCell.getAttribute('data-sq-known') || '') : '',
      rowKnown: String(row.getAttribute('data-sq-known') || ''),
      state: txt(stateCell),
      fail: txt(failCell),
      skip: txt(skipCell),
      lastOk: txt(lastOkCell),
      lastOkTitle: lastOkCell ? String(lastOkCell.getAttribute('title') || '') : '',
    };
  });
  const banner = document.getElementById('session-queue-banner');
  const meta = document.getElementById('session-queue-meta');
  const hint = document.querySelector('[data-backpressure-hint]');
  const entry = document.querySelector('[data-dispatch-entry]');
  return {
    panel: Boolean(panel),
    degraded: panel ? String(panel.getAttribute('data-sq-degraded') || '') : '',
    bannerHidden: banner ? Boolean(banner.hidden) : null,
    bannerText: txt(banner),
    meta: txt(meta),
    metaTitle: meta ? String(meta.getAttribute('title') || '') : '',
    hasHint: Boolean(hint),
    hintText: txt(hint),
    hasEntry: Boolean(entry),
    hintCount: document.querySelectorAll('[data-backpressure-hint]').length,
    rows,
  };
})()`;

/** 夹具名册：六角色 + 固定会话 id（不写真实 sessionId，避免误投递）。 */
const ROSTER = [
  { role: 'pm', name: '项目经理', sessionId: 'sq-fixture-pm' },
  { role: 'programmer1', name: '高级程序员 A', sessionId: 'sq-fixture-p1' },
  { role: 'tester', name: '测试人员', sessionId: 'sq-fixture-tester' },
  { role: 'product', name: '产品设计师', sessionId: 'sq-fixture-product' },
  { role: 'analyst', name: '需求分析师', sessionId: 'sq-fixture-analyst' },
  { role: 'programmer2', name: '高级程序员 B', sessionId: '' },
];

function sha256Of(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return ''; }
}

function statOf(file) {
  try {
    const st = fs.statSync(file);
    return { exists: true, mtimeMs: st.mtimeMs, size: st.size, sha256: sha256Of(file) };
  } catch { return { exists: false, mtimeMs: 0, size: 0, sha256: '' }; }
}

function writeJson(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(value, null, 2) + '\n', 'utf8');
}

function writeWake(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}

/**
 * 沙盘准备（readStore 之前调用）：团队状态根建好 + 状态库缺失时从真实 store 只读复制一份。
 * 与 queue-check 同法，保证沙盘项目名与 团队/状态/项目/<项目>/ 一致。
 */
function prepareSqCheckSandbox(options = {}) {
  const teamRoot = String(options.teamRoot || '');
  if (teamRoot) fs.mkdirSync(path.join(teamRoot, '状态', '项目'), { recursive: true });
  const storeFile = String(options.storeFile || '');
  const fallback = String(options.fallbackStoreFile || '');
  let needSeed = Boolean(storeFile && fallback && fs.existsSync(fallback) && !fs.existsSync(storeFile));
  if (!needSeed && storeFile && fallback && fs.existsSync(fallback) && fs.existsSync(storeFile)) {
    try {
      const parsed = JSON.parse(fs.readFileSync(storeFile, 'utf8').replace(/^\uFEFF/, ''));
      needSeed = !parsed || !Array.isArray(parsed.projects) || !parsed.projects.length;
    } catch { needSeed = true; }
  }
  if (needSeed) {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.copyFileSync(fallback, storeFile);
    console.log('SQ_CHECK_STORE_SEEDED ' + JSON.stringify({ from: fallback, to: storeFile }));
  }
  return { teamRoot, storeFile };
}

async function runSqCheck(options = {}) {
  const outRoot = String(options.outRoot || process.cwd());
  const outDir = process.env.AWB_SQ_OUT
    ? path.resolve(process.env.AWB_SQ_OUT)
    : path.join(outRoot, '_tmp', 'sq-check-' + Date.now());
  fs.mkdirSync(outDir, { recursive: true });

  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok: Boolean(ok), detail });
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)}`);
    return ok;
  };

  const app = options.app;
  const teamName = String(options.teamName || '');
  const sandboxTeamRoot = path.resolve(String(options.sandboxTeamRoot || ''));
  const sandboxRoot = path.resolve(String(options.sandboxRoot || ''));
  const stateDir = path.join(sandboxTeamRoot, '状态');
  const projectDir = teamName ? path.join(stateDir, '项目', teamName) : path.join(stateDir, '项目', '沙盘');
  const wakeFile = path.join(projectDir, '唤醒.jsonl');
  const snapshotFile = path.join(stateDir, '会话排队.json');
  const rosterFile = path.join(stateDir, '团队.json');
  const realWakeFile = String(options.realWakeFile || '');
  const realBefore = realWakeFile ? statOf(realWakeFile) : { exists: false, mtimeMs: 0, sha256: '' };
  // 真实唤醒日志会被团队实时追加：记前缀哈希，只断言「前缀没被改写」（只增不改才算没碰过）
  const prefixOf = (file, bytes) => {
    try { return crypto.createHash('sha256').update(fs.readFileSync(file).subarray(0, bytes)).digest('hex'); } catch { return ''; }
  };
  if (realBefore.exists) realBefore.prefixHash = prefixOf(realWakeFile, realBefore.size);

  // 沙盘夹具：名册（六角色）+ 空唤醒日志（用例逐个重写）
  writeJson(rosterFile, {
    activeProject: teamName || '沙盘',
    members: ROSTER.map((row) => ({ ...row })),
  });
  writeWake(wakeFile, []);

  const now = Date.now();
  const ago = (ms) => new Date(now - ms).toISOString();
  const snapshotOf = (roles, atMs) => ({
    schema: 1,
    at: new Date(atMs || now).toISOString(),
    project: teamName || '沙盘',
    staleMs: 120000,
    roles,
  });
  const baseRoles = [
    { role: 'pm', sessionId: 'sq-fixture-pm', known: true, queued: 0 },
    { role: 'programmer1', sessionId: 'sq-fixture-p1', known: true, queued: 1 },
    { role: 'tester', sessionId: 'sq-fixture-tester', known: true, queued: 2 },
    { role: 'product', sessionId: 'sq-fixture-product', known: true, queued: 3 },
    { role: 'analyst', sessionId: 'sq-fixture-analyst', known: true, queued: 5 },
    // AC4：无会话/未知 → known:false、queued:null（界面上是「—」，绝不是 0）
    { role: 'programmer2', sessionId: '', known: false, queued: null },
  ];

  // 不调用 disableHardwareAcceleration（GPU 被禁时 capturePage 会超时，属既有坑）。
  options.createWindow();
  const win = options.getWindow();
  await new Promise((resolve) => { if (win.webContents.isLoading()) win.webContents.once('did-finish-load', resolve); else resolve(); });
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  await wait(1500);
  const evalJs = (expr) => win.webContents.executeJavaScript(expr, true);
  const shot = async (name) => {
    try {
      const file = path.join(outDir, name);
      fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG());
      return file;
    } catch { return ''; }
  };
  // 拍面板专用：先把壳内 webview 藏起来（独立原生层会盖住右侧抽屉）、把面板滚进抽屉可视区，再截。
  const shotOf = async (name, selector) => {
    const ready = await evalJs(`(async () => {
      const d = document.getElementById('session-queue-drawer');
      if (d && d.hidden) { const b = document.getElementById('btn-session-queue'); if (b) b.click(); }
      const v = document.getElementById('dsh-view');
      if (v) { v.dataset.sqPrevDisplay = v.style.display || ''; v.style.display = 'none'; }
      await new Promise((r) => setTimeout(r, 400));
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { ok: false, why: 'no-element' };
      let node = el.parentElement;
      while (node && node !== document.body) {
        const cs = getComputedStyle(node);
        if (/(auto|scroll)/.test(cs.overflowY) && node.scrollHeight > node.clientHeight + 40) {
          const r = el.getBoundingClientRect();
          const nr = node.getBoundingClientRect();
          node.scrollTop += (r.top - nr.top) - 40;
          break;
        }
        node = node.parentElement;
      }
      await new Promise((r) => setTimeout(r, 350));
      const box = el.getBoundingClientRect();
      return { ok: true, top: Math.round(box.top), height: Math.round(box.height), vh: window.innerHeight };
    })()`);
    const file = await shot(name);
    await evalJs("(() => { const v = document.getElementById('dsh-view'); if (v) { v.style.display = v.dataset.sqPrevDisplay || ''; delete v.dataset.sqPrevDisplay; } return true; })()");
    return { file, ready };
  };
  const refresh = async () => {
    await evalJs('(async () => { if (typeof window.__sqRefresh === "function") await window.__sqRefresh(); return true; })()');
    await wait(220);
    return evalJs(READ_PANEL);
  };
  // 打开团队台（让面板与派单入口可见、截图能拍到）
  await evalJs("(() => { const b = document.getElementById('btn-session-queue'); if (b) b.click(); return true; })()");
  await wait(700);
  await evalJs("(() => { const el = document.getElementById('session-queue-panel'); if (el && el.scrollIntoView) el.scrollIntoView({ block: 'center' }); return true; })()");
  await wait(300);

  check('沙盘路径全部在本次 sq-check 数据根内', sandboxTeamRoot.startsWith(sandboxRoot + path.sep) && snapshotFile.startsWith(sandboxRoot + path.sep), { sandboxTeamRoot, sandboxRoot });
  check('面板与派单入口都在（#session-queue-panel / [data-dispatch-entry]）', await evalJs("(() => Boolean(document.getElementById('session-queue-panel')) && Boolean(document.querySelector('[data-dispatch-entry]')))()") === true);

  // ── AC1 四态 ──────────────────────────────────────────────
  writeJson(snapshotFile, snapshotOf(baseRoles, now));
  writeWake(wakeFile, [
    { to: 'programmer1', at: ago(20 * 1000), ok: false, reason: 'WAKE_FAILED', messageIds: ['M-a'] },
    { to: 'tester', at: ago(30 * 1000), ok: true, skipped: 'ALREADY_DELIVERED', reason: 'dedupe' },
    { to: 'product', at: ago(40 * 1000), ok: true, deliveredAt: ago(40 * 1000), reason: 'default', messageIds: ['M-b'] },
    { to: 'analyst', at: ago(50 * 1000), ok: false, reason: 'WAKE_FAILED' },
    { to: 'analyst', at: ago(60 * 1000), ok: true, skipped: 'MERGED_PENDING' },
    { to: 'analyst', at: ago(70 * 1000), ok: true, deliveredAt: ago(70 * 1000) },
  ]);
  let panel = await refresh();
  const rowOf = (p, role) => (p.rows || []).find((row) => row.role === role) || {};
  check('AC1 六角色行齐全（含无记录与未知者）', (panel.rows || []).length === 6, (panel.rows || []).map((r) => r.role));
  check('AC1① {ok:false}（无 skipped）→ fail', rowOf(panel, 'programmer1').state === 'fail', rowOf(panel, 'programmer1'));
  check('AC1② {ok:true, skipped:ALREADY_DELIVERED} → skip（不得为 ok）', rowOf(panel, 'tester').state === 'skip', rowOf(panel, 'tester'));
  check('AC1③ {ok:true} → ok 且 last-ok 取该行 deliveredAt', rowOf(panel, 'product').state === 'ok' && /刚刚|分钟前/.test(rowOf(panel, 'product').lastOk || '') && String(rowOf(panel, 'product').lastOkTitle).includes(ago(40 * 1000).slice(0, 10)), rowOf(panel, 'product'));
  check('AC1④ 0 行 → none 且 last-ok「无记录」', rowOf(panel, 'pm').state === 'none' && rowOf(panel, 'pm').lastOk === '无记录', rowOf(panel, 'pm'));
  check('AC1 同角色混合（fail+skip+ok）→ 最近一条是 fail ⇒ fail，失败数 1 / 跳过数 1 各自独立', rowOf(panel, 'analyst').state === 'fail' && rowOf(panel, 'analyst').fail === '1' && rowOf(panel, 'analyst').skip === '1', rowOf(panel, 'analyst'));
  const ac1Shot = (await shotOf('sq-ac1-four-states.png', '#session-queue-panel')).file;

  // ── B-20261117-181420-9688（P1）：四态取「最近一次投递」，计数与状态分离 ─────────
  writeJson(snapshotFile, snapshotOf(baseRoles, now));
  writeWake(wakeFile, [
    // 9688① 先失败、最近一次成功 → 必须 ok（旧实现会永久 fail）
    { to: 'programmer1', at: ago(120 * 1000), ok: false, reason: 'WAKE_FAILED' },
    { to: 'programmer1', at: ago(10 * 1000), ok: true, deliveredAt: ago(10 * 1000) },
    // 9688② 先成功、最近一次失败 → fail
    { to: 'tester', at: ago(120 * 1000), ok: true, deliveredAt: ago(120 * 1000) },
    { to: 'tester', at: ago(10 * 1000), ok: false, reason: 'WAKE_FAILED' },
    // 9688③ 同一条 ok=true + skipped → skip（单条判定，skip 优先）
    { to: 'product', at: ago(10 * 1000), ok: true, skipped: 'ALREADY_DELIVERED' },
    // 9688④ 24h 内有 2 次失败，但最近一次成功 → 状态 ok；失败数照旧计 2
    { to: 'analyst', at: ago(300 * 1000), ok: false, reason: 'WAKE_FAILED' },
    { to: 'analyst', at: ago(200 * 1000), ok: false, reason: 'WAKE_FAILED' },
    { to: 'analyst', at: ago(10 * 1000), ok: true, deliveredAt: ago(10 * 1000) },
  ]);
  panel = await refresh();
  check('9688① 先 fail 后 ok（最近一条 ok）→ state=ok，不再「曾失败就永久 fail」',
    rowOf(panel, 'programmer1').state === 'ok' && rowOf(panel, 'programmer1').fail === '1', rowOf(panel, 'programmer1'));
  check('9688② 先 ok 后 fail（最近一条 fail）→ state=fail', rowOf(panel, 'tester').state === 'fail', rowOf(panel, 'tester'));
  check('9688③ 同一条 ok=true + skipped → state=skip（skip 单条优先）', rowOf(panel, 'product').state === 'skip', rowOf(panel, 'product'));
  check('9688④ 计数与状态分离：analyst 24h 失败数=2 但最近一条 ok → state=ok（失败数不决定四态）',
    rowOf(panel, 'analyst').state === 'ok' && rowOf(panel, 'analyst').fail === '2', rowOf(panel, 'analyst'));

  // ── AC2 积压 ≠ 失败 ───────────────────────────────────────
  writeJson(snapshotFile, snapshotOf(baseRoles, now));
  writeWake(wakeFile, [
    { to: 'product', at: ago(20 * 1000), ok: true, deliveredAt: ago(20 * 1000) },
    { to: 'product', at: ago(30 * 1000), ok: true, skipped: 'DEBOUNCED' },
  ]);
  panel = await refresh();
  const productRow = rowOf(panel, 'product');
  check('AC2 排队=3 且无 fail 行 → state ∈ {ok,skip}（不得 fail）', productRow.queued === '3' && ['ok', 'skip'].includes(productRow.state), productRow);
  writeWake(wakeFile, [
    { to: 'product', at: ago(30 * 1000), ok: true, deliveredAt: ago(30 * 1000) },
    // 9688：最近一条必须是 fail，否则按新语义（取最近一次）会判 ok
    { to: 'product', at: ago(20 * 1000), ok: false, reason: 'WAKE_FAILED' },
  ]);
  panel = await refresh();
  const productFail = rowOf(panel, 'product');
  check('AC2 追加 1 条 {ok:false} → state=fail 而排队数仍为 3（数值不被失败态改写）', productFail.state === 'fail' && productFail.queued === '3', productFail);
  const ac2Shot = (await shotOf('sq-ac2-backlog-not-fail.png', '#session-queue-panel')).file;

  // ── AC8 沙盘原句：3 条排队 + 1 条真失败 + 2 条跳过 → 显示 3 / fail1 / skip2 ──
  writeJson(snapshotFile, snapshotOf(baseRoles.map((row) => (row.role === 'product' ? { ...row, queued: 3 } : row)), now));
  writeWake(wakeFile, [
    { to: 'product', at: ago(15 * 1000), ok: false, reason: 'WAKE_FAILED' },
    { to: 'product', at: ago(25 * 1000), ok: true, skipped: 'ALREADY_DELIVERED' },
    { to: 'product', at: ago(35 * 1000), ok: true, skipped: 'DEBOUNCED' },
  ]);
  panel = await refresh();
  const ac8Row = rowOf(panel, 'product');
  check('AC8 沙盘原句：3 条排队 + 1 真失败 + 2 跳过 → 排队 3 / fail 1 / skip 2（state=fail，积压不冒充失败）',
    ac8Row.queued === '3' && ac8Row.fail === '1' && ac8Row.skip === '2' && ac8Row.state === 'fail', ac8Row);
  const ac8Shot = (await shotOf('sq-ac8-3-1-2.png', '#session-queue-panel')).file;

  // ── AC4 未知 ≠ 0 ─────────────────────────────────────────
  const unknownRow = rowOf(panel, 'programmer2');
  check('AC4 known:false → 排队数「—」且 data-sq-known="false"、文本不为 0', unknownRow.queued === '—' && unknownRow.known === 'false' && unknownRow.queued !== '0', unknownRow);

  // ── AC3 背压 ─────────────────────────────────────────────
  const pickRole = async (role) => evalJs(`(() => {
    const sel = document.getElementById('dispatch-role');
    if (!sel) return '';
    if (!Array.from(sel.options).some((o) => o.value === ${JSON.stringify(role)})) {
      const opt = document.createElement('option');
      opt.value = ${JSON.stringify(role)};
      opt.textContent = ${JSON.stringify(role)};
      sel.appendChild(opt);
    }
    sel.value = ${JSON.stringify(role)};
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    return sel.value;
  })()`);
  const picked3 = await pickRole('product'); // product 夹具 queued=3
  await wait(500);
  panel = await evalJs(READ_PANEL);
  check('AC3 排队=3 → [data-backpressure-hint] 存在且文案含「排队 3 条」「先别连发」',
    picked3 === 'product' && panel.hasHint === true && /排队\s*3\s*条/.test(panel.hintText) && /先别连发/.test(panel.hintText),
    { picked3, hasHint: panel.hasHint, hintText: panel.hintText });
  const ac3Shot = (await shotOf('sq-ac3-backpressure.png', '[data-dispatch-entry]')).file;
  // 改排队=2 → 节点必须不存在
  writeJson(snapshotFile, snapshotOf(baseRoles.map((row) => (row.role === 'product' ? { ...row, queued: 2 } : row)), now));
  await refresh();
  const picked2 = await pickRole('product');
  await wait(500);
  panel = await evalJs(READ_PANEL);
  check('AC3 排队=2 → 该节点 querySelector 为 null（不是隐藏）', picked2 === 'product' && panel.hasHint === false && panel.hintCount === 0, { picked2, hasHint: panel.hasHint, hintCount: panel.hintCount });

  // ── AC6 过期降级 ─────────────────────────────────────────
  writeJson(snapshotFile, snapshotOf(baseRoles, Date.now() - 10 * 60 * 1000));
  await refresh();
  await wait(300);
  panel = await evalJs(READ_PANEL);
  check('AC6 快照 10 分钟前 → data-sq-degraded="true" 且黄条可见含原因', panel.degraded === 'true' && panel.bannerHidden === false && /过期/.test(panel.bannerText), { degraded: panel.degraded, bannerHidden: panel.bannerHidden, bannerText: panel.bannerText });
  check('AC6 黄条同时给出最近成功读取时间', /最近成功读取/.test(panel.bannerText || ''), panel.bannerText);
  const ac6Shot = (await shotOf('sq-ac6-degraded.png', '#session-queue-panel')).file;
  writeJson(snapshotFile, snapshotOf(baseRoles, Date.now()));
  await refresh();
  await refresh();
  panel = await evalJs(READ_PANEL);
  check('AC6 恢复新鲜（≤2 刷新周期）后黄条消失、degraded=false', panel.degraded === 'false' && panel.bannerHidden === true, { degraded: panel.degraded, bannerHidden: panel.bannerHidden });

  // ── AC7 无记录 + 旧行兼容 ────────────────────────────────
  writeJson(snapshotFile, snapshotOf(baseRoles, Date.now()));
  writeWake(wakeFile, [
    { to: 'tester', at: ago(25 * 1000), ok: true, deliverAt: ago(25 * 1000), why: '', messageId: 'M-old' },
    { to: 'product', at: ago(35 * 1000), ok: true, skipped: 'DEBOUNCED' },
  ]);
  panel = await refresh();
  const legacyRow = rowOf(panel, 'tester');
  const debouncedRow = rowOf(panel, 'product');
  check('AC7② 旧格式行（deliverAt/why/messageId）仍判 ok，时间取 deliverAt', legacyRow.state === 'ok' && /刚刚|分钟前/.test(legacyRow.lastOk || ''), legacyRow);
  check('AC7③ {ok:true, skipped:DEBOUNCED} → skip', debouncedRow.state === 'skip', debouncedRow);
  check('AC7① 0 行角色 → state=none + 「无记录」', rowOf(panel, 'pm').state === 'none' && rowOf(panel, 'pm').lastOk === '无记录', rowOf(panel, 'pm'));

  // ── 边界：唤醒日志空 → 全部「无记录」 ─────────────────────
  writeWake(wakeFile, []);
  panel = await refresh();
  check('边界·空值：唤醒日志为空 → 全部 none + 无记录（不崩）',
    (panel.rows || []).every((row) => row.state === 'none' && row.lastOk === '无记录'),
    (panel.rows || []).map((row) => `${row.role}:${row.state}/${row.lastOk}`));

  // ── 边界：快照缺失 → 未接入 + 黄条（不显示 0） ─────────────
  fs.rmSync(snapshotFile, { force: true });
  panel = await refresh();
  check('边界·空值：快照不存在 → degraded=true 且黄条含「未接入」', panel.degraded === 'true' && /未接入/.test(panel.bannerText || ''), { degraded: panel.degraded, bannerText: panel.bannerText });
  check('边界·空值：快照不存在时排队数全部「—」而不是 0', (panel.rows || []).every((row) => row.queued === '—' && row.known === 'false'), (panel.rows || []).map((row) => `${row.role}:${row.queued}/${row.known}`));
  const missingShot = (await shotOf('sq-missing.png', '#session-queue-panel')).file;

  // ── 边界：坏 JSON → 沿用上一份 + 黄条（不清空面板） ─────────
  writeJson(snapshotFile, snapshotOf(baseRoles, Date.now()));
  await refresh();
  fs.writeFileSync(snapshotFile, '{ "schema": 1, "roles": [ ', 'utf8');
  panel = await refresh();
  check('边界·异常：快照坏 JSON → 黄条说明并保留上一份数据（不清空、不崩）',
    panel.degraded === 'true' && /解析失败|沿用/.test(panel.bannerText || '') && (panel.rows || []).length === 6,
    { degraded: panel.degraded, bannerText: panel.bannerText, rows: (panel.rows || []).length });
  const brokenShot = (await shotOf('sq-broken.png', '#session-queue-panel')).file;

  // 还原成健康快照，给最终截图
  writeJson(snapshotFile, snapshotOf(baseRoles, Date.now()));
  writeWake(wakeFile, [
    { to: 'programmer1', at: ago(15 * 1000), ok: false, reason: 'WAKE_FAILED' },
    { to: 'tester', at: ago(20 * 1000), ok: true, skipped: 'ALREADY_DELIVERED' },
    { to: 'product', at: ago(25 * 1000), ok: true, deliveredAt: ago(25 * 1000) },
  ]);
  panel = await refresh();
  const finalShot = (await shotOf('sq-final.png', '#session-queue-panel')).file;
  check('还原后回到健康态（degraded=false、六行）', panel.degraded === 'false' && (panel.rows || []).length === 6, { degraded: panel.degraded, rows: (panel.rows || []).length });

  // ── 只读与隔离 ───────────────────────────────────────────
  const wakeSha = sha256Of(wakeFile);
  await refresh();
  await refresh();
  check('只读：多次刷新后沙盘唤醒日志 sha256 未变', sha256Of(wakeFile) === wakeSha, { before: wakeSha.slice(0, 16), after: sha256Of(wakeFile).slice(0, 16) });
  if (realWakeFile) {
    const realAfter = statOf(realWakeFile);
    const prefixSame = realBefore.exists
      ? (realAfter.exists && realAfter.size >= realBefore.size && prefixOf(realWakeFile, realBefore.size) === realBefore.prefixHash)
      : !realAfter.exists;
    check('隔离：真实 团队/状态/项目/<项目>/唤醒.jsonl 前缀未被改写（团队自己追加属正常）',
      prefixSame,
      { realWakeFile, beforeBytes: realBefore.size, afterBytes: realAfter.size, beforePrefix: String(realBefore.prefixHash || '').slice(0, 16), afterPrefix: realAfter.exists ? prefixOf(realWakeFile, realBefore.size).slice(0, 16) : '', exists: realAfter.exists });
  } else {
    check('隔离：没有真实唤醒日志路径（沙盘自足，无需比对）', true);
  }
  check('隔离：自检没有往真实 团队/状态/ 写快照', !fs.existsSync(path.join(outRoot, '团队', '状态', '会话排队.json')), path.join(outRoot, '团队', '状态'));

  // ── B-20261117-180718-9229 两条新增断言 ────────────────────────────────────
  // ①插件 teamRoot 解析不得返回相对路径（现场根因：config:{} + 无 env → 空串 → join('','状态',…)）。
  const { pathToFileURL } = require('node:url');
  const pluginModule = await import(pathToFileURL(path.join(outRoot, 'dsh-plugin', 'pm-workbench-dsh', 'index.js')).href);
  const resolvedRelative = pluginModule.resolveTeamRoot({ teamRoot: 'relative/团队' });
  const relOk = (!resolvedRelative.teamRoot || path.isAbsolute(resolvedRelative.teamRoot))
    && resolvedRelative.tried.some((item) => item.why === 'NOT_ABSOLUTE')
    && (!resolvedRelative.teamRoot ? Boolean(resolvedRelative.error && resolvedRelative.error.code === 'SQ_TEAMROOT_UNRESOLVED') : true);
  check('9-① 插件 teamRoot 解析：配置相对路径 → 不得落相对路径（记为 NOT_ABSOLUTE，最终要么绝对目录要么显式 SQ_TEAMROOT_UNRESOLVED）',
    relOk,
    { teamRoot: resolvedRelative.teamRoot, source: resolvedRelative.source, error: resolvedRelative.error && resolvedRelative.error.code, tried: resolvedRelative.tried.slice(0, 3) });
  check('9-①b 插件 teamRoot 解析：无配置时也能从 workbench.json 上溯或默认目录拿到绝对路径（安装即可用）',
    Boolean(resolvedRelative.teamRoot) && path.isAbsolute(String(resolvedRelative.teamRoot)) && fs.existsSync(path.join(String(resolvedRelative.teamRoot), '状态')),
    { teamRoot: resolvedRelative.teamRoot, source: resolvedRelative.source });

  // ②采集抛错（团队.json 读不到）时：快照必须含 degraded.code 且保留上一份 roles，不得清空。
  const degradeTeamRoot = path.join(outDir, 'degraded-team');
  const degradeStateDir = path.join(degradeTeamRoot, '状态');
  fs.mkdirSync(degradeStateDir, { recursive: true });
  const degradeSnapshot = path.join(degradeStateDir, '会话排队.json');
  const previousRoles = [{ role: 'pm', known: true, queued: 9, byPlacement: { queued: 9 } }];
  writeJson(degradeSnapshot, { schema: 1, at: ago(60 * 1000), project: '沙盘', staleMs: 120000, degraded: null, roles: previousRoles });
  // 故意不写 团队.json → collect 内部抛 SQ_TEAM_JSON_MISSING → 走 degraded 分支
  const collectResult = await pluginModule.collectSessionQueueSnapshot({ sessionController: { state: async () => null } }, { teamRoot: degradeTeamRoot });
  const afterDegrade = (() => { try { return JSON.parse(fs.readFileSync(degradeSnapshot, 'utf8')); } catch { return null; } })();
  check('9-② 采集抛错 → 快照含 degraded.code（SQ_TEAM_JSON_MISSING）且保留上次 roles（不清空）',
    collectResult && collectResult.ok === false && collectResult.code === 'SQ_TEAM_JSON_MISSING'
    && Boolean(afterDegrade && afterDegrade.degraded && afterDegrade.degraded.code === 'SQ_TEAM_JSON_MISSING')
    && Array.isArray(afterDegrade.roles) && afterDegrade.roles.length === previousRoles.length
    && Boolean(afterDegrade.degraded.lastAttemptAt),
    { code: collectResult && collectResult.code, degraded: afterDegrade && afterDegrade.degraded, roles: afterDegrade && (afterDegrade.roles || []).length });
  // 面板侧：degraded 快照必须让面板显示原因（data-sq-reason）而不是只显示「未接入」
  writeJson(snapshotFile, {
    schema: 1, at: ago(30 * 1000), project: teamName || '沙盘', staleMs: 120000,
    degraded: { code: 'SQ_WRITE_FAILED', message: '写快照失败：EACCES', lastAttemptAt: ago(10 * 1000) },
    roles: baseRoles,
  });
  panel = await refresh();
  const reasonAttr = await evalJs("(() => { const p = document.getElementById('session-queue-panel'); return p ? String(p.getAttribute('data-sq-reason') || '') : ''; })()");
  check('9-③ 面板显示降级原因（data-sq-reason=插件 code，banner 含原因与修复指引），且排队数仍显示上次成功值',
    reasonAttr === 'SQ_WRITE_FAILED' && /插件采集异常/.test(panel.bannerText || '') && /修复/.test(panel.bannerText || '')
    && (panel.rows || []).some((row) => row.queued === '0' || row.queued === '3'),
    { reasonAttr, bannerText: String(panel.bannerText || '').slice(0, 120), queued: (panel.rows || []).map((r) => r.queued) });

  const failed = checks.filter((row) => !row.ok);
  const report = {
    ok: failed.length === 0,
    total: checks.length,
    failed: failed.length,
    outDir,
    sandbox: { teamRoot: sandboxTeamRoot, wakeFile, snapshotFile, dataRoot: sandboxRoot },
    checks,
    screenshots: {
      ac1: ac1Shot, ac2: ac2Shot, ac8: ac8Shot, ac3: ac3Shot, ac6: ac6Shot,
      missing: missingShot, broken: brokenShot, final: finalShot,
    },
  };
  fs.writeFileSync(path.join(outDir, 'sq-check.json'), JSON.stringify(report, null, 2), 'utf8');
  if (report.ok) console.log('SESSION_QUEUE_CHECK_OK ' + JSON.stringify({ total: report.total, outDir }));
  else console.log('SESSION_QUEUE_CHECK_FAIL ' + JSON.stringify({ total: report.total, failed: report.failed, outDir }));
  app.exit(report.ok ? 0 : 1);
  return report;
}

module.exports = { runSqCheck, prepareSqCheckSandbox };
