#!/usr/bin/env node
/**
 * scripts/test-notice-prompt.cjs —— B-20261117-200232-b6f9 回归
 *
 * 缺陷：唤醒模板把 PM 下发的指令一律标成「回复/通知，不必为它新建任务」，
 *       角色被唤醒后只回执不执行，PM 只能手动逐条派单（Owner 认定临时解决）。
 * 热修：提交 d85b06b（2026-11-17 20:02）
 *   · 团队/工具/lib/dispatch.mjs → buildNoticePrompt() 增加 from==='pm' && to!=='pm' 分支
 *   · src/team-tools.js          → 同一逻辑的壳内实现（noticeText 三选一）
 *
 * 本脚本断言（不依赖真实邮箱/唤醒，纯模板层 + 两处实现一致性）：
 *   ① PM → role：必须含「需要你执行 / 立即按正文做 / 完成回执」，且**不得**含「不必为它新建任务」
 *   ② role → PM：必须保留通知口径（「不是新派单」「不必为它新建任务」「只 ack」），且不得含「需要你执行」
 *   ③ role → role：同 ②（不得把同事的消息也当派单）
 *   ④ 壳内实现（src/team-tools.js）的 PM 分支：同样含执行要求、不含「不必为它新建任务」
 *   ⑤ 壳内实现的通知分支：仍保留「不必为它新建任务 + 只 ack」
 *   ⑥ 两处实现口径一致：关键短语集合相同（逐字差异只记录，不判红——见报告注记）
 *   ⑦ 反例护栏：PM 分支不得退化成「整段通知口径」（即不得同时出现「不必为它新建任务」）
 *
 * 用法：node scripts/test-notice-prompt.cjs [--json]
 * 退出码：0 全绿；1 有红；2 崩溃。
 */
'use strict';
const fs = require('fs');
const path = require('path');

const jsonOut = process.argv.includes('--json');

