/**
 * T-20261117-213802-d69d（R-6b61 AC6）：靶语文案白名单与扫描（单源）。
 *
 * 靶词＝「每轮必读 / 每轮都读 / 每次必读 / 每轮第一件事读 / 先读铁律」这类把铁律说成必读的旧口径。
 * 白名单（显式，按行过滤）：
 *   ① 宪法自身标题「团队宪法（每轮必读 · v2）」（store.mjs 模板 / 团队宪法.md 第一行）；
 *   ② 项目信息模板小节「§八 交互方式总表（每次必读）」（scaffold.mjs）；
 *   ③ 「按需 / 不必每轮 / 不纳入每次必读」这类正向表述所在行；
 *   ④ 历史文档/需求正文/证据/交接/lessons/计划文档（不在扫描范围）。
 * 扫描范围：src/**\/*.js（含 renderer）+ 团队/工具/**\/*.{mjs,js}；注释行按「历史注释」豁免但要计数。
 */
import fs from 'node:fs';
import path from 'node:path';

export const RULE_TARGET_RE = /每轮必读|每轮都读|每次必读|每轮第一件事读|先读铁律/;
export const RULE_WHITELIST = [
  { id: 'constitution-title', test: (line) => /团队宪法（每轮必读/.test(line) || /# 团队宪法（每轮必读/.test(line), why: '宪法自身标题' },
  { id: 'project-info-section8', test: (line) => /交互方式总表（每次必读）/.test(line), why: '项目信息模板 §八 小节标题' },
  { id: 'positive-optional', test: (line) => /按需|不必每轮|不纳入|不每轮|仅按需/.test(line), why: '正向「按需」表述' },
  { id: 'historical-comment', test: (line) => /^\s*(\/\/|\*|\/\*)/.test(line) && /旧流程|历史|曾/.test(line), why: '历史注释（描述旧口径）' },
];
export const RULE_SCAN_DIRS = ['src', path.join('团队', '工具')];

function walk(dir, out) {
  let entries = [];
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return; }
  for (const ent of entries) {
    const p = path.join(dir, ent.name);
    if (ent.isDirectory()) {
      if (['node_modules', '_tmp', '.git', '归档'].includes(ent.name)) continue;
      walk(p, out);
    } else if (/\.(mjs|js)$/.test(ent.name)) out.push(p);
  }
}

/** 扫描靶词；返回 {ok, findings:[{file,line,text,reason}], scanned}。 */
export function scanRuleScope(root) {
  const base = path.resolve(root || process.cwd());
  const files = [];
  for (const rel of RULE_SCAN_DIRS) walk(path.join(base, rel), files);
  const findings = [];
  for (const file of files) {
    let text = '';
    try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
    const rel = path.relative(base, file).replace(/\\/g, '/');
    if (rel === '团队/工具/lib/rule-scope.mjs') continue; // 自引用豁免（本文件定义靶词）
    text.split(/\r?\n/).forEach((line, i) => {
      if (!RULE_TARGET_RE.test(line)) return;
      const whitelisted = RULE_WHITELIST.find((w) => w.test(line));
      if (whitelisted) return;
      const isComment = /^\s*(\/\/|\*|\/\*)/.test(line);
      findings.push({ file: rel, line: i + 1, text: line.trim().slice(0, 160), reason: isComment ? 'comment' : 'code' });
    });
  }
  return { ok: findings.length === 0, findings, scanned: files.length };
}

/** 生成型文档刷新：只刷新项目索引（保留 <!-- 人工说明 --> 段）。 */
export function manualSegmentOf(text) {
  const m = String(text || '').match(/<!-- 人工说明:BEGIN -->([\s\S]*?)<!-- 人工说明:END -->/);
  return m ? m[1] : '';
}
