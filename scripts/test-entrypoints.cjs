#!/usr/bin/env node
'use strict';

// 入口脚本测试：不打开工作台窗口，只验证
//   1. package.json 的 start / selftest 都经过 run-electron.cjs；
//   2. run-electron.cjs 会清掉继承的 ELECTRON_RUN_AS_NODE；
//   3. 参数、退出码原样透传到子进程；
//   4. 真正启动的是 Electron（--version 是 v33.x，而不是 Node 的 v20.x）；
//   5. 缺 Electron 时错误可读；
//   6. start.cmd 会清环境、透传参数，失败时打印可见错误且不阻塞（AWB_NO_PAUSE）。
//
// 用法：npm run test:scripts

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const RUNNER = path.join(ROOT, 'scripts', 'run-electron.cjs');
const START_CMD = path.join(ROOT, 'start.cmd');
const NODE = process.execPath;
const IS_WIN = process.platform === 'win32';
const CMD = process.env.ComSpec || 'cmd.exe';

const electronPkg = JSON.parse(
  fs.readFileSync(path.join(ROOT, 'node_modules', 'electron', 'package.json'), 'utf8'),
);
const electronVersion = `v${electronPkg.version}`;

let passed = 0;
const failures = [];

function test(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`PASS  ${name}`);
  } catch (error) {
    failures.push({ name, error });
    console.error(`FAIL  ${name}`);
    console.error(String(error && error.stack || error).split('\n').map((line) => `      ${line}`).join('\n'));
  }
}

function nodeEnv(extra = {}) {
  const env = { ...process.env, ...extra };
  if (extra.ELECTRON_RUN_AS_NODE === undefined) delete env.ELECTRON_RUN_AS_NODE;
  if (extra.AWB_ELECTRON_BIN === undefined) delete env.AWB_ELECTRON_BIN;
  return env;
}

function runRunner(args, extraEnv = {}) {
  return spawnSync(NODE, [RUNNER, ...args], {
    cwd: ROOT,
    env: nodeEnv(extraEnv),
    encoding: 'utf8',
    timeout: 30000,
  });
}

function runStartCmd(args, extraEnv = {}, cwd = ROOT) {
  assert.ok(IS_WIN, 'start.cmd 测试只在 Windows 上运行');
  return spawnSync(CMD, ['/d', '/c', path.join(cwd, 'start.cmd'), ...args], {
    cwd,
    env: nodeEnv(extraEnv),
    encoding: 'utf8',
    timeout: 30000,
  });
}

function output(result) {
  return `${result.stdout || ''}${result.stderr || ''}`;
}

// ── 1. package.json 入口 ────────────────────────────────────────────────
test('package.json: start/selftest 都经过 run-electron.cjs', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  assert.match(pkg.scripts.start, /scripts[\\/]run-electron\.cjs/);
  assert.match(pkg.scripts.selftest, /scripts[\\/]run-electron\.cjs/);
  assert.equal(pkg.scripts.selftest.includes('--user-data-dir'), false);
  assert.ok(pkg.files.includes('scripts/run-electron.cjs'));
});

// ── 2. 启动计划：继承 ELECTRON_RUN_AS_NODE=1 时的清理结果 ──────────────
test('run-electron: ELECTRON_RUN_AS_NODE=1 时报告已清除，子环境无该变量', () => {
  const result = runRunner(['--print-plan', '.', '--selftest'], { ELECTRON_RUN_AS_NODE: '1' });
  assert.equal(result.status, 0, output(result));
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.inheritedRunAsNode, true);
  assert.deepEqual(plan.cleared, ['ELECTRON_RUN_AS_NODE']);
  assert.equal(plan.childEnvHasRunAsNode, false);
  assert.deepEqual(plan.appArgs, ['.', '--selftest']);
  assert.equal(plan.electronExists, true);
  assert.ok(plan.electron.toLowerCase().includes('electron'));
});

test('run-electron: 没有该变量时计划保持干净', () => {
  const result = runRunner(['--print-plan', '.']);
  assert.equal(result.status, 0, output(result));
  const plan = JSON.parse(result.stdout);
  assert.equal(plan.inheritedRunAsNode, false);
  assert.deepEqual(plan.cleared, []);
  assert.equal(plan.childEnvHasRunAsNode, false);
});

