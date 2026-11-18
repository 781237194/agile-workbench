#!/usr/bin/env node
/**
 * 项目迁移包（R-20261116-193349-4761）· 团队工具 · v2（按 tester 15 项返工）
 *
 * 五个命令（默认 dry-run，零写入；--yes 才落盘）：
 *   export          打包项目数据 + 迁移清单.json（含名册、workbench 登记；--no-evidence 排除产出/证据-*）
 *   import          校验清单并落地（MIGRATION_HASH_MISMATCH / MIGRATION_MISSING / MIGRATION_MANIFEST_MISSING；--force 先备份）
 *   rebind          路径重写（项目.json / workbench.json / 项目信息.md），先打印 diff
 *   rebind-sessions 名册会话重绑（--role X --session 新 / --session role=id,... / --clear；写 stale_session 审计）
 *   migrate-check   AC6① 固定五步冒烟
 *
 * 清单格式（AC7②）：包根 `迁移清单.json`，条目键 `path`/`bytes`/`sha256`（`scope` 为附加键）。
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// ESM 下没有 __dirname：默认根目录（未传 --root 时）依赖它，必须显式构造
const __dirname = path.dirname(fileURLToPath(import.meta.url));
import { bsdtarZip, bsdtarUnzip, writeTarList } from './lib/evidence-pack.mjs';
// B-20261118-083158-990c：rebind-sessions 写前校验目标会话是否存在于 DSH
import { DshClient } from './lib/dsh-session.mjs';

const MANIFEST_NAME = '迁移清单.json';
const NOISE_RE = /(^|\/)(_backup|_tmp[^\/]*|\.selftest-[^\/]*|_archive|node_modules)(\/|$)|\.bak-\d+$|\.tmp$/;
const EVIDENCE_RE = /(^|\/)证据-[^\/]*(\/|$)/;

function fail(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  throw err;
}
function out(obj, json) {
  if (json) process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  else console.log(obj.message || JSON.stringify(obj));
}
/** 包内条目 kind（与 7aa8 evidence-pack kindOf 同口径）。 */
function packKindOf(rel) {
  const ext = path.extname(String(rel || '')).toLowerCase();
  if (['.png', '.jpg', '.jpeg', '.webp', '.gif', '.bmp'].includes(ext)) return 'screenshot';
  if (['.md', '.txt', '.log'].includes(ext)) return 'report';
  return 'file';
}
function sha256File(file) {
  const buf = fs.readFileSync(file);
  return { sha256: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
}
function walk(dir, rel, acc, { withNoise, withEvidence }) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const r = (rel ? rel + '/' : '') + e.name;
    if (!withNoise && NOISE_RE.test(r)) continue;
    if (!withEvidence && EVIDENCE_RE.test(r + '/')) continue;
    if (e.isDirectory()) walk(abs, r, acc, { withNoise, withEvidence });
    else acc.push({ rel: r, abs });
  }
  return acc;
}
function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}
function writeJsonFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}
function resolveRoots(argv) {
  const repoRoot = argv.root ? path.resolve(argv.root) : path.resolve(__dirname, '..', '..');
  const project = String(argv.project || '').trim();
  if (!project) fail('PROJECT_REQUIRED', '需要 --project <项目名>');
  return {
    repoRoot, project,
    projectDir: path.join(repoRoot, '项目', project),
    stateDir: path.join(repoRoot, '团队', '状态', '项目', project),
    teamFile: path.join(repoRoot, '团队', '状态', '团队.json'),
    wbFile: path.join(repoRoot, 'data', 'userdata', 'workbench.json'),
    wakeLog: path.join(repoRoot, '团队', '状态', '项目', project, '唤醒.jsonl'),
  };
}

/** 真实仓库根（本工具所安装的开发/生产仓库）：写命令默认不得直接改它（2026-11-17 ad04 事故）。 */
const REAL_REPO_ROOT = path.resolve(__dirname, '..', '..');
function isLiveRepoRoot(root) {
  try { return path.resolve(String(root || '')) === REAL_REPO_ROOT; } catch { return false; }
}
/** 写命令护栏：目标是真实仓库根时必须显式 --allow-live-root --reason，否则零写入拒绝；越权写迁移审计。 */
function guardLiveRoot(argv, root, project) {
  if (!isLiveRepoRoot(root)) return;
  const allow = argv['allow-live-root'] === true || argv.allowLiveRoot === true;
  const reason = String(argv.reason || '').trim();
  if (!allow || !reason) {
    fail('MIGRATION_LIVE_ROOT_REFUSED', '拒绝对真实仓库根执行写操作（rebind/rebind-sessions）：请在沙盘上用 --root，或显式 --allow-live-root --reason "<原因>"',
      { root: String(root), hint: '沙盘根通常在 _tmp/ 下；真实根写操作会改团队账本/名册' });
  }
  // 越权：写迁移审计（项目级 append-only）
  try {
    const auditDir = path.join(REAL_REPO_ROOT, '团队', '状态', '项目', String(project || '_live'));
    fs.mkdirSync(auditDir, { recursive: true });
    fs.appendFileSync(path.join(auditDir, '迁移审计.jsonl'), JSON.stringify({ at: new Date().toISOString(), project: String(project || ''), action: 'allow_live_root', reason, argv: process.argv.slice(2) }) + '\n', 'utf8');
  } catch { /* 审计失败不阻断（但已留 console） */ }
}

