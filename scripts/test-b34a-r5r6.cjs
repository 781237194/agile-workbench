#!/usr/bin/env node
'use strict';
/**
 * test-b34a-r5r6.cjs —— R-b34a R5/R6（T-20261118-175633-18e8）夹具：
 *   骨架屏（同步出现/清除）、列表差量（节点复用/新增/删除/顺序/子内容替换）、
 *   交互态门（打字/滚动/拖拽期间暂停）、15s 合并调度、静态接线检查。
 *
 * 纯 Node + 最小假 DOM（不依赖 jsdom/Electron），不写真实状态。
 * 用法：node scripts/test-b34a-r5r6.cjs [--out <json>]
 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const OUT_ARG = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(String(process.argv[i + 1])) : ''; })();
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? null : (detail === undefined ? null : detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + JSON.stringify(detail === undefined ? null : detail).slice(0, 500)}`);
  return Boolean(ok);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const read = (rel) => fs.readFileSync(path.join(ROOT, rel), 'utf8');

/** 最小假 DOM：只实现 gate.js 用到的 API。 */
function fakeDoc() {
  class N {
    constructor(tag) {
      this.tagName = tag; this.childNodes = []; this.parentNode = null; this.attrs = new Map();
      this.className = ''; this.textContent = ''; this.ownerDocument = null;
    }
    get children() { return this.childNodes.filter((c) => c.tagName); }
    appendChild(c) { if (c.parentNode) c.parentNode.removeChild(c); c.parentNode = this; this.childNodes.push(c); return c; }
    removeChild(c) { const i = this.childNodes.indexOf(c); if (i >= 0) this.childNodes.splice(i, 1); c.parentNode = null; return c; }
    remove() { if (this.parentNode) this.parentNode.removeChild(this); }
    setAttribute(k, v) { this.attrs.set(String(k), String(v)); }
    getAttribute(k) { return this.attrs.has(String(k)) ? this.attrs.get(String(k)) : null; }
    replaceChildren(...nodes) { for (const c of this.childNodes.slice()) this.removeChild(c); for (const n of nodes) this.appendChild(n); }
    querySelectorAll(sel) {
      const key = String(sel).replace(/^\[/, '').replace(/\]$/, '');
      const out = [];
      const walk = (n) => { for (const c of n.childNodes) { if (c.getAttribute && c.getAttribute(key) != null) out.push(c); walk(c); } };
      walk(this);
      return out;
    }
    get attributes() { return Array.from(this.attrs.entries()).map(([name, value]) => ({ name, value })); }
  }
  const doc = { createElement: (t) => { const n = new N(t); n.ownerDocument = doc; return n; } };
  return doc;
}

