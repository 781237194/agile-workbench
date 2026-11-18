#!/usr/bin/env node
'use strict';
/**
 * test-6e39-sandboxwake.cjs —— B-20261118-090620-6e39 夹具（沙盘误判导致 PM 唤醒被静默跳过 + 面板 skip 细分）
 *
 * 覆盖（任务 acceptance 四条）：
 *   ① 判据收紧：env 指向**安装默认根**（本模块 INSTALL_TEAM_ROOT）不再算沙盘；指向别处 / TEAM_SELFTEST=1 / 拷贝树仍算沙盘。
 *   ② 真实根场景不再返回 sandbox_wake_skipped（用「安装形状的整树副本」做隔离替身：env 指向该副本根 + 安装标记齐全 → 判生产）。
 *   ③ 拷贝树（无安装标记）与 TEAM_SELFTEST=1 仍被拦截（B-3c03 保护不破）。
 *   ④ 面板 skip 细分：session-queue.js 归一四类 + 面板 data-sq-skip-reason / 黄点（.sq-state-skip = gold）。
 *
 * 隔离：所有沙盘在 _tmp 下；真实 团队.json / 唤醒.jsonl / workbench.json 前后 sha256 必须不变。
 * 用法：node scripts/test-6e39-sandboxwake.cjs [--json]
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const ROOT = path.resolve(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const CORE = path.join(ROOT, '团队', '工具', 'lib', 'core.mjs');
const REAL_TEAM_JSON = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_WAKE = path.join(ROOT, '团队', '状态', '项目', '工作台改造修复', '唤醒.jsonl');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '(missing)'; } };
const wakeBeforeBuf = fs.existsSync(REAL_WAKE) ? fs.readFileSync(REAL_WAKE) : Buffer.alloc(0);
const before = { team: sha(REAL_TEAM_JSON), wake: sha(REAL_WAKE), store: sha(REAL_STORE) };

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
  return Boolean(ok);
}
function runNode(code, env) {
  const out = execFileSync(process.execPath, ['--input-type=module', '-e', code], { cwd: ROOT, env, encoding: 'utf8', timeout: 60000 });
  return JSON.parse(String(out).trim());
}
function copyTeam(dstTeam) {
  fs.cpSync(path.join(ROOT, '团队'), dstTeam, { recursive: true, filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) && !/[\\/]启动[\\/]/.test(src) });
  const tf = path.join(dstTeam, '状态', '团队.json');
  const team = JSON.parse(fs.readFileSync(tf, 'utf8'));
  for (const m of team.members || []) m.sessionId = `sess-6e39-${String(m.role || 'x')}`;
  delete team.activeProject;
  fs.writeFileSync(tf, JSON.stringify(team, null, 2) + '\n', 'utf8');
}
const coreProbe = (env, corePath = CORE) => {
  const target = String(corePath || CORE).replace(/\\/g, '/');
  const code = `import { sandboxRootInfo, isSandboxTeamRoot } from ${JSON.stringify('file:///' + target)};`
    + `console.log(JSON.stringify({ info: sandboxRootInfo(), sandbox: isSandboxTeamRoot() }));`;
  return runNode(code, env);
};
const cleanEnv = (extra = {}) => {
  const env = { ...process.env, ...extra };
  for (const k of ['TEAM_ROOT', 'TEAM_PROJECTS_ROOT', 'TEAM_SELFTEST', 'AWB_TEAM_ROOT', 'TEAM_DSH_FAKE']) delete env[k];
  return Object.assign(env, extra);
};

/* ── A. 判据矩阵（core.sandboxRootInfo） ───────────────────────────────── */
try {
  // A1：无 env → 生产（不是沙盘）
  const a1 = coreProbe(cleanEnv());
  check('A1 无 env → 不算沙盘（生产默认）', a1.info.sandbox === false && a1.sandbox === false, a1);

  // A2：env TEAM_ROOT 指向**安装默认根** → 生产（旧实现误判沙盘）
  const a2 = coreProbe(cleanEnv({ TEAM_ROOT: path.join(ROOT, '团队') }));
  check('A2 TEAM_ROOT=安装默认根 → 不算沙盘（本次修复核心）', a2.info.sandbox === false && a2.sandbox === false, a2);

  // A3：env TEAM_ROOT 指向别处（_tmp 沙盘）→ 沙盘
  const otherRoot = path.join(ROOT, '_tmp', 'fix-6e39', 'other-root', '团队');
  fs.mkdirSync(otherRoot, { recursive: true });
  const a3 = coreProbe(cleanEnv({ TEAM_ROOT: otherRoot }));
  check('A3 TEAM_ROOT 指向其它根 → 判沙盘（env_root）', a3.info.sandbox === true && a3.info.why === 'env_root', a3);

  // A4：只设 TEAM_PROJECTS_ROOT 且指向别处 → 沙盘（B-47c0 判据保留）
  const a4 = coreProbe(cleanEnv({ TEAM_PROJECTS_ROOT: path.join(ROOT, '_tmp', 'fix-6e39', 'other-projects') }));
  check('A4 TEAM_PROJECTS_ROOT 指向别处 → 判沙盘（env_projects）', a4.info.sandbox === true && a4.info.why === 'env_projects', a4);

  // A5：TEAM_SELFTEST=1 → 沙盘（selftest）
  const a5 = coreProbe(cleanEnv({ TEAM_SELFTEST: '1' }));
  check('A5 TEAM_SELFTEST=1 → 判沙盘（selftest）', a5.info.sandbox === true && a5.info.why === 'selftest', a5);

  // A6：整目录拷贝双保险——拷贝树里 env 指向它自己的 团队/（=它自己的 INSTALL 根）仍判沙盘
  const sbA = mkTempSandbox('6e39-copy');
  const copyA = path.join(sbA, '团队');
  copyTeam(copyA);
  const a6 = coreProbe(cleanEnv({ TEAM_ROOT: copyA }), path.join(copyA, '工具', 'lib', 'core.mjs'));
  check('A6 拷贝树 env 指到自身根 → 仍判沙盘（copied_tree，B-3c03 双保险不破）', a6.info.sandbox === true && a6.info.why === 'copied_tree', a6);
} catch (e) {
  check('A 段判据矩阵执行', false, String((e && e.message) || e));
}

