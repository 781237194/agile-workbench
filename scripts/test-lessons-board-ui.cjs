'use strict';
/**
 * R-51de（T-20261115-174027-410c）经验教训看板 · 真实窗口断言：
 *   ① 侧栏入口存在、可见、点开浮层（B-0538：不在标题栏）；
 *   ② 六页签 data-lesson-tab 六个值各 1；默认一个 aria-selected=true；
 *   ③ 每段 data-lesson-count = 本次打开时点 md 实测条数（不写死）、data-lesson-updated-at = 最后一条日期；
 *   ④ 最新最多 10 条 = 文件行序最后 10 个数据行（倒序），首条文本与 md 对应行一致；
 *      另：data-lesson-shown/total/truncated 与段头「已展示 N / 共 M（另有 K 条）」、容器可滚动（B-0d59）；
 *   ⑤ 点首条 → data-lesson-detail 含完整四列（逐字相等）；无 editor/save/textarea；
 *   ⑥ 临时改名 md → data-lessons-error="MISSING"（不显示 0 条当正常）；恢复后重新打开正常。
 *
 * 隔离：AWB_DATA_DIR + TEAM_ROOT + TEAM_PROJECTS_ROOT + TEAM_WORKBENCH_JSON 全指 _tmp/lessons-ui；端口 9434。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = '工作台改造修复';
const BASE = path.join(ROOT, '_tmp', 'lessons-ui');
const DATA = path.join(BASE, 'data');
const TEAM = path.join(BASE, '团队');
const FIXTURE = path.join(BASE, '项目', PROJECT);
const MD = path.join(FIXTURE, '经验教训登记册.md');
const PORT = Number(process.env.AWB_LESSONS_UI_PORT || 9434);
const EVID = path.join(ROOT, '项目', PROJECT, '程序员B', '产出', '证据-410c');
const ROLES = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
const TITLES = { 项目经理: 'pm', 产品: 'product', 需求分析师: 'analyst', 程序员A: 'programmer1', 程序员B: 'programmer2', 测试: 'tester' };

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? '' : detail });
  // detail 可能是 undefined（如 dom.count 取不到），JSON.stringify(undefined) 返回 undefined → 直接 .slice 会抛，断言脚本自己崩掉。
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail ?? null) ?? 'null').slice(0, 300)}`);
  if (!ok) process.exitCode = 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name); const d = path.join(dst, ent.name);
    if (filter && filter(s, ent)) continue;
    if (ent.isDirectory()) copyDir(s, d, filter);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
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
  send(method, params = {}, ms = 30000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时 ' + method)); } }, ms);
    });
  }
  async evaluate(expr, ms = 30000) {
    try {
      const out = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }, ms);
      if (out && out.exceptionDetails) return { __exception: String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || out.exceptionDetails.text).slice(0, 400) };
      return out && out.result ? out.result.value : undefined;
    } catch (e) { return { __cdperror: String((e && e.message) || e) }; }
  }
}

/** 与 lessons.mjs 同口径的简易解析（测试独立复算，不 import 生产实现）。 */
function parseMd() {
  const text = fs.readFileSync(MD, 'utf8');
  const lines = text.split(/\r?\n/);
  const out = {};
  let role = '';
  for (const line of lines) {
    const h = /^##\s+(.+?)\s*$/.exec(line);
    if (h) { role = TITLES[h[1].trim()] || ''; if (role && !out[role]) out[role] = { rows: [] }; continue; }
    if (!role) continue;
    if (!/^\|\s*2026-/.test(line)) continue;
    const cells = line.split('|').map((c) => c.trim()).slice(1, -1);
    if (cells.length < 4) continue;
    out[role].rows.push({ date: cells[0], scene: cells[1], lesson: cells[2], next: cells[3] });
  }
  for (const r of ROLES) if (!out[r]) out[r] = { rows: [] };
  return out;
}

