// R-20261116-191906-7aa8 · 证据导出包（唯一实现）
// 用法：
//   team.mjs evidence export --project P --out <zip> [--since 30|<YYYY-MM-DD>|0] [--only glob]
//        [--all] [--max-bytes 512MB] [--strict-size] [--skip-oversize] [--manifest 旧清单.json] [--json]
//   team.mjs evidence verify --zip <zip> [--json]
//
// 口径（需求正文 F1–F7 / AC1–AC7，正文 sha256 c8839c16…）：
//   - 打包写死系统 bsdtar（--format=zip -cf <out> -T <list>），不做第二套实现；
//   - 清单 清单.json 的 files 项恰好 5 键 path/bytes/sha256/kind/mtime，附加信息一律进 warnings[]；
//   - 默认 --since 30 天；--max-bytes 默认 512MB，超限按 mtime 倒序截断并留痕；
//   - 密钥两层：高置信拒包（EVIDENCE_SECRET_FOUND），宽词只进 warnings；
//   - --manifest 重放才判 EVIDENCE_UNLISTED / EVIDENCE_MISSING（各列前 10，零写入）。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { PATHS, TeamError, fail, hashFile, jsonOut, nowIso } from './core.mjs';

export const MANIFEST_NAME = '清单.json';
export const MANIFEST_VERSION = 1;
const DEFAULT_SINCE_DAYS = 30;
const DEFAULT_MAX_BYTES = 512 * 1024 * 1024;
const EXPORT_TIMEOUT_MS = 30 * 60 * 1000;
const LOCK_STALE_MS = 60 * 1000;
const PROGRESS_EVERY = 5000;
const SECRET_SCAN_BYTES = 64 * 1024;
const TEXT_EXT = new Set(['.md', '.txt', '.log', '.json', '.jsonl', '.yml', '.yaml', '.csv', '.xml', '.ini', '.conf', '.sh', '.ps1', '.bat', '.cjs', '.mjs', '.js', '.ts', '.html']);

/** 高置信密钥：命中即拒包（F7）。 */
const SECRET_HIGH = [
  { code: 'private_key_block', re: /-----BEGIN [A-Z ]*PRIVATE KEY-----/ },
  { code: 'openai_sk', re: /sk-[A-Za-z0-9]{20,}/ },
  { code: 'aws_akia', re: /AKIA[0-9A-Z]{16}/ },
  { code: 'github_ghp', re: /ghp_[A-Za-z0-9]{36}/ },
  { code: 'slack_token', re: /xox[baprs]-/ },
];
/** 宽词：只提示，不拒（F7）。 */
const SECRET_WIDE = /\b(token|secret|password|passwd)\b|api[_-]?key/i;

function tarExe() {
  if (process.env.AWB_TAR_EXE) return String(process.env.AWB_TAR_EXE);
  const win = path.join(process.env.SystemRoot || 'C:\\Windows', 'System32', 'tar.exe');
  return process.platform === 'win32' ? win : 'tar';
}

function requireTar() {
  const exe = tarExe();
  const probe = spawnSync(exe, ['--version'], { encoding: 'utf8' });
  if (probe.error || probe.status !== 0) {
    fail('EVIDENCE_ZIP_UNAVAILABLE', '找不到可用的 bsdtar（系统 tar 命令），证据导出需要系统 bsdtar 才能做真流式 zip', {
      tar: exe,
      platform: process.platform,
      hint: 'Windows 10/11 自带 System32 下的 bsdtar 3.5.x；缺失时请安装 libarchive/bsdtar，或用 AWB_TAR_EXE 指定路径。不降级成目录复制。',
    }, 2);
  }
  return exe;
}

export function kindOf(file) {
  const ext = path.extname(String(file || '')).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)) return 'screenshot';
  if (['.md', '.txt', '.log'].includes(ext)) return 'report';
  return 'file';
}