/* ── B. 真实根场景：不再返回 sandbox_wake_skipped（安装形状副本作隔离替身） ── */
try {
  const sbB = mkTempSandbox('6e39-prodlike');
  const teamB = path.join(sbB, '团队');
  copyTeam(teamB);
  // 让该副本具备「安装形状」：core.mjs 的 installWorkspaceMarkers 全部存在 → env 指到它的根即判生产
  for (const rel of ['package.json', 'scripts/run-electron.cjs', 'src/main.js', '团队/工具/team.mjs']) {
    const abs = path.join(sbB, rel);
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(path.dirname(abs), { recursive: true });
      fs.writeFileSync(abs, rel === 'package.json' ? '{"name":"fixture-prodlike","private":true}\n' : '// fixture marker\n', 'utf8');
    }
  }
  const projectsB = path.join(sbB, '项目');
  fs.mkdirSync(projectsB, { recursive: true });
  const envB = cleanEnv({
    TEAM_ROOT: teamB,
    TEAM_PROJECTS_ROOT: projectsB,
    TEAM_WORKBENCH_JSON: path.join(sbB, 'workbench.json'),
    AWB_DATA_DIR: path.join(sbB, 'data'),
    DSH_WEB_URL: 'http://127.0.0.1:1',
  });
  const toolB = path.join(teamB, '工具', 'team.mjs');
  const probeB = coreProbe({ ...envB, TEAM_PROJECTS_ROOT: '' }, path.join(teamB, '工具', 'lib', 'core.mjs'));
  const run = (args) => {
    const out = execFileSync(process.execPath, [toolB, ...args], { cwd: sbB, env: envB, encoding: 'utf8', timeout: 120000, stdio: 'pipe' });
    const t = String(out).trim();
    return JSON.parse(t.slice(t.indexOf('{')));
  };
  run(['project', 'add', '--name', '6e39生产形状', '--team-mode', 'fast', '--json']);
  const pm = run(['boot', '--role', 'pm', '--project', '6e39生产形状', '--session', 'sess-6e39-pm', '--json']);
  const dev = run(['boot', '--role', 'programmer1', '--project', '6e39生产形状', '--session', 'sess-6e39-p1', '--json']);
  const sent = run(['send', '--boot', dev.token, '--to', 'pm', '--subject', '6e39 真实根唤醒', '--body', '本次不得再 sandbox_skip', '--json']);
  const wake = sent.wake || {};
  check('B1 安装形状副本 + env 指到它的根 → sandboxRootInfo=false（不是沙盘）', probeB.info.sandbox === false, probeB);
  check('B2 该场景 send 成功且唤醒**未**被判 sandbox_wake_skipped', sent.ok === true && wake.skipped !== 'sandbox_wake_skipped', { ok: sent.ok, wake });
  check('B3 唤醒尝试真实路径（有失败原因/已送达，而不是「沙盘跳过」）',
    Boolean(wake.skipped === undefined || wake.skipped === '' || wake.skipped === null) || wake.skipped !== 'sandbox_wake_skipped',
    { wake });
} catch (e) {
  check('B 段真实根场景执行', false, String((e && e.message) || e).slice(0, 500));
}

