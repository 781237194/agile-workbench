#!/usr/bin/env node
'use strict';
/**
 * test-4875-lessons-missing.cjs —— B-20261116-092803-4875 回归夹具
 *
 * 缺陷：新项目（没有 经验教训登记册.md）执行 req create 被硬拦 LESSONS_FILE_MISSING。
 * 口径（本夹具断言）：
 *   AC1 登记册「文件不存在」不再硬拦 req create / req review / 派单 / 验收，改为提示并放行；
 *   AC2 只有「文件存在但该角色最新阅读记录的 fileSha ≠ 当前文件 sha」才拦 LESSONS_UNREAD；
 *   AC3 无登记册的项目可以 req create 成功，且 boot 简报里出现一条提示（LESSONS_FILE_MISSING 放行提示）。
 *
 * 隔离：mkTempSandbox 唯一目录；TEAM_ROOT / TEAM_PROJECTS_ROOT / TEAM_WORKBENCH_JSON 全指向沙盘；
 *       TEAM_SELFTEST=1（不驱动 DSH）+ TEAM_LESSONS_ENFORCE=1（沙盘默认豁免门禁，本夹具要验门禁本体）。
 *
 * 用法：node scripts/test-4875-lessons-missing.cjs
 * 退出码：0 全过 / 1 有断言失败 / 2 环境错误
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const ROOT = path.resolve(__dirname, '..');
const SB = mkTempSandbox('4875');
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench.json');
const TEAM_TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const PROJECT = '无登记册沙盘';
const REGISTRY = path.join(PROJECTS, PROJECT, '经验教训登记册.md');
const REQ_FIXTURE = 'R-20261116-000000-miss';

let passed = 0;
const failures = [];
const records = [];
function check(name, ok, detail) {
  records.push({ name, ok, detail: ok ? '' : detail });
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
    TEAM_LESSONS_ENFORCE: '1',
  };
}
function run(args) {
  try {
    const out = execFileSync(process.execPath, [TEAM_TOOL, ...args], { encoding: 'utf8', env: env(), timeout: 90000, cwd: SB });
    return { code: 0, out: String(out), err: '' };
  } catch (error) {
    return { code: error.status == null ? 1 : error.status, out: String(error.stdout || ''), err: String(error.stderr || '') };
  }
}
const text = (r) => String(r.out || '') + String(r.err || '');

if (!fs.existsSync(TEAM_TOOL)) { console.error('环境错误：找不到 team.mjs'); process.exit(2); }

// ── 沙盘骨架：团队.json（清空 sessionId）+ 团队宪法 + 团队项目铁律 + 协议
fs.mkdirSync(PROJECTS, { recursive: true });
fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
const teamSrc = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8'));
for (const m of teamSrc.members || []) { m.sessionId = ''; }
teamSrc.activeProjectId = '';
fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(teamSrc, null, 2) + '\n', 'utf8');
for (const rel of ['团队宪法.md', '项目铁律.md']) {
  const src = path.join(ROOT, '团队', rel);
  if (fs.existsSync(src)) fs.copyFileSync(src, path.join(TEAM, rel));
}
const protoSrc = path.join(ROOT, '团队', '协议');
if (fs.existsSync(protoSrc)) fs.cpSync(protoSrc, path.join(TEAM, '协议'), { recursive: true });
// 沙盘也放一份 团队/工具：少数内部 spawn（skill/唤醒回读）会用 TEAM_ROOT 相对定位 team.mjs
fs.cpSync(path.join(ROOT, '团队', '工具'), path.join(TEAM, '工具'), { recursive: true });
// 项目目录 + 需求正文夹具（供 req review 走门禁用；无登记册）
const projDir = path.join(PROJECTS, PROJECT);
fs.mkdirSync(path.join(projDir, '需求'), { recursive: true });
fs.writeFileSync(path.join(projDir, '需求', `${REQ_FIXTURE}.md`), [
  '<!-- req-doc: v2 -->',
  '# 沙盘需求：无登记册',
  '',
  '## 一、是什么',
  '沙盘夹具，验证没有经验教训登记册时不硬拦。',
  '',
  '## 二、不做什么（越界禁令）',
  '不改真实项目。',
  '',
  '## 三、验收标准',
  '- AC1 缺登记册时 req create 放行。',
  '',
].join('\n'), 'utf8');

const addProject = run(['project', 'add', '--name', PROJECT, '--path', projDir, '--json']);
check('S0 沙盘项目登记', addProject.code === 0, { code: addProject.code, out: text(addProject).slice(0, 300) });
// scaffold 可能自动生成登记册（scaffold.mjs:887）：删掉它，制造「新项目本来就没有这份文件」的现场
if (fs.existsSync(REGISTRY)) fs.rmSync(REGISTRY, { force: true });
check('S1 现场：项目根下不存在 经验教训登记册.md', !fs.existsSync(REGISTRY), REGISTRY);

// ── AC1/AC3：boot 简报出现提示，且 boot 仍成功
const bootPm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-pm-4875']);
const bootText = text(bootPm);
const pmToken = (/"token"\s*:\s*"([0-9a-f]{6,})"/i.exec(bootText) || /(?:令牌|token)[:：]\s*([0-9a-f]{6,})/i.exec(bootText) || [])[1] || '';
check('S2 boot 成功（缺登记册不阻断 boot）', bootPm.code === 0, { code: bootPm.code, out: bootText.slice(0, 300) });
check('S3 boot 简报出现 LESSONS_FILE_MISSING 放行提示', /LESSONS_FILE_MISSING/.test(bootText) && /放行/.test(bootText), { has: /LESSONS_FILE_MISSING/.test(bootText), ok: /放行/.test(bootText) });
check('S4 缺登记册时不得报 LESSONS_UNREAD', !/LESSONS_UNREAD/.test(bootText), { out: bootText.slice(0, 200) });
check('S5 取得 PM 令牌', Boolean(pmToken), { out: bootText.slice(0, 200) });

// ── AC3：无登记册项目 req create 成功
const createNoReg = run(['req', 'create', '--boot', pmToken, '--project', PROJECT, '--title', '无登记册新需求', '--priority', 'P2', '--acceptance', 'AC', '--json']);
check('S6 AC3 无登记册时 req create 成功（不再硬拦）', createNoReg.code === 0 && !/LESSONS_FILE_MISSING/.test(text(createNoReg)), { code: createNoReg.code, out: text(createNoReg).slice(0, 300) });

// ── AC1：其余三处门禁也不再因「文件不存在」硬拦（可被其它门拦，但不得报 LESSONS_FILE_MISSING）
const reviewNoReg = run(['req', 'review', '--boot', pmToken, '--project', PROJECT, '--id', REQ_FIXTURE, '--verdict', 'approve', '--comments', '沙盘：缺登记册放行', '--json']);
check('S7 AC1 缺登记册时 req review 不报 LESSONS_FILE_MISSING', !/LESSONS_FILE_MISSING/.test(text(reviewNoReg)), { code: reviewNoReg.code, out: text(reviewNoReg).slice(0, 300) });
const dispatchNoReg = run(['send', '--boot', pmToken, '--project', PROJECT, '--to', 'programmer1', '--subject', '沙盘派单', '--body', '沙盘派单正文', '--ack', '--task', 'T-20261118-000000-non', '--json']);
check('S8 AC1 缺登记册时派单（--ack --task）不报 LESSONS_FILE_MISSING', !/LESSONS_FILE_MISSING/.test(text(dispatchNoReg)), { code: dispatchNoReg.code, out: text(dispatchNoReg).slice(0, 300) });
const proxyNoReg = run(['owner', 'proxy', 'decide', '--boot', pmToken, '--project', PROJECT, '--requirement', REQ_FIXTURE, '--decision', 'accepted', '--action', 'accept', '--opinion', '沙盘代验收', '--json']);
check('S9 AC1 缺登记册时代验收不报 LESSONS_FILE_MISSING', !/LESSONS_FILE_MISSING/.test(text(proxyNoReg)), { code: proxyNoReg.code, out: text(proxyNoReg).slice(0, 300) });

// ── 门禁状态可见：lessons status 明示「PASS（LESSONS_FILE_MISSING 已放行）」
const statusNoReg = run(['lessons', 'status', '--boot', pmToken, '--project', PROJECT]);
check('S10 lessons status 明示门禁放行（PASS + LESSONS_FILE_MISSING）',
  /门禁：PASS/.test(text(statusNoReg)) && /LESSONS_FILE_MISSING/.test(text(statusNoReg)) && !/门禁：LESSONS_FILE_MISSING/.test(text(statusNoReg)),
  { out: text(statusNoReg).slice(0, 300) });

// ── AC2：文件存在但没读过 → 拦 LESSONS_UNREAD；读过 → 放行；文件改动后再拦
const lessonsMd = [
  '# 经验教训登记册（沙盘 4875）',
  '',
  '## 项目经理',
  '',
  '| 日期 | 场景 | 教训 | 下次怎么做 |',
  '|---|---|---|---|',
  '| 2026-11-16 | 沙盘 | 教训一 | 做法一 |',
  '',
  '## 产品',
  '', '| 日期 | 场景 | 教训 | 下次怎么做 |', '|---|---|---|---|',
  '| 2026-11-16 | 沙盘 | 教训二 | 做法二 |',
  '',
  '## 需求分析师',
  '', '| 日期 | 场景 | 教训 | 下次怎么做 |', '|---|---|---|---|',
  '| 2026-11-16 | 沙盘 | 教训三 | 做法三 |',
  '',
  '## 程序员A',
  '', '| 日期 | 场景 | 教训 | 下次怎么做 |', '|---|---|---|---|',
  '| 2026-11-16 | 沙盘 | 教训四 | 做法四 |',
  '',
  '## 程序员B',
  '', '| 日期 | 场景 | 教训 | 下次怎么做 |', '|---|---|---|---|',
  '| 2026-11-16 | 沙盘 | 教训五 | 做法五 |',
  '',
  '## 测试',
  '', '| 日期 | 场景 | 教训 | 下次怎么做 |', '|---|---|---|---|',
  '| 2026-11-16 | 沙盘 | 教训六 | 做法六 |',
  '',
].join('\n');
fs.writeFileSync(REGISTRY, lessonsMd, 'utf8');
const createUnread = run(['req', 'create', '--boot', pmToken, '--project', PROJECT, '--title', '有登记册但未读', '--priority', 'P2', '--json']);
check('S11 AC2 文件存在但未读 → req create 拦 LESSONS_UNREAD',
  createUnread.code !== 0 && /LESSONS_UNREAD/.test(text(createUnread)),
  { code: createUnread.code, out: text(createUnread).slice(0, 300) });
const readRes = run(['lessons', 'read', '--boot', pmToken, '--project', PROJECT, '--json']);
check('S12 lessons read 落阅读记录', readRes.code === 0 && (/"action"\s*:\s*"recorded"|已记录阅读|已读过/.test(text(readRes))), { code: readRes.code, out: text(readRes).slice(0, 200) });
const createAfterRead = run(['req', 'create', '--boot', pmToken, '--project', PROJECT, '--title', '已读后建需求', '--priority', 'P2', '--json']);
check('S13 AC2 读过当前版本 → req create 放行', createAfterRead.code === 0 && !/LESSONS_UNREAD/.test(text(createAfterRead)), { code: createAfterRead.code, out: text(createAfterRead).slice(0, 300) });
fs.appendFileSync(REGISTRY, '\n<!-- 沙盘改动：让 sha 变化 -->\n', 'utf8');
const createStale = run(['req', 'create', '--boot', pmToken, '--project', PROJECT, '--title', '文件改动后再建需求', '--priority', 'P2', '--json']);
check('S14 AC2 文件改动后再操作 → 又拦 LESSONS_UNREAD',
  createStale.code !== 0 && /LESSONS_UNREAD/.test(text(createStale)),
  { code: createStale.code, out: text(createStale).slice(0, 300) });

// ── 汇总 + 证据件
const total = passed + failures.length;
console.log(`\nB-4875 断言：${passed}/${total} PASS${failures.length ? `，${failures.length} 待修` : ''}`);
const evidDir = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-4875');
fs.mkdirSync(evidDir, { recursive: true });
const at = new Date().toISOString();
fs.writeFileSync(path.join(evidDir, 'run-4875.json'), JSON.stringify({ at, sandbox: SB, passed, total, results: records }, null, 2) + '\n', 'utf8');
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exit(1); }
process.exit(0);
