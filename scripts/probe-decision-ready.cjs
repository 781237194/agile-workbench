'use strict';
/**
 * probe-decision-ready-v2.cjs —— R-c72a 批3（T-20261116-221117-3f77）AC3 锚点语义探针
 *
 * 契约（正文 AC3 / F2b，正文 14044B / sha256 990144e8…）：
 *   #decision-box[data-decision-ready] 由 src/renderer/app.js 的 renderDecisionFloat() 独占设置——
 *   开始渲染置 "0" → 首屏渲染完成置 "1" → **渲染抛错保持 "0"**；关闭浮层**不重置**；
 *   下次打开重新走「置 0 → 置 1」（重复打开必须重新计时，不得沿用上次的 1）。
 *
 * 与批1 probe-decision-ready-fixed.cjs 的差别：那份验的是「wrapper+finally 一定置 1」的**旧临时语义**，
 * 而正文 AC3 明确要求「渲染抛错保持 0」，finally 强行置 1 反而是缺陷；本探针按正文语义重写，
 * 并额外守住三条：① 抽屉渲染 renderDecisionBox 不得再写该锚点（单写者）；② 关闭路径不得重置；
 * ③ 重复打开必须重新出现 0 → 1。
 */
const fs = require('node:fs');
const path = require('node:path');

const findRoot = (start) => {
  let cur = start;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(cur, '团队', '工具', 'team.mjs'))) return cur;
    const up = path.dirname(cur);
    if (up === cur) break;
    cur = up;
  }
  return null;
};
const ROOT = findRoot(__dirname) || findRoot(process.cwd());
if (!ROOT) { console.log('ENV_FAIL 找不到仓库根（团队/工具/team.mjs）'); process.exit(2); }
const APP = path.join(ROOT, 'src', 'renderer', 'app.js');
const src = fs.readFileSync(APP, 'utf8');
const lines = src.split(/\r?\n/);

let pass = 0;
const fails = [];
// 只留代码行、去掉整行注释：否则注释里出现的 "0"/"1"/finally 会污染顺序断言（首版就踩了这个）。
const stripComments = (text) => String(text || '').split(/\r?\n/).filter((line) => {
  const s = line.trim();
  return !(s.startsWith('//') || s.startsWith('/*') || s.startsWith('*') || s.startsWith('*/'));
}).join('\n');

const check = (name, cond, detail) => {
  if (cond) { pass += 1; console.log('PASS  ' + name); }
  else { fails.push(name); console.log('FAIL  ' + name + (detail !== undefined ? '  → ' + JSON.stringify(detail) : '')); }
};

