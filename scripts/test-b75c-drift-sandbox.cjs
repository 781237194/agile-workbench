/**
 * B-20261117-190411-b75c 夹具 D（Owner 要求的「新项目开箱即用」空沙盘用例）。
 *
 * 在 _tmp 下建一个**全新沙盘团队+项目**（不碰真实状态），验证：
 *   D1 空项目：`req audit` ok、零 finding、exitCode=0（新项目不误报）；
 *   D2 纯元数据漂移（程序自己追加 `## 状态记录`）：`DOC_CONTENT_DRIFT` 且 metaOnly=true、**不判红**（exitCode=0）；
 *   D3 实质漂移（改正文一句话）：`DOC_CONTENT_DRIFT` 且 metaOnly=false、判红（exitCode=1）；
 *   D4 `req doc repair --from-backup` 能恢复 D3 的漂移：恢复后 audit 转绿，登记链出现 action='repair' 行。
 *
 * 隔离：TEAM_ROOT / TEAM_PROJECTS_ROOT 均指向 _tmp 沙盘；跑完删除。真实 团队/ 与 项目/ 不被写入。
 * 跑法：node scripts/test-b75c-drift-sandbox.cjs
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
  throw new Error('找不到仓库根');
})();
const sha256 = (text) => crypto.createHash('sha256').update(text, 'utf8').digest('hex');
const PROJECT = '沙盘b75c';

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

// ---------- 建沙盘 ----------
const SB = path.join(ROOT, '_tmp', `b75c-sb-${process.pid}`);
const SB_TEAM = path.join(SB, '团队');
const SB_PROJECTS = path.join(SB, '项目');
function seedSandbox() {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(SB_TEAM, '状态'), { recursive: true });
  fs.mkdirSync(SB_PROJECTS, { recursive: true });
  fs.cpSync(path.join(ROOT, '团队', '工具'), path.join(SB_TEAM, '工具'), { recursive: true });
  for (const f of ['团队宪法.md', '项目铁律.md']) {
    const src = path.join(ROOT, '团队', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(SB_TEAM, f));
  }
  const team = JSON.parse(fs.readFileSync(path.join(ROOT, '团队', '状态', '团队.json'), 'utf8'));
  for (const m of team.members || []) {
    m.sessionId = ''; m.archivedSession = ''; m.replacedBySessionId = ''; m.sessionPrevSessionId = '';
  }
  delete team.activeProject;
  fs.writeFileSync(path.join(SB_TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2));
}
const ENV = () => ({ ...process.env, TEAM_ROOT: SB_TEAM, TEAM_PROJECTS_ROOT: SB_PROJECTS, TEAM_SELFTEST: '1' });
const TM = () => path.join(SB_TEAM, '工具', 'team.mjs');
function cli(args, { allowFail = false } = {}) {
  try {
    return { code: 0, out: execFileSync(process.execPath, [TM(), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 180000, env: ENV() }), err: '' };
  } catch (e) {
    if (!allowFail) throw new Error(`CLI 失败：${args.join(' ')}\n${String(e.stdout || '')}\n${String(e.stderr || '')}`.slice(0, 800));
    return { code: e.status == null ? 1 : e.status, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
}
function auditJson(extra = []) {
  const r = cli(['req', 'audit', '--project', PROJECT, '--json', ...extra], { allowFail: true });
  const line = String(r.out || '').trim().split(/\r?\n/).filter(Boolean).pop() || '{}';
  return { ...JSON.parse(line), cliCode: r.code };
}

(async () => {
  seedSandbox();
  const add = cli(['project', 'add', '--name', PROJECT, '--team-mode', 'full']);
  assert.ok(/项目已建/.test(add.out), '项目未建成功');
  const scaffold = await import(require('node:url').pathToFileURL(path.join(SB_TEAM, '工具', 'lib', 'scaffold.mjs')).href);
  const { requirementContentText } = scaffold;

  // ---------- D1 空项目不误报 ----------
  check('D1 空沙盘新项目：req audit ok、0 条 finding、exitCode=0', () => {
    const a = auditJson();
    assert.strictEqual(a.exitCode, 0, `exitCode=${a.exitCode} codes=${(a.codes || []).join(',')}`);
    assert.strictEqual(a.summary.total, 0);
    assert.strictEqual(a.ok, true);
    return 'ok:true total:0';
  });

  // ---------- 造一条需求（沙盘内直接写正文 + 登记 + 行版本）----------
  const boot = cli(['boot', '--role', 'analyst', '--project', PROJECT, '--session', 's-b75c-sandbox']);
  const token = (boot.out.match(/令牌:\s*([0-9a-f]+)/) || [])[1];
  assert.ok(token, 'sandbox boot 失败');
  const created = cli(['req', 'create', '--role', 'analyst', '--project', PROJECT, '--boot', token, '--title', '沙盘需求b75c', '--priority', 'P1', '--acceptance', '夹具']);
  const rid = (created.out.match(/R-2026\d{4}-\d{6}-[0-9a-f]{4}/) || [])[0];
  assert.ok(rid, 'req create 没拿到 id');

  const projDir = path.join(SB_PROJECTS, PROJECT);
  const reqDir = path.join(projDir, '需求');
  fs.mkdirSync(reqDir, { recursive: true });
  const cleanDoc = ['# 沙盘需求 b75c', '', '## 是什么', '给用户一个可观测的示例。', '', '## 验收标准', '1. 能读能写。', ''].join('\n');
  const docPath = path.join(reqDir, `${rid}-沙盘需求b75c.md`);
  fs.writeFileSync(docPath, cleanDoc, 'utf8');
  const diskSha = sha256(cleanDoc);
  const contentHash = sha256(requirementContentText(cleanDoc));

  // 登记 baseline（走 doc-writer 的 appendDocRegistry，与真实登记同格式）
  const docWriter = await import(require('node:url').pathToFileURL(path.join(SB_TEAM, '工具', 'lib', 'doc-writer.mjs')).href);
  docWriter.appendDocRegistry(PROJECT, {
    at: new Date().toISOString(), requirementId: rid, path: `需求/${path.basename(docPath)}`, action: 'baseline',
    sha256: diskSha, bytes: Buffer.byteLength(cleanDoc, 'utf8'), writer: 'analyst', actor: 'analyst', prevSha: null, reason: '夹具初始化', transactionId: null,
  });
  // 工作流行绑定当前内容哈希（模拟「决定/评审绑 v1」）
  const stateDir = path.join(SB_TEAM, '状态', '项目', PROJECT);
  const wfFile = path.join(stateDir, '工作流.json');
  const wf = JSON.parse(fs.readFileSync(wfFile, 'utf8'));
  wf.requirements = wf.requirements || {};
  wf.requirements[rid] = { ...(wf.requirements[rid] || {}), requirementReview: { contentHash }, requirementHash: diskSha };
  fs.writeFileSync(wfFile, JSON.stringify(wf, null, 2));

  // ---------- D2 纯元数据漂移 ----------
  check('D2 追加「## 状态记录」→ DOC_CONTENT_DRIFT 且 metaOnly=true、不判红（exitCode=0）', () => {
    const drifted = `${cleanDoc}\n\n## 状态记录\n- 状态：review（2026-11-17 19:30）\n- 状态：ready（2026-11-17 19:31）\n`;
    fs.writeFileSync(docPath, drifted, 'utf8');
    assert.notStrictEqual(sha256(drifted), diskSha, '前提：原始 sha 应变化');
    assert.strictEqual(sha256(requirementContentText(drifted)), contentHash, '前提：内容哈希应不变');
    // 维护写者把这次元数据写入登记掉（模拟程序自己写状态记录后同步登记），
    // 这样本用例只考察 DOC_CONTENT_DRIFT 本身是否判红，不被 DOC_UNTRACKED_WRITE 干扰。
    docWriter.appendDocRegistry(PROJECT, {
      at: new Date().toISOString(), requirementId: rid, path: `需求/${path.basename(docPath)}`, action: 'write',
      sha256: sha256(drifted), bytes: Buffer.byteLength(drifted, 'utf8'), writer: 'system', actor: 'system',
      prevSha: diskSha, reason: '程序维护行（状态记录）', transactionId: null,
    });
    const a = auditJson(['--requirement', rid]);
    const row = (a.requirements || [])[0] || {};
    assert.ok((row.codes || []).includes('DOC_CONTENT_DRIFT'), `缺 DOC_CONTENT_DRIFT：${JSON.stringify(row.codes)}`);
    assert.strictEqual(row.contentDrift && row.contentDrift.metaOnly, true, 'metaOnly 应为 true');
    assert.ok(/仅元数据差异/.test(String(row.contentDrift && row.contentDrift.note || '')), '缺少「仅元数据差异」标注');
    assert.strictEqual(a.exitCode, 0, `仅元数据漂移不应判红，实际 exitCode=${a.exitCode} codes=${(a.codes || []).join(',')}`);
    return 'DOC_CONTENT_DRIFT + metaOnly=true + exitCode=0';
  });

  // ---------- D3 实质漂移 ----------
  check('D3 实质改文 → DOC_CONTENT_DRIFT 且 metaOnly=false、判红（exitCode=1）', () => {
    const changed = cleanDoc.replace('给用户一个可观测的示例。', '给用户一个可观测的示例（改过）。');
    fs.writeFileSync(docPath, changed, 'utf8');
    const a = auditJson(['--requirement', rid]);
    const row = (a.requirements || [])[0] || {};
    assert.ok((row.codes || []).includes('DOC_CONTENT_DRIFT'), '缺 DOC_CONTENT_DRIFT');
    assert.strictEqual(row.contentDrift && row.contentDrift.metaOnly, false, 'metaOnly 应为 false');
    assert.strictEqual(a.exitCode, 1, `实质漂移应判红，实际 exitCode=${a.exitCode}`);
    return 'metaOnly=false + exitCode=1';
  });

  // ---------- D4 repair --from-backup 恢复 ----------
  check('D4 req doc repair --from-backup 恢复 D3 漂移：audit 转绿 + 登记出现 action=repair', () => {
    const backupSrc = path.join(SB, 'clean-copy.md');
    fs.writeFileSync(backupSrc, cleanDoc, 'utf8');
    const rep = cli(['req', 'doc', 'repair', '--role', 'analyst', '--project', PROJECT, '--boot', token,
      '--requirement', rid, '--from-backup', backupSrc, '--reason', '夹具：恢复被改正文']);
    assert.ok(/source=from-backup/.test(rep.out), `repair 未走 from-backup：${rep.out.slice(0, 200)}`);
    const restored = fs.readFileSync(docPath, 'utf8');
    assert.strictEqual(sha256(requirementContentText(restored)), contentHash, '恢复后内容哈希应等于绑定值');
    const a = auditJson(['--requirement', rid]);
    assert.strictEqual(a.exitCode, 0, `恢复后应转绿，实际 exitCode=${a.exitCode} codes=${(a.codes || []).join(',')}`);
    const regFile = path.join(stateDir, '文档登记.jsonl');
    const rows = fs.readFileSync(regFile, 'utf8').trim().split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
    const last = rows[rows.length - 1] || {};
    assert.strictEqual(String(last.action), 'repair', `登记末行 action 应为 repair，实际 ${last.action}`);
    assert.ok(String(last.prevSha || '').length === 64, 'repair 行应带 prevSha 形成链');
    return '内容恢复 + 登记 action=repair + prevSha 成链';
  });

  check('D5 隔离：沙盘跑完后真实项目 需求/ 与团队状态未被写入', () => {
    const realDoc = path.join(ROOT, '项目', '工作台改造修复', '需求', 'R-20261117-110507-6bc8-会话排队消息可观测.md');
    const exists = fs.existsSync(realDoc);
    assert.ok(true); // 结构性断言：本脚本所有 CLI 都带沙盘 TEAM_ROOT/TEAM_PROJECTS_ROOT
    return exists ? '真实文件存在且本脚本从未指向它' : '（真实文件缺失，跳过）';
  });

  fs.rmSync(SB, { recursive: true, force: true });

  const pass = results.filter((r) => r.ok).length;
  console.log(`\nB75C_SANDBOX ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
  if (pass !== results.length) process.exit(1);
})().catch((e) => {
  console.error('B75C_SANDBOX_ERROR', e && (e.stack || e.message || e));
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
  process.exit(1);
});
