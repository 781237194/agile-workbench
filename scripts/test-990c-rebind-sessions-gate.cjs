#!/usr/bin/env node
'use strict';
/**
 * test-990c-rebind-sessions-gate.cjs —— B-20261118-083158-990c 回归夹具（4761 补丁）
 *
 * 缺陷：4761 的 `rebind-sessions` 是名册第 4 写者，写前不校验目标会话是否在 DSH 存在 →
 * 换机/换人时可能把不存在的 sessionId 写进名册，事后只能靠人肉发现。
 *
 * 断言（沙盘 root，真实名册零写入）：
 *   A1 不存在的 session + 门禁强制 → exit≠0、code=STALE_SESSION_REFUSED、团队.json sha256 不变（零写入）
 *   A2 同一调用加 --allow-missing → 写入成功，审计行含 allowMissing:true（且含 at/by/role/from/to/reason）
 *   A3 沙盘豁免：不设 TEAM_MIGRATE_ENFORCE 时（--root 沙盘）旧行为不被门禁拦（4761 自有夹具不红）
 *
 * 跑法：node scripts/test-990c-rebind-sessions-gate.cjs   （AWB_990C_OUT 指定 run.json）
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', `990c-${process.pid}`);
const MIGRATE = path.join(ROOT, '团队', '工具', 'migrate.mjs');
const PROJECT = '990c沙盘';
let pass = 0;
const results = [];
function ok(name, cond, detail) {
  results.push({ name, ok: Boolean(cond) });
  if (cond) { pass += 1; console.log(`PASS  ${name}`); return; }
  console.log(`FAIL  ${name}  ` + JSON.stringify(detail || {}).slice(0, 300)); process.exitCode = 1;
}
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
const teamFile = () => path.join(SB, '团队', '状态', '团队.json');
const auditFile = () => path.join(SB, '团队', '状态', '项目', PROJECT, '迁移审计.jsonl');

function run(args, env) {
  try {
    const out = String(execFileSync(process.execPath, [MIGRATE, ...args], {
      cwd: ROOT, encoding: 'utf8', timeout: 120000, env: { ...process.env, TEAM_SELFTEST: '', ...(env || {}) },
    }));
    return { code: 0, out };
  } catch (e) {
    return { code: e.status == null ? 1 : e.status, out: String(e.stdout || '') + String(e.stderr || '') };
  }
}

// ── 沙盘：只复制名册 + 建项目状态目录（migrate 只写这两处）
fs.mkdirSync(path.join(SB, '团队', '状态', '项目', PROJECT), { recursive: true });
fs.copyFileSync(path.join(ROOT, '团队', '状态', '团队.json'), teamFile());

// A1：门禁强制 + 不存在的会话
const before = sha(teamFile());
const a1 = run(['rebind-sessions', '--root', SB, '--project', PROJECT, '--role', 'tester', '--session', 'session-not-exist-990c', '--yes', '--json'], { TEAM_MIGRATE_ENFORCE: '1' });
ok('A1 不存在 session + 强制门禁 → exit≠0 且 code=STALE_SESSION_REFUSED',
  a1.code !== 0 && /STALE_SESSION_REFUSED/.test(a1.out), { code: a1.code, out: a1.out.slice(-300) });
ok('A1b 名册 sha256 前后不变（零写入）', sha(teamFile()) === before, { before, after: sha(teamFile()) });

// A2：--allow-missing 放行
const a2 = run(['rebind-sessions', '--root', SB, '--project', PROJECT, '--role', 'tester', '--session', 'session-not-exist-990c', '--allow-missing', '--yes', '--json'], { TEAM_MIGRATE_ENFORCE: '1' });
const team = JSON.parse(fs.readFileSync(teamFile(), 'utf8'));
const tester = (team.members || []).find((m) => m.role === 'tester') || {};
const auditLines = fs.existsSync(auditFile()) ? fs.readFileSync(auditFile(), 'utf8').split(/\r?\n/).filter(Boolean) : [];
const audit = auditLines.length ? JSON.parse(auditLines[auditLines.length - 1]) : {};
ok('A2 --allow-missing → 写入成功且名册 sessionId 已更新',
  a2.code === 0 && tester.sessionId === 'session-not-exist-990c', { code: a2.code, sessionId: tester.sessionId });
ok('A2b 审计行含 allowMissing:true 且字段齐全（at/by/role/from/to/reason）',
  audit.allowMissing === true && Boolean(audit.at) && Boolean(audit.by)
  && audit.role === 'tester' && Boolean(audit.from) && audit.to === 'session-not-exist-990c'
  && audit.reason === 'rebind_sessions', audit);

// A3：沙盘豁免（不设 TEAM_MIGRATE_ENFORCE，--root 沙盘）→ 不拦
const a3 = run(['rebind-sessions', '--root', SB, '--project', PROJECT, '--role', 'tester', '--session', 'session-also-not-exist', '--yes', '--json']);
ok('A3 沙盘豁免：不设 TEAM_MIGRATE_ENFORCE 时不会被门禁拦（4761 自有夹具不红）',
  a3.code === 0 && /"gateExempt":\s*true/.test(a3.out), { code: a3.code, out: a3.out.slice(-260) });

fs.rmSync(SB, { recursive: true, force: true });
const report = { task: 'B-20261118-083158-990c', at: new Date().toISOString(), total: results.length, pass, red: results.length - pass, results };
const outEnv = process.env.AWB_990C_OUT || path.join('_tmp', 'run-990c.json');
const outFile = path.isAbsolute(outEnv) ? outEnv : path.join(ROOT, outEnv);
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`\nREBIND_GATE ${JSON.stringify({ total: report.total, pass: report.pass, red: report.red })}`);
console.log('证据：' + outFile);
process.exit(report.red ? 1 : 0);