function seed() {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  const store = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'userdata', 'workbench.json'), 'utf8'));
  const project = (store.projects || []).find((p) => p && String(p.teamName || p.name || '') === PROJECT);
  if (!project) throw new Error('真实 workbench.json 里没有 ' + PROJECT);
  fs.mkdirSync(FIXTURE, { recursive: true });
  fs.copyFileSync(path.join(ROOT, '项目', PROJECT, '经验教训登记册.md'), MD);
  fs.mkdirSync(path.join(FIXTURE, '测试人员', '产出'), { recursive: true });
  store.projects = [{ ...project, path: FIXTURE }];
  store.activeProjectId = store.projects[0].id;
  fs.writeFileSync(path.join(DATA, 'userdata', 'workbench.json'), JSON.stringify(store, null, 2) + '\n', 'utf8');
  copyDir(path.join(ROOT, '团队'), TEAM, (f) => /[\\/]锁([\\/]|$)/.test(f) || /[\\/]邮箱[\\/]/.test(f));
  const teamFile = path.join(TEAM, '状态', '团队.json');
  const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
  for (const m of team.members || []) m.sessionId = '';
  team.activeProject = PROJECT;
  fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');
}
function env() {
  return { ...process.env, AWB_DATA_DIR: DATA, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: path.join(TEAM, '状态', '项目'), TEAM_WORKBENCH_JSON: path.join(DATA, 'userdata', 'workbench.json'), TEAM_SELFTEST: '1' };
}
async function launch(port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + port], { cwd: ROOT, env: env(), stdio: 'ignore', windowsHide: false });
  const target = await waitTarget(port, 60000, (x) => x && x.type === 'page' && String(x.url || '').includes('renderer/index.html'));
  if (!target) { try { child.kill(); } catch { /* */ } return null; }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws 失败')), { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable'); await cdp.send('Page.enable');
  for (let i = 0; i < 150; i += 1) { if (await cdp.evaluate('document.readyState') === 'complete') break; await sleep(400); }
  return { child, cdp };
}

