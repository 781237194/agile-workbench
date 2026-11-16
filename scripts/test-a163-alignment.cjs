'use strict';
/** R-a163 回归：四人对齐（角色卡补充职责 / 模板 version+change 与 AC 四段式 / fast 六状态矩阵 / 字段同构）。 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, '团队', '工具', 'lib');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 260)}`);
  if (!ok) process.exitCode = 1;
}

(async () => {
  const scaffold = await import(pathToFileURL(path.join(LIB, 'scaffold.mjs')).href);
  const daemon = await import(pathToFileURL(path.join(LIB, 'route-daemon.mjs')).href);

  // ① 四角色卡都有「补充职责」，且关键词到位
  const roles = ['pm', 'product', 'analyst', 'programmer1'];
  const cards = Object.fromEntries(roles.map((r) => [r, scaffold.roleCard('沙盘', r, 'fast')]));
  check('① 四角色卡均含「本角色补充职责」段', roles.every((r) => String(cards[r]).includes('本角色补充职责')), roles.filter((r) => !String(cards[r]).includes('本角色补充职责')));
  check('① PM 卡含决策箱 + 代管 + AC 四段式', /决策箱/.test(cards.pm) && /代管/.test(cards.pm) && /AC 四段式/.test(cards.pm), '');
  check('① 分析师卡含 fast 评审执行人 + 四段式', /需求评审执行人/.test(cards.analyst) && /AC 四段式/.test(cards.analyst), '');
  check('① 开发卡含 bug 同权 + 证据', /bug 同权/.test(cards.programmer1) && /证据门/.test(cards.programmer1), '');

  // ② 需求模板：version/change 头 + AC 四段式
  const tpl = scaffold.reqTemplate('沙盘');
  check('② 需求模板带 version 与 change 头', /version: v1/.test(tpl) && /change:/.test(tpl), '');
  check('② 需求模板 AC 为四段式', /这是什么/.test(tpl) && /怎么做/.test(tpl) && /卡在哪/.test(tpl) && /怎么判通过/.test(tpl), '');

  // ③ fast 六状态矩阵：每个状态都能给出 role+action 或明确 gateBlocked（不许空转 undefined）
  const appr = [{ status: 'approved', channel: 'ui', at: '2026-11-15T00:00:00.000Z' }];
  const devTask = { id: 'T-dev', type: 'task', owner: 'programmer1', status: 'done', requirementId: 'R-x', workflow: { round: 1 } };
  const testTask = { id: 'T-test', type: 'task', owner: 'tester', status: 'done', requirementId: 'R-x', workflow: { round: 1 } };
  const rows = {
    open: { id: 'R-x', status: 'open', trq: {} },
    ready: { id: 'R-x', status: 'ready', trq: { verdict: 'testable' }, decisions: appr, deliveryRound: 1 },
    approved: { id: 'R-x', status: 'approved', trq: { verdict: 'testable' }, decisions: appr, deliveryRound: 1 },
    dev: { id: 'R-x', status: 'dev', trq: { verdict: 'testable' }, decisions: appr, deliveryRound: 1 },
    dev_done: { id: 'R-x', status: 'dev_done', trq: { verdict: 'testable' }, decisions: appr, deliveryRound: 1 },
    test_done: { id: 'R-x', status: 'test_done', trq: { verdict: 'testable' }, decisions: appr, deliveryRound: 1 },
  };
  const matrix = [];
  for (const [status, row] of Object.entries(rows)) {
    const p = daemon.planForRow(row, { tasks: [devTask, testTask], projectPath: ROOT, mode: 'fast' });
    const ok = Boolean(p && (p.role || p.action || p.gateBlocked || p.skip));
    matrix.push({ status, out: p });
    check(`③ fast ${status} → 有明确结论（role/action/gateBlocked/skip）`, ok, p);
  }
  // 10 次流转不空转：交替 ready/approved/dev/dev_done/test_done 各 2 次，全部有结论
  const seq = ['ready', 'approved', 'dev', 'dev_done', 'test_done', 'ready', 'approved', 'dev', 'dev_done', 'test_done'];
  const idles = seq.filter((s) => {
    const p = daemon.planForRow(rows[s], { tasks: [devTask, testTask], projectPath: ROOT, mode: 'fast' });
    return !p || (!p.role && !p.action && !p.gateBlocked && !p.skip);
  });
  check('③ 10 次流转空转率 0', idles.length === 0, idles);

  // ④ 派单/需求行字段同构：task create 在 fast/full 产生同一批键
  const SB = path.join(ROOT, '_tmp', 'a163-parity');
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(SB, '项目'), { recursive: true });
  fs.cpSync(path.join(ROOT, '团队'), path.join(SB, '团队'), { recursive: true, filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) });
  const TEAM_TOOL = path.join(SB, '团队', '工具', 'team.mjs');
  const env = { ...process.env, TEAM_ROOT: path.join(SB, '团队'), TEAM_PROJECTS_ROOT: path.join(SB, '项目'), TEAM_SELFTEST: '1' };
  // 每条命令只执行一次（2026-11-17 修：旧写法把同一个 execFileSync 调了两次——用第二次的输出算 index、
  // 却 parse 第一次的输出，导致沙盘里每个命令跑两遍、req/task 各被创建两条；PM M-20261117-014153-c06ae3 批准顺手修）。
  const run = (args) => {
    const out = String(execFileSync(process.execPath, [TEAM_TOOL, ...args], { cwd: SB, env, encoding: 'utf8' })).trim();
    return JSON.parse(out.slice(out.indexOf('{')));
  };
  const mk = (name, mode) => {
    run(['project', 'add', '--name', name, '--team-mode', mode, '--json']);
    const pm = run(['boot', '--role', 'pm', '--project', name, '--session', `s-${mode}`, '--json']);
    // 沙盘补一条 lessons read：否则 req create 会撞 LESSONS_UNREAD（经验教训门禁），后续断言不可达。
    // 这是**级联规避**（沙盘角色从未读过登记册），不是放宽断言——真实环境该门禁仍然生效。
    run(['lessons', 'read', '--boot', pm.token, '--project', name, '--json']);
    const req = run(['req', 'create', '--boot', pm.token, '--project', name, '--title', `${mode} 需求`, '--priority', 'P0', '--acceptance', 'AC1', '--json']).requirement;
    const task = run(['task', 'create', '--boot', pm.token, '--project', name, '--title', `${mode} 任务`, '--priority', 'P0', '--type', 'task', '--owner', 'programmer1', '--requirement', req.id, '--json']).task;
    return { req, task };
  };
  const f = mk('fast同构', 'fast');
  const u = mk('full同构', 'full');
  const taskKeys = (t) => Object.keys(t).filter((k) => !['id', 'project', 'createdAt', 'claimedAt', 'owner', 'title', 'detail'].includes(k)).sort();
  check('④ fast/full 任务字段集合一致', JSON.stringify(taskKeys(f.task)) === JSON.stringify(taskKeys(u.task)), { fast: taskKeys(f.task), full: taskKeys(u.task) });
  const wfRowKeys = (name, id) => {
    // 需求行 schema 以需求任务文件为准（工作流行由后续状态推进生成）。
    const f = path.join(SB, '团队', '状态', '项目', name, '任务', id + '.json');
    const row = JSON.parse(fs.readFileSync(f, 'utf8'));
    return Object.keys(row).filter((k) => !['id', 'project', 'title', 'createdAt', 'claimedAt'].includes(k)).sort();
  };
  check('④ fast/full 需求行 schema 同构', JSON.stringify(wfRowKeys('fast同构', f.req.id)) === JSON.stringify(wfRowKeys('full同构', u.req.id)), { fast: wfRowKeys('fast同构', f.req.id), full: wfRowKeys('full同构', u.req.id) });

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nR-a163 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
  fs.writeFileSync(path.join(ROOT, '_tmp', 'run-a163.json'), JSON.stringify({ passed, failed, results, matrix: matrix.map((m) => ({ status: m.status, out: m.out })) }, null, 2) + '\n', 'utf8');
})();
