// T-20261120-0157-1b4 / R-20261119-214901-af15：内容快照锚点（路径#sha12:行指纹，替代裸行号）
//
// 为什么：裸行号 `L7784` 会被并发改动整段挪位（B-211237-9ded 实战：证据里写 L7784/L7788，改几行即失真；
// 打点用行号锚点还误插到无关函数）。锚点 = 「文件内容 sha12 + 该行内容 sha12」——文件变了靠行指纹定位，
// 行内容也变了才报 STALE。
//
// 契约（正文 §6 写死，别改）：格式 `路径#sha12:lineSha12`（基准根=仓库根，统一 `/`）；
// 归一化=只去行首尾 [ \t\r]；三级判定顺序 格式→文件存在→快照→指纹→歧义；
// 错误码 ANCHOR_BAD_FORMAT / ANCHOR_LINE_OUT_OF_RANGE / ANCHOR_PATH_OUTSIDE /
//        ANCHOR_FILE_MISSING / ANCHOR_STALE / ANCHOR_AMBIGUOUS / ANCHOR_READ_FAILED / ANCHOR_FILE_TOO_LARGE；
// 纯只读（不写账本、不改文件、不打审计——AC8）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { WORKSPACE, fail } from './core.mjs';

/** 单文件上限 32MB（正文 §九）。 */
const MAX_BYTES = 32 * 1024 * 1024;
/** 白名单排除目录（基准根=仓库根内）；沙盘（TEAM_SELFTEST=1）放行 _tmp/。 */
const EXCLUDED_PREFIXES = ['_tmp', 'sandbox'];
const EXCLUDED_PATTERNS = [/^证据-/, /^代码快照-/];

export function anchorRepoRoot() {
  return WORKSPACE;
}

function isSandbox() {
  return String(process.env.TEAM_SELFTEST || '') === '1';
}

/** 归一化：只去行首尾 [ \t\r ]（正文 §6.4）；不做大小写/空白/标点归一。 */
export function normAnchorLine(line) {
  return String(line == null ? '' : line).replace(/^[ \t\r]+/, '').replace(/[ \t\r]+$/, '');
}

/** 行指纹 = sha256(归一化行) 前 12 位小写 hex。空行也有固定值。 */
export function lineSha12Of(line) {
  return crypto.createHash('sha256').update(normAnchorLine(line), 'utf8').digest('hex').slice(0, 12);
}

/** 文件指纹 = sha256(原始字节) 前 12 位（CRLF/LF 不同 → 文件 sha 会不同，正文 AC6 明确要求）。 */
export function fileSha12Of(buf) {
  return crypto.createHash('sha256').update(buf).digest('hex').slice(0, 12);
}

/** 读文件（UTF-8 文本；剥 BOM；>32MB 拒绝）。返回 { buf, text, lines }。 */
function readAnchorFile(abs) {
  let stat = null;
  try { stat = fs.statSync(abs); } catch { return null; }
  if (!stat.isFile()) return null;
  if (stat.size > MAX_BYTES) fail('ANCHOR_FILE_TOO_LARGE', `文件超过 32MB（${stat.size} 字节）：请改用行区间请求`, { file: abs, bytes: stat.size }, 4);
  let buf = null;
  try { buf = fs.readFileSync(abs); } catch (e) { fail('ANCHOR_READ_FAILED', `文件读取失败：${String((e && e.message) || e).slice(0, 200)}`, { file: abs }, 4); }
  let text = buf.toString('utf8');
  if (text.charCodeAt(0) === 0xFEFF) text = text.slice(1);
  // CRLF/CR 都按行切（行内容本身保留 \r 会被归一化去掉）
  const lines = text.split(/\r\n|\n|\r/);
  return { buf, text, lines };
}

/**
 * 解析锚点文本：`路径#sha12:lineSha12`。
 * 切分口径（坑①）：按**第一个 `#`** 与**最后一个 `:`** —— Windows 盘符本身含冒号（形如「盘符 + 反斜杠」），必须从右侧找冒号。
 */
