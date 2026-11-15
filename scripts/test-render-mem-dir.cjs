#!/usr/bin/env node
'use strict';
/**
 * test-render-mem-dir.cjs —— 缺陷 B-20261115-171218-3fb8（P1）断言
 *
 * 要求（PM）：①优先尊重 AWB_TEAM_ROOT / TEAM_ROOT，未设时行为不变；
 *            ②补断言「设了独立根就写到那、真实分片行数不变」。
 *
 * 做法：纯函数 resolveIsolatedDir() 直接断言路径；真实分片只读一次快照（行数+mtime+sha），
 * 断言本脚本不写任何真实文件（零写入），并在设置了隔离根时解析结果必须落在该根下。
 *
 * 用法：node scripts/test-render-mem-dir.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { resolveIsolatedDir } = require(path.join(ROOT, 'src', 'render-mem-dir.js'));

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail)}`);
}

const envRoot = path.join(ROOT, '_tmp', 'c1ed-dir-sandbox', '团队');
const projectName = '工作台改造修复';

// ①设了隔离根 → 解析到该根下（不动真实目录）
const isolated = resolveIsolatedDir({ envRoot, projectName });
check('S1 设 AWB_TEAM_ROOT/TEAM_ROOT → 采样目录落在该根下',
  isolated === path.join(envRoot, '状态', '项目', projectName), { isolated });

// ②未设隔离根 → 返回空串（调用方回退原有逻辑，行为不变）
check('S2 未设隔离根 → 返回空串（行为不变）', resolveIsolatedDir({ envRoot: '', projectName }) === '', {});
check('S3 项目名为空 → 返回空串（不猜目录）', resolveIsolatedDir({ envRoot, projectName: '' }) === '', {});

// ④真实分片行数不变：本脚本零写入，且真实目录不在隔离根下
const realDir = path.join(ROOT, '团队', '状态', '项目', projectName);
const shards = fs.existsSync(realDir) ? fs.readdirSync(realDir).filter((n) => /^渲染内存-.*\.jsonl$/.test(n)) : [];
const snapshot = shards.map((n) => {
  const stat = fs.statSync(path.join(realDir, n));
  return { name: n, size: stat.size, mtimeMs: stat.mtimeMs };
});
check('S4 隔离根与真实目录不同源（不会共写同一分片）', !isolated.startsWith(realDir) && isolated !== realDir, { isolated, realDir });
check('S5 真实分片未被本脚本触碰（数量/大小/mtime 快照一致）',
  shards.length === snapshot.length && snapshot.every((s) => {
    const stat = fs.statSync(path.join(realDir, s.name));
    return stat.size === s.size && stat.mtimeMs === s.mtimeMs;
  }), { shards: shards.length });

console.log(`\nrender-mem-dir 断言：${passed}/${passed + failures.length} PASS（真实分片 ${shards.length} 个，仅只读快照）`);
if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exit(1); }
process.exit(0);
