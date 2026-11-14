#!/usr/bin/env node
// R-b417 弹窗「说人话」+ T-a3e1「怎么做/建议拍板」静态校验（程序员B）：
// ①固定选择器齐全；②裸代号检查函数存在；③看板/清单文案不含裸代号（模板与映射文案）；
// ④看板每条有怎么做/建议拍板，且只列本轮需求。
// 用法：node scripts/test-owner-copy.cjs [--json]
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const FILE = path.join(ROOT, 'src', 'renderer', 'owner-review.js');
const src = fs.readFileSync(FILE, 'utf8');

const selectors = [
  'data-owner-board', 'data-owner-board-item', 'data-what', 'data-how', 'data-advice', 'data-blocked', 'data-impact',
  'data-owner-eval', 'data-owner-eval-item', 'data-eval-what', 'data-eval-why', 'data-eval-risk',
  'data-owner-material', 'data-owner-opinion', 'data-owner-back',
];
const checks = [];
const push = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail || '' });

for (const sel of selectors) push('选择器 ' + sel, new RegExp(sel.replace(/-/g, '\\-')).test(src));
push('裸代号检查函数', /window\.__awbCheckOwnerCopy = function awbCheckOwnerCopy/.test(src));
push('代号移括号（humanizeTitle）', /function humanizeTitle\(/.test(src) && /这项需求（/.test(src));
push('字段截断（clip60 ≤60/≤80）', /function clip60\(text, max = 60\)/.test(src) && /clip60\(humanizeTitle\(row\.title\), 80\)/.test(src));
push('三要素模板无裸代号', /为什么需要你定：/.test(src) && /不定会怎样：/.test(src));
push('待评估空态', /暂无需要你评估的事/.test(src));
push('返回按钮不清选中', /data-owner-back[\s\S]{0,160}scrollTop = 0/.test(src) && /list\.scrollTop = 0;\s*\n\s*renderDialog\(\);/.test(src));

// T-a3e1：看板补「怎么做 / 建议拍板点」+ 只看本轮需求。
push('怎么做文案函数', /function howTextOf\(/.test(src) && /功能点|方案要点|实现要点/.test(src));
push('建议拍板函数', /function adviceTextOf\(/.test(src) && /建议你定：/.test(src));
push('本轮过滤（round）', /function currentRoundOf\(/.test(src) && /row\.round\) \|\| 1\) === round/.test(src));
push('看板标题写明本轮', /本轮需求（第 \$\{round\} 轮）/.test(src));
push('怎么做/建议截断 ≤60', /clip60\(howTextOf\(req\)\)/.test(src) && /const advice = clip60\(adviceTextOf\(req, pending\)\)/.test(src));
push('本轮序号落 DOM', /setAttribute\('data-owner-board-round', String\(round\)\)/.test(src));
push('看板三问行含怎么做', /怎么做：\$\{esc\(how\)\}/.test(src));

// 裸代号静态扫描：模板字符串里的中文文案（含“干什么/卡在哪/影响谁/是什么/为什么/不定”行）不得出现裸代号
const bareCode = /\bR-\d{8,}-\w+\b|\bG\d+\b|\bAC\d+(\.\d+)?\b/;
const templateLines = src.split(/\r?\n/).filter((line) => /data-owner-board|data-owner-eval|or-board-title|or-eval-title|为什么需要你定|不定会怎样|卡在等你决定|怎么做：/.test(line));
const bareHits = templateLines.filter((line) => {
  const stripped = line.replace(/（[^）]*）/g, ' ').replace(/\([^)]*\)/g, ' ');
  return bareCode.test(stripped);
});
push('看板/清单文案裸代号 0 命中', bareHits.length === 0, bareHits.slice(0, 5).join(' | '));

const failed = checks.filter((c) => !c.ok);
const report = { file: path.relative(ROOT, FILE).replace(/\\/g, '/'), checks: checks.length, failed: failed.length, failures: failed, ok: failed.length === 0 };
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else {
  for (const c of checks) console.log((c.ok ? 'PASS  ' : 'FAIL  ') + c.name + (c.detail ? ' · ' + c.detail : ''));
  console.log(report.ok ? 'OWNER_COPY_OK' : 'OWNER_COPY_FAIL');
}
process.exitCode = report.ok ? 0 : 1;