export function parseSize(text, fallback) {
  if (text === undefined || text === null || text === '') return fallback;
  const m = String(text).trim().match(/^(\d+(?:\.\d+)?)\s*(B|KB|MB|GB|TB)?$/i);
  if (!m) return null;
  const n = Number(m[1]);
  const unit = String(m[2] || 'B').toUpperCase();
  const mul = { B: 1, KB: 1024, MB: 1024 ** 2, GB: 1024 ** 3, TB: 1024 ** 4 }[unit] || 1;
  return Math.round(n * mul);
}

function parseSince(raw) {
  if (raw === undefined || raw === null || raw === '') return { days: DEFAULT_SINCE_DAYS, text: String(DEFAULT_SINCE_DAYS) };
  const s = String(raw).trim();
  if (/^\d+$/.test(s)) return { days: Number(s), text: s };
  const t = Date.parse(s);
  if (!Number.isFinite(t)) {
    fail('EVIDENCE_SINCE_INVALID', `--since 不是天数也不是合法日期：${s}`, { since: s, examples: ['30', '0', '2026-11-01'] });
  }
  return { days: null, at: t, text: s };
}

function sinceCutoff(since) {
  if (since.days === 0) return 0;
  if (since.days !== null && since.days !== undefined) return Date.now() - since.days * 24 * 3600 * 1000;
  return since.at;
}

/** F1：证据类文件范围（项目内，排除 src/、团队/状态/、会话目录）。 */
export function isEvidencePath(rel) {
  const p = String(rel).replace(/\\/g, '/');
  if (p.startsWith('..') || p.includes('/../')) return false;
  const seg = p.split('/');
  if (seg.length < 3) return false;
  if (/^[^/]+\/产出\/证据-[^/]+(\/|$)/.test(p)) return true;
  if (/^[^/]+\/产出\/(测试确认|复核)-[^/]*\.md$/i.test(p)) return true;
  if (/^测试人员\/产出\/测试报告-v[^/]*\.md$/i.test(p)) return true;
  return false;
}

function walk(dir, base, out, depth) {
  if (depth > 12) return;
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const rel = path.relative(base, abs).replace(/\\/g, '/');
    if (e.isDirectory()) {
      if (e.name === 'node_modules' || e.name === '.git') continue;
      walk(abs, base, out, depth + 1);
    } else if (e.isFile()) {
      out.push(rel);
    }
  }
}

function scanScope(projectDir, opts) {
  const all = [];
  let tops = [];
  try { tops = fs.readdirSync(projectDir, { withFileTypes: true }).filter((d) => d.isDirectory()).map((d) => d.name); } catch {
    fail('BAD_ARGS', `项目目录不可读：${projectDir}`, { projectDir });
  }
  for (const top of tops) {
    const roleDir = path.join(projectDir, top);
    const outDir = path.join(roleDir, '产出');
    if (!fs.existsSync(outDir)) continue;
    walk(outDir, projectDir, all, 0);
  }
  const uniq = Array.from(new Set(all));
  const picked = [];
  for (const rel of uniq) {
    if (!isEvidencePath(rel)) continue;
    if (opts.only && !opts.only.test(rel)) continue;
    picked.push(rel);
  }
  return picked;
}

function readHead(abs) {
  const fd = fs.openSync(abs, 'r');
  try {
    const buf = Buffer.alloc(SECRET_SCAN_BYTES);
    const n = fs.readSync(fd, buf, 0, SECRET_SCAN_BYTES, 0);
    return buf.slice(0, n).toString('utf8');
  } finally { fs.closeSync(fd); }
}

function secretScanFile(rel, abs, warnings) {
  const ext = path.extname(rel).toLowerCase();
  if (/\.(key|pem|p12|pfx)$/i.test(rel)) {
    fail('EVIDENCE_SECRET_FOUND', `证据里出现密钥类文件：${rel}`, { code: 'secret_file_ext', path: rel }, 2);
  }
  if (!TEXT_EXT.has(ext)) return;
  let head = '';
  try { head = readHead(abs); } catch { return; }
  for (const rule of SECRET_HIGH) {
    if (rule.re.test(head)) {
      fail('EVIDENCE_SECRET_FOUND', `证据里出现高置信密钥（${rule.code}）：${rel}`, { code: rule.code, path: rel }, 2);
    }
  }
  if (SECRET_WIDE.test(head)) {
    const hit = (head.match(SECRET_WIDE) || [''])[0];
    warnings.push({ code: 'secret_suspect_word', path: rel, detail: `含疑似词 ${hit}（仅提示，建议人工看一眼；不阻断）` });
  }
}

