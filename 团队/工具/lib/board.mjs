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
// PM 代管标识（T-a01d / R-1cee）：需求行状态列后面追加【PM通过】/【PM打回】/【待 PM 评审】。
function proxyTag(row) { return row && row.ownerProxyLabel ? ' ' + row.ownerProxyLabel : ''; }

function rowsHtml(headers, rows, empty = '暂无') {
  return `<table><thead><tr>${headers.map((h) => `<th>${esc(h)}</th>`).join('')}</tr></thead><tbody>${rows.length ? rows.join('') : `<tr><td colspan="${headers.length}" class="muted">${esc(empty)}</td></tr>`}</tbody></table>`;
}
function tag(text, ok) { return `<span class="tag ${ok ? 'ok' : 'bad'}">${esc(text)}</span>`; }

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

export function renderBoardHtml(d) {
  const reqRows = d.requirements.map((r) => `<tr><td><span class="pill p-${esc(r.priority)}">${esc(r.priority)}</span></td><td><b>${esc(r.id)}</b><br><span class="sub" title="${titleAttr(r.title)}">${esc(clip(r.title, 60))}</span></td><td>${esc(status(r.derivedStatus || r.status))}${esc(proxyTag(r))}</td><td>${esc(owner(r.owner))}</td><td>${r.kidsDone ?? 0}/${r.kidsTotal ?? 0}</td><td class="muted" title="${titleAttr(r.acceptance)}">${esc(clip(r.acceptance, 90))}</td></tr>`).join('');
  const taskRows = d.childTasks.filter((t) => t.status !== 'done').map((t) => `<tr><td><span class="pill p-${esc(t.priority)}">${esc(t.priority)}</span></td><td><b>${esc(t.id)}</b> <span class="sub" title="${titleAttr(t.title)}">${esc(clip(t.title, 70))}</span></td><td>${esc(status(t.status))}</td><td>${esc(owner(t.owner))}</td><td>${esc(t.requirementId || '—')}</td></tr>`).join('');
  const propRows = d.proposals.slice().reverse().map((p) => {
    const rv = Object.entries(d.reviews[p.id] || {}).map(([r, v]) => `<span class="tag ${v.verdict === 'approve' ? 'ok' : 'bad'}">${esc(role(r))}：${esc(verdict(v.verdict))}</span>`).join(' ') || '<span class="muted">—</span>';
    const sg = Object.entries(d.signatures[p.id] || {}).map(([r, v]) => `<span class="tag ${v.decision === 'approve' ? 'ok' : 'bad'}">${esc(role(r))}：${esc(decision(v.decision))}</span>`).join(' ') || '<span class="muted">—</span>';
    return `<tr><td><b>${esc(p.id)}</b><br><span class="sub" title="${titleAttr(p.title)}">${esc(clip(p.title, 48))}</span></td><td>${esc(risk(p.risk))}</td><td>${esc(status(p.status))}</td><td>${esc(role(p.author))}</td><td>${rv}</td><td>${sg}</td><td>${esc(p.commitId || '—')}</td></tr>`;
  }).join('');
  const ackRows = d.receipts.slice(-50).reverse().map((r) => `<tr><td class="muted">${esc(time(r.ts))}</td><td>${esc(role(r.from))}</td><td>${esc(r.project || '—')}</td><td>${esc(r.msgId)}</td><td title="${titleAttr(r.log || r.note)}">${esc(clip(r.log || r.note, 100))}</td></tr>`).join('');
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
<section><div class="section-head"><h2>四、回执（最近 50 条）</h2><span>鼠标悬停查看完整备注</span></div>${rowsHtml(['时间', '回执人', '项目', '消息', '备注'], (d.receipts || []).slice(-50).reverse().map((r) => `<tr><td class="muted">${esc(time(r.ts))}</td><td>${esc(role(r.from))}</td><td>${esc(r.project || '—')}</td><td>${esc(r.msgId)}</td><td title="${titleAttr(r.log || r.note)}">${esc(clip(r.log || r.note, 100))}</td></tr>`), '暂无回执')}</section>
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
    if (kind === 'tasks') return open('任务明细', table(['优先级','任务','状态','负责人','需求'], (D.childTasks || []).map((x) => '<tr><td>' + E(x.priority) + '</td><td><b>' + E(x.id) + '</b> ' + E(x.title) + '</td><td>' + E(st(x.status)) + '</td><td>' + E(rl(x.owner)) + '</td><td>' + E(x.requirementId || '—') + '</td></tr>'), '暂无任务'));
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
})();
</script>
</body></html>`;
}
