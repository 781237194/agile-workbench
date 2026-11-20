'use strict';
/**
 * 夹具：R-e438 批① boot --json 瘦身（AC1/AC2/AC3④）
 *
 * 口径（增补卷-e438-1.md §六 + 主卷 §6.1）：
 *  - 默认 slim：三数组只留预览（tasks 3 / unread 3 / proposals 2）+ counts.* 真值；
 *    tasks 字段级裁剪、unread 去 body、read 压 {path,sha12,at}、docHashes→docDigest、handoverMeta 压 {at,from,to,sha12}；
 *    新键 teamRoot/projectPath/bootedAt/indexPaths/counts/docsBrief/bootMeta。
 *  - 体积判据 = Buffer.byteLength(stdout) ≤ 65536；--full 全量且含默认所有键。
 *  - 壳层 team-tools.js 两处解析（bootRole 记录 / refreshBootCache）counts 优先，不出现 0/3/NaN。
 *
 * 隔离：boot 本身会写启动令牌/阅读回执/boots，这是正常操作；本夹具只读解析 stdout，不写业务数据。
 * 跑法：node scripts/test-e438-boot-slim.cjs [--project 工作台改造修复]
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const argOf = (name, def) => { const i = args.indexOf(name); return i >= 0 && args[i + 1] ? args[i + 1] : def; };
const PROJECT = String(argOf('--project', '工作台改造修复'));
const BUDGET = 65536;
const RESULT = [];
function check(id, title, ok, detail) {
  RESULT.push({ id, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${title}${ok ? '' : '  ← ' + String(JSON.stringify(detail === undefined ? '' : detail)).slice(0, 420)}`);
  if (!ok) process.exitCode = 1;
}
function boot(role, extra = []) {
  const r = spawnSync(process.execPath, ['团队/工具/team.mjs', 'boot', '--role', role, '--project', PROJECT, '--json', ...extra], {
    cwd: ROOT, encoding: 'buffer', maxBuffer: 64 * 1024 * 1024,
  });
  let json = null;
  try { json = JSON.parse(r.stdout.toString('utf8')); } catch { json = null; }
  return { status: r.status, bytes: r.stdout.length, json, stderr: r.stderr.toString('utf8') };
}
const has = (obj, key) => Boolean(obj) && Object.prototype.hasOwnProperty.call(obj, key);

const slimProduct = boot('product');
const fullProduct = boot('product', ['--full']);
const slimPm = boot('pm');
const fullPm = boot('pm', ['--full']);
const slimP1 = boot('programmer1');

/* ── AC1① 体积 ─────────────────────────────────────────────── */
check('S1', `product 默认 stdout ${slimProduct.bytes}B ≤ ${BUDGET}（改造前 269.7KB 量级）`,
  slimProduct.status === 0 && slimProduct.bytes <= BUDGET && Boolean(slimProduct.json && slimProduct.json.ok),
  { bytes: slimProduct.bytes, status: slimProduct.status });
check('S2', `pm（最坏档）默认 stdout ${slimPm.bytes}B ≤ ${BUDGET}（改造前 5.28MB）`,
  slimPm.status === 0 && slimPm.bytes <= BUDGET && Boolean(slimPm.json && slimPm.json.ok),
  { bytes: slimPm.bytes, status: slimPm.status });
check('S3', '无 BOOT_SLIM_OVER_BUDGET 告警（bootMeta.overBudget=false）',
  !/BOOT_SLIM_OVER_BUDGET/.test(slimPm.stderr + slimProduct.stderr)
  && slimPm.json.bootMeta && slimPm.json.bootMeta.overBudget === false
  && slimProduct.json.bootMeta && slimProduct.json.bootMeta.overBudget === false, { stderr: slimPm.stderr.slice(0, 160) });

