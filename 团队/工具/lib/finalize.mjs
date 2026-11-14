// 项目终验与记忆清理（R-20261112-180524-fb48）
//
// 流程：权限 → 前置检查（需求/任务/派单）→ 重复检查 → 记忆快照 → 清理（memory:off 则跳过）→ 写终验记录 → 标记项目。
// 铁律：先快照后清；只清本项目 workspace；快照失败即中止；不删项目/提交；不改需求与任务状态。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import os from 'node:os';
import { readWorkflowState } from './lifecycle.mjs';
import { loadProject, projectStatePaths, listTasks, requireBoot } from './store.mjs';
import { detectOptionalPlugins } from './plugins.mjs';
import { PATHS, nowIso, stamp, ensureDir, jsonOut, textOut, fail } from './core.mjs';

const FINALIZE_ROLES = new Set(['pm', 'owner']);

export function memoriesRoot() {
  const env = String(process.env.TEAM_MEMORY_HOME || '').trim();
  if (env) return path.resolve(env);
  const home = String(process.env.DSH_HOME || '').trim() || path.join(os.homedir(), '.dsh');
  return path.join(home, 'memories');
}

/** workspace-key：项目.json 里登记的 memoryWorkspaceKey/dshWorkspaceId，缺省用项目名+路径派生。 */
export function workspaceKey(projectName) {
  const project = loadProject(projectName);
  const state = project || {};
  const key = String(state.memoryWorkspaceKey || state.dshWorkspaceId || '').trim();
  if (key) return key;
  return crypto.createHash('sha256').update(`${projectName}|${project.path || ''}`).digest('hex').slice(0, 12);
}

export function projectMemoryDir(projectName) {
  return path.join(memoriesRoot(), 'projects', workspaceKey(projectName));
}

function memoryFiles(projectName) {
  const dir = projectMemoryDir(projectName);
  const files = [];
  for (const name of ['MEMORY.md', 'TODOS.md']) {
    const file = path.join(dir, name);
    if (fs.existsSync(file)) files.push({ name, file, bytes: fs.statSync(file).size, sha256: sha(fs.readFileSync(file)) });
  }
  return files;
}

function sha(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex');
}

/** 前置检查：需求全 accepted/terminated、无未闭环任务、无未消费派单。只读。 */
export function finalizePrecheck(projectName) {
  const read = readWorkflowState(projectName);
  const state = (read && read.state) || {};
  const reqs = state.requirements && typeof state.requirements === 'object' ? state.requirements : {};
  const requirements = Object.entries(reqs).map(([id, row]) => ({ id, status: String((row && row.status) || '') }));
  const openRequirements = requirements.filter((r) => !['accepted', 'terminated'].includes(r.status));
  const tasks = listTasks(projectName) || [];
  const openTasks = tasks.filter((t) => String(t.status) !== 'done').map((t) => ({ id: t.id, owner: t.owner || '', status: t.status }));
  const dispatches = [];
  // 邮箱目录是 团队/状态/邮箱（PATHS.mail）；曾经误用 PATHS.team（团队.json 文件）拼路径，
  // 读到不存在的目录后静默 roles=[]，导致 AC22.4 派单前置永远 0（测试 v20 D1）。
  const mailDir = PATHS.mail;
  let roles = [];
  try { roles = fs.readdirSync(mailDir); } catch { roles = []; }
  for (const role of roles) {
    const newDir = path.join(mailDir, role, 'new');
    let names = [];
    try { names = fs.readdirSync(newDir); } catch { continue; }
    for (const name of names) {
      if (!/\.json$/i.test(name)) continue;
      let msg = null;
      try { msg = JSON.parse(fs.readFileSync(path.join(newDir, name), 'utf8').replace(/^\uFEFF/, '')); } catch { continue; }
      if (!msg) continue;
      const subject = String(msg.subject || '');
      const kind = String(msg.kind || '');
      if (kind === 'dispatch' || /派单/.test(subject)) {
        dispatches.push({ id: msg.id || name, to: role, recipientSessionId: String(msg.recipientSessionId || '') });
      }
    }
  }
  return {
    ok: openRequirements.length === 0 && openTasks.length === 0 && dispatches.length === 0,
    requirements,
    openRequirements,
    openTasks,
    dispatches,
    projectKey: workspaceKey(projectName),
  };
}

