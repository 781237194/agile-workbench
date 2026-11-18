#!/usr/bin/env node
'use strict';
/**
 * R-20261118-170937-b34a（T-e2d8 R2）· 批5：目录扫描缓存夹具（PM 17:57 优先序 d）。
 * 测量依据：状态目录 284MB/25857 文件；files:list 每次递归 walk + 逐文件 stat（上限 600）。
 *
 * D1 首次 scan cached=false、第二次 cached=true（不重复 readdir）
 * D2 目录 mtime 变化（新增顶层项）→ 立即失效重扫
 * D3 TTL>0 时即使目录未变，过期后也重扫（防时间戳不可靠/深层变更）
 * D4 跳过名单生效（node_modules/.git/userdata/_tmp + .awb-tmp-*）
 * D5 maxFiles 截断：count=maxFiles 且 truncated=true
 * D6 clear() 主动失效 → 下一次重扫
 * D7 静态接线：files:list 走 dirScanCache.scanTreeCached（返回结构不变，仅加 cached）；writeStore 写后 clear
 * D8 隔离：真实 团队/状态/团队.json 与 data/userdata/workbench.json 前后 sha256 不变
 *
 * 跑法：node scripts/test-b34a-dirscan.cjs
 * 产出：AWB_B34A_DIRSCAN_OUT（默认 程序员A/产出/证据-b34a/run-b34a-dirscan.json）
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const EVID = process.env.AWB_B34A_DIRSCAN_OUT ? path.resolve(process.env.AWB_B34A_DIRSCAN_OUT) : path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-b34a');
const MAIN = path.join(ROOT, 'src', 'main.js');
const scan = require(path.join(ROOT, 'src', 'dir-scan-cache.js'));

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

const SB = path.join(ROOT, '_tmp', `b34a-dirscan-${process.pid}-${Date.now().toString(36)}`);
const root = path.join(SB, 'proj');
fs.mkdirSync(path.join(root, 'src'), { recursive: true });
fs.mkdirSync(path.join(root, 'node_modules', 'x'), { recursive: true });
fs.writeFileSync(path.join(root, 'src', 'a.js'), 'a');
fs.writeFileSync(path.join(root, 'src', 'b.js'), 'bb');
fs.writeFileSync(path.join(root, 'node_modules', 'x', 'skip.js'), 'x');
fs.writeFileSync(path.join(root, 'skip.awb-tmp-1'), 't');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const r1 = scan.scanTreeCached(root, { maxDepth: 4, maxFiles: 600 });
  const r2 = scan.scanTreeCached(root, { maxDepth: 4, maxFiles: 600 });
  check('D1 首次 scan cached=false、第二次 cached=true 且结果同 count',
    r1.cached === false && r2.cached === true && r1.count === r2.count && r1.count > 0,
    { r1: { cached: r1.cached, count: r1.count }, r2: { cached: r2.cached, count: r2.count } });

  // D2：新增顶层项 → 根目录 mtime/size 变化 → 立即失效
  fs.writeFileSync(path.join(root, 'new-top.txt'), 'n');
  const st = fs.statSync(root);
  fs.utimesSync(root, new Date(st.mtimeMs + 3000), new Date(st.mtimeMs + 3000));
  const r3 = scan.scanTreeCached(root, { maxDepth: 4, maxFiles: 600 });
  check('D2 目录 mtime 变化 → 立即重扫（cached=false 且 count 增长）',
    r3.cached === false && r3.count === r1.count + 1, { cached: r3.cached, count: r3.count, before: r1.count });

  // D3：TTL 过期重扫（目录不变）
  const t1 = scan.scanTreeCached(root, { maxDepth: 4, maxFiles: 600, ttlMs: 60 });
  await sleep(90);
  const t2 = scan.scanTreeCached(root, { maxDepth: 4, maxFiles: 600, ttlMs: 60 });
  check('D3 TTL 过期 → 重扫（cached=false）', t1.cached === true || t1.cached === false ? t2.cached === false : false,
    { t1: t1.cached, t2: t2.cached });

  const names = scan.scanTreeCached(root, { maxDepth: 4, maxFiles: 600 }).files.map((f) => f.name);
  check('D4 跳过名单生效（node_modules/.awb-tmp-* 不出现）',
    !names.includes('node_modules') && !names.some((n) => n.includes('.awb-tmp-')), { names });

  const trunc = scan.scanTreeCached(root, { maxDepth: 4, maxFiles: 2 });
  check('D5 maxFiles 截断：count=maxFiles 且 truncated=true',
    trunc.count === 2 && trunc.truncated === true, { count: trunc.count, truncated: trunc.truncated });

  scan.clear(root);
  const afterClear = scan.scanTreeCached(root, { maxDepth: 4, maxFiles: 600 });
  check('D6 clear() 主动失效 → 下一次 cached=false', afterClear.cached === false, { cached: afterClear.cached });

  const mainSrc = fs.readFileSync(MAIN, 'utf8');
  const wired = /const scanned = dirScanCache\.scanTreeCached\(root, \{ maxDepth: FILES_LIST_MAX_DEPTH, maxFiles: FILES_LIST_MAX_FILES, ttlMs: FILES_LIST_TTL_MS \}\)/.test(mainSrc)
    && /return \{ ok: true, root, files: scanned\.files, count: scanned\.count, truncated: scanned\.truncated, maxDepth: scanned\.maxDepth, cached: scanned\.cached \};/.test(mainSrc);
  const cleared = /function writeStore\(store\)[\s\S]{0,1000}dirScanCache\.clear\(\)/.test(mainSrc);
  check('D7 静态接线：files:list 走 dirScanCache（结构不变仅加 cached）+ writeStore 写后 clear',
    wired && cleared, { wired, cleared });

  check('D8 隔离：真实 团队/状态/团队.json 与 data/userdata/workbench.json 前后 sha256 不变',
    sha(realTeamFile) === beforeReal.team && sha(realStoreFile) === beforeReal.store && Boolean(beforeReal.team),
    { before: beforeReal, after: { team: sha(realTeamFile), store: sha(realStoreFile) } });

  try { fs.rmSync(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
  fs.mkdirSync(EVID, { recursive: true });
  const report = {
    task: 'T-20261118-172604-e2d8', requirement: 'R-20261118-170937-b34a', batch: 'R2-dir-scan-cache', at: new Date().toISOString(),
    measurement: { stateDir: '284MB/25857 files', filesListCap: 600 },
    total: passed + failures.length, pass: passed, red: failures.length, failures,
    scanStats: scan.scanStats(),
  };
  const outFile = path.join(EVID, 'run-b34a-dirscan.json');
  fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
  console.log(`\nB34A_DIRSCAN ${failures.length === 0 ? 'OK' : 'FAIL'} ${JSON.stringify({ total: report.total, pass: report.pass, red: report.red })}`);
  console.log('证据：' + outFile);
  process.exit(failures.length ? 1 : 0);
})().catch((e) => { console.error('CRASH', (e && e.stack) || e); process.exit(1); });
