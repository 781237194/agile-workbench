// 团队工作台 v2 · 项目级隔离迁移（R-d19e 批①）
// 口径：需求 R-20261120-021829-d19e §6.4；项目级优先、团队级兜底；无归属 → 状态/_legacy/（只读）。
// 命令：team.mjs migrate project-isolation [--dry-run] [--yes] [--json] [--only tokens|mail|locks|owner-confirm]
import fs from 'node:fs';
import path from 'node:path';
import { PATHS, nowIso, stamp, ensureDir, fail, textOut, appendLine } from './core.mjs';
import { projectStateDirOf, projectSubdir } from './project-paths.mjs';
import { projectStatePaths, requireBoot } from './store.mjs';

const ONLY_ALLOWED = new Set(['tokens', 'mail', 'locks', 'owner-confirm']);

/** 迁移前消费点核对表（与需求 §6.9 / 增补卷-d19e-1 对应）。 */
const CONSUMERS = [
  { key: 'tokens', file: '团队/工具/lib/store.mjs', marker: 'resolveBootTokenPath', note: 'requireBoot/noteActionAfterWrite 读取' },
  { key: 'tokens', file: '团队/工具/lib/auto-boot.mjs', marker: 'tokenFiles(project)', note: '自动 boot 扫描' },
  { key: 'tokens', file: '团队/工具/lib/session-archive.mjs', marker: "projectStatePaths(projectName).dir, '启动'", note: '归档清理令牌扫描' },
  { key: 'tokens', file: 'src/main.js', marker: "'状态', '项目', teamTools.teamSlug", note: 'latestProjectBootToken 项目级优先' },
  { key: 'mail', file: '团队/工具/lib/mail-store.mjs', marker: 'projectSubdir(project, \'邮箱\')', note: '邮箱项目级优先+团队级兜底' },
  { key: 'locks', file: '团队/工具/lib/dispatch-check.mjs', marker: '派单锁.json', note: '派单锁已在项目状态目录' },
  { key: 'owner-confirm', file: '团队/工具/lib/owner-confirm.mjs', marker: 'projectStateSlugs()', note: 'nonce 项目级兜底读取' },
];

export function consumerCheck() {
  const rows = CONSUMERS.map((c) => {
    try {
      const s = fs.readFileSync(path.join(PATHS.workspace, c.file), 'utf8');
      return { ...c, ok: s.includes(c.marker) };
    } catch { return { ...c, ok: false, error: 'READ_FAILED' }; }
  });
  return {
    checked: rows.filter((r) => r.ok).length,
    pending: rows.filter((r) => !r.ok).map((r) => `${r.file}:${r.key}`),
    na: 0,
    rows,
  };
}

function backupRoot(ts) {
  return path.join(PATHS.state, '备份', `项目隔离-${ts}`);
}

function listJsonFiles(dir) {
  try { return fs.readdirSync(dir).filter((n) => n.endsWith('.json')).map((n) => path.join(dir, n)); } catch { return []; }
}