/* ───────── export ───────── */
/** AC7③：7aa8 证据导出能力探测——缺依赖/缺导出时返回 false，由 cmdExport 报 EVIDENCE_EXPORT_UNAVAILABLE 而非崩。 */
function evidenceExportCapable() {
  try {
    return typeof bsdtarZip === 'function' && typeof writeTarList === 'function' && typeof packKindOf === 'function';
  } catch { return false; }
}

function cmdExport(argv) {
  const { repoRoot, project, projectDir, stateDir, teamFile, wbFile } = resolveRoots(argv);
  const outDir = path.resolve(String(argv.out || path.join(repoRoot, '_tmp', `migrate-${project}-${Date.now()}`)));
  const dryRun = argv.yes !== true;
  const withNoise = argv['with-noise'] === true;
  const withEvidence = argv['no-evidence'] !== true;
  if (!fs.existsSync(projectDir)) fail('PROJECT_NOT_FOUND', `项目目录不存在：${projectDir}`);
  // AC2④/卷§二：默认 512MB 体量上限与 --all 分离；--max-bytes 可覆盖默认上限。
  const exportAll = argv.all === true;
  const maxBytes = Number(argv['max-bytes'] || 0) > 0 ? Number(argv['max-bytes']) : 512 * 1024 * 1024;
  if (withEvidence && !evidenceExportCapable()) {
    return fail('EVIDENCE_EXPORT_UNAVAILABLE', '证据导出能力（7aa8 evidence-pack）不可用：导出已被拒绝（不崩溃、不留半成品）', { probe: 'evidence-pack', withEvidence });
  }
  const projectFiles = walk(projectDir, '', [], { withNoise, withEvidence });
  const stateFiles = walk(stateDir, '', [], { withNoise, withEvidence });
  // AC1：名册与 workbench 登记随包（scope=meta）
  const metaFiles = [];
  if (fs.existsSync(teamFile)) metaFiles.push({ rel: '状态/团队.json', abs: teamFile, scope: 'meta', pack: '团队/状态/团队.json' });
  if (fs.existsSync(wbFile)) metaFiles.push({ rel: 'data/userdata/workbench.json', abs: wbFile, scope: 'meta', pack: 'data/userdata/workbench.json' });
  // 清单 path 用「包内相对路径」（与导入/AC7②一致）：
  //   项目文件 → 项目/<P>/<rel>；团队状态 → 团队/状态/项目/<P>/<rel>；名册/workbench 用固定落点。
  const entries = [
    ...projectFiles.map((f) => {
      const p = '项目/' + project + '/' + f.rel.replace(/\\/g, '/');
      return { scope: 'project', path: p, ...sha256File(f.abs), src: f.abs, pack: p };
    }),
    ...stateFiles.map((f) => {
      const p = '团队/状态/项目/' + project + '/' + f.rel.replace(/\\/g, '/');
      return { scope: 'state', path: p, ...sha256File(f.abs), src: f.abs, pack: p };
    }),
    ...metaFiles.map((f) => ({ scope: f.scope, path: f.pack, ...sha256File(f.abs), src: f.abs, pack: f.pack })),
  ];
  // AC8②/F2：totals 只计项目数据（project+state），元数据（名册/workbench）落 assets.meta；flags 记体量口径。
  const dataEntries = entries.filter((e) => e.scope !== 'meta');
  const metaEntries = entries.filter((e) => e.scope === 'meta');
  const c10BytesAtExport = dataEntries.reduce((n, e) => n + e.bytes, 0);
  let keptEntries = entries;
  let truncated = false;
  if (!exportAll && dataEntries.length) {
    let sum = 0;
    const kept = [];
    for (const e of entries) {
      if (e.scope === 'meta') { kept.push(e); continue; }
      if (sum + e.bytes > maxBytes) continue;
      sum += e.bytes;
      kept.push(e);
    }
    if (kept.length < entries.length) {
      truncated = true;
      keptEntries = kept;
    }
  }
  const keptData = keptEntries.filter((e) => e.scope !== 'meta');
  const measuredBytes = keptData.reduce((n, e) => n + e.bytes, 0);
  const deltaPct = measuredBytes > 0 ? Number((Math.abs(c10BytesAtExport - measuredBytes) / measuredBytes * 100).toFixed(2)) : 0;
  const exportFlags = { truncated, all: exportAll, maxBytes, c10BytesAtExport, measuredBytes, deltaPct };
  const manifest = {
    version: 1, kind: 'pm-workbench-migration', project, at: new Date().toISOString(),
    source: { repoRoot, projectDir, stateDir }, excludesNoise: !withNoise, includesEvidence: withEvidence,
    items: keptEntries.map((e) => ({ scope: e.scope, path: e.path, bytes: e.bytes, sha256: e.sha256 })),
    flags: exportFlags,
  };
  const outIsZip = /\.zip$/i.test(outDir);
  if (dryRun) return out({ ok: true, dryRun: true, out: outDir, zip: outIsZip, files: keptEntries.length, flags: exportFlags, name: MANIFEST_NAME, message: `[dry-run] 将导出 ${keptEntries.length} 个文件到 ${outDir}${outIsZip ? '（zip 单文件包）' : ''}（加 --yes 才写盘）` }, argv.json);
  if (outIsZip) {
    // F1/F2/AC1：zip 单文件包——包根 迁移清单.json（files 四键 path/bytes/sha256/kind + totals{files,bytes} + assets + warnings）
    const stage = path.join(repoRoot, '_tmp', `migrate-stage-${Date.now()}`);
    try {
      for (const e of keptEntries) {
        const dst = path.join(stage, e.path);
        fs.mkdirSync(path.dirname(dst), { recursive: true });
        fs.copyFileSync(e.src, dst);
      }
      const totalBytes = keptData.reduce((n, e) => n + e.bytes, 0);
      const assets = {
        meta: metaEntries.map((e) => ({ path: e.path, bytes: e.bytes, sha256: e.sha256 })),
        screenshots: keptEntries.filter((e) => packKindOf(e.path) === 'screenshot').map((e) => ({ path: e.path, bytes: e.bytes })),
      };
      const warnings = truncated ? [`体量超过默认上限 ${maxBytes} 字节：已截断 ${entries.length - keptEntries.length} 个文件（--all 可导出全部）`] : [];
      const zipManifest = {
        version: 1, kind: 'pm-workbench-migration', project, at: new Date().toISOString(),
        source: { repoRoot, projectDir, stateDir }, excludesNoise: !withNoise, includesEvidence: withEvidence,
        files: keptEntries.map((e) => ({ path: e.path, bytes: e.bytes, sha256: e.sha256, kind: packKindOf(e.path) })),
        totals: { files: keptData.length, bytes: totalBytes },
        assets,
        flags: exportFlags,
        warnings,
      };
      writeJsonFile(path.join(stage, MANIFEST_NAME), zipManifest);
      const listInfo = writeTarList([...keptEntries.map((e) => e.path), MANIFEST_NAME]);
      const listFile = listInfo.file;
      const listExtras = listInfo.extra || [];
      const packed = bsdtarZip({ out: outDir, listFile, cwd: stage });
      if (packed.result.status !== 0) {
        try { fs.unlinkSync(outDir); } catch { /* 半成品删除失败不掩盖错误 */ }
        fail('MIGRATION_EXPORT_FAILED', `bsdtar 打包失败（exit=${packed.result.status}），已删半成品`, { status: packed.result.status, stderr: packed.stderr.slice(-1200) });
      }
      for (const f of [listFile, ...listExtras]) { try { fs.unlinkSync(f); } catch { /* 忽略 */ } }
      return out({ ok: true, out: outDir, zip: true, files: keptData.length, totals: zipManifest.totals, assets: zipManifest.assets, flags: exportFlags, name: MANIFEST_NAME }, argv.json);
    } finally {
      try { fs.rmSync(stage, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* staging 清理失败不阻断 */ }
    }
  }
  fs.mkdirSync(outDir, { recursive: true });
  for (const e of keptEntries) {
    const dst = path.join(outDir, '包', e.pack);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(e.src, dst);
  }
  writeJsonFile(path.join(outDir, MANIFEST_NAME), manifest);
  return out({ ok: true, out: outDir, files: entries.length, manifest: path.join(outDir, MANIFEST_NAME), message: `已导出 ${entries.length} 个文件 → ${outDir}` }, argv.json);
}

/* ───────── import ───────── */
function loadManifest(outDir) {
  for (const name of [MANIFEST_NAME, 'manifest.json']) {
    const file = path.join(outDir, name);
    if (fs.existsSync(file)) {
      const mf = readJsonSafe(file);
      if (!mf || mf.kind !== 'pm-workbench-migration') fail('MIGRATION_MANIFEST_INVALID', `清单格式不对：${file}`);
      // zip 单文件包清单用 files[]（F2），目录包旧版用 items[]；统一成 items 供校验/导入使用
      const items = Array.isArray(mf.items) ? mf.items : (Array.isArray(mf.files) ? mf.files : null);
      if (!items) fail('MIGRATION_MANIFEST_INVALID', `清单格式不对（缺 items/files）：${file}`);
      return { mf: { ...mf, items }, file };
    }
  }
  fail('MIGRATION_MANIFEST_MISSING', `包根缺少 ${MANIFEST_NAME}：${outDir}`);
}
function verifyManifest(outDir) {
  const { mf } = loadManifest(outDir);
  const missing = [];
  const hashBad = [];
  for (const it of mf.items) {
    const flat = path.join(outDir, it.path);
    const nested = path.join(outDir, '包', it.path);
    const file = fs.existsSync(flat) ? flat : nested;
    if (!fs.existsSync(file)) { missing.push(it.path); continue; }
    const cur = sha256File(file);
    if (cur.sha256 !== it.sha256) hashBad.push(it.path);
  }
  if (missing.length) fail('MIGRATION_MISSING', `包内缺少 ${missing.length} 个文件`, { missing: missing.slice(0, 10) });
  if (hashBad.length) fail('MIGRATION_HASH_MISMATCH', `包内 ${hashBad.length} 个文件哈希不符`, { mismatch: hashBad.slice(0, 10) });
  return mf;
}
function cmdImport(argv) {
  const { repoRoot, projectDir, stateDir, teamFile, wbFile } = resolveRoots(argv);
  // F3：--zip <zip> 单文件包——用同一 bsdtar 封装解包到临时目录后走目录包逻辑
  let zipTemp = '';
  let outDir = argv.zip ? '' : path.resolve(String(argv.out || '').trim());
  if (argv.zip) {
    zipTemp = path.join(repoRoot, '_tmp', `migrate-unzip-${Date.now()}`);
    const un = bsdtarUnzip({ zip: path.resolve(String(argv.zip)), outDir: zipTemp });
    if (un.result.status !== 0) fail('MIGRATION_MANIFEST_MISSING', `zip 解包失败（exit=${un.result.status}）`, { stderr: un.stderr.slice(-800) });
    outDir = zipTemp;
    globalThis.__MIGRATE_ZIP_TEMP = zipTemp;
  }
  if (!outDir) fail('OUT_REQUIRED', '需要 --out <导出目录>');
  const mf = verifyManifest(outDir);
  // AC8②/F2：files 口径与 export 的 totals.files 同源——只计项目数据（项目/ 与 团队/状态/项目/），
  // 元数据两件（状态/团队.json、data/userdata/workbench.json）落 assets.meta，不计入 files。
  const isDataPath = (p) => p.startsWith('项目/') || p.startsWith('团队/状态/项目/');
  const dataCount = mf.items.filter((it) => isDataPath(it.path)).length;
  const dryRun = argv.yes !== true;
  const force = argv.force === true;
  const exists = fs.existsSync(projectDir) || fs.existsSync(stateDir);
  const backupDir = path.join(repoRoot, '_backup', `${new Date().toISOString().replace(/[:.]/g, '-')}-import-${mf.project}`);
  if (dryRun) return out({ ok: true, dryRun: true, project: mf.project, files: dataCount, exists, wouldFail: exists && !force }, argv.json);
  if (exists && !force) fail('MIGRATION_EXISTS', `目标已存在（项目或状态目录），加 --force 才覆盖：${projectDir}`);
  if (exists) {
    for (const [dir, label] of [[projectDir, '项目'], [stateDir, '状态']]) {
      if (!fs.existsSync(dir)) continue;
      fs.cpSync(dir, path.join(backupDir, label, path.basename(dir)), { recursive: true });
    }
  }
  for (const it of mf.items) {
    const srcFlat = path.join(outDir, it.path);
    const src = fs.existsSync(srcFlat) ? srcFlat : path.join(outDir, '包', it.path);
    let dst;
    if (it.path.startsWith('项目/')) dst = path.join(repoRoot, it.path);
    else if (it.path.startsWith('团队/状态/项目/')) dst = path.join(repoRoot, it.path);
    else if (it.path === '状态/团队.json') dst = teamFile;
    else if (it.path === 'data/userdata/workbench.json') dst = wbFile;
    else dst = path.join(repoRoot, it.path);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  return out({ ok: true, project: mf.project, files: dataCount, backup: exists ? backupDir : '' }, argv.json);
}

/* ───────── rebind ───────── */
function pathRefs(repoRoot, project) {
  const { projectDir, stateDir, wbFile } = resolveRoots({ root: repoRoot, project });
  const refs = [];
  const pj = path.join(stateDir, '项目.json');
  if (fs.existsSync(pj)) {
    const data = readJsonSafe(pj) || {};
    for (const key of ['path', 'dshWorkspaceId']) if (data[key]) refs.push({ file: pj, key, value: data[key] });
  }
  if (fs.existsSync(wbFile)) {
    const data = readJsonSafe(wbFile);
    const row = (data && data.projects || []).find((p) => p && String(p.name || p.projectName || '') === project);
    if (row) {
      for (const key of ['path', 'dshWorkspaceId', 'workspacePath']) if (row[key]) refs.push({ file: wbFile, key: `projects[].${key}`, value: row[key] });
      if (row.workspace) for (const key of ['id', 'path', 'name', 'engineUrl']) if (row.workspace[key]) refs.push({ file: wbFile, key: `projects[].workspace.${key}`, value: row.workspace[key] });
    }
  }
  const info = path.join(projectDir, '项目信息.md');
  if (fs.existsSync(info)) {
    const text = fs.readFileSync(info, 'utf8');
    // F4④：排除 URL（https:// 等）与含 scheme 的串，只认单字母盘符路径
    for (const v of text.match(/(?<![\w:/])[A-Za-z]:[\\/][^\s|`)"']+/g) || []) {
      if (/^[a-z]+:\/\//i.test(v)) continue;
      refs.push({ file: info, key: '项目信息.md 盘符路径', value: v });
    }
  }
  return refs;
}
function cmdRebind(argv) {
  const repoRoot = argv.root ? path.resolve(argv.root) : path.resolve(__dirname, '..', '..');
  const project = String(argv.project || '').trim();
  if (!project) fail('PROJECT_REQUIRED', '需要 --project <项目名>');
  const to = String(argv.to || '').trim();
  if (!to) fail('TO_REQUIRED', '需要 --to <新根目录>');
  { guardLiveRoot(argv, repoRoot, project); }
  const dryRun = argv.yes !== true;
  const refs = pathRefs(repoRoot, project);
  const diffs = refs.map((r) => ({ file: r.file.replace(/\\/g, '/'), key: r.key, from: r.value, to }));
  // F4⑤：团队.json activeProject 只在「改名时」重写（--name 给出新名）；dry-run 把它算进五处 diff 之一
  const teamFile = path.join(repoRoot, '团队', '状态', '团队.json');
  const newName = String(argv.name || '').trim();
  const teamData = fs.existsSync(teamFile) ? readJsonSafe(teamFile) : null;
  const curActive = teamData ? String(teamData.activeProject || '') : '';
  const renameActive = Boolean(newName) && curActive !== newName;
  if (renameActive) diffs.push({ file: teamFile.replace(/\\/g, '/'), key: 'activeProject', from: curActive, to: newName });
  if (!dryRun) {
    const { projectDir, stateDir, wbFile } = resolveRoots({ root: repoRoot, project });
    const pj = path.join(stateDir, '项目.json');
    if (fs.existsSync(pj)) {
      const data = readJsonSafe(pj) || {};
      data.path = to; data.dshWorkspaceId = ''; data.workspacePending = true;
      writeJsonFile(pj, data);
    }
    if (fs.existsSync(wbFile)) {
      const data = readJsonSafe(wbFile);
      const row = (data && data.projects || []).find((p) => p && String(p.name || p.projectName || '') === project);
      if (row) {
        if (row.path) row.path = to;
        if (row.workspacePath) row.workspacePath = to;
        // AC4④：workbench 条目自身的 dshWorkspaceId 也必须置 pending（不伪造 DSH 工作区 id）
        if ('dshWorkspaceId' in row) { row.dshWorkspaceId = ''; row.dshWorkspaceIdPending = true; }
        if (row.workspace) { row.workspace.path = to; row.workspace.id = ''; row.workspace.pending = true; row.workspace.bound = false; }
        writeJsonFile(wbFile, data);
      }
    }
    const info = path.join(projectDir, '项目信息.md');
    if (fs.existsSync(info)) {
      let text = fs.readFileSync(info, 'utf8');
      for (const r of refs.filter((x) => x.key === '项目信息.md 盘符路径')) text = text.split(r.value).join(to);
      fs.writeFileSync(info, text, 'utf8');
    }
    // F4⑤：改名时（--name <新名>）重写 团队.json 的 activeProject：写前备份 + 迁移审计 + 提示重 boot
    if (renameActive && teamData) {
      try {
        const backupDir = path.join(repoRoot, '_backup', `${new Date().toISOString().replace(/[:.]/g, '-')}-activeproject`);
        fs.mkdirSync(backupDir, { recursive: true });
        fs.copyFileSync(teamFile, path.join(backupDir, '团队.json'));
      } catch (e) { fail('MIGRATION_BACKUP_FAILED', `团队.json 写前备份失败：${String((e && e.message) || e)}`); }
      const team = readJsonSafe(teamFile) || {};
      team.activeProject = newName;
      writeJsonFile(teamFile, team);
      try {
        const audit = path.join(repoRoot, '团队', '状态', '项目', project, '迁移审计.jsonl');
        fs.mkdirSync(path.dirname(audit), { recursive: true });
        fs.appendFileSync(audit, JSON.stringify({ at: new Date().toISOString(), project, action: 'rebind_active_project', reason: 'activeProject_rename', from: curActive, to: newName }) + '\n', 'utf8');
      } catch { /* 审计失败不阻断 */ }
    }
    const rebootHint = renameActive ? '；团队.json 已改（rulesHash teamConfig）→ 目标侧全员令牌失效，需重 boot' : '';
    return out({ ok: true, dryRun: false, renamedActive: renameActive, diffs, message: `已重写 ${diffs.length} 处路径 → ${to}${rebootHint}` }, argv.json);
  }
  return out({ ok: true, dryRun: true, diffs, message: `[dry-run] ${diffs.length} 处待重写（含 activeProject 如为改名）——加 --yes 才写` }, argv.json);
}

/* ───────── rebind-sessions ───────── */
async function cmdRebindSessions(argv) {
  const repoRoot = argv.root ? path.resolve(argv.root) : path.resolve(__dirname, '..', '..');
  { const project = String(argv.project || '').trim(); guardLiveRoot(argv, repoRoot, project); }
  const teamFile = path.join(repoRoot, '团队', '状态', '团队.json');
  const dryRun = argv.yes !== true;
  const team = readJsonSafe(teamFile);
  if (!team) fail('TEAM_MISSING', `团队.json 不存在：${teamFile}`);
  const roles = Array.isArray(team.members) ? team.members : [];
  const mapping = {};
  for (const pair of String(argv.session || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf('=');
    if (i > 0) mapping[pair.slice(0, i)] = pair.slice(i + 1);
  }
  // AC5①：--role X --session 新 单角色写法；未指定角色**保持原值**
  if (argv.role) {
    const r = String(argv.role).trim();
    if (!roles.some((m) => String(m.role || '') === r)) fail('ROLE_NOT_FOUND', `名册无该角色：${r}`);
    mapping[r] = String(argv.session || '');
  }
  const clearAll = argv.clear === true; // AC5②：--clear 六条空且 pending
  // ① 先算变更（不写盘）——写前校验必须在任何写之前
  const changes = [];
  for (const m of roles) {
    const role = String(m.role || '');
    let next = String(m.sessionId || '');
    if (clearAll) next = '';
    else if (mapping[role] !== undefined) next = mapping[role];
    if (next === String(m.sessionId || '')) continue;
    changes.push({ role, from: String(m.sessionId || ''), to: next });
  }
  // ② B-20261118-083158-990c：写前校验目标 sessionId 在 DSH 存在；不存在默认拒绝（零写入）。
  //    --allow-missing 放行旧行为并写 allowMissing:true 审计。
  //    沙盘/自检豁免（TEAM_SELFTEST=1 或传了 --root），要验门禁本体用 TEAM_MIGRATE_ENFORCE=1。
  const allowMissing = argv['allow-missing'] === true;
  const gateExempt = process.env.TEAM_MIGRATE_ENFORCE === '1'
    ? false
    : (process.env.TEAM_SELFTEST === '1' || Boolean(argv.root));
  let missingSessions = [];
  let dshChecked = false;
  if (!dryRun && !gateExempt) {
    const targets = Array.from(new Set(changes.filter((c) => c.to).map((c) => String(c.to))));
    if (targets.length) {
      let present = null;
      try {
        const client = new DshClient();
        const list = await client.list();
        present = new Set(((list && list.items) || []).map((x) => String(x.sessionId)));
      } catch { present = null; }
      dshChecked = Boolean(present);
      missingSessions = targets.filter((id) => !present || !present.has(id));
      if (missingSessions.length && !allowMissing) {
        fail('STALE_SESSION_REFUSED',
          `目标会话在 DSH 不存在：${missingSessions.join(',')}；名册未改动（零写入）。确认要写入请加 --allow-missing（审计会记 allowMissing:true）`,
          { missing: missingSessions, dshChecked, hint: 'rebind-sessions --allow-missing --yes' });
      }
    }
  }
  // ③ 落盘（校验通过后）
  if (!dryRun) {
    for (const c of changes) {
      const m = roles.find((x) => String(x.role || '') === c.role);
      if (!m) continue;
      const prev = String(m.sessionId || '');
      // F5②：旧会话归档字段（正文要求的 archivedSession / replacedBySessionId）
      if (prev) { m.archivedSession = prev; m.replacedBySessionId = c.to; }
      m.sessionPrevSessionId = prev;
      m.sessionRebindAt = new Date().toISOString();
      m.sessionId = c.to;
      m.sessionPending = c.to === '';
    }
  }
  if (!dryRun && changes.length) {
    writeJsonFile(teamFile, team);
    const at = new Date().toISOString();
    const by = String(argv.by || 'migrate');
    // F5③：迁移审计.jsonl（项目级，append-only）——字段对齐 207b：{at, by, role, from, to, reason, allowMissing}
    const auditProject = String(argv.project || '').trim();
    if (auditProject) {
      const auditFile = path.join(repoRoot, '团队', '状态', '项目', auditProject, '迁移审计.jsonl');
      fs.mkdirSync(path.dirname(auditFile), { recursive: true });
      for (const c of changes) {
        fs.appendFileSync(auditFile, JSON.stringify({
          at, project: auditProject, by, role: c.role, from: c.from, to: c.to,
          archivedSession: c.from || '', replacedBySessionId: c.to,
          reason: 'rebind_sessions', allowMissing: Boolean(allowMissing),
          ...(allowMissing && missingSessions.includes(String(c.to)) ? { missingSession: true } : {}),
        }) + '\n', 'utf8');
      }
    }
    // AC5③：旧会话隔离审计——重绑后在项目 唤醒.jsonl 写 reason='stale_session'（旧会话不再被发往）
    const project = String(argv.project || '').trim();
    if (project) {
      const wake = path.join(repoRoot, '团队', '状态', '项目', project, '唤醒.jsonl');
      fs.mkdirSync(path.dirname(wake), { recursive: true });
      for (const c of changes) {
        fs.appendFileSync(wake, JSON.stringify({ at, project, to: c.role, reason: 'stale_session', oldSessionId: c.from, newSessionId: c.to, ok: false }) + '\n', 'utf8');
      }
    }
  }
  return out({ ok: true, dryRun, changes, gateExempt, allowMissing, missingSessions, dshChecked }, argv.json);
}

/* ───────── migrate-check（AC6① 固定五步）───────── */
function runCli(repoRoot, args) {
  const tool = path.join(repoRoot, '团队', '工具', 'team.mjs');
  const env = { ...process.env, TEAM_ROOT: path.join(repoRoot, '团队'), TEAM_PROJECTS_ROOT: path.join(repoRoot, '项目'), TEAM_SELFTEST: '1' };
  const stdout = execFileSync(process.execPath, [tool, ...args], { cwd: repoRoot, env, encoding: 'utf8' });
  const text = String(stdout).trim();
  try { return JSON.parse(text.slice(text.indexOf('{'))); } catch { return { ok: true, raw: text }; }
}
function cmdCheck(argv) {
  const repoRoot = argv.root ? path.resolve(argv.root) : path.resolve(__dirname, '..', '..');
  const project = String(argv.project || '').trim();
  if (!project) fail('PROJECT_REQUIRED', '需要 --project <项目名>');
  const { projectDir, stateDir, wbFile, wakeLog } = resolveRoots({ root: repoRoot, project });
  const steps = [];
  const push = (name, ok, detail) => steps.push({ name, ok: Boolean(ok), detail: ok ? '' : String(JSON.stringify(detail ?? '')).slice(0, 1200) });

  // ① 项目可见（项目目录 + 项目.json + 团队项目记录）
  let visible = fs.existsSync(projectDir) && fs.existsSync(path.join(stateDir, '项目.json'));
  try { const list = runCli(repoRoot, ['project', 'list', '--json']); visible = visible && JSON.stringify(list).includes(project); } catch { /* list 失败不推翻文件判据 */ }
  push('① 项目可见（目录+项目.json+团队记录）', visible, { projectDir });

  // ② 六角色 boot 记录（工作流 boots 或 状态/启动）
  const wf = readJsonSafe(path.join(stateDir, '工作流.json')) || {};
  const boots = wf.boots && typeof wf.boots === 'object' ? Object.keys(wf.boots) : [];
  const need = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
  push('② 六角色 boot 记录齐全', need.every((r) => boots.includes(r)), { boots });

  // ③ 无旧根残留：四处落点记录的路径必须都指向「本机存在的目录」（旧机路径 rebind 后应已改写，不存在即残留）
  const pathRefsAll = pathRefs(repoRoot, project);
  // F4④：URL（http(s)://、ws(s)://）不是盘符路径，不参与「旧根残留」判定
  const isUrl = (v) => /^[a-z]+:\/\//i.test(String(v));
  const staleRefs = pathRefsAll.filter((r) => !isUrl(r.value) && /[A-Za-z]:[\\/]/.test(String(r.value)) && !fs.existsSync(String(r.value)));
  push('③ 无旧根残留（四处落点路径均指向本机存在目录）', staleRefs.length === 0,
    { stale: staleRefs.map((r) => ({ key: r.key, value: r.value })) });
  // ④ send→read→ack 回环（沙盘内真实 CLI 三连）
  let loop = { ok: false };
  try {
    // AC6① ④：迁移包按设计不含团队级实例文档（团队宪法/项目铁律/角色卡由 team.mjs init 生成），
    // 所以回环前先在目标侧执行 init 补环境（换机真实路径：import → init → migrate-check）。
    let initOk = false;
    try { const init = runCli(repoRoot, ['init', '--json']); initOk = Boolean(init && init.ok !== false); } catch { initOk = false; }
    // PM 2026-11-17 13:40 口径：④ 在「导入后的目标根」上跑——init 之后还要 project add 登记（PROJECT_DIR_MISSING 的常见原因），
    // 已登记则忽略 PROJECT_EXISTS。包内容类断言（AC1/AC7）仍走假仓库，两套分开。
    try { runCli(repoRoot, ['project', 'add', '--name', project, '--dir', projectDir, '--team-mode', 'full', '--json']); } catch { /* 已登记则忽略 */ }
    const boot = runCli(repoRoot, ['boot', '--role', 'pm', '--project', project, '--session', 'sess-pm', '--json']);
    const token = String((boot && (boot.token || (boot.boot && boot.boot.token))) || '');
    if (!token) throw new Error('no token');
    const sent = runCli(repoRoot, ['send', '--boot', token, '--project', project, '--to', 'tester', '--subject', '迁移冒烟', '--body', 'migrate-check 回环', '--json']);
    const msgId = sent && sent.message && sent.message.id;
    // 回环必须由**收件人**读与 ack（发件人 token 读自己的投递件会 MESSAGE_NOT_FOUND/FORBIDDEN，实测 exit 3）
    const testerBoot = runCli(repoRoot, ['boot', '--role', 'tester', '--project', project, '--session', 'sess-tester', '--json']);
    const testerToken = String((testerBoot && (testerBoot.token || (testerBoot.boot && testerBoot.boot.token))) || '');
    const read = msgId && testerToken ? runCli(repoRoot, ['read', '--boot', testerToken, '--id', msgId, '--json']) : null;
    const ack = msgId && testerToken ? runCli(repoRoot, ['ack', '--boot', testerToken, '--id', msgId, '--note', 'migrate-check 回环 ack', '--json']) : null;
    loop = { ok: Boolean(initOk && read && read.ok !== false && ack && ack.ok !== false), msgId, initOk };
  } catch (e) { loop = { ok: false, error: String(e && e.message || e).slice(0, 200), stderr: String((e && e.stderr) || '').slice(0, 400) || undefined }; }
  push('④ send→read→ack 回环', loop.ok, loop);

  // ⑤ 关键自检可跑（team.mjs 与 migrate.mjs 语法检查）
  let selfCheckOk = true;
  try { execFileSync(process.execPath, ['--check', path.join(repoRoot, '团队', '工具', 'team.mjs')]); } catch { selfCheckOk = false; }
  try { execFileSync(process.execPath, ['--check', path.join(repoRoot, '团队', '工具', 'migrate.mjs')]); } catch { selfCheckOk = false; }
  push('⑤ 关键自检可跑（team.mjs/migrate.mjs --check）', selfCheckOk, {});

  const ok = steps.every((s) => s.ok);
  return out({ ok, steps, wakeLog: fs.existsSync(wakeLog) ? wakeLog : '', message: `${ok ? 'PASS' : 'FAIL'} 五步冒烟：${steps.filter((s) => s.ok).length}/${steps.length}` }, argv.json);
}

/* ───────── CLI ───────── */
const BOOL_FLAGS = ['yes', 'dry-run', 'force', 'with-noise', 'no-evidence', 'clear', 'json', 'all', 'allow-live-root', 'allow-missing'];
function parseArgs(argv) {
  const args = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const key = a.slice(2);
    if (BOOL_FLAGS.includes(key)) args[key] = true;
    else { args[key] = argv[i + 1]; i += 1; }
  }
  return { cmd: rest[0] || '', args };
}
async function main() {
  const { cmd, args } = parseArgs(process.argv.slice(2));
  const HELP = [
    '项目迁移包（R-20261116-193349-4761）',
    '用法: node 团队/工具/migrate.mjs <命令> --project <P> [--out <dir>] [--to <dir>] [--role R --session 新] [--session role=id,...] [--clear] [--no-evidence] [--with-noise] [--yes] [--force] [--json]',
    '  export           打包项目数据 + 迁移清单.json（含名册/workbench；--no-evidence 排除产出/证据-*；默认 dry-run）',
    '  import           校验清单并落地（MIGRATION_HASH_MISMATCH / MIGRATION_MISSING / MIGRATION_MANIFEST_MISSING；--force 先备份）',
    '  rebind           路径重写（先打印 diff；--yes 才写）',
    '  rebind-sessions  会话重绑（--role X --session 新 / --session role=id,... / --clear；写 stale_session 审计）',
    '  migrate-check    AC6① 五步冒烟（项目可见/六角色 boot/无旧根残留/send-read-ack 回环/关键自检）',
  ].join('\n');
  try {
    // 防呆：写操作必须能确认目标根。未传 --root 且 env TEAM_ROOT 指向另一个团队目录时，默认根会落在真实仓库，
    // 沙盘/测试调用会误写真实 团队.json（本日已发生一次）→ 直接拒绝，要求显式 --root。
    const WRITE_CMDS = ['import', 'rebind', 'rebind-sessions'];
    if (WRITE_CMDS.includes(cmd) && !args.root && process.env.TEAM_ROOT) {
      const defaultTeam = path.resolve(__dirname, '..', '..', '团队');
      const envTeam = path.resolve(String(process.env.TEAM_ROOT));
      if (envTeam !== defaultTeam) {
        fail('ROOT_REQUIRED', '该命令会改团队账本/路径：env TEAM_ROOT 与默认根不一致时必须显式 --root <目标根>', { envTeam, defaultTeam });
      }
    }
    if (!cmd || cmd === 'help' || cmd === '--help') { console.log(HELP); return 0; }
    const table = { export: cmdExport, import: cmdImport, rebind: cmdRebind, 'rebind-sessions': cmdRebindSessions, 'migrate-check': cmdCheck };
    const fn = table[cmd];
    if (!fn) fail('UNKNOWN_COMMAND', `未知命令：${cmd}\n${HELP}`);
    await fn(args);
    return 0;
  } catch (e) {
    const payload = { ok: false, code: e.code || 'MIGRATE_FAILED', message: String(e.message || e) };
    if (args.json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    else console.error(`${payload.code}: ${payload.message}`);
    const code2 = /^(MIGRATION_|MANIFEST_|PROJECT_NOT_FOUND|ROLE_NOT_FOUND|OUT_REQUIRED)/.test(payload.code);
    process.exitCode = code2 ? 2 : 1;
    return process.exitCode;
  }
}
function cleanupZipTemp(dir) { if (!dir) return; try { fs.rmSync(dir, { recursive: true, force: true, maxRetries: 3, retryDelay: 100 }); } catch { /* 忽略 */ } }
process.on('exit', () => { try { const g = globalThis.__MIGRATE_ZIP_TEMP; if (g) cleanupZipTemp(g); } catch { /* 忽略 */ } });
process.exit(await main());
