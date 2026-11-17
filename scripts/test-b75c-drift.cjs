/**
 * B-20261117-190411-b75c 夹具（第二步：DOC_CONTENT_DRIFT 自检 + req doc repair + 可操作错误文案）。
 *
 * 覆盖口径 §二.2/.3/.4 与 §三 夹具 A/B/C 的核心判据：
 *   A 仅元数据变化：追加/删除「## 状态记录」「- 状态：」→ contentHash 不变（决定有效性不受影响）；
 *   B 实质内容变化：改一句正文 → contentHash 变（必须判旧版，并给修复指引）；
 *   C req doc repair 入口存在且参数校验可复现（缺 --requirement → REQUIREMENT_REQUIRED；不存在的需求 → DOC_MISSING）。
 *
 * 说明：C 只走「命令契约」层（失败路径零写入），真实恢复路径需沙盘项目，留给 PM 派单的 e2e 复验；
 * 本脚本不做任何真实正文写入（断言后检查目标文件 sha 未变）。
 *
 * 跑法：node scripts/test-b75c-drift.cjs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');

const ROOT = (() => {
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, '团队', '工具', 'team.mjs'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('找不到仓库根（含 团队/工具/team.mjs）');
})();
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS  ${name}${detail ? `  ${detail}` : ''}`);
  } catch (e) {
    results.push({ name, ok: false, error: String((e && e.message) || e) });
    console.log(`FAIL  ${name}\n      ${String((e && e.message) || e).split('\n')[0]}`);
  }
}

function runCli(args) {
  const out = execFileSync(process.execPath, [path.join(ROOT, '团队', '工具', 'team.mjs'), ...args], {
    cwd: ROOT, encoding: 'utf8', timeout: 120000,
    env: { ...process.env, TEAM_SELFTEST: '1' },
  });
  return out;
}

(async () => {
  const scaffold = await import(require('node:url').pathToFileURL(path.join(ROOT, '团队', '工具', 'lib', 'scaffold.mjs')).href);
  const gates = await import(require('node:url').pathToFileURL(path.join(ROOT, '团队', '工具', 'lib', 'gates.mjs')).href);
  const { requirementContentText } = scaffold;

  // ---------- A 仅元数据变化 ----------
  const baseDoc = [
    '# 需求：示例',
    '',
    '## 是什么',
    '给用户一个可观测的会话排队面板。',
    '',
    '## 验收标准',
    '1. 面板显示排队数。',
  ].join('\n');

  check('A1 追加「## 状态记录 / - 状态：」后 contentHash 不变（sha256 变、内容不变）', () => {
    const withStatus = `${baseDoc}\n\n## 状态记录\n- 状态：rejected（2026-11-17 12:00）\n- 状态：ready（2026-11-17 12:10）\n\n- 状态：test_done\n`;
    assert.notStrictEqual(sha256(withStatus), sha256(baseDoc), '前提：原始 sha256 应该变了');
    assert.strictEqual(sha256(requirementContentText(withStatus)), sha256(requirementContentText(baseDoc)), 'contentHash 应保持不变');
    return 'sha 变 / contentHash 同';
  });

  check('A2 删除「## 状态记录」整段后 contentHash 与删除前相同', () => {
    const withStatus = `${baseDoc}\n\n## 状态记录\n- 状态：ready\n`;
    const stripped = requirementContentText(withStatus);
    assert.strictEqual(sha256(stripped), sha256(requirementContentText(baseDoc)));
    return 'section 剥离幂等';
  });

  // ---------- B 实质内容变化 ----------
  check('B1 改一句正文（实质改文）→ contentHash 变', () => {
    const changed = baseDoc.replace('给用户一个可观测的会话排队面板。', '给用户一个可观测的会话排队面板（新版说明）。');
    assert.notStrictEqual(sha256(requirementContentText(changed)), sha256(requirementContentText(baseDoc)));
    return 'contentHash 变';
  });

  // ---------- 错误文案可操作 ----------
  check('B2 G3 stale 拒绝时带差异摘要 + req audit 排查命令 + req doc repair 修复命令', () => {
    const oldSha = 'a'.repeat(64);
    const row = {
      status: 'ready',
      requirementHash: 'b'.repeat(64),
      requirementReview: { contentHash: '' },
      ownerReview: { status: 'pending', stale: true, staleSha: oldSha, staleSha12: oldSha.slice(0, 12) },
      decisions: [{ status: 'approved', at: '2026-11-16T00:00:00Z', basis: { requirement: { sha256: oldSha } } }],
    };
    const gate = gates.taskGateOf({ task: { id: 'T-fixture', requirementId: 'R-fixture' }, row });
    assert.ok(gate, '应被拦截');
    assert.strictEqual(gate.cause, 'stale', `cause 应为 stale，实际 ${gate.cause}`);
    assert.ok(gate.repair && gate.repair.summary && gate.repair.auditCommand && gate.repair.repairCommand, '缺少 repair 指引');
    assert.ok(/req audit/.test(gate.message), 'message 缺 req audit');
    assert.ok(/req doc repair/.test(gate.message), 'message 缺 req doc repair');
    return '差异摘要 + 2 条命令';
  });

  // ---------- C repair 命令契约（失败路径零写入）----------
  const bootOut = runCli(['boot', '--role', 'programmer1', '--project', '工作台改造修复']);
  const token = (bootOut.match(/令牌:\s*([0-9a-f]+)/) || [])[1];
  assert.ok(token, 'boot 没拿到令牌');

  const realDoc = path.join(ROOT, '项目', '工作台改造修复', '需求', 'R-20261117-110507-6bc8-会话排队消息可观测.md');
  const beforeSha = fs.existsSync(realDoc) ? sha256(fs.readFileSync(realDoc, 'utf8')) : '';

  check('C1 req doc repair 缺 --requirement → REQUIREMENT_REQUIRED（零写入）', () => {
    let err = '';
    try { runCli(['req', 'doc', 'repair', '--role', 'programmer1', '--project', '工作台改造修复', '--boot', token, '--reason', '夹具']); } catch (e) { err = String(e.stdout || '') + String(e.stderr || ''); }
    assert.ok(/REQUIREMENT_REQUIRED/.test(err), `未报 REQUIREMENT_REQUIRED：${err.slice(0, 200)}`);
    return 'REQUIREMENT_REQUIRED';
  });

  check('C2 不存在的需求 → DOC_MISSING（零写入）', () => {
    let err = '';
    try { runCli(['req', 'doc', 'repair', '--role', 'programmer1', '--project', '工作台改造修复', '--boot', token, '--requirement', 'R-20260101-000000-nope', '--reason', '夹具验证不存在需求']); } catch (e) { err = String(e.stdout || '') + String(e.stderr || ''); }
    assert.ok(/DOC_MISSING/.test(err), `未报 DOC_MISSING：${err.slice(0, 200)}`);
    return 'DOC_MISSING';
  });

  check('C3 未知子命令 → BAD_ACTION（只支持 repair）', () => {
    let err = '';
    try { runCli(['req', 'doc', 'delete', '--role', 'programmer1', '--project', '工作台改造修复', '--boot', token]); } catch (e) { err = String(e.stdout || '') + String(e.stderr || ''); }
    assert.ok(/BAD_ACTION/.test(err), `未报 BAD_ACTION：${err.slice(0, 200)}`);
    return 'BAD_ACTION';
  });

  check('C4 三次失败路径未改动真实正文（sha 不变）', () => {
    const nowSha = fs.existsSync(realDoc) ? sha256(fs.readFileSync(realDoc, 'utf8')) : '';
    assert.strictEqual(nowSha, beforeSha);
    return beforeSha ? `sha ${beforeSha.slice(0, 12)} 未变` : '（目标文件不存在，跳过）';
  });

  // ---------- D 自检接线（源代码级）----------
  check('D1 audit 已接 DOC_CONTENT_DRIFT 且区分仅元数据（doc-writer.mjs）', () => {
    const src = fs.readFileSync(path.join(ROOT, '团队', '工具', 'lib', 'doc-writer.mjs'), 'utf8');
    assert.ok(src.includes('DOC_CONTENT_DRIFT'), '缺 DOC_CONTENT_DRIFT');
    assert.ok(src.includes('仅元数据差异，不影响决定有效性'), '缺仅元数据标注');
    assert.ok(src.includes("requirementContentText"), '未复用 requirementContentText（会造成第二套口径）');
    return 'code + metaOnly 标注 + 单源内容哈希';
  });

  check('D2 repair 走 appendDocRegistry(action=repair) + req_doc_repair 审计（ops.mjs）', () => {
    const src = fs.readFileSync(path.join(ROOT, '团队', '工具', 'lib', 'ops.mjs'), 'utf8');
    assert.ok(/function cmdReqDoc\(args\)/.test(src), '缺 cmdReqDoc');
    assert.ok(src.includes("action: 'repair'"), '登记 action 不是 repair');
    assert.ok(src.includes('req_doc_repair'), '缺 req_doc_repair 事件');
    assert.ok(src.includes("'--from-backup'") || src.includes("args['from-backup']"), '缺 --from-backup');
    return '登记链 + 事件 + 备份来源';
  });

  const pass = results.filter((r) => r.ok).length;
  console.log(`\nB75C_DRIFT ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
  if (pass !== results.length) process.exit(1);
})().catch((e) => {
  console.error('B75C_DRIFT_ERROR', e && (e.stack || e.message || e));
  process.exit(1);
});
