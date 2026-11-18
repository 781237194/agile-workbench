#!/usr/bin/env node
'use strict';
/**
 * 013a 返工夹具（T-20261119-025518-01e1）
 *
 * 覆盖 tester 测试报告 v263 的三个未达标/未验项：
 *   A1 AC1 命令模板：每角色 ≥3 条 `team.mjs (read|ack|task|send)`、统一 `node 团队\工具\team.mjs` 前缀、占位符 <T>/<id>、无真实令牌；
 *      product 额外含 `req review --requirement <R-id>`（需求 v2 §12.1/12.2）。
 *   A2 AC2 状态块：预置派单锁（指向 pm、剩 4 分钟）→ `派单锁: pm ← <M-id>（剩余 4 分钟）`；无锁 → `派单锁: 无`；
 *      预置 2 条「已读未回执」→ `未回执: <id1>, <id2>`。
 *   A3 AC3 红线：含「禁止用 DSH 子代理代跑角色任务」、≤60 字、距最后一条模板 ≤3 行。
 *   A4 AC4 预算：真 >2000 字节夹具（1 条绑定需求的任务 + 6 卷增补卷）→ briefing ≤ maxBrief、dropped>0、
 *      且动态块先丢（dynamicDropped===2 且正文无「派单锁:」）；另单测 composeBriefing 的 >2000 丢行机制。
 *   A5 AC5 字节稳定：同会话连跑两次 boot，剔除动态块后字节完全相同。
 *
 * 跑法：node scripts/test-013a-brief-boot.cjs
 * 隔离：全部在 %TEMP% 沙盘（TEAM_ROOT/TEAM_PROJECTS_ROOT/AWB_DATA_DIR + TEAM_SELFTEST=1），真实状态零写入。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RESULTS = [];
function ok(cond, name, detail) {
  RESULTS.push({ name, ok: Boolean(cond), detail: cond ? undefined : detail });
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (cond ? '' : ' :: ' + JSON.stringify(detail)));
  if (!cond) process.exitCode = 1;
}
const sha = (file) => { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return ''; } };
const realTeamFile = path.join(ROOT, '团队', '状态', '团队.json');
const beforeReal = sha(realTeamFile);

function copyDir(src, dst, skip) {
  fs.mkdirSync(dst, { recursive: true });
  for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
    const abs = path.join(src, entry.name);
    if (skip && skip(abs)) continue;
    const target = path.join(dst, entry.name);
    if (entry.isDirectory()) copyDir(abs, target, skip);
    else fs.copyFileSync(abs, target);
  }
}

(async () => {
  const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'a013a-'));
  const TEAM = path.join(SB, '团队');
  const PROJ = path.join(SB, '项目');
  const DATA = path.join(SB, 'data');
  const PNAME = 'A013A夹具项目';
  fs.mkdirSync(PROJ, { recursive: true });
  fs.mkdirSync(DATA, { recursive: true });
  const skip = (p) => /[\\/]邮箱([\\/]|$)/.test(p) || /[\\/]锁([\\/]|$)/.test(p) || /[\\/]备份([\\/]|$)/.test(p) || /[\\/]会话轮换([\\/]|$)/.test(p) || /[\\/]沙盘([\\/]|$)/.test(p);
  copyDir(path.join(ROOT, '团队'), TEAM, skip);
  const env = {
    ...process.env,
    TEAM_ROOT: TEAM,
    TEAM_PROJECTS_ROOT: PROJ,
    AWB_DATA_DIR: DATA,
    TEAM_SELFTEST: '1'
  };
  delete env.ELECTRON_RUN_AS_NODE;
  const teamMjs = path.join(ROOT, '团队', '工具', 'team.mjs');
  const run = (args) => spawnSync(process.execPath, [teamMjs, ...args], { cwd: ROOT, env, encoding: 'utf8', timeout: 180000 });
  const bootJson = (role, session) => {
    const res = run(['boot', '--role', role, '--project', PNAME, '--session', session, '--json']);
    const text = String(res.stdout || '');
    let json = null;
    const start = text.indexOf('{');
    const end = text.lastIndexOf('}');
    if (start >= 0 && end > start) {
      try { json = JSON.parse(text.slice(start, end + 1)); } catch { json = null; }
    }
    return { code: res.status, json, brief: String((json && (json.briefing || json.text)) || ''), raw: text, stderr: String(res.stderr || '').slice(0, 200) };
  };

  try {
    const add = run(['project', 'add', '--name', PNAME, '--team-mode', 'full']);
    ok(add.status === 0, 'A0 沙盘建项目（project add full）', { code: add.status, out: String(add.stdout || '').slice(0, 200), err: String(add.stderr || '').slice(0, 200) });

    /* A1 AC1：命令模板 */
    const cmdRe = /team\.mjs\s+(read|ack|task|send)/g;
    const roleChecks = {};
    for (const role of ['pm', 'programmer1', 'product', 'analyst', 'tester']) {
      const b = bootJson(role, 'session-a013a-' + role);
      const matches = (b.brief.match(cmdRe) || []).length;
      roleChecks[role] = { code: b.code, matches, len: Buffer.byteLength(b.brief) };
      ok(b.code === 0, 'A1-' + role + ' boot 成功', { code: b.code, err: b.stderr });
      ok(matches >= 3, 'A1-' + role + ' 含 ≥3 条 team.mjs (read|ack|task|send) 模板', { matches, brief: b.brief.slice(0, 400) });
      ok(b.brief.includes('node 团队\\工具\\team.mjs'), 'A1-' + role + ' 模板带 node 团队\\工具\\team.mjs 前缀', {});
      ok(!/token["':\s]+[0-9a-f]{16,}/i.test(b.brief), 'A1-' + role + ' 简报不打印真实令牌', {});
      if (role === 'product') {
        ok(/req review --requirement <R-id> --verdict approve\|reject/.test(b.brief), 'A1-product 含 req review 模板（v2 §12.2）', {});
      }
    }
    // 同一会话两次 boot（供 AC5）
    const b1 = bootJson('programmer1', 'session-a013a-stable');
    const b2 = bootJson('programmer1', 'session-a013a-stable');

    /* A3 AC3：红线 */
    const redLine = (b1.brief.match(/红线:[^\n]*/) || [''])[0];
    const redLen = [...redLine].length;
    const briefLines = b1.brief.split(/\r?\n/);
    const redIdx = briefLines.findIndex((line) => line.startsWith('红线:'));
    const lastTemplateIdx = Math.max(...briefLines
      .map((line, i) => (line.includes('team.mjs ') && !line.startsWith('红线:') ? i : -1))
      .filter((i) => i >= 0));
    ok(redLine.includes('禁止用 DSH 子代理代跑角色任务') && redLen > 0 && redLen <= 60, 'A3a 红线句存在且 ≤60 字', { redLine, redLen });
    ok(redIdx > lastTemplateIdx && redIdx - lastTemplateIdx <= 3, 'A3b 红线距最后一条模板 ≤3 行', { redIdx, lastTemplateIdx });

    /* A2 AC2：派单锁 + 未回执 */
    const projState = path.join(TEAM, '状态', '项目', PNAME);
    fs.mkdirSync(projState, { recursive: true });
    const noLockBoot = bootJson('pm', 'session-a013a-nolock');
    ok(/派单锁: 无/.test(noLockBoot.brief), 'A2a 无派单锁 → 打印「派单锁: 无」', {});
    const lockFile = path.join(projState, '派单锁.json');
    fs.writeFileSync(lockFile, JSON.stringify({
      messageId: 'M-20261119-013000-locktest',
      to: 'pm',
      task: 'T-20261119-013000-locktest',
      subject: '夹具派单',
      ts: new Date().toISOString(),
      expiresAt: new Date(Date.now() + 4 * 60000).toISOString()
    }, null, 2) + '\n', 'utf8');
    const lockBoot = bootJson('pm', 'session-a013a-lock');
    const lockLine = (lockBoot.brief.match(/派单锁:[^\n]*/) || [''])[0];
    ok(/派单锁: pm ← M-20261119-013000-locktest（剩余 4 分钟）/.test(lockLine), 'A2b 有派单锁 → 角色/消息 id/剩余 4 分钟（AC2）', { lockLine });

    // 2 条「已读未回执」：cur/ 里 ackRequired + readAt（presenceFor 判据）
    const mailDir = path.join(TEAM, '状态', '邮箱', 'pm', 'cur');
    fs.mkdirSync(mailDir, { recursive: true });
    for (const id of ['M-20261119-013001-aaaa', 'M-20261119-013002-bbbb']) {
      fs.writeFileSync(path.join(mailDir, id + '.json'), JSON.stringify({
        id, from: 'tester', to: 'pm', subject: '夹具未回执 ' + id, body: 'x', project: PNAME,
        task: '', ackRequired: true, type: 'dispatch', ts: new Date().toISOString(), readAt: new Date().toISOString()
      }, null, 2) + '\n', 'utf8');
    }
    const ackBoot = bootJson('pm', 'session-a013a-ack');
    const ackLine = (ackBoot.brief.match(/未回执:[^\n]*/) || [''])[0];
    ok(ackLine.includes('M-20261119-013001-aaaa') && ackLine.includes('M-20261119-013002-bbbb'), 'A2c 未回执 2 条 → 两个 id 都出现（AC2）', { ackLine });

    /* A4 AC4：>2000 字节夹具（1 条绑定需求的任务 + 6 卷增补卷） */
    const projectDir = path.join(PROJ, PNAME);
    const reqDir = path.join(projectDir, '需求');
    fs.mkdirSync(reqDir, { recursive: true });
    const reqId = 'R-20261119-013100-abcd';
    fs.writeFileSync(path.join(reqDir, reqId + '-夹具需求.md'), '# ' + reqId + ' 夹具需求\n\n用于构造简报超限夹具。\n', 'utf8');
    for (let i = 1; i <= 6; i += 1) {
      fs.writeFileSync(path.join(reqDir, '增补卷-abcd-' + i + '.md'), '第 ' + i + ' 卷：' + '超限夹具内容。'.repeat(12) + '\n', 'utf8');
    }
    const taskId = 'T-20261119-013100-abcd';
    const taskDir = path.join(projState, '任务');
    fs.mkdirSync(taskDir, { recursive: true });
    fs.writeFileSync(path.join(taskDir, taskId + '.json'), JSON.stringify({
      id: taskId, project: PNAME, type: 'task', title: '夹具任务：构造简报超限（6 卷）', detail: '', acceptance: '',
      priority: 'P2', owner: 'pm', status: 'open', requirementId: reqId, createdBy: 'pm',
      createdAt: new Date().toISOString(), history: [], rev: 1
    }, null, 2) + '\n', 'utf8');
    const over = bootJson('pm', 'session-a013a-over');
    const overMeta = (over.json && over.json.briefingMeta) || {};
    const overBytes = Buffer.byteLength(over.brief);
    const overChars = over.brief.length;
    const maxBrief = Number(overMeta.maxBrief || 2000);
    ok(over.code === 0, 'A4a 超限夹具 boot 成功', { code: over.code, err: over.stderr });
    ok(overChars <= maxBrief, 'A4b 超限时 briefing.length ≤ maxBrief（字符口径；bytes 一并记录）', { overChars, overBytes, maxBrief });
    ok(Number(overMeta.dropped || 0) > 0, 'A4c briefingMeta.dropped>0（有丢弃）', { meta: overMeta });
    ok(Number(overMeta.dynamicDropped || 0) === 2 && !/派单锁:/.test(over.brief), 'A4d 动态块先丢（dynamicDropped=2 且正文无派单锁行）', { meta: overMeta, hasLock: /派单锁:/.test(over.brief) });
    ok(over.brief.includes('命令模板（可直接复制') && over.brief.includes('红线: 禁止用 DSH 子代理代跑角色任务'), 'A4e 超限后模板与红线仍在（核心区未被丢）', {});
    // 单测 composeBriefing：真实 >2000 行数组
    const ops = await import('file:///' + path.join(ROOT, '团队', '工具', 'lib', 'ops.mjs').replace(/\\/g, '/'));
    const bigLines = [];
    for (let i = 0; i < 40; i += 1) bigLines.push('第' + i + '行：' + 'x'.repeat(80));
    const composed = ops.composeBriefing(bigLines, [30, 31, 32], 2000);
    ok(composed.text.length <= 2000 && composed.dropped > 0, 'A4f composeBriefing 单测：>2000 行数组 → ≤max 且 dropped>0', { len: composed.text.length, dropped: composed.dropped, truncated: composed.truncated });

    /* A5 AC5：字节稳定（剔除动态块后两次相同） */
    // 动态块 = 派单锁/未回执/状态；另外每次 boot 都会换新令牌（既有行为，非本次新增），比较时一并剔除并如实标注。
    const stripDynamic = (text) => String(text || '').split(/\r?\n/)
      .filter((line) => !/^(派单锁|未回执|状态):/.test(line) && !/^令牌:/.test(line)).join('\n');
    fs.writeFileSync(path.join(SB, 'b1.txt'), b1.brief, 'utf8');
    fs.writeFileSync(path.join(SB, 'b2.txt'), b2.brief, 'utf8');
    const s1 = stripDynamic(b1.brief);
    const s2 = stripDynamic(b2.brief);
    const diffLines = (() => {
      const a = s1.split('\\n'); const b = s2.split('\\n');
      const out = [];
      const n = Math.max(a.length, b.length);
      for (let i = 0; i < n; i += 1) if (a[i] !== b[i]) out.push({ i, a: String(a[i] || '').slice(0, 120), b: String(b[i] || '').slice(0, 120) });
      return out;
    })();
    ok(s1.length > 0 && s1 === s2, 'A5 同会话两次 boot 剔除动态块后字节完全相同', { len1: Buffer.byteLength(s1), len2: Buffer.byteLength(s2), diffLines: diffLines.slice(0, 6) });
  } finally {
    ok(sha(realTeamFile) === beforeReal, 'I1 真实 团队.json 零写入（前后 sha 相同）', { before: beforeReal, after: sha(realTeamFile) });
    if (process.env.AWB_013A_KEEP === '1') console.log('KEEP_SANDBOX ' + SB);
    else { try { fs.rmSync(SB, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* ignore */ } }
  }

  const pass = RESULTS.filter((r) => r.ok).length;
  console.log('\nA013A_BRIEF ' + pass + '/' + RESULTS.length + (pass === RESULTS.length ? ' PASS' : ' FAIL'));
  if (process.env.AWB_013A_OUT) {
    fs.writeFileSync(process.env.AWB_013A_OUT, JSON.stringify({ at: new Date().toISOString(), results: RESULTS }, null, 2) + '\n', 'utf8');
  }
})().catch((error) => {
  console.error('A013A_BRIEF_FAILED ' + String((error && error.message) || error).slice(0, 400));
  process.exitCode = 2;
});
