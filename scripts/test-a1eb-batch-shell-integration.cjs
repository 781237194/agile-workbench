#!/usr/bin/env node
'use strict';
/**
 * test-a1eb-batch-shell-integration.cjs —— R-a1eb / T-20261119-141958-16dd（壳层侧④）集成夹具。
 *
 * 干什么：在**隔离沙盘**里用真实工具命令建一个真实项目和六人团队（不是手写 JSON 合成夹具），
 * 跑 `session rotate --batch`（2 个角色），然后断言壳层关心的四件事：
 *   A 他人不被废：换人**之前**拿到的 pm / analyst 令牌，在批量换人之后继续写成功（不出现 RULES_CHANGED）；
 *   B 旧会话写被拒：被替换的旧 sessionId 令牌写 → SESSION_REPLACED，且**零写入**（账本 sha 不变）；
 *   C 只广播一次：同一批 2 个角色 → 每个 active 成员各收到恰好 1 条系统广播（不是每角色一条）；
 *   D 隔离：真实 `团队/状态/团队.json` 零写入。
 * 追加 `--electron`：再起一个真实壳层指向同一沙盘 TEAM_ROOT，执行一次 batch rotate，断言渲染层
 *   `__rosterPushStats`：一次推送（events=1）→ 一次名册同步（pushSyncs=1），不按角色重复刷新。
 *
 * 说明：工具层实现属程序员A（T-20261119-141943-0cda）。本夹具只做**壳层侧**断言；
 * 若工具层尚未落地，夹具会把缺失能力标成 SKIP 而不是假装通过。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TEAM_TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const WANT_ELECTRON = process.argv.includes('--electron');
const OUT = (() => {
  const i = process.argv.indexOf('--out');
  return i > 0 && process.argv[i + 1]
    ? path.resolve(process.argv[i + 1])
    : path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-a1eb-batch');
})();

const rows = [];
const skipped = [];
function check(name, ok, detail) {
  let text = '';
  try { text = JSON.stringify(detail === undefined ? null : detail); } catch { text = String(detail); }
  rows.push({ name, ok: Boolean(ok), detail: ok ? undefined : text });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : ' :: ' + text.slice(0, 700)));
}
function skip(name, detail) {
  skipped.push({ name, detail: String(detail || '') });
  console.log('SKIP  ' + name + ' :: ' + String(detail || ''));
}
function sha(file) { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return '-'; } }
function shaDir(dir) {
  const list = [];
  const walk = (d) => {
    let ents = [];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { return; }
    for (const e of ents.sort((a, b) => a.name.localeCompare(b.name))) {
      const p = path.join(d, e.name);
      if (e.isDirectory()) walk(p);
      else list.push(path.relative(dir, p).split(path.sep).join('/') + ':' + sha(p));
    }
  };
  walk(dir);
  return list.join('|');
}
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

const HANDOVER_TEXT = [
  '【在途任务】无',
  '【未闭环事项】无',
  '【最近决策】无',
  '【建议下一步】无',
  '【遗留问题与坑】无已知坑',
].join('\n');

const PROJECT = '沙盘项目';
const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'a1eb-batch-'));
const teamDir = path.join(sb, '团队');
const projectsDir = path.join(sb, '项目');
const dataDir = path.join(sb, 'data');
const projectDir = path.join(projectsDir, PROJECT);
const env = {
  ...process.env,
  TEAM_ROOT: teamDir,
  TEAM_PROJECTS_ROOT: projectsDir,
  TEAM_WORKBENCH_JSON: path.join(dataDir, 'workbench.json'),
  AWB_DATA_DIR: dataDir,
  AWB_ROUTE_DAEMON: 'off',
  TEAM_SELFTEST: '1',
  TEAM_ROTATE_HANDOVER_TEXT: HANDOVER_TEXT,
};

function run(args) {
  const r = spawnSync(process.execPath, [TEAM_TOOL, ...args], {
    cwd: ROOT, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024,
  });
  const stdout = String(r.stdout || '');
  const stderr = String(r.stderr || '');
  let json = null;
  const start = stdout.indexOf('{');
  if (start >= 0) { try { json = JSON.parse(stdout.slice(start)); } catch { json = null; } }
  return { code: r.status, stdout, stderr, json, out: stdout + stderr };
}

function collectMailbox(rootTeamDir) {
  // 真实路径：团队/状态/邮箱/<role>/{new,cur}
  const mailRoot = path.join(rootTeamDir, '状态', '邮箱');
  const items = [];
  let roleDirs = [];
  try {
    roleDirs = fs.readdirSync(mailRoot, { withFileTypes: true })
      .filter((e) => e.isDirectory()).map((e) => path.join(mailRoot, e.name));
  } catch { return items; }
  for (const roleDir of roleDirs) {
    for (const box of ['new', 'cur']) {
      const dir = path.join(roleDir, box);
      let names = [];
      try { names = fs.readdirSync(dir); } catch { continue; }
      for (const name of names) {
        if (!name.endsWith('.json')) continue;
        try {
          const data = JSON.parse(fs.readFileSync(path.join(dir, name), 'utf8'));
          items.push({
            role: path.basename(roleDir), box, name,
            subject: String(data.subject || ''), from: String(data.from || ''),
            id: String(data.id || name),
          });
        } catch { /* 非 JSON 消息文件忽略 */ }
      }
    }
  }
  return items;
}

