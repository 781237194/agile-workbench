#!/usr/bin/env node
'use strict';
/**
 * test-a6d1-pm-remind-product.cjs —— B-20261118-170115-a6d1 夹具：
 * 「PM 换人提醒没有通知产品」——阈值命中角色是 PM 时，执行人是产品，系统必须提醒产品；PM 只被告知写交接并回执产品。
 *
 * 覆盖任务【要做】①–④：
 *   A 阈值命中 role=pm（强制档）→ 产品收到 1 条 session_rotate_warn（含可复制 session rotate --role pm），
 *     PM 只收到「请先交接」请求、**不收执行换人指令**；审计有 REMIND_PRODUCT_ROTATE_PM；0 rotate。
 *   B 非 pm 角色（analyst）行为不变：analyst 收交接请求、PM 收「手动执行」提醒（含 --role analyst），产品不收。
 *   C PM 交接回执落账（session handover receipt --role pm）→ 产品收到「PM 交接回执已到：可由产品执行换人」。
 *   D 名册不变（提醒阶段绝不改 sessionId）、无 rotate/broadcast_reboot 审计行。
 * 跑法：node scripts/test-a6d1-pm-remind-product.cjs [--out <json>]
 * 退出码：0 全过 / 1 有断言失败
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = '工作台改造修复';
const ROLE_DIRS = { pm: '项目经理', product: '产品', analyst: '需求分析师', programmer1: '程序员A', programmer2: '程序员B', tester: '测试人员' };
const ROLES = Object.keys(ROLE_DIRS);
const BASE = path.join(ROOT, '_tmp', `a6d1-${process.pid}-${Date.now().toString(36)}`);
const OUT_ARG = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(String(process.argv[i + 1])) : ''; })();

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? null : (detail === undefined ? null : detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + JSON.stringify(detail === undefined ? null : detail).slice(0, 500)}`);
  return Boolean(ok);
}
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
const sha = (f) => { try { return require('node:crypto').createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; } };
function copyDir(src, dest, skip) {
  fs.mkdirSync(dest, { recursive: true });
  for (const name of fs.readdirSync(src)) {
    const from = path.join(src, name);
    const to = path.join(dest, name);
    if (skip && skip(from)) continue;
    const st = fs.statSync(from);
    if (st.isDirectory()) copyDir(from, to, skip);
    else fs.copyFileSync(from, to);
  }
}
/** AWB_NOW 必须带偏移（Asia/Shanghai 10:00），不依赖宿主时区。 */
function fmtAWB(ms) {
  const p = new Intl.DateTimeFormat('sv-SE', {
    timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false,
  }).formatToParts(new Date(ms)).reduce((a, x) => { a[x.type] = x.value; return a; }, {});
  return `${p.year}-${p.month}-${p.day}T${p.hour}:${p.minute}:${p.second}+08:00`;
}
function dayTimeMs(hour = 10) {
  const parts = new Intl.DateTimeFormat('sv-SE', { timeZone: 'Asia/Shanghai', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date()).split('-').map(Number);
  return Date.UTC(parts[0], parts[1] - 1, parts[2], hour - 8, 0, 0, 0);
}
function makeSandbox(name, { usage } = {}) {
  const dir = path.join(BASE, name);
  const data = path.join(dir, 'data');
  const team = path.join(dir, '团队');
  const projectDir = path.join(dir, '项目', PROJECT);
  const state = path.join(team, '状态', '项目', PROJECT);
  fs.mkdirSync(path.join(data, 'userdata'), { recursive: true });
  fs.mkdirSync(projectDir, { recursive: true });
  copyDir(path.join(ROOT, '团队'), team, (p) => /[\\/]邮箱([\\/]|$)/.test(p) || /[\\/]锁([\\/]|$)/.test(p));
  fs.rmSync(state, { recursive: true, force: true });
  fs.mkdirSync(path.join(state, '任务'), { recursive: true });
  const roster = readJson(path.join(team, '状态', '团队.json'), { members: [] });
  for (const m of roster.members || []) m.sessionId = `sess-old-${m.role}`;
  roster.activeProject = PROJECT;
  writeJson(path.join(team, '状态', '团队.json'), roster);
  writeJson(path.join(state, '项目.json'), { name: PROJECT, path: projectDir, teamMode: 'full' });
  writeJson(path.join(state, '工作流.json'), { schema: 2, project: PROJECT, round: 1, requirements: {}, boots: {} });
  if (usage) writeJson(path.join(state, '会话用量.json'), usage);
  const store = readJson(path.join(ROOT, 'data', 'userdata', 'workbench.json'), { projects: [] });
  const project = (store.projects || []).find((p) => p && String(p.teamName || p.name || '') === PROJECT) || {};
  store.projects = [project];
  store.activeProjectId = project.id;
  project.path = projectDir;
  project.workspacePath = projectDir;
  project.sessions = Object.fromEntries(ROLES.map((r) => [r, `sess-old-${r}`]));
  writeJson(path.join(data, 'userdata', 'workbench.json'), store);
  for (const r of ROLES) fs.mkdirSync(path.join(projectDir, ROLE_DIRS[r], '产出'), { recursive: true });
  // boot 必读文档（项目信息/角色卡等）从真实项目只读复制，避免 C 组 boot 报 MISSING_DOC
  const realProjectDir = path.join(ROOT, '项目', PROJECT);
  for (const rel of ['项目信息.md', '项目索引.md', '协作准则.md', path.join('需求', '00-需求总览.md')]) {
    const src = path.join(realProjectDir, rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(projectDir, rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  for (const r of ROLES) {
    for (const name of ['角色卡.md', '文件索引.md']) {
      const src = path.join(realProjectDir, ROLE_DIRS[r], name);
      if (fs.existsSync(src)) fs.copyFileSync(src, path.join(projectDir, ROLE_DIRS[r], name));
    }
  }
  const env = (nowMs, extra = {}) => ({
    ...process.env, AWB_DATA_DIR: data, TEAM_ROOT: team,
    TEAM_PROJECTS_ROOT: path.join(team, '状态', '项目'),
    TEAM_WORKBENCH_JSON: path.join(data, 'userdata', 'workbench.json'),
    TEAM_SELFTEST: '1', TEAM_HANDOVER_ENFORCE: '', AWB_NOW: fmtAWB(nowMs), ...extra,
  });
  return {
    dir, team, projectDir, state, env,
    auditFile: path.join(state, '自动换人.jsonl'),
    rosterFile: path.join(team, '状态', '团队.json'),
    mails(role) {
      const d = path.join(team, '状态', '邮箱', role, 'new');
      try { return fs.readdirSync(d).filter((n) => n.endsWith('.json')).map((n) => readJson(path.join(d, n), {})); } catch { return []; }
    },
    rows() {
      try {
        return fs.readFileSync(this.auditFile, 'utf8').split(/\r?\n/).filter(Boolean)
          .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
      } catch { return []; }
    },
  };
}
/** 子进程跑一拍（隔离 env，避免同进程 env 串味）。 */
function runCycle(sb, nowMs) {
  const probe = path.join(sb.dir, 'probe.cjs');
  fs.writeFileSync(probe, `
'use strict';
const { pathToFileURL } = require('node:url');
(async () => {
  const mod = await import(pathToFileURL(${JSON.stringify(path.join(ROOT, '团队', '工具', 'lib', 'auto-rotate.mjs'))}).href);
  const out = await mod.runAutoRotateCycle(${JSON.stringify(PROJECT)}, { now: ${Number(nowMs)}, dryRun: false, source: 'fixture-a6d1' });
  process.stdout.write(JSON.stringify(out));
})().catch((e) => { console.error(String(e && e.stack || e)); process.exit(1); });
`, 'utf8');
  const r = spawnSync(process.execPath, [probe], { cwd: sb.dir, env: sb.env(nowMs), encoding: 'utf8', timeout: 120000 });
  try { return JSON.parse(String(r.stdout || '').trim()); } catch { return { parseError: String(r.stderr || r.stdout).slice(0, 400), code: r.status }; }
}

function main() {
  const now = dayTimeMs(10);
  const iso = (ms) => new Date(ms).toISOString();

  /* A. role=pm 命中强制档 → 提醒产品，不给 PM 执行指令 */
  const A = makeSandbox('A-pm', { usage: { pm: { sessionId: 'sess-old-pm', tokens: 10100000, at: iso(now), source: 'fixture' } } });
  const rosterBefore = sha(A.rosterFile);
  const outA = runCycle(A, now);
  const rowsA = A.rows();
  const productMailsA = A.mails('product');
  const pmMailsA = A.mails('pm');
  check('A1 审计有 REMIND_PRODUCT_ROTATE_PM（role=pm, to=product），无 PRM 手动执行提醒',
    rowsA.some((r) => String(r.stage) === 'remind' && String(r.code) === 'REMIND_PRODUCT_ROTATE_PM' && String(r.role) === 'pm')
    && !rowsA.some((r) => String(r.code) === 'REMIND_PM_MANUAL_ROTATE' && String(r.forRole) === 'pm'),
    { rows: rowsA.map((r) => `${r.stage}/${r.code}/${r.role}`), out: outA && outA.actions });
  check('A2 产品收到 1 条 session_rotate_warn，正文含可复制的 session rotate --role pm',
    productMailsA.length === 1
    && String(productMailsA[0].type) === 'session_rotate_warn'
    && /session rotate --role pm/.test(String(productMailsA[0].body || '')),
    { count: productMailsA.length, mail: productMailsA[0] && { type: productMailsA[0].type, subject: productMailsA[0].subject } });
  check('A3 PM 只收到交接请求、不收「执行换人」指令（正文无 session rotate 命令）',
    pmMailsA.length === 1 && /请先交接/.test(String(pmMailsA[0].subject || ''))
    && !/session rotate --role pm/.test(String(pmMailsA[0].body || '')),
    { count: pmMailsA.length, mail: pmMailsA[0] && { subject: pmMailsA[0].subject, body: String(pmMailsA[0].body || '').slice(0, 160) } });
  check('A4 只提醒不换人：无 rotate/broadcast_reboot 审计行，名册 sessionId 不变',
    !rowsA.some((r) => ['rotate', 'broadcast_reboot'].includes(String(r.stage))) && sha(A.rosterFile) === rosterBefore,
    { rows: rowsA.map((r) => r.stage), rosterSame: sha(A.rosterFile) === rosterBefore });

  /* B. 非 pm 角色（analyst）行为不变 */
  const B = makeSandbox('B-analyst', { usage: { analyst: { sessionId: 'sess-old-analyst', tokens: 10100000, at: iso(now), source: 'fixture' } } });
  const outB = runCycle(B, now);
  const pmMailsB = B.mails('pm');
  const productMailsB = B.mails('product');
  check('B1 analyst 命中 → PM 收手动执行提醒（含 --role analyst），actions 仍有 REMIND_PM_MANUAL_ROTATE',
    pmMailsB.some((m) => /session rotate --role analyst/.test(String(m.body || '')))
    && ((outB && outB.actions) || []).some((a) => String(a.code) === 'REMIND_PM_MANUAL_ROTATE' && String(a.forRole) === 'analyst'),
    { pmMails: pmMailsB.map((m) => ({ subject: m.subject, body: String(m.body || '').slice(0, 200) })), actions: outB && outB.actions });
  check('B2 非 pm 角色不惊动产品（产品 mailbox 无 session_rotate_warn）',
    productMailsB.filter((m) => String(m.type) === 'session_rotate_warn').length === 0,
    { productMails: productMailsB.map((m) => m.type) });

  /* C. PM 交接回执落账 → 产品收到「可执行换人」提醒 */
  const C = makeSandbox('C-receipt', {});
  const pmHandover = path.join(C.projectDir, ROLE_DIRS.pm, '产出', '交接-最新.md');
  fs.writeFileSync(pmHandover, [
    '# PM 交接（夹具）',
    '',
    '【一、状态】夹具用交接文件，八节占位。',
    '【二、已收口】无。',
    '【三、在途】无。',
    '【四、待 Owner 定】无。',
    '【五、教训】无。',
    '【六、关键文件】本文件。',
    '【七、头三件事】boot、读交接、待命。',
    '【八、未完成】无。',
    '',
  ].join('\n'), 'utf8');
  const bootPm = spawnSync(process.execPath, [path.join(ROOT, '团队', '工具', 'team.mjs'), 'boot', '--role', 'pm', '--project', PROJECT, '--session', 'sess-old-pm', '--json'], { cwd: C.dir, env: C.env(now), encoding: 'utf8' });
  let pmToken = '';
  try { pmToken = String(JSON.parse(String(bootPm.stdout)).token || ''); } catch { pmToken = ''; }
  const receipt = spawnSync(process.execPath, [path.join(ROOT, '团队', '工具', 'team.mjs'), 'session', 'handover', 'receipt', '--role', 'pm', '--project', PROJECT, '--boot', pmToken, '--json'], {
    cwd: C.dir, env: C.env(now, { TEAM_BOOT_ENFORCE: '1' }), encoding: 'utf8',
  });
  const productMailsC = C.mails('product');
  check('C1 PM 交接回执落账成功（exit 0）', receipt.status === 0,
    { code: receipt.status, out: String(receipt.stdout || '').slice(0, 300), err: String(receipt.stderr || '').slice(0, 300), pmToken: Boolean(pmToken) });
  check('C2 产品收到「PM 交接回执已到」提醒（含执行步骤）',
    productMailsC.some((m) => /PM 交接回执已到/.test(String(m.subject || '')) && /session rotate --role pm/.test(String(m.body || ''))),
    { mails: productMailsC.map((m) => ({ type: m.type, subject: m.subject })) });

  const failed = results.filter((r) => !r.ok);
  const payload = { ok: failed.length === 0, total: results.length, passed: results.length - failed.length, failed: failed.length, sandbox: BASE, at: new Date().toISOString(), checks: results };
  if (OUT_ARG) { try { fs.mkdirSync(path.dirname(OUT_ARG), { recursive: true }); fs.writeFileSync(OUT_ARG, JSON.stringify(payload, null, 2) + '\n', 'utf8'); } catch { /* ignore */ } }
  for (const sb of [A, B, C]) { try { fs.rmSync(sb.dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ } }
  console.log('');
  for (const f of failed) console.log(`FAILED  ${f.name} :: ${String(JSON.stringify(f.detail)).slice(0, 500)}`);
  console.log(`A6D1 PM REMIND PRODUCT ${failed.length ? 'FAIL' : 'OK'} ${results.length - failed.length}/${results.length} PASS`);
  process.exit(failed.length ? 1 : 0);
}

try { main(); } catch (e) { console.error('A6D1 CHECK ERROR ' + String((e && e.stack) || e)); process.exit(1); }
