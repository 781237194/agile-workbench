#!/usr/bin/env node
'use strict';
/**
 * 用例 ②：团队名册 / 角色卡 / 铁律变更（RULES_CHANGED）
 * 断言：改沙盘《团队宪法》→ 旧令牌立刻作废（RULES_CHANGED）；改名册成员 → 重新 boot 的 rulesHash 变化、
 *       展示名在简报里生效。全流程只写沙盘副本（run.cjs 侧对真实文件做哈希+标记断言）。
 */
const fs = require('node:fs');
const lib = require('./_lib.cjs');

const checks = new lib.Checks();

const first = lib.boot('tester');
checks.add('沙盘内 boot tester 成功', first.ok, { rulesHash: first.rulesHash.slice(0, 8) });

if (first.ok) {
  // 1) 规则变更：追加一行到沙盘 团队宪法.md
  fs.appendFileSync(lib.sandboxPath('团队', '团队宪法.md'), '\n> 沙盘规则变更探针（R-7841，仅沙盘副本）\n', 'utf8');
  const stale = lib.teamJson(['send', '--project', lib.PROJECT, '--boot', first.token, '--to', 'pm', '--subject', '规则变更后', '--body', '应被 RULES_CHANGED 拒', '--type', 'notice', '--no-wake']);
  checks.add('改规则后旧令牌被拒（RULES_CHANGED）', stale.ok === false && String(stale.code) === 'RULES_CHANGED', { code: stale.code });

  // 2) 名册变更：改一个成员显示名
  const rosterPath = lib.sandboxPath('团队', '状态', '团队.json');
  const roster = JSON.parse(fs.readFileSync(rosterPath, 'utf8').replace(/^\uFEFF/, ''));
  const target = (roster.members || []).find((row) => row.role === 'tester');
  if (target) target.name = `${target.name}-沙盘改名`;
  fs.writeFileSync(rosterPath, JSON.stringify(roster, null, 2) + '\n', 'utf8');

  const second = lib.boot('tester');
  checks.add('名册变更后重新 boot 成功且 rulesHash 变化', second.ok && second.rulesHash && second.rulesHash !== first.rulesHash, { before: first.rulesHash.slice(0, 8), after: second.rulesHash.slice(0, 8) });

  const briefRun = lib.team(['boot', '--role', 'tester', '--project', lib.PROJECT]);
  checks.add('改名后的展示名在简报里生效（团队.json 是唯一显示名单一口径）', String(briefRun.stdout || '').includes('沙盘改名'), { exitCode: briefRun.status });

  lib.emit({
    ok: checks.ok,
    case: '02-rules',
    category: '②名册/角色卡/铁律变更',
    rulesChangedRejected: stale.ok === false && String(stale.code) === 'RULES_CHANGED',
    rulesHashChanged: Boolean(second.rulesHash && second.rulesHash !== first.rulesHash),
    displayNameFollowsRoster: String(briefRun.stdout || '').includes('沙盘改名'),
  }, checks);
} else {
  lib.emit({ ok: false, case: '02-rules', category: '②名册/角色卡/铁律变更', bootFailed: true }, checks);
}
