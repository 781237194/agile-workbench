#!/usr/bin/env node
'use strict';
/**
 * test-a514-window.cjs —— a514 真窗口样本（隐藏单实例 / 沙盘数据 / 不改生产终态）
 *
 * 每采一个样本前，把沙盘 工作流.json 复位（需求回到待决定），保证 3 次都是真实落账而不是「已处理秒过」。
 * 采：A 验收点击→成功提示可见 ×3；B 评审「通过」→「已通过」可见 ×3；C 打字 20 字符 p95；D 主进程 profile 行。
 */
const fs = require('node:fs');
const crypto = require('node:crypto');
const os = require('node:os');
const path = require('node:path');
const { spawn, spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, '_tmp', 'a514-window'); })();
fs.mkdirSync(OUT, { recursive: true });
// 740a（PM 12:43）：沙盘根固定在安装盘上的 awb-sandbox（AWB_SANDBOX_ROOT 可覆盖但拒绝系统盘），由 guard 统一校验/创建。
const sandboxGuard = require(path.join(ROOT, 'scripts', 'sandbox-guard.cjs'));
let SANDBOX_ROOT = '';
try {
  SANDBOX_ROOT = sandboxGuard.sandboxTmp();
  sandboxGuard.guard({ root: sandboxGuard.DEFAULTS.root });
} catch (error) {
  console.error(String((error && error.code) || 'SANDBOX_GUARD_FAILED') + ': ' + String((error && error.message) || error));
  process.exit(2);
}
const SB = fs.mkdtempSync(path.join(SANDBOX_ROOT, 'a514win-'));
INSTANCE_LOCK = path.join(SANDBOX_ROOT, 'a514-window.lock');
const TEAM = path.join(SB, '团队');
const PROJ = path.join(SB, '项目', '工作台改造修复');
const STORE = path.join(SB, 'store', 'workbench.json');
const WF = path.join(TEAM, '状态', '项目', '工作台改造修复', '工作流.json');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
// PM 171732：单实例锁——锁文件存在且 pid 存活时拒绝启动，避免并发/循环起实例。
var INSTANCE_LOCK = ''; // SB 定义之后立刻赋值；var 声明避免 TDZ
function pidAlive(pid) { try { process.kill(pid, 0); return true; } catch { return false; } }
function acquireInstanceLock() {
  if (!INSTANCE_LOCK) return;
  try {
    if (fs.existsSync(INSTANCE_LOCK)) {
      const otherPid = Number.parseInt(String(fs.readFileSync(INSTANCE_LOCK, 'utf8') || ''), 10);
      if (Number.isFinite(otherPid) && otherPid > 0 && pidAlive(otherPid)) {
        console.error('SINGLE_INSTANCE_LOCKED pid=' + otherPid + '；同一时间只允许 1 个测试实例（PM 171732）');
        process.exit(3);
      }
    }
    fs.writeFileSync(INSTANCE_LOCK, String(process.pid), 'utf8');
  } catch { /* 锁失败不阻断，但清理仍会做 */ }
}
function releaseInstanceLock() {
  if (!INSTANCE_LOCK) return;
  try {
    if (!fs.existsSync(INSTANCE_LOCK)) return;
    const pid = Number.parseInt(String(fs.readFileSync(INSTANCE_LOCK, 'utf8') || ''), 10);
    if (!Number.isFinite(pid) || pid === process.pid) fs.rmSync(INSTANCE_LOCK, { force: true });
  } catch { /* ignore */ }
}
process.on('exit', releaseInstanceLock);
process.on('SIGINT', () => { releaseInstanceLock(); process.exit(130); });
process.on('SIGTERM', () => { releaseInstanceLock(); process.exit(143); });
const log = (...a) => console.log('[a514-window]', ...a);
const PROJECT = '工作台改造修复';
const REQ_ACCEPT = 'R-20261121-1401-a514'; // 必须匹配 REQ_FILE_RE：R-YYYYMMDD-数字-可选hex
const REQ_REVIEW = 'R-20261121-1402-b514';
let BASE_WF = null;

