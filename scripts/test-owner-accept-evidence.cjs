#!/usr/bin/env node
'use strict';
/**
 * B-20261115-115331-9b05（P0）验收前置两档：Owner 本人不再被「截图前置」卡死。
 *
 * 覆盖 AC1–AC5：
 *   AC1 Owner 验收（channel=ui/tty）只判「测试任务全 done + 最近决定 approved/skipped」，报告/截图不拦。
 *   AC2 PM 代验收（channel=proxy）仍要 报告≥1 + 截图≥1，缺项沿用 PM_ACCEPT_EVIDENCE_REQUIRED。
 *   AC3 缺证据时【通过】可点；确认弹窗列缺项（人话）；验收面板 0 处「前置不齐 / 暂不能验收」。
 *   AC4 造「无截图」需求 → Owner 通过可点且真落账（channel=ui）；同一条 → 代验收按钮禁用并给原因。
 *   AC5 文案统一「证据不全（Owner 可自行验收）」且与后端门同源（同一函数 acceptGate / 同一常量
 *       EVIDENCE_INCOMPLETE_LABEL，前端不另写一套）。
 *
 * 隔离（四重）：AWB_DATA_DIR + TEAM_ROOT + TEAM_PROJECTS_ROOT + TEAM_WORKBENCH_JSON 全指 _tmp/9b05-owner-accept；
 *   沙盘项目目录也独立（SB/project），夹具需求/任务/证据全部落在沙盘，真实 data/ 与 团队/状态/ 只读，
 *   脚本前后比对 mtime/sha256 并断言夹具没落进真实工作流。
 * 沙盘：复制真实 团队/（跳过 锁/邮箱），清空 members[].sessionId、activeProject、状态/启动/*.json；
 *   角色 boot 由壳层在沙盘里自动补（令牌来自团队工具，不自签）。
 * 端口：9443（独立实例，不碰 Owner 正在用的窗口）。
 *
 * 用法：node scripts/test-owner-accept-evidence.cjs
 * 退出码：0=全绿，1=有红/致命；沙盘自清理，证据留 项目/工作台改造修复/程序员A/产出/证据-9b05/。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');
const { rmSandbox, uniqueSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A/B：清理助手 + 唯一沙盘

const ROOT = path.resolve(__dirname, '..');
const REAL_TEAM = path.join(ROOT, '团队');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const REAL_PROJECT = path.join(ROOT, '项目', '工作台改造修复');
const REAL_STATE_DIR = path.join(REAL_TEAM, '状态', '项目', '工作台改造修复');
const PROJECT = '工作台改造修复';
const PROJECT_ID = 'P-b98f4eb7';
const BASE = uniqueSandbox('9b05-owner-accept'); // B-07b6 B：唯一沙盘（并发安全）
const SB = path.join(BASE, 'sb');
const TEAM = path.join(SB, '团队');
const PROJECT_DIR = path.join(SB, 'project');
const STORE = path.join(SB, 'data', 'userdata', 'workbench.json');
const STATE_DIR = path.join(TEAM, '状态', '项目', PROJECT);
const EVID = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-9b05');
const PORT = 9443;

const REQ_OWNER = 'R-20261115-999931-noshot';
const REQ_PROXY = 'R-20261115-999932-noshot';
const TASK_OWNER = 'T-20261115-999931-noshot';
const TASK_PROXY = 'T-20261115-999932-noshot';
const REPORT_REL = '测试人员/产出/9b05-测试报告.md';
const SHOT_REL = '测试人员/产出/9b05-截图.png';
const ROLE_DIRS = ['项目经理', '产品', '需求分析师', '程序员A', '程序员B', '测试人员'];
const PROJECT_DOCS = ['项目信息.md', '项目铁律.md', '项目索引.md', '项目索引.json', '协作准则.md'];
// 1x1 PNG（真魔数：验收证据的截图为文件头校验；不用假扩展名）
const PNG_1PX = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8AAAwAB/wD/6B0mAAAAAElFTkSuQmCC', 'base64');

const results = [];
const log = [];
let shots = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 700)}`;
  log.push(line);
  console.log(line);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return ''; }
}
function statStamp(file) { try { const s = fs.statSync(file); return `${s.size}:${s.mtimeMs}`; } catch { return 'missing'; } }
function readJson(file) { try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } }
function writeJson(file, data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8'); }

function getJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null));
    req.setTimeout(1500, () => { req.destroy(); resolve(null); });
  });
}
async function waitTarget(port, ms, pick) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const list = await getJson(`http://127.0.0.1:${port}/json/list`);
    if (Array.isArray(list)) {
      const hit = list.find(pick);
      if (hit && hit.webSocketDebuggerUrl) return hit;
    }
    await sleep(400);
  }
  return null;
}
class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map(); this.events = [];
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
        return;
      }
      if (m.method) this.events.push(m);
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
      if (out && out.exceptionDetails) return { __exception: String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || out.exceptionDetails.text).slice(0, 500) };
      return out && out.result ? out.result.value : undefined;
    } catch (e) { return { __cdperror: String((e && e.message) || e) }; }
  }
  exceptions() {
    return this.events.filter((e) => e.method === 'Runtime.exceptionThrown')
      .map((e) => String((e.params.exceptionDetails && (e.params.exceptionDetails.text || (e.params.exceptionDetails.exception && e.params.exceptionDetails.exception.description))) || '').slice(0, 300))
      .filter((t) => t && !/DevTools|Autofill/i.test(t));
  }
}

function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, ent.name); const d = path.join(dst, ent.name);
    if (filter && filter(s, ent)) continue;
    if (ent.isDirectory()) copyDir(s, d, filter);
    else if (ent.isFile()) fs.copyFileSync(s, d);
  }
}

/** 沙盘：团队副本 + 独立项目目录 + 独立 workbench.json（项目 path 指向沙盘项目目录）。 */
function seedSandbox() {
  fs.rmSync(BASE, { recursive: true, force: true });
  fs.mkdirSync(path.join(SB, 'data', 'userdata'), { recursive: true });
  const store = readJson(REAL_STORE);
  const real = (store.projects || []).find((p) => p && p.id === PROJECT_ID);
  if (!real) throw new Error(`真实 workbench.json 里没有项目 ${PROJECT_ID}`);
  const project = { ...real, name: PROJECT, teamName: PROJECT, path: PROJECT_DIR };
  store.projects = [project];
  store.activeProjectId = PROJECT_ID;
  writeJson(STORE, store);

  copyDir(REAL_TEAM, TEAM, (s) => /[\\/]锁([\\/]|$)/.test(s) || /[\\/]邮箱[\\/]/.test(s));
  const teamFile = path.join(TEAM, '状态', '团队.json');
  const team = readJson(teamFile) || {};
  for (const m of (team.members || [])) m.sessionId = '';
  team.activeProject = '';
  writeJson(teamFile, team);
  const startDir = path.join(TEAM, '状态', '启动');
  if (fs.existsSync(startDir)) for (const f of fs.readdirSync(startDir)) if (f.endsWith('.json')) fs.rmSync(path.join(startDir, f), { force: true });

  // 旧团队登记（<团队>/状态/项目/<slug>/项目.json → path）也必须指沙盘项目目录，
  // 否则验收会被 PROJECT_PATH_MISMATCH 拦下（壳层 store 的 path 与团队登记必须同源）。
  const regFile = path.join(STATE_DIR, '项目.json');
  const reg = readJson(regFile);
  if (reg) { reg.path = PROJECT_DIR; writeJson(regFile, reg); }

  // 沙盘项目目录：只补 boot 必读四样 + 六角色卡 + 需求总览（真实项目 34 万文件，不整目录复制）。
  fs.mkdirSync(path.join(PROJECT_DIR, '需求'), { recursive: true });
  for (const doc of PROJECT_DOCS) {
    const src = path.join(REAL_PROJECT, doc);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(PROJECT_DIR, doc));
  }
  const overview = path.join(REAL_PROJECT, '需求', '00-需求总览.md');
  if (fs.existsSync(overview)) fs.copyFileSync(overview, path.join(PROJECT_DIR, '需求', '00-需求总览.md'));
  for (const dir of ROLE_DIRS) {
    fs.mkdirSync(path.join(PROJECT_DIR, dir, '产出'), { recursive: true });
    for (const file of ['角色卡.md', '文件索引.md']) {
      const src = path.join(REAL_PROJECT, dir, file);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(PROJECT_DIR, dir, file));
    }
  }
  // 证据两件套（沙盘内）：报告含 PASS，截图是真 PNG。
  fs.mkdirSync(path.join(PROJECT_DIR, '测试人员', '产出'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT_DIR, REPORT_REL), [
    '# 9b05 夹具测试报告', '', '- 结果：PASS', '- 范围：验收前置两档', `- 日期：${new Date().toISOString().slice(0, 10)}`, ''
  ].join('\n'), 'utf8');
  fs.writeFileSync(path.join(PROJECT_DIR, SHOT_REL), PNG_1PX);
}

