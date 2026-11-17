#!/usr/bin/env node
'use strict';
/**
 * test-1a68-fail-orders.cjs —— B-20261116-065437-1a68 回归夹具
 *
 * 缺陷：判负只认「失败 N 项」这一种正序，四种常见语序漏判：
 *   「失败共2项」「2项失败」「失败 2 项」「共 2 项失败」
 *
 * 成对验（AC）：
 *   FAIL 侧：四种语序都必须判负；「通过 3/4，1 项未通过」必须仍判负（少量残留不能被正的连坐放过）
 *   PASS 侧：全通过 / 无失败 / 0 项失败 / 未发现 FAIL / 「失败 2 项已修复」（已处置）必须判正
 *
 * 跑法：node scripts/test-1a68-fail-orders.cjs
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); return; }
  fail += 1; console.log(`FAIL  ${name}  ` + JSON.stringify(detail || {}).slice(0, 300)); process.exitCode = 1;
}

(async () => {
  const ops = await import(pathToFileURL(path.join(__dirname, '..', '团队', '工具', 'lib', 'ops.mjs')).href);
  const fv = ops.failVerdictText;
  ok('导出 failVerdictText 可调用', typeof fv === 'function', {});

  // ── FAIL 侧：四种语序 + 残留负例
  const failCases = [
    ['失败共2项', '正序 + 共'],
    ['失败 2 项', '正序基线'],
    ['2项失败', '逆序'],
    ['共 2 项失败', '逆序 + 共'],
    ['共计 3 条失败', '逆序 + 共计'],
    ['结论：失败共1项（接口超时）', '正序带上下文'],
    ['status: 通过 3/4，1 项未通过', '残留负例：不能被「通过」连坐放过'],
    ['结论：不通过', '强否定词'],
  ];
  for (const [text, why] of failCases) ok(`FAIL 侧判负：${text}（${why}）`, fv(text) === true, { got: fv(text) });

  // ── PASS 侧：不能误伤
  const passCases = [
    ['结论：全部通过', '全通过'],
    ['无失败', '无失败'],
    ['0 项失败', '零靶词'],
    ['失败 0 项', '零靶词逆序'],
    ['未发现 FAIL，全部合格', '否定句'],
    ['通过（不构成不通过）', '否定句'],
    ['失败 2 项已修复', '已处置'],
    ['2 项失败已修复', '已处置（逆序）'],
    ['失败原因见 §二：接口超时', '散文，无数字量词'],
    ['失败零副作用', '散文，零值'],
    ['PASS 全部合格', 'PASS'],
  ];
  for (const [text, why] of passCases) ok(`PASS 侧判正：${text}（${why}）`, fv(text) === false, { got: fv(text) });

  console.log(`\nFAIL_ORDERS ${JSON.stringify({ total: pass + fail, pass, fail })}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('FAIL_ORDERS_FAILED ' + String((e && e.stack) || e)); process.exit(2); });
