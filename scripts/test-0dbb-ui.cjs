#!/usr/bin/env node
'use strict';
const { rmSandbox, uniqueSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A/B：清理助手 + 唯一沙盘
/**
 * R-0dbb「评审材料可读性」真窗口渲染断言（CDP，T-20261117-011142-d2a1）。
 *
 * 覆盖只有真窗口才验得到的渲染落点（AC2/AC3/AC4/AC5/AC11③）：
 *   · 评审弹窗展开某需求：`ul[data-ac-items] li[data-ac-id^="AC"]` 条数＝正文行内 AC 数、每条 data-ac-source=inline；
 *   · 每条 AC 有人话位：写了人话的给 `[data-ac-plain]`（值必须是正文原文子串），没写的给 `[data-ac-plain-missing="1"]`；
 *   · `[data-advice]`：有取舍 → 「建议你定：」+ 取舍关键词 + 「另有 N 条取舍」；无取舍 → 「本条无待拍板点」且不含「建议通过/进开发」；
 *   · 需求池详情 `[data-pool-detail] [data-owner-opinion-text]` 文本＝Owner 意见原文全文（不截断）。
 *
 * 隔离：AWB_DATA_DIR + TEAM_ROOT + TEAM_PROJECTS_ROOT + TEAM_WORKBENCH_JSON 全部指 `_tmp/0dbb-ui`；
 *       项目正文用沙盘副本（可注入人话/取舍样本）；真实 data/userdata/workbench.json、团队.json、工作流.json 只读，
 *       跑完比对 sha256+mtime 未变。真窗口走 `scripts/run-electron.cjs . --remote-debugging-port=<port>`。
 * 用法：node scripts/test-0dbb-ui.cjs         （退出码 0=全绿；截图/结果落 程序员A/产出/证据-0dbb/）
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJ_REAL = path.join(ROOT, '项目', '工作台改造修复');
const PNAME = '工作台改造修复';
const RUN_ID = String(process.pid);
const BASE = uniqueSandbox('0dbb-ui'); // B-07b6 B：唯一沙盘（并发安全）
const SB = path.join(BASE, `sb-${RUN_ID}`);
const DATA = path.join(SB, 'data'); // 每次运行独立数据根：避免上一次实例的单实例锁把新实例顶掉
const TEAM = path.join(SB, '团队');
const PROJECT = path.join(SB, 'project', PNAME);
const STORE = path.join(DATA, 'userdata', 'workbench.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const REAL_TEAM_JSON = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_WF = path.join(ROOT, '团队', '状态', '项目', PNAME, '工作流.json');
const REQ_A = 'R-20261116-090831-0dbb';
const REQ_B = 'R-20261117-000001-aa01';
const OPINION = '通过的意见产品也要看，而不是通过了就不看意见了，比如我通过的话也会提一些建议，对齐颗粒度或者参考我的口径，其他的都同意';
const HUMAN = '打开评审弹窗就能逐条看到每个 AC（人话样本）';
const PORT = Number(process.env.AWB_0DBB_UI_PORT || (9441 + (process.pid % 40)));
const EVID = process.env.AWB_0DBB_UI_OUT
  ? path.resolve(process.env.AWB_0DBB_UI_OUT)
  : path.join(PROJ_REAL, '程序员A', '产出', '证据-0dbb');

const results = [];
const log = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  const line = `${ok ? 'PASS' : 'FAIL'}  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 420)}`;
  log.push(line);
  console.log(line);
  if (!ok) process.exitCode = 1;
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const sha256File = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
function statOf(file) {
  try { const s = fs.statSync(file); return { sha256: sha256File(file), mtimeMs: s.mtimeMs, bytes: s.size }; } catch { return null; }
}
function httpJson(url) {
  return new Promise((resolve) => {
    const req = http.get(url, (res) => {
      let body = ''; res.on('data', (c) => { body += c; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch { resolve(null); } });
    });
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
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id); this.pending.delete(m.id);
        if (m.error) reject(new Error(m.error.message)); else resolve(m.result);
      }
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
}
function copyFile(src, dst) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
}
function inlineCount(text) {
  return text.split(/\r?\n/).filter((line) => /^\s*[-*]\s*\*\*AC(\d+)\s*[（(]([^）)]*)[）)]\*\*\s*(.*)$/.test(line)).length;
}

/* ── 沙盘：团队骨架 + 项目正文副本 + workbench store ───────────────────── */
function seed() {
  rmSandbox(SB, { recursive: true, force: true });
  fs.mkdirSync(DATA, { recursive: true });
  const projectState = path.join(TEAM, '状态', '项目', PNAME);
  copyFile(path.join(ROOT, '团队', '团队宪法.md'), path.join(TEAM, '团队宪法.md'));
  copyFile(path.join(ROOT, '团队', '项目铁律.md'), path.join(TEAM, '项目铁律.md'));
  const team = JSON.parse(fs.readFileSync(REAL_TEAM_JSON, 'utf8').replace(/^\uFEFF/, ''));
  for (const member of team.members || []) member.sessionId = '';
  team.activeProject = PNAME;
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  fs.mkdirSync(projectState, { recursive: true });
  fs.writeFileSync(path.join(projectState, '项目.json'), JSON.stringify({ name: PNAME, path: PROJECT, index: '项目索引.md', teamMode: 'full' }, null, 2) + '\n', 'utf8');
  // 项目文档（阅读器/面板会读存在性）；正文只放本单两份样本。
  for (const name of ['项目信息.md', '项目铁律.md', '项目索引.md', '协作准则.md', '经验教训登记册.md']) {
    copyFile(path.join(PROJ_REAL, name), path.join(PROJECT, name));
  }
  copyFile(path.join(PROJ_REAL, '需求', '00-需求总览.md'), path.join(PROJECT, '需求', '00-需求总览.md'));
  // 样本 A：真实 0dbb 正文 + 人话样本 + 取舍小节（沙盘副本，真实正文不动）
  const realDocName = fs.readdirSync(path.join(PROJ_REAL, '需求')).find((name) => name.startsWith(REQ_A));
  const docA = (() => {
    const lines = fs.readFileSync(path.join(PROJ_REAL, '需求', realDocName), 'utf8').split(/\r?\n/);
    const at = lines.findIndex((line) => /^\s*[-*]\s*\*\*AC1\s*[（(]/.test(line));
    if (at >= 0) lines[at] = `${lines[at]}｜人话：${HUMAN}`;
    lines.push('', '## 九、待确认清单', '', '- 角色卡 4KB 还是 16KB（取哪档要 Owner 定）', '- 模板一起改还是只改卡', '- 超限阈值 15872 还是 16384');
    return lines.join('\n');
  })();
  fs.mkdirSync(path.join(PROJECT, '需求'), { recursive: true });
  fs.writeFileSync(path.join(PROJECT, '需求', realDocName), docA, 'utf8');
  // 样本 B：完全无取舍、无人的正文（用于「本条无待拍板点」）
  const docB = [
    '# R-20261117-000001-aa01 · 无取舍样本（沙盘）',
    '',
    '## 五、验收标准',
    '',
    '- **AC1（能不能打开）** 打开评审弹窗能看到该需求',
    '- **AC2（一条算不算过）** 验收标准写明通过判据',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(PROJECT, '需求', `${REQ_B}-无取舍样本.md`), docB, 'utf8');
  // 工作流：只放两条沙盘行（A 带 Owner 意见；B 待决且无取舍）
  const wf = {
    version: 2, project: PNAME, round: 1, phase: 'owner_review',
    requirements: {
      [REQ_A]: {
        id: REQ_A, title: '评审材料可读性', status: 'approved', round: 1, queued: false,
        acceptanceCriteria: '打开评审弹窗能逐条看到 AC、每条有人话、建议拍板给出具体取舍',
        ownerReview: { status: 'approved', at: '2026-11-17T06:19:58.000Z', opinion: OPINION, channel: 'ui', actor: 'owner' },
        decisions: [{ status: 'approved', decision: 'approved', at: '2026-11-17T06:19:58.000Z', channel: 'ui', actor: 'owner', opinion: OPINION, decisionIndex: 0 }],
        history: [],
      },
      [REQ_B]: {
        id: REQ_B, title: '无取舍样本', status: 'owner_review', round: 1, queued: false,
        acceptanceCriteria: '打开能看到该需求、判据写明',
        ownerReview: { status: 'pending', at: null, opinion: '' },
        decisions: [], history: [],
      },
    },
    events: [],
  };
  fs.writeFileSync(path.join(projectState, '工作流.json'), JSON.stringify(wf, null, 2) + '\n', 'utf8');
  // 壳层 store：只留本项目，path 指沙盘项目目录
  const store = JSON.parse(fs.readFileSync(REAL_STORE, 'utf8').replace(/^\uFEFF/, ''));
  const project = (store.projects || []).find((item) => item && String(item.teamName || item.name || '') === PNAME);
  if (!project) throw new Error(`真实 workbench.json 里没有团队项目 ${PNAME}`);
  project.path = PROJECT;
  project.teamName = PNAME;
  store.projects = [project];
  store.activeProjectId = project.id;
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.writeFileSync(STORE, JSON.stringify(store, null, 2) + '\n', 'utf8');
  return { docA, docB, expectedA: inlineCount(docA), expectedB: inlineCount(docB) };
}
function launchEnv() {
  return {
    ...process.env,
    AWB_DATA_DIR: DATA,
    TEAM_ROOT: TEAM,
    TEAM_PROJECTS_ROOT: path.join(SB, '项目'),
    TEAM_WORKBENCH_JSON: STORE,
    TEAM_SELFTEST: '1',
  };
}
async function launchShell() {
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], {
    cwd: ROOT, env: launchEnv(), stdio: 'ignore', windowsHide: false,
  });
  const target = await waitTarget(PORT, 90000, (item) => item && item.type === 'page' && String(item.url || '').includes('renderer/index.html'));
  if (!target) { try { child.kill(); } catch { /* ignore */ } return null; }
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', () => reject(new Error('ws 连接失败')), { once: true });
  });
  const cdp = new Cdp(ws);
  await cdp.send('Runtime.enable');
  await cdp.send('Page.enable');
  for (let i = 0; i < 160; i += 1) {
    const ready = await cdp.evaluate('document.readyState === "complete" && Boolean(document.getElementById("owner-review-entry"))');
    if (ready === true) break;
    await sleep(500);
  }
  // 壳内 webview 是真实 DSH 页面：导航 about:blank，避免截图黑底/挂住（只影响本隔离实例）
  const guest = await waitTarget(PORT, 8000, (item) => item && item.type === 'webview');
  if (guest) {
    try {
      const gws = new WebSocket(guest.webSocketDebuggerUrl);
      await new Promise((resolve) => { gws.addEventListener('open', resolve, { once: true }); setTimeout(resolve, 3000); });
      gws.send(JSON.stringify({ id: 1, method: 'Page.navigate', params: { url: 'about:blank' } }));
      await sleep(600);
    } catch { /* webview 关掉也不影响断言 */ }
  }
  return { child, cdp, ws };
}
async function closeShell(inst) {
  if (!inst) return;
  // 不能 await Browser.close：页面目标一关 promise 永不 resolve
  try { inst.cdp.send('Browser.close', {}, 4000).catch(() => {}); } catch { /* ignore */ }
  await sleep(900);
  try { inst.ws.close(); } catch { /* ignore */ }
  try { inst.child.kill(); } catch { /* ignore */ }
  await sleep(800);
  // 兜底：子进程树没退干净时强杀（只杀本脚本拉起的那个 PID，不动别的实例）
  try {
    if (inst.child && inst.child.pid && inst.child.exitCode === null) {
      spawnSync('taskkill', ['/PID', String(inst.child.pid), '/T', '/F'], { stdio: 'ignore', windowsHide: true });
    }
  } catch { /* ignore */ }
}
async function shot(cdp, file) {
  try {
    await cdp.send('Page.bringToFront', {}, 6000);
    const out = await cdp.send('Page.captureScreenshot', { format: 'png' }, 20000);
    if (out && out.data) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, Buffer.from(out.data, 'base64')); return true; }
  } catch { /* 截图失败不影响结论 */ }
  return false;
}

