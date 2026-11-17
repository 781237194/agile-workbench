#!/usr/bin/env node
/**
 * B-20261117-181529-7b49：需求镜像任务 ↔ 工作流行 对账（防「req create 后工作流静默缺行」）。
 *
 * 用法：node scripts/check-req-rows.cjs [--project <P>] [--root <仓库根>] [--json]
 * 判据：
 *   - 每个 type=requirement 的任务都必须在 工作流.json requirements 里有同 id 行（缺行 → exit 1，MISSING_WORKFLOW_ROW）；
 *   - 有行没任务 → 仅提示（ORPHAN_WORKFLOW_ROW，历史清理项，不判失败）。
 * 只读：不写任何文件。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const ROOT = path.resolve(argOf('root', path.resolve(__dirname, '..')));
const JSON_OUT = argv.includes('--json');

function findProjectDir() {
  const name = String(argOf('project', '')).trim();
  const base = path.join(ROOT, '项目');
  if (name) return path.join(base, name);
  try {
    const dirs = fs.readdirSync(base, { withFileTypes: true }).filter((d) => d.isDirectory());
    return dirs.length ? path.join(base, dirs[0].name) : '';
  } catch { return ''; }
}

const projectDir = findProjectDir();
if (!projectDir || !fs.existsSync(projectDir)) {
  console.error(`CHECK_REQ_ROWS_USAGE：找不到项目目录（--project 或 项目/ 下第一个）`);
  process.exit(2);
}
const projectName = path.basename(projectDir);
const stateDir = path.join(ROOT, '团队', '状态', '项目', projectName);
const wfFile = path.join(stateDir, '工作流.json');
const taskDir = path.join(stateDir, '任务');
const readJson = (f, dflt) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return dflt; } };
const wf = readJson(wfFile, null);
if (!wf) {
  console.error(`CHECK_REQ_ROWS_USAGE：工作流不存在或不可读：${wfFile}`);
  process.exit(2);
}
const rows = (wf.requirements && typeof wf.requirements === 'object') ? wf.requirements : {};
const rowIds = new Set(Object.values(rows).map((r) => String((r && r.id) || '')).filter(Boolean));
const tasks = (() => {
  try {
    return fs.readdirSync(taskDir).filter((n) => n.endsWith('.json')).map((n) => readJson(path.join(taskDir, n), null)).filter(Boolean);
  } catch { return []; }
})();
const reqTasks = tasks.filter((t) => String(t.type || '') === 'requirement');
const CLOSED = new Set(['done', 'accepted', 'cancelled', 'terminated']);
const missing = reqTasks.filter((t) => !rowIds.has(String(t.id))).map((t) => ({ id: String(t.id), title: String(t.title || ''), status: String(t.status || '') }));
// 历史缺行（本缺陷修复前创建的镜像任务）：已终态只作 legacy 提示，不判失败；未闭环缺行才是新缺陷。
const missingOpen = missing.filter((m) => !CLOSED.has(m.status));
const missingLegacy = missing.filter((m) => CLOSED.has(m.status));
const orphan = [...rowIds].filter((id) => !reqTasks.some((t) => String(t.id) === id));

const payload = { ok: missingOpen.length === 0, project: projectName, workflowFile: wfFile, taskCount: reqTasks.length, rowCount: rowIds.size, missingOpen, missingLegacy, orphan };
if (JSON_OUT) process.stdout.write(JSON.stringify(payload) + '\n');
else {
  console.log(`需求工作流行对账（${projectName}）：行 ${rowIds.size} / 镜像任务 ${reqTasks.length} / 未闭环缺行 ${missingOpen.length} / 历史缺行 ${missingLegacy.length} / 孤儿行 ${orphan.length}`);
  for (const m of missingOpen.slice(0, 20)) console.log(`- MISSING_WORKFLOW_ROW ${m.id} ${m.status} ${m.title}`);
  for (const m of missingLegacy.slice(0, 5)) console.log(`- legacy（已终态缺行，仅提示）${m.id} ${m.status}`);
  for (const o of orphan.slice(0, 10)) console.log(`- ORPHAN_WORKFLOW_ROW ${o}`);
}
process.exit(missingOpen.length ? 1 : 0);
