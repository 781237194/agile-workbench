#!/usr/bin/env node
// 「评审范围收敛 + 跳过三方共决」静态/判据校验（B-1a5b）
// ①弹窗只在需求评审与验收阶段（阶段白名单）；②看板有建议拍板点；
// ③跳过=三方共决：三方齐全 + 多数通过（正则与实现一致）；④channel=skip_committee 落账字段。
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const or = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'owner-review.js'), 'utf8');
const main = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const tt = fs.readFileSync(path.join(ROOT, 'src', 'team-tools.js'), 'utf8');

const APPROVE_RE = /^(?!.*(?:不同意|不通过|不赞成|不可跳过|反对)).*(?:同意|通过|赞成|可跳过)/;
const committeePass = (votes) => {
  const list = [votes.analyst, votes.product, votes.dev].map((t) => String(t || '').trim());
  if (list.some((t) => !t)) return { ok: false, code: 'SKIP_COMMITTEE_INCOMPLETE' };
  const approveCount = list.filter((t) => APPROVE_RE.test(t)).length;
  return approveCount >= 2 ? { ok: true, approveCount } : { ok: false, code: 'SKIP_COMMITTEE_REJECTED', approveCount };
};

const checks = [];
const push = (name, ok, detail) => checks.push({ name, ok: Boolean(ok), detail: detail || '' });
push('弹窗阶段过滤函数', /function dialogStageAllowed\(\)/.test(or) && /dialogStageAllowed\(\)\) return;/.test(or));
push('阶段白名单=需求评审/Owner门/验收', /\['requirement_review', 'owner_review', 'owner_accept'\]/.test(or));
push('看板建议拍板点（data-suggest）', /data-suggest/.test(or) && /suggestTextOf\(/.test(or));
push('跳过按钮文案（本轮交 PM 跳过 语义）', /先跳过/.test(or) || /提交跳过/.test(or));
push('前端三方齐全校验', /三方未齐/.test(or) && /!analyst \|\| !product \|\| !dev/.test(or));
push('前端多数通过校验', /approveCount < 2/.test(or) && /至少 2 方同意/.test(or));
push('前端 channel=skip_committee', /skipChannel = 'skip_committee'/.test(or) && /channel: skipChannel/.test(or));
push('服务端三方齐全校验', /SKIP_COMMITTEE_INCOMPLETE/.test(main) && /SKIP_COMMITTEE_INCOMPLETE/.test(tt));
push('服务端多数通过校验', /SKIP_COMMITTEE_REJECTED/.test(main) && /SKIP_COMMITTEE_REJECTED/.test(tt));
push('服务端 committee 透传与落账', /committee \? \{ committee \}/.test(main) && /input\.committee \? \{ committee: input\.committee \}/.test(tt));
push('team-tools 通道白名单含 skip_committee', /\['ui', 'tty', 'proxy', 'skip_committee'\]/.test(tt));

// 判据样本（与实现同一正则）：三方齐全 + 2 同意 → 通过；1 同意 → 拒；缺一方 → 拒
const cases = [
  { name: '2/3 同意 → 通过', votes: { analyst: '同意，需求边界清楚', product: '同意先跳过', dev: '不同意，接口未定' }, expect: 'passed' },
  { name: '3/3 同意 → 通过', votes: { analyst: '同意', product: '赞成', dev: '可跳过' }, expect: 'passed' },
  { name: '1/3 同意 → 拒', votes: { analyst: '同意', product: '再等等', dev: '不同意' }, expect: 'SKIP_COMMITTEE_REJECTED' },
  { name: '缺产品意见 → 拒', votes: { analyst: '同意', product: '', dev: '同意' }, expect: 'SKIP_COMMITTEE_INCOMPLETE' },
];
const results = cases.map((c) => {
  const r = committeePass(c.votes);
  const got = r.ok ? 'passed' : r.code;
  return { name: c.name, got, expect: c.expect, ok: got === c.expect };
});
push('判据样本 4/4', results.every((r) => r.ok), JSON.stringify(results));

const failed = checks.filter((c) => !c.ok);
const report = { file: 'src/renderer/owner-review.js + main.js + team-tools.js', checks: checks.length, failed: failed.length, failures: failed, cases: results, ok: failed.length === 0 };
if (process.argv.includes('--json')) process.stdout.write(JSON.stringify(report, null, 2) + '\n');
else {
  for (const c of checks) console.log((c.ok ? 'PASS  ' : 'FAIL  ') + c.name + (c.detail ? ' · ' + c.detail : ''));
  console.log(report.ok ? 'SKIP_COMMITTEE_OK' : 'SKIP_COMMITTEE_FAIL');
}
process.exitCode = report.ok ? 0 : 1;
