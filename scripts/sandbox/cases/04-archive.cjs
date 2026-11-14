#!/usr/bin/env node
'use strict';
/**
 * 用例 ④：迁移 / 归档（session archive，会删改真实状态，必须进沙盘）
 * 断言：PM 在沙盘自归档成功、归档记录与 Owner 确认待办都落在沙盘；
 *       「有未闭环任务的角色」归档被 TASK_OPEN 拒（门禁在沙盘同样生效）。
 */
const fs = require('node:fs');
const lib = require('./_lib.cjs');

const checks = new lib.Checks();
const pm = lib.boot('pm');
checks.add('沙盘内 boot pm 成功（归档需要 PM 令牌）', pm.ok);

if (pm.ok) {
  const archived = lib.teamJson(['session', 'archive', '--project', lib.PROJECT, '--boot', pm.token, '--role', 'pm', '--self', '--reason', '沙盘归档（R-7841 AC3④）']);
  checks.add('沙盘内 session archive --self 成功', archived.ok === true, { code: archived.code || 'OK', file: archived.file });

  const archiveDir = lib.sandboxPath('团队', '状态', '项目', lib.PROJECT, '会话归档');
  const files = lib.listFiles(archiveDir).filter((name) => /\.json$/i.test(name));
  checks.add('归档记录落盘到沙盘 会话归档/*.json', files.length > 0, { files: files.slice(0, 5) });

  const record = files.length ? JSON.parse(fs.readFileSync(`${archiveDir}/${files[0]}`, 'utf8').replace(/^\uFEFF/, '')) : null;
  checks.add('归档记录含 9 字段与 self 标记（待 Owner 确认，不假成功）', Boolean(record && record.id && record.role === 'pm' && record.self === true && record.confirmedAt === null), { keys: record ? Object.keys(record) : [] });

  const box = lib.readJsonSandbox('团队', '状态', '项目', lib.PROJECT, '决策箱.json');
  const boxRows = (box && (box.entries || box.items || box.decisions)) || [];
  checks.add('PM 自归档的 Owner 确认请求已进沙盘决策箱', Array.isArray(boxRows) && boxRows.length > 0, { entries: Array.isArray(boxRows) ? boxRows.length : 0 });

  // 反例：有未闭环任务的角色不能归档（TASK_OPEN），门禁在沙盘同样生效
  const blocked = lib.teamJson(['session', 'archive', '--project', lib.PROJECT, '--boot', pm.token, '--role', 'programmer1', '--confirm', '--force', '--reason', '沙盘门禁反例']);
  checks.add('有未闭环任务的角色归档被拒（TASK_OPEN）', blocked.ok === false && String(blocked.code) === 'TASK_OPEN', { code: blocked.code });

  lib.emit({
    ok: checks.ok,
    case: '04-archive',
    category: '④迁移/归档/清理',
    archived: archived.ok === true,
    archiveFiles: files.length,
    taskOpenGate: blocked.ok === false && String(blocked.code) === 'TASK_OPEN',
  }, checks);
} else {
  lib.emit({ ok: false, case: '04-archive', category: '④迁移/归档/清理', bootFailed: true }, checks);
}
