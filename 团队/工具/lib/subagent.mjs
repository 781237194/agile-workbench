// 团队工作台 v2 · 子代理边界与版本合并（R-20261112-101932-beb3）
//
// 纪律：子代理只做可切块、只读、写入隔离的辅助；能不能开、能开几个由程序判：
// - 门槛：读 >5 个文件或 >32KB；不满足不得开；
// - 预算：PM 最多 2 个、其他角色最多 1 个，按活动锁 `subagent:<角色>:<n>` 计；
// - 记录：每次 start/end 落 团队/状态/项目/<P>/子代理/记录.jsonl（真相），
//   并镜像到本角色 `产出/子代理记录.md`；没有记录 = 没发生，评审/验收拒收；
// - 合并：需求/产品分头写时用 subagent merge 产出 `产出/子代理合并记录-vN.md`（基线/逐节/冲突/哈希/签字）。
// - 检出即违规：子代理写共享层在 start 阶段直接拒绝（SUBAGENT_WRITE_DENIED），
//   已存在的越界产出在 review/apply 阶段由调用方拒收。
import fs from 'node:fs';
import path from 'node:path';
import {
  fail, nowIso, sha256, exists, ensureDir, readText, writeText, appendLine, readJsonlTolerant,
  acquireLock, releaseLock, listLocks, truncate, stamp, randomHex, jsonOut, textOut,
} from './core.mjs';
import { requireBoot, projectStatePaths, loadProject } from './store.mjs';
import { ROLE_DIRS, ROLE_NAMES } from './roles.mjs';

export const SUBAGENT_BUDGET = { pm: 2, default: 1 };
const LOCK_PREFIX = 'subagent';
const SHARED_WRITE_RE = /^(src|团队|app|public)([\\/]|$)/i;

export function subagentBudgetFor(role) {
  return role === 'pm' ? SUBAGENT_BUDGET.pm : SUBAGENT_BUDGET.default;
}

function out(args, human, json) {
  if (args.json) jsonOut(json);
  else textOut(human);
}

function bootOf(args, action) {
  if (!args.boot) fail('BOOT_REQUIRED', `需要 --boot <启动令牌>；先运行 boot（${action}）`);
  return requireBoot(String(args.boot), {});
}

function recordsPath(projectName) {
  return path.join(projectStatePaths(projectName).dir, '子代理', '记录.jsonl');
}

function readRawRecords(projectName) {
  const { items } = readJsonlTolerant(recordsPath(projectName));
  return items;
}

/** JSONL 追加语义：start 一条、end 一条 update；按 id 合并出当前状态。 */
export function listSubagentRecords(projectName) {
  const merged = new Map();
  for (const row of readRawRecords(projectName)) {
    if (!row || !row.id) continue;
    if (row.update) {
      const prev = merged.get(row.id) || {};
      merged.set(row.id, { ...prev, ...row, update: undefined });
    } else {
      merged.set(row.id, { ...row });
    }
  }
  return [...merged.values()].sort((a, b) => String(a.startedAt || '').localeCompare(String(b.startedAt || '')));
}

function appendRecord(projectName, row) {
  appendLine(recordsPath(projectName), JSON.stringify(row));
}

function roleDirOf(project, role) {
  const dirName = ROLE_DIRS[role];
  if (!dirName) fail('BAD_ROLE', `未知角色：${role}`);
  return path.join(path.resolve(project.path), dirName);
}

