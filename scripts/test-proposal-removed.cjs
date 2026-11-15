#!/usr/bin/env node
'use strict';

// R-3d9d（T-20261115-085543-9624）「取消提案功能」A 案断言脚本。
// 纯 Node、源码级 + JSON 清单对比：不改任何状态、不写 提案/、不调用 team.mjs。
// 覆盖：死代码 0 命中 / 只读通道保留 / 数据零删除 / 文案 4 处改名 / 审计与事件齐全。
// 失败退出 1，并把逐条结果写 项目/<项目>/程序员A/产出/证据-9624/proposal-removed-result.json。
// 路径全部由 __dirname 推导，不写死盘符或用户目录。

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROJECT_NAME = process.env.AWB_TEST_PROJECT || '工作台改造修复';
const PROJECT_DIR = path.join(ROOT, '项目', PROJECT_NAME);
const STATE_DIR = path.join(ROOT, '团队', '状态', '项目', PROJECT_NAME);
const PROPOSAL_DIR = path.join(STATE_DIR, '提案');
const EVID_DIR = path.join(PROJECT_DIR, '程序员A', '产出', '证据-9624');

const FILES = {
  app: path.join(ROOT, 'src', 'renderer', 'app.js'),
  main: path.join(ROOT, 'src', 'main.js'),
  preload: path.join(ROOT, 'src', 'preload.js'),
  index: path.join(ROOT, 'src', 'renderer', 'index.html'),
  css: path.join(ROOT, 'src', 'renderer', 'style.css'),
  teamTools: path.join(ROOT, 'src', 'team-tools.js'),
  before: path.join(EVID_DIR, 'proposal-files-before.json'),
  after: path.join(EVID_DIR, 'proposal-files-after.json'),
  audit: path.join(STATE_DIR, '提案清理.jsonl'),
  workflow: path.join(STATE_DIR, '工作流.json'),
  result: path.join(EVID_DIR, 'proposal-removed-result.json')
};

const checks = [];
function assert(cond, msg) {
  if (!cond) throw new Error(msg);
}
function check(name, fn) {
  try {
    const detail = fn();
    checks.push({ name, ok: true, detail: detail === undefined ? '' : String(detail) });
  } catch (e) {
    checks.push({ name, ok: false, detail: String((e && e.message) || e) });
  }
}

function readText(file) {
  return fs.readFileSync(file, 'utf8');
}
function lines(file) {
  return readText(file).split(/\r?\n/);
}
function sha256Text(text) {
  return crypto.createHash('sha256').update(text).digest('hex');
}
function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}
function walk(dir, ext, out) {
  const list = out || [];
  let entries;
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (e) {
    if (e && e.code === 'ENOENT') return list;
    throw e;
  }
  for (const ent of entries) {
    const abs = path.join(dir, ent.name);
    if (ent.isDirectory()) walk(abs, ext, list);
    else if (!ext || ext.has(path.extname(ent.name).toLowerCase())) list.push(abs);
  }
  return list;
}
function rel(abs) {
  return path.relative(ROOT, abs).split(path.sep).join('/');
}

// 清单口径与 manifest-proposal.cjs / 产品评审硬条件③一致：
// path 升序、每项 {path,size,sha256}、JSON.stringify（无空格、键序固定）后 sha256。
function proposalManifest() {
  const files = walk(PROPOSAL_DIR, null)
    .map((abs) => ({
      path: path.relative(PROPOSAL_DIR, abs).split(path.sep).join('/'),
      size: fs.statSync(abs).size,
      sha256: sha256File(abs)
    }))
    .sort((a, b) => (a.path < b.path ? -1 : (a.path > b.path ? 1 : 0)));
  return {
    count: files.length,
    totalBytes: files.reduce((sum, f) => sum + f.size, 0),
    manifestSha256: sha256Text(JSON.stringify(files)),
    files
  };
}

function loadManifest(file) {
  const raw = JSON.parse(readText(file));
  return raw && raw.manifest ? raw.manifest : raw;
}

// ── 断言 1：改动文件语法（node --check，与 npm run check 同口径）────────────────
check('A1 语法检查：app.js / main.js 通过 node --check', () => {
  const bad = [];
  for (const file of [FILES.app, FILES.main]) {
    const r = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    if (r.status !== 0) bad.push(`${rel(file)}: ${String(r.stderr || '').trim().slice(0, 300)}`);
  }
  assert(bad.length === 0, bad.join(' | '));
  return 'app.js + main.js OK';
});

