#!/usr/bin/env node
'use strict';
/**
 * test-8056-roster-empty.cjs — B-20261120-163507-8056（P0）工作区卡片「六角色会话」列表消失 的真窗口断面
 *
 * 断面：隔离实例（AWB_DATA_DIR/AWB_STORE/TEAM_ROOT/TEAM_PROJECTS_ROOT 全指沙盘）
 *   → 真实名册（members[].sessionId 保留）+ 真实 store 项目（6 条 sessions）
 *   → CDP 读 window.workbench.teamMembers({projectId}) 的原始返回 + #role-sessions 行数/文案 + #session-count。
 *
 * 用法：
 *   node scripts/test-8056-roster-empty.cjs --probe            # 只打印断面（before 取证）
 *   node scripts/test-8056-roster-empty.cjs --tag before|after --out <dir>   # 存截图 + JSON
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PNAME = '工作台改造修复';
const SB = path.join(ROOT, '_tmp', `8056-roster-${process.pid}-${Date.now()}`);
const DATA = path.join(SB, 'data');
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目区');
const STORE = path.join(DATA, 'userdata', 'workbench.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const REAL_TEAM_JSON = path.join(ROOT, '团队', '状态', '团队.json');
const PORT = Number(process.env.AWB_8056_PORT || (9550 + (process.pid % 30)));
const ARGS = process.argv.slice(2);
const TAG = (() => { const i = ARGS.indexOf('--tag'); return i >= 0 ? String(ARGS[i + 1] || '') : ''; })();
const OUT = (() => { const i = ARGS.indexOf('--out'); return i >= 0 ? path.resolve(ARGS[i + 1]) : ''; })();
const PROBE = ARGS.includes('--probe');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
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

function seed() {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '工具'), { recursive: true });
  fs.mkdirSync(path.join(PROJECTS, PNAME), { recursive: true });
  // 团队工具：junction 指真实 团队/工具（名册/清单/项目状态读取方都用它）
  // Windows 下用 NTFS junction，避免复制整份工具目录
  try { fs.symlinkSync(path.join(ROOT, '团队', '工具'), path.join(TEAM, '工具'), 'junction'); } catch { /* 已存在 */ }
  for (const name of ['团队宪法.md', '项目铁律.md']) { try { fs.copyFileSync(path.join(ROOT, '团队', name), path.join(TEAM, name)); } catch { /* ignore */ } }
  // 真实名册（sessionId 全部保留）——PM 现场就是这个状态
  const team = JSON.parse(fs.readFileSync(REAL_TEAM_JSON, 'utf8').replace(/^\uFEFF/, ''));
  team.activeProject = PNAME;
  // 断面开关：--seed=filtered → 模拟「名册成员全被归档过滤」；--seed=noroster-mapping → store 无 sessions
  const seedMode = (() => { const i = ARGS.indexOf('--seed'); return i >= 0 ? String(ARGS[i + 1] || '') : ''; })();
  if (seedMode === 'filtered') for (const m of team.members || []) { m.archived = true; }
  if (seedMode === 'badroster') fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), '{ this is not json', 'utf8');
  else fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  fs.mkdirSync(path.join(TEAM, '状态', '项目', PNAME), { recursive: true });
  fs.writeFileSync(path.join(TEAM, '状态', '项目', PNAME, '唤醒.jsonl'), '', 'utf8');
  // 会话排队快照（六角色，与名册一致）
  const roles = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'].map((role) => ({
    role, known: true, active: false, running: false, queued: 0, sessionId: String(((team.members || []).find((m) => m && m.role === role) || {}).sessionId || ''), pendingInput: [], lastEventAt: '', lastOkAt: '',
  }));
  fs.writeFileSync(path.join(TEAM, '状态', '会话排队.json'), JSON.stringify({ schemaVersion: 2, at: new Date().toISOString(), project: PNAME, host: 'fixture', staleMs: 60000, roles }, null, 2) + '\n', 'utf8');
  // 真实 store 项目（6 条 sessions + 96 个 workspace.sessionIds）
  const store = JSON.parse(fs.readFileSync(REAL_STORE, 'utf8').replace(/^\uFEFF/, ''));
  const project = (store.projects || []).find((item) => item && String(item.teamName || item.name || '') === PNAME);
  if (!project) throw new Error('真实 workbench.json 缺少项目 ' + PNAME);
  project.teamName = PNAME;
  // 项目清单（团队会话.json）按真实内容拷到沙盘项目目录，workspace 改成沙盘路径
  const realManifest = path.join(ROOT, '项目', PNAME, '团队会话.json');
  const manifest = JSON.parse(fs.readFileSync(realManifest, 'utf8').replace(/^\uFEFF/, ''));
  manifest.workspace = path.join(PROJECTS, PNAME);
  fs.writeFileSync(path.join(PROJECTS, PNAME, '团队会话.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  project.path = path.join(PROJECTS, PNAME);
  project.workspace = { ...(project.workspace || {}), path: project.path };
  store.projects = [project];
  store.activeProjectId = project.id;
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n', 'utf8');
  return { projectId: project.id, projectName: PNAME, manifestRoles: (manifest.roles || []).length, storeSessions: Object.keys(project.sessions || {}).length };
}

async function launch() {
  const env = {
    ...process.env,
    AWB_DATA_DIR: DATA, AWB_STORE: STORE, AWB_TEAM_ROOT: TEAM, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1',
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
  for (let i = 0; i < 120; i += 1) {
    const ready = await cdp.evaluate('document.readyState === "complete" && Boolean(document.getElementById("role-sessions"))');
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
  // 只杀自己 spawn 的 PID（P0 e923：禁止按名/路径批量杀）
  try { spawn('taskkill', ['/PID', String(inst.child.pid), '/T', '/F'], { stdio: 'ignore' }); } catch { /* ignore */ }
}

/* ── --assert：三场景（正常 / 过滤空 / 名册不可读） ── */
const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : (detail === undefined ? null : detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 500)}`);
}
async function scenario(seedMode, tag) {
  const saved = process.argv.slice();
  if (seedMode) { if (ARGS.indexOf('--seed') < 0) ARGS.push('--seed', seedMode); else ARGS[ARGS.indexOf('--seed') + 1] = seedMode; }
  else { const i = ARGS.indexOf('--seed'); if (i >= 0) ARGS.splice(i, 2); }
  const seeded = seed();
  let inst = null;
  try {
    inst = await launch();
    if (!inst) throw new Error('实例未启动');
    await sleep(2500);
    const ipc = await inst.cdp.evaluate(`(async () => { try { const st = await window.workbench.state(); const p = (st.projects||[])[0]||null; const res = await window.workbench.teamMembers({ projectId: p ? p.id : ${JSON.stringify(seeded.projectId)} }); return { ok: !!res && res.ok !== false, code: String((res&&res.code)||''), rolesLen: Array.isArray(res&&res.roles)?res.roles.length:-1, membersEmpty: res&&res.membersEmpty, filteredOut: res&&res.filteredOut, memberCount: res&&res.memberCount }; } catch (e) { return { threw: String(e&&e.message||e) }; } })()`);
    const dom = await inst.cdp.evaluate(`(() => { const box = document.getElementById('role-sessions'); const count = document.getElementById('session-count'); return { rows: box ? box.querySelectorAll('.session-row').length : -1, empty: box ? Boolean(box.querySelector('[data-roster-empty]')) : null, filtered: box ? Boolean(box.querySelector('[data-roster-filtered]')) : null, failed: box ? Boolean(box.querySelector('[data-roster-failed]')) : null, text: box ? String(box.innerText||'').slice(0,160) : '', countText: count?String(count.textContent||''):'', dataLocal: count?count.getAttribute('data-local'):'', dataFailed: count?count.getAttribute('data-roster-failed'):'' }; })()`);
    if (OUT) {
      fs.mkdirSync(OUT, { recursive: true });
      const shot = await inst.cdp.send('Page.captureScreenshot', { format: 'png' }, 20000).catch(() => null);
      if (shot && shot.data) fs.writeFileSync(path.join(OUT, `8056-assert-${tag}.png`), Buffer.from(shot.data, 'base64'));
      fs.writeFileSync(path.join(OUT, `8056-assert-${tag}.json`), JSON.stringify({ seeded, ipc, dom }, null, 2) + '\n', 'utf8');
    }
    return { seeded, ipc: ipc || {}, dom: dom || {} };
  } finally {
    await close(inst);
    try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
async function runAssert() {
  try {
    const normal = await scenario('', 'normal');
    check('A1 正常名册：列表 6 行（不再消失）', normal.dom.rows === 6, normal.dom);
    check('A2 正常名册：不出现「无在册成员」空态', normal.dom.empty === false && !/无在册成员/.test(String(normal.dom.text || '')), normal.dom);
    check('A3 正常名册：顶部计数与列表同源（data-local=6/6、计数非空）', normal.dom.dataLocal === '6/6' && Boolean(normal.dom.countText), normal);

    const filtered = await scenario('filtered', 'filtered');
    check('B1 名册被过滤空：空态文案是「名册有 N 人…可显示 0 人」，不是「无在册成员」',
      filtered.dom.filtered === true && filtered.dom.empty === false && /名册有 6 人/.test(String(filtered.dom.text || '')), filtered);
    check('B2 名册被过滤空：后端 membersEmpty=false（不把「过滤空」当「无名册」）',
      filtered.ipc.membersEmpty === false && filtered.ipc.filteredOut === true && Number(filtered.ipc.memberCount) === 6, filtered.ipc);

    const bad = await scenario('badroster', 'badroster');
    check('C1 名册不可读：显示「名册读取失败」并给错误码，不再伪装「无在册成员」',
      bad.dom.failed === true && bad.dom.empty === false && /名册读取失败/.test(String(bad.dom.text || '')) && /TEAM_ROSTER_UNREADABLE/.test(String(bad.dom.text || '')), bad.dom);
    check('C2 名册不可读：后端 ok=false 且 membersEmpty=false；顶部标记 data-roster-failed=1',
      bad.ipc.ok === false && bad.ipc.code === 'TEAM_ROSTER_UNREADABLE' && bad.ipc.membersEmpty === false && bad.dom.dataFailed === '1', bad);

    // D：静态断言「保留上次值」的实现存在（真窗口首个加载失败时无上次值可保留，只能在代码层核）
    const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
    check('D1 读失败保留上次值：loadMemberStates 有 prev 回退且不再把失败映射成空数组',
      /const prev = memberStatesCache && memberStatesCache\.projectId === project\.id/.test(appSrc)
      && /rows: prev \? prev\.rows : null/.test(appSrc)
      && !/return \{ projectId: project\.id, at: Date\.now\(\), rows: \[\], empty: true \}/.test(appSrc), {});
    const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
    check('D2 后端不再把「过滤空」当无名册：membersEmpty 用 trulyEmpty 判定 + filteredOut 分支',
      /const trulyEmpty = rosterCountsNow\.memberCount === 0/.test(mainSrc) && /filteredOut: !trulyEmpty/.test(mainSrc), {});
  } catch (e) {
    check('断面未抛异常', false, { error: String((e && e.stack) || e) });
  }
  const failed = ROWS.filter((r) => !r.ok).length;
  console.log(`\n${ROWS.length - failed}/${ROWS.length} PASS${failed ? ' · ' + failed + ' FAIL' : ''}`);
  process.exit(failed ? 1 : 0);
}

async function main() {
  // --assert：三场景断言（正常 / 名册被过滤 / 名册不可读），每个场景独立实例
  if (ARGS.includes('--assert')) { await runAssert(); return; }
  const seeded = seed();
  let inst = null;
  const out = { at: new Date().toISOString(), tag: TAG, seeded };
  try {
    inst = await launch();
    if (!inst) throw new Error('实例未启动（CDP 未就绪）');
    await sleep(2500);
    out.ipc = await inst.cdp.evaluate(`(async () => {
      try {
        const st = await window.workbench.state();
        const p = (st.projects || []).find((x) => x.id === ${JSON.stringify(seeded.projectId)}) || (st.projects || [])[0] || null;
        const res = await window.workbench.teamMembers({ projectId: p ? p.id : ${JSON.stringify(seeded.projectId)} });
        return { ok: !!res && res.ok !== false, code: res && res.code || '', error: res && res.error || '', rolesLen: Array.isArray(res && res.roles) ? res.roles.length : -1,
          membersEmpty: res && res.membersEmpty, projectMissing: res && res.projectMissing, memberCount: res && res.memberCount,
          projectId: p ? p.id : '', stateProjects: (st.projects || []).length };
      } catch (e) { return { threw: String(e && e.message || e) }; }
    })()`);
    out.dom = await inst.cdp.evaluate(`(() => {
      const box = document.getElementById('role-sessions');
      const count = document.getElementById('session-count');
      const rows = box ? box.querySelectorAll('.session-row').length : -1;
      const empty = box ? Boolean(box.querySelector('[data-roster-empty]')) : false;
      return { rows, empty, boxText: box ? String(box.innerText || '').slice(0, 200) : '', countText: count ? String(count.textContent || '') : '', countTitle: count ? String(count.title || '') : '', dataLocal: count ? count.getAttribute('data-local') : '', dataVerified: count ? count.getAttribute('data-verified') : '' };
    })()`);
    out.header = await inst.cdp.evaluate(`(() => { const el = document.querySelector('#team-session-count') || document.querySelector('#status-meta'); return el ? String(el.textContent || '').slice(0, 160) : ''; })()`);
    if (OUT) {
      fs.mkdirSync(OUT, { recursive: true });
      const shot = await inst.cdp.send('Page.captureScreenshot', { format: 'png' }, 20000).catch(() => null);
      if (shot && shot.data) fs.writeFileSync(path.join(OUT, `8056-${TAG || 'shot'}.png`), Buffer.from(shot.data, 'base64'));
      fs.writeFileSync(path.join(OUT, `8056-${TAG || 'shot'}.json`), JSON.stringify(out, null, 2) + '\n', 'utf8');
    }
    console.log(JSON.stringify(out, null, 2));
  } finally {
    await close(inst);
    try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}
main().catch((e) => { console.error('PROBE_FAILED', String(e && e.stack || e)); process.exit(1); });
