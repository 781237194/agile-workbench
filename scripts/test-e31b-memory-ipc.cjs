'use strict';
/**
 * R-20261121-204514-e31b（T-20261121-204606-af31）夹具：
 * ① tasks-summary 7 字段/分页/单条体积 ② messages:page 分页/不含 body/越尾空页 ③ files:list 单层/truncated/越界零读取
 * ④ 改造前后单次返回字节对比（任务摘要 vs 全量任务；消息首页 vs 全量消息；单层 vs 递归树）
 * 纯 Node、不启动 Electron、不写真实状态；临时沙盘退出自动清理（AWB_KEEP_SANDBOX=1 保留）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const Paging = require('../src/render-data-paging.js');

const ROOT = path.resolve(__dirname, '..');
const SANDBOX_BASE = String.fromCharCode(68) + ':\\awb-sandbox';
const SANDBOX = fs.mkdtempSync(path.join(fs.existsSync(SANDBOX_BASE) ? SANDBOX_BASE : os.tmpdir(), 'e31b-ipc-'));
let passed = 0;
let failed = 0;
const rows = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; rows.push(`PASS  ${name}`); }
  else { failed += 1; rows.push(`FAIL  ${name}${detail ? ' — ' + detail : ''}`); }
}

function cleanup() {
  if (process.env.AWB_KEEP_SANDBOX === '1') { console.log('沙盘保留：' + SANDBOX); return; }
  try { fs.rmSync(SANDBOX, { recursive: true, force: true }); } catch { /* ignore */ }
}
process.on('exit', cleanup);

function makeTasks(n) {
  const tasks = [];
  for (let i = 0; i < n; i += 1) {
    tasks.push({
      id: 'T-' + String(i).padStart(6, '0'),
      title: '任务 ' + i,
      status: i % 3 === 0 ? 'open' : (i % 3 === 1 ? 'working' : 'done'),
      owner: i % 4 === 0 ? 'programmer1' : 'tester',
      priority: i % 5 === 0 ? 'P0' : 'P2',
      updatedAt: new Date(1760000000000 + i * 1000).toISOString(),
      role: 'programmer1',
      requirementId: 'R-20261121-000000-aaaa',
      detail: 'x'.repeat(900),
      acceptance: 'y'.repeat(700),
      story: 'z'.repeat(500),
      history: Array.from({ length: 5 }, () => ({ at: new Date().toISOString(), note: 'n'.repeat(80) })),
      workflow: { stage: 'dev', extra: 'w'.repeat(300) }
    });
  }
  return tasks;
}
function makeMessages(n) {
  const msgs = [];
  for (let i = 0; i < n; i += 1) {
    msgs.push({
      id: 'M-' + String(i).padStart(6, '0'),
      from: i % 2 ? 'pm' : 'programmer1',
      to: 'pm',
      subject: '主题 ' + i,
      body: 'b'.repeat(800),
      at: new Date(1760000000000 + i * 1000).toISOString(),
      read: i % 3 === 0,
      task: i % 5 === 0 ? 'T-' + i : ''
    });
  }
  return msgs;
}

// ---------- ① tasks-summary ----------
const tasks = makeTasks(1369);
const fullTaskBytes = Paging.jsonBytes(tasks);
const summary = Paging.buildTasksSummary(tasks, { limit: 200, offset: 0 });
check('tasks① 每条仅 7 字段（含 requirementId）且无 detail/acceptance/story', summary.items.every((row) => {
  const keys = Object.keys(row).sort();
  return keys.length === 7
    && !('detail' in row) && !('acceptance' in row) && !('story' in row)
    && keys.join(',') === ['id', 'owner', 'priority', 'requirementId', 'status', 'title', 'updatedAt'].sort().join(',');
}), JSON.stringify(summary.items[0] && Object.keys(summary.items[0])));
check('tasks① 单条序列化 ≤1KB', summary.items.every((row) => Paging.jsonBytes(row) <= 1024), 'max=' + Math.max(...summary.items.map((r) => Paging.jsonBytes(r))));
check('tasks② 分页 total/shown/offset 正确', summary.total === 1369 && summary.shown === 200 && summary.offset === 0, JSON.stringify({ total: summary.total, shown: summary.shown }));
const filtered = Paging.buildTasksSummary(tasks, { status: 'open', owner: 'programmer1', limit: 50 });
check('tasks② status/owner 过滤后 total 正确', filtered.total === 115, 'total=' + filtered.total);
const emptyTasks = Paging.buildTasksSummary([], {});
check('tasks③ 空列表 items=[] total=0', emptyTasks.items.length === 0 && emptyTasks.total === 0 && emptyTasks.shown === 0);
const badLimit = Paging.buildTasksSummary(tasks, { limit: 0 });
check('tasks③ limit 非法回落 500 并标 badArg', badLimit.limit === 500 && badLimit.badArg === true && badLimit.items.length === 500, JSON.stringify({ limit: badLimit.limit, bad: badLimit.badArg }));

