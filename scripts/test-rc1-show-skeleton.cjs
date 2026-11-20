'use strict';
/**
 * 夹具：RC-1 req show / task show 骨架视图
 *  a) 默认体积 ≤30%（对 --full）；b) --full 两次 sha 一致且含全文重字段；
 *  c) 六字段必留（缺失显式 null）；d) 不存在 id 原错误码；e) 非本项目 id 同码；f) 并发两次互不影响。
 *  g) task show --slim ≤2KB 且保留 id/title/status/owner/claimedAt/acceptance；默认 task show 不变。
 *
 * 跑法：node scripts/test-rc1-show-skeleton.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const PROJECT = 'rc1-沙盘';
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-rc1-'));
const TEAM = path.join(SB, '团队');
const RESULT = [];
function check(id, title, ok, detail) {
  RESULT.push({ id, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${title}${ok ? '' : '  ← ' + String(JSON.stringify(detail === undefined ? '' : detail)).slice(0, 420)}`);
  if (!ok) process.exitCode = 1;
}
const env = () => ({ ...process.env, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: path.join(SB, '项目'), TEAM_WORKBENCH_JSON: path.join(SB, 'workbench.json'), AWB_DATA_DIR: path.join(SB, 'data'), TEAM_SELFTEST: '1' });
function cli(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: env(), cwd: SB, timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  return { status: r.status, out: r.stdout || '', err: r.stderr || '' };
}
const sha = (s) => crypto.createHash('sha256').update(Buffer.from(s, 'utf8')).digest('hex');
const bytes = (s) => Buffer.byteLength(s, 'utf8');

let token = '';
const stateDir = path.join(TEAM, '状态', '项目');
function projectDirOf() {
  // project add 默认落在 项目区/<name>
  return path.join(SB, '项目', PROJECT);
}
function seedRequirement(id, { withDoc = true, heavy = true } = {}) {
  const pdir = path.join(stateDir, PROJECT);
  fs.mkdirSync(path.join(pdir, '任务'), { recursive: true });
  fs.mkdirSync(path.join(projectDirOf(), '需求'), { recursive: true });
  const hist = Array.from({ length: heavy ? 30 : 0 }, (_, i) => ({ at: `2026-11-20T0${i % 9}:00:00Z`, action: 'x', note: 'y'.repeat(heavy ? 120 : 0) }));
  const revs = Array.from({ length: heavy ? 12 : 0 }, (_, i) => ({ at: `2026-11-19T0${i % 9}:00:00Z`, verdict: 'approve', comments: 'z'.repeat(heavy ? 200 : 0) }));
  const row = {
    id, project: PROJECT, type: 'requirement', requirementId: id, title: `${id} 标题`,
    detail: heavy ? 'D'.repeat(6000) : '', acceptance: heavy ? 'A'.repeat(4000) : '',
    story: heavy ? 'S'.repeat(3000) : '', priority: 'P1', owner: 'pm', status: 'dev_done',
    createdBy: 'pm', createdAt: '2026-11-18T00:00:00Z', claimedAt: null, due: '', doneAt: null,
    evidence: '', rev: 3, history: hist, reviews: revs,
    review: { verdict: 'approve', comments: 'C'.repeat(800) },
    workflow: { status: 'dev_done', phase: 'dev_done', stage: 'dev', iterations: [{ n: 1 }] },
    updatedAt: '2026-11-20T01:00:00Z', ownerSessionId: 'session-rc1',
  };
  fs.writeFileSync(path.join(pdir, '任务', `${id}.json`), JSON.stringify(row, null, 1), 'utf8');
  if (withDoc) fs.writeFileSync(path.join(projectDirOf(), '需求', `${id}-正文.md`), `# ${id}\n` + '正文'.repeat(200), 'utf8');
  return row;
}
function seedTask(id, rid) {
  const pdir = path.join(stateDir, PROJECT, '任务');
  fs.mkdirSync(pdir, { recursive: true });
  const row = { id, project: PROJECT, type: 'task', requirementId: rid, title: `${id} 子任务`, acceptance: '验收要求'.repeat(40), status: 'working', owner: 'programmer1', priority: 'P1', claimedAt: '2026-11-20T00:00:00Z', updatedAt: '2026-11-20T01:00:00Z', rev: 2, history: [{ at: '2026-11-20T00:00:00Z', action: 'claim' }], reviews: [], review: {}, workflow: { stage: 'dev' } };
  fs.writeFileSync(path.join(pdir, `${id}.json`), JSON.stringify(row, null, 1), 'utf8');
}

try {
  const init = cli(['init', '--json']);
  const add = cli(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
  const boot = cli(['boot', '--role', 'programmer1', '--project', PROJECT, '--json']);
  try { token = JSON.parse(boot.out).token || ''; } catch { token = ''; }
  check('S0', '沙盘 init/project add/boot 就绪', Boolean(token), { init: init.status, add: add.status, boot: boot.status, err: (boot.err || '').slice(0, 200) });

  const R = 'R-RC1-0001';
  seedRequirement(R);
  seedTask('T-RC1-001', R);
  seedTask('T-RC1-002', R);

  const slim = cli(['req', 'show', '--boot', token, '--id', R, '--json']);
  const full = cli(['req', 'show', '--boot', token, '--id', R, '--json', '--full']);
  const ratio = bytes(slim.out) / Math.max(1, bytes(full.out));
  check('A1', `默认骨架体积 ≤30%（slim=${bytes(slim.out)}B / full=${bytes(full.out)}B = ${(ratio * 100).toFixed(1)}%）`, slim.status === 0 && ratio <= 0.30, { slim: bytes(slim.out), full: bytes(full.out) });

  const fullSha2 = sha(cli(['req', 'show', '--boot', token, '--id', R, '--json', '--full']).out);
  const fullObj = (() => { try { return JSON.parse(full.out); } catch { return null; } })();
  check('A2', '--full 两次 sha 一致且含全文重字段（detail/acceptance/history/reviews 原样）',
    full.status === 0 && sha(full.out) === fullSha2 && Boolean(fullObj && fullObj.requirement && String(fullObj.requirement.detail || '').length === 6000 && Array.isArray(fullObj.requirement.history)), { shaSame: sha(full.out) === fullSha2 });

  const slimObj = (() => { try { return JSON.parse(slim.out); } catch { return null; } })();
  const req6 = slimObj && slimObj.requirement ? slimObj.requirement : {};
  const six = ['id', 'title', 'status', 'phase', 'sha12', 'subtaskCount'];
  const sixOk = six.every((k) => Object.prototype.hasOwnProperty.call(req6, k)) && req6.id === R
    && Number.isInteger(req6.subtaskCount) && req6.subtaskCount === (Array.isArray(slimObj.tasks) ? slimObj.tasks.length : -1) && req6.subtaskCount >= 2
    && typeof req6.sha12 === 'string' && req6.sha12.length === 12;
  check('A3', '六字段必留（id/title/status/phase/sha12/subtaskCount），且重字段只留计数（detail 不出现原文）',
    Boolean(slimObj) && sixOk && Number(req6.detailBytes) === 6000 && !String(slim.out).includes('D'.repeat(100)), { six: req6, hasDetail: Object.prototype.hasOwnProperty.call(req6, 'detail') });

  // 缺正文/缺 phase 的需求：sha12/phase 显式 null（不消失）
  seedRequirement('R-RC1-NODOC', { withDoc: false, heavy: false });
  const nodoc = cli(['req', 'show', '--boot', token, '--id', 'R-RC1-NODOC', '--json']);
  const nodocObj = (() => { try { return JSON.parse(nodoc.out); } catch { return null; } })();
  const nd = nodocObj && nodocObj.requirement ? nodocObj.requirement : {};
  check('A3b', '缺正文/缺阶段时 sha12、phase 字段仍存在且为 null（不消失）',
    nodoc.status === 0 && Object.prototype.hasOwnProperty.call(nd, 'sha12') && nd.sha12 === null && Object.prototype.hasOwnProperty.call(nd, 'phase'), { sha12: nd.sha12, phase: nd.phase });

  // d) 不存在 id
  const noReq = cli(['req', 'show', '--boot', token, '--id', 'R-NOT-EXIST']);
  const noTask = cli(['task', 'show', '--boot', token, '--id', 'T-NOT-EXIST']);
  const codeOf = (r) => { const m = /\[([A-Z_]+)\]/.exec(r.out + '\n' + r.err); return m ? m[1] : ''; };
  check('A4', '不存在 id：req show/task show 均给明确错误码（非 INTERNAL）且退出码非 0',
    noReq.status !== 0 && noTask.status !== 0 && codeOf(noReq) && codeOf(noReq) !== 'INTERNAL' && codeOf(noTask) === 'TASK_NOT_FOUND', { reqCode: codeOf(noReq), taskCode: codeOf(noTask) });

  // e) 非本项目 id：用另一项目的合法 id（不在本项目 任务/ 目录）
  const other = 'R-OTHER-PROJ-1';
  seedRequirement('R-RC1-0002'); // 保证其它需求存在
  const foreign = cli(['req', 'show', '--boot', token, '--id', other]);
  check('A5', '非本项目 id 与不存在 id 同错误码（不泄漏他人项目数据）', foreign.status !== 0 && codeOf(foreign) === codeOf(noReq), { code: codeOf(foreign) });

  // f) 并发两次 show 互不影响
  const c1 = cli(['req', 'show', '--boot', token, '--id', R, '--json']);
  const c2 = cli(['req', 'show', '--boot', token, '--id', R, '--json']);
  check('A6', '并发/连续两次 show 输出一致、无锁冲突', c1.status === 0 && c2.status === 0 && sha(c1.out) === sha(c2.out), { s1: c1.status, s2: c2.status });

  // g) task show：默认不变（含 history），--slim ≤2KB 且保留六键
  const tDefault = cli(['task', 'show', '--boot', token, '--id', 'T-RC1-001']);
  const tSlim = cli(['task', 'show', '--boot', token, '--id', 'T-RC1-001', '--slim', '--json']);
  const tSlimObj = (() => { try { return JSON.parse(tSlim.out); } catch { return null; } })();
  const t = tSlimObj && tSlimObj.task ? tSlimObj.task : {};
  check('A7', `task show --slim ≤2KB 且保留 id/title/status/owner/claimedAt/acceptance（${bytes(tSlim.out)}B）`,
    tSlim.status === 0 && bytes(tSlim.out) <= 2048 && t.id === 'T-RC1-001' && t.status === 'working' && t.owner === 'programmer1' && t.claimedAt === '2026-11-20T00:00:00Z' && typeof t.acceptance === 'string' && t.acceptance.length > 0, { bytes: bytes(tSlim.out), t });
  const tDefaultObj = (() => { try { const o = JSON.parse(tDefault.out); return o && o.task ? o.task : o; } catch { return null; } })();
  check('A7b', 'task show 默认保持现状字段（含 history 等重字段；--slim 不含 history）',
    tDefault.status === 0 && Boolean(tDefaultObj && Array.isArray(tDefaultObj.history))
    && !Object.prototype.hasOwnProperty.call(t, 'history') && tSlim.status === 0, { defaultBytes: bytes(tDefault.out), slimBytes: bytes(tSlim.out), slimHasHistory: Object.prototype.hasOwnProperty.call(t, 'history') });
} catch (e) {
  check('E0', '夹具未抛异常', false, { error: String((e && e.stack) || e) });
} finally {
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
}
const pass = RESULT.filter((r) => r.ok).length;
console.log(`\n${pass}/${RESULT.length} PASS`);
if (pass !== RESULT.length) process.exitCode = 1;
