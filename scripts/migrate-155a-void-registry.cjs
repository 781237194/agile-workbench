'use strict';
/**
 * B-a17d / B-155a 数据修复：把误写进「仓库根」的作废登记迁到「项目根/需求/作废登记.jsonl」。
 *
 * 背景：旧 cmdReqVoid 用 团队/状态/项目/<项目>/ 向上 4 级拼 registry（ops.mjs 旧 3368 行），
 *       结果写到 <仓库根>/需求/作废登记.jsonl：①未 gitignore → git status 出现 ?? 需求/；
 *       ②跨项目共用；③没有 project 字段；④快照层又不消费它（作废不生效）。
 *
 * 本脚本只做三件事（幂等，可重跑）：
 *   ① 把仓库根登记逐行补 project 字段后追加到项目根登记（已在项目登记里的 id 跳过）；
 *   ② 把对应需求任务文件收口（status=done + workflow.voided=true），
 *      否则 readWorkflowSnapshot 会继续用任务文件把它们造回 review；
 *   ③ 全部迁完后把仓库根文件移到 _backup/<stamp>-a17d-migrate/（不直接删，留回滚）。
 *
 * 用法：
 *   node scripts/migrate-155a-void-registry.cjs [--project "工作台改造修复"] [--dry-run]
 *
 * ⚠️ 本脚本写的是「已由 PM 在 2026-11-15 04:42 作废过」这批记录的落点，不新做任何作废决定；
 *    by 字段沿用原始登记人（pm）。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const TEAM_ROOT = path.join(ROOT, '团队');
const argOf = (name, fallback = '') => {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 && process.argv[i + 1] ? String(process.argv[i + 1]) : fallback;
};
const PROJECT = argOf('project', '工作台改造修复');
const DRY = process.argv.includes('--dry-run');
const stamp = new Date().toISOString().replace(/[-:T]/g, '').slice(0, 14);

function readJson(file, fallback) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return fallback; }
}
function readJsonl(file) {
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const raw of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    try { out.push(JSON.parse(line)); } catch { out.push({ __bad: line.slice(0, 120) }); }
  }
  return out;
}
function writeJsonl(file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + (rows.length ? '\n' : ''), 'utf8');
}
function backup(file) {
  const rel = path.relative(ROOT, file);
  if (rel.startsWith('..')) return '';
  const dst = path.join(ROOT, '_backup', `${stamp}-a17d-migrate`, rel);
  fs.mkdirSync(path.dirname(dst), { recursive: true });
  fs.copyFileSync(file, dst);
  return dst;
}

const projectFile = path.join(TEAM_ROOT, '状态', '项目', PROJECT, '项目.json');
if (!fs.existsSync(projectFile)) { console.error(`[NO_PROJECT] 找不到项目状态：${projectFile}`); process.exit(2); }
const project = readJson(projectFile, {});
const projectDir = String(project.path || '');
if (!projectDir || !fs.existsSync(projectDir)) { console.error(`[PROJECT_DIR_MISSING] ${projectDir}`); process.exit(2); }

const legacyFile = path.join(ROOT, '需求', '作废登记.jsonl');
const targetFile = path.join(projectDir, '需求', '作废登记.jsonl');
const taskDir = path.join(TEAM_ROOT, '状态', '项目', PROJECT, '任务');
const auditFile = path.join(TEAM_ROOT, '状态', '项目', PROJECT, '作废登记迁移.jsonl');

const legacyRows = readJsonl(legacyFile).map((row) => (row && !row.__bad ? row : { __bad: String((row && row.__bad) || '').slice(0, 120) }));
const legacyGood = legacyRows.filter((row) => row && !row.__bad && String(row.requirementId || row.id || '').trim());
const targetRows = readJsonl(targetFile);
const targetIds = new Set(targetRows.map((row) => String(row.requirementId || row.id || '').trim()).filter(Boolean));

const summary = {
  stamp, project: PROJECT, projectDir, legacyFile, targetFile,
  legacyExists: fs.existsSync(legacyFile), legacyCount: legacyGood.length,
  targetBefore: targetRows.length, moved: [], skipped: [], taskClosed: [], taskMissing: [], backups: [], dryRun: DRY,
};

if (!summary.legacyExists) {
  console.log(`[SKIP] 仓库根没有作废登记：${legacyFile}`);
  console.log(JSON.stringify(summary, null, 2));
  process.exit(0);
}

for (const row of legacyRows) {
  if (row && row.__bad) { summary.skipped.push({ id: '(坏行)', reason: 'JSON 解析失败' }); continue; }
  const id = String((row && (row.requirementId || row.id)) || '').trim();
  if (!id) { summary.skipped.push({ id: '(空)', reason: 'requirementId 缺失' }); continue; }
  if (targetIds.has(id)) { summary.skipped.push({ id, reason: '项目登记里已有' }); continue; }
  const entry = {
    at: String(row.at || new Date().toISOString()),
    project: String(row.project || PROJECT),
    requirementId: id,
    reason: String(row.reason || ''),
    by: String(row.by || 'pm'),
    hadWorkflowRow: row.hadWorkflowRow === true,
    source: 'migrate_from_repo_root',
    migratedAt: new Date().toISOString(),
    migratedBy: 'programmer2',
  };
  targetRows.push(entry);
  targetIds.add(id);
  summary.moved.push(id);
}

// ② 任务文件收口（只收口本次迁到项目登记的 id，不乱动别的任务）
for (const id of summary.moved) {
  const file = path.join(taskDir, `${id}.json`);
  if (!fs.existsSync(file)) { summary.taskMissing.push(id); continue; }
  const task = readJson(file, null);
  if (!task) { summary.taskMissing.push(id); continue; }
  summary.backups.push(backup(file));
  const at = new Date().toISOString();
  task.status = 'done';
  task.doneAt = task.doneAt || at;
  task.workflow = {
    ...(task.workflow || {}),
    requirementStatus: 'terminated',
    voided: true,
    voidedAt: task.workflow && task.workflow.voidedAt ? task.workflow.voidedAt : at,
    voidReason: String((targetRows.find((r) => r.requirementId === id) || {}).reason || ''),
    voidedBy: 'pm',
    voidedSource: 'migrate_from_repo_root',
  };
  task.history = Array.isArray(task.history) ? task.history : [];
  task.history.push({ at, action: 'req_void_migrate', by: 'programmer2', note: '作废登记迁到项目根 + 任务收口（B-a17d）' });
  if (!DRY) fs.writeFileSync(file, JSON.stringify(task, null, 2) + '\n', 'utf8');
  summary.taskClosed.push(id);
}

// ③ 落盘：项目登记 + 备份仓库根 + 移走仓库根 + 审计
if (!DRY && summary.moved.length) {
  if (fs.existsSync(targetFile)) summary.backups.push(backup(targetFile));
  writeJsonl(targetFile, targetRows);
  summary.backups.push(backup(legacyFile));
  const archived = path.join(ROOT, '_backup', `${stamp}-a17d-migrate`, '需求', '作废登记.jsonl');
  fs.mkdirSync(path.dirname(archived), { recursive: true });
  fs.renameSync(legacyFile, archived);
  summary.archivedTo = archived;
  const auditRow = {
    at: new Date().toISOString(), action: 'void_registry_migrated', project: PROJECT,
    by: 'programmer2', from: legacyFile, to: targetFile,
    moved: summary.moved, skipped: summary.skipped.map((s) => s.id), taskClosed: summary.taskClosed,
  };
  fs.mkdirSync(path.dirname(auditFile), { recursive: true });
  fs.appendFileSync(auditFile, JSON.stringify(auditRow) + '\n', 'utf8');
  // 仓库根 需求/ 只剩空目录时清掉，避免 git status 出现 ?? 需求/
  try {
    const legacyDir = path.dirname(legacyFile);
    if (fs.readdirSync(legacyDir).length === 0) fs.rmdirSync(legacyDir);
  } catch { /* 非空或删不掉就留着 */ }
}

summary.targetAfter = DRY ? targetRows.length : readJsonl(targetFile).length;
console.log(`作废登记迁移：${DRY ? '（dry-run，未写入）' : '已写入'}`);
console.log(`  仓库根 ${summary.legacyCount} 行 → 迁移 ${summary.moved.length} 行，跳过 ${summary.skipped.length} 行`);
console.log(`  项目登记：${targetFile}（${summary.targetBefore} → ${summary.targetAfter}）`);
console.log(`  任务收口：${summary.taskClosed.length} 条${summary.taskMissing.length ? `，缺任务文件 ${summary.taskMissing.length} 条` : ''}`);
if (summary.archivedTo) console.log(`  仓库根文件已移到：${summary.archivedTo}`);
console.log(JSON.stringify(summary, null, 2));
