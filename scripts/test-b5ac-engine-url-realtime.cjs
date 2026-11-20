#!/usr/bin/env node
'use strict';
/**
 * test-b5ac-engine-url-realtime.cjs — B-20261120-144358-b5ac（P2）夹具：
 * 路由唤醒 engineUrl 的实时源与「探活失败换端口」+ 失败回执带 upstream url / error code。
 *
 * 背景：团队/状态/当前工作区.json 的 engineUrl 指向死端口 62800（2026-11-18 后未刷新），
 * 路由唤醒 100% fetch failed。口径：
 *   ①engineUrlOf 增实时源：~/.dsh/gui.port（> 当前工作区.json），并保留 override/env/dsh.json；
 *   ②探活失败（网络类）→ 换端口重试一次（实时端口 / 工作区）；
 *   ③失败回执/PM 告警带 upstream url + error code，且 PM 只收一条（同 key 去重）；
 *   ④真不可达时不再静默：wake_failed 事件 + PM 消息。
 *
 * 用法：node scripts/test-b5ac-engine-url-realtime.cjs [--json]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const DAEMON_SRC = path.join(ROOT, '团队', '工具', 'lib', 'route-daemon.mjs');
const URL_SRC = path.join(ROOT, '团队', '工具', 'lib', 'dsh-url.mjs');
const JSON_OUT = process.argv.includes('--json');
const PROJECT = 'b5ac沙盘';
const ROLES = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
const SECRET = 'A'.repeat(43);

const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 800)}`);
  return Boolean(ok);
}
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '(missing)'; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
const jsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };
const mailOf = (dir) => {
  const out = [];
  for (const box of ['new', 'cur']) {
    let names = [];
    try { names = fs.readdirSync(path.join(dir, box)); } catch { names = []; }
    for (const n of names) {
      if (!n.endsWith('.json')) continue;
      const row = readJson(path.join(dir, box, n), null);
      if (row) out.push(row);
    }
  }
  return out;
};

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'b5ac-'));
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench.json');
const DATA = path.join(SB, 'data');
const DSH_HOME = path.join(SB, 'dshhome');
const STATE = path.join(TEAM, '状态', '项目', PROJECT);
const REAL_TEAM = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');

function env(extra = {}) {
  const base = { ...process.env };
  delete base.DSH_WEB_URL;
  delete base.DSH_WEB_PORT;
  delete base.DSH_PORT;
  delete base.AWB_TEAM_ROOT;
  delete base.DSH_SESSION_ID;
  delete base.TEAM_SELFTEST;
  delete base.TEAM_ROUTE_WAKE;
  return {
    ...base,
    TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_WORKBENCH_JSON: STORE,
    AWB_DATA_DIR: DATA, AWB_STORE: STORE, DSH_HOME,
    ...extra,
  };
}
function run(args, extra = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: env(extra), cwd: SB, timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status == null ? 1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
const text = (r) => `${r.out || ''}${r.err || ''}`;

/** 取一个当前确实没人监听的端口（listen 0 拿端口后立刻关闭）。 */
function deadPort() {
  return new Promise((resolve) => {
    const s = http.createServer(() => {});
    s.listen(0, '127.0.0.1', () => {
      const port = s.address().port;
      s.close(() => resolve(port));
    });
  });
}

/** 假 DSH：只实现 POST /api/session/prompt，回 server-response 信封（cookie 不校验）。 */
function startFakeDsh() {
  const hits = [];
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => { body += c; });
    req.on('end', () => {
      let payload = {};
      try { payload = JSON.parse(body || '{}'); } catch { payload = {}; }
      hits.push({ method: String(payload.method || ''), args: payload.payload && payload.payload.args });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ type: 'server-response', rpcId: payload.rpcId, result: { ok: true, value: { accepted: true } } }));
    });
  });
  return new Promise((resolve) => {
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port, hits }));
  });
}

