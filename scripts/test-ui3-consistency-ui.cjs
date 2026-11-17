#!/usr/bin/env node
'use strict';
/**
 * B-20261116-094215-2ff6 / B-20261116-095320-410e / B-20261116-100905-1211 真窗口断言（CDP）
 *
 * 覆盖只有真窗口才能验的部分：
 *   ① 评审弹窗「全部需求」：口径数字 data-owner-all-total（= 工作流需求行）、兜底行 data-owner-all-fallback 单列、
 *      「产品评审中」档真的渲染出来（[data-owner-all-group="product_review"] 含 review+RR空 的行），
 *      已通过（approved+decisions 有效）的行不在「等你决定」组（data-or-bucket != pending）；
 *   ② 需求/缺陷池：#pool-foot[data-pool-req] 与评审同数、data-pool-unaccepted 单独计数，
 *      done 且无验收记录的缺陷行显示「已完成·未验收」且 data-bucket=unaccepted；
 *   ③ 流程面板：data-flow-total 与评审/池同数、data-flow-refreshed-at 有值、data-flow-stale=0（刚刷新），
 *      terminated 行的行内状态**不是**「可派单」。
 *
 * 隔离：AWB_DATA_DIR + TEAM_ROOT + TEAM_PROJECTS_ROOT + TEAM_WORKBENCH_JSON 全指 _tmp/ui3-consistency-ui/sb-<pid>；
 *       真实 data/userdata/workbench.json、团队状态、工作流.json 只读，跑完比对 sha256+mtime 未变。
 * 跑法：node scripts/test-ui3-consistency-ui.cjs（退出码 0=全绿；窗口起不来会明确报 FAIL 并 kill 进程）
 */

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PNAME = '工作台改造修复';
const BASE = path.join(ROOT, '_tmp', 'ui3-consistency-ui');
const RUN = `sb-${process.pid}`;
const SB = path.join(BASE, RUN);
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const PROJECT = path.join(SB, 'project', PNAME);
const STATE = path.join(TEAM, '状态', '项目', PNAME);
const STORE = path.join(DATA, 'userdata', 'workbench.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const REAL_TEAM_JSON = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_WF = path.join(ROOT, '团队', '状态', '项目', PNAME, '工作流.json');
const PORT = Number(process.env.AWB_UI3_UI_PORT || (9461 + (process.pid % 30)));
const EVID = process.env.AWB_UI3_UI_OUT ? path.resolve(process.env.AWB_UI3_UI_OUT) : path.join(ROOT, '项目', PNAME, '程序员A', '产出', '证据-ui3');

// 夹具行（工作流里应有 8 行 registered + 1 行快照兜底；缺陷 2 条：已验收 1、未验收 1）
const R_PRODUCT = 'R-20261117-080001-p001'; // review + requirementReview 空 → 产品评审中
const R_WAIT = 'R-20261117-080002-w001';    // approved 未决定 → 等你决定
const R_DECIDED = 'R-20261117-080003-d001';  // approved + 有效决定 → 进行中（不回退 B-dfe6 / 2ff6①）
const R_READY = 'R-20261117-080004-r001';    // ready → 可派单
const R_TERM = 'R-20261117-080005-t001';     // terminated → 已终止，不得可派单
const R_DEV = 'R-20261117-080006-v001';      // dev → 进行中
const R_TEST = 'R-20261117-080007-e001';     // test_done 无决定 → 待验收
const R_ACC = 'R-20261117-080008-a001';      // accepted → 已收口
const R_GHOST = 'R-20261117-080009-g001';    // 只有任务镜像、工作流没有 → 快照兜底行
const B_DONE_NOACC = 'B-20261117-080101-f001'; // done 且无 acceptanceRecord → 已完成·未验收
const B_DONE_ACC = 'B-20261117-080102-f002';   // done 且有 accepted 记录 → 已验收

const results = [];
const log = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + JSON.stringify(detail).slice(0, 500)}`;
  log.push(line);
  console.log(line);
  if (!ok) process.exitCode = 1;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
function sha(file) { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return null; } }
function statOf(file) { try { const st = fs.statSync(file); return { sha: sha(file), mtimeMs: st.mtimeMs }; } catch { return null; } }
function copyFile(src, dst) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
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
    await sleep(300);
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
  async evaluate(expression, ms = 30000) {
    try {
      const out = await this.send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true, userGesture: true }, ms);
      if (out && out.exceptionDetails) return { __exception: String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || out.exceptionDetails.text).slice(0, 400) };
      return out && out.result ? out.result.value : undefined;
    } catch (e) { return { __cdperror: String((e && e.message) || e) }; }
  }
}

function seed() {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  // 团队名册（清空 sessionId，防止任何唤醒；TEAM_SELFTEST=1 双保险）
  const team = JSON.parse(fs.readFileSync(REAL_TEAM_JSON, 'utf8').replace(/^\uFEFF/, ''));
  for (const member of team.members || []) member.sessionId = '';
  team.activeProject = PNAME;
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  fs.mkdirSync(STATE, { recursive: true });
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.writeFileSync(path.join(STATE, '项目.json'), JSON.stringify({ name: PNAME, path: PROJECT, index: '项目索引.md', teamMode: 'full' }, null, 2) + '\n', 'utf8');
  // 项目必读文档（面板读取用；正文用最小占位，不复制真实正文）
  for (const name of ['项目信息.md', '项目铁律.md', '项目索引.md', '协作准则.md']) {
    fs.writeFileSync(path.join(PROJECT, name), `# ${name}（ui3 沙盘）\n\n只用于真窗口自检，不是项目真实内容。\n`, 'utf8');
  }
  fs.mkdirSync(path.join(PROJECT, '需求'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT, '需求', '00-需求总览.md'), '# 需求总览（ui3 沙盘）\n', 'utf8');
  const HASH = 'e'.repeat(64);
  const row = (id, status, extra) => ({ id, title: `夹具 ${status} 需求`, status, round: 1, queued: false, priority: 'P1', ...(extra || {}) });
  const wf = {
    schema: 2, project: PNAME, round: 1, phase: 'owner_review', updatedAt: new Date().toISOString(),
    requirements: {
      [R_PRODUCT]: row(R_PRODUCT, 'review', { requirementReview: null, ownerReview: { status: 'pending' }, decisions: [] }),
      [R_WAIT]: row(R_WAIT, 'approved', { requirementReview: { verdict: 'approve', requirementHash: HASH }, ownerReview: { status: 'pending' }, decisions: [] }),
      [R_DECIDED]: row(R_DECIDED, 'approved', {
        requirementHash: HASH,
        requirementReview: { verdict: 'approve', requirementHash: HASH },
        ownerReview: { status: 'approved', at: '2026-11-17T00:00:00.000Z', channel: 'ui', actor: 'owner' },
        decisions: [{ status: 'approved', decision: 'approved', at: '2026-11-17T00:00:00.000Z', channel: 'ui', actor: 'owner', basis: { requirement: { sha256: HASH } } }]
      }),
      [R_READY]: row(R_READY, 'ready', {}),
      [R_TERM]: row(R_TERM, 'terminated', { voided: false, closedAt: '2026-11-17T00:00:00.000Z' }),
      [R_DEV]: row(R_DEV, 'dev', {}),
      [R_TEST]: row(R_TEST, 'test_done', {}),
      [R_ACC]: row(R_ACC, 'accepted', { closedAt: '2026-11-17T00:00:00.000Z' })
    },
    events: []
  };
  fs.writeFileSync(path.join(STATE, '工作流.json'), JSON.stringify(wf, null, 2) + '\n', 'utf8');
  fs.mkdirSync(path.join(STATE, '任务'), { recursive: true });
  const task = (id, type, status, extra) => ({ id, project: PNAME, type, title: `夹具 ${id}`, status, priority: 'P1', createdAt: '2026-11-17T00:00:00.000Z', updatedAt: '2026-11-17T00:00:00.000Z', history: [], ...(extra || {}) });
  fs.writeFileSync(path.join(STATE, '任务', `${R_GHOST}.json`), JSON.stringify(task(R_GHOST, 'requirement', 'open', { requirementId: '', workflow: { round: 1 } }), null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(STATE, '任务', `${B_DONE_NOACC}.json`), JSON.stringify(task(B_DONE_NOACC, 'bug', 'done', { acceptanceRecord: null }), null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(STATE, '任务', `${B_DONE_ACC}.json`), JSON.stringify(task(B_DONE_ACC, 'bug', 'done', {
    acceptanceRecord: { status: 'accepted', by: 'pm', channel: 'pm', at: '2026-11-17T00:00:00.000Z', evidence: [], testReport: '' }
  }), null, 2) + '\n', 'utf8');
  // 壳层 store：只留本项目；path 指沙盘项目目录；mirror/requirements/tasks 清空（防旧镜像被当真相）
  const store = JSON.parse(fs.readFileSync(REAL_STORE, 'utf8').replace(/^\uFEFF/, ''));
  const project = (store.projects || []).find((item) => item && String(item.teamName || item.name || '') === PNAME) || (store.projects || [])[0];
  if (!project) throw new Error('真实 workbench.json 里没有项目 ' + PNAME);
  project.name = PNAME;
  project.teamName = PNAME;
  project.path = PROJECT;
  project.tasks = [];
  project.requirements = [];
  project.workflowMirror = null;
  store.projects = [project];
  store.activeProjectId = project.id;
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n', 'utf8');
  return {
    registered: Object.keys(wf.requirements).length,
    fallback: 1,
    unaccepted: 1
  };
}

function env() {
  return {
    ...process.env,
    AWB_DATA_DIR: DATA,
    TEAM_ROOT: TEAM,
    TEAM_PROJECTS_ROOT: path.join(TEAM, '状态', '项目'),
    TEAM_WORKBENCH_JSON: STORE,
    TEAM_SELFTEST: '1'
  };
}
async function launch(port) {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + port], {
    cwd: ROOT, env: env(), stdio: 'ignore', windowsHide: false
  });
  const target = await waitTarget(port, 90000, (x) => x && x.type === 'page' && String(x.url || '').includes('renderer/index.html'));
  if (!target) { try { child.kill(); } catch { /* ignore */ } return null; }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws 失败')), { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  for (let i = 0; i < 200; i += 1) {
    const ready = await cdp.evaluate('document.readyState');
    if (ready === 'complete') break;
    await sleep(300);
  }
  return { child, cdp };
}

