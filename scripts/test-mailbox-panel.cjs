'use strict';
/**
 * R-c4c7（T-20261115-195024-5369）· 团队收件箱实时面板自检（纯 Node，不启动 Electron）
 *
 * 覆盖：
 *   S* 快照口径（计数/最新 3 条/队列 pending/坏 JSON/目录缺失/不读 body/名册行集合）
 *   W* 零轮询与实时性（fs.watch 事件驱动；3 次写入 ≥1s 间隔 → changed ≥3；每次 ≤2s）
 *   Z* 只读（邮箱文件清单前后不变；唯一新增写是 收件箱监听.jsonl）
 *   D* 降级与恢复（目录被 rename → 降级 + 审计；恢复 → 数据补齐 + recovered 审计 + 后续事件来源=watch）
 *   G* 静态断言（新代码 setInterval=0；渲染层无「排队消息/待办队列」字样）
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const QW = require(path.join(ROOT, 'src', 'queue-watch.js'));
const SB = path.join(ROOT, '_tmp', 'mailbox-panel-test');

let pass = 0;
let fail = 0;
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); }
  else { fail += 1; console.log(`FAIL  ${name}  ${JSON.stringify(detail).slice(0, 400)}`); process.exitCode = 1; }
}
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const shaList = (names) => JSON.stringify(names.slice().sort());

fs.rmSync(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
const TEAM = path.join(SB, '团队');
const STATE = path.join(TEAM, '状态', '项目', 'demo');
const AUDIT = path.join(STATE, '收件箱监听.jsonl');
for (const role of QW.ROLE_IDS) {
  fs.mkdirSync(path.join(TEAM, '状态', '邮箱', role, 'new'), { recursive: true });
  fs.mkdirSync(path.join(TEAM, '状态', '邮箱', role, 'cur'), { recursive: true });
}
fs.mkdirSync(STATE, { recursive: true });
const writeTeam = (roles) => fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify({ members: roles.map((role) => ({ role, name: role.toUpperCase(), status: 'active' })) }, null, 2), 'utf8');
writeTeam(QW.ROLE_IDS);

const mailFile = (role, index, data = {}) => {
  const stamp = `2026-11-16T00-00-${String(index).padStart(2, '0')}-000Z`;
  return path.join(TEAM, '状态', '邮箱', role, 'new', `${stamp}-m${index}.json`);
};
const writeMail = (role, index, data = {}) => {
  const file = mailFile(role, index);
  fs.writeFileSync(file, JSON.stringify({ id: 'M-' + index, from: 'pm', to: role, subject: '主题' + index, body: 'BODY-SHOULD-NOT-APPEAR', ts: `2026-11-16T00:00:${String(index).padStart(2, '0')}.000Z`, ...data }), 'utf8');
  return file;
};
writeMail('pm', 1); writeMail('pm', 2); writeMail('pm', 3); writeMail('pm', 4);
writeMail('analyst', 5);
// 坏 JSON：必须只跳过并计数
fs.writeFileSync(mailFile('tester', 6), '{ broken json', 'utf8');
// role_queues.json：analyst 2 条 pending（其中一条 done 不算），tester 1 条
fs.writeFileSync(path.join(STATE, 'role_queues.json'), JSON.stringify({
  generatedAt: '2026-11-16T00:00:00.000Z',
  roles: {
    analyst: { queue: [
      { taskId: 'R-a', action: 'rework', priority: 'P1', status: 'pending', createdAt: '2026-11-16T00:00:01.000Z' },
      { taskId: 'R-b', action: 'develop', priority: 'P2', status: 'pending', createdAt: '2026-11-16T00:00:03.000Z' },
      { taskId: 'R-c', action: 'test', priority: 'P3', status: 'done', createdAt: '2026-11-16T00:00:02.000Z' },
    ] },
    tester: { queue: [{ taskId: 'R-t', action: 'test', priority: 'P1', status: 'pending', createdAt: '2026-11-16T00:00:04.000Z' }] },
  },
}, null, 2), 'utf8');

// ── S：快照口径 ──────────────────────────────────────────────────────────
const snap = QW.buildSnapshot({ teamRoot: TEAM, stateDir: STATE, projectName: 'demo' });
ok('S1 六角色六行、行顺序稳定', Object.keys(snap.roles).join(',') === QW.ROLE_IDS.join(','), Object.keys(snap.roles));
ok('S2 pm 邮件 4 条，最新 3 条按文件名时间戳倒序', snap.roles.pm.mailNew === 4 && snap.roles.pm.mailLatest.length === 3 && snap.roles.pm.mailLatest[0].file.includes('00-00-04'), snap.roles.pm.mailLatest.map((m) => m.file));
ok('S3 最新 3 条只有 at/from/subject（**不含 body**）', snap.roles.pm.mailLatest.every((row) => !('body' in row)) && !JSON.stringify(snap).includes('BODY-SHOULD-NOT-APPEAR'), Object.keys(snap.roles.pm.mailLatest[0]));
ok('S4 队列 pending 计数正确（analyst=2，done 不算）', snap.roles.analyst.queuePending === 2, snap.roles.analyst.queuePending);
ok('S5 队列最新 3 条按 createdAt 倒序', snap.roles.analyst.queueLatest[0].taskId === 'R-b', snap.roles.analyst.queueLatest.map((q) => q.taskId));
ok('S6 坏 JSON 只跳过并计数（tester parseErrors=1，计数不受影响）', snap.roles.tester.parseErrors === 1 && snap.roles.tester.mailNew === 1, { parseErrors: snap.roles.tester.parseErrors, mailNew: snap.roles.tester.mailNew });
ok('S7 目录缺失 → 该行 dirMissing=true 且不整体失败', (() => {
  fs.rmSync(path.join(TEAM, '状态', '邮箱', 'programmer1', 'new'), { recursive: true, force: true });
  const s2 = QW.buildSnapshot({ teamRoot: TEAM, stateDir: STATE, projectName: 'demo' });
  return s2.roles.programmer1.dirMissing === true && s2.roles.programmer1.mailNew === 0 && Boolean(s2.roles.pm);
})(), {});
ok('S8 总积压 = 邮件 + 队列 pending', (() => {
  const sumMail = Object.values(snap.roles).reduce((acc, row) => acc + row.mailNew, 0);
  const sumQueue = Object.values(snap.roles).reduce((acc, row) => acc + row.queuePending, 0);
  return snap.totals.mail === sumMail && snap.totals.queue === sumQueue && snap.total === sumMail + sumQueue;
})(), snap.totals);
ok('S9 最堵角色 = pm（积压 4）', Boolean(snap.busiestRole) && snap.busiestRole.roleId === 'pm' && snap.busiestRole.count === 4, snap.busiestRole);
// fast 模式四角色：只出现名册里的四行
writeTeam(['pm', 'analyst', 'programmer1', 'tester']);
ok('S10 行集合按 团队.json 名册（fast 四角色只四行）', QW.roleIdsFromTeam(TEAM).join(',') === 'pm,analyst,programmer1,tester', QW.roleIdsFromTeam(TEAM));
writeTeam(QW.ROLE_IDS);
// 恢复 programmer1/new（后面 watch 测试要用）
fs.mkdirSync(path.join(TEAM, '状态', '邮箱', 'programmer1', 'new'), { recursive: true });

// ── W/Z/D：watcher（异步） ─────────────────────────────────────────────
(async () => {
  const events = [];
  const watcher = QW.createMailboxWatcher({
    teamRoot: TEAM, stateDir: STATE, projectName: 'demo', auditFile: AUDIT,
    fallbackMs: 1200, logger: { warn: () => {} },
  });
  watcher.subscribe((s) => events.push({ at: Date.now(), total: s.total, source: s.source, degraded: s.degraded }));
  watcher.start();
  await sleep(150);

  const newBefore = fs.readdirSync(path.join(TEAM, '状态', '邮箱', 'pm', 'new'));
  const curBefore = fs.readdirSync(path.join(TEAM, '状态', '邮箱', 'pm', 'cur'));

  // AC3 实时性：3 次写入，两两间隔 ≥1000ms、不同文件名、每次写完等 200ms
  const latencies = [];
  const totalsAfter = [];
  for (let i = 1; i <= 3; i += 1) {
    const before = events.length;
    const t0 = Date.now();
    writeMail('programmer2', 10 + i);
    await sleep(200);
    for (let wait = 0; wait < 40 && events.length === before; wait += 1) await sleep(50);
    if (events.length > before) {
      latencies.push(Date.now() - t0);
      totalsAfter.push(events[events.length - 1].total);
    }
    await sleep(1000); // 与下一次写入至少间隔 1s（共 ≥1000ms）
  }
  ok('W1 三次写入各产生一次推送（≥3）', latencies.length === 3, { events: events.length, latencies });
  ok('W2 每次推送延迟 ≤2000ms（实测见日志）', latencies.every((ms) => ms <= 2000), latencies);
  ok('W3 数字随写入增长（+1/+2/+3）', totalsAfter.length === 3 && totalsAfter[0] === events[0].total + 1 && totalsAfter[2] === totalsAfter[0] + 2, { totalsAfter, base: events[0].total });
  ok('W4 事件来源标记为 watch（不是兜底）', events.filter((e) => e.source === 'watch').length >= 3, events.map((e) => e.source));

  // AC7 只读：邮箱文件清单不变；除审计外无新增写
  const newAfter = fs.readdirSync(path.join(TEAM, '状态', '邮箱', 'pm', 'new'));
  const curAfter = fs.readdirSync(path.join(TEAM, '状态', '邮箱', 'pm', 'cur'));
  ok('Z1 只读：pm/new 清单前后一致（面板没有动邮箱）', shaList(newBefore) === shaList(newAfter), { before: newBefore, after: newAfter });
  ok('Z2 只读：pm/cur 清单前后一致', shaList(curBefore) === shaList(curAfter), { before: curBefore, after: curAfter });
  const stateFiles = fs.readdirSync(STATE).filter((name) => name !== 'role_queues.json');
  ok('Z3 项目状态目录只有审计文件被写（收件箱监听.jsonl）', stateFiles.every((name) => name === '收件箱监听.jsonl'), stateFiles);

  // AC6 降级：把 analyst/new rename 掉 → ≤30s 出现 degraded + 审计；离线期间新增邮件；恢复后数据补齐
  const analystNew = path.join(TEAM, '状态', '邮箱', 'analyst', 'new');
  const degStart = Date.now();
  fs.renameSync(analystNew, analystNew + '-gone');
  // 离线期间到达的邮件写进「被移走的目录」里（原路径已不存在，必须写改名后的目录）
  const offlineName = path.basename(mailFile('analyst', 30));
  const offlineMail = path.join(analystNew + '-gone', offlineName);
  fs.writeFileSync(offlineMail, JSON.stringify({ id: 'M-offline', from: 'pm', to: 'analyst', subject: '离线期间到达', ts: '2026-11-16T00:00:30.000Z' }), 'utf8');
  let degradedAt = 0;
  for (let wait = 0; wait < 300; wait += 1) {
    if (watcher.getSnapshot().degraded) { degradedAt = Date.now(); break; }
    await sleep(50);
  }
  ok('D1 目录被 rename 后 ≤30s 进入降级', degradedAt > 0 && (degradedAt - degStart) <= 30000, { ms: degradedAt ? degradedAt - degStart : -1 });
  ok('D2 降级态带次数与原因', Boolean(watcher.getSnapshot().degradedCount >= 1) && /DIR_VANISHED/.test(String(watcher.getSnapshot().degradedReason)), { count: watcher.getSnapshot().degradedCount, reason: watcher.getSnapshot().degradedReason });
  // 恢复
  fs.renameSync(analystNew + '-gone', analystNew);
  let recoveredAt = 0;
  for (let wait = 0; wait < 300; wait += 1) {
    if (!watcher.getSnapshot().degraded) { recoveredAt = Date.now(); break; }
    await sleep(50);
  }
  ok('D3 目录恢复后 ≤30s 退出降级', recoveredAt > 0 && (recoveredAt - degStart) <= 30000, { ms: recoveredAt ? recoveredAt - degStart : -1 });
  ok('D4 恢复后数据补齐（离线期间那封邮件被算进去）', fs.existsSync(path.join(analystNew, offlineName)) && watcher.getSnapshot().roles.analyst.mailNew === 2, { mailNew: watcher.getSnapshot().roles.analyst.mailNew, file: offlineName });

  // 恢复后：真实文件事件必须是 watch 来源（不是兜底轮询）
  await sleep(300);
  const beforeSource = events.length;
  writeMail('programmer1', 40);
  let watchAfterRecover = '';
  for (let wait = 0; wait < 200; wait += 1) {
    const last = events[events.length - 1];
    if (events.length > beforeSource && last && last.source === 'watch') { watchAfterRecover = 'watch'; break; }
    await sleep(50);
  }
  ok('D5 恢复后 10 秒内收到的事件来源=watch（watcher 已重建，不是永久兜底）', watchAfterRecover === 'watch', events.slice(-3));

  const auditRows = fs.existsSync(AUDIT) ? fs.readFileSync(AUDIT, 'utf8').trim().split(/\n/).filter(Boolean).map((line) => JSON.parse(line)) : [];
  ok('D6 审计写 degraded + recovered 两行，字段 {at,action,reason,backlog}', auditRows.some((row) => row.action === 'degraded') && auditRows.some((row) => row.action === 'recovered') && ['at', 'action', 'reason', 'backlog'].every((key) => key in auditRows[0]), auditRows);

  watcher.stop();

  // ── G：静态断言 ──────────────────────────────────────────────────────
  const files = ['src/queue-watch.js', 'src/renderer/mailbox-panel.js'];
  const intervalHits = [];
  for (const rel of files) {
    const text = fs.readFileSync(path.join(ROOT, rel), 'utf8');
    if (/setInterval\s*\(/.test(text)) intervalHits.push(rel);
  }
  ok('G1 新代码里 setInterval 0 命中（零轮询静态证据）', intervalHits.length === 0, intervalHits);
  const renderer = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'mailbox-panel.js'), 'utf8');
  ok('G2 渲染层不含「排队消息」「待办队列」字样（口径不冒充）', !/排队消息/.test(renderer) && !/待办队列/.test(renderer), {});
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const mailboxBlock = mainSrc.slice(mainSrc.indexOf("ipcMain.handle('mailbox:snapshot'"), mainSrc.indexOf("ipcMain.handle('mailbox:state'"));
  ok('G3 主进程侧 mailbox 段落不含 setInterval', !/setInterval\s*\(/.test(mailboxBlock), {});
  ok('G4 不写邮箱：mailbox 相关代码无 fs.write/append 到 邮箱 路径，也无 ack/read 调用', !/邮箱[^\n]*(writeFileSync|appendFileSync|renameSync|unlinkSync)/.test(mailboxBlock) && !/inboxAck|mailboxAck|teamAck/.test(mailboxBlock), {});

  console.log(`\nR-c4c7 面板断言：${pass} 通过 / ${fail} 失败`);
  console.log(`    实时延迟(ms)=${latencies.join(',')} ｜ 降级耗时=${degradedAt ? degradedAt - degStart : -1}ms ｜ 恢复耗时=${recoveredAt ? recoveredAt - degStart : -1}ms`);
  const evidDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-c4c7');
  fs.mkdirSync(evidDir, { recursive: true });
  fs.writeFileSync(path.join(evidDir, 'run-c4c7.log'), [
    `pass=${pass} fail=${fail} exit=${process.exitCode || 0}`,
    `latencyMs=${latencies.join(',')}`,
    `degradeMs=${degradedAt ? degradedAt - degStart : -1} recoverMs=${recoveredAt ? recoveredAt - degStart : -1}`,
    `events=${events.length}`,
  ].join('\n') + '\n', 'utf8');
})();
