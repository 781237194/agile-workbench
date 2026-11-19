/**
 * rolecard-cli.mjs —— R-bf05（T-20261119-181230-feee）`team.mjs rolecard` 子命令
 *
 *   rolecard sync   --project <P> [--role <r>|--all] [--dry-run|--apply] [--boot <T>] [--json]
 *   rolecard status --project <P> [--role <r>|--all] [--json]      # 只读检测（三入口之一）
 *   rolecard manifest --write [--boot <T>] [--json]                 # 重建 模板/角色卡模板版本.json
 *
 * 语义（需求 §7.3）：默认 dry-run；`--dry-run` 与 `--apply` 互斥；`--apply` 必须带 `--boot`，
 * 仅本人或 PM/Owner；`--all` 只准 dry-run；冲突时该节不写、ok=false + partial:true，其余节照写。
 */
import { fail, nowIso, jsonOut } from './core.mjs';
import { requireBoot } from './store.mjs';
import {
  planRoleCardSync, applyRoleCardSync, rolecardStaleOf, rolesForProject, templateOf,
  writeManifest, readManifest, roleLabelOf, manifestPath,
} from './rolecard-sync.mjs';

const APPLY_ROLES = new Set(['pm', 'owner']);

function roleListOf(project, args) {
  const explicit = String(args.role || '').trim();
  if (explicit) {
    const list = rolesForProject(project);
    if (!list.includes(explicit)) fail('BAD_ROLE', `角色不在当前项目模式：${explicit}（可用 ${list.join(' / ')}）`, { role: explicit, project, roles: list });
    return [explicit];
  }
  if (args.all) return rolesForProject(project);
  fail('BAD_ARGS', '需要 --role <角色> 或 --all（--all 只准 dry-run）');
}

function summaryLine(row) {
  if (!row.ok) return `${row.role}: 检测失败（${row.code || 'UNKNOWN'}）`;
  const ver = row.stale ? `${row.cardVersion} → ${row.templateVersion}` : row.templateVersion;
  const mark = row.stale ? '落后' : '最新';
  return `${row.role}：模板 v${row.templateVersion} / 卡 v${row.cardVersion || '0'}（${mark}），差异 ${row.diffCount} 处`;
}