export function parseAnchor(text) {
  const raw = String(text == null ? '' : text).trim();
  if (!raw) return { ok: false, why: 'EMPTY' };
  const hashIdx = raw.indexOf('#');
  if (hashIdx <= 0) return { ok: false, why: 'NO_HASH' };
  const p = raw.slice(0, hashIdx);
  const rest = raw.slice(hashIdx + 1);
  const colonIdx = rest.lastIndexOf(':');
  if (colonIdx <= 0) return { ok: false, why: 'NO_LINE_HASH' };
  const sha12 = rest.slice(0, colonIdx);
  const lineSha12 = rest.slice(colonIdx + 1);
  if (!/^[0-9a-f]{12}$/.test(sha12)) return { ok: false, why: 'BAD_SHA12' };
  if (!/^[0-9a-f]{12}$/.test(lineSha12)) return { ok: false, why: 'BAD_LINE_SHA12' };
  return { ok: true, path: p.replace(/\\/g, '/'), sha12, lineSha12, raw };
}

// 路径白名单：必须在仓库根内；排除 _tmp、sandbox、证据-x、代码快照-x（沙盘放行 _tmp）。
export function resolveAnchorPath(relOrAbs) {
  const root = anchorRepoRoot();
  const raw = String(relOrAbs == null ? '' : relOrAbs).trim();
  if (!raw) return { ok: false, why: 'EMPTY' };
  const abs = path.resolve(root, raw.replace(/^[/\\]+/, ''));
  const rel = path.relative(root, abs).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return { ok: false, why: 'OUTSIDE', abs, rel };
  const first = rel.split('/')[0] || '';
  if (first === '_tmp' && isSandbox()) return { ok: true, abs, rel };
  if (EXCLUDED_PREFIXES.includes(first)) return { ok: false, why: 'EXCLUDED', abs, rel, prefix: first };
  if (EXCLUDED_PATTERNS.some((re) => re.test(first))) return { ok: false, why: 'EXCLUDED', abs, rel, prefix: first };
  return { ok: true, abs, rel };
}

function anchorOut(args, human, json) {
  if (args.json) { process.stdout.write(JSON.stringify(json, null, 2) + '\n'); return; }
  process.stdout.write(human + '\n');
}

/** `team.mjs anchor cite <path> --line <n>` */
export function cmdAnchorCite(args) {
  const sub = String(args._[1] || '').toLowerCase();
  if (sub && sub !== 'cite') { /* check 走另一分支 */ }
  const target = String(args._[2] || args.path || '').trim();
  if (!target) fail('ANCHOR_BAD_FORMAT', '用法：anchor cite <path> --line <n>', {}, 1);
  const lineRaw = String(args.line == null ? '' : args.line).trim();
  const lineNo = Number(lineRaw);
  if (!Number.isInteger(lineNo) || lineNo <= 0) {
    fail('ANCHOR_LINE_OUT_OF_RANGE', `--line 必须是正整数（收到 ${lineRaw || '(空)'}）`, { line: lineRaw }, 1);
  }
  const resolved = resolveAnchorPath(target);
  if (!resolved.ok) {
    fail('ANCHOR_PATH_OUTSIDE', `路径不在白名单内（${resolved.why === 'EXCLUDED' ? '排除目录' : '仓库根外'}）：${target}`, { path: target, resolvedPath: resolved.abs, rel: resolved.rel || '' }, 1);
  }
  const file = readAnchorFile(resolved.abs);
  if (!file) fail('ANCHOR_FILE_MISSING', `文件不存在：${resolved.rel}`, { path: resolved.rel }, 3);
  if (lineNo > file.lines.length) {
    fail('ANCHOR_LINE_OUT_OF_RANGE', `行号越界：--line ${lineNo} 超过末行 ${file.lines.length}`, { line: lineNo, lastLine: file.lines.length }, 1);
  }
  const lineText = file.lines[lineNo - 1];
  const fileSha12 = fileSha12Of(file.buf);
  const lineSha12 = lineSha12Of(lineText);
  const anchor = `${resolved.rel}#${fileSha12}:${lineSha12}`;
  const json = { ok: true, anchor, path: resolved.rel, lineNo, fileSha12, lineSha12, lineText40: String(lineText || '').trim().slice(0, 40) };
  anchorOut(args, anchor, json);
}