/** 把当前记录渲染成角色目录下的 `产出/子代理记录.md`（只读镜像，真相在 JSONL）。 */
export function renderSubagentRecordMirror(projectName, role) {
  const project = loadProject(projectName);
  const outDir = path.join(roleDirOf(project, role), '产出');
  ensureDir(outDir);
  const rows = listSubagentRecords(projectName).filter((row) => row.role === role);
  const header = [
    '# 子代理记录',
    '',
    `> 由 team.mjs subagent start/end 自动生成；六字段：角色｜目的｜输入路径｜输出路径｜耗时｜复核结论。`,
    `> 没有记录 = 没发生：评审/验收要能对上锁、记录行与文件作者，缺一拒收。`,
    '',
    '| 角色 | 目的 | 输入路径 | 输出路径 | 耗时 | 复核结论 |',
    '|---|---|---|---|---|---|',
  ];
  const body = rows.map((row) => {
    const inputs = Array.isArray(row.inputs) ? row.inputs.join('<br>') : String(row.inputs || '');
    const duration = row.endedAt ? `${Math.max(0, Number(row.durationMs || 0))} ms` : '（运行中）';
    return `| ${role} | ${escapeCell(row.purpose)} | ${escapeCell(inputs)} | ${escapeCell(row.output || '（未结束）')} | ${duration} | ${escapeCell(row.review || row.status || '')} |`;
  });
  writeText(path.join(outDir, '子代理记录.md'), [...header, ...(body.length ? body : ['| （暂无） | | | | | |']), ''].join('\n'));
  return { file: path.join(outDir, '子代理记录.md'), count: rows.length };
}

function escapeCell(value) {
  return String(value == null ? '' : value).replace(/\|/g, '/').replace(/\s+/g, ' ').slice(0, 160);
}

function activeLocksFor(role) {
  return listLocks().filter((lock) => lock && !lock.stale && String(lock.key || '').startsWith(`${LOCK_PREFIX}:${role}:`));
}

function nextLockKey(role) {
  const used = new Set(activeLocksFor(role).map((lock) => String(lock.key)));
  for (let index = 1; index <= subagentBudgetFor(role) + 2; index += 1) {
    const key = `${LOCK_PREFIX}:${role}:${index}`;
    if (!used.has(key)) return key;
  }
  return `${LOCK_PREFIX}:${role}:${Date.now()}`;
}

function parseNumber(value) {
  const n = Number(value);
  return Number.isFinite(n) && n >= 0 ? n : null;
}

function checkThreshold(args) {
  const files = parseNumber(args.files);
  const bytes = parseNumber(args.bytes);
  if (files === null && bytes === null) {
    fail('SUBAGENT_THRESHOLD_REQUIRED', '开子代理前必须给出工作量证据：--files <读取文件数> 或 --bytes <读取字节数>，程序据此判门槛', {
      hint: '门槛：读 >5 个文件 或 >32KB；不满足本人做',
    });
  }
  const overFiles = files !== null && files > 5;
  const overBytes = bytes !== null && bytes > 32 * 1024;
  if (!overFiles && !overBytes) {
    fail('SUBAGENT_THRESHOLD_NOT_MET', `未达开子代理门槛（文件 ${files ?? '—'}、字节 ${bytes ?? '—'}）；不满足“>5 个文件或 >32KB”就本人做`, {
      files, bytes, limits: { files: 5, bytes: 32 * 1024 },
    });
  }
  return { files: files ?? 0, bytes: bytes ?? 0 };
}

function checkWrites(writes) {
  const list = Array.isArray(writes) ? writes : String(writes || '').split(',').map((s) => s.trim()).filter(Boolean);
  for (const rel of list) {
    const normalized = String(rel).replace(/\\/g, '/');
    if (SHARED_WRITE_RE.test(normalized)) {
      fail('SUBAGENT_WRITE_DENIED', `子代理不许写共享层/别人目录：${normalized}；共享层（src/**、团队/**）与角色正式产出只能本人写`, {
        writes: list, denied: normalized,
      });
    }
    if (!/^_tmp\//.test(normalized)) {
      fail('SUBAGENT_WRITE_DENIED', `子代理写入必须隔离在 _tmp/ 下（当前 ${normalized}）；正式产出由本人合并`, { writes: list, denied: normalized });
    }
  }
  return list;
}

function inputList(args) {
  const raw = args.input ?? args.inputs ?? '';
  return String(raw).split(',').map((s) => s.trim()).filter(Boolean);
}

export function cmdSubagent(args) {
  const sub = String(args._[1] || 'list').trim().toLowerCase();
  if (sub === 'start') return subagentStart(args);
  if (sub === 'end') return subagentEnd(args);
  if (sub === 'merge') return subagentMerge(args);
  if (sub === 'list' || sub === 'status') return subagentList(args);
  fail('BAD_SUBCOMMAND', `未知 subagent 子命令：${sub}（start / end / merge / list）`);
}

