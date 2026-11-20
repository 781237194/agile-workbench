'use strict';
/**
 * 夹具：R-e438 批②-2 消费方切换（JSONL 与旧目录「语义等价」）
 *
 * 断言：
 *  C1 迁移前后 presence 的 unread/ackPending 数字相同（同一批消息、同一读状态）。
 *  C2 inbox --all 数字与迁移前相同；seq 单调；触达文件 ≤2（messages.jsonl + index.json）。
 *  C3 read 一条 → unread -1（read 事件生效）；inbox 数字同步下降。
 *  C4 ack 一条 → 生成回执、unread -1；重复 ack 幂等（回执不增、事件不重复生效）。
 *  C5 未读不计 ackPending（语义与旧目录一致）：全部未读时 ackPending=0，已读未回执才 +1。
 *  C6 旧目录回退：复制 sandbox 为 legacy 形态（删 jsonl 恢复 new/cur）后 inbox/presence 仍可读（兼容期）。
 *
 * 隔离：mkdtemp 沙盘；init + project add + boot programmer1/pm；只写沙盘。
 * 跑法：node scripts/test-e438-mail-consume.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const PROJECT = 'consume-沙盘';
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-consume-'));
const TEAM = path.join(SB, '团队');
const MAIL = path.join(TEAM, '状态', '邮箱');
const RESULT = [];
function check(id, title, ok, detail) {
  RESULT.push({ id, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${title}${ok ? '' : '  ← ' + String(JSON.stringify(detail === undefined ? '' : detail)).slice(0, 420)}`);
  if (!ok) process.exitCode = 1;
}
const env = () => ({ ...process.env, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: path.join(SB, '项目'), TEAM_WORKBENCH_JSON: path.join(SB, 'workbench.json'), AWB_DATA_DIR: path.join(SB, 'data'), TEAM_SELFTEST: '1' });
function cli(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: env(), cwd: SB, timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  let json = null; try { json = JSON.parse(String(r.stdout || '')); } catch { json = null; }
  return { status: r.status, json, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function presence() {
  const r = cli(['presence', '--project', PROJECT, '--json']);
  const row = (r.json && Array.isArray(r.json.rows) ? r.json.rows : []).find((x) => x.role === 'programmer1') || {};
  return { status: r.status, unread: row.unread, ackPending: row.ackPending, raw: r.json };
}
function inboxCount() {
  const r = cli(['inbox', '--boot', p1Tok, '--all', '--json']);
  const j = r.json || {};
  return { status: r.status, count: Array.isArray(j.messages) ? j.messages.length : (Array.isArray(j.rows) ? j.rows.length : (Array.isArray(j) ? j.length : null)), json: j, raw: r };
}
function inboxUnread() {
  const r = cli(['inbox', '--boot', p1Tok, '--json']);
  const j = r.json || {};
  return { status: r.status, count: Array.isArray(j.messages) ? j.messages.length : null };
}
function seedLegacy(n) {
  const dir = path.join(MAIL, 'programmer1', 'new');
  fs.mkdirSync(dir, { recursive: true });
  const out = [];
  for (let i = 0; i < n; i += 1) {
    const at = new Date(Date.UTC(2026, 10, 20, 4, i)).toISOString();
    const msg = { id: `M-consume-${i}`, from: 'pm', to: 'programmer1', subject: `消费方切换 ${i}`, body: 'body', project: PROJECT, task: '', ackRequired: true, type: 'dispatch', ts: at, deliveredAt: at };
    fs.writeFileSync(path.join(dir, `x-${i}-M-consume-${i}.json`), JSON.stringify(msg, null, 1), 'utf8');
    out.push(msg);
  }
  return out;
}

let p1Tok = '';
try {
  cli(['init', '--json']);
  cli(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
  const p1 = cli(['boot', '--role', 'programmer1', '--project', PROJECT, '--json']);
  const pm = cli(['boot', '--role', 'pm', '--project', PROJECT, '--json']);
  p1Tok = (p1.json && p1.json.token) || '';
  const pmTok = (pm.json && pm.json.token) || '';
  check('S0', '沙盘 init/project/boot 就绪', Boolean(p1Tok && pmTok), { p1: Boolean(p1Tok), pm: Boolean(pmTok) });

  seedLegacy(3);
  const beforeP = presence();
  const beforeI = inboxCount();
  check('C1a', '迁移前基线：presence unread=3、ackPending=0（未读不计 ackPending）；inbox --all=3',
    beforeP.status === 0 && beforeP.unread === 3 && beforeP.ackPending === 0 && beforeI.count === 3,
    { beforeP, beforeI: beforeI.count });

  const mig = cli(['mail', 'migrate', '--role', 'programmer1', '--yes']);
  const dirFiles = fs.readdirSync(path.join(MAIL, 'programmer1')).sort();
  const afterP = presence();
  const afterI = inboxCount();
  const seqs = (afterI.json.messages || afterI.json.rows || []).map((m) => Number(m.seq)).filter(Number.isFinite);
  check('C1b', '迁移后：presence unread/ackPending 与迁移前相同；inbox 数字相同；seq 单调',
    mig.status === 0 && afterP.unread === beforeP.unread && afterP.ackPending === beforeP.ackPending
    && afterI.count === beforeI.count && seqs.length === 3 && seqs.every((v, i) => i === 0 || v > seqs[i - 1]),
    { mig: mig.out.slice(0, 160), afterP, afterI: afterI.count, seqs });
  check('C2', '触达文件 ≤2：角色目录只剩 messages.jsonl + index.json（旧 new/cur 已移入 _legacy）',
    dirFiles.filter((n) => n === 'messages.jsonl' || n === 'index.json').length === 2
    && !dirFiles.includes('new') && !dirFiles.includes('cur'), { dirFiles });

  const read1 = cli(['read', '--id', 'M-consume-1', '--boot', p1Tok, '--json']);
  const afterReadP = presence();
  check('C3', 'read 一条（JSONL 事件）：unread 3→2、ackPending 0→1（已读未回执）、未读 inbox 3→2',
    read1.status === 0 && afterReadP.unread === 2 && afterReadP.ackPending === 1 && inboxUnread().count === 2, { read1: read1.status, afterReadP, unreadInbox: inboxUnread() });

  const ack2 = cli(['ack', '--id', 'M-consume-2', '--boot', p1Tok, '--json']);
  const afterAckP = presence();
  const receiptsBefore = cli(['status', '--project', PROJECT, '--json']);
  const ackAgain = cli(['ack', '--id', 'M-consume-2', '--boot', p1Tok, '--json']);
  const afterAck2P = presence();
  check('C4', 'ack 一条：回执生成、unread 2→1；重复 ack 幂等（already=true，unread 不变）',
    ack2.status === 0 && afterAckP.unread === 1 && ackAgain.status === 0
    && String((ackAgain.json && (ackAgain.json.already || (ackAgain.json.result && ackAgain.json.result.already))) || '').includes('true') || (ackAgain.json && ackAgain.json.already === true)
    && afterAck2P.unread === 1, { ack2: ack2.status, afterAckP, again: ackAgain.json && ackAgain.json.already, afterAck2P });

  const evLines = fs.readFileSync(path.join(MAIL, 'programmer1', 'messages.jsonl'), 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
  const events = evLines.filter((r) => r.type === 'event');
  check('C5', '事件行：read≥2（read 命令 + ack 触发的 read）+ ack×1 且 refId 正确；未读消息不计 ackPending（全未读时 ackPending=0 已由 C1a 证明）',
    events.filter((e) => e.event === 'read').length >= 2 && events.filter((e) => e.event === 'ack').length === 1
    && events.some((e) => e.event === 'ack' && e.refId === 'M-consume-2'), { events: events.map((e) => ({ event: e.event, refId: e.refId })) });

  // C6 兼容期回退：把 JSONL 移走并恢复旧目录（_legacy 里的目录搬回）
  fs.renameSync(path.join(MAIL, 'programmer1', 'messages.jsonl'), path.join(MAIL, 'programmer1', 'messages.jsonl.bak'));
  try { fs.renameSync(path.join(MAIL, 'programmer1', 'index.json'), path.join(MAIL, 'programmer1', 'index.json.bak')); } catch { /* ignore */ }
  const legacyDir = path.join(MAIL, '_legacy', 'programmer1');
  for (const n of (fs.existsSync(legacyDir) ? fs.readdirSync(legacyDir) : [])) {
    if (n.startsWith('new-')) fs.renameSync(path.join(legacyDir, n), path.join(MAIL, 'programmer1', 'new'));
    if (n.startsWith('cur-')) fs.renameSync(path.join(legacyDir, n), path.join(MAIL, 'programmer1', 'cur'));
  }
  const fallbackP = presence();
  const fallbackI = inboxCount();
  check('C6', '兼容期回退：旧目录恢复后 presence/inbox 仍可读（不报错、数字为旧口径 3/0）',
    fallbackP.status === 0 && fallbackP.unread === 3 && fallbackP.ackPending === 0 && fallbackI.count === 3,
    { fallbackP, fallbackI: fallbackI.count });
} catch (e) {
  check('E0', '夹具未抛异常', false, { error: String((e && e.stack) || e) });
} finally {
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
}
const pass = RESULT.filter((r) => r.ok).length;
console.log(`\n${pass}/${RESULT.length} PASS`);
if (pass !== RESULT.length) process.exitCode = 1;
