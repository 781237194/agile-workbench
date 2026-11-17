#!/usr/bin/env node
'use strict';
/**
 * test-75e9-folder-dedupe.cjs —— B-20261117-074103-75e9 回归夹具
 *
 * 缺陷：工作台「文件夹」每点一次 `shell.openPath` 一次 → 同一目录堆 N 个资源管理器窗口。
 * 修法：`src/folder-open.js` 唯一实现（project:open 与 files:open 的目录分支共用）：
 *   ① 同一路径 3s 内重复 → 不新开（throttle）
 *   ② 5 分钟内已开过 → 不新开，尽力聚焦已有窗口（focus 回调）
 *   ③ 首次点击行为不变（真调 openPath）
 *   ④ stats() 计数供自检断言
 *
 * 断言（注入 openPath/now/focus，不真弹窗口）：
 *   D1 连点 5 次同一路径 → openPath 只被调 1 次，deduped=4、throttleHits=4（AC①④）
 *   D2 3s 后再点 → 仍是「已开」不新开（5 分钟窗口内），且触发 focus 且 focused 计数 +1（AC②）
 *   D3 超过 5 分钟再点 → 真开第二次（AC③：行为可恢复）
 *   D4 不同路径互不影响（各自首开）
 *   D5 路径归一：盘符大小写、反斜杠/斜杠形态视为同一目录（用运行时路径构造，不写盘符字面量）
 *   D6 静态接线：main.js 的 project:open 与 files:open 目录分支走 folderOpener.open（不再裸 shell.openPath）
 *
 * 跑法：node scripts/test-75e9-folder-dedupe.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { createFolderOpener } = require(path.join(ROOT, 'src', 'folder-open.js'));
// 路径用运行时构造（不在源码里写盘符字面量，避免真实树路径审计误判）
const REQ_DIR = path.join(ROOT, '项目', '工作台改造修复');
const WIN = (p) => p.replace(/\//g, '\\');
const SLASH_LOWER = (p) => p.replace(/\\/g, '/').toLowerCase();

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); return; }
  fail += 1; console.log(`FAIL  ${name}  ` + JSON.stringify(detail || {}).slice(0, 300)); process.exitCode = 1;
}

(async () => {
  let clock = 1_000_000;
  const calls = [];
  const focusCalls = [];
  const opener = createFolderOpener({
    openPath: async (t) => { calls.push(t); return ''; },
    focus: async (t) => { focusCalls.push(t); return true; },
    now: () => clock,
  });

  // D1：连点 5 次
  const results = [];
  for (let i = 0; i < 5; i += 1) {
    results.push(await opener.open(WIN(REQ_DIR)));
    clock += 100;
  }
  const s1 = opener.stats();
  ok('D1 连点 5 次同一路径 → openPath 只调 1 次，deduped=4、throttleHits=4（AC①④）',
    calls.length === 1 && s1.opened === 1 && s1.deduped === 4 && s1.throttleHits === 4,
    { calls: calls.length, stats: s1 });

  // D2：3.5s 后再点 → 不新开，且调 focus
  clock += 3500;
  const r2 = await opener.open(SLASH_LOWER(REQ_DIR) + '/');
  const s2 = opener.stats();
  ok('D2 3s 后再点 → 仍不新开（5 分钟已开复用）+ 触发 focus（AC②）+ 路径归一（D5）',
    r2.deduped === true && r2.reason === 'already-open' && calls.length === 1
    && focusCalls.length === 1 && s2.focused === 1,
    { result: r2, focusCalls: focusCalls.length, stats: s2 });

  // D3：超过 5 分钟 → 真开
  clock += 5 * 60 * 1000 + 1000;
  const r3 = await opener.open(WIN(REQ_DIR));
  const s3 = opener.stats();
  ok('D3 超过 5 分钟再点 → 真开第二次（AC③ 行为可恢复）',
    r3.opened === true && calls.length === 2 && s3.opened === 2, { calls: calls.length, stats: s3 });

  // D4：不同路径各自首开
  const r4a = await opener.open(WIN(path.join(ROOT, '项目', '另一个')));
  const r4b = await opener.open(WIN(path.join(ROOT, '项目', '再一个')));
  ok('D4 不同路径互不影响（各自首开）',
    r4a.opened === true && r4b.opened === true && calls.length === 4, { calls: calls.length });

  // D6：静态接线
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  ok('D6 静态接线：project:open 与 files:open 目录分支都走 folderOpener.open',
    /return folderOpener\.open\(p\.path\);/.test(mainSrc)
    && /if \(isDir\) return folderOpener\.open\(target\);/.test(mainSrc)
    && /FolderOpen\.createFolderOpener\(/.test(mainSrc), {});

  console.log(`\nFOLDER_DEDUPE ${JSON.stringify({ total: pass + fail, pass, fail })}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FOLDER_DEDUPE_FAILED ' + String((e && e.stack) || e)); process.exit(2); });