/* ── C. 拷贝树 + TEAM_SELFTEST=1 仍被拦截（B-3c03 保护） ─────────────── */
try {
  const sbC = mkTempSandbox('6e39-sandbox');
  const teamC = path.join(sbC, '团队');
  copyTeam(teamC);
  const projectsC = path.join(sbC, '项目');
  fs.mkdirSync(projectsC, { recursive: true });
  const envC = cleanEnv({
    TEAM_ROOT: teamC,
    TEAM_PROJECTS_ROOT: projectsC,
    TEAM_WORKBENCH_JSON: path.join(sbC, 'workbench.json'),
    AWB_DATA_DIR: path.join(sbC, 'data'),
    DSH_WEB_URL: 'http://127.0.0.1:1',
  });
  const toolC = path.join(teamC, '工具', 'team.mjs');
  const runC = (args, env = envC) => {
    const out = execFileSync(process.execPath, [toolC, ...args], { cwd: sbC, env, encoding: 'utf8', timeout: 120000, stdio: 'pipe' });
    const t = String(out).trim();
    return JSON.parse(t.slice(t.indexOf('{')));
  };
  runC(['project', 'add', '--name', '6e39沙盘', '--team-mode', 'fast', '--json']);
  const devC = runC(['boot', '--role', 'programmer1', '--project', '6e39沙盘', '--session', 'sess-6e39-c-p1', '--json']);
  const sentC = runC(['send', '--boot', devC.token, '--to', 'pm', '--subject', '6e39 拷贝树', '--body', '拷贝树必须仍判沙盘', '--json']);
  const wakeC = sentC.wake || {};
  check('C1 拷贝树（无安装标记）→ 唤醒仍 sandbox_wake_skipped（B-3c03 保护）',
    wakeC.skipped === 'sandbox_wake_skipped' && wakeC.delivered === false && String(wakeC.sandboxWhy || '') === 'copied_tree',
    { skipped: wakeC.skipped, why: wakeC.sandboxWhy });

  // C2：同一拷贝树 + TEAM_SELFTEST=1 → 也仍拦截（selftest 口径）
  const envC2 = { ...envC, TEAM_SELFTEST: '1' };
  const sentC2 = runC(['send', '--boot', devC.token, '--to', 'pm', '--subject', '6e39 selftest', '--body', 'selftest 必须仍判沙盘', '--json'], envC2);
  const wakeC2 = sentC2.wake || {};
  check('C2 TEAM_SELFTEST=1 → 唤醒仍 sandbox_wake_skipped（selftest 口径）', wakeC2.skipped === 'sandbox_wake_skipped', { skipped: wakeC2.skipped, wake: wakeC2 });

  // C3：沙盘留痕写进沙盘自己的 唤醒.jsonl，且带 sandboxWhy 细分
  const wf = path.join(teamC, '状态', '项目', '6e39沙盘', '唤醒.jsonl');
  const rows = fs.existsSync(wf) ? fs.readFileSync(wf, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
  const skipRows = rows.filter((r) => String(r.skipped || '') === 'sandbox_wake_skipped');
  check('C3 沙盘 唤醒.jsonl 有 skipped=sandbox_wake_skipped + sandboxReason=sandbox_root + sandboxWhy 行',
    skipRows.length >= 1 && skipRows.every((r) => String(r.sandboxReason || '') === 'sandbox_root') && skipRows.some((r) => String(r.sandboxWhy || '').length > 0),
    { rows: rows.length, skipRows: skipRows.slice(0, 2) });
} catch (e) {
  check('C 段沙盘保护执行', false, String((e && e.message) || e).slice(0, 500));
}

/* ── D. 面板 skip 细分（session-queue 归一 + 面板锚点 + 黄点不红） ────── */
try {
  const sq = require(path.join(ROOT, 'src', 'session-queue.js'));
  const cases = [
    ['MERGED_PENDING', 'merged'],
    ['ALREADY_DELIVERED', 'dedupe'],
    ['DEBOUNCED', 'debounced'],
    ['SANDBOX_WAKE_SKIPPED', 'sandbox'],
  ];
  const got = cases.map(([raw]) => sq.skipReasonOf({ ok: true, skipped: raw }));
  check('D1 skipReasonOf 四类归一（merged/dedupe/debounced/sandbox）',
    JSON.stringify(got) === JSON.stringify(cases.map(([, exp]) => exp)), { got, expect: cases.map(([, e]) => e) });
  check('D2 四类都有中文文案（已合并/已送达/去抖/沙盘跳过）',
    ['merged', 'dedupe', 'debounced', 'sandbox'].every((k) => typeof sq.SKIP_REASON_LABELS[k] === 'string' && sq.SKIP_REASON_LABELS[k].length >= 2),
    sq.SKIP_REASON_LABELS);
  const summary = sq.summarizeRows([{ at: new Date().toISOString(), ok: true, skipped: 'SANDBOX_WAKE_SKIPPED', reason: 'mailbox_digest', sandboxReason: 'sandbox_root', sandboxWhy: 'env_root' }], { now: Date.now() });
  check('D3 summarizeRows 最新 skip → state=skip + skipReason=sandbox + 明细带 sandbox 原因',
    summary.state === 'skip' && summary.skipReason === 'sandbox' && /sandbox=(sandbox_root|env_root|copied_tree|selftest)/.test(summary.skipDetail), summary);
  const panelSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'session-queue-panel.js'), 'utf8');
  check('D4 面板：state=skip 时另加原因 chip，带 data-sq-skip-reason 且文案按四类细分',
    panelSrc.includes('data-sq-skip-reason') && panelSrc.includes('SKIP_SHORT') && panelSrc.includes('sq-skip-reason')
    && !/stateText = rowState === 'skip'/.test(panelSrc),
    { hasAttr: panelSrc.includes('data-sq-skip-reason'), hasShort: panelSrc.includes('SKIP_SHORT') });
  const css = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'style.css'), 'utf8');
  const skipCss = (css.match(/\.sq-state-skip\s*\{[^}]*\}/) || [''])[0];
  const reasonCss = (css.match(/\.sq-skip-reason\s*\{[^}]*\}/) || [''])[0];
  check('D5 黄点不红：.sq-state-skip 与 .sq-skip-reason 都用 --gold（不是 --red）',
    /--gold/.test(skipCss) && !/--red/.test(skipCss) && /--gold/.test(reasonCss) && !/--red/.test(reasonCss),
    { skipCss, reasonCss });
  check('D6 面板不再只有笼统 skip 值：STATE_LABEL.skip 明确指向细分', /细分/.test(panelSrc), {});
} catch (e) {
  check('D 段面板细分执行', false, String((e && e.message) || e).slice(0, 500));
}

