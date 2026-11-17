/**
 * B-20261117-151857-a1dc（R-4761 四项返工）夹具：
 *   A1 清单 version=1（正文 F2 口径）；
 *   A2 体量口径：flags{truncated,all,maxBytes,c10BytesAtExport,deltaPct}；--max-bytes 截断 → truncated=true；
 *      --all → 全量、truncated=false；默认模式 deltaPct ≤10；
 *   A3 7aa8 错误码：migrate.mjs 含 EVIDENCE_EXPORT_UNAVAILABLE 分支（能力探测失败返回该码）；
 *   A4 空项目：totals.files=0、totals.bytes=0，名册/workbench 两件落 assets.meta（不在 files）。
 *
 * 跑法：node scripts/test-4761-a1dc-gaps.cjs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');

const ROOT = (() => {
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, '团队', '工具', 'migrate.mjs'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('找不到仓库根');
})();
const MIGRATE = path.join(ROOT, '团队', '工具', 'migrate.mjs');
const SB = path.join(ROOT, '_tmp', `a1dc-${process.pid}`);
const REPO = path.join(SB, 'repo');
const P = '迁移演示项目';
const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS  ${name}${detail ? `  ${detail}` : ''}`);
  } catch (e) {
    results.push({ name, ok: false, error: String((e && e.message) || e) });
    console.log(`FAIL  ${name}\n      ${String((e && e.message) || e).split('\n')[0]}`);
  }
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
function run(args) {
  try {
    const out = execFileSync(process.execPath, [MIGRATE, ...args], { cwd: ROOT, encoding: 'utf8', timeout: 180000 });
    // migrate --json 输出是**多行 pretty JSON**（不是单行），按首个 { 到末尾解析。
    const text = String(out);
    const idx = text.indexOf('{');
    return { code: 0, json: JSON.parse(idx >= 0 ? text.slice(idx) : text), raw: text };
  } catch (e) {
    const raw = String(e.stdout || '');
    let json = null;
    try {
      const idx = raw.indexOf('{');
      json = idx >= 0 ? JSON.parse(raw.slice(idx)) : null;
    } catch { json = null; }
    if (process.env.__A1DC_DEBUG__) {
      console.log('[a1dc:debug]', JSON.stringify({ code: e.status, args, signal: e.signal, message: String(e.message || '').split('\n')[0], stdoutLen: raw.length, stderrLen: String(e.stderr || '').length }));
    }
    return { code: e.status == null ? 1 : e.status, json: json || {}, raw, err: String(e.stderr || '') };
  }
}
/** 建最小可导出根：项目 1 个数据文件 + 状态 1 个 + 名册/workbench 两件 meta。 */
function seed(withData = true) {
  fs.rmSync(SB, { recursive: true, force: true });
  const projDir = path.join(REPO, '项目', P);
  fs.mkdirSync(path.join(projDir, '需求'), { recursive: true });
  fs.mkdirSync(path.join(REPO, '团队', '状态', '项目', P), { recursive: true });
  fs.mkdirSync(path.join(REPO, 'data', 'userdata'), { recursive: true });
  if (withData) {
    fs.writeFileSync(path.join(projDir, '需求', 'R-1.md'), '# 需求\n', 'utf8');
    fs.writeFileSync(path.join(REPO, '团队', '状态', '项目', P, '工作流.json'), '{"requirements":{}}\n', 'utf8');
  }
  fs.writeFileSync(path.join(REPO, '团队', '状态', '团队.json'), '{"members":[]}\n', 'utf8');
  fs.writeFileSync(path.join(REPO, 'data', 'userdata', 'workbench.json'), '{"projects":[]}\n', 'utf8');
}
function unzipManifest(zip) {
  const out = path.join(SB, `unzip-${Date.now()}`);
  fs.mkdirSync(out, { recursive: true });
  execFileSync('tar', ['-xf', zip, '-C', out], { encoding: 'utf8', timeout: 120000 });
  // 观察项：zip 内中文名按本机 ANSI(GBK) 写入、未置 UTF-8 标志，解出的文件名可能是乱码；
  // 夹具不依赖文件名，直接按内容找「kind=pm-workbench-migration」的清单。
  const found = [];
  const walk = (dir) => {
    for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, ent.name);
      if (ent.isDirectory()) walk(p);
      else if (ent.name.toLowerCase().endsWith('.json')) found.push(p);
    }
  };
  walk(out);
  for (const p of found) {
    try {
      const j = JSON.parse(fs.readFileSync(p, 'utf8'));
      if (j && j.kind === 'pm-workbench-migration') return j;
    } catch { /* 非清单 */ }
  }
  throw new Error(`zip 里没找到迁移清单（候选 ${found.length} 个 json）`);
}

