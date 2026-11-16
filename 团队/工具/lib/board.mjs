// 团队看板渲染：目录/明细/文件预览/项目切换/中文标签。
import { truncate, shortHash } from './core.mjs';

const ROLE = { pm: '项目经理', product: '产品设计师', analyst: '需求分析师', programmer1: '程序员 A', programmer2: '程序员 B', tester: '测试人员', owner: '老板' };
const STATUS = { open: '待领取', working: '进行中', done: '已完成', proposed: '待评审', reviewing: '评审中', signing: '待签字', approved: '已批准', applied: '已提交', rejected: '已拒绝', stale: '已过期', blocked: '阻塞', active: '活跃' };
const RISK = { normal: '普通', sensitive: '敏感', critical: '严重' };
const VERDICT = { approve: '通过', reject: '驳回' };
const DECISION = { approve: '批准', reject: '拒绝' };
const PHASE = { team: '团队协作', pilot: '试点', done: '完成' };

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}
function role(v) { return ROLE[v] || v || '—'; }
function status(v) { return STATUS[v] || v || '—'; }
function risk(v) { return RISK[v] || v || '—'; }
function verdict(v) { return VERDICT[v] || v || '—'; }
function decision(v) { return DECISION[v] || v || '—'; }
function phase(v) { return PHASE[v] || v || '—'; }
function time(v) { return String(v || '').slice(0, 19).replace('T', ' '); }
function clip(v, n) { return truncate(String(v || ''), n); }
function titleAttr(v) { return esc(String(v || '')); }
function owner(v) { return v ? role(v) : '—'; }
function sid(v) { return v ? '当前工作区' : '—'; }
// T-d2ee / R-9db6 F-9db6-3：条目没给 options 时的回执候选（与需求默认枚举一致）。
function dboxDefaultChoices() { return ['通过', '打回', '其他']; }
// 看板窗回执通道名（与程序员B 的后端 IPC 约定；只改这一处即可切换）。
const DECISION_RECEIPT_BRIDGE = 'decisionReceipt';
// PM 代管标识（T-a01d / R-1cee）：需求行状态列后面追加【PM通过】/【PM打回】/【待 PM 评审】。
function proxyTag(row) { return row && row.ownerProxyLabel ? ' ' + row.ownerProxyLabel : ''; }

function rowsHtml(headers, rows, empty = '暂无') {
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.join('') : `<tr><td colspan="${headers.length}" class="muted">${esc(empty)}</td></tr>`}</tbody></table>`;
}
function tag(text, ok) { return `<span class="tag ${ok ? 'ok' : 'bad'}">${esc(text)}</span>`; }

// R-45d3 F-45d3-1~5：看板回执区数据准备。计数维度写死 from（回执无 role 字段，to 只是「交给谁」）；
// 今天/更早按本地日界分组；每角色最新 1 条做保底；每组渲染上限 200（超出提示总数，不做分页）。
const ACK_ROLE_ORDER = ['programmer1', 'programmer2', 'tester', 'product', 'analyst', 'pm'];
const ACK_ROLE_LABEL = { programmer1: '程序员A', programmer2: '程序员B', tester: '测试', product: '产品', analyst: '分析师', pm: 'PM' };
const ACK_OTHER_KEY = 'other';
const ACK_OTHER_LABEL = '其他';
const ACK_GROUP_LIMIT = 200;
function ackRoleKey(from) {
  const f = String(from || '');
  return ACK_ROLE_ORDER.indexOf(f) >= 0 ? f : ACK_OTHER_KEY;
}
// 未知角色归「其他」置末；行内保留原始 from，便于审计。
function ackRoleText(from) {
  const f = String(from || '');
  if (ACK_ROLE_ORDER.indexOf(f) >= 0) return role(f);
  return f ? `${ACK_OTHER_LABEL}（${f}）` : ACK_OTHER_LABEL;
}
function ackReceiptId(r) {
  return String((r && r.id) || `${(r && r.msgId) || ''}|${(r && r.from) || ''}|${(r && r.ts) || ''}`);
}
// F-45d3-5：备注 title 取 note 原文（log 已截 160 字）；无 note 回退 log 标「（无完整备注）」。
function ackReceiptTitle(r) {
  const note = r && r.note != null ? String(r.note) : '';
  if (note.trim()) return note;
  const log = r && r.log != null ? String(r.log) : '';
  return log ? `${log}（无完整备注）` : '（无完整备注）';
}
function ackReceiptText(r) {
  const note = r && r.note != null ? String(r.note) : '';
  if (note.trim()) return clip(note, 100);
  const log = r && r.log != null ? String(r.log) : '';
  return log ? `${clip(log, 100)}（无完整备注）` : '—';
}
function ackTsMs(r) {
  const n = Date.parse(String((r && r.ts) || ''));
  return Number.isFinite(n) ? n : NaN;
}
function ackDayKey(ms) {
  const d = new Date(ms);
  return `${d.getFullYear()}-${d.getMonth() + 1}-${d.getDate()}`;
}

// 返回 { total, buckets, pins, pinned, today, earlier }；today/earlier 各含 rows/total/shown/truncated。
export function prepareReceipts(receipts, nowMs = Date.now()) {
  const rows = (Array.isArray(receipts) ? receipts : [])
    .filter((r) => r && typeof r === 'object')
    .map((r, i) => ({ r, i, ms: ackTsMs(r), id: ackReceiptId(r), key: ackRoleKey(r.from) }));
  // 按 ts 倒序；ts 非法置末并归「更早」。
  rows.sort((a, b) => {
    const av = Number.isFinite(a.ms);
    const bv = Number.isFinite(b.ms);
    if (av && bv) return (b.ms - a.ms) || (b.i - a.i);
    if (av !== bv) return av ? -1 : 1;
    return b.i - a.i;
  });
  const todayKey = ackDayKey(nowMs);
  const today = [];
  const earlier = [];
  for (const row of rows) {
    if (Number.isFinite(row.ms) && ackDayKey(row.ms) === todayKey) today.push(row);
    else earlier.push(row);
  }
  const counts = new Map();
  for (const row of rows) counts.set(row.key, (counts.get(row.key) || 0) + 1);
  const buckets = [...ACK_ROLE_ORDER, ACK_OTHER_KEY]
    .filter((k) => counts.get(k))
    .map((k) => ({ key: k, label: k === ACK_OTHER_KEY ? ACK_OTHER_LABEL : ACK_ROLE_LABEL[k], count: counts.get(k) }));
  // 保底：每个有回执的角色 1 条最新（未知角色合并成「其他」1 条）。
  const pins = buckets.map((b) => ({ key: b.key, label: b.label, row: rows.find((x) => x.key === b.key) })).filter((p) => p.row);
  const pinned = new Set(pins.map((p) => p.row.id));
  const pack = (list) => ({ rows: list.slice(0, ACK_GROUP_LIMIT), total: list.length, shown: Math.min(list.length, ACK_GROUP_LIMIT), truncated: list.length > ACK_GROUP_LIMIT });
  return { total: rows.length, buckets, pins, pinned, todayKey, today: pack(today), earlier: pack(earlier) };
}

export function renderBoardMd(d) {
  const lines = [];
  lines.push(`# 团队看板 · ${d.project?.name || '未选项目'}`);
  lines.push('');
  lines.push(`> 生成 ${d.generatedAt} ｜ 阶段 ${phase(d.team.phase)} ｜ 负责人 ${d.team.owner} ｜ 成员 ${d.members.length}`);
  if (d.questions && d.questions.total) {
    lines.push(`> 问询：未答 ${d.questions.open} ｜ 超时待升级 ${d.questions.overdue} ｜ 已升级 ${d.questions.escalated} ｜ 已回答 ${d.questions.answered}`);
  }
  lines.push('');
  lines.push('## 一、需求');
  lines.push('');
  if (!d.requirements.length) lines.push('（暂无需求）');
  else {
    lines.push('| 优先级 | 需求 | 状态 | 负责人 | 子任务 | 验收标准 |');
    lines.push('|---|---|---|---|---|---|');
    for (const r of d.requirements) lines.push(`| ${r.priority} | ${r.id} ${r.title} | ${status(r.derivedStatus || r.status)}${proxyTag(r)} | ${owner(r.owner)} | ${r.kidsDone ?? 0}/${r.kidsTotal ?? 0} | ${clip(r.acceptance, 100)} |`);
  }
  lines.push('');
  lines.push('## 二、进行中任务');
  lines.push('');
  const tasks = d.childTasks.filter((t) => t.status !== 'done');
  if (!tasks.length) lines.push('（无进行中任务）');
  else {
    lines.push('| 优先级 | 任务 | 状态 | 负责人 | 需求 |');
    lines.push('|---|---|---|---|---|');
    for (const t of tasks) lines.push(`| ${t.priority} | ${t.id} ${t.title} | ${status(t.status)} | ${owner(t.owner)} | ${t.requirementId || '—'} |`);
  }
  lines.push('');
  lines.push('## 三、提案');
  lines.push('');
  if (!d.proposals.length) lines.push('（暂无提案）');
  for (const p of d.proposals) {
    const rv = Object.entries(d.reviews[p.id] || {}).map(([r, v]) => `${role(r)}：${verdict(v.verdict)}`).join('；') || '—';
    const sg = Object.entries(d.signatures[p.id] || {}).map(([r, v]) => `${role(r)}：${decision(v.decision)}`).join('；') || '—';
    lines.push(`- ${p.id} ${p.title} ｜ ${risk(p.risk)} ｜ ${status(p.status)} ｜ 作者 ${role(p.author)} ｜ 评审 ${rv} ｜ 签字 ${sg} ｜ 提交 ${p.commitId || '—'}`);
  }
  lines.push('');
  lines.push('## 四、回执');
  lines.push('');
  for (const r of d.receipts.slice(0, 30)) lines.push(`- ${time(r.ts)} ｜ ${role(r.from)} ｜ ${r.project || '—'} ｜ ${r.msgId} ｜ ${clip(r.log || r.note, 100)}`);
  lines.push('');
  lines.push('## 五、项目文件');
  lines.push('');
  for (const f of d.files.slice(0, 200)) lines.push(`- ${f.target} ｜ ${f.size} B ｜ ${owner(f.owner)} ｜ ${shortHash(f.hash || '', 10)}`);
  lines.push('');
  lines.push('## 六、成员');
  lines.push('');
  for (const m of d.members) {
    const wf = d.wakeFailed && d.wakeFailed[m.role];
    lines.push(`- ${role(m.role)}（${m.name}）｜ 会话 ${sid(m.session)} ｜ 发消息 ${m.sent} ｜ 评审 ${m.reviews} ｜ 签字 ${m.signs} ｜ 提交 ${m.commits} ｜ 回执 ${m.acks}${wf ? ` ｜ 🔴 唤醒失败（${wf.attempt || '?'} 次，消息 ${wf.messageId || '无'}，原因 ${wf.why || '未知'}）` : ''}`);
  }
  lines.push('');
  lines.push('## 七、质量汇总');
  lines.push('');
  lines.push(`- 提交闭环：${d.commits.length} 次`);
  lines.push(`- 回执：${d.receipts.length} 条`);
  lines.push(`- 提案：${d.proposals.length} 个`);
  lines.push(`- 文件：${d.files.length} 个`);
  lines.push(`- 成员：${d.members.length} 人`);
  lines.push('');
  lines.push('## 八、成员日志');
  lines.push('');
  for (const l of d.logs.slice(0, 40)) lines.push(`- ${time(l.ts)} ｜ ${role(l.actor)} ｜ ${l.kind} ｜ ${clip(l.text, 120)}`);
  lines.push('');
  return lines.join('\n');
}

