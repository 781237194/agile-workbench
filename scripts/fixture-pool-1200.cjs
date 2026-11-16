#!/usr/bin/env node
/* R-c72a AC4 夹具：在沙盘写 1200 行需求池（AWB_DATA_DIR + TEAM_ROOT 双隔离）。
 * 用法：node scripts/fixture-pool-1200.cjs [--base <目录>] [--rows 1200] [--json]
 * 只写 --base 指定目录（缺省 _tmp/c72a-batch2/pool-1200），不碰真实 workbench.json 与 团队/状态。
 */
'use strict';
const path = require('node:path');
const { seedSandbox, ROOT } = require('./lib/c72a-sandbox.cjs');

function argOf(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function seedPool1200(opts = {}) {
  const rows = Number(opts.rows || 1200);
  const base = path.resolve(opts.base || path.join(ROOT, '_tmp', 'c72a-batch2', 'pool-1200'));
  const seed = seedSandbox({
    base,
    projects: [{ id: opts.projectId || 'c72a-pool-1200', name: opts.projectName || '工作台改造修复', rows }],
  });
  return { ...seed, rows, project: seed.projects[0] };
}

module.exports = { seedPool1200 };

if (require.main === module) {
  const base = argOf('--base', '');
  const rows = Number(argOf('--rows', '1200'));
  const seed = seedPool1200({ base: base || undefined, rows });
  const out = {
    ok: true,
    base: seed.base,
    rows: seed.rows,
    project: seed.projects[0],
    workbench: path.join(seed.data, 'userdata', 'workbench.json'),
    teamFile: path.join(seed.team, '状态', '团队.json'),
    workflow: path.join(seed.team, '状态', '项目', seed.projects[0].slug, '工作流.json'),
  };
  if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
  else {
    console.log('沙盘已播种：' + out.base);
    console.log('  需求行：' + out.rows + '（requirements 对象 map，键=完整需求 id）');
    console.log('  工作流：' + out.workflow);
  }
}