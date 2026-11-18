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
  console.log('  . --sq-check         会话排队面板自检（沙盘 + AWB_SQ_OUT 指定产物目录）');
  console.log('  . --live-check       会话实时状态面板自检（沙盘 + AWB_LIVE_OUT 指定产物目录）');
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
// 注意：这是「已处理」的提示、不是错误，必须写 stdout——写 stderr 会让
// `--layout-check` / `--theme-shots` 这类「ok=true」的自检被 CI 判成失败
// （PM 2026-11-16 反馈：报 ok=true 但退出码被记成 1）。
if (inheritedRunAsNode) {
  console.log(`[环境] 检测到继承的 ${ENV_KEY}=${inheritedRunAsNodeValue || '(空)'}，已在启动 Electron 前清除。`);
}

const args = argv.length ? argv : ['.'];

// R-c9ac：--live-check 自检的沙盘隔离在启动前兜底（主进程 src/main.js 里还会再兜一次，
// 保证直接 `electron . --live-check` 与经本入口启动行为一致）：
//   ① TEAM_SELFTEST=1 —— 沙盘不驱动 DSH、不弹通知；
//   ② AWB_LIVE_DATA   —— 独立数据根（缺省 .live-check-data）；
//   ③ AWB_LIVE_OUT    —— 自检产物目录（缺省 _tmp/live-check）。
// 只给 flag 不给 app 路径时补 '.'，否则 Electron 会把 --live-check 当成应用目录。
if (args.includes('--live-check')) {
  if (!process.env.TEAM_SELFTEST) process.env.TEAM_SELFTEST = '1';
  if (!process.env.AWB_LIVE_DATA) process.env.AWB_LIVE_DATA = path.join(ROOT, '.live-check-data');
  if (!process.env.AWB_LIVE_OUT) process.env.AWB_LIVE_OUT = path.join(ROOT, '_tmp', 'live-check');
  if (args[0] && String(args[0]).startsWith('--')) args.unshift('.');
  // 写 stdout（不是 stderr）：自检按 ok=true 判成功，stderr 会被 CI 误当失败。
  console.log(`[live-check] 沙盘隔离：TEAM_SELFTEST=${process.env.TEAM_SELFTEST} · AWB_LIVE_DATA=${process.env.AWB_LIVE_DATA} · AWB_LIVE_OUT=${process.env.AWB_LIVE_OUT}`);
}

// 30d8：沙盘测试集中隔离 DSH_HOME。
// 背景：UI/沙盘测试拉起工作台（内嵌 DSH）时若未隔离 DSH_HOME，DSH 会把 _tmp 沙盘目录
// 注册进真实 ~/.dsh/storages/workspace.json，沙盘清理后界面一直留着死工作区（c72a 事故）。
// 关键：DSH 宿主派生的终端**通常已继承 DSH_HOME=~/.dsh**（本机会话实测），所以不能只在
// 「未设置」时兜底，必须在识别到沙盘时**强制覆盖**（除非显式 AWB_ALLOW_REAL_DSH_HOME=1）。
// 口径：AWB_DATA_DIR / TEAM_ROOT / TEAM_WORKBENCH_JSON 指向 `_tmp` 沙盘 → DSH_HOME=<沙盘根>/dsh-home。
function sandboxRootOf() {
  const cands = [process.env.AWB_DATA_DIR, process.env.TEAM_ROOT, process.env.TEAM_WORKBENCH_JSON]
    .filter(Boolean)
    .map((p) => path.resolve(String(p)));
  for (const p of cands) {
    const segs = p.split(path.sep);
    let i = -1;
    segs.forEach((seg, idx) => { if (/^_tmp([._-].*)?$/i.test(seg)) i = idx; });
    // 沙盘根 = `_tmp/<沙盘目录>`：取 _tmp 的下一层（没有下一层时退回 _tmp 本身）
    if (i > 0) return segs.slice(0, Math.min(segs.length, i + 2)).join(path.sep);
  }
  return '';
}
{
  const sandboxRoot = sandboxRootOf();
  const allowReal = process.env.AWB_ALLOW_REAL_DSH_HOME === '1';
  if (sandboxRoot && !allowReal) {
    const inherited = String(process.env.DSH_HOME || '');
    const dshHome = path.join(sandboxRoot, 'dsh-home');
    try { fs.mkdirSync(dshHome, { recursive: true }); } catch { /* 建目录失败不阻断启动，但 env 仍隔离 */ }
    process.env.DSH_HOME = dshHome;
    const overridden = inherited && path.resolve(inherited) !== dshHome;
    // 写 stdout（不是 stderr）：这类自检脚本按 ok=true 判成功，stderr 会让 CI 误判失败
    console.log(overridden
      ? `[隔离] 沙盘测试强制改 DSH_HOME：继承 ${inherited}（真实家目录）→ ${dshHome}`
      : `[隔离] 沙盘测试 DSH_HOME 已指向 ${dshHome}（不写真实 ~/.dsh）`);
  }
}
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