// ---------- ② messages:page ----------
const messages = makeMessages(5594);
const fullMsgBytes = Paging.jsonBytes(messages);
const page1 = Paging.buildLocalMessagesPage(messages, { limit: 50, offset: 0 });
check('msg① limit=50 → 50 条且 total 真值', page1.items.length === 50 && page1.total === 5594, JSON.stringify({ len: page1.items.length, total: page1.total }));
check('msg① items 不含 body 且只含 7 字段', page1.items.every((row) => !('body' in row) && Object.keys(row).length === 7), JSON.stringify(Object.keys(page1.items[0] || {})));
const tail = Paging.buildLocalMessagesPage(messages, { limit: 50, offset: 5594 });
check('msg② offset=total → items=[] 且 total 仍真值', tail.items.length === 0 && tail.total === 5594, JSON.stringify({ len: tail.items.length, total: tail.total }));
const seen = new Set();
let dup = 0;
for (let p = 0; p < 5; p += 1) {
  for (const row of Paging.buildLocalMessagesPage(messages, { limit: 50, offset: p * 50 }).items) {
    if (seen.has(row.id)) dup += 1; else seen.add(row.id);
  }
}
check('msg③ 连翻 5 页无重复、无缺页（250 条）', seen.size === 250 && dup === 0, JSON.stringify({ size: seen.size, dup }));
const badMsgLimit = Paging.buildLocalMessagesPage(messages, { limit: 999 });
check('msg③ limit 非法回落 50 并标 badArg', badMsgLimit.limit === 50 && badMsgLimit.badArg === true, JSON.stringify({ limit: badMsgLimit.limit, bad: badMsgLimit.badArg }));

// ---------- ③ files:list ----------
const projectRoot = path.join(SANDBOX, '项目');
fs.mkdirSync(path.join(projectRoot, '需求'), { recursive: true });
fs.mkdirSync(path.join(projectRoot, 'src', 'renderer'), { recursive: true });
fs.mkdirSync(path.join(projectRoot, '.git'), { recursive: true });
fs.mkdirSync(path.join(projectRoot, 'node_modules', 'x'), { recursive: true });
for (let i = 0; i < 8; i += 1) fs.writeFileSync(path.join(projectRoot, 'doc-' + i + '.md'), 'x'.repeat(30));
fs.writeFileSync(path.join(projectRoot, '需求', 'R-1.md'), '需求');
fs.writeFileSync(path.join(projectRoot, 'src', 'renderer', 'app.js'), 'js');
for (let i = 0; i < 80; i += 1) fs.writeFileSync(path.join(projectRoot, 'src', 'renderer', 'part-' + i + '.js'), 'y'.repeat(200));
fs.writeFileSync(path.join(projectRoot, '.git', 'config'), 'secret');
fs.writeFileSync(path.join(projectRoot, 'node_modules', 'x', 'index.js'), 'nm');

const top = Paging.buildFilesPage({ root: projectRoot, dir: '', limit: 500 });
check('files① 顶层只列一层（含子目录、不含 .git/node_modules）', top.items.some((i) => i.name === '需求' && i.isDir)
  && top.items.some((i) => i.name === 'src' && i.isDir)
  && !top.items.some((i) => i.name === '.git' || i.name === 'node_modules')
  && !top.items.some((i) => i.name === 'app.js'), JSON.stringify(top.items.map((i) => i.name)));
const topLimited = Paging.buildFilesPage({ root: projectRoot, dir: '', limit: 2 });
check('files① limit 截断 → truncated=true 且 count 为真值', topLimited.items.length === 2 && topLimited.truncated === true && topLimited.count > 2, JSON.stringify({ len: topLimited.items.length, count: topLimited.count, truncated: topLimited.truncated }));
const sub = Paging.buildFilesPage({ root: projectRoot, dir: 'src' });
check('files② 展开子目录只取该层（app.js/renderer）', sub.dir === 'src' && sub.items.some((i) => i.name === 'renderer' && i.isDir), JSON.stringify(sub.items.map((i) => i.name)));
const parentAgain = Paging.buildFilesPage({ root: projectRoot, dir: '' });
check('files② 展开子目录后父层数据仍在（再查顶层同数量）', parentAgain.items.length === top.items.length, JSON.stringify({ before: top.items.length, after: parentAgain.items.length }));
let readdirCalls = 0;
const spyFs = { ...fs, readdirSync: (...a) => { readdirCalls += 1; return fs.readdirSync(...a); } };
let outsideCode = '';
try { Paging.buildFilesPage({ root: projectRoot, dir: '..', limit: 10 }, { fs: spyFs }); } catch (e) { outsideCode = e && e.code || ''; }
check('files③ 越界 dir:.. → FILES_DIR_OUTSIDE 且零读取', outsideCode === 'FILES_DIR_OUTSIDE' && readdirCalls === 0, JSON.stringify({ code: outsideCode, readdirCalls }));
let forbiddenCode = '';
try { Paging.buildFilesPage({ root: projectRoot, dir: 'src/../.git', limit: 10 }); } catch (e) { forbiddenCode = e && e.code || ''; }
check('files③ 禁止目录（任意段 .git）→ FILES_DIR_OUTSIDE', forbiddenCode === 'FILES_DIR_OUTSIDE', forbiddenCode);