function subagentStart(args) {
  const b = bootOf(args, 'subagent start');
  const role = String(args.role || b.role).trim();
  if (role !== b.role) {
    fail('SUBAGENT_ROLE_MISMATCH', `只能以自己的身份开子代理：令牌角色 ${b.role} ≠ --role ${role}`, { bootRole: b.role, role });
  }
  const mode = String(args.mode || 'read-only').trim().toLowerCase();
  if (!['read-only', 'readonly'].includes(mode)) {
    fail('SUBAGENT_READONLY_REQUIRED', '子代理只能是只读辅助（--mode read-only）；写代码、提案、互审、合并都由本人做', { mode });
  }
  const purpose = String(args.purpose || '').trim();
  if (!purpose) fail('SUBAGENT_PURPOSE_REQUIRED', '需要 --purpose "子代理要做什么"');
  const evidence = checkThreshold(args);
  const writes = checkWrites(args.writes || '');
  const inputs = inputList(args);
  const ttlMinutes = Math.max(1, Math.min(120, Number(args.ttl || 30)));
  const lockKey = nextLockKey(role);
  const budget = subagentBudgetFor(role);
  const active = activeLocksFor(role);
  if (active.length >= budget) {
    fail('SUBAGENT_BUDGET_EXCEEDED', `${ROLE_NAMES[role] || role} 的只读子代理预算已满（${active.length}/${budget}，${role === 'pm' ? 'PM' : '非 PM'} 上限）；先 subagent end 再开`, {
      role, budget, active: active.map((lock) => ({ key: lock.key, role: lock.role, expiresAt: lock.expiresAt })), code: 'SUBAGENT_BUDGET_EXCEEDED',
    });
  }
  const owner = acquireLock(lockKey, {
    role, sessionId: b.sessionId, ttlMs: ttlMinutes * 60000, waitMs: 0, reason: `subagent:${purpose}`,
  });
  const at = nowIso();
  const record = {
    id: `S-${stamp()}-${randomHex(2)}`,
    project: b.project,
    role,
    purpose: truncate(purpose, 300),
    mode: 'read-only',
    inputs,
    writes,
    files: evidence.files,
    bytes: evidence.bytes,
    lockKey,
    startedAt: at,
    endedAt: null,
    durationMs: null,
    output: '',
    review: '',
    status: 'running',
    sessionId: b.sessionId,
    ttlMinutes,
  };
  appendRecord(b.project, record);
  const mirror = renderSubagentRecordMirror(b.project, role);
  const human = [
    `子代理已领锁：${record.id}（${ROLE_NAMES[role] || role}）`,
    `锁：${lockKey} ｜ TTL ${ttlMinutes} 分钟 ｜ 到期 ${owner.expiresAt}`,
    `目的：${record.purpose}`,
    `输入：${inputs.join('、') || '（未写）'} ｜ 写入：${writes.join('、') || '（只读）'}`,
    `记录：${mirror.file}`,
    '下一步：结束必须 subagent end --id <id> --result <路径> --note "复核结论"，否则视为没发生。',
  ].join('\n');
  out(args, human, { ok: true, subagent: record, lock: owner, mirror: mirror.file });
}