(async () => {
  const beforeReal = { store: statOf(REAL_STORE), team: statOf(REAL_TEAM_JSON), wf: statOf(REAL_WF) };
  const fixture = seed();
  const app = await launch(PORT);
  check('UI-01 隔离实例已启动（renderer/index.html 可连）', Boolean(app && app.cdp), { port: PORT });
  if (!app) {
    console.log('\nUI3 真窗口断言：窗口没起来，后续跳过（隔离根已清理前的现场在 ' + SB + '）');
    fs.writeFileSync(path.join(BASE, 'ui3-ui-fail.log'), log.join('\n'), 'utf8');
    return;
  }
  const { child, cdp } = app;
  try {
    await sleep(2500); // 等首屏 workflow:state / workflow:next 回来
    // ① 评审弹窗
    await cdp.evaluate("(function(){ const b=document.querySelector('[data-owner-review-entry]')||document.querySelector('#owner-review-entry'); if(b){b.click();return 'clicked';} return 'missing'; })()");
    await sleep(1600);
    const dialog = await cdp.evaluate("(function(){ const d=document.querySelector('[data-owner-review-dialog]'); return d ? (d.hidden ? 'hidden' : 'open') : 'missing'; })()");
    check('UI-02 评审弹窗可打开（真实入口点击）', dialog === 'open', dialog);
    const review = await cdp.evaluate(`(function(){
      const box = document.querySelector('[data-owner-all]');
      if(!box) return { missing:true };
      const rowOf = (id) => document.querySelector('[data-owner-all-item][data-or-req="'+id+'"]');
      const badgeOf = (id) => { const row=rowOf(id); const b=row?row.querySelector('[data-or-status-badge]'):null; return b?b.textContent:null; };
      const groupOfReq = (id) => { const row=rowOf(id); if(!row) return null; const g=row.closest('[data-owner-all-group]'); return g?g.getAttribute('data-owner-all-group'):null; };
      return JSON.stringify({
        total: box.getAttribute('data-owner-all-total'),
        fallback: box.getAttribute('data-owner-all-fallback'),
        rows: box.getAttribute('data-owner-all-rows'),
        groups: [...box.querySelectorAll('[data-owner-all-group]')].map((g) => g.getAttribute('data-owner-all-group')),
        productGroupHasRow: Boolean(document.querySelector('[data-owner-all-group="product_review"] [data-or-req="${R_PRODUCT}"]')),
        productBucket: (rowOf('${R_PRODUCT}')||{getAttribute:()=>null}).getAttribute('data-or-bucket'),
        waitBucket: (rowOf('${R_WAIT}')||{getAttribute:()=>null}).getAttribute('data-or-bucket'),
        decidedBucket: (rowOf('${R_DECIDED}')||{getAttribute:()=>null}).getAttribute('data-or-bucket'),
        decidedBadge: badgeOf('${R_DECIDED}'),
        productBadge: badgeOf('${R_PRODUCT}'),
        ghostBucket: (rowOf('${R_GHOST}')||{getAttribute:()=>null}).getAttribute('data-or-bucket'),
        buckets: [...box.querySelectorAll('[data-owner-all-item]')].map((n) => n.getAttribute('data-or-bucket'))
      });
    })()`);
    const rv = typeof review === 'string' ? JSON.parse(review) : (review || {});
    check('UI-03 评审弹窗口径数字 = 工作流需求行数（兜底行单列、不计入）',
      Number(rv.total) === fixture.registered && Number(rv.fallback) === fixture.fallback, { total: rv.total, fallback: rv.fallback, registered: fixture.registered });
    check('UI-04 评审弹窗「产品评审中」档存在且 review+RR空 的行落在该档',
      rv.productGroupHasRow === true && rv.productBucket === 'product_review', { productBucket: rv.productBucket, productGroupHasRow: rv.productGroupHasRow });
    check('UI-05 已通过（approved+有效决定）的行不在「等你决定」，落在进行中且徽标「已通过」',
      rv.decidedBucket === 'running' && /已通过/.test(String(rv.decidedBadge || '')), { decidedBucket: rv.decidedBucket, badge: rv.decidedBadge });
    check('UI-06 未决定 approved 的行仍在「等你决定」（口径不变）', rv.waitBucket === 'pending', rv.waitBucket);
    check('UI-07 产品评审中的行徽标写「产品评审中」，不再显示「等你决定」',
      /产品评审中/.test(String(rv.productBadge || '')) && !/等你决定/.test(String(rv.productBadge || '')), rv.productBadge);
    await cdp.evaluate("(function(){ const c=document.querySelector('[data-or-close]'); if(c) c.click(); return true; })()");
    await sleep(600);

    // ② 需求/缺陷池
    await cdp.evaluate("(function(){ const b=document.querySelector('#btn-pool'); if(b) b.click(); return Boolean(b); })()");
    await sleep(1800);
    const pool = await cdp.evaluate(`(function(){
      const foot = document.querySelector('#pool-foot');
      const row = document.querySelector('.pool-row[data-id="${B_DONE_NOACC}"]');
      const acc = document.querySelector('.pool-row[data-id="${B_DONE_ACC}"]');
      const chip = [...document.querySelectorAll('#pool-filters .pool-chip')].find((b) => b.getAttribute('data-filter') === 'accepted');
      const termRow = document.querySelector('.pool-row[data-id="${R_TERM}"]');
      return JSON.stringify({
        maskOpen: (()=>{ const m=document.querySelector('#pool-mask'); return m && !m.hidden; })(),
        foot: foot ? { req: foot.getAttribute('data-pool-req'), fallback: foot.getAttribute('data-pool-fallback'), unaccepted: foot.getAttribute('data-pool-unaccepted'), accepted: foot.getAttribute('data-pool-accepted'), text: foot.textContent.slice(0, 200) } : null,
        doneRow: row ? { bucket: row.getAttribute('data-bucket'), text: row.textContent.slice(0, 80) } : null,
        accRow: acc ? { bucket: acc.getAttribute('data-bucket'), text: acc.textContent.slice(0, 80) } : null,
        acceptedChip: chip ? chip.textContent : null,
        termRow: termRow ? termRow.textContent.slice(0, 80) : null
      });
    })()`);
    const pl = typeof pool === 'string' ? JSON.parse(pool) : (pool || {});
    check('UI-08 池面板可打开（真实入口 #btn-pool）', pl.maskOpen === true, pl);
    check('UI-09 池需求条数 = 评审界面 = 工作流需求行数', Boolean(pl.foot) && Number(pl.foot.req) === fixture.registered,
      { req: pl.foot && pl.foot.req, registered: fixture.registered, fallback: pl.foot && pl.foot.fallback });
    check('UI-10 done 且无验收记录的缺陷显示「已完成·未验收」且桶=unaccepted（不是已验收）',
      Boolean(pl.doneRow) && pl.doneRow.bucket === 'unaccepted' && /已完成·未验收/.test(String(pl.doneRow.text)) && !/已验收/.test(String(pl.doneRow.text)),
      pl.doneRow);
    check('UI-11 有 accepted 记录的缺陷仍显示「已验收」且桶=accepted（不误伤）',
      Boolean(pl.accRow) && pl.accRow.bucket === 'accepted' && /已验收/.test(String(pl.accRow.text)), pl.accRow);
    check('UI-12 池单独计数「已完成未验收 N」（N=1，不进已验收筛选）',
      Boolean(pl.foot) && Number(pl.foot.unaccepted) === fixture.unaccepted && Number(pl.foot.accepted) === 1
      && /已完成未验收 1/.test(String(pl.foot.text)), pl.foot && { unaccepted: pl.foot.unaccepted, accepted: pl.foot.accepted, text: pl.foot.text });
    check('UI-13 已终止需求在池里显示「已终止」（不再糊成待评审）',
      /已终止/.test(String(pl.termRow || '')), pl.termRow);
    await cdp.evaluate("(function(){ const b=document.querySelector('#pool-close'); if(b) b.click(); return true; })()");
    await sleep(600);

    // ③ 流程面板（浮窗真实入口 #flow-launcher）
    await cdp.evaluate("(function(){ const b=document.querySelector('#flow-launcher'); if(b) b.click(); return Boolean(b); })()");
    await sleep(2500);
    // 已收口区默认折叠：展开后再读 terminated 行（行只在展开时进 DOM，这是既有交互）。
    await cdp.evaluate("(function(){ const f=document.querySelector('#flow-mini [data-fold]'); if(f) f.click(); return Boolean(f); })()");
    await sleep(1200);
    const flow = await cdp.evaluate(`(function(){
      const mini = document.querySelector('#flow-mini');
      const rowOf = (id) => document.querySelector('#flow-mini [data-id="'+id+'"]');
      const statusOf = (id) => { const r=rowOf(id); if(!r) return null; const s=r.querySelector('.fv4-st'); return s?s.textContent:null; };
      return JSON.stringify({
        panelOpen: (()=>{ const p=document.querySelector('#flow-panel'); return p && !p.hidden; })(),
        attrs: mini ? {
          total: mini.getAttribute('data-flow-total'), open: mini.getAttribute('data-flow-open'),
          closed: mini.getAttribute('data-flow-closed'), fallback: mini.getAttribute('data-flow-fallback'),
          refreshedAt: mini.getAttribute('data-flow-refreshed-at'), stale: mini.getAttribute('data-flow-stale')
        } : null,
        head: (()=>{ const m=document.querySelector('#flow-mini-meta'); return m ? m.textContent.slice(-160) : null; })(),
        termStatus: statusOf('${R_TERM}'),
        readyStatus: statusOf('${R_READY}'),
        termText: rowOf('${R_TERM}') ? rowOf('${R_TERM}').textContent.slice(0, 120) : null
      });
    })()`);
    const fw = typeof flow === 'string' ? JSON.parse(flow) : (flow || {});
    check('UI-14 流程浮窗可打开（真实入口 #flow-launcher）', fw.panelOpen === true, fw.panelOpen);
    check('UI-15 流程面板条数 = 评审/池 = 工作流需求行数（兜底行单列）',
      Boolean(fw.attrs) && Number(fw.attrs.total) === fixture.registered && Number(fw.attrs.fallback) === fixture.fallback,
      fw.attrs);
    check('UI-16 流程面板带 refreshedAt 且刚刷新不标过期（data-flow-stale=0）',
      Boolean(fw.attrs) && Boolean(fw.attrs.refreshedAt) && fw.attrs.stale === '0'
      && /数据刷新于/.test(String(fw.head || '')), fw.attrs);
    check('UI-17 已终止行显示「已终止」，**不是**「可派单」',
      fw.termStatus === '已终止' && !/可派单/.test(String(fw.termText || '')) && !/可派单/.test(String(fw.termStatus || '')),
      { termStatus: fw.termStatus, termText: fw.termText });
    check('UI-18 ready 行仍显示「可派单」（不误伤正常行）', fw.readyStatus === '可派单', fw.readyStatus);
  } finally {
    try { cdp.ws.close(); } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
    await sleep(800);
  }

  // 隔离取证：真实 store / 团队.json / 工作流.json 无本脚本写入
  // 注：真实 workbench.json 会被「正在运行的其它实例」持续写（5 秒心跳会镜像工作流），
  // 所以对它只断言「沙盘 store 确实落在隔离根、真实 store 没被指向沙盘」这两件本脚本可控的事，
  // 不把外部写当成自己的回归（并发工作区里断言全仓文件不变永远不可能 PASS）。
  const afterReal = { store: statOf(REAL_STORE), team: statOf(REAL_TEAM_JSON), wf: statOf(REAL_WF) };
  const sandboxStoreText = (() => { try { return fs.readFileSync(STORE, 'utf8'); } catch { return ''; } })();
  const realStoreText = (() => { try { return fs.readFileSync(REAL_STORE, 'utf8'); } catch { return ''; } })();
  check('UI-19 隔离：实例写的是沙盘 store（含沙盘路径），真实 workbench.json 不含沙盘路径',
    sandboxStoreText.includes(PROJECT.replace(/\\/g, '\\\\')) || sandboxStoreText.includes(PROJECT)
    || sandboxStoreText.includes('ui3-consistency-ui'),
    { realChanged: beforeReal.store && afterReal.store && beforeReal.store.sha !== afterReal.store.sha });
  check('UI-19b 隔离：真实 workbench.json 未被本脚本指向沙盘项目路径',
    !realStoreText.includes('ui3-consistency-ui') && !realStoreText.includes(path.join(SB, 'project')),
    { note: beforeReal.store && afterReal.store && beforeReal.store.sha !== afterReal.store.sha ? '真实 store 被外部实例写过（允许）' : '' });
  check('UI-20 隔离：真实 团队.json sha256+mtime 未变',
    beforeReal.team && afterReal.team && beforeReal.team.sha === afterReal.team.sha && beforeReal.team.mtimeMs === afterReal.team.mtimeMs, {});
  check('UI-21 隔离：真实 工作流.json sha256+mtime 未变',
    beforeReal.wf && afterReal.wf && beforeReal.wf.sha === afterReal.wf.sha && beforeReal.wf.mtimeMs === afterReal.wf.mtimeMs, {});

  console.log(`\nUI3 真窗口断言：${results.filter((r) => r.ok).length}/${results.length} PASS`);
  try {
    fs.mkdirSync(EVID, { recursive: true });
    fs.writeFileSync(path.join(EVID, `ui3-ui-run-${RUN}.json`), JSON.stringify({ at: new Date().toISOString(), port: PORT, fixture, results }, null, 2), 'utf8');
    fs.writeFileSync(path.join(EVID, `ui3-ui-run-${RUN}.log`), log.join('\n'), 'utf8');
  } catch { /* 证据写不出来不影响退出码 */ }
  if (results.some((r) => !r.ok)) process.exitCode = 1;
})();
