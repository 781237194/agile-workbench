#!/usr/bin/env node
'use strict';
const { rmSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/**
 * test-notify-delivery.cjs — B-20261116-190049-6d72（Owner 定级 P0）+ 宪法第 25 条
 *
 * 纪律：通知与唤醒只投 to 指定的收件人；禁广播、禁抄送（含 PM）；自发自收不发回执通知、不唤醒。
 * 本脚本是**共享层夹具**（只依赖 团队/ 与 team.mjs，别的项目复制 团队/ 过去也能跑）。
 *
 *   AC1 精确投递：pm→tester 的 notice 只在 tester 邮箱，pm/其它角色 0 命中
 *   AC2 唤醒只给 to：唤醒.jsonl 该消息行的 to === 'tester'
 *   AC3 自环闸：from === 回执人 的消息被 ack 后，不产生任何新消息（无 notice/无回执），只写回执记录
 *   AC4 静态禁令：团队/工具/lib 与 src/main.js 中不存在「遍历 members 后 sendMessage」的广播写法
 *
 * 用法：node scripts/test-notify-delivery.cjs
 * 退出码：0 全过 / 1 断言失败 / 2 环境错
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', 'notify-delivery-' + Date.now().toString(36));
const TEAM = path.join(SB, '团队');
const PROJECT = '工作台改造修复';
const TEAM_SRC = path.join(ROOT, '团队');
const TEAM_MJS = path.join(TEAM_SRC, '工具', 'team.mjs');
const WAKE_LOG = path.join(TEAM, '状态', '项目', PROJECT, '唤醒.jsonl');
const MAIL = path.join(TEAM, '状态', '邮箱');

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log('PASS  ' + name); }
  else { fails.push({ name, detail }); console.log('FAIL  ' + name + ' · ' + JSON.stringify(detail)); }
};

const env = {
  ...process.env,
  ELECTRON_RUN_AS_NODE: '1',
  TEAM_ROOT: TEAM,
  TEAM_PROJECTS_ROOT: path.join(ROOT, '项目'),
  TEAM_WORKBENCH_JSON: path.join(SB, 'workbench.json'),
  TEAM_SELFTEST: '1',
};
delete env.TEAM_ALLOW_SANDBOX_WAKE;

function run(args) {
  try {
    const out = execFileSync(process.execPath, [TEAM_MJS, ...args], { cwd: SB, env, encoding: 'utf8', timeout: 120000 });
    return { code: 0, out: String(out) };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, out: String((e.stdout || '') + (e.stderr || '')) };
  }
}
function boot(role) {
  const r = run(['boot', '--role', role, '--project', PROJECT]);
  const m = /令牌[:：]\s*([0-9a-f]{24})/.exec(r.out);
  return { token: m ? m[1] : '', raw: r };
}
function inboxFiles(role) {
  const dir = path.join(MAIL, role);
  const out = [];
  for (const box of ['new', 'cur']) {
    const d = path.join(dir, box);
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) if (f.endsWith('.json')) out.push({ file: path.join(d, f), box });
  }
  return out;
}
function inboxIds(role) {
  return inboxFiles(role).map(({ file }) => {
    try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return null; }
  }).filter(Boolean);
}
function wakeRows() {
  if (!fs.existsSync(WAKE_LOG)) return [];
  return fs.readFileSync(WAKE_LOG, 'utf8').trim().split(/\r?\n/).filter(Boolean)
    .map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
}

// ── 沙盘搭建
fs.mkdirSync(path.join(TEAM, '状态', '项目'), { recursive: true });
const teamJson = JSON.parse(fs.readFileSync(path.join(TEAM_SRC, '状态', '团队.json'), 'utf8'));
for (const m of (teamJson.members || [])) delete m.sessionId;
teamJson.activeProjectId = '';
fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(teamJson, null, 2), 'utf8');
for (const rel of ['团队宪法.md', '项目铁律.md', '项目经理/角色卡.md', '测试人员/角色卡.md', '项目经理/文件索引.md', '测试人员/文件索引.md']) {
  const from = path.join(TEAM_SRC, rel);
  if (!fs.existsSync(from)) continue;
  const to = path.join(TEAM, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
fs.cpSync(path.join(TEAM_SRC, '状态', '项目', PROJECT), path.join(TEAM, '状态', '项目', PROJECT), { recursive: true });
try { fs.rmSync(WAKE_LOG, { force: true }); } catch { /* ignore */ }

