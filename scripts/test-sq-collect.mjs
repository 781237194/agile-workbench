#!/usr/bin/env node
/**
 * R-6bc8（T-37f5）接线片回归：插件 host half 用假 ctx.sessionController 采一次快照，
 * 断言 会话排队.json 落盘、排队=3、未知≠0、四态与 byPlacement 正确、且只读（写侧 0 调用）。
 *
 * 跑法：node scripts/test-sq-collect.mjs
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const { mkTempSandbox } = require(path.join(__dirname, 'lib', 'sandbox-dir.cjs'));
const PLUGIN = await import(pathToFileURL(path.join(ROOT, 'dsh-plugin', 'pm-workbench-dsh', 'index.js')).href);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? '' : String(JSON.stringify(detail)).slice(0, 500) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 500)}`);
  if (!ok) process.exitCode = 1;
}

const SB = mkTempSandbox('sq-collect');
const teamRoot = path.join(SB, '团队');
const stateDir = path.join(teamRoot, '状态');
fs.mkdirSync(stateDir, { recursive: true });
fs.writeFileSync(path.join(stateDir, '团队.json'), JSON.stringify({
  members: [
    { role: 'analyst', sessionId: 's-analyst' },
    { role: 'tester', sessionId: 's-tester' },
    { role: 'pm', sessionId: '' },
  ],
  activeProject: '沙盘',
}, null, 2) + '\n', 'utf8');
const now = Date.now();
fs.writeFileSync(path.join(stateDir, '唤醒.jsonl'), [
  { at: new Date(now - 60000).toISOString(), to: 'analyst', ok: true, reason: 'wake' },
  // B-20261117-181420-9688（P1）：tester 先失败、再跳过、**最近一条成功** —— 四态必须判 ok，
  // 不能再像旧实现那样「窗口内曾失败一次就永久 fail」。
  { at: new Date(now - 40000).toISOString(), to: 'tester', ok: false, reason: 'WAKE_FAILED' },
  { at: new Date(now - 20000).toISOString(), to: 'tester', ok: false, skipped: true, reason: 'skipped' },
  { at: new Date(now - 10000).toISOString(), to: 'tester', ok: true, reason: 'wake' },
].map((row) => JSON.stringify(row)).join('\n') + '\n', 'utf8');

const calls = { state: 0, writeSide: 0 };
const fakeCtx = {
  sessionController: {
    state: async (req) => {
      calls.state += 1;
      if (String(req && req.sessionId) === 's-analyst') {
        return { active: true, running: true, queue: [
          { placement: 'queued' }, { placement: 'queued' }, { placement: 'queued' },
          { placement: 'steering' }, { placement: 'context' },
        ] };
      }
      return null;
    },
    updateQueue: () => { calls.writeSide += 1; },
    prompt: () => { calls.writeSide += 1; },
    cancel: () => { calls.writeSide += 1; },
  },
};

const out = await PLUGIN.collectSessionQueueSnapshot(fakeCtx, { teamRoot, staleMs: 120000 }, now);
check('① collectSessionQueueSnapshot 成功并返回写入文件', out.ok === true && String(out.file).endsWith(path.join('团队', '状态', '会话排队.json')), out);

const disk = JSON.parse(fs.readFileSync(path.join(stateDir, '会话排队.json'), 'utf8'));
const analyst = disk.roles.find((row) => row.role === 'analyst') || {};
const tester = disk.roles.find((row) => row.role === 'tester') || {};
check('② analyst 排队=3、byPlacement steering=1/context=1、state=ok',
  analyst.queued === 3 && analyst.byPlacement && analyst.byPlacement.steering === 1 && analyst.byPlacement.context === 1 && analyst.state === 'ok',
  analyst);
check('③ 9688：tester 先失败→跳过→最近一条 ok → state=ok（不再「曾失败就永久 fail」）', tester.state === 'ok', tester);
check('④ pm 无 sessionId → known=false、queued=null（面板显示 —，不是 0）', (disk.roles.find((row) => row.role === 'pm') || {}).known === false && (disk.roles.find((row) => row.role === 'pm') || {}).queued === null, disk.roles.find((row) => row.role === 'pm'));
check('⑤ 只读：sessionController.state 被调用，写侧方法 0 调用', calls.state >= 2 && calls.writeSide === 0, calls);
check('⑥ 快照字段齐全（schema/at/project/staleMs/roles[]）', disk.schema === 1 && Boolean(disk.at) && disk.staleMs === 120000 && Array.isArray(disk.roles) && disk.roles.length === 3, { schema: disk.schema, roles: disk.roles.length });

// 静态：插件 inject 含 sessionController + ctx.effect 定时器
const idx = fs.readFileSync(path.join(ROOT, 'dsh-plugin', 'pm-workbench-dsh', 'index.js'), 'utf8');
check('⑦ 插件 inject=[tools,sessionController]、ctx.effect 定时采集、卸载 clearInterval',
  idx.includes("inject = ['tools', 'sessionController']") && idx.includes('collectSessionQueueSnapshot') && idx.includes('clearInterval(timer)'),
  { inject: idx.includes("'sessionController'") });

// AC5 静态：实现里写侧方法 0 命中、.zstd 0 命中
const writeSide = ['updateQueue', 'prompt', 'cancel', 'selectModel', 'rename', 'fork', 'create'];
const hits = writeSide.filter((m) => new RegExp(`\\.${m}\\s*\\(`).test(idx));
check('⑧ AC5① 插件实现里写侧方法调用 0 命中', hits.length === 0, hits);
check('⑨ AC5② 插件实现里 .zstd 0 命中', !idx.includes('.zstd'));

const passed = results.filter((r) => r.ok).length;
console.log(`\nR-6bc8 接线片断言：${passed}/${results.length} PASS`);
const evDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-37f5');
fs.mkdirSync(evDir, { recursive: true });
fs.writeFileSync(path.join(evDir, 'run-sq-collect.json'), JSON.stringify({ at: new Date().toISOString(), total: results.length, passed, results, snapshot: disk }, null, 2) + '\n', 'utf8');