/** 夹具：两条「无截图」需求（test_done + 最近决定 approved + 测试任务 done），都带进行中的代管记录。 */
function acceptFixture() {
  const wfFile = path.join(STATE_DIR, '工作流.json');
  const wf = readJson(wfFile) || {};
  wf.requirements = wf.requirements || {};
  const at = '2026-11-15T04:00:00.000Z';
  const docRel = (id) => `需求/${id}-夹具.md`;
  const rowOf = (id, title) => ({
    id, title, priority: 'P1', origin: 'role', queued: false, round: Number(wf.round || 1), status: 'test_done',
    createdBy: 'product', createdAt: at, updatedAt: at,
    acceptanceCriteria: 'Owner 确认后 accepted。', story: '', detail: '',
    productReview: { verdict: 'approve', by: 'product', reviewRole: 'product', teamMode: 'full', comment: '9b05 夹具：已评审通过', at },
    requirementReview: { verdict: 'approve', by: 'product', reviewRole: 'product', teamMode: 'full', comment: '9b05 夹具：已评审通过', at },
    reviewedAt: at, reviewedBy: 'product', reviewRole: 'product',
    ownerReview: { status: 'approved', by: 'Owner', actor: 'owner', channel: 'ui', at, opinion: '9b05 夹具：Owner 已通过' },
    decisions: [{ status: 'approved', decision: 'approved', channel: 'ui', decidedBy: 'Owner', actor: 'owner', at, opinion: '9b05 夹具' }],
    dispatch: null, dev: null, test: null,
    // ★ 关键：只有报告、没有截图（Owner 报的「截图前置卡死」就是这个组合）
    acceptance: { evidence: [{ path: REPORT_REL, kind: 'report' }] },
    doc: docRel(id),
    history: []
  });
  wf.requirements[REQ_OWNER] = rowOf(REQ_OWNER, '夹具：无截图（Owner 可自行验收）');
  wf.requirements[REQ_PROXY] = rowOf(REQ_PROXY, '夹具：无截图（代验收要两件套）');
  writeJson(wfFile, wf);

  for (const [id, docId] of [[REQ_OWNER, REQ_OWNER], [REQ_PROXY, REQ_PROXY]]) {
    const file = path.join(PROJECT_DIR, '需求', `${docId}-夹具.md`);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, ['# ' + id + ' 夹具：无截图验收前置', '', `- 需求 id：${id}`, '- 优先级：P1', '- 状态：test_done', '', '## 验收标准', '', 'Owner 确认后 accepted。', ''].join('\n'), 'utf8');
  }
  const taskDir = path.join(STATE_DIR, '任务');
  fs.mkdirSync(taskDir, { recursive: true });
  const taskOf = (id, reqId) => ({
    id, project: PROJECT, type: 'task', requirementId: reqId,
    title: '9b05 夹具测试任务 ' + id, detail: '验收前置两档夹具', acceptance: '', story: '',
    priority: 'P1', owner: 'tester', status: 'done', createdBy: 'pm',
    createdAt: at, claimedAt: at, doneAt: at, evidence: `${REPORT_REL}（PASS）`, rev: 1, history: [], updatedAt: at
  });
  writeJson(path.join(taskDir, TASK_OWNER + '.json'), taskOf(TASK_OWNER, REQ_OWNER));
  writeJson(path.join(taskDir, TASK_PROXY + '.json'), taskOf(TASK_PROXY, REQ_PROXY));
  // 旧协议的需求镜像任务（任务/R-*.json，type=requirement、已 done）：验收收口要求它 done，
  // 否则壳层会去跑 team.mjs task done（沙盘里没有对应可收口任务会 TASK_NOT_FOUND）。
  const mirrorOf = (id) => ({
    id, project: PROJECT, type: 'requirement', requirementId: '',
    title: '夹具需求任务 ' + id, detail: '', acceptance: 'Owner 确认后 accepted。', story: '',
    priority: 'P1', owner: null, status: 'done', createdBy: 'product',
    createdAt: at, claimedAt: null, due: '', doneAt: at, evidence: '9b05 夹具：验收前置两档',
    rev: 0, history: [], workflow: { requirementStatus: 'test_done' }, updatedAt: at
  });
  writeJson(path.join(taskDir, REQ_OWNER + '.json'), mirrorOf(REQ_OWNER));
  writeJson(path.join(taskDir, REQ_PROXY + '.json'), mirrorOf(REQ_PROXY));
  // 进行中的代管记录：让「代验收」按钮的禁用原因只能来自证据门（AC4）。
  writeJson(path.join(STATE_DIR, '评审代管.json'), {
    records: [REQ_OWNER, REQ_PROXY].map((reqId) => ({
      requirementId: reqId, scope: 'always', authorization: '9b05 夹具：Owner 全权代管',
      startedAt: at, startedBy: 'owner', at, by: 'owner'
    }))
  });
}

