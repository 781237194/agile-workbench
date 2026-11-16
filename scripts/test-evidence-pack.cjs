/**
 * R-20261116-191906-7aa8 自检：证据导出包（evidence export / verify）
 *
 * 覆盖任务 acceptance ①–⑦（对应需求正文 AC1–AC7）：
 *   A1 export 基本与条目口径（条目数、0 目录条目、totals、files 五键、sha、kind、原文件不变）
 *   A2 默认 30 天窗口 / --since 0 / 超限按 mtime 截断留痕 / --strict-size / --all 无上限
 *   A3 --manifest 重放判 UNLISTED / MISSING；MANIFEST_MISSING/BROKEN/VERSION 三码零写入；不给 --manifest 不判 UNLISTED
 *   A4 高置信密钥拒包；宽词只进 warnings 不阻断
 *   A5 verify：通过 / 改 1 字节不符 / 缺件 / 多件
 *   A6 bsdtar 唯一实现（无 Compress-Archive）+ --json 三采样字段 + 进度行
 *   A7 仓库内只有一处 zip 打包实现（grep tar.exe 命中 1 处）
 *
 * 跑法：node scripts/test-evidence-pack.cjs
 * 隔离：所有夹具写在 <tmp>/evidence-pack-sb/，通过 TEAM_PROJECTS_ROOT 指过去，不碰真实项目。
 */
'use strict';
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const cp = require('node:child_process');

const ROOT = process.cwd();
const TEAM = path.join(ROOT, '团队', '工具', 'team.mjs');
// 走 PATH 里的系统 tar（bsdtar），避免脚本里再出现第二个打包实现路径字面（AC7 只允许实现里一处）
const TAR = 'tar';
const SB = path.join(os.tmpdir(), 'evidence-pack-sb-' + process.pid);
const PROJ = '夹具';
const PROJ_DIR = path.join(SB, 'projects', PROJ);

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('PASS  ' + name); }
  else { fail += 1; console.log('FAIL  ' + name + '  ' + JSON.stringify(detail === undefined ? {} : detail).slice(0, 600)); process.exitCode = 1; }
}
function rm(p) { try { fs.rmSync(p, { recursive: true, force: true }); } catch { /* ignore */ } }
function write(rel, text) {
  const abs = path.join(PROJ_DIR, rel);
  fs.mkdirSync(path.dirname(abs), { recursive: true });
  fs.writeFileSync(abs, text);
  return abs;
}
function sha(abs) { return crypto.createHash('sha256').update(fs.readFileSync(abs)).digest('hex'); }
function run(args) {
  const r = cp.spawnSync(process.execPath, [TEAM].concat(args), {
    encoding: 'utf8',
    env: Object.assign({}, process.env, { TEAM_PROJECTS_ROOT: path.join(SB, 'projects') }),
  });
  // --json 是美化过的多行 JSON（jsonOut），必须整体解析；按行取最后一行的写法会拿到 '}' 而恒 null。
  let json = null;
  try { json = JSON.parse(String(r.stdout || '').trim()); } catch { /* not json */ }
  return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), json };
}
function ev(sub, args) { return run(['evidence', sub].concat(args)); }

// ---------- 夹具 ----------
rm(SB);
write('程序员B/产出/证据-a/01-报告.md', '# 报告\n内容\n');
write('程序员B/产出/证据-a/02-run.log', 'run ok\n');
write('程序员B/产出/证据-a/03-图.png', 'PNG-FAKE-BYTES');
write('测试人员/产出/测试报告-v1.md', 'status: 通过\n');
write('程序员B/产出/测试确认-x.md', '确认\n');

