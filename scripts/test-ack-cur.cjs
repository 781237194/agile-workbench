'use strict';
/**
 * B-c42e（P0）回归：消息移档到 cur 后 ack 不能报 INTERNAL ENOENT。
 *
 * 跑法：node scripts/test-ack-cur.cjs
 * 隔离：复制 团队/ 到 _tmp/ack-cur-test，TEAM_ROOT/TEAM_PROJECTS_ROOT 指向沙盘，TEAM_SELFTEST=1。
 *
 * 断言：
 * ① 消息只在 cur（模拟已自动已读/被移档）→ ack 成功，回执落 1 条，回执消息发给原发送者；
 * ② 同一 id 重复 ack → already，不重复落回执；
 * ③ 并发两个 ack（同一条 cur 消息）→ 不出现 INTERNAL，回执恰好 1 条；
 * ④ 不存在 id → MESSAGE_NOT_FOUND（不是 INTERNAL）；
 * ⑤ 同一消息同时存在 new 与 cur（并发拷贝场景）→ ack 不崩，回执仍只 1 条。
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', 'ack-cur-test');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TEAM_TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = '移档沙盘';
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + JSON.stringify(detail).slice(0, 300)}`);
  if (!ok) process.exitCode = 1;
}
function run(args) {
  const out = execFileSync(process.execPath, [TEAM_TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
  const text = String(out).trim();
  return JSON.parse(text.slice(text.indexOf('{')));
}
function runRaw(args) {
  return spawnSync(process.execPath, [TEAM_TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
}
const mailDir = (role, box) => path.join(TEAM_ROOT, '状态', '邮箱', role, box);
const findInBox = (role, box, id) => {
  const dir = mailDir(role, box);
  if (!fs.existsSync(dir)) return null;
  return fs.readdirSync(dir).map((n) => path.join(dir, n)).find((f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')).id === id; } catch { return false; } }) || null;
};
const receiptsFor = (msgId) => {
  const file = path.join(TEAM_ROOT, '状态', '回执.jsonl');
  if (!fs.existsSync(file)) return [];
  return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } })
    .filter(Boolean).filter((row) => row.msgId === msgId && !row.update);
};

// ---------- 沙盘 ----------
fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true });
run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'sbx-pm', '--json']);
const dev = run(['boot', '--role', 'programmer2', '--project', PROJECT, '--session', 'sbx-dev', '--json']);
console.log(`沙盘就绪：${SB}`);

// ① 消息在 cur 再 ack
const m1 = run(['send', '--boot', dev.token, '--to', 'pm', '--subject', '移档用例1', '--body', 'x', '--json']).message;
const inNew1 = findInBox('pm', 'new', m1.id);
const inCur1 = findInBox('pm', 'cur', m1.id);
const src1 = inNew1 || inCur1;
fs.mkdirSync(mailDir('pm', 'cur'), { recursive: true });
fs.renameSync(src1, path.join(mailDir('pm', 'cur'), path.basename(src1)));
const ack1 = runRaw(['ack', '--boot', pm.token, '--id', m1.id, '--note', '收到', '--json']);
check('① cur 里的消息 ack 成功（无 INTERNAL/ENOENT）', ack1.status === 0 && !/INTERNAL|ENOENT/.test(ack1.stderr || ''), { stderr: String(ack1.stderr).slice(0, 200) });
check('① 回执落 1 条', receiptsFor(m1.id).length === 1, receiptsFor(m1.id).length);
check('① 消息仍留在 cur（没被搬回 new）', Boolean(findInBox('pm', 'cur', m1.id)) && !findInBox('pm', 'new', m1.id), { cur: Boolean(findInBox('pm', 'cur', m1.id)), new: Boolean(findInBox('pm', 'new', m1.id)) });

// ② 重复 ack
const ack2 = run(['ack', '--boot', pm.token, '--id', m1.id, '--note', '再确认', '--json']);
check('② 重复 ack 幂等', ack2.already === true, ack2.already);
check('② 回执仍 1 条', receiptsFor(m1.id).length === 1, receiptsFor(m1.id).length);

// ③ 并发两个 ack
const m2 = run(['send', '--boot', dev.token, '--to', 'pm', '--subject', '并发用例', '--body', 'x', '--json']).message;
const p2New = findInBox('pm', 'new', m2.id) || findInBox('pm', 'cur', m2.id);
fs.mkdirSync(mailDir('pm', 'cur'), { recursive: true });
fs.renameSync(p2New, path.join(mailDir('pm', 'cur'), path.basename(p2New)));
const childA = require('node:child_process').spawn(process.execPath, [TEAM_TOOL, 'ack', '--boot', pm.token, '--id', m2.id, '--note', 'A', '--json'], { cwd: SB, env });
const childB = require('node:child_process').spawn(process.execPath, [TEAM_TOOL, 'ack', '--boot', pm.token, '--id', m2.id, '--note', 'B', '--json'], { cwd: SB, env });
let outA = ''; let outB = ''; let errA = ''; let errB = '';
childA.stdout.on('data', (d) => { outA += d; }); childB.stdout.on('data', (d) => { outB += d; });
childA.stderr.on('data', (d) => { errA += d; }); childB.stderr.on('data', (d) => { errB += d; });
const done = new Promise((resolve) => { let n = 0; const tick = () => { n += 1; if (n === 2) resolve(); }; childA.on('close', tick); childB.on('close', tick); });
done.then(() => {
  check('③ 并发 ack 均无 INTERNAL/ENOENT', !/INTERNAL|ENOENT/.test(errA + errB), { errA: errA.slice(0, 160), errB: errB.slice(0, 160) });
  check('③ 并发后回执恰好 1 条', receiptsFor(m2.id).length === 1, receiptsFor(m2.id).length);
  check('③ 两个进程至少一个返回 ok', /"ok"\s*:\s*true/.test(outA) || /"ok"\s*:\s*true/.test(outB), { outA: outA.slice(0, 120), outB: outB.slice(0, 120) });

  // ④ 不存在 id
  const missing = runRaw(['ack', '--boot', pm.token, '--id', 'M-20200101-000000-dead', '--note', 'x', '--json']);
  const msgText = String(missing.stdout || '') + String(missing.stderr || '');
  check('④ 不存在 id 返回 MESSAGE_NOT_FOUND（不是 INTERNAL）', /MESSAGE_NOT_FOUND/.test(msgText) && !/INTERNAL/.test(msgText), msgText.slice(0, 200));

  // ⑤ 同一消息同时在 new 与 cur（并发拷贝场景）
  const m3 = run(['send', '--boot', dev.token, '--to', 'pm', '--subject', '双份用例', '--body', 'x', '--json']).message;
  const p3 = findInBox('pm', 'new', m3.id) || findInBox('pm', 'cur', m3.id);
  fs.mkdirSync(mailDir('pm', 'cur'), { recursive: true });
  fs.copyFileSync(p3, path.join(mailDir('pm', 'cur'), path.basename(p3)));
  if (!findInBox('pm', 'new', m3.id)) {
    fs.copyFileSync(p3, path.join(mailDir('pm', 'new'), path.basename(p3)));
  }
  const ack5 = runRaw(['ack', '--boot', pm.token, '--id', m3.id, '--note', '双份', '--json']);
  check('⑤ new/cur 各一份时 ack 不崩', ack5.status === 0 && !/INTERNAL|ENOENT/.test(ack5.stderr || ''), { stderr: String(ack5.stderr).slice(0, 200) });
  check('⑤ 回执仍只 1 条', receiptsFor(m3.id).length === 1, receiptsFor(m3.id).length);

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nB-c42e 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
  fs.writeFileSync(path.join(SB, 'run-ack-cur.json'), JSON.stringify({ at: new Date().toISOString(), passed, failed, results }, null, 2) + '\n', 'utf8');
  if (failed) process.exitCode = 1;
});