function launchEnv() {
  return {
    ...process.env,
    TEAM_ROOT: TEAM,
    TEAM_PROJECTS_ROOT: path.join(TEAM, '状态', '项目'),
    TEAM_WORKBENCH_JSON: STORE,
    TEAM_SELFTEST: '1',
    AWB_DATA_DIR: path.join(SB, 'data')
  };
}
async function launchElectron() {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], {
    cwd: ROOT, env: launchEnv(), stdio: 'ignore', windowsHide: false
  });
  const target = await waitTarget(PORT, 60000, (x) => x && x.type === 'page' && String(x.url || '').includes('renderer/index.html'));
  if (!target) { try { child.kill(); } catch { /* */ } return null; }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws 连接失败')), { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Log.enable');
  await cdp.send('Page.enable');
  for (let i = 0; i < 120; i += 1) {
    const ready = await cdp.evaluate('document.readyState === "complete" && Boolean(document.getElementById("btn-board"))');
    if (ready === true) break;
    await sleep(500);
  }
  // 壳内 webview 加载的是真实 DSH 页面：导航到 about:blank，否则截图会黑底/挂住（只影响本隔离实例）
  const guest = await waitTarget(PORT, 5000, (x) => x && x.type === 'webview');
  if (guest) {
    try {
      const gws = new WebSocket(guest.webSocketDebuggerUrl);
      await new Promise((res) => { gws.addEventListener('open', res, { once: true }); setTimeout(res, 3000); });
      gws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: 'about:blank' } }));
      await sleep(600);
    } catch { /* webview 关掉也不影响断言 */ }
  }
  return { child, cdp, ws };
}
async function closeElectron(inst) {
  if (!inst) return;
  try { await inst.cdp.send('Browser.close', {}, 5000); } catch { /* */ }
  try { inst.child.kill(); } catch { /* */ }
  await sleep(1200);
}

