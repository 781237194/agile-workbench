'use strict';
/**
 * B-20261120-163528-ebbb（P0）维护（重置/卸载）调用的小工具：JSON 提取 + 调用日志。
 *
 * 背景：
 *  - `install.ps1 -Json` 的输出形如 `<多行日志>\nAWB_MAINT_JSON:{...}\n日志：...`，旧实现
 *    `JSON.parse(out.slice(at+15).trim())` 遇到 JSON 之后的任何一行（或截断）就整段失败 →
 *    界面显示「干跑失败（code=?）」，而实际干跑成功。
 *  - 维护调用此前不写调用日志（install.ps1 自己那份可能 0 字节：它在写任何内容前就 return）。
 *
 * 本模块只做两件纯事，便于夹具直接测：
 *   1) `extractLastJson(text)`：从混合输出里取**最后一个完整 JSON 对象**（容忍前缀/多行/尾随文本/截断自动闭合）；
 *   2) `buildMaintLog({...})` / `writeMaintLog(dir, meta)`：生成/写入 `install-<ts>.log`（时间/命令/工作目录/退出码/stdout/stderr/耗时），
 *      保证非 0 字节。
 */
const fs = require('node:fs');
const path = require('node:path');

const MAINT_JSON_MARK = 'AWB_MAINT_JSON:';

/** 从 `start` 处的 `{` 起扫描，返回所有括号配平的候选（含被截断时可自动闭合的候选）。 */
function balancedCandidates(text, start, allowAutoClose = false) {
  const out = [];
  const stack = [];
  let inString = false;
  let escape = false;
  let begin = -1;
  for (let i = start; i < text.length; i += 1) {
    const ch = text[i];
    if (inString) {
      if (escape) { escape = false; continue; }
      if (ch === '\\') { escape = true; continue; }
      if (ch === '"') { inString = false; }
      continue;
    }
    if (ch === '"') { inString = true; continue; }
    if (ch === '{' || ch === '[') {
      if (stack.length === 0) begin = i;
      stack.push(ch);
      continue;
    }
    if (ch === '}' || ch === ']') {
      if (stack.length === 0) continue;
      stack.pop();
      if (stack.length === 0 && begin >= 0) {
        out.push(text.slice(begin, i + 1));
        begin = -1;
      }
    }
  }
  // 截断兜底：按栈逆序补闭合符；若截断在字符串中间，先补一个引号
  if (allowAutoClose && stack.length > 0 && begin >= 0) {
    const closers = stack.slice().reverse().map((c) => (c === '{' ? '}' : ']')).join('');
    out.push(text.slice(begin) + (inString ? '"' : '') + closers);
  }
  return out;
}

function tryParse(candidate) {
  try {
    const v = JSON.parse(candidate);
    return v && typeof v === 'object' ? v : null;
  } catch { return null; }
}

/**
 * 取输出中最后一个完整 JSON 对象。
 * @param {string} raw 原始输出（可含 AWB_MAINT_JSON: 前缀、多行日志、尾随「日志：…」行、甚至截断）
 * @returns {{json: object|null, at: number, source: 'marker'|'scan'|'none'}}
 */
function extractLastJson(raw) {
  const text = String(raw == null ? '' : raw);
  if (!text.trim()) return { json: null, at: -1, source: 'none' };
  const markerAt = text.lastIndexOf(MAINT_JSON_MARK);
  if (markerAt >= 0) {
    const bodyStart = markerAt + MAINT_JSON_MARK.length;
    // 只在 marker 之后找（容忍 marker 前后都有日志）
    const cands = balancedCandidates(text, bodyStart, true);
    for (let i = cands.length - 1; i >= 0; i -= 1) {
      const v = tryParse(cands[i]);
      if (v) return { json: v, at: bodyStart, source: 'marker' };
    }
  }
  // 没有 marker（或 marker 之后解析不出）：全文扫描，取最后一个可解析对象
  const cands = balancedCandidates(text, 0, true);
  for (let i = cands.length - 1; i >= 0; i -= 1) {
    const v = tryParse(cands[i]);
    if (v) return { json: v, at: text.indexOf(cands[i].slice(0, 12)), source: 'scan' };
  }
  return { json: null, at: -1, source: 'none' };
}

/** 组装维护调用日志正文（纯函数，夹具可直接断言字段齐全）。 */
function buildMaintLog({ at = '', command = '', cwd = '', exitCode = null, durationMs = null, stdout = '', stderr = '' } = {}) {
  const lines = [];
  lines.push('# 维护调用日志（PMWorkbench）');
  lines.push(`时间: ${at || new Date().toISOString()}`);
  lines.push(`命令: ${String(command || '')}`);
  lines.push(`工作目录: ${String(cwd || '')}`);
  lines.push(`退出码: ${exitCode === null || exitCode === undefined ? '(未知)' : String(exitCode)}`);
  lines.push(`耗时: ${durationMs === null || durationMs === undefined ? '(未知)' : String(durationMs) + 'ms'}`);
  const out = String(stdout || '');
  const err = String(stderr || '');
  lines.push(`--- stdout (${out.length} 字符) ---`);
  lines.push(out.replace(/\r\n/g, '\n'));
  lines.push(`--- stderr (${err.length} 字符) ---`);
  lines.push(err.replace(/\r\n/g, '\n'));
  return lines.join('\n') + '\n';
}

/** 写 `<dir>/install-<ts>.log`（同秒冲突加序号），返回 {file, bytes}。非 0 字节由内容保证。 */
function writeMaintLog(dir, meta = {}) {
  const directory = String(dir || '');
  if (!directory) throw new Error('writeMaintLog 需要目录');
  fs.mkdirSync(directory, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace('T', '-').slice(0, 15).replace('.', '');
  const base = `install-${stamp}`;
  let file = path.join(directory, `${base}.log`);
  let i = 1;
  while (fs.existsSync(file)) { file = path.join(directory, `${base}-${i}.log`); i += 1; }
  const body = buildMaintLog(meta);
  fs.writeFileSync(file, body, 'utf8');
  return { file, bytes: Buffer.byteLength(body, 'utf8') };
}

module.exports = { MAINT_JSON_MARK, extractLastJson, buildMaintLog, writeMaintLog };
