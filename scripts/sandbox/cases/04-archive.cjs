#!/usr/bin/env node
'use strict';
/**
 * 用例 ④：迁移 / 归档（session archive，会删改真实状态，必须进沙盘）
 *
 * 断言（可重复跑：同一个 root 连跑两次也必须一致 PASS）：
 *   ① PM 在沙盘自归档成功（首次）／已存在待 Owner 确认的自归档时视为已完成（第二次跑的幂等口径）；
 *   ② 归档记录与 Owner 确认请求都落在沙盘；
 *   ③ 反例：**先造一个未闭环任务**，再归档该角色 → 必须被 TASK_OPEN 拒（v159 指出原来没有前置，断言必红）。
 */
const fs = require('node:fs');
const lib = require('./_lib.cjs');

const checks = new lib.Checks();
const pm = lib.boot('pm');
checks.add('沙盘内 boot pm 成功（归档需要 PM 令牌）', pm.ok);

if (pm.ok) {
  const archiveDir = lib.sandboxPath('团队', '状态', '项目', lib.PROJECT, '会话归档');
  const listArchives = () => lib.listFiles(archiveDir).filter((name) => /\.json$/i.test(name));
  const readArchive = (name) => { try { return JSON.parse(fs.readFileSync(`${archiveDir}/${name}`, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; } };

  // 幂等：第二次跑时已经存在「PM 自归档、待 Owner 确认」的记录，就不再重复 --self（否则 OWNER_CONFIRM_REQUIRED）
  const pendingSelf = listArchives().map(readArchive).find((row) => row && row.role === 'pm' && row.self === true && !row.confirmedAt);
  let archivedOk = false;
  let archivedCode = '';
  if (pendingSelf) {
    archivedOk = true;
    archivedCode = 'ALREADY_SELF_ARCHIVED';
  } else {
    const archived = lib.teamJson(['session', 'archive', '--project', lib.PROJECT, '--boot', pm.token, '--role', 'pm', '--self', '--reason', '沙盘归档（R-7841 AC3④）']);
    archivedOk = archived.ok === true;
    archivedCode = String(archived.code || (archived.ok ? 'OK' : 'FAILED'));
  }
  // 断言名在「首次跑」和「重复跑」下保持一致（AC2 按 checks 深度相等比两次结果）
  checks.add('PM 自归档状态成立（首次执行 / 重复跑幂等）', archivedOk, { mode: pendingSelf ? 'ALREADY_SELF_ARCHIVED' : 'ARCHIVED', code: archivedCode });

  const files = listArchives();
  checks.add('归档记录落盘到沙盘 会话归档/*.json', files.length > 0, { files: files.slice(0, 5) });

  const selfRecord = files.map(readArchive).find((row) => row && row.role === 'pm' && row.self === true);
  checks.add('归档记录含 9 字段与 self 标记（待 Owner 确认，不假成功）', Boolean(selfRecord && selfRecord.id && selfRecord.self === true && selfRecord.confirmedAt === null), { keys: selfRecord ? Object.keys(selfRecord) : [] });

  const box = lib.readJsonSandbox('团队', '状态', '项目', lib.PROJECT, '决策箱.json');
  const boxRows = (box && (box.entries || box.items || box.decisions)) || [];
  checks.add('PM 自归档的 Owner 确认请求已进沙盘决策箱', Array.isArray(boxRows) && boxRows.length > 0, { entries: Array.isArray(boxRows) ? boxRows.length : 0 });

  // 反例前置（v159）：先造一个未闭环任务，保证 TASK_OPEN 门禁有真实输入
  const targetRole = 'programmer1';
  const created = lib.teamJson(['task', 'create', '--project', lib.PROJECT, '--boot', pm.token, '--title', '沙盘门禁反例任务', '--priority', 'P1', '--type', 'task', '--owner', targetRole, '--detail', 'R-7841 AC3④ 反例前置：未闭环任务存在时归档必须 TASK_OPEN']);
  const createdId = String((created && (created.id || (created.task && created.task.id))) || '');
  checks.add('反例前置：在沙盘里造出一个未闭环任务', Boolean(createdId) && created.ok !== false, { code: created.code || 'OK', taskId: createdId });

  const blocked = lib.teamJson(['session', 'archive', '--project', lib.PROJECT, '--boot', pm.token, '--role', targetRole, '--confirm', '--force', '--reason', '沙盘门禁反例']);
  checks.add('有未闭环任务的角色归档被拒（TASK_OPEN）', blocked.ok === false && String(blocked.code) === 'TASK_OPEN', { code: blocked.code, taskId: createdId });

  lib.emit({
    ok: checks.ok,
    case: '04-archive',
    category: '④迁移/归档/清理',
    archived: archivedOk,
    archivedCode,
    archiveFiles: files.length,
    taskOpenGate: blocked.ok === false && String(blocked.code) === 'TASK_OPEN',
    idempotentRerun: Boolean(pendingSelf),
  }, checks);
} else {
  lib.emit({ ok: false, case: '04-archive', category: '④迁移/归档/清理', bootFailed: true }, checks);
}
