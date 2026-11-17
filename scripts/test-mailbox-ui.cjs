'use strict';
/**
 * R-c4c7（T-20261115-195024-5369）· 团队收件箱实时面板「真实窗口」自检
 *
 * 隔离：AWB_DATA_DIR + TEAM_ROOT + TEAM_PROJECTS_ROOT + TEAM_WORKBENCH_JSON 全指 _tmp/mailbox-ui；端口 9471。
 * 断言：入口在侧栏、面板可开、标题/口径文案、六行数字、无「排队消息」字样、无只读按钮（data-mailbox-action 0 命中）、
 *       首屏只读一次快照、外部写一封邮件 → 面板数字 +1 且推送事件来源=watch。
 */
const fs = require('node:fs');
const path = require('node:path');
const { rmSandbox, uniqueSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A/B
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = '工作台改造修复';
const BASE = uniqueSandbox('mailbox-ui'); // B-07b6 B：唯一沙盘（并发安全）
const DATA = path.join(BASE, 'data');
const TEAM = path.join(BASE, '团队');
const STATE = path.join(TEAM, '状态', '项目', PROJECT);
const PORT = Number(process.env.AWB_MAILBOX_UI_PORT || 9471);
const EVID = path.join(ROOT, '项目', PROJECT, '程序员B', '产出', '证据-c4c7-ui');
const ROLE_IDS = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];

const results = [];
function check(name, okValue, detail) {
  results.push({ name, ok: Boolean(okValue), detail });
  console.log(`${okValue ? 'PASS' : 'FAIL'}  ${name}${okValue ? '' : ' · ' + JSON.stringify(detail).slice(0, 400)}`);
  if (!okValue) process.exitCode = 1;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, entry.name);
    const d = path.join(dst, entry.name);
    if (filter && filter(s, entry)) continue;
    if (entry.isDirectory()) copyDir(s, d, filter);
    else if (entry.isFile()) fs.copyFileSync(s, d);
  }
}
function httpJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { let body = ''; res.on('data', (c) => { body += c; }); res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null));
    req.setTimeout(4000, () => { req.destroy(); resolve(null); });
  });
}
async function waitTarget(port, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const list = await httpJson(`http://127.0.0.1:${port}/json/list`);
    if (Array.isArray(list)) {
      const hit = list.find((p) => p && p.type === 'page' && String(p.url || '').includes('renderer/index.html'));
      if (hit && hit.webSocketDebuggerUrl) return hit;
    }
    await sleep(400);
  }
  return null;
}
class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (event) => {
      let msg = null;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (!msg || !msg.id || !this.pending.has(msg.id)) return;
      const { resolve, reject } = this.pending.get(msg.id);
      this.pending.delete(msg.id);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result);
    });
  }
  send(method, params = {}) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try { this.ws.send(JSON.stringify({ id, method, params })); } catch (error) { reject(error); }
    });
  }
  async evaluate(expression) {
    const res = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });
    if (res && res.exceptionDetails) return { __error: String((res.exceptionDetails.text || '') + ' ' + (res.exceptionDetails.exception && res.exceptionDetails.exception.description || '')).slice(0, 300) };
    return res && res.result ? res.result.value : undefined;
  }
}