const pm = boot('pm');
const tester = boot('tester');
if (!pm.token || !tester.token) {
  console.log('ENV_FAIL boot 未拿到令牌：pm=' + Boolean(pm.token) + ' tester=' + Boolean(tester.token));
  console.log((pm.raw.out + tester.raw.out).slice(-500));
  process.exit(2);
}

// ── AC1/AC2：pm→tester 的 notice 只进 tester 邮箱，唤醒 to=tester
const beforePm = inboxIds('pm').length;
const send = run(['send', '--role', 'pm', '--project', PROJECT, '--boot', pm.token,
  '--to', 'tester', '--subject', '夹具-精确投递', '--body', '只该进 tester 邮箱', '--type', 'notice']);
const sentId = (/M-\d{8}-\d{6}-[0-9a-f]{6}/.exec(send.out) || [])[0] || '';
const testerHas = inboxIds('tester').some((m) => m.id === sentId || String(m.subject || '').includes('夹具-精确投递'));
const pmHas = inboxIds('pm').some((m) => m.id === sentId || String(m.subject || '').includes('夹具-精确投递'));
check('AC1 精确投递：tester 邮箱有该消息', Boolean(sentId) && testerHas, { sentId, code: send.code });
check('AC1 精确投递：pm 邮箱 0 命中该消息', pmHas === false, { pmHas, beforePm, afterPm: inboxIds('pm').length });
const row = wakeRows().pop();
check('AC2 唤醒只给 to：唤醒行 to === tester（无 to=pm 行）',
  Boolean(row) && String(row.to) === 'tester' && !wakeRows().some((r) => String(r.to) === 'pm' && String(r.subject || '').includes('夹具-精确投递')),
  { row: row ? { to: row.to, reason: row.reason } : null, wakeRows: wakeRows().length });

// ── AC3 自环闸：把一条 from=tester 的消息塞进 tester 邮箱，tester ack 它 → 不应产生新消息
const selfId = 'M-20261116-999999-abc123';
const selfFile = path.join(MAIL, 'tester', 'new', selfId + '.json');
fs.mkdirSync(path.dirname(selfFile), { recursive: true });
fs.writeFileSync(selfFile, JSON.stringify({
  id: selfId, from: 'tester', to: 'tester', subject: '自环夹具', body: '自己发给自己的消息',
  project: PROJECT, type: 'receipt', ts: new Date().toISOString(), ackRequired: false,
}, null, 2), 'utf8');
const beforeSelf = inboxIds('tester').length;
const ackSelf = run(['ack', '--role', 'tester', '--project', PROJECT, '--boot', tester.token, '--id', selfId, '--note', '自环夹具回执']);
const afterSelf = inboxIds('tester').length;
check('AC3 自环闸：from===自身 被 ack 后不产生任何新消息',
  ackSelf.code === 0 && afterSelf === beforeSelf, { code: ackSelf.code, beforeSelf, afterSelf, tail: ackSelf.out.slice(-120) });

// ── AC4 静态禁令：禁止「遍历 members 后 sendMessage」广播写法
const scanFiles = [];
for (const f of fs.readdirSync(path.join(TEAM_SRC, '工具', 'lib'))) {
  if (f.endsWith('.mjs')) scanFiles.push(path.join(TEAM_SRC, '工具', 'lib', f));
}
scanFiles.push(path.join(ROOT, 'src', 'main.js'));
const hits = [];
for (const file of scanFiles) {
  const text = fs.readFileSync(file, 'utf8');
  const re = /for\s*\(\s*const\s+\w+\s+of\s+[^)]*members[^)]*\)\s*\{[\s\S]{0,600}?sendMessage\s*\(/g;
  const m = re.exec(text);
  if (m) hits.push({ file: path.relative(ROOT, file), index: m.index });
}
check('AC4 静态禁令：全仓 0 处「遍历角色 + sendMessage」广播写法', hits.length === 0, { hits });

console.log('\n通知投递断言：' + pass + '/' + (pass + fails.length) + ' PASS');
try { rmSandbox(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }); } catch { /* ignore */ }
if (fails.length) { console.log(JSON.stringify(fails, null, 2)); process.exit(1); }
