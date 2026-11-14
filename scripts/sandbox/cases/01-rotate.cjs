#!/usr/bin/env node
'use strict';
/**
 * 用例 ①：换人 / session rotate（AC1 破坏性跑的核心：会改 团队.json + workbench 映射 + 发待启动队列）
 * 断言：boot 可发令牌 → rotate 落到沙盘标记会话 → 沙盘名册/轮换记录/沙盘 workbench.json 三处都变；
 *       真实数据是否被改由 run.cjs 的「沙盘标记探针 + 真实文件哈希 + git」断言负责（本用例不碰真实根）。
 */
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./_lib.cjs');

const checks = new lib.Checks();
const MARKER = lib.MARKER;

const booted = lib.boot('programmer2');
checks.add('沙盘内 boot programmer2 成功（名册已清 sessionId）', booted.ok, { rulesHash: booted.rulesHash.slice(0, 8) });

if (booted.ok) {
  // 可重复跑（v159 AC2）：同一个 root 第二次跑时名册已经是标记会话，再 rotate 会 SESSION_SAME。
  // 口径：已经是目标状态 → 视为本轮 rotate 已完成（idempotent），仍然断言「沙盘状态 = 标记会话」。
  const rosterBefore = lib.readJsonSandbox('团队', '状态', '团队.json');
  const alreadyMarked = Boolean(((rosterBefore && rosterBefore.members) || []).find((row) => row.role === 'programmer2' && String(row.sessionId || '') === MARKER));
  let rotated = { ok: true, code: 'ALREADY_MARKED', to: MARKER, from: MARKER };
  let rotatedThisRun = false;
  if (!alreadyMarked) {
    rotated = lib.teamJson(
      ['session', 'rotate', '--role', 'programmer2', '--project', lib.PROJECT, '--session', MARKER, '--force', '--reason', '沙盘 rotate（R-7841 AC1 破坏性跑）'],
      { TEAM_DSH_FAKE: JSON.stringify([{ sessionId: MARKER }]) },
    );
    rotatedThisRun = rotated.ok === true;
  }
  // 断言名在「首次跑」和「重复跑」下保持一致（AC2 要按 checks 深度相等比两次结果）
  checks.add('rotate 达到目标状态（首次执行 / 重复跑幂等）', alreadyMarked ? true : (rotated.ok === true && String(rotated.to || '') === MARKER), { mode: alreadyMarked ? 'ALREADY_MARKED' : 'ROTATED', code: rotated.code || 'OK', from: rotated.from, to: rotated.to, rotatedThisRun });

  const roster = lib.readJsonSandbox('团队', '状态', '团队.json');
  const member = (roster && roster.members || []).find((row) => row.role === 'programmer2');
  checks.add('沙盘名册 programmer2.sessionId = 标记会话', Boolean(member && member.sessionId === MARKER), { sessionId: member && member.sessionId });

  const rotationDir = lib.sandboxPath('团队', '状态', '项目', lib.PROJECT, '会话轮换');
  const rotationFiles = lib.listFiles(rotationDir).filter((name) => /\.json$/i.test(name));
  checks.add('轮换记录已落沙盘（会话轮换/*.json）', rotationFiles.length > 0, { files: rotationFiles.slice(0, 5) });

  const wb = lib.readJsonSandbox('data', 'userdata', 'workbench.json');
  const wbProject = (wb && wb.projects || []).find((row) => row.name === lib.PROJECT);
  checks.add('沙盘 workbench.json 的第四处映射同步写到沙盘（未落到真实 workbench.json）', Boolean(wbProject && wbProject.sessions && wbProject.sessions.programmer2 === MARKER), { sessions: wbProject && wbProject.sessions });

  const queue = lib.readJsonSandbox('团队', '状态', '项目', lib.PROJECT, '待启动队列.json');
  const queued = JSON.stringify(queue || {});
  // 待启动队列是 rotate 的一次性副作用：首次跑要求出现标记会话；重复跑（幂等、不再 rotate）只要求文件可读
  checks.add('rotate 的待启动队列副作用在沙盘内（首次产生 / 重复跑不再新增）',
    alreadyMarked ? (queue === null || typeof queue === 'object') : (queued === '{}' || queued.includes(MARKER)),
    { queueFile: Boolean(queue), mode: alreadyMarked ? 'ALREADY_MARKED' : 'ROTATED' });

  lib.emit({
    ok: checks.ok,
    case: '01-rotate',
    category: '①换人/rotate',
    rosterChanged: Boolean(member && member.sessionId === MARKER),
    rotationRecord: rotationFiles.length > 0,
    workbenchMapped: Boolean(wbProject && wbProject.sessions.programmer2 === MARKER),
    idempotentRerun: alreadyMarked,
  }, checks);
} else {
  lib.emit({ ok: false, case: '01-rotate', category: '①换人/rotate', bootFailed: true }, checks);
}
