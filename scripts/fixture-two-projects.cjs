#!/usr/bin/env node
/* R-c72a AC2 夹具：在沙盘建两个项目（A/B 各 50 行需求），供「切项目」列表更新采样。
 * 用法：node scripts/fixture-two-projects.cjs [--base <目录>] [--rows 50] [--json]
 * 只写 --base 指定目录（缺省 _tmp/c72a-batch2/two-projects）。
 */
'use strict';
const path = require('node:path');
const { seedSandbox, ROOT } = require('./lib/c72a-sandbox.cjs');

function argOf(name, dflt) {
  const i = process.argv.indexOf(name);
  return i > 0 && process.argv[i + 1] ? process.argv[i + 1] : dflt;
}

function seedTwoProjects(opts = {}) {
  const rows = Number(opts.rows || 50);
  const base = path.resolve(opts.base || path.join(ROOT, '_tmp', 'c72a-batch2', 'two-projects'));
  return seedSandbox({
    base,
    projects: [
      { id: opts.idA || 'c72a-two-a', name: opts.nameA || '夹具项目A', rows },
      { id: opts.idB || 'c72a-two-b', name: opts.nameB || '夹具项目B', rows },
    ],
  });
}

module.exports = { seedTwoProjects };

if (require.main === module) {
  const base = argOf('--base', '');
  const rows = Number(argOf('--rows', '50'));
  const seed = seedTwoProjects({ base: base || undefined, rows });
  const out = {
    ok: true,
    base: seed.base,
    projects: seed.projects,
    workbench: path.join(seed.data, 'userdata', 'workbench.json'),
    teamFile: path.join(seed.team, '状态', '团队.json'),
  };
  if (process.argv.includes('--json')) console.log(JSON.stringify(out, null, 2));
  else {
    console.log('沙盘已播种：' + out.base);
    for (const p of out.projects) console.log(`  ${p.name}（id=${p.id}）· ${p.rows} 行 · slug=${p.slug}`);
  }
}