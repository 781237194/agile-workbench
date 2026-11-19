#!/usr/bin/env node
'use strict';
/**
 * test-194559-g7-report-dir.cjs —— 夹具：G7 报告门改为「按需求 id 目录」（B-20261119-194559-1aed，PM 裁定改工具）
 *
 * 覆盖：
 *   D1 两个需求各有自己的目录与报告 → 只认各自（R-B 的 v9 更新也不影响 R-A 的判定，不再按全局最新）
 *   D2 报告首行没写需求 id → 拒（TEST_REPORT_REQUIRED，missing 含「首行」）
 *   D3 同目录多版本时取版本号最大的一份（v2 优先于 v1，即使 v1 mtime 更新）
 *   D4 需求目录不存在/为空 → soft（仅审计，不阻断，返回值 soft:true）
 *   D5 无需求绑定的任务沿用历史口径（测试人员/产出/测试报告-vN.md，取 mtime 最新），且旧文件不会遮蔽需求目录
 *   D6 历史报告不迁移：旧口径文件仍在原处、内容不被改写（只读校验 sha 不变）
 *   H  隔离：只在临时目录里造数据，不碰真实项目
 *
 * 跑法：node scripts/test-194559-g7-report-dir.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const { gateTestReport } = require(path.join(ROOT, '团队', '工具', 'lib', 'gates.mjs'));

let pass = 0;
let fail = 0;
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log('PASS  ' + name); } else { fail += 1; console.log('FAIL  ' + name + ' :: ' + JSON.stringify(detail).slice(0, 500)); }
};
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'g7-report-dir-'));
const proj = path.join(SB, '项目', 'g7probe');
const outDir = path.join(proj, '测试人员', '产出');
fs.mkdirSync(outDir, { recursive: true });

const writeReport = (rel, firstLine, body = '结论：PASS') => {
  const file = path.join(outDir, rel);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${firstLine}\n\n${body}\n`, 'utf8');
  return file;
};

try {
  // ── D1：两需求各自目录，互不遮蔽 ─────────────────────────────
  writeReport(path.join('测试报告', 'R-A-001', 'v1.md'), '# 测试报告 · R-A-001 结论 PASS');
  writeReport(path.join('测试报告', 'R-B-002', 'v9.md'), '# 测试报告 · R-B-002 结论 PASS');
  const d1a = gateTestReport({ projectPath: proj, requirementId: 'R-A-001', task: { id: 'T-1' } });
  check('D1① R-A 只认自己目录的报告（不受 R-B 的 v9 影响）', d1a === null, d1a);
  // R-A 自己的最新版本首行写错 → 必须拒（证明它读的是 R-A 目录，不是 R-B）
  writeReport(path.join('测试报告', 'R-A-001', 'v2.md'), '# 测试报告 · 别的需求 结论 PASS');
  const d1b = gateTestReport({ projectPath: proj, requirementId: 'R-A-001', task: { id: 'T-1' } });
  check('D1② R-A 的 v2 首行写错 → 拒（不是拿 R-B 的报告来凑）',
    Boolean(d1b) && d1b.code === 'TEST_REPORT_REQUIRED' && String(JSON.stringify(d1b.missing)).includes('首行'), d1b);
  const d1c = gateTestReport({ projectPath: proj, requirementId: 'R-B-002', task: { id: 'T-2' } });
  check('D1③ R-B 不受 R-A 的坏报告影响（仍通过）', d1c === null, d1c);

  // ── D2：首行缺需求 id → 拒 ───────────────────────────────────
  writeReport(path.join('测试报告', 'R-C-003', 'v1.md'), '# 测试报告（无需求 id）结论 PASS');
  const d2 = gateTestReport({ projectPath: proj, requirementId: 'R-C-003', task: { id: 'T-3' } });
  check('D2 首行没有需求 id → 拒', Boolean(d2) && d2.code === 'TEST_REPORT_REQUIRED', d2);
  // 正文含 id 但首行不含 → 仍拒（口径就是首行）
  writeReport(path.join('测试报告', 'R-C-003', 'v1.md'), '# 测试报告（无 id）结论 PASS', '正文提到 R-C-003 不算');
  const d2b = gateTestReport({ projectPath: proj, requirementId: 'R-C-003', task: { id: 'T-3' } });
  check('D2② 只有正文含 id、首行不含 → 仍拒', Boolean(d2b) && d2b.code === 'TEST_REPORT_REQUIRED', d2b);

  // ── D3：取版本号最大的一份 ──────────────────────────────────
  const oldV1 = writeReport(path.join('测试报告', 'R-D-004', 'v1.md'), '# 测试报告 · R-D-004 结论 PASS');
  writeReport(path.join('测试报告', 'R-D-004', 'v10.md'), '# 测试报告 · R-D-004 结论 PASS');
  // 让 v1 的 mtime 比 v10 新，验证「按版本号」而不是「按 mtime」
  const future = new Date(Date.now() + 60_000);
  fs.utimesSync(oldV1, future, future);
  const d3 = gateTestReport({ projectPath: proj, requirementId: 'R-D-004', task: { id: 'T-4' } });
  check('D3 取版本号最大（v10 优先于 mtime 更新的 v1）', d3 === null, d3);

  // ── D4：目录不存在/为空且无历史报告 → soft（仅审计）────────
  const freshProj = path.join(SB, '项目', 'g7fresh');
  fs.mkdirSync(path.join(freshProj, '测试人员', '产出'), { recursive: true });
  const d4 = gateTestReport({ projectPath: freshProj, requirementId: 'R-NODIR-005', task: { id: 'T-5' } });
  check('D4 需求目录不存在且无历史报告 → soft:true（不阻断，仅审计）', Boolean(d4) && d4.code === 'TEST_REPORT_REQUIRED' && d4.soft === true, d4);
  fs.mkdirSync(path.join(freshProj, '测试人员', '产出', '测试报告', 'R-EMPTY-006'), { recursive: true });
  const d4b = gateTestReport({ projectPath: freshProj, requirementId: 'R-EMPTY-006', task: { id: 'T-6' } });
  check('D4② 目录存在但没有 vN.md 且无历史报告 → soft:true', Boolean(d4b) && d4b.soft === true, d4b);
  // D4③ 回退历史口径：需求目录没报告但历史报告覆盖该需求 → 通过（老项目不被误拦；历史报告不改写）
  writeReport('测试报告-v150.md', '# 测试报告 · 历史口径 PASS 需求 R-LEGACY-008');
  const d4c = gateTestReport({ projectPath: proj, requirementId: 'R-LEGACY-008', task: { id: 'T-8b' } });
  check('D4③ 需求目录无报告时回退历史口径（覆盖该需求的历史报告可通过）', d4c === null, d4c);

  // ── D5：无需求绑定沿用历史口径 ──────────────────────────────
  const legacy1 = writeReport('测试报告-v101.md', '# 测试报告 · 无需求绑定的历史口径 PASS');
  writeReport('测试报告-v100.md', '# 测试报告 · 旧的一份 PASS');
  const d5 = gateTestReport({ projectPath: proj, requirementId: '', task: { id: 'T-7' } });
  check('D5 无需求绑定：沿用 测试人员/产出/测试报告-vN.md（mtime 最新一份）', d5 === null, d5);
  const legacySha = sha(legacy1);
  // 需求目录判定不受 legacy 文件影响
  const d5b = gateTestReport({ projectPath: proj, requirementId: 'R-A-001', task: { id: 'T-8' } });
  check('D5② 需求判定不会被 测试报告-vN.md 历史文件遮蔽', Boolean(d5b) && d5b.code === 'TEST_REPORT_REQUIRED', d5b);

  // ── D6：历史报告不改写 ─────────────────────────────────────
  check('D6 历史 测试报告-vN.md 内容未被改动（sha 一致）', sha(legacy1) === legacySha, { before: legacySha, after: sha(legacy1) });

  // ── D7：缺 PASS/FAIL 结论 → 拒 ────────────────────────────
  writeReport(path.join('测试报告', 'R-E-007', 'v1.md'), '# 测试报告 · R-E-007', '没有明确结论');
  const d7 = gateTestReport({ projectPath: proj, requirementId: 'R-E-007', task: { id: 'T-9' } });
  check('D7 报告缺 PASS/FAIL 结论 → 拒', Boolean(d7) && d7.code === 'TEST_REPORT_REQUIRED', d7);
} finally {
  fs.rmSync(SB, { recursive: true, force: true });
}

console.log('');
console.log((fail ? 'HAS_RED' : 'ALL_PASS') + ' ' + pass + '/' + (pass + fail));
process.exit(fail ? 1 : 0);
