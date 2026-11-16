// R-ad44（T-20261116-184335-b7dd）自检 · 批1：唯一实现体 json-atomic.cjs/.mjs
// 覆盖：AC1② 原子写顺序与薄包装静态判据 · AC2 50 子进程并发 0 丢失 · AC3 确定性冲突 · AC7 注入时钟锁超时 · AC8 审计 8 键
// 另含 AC4 事件合并（同文件 20 连写 ≤1 次回调；3 个不同文件各 1 次回调）
// 用法：node scripts/test-json-write.cjs（只写 _tmp/ad44-json-<pid> 沙盘，不碰真实状态）
'use strict';
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const IMPL = path.join(ROOT, '团队', '工具', 'lib', 'json-atomic.cjs');
const ESM = path.join(ROOT, '团队', '工具', 'lib', 'json-atomic.mjs');
const SB = path.join(ROOT, '_tmp', 'ad44-json-' + process.pid);
const PROJECT = '写入沙盘';
const STATE = path.join(SB, '团队', '状态', '项目', PROJECT);
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));
const readJsonl = (f) => (fs.existsSync(f) ? fs.readFileSync(f, 'utf8').trim().split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)) : []);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log('PASS  ' + name); }
  else { fails.push({ name, detail }); console.log('FAIL  ' + name + ' · ' + JSON.stringify(detail).slice(0, 600)); }
};