/** 真实鼠标点击：滚进视野 + elementFromPoint 命中校验；矩形为 0 才退回 element.click()。 */
async function realClick(cdp, selector) {
  const geo = await cdp.evaluate(`(function(){
    const el = document.querySelector(${JSON.stringify(selector)});
    if (!el) return { missing: true };
    el.scrollIntoView({ block: 'center', inline: 'center' });
    const r = el.getBoundingClientRect();
    const x = Math.round(r.x + r.width / 2), y = Math.round(r.y + r.height / 2);
    const hit = (r.width > 0 && r.height > 0) ? document.elementFromPoint(x, y) : null;
    return { x, y, w: Math.round(r.width), h: Math.round(r.height),
      hitIsTarget: Boolean(hit && (hit === el || el.contains(hit))), disabled: Boolean(el.disabled) };
  })()`);
  if (!geo || geo.missing) return { mode: 'missing', geo };
  if (geo.w > 0 && geo.h > 0 && geo.hitIsTarget) {
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: geo.x, y: geo.y });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: geo.x, y: geo.y, button: 'left', clickCount: 1 });
    await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: geo.x, y: geo.y, button: 'left', clickCount: 1 });
    return { mode: 'mouse', geo, x: geo.x, y: geo.y };
  }
  await cdp.evaluate(`(function(){ const el = document.querySelector(${JSON.stringify(selector)}); if (el) el.click(); return true; })()`);
  return { mode: 'element', geo, reason: geo.w === 0 ? 'rect=0（不可见）' : 'elementFromPoint 未命中' };
}

/** 截图：不加 --disable-gpu（会让 captureScreenshot 恒超时）；先 bringToFront，失败重试。 */
async function shot(cdp, file) {
  try { await cdp.send('Page.bringToFront', {}, 8000); } catch { /* */ }
  const size = await cdp.evaluate('(function(){ return { w: Math.max(1, Number(window.innerWidth) || 1280), h: Math.max(1, Number(window.innerHeight) || 800) }; })()') || { w: 1280, h: 800 };
  try { await cdp.send('Emulation.setDeviceMetricsOverride', { width: size.w, height: size.h, deviceScaleFactor: 1, mobile: false }, 8000); } catch { /* */ }
  let lastErr = '';
  try {
    for (let i = 0; i < 4; i += 1) {
      try {
        const r = await cdp.send('Page.captureScreenshot', { format: 'png', fromSurface: true, captureBeyondViewport: false }, 20000);
        if (r && r.data) {
          const buf = Buffer.from(r.data, 'base64');
          fs.mkdirSync(path.dirname(file), { recursive: true });
          fs.writeFileSync(file, buf);
          return { ok: true, tries: i + 1, bytes: buf.length, file: path.basename(file) };
        }
        lastErr = '返回没有 data';
      } catch (e) { lastErr = String((e && e.message) || e); }
      await sleep(800);
    }
  } finally {
    try { await cdp.send('Emulation.clearDeviceMetricsOverride', {}, 5000); } catch { /* */ }
  }
  log.push(`截图失败 ${path.basename(file)}：${lastErr}`);
  return { ok: false, error: lastErr, file: path.basename(file) };
}

function readReqRow(id) {
  const wf = readJson(path.join(STATE_DIR, '工作流.json')) || {};
  return (wf.requirements || {})[id] || {};
}

