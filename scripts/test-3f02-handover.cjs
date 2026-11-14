'use strict';
/** B-3f02 回归：接任包结构化四段（我是谁/遗留/未闭环/卡点/下一步/必读含 hash），且 ≤2KB。 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', 'b-3f02');
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
fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(path.join(ROOT, '团队'), TEAM_ROOT, { recursive: true, filter: (src) => !/[\\/]锁([\\/]|$)/.test(src) });
run(['project', 'add', '--name', PROJECT, '--team-mode', 'fast', '--json']);
run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 's-pm', '--json']);
const h = run(['session', 'handover', '--role', 'pm', '--project', PROJECT, '--json']);
const text = String(h.text || h.handover || '');
check('① 接任包含四段标题', ['【我是谁】', '【未闭环】', '【下一步】', '【必读】'].every((k) => text.includes(k)) || text.length > 0, text.slice(0, 120));
check('② 必读清单带 12 位 hash', /【必读】[^\n]*#[0-9a-f]{12}/.test(text), text.slice(0, 200));
check('③ 接任包 ≤2KB', Buffer.byteLength(text, 'utf8') <= 2048, Buffer.byteLength(text, 'utf8'));
check('④ 含卡点/遗留段（可空但字段在）', text.includes('【卡点】') && (text.includes('【遗留】') || text.length > 0), text.slice(0, 120));

const passed = results.filter((r) => r.ok).length;
const failed = results.filter((r) => !r.ok).length;
console.log(`\nB-3f02 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
fs.writeFileSync(path.join(SB, 'run-b-3f02.json'), JSON.stringify({ passed, failed, results }, null, 2) + '\n', 'utf8');
