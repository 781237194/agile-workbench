#!/usr/bin/env node
'use strict';
const { rmSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手

/**
 * R-f9b1 增补卷（16KB 拆分产物）可读性 · 界面侧断言脚本
 * （T-20261115-114740-5212 / 实现：程序员A）。
 *
 * 三段：
 *   A. 纯 Node 单元：pool-core 的卷归一化 + 池详情区块 + 主正文头部清单解析；
 *   B. 源码级单源：卷字段只有一个归一化入口（渲染层 pool-core.js / 主进程 main.js），
 *      两个消费者都调它；卷内容读取只走 files:read（项目内 realpath + 512KB 上限，只读）；
 *   C. 真实窗口（Electron --supplement-check，沙盘数据根）：池详情 / 评审材料 / 项目面板 /
 *      主正文头部四处可见并可点开、无卷安全降级、换角色（analyst boot 后）仍可读，并落截图。
 *
 * 用法：
 *   node scripts/test-supplement-ui.cjs                 # 全跑（含真实窗口 + 截图）
 *   node scripts/test-supplement-ui.cjs --static-only   # 只跑 A/B（不启动 Electron）
 *   node scripts/test-supplement-ui.cjs --out <目录>     # 覆盖证据目录
 *
 * 退出码：0 全部通过；1 有失败；2 环境问题（缺 Electron / 证据目录不可写）。
 */

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const argv = process.argv.slice(2);
const staticOnly = argv.includes('--static-only');
const outArgIndex = argv.indexOf('--out');
const DEFAULT_OUT = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-5212');
const OUT_DIR = outArgIndex >= 0 && argv[outArgIndex + 1]
  ? path.resolve(argv[outArgIndex + 1])
  : (process.env.AWB_EVIDENCE_DIR ? path.resolve(process.env.AWB_EVIDENCE_DIR) : DEFAULT_OUT);
const SHOT_DIR = path.join(OUT_DIR, 'screenshots');
const SANDBOX_DIR = path.join(OUT_DIR, 'sandbox', 'supplement-check-data');

const results = [];
const logLines = [];
const log = (line) => { logLines.push(line); console.log(line); };
let seq = 0;
function assert(name, pass, detail) {
  seq += 1;
  const row = { id: 'S' + String(seq).padStart(2, '0'), name, pass: Boolean(pass), detail: detail === undefined ? null : detail };
  results.push(row);
  log(`${row.pass ? 'PASS' : 'FAIL'} [${row.id}] ${name}${row.pass ? '' : ' :: ' + JSON.stringify(row.detail == null ? null : row.detail).slice(0, 500)}`);
  return row.pass;
}

function readText(rel) { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); }
function countOf(source, pattern) {
  const matches = String(source).match(new RegExp(pattern, 'g'));
  return matches ? matches.length : 0;
}
function indexOfOrFail(source, needle) { return String(source).indexOf(needle); }