(async () => {
  fs.mkdirSync(EVID, { recursive: true });
  const guards = {
    store: statStamp(REAL_STORE),
    team: sha256File(path.join(REAL_TEAM, '状态', '团队.json')),
    projectInfo: sha256File(path.join(REAL_PROJECT, '项目信息.md')),
    realWf: sha256File(path.join(REAL_STATE_DIR, '工作流.json'))
  };

  // ---------- 沙盘 + 夹具 ----------
  seedSandbox();
  acceptFixture();
  const startDir = path.join(TEAM, '状态', '启动');
  const startEmpty = fs.existsSync(startDir) ? fs.readdirSync(startDir).filter((f) => f.endsWith('.json')).length : 0;
  const membersCleared = ((readJson(path.join(TEAM, '状态', '团队.json')) || {}).members || []).every((m) => !m.sessionId);
  check('S0 沙盘就绪（团队副本 / members.sessionId 全清 / 状态/启动 令牌清空 / 项目目录独立）',
    startEmpty === 0 && membersCleared && fs.existsSync(path.join(PROJECT_DIR, '项目信息.md')), { startTokens: startEmpty, membersCleared });

  // 判定层（后端同一份实现的纯函数）：同一行 owner 档放行、proxy 档拦。
  const AP = require(path.join(ROOT, 'src', 'renderer', 'accept-prereq.js'));
  const wfNow = readJson(path.join(STATE_DIR, '工作流.json')) || {};
  const tasksNow = fs.existsSync(path.join(STATE_DIR, '任务'))
    ? fs.readdirSync(path.join(STATE_DIR, '任务')).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(STATE_DIR, '任务', f))).filter(Boolean)
    : [];
  const gateOwner = AP.acceptGate(wfNow.requirements[REQ_OWNER], tasksNow, { channel: 'ui' });
  const gateProxy = AP.acceptGate(wfNow.requirements[REQ_OWNER], tasksNow, { channel: 'proxy' });
  check('S1 夹具（无截图行）：owner 档可验收 / proxy 档缺截图 / 原因串带截图',
    gateOwner.canAccept === true && gateProxy.canAccept === false
    && gateProxy.evidenceMissingKeys.includes('shot') && /缺截图/.test(gateProxy.reasonText),
    { owner: { canAccept: gateOwner.canAccept, missing: gateOwner.missing.map((m) => m.key), reason: gateOwner.reasonText },
      proxy: { canAccept: gateProxy.canAccept, missing: gateProxy.missing.map((m) => m.key), reason: gateProxy.reasonText, code: gateProxy.code } });

  // 真实 11 条 test_done 需求（生产数据）在 owner 档是否都被放行——回放不断言真实写入。
  const realWf = readJson(path.join(REAL_STATE_DIR, '工作流.json')) || {};
  const realTasks = fs.existsSync(path.join(REAL_STATE_DIR, '任务'))
    ? fs.readdirSync(path.join(REAL_STATE_DIR, '任务')).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(REAL_STATE_DIR, '任务', f))).filter(Boolean)
    : [];
  const realTestDone = Object.values(realWf.requirements || {}).filter((row) => String((row && row.status) || '') === 'test_done');
  const realOwnerOpen = realTestDone.filter((row) => AP.acceptGate(row, realTasks, { channel: 'ui' }).canAccept).length;
  const realProxyBlocked = realTestDone.filter((row) => !AP.acceptGate(row, realTasks, { channel: 'proxy' }).canAccept).length;
  check('S2 真实数据回放：待验收需求在 owner 档全部放行、在 proxy 档仍被证据门拦住（修复前是 0/11 可点）',
    realTestDone.length > 0 && realOwnerOpen === realTestDone.length && realProxyBlocked === realTestDone.length,
    { testDone: realTestDone.length, ownerOpen: realOwnerOpen, proxyBlocked: realProxyBlocked });

  // ---------- 真窗口 ----------
  const inst = await launchElectron();
  try {
    if (!inst) { check('E0 实例启动 + CDP 连上', false); throw new Error('Electron 实例未起来'); }
    check('E0 实例启动 + CDP 连上', true, { port: PORT });

    // tester boot（验收前置门：gateRole=tester）
    const bootRaw = await inst.cdp.evaluate(`(async()=>{ const r = await window.workbench.workflowBoot({ projectId: ${JSON.stringify(PROJECT_ID)}, role: 'tester' }); return JSON.stringify({ ok: r.ok, code: r.code || '', complete: Boolean(r.bootRead && r.bootRead.complete), message: String((r && r.message) || '').slice(0, 200) }); })()`, 120000);
    let boot = null; try { boot = JSON.parse(bootRaw); } catch { boot = { raw: String(bootRaw).slice(0, 300) }; }
    check('S3 tester boot 完成（验收前置门；令牌来自团队工具）', boot && boot.ok === true && boot.complete === true, boot);

    // 打开【我的验收】并按刷新（夹具在页面前写盘，与 Owner 真实操作一致）
    await inst.cdp.evaluate(`(function(){ const b = document.querySelector('[data-owner-accept-entry]'); if (b) b.click(); return true; })()`);
    await sleep(800);
    await inst.cdp.evaluate(`(function(){ const b = document.querySelector('[data-action="accept-refresh"]'); if (b) b.click(); return true; })()`);
    await sleep(1500);

    const rowSel = `#accept-list .accept-row[data-req-id="${REQ_OWNER}"]`;
    const dom = await inst.cdp.evaluate(`(function(){
      const box = document.getElementById('accept-list');
      const row = document.querySelector(${JSON.stringify(rowSel)});
      if (!box || !row) return { hasBox: Boolean(box), hasRow: Boolean(row), text: box ? String(box.innerText || '').slice(0, 400) : '' };
      const accept = row.querySelector('[data-action="owner-accept"]');
      const proxy = row.querySelector('[data-action="pm-accept"]');
      return {
        hasBox: true, hasRow: true,
        rowText: String(row.innerText || '').slice(0, 900),
        boxText: String(box.innerText || '').slice(0, 4000),
        prereqCan: row.querySelector('[data-accept-prereq]') ? row.querySelector('[data-accept-prereq]').getAttribute('data-accept-can') : null,
        proxyCan: row.querySelector('[data-accept-prereq]') ? row.querySelector('[data-accept-prereq]').getAttribute('data-accept-proxy-can') : null,
        evidenceMissing: row.querySelector('[data-accept-evidence-missing]') ? row.querySelector('[data-accept-evidence-missing]').getAttribute('data-accept-evidence-missing') : '',
        evidenceText: row.querySelector('.accept-pre-evidence') ? String(row.querySelector('.accept-pre-evidence').textContent || '') : '',
        acceptDisabled: accept ? Boolean(accept.disabled) : null,
        acceptGate: accept ? accept.getAttribute('data-accept-gate') : null,
        acceptTitle: accept ? String(accept.title || '') : '',
        proxyDisabled: proxy ? Boolean(proxy.disabled) : null,
        proxyBlocked: proxy ? String(proxy.getAttribute('data-accept-proxy-blocked') || '') : '',
        proxyCode: proxy ? String(proxy.getAttribute('data-accept-proxy-code') || '') : '',
        proxyTitle: proxy ? String(proxy.title || '') : ''
      };
    })()`);
    check('V0 验收列表里有这条「无截图」需求且前置行已渲染', Boolean(dom && dom.hasRow && dom.acceptGate), { hasRow: dom && dom.hasRow, text: dom && (dom.rowText || dom.text || '').slice(0, 200) });

    // AC1/AC3：【通过】可点
    check('A1（AC1/AC3）缺截图时【通过】可点（disabled=false，gate=open）',
      Boolean(dom) && dom.acceptDisabled === false && dom.acceptGate === 'open',
      { disabled: dom && dom.acceptDisabled, gate: dom && dom.acceptGate, title: dom && dom.acceptTitle });

    // AC5：行内缺项文案 = 统一原因串
    check('A2（AC5）行内缺项文案＝「证据不全（Owner 可自行验收）：缺截图」（data-accept-evidence-missing=shot）',
      Boolean(dom) && dom.evidenceMissing === 'shot' && /证据不全（Owner 可自行验收）/.test(String(dom.evidenceText)) && /缺截图/.test(String(dom.evidenceText)),
      { evidenceMissing: dom && dom.evidenceMissing, evidenceText: dom && dom.evidenceText });

    // AC3：面板里 0 处拦截文案
    check('A3（AC3）验收面板 0 处「前置不齐」「暂不能验收」拦截文案',
      Boolean(dom) && !/前置不齐/.test(String(dom.boxText || '')) && !/暂不能验收/.test(String(dom.boxText || '')),
      { hasPhrase: [/前置不齐/.test(String(dom && dom.boxText || '')), /暂不能验收/.test(String(dom && dom.boxText || ''))] });

    // AC2/AC4：代验收按钮禁用并给原因
    check('A4（AC2/AC4）同一条的代验收按钮禁用，原因含「证据不全（Owner 可自行验收）」且码=PM_ACCEPT_EVIDENCE_REQUIRED',
      Boolean(dom) && dom.proxyDisabled === true && dom.proxyBlocked.includes('shot')
      && dom.proxyCode === 'PM_ACCEPT_EVIDENCE_REQUIRED'
      && /证据不全（Owner 可自行验收）/.test(String(dom.proxyTitle)),
      { disabled: dom && dom.proxyDisabled, blocked: dom && dom.proxyBlocked, code: dom && dom.proxyCode, title: dom && dom.proxyTitle });

    shots.push(await shot(inst.cdp, path.join(EVID, 'shot-1-accept-list-owner-clickable.png')));

    // AC3：确认弹窗列缺项且【确认验收】可点
    const clicked = await realClick(inst.cdp, `${rowSel} [data-action="owner-accept"]`);
    await sleep(900);
    const dialog = await inst.cdp.evaluate(`(function(){
      const form = document.querySelector('[data-accept-form]');
      if (!form) return { hasForm: false };
      const box = form.querySelector('[data-accept-dialog-missing]');
      const ok = form.querySelector('[data-action="owner-accept-confirm"]');
      return {
        hasForm: form.hidden !== true,
        missingKeys: box ? String(box.getAttribute('data-accept-dialog-missing') || '') : '',
        missingText: box ? String(box.innerText || '').trim().slice(0, 400) : '',
        preKeys: [...form.querySelectorAll('[data-accept-dialog-pre]')].map((n) => n.getAttribute('data-accept-dialog-pre')),
        confirmDisabled: ok ? Boolean(ok.disabled) : null,
        formText: String(form.innerText || '').slice(0, 900)
      };
    })()`);
    check('A5（AC3）确认弹窗列出缺项（缺截图 + 统一原因串）且【确认验收】可点',
      Boolean(dialog) && dialog.hasForm === true && String(dialog.missingKeys).includes('shot')
      && /证据不全（Owner 可自行验收）/.test(String(dialog.missingText)) && /缺截图/.test(String(dialog.missingText))
      && dialog.confirmDisabled === false,
      { trigger: clicked.mode, dialog: dialog && { missingKeys: dialog.missingKeys, missingText: dialog.missingText, preKeys: dialog.preKeys, confirmDisabled: dialog.confirmDisabled } });
    shots.push(await shot(inst.cdp, path.join(EVID, 'shot-2-confirm-dialog-missing.png')));

    // AC1/AC4：真点确认 → 落账（channel=ui、无证据）
    const confirmClick = await realClick(inst.cdp, '[data-accept-form] [data-action="owner-accept-confirm"]');
    // 验收要跑旧协议（task done / 看板重生成），等状态真落账，最多 40 秒（轮询而不是死等）。
    let rowAfter = readReqRow(REQ_OWNER);
    for (let i = 0; i < 40 && String(rowAfter.status) !== 'accepted'; i += 1) {
      await sleep(1000);
      rowAfter = readReqRow(REQ_OWNER);
    }
    const banner = await inst.cdp.evaluate(`(function(){ const f = document.querySelector('[data-accept-form]'); const e = f ? f.querySelector('[data-accept-error]') : null; return e && e.hidden === false ? String(e.textContent || '').slice(0, 400) : ''; })()`);
    const decisions = Array.isArray(rowAfter.decisions) ? rowAfter.decisions : [];
    const last = decisions.length ? decisions[decisions.length - 1] : {};
    check('A6（AC1/AC4）点确认后真落账：status=accepted、最近决定 channel=ui / actor=owner、未因缺截图被拦',
      String(rowAfter.status) === 'accepted' && String(last.status || last.decision) === 'accepted'
      && String(last.channel) === 'ui' && String(last.actor) === 'owner' && !(Array.isArray(last.evidence) && last.evidence.length),
      { trigger: confirmClick.mode, status: rowAfter.status, banner, decision: { status: last.status, channel: last.channel, actor: last.actor, evidence: last.evidence || null } });

    // 落账后该行从列表消失（同一个 #accept-list）；界面拿到 IPC 结果后会 loadData + 重绘，轮询最多 15 秒。
    let goneAfter = false;
    for (let i = 0; i < 15 && !goneAfter; i += 1) {
      goneAfter = await inst.cdp.evaluate(`(function(){ return !document.querySelector(${JSON.stringify(rowSel)}); })()`) === true;
      if (!goneAfter) await sleep(1000);
    }
    check('A7（AC4）落账后该行从待验收列表移除（重绘后不在 test_done 列表里）', goneAfter === true, { gone: goneAfter });

    // ---------- AC2 后端门：代验收 ----------
    const proxyNoEvidence = await inst.cdp.evaluate(`(async()=>{
      try {
        const r = await window.workbench.ownerAccept({ projectId: ${JSON.stringify(PROJECT_ID)}, requirementId: ${JSON.stringify(REQ_PROXY)}, decision: 'accepted', opinion: '9b05 断言：无截图代验收', role: 'pm', evidence: [{ path: ${JSON.stringify(REPORT_REL)}, kind: 'report' }] });
        return JSON.stringify({ ok: r && r.ok, code: r && r.code, message: String((r && r.message) || '').slice(0, 300), reason: r && r.reason });
      } catch (e) { return JSON.stringify({ error: String((e && e.message) || e).slice(0, 300) }); }
    })()`, 120000);
    let proxyReject = null; try { proxyReject = JSON.parse(proxyNoEvidence); } catch { proxyReject = { raw: String(proxyNoEvidence).slice(0, 300) }; }
    const proxyRowBefore = readReqRow(REQ_PROXY);
    check('B1（AC2）代验收缺截图 → PM_ACCEPT_EVIDENCE_REQUIRED（码不变）且零副作用',
      Boolean(proxyReject) && proxyReject.ok === false && proxyReject.code === 'PM_ACCEPT_EVIDENCE_REQUIRED'
      && String(proxyRowBefore.status) === 'test_done' && (Array.isArray(proxyRowBefore.decisions) ? proxyRowBefore.decisions.length : 0) === 1,
      { result: proxyReject, status: proxyRowBefore.status, decisions: (proxyRowBefore.decisions || []).length });

    const proxyWithEvidence = await inst.cdp.evaluate(`(async()=>{
      try {
        const report = ${JSON.stringify(REPORT_REL)}, shotRel = ${JSON.stringify(SHOT_REL)};
        const r = await window.workbench.ownerAccept({ projectId: ${JSON.stringify(PROJECT_ID)}, requirementId: ${JSON.stringify(REQ_PROXY)}, decision: 'accepted', opinion: '9b05 断言：两件套齐全代验收', role: 'pm', evidence: [{ path: report, kind: 'report' }, { path: shotRel, kind: 'screenshot' }] });
        return JSON.stringify({ ok: r && r.ok, code: r && r.code, message: String((r && r.message) || '').slice(0, 300) });
      } catch (e) { return JSON.stringify({ error: String((e && e.message) || e).slice(0, 300) }); }
    })()`, 120000);
    let proxyOk = null; try { proxyOk = JSON.parse(proxyWithEvidence); } catch { proxyOk = { raw: String(proxyWithEvidence).slice(0, 300) }; }
    const proxyRowAfter = readReqRow(REQ_PROXY);
    const proxyDecisions = Array.isArray(proxyRowAfter.decisions) ? proxyRowAfter.decisions : [];
    const proxyLast = proxyDecisions.length ? proxyDecisions[proxyDecisions.length - 1] : {};
    check('B2（AC2 正控）代验收两件套齐全 → 成功并落账 channel=proxy + evidence 留痕（门没有把 PM 一起挡死）',
      Boolean(proxyOk) && proxyOk.ok === true && String(proxyRowAfter.status) === 'accepted'
      && String(proxyLast.channel) === 'proxy' && String(proxyLast.recordedBy) === 'pm'
      && Array.isArray(proxyLast.evidence) && proxyLast.evidence.length >= 2,
      { result: proxyOk, status: proxyRowAfter.status, decision: { channel: proxyLast.channel, recordedBy: proxyLast.recordedBy, evidence: (proxyLast.evidence || []).length } });

    // ---------- AC5 同源（源码级） ----------
    const AP_SRC = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'accept-prereq.js'), 'utf8');
    const MAIN_SRC = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
    const REVIEW_SRC = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'owner-review.js'), 'utf8');
    const LABEL = AP.EVIDENCE_INCOMPLETE_LABEL;
    const labelLiteral = (src) => (String(src).match(new RegExp(LABEL.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
    check('C1（AC5）原因串唯一常量：accept-prereq.js 定义 EVIDENCE_INCOMPLETE_LABEL，且全仓只有它写这句字面量',
      AP_SRC.includes('const EVIDENCE_INCOMPLETE_LABEL') && labelLiteral(AP_SRC) >= 1
      && !MAIN_SRC.includes(LABEL) && !REVIEW_SRC.includes(LABEL),
      { label: LABEL, inAcceptPrereq: labelLiteral(AP_SRC), inMain: labelLiteral(MAIN_SRC), inOwnerReview: labelLiteral(REVIEW_SRC) });
    check('C2（AC5）后端门用同一个函数：main.js require accept-prereq 并调 acceptGate（不另写一套判定）',
      /require\(path\.join\(__dirname, 'renderer', 'accept-prereq\.js'\)\)/.test(MAIN_SRC)
      && /acceptPrereq\.acceptGate\(/.test(MAIN_SRC) && /acceptPrereq\.EVIDENCE_INCOMPLETE_LABEL/.test(MAIN_SRC)
      && /acceptPrereq\.PROXY_EVIDENCE_CODE/.test(MAIN_SRC),
      { requiresModule: /accept-prereq\.js/.test(MAIN_SRC), callsGate: /acceptPrereq\.acceptGate\(/.test(MAIN_SRC) });
    check('C3（AC5）前端取同一函数与同一常量：owner-review.js 用 gateOfRow/acceptGate + AcceptPrereq 常量，不再用 prereq.canAccept 决定置灰',
      /function gateOfRow\(/.test(REVIEW_SRC) && /AP\.acceptGate\(row, tasks, \{ channel: channel \|\| 'ui' \}\)/.test(REVIEW_SRC)
      && /gateOfRow\(row, 'ui'\)/.test(REVIEW_SRC) && /gateOfRow\(row, 'proxy'\)/.test(REVIEW_SRC)
      && !/prereq\.canAccept \? '1' : '0'/.test(REVIEW_SRC)
      && /evidenceIncompleteTextOf\(/.test(REVIEW_SRC),
      { gateOfRow: /function gateOfRow\(/.test(REVIEW_SRC), usesApGate: /AP\.acceptGate\(/.test(REVIEW_SRC) });

    const exec = inst.cdp.exceptions();
    check('E1 全程窗口零未捕获异常（Runtime.exceptionThrown 0）', exec.length === 0, { exceptions: exec.slice(0, 3) });
  } finally {
    await closeElectron(inst);
  }

  // ---------- 截图与隔离 ----------
  check('V1 两张证据截图落盘且不是空图（列表可点 / 确认框缺项）',
    shots.length === 2 && shots.every((s) => s && s.ok && Number(s.bytes) > 10000), { shots });

  const after = {
    store: statStamp(REAL_STORE),
    team: sha256File(path.join(REAL_TEAM, '状态', '团队.json')),
    projectInfo: sha256File(path.join(REAL_PROJECT, '项目信息.md'))
  };
  const realWfText = fs.existsSync(path.join(REAL_STATE_DIR, '工作流.json')) ? fs.readFileSync(path.join(REAL_STATE_DIR, '工作流.json'), 'utf8') : '';
  const leaked = [TASK_OWNER, TASK_PROXY].filter((id) => fs.existsSync(path.join(REAL_STATE_DIR, '任务', id + '.json')));
  check('R1 隔离：真实 workbench.json 尺寸/mtime、团队.json、项目信息.md 未被本脚本写；夹具没落进真实 团队/状态',
    after.store === guards.store && after.team === guards.team && after.projectInfo === guards.projectInfo
    && !realWfText.includes(REQ_OWNER) && !realWfText.includes(REQ_PROXY) && leaked.length === 0,
    { store: { before: guards.store, after: after.store }, teamSame: after.team === guards.team, projectInfoSame: after.projectInfo === guards.projectInfo, leaked, fixturesInRealWorkflow: realWfText.includes(REQ_OWNER) || realWfText.includes(REQ_PROXY) });

  // ---------- 证据落盘 + 沙盘自清理 ----------
  const passed = results.filter((r) => r.ok).length;
  const summary = {
    at: new Date().toISOString(),
    requirement: 'B-20261115-115331-9b05',
    passed, failed: results.length - passed, total: results.length,
    fixture: { ownerRequirement: REQ_OWNER, proxyRequirement: REQ_PROXY, evidence: [REPORT_REL], screenshots: [] },
    ownerAccept: {
      ownerRequirement: REQ_OWNER,
      status: readReqRow(REQ_OWNER).status,
      decisions: readReqRow(REQ_OWNER).decisions || []
    },
    proxyAccept: {
      requirementId: REQ_PROXY,
      status: readReqRow(REQ_PROXY).status,
      decisions: readReqRow(REQ_PROXY).decisions || []
    },
    screenshots: shots,
    results
  };
  fs.writeFileSync(path.join(EVID, 'owner-accept-result.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(EVID, 'owner-accept.log'), log.join('\n') + '\n', 'utf8');
  try {
    const snap = path.join(EVID, 'sandbox-snapshot');
    fs.mkdirSync(snap, { recursive: true });
    fs.writeFileSync(path.join(snap, 'requirements.json'), JSON.stringify({ [REQ_OWNER]: readReqRow(REQ_OWNER), [REQ_PROXY]: readReqRow(REQ_PROXY) }, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(snap, 'stateDir.txt'), STATE_DIR + '\n', 'utf8');
  } catch (e) { log.push('证据副本失败：' + String((e && e.message) || e)); }
  fs.rmSync(BASE, { recursive: true, force: true });

  console.log(`\nB-9b05 验收前置两档断言：${passed}/${results.length} PASS`);
  process.exit(passed === results.length ? 0 : 1);
})().catch((e) => {
  console.error((e && e.stack) || e);
  try {
    fs.mkdirSync(EVID, { recursive: true });
    fs.writeFileSync(path.join(EVID, 'owner-accept.log'), log.join('\n') + '\nFATAL: ' + String((e && e.stack) || e) + '\n', 'utf8');
  } catch { /* 证据写不进也不能二次抛 */ }
  try { fs.rmSync(BASE, { recursive: true, force: true }); } catch { /* 沙盘删不掉不影响退出码 */ }
  process.exit(1);
});
