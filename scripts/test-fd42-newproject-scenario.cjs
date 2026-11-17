#!/usr/bin/env node
/**
 * T-20261117-205143-ac5a（P1，测试）：fd42 场景级复验 —— 沙盘「新建项目」→ 换 PM 会话 → 不刷新不重启 → 自动对齐 + boot 成功
 *
 * Owner 2026-11-17 20:52 要求（比现有 E2E 更严格）：
 *   ①沙盘**新建项目**（project add scaffold，不是复制现有项目）→ 建 full 团队；
 *   ②改沙盘名册 members[pm].sessionId 模拟换人（不改 workbench）；
 *   ③**不刷新页面、不重启进程**，等 ≤65 秒，断言自动对齐；
 *   ④界面显示新会话短号或「已绑定（会话待激活）」，binding-state ∈ {ok,pending_activation}，不得 unmapped；
 *   ⑤新名册 boot 后 send / task list 可用（无 RULES_CHANGED / ROLE_NOT_BOUND）；
 *   ⑥真实状态零写入；⑦时间戳表 + 截图。
 *
 * 隔离：AWB_DATA_DIR + TEAM_ROOT + TEAM_PROJECTS_ROOT + TEAM_WORKBENCH_JSON + TEAM_SELFTEST=1（四变量 + 自检位）
 * 用法：node scripts/test-fd42-newproject-scenario.cjs [--json]
 * 输出：全绿 SCENARIO_OK {...}（exit 0）；有红 SCENARIO_WARN {...}（exit 1）
 * 证据：项目/工作台改造修复/测试人员/产出/证据-fd42-newproj/run-<ts>-<green|red>.json + 截图 png
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJECT_HINT = '工作台改造修复';
const jsonOut = process.argv.includes('--json');
const REAL_TEAM = path.join(ROOT, '团队');
const REAL_TEAM_FILE = path.join(REAL_TEAM, '状态', '团队.json');
const REAL_STORE_FILE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const TEAM_MJS = path.join(ROOT, '团队', '工具', 'team.mjs');

const ROLES = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
const NEWPROJ = 'fd42-新项目场景';
const NEW_PM = 'sess-NEWPM-ac5a';
const OLD_PM = 'sess-OLDPM-ac5a';
const WAIT_MAX_MS = 65000;
const SAMPLE_MS = 5000;
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const SANDBOX = path.join(ROOT, '_tmp', `fd42-newproj-${process.pid}-${Date.now().toString(36)}`);
// B-20261117-140928-b51b：沙盘退出自动清理（证据写在 项目/.../证据-fd42-newproj，不依赖沙盘保留）。
const { rmSandbox: rmFd42Sandbox } = require('./lib/sandbox-dir.cjs');
if (String(process.env.AWB_KEEP_SANDBOX || '') === '1') console.log('[b51b] 保留沙盘：' + SANDBOX);
else process.on('exit', () => { try { rmFd42Sandbox(SANDBOX); } catch { /* 清理失败不改变断言结论 */ } });
const PORT = 9610 + (process.pid % 60);

