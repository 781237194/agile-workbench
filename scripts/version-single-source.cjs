#!/usr/bin/env node
'use strict';
/**
 * version-single-source.cjs —— R-20261120-183412-5099：版本单源映射（唯一实现）+ 六处一致性门
 *
 * 唯一映射（代码常量，别再各处手写）：
 *   app  A.B.C  →  plugin A.(B+1).C        （app 2.1.14 ↔ plugin 2.2.14）
 *   plugin A.B.C →  app   A.(B-1).C
 *   app A.B.C   →  tag vA.B.C
 *
 * 六处一致性门（任何一处不符即红，错误码见下）：
 *   G1 package.json                     version == app
 *   G2 dsh-plugin/package.json          name == dsh-agile-workbench、version == mapAppToPlugin(app)、
 *                                       且 pmWorkbenchPayload.sha256 == 发布/版本信息.json 的 sha（APP_PAYLOAD_SHA_MISMATCH）
 *   G3 发布/版本信息.json               version/app sha/size 与本地 zip 一致（FEED_VERSION_MISMATCH / FEED_SHA_MISMATCH）
 *   G4 发布/版本历史.jsonl              有该版本行且 sha 一致（HISTORY_*）
 *   G5 zip 文件名                       发布/pm-workbench-<app>.zip 存在（ZIP_MISSING）
 *   G6 npm 包名/版本                    本地 name/映射版本；--registry 时再查 registry 真有该版本（NPM_VERSION_MISMATCH / NPM_NOT_PUBLISHED）
 *
 * 用法：
 *   node scripts/version-single-source.cjs                 # 只打印当前版本映射
 *   node scripts/version-single-source.cjs --check [--json] [--registry]
 *   node scripts/version-single-source.cjs --check --root <repo>
 * 退出码：0 全绿；1 有红门；2 参数/读盘错误。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const https = require('node:https');

const REPO_ROOT = path.resolve(__dirname, '..');

/** 解析 A.B.C → {major, minor, patch}；非法返回 null。 */
function parseVersion(text) {
  const m = /^(\d+)\.(\d+)\.(\d+)$/.exec(String(text || '').trim());
  if (!m) return null;
  return { major: Number(m[1]), minor: Number(m[2]), patch: Number(m[3]) };
}
function formatVersion(parts) {
  return `${parts.major}.${parts.minor}.${parts.patch}`;
}
/** app → plugin：MINOR+1（唯一映射实现）。 */
function appToPlugin(appVersion) {
  const parts = parseVersion(appVersion);
  if (!parts) return '';
  return formatVersion({ ...parts, minor: parts.minor + 1 });
}
/** plugin → app：MINOR-1。 */
function pluginToApp(pluginVersion) {
  const parts = parseVersion(pluginVersion);
  if (!parts || parts.minor < 1) return '';
  return formatVersion({ ...parts, minor: parts.minor - 1 });
}
function tagForApp(appVersion) {
  return parseVersion(appVersion) ? 'v' + appVersion : '';
}
function sha256File(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return ''; }
}
function readJson(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
}

/**
 * 本地一致性检查（不联网）。返回 { ok, appVersion, pluginVersion, rows[] }。
 * rows[] 每项 { id, name, ok, code?, detail }。
 */
