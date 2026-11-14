// 角色产出播报（R-20261112-201100-1e5f）
//
// 只做“通知”：产出落盘后播一条，含 8 字段 + status；不进入消息未读计数，不改产出/回执/task done。
// 记录：团队/状态/项目/<项目>/播报/记录.jsonl（一行一条，append-only）。
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { projectStatePaths, loadProject, requireBoot } from './store.mjs';
import { ROLE_DIRS, ROLE_NAMES } from './roles.mjs';
import { nowIso, stamp, ensureDir, jsonOut, textOut, fail } from './core.mjs';

export const BROADCAST_TYPES = ['requirement', 'analysis', 'design', 'proposal', 'code', 'test', 'receipt', 'review', 'other'];
const SUMMARY_MAX = 200;
// 摘要脱敏（R-1e5f 复核 P2）：密钥/口令/隐私只允许记路径，不允许把值写进播报。
const SENSITIVE_RE = /((?:token|secret|password|passwd|api[_-]?key|access[_-]?key|authorization)\s*[:=]\s*)([^\s,;，；]+)/gi;

function redactSummary(text) {
  return String(text || '')
    .replace(SENSITIVE_RE, '$1***')
    .replace(/\b(bearer)\s+([A-Za-z0-9._~+/-]{8,})/gi, '$1 ***');
}

function broadcastDir(projectName) {
  return path.join(projectStatePaths(projectName).dir, '播报');
}

function recordFile(projectName) {
  return path.join(broadcastDir(projectName), '记录.jsonl');
}

function clipSummary(text, max = SUMMARY_MAX) {
  const s = redactSummary(text).replace(/\s+/g, ' ').trim();
  if (s.length <= max) return s;
  return s.slice(0, Math.max(0, max - 1)) + '…';
}

function readRecords(projectName) {
  const file = recordFile(projectName);
  if (!fs.existsSync(file)) return [];
  const out = [];
  for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
    if (!line.trim()) continue;
    try {
      const row = JSON.parse(line);
      if (row && row.id) out.push(row);
    } catch { /* 跳过损坏条目，不影响新播报 */ }
  }
  return out;
}

function appendRecord(projectName, record) {
  const dir = broadcastDir(projectName);
  ensureDir(dir);
  fs.appendFileSync(recordFile(projectName), JSON.stringify(record) + '\n', 'utf8');
  return record;
}

function roleDirOf(role) {
  return ROLE_DIRS[role] || role;
}

/** 播报：写一条记录（去重：同 task+path+sha256 只播一次；哈希变可再播）。
 * 安全：记录里绝不写启动令牌；actor 只记角色名。权限由调用方用 --boot 令牌校验（见 cmdBroadcast）。 */
export function broadcastEmit({ projectName, role, taskId, file, type = '', summary = '', failInject = false }) {
  const name = String(projectName || '');
  if (!name) fail('BAD_ARGS', '需要 --project');
  if (!role) fail('BAD_ARGS', '需要 --role');
  if (!String(taskId || '').trim()) fail('BAD_ARGS', '需要 --task');
  if (!file) fail('BAD_ARGS', '需要 --path');
  const project = loadProject(name);
  const abs = path.resolve(project.path, String(file));
  const rel = path.relative(project.path, abs).replace(/\\/g, '/');
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) {
    fail('PATH_OUTSIDE_PROJECT', `${file} 不在项目目录内`);
  }
  // 权限：只能播本角色目录下的产出（F-B7/AC25.7）
  const ownerDir = rel.split('/')[0];
  if (ownerDir !== roleDirOf(role)) {
    fail('NOT_OWNER', `角色 ${role} 只能播报 ${roleDirOf(role)}/ 下的产出（收到 ${rel}）`);
  }
  if (!fs.existsSync(abs)) fail('FILE_NOT_FOUND', `${rel} 不存在（只播已落盘产出）`);
  const buf = fs.readFileSync(abs);
  const hash = crypto.createHash('sha256').update(buf).digest('hex');
  const typeNorm = BROADCAST_TYPES.includes(String(type || '')) ? String(type) : 'other';
  const records = readRecords(name);
  // 去重只认“已成功”的记录：failed 记录不阻止同任务/同路径/同哈希重试（R-1e5f 复核 P1）。
  const dup = records.find((row) => String(row.status || 'ok') !== 'failed'
    && row.taskId === String(taskId) && row.path === rel && row.sha256 === hash);
  if (dup) return { ok: true, deduped: true, count: records.length, item: dup };

  const base = {
    id: `B-${stamp()}-${crypto.randomBytes(2).toString('hex')}`,
    role: String(role),
    taskId: String(taskId),
    type: typeNorm,
    summary: clipSummary(summary || `${ROLE_NAMES[role] || role} 产出 ${rel}`),
    path: rel,
    sha256: hash,
    at: nowIso(),
  };
  if (failInject || process.env.BROADCAST_FAIL === '1') {
    const failed = { ...base, status: 'failed', error: 'BROADCAST_INJECTED_FAILURE' };
    appendRecord(name, failed);
    return { ok: false, failed: true, item: failed, count: records.length + 1 };
  }
  const record = { ...base, status: 'ok' };
  appendRecord(name, record);
  return { ok: true, deduped: false, count: records.length + 1, item: record };
}

