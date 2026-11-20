#!/usr/bin/env node
'use strict';
/**
 * test-7009-usage-view.cjs —— B-20261120-163603-7009（P1）会话用量展示夹具（三条 + 原生对齐）
 *
 *  ①缓存键含角色：key 随角色变；角色不同即使 TTL 未到也必须刷新（≤2s）
 *  ②切角色刷新：view 值随角色变化，且渲染层有「角色 chip → 清缓存重取」的真实接线
 *  ③对照表字段齐：每个指标都有 界面值/原生值/公式/误差/≤5% 判定；用 Owner 截图的原生数验证误差 0
 *  ④原生对齐：界面值就是原生三项（uncachedInputTokens / cacheReadTokens / outputTokens），误差 ≤5%
 *
 * 用法：node scripts/test-7009-usage-view.cjs [--json]
 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');
const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
}
const view = require(path.join(ROOT, 'src', 'usage-view.js'));

/* ① 缓存键含角色 */
check('①a 缓存键随角色不同而不同', view.usageCacheKey('P-1', 'pm') !== view.usageCacheKey('P-1', 'product')
  && view.usageCacheKey('P-1', 'pm') === view.usageCacheKey('P-1', 'pm'), {
  pm: view.usageCacheKey('P-1', 'pm'), product: view.usageCacheKey('P-1', 'product'),
});
const now = Date.now();
check('①b 同角色 TTL 内不刷新（15s）',
  view.usageShouldRefresh({ projectId: 'P-1', role: 'pm', at: now - 1000 }, { projectId: 'P-1', role: 'pm', now, ttlMs: 15000 }) === false, {});
check('①c 切角色即使 TTL 未到也刷新（≤2s 生效）',
  view.usageShouldRefresh({ projectId: 'P-1', role: 'pm', at: now - 1000 }, { projectId: 'P-1', role: 'product', now, ttlMs: 15000 }) === true, {});
check('①d 换项目也刷新', view.usageShouldRefresh({ projectId: 'P-1', role: 'pm', at: now - 1000 }, { projectId: 'P-2', role: 'pm', now }) === true, {});

/* ② 切角色后数值随角色变 + 渲染层真实接线 */
const pm = { input: 300601, cacheRead: 123746816, output: 208150, tokens: 124255567 };
const product = { input: 378620, cacheRead: 83000000, output: 142000, tokens: 83520620 };
const vPm = view.usageViewOf('pm', pm);
const vProd = view.usageViewOf('product', product);
check('②a 切角色后展示模型随角色变（角色名与数值都变）',
  vPm.role === 'pm' && vProd.role === 'product' && vPm.breakdown.input === pm.input && vProd.breakdown.input === product.input
  && vPm.breakdown.input !== vProd.breakdown.input, { pm: vPm.label, product: vProd.label });
const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
check('②b 渲染层有角色 chip 接线（点击 → 清缓存 + 重取）',
  /data-usage-role-pick/.test(appSrc) && /usageUi = \{ projectId: usageUi\.projectId, role, at: 0, data: null \}/.test(appSrc), {});
check('②c 渲染层缓存判定含角色（usageNeedsRefresh 比 role）',
  /function usageNeedsRefresh/.test(appSrc) && /String\(usageUi\.role \|\| ''\) !== String\(role \|\| ''\)/.test(appSrc), {});
const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
check('②d IPC 接受 role 参数且返回 focus.view/cacheKey',
  /const requestedRole = String\(p\.role \|\| ''\)\.trim\(\)/.test(mainSrc) && /cacheKey: UsageView\.usageCacheKey/.test(mainSrc), {});
check('②e 写盘行带原生分项（cacheRead/output）',
  /cacheRead: usage\.cacheRead, output: usage\.output/.test(fs.readFileSync(path.join(ROOT, 'src', 'rolecard-shell-hook.js'), 'utf8')), {});

/* ③ 对照表字段齐 + ④ 原生对齐 */
const rows = vPm.rows;
check('③a 对照表四项齐（未缓存输入/缓存读/输出/总 token）',
  rows.map((r) => r.key).sort().join(',') === 'cacheRead,input,output,tokens', rows.map((r) => r.key));
check('③b 每行都有 界面值/原生值/公式/误差/≤5% 判定',
  rows.every((r) => Number.isFinite(r.ui) && Number.isFinite(r.native) && typeof r.formula === 'string' && r.formula
    && typeof r.errorPct === 'number' && typeof r.within5 === 'boolean'), rows);
check('③c compareTableComplete() 通过', view.compareTableComplete(vPm) === true, view.compareTableComplete(vPm));
check('④a 界面值 = DSH 原生三项（按 Owner 截图数字：300,601 / 123,746,816 / +输出 → 124,255,567）',
  rows.find((r) => r.key === 'input').ui === 300601
  && rows.find((r) => r.key === 'cacheRead').ui === 123746816
  && rows.find((r) => r.key === 'tokens').ui === 124255567
  && rows.find((r) => r.key === 'tokens').ui === pm.input + pm.cacheRead + pm.output, rows);
check('④b 对照误差全部 ≤5%（本实现直取原生，实测 0%）', rows.every((r) => r.within5 && r.errorPct <= 5), rows.map((r) => r.errorPct));
check('④c 文案点名角色且写清三项口径',
  /^本会话（pm）/.test(vPm.label) && /未缓存输入/.test(vPm.label) && /缓存读/.test(vPm.label) && /输出/.test(vPm.label) && /总 token/.test(vPm.label), vPm.label);
check('④d 老数据（无 cacheRead/output 分项）不猜数：缓存读按 tokens−input 并标注合并',
  (() => { const old = view.usageViewOf('pm', { input: 1000, tokens: 5000 }); const cr = old.rows.find((r) => r.key === 'cacheRead');
    return cr.ui === 4000 && /合并/.test(cr.formula) && /含输出/.test(old.label); })(), view.usageViewOf('pm', { input: 1000, tokens: 5000 }).label);

const failed = ROWS.filter((r) => !r.ok).length;
if (JSON_OUT) console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed, failed: ROWS.filter((r) => !r.ok).map((r) => r.name), rows: ROWS }, null, 2));
else console.log(`\n${ROWS.length - failed}/${ROWS.length} PASS${failed ? ' · ' + failed + ' FAIL' : ''}`);
process.exit(failed ? 1 : 0);
