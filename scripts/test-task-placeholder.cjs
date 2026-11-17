#!/usr/bin/env node
'use strict';
/**
 * B-20261117-224405-d376 夹具：派单消息 task 字段占位未替换（正文出现 task:true / 任务：true）。
 *
 * 判据：
 *   ① 有 task：sendMessage 持久化的 task = 原 id；buildDispatchPrompt 正文含「任务：<id>」与 task claim 步骤；
 *   ② 无 task：正文写「任务：见本条消息正文」，不出现 task claim；
 *   ③ 占位值：task=true（布尔）、task='true'（字符串化占位）、task=undefined —— 一律归一为空，
 *      邮箱记录 task='' 且正文不含 true/undefined/false；
 *   ④ 回归：store 的 normalizeTaskId 与 dispatch 口径一致（both 走同一函数）。
 *
 * 隔离：TEAM_ROOT / TEAM_PROJECTS_ROOT / TEAM_WORKBENCH_JSON / TEAM_SELFTEST=1 + 唯一 _tmp 沙盘。
 * 跑法：node scripts/test-task-placeholder.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const ROOT = path.resolve(__dirname, '..');
const { mkTempSandbox, rmSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));
const SB = mkTempSandbox('d376');
const TEAM = path.join(SB, '团队');
const PROJ_DIR = path.join(SB, '项目', 'P-d376');
const PROJECT = 'P-d376';

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
  if (!ok) process.exitCode = 1;
}
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };

// ── 沙盘骨架（只做 sendMessage 需要的最小集）
fs.mkdirSync(path.join(TEAM, '状态'), { recursive: true });
const roster = readJson(path.join(ROOT, '团队', '状态', '团队.json'), { members: [] });
for (const m of roster.members || []) m.sessionId = `sess-d376-${m.role}`;
roster.activeProject = PROJECT;
writeJson(path.join(TEAM, '状态', '团队.json'), roster);
fs.mkdirSync(PROJ_DIR, { recursive: true });
writeJson(path.join(TEAM, '状态', '项目', PROJECT, '项目.json'), { name: PROJECT, path: PROJ_DIR, teamMode: 'full' });

const env = {
  ...process.env,
  TEAM_ROOT: TEAM,
  TEAM_PROJECTS_ROOT: path.join(TEAM, '状态', '项目'),
  TEAM_WORKBENCH_JSON: path.join(SB, 'workbench.json'),
  TEAM_SELFTEST: '1',
  __STORE: path.join(ROOT, '团队', '工具', 'lib', 'store.mjs'),
  __DISPATCH: path.join(ROOT, '团队', '工具', 'lib', 'dispatch.mjs'),
  __PROJ_DIR: PROJ_DIR,
};

const child = `
const { pathToFileURL } = require('node:url');
(async () => {
  const store = await import(pathToFileURL(process.env.__STORE).href);
  const dispatch = await import(pathToFileURL(process.env.__DISPATCH).href);
  const out = { sends: [], prompts: [], normalize: [] };
  const send = (label, task) => {
    try {
      const m = store.sendMessage({ from: 'pm', to: 'programmer1', project: process.env.__PROJECT || 'P-d376', subject: 's', body: 'd376 fixture', task, ackRequired: true });
      out.sends.push({ label, id: m.id, task: m.task });
    } catch (e) { out.sends.push({ label, error: String((e && e.message) || e) }); }
  };
  send('with-task', 'T-20261117-D376-OK');
  send('bool-true', true);
  send('literal-true', 'true');
  send('none', undefined);
  const prompt = (taskId) => dispatch.buildDispatchPrompt({ to: 'programmer1', project: 'P-d376', projectPath: process.env.__PROJ_DIR, roleDir: '程序员A', messageId: 'M-d376-x', subject: 's', taskId, teamTool: 'team.mjs', readingList: [] });
  for (const [label, v] of [['with-task', 'T-20261117-D376-OK'], ['bool-true', true], ['literal-true', 'true'], ['none', '']]) {
    out.prompts.push({ label, text: prompt(v) });
  }
  for (const v of ['T-1', true, false, 'true', 'false', 'undefined', 'null', '', undefined, 7]) out.normalize.push({ input: String(v), out: store.normalizeTaskId(v) });
  console.log('@@D376@@' + JSON.stringify(out));
})().catch((e) => console.log('@@D376@@' + JSON.stringify({ fatal: String((e && e.stack) || e) })));
`;
const r = spawnSync(process.execPath, ['-e', child], { cwd: ROOT, encoding: 'utf8', timeout: 120000, env: { ...env, __PROJECT: PROJECT } });
const line = String(r.stdout || '').split(/\r?\n/).find((x) => x.includes('@@D376@@'));
let out = null;
try { out = line ? JSON.parse(line.split('@@D376@@')[1]) : null; } catch { out = null; }
const sends = (out && out.sends) || [];
const prompts = (out && out.prompts) || [];
const by = (arr, label) => arr.find((x) => x.label === label) || {};
const promptOf = (label) => String(by(prompts, label).text || '');

check('DQ0 沙盘内 sendMessage 全部成功（4 例）', sends.length === 4 && sends.every((s) => !s.error), { sends, fatal: out && out.fatal, stderr: String(r.stderr || '').slice(0, 300) });
check('DQ1 有 task：邮箱记录 task=原 id', String(by(sends, 'with-task').task || '') === 'T-20261117-D376-OK', { send: by(sends, 'with-task') });
check('DQ2 task=true（布尔）：邮箱记录 task 归一为空（修复核心）', by(sends, 'bool-true').task === '', { send: by(sends, 'bool-true') });
check("DQ3 task='true'（字符串化占位）：邮箱记录 task 归一为空", by(sends, 'literal-true').task === '', { send: by(sends, 'literal-true') });
check('DQ4 无 task：邮箱记录 task 为空串', by(sends, 'none').task === '', { send: by(sends, 'none') });

// 邮箱落盘复核（不看返回值，只看磁盘）
const mailbox = path.join(TEAM, '状态', '邮箱', 'programmer1', 'new');
const files = fs.existsSync(mailbox) ? fs.readdirSync(mailbox).filter((f) => f.endsWith('.json')).map((f) => readJson(path.join(mailbox, f), null)).filter(Boolean) : [];
const diskTask = (id) => String((files.find((m) => m.id === id) || {}).task || '');
check('DQ5 磁盘复核：4 条消息里只有 with-task 带任务 id，其余三条都是空串',
  diskTask(by(sends, 'with-task').id) === 'T-20261117-D376-OK'
  && diskTask(by(sends, 'bool-true').id) === ''
  && diskTask(by(sends, 'literal-true').id) === ''
  && diskTask(by(sends, 'none').id) === '',
  { files: files.map((m) => ({ id: m.id, task: m.task })) });

const pWith = promptOf('with-task');
const pBool = promptOf('bool-true');
const pLiteral = promptOf('literal-true');
const pNone = promptOf('none');
check('DQ6 派单正文（有 task）：含「任务：T-20261117-D376-OK」+ task claim 步骤',
  /任务：T-20261117-D376-OK/.test(pWith) && /task claim --boot <T> --id T-20261117-D376-OK/.test(pWith),
  { head: pWith.slice(0, 200) });
check('DQ7 派单正文（布尔 true）：写「任务：见本条消息正文」，不含 task:true / 任务：true / task claim',
  /任务：见本条消息正文/.test(pBool) && !/true/.test(pBool) && !/task claim/.test(pBool),
  { head: pBool.slice(0, 240) });
check("DQ8 派单正文（字符串 'true'）：同上，不含 true / task claim",
  /任务：见本条消息正文/.test(pLiteral) && !/true/.test(pLiteral) && !/task claim/.test(pLiteral),
  { head: pLiteral.slice(0, 240) });
check('DQ9 派单正文（无 task）：不含 true/undefined，且无 task claim',
  /任务：见本条消息正文/.test(pNone) && !/true|undefined|null/.test(pNone) && !/task claim/.test(pNone),
  { head: pNone.slice(0, 240) });

const nrm = (out && out.normalize) || [];
const nrmMap = Object.fromEntries(nrm.map((x) => [x.input, x.out]));
check('DQ10 normalizeTaskId 口径：合法 id/数字保留，true/false/undefined/null/空 一律为空',
  nrmMap['T-1'] === 'T-1' && nrmMap['7'] === '7' && nrmMap['true'] === '' && nrmMap['false'] === ''
  && nrmMap['undefined'] === '' && nrmMap['null'] === '' && nrmMap[''] === '',
  { nrm });

const total = results.length;
const pass = results.filter((x) => x.ok).length;
const evDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-d376');
fs.mkdirSync(evDir, { recursive: true });
const evFile = path.join(evDir, `run-${new Date().toISOString().replace(/[:.]/g, '-')}-${total - pass === 0 ? 'green' : 'red'}.json`);
fs.writeFileSync(evFile, JSON.stringify({ task: 'T-20261117-224405-d376', at: new Date().toISOString(), total, pass, red: total - pass, results, raw: out }, null, 2) + '\n', 'utf8');
console.log(`\nD376_${total - pass === 0 ? 'OK' : 'RED'} ${JSON.stringify({ total, pass, red: total - pass })}`);
console.log(`证据：${evFile}`);
if (process.env.AWB_KEEP_SANDBOX !== '1') { try { rmSandbox(SB); } catch { /* ignore */ } }