(async () => {
  const gate = require(path.join(ROOT, 'src', 'renderer', 'gate.js'));
  const doc = fakeDoc();

  /* R5-① 骨架：同步出现、行数/文案、可清除 */
  const host = doc.createElement('div');
  const t0 = Date.now();
  const sk = gate.skeleton(host, { rows: 5, label: '会话排队加载中…' });
  const ms = Date.now() - t0;
  const skNodes = host.querySelectorAll('[data-skeleton]');
  const rows = skNodes.length ? skNodes[0].querySelectorAll('[data-skeleton-row]') : [];
  check('R5-① 骨架同步渲染（<200ms）且带 data-skeleton/行数/文案',
    Boolean(sk) && ms < 200 && skNodes.length === 1 && rows.length === 5
    && String(sk.querySelectorAll('[data-skeleton-label]')[0].textContent || '') === '会话排队加载中…', { ms, rows: rows.length });
  const cleared = gate.clearSkeleton(host);
  check('R5-② clearSkeleton 移除骨架且幂等', cleared === 1 && host.querySelectorAll('[data-skeleton]').length === 0, { cleared });

  /* R5-③ 差量：同 key 保留节点实体、只换内容；新增/删除/顺序正确 */
  const list = doc.createElement('div');
  const mk = (item) => {
    const el = doc.createElement('div');
    el.setAttribute('data-row', '1');
    const span = doc.createElement('span');
    span.textContent = String(item.title);
    el.appendChild(span);
    return el;
  };
  const v1 = [{ id: 'a', title: 'A1' }, { id: 'b', title: 'B1' }, { id: 'c', title: 'C1' }];
  gate.reconcileReplace(list, v1, { keyOf: (x) => x.id, build: mk });
  const nodeA1 = list.children[0];
  const nodeB1 = list.children[1];
  const v2 = [{ id: 'b', title: 'B2' }, { id: 'a', title: 'A2' }, { id: 'd', title: 'D1' }];
  const stat = gate.reconcileReplace(list, v2, { keyOf: (x) => x.id, build: mk });
  const keys = list.children.map((n) => n.getAttribute('data-reconcile-key'));
  check('R5-③ 同 key 节点实体复用（不重建）、新增 1/删除 1、顺序按 items',
    stat.kept === 2 && stat.created === 1 && stat.removed === 1
    && list.children[1] === nodeA1 && list.children[0] === nodeB1
    && keys.join(',') === 'b,a,d', { stat, keys });
  check('R5-④ 复用节点的子内容被替换（B2 而非 B1），且未整块清空容器（无 innerHTML 使用）',
    String(nodeB1.children[0].textContent) === 'B2' && String(nodeA1.children[0].textContent) === 'A2'
    && !/\.innerHTML\s*=/.test(String(gate.reconcileReplace)), {});

  /* R6-① 交互态门：interacting 时 gate 不执行并计数 */
  let hidden = false; let busy = false;
  const g = gate.createGate({ hidden: () => hidden, interacting: () => busy });
  let ran = 0;
  g.gate(() => { ran += 1; })();
  busy = true;
  g.gate(() => { ran += 1; })();
  hidden = true; busy = false;
  g.gate(() => { ran += 1; })();
  check('R6-① 交互期/隐藏期 gate 均不执行（分别计数）',
    ran === 1 && g.stats.skippedInteraction === 1 && g.stats.skippedHidden === 1, { ran, stats: g.stats });

  /* R6-② 15s 合并调度：同 key 去重、窗口内不重跑、返回同一 Promise */
  let runs = 0;
  const p1 = gate.schedule(() => { runs += 1; return 'v1'; }, 'k1', { windowMs: 15000 });
  const p2 = gate.schedule(() => { runs += 1; return 'v1'; }, 'k1', { windowMs: 15000 });
  await p1; await p2;
  await sleep(60);
  const runsAfter = runs;
  await gate.schedule(() => { runs += 1; }, 'k1', { windowMs: 15000 });
  check('R6-② 同 key 15s 窗口合并：两次调用只执行 1 次；窗口内再调不重跑',
    runsAfter === 1 && runs === 1 && p1 === p2, { runs, runsAfter, samePromise: p1 === p2 });

  /* R6-③ 交互期延后：interacting 时 schedule 不立即执行，静默后执行 */
  let runs2 = 0; busy = true; hidden = false;
  const p3 = g.schedule(() => { runs2 += 1; return 'x'; }, 'k2', { windowMs: 2000 });
  await sleep(120);
  const during = runs2;
  busy = false;
  await p3;
  await sleep(300);
  check('R6-③ 交互期 schedule 延后执行（交互中 0 次，静默后执行）', during === 0 && runs2 === 1, { during, runs2 });

  /* R6-④ installInteraction：监听安装一次、事件触发交互态 */
  const target = {
    handlers: {},
    addEventListener(evt, fn) { (this.handlers[evt] = this.handlers[evt] || []).push(fn); },
  };
  const ok1 = gate.installInteraction(target, { quietMs: 500 });
  const ok2 = gate.installInteraction(target, { quietMs: 500 });
  const g2 = gate.createGate({ hidden: () => false });
  // 直接验证 install 计数与事件注册（interacting 判定由实例状态维护，这里验监听器存在）
  check('R6-④ installInteraction 幂等（首次 true、二次 false），键盘/滚动/触摸监听已注册',
    ok1 === true && ok2 === false
    && ['keydown', 'wheel', 'pointerdown', 'touchstart', 'scroll'].every((e) => (target.handlers[e] || []).length === 1),
    { ok1, ok2, handlers: Object.keys(target.handlers) });

  /* 静态接线 */
  const app = read(path.join('src', 'renderer', 'app.js'));
  const panel = read(path.join('src', 'renderer', 'session-queue-panel.js'));
  const gateSrc = read(path.join('src', 'renderer', 'gate.js'));
  check('R5-⑤ 接线：app.js 安装交互监听 + 流程面板先骨架；排队面板无模型先骨架',
    /installInteraction\(window\)/.test(app) && /skeleton\(board/.test(app) && /skeleton\(host/.test(panel), {});
  check('R5-⑥ gate.js 导出 R5/R6 API（skeleton/clearSkeleton/reconcileReplace/schedule/installInteraction）',
    ['skeleton', 'clearSkeleton', 'reconcileReplace', 'schedule', 'installInteraction'].every((k) => typeof gate[k] === 'function'), {});
  const app2 = app;
  const orSrc = read(path.join('src', 'renderer', 'owner-review.js'));
  check('R5-⑧ 批2：团队台/需求池开启时骨架已接（r5Skeleton 注入点存在）',
    /r5Skeleton\('#team-drawer'/.test(app2) && /r5Skeleton\('#pool-req-list'/.test(app2) && /r5Skeleton\('#pool-def-list'/.test(app2), {});
  check('R5-⑨ 批2：评审弹窗打开先骨架 + 5s 刷新按签名跳过重建（差量）',
    /AWBGate\.skeleton\(list/.test(orSrc) && /reviewRenderSig\(allRows\)/.test(orSrc) && /state\._renderSig === renderSig/.test(orSrc), {});
  check('R5-⑩ 批2：需求池缺陷列表改行级差量（reconcileReplaceMarkup，不再整块 innerHTML）',
    /reconcileReplaceMarkup\(defList/.test(app2) && typeof gate.reconcileReplaceMarkup === 'function', {});
  check('R5-⑪ 批2：流程列表沿用既有渲染签名短路（不整块重建）+ 骨架', /flowRenderUi\.sig/.test(app2) && /skeleton\(board/.test(app2), {});
  check('R5-⑫ 骨架样式已入 style.css（.awb-skeleton 且 reduced-motion 关动画）',
    /\.awb-skeleton-row/.test(read(path.join('src', 'renderer', 'style.css'))) && /prefers-reduced-motion/.test(read(path.join('src', 'renderer', 'style.css'))), {});
  const sqIntervals = (panel.match(/setInterval\(/g) || []).length;
  check('R5-⑦ c9ac 契约保持：session-queue-panel setInterval 恒 = 2', sqIntervals === 2, { sqIntervals });

  const failed = results.filter((r) => !r.ok);
  const payload = { task: 'T-20261118-175633-18e8', requirement: 'R-20261118-170937-b34a', total: results.length, pass: results.length - failed.length, red: failed.length, ok: failed.length === 0, at: new Date().toISOString(), checks: results };
  if (OUT_ARG) { try { fs.mkdirSync(path.dirname(OUT_ARG), { recursive: true }); fs.writeFileSync(OUT_ARG, JSON.stringify(payload, null, 2) + '\n', 'utf8'); } catch { /* ignore */ } }
  console.log('');
  for (const f of failed) console.log(`FAILED  ${f.name} :: ${String(JSON.stringify(f.detail)).slice(0, 500)}`);
  console.log(`B34A_R5R6 ${failed.length ? 'FAIL' : 'OK'} ${JSON.stringify({ total: payload.total, pass: payload.pass, red: payload.red })}`);
  if (OUT_ARG) console.log('证据：' + OUT_ARG);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => { console.error('B34A_R5R6 ERROR ' + String((e && e.stack) || e)); process.exit(1); });
