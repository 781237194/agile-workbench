#!/usr/bin/env node
'use strict';
/**
 * test-c114a5-route-wake-off.cjs — Owner 2026-11-20 决定：看板路由唤醒默认关闭（保留实现，调用点短路）
 *
 * 三向：
 *   ①默认（TEAM_ROUTE_WAKE 未设）= 静默：wakeRoute 直接短路、路由守护.jsonl 记 skip(route_wake_disabled)、唤醒.jsonl 不新增 route 行；
 *   ②显式 TEAM_ROUTE_WAKE=on = 行为恢复：wakeRoute 走原逻辑（沙盘下 deliverRouteWake 返回 SELFTEST，落 wake 行）；
 *   ③派单/回执的事件唤醒不受影响：PM send --ack --task 仍会写 唤醒.jsonl（走 ops.cmdSend → wakeSessionForMessage，与开关无关）；
 * 另：开关判据 routeWakeEnabled() 的取值矩阵 + 真实 团队.json/workbench.json sha 不变。
 *
 * 用法：node scripts/test-c114a5-route-wake-off.cjs [--json]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const DAEMON_SRC = path.join(ROOT, '团队', '工具', 'lib', 'route-daemon.mjs');
const JSON_OUT = process.argv.includes('--json');
const PROJECT = 'c114a5沙盘';
const ROLES = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];

const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 800)}`);
  return Boolean(ok);
}
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '(missing)'; } };
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8').replace(/^\uFEFF/, '')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
const jsonl = (f) => { try { return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean); } catch { return []; } };

const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'c114a5-'));
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const STORE = path.join(SB, 'workbench.json');
const DATA = path.join(SB, 'data');
const STATE = path.join(TEAM, '状态', '项目', PROJECT);
const WAKE_LOG = path.join(STATE, '唤醒.jsonl');
const ROUTE_LOG = path.join(STATE, '路由守护.jsonl');
const REAL_TEAM = path.join(ROOT, '团队', '状态', '团队.json');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');

function baseEnv(extra = {}) {
  const copy = { ...process.env };
  delete copy.TEAM_ROUTE_WAKE;
  delete copy.AWB_TEAM_ROOT;
  delete copy.DSH_SESSION_ID;
  delete copy.DSH_WEB_URL;
  return { ...copy, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_WORKBENCH_JSON: STORE, AWB_DATA_DIR: DATA, AWB_STORE: STORE, TEAM_SELFTEST: '1', ...extra };
}
function run(args, extra = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: baseEnv(extra), cwd: SB, timeout: 180000, maxBuffer: 32 * 1024 * 1024 });
  return { code: r.status == null ? 1 : r.status, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function runJson(args, extra = {}) {
  const r = run(args, extra);
  const t = String(r.out || '').trim();
  const i = t.indexOf('{');
  let json = null;
  if (i >= 0) { try { json = JSON.parse(t.slice(i)); } catch { json = null; } }
  return { ...r, json };
}
const text = (r) => `${r.out || ''}${r.err || ''}`;
const codeOf = (r) => String((r.json && r.json.code) || '');
const tokenOf = (r) => String(((r.json || {}).token) || '');

async function main() {
  let exitCode = 0;
  const realBefore = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
  try {
    for (const k of ['TEAM_ROUTE_WAKE', 'AWB_TEAM_ROOT', 'DSH_SESSION_ID', 'DSH_WEB_URL']) delete process.env[k];
    Object.assign(process.env, baseEnv());
    check('S0 沙盘 init', run(['init']).code === 0, {});
    check('S1 沙盘建项目', run(['project', 'add', '--name', PROJECT, '--team-mode', 'full']).code === 0, {});
    const team = readJson(path.join(TEAM, '状态', '团队.json'), { members: [] });
    team.activeProject = PROJECT;
    team.members = ROLES.map((role) => ({ role, name: role, status: 'active', sessionId: `session-c1-${role}` }));
    writeJson(path.join(TEAM, '状态', '团队.json'), team);
    const projMeta = readJson(path.join(STATE, '项目.json'), {});
    const projDir = String(projMeta.path || path.join(PROJECTS, PROJECT));
    writeJson(path.join(projDir, '团队会话.json'), { project: PROJECT, teamMode: 'full', workspace: projDir, roles: ROLES.map((role) => ({ role, sessionId: `session-c1-${role}` })) });
    writeJson(STORE, { projects: [{ id: 'c1-p1', name: PROJECT, teamName: PROJECT, path: projDir, sessions: Object.fromEntries(ROLES.map((r) => [r, `session-c1-${r}`])), workspace: { path: projDir, sessionIds: ROLES.map((r) => `session-c1-${r}`) } }], activeProjectId: 'c1-p1' });
    const pmTok = tokenOf(runJson(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'session-c1-pm', '--json']));
    const devTok = tokenOf(runJson(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 'session-c1-programmer1', '--json']));
    const prodTok = tokenOf(runJson(['boot', '--role', 'product', '--project', PROJECT, '--session', 'session-c1-product', '--json']));
    check('S2 沙盘 pm/programmer1/product boot 成功', Boolean(pmTok && devTok && prodTok), {});

    const daemon = await import(`file://${DAEMON_SRC.replace(/\\/g, '/')}`);

    /* ── 开关判据取值矩阵 ── */
    check('A1 routeWakeEnabled：默认 false（未设/off/其它）', daemon.routeWakeEnabled({}) === false
      && daemon.routeWakeEnabled({ TEAM_ROUTE_WAKE: 'off' }) === false
      && daemon.routeWakeEnabled({ TEAM_ROUTE_WAKE: '1' }) === false, {});
    check('A2 routeWakeEnabled：TEAM_ROUTE_WAKE=on / ON 才为 true',
      daemon.routeWakeEnabled({ TEAM_ROUTE_WAKE: 'on' }) === true
      && daemon.routeWakeEnabled({ TEAM_ROUTE_WAKE: 'ON' }) === true, {});

    const optOf = (key) => ({
      role: 'programmer1', action: 'fix', requirementId: 'R-c114a5-fixture', taskId: 'B-c114a5-fixture',
      fromStatus: 'working', toStatus: 'done', key, status: { wakes: {} }, windowMs: 24 * 3600 * 1000,
      now: Date.now(), engineUrl: '', source: 'task', triggerChange: 'status:done',
    });

    /* ── ① 默认静默 ── */
    const wakeBefore = jsonl(WAKE_LOG).length;
    const routeBefore = jsonl(ROUTE_LOG).length;
    const r1 = await daemon.wakeRoute(PROJECT, optOf('c114a5-default-1'));
    const routeRows1 = jsonl(ROUTE_LOG).slice(routeBefore);
    const wakeRows1 = jsonl(WAKE_LOG).slice(wakeBefore);
    check('①a 默认：wakeRoute 返回 skipped=route_wake_disabled（未发唤醒）',
      Boolean(r1 && r1.skipped === 'route_wake_disabled'), { r1 });
    check('①b 默认：路由守护.jsonl 记一条 skip(route_wake_disabled)，没有 wake 行',
      routeRows1.some((r) => String(r.event) === 'skip' && String(r.why) === 'route_wake_disabled')
      && !routeRows1.some((r) => String(r.event) === 'wake'), { rows: routeRows1 });
    check('①c 默认：唤醒.jsonl 不新增任何行（看板不再叫醒任何人）',
      wakeRows1.length === 0, { wakeRows: wakeRows1 });

    /* ── ② 显式开启（排障）行为恢复 ── */
    process.env.TEAM_ROUTE_WAKE = 'on';
    const routeBefore2 = jsonl(ROUTE_LOG).length;
    const r2 = await daemon.wakeRoute(PROJECT, optOf('c114a5-on-1'));
    const routeRows2 = jsonl(ROUTE_LOG).slice(routeBefore2);
    check('②a TEAM_ROUTE_WAKE=on：不再短路（wake=true，沙盘下 deliverRouteWake 走 SELFTEST 分支）',
      Boolean(r2 && r2.wake === true), { r2 });
    check('②b TEAM_ROUTE_WAKE=on：路由守护.jsonl 出现 wake 行（行为恢复）',
      routeRows2.some((r) => String(r.event) === 'wake'), { rows: routeRows2 });
    delete process.env.TEAM_ROUTE_WAKE;

    /* ── ③ 派单唤醒不受影响（默认关闭状态下仍要能叫醒人） ── */
    const created = runJson(['task', 'create', '--boot', pmTok, '--title', '派单唤醒夹具任务', '--priority', 'P2', '--type', 'task', '--owner', 'programmer1', '--json']);
    const taskId = String(((created.json || {}).task || {}).id || '');
    check('③a 造出待派单任务', created.code === 0 && Boolean(taskId), { out: text(created).slice(0, 200) });
    const wakeBefore3 = jsonl(WAKE_LOG).length;
    const send = runJson(['send', '--boot', pmTok, '--to', 'programmer1', '--subject', '派单唤醒夹具', '--body', '执行', '--ack', '--task', taskId, '--json']);
    const wakeRows3 = jsonl(WAKE_LOG).slice(wakeBefore3);
    check('③b 派单（send --ack --task）仍写 唤醒.jsonl（ops.cmdSend→wakeSessionForMessage 未受影响）',
      send.code === 0 && wakeRows3.length >= 1, { code: send.code, wakeRows: wakeRows3.slice(0, 2), out: text(send).slice(0, 300) });
    check('③c 该唤醒行不是看板路由行（trigger/source 与 route 无关）',
      wakeRows3.every((r) => !/route/i.test(String(r.source || '')) || String(r.trigger || '') === 'event'),
      { rows: wakeRows3 });

    /* ── ⑤ 反向证据①：需求评审结果通知（走 ops 的 send/wakeWithGuard 另一条通道，与看板唤醒无关） ── */
    // 造一条需求行（评审结果落账的对象），再跑评审；看板唤醒默认关闭期间：
    //  - 若确认有 PM 通知：必须带 唤醒.jsonl 行，且不得出现 route 行；
    //  - 若工具层本就没有「评审结果 → PM」发送点：如实记录为「无通知」并把证据留给壳层路径（由 PM 指认/真窗口补）。
    const reqId = 'R-20261120-999999-c114';
    writeJson(path.join(STATE, '任务', `${reqId}.json`), {
      id: reqId, project: PROJECT, type: 'requirement', requirementId: reqId, title: '反向证据需求',
      detail: '', acceptance: 'AC1', story: '', priority: 'P1', owner: 'product', status: 'open',
      createdBy: 'pm', createdAt: new Date().toISOString(), claimedAt: null, due: '', doneAt: null, evidence: '',
      workflow: { requirementStatus: 'review', round: 1 }, rev: 1, history: [],
    });
    writeJson(path.join(STATE, '工作流.json'), {
      schema: 2, project: PROJECT, phase: 'requirement_review', round: 1, events: [],
      requirements: {
        [reqId]: {
          id: reqId, title: '反向证据需求', status: 'review', round: 1, priority: 'P1',
          productReview: null, ownerReview: null, decisions: [], trq: null,
        },
      },
      boots: {},
    });
    const pmMailDir = path.join(TEAM, '状态', '邮箱', 'pm');
    const pmMailCount = () => {
      let n = 0;
      for (const box of ['new', 'cur']) {
        try { n += fs.readdirSync(path.join(pmMailDir, box)).filter((x) => x.endsWith('.json')).length; } catch { /* 空箱 */ }
      }
      return n;
    };
    const mailBefore = pmMailCount();
    const wakeBeforeReview = jsonl(WAKE_LOG).length;
    const routeBeforeReview = jsonl(ROUTE_LOG).length;
    const review = runJson(['req', 'review', '--boot', prodTok, '--id', reqId, '--verdict', 'approve', '--comments', '空值/异常/权限/并发/降级/模式 均覆盖', '--json']);
    const wakeReview = jsonl(WAKE_LOG).slice(wakeBeforeReview);
    const routeReview = jsonl(ROUTE_LOG).slice(routeBeforeReview);
    const reviewNotified = pmMailCount() > mailBefore;
    if (!JSON_OUT) console.log(`INFO  ⑤ 观察：req review code=${codeOf(review) || '-'} ｜ PM 邮箱新增=${reviewNotified ? 'Y' : 'N'} ｜ 唤醒新增=${wakeReview.length} ｜ 路由新增=${routeReview.length}`);
    check('⑤a 需求评审结果通知：不得混入看板路由唤醒（路由守护.jsonl 无 wake 行）',
      !routeReview.some((r) => String(r.event) === 'wake'), { routeRows: routeReview });
    check('⑤b 需求评审结果：PM 被叫醒（唤醒.jsonl 新增行）且全部来自事件通道（trigger=event）',
      reviewNotified === true && wakeReview.length >= 1 && wakeReview.every((r) => String(r.trigger || '') === 'event'),
      { notified: reviewNotified, wakeRows: wakeReview, reviewCode: codeOf(review) });
    check('⑤c 需求评审结果的 PM 通知走 send 通道（PM 邮箱确有新增），与看板路由无关',
      reviewNotified === true && !routeReview.some((r) => String(r.event) === 'wake'),
      { reviewNotified, routeRows: routeReview.length });

    /* ── ⑥ 反向证据②：Owner 决定通知（runOwnerDecisionNotify → send + wakeWithGuard） ── */
    const wakeBeforeNotify = jsonl(WAKE_LOG).length;
    const notify = runJson(['owner-notify', '--boot', pmTok, '--project', PROJECT, '--requirement', reqId, '--status', 'approved', '--round', '1', '--channel', 'ui', '--json']);
    const wakeNotify = jsonl(WAKE_LOG).slice(wakeBeforeNotify);
    const notifyRes = (notify.json || {}).notify || {};
    check('⑥a Owner 决定通知：PM 被叫醒（唤醒.jsonl 新增 to=pm 行）',
      notify.code === 0 && wakeNotify.some((r) => String(r.to || '') === 'pm' || String(r.role || '') === 'pm'),
      { code: notify.code, wakeRows: wakeNotify, notify: notifyRes, out: text(notify).slice(0, 300) });
    check('⑥b Owner 决定通知的唤醒来自事件通道（trigger=event），不是看板路由',
      wakeNotify.every((r) => String(r.trigger || '') === 'event'), { wakeRows: wakeNotify });
    check('⑥c 该通知同时落 PM 邮箱（send 通道正常）', pmMailCount() > mailBefore, { before: mailBefore, after: pmMailCount() });

    /* ── ④ 保留实现（不删函数）与注释锚点 ── */
    check('④a buildRouteWakeText / deliverRouteWake 仍导出（实现保留）',
      typeof daemon.buildRouteWakeText === 'function' && typeof daemon.deliverRouteWake === 'function', {});
    const src = fs.readFileSync(DAEMON_SRC, 'utf8');
    check('④b route-daemon 注释写死「默认不得开启 / 须 Owner 书面同意并记录决策编号 / 此注释不得删除」',
      /看板路由唤醒默认关闭/.test(src) && /默认不得开启/.test(src) && /书面同意/.test(src) && /此注释不得删除/.test(src), {});
    const flow = fs.readFileSync(path.join(ROOT, '团队', '流程.md'), 'utf8');
    check('④c 团队/流程.md 有 §J 段且含同一约束',
      /J\. 看板路由唤醒默认关闭/.test(flow) && /默认不得开启/.test(flow) && /书面同意并记录决策编号/.test(flow) && /不得删除/.test(flow), {});
  } catch (e) {
    check('夹具未抛异常', false, { error: String((e && e.stack) || e) });
  } finally {
    const realAfter = { team: sha(REAL_TEAM), store: sha(REAL_STORE) };
    check('C 隔离：真实 团队.json / workbench.json 前后 sha256 不变',
      realAfter.team === realBefore.team && realAfter.store === realBefore.store,
      { team: [realBefore.team.slice(0, 12), realAfter.team.slice(0, 12)], store: [realBefore.store.slice(0, 12), realAfter.store.slice(0, 12)] });
    fs.rmSync(SB, { recursive: true, force: true });
    const failed = ROWS.filter((r) => r.ok !== true);
    if (!JSON_OUT) {
      console.log(`\n${ROWS.length - failed.length}/${ROWS.length} PASS${failed.length ? ' · ' + failed.length + ' FAIL' : ''}`);
      if (failed.length) console.log('失败项：' + failed.map((r) => r.name).join(' | '));
    } else {
      console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed.length, failed: failed.map((r) => r.name), rows: ROWS }, null, 2));
    }
    if (failed.length) exitCode = 1;
  }
  process.exit(exitCode);
}
main();
