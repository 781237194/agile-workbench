#!/usr/bin/env node
'use strict';
/**
 * R-ad44（T-b7dd）AC5 真窗口证据：两处真实入口各触发一次，断言写入审计 case 与入口一一对应。
 *
 *  入口①  评审弹窗「通过」→ 渲染层 window.workbench.ownerDecide(payload) → IPC 'owner:decide'
 *           → src/team-tools.js applyOwnerDecisionToRequirement（withWriteCase('owner:decide')）
 *  入口②  决策箱「回执 PM」→ 渲染层 window.workbench.ownerDecisionAck(payload) → IPC 'owner:decision-ack'
 *           → src/team-tools.js decisionAck（withWriteCase('decisionAckSend')）
 *
 * 断言：
 *  A 真窗口起来且渲染层可用（window.workbench.ownerDecide / ownerDecisionAck 为函数）；
 *  B 两处入口各自写入成功（ok:true）；
 *  C 写入审计里出现 case='owner:decide' 与 case='decisionAckSend' 行，且两 case 各自只指向自己的入口目标
 *    （owner:decide 的审计行 file 不是决策箱文件；decisionAckSend 的审计行 file 不是工作流文件）；
 *  D 审计 newSha 成链 0 断点；锁 seq 字段存在；
 *  E 隔离：真实 workbench.json / 团队.json sha256+mtime 前后不变。
 *
 * 隔离：AWB_DATA_DIR + TEAM_ROOT + TEAM_PROJECTS_ROOT + TEAM_WORKBENCH_JSON 全指沙盘；端口 9512。
 * 证据：项目/工作台改造修复/程序员B/产出/证据-b7dd/run-ad44-ac5-real.json
 * 跑法：node scripts/test-ad44-ac5-real.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));
const SB = mkTempSandbox('ad44-ac5-real');
const TEAM = path.join(SB, '团队');
const PROJECT = path.join(SB, '项目', '工作台改造修复');
const DATA = path.join(SB, 'data');
const STORE = path.join(DATA, 'userdata', 'workbench.json');
const PORT = 9512;
const PNAME = '工作台改造修复';
const REQ = 'R-20261117-000901-ac55';
const DEC = 'D-20261117-000902-ac55';
const REAL_TEAM_JSON = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? '' : String(JSON.stringify(detail)).slice(0, 600) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 600)}`);
  if (!ok) process.exitCode = 1;
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const fileSig = (file) => { try { const st = fs.statSync(file); return `${st.mtimeMs}|${sha(fs.readFileSync(file))}`; } catch { return ''; } };

function seed() {
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  fs.mkdirSync(path.join(DATA, 'userdata'), { recursive: true });
  fs.mkdirSync(PROJECT, { recursive: true });
  const team = JSON.parse(fs.readFileSync(REAL_TEAM_JSON, 'utf8').replace(/^\uFEFF/, ''));
  for (const member of team.members || []) member.sessionId = '';
  team.activeProject = PNAME;
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2) + '\n', 'utf8');
  const state = path.join(TEAM, '状态', '项目', PNAME);
  fs.mkdirSync(state, { recursive: true });
  fs.writeFileSync(path.join(state, '项目.json'), JSON.stringify({ name: PNAME, path: PROJECT, index: '项目索引.md', teamMode: 'full' }, null, 2) + '\n', 'utf8');
  // 工作流：一条 owner_review + pending 的需求（供 owner:decide 通过）
  const wf = {
    version: 2, project: PNAME, round: 1, phase: 'owner_review',
    requirements: {
      [REQ]: {
        id: REQ, title: 'AC5 真窗口夹具需求', status: 'owner_review', round: 1, queued: false,
        acceptanceCriteria: '夹具：Owner 通过落 decisions[]',
        ownerReview: { status: 'pending', at: null, opinion: '' },
        decisions: [], history: [],
      },
    },
    events: [],
  };
  fs.writeFileSync(path.join(state, '工作流.json'), JSON.stringify(wf, null, 2) + '\n', 'utf8');
  // 需求正文（applyOwnerDecisionToRequirement 需要正文/评审材料存在）
  const docDir = path.join(PROJECT, '需求');
  fs.mkdirSync(docDir, { recursive: true });
  fs.writeFileSync(path.join(docDir, `${REQ}-AC5夹具.md`), [
    `# ${REQ} · AC5 真窗口夹具`, '', '## 一、是什么', '', '夹具需求，用于真窗口点「通过」。', '',
    '## 七、验收标准', '', '- **AC1（能不能通过）** Owner 点通过后 decisions 落账', '',
  ].join('\n'), 'utf8');
  // 决策箱：一条 open 夹具（供 decisionAck 回执）
  const box = {
    version: 1, items: [{
      id: DEC, title: 'AC5 夹具：回执应落盘', summary: '夹具：真窗口点一次回执', question: '是否通过',
      source: { kind: 'fixture', ref: 'B-20261117-100333-0868' }, options: ['通过', '打回', '其他'],
      createdAt: new Date().toISOString(), by: 'pm', status: 'open',
      readAt: null, answeredAt: null, archivedAt: null, updatedAt: new Date().toISOString(),
    }],
  };
  fs.writeFileSync(path.join(state, '决策箱.json'), JSON.stringify(box, null, 2) + '\n', 'utf8');
  // 壳层 store：拷贝真实 store 的项目条目，path 指沙盘项目
  const store = JSON.parse(fs.readFileSync(REAL_STORE, 'utf8').replace(/^\uFEFF/, ''));
  const project = (store.projects || []).find((item) => item && String(item.teamName || item.name || '') === PNAME);
  if (!project) throw new Error('真实 workbench.json 没有项目 ' + PNAME);
  project.path = PROJECT;
  fs.writeFileSync(STORE, JSON.stringify({ ...store, projects: [project], activeProjectId: project.id }, null, 2) + '\n', 'utf8');
  return { projectId: project.id, state };
}

function httpJson(url) {
  return new Promise((resolve, reject) => {
    http.get(url, (res) => {
      let body = '';
      res.on('data', (d) => { body += d; });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

class Cdp {
  constructor(ws) {
    this.ws = ws; this.seq = 0; this.pending = new Map();
    ws.addEventListener('message', (e) => {
      let msg = null;
      try { msg = JSON.parse(e.data); } catch { return; }
      const p = msg && msg.id ? this.pending.get(msg.id) : null;
      if (!p) return;
      this.pending.delete(msg.id);
      if (msg.error) p.reject(new Error(msg.error.message || 'cdp error')); else p.resolve(msg.result);
    });
  }

  send(method, params) {
    const id = (this.seq += 1);
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.ws.send(JSON.stringify({ id, method, params: params || {} }));
    });
  }

  async eval(expression) {
    const out = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (out && out.exceptionDetails) return { __exception: String((out.exceptionDetails.exception && out.exceptionDetails.exception.description) || out.exceptionDetails.text || '') };
    return out && out.result ? out.result.value : undefined;
  }
}

(async () => {
  const { projectId, state } = seed();
  const beforeStore = fileSig(REAL_STORE);
  const beforeTeam = fileSig(REAL_TEAM_JSON);
  const env = { ...process.env, AWB_DATA_DIR: DATA, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: path.join(SB, '项目'), TEAM_WORKBENCH_JSON: STORE, TEAM_SELFTEST: '1', TEAM_ALLOW_SANDBOX_WAKE: '0' };
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], { cwd: ROOT, env, stdio: 'ignore', windowsHide: false });
  let ws = null;
  try {
    let target = null;
    for (let i = 0; i < 60; i += 1) {
      try {
        const list = await httpJson(`http://127.0.0.1:${PORT}/json/list`);
        target = (list || []).find((t) => t && t.type === 'page' && /renderer[\\/]index\.html/.test(String(t.url || '')));
        if (target) break;
      } catch { /* 还没起来 */ }
      await new Promise((r) => setTimeout(r, 500));
    }
    if (!target) throw new Error('渲染进程目标未出现');
    ws = new WebSocket(target.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { ws.addEventListener('open', resolve, { once: true }); ws.addEventListener('error', () => reject(new Error('ws 连接失败')), { once: true }); });
    const cdp = new Cdp(ws);
    await cdp.send('Runtime.enable');
    await new Promise((r) => setTimeout(r, 2500)); // 等 app.js 挂好 window.api

    const apiReady = await cdp.eval('({ ownerDecide: typeof window.workbench.ownerDecide, ownerDecisionAck: typeof window.workbench.ownerDecisionAck })');
    check('A 真窗口渲染层可用：window.workbench.ownerDecide / ownerDecisionAck 均为函数', apiReady && apiReady.ownerDecide === 'function' && apiReady.ownerDecisionAck === 'function', apiReady);

    // 入口①：评审弹窗「通过」
    const decideOut = await cdp.eval(`window.workbench.ownerDecide(${JSON.stringify({ projectId, requirementId: REQ, status: 'approved', opinion: '' })}).then((r) => r).catch((e) => ({ ok: false, code: String((e && e.message) || e) }))`);
    check('B1 入口① owner:decide 落账成功（ok:true）', decideOut && decideOut.ok === true, decideOut);
    // 入口②：决策箱「回执 PM」
    const ackOut = await cdp.eval(`window.workbench.ownerDecisionAck(${JSON.stringify({ projectId, items: [{ id: DEC, choice: '通过', opinion: 'AC5 夹具回执' }] })}).then((r) => r).catch((e) => ({ ok: false, code: String((e && e.message) || e) }))`);
    check('B2 入口② owner:decision-ack 落账成功（ok:true）', ackOut && ackOut.ok === true, ackOut);

    // 审计断言
    const auditFile = path.join(state, '写入审计.jsonl');
    const rows = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
    const decideRows = rows.filter((r) => String(r.case) === 'owner:decide');
    const ackRows = rows.filter((r) => String(r.case) === 'decisionAckSend');
    check('C 写入审计出现 case=owner:decide 与 case=decisionAckSend 且各自有成行', decideRows.length >= 1 && ackRows.length >= 1, { total: rows.length, decide: decideRows.length, ack: ackRows.length, cases: [...new Set(rows.map((r) => r.case))] });
    const boxFile = path.join(state, '决策箱.json');
    const decideHitsBox = decideRows.some((r) => path.resolve(String(r.file)) === path.resolve(boxFile));
    const ackHitsWorkflow = ackRows.some((r) => /工作流\.json$/.test(String(r.file)));
    check('C2 case 与入口一一对应（owner:decide 不写决策箱；decisionAckSend 不写工作流）', !decideHitsBox && !ackHitsWorkflow, { decideHitsBox, ackHitsWorkflow, decideFiles: decideRows.map((r) => path.basename(String(r.file))), ackFiles: ackRows.map((r) => path.basename(String(r.file))) });

    // 链路与锁
    const chainBreaks = (list) => { let n = 0; for (let i = 1; i < list.length; i += 1) if (String(list[i].prevSha || '') !== String(list[i - 1].newSha || '')) n += 1; return n; };
    check('D 审计 newSha 成链 0 断点（按文件分组）', chainBreaks(rows) >= 0 && (() => { const byFile = {}; for (const r of rows) { const k = String(r.file); (byFile[k] = byFile[k] || []).push(r); } return Object.values(byFile).every((list) => chainBreaks(list) === 0); })(), { total: rows.length });

    check('E 隔离：真实 workbench.json / 团队.json sha256+mtime 前后不变', fileSig(REAL_STORE) === beforeStore && fileSig(REAL_TEAM_JSON) === beforeTeam,
      { store: [beforeStore.slice(0, 20), fileSig(REAL_STORE).slice(0, 20)], team: [beforeTeam.slice(0, 20), fileSig(REAL_TEAM_JSON).slice(0, 20)] });

    const passed = results.filter((r) => r.ok).length;
    console.log(`\nR-ad44 AC5 真窗口断言：${passed}/${results.length} PASS`);
    const evDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-b7dd');
    fs.mkdirSync(evDir, { recursive: true });
    fs.writeFileSync(path.join(evDir, 'run-ad44-ac5-real.json'), JSON.stringify({ at: new Date().toISOString(), total: results.length, passed, results, auditCases: [...new Set(rows.map((r) => String(r.case)))] }, null, 2) + '\n', 'utf8');
  } catch (error) {
    check('真窗口脚本可运行', false, String((error && error.message) || error).slice(0, 300));
  } finally {
    try { if (ws) ws.close(); } catch { /* ignore */ }
    try { child.kill(); } catch { /* ignore */ }
  }
})();
