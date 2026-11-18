#!/usr/bin/env node
'use strict';
/**
 * test-9525-tech-debt.cjs —— T-20261118-134622-9525 回归夹具（发版前技术债三件）
 *
 * 覆盖（对应任务 detail【验收】1–4 与 acceptance 1–4）：
 *   A. d4e9① 唤醒正文上限读配置：`lib/wake-text.cjs` 的 BODY_LIMIT 不再写死 600 当唯一值——
 *      有效上限 = min(600, messageMaxChars)；非法值（非数字 / 0 / 负数 / undefined）回落 600；
 *      **仅真超长才标「已截断 N 字」**，短消息不再误标。
 *   B. d4e9① 接线：ops.mjs 三处 buildNoticePrompt 都传 `messageMaxChars: messageMaxChars()`；
 *      壳层 src/team-tools.js 也把 `teamConfig().messageMaxChars` 传给同一份 wake-text（两端同源）。
 *   C. d4e9② 维护提醒带 project：`lessons.mjs → promptIfDue()` 的 sendNotice 载荷必须有 `project`。
 *   D. d5a6 pump 时间源：`ops.mjs → pumpDispatchQueue()` 入口只取一次 now（AWB_NOW_MS 可注入），
 *      函数体内不再有裸 Date.now()；沙盘把 AWB_NOW_MS 拨后 10 分钟 → 投递审计 stallMs ≈ 10 分钟。
 *   E. e05b task update：仅 PM/Owner；reason 必填；字段校验（title/priority/owner）零副作用；
 *      append-only 审计 `任务修改.jsonl`（{at,by,id,field,before,after,reason}）；同值 NOOP；列表显示新值。
 *
 * 隔离：mkTempSandbox + TEAM_ROOT/TEAM_PROJECTS_ROOT/TEAM_WORKBENCH_JSON/AWB_DATA_DIR 全指沙盘 + TEAM_SELFTEST=1；
 *       真实 团队.json / workbench.json 前后 sha256 不变。
 * 用法：node scripts/test-9525-tech-debt.cjs [--json] [--out <json>]
 * 退出码：0 全过 / 1 有断言失败 / 2 环境错误
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const ROOT = path.resolve(__dirname, '..');
const PROJECT = '9525技术债沙盘';
const ROLES = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
const ROLE_DIRS = { pm: '项目经理', product: '产品', analyst: '需求分析师', programmer1: '程序员A', programmer2: '程序员B', tester: '测试人员' };
const JSON_OUT = process.argv.includes('--json');
const OUT_ARG = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(String(process.argv[i + 1])) : ''; })();

const SB = mkTempSandbox('9525');
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench.json');
const DATA = path.join(SB, 'data');
const TEAM_TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const WAKE_TEXT = path.join(ROOT, '团队', '工具', 'lib', 'wake-text.cjs');
const OPS = path.join(ROOT, '团队', '工具', 'lib', 'ops.mjs');
const LESSONS = path.join(ROOT, '团队', '工具', 'lib', 'lessons.mjs');
const TEAM_FILE = path.join(TEAM, '状态', '团队.json');
const STATE = path.join(TEAM, '状态', '项目', PROJECT);
const PROJECT_DIR = path.join(PROJECTS, PROJECT);
const TASK_DIR = path.join(STATE, '任务');
const QUEUE_FILE = path.join(STATE, '派单队列.json');
const AUDIT_DELIVERY = path.join(STATE, '派单投递审计.jsonl');
const AUDIT_TASK_EDIT = path.join(STATE, '任务修改.jsonl');
const MESSAGE_MAX = 420;            // 沙盘配置：验证「配置调小 → 唤醒正文跟着调小」
const REAL_TEAM = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');

Object.assign(process.env, {
  TEAM_ROOT: TEAM,
  TEAM_PROJECTS_ROOT: PROJECTS,
  TEAM_WORKBENCH_JSON: STORE,
  AWB_DATA_DIR: DATA,
  TEAM_SELFTEST: '1',
  TEAM_BOOT_ENFORCE: '',
  TEAM_ROSTER_DSH_ENFORCE: '',
});
delete process.env.AWB_NOW_MS;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
  return Boolean(ok);
}
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '(missing)'; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
const jsonlRows = (f) => {
  try { return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; }
};
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
const clip = (s, n = 140) => (String(s == null ? '' : s).length > n ? String(s).slice(0, n) + '…' : String(s == null ? '' : s));

function env(extra = {}) {
  return {
    ...process.env,
    TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_WORKBENCH_JSON: STORE, AWB_DATA_DIR: DATA, TEAM_SELFTEST: '1',
    TEAM_BOOT_ENFORCE: '', TEAM_ROSTER_DSH_ENFORCE: '', ...extra,
  };
}
function run(args, extraEnv = {}) {
  try {
    const out = execFileSync(process.execPath, [TEAM_TOOL, ...args], { encoding: 'utf8', env: env(extraEnv), timeout: 120000, cwd: SB });
    return { code: 0, out: String(out), err: '' };
  } catch (error) {
    return { code: error.status == null ? 1 : error.status, out: String(error.stdout || ''), err: String(error.stderr || '') };
  }
}
function runJson(args, extraEnv = {}) {
  const r = run(args, extraEnv);
  const t = String(r.out || '').trim();
  const i = t.indexOf('{');
  let json = null;
  if (i >= 0) { try { json = JSON.parse(t.slice(i)); } catch { json = null; } }
  return { ...r, json };
}
const textOf = (r) => String(r.out || '') + String(r.err || '');
const tokenOf = (r) => String((r.json && r.json.token) || '');

async function main() {
  if (!fs.existsSync(TEAM_TOOL)) { console.error('环境错误：找不到 team.mjs'); process.exit(2); }
  const realBefore = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };

  /* ── 沙盘骨架（配置 messageMaxChars 要在 boot 之前写：改团队.json 会使令牌失效） ── */
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  fs.mkdirSync(PROJECTS, { recursive: true });
  const seedTeam = readJson(path.join(ROOT, '团队', '状态', '团队.json'), { members: [] });
  seedTeam.activeProject = PROJECT;
  seedTeam.config = { ...(seedTeam.config || {}), messageMaxChars: MESSAGE_MAX };
  for (const m of seedTeam.members || []) { m.sessionId = ''; m.status = 'active'; }
  writeJson(TEAM_FILE, seedTeam);
  for (const rel of ['团队宪法.md', '项目铁律.md']) {
    const src = path.join(ROOT, '团队', rel);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TEAM, rel));
  }
  if (fs.existsSync(path.join(ROOT, '团队', '协议'))) fs.cpSync(path.join(ROOT, '团队', '协议'), path.join(TEAM, '协议'), { recursive: true });

  const setup = runJson(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
  check('S0 沙盘项目登记（full）', setup.code === 0, { code: setup.code, out: textOf(setup).slice(0, 300) });
  if (setup.code !== 0) { summary(); return; }
  // boot 的必读文档在不同版本里可能从「团队根」或「项目根」解析：夹具两处都放一份，避免因解析口径漂移而假红。
  for (const rel of ['团队宪法.md', '项目铁律.md']) {
    const src = path.join(ROOT, '团队', rel);
    if (!fs.existsSync(src)) continue;
    const dst = path.join(PROJECT_DIR, rel);
    if (!fs.existsSync(dst)) { fs.mkdirSync(path.dirname(dst), { recursive: true }); fs.copyFileSync(src, dst); }
  }
  const projectJson = readJson(path.join(STATE, '项目.json'), {});
  const MODE_ROLES = Array.isArray(projectJson.roleIds) && projectJson.roleIds.length ? projectJson.roleIds : ROLES.slice();
  const oldId = (role) => `session-9525-old-${role}`;
  const teamSeed = readJson(TEAM_FILE, { members: [] });
  teamSeed.activeProject = PROJECT;
  for (const role of MODE_ROLES) {
    let m = (teamSeed.members || []).find((x) => x && x.role === role);
    if (!m) { m = { role, name: role, status: 'active', joinedAt: new Date().toISOString() }; teamSeed.members.push(m); }
    m.sessionId = oldId(role);
    m.status = 'active';
  }
  writeJson(TEAM_FILE, teamSeed);
  writeJson(path.join(PROJECT_DIR, '团队会话.json'), {
    project: PROJECT, teamMode: 'full', workspace: PROJECT_DIR,
    roles: MODE_ROLES.map((role) => ({ role, name: role, sessionId: oldId(role), reused: false, model: '' })),
  });
  const realStore = readJson(REAL_STORE, { projects: [] }) || { projects: [] };
  const tpl = (realStore.projects || [])[0] || {};
  const entry = JSON.parse(JSON.stringify(tpl));
  entry.id = '9525-p1'; entry.name = PROJECT; entry.teamName = PROJECT;
  entry.path = PROJECT_DIR; entry.workspacePath = PROJECT_DIR;
  entry.sessions = Object.fromEntries(MODE_ROLES.map((r) => [r, oldId(r)]));
  entry.workspace = { ...(entry.workspace || {}), path: PROJECT_DIR, sessionIds: MODE_ROLES.map(oldId) };
  writeJson(STORE, { ...realStore, projects: [entry], activeProjectId: entry.id });
  writeJson(path.join(STATE, '工作流.json'), { schema: 2, project: PROJECT, round: 1, requirements: {}, boots: {} });
  writeJson(path.join(STATE, '会话轮次.json'), {});
  for (const role of MODE_ROLES) fs.mkdirSync(path.join(PROJECT_DIR, ROLE_DIRS[role] || role, '产出'), { recursive: true });

  const bootPm = runJson(['boot', '--role', 'pm', '--project', PROJECT, '--session', oldId('pm'), '--json']);
  const bootP1 = runJson(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', oldId('programmer1'), '--json']);
  const PM = tokenOf(bootPm);
  const P1 = tokenOf(bootP1);
  check('S1 pm / programmer1 可 boot（沙盘令牌就绪）', bootPm.code === 0 && bootP1.code === 0 && Boolean(PM) && Boolean(P1),
    { pm: bootPm.code, p1: bootP1.code, pmToken: Boolean(PM), p1Token: Boolean(P1) });

  /* ── A. d4e9① wake-text 上限读配置（纯函数） ───────────────────────── */
  const wake = require(WAKE_TEXT);
  const norm = wake.normalizeBodyLimit;
  check('A1 有效上限 = min(600, messageMaxChars)；非法值回落 600',
    norm(undefined) === 600 && norm('abc') === 600 && norm(0) === 600 && norm(-5) === 600
    && norm(300) === 300 && norm('420') === 420 && norm(900) === 600,
    { cases: [norm(undefined), norm('abc'), norm(0), norm(-5), norm(300), norm('420'), norm(900)] });
  const longBody = '甲'.repeat(500);
  const textWide = wake.buildNoticePrompt({ to: 'tester', project: PROJECT, messageId: 'M-x', subject: '上限 420', from: 'pm', body: longBody, messageMaxChars: MESSAGE_MAX });
  check('A2 配置 420 + 500 字正文 → 只保留 420 字并标「已截断 420 字」',
    textWide.includes('已截断 420 字') && textWide.includes('甲'.repeat(420)) && !textWide.includes('甲'.repeat(421)),
    { hasNote: textWide.includes('已截断 420 字'), tail: clip(textWide, 80) });
  const textCfg = wake.buildNoticePrompt({ to: 'tester', project: PROJECT, messageId: 'M-y', subject: '配置值', from: 'pm', body: longBody, messageMaxChars: 'abc' });
  check('A2b 配置为非法值（非数字）时回落 600：500 字正文不截断、也不误标',
    !textCfg.includes('已截断') && textCfg.includes(longBody),
    { hasNote: textCfg.includes('已截断'), len: longBody.length });
  const shortBody = '乙'.repeat(100);
  const textShort = wake.buildNoticePrompt({ to: 'pm', project: PROJECT, messageId: 'M-z', subject: '短消息', from: 'tester', body: shortBody, messageMaxChars: MESSAGE_MAX });
  check('A3 短消息不误标截断（正文完整出现，「已截断」0 命中，但仍给 read --id 入口）',
    !textShort.includes('已截断') && textShort.includes(shortBody) && textShort.includes('全文用 read --id'),
    { hasNote: textShort.includes('已截断'), hasRead: textShort.includes('全文用 read --id') });
  check('A4 无正文时不出现「正文」行（保持旧口径）',
    !wake.buildNoticePrompt({ to: 'pm', project: PROJECT, messageId: 'M-e', subject: '空', from: 'tester', body: '', messageMaxChars: 100 }).includes('正文：'),
    {});

  /* ── B. d4e9① 接线：ops 三处 + 壳层一处 ───────────────────────────── */
  const opsSrc = fs.readFileSync(OPS, 'utf8');
  const shellSrc = fs.readFileSync(path.join(ROOT, 'src', 'team-tools.js'), 'utf8');
  const noticeCalls = (opsSrc.match(/buildNoticePrompt\(\{/g) || []).length;
  const noticeWithCfg = (opsSrc.match(/messageMaxChars:\s*messageMaxChars\(\)/g) || []).length;
  check('B1 ops.mjs 三处 buildNoticePrompt 全部传 messageMaxChars（读团队配置）',
    noticeCalls === 3 && noticeWithCfg === 3,
    { noticeCalls, noticeWithCfg });
  check('B2 壳层 team-tools.js 把 teamConfig().messageMaxChars 传给同一份 wake-text（两端同源）',
    /messageMaxChars:\s*\(\(\)\s*=>\s*\{\s*try\s*\{\s*return teamConfig\(\)\.messageMaxChars/.test(shellSrc),
    { hit: /messageMaxChars/.test(shellSrc) });
  const cfgNow = Number((readJson(TEAM_FILE, {}).config || {}).messageMaxChars);
  const textViaCfg = wake.buildNoticePrompt({ to: 'tester', project: PROJECT, messageId: 'M-cfg', subject: '配置链路', from: 'pm', body: '丙'.repeat(500), messageMaxChars: cfgNow });
  check('B3 从沙盘团队.json 读出 messageMaxChars 后喂给 wake-text：按 420 截断（配置→上限链路成立）',
    cfgNow === MESSAGE_MAX && textViaCfg.includes('已截断 420 字'),
    { cfgNow, hasNote: textViaCfg.includes('已截断 420 字') });

  /* ── C. d4e9② 维护提醒带 project ─────────────────────────────────── */
  const lessonsMod = await import(pathToFileURL(LESSONS).href);
  const captured = [];
  const savedSelftest = process.env.TEAM_SELFTEST;
  delete process.env.TEAM_SELFTEST;          // promptIfDue 在沙盘会抑制发送；这里直接验载荷
  let promptResult = null;
  try {
    const atIso = new Date().toISOString();
    promptResult = lessonsMod.promptIfDue({
      stateDir: STATE,
      teamRoot: TEAM,
      role: 'tester',
      entry: { turns: 21, lastMaintenanceRounds: 0, lastNoticeSha: '' },
      threshold: { value: 20 },
      now: Date.now(),
      atIso,
      projectName: PROJECT,
      parsed: { missing: false, broken: false, fileSha: 'deadbeefdeadbeef' },
      sendNotice: (payload) => { captured.push(payload); return { ok: true, messageId: 'M-fixture-9525' }; },
    });
  } finally {
    if (savedSelftest !== undefined) process.env.TEAM_SELFTEST = savedSelftest;
  }
  const notice = captured[0] || null;
  check('C1 lessons 维护提醒 sendNotice 带 project（旧实现缺这个字段）',
    Boolean(notice) && String(notice.project || '') === PROJECT && String(notice.type || '') === 'maintenance_prompt' && String(notice.to || '') === 'tester',
    { notice: notice && { project: notice.project, to: notice.to, type: notice.type }, promptResult });
  check('C2 维护提醒正文仍是两问两命令（skill + 经验教训），未被本改动带偏',
    Boolean(notice) && /skill/.test(String(notice.body)) && /lessons read/.test(String(notice.body)),
    { body: notice && clip(notice.body, 120) });

  /* ── D. d5a6 pump 时间源 ─────────────────────────────────────────── */
  const pumpSrc = (() => {
    const start = opsSrc.indexOf('export async function pumpDispatchQueue');
    const end = opsSrc.indexOf('\nexport ', start + 10);
    return opsSrc.slice(start, end > 0 ? end : opsSrc.length);
  })();
  const pumpDateNow = (() => {
    // 去掉 // 注释后数真正的 Date.now() 调用（入口兜底仅 1 处）
    return pumpSrc.split(/\r?\n/).map((l) => l.replace(/\/\/.*$/, '')).filter((l) => /Date\.now\(\)/.test(l)).length;
  })();
  check('D1 pumpDispatchQueue 只有入口 1 处 Date.now() 兜底，体内不再裸用',
    pumpDateNow === 1 && /AWB_NOW_MS/.test(pumpSrc),
    { pumpDateNow, hasEnv: /AWB_NOW_MS/.test(pumpSrc) });
  const opsMod = await import(pathToFileURL(OPS).href);
  const queueItem = () => ({
    id: 'Q-9525-fixture-1', at: new Date().toISOString(), to: 'tester', from: 'pm',
    subject: '9525 夹具派单', body: '夹具正文', task: '', attempt: 1,
  });
  const runPump = async () => {
    writeJson(QUEUE_FILE, { items: [queueItem()], updatedAt: new Date().toISOString() });
    const before = jsonlRows(AUDIT_DELIVERY).length;
    const r = await opsMod.pumpDispatchQueue(PROJECT, { source: 'tick' });
    const rows = jsonlRows(AUDIT_DELIVERY).slice(before);
    const stall = rows.map((x) => Number(x.stallMs) || 0).sort((a, b) => b - a)[0] || 0;
    return { r, rows, stall };
  };
  delete process.env.AWB_NOW_MS;
  const pumpReal = await runPump();
  const injected = Date.now() + 600 * 1000;
  process.env.AWB_NOW_MS = String(injected);
  const pumpInjected = await runPump();
  delete process.env.AWB_NOW_MS;
  check('D2 未注入：stallMs 取真实时钟（< 60 秒）',
    pumpReal.rows.length >= 1 && pumpReal.stall < 60 * 1000,
    { stall: pumpReal.stall, rows: pumpReal.rows.length, reason: pumpReal.r && pumpReal.r.reason });
  check('D3 注入 AWB_NOW_MS=+10 分钟：投递审计 stallMs ≈ 10 分钟（≥ 9 分钟），说明 6 处判定都吃注入时间',
    pumpInjected.rows.length >= 1 && pumpInjected.stall >= 9 * 60 * 1000,
    { stall: pumpInjected.stall, rows: pumpInjected.rows.length, reason: pumpInjected.r && pumpInjected.r.reason });

  /* ── E. e05b task update ──────────────────────────────────────────── */
  const create = runJson(['task', 'create', '--project', PROJECT, '--boot', PM, '--type', 'task', '--title', '原始标题', '--priority', 'P2', '--detail', '夹具任务', '--json']);
  const taskId = String((create.json && create.json.task && create.json.task.id) || '');
  check('E0 PM 建夹具任务', create.code === 0 && /^T-/.test(taskId), { code: create.code, out: textOf(create).slice(0, 200) });
  const taskFile = path.join(TASK_DIR, `${taskId}.json`);
  const revBeforeUpdate = Number(readJson(taskFile, {}).rev) || 0;
  const auditCount = () => jsonlRows(AUDIT_TASK_EDIT).length;

  const deny = runJson(['task', 'update', '--project', PROJECT, '--boot', P1, '--id', taskId, '--title', 'P1 改标题', '--reason', '越权尝试', '--json']);
  check('E1 非 PM/Owner（programmer1）→ PERMISSION_DENIED，且零副作用（任务/审计不变）',
    deny.code !== 0 && /PERMISSION_DENIED/.test(textOf(deny)) && auditCount() === 0
    && String(readJson(taskFile, {}).title || '') === '原始标题',
    { code: deny.code, out: clip(textOf(deny), 160), audit: auditCount() });

  const noReason = runJson(['task', 'update', '--project', PROJECT, '--boot', PM, '--id', taskId, '--title', 'x', '--json']);
  check('E2 缺 --reason → REASON_REQUIRED，零副作用',
    noReason.code !== 0 && /REASON_REQUIRED/.test(textOf(noReason)) && auditCount() === 0,
    { code: noReason.code, out: clip(textOf(noReason), 160) });

  const noField = runJson(['task', 'update', '--project', PROJECT, '--boot', PM, '--id', taskId, '--reason', '什么都不改', '--json']);
  check('E3 未指定任何字段 → BAD_ARGS，零副作用',
    noField.code !== 0 && /BAD_ARGS/.test(textOf(noField)) && auditCount() === 0,
    { code: noField.code, out: clip(textOf(noField), 160) });

  const badPriority = runJson(['task', 'update', '--project', PROJECT, '--boot', PM, '--id', taskId, '--priority', 'P9', '--reason', '非法优先级', '--json']);
  const badOwner = runJson(['task', 'update', '--project', PROJECT, '--boot', PM, '--id', taskId, '--owner', 'not-a-role', '--reason', '非法 owner', '--json']);
  check('E4 非法 priority（P9）/ 未知 owner → BAD_PRIORITY / BAD_OWNER，零副作用',
    badPriority.code !== 0 && /BAD_PRIORITY/.test(textOf(badPriority))
    && badOwner.code !== 0 && /BAD_OWNER/.test(textOf(badOwner)) && auditCount() === 0,
    { badPriority: badPriority.code, badOwner: badOwner.code });

  const update1 = runJson(['task', 'update', '--project', PROJECT, '--boot', PM, '--id', taskId, '--title', '新标题', '--priority', 'P1', '--owner', 'tester', '--reason', '夹具：改标题/优先级/owner', '--json']);
  const taskAfter1 = readJson(taskFile, {});
  const auditRows1 = jsonlRows(AUDIT_TASK_EDIT);
  check('E5 PM 改 title+priority+owner → 落盘成功、rev+1、history 追加 update',
    update1.code === 0 && taskAfter1.title === '新标题' && taskAfter1.priority === 'P1' && taskAfter1.owner === 'tester'
    && Number(taskAfter1.rev) === Number(revBeforeUpdate) + 1 && (taskAfter1.history || []).some((h) => h.action === 'update'),
    { code: update1.code, task: { title: taskAfter1.title, priority: taskAfter1.priority, owner: taskAfter1.owner, rev: taskAfter1.rev, revBefore: revBeforeUpdate }, out: clip(textOf(update1), 160) });
  check('E6 审计 append-only：每个字段一行 {at,by,id,field,before,after,reason}（3 行，by=pm）',
    auditRows1.length === 3
    && auditRows1.every((r) => r.at && r.by === 'pm' && r.id === taskId && r.field && r.reason)
    && auditRows1.map((r) => r.field).sort().join(',') === 'owner,priority,title'
    && auditRows1.find((r) => r.field === 'owner').before === '' && auditRows1.find((r) => r.field === 'owner').after === 'tester',
    { rows: auditRows1.map((r) => ({ field: r.field, before: r.before, after: r.after, by: r.by })) });

  const listed = runJson(['task', 'list', '--project', PROJECT, '--boot', PM, '--all', '--json']);
  const listedRow = ((listed.json && listed.json.tasks) || []).find((t) => String(t.id) === taskId) || {};
  check('E7 task list 显示新值（title/priority/owner 都取改后）',
    listed.code === 0 && listedRow.title === '新标题' && listedRow.priority === 'P1' && listedRow.owner === 'tester',
    { row: { title: listedRow.title, priority: listedRow.priority, owner: listedRow.owner } });

  const noop = runJson(['task', 'update', '--project', PROJECT, '--boot', PM, '--id', taskId, '--title', '新标题', '--priority', 'P1', '--reason', '同值', '--json']);
  check('E8 同值 → NOOP（noop=true），不追加审计',
    noop.code === 0 && noop.json && noop.json.noop === true && jsonlRows(AUDIT_TASK_EDIT).length === 3,
    { code: noop.code, json: noop.json && { ok: noop.json.ok, noop: noop.json.noop }, audit: jsonlRows(AUDIT_TASK_EDIT).length });

  const clearOwner = runJson(['task', 'update', '--project', PROJECT, '--boot', PM, '--id', taskId, '--owner', '', '--reason', '清空 owner 夹具', '--json']);
  const taskAfterClear = readJson(taskFile, {});
  check('E9 --owner "" 清空 owner（null），并追加 1 行审计',
    clearOwner.code === 0 && taskAfterClear.owner === null && jsonlRows(AUDIT_TASK_EDIT).length === 4,
    { code: clearOwner.code, owner: taskAfterClear.owner, audit: jsonlRows(AUDIT_TASK_EDIT).length });

  /* ── 真实树零写入 ──────────────────────────────────────────────────── */
  check('隔离：真实 团队.json / workbench.json 前后 sha256 不变',
    sha(REAL_TEAM) === realBefore.team && sha(REAL_STORE) === realBefore.store,
    { teamSame: sha(REAL_TEAM) === realBefore.team, storeSame: sha(REAL_STORE) === realBefore.store });

  summary();
}

function summary() {
  const failed = results.filter((r) => !r.ok);
  const payload = {
    ok: failed.length === 0, project: PROJECT, total: results.length,
    passed: results.length - failed.length, failed: failed.length,
    sandbox: SB, at: new Date().toISOString(),
    artifacts: {
      taskEditAudit: AUDIT_TASK_EDIT,
      taskEditRows: (() => { try { return fs.readFileSync(AUDIT_TASK_EDIT, 'utf8').split(/\r?\n/).filter(Boolean).length; } catch { return 0; } })(),
      wakeLimitSample: (() => { try { return require(WAKE_TEXT).buildNoticePrompt({ to: 'tester', project: PROJECT, messageId: 'M-sample', subject: '样例', from: 'pm', body: '丁'.repeat(500), messageMaxChars: MESSAGE_MAX }).split('\n').find((l) => l.startsWith('正文')); } catch { return ''; } })(),
    },
    checks: results,
  };
  if (OUT_ARG) {
    try { fs.mkdirSync(path.dirname(OUT_ARG), { recursive: true }); fs.writeFileSync(OUT_ARG, JSON.stringify(payload, null, 2) + '\n', 'utf8'); } catch { /* 证据落盘失败不改变结论 */ }
  }
  if (JSON_OUT) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log('');
    for (const f of failed) console.log(`FAILED  ${f.name} :: ${String(JSON.stringify(f.detail)).slice(0, 500)}`);
    console.log(`9525 TECH DEBT CHECK ${failed.length ? 'FAIL' : 'OK'} ${results.length - failed.length}/${results.length} PASS`);
  }
  process.exit(failed.length ? 1 : 0);
}

main().catch((e) => {
  console.error('9525 TECH DEBT CHECK ERROR ' + String((e && e.stack) || e));
  process.exit(1);
});