export async function cmdRolecard(args = {}) {
  const sub = String((args._ && args._[1]) || 'sync').toLowerCase();
  const project = String(args.project || '').trim();

  if (sub === 'manifest') {
    if (!args.write) fail('BAD_ARGS', 'rolecard manifest 需要 --write（重建 团队/工具/模板/角色卡模板版本.json）');
    const token = String(args.boot || '').trim();
    if (!token) fail('BOOT_REQUIRED', '重建模板 manifest 需要 --boot（PM/Owner 或本人）');
    const info = requireBoot(token, { write: true });
    const write = writeManifest({ updatedBy: String(info.role || 'unknown') });
    const data = readManifest();
    const rows = Object.entries((data.roles) || {}).map(([role, row]) => `${role}: v${row.version} sha12=${row.sha12}`);
    const result = { ok: true, action: 'manifest', file: write.file, roles: data.roles || {} };
    if (args.json) { jsonOut(result); return result; }
    console.log(`模板 manifest 已重建：${write.file}\n${rows.join('\n')}`);
    return result;
  }

  if (!project) fail('BAD_PROJECT', 'rolecard 需要 --project <项目名>');

  if (sub === 'status') {
    // status 只读：缺省查全部模式内角色（与 sync 的「必须显式指定」不同）。
    const roles = (String(args.role || '').trim() || args.all) ? roleListOf(project, args) : rolesForProject(project);
    const rows = roles.map((role) => {
      try { return rolecardStaleOf(project, role, { log: true }); } catch (error) { return { ok: false, code: String((error && error.code) || 'CHECK_FAILED'), role }; }
    });
    const staleCount = rows.filter((r) => r.ok && r.stale).length;
    const result = { ok: true, action: 'status', project, projectName: project, rows, staleCount, at: nowIso() };
    if (args.json) { jsonOut(result); return result; }
    console.log(`角色卡版本检测 · ${project}（${staleCount}/${rows.length} 落后）`);
    for (const row of rows) console.log('  ' + summaryLine(row));
    console.log('提示：只提示不写卡；要合并用 rolecard sync --role <r> --apply --boot <令牌>');
    return result;
  }

  if (sub !== 'sync') fail('BAD_SUBCOMMAND', `未知 rolecard 子命令：${sub}（sync / status / manifest）`);

  const dryRunFlag = Boolean(args['dry-run']);
  const applyFlag = Boolean(args.apply);
  if (dryRunFlag && applyFlag) fail('BAD_ARGS', '--dry-run 与 --apply 互斥');
  const apply = applyFlag; // 默认 dry-run
  let actorRole = '';
  let actor = '';
  if (apply) {
    if (args.all) fail('BAD_ARGS', '--apply --all 不允许：一次只同步一个角色（--role）');
    const token = String(args.boot || '').trim();
    if (!token) fail('BOOT_REQUIRED', '--apply 必须带 --boot（本人 / PM / Owner）');
    const info = requireBoot(token, { write: true });
    actorRole = String(info.role || '');
    actor = String(info.sessionId || '');
  }
  const roles = roleListOf(project, args);
  if (apply && roles.length === 1) {
    const role = roles[0];
    if (!(APPLY_ROLES.has(actorRole) || actorRole === role)) {
      fail('PERMISSION_DENIED', `--apply 只准本人或 PM/Owner：令牌角色 ${actorRole || '(未知)'} 不能改 ${role} 的角色卡`, { role, actorRole, project, wrote: false });
    }
  }
  const plans = [];
  for (const role of roles) {
    if (apply) {
      const plan = applyRoleCardSync(project, role, { actor, actorRole });
      plans.push(plan);
    } else {
      plans.push(planRoleCardSync(project, role));
    }
  }
  const conflicts = plans.reduce((n, p) => n + (p.conflicts ? p.conflicts.length : 0), 0);
  const wrote = plans.some((p) => p.wrote);
  const ok = conflicts === 0;
  if (args.json) {
    const payload = {
      ok, partial: conflicts > 0, project, action: 'sync', mode: apply ? 'apply' : 'dry-run',
      roles: plans.map((p) => ({
        role: p.role, ok: p.ok, partial: Boolean(p.partial), wrote: Boolean(p.wrote),
        cardVersion: p.cardVersion, cardSha256: p.cardSha256, templateVersion: p.templateVersion,
        templateSha12: p.templateSha12, stale: p.stale, changes: p.changes, conflicts: p.conflicts,
        renames: p.renames, applied: p.updateSections ? p.updateSections.map((u) => u.key) : [],
        added: p.addedKeys || [],
        backup: p.backup || '', next: p.next || '', message: p.message || '',
      })),
      applied: wrote, wrote, conflicts,
    };
    jsonOut(payload);
    if (!ok) process.exitCode = 1;
    return payload;
  }
  console.log(`rolecard sync（${apply ? 'apply' : 'dry-run'}）· ${project}`);
  for (const p of plans) {
    console.log(`\n[${roleLabelOf(p.role)}] 卡 v${p.cardVersion || '0'} → 模板 v${p.templateVersion}（sha12 ${p.templateSha12}）`);
    for (const c of p.changes || []) console.log(`  ${String(c.action).padEnd(8)} ${c.section}${c.reason ? `（${c.reason}）` : ''}`);
    for (const r of p.renames || []) console.log(`  rename   建议：${r.from} → ${r.to}（只建议，不自动改）`);
    if (p.conflicts && p.conflicts.length) console.log(`  冲突：${p.conflicts.map((c) => c.section).join('、')}（未写）`);
    if (p.wrote) console.log(`  已写卡：${p.cardSha256.slice(0, 12)}｜备份：${p.backup}\n  ${p.next}`);
    else if (p.message) console.log(`  ${p.message}`);
  }
  if (conflicts > 0) console.log('\n结果：partial（有冲突节未覆盖，其余已处理）');
  else if (wrote) console.log('\n结果：已同步（只增补/更新标准节，manual 段未动）');
  else console.log('\n结果：无需写入');
  if (!ok) process.exitCode = 1;
  return { ok, partial: conflicts > 0, project, action: 'sync', mode: apply ? 'apply' : 'dry-run', roles: plans, applied: wrote, wrote, conflicts };
}

/** 供 boot 简报/面板复用的单行文本（前缀按需求 §7.2：`角色卡模板落后:`）。 */
export function rolecardStaleBriefLines(project, role) {
  try {
    const row = rolecardStaleOf(project, role);
    if (!row.ok || !row.stale) return [];
    return [`角色卡模板落后: ${role}：模板 v${row.templateVersion} / 卡 v${row.cardVersion || '0'}（无标记），差异 ${row.diffCount} 处；看 diff：rolecard sync --role ${role} --dry-run`];
  } catch {
    return [];
  }
}
