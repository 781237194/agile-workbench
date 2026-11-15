'use strict';
/**
 * R-9a8e / T-20261115-012022-df1d 断言：评审与正文版本绑定（version + hash / req stale / d225 合流）。
 *
 * AC1 改内容且 version+1 → G2 拦，错误信息「需重评：v旧→v新，变更点：…」+ review_stale_blocked 事件
 * AC2 重评后记录追加（不覆盖旧记录）
 * AC3 req stale 清单准确（stale / 已一致 / 从未评审分开）
 * AC3b req reopen（gateInvalidatedAt）也列，reason=reopened
 * AC4 改回历史版本默认仍要重评
 * AC5 无静默放行（改正文不更新记录 → 必被拦；门禁代码无「忽略 hash」分支）
 * AC6 旧正文无 version：首记 v1+legacy，正文 sha256 不变
 * AC7 忘涨版 → VERSION_NOT_BUMPED（不是 HASH_MISMATCH）
 *
 * 沙盘：_tmp/9a8e（TEAM_ROOT + TEAM_PROJECTS_ROOT 双隔离 + TEAM_SELFTEST=1 + 清空 sessionId）。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', '9a8e');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = '版本绑定沙盘';
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };
process.env.TEAM_ROOT = TEAM_ROOT;
process.env.TEAM_PROJECTS_ROOT = PROJECTS;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 360)}`);
  if (!ok) process.exitCode = 1;
}
function run(args) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
    const text = String(out).trim();
    const idx = text.indexOf('{');
    return { status: 0, json: idx >= 0 ? JSON.parse(text.slice(idx)) : null };
  } catch (e) {
    const stdout = String((e && e.stdout) || '') + String((e && e.stderr) || '');
    try { return { status: e.status, json: JSON.parse(stdout.slice(stdout.indexOf('{'))) }; } catch { return { status: e.status, json: null, raw: stdout.slice(0, 300) }; }
  }
}
const sha256 = (text) => crypto.createHash('sha256').update(text).digest('hex');

fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true, filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) });
const teamFile = path.join(TEAM_ROOT, '状态', '团队.json');
const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
for (const member of team.members || []) member.sessionId = '';
team.activeProject = PROJECT;
fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');
run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
// 需求正文一变，boot 登记的正文哈希就过期（TASK_DOCS_UNREAD）——每次改正文后必须重新 boot。
let pm = '';
let product = '';
let p1 = '';
function bootAll() {
  pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's9a-pm', '--json']).json.token;
  product = run(['boot', '--role', 'product', '--project', PROJECT, '--session', 's9a-pd', '--json']).json.token;
  p1 = run(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 's9a-p1', '--json']).json.token;
}
bootAll();

const projectDir = path.join(PROJECTS, PROJECT);
const reqDir = path.join(projectDir, '需求');
fs.mkdirSync(reqDir, { recursive: true });

function docText({ id, version, change, body }) {
  return [
    `# ${id} · 版本绑定夹具`,
    '',
    '<!-- req-doc: v2 -->',
    `version: ${version}`,
    `change: ${change}`,
    '',
    '## 一、这是什么',
    '',
    body,
    '',
    '## 二、为什么',
    '',
    '夹具需要。',
    '',
    '## 三、不定会怎样',
    '',
    '说不清。',
    '',
    '## 四、不做什么',
    '',
    '不做别的。',
    '',
    '## 五、边界清单',
    '',
    '| 类别 | 边界 | 处理 |',
    '|---|---|---|',
    '| 空值 | 为空 | 拒绝 |',
    '| 异常 | 失败报错 | 记录 |',
    '| 权限 | 越权 | 拒绝 |',
    '| 并发 | 同时改 | 版本冲突 |',
    '| 降级 | 不可用 | 提示重试 |',
    '| 模式 | 六人/四人 | 同口径 |',
    '',
    '## 六、验收标准',
    '',
    '- AC1 夹具断言。',
    '',
  ].join('\n');
}

const R1 = run(['req', 'create', '--boot', product, '--project', PROJECT, '--title', '版本绑定夹具', '--priority', 'P0', '--acceptance', 'AC1 夹具', '--json']).json.requirement.id;
const R2 = run(['req', 'create', '--boot', product, '--project', PROJECT, '--title', '从未评审夹具', '--priority', 'P2', '--acceptance', 'AC', '--json']).json.requirement.id;
const doc1 = path.join(reqDir, `${R1}-版本绑定夹具.md`);
const v1 = docText({ id: R1, version: 'v1', change: '首版', body: '第一版正文。' });
fs.writeFileSync(doc1, v1, 'utf8');
bootAll();

// 产品评审必须逐项给六类边界结论（PRODUCT_CHECKLIST_INCOMPLETE），夹具 comments 要覆盖六类关键词。
const CHECK = '空值：拒绝为空；异常：报错记录；权限：越权拒绝；并发：同时改走版本冲突；降级：不可用提示重试；模式：六人/四人同口径';
const rv1 = run(['req', 'review', '--boot', product, '--project', PROJECT, '--id', R1, '--verdict', 'approve', '--comments', `v1 通过。${CHECK}`, '--json']);
check('前置：v1 评审通过并写三元组（version=v1 + hash）', rv1.json && rv1.json.ok === true, rv1.json && (rv1.json.code || rv1.json.message));
const task1 = JSON.parse(fs.readFileSync(path.join(TEAM_ROOT, '状态', '项目', PROJECT, '任务', `${R1}.json`), 'utf8'));
const rec1 = task1.workflow && (task1.workflow.productReview || task1.workflow.requirementReview);
check('前置：评审记录带 version/requirementHash', Boolean(rec1) && rec1.version === 'v1' && String(rec1.requirementHash || '').length === 64, rec1 && { version: rec1.version, hash: String(rec1.requirementHash).slice(0, 12) });

// 造开发任务用于触发派单闸门 G2
const devTask = run(['task', 'create', '--boot', pm, '--project', PROJECT, '--type', 'task', '--title', '夹具开发任务', '--priority', 'P2', '--detail', '夹具', '--owner', 'programmer1', '--requirement', R1, '--json']).json.task.id;
function dispatch() {
  return run(['send', '--boot', pm, '--project', PROJECT, '--to', 'programmer1', '--subject', '派单夹具', '--body', '夹具派单', '--ack', '--task', devTask, '--json']);
}
function eventsOf(id) {
  // 事件链落在 团队/状态/事件.jsonl（不是项目目录）；只看 action/target 命中的行。
  const file = path.join(TEAM_ROOT, '状态', '事件.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean).filter((row) => String(row.target || (row.data && row.data.requirementId) || '') === id);
}

// ── AC1：改内容且 version+1 → G2 拦，信息含新旧版本号 ──
fs.writeFileSync(doc1, docText({ id: R1, version: 'v2', change: '补第二段', body: '第二版正文，改了内容。' }), 'utf8');
bootAll();
const ac1 = dispatch();
check('AC1 改内容且 version+1 → 派单被 G2 拦',
  ac1.json && ac1.json.ok === false && (ac1.json.details && (ac1.json.details.gate === 'G2' || String(ac1.json.code) === 'REQ_REVIEW_REQUIRED')), ac1.json && { code: ac1.json.code, gate: ac1.json.details && ac1.json.details.gate });
const ac1Msg = String((ac1.json && (ac1.json.message || (ac1.json.details && ac1.json.details.message))) || '');
check('AC1 错误信息含「需重评：v1→v2」与变更点',
  /需重评/.test(ac1Msg) && /v1\s*→\s*v2/.test(ac1Msg) && /补第二段/.test(ac1Msg), ac1Msg.slice(0, 200));
check('AC1 留一条 review_stale_blocked 事件',
  eventsOf(R1).some((row) => String(row.action) === 'review_stale_blocked'), eventsOf(R1).map((row) => row.action).slice(-6));

// ── AC7：忘涨版（改内容不动 version）──
const rv2 = run(['req', 'review', '--boot', product, '--project', PROJECT, '--id', R1, '--verdict', 'approve', '--comments', `v2 通过。${CHECK}`, '--json']);
check('AC2 前置：v2 评审通过（记录追加）', rv2.json && rv2.json.ok === true, rv2.json && rv2.json.code);
const taskAfter2 = JSON.parse(fs.readFileSync(path.join(TEAM_ROOT, '状态', '项目', PROJECT, '任务', `${R1}.json`), 'utf8'));
const reviewsDir = path.join(TEAM_ROOT, '状态', '项目', PROJECT, '需求评审');
const rrFiles = fs.existsSync(reviewsDir) ? fs.readdirSync(reviewsDir).filter((n) => n.startsWith('RR-') && n.endsWith('.json')) : [];
const rrForReq = rrFiles.map((n) => JSON.parse(fs.readFileSync(path.join(reviewsDir, n), 'utf8'))).filter((row) => String(row.requirementId) === R1);
check('AC2 重评后评审记录追加、旧记录仍在（两条，版本 v1/v2）',
  rrForReq.length === 2 && rrForReq.some((row) => row.version === 'v1') && rrForReq.some((row) => row.version === 'v2'),
  rrForReq.map((row) => row.version));

fs.writeFileSync(doc1, docText({ id: R1, version: 'v2', change: '补第二段', body: '第二版正文，又改了内容但忘了涨版。' }), 'utf8');
bootAll();
const ac7 = dispatch();
check('AC7 忘涨版 → VERSION_NOT_BUMPED（不是 HASH_MISMATCH）',
  ac7.json && ac7.json.ok === false && (String(ac7.json.code) === 'VERSION_NOT_BUMPED' || String((ac7.json.details && ac7.json.details.code) || '') === 'VERSION_NOT_BUMPED'),
  ac7.json && { code: ac7.json.code, details: ac7.json.details && ac7.json.details.code });

// ── AC4：改回历史版本（v1 内容）默认仍要重评 ──
fs.writeFileSync(doc1, docText({ id: R1, version: 'v1', change: '回退自 v2', body: '第一版正文。' }), 'utf8');
bootAll();
const ac4 = dispatch();
check('AC4 改回历史版本默认仍要重评（版本回退不复活旧评审）',
  ac4.json && ac4.json.ok === false && /需重评|VERSION_NOT_BUMPED/.test(String(ac4.json.code) + String(ac4.json.message || '')),
  ac4.json && { code: ac4.json.code, message: String(ac4.json.message || '').slice(0, 120) });

// ── AC3 / AC3b：req stale 清单 ──
// AC3b：真实 req reopen 只接受 dev_done/test_done，沙盘这里直接把「重开痕迹」写进工作流行
// （lastReopenAt + gateInvalidatedAt + gateInvalidatedBy=reopen，与 ops.mjs cmdReqReopen 同字段），
// 用来验证 stale 判据的 reopened 分支与 reason 优先级——不是改真相，是沙盘夹具。
const wfFile = path.join(TEAM_ROOT, '状态', '项目', PROJECT, '工作流.json');
if (!fs.existsSync(wfFile)) { check('AC3b 前置：工作流.json 存在（评审通过后应有行）', false, wfFile); }
const wf = JSON.parse(fs.readFileSync(wfFile, 'utf8'));
const rowR1 = wf.requirements[R1] || Object.values(wf.requirements).find((row) => row && String(row.id) === R1);
const reopenAt = new Date(Date.now() + 60000).toISOString();
rowR1.lastReopenAt = reopenAt;
rowR1.gateInvalidatedAt = reopenAt;
rowR1.gateInvalidatedBy = 'reopen';
rowR1.reopenCount = Number(rowR1.reopenCount || 0) + 1;
fs.writeFileSync(wfFile, JSON.stringify(wf, null, 2) + '\n', 'utf8');
check('AC3b 前置：工作流行带 lastReopenAt/gateInvalidatedAt（reopen 同字段）',
  Boolean(rowR1.lastReopenAt) && String(rowR1.gateInvalidatedBy) === 'reopen', { lastReopenAt: rowR1.lastReopenAt });
const stale = run(['req', 'stale', '--boot', pm, '--project', PROJECT, '--json']);
const staleIds = (stale.json && stale.json.stale || []).map((row) => row.requirementId);
check('AC3 stale 列出需要重评的需求', stale.json && stale.json.ok === true && staleIds.includes(R1), staleIds);
check('AC3 从未评审单独计数（不混进 stale）',
  stale.json && (stale.json.neverReviewed || []).some((row) => row.requirementId === R2) && !staleIds.includes(R2),
  { neverReviewed: (stale.json && stale.json.neverReviewed || []).map((row) => row.requirementId) });
const row1 = (stale.json && stale.json.stale || []).find((row) => row.requirementId === R1) || {};
check('AC3b reason=reopened 且卡门是枚举值',
  String(row1.reason) === 'reopened' && ['G2_REVIEW', 'TRQ', 'G3_OWNER', 'DEV_GATE', 'TEST_GATE', 'PENDING_VERIFY'].includes(String(row1.gate)),
  { reason: row1.reason, gate: row1.gate });

// ── AC6：旧正文无 version → 首记 v1+legacy，正文 sha256 不变 ──
const R3 = run(['req', 'create', '--boot', product, '--project', PROJECT, '--title', '旧正文夹具', '--priority', 'P2', '--acceptance', 'AC', '--json']).json.requirement.id;
const legacyDoc = path.join(reqDir, `${R3}-旧正文夹具.md`);
fs.writeFileSync(legacyDoc, '# 旧正文夹具\n\n## 一、这是什么\n\n历史正文，无 version 头。\n', 'utf8');
bootAll();
const legacyHashBefore = sha256(fs.readFileSync(legacyDoc));
const rvLegacy = run(['req', 'review', '--boot', product, '--project', PROJECT, '--id', R3, '--verdict', 'approve', '--comments', '旧正文通过', '--json']);
const legacyTask = JSON.parse(fs.readFileSync(path.join(TEAM_ROOT, '状态', '项目', PROJECT, '任务', `${R3}.json`), 'utf8'));
const legacyRec = legacyTask.workflow && (legacyTask.workflow.productReview || legacyTask.workflow.requirementReview);
check('AC6 旧正文无 version：记录写 version=v1 + legacy=true',
  rvLegacy.json && rvLegacy.json.ok === true && legacyRec && legacyRec.version === 'v1' && legacyRec.legacy === true,
  legacyRec && { version: legacyRec.version, legacy: legacyRec.legacy });
check('AC6 正文 sha256 前后不变（程序只写记录）', sha256(fs.readFileSync(legacyDoc)) === legacyHashBefore, {});

// ── AC5：无静默放行（门禁代码不存在「忽略 hash/仅比 id」的分支）──
const gatesSrc = fs.readFileSync(path.join(TEAM_ROOT, '工具', 'lib', 'gates.mjs'), 'utf8');
check('AC5 门禁代码里没有“忽略 hash”的放行分支',
  !/requirementHash\s*\|\|\s*true/.test(gatesSrc) && !/if\s*\(\s*false\s*\)/.test(gatesSrc), {});
const blockAfterChange = dispatch();
check('AC5 改正文但不更新记录 → 必被拦（无静默放行）', blockAfterChange.json && blockAfterChange.json.ok === false, blockAfterChange.json && blockAfterChange.json.code);

const passed = results.filter((row) => row.ok).length;
const failed = results.length - passed;
console.log(`\nR-9a8e 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
fs.writeFileSync(path.join(SB, 'run-9a8e.json'), JSON.stringify({ passed, failed, results }, null, 2) + '\n', 'utf8');