// ── 断言 2：需求正文 F-3d9d-3 关键词在 src/renderer/** 0 命中 ─────────────────
const F3D9D_KEYWORDS = /renderProposals|proposals-list|proposal-protocol|proposal-summary|openProposalModal|showTab\('proposals'\)/;
check('A2 src/renderer/** 死代码关键词 0 命中（F-3d9d-3 清单）', () => {
  const renderer = path.join(ROOT, 'src', 'renderer');
  const hits = [];
  for (const abs of walk(renderer, new Set(['.js', '.html', '.css', '.json']))) {
    lines(abs).forEach((line, i) => {
      if (F3D9D_KEYWORDS.test(line)) hits.push(`${rel(abs)}:${i + 1} ${line.trim().slice(0, 160)}`);
    });
  }
  assert(hits.length === 0, `命中 ${hits.length} 处：${hits.join(' | ')}`);
  return '0 命中';
});

// ── 断言 3：A 案扩展关键词（提案页函数/变量/新提案/应用提案）0 命中 ────────────
// 标识符（函数/变量/入口）两个文件都必须 0；「应用提案/新提案」是 UI 按钮文案，只扫 app.js。
// main.js 的本地 proposal:apply 报文里保留「已应用提案」字样属 A 案协议面，不在 UI 断言范围。
const EXTRA_ID_KEYWORDS = /renderProposalProtocol|showProposal|legacyProposals|openReviewModal|openSignModal|refreshLegacyProposal|loadLegacyProposals|legacyProposalView|legacyProposalSteps|legacyProposalStageText|proposalLocalSteps|proposalIsLegacy|legacyProposalOrder|PROTOCOL_STEPS|data-open-proposal|btn-proposal-add/;
const EXTRA_UI_KEYWORDS = /应用提案|新提案|提案标题|提案理由/;
check('A3 app.js/main.js 提案页函数与入口标识 0 命中（UI 按钮文案只扫 app.js）', () => {
  const hits = [];
  for (const abs of [FILES.app, FILES.main]) {
    lines(abs).forEach((line, i) => {
      if (EXTRA_ID_KEYWORDS.test(line)) hits.push(`${rel(abs)}:${i + 1} ${line.trim().slice(0, 160)}`);
    });
  }
  lines(FILES.app).forEach((line, i) => {
    if (EXTRA_UI_KEYWORDS.test(line)) hits.push(`${rel(FILES.app)}:${i + 1} ${line.trim().slice(0, 160)}`);
  });
  assert(hits.length === 0, `命中 ${hits.length} 处：${hits.join(' | ')}`);
  return '0 命中';
});

// ── 断言 4：死代码只允许留在注释里（可见文案 0「提案」）────────────────────────
check('A4 app.js「提案」只出现在注释行（渲染文案 0 命中）', () => {
  const offenders = [];
  lines(FILES.app).forEach((line, i) => {
    if (!line.includes('提案')) return;
    const t = line.trim();
    const isComment = t.startsWith('//') || t.startsWith('*') || t.startsWith('/*') || t.startsWith('*/');
    if (!isComment) offenders.push(`${i + 1}: ${t.slice(0, 160)}`);
  });
  assert(offenders.length === 0, `非注释行出现「提案」：${offenders.join(' | ')}`);
  return '仅注释命中';
});

// ── 断言 5：看板计数不再渲染提案数字 ─────────────────────────────────────────
check('A5 boardCountsMarkup 不含提案计数（counts.proposals 不渲染）', () => {
  const src = readText(FILES.app);
  const start = src.indexOf('function boardCountsMarkup(counts)');
  assert(start >= 0, '找不到 boardCountsMarkup');
  const end = src.indexOf('\n}\n', start);
  assert(end > start, 'boardCountsMarkup 函数体边界未识别');
  const body = src.slice(start, end);
  assert(!body.includes('提案'), 'boardCountsMarkup 仍含「提案」');
  assert(!/counts\.proposals/.test(body), 'boardCountsMarkup 仍引用 counts.proposals');
  for (const must of ["['需求'", "['任务'", "['提交'", "['回执'", "['文件'"]) {
    assert(body.includes(must), `缺少计数项 ${must}`);
  }
  return '计数项：需求/任务/提交/回执/文件';
});

