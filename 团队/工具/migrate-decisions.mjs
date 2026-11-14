#!/usr/bin/env node
// 一次性迁移（B-a08e）：把决定从 row.ownerReview.decisions（旧 nested 层级）搬到
// row.decisions（顶层，闸门/弹窗读这里）；没有 decisions 但 ownerReview 已是终态的行，
// 按 ownerReview 摘要补一条。幂等：重复跑不会重复补；不改顶层 state.ownerReview。
//
// 用法：
//   node 团队/工具/migrate-decisions.mjs --project "工作台改造修复" [--apply] [--json]
//   默认 dry-run（只打印对照表）；--apply 才写，写前自动备份 工作流.json。
'use strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const args = process.argv.slice(2);
const argOf = (name) => {
  const i = args.indexOf(name);
  return i >= 0 ? String(args[i + 1] || '') : '';
};
const has = (name) => args.includes(name);
const project = argOf('--project') || '工作台改造修复';
const apply = has('--apply');
const asJson = has('--json');

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEAM_ROOT = process.env.TEAM_ROOT ? path.resolve(process.env.TEAM_ROOT) : path.resolve(HERE, '..');
const stateDir = path.join(TEAM_ROOT, '状态', '项目', project);
const workflowFile = path.join(stateDir, '工作流.json');
if (!fs.existsSync(workflowFile)) {
  console.error(`找不到工作流：${workflowFile}`);
  process.exit(2);
}
const state = JSON.parse(fs.readFileSync(workflowFile, 'utf8'));
const at = new Date().toISOString();
const FINAL = new Set(['approved', 'rejected', 'skipped']);
const keyOf = (d) => `${String(d && d.at || '')}|${String(d && (d.status || d.decision) || '')}|${String(d && d.channel || '')}`;
const rows = [];
let topMigrated = 0;
let synthesized = 0;
let already = 0;
let skipped = 0;

for (const [id, row] of Object.entries(state.requirements || {})) {
  if (!row || typeof row !== 'object') { skipped += 1; continue; }
  const owner = row.ownerReview && typeof row.ownerReview === 'object' ? row.ownerReview : null;
  const topLevel = Array.isArray(row.decisions) ? row.decisions.filter(Boolean) : [];
  const nested = owner && Array.isArray(owner.decisions) ? owner.decisions.filter(Boolean) : [];
  const merged = [];
  const seen = new Set();
  for (const rec of [...topLevel, ...nested]) {
    const key = keyOf(rec);
    if (seen.has(key)) continue;
    seen.add(key);
    merged.push(rec);
  }
  let action = 'already';
  if (merged.length === 0 && owner && FINAL.has(String(owner.status || ''))) {
    // 旧数据：只有 ownerReview 摘要，没有 decisions → 按同一份摘要补一条（不伪造新决定）。
    merged.push({
      status: String(owner.status), decision: String(owner.status),
      channel: String(owner.channel || 'ui'), decidedBy: 'owner', actor: 'owner',
      by: String(owner.by || 'Owner'), at: String(owner.at || at),
      roundKey: String(owner.roundKey || ''), opinion: String(owner.opinion || ''),
      migratedFrom: 'ownerReview',
      ...(owner.recordedBy ? { recordedBy: String(owner.recordedBy) } : {}),
      ...(owner.proxy ? { proxy: String(owner.proxy) } : {}),
      ...(owner.authorization ? { authorization: String(owner.authorization) } : {}),
    });
    synthesized += 1;
    action = 'synthesized';
  } else if (nested.length || merged.length !== topLevel.length) {
    topMigrated += 1;
    action = 'migrated';
  } else {
    already += 1;
  }
  if (action === 'already') {
    rows.push({ id, status: String((owner && owner.status) || ''), before: topLevel.length, after: topLevel.length, action });
    continue;
  }
  if (merged.length) row.decisions = merged;
  if (owner && Array.isArray(owner.decisions)) delete owner.decisions;
  rows.push({ id, status: String((owner && owner.status) || ''), before: topLevel.length, after: merged.length, action });
}

const summary = {
  at, project, file: workflowFile, mode: apply ? 'apply' : 'dry-run',
  requirements: Object.keys(state.requirements || {}).length,
  nestedMigrated: topMigrated, synthesized, already, skipped,
  withDecisions: Object.values(state.requirements || {}).filter((r) => Array.isArray(r.decisions) && r.decisions.length).length,
};

if (apply && (topMigrated || synthesized)) {
  const backup = `${workflowFile}.bak-${at.replace(/[:.]/g, '-')}`;
  fs.copyFileSync(workflowFile, backup);
  const tmp = `${workflowFile}.tmp-${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(state, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, workflowFile);
  summary.backup = backup;
}

if (asJson) {
  console.log(JSON.stringify({ ...summary, rows }, null, 2));
} else {
  console.log(`${summary.mode === 'apply' ? '已迁移' : '预演（未写盘）'} · ${project}`);
  console.log(`需求 ${summary.requirements} 条 ｜ nested→顶层 ${summary.nestedMigrated} ｜ 按 ownerReview 补 ${summary.synthesized} ｜ 已有 ${summary.already} ｜ 跳过 ${summary.skipped} ｜ 有 decisions 的行 ${summary.withDecisions}`);
  console.log('需求 id → decisions 条数');
  for (const row of rows) console.log(`  ${row.id}  ${row.before} → ${row.after}  ${row.action}${row.status ? ' (' + row.status + ')' : ''}`);
  if (summary.backup) console.log(`备份：${summary.backup}`);
  if (!apply) console.log('确认无误后加 --apply 执行（会先备份 工作流.json）。');
}
