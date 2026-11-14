#!/usr/bin/env node
'use strict';
/**
 * R-b28f AC7 降级断言（B-20261115-070547-2ed0）
 *
 * 场景：`评审代管.json` 被写坏（非法 JSON）时，界面必须显示「代管状态读取失败 · 重试」，
 * 而不是把「读不出来」显示成「未启用」。
 *
 * 分两层：
 *  ① 运行时（真函数）：把 团队/工具/lib 的 store 读出逻辑按同一契约复现——主进程 readOwnerProxy 的实现是
 *     「解析失败 → { records: [], readError }」，本脚本用源码抽取的函数体在临时目录里真跑一遍；
 *  ② 源码级断言：main.js 的 readOwnerProxy 不再静默 return {records:[]}、owner:proxy-status 透出 readError、
 *     渲染层有 [data-proxy-retry] + 「读取失败 · 重试」+ retryProxyRead。
 *
 * 跑法：node scripts\test-proxy-read-error.cjs   （纯 Node，不启动 Electron、不碰真实 data/ 与 团队/状态/）
 * 退出码：0 全绿；1 有失败。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const MAIN = path.join(ROOT, 'src', 'main.js');
const RENDERER = path.join(ROOT, 'src', 'renderer', 'owner-review.js');
const OUT_DIR = path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-b28f-ac7');

const rows = [];
let failed = 0;
function check(name, ok, detail) {
  rows.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  if (!ok) failed += 1;
  console.log((ok ? 'PASS ' : 'FAIL ') + name + (detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 300)));
}

/* ① 运行时：从 main.js 抽出 readOwnerProxy 的函数体，在临时目录真跑「被写坏的 评审代管.json」 */
const mainText = fs.readFileSync(MAIN, 'utf8');
const fnMatch = mainText.match(/const readOwnerProxy = \(project\) => \{[\s\S]*?\n  \};/);
check('main.js 里能抽到 readOwnerProxy 实现', Boolean(fnMatch), { found: Boolean(fnMatch) });

let runtime = null;
if (fnMatch) {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b28f-ac7-'));
  const dir = path.join(tmp, '状态', '项目', '沙盘项目');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, '评审代管.json');
  fs.writeFileSync(file, '{ 这不是合法 JSON', 'utf8');
  const body = fnMatch[0]
    .replace('const readOwnerProxy = (project) => {', 'return (project) => {')
    .replace(/\n  \};$/, '\n  };');
  const factory = new Function('fs', 'path', 'ownerProxyFile', 'console', body + '\n return readOwnerProxy;');
  const readOwnerProxy = factory(fs, path, () => file, console);
  runtime = readOwnerProxy({ path: tmp });
  check('写坏 评审代管.json 后：readOwnerProxy 返回 records=[]（不崩）', Array.isArray(runtime.records) && runtime.records.length === 0, { records: runtime.records });
  check('写坏后带回 readError.code=PROXY_STATE_UNREADABLE', Boolean(runtime.readError && runtime.readError.code === 'PROXY_STATE_UNREADABLE'), runtime.readError);
  check('readError.message 是人话（含「读取失败」）', Boolean(runtime.readError && /读取失败/.test(String(runtime.readError.message))), { message: runtime.readError && runtime.readError.message });

  // 正常文件不误报
  fs.writeFileSync(file, JSON.stringify({ records: [{ id: 'P-1', scope: 'all', startedAt: 'x' }] }, null, 2), 'utf8');
  const okRun = readOwnerProxy({ path: tmp });
  check('正常 评审代管.json：不返回 readError，records 原样带回', !okRun.readError && Array.isArray(okRun.records) && okRun.records.length === 1, { records: okRun.records.length, readError: okRun.readError || null });
  // 「恢复后重试回正常」：先把文件写坏 → 读到错误态；修好文件后再次读（= 点重试那一下）→ 回到正常态、无误报
  fs.writeFileSync(file, '{"records": [ 坏', 'utf8');
  const brokenAgain = readOwnerProxy({ path: tmp });
  check('再次写坏：回到错误态（readError 出现）', Boolean(brokenAgain.readError), { code: brokenAgain.readError && brokenAgain.readError.code });
  fs.writeFileSync(file, JSON.stringify({ records: [{ id: 'P-2', scope: 'all', startedAt: 'y' }] }, null, 2), 'utf8');
  const recovered = readOwnerProxy({ path: tmp });
  check('恢复文件后重读（点重试）= 回到正常态：无 readError 且 records 正确', !recovered.readError && Array.isArray(recovered.records) && recovered.records.length === 1 && recovered.records[0].id === 'P-2', { records: recovered.records.length, id: recovered.records[0] && recovered.records[0].id, readError: recovered.readError || null });
  check('恢复后仍能取到 scope=all 生效记录（行可回到「代管中」而不是空）', Array.isArray(recovered.records) && recovered.records.some((row) => String(row.scope || '') === 'all' && !row.endedAt), null);
  fs.rmSync(tmp, { recursive: true, force: true });
}

/* ② 源码级断言 */
const statusHandler = (mainText.match(/ipcMain\.handle\('owner:proxy-status'[\s\S]*?\n  \}\);/) || [''])[0];
check('owner:proxy-status 透出 readError（IPC 不再吞掉）', /readError:\s*data\.readError/.test(statusHandler), { handlerLen: statusHandler.length });
check('main.js 有 readOwnerProxyStrict（写操作读失败直接抛，不当作没记录）', /const readOwnerProxyStrict = \(project\) => \{/.test(mainText), null);
check('main.js 不再存在裸「catch { return { records: [] } }」的吞错写法', !/catch \{ return \{ records: \[\] \}; \}/.test(mainText), null);

const rendererText = fs.readFileSync(RENDERER, 'utf8');
check('渲染层识别 readError（不再无条件清空 proxyReadError）', /if \(r && r\.readError\)/.test(rendererText), null);
check('渲染层有 [data-proxy-retry] 锚点', /data-proxy-retry/.test(rendererText), null);
check('渲染层错误态文案 =「代管状态读取失败 · 重试」', /代管状态读取失败 · 重试/.test(rendererText), null);
check('渲染层有 retryProxyRead()（点了能重读）', /async function retryProxyRead\(\)/.test(rendererText) && /retryProxyRead\(\)/.test(rendererText), null);
check('错误态时行仍是 button 且不 disabled（可点重试）', /row\.disabled = rowState === 'missing'/.test(rendererText), null);

fs.mkdirSync(OUT_DIR, { recursive: true });
fs.writeFileSync(path.join(OUT_DIR, 'proxy-read-error-result.json'), JSON.stringify({ at: new Date().toISOString(), total: rows.length, failed, rows }, null, 2) + '\n', 'utf8');
console.log(`\nR-b28f AC7 降级断言：${rows.length - failed}/${rows.length} PASS`);
console.log('证据：' + path.relative(ROOT, path.join(OUT_DIR, 'proxy-read-error-result.json')));
process.exit(failed ? 1 : 0);
