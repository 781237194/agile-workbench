#!/usr/bin/env node
// 开源导出：只按白名单复制，绝不带旧壳、私有项目、备份、临时文件、运行数据与凭据。
// 导出后扫描密钥、真实 session、个人资料与私有绝对路径；任一命中即失败。
// 本脚本只生成一份干净目录并自检，不会发布任何东西（不执行 npm publish，不 git push）。
//
// 用法：
//   node scripts\export-open-source.mjs
//   node scripts\export-open-source.mjs --out D:\somewhere\agile-workbench
//   node scripts\export-open-source.mjs --force        # 覆盖已存在、但不是上次导出产物的目录
//
// 退出码：0 成功；1 自检或敏感串扫描失败；2 参数/用法错误。

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const DEFAULT_OUT = path.join(ROOT, '_tmp', 'export-open-source');

// ── 白名单：与 package.json 的 files 保持一致 ────────────────────────────
const FILE_WHITELIST = [
  'LICENSE', 'NOTICE.md', 'README.md', 'start.cmd', 'package.json',
  'install.ps1', '安装PM工作台.cmd',
  'assets/pm-workbench.ico', 'assets/pm-workbench.png',
  'scripts/run-electron.cjs', 'scripts/test-entrypoints.cjs',
];
const DIR_WHITELIST = ['src', '团队/工具', '团队/角色', '团队/模板', '团队/协议'];

// 团队/工具 里的旧导出脚本已被 scripts/export-open-source.mjs 取代，且引用了旧壳路径，不导出
const EXCLUDED_FILES = new Set(['团队/工具/export-open-source.mjs']);

// 任何层级出现这些目录名都直接跳过（私有/临时/运行数据）
const DENY_SEGMENTS = new Set([
  'node_modules', '.git', '_tmp', '_backup', '_archive', '.tmp', '.selftest-data',
  'data', '项目', 'userdata', 'probe-receipts', '状态', '日志', '备份',
]);

const REQUIRED_FILES = [
  'package.json', 'LICENSE', 'README.md', 'NOTICE.md', 'start.cmd',
  'install.ps1', '安装PM工作台.cmd',
  'assets/pm-workbench.ico', 'assets/pm-workbench.png',
  'scripts/run-electron.cjs', 'scripts/test-entrypoints.cjs',
  'src/main.js', 'src/preload.js', 'src/dsh-adapter.js', 'src/team-tools.js', 'src/renderer/index.html',
  '团队/工具/team.mjs', '团队/角色/pm.md', '团队/模板/提案.md', '团队/协议/01-会话与必读.md',
];

const TEXT_EXT = new Set([
  '.js', '.mjs', '.cjs', '.json', '.md', '.txt', '.yml', '.yaml',
  '.html', '.css', '.cmd', '.ps1', '.sh', '.svg',
]);

const SECRET_PATTERNS = [
  { name: 'sk-', re: /sk-[A-Za-z0-9]{20,}/ },
  { name: 'ark-', re: /ark-[A-Za-z0-9-]{20,}/ },
  { name: 'token', re: /\bgh[pousr]_[A-Za-z0-9]{20,}|Bearer\s+[A-Za-z0-9._~+/=-]{20,}/ },
  { name: 'real-session-id', re: /session-[1-9a-f][0-9a-f]{7}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i },
  { name: 'personal-dir', re: /个人资料/ },
];