// ---------- ④ 字节对比 ----------
const tasksAfterBytes = Paging.jsonBytes(summary.items);
const msgAfterBytes = Paging.jsonBytes(page1.items);
const topBytes = Paging.jsonBytes(top);
const rendererPage = Paging.buildFilesPage({ root: projectRoot, dir: 'src/renderer' });
const fullTreeBytes = Paging.jsonBytes([top, sub, rendererPage]);
check('字节① 任务摘要前 200 条 < 全量任务 30%', tasksAfterBytes < fullTaskBytes * 0.3, JSON.stringify({ before: fullTaskBytes, after: tasksAfterBytes, ratio: +(tasksAfterBytes / fullTaskBytes).toFixed(3) }));
check('字节② 消息首页 50 条 < 全量消息 5%', msgAfterBytes < fullMsgBytes * 0.05, JSON.stringify({ before: fullMsgBytes, after: msgAfterBytes, ratio: +(msgAfterBytes / fullMsgBytes).toFixed(3) }));
check('字节③ 单层目录 < 递归树 60%', topBytes < fullTreeBytes * 0.6, JSON.stringify({ before: fullTreeBytes, after: topBytes, ratio: +(topBytes / fullTreeBytes).toFixed(3) }));

// ---------- ⑤ app:state 真实 store 摘要口径（只读） ----------
const storeFile = path.join(ROOT, 'data', 'userdata', 'workbench.json');
if (fs.existsSync(storeFile)) {
  const store = JSON.parse(fs.readFileSync(storeFile, 'utf8'));
  const project = (store.projects || []).find((p) => p.id === store.activeProjectId) || (store.projects || [])[0];
  if (project) {
    const fullTasks = Array.isArray(project.tasks) ? project.tasks : [];
    const fullMessages = Array.isArray(project.messages) ? project.messages : [];
    const afterTasks = fullTasks.slice(0, 300).map(Paging.taskUiSummaryOf);
    const afterMessages = fullMessages.slice(-50);
    const beforeBytes = Paging.jsonBytes(fullTasks) + Paging.jsonBytes(fullMessages);
    const afterBytes = Paging.jsonBytes(afterTasks) + Paging.jsonBytes(afterMessages);
    check('真实 store app:state 载荷下降 ≥50%', fullTasks.length > 300 && afterBytes < beforeBytes * 0.5, JSON.stringify({
      tasks: fullTasks.length, messages: fullMessages.length, beforeBytes, afterBytes, ratio: +(afterBytes / beforeBytes).toFixed(3)
    }));
    rows.push(`INFO  app:state 改造前=${beforeBytes}B / 改造后=${afterBytes}B（tasks ${fullTasks.length}→${afterTasks.length}，messages ${fullMessages.length}→${afterMessages.length}）`);
  }
}

// ---------- ⑥ 接线静态断言 ----------
const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
const preloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
check('接线 main 注册 workflow:tasks-summary', mainSrc.includes("ipcMain.handle('workflow:tasks-summary'"));
check('接线 main 注册 messages:page 与 files:list 新形态', mainSrc.includes("ipcMain.handle('messages:page'") && mainSrc.includes('RenderDataPaging.buildFilesPage'));
check('接线 preload 暴露 tasksSummary/messagesPage/filesList', preloadSrc.includes('tasksSummary:') && preloadSrc.includes('messagesPage:') && preloadSrc.includes('filesList:'));
check('接线 app:state 任务只下发摘要', mainSrc.includes('taskUiSummaryOf') && mainSrc.includes('localTaskSummaries'));
check('接线 越界错误码 FILES_DIR_OUTSIDE 在纯逻辑里', fs.readFileSync(path.join(ROOT, 'src', 'render-data-paging.js'), 'utf8').includes("'FILES_DIR_OUTSIDE'"));

rows.forEach((line) => console.log(line));
console.log(`\n${failed ? 'FAILED' : 'PASS'}  ${passed} PASS / ${failed} FAIL`);
process.exit(failed ? 1 : 0);
