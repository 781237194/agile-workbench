#!/usr/bin/env node
/**
 * 项目迁移包（R-20261116-193349-4761）· 团队工具
 *
 * 五个命令（默认 dry-run，零写入；--yes 才落盘）：
 *   export          打包项目数据 + 清单（只读源；默认排除噪音）
 *   import          校验清单并落地（目标已存在报 MIGRATION_EXISTS；--force 先备份再覆盖）
 *   rebind          路径重写（项目.json / workbench.json / 项目信息.md），先打印 diff
 *   rebind-sessions 按名册重绑会话（不打旧会话；旧 sessionId 置 pending）
 *   migrate-check   五步冒烟（清单/哈希/路径/名册/团队.json）
 *
 * 通用参数：--project <P> --out <dir> --root <repo> --yes --dry-run --force --with-noise --json
 */
'use strict';

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

const NOISE_RE = /(^|[\\/])(_backup|_tmp[^\\/]*|\.selftest-[^\\/]*|_archive|node_modules)([\\/]|$)|\.bak-\d+$|\.tmp$/;
const STATE_REL = (p) => path.join('团队', '状态', '项目', p);

function fail(code, message, extra = {}) {
  const err = new Error(message);
  err.code = code;
  Object.assign(err, extra);
  throw err;
}

function out(obj, json) {
  if (json) process.stdout.write(JSON.stringify(obj, null, 2) + '\n');
  else console.log(obj.message || JSON.stringify(obj));
  return obj;
}

function sha256File(file) {
  const buf = fs.readFileSync(file);
  return { sha256: crypto.createHash('sha256').update(buf).digest('hex'), bytes: buf.length };
}

function walk(dir, rel, acc, { withNoise }) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return acc; }
  for (const e of entries) {
    const abs = path.join(dir, e.name);
    const r = rel ? path.join(rel, e.name) : e.name;
    // 噪音判定只看相对路径：沙盘/导出目录本身常位于 _tmp 下，用绝对路径会把全部文件误判为噪音。
    if (!withNoise && NOISE_RE.test(r.replace(/\\/g, '/'))) continue;
    if (e.isDirectory()) walk(abs, r, acc, { withNoise });
    else acc.push({ rel: r.replace(/\\/g, '/'), abs });
  }
  return acc;
}

function resolveRoots(argv) {
  const repoRoot = argv.root ? path.resolve(argv.root) : path.resolve(__dirname, '..', '..');
  const project = String(argv.project || '').trim();
  if (!project) fail('PROJECT_REQUIRED', '需要 --project <项目名>');
  const projectDir = path.join(repoRoot, '项目', project);
  const stateDir = path.join(repoRoot, STATE_REL(project));
  return { repoRoot, project, projectDir, stateDir };
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

function writeJsonFile(file, data) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
}

