#!/usr/bin/env node
'use strict';
/**
 * test-sceneh-role-cards.cjs —— §H「场景覆盖准则」写入六卡模板的**真实生成物**夹具
 *
 * PM 口径（M-20261119-172230-5e4ed6 要求②）：断言「新项目生成的六张角色卡含 §H 模板段」，
 * 而不是只看 `roleCard()`/模板函数的返回值。
 *
 * 做法：沙盘 `init` + `project add --team-mode full` → 直接读六张生成出来的
 *       `项目/<沙盘项目>/<角色目录>/角色卡.md`，逐张断言：
 *       ① 存在且非空；② 含「场景覆盖准则」小节标题；③ 含五个要点关键词
 *       （五种「假完成」/ 全链路六段 / 场景矩阵六类 / 反例锚点）；
 *       ④ 含**该角色专属**的那一条硬门（PM 送审自查 / 产品 RR 逐条核 / 需求正文场景表 /
 *          开发交付自查三问 ×2 / TR-Q 转断言）；
 *       ⑤ 隔离：真实 团队.json / workbench.json sha256 前后不变。
 *
 * 另附静态断言（防回归到只改兜底块）：
 *       ⑥ `scaffold.roleCard()` 的取值是 `GENERATED_ROLE_CARDS[role] || ROLE_CARD_BODIES[role]`；
 *       ⑦ 两个模板块合起来覆盖六角色（不要求六卡都在同一个块里，但要求**合起来无缺**）；
 *       ⑧ 两个块里 §H 都有落点（GENERATED 内联文本 / ROLE_CARD_BODIES 经 sceneCoverageSection 注入）。
 *
 * 用法：node scripts/test-sceneh-role-cards.cjs [--json]
 * 退出码：0 全过 / 1 有断言失败 / 2 环境错误
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const SCAFFOLD = path.join(ROOT, '团队', '工具', 'lib', 'scaffold.mjs');
const JSON_OUT = process.argv.includes('--json');
const PROJECT = 'sceneh沙盘';
const ROLES = [
  { dir: '项目经理', role: 'pm', gate: 'PM 送审前自查' },
  { dir: '产品', role: 'product', gate: '产品 RR 逐条核场景覆盖' },
  { dir: '需求分析师', role: 'analyst', gate: '需求正文必须含「场景表」' },
  { dir: '程序员A', role: 'programmer1', gate: '开发交付自查三问' },
  { dir: '程序员B', role: 'programmer2', gate: '开发交付自查三问' },
  { dir: '测试人员', role: 'tester', gate: 'TR-Q 把场景矩阵转成可执行断言' },
];
const KEY_POINTS = ['五种「假完成」', '全链路六段', '场景矩阵六类', '反例锚点（Owner 原话）'];

const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
  return Boolean(ok);
}
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '(missing)'; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'sceneh-'));
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench-sceneh.json');
const DATA = path.join(SB, 'data');
const REAL_TEAM = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');

function env() {
  const { DSH_SESSION_ID, ...base } = process.env;
  return {
    ...base,
    TEAM_ROOT: TEAM,
    TEAM_PROJECTS_ROOT: PROJECTS,
    TEAM_WORKBENCH_JSON: STORE,
    AWB_DATA_DIR: DATA,
    AWB_STORE: STORE,
    TEAM_SELFTEST: '1',
  };
}
function run(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: env(), timeout: 180000, cwd: SB, maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status == null ? 1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}

const realBefore = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
let exitCode = 0;
try {
  if (!fs.existsSync(TOOL)) { console.error('环境错误：找不到 team.mjs'); process.exit(2); }
  check('S0 沙盘 init', run(['init']).code === 0, {});
  const add = run(['project', 'add', '--name', PROJECT, '--team-mode', 'full']);
  check('S1 沙盘建 full 项目（真实走模板生成）', add.code === 0, { code: add.code, err: String(add.err).slice(0, 300) });
  const projMeta = readJson(path.join(TEAM, '状态', '项目', PROJECT, '项目.json'), {});
  const projDir = String(projMeta.path || path.join(PROJECTS, PROJECT));

  // ①–④ 逐张读**生成出来的**文件（不是函数返回值）
  const perRole = [];
  for (const r of ROLES) {
    const file = path.join(projDir, r.dir, '角色卡.md');
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { text = ''; }
    const row = {
      role: r.role, dir: r.dir,
      exists: Boolean(text),
      bytes: Buffer.byteLength(text, 'utf8'),
      hasSectionTitle: text.includes('场景覆盖准则'),
      keyPoints: KEY_POINTS.filter((k) => text.includes(k)),
      hasRoleGate: text.includes(r.gate),
    };
    perRole.push(row);
    check(`① ${r.dir}（${r.role}）生成的角色卡含 §H 小节标题`, row.exists && row.hasSectionTitle, row);
    check(`② ${r.dir} 含 §H 四要点（五种假完成/全链路六段/场景矩阵六类/反例锚点）`,
      row.keyPoints.length === KEY_POINTS.length, { missing: KEY_POINTS.filter((k) => !text.includes(k)), role: r.role });
    check(`③ ${r.dir} 含本角色专属硬门「${r.gate}」`, row.hasRoleGate, { role: r.role });
  }
  check('④ 六张卡全部合格（逐张断言而非只看函数返回）',
    perRole.every((r) => r.exists && r.hasSectionTitle && r.keyPoints.length === KEY_POINTS.length && r.hasRoleGate),
    { perRole });

  // ⑤ 静态：roleCard 取值顺序 + 两块合起来覆盖六角色 + 两块都有 §H 落点
  const src = fs.readFileSync(SCAFFOLD, 'utf8');
  const genStart = src.indexOf('const GENERATED_ROLE_CARDS = {');
  const genEnd = src.indexOf('// === GENERATED_ROLE_CARDS_END ===');
  const printedStart = src.indexOf('const ROLE_CARD_BODIES = {');
  const printedEnd = src.indexOf('export function roleCard');
  const genBlock = genStart >= 0 && genEnd > genStart ? src.slice(genStart, genEnd) : '';
  const printedBlock = printedStart >= 0 && printedEnd > printedStart ? src.slice(printedStart, printedEnd) : '';
  const keysIn = (block) => ROLES.map((r) => r.role).filter((role) => new RegExp(`^  ${role}: \\(projectName`, 'm').test(block));
  const genRoles = keysIn(genBlock);
  const printedRoles = keysIn(printedBlock);
  const union = [...new Set([...genRoles, ...printedRoles])].sort();
  check('⑤ roleCard() 取值顺序 = GENERATED_ROLE_CARDS[role] || ROLE_CARD_BODIES[role]',
    /GENERATED_ROLE_CARDS\[role\]\s*\|\|\s*ROLE_CARD_BODIES\[role\]/.test(src), { found: false });
  check('⑥ 两个模板块合起来覆盖六角色（允许分块，但不许缺角色）',
    union.length === ROLES.length, { generatedRoles: genRoles, printedRoles, union });
  check('⑦ 两块都有 §H 落点（GENERATED 内联文本 / ROLE_CARD_BODIES 经 sceneCoverageSection 注入）',
    genBlock.includes('场景覆盖准则') && /sceneCoverageSection\('pm'\)|sceneCoverageSection\('programmer1'\)/.test(printedBlock),
    { genHasText: genBlock.includes('场景覆盖准则'), printedHasHelperCall: /sceneCoverageSection\('/.test(printedBlock) });
} catch (e) {
  check('夹具未抛异常', false, { error: String((e && e.stack) || e) });
} finally {
  const realAfter = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
  check('⑧ 隔离：真实 团队/状态/团队.json 与 data/userdata/workbench.json sha256 前后不变',
    realAfter.team === realBefore.team && realAfter.store === realBefore.store,
    { team: [realBefore.team.slice(0, 12), realAfter.team.slice(0, 12)], store: [realBefore.store.slice(0, 12), realAfter.store.slice(0, 12)] });
  fs.rmSync(SB, { recursive: true, force: true });
  const failed = ROWS.filter((r) => r.ok !== true);
  if (!JSON_OUT) {
    console.log(`\n${ROWS.length - failed.length}/${ROWS.length} PASS${failed.length ? ` · ${failed.length} FAIL` : ''}`);
    if (failed.length) console.log('失败项：' + failed.map((r) => r.name).join(' | '));
  } else {
    console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed.length, failed: failed.map((r) => r.name), rows: ROWS }, null, 2));
  }
  if (failed.length) exitCode = 1;
}
process.exit(exitCode);