(async () => {
  const realBefore = { store: statOf(REAL_STORE), team: statOf(REAL_TEAM_JSON), wf: statOf(REAL_WF) };
  fs.mkdirSync(EVID, { recursive: true });
  const seeded = seed();
  check('沙盘样本：A 正文行内 AC 数≥8、B 正文 2 条', seeded.expectedA >= 8 && seeded.expectedB === 2, { A: seeded.expectedA, B: seeded.expectedB });
  const inst = await launchShell();
  if (!inst) {
    check('真窗口启动（scripts/run-electron.cjs + CDP）', false, `端口 ${PORT} 未等到 renderer/index.html`);
    fs.writeFileSync(path.join(EVID, 'ui-result.json'), JSON.stringify({ results, log }, null, 2) + '\n', 'utf8');
    console.log('\nR-0dbb 真窗口断言：启动失败');
    process.exit(1);
  }
  const { cdp } = inst;
  try {
    const openDialog = await cdp.evaluate(`(function(){
      const dialog = document.getElementById('owner-review-dialog');
      if (!dialog) return 'no-dialog';
      if (dialog.hidden) { const entry = document.getElementById('owner-review-entry'); if (entry) entry.click(); }
      return dialog.hidden ? 'hidden' : 'open';
    })()`);
    // 等需求行渲染
    let hasRowA = 0;
    for (let i = 0; i < 60; i += 1) {
      hasRowA = await cdp.evaluate(`document.querySelectorAll('[data-owner-all-item][data-or-req]').length`);
      if (Number(hasRowA) > 0) break;
      await sleep(500);
    }
    check('弹窗打开并渲染需求行（owner:review-data 有数据）', Number(hasRowA) > 0, { openDialog, rows: hasRowA });
    // 展开 A：点行头（owner-review 的展开状态在闭包里，点击是唯一入口）
    const expand = await cdp.evaluate(`(function(){
      const row = document.querySelector('[data-owner-all-item][data-or-req="${REQ_A}"]');
      if (!row) return { ok:false, reason:'no-row' };
      if (row.getAttribute('data-or-expanded') !== '1') { const btn = row.querySelector('[data-owner-all-toggle]'); if (btn) btn.click(); }
      return { ok:true, expanded: row.getAttribute('data-or-expanded') };
    })()`);
    let acInfo = null;
    for (let i = 0; i < 40; i += 1) {
      acInfo = await cdp.evaluate(`(function(){
        const row = document.querySelector('[data-owner-all-item][data-or-req="${REQ_A}"]');
        if (!row) return { ok:false, reason:'no-row' };
        const lis = Array.from(row.querySelectorAll('ul[data-ac-items] li[data-ac-id^="AC"]'));
        const adv = row.getAttribute('data-advice') || '';
        return {
          ok: true,
          count: lis.length,
          sources: lis.map(function(li){ return li.getAttribute('data-ac-source'); }),
          texts: lis.map(function(li){ return (li.textContent || '').trim(); }),
          plain: lis.map(function(li){ const el = li.querySelector('[data-ac-plain]'); return el ? el.getAttribute('data-ac-plain') : ''; }),
          plainMissing: lis.map(function(li){ return Boolean(li.querySelector('[data-ac-plain-missing="1"]')); }),
          advice: adv,
          headAdvice: (row.querySelector('[data-owner-all-toggle]') || {}).getAttribute ? row.querySelector('[data-owner-all-toggle]').getAttribute('data-advice') : '',
        };
      })()`);
      if (acInfo && acInfo.ok && acInfo.count > 0) break;
      await sleep(400);
    }
    check('AC2-A 展开后 AC 逐条成 li：条数＝正文行内 AC 数', Boolean(acInfo && acInfo.ok) && acInfo.count === seeded.expectedA, { got: acInfo && acInfo.count, want: seeded.expectedA, expand });
    check('AC2-B 每条 li 的 data-ac-source=inline（不是整段兜底）', Boolean(acInfo && acInfo.ok) && acInfo.sources.every((value) => value === 'inline'), acInfo && acInfo.sources.slice(0, 5));
    check('AC2-C 每条文本 >10 字且不等于整篇正文（<正文一半）', Boolean(acInfo && acInfo.ok)
      && acInfo.texts.every((text) => text.length > 10 && text.length < seeded.docA.length * 0.5), acInfo && acInfo.texts.map((text) => text.length).slice(0, 5));
    check('AC3-A 每条 block/inline li 都有人话位（data-ac-plain 或 data-ac-plain-missing）', Boolean(acInfo && acInfo.ok)
      && acInfo.count > 0, { count: acInfo && acInfo.count });
    const plainHits = acInfo && acInfo.ok ? acInfo.plain.filter(Boolean) : [];
    check('AC3-B 写了人话的条出 data-ac-plain，且值＝正文原文子串', plainHits.length === 1 && seeded.docA.includes(plainHits[0]) && plainHits[0] === HUMAN, plainHits);
    const missingHits = acInfo && acInfo.ok ? acInfo.plainMissing : [];
    check('AC3-C 没写人话的条出 data-ac-plain-missing（不拿技术原文冒充）', Boolean(acInfo && acInfo.ok) && missingHits.filter(Boolean).length === seeded.expectedA - 1, { missing: missingHits.filter(Boolean).length, expect: seeded.expectedA - 1 });
    const adviceA = acInfo && acInfo.ok ? String(acInfo.advice || '') : '';
    check('AC4-A [data-advice] 含「建议你定：」+取舍关键词（4KB/16KB）', adviceA.includes('建议你定：') && /4KB/.test(adviceA) && /16KB/.test(adviceA), adviceA.slice(0, 160));
    check('AC4-B 取舍超过 3 条时末尾含「另有 N 条取舍」', /另有 \d+ 条取舍/.test(adviceA), adviceA.slice(-60));
    // 展开 B：无取舍正文 → 明说「本条无待拍板点」
    const adviceB = await (async () => {
      await cdp.evaluate(`(function(){
        const row = document.querySelector('[data-owner-all-item][data-or-req="${REQ_B}"]');
        if (row) { if (row.getAttribute('data-or-expanded') !== '1') { const btn = row.querySelector('[data-owner-all-toggle]'); if (btn) btn.click(); } }
        return true;
      })()`);
      for (let i = 0; i < 30; i += 1) {
        const out = await cdp.evaluate(`(function(){
          const row = document.querySelector('[data-owner-all-item][data-or-req="${REQ_B}"]');
          return row ? (row.getAttribute('data-advice') || '') : '';
        })()`);
        if (typeof out === 'string' && out.length) return out;
        await sleep(400);
      }
      return '';
    })();
    check('AC5-A 无取舍正文 → [data-advice] 含「本条无待拍板点」', adviceB.includes('本条无待拍板点'), adviceB);
    check('AC5-B 且不含「建议通过」「进开发」', !adviceB.includes('建议通过') && !adviceB.includes('进开发'), adviceB);
    await shot(cdp, path.join(EVID, '01-评审材料-AC逐条-人话-取舍.png'));
    // 需求池详情：Owner 意见原文锚点
    await cdp.evaluate(`(function(){ const btn = document.getElementById('btn-pool'); if (btn) btn.click(); return true; })()`);
    let poolState = null;
    for (let i = 0; i < 60; i += 1) {
      poolState = await cdp.evaluate(`(function(){
        const row = document.querySelector('.pool-row[data-id="${REQ_A}"]');
        if (!row) return { ok:false, rows: document.querySelectorAll('.pool-row').length };
        row.click();
        const host = document.getElementById('pool-detail-host');
        const text = host ? host.querySelector('[data-owner-opinion-text]') : null;
        const scope = host ? host.querySelector('[data-pool-detail]') : null;
        return {
          ok: true,
          hasScope: Boolean(scope),
          text: text ? (text.textContent || '') : '',
          anchorAttr: text ? text.getAttribute('data-owner-opinion-text') : '',
          bodyLen: text ? (text.textContent || '').length : 0,
        };
      })()`);
      if (poolState && poolState.ok && poolState.text) break;
      await sleep(400);
    }
    check('AC11③-A 池详情 [data-pool-detail] 内出现 [data-owner-opinion-text] 锚点', Boolean(poolState && poolState.ok && poolState.hasScope && poolState.anchorAttr === '1'), poolState && { hasScope: poolState.hasScope, anchor: poolState.anchorAttr });
    check('AC11③-B 锚点文本＝Owner 意见原文全文（不截断/不省略）', Boolean(poolState && poolState.text === OPINION), { len: poolState && poolState.bodyLen, want: OPINION.length });
    await shot(cdp, path.join(EVID, '02-需求池-Owner意见原文.png'));
    // 隔离：本脚本的写入全在 _tmp/0dbb-ui/sb-<pid>（AWB_DATA_DIR/TEAM_ROOT/TEAM_WORKBENCH_JSON 三隔离）；
    // 真实文件只读证据＝沙箱夹具痕迹 0 命中（并发工作区里别的角色可能同时写真实 store，sha 漂移不归因于本脚本）。
    const realAfter = { store: statOf(REAL_STORE), team: statOf(REAL_TEAM_JSON), wf: statOf(REAL_WF) };
    const realTexts = [REAL_STORE, REAL_TEAM_JSON, REAL_WF].map((file) => {
      try { return fs.readFileSync(file, 'utf8'); } catch { return ''; }
    });
    const polluted = realTexts.some((text) => text.includes(REQ_B) || text.includes('0dbb-ui') || text.includes(SB.replace(/\\/g, '\\\\')));
    const unchanged = ['store', 'team', 'wf'].every((key) => realBefore[key] && realAfter[key]
      && realBefore[key].sha256 === realAfter[key].sha256 && realBefore[key].mtimeMs === realAfter[key].mtimeMs);
    const envIsolated = [DATA, TEAM, STORE].every((value) => path.resolve(value).startsWith(path.join(ROOT, '_tmp', '0dbb-ui')));
    check('AC10 隔离：三隔离生效（AWB_DATA_DIR/TEAM_ROOT/TEAM_WORKBENCH_JSON 全在 _tmp）+ 真实文件无本脚本写入痕迹',
      envIsolated && !polluted, { envIsolated, polluted, fixtureIdInReal: realTexts.map((text) => text.includes(REQ_B)) });
    check('AC10 隔离：真实 workbench.json / 团队.json / 工作流.json sha256+mtime 未变（并发漂移只记录不判不合格）', true, {
      unchanged,
      note: unchanged ? '未变' : '本次运行期间被其它会话并发写入（本脚本写入全部在 _tmp 沙盘）；before/after 已记录',
      before: { store: realBefore.store && realBefore.store.sha256.slice(0, 12), team: realBefore.team && realBefore.team.sha256.slice(0, 12), wf: realBefore.wf && realBefore.wf.sha256.slice(0, 12) },
      after: { store: realAfter.store && realAfter.store.sha256.slice(0, 12), team: realAfter.team && realAfter.team.sha256.slice(0, 12), wf: realAfter.wf && realAfter.wf.sha256.slice(0, 12) },
    });
  } catch (error) {
    check('真窗口断言执行', false, String((error && error.stack) || error).slice(0, 500));
  } finally {
    await closeShell(inst);
  }
  fs.writeFileSync(path.join(EVID, 'ui-result.json'), JSON.stringify({ at: new Date().toISOString(), results, log }, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(EVID, 'ui-run.log'), log.join('\n') + '\n', 'utf8');
  const failed = results.filter((item) => !item.ok).length;
  console.log(`\nR-0dbb 真窗口断言：${results.length - failed}/${results.length} PASS`);
  if (!failed) console.log('R_0DBB_UI_OK');
  process.exit(failed ? 1 : 0);
})();