// ── 1) 结构：renderDecisionFloat=wrapper（写锚点） / renderDecisionFloatInner=原渲染体
const wStart = lines.findIndex((l) => /^function renderDecisionFloat\s*\(/.test(l));
check('S1a renderDecisionFloat wrapper 存在', wStart >= 0, { line: wStart + 1 });
check('S1b 原渲染体已改名 renderDecisionFloatInner', /^function renderDecisionFloatInner\s*\(/m.test(src));

// 取 wrapper 源码（按花括号配平，函数体只含 if 语句与函数调用）
let wrapper = '';
if (wStart >= 0) {
  let depth = 0;
  let startIdx = -1;
  for (let i = wStart; i < lines.length; i += 1) {
    for (const ch of lines[i]) {
      if (ch === '{') { depth += 1; if (startIdx < 0) startIdx = i; }
      else if (ch === '}') depth -= 1;
    }
    if (startIdx >= 0 && depth === 0) { wrapper = lines.slice(wStart, i + 1).join('\n'); break; }
  }
}

// ── 2) 顺序与不吞错：置 0 → 调 inner → 置 1；无 finally
const wrapperCode = stripComments(wrapper);
const i0 = wrapperCode.indexOf('setAttribute("data-decision-ready", "0")');
const iCall = wrapperCode.indexOf('renderDecisionFloatInner(');
const i1 = wrapperCode.indexOf('setAttribute("data-decision-ready", "1")');
check('S2a wrapper 里有 置0 / 调inner / 置1 三段', i0 >= 0 && iCall > i0 && i1 > iCall, { i0, iCall, i1 });
check('S2b wrapper 里没有 finally（抛错不得被强行置 1）', wrapperCode.length > 0 && !/finally/.test(wrapperCode));
check('S2c wrapper 里没有 catch（错误必须照旧向外抛、不静默）', wrapperCode.length > 0 && !/catch/.test(wrapperCode));

// ── 3) 单写者：锚点只由浮层 wrapper 写，抽屉渲染不写
// 只数「真正写属性」的调用（setAttribute("data-decision-ready", ...)），注释里提到属性名不算写入者。
const anchorHits = [];
{
  const needle = 'setAttribute("data-decision-ready"';
  let idx = -1;
  for (;;) {
    idx = src.indexOf(needle, idx + 1);
    if (idx < 0) break;
    anchorHits.push(src.slice(0, idx).split('\n').length);
  }
}
check('S3a 全文件 data-decision-ready 写入只出现 2 次（写 0 与写 1）', anchorHits.length === 2, { lines: anchorHits });
const wLineStart = wStart + 1;
const wLineEnd = wLineStart + wrapper.split('\n').length - 1;
check('S3b 两次锚点写入都在 renderDecisionFloat wrapper 内', anchorHits.length === 2 && anchorHits.every((n) => n >= wLineStart && n <= wLineEnd), { wrapperLines: [wLineStart, wLineEnd], anchorLines: anchorHits });
{
  const bStart = lines.findIndex((l) => /^function renderDecisionBox\s*\(/.test(l));
  let bSeg = '';
  if (bStart >= 0) {
    let depth = 0;
    for (let i = bStart; i < lines.length && i < bStart + 80; i += 1) {
      for (const ch of lines[i]) { if (ch === '{') depth += 1; else if (ch === '}') depth -= 1; }
      bSeg += lines[i] + '\n';
      if (depth === 0) break;
    }
  }
  check('S3c 抽屉渲染 renderDecisionBox 不写 data-decision-ready（避免两个写入者）', bStart >= 0 && bSeg.length > 0 && !bSeg.includes('data-decision-ready'), { line: bStart + 1 });
}

// ── 4) 重开必须重新计时：setDecisionExpanded(true) 重新调用 renderDecisionFloat
{
  const sStart = lines.findIndex((l) => /^function setDecisionExpanded\s*\(/.test(l));
  const seg = sStart >= 0 ? stripComments(lines.slice(sStart, sStart + 25).join('\n')) : '';
  const onIdx = seg.indexOf('if (on)');
  const callIdx = seg.indexOf('renderDecisionFloat(DECISION_FLOAT_STATE.data)');
  check('S4a 展开路径（if (on)）重新调用 renderDecisionFloat', onIdx >= 0 && callIdx > onIdx, { sStart: sStart + 1 });
  const offBranch = onIdx >= 0 ? seg.slice(0, onIdx) : '';
  check('S4b 关闭路径里没有 renderDecisionFloat/锚点写入（关闭不重置）', seg.length > 0 && !/renderDecisionFloat\s*\(/.test(offBranch) && !offBranch.includes('data-decision-ready'));
}

// ── 5) 运行时语义（抽 wrapper 源码 + 假 inner，三条路径）
const runtimeCalls = [];
const boxStub = { setAttribute(n, v) { runtimeCalls.push(String(v)); } };
const docStub = { querySelector: () => boxStub };
function runWrapper(inner) {
  const fn = new Function('document', 'renderDecisionFloatInner', wrapper + '\nreturn renderDecisionFloat;');
  return fn(docStub, inner);
}
let runtimeOk = true;
let detail = {};
try {
  // 正常路径：置 0 → 置 1，返回 inner 值
  const normal = runWrapper(() => 'ok-inner');
  runtimeCalls.length = 0;
  const ret = normal('data');
  const normalCalls = runtimeCalls.slice();
  // 抛错路径：只置 0，错误向外抛
  runtimeCalls.length = 0;
  const throwing = runWrapper(() => { throw new Error('boom-inner'); });
  let thrown = null;
  try { throwing('data'); } catch (e) { thrown = e; }
  const thrownCalls = runtimeCalls.slice();
  // 重复打开：两次打开都必须重新出现 0 → 1
  runtimeCalls.length = 0;
  const again = runWrapper(() => 'ok-inner');
  again('data'); again('data');
  const reopenCalls = runtimeCalls.slice();
  detail = { normalCalls, thrownCalls, reopenCalls, ret, thrown: thrown && thrown.message };
  runtimeOk = normalCalls.join(',') === '0,1'
    && ret === 'ok-inner'
    && thrownCalls.join(',') === '0'
    && /boom-inner/.test(String(thrown && thrown.message))
    && reopenCalls.join(',') === '0,1,0,1';
} catch (e) {
  runtimeOk = false;
  detail = { error: String((e && e.message) || e) };
}
check('S5 wrapper 可在 stub 环境执行（正常/抛错/重开三条路径）', runtimeOk, detail);

console.log('\n结果：' + pass + '/' + (pass + fails.length) + (fails.length ? '（失败 ' + fails.length + '）' : ' PASS'));
if (fails.length) console.log('失败项：' + fails.join('、'));
process.exit(fails.length ? 1 : 0);