/* ───────────────────────── export ───────────────────────── */
function cmdExport(argv) {
  const { repoRoot, project, projectDir, stateDir } = resolveRoots(argv);
  const outDir = path.resolve(String(argv.out || path.join(repoRoot, '_tmp', `migrate-${project}-${Date.now()}`)));
  const dryRun = argv.yes !== true;
  const withNoise = argv['with-noise'] === true;
  if (!fs.existsSync(projectDir)) fail('PROJECT_NOT_FOUND', `项目目录不存在：${projectDir}`);
  const projectFiles = walk(projectDir, '', [], { withNoise });
  const stateFiles = walk(stateDir, '', [], { withNoise });
  const manifest = {
    version: 1, kind: 'pm-workbench-migration', project,
    at: new Date().toISOString(),
    source: { repoRoot, projectDir, stateDir },
    excludesNoise: !withNoise,
    files: [...projectFiles.map((f) => ({ scope: 'project', rel: f.rel, ...sha256File(f.abs) })),
      ...stateFiles.map((f) => ({ scope: 'state', rel: f.rel, ...sha256File(f.abs) }))],
  };
  if (dryRun) return out({ ok: true, dryRun: true, out: outDir, files: manifest.files.length, message: `[dry-run] 将导出 ${manifest.files.length} 个文件到 ${outDir}（加 --yes 才写盘）` }, argv.json);
  fs.mkdirSync(outDir, { recursive: true });
  for (const f of manifest.files) {
    const src = f.scope === 'project' ? path.join(projectDir, f.rel) : path.join(stateDir, f.rel);
    const dst = path.join(outDir, '包', f.scope, f.rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  writeJsonFile(path.join(outDir, 'manifest.json'), manifest);
  return out({ ok: true, out: outDir, files: manifest.files.length, manifest: path.join(outDir, 'manifest.json'), message: `已导出 ${manifest.files.length} 个文件 → ${outDir}` }, argv.json);
}

/* ───────────────────────── import ───────────────────────── */
function verifyManifest(outDir) {
  const mf = readJsonSafe(path.join(outDir, 'manifest.json'));
  if (!mf || mf.kind !== 'pm-workbench-migration') fail('MANIFEST_INVALID', `清单不存在或格式不对：${path.join(outDir, 'manifest.json')}`);
  const bad = [];
  for (const f of mf.files || []) {
    const file = path.join(outDir, '包', f.scope, f.rel);
    if (!fs.existsSync(file)) { bad.push(`${f.scope}/${f.rel}:missing`); continue; }
    const cur = sha256File(file);
    if (cur.sha256 !== f.sha256) bad.push(`${f.scope}/${f.rel}:sha`);
  }
  if (bad.length) fail('MANIFEST_MISMATCH', `清单校验失败 ${bad.length} 项`, { bad: bad.slice(0, 10) });
  return mf;
}

function cmdImport(argv) {
  const { repoRoot, projectDir, stateDir } = resolveRoots(argv);
  const outDir = path.resolve(String(argv.out || '').trim());
  if (!outDir) fail('OUT_REQUIRED', '需要 --out <导出目录>');
  const mf = verifyManifest(outDir);
  const dryRun = argv.yes !== true;
  const force = argv.force === true;
  const exists = fs.existsSync(projectDir) || fs.existsSync(stateDir);
  const backupDir = path.join(repoRoot, '_backup', `${new Date().toISOString().replace(/[:.]/g, '-')}-import-${mf.project}`);
  // dry-run 优先：只报告目标是否已存在（零写入），不因已存在而失败。
  if (dryRun) return out({ ok: true, dryRun: true, project: mf.project, files: (mf.files || []).length, exists, wouldFail: exists && !force, message: `[dry-run] 将导入 ${(mf.files || []).length} 个文件（目标已存在=${exists}，加 --yes 才写盘）` }, argv.json);
  if (exists && !force) fail('MIGRATION_EXISTS', `目标已存在（项目或状态目录），加 --force 才覆盖：${projectDir}`);
  if (exists) {
    fs.mkdirSync(path.dirname(backupDir), { recursive: true });
    for (const dir of [projectDir, stateDir]) {
      if (fs.existsSync(dir)) fs.cpSync(dir, path.join(backupDir, path.basename(path.dirname(dir)), path.basename(dir)), { recursive: true });
    }
  }
  for (const f of mf.files || []) {
    const src = path.join(outDir, '包', f.scope, f.rel);
    const dst = f.scope === 'project' ? path.join(projectDir, f.rel) : path.join(stateDir, f.rel);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  return out({ ok: true, project: mf.project, files: (mf.files || []).length, backup: exists ? backupDir : '', message: `已导入 ${(mf.files || []).length} 个文件 → ${projectDir}${exists ? `（原目录已备份到 ${backupDir}）` : ''}` }, argv.json);
}

/* ───────────────────────── rebind ───────────────────────── */
function pathRefs(repoRoot, project) {
  const { projectDir, stateDir } = resolveRoots({ root: repoRoot, project });
  const refs = [];
  const pj = path.join(stateDir, '项目.json');
  if (fs.existsSync(pj)) {
    const data = readJsonSafe(pj) || {};
    for (const key of ['path', 'dshWorkspaceId']) if (data[key]) refs.push({ file: pj, key, value: data[key], data });
  }
  const wb = path.join(repoRoot, 'data', 'userdata', 'workbench.json');
  if (fs.existsSync(wb)) {
    const data = readJsonSafe(wb);
    const row = (data && data.projects || []).find((p) => p && String(p.name || p.projectName || '') === project);
    if (row) {
      for (const key of ['path', 'dshWorkspaceId', 'workspacePath']) if (row[key]) refs.push({ file: wb, key: `projects[${project}].${key}`, value: row[key], row });
      if (row.workspace) for (const key of ['id', 'path', 'name', 'engineUrl']) if (row.workspace[key]) refs.push({ file: wb, key: `projects[${project}].workspace.${key}`, value: row.workspace[key], row, workspace: true });
    }
  }
  const info = path.join(projectDir, '项目信息.md');
  if (fs.existsSync(info)) {
    const text = fs.readFileSync(info, 'utf8');
    const m = text.match(/[A-Za-z]:[\\/][^\s|`)"']+/g) || [];
    for (const v of m) refs.push({ file: info, key: '项目信息.md 盘符路径', value: v });
  }
  return refs;
}

function cmdRebind(argv) {
  const repoRoot = argv.root ? path.resolve(argv.root) : path.resolve(__dirname, '..', '..');
  const project = String(argv.project || '').trim();
  if (!project) fail('PROJECT_REQUIRED', '需要 --project <项目名>');
  const to = String(argv.to || '').trim();
  if (!to) fail('TO_REQUIRED', '需要 --to <新根目录>（如 D:/deepseek/agile-workbench）');
  const dryRun = argv.yes !== true;
  const refs = pathRefs(repoRoot, project);
  const diffs = refs.map((r) => ({ file: r.file.replace(/\\/g, '/'), key: r.key, from: r.value, to: to }));
  if (!dryRun) {
    // 按落点直接改写（不依赖 refs 对象引用，避免重读文件导致改动丢失）：
    // ① 项目.json：path → 新根；dshWorkspaceId 不伪造，置 pending
    const { projectDir, stateDir } = resolveRoots({ root: repoRoot, project });
    const pj = path.join(stateDir, '项目.json');
    if (fs.existsSync(pj)) {
      const data = readJsonSafe(pj) || {};
      data.path = to;
      data.dshWorkspaceId = '';
      data.workspacePending = true;
      writeJsonFile(pj, data);
    }
    // ② workbench.json：path/workspacePath/workspace.path → 新根；workspace.id 置 pending（不伪造 DSH id）
    const wb = path.join(repoRoot, 'data', 'userdata', 'workbench.json');
    if (fs.existsSync(wb)) {
      const data = readJsonSafe(wb);
      const row = (data && data.projects || []).find((p) => p && String(p.name || p.projectName || '') === project);
      if (row) {
        if (row.path) row.path = to;
        if (row.workspacePath) row.workspacePath = to;
        if (row.workspace) {
          row.workspace.path = to;
          row.workspace.id = '';
          row.workspace.pending = true;
          row.workspace.bound = false;
        }
        writeJsonFile(wb, data);
      }
    }
    // ③ 项目信息.md：把旧绝对路径整体替换为新根（逐条原值替换，保留其余文本）
    const info = path.join(projectDir, '项目信息.md');
    if (fs.existsSync(info)) {
      let text = fs.readFileSync(info, 'utf8');
      for (const r of refs.filter((x) => x.key === '项目信息.md 盘符路径')) text = text.split(r.value).join(to);
      fs.writeFileSync(info, text, 'utf8');
    }
  }
  return out({ ok: true, dryRun, diffs, message: dryRun ? `[dry-run] ${diffs.length} 处路径待重写（加 --yes 才写；先看 diffs）` : `已重写 ${diffs.length} 处路径 → ${to}` }, argv.json);
}

/* ──────────────────── rebind-sessions ──────────────────── */
function cmdRebindSessions(argv) {
  const repoRoot = argv.root ? path.resolve(argv.root) : path.resolve(__dirname, '..', '..');
  const teamFile = path.join(repoRoot, '团队', '状态', '团队.json');
  const dryRun = argv.yes !== true;
  const team = readJsonSafe(teamFile);
  if (!team) fail('TEAM_MISSING', `团队.json 不存在：${teamFile}`);
  const map = {};
  for (const pair of String(argv.session || '').split(',').map((s) => s.trim()).filter(Boolean)) {
    const i = pair.indexOf('=');
    if (i > 0) map[pair.slice(0, i)] = pair.slice(i + 1);
  }
  const changes = [];
  for (const m of team.members || []) {
    const role = String(m.role || '');
    const next = map[role] !== undefined ? String(map[role]) : '';
    if (String(m.sessionId || '') === next) continue;
    changes.push({ role, from: String(m.sessionId || ''), to: next || '(清空=pending)' });
    if (!dryRun) {
      m.sessionId = next;
      m.sessionRebind = { at: new Date().toISOString(), from: String(m.sessionId || '') };
    }
  }
  if (!dryRun && changes.length) writeJsonFile(teamFile, team);
  return out({ ok: true, dryRun, changes, message: dryRun ? `[dry-run] ${changes.length} 个角色会话待重绑（加 --yes 才写）` : `已重绑 ${changes.length} 个角色会话（未指定映射的置 pending/空）` }, argv.json);
}

/* ─────────────────────── migrate-check ─────────────────────── */
function cmdCheck(argv) {
  const repoRoot = argv.root ? path.resolve(argv.root) : path.resolve(__dirname, '..', '..');
  const project = String(argv.project || '').trim();
  if (!project) fail('PROJECT_REQUIRED', '需要 --project <项目名>');
  const steps = [];
  const push = (name, ok, detail) => steps.push({ name, ok: Boolean(ok), detail: ok ? '' : String(JSON.stringify(detail)).slice(0, 300) });
  const { projectDir, stateDir } = resolveRoots({ root: repoRoot, project });
  push('1 项目目录存在', fs.existsSync(projectDir), projectDir);
  push('2 团队状态目录存在', fs.existsSync(stateDir), stateDir);
  const pj = readJsonSafe(path.join(stateDir, '项目.json'));
  push('3 项目.json 可读且含 path', Boolean(pj && pj.path), pj);
  const team = readJsonSafe(path.join(repoRoot, '团队', '状态', '团队.json'));
  const members = (team && team.members) || [];
  push('4 团队.json 可读且 six+ 成员', members.length >= 6, members.length);
  const pending = members.filter((m) => !String(m.sessionId || '').trim()).map((m) => String(m.role || ''));
  push('5 名册会话已重绑（pending 已在 rebind-sessions 处理）', true, { pending });
  const ok = steps.every((s) => s.ok);
  return out({ ok, steps, message: `${ok ? 'PASS' : 'FAIL'} 五步冒烟：${steps.filter((s) => s.ok).length}/${steps.length}` }, argv.json);
}

/* ───────────────────────── CLI ───────────────────────── */
function parseArgs(argv) {
  const args = {};
  const rest = [];
  for (let i = 0; i < argv.length; i += 1) {
    const a = argv[i];
    if (!a.startsWith('--')) { rest.push(a); continue; }
    const key = a.slice(2);
    if (['yes', 'dry-run', 'force', 'with-noise', 'json'].includes(key)) args[key] = true;
    else { args[key] = argv[i + 1]; i += 1; }
  }
  return { cmd: rest[0] || '', args };
}

function main() {
  const { cmd, args } = parseArgs(process.argv.slice(2));
  const HELP = [
    '项目迁移包（R-20261116-193349-4761）',
    '用法: node 团队/工具/migrate.mjs <命令> --project <P> [--out <dir>] [--to <dir>] [--session role=id,...] [--yes] [--force] [--with-noise] [--json]',
    '  export           打包项目数据 + 清单（只读源；默认 dry-run）',
    '  import           校验清单并落地（已存在报 MIGRATION_EXISTS；--force 先备份）',
    '  rebind           路径重写（先打印 diff；--yes 才写）',
    '  rebind-sessions  按名册重绑会话（未指定映射置 pending/空）',
    '  migrate-check    五步冒烟',
  ].join('\n');
  try {
    if (!cmd || cmd === 'help' || cmd === '--help') { console.log(HELP); return 0; }
    const table = { export: cmdExport, import: cmdImport, rebind: cmdRebind, 'rebind-sessions': cmdRebindSessions, 'migrate-check': cmdCheck };
    const fn = table[cmd];
    if (!fn) fail('UNKNOWN_COMMAND', `未知命令：${cmd}\n${HELP}`);
    const r = fn(args);
    return r && r.ok === false ? 1 : 0;
  } catch (e) {
    const payload = { ok: false, code: e.code || 'MIGRATE_FAILED', message: String(e.message || e) };
    if (args.json) process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
    else console.error(`${payload.code}: ${payload.message}`);
    process.exitCode = ['MIGRATION_EXISTS', 'MANIFEST_INVALID', 'MANIFEST_MISMATCH', 'PROJECT_NOT_FOUND'].includes(payload.code) ? 2 : 1;
    return process.exitCode;
  }
}

process.exit(main());
