#!/usr/bin/env node
'use strict';
/**
 * test-82e2-owner-decide-ui.cjs —— B-20261120-230446-82e2（P1）真窗口断面
 *
 * 沙盘里造一条「待 Owner 决定」的需求 → 真窗口点 #owner-review-entry → 选中该需求 → 点「通过」
 *  → 断言：①决定已落账（workflow decisions +1）；②界面文案是「已通过/已生效」，不是「现在还不能提交」；
 *         ③通知 PM 失败时文案带 code；④截图存证。
 *
 * 若沙盘环境下弹窗列表入口不可用，则退化为**同一 IPC**（window.workbench.ownerDecide）调用，
 * 并如实记录 mode=ipc（不冒充点过按钮）。
 *
 * 用法：node scripts/test-82e2-owner-decide-ui.cjs [--json] [--out <dir>]
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PNAME = '工作台改造修复';
const REQ = 'R-20261120-230446-82e2';
const SB = path.join(ROOT, '_tmp', `82e2-ui-${process.pid}-${Date.now()}`);
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const PROJ_DIR = path.join(SB, '项目区', PNAME);
const STORE = path.join(DATA, 'userdata', 'workbench.json');
const STATE = path.join(TEAM, '状态', '项目', PNAME);
const REAL_TEAM_JSON = path.join(ROOT, '团队', '状态', '团队.json');
const PORT = Number(process.env.AWB_7F3A_PORT || (9750 + (process.pid % 30)));
const JSON_OUT = process.argv.includes('--json');
const OUT = (() => { const i = process.argv.indexOf('--out'); return i >= 0 ? path.resolve(process.argv[i + 1]) : ''; })();
const ROWS = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 800)}`);
}
function httpJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null));
    req.setTimeout(4000, () => { req.destroy(); resolve(null); });
  });
}
async function waitTarget(port, ms, pick) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const list = await httpJson(`http://127.0.0.1:${port}/json/list`);
    if (Array.isArray(list)) { const hit = list.find(pick); if (hit && hit.webSocketDebuggerUrl) return hit; }
    await sleep(400);
  }
  return null;
}
class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m.id && this.pending.has(m.id)) { const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) reject(new Error(m.error.message)); else resolve(m.result); }
    });
  }
  send(method, params = {}, ms = 40000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时 ' + method)); } }, ms);
    });
  }
  async evaluate(expr, ms = 40000) {
    try {
      const out = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }, ms);
      if (out && out.exceptionDetails) return { __exception: String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || '') };
      return out && out.result ? out.result.value : undefined;
    } catch (e) { return { __cdperror: String((e && e.message) || e) }; }
  }
}
function workflow() { return JSON.parse(fs.readFileSync(path.join(STATE, '工作流.json'), 'utf8')); }
function decisionsCount() { try { const row = workflow().requirements[REQ]; return Array.isArray(row && row.decisions) ? row.decisions.length : -1; } catch { return -1; } }
function seed() {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.mkdirSync(STATE, { recursive: true });
  fs.mkdirSync(PROJ_DIR, { recursive: true });
  try { fs.symlinkSync(path.join(ROOT, '团队', '工具'), path.join(TEAM, '工具'), 'junction'); } catch { /* ignore */ }
  for (const name of ['团队宪法.md', '项目铁律.md']) { try { fs.copyFileSync(path.join(ROOT, '团队', name), path.join(TEAM, name)); } catch { /* ignore */ } }
  const team = JSON.parse(fs.readFileSync(REAL_TEAM_JSON, 'utf8').replace(/^\uFEFF/, ''));
  team.activeProject = PNAME;
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2));
  fs.writeFileSync(path.join(STATE, '项目.json'), JSON.stringify({ name: PNAME, path: PROJ_DIR, teamMode: 'full' }, null, 2));
  fs.writeFileSync(path.join(STATE, '工作流.json'), JSON.stringify({
    schema: 2, project: PNAME, phase: 'requirement_review', round: 1, events: [],
    requirements: {
      [REQ]: {
        id: REQ, title: '82e2 真窗口夹具需求（点一次通过）', status: 'review', round: 1, decisions: [], ownerReview: null,
        priority: 'P1', doc: '', acceptance: 'AC1', story: '', updatedAt: new Date().toISOString(),
      },
    },
    ownerReview: {},
  }, null, 2));
  fs.writeFileSync(STORE, JSON.stringify({
    version: 1, activeProjectId: 'P-82e2',
    projects: [{
      id: 'P-82e2', name: PNAME, teamName: PNAME, path: PROJ_DIR, teamMode: 'full',
      workspace: { id: 'W-82e2', path: PROJ_DIR, name: PNAME, bound: true, sessionIds: [] },
      sessions: {}, requirements: [], sessionMeta: {},
    }],
    ui: {},
  }, null, 2));
}
async function launch() {
  const env = {
    ...process.env,
    AWB_DATA_DIR: DATA, AWB_STORE: STORE, AWB_TEAM_ROOT: TEAM, TEAM_ROOT: TEAM,
    TEAM_PROJECTS_ROOT: path.join(SB, '项目区'), TEAM_SELFTEST: '1',
    DSH_WEB_URL: 'http://127.0.0.1:1', AWB_DSH_BASE_URL: 'http://127.0.0.1:1',
  };
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], { cwd: ROOT, env, stdio: 'ignore', windowsHide: false });
  const target = await waitTarget(PORT, 90000, (item) => item && item.type === 'page' && String(item.url || '').includes('renderer/index.html'));
  if (!target) { try { child.kill(); } catch { /* ignore */ } return null; }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', () => reject(new Error('ws 连接失败')), { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  for (let i = 0; i < 150; i += 1) {
    const ready = await cdp.evaluate('document.readyState === "complete" && Boolean(document.getElementById("btn-more"))');
    if (ready === true) break;
    await sleep(400);
  }
  return { child, cdp, ws };
}
async function close(inst) {
  if (!inst) return;
  try { inst.cdp.send('Browser.close', {}, 3000).catch(() => {}); } catch { /* ignore */ }
  await sleep(900);
  try { inst.ws.close(); } catch { /* ignore */ }
  try { inst.child.kill(); } catch { /* ignore */ }
  try { spawn('taskkill', ['/PID', String(inst.child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
}

async function main() {
  let inst = null;
  const evidence = { at: new Date().toISOString(), requirementId: REQ };
  const before = (() => { seed(); return decisionsCount(); })();
  try {
    inst = await launch();
    if (!inst) throw new Error('实例未启动（CDP 未就绪）');
    await sleep(2500);
    // 1) 打开评审弹窗：优先点入口（真用户路径），失败则如实退化为同一 IPC。
    const forceIpc = String(process.env.AWB_7F3A_MODE || '') === 'ipc';
    const open = forceIpc ? 'forced-ipc' : await inst.cdp.evaluate(`(async () => {
      const entry = document.getElementById('owner-review-entry');
      if (!entry) return 'no-entry';
      entry.click();
      await new Promise((r) => setTimeout(r, 600));
      const card = document.querySelector('[data-or-req]');
      return card ? 'entry-ok' : 'entry-empty';
    })()`);
    let mode = 'ui';
    let noticeText = '';
    let bannerText = '';
    let ipcResult = null;
    if (open === 'entry-ok') {
      const clicked = await inst.cdp.evaluate(`(async () => {
        const card = document.querySelector('[data-or-req]');
        if (card) card.click();
        await new Promise((r) => setTimeout(r, 400));
        const approve = document.querySelector('[data-or-approve]');
        if (!approve) return { error: 'no-approve' };
        approve.click();
        const started = Date.now();
        while (Date.now() - started < 20000) {
          const notice = document.querySelector('[data-or-notice]');
          const banner = document.querySelector('[data-or-banner], [data-or-error]');
          const nt = notice ? String(notice.textContent || '') : '';
          const bt = banner && !banner.hidden ? String(banner.textContent || '') : '';
          if (nt || bt) return { notice: nt, banner: bt };
          await new Promise((r) => setTimeout(r, 300));
        }
        return { notice: '', banner: '' };
      })()`, 40000) || {};
      noticeText = String(clicked.notice || '');
      bannerText = String(clicked.banner || '');
      if (clicked.error) mode = 'ipc';
    } else {
      mode = 'ipc';
    }
    if (mode === 'ipc') {
      // 退化路径：调同一 IPC（owner:decide），不冒充点过按钮。
      ipcResult = await inst.cdp.evaluate(`(async () => {
        const st = await window.workbench.state();
        const p = (st.projects || [])[0] || null;
        try {
          const r = await window.workbench.ownerDecide({ projectId: p && p.id, requirementId: ${JSON.stringify(REQ)}, status: 'approved', opinion: '真窗口夹具：点通过', channel: 'ui' });
          return { ok: r && r.ok, decided: r && r.decided, notify: r && r.ownerDecisionNotify, notifyFailed: r && r.notifyFailed };
        } catch (e) { return { threw: String(e && e.message || e) }; }
      })()`, 40000);
    }
    if (OUT) {
      fs.mkdirSync(OUT, { recursive: true });
      const shot = await inst.cdp.send('Page.captureScreenshot', { format: 'png' }, 20000).catch(() => null);
      if (shot && shot.data) fs.writeFileSync(path.join(OUT, `82e2-owner-decide-${mode}.png`), Buffer.from(shot.data, 'base64'));
      fs.writeFileSync(path.join(OUT, '82e2-owner-decide-ui.json'), JSON.stringify({ ...evidence, mode, before, after: decisionsCount(), noticeText, bannerText, ipcResult, open }, null, 2) + '\n');
    }
    const after = decisionsCount();
    check('① 决定已落账：workflow decisions 净 +1（' + before + ' → ' + after + '）', after === before + 1, { before, after, mode });
    if (mode === 'ui') {
      const text = noticeText + '\n' + bannerText;
      check('② 界面文案是「已通过/已生效」，不是「现在还不能提交」',
        /已通过|已生效/.test(text) && !/现在还不能提交/.test(text), { noticeText, bannerText });
      check('③ 通知失败时文案带 code；通知成功时不得出现「现在还不能提交」',
        (/通知 PM 失败 code=/.test(text) || /错误码/.test(text)) || (!/通知 PM 失败/.test(text)),
        { text });
      const auditFile = path.join(STATE, 'owner决定通知.jsonl');
      let auditRows = 0;
      try { auditRows = fs.readFileSync(auditFile, 'utf8').split(/\r?\n/).filter(Boolean).length; } catch { auditRows = 0; }
      check('③b 通知 PM 的真实结果：审计行数 ' + auditRows + '，文案与之相符（成功则无失败后缀）',
        (auditRows > 0 && !/通知 PM 失败/.test(text)) || (auditRows === 0 && /通知 PM 失败 code=/.test(text)), { auditRows, text });
    } else {
      check('② 界面入口不可用 → 同 IPC 返回 ok+decided（如实记录 mode=ipc）',
        Boolean(ipcResult && ipcResult.ok === true && ipcResult.decided === true) && !ipcResult.threw, ipcResult);
      check('③ 同 IPC 的通知失败码可见（ownerDecisionNotify.ok=false + code）',
        Boolean(ipcResult && ipcResult.notify && ipcResult.notify.ok === false && ipcResult.notify.code), ipcResult && ipcResult.notify);
    }
  } catch (e) {
    check('断面未抛异常', false, { error: String((e && e.stack) || e) });
  } finally {
    await close(inst);
    try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const failed = ROWS.filter((r) => !r.ok).length;
  if (JSON_OUT) console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed, failed: ROWS.filter((r) => !r.ok).map((r) => r.name), rows: ROWS }, null, 2));
  else console.log(`\n${ROWS.length - failed}/${ROWS.length} PASS${failed ? ' · ' + failed + ' FAIL' : ''}`);
  process.exit(failed ? 1 : 0);
}
main().catch((e) => { console.error('FIXTURE_FAILED', String((e && e.stack) || e)); process.exit(1); });
