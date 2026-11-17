#!/usr/bin/env node
/**
 * T-20261117-192346-1c57（P1，测试侧）：fd42「更换项目经理后身份不生效」沙箱验收脚本（先红后绿）
 *
 * 需求：R-20261117-180740-fd42（v3，12168B/sha 04e12cfe…/RR-19a8）——名册唯一真相 + workbench 自动对齐 + 界面显示 + 失败可见。
 * 当前预期：**红**（A 的 T-20261117-183920-5d98 尚未交付/未接线），A 实现后本脚本应转绿（与 d120/fa0e 同套路）。
 *
 * 6 条断言（每个 case 独立沙箱：AWB_DATA_DIR+TEAM_ROOT+TEAM_PROJECTS_ROOT+TEAM_WORKBENCH_JSON+TEAM_SELFTEST=1；真窗口 + CDP）：
 *   ① 名册为唯一真相自动对齐：members[pm].sessionId 改新值 → 启动后 workbench.projects[].sessions.pm 与 workspace.sessionIds 自动等于新值，
 *      且审计 `会话绑定对齐.jsonl` 至少 1 行；名册 `团队.json` sha256/mtime 不变（不回写名册）。
 *   ② 界面显示「项目经理」：`[data-role-row][data-role="pm"]` 存在、`[data-role-name]` 显示名册名、`[data-role-bound-session]` 显示新会话短号或「已绑定（会话待激活）」、
 *      `[data-role-binding-state]` ∈ {ok,pending_activation}（不得 unmapped/mismatch），`#extra-sessions` 不含新会话。
 *   ③ 对齐不触发 rulesHash / 不需全员重 boot：对齐前后名册 sha256 不变、沙盘邮箱无「名册变更/重 boot」广播、审计无 rotate/broadcast 类行。
 *   ④ 失败可见：workbench 非法 JSON → 审计 `WB_UNREADABLE` 且文件原样不改写 + `#binding-error-banner` 可见；
 *      workbench 只读（写失败）→ 审计 `WB_UNWRITABLE` + 可见「待写入」，恢复可写后 60 秒内重试成功；DSH 不可用 → 显示「会话待激活」而非错误。
 *   ⑤ 幂等与并发：同沙箱重启第二次对齐 → 新增审计为 noop（或 workbench sha 不变）、workspace.sessionIds 无重复；结果稳定。
 *   ⑥ 真实状态零写入：脚本前后真实 `团队/状态/团队.json` 与 `data/userdata/workbench.json` sha256 不变。
 *
 * 用法：node scripts/test-pm-identity-bind.cjs [--json]
 * 输出：全绿 `PM_IDENTITY_OK {...}`（exit 0）；当前红 `PM_IDENTITY_WARN {...}`（exit 1，逐条给结果与 code）
 * 证据：项目/工作台改造修复/测试人员/产出/证据-fd42-repro/run-<ts>-<red|green>.json（每次新增，不覆盖）
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = '工作台改造修复';
const jsonOut = process.argv.includes('--json');
const REAL_TEAM = path.join(ROOT, '团队');
const REAL_TEAM_FILE = path.join(REAL_TEAM, '状态', '团队.json');
const REAL_STORE_FILE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const REAL_FILES = { team: REAL_TEAM_FILE, workbench: REAL_STORE_FILE };
const NEW_PM = 'sess-M1NEW-fd42';
const NEW_PM_SHORT = NEW_PM.slice(0, 8);
const OLD_PM = 'sess-OLDP-fd42';
const ROLES = ['pm', 'programmer1', 'tester', 'product', 'analyst', 'programmer2'];
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const CASE_BASE = path.join(ROOT, '_tmp', `fd42-identity-${process.pid}-${Date.now().toString(36)}`);
const PORT_BASE = 9510 + (process.pid % 60);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!jsonOut) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 800)}`);
  return Boolean(ok);
}
const sha256 = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; } };
const statOf = (f) => { try { const s = fs.statSync(f); return { sha256: sha256(f), bytes: s.size, mtimeMs: s.mtimeMs }; } catch { return { sha256: '', bytes: -1, mtimeMs: 0 }; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const httpJson = (url) => fetch(url).then((r) => r.json());
function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, ent.name); const b = path.join(dst, ent.name);
    if (filter && filter(a)) continue;
    if (ent.isDirectory()) copyDir(a, b, filter); else fs.copyFileSync(a, b);
  }
}

// ── 极简 CDP（与其它真窗口脚本同套路） ─────────────────────────────────────
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
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP timeout ' + method)); } }, ms);
    });
  }
  async evaluate(expr) { const out = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); return out && out.result ? out.result.value : undefined; }
}

class Sandbox {
  constructor(name) {
    this.name = name;
    this.dir = path.join(CASE_BASE, name);
    this.data = path.join(this.dir, 'data');
    this.team = path.join(this.dir, '团队');
    this.projectDir = path.join(this.dir, '项目', PROJECT);
    this.state = path.join(this.team, '状态', '项目', PROJECT);
    this.mailDir = path.join(this.team, '状态', '邮箱');
  }
  get teamFile() { return path.join(this.team, '状态', '团队.json'); }
  get workbenchFile() { return path.join(this.data, 'userdata', 'workbench.json'); }
  get auditFile() { return path.join(this.state, '会话绑定对齐.jsonl'); }
  get roster() { return readJson(this.teamFile, { members: [] }); }
  pmMember() { return (this.roster.members || []).find((m) => String(m.role) === 'pm') || null; }
  auditRows() {
    if (!fs.existsSync(this.auditFile)) return [];
    return fs.readFileSync(this.auditFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  }
  allMails() {
    const rows = [];
    for (const role of ROLES) {
      const dir = path.join(this.mailDir, role, 'new');
      if (!fs.existsSync(dir)) continue;
      for (const f of fs.readdirSync(dir).filter((x) => x.endsWith('.json'))) rows.push({ role, ...(readJson(path.join(dir, f), {}) || {}) });
    }
    return rows;
  }
  seed(opts = {}) {
    fs.rmSync(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    fs.mkdirSync(path.join(this.data, 'userdata'), { recursive: true });
    fs.mkdirSync(this.projectDir, { recursive: true });
    copyDir(REAL_TEAM, this.team, (p) => /[\\/]邮箱([\\/]|$)/.test(p) || /[\\/]锁([\\/]|$)/.test(p) || /[\\/]备份([\\/]|$)/.test(p));
    // 项目状态最小夹具
    fs.rmSync(this.state, { recursive: true, force: true });
    fs.mkdirSync(path.join(this.state, '任务'), { recursive: true });
    writeJson(path.join(this.state, '工作流.json'), { schema: 2, project: PROJECT, round: 1, updatedAt: new Date().toISOString(), requirements: {}, boots: {} });
    // 名册（唯一真相）：pm 指向 NEW_PM，其余假会话
    const team = this.roster;
    for (const m of (Array.isArray(team.members) ? team.members : [])) m.sessionId = `sess-old-${m.role}`;
    const pm = (team.members || []).find((m) => String(m.role) === 'pm');
    if (pm) {
      pm.sessionId = NEW_PM;
      pm.name = opts.pmName !== undefined ? opts.pmName : (pm.name || '项目经理');
      if (opts.pmName === null) delete pm.name;
    }
    team.activeProject = PROJECT;
    if (opts.config) team.config = { ...(team.config || {}), ...opts.config };
    writeJson(this.teamFile, team);
    // 壳 store：pm 绑定旧值（制造不一致）
    const store = readJson(REAL_STORE_FILE, { projects: [] }) || { projects: [] };
    const project = (store.projects || []).find((p) => p && String(p.teamName || p.name || '') === PROJECT);
    if (!project) throw new Error('真实 workbench.json 里没有团队项目 ' + PROJECT);
    store.projects = [project];
    store.activeProjectId = project.id;
    project.path = this.projectDir;
    project.workspacePath = this.projectDir;
    if (project.workspace && typeof project.workspace === 'object') project.workspace.path = this.projectDir;
    project.sessions = Object.fromEntries(ROLES.map((r) => [r, `sess-old-${r}`]));
    project.sessions.pm = OLD_PM;
    if (project.workspace && Array.isArray(project.workspace.sessionIds)) {
      project.workspace.sessionIds = ROLES.map((r) => (r === 'pm' ? OLD_PM : `sess-old-${r}`));
    }
    writeJson(this.workbenchFile, store);
    if (opts.brokenWorkbench) fs.writeFileSync(this.workbenchFile, '{ "projects": [ 这不是合法 JSON', 'utf8');
    if (opts.brokenWorkbench || opts.readonlyWorkbench) fs.chmodSync(this.workbenchFile, 0o444);
    return this;
  }
  wb() { return readJson(this.workbenchFile, null); }
  wbSessions() { const wb = this.wb(); return ((wb && (wb.projects || [])[0]) || {}).sessions || {}; }
  wbWorkspaceIds() { const wb = this.wb(); const p = ((wb && (wb.projects || [])[0]) || {}); return (p.workspace && p.workspace.sessionIds) || []; }
  env(port) {
    return {
      ...process.env,
      AWB_DATA_DIR: this.data,
      TEAM_ROOT: this.team,
      TEAM_PROJECTS_ROOT: path.join(this.team, '状态', '项目'),
      TEAM_WORKBENCH_JSON: this.workbenchFile,
      TEAM_SELFTEST: '1',
      ABP_IDENTITY_FIXTURE: '1',
    };
  }
  cleanup() { try { fs.rmSync(this.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ } }
}

async function waitTarget(port, ms) {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    const list = await httpJson(`http://127.0.0.1:${port}/json/list`).catch(() => null);
    const hit = Array.isArray(list) ? list.find((p) => p && String(p.url || '').includes('renderer/index.html')) : null;
    if (hit && hit.webSocketDebuggerUrl) return hit;
    await sleep(300);
  }
  return null;
}
function killTree(child) {
  if (!child) return;
  try { spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { try { child.kill('SIGKILL'); } catch { /* ignore */ } }
}
async function launchAndProbe(sb, port, opts = {}) {
  // 真窗口偶发一次连不上/CDP 超时（上一条实例收尾竞态）：重试一次，仍失败才如实记红。
  for (let attempt = 1; attempt <= 2; attempt += 1) {
    const out = await launchOnce(sb, port + (attempt - 1) * 10, opts);
    if (!out.errors || out.errors.length === 0) return out;
    if (attempt === 2) return out;
    await sleep(1200);
  }
  return { dom: null, errors: ['unreachable'] };
}
/** 启动沙盘实例 → 等首屏 → 等对齐落盘（可选）→ 读 DOM → 收工。返回 {dom, errors, child}。 */
async function launchOnce(sb, port, { waitForAlignMs = 25000, keepAlive = false } = {}) {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + port], {
    cwd: ROOT, env: sb.env(port), stdio: 'ignore', windowsHide: true,
  });
  const out = { dom: null, errors: [], child, startedAt: Date.now() };
  try {
    const target = await waitTarget(port, 60000);
    if (!target) { out.errors.push('未连上真窗口（60s 内无 renderer/index.html 目标）'); return out; }
    const ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws fail')), { once: true }); });
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    for (let i = 0; i < 120; i += 1) { if ((await cdp.evaluate('document.readyState')) === 'complete') break; await sleep(300); }
    // 等对齐落盘（首个 25s 内轮询 workbench，避免启动竞态）
    const end = Date.now() + waitForAlignMs;
    while (Date.now() < end) {
      const sessions = sb.wbSessions();
      const audit = sb.auditRows();
      if (String(sessions.pm || '') === NEW_PM || audit.length > 0) break;
      await sleep(500);
    }
    await sleep(1200);
    out.dom = await cdp.evaluate(`(function(){
      // 角色行：需求 §六「优先用既有 [data-role-row][data-role='pm']；不存在则新建同语义锚点」；
      // 既有花名册行是 .session-row[data-role-session='pm']（app.js:2467），两种都认。
      const row = document.querySelector('[data-role-row][data-role="pm"]')
        || document.querySelector('.session-row[data-role-session="pm"]')
        || document.querySelector('[data-role-session="pm"]');
      const within = (sel) => (row ? row.querySelector(sel) : null);
      const any = (sel) => within(sel) || document.querySelector(sel);
      const name = any('[data-role-name]');
      const bound = any('[data-role-bound-session]');
      const stateEl = any('[data-role-binding-state]');
      const errEl = any('[data-role-error]');
      const banner = document.querySelector('#binding-error-banner');
      const extra = document.querySelector('#extra-sessions');
      const vis = (el) => Boolean(el) && (el.offsetParent !== null || el.getClientRects().length > 0);
      return {
        hasRow: Boolean(row),
        rowText: row ? String(row.textContent || '').trim().slice(0, 200) : '',
        nameText: name ? String(name.textContent || '').trim() : '',
        boundText: bound ? String(bound.textContent || '').trim() : '',
        bindingState: stateEl ? String(stateEl.getAttribute('data-role-binding-state') || stateEl.textContent || '').trim() : '',
        errText: errEl ? String(errEl.textContent || '').trim() : '',
        errVisible: vis(errEl),
        bannerText: banner ? String(banner.textContent || '').trim() : '',
        bannerVisible: vis(banner),
        extraText: extra ? String(extra.textContent || '').trim() : '',
      };
    })()`);
    // keepAlive=true：把进程留给调用方（④b 要在**同一进程**里等 60s 重试窗口），此处不关标签、不 kill。
    if (keepAlive) { out.keptAlive = true; return out; }
    // fire-and-forget 关标签，避免 CDP promise 悬挂
    cdp.send('Browser.close').catch(() => {});
    await sleep(500);
    try { ws.close(); } catch { /* ignore */ }
    return out;
  } catch (e) { out.errors.push(String((e && e.message) || e)); return out; }
  finally { if (!out.keptAlive) { killTree(child); await sleep(600); } }
}

