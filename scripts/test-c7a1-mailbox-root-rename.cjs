#!/usr/bin/env node
'use strict';
/**
 * test-c7a1-mailbox-root-rename.cjs —— B-20261116-114813-c7a1 回归夹具
 *
 * 缺陷：邮箱根目录**整体 rename** 不在监听树内产生事件 → watcher 不降级，收件箱面板静默停在旧数字。
 * 修法：未降级态每 30s 一次轻量 `statSync(邮箱根)`（自检可用 AWB_MAILBOX_HEALTH_MS 调小），
 *      根不存在 → 进降级（黄条 + 审计 + fallback）；根回来后 reattach 重建 watcher 并解除降级。
 *
 * 断言：
 *   R1 基线：watcher 启动即非降级，snapshot 能数到 new/ 里的未读，state 暴露 healthCheckMs=30000
 *   R2 根目录 rename → 一个核对周期内降级（degraded=true、reason 含 ROOT_VANISHED），审计 jsonl 落 degraded 行
 *   R3 根目录 rename 回来 → 10s 内解除降级（degraded=false），审计落 recovered 行
 *   R4 恢复后数字补齐：再放一条未读 → 面板 snapshot 的 unread 随事件/重算更新
 *   R5 零轮询边界：只 stat 根目录（不读文件内容），healthChecks 计数随周期增长而 healthCheckMs 固定
 *
 * 用法：node scripts/test-c7a1-mailbox-root-rename.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const WATCH = require(path.join(ROOT, 'src', 'queue-watch.js'));
const SB = path.join(ROOT, '_tmp', `c7a1-${process.pid}`);
const TEAM = path.join(SB, '团队');
const STATE = path.join(SB, '团队', '状态', '项目', 'c7a1沙盘');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); return; }
  fail += 1; console.log(`FAIL  ${name}  ` + JSON.stringify(detail || {}).slice(0, 300)); process.exitCode = 1;
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  const mailRoot = path.join(TEAM, '状态', '邮箱');
  const roleIds = ['pm', 'analyst'];
  for (const role of roleIds) fs.mkdirSync(path.join(mailRoot, role, 'new'), { recursive: true });
  fs.writeFileSync(path.join(mailRoot, 'analyst', 'new', 'm1.json'), JSON.stringify({ id: 'M-1', from: 'pm', to: 'analyst', subject: 's1', body: 'b1', ts: new Date().toISOString() }), 'utf8');
  fs.mkdirSync(STATE, { recursive: true });
  const auditFile = path.join(STATE, '收件箱监听.jsonl');

  const w = WATCH.createMailboxWatcher({
    teamRoot: TEAM, stateDir: STATE, projectName: 'c7a1沙盘', roleIds,
    auditFile, logger: { warn() {}, log() {} }, healthMs: 800, fallbackMs: 500,
  });
  w.start();
  await sleep(120);
  const s1 = w.state();
  const snap1 = w.getSnapshot() || w.recompute('initial');
  ok('R1 基线非降级 + snapshot 数到未读 + state 暴露 healthCheckMs（默认 30s 口径）',
    s1.degraded === false && Number(snap1.totals && snap1.totals.mail) >= 1 && s1.healthCheckMs === 800
    && WATCH.createMailboxWatcher({ teamRoot: TEAM, stateDir: STATE, roleIds, logger: { warn() {} } }).state().healthCheckMs === 30000,
    { degraded: s1.degraded, mail: snap1.totals && snap1.totals.mail, healthCheckMs: s1.healthCheckMs });

  // R2：整根 rename
  const moved = path.join(TEAM, '状态', '邮箱-moved');
  fs.renameSync(mailRoot, moved);
  await sleep(2600); // 3 个核对周期内
  const s2 = w.state();
  const audit = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8') : '';
  ok('R2 根目录整体 rename → 一个核对周期内降级（ROOT_VANISHED）且审计落 degraded 行',
    s2.degraded === true && /ROOT_VANISHED/.test(String(s2.degradedReason)) && /"action":"degraded"/.test(audit),
    { degraded: s2.degraded, reason: s2.degradedReason, auditHasDegraded: /"action":"degraded"/.test(audit) });

  // R3：rename 回来
  fs.renameSync(moved, mailRoot);
  await sleep(2600);
  const s3 = w.state();
  const audit3 = fs.readFileSync(auditFile, 'utf8');
  ok('R3 根目录回来后解除降级 + 审计落 recovered 行',
    s3.degraded === false && /"action":"recovered"/.test(audit3),
    { degraded: s3.degraded, auditHasRecovered: /"action":"recovered"/.test(audit3) });

  // R4：恢复后数字补齐
  fs.writeFileSync(path.join(mailRoot, 'analyst', 'new', 'm2.json'), JSON.stringify({ id: 'M-2', from: 'pm', to: 'analyst', subject: 's2', body: 'b2', ts: new Date().toISOString() }), 'utf8');
  await sleep(600);
  const snap4 = w.recompute('test') || w.getSnapshot();
  ok('R4 恢复后数字补齐（mail ≥ 2）', Number(snap4.totals && snap4.totals.mail) >= 2, { mail: snap4.totals && snap4.totals.mail });

  // R5：核对只 stat、计数随周期增长
  const s5 = w.state();
  ok('R5 恢复后核对继续跑（healthChecks 增长）且间隔口径固定',
    Number(s5.healthChecks) > Number(s1.healthChecks) && s5.healthCheckMs === 800,
    { before: s1.healthChecks, after: s5.healthChecks, ms: s5.healthCheckMs });

  // R6：口径落地要求 ⑤（PM 口径-周期存活探测与轮询边界-20261118 §落地要求）
  // 「只 stat、不读内容」必须在自检里断言：探测函数体内不得出现 readFile/readdir/readFileSync/readdirSync。
  const qwSrc = fs.readFileSync(path.join(ROOT, 'src', 'queue-watch.js'), 'utf8');
  const fnBody = (() => {
    const i = qwSrc.indexOf('const scheduleHealthCheck');
    if (i < 0) return '';
    const j = qwSrc.indexOf('const start = () =>', i);
    return j > i ? qwSrc.slice(i, j) : qwSrc.slice(i, i + 2000);
  })();
  ok('R6 探测函数「只 stat 不读内容」（无 readFile/readdir）+ 默认间隔 30000 + stop 清 timer',
    fnBody.includes('fs.statSync') && !/readFile|readdir/.test(fnBody)
    && /DEFAULT_HEALTH_MS = 30000/.test(qwSrc) && /clearTimeout\(timers\.health\)/.test(qwSrc)
    && /healthCheckMs: healthMs/.test(qwSrc) && /healthChecks,/.test(qwSrc),
    { hasStat: fnBody.includes('fs.statSync'), reads: /readFile|readdir/.test(fnBody) });

  w.stop();
  fs.rmSync(SB, { recursive: true, force: true });
  console.log(`\nC7A1_ROOT_RENAME ${JSON.stringify({ total: pass + fail, pass, fail })}`);
  process.exit(fail ? 1 : 0);
})().catch((e) => { console.error('C7A1_FAILED ' + String((e && e.stack) || e)); process.exit(2); });