function checkVersionConsistency({ root = REPO_ROOT } = {}) {
  const rows = [];
  const push = (id, name, ok, detail = {}, code = '') => rows.push({ id, name, ok: Boolean(ok), code: ok ? '' : code, detail });
  const pkg = readJson(path.join(root, 'package.json'));
  const pluginPkg = readJson(path.join(root, 'dsh-plugin', 'package.json'));
  const appVersion = String((pkg && pkg.version) || '');
  const expectedPlugin = appToPlugin(appVersion);
  const feed = readJson(path.join(root, '发布', '版本信息.json'));
  const zipRel = appVersion ? `发布/pm-workbench-${appVersion}.zip` : '';
  const zipAbs = zipRel ? path.join(root, zipRel) : '';
  const zipSha = zipAbs ? sha256File(zipAbs) : '';
  const zipSize = zipAbs && fs.existsSync(zipAbs) ? fs.statSync(zipAbs).size : -1;

  push('G1', 'package.json 版本可解析', Boolean(parseVersion(appVersion)), { appVersion }, 'APP_VERSION_SOURCE_MISSING');
  push('G2a', `dsh-plugin/package.json name=dsh-agile-workbench`,
    Boolean(pluginPkg && pluginPkg.name === 'dsh-agile-workbench'), { name: pluginPkg && pluginPkg.name }, 'NPM_NAME_MISMATCH');
  push('G2b', `plugin 版本 == 映射值 ${expectedPlugin || '（算不出）'}（插件实际 ${(pluginPkg && pluginPkg.version) || '缺失'}）`,
    Boolean(expectedPlugin) && Boolean(pluginPkg) && pluginPkg.version === expectedPlugin,
    { appVersion, expectedPlugin, pluginVersion: pluginPkg && pluginPkg.version }, 'PLUGIN_VERSION_MISMATCH');
  const declaredPayload = pluginPkg && pluginPkg.pmWorkbenchPayload && String(pluginPkg.pmWorkbenchPayload.sha256 || '');
  push('G2c', 'npm 包声明 payload sha == 版本信息 sha（APP_PAYLOAD_SHA_MISMATCH）',
    Boolean(declaredPayload) && Boolean(feed) && declaredPayload === String(feed.sha256 || ''),
    { declaredPayload: declaredPayload || '', feedSha: feed && feed.sha256 }, 'APP_PAYLOAD_SHA_MISMATCH');
  const declaredApp = pluginPkg && pluginPkg.pmWorkbenchPayload && String(pluginPkg.pmWorkbenchPayload.appVersion || '');
  push('G2d', `npm 包声明 appVersion == package.json 版本（${appVersion}）`,
    Boolean(declaredApp) && declaredApp === appVersion,
    { declaredApp: declaredApp || '', appVersion }, 'APP_PAYLOAD_VERSION_MISMATCH');
  push('G3a', `版本信息.json version == ${appVersion}`, Boolean(feed) && feed.version === appVersion,
    { feedVersion: feed && feed.version, appVersion }, 'FEED_VERSION_MISMATCH');
  push('G3b', '版本信息.json sha256 == 本地 zip sha256',
    Boolean(feed) && Boolean(zipSha) && feed.sha256 === zipSha,
    { feedSha: feed && feed.sha256, zipSha }, 'FEED_SHA_MISMATCH');
  push('G3c', '版本信息.json size == 本地 zip size',
    Boolean(feed) && Number(feed.size) === zipSize, { feedSize: feed && feed.size, zipSize }, 'FEED_SIZE_MISMATCH');
  let histRow = null;
  try {
    const lines = fs.readFileSync(path.join(root, '发布', '版本历史.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
    histRow = lines.map((line) => { try { return JSON.parse(line); } catch { return null; } })
      .filter(Boolean).reverse().find((row) => String(row.version) === appVersion) || null;
  } catch { histRow = null; }
  push('G4a', `版本历史.jsonl 有 ${appVersion} 行`, Boolean(histRow), { found: Boolean(histRow) }, 'HISTORY_VERSION_MISSING');
  push('G4b', '版本历史行 sha256 == 本地 zip sha256', Boolean(histRow) && histRow.sha256 === zipSha,
    { histSha: histRow && histRow.sha256, zipSha }, 'HISTORY_SHA_MISMATCH');
  push('G5', `升级包 ${zipRel || '（版本缺失）'} 存在`, Boolean(zipRel) && fs.existsSync(path.join(root, zipRel)),
    { zipRel, exists: Boolean(zipRel) && fs.existsSync(path.join(root, zipRel)) }, 'ZIP_MISSING');
  // G7：插件安装器兜底字面量必须等于当前 app 版本（不允许再出现 @v2.1.4 这类旧 tag）。
  let installerFallback = '';
  try {
    const pluginIndex = fs.readFileSync(path.join(root, 'dsh-plugin', 'pm-workbench-dsh', 'index.js'), 'utf8');
    const m = /APP_VERSION_FALLBACK\s*=\s*'([0-9]+\.[0-9]+\.[0-9]+)'/.exec(pluginIndex);
    installerFallback = m ? m[1] : '';
  } catch { installerFallback = ''; }
  push('G7', `插件安装器兜底版本 == ${appVersion}（现在是 ${installerFallback || '缺失'}）`,
    Boolean(appVersion) && installerFallback === appVersion,
    { appVersion, installerFallback }, 'PLUGIN_INSTALLER_LITERAL_STALE');
  return {
    ok: rows.every((row) => row.ok),
    root,
    appVersion,
    pluginVersion: (pluginPkg && pluginPkg.version) || '',
    expectedPlugin,
    mapping: { appToPlugin, pluginToApp, tag: tagForApp(appVersion) },
    zipRel,
    zipSha,
    zipSize,
    rows,
  };
}

function httpJson(url, timeout = 20000) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers: { 'User-Agent': 'awb-version-check', 'Cache-Control': 'no-cache' } }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        try { resolve({ status: res.statusCode, json: JSON.parse(Buffer.concat(chunks).toString('utf8')) }); } catch (error) { reject(error); }
      });
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => req.destroy(new Error('HTTP_TIMEOUT')));
  });
}