// ── 3. 子进程环境与退出码透传（用 Node 当假 Electron，不启动 GUI） ──────
test('run-electron: 子进程看不到 ELECTRON_RUN_AS_NODE，退出码原样透传', () => {
  const childCode = [
    "console.log('CHILD_RUN_AS_NODE=' + (process.env.ELECTRON_RUN_AS_NODE === undefined ? 'missing' : 'present'));",
    "console.log('CHILD_ARG=' + process.argv[1]);",
    'process.exit(7);',
  ].join(' ');
  const result = runRunner(['-e', childCode, 'x'], {
    ELECTRON_RUN_AS_NODE: '1',
    AWB_ELECTRON_BIN: NODE,
  });
  assert.equal(result.status, 7, output(result));
  assert.match(result.stdout, /CHILD_RUN_AS_NODE=missing/);
  assert.match(result.stdout, /CHILD_ARG=x/);
});

// ── 4. 真正启动的是 Electron，不是 Node ───────────────────────────────
test('run-electron: --version 输出 Electron 版本而不是 Node 版本', () => {
  const result = runRunner(['--version'], { ELECTRON_RUN_AS_NODE: '1' });
  assert.equal(result.status, 0, output(result));
  const lines = result.stdout.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  assert.ok(lines.includes(electronVersion), `输出里应有 ${electronVersion}\n${result.stdout}`);
  assert.ok(!lines.some((line) => /^v20\./.test(line)), '不应出现 Node 版本（v20.x）');
});

// ── 5. 缺 Electron 的错误可读 ──────────────────────────────────────────
test('run-electron: 缺 Electron 时退出码 1 并提示 npm install', () => {
  const result = runRunner(['--version'], {
    ELECTRON_RUN_AS_NODE: '1',
    AWB_ELECTRON_BIN: path.join(ROOT, '_tmp', 'missing-electron-for-test.exe'),
  });
  assert.equal(result.status, 1, output(result));
  const text = output(result);
  assert.match(text, /找不到 Electron/);
  assert.match(text, /npm install/);
});

// ── 6. start.cmd：清环境、透传参数、打印 Electron 版本 ─────────────────
test('start.cmd --check: 清掉继承变量、透传参数、版本是 Electron', () => {
  const result = runStartCmd(['--check', '--selftest', '--user-data-dir=userdata-selftest'], {
    ELECTRON_RUN_AS_NODE: '1',
    AWB_NO_PAUSE: '1',
  });
  assert.equal(result.status, 0, output(result));
  const text = output(result);
  assert.match(text, /ELECTRON_RUN_AS_NODE.*已清除/);
  assert.match(text, /--selftest/);
  assert.match(text, /--user-data-dir=userdata-selftest/);
  assert.ok(text.includes(electronVersion), `输出里应有 Electron 版本 ${electronVersion}\n${text}`);
});

