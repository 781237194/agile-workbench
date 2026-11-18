#!/usr/bin/env node
'use strict';
/**
 * test-64bc-bad-json.cjs —— B-20261118-163239-64bc 夹具：邮箱目录里单个坏 JSON 不得阻断 ack
 *
 * 背景（场景探针 B8）：`团队/状态/邮箱/<role>/new/` 放入一个坏 JSON（`{ bad`）后，ack 同目录另一条正常消息
 * 会返回 `BAD_JSON` 退出码 3，正常消息无法回执。根因：`core.readJson` 对 SyntaxError 走 fail('BAD_JSON')，
 * 而 `store.findMessage` 用 `readJson(file,null)` 未捕获 → 扫描到坏文件即整条路径失败。
 *
 * 断言（端到端 CLI，沙盘隔离）：
 *   A1 inbox 遇到坏文件仍成功（exit 0）且只列正常消息
 *   A2 ack 正常消息成功（exit 0）、回执落 团队/状态/回执.jsonl、消息从 new 移到 cur
 *   A3 坏文件被跳过但**不删除**（逐字节不变）
 *   A4 跳过可观测：stderr 里有 MAILBOX_BAD_JSON_SKIPPED（含坏文件路径与累计计数）
 *   A5 多个坏文件（3 个）仍不影响 ack；stderr 计数递增
 *   A6 隔离：真实 团队/状态/团队.json、data/userdata/workbench.json 前后 sha256 不变
 * 用法：node scripts/test-64bc-bad-json.cjs [--json] [--out <json>]
 * 退出码：0 全过 / 1 有断言失败
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));

const ROOT = path.resolve(__dirname, '..');
const PROJECT = '64bc坏JSON沙盘';
const SB = mkTempSandbox('64bc');
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench.json');
const DATA = path.join(SB, 'data');
const TEAM_TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const STATE = path.join(TEAM, '状态', '项目', PROJECT);
const RECEIPTS = path.join(TEAM, '状态', '回执.jsonl');
const REAL_TEAM = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const JSON_OUT = process.argv.includes('--json');
const OUT_ARG = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(String(process.argv[i + 1])) : ''; })();

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 600)}`);
  return Boolean(ok);
}
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '(missing)'; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
const textOf = (r) => String(r.out || '') + String(r.err || '');
const mailDir = (role, box) => path.join(TEAM, '状态', '邮箱', role, box);

Object.assign(process.env, { TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_WORKBENCH_JSON: STORE, AWB_DATA_DIR: DATA, TEAM_SELFTEST: '1' });
function run(args) {
  // 用 spawnSync 才能同时拿到 stdout 与 stderr（跳过告警在 stderr，execFileSync 成功时不回传 stderr）。
  const r = spawnSync(process.execPath, [TEAM_TOOL, ...args], { encoding: 'utf8', env: process.env, timeout: 120000, cwd: SB });
  return { code: r.status == null ? 1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function runJson(args) {
  const r = run([...args, '--json']);
  const t = String(r.out || '').trim();
  const i = t.indexOf('{');
  let json = null;
  if (i >= 0) { try { json = JSON.parse(t.slice(i)); } catch { json = null; } }
  return { ...r, json };
}
const tokenOf = (r) => String((r.json && r.json.token) || '');

function main() {
  const realBefore = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
  fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
  fs.mkdirSync(PROJECTS, { recursive: true });
  const seed = readJson(path.join(ROOT, '团队', '状态', '团队.json'), { members: [] });
  seed.activeProject = PROJECT;
  for (const m of seed.members || []) { m.sessionId = ''; m.status = 'active'; }
  writeJson(path.join(TEAM, '状态', '团队.json'), seed);
  for (const rel of ['团队宪法.md', '项目铁律.md']) { const s = path.join(ROOT, '团队', rel); if (fs.existsSync(s)) fs.copyFileSync(s, path.join(TEAM, rel)); }
  if (fs.existsSync(path.join(ROOT, '团队', '协议'))) fs.cpSync(path.join(ROOT, '团队', '协议'), path.join(TEAM, '协议'), { recursive: true });

  const add = runJson(['project', 'add', '--name', PROJECT, '--team-mode', 'full']);
  check('S0 沙盘项目登记', add.code === 0, { code: add.code, out: textOf(add).slice(0, 200) });
  if (add.code !== 0) return summary();

  const roles = (readJson(path.join(STATE, '项目.json'), {}).roleIds) || ['pm', 'tester'];
  const team = readJson(path.join(TEAM, '状态', '团队.json'), { members: [] });
  for (const role of roles) {
    const m = (team.members || []).find((x) => x.role === role);
    if (m) m.sessionId = `session-64bc-${role}`;
  }
  writeJson(path.join(TEAM, '状态', '团队.json'), team);
  writeJson(path.join(PROJECTS, PROJECT, '团队会话.json'), { project: PROJECT, teamMode: 'full', workspace: path.join(PROJECTS, PROJECT), roles: roles.map((r) => ({ role: r, sessionId: `session-64bc-${r}` })) });
  writeJson(path.join(STATE, '工作流.json'), { schema: 2, project: PROJECT, round: 1, requirements: {}, boots: {} });
  const ops = readJson(REAL_STORE, { projects: [] }) || { projects: [] };
  const tpl = JSON.parse(JSON.stringify((ops.projects || [])[0] || {}));
  tpl.id = '64bc-p1'; tpl.name = PROJECT; tpl.teamName = PROJECT; tpl.path = path.join(PROJECTS, PROJECT); tpl.workspacePath = tpl.path;
  tpl.sessions = Object.fromEntries(roles.map((r) => [r, `session-64bc-${r}`]));
  tpl.workspace = { ...(tpl.workspace || {}), path: tpl.path, sessionIds: roles.map((r) => `session-64bc-${r}`) };
  writeJson(STORE, { ...ops, projects: [tpl], activeProjectId: tpl.id });

  const pm = tokenOf(runJson(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'session-64bc-pm']));
  const tester = tokenOf(runJson(['boot', '--role', 'tester', '--project', PROJECT, '--session', 'session-64bc-tester']));
  check('S1 pm/tester boot 成功', Boolean(pm) && Boolean(tester), { pm: Boolean(pm), tester: Boolean(tester) });

  // 正常消息直接落 tester/new（避开 send 的唤醒/自动已读：本单要测的是「扫描时坏文件是否阻断」，不是投递链路）
  const msgId = 'M-20261118-fixture-64bc-1';
  const normalFile = path.join(mailDir('tester', 'new'), `2026-11-18T00-00-00-000Z-${msgId}.json`);
  writeJson(normalFile, {
    id: msgId, from: 'pm', to: 'tester', project: PROJECT, type: 'notice',
    subject: '夹具正常消息', body: '坏 JSON 同目录也要能 ack', ts: '2026-11-18T00:00:00.000Z', ackRequired: true,
  });
  check('S2 tester/new 已有 1 条正常消息 + 即将加入的坏文件同目录', fs.existsSync(normalFile), { normalFile });

  // 放一个坏 JSON 到 tester/new/（与正常消息同目录）
  const badFile = path.join(mailDir('tester', 'new'), 'zz-bad-64bc.json');
  fs.writeFileSync(badFile, '{ bad', 'utf8');
  const badSha = sha(badFile);

  // A1：inbox 不被坏文件阻断
  const inbox = runJson(['inbox', '--role', 'tester', '--project', PROJECT, '--boot', tester, '--all']);
  check('A1 inbox（--all）遇坏 JSON 仍成功（exit 0），正常消息可见', inbox.code === 0 && /夹具正常消息/.test(textOf(inbox)),
    { code: inbox.code, out: textOf(inbox).slice(0, 200), newDir: fs.readdirSync(mailDir('tester', 'new')) });
  check('A1b inbox 跳过坏文件可观测（stderr 有 MAILBOX_BAD_JSON_SKIPPED，含坏文件路径）',
    /MAILBOX_BAD_JSON_SKIPPED/.test(String(inbox.err || '') + String(inbox.out || '')) && /zz-bad-64bc\.json/.test(String(inbox.err || '') + String(inbox.out || '')),
    { err: String(inbox.err || '').slice(0, 300) });

  // A2：ack 正常消息成功
  const ack = runJson(['ack', '--role', 'tester', '--project', PROJECT, '--boot', tester, '--id', msgId, '--note', '夹具回执']);
  const receipts = (() => { try { return fs.readFileSync(RECEIPTS, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } })();
  const receipt = receipts.find((r) => String(r.msgId) === msgId);
  check('A2 ack 正常消息成功（exit 0），回执落盘且 msgId 对得上',
    ack.code === 0 && Boolean(receipt), { code: ack.code, receipt: receipt && receipt.id, out: textOf(ack).slice(0, 200) });
  const baseName = path.basename(normalFile);
  check('A2b 消息已从 new 移入 cur（ack 语义完整，不是只写回执）',
    !fs.existsSync(path.join(mailDir('tester', 'new'), baseName)) && fs.existsSync(path.join(mailDir('tester', 'cur'), baseName)),
    { baseName, newDir: fs.existsSync(mailDir('tester', 'new')) ? fs.readdirSync(mailDir('tester', 'new')) : [], curDir: fs.existsSync(mailDir('tester', 'cur')) ? fs.readdirSync(mailDir('tester', 'cur')) : [] });

  // A3：坏文件被跳过但不删除
  check('A3 坏文件被跳过而非删除（仍存在且字节未变）', fs.existsSync(badFile) && sha(badFile) === badSha, { exists: fs.existsSync(badFile) });
  check('A3b ack 自身 stderr 也有跳过留痕（ack 路径与 inbox 对齐）',
    /MAILBOX_BAD_JSON_SKIPPED/.test(String(ack.err || '') + String(ack.out || '')), { err: String(ack.err || '').slice(0, 300) });

  // A5：多个坏文件仍不影响（再造 3 个，发第二条消息再 ack）
  const sent2 = runJson(['send', '--role', 'pm', '--project', PROJECT, '--boot', pm, '--to', 'tester', '--subject', '夹具第二条', '--body', '多坏文件']);
  const msgId2 = String((sent2.json && sent2.json.message && sent2.json.message.id) || '');
  for (let i = 0; i < 3; i += 1) fs.writeFileSync(path.join(mailDir('tester', 'new'), `zz-bad-64bc-${i}.json`), `{ bad ${i}`, 'utf8');
  const ack2 = runJson(['ack', '--role', 'tester', '--project', PROJECT, '--boot', tester, '--id', msgId2, '--note', '多坏文件回执']);
  const skippedLines = String(ack2.err || '').split(/\r?\n/).filter((l) => /MAILBOX_BAD_JSON_SKIPPED/.test(l)).length;
  check('A5 多坏文件（3 个）仍能 ack（exit 0），且跳过留痕逐文件计数（≥3 条）',
    ack2.code === 0 && skippedLines >= 3, { code: ack2.code, skippedLines, err: String(ack2.err || '').slice(0, 400) });

  check('A6 隔离：真实 团队.json / workbench.json 前后 sha256 不变',
    sha(REAL_TEAM) === realBefore.team && sha(REAL_STORE) === realBefore.store,
    { teamSame: sha(REAL_TEAM) === realBefore.team, storeSame: sha(REAL_STORE) === realBefore.store });

  return summary();
}

function summary() {
  const failed = results.filter((r) => !r.ok);
  const payload = { ok: failed.length === 0, total: results.length, passed: results.length - failed.length, failed: failed.length, sandbox: SB, at: new Date().toISOString(), checks: results };
  if (OUT_ARG) { try { fs.mkdirSync(path.dirname(OUT_ARG), { recursive: true }); fs.writeFileSync(OUT_ARG, JSON.stringify(payload, null, 2) + '\n', 'utf8'); } catch { /* ignore */ } }
  if (JSON_OUT) console.log(JSON.stringify(payload, null, 2));
  else {
    console.log('');
    for (const f of failed) console.log(`FAILED  ${f.name} :: ${String(JSON.stringify(f.detail)).slice(0, 500)}`);
    console.log(`64BC BAD JSON CHECK ${failed.length ? 'FAIL' : 'OK'} ${results.length - failed.length}/${results.length} PASS`);
  }
  process.exit(failed.length ? 1 : 0);
}

try { main(); } catch (e) { console.error('64BC CHECK ERROR ' + String((e && e.stack) || e)); process.exit(1); }
