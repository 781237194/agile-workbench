'use strict';
/**
 * T-20261115-173751-5644 守卫断言：selftest 夹具不再写死 65536。
 *
 * 双目标（2026-11-16 PM/analyst 复核要求）：
 *  ①提案副本 提案暂存-5644/main.js：不再含 65536、夹具=8*1024*1024；
 *  ②真实文件 src/main.js：apply 后必须同样=8MB 且与副本逐字节一致（sha256 相等）——
 *    否则「apply 后有人改回 65536」而测试仍绿。
 *
 * pre-apply 兼容：当 src/main.js 仍等于提案 base（8b515126…，尚未 apply）时，②只记 INFO；
 * apply 后（src 值=8MB 或 hash 已变）②变成硬断言。env AWB_EXPECT_APPLIED=1 可强制硬断言。
 *
 * 措辞：main.js 里是「硬编码 8*1024*1024 + 本测试守护」，不是从 roles import 同源。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const staged = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '提案暂存-5644', 'main.js');
const realMain = path.join(ROOT, 'src', 'main.js');
const rolesFile = path.join(ROOT, '团队', '工具', 'lib', 'roles.mjs');
const storeFile = path.join(ROOT, '团队', '工具', 'lib', 'store.mjs');
const BASE_SHA = '8b515126e8fe73b8db2bd6f393f836f6de311b3565f499152525d66fba2a2670'; // 提案 base（未 apply 的真实文件）
const sha = (p) => crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const DEF_RE = /export const DEFAULT_CODE_MAX_BYTES\s*=\s*([^;]+);/;

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 300)}`);
  if (!ok) process.exitCode = 1;
}
function info(name, detail) { console.log(`INFO  ${name}  ${String(JSON.stringify(detail)).slice(0, 300)}`); }

const mainText = fs.readFileSync(staged, 'utf8');
check('提案副本不再出现 codeMaxBytes: 65536', !/codeMaxBytes\s*:\s*65536/.test(mainText), 'still hardcoded 65536');
check('提案副本夹具写明 codeMaxBytes: 8 * 1024 * 1024', /codeMaxBytes\s*:\s*8\s*\*\s*1024\s*\*\s*1024/.test(mainText), 'missing 8MB fixture');
check('提案副本注释写明「硬编码 + 测试守护」而非 import 同源', /测试守护|测试同步|test-5644/.test(mainText) || /DEFAULT_CODE_MAX_BYTES/.test(mainText), 'missing guard comment');

// 常量口径（roles 优先，f79c 前在 store；f79c 后 store re-export）
const rolesText = fs.readFileSync(rolesFile, 'utf8');
const storeText = fs.readFileSync(storeFile, 'utf8');
const defMatch = DEF_RE.exec(rolesText) || DEF_RE.exec(storeText);
const defValue = defMatch ? Number(Function(`return (${defMatch[1]});`)()) : NaN;
check('DEFAULT_CODE_MAX_BYTES 可解析且 = 8MB（roles 或 store）', defValue === 8 * 1024 * 1024, defMatch && defMatch[1]);

const stagedValue = Number((/codeMaxBytes\s*:\s*([0-9\s*]+),/.exec(mainText) || [])[1]
  ? Function(`return (${(/codeMaxBytes\s*:\s*([0-9\s*]+),/.exec(mainText))[1]});`)() : NaN);
check('提案副本夹具值与 DEFAULT_CODE_MAX_BYTES 相等', stagedValue === defValue, { stagedValue, defValue });

// ②真实文件守卫
const realText = fs.readFileSync(realMain, 'utf8');
const realValue = Number((/codeMaxBytes\s*:\s*([0-9\s*]+),/.exec(realText) || [])[1]
  ? Function(`return (${(/codeMaxBytes\s*:\s*([0-9\s*]+),/.exec(realText))[1]});`)() : NaN);
const realSha = sha(realMain);
const stagedSha = sha(staged);
const applied = realSha === stagedSha || realValue === 8 * 1024 * 1024 || process.env.AWB_EXPECT_APPLIED === '1';
if (!applied) {
  const pending = realSha === BASE_SHA && realValue === 65536;
  check('真实 src/main.js 守卫（pre-apply 兼容）', pending, { realSha: realSha.slice(0, 16), realValue });
  if (pending) info('src/main.js 仍是提案 base（65536），apply 后本条变硬断言', { realSha: realSha.slice(0, 16) });
} else {
  check('真实 src/main.js 的 codeMaxBytes = 8 * 1024 * 1024', realValue === 8 * 1024 * 1024, { realValue });
  check('真实 src/main.js 与提案副本逐字节一致（sha256 相等）', realSha === stagedSha, { real: realSha.slice(0, 16), staged: stagedSha.slice(0, 16) });
}

const passed = results.filter((r) => r.ok).length;
const failed = results.length - passed;
console.log(`\nT-5644 夹具同步断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
const evid = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-5644');
fs.mkdirSync(evid, { recursive: true });
fs.writeFileSync(path.join(evid, 'run-5644.json'), JSON.stringify({ passed, failed, applied, results }, null, 2) + '\n', 'utf8');
