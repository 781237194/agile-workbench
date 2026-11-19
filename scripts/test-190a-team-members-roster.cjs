#!/usr/bin/env node
'use strict';
/**
 * test-190a-team-members-roster.cjs —— B-190a 第 3 处（PM 2026-11-20 02:56 补）
 *
 * 背景：`team:members` 的 baseRoles 原来只来自 项目.sessions / 团队会话.json，
 * 于是「归档成员」后团队台仍列出 6 行（每行还带「已就绪」）——Owner 2026-11-20 02:0x 截图症状之一。
 * 修法（读侧）：名册里 `archived===true` 或 `sessionId` 为空 → 该角色不进 baseRoles。
 * 写侧清理（project.sessions / workspace.sessionIds）属 P2 B-20261120-024721-85c5，排 2.1.10。
 *
 * 断言（静态 + 逻辑复刻）：
 *   A1 源码存在 rosterArchivedRoles 过滤，且过滤条件含 archived===true 与 sessionId 空
 *   A2 过滤应用于 baseRoles（先 raw 再 filter），且 rosterArchivedRoles 为空时不做过滤（旧行为不变）
 *   B1 复刻过滤逻辑：名册 2 活跃 + 4 归档 → 6 行变 2 行
 *   B2 名册全空（全部 archived/无 sid）→ 0 行（Owner 回归场景）
 *   B3 名册未加载（空 Set）→ 保持 6 行（不误清）
 *   C 隔离：只读（src/main.js sha 前后不变）
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const rows = [];
const check = (name, ok, detail) => {
  let text = ''; try { text = JSON.stringify(detail === undefined ? null : detail); } catch { text = String(detail); }
  rows.push({ name, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' :: ' + String(text).slice(0, 400)}`);
};

const mainPath = path.join(ROOT, 'src', 'main.js');
const sha256 = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const before = sha256(fs.readFileSync(mainPath));
const src = fs.readFileSync(mainPath, 'utf8');

check('A1 存在 rosterArchivedRoles，条件含 archived===true 与 sessionId 空',
  /rosterArchivedRoles/.test(src) && /m\.archived === true \|\| !sid/.test(src), {});

check('A2 先算 baseRolesRaw 再按名册过滤，且空 Set 时不过滤（旧行为不变）',
  /const baseRolesRaw =/.test(src)
  && /const baseRoles = rosterArchivedRoles\.size/.test(src)
  && /baseRolesRaw\.filter\(\(row\) => !rosterArchivedRoles\.has/.test(src), {});

check('A3 注释写明写侧清理归 P2（2.1.10），读侧只做过滤',
  /B-20261120-024721-85c5/.test(src) && /2\.1\.10/.test(src), {});

// ── B 逻辑复刻（与实现同语义）─────────────────────────────
const archivedSetOf = (members) => new Set(
  (members || []).filter((m) => {
    if (!m) return false;
    const sid = String(m.sessionId || '').trim();
    return m.archived === true || !sid;
  }).map((m) => String(m.role || ''))
);
const applyFilter = (rowsIn, members) => {
  const arch = archivedSetOf(members);
  return arch.size ? rowsIn.filter((r) => !arch.has(String(r.role))) : rowsIn;
};

const six = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'].map((role) => ({ role }));
const members2active = [
  { role: 'pm', sessionId: 'session-a' },
  { role: 'product', sessionId: 'session-b' },
  { role: 'analyst', sessionId: '', archived: true },
  { role: 'programmer1', sessionId: '', archived: true },
  { role: 'programmer2', sessionId: '', archived: true },
  { role: 'tester', sessionId: '', archived: true },
];
check('B1 名册 2 活跃 + 4 归档 → 6 行剩 2 行',
  applyFilter(six, members2active).length === 2, { n: applyFilter(six, members2active).length });

const membersAllArchived = six.map((r) => ({ role: r.role, sessionId: '', archived: true }));
check('B2 名册全归档 → 0 行（Owner 回归场景）',
  applyFilter(six, membersAllArchived).length === 0, {});

check('B3 名册未加载（空数组）→ 保持 6 行，不误清',
  applyFilter(six, []).length === 6, {});

check('B4 sessionId 空但没写 archived 也算归档（名册清绑定的既有形态）',
  applyFilter(six, [{ role: 'pm', sessionId: '' }, { role: 'product', sessionId: 's' }]).length === 5, {});

const after = sha256(fs.readFileSync(mainPath));
check('C 隔离：本夹具只读（src/main.js sha 不变）', before === after, { before: before.slice(0, 12), after: after.slice(0, 12) });

const pass = rows.filter((r) => r.ok).length;
console.log(`\n${pass}/${rows.length} PASS`);
process.exit(pass === rows.length ? 0 : 1);