/* ── AC1② --full 全量 ──────────────────────────────────────── */
check('F1', '--full 体积远大于默认（product ≥20×、pm ≥200×）且 ≥改造前 95%（product ≥240KB / pm ≥4.5MB）',
  fullProduct.bytes >= slimProduct.bytes * 20 && fullProduct.bytes >= 240000
  && fullPm.bytes >= slimPm.bytes * 200 && fullPm.bytes >= 4500000,
  { fullProduct: fullProduct.bytes, fullPm: fullPm.bytes });
{
  const keys = ['ok', 'role', 'project', 'sessionId', 'teamMode', 'token', 'briefing', 'unread', 'tasks', 'proposals'];
  const missing = keys.filter((k) => !has(fullPm.json, k));
  check('F2', '--full 含默认所有键（ok/role/project/sessionId/teamMode/token/briefing/unread/tasks/proposals）',
    fullPm.json && fullPm.json.ok === true && missing.length === 0, { missing });
  check('F3', '--full 的 unread/tasks 仍是全量数组（pm unread > 3、product unread > 3）',
    Array.isArray(fullPm.json.unread) && fullPm.json.unread.length > 3 && Array.isArray(fullProduct.json.unread) && fullProduct.json.unread.length > 3,
    { pm: fullPm.json.unread.length, product: fullProduct.json.unread.length });
  check('F4', 'bootMeta：默认 slim=true，--full slim=false',
    slimPm.json.bootMeta.slim === true && fullPm.json.bootMeta.slim === false && fullProduct.json.bootMeta.slim === false, {});
}

/* ── AC1③ 五字段默认与 --full 一致 ─────────────────────────── */
{
  const pick = (j) => ({ role: j.role, project: j.project, sessionId: j.sessionId, rulesHash: j.rulesHash, rosterVersion: j.rosterVersion, teamRoot: j.teamRoot });
  const a = pick(slimPm.json); const b = pick(fullPm.json);
  check('E1', '五字段默认==--full（role/project/sessionId/rulesHash/rosterVersion/teamRoot）',
    JSON.stringify(a) === JSON.stringify(b) && a.role === 'pm' && a.project === PROJECT, { slim: a, full: b });
  check('E2', 'token 两路均有且非空（每次 boot 重签，值允许不同）',
    typeof slimPm.json.token === 'string' && slimPm.json.token.length > 8 && typeof fullPm.json.token === 'string' && fullPm.json.token.length > 8, {});
}

/* ── AC2 三问 ─────────────────────────────────────────────── */
{
  const j = slimProduct.json;
  const paths = j.indexPaths || {};
  const four = ['项目索引', '流程', '协作准则', '文档登记'];
  const missingPath = four.filter((k) => !(paths[k] && paths[k].path));
  const missingFile = four.filter((k) => !(paths[k] && paths[k].exists));
  check('Q1', '我是谁：role/project/sessionId + briefing（≤2000 字，按字符口径）+ rolecardDigest 都在',
    j.role === 'product' && j.project === PROJECT && typeof j.briefing === 'string' && j.briefing.length > 0
    && String(j.briefing || '').length <= 2000 && Boolean(j.rolecardDigest),
    { briefingChars: String(j.briefing || '').length, briefingBytes: Buffer.byteLength(String(j.briefing || '')) });
  check('Q2', '流程去哪看：indexPaths 四入口路径齐全且文件存在',
    missingPath.length === 0 && missingFile.length === 0, { paths, missingPath, missingFile });
  check('Q3', '某事实去哪找：被砍项在 briefing 有替代路径（inbox/task list/propose/--full 任一）',
    /inbox|task list|propose|--full|index|文档登记|presence/i.test(String(j.briefing || '')), { briefingTail: String(j.briefing || '').slice(-300) });
}