// 私有绝对路径：本机用户名、私有仓库根、Unix home 等一律不许出现在导出目录。
// C:\Users\<user> / C:\Users\... 是脚本脱敏后的占位，不算泄露。
const PRIVATE_PATH_PATTERNS = [
  { name: 'windows-user-home', re: /[A-Za-z]:\\Users\\(?!<user>|\.\.\.)[^\\\s"'<>]+/i },
  { name: 'windows-private-root', re: /[A-Za-z]:\\(?:deepseek|个人资料|dsh-home)(?:\\|$)/i },
  { name: 'unix-user-home', re: /(?:^|[\s"'(=])\/(?:Users|home)\/[^/\s"'<>]+/m },
];

function fail(message, code = 1) {
  console.error(`\n[失败] ${message}`);
  process.exit(code);
}

function toPosix(p) {
  return p.split(path.sep).join('/');
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sanitize(text) {
  return String(text)
    .replace(/C:\\Users\\[^\\]+/gi, 'C:\\Users\\<user>')
    .replace(/session-[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/gi,
      'session-00000000-0000-0000-0000-000000000000');
}

function copyFile(src, dst, rel) {
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  if (TEXT_EXT.has(path.extname(src).toLowerCase())) {
    fs.writeFileSync(dst, sanitize(fs.readFileSync(src, 'utf8')), 'utf8');
  } else {
    fs.copyFileSync(src, dst);
  }
  return rel;
}

function copyDir(srcDir, dstDir, relDir, out) {
  if (!fs.existsSync(srcDir)) fail(`白名单目录不存在：${srcDir}`);
  for (const ent of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const rel = path.posix.join(relDir, ent.name);
    const src = path.join(srcDir, ent.name);
    const dst = path.join(dstDir, ent.name);

    if (DENY_SEGMENTS.has(ent.name)) continue;
    if (ent.name.startsWith('.')) continue;
    if (EXCLUDED_FILES.has(rel)) continue;
    if (ent.isSymbolicLink()) continue;

    if (ent.isDirectory()) {
      copyDir(src, dst, rel, out);
    } else if (ent.isFile()) {
      out.push(copyFile(src, dst, rel));
    }
  }
  return out;
}

function walk(dir, acc = []) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(p, acc);
    else if (ent.isFile()) acc.push(p);
  }
  return acc;
}

function main() {
  const argv = process.argv.slice(2);
  if (argv.includes('--help') || argv.includes('-h')) {
    console.log('用法：node scripts\\export-open-source.mjs [--out <目录>] [--force]');
    console.log('说明：只导出白名单（src、assets 图标、团队/工具|角色|模板|协议、LICENSE、NOTICE.md、README.md、start.cmd、install.ps1、安装PM工作台.cmd、package.json），不发布。');
    return;
  }
  if (argv.includes('--publish')) {
    fail('本脚本不发布，只生成可开源目录。发布请人工执行并复核清单。', 2);
  }

  const outIdx = argv.indexOf('--out');
  const FORCE = argv.includes('--force');

  let outArg = null;
  if (outIdx >= 0) {
    outArg = argv[outIdx + 1];
    if (!outArg || outArg.startsWith('--')) fail('--out 后面要跟一个目录。', 2);
  }

  const OUT = outArg ? path.resolve(outArg) : DEFAULT_OUT;
  const relOut = path.relative(ROOT, OUT);

  if (relOut === '') fail('输出目录不能是仓库根目录。', 2);
  if (relOut && !relOut.startsWith('..') && !path.isAbsolute(relOut)) {
    if (toPosix(relOut).split('/')[0] !== '_tmp') {
      fail(`输出目录若在仓库内，只能放在 _tmp/ 下：${OUT}`, 2);
    }
  }
  if (relOut.startsWith('..') && !path.relative(OUT, ROOT).startsWith('..')) {
    fail('输出目录不能是仓库的上级目录。', 2);
  }

  if (fs.existsSync(OUT)) {
    const looksLikeExport = fs.existsSync(path.join(OUT, 'MANIFEST.json'));
    if (!looksLikeExport && !FORCE) {
      fail(`输出目录已存在且不像上次导出的产物：${OUT}\n  换个 --out，或确认后加 --force。`, 2);
    }
    fs.rmSync(OUT, { recursive: true, force: true });
  }
  fs.mkdirSync(OUT, { recursive: true });

  // ── 复制白名单 ────────────────────────────────────────────────────────
  const copied = [];
  for (const dir of DIR_WHITELIST) {
    const src = path.join(ROOT, dir);
    const dst = path.join(OUT, dir);
    copyDir(src, dst, dir, copied);
  }
  for (const file of FILE_WHITELIST) {
    const src = path.join(ROOT, file);
    if (!fs.existsSync(src)) fail(`白名单文件缺失：${src}`);
    copied.push(copyFile(src, path.join(OUT, file), file));
  }

  // ── 断言 1：路径全部落在白名单内 ─────────────────────────────────────
  const problems = [];
  for (const rel of copied) {
    const okFile = FILE_WHITELIST.includes(rel);
    const okDir = DIR_WHITELIST.some((d) => rel === d || rel.startsWith(`${d}/`));
    if (!okFile && !okDir) problems.push(`越界文件：${rel}`);
    for (const seg of rel.split('/')) {
      if (DENY_SEGMENTS.has(seg)) problems.push(`命中禁导目录 "${seg}"：${rel}`);
    }
    if (EXCLUDED_FILES.has(rel)) problems.push(`不该导出的文件：${rel}`);
  }

  // ── 断言 2：必需文件齐全 ─────────────────────────────────────────────
  for (const rel of REQUIRED_FILES) {
    if (!fs.existsSync(path.join(OUT, rel))) problems.push(`缺少必需文件：${rel}`);
  }

  if (problems.length) {
    fail(`导出目录自检失败（${problems.length} 项）：\n  - ${problems.join('\n  - ')}`);
  }

  // ── 清单 + 扫描 ──────────────────────────────────────────────────────
  const files = walk(OUT);
  let bytes = 0;
  const manifest = [];
  for (const f of files) {
    const st = fs.statSync(f);
    bytes += st.size;
    manifest.push({
      path: toPosix(path.relative(OUT, f)),
      size: st.size,
      sha256: sha256(f),
    });
  }
  fs.writeFileSync(
    path.join(OUT, 'MANIFEST.json'),
    `${JSON.stringify({ generatedAt: new Date().toISOString(), files: files.length, bytes, manifest }, null, 2)}\n`,
    'utf8',
  );

  const hits = [];
  const pathHits = [];
  const privateNeedles = [...new Set([ROOT, toPosix(ROOT)])];
  for (const f of files) {
    if (!TEXT_EXT.has(path.extname(f).toLowerCase())) continue;
    const text = fs.readFileSync(f, 'utf8');
    const rel = toPosix(path.relative(OUT, f));
    for (const p of SECRET_PATTERNS) {
      if (p.re.test(text)) hits.push({ file: rel, pattern: p.name });
    }
    for (const p of PRIVATE_PATH_PATTERNS) {
      if (p.re.test(text)) pathHits.push({ file: rel, pattern: p.name });
    }
    if (privateNeedles.some((needle) => text.includes(needle))) {
      pathHits.push({ file: rel, pattern: 'repo-absolute-path' });
    }
  }

  const group = (dir) => manifest.filter((m) => m.path === dir || m.path.startsWith(`${dir}/`)).length;
  console.log(`导出完成：${OUT}`);
  console.log(`  文件 ${files.length} 个 / ${(bytes / 1024).toFixed(1)} KB`);
  for (const dir of DIR_WHITELIST) console.log(`    ${dir}: ${group(dir)} 个`);
  const assets = manifest.filter((m) => m.path.startsWith('assets/'));
  console.log(`    assets: ${assets.length} 个（${assets.map((m) => m.path).join(', ')}）`);
  console.log(`    根目录文件: ${manifest.filter((m) => !m.path.includes('/')).map((m) => m.path).join(', ')}`);
  console.log('  自检：路径全在白名单内、必需文件齐全、已生成 MANIFEST.json');

  if (hits.length) {
    console.error(`\n[失败] 敏感串扫描命中 ${hits.length} 处：`);
    for (const h of hits.slice(0, 30)) console.error(`  - ${h.pattern}  ${h.file}`);
    console.error('请清理源文件后重新导出，本目录不要对外分发。');
    process.exit(1);
  }

  if (pathHits.length) {
    console.error(`\n[失败] 私有路径扫描命中 ${pathHits.length} 处：`);
    for (const h of pathHits.slice(0, 30)) console.error(`  - ${h.pattern}  ${h.file}`);
    console.error('导出目录包含本机私有路径，已拒绝分发。请清理源文件或补充脱敏规则后重试。');
    process.exit(1);
  }

  console.log('  扫描：无密钥 / 真实 session / 私有路径 / 个人资料命中');
  console.log('  未发布：本脚本只生成目录，不会 npm publish / git push。');
}

main();
