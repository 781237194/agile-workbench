#!/usr/bin/env node
'use strict';
/**
 * build-upgrade-zip.cjs —— 生成升级包 `发布/pm-workbench-<version>.zip`（P0 B-20261119-194157-2e6d）
 *
 * 为什么要脚本：2.1.5 的升级包是用临时命令手工打的，漏掉整个 `团队/` → 一键升级装不到工具层修复；
 * 现在把「包内容清单」收敛到 scripts/upgrade-package-manifest.cjs，打包产物与 install.ps1 的白名单同源。
 *
 * 用法：
 *   node scripts/build-upgrade-zip.cjs                 # 按 package.json.version 打包到 发布/
 *   node scripts/build-upgrade-zip.cjs --version 2.1.6 # 指定版本（只影响目录名/文件名）
 *   node scripts/build-upgrade-zip.cjs --out <path>.zip
 *   node scripts/build-upgrade-zip.cjs --source <仓库根>  # 从别的树打包（沙盘/净快照）
 *   node scripts/build-upgrade-zip.cjs --dry-run        # 只打印将纳入的条目数与体积
 *
 * 说明：压缩包内顶层目录固定 `agile-workbench-v<version>/`（与历史包一致）；用户数据目录
 * （团队/状态、团队/项目、项目/、data/ 等）由清单里的 NEVER_PACKAGE 排除，根本不进 staging。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const manifest = require('./upgrade-package-manifest.cjs');

function parseArgs(argv) {
  const out = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { out._.push(a); continue; }
    const key = a.slice(2);
    const next = argv[i + 1];
    if (next && !next.startsWith('--')) { out[key] = next; i += 1; } else { out[key] = true; }
  }
  return out;
}

function copyEntry(srcRoot, rel, stageRoot, stats) {
  const src = path.join(srcRoot, rel);
  if (!fs.existsSync(src)) return;
  if (manifest.isNeverPackaged(rel)) return;
  const dst = path.join(stageRoot, rel);
  const st = fs.statSync(src);
  if (st.isDirectory()) {
    fs.mkdirSync(dst, { recursive: true });
    for (const entry of fs.readdirSync(src, { withFileTypes: true })) {
      const childRel = `${rel}/${entry.name}`;
      if (manifest.isNeverPackaged(childRel)) continue;
      copyEntry(srcRoot, childRel, stageRoot, stats);
    }
    return;
  }
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(src, dst);
  stats.files += 1;
  stats.bytes += st.size;
}

function listStage(stageRoot) {
  const out = [];
  const walk = (dir, prefix) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (entry.isDirectory()) walk(path.join(dir, entry.name), rel);
      else out.push(rel);
    }
  };
  walk(stageRoot, '');
  return out.sort();
}

/** CRC32（zip 每条必须的校验） */
function crc32(buf) {
  let table = crc32.table;
  if (!table) {
    table = new Int32Array(256);
    for (let n = 0; n < 256; n += 1) {
      let c = n;
      for (let k = 0; k < 8; k += 1) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      table[n] = c;
    }
    crc32.table = table;
  }
  let crc = -1;
  for (let i = 0; i < buf.length; i += 1) crc = (crc >>> 8) ^ table[(crc ^ buf[i]) & 0xFF];
  return (crc ^ -1) >>> 0;
}

/**
 * 自己写 zip（deflate，条目名 UTF-8 + UTF-8 标志位）。
 * 为什么不用系统 tar/Compress-Archive：Windows bsdtar 会把中文名按本地代码页（GBK）存、不打 UTF-8 标志，
 * 升级包里的 `团队/` 路径在别的机器/校验工具里会变乱码；自写可保证跨机器一致且可被 Expand-Archive 解。
 */
function writeZip(stageRoot, entries, outZip, prefixDir) {
  const zlib = require('node:zlib');
  const parts = [];
  const central = [];
  let offset = 0;
  for (const rel of entries) {
    const data = fs.readFileSync(path.join(stageRoot, rel));
    const deflated = zlib.deflateRawSync(data, { level: 9 });
    const useDeflate = deflated.length < data.length;
    const payload = useDeflate ? deflated : data;
    const nameBytes = Buffer.from(prefixDir ? prefixDir + '/' + rel : rel, 'utf8');
    const crc = crc32(data);
    const local = Buffer.alloc(30 + nameBytes.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4); // version needed
    local.writeUInt16LE(0x0800, 6); // UTF-8 标志
    local.writeUInt16LE(useDeflate ? 8 : 0, 8);
    local.writeUInt16LE(0, 10); // time
    local.writeUInt16LE(0x21, 12); // date 1980-01-01（确定性）
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(payload.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    nameBytes.copy(local, 30);
    parts.push(local, payload);
    const cen = Buffer.alloc(46 + nameBytes.length);
    cen.writeUInt32LE(0x02014b50, 0);
    cen.writeUInt16LE(20, 4);
    cen.writeUInt16LE(20, 6);
    cen.writeUInt16LE(0x0800, 8);
    cen.writeUInt16LE(useDeflate ? 8 : 0, 10);
    cen.writeUInt16LE(0, 12);
    cen.writeUInt16LE(0x21, 14);
    cen.writeUInt32LE(crc, 16);
    cen.writeUInt32LE(payload.length, 20);
    cen.writeUInt32LE(data.length, 24);
    cen.writeUInt16LE(nameBytes.length, 28);
    cen.writeUInt16LE(0, 30);
    cen.writeUInt16LE(0, 32);
    cen.writeUInt16LE(0, 34);
    cen.writeUInt16LE(0, 36);
    cen.writeUInt32LE(0, 38);
    cen.writeUInt32LE(offset, 42);
    nameBytes.copy(cen, 46);
    central.push(cen);
    offset += local.length + payload.length;
  }
  const centralStart = offset;
  const centralBuf = Buffer.concat(central);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralBuf.length, 12);
  eocd.writeUInt32LE(centralStart, 16);
  eocd.writeUInt16LE(0, 20);
  fs.mkdirSync(path.dirname(outZip), { recursive: true });
  fs.writeFileSync(outZip, Buffer.concat([...parts, centralBuf, eocd]));
  return { entries: entries.length, bytes: fs.statSync(outZip).size };
}

