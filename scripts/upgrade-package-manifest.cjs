'use strict';
/**
 * upgrade-package-manifest.cjs —— 升级包内容清单（唯一事实来源，P0 B-20261119-194157-2e6d）
 *
 * 背景：2.1.5 升级包不含任何 `团队/` 条目 → 一键升级后 `团队/工具`、角色卡模板、skill 仍是首装版；
 * 而 git pull 会更新 → 两种升级方式永久不等价，工具层修复到不了笔记本用户。
 *
 * 口径（PM 派单 M-20261119-194226-24ec15）：
 *   纳入（代码/规则，非用户数据）：团队/工具、团队/模板、团队/角色、团队/协议、团队/skill，
 *     以及 团队/团队宪法.md、团队/流程.md、团队/项目铁律.md；
 *   排除（用户数据，永不覆盖）：团队/状态、团队/日志、团队/产出、团队/项目、团队/看板.*，
 *     以及 项目/、data/、node_modules/、_tmp/ 等运行时目录。
 *
 * install.ps1 → Invoke-UpgradeApplyTree 的 $relatives 必须与本清单一致；
 * 夹具 scripts/test-2e6d-team-upgrade.cjs 会逐项比对（两处不一致即红）。
 */

/** 整目录纳入（相对仓库根，正斜杠） */
const UPGRADE_TREE = Object.freeze([
  'src',
  'scripts',
  'dsh-plugin',
  'assets',
  'docs',
  '团队/工具',
  '团队/模板',
  '团队/角色',
  '团队/协议',
  '团队/skill',
]);

/** 单文件纳入（相对仓库根，正斜杠） */
const UPGRADE_FILES = Object.freeze([
  'package.json',
  'package-lock.json',
  'install.ps1',
  'start.cmd',
  'launch.vbs',
  'README.md',
  'CHANGELOG.md',
  'NOTICE.md',
  'LICENSE',
  '发版记录.md',
  '安装PM工作台.cmd',
  '团队/团队宪法.md',
  '团队/流程.md',
  '团队/项目铁律.md',
]);

/**
 * 用户数据/运行时目录（永不进包、也永不覆盖）：命中即排除。
 * 正则在相对路径（正斜杠）上按「路径段」匹配，避免把 `团队/工具` 之类误伤。
 */
const NEVER_PACKAGE = Object.freeze([
  '团队/状态',
  '团队/日志',
  '团队/产出',
  '团队/项目',
  '团队/看板',
  '项目',
  'data',
  'node_modules',
  '_tmp',
  '_backup',
  '_archive',
  '.git',
]);

/** 相对路径是否属于「永不打包/永不覆盖」 */
function isNeverPackaged(rel) {
  const p = String(rel || '').replace(/\\/g, '/').replace(/^\.?\//, '');
  if (!p) return true;
  return NEVER_PACKAGE.some((prefix) => p === prefix || p.startsWith(prefix + '/'));
}

/**
 * 读取 zip 中央目录里的条目名（UTF-8）。
 * 为什么自己解析：Windows 自带 bsdtar 的 `-tf` 输出走控制台代码页，中文会被解成乱码（`�Ŷ�`），
 * 拿它比对 `团队/工具/...` 永远 false。Zip 中央目录里本就是 UTF-8（或带 UTF-8 标志位），直接解析最稳。
 */
function zipEntryNames(buf) {
  const b = Buffer.isBuffer(buf) ? buf : Buffer.from(buf || []);
  const out = [];
  let eocd = -1;
  for (let i = b.length - 22; i >= 0 && i > b.length - 65558; i -= 1) {
    if (b.readUInt32LE(i) === 0x06054b50) { eocd = i; break; }
  }
  if (eocd < 0) return out;
  const count = b.readUInt16LE(eocd + 10);
  let off = b.readUInt32LE(eocd + 16);
  for (let k = 0; k < count; k += 1) {
    if (off + 46 > b.length || b.readUInt32LE(off) !== 0x02014b50) break;
    const flags = b.readUInt16LE(off + 8);
    const nameLen = b.readUInt16LE(off + 28);
    const extraLen = b.readUInt16LE(off + 30);
    const commentLen = b.readUInt16LE(off + 32);
    const raw = b.slice(off + 46, off + 46 + nameLen);
    out.push(raw.toString((flags & 0x800) ? 'utf8' : 'utf8'));
    off += 46 + nameLen + extraLen + commentLen;
  }
  return out;
}

/** 压缩包内应出现的一等条目（供夹具断言） */
const PACKAGE_ASSERT_ENTRIES = Object.freeze([
  '团队/工具/lib/gates.mjs',
  '团队/工具/lib/rolecard-sync.mjs',
  '团队/工具/team.mjs',
  '团队/团队宪法.md',
  '团队/流程.md',
  '团队/项目铁律.md',
]);

module.exports = {
  UPGRADE_TREE,
  UPGRADE_FILES,
  NEVER_PACKAGE,
  PACKAGE_ASSERT_ENTRIES,
  isNeverPackaged,
  zipEntryNames,
};
