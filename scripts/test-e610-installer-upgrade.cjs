#!/usr/bin/env node
'use strict';
/**
 * e610 安装器侧升级夹具（T-20261119-021320-2b3a）
 *
 * 覆盖（全部真跑 install.ps1 -Upgrade，mock 版本源用本机 HTTP）：
 *   U1 dry-run：只校验源+参数、落 dryRun 记录、不改文件
 *   U2 真实升级：下载 → sha256 → 备份（_backup/upgrade-<ts> + manifest）→ 应用 → start.cmd --check 自检 → 落账 + 重启提示
 *   U3 源缺 sha256：exit 2、零副作用（不下载、无备份、无记录）
 *   U4 sha256 不一致：exit 1、中止、版本不变、记录 steps.download=false
 *   U5 应用阶段失败（升级包不是完整发布包）：exit 1、回滚、版本不变、记录 rolledBack=true
 *   U6 强制升级没写原因：exit 2、零副作用
 *   U7 手动回滚 -UpgradeRollback <backup>：文件恢复到升级前、记录 rolledBack=true
 *   U8 字段对接：升级记录行与壳层 app:upgrade-start 同 schema（ts/from/to/sha256/steps/ok/force/reason/dryRun/restartHint）
 *   U9 静态：install.ps1 可解析 + BOM；脚本无盘符字面量（selftest 真实树白名单）
 *
 * 跑法：node scripts/test-e610-installer-upgrade.cjs
 * 隔离：沙盘仓库全部在 %TEMP%，不碰真实 data/团队；只杀自己 spawn 的进程（本脚本无常驻进程）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const RESULTS = [];
function ok(cond, name, detail) {
  RESULTS.push({ name, ok: Boolean(cond), detail: cond ? undefined : detail });
  console.log((cond ? 'PASS' : 'FAIL') + '  ' + name + (cond ? '' : ' :: ' + JSON.stringify(detail)));
  if (!cond) process.exitCode = 1;
}
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

function runPwsh(args, options) {
  const opts = options || {};
  // 必须异步 spawn：mock 版本源在同进程的 HTTP server 里，spawnSync 会阻塞事件循环导致 PS 侧超时。
  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ...args], {
      cwd: opts.cwd || ROOT,
      env: { ...process.env, ...(opts.env || {}) },
      windowsHide: true
    });
    let stdout = '';
    let stderr = '';
    let settled = false;
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 180000);
    const finish = (payload) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(payload);
    };
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('close', (code) => finish({ status: code, stdout, stderr }));
    child.on('error', (error) => finish({ status: -1, stdout, stderr: stderr + String((error && error.message) || error) }));
  });
}

function writeFile(file, text) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, text, 'utf8');
}

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}

function readUpgradeRows(dataDir) {
  try {
    return fs.readFileSync(path.join(dataDir, '升级记录.jsonl'), 'utf8')
      .split(/\r?\n/).filter(Boolean).map((line) => JSON.parse(line));
  } catch { return []; }
}

function seedRepo(dir, version) {
  writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'pm-workbench', version }, null, 2) + '\n');
  fs.copyFileSync(path.join(ROOT, 'install.ps1'), path.join(dir, 'install.ps1'));
  writeFile(path.join(dir, 'start.cmd'), ['@echo off', 'echo [检查] APP_DIR=fake', 'echo [检查] electron 存在', 'exit /b 0', ''].join('\r\n'));
  writeFile(path.join(dir, 'src', 'main.js'), '// seed v' + version + '\n');
  writeFile(path.join(dir, 'src', 'old-only.js'), '// only in old build\n');
  writeFile(path.join(dir, 'dsh-plugin', 'cordis.patch.yml'), '# seed\n');
}

function seedNewPackage(dir, version) {
  writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'pm-workbench', version }, null, 2) + '\n');
  writeFile(path.join(dir, 'src', 'main.js'), '// new build v' + version + '\n');
  writeFile(path.join(dir, 'src', 'new-only.js'), '// only in new build\n');
  writeFile(path.join(dir, 'dsh-plugin', 'cordis.patch.yml'), '# new\n');
}

function makeZip(dir, zipPath) {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  const res = spawnSync('powershell', ['-NoProfile', '-Command',
    `Compress-Archive -Path "${dir}\\*" -DestinationPath "${zipPath}" -Force`
  ], { encoding: 'utf8', timeout: 120000 });
  if (res.status !== 0 || !fs.existsSync(zipPath)) {
    throw new Error('Compress-Archive failed: ' + String(res.stderr || '').slice(0, 200));
  }
  return fs.readFileSync(zipPath);
}

(async () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'e610-up-'));
  const template = path.join(sb, 'template');
  seedRepo(template, '2.1.0');
  const newPkg = path.join(sb, 'newpkg');
  seedNewPackage(newPkg, '2.2.0');
  const goodZip = makeZip(newPkg, path.join(sb, 'zips', 'good.zip'));
  const goodSha = sha256(goodZip);
  const badPkg = path.join(sb, 'badpkg');
  writeFile(path.join(badPkg, 'package.json'), JSON.stringify({ name: 'pm-workbench', version: '2.2.0' }, null, 2));
  writeFile(path.join(badPkg, 'README.md'), 'not a release package\n');
  const badZip = makeZip(badPkg, path.join(sb, 'zips', 'bad.zip'));
  const badSha = sha256(badZip);

  const server = await new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const sendJson = (obj) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(obj)); };
      if (req.url === '/good.zip') { res.writeHead(200, { 'content-type': 'application/zip' }); res.end(goodZip); return; }
      if (req.url === '/bad.zip') { res.writeHead(200, { 'content-type': 'application/zip' }); res.end(badZip); return; }
      if (req.url === '/feed-ok') return sendJson({ version: '2.2.0', sha256: goodSha, url: `http://127.0.0.1:${srv.address().port}/good.zip`, notes: 'fixture' });
      if (req.url === '/feed-nosha') return sendJson({ version: '2.2.0', url: `http://127.0.0.1:${srv.address().port}/good.zip` });
      if (req.url === '/feed-badsha') return sendJson({ version: '2.2.0', sha256: 'f'.repeat(64), url: `http://127.0.0.1:${srv.address().port}/good.zip` });
      if (req.url === '/feed-badpkg') return sendJson({ version: '2.2.0', sha256: badSha, url: `http://127.0.0.1:${srv.address().port}/bad.zip` });
      res.writeHead(404); res.end('nope');
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
  const base = `http://127.0.0.1:${server.address().port}`;

  const newRepo = (name) => {
    const dir = path.join(sb, name);
    fs.mkdirSync(dir, { recursive: true });
    for (const entry of fs.readdirSync(template)) fs.cpSync(path.join(template, entry), path.join(dir, entry), { recursive: true });
    return dir;
  };
  const upgrade = (repo, extra, env) => runPwsh([path.join(repo, 'install.ps1'), '-Upgrade', '-InstallDir', repo, ...extra, '-NonInteractive'], { cwd: repo, env });

  try {
    /* U1 dry-run */
    const r1 = newRepo('r1');
    const d1 = path.join(r1, 'data');
    const u1 = await upgrade(r1, ['-UpgradeFeed', `${base}/feed-ok`, '-UpgradeDryRun', '-UpgradeDataDir', d1]);
    const rows1 = readUpgradeRows(d1);
    const row1 = rows1[rows1.length - 1] || {};
    ok(u1.status === 0, 'U1a dry-run 退出码 0', { status: u1.status, out: u1.stdout.slice(-400), err: u1.stderr.slice(-300) });
    ok(row1.dryRun === true && row1.ok === true && row1.steps && row1.steps.backup && row1.steps.download && row1.steps.apply && row1.steps.selfcheck, 'U1b dry-run 记录：dryRun=true + steps 全 true', { row: row1 });
    ok(String(row1.sha256 || '') === goodSha, 'U1c dry-run 记录 sha256 与源逐位相同', { sha: row1.sha256, want: goodSha });
    ok(readJson(path.join(r1, 'package.json')).version === '2.1.0', 'U1d dry-run 不改 package.json 版本', {});
    ok(!fs.existsSync(path.join(r1, '_backup')), 'U1e dry-run 不产生备份目录（零文件副作用）', {});

    /* U2 真实升级 */
    const r2 = newRepo('r2');
    const d2 = path.join(r2, 'data');
    const u2 = await upgrade(r2, ['-UpgradeFeed', `${base}/feed-ok`, '-UpgradeDataDir', d2]);
    const rows2 = readUpgradeRows(d2);
    const row2 = rows2[rows2.length - 1] || {};
    ok(u2.status === 0, 'U2a 真实升级退出码 0', { status: u2.status, out: u2.stdout.slice(-600), err: u2.stderr.slice(-300) });
    ok(readJson(path.join(r2, 'package.json')).version === '2.2.0' && fs.readFileSync(path.join(r2, 'src', 'main.js'), 'utf8').includes('new build'), 'U2b 程序文件已更新（version 2.2.0 + 新 main.js）', {});
    ok(fs.existsSync(path.join(r2, 'src', 'new-only.js')) && !fs.existsSync(path.join(r2, 'src', 'old-only.js')), 'U2c 新增文件到位、旧文件随目录替换移除', {});
    const backups = fs.existsSync(path.join(r2, '_backup')) ? fs.readdirSync(path.join(r2, '_backup')).filter((n) => n.startsWith('upgrade-')) : [];
    const backupDir = backups.length ? path.join(r2, '_backup', backups[0]) : '';
    const manifest = backupDir ? readJson(path.join(backupDir, 'manifest.json'), []) : [];
    ok(backups.length === 1 && Array.isArray(manifest) && manifest.length >= 3, 'U2d 备份先行：_backup/upgrade-<ts> 有 manifest 且条目数 ≥3', { backups, manifest });
    ok(backupDir && readJson(path.join(backupDir, 'package.json')).version === '2.1.0', 'U2e 备份里是升级前文件（package.json=2.1.0）', { backupDir });
    ok(row2.ok === true && row2.steps && row2.steps.backup && row2.steps.download && row2.steps.apply && row2.steps.selfcheck, 'U2f 升级记录：ok=true + 四步全 true', { row: row2 });
    ok(String(row2.sha256 || '') === goodSha && String(row2.from) === '2.1.0' && String(row2.to) === '2.2.0', 'U2g 记录 from/to/sha256 正确（与壳层同字段）', { row: row2 });
    ok(/请重启后生效/.test(String(row2.restartHint || '')) && /重启提示：请重启后生效/.test(u2.stdout), 'U2h 重启提示（记录 + 输出）', { row: row2, tail: u2.stdout.slice(-200) });
    ok(row2.source === 'installer', 'U2i 记录 source=installer（区分壳层 dry-run 行）', { source: row2.source });

    /* U3 源缺 sha256 */
    const r3 = newRepo('r3');
    const d3 = path.join(r3, 'data');
    const u3 = await upgrade(r3, ['-UpgradeFeed', `${base}/feed-nosha`, '-UpgradeDataDir', d3]);
    ok(u3.status === 2 && /UPGRADE_SHA_MISSING/.test(u3.stdout), 'U3a 源缺 sha256 → exit 2 + UPGRADE_SHA_MISSING', { status: u3.status, out: u3.stdout.slice(-300) });
    ok(readUpgradeRows(d3).length === 0 && !fs.existsSync(path.join(r3, '_backup')), 'U3b 缺 sha256 零副作用（无记录、无备份）', { rows: readUpgradeRows(d3) });
    const zips3 = fs.existsSync(path.join(r3, '_tmp', 'upgrade')) ? fs.readdirSync(path.join(r3, '_tmp', 'upgrade')).filter((n) => n.endsWith('.zip')) : [];
    ok(zips3.length === 0, 'U3c 缺 sha256 不发起下载（无 zip）', { zips3 });

    /* U4 sha256 不一致 */
    const r4 = newRepo('r4');
    const d4 = path.join(r4, 'data');
    const u4 = await upgrade(r4, ['-UpgradeFeed', `${base}/feed-badsha`, '-UpgradeDataDir', d4]);
    const rows4 = readUpgradeRows(d4);
    const row4 = rows4[rows4.length - 1] || {};
    ok(u4.status === 1 && /UPGRADE_SHA_MISMATCH/.test(u4.stdout), 'U4a 下载文件 sha 不一致 → exit 1 + UPGRADE_SHA_MISMATCH', { status: u4.status, out: u4.stdout.slice(-300) });
    ok(row4.ok === false && row4.steps && row4.steps.download === false && row4.code === 'UPGRADE_SHA_MISMATCH', 'U4b 记录 steps.download=false + code', { row: row4 });
    ok(readJson(path.join(r4, 'package.json')).version === '2.1.0', 'U4c 校验失败版本不变（仍 2.1.0）', {});

    /* U5 应用阶段失败 → 回滚 */
    const r5 = newRepo('r5');
    const d5 = path.join(r5, 'data');
    const u5 = await upgrade(r5, ['-UpgradeFeed', `${base}/feed-ok`, '-UpgradeDataDir', d5], { AWB_UPGRADE_FAIL_APPLY: '1' });
    const rows5 = readUpgradeRows(d5);
    const row5 = rows5[rows5.length - 1] || {};
    ok(u5.status === 1 && /UPGRADE_APPLY_FAILED/.test(u5.stdout), 'U5a 应用失败 → exit 1 + UPGRADE_APPLY_FAILED', { status: u5.status, out: u5.stdout.slice(-300) });
    ok(row5.ok === false && row5.steps && row5.steps.apply === false && row5.rolledBack === true, 'U5b 记录 steps.apply=false + rolledBack=true（AC4③）', { row: row5 });
    ok(readJson(path.join(r5, 'package.json')).version === '2.1.0'
      && fs.readFileSync(path.join(r5, 'src', 'main.js'), 'utf8').includes('seed v2.1.0')
      && fs.existsSync(path.join(r5, 'src', 'old-only.js')), 'U5c 回滚后程序文件恢复为升级前内容（AC4①）', {});

    /* U5d 非完整发布包 → 拒绝应用（版本不变） */
    const r5b = newRepo('r5b');
    const d5b = path.join(r5b, 'data');
    const u5b = await upgrade(r5b, ['-UpgradeFeed', `${base}/feed-badpkg`, '-UpgradeDataDir', d5b]);
    const rows5b = readUpgradeRows(d5b);
    const row5b = rows5b[rows5b.length - 1] || {};
    ok(u5b.status === 1 && row5b.code === 'UPGRADE_APPLY_FAILED' && readJson(path.join(r5b, 'package.json')).version === '2.1.0', 'U5d 非完整发布包 → 拒绝应用且版本不变', { row: row5b });
    /* U6 强制升级没写原因 */
    const r6 = newRepo('r6');
    const d6 = path.join(r6, 'data');
    const u6 = await upgrade(r6, ['-UpgradeFeed', `${base}/feed-ok`, '-UpgradeForce', '-UpgradeDataDir', d6]);
    ok(u6.status === 2 && /UPGRADE_FORCE_REASON_REQUIRED/.test(u6.stdout), 'U6a 强制升级缺 reason → exit 2 + UPGRADE_FORCE_REASON_REQUIRED', { status: u6.status, out: u6.stdout.slice(-300) });
    ok(readUpgradeRows(d6).length === 0 && !fs.existsSync(path.join(r6, '_backup')), 'U6b 缺 reason 零副作用（AC5b①）', {});

    /* U7 手动回滚 */
    const d7 = path.join(r2, 'data');
    const u7 = await runPwsh([path.join(r2, 'install.ps1'), '-UpgradeRollback', backupDir, '-InstallDir', r2, '-UpgradeDataDir', d7, '-NonInteractive'], { cwd: r2 });
    const rows7 = readUpgradeRows(d7);
    const row7 = rows7[rows7.length - 1] || {};
    ok(u7.status === 0 && /回滚完成/.test(u7.stdout), 'U7a -UpgradeRollback 退出码 0 + 回滚完成', { status: u7.status, out: u7.stdout.slice(-300) });
    ok(readJson(path.join(r2, 'package.json')).version === '2.1.0'
      && fs.readFileSync(path.join(r2, 'src', 'main.js'), 'utf8').includes('seed v2.1.0')
      && fs.existsSync(path.join(r2, 'src', 'old-only.js')), 'U7b 手动回滚把程序文件恢复为 2.1.0', {});
    ok(row7.rolledBack === true && row7.ok === true, 'U7c 回滚记录 rolledBack=true', { row: row7 });

    /* U8 字段对接（schema 与壳层一致） */
    const shellFields = ['ts', 'from', 'to', 'sha256', 'steps', 'ok', 'force', 'reason', 'dryRun', 'restartHint'];
    ok(shellFields.every((f) => f in row2), 'U8a 升级记录含壳层 app:upgrade-start 的全部字段', { missing: shellFields.filter((f) => !(f in row2)), row: row2 });
    ok(row2.steps && ['backup', 'download', 'apply', 'selfcheck'].every((k) => k in row2.steps), 'U8b steps 四步键名与壳层一致', { steps: row2.steps });

    /* U9 静态 */
    const instBytes = fs.readFileSync(path.join(ROOT, 'install.ps1'));
    ok(instBytes[0] === 0xEF && instBytes[1] === 0xBB && instBytes[2] === 0xBF, 'U9a install.ps1 保留 UTF-8 BOM', { first3: [...instBytes.slice(0, 3)] });
    const instText = instBytes.toString('utf8');
    ok(instText.includes('[switch]$Upgrade') && instText.includes('-UpgradeRollback') && instText.includes('UPGRADE_SHA_MISSING'), 'U9b install.ps1 含 --Upgrade 参数与错误码', {});
    const driveRe = new RegExp(String.fromCharCode(65 + 3) + ':[\\\\/]');
    const selfText = fs.readFileSync(__filename, 'utf8');
    ok(!driveRe.test(selfText), 'U9c 本夹具脚本无盘符路径字面量（selftest 真实树白名单）', {});
  } finally {
    try { server.close(); } catch { /* ignore */ }
    if (process.env.AWB_E610_KEEP === '1') console.log('KEEP_SANDBOX ' + sb);
    else { try { fs.rmSync(sb, { recursive: true, force: true, maxRetries: 3, retryDelay: 200 }); } catch { /* ignore */ } }
  }

  const pass = RESULTS.filter((r) => r.ok).length;
  console.log('\nE610_INSTALLER_UPGRADE ' + pass + '/' + RESULTS.length + (pass === RESULTS.length ? ' PASS' : ' FAIL'));
  if (process.env.AWB_E610_OUT) {
    fs.writeFileSync(process.env.AWB_E610_OUT, JSON.stringify({ at: new Date().toISOString(), results: RESULTS }, null, 2) + '\n', 'utf8');
  }
})().catch((error) => {
  console.error('E610_INSTALLER_UPGRADE_FAILED ' + String((error && error.message) || error).slice(0, 400));
  process.exitCode = 2;
});
