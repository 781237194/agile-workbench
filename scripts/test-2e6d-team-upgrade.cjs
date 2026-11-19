#!/usr/bin/env node
'use strict';
/**
 * test-2e6d-team-upgrade.cjs —— P0 B-20261119-194157-2e6d 夹具
 * 「升级包必须带 团队/（工具/模板/角色/协议/skill + 宪法/流程/项目铁律）」+ 不覆盖用户数据
 *
 * 用例：
 *   T1 清单同源：install.ps1 的 $relatives 与 scripts/upgrade-package-manifest.cjs 逐项一致；
 *      并断言「用户数据双保险」$isUserData 存在（团队/状态 等即使被写进白名单也会被跳过）。
 *   T2 打包产物：真跑 scripts/build-upgrade-zip.cjs --source <仓库根> → 包里有 团队/工具/lib/gates.mjs
 *      等关键条目；不含 团队/状态、团队/项目、团队/产出、团队/日志、项目/、data/、node_modules。
 *   T3 真实升级（含 团队/）：install.ps1 -Upgrade 真跑（本地 HTTP mock 版本源）→
 *      团队/工具/lib/gates.mjs 被替换（新哈希）、团队/模板 新增文件落盘、团队/状态 与 项目/ sha 不变、
 *      升级记录 ok=true steps.apply=true。
 *   T4 老包兼容：升级包不含 团队/ 时仍能升级成功（不回归历史包），团队/工具 保持旧版。
 *   T5 应用失败回滚：AWB_UPGRADE_FAIL_APPLY=1 → exit 1、rolledBack=true、gates.mjs 恢复旧哈希、
 *      团队/状态 与 项目/ 仍零改动。
 *
 * 隔离：沙盘仓库/数据/压缩包全在 %TEMP%；mock HTTP 只监听 127.0.0.1；不碰真实 团队/状态、不杀任何进程。
 * 跑法：node scripts/test-2e6d-team-upgrade.cjs [--out <证据目录>]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const http = require('node:http');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const manifest = require('./upgrade-package-manifest.cjs');
const OUT = (() => {
  const i = process.argv.indexOf('--out');
  return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-2e6d');
})();
const rows = [];
function check(name, ok, detail) {
  let text = ''; try { text = JSON.stringify(detail === undefined ? null : detail); } catch { text = String(detail); }
  rows.push({ name, ok: Boolean(ok), detail: ok ? undefined : text });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : ' :: ' + text.slice(0, 700)));
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const shaFile = (f) => { try { return sha(fs.readFileSync(f)); } catch { return '-'; } };
function writeFile(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); }
function readJson(file, fallback) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; } }

function runPwsh(args, options = {}) {
  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', ...args], {
      cwd: options.cwd || ROOT,
      env: { ...process.env, ...(options.env || {}) },
      windowsHide: true,
    });
    let stdout = ''; let stderr = ''; let settled = false;
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 240000);
    const finish = (payload) => { if (settled) return; settled = true; clearTimeout(timer); resolve(payload); };
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('close', (code) => finish({ status: code, stdout, stderr }));
    child.on('error', (error) => finish({ status: -1, stdout, stderr: stderr + String((error && error.message) || error) }));
  });
}

function makeZip(dir, zipPath) {
  fs.mkdirSync(path.dirname(zipPath), { recursive: true });
  const res = spawnSync('powershell', ['-NoProfile', '-Command', `Compress-Archive -Path '${dir}\\*' -DestinationPath '${zipPath}' -Force`], { encoding: 'utf8', timeout: 180000 });
  if (res.status !== 0 || !fs.existsSync(zipPath)) throw new Error('Compress-Archive 失败：' + String(res.stderr || '').slice(0, 200));
  return fs.readFileSync(zipPath);
}

function seedSandboxRepo(dir, { gatesText, version }) {
  writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'pm-workbench', version }, null, 2) + '\n');
  writeFile(path.join(dir, 'start.cmd'), ['@echo off', 'echo [检查] APP_DIR=fake', 'echo [检查] electron 存在', 'exit /b 0', ''].join('\r\n'));
  writeFile(path.join(dir, 'src', 'main.js'), '// sandbox app ' + version + '\n');
  fs.copyFileSync(path.join(ROOT, 'install.ps1'), path.join(dir, 'install.ps1'));
  writeFile(path.join(dir, '团队', '工具', 'lib', 'gates.mjs'), gatesText);
  writeFile(path.join(dir, '团队', '状态', '团队.json'), JSON.stringify({ sentinel: 'keep-me', members: [] }, null, 2));
  writeFile(path.join(dir, '团队', '产出', 'x.md'), 'sentinel team output\n');
  writeFile(path.join(dir, '项目', '样例', '角色卡.md'), 'sentinel role card\n');
}

function seedNewPackage(dir, version) {
  writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'pm-workbench', version }, null, 2) + '\n');
  writeFile(path.join(dir, 'src', 'main.js'), '// new build ' + version + '\n');
  writeFile(path.join(dir, '团队', '工具', 'lib', 'gates.mjs'), '// new gates ' + version + '\n');
  writeFile(path.join(dir, '团队', '模板', '角色卡模板版本.json'), JSON.stringify({ schema: 1, roles: {} }, null, 2) + '\n');
  writeFile(path.join(dir, '团队', '团队宪法.md'), '# 宪法（升级包新版）\n');
  // B-38ce：团队根三份 + 团队工具入口是 boot 硬依赖，新守卫要求包内必须齐全。
  writeFile(path.join(dir, '团队', '流程.md'), '# 流程（升级包新版）\n');
  writeFile(path.join(dir, '团队', '项目铁律.md'), '# 项目铁律（升级包新版）\n');
  writeFile(path.join(dir, '团队', '工具', 'team.mjs'), '// team.mjs（升级包新版）\n');
  writeFile(path.join(dir, '发版记录.md'), '# 发版记录\n');
}

function seedLegacyPackage(dir, version) {
  writeFile(path.join(dir, 'package.json'), JSON.stringify({ name: 'pm-workbench', version }, null, 2) + '\n');
  writeFile(path.join(dir, 'src', 'main.js'), '// legacy build ' + version + '\n');
}

(async () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-2e6d-'));
  const server = await new Promise((resolve) => {
    const srv = http.createServer((req, res) => {
      const file = path.join(sb, 'zips', String(req.url || '').replace(/^\//, ''));
      if (fs.existsSync(file)) { res.writeHead(200, { 'content-type': 'application/zip' }); res.end(fs.readFileSync(file)); return; }
      res.writeHead(404); res.end('nope');
    });
    srv.listen(0, '127.0.0.1', () => resolve(srv));
  });
  const port = server.address().port;
  try {
    // ── T1 清单同源 ─────────────────────────────────────────────────────
    const installText = fs.readFileSync(path.join(ROOT, 'install.ps1'), 'utf8');
    const relativesMatch = installText.match(/\$relatives\s*=\s*@\(([\s\S]*?)\)/);
    const psRelatives = relativesMatch
      ? [...relativesMatch[1].matchAll(/'([^']+)'/g)].map((m) => m[1].replace(/\\/g, '/'))
      : [];
    const manifestAll = [...manifest.UPGRADE_TREE, ...manifest.UPGRADE_FILES].sort();
    const psSorted = [...new Set(psRelatives)].sort();
    check('T1 install.ps1 $relatives 与 upgrade-package-manifest.cjs 逐项一致（含 团队/ 五目录 + 三份根规则）',
      JSON.stringify(psSorted) === JSON.stringify(manifestAll), { ps: psSorted, manifest: manifestAll });
    check('T1b install.ps1 有「用户数据双保险」$isUserData（即使误写进白名单也跳过）',
      /\$isUserData\s*=/.test(installText) && /\$isUserData\s+\$rel/.test(installText), null);
    check('T1c 三个团队根规则文件都在清单里（宪法/流程/项目铁律）',
      ['团队/团队宪法.md', '团队/流程.md', '团队/项目铁律.md'].every((p) => manifestAll.includes(p)), manifestAll);

    // ── T2 打包产物（真跑构建脚本）───────────────────────────────────────
    const pkgZip = path.join(sb, 'zips', 'built.zip');
    const build = spawnSync(process.execPath, [path.join(ROOT, 'scripts', 'build-upgrade-zip.cjs'), '--source', ROOT, '--out', pkgZip], { encoding: 'utf8', timeout: 600000, maxBuffer: 32 * 1024 * 1024 });
    // 用中央目录解析（tar -tf 在 Windows 会把中文名按本地代码页解成乱码，不能拿来比对）
    const names = fs.existsSync(pkgZip)
      ? manifest.zipEntryNames(fs.readFileSync(pkgZip)).map((n) => n.replace(/\\/g, '/').replace(/^[^/]+\//, ''))
      : [];
    const has = (rel) => names.includes(rel);
    const leaked = names.filter((rel) => rel && !rel.endsWith('/') && manifest.isNeverPackaged(rel));
    check('T2 构建脚本产出升级包且退出码 0（含 团队/ 条目）', build.status === 0 && fs.existsSync(pkgZip), String(build.stderr || build.stdout).slice(0, 500));
    check('T2b 包内含关键团队条目（gates.mjs / rolecard-sync.mjs / team.mjs / 宪法 / 流程 / 铁律）',
      manifest.PACKAGE_ASSERT_ENTRIES.every((rel) => has(rel)), manifest.PACKAGE_ASSERT_ENTRIES.filter((rel) => !has(rel)));
    check('T2c 包内不含用户数据/运行时目录（团队/状态|项目|产出|日志|看板、项目/、data/、node_modules）', leaked.length === 0, leaked.slice(0, 8));

    // ── T3 真实升级（含 团队/）───────────────────────────────────────────
    const repo = path.join(sb, 'app');
    seedSandboxRepo(repo, { gatesText: '// old gates 2.1.5\n', version: '2.1.5' });
    const dataDir = path.join(sb, 'data');
    const gatesOld = shaFile(path.join(repo, '团队', '工具', 'lib', 'gates.mjs'));
    const rosterSha = shaFile(path.join(repo, '团队', '状态', '团队.json'));
    const roleCardSha = shaFile(path.join(repo, '项目', '样例', '角色卡.md'));
    const teamOutSha = shaFile(path.join(repo, '团队', '产出', 'x.md'));
    const pkgDir = path.join(sb, 'newpkg', 'agile-workbench-v2.2.0');
    seedNewPackage(pkgDir, '2.2.0');
    const zipBuf = makeZip(path.join(sb, 'newpkg'), path.join(sb, 'zips', 'team.zip'));
    const up = await runPwsh([
      path.join(ROOT, 'install.ps1'), '-Upgrade', '-InstallDir', repo, '-UpgradeDataDir', dataDir,
      '-UpgradeVersion', '2.2.0', '-UpgradeSha256', sha(zipBuf), '-UpgradeUrl', `http://127.0.0.1:${port}/team.zip`,
    ]);
    const rowsUp = (() => { try { return fs.readFileSync(path.join(dataDir, '升级记录.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } })();
    const last = rowsUp[rowsUp.length - 1] || null;
    check('T3 升级成功（exit 0 + 记录 ok=true + steps.apply=true）',
      up.status === 0 && Boolean(last && last.ok === true && last.steps && last.steps.apply === true),
      { status: up.status, last: last && { ok: last.ok, steps: last.steps, code: last.code }, tail: String(up.stdout || '').slice(-400) });
    const gatesNew = shaFile(path.join(repo, '团队', '工具', 'lib', 'gates.mjs'));
    check('T3b 团队/工具/lib/gates.mjs 已被新包替换（哈希变化且等于新版）',
      gatesNew !== gatesOld && gatesNew === sha('// new gates 2.2.0\n'), { gatesOld, gatesNew });
    check('T3c 团队/模板 新增文件落盘（角色卡模板版本.json）',
      fs.existsSync(path.join(repo, '团队', '模板', '角色卡模板版本.json')), null);
    check('T3d 用户数据零覆盖：团队/状态/团队.json、项目/样例/角色卡.md、团队/产出/x.md sha 全不变',
      shaFile(path.join(repo, '团队', '状态', '团队.json')) === rosterSha
      && shaFile(path.join(repo, '项目', '样例', '角色卡.md')) === roleCardSha
      && shaFile(path.join(repo, '团队', '产出', 'x.md')) === teamOutSha,
      { roster: [rosterSha, shaFile(path.join(repo, '团队', '状态', '团队.json'))] });

    // ── T4 老包兼容（不含 团队/）─────────────────────────────────────────
    const repo2 = path.join(sb, 'app2');
    seedSandboxRepo(repo2, { gatesText: '// old gates 2.1.5\n', version: '2.1.5' });
    const legacyDir = path.join(sb, 'legacy', 'agile-workbench-v2.2.1');
    seedLegacyPackage(legacyDir, '2.2.1');
    const legacyZip = makeZip(path.join(sb, 'legacy'), path.join(sb, 'zips', 'legacy.zip'));
    const up2 = await runPwsh([
      path.join(ROOT, 'install.ps1'), '-Upgrade', '-InstallDir', repo2, '-UpgradeDataDir', path.join(sb, 'data2'),
      '-UpgradeVersion', '2.2.1', '-UpgradeSha256', sha(legacyZip), '-UpgradeUrl', `http://127.0.0.1:${port}/legacy.zip`,
    ]);
    // B-38ce：老包缺团队根三份 → 必须拒绝（包不完整），并且安装目录保持原样。
    check('T4 老包（不含 团队/）被拒：exit 非 0 + 旧 gates 保持 + 文案点名缺规则文件',
      up2.status !== 0 && shaFile(path.join(repo2, '团队', '工具', 'lib', 'gates.mjs')) === sha('// old gates 2.1.5\n')
      && /升级包不完整|必需规则文件/.test(`${up2.stdout || ''}${up2.stderr || ''}`),
      { status: up2.status, tail: String(`${up2.stdout || ''}${up2.stderr || ''}`).slice(-400) });

    // ── T5 应用失败回滚（团队文件恢复）────────────────────────────────────
    const repo3 = path.join(sb, 'app3');
    seedSandboxRepo(repo3, { gatesText: '// old gates 2.1.5\n', version: '2.1.5' });
    const roster3 = shaFile(path.join(repo3, '团队', '状态', '团队.json'));
    const up3 = await runPwsh([
      path.join(ROOT, 'install.ps1'), '-Upgrade', '-InstallDir', repo3, '-UpgradeDataDir', path.join(sb, 'data3'),
      '-UpgradeVersion', '2.2.0', '-UpgradeSha256', sha(zipBuf), '-UpgradeUrl', `http://127.0.0.1:${port}/team.zip`,
    ], { env: { AWB_UPGRADE_FAIL_APPLY: '1' } });
    const rows3 = (() => { try { return fs.readFileSync(path.join(sb, 'data3', '升级记录.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => JSON.parse(l)); } catch { return []; } })();
    const last3 = rows3[rows3.length - 1] || null;
    check('T5 应用阶段失败 → exit 1 + rolledBack=true + gates.mjs 恢复旧哈希 + 团队/状态 不变',
      up3.status === 1 && Boolean(last3 && last3.rolledBack === true) && shaFile(path.join(repo3, '团队', '工具', 'lib', 'gates.mjs')) === sha('// old gates 2.1.5\n')
      && shaFile(path.join(repo3, '团队', '状态', '团队.json')) === roster3,
      { status: up3.status, last: last3 && { code: last3.code, rolledBack: last3.rolledBack } });
    // ── T6 注入删宪法：应用阶段拒绝且安装目录恢复 ─────────────────────
    const repo4 = path.join(sb, 'app4');
    seedSandboxRepo(repo4, { gatesText: '// old gates 2.1.5\n', version: '2.1.5' });
    const gate4Before = shaFile(path.join(repo4, '团队', '工具', 'lib', 'gates.mjs'));
    const pkgDir4 = path.join(sb, 'pkg-missing-constitution', 'agile-workbench-v2.2.0');
    seedNewPackage(pkgDir4, '2.2.0');
    // 注入：把团队宪法从包里删掉（模拟「包是坏的/漏了宪法」）
    fs.rmSync(path.join(pkgDir4, '团队', '团队宪法.md'), { force: true });
    const zip4 = makeZip(path.dirname(pkgDir4), path.join(sb, 'zips', 'missing-constitution.zip'));
    const up4 = await runPwsh([
      path.join(ROOT, 'install.ps1'), '-Upgrade', '-InstallDir', repo4, '-UpgradeDataDir', path.join(sb, 'data4'),
      '-UpgradeVersion', '2.2.0', '-UpgradeSha256', sha(zip4), '-UpgradeUrl', `http://127.0.0.1:${port}/missing-constitution.zip`,
    ]);
    check('T6 包内缺团队宪法 → 拒绝（exit 非 0）+ 文案点名 + 安装目录 gates 恢复旧哈希',
      up4.status !== 0 && /团队宪法/.test(`${up4.stdout || ''}${up4.stderr || ''}`)
      && shaFile(path.join(repo4, '团队', '工具', 'lib', 'gates.mjs')) === gate4Before,
      { status: up4.status, gate: [gate4Before, shaFile(path.join(repo4, '团队', '工具', 'lib', 'gates.mjs'))], tail: String(`${up4.stdout || ''}${up4.stderr || ''}`).slice(-400) });

    // ── T7 正常升级：团队根三份 + team.mjs 与包内 sha 一致 ─────────────
    const reqRels = ['团队/团队宪法.md', '团队/流程.md', '团队/项目铁律.md', '团队/工具/team.mjs'];
    const pkgDir7 = path.join(sb, 'pkg-full', 'agile-workbench-v2.2.0');
    seedNewPackage(pkgDir7, '2.2.0');
    const zip7 = makeZip(path.dirname(pkgDir7), path.join(sb, 'zips', 'full.zip'));
    const repo7 = path.join(sb, 'app7');
    seedSandboxRepo(repo7, { gatesText: '// old gates 2.1.5\n', version: '2.1.5' });
    const up7 = await runPwsh([
      path.join(ROOT, 'install.ps1'), '-Upgrade', '-InstallDir', repo7, '-UpgradeDataDir', path.join(sb, 'data7'),
      '-UpgradeVersion', '2.2.0', '-UpgradeSha256', sha(zip7), '-UpgradeUrl', `http://127.0.0.1:${port}/full.zip`,
    ]);
    const reqMismatch = reqRels.filter((rel) => {
      const a = path.join(pkgDir7, rel.split('/').join(path.sep));
      const b = path.join(repo7, rel.split('/').join(path.sep));
      return shaFile(a) !== shaFile(b);
    });
    check('T7 正常升级成功（exit 0）且团队根三份 + team.mjs 与包内 sha 一致',
      up7.status === 0 && reqMismatch.length === 0,
      { status: up7.status, reqMismatch, tail: String(`${up7.stdout || ""}${up7.stderr || ""}`).slice(-300) });

  } finally {
    try { server.close(); } catch { /* ignore */ }
    try { fs.rmSync(sb, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const pass = rows.filter((r) => r.ok).length;
  const fail = rows.length - pass;
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'test-2e6d-team-upgrade.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      head: (() => { try { return spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(); } catch { return ''; } })(),
      task: 'B-20261119-194157-2e6d', pass, fail, total: rows.length, rows,
    }, null, 2), 'utf8');
  } catch { /* ignore */ }
  console.log(`\n${pass}/${rows.length} PASS${fail ? ` · ${fail} FAIL` : ''}`);
  process.exit(fail ? 1 : 0);
})();
