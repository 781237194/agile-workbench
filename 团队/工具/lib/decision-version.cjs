/**
 * B-20261117-190411-b75c：Owner 决定「绑的是不是当前正文版本」的**唯一判定函数**（CJS 单源）。
 *
 * 为什么要有第二个哈希：程序自己会往正文里追加「## 状态记录」等维护行（设计允许），
 * 这份写入只改**原始文件 sha256**、不改内容语义。以前验收/派单门禁用原始 sha256 比，
 * 于是「正文一发状态行 → Owner 已通过的决定立刻被判旧版 → 验收/派单被挡」（6bc8 实测）。
 *
 * 口径（b75c 修复口径 §一）：
 *   ① 先比 contentHash（忽略程序维护行的内容哈希）：两边都有且相等 → 视为**同一版本（有效）**；
 *   ② contentHash 任一侧缺失 → 回落原始 sha256 比较（旧记录兼容，行为不变）；
 *   ③ 两边都比不了（无 hash）→ 交给调用方按各自的历史兼容策略处理，本函数返回 null。
 *
 * 返回：true（同一版本）/ false（旧版本）/ null（无从判断）。
 * ESM（团队/工具/lib/gates.mjs）与 CJS（src/team-tools.js）共用本文件，禁止各自再写一份。
 */
'use strict';

function textOf(value) {
  return value === undefined || value === null ? '' : String(value).trim();
}

/**
 * @param {object|null} decision Owner 决定（读 basis.requirement.sha256 / basis.requirement.contentHash，旧记录回落顶层）
 * @param {object|null} version 当前正文版本 {sha256, contentHash}
 * @returns {true|false|null}
 */
function decisionMatchesVersion(decision, version) {
  if (!decision || typeof decision !== 'object') return null;
  const basis = decision.basis && typeof decision.basis === 'object' ? decision.basis : {};
  const req = basis.requirement && typeof basis.requirement === 'object' ? basis.requirement : {};
  const decSha = textOf(req.sha256) || textOf(decision.sha256);
  const decContent = textOf(req.contentHash) || textOf(decision.contentHash);
  const cur = version && typeof version === 'object' ? version : {};
  const curSha = textOf(cur.sha256);
  const curContent = textOf(cur.contentHash);
  // ① contentHash 优先：只差程序维护行时判同一版本（不阻断验收/派单）。
  if (decContent && curContent) return decContent === curContent;
  // ② 回落原始 sha256（旧决定没有 contentHash 时的兼容口径）。
  if (decSha && curSha) return decSha === curSha;
  // ③ 无从判断：调用方按历史兼容策略处理。
  return null;
}

/** 该决定是否**明确**绑在别的版本上（用于「实质改文 → 判旧」与错误文案）。 */
function decisionIsStale(decision, version) {
  return decisionMatchesVersion(decision, version) === false;
}

module.exports = { decisionMatchesVersion, decisionIsStale };
