/**
 * T-20261117-184114-4358（R-bcae）第二步：Skill 机制的工具层（四要素校验 + 30 分钟评估提示）。
 *
 * 口径（需求正文 §5.1）：
 *   - 技能索引真源 = 团队/skill/基础流程/00-索引.md（index.md 只是兼容指针）；
 *   - 基础流程 skill 为 Owner 批准版本，不可自行修改（manifest 校验见 scripts/skill-check.cjs）；
 *   - 创建/更新 skill 必须带四要素：①会重复发生 ②明确步骤 ③可验证判据 ④出错代价高；缺项拒收；
 *   - 每 ≥30 分钟给一次「是否创建/更新 skill」提示：同窗口只一次、可跳过但必须写 reason；
 *     状态 append-only 记 团队/状态/项目/<项目>/skill评估.jsonl。
 *
 * 本模块只读代码与文件、只 append 评估日志；不修改 skill 模板（模板走 Owner 批准 + manifest）。
 */
import fs from 'node:fs';
import path from 'node:path';
import { nowIso } from './core.mjs';
import { projectStatePaths } from './store.mjs';

export const SKILL_PROMPT_WINDOW_MS = 30 * 60 * 1000;
export const SKILL_EVAL_FILE = 'skill评估.jsonl';

/** 四要素判定：按固定小节 + 关键词双判（宁可提示，不静默放行）。 */
export const SKILL_ELEMENTS = [
  { key: 'repeat', label: '会重复发生', section: '适用场景', keywords: ['重复', '每次', '经常', '随', '场景'] },
  { key: 'steps', label: '明确步骤', section: '步骤', keywords: ['1.', '2.', '步骤', '先', '再'] },
  { key: 'verdict', label: '可验证判据', section: '判据', keywords: ['判据', '断言', '命令', '通过', '证据'] },
  { key: 'costly', label: '出错代价高', section: '反例', keywords: ['反例', '代价', '失败', '错误', '禁止'] },
];

/** 校验一份 skill 文本是否满足四要素；返回 {ok, missing:[{key,label,why}]}。 */
export function validateSkillContent(text) {
  const doc = String(text || '');
  const missing = [];
  for (const el of SKILL_ELEMENTS) {
    const sectionRe = new RegExp(`^##\\s*${el.section}`, 'm');
    const hasSection = sectionRe.test(doc);
    const hasKeyword = el.keywords.some((k) => doc.includes(k));
    if (!hasSection) missing.push({ key: el.key, label: el.label, why: `缺「## ${el.section}」小节` });
    else if (!hasKeyword) missing.push({ key: el.key, label: el.label, why: `「## ${el.section}」里没有可判定的表述（关键词：${el.keywords.join('/')}）` });
  }
  return { ok: missing.length === 0, missing };
}

function evalFile(projectName) {
  return path.join(projectStatePaths(String(projectName || '').trim()).dir, SKILL_EVAL_FILE);
}

/** 读评估日志（append-only jsonl；坏行跳过不抛）。 */
export function readSkillEvaluations(projectName) {
  const file = evalFile(projectName);
  try {
    return fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);
  } catch { return []; }
}

/** 最近一次「提示或评估」时间（prompt/skip/create/update 都算一次评估动作）。 */
export function lastSkillEvalAt(projectName, role) {
  const rows = readSkillEvaluations(projectName).filter((r) => String(r.role || '') === String(role || ''));
  if (!rows.length) return { at: '', atMs: 0, action: '' };
  const last = rows[rows.length - 1];
  const ms = Date.parse(String(last.at || ''));
  return { at: String(last.at || ''), atMs: Number.isFinite(ms) ? ms : 0, action: String(last.action || '') };
}

/** 是否到点提示（≥30 分钟或从未评估过）；now 可注入（AWB_NOW_MS / 参数），便于夹具不真等。 */
export function skillPromptDue(projectName, role, { nowMs = Number(process.env.AWB_NOW_MS || 0) || Date.now(), windowMs = SKILL_PROMPT_WINDOW_MS } = {}) {
  const last = lastSkillEvalAt(projectName, role);
  if (!last.atMs) return { due: true, reason: 'never', lastAt: '', dueInMs: 0 };
  const delta = nowMs - last.atMs;
  return { due: delta >= windowMs, reason: delta >= windowMs ? 'window' : 'cooldown', lastAt: last.at, dueInMs: Math.max(0, windowMs - delta) };
}

/** append 一条评估记录（只 append，不改历史）。 */
export function recordSkillEvaluation(projectName, role, { action = 'prompt', reason = '', at = '', detail = null } = {}) {
  const file = evalFile(projectName);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const row = {
    at: String(at || nowIso()),
    role: String(role || ''),
    action: String(action || ''),
    reason: String(reason || ''),
    ...(detail && typeof detail === 'object' ? { detail } : {}),
  };
  fs.appendFileSync(file, JSON.stringify(row) + '\n', 'utf8');
  return row;
}

/** 启动简报用的提示行（due 时才出；同时落一条 action=prompt 记录，保证同窗口只一次）。 */
export function skillPromptLineFor(projectName, role, { nowMs = Number(process.env.AWB_NOW_MS || 0) || Date.now(), windowMs = SKILL_PROMPT_WINDOW_MS } = {}) {
  const due = skillPromptDue(projectName, role, { nowMs, windowMs });
  if (!due.due) return null;
  recordSkillEvaluation(projectName, role, { action: 'prompt', reason: due.reason, at: new Date(nowMs).toISOString() });
  return `skill 提示: 距上次 skill 评估已 ${due.lastAt ? Math.round((nowMs - Date.parse(due.lastAt)) / 60000) + ' 分钟' : '从未评估'}（阈值 30 分钟）——是否创建/更新 skill？可用 \`team.mjs skill skip --reason "…"\` 跳过（必填 reason）。`;
}
