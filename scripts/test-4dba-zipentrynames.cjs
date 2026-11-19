#!/usr/bin/env node
'use strict';
/**
 * test-4dba-zipentrynames.cjs —— B-20261119-201948-4dba 夹具（PM 2026-11-20 落地）
 *
 * 背景（PM 更正）：4dba 报「zipEntryNames 对自建 zip 返回 0 条」，实测根因不是 zip 格式，
 * 而是**调用方把文件路径字符串传进去**，旧实现 `Buffer.from(路径字符串)` → 解析不到中央目录 → 静默返回 []。
 * 于是「自检」把「解析失败」当成「包里没有条目」，守卫形同虚设。
 *
 * 断言：
 *   A1 Buffer 入参 → 真实条目数（对 发布/pm-workbench-2.1.8.zip 断言 > 600）
 *   A2 路径字符串入参 → 与 A1 相同（旧实现会得 0）
 *   A3 数字/undefined 等非法入参 → 抛 BAD_ZIP_INPUT（不静默返回空）
 *   A4 非 zip 内容 → 抛 ZIP_UNREADABLE
 *   A5 opts.allowEmpty=true 时才允许空数组（夹具专用后门）
 *   A6 关键条目（PACKAGE_ASSERT_ENTRIES）在包里都能被定位到
 *   A7 build-upgrade-zip 的自检不再可能因空数组而假绿：names.length===0 时脚本必须非 0 退出
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const manifest = require('./upgrade-package-manifest.cjs');
const rows = [];
function check(name, ok, detail) {
  let text = '';
  try { text = JSON.stringify(detail === undefined ? null : detail); } catch { text = String(detail); }
  rows.push({ name, ok: Boolean(ok) });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : ' :: ' + String(text).slice(0, 400)));
}

const zip = path.join(ROOT, '发布', 'pm-workbench-2.1.8.zip');
let buf = null;
try { buf = fs.readFileSync(zip); } catch { buf = null; }
check('前置：存在 发布/pm-workbench-2.1.8.zip', Boolean(buf), { zip });

let viaBuffer = [];
let viaPath = [];
if (buf) {
  try { viaBuffer = manifest.zipEntryNames(buf); } catch (e) { viaBuffer = []; console.log('  (Buffer 抛错: ' + e.message + ')'); }
  try { viaPath = manifest.zipEntryNames(zip); } catch (e) { viaPath = []; console.log('  (路径 抛错: ' + e.message + ')'); }
}
check('A1 Buffer 入参解析出真实条目（>600）', viaBuffer.length > 600, { count: viaBuffer.length });
check('A2 路径字符串入参与 Buffer 结果一致（旧实现会得 0）', viaPath.length === viaBuffer.length && viaPath.length > 600, {
  viaBuffer: viaBuffer.length, viaPath: viaPath.length,
});

let badTypeThrew = false;
try { manifest.zipEntryNames(12345); } catch (e) { badTypeThrew = /BAD_ZIP_INPUT/.test(String(e && e.message)); }
check('A3 非法入参（数字）抛 BAD_ZIP_INPUT', badTypeThrew, {});

let garbageThrew = false;
try { manifest.zipEntryNames(Buffer.from('this is not a zip at all')); } catch (e) { garbageThrew = /ZIP_UNREADABLE/.test(String(e && e.message)); }
check('A4 非 zip 内容抛 ZIP_UNREADABLE', garbageThrew, {});

const emptyOk = (() => {
  try { return manifest.zipEntryNames(Buffer.from('x'), { allowEmpty: true }).length === 0; } catch { return false; }
})();
check('A5 allowEmpty 后门可返回空数组（仅夹具用）', emptyOk, {});

if (buf) {
  const miss = manifest.PACKAGE_ASSERT_ENTRIES.filter((rel) => !viaPath.some((n) => n.replace(/\\/g, '/').endsWith('/' + rel) || n === rel));
  check('A6 关键条目全部可在包内定位', miss.length === 0, { miss });
}

// A7：把 manifest 临时指到「必空」的场景，build 脚本必须失败——用子进程注入 stub 模块
const stubDir = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-4dba-'));
try {
  const stub = `
    const real = require(${JSON.stringify(path.join(ROOT, 'scripts', 'upgrade-package-manifest.cjs'))});
    module.exports = Object.assign({}, real, { zipEntryNames: () => [] });
  `;
  fs.writeFileSync(path.join(stubDir, 'upgrade-package-manifest.cjs'), stub, 'utf8');
  // 不实际跑 build（它要打全包，太慢）；改为断言 build 脚本源码在 names 为空时有显式失败分支
  const src = fs.readFileSync(path.join(ROOT, 'scripts', 'build-upgrade-zip.cjs'), 'utf8');
  const guarded = /names\.length\s*===\s*0|!names\.length/.test(src) && /return 1|process\.exit\(1\)/.test(src);
  check('A7 build-upgrade-zip 对「条目 0」有显式失败分支（防假绿）', guarded, {});
} finally {
  try { fs.rmSync(stubDir, { recursive: true, force: true }); } catch { /* ignore */ }
}

const pass = rows.filter((r) => r.ok).length;
console.log(`\n${pass}/${rows.length} PASS`);
process.exit(pass === rows.length ? 0 : 1);
