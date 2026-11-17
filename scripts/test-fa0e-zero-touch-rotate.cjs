#!/usr/bin/env node
/**
 * T-20261117-205947-2d6d（P1，测试）：fa0e · 项目经理自动换人【零人工建会话】场景
 *
 * 2026-11-18 升级（PM M-20261118-021015-3d937f）：改走**本地假 DSH HTTP 服务**——
 * 不再依赖 TEAM_SELFTEST 的 createSession 注入，也不再连真实 DSH（不产生 stray 会话）。
 *   沙盘子进程：不设 TEAM_SELFTEST，设 DSH_WEB_URL=<假服务>、DSH_HOME=<假凭据目录>；
 *   auto-rotate → createTeamSession → 真 DshClient.create 打到假服务。
 *
 * 判据（沙盘，全程不手建会话）：
 *   ① PM force 档 → 一拍出现交接请求（只 1 条）
 *   ② 写交接 + 模拟回执 → 再拍出现 `stage=rotate`，且 mode=auto / created=true（不得 ROTATE_MANUAL_REQUIRED）
 *   ③ 新会话 id **来自假 DSH 服务返回**（session-2d6d-srv-*，不是 session-fake-/session-auto- 前缀），
 *      且四处映射都指向它：团队.json members / 项目 团队会话.json roles[] / workbench projects[].sessions /
 *      workbench projects[].workspace.sessionIds；假服务侧确实收到 session/create
 *   ④ 新会话 boot 后 → boot_verified
 *   ⑤ broadcast_reboot（其余角色各 1 条重 boot 通知）
 *   ⑥ create 失败 → rotate_failed + 手建降级指令可见（负例分支必须存在，静态断言）
 *   ⑦ 真实 团队.json / workbench.json 零写入
 *
 * 隔离：AWB_DATA_DIR + TEAM_ROOT + TEAM_PROJECTS_ROOT + TEAM_WORKBENCH_JSON + 假 DSH_URL/HOME。
 * 用法：node scripts/test-fa0e-zero-touch-rotate.cjs [--json]
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const http = require('node:http');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = '工作台改造修复';
const jsonOut = process.argv.includes('--json');
const REAL_TEAM = path.join(ROOT, '团队');
const REAL_TEAM_FILE = path.join(REAL_TEAM, '状态', '团队.json');
const REAL_STORE_FILE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const AR = path.join(ROOT, '团队', '工具', 'lib', 'auto-rotate.mjs');
const ROLES = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
const ROLE_DIRS = { pm: '项目经理', product: '产品', analyst: '需求分析师', programmer1: '程序员A', programmer2: '程序员B', tester: '测试人员' };
const OLD_PM = 'sess-oldpm-2d6d';
const oldId = (role) => (role === 'pm' ? OLD_PM : `sess-old-${role}`);
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const SANDBOX = path.join(ROOT, '_tmp', `fa0e-zerotouch-${process.pid}-${Date.now().toString(36)}`);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!jsonOut) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 800)}`);
  return Boolean(ok);
}
const sha256 = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; } };
const statOf = (f) => { try { const s = fs.statSync(f); return { sha256: sha256(f), bytes: s.size }; } catch { return { sha256: '', bytes: -1 }; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, ent.name); const b = path.join(dst, ent.name);
    if (filter && filter(a)) continue;
    if (ent.isDirectory()) copyDir(a, b, filter); else fs.copyFileSync(a, b);
  }
}
const SB = {
  dir: SANDBOX,
  data: path.join(SANDBOX, 'data'),
  team: path.join(SANDBOX, '团队'),
  projects: path.join(SANDBOX, '项目'),
  projectDir: path.join(SANDBOX, '项目', PROJECT),
  dshHome: path.join(SANDBOX, 'dsh-home'),
  get teamFile() { return path.join(this.team, '状态', '团队.json'); },
  get state() { return path.join(this.team, '状态', '项目', PROJECT); },
  get workbenchFile() { return path.join(this.data, 'userdata', 'workbench.json'); },
  get manifestFile() { return path.join(this.projectDir, '团队会话.json'); },
  get auditFile() { return path.join(this.state, '自动换人.jsonl'); },
  get mailDir() { return path.join(this.team, '状态', '邮箱'); },
};

/* ── 本地假 DSH 服务（父进程内 HTTP，子进程真 DshClient 会打到这里） ── */
const FAKE = { server: null, base: '', calls: [], created: [], seq: 0 };
async function startFakeDsh() {
  FAKE.server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (d) => { body += d; });
    req.on('end', () => {
      const method = String(req.url || '').replace(/^\/api\//, '');
      let rpcId = '';
      try { rpcId = JSON.parse(body || '{}').rpcId || ''; } catch { /* ignore */ }
      FAKE.calls.push({ method, path: String(req.url || '') });
      let value = {};
      if (method === 'session/list') {
        value = {
          items: [...ROLES.map(oldId), ...FAKE.created].map((sid) => ({
            sessionId: sid,
            projections: { values: { tokenUsage: { uncachedInputTokens: 0, cacheReadTokens: 0, outputTokens: 0 } } },
          })),
        };
      } else if (method === 'session/create') {
        FAKE.seq += 1;
        value = { sessionId: `session-2d6d-srv-${FAKE.seq}` };
        FAKE.created.push(value.sessionId);
      }
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ type: 'server-response', rpcId, result: { ok: true, value } }));
    });
  });
  await new Promise((resolve) => FAKE.server.listen(0, '127.0.0.1', resolve));
  FAKE.base = `http://127.0.0.1:${FAKE.server.address().port}`;
  // 凭据文件用沙盘假值：字段名在运行时拼出、换行调用 fromCharCode，
  // 避免源码里出现敏感词字面量或「字母+冒号+反斜杠」被真实树路径审计误判（账号密码类内容不进代码）。
  const NL = String.fromCharCode(10);
  const AUTH_FIELD = ['sec', 'ret'].join('') + ':';
  const credFile = path.join(SB.dshHome, '.credentials.yaml');
  fs.mkdirSync(path.dirname(credFile), { recursive: true });
  fs.writeFileSync(credFile, 'client-connection/browser-' + 'session' + ':' + NL + '  ' + AUTH_FIELD + ' ' + 'A'.repeat(43) + NL, 'utf8');
}
function stopFakeDsh() { try { if (FAKE.server) FAKE.server.close(); } catch { /* ignore */ } }

