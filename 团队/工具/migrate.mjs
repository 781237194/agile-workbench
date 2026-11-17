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

/* ───────── export ───────── */
function cmdExport(argv) {
  const { repoRoot, project, projectDir, stateDir, teamFile, wbFile } = resolveRoots(argv);
  const outDir = path.resolve(String(argv.out || path.join(repoRoot, '_tmp', `migrate-${project}-${Date.now()}`)));
  const dryRun = argv.yes !== true;
  const withNoise = argv['with-noise'] === true;
  const withEvidence = argv['no-evidence'] !== true;
  if (!fs.existsSync(projectDir)) fail('PROJECT_NOT_FOUND', `项目目录不存在：${projectDir}`);
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
  const manifest = {
    version: 2, kind: 'pm-workbench-migration', project, at: new Date().toISOString(),
    source: { repoRoot, projectDir, stateDir }, excludesNoise: !withNoise, includesEvidence: withEvidence,
    items: entries.map((e) => ({ scope: e.scope, path: e.path, bytes: e.bytes, sha256: e.sha256 })),
  };
  if (dryRun) return out({ ok: true, dryRun: true, out: outDir, files: entries.length, name: MANIFEST_NAME, message: `[dry-run] 将导出 ${entries.length} 个文件到 ${outDir}（加 --yes 才写盘）` }, argv.json);
  fs.mkdirSync(outDir, { recursive: true });
  for (const e of entries) {
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
      if (!mf || mf.kind !== 'pm-workbench-migration' || !Array.isArray(mf.items)) fail('MIGRATION_MANIFEST_INVALID', `清单格式不对：${file}`);
      return { mf, file };
    }
  }
  fail('MIGRATION_MANIFEST_MISSING', `包根缺少 ${MANIFEST_NAME}：${outDir}`);
}
function verifyManifest(outDir) {
  const { mf } = loadManifest(outDir);
  const missing = [];
  const hashBad = [];
  for (const it of mf.items) {
    const file = path.join(outDir, '包', it.path);
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
  const outDir = path.resolve(String(argv.out || '').trim());
  if (!outDir) fail('OUT_REQUIRED', '需要 --out <导出目录>');
  const mf = verifyManifest(outDir);
  const dryRun = argv.yes !== true;
  const force = argv.force === true;
  const exists = fs.existsSync(projectDir) || fs.existsSync(stateDir);
  const backupDir = path.join(repoRoot, '_backup', `${new Date().toISOString().replace(/[:.]/g, '-')}-import-${mf.project}`);
  if (dryRun) return out({ ok: true, dryRun: true, project: mf.project, files: mf.items.length, exists, wouldFail: exists && !force }, argv.json);
  if (exists && !force) fail('MIGRATION_EXISTS', `目标已存在（项目或状态目录），加 --force 才覆盖：${projectDir}`);
  if (exists) {
    for (const [dir, label] of [[projectDir, '项目'], [stateDir, '状态']]) {
      if (!fs.existsSync(dir)) continue;
      fs.cpSync(dir, path.join(backupDir, label, path.basename(dir)), { recursive: true });
    }
  }
  for (const it of mf.items) {
    const src = path.join(outDir, '包', it.path);
    let dst;
    if (it.path.startsWith('项目/')) dst = path.join(repoRoot, it.path);
    else if (it.path.startsWith('团队/状态/项目/')) dst = path.join(repoRoot, it.path);
    else if (it.path === '状态/团队.json') dst = teamFile;
    else if (it.path === 'data/userdata/workbench.json') dst = wbFile;
    else dst = path.join(repoRoot, it.path);
    fs.mkdirSync(path.dirname(dst), { recursive: true });
    fs.copyFileSync(src, dst);
  }
  return out({ ok: true, project: mf.project, files: mf.items.length, backup: exists ? backupDir : '' }, argv.json);
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
    for (const v of text.match(/[A-Za-z]:[\\/][^\s|`)"']+/g) || []) refs.push({ file: info, key: '项目信息.md 盘符路径', value: v });
  }
  return refs;
}
function cmdRebind(argv) {
  const repoRoot = argv.root ? path.resolve(argv.root) : path.resolve(__dirname, '..', '..');
  const project = String(argv.project || '').trim();
  if (!project) fail('PROJECT_REQUIRED', '需要 --project <项目名>');
  const to = String(argv.to || '').trim();
  if (!to) fail('TO_REQUIRED', '需要 --to <新根目录>');
  const dryRun = argv.yes !== true;
  const refs = pathRefs(repoRoot, project);
  const diffs = refs.map((r) => ({ file: r.file.replace(/\\/g, '/'), key: r.key, from: r.value, to }));
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
  }
  return out({ ok: true, dryRun, diffs, message: dryRun ? `[dry-run] ${diffs.length} 处路径待重写（加 --yes 才写）` : `已重写 ${diffs.length} 处路径 → ${to}` }, argv.json);
}

/* ───────── rebind-sessions ───────── */
function cmdRebindSessions(argv) {
  const repoRoot = argv.root ? path.resolve(argv.root) : path.resolve(__dirname, '..', '..');
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
  const changes = [];
  for (const m of roles) {
    const role = String(m.role || '');
    let next = String(m.sessionId || '');
    if (clearAll) next = '';
    else if (mapping[role] !== undefined) next = mapping[role];
    if (next === String(m.sessionId || '')) continue;
    changes.push({ role, from: String(m.sessionId || ''), to: next });
    if (!dryRun) {
      m.sessionPrevSessionId = String(m.sessionId || '');
      m.sessionRebindAt = new Date().toISOString();
      m.sessionId = next;
      m.sessionPending = next === '';
    }
  }
  if (!dryRun && changes.length) {
    writeJsonFile(teamFile, team);
    // AC5③：旧会话隔离审计——重绑后在项目 唤醒.jsonl 写 reason='stale_session'（旧会话不再被发往）
    const project = String(argv.project || '').trim();
    if (project) {
      const wake = path.join(repoRoot, '团队', '状态', '项目', project, '唤醒.jsonl');
      fs.mkdirSync(path.dirname(wake), { recursive: true });
      const at = new Date().toISOString();
      for (const c of changes) {
        fs.appendFileSync(wake, JSON.stringify({ at, project, to: c.role, reason: 'stale_session', oldSessionId: c.from, newSessionId: c.to, ok: false }) + '\n', 'utf8');
      }
    }
  }
  return out({ ok: true, dryRun, changes }, argv.json);
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
const BOOL_FLAGS = ['yes', 'dry-run', 'force', 'with-noise', 'no-evidence', 'clear', 'json'];
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
function main() {
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
    if (!cmd || cmd === 'help' || cmd === '--help') { console.log(HELP); return 0; }
    const table = { export: cmdExport, import: cmdImport, rebind: cmdRebind, 'rebind-sessions': cmdRebindSessions, 'migrate-check': cmdCheck };
    const fn = table[cmd];
    if (!fn) fail('UNKNOWN_COMMAND', `未知命令：${cmd}\n${HELP}`);
    fn(args);
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
process.exit(main());