function subagentEnd(args) {
  const b = bootOf(args, 'subagent end');
  const id = String(args.id || '').trim();
  if (!id) fail('BAD_ID', '需要 --id S-...');
  const records = listSubagentRecords(b.project);
  const record = records.find((row) => row.id === id);
  if (!record) fail('SUBAGENT_RECORD_NOT_FOUND', `没有子代理记录：${id}（没有 start = 没发生）`, { id });
  if (record.role !== b.role) fail('SUBAGENT_ROLE_MISMATCH', `只能结束自己的子代理：记录角色 ${record.role} ≠ 令牌角色 ${b.role}`, { id, recordRole: record.role });
  if (record.status !== 'running') fail('SUBAGENT_ALREADY_ENDED', `子代理 ${id} 已结束（${record.status}）`, { id, status: record.status });
  const failed = String(args.failed || '').trim();
  const result = String(args.result || '').trim();
  const note = String(args.note || '').trim();
  if (!failed && !result) fail('SUBAGENT_RESULT_REQUIRED', '结束时必须给 --result <产出路径>（或 --failed "原因"）', { id });
  if (!failed && !note) fail('SUBAGENT_REVIEW_REQUIRED', '结束必须给 --note "复核结论"：子代理产出未经本人复核不能入库', { id });
  const at = nowIso();
  const update = {
    id,
    update: true,
    endedAt: at,
    durationMs: Math.max(0, Date.parse(at) - Date.parse(String(record.startedAt || ''))),
    output: truncate(result, 300),
    review: truncate(note || `失败：${failed}`, 300),
    status: failed ? 'failed' : 'completed',
    endedBy: b.role,
    endedSession: b.sessionId,
  };
  appendRecord(b.project, update);
  let released = false;
  try {
    released = releaseLock(record.lockKey, { role: b.role });
  } catch (error) {
    // 锁主不一致/锁已被 TTL 回收都不阻塞记录；把事实写进 note。
    update.releaseWarning = String((error && error.message) || error).slice(0, 200);
  }
  const mirror = renderSubagentRecordMirror(b.project, b.role);
  out(args, [
    `子代理已结束：${id} → ${update.status}`,
    `产出：${update.output || '（无）'} ｜ 耗时 ${update.durationMs} ms ｜ 锁已释放：${released ? '是' : '否（TTL 已回收）'}`,
    `复核：${update.review}`,
    `记录：${mirror.file}`,
  ].join('\n'), { ok: true, subagent: { ...record, ...update }, released, mirror: mirror.file });
}

function sectionize(text) {
  const lines = String(text || '').replace(/^\uFEFF/, '').split(/\r?\n/);
  const rows = [];
  let current = { title: '(前言)', body: [] };
  for (const line of lines) {
    const match = /^##\s+(.+)$/.exec(line);
    if (match) {
      rows.push({ title: current.title, body: current.body.join('\n').trim() });
      current = { title: match[1].trim(), body: [] };
    } else {
      current.body.push(line);
    }
  }
  rows.push({ title: current.title, body: current.body.join('\n').trim() });
  return rows.filter((row) => row.title !== '(前言)' || row.body);
}

function relInside(project, given) {
  const abs = path.isAbsolute(given) ? path.resolve(given) : path.resolve(project.path, given);
  const root = path.resolve(project.path);
  if (!abs.toLowerCase().startsWith(root.toLowerCase() + path.sep) && abs.toLowerCase() !== root.toLowerCase()) {
    fail('SUBAGENT_PATH_OUTSIDE', `路径必须在项目内：${given}`, { path: abs, projectRoot: root });
  }
  return { abs, rel: path.relative(root, abs).replace(/\\/g, '/') };
}

function versionOf(name) {
  const match = /-v(\d+)\.md$/i.exec(String(name || ''));
  return match ? Number(match[1]) : 0;
}

/**
 * subagent merge：需求/产品分头写章节后的合并登记。
 * 五步：基线版本 → 逐节合并 → 冲突清单 → 合并后哈希 → 本人复核签字。
 * --auto 时按“基线正文 + 各分片章节”拼出 --out（不覆盖已存在文件）；否则要求 --out 已由本人写好。
 */
