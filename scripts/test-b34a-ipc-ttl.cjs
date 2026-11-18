#!/usr/bin/env node
'use strict';
/**
 * R-20261118-170937-b34a（T-e2d8 R2）· 批4：主进程热路径降本（测量单优先序 a/b/c）静态契约夹具。
 *
 * 背景（测试人员/产出/UI卡顿基线-20261118.md）：workflow:state p95 1.74s、team:board 8.48s、metrics 均 359ms、
 * readStore 204 调用点、打字 p95 219ms。PM 2026-11-18 17:57 优先序：
 *   a) readStore() 进程内 mtime 缓存+写后失效（已有 storeCache；本批去掉只读热路径的 2.71MB structuredClone）；
 *   b) workflow:state / team:board 5–10s 短 TTL（写后清空）；
 *   c) system:metrics 2s→5s（由渲染层改频，主进程侧走同一 TTL）。
 *
 * 断言：
 *   T1 热点 TTL 表：workflow:state=5000 / team:board=8000 / system:metrics=5000
 *   T2 TTL 包装已接到全局 ipcMain.handle（hotIpcTtlWrap 在注册处组合，未改任何 handler 本体）
 *   T3 TTL key 含 payload 参数（不同项目/参数不串值）
 *   T4 写后清空：writeStore 内调 hotIpcCacheClear()（写完立刻可见）
 *   T5 readStoreCached()：存在且只读路径跳过 structuredClone（readStoreSharedDepth 机制）
 *   T6 readStore() 默认语义不变：非只读路径仍返回深拷贝（structuredClone 仍在）
 *   T7 缓存上限：TTL 缓存条数封顶（防无界增长）
 *   T8 隔离：真实 团队/状态/团队.json 与 data/userdata/workbench.json 前后 sha256 不变
 *
 * 跑法：node scripts/test-b34a-ipc-ttl.cjs
 * 产出：AWB_B34A_TTL_OUT（默认 程序员A/产出/证据-b34a/run-b34a-ipc-ttl.json）
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const EVID = process.env.AWB_B34A_TTL_OUT ? path.resolve(process.env.AWB_B34A_TTL_OUT) : path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-b34a');
const MAIN = path.join(ROOT, 'src', 'main.js');
const src = fs.readFileSync(MAIN, 'utf8');

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 300)}`);
}
const sha = (p) => { try { return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex'); } catch { return ''; } };
const realTeamFile = path.join(ROOT, '团队', '状态', '团队.json');
const realStoreFile = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const beforeReal = { team: sha(realTeamFile), store: sha(realStoreFile) };

check('T1 热点 TTL 表：workflow:state 5000 / team:board 8000 / system:metrics 5000',
  /const HOT_IPC_TTL_MS = \{ 'workflow:state': 5000, 'team:board': 8000, 'system:metrics': 5000 \};/.test(src), {});

check('T2 TTL 包装接到全局 ipcMain.handle 注册处（未改 handler 本体）',
  /perfCache\.withIpcTiming\(channel, hotIpcTtlWrap\(channel, handler\)/.test(src), {});

check('T3 TTL key 含 payload 参数（不同项目/参数不串值）',
  /\$\{channel\}\|\$\{JSON\.stringify\(args\[1\]/.test(src), {});

check('T4 写后清空热点 TTL：writeStore 内调 hotIpcCacheClear()',
  /function writeStore\(store\)[\s\S]{0,800}hotIpcCacheClear\(\)/.test(src), {});

check('T5 readStoreCached() 存在且命中路径跳过 structuredClone（readStoreSharedDepth 机制）',
  /let readStoreSharedDepth = 0;/.test(src) && /function readStoreCached\(\)/.test(src)
  && /if \(readStoreSharedDepth > 0\) return storeCache\.value;/.test(src), {});

check('T6 readStore() 默认语义不变：非只读路径仍返回深拷贝（structuredClone 保留两处）',
  (src.match(/structuredClone\(storeCache\.value\)/g) || []).length >= 1
  && /if \(readStoreSharedDepth > 0\) return storeCache\.value;\s*return structuredClone\(storeCache\.value\);/.test(src), {});

check('T7 TTL 缓存上限：条数封顶（>64 删最旧，防无界增长）',
  /if \(hotIpcCache\.size > 64\) hotIpcCache\.delete/.test(src), {});

check('T8 隔离：真实 团队/状态/团队.json 与 data/userdata/workbench.json 前后 sha256 不变',
  sha(realTeamFile) === beforeReal.team && sha(realStoreFile) === beforeReal.store && Boolean(beforeReal.team),
  { before: beforeReal, after: { team: sha(realTeamFile), store: sha(realStoreFile) } });

fs.mkdirSync(EVID, { recursive: true });
const report = {
  task: 'T-20261118-172604-e2d8', requirement: 'R-20261118-170937-b34a', batch: 'R2-hot-ipc-ttl', at: new Date().toISOString(),
  measurement: { 'workflow:state_p95_ms': 1740, 'team:board_p95_ms': 8480, 'metrics_avg_ms': 359, readStore_call_sites: 204 },
  total: passed + failures.length, pass: passed, red: failures.length, failures,
};
const outFile = path.join(EVID, 'run-b34a-ipc-ttl.json');
fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`\nB34A_IPC_TTL ${failures.length === 0 ? 'OK' : 'FAIL'} ${JSON.stringify({ total: report.total, pass: report.pass, red: report.red })}`);
console.log('证据：' + outFile);
process.exit(failures.length ? 1 : 0);