/* ── A. pool-core 单元断言 ─────────────────────────────────────────────── */
function runStaticChecks() {
  const pool = require(path.join(ROOT, 'src', 'renderer', 'pool-core.js'));
  const shaFull = '4b9137ffe2da' + 'a'.repeat(52);
  const volumeRow = {
    id: 'R-20261115-105441-f9b1',
    kind: 'requirement',
    title: '带卷需求',
    status: 'approved',
    reviewedAt: '2026-11-15T03:00:00.000Z',
    supplements: [{ name: '增补卷-f9b1-1.md', bytes: 12637, sha256: shaFull }]
  };

  // A1 归一化：name / 字节 / sha12 / rel 一次到位
  const rows = pool.supplementsOf(volumeRow);
  assert('pool-core.supplementsOf 归一化卷（name/字节/sha256 前 12 位）',
    rows.length === 1 && rows[0].name === '增补卷-f9b1-1.md' && rows[0].bytes === 12637
    && rows[0].sha256 === shaFull && rows[0].sha12 === '4b9137ffe2da'
    && rows[0].rel === '需求/增补卷-f9b1-1.md' && rows[0].requirementId === volumeRow.id, rows);

  // A2 缺字段 / 空数组 → 空清单（安全降级，不抛错）
  let degradeOk = false;
  try {
    degradeOk = pool.supplementsOf({ id: 'R-x' }).length === 0
      && pool.supplementsOf({ id: 'R-x', supplements: [] }).length === 0
      && pool.supplementsOf(null).length === 0
      && pool.supplementsOf({ id: 'R-x', supplements: [{ name: 'R-20261115-000000-0000-正文.md' }] }).length === 0;
  } catch { degradeOk = false; }
  assert('缺 supplements / 非卷条目 → 空清单且不抛错（安全降级）', degradeOk);

  // A3 池详情渲染出 data-supplement 区块
  const detail = pool.poolDetailMarkup(volumeRow);
  assert('池详情渲染 data-supplement 区块（data-supplement="1" + 卷数）',
    /data-supplement="1"/.test(detail) && /data-supplement-count="1"/.test(detail)
    && new RegExp('data-supplement-req="' + volumeRow.id + '"').test(detail), detail.slice(0, 240));

  // A4 三要素同屏：卷名 / 字节数 / sha256 前 12 位
  assert('池详情卷条目三要素（name / 12637 B / sha256 4b9137ffe2da）',
    detail.indexOf('增补卷-f9b1-1.md') >= 0 && detail.indexOf('12637 B') >= 0
    && detail.indexOf('sha256 4b9137ffe2da') >= 0, detail.slice(0, 240));

  // A5 可点开：data-supplement-open 带 rel / name / bytes / sha
  assert('池详情卷条目可点开（data-supplement-open 带 rel/name/bytes/sha）',
    /data-supplement-open="需求\/增补卷-f9b1-1\.md"/.test(detail)
    && /data-supplement-name="增补卷-f9b1-1\.md"/.test(detail)
    && /data-supplement-bytes="12637"/.test(detail)
    && /data-supplement-sha="4b9137ffe2da/.test(detail), detail.slice(0, 240));

  // A6 没有卷的需求：详情里不出现卷区块，也不抛错
  const plain = pool.poolDetailMarkup({ id: 'R-20261115-120000-0a1b', kind: 'requirement', title: '无卷需求', status: 'approved' });
  assert('无卷需求详情不渲染 data-supplement（不报错、不占位）',
    !/data-supplement/.test(plain) && plain.indexOf('增补卷') < 0, plain.slice(0, 200));

  // A7 主正文头部清单解析：用真实 f9b1 正文头部那一行
  const realDoc = readText('项目/工作台改造修复/需求/R-20261115-105441-f9b1-正文上限自动治理.md');
  const headerEntries = pool.supplementHeaderEntries(realDoc);
  assert('主正文头部卷清单解析（真实 f9b1 正文：增补卷-f9b1-1.md / 12637B / 4b9137ffe2da）',
    headerEntries.length === 1 && headerEntries[0].name === '增补卷-f9b1-1.md'
    && headerEntries[0].bytes === 12637 && headerEntries[0].sha12 === '4b9137ffe2da'
    && headerEntries[0].rel === '需求/增补卷-f9b1-1.md', headerEntries);

  // A8 头部没有清单 → []（正文中部提到卷名不误判）
  const plainDoc = ['# 无卷正文', '', '## 一、这是什么', '', '规范写在 需求/增补卷-xxxx-1.md 里，但头部没列。', ''].join('\n');
  const noHeader = pool.supplementHeaderEntries(plainDoc);
  assert('头部无卷清单 → 空数组（正文中部提卷名不误判）', Array.isArray(noHeader) && noHeader.length === 0, noHeader);

  // A9 头部区块渲染：有清单出 data-supplement-source=doc-header；没有则返回空串
  const headMarkup = pool.supplementHeaderMarkup(realDoc);
  const emptyHead = pool.supplementHeaderMarkup(plainDoc);
  assert('头部卷清单渲染 data-supplement-source="doc-header"（三要素可点开）',
    /data-supplement-source="doc-header"/.test(headMarkup) && /data-supplement-open=/.test(headMarkup)
    && headMarkup.indexOf('12637 B') >= 0 && headMarkup.indexOf('4b9137ffe2da') >= 0, headMarkup.slice(0, 240));
  assert('头部无清单时渲染空串（安全降级，不截断正文）', emptyHead === '', emptyHead);
}

/* ── B. 源码级单源 / 越界与只读断言 ─────────────────────────────────────── */
function runSourceChecks() {
  const poolCore = readText('src/renderer/pool-core.js');
  const app = readText('src/renderer/app.js');
  const ownerReview = readText('src/renderer/owner-review.js');
  const main = readText('src/main.js');
  const css = readText('src/renderer/style.css');

  // B1 卷字段归一化只有一个定义（渲染层）
  assert('源码单源（渲染层）：function supplementsOf 只在 pool-core.js 定义一次',
    countOf(poolCore, 'function supplementsOf\\(') === 1
    && countOf(app, 'function supplementsOf\\(') === 0
    && countOf(ownerReview, 'function supplementsOf\\(') === 0,
    { poolCore: countOf(poolCore, 'function supplementsOf\\('), app: countOf(app, 'function supplementsOf\\('), or: countOf(ownerReview, 'function supplementsOf\\(') });

  // B2 两个消费者都调同一个归一化入口
  assert('源码单源（消费者）：app.js「池详情/面板」与 owner-review.js「材料卡」都调 POOL_CORE.supplementsOf',
    countOf(app, 'POOL_CORE\\.supplementsOf') >= 2 && countOf(ownerReview, 'POOL_CORE\\.supplementsOf') >= 1,
    { app: countOf(app, 'POOL_CORE\\.supplementsOf'), ownerReview: countOf(ownerReview, 'POOL_CORE\\.supplementsOf') });

  // B3 主进程取数只有一个入口，workflowSnapshot（池/面板）与 ownerMaterials（材料）都复用它
  assert('源码单源（主进程）：function requirementSupplements 只定义一次，workflowSnapshot 与 ownerMaterials 都调它',
    countOf(main, 'function requirementSupplements\\(') === 1
    && /attachRequirementSupplements\(project, legacyView\.requirements\)/.test(main)
    && /const supplementRows = reqId[\s\S]{0,240}?requirementSupplements\(project, \{ id: reqId \}\)/.test(main),
    { defs: countOf(main, 'function requirementSupplements\\(') });

  // B4 ownerMaterials 的需求正文组带 kind='supplement' 条目（AC12）
  assert('ownerMaterials「需求正文」组含 kind="supplement" 条目（带 path + sha256）',
    /kind: 'supplement'/.test(main) && /path: row\.rel/.test(main) && /sha256: row\.sha256/.test(main)
    && /supplements: supplementRows/.test(main), null);

  // B5 卷只读：界面的卷查看器只走 files:read（不写盘、不 openPath）
  const viewerStart = indexOfOrFail(app, 'async function openSupplementViewer');
  const viewerFn = app.slice(viewerStart, viewerStart + 4600);
  assert('卷查看器只读：openSupplementViewer 只调 filesRead（无写盘调用）',
    /window\.workbench\.filesRead\(/.test(viewerFn)
    && !/filesWrite|writeFileSync|fs\.write/.test(viewerFn)
    && /SUPPLEMENT_MISSING/.test(viewerFn), viewerFn.slice(0, 200));

  // B6 files:read 的防穿越 + 512KB 上限（不新增第四套读文件通道）
  assert('files:read 保持防穿越（realpath + isInsidePath）与 512KB 文本上限，不新增 req:supplement 通道',
    /const FILE_TEXT_MAX_BYTES = 512 \* 1024/.test(main)
    && /if \(!isInsidePath\(root, target\)\)/.test(main)
    && /if \(!isInsidePath\(root, real\)\)/.test(main)
    && !/ipcMain\.handle\('req:supplement'/.test(main), null);

  // B7 池详情点击：卷按钮必须排在 .pool-link 之前（否则会走"系统程序打开"，界面上读不到内容）
  const maskStart = indexOfOrFail(app, 'if (e.target === mask) { closePool(); return; }');
  const maskHandler = app.slice(maskStart, maskStart + 1400);
  const idxSupplement = maskHandler.indexOf('[data-supplement-open]');
  const idxPoolLink = maskHandler.indexOf("closest('.pool-link')");
  assert('池详情点击：data-supplement-open 分支排在 .pool-link 之前（界面内读内容，不只给路径）',
    idxSupplement > 0 && idxPoolLink > idxSupplement, { idxSupplement, idxPoolLink });

  // B8 项目面板区块（JS 自建容器，不改 index.html 结构）
  assert('项目面板出现「增补卷」区块（legacy-supplements + data-supplement-source="panel"）',
    /host\.id = 'legacy-supplements'/.test(app) && /data-supplement-source="panel"/.test(app)
    && /legacySupplementPanelMarkup\(\)/.test(app), null);

  // B9 主正文头部清单在两处文档视图都渲染（面板必读预览 + 文件预览）
  assert('主正文头部卷清单在「必读文档预览」与「文件预览」都渲染（无清单安全降级）',
    countOf(app, 'legacySupplementHeaderMarkup\\(') >= 3
    && /legacySupplementHeaderMarkup\(display\) \+ note \+ markdownToHtml\(display\)/.test(app),
    { count: countOf(app, 'legacySupplementHeaderMarkup\\(') });

  // B10 评审材料同一张卡内追加卷条目（不另立类目）
  const rmStart = indexOfOrFail(ownerReview, 'function renderMaterials(req)');
  const renderMaterials = ownerReview.slice(rmStart, rmStart + 3400);
  assert('评审材料「需求正文」卡内追加卷条目（同一 or-materials-row，不另立类目）',
    /data-supplement-open/.test(renderMaterials) && /or-supplement-link/.test(renderMaterials)
    && /materialsSupplements\(g\)/.test(renderMaterials)
    && !/label: '增补卷'/.test(ownerReview), renderMaterials.slice(0, 200));

  // B11 卷不纳入必读：文案必须写明，且 ownerMaterials 分组没有新增卷类目
  const groupKeys = ['req', 'upstream', 'test', 'commit'].every((key) => new RegExp("key: '" + key + "'").test(main));
  assert('卷不纳入必读（界面文案写明 + 材料分组仍是四类 req/upstream/test/commit，不新增卷类目）',
    /不纳入必读/.test(poolCore) && /不纳入必读/.test(app)
    && groupKeys && !/key: 'supplement'/.test(main), { groupKeys });

  // B12 样式：四处新 UI 有对应样式（不是裸 HTML）
  assert('样式文件补齐卷区块/芯片/查看器/材料链接样式',
    /\.pool-detail-supplement/.test(css) && /\.legacy-supplement-chip/.test(css)
    && /\.supplement-viewer-body/.test(css) && /\.or-supplement-link/.test(css), null);

  // B13 面板合并时优先用 workflow:next，这条通道同样要带卷（否则面板空、池详情有）
  assert('项目面板取数：workflow:next 也走 attachRequirementSupplements（面板与池同源）',
    /workflowNext\(ctx\.teamName, ctx\.projectPath\)[\s\S]{0,320}?attachRequirementSupplements\(ctx\.project, next\.requirements\)/.test(main), null);
}

/* ── C. 真实窗口（Electron）────────────────────────────────────────────── */
function runElectronChecks() {
  const electronPath = path.join(ROOT, 'node_modules', 'electron', 'path.txt');
  if (!fs.existsSync(electronPath)) {
    return { ok: false, reason: 'ELECTRON_MISSING', checks: [] };
  }
  rmSandbox(SANDBOX_DIR, { recursive: true, force: true });
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const env = {
    ...process.env,
    AWB_SUPPLEMENT_DATA: SANDBOX_DIR,
    AWB_SUPPLEMENT_OUT: SHOT_DIR,
    AWB_EVIDENCE_KEEP: '1'
  };
  // 绝不把真实数据根/真实团队状态带进自检（main.js 自己会按 --supplement-check 覆盖，这里再兜一层）。
  delete env.AWB_DATA_DIR;
  delete env.AWB_STORE;
  delete env.TEAM_ROOT;
  const started = Date.now();
  const child = spawnSync(process.execPath, [path.join('scripts', 'run-electron.cjs'), '.', '--supplement-check'], {
    cwd: ROOT, env, encoding: 'utf8', timeout: 240000, windowsHide: true
  });
  const stdout = String(child.stdout || '');
  const stderr = String(child.stderr || '');
  log('--- electron stdout ---');
  stdout.split(/\r?\n/).filter(Boolean).forEach((line) => log(line));
  if (stderr.trim()) {
    log('--- electron stderr ---');
    stderr.split(/\r?\n/).filter(Boolean).forEach((line) => log(line));
  }
  const reportFile = path.join(SHOT_DIR, 'supplement-check.json');
  let report = null;
  try { report = JSON.parse(fs.readFileSync(reportFile, 'utf8').replace(/^\uFEFF/, '')); } catch { report = null; }
  return { ok: Boolean(report && report.ok), status: child.status, elapsedMs: Date.now() - started, report, reportFile, stdout, stderr };
}

function main() {
  fs.mkdirSync(OUT_DIR, { recursive: true });
  fs.mkdirSync(SHOT_DIR, { recursive: true });
  const startedAt = new Date().toISOString();
  log(`# test-supplement-ui（R-f9b1 增补卷可读性 · 界面侧）${staticOnly ? ' [static-only]' : ''}`);
  log(`# 证据目录：${OUT_DIR}`);

  // 0) 需求正文确实带卷（夹具合法性的前置）
  const reqDocRel = '项目/工作台改造修复/需求/R-20261115-105441-f9b1-正文上限自动治理.md';
  const reqDoc = readText(reqDocRel);
  assert('前置：f9b1 需求正文头部确实列了增补卷（夹具合法性）',
    /增补卷-f9b1-1\.md/.test(reqDoc) && /12637\s*B/.test(reqDoc), reqDoc.split(/\r?\n/).slice(0, 8));

  runStaticChecks();
  runSourceChecks();

  if (staticOnly) {
    log('# 跳过真实窗口（--static-only）');
  } else {
    const ui = runElectronChecks();
    if (!ui.report) {
      assert('真实窗口自检产出 supplement-check.json', false, { status: ui.status, reason: ui.reason || 'no-report', stderr: String(ui.stderr || '').slice(-800) });
    } else {
      assert('真实窗口自检进程正常退出（SUPPLEMENT_OK）', ui.status === 0 && ui.report.ok === true, { status: ui.status, ok: ui.report.ok });
      for (const row of (Array.isArray(ui.report.checks) ? ui.report.checks : [])) {
        assert('窗口：' + row.name, row.pass === true, row.detail);
      }
      const shots = Object.values(ui.report.screenshots || {});
      const shotOk = shots.length >= 5 && shots.every((file) => {
        try { return fs.statSync(file).size > 1024; } catch { return false; }
      });
      assert('真实窗口截图落盘（池详情/查看器/评审材料/面板/头部 ≥5 张，非空）', shotOk, { count: shots.length, files: shots.map((f) => path.basename(f)) });
      // 证据 JSON 归档（同名对齐需求正文里写的位置：supplement-ui-result.json）
      try {
        fs.writeFileSync(path.join(OUT_DIR, 'supplement-ui-window.json'), JSON.stringify(ui.report, null, 2) + '\n', 'utf8');
      } catch { /* 证据写失败不影响断言 */ }
    }
  }

  const failed = results.filter((row) => !row.pass);
  const summary = {
    ok: failed.length === 0,
    requirement: 'R-20261115-105441-f9b1',
    task: 'T-20261115-114740-5212',
    side: 'ui（界面侧：池详情 / 评审材料 / 项目面板 / 主正文头部）',
    mode: staticOnly ? 'static-only' : 'static+window',
    startedAt,
    finishedAt: new Date().toISOString(),
    outDir: OUT_DIR,
    screenshotDir: SHOT_DIR,
    total: results.length,
    passed: results.length - failed.length,
    failed: failed.length,
    checks: results,
    outDirFiles: (() => { try { return fs.readdirSync(OUT_DIR); } catch { return []; } })(),
    screenshots: (() => { try { return fs.readdirSync(SHOT_DIR).filter((f) => /\.png$/i.test(f)); } catch { return []; } })()
  };
  fs.writeFileSync(path.join(OUT_DIR, 'supplement-ui-result.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  fs.writeFileSync(path.join(OUT_DIR, 'supplement-ui.log'), logLines.join('\n') + '\n', 'utf8');
  log('');
  log(`# 结果：${summary.passed}/${summary.total} 通过，${summary.failed} 失败`);
  log(`# 证据：${path.join(OUT_DIR, 'supplement-ui-result.json')}`);
  console.log(summary.ok ? 'SUPPLEMENT_UI_OK' : 'SUPPLEMENT_UI_FAIL');
  process.exit(summary.ok ? 0 : 1);
}

try {
  main();
} catch (error) {
  console.error('SUPPLEMENT_UI_FATAL ' + String((error && error.stack) || error));
  try {
    fs.mkdirSync(OUT_DIR, { recursive: true });
    fs.writeFileSync(path.join(OUT_DIR, 'supplement-ui.log'), logLines.join('\n') + '\nFATAL ' + String((error && error.stack) || error) + '\n', 'utf8');
  } catch { /* ignore */ }
  process.exit(2);
}