function readJsonFile(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

function moveWithBackup(file, target, moved, backupDir, dryRun) {
  if (!dryRun) {
    ensureDir(path.dirname(target));
    if (fs.existsSync(target)) return { moved: false, skipped: 'TARGET_EXISTS' };
    ensureDir(backupDir);
    fs.copyFileSync(file, path.join(backupDir, `${stamp()}-${path.basename(file)}`));
    fs.renameSync(file, target);
  }
  moved.push({ from: file, to: target });
  return { moved: true };
}

export function migrateProjectIsolation({ only = [], dryRun = true, now = Date.now(), projectFilter = '' } = {}) {
  const onlySet = new Set(only.length ? only : [...ONLY_ALLOWED]);
  for (const k of onlySet) if (!ONLY_ALLOWED.has(k)) fail('BAD_ARGS', `--only 只支持 tokens|mail|locks|owner-confirm（收到 ${k}）`, { allowed: [...ONLY_ALLOWED] });
  const ts = new Date(now).toISOString().replace(/[-:T]/g, '').slice(0, 14);
  const backupDir = backupRoot(ts);
  const moved = [];
  const result = { dryRun: Boolean(dryRun), ts, backupDir, only: [...onlySet], tokens: { scanned: 0, moved: 0, skipped: 0 }, mail: { roles: 0, moved: 0, skipped: 0, unowned: 0 }, locks: { moved: 0, skipped: 0 }, ownerConfirm: { moved: 0, skipped: 0 }, legacy: 0, rollback: null, audit: '', consumer: consumerCheck() };
  try {
    // 1) 启动令牌
    if (onlySet.has('tokens')) {
      for (const file of listJsonFiles(PATHS.boots)) {
        result.tokens.scanned += 1;
        const row = readJsonFile(file);
        const project = String((row && row.project) || '').trim();
        if (!project) {
          // 无归属 → 状态/_legacy/启动/（只读保留）
          const r = moveWithBackup(file, path.join(PATHS.state, '_legacy', '启动', path.basename(file)), moved, backupDir, dryRun);
          if (r.moved) result.legacy += 1; else result.tokens.skipped += 1;
          continue;
        }
        const target = path.join(projectSubdir(project, '启动'), path.basename(file));
        const r = moveWithBackup(file, target, moved, backupDir, dryRun);
        if (r.moved) result.tokens.moved += 1; else result.tokens.skipped += 1;
      }
    }
    // 2) 邮箱：按消息 project 分桶
    if (onlySet.has('mail')) {
      let roles = [];
      try { roles = fs.readdirSync(PATHS.mail, { withFileTypes: true }).filter((e) => e.isDirectory() && !['_legacy', '归档'].includes(e.name)).map((e) => e.name); } catch { roles = []; }
      result.mail.roles = roles.length;
      for (const role of roles) {
        const src = path.join(PATHS.mail, role, 'messages.jsonl');
        if (!fs.existsSync(src)) continue;
        const lines = fs.readFileSync(src, 'utf8').split(/\r?\n/).filter(Boolean);
        const keep = [];
        const buckets = new Map();
        for (const line of lines) {
          let row = null;
          try { row = JSON.parse(line); } catch { keep.push(line); continue; }
          if (!row || row.type === 'event' || !row.id) { keep.push(line); continue; }
          const project = String(row.project || '').trim();
          if (!project) {
            result.mail.unowned += 1;
            result.legacy += 1;
            if (!dryRun) {
              const legacyDir = path.join(PATHS.state, '_legacy', '邮箱');
              ensureDir(legacyDir);
              fs.appendFileSync(path.join(legacyDir, `${role}.jsonl`), line + '\n', 'utf8');
            }
            continue;
          }
          if (!buckets.has(project)) buckets.set(project, []);
          buckets.get(project).push(line);
        }
        if (dryRun) {
          for (const [, rows] of buckets) result.mail.moved += rows.length;
          continue;
        }
        if (buckets.size) {
          ensureDir(backupDir);
          fs.copyFileSync(src, path.join(backupDir, `邮箱-${role}.messages.jsonl`));
        }
        for (const [project, rows] of buckets) {
          const targetDir = path.join(projectSubdir(project, '邮箱'), role);
          ensureDir(targetDir);
          fs.appendFileSync(path.join(targetDir, 'messages.jsonl'), rows.join('\n') + '\n', 'utf8');
          fs.appendFileSync(path.join(targetDir, 'index.json.tmp'), '', 'utf8');
          result.mail.moved += rows.length;
        }
        try { fs.rmSync(path.join(src, '..', 'index.json.tmp'), { force: true }); } catch { /* ignore */ }
        fs.writeFileSync(src, keep.length ? keep.join('\n') + '\n' : '', 'utf8');
      }
    }
    // 3) 锁：boot 锁按文件内 project 归项目锁目录
    if (onlySet.has('locks')) {
      let files = [];
      try { files = fs.readdirSync(PATHS.locks).filter((n) => n.endsWith('.json')).map((n) => path.join(PATHS.locks, n)); } catch { files = []; }
      for (const file of files) {
        const row = readJsonFile(file);
        const project = String((row && row.project) || '').trim();
        if (!project) { result.locks.skipped += 1; continue; }
        const r = moveWithBackup(file, path.join(projectSubdir(project, '锁'), path.basename(file)), moved, backupDir, dryRun);
        if (r.moved) result.locks.moved += 1; else result.locks.skipped += 1;
      }
    }
    // 4) owner-confirm
    if (onlySet.has('owner-confirm')) {
      const dir = path.join(PATHS.state, 'owner-confirm');
      for (const file of listJsonFiles(dir)) {
        const row = readJsonFile(file);
        const project = String((row && row.project) || '').trim();
        if (!project) { result.ownerConfirm.skipped += 1; continue; }
        const r = moveWithBackup(file, path.join(projectSubdir(project, 'owner-confirm'), path.basename(file)), moved, backupDir, dryRun);
        if (r.moved) result.ownerConfirm.moved += 1; else result.ownerConfirm.skipped += 1;
      }
    }
    if (!dryRun) {
      result.audit = path.join(PATHS.state, '项目隔离迁移.jsonl');
      appendLine(result.audit, JSON.stringify({ at: nowIso(), event: 'project_isolation_migrate', ok: true, ts, only: [...onlySet], moved: moved.length, tokens: result.tokens, mail: { moved: result.mail.moved, unowned: result.mail.unowned }, locks: result.locks, ownerConfirm: result.ownerConfirm, backupDir, consumer: { checked: result.consumer.checked, pending: result.consumer.pending } }));
    }
    return { ok: true, ...result, movedCount: moved.length };
  } catch (e) {
    // 失败回滚：反向移动 + 邮箱文件从备份还原
    const rollback = { restored: 0, failed: 0 };
    if (!dryRun) {
      for (const m of moved.slice().reverse()) {
        try { ensureDir(path.dirname(m.from)); fs.renameSync(m.to, m.from); rollback.restored += 1; } catch { rollback.failed += 1; }
      }
      try {
        const bk = fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter((n) => n.endsWith('.messages.jsonl')) : [];
        for (const n of bk) {
          const role = n.replace(/^.*?邮箱-/, '').replace(/\.messages\.jsonl$/, '');
          fs.copyFileSync(path.join(backupDir, n), path.join(PATHS.mail, role, 'messages.jsonl'));
          rollback.restored += 1;
        }
      } catch { rollback.failed += 1; }
      try {
        appendLine(path.join(PATHS.state, '项目隔离迁移.jsonl'), JSON.stringify({ at: nowIso(), event: 'project_isolation_migrate', ok: false, error: String((e && e.message) || e), rollback }));
      } catch { /* ignore */ }
    }
    if (e && e.code && e.name === 'TeamError') throw e;
    fail('MIGRATION_FAILED', `项目隔离迁移失败：${String((e && e.message) || e)}；已回滚 restored=${rollback.restored} failed=${rollback.failed}`, { rollback });
  }
}

export function cmdMigrate(args) {
  const sub = String((args._ && args._[1]) || '').toLowerCase();
  if (sub !== 'project-isolation') fail('BAD_SUBCOMMAND', `migrate 只支持 project-isolation（收到 ${sub || '(空)'}）`, { usage: 'team.mjs migrate project-isolation [--dry-run] [--yes] [--json] [--only tokens,mail,locks,owner-confirm]' });
  const dryRun = Boolean(args['dry-run']) || !args.yes;
  // 落地（--yes）需 pm/owner 令牌；沙盘豁免（与 mail migrate 同口径）。
  if (!dryRun && String(process.env.TEAM_SELFTEST || '') !== '1') {
    const token = String(args.boot || '').trim();
    if (!token) fail('BOOT_REQUIRED', 'migrate project-isolation --yes 必须带 --boot（pm/owner 令牌）', { action: 'project-isolation' });
    const info = requireBoot(token, { write: true });
    const actor = String(info.role || '');
    if (actor !== 'pm' && actor !== 'owner') fail('PERMISSION_DENIED', `只有 pm/owner 能执行项目隔离迁移（当前令牌角色 ${actor || '-'}）`, { action: 'project-isolation', tokenRole: actor });
  }
  const only = String(args.only || '').split(',').map((s) => s.trim()).filter(Boolean);
  const consumer = consumerCheck();
  const r = migrateProjectIsolation({ only, dryRun });
  const lines = [
    `项目隔离迁移（${dryRun ? 'dry-run' : '已执行'}）：启动 扫描 ${r.tokens.scanned}/移动 ${r.tokens.moved}/跳过 ${r.tokens.skipped}；`,
    `邮箱 ${r.mail.roles} 角色/移动 ${r.mail.moved} 条/无归属 ${r.mail.unowned}；锁 移动 ${r.locks.moved}；owner-confirm 移动 ${r.ownerConfirm.moved}`,
    `消费点核对：已核对 ${consumer.checked}/待改 ${consumer.pending.length}/不适用 ${consumer.na}${consumer.pending.length ? ' → ' + consumer.pending.join('、') : ''}`,
    dryRun ? '（dry-run 未写盘；加 --yes 执行）' : `备份=${r.backupDir} 审计=${r.audit}`,
  ];
  if (consumer.pending.length) fail('CONSUMER_CHECK_INCOMPLETE', `消费点未全部接线（待改 ${consumer.pending.length}）：${consumer.pending.join('、')}；不得合入`, { consumer }, 2);
  textOut(lines.join('\n'));
  if (args.json) process.stdout.write(JSON.stringify({ ok: true, action: 'project-isolation', ...r, consumer }) + '\n');
}