function fileListOf(projectDir, rels) {
  const items = [];
  for (const rel of rels) {
    const abs = path.join(projectDir, rel);
    let st;
    try { st = fs.statSync(abs); } catch { continue; }
    items.push({ rel, abs, bytes: st.size, mtime: st.mtime.toISOString(), mtimeMs: st.mtimeMs, kind: kindOf(rel) });
  }
  return items;
}

function acquireExportLock(out) {
  const lock = out + '.export.lock';
  const tryOnce = () => {
    const fd = fs.openSync(lock, 'wx');
    fs.writeSync(fd, JSON.stringify({ pid: process.pid, at: nowIso(), out }));
    fs.closeSync(fd);
    return true;
  };
  try { return tryOnce(); } catch (e) {
    if (e && e.code === 'EEXIST') {
      let stale = false;
      try { stale = Date.now() - fs.statSync(lock).mtimeMs > LOCK_STALE_MS; } catch { stale = true; }
      if (stale) {
        try { fs.unlinkSync(lock); } catch { /* ignore */ }
        try { return tryOnce(); } catch { /* fallthrough */ }
      }
      fail('EVIDENCE_EXPORT_BUSY', `同一个 --out 正在被另一次导出占用：${out}`, { lock }, 2);
    }
    fail('EVIDENCE_EXPORT_IO', `无法创建导出锁：${lock}`, { error: String(e && e.message || e) }, 2);
  }
  return false;
}

function releaseExportLock(out) {
  try { fs.unlinkSync(out + '.export.lock'); } catch { /* ignore */ }
}

function readManifestFile(file) {
  if (!file) return null;
  const abs = path.resolve(String(file));
  if (!fs.existsSync(abs)) {
    fail('EVIDENCE_MANIFEST_MISSING', `--manifest 指定的旧清单不存在：${abs}`, { manifest: abs }, 2);
  }
  let raw;
  try { raw = fs.readFileSync(abs, 'utf8'); } catch (e) {
    fail('EVIDENCE_MANIFEST_BROKEN', `旧清单读不出发：${abs}`, { manifest: abs, error: String(e && e.message || e) }, 2);
  }
  let json;
  try { json = JSON.parse(raw); } catch (e) {
    fail('EVIDENCE_MANIFEST_BROKEN', `旧清单不是合法 JSON：${abs}`, { manifest: abs, error: String(e && e.message || e) }, 2);
  }
  if (!json || Number(json.version) !== MANIFEST_VERSION) {
    fail('EVIDENCE_MANIFEST_VERSION', `旧清单版本不兼容（期望 ${MANIFEST_VERSION}，实际 ${json && json.version}）`, { manifest: abs, version: json && json.version }, 2);
  }
  if (!Array.isArray(json.files)) {
    fail('EVIDENCE_MANIFEST_BROKEN', `旧清单缺 files 数组：${abs}`, { manifest: abs }, 2);
  }
  return json;
}

function reconcileManifest(oldManifest, items) {
  const disk = new Set(items.map((i) => i.rel));
  const listed = new Set(oldManifest.files.map((f) => String(f.path)));
  const unlisted = Array.from(disk).filter((p) => !listed.has(p)).sort();
  const missing = Array.from(listed).filter((p) => !disk.has(p)).sort();
  if (unlisted.length) {
    fail('EVIDENCE_UNLISTED', `磁盘上有 ${unlisted.length} 件证据不在旧清单里（未写包）`, { count: unlisted.length, paths: unlisted.slice(0, 10) }, 2);
  }
  if (missing.length) {
    fail('EVIDENCE_MISSING', `旧清单里有 ${missing.length} 件证据磁盘上找不到（未写包）`, { count: missing.length, paths: missing.slice(0, 10) }, 2);
  }
}

