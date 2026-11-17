#!/usr/bin/env node
/**
 * R-6bc8（T-20261117-123812-37f5）团队侧纯逻辑回归（src/session-queue.js）：
 *   ① 四态 fail > skip > ok > none，skipped 优先（ok=true + ALREADY_DELIVERED → skip）；
 *   ② AC2 积压≠失败：queued=3 + 只有 ok/skip 行 → state ∈ {ok,skip}；再补 1 条 ok=false → fail 且 queued 仍为 3；
 *   ③ AC4 未知≠0：known:false / queue===null → queued=null（渲染层显示「—」）；
 *   ④ AC7 兼容字段：deliveredAt ?? deliverAt ?? at / reason ?? why / messageIds[0] ?? messageId；
 *   ⑤ AC6 过期降级：at 10 分钟前 → code=stale；快照缺失 → code=missing 且文案含「未接入」；
 *   ⑥ AC3 背压阈值：3 → 有文案、2/null → 无节点；
 *   ⑦ 窗口：24 小时外的行不计；
 *   ⑧ 快照两种角色形态（roles[] 与 roles{}）都认。
 *
 * 跑法：node scripts/test-sq-panel.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const __dirname = path.dirname(fileURLToPath(import.meta.url));
const SRC = await import(pathToFileURL(path.join(__dirname, '..', 'src', 'session-queue.js')).href);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? '' : String(JSON.stringify(detail)).slice(0, 500) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 500)}`);
  if (!ok) process.exitCode = 1;
}

const now = Date.now();
const iso = (offsetMs) => new Date(now - offsetMs).toISOString();
const row = (patch) => ({ at: iso(30 * 1000), ok: true, ...patch });
const identity = { pm: '项目经理', programmer1: '高级程序员 A', tester: '测试人员', product: '产品设计师', analyst: '需求分析师', programmer2: '高级程序员 B' };

// ① 四态
check('① AC1① {ok:false}（无 skipped）→ fail', SRC.classifyRow(row({ ok: false, reason: 'WAKE_FAILED' })) === 'fail', SRC.classifyRow(row({ ok: false })));
check('① AC1② {ok:true, skipped:\'ALREADY_DELIVERED\'} → skip（不得为 ok）', SRC.classifyRow(row({ ok: true, skipped: 'ALREADY_DELIVERED' })) === 'skip', SRC.classifyRow(row({ ok: true, skipped: 'ALREADY_DELIVERED' })));
check('① AC1③ {ok:true}（无 skipped）→ ok', SRC.classifyRow(row({ ok: true })) === 'ok', SRC.classifyRow(row({ ok: true })));
check('① AC7③ {ok:true, skipped:\'DEBOUNCED\'} → skip', SRC.classifyRow(row({ ok: true, skipped: 'DEBOUNCED' })) === 'skip', SRC.classifyRow(row({ ok: true, skipped: 'DEBOUNCED' })));
check('① 四态优先级 fail > skip > ok：三类行同角色 → fail', SRC.summarizeRows([row({ ok: false }), row({ ok: true, skipped: 'MERGED_PENDING' }), row({ ok: true })], { now }).state === 'fail');

// 同一角色失败/跳过各自独立计数
const mixed = SRC.summarizeRows([row({ ok: false }), row({ ok: false }), row({ ok: true, skipped: 'ALREADY_DELIVERED' }), row({ ok: true })], { now });
check('① AC1 混合：failCount=2 / skipCount=1 / okCount=1 且 state=fail', mixed.failCount === 2 && mixed.skipCount === 1 && mixed.okCount === 1 && mixed.state === 'fail', mixed);

// ② AC2 积压≠失败
const backlog = SRC.buildPanelModel({
  now,
  roles: SRC.SIX_ROLES,
  roleNames: identity,
  snapshot: { at: iso(5 * 1000), roles: [{ role: 'pm', known: true, queued: 3, byPlacement: { queued: 3, steering: 0, context: 0 } }] },
  wakeRows: [row({ to: 'pm', ok: true }), row({ to: 'pm', ok: true, skipped: 'DEBOUNCED' })],
});
const pmRow = backlog.rows.find((item) => item.role === 'pm');
check('② AC2 积压≠失败：queued=3 + 只有 ok/skip → state∈{ok,skip} 且不得 fail', pmRow.queued === 3 && ['ok', 'skip'].includes(pmRow.state), pmRow);
const backlogPlusFail = SRC.buildPanelModel({
  now,
  roles: ['pm'],
  snapshot: { at: iso(5 * 1000), roles: [{ role: 'pm', known: true, queued: 3 }] },
  wakeRows: [row({ to: 'pm', ok: true }), row({ to: 'pm', ok: false })],
});
const pmFail = backlogPlusFail.rows[0];
check('② AC2 追加 1 条 {ok:false} → state=fail 而 queued 仍为 3（数值不被失败态改写）', pmFail.state === 'fail' && pmFail.queued === 3, pmFail);

// ③ AC4 未知≠0
const unknown = SRC.buildPanelModel({
  now,
  roles: ['analyst'],
  snapshot: { at: iso(5 * 1000), roles: [{ role: 'analyst', known: false, queued: null }] },
  wakeRows: [],
});
check('③ AC4 known:false → known=false 且 queued=null（不是 0）', unknown.rows[0].known === false && unknown.rows[0].queued === null, unknown.rows[0]);
const queueNull = SRC.buildPanelModel({
  now,
  roles: ['analyst'],
  snapshot: { at: iso(5 * 1000), roles: [{ role: 'analyst', known: false, queued: null, byPlacement: null }] },
  wakeRows: [],
});
check('③ AC4 queue===null 同口径 → queued=null', queueNull.rows[0].queued === null, queueNull.rows[0]);
const zeroQueued = SRC.buildPanelModel({ now, roles: ['pm'], snapshot: { at: iso(5000), roles: [{ role: 'pm', known: true, queued: 0 }] }, wakeRows: [] });
check('③ 真 0 与未知分开：known:true queued:0 → 0（不是 null）', zeroQueued.rows[0].known === true && zeroQueued.rows[0].queued === 0, zeroQueued.rows[0]);

// ④ AC7 旧行兼容
const legacyAt = iso(20 * 1000);
const legacy = SRC.buildPanelModel({
  now,
  roles: ['programmer2'],
  snapshot: { at: iso(5000), roles: [{ role: 'programmer2', known: true, queued: 1 }] },
  wakeRows: [{ to: 'programmer2', at: legacyAt, ok: true, deliverAt: legacyAt, why: '', messageId: 'M-1' }],
});
check('④ AC7 旧行（deliverAt/why/messageId）→ ok 且 lastOkAt 取 deliverAt', legacy.rows[0].state === 'ok' && legacy.rows[0].lastOkAt === new Date(Date.parse(legacyAt)).toISOString(), legacy.rows[0]);
const newAt = iso(10 * 1000);
const modern = SRC.buildPanelModel({
  now,
  roles: ['tester'],
  snapshot: { at: iso(5000), roles: [{ role: 'tester', known: true, queued: 0 }] },
  wakeRows: [{ to: 'tester', at: iso(60 * 1000), ok: true, deliveredAt: newAt, reason: 'default', messageIds: ['M-2'] }],
});
check('④ 新行优先 deliveredAt（不是 at）', modern.rows[0].lastOkAt === new Date(Date.parse(newAt)).toISOString(), modern.rows[0]);
const noRows = SRC.buildPanelModel({ now, roles: ['product'], snapshot: { at: iso(5000), roles: [{ role: 'product', known: true, queued: 0 }] }, wakeRows: [] });
check('④ AC7① 0 行 → state=none 且 lastOkAt 空（界面「无记录」）', noRows.rows[0].state === 'none' && noRows.rows[0].lastOkAt === '', noRows.rows[0]);

// ⑤ AC6 过期降级 / 缺失
const stale = SRC.degradationOf({ now, staleMs: 120000, snapshot: { at: iso(10 * 60 * 1000), roles: [] } });
check('⑤ AC6 快照 10 分钟前 → degraded 且 code=stale、文案含过期与最近成功读取', stale.degraded === true && stale.code === 'stale' && /过期/.test(stale.text) && /最近成功读取/.test(stale.text), stale);
const fresh = SRC.degradationOf({ now, staleMs: 120000, snapshot: { at: iso(5000), roles: [] } });
check('⑤ 快照新鲜 → 不降级（banner 不显示）', fresh.degraded === false && fresh.code === 'ok', fresh);
const missing = SRC.degradationOf({ now, snapshotError: 'missing', snapshot: null });
check('⑤ 边界·空值：快照不存在 → degraded 且文案含「未接入」（不显示 0）', missing.degraded === true && /未接入/.test(missing.text), missing);
const broken = SRC.degradationOf({ now, snapshotError: 'broken', snapshot: { at: iso(5000) } });
check('⑤ 边界·异常：快照解析失败 → degraded + 沿用上一份（文案含沿用）', broken.degraded === true && /沿用/.test(broken.text), broken);
const badAt = SRC.degradationOf({ now, snapshot: { at: 'not-a-date' } });
check('⑤ 边界·空值：at 非 ISO → 按过期处理', badAt.degraded === true && badAt.code === 'bad-at', badAt);

// ⑥ AC3 背压
check('⑥ AC3 排队=3 → 有提示且文案含「排队 3 条」「先别连发」', SRC.backpressureHint(3).show === true && /排队\s*3\s*条/.test(SRC.backpressureHint(3).text) && /先别连发/.test(SRC.backpressureHint(3).text), SRC.backpressureHint(3));
check('⑥ AC3 排队=2 → 不显示（节点不存在）', SRC.backpressureHint(2).show === false && SRC.backpressureHint(2).text === '', SRC.backpressureHint(2));
check('⑥ 未知（null）→ 不显示背压', SRC.backpressureHint(null).show === false, SRC.backpressureHint(null));

// ⑦ 窗口
const old = SRC.summarizeRows([row({ at: iso(25 * 60 * 60 * 1000), ok: false })], { now, windowMs: 24 * 60 * 60 * 1000 });
check('⑦ 24 小时外的失败行不计（窗口默认 24h）', old.failCount === 0 && old.state === 'none', old);

// ⑧ 快照两种形态 + 坏行计数
const objectForm = SRC.buildPanelModel({
  now,
  roles: ['pm'],
  snapshot: { at: iso(5000), roles: { pm: { known: true, queued: 7, byPlacement: { queued: 7, steering: 1, context: 0 } } } },
  wakeRows: [],
});
check('⑧ 正文 §5.2 的 roles{} 形态也认（queued=7 + byPlacement 保留）', objectForm.rows[0].queued === 7 && objectForm.rows[0].byPlacement.steering === 1, objectForm.rows[0]);
const parsed = SRC.parseWakeLog('{"to":"pm","ok":true}\n\n这不是 JSON\n{"to":"tester","ok":false}\n');
check('⑧ 坏行跳过并计数（badLines=1，不静默丢）', parsed.rows.length === 2 && parsed.badLines === 1, { rows: parsed.rows.length, badLines: parsed.badLines });
const modelFromText = SRC.buildPanelModel({ now, roles: ['pm', 'tester'], snapshot: { at: iso(5000), roles: [] }, wakeText: '{"to":"pm","ok":true}\nbad\n' });
check('⑧ 模型透传 badLines 与角色顺序（六角色固定顺序）', modelFromText.badLines === 1 && modelFromText.rows.map((r) => r.role).join(',') === 'pm,tester', { badLines: modelFromText.badLines, roles: modelFromText.rows.map((r) => r.role) });

const failed = results.filter((item) => !item.ok);
console.log('');
console.log(`SQ_PANEL ${JSON.stringify({ ok: failed.length === 0, total: results.length, failed: failed.length })}`);
