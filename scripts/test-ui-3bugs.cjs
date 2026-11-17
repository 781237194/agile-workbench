'use strict';
/**
 * 三个界面 BUG 真实窗口断言（2026-11-16）：
 *  B-20261116-061155-dfe6：R-9f3e 数据层 approved+decisions → 界面不得再显示「等你决定」
 *  B-20261116-061156-6155：工作流没有的 R-253b（task-only 行）→ 弹窗当场标「未登记·不可评审」且禁用
 *  B-20261116-061156-60ae：决策箱 4 条 open 全缺七要素 → 列表空但必须给三数说明行（total/shown/hidden）
 *
 * 隔离：AWB_DATA_DIR + TEAM_ROOT + TEAM_PROJECTS_ROOT + TEAM_WORKBENCH_JSON 全指 _tmp/ui3bugs；端口 9433。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const { uniqueSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 B2：唯一沙盘

const ROOT = path.resolve(__dirname, '..');
const PROJECT = '工作台改造修复';
const BASE = uniqueSandbox('ui3bugs');
const DATA = path.join(BASE, 'data');
const TEAM = path.join(BASE, '团队');
const STATE_DIR = path.join(TEAM, '状态', '项目', PROJECT);
const BOX_FILE = path.join(STATE_DIR, '决策箱.json');
const PORT = Number(process.env.AWB_UI3_PORT || 9433);
const EVID = path.join(ROOT, '项目', PROJECT, '程序员B', '产出', '证据-ui3bugs');
const REQ_OK = 'R-20261115-121640-9f3e';
// T-20261117-161410-593c：ghost 改用项目内不存在的假 id——原 253b 与真实 需求/作废登记.jsonl 撞号，
// 快照会按「作废优先」把它从 task-only 兜底里排除（=A a17d 正确行为），导致②恒红（夹具过时）。
const REQ_GHOST = 'R-20261116-999903-ghost';
// PM 2026-11-16 06:31：无门保护区两条夹具（造数据，不依赖真实库）——
// S7 真待决不能被静默隐藏；S8 approved 但 decisions=[] 走 ownerReview 回退口径。
const REQ_WAIT = 'R-20261116-999901-wait';
const REQ_NODEC = 'R-20261116-999902-nodec';

const results = [];
const log = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail });
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + JSON.stringify(detail).slice(0, 500)}`;
  log.push(line);
  console.log(line);
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

function seed() {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  const realStore = path.join(ROOT, 'data', 'userdata', 'workbench.json');
  const store = JSON.parse(fs.readFileSync(realStore, 'utf8'));
  const project = (store.projects || []).find((p) => p && String(p.teamName || p.name || '') === PROJECT);
  if (!project) throw new Error('真实 workbench.json 里没有项目 ' + PROJECT);
  store.projects = [project]; store.activeProjectId = project.id;
  // T-20261117-161410-593c：夹具项目路径指到沙盘内（原用真实项目路径 → 快照按真实 需求/ 目录扫出 90+ legacy-doc 行，
  // 还会命中真实 作废登记 → 未登记行被排除，②恒红；项目路径隔离后只剩本夹具的注册行 + 未登记兜底行）。
  const SANDBOX_PROJECT_PATH = path.join(BASE, '项目', PROJECT);
  fs.mkdirSync(path.join(SANDBOX_PROJECT_PATH, '需求'), { recursive: true });
  project.path = SANDBOX_PROJECT_PATH;
  project.workspacePath = SANDBOX_PROJECT_PATH;
  if (project.workspace && typeof project.workspace === 'object') project.workspace.path = SANDBOX_PROJECT_PATH;
  fs.writeFileSync(path.join(DATA, 'userdata', 'workbench.json'), JSON.stringify(store, null, 2) + '\n', 'utf8');
  copyDir(path.join(ROOT, '团队'), TEAM, (f) => /[\\/]锁([\\/]|$)/.test(f) || /[\\/]邮箱[\\/]/.test(f));
  const teamFile = path.join(TEAM, '状态', '团队.json');
  const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
  for (const m of team.members || []) m.sessionId = '';
  team.activeProject = PROJECT;
  fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');
  for (const sub of ['启动', '任务']) {
    const d = path.join(STATE_DIR, sub);
    if (fs.existsSync(d)) for (const f of fs.readdirSync(d)) if (f.endsWith('.json')) fs.rmSync(path.join(d, f), { force: true });
  }
  fs.mkdirSync(path.join(STATE_DIR, '任务'), { recursive: true });
  const nowIso = new Date().toISOString();
  // ① R-9f3e：数据层已通过（status=approved + ownerReview approved + decisions 1 条）
  const wf = {
    schema: 2, project: PROJECT, round: 1, phase: 'owner_review', updatedAt: nowIso,
    requirements: {
      [REQ_OK]: {
        id: REQ_OK, title: '取消提案 B 案', status: 'approved', createdAt: nowIso,
        // T-20261117-161410-593c：现行口径「决定必须绑当前正文版本」——旧夹具 decisions 无 basis 会被判「绑旧版→待重评→等你决定」，
        // 与 dfe6 原意（已通过不得落等你决定）冲突。这里补齐版本三元组（行 requirementHash 与 decision basis 一致），
        // 保持原断言口径不变、只修夹具数据。
        requirementHash: 'a'.repeat(64),
        ownerReview: { status: 'approved', at: '2026-11-15T04:55:08.986Z', channel: 'ui', actor: 'owner', decidedBy: 'owner', by: 'Owner' },
        decisions: [{ status: 'approved', at: '2026-11-15T04:55:08.986Z', channel: 'ui', actor: 'owner', by: 'Owner', basis: { requirement: { sha256: 'a'.repeat(64) } } }],
      },
      // S7：owner_review + ownerReview.status=pending + decisions=[] → 必须仍进「等你决定」（防「有 ownerReview 就 return running」的回归）。
      [REQ_WAIT]: {
        id: REQ_WAIT, title: '夹具：真待决（不能静默隐藏）', status: 'owner_review', createdAt: nowIso,
        ownerReview: { status: 'pending' },
        decisions: [],
      },
      // S8：ownerReview.status=approved 但 decisions=[] → decidedStatusOf 回退 ownerReview.status=approved → running。
      [REQ_NODEC]: {
        id: REQ_NODEC, title: '夹具：approved 无 decisions', status: 'approved', createdAt: nowIso,
        ownerReview: { status: 'approved', at: '2026-11-16T00:00:00.000Z' },
        decisions: [],
      },
    },
  };
  fs.writeFileSync(path.join(STATE_DIR, '工作流.json'), JSON.stringify(wf, null, 2) + '\n', 'utf8');
  // ② R-253b：只有任务镜像、工作流没有 → 快照里是 source=task-only 的幽灵行
  fs.writeFileSync(path.join(STATE_DIR, '任务', `${REQ_GHOST}.json`), JSON.stringify({
    id: REQ_GHOST, project: PROJECT, type: 'requirement', title: '经验教训登记册（旧版，已被 51de 取代）',
    status: 'open', priority: 'P2', owner: '', createdAt: nowIso, updatedAt: nowIso, detail: '', acceptance: '',
    workflow: { round: 1 },
  }, null, 2) + '\n', 'utf8');
  // ③ 决策箱：4 条 open 全缺七要素（缺 defaultChoice/impact/dueAt）→ 列表被过滤空，但 open 计数=4
  const item = (id, over = {}) => ({
    id, title: '夹具：' + id, summary: '夹具背景', question: '怎么处置？',
    source: { kind: 'task', ref: 'T-20261116-000001-fixture' }, createdAt: nowIso, by: 'pm', status: 'open',
    options: ['继续', '停'], defaultChoice: '', impact: '', dueAt: '', readAt: null, answeredAt: null, updatedAt: nowIso, ...over,
  });
  fs.writeFileSync(BOX_FILE, JSON.stringify({
    schema: 1, project: PROJECT, updatedAt: nowIso,
    items: [
      item('D-20261115-184234-5be5', { title: '3条需求0任务怎么派' }),
      item('D-20261115-184235-4717', { title: '9f3e执行窗口选择' }),
      item('D-20261115-184356-3efd', { title: '12条账实不符需求怎么处置' }),
      item('D-20261115-185653-4a2c', { title: '角色卡上限4KB还是16KB' }),
    ],
  }, null, 2) + '\n', 'utf8');
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
  for (let i = 0; i < 150; i += 1) {
    const ready = await cdp.evaluate('document.readyState');
    if (ready === 'complete') break;
    await sleep(400);
  }
  return { child, cdp };
}

(async () => {
  seed();
  const app = await launch(PORT);
  check('隔离实例已启动（renderer/index.html 可连）', Boolean(app && app.cdp), { port: PORT });
  if (!app) return;
  const { child, cdp } = app;
  try {
    // 打开评审弹窗（界面真实入口）
    await cdp.evaluate("(function(){ const b=document.querySelector('[data-owner-review-entry]')||document.querySelector('#owner-review-entry'); if(b){b.click();return 'clicked';} return 'missing'; })()");
    await sleep(1200);
    const opened = await cdp.evaluate("(function(){ const d=document.querySelector('[data-owner-review-dialog]'); return d && !d.hidden ? 'open' : 'closed'; })()");
    check('评审弹窗可打开', opened === 'open', opened);

    const okRow = await cdp.evaluate(`(function(){
      const row=document.querySelector('[data-owner-all-item][data-or-req="${REQ_OK}"]');
      if(!row) return {missing:true};
      const badge=row.querySelector('[data-or-status-badge]');
      return { bucket: row.getAttribute('data-or-bucket'), text: (badge&&badge.textContent)||row.textContent||'' };
    })()`);
    check('① R-9f3e 不落「等你决定」组', Boolean(okRow && okRow.bucket && okRow.bucket !== 'pending'), okRow);
    check('① R-9f3e 徽标显示已通过（消费 ownerReview/decisons）', Boolean(okRow && /已通过/.test(okRow.text || '')), okRow);

    const ghost = await cdp.evaluate(`(function(){
      const row=document.querySelector('[data-owner-all-item][data-or-req="${REQ_GHOST}"]');
      const all=[...document.querySelectorAll('[data-owner-all-item]')].map(n=>n.getAttribute('data-or-req'));
      if(!row) return {missing:true, allCount: all.length};
      return { unregistered: row.getAttribute('data-or-unregistered'), text: row.textContent || '' };
    })()`);
    check('② 未登记需求在弹窗内可见并标「未登记·不可评审」', Boolean(ghost && /未登记/.test(ghost.text || '')), ghost);

    // S7（PM 06:31）：无门保护区——owner_review + pending + decisions=[] 必须仍进「等你决定」。
    const s7 = await cdp.evaluate(`(function(){
      const row=document.querySelector('[data-owner-all-item][data-or-req="${REQ_WAIT}"]');
      if(!row) return {missing:true};
      return { bucket: row.getAttribute('data-or-bucket'), text: row.textContent || '' };
    })()`);
    check('S7 真待决（owner_review+pending+无 decisions）仍在「等你决定」组', Boolean(s7 && s7.bucket === 'pending'), s7);

    // S8（PM 06:31）：approved 但 decisions=[] → 回退 ownerReview.status=approved → 不落 pending。
    const s8 = await cdp.evaluate(`(function(){
      const row=document.querySelector('[data-owner-all-item][data-or-req="${REQ_NODEC}"]');
      if(!row) return {missing:true};
      const badge=row.querySelector('[data-or-status-badge]');
      return { bucket: row.getAttribute('data-or-bucket'), text: (badge&&badge.textContent)||row.textContent||'' };
    })()`);
    check('S8 approved 无 decisions → 回退 ownerReview.status，落 running 且徽标已通过', Boolean(s8 && s8.bucket === 'running' && /已通过/.test(s8.text || '')), s8);

    // 打开决策箱：先点右下浮标，再点胶囊
    await cdp.evaluate("(function(){ const t=document.querySelector('#side-float-toggle'); if(t) t.click(); return 'ok'; })()");
    await sleep(600);
    await cdp.evaluate("(function(){ const p=document.querySelector('#decision-box-pill'); if(p) p.click(); return 'ok'; })()");
    await sleep(1200);
    const box = await cdp.evaluate(`(function(){
      const note=document.querySelector('#decision-box-list [data-decision-hidden]');
      const drawer=document.querySelector('#decision-box-drawer [data-decision-hidden]');
      const n=note||drawer;
      if(!n) return {missing:true, listEmpty: document.querySelector('#decision-box-list') ? document.querySelector('#decision-box-list').textContent.slice(0,80) : ''};
      return { total:n.getAttribute('data-decision-total'), shown:n.getAttribute('data-decision-shown'), hidden:n.getAttribute('data-decision-hidden'), text:n.textContent.slice(0,120) };
    })()`);
    check('③ 决策箱空列表仍给三数说明行（total=4/shown=0/hidden=4）', Boolean(box && box.total === '4' && box.shown === '0' && box.hidden === '4'), box);

    fs.mkdirSync(EVID, { recursive: true });
    fs.writeFileSync(path.join(EVID, 'ui3bugs-run.json'), JSON.stringify({ at: new Date().toISOString(), results }, null, 2) + '\n', 'utf8');
  } finally {
    try { await cdp.send('Browser.close', {}, 5000); } catch { /* */ }
    try { child.kill(); } catch { /* */ }
  }
  const pass = results.filter((r) => r.ok).length;
  console.log(`\n三个界面 BUG 断言：${pass}/${results.length} PASS`);
  fs.mkdirSync(EVID, { recursive: true });
  fs.writeFileSync(path.join(EVID, 'ui3bugs.log'), log.join('\n') + '\n', 'utf8');
})().catch((e) => { console.error('RUN_FAILED', (e && e.stack) || e); process.exitCode = 1; });
