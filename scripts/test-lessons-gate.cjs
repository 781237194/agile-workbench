#!/usr/bin/env node
'use strict';
/**
 * test-lessons-gate.cjs —— R-51de（一）经验教训读记录与换人门禁断言（AC4 五条）
 *
 * 沙盘运行：TEAM_ROOT / TEAM_PROJECTS_ROOT / TEAM_WORKBENCH_JSON 全指向 _tmp 沙盘，
 * 不碰真实 团队/ 与真实项目。断言用真实 CLI（execFileSync）跑，不直接调函数。
 *
 * 用法：node scripts/test-lessons-gate.cjs
 * 退出码：0 全过 / 1 有断言失败 / 2 环境错误
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', 'lessons-gate-' + Date.now().toString(36));
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench.json');
const PROJECT = '沙盘经验教训';

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 300)}`);
}

function env() {
  return {
    ...process.env,
    TEAM_ROOT: TEAM,
    TEAM_PROJECTS_ROOT: PROJECTS,
    TEAM_WORKBENCH_JSON: STORE,
    TEAM_SELFTEST: '1',
  };
}

function run(args) {
  try {
    const out = execFileSync(process.execPath, [path.join(ROOT, '团队', '工具', 'team.mjs'), ...args], { encoding: 'utf8', env: env(), timeout: 90000 });
    return { code: 0, out, err: '' };
  } catch (error) {
    return { code: error.status == null ? 1 : error.status, out: String(error.stdout || ''), err: String(error.stderr || '') };
  }
}

// ── 造沙盘：复制真实 团队/ 骨架（团队.json + 工具），建一个项目 + 需求正文 + 经验教训登记册
function seed() {
  fs.mkdirSync(SB, { recursive: true });
  fs.mkdirSync(PROJECTS, { recursive: true });
  // 团队.json：清空所有 sessionId（沙盘复验铁律），只留角色
  const teamSrc = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8'));
  for (const m of teamSrc.members || []) { m.sessionId = ''; }
  teamSrc.activeProjectId = '';
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(teamSrc, null, 2), 'utf8');
  // boot 必读：团队级宪法 + 团队项目铁律 + 协议目录（沙盘必须自带，否则 MISSING_DOC）
  for (const rel of ['团队宪法.md', '项目铁律.md']) {
    const src = path.join(ROOT, '团队', rel);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TEAM, rel));
  }
  const protoSrc = path.join(ROOT, '团队', '协议');
  if (fs.existsSync(protoSrc)) fs.cpSync(protoSrc, path.join(TEAM, '协议'), { recursive: true });
  // 沙盘项目目录 + 六段登记册 + 需求正文
  const projDir = path.join(PROJECTS, PROJECT);
  fs.mkdirSync(path.join(projDir, '需求'), { recursive: true });
  const lessonsMd = [
    '# 经验教训登记册（沙盘）',
    '',
    '## 项目经理',
    '',
    '| 日期 | 场景 | 教训 | 下次怎么做 |',
    '|---|---|---|---|',
    '| 2026-11-16 | 沙盘 PM 条 | 教训一 | 做法一 |',
    '',
    '## 产品',
    '',
    '| 日期 | 场景 | 教训 | 下次怎么做 |',
    '|---|---|---|---|',
    '| 2026-11-16 | 沙盘产品条 | 教训二 | 做法二 |',
    '',
    '## 需求分析师',
    '',
    '| 日期 | 场景 | 教训 | 下次怎么做 |',
    '|---|---|---|---|',
    '| 2026-11-16 | 沙盘分析师条 | 教训三 | 做法三 |',
    '',
    '## 程序员A',
    '',
    '| 日期 | 场景 | 教训 | 下次怎么做 |',
    '|---|---|---|---|',
    '| 2026-11-16 | 沙盘程序员A条 | 教训四 | 做法四 |',
    '',
    '## 程序员B',
    '',
    '| 日期 | 场景 | 教训 | 下次怎么做 |',
    '|---|---|---|---|',
    '| 2026-11-16 | 沙盘程序员B条 | 教训五 | 做法五 |',
    '',
    '## 测试',
    '',
    '| 日期 | 场景 | 教训 | 下次怎么做 |',
    '|---|---|---|---|',
    '| 2026-11-16 | 沙盘测试条 | 教训六 | 做法六 |',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(projDir, '经验教训登记册.md'), lessonsMd, 'utf8');
  const reqDoc = [
    '<!-- req-doc: v2 -->',
    '# 沙盘需求：经验教训门禁',
    '',
    '## 一、是什么',
    '沙盘用例，验证 lessons read 与 LESSONS_UNREAD 门禁。',
    '',
    '## 二、不做什么（越界禁令）',
    '不改真实项目。',
    '',
    '## 三、验收标准',
    '- AC1 读记录与门禁可用。',
    '',
    '## 四、边界清单',
    '',
    '| 类别 | 边界 | 处理 |',
    '|---|---|---|',
    '| 空值 | 无阅读记录 | 视同未读 |',
    '| 异常 | 文件缺失 | LESSONS_FILE_MISSING |',
    '| 权限 | Owner 通道 | 豁免不检查 |',
    '| 并发 | 同版本重复读 | 不重复落行 |',
    '| 降级 | CLI 不可用 | 门禁报未读 |',
    '| 模式 | fast 团队缺段 | 不算损坏 |',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(projDir, '需求', 'R-20261116-000000-less.md'), reqDoc, 'utf8');
  return projDir;
}

if (!fs.existsSync(path.join(ROOT, '团队', '工具', 'team.mjs'))) {
  console.error('环境错误：找不到 team.mjs');
  process.exit(2);
}
const projDir = seed();
// 沙盘必须先登记项目（否则 NO_PROJECT）；用 --path 指向沙盘项目目录
const cleanReadLog = () => { const lp = path.join(TEAM, '状态', '经验教训阅读.jsonl'); if (fs.existsSync(lp)) fs.writeFileSync(lp, '', 'utf8'); };
const addProject = run(['project', 'add', '--name', PROJECT, '--path', path.join(PROJECTS, PROJECT)]);
check('S0 沙盘项目登记', addProject.code === 0, { code: addProject.code, out: (addProject.out + addProject.err).slice(0, 300) });

// boot（PM 身份）
const bootPm = run(['boot', '--role', 'pm', '--project', PROJECT]);
check('S1 PM boot 成功', bootPm.code === 0, { code: bootPm.code, out: bootPm.out.slice(0, 200), err: bootPm.err.slice(0, 200) });
let pmToken = (/(?:令牌|token)[:：]\s*([0-9a-f]{6,})/i.exec(bootPm.out) || [])[1] || '';
check('S2 取到 PM 令牌', Boolean(pmToken), { out: bootPm.out.slice(0, 200) });

// AC4④：boot 简报里出现 LESSONS_UNREAD 红条，但 boot 成功
check('S3 AC4④ boot 未读 → 简报含 LESSONS_UNREAD 且 boot 仍成功',
  bootPm.code === 0 && /LESSONS_UNREAD/.test(bootPm.out), { hasCode: /LESSONS_UNREAD/.test(bootPm.out) });

// AC4①：清掉记录后执行 req review → LESSONS_UNREAD（沙盘里本来就没有记录）
const reviewBefore = run(['req', 'review', '--boot', pmToken, '--id', 'R-20261116-000000-less', '--verdict', 'approve', '--comments', '空值=无记录视同未读；异常=文件缺失报码；权限=Owner豁免；并发=同版本不重复落行；降级=CLI不可用报未读；模式=fast缺段不算损坏']);
check('S4 AC4① 未读时 req review → LESSONS_UNREAD',
  reviewBefore.code !== 0 && /LESSONS_UNREAD/.test(reviewBefore.out + reviewBefore.err),
  { code: reviewBefore.code, out: (reviewBefore.out + reviewBefore.err).slice(0, 300) });

// AC4②：lessons read 后同一操作通过门禁
const readRes = run(['lessons', 'read', '--boot', pmToken]);
check('S5 lessons read 落记录', readRes.code === 0 && /已记录阅读|已读过/.test(readRes.out), { out: readRes.out.slice(0, 200) });
const logPath = path.join(TEAM, '状态', '经验教训阅读.jsonl');
const logRows = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
check('S6 阅读记录含 role/sessionId/fileSha/entries/source', logRows.length >= 1
  && ['role', 'sessionId', 'fileSha', 'entries', 'source'].every((k) => Object.prototype.hasOwnProperty.call(logRows[logRows.length - 1], k)), logRows[logRows.length - 1]);

// 同版本重复读不追加行
const readAgain = run(['lessons', 'read', '--boot', pmToken]);
const logRows2 = fs.readFileSync(logPath, 'utf8').trim().split('\n').filter(Boolean);
check('S7 同版本重复读不追加行（already_read）',
  readAgain.code === 0 && /已读过/.test(readAgain.out) && logRows2.length === logRows.length,
  { rows: logRows.length, rows2: logRows2.length, out: readAgain.out.slice(0, 120) });

// S11（tester 注记）：正向路径——读过当前版本后同一操作**不**返回 LESSONS_UNREAD
const reviewAfterRead = run(['req', 'review', '--boot', pmToken, '--id', 'R-20261116-000000-less', '--verdict', 'approve', '--comments', '空值=读过放行；异常=文件缺失报码；权限=Owner豁免；并发=同版本不重复落行；降级=CLI不可用报未读；模式=fast缺段不算损坏']);
check('S11 正向：lessons read 后 req review 不再返回 LESSONS_UNREAD',
  !/LESSONS_UNREAD/.test(reviewAfterRead.out + reviewAfterRead.err),
  { code: reviewAfterRead.code, out: (reviewAfterRead.out + reviewAfterRead.err).slice(0, 300) });

// AC4③：改 md 一行（sha 变）→ 同一操作又 LESSONS_UNREAD
const mdPath = path.join(projDir, '经验教训登记册.md');
fs.appendFileSync(mdPath, '\n<!-- 沙盘改动：让 sha 变化 -->\n', 'utf8');
const reviewStale = run(['req', 'review', '--boot', pmToken, '--id', 'R-20261116-000000-less', '--verdict', 'approve', '--comments', '空值=改后未读；异常=文件缺失报码；权限=Owner豁免；并发=同版本不重复落行；降级=CLI不可用报未读；模式=fast缺段不算损坏']);
check('S8 AC4③ 文件改动后再评审 → 又 LESSONS_UNREAD（比当前版本）',
  reviewStale.code !== 0 && /LESSONS_UNREAD/.test(reviewStale.out + reviewStale.err),
  { code: reviewStale.code, out: (reviewStale.out + reviewStale.err).slice(0, 300) });

// AC4⑤：Owner 通道豁免 —— channel=ui 时门禁不检查（未读也能过）
const reviewOwner = run(['req', 'review', '--boot', pmToken, '--id', 'R-20261116-000000-less', '--verdict', 'approve', '--channel', 'ui', '--comments', '空值=Owner通道豁免；异常=文件缺失报码；权限=Owner不检查；并发=同版本不重复落行；降级=CLI不可用报未读；模式=fast缺段不算损坏']);
check('S9 AC4⑤ Owner 通道（channel=ui）未读也不拦',
  !/LESSONS_UNREAD/.test(reviewOwner.out + reviewOwner.err),
  { code: reviewOwner.code, out: (reviewOwner.out + reviewOwner.err).slice(0, 300) });

// 派单门禁：--ack --task（PM 未读当前版本 → LESSONS_UNREAD）
const dispatch = run(['send', '--boot', pmToken, '--to', 'programmer1', '--subject', '沙盘派单', '--body', '沙盘派单正文', '--ack', '--task', 'T-沙盘']);
check('S10 派单（--ack --task）未读当前版本 → LESSONS_UNREAD',
  /LESSONS_UNREAD/.test(dispatch.out + dispatch.err),
  { code: dispatch.code, out: (dispatch.out + dispatch.err).slice(0, 300) });

// S12（tester 打回补）：req create 未读当前版本 → LESSONS_UNREAD（owner 通道豁免另测）
const createUnread = run(['req', 'create', '--boot', pmToken, '--title', '沙盘新需求-未读', '--priority', 'P2']);
check('S12 未读时 req create → LESSONS_UNREAD',
  createUnread.code !== 0 && /LESSONS_UNREAD/.test(createUnread.out + createUnread.err),
  { code: createUnread.code, out: (createUnread.out + createUnread.err).slice(0, 300) });

// S13：lessons read 后 req create 放行（正向）
const readBeforeCreate = run(['lessons', 'read', '--boot', pmToken]);
const createAfterRead = run(['req', 'create', '--boot', pmToken, '--title', '沙盘新需求-已读', '--priority', 'P2']);
check('S13 lessons read 后 req create 不再返回 LESSONS_UNREAD',
  !/LESSONS_UNREAD/.test(createAfterRead.out + createAfterRead.err),
  { readCode: readBeforeCreate.code, code: createAfterRead.code, out: (createAfterRead.out + createAfterRead.err).slice(0, 300) });

// S14：PM 代管代验收 → **PROXY_ACCEPT_FORBIDDEN**（代管不得代需求验收，B-20261116-105213-bd22 起）
// 2026-11-17 08:18 PM 裁定（M-20261117-082018-a87815）：S14/S15 按新口径更新断言（旧期望「LESSONS_UNREAD」已过期）
const proxyAcceptUnread = run(['owner', 'proxy', 'decide', '--boot', pmToken, '--project', PROJECT, '--requirement', 'R-20261116-000000-less', '--decision', 'accepted', '--action', 'accept', '--opinion', '沙盘代验收']);
check('S14 PM 代管代验收 → PROXY_ACCEPT_FORBIDDEN（代管禁验收，先于经验教训门）',
  /PROXY_ACCEPT_FORBIDDEN/.test(proxyAcceptUnread.out + proxyAcceptUnread.err),
  { code: proxyAcceptUnread.code, out: (proxyAcceptUnread.out + proxyAcceptUnread.err).slice(0, 300) });

// S15（PM 点名 + tester 注记 + B-fa6c）：CLI 的 owner --action accept 走 **Owner 通道豁免**——
// 未读时**不报 LESSONS_UNREAD**（可被后续其它门拦，例如沙盘里没有该需求 → TASK_NOT_FOUND）。
// 2026-11-17 08:18 PM 裁定：按 B-fa6c（Owner 验收被 LESSONS_UNREAD 误挡 → lessonGateFor 对 role=owner 豁免）更新断言。
cleanReadLog();
const ownerAcceptUnread = run(['owner', '--boot', pmToken, '--project', PROJECT, '--requirement', 'R-20261116-000000-less', '--action', 'accept', '--decision', 'accepted', '--opinion', '沙盘Owner验收']);
check('S15 owner --action accept 未读 → 不报 LESSONS_UNREAD（Owner 通道豁免，B-fa6c）',
  !/LESSONS_UNREAD/.test(ownerAcceptUnread.out + ownerAcceptUnread.err),
  { code: ownerAcceptUnread.code, out: (ownerAcceptUnread.out + ownerAcceptUnread.err).slice(0, 300) });
// S15b：门禁判定本体仍单测一次（清空记录后 lessons status 报 LESSONS_UNREAD）
const statusUnread = run(['lessons', 'status', '--boot', pmToken]);
check('S15b 门禁判定本体：未读当前版本 → LESSONS_UNREAD',
  /LESSONS_UNREAD/.test(statusUnread.out + statusUnread.err),
  { code: statusUnread.code, out: (statusUnread.out + statusUnread.err).slice(0, 200) });
// S16（PM 点名）：Owner 通道豁免要能过 —— --channel ui 时不因 LESSONS_UNREAD 被拦（可因其它门被拦）
const ownerAcceptChUi = run(['owner', '--boot', pmToken, '--project', PROJECT, '--requirement', 'R-20261116-000000-less', '--action', 'accept', '--decision', 'accepted', '--channel', 'ui']);
check('S16 Owner 通道（--channel ui）验收不被 LESSONS_UNREAD 拦',
  !/LESSONS_UNREAD/.test(ownerAcceptChUi.out + ownerAcceptChUi.err),
  { code: ownerAcceptChUi.code, out: (ownerAcceptChUi.out + ownerAcceptChUi.err).slice(0, 300) });

console.log(`\nlessons 门禁断言：${passed}/${passed + failures.length} PASS`);
console.log('沙盘：' + SB);
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exit(1); }
process.exit(0);