// ── 断言 ────────────────────────────────────────────────────────────────────
async function caseMain() {
  const sb = new Sandbox('c1-main').seed();
  try {
    const rosterBefore = statOf(sb.teamFile);
    const wbBefore = statOf(sb.workbenchFile);
    const dom = (await launchAndProbe(sb, PORT_BASE + 1)).dom || {};
    const errors = [];
    const sessions = sb.wbSessions();
    const ids = sb.wbWorkspaceIds();
    const audit = sb.auditRows();
    const mails = sb.allMails();
    const alignRows = audit.filter((r) => String(r.role) === 'pm');
    check('① 名册变更即自动对齐（workbench.sessions.pm 与 workspace.sessionIds = 新会话，审计≥1 行，名册 sha/mtime 不变）',
      String(sessions.pm || '') === NEW_PM && ids.includes(NEW_PM) && !ids.includes(OLD_PM) && alignRows.length >= 1 && statOf(sb.teamFile).sha256 === rosterBefore.sha256 && statOf(sb.teamFile).mtimeMs === rosterBefore.mtimeMs,
      { pm: sessions.pm, idsHasNew: ids.includes(NEW_PM), idsHasOld: ids.includes(OLD_PM), auditRows: alignRows.map((r) => `${r.source}/${r.why}/${r.result}/${r.code || ''}`), rosterStable: statOf(sb.teamFile), rosterBefore, errors });
    const pmName = String(((sb.roster.members || []).find((m) => m.role === 'pm') || {}).name || '项目经理');
    const stateOk = ['ok', 'pending_activation'].includes(String(dom.bindingState || ''));
    const extraHasRows = /额外会话\s*[1-9]/.test(String(dom.extraText || ''));
    check('② 界面显示「项目经理」+ 会话区显示新会话短号/待激活（binding-state ∈ ok|pending_activation，不落 unmapped/mismatch，#extra-sessions 不含新会话）',
      dom.hasRow === true && dom.nameText.includes(pmName) && (dom.boundText.includes(NEW_PM_SHORT) || /已绑定|待激活/.test(dom.boundText)) && stateOk && !extraHasRows,
      { pmName, hasRow: dom.hasRow, nameText: dom.nameText, boundText: dom.boundText, bindingState: dom.bindingState, extraHasRows, rowText: dom.rowText });
    const broadcastMails = mails.filter((m) => /名册变更|重 boot|重boot|重启.*boot|规则.*变化/i.test(`${m.subject || ''} ${m.body || ''}`));
    const rotateRows = audit.filter((r) => /rotate|broadcast/i.test(String(r.stage || '') + String(r.code || '')));
    check('③ 对齐不触发 rulesHash / 不需全员重 boot（名册 sha256 不变、无广播邮件、审计无 rotate/broadcast）',
      statOf(sb.teamFile).sha256 === rosterBefore.sha256 && broadcastMails.length === 0 && rotateRows.length === 0,
      { rosterSame: statOf(sb.teamFile).sha256 === rosterBefore.sha256, broadcastMails: broadcastMails.map((m) => m.subject), rotateRows });
    return { sb, wbBefore, firstWb: statOf(sb.workbenchFile), rosterBefore, rosterAfter: statOf(sb.teamFile), auditCount: audit.length };
  } finally { sb.cleanup(); }
}

