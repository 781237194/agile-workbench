'use strict';
/**
 * release-verify-lib.cjs —— release-verify 的纯判定（可单测，不联网）
 * R-20261120-183412-5099：把「四渠道同源」判据从脚本里抽出来，夹具可用假 asset 直接验红/绿。
 */
const crypto = require('node:crypto');

function sha256(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/**
 * GitHub asset 判据（修复旧 C3「只比 size」的已知洞）：
 *   - 必须真的有下载到的字节；
 *   - 大小一致 **且** 重算 sha256 与本地一致；
 *   - 只比 size 即同大小换内容也能蒙过 → 这里必须红。
 * 返回 { ok, code, detail }。code：GITHUB_ASSET_MISSING / GITHUB_ASSET_SIZE_MISMATCH / GITHUB_ASSET_SHA_MISMATCH。
 */
function assetVerdict({ localBuf, assetBuf, localSha, assetSha } = {}) {
  const expectedSha = String(localSha || (localBuf ? sha256(localBuf) : ''));
  const actualSha = String(assetSha || (assetBuf ? sha256(assetBuf) : ''));
  const expectedSize = localBuf ? localBuf.length : (Number.isFinite(Number((assetBuf || {}).length)) ? Number(assetBuf.length) : -1);
  const actualSize = assetBuf ? assetBuf.length : -1;
  const detail = { expectedSha, actualSha, expectedSize, actualSize };
  if (!assetBuf || actualSize <= 0) return { ok: false, code: 'GITHUB_ASSET_MISSING', detail };
  if (expectedSize >= 0 && actualSize !== expectedSize) return { ok: false, code: 'GITHUB_ASSET_SIZE_MISMATCH', detail };
  if (!expectedSha || actualSha !== expectedSha) return { ok: false, code: 'GITHUB_ASSET_SHA_MISMATCH', detail };
  return { ok: true, code: '', detail };
}

/**
 * 四渠道同源：本地 zip / 版本信息.json / GitHub asset（下载重算）/ CDN（下载重算）四方 sha 必须一致。
 * 任一方为 skipped（如 --skip-cdn）则不计入；参与方少于 2 个视为 SKIPPED 通过（由调用方决定是否接受）。
 * 返回 { ok, code, skipped, detail }；code：CHANNEL_SHA_MISMATCH / CHANNEL_SHA_MISSING。
 */
function fourWayVerdict({ localSha, feedSha, githubSha, cdnSha } = {}) {
  const channels = [
    { id: 'local', sha: String(localSha || '') },
    { id: 'feed', sha: String(feedSha || '') },
    { id: 'github', sha: String(githubSha || '') },
    { id: 'cdn', sha: String(cdnSha || '') },
  ].filter((row) => row.sha !== 'skipped');
  const missing = channels.filter((row) => !row.sha);
  const shaSet = new Set(channels.filter((row) => row.sha).map((row) => row.sha));
  const detail = { channels, missing: missing.map((row) => row.id), distinctSha: Array.from(shaSet) };
  if (missing.length) return { ok: false, code: 'CHANNEL_SHA_MISSING', detail };
  if (channels.length < 2) return { ok: true, code: 'SKIPPED', detail };
  if (shaSet.size !== 1) return { ok: false, code: 'CHANNEL_SHA_MISMATCH', detail };
  return { ok: true, code: '', detail };
}

/**
 * npm 包 payload 声明判据（C8）：发布进程写进 package.json 的 pmWorkbenchPayload.sha256
 * 必须等于升级包 sha；registry 上的实际包也必须声明同一个值。
 * 返回 { ok, code, detail }；code：APP_PAYLOAD_SHA_MISMATCH / APP_PAYLOAD_MISSING。
 */
function payloadVerdict({ localDeclared, publishedDeclared, localSha } = {}) {
  const expected = String(localSha || '');
  const local = String(localDeclared || '');
  const published = String(publishedDeclared || '');
  const detail = { expected, localDeclared: local, publishedDeclared: published };
  if (!expected || !local || !published) return { ok: false, code: 'APP_PAYLOAD_MISSING', detail };
  if (local !== expected || published !== expected) return { ok: false, code: 'APP_PAYLOAD_SHA_MISMATCH', detail };
  return { ok: true, code: '', detail };
}

module.exports = { sha256, assetVerdict, fourWayVerdict, payloadVerdict };
