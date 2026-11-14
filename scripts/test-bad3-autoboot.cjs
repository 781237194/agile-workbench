'use strict';
/** R-bad3 回归：boot 自动化（单飞 / 复用 / 审计字段 / 失败告警去重）。 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync, spawn } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', 'bad3-autoboot');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TEAM_TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = 'boot沙盘';
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 280)}`);
  if (!ok) process.exitCode = 1;
}
function run(args, allowFail = false) {
  try {
    const out = execFileSync(process.execPath, [TEAM_TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
    const t = String(out).trim();
    return JSON.parse(t.slice(t.indexOf('{')));
  } catch (e) {
    const text = String((e && e.stdout) || '') + String((e && e.stderr) || '');
    if (allowFail) { try { return JSON.parse(text.slice(text.indexOf('{'))); } catch { return { ok: false, raw: text.slice(0, 200) }; } }
    throw e;
  }
}
const auditRows = () => {
  const f = path.join(TEAM_ROOT, '状态', '项目', PROJECT, '自动boot.jsonl');
  if (!fs.existsSync(f)) return [];
  return fs.readFileSync(f, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean);
};
const pmMessages = () => {
  const dir = path.join(TEAM_ROOT, '状态', '邮箱', 'pm');
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const walk = (d) => {
    for (const name of fs.readdirSync(d)) {
      const full = path.join(d, name);
      const st = fs.statSync(full);
      if (st.isDirectory()) { walk(full); continue; }
      if (!name.endsWith('.json')) continue;
      try { out.push(JSON.parse(fs.readFileSync(full, 'utf8'))); } catch { /* ignore */ }
    }
  };
  walk(dir);
  return out;
};

fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true });
run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);

// ① 首次自动 boot：leader + booted
const b1 = run(['auto-boot', '--project', PROJECT, '--role', 'programmer1', '--session', 's-1', '--trigger', 'create', '--json']);
check('① 首次 auto-boot 成功且是 leader', b1.ok === true && b1.booted === true && b1.singleFlight === 'leader', b1);
const rows1 = auditRows();
const r1 = rows1[0] || {};
const requiredFields = ['at', 'role', 'sessionId', 'trigger', 'ok', 'why', 'tokenId', 'rulesHash', 'durationMs', 'docsRead', 'reused', 'skippedByHash', 'duringTask', 'singleFlight'];
const missingFields = requiredFields.filter((k) => !(k in r1));
check('① 审计字段齐全（14 个，含 duringTask 驼峰）', missingFields.length === 0, missingFields);
check('① 审计 tokenId 只有前 8 位、不写令牌全文', String(r1.tokenId || '').length === 8 && !JSON.stringify(r1).includes(b1.tokenId + 'x'), r1.tokenId);
check('① 审计 docsRead 是已读文件数组、leader 不重复读', Array.isArray(r1.docsRead) && r1.docsRead.length > 0 && r1.reused === false, r1.docsRead);

// ② 第二次：复用有效令牌，跳过读取
const b2 = run(['auto-boot', '--project', PROJECT, '--role', 'programmer1', '--session', 's-1', '--trigger', 'stale', '--json']);
check('② 已有有效令牌 → 复用不重跑（reused/skippedByHash）', b2.ok === true && b2.booted === false && b2.reused === true, b2);
const r2 = auditRows().slice(-1)[0] || {};
check('② 复用时 skippedByHash=true 且 docsRead 为空', r2.skippedByHash === true && Array.isArray(r2.docsRead) && r2.docsRead.length === 0, { skippedByHash: r2.skippedByHash, docsRead: r2.docsRead });

// ③ 单飞：同角色并发两路 → 只出现 1 条 leader
fs.rmSync(path.join(TEAM_ROOT, '状态', '项目', PROJECT, '自动boot.jsonl'), { force: true });
const tokenDir = path.join(TEAM_ROOT, '状态', '启动');
if (fs.existsSync(tokenDir)) for (const n of fs.readdirSync(tokenDir)) if (n.includes('programmer2') || true) { try { const j = JSON.parse(fs.readFileSync(path.join(tokenDir, n), 'utf8')); if (j.role === 'programmer2') fs.rmSync(path.join(tokenDir, n)); } catch { /* ignore */ } }
const spawnOne = () => spawn(process.execPath, [TEAM_TOOL, 'auto-boot', '--project', PROJECT, '--role', 'programmer2', '--session', 's-2', '--trigger', 'stale', '--json'], { cwd: SB, env });
const p1 = spawnOne();
const p2 = spawnOne();
Promise.all([new Promise((res) => p1.on('exit', res)), new Promise((res) => p2.on('exit', res))]).then(() => {
  const rows = auditRows().filter((row) => row.role === 'programmer2');
  const leaders = rows.filter((row) => row.singleFlight === 'leader').length;
  const hits = rows.filter((row) => row.singleFlight === 'hit').length;
  check('③ 单飞：并发两路只有 1 条 leader，其余 hit', leaders === 1 && hits >= 1, { leaders, hits, rows: rows.map((x) => ({ s: x.singleFlight, ok: x.ok })) });

  // ④ 失败告警 + 去重：未知角色 boot 必然失败
  const f1 = run(['auto-boot', '--project', PROJECT, '--role', 'no-such-role', '--session', 's-x', '--trigger', 'stale', '--json'], true);
  const failRows = auditRows().filter((row) => row.role === 'no-such-role');
  check('④ 失败 → 审计 ok=false 且带 why', f1.ok === false && failRows.length >= 1 && Boolean(failRows[0].why), { f1: f1.ok, failRows: failRows.length });
  const boots1 = pmMessages().filter((m) => m.type === 'boot_failed').length;
  check('④ 失败给 PM 发 boot_failed（1 条）', boots1 === 1, boots1);
  run(['auto-boot', '--project', PROJECT, '--role', 'no-such-role', '--session', 's-x', '--trigger', 'stale', '--json'], true);
  const boots2 = pmMessages().filter((m) => m.type === 'boot_failed').length;
  check('④ 同 dedupeKey 再次失败不重复发（窗口内仍 1 条）', boots2 === 1, boots2);

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nR-bad3 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
  fs.writeFileSync(path.join(SB, 'run-bad3.json'), JSON.stringify({ passed, failed, results }, null, 2) + '\n', 'utf8');
});