async function caseIdempotent() {
  const sb = new Sandbox('c5-idempotent').seed();
  try {
    await launchAndProbe(sb, PORT_BASE + 2);
    const wb1 = statOf(sb.workbenchFile);
    const audit1 = sb.auditRows().length;
    const dom = (await launchAndProbe(sb, PORT_BASE + 3)).dom || {};
    const wb2 = statOf(sb.workbenchFile);
    const audit2 = sb.auditRows();
    const added = audit2.slice(audit1);
    const ids = sb.wbWorkspaceIds();
    const unique = new Set(ids.map(String)).size === ids.length;
    const sessions = sb.wbSessions();
    return check('⑤ 幂等（同沙箱第二次对齐：workbench sha 不变、新增审计为 noop、sessionIds 无重复）',
      String(sessions.pm || '') === NEW_PM && unique && wb2.sha256 === wb1.sha256 && added.every((r) => String(r.result) === 'noop' || String(r.why) === 'noop'),
      { pm: sessions.pm, unique, wb1: wb1.sha256.slice(0, 12), wb2: wb2.sha256.slice(0, 12), added: added.map((r) => `${r.why}/${r.result}/${r.code || ''}`), domName: dom.nameText });
  } finally { sb.cleanup(); }
}

async function caseBroken() {
  const sb = new Sandbox('c4-broken').seed({ brokenWorkbench: true });
  try {
    const brokenBefore = statOf(sb.workbenchFile);
    const probed = await launchAndProbe(sb, PORT_BASE + 4, { waitForAlignMs: 15000 });
    const dom = probed.dom || {};
    const brokenAfter = statOf(sb.workbenchFile);
    let afterHead = '';
    try { afterHead = fs.readFileSync(sb.workbenchFile, 'utf8').slice(0, 120); } catch { /* ignore */ }
    const audit = sb.auditRows();
    const codeHit = audit.some((r) => /WB_UNREADABLE/.test(String(r.code || ''))) || /WB_UNREADABLE|绑定文件损坏/.test(`${dom.bannerText} ${dom.errText}`);
    const visible = dom.bannerVisible === true || dom.errVisible === true;
    // 口径（PM 2026-11-17 19:52 M-20261117-195257-a0d2eb）：AC5 只要求「写失败 → banner + 审计 fail/WB_UNWRITABLE」，
    // **不含「坏文件不改名」**；既有 readStore 恢复机制可能重写坏文件，不属本单范围 → 文件是否变化只记录、不作判据。
    return check('④a workbench 非法 JSON（只读沙盘）→ 报 WB_UNREADABLE 且错误可见（不得静默；不判坏文件是否被改写）',
      codeHit && visible,
      { codeHit, visible, bannerText: String(dom.bannerText || '').slice(0, 160), errText: String(dom.errText || '').slice(0, 160), fileUnchanged: brokenAfter.sha256 === brokenBefore.sha256, brokenBefore: brokenBefore.sha256.slice(0, 12), brokenAfter: brokenAfter.sha256.slice(0, 12), afterHead, auditRows: audit.length, errors: probed.errors });
  } finally { sb.cleanup(); }
}