function main() {
  const args = parseArgs(process.argv.slice(2));
  const sourceRoot = path.resolve(String(args.source || path.join(__dirname, '..')));
  const pkg = JSON.parse(fs.readFileSync(path.join(sourceRoot, 'package.json'), 'utf8'));
  const version = String(args.version || pkg.version || '').trim();
  if (!version) { console.error('缺少版本号（package.json.version 或 --version）'); process.exit(2); }
  const topDir = `agile-workbench-v${version}`;
  const outZip = path.resolve(String(args.out || path.join(sourceRoot, '发布', `pm-workbench-${version}.zip`)));
  const stageParent = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-upgrade-stage-'));
  const stageRoot = path.join(stageParent, topDir);
  const stats = { files: 0, bytes: 0 };
  try {
    fs.mkdirSync(stageRoot, { recursive: true });
    for (const rel of [...manifest.UPGRADE_TREE, ...manifest.UPGRADE_FILES]) copyEntry(sourceRoot, rel, stageRoot, stats);
    const entries = listStage(stageRoot);
    if (!entries.length) throw new Error('staging 为空：清单里的路径都不存在？');
    console.log(`[build-upgrade-zip] 版本 ${version}｜${entries.length} 文件｜${(stats.bytes / 1048576).toFixed(2)}MB（未压缩）`);
    if (args['dry-run']) {
      for (const rel of entries) console.log('  ' + rel);
      return 0;
    }
    fs.mkdirSync(path.dirname(outZip), { recursive: true });
    // 自写 zip（UTF-8 名 + deflate）：不依赖 tar/Compress-Archive 的本地代码页行为，跨机器一致。
    const packed = writeZip(stageRoot, entries, outZip, topDir);
    const buf = fs.readFileSync(outZip);
    const sha = crypto.createHash('sha256').update(buf).digest('hex');
    // 自检：关键条目必须在包里（防止再次漏 团队/）；用中央目录解析，避免 tar -tf 的中文乱码。
    const names = manifest.zipEntryNames(buf);
    // 4dba 守卫：条目解析失败必须显式失败，绝不能让「解析出 0 条」被当成「包里没有违规条目」而假绿。
    if (!Array.isArray(names) || names.length === 0) {
      console.error('[build-upgrade-zip] 致命：无法从刚写出的 zip 解析出任何条目（守卫防止自检假绿）');
      return 1;
    }
    const hasRel = (rel) => names.some((n) => n.replace(/\\/g, '/').endsWith('/' + rel) || n.replace(/\\/g, '/') === topDir + '/' + rel);
    const missing = manifest.PACKAGE_ASSERT_ENTRIES.filter((rel) => !hasRel(rel));
    const leaked = names
      .map((n) => n.replace(/\\/g, '/').replace(new RegExp('^' + topDir.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '/'), ''))
      .filter((rel) => rel && !rel.endsWith('/') && manifest.isNeverPackaged(rel));
    console.log(`[build-upgrade-zip] 写出 ${outZip}｜${packed.bytes}B｜${packed.entries} 条｜sha256 ${sha}`);
    console.log(`[build-upgrade-zip] 关键条目缺 ${missing.length}；用户数据泄漏 ${leaked.length}`);
    if (missing.length) { console.error('缺少关键条目：' + missing.join(', ')); return 1; }
    if (leaked.length) { console.error('包里出现用户数据：' + leaked.slice(0, 5).join(', ')); return 1; }
    const sidecar = outZip + '.sha256';
    fs.writeFileSync(sidecar, `${sha}  ${path.basename(outZip)}\n`, 'utf8');
    console.log(`[build-upgrade-zip] sha256 旁路文件：${sidecar}`);
    return 0;
  } finally {
    try { fs.rmSync(stageParent, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

if (require.main === module) process.exit(main());
module.exports = { main };