function cpRetry(src, dst) {
  let last = null;
  for (let i = 0; i < 4; i += 1) {
    try { fs.cpSync(src, dst, { recursive: true, force: true }); return; } catch (e) { last = e; }
    try { spawnSync('powershell', ['-NoProfile', '-Command', 'Start-Sleep -Milliseconds 400'], { stdio: 'ignore' }); } catch { /* ignore */ }
  }
  throw last;
}

/**
 * 沙盘隔离关键：copied 的 团队.json / 项目.json / 工作流.json / 团队会话.json 里都是真实仓库绝对路径，
 * 不改成沙盘路径时，验收 IPC 会报「项目目录与旧团队登记不一致」——之前 accept 样本实际测到的是失败提示。
 */
function rewriteSandboxPaths() {
  const realRoot = ROOT;
  const realRootFwd = realRoot.replace(/\\/g, '/');
  // JSON 文件里反斜杠会被转义成双写形态，只替换原始形态匹配不到 → 四种形态都要换。
  const realRootEsc = realRoot.replace(/\\/g, '\\\\');
  const sandbox = SB;
  const sandboxFwd = sandbox.replace(/\\/g, '/');
  const sandboxEsc = sandbox.replace(/\\/g, '\\\\');
  const forms = [
    [realRootEsc, sandboxEsc],
    [realRootFwd, sandboxFwd],
    [realRoot, sandbox],
  ];
  const walk = (dir) => {
    let entries = [];
    try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) { walk(full); continue; }
      // 只改 JSON/JSONL：boot 记录里 项目信息.md/角色卡.md 的 hash 必须与真实文件一致，改了就会「boot 记录过期」。\n      if (!/\.(json|jsonl)$/i.test(entry.name)) continue;
      let text = '';
      try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
      // 项目.json 里的路径是 JSON 转义后的双反斜杠形态，必须用 forms 逐个判存在。
      if (!forms.some(([from]) => text.includes(from))) continue;
      let next = text;
      for (const [from, to] of forms) next = next.split(from).join(to);
      try { fs.writeFileSync(full, next, 'utf8'); } catch { /* ignore */ }
    }
  };
  walk(TEAM);
  walk(PROJ);
}

