#!/usr/bin/env node
'use strict';
/**
 * test-97db-ghost.cjs —— R-20261119-011311-97db（B-20261119-015113-2443）验收夹具
 * 覆盖：名册四态（AC2/AC3 后端单源）、删除项目四处映射清理计划（AC7）、恢复四段审计（AC4/AC5 missing）、
 * 以及壳层接线静态断言（team:members state / planProjectCleanup / 恢复审计 / 渲染层只读 state）。
 * 纯逻辑 + 源码静态断言，不启动 Electron、不写真实状态。
 * 用法：node scripts/test-97db-ghost.cjs    退出码 0=全绿
 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const mod = require(path.join(ROOT, 'src', 'project-roster-cleanup.js'));
const rows = [];
function check(name, ok, detail) {
  rows.push({ name, ok: Boolean(ok), detail: ok ? null : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' :: ' + JSON.stringify(detail)}`);
}
const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');

// ── 1. 四态（AC2/AC3）────────────────────────────────────────────────────
check('M1 名册空+映射空 → stale（已失效）', mod.memberStateOf({ rosterSession: '', projectSession: '' }) === 'stale');
check('M2 名册空+映射有 → missing（未就绪缺会话）', mod.memberStateOf({ rosterSession: '', projectSession: 's1' }) === 'missing');
check('M3 名册有+映射空 → pending（待激活）', mod.memberStateOf({ rosterSession: 's1', projectSession: '' }) === 'pending');
check('M4 名册与映射一致 → ok', mod.memberStateOf({ rosterSession: 's1', projectSession: 's1' }) === 'ok');
check('M5 两边不一致 → pending（不冒充就绪）', mod.memberStateOf({ rosterSession: 's1', projectSession: 's2' }) === 'pending');
check('M6 映射一致但不在 workspace → pending', mod.memberStateOf({ rosterSession: 's1', projectSession: 's1', workspaceSession: false }) === 'pending');
check('M7 枚举只含四态', JSON.stringify(mod.MEMBER_STATES) === JSON.stringify(['ok', 'pending', 'stale', 'missing']));

// ── 2. 删除项目：四处映射同事务清理计划（AC7）──────────────────────────────
const team = {
  members: [
    { role: 'pm', sessionId: 's-pm' },
    { role: 'programmer1', sessionId: 's-a' },
    { role: 'programmer2', sessionId: 'other-project-session' },
    { role: 'tester', sessionId: '' }
  ]
};
const project = { sessions: { pm: 's-pm', programmer1: 's-a' }, workspace: { sessionIds: ['s-pm', 's-a', 's-extra'] } };
const plan = mod.planProjectCleanup({ team, project, manifestRoles: [{ role: 'pm', sessionId: 's-pm' }] });
check('C1 清理计划不改原 team 对象（可回滚）', team.members[0].sessionId === 's-pm');
check('C2 本项目名册会话被清空（pm/programmer1）', plan.team.members[0].sessionId === '' && plan.team.members[1].sessionId === '');
check('C3 其他项目成员会话保留', plan.team.members[2].sessionId === 'other-project-session');
check('C4 已归档标记写入', plan.team.members[0].archived === true && plan.team.members[1].archived === true);
check('C5 workspace 会话也进清理集合（s-extra）', plan.doomsSessions.includes('s-extra'));
check('C6 clearedMembers 记录被清角色', plan.clearedMembers.includes('pm') && plan.clearedMembers.includes('programmer1'));
check('C7 原 team 缺失时 missing=team', mod.planProjectCleanup({ team: null, project }).missing.includes('team'));
const verifyAfter = mod.verifyProjectCleanup({ team: plan.team, project: null, manifestRoles: [{ sessionId: 's-pm' }] });
check('C8 清理后四处校验 ok', verifyAfter.ok === true);
const verifyBefore = mod.verifyProjectCleanup({ team, project, manifestRoles: [] });
check('C9 清理前校验报残留（证明断言不是恒真）', verifyBefore.ok === false && verifyBefore.problems.length > 0);

// ── 3. 恢复四段审计（AC4/AC5）───────────────────────────────────────────
const good = mod.buildRestoreAudit({ record: true, workspace: true, sessions: true, ui: true });
check('R1 四段全绿 → ok 且 missing 空', good.ok === true && good.missing.length === 0);
const bad = mod.buildRestoreAudit({ record: true, workspace: { ok: false, code: 'WORKSPACE_CREATE_FAILED' }, sessions: true, ui: true });
check('R2 工作区失败 → ok=false 且 missing=[workspace]', bad.ok === false && JSON.stringify(bad.missing) === JSON.stringify(['workspace']));
check('R3 支持 {ok} 对象形态输入', mod.buildRestoreAudit({ record: { ok: true }, workspace: { ok: true }, sessions: { ok: true }, ui: true }).ok === true);
check('R4 缺段按 false 处理（不静默通过）', mod.buildRestoreAudit({ record: true }).missing.length === 3);

// ── 4. 壳层接线静态断言（防「模块写了没接线」）─────────────────────────────
check('W1 main.js require 纯逻辑模块', /const projectRosterCleanup = require\('\.\/project-roster-cleanup\.js'\)/.test(mainSrc));
check('W2 team:members 每行带后端 state', /state: projectRosterCleanup\.memberStateOf\(\{/.test(mainSrc));
check('W3 team:members 返回 membersEmpty', /membersEmpty,\n/.test(mainSrc) || /membersEmpty,/.test(mainSrc));
check('W4 删除项目使用 planProjectCleanup（含 workspace/清单会话）', /const cleanupPlan = projectRosterCleanup\.planProjectCleanup\(\{ team, project, manifestRoles: manifestRolesForCleanup \}\)/.test(mainSrc));
check('W5 恢复项目写「恢复审计.jsonl」四段', /恢复审计\.jsonl/.test(mainSrc) && /stages: restoreAudit\.stages, ok: restoreAudit\.ok, missing: restoreAudit\.missing/.test(mainSrc));
check('W6 渲染层四态只读后端（memberStateOfCache + memberStateView）', /memberStateOfCache/.test(appSrc) && /function memberStateView/.test(appSrc));
check('W7 渲染层不自行判定 stale（无 rosterSession 判空分支）', !/stale[\s\S]{0,80}rosterSession/.test(appSrc));
check('W8 侧栏空名册提示 data-roster-empty', /data-roster-empty/.test(appSrc));
check('W9 恢复失败横幅 data-restore-error', /data-restore-error/.test(appSrc));
check('W10 侧栏/团队台计数在名册为空时写死 0', /count\.textContent = rosterEmpty \? '0'/.test(appSrc));

// ── 汇总 ────────────────────────────────────────────────────────────────
const failed = rows.filter((r) => !r.ok);
console.log('');
console.log(`GHOST97DB ${failed.length ? 'FAIL' : 'OK'} ${JSON.stringify({ total: rows.length, pass: rows.length - failed.length, red: failed.length })}`);
process.exit(failed.length ? 1 : 0);