function hardlinkOrCopy(src, dest) {
  try { fs.linkSync(src, dest); return 'link'; } catch {
    fs.copyFileSync(src, dest);
    try { const st = fs.statSync(src); fs.utimesSync(dest, st.atime, st.mtime); } catch { /* ignore */ }
    return 'copy';
  }
}

function sampleRssMB(pid) {
  try {
    const r = spawnSync('tasklist', ['/FI', `PID eq ${pid}`, '/FO', 'CSV', '/NH'], { encoding: 'utf8' });
    const line = String(r.stdout || '').trim().split(/\r?\n/)[0] || '';
    const cells = line.split('","').map((x) => x.replace(/^"|"$/g, ''));
    if (cells.length < 5) return null;
    const raw = cells[4].replace(/[^\d]/g, '');
    if (!raw) return null;
    return Math.round(Number(raw) / 1024);
  } catch { return null; }
}

function toPosix(p) { return String(p).replace(/\\/g, '/'); }

/**
 * 写 bsdtar 的 -T 列表。
 * 实测（2026-11-16，bsdtar 3.5.2 / Windows）：-T 列表按**系统 ANSI 代码页**解析，
 * 纯 UTF-8 中文名会报 "Couldn't visit directory"；带 BOM 会把名字按 ANSI 读成乱码。
 * 所以非 ASCII 场景用 PowerShell 把 UTF-8 列表转成 ANSI（[Text.Encoding]::Default）再交给 tar，
 * 并用 TextDecoder('gbk') 回读校验每个名字都能往返；往返不了直接失败，不静默丢件。
 */
function writeTarList(lines) {
  const utf8File = path.join(os.tmpdir(), `evidence-list-${process.pid}-${Date.now()}.utf8.txt`);
  fs.writeFileSync(utf8File, lines.join('\r\n') + '\r\n', 'utf8');
  const ascii = lines.every((l) => /^[\x00-\x7F]*$/.test(l));
  if (ascii) return { file: utf8File, extra: [], encoding: 'utf8' };
  const ansiFile = utf8File.replace(/\.utf8\.txt$/, '.ansi.txt');
  const ps = [
    "$ErrorActionPreference='Stop'",
    `[IO.File]::WriteAllText('${ansiFile.replace(/'/g, "''")}', [IO.File]::ReadAllText('${utf8File.replace(/'/g, "''")}', [Text.Encoding]::UTF8), [Text.Encoding]::Default)`,
  ].join('; ');
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', ps], { encoding: 'utf8' });
  if (r.status !== 0 || !fs.existsSync(ansiFile)) {
    fail('EVIDENCE_EXPORT_IO', '无法把文件名列表转换成系统 ANSI 代码页（bsdtar 只按 ANSI 读 -T）', {
      status: r.status, stderr: String(r.stderr || '').slice(-800),
    }, 2);
  }
  const back = new TextDecoder('gbk').decode(fs.readFileSync(ansiFile));
  const expected = lines.join('\r\n') + '\r\n';
  if (back.replace(/\r\n/g, '\n') !== expected.replace(/\r\n/g, '\n')) {
    const bad = lines.filter((l) => !back.includes(l)).slice(0, 5);
    fail('EVIDENCE_PATH_UNENCODABLE', '有文件名无法用系统 ANSI 代码页表示（bsdtar -T 限制），请改文件名后重试', {
      paths: bad, hint: '本机 bsdtar 3.5.2 按 ANSI 代码页读 -T 列表；emoji/生僻字需改成可表示的名字',
    }, 2);
  }
  return { file: ansiFile, extra: [utf8File], encoding: 'ansi', warning: { code: 'ansi_filename_encoding', detail: `本机 bsdtar 3.5.2 按 ANSI 代码页读 -T 列表，${lines.length} 个路径经 ANSI 转换后打包（zip 内同为 ANSI 字节，verify 往返一致）；要纯 UTF-8 zip 需换 libarchive 版本` } };
}