function seed() {
  fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  const realStore = path.join(ROOT, 'data', 'userdata', 'workbench.json');
  const store = JSON.parse(fs.readFileSync(realStore, 'utf8'));
  const project = (store.projects || []).find((p) => p && String(p.teamName || p.name || '') === PROJECT);
  if (!project) throw new Error('真实 workbench.json 里没有项目 ' + PROJECT);
  store.projects = [project];
  store.activeProjectId = project.id;
  fs.writeFileSync(path.join(DATA, 'userdata', 'workbench.json'), JSON.stringify(store, null, 2) + '\n', 'utf8');
  copyDir(path.join(ROOT, '团队'), TEAM, (f) => /[\\/]锁([\\/]|$)/.test(f) || /[\\/]邮箱[\\/]/.test(f));
  const teamFile = path.join(TEAM, '状态', '团队.json');
  const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
  for (const member of team.members || []) member.sessionId = '';
  team.activeProject = PROJECT;
  fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');
  // 邮箱沙盘：pm 3 封 / analyst 1 封 / tester 各目录留空；其余角色目录空
  for (const role of ROLE_IDS) {
    fs.mkdirSync(path.join(TEAM, '状态', '邮箱', role, 'new'), { recursive: true });
    fs.mkdirSync(path.join(TEAM, '状态', '邮箱', role, 'cur'), { recursive: true });
  }
  const put = (role, index, subject) => {
    const stamp = `2026-11-16T00-00-${String(index).padStart(2, '0')}-000Z`;
    fs.writeFileSync(path.join(TEAM, '状态', '邮箱', role, 'new', `${stamp}-m${index}.json`), JSON.stringify({ id: 'M-' + index, from: 'pm', to: role, subject, body: 'x', ts: `2026-11-16T00:00:${String(index).padStart(2, '0')}.000Z` }), 'utf8');
  };
  put('pm', 1, '沙盘邮件一'); put('pm', 2, '沙盘邮件二'); put('pm', 3, '沙盘邮件三'); put('analyst', 4, '沙盘邮件四');
  fs.mkdirSync(STATE, { recursive: true });
  fs.writeFileSync(path.join(STATE, 'role_queues.json'), JSON.stringify({
    generatedAt: '2026-11-16T00:00:00.000Z',
    roles: {
      analyst: { queue: [{ taskId: 'R-a', action: 'rework', priority: 'P1', status: 'pending', createdAt: '2026-11-16T00:00:01.000Z' }] },
      tester: { queue: [{ taskId: 'R-t', action: 'test', priority: 'P1', status: 'pending', createdAt: '2026-11-16T00:00:04.000Z' }] },
    },
  }, null, 2) + '\n', 'utf8');
  fs.mkdirSync(EVID, { recursive: true });
}

function env() {
  return { ...process.env, AWB_DATA_DIR: DATA, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: path.join(TEAM, '状态', '项目'), TEAM_WORKBENCH_JSON: path.join(DATA, 'userdata', 'workbench.json'), TEAM_SELFTEST: '1' };
}

async function launch(port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + port], { cwd: ROOT, env: env(), stdio: 'ignore', windowsHide: false });
  const target = await waitTarget(port, 90000);
  if (!target) { try { child.kill(); } catch { /* ignore */ } return null; }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', () => reject(new Error('ws 连接失败')), { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  for (let i = 0; i < 120; i += 1) {
    const ready = await cdp.evaluate('document.readyState');
    if (ready === 'complete') break;
    await sleep(400);
  }
  return { child, cdp };
}

