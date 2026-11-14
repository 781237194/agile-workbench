'use strict';
/** B-155a：给 ops.mjs 增加 req register / req void（幽灵需求登记与作废）+ cmdReq 分发。 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const file = path.join(ROOT, '团队', '工具', 'lib', 'ops.mjs');
let s = fs.readFileSync(file, 'utf8');
if (s.includes('function cmdReqRegister(')) { console.log('已存在，跳过'); process.exit(0); }

const anchor = 'export function cmdReq(args) {';
const code = `/**
 * B-155a：把「只在工作台本地缓存里、工作流没有」的幽灵需求登记进工作流（可评审/派单）。
 * 幂等：已在工作流 → ALREADY_REGISTERED（零副作用）。
 */
function cmdReqRegister(args) {
  const b = bootFor(args, 'req');
  if (!['pm', 'analyst', 'product'].includes(String(b.role))) {
    fail('PERMISSION_DENIED', '只有 PM / 需求分析 / 产品能登记幽灵需求', { role: b.role });
  }
  const id = String(args.id || args.requirement || '').trim();
  if (!id) fail('BAD_ID', '需要 --id R-...');
  if (!/^R-\\d{8}-\\d{6}-[0-9a-f]{4}$/.test(id)) fail('BAD_ID', '需求 id 形态应为 R-YYYYMMDD-HHMMSS-xxxx', { id });
  const stateRead = readWorkflowState(b.project, { fresh: true });
  const wf = stateRead.state || {};
  const rows = wf.requirements || {};
  const existing = rows[id] || Object.values(rows).find((r) => r && String(r.id || '') === id);
  if (existing) fail('ALREADY_REGISTERED', \`需求已在工作流：\${id}（status=\${existing.status || '?'}）\`, { requirementId: id, status: existing.status });
  const title = String(args.title || '').trim() || id;
  const at = nowIso();
  let task = null;
  try { task = loadTask(b.project, id); } catch { task = null; }
  if (!task) {
    task = {
      id, project: b.project, type: 'requirement', requirementId: '',
      title: truncate(title, 120), detail: truncate(String(args.detail || '从工作台本地缓存登记（无需求正文）'), 1000),
      acceptance: truncate(String(args.acceptance || ''), 1000), story: '',
      priority: String(args.priority || 'P2'), priorityBy: b.role, priorityReason: '',
      owner: null, status: 'open', createdBy: b.role, createdAt: at, claimedAt: null, due: '',
      doneAt: null, evidence: '', rev: 0,
      history: [],
      workflow: { requirementStatus: 'review', registeredFrom: 'cache', registeredAt: at, registeredBy: b.role },
    };
    task._by = b.role; task._action = 'req_register'; task._note = '从本地缓存登记';
    saveTask(b.project, task);
  }
  const sync = syncWorkflowRow(b.project, task, 'review', {
    teamMode: task.workflow && task.workflow.teamMode,
  }, { create: true, action: 'req_register', by: b.role, note: '从本地缓存登记（幽灵需求）', phase: 'review' });
  appendEvent({
    role: b.role, sessionId: b.sessionId, action: 'requirement_registered', project: b.project,
    target: id, note: truncate(title, 120), data: { requirementId: id, from: 'cache', workflowFile: sync && sync.file },
  });
  out(args, \`已登记幽灵需求 \${id}（\${title}）→ 工作流 status=review\\n工作流：\${sync && sync.file ? sync.file : ''}\`, {
    ok: true, requirementId: id, title, status: 'review', workflowFile: sync && sync.file,
  });
}

/**
 * B-155a：把幽灵需求作废（登记到 需求/作废登记.jsonl，工作流行置 terminated，原因 ghost_void）。
 * 幂等：已 terminated/voided → ALREADY_VOIDED。
 */
function cmdReqVoid(args) {
  const b = bootFor(args, 'req');
  if (!['pm', 'analyst', 'product'].includes(String(b.role))) fail('PERMISSION_DENIED', '只有 PM / 需求分析 / 产品能作废幽灵需求', { role: b.role });
  const id = String(args.id || args.requirement || '').trim();
  const reason = String(args.reason || '').trim();
  if (!id) fail('BAD_ID', '需要 --id R-...');
  if (!reason) fail('REASON_REQUIRED', '作废必须带 --reason（为什么作废）', { requirementId: id });
  const stateRead = readWorkflowState(b.project, { fresh: true });
  const wf = stateRead.state || {};
  const rows = wf.requirements || {};
  const row = rows[id] || Object.values(rows).find((r) => r && String(r.id || '') === id) || null;
  const at = nowIso();
  if (row && ['terminated', 'accepted'].includes(String(row.status || ''))) {
    fail('ALREADY_VOIDED', \`需求已是 \${row.status}，不能重复作废\`, { requirementId: id, status: row.status });
  }
  const registry = path.join(projectStatePaths(b.project).dir, '..', '..', '..', '..', '需求', '作废登记.jsonl');
  const line = JSON.stringify({ at, requirementId: id, reason: truncate(reason, 300), by: b.role, hadWorkflowRow: Boolean(row) });
  try {
    ensureDir(path.dirname(registry));
    fs.appendFileSync(registry, line + '\\n', 'utf8');
  } catch { /* 登记失败不阻断作废 */ }
  if (row) {
    row.status = 'terminated';
    row.gateInvalidatedAt = at;
    row.gateInvalidatedBy = 'ghost_void';
    row.voidReason = truncate(reason, 300);
    writeWorkflowState(b.project, stateRead.state);
    try {
      const task = loadTask(b.project, id);
      task.status = 'done'; task.doneAt = at; task.workflow = { ...(task.workflow || {}), requirementStatus: 'terminated' };
      task._by = b.role; task._action = 'req_void'; task._note = truncate(reason, 200);
      saveTask(b.project, task);
    } catch { /* 没任务文件也能作废工作流行 */ }
  }
  appendEvent({
    role: b.role, sessionId: b.sessionId, action: 'requirement_voided', project: b.project,
    target: id, note: truncate(reason, 120), data: { requirementId: id, hadWorkflowRow: Boolean(row), registry },
  });
  out(args, \`已作废 \${id}（\${row ? '工作流置 terminated' : '仅登记作废（工作流无此行）'}）\\n原因：\${reason}\\n登记：\${registry}\`, {
    ok: true, requirementId: id, status: row ? 'terminated' : 'voided', registry, hadWorkflowRow: Boolean(row),
  });
}

`;

s = s.replace(anchor, code + anchor);
// cmdReq 分发
s = s.replace("  if (sub === 'reopen') return cmdReqReopen(args);",
  "  if (sub === 'reopen') return cmdReqReopen(args);\n  // B-155a：幽灵需求登记 / 作废（工作流没有但工作台缓存里有）。\n  if (sub === 'register') return cmdReqRegister(args);\n  if (sub === 'void') return cmdReqVoid(args);");
fs.writeFileSync(file, s, 'utf8');
console.log('ops.mjs 已加 req register / req void');