/** export 主流程。 */
export function exportEvidence(args) {
  const projectName = String(args.project || '');
  if (!projectName) fail('BAD_ARGS', '缺少 --project', { missing: ['project'] });
  const outArg = String(args.out || '');
  if (!outArg) fail('BAD_ARGS', '缺少 --out <zip 路径>', { missing: ['out'] });
  const projectDir = path.join(PATHS.projects, projectName);
  if (!fs.existsSync(projectDir)) fail('BAD_ARGS', `项目不存在：${projectName}`, { projectDir });
  const out = path.resolve(outArg);
  const outDir = path.dirname(out);
  if (!fs.existsSync(outDir)) fail('BAD_ARGS', `--out 的目录不存在：${outDir}`, { outDir });

  const since = parseSince(args.since);
  const cutoff = sinceCutoff(since);
  const all = Boolean(args.all);
  const maxArg = args['max-bytes'];
  const maxBytes = parseSize(maxArg, all ? null : DEFAULT_MAX_BYTES);
  if (maxBytes === null && !all) {
    fail('BAD_ARGS', `--max-bytes 格式不对：${maxArg}`, { maxBytes: maxArg, examples: ['524288000', '512MB', '1GB'] });
  }
  if (all && !maxArg) {
    fail('EVIDENCE_EXPORT_TOO_LARGE', '--all 必须同时显式给 --max-bytes（全量可能上 GB），本次未给', {
      hint: '先算体量：evidence export --all --max-bytes 2GB；或去掉 --all 走默认 30 天窗口',
    }, 2);
  }
  const strictSize = Boolean(args['strict-size']);
  const skipOversize = Boolean(args['skip-oversize']);
  let only = null;
  if (args.only) {
    const g = String(args.only);
    const re = '^' + g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '.*').replace(/\*/g, '[^/]*').replace(/\?/g, '.') + '$';
    try { only = new RegExp(re); } catch { only = null; }
  }

  const oldManifest = args.manifest ? readManifestFile(args.manifest) : null;
  const warnings = [];

  // 1) 范围 + 时间窗
  const rels = scanScope(projectDir, { only });
  let items = fileListOf(projectDir, rels).filter((i) => all || i.mtimeMs >= cutoff);

  // 2) --manifest 重放对账（仅此时判 UNLISTED/MISSING，零写入）
  if (oldManifest) reconcileManifest(oldManifest, items);

  // 3) 密钥闸（高置信拒包；宽词 warnings）
  for (const it of items) secretScanFile(it.rel, it.abs, warnings);

  // 4) 单件超限 + 总体积上限（按 mtime 倒序截断）
  if (maxBytes !== null) {
    const oversize = items.filter((i) => i.bytes > maxBytes);
    if (oversize.length) {
      if (!skipOversize) {
        fail('EVIDENCE_FILE_TOO_LARGE', `有 ${oversize.length} 件单件超过 --max-bytes(${maxBytes})，整包失败（不静默跳过）`, {
          maxBytes, files: oversize.slice(0, 10).map((i) => ({ path: i.rel, bytes: i.bytes })),
          hint: '给 --skip-oversize 跳过这些件（进 warnings），或调大 --max-bytes',
        }, 2);
      }
      for (const i of oversize) warnings.push({ code: 'oversize_skipped', path: i.rel, detail: `单件 ${i.bytes} 字节 > 上限 ${maxBytes}，已跳过` });
      items = items.filter((i) => i.bytes <= maxBytes);
    }
  }

  let truncated = false;
  let truncatedFiles = 0;
  let truncatedBytes = 0;
  if (maxBytes !== null) {
    const total = items.reduce((s, i) => s + i.bytes, 0);
    if (total > maxBytes) {
      if (strictSize) {
        fail('EVIDENCE_EXPORT_TOO_LARGE', `范围内证据共 ${total} 字节，超过 --max-bytes(${maxBytes})，--strict-size 直接失败（未写包）`, {
          totalBytes: total, maxBytes, files: items.length,
        }, 2);
      }
      const sorted = items.slice().sort((a, b) => b.mtimeMs - a.mtimeMs);
      const keep = [];
      let acc = 0;
      const drop = [];
      for (const it of sorted) {
        if (acc + it.bytes <= maxBytes) { keep.push(it); acc += it.bytes; } else { drop.push(it); }
      }
      truncated = drop.length > 0;
      truncatedFiles = drop.length;
      truncatedBytes = drop.reduce((s, i) => s + i.bytes, 0);
      items = keep.sort((a, b) => a.rel.localeCompare(b.rel));
      if (truncated) {
        warnings.push({ code: 'truncated_by_size', detail: `超过 --max-bytes(${maxBytes})，按 mtime 倒序保留 ${keep.length} 件，剔除 ${truncatedFiles} 件 / ${truncatedBytes} 字节` });
        process.stderr.write(`[evidence] 警告：体积超过上限 ${maxBytes}，已按 mtime 倒序截断 ${truncatedFiles} 件 / ${truncatedBytes} 字节（清单 flags.truncated=true）\n`);
      }
    }
  }

  const tar = requireTar();
  acquireExportLock(out);

  const stageDir = path.join(projectDir, `.evidence-stage-${process.pid}-${Date.now()}`);
  const listFiles = [];
  const startedAt = Date.now();
  let peakRss = 0;
  let peakSamples = 0;
  try {
    fs.mkdirSync(stageDir, { recursive: true });
    // 5) 逐件算 sha256（清单真相）+ 建 staging 硬链（同一卷，零拷贝）
    const files = [];
    const listLines = [];
    for (const it of items) {
      let sha;
      try { sha = hashFile(it.abs); } catch (e) {
        fail('EVIDENCE_EXPORT_IO', `读不出发证据文件：${it.rel}`, { path: it.rel, error: String(e && e.message || e) }, 2);
      }
      const dest = path.join(stageDir, it.rel);
      fs.mkdirSync(path.dirname(dest), { recursive: true });
      hardlinkOrCopy(it.abs, dest);
      files.push({ path: it.rel, bytes: it.bytes, sha256: sha, kind: it.kind, mtime: it.mtime });
      listLines.push(toPosix(it.rel));
    }
    const totals = {
      files: files.length,
      bytes: files.reduce((s, f) => s + f.bytes, 0),
      truncatedFiles,
      truncatedBytes,
    };
    const manifest = {
      version: MANIFEST_VERSION,
      project: projectName,
      exportedAt: nowIso(),
      tool: 'team.mjs evidence export (bsdtar)',
      sourceRoot: toPosix(projectDir),
      since: since.text,
      flags: { truncated, strictSize, noEvidence: files.length === 0 },
      totals,
      warnings,
      files,
    };
    fs.writeFileSync(path.join(stageDir, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
    listLines.push(MANIFEST_NAME);
    const listInfo = writeTarList(listLines);
    if (listInfo.warning) warnings.push(listInfo.warning);
    listFiles.push(listInfo.file, ...(listInfo.extra || []));
    const listFile = listInfo.file;

    // 6) bsdtar 打包（-T 显式列表，只写文件、不写目录条目；-v 逐行走 stderr，消费后每 5000 件打一行进度）
    const planned = items.map((i) => i.bytes);
    const sizeOf = (idx) => planned[idx] || 0;
    const result = spawnSync(tar, ['--format=zip', '-cf', out, '-v', '-T', listFile], {
      cwd: stageDir,
      encoding: 'utf8',
      maxBuffer: 256 * 1024 * 1024,
      timeout: EXPORT_TIMEOUT_MS,
    });
    const stderr = String(result.stderr || '');
    let seen = 0;
    let sent = 0;
    let bytesAcc = 0;
    for (const line of stderr.split(/\r?\n/)) {
      if (!line.trim()) continue;
      if (/^(tar\.exe:)/i.test(line.trim())) continue;
      seen += 1;
      bytesAcc += sizeOf(seen - 1);
      if (seen - sent >= PROGRESS_EVERY) {
        sent = seen;
        process.stderr.write(`progress: ${seen} files / ${bytesAcc} bytes\n`);
      }
    }
    if (result.error && result.error.code === 'ETIMEDOUT') {
      try { fs.unlinkSync(out); } catch { /* ignore */ }
      fail('EVIDENCE_EXPORT_TIMEOUT', `打包超时（${EXPORT_TIMEOUT_MS} ms），已删半成品；进度日志见上`, { timeoutMs: EXPORT_TIMEOUT_MS, files: files.length }, 2);
    }
    if (result.status !== 0) {
      try { fs.unlinkSync(out); } catch { /* ignore */ }
      fail('EVIDENCE_EXPORT_FAILED', `bsdtar 打包失败（exit=${result.status}），已删半成品`, { status: result.status, stderr: stderr.slice(-2000) }, 2);
    }
    // 7) 结果自检：zip 内文件数应 = 证据件数 + 清单
    const listOut = spawnSync(tar, ['-tf', out], { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
    const entries = String(listOut.stdout || '').split(/\r?\n/).filter(Boolean);
    const dirEntries = entries.filter((e) => /\/$/.test(e.trim()));
    if (dirEntries.length) {
      warnings.push({ code: 'dir_entries_present', detail: `zip 内出现 ${dirEntries.length} 个目录条目（应为 0）`, paths: dirEntries.slice(0, 5) });
    }
    const json = {
      ok: true,
      zip: out,
      manifestInsideZip: MANIFEST_NAME,
      totals,
      flags: manifest.flags,
      warnings,
      entries: entries.length,
      dirEntries: dirEntries.length,
      elapsedMs: Date.now() - startedAt,
      peakTreeRssMB: peakRss || null,
      peakSampledCount: peakSamples,
      sampledSpanMs: Date.now() - startedAt,
      truncated,
      truncatedFiles,
      truncatedBytes,
    };
    if (args.json) jsonOut(json);
    else {
      process.stdout.write([
        `已导出证据包：${out}`,
        `  条目 ${entries.length}（目录条目 ${dirEntries.length}）｜ 文件 ${totals.files} 件 / ${totals.bytes} 字节`,
        `  截断 ${truncated ? '是' : '否'}（剔除 ${truncatedFiles} 件 / ${truncatedBytes} 字节）｜ 警告 ${warnings.length} 条`,
        `  清单：zip 内 ${MANIFEST_NAME}（version ${MANIFEST_VERSION}）`,
      ].join('\n') + '\n');
    }
    return json;
  } catch (e) {
    try { if (fs.existsSync(out) && process.exitCode) fs.unlinkSync(out); } catch { /* ignore */ }
    throw e;
  } finally {
    releaseExportLock(out);
    try { fs.rmSync(stageDir, { recursive: true, force: true }); } catch { /* ignore */ }
    for (const f of listFiles) { try { fs.unlinkSync(f); } catch { /* ignore */ } }
  }
}

/** verify：解包到临时目录，逐件比 bytes/sha256，并列出 missing/mismatch/extra。 */
export function verifyEvidence(args) {
  const zipArg = String(args.zip || '');
  if (!zipArg) fail('BAD_ARGS', '缺少 --zip <zip 路径>', { missing: ['zip'] });
  const zip = path.resolve(zipArg);
  if (!fs.existsSync(zip)) fail('BAD_ARGS', `zip 不存在：${zip}`, { zip });
  const tar = requireTar();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'evidence-verify-'));
  try {
    const ex = spawnSync(tar, ['-xf', zip, '-C', tmp], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: EXPORT_TIMEOUT_MS });
    if (ex.status !== 0) {
      fail('EVIDENCE_MANIFEST_BROKEN', `zip 解不开：${zip}`, { status: ex.status, stderr: String(ex.stderr || '').slice(-1000) }, 2);
    }
    const manifestPath = path.join(tmp, MANIFEST_NAME);
    if (!fs.existsSync(manifestPath)) {
      fail('EVIDENCE_MANIFEST_MISSING', `zip 内没有 ${MANIFEST_NAME}`, { zip }, 2);
    }
    let manifest;
    try { manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8')); } catch (e) {
      fail('EVIDENCE_MANIFEST_BROKEN', `${MANIFEST_NAME} 不是合法 JSON`, { zip, error: String(e && e.message || e) }, 2);
    }
    if (!manifest || Number(manifest.version) !== MANIFEST_VERSION) {
      fail('EVIDENCE_MANIFEST_VERSION', `清单版本不兼容（期望 ${MANIFEST_VERSION}，实际 ${manifest && manifest.version}）`, { zip }, 2);
    }
    const files = Array.isArray(manifest.files) ? manifest.files : [];
    const missing = [];
    const mismatch = [];
    let okCount = 0;
    const listed = new Set(files.map((f) => String(f.path)));
    for (const f of files) {
      const rel = String(f.path);
      const abs = path.join(tmp, rel);
      if (!fs.existsSync(abs)) { missing.push({ path: rel, reason: 'not_in_zip' }); continue; }
      const st = fs.statSync(abs);
      const sha = hashFile(abs);
      if (st.size !== Number(f.bytes) || sha !== String(f.sha256)) {
        mismatch.push({ path: rel, expectedBytes: Number(f.bytes), actualBytes: st.size, expectedSha256: String(f.sha256), actualSha256: sha });
        continue;
      }
      okCount += 1;
    }
    const extra = [];
    const walkTmp = (dir, base) => {
      for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
        const abs = path.join(dir, e.name);
        const rel = toPosix(path.relative(base, abs));
        if (e.isDirectory()) walkTmp(abs, base);
        else if (rel !== MANIFEST_NAME && !listed.has(rel)) extra.push({ path: rel, reason: 'not_in_manifest' });
      }
    };
    walkTmp(tmp, tmp);
    const ok = missing.length === 0 && mismatch.length === 0 && extra.length === 0;
    const json = {
      ok,
      total: files.length,
      okCount,
      missing: missing.slice(0, 20),
      mismatch: mismatch.slice(0, 20),
      extra: extra.slice(0, 20),
      missingCount: missing.length,
      mismatchCount: mismatch.length,
      extraCount: extra.length,
      project: manifest.project,
      exportedAt: manifest.exportedAt,
    };
    if (args.json) jsonOut(json);
    else {
      process.stdout.write([
        `核对证据包：${zip}`,
        `  清单 ${files.length} 件 ｜ 一致 ${okCount} ｜ 缺件 ${missing.length} ｜ 不符 ${mismatch.length} ｜ 多出 ${extra.length}`,
        ...missing.slice(0, 20).map((m) => `  MISSING ${m.path}`),
        ...mismatch.slice(0, 20).map((m) => `  MISMATCH ${m.path}（期望 ${m.expectedBytes}B/${String(m.expectedSha256).slice(0, 12)}，实际 ${m.actualBytes}B/${String(m.actualSha256).slice(0, 12)}）`),
        ...extra.slice(0, 20).map((m) => `  EXTRA ${m.path}`),
        ok ? '  结论：通过' : '  结论：未通过（退出码 1）',
      ].join('\n') + '\n');
    }
    if (!ok) process.exitCode = 1;
    return json;
  } finally {
    try { fs.rmSync(tmp, { recursive: true, force: true }); } catch { /* ignore */ }
  }
}

export function cmdEvidence(args) {
  const sub = String((args._ && args._[1]) || '').toLowerCase();
  if (sub === 'export') return exportEvidence(args);
  if (sub === 'verify') return verifyEvidence(args);
  fail('BAD_ARGS', `未知 evidence 子命令：${sub || '(空)'}；可用 export | verify`, {
    sub, usage: ['evidence export --project P --out <zip>', 'evidence verify --zip <zip>'],
  });
  return null;
}
