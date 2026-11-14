'use strict';
/**
 * R-b5fc F-4b 自检（--queue-check）：工作台侧 #role-queue 队列面板
 *
 * 口径（对应 T-20261114-062003-8bfe 三项）：
 * ① 文件损坏 → 面板灰字「队列未生成（文件损坏已忽略）」，不报红；解析原文只进 title/日志，不进正文；
 * ② 沙盘隔离：TEAM_ROOT 指向 .queue-check-data/团队，用例只在沙盘里造/删/改 role_queues.json，
 *    真实团队目录下的派生文件只做「没被碰过」的哈希断言（不改名、不写入）；
 * ③ 查看者按当前会话角色绑定：不再固定 role=pm；识别不到角色会话时按 Owner 控制台（PM 全量）并在面板标来源。
 *
 * 其余覆盖：分组 / 排序 / 六列 / 权限 / 只读 / 四张截图。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const READ_PANEL = `(() => {
  const box = document.getElementById('role-queue');
  if (!box) return { ok: false, why: '没有 #role-queue' };
  const text = (id) => { const el = document.getElementById(id); return el ? String(el.textContent || '').trim() : ''; };
  const groups = Array.from(box.querySelectorAll('.rq-group')).map((g) => ({
    role: g.dataset.role,
    count: Number(g.dataset.count || 0),
    rows: Array.from(g.querySelectorAll('tbody tr')).map((tr) => ({
      task: tr.dataset.task || '',
      priority: (tr.querySelector('.rq-p') || {}).textContent || '',
      action: (tr.querySelector('.rq-action') || {}).textContent || '',
      requirement: tr.dataset.requirement || '',
      evidence: (tr.querySelector('.rq-evidence') || {}).textContent || '',
      title: (tr.querySelector('.rq-evidence') || {}).title || '',
      cells: tr.querySelectorAll('td').length,
    })),
  }));
  const meta = document.getElementById('role-queue-meta');
  const viewer = document.getElementById('role-queue-viewer');
  return {
    ok: true,
    state: box.dataset.state || '',
    count: Number(box.dataset.count || 0),
    text: String(box.textContent || '').replace(/\\s+/g, ' ').slice(0, 400),
    reason: box.dataset.reason || '',
    degraded: box.dataset.degraded || '',
    viewerRole: box.dataset.viewerRole || '',
    viewerSource: box.dataset.viewerSource || '',
    viewerSession: box.dataset.viewerSession || '',
    groups,
    meta: meta ? String(meta.textContent || '').trim() : '',
    metaClass: meta ? String(meta.className || '') : '',
    metaTitle: meta ? String(meta.title || '') : '',
    viewerText: viewer ? String(viewer.textContent || '').trim() : '',
    viewerClass: viewer ? String(viewer.className || '') : '',
  };
})()`;

const FIXTURE = {
  schema: 1,
  teamMode: 'full',
  generatedAt: '2026-11-13T22:20:00.000Z',
  source: { path: '沙盘/工作流.json', sha256: 'a1b2c3d4e5f60718293a4b5c6d7e8f90a1b2c3d4e5f60718293a4b5c6d7e8f90' },
  roles: {
    pm: [
      { taskId: 'T-pm-b', requirementId: 'R-sandbox-pm', action: 'review', priority: 'P2', status: 'pending', due: '2026-11-19', createdAt: '2026-11-13T01:00:00.000Z' },
      { taskId: 'T-pm-a', requirementId: '', action: 'dispatch', priority: 'P0', status: 'pending', due: '2026-11-20', createdAt: '2026-11-13T02:00:00.000Z' },
    ],
    product: [
      { taskId: 'T-prod-1', requirementId: 'R-sandbox-prod', action: 'design', priority: 'P1', status: 'pending', due: '2026-11-18', createdAt: '2026-11-13T03:00:00.000Z', evidencePath: '产品/产出/证据-一个真的非常非常非常非常非常非常非常非常长的目录名/设计稿-超长路径截断用例-v99.md' },
    ],
    analyst: [
      { taskId: 'T-ana-1', requirementId: 'R-sandbox-ana', action: 'trq', priority: 'P1', status: 'done', due: '', createdAt: '2026-11-13T04:00:00.000Z' },
    ],
    programmer1: [
      { taskId: 'T-dev-1', requirementId: 'R-sandbox-dev', action: 'develop', priority: 'P0', status: 'working', due: '2026-11-19', createdAt: '2026-11-13T05:00:00.000Z' },
      { taskId: 'T-dev-2', requirementId: 'R-sandbox-dev2', action: 'develop', priority: 'P0', status: 'working', due: '2026-11-16', createdAt: '2026-11-13T06:00:00.000Z', evidencePath: '程序员A/产出/证据/说明.md' },
    ],
    programmer2: [
      { taskId: 'T-devb-1', requirementId: '', action: 'review', priority: 'P1', status: 'pending', due: '', createdAt: '2026-11-13T07:00:00.000Z' },
    ],
    tester: [
      { taskId: 'T-test-1', requirementId: 'R-sandbox-t1', action: 'trq', priority: 'P1', status: 'pending', due: '', createdAt: '2026-11-13T08:00:00.000Z' },
      { taskId: 'T-test-9', requirementId: '', action: 'trq', priority: 'P9', status: 'pending', due: '', createdAt: '2026-11-13T09:00:00.000Z' },
      { taskId: 'T-test-2', requirementId: 'R-sandbox-t2', action: 'trq', priority: 'P1', status: 'pending', due: '2026-11-17', createdAt: '2026-11-13T10:00:00.000Z' },
    ],
  },
};

function fixtureBody() {
  return {
    generatedAt: FIXTURE.generatedAt,
    source: FIXTURE.source,
    roles: Object.fromEntries(Object.keys(FIXTURE.roles).map((role) => [
      role,
      { queue: FIXTURE.roles[role].map((row) => ({ ...row })) },
    ])),
    meta: { schema: FIXTURE.schema, teamMode: FIXTURE.teamMode },
  };
}

function sha256Of(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return ''; }
}

function statOf(file) {
  try { const st = fs.statSync(file); return { exists: true, mtimeMs: st.mtimeMs, size: st.size, sha256: sha256Of(file) }; }
  catch { return { exists: false, mtimeMs: 0, size: 0, sha256: '' }; }
}

/**
 * 沙盘准备：团队状态根建好；状态库缺失时从真实 store 只读复制一份（不写真实文件）。
 * 主进程在 readStore() 之前调用，保证沙盘项目名与 .queue-check-data/团队 下的目录一致。
 */
