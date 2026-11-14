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
  const rotated = lib.teamJson(
    ['session', 'rotate', '--role', 'programmer2', '--project', lib.PROJECT, '--session', MARKER, '--force', '--reason', '沙盘 rotate（R-7841 AC1 破坏性跑）'],
    { TEAM_DSH_FAKE: JSON.stringify([{ sessionId: MARKER }]) },
  );
  checks.add('rotate 成功且换到沙盘标记会话', rotated.ok === true && String(rotated.to || '') === MARKER, { code: rotated.code || 'OK', from: rotated.from, to: rotated.to });

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
  checks.add('rotate 后续动作（待启动队列）也写在沙盘', queued === '{}' || queued.includes(MARKER), { queueFile: Boolean(queue) });

  lib.emit({
    ok: checks.ok,
    case: '01-rotate',
    category: '①换人/rotate',
    rosterChanged: Boolean(member && member.sessionId === MARKER),
    rotationRecord: rotationFiles.length > 0,
    workbenchMapped: Boolean(wbProject && wbProject.sessions.programmer2 === MARKER),
  }, checks);
} else {
  lib.emit({ ok: false, case: '01-rotate', category: '①换人/rotate', bootFailed: true }, checks);
}