function claimBadge(t) {
  if (!t) return '';
  if (t.claimedAt) return ''; // 已认领：红标一律不显示（扫描也会清字段，这里是双保险）
  // T-20261116-124658-303e：认领门红标——任务行带 claimOverdue/claimStalled 就渲染，缺字段时静默。
  if (t.claimStalled === true) return ' <span class="tag bad" title="派单超过 30 分钟未认领，已升级">未认领·已升级</span>';
  if (t.claimOverdue === true) return ' <span class="tag bad" title="派单超过 10 分钟未认领">未认领·超时</span>';
  return '';
}

export function renderBoardHtml(d) {
  const reqRows = d.requirements.map((r) => `<tr><td><span class="pill p-${esc(r.priority)}">${esc(r.priority)}</span></td><td><b>${esc(r.id)}</b><br><span class="sub" title="${titleAttr(r.title)}">${esc(clip(r.title, 60))}</span></td><td>${esc(status(r.derivedStatus || r.status))}${esc(proxyTag(r))}</td><td>${esc(owner(r.owner))}</td><td>${r.kidsDone ?? 0}/${r.kidsTotal ?? 0}</td><td class="muted" title="${titleAttr(r.acceptance)}">${esc(clip(r.acceptance, 90))}</td></tr>`).join('');
  const taskRows = d.childTasks.filter((t) => t.status !== 'done').map((t) => `<tr><td><span class="pill p-${esc(t.priority)}">${esc(t.priority)}</span></td><td><b>${esc(t.id)}</b> <span class="sub" title="${titleAttr(t.title)}">${esc(clip(t.title, 70))}</span></td><td>${esc(status(t.status))}${claimBadge(t)}</td><td>${esc(owner(t.owner))}</td><td>${esc(t.requirementId || '—')}</td></tr>`).join('');
  const propRows = d.proposals.slice().reverse().map((p) => {
    const rv = Object.entries(d.reviews[p.id] || {}).map(([r, v]) => `<span class="tag ${v.verdict === 'approve' ? 'ok' : 'bad'}">${esc(role(r))}：${esc(verdict(v.verdict))}</span>`).join(' ') || '<span class="muted">—</span>';
    const sg = Object.entries(d.signatures[p.id] || {}).map(([r, v]) => `<span class="tag ${v.decision === 'approve' ? 'ok' : 'bad'}">${esc(role(r))}：${esc(decision(v.decision))}</span>`).join(' ') || '<span class="muted">—</span>';
    return `<tr><td><b>${esc(p.id)}</b><br><span class="sub" title="${titleAttr(p.title)}">${esc(clip(p.title, 48))}</span></td><td>${esc(risk(p.risk))}</td><td>${esc(status(p.status))}</td><td>${esc(role(p.author))}</td><td>${rv}</td><td>${sg}</td><td>${esc(p.commitId || '—')}</td></tr>`;
  }).join('');
  const ackRows = d.receipts.slice(-50).reverse().map((r) => `<tr><td class="muted">${esc(time(r.ts))}</td><td>${esc(role(r.from))}</td><td>${esc(r.project || '—')}</td><td>${esc(r.msgId)}</td><td title="${titleAttr(r.log || r.note)}">${esc(clip(r.log || r.note, 100))}</td></tr>`).join('');
  // R-45d3 F-45d3-1~6：回执区 = 角色 chip（带计数）+ 每角色保底 1 条 + 今天/更早分组（每组上限 200）。
  const RCPT = prepareReceipts(d.receipts);
  const ackRowHtml = (row, opts = {}) => {
    const r = row.r || {};
    const tsText = Number.isFinite(row.ms) ? time(r.ts) : `时间未知 ${time(r.ts)}`.trim();
    const attrs = [
      `data-ack-role="${esc(row.key)}"`,
      `data-ack-from="${esc(r.from || '')}"`,
      `data-receipt-id="${esc(row.id)}"`,
      opts.pinned ? 'data-pinned="1"' : '',
      opts.pinRole ? `data-ack-pin-role="${esc(opts.pinRole)}"` : '',
    ].filter(Boolean).join(' ');
    return `<tr ${attrs}><td class="muted">${esc(tsText)}</td><td>${esc(ackRoleText(r.from))}</td><td>${esc(r.project || '—')}</td><td>${esc(r.msgId || '—')}</td><td title="${titleAttr(ackReceiptTitle(r))}">${esc(ackReceiptText(r))}</td></tr>`;
  };
  const ackChipHtml = [`<button type="button" class="chip" data-ack-role="all" aria-pressed="true">全部(${RCPT.total})</button>`]
    .concat(RCPT.buckets.map((b) => `<button type="button" class="chip" data-ack-role="${esc(b.key)}" aria-pressed="false">${esc(b.label)}(${b.count})</button>`))
    .join('');
  const ackPinsHtml = RCPT.pins.length
    ? `<div class="ack-pins" data-ack-pins data-ack-pins-count="${RCPT.pins.length}"><div class="ack-pins-head"><b>各角色最新（保底 ${RCPT.pins.length} 条）</b><span>每角色 1 条；同一回执在列表里带 data-pinned="1"</span></div><table class="ack-table"><thead><tr><th>时间</th><th>回执人</th><th>项目</th><th>消息</th><th>备注</th></tr></thead><tbody>${RCPT.pins.map((p) => ackRowHtml(p.row, { pinRole: p.key })).join('')}</tbody></table></div>`
    : '';
  const ackGroupText = (name, g) => `${name}（${g.total} 条${g.truncated ? `，已显示 ${g.shown}` : ''}）`;
  const ackGroupSpan = (key, name, g) => `<span data-ack-group-text="${key}" data-ack-group-name="${esc(name)}" data-ack-group-n="${g.total}" data-ack-group-shown="${g.shown}">${esc(ackGroupText(name, g))}</span>`;
  const ackGroupsBar = RCPT.total
    ? `<div class="ack-groups-bar">${ackGroupSpan('today', '今天', RCPT.today)}<button type="button" class="ack-earlier-toggle" data-ack-earlier aria-expanded="false" aria-label="展开更早的回执">${ackGroupSpan('earlier', '更早', RCPT.earlier)} ▾</button></div>`
    : '';
  const ackTableHtml = RCPT.total
    ? `<table class="ack-table"><thead><tr><th>时间</th><th>回执人</th><th>项目</th><th>消息</th><th>备注</th></tr></thead>
<tbody data-ack-group="today" data-ack-group-total="${RCPT.today.total}" data-ack-group-shown="${RCPT.today.shown}">${RCPT.today.rows.map((row) => ackRowHtml(row, { pinned: RCPT.pinned.has(row.id) })).join('')}</tbody>
<tbody data-ack-group="earlier" data-ack-group-total="${RCPT.earlier.total}" data-ack-group-shown="${RCPT.earlier.shown}" hidden>${RCPT.earlier.rows.map((row) => ackRowHtml(row, { pinned: RCPT.pinned.has(row.id) })).join('')}</tbody></table>`
    : '<div class="empty" data-ack-empty>暂无回执</div>';
  // 每组渲染上限 200：超出时给「共 N 条，已显示 200」（不引入分页/虚拟滚动）。
  const ackMoreHtml = !RCPT.total ? ''
    : `${RCPT.today.truncated ? `<div class="ack-more" data-ack-more="today">今天共 ${RCPT.today.total} 条，已显示 ${RCPT.today.shown}</div>` : ''}`
      + `${RCPT.earlier.truncated ? `<div class="ack-more" data-ack-more="earlier" data-ack-truncated="1" hidden>更早共 ${RCPT.earlier.total} 条，已显示 ${RCPT.earlier.shown}</div>` : ''}`;
  const ackHtml = `<div class="ack-chips" data-ack-chips>${ackChipHtml}</div>${ackPinsHtml}${ackGroupsBar}${ackTableHtml}${ackMoreHtml}`;
  const fileRows = d.files.slice(0, 400).map((f) => `<tr><td><button class="file-link" data-file="${esc(f.abs)}" title="${titleAttr(f.abs)}">${esc(f.target)}</button></td><td>${f.size} B</td><td class="mono">${esc(shortHash(f.hash || '', 12))}</td><td>${esc(owner(f.owner))}</td></tr>`).join('');
  const memRows = d.members.map((m) => {
    // R-c651 F-c651-3：3 次重试仍唤醒失败 → 该角色红点（tooltip 带消息 id 与原因）；下次唤醒成功由工具清掉。
    const wf = d.wakeFailed && d.wakeFailed[m.role];
    const dot = wf
      ? `<span class="wake-failed-dot" data-wake-failed="${esc(m.role)}" title="${titleAttr(`唤醒失败 ${wf.attempt || ''} 次 ｜ 消息 ${wf.messageId || '无'} ｜ 原因 ${wf.why || '未知'} ｜ ${wf.at || ''}`)}">●</span> `
      : '';
    return `<tr${wf ? ' class="wake-failed"' : ''} data-role="${esc(m.role)}" data-wake-failed="${wf ? '1' : '0'}"><td>${dot}<b>${esc(role(m.role))}</b><br><span class="sub" title="${titleAttr(m.name)}">${esc(m.name)}</span></td><td class="mono">${esc(sid(m.session))}</td><td>${m.sent}</td><td>${m.reviews}</td><td>${m.signs}</td><td>${m.commits}</td><td>${m.acks}</td></tr>`;
  }).join('');
  const logRows = d.logs.slice(0, 60).map((l) => `<tr><td class="muted">${esc(time(l.ts))}</td><td>${esc(role(l.actor))}</td><td>${esc(l.kind)}</td><td title="${titleAttr(l.text)}">${esc(clip(l.text, 120))}</td></tr>`).join('');
  const checks = [
    ['提交闭环', `${d.commits.length} 次提交`, d.commits.length > 0],
    ['回执', `${d.receipts.length} 条回执`, d.receipts.length > 0],
    ['提案', `${d.proposals.length} 个提案`, d.proposals.length > 0],
    ['文件索引', `${d.files.length} 个项目文件`, d.files.length > 0],
    ['成员', `${d.members.length} 名成员`, d.members.length > 0],
    ['成员日志', `${d.logs.length} 条一句话日志`, d.logs.length > 0],
    ...(d.questions && d.questions.total
      ? [['问询', `未答 ${d.questions.open} 条（超时已升级 ${d.questions.escalated} 条）`, d.questions.open === 0]]
      : []),
  ].map(([label, detail, ok]) => `<li class="${ok ? 'ok' : 'bad'}">${ok ? '✅' : '❌'} ${esc(label)}：${esc(detail)}</li>`).join('');
  const projectOpts = (d.projects || []).map((p) => `<option value="${esc(p.name)}" ${p.selected ? 'selected' : ''}>${esc(p.name)}${p.current ? '（当前）' : ''}</option>`).join('');
  const summary = [
    ['commits', d.commits.length, '次提交闭环'],
    ['receipts', d.receipts.length, '条回执'],
    ['proposals', d.proposals.length, '个提案'],
    ['files', d.files.length, '个项目文件'],
    ['members', d.members.length, '名成员'],
    ['logs', d.logs.length, '条成员日志'],
  ].map(([view, n, label]) => `<button class="summary-btn" data-view="${view}"><b>${esc(n)}</b><span>${esc(label)}</span></button>`).join('');
  // R-9db6 F-9db6-1 / F-9db6-5：右下角 Owner 决策箱（只读）。未读 = status=open 且没有 readAt 的条数。
  const db = (d.decisionBox && typeof d.decisionBox === 'object') ? d.decisionBox : {};
  const dbItems = Array.isArray(db.items) ? db.items.filter((x) => x && x.id) : [];
  const dbOpenRows = dbItems.filter((x) => String(x.status || 'open') === 'open');
  const dbOtherRows = dbItems.filter((x) => String(x.status || 'open') !== 'open');
  const dbUnread = Number(db.unread || 0) || 0;
  const dbState = db.corrupt ? 'degraded' : (dbOpenRows.length ? 'ready' : 'empty');
  const dbRowHtml = (x, done) => {
    const st = String(x.status || 'open');
    const srcRef = String((x.source && x.source.ref) || '');
    const srcKind = String((x.source && x.source.kind) || 'none');
    const srcAbs = String((x.source && x.source.abs) || '');
    const src = srcRef
      ? `<button type="button" class="dbox-src" data-source-open="${esc(srcRef)}" data-source-kind="${esc(srcKind)}" data-source-abs="${esc(srcAbs)}">看来源</button>`
      : '<span class="muted">未记来源</span>';
    const badge = done
      ? `<span class="dbox-badge" data-unread="0">${esc(st === 'archived' ? '已归档' : '已回执')}</span>`
      : `<span class="dbox-badge" data-unread="${x.readAt ? '0' : '1'}">${x.readAt ? '已读' : '未读'}</span>`;
    // AC4（T-d2ee）：待决条目给候选按钮 + 意见框 + 单条【回执 PM】；已回执条目只展示结果，不再可点。
    const choices = (Array.isArray(x.options) && x.options.length ? x.options : dboxDefaultChoices())
      .map((o) => `<button type="button" class="dbox-opt" data-decision-opt="${esc(o)}">${esc(o)}</button>`).join('');
    const decided = x.decision && x.decision.choice
      ? `<div class="dbox-line dbox-decided">已回执：${esc(x.decision.choice)}${x.decision.opinion ? ' ｜ 意见：' + esc(x.decision.opinion) : ''}${x.decision.at ? ' ｜ ' + esc(time(x.decision.at)) : ''}</div>`
      : '';
    const answerBlock = done ? decided : `<div class="dbox-choices" data-decision-choices>${choices}</div>
      <div class="dbox-reply">
        <input class="dbox-opinion" data-decision-opinion maxlength="200" placeholder="意见（≤200 字；选“打回”必填）">
        <button type="button" class="dbox-submit" data-decision-submit disabled>回执 PM</button>
      </div>`;
    const pick = done ? '' : `<label class="dbox-pick" title="勾选后可批量回执"><input type="checkbox" data-decision-pick>批量</label>`;
    return `<div class="dbox-item" data-decision-id="${esc(x.id)}" data-status="${esc(st)}">
      <div class="dbox-item-head">${pick}<b>${esc(x.title || x.id)}</b><code>${esc(x.id)}</code>${badge}</div>
      <div class="dbox-line">${esc(x.summary || '（没写摘要）')}</div>
      <div class="dbox-line q">要决定什么：${esc(x.question || '（没写待决事项）')}</div>
      ${answerBlock}
      <div class="dbox-actions">${src}<span class="muted">放入于 ${esc(time(x.createdAt) || '未记')}</span></div>
      <div class="dbox-error" data-decision-error hidden></div>
    </div>`;
  };
  const dbBody = db.corrupt
    ? `<div class="dbox-empty" data-open-error="DECISION_BOX_CORRUPT">决策箱文件读不出来：${esc(db.error || '格式损坏')}（原文件保留，见团队台告警）</div>`
    : (dbOpenRows.length
      ? dbOpenRows.map((x) => dbRowHtml(x, false)).join('')
        + (dbOtherRows.length ? `<div class="dbox-empty">— 已回执 ${dbOtherRows.length} 条（灰显，不再出现在待决列表） —</div>` + dbOtherRows.map((x) => dbRowHtml(x, true)).join('') : '')
      : '<div class="dbox-empty">暂无待决事项</div>');
  // Owner 2026-11-14 13:15 定：决策箱**不做在团队看板页**，主入口改到主界面右下角【团队看板】按钮正上方的浮层。
  // 这里不再渲染（数据仍随 看板.json 带出，供壳层浮层与测试复用）；board 侧取数/渲染代码暂留，清理另立单。
  const dbHtml = '';
  const json = JSON.stringify(d).replace(/</g, '\\u003c');

  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>团队看板 · ${esc(d.project?.name || '')}</title>
<style>
:root{--bg:#0b0c10;--panel:#17181e;--panel2:#1d1e25;--line:rgba(232,211,177,.14);--line2:rgba(232,211,177,.27);--text:#ece5d8;--strong:#fff9ee;--muted:#a99e8d;--muted2:#81776b;--gold:#dcb56f;--gold2:#f4d39a;--ok:#70d7b5;--bad:#ee8d7f;--warn:#e8bb70}
*{box-sizing:border-box}html,body{min-height:100%}body{margin:0;background:radial-gradient(900px 500px at 8% -10%,rgba(220,181,111,.10),transparent 65%),radial-gradient(700px 420px at 100% 0%,rgba(112,215,181,.045),transparent 62%),#0b0c10;color:var(--text);font:13px/1.65 "Segoe UI","Microsoft YaHei",sans-serif;padding-top:42px}
::selection{background:rgba(220,181,111,.3);color:var(--strong)}
::-webkit-scrollbar{width:9px;height:9px}::-webkit-scrollbar-thumb{background:rgba(220,198,162,.2);border-radius:8px;border:2px solid transparent;background-clip:content-box}
.board-chrome{position:fixed;left:0;right:0;top:0;height:38px;z-index:1000;display:flex;align-items:center;justify-content:space-between;padding:0 8px 0 14px;background:rgba(16,17,22,.94);border-bottom:1px solid var(--line);backdrop-filter:blur(16px);-webkit-app-region:drag}
.board-drag{display:flex;gap:12px;align-items:center;font-size:12px}.board-drag b{letter-spacing:.4px}.board-drag span{color:var(--muted2);font-size:10.5px}
.board-actions{display:flex;gap:4px;-webkit-app-region:no-drag}.board-actions button{width:28px;height:25px;border:1px solid var(--line);border-radius:6px;background:#17181e;color:var(--text);cursor:pointer;font:13px/1 sans-serif}.board-actions button:hover{background:rgba(220,181,111,.14);border-color:var(--gold);color:var(--gold2)}
body.collapsed .board-content{display:none}
header{display:flex;justify-content:space-between;align-items:flex-end;gap:20px;flex-wrap:wrap;padding:24px 28px 18px}
h1{margin:0;font-size:23px;letter-spacing:.2px;color:var(--strong)}h2{font-size:15px;margin:0 0 12px;color:var(--strong)}
.muted{color:var(--muted)}.sub{color:var(--muted)}.mono{font-family:Consolas,"Cascadia Code",monospace;font-size:11.5px;color:var(--muted)}
.eyebrow{font-size:10px;letter-spacing:2px;color:var(--gold);font-weight:700;margin-bottom:5px}.meta{color:var(--muted2);font-size:11px;margin-top:6px}
select{height:32px;min-width:190px;border:1px solid var(--line2);border-radius:8px;background:#17181e;color:var(--strong);padding:0 10px;outline:none;cursor:pointer}select:focus{border-color:var(--gold);box-shadow:0 0 0 3px rgba(220,181,111,.12)}
.header-side{display:flex;flex-direction:column;align-items:flex-end;gap:7px}.header-hint{font-size:10.5px;color:var(--muted2)}
.cards{display:grid;grid-template-columns:repeat(auto-fit,minmax(145px,1fr));gap:10px;padding:0 28px 18px}
.card{text-align:left;background:linear-gradient(160deg,rgba(255,248,235,.045),rgba(255,248,235,.012));border:1px solid var(--line);border-radius:12px;padding:13px 15px;color:var(--text);cursor:pointer;transition:transform .16s,border-color .16s,background .16s}
.card:hover{transform:translateY(-2px);border-color:var(--line2);background:rgba(220,181,111,.08)}.card span{display:block;color:var(--muted);font-size:11px}.card b{display:block;color:var(--gold2);font-size:28px;line-height:1.25;margin-top:2px;font-variant-numeric:tabular-nums}
section{margin:0 28px 18px;background:linear-gradient(180deg,rgba(29,30,37,.97),rgba(20,21,27,.98));border:1px solid var(--line);border-radius:14px;padding:16px 18px;overflow:auto;box-shadow:0 8px 24px rgba(0,0,0,.18)}
.section-head{display:flex;justify-content:space-between;align-items:baseline;gap:12px;margin-bottom:10px}.section-head h2{margin:0}.section-head span{font-size:10.5px;color:var(--muted2)}
table{width:100%;border-collapse:collapse;font-size:12px}th,td{text-align:left;padding:8px 9px;border-bottom:1px solid var(--line);vertical-align:top}th{color:var(--muted2);font-weight:650;white-space:nowrap;position:sticky;top:0;background:#1b1c23;z-index:1}tr:hover td{background:rgba(220,181,111,.045)}td{max-width:420px}
.pill{display:inline-block;padding:1px 8px;border-radius:999px;font-size:11px;font-weight:700}.p-P0{background:#4a1717;color:#ffb4b4}.p-P1{background:#4a3a12;color:#ffd48a}.p-P2{background:#12332f;color:#9fe4d1}.p-P3{background:#24252d;color:#b8c6dc}
.tag{display:inline-block;padding:1px 7px;border-radius:6px;font-size:10.5px;margin:1px;white-space:nowrap}.tag.ok{background:rgba(112,215,181,.13);color:#8be5c7;border:1px solid rgba(112,215,181,.25)}.tag.bad{background:rgba(238,141,127,.12);color:#ffa89d;border:1px solid rgba(238,141,127,.25)}
.file-link{border:0;background:transparent;color:var(--gold2);font:inherit;text-align:left;padding:0;cursor:pointer;border-bottom:1px dotted rgba(220,181,111,.4)}.file-link:hover{color:#fff;border-bottom-color:var(--gold)}
.wake-failed-dot{color:var(--bad);font-size:12px;margin-right:4px;text-shadow:0 0 6px rgba(238,141,127,.5)}tr.wake-failed td{background:rgba(238,141,127,.07)}
/* R-45d3 回执区：角色 chip / 保底区 / 今天·更早 */
.ack-chips{display:flex;flex-wrap:wrap;gap:6px;margin:0 0 10px}
.ack-chips .chip,.ack-groups-bar button{border:1px solid var(--line2);background:transparent;color:var(--gold2);border-radius:999px;padding:2px 10px;font-size:11px;cursor:pointer}
.ack-chips .chip{color:var(--text);font-size:11.5px}
.ack-chips .chip:hover,.ack-groups-bar button:hover{background:rgba(220,181,111,.12)}
.ack-chips .chip[aria-pressed="true"]{background:rgba(220,181,111,.26);border-color:var(--gold);color:var(--strong);font-weight:700}
.ack-pins{margin:0 0 10px;padding:8px 10px;border:1px solid var(--line);border-radius:10px;background:rgba(220,181,111,.05)}
.ack-pins-head,.ack-groups-bar{display:flex;gap:10px;align-items:center;flex-wrap:wrap;font-size:11px;color:var(--muted2);margin:0 0 6px}
.ack-more{font-size:11px;color:var(--warn);margin:6px 0 0}
tbody[hidden],tr[hidden]{display:none}
.summary-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(140px,1fr));gap:9px}.summary-btn{text-align:left;border:1px solid var(--line);border-radius:10px;background:rgba(255,248,235,.025);color:var(--text);padding:10px 12px;cursor:pointer}.summary-btn:hover{background:rgba(220,181,111,.10);border-color:var(--line2)}.summary-btn b{display:block;color:var(--gold2);font-size:20px}.summary-btn span{font-size:10.5px;color:var(--muted)}
#pilot-list{list-style:none;margin:10px 0 0;padding:0}#pilot-list li{padding:4px 0;color:var(--muted)}#pilot-list li.ok{color:#a9e8d4}#pilot-list li.bad{color:#ffb1a8}
footer{padding:0 28px 24px;color:var(--muted2);font-size:10.5px}
.drawer-mask{position:fixed;inset:0;z-index:5000;background:rgba(4,5,8,.72);backdrop-filter:blur(10px);display:none}.drawer-mask.open{display:block}
.drawer{position:absolute;right:0;top:0;bottom:0;width:min(820px,94vw);background:linear-gradient(180deg,#1e1f27,#101116);border-left:1px solid var(--line2);box-shadow:-24px 0 70px rgba(0,0,0,.6);display:flex;flex-direction:column}
.drawer-head{display:flex;align-items:center;gap:10px;padding:16px 20px;border-bottom:1px solid var(--line)}.drawer-head h3{margin:0;flex:1;font-size:16px;color:var(--strong)}.drawer-close{width:30px;height:30px;border:1px solid var(--line);border-radius:8px;background:transparent;color:var(--muted);cursor:pointer;font-size:18px}.drawer-close:hover{background:rgba(220,181,111,.12);color:var(--gold2)}
.drawer-body{flex:1;overflow:auto;padding:16px 20px 30px}.drawer-body pre{margin:0;white-space:pre-wrap;word-break:break-word;font:12px/1.75 Consolas,"Microsoft YaHei",monospace;color:var(--text);background:rgba(0,0,0,.18);border:1px solid var(--line);border-radius:9px;padding:14px}
.empty{padding:12px;color:var(--muted2)}.close-note{font-size:10.5px;color:var(--muted2);margin-top:8px}
@media(max-width:720px){header{padding:16px}.cards,section{margin-left:12px;margin-right:12px;padding-left:12px;padding-right:12px}.cards{padding:0 12px 14px}header{padding:18px 12px}.header-side{align-items:flex-start}td{max-width:220px}}
/* 暖白：与工作台 html[data-theme="light"] 同步；看板在 iframe/独立窗口里也要变白。 */
html[data-theme="light"]{--bg:#f6f1e7;--panel:#fffaf1;--panel2:#f3ece0;--line:rgba(90,72,48,.16);--line2:rgba(90,72,48,.30);--text:#2c261e;--strong:#1d1812;--muted:#6b5f50;--muted2:#8a7c69;--gold:#8e6328;--gold2:#7a4f16;--ok:#1f7a5c;--bad:#b3402f;--warn:#8a5a13}
html[data-theme="light"] body{background:radial-gradient(900px 500px at 8% -10%,rgba(142,99,40,.08),transparent 65%),radial-gradient(700px 420px at 100% 0%,rgba(31,122,92,.04),transparent 62%),#f6f1e7}
html[data-theme="light"] .board-chrome{background:rgba(255,250,241,.94)}
html[data-theme="light"] .board-actions button,html[data-theme="light"] select{background:#fffaf1}
html[data-theme="light"] section{background:linear-gradient(180deg,#fffaf1,#fbf4e8);box-shadow:0 8px 24px rgba(90,72,48,.10)}
html[data-theme="light"] th{background:#f3ece0}
html[data-theme="light"] .drawer{background:linear-gradient(180deg,#fffaf1,#f6efe3);box-shadow:-24px 0 70px rgba(60,45,28,.25)}
html[data-theme="light"] .drawer-body pre{background:rgba(90,72,48,.06)}
html[data-theme="light"] .p-P0{background:#f7d9d4;color:#8f2318}
html[data-theme="light"] .p-P1{background:#f7e8c6;color:#7a4f16}
html[data-theme="light"] .p-P2{background:#d8efe6;color:#145c46}
html[data-theme="light"] .p-P3{background:#e6e9f0;color:#3d4a63}
html[data-theme="light"] .tag.ok{background:rgba(31,122,92,.10);color:#16624a;border-color:rgba(31,122,92,.28)}
html[data-theme="light"] .tag.bad{background:rgba(179,64,47,.10);color:#8f2318;border-color:rgba(179,64,47,.28)}
html[data-theme="light"] .file-link:hover{color:#1d1812}
html[data-theme="light"] .drawer-mask{background:rgba(40,32,22,.40)}
/* R-9db6 F-9db6-1：Owner 决策箱固定在看板右下角，不挤占正文版面；未读数与空态见 #decision-box[data-unread]。 */
#decision-box{position:fixed;right:14px;bottom:14px;z-index:900;width:min(360px,44vw);max-height:min(52vh,420px);display:flex;flex-direction:column;background:linear-gradient(180deg,rgba(30,31,39,.98),rgba(16,17,22,.99));border:1px solid var(--line2);border-radius:13px;box-shadow:0 14px 40px rgba(0,0,0,.5);overflow:hidden;font-size:12px}
.decision-box-head{display:flex;align-items:center;gap:8px;padding:9px 12px;border-bottom:1px solid var(--line);background:rgba(220,181,111,.07)}
.decision-box-head h2{margin:0;font-size:13px;color:var(--strong);flex:1}
.dbox-badge{display:inline-block;padding:1px 8px;border-radius:999px;font-size:10.5px;font-weight:700;background:rgba(220,181,111,.16);color:var(--gold2);border:1px solid rgba(220,181,111,.3);white-space:nowrap}
.dbox-badge[data-unread="0"]{background:rgba(255,248,235,.06);color:var(--muted);border-color:var(--line)}
.decision-box-body{flex:1 1 auto;min-height:0;overflow:auto}
.dbox-empty{padding:16px 14px;color:var(--muted2);text-align:center}
.dbox-item{padding:9px 12px;border-bottom:1px solid rgba(232,211,177,.08)}
.dbox-item:last-child{border-bottom:0}
.dbox-item[data-status="answered"],.dbox-item[data-status="archived"]{opacity:.55}
.dbox-item-head{display:flex;align-items:baseline;gap:6px;flex-wrap:wrap}
.dbox-item-head b{color:var(--strong);font-size:12.5px}
.dbox-item-head code{color:var(--gold);font-size:10.5px}
.dbox-line{color:var(--muted);margin-top:3px;line-height:1.55}
.dbox-line.q{color:var(--text)}
.dbox-actions{display:flex;align-items:center;gap:8px;margin-top:5px;flex-wrap:wrap}
.dbox-src{border:1px solid var(--line2);background:transparent;color:var(--gold2);border-radius:6px;padding:1px 7px;font-size:10.5px;cursor:pointer}
.dbox-src:hover{background:rgba(220,181,111,.14)}
#source-viewer{margin:6px 12px 10px;border:1px solid var(--line);border-radius:8px;padding:8px;max-height:200px;overflow:auto}
#source-viewer[hidden]{display:none}
#source-viewer pre{margin:6px 0 0;max-height:150px;overflow:auto;white-space:pre-wrap;word-break:break-word;font:11px/1.6 Consolas,"Microsoft YaHei",monospace;background:rgba(0,0,0,.2);border-radius:6px;padding:8px}
.dbox-open-error{color:var(--bad);margin-top:4px;font-size:11px}
/* T-d2ee / R-9db6 AC4：回执 PM 的候选按钮、意见框、批量条 */
.dbox-choices{display:flex;flex-wrap:wrap;gap:5px;margin-top:6px}
.dbox-opt{border:1px solid var(--line2);background:transparent;color:var(--text);border-radius:6px;padding:2px 9px;font-size:10.5px;cursor:pointer}
.dbox-opt:hover{background:rgba(220,181,111,.12)}
.dbox-opt.selected{background:rgba(220,181,111,.26);border-color:var(--gold);color:var(--strong);font-weight:700}
.dbox-opt.selected::before{content:"✓ ";color:var(--gold2)}
.dbox-reply{display:flex;gap:6px;margin-top:6px;align-items:center}
.dbox-opinion{flex:1;min-width:0;height:24px;border:1px solid var(--line2);border-radius:6px;background:transparent;color:var(--text);font:11px/1.4 inherit;padding:0 7px}
.dbox-submit{border:1px solid var(--line2);background:rgba(220,181,111,.16);color:var(--gold2);border-radius:6px;padding:2px 10px;font-size:10.5px;cursor:pointer;white-space:nowrap}
.dbox-submit:disabled{opacity:.45;cursor:not-allowed}
.dbox-pick{display:inline-flex;align-items:center;gap:3px;color:var(--muted);font-size:10px;margin-right:4px;cursor:pointer}
.dbox-decided{color:var(--gold2)}
.dbox-error{margin-top:4px;color:var(--bad);font-size:10.5px;line-height:1.5}
.dbox-error[hidden]{display:none}
.dbox-item[data-status="answered"] .dbox-choices,.dbox-item[data-status="archived"] .dbox-choices{display:none}
.decision-batch{display:flex;align-items:center;gap:8px;justify-content:space-between;padding:7px 12px;border-top:1px solid var(--line);background:rgba(220,181,111,.08);font-size:10.5px;color:var(--text)}
.decision-batch[hidden]{display:none}
.decision-error{padding:7px 12px;border-top:1px solid var(--line);color:var(--bad);font-size:10.5px;line-height:1.55}
.decision-error[hidden]{display:none}
html[data-theme="light"] .dbox-opt.selected{background:rgba(142,99,40,.20);border-color:#8e6328;color:#4a3208}
html[data-theme="light"] .dbox-opt.selected::before{color:#7a4f16}
html[data-theme="light"] .decision-batch{background:rgba(142,99,40,.10)}
html[data-theme="light"] #decision-box{background:linear-gradient(180deg,#fffaf1,#fbf4e8);box-shadow:0 14px 40px rgba(90,72,48,.22)}
html[data-theme="light"] .decision-box-head{background:rgba(142,99,40,.08)}
html[data-theme="light"] .dbox-src{color:#7a4f16}
html[data-theme="light"] .dbox-badge{color:#7a4f16;border-color:rgba(142,99,40,.35);background:rgba(142,99,40,.10)}
html[data-theme="light"] #source-viewer pre{background:rgba(90,72,48,.06)}
@media(max-width:720px){#decision-box{width:calc(100vw - 24px);max-height:46vh}}
</style></head><body>
<script>
(() => {
  try {
    const q = new URLSearchParams(location.search);
    const wanted = q.get('theme') || localStorage.getItem('awb.boardTheme') || 'dark';
    if (wanted === 'light') document.documentElement.dataset.theme = 'light';
    if (q.get('theme')) localStorage.setItem('awb.boardTheme', q.get('theme'));
  } catch { /* ignore */ }
})();
</script>
<div class="board-chrome"><div class="board-drag"><b>团队看板</b><span>可拖动 / 缩放 / 半透明悬浮</span></div><div class="board-actions"><button data-win="collapse" title="收纳成标题条">—</button><button data-win="zoom-out" title="缩小">－</button><button data-win="zoom-in" title="放大">＋</button><button data-win="maximize" title="最大化/还原">⛶</button><button data-win="close" title="关闭">×</button></div></div>
<div class="board-content">
<header><div><div class="eyebrow">团队运营 / 团队总览</div><h1>团队看板 · ${esc(d.project?.name || '未选项目')}</h1><div class="meta">阶段 ${esc(phase(d.team.phase))} ｜ 负责人 ${esc(d.team.owner)} ｜ 生成 ${esc(time(d.generatedAt))}</div></div><div class="header-side"><select id="project-select" title="切换项目">${projectOpts}</select><div class="header-hint">切换项目不会改变工作台当前项目</div></div></header>
<div class="cards">${[
    ['requirements', '需求', d.requirements.length],
    ['tasks', '进行中任务', d.childTasks.filter((t) => t.status !== 'done').length],
    ['proposals', '提案', d.proposals.length],
    ['receipts', '回执', d.receipts.length],
    ['files', '项目文件', d.files.length],
    ['members', '成员', d.members.length],
  ].map(([view, label, n]) => `<button class="card" data-view="${view}"><span>${label}</span><b>${n}</b></button>`).join('')}</div>
<section><div class="section-head"><h2>一、需求看板</h2><span>点击卡片查看完整明细</span></div>${rowsHtml(['优先级', '需求', '状态', '负责人', '子任务', '验收标准'], (d.requirements || []).map((r) => `<tr><td><span class="pill p-${esc(r.priority)}">${esc(r.priority)}</span></td><td><b>${esc(r.id)}</b><br><span class="sub" title="${titleAttr(r.title)}">${esc(clip(r.title, 60))}</span></td><td>${esc(status(r.derivedStatus || r.status))}${esc(proxyTag(r))}</td><td>${esc(owner(r.owner))}</td><td>${r.kidsDone ?? 0}/${r.kidsTotal ?? 0}</td><td title="${titleAttr(r.acceptance)}">${esc(clip(r.acceptance, 90))}</td></tr>`), '暂无需求')}</section>
<section><div class="section-head"><h2>二、进行中任务</h2><span>状态/负责人/需求均可在这里核对</span></div>${rowsHtml(['优先级', '任务', '状态', '负责人', '需求'], (d.childTasks || []).filter((t) => t.status !== 'done').map((t) => `<tr><td><span class="pill p-${esc(t.priority)}">${esc(t.priority)}</span></td><td><b>${esc(t.id)}</b> <span class="sub" title="${titleAttr(t.title)}">${esc(clip(t.title, 70))}</span></td><td>${esc(status(t.status))}</td><td>${esc(owner(t.owner))}</td><td>${esc(t.requirementId || '—')}</td></tr>`), '无进行中任务')}</section>
<section><div class="section-head"><h2>三、提案 · 评审 · 签字</h2><span>评审/签字统一显示中文</span></div>${rowsHtml(['提案', '风险', '状态', '作者', '评审', '签字', '提交'], (d.proposals || []).map((p) => {
    const rv = Object.entries(d.reviews[p.id] || {}).map(([r, v]) => `<span class="tag ${v.verdict === 'approve' ? 'ok' : 'bad'}">${esc(role(r))}：${esc(verdict(v.verdict))}</span>`).join(' ') || '<span class="muted">—</span>';
    const sg = Object.entries(d.signatures[p.id] || {}).map(([r, v]) => `<span class="tag ${v.decision === 'approve' ? 'ok' : 'bad'}">${esc(role(r))}：${esc(decision(v.decision))}</span>`).join(' ') || '<span class="muted">—</span>';
    return `<tr><td><b>${esc(p.id)}</b><br><span class="sub" title="${titleAttr(p.title)}">${esc(clip(p.title, 48))}</span></td><td>${esc(risk(p.risk))}</td><td>${esc(status(p.status))}</td><td>${esc(role(p.author))}</td><td>${rv}</td><td>${sg}</td><td>${esc(p.commitId || '—')}</td></tr>`;
  }), '暂无提案')}</section>
<section data-ack-root data-ack-filter="all"><div class="section-head"><h2>四、回执（按角色筛选 · 今天/更早）</h2><span>点角色筛选；「更早」默认收起；鼠标悬停看完整备注</span></div>${ackHtml}</section>
<section><div class="section-head"><h2>五、项目文件</h2><span>点击文件名在弹窗预览，可关闭返回</span></div>${rowsHtml(['文件', '大小', '哈希', '归属'], (d.files || []).map((f) => `<tr><td><button class="file-link" data-file="${esc(f.abs)}" title="${titleAttr(f.abs)}">${esc(f.target)}</button></td><td>${f.size} B</td><td class="mono">${esc(shortHash(f.hash || '', 12))}</td><td>${esc(owner(f.owner))}</td></tr>`), '暂无索引')}</section>
<section><div class="section-head"><h2>六、成员</h2><span>角色 / 会话 / 贡献计数</span></div>${rowsHtml(['角色', '会话', '发消息', '评审', '签字', '提交', '回执'], (d.members || []).map((m) => {
    // R-c651 F-c651-3：3 次重试仍唤醒失败 → 该角色红点（tooltip 带消息 id 与原因）；唤醒成功后由工具清掉。
    const wf = d.wakeFailed && d.wakeFailed[m.role];
    const dot = wf
      ? `<span class="wake-failed-dot" data-wake-failed="${esc(m.role)}" title="${titleAttr(`唤醒失败 ${wf.attempt || '?'} 次 ｜ 消息 ${wf.messageId || '无'} ｜ 原因 ${wf.why || '未知'} ｜ ${wf.at || ''}`)}">●</span> `
      : '';
    return `<tr${wf ? ' class="wake-failed"' : ''} data-role="${esc(m.role)}" data-wake-failed="${wf ? '1' : '0'}"><td>${dot}<b>${esc(role(m.role))}</b><br><span class="sub" title="${titleAttr(m.name)}">${esc(m.name)}</span></td><td class="mono">${esc(sid(m.session))}</td><td>${m.sent}</td><td>${m.reviews}</td><td>${m.signs}</td><td>${m.commits}</td><td>${m.acks}</td></tr>`;
  }), '暂无成员')}</section>
<section><div class="section-head"><h2>七、质量汇总</h2><span>点击“次提交闭环”查看是哪几次</span></div><div class="summary-grid">${summary}</div><ul id="pilot-list">${checks}</ul></section>
<section><div class="section-head"><h2>八、成员日志（一句话）</h2><span>每次提交/回执由成员写一句；点击查看全部</span></div>${rowsHtml(['时间', '成员', '动作', '日志'], (d.logs || []).slice(0, 60).map((l) => `<tr><td class="muted">${esc(time(l.ts))}</td><td>${esc(role(l.actor))}</td><td>${esc(l.kind)}</td><td title="${titleAttr(l.text)}">${esc(clip(l.text, 120))}</td></tr>`), '暂无日志')}</section>
<footer>数据源：团队\\状态\\看板.json ｜ 重新生成：node 团队\\工具\\team.mjs board ｜ 看板 v2</footer>
</div>
${dbHtml}
<div id="drawer-mask" class="drawer-mask"><div class="drawer" role="dialog" aria-modal="true"><div class="drawer-head"><h3 id="drawer-title">明细</h3><button class="drawer-close" id="drawer-close" title="关闭">×</button></div><div class="drawer-body" id="drawer-body"></div></div></div>
<script id="team-data" type="application/json">${json}</script>
<script>
(() => {
  const D = JSON.parse(document.getElementById('team-data').textContent);
  const E = (s) => String(s == null ? '' : s).replace(/[&<>"']/g, (c) => ({'&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;',"'":'&#39;'}[c]));
  const R = {pm:'项目经理',product:'产品设计师',analyst:'需求分析师',programmer1:'程序员 A',programmer2:'程序员 B',tester:'测试人员',owner:'老板'};
  const S = {open:'待领取',working:'进行中',done:'已完成',proposed:'待评审',reviewing:'评审中',signing:'待签字',approved:'已批准',applied:'已提交',rejected:'已拒绝',stale:'已过期',blocked:'阻塞',active:'活跃'};
  const K = {normal:'普通',sensitive:'敏感',critical:'严重'}, V = {approve:'通过',reject:'驳回'}, G = {approve:'批准',reject:'拒绝'};
  const rl = (v) => R[v] || v || '—', st = (v) => S[v] || v || '—', rk = (v) => K[v] || v || '—', vd = (v) => V[v] || v || '—', dg = (v) => G[v] || v || '—';
  const t = (v) => String(v || '').slice(0,19).replace('T',' ');
  const sid = (v) => v ? '当前工作区' : '—';
  const mask = document.getElementById('drawer-mask'), body = document.getElementById('drawer-body'), title = document.getElementById('drawer-title');
  function open(titleText, html) { title.textContent = titleText; body.innerHTML = html; mask.classList.add('open'); }
  function close() { mask.classList.remove('open'); body.innerHTML = ''; }
  document.getElementById('drawer-close').onclick = close;
  mask.addEventListener('click', (e) => { if (e.target === mask) close(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape') close(); });
  function table(headers, rows, empty) {
    return '<table><thead><tr>' + headers.map((h) => '<th>' + E(h) + '</th>').join('') + '</tr></thead><tbody>' + (rows.length ? rows.join('') : '<tr><td colspan="' + headers.length + '" class="muted">' + E(empty || '暂无') + '</td></tr>') + '</tbody></table>';
  }
  function view(kind) {
    if (kind === 'requirements') return open('需求明细', table(['优先级','需求','状态','负责人','子任务','验收标准'], (D.requirements || []).map((r) => '<tr><td>' + E(r.priority) + '</td><td><b>' + E(r.id) + '</b><br>' + E(r.title) + '</td><td>' + E(st(r.derivedStatus || r.status)) + E(proxyTag(r)) + '</td><td>' + E(rl(r.owner)) + '</td><td>' + (r.kidsDone ?? 0) + '/' + (r.kidsTotal ?? 0) + '</td><td>' + E(r.acceptance || '—') + '</td></tr>'), '暂无需求'));
    if (kind === 'tasks') return open('任务明细', table(['优先级','任务','状态','负责人','需求'], (D.childTasks || []).map((x) => '<tr><td>' + E(x.priority) + '</td><td><b>' + E(x.id) + '</b> ' + E(x.title) + '</td><td>' + E(st(x.status)) + (x.claimStalled ? ' <span class="tag bad" title="派单超过 30 分钟未认领，已升级">未认领·已升级</span>' : (x.claimOverdue ? ' <span class="tag bad" title="派单超过 10 分钟未认领">未认领·超时</span>' : '')) + '</td><td>' + E(rl(x.owner)) + '</td><td>' + E(x.requirementId || '—') + '</td></tr>'), '暂无任务'));
    if (kind === 'proposals') return open('提案明细', table(['提案','风险','状态','作者','评审','签字','提交'], (D.proposals || []).map((p) => {
      const rv = Object.entries(D.reviews[p.id] || {}).map(([r,v]) => rl(r) + '：' + vd(v.verdict)).join('；') || '—';
      const sg = Object.entries(D.signatures[p.id] || {}).map(([r,v]) => rl(r) + '：' + dg(v.decision)).join('；') || '—';
      return '<tr><td><b>' + E(p.id) + '</b><br>' + E(p.title) + '</td><td>' + E(rk(p.risk)) + '</td><td>' + E(st(p.status)) + '</td><td>' + E(rl(p.author)) + '</td><td>' + E(rv) + '</td><td>' + E(sg) + '</td><td>' + E(p.commitId || '—') + '</td></tr>';
    }), '暂无提案'));
    if (kind === 'receipts') return open('回执明细', table(['时间','回执人','项目','消息','备注'], (D.receipts || []).map((r) => '<tr><td>' + E(t(r.ts)) + '</td><td>' + E(rl(r.from)) + '</td><td>' + E(r.project || '—') + '</td><td>' + E(r.msgId) + '</td><td>' + E(r.log || r.note || '—') + '</td></tr>'), '暂无回执'));
    if (kind === 'files') return open('项目文件', table(['文件','大小','哈希','归属'], (D.files || []).map((f) => '<tr><td><button class="file-link" data-file="' + E(f.abs) + '">' + E(f.target) + '</button></td><td>' + f.size + ' B</td><td class="mono">' + E(f.hash || '') + '</td><td>' + E(rl(f.owner)) + '</td></tr>'), '暂无文件'));
    if (kind === 'members') return open('成员', table(['角色','名称','会话','发消息','评审','签字','提交','回执'], (D.members || []).map((m) => '<tr><td><b>' + E(rl(m.role)) + '</b></td><td>' + E(m.name) + '</td><td class="mono">' + E(sid(m.session)) + '</td><td>' + m.sent + '</td><td>' + m.reviews + '</td><td>' + m.signs + '</td><td>' + m.commits + '</td><td>' + m.acks + '</td></tr>'), '暂无成员'));
    if (kind === 'commits') return open('提交闭环明细', table(['提交','时间','提案','提交人','文件','日志'], (D.commits || []).map((c) => '<tr><td><b>' + E(c.id) + '</b></td><td>' + E(t(c.createdAt)) + '</td><td>' + E(c.proposalId || '—') + '</td><td>' + E(rl(c.appliedBy || c.author)) + '</td><td>' + E((c.after || []).map((x) => x.target).join(', ')) + '</td><td>' + E(c.log || '—') + '</td></tr>'), '暂无提交'));
    if (kind === 'pilot') return open('质量门槛明细', '<ul id="pilot-list">' + (D.pilot?.checks || []).map((c) => '<li class="' + (c.ok ? 'ok' : 'bad') + '">' + (c.ok ? '✅' : '❌') + ' ' + E(c.label) + '：' + E(c.detail) + '</li>').join('') + '</ul>');
    if (kind === 'logs') return open('成员日志', table(['时间','成员','动作','日志'], (D.logs || []).map((l) => '<tr><td>' + E(t(l.ts)) + '</td><td>' + E(rl(l.actor)) + '</td><td>' + E(l.kind) + '</td><td>' + E(l.text) + '</td></tr>'), '暂无日志'));
  }
  document.querySelectorAll('[data-view]').forEach((b) => b.addEventListener('click', () => view(b.dataset.view)));
  async function previewFile(p) {
    if (!window.boardWin || !window.boardWin.openFile) return open('文件', '<div class="empty">当前窗口不支持预览</div>');
    const r = await window.boardWin.openFile(p);
    if (!r || !r.ok) return open('文件 · ' + p.split(/[\\\\/]/).pop(), '<div class="empty">' + E((r && r.why) || '读不了') + '</div>');
    if (r.kind === 'image') return open('文件 · ' + p.split(/[\\\\/]/).pop(), '<img style="max-width:100%;border-radius:8px" src="' + r.dataUrl + '">');
    if (r.kind === 'external') return open('文件 · ' + p.split(/[\\\\/]/).pop(), '<div class="empty">已用系统程序打开</div>');
    return open('文件 · ' + p.split(/[\\\\/]/).pop(), '<pre>' + E(r.text || '') + '</pre><div class="close-note">只读预览；按 Esc 或右上角关闭返回。</div>');
  }
  // 事件委托：文件表格和“项目文件”抽屉里动态生成的文件按钮都能点。
  document.addEventListener('click', async (e) => {
    const b = e.target && e.target.closest ? e.target.closest('.file-link') : null;
    if (!b) return;
    e.preventDefault(); e.stopPropagation();
    await previewFile(b.dataset.file);
  });
  const sel = document.getElementById('project-select');
  if (sel) sel.addEventListener('change', async () => {
    if (!window.boardWin || !window.boardWin.selectProject) return;
    sel.disabled = true;
    try { await window.boardWin.selectProject(sel.value); } finally { sel.disabled = false; }
  });
  const collapse = document.querySelector('[data-win="collapse"]');
  if (collapse) collapse.addEventListener('click', async () => {
    const c = document.body.classList.toggle('collapsed'); collapse.textContent = c ? '＋' : '—';
    if (window.boardWin) await window.boardWin.control(c ? 'collapse' : 'expand');
  });
  for (const b of document.querySelectorAll('[data-win]:not([data-win="collapse"])')) b.addEventListener('click', () => {
    const a = b.dataset.win; if (window.boardWin) window.boardWin.control(a); else if (a === 'close') window.close();
  });
  // R-9db6 F-9db6-5：决策箱「看来源」——打开到 #source-viewer，打不开时必须留 data-open-error，不许静默。
  function openSourceError(viewer, ref, code, why) {
    viewer.dataset.openError = code;
    viewer.innerHTML = '<div class="dbox-line">来源：' + E(ref) + '</div>'
      + '<div class="dbox-open-error" data-open-error="' + E(code) + '">' + E(why || '打不开') + '</div>';
  }
  document.addEventListener('click', async (e) => {
    const b = e.target && e.target.closest ? e.target.closest('[data-source-open]') : null;
    const viewer = document.getElementById('source-viewer');
    if (!b || !viewer) return;
    e.preventDefault(); e.stopPropagation();
    const ref = b.getAttribute('data-source-open') || '';
    const kind = b.getAttribute('data-source-kind') || 'none';
    const abs = b.getAttribute('data-source-abs') || '';
    viewer.hidden = false;
    viewer.dataset.viewerKind = kind;
    viewer.dataset.viewerRef = ref;
    delete viewer.dataset.openError;
    viewer.innerHTML = '<div class="dbox-line">来源（' + E(kind) + '）：' + E(ref || '未记录') + '</div><div class="dbox-line">读取中…</div>';
    if (!ref) return openSourceError(viewer, ref, 'SOURCE_EMPTY', '这条没有记来源');
    if (kind === 'message') return openSourceError(viewer, ref, 'BOARD_NO_MESSAGE_CHANNEL', '看板窗口读不到消息正文；请回工作台团队台按这条消息 id 查看：' + ref);
    if (!abs) return openSourceError(viewer, ref, 'SOURCE_NOT_FOUND', '来源文件不存在，或不在本项目目录内：' + ref);
    if (!window.boardWin || !window.boardWin.openFile) return openSourceError(viewer, ref, 'BOARD_BRIDGE_MISSING', '当前窗口不支持预览：' + abs);
    const r = await window.boardWin.openFile(abs);
    if (!r || !r.ok) return openSourceError(viewer, ref, String((r && r.code) || 'OPEN_FAILED'), String((r && r.why) || '读不了') + '：' + abs);
    if (r.kind === 'image') { viewer.innerHTML = '<div class="dbox-line">来源（' + E(kind) + '）：' + E(ref) + '</div><img style="max-width:100%;border-radius:8px" src="' + r.dataUrl + '">'; return; }
    viewer.innerHTML = '<div class="dbox-line">来源（' + E(kind) + '）：' + E(ref) + '</div><pre>' + E(r.text || '') + '</pre>';
  });
  // ===== T-d2ee / R-9db6 AC4：决策箱「回执 PM」（单条 + 勾选批量）=====
  // 后端通道名由生成时注入；与后端 IPC 约定 receipt{messageId,at,choice,opinion}。
  const DB = { bridge: '${esc(DECISION_RECEIPT_BRIDGE)}' };
  const dboxBox = () => document.getElementById('decision-box');
  const dboxItemOf = (el) => (el && el.closest ? el.closest('.dbox-item') : null);
  const dboxOpenItems = () => Array.from(document.querySelectorAll('#decision-box .dbox-item[data-status="open"]'));
  function dboxSetError(el, text) {
    if (!el) return;
    el.textContent = text || '';
    if (text) el.removeAttribute('hidden'); else el.setAttribute('hidden', '');
  }
  function dboxGlobalError(text) {
    const box = document.getElementById('decision-error');
    if (!box) return;
    box.textContent = text || '';
    if (text) box.removeAttribute('hidden'); else box.setAttribute('hidden', '');
  }
  function dboxPayload(item) {
    const id = item.getAttribute('data-decision-id') || '';
    const chip = item.querySelector('.dbox-opt.selected');
    const opinionEl = item.querySelector('[data-decision-opinion]');
    return { id, choice: chip ? chip.getAttribute('data-decision-opt') : '', opinion: opinionEl ? String(opinionEl.value || '').trim() : '' };
  }
  function dboxWhy(p) {
    if (!p.choice) return '先点一个候选（通过 / 打回 / 其他）';
    if (p.choice.indexOf('打回') >= 0 && !p.opinion) return '选「打回」必须写一句意见';
    if (p.opinion.length > 200) return '意见最多 200 字';
    return '';
  }
  async function dboxSend(p) {
    const bridge = window.boardWin || {};
    const fn = bridge[DB.bridge];
    if (typeof fn !== 'function') {
      return { ok: false, code: 'BOARD_RECEIPT_BRIDGE_MISSING', message: '看板窗口还没接上后端回执通道（等后端 IPC 上线），这条没有提交，仍是待决' };
    }
    try {
      const out = await fn({ id: p.id, receipt: { messageId: null, at: new Date().toISOString(), choice: p.choice, opinion: p.opinion } });
      if (!out || out.ok === false) {
        return { ok: false, code: (out && out.code) || 'RECEIPT_FAILED', message: (out && (out.message || out.why)) || '后端没有确认这次回执' };
      }
      return { ok: true, messageId: (out && out.messageId) || '' };
    } catch (e) {
      return { ok: false, code: 'BOARD_RECEIPT_FAILED', message: String((e && e.message) || e) };
    }
  }
  function dboxDecUnread() {
    const box = dboxBox();
    if (!box) return;
    const n = Math.max(0, Number(box.getAttribute('data-unread') || 0) - 1);
    box.setAttribute('data-unread', String(n));
    box.setAttribute('data-open', String(dboxOpenItems().length));
    const badge = document.getElementById('decision-box-unread');
    if (badge) { badge.setAttribute('data-unread', String(n)); badge.textContent = '待决 ' + n; }
  }
  function dboxMarkAnswered(item, p, out) {
    item.setAttribute('data-status', 'answered');
    const badge = item.querySelector('.dbox-badge');
    if (badge) { badge.setAttribute('data-unread', '0'); badge.textContent = '已回执'; }
    const choices = item.querySelector('[data-decision-choices]');
    const reply = item.querySelector('.dbox-reply');
    const pick = item.querySelector('.dbox-pick');
    const cb = item.querySelector('[data-decision-pick]');
    if (cb) cb.checked = false;
    if (choices) choices.remove();
    if (reply) reply.remove();
    if (pick) pick.remove();
    const line = document.createElement('div');
    line.className = 'dbox-line dbox-decided';
    line.setAttribute('data-decision-result', p.id);
    line.textContent = '已回执：' + p.choice + (p.opinion ? ' ｜ 意见：' + p.opinion : '') + (out && out.messageId ? ' ｜ 回执消息 ' + out.messageId : '');
    item.appendChild(line);
    dboxSetError(item.querySelector('[data-decision-error]'), '');
    dboxDecUnread();
  }
  function dboxUpdateBatch() {
    const bar = document.getElementById('decision-batch');
    const cnt = document.getElementById('decision-batch-count');
    const btn = document.getElementById('decision-batch-submit');
    if (!bar || !cnt || !btn) return;
    const picks = Array.from(document.querySelectorAll('#decision-box [data-decision-pick]:checked'));
    bar.setAttribute('data-count', String(picks.length));
    cnt.textContent = String(picks.length);
    cnt.setAttribute('data-batch-count', String(picks.length));
    btn.textContent = '回执 PM（' + picks.length + ' 条）';
    btn.disabled = picks.length === 0;
    if (picks.length) bar.removeAttribute('hidden'); else bar.setAttribute('hidden', '');
  }
  async function dboxSubmitOne(item) {
    const errEl = item.querySelector('[data-decision-error]');
    const p = dboxPayload(item);
    const why = dboxWhy(p);
    if (why) { dboxSetError(errEl, why); return false; }
    const btn = item.querySelector('[data-decision-submit]');
    if (btn) { btn.disabled = true; btn.textContent = '提交中…'; }
    const out = await dboxSend(p);
    if (!out.ok) {
      if (btn) { btn.disabled = false; btn.textContent = '回执 PM'; }
      dboxSetError(errEl, '没提交成功：' + (out.message || out.code) + '（' + out.code + '）');
      return false;
    }
    dboxMarkAnswered(item, p, out);
    dboxUpdateBatch();
    return true;
  }
  async function dboxSubmitBatch() {
    const picks = Array.from(document.querySelectorAll('#decision-box [data-decision-pick]:checked'));
    if (!picks.length) { dboxGlobalError('先在条目上勾选要一起回执的条数'); return; }
    let okCount = 0;
    const failed = [];
    for (const cb of picks) {
      const item = dboxItemOf(cb);
      if (!item) continue;
      const p = dboxPayload(item);
      const why = dboxWhy(p);
      if (why) { dboxSetError(item.querySelector('[data-decision-error]'), why); failed.push(p.id + '：' + why); continue; }
      const out = await dboxSend(p);
      if (!out.ok) {
        dboxSetError(item.querySelector('[data-decision-error]'), '没提交成功：' + (out.message || out.code));
        failed.push(p.id + '：' + (out.message || out.code));
        continue;
      }
      dboxMarkAnswered(item, p, out);
      okCount += 1;
    }
    dboxUpdateBatch();
    dboxGlobalError(failed.length
      ? ('批量回执：成功 ' + okCount + ' 条，失败 ' + failed.length + ' 条 —— ' + failed.join('；'))
      : '');
  }
  document.addEventListener('click', async (e) => {
    const target = e.target;
    if (!target || !target.closest) return;
    const opt = target.closest('.dbox-opt');
    if (opt) {
      const item = dboxItemOf(opt);
      const group = item ? item.querySelector('[data-decision-choices]') : null;
      if (group) group.querySelectorAll('.dbox-opt').forEach((b) => b.classList.remove('selected'));
      opt.classList.add('selected');
      const submit = item ? item.querySelector('[data-decision-submit]') : null;
      if (submit) submit.disabled = false;
      dboxSetError(item ? item.querySelector('[data-decision-error]') : null, '');
      return;
    }
    const one = target.closest('[data-decision-submit]');
    if (one) {
      e.preventDefault(); e.stopPropagation();
      const item = dboxItemOf(one);
      if (item) await dboxSubmitOne(item);
      return;
    }
    const batch = target.closest('[data-decision-batch]');
    if (batch) {
      e.preventDefault(); e.stopPropagation();
      await dboxSubmitBatch();
    }
  });
  document.addEventListener('change', (e) => {
    if (e.target && e.target.matches && e.target.matches('[data-decision-pick]')) dboxUpdateBatch();
  });
  // ===== R-45d3：回执区「按角色筛选」+「更早」折叠（drawer / data-view 明细入口不动）=====
  const ackRoot = document.querySelector('[data-ack-root]');
  if (ackRoot) {
    const ackChipBtns = Array.from(ackRoot.querySelectorAll('[data-ack-chips] [data-ack-role]'));
    const ackGroupBodies = Array.from(ackRoot.querySelectorAll('tbody[data-ack-group]'));
    const ackListRows = Array.from(ackRoot.querySelectorAll('[data-ack-pins] tr[data-ack-role]'))
      .concat(Array.from(ackRoot.querySelectorAll('tbody[data-ack-group] tr[data-ack-role]')));
    function ackSyncGroupLabels(filter) {
      for (const tb of ackGroupBodies) {
        const key = tb.getAttribute('data-ack-group');
        const span = ackRoot.querySelector('[data-ack-group-text="' + key + '"]');
        if (!span) continue;
        const name = span.getAttribute('data-ack-group-name') || key;
        const total = Number(span.getAttribute('data-ack-group-n') || 0);
        const shown = Number(span.getAttribute('data-ack-group-shown') || 0);
        const hit = Array.from(tb.querySelectorAll('tr[data-ack-role]'))
          .filter((tr) => filter === 'all' || tr.getAttribute('data-ack-role') === filter).length;
        const capped = filter === 'all' && total > shown;
        span.textContent = name + '（' + (filter === 'all' ? total : hit) + ' 条' + (capped ? '，已显示 ' + shown : '') + '）';
      }
    }
    function ackSyncMore() {
      const tf = ackRoot.getAttribute('data-ack-filter') || 'all';
      const eb = ackRoot.querySelector('tbody[data-ack-group="earlier"]');
      const eo = !!eb && !eb.hasAttribute('hidden');
      for (const box of ackRoot.querySelectorAll('[data-ack-more]')) {
        const show = tf === 'all' && (box.getAttribute('data-ack-more') === 'today' || eo);
        if (show) box.removeAttribute('hidden'); else box.setAttribute('hidden', '');
      }
    }
    function ackApply(filter) {
      ackRoot.setAttribute('data-ack-filter', filter);
      for (const b of ackChipBtns) b.setAttribute('aria-pressed', b.getAttribute('data-ack-role') === filter ? 'true' : 'false');
      for (const tr of ackListRows) tr.hidden = !(filter === 'all' || tr.getAttribute('data-ack-role') === filter);
      ackSyncGroupLabels(filter);
      ackSyncMore();
    }
    for (const b of ackChipBtns) {
      b.addEventListener('click', () => {
        const want = b.getAttribute('data-ack-role') || 'all';
        ackApply((ackRoot.getAttribute('data-ack-filter') || 'all') === want ? 'all' : want);
      });
    }
    const ackEarlierBtn = ackRoot.querySelector('[data-ack-earlier]');
    if (ackEarlierBtn) {
      ackEarlierBtn.addEventListener('click', () => {
        const tb = ackRoot.querySelector('tbody[data-ack-group="earlier"]');
        if (!tb) return;
        const open = tb.hasAttribute('hidden');
        if (open) tb.removeAttribute('hidden'); else tb.setAttribute('hidden', '');
        ackSyncMore();
        ackEarlierBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      });
    }
    ackApply(ackRoot.getAttribute('data-ack-filter') || 'all');
  }
})();
</script>
</body></html>`;
}
