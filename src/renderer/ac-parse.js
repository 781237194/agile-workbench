/* AC 结构化解析（R-5550 F-5550-1/2）——无 DOM 依赖，Node 可 require。
 *
 * 只解析正文里的 AC 块，块外文字（依赖与风险/边界条件等章节）一律忽略：
 *   块起点：行首 `### ACn（…）`（也兼容 `### ACn：`）
 *   块终点：下一个 `### AC…` 行 或 `## ` 章节标题
 *   字段名固定：功能是什么 / 目的 / 风险 / 风险处理 / 拍板选项
 *   选项：`- A. <选项名>：<后果>`（也兼容 `- A：…`、`A) …`）
 * 校验：至少 1 条 AC；每条四段非空；每条选项 ≥2 且每项有后果。缺项清单供弹窗标缺与统计。
 */
(function (globalScope) {
  'use strict';

  const FIELD_KEYS = ['功能是什么', '目的', '风险', '风险处理'];
  const FIELD_MAP = { 功能是什么: 'what', 目的: 'purpose', 风险: 'risk', 风险处理: 'mitigation' };
  const AC_START_RE = /^###\s*AC(\d+)\s*(?:[（(：:]\s*(.*?)[）)]?\s*)?$/;
  const FIELD_RE = /^[-*+\s]*\*{0,2}(功能是什么|目的|风险处理|风险)\*{0,2}\s*[:：]\s*(.*)$/;
  const OPTION_HEAD_RE = /^[-*+\s]*\*{0,2}拍板选项\*{0,2}\s*[:：]\s*(.*)$/;
  const OPTION_RE = /^[-*+\s]*(?:[-*]\s*)?([A-Za-z])[.、:：)]\s*(.+)$/;
  const SECTION_RE = /^##\s+/;

  function textOf(value) { return value === null || value === undefined ? '' : String(value); }
  function clean(value) { return textOf(value).replace(/\s+/g, ' ').trim(); }

  function splitOption(rest) {
    const raw = clean(rest);
    if (!raw) return { key: '', label: '', consequence: '' };
    const idx1 = raw.search(/[：:]/);
    if (idx1 >= 0) {
      return { label: raw.slice(0, idx1).trim(), consequence: raw.slice(idx1 + 1).trim() };
    }
    return { label: raw, consequence: '' };
  }

  /** 解析正文 → AC 数组（只认 AC 块内字段）。 */
  function parseAcBlocks(text) {
    const lines = textOf(text).split(/\r?\n/);
    const acs = [];
    const duplicates = [];
    const seen = new Set();
    let current = null;
    let field = '';
    const close = () => {
      if (!current) return;
      acs.push(current);
      current = null;
      field = '';
    };
    const ensureOptionHead = () => { /* 仅用于可读性 */ };

    for (const line of lines) {
      const start = AC_START_RE.exec(String(line).trim());
      if (start) {
        const id = 'AC' + start[1];
        close();
        if (seen.has(id)) { duplicates.push(id); continue; }
        seen.add(id);
        current = {
          id,
          title: clean(start[2] || ''),
          what: '', purpose: '', risk: '', mitigation: '',
          options: [],
          raw: [],
        };
        field = '';
        continue;
      }
      if (!current) continue; // 块外一律忽略
      if (SECTION_RE.test(String(line))) { close(); continue; }
      if (/^###\s*/.test(String(line))) { close(); continue; }
      current.raw.push(String(line));

      const optionHead = OPTION_HEAD_RE.exec(String(line).trim());
      if (optionHead) {
        field = 'options';
        const inline = clean(optionHead[1]);
        if (inline) {
          const opt = splitOption(inline);
          if (opt.label) current.options.push({ key: current.options.length ? String.fromCharCode(65 + current.options.length) : 'A', ...opt });
        }
        continue;
      }
      const fieldMatch = FIELD_RE.exec(String(line).trim());
      if (fieldMatch) {
        field = FIELD_MAP[fieldMatch[1]] || '';
        const value = clean(fieldMatch[2]);
        if (field && value) current[field] = current[field] ? current[field] + ' ' + value : value;
        continue;
      }
      if (field === 'options') {
        const opt = OPTION_RE.exec(String(line).trim());
        if (opt) {
          const rest = splitOption(opt[2]);
          if (rest.label) current.options.push({ key: opt[1].toUpperCase(), label: rest.label, consequence: rest.consequence });
        }
        continue;
      }
      if (field && current[field] !== undefined) {
        const more = clean(String(line).trim());
        if (more) current[field] = current[field] ? current[field] + ' ' + more : more;
      }
    }
    close();
    ensureOptionHead();
    return { acs, duplicates, formatError: false };
  }

  /** 校验：返回缺项清单（acId + missingFields）。 */
  function validateAcs(acs) {
    const list = Array.isArray(acs) ? acs : [];
    const issues = [];
    if (!list.length) {
      return { ok: false, issues: [{ acId: '', missingFields: ['AC 块'] }], total: 1 };
    }
    for (const ac of list) {
      const missingFields = [];
      for (const label of FIELD_KEYS) {
        const key = FIELD_MAP[label];
        if (!clean(ac[key])) missingFields.push(label);
      }
      if (!Array.isArray(ac.options) || ac.options.length < 2) missingFields.push('拍板选项');
      else if (ac.options.some((option) => !clean(option.consequence))) missingFields.push('拍板选项-后果');
      if (missingFields.length) issues.push({ acId: ac.id, missingFields });
    }
    return { ok: issues.length === 0, issues, total: issues.length };
  }

  /** 需求维度：解析 + 校验 + 是否结构化。 */
  function analyzeRequirement(row) {
    const source = row && typeof row === 'object' ? row : {};
    const text = [textOf(source.docText), textOf(source.detail), textOf(source.acceptance), textOf(source.story)]
      .filter((part) => part.trim()).join('\n');
    const parsed = parseAcBlocks(text);
    const validation = validateAcs(parsed.acs);
    return {
      structured: parsed.acs.length > 0,
      acs: parsed.acs,
      duplicates: parsed.duplicates,
      // 旧正文（没有 AC 块）不产生缺项——按 F-5550-6 渐进降级，不逐条报缺。
      issues: parsed.acs.length ? validation.issues : [],
      ok: parsed.acs.length > 0 && validation.ok,
    };
  }

  /** 弹窗维度：汇总缺失统计（只统计结构化需求；旧正文不报缺）。 */
  function missingStats(rows, requirementIdOf) {
    const items = [];
    for (const row of (Array.isArray(rows) ? rows : [])) {
      if (!row || !row.__ac || !row.__ac.structured) continue;
      for (const issue of (row.__ac.issues || [])) {
        items.push({
          requirementId: requirementIdOf ? requirementIdOf(row) : String(row.id || ''),
          acId: issue.acId,
          missingFields: issue.missingFields.slice(),
        });
      }
    }
    return { total: items.length, items };
  }

  /**
   * R-5550 AC5 / F-5550-4：看板五要素与弹窗**同一解析结果**（禁止两套取数）。
   * 是什么=功能是什么；怎么做=功能+目的；卡在哪=风险；影响谁=目的；建议拍板=逐项选项+后果。
   * 旧正文（无结构）返回 null，调用方退回原五要素降级。
   */
  function boardFieldsOf(row) {
    const info = row && row.__ac;
    if (!info || !info.structured || !Array.isArray(info.acs) || !info.acs.length) return null;
    const ac = info.acs[0];
    const options = Array.isArray(ac.options) ? ac.options : [];
    const advice = options.map((option) => `${option.key}. ${option.label}：${option.consequence || '（正文缺：后果）'}`).join('；');
    return {
      acId: ac.id,
      what: ac.what || '（正文缺：功能是什么）',
      how: `功能：${ac.what || '（正文缺）'}；目的：${ac.purpose || '（正文缺）'}`,
      blocked: ac.risk || '（正文缺：风险）',
      impact: ac.purpose || '（正文缺：目的）',
      advice: advice || '（正文缺：拍板选项）',
    };
  }

  const api = { parseAcBlocks, validateAcs, analyzeRequirement, missingStats, boardFieldsOf, FIELD_KEYS };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  if (globalScope) globalScope.AcParse = api;
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : null));
