#!/usr/bin/env node
'use strict';

// Electron 启动器：所有 npm 入口先经过这里。
//
// 为什么需要它：在 DSH / Electron 宿主派生的终端里，环境经常带着
// ELECTRON_RUN_AS_NODE=1。只要这个变量存在，electron.exe 就退化成纯 Node
// 解释器，`electron .` 会在 src/main.js 的 app.setPath 处直接崩：
//   TypeError: Cannot read properties of undefined (reading 'setPath')
// 所以入口的第一件事必须是把它从进程环境里删掉，再启动 Electron。
//
// 用法：
//   node scripts/run-electron.cjs .                 # 等价于 electron .
//   node scripts/run-electron.cjs . --selftest      # 参数原样透传
//   node scripts/run-electron.cjs --print-plan .    # 只打印启动计划，不启动 Electron
//   node scripts/run-electron.cjs --help
//
// 退出码：与 Electron 子进程一致；找不到 Electron 或参数错误时为 1。
// 仅供测试：AWB_ELECTRON_BIN 可指向别的可执行文件，验证环境清理与退出码透传。

const ENV_KEY = 'ELECTRON_RUN_AS_NODE';

// ── 关键：先清环境，再解析/启动任何东西 ──────────────────────────────────
const inheritedRunAsNode = Object.prototype.hasOwnProperty.call(process.env, ENV_KEY);
const inheritedRunAsNodeValue = inheritedRunAsNode ? String(process.env[ENV_KEY]) : '';
if (inheritedRunAsNode) delete process.env.ELECTRON_RUN_AS_NODE;

const fs = require('node:fs');
const path = require('node:path');
const { spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

function looksLikeFile(target) {
  try {
    return fs.statSync(target).isFile();
  } catch {
    return false;
  }
}

function resolveElectron() {
  const override = process.env.AWB_ELECTRON_BIN;
  if (override) {
    return { bin: path.resolve(override), source: 'AWB_ELECTRON_BIN' };
  }

  const pkgDir = path.join(ROOT, 'node_modules', 'electron');
  const distDir = path.join(pkgDir, 'dist');

  // electron 包安装后会在 path.txt 里写可执行文件名，这是官方布局。
  try {
    const rel = fs.readFileSync(path.join(pkgDir, 'path.txt'), 'utf8').trim();
    if (rel) {
      const fromPathFile = path.join(distDir, rel);
      if (looksLikeFile(fromPathFile)) {
        return { bin: fromPathFile, source: 'node_modules/electron/path.txt' };
      }
    }
  } catch {
    /* 继续走下面的兜底 */
  }

  const platformDefault = path.join(distDir, process.platform === 'win32' ? 'electron.exe' : 'electron');
  if (looksLikeFile(platformDefault)) {
    return { bin: platformDefault, source: 'node_modules/electron/dist' };
  }

  // 在普通 Node 里 require('electron') 返回可执行文件路径；放在最后兜底。
  try {
    const resolved = require('electron');
    if (typeof resolved === 'string' && looksLikeFile(resolved)) {
      return { bin: resolved, source: 'require("electron")' };
    }
  } catch {
    /* 没装依赖，交给调用方报错 */
  }

  return { bin: platformDefault, source: 'not-found' };
}

function printHelp() {
  console.log('用法：node scripts\\run-electron.cjs [--print-plan] [Electron 参数...]');
  console.log('');
  console.log('  .                    启动当前工作台（与 npm start 相同）');
  console.log('  . --selftest         运行自检（与 npm run selftest 相同）');
  console.log('  --version            只让 Electron 打印版本，不打开窗口');
  console.log('  --print-plan         只打印解析到的 Electron 路径/参数/环境清理结果，不启动');
  console.log('');
  console.log('说明：入口会先清除继承的 ELECTRON_RUN_AS_NODE，再启动 Electron。');
}

function printPlan(args) {
  const resolved = resolveElectron();
  const plan = {
    ok: resolved.source !== 'not-found',
    electron: resolved.bin,
    electronSource: resolved.source,
    electronExists: looksLikeFile(resolved.bin),
    appArgs: args,
    cwd: ROOT,
    inheritedRunAsNode,
    inheritedRunAsNodeValue,
    cleared: inheritedRunAsNode ? [ENV_KEY] : [],
    childEnvHasRunAsNode: Object.prototype.hasOwnProperty.call(process.env, ENV_KEY),
  };
  console.log(JSON.stringify(plan, null, 2));
  return plan.ok ? 0 : 1;
}

function failMissingElectron(resolved) {
  console.error('');
  console.error('[失败] 找不到 Electron 可执行文件。');
  console.error(`  期望位置：${resolved.bin}`);
  console.error('  处理办法：在仓库根目录执行 npm install');
  console.error('  说明：electron 在 package.json 的 devDependencies 里，没装依赖就启动不了。');
}

const argv = process.argv.slice(2);

if (argv[0] === '--help' || argv[0] === '-h') {
  printHelp();
  process.exit(0);
}

if (argv[0] === '--print-plan') {
  process.exit(printPlan(argv.slice(1)));
}

const resolved = resolveElectron();
if (!looksLikeFile(resolved.bin)) {
  failMissingElectron(resolved);
  process.exit(1);
}

// 明确告诉用户“这次继承的值被清掉了”，避免以后又把它当成产品崩溃。
if (inheritedRunAsNode) {
  console.error(`[环境] 检测到继承的 ${ENV_KEY}=${inheritedRunAsNodeValue || '(空)'}，已在启动 Electron 前清除。`);
}

const args = argv.length ? argv : ['.'];
let child;
try {
  child = spawn(resolved.bin, args, {
    cwd: ROOT,
    env: process.env,
    stdio: 'inherit',
    windowsHide: false,
  });
} catch (error) {
  console.error(`[失败] 无法启动 Electron：${String(error && error.message || error)}`);
  process.exit(1);
}

child.on('error', (error) => {
  console.error(`[失败] 无法启动 Electron：${String(error && error.message || error)}`);
  process.exit(1);
});

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[失败] Electron 被信号 ${signal} 终止。`);
    process.exit(1);
  }
  process.exit(code === null ? 1 : code);
});

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.on(signal, () => {
    if (!child.killed) child.kill(signal);
  });
}
