#!/usr/bin/env node
/**
 * 提交范围守护（全队规矩，2026-11-15 PM M-20261115-153317-86ea2e）：
 *   「提交只加自己改的文件，禁止 git add -A / git commit -a 整树带别人的改动」
 *
 * 背景：7d2ac98 用 `git add <我的两个文件>` 提交，但 团队/工具/lib/ops.mjs 这个**共享文件里同时躺着
 * 程序员A 未提交的 62b9 E1/E2 改动**（task accept --as / acceptDefectTask 的 byRole 等 48 行），
 * 于是整段被一起提交、审计里分不清谁改了什么。文件级 add 挡不住「同一文件里混着别人的改动」，
 * 所以本脚本做两件事：①文件范围核对（staged 集合 == 你声明的集合）；②按函数给出 staged 改动块，
 * 让你在提交前肉眼核一遍「这些块是不是都是我写的」。
 *
 * 用法：
 *   node scripts/check-commit-scope.cjs --expect 团队/工具/lib/ops.mjs --expect scripts/x.cjs
 *   node scripts/check-commit-scope.cjs --expect <file> --hunks        # 附带每个文件的函数级改动块
 *   node scripts/check-commit-scope.cjs --expect <file> --json         # 机器可读
 * 退出码：0=范围一致 / 1=范围不一致（有多余或漏加）/ 2=用法或 git 调用失败
 *
 * 建议接法（可选，不自动装）：`.git/hooks/pre-commit` 里调用本脚本并传 `--expect-file .commit-scope`，
 * 或提交前手动跑一次。本脚本只读（git diff/status），不改任何文件。
 */
'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

function usage(msg) {
  console.error(`[check-commit-scope] ${msg}\n用法：node scripts/check-commit-scope.cjs --expect <文件> [--expect <文件> ...] [--hunks] [--json]`);
  process.exit(2);
}

const argv = process.argv.slice(2);
const expects = [];
let showHunks = false;
let asJson = false;
let expectFile = '';
for (let i = 0; i < argv.length; i += 1) {
  const a = argv[i];
  if (a === '--expect') {
    if (!argv[i + 1]) usage('--expect 后面要跟文件路径');
    expects.push(argv[i + 1]); i += 1;
  } else if (a === '--expect-file') {
    if (!argv[i + 1]) usage('--expect-file 后面要跟清单文件');
    expectFile = argv[i + 1]; i += 1;
  } else if (a === '--hunks') showHunks = true;
  else if (a === '--json') asJson = true;
  else if (a === '-h' || a === '--help') usage('提交范围守护');
  else usage(`未知参数：${a}`);
}

function git(args) {
  try {
    return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 }).replace(/\r?\n$/, '');
  } catch (e) {
    console.error(`[check-commit-scope] git ${args.join(' ')} 失败：${(e && e.message) || e}`);
    process.exit(2);
  }
}

let expectList = [...expects];
if (expectFile) {
  const fs = require('node:fs');
  if (!fs.existsSync(expectFile)) usage(`清单文件不存在：${expectFile}`);
  for (const line of fs.readFileSync(expectFile, 'utf8').split(/\r?\n/)) {
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    expectList.push(t);
  }
}
const norm = (p) => String(p || '').replace(/\\/g, '/').replace(/^\.\//, '').trim();
expectList = [...new Set(expectList.map(norm).filter(Boolean))];
if (!expectList.length) usage('至少要声明一个 --expect（你要提交的文件）');

// 1) staged 集合
const stagedRaw = git(['diff', '--cached', '--name-only']).split(/\r?\n/).filter(Boolean).map(norm);
const staged = [...new Set(stagedRaw)];
const extra = staged.filter((f) => !expectList.includes(f));
const missing = expectList.filter((f) => !staged.includes(f));
// 2) 工作树里"改了但没 staged"的文件（提醒：可能是别人正在改的，别手滑 add -A）
const dirtyRaw = git(['status', '--porcelain']).split(/\r?\n/).filter(Boolean);
const dirty = dirtyRaw.map((line) => ({ code: line.slice(0, 2).trim(), file: norm(line.slice(3)) }))
  .filter((row) => row.file && !staged.includes(row.file));

// 3) 每个文件的函数级改动块（提交前肉眼核对归属）
const hunks = {};
if (showHunks) {
  for (const file of staged) {
    let diff = '';
    // 用默认上下文（-U3）：git 会把所在函数名放进 @@ … @@ 尾部；文件开头/函数名取不到时，
    // 用该块第一条改动行当提示，照样能看出"这块大概是谁的改动"。
    try { diff = git(['diff', '--cached', '--', file]); } catch { diff = ''; }
    const blocks = [];
    let cur = null;
    for (const line of diff.split(/\r?\n/)) {
      if (line.startsWith('@@')) {
        const m = /^@@[^@]*@@\s*(.*)$/.exec(line);
        cur = { ctx: m ? m[1].trim() : '', where: (line.match(/^@@\s+([^@]*?)\s+@@/) || [])[1] || '', hint: '' };
        blocks.push(cur);
        continue;
      }
      if (!cur || cur.hint) continue;
      if (line.startsWith('+') && !line.startsWith('+++')) cur.hint = line.slice(1).trim();
      else if (line.startsWith(' ')) cur.hint = line.trim();
    }
    hunks[file] = blocks
      .map((b) => {
        const label = b.ctx || b.hint || '（无上下文）';
        return `${label.slice(0, 90)}  [${b.where}]`;
      })
      .filter(Boolean);
  }
}

const ok = extra.length === 0 && missing.length === 0;
const result = {
  ok,
  staged,
  expect: expectList,
  extra,
  missing,
  dirtyNotStaged: dirty,
  ...(showHunks ? { hunks } : {}),
  hint: ok
    ? '范围一致：staged 的文件与你声明的完全一致。'
    : '范围不一致：先 git restore --staged <多余文件> 去掉不属于你的；漏加的先 git add；再复跑本脚本。',
};

if (asJson) {
  process.stdout.write(JSON.stringify(result) + '\n');
} else {
  console.log(`staged（${staged.length}）：${staged.join('、') || '(空)'}`);
  console.log(`声明（${expectList.length}）：${expectList.join('、')}`);
  if (extra.length) console.log(`✗ 多余（不属于你 / 没打算提交）：${extra.join('、')}`);
  if (missing.length) console.log(`✗ 漏加（声明了但没 staged）：${missing.join('、')}`);
  if (!ok) {
    console.log(result.hint);
    if (dirty.length) {
      console.log('提示：工作树里这些改动**没有**进本次提交（多半是别人的，别 git add -A）：');
      for (const row of dirty.slice(0, 20)) console.log(`  ${row.code} ${row.file}`);
    }
  } else {
    console.log('✓ 范围一致');
  }
  if (showHunks) {
    console.log('\n按函数看 staged 改动块（核对每一块都是你写的）：');
    for (const [file, list] of Object.entries(hunks)) {
      console.log(`- ${file}：${list.length} 块`);
      for (const h of list) console.log(`    ${h}`);
    }
  }
}
process.exit(ok ? 0 : 1);