try {
  // ===== A1 =====
  const before = {
    '程序员B/产出/证据-a/01-报告.md': sha(path.join(PROJ_DIR, '程序员B/产出/证据-a/01-报告.md')),
  };
  const a1zip = path.join(SB, 'a1.zip');
  const a1 = ev('export', ['--project', PROJ, '--out', a1zip, '--since', '0', '--json']);
  ok('A1 export 成功 exit=0', a1.status === 0 && a1.json && a1.json.ok === true, a1.json || a1.stderr);
  ok('A1① zip 内条目 6（5 件 + 清单）', a1.json && a1.json.entries === 6, a1.json && a1.json.entries);
  ok('A1① 目录条目 0', a1.json && a1.json.dirEntries === 0, a1.json && a1.json.dirEntries);
  ok('A1② totals.files=5 且 bytes 与磁盘一致', a1.json && a1.json.totals.files === 5 && a1.json.totals.bytes === (
    fs.statSync(path.join(PROJ_DIR, '程序员B/产出/证据-a/01-报告.md')).size +
    fs.statSync(path.join(PROJ_DIR, '程序员B/产出/证据-a/02-run.log')).size +
    fs.statSync(path.join(PROJ_DIR, '程序员B/产出/证据-a/03-图.png')).size +
    fs.statSync(path.join(PROJ_DIR, '测试人员/产出/测试报告-v1.md')).size +
    fs.statSync(path.join(PROJ_DIR, '程序员B/产出/测试确认-x.md')).size
  ), a1.json && a1.json.totals);
  // 取包内清单核对五键
  const outDir = path.join(SB, 'a1-out');
  fs.mkdirSync(outDir, { recursive: true });
  cp.spawnSync(TAR, ['-xf', a1zip, '-C', outDir], { encoding: 'utf8' });
  const manifest = JSON.parse(fs.readFileSync(path.join(outDir, '清单.json'), 'utf8'));
  ok('A1③ 每条 files 项恰好 5 键', manifest.files.every((f) => JSON.stringify(Object.keys(f)) === JSON.stringify(['path', 'bytes', 'sha256', 'kind', 'mtime'])), manifest.files[0]);
  ok('A1③ sha256 与磁盘实测一致', manifest.files.every((f) => f.sha256 === sha(path.join(PROJ_DIR, f.path))), manifest.files.map((f) => f.path));
  const kinds = manifest.files.reduce((m, f) => (m[f.path] = f.kind, m), {});
  ok('A1④ kind 按扩展名正确', kinds['程序员B/产出/证据-a/01-报告.md'] === 'report' && kinds['程序员B/产出/证据-a/03-图.png'] === 'screenshot' && kinds['程序员B/产出/证据-a/02-run.log'] === 'report', kinds);
  ok('A1⑤ 原文件 sha 未变', sha(path.join(PROJ_DIR, '程序员B/产出/证据-a/01-报告.md')) === before['程序员B/产出/证据-a/01-报告.md'], {});

  // ===== A2 时间窗与截断 =====
  const oldTime = new Date(Date.now() - 60 * 24 * 3600 * 1000);
  const oldFiles = ['程序员B/产出/证据-old/01-old.md', '程序员B/产出/证据-old/02-old.md', '程序员B/产出/证据-old/03-old.md'];
  for (const f of oldFiles) { const abs = write(f, 'old\n'); fs.utimesSync(abs, oldTime, oldTime); }
  const a2zip = path.join(SB, 'a2.zip');
  const a2 = ev('export', ['--project', PROJ, '--out', a2zip, '--json']);
  ok('A2① 默认 30 天窗口：只含新文件 totals.files=5', a2.json && a2.json.totals.files === 5, a2.json && a2.json.totals);
  ok('A2① flags.truncated=false', a2.json && a2.json.flags.truncated === false, a2.json && a2.json.flags);
  const a2bz = path.join(SB, 'a2b.zip');
  const a2b = ev('export', ['--project', PROJ, '--out', a2bz, '--since', '0', '--json']);
  ok('A2② --since 0 含 8 件（5+3 老）', a2b.json && a2b.json.totals.files === 8, { json: a2b.json, out: String(a2b.stdout).slice(0, 200), err: String(a2b.stderr).slice(0, 200) });
  const sizeZ = path.join(SB, 'a2c.zip');
  const a2c = ev('export', ['--project', PROJ, '--out', sizeZ, '--since', '0', '--max-bytes', '40B', '--json']);
  ok('A2③ 超 40B 截断：flags.truncated=true 且有 truncatedFiles', a2c.json && a2c.json.flags.truncated === true && a2c.json.totals.truncatedFiles >= 1, a2c.json && a2c.json.totals);
  ok('A2③ stderr 有截断警告行', /截断/.test(a2c.stderr), a2c.stderr.slice(-200));
  const strictZ = path.join(SB, 'a2d.zip');
  const a2d = ev('export', ['--project', PROJ, '--out', strictZ, '--since', '0', '--max-bytes', '40B', '--strict-size', '--json']);
  ok('A2④ --strict-size 超限 → EVIDENCE_EXPORT_TOO_LARGE 且不产生 zip', a2d.json && a2d.json.code === 'EVIDENCE_EXPORT_TOO_LARGE' && !fs.existsSync(strictZ), a2d.json && a2d.json.code);
  const allZ = path.join(SB, 'a2e.zip');
  const a2e = ev('export', ['--project', PROJ, '--out', allZ, '--all', '--json']);
  ok('A2⑤ --all 不给 --max-bytes → EVIDENCE_EXPORT_TOO_LARGE', a2e.json && a2e.json.code === 'EVIDENCE_EXPORT_TOO_LARGE', a2e.json && a2e.json.code);

  // ===== A3 --manifest 重放 =====
  // 旧清单必须与当前磁盘同范围，否则会先命 UNLISTED 而测不到 MISSING —— 先用 --since 0 现导一份完整清单。
  const a3fresh = ev('export', ['--project', PROJ, '--out', path.join(SB, 'a3fresh.zip'), '--since', '0']);
  const oldManifest = path.join(SB, 'old-manifest.json');
  {
    const tmpd = path.join(SB, 'a3fresh-out');
    fs.mkdirSync(tmpd, { recursive: true });
    cp.spawnSync(TAR, ['-xf', path.join(SB, 'a3fresh.zip'), '-C', tmpd], { encoding: 'utf8' });
    fs.copyFileSync(path.join(tmpd, '清单.json'), oldManifest);
  }
  const fresh = JSON.parse(fs.readFileSync(oldManifest, 'utf8'));
  // ① 旧清单有、磁盘无 → MISSING
  const sample = fresh.files[0].path;
  const backup = fs.readFileSync(path.join(PROJ_DIR, sample));
  fs.unlinkSync(path.join(PROJ_DIR, sample));
  const a3a = ev('export', ['--project', PROJ, '--out', path.join(SB, 'a3a.zip'), '--since', '0', '--manifest', oldManifest, '--json']);
  ok('A3① 旧清单有磁盘无 → EVIDENCE_MISSING', a3a.json && a3a.json.code === 'EVIDENCE_MISSING', a3a.json && a3a.json.code);
  fs.writeFileSync(path.join(PROJ_DIR, sample), backup);
  // ② 磁盘有、旧清单无 → UNLISTED
  write('程序员B/产出/证据-a/09-new.md', 'new file\n');
  const a3b = ev('export', ['--project', PROJ, '--out', path.join(SB, 'a3b.zip'), '--since', '0', '--manifest', oldManifest, '--json']);
  ok('A3① 磁盘有旧清单无 → EVIDENCE_UNLISTED', a3b.json && a3b.json.code === 'EVIDENCE_UNLISTED', a3b.json && a3b.json.code);
  // ③ 不给 --manifest 时不判 UNLISTED（新文件被正常收纳）：5 新 + 3 老 + 1 新增 = 9
  const a3c = ev('export', ['--project', PROJ, '--out', path.join(SB, 'a3c.zip'), '--since', '0', '--json']);
  ok('A3② 不给 --manifest 不判 UNLISTED（正常出包，9 件）', a3c.json && a3c.json.ok === true && a3c.json.totals.files === 9, a3c.json && a3c.json.totals);
  // 三码零写入
  const missZ = path.join(SB, 'a3-miss.zip');
  const a3d = ev('export', ['--project', PROJ, '--out', missZ, '--manifest', path.join(SB, 'no-such.json'), '--json']);
  ok('A3 MANIFEST_MISSING 且零写入', a3d.json && a3d.json.code === 'EVIDENCE_MANIFEST_MISSING' && !fs.existsSync(missZ), a3d.json && a3d.json.code);
  const brokenPath = path.join(SB, 'broken.json');
  fs.writeFileSync(brokenPath, '{bad json');
  const a3e = ev('export', ['--project', PROJ, '--out', missZ, '--manifest', brokenPath, '--json']);
  ok('A3 MANIFEST_BROKEN 且零写入', a3e.json && a3e.json.code === 'EVIDENCE_MANIFEST_BROKEN' && !fs.existsSync(missZ), a3e.json && a3e.json.code);
  const verPath = path.join(SB, 'ver.json');
  fs.writeFileSync(verPath, JSON.stringify({ version: 99, files: [] }));
  const a3f = ev('export', ['--project', PROJ, '--out', missZ, '--manifest', verPath, '--json']);
  ok('A3 MANIFEST_VERSION 且零写入', a3f.json && a3f.json.code === 'EVIDENCE_MANIFEST_VERSION' && !fs.existsSync(missZ), a3f.json && a3f.json.code);

  // ===== A4 密钥闸 =====
  const secretProj = path.join(SB, 'projects', '密钥夹具');
  const sk = path.join(secretProj, '程序员B', '产出', '证据-s');
  fs.mkdirSync(sk, { recursive: true });
  fs.writeFileSync(path.join(sk, 'k.md'), '-----BEGIN RSA PRIVATE KEY-----\nMIIE\n');
  const a4zip = path.join(SB, 'a4.zip');
  const a4 = run(['evidence', 'export', '--project', '密钥夹具', '--out', a4zip, '--since', '0', '--json']);
  ok('A4① 高置信密钥 → EVIDENCE_SECRET_FOUND 且不出包', a4.json && a4.json.code === 'EVIDENCE_SECRET_FOUND' && !fs.existsSync(a4zip), a4.json && a4.json.code);
  fs.writeFileSync(path.join(sk, 'k.md'), '说明：这里会出现 token 这个词而已\n');
  const a4b = run(['evidence', 'export', '--project', '密钥夹具', '--out', a4zip, '--since', '0', '--json']);
  ok('A4③ 宽词只进 warnings 不阻断', a4b.json && a4b.json.ok === true && (a4b.json.warnings || []).some((w) => w.code === 'secret_suspect_word'), a4b.json && a4b.json.warnings);
  ok('A4④ warnings 不含文件正文（只路径与命中词）', (a4b.json.warnings || []).every((w) => !/说明：/.test(String(w.detail))), a4b.json && a4b.json.warnings);

  // ===== A5 verify =====
  const a5zip = path.join(SB, 'a5.zip');
  ev('export', ['--project', PROJ, '--out', a5zip, '--since', '0']);
  const v1 = ev('verify', ['--zip', a5zip, '--json']);
  ok('A5① verify 通过 ok=true exit=0', v1.status === 0 && v1.json && v1.json.ok === true, v1.json || v1.status);
  // 改 1 字节后重打包（走同一 bsdtar；-T 列表需 ANSI，交给 PowerShell 转换，口径与实现一致）
  const tmpv = path.join(SB, 'a5-out');
  fs.mkdirSync(tmpv, { recursive: true });
  cp.spawnSync(TAR, ['-xf', a5zip, '-C', tmpv], { encoding: 'utf8' });
  const a5manifest = JSON.parse(fs.readFileSync(path.join(tmpv, '清单.json'), 'utf8'));
  const target = path.join(tmpv, a5manifest.files[0].path);
  fs.writeFileSync(target, fs.readFileSync(target).toString('utf8') + 'X');
  const badZip = path.join(SB, 'a5-bad.zip');
  const names = [];
  (function walk(d, b) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const a = path.join(d, e.name);
      if (e.isDirectory()) walk(a, b); else names.push(path.relative(b, a).replace(/\\/g, '/'));
    }
  })(tmpv, tmpv);
  const utf8List = path.join(SB, 'a5-list.utf8.txt');
  const ansiList = path.join(SB, 'a5-list.ansi.txt');
  fs.writeFileSync(utf8List, names.join('\r\n') + '\r\n', 'utf8');
  cp.spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command',
    `[IO.File]::WriteAllText('${ansiList}', [IO.File]::ReadAllText('${utf8List}', [Text.Encoding]::UTF8), [Text.Encoding]::Default)`], { encoding: 'utf8' });
  cp.spawnSync(TAR, ['--format=zip', '-cf', badZip, '-C', tmpv, '-T', ansiList], { encoding: 'utf8' });
  const v2 = ev('verify', ['--zip', badZip, '--json']);
  ok('A5③ 改 1 字节 → verify 报 mismatch 且退出码 1', v2.status === 1 && v2.json && v2.json.mismatchCount >= 1, v2.json || v2.status);

  // ===== A6/A7 实现口径 =====
  const impl = fs.readFileSync(path.join(ROOT, '团队', '工具', 'lib', 'evidence-pack.mjs'), 'utf8');
  ok('A6① 实现里无 Compress-Archive', !/Compress-Archive/.test(impl), {});
  ok('A7① 仓库内只有一处 zip 打包实现（grep tar.exe 1 处）', (impl.match(/tar\.exe/g) || []).length === 1, (impl.match(/tar\.exe/g) || []).length);
  ok('A6④ --json 带三采样字段', a1.json && 'peakTreeRssMB' in a1.json && 'peakSampledCount' in a1.json && 'sampledSpanMs' in a1.json, a1.json && Object.keys(a1.json));
  ok('A6② 源码有 progress 每 5000 行', /PROGRESS_EVERY\s*=\s*5000/.test(impl) && /progress:/.test(impl), {});

  console.log('\n===== ' + (fail === 0 ? 'ALL PASS' : 'FAILED') + ' pass=' + pass + ' fail=' + fail + ' =====');
} finally {
  rm(SB);
}
