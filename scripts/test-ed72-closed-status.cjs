'use strict';
/**
 * test-ed72-closed-status.cjs —— B-20261117-123207-ed72 回归夹具
 *
 * 缺陷：lib 里还有一批「手写 done 判定」，决策/门禁/路由语义里 `status !== 'done'`
 * 会把 accepted/cancelled/terminated（已闭环）当成「还有活」→ 误催、误派、误挡。
 * 本批按「保留 / 改 / 已由他处覆盖」三类逐处定性，**决策语义收敛到 gates.statusIsClosed 单源**，
 * **展示/统计口径保留 `!== 'done'` 并注明「只认 done，不等于闭环」**。
 *
 * 断言：
 *   C1 单源语义：statusIsClosed 覆盖 done/accepted/cancelled/terminated，open/working 不算闭环
 *   C2 已收敛 6 处（gates 2 / ops 2 / lifecycle 1 / finalize 1）均改用 statusIsClosed，且原手写判定已消失
 *   C3 展示类 4 处（board.mjs）**保持** `!== 'done'`（不被误改，避免看板「进行中」口径变空）
 *   C4 保留类抽样：`task list` 默认过滤（ops）仍按 done 展示口径；selftest 断言文件不在本批范围
 *   C5 引入无循环依赖：lifecycle/finalize 能正常 import（gates 不 import 它们）
 *
 * 跑法：node scripts/test-ed72-closed-status.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, '团队', '工具', 'lib');
let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); return; }
  fail += 1; console.log(`FAIL  ${name}  ` + JSON.stringify(detail || {}).slice(0, 300)); process.exitCode = 1;
}
const src = (rel) => fs.readFileSync(path.join(LIB, rel), 'utf8');

(async () => {
  const gates = await import(pathToFileURL(path.join(LIB, 'gates.mjs')).href);
  ok('C1 statusIsClosed 单源：done/accepted/cancelled/terminated 闭环，open/working 未闭环',
    ['done', 'accepted', 'cancelled', 'terminated'].every((s) => gates.statusIsClosed(s) === true)
    && ['open', 'working'].every((s) => gates.statusIsClosed(s) === false),
    { statuses: gates.CLOSED_TASK_STATUSES });

  const gatesSrc = src('gates.mjs');
  const opsSrc = src('ops.mjs');
  const lifeSrc = src('lifecycle.mjs');
  const finSrc = src('finalize.mjs');
  ok('C2① gates.mjs 的 G5 两处 open 判定改走 statusIsClosed（不再 status !== done）',
    !/task\.status !== 'done' && task\.type !== 'requirement'/.test(gatesSrc)
    && /!statusIsClosed\(task\.status\) && task\.type !== 'requirement'/.test(gatesSrc)
    && /const open = kids\.filter\(\(task\) => !statusIsClosed\(task\.status\)\)/.test(gatesSrc), {});
  ok('C2② ops.mjs 角色「还有活」与「未分配子任务」两处改走 statusIsClosed',
    !/listTasks\(projectName\)\.filter\(\(t\) => t\.status !== 'done' && \(!t\.owner \|\| t\.owner === role\)\)/.test(opsSrc)
    && /listTasks\(projectName\)\.filter\(\(t\) => !statusIsClosed\(t\.status\) && \(!t\.owner \|\| t\.owner === role\)\)/.test(opsSrc)
    && /!statusIsClosed\(row\.status\)\)\.map\(\(row\) => String\(row\.id\)\)/.test(opsSrc), {});
  ok('C2③ lifecycle.mjs 未闭环任务集合改走 statusIsClosed（且已 import 单源）',
    /from '\.\/gates\.mjs'/.test(lifeSrc) && /!statusIsClosed\(task\.status\)\) ids\.add/.test(lifeSrc)
    && !/task\.status !== 'done'\) ids\.add/.test(lifeSrc), {});
  ok('C2④ finalize.mjs 未闭环任务清单改走 statusIsClosed（且已 import 单源）',
    /from '\.\/gates\.mjs'/.test(finSrc) && /tasks\.filter\(\(t\) => !statusIsClosed\(t\.status\)\)/.test(finSrc), {});

  const boardSrc = src('board.mjs');
  const boardHits = (boardSrc.match(/t\.status !== 'done'/g) || []).length;
  ok('C3 展示类 board.mjs 4 处保持 `!== done`（看板「进行中任务」口径不被误改）',
    boardHits === 4, { boardHits });

  ok('C4 保留类抽样：task list 默认展示过滤仍按 done 口径（ops.mjs）',
    /if \(!args\.all\) tasks = tasks\.filter\(\(t\) => t\.status !== 'done'\);/.test(opsSrc), {});

  const life = await import(pathToFileURL(path.join(LIB, 'lifecycle.mjs')).href);
  const fin = await import(pathToFileURL(path.join(LIB, 'finalize.mjs')).href);
  ok('C5 无循环依赖：lifecycle / finalize 正常加载并导出函数',
    typeof life.findRejectedVote === 'function' && typeof fin.memoriesRoot === 'function', {});

  console.log(`\nED72_CLOSED ${JSON.stringify({ total: pass + fail, pass, fail })}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('ED72_CLOSED_FAILED ' + String((e && e.stack) || e)); process.exit(2); });
