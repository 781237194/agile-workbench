'use strict';
/**
 * R-c431 验收打回断言（Owner 2026-11-14 再报：验收只有通过、没有打回）
 * 只读源码 + 只读后端关键字，不启动窗口。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const ui = fs.readFileSync(path.join(ROOT, 'src/renderer/owner-review.js'), 'utf8');
const tools = fs.readFileSync(path.join(ROOT, 'src/team-tools.js'), 'utf8');
const ops = fs.readFileSync(path.join(ROOT, '团队/工具/lib/ops.mjs'), 'utf8');

const checks = [];
const push = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail }); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`); };

push('验收行有【通过】按钮 data-action=owner-accept', /'通过'/.test(ui) && /setAttribute\('data-action', 'owner-accept'\)/.test(ui));
push('验收行有【打回】按钮 data-action=owner-reject', /'打回'/.test(ui) && /setAttribute\('data-action', 'owner-reject'\)/.test(ui));
push('打回走独立确认按钮 owner-reject-confirm', /owner-reject-confirm/.test(ui));
push('确认框区分验收/打回两种文案', /确认打回/.test(ui) && /确认验收/.test(ui));
push('打回提示「回到可整改、不再出池」', /打回后该需求回到可整改/.test(ui));
push('打回原因为空时前端拦截', /if \(rejecting && !opinion\)/.test(ui) && /OWNER_OPINION_REQUIRED/.test(ui));
push('打回输入框标必填', /data-required/.test(ui) && /打回原因（必填/.test(ui));
push('提交时 decision 随模式切换为 rejected', /decision: rejecting \? 'rejected' : 'accepted'/.test(ui));
push('打回成功后列表刷新并提示不消失', /await loadData\(\)/.test(ui) && /已打回/.test(ui) && /PM 会收到打回原因/.test(ui));
push('后端 OWNER_OPINION_REQUIRED 兜底仍在', /OWNER_OPINION_REQUIRED/.test(tools));
push('后端验收决策认 rejected', /accepted: 'accepted'[\s\S]{0,120}reject: 'rejected'/.test(ops) || /rejected: 'rejected'/.test(ops));

const failed = checks.filter((row) => !row.ok);
console.log(`ACCEPT_REJECT_CHECK ${JSON.stringify({ ok: failed.length === 0, total: checks.length, failed: failed.length })}`);
process.exit(failed.length === 0 ? 0 : 1);