const results = [];
const timeline = [];
const now = () => new Date().toISOString();
function mark(what) { timeline.push({ at: now(), what }); return Date.now(); }
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!jsonOut) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 900)}`);
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

// ── 极简 CDP ────────────────────────────────────────────────────────────────
class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      let m; try { m = JSON.parse(String(e.data)); } catch { return; }
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      }
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

const SB = {
  dir: SANDBOX,
  data: path.join(SANDBOX, 'data'),
  team: path.join(SANDBOX, '团队'),
  projectsRoot: path.join(SANDBOX, '项目'),
  get teamFile() { return path.join(this.team, '状态', '团队.json'); },
  get workbenchFile() { return path.join(this.data, 'userdata', 'workbench.json'); },
  get projectDir() { return path.join(this.projectsRoot, NEWPROJ); },
  get stateDir() { return path.join(this.team, '状态', '项目', NEWPROJ); },
};
function envSb(extra = {}) {
  return {
    ...process.env,
    AWB_DATA_DIR: SB.data,
    TEAM_ROOT: SB.team,
    TEAM_PROJECTS_ROOT: SB.projectsRoot,
    TEAM_WORKBENCH_JSON: SB.workbenchFile,
    TEAM_SELFTEST: '1',
    // B-7b01 起 boot 校验「名册会话必须存在于 DSH 列表」；沙盘用官方注入口给**显式假会话 id**
    // （只列本场景真实会用到的那几个 id，避免"校验被放过"的假成功），并断掉真实 DSH 连接。
    DSH_WEB_URL: '',
    TEAM_DSH_FAKE: JSON.stringify([
      { sessionId: String(OLD_PM || 'sess-OLDPM-ac5a') },
      { sessionId: String(NEW_PM || 'sess-NEWPM-ac5a') },
      ...ROLES.map((r) => ({ sessionId: `sess-old-${r}` })),
    ]),
    ...extra,
  };
}
function runTeam(args, extra = {}) {
  const r = spawnSync(process.execPath, [TEAM_MJS, ...args], { cwd: ROOT, env: envSb(extra), encoding: 'utf8', timeout: 120000 });
  return { code: r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

function wbPm() {
  const wb = readJson(SB.workbenchFile, null);
  const p = (wb && (wb.projects || [])[0]) || {};
  return String((p.sessions || {}).pm || '');
}
function wbSessionIds() {
  const wb = readJson(SB.workbenchFile, null);
  const p = (wb && (wb.projects || [])[0]) || {};
  return ((p.workspace || {}).sessionIds) || [];
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

const DOM_PROBE = `(function(){
  const row = document.querySelector('[data-role-row][data-role="pm"]')
    || document.querySelector('.session-row[data-role-session="pm"]')
    || document.querySelector('[data-role-session="pm"]');
  const within = (sel) => (row ? row.querySelector(sel) : null);
  const any = (sel) => within(sel) || document.querySelector(sel);
  const bound = any('[data-role-bound-session]');
  const stateEl = any('[data-role-binding-state]');
  const errEl = any('[data-role-error]');
  const banner = document.querySelector('#binding-error-banner');
  const extra = document.querySelector('#extra-sessions');
  const vis = (el) => Boolean(el) && (el.offsetParent !== null || el.getClientRects().length > 0);
  return {
    hasRow: Boolean(row),
    rowText: row ? String(row.textContent || '').trim().slice(0, 200) : '',
    nameText: (() => { const n = any('[data-role-name]'); return n ? String(n.textContent || '').trim() : ''; })(),
    boundText: bound ? String(bound.textContent || '').trim() : '',
    bindingState: stateEl ? String(stateEl.getAttribute('data-role-binding-state') || stateEl.textContent || '').trim() : '',
    errText: errEl ? String(errEl.textContent || '').trim() : '',
    errVisible: vis(errEl),
    bannerText: banner ? String(banner.textContent || '').trim() : '',
    bannerVisible: vis(banner),
    extraText: extra ? String(extra.textContent || '').trim() : '',
  };
})()`;

async function main() {
  const realBefore = { team: statOf(REAL_TEAM_FILE), workbench: statOf(REAL_STORE_FILE) };
  const t0 = mark('开始');
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(path.join(SB.data, 'userdata'), { recursive: true });
  fs.mkdirSync(SB.projectsRoot, { recursive: true });
  // 团队登记册骨架（只复制登记册，不复制任何项目目录）；sessionId 全清（沙盘防污染）
  // 只复制团队级登记册/规则/模板；**排除 状态/项目（不在沙盘里带任何既有项目）**、邮箱、锁、备份
  copyDir(REAL_TEAM, SB.team, (p) => /[\\/]邮箱([\\/]|$)/.test(p) || /[\\/]锁([\\/]|$)/.test(p) || /[\\/]备份([\\/]|$)/.test(p) || /[\\/]状态[\\/]项目([\\/]|$)/.test(p));
  fs.mkdirSync(path.join(SB.team, '状态', '项目'), { recursive: true });
  const roster0 = readJson(SB.teamFile, { members: [] });
  for (const m of (Array.isArray(roster0.members) ? roster0.members : [])) m.sessionId = `sess-old-${m.role}`;
  const pm0 = (roster0.members || []).find((m) => String(m.role) === 'pm');
  if (pm0) pm0.sessionId = OLD_PM;
  roster0.activeProject = NEWPROJ;
  // 沙盘团队只保留空项目表（新建项目由 project add 自己登记）
  roster0.projects = [];
  writeJson(SB.teamFile, roster0);

  // ── ① 沙盘新建项目（project add scaffold，不是复制现有项目） ──────────────
  const tCreate = mark('project add 开始');
  const add = runTeam(['project', 'add', '--name', NEWPROJ, '--team-mode', 'full', '--by', 'owner']);
  const projJson = readJson(path.join(SB.stateDir, '项目.json'), null);
  const listOut = runTeam(['project', 'list']).out;
  const hasRoleDirs = ROLES.every((r) => {
    const map = { pm: '项目经理', product: '产品', analyst: '需求分析师', programmer1: '程序员A', programmer2: '程序员B', tester: '测试人员' };
    return fs.existsSync(path.join(SB.projectDir, map[r]));
  });
  const registered = listOut.includes(NEWPROJ) && Boolean(projJson);
  mark('project add 结束');
  check('① 沙盘新建项目（project add --team-mode full）成功：目录/项目.json/六角色目录齐、project list 可见',
    add.code === 0 && Boolean(projJson) && hasRoleDirs && registered,
    { code: add.code, out: add.out.slice(0, 300), err: add.err.slice(0, 300), hasProjectJson: Boolean(projJson), hasRoleDirs, registered, listOut: listOut.slice(0, 200) });

  // 新项目状态目录（工作流等）由 scaffold 建好；补最小工作流夹具，避免壳读空
  fs.mkdirSync(path.join(SB.stateDir, '任务'), { recursive: true });
  if (!fs.existsSync(path.join(SB.stateDir, '工作流.json'))) {
    writeJson(path.join(SB.stateDir, '工作流.json'), { schema: 2, project: NEWPROJ, round: 1, updatedAt: now(), requirements: {}, boots: {} });
  }

  // ── ② 沙盘壳 store：登记这个新项目，pm 绑定旧会话（制造不一致） ──────────────
  const realStore = readJson(REAL_STORE_FILE, { projects: [] }) || { projects: [] };
  const template = (realStore.projects || []).find((p) => p && String(p.teamName || p.name || '') === PROJECT_HINT) || (realStore.projects || [])[0] || {};
  const entry = {
    ...JSON.parse(JSON.stringify(template)),
    id: 'proj-' + crypto.createHash('sha1').update(NEWPROJ).digest('hex').slice(0, 12),
    name: NEWPROJ,
    teamName: NEWPROJ,
    desc: 'fd42 场景级复验：沙盘新建项目',
    path: SB.projectDir,
    workspacePath: SB.projectDir,
  };
  entry.sessions = Object.fromEntries(ROLES.map((r) => [r, r === 'pm' ? OLD_PM : `sess-old-${r}`]));
  entry.workspace = { ...(entry.workspace || {}), path: SB.projectDir, sessionIds: ROLES.map((r) => (r === 'pm' ? OLD_PM : `sess-old-${r}`)) };
  const store = { ...realStore, projects: [entry], activeProjectId: entry.id };
  writeJson(SB.workbenchFile, store);
  // 「建 full 团队」= 项目已被 launch 起过六角色会话：写出 <项目>/团队会话.json（真实流程由 launch.mjs 写）。
  // 这一步很关键：它让「换 PM 后四处映射是否仍一致」成为可观测的真实问题（团队.json / 团队会话.json / workbench）。
  const manifestFile = path.join(SB.projectDir, '团队会话.json');
  writeJson(manifestFile, {
    version: 1,
    project: NEWPROJ,
    workspacePath: SB.projectDir,
    createdAt: now(),
    roles: ROLES.map((r) => ({ role: r, name: r, sessionId: r === 'pm' ? OLD_PM : `sess-old-${r}` })),
  });
  check('② 沙盘 store 已登记新项目且 pm 绑定旧会话（对齐前不一致）',
    wbPm() === OLD_PM && Boolean(readJson(path.join(SB.stateDir, '项目.json'), null)),
    { pm: wbPm(), expect: OLD_PM });

  // ── ③ 起真窗口（不刷新、不重启，直到结束） ──────────────────────────────────
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], {
    cwd: ROOT, env: envSb(), stdio: 'ignore', windowsHide: true,
  });
  let ws = null; let cdp = null; let shot = '';
  try {
    const target = await waitTarget(PORT, 60000);
    if (!target) throw new Error('60s 内未连上真窗口（renderer/index.html）');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((res, rej) => { ws.addEventListener('open', res, { once: true }); ws.addEventListener('error', () => rej(new Error('ws fail')), { once: true }); });
    cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    for (let i = 0; i < 120; i += 1) { if ((await cdp.evaluate('document.readyState')) === 'complete') break; await sleep(300); }
    await sleep(1500);
    const domBefore = await cdp.evaluate(DOM_PROBE);
    timeline.push({ at: now(), what: '首屏就绪（未换人）', dom: { state: domBefore && domBefore.bindingState, bound: domBefore && domBefore.boundText } });
    check('③ 首屏可读且对齐前显示旧绑定（新项目在真窗口内正常渲染）',
      Boolean(domBefore && domBefore.hasRow), { dom: domBefore });

    // ── ④ 改沙盘名册 members[pm].sessionId 换人（不改 workbench），不刷新不重启 ──
    const roster = readJson(SB.teamFile, { members: [] });
    const pmM = (roster.members || []).find((m) => String(m.role) === 'pm');
    if (!pmM) throw new Error('沙盘名册缺 pm 成员');
    pmM.sessionId = NEW_PM;
    writeJson(SB.teamFile, roster);
    const tSwap = mark('改名册（换 PM）');
    const afterSwapPm = wbPm();
    check('④ 换人瞬间 workbench 仍是旧值（说明后面若变只能是自动对齐，不是我写进去的）',
      afterSwapPm === OLD_PM, { wbPm: afterSwapPm, expect: OLD_PM, newPm: NEW_PM });

    // ── ⑤ 等 ≤65 秒自动对齐，每 5 秒采样 ──────────────────────────────────
    let alignedAt = 0;
    const samples = [];
    while (Date.now() - tSwap <= WAIT_MAX_MS) {
      const cur = wbPm();
      samples.push({ at: now(), ms: Date.now() - tSwap, pm: cur });
      if (cur === NEW_PM) { alignedAt = Date.now(); break; }
      await sleep(SAMPLE_MS);
    }
    const delta = alignedAt ? alignedAt - tSwap : -1;
    mark('自动对齐' + (alignedAt ? `（${delta}ms）` : '（未发生）'));
    check(`⑤ 不刷新不重启，≤65s 内 workbench.sessions.pm 自动对齐为新会话`,
      Boolean(alignedAt) && delta <= WAIT_MAX_MS,
      { deltaMs: delta, samples, expect: NEW_PM });
    check('⑤b workspace.sessionIds 同步包含新会话、不含旧会话',
      wbSessionIds().includes(NEW_PM) && !wbSessionIds().includes(OLD_PM),
      { ids: wbSessionIds() });

    // ── ⑥ 界面显示（同一进程，未刷新）；允许短暂过渡：最多轮询 20s 等最终一致 ──────
    const newShort = NEW_PM.slice(0, 8);
    const judge = (d) => {
      const state = String((d && d.bindingState) || '');
      const bound = String((d && d.boundText) || '');
      const banner = String((d && d.bannerText) || '');
      const stateOk = ['ok', 'pending_activation'].includes(state);
      const showsNew = Boolean(newShort) && bound.includes(newShort);
      const showsPending = /已绑定|待激活/.test(bound);
      const notUnmapped = !/unmapped|mismatch/.test(state + String((d && d.rowText) || ''));
      const bannerMismatch = /映射不一致|能看不能发/.test(banner);
      const extraHasNew = Boolean(newShort) && String((d && d.extraText) || '').includes(newShort);
      return { stateOk, showsNew, showsPending, notUnmapped, bannerMismatch, extraHasNew, ok: stateOk && (showsNew || showsPending) && notUnmapped && !extraHasNew && !bannerMismatch };
    };
    const series = [];
    let domAfter = null; let verdict = null;
    for (let i = 0; i < 10; i += 1) {
      await sleep(2000);
      domAfter = await cdp.evaluate(DOM_PROBE);
      verdict = judge(domAfter);
      series.push({ ms: (i + 1) * 2000, state: String((domAfter && domAfter.bindingState) || ''), bound: String((domAfter && domAfter.boundText) || '').slice(0, 40), banner: /映射不一致|能看不能发/.test(String((domAfter && domAfter.bannerText) || '')), ok: verdict.ok });
      if (verdict.ok) break;
    }
    check('⑥ 界面最终显示新会话短号或已绑定（会话待激活），binding-state ∈ {ok,pending_activation}，非 unmapped，无「映射不一致」横幅，#extra-sessions 不含新会话（≤20s 内最终一致）',
      Boolean(domAfter && domAfter.hasRow) && verdict.ok,
      { dom: domAfter, series, expectState: 'ok|pending_activation', newShort });

    // ── ⑦ 截图 ────────────────────────────────────────────────────────────
    const evDir = path.join(ROOT, '项目', PROJECT_HINT, '测试人员', '产出', '证据-fd42-newproj');
    fs.mkdirSync(evDir, { recursive: true });
    try {
      await cdp.send('Page.enable').catch(() => {});
      // 已知坑：captureScreenshot 偶发超时（后台/重绘中）→ bringToFront + 最多 3 次重试
      let cap = null;
      for (let attempt = 1; attempt <= 3 && !cap; attempt += 1) {
        try {
          await cdp.send('Page.bringToFront').catch(() => {});
          await sleep(400);
          cap = await cdp.send('Page.captureScreenshot', { format: 'png' }, 20000);
        } catch (e) {
          timeline.push({ at: now(), what: `截图第 ${attempt} 次失败：${String((e && e.message) || e)}` });
          await sleep(800);
        }
      }
      if (cap && cap.data) {
        shot = path.join(evDir, `screenshot-${ts}.png`);
        fs.writeFileSync(shot, Buffer.from(cap.data, 'base64'));
      }
    } catch (e) { timeline.push({ at: now(), what: '截图失败：' + String((e && e.message) || e) }); }
    check('⑦ 截图已落盘', Boolean(shot) && fs.existsSync(shot), { shot });

    // ── ⑧ 新名册 boot 后 send / task list 可用 ─────────────────────────────
    const boot = runTeam(['boot', '--role', 'pm', '--project', NEWPROJ, '--session', NEW_PM, '--json']);
    const token = (() => {
      const m = /"?token"?\s*:\s*"([0-9a-f]+)"/.exec(boot.out) || /令牌[:：]\s*([0-9a-f]+)/.exec(boot.out);
      return m ? m[1] : '';
    })();
    // send 发给 tester（**不能发给自己**：send 对 self 明确 SELF_SEND 拒绝，那是正确行为，不是本单缺陷）
    const send = token ? runTeam(['send', '--role', 'pm', '--project', NEWPROJ, '--boot', token, '--to', 'tester', '--subject', '自检', '--body', 'ac5a 场景自检']) : { code: -1, out: '', err: 'NO_TOKEN' };
    // PM 口径补充：也要验 send --to pm 这条路径不得报 SESSION_MAP_INCONSISTENT（self 发送应被 SELF_SEND 明确拒绝，属正确行为）
    const sendSelf = token ? runTeam(['send', '--role', 'pm', '--project', NEWPROJ, '--boot', token, '--to', 'pm', '--subject', '自检-self', '--body', 'ac5a self 自检']) : { code: -1, out: '', err: 'NO_TOKEN' };
    const tl = token ? runTeam(['task', 'list', '--role', 'pm', '--project', NEWPROJ, '--boot', token]) : { code: -1, out: '', err: 'NO_TOKEN' };
    const bad = (r) => /RULES_CHANGED|ROLE_NOT_BOUND/.test(`${r.out} ${r.err}`);
    const manifestPm = (() => {
      try { const j = readJson(manifestFile, null) || {}; const row = (j.roles || []).find((x) => String(x.role) === 'pm') || {}; return String(row.sessionId || ''); } catch { return ''; }
    })();
    check('⑧ 新名册 boot 成功，且 send / task list 均可执行（无 RULES_CHANGED / ROLE_NOT_BOUND）',
      Boolean(token) && send.code === 0 && tl.code === 0 && !bad(send) && !bad(tl) && !bad(boot),
      { bootCode: boot.code, tokenLen: token.length, sendCode: send.code, taskCode: tl.code, manifestPm, wbPm: wbPm(), sendOut: send.out.slice(0, 200), sendErr: send.err.slice(0, 400), taskErr: tl.err.slice(0, 200) });
    check('⑧b 换人后项目清单 团队会话.json 的 pm 也已同步（四处映射：团队.json / 团队会话.json / workbench.sessions / workspace.sessionIds）',
      manifestPm === NEW_PM && wbPm() === NEW_PM,
      { manifestPm, wbPm: wbPm(), expect: NEW_PM, note: '团队会话.json 由 launch/session rotate 维护；壳自动对齐是否也写它直接影响 send 能否通过' });
    // ⑧c（PM 2026-11-17 21:27 补充要求）：只改 pm 行 + 其它角色行不变 + generatedAt/updatedAt 刷新
    const mAfter = readJson(manifestFile, null) || {};
    const rows = (mAfter.roles || []);
    const pmRow = rows.find((x) => String(x.role) === 'pm') || {};
    const othersUnchanged = rows.filter((x) => String(x.role) !== 'pm').every((x) => String(x.sessionId || '') === `sess-old-${x.role}`);
    const stamp = String(mAfter.generatedAt || mAfter.updatedAt || mAfter.at || '');
    const stampFresh = Boolean(stamp) && Date.parse(stamp) >= tSwap - 60000;
    check('⑧c 团队会话.json 只把 pm 行改成新会话、其它角色行不变，且 generatedAt/updatedAt 已刷新',
      String(pmRow.sessionId || '') === NEW_PM && othersUnchanged && stampFresh,
      { pm: String(pmRow.sessionId || ''), othersUnchanged, stamp, stampFresh, tSwap: new Date(tSwap).toISOString() });
    // ⑧d（PM 同一要求）：send --to pm 这条路径不得报 SESSION_MAP_INCONSISTENT（self 被 SELF_SEND 拒属正确行为）
    const selfMapErr = /SESSION_MAP_INCONSISTENT/.test(`${sendSelf.out} ${sendSelf.err}`);
    check('⑧d `send --to pm` 不再报 SESSION_MAP_INCONSISTENT（自恋发送按设计被 SELF_SEND 拒，属正确行为）',
      Boolean(token) && !selfMapErr,
      { token: Boolean(token), selfCode: sendSelf.code, selfErr: sendSelf.err.slice(0, 240), selfMapErr });

    mark('场景结束');
  } finally {
    try { if (ws) ws.close(); } catch { /* ignore */ }
    killTree(child);
    await sleep(500);
  }

  // ── ⑨ 真实状态零写入 ──────────────────────────────────────────────────
  const realAfter = { team: statOf(REAL_TEAM_FILE), workbench: statOf(REAL_STORE_FILE) };
  check('⑨ 真实 团队.json / workbench.json 前后 sha256 不变（沙盘全程零写入真实状态）',
    realBefore.team.sha256 === realAfter.team.sha256 && realBefore.workbench.sha256 === realAfter.workbench.sha256 && Boolean(realBefore.team.sha256),
    { before: realBefore, after: realAfter });

  return finish({ realBefore, realAfter, shot, timeline, durationMs: Date.now() - t0 });
}

function finish(extra) {
  const total = results.length;
  const pass = results.filter((r) => r.ok).length;
  const red = total - pass;
  const evDir = path.join(ROOT, '项目', PROJECT_HINT, '测试人员', '产出', '证据-fd42-newproj');
  fs.mkdirSync(evDir, { recursive: true });
  const payload = {
    at: now(), script: 'scripts/test-fd42-newproject-scenario.cjs', task: 'T-20261117-205143-ac5a',
    requirement: 'R-20261117-180740-fd42', project: NEWPROJ,
    oldPm: OLD_PM, newPm: NEW_PM, waitMaxMs: WAIT_MAX_MS,
    total, pass, red, results, timeline: extra.timeline, shot: extra.shot,
    realFiles: { before: extra.realBefore, after: extra.realAfter }, durationMs: extra.durationMs,
  };
  const evFile = path.join(evDir, `run-${ts}-${red === 0 ? 'green' : 'red'}.json`);
  payload.evidenceFile = path.relative(ROOT, evFile).replace(/\\/g, '/');
  fs.writeFileSync(evFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  // 时间戳表
  if (!jsonOut) {
    console.log('\n时间戳表：');
    for (const t of extra.timeline) console.log(`  ${t.at}  ${t.what}`);
    console.log('');
    console.log(`${red === 0 ? 'SCENARIO_OK' : 'SCENARIO_WARN'} ${JSON.stringify({ total, pass, red })}`);
    console.log(`证据：${payload.evidenceFile}`);
    if (extra.shot) console.log(`截图：${path.relative(ROOT, extra.shot).replace(/\\/g, '/')}`);
  } else {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  }
  process.exit(red === 0 ? 0 : 1);
}

main().catch((e) => { console.error('CRASH', String((e && e.stack) || e)); process.exit(2); });