function seed() {
  fs.mkdirSync(path.join(TEAM, '状态', '项目'), { recursive: true });
  cpRetry(path.join(ROOT, '团队', '状态', '项目', PROJECT), path.join(TEAM, '状态', '项目', PROJECT));
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  fs.copyFileSync(path.join(ROOT, '团队', '状态', '团队.json'), path.join(TEAM, '状态', '团队.json'));
  // 沙盘名册必须清空真实会话绑定：不清时壳层拿自己的 boot 令牌（DSH 会话）去写操作会撞 SESSION_REPLACED，
  // 表现为验收在「关闭旧需求任务」处失败（accept-profile acceptMs≈3s 且提示会话已被替换）。
  try {
    const teamJsonPath = path.join(TEAM, '状态', '团队.json');
    const teamJson = JSON.parse(fs.readFileSync(teamJsonPath, 'utf8'));
    for (const member of Array.isArray(teamJson.members) ? teamJson.members : []) member.sessionId = '';
    teamJson.activeProject = PROJECT;
    fs.writeFileSync(teamJsonPath, JSON.stringify(teamJson, null, 2) + '\n', 'utf8');
  } catch { /* ignore */ }
  for (const name of ['工具', '角色', '协议', 'skill', '模板', '流程.md', '团队宪法.md', '项目铁律.md']) {
    const src = path.join(ROOT, '团队', name);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(TEAM, name);
    if (fs.statSync(src).isDirectory()) fs.cpSync(src, dst, { recursive: true, force: true });
    else fs.copyFileSync(src, dst);
  }
  fs.mkdirSync(PROJ, { recursive: true });
  // 验收门校验 boot 记录里的文档 hash：把各角色目录的 md（角色卡/文件索引/协作准则…）原样复制，
  // 保证 hash 与真实 boot 记录一致；产出目录不复制（体积大且与本测无关）。
  for (const role of ['需求分析师', '产品', '项目经理', '程序员A', '程序员B', '测试人员']) {
    const srcDir = path.join(ROOT, '项目', PROJECT, role);
    if (!fs.existsSync(srcDir)) continue;
    const dstDir = path.join(PROJ, role);
    fs.mkdirSync(dstDir, { recursive: true });
    for (const name of fs.readdirSync(srcDir)) {
      if (!name.endsWith('.md')) continue;
      const srcFile = path.join(srcDir, name);
      if (!fs.statSync(srcFile).isFile()) continue;
      fs.copyFileSync(srcFile, path.join(dstDir, name));
    }
  }
  for (const name of ['需求', '项目信息.md', '项目索引.md', '项目铁律.md']) {
    const src = path.join(ROOT, '项目', PROJECT, name);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(PROJ, name);
    if (fs.statSync(src).isDirectory()) fs.cpSync(src, dst, { recursive: true, force: true }); else fs.copyFileSync(src, dst);
  }
  fs.mkdirSync(path.dirname(STORE), { recursive: true });
  const wf = JSON.parse(fs.readFileSync(WF, 'utf8'));
  wf.requirements = wf.requirements || {};
  wf.ownerReview = { status: 'optional', opinion: '', at: null, by: null, actor: null };
  const docs = fs.readdirSync(path.join(PROJ, '需求')).filter((n) => /^R-.*\.md$/.test(n));
  // 两个样本需求必须有自己的正文文件（验收门要求「需求有可读正文」，按文件名/id 匹配）。
  const reqDocs = {};
  // 与 src/team-tools.js → requirementContentText 同口径（去 BOM/状态行/状态记录节，行尾空白）后再算 contentHash。
  const requirementContentText = (text) => {
    const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
    const out = [];
    let inStatusSection = false;
    for (const line of lines) {
      if (/^##\s+状态记录/.test(line)) { inStatusSection = true; continue; }
      if (inStatusSection && /^##\s+/.test(line)) inStatusSection = false;
      if (inStatusSection) continue;
      if (/^- 状态：/.test(line)) continue;
      out.push(line.replace(/\s+$/, ''));
    }
    return out.join('\n').trim();
  };
  for (const pair of [[REQ_ACCEPT, 'a514 验收样本'], [REQ_REVIEW, 'a514 评审样本']]) {
    const rel = '需求/' + pair[0] + '-样本.md';
    const body = '# ' + pair[0] + ' · ' + pair[1] + '\n\n## 背景\n沙盘夹具需求。\n\n## 验收标准\n- AC1：沙盘内可验收/评审。\n';
    fs.writeFileSync(path.join(PROJ, rel), body, 'utf8');
    reqDocs[pair[0]] = {
      rel,
      sha256: crypto.createHash('sha256').update(body, 'utf8').digest('hex'),
      contentHash: crypto.createHash('sha256').update(requirementContentText(body), 'utf8').digest('hex'),
    };
  }
  const ts = (m) => new Date(Date.now() - m * 60000).toISOString();
  wf.requirements[REQ_ACCEPT] = {
    id: REQ_ACCEPT, title: 'a514 验收样本', status: 'test_done', phase: 'test_done', priority: 'P1',
    createdAt: ts(40), updatedAt: ts(1), acceptance: null,
    productReview: { verdict: 'approve', at: ts(30), by: 'product' },
    ownerReview: { status: 'pending', opinion: '', at: null },
    decisions: [{ decision: 'approved', at: ts(20), by: 'Owner', channel: 'ui', opinion: '开测', basis: { requirement: { sha256: reqDocs[REQ_ACCEPT].sha256 } } }],
    doc: reqDocs[REQ_ACCEPT].rel, tasks: [],
  };
  wf.requirements[REQ_REVIEW] = {
    id: REQ_REVIEW, title: 'a514 评审样本', status: 'ready', phase: 'ready', priority: 'P1',
    createdAt: ts(30), updatedAt: ts(2), acceptance: null,
    productReview: { verdict: 'approve', at: ts(10), by: 'product' },
    ownerReview: { status: 'pending', opinion: '', at: null },
    decisions: [], doc: reqDocs[REQ_REVIEW].rel, tasks: [],
  };
  // 验收/评审门还要求「该角色 boot 时读到过这条需求」：把两个样本需求补进各角色 boot 记录的 requirements.list。
  for (const boot of Object.values(wf.boots || {})) {
    if (!boot || typeof boot !== 'object') continue;
    boot.requirements = boot.requirements && typeof boot.requirements === 'object' ? boot.requirements : {};
    const list = Array.isArray(boot.requirements.list) ? boot.requirements.list.filter((row) => row && String(row.id || '') !== REQ_ACCEPT && String(row.id || '') !== REQ_REVIEW) : [];
    for (const rid of [REQ_ACCEPT, REQ_REVIEW]) {
      list.push({ id: rid, rel: reqDocs[rid].rel, hash: reqDocs[rid].sha256, contentHash: reqDocs[rid].contentHash, source: 'sandbox-seed', at: ts(5) });
    }
    boot.requirements.list = list;
    boot.requirements.hash = crypto.createHash('sha256').update(JSON.stringify(list)).digest('hex');
    boot.requirements.contentHash = boot.requirements.hash;
  }
  BASE_WF = JSON.stringify(wf, null, 2) + '\n';
  fs.writeFileSync(WF, BASE_WF, 'utf8');
  rewriteSandboxPaths();
  // boot 记录里的文档 hash 必须与沙盘文件一致（真实 boot 早于文档改动时会「必读文件已变化」）。
  try {
    const wfHash = JSON.parse(fs.readFileSync(WF, 'utf8'));
    let changed = false;
    for (const boot of Object.values(wfHash.boots || {})) {
      for (const doc of Object.values((boot && boot.docs) || {})) {
        if (!doc || !doc.rel) continue;
        // 项目级必读优先（项目铁律/项目信息/角色卡都在项目目录），团队级 rel（团队/skill/...）回退 TEAM。
        const candidates = [path.join(PROJ, doc.rel), path.join(TEAM, doc.rel), path.join(ROOT, doc.rel)];
        const found = candidates.find((p) => { try { return fs.statSync(p).isFile(); } catch { return false; } });
        if (!found) continue;
        const hash = crypto.createHash('sha256').update(fs.readFileSync(found)).digest('hex');
        if (doc.hash !== hash) { doc.hash = hash; doc.exists = true; changed = true; }
      }
    }
    if (changed) {
      BASE_WF = JSON.stringify(wfHash, null, 2) + '\n';
      fs.writeFileSync(WF, BASE_WF, 'utf8');
    }
  } catch { /* hash 对齐失败不阻断 seed */ }
  const taskDir = path.join(TEAM, '状态', '项目', PROJECT, '任务');
  fs.mkdirSync(taskDir, { recursive: true });
  const ACCEPT_TASK_ID = 'T-20261121-1401-a514';
  fs.writeFileSync(path.join(taskDir, ACCEPT_TASK_ID + '.json'), JSON.stringify({
    id: ACCEPT_TASK_ID, type: 'task', title: 'a514 验收样本测试', status: 'done',
    owner: 'tester', requirementId: REQ_ACCEPT, createdAt: ts(20), updatedAt: ts(5), acceptance: 'ok', evidence: 'task-scan-base.log'
  }, null, 2), 'utf8');
  // 需求行要带上已完成的测试任务（验收门会查「没有测试任务」）。
  {
    const wfTask = JSON.parse(fs.readFileSync(WF, 'utf8'));
    if (wfTask.requirements && wfTask.requirements[REQ_ACCEPT]) {
      wfTask.requirements[REQ_ACCEPT].tasks = [ACCEPT_TASK_ID];
      BASE_WF = JSON.stringify(wfTask, null, 2) + '\n';
      fs.writeFileSync(WF, BASE_WF, 'utf8');
    }
  }
  fs.writeFileSync(STORE, JSON.stringify({
    version: 1, activeProjectId: 'P-a514',
    projects: [{
      id: 'P-a514', name: PROJECT, teamName: PROJECT, path: PROJ, teamMode: 'full',
      workspace: { id: 'W-a514', path: PROJ, name: PROJECT, bound: true, sessionIds: [] },
      dshWorkspaceId: '', workspacePath: PROJ, sessions: {}, requirements: [], sessionMeta: {}, tasks: [], votes: [], ui: {}
    }],
    ui: {}
  }, null, 2) + '\n', 'utf8');
}
function resetWf() { if (BASE_WF) fs.writeFileSync(WF, BASE_WF, 'utf8'); }

function launch() {
  const electron = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');
  const port = 9700 + Math.floor(Math.random() * 200);
  const env = {
    ...process.env,
    ...sandboxGuard.sandboxEnv(),
    AWB_DATA_DIR: path.join(SB, 'data'), AWB_STORE: STORE, AWB_TEAM_ROOT: TEAM,
    TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: path.join(SB, '项目'), TEAM_WORKBENCH_JSON: STORE,
    AWB_START_HIDDEN: '1', DSH_WEB_URL: 'http://127.0.0.1:1', AWB_SHOW_INACTIVE: '1',
    ...(process.env.A514_PROD_PATH === '1' ? {} : { TEAM_SELFTEST: '1' }),
    // 隐藏窗口下 Chromium 会节流 rAF，打字「下一帧」测不出来；测试实例关闭后台节流。
    AWB_BACKGROUND_THROTTLING: '0',
  };
  delete env.ELECTRON_RUN_AS_NODE;
  acquireInstanceLock();
  const child = spawn(electron, [ROOT, `--remote-debugging-port=${port}`], { env, stdio: ['ignore', 'pipe', 'pipe'] });
  let stdout = '';
  child.stdout.on('data', (d) => { stdout += d.toString('utf8'); });
  child.stderr.on('data', (d) => { stdout += d.toString('utf8'); });
  return { child, port, getStdout: () => stdout };
}
async function waitTarget(port, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    try {
      const res = await fetch(`http://127.0.0.1:${port}/json/list`);
      const list = await res.json();
      const t = list.find((x) => x.type === 'page' && x.webSocketDebuggerUrl);
      if (t) return t;
    } catch { /* retry */ }
    await sleep(300);
  }
  return null;
}
class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); this.ws.addEventListener('message', (ev) => {
    try { const m = JSON.parse(ev.data); if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) p.reject(new Error(JSON.stringify(m.error))); else p.resolve(m.result); } } catch { /* ignore */ }
  }); }
  send(method, params = {}) { return new Promise((resolve, reject) => { const id = ++this.id; this.pending.set(id, { resolve, reject }); this.ws.send(JSON.stringify({ id, method, params })); setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP_TIMEOUT ' + method)); } }, 120000); }); }
  async evaluate(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true, userGesture: true });
    if (r.exceptionDetails) throw new Error('EVAL_FAIL ' + JSON.stringify(r.exceptionDetails).slice(0, 600));
    return r.result ? r.result.value : undefined;
  }
}
async function pageWaitIdle(cdp) {
  await cdp.evaluate(`new Promise((r) => { const t0 = Date.now(); const tick = async () => {
    try { const s = await window.workbench.workflowSideEffectsStatus(); if (!(s.queue || []).some((q) => q.running || q.pending)) return r(true); } catch {}
    if (Date.now() - t0 > 20000) return r(false); setTimeout(tick, 250);
  }; tick(); })`);
}
const ACCEPT_ONE = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { const v = fn(); if (v) return { v, at: performance.now() }; await wait(16); } return null; };
  if (typeof window.__awbOpenAcceptList !== 'function') return { ok: false, error: 'no __awbOpenAcceptList' };
  window.__awbOpenAcceptList();
  await wait(700);
  const row = document.querySelector('.accept-row[data-req-id="${REQ_ACCEPT}"]');
  if (!row) return { ok: false, error: 'row missing' };
  row.querySelector('[data-action="owner-accept"]').click();
  const c = await until(() => document.querySelector('[data-action="owner-accept-confirm"]:not([hidden])'), 5000);
  if (!c) return { ok: false, error: 'confirm missing' };
  const n0 = document.querySelector('[data-accept-list-notice]'); if (n0) n0.remove();
  const t0 = performance.now();
  try { c.v.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true, cancelable: true, pointerType: 'mouse' })); } catch { /* ignore */ }
  c.v.click();
  const seen = await until(() => {
    const list = [document.querySelector('#awb-accept-global'), document.querySelector('[data-accept-list-notice]')];
    return list.find((n) => n && n.getBoundingClientRect().height > 0 && /已验收|验收/.test(n.textContent || '')) || null;
  }, 20000);
  if (!seen) return { ok: false, error: 'notice timeout' };
  // PM 172739/173217：t0 click → t1 提示节点插入 → t2 实际可见 → t3 列表重建；另给 pointerdown→handler→notice→visible→IPC 五段
  const uiLast = window.__acceptUiLast || null;
  const click4 = window.__acceptClick4 || null;
  const t2 = Math.round(performance.now() - t0);
  return { ok: true, ms: t2, notice: String((seen.v ? seen.v.textContent : '') || '').slice(0, 80), ui: uiLast ? { ...uiLast, t2VisibleMs: t2 } : { t2VisibleMs: t2 }, click4 };
})()`;
const REVIEW_ONE = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const until = async (fn, ms) => { const t0 = performance.now(); while (performance.now() - t0 < ms) { const v = fn(); if (v) return { v, at: performance.now() }; await wait(16); } return null; };
  const entry = document.querySelector('#owner-review-entry');
  if (!entry) return { ok: false, error: 'review entry missing' };
  entry.click();
  await wait(900);
  const row = document.querySelector('[data-or-req="${REQ_REVIEW}"]') || document.querySelector('.or-item[data-id="${REQ_REVIEW}"]');
  if (!row) return { ok: false, error: 'review row missing' };
  row.click();
  await wait(600);
  const approve = document.querySelector('[data-or-approve]');
  if (!approve) return { ok: false, error: 'approve missing' };
  const n0 = document.querySelector('[data-or-notice]'); if (n0) { n0.textContent = ''; }
  const t0 = performance.now();
  approve.click();
  const seen = await until(() => {
    const list = [document.querySelector('[data-or-notice]'), document.querySelector('[data-or-notice-global]')];
    return list.find((n) => n && n.getBoundingClientRect().height > 0 && /已通过/.test(n.textContent || '')) || null;
  }, 20000);
  if (!seen) return { ok: false, error: 'notice timeout' };
  return { ok: true, ms: Math.round(seen.at - t0), notice: String((document.querySelector('[data-or-notice]') || {}).textContent || '').slice(0, 80), ui: window.__reviewUiLast || null };
})()`;
const TYPING = `(async () => {
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  const input = document.querySelector('#search') || document.querySelector('input[type="search"]') || document.querySelector('input[type="text"]');
  if (!input) return { ok: false, error: 'no input' };
  input.focus();
  const p = window.__awbTypingProbe(3200);
  for (let i = 0; i < 20; i += 1) {
    input.dispatchEvent(new KeyboardEvent('keydown', { key: String.fromCharCode(97 + i), bubbles: true }));
    await wait(30);
  }
  const r = await p;
  return { ok: Boolean(r && r.verdict), result: r };
})()`;