function snapshotMemory(projectName, projectPath) {
  const files = memoryFiles(projectName);
  const ts = stamp();
  // 同一秒内重复 finalize（例如 --force）不能复用快照目录，否则后一次会把前一次的快照覆盖成清理后的内容；
  // 目录名加随机后缀保证每次快照独立（R-fb48 修复，A 代修并请 B 复核）。
  const dir = path.join(projectPath, '_archive', `记忆-${ts}-${crypto.randomBytes(2).toString('hex')}`);
  ensureDir(dir);
  const entries = [];
  for (const f of files) {
    const dst = path.join(dir, f.name);
    fs.copyFileSync(f.file, dst);
    entries.push({ name: f.name, file: path.relative(projectPath, dst).replace(/\\/g, '/'), bytes: f.bytes, sha256: f.sha256 });
  }
  const manifest = { at: nowIso(), project: projectName, workspaceKey: workspaceKey(projectName), source: projectMemoryDir(projectName), files: entries };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n', 'utf8');
  return { dir, manifest };
}

function clearMemory(projectName) {
  const dir = projectMemoryDir(projectName);
  const header = '# 项目记忆（已终验清理）\n\n<!-- 本项目已终验；原内容已快照到 _archive/记忆-<ts>/，需要时执行 finalize restore -->\n';
  const before = memoryFiles(projectName);
  for (const f of before) fs.writeFileSync(f.file, header, 'utf8');
  return { before, after: memoryFiles(projectName), dir };
}

function writeFinalizeRecord(projectName, projectPath, record, mem) {
  const dir = path.join(projectPath, '终验');
  ensureDir(dir);
  const ts = record.finalizedAt.replace(/[-:T]/g, '').replace(/\..*$/, '').replace(/^(\d{8})(\d{6})$/, '$1-$2');
  const base = `FV-${ts}`;
  const jsonFile = path.join(dir, `${base}.json`);
  fs.writeFileSync(jsonFile, JSON.stringify(record, null, 2) + '\n', 'utf8');
  const md = `# 项目终验记录 · ${projectName}\n\n- 时间：${record.finalizedAt}\n- 操作人：${record.operator}\n- 结果：${record.result}\n- 需求：${record.requirements.length} 条（全部 accepted/terminated）\n- 提交哈希：${record.commitHashes.length ? record.commitHashes.join('、') : '（无）'}\n- 记忆：${record.memory.status}${record.memory.cleared ? '（已清理）' : '（未清理）'}${record.memory.archivePath ? '，快照 ' + record.memory.archivePath : ''}\n- 来源：${record.source}\n`;
  fs.writeFileSync(path.join(dir, `${base}.md`), md, 'utf8');
  return { jsonFile, mdFile: path.join(dir, `${base}.md`) };
}

function commitHashesOf(projectPath) {
  const list = [];
  const commitsDir = path.join(projectPath, '..', '..', '团队', '状态', '项目', path.basename(projectPath), '提交');
  let names = [];
  try { names = fs.readdirSync(commitsDir).filter((n) => n.endsWith('.json')); } catch { return list; }
  for (const name of names.slice(-5)) {
    try { const j = JSON.parse(fs.readFileSync(path.join(commitsDir, name), 'utf8')); if (j.proposalHash) list.push(String(j.proposalHash)); } catch { /* 跳过损坏 */ }
  }
  return list;
}

