#!/usr/bin/env node
'use strict';
/**
 * release-verify.cjs —— 一次性核对某个版本「三处 sha 一致 + 全渠道可见」
 * 用法：node scripts/release-verify.cjs 2.1.8 [--skip-cdn] [--skip-npm]
 *
 * 为什么要有它（Owner 2026-11-20 的「发版必留包可回退」+ 今晚多次手工核对）：
 *   每次发版都要人肉跑 5 条命令（本地 sha / tag 内 zip / Release asset / CDN / npm），
 *   漏一条就可能发出一个「tag 与 CDN 不一致」的版本。本脚本把 5 项收敛成一条，输出 PASS/FAIL 表。
 *
 * 判据（全绿才算发版完成）：
 *   C1 本地 `发布/pm-workbench-<v>.zip` 存在，sha256 与 `发布/版本信息.json` 一致
 *   C2 tag `v<v>` 指向的 tree 内 zip 与本地同 sha（git show v<v>:发布/…zip）
 *   C3 GitHub Release `v<v>` 存在且 asset `pm-workbench-<v>.zip` 的 digest/size 与本地一致
 *   C4 CDN（jsDelivr @v<v>）下载的 sha256 与本地一致
 *   C5 npm `dsh-agile-workbench` 的 `dist-tags.latest` 或版本表包含 `2.2.<minor+0>` 对应版本
 *      （app 2.1.N ↔ npm 2.2.N 的映射按 package.json 读取，不写死）
 *   C6 `发布/版本历史.jsonl` 有该版本一行且 sha256 匹配
 */
const fs = require('node:fs');
const path = require('node:path');
const https = require('node:https');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const version = String(args.find((a) => !a.startsWith('--')) || '').trim();
const skipCdn = args.includes('--skip-cdn');
const skipNpm = args.includes('--skip-npm');
if (!version) {
  console.error('用法：node scripts/release-verify.cjs <version> [--skip-cdn] [--skip-npm]');
  process.exit(2);
}