// ── 断言 6：开发流程四处文案已改名，旧文案 0 命中 ─────────────────────────────
check('A6 dev 流程文案「提交开发产出」4 处，旧「提交提案」0 命中（F-3d9d-2）', () => {
  const src = readText(FILES.app);
  const newHits = (src.match(/提交开发产出/g) || []).length;
  assert(newHits >= 4, `「提交开发产出」只有 ${newHits} 处（要求 ≥4：能力矩阵/动作标题/按钮/状态行）`);
  for (const old of ['开发提交提案', '提交提案', '未提交提案']) {
    assert(!src.includes(old), `旧文案仍在：${old}`);
  }
  // 内部命令/日志允许保留 propose，行为不变由 A13 兜住
  assert(src.includes("'dev-submit'"), 'dev-submit 动作不存在');
  assert(src.includes('dev:submit'), 'dev:submit IPC 引用丢失');
  return `新文案 ${newHits} 处，旧文案 0`;
});

// ── 断言 7：Owner 评审材料由五类变四类 ──────────────────────────────────────
check('A7 owner:materials 去提案类（四类：需求/上游/测试/提交）', () => {
  const main = readText(FILES.main);
  const start = main.indexOf('function ownerMaterials(project, requirementId)');
  assert(start >= 0, '找不到 ownerMaterials');
  const end = main.indexOf('\n}\n', start);
  const body = main.slice(start, end);
  assert(!/key: 'proposal'/.test(body), "ownerMaterials 仍有 key: 'proposal' 分组");
  assert(!/label: '提案'/.test(body), "ownerMaterials 仍有 label: '提案'");
  assert(!body.includes('listLegacyProposals'), 'ownerMaterials 仍读旧协议提案列表');
  for (const key of ["key: 'req'", "key: 'upstream'", "key: 'test'", "key: 'commit'"]) {
    assert(body.includes(key), `ownerMaterials 缺分组 ${key}`);
  }
  const app = readText(FILES.app);
  assert(app.includes('四类材料'), 'app.js 状态文案未改「四类材料」');
  assert(!app.includes('五类材料'), 'app.js 仍是「五类材料」');
  assert(!/item\.kind === 'proposal'/.test(app), "app.js 仍有 item.kind === 'proposal' 分支");
  return '四类分组齐全，提案分支 0';
});

// ── 断言 8：评审记录不再并入提案行，界面无提案容器 ──────────────────────────
check('A8 评审记录不再新增提案行（历史数据只走只读通道）', () => {
  const src = readText(FILES.app);
  assert(!/p\.proposals/.test(src), 'app.js 仍从 p.proposals 取提案');
  assert(!/proposal\.reviews/.test(src), 'app.js 仍并入提案评审');
  assert(!/'未命名提案'/.test(src), 'app.js 仍有未命名提案行');
  const idx = readText(FILES.index);
  for (const token of ['提案', 'proposal']) assert(!idx.includes(token), `index.html 仍含 ${token}`);
  for (const tab of ['overview', 'docs', 'flow', 'roles', 'files']) assert(idx.includes(`data-tab="${tab}"`), `缺页签 ${tab}`);
  return '页签 5 个，提案容器 0';
});

// ── 断言 9：style.css 提案样式清零 ──────────────────────────────────────────
check('A9 style.css 提案样式 0 命中（proposal/protocol/local-step 等）', () => {
  const css = readText(FILES.css);
  const hits = [];
  lines(FILES.css).forEach((line, i) => {
    if (/proposal|protocol-head|protocol-step|protocol-note|local-step|local-flag|local-arrow|legacy-badge/.test(line)) {
      hits.push(`${i + 1}: ${line.trim().slice(0, 120)}`);
    }
  });
  assert(hits.length === 0, `命中 ${hits.length} 处：${hits.join(' | ')}`);
  return `样式表 ${(css.length / 1024).toFixed(1)}KB，0 命中`;
});

