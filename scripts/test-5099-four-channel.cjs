#!/usr/bin/env node
'use strict';
/**
 * test-5099-four-channel.cjs —— R-20261120-183412-5099 四渠道同源 / 版本单源 / 漂移扫描 夹具
 *
 * A. drift-scan：emit → baseline → --strict 全绿；注入新字面量 → extra=1、exit 1；
 *    删清单一行 → --strict missing=1、exit 1；非 strict exit 0。
 * B. 假 asset（同 size 不同内容）→ assetVerdict 必须红（GITHUB_ASSET_SHA_MISMATCH）；
 *    同字节 → 绿；大小不符 → GITHUB_ASSET_SIZE_MISMATCH。
 * C. 四渠道同源：sha 不一致 → CHANNEL_SHA_MISMATCH；缺一方 → CHANNEL_SHA_MISSING；全同 → 绿。
 * D. npm payload 声明：声明与包 sha 不一致 → APP_PAYLOAD_SHA_MISMATCH；缺失 → APP_PAYLOAD_MISSING。
 * E. 版本单源：真实仓库 13/13 全绿；沙盘「app 2.1.15 / plugin 2.2.14」→ PLUGIN_VERSION_MISMATCH。
 *
 * 用法：node scripts/test-5099-four-channel.cjs [--json]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');
const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 800)}`);
}
function sha256(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function run(args, opts = {}) {
  return spawnSync(process.execPath, args, { cwd: opts.cwd || ROOT, encoding: 'utf8', env: { ...process.env, ...(opts.env || {}) } });
}
function mkSandbox(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  fs.mkdirSync(path.join(dir, 'scripts'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'dsh-plugin', 'pm-workbench-dsh'), { recursive: true });
  fs.mkdirSync(path.join(dir, 'src'), { recursive: true });
  fs.mkdirSync(path.join(dir, '发布'), { recursive: true });
  fs.writeFileSync(path.join(dir, 'install.ps1'), "$relatives = @('src')\n", 'utf8');
  fs.writeFileSync(path.join(dir, 'scripts', 'upgrade-package-manifest.cjs'),
    "const UPGRADE_TREE = ['src'];\nconst UPGRADE_FILES = ['package.json'];\nconst NEVER_PACKAGE = ['项目'];\nmodule.exports = { UPGRADE_TREE, UPGRADE_FILES, NEVER_PACKAGE };\n", 'utf8');
  fs.writeFileSync(path.join(dir, 'dsh-plugin', 'pm-workbench-dsh', 'index.js'),
    "const INSTALLER_SCRIPT_URL = 'https://example.invalid/@v2.2.14/install.ps1'\n", 'utf8');
  fs.writeFileSync(path.join(dir, 'src', 'placeholder.js'), '// nothing\n', 'utf8');
  return dir;
}

function driftSection() {
  const box = mkSandbox('5099-drift-');
  const base = path.join(box, 'baseline.json');
  const emit = run([path.join(ROOT, 'scripts', 'release-manifest-drift-scan.cjs'), '--root', box, '--emit-baseline', base, '--json']);
  check('A1 emit 基线成功（exit 0，基线含 hits）', emit.status === 0 && (() => { try { return Array.isArray(JSON.parse(fs.readFileSync(base, 'utf8')).hits); } catch { return false; } })(), { status: emit.status, stderr: String(emit.stderr || '').slice(0, 300) });
  const strict = run([path.join(ROOT, 'scripts', 'release-manifest-drift-scan.cjs'), '--root', box, '--baseline', base, '--strict', '--json']);
  const strictJson = (() => { try { return JSON.parse(strict.stdout); } catch { return null; } })();
  check('A2 emit→baseline→--strict 全绿（extra=0 missing=0、exit 0）',
    strict.status === 0 && strictJson && strictJson.drift.extra.length === 0 && strictJson.drift.missing.length === 0,
    { status: strict.status, drift: strictJson && strictJson.drift });

  fs.writeFileSync(path.join(box, 'scripts', 'injected.cjs'), "// 新增字面量：2.2.9 必须被抓\n", 'utf8');
  const injected = run([path.join(ROOT, 'scripts', 'release-manifest-drift-scan.cjs'), '--root', box, '--baseline', base, '--json']);
  const injJson = (() => { try { return JSON.parse(injected.stdout); } catch { return null; } })();
  const injExtra = (injJson && injJson.drift.extra) || [];
  check('A3 注入 2.2.9 字面量 → extra=1、exit 1、给出 file:line',
    injected.status === 1 && injExtra.length === 1
      && /injected\.cjs$/.test(String(injExtra[0].file)) && Number(injExtra[0].line) === 1,
    { status: injected.status, extra: injExtra });
  fs.rmSync(path.join(box, 'scripts', 'injected.cjs'), { force: true });

  // 删清单定义一行 → strict 报 missing，非 strict 放行。
  const manifestPath = path.join(box, 'scripts', 'upgrade-package-manifest.cjs');
  const original = fs.readFileSync(manifestPath, 'utf8');
  fs.writeFileSync(manifestPath, original.replace("const NEVER_PACKAGE = ['项目'];\n", ''), 'utf8');
  const missingStrict = run([path.join(ROOT, 'scripts', 'release-manifest-drift-scan.cjs'), '--root', box, '--baseline', base, '--strict', '--json']);
  const missingJson = (() => { try { return JSON.parse(missingStrict.stdout); } catch { return null; } })();
  check('A4 删清单一行 → --strict missing=1、exit 1', missingStrict.status === 1 && missingJson && missingJson.drift.missing.length === 1, { status: missingStrict.status, missing: missingJson && missingJson.drift.missing });
  const missingLoose = run([path.join(ROOT, 'scripts', 'release-manifest-drift-scan.cjs'), '--root', box, '--baseline', base, '--json']);
  check('A5 同上但非 strict → exit 0（只报 extra）', missingLoose.status === 0, { status: missingLoose.status });
  fs.writeFileSync(manifestPath, original, 'utf8');
  fs.rmSync(box, { recursive: true, force: true });
}

function verdictSection() {
  const lib = require(path.join(ROOT, 'scripts', 'release-verify-lib.cjs'));
  const real = Buffer.from('A'.repeat(4096));
  const fakeSameSize = Buffer.from('B'.repeat(4096));
  check('B1 假 asset：同 size 不同内容 → 必红（GITHUB_ASSET_SHA_MISMATCH）',
    lib.assetVerdict({ localBuf: real, assetBuf: fakeSameSize }).code === 'GITHUB_ASSET_SHA_MISMATCH',
    lib.assetVerdict({ localBuf: real, assetBuf: fakeSameSize }));
  check('B2 真 asset（同字节）→ 绿', lib.assetVerdict({ localBuf: real, assetBuf: Buffer.from(real) }).ok === true, {});
  check('B3 asset 缺失 → GITHUB_ASSET_MISSING', lib.assetVerdict({ localBuf: real, assetBuf: null }).code === 'GITHUB_ASSET_MISSING', {});
  const short = Buffer.from('A'.repeat(1024));
  check('B4 大小不符 → GITHUB_ASSET_SIZE_MISMATCH', lib.assetVerdict({ localBuf: real, assetBuf: short }).code === 'GITHUB_ASSET_SIZE_MISMATCH', {});

  const s1 = sha256(real);
  check('C1 四渠道全同 → 绿', lib.fourWayVerdict({ localSha: s1, feedSha: s1, githubSha: s1, cdnSha: s1 }).ok === true, {});
  check('C2 GitHub 与本地不同 → CHANNEL_SHA_MISMATCH', lib.fourWayVerdict({ localSha: s1, feedSha: s1, githubSha: sha256(fakeSameSize), cdnSha: s1 }).code === 'CHANNEL_SHA_MISMATCH', {});
  check('C3 CDN skipped 仍按参与方判定 → 绿', lib.fourWayVerdict({ localSha: s1, feedSha: s1, githubSha: s1, cdnSha: 'skipped' }).ok === true, {});
  check('C4 一方缺失 → CHANNEL_SHA_MISSING', lib.fourWayVerdict({ localSha: s1, feedSha: s1, githubSha: '', cdnSha: s1 }).code === 'CHANNEL_SHA_MISSING', {});

  check('D1 npm 声明 sha 与包不一致 → APP_PAYLOAD_SHA_MISMATCH',
    lib.payloadVerdict({ localDeclared: s1, publishedDeclared: sha256(fakeSameSize), localSha: s1 }).code === 'APP_PAYLOAD_SHA_MISMATCH', {});
  check('D2 npm 未声明 payload → APP_PAYLOAD_MISSING',
    lib.payloadVerdict({ localDeclared: '', publishedDeclared: '', localSha: s1 }).code === 'APP_PAYLOAD_MISSING', {});
  check('D3 声明一致 → 绿', lib.payloadVerdict({ localDeclared: s1, publishedDeclared: s1, localSha: s1 }).ok === true, {});
}

function versionSection() {
  const source = require(path.join(ROOT, 'scripts', 'version-single-source.cjs'));
  const real = source.checkVersionConsistency({ root: ROOT });
  check('E1 真实仓库版本单源六门全绿（' + real.rows.length + ' 项）', real.ok === true, { rows: real.rows.filter((r) => !r.ok) });
  check('E2 映射：app 2.1.14 → plugin 2.2.14、逆向一致、tag v2.1.14',
    source.appToPlugin('2.1.14') === '2.2.14' && source.pluginToApp('2.2.14') === '2.1.14' && source.tagForApp('2.1.14') === 'v2.1.14', {});

  // 沙盘：app 2.1.15 / plugin 2.2.14（映射错位）+ payload 声明仍指旧 sha → 必须红
  const box = mkSandbox('5099-version-');
  const zip = Buffer.from('PK-FAKE-ZIP-BYTES');
  fs.writeFileSync(path.join(box, '发布', 'pm-workbench-2.1.15.zip'), zip);
  fs.writeFileSync(path.join(box, 'package.json'), JSON.stringify({ name: 'pm-workbench', version: '2.1.15' }, null, 2));
  fs.writeFileSync(path.join(box, 'dsh-plugin', 'package.json'), JSON.stringify({ name: 'dsh-agile-workbench', version: '2.2.14', pmWorkbenchPayload: { appVersion: '2.1.14', sha256: sha256(zip) } }, null, 2));
  fs.writeFileSync(path.join(box, '发布', '版本信息.json'), JSON.stringify({ version: '2.1.15', sha256: sha256(zip), size: zip.length }, null, 2));
  fs.writeFileSync(path.join(box, '发布', '版本历史.jsonl'), JSON.stringify({ version: '2.1.15', sha256: sha256(zip) }) + '\n');
  const bad = source.checkVersionConsistency({ root: box });
  const codes = bad.rows.filter((r) => !r.ok).map((r) => r.code);
  check('E2b 同 minor 内 patch 递增允许（PM 02:23 放宽）：app 2.1.14 / plugin 2.2.15 → 绿；app 2.1.15 / plugin 2.2.14 → 不许可',
    source.pluginVersionAllowed('2.2.15', '2.1.14') === true && source.pluginVersionAllowed('2.2.14', '2.1.15') === false, {});
  check('E3 沙盘版本映射错位（app 2.1.15 / plugin 2.2.14）→ PLUGIN_VERSION_MISMATCH 红',
    bad.ok === false && codes.includes('PLUGIN_VERSION_MISMATCH'), { codes });
  check('E4 同一沙盘 payload.appVersion 旧值 → APP_PAYLOAD_VERSION_MISMATCH 红', codes.includes('APP_PAYLOAD_VERSION_MISMATCH'), { codes });
  fs.rmSync(box, { recursive: true, force: true });
}

function main() {
  driftSection();
  verdictSection();
  versionSection();
  const failed = ROWS.filter((r) => !r.ok).length;
  if (JSON_OUT) console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed, failed: ROWS.filter((r) => !r.ok).map((r) => r.name), rows: ROWS }, null, 2));
  else console.log(`\n${ROWS.length - failed}/${ROWS.length} PASS${failed ? ' · ' + failed + ' FAIL' : ''}`);
  process.exit(failed ? 1 : 0);
}
main();
