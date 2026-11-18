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
  const storeFile = String(options.storeFile || '');
  // B-20261117-213547-e6c9①：强制隔离——团队根/状态库若落在真实 团队/ 或 项目/ 下，直接 fail fast（不许回退真实路径）。
  const repoRoot = path.resolve(__dirname, '..');
  const realTeam = path.join(repoRoot, '团队');
  const realProjects = path.join(repoRoot, '项目');
  const under = (p, base) => {
    const rp = path.resolve(p); const rb = path.resolve(base);
    return rp === rb || rp.startsWith(rb + path.sep);
  };
  const notIsolated = [
    ['teamRoot', teamRoot], ['storeFile', storeFile],
  ].filter(([, p]) => p && (under(p, realTeam) || under(p, realProjects))).map(([k]) => k);
  if (!teamRoot || !storeFile || notIsolated.length) {
    const message = `SQ_CHECK_NOT_ISOLATED 自检拒绝在真实树上运行（缺变量或路径指向真实 团队/ 项目）：${notIsolated.join(',') || 'teamRoot/storeFile 为空'}`;
    console.log(message);
    throw new Error(message);
  }
  if (teamRoot) fs.mkdirSync(path.join(teamRoot, '状态', '项目'), { recursive: true });
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
  // B-20261117-2133（现场事故）：从真实 store 复制过来的 projects[].path 指向**真实项目目录**，
  // 于是自检期间任何「往项目目录写」的动作（如团队会话清单 团队会话.json 的引导）都会写到真实树里，
  // 把 pm 的 sessionId 写成 sq-fixture-pm → 之后真实 send 被 SESSION_MAP_INCONSISTENT 拦。
  // 修法：store 里的项目路径一律改指沙盘项目目录（不存在就建），自检只能写沙盘。
  const sandboxProjectDir = String(options.sandboxProjectDir || '');
  if (sandboxProjectDir && storeFile && fs.existsSync(storeFile)) {
    try {
      const store = JSON.parse(fs.readFileSync(storeFile, 'utf8').replace(/^\uFEFF/, ''));
      let changed = false;
      for (const p of (Array.isArray(store.projects) ? store.projects : [])) {
        if (!p || typeof p !== 'object') continue;
        const target = path.join(sandboxProjectDir, String(p.teamName || p.name || 'project'));
        if (String(p.path || '') !== target) { p.path = target; changed = true; }
        if (p.workspacePath !== undefined && String(p.workspacePath) !== target) { p.workspacePath = target; changed = true; }
        if (p.workspace && typeof p.workspace === 'object' && String(p.workspace.path || '') !== target) {
          p.workspace.path = target;
          changed = true;
        }
        fs.mkdirSync(target, { recursive: true });
      }
      if (changed) {
        fs.writeFileSync(storeFile, JSON.stringify(store, null, 2) + '\n', 'utf8');
        console.log('SQ_CHECK_STORE_SANDBOXED ' + JSON.stringify({ sandboxProjectDir, storeFile }));
      }
    } catch (e) {
      console.log('SQ_CHECK_STORE_SANDBOX_FAILED ' + JSON.stringify({ storeFile, why: String((e && e.message) || e) }));
    }
  }
  return { teamRoot, storeFile, sandboxProjectDir };
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
    // B-20261118-085825-0950：单条窗口内失败判 retry，这里把 fail 放到重试窗口（90s）之外，保留 fail 判据。
    { to: 'programmer1', at: ago(100 * 1000), ok: false, reason: 'WAKE_FAILED', messageIds: ['M-a'] },
    { to: 'tester', at: ago(30 * 1000), ok: true, skipped: 'ALREADY_DELIVERED', reason: 'dedupe' },
    { to: 'product', at: ago(40 * 1000), ok: true, deliveredAt: ago(40 * 1000), reason: 'default', messageIds: ['M-b'] },
    { to: 'analyst', at: ago(95 * 1000), ok: false, reason: 'WAKE_FAILED' },
    { to: 'analyst', at: ago(120 * 1000), ok: true, skipped: 'MERGED_PENDING' },
    { to: 'analyst', at: ago(130 * 1000), ok: true, deliveredAt: ago(130 * 1000) },
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

  // ── B-20261118-090620-6e39：skip 细分（四类文案 + data-sq-skip-reason + 黄点不红）─────────
  writeWake(wakeFile, [
    { to: 'pm', at: ago(20 * 1000), ok: true, skipped: 'SANDBOX_WAKE_SKIPPED', reason: 'mailbox_digest', sandboxReason: 'sandbox_root', sandboxWhy: 'env_root' },
    { to: 'product', at: ago(30 * 1000), ok: true, skipped: 'DEBOUNCED', reason: 'debounce' },
    { to: 'tester', at: ago(30 * 1000), ok: true, skipped: 'MERGED_PENDING', reason: 'merge' },
    { to: 'programmer2', at: ago(30 * 1000), ok: true, skipped: 'ALREADY_DELIVERED', reason: 'dedupe' },
  ]);
  panel = await refresh();
  const SKIP_DOM = `(() => {
    const out = { rows: {} };
    const rootStyle = getComputedStyle(document.documentElement);
    out.varGold = rootStyle.getPropertyValue('--gold').trim();
    out.varRed = rootStyle.getPropertyValue('--red').trim();
    for (const row of Array.from(document.querySelectorAll('[data-sq-row]'))) {
      const role = row.getAttribute('data-role');
      const chip = row.querySelector('[data-sq-state]');
      const reason = row.querySelector('[data-sq-skip-reason]');
      out.rows[role] = {
        state: chip ? chip.textContent.trim() : '',
        reason: reason ? reason.textContent.trim() : '',
        why: reason ? reason.getAttribute('data-sq-skip-reason') : '',
        reasonColor: reason ? getComputedStyle(reason).color : '',
        stateColor: chip ? getComputedStyle(chip).color : '',
        rowWhy: row.getAttribute('data-sq-skip-reason') || '',
      };
    }
    return out;
  })()`;
  const skipDom = await evalJs(SKIP_DOM);
  const goldRgb = (() => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(skipDom.varGold || '').trim());
    if (!m) return '';
    const n = parseInt(m[1], 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
  })();
  const redRgb = (() => {
    const m = /^#?([0-9a-f]{6})$/i.exec(String(skipDom.varRed || '').trim());
    if (!m) return '';
    const n = parseInt(m[1], 16);
    return `rgb(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255})`;
  })();
  const sr = (role) => (skipDom.rows || {})[role] || {};
  check('B-6e39 面板 skip 四类文案（沙盘跳过/去抖/已合并/已去重）+ data-sq-skip-reason',
    sr('pm').reason === '沙盘跳过' && sr('pm').why === 'sandbox' && sr('pm').rowWhy === 'sandbox'
    && sr('product').reason === '去抖' && sr('product').why === 'debounced'
    && sr('tester').reason === '已合并' && sr('tester').why === 'merged'
    && sr('programmer2').reason === '已去重' && sr('programmer2').why === 'dedupe',
    { dom: skipDom.rows, goldRgb });
  check('B-6e39 黄点不红：skip 状态 chip 取主题 --gold、原因 chip 不是 --red，state 文本仍是 skip',
    ['pm', 'product', 'tester', 'programmer2'].every((role) => sr(role).state === 'skip')
    && ['pm', 'product', 'tester', 'programmer2'].every((role) => Boolean(goldRgb) && sr(role).stateColor === goldRgb)
    && ['pm', 'product', 'tester', 'programmer2'].every((role) => Boolean(sr(role).reasonColor) && sr(role).reasonColor !== redRgb),
    { dom: skipDom.rows, goldRgb, redRgb });
  check('B-6e39 沙盘跳过 hover 带原因（title 含 sandbox=env_root）',
    await evalJs(`(() => {
      const row = Array.from(document.querySelectorAll('[data-sq-row]')).find((el) => el.getAttribute('data-role') === 'pm');
      const reason = row ? row.querySelector('[data-sq-skip-reason]') : null;
      return Boolean(reason) && /sandbox=env_root/.test(String(reason.title || ''));
    })()`) === true,
    {});
  const skipShot = (await shotOf('sq-b6e39-skip-reasons.png', '#session-queue-panel')).file;
  void skipShot;

  // ── B-20261118-085825-0950：单次失败 + 已排重试 → retry（重试中，黄），不再闪红 ─────────
  writeWake(wakeFile, [
    { to: 'programmer2', at: ago(20 * 1000), ok: false, retried: true, reason: 'fetch failed', messageIds: ['M-retry'] },
  ]);
  panel = await refresh();
  const retryRow = rowOf(panel, 'programmer2');
  const retryDom = await evalJs(`(() => {
    const row = Array.from(document.querySelectorAll('[data-sq-row]')).find((el) => el.getAttribute('data-role') === 'programmer2');
    if (!row) return null;
    const chip = row.querySelector('[data-sq-state]');
    return chip ? { text: chip.textContent.trim(), cls: chip.className, color: getComputedStyle(chip).color } : null;
  })()`);
  check('B-950 单次失败（retried=true，20s 前）→ state=retry（不是 fail）、文案「重试中」、样式 sq-state-retry（黄）',
    (retryRow.state === 'retry' || /重试中/.test(String(retryRow.state || '')))
    && Boolean(retryDom) && /重试中/.test(retryDom.text) && /sq-state-retry/.test(retryDom.cls)
    && /227,\s*179,\s*65/.test(String(retryDom.color)),
    { state: retryRow.state, dom: retryDom });
  const retryShot = (await shotOf('sq-b950-retry-state.png', '#session-queue-panel')).file;

  // ── B-20261117-192034-e9b5（Owner 19:20 截图）：可读性——字号 9px→≥13px、补列头、面板宽 ≥560 ──
  const READABLE = `(() => {
    const panel = document.getElementById('session-queue-panel');
    const header = document.getElementById('session-queue-header');
    const rowsHost = document.getElementById('session-queue-rows');
    const drawer = document.getElementById('session-queue-drawer');
    const row = document.querySelector('[data-sq-row]');
    const state = row ? row.querySelector('[data-sq-state]') : null;
    const px = (n) => (n ? parseFloat(getComputedStyle(n).fontSize) || 0 : 0);
    const rowsEls = Array.from(document.querySelectorAll('[data-sq-row]'));
    return {
      hasHeader: Boolean(header),
      headerVisible: Boolean(header) && getComputedStyle(header).display !== 'none',
      headerCells: header ? Array.from(header.children).map((c) => String(c.textContent || '').trim()) : [],
      headerAnchor: header ? header.getAttribute('data-sq-header') : '',
      rowFont: px(row), stateFont: px(state), headerFont: px(header),
      drawerWidth: drawer ? Math.round(drawer.getBoundingClientRect().width) : 0,
      rowsOverflow: rowsHost ? { scrollWidth: rowsHost.scrollWidth, clientWidth: rowsHost.clientWidth } : null,
      rowsCount: rowsEls.length,
      anchorsKept: rowsEls.every((n) => n.hasAttribute('data-sq-row')
        && Boolean(n.querySelector('[data-sq-queued]')) && Boolean(n.querySelector('[data-sq-state]'))
        && Boolean(n.querySelector('[data-sq-fail-count]')) && Boolean(n.querySelector('[data-sq-skip-count]'))
        && Boolean(n.querySelector('[data-sq-last-ok]'))),
      panelDegraded: panel ? panel.getAttribute('data-sq-degraded') : '',
    };
  })()`;
  const readable = await evalJs(READABLE);
  // ── T-20261117-211833-7a30（R-a4c7）AC5②：调度建议锚点必须挂在既有抽屉里（#session-queue-sched + data-sched-*）──
  const SCHED_ROWS = `(() => {
    const box = document.getElementById('session-queue-sched');
    const drawer = document.getElementById('session-queue-drawer');
    const rows = Array.from(document.querySelectorAll('[data-sched-role]'));
    return {
      boxExists: Boolean(box),
      inDrawer: Boolean(box && drawer && drawer.contains(box)),
      at: box ? String(box.getAttribute('data-sched-at') || '') : '',
      empty: box ? box.getAttribute('data-sched-empty') === '1' : false,
      rows: rows.length,
      rowsOk: rows.every((n) => n.hasAttribute('data-sched-advice')
        && n.hasAttribute('data-sched-level') && n.hasAttribute('data-sched-reason') && n.hasAttribute('data-sched-available')),
      decisions: rows.map((n) => n.getAttribute('data-sched-advice')),
      availableFlags: rows.map((n) => n.getAttribute('data-sched-available')),
    };
  })()`;
  const schedPanel = await evalJs(SCHED_ROWS);
  check('调度建议锚点在既有抽屉内（#session-queue-sched / data-sched-role/advice/level/reason/at）',
    schedPanel.boxExists === true && schedPanel.inDrawer === true
    && schedPanel.rows > 0 && schedPanel.rowsOk === true && Boolean(schedPanel.at), schedPanel);
  check('可读性：列头存在（data-sq-header）且 6 列（角色 + 排队数 / 四态 / 失败 / 跳过 / 最近成功投递）',
    readable.hasHeader === true && readable.headerAnchor === '1' && readable.headerCells.length === 6, readable.headerCells);
  const headerText = (readable.headerCells || []).join('|');
  check('可读性：列头写清含义与统计窗口（失败数(24h) / 跳过数(24h) 必须出现）',
    ['排队数', '四态', '失败数(24h)', '跳过数(24h)', '最近成功投递'].every((t) => headerText.includes(t)), headerText);
  check('可读性：数据行字号 ≥13px、四态徽标 ≥12px、列头 ≥12px（原来行 9px / 说明 8.5px）',
    readable.rowFont >= 13 && readable.stateFont >= 12 && readable.headerFont >= 12,
    { rowFont: readable.rowFont, stateFont: readable.stateFont, headerFont: readable.headerFont });
  check('可读性：面板宽 ≥560px（六列数字不挤压）', readable.drawerWidth >= 560, { drawerWidth: readable.drawerWidth });
  check('可读性：行容器无横向滚动（scrollWidth<=clientWidth）',
    Boolean(readable.rowsOverflow) && readable.rowsOverflow.scrollWidth <= readable.rowsOverflow.clientWidth + 1, readable.rowsOverflow);
  check('可读性：现有 data-sq-* 锚点全部保留（六行 × 排队数/四态/失败数/跳过数/最近成功）',
    readable.rowsCount === 6 && readable.anchorsKept === true, { rowsCount: readable.rowsCount, anchorsKept: readable.anchorsKept });
  // before/after：改前用旧样式覆盖复现（9px + 无列头），改后恢复真实样式；同一窗口、同一宽度、同一夹具。
  // Owner 常用 1280 宽 → 先把内容区切到 1280×800 再拍，拍完还原。
  const prevContentSize = win.getContentSize();
  try { win.setContentSize(1280, 800); } catch { /* 切不动就按当前宽度拍，不阻断 */ }
  await wait(600);
  const narrow = await evalJs(READABLE);
  check('可读性：1280 宽下字号 ≥13px、面板宽 ≥560px、行容器无横向滚动',
    narrow.rowFont >= 13 && narrow.drawerWidth >= 560
    && Boolean(narrow.rowsOverflow) && narrow.rowsOverflow.scrollWidth <= narrow.rowsOverflow.clientWidth + 1,
    { rowFont: narrow.rowFont, drawerWidth: narrow.drawerWidth, rowsOverflow: narrow.rowsOverflow });
  const OLD_STYLE_ID = 'sq-readability-old-style';
  await evalJs(`(() => {
    if (document.getElementById(${JSON.stringify(OLD_STYLE_ID)})) return true;
    const s = document.createElement('style');
    s.id = ${JSON.stringify(OLD_STYLE_ID)};
    s.textContent = '#session-queue-header{display:none!important}.sq-row{font-size:9px!important;padding:3px 6px!important;gap:6px!important;grid-template-columns:minmax(64px,1.4fr) 44px 52px 34px 34px minmax(64px,1fr)!important}#session-queue-drawer{min-width:0!important}';
    document.head.appendChild(s);
    return true;
  })()`);
  await wait(250);
  const beforeReadable = await evalJs(READABLE);
  const readableBeforeShot = (await shotOf('sq-readable-before.png', '#session-queue-panel')).file;
  await evalJs(`(() => { const n = document.getElementById(${JSON.stringify(OLD_STYLE_ID)}); if (n) n.remove(); return true; })()`);
  await wait(250);
  const restoredReadable = await evalJs(READABLE);
  check('可读性：移除 before 覆盖后列头恢复可见、字号回到 ≥13px（after 图拍的是真实样式）',
    restoredReadable.headerVisible === true && restoredReadable.rowFont >= 13,
    { headerVisible: restoredReadable.headerVisible, rowFont: restoredReadable.rowFont });
  const readableAfterShot = (await shotOf('sq-readable-after.png', '#session-queue-panel')).file;
  check('可读性：before 覆盖确实复现旧样式（行 ≤9px 且列头不可见），不是「改后再拍一张」',
    beforeReadable.rowFont > 0 && beforeReadable.rowFont <= 9 && beforeReadable.headerVisible === false,
    { rowFont: beforeReadable.rowFont, headerVisible: beforeReadable.headerVisible });
  check('可读性：before/after 截图都已落盘（同窗口同宽同夹具，1280 宽）',
    Boolean(readableBeforeShot) && Boolean(readableAfterShot), { readableBeforeShot, readableAfterShot });
  try { win.setContentSize(prevContentSize[0], prevContentSize[1]); } catch { /* 还原失败不影响断言 */ }
  await wait(400);

  // ── B-20261117-181420-9688（P1）：四态取「最近一次投递」，计数与状态分离 ─────────
  writeJson(snapshotFile, snapshotOf(baseRoles, now));
  writeWake(wakeFile, [
    // 9688① 先失败、最近一次成功 → 必须 ok（旧实现会永久 fail）
    { to: 'programmer1', at: ago(120 * 1000), ok: false, reason: 'WAKE_FAILED' },
    { to: 'programmer1', at: ago(10 * 1000), ok: true, deliveredAt: ago(10 * 1000) },
    // 9688② 先成功、最近一次失败 → fail（B-950：fail 放到 retry 窗口外，保持 fail 判据）
    { to: 'tester', at: ago(130 * 1000), ok: true, deliveredAt: ago(130 * 1000) },
    { to: 'tester', at: ago(100 * 1000), ok: false, reason: 'WAKE_FAILED' },
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
    { to: 'product', at: ago(130 * 1000), ok: true, deliveredAt: ago(130 * 1000) },
    // 9688：最近一条必须是 fail，否则按新语义（取最近一次）会判 ok；B-950：放到 retry 窗口外保持 fail
    { to: 'product', at: ago(100 * 1000), ok: false, reason: 'WAKE_FAILED' },
  ]);
  panel = await refresh();
  const productFail = rowOf(panel, 'product');
  check('AC2 追加 1 条 {ok:false} → state=fail 而排队数仍为 3（数值不被失败态改写）', productFail.state === 'fail' && productFail.queued === '3', productFail);
  const ac2Shot = (await shotOf('sq-ac2-backlog-not-fail.png', '#session-queue-panel')).file;

  // ── AC8 沙盘原句：3 条排队 + 1 条真失败 + 2 条跳过 → 显示 3 / fail1 / skip2 ──
  writeJson(snapshotFile, snapshotOf(baseRoles.map((row) => (row.role === 'product' ? { ...row, queued: 3 } : row)), now));
  writeWake(wakeFile, [
    // B-6118-085825-0950：fail 放到 retry 窗口（90s）外，状态仍是 fail，计数 1/2 不变。
    { to: 'product', at: ago(100 * 1000), ok: false, reason: 'WAKE_FAILED' },
    { to: 'product', at: ago(120 * 1000), ok: true, skipped: 'ALREADY_DELIVERED' },
    { to: 'product', at: ago(130 * 1000), ok: true, skipped: 'DEBOUNCED' },
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
  // B-20261117-192034-e9b5 补：真实 团队/状态/会话排队.json 现在由 DSH 插件正常产出（本机重启后已有），
  // 所以不能再断言「文件不存在」——改为断言「真实快照不是本次沙盘写的」（teamRoot 指向真实团队，不落在沙盘根下）。
  const realSnapshot = path.join(outRoot, '团队', '状态', '会话排队.json');
  const realSnapshotInfo = (() => {
    if (!fs.existsSync(realSnapshot)) return { exists: false, teamRoot: '', project: '' };
    try {
      const parsed = JSON.parse(fs.readFileSync(realSnapshot, 'utf8'));
      return { exists: true, teamRoot: String(parsed.teamRoot || ''), project: String(parsed.project || '') };
    } catch { return { exists: true, teamRoot: '<unparsable>', project: '' }; }
  })();
  const realSnapshotNotFromSandbox = !realSnapshotInfo.exists
    || Boolean(realSnapshotInfo.teamRoot) && !realSnapshotInfo.teamRoot.toLowerCase().startsWith(String(sandboxRoot).toLowerCase());
  check('隔离：自检没有往真实 团队/状态/ 写快照（真实快照若存在，teamRoot 必须指向真实团队而不是本次沙盘）',
    realSnapshotNotFromSandbox, { realSnapshot, sandboxRoot, ...realSnapshotInfo });

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

  // ── R-20261118-131107-28b8：旧会话自动归档失败可见（面板黄点 + 摘要行后缀，渲染层只读 model） ──
  const teamTools = require('./team-tools.js');
  const ledgerProjectDir = path.join(stateDir, '项目', teamTools.teamSlug(teamName || '沙盘'));
  const ledgerFile = path.join(ledgerProjectDir, '会话归档.jsonl');
  const writeLedger = (rows) => {
    fs.mkdirSync(path.dirname(ledgerFile), { recursive: true });
    fs.writeFileSync(ledgerFile, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
    const nowDate = new Date();
    try { fs.utimesSync(ledgerFile, nowDate, nowDate); } catch { /* mtime 刷不动也不影响内容变化 */ }
  };
  writeJson(snapshotFile, snapshotOf(baseRoles, Date.now()));
  writeLedger([{
    at: ago(30 * 1000), project: teamName || '沙盘', role: 'tester',
    oldSessionId: 'sq-fixture-old-tester', newSessionId: 'sq-fixture-tester',
    result: 'failed', reason: 'EACCES 写盘失败', attempts: 3, source: 'sweep', auto: true,
  }]);
  panel = await refresh();
  const archiveDom = await evalJs(`(() => {
    const live = document.querySelector('[data-live-row][data-role="tester"]');
    const sq = document.querySelector('[data-sq-row][data-role="tester"]');
    const summary = document.getElementById('session-queue-summary');
    return {
      liveFlag: live ? String(live.getAttribute('data-sq-archive-failed') || '') : '',
      liveTitle: live ? String(live.getAttribute('title') || '') : '',
      liveDot: live ? Boolean(live.querySelector('[data-sq-archive-dot]')) : false,
      sqFlag: sq ? String(sq.getAttribute('data-sq-archive-failed') || '') : '',
      flagged: document.querySelectorAll('[data-live-row][data-sq-archive-failed="1"]').length,
      summary: summary ? String(summary.textContent || '') : '',
    };
  })()`);
  check('28b8-① 归档失败 → 该角色行 data-sq-archive-failed="1" + 黄点 + title 含原因（值来自 model，不读盘）',
    archiveDom.liveFlag === '1' && archiveDom.sqFlag === '1' && archiveDom.liveDot && /EACCES/.test(archiveDom.liveTitle),
    archiveDom);
  check('28b8-② 摘要行末尾「· 有 1 个归档失败」（取 model.archiveFailures.total）',
    /· 有 1 个归档失败$/.test(String(archiveDom.summary || '')),
    { summary: archiveDom.summary });
  check('28b8-③ 只有失败角色亮黄点（其它角色不连带）',
    Number(archiveDom.flagged) === 1,
    { flagged: archiveDom.flagged });
  writeLedger([{
    at: ago(20 * 1000), project: teamName || '沙盘', role: 'tester',
    oldSessionId: 'sq-fixture-old-tester', newSessionId: 'sq-fixture-tester',
    result: 'archived', reason: 'rotate-auto', archiveId: 'A-fixture-tester',
  }]);
  panel = await refresh();
  const archiveCleared = await evalJs(`(() => ({
    flagged: document.querySelectorAll('[data-sq-archive-failed]').length,
    summary: String((document.getElementById('session-queue-summary') || {}).textContent || ''),
  }))()`);
  check('28b8-④ 账本无 failed 行 → 黄点消失、摘要无「归档失败」后缀（不残留）',
    Number(archiveCleared.flagged) === 0 && !/归档失败/.test(String(archiveCleared.summary || '')),
    archiveCleared);
  try { fs.rmSync(ledgerFile, { force: true }); } catch { /* 清理失败不影响结论 */ }

  // ── B-20261118-144907-b318：自动换人栏陈旧状态（时效/关闭态/历史码/设计内超时/真失败） ──
  // 数据源＝团队/状态/项目/<项目slug>/自动换人.jsonl；enabled 取自 团队.json → config.autoRotate（与名册同一次读盘）。
  const autoRotateFile = path.join(ledgerProjectDir, '自动换人.jsonl');
  const writeAutoRotate = (rows) => {
    fs.mkdirSync(path.dirname(autoRotateFile), { recursive: true });
    fs.writeFileSync(autoRotateFile, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
    const nowDate = new Date();
    try { fs.utimesSync(autoRotateFile, nowDate, nowDate); } catch { /* mtime 刷不动不影响内容变化 */ }
  };
  const writeRoster = (autoRotate) => writeJson(rosterFile, {
    activeProject: teamName || '沙盘',
    members: ROSTER.map((row) => ({ ...row })),
    config: autoRotate ? { autoRotate } : {},
  });
  const readAr = async () => evalJs(`(() => {
    const rows = Array.from(document.querySelectorAll('[data-sq-row]')).map((row) => ({
      role: row.dataset.role || '',
      state: String(row.getAttribute('data-ar-state') || ''),
      chip: String((row.querySelector('.sq-ar-chip') || {}).textContent || '').trim(),
      error: String((row.querySelector('[data-ar-error]') || {}).textContent || '').trim(),
      history: String((row.querySelector('[data-ar-history]') || {}).textContent || '').trim(),
      reason: String((row.querySelector('[data-ar-reason]') || {}).textContent || '').trim(),
      tail: String((row.querySelector('[data-ar-audit-tail]') || {}).textContent || '').trim(),
    }));
    const byRole = {};
    for (const row of rows) byRole[row.role] = row;
    const summaryEl = document.querySelector('[data-ar-summary]');
    return { byRole, summary: summaryEl ? String(summaryEl.textContent || '') : '' };
  })()`);
  writeJson(snapshotFile, snapshotOf(baseRoles, Date.now()));
  // ③ 先验「设计内超时不计失败」：只有 HANDOVER_TIMEOUT 时失败数必须是 0（旧实现会算 1）。
  writeAutoRotate([{ at: ago(2 * 60 * 1000), role: 'tester', stage: 'skipped', code: 'HANDOVER_TIMEOUT', result: 'ok' }]);
  writeRoster({ enabled: true, mode: 'auto' });
  panel = await refresh();
  const arTimeoutOnly = await readAr();
  check('B318-③ HANDOVER_TIMEOUT 不计入失败数（只有它时 [data-ar-summary] 失败 0 次）',
    /失败 0 次/.test(String(arTimeoutOnly.summary || '')), { summary: arTimeoutOnly.summary });
  writeAutoRotate([
    // pm：50 分钟前的 rotate（陈旧，不得再显示「正在换人」）+ 60 分钟前的旧错误码（灰字历史，不红）
    { at: ago(50 * 60 * 1000), role: 'pm', stage: 'rotate', code: 'ROTATED', result: 'ok', note: '已换人（夹具）' },
    { at: ago(60 * 60 * 1000), role: 'pm', stage: 'boot_check', code: 'ROTATE_MANUAL_REQUIRED', result: 'fail' },
    // tester：2 分钟前的 HANDOVER_TIMEOUT（设计内，黄色，不算失败）
    { at: ago(2 * 60 * 1000), role: 'tester', stage: 'skipped', code: 'HANDOVER_TIMEOUT', result: 'ok' },
    // analyst：1 分钟前的真失败（红）
    { at: ago(60 * 1000), role: 'analyst', stage: 'failed', code: 'ROTATE_FAILED', result: 'fail' },
    // product：5 分钟前的交接请求（等回执，黄）
    { at: ago(5 * 60 * 1000), role: 'product', stage: 'trigger', code: '', result: 'ok' },
  ]);
  writeRoster({ enabled: false, mode: 'remind-only' });
  panel = await refresh();
  const arDisabled = await readAr();
  const arRoles = Object.keys(arDisabled.byRole || {});
  check('B318-① enabled=false → 所有角色 data-ar-state=disabled，chip 文案含「已关闭」',
    arRoles.length === 6 && arRoles.every((role) => arDisabled.byRole[role].state === 'disabled' && /已关闭/.test(arDisabled.byRole[role].chip)),
    { roles: arRoles, pm: arDisabled.byRole.pm && arDisabled.byRole.pm.chip });
  check('B318-② 关闭态仍把旧错误码放灰字历史（[data-ar-history] 含 ROTATE_MANUAL_REQUIRED，红 error 为空）',
    /ROTATE_MANUAL_REQUIRED/.test(String(arDisabled.byRole.pm.history || '')) && String(arDisabled.byRole.pm.error || '') === '',
    arDisabled.byRole.pm);
  check('B318-③b 失败数只算真失败：2 条真失败（pm 旧错误码 + analyst 新失败），HANDOVER_TIMEOUT 不计',
    /失败 2 次/.test(String(arDisabled.summary || '')), { summary: arDisabled.summary });
  const b318Shot = (await shotOf('sq-b318-ar.png', '#session-queue-panel')).file;
  // 打开开关：陈旧 rotate 不得显示「正在换人」；旧错误码灰字；设计内超时黄；真失败红。
  writeRoster({ enabled: true, mode: 'auto' });
  panel = await refresh();
  const arOn = await readAr();
  check('B318-④ 50 分钟前的 rotate → 不再 rotating/rebooting（陈旧事件回落 history）',
    arOn.byRole.pm.state === 'history',
    arOn.byRole.pm);
  check('B318-⑤ 旧错误码只作灰字历史（reason 写「历史：…已恢复」），红 error 为空',
    /历史：ROTATE_MANUAL_REQUIRED/.test(String(arOn.byRole.pm.reason || arOn.byRole.pm.history || '')) && String(arOn.byRole.pm.error || '') === '',
    arOn.byRole.pm);
  check('B318-⑥ HANDOVER_TIMEOUT → 黄色设计内（state=warn、reason 含「设计内」）',
    arOn.byRole.tester.state === 'warn' && /设计内/.test(String(arOn.byRole.tester.reason || '')),
    arOn.byRole.tester);
  check('B318-⑦ 最近 1 分钟真失败 → failed + [data-ar-error]=ROTATE_FAILED（红）',
    arOn.byRole.analyst.state === 'failed' && String(arOn.byRole.analyst.error || '') === 'ROTATE_FAILED',
    arOn.byRole.analyst);
  check('B318-⑧ 5 分钟前 trigger → pending_handover（等交接回执）',
    arOn.byRole.product.state === 'pending_handover',
    arOn.byRole.product);
  try { fs.rmSync(autoRotateFile, { force: true }); } catch { /* 清理失败不影响结论 */ }
  writeRoster(null);

  // ── B-20261118-163409-6705：busy 期间推送不丢（pendingRefresh）+ 新鲜度只随成功刷新前进 ──
  // 走真实 bindPush 回调（window.__sqPush）与真实 refresh（window.__sqRefresh），不新增数据通道。
  // 关抽屉把降级自检停掉（drawerVisible=false → 定时器只 return），避免 5s 自检并发刷新污染计数。
  const burst = await evalJs(`(async () => {
    const d = document.getElementById('session-queue-drawer');
    const wasHidden = d ? d.hidden : true;
    if (d) d.hidden = true;
    for (let i = 0; i < 40; i++) { if (!window.__sqStats().busy) break; await new Promise((r) => setTimeout(r, 25)); }
    const before = window.__sqStats();
    const p1 = window.__sqRefresh();          // 先进入 busy
    const pushed1 = window.__sqPush();        // busy 期间推送 1
    const pushed2 = window.__sqPush();        // busy 期间推送 2（合并为一次补跑）
    await p1;                                 // 补跑在同一 promise 链里，await 会等到补跑结束
    const after = window.__sqStats();
    if (d) d.hidden = wasHidden;
    return { before, after, pushed1, pushed2, rows: ((window.__sqModel() || {}).rows || []).length };
  })()`);
  check('B6705-① busy 期间两次推送不丢：合并为 1 次补跑（pendingRuns +1、busyReturns +2、refreshCalls +4＝2 次真跑+2 次 busy 返回）',
    burst.pushed1 === true && burst.pushed2 === true
    && burst.after.pendingRuns - burst.before.pendingRuns === 1
    && burst.after.busyReturns - burst.before.busyReturns === 2
    && burst.after.refreshCalls - burst.before.refreshCalls === 4
    && burst.after.lastModelAtUpdates - burst.before.lastModelAtUpdates === 2,
    { before: burst.before, after: burst.after, pushed: [burst.pushed1, burst.pushed2] });
  check('B6705-② 补跑后模型仍完整（六角色行，不是空模型）',
    burst.rows === 6, { rows: burst.rows });
  check('B6705-③ 新鲜度只随成功刷新前进：lastModelAtUpdates === refreshCalls - busyReturns（且 > 0）',
    burst.after.lastModelAt > 0 && burst.after.lastModelAtUpdates === burst.after.refreshCalls - burst.after.busyReturns,
    { stats: burst.after });

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
      b318: b318Shot,
    },
  };
  fs.writeFileSync(path.join(outDir, 'sq-check.json'), JSON.stringify(report, null, 2), 'utf8');
  if (report.ok) console.log('SESSION_QUEUE_CHECK_OK ' + JSON.stringify({ total: report.total, outDir }));
  else console.log('SESSION_QUEUE_CHECK_FAIL ' + JSON.stringify({ total: report.total, failed: report.failed, outDir }));
  app.exit(report.ok ? 0 : 1);
  return report;
}

module.exports = { runSqCheck, prepareSqCheckSandbox };