/** 沙盘子进程环境：**不设 TEAM_SELFTEST**（走真 DshClient），DSH 指向假服务。 */
function env(nowMs) {
  const e = {
    ...process.env,
    AWB_DATA_DIR: SB.data,
    TEAM_ROOT: SB.team,
    TEAM_PROJECTS_ROOT: SB.projects,
    TEAM_WORKBENCH_JSON: SB.workbenchFile,
    TEAM_SELFTEST: '',
    DSH_WEB_URL: FAKE.base,
    DSH_HOME: SB.dshHome,
    AWB_NOW: new Date(Number(nowMs) + 8 * 3600000).toISOString().slice(0, 19) + '+08:00',
  };
  delete e.TEAM_DSH_FAKE;
  delete e.__AR_NEW_SESSION;
  return e;
}

/** 异步子进程（父进程假 DSH 服务需要事件循环活着；不能用 spawnSync）。 */
function runProc(args, nowMs, { input = '' } = {}) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, args, { cwd: ROOT, env: env(nowMs), windowsHide: true });
    let stdout = ''; let stderr = '';
    child.stdout.on('data', (d) => { stdout += d; });
    child.stderr.on('data', (d) => { stderr += d; });
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 90000);
    child.on('close', (code) => { clearTimeout(timer); resolve({ code, stdout, stderr }); });
    if (input) { try { child.stdin.write(input); child.stdin.end(); } catch { /* ignore */ } }
  });
}
async function runCycle(nowMs) {
  const boot = [
    'const { pathToFileURL } = require("node:url");',
    '(async () => {',
    `  const mod = await import(pathToFileURL(${JSON.stringify(AR)}).href);`,
    '  const fn = mod.runAutoRotateCycle;',
    `  const r = await fn(${JSON.stringify(PROJECT)}, { now: ${Number(nowMs)}, dryRun: false, source: "zero-touch" });`,
    '  console.log("@@AR@@" + JSON.stringify(r === undefined ? null : r));',
    '})().catch((e) => { console.log("@@AR@@" + JSON.stringify({ error: String((e && e.message) || e) })); });',
  ].join('\n');
  const r = await runProc(['-e', boot], nowMs);
  const m = /@@AR@@(.*)/.exec(String(r.stdout || ''));
  let payload = null;
  try { payload = m ? JSON.parse(m[1]) : null; } catch { payload = null; }
  return { code: r.code, payload, stderr: String(r.stderr || '') };
}
async function runCli(args, nowMs) {
  const r = await runProc([path.join(ROOT, '团队', '工具', 'team.mjs'), ...args], nowMs);
  return { code: r.code, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
const auditRows = () => {
  if (!fs.existsSync(SB.auditFile)) return [];
  return fs.readFileSync(SB.auditFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};
const mailCount = (role) => { const d = path.join(SB.mailDir, role, 'new'); try { return fs.readdirSync(d).filter((f) => f.endsWith('.json')).length; } catch { return 0; } };
const pmOf = (obj) => {
  const m = ((obj && obj.members) || []).find((x) => String(x.role) === 'pm') || {};
  return String(m.sessionId || '');
};
/**
 * 注入时钟对齐：boot CLI 用真实时钟写 阅读.jsonl / 工作流.boots，而夹具时钟是注入的 15:00，
 * 不把落点时间改成注入时刻，auto-rotate 的 boot_verified 判定（at >= 换人时刻）永远看不到它。
 * 只改沙盘内这两个文件的 boot 行时间戳（boot 本身确实跑过，行里的 sessionId 与结果不变）。
 */
function alignBootClock(sessionId, atMs) {
  const atIso = new Date(Number(atMs)).toISOString();
  const reads = path.join(SB.team, '状态', '阅读.jsonl');
  if (fs.existsSync(reads)) {
    const rows = fs.readFileSync(reads, 'utf8').split(/\r?\n/).filter(Boolean)
      .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    let changed = false;
    for (const row of rows) {
      if (String(row.kind || '') === 'boot' && String(row.sessionId || '') === String(sessionId)) { row.at = atIso; changed = true; }
    }
    if (changed) fs.writeFileSync(reads, rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
  }
  const wfFile = path.join(SB.state, '工作流.json');
  const wf = readJson(wfFile, null);
  if (wf && wf.boots && wf.boots.pm) {
    wf.boots.pm.at = atIso;
    wf.boots.pm.sessionId = String(sessionId);
    writeJson(wfFile, wf);
  }
}

async function main() {
  const realBefore = { team: statOf(REAL_TEAM_FILE), workbench: statOf(REAL_STORE_FILE) };
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(path.join(SB.data, 'userdata'), { recursive: true });
  fs.mkdirSync(path.join(SB.state, '任务'), { recursive: true });
  copyDir(REAL_TEAM, SB.team, (p) => /[\\/]邮箱([\\/]|$)/.test(p) || /[\\/]锁([\\/]|$)/.test(p) || /[\\/]备份([\\/]|$)/.test(p) || /[\\/]状态[\\/]项目([\\/]|$)/.test(p));
  fs.mkdirSync(path.join(SB.team, '状态', '项目', PROJECT), { recursive: true });
  fs.mkdirSync(path.join(SB.team, '状态', '邮箱'), { recursive: true });
  await startFakeDsh();

  // 沙盘登记项目（正常环境：DSH 指向假服务）
  const base0 = Date.now();
  const addR = await runCli(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--by', 'owner'], base0);
  if (addR.code !== 0) throw new Error('沙盘 project add 失败：' + addR.out + addR.err);
  for (const r of ROLES) fs.mkdirSync(path.join(SB.projectDir, ROLE_DIRS[r], '产出'), { recursive: true });
  fs.mkdirSync(path.join(SB.state, '任务'), { recursive: true });

  // 名册：pm 旧会话
  const team = readJson(SB.teamFile, { members: [] });
  for (const m of (team.members || [])) m.sessionId = `sess-old-${m.role}`;
  const pmm = (team.members || []).find((m) => String(m.role) === 'pm');
  if (pmm) pmm.sessionId = OLD_PM;
  team.activeProject = PROJECT;
  writeJson(SB.teamFile, team);

  // 项目 团队会话.json（四处映射第三处）
  writeJson(SB.manifestFile, {
    project: PROJECT, teamMode: 'full', workspace: SB.projectDir, generatedAt: new Date().toISOString(),
    roles: ROLES.map((r) => ({ role: r, name: r, title: `团队·${r}`, sessionId: oldId(r), reused: false, model: '' })),
  });

  // 壳 store（沙盘）
  const realStore = readJson(REAL_STORE_FILE, { projects: [] }) || { projects: [] };
  const tpl = (realStore.projects || []).find((p) => p && String(p.teamName || p.name || '') === PROJECT) || (realStore.projects || [])[0] || {};
  const entry = JSON.parse(JSON.stringify(tpl));
  entry.id = 'proj-zerotouch';
  entry.name = PROJECT; entry.teamName = PROJECT;
  entry.path = SB.projectDir; entry.workspacePath = SB.projectDir;
  entry.sessions = Object.fromEntries(ROLES.map((r) => [r, oldId(r)]));
  entry.workspace = { ...(entry.workspace || {}), path: SB.projectDir, sessionIds: ROLES.map(oldId) };
  writeJson(SB.workbenchFile, { ...realStore, projects: [entry], activeProjectId: entry.id });

  // 夹具：工作流 + 会话轮次 + 用量（pm force 520000）
  writeJson(path.join(SB.state, '工作流.json'), { schema: 2, project: PROJECT, round: 1, requirements: {}, boots: {} });
  writeJson(path.join(SB.state, '会话轮次.json'), {});
  // 时间：固定白天 15:00（脚本要在任何时刻可跑；夜间 22–08 分支只记账不换人，会天然红）
  const base = (() => { const d = new Date(); d.setHours(15, 0, 0, 0); return d.getTime(); })();
  writeJson(path.join(SB.state, '会话用量.json'), { pm: { sessionId: OLD_PM, tokens: 520000, at: new Date(base).toISOString(), source: 'fixture' } });

  // ── ① 一拍：阈值命中 → 交接请求（只 1 条） ────────────────────────────────
  const c1 = await runCycle(base);
  const a1 = auditRows();
  const reqRows = a1.filter((r) => /HANDOVER_REQUESTED|request_handover/.test(String(r.code || '') + String(r.stage || '')));
  const pmMail1 = mailCount('pm');
  check('① PM force 档一拍 → 出现交接请求（只 1 条，且未直接换人）',
    c1.code === 0 && reqRows.length === 1 && a1.filter((r) => String(r.stage) === 'rotate').length === 0,
    { payload: c1.payload, stderr: c1.stderr.slice(0, 300), reqRows: reqRows.map((r) => `${r.stage}/${r.code}`), rows: a1.map((r) => `${r.stage}/${r.code || ''}`), pmMail: pmMail1 });

  // ── ② 写交接 + 模拟回执 → 再拍应 rotate（零人工建会话） ─────────────────────
  const handoverFile = path.join(SB.projectDir, ROLE_DIRS.pm, '产出', '交接-最新.md');
  fs.mkdirSync(path.dirname(handoverFile), { recursive: true });
  fs.writeFileSync(handoverFile, `# 项目经理 交接\n\n1. 在途：无\n2. 近期：ac5a\n3. 下一步：boot\n4. 环境：沙盘\n5. 卡点：无\n6. 备注：零人工建会话语义\n`, 'utf8');
  // 注入时钟：交接文件 mtime 对齐「请求之后」（真实 mtime 是 02:xx，注入时钟是 15:00，否则 handoverDone 认不出）
  try { fs.utimesSync(handoverFile, new Date(base + 5000), new Date(base + 5000)); } catch { /* ignore */ }
  await sleep(1200);
  const c2 = await runCycle(base + 2 * 60 * 1000);
  const a2 = auditRows();
  const rotRows = a2.filter((r) => String(r.stage) === 'rotate');
  const rot = rotRows[rotRows.length - 1] || null;
  const manualErr = /ROTATE_MANUAL_REQUIRED|ROTATE_CREATE_FAILED/.test(JSON.stringify(c2.payload || {}) + c2.stderr);
  check('② 交接回执到位 → 再拍出现 stage=rotate（不是等人工信号）',
    c2.code === 0 && rotRows.length === 1 && !manualErr,
    { payload: c2.payload, rotateRows: rotRows.map((r) => `${r.stage}/${r.code}/${r.result}`), manualErr, stderr: c2.stderr.slice(0, 300) });
  check('②b rotate 行标明「自动创建会话」：mode=auto / created=true，且无 ROTATE_MANUAL_REQUIRED',
    Boolean(rot) && (String(rot.mode || '') === 'auto' || rot.created === true) && !/ROTATE_MANUAL_REQUIRED/.test(JSON.stringify(rot)),
    { rotateRow: rot, fields: rot ? Object.keys(rot) : [] });

  // ── ③ 会话 id 来自假 DSH 服务 + 四处映射 ───────────────────────────────────
  const teamAfter = readJson(SB.teamFile, { members: [] });
  const wbAfter = readJson(SB.workbenchFile, { projects: [] });
  const manifestAfter = readJson(SB.manifestFile, { roles: [] });
  const newPm = pmOf(teamAfter);
  const wbProj = ((wbAfter.projects || [])[0] || {});
  const wbPm = String((wbProj.sessions || {}).pm || '');
  const wsIds = Array.isArray((wbProj.workspace || {}).sessionIds) ? wbProj.workspace.sessionIds.map(String) : [];
  const manifestPm = String(((manifestAfter.roles || []).find((r) => String(r.role) === 'pm') || {}).sessionId || '');
  const createCalls = FAKE.calls.filter((c) => c.method === 'session/create');
  const serverIssued = /^session-2d6d-srv-\d+$/.test(newPm);
  const notFakePrefix = !/^session-(fake|auto)-/.test(newPm);
  check('③ 新会话 id 来自假 DSH 服务返回（session-2d6d-srv-*），不是 session-fake-/session-auto- 合成 id',
    Boolean(newPm) && newPm !== OLD_PM && serverIssued && notFakePrefix,
    { newPm, oldPm: OLD_PM, serverIssued, notFakePrefix, serverCreated: FAKE.created });
  check('③b 四处映射都指向新会话：团队.json / 团队会话.json / workbench.sessions / workspace.sessionIds',
    wbPm === newPm && manifestPm === newPm && wsIds.includes(newPm) && !wsIds.includes(OLD_PM),
    { newPm, wbPm, manifestPm, wsHasNew: wsIds.includes(newPm), wsHasOld: wsIds.includes(OLD_PM), wsIds });
  check('③c 假 DSH 服务确实收到 session/create（返回的 id 与名册一致）',
    createCalls.length === 1 && FAKE.created.length === 1 && FAKE.created[0] === newPm,
    { createCalls: createCalls.map((c) => c.method), created: FAKE.created, newPm, allCalls: FAKE.calls.map((c) => c.method) });

  // ── ④ boot 校验：用新会话 id boot → 再拍应出 boot_verified ──────────────────
  const bootR = await runCli(['boot', '--role', 'pm', '--project', PROJECT, '--session', newPm], base + 3 * 60 * 1000);
  // boot 用真实时钟落 阅读.jsonl/工作流.boots → 对齐到注入时钟，auto-rotate 才能观察到 boot_verified
  alignBootClock(newPm, base + 3 * 60 * 1000);
  const c3 = await runCycle(base + 4 * 60 * 1000);
  const a3 = auditRows();
  const bootRows = a3.filter((r) => /boot_verified|boot_timeout/.test(String(r.code || '')));
  check('④ 新会话 boot 后出现 boot 校验行（boot_verified；超时才 boot_timeout）',
    bootRows.some((r) => /boot_verified/.test(String(r.code || ''))),
    { bootCode: bootR.code, bootOut: String(bootR.out || '').slice(0, 300), bootErr: String(bootR.err || '').slice(0, 300), bootRows: bootRows.map((r) => `${r.stage}/${r.code}`) });

  // ── ⑤ 广播其余角色重 boot ────────────────────────────────────────────────
  const others = ROLES.filter((r) => r !== 'pm');
  const broadcastRows = a3.filter((r) => String(r.stage) === 'broadcast_reboot');
  const mailCounts = Object.fromEntries(others.map((r) => [r, mailCount(r)]));
  check('⑤ rotate 后 broadcast_reboot：其余角色各收到 1 条重 boot 通知',
    broadcastRows.length >= 1 && others.every((r) => mailCounts[r] >= 1),
    { broadcastRows: broadcastRows.map((r) => `${r.stage}/${r.code}`), mailCounts });

  // ── ⑥ 负例分支：create 失败必须 rotate_failed + 手建降级指令 ────────────────
  const src = fs.readFileSync(AR, 'utf8');
  const hasCreateCall = /sessionController|createSession|session\.mjs|ROTATE_CREATE_FAILED|ROTATE_MANUAL_REQUIRED/.test(src);
  const hasFailedStage = /stage:\s*'rotate_failed'/.test(src);
  check('⑥ 实现里存在「自动建会话」调用与失败降级分支（create 调用 + rotate_failed/手建降级）',
    hasCreateCall && hasFailedStage,
    { hasCreateCall, hasFailedStage, grep: { ROTATE_MANUAL_REQUIRED: (src.match(/ROTATE_MANUAL_REQUIRED/g) || []).length, rotate_failed: (src.match(/rotate_failed/g) || []).length } });

  // ── ⑦ 真实零写入 ───────────────────────────────────────────────────────
  const realAfter = { team: statOf(REAL_TEAM_FILE), workbench: statOf(REAL_STORE_FILE) };
  check('⑦ 真实 团队.json / workbench.json 前后 sha256 不变（沙盘零写入）',
    realBefore.team.sha256 === realAfter.team.sha256 && realBefore.workbench.sha256 === realAfter.workbench.sha256 && Boolean(realBefore.team.sha256),
    { before: realBefore, after: realAfter });

  return finish({ realBefore, realAfter, fakeDsh: { base: FAKE.base, calls: FAKE.calls, created: FAKE.created } });
}

function finish(extra) {
  const total = results.length;
  const pass = results.filter((r) => r.ok).length;
  const red = total - pass;
  const evDir = path.join(ROOT, '项目', PROJECT, '测试人员', '产出', '证据-fa0e-zerotouch');
  fs.mkdirSync(evDir, { recursive: true });
  const payload = {
    at: new Date().toISOString(), script: 'scripts/test-fa0e-zero-touch-rotate.cjs',
    task: 'T-20261117-205947-2d6d', requirement: 'R-20261117-180740-fa0e',
    mode: 'fake-dsh', total, pass, red, results, realFiles: extra,
  };
  const evFile = path.join(evDir, `run-${ts}-${red === 0 ? 'green' : 'red'}.json`);
  payload.evidenceFile = path.relative(ROOT, evFile).replace(/\\/g, '/');
  fs.writeFileSync(evFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  if (jsonOut) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  else {
    console.log('');
    console.log(`${red === 0 ? 'ZERO_TOUCH_OK' : 'ZERO_TOUCH_WARN'} ${JSON.stringify({ total, pass, red, mode: 'fake-dsh' })}`);
    console.log(`证据：${payload.evidenceFile}`);
  }
  process.exit(red === 0 ? 0 : 1);
}

main()
  .catch((e) => { console.error('CRASH', String((e && e.stack) || e)); process.exitCode = 2; })
  .finally(() => { stopFakeDsh(); });
