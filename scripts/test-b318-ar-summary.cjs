#!/usr/bin/env node
'use strict';
/**
 * test-b318-ar-summary.cjs —— B-20261118-144907-b318「自动换人栏陈旧状态」纯函数夹具
 *
 * 覆盖任务【要做】4 条 + acceptance 1–4：
 *   A 时效：状态只认最近 15 分钟内的事件；14:10 的 rotate 在 15:00 不得再显示「正在换人」；
 *   B 历史错误码：12:49 的 ROTATE_MANUAL_REQUIRED 不再红，只作灰字「历史：…已恢复」；
 *   C 设计内：HANDOVER_TIMEOUT（及 NIGHT_SILENT 等）归 yellow warn，且**不计入 failedToday**；
 *   D 关闭态：config.autoRotate.enabled=false → 所有角色 disabled「已关闭（手动换人模式）」；
 *   E 真失败：最近 15 分钟内 result=fail / stage=failed → failed + error（红），failedToday 计 1；
 *   F 边界：14:59 算最近、15:01 算过期；
 *   G 恢复：旧失败（>15 分钟）+ 新 rotate（<15 分钟）→ rotating + history（不红）；
 *   H 计数：rotatedToday 只算 rotate 成功行；HANDOVER_TIMEOUT/NIGHT_SILENT 不算失败。
 * 用法：node scripts/test-b318-ar-summary.cjs [--json] [--out <json>]
 * 退出码：0 全过 / 1 有断言失败
 */
const fs = require('node:fs');
const path = require('node:path');
const SQ = require(path.join(__dirname, '..', 'src', 'session-queue.js'));