function findRoot(start) {
  let dir = start;
  for (let i = 0; i < 8; i += 1) {
    if (fs.existsSync(path.join(dir, '团队', '工具', 'team.mjs'))) return dir;
    const up = path.dirname(dir);
    if (up === dir) break;
    dir = up;
  }
  throw new Error('找不到仓库根（含 团队/工具/team.mjs）');
}
const ROOT = findRoot(__dirname);
const PROJECT = '工作台改造修复';
const DISPATCH = path.join(ROOT, '团队', '工具', 'lib', 'dispatch.mjs');
const TEAM_TOOLS = path.join(ROOT, 'src', 'team-tools.js');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail });
  return { name, ok: Boolean(ok), detail };
}
const has = (s, k) => String(s || '').includes(k);
const norm = (s) => String(s || '').replace(/\*\*/g, '').replace(/[“”"']/g, '').replace(/\s+/g, '');

/** 从 src/team-tools.js 静态提取 noticeText 的两个分支字面量（不 require 该文件：它依赖 Electron 运行时） */
function extractTeamToolsBranches(src) {
  const anchor = src.indexOf('pmInstruction');
  if (anchor < 0) return { ok: false, why: '未找到 pmInstruction 分支（壳内实现被改动或回退）' };
  const tail = src.slice(anchor, anchor + 3000);
  // 兼容实际排版：`pmInstruction\n ? [ ... ].join('\n')\n : [ ... ].join('\n')`
  const m = tail.match(/\?[\s\S]{0,20}\[([\s\S]*?)\]\s*\.join\(\s*'\\n'\s*\)\s*:\s*\[([\s\S]*?)\]\s*\.join\(\s*'\\n'\s*\)/);
  if (!m) return { ok: false, why: '壳内实现的三元分支结构无法定位（? [ ... ].join 与 : [ ... ].join 未配对）' };
  // 单引号字符串 + 反引号模板串都要收（壳内「请按需读取…只 ack」那行是模板串）
  const strings = (part) => {
    const out = [];
    for (const mm of part.matchAll(/'([^']*)'|`([^`]*)`/g)) out.push(mm[1] !== undefined ? mm[1] : mm[2]);
    return out;
  };
  const pmStrings = strings(m[1]);
  const noticeStrings = strings(m[2]);
  if (!pmStrings.length || !noticeStrings.length) return { ok: false, why: '分支内未提取到字符串字面量' };
  return { ok: true, pmText: pmStrings.join('\n'), noticeText: noticeStrings.join('\n'), pmStrings, noticeStrings };
}

/** 关键短语集合（用于「两处口径一致」判断，不看逐字） */
const PM_CLAUSES = ['需要你执行', '立即按正文做', '完成回执', '已读', '需要明确', '卡点'];
const NOTICE_CLAUSES = ['不是新派单', '不必为它新建任务', '只 ack', '已读/已回执'];
const clauseSet = (text, list) => list.filter((k) => norm(text).includes(norm(k)));

async function main() {
  const mod = await import('file:///' + DISPATCH.replace(/\\/g, '/'));
  const build = mod.buildNoticePrompt || (mod.default && mod.default.buildNoticePrompt);
  if (typeof build !== 'function') {
    check('入口：dispatch.mjs 导出 buildNoticePrompt', false, { found: Object.keys(mod).slice(0, 12) });
    return finish();
  }
  const base = { project: PROJECT, teamTool: path.join(ROOT, '团队', '工具', 'team.mjs'), body: '正文占位' };
  const pmToRole = build({ ...base, to: 'tester', messageId: 'M-T1', subject: '请执行一个小动作', from: 'pm' });
  const roleToPm = build({ ...base, to: 'pm', messageId: 'M-T2', subject: '回执', from: 'tester' });
  const roleToRole = build({ ...base, to: 'tester', messageId: 'M-T3', subject: '通知', from: 'programmer1' });

  // ① PM → role
  const a1Need = ['需要你执行', '立即按正文做', '完成回执'].every((k) => has(pmToRole, k));
  const a1NoNotice = !has(pmToRole, '不必为它新建任务');
  check('① PM → role 模板含执行要求（需要你执行/立即按正文做/完成回执）且不含「不必为它新建任务」',
    a1Need && a1NoNotice, { needClauses: a1Need, noNoticeClause: a1NoNotice, text: pmToRole.slice(0, 300) });

  // ② role → PM
  const a2 = has(roleToPm, '不是新派单') && has(roleToPm, '不必为它新建任务') && has(roleToPm, '只 ack') && !has(roleToPm, '需要你执行');
  check('② role → PM 保留通知口径（不是新派单/不必为它新建任务/只 ack），且不出现执行要求',
    a2, { text: roleToPm.slice(0, 300) });

  // ③ role → role
  const a3 = has(roleToRole, '不是新派单') && has(roleToRole, '不必为它新建任务') && !has(roleToRole, '需要你执行');
  check('③ role → role 保留通知口径，且不出现执行要求',
    a3, { text: roleToRole.slice(0, 300) });

  // ④⑤⑥ T-20261117-204902-ca6b：文案抽单一来源（团队/工具/lib/wake-text.cjs），两处产出必须**逐字一致**
  const WAKE_TEXT = path.join(ROOT, '团队', '工具', 'lib', 'wake-text.cjs');
  const ttSrc = fs.readFileSync(TEAM_TOOLS, 'utf8');
  const dispSrc = fs.readFileSync(DISPATCH, 'utf8');
  const singleSource = fs.existsSync(WAKE_TEXT)
    && /wake-text\.cjs/.test(dispSrc)
    && /wake-text\.cjs/.test(ttSrc)
    && /buildNoticeTextFromTool\(/.test(ttSrc);
  check('④ 两处都从同一来源取文案（dispatch.mjs 与 src/team-tools.js 都指向 lib/wake-text.cjs）',
    singleSource, { wakeTextExists: fs.existsSync(WAKE_TEXT), dispatchRef: /wake-text\.cjs/.test(dispSrc), shellRef: /wake-text\.cjs/.test(ttSrc), shellUsesHelper: /buildNoticeTextFromTool\(/.test(ttSrc) });

  const wt = require(WAKE_TEXT);
  const cases = [
    { name: 'PM → role', args: { ...base, to: 'tester', messageId: 'M-T1', subject: '请执行一个小动作', from: 'pm' } },
    { name: 'role → PM', args: { ...base, to: 'pm', messageId: 'M-T2', subject: '回执', from: 'tester' } },
    { name: 'role → role', args: { ...base, to: 'tester', messageId: 'M-T3', subject: '通知', from: 'programmer1' } },
  ];
  const pairs = cases.map((c) => ({ name: c.name, a: build(c.args), b: wt.buildNoticePrompt(c.args) }));
  const allIdentical = pairs.every((d) => d.a === d.b);
  check('⑤ 两处产出逐字相等（dispatch.mjs 与 wake-text.cjs，PM/role/role 三个样本 byte 级相同）',
    allIdentical, { pairs: pairs.map((d) => ({ name: d.name, dispatchLen: d.a.length, sourceLen: d.b.length, equal: d.a === d.b })) });

  const hasLocalCopy = /这条是回复\/通知/.test(ttSrc);
  const shellDelegates = /buildNoticeTextFromTool\(\{/.test(ttSrc) && !/pmInstruction\s*\?/.test(ttSrc);
  check('⑤b 壳内不再保留本地文案（改调 buildNoticeTextFromTool，源码里没有「这条是回复/通知」这类字面量）',
    shellDelegates && !hasLocalCopy, { delegates: shellDelegates, hasLocalCopy });

  check('⑥ 两处实现口径一致 → 已升级为逐字断言（见 ⑤，不再是「关键短语集合相同」）', allIdentical, { upgradedFrom: 'clause-set' });

  // ⑦ 反例护栏：PM 分支不得退化成「整段通知口径」

  const a7 = has(pmToRole, '需要你执行') && has(pmToRole, '已执行 <做了什么>') && !has(pmToRole, '只回一行：已读/已回执');
  check('⑦ 反例护栏：PM 分支回执口径为「已执行/需处理/已读」，未退化成通知分支的「只回一行：已读/已回执」',
    a7, { hasExecutedLine: has(pmToRole, '已执行 <做了什么>'), hasNoticeOnlyLine: has(pmToRole, '只回一行：已读/已回执') });
  return finish();
}

function finish() {
  const total = results.length;
  const pass = results.filter((r) => r.ok).length;
  const red = total - pass;
  const payload = {
    at: new Date().toISOString(),
    script: 'scripts/test-notice-prompt.cjs',
    bug: 'B-20261117-200232-b6f9',
    hotfixCommit: 'd85b06b',
    total, pass, red, results,
  };
  const evDir = path.join(ROOT, '项目', PROJECT, '测试人员', '产出', '证据-b6f9');
  try { fs.mkdirSync(evDir, { recursive: true }); } catch { /* ignore */ }
  const tsName = new Date().toISOString().replace(/[:.]/g, '-');
  const evFile = path.join(evDir, `run-${tsName}-${red === 0 ? 'green' : 'red'}.json`);
  try {
    payload.evidenceFile = path.relative(ROOT, evFile).replace(/\\/g, '/');
    fs.writeFileSync(evFile, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  } catch { /* ignore */ }
  if (jsonOut) {
    process.stdout.write(JSON.stringify(payload, null, 2) + '\n');
  } else {
    for (const r of results) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}`);
    console.log('');
    console.log(`${red === 0 ? 'NOTICE_PROMPT_OK' : 'NOTICE_PROMPT_WARN'} ${JSON.stringify({ total, pass, red })}`);
    if (payload.evidenceFile) console.log(`证据：${payload.evidenceFile}`);
  }
  process.exit(red === 0 ? 0 : 1);
}

main().catch((e) => { console.error('CRASH', String((e && e.stack) || e)); process.exit(2); });
