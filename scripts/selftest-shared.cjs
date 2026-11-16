#!/usr/bin/env node
'use strict';
/**
 * selftest-shared.cjs — 共享层自检入口清单（宪法第 25 条 / B-20261116-190049-6d72 第④件）
 *
 * 目的：把「共享层必须防回归」的夹具集中到**唯一入口**，新建项目复制 团队/ 后也能直接跑。
 * 每个条目 {name, file, why}；新增回归夹具只往这里加一行，不要再散落在文档里。
 *
 * 用法：
 *   node scripts/selftest-shared.cjs            # 跑全部
 *   node scripts/selftest-shared.cjs --list     # 只列清单（名字 + 文件 + 用途）
 *   node scripts/selftest-shared.cjs --only notify-delivery   # 只跑某一条
 * 退出码：0 全过 / 1 有条目失败 / 2 环境错（文件缺失等）
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');

/** 共享层自检清单（唯一来源） */
const SHARED_CHECKS = [
  {
    name: 'notify-delivery',
    file: 'scripts/test-notify-delivery.cjs',
    why: '宪法第25条：通知/唤醒只投 to，禁广播禁抄送，自发自收不发回执通知不唤醒（P0）',
  },
];

const argv = process.argv.slice(2);
const listOnly = argv.includes('--list');
const onlyIdx = argv.indexOf('--only');
const only = onlyIdx >= 0 ? String(argv[onlyIdx + 1] || '') : '';

if (!SHARED_CHECKS.length) { console.log('ENV_FAIL 清单为空'); process.exit(2); }

if (listOnly) {
  for (const c of SHARED_CHECKS) console.log(`${c.name}\t${c.file}\t${c.why}`);
  process.exit(0);
}

const picked = only ? SHARED_CHECKS.filter((c) => c.name === only) : SHARED_CHECKS;
if (!picked.length) { console.log('ENV_FAIL 没有匹配条目：' + only); process.exit(2); }

let failed = 0;
const results = [];
for (const c of picked) {
  const file = path.join(ROOT, c.file);
  if (!fs.existsSync(file)) {
    console.log(`MISSING  ${c.name} · ${c.file} 不存在`);
    results.push({ name: c.name, ok: false, why: 'file-missing' });
    failed += 1;
    continue;
  }
  let exitCode = 0;
  let out = '';
  try {
    out = execFileSync(process.execPath, [file], { cwd: ROOT, encoding: 'utf8', timeout: 600000 });
  } catch (e) {
    exitCode = e.status == null ? -1 : e.status;
    out = String((e.stdout || '') + (e.stderr || ''));
  }
  const tail = out.trim().split(/\r?\n/).slice(-1)[0] || '';
  const ok = exitCode === 0;
  if (!ok) failed += 1;
  results.push({ name: c.name, ok, exitCode, tail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${c.name} · exit=${exitCode} · ${tail.slice(0, 120)}`);
}

console.log(`\n共享层自检：${results.length - failed}/${results.length} 通过`);
if (failed) { console.log(JSON.stringify(results.filter((r) => !r.ok), null, 2)); process.exit(1); }