const JSON_OUT = process.argv.includes('--json');
const OUT_ARG = (() => { const i = process.argv.indexOf('--out'); return i > 0 && process.argv[i + 1] ? path.resolve(String(process.argv[i + 1])) : ''; })();
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 600)}`);
  return Boolean(ok);
}

// 固定「现在」= 上海 2026-11-18 15:00；所有事件都用真实 UTC ISO（本地 +8）。
const NOW = Date.parse('2026-11-18T15:00:00+08:00');
const iso = (hhmm) => new Date(Date.parse(`2026-11-18T${hhmm}:00+08:00`)).toISOString();
const row = (role, hhmm, stage, code, result) => ({ at: iso(hhmm), role, stage, code, result, project: '夹具有限', note: '' });
const sum = (rows, config) => SQ.readAutoRotateSummary({ auditRows: rows, now: NOW, config });

/* A. 时效：14:10 rotate → 15:00 不得「正在换人」 */
const a = sum([row('pm', '14:10', 'rotate', 'ROTATED', 'ok')]);
check('A1 14:10 的 rotate 行 + 现在 15:00（50 分钟前）→ 状态不再是 rotating/rebooting',
  a.byRole.pm && !['rotating', 'rebooting'].includes(a.byRole.pm.state),
  { state: a.byRole.pm && a.byRole.pm.state, reason: a.byRole.pm && a.byRole.pm.reason });
check('A2 过期无失败 → idle，且 reason 说清「超过 15 分钟」',
  a.byRole.pm.state === 'idle' && /超过 15 分钟/.test(String(a.byRole.pm.reason || '')),
  { state: a.byRole.pm.state, reason: a.byRole.pm.reason });
check('A3 staleMs 口径 = 15 分钟（900000ms）', a.staleMs === 15 * 60 * 1000, { staleMs: a.staleMs });

/* B. 历史错误码：12:49 ROTATE_MANUAL_REQUIRED 不红 */
const b = sum([row('pm', '12:49', 'boot_check', 'ROTATE_MANUAL_REQUIRED', 'fail')]);
check('B1 12:49 旧错误码 + 无后续失败 → 不输出红 error，state=history',
  b.byRole.pm.state === 'history' && String(b.byRole.pm.error || '') === '',
  { state: b.byRole.pm.state, error: b.byRole.pm.error });
check('B2 历史码以灰字 history 呈现（含「历史：…已恢复」与时间）',
  /历史：ROTATE_MANUAL_REQUIRED/.test(String(b.byRole.pm.history || '')) && /已恢复/.test(String(b.byRole.pm.history || '')) && Boolean(b.byRole.pm.historyAt),
  { history: b.byRole.pm.history, historyAt: b.byRole.pm.historyAt });

/* C. 设计内：HANDOVER_TIMEOUT 黄色、不记失败 */
const c = sum([row('tester', '14:58', 'skipped', 'HANDOVER_TIMEOUT', 'ok')]);
check('C1 HANDOVER_TIMEOUT（2 分钟前）→ state=warn（黄色设计内），error 为空',
  c.byRole.tester.state === 'warn' && String(c.byRole.tester.error || '') === ''
  && /设计内/.test(String(c.byRole.tester.reason || '')),
  { state: c.byRole.tester.state, error: c.byRole.tester.error, reason: c.byRole.tester.reason });
check('C2 HANDOVER_TIMEOUT / NIGHT_SILENT 不计入 failedToday',
  c.failedToday === 0
  && sum([row('x', '14:59', 'skipped', 'NIGHT_SILENT', 'ok')]).failedToday === 0,
  { failedToday: c.failedToday });

/* D. 关闭态：enabled=false → disabled */
const d = sum([row('pm', '14:10', 'rotate', 'ROTATED', 'ok'), row('pm', '12:49', 'boot_check', 'ROTATE_MANUAL_REQUIRED', 'fail')],
  { enabled: false, mode: 'remind-only' });
check('D1 enabled=false → 所有出现过的角色 state=disabled，文案「已关闭（手动换人模式）」',
  d.byRole.pm.state === 'disabled' && /已关闭（手动换人模式）/.test(String(d.byRole.pm.reason || '')),
  { state: d.byRole.pm.state, reason: d.byRole.pm.reason });
check('D2 关闭态仍保留历史错误码灰字（不丢信息、也不红）',
  String(d.byRole.pm.error || '') === '' && /ROTATE_MANUAL_REQUIRED/.test(String(d.byRole.pm.history || '')),
  { error: d.byRole.pm.error, history: d.byRole.pm.history });
check('D3 model 自述 enabled/mode（面板可判关闭模式）',
  d.enabled === false && String(d.mode) === 'remind-only',
  { enabled: d.enabled, mode: d.mode });

/* E. 真失败：最近 15 分钟内 fail → 红 */
const e = sum([row('analyst', '14:59', 'failed', 'ROTATE_FAILED', 'fail')]);
check('E1 最近 1 分钟 result=fail → state=failed + error=错误码',
  e.byRole.analyst.state === 'failed' && String(e.byRole.analyst.error) === 'ROTATE_FAILED',
  { state: e.byRole.analyst.state, error: e.byRole.analyst.error });
check('E2 真实失败计入 failedToday（=1）', e.failedToday === 1, { failedToday: e.failedToday });

/* F. 边界：14:59 最近 / 15:01 过期 */
const f1 = sum([row('p1', '14:45', 'rotate', 'ROTATED', 'ok')]);   // 15 分钟整
const f2 = sum([row('p2', '14:44', 'rotate', 'ROTATED', 'ok')]);   // 16 分钟前
check('F1 边界：恰好 15 分钟（14:45 → 15:00）仍算最近 → rotating',
  f1.byRole.p1.state === 'rotating', { state: f1.byRole.p1.state });
check('F2 边界：16 分钟前（14:44）→ 过期回落 idle',
  f2.byRole.p2.state === 'idle', { state: f2.byRole.p2.state });

/* G. 恢复：旧失败 + 新 rotate → rotating + history（不红） */
const g = sum([row('product', '14:20', 'boot_check', 'ROTATE_MANUAL_REQUIRED', 'fail'), row('product', '14:58', 'rotate', 'ROTATED', 'ok')]);
check('G1 旧失败（40 分钟前）+ 新 rotate（2 分钟前）→ rotating，且 error 为空',
  g.byRole.product.state === 'rotating' && String(g.byRole.product.error || '') === '',
  { state: g.byRole.product.state, error: g.byRole.product.error });
check('G2 旧失败降为灰字历史（已恢复）',
  /历史：ROTATE_MANUAL_REQUIRED/.test(String(g.byRole.product.history || '')),
  { history: g.byRole.product.history });

/* H. 计数：rotatedToday 只算 rotate 成功；summary 文本 */
const h = sum([
  row('pm', '10:00', 'rotate', 'ROTATED', 'ok'),
  row('tester', '11:00', 'rotate', 'ROTATED', 'ok'),
  row('tester', '12:00', 'skipped', 'HANDOVER_TIMEOUT', 'ok'),
  row('analyst', '14:59', 'failed', 'ROTATE_FAILED', 'fail'),
]);
check('H1 rotatedToday=2（只算 rotate 成功行）、failedToday=1（设计内超时不算）',
  h.rotatedToday === 2 && h.failedToday === 1,
  { rotatedToday: h.rotatedToday, failedToday: h.failedToday });
check('H2 summary 文案「今日自动换人 2 次 / 失败 1 次」',
  String(h.summary) === '今日自动换人 2 次 / 失败 1 次', { summary: h.summary });

/* I. 近事件：trigger/broadcast 各自归位 */
const i1 = sum([row('pm', '14:59', 'trigger', '', 'ok')]);
const i2 = sum([row('pm', '14:59', 'broadcast_reboot', 'REBOOT_BROADCAST', 'ok')]);
check('I1 trigger（1 分钟内）→ pending_handover；broadcast_reboot → rebooting',
  i1.byRole.pm.state === 'pending_handover' && i2.byRole.pm.state === 'rebooting',
  { trigger: i1.byRole.pm.state, reboot: i2.byRole.pm.state });

/* J. 跨天：昨日事件不影响今天状态 */
const j = sum([row('pm', '10:00', 'rotate', 'ROTATED', 'ok'), { at: '2026-11-17T10:00:00+08:00', role: 'pm', stage: 'rotate', code: 'ROTATED', result: 'ok' }]);
check('J1 昨日事件不计入今日状态（today 口径不变）',
  j.rotatedToday === 1 && j.byRole.pm.state === 'idle',
  { rotatedToday: j.rotatedToday, state: j.byRole.pm.state });

/* K. B-3594（remind-only）之后的审计行口径 */
const k1 = sum([row('pm', '14:58', 'remind', 'REMIND_ONLY_MANUAL_ROTATE', 'ok')]);
check('K1 remind 行（2 分钟内）→ warn（黄色）且 reason 说明「只提醒、不换人」',
  k1.byRole.pm.state === 'warn' && /只提醒/.test(String(k1.byRole.pm.reason || '')) && String(k1.byRole.pm.error || '') === '',
  k1.byRole.pm);
const k2 = sum([row('pm', '14:57', 'rotate', 'ROTATED', 'ok'), row('pm', '14:59', 'archive', 'ARCHIVE_ARCHIVED', 'ok')]);
check('K2 archive 成功行不算状态事件（刚换完仍 rotating，不立刻回落 idle）',
  k2.byRole.pm.state === 'rotating', k2.byRole.pm);
const k3 = sum([row('pm', '14:58', 'archive', 'ARCHIVE_FAILED', 'fail')]);
check('K3 archive 失败行仍算真失败（红，error=ARCHIVE_FAILED）',
  k3.byRole.pm.state === 'failed' && String(k3.byRole.pm.error) === 'ARCHIVE_FAILED', k3.byRole.pm);

/* 汇总 */
const failed = results.filter((r) => !r.ok);
const payload = { ok: failed.length === 0, total: results.length, passed: results.length - failed.length, failed: failed.length, at: new Date().toISOString(), now: new Date(NOW).toISOString(), checks: results };
if (OUT_ARG) { try { fs.mkdirSync(path.dirname(OUT_ARG), { recursive: true }); fs.writeFileSync(OUT_ARG, JSON.stringify(payload, null, 2) + '\n', 'utf8'); } catch { /* 证据落盘失败不改变结论 */ } }
if (JSON_OUT) console.log(JSON.stringify(payload, null, 2));
else {
  console.log('');
  for (const f of failed) console.log(`FAILED  ${f.name} :: ${String(JSON.stringify(f.detail)).slice(0, 500)}`);
  console.log(`B318 AR SUMMARY CHECK ${failed.length ? 'FAIL' : 'OK'} ${results.length - failed.length}/${results.length} PASS`);
}
process.exit(failed.length ? 1 : 0);
