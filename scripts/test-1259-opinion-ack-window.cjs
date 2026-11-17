#!/usr/bin/env node
'use strict';
/**
 * test-1259-opinion-ack-window.cjs —— B-20261117-080706-1259 回归夹具
 *
 * 缺陷：Owner 意见的「已消费集合」只从工作流行 `history` 里查 `action=owner_opinion_ack`，
 * 而 `lifecycle.appendRowHistory()` 只保留最近 100 条（lifecycle.mjs:122）——
 * 一条 ack 被挤出窗口后，同一意见会被再次要求 ack（重复劳动 + 台账抖动）。
 *
 * 断言：
 *   S1 前提成立：lifecycle.mjs 仍有 100 条截断；ops.mjs 的判定读项目级 `意见消费.jsonl`
 *   U1 无任何 ack → OWNER_OPINION_UNREAD（不静默放行）
 *   U2 history 里有 ack（未带 projectName，纯函数旧签名）→ ACKED / source=history
 *   U3 history 被截断（120 条无关条目）但持久落点有 sha → ACKED / source=persist   ← 本单核心
 *   U4 反例：持久落点也没有该 sha → 仍 UNREAD（证明不是「一律放行」）
 *   U5 空意见不拦（EMPTY_OPINION）
 *   C1 CLI `req ack-backfill`（PM）把 history 里的 ack 回填到 意见消费.jsonl，幂等（第二次 appended=0）
 *   C2 回填后把 history 整段换掉（模拟被挤出）→ 门禁仍 ACKED（persist）
 *
 * 隔离：mkTempSandbox + TEAM_ROOT/TEAM_PROJECTS_ROOT/TEAM_WORKBENCH_JSON/TEAM_SELFTEST=1。
 * 用法：node scripts/test-1259-opinion-ack-window.cjs
 * 退出码：0 全过 / 1 有断言失败 / 2 环境错误
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const ROOT = path.resolve(__dirname, '..');
const SB = mkTempSandbox('1259');
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench.json');
const TEAM_TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const PROJECT = '意见消费沙盘';
const sha256 = (s) => crypto.createHash('sha256').update(String(s), 'utf8').digest('hex');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 320)}`);
}
const env = () => ({
  ...process.env,
  TEAM_ROOT: TEAM,
  TEAM_PROJECTS_ROOT: PROJECTS,
  TEAM_WORKBENCH_JSON: STORE,
  TEAM_SELFTEST: '1',
});
function run(args) {
  try {
    return { code: 0, out: String(execFileSync(process.execPath, [TEAM_TOOL, ...args], { encoding: 'utf8', env: env(), timeout: 180000, cwd: SB })) };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
}
function runJson(args) {
  const r = run(args);
  const t = String(r.out || '').trim();
  const i = t.indexOf('{');
  let json = null;
  if (i >= 0) { try { json = JSON.parse(t.slice(i)); } catch { json = null; } }
  return { ...r, json };
}

if (!fs.existsSync(TEAM_TOOL)) { console.error('环境错误：找不到 team.mjs'); process.exit(2); }

(async () => {

// ── 沙盘骨架
fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
fs.mkdirSync(PROJECTS, { recursive: true });
const teamSrc = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8'));
for (const m of teamSrc.members || []) m.sessionId = '';
teamSrc.activeProjectId = '';
fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(teamSrc, null, 2) + '\n', 'utf8');
for (const rel of ['团队宪法.md', '项目铁律.md']) {
  const src = path.join(ROOT, '团队', rel);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TEAM, rel));
}
for (const d of ['协议', '模板']) {
  const s = path.join(ROOT, '团队', d);
  if (fs.existsSync(s)) fs.cpSync(s, path.join(TEAM, d), { recursive: true });
}
fs.cpSync(path.join(ROOT, '团队', '工具'), path.join(TEAM, '工具'), { recursive: true });

// in-process 导入 ops 前先固定沙盘环境（ops 读 PATHS 是模块级常量）
for (const [k, v] of Object.entries({ TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_WORKBENCH_JSON: STORE, TEAM_SELFTEST: '1' })) process.env[k] = v;
const ops = await import(pathToFileURL(path.join(TEAM, '工具', 'lib', 'ops.mjs')).href);

// ── S1 前提（静态）
const lifecycleSrc = fs.readFileSync(path.join(ROOT, '团队', '工具', 'lib', 'lifecycle.mjs'), 'utf8');
const opsSrc = fs.readFileSync(path.join(ROOT, '团队', '工具', 'lib', 'ops.mjs'), 'utf8');
check('S1 前提成立：lifecycle 仍按 100 条截断 history，且判定读项目级 意见消费.jsonl',
  /row\.history\.length > 100/.test(lifecycleSrc) && lifecycleSrc.includes('slice(-100)')
  && opsSrc.includes('意见消费.jsonl')
  && /export function ownerOpinionGateFor\(row, opts/.test(opsSrc),
  { cap: /row\.history\.length > 100/.test(lifecycleSrc), file: opsSrc.includes('意见消费.jsonl') });

// ── 建项目 + PM/评审人令牌（供 C1/C2）
const addProject = runJson(['project', 'add', '--name', PROJECT, '--team-mode', 'fast', '--json']);
if (addProject.code !== 0) { console.error('环境错误：project add 失败'); process.exit(2); }
const bootPm = runJson(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-pm-1259', '--json']);
const PM = String((bootPm.json && bootPm.json.token) || '');
if (!PM) { console.error('环境错误：PM 未取到令牌'); process.exit(2); }
run(['lessons', 'read', '--boot', PM, '--project', PROJECT, '--json']);
const reqCreate = runJson(['req', 'create', '--boot', PM, '--project', PROJECT, '--title', '1259 意见消费沙盘需求', '--priority', 'P2', '--acceptance', 'AC1', '--json']);
const REQ = String((reqCreate.json && reqCreate.json.requirement && reqCreate.json.requirement.id) || '');
if (!REQ) { console.error('环境错误：req create 失败 ' + JSON.stringify(reqCreate).slice(0, 300)); process.exit(2); }

// ── 直接在沙盘工作流里造一个「Owner 已批 + 带意见」的行（评审证据门不是本单对象）
const wfFile = path.join(TEAM, '状态', '项目', PROJECT, '工作流.json');
const OPINION = '这条意见用于验证 ack 去重窗口（1259 夹具）';
const sha = sha256(OPINION);
const writeRow = (history) => {
  const wf = JSON.parse(fs.readFileSync(wfFile, 'utf8'));
  const row = wf.requirements[REQ] || { id: REQ, status: 'ready', round: 1 };
  Object.assign(row, {
    status: 'ready',
    decisions: [{ status: 'approved', at: '2026-11-17T00:00:00.000Z', channel: 'ui', opinion: OPINION }],
    ownerReview: { status: 'approved', at: '2026-11-17T00:00:00.000Z', opinion: OPINION, channel: 'ui' },
    history: Array.isArray(history) ? history : [],
  });
  wf.requirements[REQ] = row;
  fs.writeFileSync(wfFile, JSON.stringify(wf, null, 2) + '\n', 'utf8');
  return row;
};
const filler = (n) => Array.from({ length: n }, (_, i) => ({ at: `2026-11-17T00:${String(i % 60).padStart(2, '0')}:00.000Z`, action: 'advance', by: 'system', note: `filler-${i}` }));

// ── U1/U2/U5：纯函数口径（不带 projectName，保持旧签名兼容）
const rowNoAck = writeRow([]);
check('U1 无任何 ack → OWNER_OPINION_UNREAD（不静默放行）',
  ops.ownerOpinionGateFor(rowNoAck).code === 'OWNER_OPINION_UNREAD', ops.ownerOpinionGateFor(rowNoAck));
const rowHistAck = { ...rowNoAck, history: [{ action: 'owner_opinion_ack', opinionSha256: sha }] };
check('U2 history 里有 ack（旧签名，无 projectName）→ ACKED / source=history',
  ops.ownerOpinionGateFor(rowHistAck).ok === true && ops.ownerOpinionGateFor(rowHistAck).source === 'history',
  ops.ownerOpinionGateFor(rowHistAck));
check('U5 空意见不拦（EMPTY_OPINION）',
  ops.ownerOpinionGateFor({ status: 'approved', decisions: [{ status: 'approved', opinion: '', at: '2026-11-17T00:00:00.000Z' }] }).ok === true);

// ── C1：CLI 回填（PM）
const rowForBackfill = writeRow([{ at: '2026-11-17T00:10:00.000Z', action: 'owner_opinion_ack', by: 'product', note: '采纳：先这样', opinionSha256: sha }]);
const backfill1 = runJson(['req', 'ack-backfill', '--boot', PM, '--project', PROJECT, '--json']);
const ackFile = path.join(TEAM, '状态', '项目', PROJECT, '意见消费.jsonl');
const ackText = fs.existsSync(ackFile) ? fs.readFileSync(ackFile, 'utf8') : '';
check('C1 req ack-backfill 落 意见消费.jsonl（含 sha/req/by，source=backfill）',
  backfill1.code === 0 && backfill1.json && Number(backfill1.json.appended) >= 1
  && ackText.includes(sha) && ackText.includes(REQ) && ackText.includes('backfill'),
  { code: backfill1.code, json: backfill1.json, fileExists: fs.existsSync(ackFile) });
const backfill2 = runJson(['req', 'ack-backfill', '--boot', PM, '--project', PROJECT, '--json']);
check('C1b 回填幂等：第二次 appended=0，文件不膨胀',
  backfill2.code === 0 && Number(backfill2.json && backfill2.json.appended) === 0,
  backfill2.json);

// ── U3/U4：history 被挤出窗口后的判定
const truncated = writeRow([...filler(120)]); // ack 已被挤出 100 条窗口
const gateTruncated = ops.ownerOpinionGateFor(truncated, { projectName: PROJECT });
check('U3 history 被截断（120 条无关条目、ack 已挤出）但持久落点有 sha → ACKED / source=persist',
  gateTruncated.ok === true && gateTruncated.source === 'persist', gateTruncated);
const otherOpinion = '另一条没 ack 过的意见';
const rowOther = { ...truncated, decisions: [{ status: 'approved', at: '2026-11-17T01:00:00.000Z', opinion: otherOpinion }] };
check('U4 反例：新意见的 sha 不在持久落点/ history → 仍 UNREAD（不是一律放行）',
  ops.ownerOpinionGateFor(rowOther, { projectName: PROJECT }).code === 'OWNER_OPINION_UNREAD',
  ops.ownerOpinionGateFor(rowOther, { projectName: PROJECT }));

// ── C2：CLI 回填后把 history 整段换掉，门禁仍 ACKED（真实文件读路径）
writeRow([{ at: '2026-11-17T00:10:00.000Z', action: 'owner_opinion_ack', by: 'product', note: '采纳：先这样', opinionSha256: sha }]);
run(['req', 'ack-backfill', '--boot', PM, '--project', PROJECT, '--json']);
const rowAfter = writeRow([...filler(120)]);
const gateAfter = ops.ownerOpinionGateFor(rowAfter, { projectName: PROJECT });
check('C2 回填后 history 被整段换掉（模拟挤出）→ 门禁仍 ACKED（读持久落点）',
  gateAfter.ok === true && gateAfter.source === 'persist', gateAfter);

const total = passed + failures.length;
const outFile = process.env.AWB_1259_OUT
  ? (path.isAbsolute(process.env.AWB_1259_OUT) ? process.env.AWB_1259_OUT : path.join(ROOT, process.env.AWB_1259_OUT))
  : path.join(ROOT, '_tmp', 'run-1259.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({ task: 'B-20261117-080706-1259', at: new Date().toISOString(), total, pass: passed, red: failures.length, failures }, null, 2) + '\n', 'utf8');
console.log(`\nOPINION_ACK_WINDOW ${JSON.stringify({ total, pass: passed, red: failures.length })}`);
console.log('证据：' + outFile);
process.exit(failures.length ? 1 : 0);
})().catch((e) => {
  console.error('OPINION_ACK_WINDOW_FAILED ' + String((e && e.stack) || e));
  process.exit(2);
});
