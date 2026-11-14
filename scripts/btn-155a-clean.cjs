'use strict';
/**
 * B-155a 清理脚本（B-a17d 起改为「一条命令处理多条」，走 team.mjs 的批量入口）。
 *
 * 权限：req register / req void 只对 pm / 需求分析 / 产品开放——必须用 PM 令牌跑：
 *   node 团队\工具\team.mjs boot --role pm --project "工作台改造修复" --json   ← 拿 token
 *   node scripts/btn-155a-clean.cjs <pm-token> [--dry-run]
 *
 * 注意：2026-11-15 04:42 PM 已经清理过这 12 条（register 2 + void 10），脚本幂等可重跑；
 *       作废登记现在落 <项目根>/需求/作废登记.jsonl（旧版曾误写仓库根，已由
 *       scripts/migrate-155a-void-registry.cjs 迁移并修正）。
 */
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const PROJECT = '工作台改造修复';
const token = String(process.argv[2] || '').trim();
const dryRun = process.argv.includes('--dry-run');
if (!token) { console.error('用法：node scripts/btn-155a-clean.cjs <pm-token> [--dry-run]'); process.exit(2); }

const REGISTER = [
  { id: 'R-20261113-015208-ba18', title: '敏捷并行协同：互询、并行开发、并行看板、提案回执去留' },
  { id: 'R-20261114-144138-550f', title: '消息唤醒下一批：忙碌排队 / pending_wake' },
];
const VOID = [
  'R-20261113-000757-4720', 'R-20261113-004109-68f7', 'R-20261113-043814-bb1e',
  'R-20261113-213257-3f0d', 'R-20261113-213257-46d9', 'R-20261113-225803-e5f4',
  'R-20261114-001010-2742', 'R-20261114-001012-b888', 'R-20261114-001013-533e', 'R-20261114-001013-ff75',
];
const VOID_REASON = '11-13/11-14 需求池录入未登记工作流（无正文），按 B-155a 作废';

function run(args) {
  try {
    const out = execFileSync(process.execPath, [TOOL, ...args], { cwd: ROOT, encoding: 'utf8' });
    const t = String(out).trim();
    return JSON.parse(t.slice(t.indexOf('{')));
  } catch (e) {
    const text = String((e && e.stdout) || '') + String((e && e.stderr) || '');
    try { return JSON.parse(text.slice(text.indexOf('{'))); } catch { return { ok: false, code: 'PARSE_FAIL', raw: text.slice(0, 300) }; }
  }
}

if (dryRun) {
  console.log(`[dry] register ${REGISTER.map((item) => item.id).join(',')}`);
  console.log(`[dry] void ${VOID.join(',')}`);
  process.exit(0);
}

// register：标题逐条不同 → 用 --from-file（每行一条 JSON）
const specFile = path.join(ROOT, '_tmp', 'btn-155a-register.jsonl');
require('node:fs').mkdirSync(path.dirname(specFile), { recursive: true });
require('node:fs').writeFileSync(specFile, REGISTER.map((item) => JSON.stringify(item)).join('\n') + '\n', 'utf8');
const reg = run(['req', 'register', '--boot', token, '--project', PROJECT, '--from-file', specFile, '--json']);
console.log(`register 批量：${reg.ok ? `OK ${reg.okCount}/${reg.total}` : `FAIL ${reg.code || ''}`}`);

// void：一条命令处理 10 条
const voi = run(['req', 'void', '--boot', token, '--project', PROJECT, '--ids', VOID.join(','), '--reason', VOID_REASON, '--json']);
console.log(`void 批量：${voi.ok ? `OK ${voi.okCount}/${voi.total}` : `FAIL ${voi.code || ''}`}（幂等时 okCount 计入已作废）`);

// 收尾自检：双向同步断言（0 违规才算清理完成）
const sync = run(['req', 'sync', '--boot', token, '--project', PROJECT, '--json']);
console.log(`同步检查：${sync.ok ? 'PASS（0 违规）' : `FAIL ${(sync.violations || []).length} 条违规`}`);
for (const row of sync.violations || []) console.log(`  - [${row.rule}] ${row.id || row.file || ''} ${row.message || ''}`);
process.exitCode = sync.ok ? 0 : 1;
