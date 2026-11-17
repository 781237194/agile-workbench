#!/usr/bin/env node
'use strict';
/**
 * test-3c12-role-index-manual.cjs —— B-20261115-120000-3c12 回归夹具
 *
 * 缺陷：`writeRoleIndexes()` 每次 apply 后**整份覆盖**角色目录的《文件索引.md》——
 * 手写速查段被吃掉，且 8192 截断时没有任何保护。
 *
 * 断言（沙盘项目，真实树零写入）：
 *   M1 首次重建：原本没有标记的文件 → 自动补一对空标记（`<!-- manual:begin -->`…`<!-- manual:end -->`），不报错
 *   M2 写入自定义手写段 → 再 rebuild → 手写段逐字仍在，且表格行数（文件计数）仍正确
 *   M3 大目录（造 >8192 的表格）→ rebuild 截断表格但仍保留手写段（标记区不被截断）
 *   M4 连跑两次：手写段不被重复堆叠（幂等：标记区只有一个）
 *
 * 隔离：mkTempSandbox + TEAM_ROOT/TEAM_PROJECTS_ROOT/TEAM_WORKBENCH_JSON/TEAM_SELFTEST=1。
 * 用法：node scripts/test-3c12-role-index-manual.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const ROOT = path.resolve(__dirname, '..');
const SB = mkTempSandbox('3c12');
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench.json');
const TEAM_TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const PROJECT = '索引手写段沙盘';
const ROLE_DIR = '需求分析师';

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 300)}`);
}
const env = () => ({ ...process.env, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_WORKBENCH_JSON: STORE, TEAM_SELFTEST: '1' });
function run(args) {
  try {
    return { code: 0, out: String(execFileSync(process.execPath, [TEAM_TOOL, ...args], { encoding: 'utf8', env: env(), timeout: 180000, cwd: SB })) };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
}
const BEGIN = '<!-- manual:begin -->';
const END = '<!-- manual:end -->';
const idxPathOf = (name) => path.join(PROJECTS, PROJECT, name, '文件索引.md');
const readIdx = (name) => fs.readFileSync(idxPathOf(name), 'utf8');
const countTableRows = (t) => (t.match(/^\|\s/gm) || []).length;

if (!fs.existsSync(TEAM_TOOL)) { console.error('环境错误：找不到 team.mjs'); process.exit(2); }

// 沙盘骨架
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

const add = run(['project', 'add', '--name', PROJECT, '--team-mode', 'fast', '--json']);
if (add.code !== 0) { console.error('环境错误：project add 失败 ' + add.out.slice(0, 300)); process.exit(2); }

const rebuild = () => run(['index', '--project', PROJECT, '--json']);

// M1：首次重建自动补标记
const first = rebuild();
check('M1 首次 rebuild 成功', first.code === 0, first.out.slice(0, 200));
const t1 = readIdx(ROLE_DIR);
check('M1 原本无标记 → 自动补一对（begin/end 各一次）',
  t1.includes(BEGIN) && t1.includes(END) && (t1.match(/manual:begin/g) || []).length === 1,
  { hasBegin: t1.includes(BEGIN), hasEnd: t1.includes(END), begins: (t1.match(/manual:begin/g) || []).length });

// M2：写自定义手写段 → 再 rebuild 仍在
const manualText = '### 我的速查\n- 验收证据都放 证据-*/ 下\n- 口径：PASS 才算过（本行是手写，不允许被覆盖）';
fs.mkdirSync(path.join(PROJECTS, PROJECT, ROLE_DIR, '产出'), { recursive: true });
fs.writeFileSync(path.join(PROJECTS, PROJECT, ROLE_DIR, '产出', '手写段夹具-输出.md'), '# 夹具输出\n\n用于让索引表格有 ≥2 行数据。\n', 'utf8');
rebuild();
const t2a = readIdx(ROLE_DIR);
const rowsBefore = countTableRows(t2a);
const withManual = t2a.replace(BEGIN, `${BEGIN}\n${manualText}`);
fs.writeFileSync(idxPathOf(ROLE_DIR), withManual, 'utf8');
const second = rebuild();
const t2 = readIdx(ROLE_DIR);
check('M2 写入手写段 → rebuild 后手写段逐字仍在',
  second.code === 0 && t2.includes(manualText.split('\n')[1]) && t2.includes('口径：PASS 才算过'),
  { code: second.code, snippetKept: t2.includes('我的速查') });
check('M2 手写段不被表格误吃：计数（表格行）仍正确',
  countTableRows(t2) === rowsBefore && countTableRows(t2) >= 3,
  { before: rowsBefore, after: countTableRows(t2) });

// M3：大目录触发截断，手写段仍保留
const roleDirAbs = path.join(PROJECTS, PROJECT, ROLE_DIR);
for (let i = 0; i < 120; i += 1) {
  fs.writeFileSync(path.join(roleDirAbs, `速查批量-${String(i).padStart(3, '0')}-很长的文件名用于撑大索引表格.md`), `# 批量 ${i}\n\n内容占位，用于触发 8192 截断。\n`.repeat(4), 'utf8');
}
const third = rebuild();
const t3 = readIdx(ROLE_DIR);
const bytes3 = Buffer.byteLength(t3, 'utf8');
check('M3 大目录 rebuild 触发截断（出现截断提示）', third.code === 0 && /索引超限截断/.test(t3), { bytes: bytes3, trunc: /索引超限截断/.test(t3) });
check('M3 截断后手写段仍完整保留（标记区不被砍）',
  t3.includes('我的速查') && t3.includes('口径：PASS 才算过') && t3.indexOf(BEGIN) > 0 && t3.indexOf(END) > t3.indexOf(BEGIN),
  { hasManual: t3.includes('我的速查'), bytes: bytes3 });

// M4：连跑两次幂等（标记区只有一个）
rebuild();
const t4 = readIdx(ROLE_DIR);
check('M4 连跑两次：手写段不重复堆叠（manual 标记各 1 处）',
  (t4.match(/manual:begin/g) || []).length === 1 && (t4.match(/manual:end/g) || []).length === 1
  && (t4.match(/口径：PASS 才算过/g) || []).length === 1,
  { begins: (t4.match(/manual:begin/g) || []).length, hasManualOnce: (t4.match(/口径：PASS 才算过/g) || []).length });

const total = passed + failures.length;
const outFile = process.env.AWB_3C12_OUT
  ? (path.isAbsolute(process.env.AWB_3C12_OUT) ? process.env.AWB_3C12_OUT : path.join(ROOT, process.env.AWB_3C12_OUT))
  : path.join(ROOT, '_tmp', 'run-3c12.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify({ task: 'B-20261115-120000-3c12', at: new Date().toISOString(), total, pass: passed, red: failures.length, failures }, null, 2) + '\n', 'utf8');
console.log(`\nROLE_INDEX_MANUAL ${JSON.stringify({ total, pass: passed, red: failures.length })}`);
console.log('证据：' + outFile);
process.exit(failures.length ? 1 : 0);