function readBootQueueItems(rootTeamDir) {
  // 真实路径：团队/状态/项目/<项目slug>/待启动队列.json（items[]）；这里按目录扫，避免 slug 规则耦合。
  const base = path.join(rootTeamDir, '状态', '项目');
  const out = [];
  let dirs = [];
  try { dirs = fs.readdirSync(base, { withFileTypes: true }).filter((e) => e.isDirectory()).map((e) => path.join(base, e.name)); } catch { return out; }
  for (const dir of dirs) {
    const file = path.join(dir, '待启动队列.json');
    if (!fs.existsSync(file)) continue;
    try {
      const data = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (Array.isArray(data.items)) out.push(...data.items);
    } catch { /* ignore */ }
  }
  return out;
}

function readRosterAudit(rootTeamDir) {
  const file = path.join(rootTeamDir, '状态', '项目', PROJECT, '名册变更.jsonl');
  const lines = [];
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      if (!line.trim()) continue;
      try { lines.push(JSON.parse(line)); } catch { /* ignore */ }
    }
  } catch { /* 无审计文件 */ }
  return lines;
}

async function connectCdp(port) {
  const list = await new Promise((resolve, reject) => {
    const req = http.get(`http://127.0.0.1:${port}/json/list`, (res) => {
      let body = '';
      res.on('data', (d) => { body += String(d); });
      res.on('end', () => { try { resolve(JSON.parse(body)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.setTimeout(5000, () => { req.destroy(new Error('cdp list timeout')); });
  });
  const targets = Array.isArray(list) ? list : [];
  const target = targets.find((t) => t && t.webSocketDebuggerUrl && t.type === 'page' && !/^devtools:/i.test(String(t.url || '')))
    || targets.find((t) => t && t.webSocketDebuggerUrl && t.type === 'page');
  if (!target) throw new Error('no page target');
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { ws.onopen = resolve; ws.onerror = () => reject(new Error('ws open failed')); });
  const evaluate = (expr, ms = 20000) => new Promise((resolve, reject) => {
    const id = Math.floor(Math.random() * 1e6);
    const timer = setTimeout(() => reject(new Error('evaluate timeout')), ms);
    const onMsg = (ev) => {
      let msg = null;
      try { msg = JSON.parse(String(ev.data)); } catch { return; }
      if (!msg || msg.id !== id) return;
      clearTimeout(timer);
      ws.removeEventListener('message', onMsg);
      if (msg.error) reject(new Error(JSON.stringify(msg.error)));
      else resolve(msg.result && msg.result.result ? msg.result.result.value : undefined);
    };
    ws.addEventListener('message', onMsg);
    ws.send(JSON.stringify({ id, method: 'Runtime.evaluate', params: { expression: expr, returnByValue: true, awaitPromise: true } }));
  });
  return { evaluate, close: () => { try { ws.close(); } catch { /* ignore */ } } };
}

(async () => {
  let child = null;
  try {
    // ── 0) 真实初始化：团队 + 项目（生产同一套 init / project create）──────────
    const realRoster = path.join(ROOT, '团队', '状态', '团队.json');
    const realRosterBefore = sha(realRoster);
    const init = run(['init', '--json']);
    check('I1 team.mjs init 成功（真实团队结构，不是手写 JSON）', Boolean(init.json && init.json.ok === true), init.out.slice(0, 400));
    const proj = run(['project', 'create', '--name', PROJECT, '--dir', projectDir, '--json']);
    check('I2 project create 成功（真实项目目录 + 六角色结构）',
      Boolean(proj.json && proj.json.ok === true && proj.json.project && String(proj.json.project.path) === path.resolve(projectDir)),
      proj.out.slice(0, 500));

    // ── 1) 扩编到真实六人团队（PM 令牌 + roster add，走生产同一入口）──────────
    const pmBoot0 = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'session-sandbox-pm-0001', '--json']);
    const pmToken0 = pmBoot0.json && pmBoot0.json.token ? String(pmBoot0.json.token) : '';
    const addRoles = ['product', 'analyst', 'programmer2', 'tester'];
    const addResults = addRoles.map((role) => run(['roster', 'add', '--role', role, '--boot', pmToken0, '--force', '--reason', '夹具：建真实六人团队', '--json']));
    const rosterList = run(['roster', 'list', '--json']);
    const memberRoles = rosterList.json && Array.isArray(rosterList.json.members)
      ? rosterList.json.members.map((m) => String((m && m.role) || '')) : [];
    check('B1 真实六人团队：roster add 四个角色后名册齐全',
      ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'].every((r) => memberRoles.includes(r)),
      { memberRoles, adds: addResults.map((r) => (r.json ? r.json.ok : r.out.slice(0, 120))) });

    // ── 1b) 给六个角色各落一个真实会话映射（四处映射一致），后面「他人不被废」才有可比基线 ──
    const bootstrapIds = {
      pm: 'session-sandbox-pm-0001', product: 'session-sandbox-pr-0001', analyst: 'session-sandbox-an-0001',
      programmer1: 'session-sandbox-p1-0000', programmer2: 'session-sandbox-p2-0000', tester: 'session-sandbox-t-0000',
    };
    const bootRot = run(['session', 'rotate', '--batch', '--project', PROJECT,
      '--roles', Object.keys(bootstrapIds).join(','),
      '--sessions', Object.entries(bootstrapIds).map(([r, id]) => `${r}=${id}`).join(','),
      '--offline', '--reason', '夹具：六角色初始会话映射', '--json']);
    check('B2 六角色初始会话映射一次落盘（四处映射一致，后续才有「旧会话」可比）',
      Boolean(bootRot.json && bootRot.json.ok === true), bootRot.out.slice(0, 500));

    // 换人前拿 pm / analyst 令牌（映射落盘后重签，保证令牌会话 == 名册当前）
    const pmBoot = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', bootstrapIds.pm, '--json']);
    const pmToken = pmBoot.json && pmBoot.json.token ? String(pmBoot.json.token) : '';
    const analystBoot = run(['boot', '--role', 'analyst', '--project', PROJECT, '--session', bootstrapIds.analyst, '--json']);
    const analystToken = analystBoot.json && analystBoot.json.token ? String(analystBoot.json.token) : '';
    check('B0 换人前 pm / analyst 令牌可用', Boolean(pmToken) && Boolean(analystToken),
      { pm: pmBoot.out.slice(0, 200), analyst: analystBoot.out.slice(0, 200) });
    check('B0b boot 输出带 rosterVersion 前 12 位（§6.5 可观测）',
      Boolean(pmBoot.json && String(pmBoot.json.rosterVersion || '').length >= 12),
      pmBoot.json && { rosterVersion: pmBoot.json.rosterVersion, rulesHash: pmBoot.json.rulesHash });

    // ── 2) 批量换人（2 角色）──────────────────────────────────────────────
    const mailBefore = collectMailbox(teamDir);
    const bqBefore = readBootQueueItems(teamDir);
    const rot1 = run(['session', 'rotate', '--batch', '--project', PROJECT, '--roles', 'programmer1,programmer2',
      '--sessions', 'programmer1=session-sandbox-p1-a,programmer2=session-sandbox-p2-a',
      '--offline', '--reason', '夹具：批量换人 2 角色', '--json']);
    const rot1Json = rot1.json || {};
    const batchSupported = Boolean(rot1Json && (rot1Json.batch === true || Array.isArray(rot1Json.roles)
      || rot1Json.code === 'HANDOVER_INCOMPLETE' || rot1Json.code === 'BAD_SESSION'));
    if (!batchSupported) {
      skip('C1–C9 批量换人集成（依赖 A 的 T-20261119-141943-0cda）',
        `工具层 batch 入口不可用：code=${rot1Json.code || 'NO_JSON'} ${rot1.out.slice(0, 300)}`);
    } else {
      check('C1 batch rotate 成功（2 角色，一次事务写名册）',
        rot1Json.ok === true && Array.isArray(rot1Json.roles) && rot1Json.roles.length === 2, rot1.out.slice(0, 700));
      check('C2 返回体 broadcast=1 / bootPending=2',
        Number(rot1Json.broadcast) === 1 && Number(rot1Json.bootPending) === 2,
        { broadcast: rot1Json.broadcast, bootPending: rot1Json.bootPending });
      check('C3 rosterVersion 前后不同（名册真变了）',
        String(rot1Json.rosterVersionBefore || '') !== String(rot1Json.rosterVersionAfter || '') && Boolean(rot1Json.rosterVersionAfter),
        { before: rot1Json.rosterVersionBefore, after: rot1Json.rosterVersionAfter });

      // C4 只广播一次：同一批 → 每个 active 成员恰好 1 条系统广播
      const mailAfter = collectMailbox(teamDir);
      const newSys = mailAfter.filter((m) => m.from === 'system'
        && m.subject.includes('批量换人 2 个角色') && m.subject.includes('programmer1') && m.subject.includes('programmer2'));
      const byRole = new Map();
      for (const m of newSys) byRole.set(m.role, (byRole.get(m.role) || 0) + 1);
      const dup = [...byRole.entries()].filter(([, n]) => n > 1);
      check('C4 批量广播只发一轮：每个收件人恰好 1 条（无按角色重复）',
        newSys.length >= 1 && dup.length === 0 && byRole.size >= 2,
        { recipients: [...byRole.entries()], total: newSys.length, dup, before: mailBefore.length });

      // C5 BQ：2 条（每个被换角色 1 条）。注意队列是「每角色一条」（同角色替换而非追加），
      // 所以不能断言总条数增加，只能断言这两个角色的条目已指向本批新会话。
      const bqAfter = readBootQueueItems(teamDir);
      const bqNew = bqAfter.filter((it) => ['session-sandbox-p1-a', 'session-sandbox-p2-a'].includes(String(it.sessionId || '')));
      const bqRoles = bqNew.map((it) => String(it.role || '')).sort();
      check('C5 待启动队列新增 2 条（每个被换角色 1 条，指向本批新会话）',
        bqNew.length === 2 && bqRoles.join(',') === 'programmer1,programmer2',
        { added: bqNew.length, roles: bqRoles, before: bqBefore.length, after: bqAfter.length });

      // C6 名册变更审计：1 行 batch 汇总（字段齐）
      const audit = readRosterAudit(teamDir);
      const batchRows = audit.filter((row) => row && row.event === 'roster_rotate_batch');
      const lastBatch = batchRows[batchRows.length - 1];
      check('C6 名册变更.jsonl 有 batch 汇总行且字段齐（batchId/roles/by/at/rosterVersionBefore/After）',
        Boolean(lastBatch) && Boolean(lastBatch.batchId) && Array.isArray(lastBatch.roles) && Boolean(lastBatch.by)
        && Boolean(lastBatch.at) && 'rosterVersionBefore' in lastBatch && 'rosterVersionAfter' in lastBatch,
        lastBatch || audit.slice(-3));

      // ── 3) 他人不被废：换人前拿到的 pm / analyst 令牌照常写 ────────────────
      const pmSend = run(['send', '--boot', pmToken, '--to', 'tester', '--subject', '换人后仍可写（pm）',
        '--body', 'C7：批量换人后旧令牌不被废（不出现 RULES_CHANGED）', '--json']);
      const pmJson = pmSend.json || {};
      check('C7 未参与换人的 pm 令牌在换人后仍写成功（无 RULES_CHANGED）',
        pmJson.ok === true && pmJson.code !== 'RULES_CHANGED', { code: pmJson.code, message: String(pmJson.message || '').slice(0, 200) });
      const anSend = run(['send', '--boot', analystToken, '--to', 'tester', '--subject', '换人后仍可写（analyst）',
        '--body', 'C7b：批量换人后旧令牌不被废', '--json']);
      const anJson = anSend.json || {};
      check('C7b analyst 令牌同样不受影响（唯一硬校验只看自己）',
        anJson.ok === true && anJson.code !== 'RULES_CHANGED', { code: anJson.code, message: String(anJson.message || '').slice(0, 200) });

      // ── 4) 旧会话写被拒 + 零写入 ─────────────────────────────────────────
      const p1old = run(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 'session-sandbox-p1-a', '--json']);
      const p1oldToken = p1old.json && p1old.json.token ? String(p1old.json.token) : '';
      const rot2 = run(['session', 'rotate', '--batch', '--project', PROJECT, '--roles', 'programmer1',
        '--sessions', 'programmer1=session-sandbox-p1-b', '--offline', '--reason', '夹具：替换 programmer1 会话', '--json']);
      check('C8 第二次批量换人（替换 programmer1）成功', Boolean(rot2.json && rot2.json.ok === true), rot2.out.slice(0, 400));
      const rosterFile = path.join(teamDir, '状态', '团队.json');
      const ledgerBefore = {
        roster: sha(rosterFile),
        mail: shaDir(path.join(teamDir, '邮箱')),
        board: sha(path.join(teamDir, '看板.md'))
      };
      const oldWrite = run(['send', '--boot', p1oldToken, '--to', 'tester', '--subject', '旧会话尝试写',
        '--body', '应当被 SESSION_REPLACED 拒绝', '--json']);
      const oldJson = oldWrite.json || {};
      const ledgerAfter = {
        roster: sha(rosterFile),
        mail: shaDir(path.join(teamDir, '邮箱')),
        board: sha(path.join(teamDir, '看板.md'))
      };
      check('C9 旧会话写被硬拒：SESSION_REPLACED',
        oldJson.ok === false && oldJson.code === 'SESSION_REPLACED', { code: oldJson.code, message: String(oldJson.message || '').slice(0, 200) });
      check('C10 拒绝路径零写入（团队.json / 邮箱 / 看板 sha 全不变）',
        ledgerAfter.roster === ledgerBefore.roster && ledgerAfter.mail === ledgerBefore.mail && ledgerAfter.board === ledgerBefore.board,
        {
          before: { roster: ledgerBefore.roster.slice(0, 12), mailLen: ledgerBefore.mail.length, board: ledgerBefore.board.slice(0, 12) },
          after: { roster: ledgerAfter.roster.slice(0, 12), mailLen: ledgerAfter.mail.length, board: ledgerAfter.board.slice(0, 12) },
        });

      // ── 5) 壳层侧：批量换人 → 界面只刷新一次（--electron）──────────────────
      if (WANT_ELECTRON) {
        const PORT = 19571 + Math.floor(Math.random() * 200);
        let out = '';
        child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], {
          cwd: ROOT, env: { ...env, AWB_START_HIDDEN: '1', AWB_SQ_PUSH_DISABLE: '0' }, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'],
        });
        child.stdout.on('data', (c) => { out += String(c || ''); });
        child.stderr.on('data', (c) => { out += String(c || ''); });
        const deadline = Date.now() + 45000;
        while (Date.now() < deadline && !/\[roster-push\] \{"event":"watch"/.test(out)) await sleep(200);
        check('S1 真实壳层在沙盘上进入推送模式（[roster-push] event=watch）', /\[roster-push\] \{"event":"watch"/.test(out), out.slice(-500));
        await sleep(2500);
        const pushBefore = (out.match(/\[roster-push\] \{"event":"broadcast"/g) || []).length;
        const rot3 = run(['session', 'rotate', '--batch', '--project', PROJECT, '--roles', 'tester,product',
          '--sessions', 'tester=session-sandbox-t-a,product=session-sandbox-pr-a',
          '--offline', '--reason', '夹具：壳层刷新一次', '--json']);
        check('S2 壳层运行期间再跑一次 batch rotate（2 角色）成功', Boolean(rot3.json && rot3.json.ok === true), rot3.out.slice(0, 400));
        await sleep(3000);
        const pushAfter = (out.match(/\[roster-push\] \{"event":"broadcast"/g) || []).length;
        check('S3 主进程：一次批量换人 → 恰好 1 次名册推送', pushAfter === pushBefore + 1, { before: pushBefore, after: pushAfter });
        let stats = null;
        try {
          const cdp = await connectCdp(PORT);
          stats = await cdp.evaluate('(typeof window.__rosterPushStats === "function" ? window.__rosterPushStats() : null)');
          cdp.close();
        } catch (error) {
          check('S4 渲染层钩子可读', false, String((error && error.message) || error));
        }
        if (stats) {
          check('S4 渲染层：1 次推送 → 1 次名册同步（events=1 / pushSyncs=1）',
            Number(stats.events) === 1 && Number(stats.pushSyncs) === 1, stats);
          check('S5 渲染层：未按角色重复刷新（coalescedRuns=0、syncs ≤ 2）',
            Number(stats.coalescedRuns) === 0 && Number(stats.syncs) <= 2, stats);
        } else if (!rows.some((r) => r.name.startsWith('S4'))) {
          check('S4 渲染层：1 次推送 → 1 次名册同步（events=1 / pushSyncs=1）', false, '未取到 __rosterPushStats');
        }
      } else {
        skip('S1–S5 壳层刷新一次（--electron）', '本次未加 --electron');
      }
    }

    // ── 6) 隔离：真实账本零写入 ───────────────────────────────────────────
    check('I3 隔离：真实 团队/状态/团队.json 零写入（sha 不变）',
      sha(realRoster) === realRosterBefore, { before: realRosterBefore.slice(0, 12), after: sha(realRoster).slice(0, 12) });
  } finally {
    try { if (child && child.pid) spawnSync('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true, stdio: 'ignore' }); } catch { /* ignore */ }
    try { await sleep(120); if (child) child.kill(); } catch { /* ignore */ }
    try { fs.rmSync(sb, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  const pass = rows.filter((r) => r.ok).length;
  const fail = rows.length - pass;
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'test-a1eb-batch-shell-integration.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      head: (() => { try { return spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(); } catch { return ''; } })(),
      task: 'T-20261119-141958-16dd', requirement: 'R-20261119-140657-a1eb',
      electron: WANT_ELECTRON, pass, fail, total: rows.length, skipped: skipped.length, rows, skippedRows: skipped,
    }, null, 2), 'utf8');
  } catch { /* ignore */ }
  console.log(`\n${pass}/${rows.length} PASS${fail ? ` · ${fail} FAIL` : ''}`);
  process.exit(fail ? 1 : 0);
})();
