#!/usr/bin/env node
'use strict';
/**
 * test-accept-latency-ui.cjs —— B-20261118-211237-9ded 可复验入口（tester 真跑验收流程）【最终版】
 *
 * 沙盘：复制真实项目状态（工作流/任务/项目.json）+ 团队名册（清 sessionId）+ 项目正文目录；把 R-b34a 改回
 * 「test_done + Owner approved」构造一条可验收需求（真实状态只读复制，不改不删）。
 * 隔离实例（AWB_DATA_DIR + TEAM_ROOT 沙盘）+ 真窗口 CDP：打开验收列表 → 点【通过】→【确认验收】（连点两次）。
 *
 * 断言：①列表出现目标行且【通过】可点；②点击后 ≤300ms 出现「正在验收…」反馈；③成功提示含「已验收」且行移除；
 * ④主进程 stdout 的 `[accept-profile]` 只有 1 行（连点不重复落账）；⑤profile 含 gateMs/acceptMs/totalMs；
 * ⑥失败路径直接调 ownerAccept(不存在需求) → ok:false 不抛；⑦截图 3 张 + JSON 记录反馈/总耗时。
 *
 * 用法：node scripts/test-accept-latency-ui.cjs [--out <dir>]
 * 退出码：0 全绿 / 1 有失败。
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PNAME = '工作台改造修复';
const SB = path.join(ROOT, '_tmp', `accept-ui-${process.pid}-${Date.now()}`);
const TEAM = path.join(SB, '团队');
const DATA = path.join(SB, 'data');
const PROJ = path.join(SB, '项目', PNAME);
const PORT = Number(process.env.AWB_ACCEPT_UI_PORT || (9560 + (process.pid % 20)));
const OUT = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, '项目', PNAME, '程序员B', '产出', '证据-accept-latency'); })();
const TARGET = 'R-20261118-170937-b34a';
const rows = [];
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
function check(name, ok, detail) {
  rows.push({ name, ok: Boolean(ok), detail: ok ? null : (detail === undefined ? null : detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + JSON.stringify(detail === undefined ? null : detail).slice(0, 420)}`);
}
function httpJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => { let b = ''; res.on('data', (c) => { b += c; }); res.on('end', () => { try { resolve(JSON.parse(b)); } catch { resolve(null); } }); });
    req.on('error', () => resolve(null));
    req.setTimeout(3000, () => { req.destroy(); resolve(null); });
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
      if (m.id && this.pending.has(m.id)) { const p = this.pending.get(m.id); this.pending.delete(m.id); if (m.error) p.reject(new Error(m.error.message)); else p.resolve(m.result); }
    });
  }
  send(method, params = {}, ms = 60000) {
    const id = ++this.seq;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params }));
      setTimeout(() => { if (this.pending.has(id)) { this.pending.delete(id); reject(new Error('CDP 超时 ' + method)); } }, ms);
    });
  }
  async evaluate(expr, ms = 60000) {
    try {
      const out = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true, userGesture: true }, ms);
      if (out && out.exceptionDetails) return { __exception: String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || '') };
      return out && out.result ? out.result.value : undefined;
    } catch (e) { return { __cdperror: String((e && e.message) || e) }; }
  }
}
const REAL_STATE = path.join(ROOT, '团队', '状态', '项目', PNAME);
const REAL_TEAM = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_PROJ = path.join(ROOT, '项目', PNAME);
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
function seed() {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  const team = JSON.parse(fs.readFileSync(REAL_TEAM, 'utf8').replace(/^\uFEFF/, ''));
  for (const m of team.members || []) m.sessionId = '';
  team.activeProject = PNAME;
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  for (const name of ['团队宪法.md', '项目铁律.md']) { try { fs.copyFileSync(path.join(ROOT, '团队', name), path.join(TEAM, name)); } catch { /* ignore */ } }
  fs.cpSync(REAL_STATE, path.join(TEAM, '状态', '项目', PNAME), { recursive: true, force: true });
  fs.mkdirSync(PROJ, { recursive: true });
  for (const sub of ['需求', '项目信息.md', '项目铁律.md', '项目索引.md', '协作准则.md']) {
    try { fs.cpSync(path.join(REAL_PROJ, sub), path.join(PROJ, sub), { recursive: true, force: true }); } catch { /* ignore */ }
  }
  // boot 必读「角色卡」在**项目内** `<项目>/<角色目录>/角色卡.md`（team-tools bootDocSpecs）；只复制角色卡本身，不搬产出。
  try {
    for (const ent of fs.readdirSync(REAL_PROJ, { withFileTypes: true })) {
      if (!ent.isDirectory() || ent.name === '需求') continue;
      const card = path.join(REAL_PROJ, ent.name, '角色卡.md');
      if (fs.existsSync(card)) {
        fs.mkdirSync(path.join(PROJ, ent.name), { recursive: true });
        fs.cpSync(card, path.join(PROJ, ent.name, '角色卡.md'), { force: true });
      }
    }
  } catch { /* ignore */ }
  const wfFile = path.join(TEAM, '状态', '项目', PNAME, '工作流.json');
  const wf = JSON.parse(fs.readFileSync(wfFile, 'utf8').replace(/^\uFEFF/, ''));
  const reqs = wf.requirements && typeof wf.requirements === 'object' ? wf.requirements : {};
  const row = reqs[TARGET];
  if (!row) throw new Error('沙盘工作流缺少 ' + TARGET);
  const nowIso = new Date().toISOString();
  row.status = 'test_done';
  row.updatedAt = nowIso;
  row.ownerReview = { status: 'approved', at: nowIso, opinion: '沙盘复验：Owner 已通过评审', channel: 'ui', recordedBy: 'owner' };
  row.acceptance = null;
  row.decisions = [];
  // 沙盘 boot 记录会引用真实角色卡哈希 → 清掉 boots，避免 RULES_CHANGED（沙盘里再按需 boot）
  wf.boots = {};
  fs.writeFileSync(wfFile, JSON.stringify(wf, null, 2) + '\n', 'utf8');
  // 角色卡等必读文件也复制进沙盘（boot 校验用；真实布局是 团队/角色/<role>/）
  try { fs.cpSync(path.join(ROOT, '团队', '角色'), path.join(TEAM, '角色'), { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.cpSync(path.join(ROOT, '团队', '协议'), path.join(TEAM, '协议'), { recursive: true, force: true }); } catch { /* ignore */ }
  const store = JSON.parse(fs.readFileSync(REAL_STORE, 'utf8').replace(/^\uFEFF/, ''));
  const project = (store.projects || []).find((p) => p && String(p.teamName || p.name || '') === PNAME);
  if (!project) throw new Error('真实 workbench.json 缺少 ' + PNAME);
  project.path = PROJ;
  project.teamName = PNAME;
  project.sessions = {};
  project.workspace = { sessionIds: [] };
  store.projects = [project];
  store.activeProjectId = project.id;
  fs.writeFileSync(path.join(DATA, 'userdata', 'workbench.json'), JSON.stringify(store, null, 2) + '\n', 'utf8');
  // 沙盘路径改写：项目登记/项目索引/派单锁等 JSON 里记的是真实项目目录（含反斜杠转义），
  // 团队工具会校验「项目目录与旧团队登记一致」，必须把沙盘副本里的路径前缀换成本沙盘项目目录。
  const rewriteValue = (v) => {
    if (typeof v === 'string') {
      if (v === REAL_PROJ) return PROJ;
      if (v.startsWith(REAL_PROJ + '\\') || v.startsWith(REAL_PROJ + '/')) return PROJ + v.slice(REAL_PROJ.length);
      return v;
    }
    if (Array.isArray(v)) return v.map((x) => rewriteValue(x));
    if (v && typeof v === 'object') { for (const k of Object.keys(v)) v[k] = rewriteValue(v[k]); return v; }
    return v;
  };
  const walkJson = (dir) => {
    let ents = [];
    try { ents = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
    for (const ent of ents) {
      const full = path.join(dir, ent.name);
      if (ent.isDirectory()) { walkJson(full); continue; }
      if (!/\.json$/.test(ent.name)) continue;
      try {
        const text = fs.readFileSync(full, 'utf8');
        if (!text.includes('工作台改造修复')) continue;
        const obj = JSON.parse(text.replace(/^\uFEFF/, ''));
        const next = JSON.stringify(rewriteValue(obj), null, 2) + '\n';
        if (next !== text) fs.writeFileSync(full, next, 'utf8');
      } catch { /* 坏文件/非 JSON 忽略 */ }
    }
  };
  try { walkJson(path.join(TEAM, '状态')); } catch { /* ignore */ }
  // 沙盘里 boot 测试人员（验收门会校验「本轮已 boot」）；只写沙盘，TEAM_SELFTEST=1 不驱动真实 DSH。
  const bootEnv = { ...process.env, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: path.join(SB, '项目'), TEAM_SELFTEST: '1', TEAM_WORKBENCH_JSON: path.join(DATA, 'userdata', 'workbench.json') };
  for (const role of ['tester', 'pm']) {
    try {
      const r = spawnSync(process.execPath, [path.join(ROOT, '团队', '工具', 'team.mjs'), 'boot', '--role', role, '--project', PNAME, '--session', 'session-sandbox-' + role], { env: bootEnv, cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 120000 });
      const out = String((r.stdout || '') + (r.stderr || ''));
      if (!/BOOT_OK|已完成|令牌/.test(out)) console.error('SANDBOX_BOOT_WARN ' + role + ' ' + out.slice(0, 300));
    } catch { /* boot 失败由后续断言暴露 */ }
  }
  // 若 sandbox boot 没写出 boots（缺文档等），补一条合成 boot 记录：验收门只要求「本轮已 boot + complete」。
  try {
    const wf2 = JSON.parse(fs.readFileSync(wfFile, 'utf8').replace(/^\uFEFF/, ''));
    wf2.boots = wf2.boots && typeof wf2.boots === 'object' ? wf2.boots : {};
    const bootAt = new Date().toISOString();
    for (const role of ['tester', 'pm']) {
      const cur = wf2.boots[role];
      if (!cur || !cur.complete || !cur.at) {
        wf2.boots[role] = { role, at: bootAt, complete: true, round: Math.max(1, Number(wf2.round) || 1), docs: cur && cur.docs ? cur.docs : {}, rulesHash: 'sandbox', source: 'sandbox-fixture' };
      }
    }
    fs.writeFileSync(wfFile, JSON.stringify(wf2, null, 2) + '\n', 'utf8');
    console.error('SANDBOX_BOOTS ' + JSON.stringify(Object.keys(wf2.boots)));
  } catch (e) { console.error('SANDBOX_BOOTS_FAIL ' + String((e && e.message) || e)); }
  fs.mkdirSync(OUT, { recursive: true });
  return { target: TARGET, taskFiles: (() => { try { return fs.readdirSync(path.join(TEAM, '状态', '项目', PNAME, '任务')).length; } catch { return 0; } })() };
}
async function launch() {
  const env = { ...process.env, AWB_DATA_DIR: DATA, TEAM_ROOT: TEAM, TEAM_SELFTEST: '1' };
  const stdoutLines = [];
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: false });
  const collect = (buf) => { for (const line of String(buf || '').split(/\r?\n/)) if (line.trim()) stdoutLines.push(line.trim()); };
  child.stdout.on('data', collect);
  child.stderr.on('data', collect);
  const target = await waitTarget(PORT, 90000, (item) => item && item.type === 'page' && String(item.url || '').includes('renderer/index.html'));
  if (!target) { try { child.kill(); } catch { /* ignore */ } return null; }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', () => reject(new Error('ws fail')), { once: true }); });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  for (let i = 0; i < 200; i += 1) {
    const ready = await cdp.evaluate('document.readyState === "complete" && Boolean(window.workbench) && Boolean(document.getElementById("owner-review-entry"))');
    if (ready === true) break;
    await sleep(400);
  }
  const guest = await waitTarget(PORT, 6000, (item) => item && item.type === 'webview');
  if (guest) {
    try {
      const gws = new WebSocket(guest.webSocketDebuggerUrl);
      await new Promise((resolve) => { gws.addEventListener('open', resolve, { once: true }); setTimeout(resolve, 2000); });
      gws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: 'about:blank' } }));
      await sleep(400);
    } catch { /* ignore */ }
  }
  return { child, cdp, ws, stdoutLines };
}
async function close(inst) {
  if (!inst) return;
  try { inst.cdp.send('Browser.close', {}, 3000).catch(() => {}); } catch { /* ignore */ }
  await sleep(800);
  try { inst.ws.close(); } catch { /* ignore */ }
  try { inst.child.kill(); } catch { /* ignore */ }
  await sleep(400);
  try { if (inst.child && inst.child.pid && inst.child.exitCode === null) spawnSync('taskkill', ['/PID', String(inst.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true }); } catch { /* ignore */ }
}
async function shot(cdp, file) {
  for (let i = 0; i < 3; i += 1) {
    try {
      await cdp.send('Page.bringToFront', {}, 6000);
      const out = await cdp.send('Page.captureScreenshot', { format: 'png' }, 20000);
      if (out && out.data) { const buf = Buffer.from(out.data, 'base64'); fs.writeFileSync(file, buf); if (buf.length > 3000) return buf.length; }
    } catch { /* retry */ }
    await sleep(500);
  }
  return 0;
}
(async () => {
  const seedInfo = seed();
  const inst = await launch();
  check('AC-0 隔离实例启动（沙盘：目标需求可验收）', Boolean(inst), seedInfo);
  const report = { at: new Date().toISOString(), seed: seedInfo, port: PORT, feedbackMs: null, noticeMs: null, profile: null, screenshots: [] };
  if (inst) {
    try {
      const opened = await inst.cdp.evaluate('(() => { if (typeof window.__awbOpenAcceptList === "function") { window.__awbOpenAcceptList(); return true; } return false; })()');
      check('AC-1 验收列表已打开（window.__awbOpenAcceptList）', opened === true, opened);
      await sleep(700);
      const rowInfo = await inst.cdp.evaluate(`(() => {
        const row = document.querySelector('#accept-list .accept-row[data-req-id="${TARGET}"]');
        if (!row) return { found: false };
        const btn = row.querySelector('[data-action="owner-accept"]');
        const why = row.querySelector('[data-accept-pre-why]');
        return { found: true, disabled: Boolean(btn && btn.disabled), gate: btn ? btn.getAttribute('data-accept-gate') : null, why: why ? String(why.textContent || '') : '' };
      })()`);
      check('AC-2 目标需求出现在验收列表且【通过】可点', Boolean(rowInfo && rowInfo.found && rowInfo.disabled === false), rowInfo);
      await shot(inst.cdp, path.join(OUT, 'accept-ui-01-list.png'));
      report.screenshots.push('accept-ui-01-list.png');
      // busy / notice 观察器
      const probe = await inst.cdp.evaluate(`(() => {
        window.__acceptProbe = { clickAt: 0, busyAt: null, noticeAt: null };
        const obs = new MutationObserver(() => {
          const p = window.__acceptProbe;
          const busy = document.querySelector('[data-accept-busy]');
          if (busy && !busy.hidden && p.clickAt && p.busyAt === null) p.busyAt = performance.now() - p.clickAt;
          const notice = document.querySelector('[data-or-notice]');
          if (notice && p.clickAt && p.noticeAt === null && /已验收/.test(String(notice.textContent || ''))) p.noticeAt = performance.now() - p.clickAt;
        });
        obs.observe(document.body, { childList: true, subtree: true, attributes: true, characterData: true });
        return { wrapped: true };
      })()`);
      check('AC-3 页面内 busy/notice 观察器已挂上', Boolean(probe && probe.wrapped), probe);
      const steps = await inst.cdp.evaluate(`(async () => {
        const p = window.__acceptProbe;
        const row = document.querySelector('#accept-list .accept-row[data-req-id="${TARGET}"]');
        const btn = row && row.querySelector('[data-action="owner-accept"]');
        if (!btn) return { ok: false, why: 'no-accept-button' };
        btn.click();
        await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r)));
        const confirm = document.querySelector('[data-action="owner-accept-confirm"]');
        if (!confirm) return { ok: false, why: 'no-confirm-button' };
        p.clickAt = performance.now();
        confirm.click();
        confirm.click(); // 连点第二次 → 应被 disabled + submitting 拦住
        return { ok: true };
      })()`);
      check('AC-4 已点【通过】并进入确认框（连点两次）', Boolean(steps && steps.ok), steps);
      let state = null;
      for (let i = 0; i < 120; i += 1) {
        await sleep(200);
        state = await inst.cdp.evaluate('(() => { const p = window.__acceptProbe || {}; const row = document.querySelector(\'#accept-list .accept-row[data-req-id="' + TARGET + '"]\'); const n = document.querySelector("[data-or-notice]"); return { busyAt: p.busyAt === undefined ? null : p.busyAt, noticeAt: p.noticeAt === undefined ? null : p.noticeAt, notice: n ? String(n.textContent || "") : "", rowGone: !row }; })()');
        if (state && /已验收/.test(state.notice)) break;
      }
      report.feedbackMs = state && state.busyAt !== null ? Math.round(state.busyAt * 10) / 10 : null;
      report.noticeMs = state && state.noticeAt !== null ? Math.round(state.noticeAt * 10) / 10 : null;
      const profileLines = (inst.stdoutLines || []).filter((l) => l.includes('[accept-profile]'));
      let profile = null;
      try {
        if (profileLines.length) { const last = profileLines[profileLines.length - 1]; profile = JSON.parse(last.slice(last.indexOf('{'))); }
      } catch { profile = null; }
      report.profile = profile;
      report.profileLines = profileLines.length;
      const errInfo = await inst.cdp.evaluate('(() => { const e = document.querySelector("[data-accept-error]"); const f = document.querySelector("[data-accept-form]"); return { err: e ? String(e.textContent || "") : "", code: e ? String(e.getAttribute("data-error-code") || "") : "", formHidden: f ? Boolean(f.hidden) : null, busy: (() => { const b = document.querySelector("[data-accept-busy]"); return b ? { hidden: b.hidden, text: String(b.textContent || "") } : null; })() }; })()');
      report.errorInfo = errInfo;
      console.error('DIAG ' + JSON.stringify({ profile, errInfo }));
      check('AC-5 点击后 ≤300ms 出现「正在验收…」反馈（busy 可见）', report.feedbackMs !== null && report.feedbackMs <= 300, { feedbackMs: report.feedbackMs });
      check('AC-6 成功提示在响应即出（含「已验收」）', Boolean(state && /已验收/.test(state.notice)), state && state.notice);
      check('AC-7 连点两次只落账 1 次（主进程 [accept-profile] 行数 = 1）', profileLines.length === 1, { profileLines: profileLines.length });
      check('AC-8 主进程 profile 可回填 gateMs/acceptMs/totalMs', Boolean(profile) && ['gateMs', 'acceptMs', 'totalMs'].every((k) => Number.isFinite(Number(profile[k]))), profile);
      const after = await inst.cdp.evaluate(`(async () => { await new Promise((r) => setTimeout(r, 1800)); const row = document.querySelector('#accept-list .accept-row[data-req-id="${TARGET}"]'); return { rowGone: !row }; })()`);
      check('AC-9 成功后该行从验收列表移除（后台刷新完成）', Boolean(after && after.rowGone), after);
      await shot(inst.cdp, path.join(OUT, 'accept-ui-02-success.png'));
      report.screenshots.push('accept-ui-02-success.png');
      const fail = await inst.cdp.evaluate(`(async () => {
        try { const r = await window.workbench.ownerAccept({ projectId: null, requirementId: 'R-00000000-000000-ffff', decision: 'accepted', role: 'owner' }); return { ok: Boolean(r && r.ok), code: r && r.code }; }
        catch (e) { return { threw: true, message: String((e && e.message) || e) }; }
      })()`);
      check('AC-10 失败路径返回 ok:false 且不抛未捕获异常（失败不落账）', Boolean(fail && !fail.threw && fail.ok === false), fail);
      report.failurePath = fail;
      await shot(inst.cdp, path.join(OUT, 'accept-ui-03-failure.png'));
      report.screenshots.push('accept-ui-03-failure.png');
      report.ipcProfileMs = profile ? { gateMs: profile.gateMs, acceptMs: profile.acceptMs, totalMs: profile.totalMs } : null;
    } catch (e) {
      check('AC 测量未抛错', false, String((e && e.message) || e));
    }
  }
  try { fs.writeFileSync(path.join(OUT, 'accept-ui-run.json'), JSON.stringify({ ...report, checks: rows }, null, 2) + '\n', 'utf8'); } catch { /* ignore */ }
  await close(inst);
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
  const failed = rows.filter((r) => !r.ok);
  console.log('');
  for (const f of failed) console.log(`FAILED  ${f.name} :: ${String(JSON.stringify(f.detail)).slice(0, 400)}`);
  console.log(`ACCEPT_UI ${failed.length ? 'FAIL' : 'OK'} ${JSON.stringify({ total: rows.length, pass: rows.length - failed.length, red: failed.length })}`);
  console.log('证据：' + path.join(OUT, 'accept-ui-run.json'));
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('ACCEPT_UI ERROR ' + String((e && e.stack) || e)); process.exit(1); });
