#!/usr/bin/env node
'use strict';
/**
 * measure-boot-payload.cjs —— T-20261120-034649-47ec（只读 spike，不改生产行为）
 *
 * 目的：`team.mjs boot --json` 实测 4.6MB，把「哪个顶层字段吃掉多少字节」量化出来，
 * 并对「换 counts.* / 砍 docHashes」给出**可复算**的收益估计，回答「瘦身后能否 ≤64KB」。
 *
 * 用法：
 *   node scripts/measure-boot-payload.cjs                  # pm / product / programmer1 三角色，写 JSON 结果
 *   node scripts/measure-boot-payload.cjs --role pm        # 单角色
 *   node scripts/measure-boot-payload.cjs --json           # 只打印 JSON（不写文件）
 *
 * 只读保证：只跑 `team.mjs boot --json`（读命令，不写账本）；不修改任何生产文件。
 * 产物：`测试人员/产出/证据-47ec/boot-payload.json`（默认；可用 --out 改）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const argv = process.argv.slice(2);
const argOf = (name, dft) => { const i = argv.indexOf(name); return i >= 0 && argv[i + 1] ? argv[i + 1] : dft; };
const JSON_ONLY = argv.includes('--json');
const ROLES = argv.includes('--role') ? [argOf('--role', 'pm')] : ['pm', 'product', 'programmer1'];
const OUT = argOf('--out', path.join(ROOT, '项目', '工作台改造修复', '测试人员', '产出', '证据-47ec', 'boot-payload.json'));
const TARGET = 64 * 1024;   // <64KB 目标
const PROJECT = argOf('--project', '工作台改造修复');

const byteLen = (v) => {
  try { return Buffer.byteLength(JSON.stringify(v === undefined ? null : v), 'utf8'); } catch { return -1; }
};
const kb = (n) => (n / 1024).toFixed(1) + 'KB';
const pct = (n, total) => (total > 0 ? ((n / total) * 100).toFixed(2) + '%' : '-');

function runBoot(role) {
  const env = { ...process.env };
  delete env.DSH_SESSION_ID;   // 避免把宿主会话写进 boot 记录
  const r = spawnSync(process.execPath, [TOOL, 'boot', '--role', role, '--project', PROJECT, '--json'], {
    encoding: 'utf8', env, cwd: ROOT, timeout: 300000, maxBuffer: 64 * 1024 * 1024,
  });
  const text = String(r.stdout || '');
  const i = text.indexOf('{');
  let json = null;
  let parseError = '';
  if (i >= 0) { try { json = JSON.parse(text.slice(i)); } catch (e) { parseError = String(e.message).slice(0, 200); } }
  return { status: r.status == null ? -1 : r.status, rawBytes: Buffer.byteLength(text, 'utf8'), json, parseError, stderr: String(r.stderr || '').slice(-400) };
}

/** 换 counts 后的估计：tasks/unread/proposals 只留计数 + 指针 */
function estimateCountsSwap(payload) {
  const out = { tasks: 0, unread: 0, proposals: 0, grants: 0, before: 0, after: 0, note: [] };
  for (const key of ['tasks', 'unread', 'proposals', 'grants']) {
    const v = payload[key];
    if (v === undefined) continue;
    const before = byteLen(v);
    out[key] = before;
    out.before += before;
    // 替换成 {count, next:'…'} 的估计（counts.* 一行约 60~120B）
    out.after += 110;
    out.note.push(`${key}: ${kb(before)} → counts.${key}≈110B（指针：task list / inbox --all / req list）`);
  }
  return out;
}

function main() {
  const result = { generatedAt: new Date().toISOString(), project: PROJECT, targetBytes: TARGET, roles: [] };
  for (const role of ROLES) {
    const boot = runBoot(role);
    const row = { role, status: boot.status, rawBytes: boot.rawBytes, parseError: boot.parseError, topKeys: [], briefingChars: null, countsSwap: null };
    if (boot.json && typeof boot.json === 'object') {
      const body = { ...boot.json };
      const total = byteLen(body);
      row.jsonBytes = total;
      row.topKeys = Object.keys(body)
        .map((k) => ({ key: k, bytes: byteLen(body[k]), pct: pct(byteLen(body[k]), total) }))
        .sort((a, b) => b.bytes - a.bytes);
      const brief = body.briefing;
      row.briefingChars = typeof brief === 'string' ? brief.length : null;
      row.briefingBytes = typeof brief === 'string' ? Buffer.byteLength(brief, 'utf8') : null;
      row.countsSwap = estimateCountsSwap(body);
      // 砍掉「换 counts」的三个大块后预计
      if (row.countsSwap.before > 0) {
        row.afterCountsBytes = total - row.countsSwap.before + row.countsSwap.after;
        row.afterCountsPctOfTarget = pct(row.afterCountsBytes, TARGET);
      }
      // 砍掉 docHashes / read / docsBrief（指针：team.mjs status / doc index）
      const cutKeys = ['docHashes', 'read', 'docsBrief'];
      let cutSum = 0;
      for (const k of cutKeys) if (body[k] !== undefined) cutSum += byteLen(body[k]);
      row.cutCandidateBytes = cutSum;
      row.afterAllCutBytes = total - row.countsSwap.before + row.countsSwap.after - cutSum;
      row.afterAllCutPctOfTarget = pct(row.afterAllCutBytes, TARGET);
      row.withinTarget = row.afterAllCutBytes <= TARGET;
    }
    result.roles.push(row);
    if (!JSON_ONLY) {
      console.log(`\n=== ${role} === raw=${kb(boot.rawBytes)} status=${boot.status}${row.parseError ? ' parseError=' + row.parseError : ''}`);
      if (row.topKeys.length) {
        console.log('  顶层键体量（Top 15）：');
        for (const r of row.topKeys.slice(0, 15)) console.log(`    ${String(r.bytes).padStart(8)}B  ${r.pct.padStart(7)}  ${r.key}`);
        console.log(`  briefing 正文字符=${row.briefingChars} 字节=${row.briefingBytes}`);
        console.log(`  换 counts 后 ≈ ${kb(row.afterCountsBytes)}；再砍 docHashes/read/docsBrief（${kb(row.cutCandidateBytes)}）后 ≈ ${kb(row.afterAllCutBytes)}（目标的 ${row.afterAllCutPctOfTarget}）→ ${row.withinTarget ? '✅ 可 ≤64KB' : '❌ 仍超 64KB'}`);
        console.log(`  建议：${row.countsSwap.note.join(' ｜ ')}`);
      }
    }
  }
  if (!JSON_ONLY) {
    try { fs.mkdirSync(path.dirname(OUT), { recursive: true }); fs.writeFileSync(OUT, JSON.stringify(result, null, 2) + '\n', 'utf8'); console.log(`\n已写 ${path.relative(ROOT, OUT)}`); } catch (e) { console.error('写结果失败：' + (e && e.message)); }
  } else {
    console.log(JSON.stringify(result, null, 2));
  }
  // 只读 spike：任何角色 boot 失败都算失败（否则数据不可信）
  const bad = result.roles.filter((r) => r.status !== 0 || !r.jsonBytes);
  process.exit(bad.length ? 1 : 0);
}
main();