// ── 7. start.cmd 失败可见且不阻塞 ─────────────────────────────────────
test('start.cmd: 缺 Electron 时打印 [失败] 并以非 0 退出（不 pause）', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-startcmd-'));
  try {
    fs.copyFileSync(START_CMD, path.join(tmp, 'start.cmd'));
    const result = runStartCmd(['--check'], { AWB_NO_PAUSE: '1' }, tmp);
    assert.equal(result.status, 1, output(result));
    const text = output(result);
    assert.match(text, /\[失败\]/);
    assert.match(text, /npm install/);
    assert.match(text, /没有找到 Electron/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('start.cmd: 正常启动分支透传参数，子进程看不到 ELECTRON_RUN_AS_NODE', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-startcmd-ok-'));
  try {
    const dist = path.join(tmp, 'node_modules', 'electron', 'dist');
    fs.mkdirSync(dist, { recursive: true });
    const exe = path.join(dist, 'electron.exe');
    try {
      fs.linkSync(process.execPath, exe);
    } catch {
      fs.copyFileSync(process.execPath, exe);
    }
    fs.copyFileSync(START_CMD, path.join(tmp, 'start.cmd'));
    fs.writeFileSync(
      path.join(tmp, 'package.json'),
      JSON.stringify({ name: 'fake-electron-for-test', main: 'fake.js' }),
      'utf8',
    );
    fs.writeFileSync(
      path.join(tmp, 'fake.js'),
      [
        "console.log('FAKE_ARGV=' + JSON.stringify(process.argv.slice(1)));",
        "console.log('FAKE_ENV=' + (process.env.ELECTRON_RUN_AS_NODE === undefined ? 'missing' : 'present'));",
      ].join('\n'),
      'utf8',
    );

    const result = runStartCmd(['--selftest', '--user-data-dir=userdata-selftest'], {
      ELECTRON_RUN_AS_NODE: '1',
      AWB_NO_PAUSE: '1',
    }, tmp);
    assert.equal(result.status, 0, output(result));
    const text = output(result);
    assert.match(text, /FAKE_ENV=missing/);
    assert.match(text, /--selftest/);
    assert.match(text, /--user-data-dir=userdata-selftest/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

test('start.cmd: 正常启动分支缺 Electron 时也可见地失败', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-startcmd-run-'));
  try {
    fs.copyFileSync(START_CMD, path.join(tmp, 'start.cmd'));
    const result = runStartCmd(['--selftest'], { AWB_NO_PAUSE: '1' }, tmp);
    assert.equal(result.status, 1, output(result));
    const text = output(result);
    assert.match(text, /\[失败\]/);
    assert.match(text, /没有找到 Electron/);
    assert.match(text, /npm install/);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});

// ── 8. 导出清单与新入口保持一致 ────────────────────────────────────────
test('export-open-source: 白名单和必需文件包含 scripts/run-electron.cjs', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'export-open-source.mjs'), 'utf8');
  assert.match(source, /'scripts\/run-electron\.cjs'/);
  assert.match(source, /REQUIRED_FILES[\s\S]*?run-electron\.cjs/);
});

// ── 9. 一键安装器随包分发，并且编码/换行适合 Windows ────────────────────
test('安装器：package.json 与导出白名单包含 install.ps1 / 安装PM工作台.cmd', () => {
  const installerFiles = ['install.ps1', '安装PM工作台.cmd'];
  const pkg = JSON.parse(fs.readFileSync(path.join(ROOT, 'package.json'), 'utf8'));
  for (const file of installerFiles) {
    assert.ok(pkg.files.includes(file), `package.json files 缺 ${file}`);
  }

  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'export-open-source.mjs'), 'utf8');
  for (const file of installerFiles) {
    assert.ok(source.includes(`'${file}'`), `导出白名单缺 ${file}`);
  }

  // PowerShell 5.1 按 ANSI 读取无 BOM 文件，中文必须靠 BOM 才能正确解析。
  const ps1 = fs.readFileSync(path.join(ROOT, 'install.ps1'));
  assert.equal(ps1.subarray(0, 3).toString('hex'), 'efbbbf', 'install.ps1 必须是 UTF-8 BOM');

  // cmd.exe 对 LF-only 批处理的多行块解析不可靠，必须 CRLF；BOM 会破坏首行。
  const cmd = fs.readFileSync(path.join(ROOT, '安装PM工作台.cmd'));
  assert.notEqual(cmd.subarray(0, 3).toString('hex'), 'efbbbf', '安装PM工作台.cmd 不能带 BOM');
  const cmdText = cmd.toString('utf8');
  assert.match(cmdText, /chcp 65001/i);
  assert.match(cmdText, /install\.ps1/);
  assert.ok(cmdText.includes('\r\n'), '安装PM工作台.cmd 必须使用 CRLF 换行');
  assert.equal(cmdText.replace(/\r\n/g, '').includes('\n'), false, '安装PM工作台.cmd 不能有裸 LF');
});

console.log('');
if (failures.length) {
  console.error(`SCRIPTS_FAILED ${failures.length}/${passed + failures.length}`);
  for (const failure of failures) console.error(`  - ${failure.name}`);
  process.exit(1);
}
console.log(`SCRIPTS_OK ${passed}/${passed}`);