/** `team.mjs anchor check <anchor> [--file <path>]` */
export function cmdAnchorCheck(args) {
  const rawAnchor = String(args._[2] || args.anchor || '').trim();
  if (!rawAnchor) fail('ANCHOR_BAD_FORMAT', '用法：anchor check <路径#sha12:lineSha12> [--file <path>]', {}, 1);
  const parsed = parseAnchor(rawAnchor);
  if (!parsed.ok) {
    const hint = parsed.why === 'NO_LINE_HASH'
      ? '锚点缺行指纹（只有 路径#sha12）：请用「路径#sha12:lineSha12」，由 anchor cite 生成'
      : '锚点格式应为 路径#sha12:lineSha12（两段都是 12 位小写 hex）';
    fail('ANCHOR_BAD_FORMAT', `锚点格式非法（${parsed.why}）：${hint}`, { anchor: rawAnchor, why: parsed.why }, 1);
  }
  const fileArg = String(args.file || args._[3] || '').trim() || parsed.path;
  const resolved = resolveAnchorPath(fileArg);
  if (!resolved.ok) {
    fail('ANCHOR_PATH_OUTSIDE', `路径不在白名单内：${fileArg}`, { path: fileArg, resolvedPath: resolved.abs, rel: resolved.rel || '' }, 1);
  }
  const file = readAnchorFile(resolved.abs);
  if (!file) fail('ANCHOR_FILE_MISSING', `文件不存在：${resolved.rel}`, { path: resolved.rel, anchor: parsed.raw, next: '先确认文件是否移动/改名' }, 3);
  const currentFileSha12 = fileSha12Of(file.buf);
  const fileUnchanged = currentFileSha12 === parsed.sha12;
  // B-20261120-021256-e504（PM 实测假阳性）：**任何情况下都必须逐行校验**——文件快照一致只说明「文件没变」，
  // 不代表「锚点里的行指纹真的存在于这个文件」。旧实现「快照一致就 ok:true + lineNo:0」是契约级假阳性
  // （随机指纹 `…#f32055807499:111111111111` 也会 ok:true），会连带架空 AC7 的 EVIDENCE_ANCHOR_STALE。
  // 判定顺序（PM 写死）：文件快照 → 逐行 lineSha12 精确匹配 → 无匹配 STALE / 多匹配 AMBIGUOUS。
  const hits = [];
  for (let i = 0; i < file.lines.length; i += 1) {
    if (lineSha12Of(file.lines[i]) === parsed.lineSha12) hits.push(i + 1);
  }
  if (hits.length === 1) {
    const json = {
      ok: true, anchor: parsed.raw, path: resolved.rel, lineNo: hits[0],
      matched: fileUnchanged ? 'snapshot' : 'fingerprint', fileSha12: currentFileSha12,
    };
    const verb = fileUnchanged ? 'snapshot' : 'fingerprint';
    anchorOut(args, `${parsed.raw} → ${verb} 命中（行 ${hits[0]}）`, json);
    return;
  }
  if (hits.length === 0) {
    fail('ANCHOR_STALE', `锚点已失效（该行指纹在文件里不存在${fileUnchanged ? '；文件快照一致但行指纹不匹配，说明锚点本身写错了' : ''}）：${resolved.rel}`, {
      anchor: parsed.raw, path: resolved.rel, currentFileSha12,
      next: '重新 anchor cite 生成新锚点',
    }, 2);
  }
  fail('ANCHOR_AMBIGUOUS', `锚点歧义：该行内容在文件里出现 ${hits.length} 次（行 ${hits.slice(0, 10).join(', ')}）`, {
    anchor: parsed.raw, path: resolved.rel, candidates: hits, currentFileSha12,
    next: '改用相邻行/块级限定提供唯一上下文',
  }, 2);
}

/** 分发：`anchor cite|check`。 */
export function cmdAnchor(args) {
  const sub = String(args._[1] || '').toLowerCase();
  if (sub === 'cite') return cmdAnchorCite(args);
  if (sub === 'check') return cmdAnchorCheck(args);
  fail('BAD_SUBCOMMAND', `未知 anchor 子命令：${sub || '(空)'}（只支持 cite / check）`, { sub }, 1);
}
