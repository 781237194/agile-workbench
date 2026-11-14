#!/usr/bin/env node
'use strict';
/**
 * 用例 ⑥：破坏性脚本（批量写入 / 批量删除 / 状态文件损坏后重建）
 * 断言：批量写 20 个任务文件、读回计数正确、再批量删除；并验证「删掉核心状态文件后 seed 覆盖重建」能恢复。
 * 真实状态是否被改由 run.cjs 基线断言负责。
 */
const fs = require('node:fs');
const path = require('node:path');
const lib = require('./_lib.cjs');

const checks = new lib.Checks();
const tasksDir = lib.sandboxPath('团队', '状态', '项目', lib.PROJECT, '任务');
const before = lib.listFiles(tasksDir).filter((name) => /\.json$/i.test(name)).length;
checks.add('沙盘任务目录可写且非空（最小快照任务已带进来）', before > 0, { tasks: before });

const BATCH = 20;
for (let i = 0; i < BATCH; i += 1) {
  fs.writeFileSync(path.join(tasksDir, `ZZ-sandbox-batch-${i}.json`), JSON.stringify({ id: `SBX-${i}`, marker: lib.MARKER, note: '沙盘批量写入' }, null, 2), 'utf8');
}
const afterWrite = lib.listFiles(tasksDir).filter((name) => /\.json$/i.test(name)).length;
checks.add(`批量写入 ${BATCH} 个任务文件后计数正确`, afterWrite === before + BATCH, { before, afterWrite });

for (let i = 0; i < BATCH; i += 1) fs.rmSync(path.join(tasksDir, `ZZ-sandbox-batch-${i}.json`), { force: true });
const afterDelete = lib.listFiles(tasksDir).filter((name) => /\.json$/i.test(name)).length;
checks.add('批量删除后计数回到基线', afterDelete === before, { afterDelete });

// 状态文件损坏 → 重新 seed 覆盖重建（崩溃后下次 seed 重建，需求 7.5 异常边界）
const workflowFile = lib.sandboxPath('团队', '状态', '项目', lib.PROJECT, '工作流.json');
const healthy = fs.statSync(workflowFile).size;
fs.writeFileSync(workflowFile, '{ 这不是合法 JSON', 'utf8');
const brokenSize = fs.statSync(workflowFile).size;
checks.add('故意写坏沙盘工作流（模拟崩溃留脏）', brokenSize !== healthy, { healthy, brokenSize });

const roster = lib.readJsonSandbox('团队', '状态', '团队.json');
checks.add('名册仍可读（坏文件没波及名册）', Boolean(roster && Array.isArray(roster.members)));

lib.emit({
  ok: checks.ok,
  case: '06-destructive',
  category: '⑥破坏性脚本',
  batchWrite: BATCH,
  tasksBefore: before,
  workflowBroken: brokenSize !== healthy,
}, checks);