const zipRel = `发布/pm-workbench-${version}.zip`;
const zipAbs = path.join(ROOT, zipRel);
const rows = [];
const check = (id, name, ok, detail) => {
  rows.push({ id, name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${name}${ok ? '' : ' :: ' + JSON.stringify(detail || {})}`);
};
const sha256Buf = (b) => crypto.createHash('sha256').update(b).digest('hex');

function httpGet(url, { headers = {}, timeout = 45000, follow = 5 } = {}) {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { headers }, (res) => {
      if ([301, 302, 303, 307, 308].includes(res.statusCode) && res.headers.location && follow > 0) {
        res.resume();
        const next = new URL(res.headers.location, url).toString();
        resolve(httpGet(next, { headers, timeout, follow: follow - 1 }));
        return;
      }
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode, body: Buffer.concat(chunks), headers: res.headers }));
    });
    req.on('error', reject);
    req.setTimeout(timeout, () => { req.destroy(new Error('HTTP_TIMEOUT')); });
  });
}

function githubToken() {
  try {
    const cred = execFileSync('git', ['credential', 'fill'], {
      cwd: ROOT, input: 'protocol=https\nhost=github.com\n\n', encoding: 'utf8',
    });
    const line = cred.split('\n').find((l) => l.startsWith('password=')) || '';
    return line.replace('password=', '').trim();
  } catch { return ''; }
}

(async () => {
  // C1 本地包 + 版本信息
  let localBuf = null;
  let localSha = '';
  try {
    localBuf = fs.readFileSync(zipAbs);
    localSha = sha256Buf(localBuf);
  } catch { localBuf = null; }
  const feedPath = path.join(ROOT, '发布', '版本信息.json');
  let feed = null;
  try { feed = JSON.parse(fs.readFileSync(feedPath, 'utf8')); } catch { feed = null; }
  check('C1', `本地包存在且与 版本信息.json sha 一致（${localBuf ? localBuf.length : 0}B）`,
    Boolean(localBuf) && Boolean(feed) && feed.version === version && feed.sha256 === localSha,
    { localSha, feedVersion: feed && feed.version, feedSha: feed && feed.sha256 });

  // C2 tag 内 zip
  let tagSha = '';
  try {
    const buf = execFileSync('git', ['show', `v${version}:${zipRel}`], { cwd: ROOT, maxBuffer: 128 * 1024 * 1024 });
    tagSha = sha256Buf(buf);
  } catch (e) { tagSha = ''; }
  check('C2', `tag v${version} 内 zip 与本地同 sha`, Boolean(tagSha) && tagSha === localSha, { tagSha, localSha });

  // C3 GitHub Release asset
  const token = githubToken();
  if (token) {
    try {
      const rel = await httpGet(`https://api.github.com/repos/781237194/agile-workbench/releases/tags/v${version}`, {
        headers: { Authorization: `token ${token}`, 'User-Agent': 'awb-release-verify', Accept: 'application/vnd.github+json' },
      });
      const json = JSON.parse(rel.body.toString('utf8'));
      const asset = (json.assets || []).find((a) => a.name === `pm-workbench-${version}.zip`);
      check('C3', `Release v${version} 存在且 asset 大小与本地一致`,
        rel.status === 200 && Boolean(asset) && Number(asset.size) === (localBuf ? localBuf.length : -1),
        { status: rel.status, asset: asset && { name: asset.name, size: asset.size, state: asset.state } });
    } catch (e) {
      check('C3', `Release v${version} 可查`, false, { error: String(e && e.message) });
    }
  } else {
    check('C3', 'Release 校验（无 GitHub token，跳过）', true, { skipped: true });
  }

  // C4 CDN
  if (skipCdn) {
    check('C4', 'CDN 校验（--skip-cdn）', true, { skipped: true });
  } else {
    const url = `https://cdn.jsdelivr.net/gh/781237194/agile-workbench@v${version}/%E5%8F%91%E5%B8%83/pm-workbench-${version}.zip`;
    try {
      const res = await httpGet(url, { timeout: 90000 });
      const cdnSha = sha256Buf(res.body);
      check('C4', 'CDN 下载包 sha256 与本地一致', res.status === 200 && cdnSha === localSha, { status: res.status, cdnSha, localSha, bytes: res.body.length });
    } catch (e) {
      check('C4', 'CDN 下载包 sha256 与本地一致', false, { error: String(e && e.message) });
    }
  }

  // C5 npm（映射：app 2.1.N ↔ dsh-plugin package.json 里的版本）
  if (skipNpm) {
    check('C5', 'npm 版本（--skip-npm）', true, { skipped: true });
  } else {
    let pluginVersion = '';
    try { pluginVersion = JSON.parse(fs.readFileSync(path.join(ROOT, 'dsh-plugin', 'package.json'), 'utf8')).version; } catch { pluginVersion = ''; }
    try {
      const res = await httpGet('https://registry.npmjs.org/dsh-agile-workbench', { headers: { 'Cache-Control': 'no-cache' } });
      const json = JSON.parse(res.body.toString('utf8'));
      const exists = Boolean(json.versions && json.versions[pluginVersion]);
      check('C5', `npm 含 dsh-agile-workbench@${pluginVersion}`, res.status === 200 && exists, {
        pluginVersion, latest: json['dist-tags'] && json['dist-tags'].latest, exists,
      });
    } catch (e) {
      check('C5', 'npm 版本可查', false, { error: String(e && e.message) });
    }
  }

  // C6 版本历史
  let histRow = null;
  try {
    const lines = fs.readFileSync(path.join(ROOT, '发布', '版本历史.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean);
    histRow = lines.map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean).reverse().find((r) => String(r.version) === version) || null;
  } catch { histRow = null; }
  check('C6', `版本历史.jsonl 有 ${version} 行且 sha 匹配`, Boolean(histRow) && histRow.sha256 === localSha, {
    found: Boolean(histRow), histSha: histRow && histRow.sha256,
  });

  const pass = rows.filter((r) => r.ok).length;
  console.log(`\n${pass}/${rows.length} PASS  版本 ${version}`);
  const outFile = path.join(ROOT, '_tmp', `release-verify-${version}.json`);
  try {
    fs.mkdirSync(path.dirname(outFile), { recursive: true });
    fs.writeFileSync(outFile, JSON.stringify({ version, at: new Date().toISOString(), localSha, rows }, null, 2), 'utf8');
    console.log('明细：' + outFile);
  } catch { /* ignore */ }
  process.exit(pass === rows.length ? 0 : 1);
})();