function subagentMerge(args) {
  const b = bootOf(args, 'subagent merge');
  if (!['analyst', 'product'].includes(b.role)) {
    fail('SUBAGENT_ROLE_NOT_ALLOWED', '版本合并只用于需求分析师/产品的多子代理写作；其他角色直接本人写', { role: b.role });
  }
  const project = loadProject(b.project);
  const baseArg = String(args.base || '').trim();
  if (!baseArg) fail('BAD_ARGS', '需要 --base <基线文件，如 产出/需求分析-v2.md>');
  const base = relInside(project, baseArg);
  if (!exists(base.abs)) fail('SUBAGENT_MERGE_BASE_MISSING', `基线文件不存在：${base.rel}`, { base: base.rel });
  const partArgs = String(args.parts || '').split(',').map((s) => s.trim()).filter(Boolean);
  if (!partArgs.length) fail('BAD_ARGS', '需要 --parts <分片1,分片2>');
  const parts = partArgs.map((item) => {
    const hit = relInside(project, item);
    if (!exists(hit.abs)) fail('SUBAGENT_MERGE_PART_MISSING', `分片不存在：${hit.rel}`, { part: hit.rel });
    return { ...hit, text: readText(hit.abs, ''), hash: sha256(fs.readFileSync(hit.abs)) };
  });
  const outArg = String(args.out || '').trim();
  if (!outArg) fail('BAD_ARGS', '需要 --out <合并后文件，如 产出/需求分析-v3.md>');
  const outFile = relInside(project, outArg);
  if (exists(outFile.abs) && !args.force) {
    fail('SUBAGENT_MERGE_OUT_EXISTS', `合并目标已存在，不覆盖历史版本：${outFile.rel}；请换 vN+1 或用 --force（需本人确认）`, { out: outFile.rel });
  }
  const baseText = readText(base.abs, '');
  const baseSections = sectionize(baseText);
  const baseTitles = new Set(baseSections.map((row) => row.title));
  const partSections = [];
  for (const part of parts) {
    for (const section of sectionize(part.text)) {
      partSections.push({ part: part.rel, title: section.title, body: section.body, hash: sha256(section.body) });
    }
  }
  // 冲突：同一章节标题来自多个分片且正文哈希不同；或分片章节与基线同名但内容不同（提示人工裁决）。
  const byTitle = new Map();
  for (const section of partSections) {
    const list = byTitle.get(section.title) || [];
    list.push(section);
    byTitle.set(section.title, list);
  }
  const conflicts = [];
  for (const [title, list] of byTitle.entries()) {
    if (list.length > 1 && new Set(list.map((row) => row.hash)).size > 1) {
      conflicts.push({ title, parts: list.map((row) => ({ part: row.part, hash: row.hash.slice(0, 12) })), reason: '多个分片写同一章节且内容不同' });
    }
    if (baseTitles.has(title)) {
      const baseSection = baseSections.find((row) => row.title === title);
      if (baseSection && sha256(baseSection.body) !== list[0].hash) {
        conflicts.push({ title, parts: [{ part: list[0].part, hash: list[0].hash.slice(0, 12) }], reason: `与基线 ${base.rel} 同名章节内容不同` });
      }
    }
  }
  const extraConflicts = String(args.conflict || '').split(/[\n;；]/).map((s) => s.trim()).filter(Boolean)
    .map((note) => ({ title: '(人工标注)', parts: [], reason: note }));
  const allConflicts = [...conflicts, ...extraConflicts];
  if (args.auto) {
    const built = [
      baseText.trim(),
      ...parts.map((part) => `\n\n<!-- 合并自分片：${part.rel} -->\n\n${part.text.trim()}`),
    ].join('');
    writeText(outFile.abs, built.replace(/\n{3,}/g, '\n\n') + '\n');
  }
  if (!exists(outFile.abs)) {
    fail('SUBAGENT_MERGE_OUT_MISSING', `合并目标不存在：${outFile.rel}；本人写好合并稿再登记，或加 --auto 由工具按分片拼接`, { out: outFile.rel });
  }
  const outHash = sha256(fs.readFileSync(outFile.abs));
  const version = versionOf(outFile.rel) || 1;
  const recordDir = path.join(roleDirOf(project, b.role), '产出');
  ensureDir(recordDir);
  const recordFile = path.join(recordDir, `子代理合并记录-v${version}.md`);
  if (exists(recordFile) && !args.force) {
    fail('SUBAGENT_MERGE_RECORD_EXISTS', `合并记录已存在，不覆盖：${path.relative(project.path, recordFile)}`, { file: recordFile });
  }
  const at = nowIso();
  const sectionRows = partSections.map((row) => `| ${row.title} | ${row.part} | ${row.hash.slice(0, 12)} |`).join('\n') || '| （无章节） | | |';
  const conflictRows = allConflicts.map((row) => `| ${row.title} | ${row.reason} | ${(row.parts || []).map((p) => p.part || p).join('、') || '—'} |`).join('\n') || '| （无冲突） | | |';
  const text = [
    `# 子代理合并记录 · v${version}`,
    '',
    `- 角色：${b.role}（${ROLE_NAMES[b.role] || b.role}）`,
    `- 项目：${b.project}`,
    `- 基线版本：${base.rel}（sha256 ${sha256(fs.readFileSync(base.abs)).slice(0, 16)}）`,
    `- 合并时间：${at}`,
    '',
    '## 一、逐节合并结果',
    '',
    '| 章节 | 来源分片 | 正文哈希 |',
    '|---|---|---|',
    sectionRows,
    '',
    '## 二、冲突清单',
    '',
    '| 章节 | 原因 | 涉及分片 |',
    '|---|---|---|',
    conflictRows,
    '',
    '## 三、合并后哈希',
    '',
    `- 文件：${outFile.rel}`,
    `- sha256：${outHash}`,
    '',
    '## 四、复核签字',
    '',
    `- ${ROLE_NAMES[b.role] || b.role}（${b.role}）已于 ${at} 复核并签字；未签字前不得作为评审/验收证据。`,
    '',
    '> 五步固定：基线版本 → 逐节合并 → 冲突清单 → 合并后哈希 → 本人复核签字；缺一项即不合规。',
    '',
  ].join('\n');
  writeText(recordFile, text);
  out(args, [
    `合并记录已落：${path.relative(project.path, recordFile)}`,
    `基线：${base.rel} ｜ 分片：${parts.map((part) => part.rel).join('、')}`,
    `合并后：${outFile.rel}（sha256 ${outHash.slice(0, 16)}）`,
    `冲突：${allConflicts.length} 条${allConflicts.length ? '（见记录，需本人裁决）' : ''}`,
  ].join('\n'), {
    ok: true, role: b.role, base: base.rel, parts: parts.map((part) => part.rel), out: outFile.rel,
    outHash, conflicts: allConflicts, recordFile: path.relative(project.path, recordFile), version,
  });
}

