// R-5b14：每角色默认交接文档（<角色>/产出/交接-最新.md）的**只读发现**。
// 边界（需求 §二）：不创建、不改名、不校验内容、不进 rulesHash；结构与 rotate 校验属产品口径。
//
// ── 「固定名优先」的正文出处（产品 2026-11-16 10:27 裁定：这属**正文已覆盖**，不是实现细节）──────────
// 需求 R-8f2a / R-5b14 正文里的交集口径，本条只做注释留痕，不改逻辑：
//   ① 固定名 `交接-最新.md` **优先**：F-1（每角色一个默认交接文档、固定名）+ AC2（boot 提示读「最新」那份）。
//   ② **只有固定名不存在时才扫历史**：F-3（历史沿用 dated 归档，四类前缀 交接-/接任-/开工交接-/换人交接-）
//      ——扫描是「找不到固定名」的兜底，不是并列候选。
//   ③ 历史件排序：F-4 三级规则——先按文件名里的 8 位日期（含可选 -HHMM，缺时分按 0000），
//      再按 mtime，最后按文件名升序（保证幂等、同输入必得同一结果）。
//   ④ 边角（正文未逐字写死，由 F-3 直接推得）：**固定名与 dated 同时存在时，固定名优先**——
//      因为 F-3 明确「扫历史仅当固定名不存在」，所以两者并存不是「比谁更新」，而是固定名直接胜出；
//      产品 2026-11-16 10:27 裁定确认此推导，AC4 的「N 份历史」计数也不含固定名那份。
// 相关 AC：AC2（boot 提示最新一份、不阻断）、AC4（历史件识别与并列时的稳定排序）。
import fs from 'node:fs';
import path from 'node:path';

/** 当前版固定名（唯一） */
export const HANDOVER_FIXED = '交接-最新.md';
/** 历史命名四类（AC4/F-3）：交接-/接任-/开工交接-/换人交接-，大小写不敏感、扩展名 .md */
const HISTORY_FILE_RE = /^(?:交接|接任|开工交接|换人交接).*\.md$/i;
/** 剥前缀用于解析日期 */
const PREFIX_RE = /^(?:交接|接任|开工交接|换人交接)-?/;

function stripPrefix(name) {
  const text = String(name || '');
  const m = text.match(PREFIX_RE);
  return m ? text.slice(m[0].length) : text;
}

/**
 * F-4 解析规则：先剥前缀，再找 8 位日期 `(\d{8})` 与其后可选 `-(\d{4})`（时分）。
 * 有日期无时分 → YYYYMMDD-0000；无合法 8 位日期 → 用 mtime 兜底。
 * 返回 { stamp, dated }：stamp 是可比较的毫秒时间戳。
 */
export function handoverStampOf(name, mtimeMs = 0) {
  const rest = stripPrefix(name);
  const hit = rest.match(/(\d{8})(?:-(\d{4}))?/);
  if (hit) {
    const y = Number(hit[1].slice(0, 4));
    const mo = Number(hit[1].slice(4, 6));
    const d = Number(hit[1].slice(6, 8));
    const hh = hit[2] ? Number(hit[2].slice(0, 2)) : 0;
    const mi = hit[2] ? Number(hit[2].slice(2, 4)) : 0;
    const inRange = mo >= 1 && mo <= 12 && d >= 1 && d <= 31 && hh <= 23 && mi <= 59;
    if (inRange) {
      const stamp = Date.UTC(y, mo - 1, d, hh, mi);
      const back = new Date(stamp);
      // 防 2026-02-31 这类被 Date 归一化的假日期：回读必须与原值一致
      if (Number.isFinite(stamp) && back.getUTCFullYear() === y && back.getUTCMonth() === mo - 1 && back.getUTCDate() === d) {
        return { stamp, dated: true };
      }
    }
  }
  return { stamp: Number(mtimeMs) || 0, dated: false };
}

/**
 * F-4「最新」判定：①文件中日期时间戳大者优先；②无日期按 mtime；③并列取 mtime 较新；
 * ④仍并列取文件名升序第一条（保证 AC11 幂等）。
 * candidates: [{ name, mtimeMs }]
 */
export function pickLatestHandover(candidates) {
  const rows = (Array.isArray(candidates) ? candidates : [])
    .filter((row) => row && row.name)
    .map((row) => {
      const mtimeMs = Number(row.mtimeMs) || 0;
      const parsed = handoverStampOf(row.name, mtimeMs);
      return { ...row, name: String(row.name), mtimeMs, stamp: parsed.stamp, dated: parsed.dated };
    });
  rows.sort((a, b) => (b.stamp - a.stamp) || (b.mtimeMs - a.mtimeMs) || a.name.localeCompare(b.name, 'zh-Hans-CN'));
  return rows[0] || null;
}

function readDirNames(dir) {
  try {
    return fs.readdirSync(dir);
  } catch (e) {
    // 目录不存在是常态（老项目/首次接手），只有真读失败才告警（边界「异常」行）
    if (e && e.code !== 'ENOENT' && e.code !== 'ENOTDIR') console.warn('[handover] read failed:', String((e && e.message) || e));
    return [];
  }
}

function isFile(file) {
  try { return fs.statSync(file).isFile(); } catch { return false; }
}

/**
 * 扫描某角色的交接现状（只读）。
 * 返回 { dir, hasLatest, latestRel, history[], historyCount, latestHistory }
 */
export function handoverState({ projectRoot, roleDirName } = {}) {
  const role = String(roleDirName || '');
  const base = String(projectRoot || '');
  const empty = { dir: '', hasLatest: false, latestRel: '', history: [], historyCount: 0, latestHistory: null };
  if (!role || !base) return empty;
  const dir = path.join(base, role, '产出');
  const names = readDirNames(dir).filter((name) => /\.md$/i.test(name));
  const hasLatest = names.includes(HANDOVER_FIXED) && isFile(path.join(dir, HANDOVER_FIXED));
  const history = [];
  for (const name of names) {
    if (name === HANDOVER_FIXED) continue;
    if (!HISTORY_FILE_RE.test(name)) continue;
    const file = path.join(dir, name);
    if (!isFile(file)) continue; // 「是目录」按不存在处理
    let mtimeMs = 0;
    try { mtimeMs = fs.statSync(file).mtimeMs; } catch { mtimeMs = 0; }
    history.push({ name, rel: `${role}/产出/${name}`, mtimeMs });
  }
  return {
    dir,
    hasLatest,
    latestRel: hasLatest ? `${role}/产出/${HANDOVER_FIXED}` : '',
    history,
    historyCount: history.length,
    latestHistory: pickLatestHandover(history),
  };
}

/**
 * F-2 / F-3：简报提示行（两态互斥；都没有 → 空串，简报不出任何行）。
 * 有固定名 → 「⚠ 检测到前任交接：<rel>（建议先读，不阻断）」
 * 只有历史 → 「⚠ 未找到 交接-最新.md，但有历史交接 N 份（最新 <rel>），建议改名」
 */
export function handoverBriefLine({ projectRoot, roleDirName } = {}) {
  const st = handoverState({ projectRoot, roleDirName });
  if (st.hasLatest) return { kind: 'latest', line: `⚠ 检测到前任交接：${st.latestRel}（建议先读，不阻断）`, rel: st.latestRel };
  if (st.historyCount >= 1 && st.latestHistory) {
    return {
      kind: 'history',
      line: `⚠ 未找到 交接-最新.md，但有历史交接 ${st.historyCount} 份（最新 ${st.latestHistory.rel}），建议改名`,
      rel: st.latestHistory.rel,
    };
  }
  return { kind: '', line: '', rel: '' };
}
