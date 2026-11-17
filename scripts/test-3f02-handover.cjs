'use strict';
const { rmSandbox, uniqueSandbox } = require('./lib/sandbox-dir.cjs'); // B-07b6 A：沙盘清理统一走重试助手
/** B-3f02 回归：接任包结构化四段（我是谁/遗留/未闭环/卡点/下一步/必读含 hash），且 ≤2KB。 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = uniqueSandbox('b-3f02');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const PROJECT = '接任沙盘';
const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 260)}`);
  if (!ok) process.exitCode = 1;
}
function run(args) {
  const out = execFileSync(process.execPath, [TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
  const t = String(out).trim();
  return JSON.parse(t.slice(t.indexOf('{')));
}
rmSandbox(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true, filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) });
run(['project', 'add', '--name', PROJECT, '--team-mode', 'fast', '--json']);
run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-pm', '--json']);
const h = run(['session', 'handover', '--role', 'pm', '--project', PROJECT, '--json']);
const text = String(h.text || h.handover || '');
const SIX = ['【你是谁】', '【在途任务】', '【未闭环事项】', '【最近决策】', '【建议下一步】', '【遗留问题与坑】'];
check('① 接任包六小节齐全', SIX.every((k) => text.includes(k)), SIX.filter((k) => !text.includes(k)));
check('① 遗留段空时写「无已知坑」', text.includes('无已知坑') || text.includes('ARCHIVE_DEFERRED'), text.slice(0, 160));
check('② 必读清单带 12 位 hash', /【必读】[^\n]*#[0-9a-f]{12}/.test(text), text.slice(0, 200));
check('③ 接任包 ≤2KB', Buffer.byteLength(text, 'utf8') <= 2048, Buffer.byteLength(text, 'utf8'));
check('④ 含未闭环/遗留段', text.includes('【未闭环事项】') && text.includes('【遗留问题与坑】'), text.slice(0, 120));

// ⑤ 机械检查：缺必填小节 → 拒；缺遗留坑 → 只标红
(async () => {
  const lib = await import('file:///' + path.join(TEAM_ROOT, '工具', 'lib', 'session.mjs').replace(/\\/g, '/'));
  const broken = '【你是谁】x\n【在途任务】无\n【最近决策】无\n【建议下一步】无\n【遗留问题与坑】无已知坑';
  const v1 = lib.validateHandover(broken);
  check('⑤ 缺【未闭环事项】→ missingRequired 命中', v1.ok === false && v1.missingRequired.includes('未闭环事项'), v1.missingRequired);
  const broken2 = '【你是谁】x\n【在途任务】无\n【未闭环事项】无\n【最近决策】无\n【建议下一步】无';
  const v2 = lib.validateHandover(broken2);
  check('⑤ 缺【遗留问题与坑】→ 只标红不拒', v2.ok === true && v2.redFlags.length > 0, { ok: v2.ok, redFlags: v2.redFlags });
  check('⑤ 完整接任包 → ok=true', lib.validateHandover(text).ok === true, lib.validateHandover(text));

  // ⑥ 换人优先级：档位升序 + 状态/在途/需准备字段
  const pri = run(['session', 'priority', '--project', PROJECT, '--json']);
  const rows = pri.rows || [];
  const tiers = rows.map((r) => r.tier);
  check('⑥ 优先级列表按档位升序', rows.length > 0 && JSON.stringify(tiers) === JSON.stringify([...tiers].sort((a, b) => a - b)), tiers);
  check('⑥ 每行带状态/在途/需准备', rows.every((r) => r.state && Number.isFinite(r.inflight) && typeof r.needPrep === 'boolean'), rows.slice(0, 2));

  // ⑦ 增量：20秒摘要 / 代管状态 / 换人原因字段 / why+blockedBy
  check('⑦ 含【20秒摘要】三行开头', text.includes('【20秒摘要】'), text.slice(0, 120));
  check('⑦ 【你是谁】含代管状态与换人原因', /【你是谁】[\s\S]*代管：/.test(text) && /换人原因：/.test(text), text.slice(0, 200));
  check('⑦ handoverMeta 带 handoffReason{kind,by,at,note}', Boolean(h.handoffReason && h.handoffReason.kind && h.handoffReason.by && h.handoffReason.at && h.handoffReason.note !== undefined), h.handoffReason);
  check('⑦ 在途任务带 why（及可选 blockedBy）', /【在途任务】[^\n]*why=/.test(text) || text.includes('【在途任务】无'), text.slice(0, 200));
  const passed2 = results.filter((r) => r.ok).length;
  const failed2 = results.filter((r) => !r.ok).length;
  console.log(`\nB-3f02 断言：${passed2}/${results.length} PASS${failed2 ? `，${failed2} FAIL` : ''}`);
  fs.writeFileSync(path.join(SB, 'run-b-3f02.json'), JSON.stringify({ passed: passed2, failed: failed2, results }, null, 2) + '\n', 'utf8');
})();