(async () => {
  seed(); log('sandbox', SB);
  const inst = launch();
  const samples = { accept: [], review: [] };
  const errors = [];
  try {
    const target = await waitTarget(inst.port);
    if (!target) throw new Error('CDP 目标未出现');
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', rej, { once: true }); });
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    await cdp.evaluate(`new Promise((r) => { const t0 = Date.now(); const tick = () => { if (window.workbench && document.querySelector('#app')) return r(true); if (Date.now() - t0 > 30000) return r(false); setTimeout(tick, 200); }; tick(); })`);
    const lazy = await cdp.evaluate(`new Promise((r) => { const t0 = Date.now(); const tick = () => { if (window.__awbLazyLoaded) return r(true); if (Date.now() - t0 > 20000) return r(false); setTimeout(tick, 200); }; tick(); })`);
    log('lazyLoaded', lazy);
    const ONLY_REVIEW = process.env.A514_ONLY_REVIEW === '1';
    let coldAccept = null;
    let coldUi = null;
    let cold = null;
    if (!ONLY_REVIEW) {
      // PM 14:37：冷态样本＝新实例 lazyLoaded 后立刻点验收（不预热弹窗、不 sleep 2s）。
      resetWf();
      await sleep(150);
      cold = await cdp.evaluate(ACCEPT_ONE);
      coldAccept = cold && cold.ok ? cold.ms : null;
      coldUi = cold && cold.ok ? (cold.ui || null) : null;
      if (coldAccept === null) errors.push('coldAccept: ' + JSON.stringify(cold));
      log('cold accept', JSON.stringify({ ms: coldAccept, cold }));
      await pageWaitIdle(cdp);
      // 预热两个弹窗（冷数据不计入样本）
      await cdp.evaluate(`(async () => { const wait = (ms) => new Promise((r) => setTimeout(r, ms));
        try { window.__awbOpenAcceptList && window.__awbOpenAcceptList(); } catch {}
        await wait(900);
        try { const c = document.querySelector('[data-accept-list-close], #accept-list .close'); if (c) c.click(); } catch {}
        try { const e = document.querySelector('#owner-review-entry'); if (e) e.click(); } catch {}
        await wait(900);
        try { const c = document.querySelector('[data-or-close]'); if (c) c.click(); } catch {}
        return true; })()`);
      await pageWaitIdle(cdp); await sleep(1200);
      resetWf();
      await sleep(400);
      const r = await cdp.evaluate(ACCEPT_ONE);
      if (r && r.ok) { samples.accept.push(r.ms); samples.acceptNotices = samples.acceptNotices || []; samples.acceptNotices.push(String(r.notice || '')); } else errors.push('accept: ' + JSON.stringify(r));
      await pageWaitIdle(cdp); await sleep(1200);
    }
    for (let i = 0; i < 1; i += 1) {
      resetWf();
      await sleep(400);
      const r = await cdp.evaluate(REVIEW_ONE);
      if (r && r.ok) { samples.review.push(r.ms); samples.reviewUi = samples.reviewUi || []; samples.reviewUi.push(r.ui || null); } else errors.push('review: ' + JSON.stringify(r));
      await pageWaitIdle(cdp); await sleep(1200);
      try { await cdp.evaluate(`(() => { const c = document.querySelector('[data-or-close]'); if (c) c.click(); return true; })()`); } catch { /* ignore */ }
      await sleep(300);
    }
    let typing = null;
    if (!ONLY_REVIEW) {
      await pageWaitIdle(cdp); await sleep(5000);
      typing = await cdp.evaluate(TYPING);
    }
    // 列表重建（requestIdleCallback 后）完成时间：t3
    try { coldUi = (await cdp.evaluate('window.__acceptUiLast || null')) || coldUi; } catch { /* ignore */ }
    const profiles = inst.getStdout().split(/\r?\n/).filter((l) => /\[accept-profile\]|\[review-profile\]|\[side-effects-profile\]|\[board-profile\]|\[workflow-prewarm\]/.test(l)).slice(-60);
    const report = { at: new Date().toISOString(), coldAccept, coldUi, coldClick4: (cold && cold.click4) || null, coldNotice: cold && cold.notice ? String(cold.notice) : '', samples, errors, typing, profiles };
    fs.writeFileSync(path.join(OUT, 'window-report.json'), JSON.stringify(report, null, 2) + '\n', 'utf8');
    fs.writeFileSync(path.join(OUT, 'window-stdout.log'), inst.getStdout(), 'utf8');
    log('accept samples', JSON.stringify(samples.accept));
    log('review samples', JSON.stringify(samples.review));
    log('typing', JSON.stringify({ ok: typing.ok, summary: typing.result && typing.result.summary, gate: typing.result && typing.result.gateSkipped }));
    log('errors', JSON.stringify(errors).slice(0, 300));
  } catch (e) {
    log('FAILED', String((e && e.stack) || e).slice(0, 900));
    fs.writeFileSync(path.join(OUT, 'window-stdout.log'), inst.getStdout(), 'utf8');
    process.exitCode = 1;
  } finally {
    try { spawnSync('taskkill', ['/PID', String(inst.child.pid), '/T', '/F'], { stdio: 'ignore', timeout: 20000 }); } catch { /* ignore */ }
    // PM 132753：跑完自清（AWB_KEEP_SANDBOX=1 才保留，便于事后归因）。
    if (String(process.env.AWB_KEEP_SANDBOX || '') !== '1') {
      // kill 后文件句柄可能还未释放：最多重试 3 次，避免沙盘残留。
      for (let attempt = 1; attempt <= 3; attempt += 1) {
        try { fs.rmSync(SB, { recursive: true, force: true }); break; } catch { if (attempt === 3) { try { console.warn('[sandbox] cleanup failed: ' + SB); } catch { /* ignore */ } } }
      }
    } else {
      log('sandbox kept', SB);
    }
  }
})();
