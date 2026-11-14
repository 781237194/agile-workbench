#!/usr/bin/env node
'use strict';
/**
 * 用例 ③：消息发送与唤醒链路（会真发消息，不可撤回 —— B-3c03 事故类别）
 * 断言：沙盘内 send 成功、消息只落在沙盘 pm 邮箱；真实邮箱是否被污染由 run.cjs 的 MESSAGE_MARKER 探针判定。
 */
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./_lib.cjs');

const checks = new lib.Checks();
const booted = lib.boot('programmer2');
checks.add('沙盘内 boot programmer2 成功', booted.ok);

if (booted.ok) {
  const subject = '沙盘消息（R-7841 ③消息链路）';
  const sent = lib.teamJson(['send', '--project', lib.PROJECT, '--boot', booted.token, '--to', 'pm', '--subject', subject, '--body', `探针正文 ${lib.MESSAGE_MARKER}`, '--type', 'notice', '--no-wake']);
  checks.add('沙盘内 send 成功（--no-wake 不发真实唤醒）', sent.ok === true, { code: sent.code || 'OK', wakeFailed: sent.wakeFailed });

  const pmNew = lib.sandboxPath('团队', '状态', '邮箱', 'pm', 'new');
  const hits = lib.listFiles(pmNew).filter((name) => {
    try { return fs.readFileSync(path.join(pmNew, name), 'utf8').includes(lib.MESSAGE_MARKER); } catch { return false; }
  });
  checks.add('消息落在沙盘 pm 邮箱（new/）', hits.length === 1, { files: hits });

  const teamJson = lib.readJsonSandbox('团队', '状态', '团队.json');
  const ids = ((teamJson && teamJson.members) || []).map((row) => String(row.sessionId || '').trim()).filter(Boolean);
  const cleared = ids.every((id) => id === lib.MARKER);
  checks.add('沙盘名册里没有真实 sessionId（只有空或沙盘标记，发消息找不到真人）', cleared, { ids });

  lib.emit({
    ok: checks.ok,
    case: '03-message',
    category: '③消息与唤醒',
    deliveredToSandboxMailbox: hits.length === 1,
    rosterSessionIdsCleared: cleared,
  }, checks);
} else {
  lib.emit({ ok: false, case: '03-message', category: '③消息与唤醒', bootFailed: true }, checks);
}