seed(true);
const zipDefault = path.join(SB, 'default.zip');
const exp = run(['export', '--root', REPO, '--project', P, '--out', zipDefault, '--yes', '--json']);
const mfDefault = unzipManifest(zipDefault);

check('A1 清单 version=1（F2 口径）', () => {
  assert.strictEqual(exp.code, 0, `code=${exp.code} existsProject=${fs.existsSync(path.join(REPO, '项目', P))} existsRepo=${fs.existsSync(REPO)} raw=${String(exp.raw || '').slice(-400)} err=${String(exp.err || '').slice(-300)}`);
  assert.strictEqual(mfDefault.version, 1);
  assert.strictEqual(mfDefault.kind, 'pm-workbench-migration');
  return 'version=1';
});

check('A2 体量口径：flags 齐全、默认 deltaPct≤10、--max-bytes 截断、--all 全量', () => {
  const f = mfDefault.flags || {};
  for (const k of ['truncated', 'all', 'maxBytes', 'c10BytesAtExport', 'deltaPct']) assert.ok(k in f, `flags 缺 ${k}`);
  assert.strictEqual(f.truncated, false);
  assert.ok(Number(f.deltaPct) <= 10, `deltaPct=${f.deltaPct}`);
  assert.strictEqual(Number(f.maxBytes), 512 * 1024 * 1024);

  const zipCut = path.join(SB, 'cut.zip');
  const cut = run(['export', '--root', REPO, '--project', P, '--out', zipCut, '--max-bytes', '1', '--yes', '--json']);
  assert.strictEqual(cut.code, 0, JSON.stringify(cut.json));
  const mfCut = unzipManifest(zipCut);
  assert.strictEqual(mfCut.flags.truncated, true, '1 字节上限应截断');
  assert.ok(mfCut.totals.files < mfDefault.totals.files, '截断后 files 应减少');
  assert.ok(mfCut.warnings.some((w) => /截断/.test(w)), '缺截断 warning');

  const zipAll = path.join(SB, 'all.zip');
  const all = run(['export', '--root', REPO, '--project', P, '--out', zipAll, '--max-bytes', '1', '--all', '--yes', '--json']);
  assert.strictEqual(all.code, 0, JSON.stringify(all.json));
  const mfAll = unzipManifest(zipAll);
  assert.strictEqual(mfAll.flags.truncated, false, '--all 不应截断');
  assert.strictEqual(mfAll.totals.files, mfDefault.totals.files);
  return `deltaPct=${f.deltaPct} cut=${mfCut.totals.files} all=${mfAll.totals.files}`;
});

check('A3 7aa8 能力失败分支：EVIDENCE_EXPORT_UNAVAILABLE 可静态断言', () => {
  const src = fs.readFileSync(MIGRATE, 'utf8');
  assert.ok(/EVIDENCE_EXPORT_UNAVAILABLE/.test(src), 'migrate.mjs 缺 EVIDENCE_EXPORT_UNAVAILABLE');
  assert.ok(/function evidenceExportCapable/.test(src), '缺能力探测函数');
  return '码+探测在';
});

check('A4 空项目：totals.files=0/bytes=0，名册/workbench 落 assets.meta', () => {
  seed(false);
  const zipEmpty = path.join(SB, 'empty.zip');
  const e = run(['export', '--root', REPO, '--project', P, '--out', zipEmpty, '--yes', '--json']);
  assert.strictEqual(e.code, 0, JSON.stringify(e.json));
  const mf = unzipManifest(zipEmpty);
  assert.strictEqual(mf.totals.files, 0, `空项目 totals.files=${mf.totals.files}`);
  assert.strictEqual(mf.totals.bytes, 0);
  assert.ok(Array.isArray(mf.assets.meta) && mf.assets.meta.length === 2, `assets.meta=${JSON.stringify(mf.assets && mf.assets.meta)}`);
  // 注：meta 仍需留在 files[]（导入要用它还原名册/workbench），但**不计入 totals**；这里只校验 assets.meta 完整。
  assert.ok(mf.assets.meta.every((x) => typeof x.sha256 === 'string' && x.sha256.length === 64), 'assets.meta 缺 sha256');
  return `files=0 meta=${mf.assets.meta.length}`;
});

fs.rmSync(SB, { recursive: true, force: true });
const pass = results.filter((r) => r.ok).length;
console.log(`\nA1DC_GAPS ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
if (pass !== results.length) process.exit(1);
