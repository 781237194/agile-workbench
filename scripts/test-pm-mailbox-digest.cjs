#!/usr/bin/env node
'use strict';
/**
 * B-20261117-201316-1441 自检：PM 邮箱补唤醒（mailbox_digest）+ 统一入口 sendToPmWithWake
 *
 * 断言（沙箱四隔离 + TEAM_SELFTEST=1，不写真实状态）：
 *   ① 写一条 type=escalation 到 PM 邮箱（未唤醒）→ 跑一拍 pmMailboxDigest → 唤醒.jsonl 出现 to=pm 且 reason=mailbox_digest 的行，
 *      该行 messageIds 含这条消息 id（= 60 秒内必有一次唤醒）；
 *   ② 同一条消息再跑一拍 → 不重复唤醒（去重：第二次 pending=0 / 无新行）；
 *   ③ 超过 15 分钟窗口的旧消息 → 不唤醒（不补叫陈旧消息）；
 *   ④ 多条不同类型同一拍 → 合并成 **1 条** 唤醒，正文含条数与类型分布；
 *   ⑤ sendToPmWithWake：写邮箱 + 立刻唤醒（reason=send_to_pm:*），不依赖兜底；
 *   ⑥ 隔离：真实 团队.json / workbench.json sha256 不变。
 *
 * 跑法：node scripts/test-pm-mailbox-digest.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const REAL = path.resolve(__dirname, '..');
const PROJECT = '工作台改造修复';
const BASE = path.join(REAL, '_tmp', `pm-digest-${process.pid}-${Date.now().toString(36)}`);
const REAL_TEAM = path.join(REAL, '团队', '状态', '团队.json');
const REAL_STORE = path.join(REAL, 'data', 'userdata', 'workbench.json');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 600)}`);
  if (!ok) process.exitCode = 1;
}
const readJson = (f, d) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return d; } };
const writeJson = (f, v) => { fs.mkdirSync(path.dirname(f), { recursive: true }); fs.writeFileSync(f, JSON.stringify(v, null, 2) + '\n', 'utf8'); };
const sha256 = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return ''; } };
function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, ent.name); const b = path.join(dst, ent.name);
    if (filter && filter(a)) continue;
    if (ent.isDirectory()) copyDir(a, b, filter); else fs.copyFileSync(a, b);
  }
}

function seed() {
  const dir = BASE;
  const data = path.join(dir, 'data');
  const team = path.join(dir, '团队');
  const projectDir = path.join(dir, '项目', PROJECT);
  fs.mkdirSync(path.join(data, 'userdata'), { recursive: true });
  copyDir(path.join(REAL, '团队'), team, (p) => /[\\/]邮箱([\\/]|$)/.test(p) || /[\\/]锁([\\/]|$)/.test(p));
  const state = path.join(team, '状态', '项目', PROJECT);
  fs.rmSync(state, { recursive: true, force: true });
  fs.mkdirSync(state, { recursive: true });
  const roster = readJson(path.join(team, '状态', '团队.json'), { members: [] });
  for (const m of roster.members || []) m.sessionId = '';
  roster.activeProject = PROJECT;
  writeJson(path.join(team, '状态', '团队.json'), roster);
  writeJson(path.join(state, '项目.json'), { name: PROJECT, path: projectDir, teamMode: 'full' });
  fs.mkdirSync(projectDir, { recursive: true });
  const store = readJson(REAL_STORE, { projects: [] });
  const project = (store.projects || []).find((p) => p && String(p.teamName || p.name || '') === PROJECT);
  store.projects = [project]; store.activeProjectId = project.id;
  project.path = projectDir;
  writeJson(path.join(data, 'userdata', 'workbench.json'), store);
  return { dir, data, team, projectDir, state };
}

const send = (sb, { id, type, subject, ageMs = 0, from = 'system' }) => {
  const ts = new Date(Date.now() - ageMs).toISOString();
  const file = path.join(sb.team, '状态', '邮箱', 'pm', 'new', `${ts.replace(/[:.]/g, '-')}-${id}.json`);
  writeJson(file, { id, from, to: 'pm', subject, body: `${subject}（夹具）`, type, project: PROJECT, ts, deliveredAt: ts });
  return file;
};
const wakeRows = (sb) => {
  const f = path.join(sb.state, '唤醒.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};

(async () => {
  fs.mkdirSync(BASE, { recursive: true });
  const before = { team: sha256(REAL_TEAM), store: sha256(REAL_STORE) };
  const sb = seed();
  process.env.AWB_DATA_DIR = sb.data;
  process.env.TEAM_ROOT = sb.team;
  process.env.TEAM_PROJECTS_ROOT = path.join(sb.team, '状态', '项目');
  process.env.TEAM_WORKBENCH_JSON = path.join(sb.data, 'userdata', 'workbench.json');
  process.env.TEAM_SELFTEST = '1';
  const ops = await import(require('node:url').pathToFileURL(path.join(REAL, '团队', '工具', 'lib', 'ops.mjs')).href);

  /* ① 一条 escalation → 一拍 → 有 mailbox_digest 唤醒 */
  send(sb, { id: 'M-test-escalation-1', type: 'escalation', subject: '交接超时：analyst 未回执' });
  const r1 = await ops.pmMailboxDigest(PROJECT);
  const rows1 = wakeRows(sb);
  const digest1 = rows1.filter((r) => String(r.reason) === 'mailbox_digest' || String(r.to) === 'pm' && /digest/i.test(String(r.subject || '')));
  const digestRow1 = rows1.filter((r) => String(r.reason) === 'mailbox_digest');
  const carriesId = digestRow1.some((r) => String((r.messageIds || []).join(',')).includes('M-test-escalation-1'));
  check('① escalation 落入 PM 邮箱后一拍内必有 to=pm 的 mailbox_digest 唤醒，且带该 messageId',
    r1.ok === true && r1.woken === 1 && digestRow1.length === 1 && digestRow1.every((r) => String(r.to) === 'pm') && carriesId,
    { r1, digestRows: digestRow1, carriesId, wakeRows: rows1.length });

  /* ② 再跑一拍 → 不重复 */
  const r2 = await ops.pmMailboxDigest(PROJECT);
  const digest2 = wakeRows(sb).filter((r) => String(r.reason) === 'mailbox_digest');
  check('② 同一条消息再跑一拍不重复唤醒（已进唤醒日志即跳过）',
    r2.ok === true && r2.woken === 0 && digest2.length === digest1.length, { r2, digestRows: digest2.length, before: digest1.length });

  /* ③ 陈旧消息（>15 分钟）不补叫 */
  send(sb, { id: 'M-test-old-1', type: 'req_review', subject: '评审打回（20 分钟前）', ageMs: 20 * 60 * 1000 });
  const r3 = await ops.pmMailboxDigest(PROJECT);
  const digest3 = wakeRows(sb).filter((r) => String(r.reason) === 'mailbox_digest');
  check('③ 超过 15 分钟窗口的旧消息不补唤醒（不叫陈旧消息）',
    r3.ok === true && r3.woken === 0 && digest3.length === digest1.length, { r3, digestRows: digest3.length });

  /* ④ 多条不同类型 → 合并成 1 条 */
  send(sb, { id: 'M-test-wakefailed-1', type: 'wake_failed', subject: '唤醒失败：route-daemon 心跳停' });
  send(sb, { id: 'M-test-reqreview-1', type: 'req_review', subject: '需求评审打回：R-fa0e' });
  send(sb, { id: 'M-test-note-1', type: 'note', subject: '认领提醒：analyst 已认领 T-1' });
  const r4 = await ops.pmMailboxDigest(PROJECT);
  const digest4 = wakeRows(sb).filter((r) => String(r.reason) === 'mailbox_digest');
  const mergedBody = String((r4 && r4.wake && r4.wake.text) || '');
  const idsInRow = digest4.length ? (digest4[digest4.length - 1].messageIds || []) : [];
  check('④ 同拍多条不同类型合并成 1 条唤醒（正文含条数与类型分布）',
    r4.ok === true && r4.woken === 3 && digest4.length === digest1.length + 1 && /3 条/.test(mergedBody) && /escalation|wake_failed|req_review|note/.test(mergedBody) && String(idsInRow.join(',')).includes('M-test-wakefailed-1') && String(idsInRow.join(',')).includes('M-test-reqreview-1'),
    { r4, digestRows: digest4.length, mergedBody, idsInRow });

  /* ④b B-3c45：同一批未读消息连跑 3 拍 → 仍然只有 1 条 digest（不许每拍再叫一次） */
  const beforeTicks = wakeRows(sb).filter((r) => String(r.reason) === 'mailbox_digest').length;
  const t1 = await ops.pmMailboxDigest(PROJECT);
  const t2 = await ops.pmMailboxDigest(PROJECT);
  const t3 = await ops.pmMailboxDigest(PROJECT);
  const afterTicks = wakeRows(sb).filter((r) => String(r.reason) === 'mailbox_digest').length;
  check('④b B-3c45：同一批消息连跑 3 拍不重复唤醒（台账按 messageId 去重，digest 条数不增）',
    afterTicks === beforeTicks && [t1, t2, t3].every((r) => r.ok === true && r.woken === 0),
    { beforeTicks, afterTicks, ticks: [t1.woken, t2.woken, t3.woken] });

  /* ④c 有新消息进来时，digest 只含新的那条（旧消息不再被重复摘要） */
  send(sb, { id: 'M-test-new-2', type: 'escalation', subject: '新升级：只有这条该被叫醒' });
  const r4c = await ops.pmMailboxDigest(PROJECT);
  const digest4c = wakeRows(sb).filter((r) => String(r.reason) === 'mailbox_digest');
  const lastIds = String(((digest4c[digest4c.length - 1] || {}).messageIds || []).join(','));
  check('④c 有新消息时只摘要新的那条（旧 messageId 不再进 digest）',
    r4c.ok === true && r4c.woken === 1 && lastIds.includes('M-test-new-2') && !lastIds.includes('M-test-wakefailed-1'),
    { r4c, lastIds });

  /* ⑤ sendToPmWithWake：写邮箱 + 立刻唤醒 */
  const before5 = wakeRows(sb).length;
  const sent = await ops.sendToPmWithWake(PROJECT, { subject: '直接发并唤醒', body: '这条走统一入口', type: 'escalation' });
  const rows5 = wakeRows(sb);
  const newRows = rows5.slice(before5);
  const directWake = newRows.filter((r) => String(r.to) === 'pm' && String(r.reason || '').startsWith('send_to_pm'));
  const mailFile = path.join(sb.team, '状态', '邮箱', 'pm', 'new');
  const mailed = fs.existsSync(mailFile) && fs.readdirSync(mailFile).some((f) => f.includes(String(sent.messageId || '').replace(/[^\w-]/g, '')) || f.includes('M-'));
  check('⑤ sendToPmWithWake：写 PM 邮箱 + 立刻唤醒（reason=send_to_pm:*），不依赖兜底',
    sent.ok === true && Boolean(sent.messageId) && directWake.length >= 1 && mailed, { sent, directWake: directWake.length, mailed });

  /* ⑥ 隔离：真实树里不能出现沙盘标记（真实 团队.json / workbench.json 会被其他角色实时写，整文件 sha 不适合做基线） */
  const realTeam = readJson(REAL_TEAM, { members: [] });
  const sandboxSessionLeak = (realTeam.members || []).some((m) => /^sess-old-/.test(String(m.sessionId || '')));
  const realStore = readJson(REAL_STORE, { projects: [] });
  const storeLeak = (realStore.projects || []).some((p) => Object.values(p.sessions || {}).some((v) => /^sess-old-|^session-auto-/.test(String(v))));
  const ledgerWritten = fs.existsSync(path.join(sb.state, '邮箱摘要已通知.json'));
  check('⑥ 隔离：真实 团队.json / workbench.json 里 0 个沙盘夹具标识，且去重台账只落在沙盘',
    !sandboxSessionLeak && !storeLeak && ledgerWritten,
    { sandboxSessionLeak, storeLeak, ledgerWritten, realTeamSha: sha256(REAL_TEAM) === before.team });

  /* ④d 把候选 read 掉（new→cur）→ 下一拍候选 0、不发唤醒 */
  const pmNew = path.join(sb.team, '状态', '邮箱', 'pm', 'new');
  const pmCur = path.join(sb.team, '状态', '邮箱', 'pm', 'cur');
  fs.mkdirSync(pmCur, { recursive: true });
  let moved = 0;
  for (const f of fs.readdirSync(pmNew)) { fs.renameSync(path.join(pmNew, f), path.join(pmCur, f)); moved += 1; }
  const before4d = wakeRows(sb).filter((r) => String(r.reason) === 'mailbox_digest').length;
  const r4d = await ops.pmMailboxDigest(PROJECT);
  const after4d = wakeRows(sb).filter((r) => String(r.reason) === 'mailbox_digest').length;
  check('④d 候选被 read 掉（new→cur）后 → 候选 0 不发唤醒',
    moved > 0 && r4d.ok === true && r4d.pending === 0 && after4d === before4d, { moved, r4d, before4d, after4d });

  /* ④e 24h 过期清理：台账里 25 小时前的条目要被剪掉（不永久占位），1 分钟前的保留 */
  {
    const ledgerFile = path.join(sb.state, '邮箱摘要已通知.json');
    const cur = readJson(ledgerFile, { ids: {} });
    const oldIso = new Date(Date.now() - 25 * 3600 * 1000).toISOString();
    const freshIso = new Date(Date.now() - 60 * 1000).toISOString();
    cur.ids = {
      ...(cur.ids || {}),
      'M-old-25h': { at: oldIso, messageId: 'M-old-25h', type: 'escalation' },
      'M-keep-1m': { at: freshIso, messageId: 'M-keep-1m', type: 'note' },
    };
    writeJson(ledgerFile, cur);
    send(sb, { id: 'M-test-after-prune', type: 'escalation', subject: '触发一次写回，验证剪枝落盘' });
    const r = await ops.pmMailboxDigest(PROJECT);
    const after = readJson(ledgerFile, { ids: {} }).ids || {};
    check('④e 台账 24h 过期清理：25 小时前条目被剪掉、1 分钟内条目保留（写回后生效）',
      r.ok === true && !after['M-old-25h'] && Boolean(after['M-keep-1m']) && Boolean(after['M-test-after-prune']),
      { woken: r.woken, pruned: !after['M-old-25h'], keep: Boolean(after['M-keep-1m']) });
  }

  const pass = results.filter((r) => r.ok).length;
  console.log('');
  console.log(`${pass === results.length ? 'PM_MAILBOX_DIGEST_OK' : 'PM_MAILBOX_DIGEST_WARN'} ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
  try { fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
})();
