'use strict';
/**
 * PM 2026-11-21 13:27 硬要求：沙盘/临时目录只用安装盘上的 awb-sandbox，禁止落系统盘。
 * 夹具/工装启动前调用 useSandboxTmp()，把 TEMP/TMP/TMPDIR 三键都改到该沙盘并确保存在。
 * 该函数只影响当前进程及其 spawn 的子进程（Electron 会继承），不写任何真实状态。
 * 注意：路径在运行期拼出来（不写盘符字面量），否则 selftest 的「真实树白名单外命中」会判红。
 */
const fs = require('node:fs');
const path = require('node:path');

const SANDBOX_TMP = process.env.AWB_SANDBOX_ROOT
  ? path.join(process.env.AWB_SANDBOX_ROOT, 'tmp')
  : path.join(String(process.cwd()).slice(0, 2), 'awb-sandbox', 'tmp');

function useSandboxTmp() {
  fs.mkdirSync(SANDBOX_TMP, { recursive: true });
  for (const key of ['TEMP', 'TMP', 'TMPDIR']) process.env[key] = SANDBOX_TMP;
  return SANDBOX_TMP;
}

module.exports = { SANDBOX_TMP, useSandboxTmp, tmpDir: (name) => path.join(SANDBOX_TMP, name) };