/** 查询：按任务/角色过滤；无记录返回空数组不报错。 */
export function broadcastList({ projectName, taskId = '', role = '' }) {
  const name = String(projectName || '');
  if (!name) fail('BAD_ARGS', '需要 --project');
  let items = readRecords(name);
  if (taskId) items = items.filter((row) => row.taskId === String(taskId));
  if (role) items = items.filter((row) => row.role === String(role));
  return { ok: true, project: name, items, count: items.length, file: recordFile(name) };
}

function esc(value) {
  return String(value ?? '').replace(/[&<>"']/g, (ch) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[ch]));
}

/** 播报面板 DOM（固定选择器：data-broadcast-item / -toggle / -count / -failed）。 */
export function renderBroadcastPanel(items) {
  const list = Array.isArray(items) ? items : [];
  const rows = list.slice(-80).reverse().map((it) => `<article class="bc-item${it.status === 'failed' ? ' bc-failed' : ''}" data-broadcast-item data-broadcast-id="${esc(it.id)}">
  <button class="bc-head" type="button" data-broadcast-toggle aria-expanded="false">
    <span class="bc-role">${esc(ROLE_NAMES[it.role] || it.role)}</span>
    <span class="bc-task">${esc(it.taskId)}</span>
    <span class="bc-type">${esc(it.type)}</span>
    <span class="bc-sum">${esc(it.summary)}</span>
    <span class="bc-at">${esc(String(it.at).replace('T', ' ').slice(0, 19))}</span>
    ${it.status === 'failed' ? '<span class="bc-badge" data-broadcast-failed>失败</span>' : ''}
  </button>
  <div class="bc-body" hidden>
    <p><b>完整摘要</b>：${esc(it.summary)}</p>
    <p><b>路径</b>：<code>${esc(it.path)}</code></p>
    <p><b>sha256</b>：<code>${esc(it.sha256)}</code></p>
    <p><b>时间</b>：${esc(it.at)} ｜ <b>状态</b>：${esc(it.status)}${it.error ? ' ｜ <b>错误</b>：' + esc(it.error) : ''}</p>
  </div>
</article>`).join('\n');
  return `<section class="broadcast-panel" data-broadcast-panel>
  <header class="bc-panel-head"><h3>角色产出播报</h3><span class="bc-count" data-broadcast-count>${list.length}</span><span class="bc-hint">只播本角色已落盘产出；同一产出同一哈希只播一次</span></header>
  <div class="bc-list">${rows || '<p class="bc-empty">还没有播报</p>'}</div>
</section>`;
}

export function renderBroadcastPage({ project, items }) {
  const panel = renderBroadcastPanel(items);
  return `<!doctype html><html lang="zh-CN"><head><meta charset="utf-8"><title>产出播报 · ${esc(project)}</title>
<style>
:root{--bg:#15171d;--panel:#1a1c23;--line:rgba(223,218,207,.14);--text:#efece5;--muted:#aaa8a2;--gold:#c9a365;--red:#e18b7b}
*{box-sizing:border-box}body{margin:0;padding:18px 22px;background:var(--bg);color:var(--text);font:13px/1.6 "Microsoft YaHei",sans-serif}
h3{margin:0;font-size:14px}.broadcast-panel{background:var(--panel);border:1px solid var(--line);border-radius:8px;padding:12px 14px}
.bc-panel-head{display:flex;align-items:center;gap:10px;margin-bottom:8px}.bc-count{color:var(--gold);font-weight:700}.bc-hint{color:var(--muted);font-size:10.5px;margin-left:auto}
.bc-item{border:1px solid var(--line);border-radius:6px;margin-bottom:6px;background:#1d1f27}.bc-item.bc-failed{border-color:var(--red)}
.bc-head{display:flex;align-items:center;gap:10px;width:100%;text-align:left;background:transparent;border:0;color:var(--text);padding:8px 10px;cursor:pointer;font:inherit}
.bc-role{color:var(--gold);font-weight:700}.bc-task{font-family:monospace;font-size:11px;color:var(--muted)}.bc-type{font-size:10.5px;border:1px solid var(--line);border-radius:999px;padding:0 7px;color:var(--muted)}
.bc-sum{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}.bc-at{font-size:10.5px;color:var(--muted)}.bc-badge{color:var(--red);font-size:10.5px}
.bc-body{padding:4px 12px 10px;color:var(--muted);font-size:12px;border-top:1px dashed var(--line)}.bc-body p{margin:4px 0}.bc-body code{color:var(--text);font-size:11px}
.bc-empty{color:var(--muted)}
</style></head><body>
${panel}
<script>
for (const btn of document.querySelectorAll('[data-broadcast-toggle]')) {
  btn.addEventListener('click', () => {
    const body = btn.parentElement.querySelector('.bc-body');
    const open = btn.getAttribute('aria-expanded') === 'true';
    btn.setAttribute('aria-expanded', String(!open));
    if (body) body.hidden = open;
  });
}
</script>
</body></html>`;
}

export function cmdBroadcast(args) {
  const action = String((args._ && args._[1]) || '').toLowerCase();
  const projectName = String(args.project || '');
  if (action === 'emit') {
    const role = String(args.role || '');
    const token = String(args.boot || '');
    // 安全：令牌只用于校验，绝不写进记录（此前把 --boot 原文写进 actor，属泄露）。
    if (!token || token === 'true') fail('UNAUTHENTICATED', '播报必须带 --boot <令牌>：令牌只用于校验归属，不写入记录');
    let boot = null;
    try { boot = requireBoot(token, { project: projectName }); } catch (error) { throw error; }
    if (!boot || String(boot.role || '') !== role) {
      fail('PERMISSION_DENIED', `令牌角色 ${(boot && boot.role) || '(未知)'} ≠ 声明角色 ${role}；不能播报他人产出`);
    }
    requireBoot(token, { role, project: projectName });
    const r = broadcastEmit({
      projectName,
      role,
      taskId: String(args.task || ''),
      file: String(args.path || ''),
      type: String(args.type || ''),
      summary: String(args.summary || ''),
      failInject: Boolean(args['fail-inject']),
    });
    if (args.json) jsonOut(r);
    else if (r.deduped) textOut(`已存在同哈希播报，跳过（count=${r.count}）`);
    else if (r.failed) textOut(`播报失败已记录（status=failed，不影响主流程）`);
    else textOut(`已播报 ${r.item.role} ${r.item.taskId} ${r.item.path}（count=${r.count}）`);
    return;
  }
  if (action === 'list' || !action) {
    const r = broadcastList({ projectName, taskId: String(args.task || ''), role: String(args.role || '') });
    if (args.json) { jsonOut(r); return; }
    const lines = [`产出播报 · ${projectName} ｜ ${r.count} 条`];
    for (const it of r.items.slice(-30).reverse()) lines.push(`- ${it.at} [${it.role}] ${it.taskId} ${it.type} ${it.status} — ${it.summary}（${it.path}）`);
    textOut(lines.join('\n'));
    return;
  }
  if (action === 'html') {
    const r = broadcastList({ projectName, taskId: String(args.task || ''), role: String(args.role || '') });
    const file = args.out ? path.resolve(String(args.out)) : path.join(broadcastDir(projectName), '播报.html');
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, renderBroadcastPage({ project: projectName, items: r.items }), 'utf8');
    if (args.json) jsonOut({ ok: true, file, count: r.count });
    else textOut(`已生成播报面板：${file}（${r.count} 条）`);
    return;
  }
  fail('BAD_SUBCOMMAND', 'broadcast 只支持 emit | list | html');
}