/** 终验主流程。 */
export function finalizeRun({ projectName, token, force = false }) {
  const boot = requireBoot(token);
  const role = String(boot.role || '');
  if (!FINALIZE_ROLES.has(role)) fail('PERMISSION_DENIED', `只有 PM/Owner 能终验（当前角色 ${role}）`);
  const project = loadProject(projectName);
  const projectPath = project.path;
  const state = project || {};
  if (state.finalizedAt && !force) {
    fail('ALREADY_FINALIZED', `项目已终验（${state.finalizedAt}）；如需强制重验，Owner 显式 --force 并留痕`);
  }
  const pre = finalizePrecheck(projectName);
  if (!pre.ok) {
    const parts = [];
    if (pre.openRequirements.length) parts.push(`未收口需求 ${pre.openRequirements.map((r) => `${r.id}(${r.status})`).join('、')}`);
    if (pre.openTasks.length) parts.push(`未闭环任务 ${pre.openTasks.map((t) => `${t.id}(${t.owner}/${t.status})`).join('、')}`);
    if (pre.dispatches.length) parts.push(`未消费派单 ${pre.dispatches.map((d) => `${d.id}→${d.to}`).join('、')}`);
    fail('PRECHECK_FAILED', parts.join('；'));
  }
  const memory = detectOptionalPlugins().plugins.find((p) => p.id === 'memory-evolve');
  const memoryStatus = memory ? memory.status : 'off';
  let mem = { status: memoryStatus, cleared: false, archivePath: '' };
  if (memoryStatus === 'on') {
    const snap = snapshotMemory(projectName, projectPath);
    const cleared = clearMemory(projectName);
    mem = { status: memoryStatus, cleared: true, archivePath: path.relative(projectPath, snap.dir).replace(/\\/g, '/'), snapshotFiles: snap.manifest.files, clearedFiles: cleared.after.map((f) => f.name) };
  }
  const record = {
    project: projectName,
    finalizedAt: nowIso(),
    operator: role,
    requirements: pre.requirements,
    commitHashes: commitHashesOf(projectPath),
    memory: mem,
    result: 'passed',
    source: 'team.mjs finalize run',
    forced: Boolean(force),
  };
  const written = writeFinalizeRecord(projectName, projectPath, record, mem);
  // 标记项目已终验
  const projectJson = path.join(projectStatePaths(projectName).dir, '项目.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(projectJson, 'utf8').replace(/^\uFEFF/, '')); } catch { data = {}; }
  data.finalizedAt = record.finalizedAt;
  data.finalizedBy = role;
  fs.writeFileSync(projectJson, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return { ok: true, code: 'OK', record, recordJson: written.jsonFile, recordMd: written.mdFile, memory: mem, precheck: pre };
}

/** 从快照恢复本项目记忆（条目/哈希与清理前一致）。 */
export function finalizeRestore({ projectName, snapshot }) {
  const project = loadProject(projectName);
  const projectPath = project.path;
  const dir = path.resolve(projectPath, String(snapshot || ''));
  const manifestFile = path.join(dir, 'manifest.json');
  if (!fs.existsSync(manifestFile)) fail('SNAPSHOT_MISSING', `快照不存在或缺 manifest.json：${dir}`);
  const manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8'));
  const target = projectMemoryDir(projectName);
  ensureDir(target);
  const restored = [];
  for (const entry of manifest.files || []) {
    const src = path.join(projectPath, entry.file);
    if (!fs.existsSync(src)) fail('SNAPSHOT_CORRUPT', `快照文件缺失：${entry.file}`);
    fs.copyFileSync(src, path.join(target, entry.name));
    restored.push({ name: entry.name, sha256: sha(fs.readFileSync(path.join(target, entry.name))) });
  }
  const after = memoryFiles(projectName);
  const match = (manifest.files || []).every((f) => after.find((a) => a.name === f.name && a.sha256 === f.sha256));
  const record = { at: nowIso(), project: projectName, snapshot: dir, restored, match, target };
  const recordFile = path.join(dir, 'restore.json');
  fs.writeFileSync(recordFile, JSON.stringify(record, null, 2) + '\n', 'utf8');
  return { ok: true, code: 'OK', record, recordFile };
}

export function finalizeStatus(projectName) {
  const project = loadProject(projectName);
  const state = project.state || {};
  const recordDir = path.join(project.path, '终验');
  let records = [];
  try { records = fs.readdirSync(recordDir).filter((n) => n.endsWith('.json')).sort(); } catch { records = []; }
  return { ok: true, project: projectName, finalizedAt: state.finalizedAt || '', finalizedBy: state.finalizedBy || '', records, memoryDir: projectMemoryDir(projectName) };
}

export function cmdFinalize(args) {
  const action = String((args._ && args._[1]) || 'status').toLowerCase();
  const projectName = String(args.project || '');
  if (!projectName) throw new Error('需要 --project');
  if (action === 'run') {
    const r = finalizeRun({ projectName, token: String(args.boot || ''), force: Boolean(args.force) });
    if (args.json) { jsonOut(r); return; }
    textOut([`终验完成：${r.record.finalizedAt} ｜ ${r.record.result}`, `记录：${r.recordJson}`, `记忆：${r.memory.status}${r.memory.cleared ? '（已清理，快照 ' + r.memory.archivePath + '）' : '（未清理）'}`].join('\n'));
    return;
  }
  if (action === 'restore') {
    const r = finalizeRestore({ projectName, snapshot: String(args.snapshot || '') });
    if (args.json) { jsonOut(r); return; }
    textOut(`已恢复 ${r.record.restored.length} 个文件（哈希一致：${r.record.match}）：${r.recordFile}`);
    return;
  }
  if (action === 'status') {
    const r = finalizeStatus(projectName);
    if (args.json) { jsonOut(r); return; }
    textOut([`项目 ${projectName}：${r.finalizedAt ? '已终验（' + r.finalizedAt + '，' + r.finalizedBy + '）' : '未终验'}`, `记录 ${r.records.length} 条；记忆目录 ${r.memoryDir}`].join('\n'));
    return;
  }
  if (action === 'precheck') {
    const r = finalizePrecheck(projectName);
    if (!r.ok) process.exitCode = 1;
    if (args.json) { jsonOut(r); return; }
    textOut([`前置检查：${r.ok ? 'PASS' : 'FAIL'}`, ...(r.openRequirements.length ? ['未收口需求：' + r.openRequirements.map((x) => x.id + '(' + x.status + ')').join('、')] : []), ...(r.openTasks.length ? ['未闭环任务：' + r.openTasks.map((x) => x.id + '(' + x.owner + '/' + x.status + ')').join('、')] : [])].join('\n'));
    return;
  }
  throw new Error('finalize 只支持 run | precheck | restore | status');
}