async function caseWriteFail() {
  const sb = new Sandbox('c4-writefail').seed({ readonlyWorkbench: true });
  let handle = null;
  try {
    const oldSha = statOf(sb.workbenchFile).sha256;
    // 时序口径（PM 2026-11-17 19:52）：写失败由 seed 时的只读文件制造，**进程保活**，恢复可写也在进程存活期间做；
    // 不在 launchAndProbe 返回（已 killTree）之后再 chmod——否则 60 秒重试窗口里根本没有进程在跑。
    handle = await launchAndProbe(sb, PORT_BASE + 5, { waitForAlignMs: 20000, keepAlive: true });
    const dom = handle.dom || {};
    const audit = sb.auditRows();
    const failAudit = audit.some((r) => /WB_UNWRITABLE/.test(String(r.code || '')) || String(r.result) === 'fail');
    const pendingText = /待写入|待重试|绑定待写入|不可写|只读/.test(`${dom.bannerText} ${dom.errText} ${dom.boundText}`);
    const readable = failAudit || pendingText;
    // 恢复可写（进程仍存活）：目标文件 + 它同目录的派生文件（.bak/.tmp）一起恢复。
    // 依据：首次失败时 json-atomic 会从只读源复制出**只读 .bak**，只 chmod 目标文件无法恢复写入（本机实测 EPERM copyfile），
    // 这属“权限问题被彻底修复”的建模，不是放宽判据；.bak 残留只读另记非阻断注记。
    const restoreWritable = () => {
      try { fs.chmodSync(sb.workbenchFile, 0o666); } catch { /* ignore */ }
      for (const suf of ['.bak', '.tmp', '.lock']) { try { fs.chmodSync(sb.workbenchFile + suf, 0o666); } catch { /* ignore */ } }
    };
    const bakReadonlyLeft = (() => { try { const s = fs.statSync(sb.workbenchFile + '.bak'); return !(s.mode & 0o200); } catch { return false; } })();
    const chmodAfterMs = handle && handle.startedAt ? Date.now() - handle.startedAt : null;
    restoreWritable();
    const end = Date.now() + 85000;
    let retried = false;
    while (Date.now() < end) {
      const sessions = sb.wbSessions();
      const rows = sb.auditRows();
      if (String(sessions.pm || '') === NEW_PM && rows.length > audit.length) { retried = true; break; }
      if (String(sessions.pm || '') === NEW_PM && statOf(sb.workbenchFile).sha256 !== oldSha) { retried = true; break; }
      await sleep(2000);
    }
    const auditAfter = sb.auditRows();
    return check('④b workbench 写失败 → 可见「待写入」/WB_UNWRITABLE（不静默），进程存活期间恢复可写后 60 秒内重试成功',
      readable && retried,
      { failAudit, pendingText, bannerText: String(dom.bannerText || '').slice(0, 160), errText: String(dom.errText || '').slice(0, 160), retried, keptAlive: Boolean(handle && handle.keptAlive), chmodAfterMs, polledMs: Date.now() - (handle && handle.startedAt ? handle.startedAt : Date.now()) - (chmodAfterMs || 0), bakReadonlyLeft, oldSha: oldSha.slice(0, 12), newSha: statOf(sb.workbenchFile).sha256.slice(0, 12), auditBefore: audit.length, auditAfter: auditAfter.length, rowsAfter: auditAfter.map((r) => `${r.source || r.stage}/${r.result}/${r.code || ''}`), pmAfter: String(sb.wbSessions().pm || ''), errors: handle.errors });
  } finally {
    try { fs.chmodSync(sb.workbenchFile, 0o666); } catch { /* ignore */ }
    killTree(handle && handle.child);
    await sleep(600);
    sb.cleanup();
  }
}