function subagentList(args) {
  const name = String(args.project || '').trim();
  if (!name) fail('BAD_ARGS', '需要 --project <项目名>');
  const records = listSubagentRecords(name).filter((row) => !args.role || row.role === args.role);
  const rows = records.map((row) => ({
    id: row.id, role: row.role, status: row.status, purpose: row.purpose,
    startedAt: row.startedAt, duration: row.endedAt ? `${row.durationMs} ms` : '运行中', output: row.output || '',
  }));
  out(args, `子代理记录（${name}，${rows.length} 条）\n` + (rows.length
    ? rows.map((row) => `${row.id} ${row.status} ${row.role} ${row.duration} ${row.purpose}${row.output ? ' → ' + row.output : ''}`).join('\n')
    : '（暂无）'), { ok: true, records });
}

/** 评审/验收用：本人（proposal 作者）还有未结束的子代理 → 记录缺失/未复核，拒收。 */
export function assertNoPendingSubagent(projectName, role, { action = 'review' } = {}) {
  const pending = listSubagentRecords(projectName).filter((row) => row.role === role && row.status === 'running');
  if (!pending.length) return null;
  fail('SUBAGENT_RECORD_REQUIRED', `角色 ${role} 还有未结束的子代理（${pending.map((row) => row.id).join(', ')}）；先 subagent end --result --note 复核，否则视为没发生，${action === 'apply' ? '不能 apply' : '不能评审'}`, {
    role, pending: pending.map((row) => ({ id: row.id, lockKey: row.lockKey, startedAt: row.startedAt })), action,
  });
}

/** 验收/评审辅助：列出记录、锁与可疑项，供 verify / 测试复核。 */
export function subagentAudit(projectName) {
  const records = listSubagentRecords(projectName);
  const running = records.filter((row) => row.status === 'running');
  const activeLocks = listLocks().filter((lock) => !lock.stale && String(lock.key || '').startsWith(`${LOCK_PREFIX}:`));
  const warnings = [];
  for (const row of running) {
    const ageMs = Date.now() - Date.parse(String(row.startedAt || ''));
    if (Number.isFinite(ageMs) && ageMs > Number(row.ttlMinutes || 30) * 60000) {
      warnings.push({ code: 'SUBAGENT_LOCK_STALE', id: row.id, lockKey: row.lockKey, ageMs });
    }
  }
  for (const row of records) {
    if (row.status === 'completed' && !String(row.review || '').trim()) {
      warnings.push({ code: 'SUBAGENT_REVIEW_MISSING', id: row.id });
    }
  }
  return { records, running, activeLocks, warnings };
}

export { recordsPath };