// ── 断言 10：只读通道 proposal:list 仍在 ────────────────────────────────────
check('A10 只读通道 proposal:list 仍在（main/preload/team-tools）', () => {
  const main = readText(FILES.main);
  const preload = readText(FILES.preload);
  const tools = readText(FILES.teamTools);
  assert(/ipcMain\.handle\('proposal:list'/.test(main), 'main.js 缺 ipcMain.handle(proposal:list)');
  assert(/proposalList/.test(preload), 'preload.js 未暴露 proposalList');
  assert(/listLegacyProposals/.test(tools), 'team-tools.js 缺 listLegacyProposals');
  assert(/function listLegacyProposals/.test(tools), 'listLegacyProposals 不是函数定义');
  return 'proposal:list 三处齐全';
});

// ── 断言 11：只读通道 proposal:legacy（action:'show'）仍在 ──────────────────
check("A11 只读通道 proposal:legacy(action:'show') 仍在", () => {
  const main = readText(FILES.main);
  const preload = readText(FILES.preload);
  const tools = readText(FILES.teamTools);
  assert(/team:proposal-legacy/.test(main), 'main.js 缺 team:proposal-legacy handler');
  assert(/LEGACY_REVIEW_ACTIONS = \['propose', 'show'/.test(main), "main.js 的 LEGACY_REVIEW_ACTIONS 不含 show（proposal:legacy 只读通道被砍）");
  assert(/proposalLegacy\b/.test(preload) && /proposalLegacyShow/.test(preload), 'preload.js 未暴露 proposalLegacy / proposalLegacyShow');
  assert(/if \(action === 'show'\)/.test(tools), 'team-tools.js 缺 action === show 分支');
  assert(/legacyShow/.test(tools), 'team-tools.js 缺 legacyShow');
  return 'proposal:legacy + show 分支齐全';
});

// ── 断言 12：A 案协议面不动 + 既有 selftest 断言保留（AC2 基线）────────────
check('A12 A 案不废协议：proposal:create/review/sign/apply/rollback 与 selftest 基线仍在', () => {
  const main = readText(FILES.main);
  for (const ipc of ['proposal:create', 'proposal:review', 'proposal:sign', 'proposal:apply', 'proposal:rollback']) {
    assert(main.includes(`ipcMain.handle('${ipc}'`), `main.js 缺 ${ipc}（A 案不许废协议）`);
  }
  assert(main.includes('proposal:legacy IPC 暴露并可镜像'), 'selftest 断言「proposal:legacy IPC 暴露并可镜像」被删（AC2 A 案基线不许改）');
  assert(/devSubmit|dev:submit/.test(main), 'dev 流程不见了');
  return '5 个协议 IPC + selftest 断言在';
});

// ── 断言 13：数据零删除（清理前后清单全等 + 与磁盘实时清单三向相等）───────────
check('A13 提案/** 清单前后全等（path+size+sha256，AC3）', () => {
  const before = loadManifest(FILES.before);
  const after = loadManifest(FILES.after);
  const live = proposalManifest();
  for (const [name, m] of [['before', before], ['after', after]]) {
    assert(m.count === live.count, `${name}.count=${m.count} ≠ 磁盘 ${live.count}`);
    assert(m.totalBytes === live.totalBytes, `${name}.totalBytes=${m.totalBytes} ≠ 磁盘 ${live.totalBytes}`);
    assert(m.manifestSha256 === live.manifestSha256, `${name}.manifestSha256=${m.manifestSha256} ≠ 磁盘 ${live.manifestSha256}`);
    assert(Array.isArray(m.files) && m.files.length === live.count, `${name}.files 条数不符`);
  }
  assert(before.manifestSha256 === after.manifestSha256, '前后 manifestSha256 不等（数据被删/改）');
  return `${live.count} 文件 / ${live.totalBytes}B / ${live.manifestSha256.slice(0, 16)}…`;
});

// ── 断言 14：AC4 数据面（真实提案字段与三份评审/签字文件）────────────────────
check('A14 真实提案 P-…dd3a2a 字段完整（status/files/reviews/signatures）', () => {
  const id = 'P-20261112-142404-dd3a2a';
  const dir = path.join(PROPOSAL_DIR, id);
  assert(fs.existsSync(dir), `提案目录不存在：${rel(dir)}`);
  const meta = JSON.parse(readText(path.join(dir, '提案.json')));
  assert(meta.id === id, `提案.json id=${meta.id}`);
  assert(String(meta.status) === 'applied', `status=${meta.status}（期望 applied）`);
  assert(Array.isArray(meta.files) && meta.files.length > 0, 'files 为空');
  for (const name of ['analyst', 'pm']) {
    const review = path.join(dir, '评审', `${name}.json`);
    assert(fs.existsSync(review) && fs.statSync(review).size > 0, `评审/${name}.json 缺失或空`);
  }
  const sign = path.join(dir, '签字', 'pm.json');
  assert(fs.existsSync(sign) && fs.statSync(sign).size > 0, '签字/pm.json 缺失或空');
  return `${id} applied · files ${meta.files.length} · 评审 2 · 签字 1`;
});

// ── 断言 15：审计行字段齐全且与清单同源（F-3d9d-6 / AC7）──────────────────
check('A15 提案清理.jsonl：字段齐全，dataSnapshot 与清单复算相等', () => {
  assert(fs.existsSync(FILES.audit), `审计文件不存在：${rel(FILES.audit)}`);
  const rows = lines(FILES.audit).filter((line) => line.trim());
  assert(rows.length >= 1, '审计文件为空');
  const row = JSON.parse(rows[rows.length - 1]);
  for (const key of ['at', 'actor', 'mode', 'batchId', 'items', 'codePaths', 'dataSnapshot', 'evidence']) {
    assert(Object.prototype.hasOwnProperty.call(row, key), `缺字段 ${key}`);
  }
  assert(row.mode === 'A', `mode=${row.mode}（A 案必须是 A）`);
  assert(/^\d{8}-\d{4}$/.test(String(row.batchId)), `batchId 格式不对：${row.batchId}`);
  assert(Array.isArray(row.items) && row.items.length > 0, 'items 为空');
  assert(Array.isArray(row.codePaths) && row.codePaths.length > 0, 'codePaths 为空');
  const live = proposalManifest();
  assert(row.dataSnapshot.count === live.count, `dataSnapshot.count=${row.dataSnapshot.count} ≠ ${live.count}`);
  assert(row.dataSnapshot.totalBytes === live.totalBytes, `dataSnapshot.totalBytes 不等`);
  assert(row.dataSnapshot.manifestSha256 === live.manifestSha256, 'dataSnapshot.manifestSha256 与清单复算不等');
  assert(Array.isArray(row.evidence) && row.evidence.length > 0, 'evidence 为空');
  for (const item of row.evidence) {
    const abs = path.resolve(ROOT, item.path);
    assert(fs.existsSync(abs), `evidence 文件不存在：${item.path}`);
    const actual = sha256File(abs);
    assert(actual === item.sha256, `evidence sha256 不符：${item.path}`);
    assert(!path.isAbsolute(item.path), `evidence 路径不得是绝对路径：${item.path}`);
  }
  return `batchId=${row.batchId} · items ${row.items.length} · codePaths ${row.codePaths.length} · evidence ${row.evidence.length}`;
});

// ── 断言 16：工作流 events[] 有 proposal_cleanup（同 batchId）──────────────
check('A16 工作流 events[] 含 proposal_cleanup（mode A / 同 batchId）', () => {
  const wf = JSON.parse(readText(FILES.workflow));
  const events = Array.isArray(wf.events) ? wf.events : [];
  const rows = lines(FILES.audit).filter((line) => line.trim());
  const audit = JSON.parse(rows[rows.length - 1]);
  const hit = events.filter((e) => e && (e.type === 'proposal_cleanup' || e.action === 'proposal_cleanup'));
  assert(hit.length >= 1, 'events[] 没有 proposal_cleanup');
  const last = hit[hit.length - 1];
  assert(last.mode === 'A', `event.mode=${last.mode}`);
  assert(last.batchId === audit.batchId, `event.batchId=${last.batchId} ≠ 审计 ${audit.batchId}`);
  assert(Array.isArray(last.items) && last.items.length > 0, 'event.items 为空');
  return `${hit.length} 条 · batchId=${last.batchId}`;
});

// ── 收尾：写证据 JSON，失败退出 1 ──────────────────────────────────────────
const passed = checks.filter((c) => c.ok).length;
const ok = passed === checks.length;
fs.mkdirSync(EVID_DIR, { recursive: true });
const payload = {
  at: new Date().toISOString(),
  requirementId: 'R-20261115-065609-3d9d',
  taskId: 'T-20261115-085543-9624',
  mode: 'A',
  project: PROJECT_NAME,
  ok,
  passed,
  total: checks.length,
  manifest: (() => {
    try { return proposalManifest(); } catch (e) { return { error: String(e.message || e) }; }
  })(),
  checks
};
fs.writeFileSync(FILES.result, JSON.stringify(payload, null, 2) + '\n', 'utf8');

for (const c of checks) console.log(`${c.ok ? 'PASS' : 'FAIL'} ${c.name}${c.detail ? ' → ' + c.detail : ''}`);
console.log(`\nPROPOSAL_REMOVED ${ok ? 'OK' : 'FAIL'} ${passed}/${checks.length}`);
console.log(`evidence: ${rel(FILES.result)}`);
process.exit(ok ? 0 : 1);