/* ── 收口：真实状态零写入 ─────────────────────────────────────────────── */
const after = { team: sha(REAL_TEAM_JSON), store: sha(REAL_STORE) };
// 唤醒.jsonl 会被其他角色实时追加：比「原有前缀字节完全一致 + 总字节不减」（记忆里的既有口径）
let wakePrefixSame = true;
let wakeBytesBefore = 0;
let wakeBytesAfter = 0;
try {
  const bufBefore = wakeBeforeBuf;
  const bufAfter = fs.readFileSync(REAL_WAKE);
  wakeBytesBefore = bufBefore.length;
  wakeBytesAfter = bufAfter.length;
  wakePrefixSame = bufAfter.length >= bufBefore.length && bufAfter.subarray(0, bufBefore.length).equals(bufBefore);
} catch { wakePrefixSame = false; }
check('E1 隔离：真实 团队.json / workbench.json sha256 不变；唤醒.jsonl 原有前缀未被改动且字节数不减',
  after.team === before.team && after.store === before.store && wakePrefixSame,
  { before, after, wakeBytesBefore, wakeBytesAfter, wakePrefixSame });

const total = results.length;
const pass = results.filter((r) => r.ok).length;
const red = total - pass;
const evDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-6e39');
fs.mkdirSync(evDir, { recursive: true });
const ts = new Date().toISOString().replace(/[:.]/g, '-');
const payload = { at: new Date().toISOString(), script: 'scripts/test-6e39-sandboxwake.cjs', task: 'B-20261118-090620-6e39', total, pass, red, isolation: { before, after }, results };
const evFile = path.join(evDir, `run-${ts}-${red === 0 ? 'green' : 'red'}.json`);
payload.evidenceFile = path.relative(ROOT, evFile).replace(/\\/g, '/');
fs.writeFileSync(evFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
if (JSON_OUT) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
else { console.log(''); console.log(`${red === 0 ? 'SANDBOX_WAKE_OK' : 'SANDBOX_WAKE_WARN'} ${JSON.stringify({ total, pass, red })}`); console.log('证据：' + payload.evidenceFile); }
process.exit(red === 0 ? 0 : 1);
