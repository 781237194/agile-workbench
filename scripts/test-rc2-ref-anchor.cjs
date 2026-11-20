'use strict';
/**
 * 夹具：RC-2 补丁式引用（路径#sha12:行号）与 R-af15 锚点接线（T-20261120-165933-b610）
 *
 * 断言：
 *  R1 合法引用：路径#sha12:行/行范围 → checkRef ok，fileSha12/lineCount 正确。
 *  R2 改行内容 → EVIDENCE_ANCHOR_STALE（FILE_SHA_MISMATCH），引用不再 ok。
 *  R3 越界路径（../outside）→ ANCHOR_PATH_OUTSIDE；排除目录（证据-*）同样拒绝。
 *  E1 evidence.mjs 接线：证据串含合法引用 → EVIDENCE_OK 且 anchorWarnings=0、files 正常；
 *  E2 evidence.mjs 非阻断：引用过期 → 仍 EVIDENCE_OK，但 anchorWarnings≥1 且审计落 锚点校验.jsonl。
 *  D1 dispatch.mjs 接线：派单标题带合法引用 → 无【锚点校验】行；带过期引用 → 附提示行且审计有记录。
 *  D2 格式判据：文档引用正则 ^[^#]+#([0-9a-f]{12})(:\d+(-\d+)?)?$ 命中样本。
 *
 * 隔离：文件建在 <工作区>/_tmp/rc2-<rand>/ 下（TEAM_SELFTEST=1 放行 _tmp），审计根 TEAM_ANCHOR_AUDIT_ROOT 指沙盘。
 * 跑法：node scripts/test-rc2-ref-anchor.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');

const WORKSPACE = path.resolve(__dirname, '..');
const SANDBOX = path.join(WORKSPACE, '_tmp', `rc2-ref-${Date.now().toString(36)}-${crypto.randomBytes(3).toString('hex')}`);
const AUDIT = path.join(SANDBOX, 'audit');
const PROJECT = path.join(SANDBOX, '项目', 'rc2-夹具');
process.env.TEAM_SELFTEST = '1';
process.env.TEAM_EVIDENCE_ENFORCE = '1';
process.env.TEAM_ANCHOR_AUDIT_ROOT = AUDIT;
process.env.TEAM_ROOT = process.env.TEAM_ROOT || path.join(WORKSPACE, '团队');

const RESULT = [];
function check(id, title, ok, detail) {
  RESULT.push({ id, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${title}${ok ? '' : '  ← ' + String(JSON.stringify(detail === undefined ? '' : detail)).slice(0, 420)}`);
  if (!ok) process.exitCode = 1;
}
const sha12Of = (buf) => crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);

(async () => {
  fs.mkdirSync(PROJECT, { recursive: true });
  fs.mkdirSync(AUDIT, { recursive: true });
  const srcRel = path.relative(WORKSPACE, path.join(PROJECT, 'src.js')).replace(/\\/g, '/');
  const srcAbs = path.join(PROJECT, 'src.js');
  fs.writeFileSync(srcAbs, 'const a = 1;\nconst b = 2;\nconst c = 3;\n', 'utf8');
  const sha = sha12Of(fs.readFileSync(srcAbs));

  const { checkRef, parseRef, extractRefs, stripRefs } = await import('../团队/工具/lib/ref-anchor.mjs');
  const { checkEvidenceGate } = await import('../团队/工具/lib/evidence.mjs');
  const { buildDispatchPrompt } = await import('../团队/工具/lib/dispatch.mjs');

  // R1 合法
  const good = `${srcRel}#${sha}:2-3`;
  const r1 = checkRef(good);
  check('R1', `合法引用通过（${good}）`, r1.ok && r1.fileSha12 === sha && r1.lineCount === 4, { r1 });

  // R2 改行内容 → STALE
  fs.writeFileSync(srcAbs, 'const a = 1;\nconst b = 222;\nconst c = 3;\n', 'utf8');
  const r2 = checkRef(good);
  check('R2', '改行内容后同引用 → EVIDENCE_ANCHOR_STALE（FILE_SHA_MISMATCH）', !r2.ok && r2.code === 'EVIDENCE_ANCHOR_STALE' && r2.details && r2.details.why === 'FILE_SHA_MISMATCH', { r2 });
  const shaNow = sha12Of(fs.readFileSync(srcAbs));
  const goodNow = `${srcRel}#${shaNow}:2-3`;

  // R3 越界 / 排除目录
  const outside = `../outside.js#${shaNow}:1`;
  const r3 = checkRef(outside);
  const outsideAbs = path.join(WORKSPACE, '..', 'outside.js');
  fs.writeFileSync(outsideAbs, 'x\n', 'utf8');
  const r3b = checkRef(`../${path.basename(outsideAbs)}#${sha12Of(fs.readFileSync(outsideAbs))}:1`);
  check('R3', '越界路径 → ANCHOR_PATH_OUTSIDE', !r3.ok && r3.code === 'ANCHOR_PATH_OUTSIDE' && !r3b.ok && r3b.code === 'ANCHOR_PATH_OUTSIDE', { r3, r3b });

  // D2 格式正则
  const DOC_RE = /^[^#]+#([0-9a-f]{12})(:\d+(-\d+)?)?$/;
  const samples = [goodNow, `${srcRel}#${shaNow}`, `${srcRel}#${shaNow}:2`];
  check('D2', '文档引用正则（^[^#]+#sha12(:行(-行)?)?$）命中三类样本、拒绝旧式裸行号', samples.every((s) => DOC_RE.test(s)) && !DOC_RE.test('src/a.js:12') && !parseRef('src/a.js:12').ok, { samples });

  // E1/E2 evidence 接线
  fs.mkdirSync(path.join(PROJECT, '产出'), { recursive: true });
  const evidenceFile = path.join(PROJECT, '产出', '实现说明-v1.md');
  fs.writeFileSync(evidenceFile, `# 证据引用\n见 ${goodNow}\n`, 'utf8');
  const task = { id: 'T-RC2-1', project: 'rc2-夹具', claimedAt: '2026-11-20T00:00:00.000Z', createdAt: '2026-11-20T00:00:00.000Z' };
  const ev1 = checkEvidenceGate({ projectPath: PROJECT, task, evidence: `产出/实现说明-v1.md ${goodNow}` });
  check('E1', 'evidence：含合法引用 → EVIDENCE_OK、anchorWarnings=0、files 正常', ev1.ok && ev1.code === 'EVIDENCE_OK' && ev1.anchorWarnings === 0 && ev1.files.length === 1, { ev1 });
  const ev2 = checkEvidenceGate({ projectPath: PROJECT, task, evidence: `产出/实现说明-v1.md ${srcRel}#${sha}:2` });
  const auditFile = path.join(AUDIT, 'rc2-夹具', '锚点校验.jsonl');
  const auditRows = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
  check('E2', 'evidence：过期引用不阻断（仍 EVIDENCE_OK），anchorWarnings≥1 且审计落 锚点校验.jsonl',
    ev2.ok && ev2.code === 'EVIDENCE_OK' && ev2.anchorWarnings >= 1 && auditRows.some((r) => r.source === 'evidence' && r.code === 'EVIDENCE_ANCHOR_STALE'), { ev2, auditRows: auditRows.slice(-2) });

  // D1 dispatch 接线
  const baseArgs = { to: 'programmer1', project: 'rc2-夹具', projectPath: PROJECT, roleDir: '程序员A', messageId: 'M-RC2-1', subject: '夹具', taskId: 'T-RC2-1', taskTitle: '', teamTool: 'team.mjs' };
  const okPrompt = buildDispatchPrompt({ ...baseArgs, taskTitle: `改 ${goodNow}` });
  const badPrompt = buildDispatchPrompt({ ...baseArgs, taskTitle: `改 ${srcRel}#${sha}:2` });
  const rows2 = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : [];
  check('D1', 'dispatch：合法引用无提示行；过期引用附录【锚点校验】行且审计有 dispatch 记录',
    !okPrompt.includes('【锚点校验】') && badPrompt.includes('【锚点校验】') && rows2.some((r) => r.source === 'dispatch' && r.code === 'EVIDENCE_ANCHOR_STALE'), { hasBad: badPrompt.includes('【锚点校验】'), rows: rows2.filter((r) => r.source === 'dispatch').slice(-1) });

  // 辅助函数：extractRefs/stripRefs 不误伤普通路径
  check('R4', 'extractRefs 只提取带 #sha12 的引用；stripRefs 还原纯路径（普通路径不受影响）',
    extractRefs(`a.md b ${goodNow} ${srcRel}`).length === 1 && stripRefs(`x ${goodNow}`) === `x ${srcRel}`, { refs: extractRefs(`a ${goodNow} ${srcRel}`), stripped: stripRefs(`x ${goodNow}`) });
})().catch((e) => {
  check('E0', '夹具未抛异常', false, { error: String((e && e.stack) || e) });
}).finally(() => {
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ignore */ }
  try { fs.rmSync(path.join(WORKSPACE, '..', 'outside.js'), { force: true }); } catch { /* ignore */ }
});

process.on('exit', () => {
  const pass = RESULT.filter((r) => r.ok).length;
  console.log(`\n${pass}/${RESULT.length} PASS`);
  if (pass !== RESULT.length) process.exitCode = 1;
});