async function main() {
  let exitCode = 0;
  const realBefore = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
  let fake = null;
  try {
    // 先清掉本机环境里的真实 DSH 地址（否则解析链第一时间命中 env，测不到实时端口源）
    for (const k of ['DSH_WEB_URL', 'DSH_WEB_PORT', 'DSH_PORT', 'AWB_TEAM_ROOT', 'DSH_SESSION_ID', 'TEAM_SELFTEST', 'TEAM_ROUTE_WAKE']) delete process.env[k];
    Object.assign(process.env, env());
    // 假 DSH 凭据（DshClient 构造时要 mint cookie；真实格式是 `client-connection/browser-session:` 单键）
    fs.mkdirSync(DSH_HOME, { recursive: true });
    fs.writeFileSync(path.join(DSH_HOME, '.credentials.yaml'), `client-connection/browser-session:\n  secret: ${SECRET}\n`, 'utf8');
    check('S0 沙盘 init', run(['init']).code === 0, {});
    check('S1 沙盘建项目', run(['project', 'add', '--name', PROJECT, '--team-mode', 'full']).code === 0, {});
    const team = readJson(path.join(TEAM, '状态', '团队.json'), { members: [] });
    team.activeProject = PROJECT;
    team.members = ROLES.map((role) => ({ role, name: role, status: 'active', sessionId: `session-b5ac-${role}` }));
    writeJson(path.join(TEAM, '状态', '团队.json'), team);
    const projMeta = readJson(path.join(STATE, '项目.json'), {});
    const projDir = String(projMeta.path || path.join(PROJECTS, PROJECT));
    writeJson(path.join(projDir, '团队会话.json'), { project: PROJECT, teamMode: 'full', workspace: projDir, roles: ROLES.map((role) => ({ role, sessionId: `session-b5ac-${role}` })) });
    writeJson(STORE, { projects: [{ id: 'b5ac-p1', name: PROJECT, teamName: PROJECT, path: projDir, sessions: Object.fromEntries(ROLES.map((r) => [r, `session-b5ac-${r}`])), workspace: { path: projDir, sessionIds: ROLES.map((r) => `session-b5ac-${r}`) } }], activeProjectId: 'b5ac-p1' });

    fake = await startFakeDsh();
    writeJson(path.join(TEAM, '状态', '当前工作区.json'), { project: PROJECT, engineUrl: 'http://127.0.0.1:62800', at: new Date().toISOString() });   // 陈旧死端口
    fs.writeFileSync(path.join(DSH_HOME, 'gui.port'), String(fake.port), 'utf8');

    const urlMod = await import(`file://${URL_SRC.replace(/\\/g, '/')}`);
    const daemon = await import(`file://${DAEMON_SRC.replace(/\\/g, '/')}`);

    /* ── ① 解析链：实时端口源优先于陈旧的当前工作区.json ── */
    const resolved = urlMod.resolveDshBaseUrl({});
    check('①a 当前工作区.json 指向死端口 62800 时，解析链选中 gui.port 的活端口',
      resolved.baseUrl === `http://127.0.0.1:${fake.port}` && /^port-file:gui\.port/.test(String(resolved.source)),
      { resolved });
    const engineOf = daemon.resolveWakeEngine('');
    check('①b route-daemon.resolveWakeEngine 也拿到同一地址（并带来源）',
      engineOf.baseUrl === `http://127.0.0.1:${fake.port}` && /^port-file:gui\.port/.test(String(engineOf.source)),
      { engineOf });

    /* ── ② 真唤醒走实时端口：当前工作区.json 是死端口也能成功 ── */
    const w1 = await daemon.deliverRouteWake(PROJECT, { role: 'tester', text: '【夹具】路由唤醒 1' });
    check('②a 当前工作区.json=死端口 + gui.port=活端口 → 唤醒成功（不再 fetch failed）',
      w1.ok === true && w1.engineUrl === `http://127.0.0.1:${fake.port}` && /^port-file:gui\.port/.test(String(w1.engineSource)),
      { w1 });
    check('②b 假 DSH 真的收到 session/prompt（不是空转成功）',
      fake.hits.some((h) => String(h.method) === 'session/prompt'), { hits: fake.hits.map((h) => h.method) });

    /* ── ③ 探活失败换端口：主地址（gui.port）指死端口，工作区文件写活端口 ── */
    const dead1 = await deadPort();
    fs.writeFileSync(path.join(DSH_HOME, 'gui.port'), String(dead1), 'utf8');   // 该端口已确认没人监听
    writeJson(path.join(TEAM, '状态', '当前工作区.json'), { project: PROJECT, engineUrl: `http://127.0.0.1:${fake.port}`, at: new Date().toISOString() });
    const beforeHits = fake.hits.length;
    const w2 = await daemon.deliverRouteWake(PROJECT, { role: 'tester', text: '【夹具】路由唤醒 2' });
    check('③a 主地址（gui.port=死端口）网络失败 → 自动换端口重试成功',
      w2.ok === true && w2.engineUrl === `http://127.0.0.1:${fake.port}`
      && Array.isArray(w2.attempts) && w2.attempts.length >= 2
      && w2.attempts[0].ok === false && w2.attempts[w2.attempts.length - 1].ok === true,
      { w2 });
    check('③b 换端口后确实打到了活的假 DSH', fake.hits.length === beforeHits + 1, { beforeHits, after: fake.hits.length });

    /* ── ④ 真不可达：回执带 url+code，PM 收一条 wake_failed ── */
    const dead2 = await deadPort();
    const dead3 = await deadPort();
    fs.writeFileSync(path.join(DSH_HOME, 'gui.port'), String(dead2), 'utf8');
    writeJson(path.join(TEAM, '状态', '当前工作区.json'), { project: PROJECT, engineUrl: `http://127.0.0.1:${dead3}`, at: new Date().toISOString() });
    const w3 = await daemon.deliverRouteWake(PROJECT, { role: 'tester', text: '【夹具】真不可达' });
    check('④a 真不可达 → ok=false，且带回 upstream url 与 error code',
      w3.ok === false && Boolean(w3.engineUrl) && Boolean(w3.code)
      && Array.isArray(w3.attempts) && w3.attempts.every((a) => a.ok === false),
      { w3 });
    const pmDir = path.join(TEAM, '状态', '邮箱', 'pm');
    const beforeMail = mailOf(pmDir).filter((m) => String(m.type) === 'wake_failed').length;
    const rep = daemon.reportWakeFailure(PROJECT, {
      role: 'tester', action: 'route_wake', requirementId: 'R-b5ac-fixture', taskId: 'T-b5ac-fixture', key: 'b5ac-key-1',
      result: w3, base: { source: 'status', role: 'tester', action: 'route_wake' },
    });
    const mailAfter = mailOf(pmDir).filter((m) => String(m.type) === 'wake_failed');
    check('④b PM 收到一条 wake_failed（且 body 带 upstream url + error code + 已尝试列表）',
      mailAfter.length === beforeMail + 1
      && String(mailAfter[mailAfter.length - 1].body || '').includes(String(w3.engineUrl))
      && String(mailAfter[mailAfter.length - 1].body || '').includes(String(w3.code))
      && /upstream url=/.test(String(mailAfter[mailAfter.length - 1].body || '')),
      { count: mailAfter.length, body: String((mailAfter[mailAfter.length - 1] || {}).body || '').slice(0, 500) });
    const wakeRows = jsonl(path.join(STATE, '路由守护.jsonl')).filter((r) => r && r.event === 'wake_failed');
    check('④c 路由守护.jsonl 的 wake_failed 行带 upstreamUrl/errorCode/attempts',
      wakeRows.length >= 1 && String(wakeRows[wakeRows.length - 1].upstreamUrl || '') === String(w3.engineUrl)
      && String(wakeRows[wakeRows.length - 1].errorCode || '') === String(w3.code)
      && Boolean(wakeRows[wakeRows.length - 1].attempts),
      { row: wakeRows[wakeRows.length - 1] });
    const rep2 = daemon.reportWakeFailure(PROJECT, {
      role: 'tester', action: 'route_wake', requirementId: 'R-b5ac-fixture', taskId: 'T-b5ac-fixture', key: 'b5ac-key-1',
      result: w3, base: { source: 'status', role: 'tester', action: 'route_wake' },
    });
    const mailAfter2 = mailOf(pmDir).filter((m) => String(m.type) === 'wake_failed');
    check('④d 同一 key 重复上报只留一条 PM 消息（去重，不刷屏）',
      mailAfter2.length === mailAfter.length,
      { first: rep.alert, second: rep2.alert, count: mailAfter2.length });

    /* ── ⑤ override/env 优先于端口文件（不破坏既有口径） ── */
    fs.writeFileSync(path.join(DSH_HOME, 'gui.port'), String(fake.port), 'utf8');
    const over = urlMod.resolveDshBaseUrl({ override: 'http://127.0.0.1:55999' });
    check('⑤a 显式 override 仍最高优先（不被实时端口覆盖）',
      over.baseUrl === 'http://127.0.0.1:55999' && over.source === 'override', { over });
  } catch (e) {
    check('夹具未抛异常', false, { error: String((e && e.stack) || e) });
  } finally {
    if (fake && fake.server) { try { fake.server.close(); } catch { /* ignore */ } }
    const realAfter = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
    check('C 隔离：真实 团队.json / workbench.json 前后 sha256 不变',
      realAfter.team === realBefore.team && realAfter.store === realBefore.store,
      { team: [realBefore.team.slice(0, 12), realAfter.team.slice(0, 12)], store: [realBefore.store.slice(0, 12), realAfter.store.slice(0, 12)] });
    fs.rmSync(SB, { recursive: true, force: true });
    const failed = ROWS.filter((r) => r.ok !== true);
    if (!JSON_OUT) {
      console.log(`\n${ROWS.length - failed.length}/${ROWS.length} PASS${failed.length ? ' · ' + failed.length + ' FAIL' : ''}`);
      if (failed.length) console.log('失败项：' + failed.map((r) => r.name).join(' | '));
    } else {
      console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed.length, failed: failed.map((r) => r.name), rows: ROWS }, null, 2));
    }
    if (failed.length) exitCode = 1;
  }
  process.exit(exitCode);
}
main();
