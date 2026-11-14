#!/usr/bin/env node
'use strict';
/**
 * 用例 ⑦：保留目录「再启动一次」验证（AC8 后半）：沙盘不是空壳，能读到需求/任务/工作流。
 * 断言：沙盘工作流 requirements 数 > 0、任务 json 数 > 0、需求文档 md 数 > 0，
 *       且 boot 仍能发令牌、简报里能读到「需求池 / 待办任务」。
 */
const lib = require('./_lib.cjs');

const checks = new lib.Checks();

const workflow = lib.readJsonSandbox('团队', '状态', '项目', lib.PROJECT, '工作流.json');
const requirementRows = Object.keys((workflow && workflow.requirements) || {}).length;
const taskFiles = lib.listFiles(lib.sandboxPath('团队', '状态', '项目', lib.PROJECT, '任务')).filter((name) => /\.json$/i.test(name)).length;
const requirementDocs = lib.listFiles(lib.sandboxPath('项目', lib.PROJECT, '需求')).filter((name) => /\.md$/i.test(name)).length;

checks.add('保留目录里工作流非空（requirements > 0）', requirementRows > 0, { requirementRows });
checks.add('保留目录里任务非空（任务/*.json > 0）', taskFiles > 0, { taskFiles });
checks.add('保留目录里需求文档非空（需求/*.md > 0）', requirementDocs > 0, { requirementDocs });

const booted = lib.boot('programmer1');
checks.add('保留目录可再次 boot（沙盘可用，非空壳）', booted.ok, { rulesHash: booted.rulesHash.slice(0, 8) });

const brief = lib.team(['boot', '--role', 'programmer1', '--project', lib.PROJECT]);
const briefText = String(brief.stdout || '');
checks.add('保留目录简报能读到需求池与待办任务', /需求池/.test(briefText) && /待办任务/.test(briefText), { exitCode: brief.status });

lib.emit({
  ok: checks.ok,
  case: '07-restart',
  category: 'AC8 再启动',
  requirements: requirementRows,
  tasks: taskFiles,
  requirementDocs,
  bootOk: booted.ok,
}, checks);