(async () => {
  seed();
  const md = parseMd();
  const app = await launch(PORT);
  check('隔离实例已启动（renderer 可连）', Boolean(app && app.cdp), { port: PORT });
  if (!app) return;
  const { child, cdp } = app;
  try {
    const entry = await cdp.evaluate(`(function(){
      const e=document.getElementById('lessons-entry');
      if(!e) return {missing:true};
      const r=e.getBoundingClientRect();
      const foot=document.querySelector('.sidebar-foot');
      return {inSidebar: Boolean(foot&&foot.contains(e)), inTitlebar: Boolean(document.querySelector('#titlebar')&&document.querySelector('#titlebar').contains(e)), visible: r.width>0&&r.height>0};
    })()`);
    check('① 入口在侧栏底部且可见（不在标题栏）', Boolean(entry && entry.inSidebar && entry.visible && !entry.inTitlebar), entry);

    await cdp.evaluate("(function(){ const e=document.getElementById('lessons-entry'); if(e) e.click(); return true; })()");
    await sleep(1500);
    const shell = await cdp.evaluate(`(function(){
      const d=document.getElementById('lessons-dialog');
      if(!d) return {missing:true};
      return { opened: !d.hidden, tabs: [...d.querySelectorAll('[data-lesson-tab]')].map(x=>x.getAttribute('data-lesson-tab')),
        selected: [...d.querySelectorAll('[data-lesson-tab][aria-selected="true"]')].map(x=>x.getAttribute('data-lesson-tab')),
        editors: d.querySelectorAll('[data-lessons-editor],#lessons-save,textarea').length,
        error: d.querySelector('[data-lessons-error]') ? d.querySelector('[data-lessons-error]').getAttribute('data-lessons-error') : '' };
    })()`);
    check('① 点开浮层', Boolean(shell && shell.opened), shell);
    check('② 六页签各 1', Boolean(shell && shell.tabs.length === 6 && ROLES.every((r) => shell.tabs.filter((x) => x === r).length === 1)), shell && shell.tabs);
    check('② 默认恰好一个 aria-selected', Boolean(shell && shell.selected.length === 1 && ROLES.includes(shell.selected[0])), shell && shell.selected);
    check('⑤ 浮层内无编辑框/保存控件', Boolean(shell && shell.editors === 0), shell && shell.editors);
    check('⑥ 正常文件不显示错误条', Boolean(shell && !shell.error), shell && shell.error);

    for (const role of ROLES) {
      const rows = md[role].rows;
      const dom = await cdp.evaluate(`(function(){
        const d=document.getElementById('lessons-dialog');
        const sec=d.querySelector('[data-lesson-section="${role}"]');
        if(!sec) return {missing:true};
        const count=sec.querySelector('[data-lesson-count="${role}"]');
        const updated=sec.querySelector('[data-lesson-updated-at="${role}"]');
        const items=[...sec.querySelectorAll('[data-lesson-item="${role}"]')].map(it=>({title: it.querySelector('.lessons-item-title') ? it.querySelector('.lessons-item-title').textContent : '', date: it.getAttribute('data-lesson-date'), open: it.getAttribute('data-lesson-expanded')}));
        const trunc=sec.querySelector('.lessons-trunc');
        return { count: count?count.textContent.replace(/[^0-9]/g,''):'', updated: updated?updated.textContent:'', items,
          shown: sec.getAttribute('data-lesson-shown'), total: sec.getAttribute('data-lesson-total'), truncated: sec.getAttribute('data-lesson-truncated'),
          more: trunc?trunc.getAttribute('data-lesson-more'):'', truncText: trunc?trunc.textContent:'' };
      })()`);
      check(`③ [${role}] 条数=md 实测 ${rows.length}`, Boolean(dom && String(dom.count) === String(rows.length)), dom && dom.count);
      check(`③ [${role}] 最近更新=最后一条日期`, Boolean(dom && String(dom.updated || '').includes(rows.length ? rows[rows.length - 1].date : '')), dom && dom.updated);
      const expectLatest = rows.slice(-10).reverse();
      check(`④ [${role}] 最新条目数 = min(10,${rows.length})`, Boolean(dom && dom.items.length === Math.min(10, rows.length)), dom && dom.items.length);
      // B-0d59：三锚点 + 段头提示（禁止静默截断）
      const expectShown = Math.min(10, rows.length);
      const expectTruncated = rows.length > expectShown ? '1' : '0';
      check(`④ [${role}] data-lesson-shown=${expectShown}`, Boolean(dom && String(dom.shown) === String(expectShown)), dom && dom.shown);
      check(`④ [${role}] data-lesson-total=${rows.length}`, Boolean(dom && String(dom.total) === String(rows.length)), dom && dom.total);
      check(`④ [${role}] data-lesson-truncated=${expectTruncated}`, Boolean(dom && String(dom.truncated) === expectTruncated), dom && dom.truncated);
      check(`④ [${role}] 段头提示「另有 K 条」K=${rows.length - expectShown}`, Boolean(dom && String(dom.more) === String(rows.length - expectShown) && (expectTruncated === '1' ? /另有 \d+ 条/.test(dom.truncText || '') : /已展示 \d+ \/ 共 \d+/.test(dom.truncText || ''))), dom && { more: dom.more, text: dom.truncText });
      if (expectTruncated === '1') {
        // B-0d59：容器必须可纵向滚动。分两步验，避免「10 条短行恰好装得下」造成假红：
        //   a) 静态能力：.lessons-body 的 overflow-y ∈ {auto, scroll}；
        //   b) 运行时可滚：把该段条目全部展开（内容自然溢出）后 scrollHeight > clientHeight。
        const scroll = await cdp.evaluate(`(function(){
          const b=document.querySelector('#lessons-dialog .lessons-body') || document.querySelector('.lessons-body');
          if(!b) return {missing:true};
          const oy=(getComputedStyle(b).overflowY||'').toLowerCase();
          const sec=document.querySelector('[data-lesson-section="${role}"]');
          const items=sec?[...sec.querySelectorAll('[data-lesson-item="${role}"]')]:[];
          for(const it of items) it.click();          // 全部展开 → 内容溢出
          const sh=b.scrollHeight, ch=b.clientHeight;
          for(const it of items) it.click();          // 还原为收起态，避免影响后续「点首条」用例
          return {oy, scrollHeight:sh, clientHeight:ch, expandedItems:items.length, overflowOk: oy==='auto'||oy==='scroll', scrollable: sh>ch};
        })()`);
        check(`④ [${role}] 截断段容器 overflow-y 可滚（auto/scroll）`, Boolean(scroll && scroll.overflowOk), scroll);
        check(`④ [${role}] 展开后内容溢出可滚动（scrollHeight>clientHeight）`, Boolean(scroll && scroll.scrollable), scroll);
      }
      if (expectLatest.length) {
        check(`④ [${role}] 首条=文件最后一行（行序倒序）`, Boolean(dom && dom.items[0] && dom.items[0].date === expectLatest[0].date && dom.items[0].title.includes(expectLatest[0].scene.slice(0, 20))), dom && dom.items[0]);
        const detail = await cdp.evaluate(`(function(){
          const sec=document.querySelector('[data-lesson-section="${role}"]');
          const item=sec.querySelector('[data-lesson-item="${role}"]');
          item.click();
          const d=item.querySelector('[data-lesson-detail]');
          return {hidden: d.hidden, text: d.textContent};
        })()`);
        const expect = `日期：${expectLatest[0].date}\n场景：${expectLatest[0].scene}\n教训：${expectLatest[0].lesson}\n下次怎么做：${expectLatest[0].next}`;
        check(`④ [${role}] 点首条展开完整四列（逐字相等）`, Boolean(detail && !detail.hidden && detail.text === expect), { got: detail && detail.text && detail.text.slice(0, 120), expect: expect.slice(0, 120) });
      }
    }

    // ⑥ 缺失：临时改名 → 关掉重开 → 错误条 MISSING，且不显示 0 条当正常
    fs.renameSync(MD, MD + '.bak');
    try {
      await cdp.evaluate("(function(){ const c=document.querySelector('[data-lessons-close]'); if(c) c.click(); const e=document.getElementById('lessons-entry'); if(e) e.click(); return true; })()");
      await sleep(3500);
      const miss = await cdp.evaluate(`(function(){
        const d=document.getElementById('lessons-dialog');
        const err=d.querySelector('[data-lessons-error]');
        return {error: err?err.getAttribute('data-lessons-error'):'', text: err?err.textContent:'', meta: d.querySelector('[data-lessons-meta]') ? d.querySelector('[data-lessons-meta]').textContent : '', phase: window.__lessonsPhase || '', loading: Boolean(window.__lessonsLoading), sections: d.querySelectorAll('[data-lesson-section]').length, hidden: d.hidden};
      })()`);
      check('⑥ 文件缺失 → data-lessons-error=MISSING 且给路径', Boolean(miss && miss.error === 'MISSING' && /经验教训登记册/.test(miss.text || '')), miss);
    } finally {
      fs.renameSync(MD + '.bak', MD);
    }
    await cdp.evaluate("(function(){ const c=document.querySelector('[data-lessons-close]'); if(c) c.click(); const e=document.getElementById('lessons-entry'); if(e) e.click(); return true; })()");
    await sleep(3500);
    const restored = await cdp.evaluate(`(function(){
      const d=document.getElementById('lessons-dialog');
      const err=d.querySelector('[data-lessons-error]');
      const sec=d.querySelector('[data-lesson-section="pm"]');
      const count=sec?sec.querySelector('[data-lesson-count]'):null;
      return {error: err?err.getAttribute('data-lessons-error'):'', count: count?count.textContent.replace(/[^0-9]/g,''):''};
    })()`);
    check('⑥ 恢复原文件后错误条消失、计数回到实测值', Boolean(restored && !restored.error && restored.count === String(md.pm.rows.length)), restored);

    fs.mkdirSync(EVID, { recursive: true });
    fs.writeFileSync(path.join(EVID, 'run-410c.json'), JSON.stringify({ at: new Date().toISOString(), mdCounts: Object.fromEntries(ROLES.map((r) => [r, md[r].rows.length])), results }, null, 2) + '\n', 'utf8');
  } finally {
    try { await cdp.send('Browser.close', {}, 5000); } catch { /* */ }
    try { child.kill(); } catch { /* */ }
  }
  const pass = results.filter((r) => r.ok).length;
  console.log(`\nR-51de 看板断言：${pass}/${results.length} PASS`);
})().catch((e) => { console.error('RUN_FAILED', (e && e.stack) || e); process.exitCode = 1; });