/** G6：registry 回查（发布后必须验证「真的发出去了」，不能只信 npm publish 的 exit 0）。 */
async function checkRegistryVersion({ name = 'dsh-agile-workbench', version } = {}) {
  try {
    const { status, json } = await httpJson(`https://registry.npmjs.org/${encodeURIComponent(name)}`);
    if (status !== 200) return { ok: false, code: 'NPM_REGISTRY_UNREACHABLE', detail: { status } };
    const exists = Boolean(json && json.versions && json.versions[version]);
    return {
      ok: exists,
      code: exists ? '' : 'NPM_NOT_PUBLISHED',
      detail: { version, latest: json && json['dist-tags'] && json['dist-tags'].latest, versions: json && Object.keys(json.versions || {}).length },
    };
  } catch (error) {
    return { ok: false, code: 'NPM_REGISTRY_UNREACHABLE', detail: { error: String((error && error.message) || error) } };
  }
}

async function main() {
  const argv = process.argv.slice(2);
  const asJson = argv.includes('--json');
  const rootArg = (() => { const i = argv.indexOf('--root'); return i >= 0 && argv[i + 1] ? path.resolve(argv[i + 1]) : REPO_ROOT; })();
  const result = checkVersionConsistency({ root: rootArg });
  if (!argv.includes('--check')) {
    if (asJson) console.log(JSON.stringify(result, null, 2));
    else {
      console.log(`app=${result.appVersion} plugin=${result.pluginVersion}（应为 ${result.expectedPlugin}）tag=${result.mapping.tag}`);
      console.log(`zip=${result.zipRel} sha256=${result.zipSha || '（缺失）'} size=${result.zipSize}`);
    }
    process.exit(0);
  }
  if (argv.includes('--registry')) {
    const pluginVersion = result.pluginVersion;
    const reg = await checkRegistryVersion({ version: pluginVersion });
    result.rows.push({ id: 'G6', name: `registry 回查 dsh-agile-workbench@${pluginVersion} 真实存在`, ok: reg.ok, code: reg.code, detail: reg.detail });
    result.registry = reg;
    result.ok = result.ok && reg.ok;
  } else {
    result.rows.push({ id: 'G6', name: 'npm 包名/版本映射（未加 --registry，只查本地声明）', ok: Boolean(result.expectedPlugin) && result.pluginVersion === result.expectedPlugin, code: result.pluginVersion === result.expectedPlugin ? '' : 'NPM_VERSION_MISMATCH', detail: {} });
    result.ok = result.ok && result.pluginVersion === result.expectedPlugin;
  }
  if (asJson) console.log(JSON.stringify(result, null, 2));
  else {
    for (const row of result.rows) console.log(`${row.ok ? 'PASS' : 'FAIL'}  ${row.id} ${row.name}${row.code ? ' :: ' + row.code : ''}`);
    const pass = result.rows.filter((r) => r.ok).length;
    console.log(`\n${pass}/${result.rows.length} PASS  app=${result.appVersion} plugin=${result.pluginVersion}`);
  }
  process.exit(result.ok ? 0 : 1);
}

module.exports = {
  parseVersion,
  formatVersion,
  appToPlugin,
  pluginToApp,
  tagForApp,
  checkVersionConsistency,
  checkRegistryVersion,
  sha256File,
};

if (require.main === module) {
  main().catch((error) => { console.error('VERSION_CHECK_FAILED: ' + String((error && error.stack) || error)); process.exit(2); });
}