(async () => {
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(STATE, { recursive: true });
  const atomic = require(IMPL);

  // ── AC1② 原子写顺序（函数体正则，不按行号）
  const src = fs.readFileSync(IMPL, 'utf8');
  const bodyStart = src.indexOf('function atomicWriteRaw');
  const bodyEnd = src.indexOf('\n/* ── 路径白名单', bodyStart);
  const body = src.slice(bodyStart, bodyEnd);
  const iTmp = body.indexOf('.tmp');
  const iFsync = body.indexOf('fsyncSync');
  const iBak = body.indexOf("'.bak'");
  const iRename = body.indexOf('renameSync');
  check('AC1② 原子写顺序：<file>.tmp → fsync → .bak → rename（函数体内按出现顺序）',
    iTmp >= 0 && iFsync > iTmp && iBak > iFsync && iRename > iBak, { iTmp, iFsync, iBak, iRename });
  const esm = fs.readFileSync(ESM, 'utf8');
  check('AC1② .mjs 只是 createRequire 薄包装（无 writeFileSync/renameSync/fsyncSync 调用）',
    /createRequire/.test(esm) && !/writeFileSync\s*\(/.test(esm) && !/renameSync\s*\(/.test(esm) && !/fsyncSync\s*\(/.test(esm));

  // ── AC2 50 个子进程并发写同一文件：0 丢失 0 覆盖
  const concFile = path.join(STATE, '并发.json');
  const CHILD = `const a=require(process.env.A44_IMPL);try{a.updateJsonAtomic(process.env.A44_FILE,(cur)=>({...(cur||{}),[process.env.A44_KEY]:process.env.A44_VAL}),{case:'ac2',project:'${PROJECT}',lockTimeoutMs:20000});process.exit(0)}catch(e){console.error(String(e&&e.code||e));process.exit(1)}`;
  const t0 = Date.now();
  const children = [];
  for (let i = 0; i < 50; i += 1) {
    children.push(new Promise((resolve) => {
      const p = spawn(process.execPath, ['-e', CHILD], {
        env: { ...process.env, A44_IMPL: IMPL, A44_FILE: concFile, A44_KEY: 'k' + i, A44_VAL: 'v' + i },
        stdio: ['ignore', 'ignore', 'pipe'], windowsHide: true,
      });
      let err = '';
      p.stderr.on('data', (c) => { err += String(c); });
      p.on('exit', (code) => resolve({ i, code, err: err.slice(0, 120) }));
    }));
  }
  const done = await Promise.all(children);
  const badChildren = done.filter((x) => x.code !== 0);
  const concData = (() => { try { return readJson(concFile); } catch { return null; } })();
  const concKeys = concData && typeof concData === 'object' ? Object.keys(concData) : [];
  check('AC2 50 个子进程全部成功（无 WRITE_LOCKED 失败）', badChildren.length === 0, badChildren.slice(0, 5));
  check('AC2 并发后 JSON 可解析且键数 = 50（0 丢失 0 覆盖）', concKeys.length === 50, { keys: concKeys.length, ms: Date.now() - t0 });
  check('AC2 无 .tmp / .lock 残留', !fs.existsSync(concFile + '.tmp') && !fs.existsSync(concFile + '.lock'));
  const concAudit = readJsonl(path.join(STATE, '写入审计.jsonl')).filter((r) => r.file === concFile && r.result === 'ok');
  check('AC2 审计 50 行 result=ok', concAudit.length === 50, { rows: concAudit.length });

  // ── AC3 确定性冲突：持锁 → 外部改动 → 释放锁 → 旧 prevSha 写入必须 WRITE_CONFLICT
  const confFile = path.join(STATE, '冲突.json');
  atomic.writeJsonAtomic(confFile, { n: 1 }, { case: 'ac3', project: PROJECT });
  const oldSha = sha(fs.readFileSync(confFile));
  atomic.__internals.acquireLock(confFile, { case: 'ac3-hold', project: PROJECT });
  fs.writeFileSync(confFile, JSON.stringify({ n: 2, external: true }, null, 2) + '\n', 'utf8');
  const externalSha = sha(fs.readFileSync(confFile));
  atomic.__internals.releaseLock(confFile);
  let conflict = null;
  try { atomic.writeJsonAtomic(confFile, { n: 3 }, { case: 'ac3', project: PROJECT, prevSha: oldSha }); } catch (e) { conflict = e; }
  check('AC3 旧 prevSha 写入 → WRITE_CONFLICT 且目标文件未被覆盖',
    Boolean(conflict && conflict.code === 'WRITE_CONFLICT') && sha(fs.readFileSync(confFile)) === externalSha,
    { code: conflict && conflict.code, same: sha(fs.readFileSync(confFile)) === externalSha });
  const confAudit = readJsonl(path.join(STATE, '写入审计.jsonl')).filter((r) => r.file === confFile && r.result === 'conflict');
  check('AC3 冲突写审计 1 行 result=conflict', confAudit.length === 1, { rows: confAudit.length });
  const retry = atomic.writeJsonAtomic(confFile, { n: 3 }, { case: 'ac3-retry', project: PROJECT, prevSha: externalSha });
  check('AC3 用新 prevSha 重试 → 成功', retry.ok === true && readJson(confFile).n === 3, retry);

  // ── AC7 注入时钟：70 秒前锁可接管（审计 stale）；5 秒前锁 → WRITE_LOCKED 且不删他人锁
  const FIXED = 1800000000000;
  process.env.AWB_NOW_MS = String(FIXED);
  const lockFile = path.join(STATE, '过期锁.json');
  atomic.__internals.releaseLock(lockFile);
  fs.writeFileSync(lockFile + '.lock', JSON.stringify({ pid: 999999, at: FIXED - 70000, case: 'old', seq: 1 }), 'utf8');
  const staleRes = atomic.writeJsonAtomic(lockFile, { ok: 1 }, { case: 'ac7-stale', project: PROJECT });
  const staleAudit = readJsonl(path.join(STATE, '写入审计.jsonl')).filter((r) => r.file === lockFile && r.result === 'stale');
  check('AC7 70 秒前锁 → LOCK_STALE 接管并写审计 stale', staleRes.ok === true && staleAudit.length === 1, { rows: staleAudit.length });

  const lockedFile = path.join(STATE, '活锁.json');
  atomic.__internals.releaseLock(lockedFile);
  fs.writeFileSync(lockedFile + '.lock', JSON.stringify({ pid: 999998, at: FIXED - 5000, case: 'fresh', seq: 2 }), 'utf8');
  let locked = null;
  try { atomic.writeJsonAtomic(lockedFile, { ok: 1 }, { case: 'ac7-locked', project: PROJECT, lockTimeoutMs: 300 }); } catch (e) { locked = e; }
  check('AC7 5 秒前锁 → WRITE_LOCKED 且不删他人锁',
    Boolean(locked && locked.code === 'WRITE_LOCKED') && fs.existsSync(lockedFile + '.lock') && !fs.existsSync(lockedFile), { code: locked && locked.code });
  delete process.env.AWB_NOW_MS;
  atomic.__internals.releaseLock(lockedFile);

  // ── AC8 审计固定 8 键、append-only
  const auditRows = readJsonl(path.join(STATE, '写入审计.jsonl'));
  const KEYS = ['at', 'project', 'file', 'case', 'result', 'code', 'prevSha', 'newSha'];
  const badKeyRows = auditRows.filter((r) => JSON.stringify(Object.keys(r).sort()) !== JSON.stringify(KEYS.slice().sort()));
  check('AC8 写入审计每行恰好 8 键（at/project/file/case/result/code/prevSha/newSha）',
    auditRows.length > 50 && badKeyRows.length === 0, { rows: auditRows.length, bad: badKeyRows.slice(0, 2) });

  // ── AC4 事件合并：同文件 20 连写（50ms 间隔）≤1 次回调；3 个不同文件各写 1 次 = 3 次回调
  const watchFile = path.join(STATE, '合并.json');
  atomic.writeJsonAtomic(watchFile, { i: 0 }, { case: 'ac4', project: PROJECT });
  let sameFileCalls = 0;
  let lastPayload = null;
  const un1 = atomic.watchJson(watchFile, (info) => { sameFileCalls += 1; lastPayload = info; }, { debounceMs: 300 });
  for (let i = 1; i <= 20; i += 1) {
    atomic.writeJsonAtomic(watchFile, { i }, { case: 'ac4', project: PROJECT });
    await sleep(50);
  }
  await sleep(700);
  const diskSha = sha(fs.readFileSync(watchFile));
  un1();
  check('AC4 同一文件 50ms 内 20 连写 → 回调 ≤1 次且内容为最终态',
    sameFileCalls <= 1 && (!lastPayload || lastPayload.sha256 === diskSha), { calls: sameFileCalls, payloadSha: lastPayload && lastPayload.sha256, diskSha });

  const files3 = [1, 2, 3].map((n) => path.join(STATE, `合并-${n}.json`));
  const calls3 = [0, 0, 0];
  const uns = files3.map((f, idx) => atomic.watchJson(f, () => { calls3[idx] += 1; }, { debounceMs: 300 }));
  for (let idx = 0; idx < 3; idx += 1) {
    atomic.writeJsonAtomic(files3[idx], { n: idx }, { case: 'ac4', project: PROJECT });
    await sleep(1200);
  }
  await sleep(600);
  uns.forEach((u) => u());
  check('AC4 3 个不同文件各写 1 次（间隔 ≥1s）→ 回调恰好 3 次（不跨文件合并）',
    calls3.join(',') === '1,1,1', { calls: calls3 });

  console.log('\nad44 写入口批1 断言：' + pass + '/' + (pass + fails.length) + ' PASS');
  if (!fails.length) {
    fs.rmSync(SB, { recursive: true, force: true });
    console.log('沙盘已清理：' + SB);
  } else {
    console.log('沙盘保留：' + SB);
    console.log(JSON.stringify(fails, null, 2));
    process.exit(1);
  }
})().catch((e) => { console.error('ERR ' + ((e && e.stack) || e)); process.exit(2); });
