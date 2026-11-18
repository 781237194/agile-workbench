#!/usr/bin/env node
'use strict';
/**
 * R-9674（T-20261118-133655-05b1）纯逻辑 + 静态契约夹具（不需要 Electron）。
 *
 * 覆盖：
 *   AC1 三源优先级：快照 lastEventAt → 快照 lastOkAt → 唤醒.jsonl 最近一条 → 任务 done → 未知
 *   AC2 摘要 ≤24 字（超长补「…」）、行内时间 mm-dd hh:mm、ISO 归一（非法 ISO 按缺失）、
 *       负例：实现里不得新增 data-sq-last-event（该属性仍只属于 c9ac 的 [data-live-row]）
 *   AC3 全员摘要四种形态：all-idle / busy（思考中 mm:ss）/ 3 人以上「等 N 人」/ 有 unknown → 末尾「有 N 行未接入」
 *   AC4③ session-queue-panel.js 的 setInterval 仍 = 2（不新增定时器）
 *   AC5① 团队台 LEGACY_ACTIVITY_COLUMNS = 4 列（含 lastActivity + textField），LEGACY_SQ_LIVE_COLUMNS 仍 4
 *   AC5④ 真实规模（真实 唤醒.jsonl 行 + 1024 任务位）下 10 次模型构建 p95 ≤50ms
 *
 * 跑法：node scripts/test-9674-activity.cjs
 * 产出：AWB_9674_OUT 指定目录（默认 程序员A/产出/证据-9674/run-9674-activity.json）
 */
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const S = require(path.join(ROOT, 'src', 'session-queue.js'));
const EVID = process.env.AWB_9674_OUT ? path.resolve(process.env.AWB_9674_OUT) : path.join(ROOT, '项目', '工作台改造修复', '程序员A', '产出', '证据-9674');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? null : (detail === undefined ? null : detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + JSON.stringify(detail === undefined ? null : detail).slice(0, 400)}`);
  if (!ok) process.exitCode = 1;
}

const NOW = Date.parse('2026-11-18T06:00:00.000Z');
const iso = (minAgo) => new Date(NOW - minAgo * 60000).toISOString();

/* ───────── AC1 三源优先级 ───────── */
const snapCase = S.lastActivityOf({ snapshotEntry: { known: true, lastEventAt: iso(2), lastOkAt: iso(50) } });
check('AC1① 快照 lastEventAt → source=snapshot + 「会话状态更新」', snapCase.source === 'snapshot' && snapCase.text === '会话状态更新' && snapCase.at === iso(2), snapCase);
const snapOkCase = S.lastActivityOf({ snapshotEntry: { known: true, lastEventAt: '', lastOkAt: iso(30) }, wakeRow: { at: iso(1), to: 'pm', ok: true } });
check('AC1①-2 快照无 lastEventAt 但 lastOkAt → source=snapshot + 「唤醒成功」', snapOkCase.source === 'snapshot' && snapOkCase.text === '唤醒成功' && snapOkCase.at === iso(30), snapOkCase);
const wakeCase = S.lastActivityOf({ snapshotEntry: null, wakeRow: { at: iso(7), to: 'tester', ok: true, skipped: 'MERGED_PENDING', reason: 'merged' } });
check('AC1② 唤醒日志 skipped=MERGED_PENDING → 「唤醒跳过（合并）」+ source=wake', wakeCase.source === 'wake' && wakeCase.text === '唤醒跳过（合并）' && wakeCase.at === iso(7), wakeCase);
const wakeFail = S.lastActivityOf({ wakeRow: { at: iso(9), to: 'pm', ok: false, reason: 'WAKE_FAILED' } });
check('AC1②-2 唤醒失败行 → 「唤醒失败」', wakeFail.source === 'wake' && wakeFail.text === '唤醒失败', wakeFail);
const wakeOk = S.lastActivityOf({ wakeRow: { at: iso(9), to: 'pm', ok: true } });
check('AC1②-3 唤醒成功行 → 「唤醒成功」', wakeOk.source === 'wake' && wakeOk.text === '唤醒成功', wakeOk);
const taskCase = S.lastActivityOf({ snapshotEntry: null, wakeRow: null, taskRow: { doneAt: iso(12), title: '夹具：分析需求总览并回执' } });
check('AC1③ 任务 done → 「任务完成：<标题前 12 字>」+ source=task', taskCase.source === 'task' && /^任务完成：/.test(taskCase.text) && taskCase.at === iso(12), taskCase);
const noneCase = S.lastActivityOf({ snapshotEntry: { known: true }, wakeRow: null, taskRow: null });
check('AC1④ 三源全空 → 「未知」+ source=none + at 空（不得用「空闲」冒充）', noneCase.source === 'none' && noneCase.text === '未知' && noneCase.at === '', noneCase);
const badIso = S.lastActivityOf({ snapshotEntry: { known: true, lastEventAt: 'not-a-date' }, wakeRow: { at: iso(3), to: 'pm', ok: true } });
check('AC1 边界：lastEventAt 非法 ISO → 按缺失退到唤醒源', badIso.source === 'wake' && badIso.at === iso(3), badIso);

/* ───────── AC2 摘要截断 / 时间格式 / title 契约 ───────── */
const short = S.clipActivityText('唤醒成功');
check('AC2① ≤24 字不补「…」', short === '唤醒成功', short);
const long = S.clipActivityText('任务完成：' + '一二三四五六七八九十'.repeat(4));
check('AC2① 超 24 字 → 截断到 24 字 + 「…」（长度 25）', Array.from(long).length === 25 && long.endsWith('…'), { len: Array.from(long).length, long });
const long40 = S.clipActivityText('四'.repeat(40));
check('AC2① 40 字事件文本 → 25 字以内（24 + 「…」）', Array.from(long40).length === 25, { len: Array.from(long40).length });
check('AC2② 时间展示 mm-dd hh:mm（本地时区）', /^\d{2}-\d{2} \d{2}:\d{2}$/.test(S.activityTimeText('2026-11-18T05:45:08.210Z')), S.activityTimeText('2026-11-18T05:45:08.210Z'));
check('AC2② 非法时间 → 空串（渲染层显示「未知」）', S.activityTimeText('bad') === '' && S.activityTimeText('') === '', { bad: S.activityTimeText('bad') });
check('AC2 ISO 归一：合法 → 规范 ISO；非法/空 → 空', S.activityIso('2026-11-18T05:45:08.210Z') === '2026-11-18T05:45:08.210Z' && S.activityIso('xx') === '' && S.activityIso('') === '');
check('AC2 唤醒摘要不超 24 字（模板自带文本全部合规）',
  ['唤醒成功', '唤醒失败', '唤醒跳过', '唤醒跳过（合并）'].every((t) => Array.from(S.clipActivityText(t)).length <= 24));

/* ───────── AC3 全员摘要 ───────── */
const mkRow = (role, name, state, extra = {}) => ({
  role, name, live: { state, runningSince: extra.runningSince || '' },
  lastActivity: extra.lastActivity || { at: '', text: '未知', source: 'none' },
});
const idleRows = [
  mkRow('pm', '项目经理', 'idle', { lastActivity: { at: iso(2), text: '会话状态更新', source: 'snapshot' } }),
  mkRow('product', '产品设计师', 'idle', { lastActivity: { at: iso(40), text: '唤醒成功', source: 'wake' } }),
  mkRow('analyst', '需求分析师', 'idle', { lastActivity: { at: '', text: '未知', source: 'none' } }),
];
const allIdle = S.buildActivitySummary(idleRows, { now: NOW });
check('AC3① 全员 idle → mode=all-idle + 「全员空闲 · 最近活动：<角色> hh:mm <事件>（N 分钟前）」',
  allIdle.mode === 'all-idle' && /^全员空闲 · 最近活动：.+ \d{2}:\d{2} .+（\d+ 分钟前）$/.test(allIdle.text) && /项目经理/.test(allIdle.text) && /（2 分钟前）/.test(allIdle.text),
  allIdle);
const busyRows = [
  mkRow('pm', '项目经理', 'thinking', { runningSince: new Date(NOW - 65 * 1000).toISOString() }),
  mkRow('product', '产品设计师', 'thinking', { runningSince: new Date(NOW - 10 * 1000).toISOString() }),
];
const busy = S.buildActivitySummary(busyRows, { now: NOW });
check('AC3② 有 running → mode=busy 且含「思考中 mm:ss」', busy.mode === 'busy' && /思考中 \d{2}:\d{2}/.test(busy.text) && /项目经理/.test(busy.text), busy);
const manyRows = ['pm', 'product', 'analyst', 'programmer1', 'programmer2'].map((role, i) => mkRow(role, '角色' + i, i === 0 ? 'thinking' : (i === 1 ? 'queued' : 'blocked')));
const many = S.buildActivitySummary(manyRows, { now: NOW });
check('AC3③ 3 人以上非 idle → 只列 3 个 + 「等 N 人」', many.mode === 'busy' && /等 2 人/.test(many.text), many);
const unknownRows = [mkRow('pm', '项目经理', 'idle', { lastActivity: { at: iso(1), text: '唤醒成功', source: 'wake' } }), mkRow('tester', '测试人员', 'unknown'), mkRow('product', '产品设计师', 'unknown')];
const withUnknown = S.buildActivitySummary(unknownRows, { now: NOW });
check('AC3④ 有 unknown → 摘要末尾「· 有 N 行未接入」', /有 2 行未接入/.test(withUnknown.text) && withUnknown.unknownCount === 2, withUnknown);

/* ───────── AC4③ / AC5① 静态契约 ───────── */
const panelSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'session-queue-panel.js'), 'utf8');
check('AC4③ session-queue-panel.js 的 setInterval 仍 = 2（不新增定时器）', (panelSrc.match(/setInterval/g) || []).length === 2, { count: (panelSrc.match(/setInterval/g) || []).length });
check('AC4① 面板实现新增 data-sq-last-activity/-text/-source，且未新增 data-sq-last-event 写入',
  /data-sq-last-activity-text/.test(panelSrc) && /data-sq-last-activity-source/.test(panelSrc)
  && (panelSrc.match(/setAttribute\('data-sq-last-event'/g) || []).length === 1
  && /data-sq-last-activity'/.test(panelSrc), { lastEventWrites: (panelSrc.match(/setAttribute\('data-sq-last-event'/g) || []).length });
const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
function extractArray(src, name) {
  const start = src.indexOf(`const ${name} = [`);
  if (start < 0) return null;
  let i = src.indexOf('[', start);
  let depth = 0;
  for (let j = i; j < src.length; j += 1) {
    const ch = src[j];
    if (ch === '[') depth += 1;
    else if (ch === ']') { depth -= 1; if (depth === 0) return vm.runInNewContext('(' + src.slice(i, j + 1) + ')'); }
  }
  return null;
}
const actCols = extractArray(appSrc, 'LEGACY_ACTIVITY_COLUMNS');
const liveCols = extractArray(appSrc, 'LEGACY_SQ_LIVE_COLUMNS');
check('AC5① LEGACY_ACTIVITY_COLUMNS = 4 列（commit/file/wake/lastActivity）',
  Array.isArray(actCols) && actCols.length === 4 && actCols.map((c) => c.key).join(',') === 'commit,file,wake,lastActivity', actCols && actCols.map((c) => c.key));
check('AC5① 第 4 列声明 field=lastActivityAt + textField=lastActivityText + sourceField',
  Array.isArray(actCols) && actCols[3] && actCols[3].field === 'lastActivityAt' && actCols[3].textField === 'lastActivityText' && actCols[3].sourceField === 'lastActivitySource', actCols && actCols[3]);
check('AC5① LEGACY_SQ_LIVE_COLUMNS 仍 4 列（未被并入）', Array.isArray(liveCols) && liveCols.length === 4, liveCols && liveCols.length);
check('AC5② app.js 自定义渲染分支：textField → `HH:MM 摘要` + title 含 ISO/来源',
  /col\.textField/.test(appSrc) && /text: `\$\{text\} \$\{summary\}`/.test(appSrc) && /LEGACY_ACTIVITY_SOURCE_LABEL/.test(appSrc));
check('AC5② 团队台单元格锚点由列声明生成（data-activity-<key> / data-activity-head=<key>）',
  /data-activity-\$\{esc\(col\.key\)\}/.test(appSrc) && /data-activity-head="\$\{esc\(col\.key\)\}"/.test(appSrc));

/* ───────── AC5④ 真实规模性能（真实 唤醒.jsonl + 1024 任务位） ───────── */
const realWake = path.join(ROOT, '团队', '状态', '项目', '工作台改造修复', '唤醒.jsonl');
let perfDetail = { source: 'fixture' };
try {
  const text = fs.readFileSync(realWake, 'utf8');
  const rows = S.parseWakeLog(text).rows;
  const bytes = fs.statSync(realWake).size;
  const roleNames = { pm: '项目经理', product: '产品设计师', analyst: '需求分析师', programmer1: '高级程序员 A', programmer2: '高级程序员 B', tester: '测试人员' };
  const taskByRole = {};
  for (const [i, role] of Object.keys(roleNames).entries()) {
    taskByRole[role] = { doneAt: new Date(NOW - (i + 1) * 60000).toISOString(), title: `夹具任务${i}：标题` };
  }
  const snapshot = {
    at: new Date(NOW).toISOString(), staleMs: 60000,
    roles: Object.keys(roleNames).map((role, i) => ({ role, known: true, queued: i % 2, running: false, lastEventAt: i === 0 ? new Date(NOW - 60000).toISOString() : '', lastOkAt: '' })),
  };
  // 模拟主进程索引：latestWakeRowByRole 只在追加时增量算（请求路径直接复用）
  const latestWakeRowByRole = {};
  for (const row of rows) {
    const role = String(row && row.to || '').trim();
    if (!role) continue;
    const ms = Date.parse(String(row.at || row.deliveredAt || row.deliverAt || ''));
    if (!Number.isFinite(ms)) continue;
    const prevMs = latestWakeRowByRole[role] ? Date.parse(String(latestWakeRowByRole[role].at || '')) : -Infinity;
    if (!Number.isFinite(prevMs) || ms >= prevMs) latestWakeRowByRole[role] = row;
  }
  const samples = [];
  for (let i = 0; i < 10; i += 1) {
    const t = process.hrtime.bigint();
    const model = S.buildPanelModel({ now: NOW, roles: Object.keys(roleNames), roleNames, snapshot, wakeRows: rows, latestWakeRowByRole, badLines: 0, taskByRole });
    samples.push(Number(process.hrtime.bigint() - t) / 1e6);
    if (i === 0) perfDetail.rows = model.rows.length;
  }
  const sorted = samples.slice().sort((a, b) => a - b);
  const p95 = sorted[Math.min(sorted.length - 1, Math.ceil(0.95 * sorted.length) - 1)];
  perfDetail = { source: realWake, bytes, wakeRows: rows.length, samples: samples.map((v) => Number(v.toFixed(2))), p95: Number(p95.toFixed(2)), taskByRole: Object.keys(taskByRole).length };
  check('AC5④ 真实规模（真实唤醒日志 + 6 角色 + 任务源）单次模型构建 p95 ≤50ms', p95 <= 50, perfDetail);
  check('AC5④ 真实唤醒日志规模符合基线（≥1000 行，正文 8293 行）', rows.length >= 1000, { rows: rows.length, bytes });
} catch (e) {
  check('AC5④ 真实唤醒日志可读（读不到就降级为夹具规模）', false, String((e && e.message) || e));
}

/* ───────── 汇总 ───────── */
fs.mkdirSync(EVID, { recursive: true });
const report = { task: 'T-20261118-133655-05b1', requirement: 'R-20261118-131106-9674', at: new Date().toISOString(), total: results.length, pass: results.filter((r) => r.ok).length, red: results.filter((r) => !r.ok).length, perf: perfDetail, results };
const outFile = path.join(EVID, 'run-9674-activity.json');
fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`\nSQ_9674_ACTIVITY ${JSON.stringify({ total: report.total, pass: report.pass, red: report.red, p95: perfDetail.p95 })}`);
console.log('证据：' + outFile);
process.exit(report.red ? 1 : 0);