(async () => {
  seed();
  const app = await launch(PORT);
  check('U0 隔离实例已启动（renderer/index.html 可连）', Boolean(app && app.cdp), { port: PORT });
  if (!app) return;
  const { child, cdp } = app;
  try {
    const entry = await cdp.evaluate(`(function(){
      const btn = document.querySelector('#btn-mailbox');
      if (!btn) return { missing: true };
      const inTitlebar = Boolean(btn.closest('#titlebar'));
      const inSidebar = Boolean(btn.closest('#sidebar, .sidebar, .sidebar-foot'));
      return { missing: false, inTitlebar, inSidebar, text: btn.textContent };
    })()`);
    check('U1 入口 #btn-mailbox 存在且在侧栏、不在标题栏（B-0538）', entry && !entry.missing && entry.inSidebar && !entry.inTitlebar, entry);
    check('U2 入口文案是「收件箱」（不是「排队消息」）', Boolean(entry && /收件箱/.test(entry.text || '') && !/排队消息/.test(entry.text || '')), entry && entry.text);

    await cdp.evaluate("(function(){ const b=document.querySelector('#btn-mailbox'); if(b) b.click(); return true; })()");
    await sleep(1500);
    const panel = await cdp.evaluate(`(function(){
      const p = document.querySelector('#mailbox-panel');
      if (!p) return { missing: true };
      const text = p.textContent || '';
      return {
        missing: false,
        visible: !p.hidden,
        title: (p.querySelector('[data-mailbox-title]') || {}).textContent || '',
        scope: (p.querySelector('[data-mailbox-scope]') || {}).textContent || '',
        total: (p.querySelector('[data-mailbox-total]') || {}).textContent || '',
        busiest: (p.querySelector('[data-mailbox-busiest]') || {}).textContent || '',
        rows: p.querySelectorAll('[data-mailbox-row]').length,
        pmMail: (p.querySelector('[data-mailbox-row][data-role="pm"] [data-mailbox-mail-count]') || {}).textContent || '',
        analystQueue: (p.querySelector('[data-mailbox-row][data-role="analyst"] [data-mailbox-queue-count]') || {}).textContent || '',
        actions: p.querySelectorAll('[data-mailbox-action]').length,
        hasBanned: /排队消息/.test(text) + '/' + /待办队列/.test(text),
        degradedHidden: Boolean((p.querySelector('[data-mailbox-degraded]') || {}).hidden),
        probe: window.__mailboxProbe ? window.__mailboxProbe() : null,
      };
    })()`);
    check('U3 点入口后面板打开', Boolean(panel && panel.visible), panel);
    check('U4 标题=「团队收件箱」（不含「排队消息」）', Boolean(panel && /团队收件箱/.test(panel.title) && !/排队消息/.test(panel.title)), panel && panel.title);
    check('U5 口径行含「不含 DSH 运行时队列」', Boolean(panel && /不含 DSH 运行时队列/.test(panel.scope)), panel && panel.scope);
    check('U6 六角色六行', Boolean(panel && panel.rows === 6), panel && panel.rows);
    check('U7 总数 = 邮件 4 + 队列 2 = 6', Boolean(panel && String(panel.total).trim() === '6'), panel && panel.total);
    check('U8 pm 邮件数=3、analyst 队列=1', Boolean(panel && String(panel.pmMail).trim() === '3' && String(panel.analystQueue).trim() === '1'), panel);
    check('U9 面板文本无「排队消息」「待办队列」', Boolean(panel && panel.hasBanned === 'false/false'), panel && panel.hasBanned);
    check('U10 面板内没有任何操作按钮（data-mailbox-action 0 命中，只读）', Boolean(panel && panel.actions === 0), panel && panel.actions);
    check('U11 首屏只读一次快照（snapshotReads=1）', Boolean(panel && panel.probe && panel.probe.snapshotReads === 1), panel && panel.probe);
    check('U12 无降级（watch 正常）', Boolean(panel && panel.degradedHidden === true && panel.probe && panel.probe.degraded === false), panel && panel.probe && { degraded: panel.probe.degraded, hidden: panel.degradedHidden });

    // 实时：外部写一封邮件 → 面板数字 +1 且事件来源=watch
    const stamp = '2026-11-16T09-59-01-000Z';
    fs.writeFileSync(path.join(TEAM, '状态', '邮箱', 'programmer2', 'new', `${stamp}-live1.json`), JSON.stringify({ id: 'M-live1', from: 'pm', to: 'programmer2', subject: '实时写入测试', ts: '2026-11-16T09:59:01.000Z' }), 'utf8');
    await sleep(1800);
    const after = await cdp.evaluate(`(function(){
      const p = document.querySelector('#mailbox-panel');
      const probe = window.__mailboxProbe ? window.__mailboxProbe() : null;
      return {
        total: (p.querySelector('[data-mailbox-total]') || {}).textContent || '',
        pm2: (p.querySelector('[data-mailbox-row][data-role="programmer2"] [data-mailbox-mail-count]') || {}).textContent || '',
        probe,
      };
    })()`);
    check('U13 外部写 1 封 → 面板数字 +1（7）', Boolean(after && String(after.total).trim() === '7' && String(after.pm2).trim() === '1'), after);
    check('U14 推送事件来源=watch、changedEvents≥1（真实时，不是轮询）', Boolean(after && after.probe && after.probe.changedEvents >= 1 && after.probe.lastSource === 'watch'), after && after.probe);
    check('U15 期间快照读取没有随事件增长（snapshotReads 仍=1）', Boolean(after && after.probe && after.probe.snapshotReads === 1), after && after.probe);

    // 截图
    try {
      const shot = await cdp.send('Page.captureScreenshot', { format: 'png' });
      fs.writeFileSync(path.join(EVID, '01-收件箱面板.png'), Buffer.from(shot.data, 'base64'));
      check('U16 截图已落盘', fs.existsSync(path.join(EVID, '01-收件箱面板.png')), {});
    } catch (error) {
      check('U16 截图已落盘', false, String((error && error.message) || error).slice(0, 200));
    }
  } catch (error) {
    check('执行过程无异常', false, String((error && error.message) || error).slice(0, 300));
  } finally {
    try { child.kill(); } catch { /* ignore */ }
    await sleep(800);
  }
  const pass = results.filter((r) => r.ok).length;
  const fail = results.length - pass;
  console.log(`\nR-c4c7 真窗口断言：${pass} 通过 / ${fail} 失败`);
  fs.writeFileSync(path.join(EVID, 'run-c4c7-ui.log'), `pass=${pass} fail=${fail} exit=${process.exitCode || 0}\n` + results.map((r) => `${r.ok ? 'PASS' : 'FAIL'} ${r.name}`).join('\n') + '\n', 'utf8');
  process.exit(process.exitCode || 0);
})();
