'use strict';
/**
 * T-ece6 启动加固断言（只读）：确认 start.cmd 用绝对路径、有残留检测、锁冲突不静默。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const cmd = fs.readFileSync(path.join(ROOT, 'start.cmd'), 'utf8');
const guard = fs.readFileSync(path.join(ROOT, 'scripts/start-guard.ps1'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'src/main.js'), 'utf8');

const checks = [];
const push = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail }); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`); };

push('start.cmd 用 %~dp0 派生 APP_DIR', /set "APP_DIR=%~dp0"/.test(cmd));
push('electron 用绝对路径启动（%APP_DIR% 前缀）', /set "ELECTRON_EXE=%APP_DIR%\\node_modules\\electron\\dist\\electron\.exe"/.test(cmd));
push('启动时传入绝对项目目录', /"%ELECTRON_EXE%" "%APP_DIR%"/.test(cmd));
push('有 --check 启动前检查入口', /--check/.test(cmd) && /:check/.test(cmd));
push('有 --kill-orphans 清理入口', /--kill-orphans/.test(cmd) && /:kill_orphans/.test(cmd));
push('默认不杀进程（只提示）', /只提示、不启动/.test(cmd) || /exit \/b 2/.test(cmd));
push('guard 只认本目录且排除 --type= 的主进程', /ExecutablePath\.StartsWith/.test(guard) && /--type=/.test(guard));
push('main.js 锁冲突有显式日志 SINGLE_INSTANCE_LOCK_DENIED', /SINGLE_INSTANCE_LOCK_DENIED/.test(main));
push('main.js 锁冲突有人话弹窗（dialog.showErrorBox）', /showErrorBox/.test(main));
push('启动文档存在', fs.existsSync(path.join(ROOT, 'docs/启动与黑屏排查.md')));

const failed = checks.filter((row) => !row.ok);
console.log(`START_GUARD_CHECK ${JSON.stringify({ ok: failed.length === 0, total: checks.length, failed: failed.length })}`);
process.exit(failed.length === 0 ? 0 : 1);