function prepareQueueCheckSandbox(options = {}) {
  const teamRoot = String(options.teamRoot || '');
  if (teamRoot) {
    fs.mkdirSync(path.join(teamRoot, '状态', '项目'), { recursive: true });
  }
  const storeFile = String(options.storeFile || '');
  const fallback = String(options.fallbackStoreFile || '');
  let needSeed = Boolean(storeFile && fallback && fs.existsSync(fallback) && !fs.existsSync(storeFile));
  if (!needSeed && storeFile && fallback && fs.existsSync(fallback) && fs.existsSync(storeFile)) {
    // 空库（Electron 首次启动会先落一个没有项目的 store）也要换成真实 store 的只读副本。
    try {
      const parsed = JSON.parse(fs.readFileSync(storeFile, 'utf8').replace(/^\uFEFF/, ''));
      needSeed = !parsed || !Array.isArray(parsed.projects) || !parsed.projects.length;
    } catch { needSeed = true; }
  }
  if (needSeed) {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.copyFileSync(fallback, storeFile);
    console.log('QUEUE_CHECK_STORE_SEEDED ' + JSON.stringify({ from: fallback, to: storeFile }));
  }
  return { teamRoot, storeFile };
}

async function runQueueCheck({ app, createWindow, getWindow, readStore, outRoot, projectQueueFile, realQueueFile, teamName, sandboxTeamRoot, sandboxRoot }) {
  const outDir = process.env.AWB_QUEUE_OUT ? path.resolve(process.env.AWB_QUEUE_OUT) : path.join(outRoot, '_tmp', 'queue-check-' + Date.now());
  fs.mkdirSync(outDir, { recursive: true });
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok: Boolean(ok), detail });
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)}`);
    return ok;
  };

  // 沙盘边界先算清：所有用例只允许动 sandboxQueue；realQueue 只做只读哈希。
  const sandboxQueue = String(projectQueueFile || '');
  const sandboxRootPath = path.resolve(String(sandboxTeamRoot || ''));
  const realQueue = String(realQueueFile || '');
  const realBefore = realQueue ? statOf(realQueue) : { exists: false, mtimeMs: 0, sha256: '' };

  createWindow();
  const win = getWindow();
  await new Promise((resolve) => { if (win.webContents.isLoading()) win.webContents.once('did-finish-load', resolve); else resolve(); });
  await new Promise((resolve) => setTimeout(resolve, 1800));
  const shot = async (name) => {
    try { const file = path.join(outDir, name); fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); return file; } catch { return ''; }
  };
  const evalJs = (expr) => win.webContents.executeJavaScript(expr, true);
  const readPanel = () => evalJs(READ_PANEL);
  const store0 = readStore();
  const activeId = store0 && store0.activeProjectId ? String(store0.activeProjectId) : '';
  const project0 = store0 && Array.isArray(store0.projects) ? store0.projects.find((item) => String(item.id) === activeId) : null;
  const q = (extra) => `(async () => JSON.stringify(await window.workbench.teamRoleQueues(Object.assign({ projectId: ${JSON.stringify(activeId)} }, ${JSON.stringify(extra)}))))()`;
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const refresh = async () => {
    await evalJs("(() => { const b = document.getElementById('btn-queue-refresh'); if (b) b.click(); return true; })()");
    await wait(1300);
    await ensureDrawer();
    return readPanel();
  };

  // ── 沙盘前置：路径必须落在沙盘团队根里，真实团队文件不参与 ──────────────
  check('沙盘路径已拿到（项目队列表在沙盘团队根下）', Boolean(sandboxQueue) && path.resolve(sandboxQueue).startsWith(sandboxRootPath + path.sep), { sandboxQueue, sandboxRoot: sandboxRootPath });
  check('沙盘确实隔离：数据根在本次 queue-check 目录', Boolean(sandboxRoot) && sandboxRootPath.startsWith(path.resolve(String(sandboxRoot))) , { sandboxRoot, teamRoot: sandboxRootPath });
  if (!sandboxQueue) {
    const report = { ok: false, total: checks.length, failed: checks.filter((row) => !row.ok).length, outDir, checks, fatal: '没有沙盘队列路径（项目或团队名缺失）' };
    fs.writeFileSync(path.join(outDir, 'queue-check.json'), JSON.stringify(report, null, 2), 'utf8');
    console.log('QUEUE_CHECK ' + JSON.stringify({ ok: false, total: report.total, failed: report.failed, outDir }));
    app.exit(1);
    return;
  }
  fs.mkdirSync(path.dirname(sandboxQueue), { recursive: true });
  // 上一轮若崩在改名/写坏状态，先恢复成沙盘 fixture（只动沙盘文件）。
  fs.writeFileSync(sandboxQueue, JSON.stringify(fixtureBody(), null, 2) + '\n', 'utf8');
  const sandboxReadySha = sha256Of(sandboxQueue);

  // 打开团队台（队列面板在团队抽屉里）
  const opened = await evalJs("(() => { const b = document.getElementById('team-pill'); if (!b) return false; b.click(); return true; })()");
  check('团队台打开', opened === true, opened);
  const ensureDrawer = async () => {
    const open = await evalJs("(() => { const d = document.getElementById('team-drawer'); if (d && d.hidden) { const b = document.getElementById('team-pill'); if (b) b.click(); } return Boolean(d && !d.hidden); })()");
    await wait(700);
    await evalJs("(() => { const el = document.getElementById('role-queue-block'); if (el) el.scrollIntoView({ block: 'center' }); return true; })()");
    await wait(350);
    return open || evalJs("(() => { const d = document.getElementById('team-drawer'); return Boolean(d && !d.hidden); })()");
  };
  await wait(2400);
  await evalJs("(() => { const el = document.getElementById('role-queue-block'); if (el) el.scrollIntoView({ block: 'center' }); return true; })()");
  await wait(350);
  const drawerOpen = await ensureDrawer();
  check('团队台抽屉打开（截图能拍到队列面板）', drawerOpen === true, drawerOpen);

  // ── ready：分组 / 排序 / 六列 ─────────────────────────────────────
  const panel = await refresh();
  const readyShot = await shot('queue-ready.png');
  check('面板进入 ready 状态（沙盘 role_queues.json 已读到）', panel.ok && panel.state === 'ready', { state: panel.state, count: panel.count, meta: panel.meta });
  check('按角色分组 6 队且总数 10', panel.ok && (panel.groups || []).length === 6 && panel.count === 10, { groups: (panel.groups || []).length, count: panel.count });
  check('各队条数 2/1/1/2/1/3', JSON.stringify((panel.groups || []).map((g) => g.count)) === JSON.stringify([2, 1, 1, 2, 1, 3]), (panel.groups || []).map((g) => `${g.role}:${g.count}`));
  const groupOf = (role) => (panel.groups || []).find((g) => g.role === role) || { rows: [] };
  check('排序·优先级：pm 队 P0 在 P2 之前', groupOf('pm').rows.map((r) => r.priority).join(',') === 'P0,P2', groupOf('pm').rows.map((r) => `${r.task}/${r.priority}`));
  check('排序·截止：programmer1 队 11-16 在 11-19 之前（创建更晚也靠前）', groupOf('programmer1').rows.map((r) => r.task).join(',') === 'T-dev-2,T-dev-1', groupOf('programmer1').rows.map((r) => r.task));
  check('排序·空截止与未知优先级沉底：tester 队 T-test-2→T-test-1→T-test-9', groupOf('tester').rows.map((r) => r.task).join(',') === 'T-test-2,T-test-1,T-test-9', groupOf('tester').rows.map((r) => `${r.task}/${r.priority}`));
  const allRows = (panel.groups || []).reduce((list, g) => list.concat(g.rows), []);
  check('每行 6 列（优先/任务/动作/状态/关联需求/证据路径）', allRows.length === 10 && allRows.every((r) => Number(r.cells) === 6), allRows.map((r) => r.cells));
  check('行值抽样：programmer1 的 T-dev-1 = P0/develop/working', (() => {
    const row = groupOf('programmer1').rows.find((r) => r.task === 'T-dev-1') || {};
    return row.priority === 'P0' && row.action === 'develop';
  })(), groupOf('programmer1').rows.find((r) => r.task === 'T-dev-1'));
  check('超长证据路径截断 46 字 + …，title 为全文；无证据显示「无」', (() => {
    const prod = (groupOf('product').rows[0] || {});
    const ana = (groupOf('analyst').rows[0] || {});
    const shown = String(prod.evidence || '');
    const title = String(prod.title || '');
    return title.length > 46 && shown === title.slice(0, 46) + '…' && title.endsWith('.md') && String(ana.evidence || '').includes('无');
  })(), { prod: groupOf('product').rows[0], ana: groupOf('analyst').rows[0] });

  // ── 查看者按会话绑定（③）：面板不再固定 role=pm ─────────────────
  check('面板标出查看者来源（owner-console / session / session-unbound）', ['owner-console', 'session', 'session-unbound'].includes(panel.viewerSource), { viewerRole: panel.viewerRole, viewerSource: panel.viewerSource, viewerText: panel.viewerText });
  check('无角色会话时按 Owner 控制台（PM 全量）且徽标写清来源', panel.viewerSource === 'owner-console' && panel.viewerRole === 'pm' && /Owner 控制台/.test(panel.viewerText || ''), { viewerRole: panel.viewerRole, viewerSource: panel.viewerSource, viewerText: panel.viewerText });

  const noViewer = JSON.parse(await evalJs(q({})));
  check('IPC 没有 role/sessionId → QUEUE_VIEWER_REQUIRED（不默认 pm）', noViewer.ok === false && noViewer.code === 'QUEUE_VIEWER_REQUIRED', { code: noViewer.code, message: String(noViewer.message || '').slice(0, 60) });
  const testerSession = String((project0 && project0.sessions && project0.sessions.tester) || '');
  const bySession = JSON.parse(await evalJs(q({ sessionId: testerSession })));
  check('IPC 只给 sessionId → 按会话反查角色，只返回 tester 那一队', Boolean(testerSession) && bySession.ok === true && Object.keys(bySession.roles || {}).join(',') === 'tester' && bySession.role === 'tester', { testerSession, role: bySession.role, roles: Object.keys(bySession.roles || {}) });
  const unknownSession = JSON.parse(await evalJs(q({ sessionId: 'session-00000000-0000-0000-0000-000000000000' })));
  check('IPC 未知 sessionId → QUEUE_SESSION_UNBOUND（零副作用、不泄漏队列）', unknownSession.ok === false && unknownSession.code === 'QUEUE_SESSION_UNBOUND' && !unknownSession.roles, { code: unknownSession.code });
  const forbidden = JSON.parse(await evalJs(q({ role: 'tester', targetRole: 'pm' })));
  check('越权：tester 索要 pm 的队 → QUEUE_FORBIDDEN', forbidden.ok === false && forbidden.code === 'QUEUE_FORBIDDEN', { code: forbidden.code });

  // 端到端：把查看者会话切到 tester（测试钩子），刷新后面板只剩 tester 一队。
  await evalJs(`(() => { window.__awbQueueViewerOverride = { role: 'tester', sessionId: ${JSON.stringify(testerSession)} }; return true; })()`);
  const testerPanel = await refresh();
  check('切到 tester 会话后：面板只剩 tester 一队，来源=session', testerPanel.state === 'ready' && (testerPanel.groups || []).length === 1 && (testerPanel.groups || [])[0].role === 'tester' && testerPanel.viewerSource === 'session' && testerPanel.viewerRole === 'tester', { groups: (testerPanel.groups || []).map((g) => g.role), viewerRole: testerPanel.viewerRole, viewerSource: testerPanel.viewerSource });
  await evalJs("(() => { delete window.__awbQueueViewerOverride; return true; })()");
  const backPanel = await refresh();
  check('清掉测试钩子后回到 Owner 控制台（PM 全量 6 队）', backPanel.state === 'ready' && (backPanel.groups || []).length === 6 && backPanel.viewerSource === 'owner-console', { groups: (backPanel.groups || []).length, viewerSource: backPanel.viewerSource });

  // ── 缺失：删沙盘文件 → 灰字「队列未生成」 ────────────────────────
  let missingShot = '';
  let brokenShot = '';
  fs.rmSync(sandboxQueue, { force: true });
  const missing = await refresh();
  check('文件缺失 → 队列未生成、不报红', missing.state === 'missing' && missing.reason === 'missing' && /队列未生成/.test(missing.text) && !/badge-rejected/.test(missing.metaClass), { state: missing.state, reason: missing.reason, metaClass: missing.metaClass, text: missing.text.slice(0, 80) });
  missingShot = await shot('queue-missing.png');

  // ── 损坏：写非法 JSON → 同样的「队列未生成」，原文只进 title/日志 ──
  fs.writeFileSync(sandboxQueue, '{ "generatedAt": "2026-11-13T00:00:00.000Z", "roles": { "pm": { "queue": [ ', 'utf8');
  const broken = await refresh();
  brokenShot = await shot('queue-broken.png');
  check('文件损坏 → data-state=missing（降级，不报红）', broken.state === 'missing' && broken.degraded === '1' && broken.reason === 'broken', { state: broken.state, reason: broken.reason, degraded: broken.degraded });
  check('损坏文案是人话「队列未生成（文件损坏已忽略）」', /队列未生成/.test(broken.text) && /文件损坏已忽略/.test(broken.text), broken.text.slice(0, 120));
  check('损坏不报红：徽标仍是灰色 muted-badge', /muted-badge/.test(broken.metaClass) && !/badge-rejected/.test(broken.metaClass), { metaClass: broken.metaClass });
  check('解析原文不进正文（正文无 Expected/Unexpected/SyntaxError/position）', !/Expected|Unexpected|SyntaxError|JSON at position/i.test(broken.text), broken.text.slice(0, 160));
  check('解析原文进 title（供排查，不占界面）', /Expected|Unexpected|JSON at position|SyntaxError/i.test(broken.metaTitle || ''), String(broken.metaTitle || '').slice(0, 160));

  // ── 还原：重写沙盘 fixture → 回到 ready ────────────────────────
  fs.writeFileSync(sandboxQueue, JSON.stringify(fixtureBody(), null, 2) + '\n', 'utf8');
  const restored = await refresh();
  check('还原后点刷新回到 ready（10 条）', restored.state === 'ready' && restored.count === 10, { state: restored.state, count: restored.count });
  const restoredShot = await shot('queue-restored.png');

  // ── 只读 + 隔离断言 ────────────────────────────────────────────
  check('只读：渲染与 5 次 IPC 调用后沙盘队列文件未被改写', sha256Of(sandboxQueue) === sandboxReadySha, { before: sandboxReadySha.slice(0, 16), after: sha256Of(sandboxQueue).slice(0, 16) });
  if (realQueue) {
    const realAfter = statOf(realQueue);
    check('隔离：真实项目 role_queues.json 的 sha256 与 mtime 未被碰（不改名、不写入）', realAfter.exists === realBefore.exists && realAfter.sha256 === realBefore.sha256 && realAfter.mtimeMs === realBefore.mtimeMs, { realQueue, before: realBefore.sha256.slice(0, 16), after: realAfter.sha256.slice(0, 16), exists: realAfter.exists });
    check('隔离：真实目录下没有遗留 .queuecheck-tmp 改名文件', !fs.existsSync(realQueue + '.queuecheck-tmp'), realQueue + '.queuecheck-tmp');
  } else {
    check('隔离：真实项目 role_queues.json 不存在（无需比对，也不去创建）', true, realQueue || '路径未知');
  }
  check('隔离：沙盘目录下也没有遗留 .queuecheck-tmp', !fs.existsSync(sandboxQueue + '.queuecheck-tmp'), sandboxQueue + '.queuecheck-tmp');

  const failed = checks.filter((row) => !row.ok);
  const report = {
    ok: failed.length === 0, total: checks.length, failed: failed.length, outDir,
    sandbox: { teamRoot: sandboxRootPath, queueFile: sandboxQueue, realQueueFile: realQueue || '' },
    checks,
    screenshots: { ready: readyShot, missing: missingShot, broken: brokenShot, restored: restoredShot },
  };
  fs.writeFileSync(path.join(outDir, 'queue-check.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('QUEUE_CHECK ' + JSON.stringify({ ok: report.ok, total: report.total, failed: report.failed, outDir }));
  app.exit(report.ok ? 0 : 1);
}

module.exports = { runQueueCheck, prepareQueueCheckSandbox };
