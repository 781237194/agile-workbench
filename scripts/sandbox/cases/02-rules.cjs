#!/usr/bin/env node
'use strict';
/**
 * 用例 ②：团队名册 / 角色卡 / 铁律变更（RULES_CHANGED）—— R-a1eb 新口径
 *
 * 断言（名册已移出 rulesHash）：
 *   ① 改**成员显示名** → rulesHash **不变**，且 rosterVersion **也不变**（§6.1 只含 role/sessionId/status）；
 *   ② 只改名册不改宪法 → **旧令牌仍可写**（task create 成功，不出现 RULES_CHANGED）；
 *   ③ 改**名册 sessionId**（等价换人）→ rulesHash 仍不变、rosterVersion 变化（轻量校验的独立口径）；
 *   ④ 改**团队宪法** → 旧令牌立刻作废（RULES_CHANGED）；
 *   ⑤ 名册改名后的展示名在简报里生效（团队.json 是唯一显示名单一口径）。
 * 全流程只写沙盘副本（run.cjs 侧对真实文件做哈希+标记断言）。
 */
const fs = require('node:fs');
const lib = require('./_lib.cjs');

const checks = new lib.Checks();
const rosterPath = lib.sandboxPath('团队', '状态', '团队.json');
const readRoster = () => JSON.parse(fs.readFileSync(rosterPath, 'utf8').replace(/^\uFEFF/, ''));
const writeRoster = (r) => fs.writeFileSync(rosterPath, JSON.stringify(r, null, 2) + '\n', 'utf8');

const first = lib.boot('pm');
checks.add('沙盘内 boot pm 成功', first.ok, { rulesHash: first.rulesHash.slice(0, 8) });
const rosterVersion1 = String((first.doc && first.doc.rosterVersion) || '');

if (first.ok) {
  // ① 改成员显示名：rulesHash 不变、rosterVersion 也不变（昵称/备注不触发，§6.1）
  const roster1 = readRoster();
  const pmMember = (roster1.members || []).find((row) => row.role === 'pm');
  if (pmMember) pmMember.name = `${pmMember.name}-沙盘改名`;
  writeRoster(roster1);

  const second = lib.boot('pm');
  const rosterVersion2 = String((second.doc && second.doc.rosterVersion) || '');
  checks.add('改名册显示名后重新 boot 成功，rulesHash **不变**（名册已移出规则哈希）',
    second.ok && Boolean(second.rulesHash) && second.rulesHash === first.rulesHash,
    { before: first.rulesHash.slice(0, 8), after: String(second.rulesHash || '').slice(0, 8) });
  checks.add('改显示名 → rosterVersion **不变**（§6.1 只含 role/sessionId/status）',
    Boolean(rosterVersion1) && rosterVersion1 === rosterVersion2,
    { before: rosterVersion1.slice(0, 12), after: rosterVersion2.slice(0, 12) });

  // ② 只改名册不改宪法 → 旧令牌仍可写（用 task create 避开 send 的会话映射一致性门）
  const stillWritable = lib.teamJson(['task', 'create', '--boot', first.token, '--project', lib.PROJECT,
    '--title', '沙盘-名册变更后旧令牌写', '--priority', 'P1']);
  checks.add('只改名册（不改宪法）→ 旧令牌仍可写（无 RULES_CHANGED）', stillWritable.ok === true, { code: stillWritable.code });

  // ③ 改 roster 的 sessionId（等价换人）→ rulesHash 仍不变、rosterVersion 变化
  const roster2 = readRoster();
  const testerMember = (roster2.members || []).find((row) => row.role === 'tester');
  if (testerMember) testerMember.sessionId = 'session-sandbox-02-rotated';
  writeRoster(roster2);
  const third = lib.boot('pm');
  const rosterVersion3 = String((third.doc && third.doc.rosterVersion) || '');
  checks.add('改名册 sessionId（等价换人）→ rulesHash 仍不变',
    third.ok && third.rulesHash === first.rulesHash,
    { before: first.rulesHash.slice(0, 8), after: String(third.rulesHash || '').slice(0, 8) });
  checks.add('改名册 sessionId → rosterVersion 变化（独立口径生效）',
    Boolean(rosterVersion3) && rosterVersion3 !== rosterVersion1,
    { before: rosterVersion1.slice(0, 12), after: rosterVersion3.slice(0, 12) });

  // ④ 规则变更：追加一行到沙盘 团队宪法.md → 旧令牌立刻作废
  fs.appendFileSync(lib.sandboxPath('团队', '团队宪法.md'), '\n> 沙盘规则变更探针（R-7841，仅沙盘副本）\n', 'utf8');
  const stale = lib.teamJson(['task', 'create', '--project', lib.PROJECT, '--boot', first.token,
    '--title', '沙盘-改宪法后旧令牌', '--priority', 'P1']);
  checks.add('改宪法后旧令牌被拒（RULES_CHANGED）', stale.ok === false && String(stale.code) === 'RULES_CHANGED', { code: stale.code });

  // ⑤ 展示名在简报里生效
  const briefRun = lib.team(['boot', '--role', 'pm', '--project', lib.PROJECT]);
  checks.add('改名后的展示名在简报里生效（团队.json 是唯一显示名单一口径）', String(briefRun.stdout || '').includes('沙盘改名'), { exitCode: briefRun.status });

  lib.emit({
    ok: checks.ok,
    case: '02-rules',
    category: '②名册/角色卡/铁律变更',
    rosterDoesNotChangeRulesHash: Boolean(second.rulesHash) && second.rulesHash === first.rulesHash,
    displayNameDoesNotChangeRosterVersion: Boolean(rosterVersion1) && rosterVersion1 === rosterVersion2,
    rosterChangeKeepsTokenUsable: stillWritable.ok === true,
    sessionIdChangeMovesRosterVersion: Boolean(rosterVersion3) && rosterVersion3 !== rosterVersion1,
    constitutionChangeRejectsOldToken: stale.ok === false && String(stale.code) === 'RULES_CHANGED',
    displayNameFollowsRoster: String(briefRun.stdout || '').includes('沙盘改名'),
  }, checks);
} else {
  lib.emit({ ok: false, case: '02-rules', category: '②名册/角色卡/铁律变更', bootFailed: true }, checks);
}