/* ── 字段形态（增补卷 §六） ────────────────────────────────── */
{
  const j = slimProduct.json;
  const c = j.counts;
  check('D1', 'counts 真值：unread/tasks/pendingProposals + 预览条数（3/3/2）',
    Boolean(c) && Number.isInteger(c.unread) && Number.isInteger(c.pendingProposals)
    && c.tasks && Number.isInteger(c.tasks.open) && Number.isInteger(c.tasks.working)
    && j.unread.length === Math.min(3, c.unread) && j.tasks.length === Math.min(3, c.tasks.open + c.tasks.working + c.tasks.done)
    && j.proposals.length === Math.min(2, c.pendingProposals), { counts: c, lens: { unread: j.unread.length, tasks: j.tasks.length, proposals: j.proposals.length } });
  check('D2', 'tasks 字段级裁剪：仅 {id,title,status,owner,priority,updatedAt}，title≤60',
    j.tasks.every((t) => Object.keys(t).sort().join(',') === 'id,owner,priority,status,title,updatedAt'.split(',').sort().join(',') && String(t.title).length <= 60), { tasks: j.tasks });
  check('D3', 'unread 去 body：仅 {id,subject,from,at,taskId,ackRequired}，subject≤160',
    j.unread.every((m) => Object.keys(m).sort().join(',') === 'ackRequired,at,from,id,subject,taskId'.split(',').sort().join(',') && String(m.subject).length <= 160 && !has(m, 'body')), { unread: j.unread });
  check('D4', 'read 压 {path,sha12,at}；docHashes 删除 → docDigest{constitutionSha12,roleCardSha12}',
    Array.isArray(j.read) && j.read.every((r) => has(r, 'path') && /^[0-9a-f]{12}$/.test(String(r.sha12)) && has(r, 'at'))
    && !has(j, 'docHashes') && j.docDigest && /^[0-9a-f]{12}$/.test(String(j.docDigest.constitutionSha12)) && /^[0-9a-f]{12}$/.test(String(j.docDigest.roleCardSha12)), { read0: j.read[0], docDigest: j.docDigest });
  check('D5', 'handoverMeta 仅 {at,from,to,sha12}（且 handover 正文不进默认输出）',
    (j.handoverMeta === null || Object.keys(j.handoverMeta).sort().join(',') === 'at,from,sha12,to') && j.handover === null, { handoverMeta: j.handoverMeta });
  check('D6', '新键齐全：teamRoot/projectPath/bootedAt/indexPaths/counts/docsBrief/bootMeta',
    ['teamRoot', 'projectPath', 'bootedAt', 'indexPaths', 'counts', 'docsBrief', 'bootMeta'].every((k) => has(j, k))
    && Array.isArray(j.docsBrief) && j.docsBrief.every((x) => x && has(x, 'key') && has(x, 'sha12')), { docsBrief: j.docsBrief.slice(0, 2) });
  check('D7', 'bootMeta.bytes 与实测 stdout 字节一致（±1）',
    Math.abs(Number(j.bootMeta.bytes) - slimProduct.bytes) <= 1, { reported: j.bootMeta.bytes, actual: slimProduct.bytes });
}

/* ── AC3④ 壳层 counts 优先（静态 + 三处调用点） ────────────── */
{
  const src = fs.readFileSync(path.join(ROOT, 'src', 'team-tools.js'), 'utf8');
  check('C1', 'team-tools.js 有 bootCountOf 且两处解析都走 counts 优先（数组 length / Number 回退）',
    /function bootCountOf\(value, key, legacy\)/.test(src) && (src.match(/bootCountOf\(value, 'tasks'/g) || []).length >= 2
    && (src.match(/bootCountOf\(value, 'unread'/g) || []).length >= 2, { hits: (src.match(/bootCountOf\(/g) || []).length });
  check('C2', '壳层不再直接用 Array.isArray(unread).length / Number(unread||0) 当计数',
    !/unread: Array\.isArray\(value\.unread\) \? value\.unread\.length : 0,/.test(src)
    && !/unread: Number\(value\.unread \|\| 0\),/.test(src), {});
}

const total = RESULT.length;
const pass = RESULT.filter((x) => x.ok).length;
console.log(`\n${pass}/${total} PASS`);
console.log('BOOT_SLIM_MEASURED ' + JSON.stringify({ product: slimProduct.bytes, pm: slimPm.bytes, programmer1: slimP1.bytes, fullProduct: fullProduct.bytes, fullPm: fullPm.bytes }));
if (pass !== total) process.exitCode = 1;
