#!/usr/bin/env node
'use strict';
/**
 * e379 安装链路夹具（T-20261119-015112-968d）
 *
 * 覆盖：
 *   A1 install.ps1 安装链路静态项（镜像/重试/校验/缓存兜底/Move 重试/保 zip/快捷方式与预检提前/Bypass 提示/AWB_TEAM_ROOT/BOM）
 *   A2 bundle patch teamRoot 去写死
 *   A3 main.js：capability 探针接线 + dsh:pin-endpoint / dsh:capability IPC
 *   A4 preload：dshCapability / dshPin
 *   A5 界面：记住地址按钮 + 点击接线
 *   A6 src/dsh-capability.js 单测（成功/失败/无适配器 + 落盘/回读 + 摘要）
 *   A7 start.cmd 报错文案不再指向不存在的 npm
 *   A8 只读静态断言 + 临时目录写入（不碰真实 data/ 团队状态）
 *
 * 跑法：node scripts/test-e379-install-chain.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const results = [];
function ok(cond, name, detail) {
  results.push({ name, ok: Boolean(cond), detail: cond ? undefined : detail });
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (cond ? '' : ' :: ' + JSON.stringify(detail)));
  if (!cond) process.exitCode = 1;
}
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return ''; } };

(async () => {
  /* A1 install.ps1 */
  const inst = read('install.ps1');
  ok(inst.length > 1000, 'A1a install.ps1 可读', { bytes: inst.length });
  ok(inst.includes('ELECTRON_MIRROR') && inst.includes('npmmirror.com/mirrors/electron'), 'A1b Electron 默认镜像 npmmirror', {});
  ok(inst.includes('改用官方源重试一次'), 'A1c 镜像失败回退官方源重试', {});
  ok(inst.includes('electron-v33*.zip') || inst.includes('electron-v33'), 'A1d Electron 收尾校验带缓存 zip 兜底', {});
  ok(inst.includes('已经就位') || inst.includes('dist\\electron.exe') || inst.includes('path.txt'), 'A1e Electron 校验含 path.txt/exe 两项', {});
  ok(/Directory\]::Move\(/.test(inst) && /for \(\$attempt = 1; \$attempt -le 3; \$attempt\+\+\)/.test(inst) && /Start-Sleep -Milliseconds/.test(inst), 'A1f Directory.Move 三次重试', {});
  ok(inst.includes('Copy-Item -LiteralPath (Join-Path $source') , 'A1g Move 失败回退复制落盘', {});
  ok(inst.includes('KeepNodeZip'), 'A1h 失败时保留下载包（KeepNodeZip）', {});
  ok(inst.includes('提前创建桌面快捷方式'), 'A1i 快捷方式提前到依赖安装前', {});
  ok(inst.includes('start.cmd') && inst.includes('--check') && inst.indexOf('提前创建桌面快捷方式') < inst.indexOf("Invoke-LoggedCommand -Exe $tools.NpmExe"), 'A1j 依赖安装前先跑 start.cmd --check', {});
  ok(inst.includes('AWB_TEAM_ROOT'), 'A1k 安装器写入 AWB_TEAM_ROOT 用户环境变量', {});
  ok(inst.includes('-ExecutionPolicy Bypass'), 'A1l 执行策略提示', {});
  const instBytes = fs.readFileSync(path.join(ROOT, 'install.ps1'));
  ok(instBytes[0] === 0xEF && instBytes[1] === 0xBB && instBytes[2] === 0xBF, 'A1m install.ps1 保留 UTF-8 BOM（PowerShell 5.1 中文解析）', { first3: [...instBytes.slice(0, 3)] });

  /* A2 patch teamRoot */
  const patch = read('dsh-plugin/cordis.patch.yml');
  ok(patch.includes("teamRoot: !!js process.env.AWB_TEAM_ROOT || ''"), 'A2a teamRoot 默认值不再写死作者路径', {});
  ok(!/teamRoot:\s*[^#\n]*D:\/deepseek\/agile-workbench/.test(patch), 'A2b patch 的 teamRoot 配置行已无硬编码本机路径', {});

  /* A3 main.js */
  const main = read('src/main.js');
  ok(main.includes("require('./dsh-capability')"), 'A3a main.js 引入 dsh-capability', {});
  ok(main.includes("ipcMain.handle('dsh:capability'"), 'A3b IPC dsh:capability', {});
  ok(main.includes("ipcMain.handle('dsh:pin-endpoint'"), 'A3c IPC dsh:pin-endpoint', {});
  const pinBlock = main.slice(main.indexOf("ipcMain.handle('dsh:pin-endpoint'"), main.indexOf("ipcMain.handle('dsh:pin-endpoint'") + 1600);
  ok(/persistDshConfig\(baseUrl, \{ source: 'user', pinned: true \}\)/.test(pinBlock), 'A3d 一键 pin 写 source:user+pinned:true', {});
  ok(main.includes("runDshCapabilityProbe('status')"), 'A3e 首启/状态检查触发能力探针', {});

  /* A4 preload */
  const pre = read('src/preload.js');
  ok(pre.includes("ipcRenderer.invoke('dsh:capability')") && pre.includes("ipcRenderer.invoke('dsh:pin-endpoint')"), 'A4 preload 暴露 dshCapability/dshPin', {});

  /* A5 界面 */
  ok(read('src/renderer/index.html').includes('id="btn-dsh-pin"'), 'A5a 界面有「记住地址」按钮', {});
  ok(read('src/renderer/app.js').includes("$('#btn-dsh-pin')"), 'A5b 按钮已接线', {});

  /* A6 capability 模块单测 */
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e379-cap-'));
  try {
    const mod = require(path.join(ROOT, 'src', 'dsh-capability.js'));
    const okRec = await mod.probeDshCapability({ adapter: { listSessions: async () => [{ id: 'a' }, { id: 'b' }] }, dataDir: tmp, timeoutMs: 1000 });
    ok(okRec.ok === true && okRec.sessionsCount === 2 && okRec.httpStatus === 200 && okRec.method === 'session/list', 'A6a 探针成功：ok/count/httpStatus/method', okRec);
    const back = mod.readCapability(tmp);
    ok(back && back.ok === true && back.sessionsCount === 2, 'A6b 结果落盘 data/dsh-capability.json 并可回读', { back });
    ok(mod.capabilityPath(tmp).endsWith('dsh-capability.json'), 'A6c 落盘文件名正确', { p: mod.capabilityPath(tmp) });
    const badRec = await mod.probeDshCapability({ adapter: { listSessions: async () => { const e = new Error('DSH RPC session/list 失败：404'); e.httpStatus = 404; throw e; } }, dataDir: tmp, timeoutMs: 1000 });
    ok(badRec.ok === false && badRec.httpStatus === 404 && /404/.test(badRec.error || ''), 'A6d 探针失败：ok=false + httpStatus + error', badRec);
    const none = await mod.probeDshCapability({ adapter: null, dataDir: tmp });
    ok(none.ok === false && !!none.error, 'A6e 适配器未就绪也算可读失败', none);
    ok(mod.capabilityLine(okRec).includes('DSH 互通能力：有'), 'A6f 有能力的摘要文案', { line: mod.capabilityLine(okRec) });
    ok(mod.capabilityLine(badRec).includes('DSH 互通能力：无'), 'A6g 缺能力的摘要文案', { line: mod.capabilityLine(badRec) });
    const badJsonDir = path.join(tmp, 'bad');
    fs.mkdirSync(badJsonDir, { recursive: true });
    fs.writeFileSync(path.join(badJsonDir, 'dsh-capability.json'), '{not-json', 'utf8');
    ok(mod.readCapability(badJsonDir) === null, 'A6h 损坏文件回读为 null（不抛）', {});
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  /* A7 start.cmd 文案 */
  const startCmd = read('start.cmd');
  ok(startCmd.includes('重跑 安装PM工作台.cmd'), 'A7 start.cmd 排查建议指向安装器而非不存在的 npm', {});

  const pass = results.filter((r) => r.ok).length;
  console.log('\nE379_INSTALL_CHAIN ' + pass + '/' + results.length + (pass === results.length ? ' PASS' : ''));
})().catch((e) => { console.error('FIXTURE_FAILED ' + ((e && e.message) || e)); process.exitCode = 2; });