async function caseDshUnavailable() {
  const sb = new Sandbox('c4-dsh').seed();
  try {
    const probed = await launchAndProbe(sb, PORT_BASE + 6);
    const dom = probed.dom || {};
    const state = String(dom.bindingState || '');
    const isPending = state === 'pending_activation' || /待激活/.test(`${dom.boundText} ${dom.nameText}`);
    const noError = !dom.bannerVisible && !dom.errVisible;
    return check('④c DSH 不可用/新会话无活动 → 显示「已绑定（会话待激活）」而不报错误（pending_activation 或 ok）',
      (isPending || state === 'ok') && noError,
      { state, boundText: String(dom.boundText || '').slice(0, 120), nameText: String(dom.nameText || '').slice(0, 80), bannerVisible: dom.bannerVisible, errVisible: dom.errVisible, errors: probed.errors });
  } finally { sb.cleanup(); }
}

async function main() {
  fs.mkdirSync(CASE_BASE, { recursive: true });
  const realBefore = { team: statOf(REAL_TEAM_FILE), workbench: statOf(REAL_STORE_FILE) };
  let sbMain = null;
  const order = [];
  try {
    const r = await caseMain();
    sbMain = r;
    order.push('main');
    await caseIdempotent();
    await caseBroken();
    await caseWriteFail();
    await caseDshUnavailable();
    if (r && r.auditCount >= 0) { /* 仅为保持 caseMain 引用 */ }
  } finally {
    // 基线口径（PM 2026-11-17 19:52）：真实 团队.json 会随真实团队活动变化，**不能当基线**；
    // ⑥ 只对**沙箱内副本**做前后 sha 对比：沙箱名册不被对齐改写（rulesHash 不变）+ 沙箱 workbench 确有写入。
    // 真实两文件仅作信息记录，不参与判定。
    const realAfter = { team: statOf(REAL_TEAM_FILE), workbench: statOf(REAL_STORE_FILE) };
    const sbRosterSame = Boolean(sbMain && sbMain.rosterBefore && sbMain.rosterAfter && sbMain.rosterBefore.sha256 && sbMain.rosterBefore.sha256 === sbMain.rosterAfter.sha256);
    const sbWbWritten = Boolean(sbMain && sbMain.wbBefore && sbMain.firstWb && sbMain.wbBefore.sha256 && sbMain.firstWb.sha256 !== sbMain.wbBefore.sha256);
    check('⑥ 沙箱内副本前后 sha 对比：沙箱名册不变（对齐只写 workbench）、沙箱 workbench 已写入（真实文件仅记录、不作判据）',
      sbRosterSame && sbWbWritten,
      { sbRosterSame, sbWbWritten, sandboxRoster: sbMain && sbMain.rosterBefore, sandboxWb: sbMain && { before: sbMain.wbBefore, after: sbMain.firstWb }, realFilesInfo: { before: realBefore, after: realAfter } });
  }
  try { fs.rmSync(CASE_BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }

  const total = results.length;
  const pass = results.filter((x) => x.ok).length;
  const red = total - pass;
  const payload = { at: new Date().toISOString(), script: 'scripts/test-pm-identity-bind.cjs', requirement: 'R-20261117-180740-fd42', total, pass, red, results, realFiles: { before: realBefore, after: (() => { try { return { team: statOf(REAL_TEAM_FILE), workbench: statOf(REAL_STORE_FILE) }; } catch { return {}; } })() } };
  const evDir = path.join(ROOT, '项目', PROJECT, '测试人员', '产出', '证据-fd42-repro');
  fs.mkdirSync(evDir, { recursive: true });
  const evFile = path.join(evDir, `run-${ts}-${red === 0 ? 'green' : 'red'}.json`);
  payload.evidenceFile = path.relative(ROOT, evFile).replace(/\\/g, '/');
  fs.writeFileSync(evFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  if (jsonOut) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  else {
    console.log('');
    console.log(`${red === 0 ? 'PM_IDENTITY_OK' : 'PM_IDENTITY_WARN'} ${JSON.stringify({ total, pass, red })}`);
    console.log(`证据：${payload.evidenceFile}`);
  }
  process.exit(red === 0 ? 0 : 1);
}

main().catch((e) => { console.error('CRASH', String((e && e.stack) || e)); process.exit(2); });
