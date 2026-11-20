'use strict';
/**
 * 夹具：R-d19e 批① 项目级隔离（T-20261120-041331-1b82）
 * M1 dry-run 报数（不写盘）、消费点核对 7/0；M2 --yes 分桶迁移 + 备份 + 审计；M3 幂等（二次 moved=0）；
 * M4 项目级优先/团队级兜底读（令牌 resolve、邮箱 readAll）；M5 跨项目四类错误码中的 2 类（读 TOKEN_PROJECT_MISMATCH / 写 PROJECT_WRITE_DENIED）。
 * 跑法：node scripts/test-d19e-project-isolation.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-d19e-'));
const TEAM = path.join(SB, '团队');
const STATE = path.join(TEAM, '状态');
const RESULT = [];
function check(id, title, ok, detail) {
  RESULT.push({ id, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${title}${ok ? '' : '  ← ' + String(JSON.stringify(detail === undefined ? '' : detail)).slice(0, 420)}`);
  if (!ok) process.exitCode = 1;
}
const env = () => ({ ...process.env, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: path.join(SB, '项目'), TEAM_WORKBENCH_JSON: path.join(SB, 'workbench.json'), AWB_DATA_DIR: path.join(SB, 'data'), TEAM_SELFTEST: '1', TEAM_EVIDENCE_ENFORCE: '1' });
function cli(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: env(), cwd: SB, timeout: 120000, maxBuffer: 64 * 1024 * 1024 });
  let json = null;
  try { json = JSON.parse(String(r.stdout || '').trim().split(/\r?\n/).filter((l) => l.startsWith('{')).pop() || ''); } catch { json = null; }
  return { status: r.status, out: String(r.stdout || ''), err: String(r.stderr || ''), json };
}
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 1), 'utf8'); };
const seedToken = (dir, token, project, role = 'pm') => writeJson(path.join(dir, `${token}.json`), { token, role, project, sessionId: 'session-x', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 3600000).toISOString() });
const seedMail = (rows) => {
  const dir = path.join(STATE, '邮箱', 'programmer1');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'messages.jsonl'), rows.map((r) => JSON.stringify(r)).join('\n') + '\n', 'utf8');
};
const seedConfirm = (nonce, project) => writeJson(path.join(STATE, 'owner-confirm', `${nonce}.json`), { nonce, project, requirementId: 'R-X', decision: 'approved', action: 'owner.accept', createdAt: new Date().toISOString(), expiresAt: new Date(Date.now() + 600000).toISOString() });

(async () => {
  // seed：三个令牌（A/B/无归属）、三条邮件（A/B/无归属）、两个 owner-confirm
  seedToken(path.join(STATE, '启动'), 'tok-a', '项目A');
  seedToken(path.join(STATE, '启动'), 'tok-b', '项目B');
  seedToken(path.join(STATE, '启动'), 'tok-x', '');
  seedMail([
    { id: 'M-a1', from: 'pm', to: 'programmer1', project: '项目A', subject: 'A1', type: 'note', at: '2026-11-20T00:00:00Z' },
    { id: 'M-b1', from: 'pm', to: 'programmer1', project: '项目B', subject: 'B1', type: 'note', at: '2026-11-20T00:00:00Z' },
    { id: 'M-x1', from: 'pm', to: 'programmer1', project: '', subject: 'X1', type: 'note', at: '2026-11-20T00:00:00Z' },
    { type: 'event', event: 'read', refId: 'M-a1', at: '2026-11-20T00:00:00Z' },
  ]);
  seedConfirm('aaaaaaaaaaaa', '项目A');
  seedConfirm('bbbbbbbbbbbb', '项目B');

  // M1 dry-run
  const dry = cli(['migrate', 'project-isolation', '--dry-run', '--json']);
  const movedStill = fs.existsSync(path.join(STATE, '启动', 'tok-a.json'));
  const d = dry.json || {};
  check('M1', 'dry-run：tokens 移动 2/无归属 1、mail 移动 2/无归属 1、owner-confirm 2、消费点 7/0，且零写盘',
    dry.status === 0 && d.dryRun === true && d.tokens && d.tokens.moved === 2 && d.mail && d.mail.moved === 2 && d.mail.unowned === 1
    && d.ownerConfirm && d.ownerConfirm.moved === 2 && d.consumer && d.consumer.checked === 7 && d.consumer.pending.length === 0 && movedStill, { status: dry.status, d, err: dry.err.slice(0, 200) });

  // M2 --yes
  const apply = cli(['migrate', 'project-isolation', '--yes', '--json']);
  const a = apply.json || {};
  const slugA = '项目A';
  const slugB = '项目B';
  const tokenA = path.join(STATE, '项目', slugA, '启动', 'tok-a.json');
  const tokenB = path.join(STATE, '项目', slugB, '启动', 'tok-b.json');
  const legacyTok = path.join(STATE, '_legacy', '启动', 'tok-x.json');
  const mailA = path.join(STATE, '项目', slugA, '邮箱', 'programmer1', 'messages.jsonl');
  const mailB = path.join(STATE, '项目', slugB, '邮箱', 'programmer1', 'messages.jsonl');
  const legacyMail = path.join(STATE, '_legacy', '邮箱', 'programmer1.jsonl');
  const cfA = path.join(STATE, '项目', slugA, 'owner-confirm', 'aaaaaaaaaaaa.json');
  const audit = path.join(STATE, '项目隔离迁移.jsonl');
  const teamMail = fs.readFileSync(path.join(STATE, '邮箱', 'programmer1', 'messages.jsonl'), 'utf8');
  check('M2', '--yes：令牌按项目落盘、无归属进 _legacy；邮箱分桶（A/B 各 1 条、无归属进 _legacy）；owner-confirm 分项目；备份+审计存在；团队级邮箱只留事件行',
    apply.status === 0 && fs.existsSync(tokenA) && fs.existsSync(tokenB) && fs.existsSync(legacyTok) && fs.existsSync(mailA) && fs.existsSync(mailB) && fs.existsSync(legacyMail) && fs.existsSync(cfA)
    && fs.readFileSync(mailA, 'utf8').includes('M-a1') && fs.readFileSync(mailB, 'utf8').includes('M-b1')
    && fs.readFileSync(legacyMail, 'utf8').includes('M-x1') && teamMail.includes('"type":"event"') && !teamMail.includes('"id":"M-a1"')
    && fs.existsSync(audit) && a.backupDir && fs.existsSync(a.backupDir), { status: apply.status, a, err: apply.err.slice(0, 300) });

  // M3 幂等
  const apply2 = cli(['migrate', 'project-isolation', '--yes', '--json']);
  const a2 = apply2.json || {};
  const linesA = fs.readFileSync(mailA, 'utf8').split(/\r?\n/).filter(Boolean).length;
  check('M3', '二次迁移幂等：moved=0、项目邮箱行数不变、审计追加第二行',
    apply2.status === 0 && a2.tokens && a2.tokens.moved === 0 && a2.mail && a2.mail.moved === 0 && linesA === 1
    && fs.readFileSync(audit, 'utf8').trim().split(/\r?\n/).length >= 2, { a2, linesA });

  // M4 读兜底（模块级，子进程 import）
  const probeScript = `const { pathToFileURL } = require('node:url');
(async () => {
  const store = await import(pathToFileURL(${JSON.stringify(path.join(ROOT, '团队', '工具', 'lib', 'store.mjs'))}).href);
  const mail = await import(pathToFileURL(${JSON.stringify(path.join(ROOT, '团队', '工具', 'lib', 'mail-store.mjs'))}).href);
  const p = store.resolveBootTokenPath('tok-a');
  const rowsA = mail.readAll(${JSON.stringify(path.join(STATE, '邮箱'))}, 'programmer1', { project: '项目A' }).rows.map((r) => r.id);
  const rowsB = mail.readAll(${JSON.stringify(path.join(STATE, '邮箱'))}, 'programmer1', { project: '项目B' }).rows.map((r) => r.id);
  console.log(JSON.stringify({ p: p.replace(/\\\\/g, '/'), rowsA, rowsB }));
})();`;
  const probe = spawnSync(process.execPath, ['-e', probeScript], { encoding: 'utf8', env: env(), cwd: SB });
  let pr = null;
  try { pr = JSON.parse(probe.stdout.trim().split(/\r?\n/).pop()); } catch { pr = null; }
  check('M4', '项目级优先/团队级兜底读：resolveBootTokenPath 命中项目令牌；readAll(project) 只读到本项目消息',
    Boolean(pr) && pr.p.includes(`项目/项目A/启动/tok-a.json`) && pr.rowsA.length === 1 && pr.rowsA[0] === 'M-a1' && pr.rowsB.length === 1 && pr.rowsB[0] === 'M-b1', { pr, probeErr: probe.stderr && probe.stderr.slice(0, 200) });

  // M5 跨项目错误码（读/写）
  const initA = cli(['init', '--json']);
  cli(['project', 'add', '--name', '项目A', '--team-mode', 'full', '--json']);
  cli(['project', 'add', '--name', '项目B', '--team-mode', 'full', '--json']);
  const bootA = cli(['boot', '--role', 'programmer1', '--project', '项目A', '--json']);
  let tokA = '';
  try { tokA = JSON.parse(bootA.out).token || ''; } catch { tokA = ''; }
  const readCross = cli(['task', 'list', '--boot', tokA, '--project', '项目B', '--json']);
  const writeCross = cli(['task', 'claim', '--boot', tokA, '--project', '项目B', '--id', 'T-none']);
  const codeOf = (r) => { const t = r.out + '\n' + r.err; const a = /\[([A-Z_]+)\]/.exec(t); if (a) return a[1]; const b = /"code"\s*:\s*"([A-Z_]+)"/.exec(t); return b ? b[1] : ''; };
  const crossAudit = path.join(STATE, '项目', '项目B', '跨项目访问.jsonl');
  check('M5', '跨项目：读给 TOKEN_PROJECT_MISMATCH(exit 3)、写给 PROJECT_WRITE_DENIED(exit 3)，且未产生跨项目审计（无 --cross-project）',
    Boolean(tokA) && readCross.status === 3 && codeOf(readCross) === 'TOKEN_PROJECT_MISMATCH' && writeCross.status === 3 && codeOf(writeCross) === 'PROJECT_WRITE_DENIED' && !fs.existsSync(crossAudit),
    { tok: Boolean(tokA), read: { status: readCross.status, code: codeOf(readCross) }, write: { status: writeCross.status, code: codeOf(writeCross) } });
})().catch((e) => { check('E0', '夹具未抛异常', false, { error: String((e && e.stack) || e) }); }).finally(() => {
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
});
process.on('exit', () => {
  const pass = RESULT.filter((r) => r.ok).length;
  console.log(`\n${pass}/${RESULT.length} PASS`);
  if (pass !== RESULT.length) process.exitCode = 1;
});
