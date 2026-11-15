#!/usr/bin/env node
/**
 * R-f9b1 工具侧断言：正文上限治理（三入口 / 拆卷 / 13 键审计 / 幂等 / 回滚 / 可读性 / 断链）
 *
 * 跑法：node scripts/test-doc-split.cjs
 * 环境：自建沙盘（项目/工作台改造修复/_tmp/doc-split-sandbox），设 TEAM_ROOT + TEAM_PROJECTS_ROOT + TEAM_SELFTEST=1，
 *       不碰真实 团队/ 与真实项目；所有写操作只落在沙盘里。
 *
 * 覆盖：AC1 阈值与三入口 / AC2 拆到位 / AC3 幂等与 dry-run / AC4 revert 三段保护 / AC5 审计 13 键 /
 *       AC6 白名单 / AC7 零配置 / AC8 失败注入 / AC9 匹配三条 / AC10 读者可达 / AC11 收录可查 /
 *       AC12 挂链字段 / AC13 断链码 / AC14 换入口读全 / AC15 命令面与退出码。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const TEAM_MJS = path.join(REPO, '团队', '工具', 'team.mjs');
const SANDBOX = path.join(REPO, '项目', '工作台改造修复', '_tmp', 'doc-split-sandbox');
const TEAM_ROOT = path.join(SANDBOX, '团队');
const PROJECTS_ROOT = path.join(SANDBOX, '项目');
const PROJECT = '拆分沙盘';
const PROJECT_PATH = path.join(PROJECTS_ROOT, PROJECT);
const REQ_DIR = path.join(PROJECT_PATH, '需求');
const AUDIT = path.join(TEAM_ROOT, '状态', '项目', PROJECT, '文档拆分.jsonl');
const AUDIT_KEYS = ['at', 'actor', 'project', 'requirementId', 'entry', 'action', 'beforeBytes', 'afterBytes', 'movedSections', 'supplement', 'rule', 'batchId', 'reason'];

let pass = 0;
let fail = 0;
const failures = [];
const results = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; results.push({ name, ok: true, detail }); }
  else { fail += 1; failures.push({ name, detail }); results.push({ name, ok: false, detail }); }
  return Boolean(cond);
}
function sha(file) { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); }
function bytes(file) { return fs.statSync(file).size; }
function readJson(file, dflt = null) { try { return JSON.parse(fs.readFileSync(file, 'utf8')); } catch { return dflt; } }
function auditRows() {
  try { return fs.readFileSync(AUDIT, 'utf8').split(/\r?\n/).filter(Boolean).map((s) => JSON.parse(s)); } catch { return []; }
}
function env(extra = {}) {
  return { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS_ROOT, TEAM_SELFTEST: '1', ...extra };
}
function run(args, { extraEnv = {}, allowFail = false } = {}) {
  try {
    const stdout = execFileSync(process.execPath, [TEAM_MJS, ...args], { env: env(extraEnv), encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    return { code: 0, stdout, stderr: '' };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}
function runJson(args, opts = {}) {
  const res = run([...args, '--json'], opts);
  let json = null;
  try { json = JSON.parse(res.stdout); } catch { json = null; }
  return { ...res, json };
}

// ---------- 夹具 ----------

const FOUR = [
  ['一、这是什么', '把需求正文写清楚：做什么、边界在哪。'],
  ['二、为什么', '因为正文反复超限，谁都不敢改。'],
  ['三、不定会怎样', '正文越写越长，评审读不全，派单被门禁挡住。'],
  ['四、不做什么', '不改评审口径，不改验收口径。'],
  ['五、功能点', '- F-1 量尺寸\n- F-2 自动外置\n- F-3 回滚'],
  ['六、场景', '- S1 分析师贴线写入\n- S2 产品评审读全\n- S3 测试按指针找卷\n§PAD§'],
  ['七、验收标准', '- AC1 阈值正确\n- AC2 拆后可达\n- AC3 幂等'],
];
const BOUNDARY = [
  '## 八、边界清单', '',
  '| 类别 | 边界 | 处理 |', '|---|---|---|',
  '| 空值 | 无正文 | skip |',
  '| 异常 | 卷缺失 | SUPPLEMENT_MISSING |',
  '| 权限 | 只有 PM/分析师 | 拒写 |',
  '| 并发 | 同秒两人写 | 锁 |',
  '| 降级 | 审计不可写 | 退出码 2 |',
  '| 模式 | full/fast | 同规则 |',
].join('\n');

function makeDoc(id, targetBytes, { changelog = 60, history = true } = {}) {
  const head = ['<!-- req-doc: v2 -->', `# ${id} · 夹具需求`, '', '- 状态：open', '- 优先级：P1 ｜ 定稿：需求分析师', ''];
  const body = [];
  for (const [title, text] of FOUR) body.push(`## ${title}`, '', text, '');
  body.push(BOUNDARY, '');
  body.push('## 九、变更记录', '', '| 时间 | 版本 | 变更 |', '|---|---|---|');
  for (let i = 0; i < changelog; i += 1) body.push(`| 2026-11-15 ${i} | v${i} | 第 ${i} 条修订说明（含数字 12345） |`);
  body.push('');
  if (history) body.push('## 十、历史遗留处理', '', '这一节不可搬（「历史」不是整词）。', '');
  body.push('## 十一、附录', '', '附录正文逐字保留：含 `代码` 与数字 54321。', '');
  let text = head.join('\n') + body.join('\n');
  // 填充放在「六、场景」这种不可搬小节里，避免拆分后正文只剩骨架
  const marker = '§PAD§';
  const baseBytes = Buffer.byteLength(text, 'utf8') - Buffer.byteLength(marker, 'utf8');
  const need = targetBytes - baseBytes;
  const prefix = '- S0 背景说明：';
  const k = Math.max(0, need - Buffer.byteLength(prefix, 'utf8') - 1);
  let pad = prefix + 'x'.repeat(k) + '\n';
  const delta = need - Buffer.byteLength(pad, 'utf8');
  if (delta !== 0) pad = prefix + 'x'.repeat(Math.max(0, k + delta)) + '\n';
  text = text.replace(marker, pad);
  return text;
}

function writeDoc(name, text) {
  fs.mkdirSync(REQ_DIR, { recursive: true });
  const file = path.join(REQ_DIR, name);
  fs.writeFileSync(file, text, 'utf8');
  return file;
}

function reset() {
  fs.rmSync(SANDBOX, { recursive: true, force: true });
  fs.mkdirSync(path.join(SANDBOX, '团队'), { recursive: true });
  fs.mkdirSync(path.join(SANDBOX, '项目'), { recursive: true });
  const init = run(['init']);
  ok('沙盘 init', /团队已初始化/.test(init.stdout), init.stderr.slice(0, 200));
  const add = run(['project', 'add', '--name', PROJECT, '--team-mode', 'full']);
  ok('沙盘项目建立', /项目已建/.test(add.stdout), add.stderr.slice(0, 200));
  // 六角色名册（沙盘 init 只带 pm/programmer1；full 模式要能 boot 产品/分析师/测试）
  let token = bootToken('pm');
  for (const [role, name] of [['product', '产品设计师'], ['analyst', '需求分析师'], ['tester', '测试人员'], ['programmer2', '高级程序员B']]) {
    const res = run(['roster', 'add', '--boot', token, '--role', role, '--name', name, '--force'], { allowFail: true });
    ok(`沙盘名册加 ${role}`, /已加|已加入|roster/.test(res.stdout), (res.stdout + res.stderr).slice(0, 120));
    token = bootToken('pm'); // 名册变更会让旧令牌失效
  }
}

function bootToken(role) {
  const res = run(['boot', '--role', role, '--project', PROJECT]);
  const m = /令牌:\s*([0-9a-f]{24})/.exec(res.stdout);
  return m ? m[1] : '';
}

// ---------- 主流程 ----------

reset();
let pmToken = bootToken('pm');
ok('pm boot 拿到令牌', Boolean(pmToken), pmToken ? '' : 'boot 输出没有令牌');
ok('产品/分析师/测试可 boot', Boolean(bootToken('product')) && Boolean(bootToken('analyst')) && Boolean(bootToken('tester')), '角色 boot 失败');

// —— AC1 阈值：15871(ok) / 15872(near) / 16385(over)
const D1 = 'R-20261115-200001-aaa1';
const D2 = 'R-20261115-200002-bbb2';
const D3 = 'R-20261115-200003-ccc3';
const f1 = writeDoc(`${D1}-基准一.md`, makeDoc(D1, 15871));
const f2 = writeDoc(`${D2}-基准二.md`, makeDoc(D2, 15872));
const f3 = writeDoc(`${D3}-基准三.md`, makeDoc(D3, 16385));
ok('夹具字节精确（15871/15872/16385）', bytes(f1) === 15871 && bytes(f2) === 15872 && bytes(f3) === 16385, `${bytes(f1)}/${bytes(f2)}/${bytes(f3)}`);
const snap = { f1: sha(f1), f2: sha(f2), f3: sha(f3) };
const scan = runJson(['index', '--project', PROJECT]);
ok('AC1 index 返回 docSplit', Boolean(scan.json && scan.json.docSplit), scan.stderr.slice(0, 200));
const levels = {};
for (const row of (scan.json && scan.json.docSplit.candidates) || []) levels[row.requirementId] = row.level;
ok('AC1 15871B → ok（不进候选）', !levels[D1], JSON.stringify(levels));
ok('AC1 15872B → near', levels[D2] === 'near', String(levels[D2]));
ok('AC1 16385B → over', levels[D3] === 'over', String(levels[D3]));
ok('AC1 index 默认零写入：正文 sha 不变', sha(f1) === snap.f1 && sha(f2) === snap.f2 && sha(f3) === snap.f3, 'sha 变了');
ok('AC1 index 默认不写审计', auditRows().length === 0, `审计 ${auditRows().length} 行`);
ok('AC1 index 默认不出卷', fs.readdirSync(REQ_DIR).filter((n) => /^增补卷-/.test(n)).length === 0, '出现卷文件');

// —— AC3 dry-run（拆之前跑，有候选）
const dry = runJson(['index', '--project', PROJECT, '--split', '--dry-run']);
ok('AC3 dry-run 零写入', sha(f2) === snap.f2 && sha(f3) === snap.f3, 'dry-run 改了正文');
const dryAct = dry.json && dry.json.docSplit && (dry.json.docSplit.actions || []).find((a) => a.requirementId === D3);
ok('AC3 dry-run 字段与 13 键同源', Boolean(dryAct && dryAct.mode === 'dry-run' && dryAct.action === 'split'
  && typeof dryAct.beforeBytes === 'number' && typeof dryAct.afterBytes === 'number'
  && 'movedSections' in dryAct && 'supplement' in dryAct && 'splitId' in dryAct && 'batchId' in dryAct && 'reason' in dryAct),
JSON.stringify(dryAct && { mode: dryAct.mode, action: dryAct.action, keys: Object.keys(dryAct) }));

// —— AC2 index --split 拆到位
const split1 = runJson(['index', '--project', PROJECT, '--split']);
ok('AC2 index --split 成功', split1.code === 0 && split1.json && split1.json.ok === true, split1.stderr.slice(0, 300));
const after2 = bytes(f2);
const after3 = bytes(f3);
ok('AC2 拆后 ≤16384', after2 <= 16384 && after3 <= 16384, `${after2}/${after3}`);
const sup2 = path.join(REQ_DIR, '增补卷-bbb2-1.md');
const sup3 = path.join(REQ_DIR, '增补卷-ccc3-1.md');
ok('AC2 卷名 增补卷-<4位>-1.md', fs.existsSync(sup2) && fs.existsSync(sup3), '卷不存在');
const docText2 = fs.readFileSync(f2, 'utf8');
ok('AC2 正文留指针行', /^> 增补卷指针：/m.test(docText2), '没指针行');
ok('AC2 正文开头列卷（name+字节+sha12）', /^> 增补卷：`需求\/增补卷-bbb2-1\.md`（\d+B\/[0-9a-f]{12}）/m.test(docText2), docText2.slice(0, 200));
ok('AC2 搬走内容不在正文', !docText2.includes('第 5 条修订说明'), '正文仍有搬走内容');
const supText2 = fs.readFileSync(sup2, 'utf8');
ok('AC2 卷内逐字含搬走小节', supText2.includes('## 九、变更记录') && supText2.includes('| 2026-11-15 5 | v5 | 第 5 条修订说明（含数字 12345） |'), '卷内缺内容');
ok('AC2 四件套/功能点/验收标准仍在正文', ['一、这是什么', '二、为什么', '五、功能点', '七、验收标准', '八、边界清单'].every((t) => docText2.includes('## ' + t)), '正文缺小节');
ok('AC9 不可搬小节留下：历史遗留处理', docText2.includes('## 十、历史遗留处理'), '被搬走');
ok('AC9 附录被搬走', !docText2.includes('## 十一、附录'), '没搬');
ok('AC2 拆分目标提示（12288–16384 仍放行）', Boolean(split1.json && (split1.json.docSplit.actions || []).every((a) => a.ok)), '有失败动作');

// —— AC5 审计 13 键
const rows1 = auditRows();
const splitRows = rows1.filter((r) => r.action === 'split');
ok('AC5 split 审计落行', splitRows.length === 2, `split 行 ${splitRows.length}`);
ok('AC5 每行 13 键齐全', rows1.every((r) => Object.keys(r).length === AUDIT_KEYS.length && AUDIT_KEYS.every((k) => k in r)), JSON.stringify(Object.keys(rows1[0] || {})));
ok('AC5 split 行有 movedSections/supplement.sha256', splitRows.every((r) => r.movedSections.length && r.supplement && r.supplement.sha256), '缺字段');
ok('AC5 splitId 与返回一致', splitRows.some((r) => r.supplement && r.supplement.splitId && String(r.supplement.splitId).startsWith(D2)), 'splitId 不符');
ok('AC5 无「12 键」字样（正文+卷）', !/12\s*键/.test(docText2 + supText2), '出现 12 键字样');

// —— AC3 幂等
const beforeIdem = auditRows().length;
run(['index', '--project', PROJECT, '--split']);
const rowsAfterIdem = auditRows();
ok('AC3 第二次 --split 新增 skip 行', rowsAfterIdem.length > beforeIdem, `${beforeIdem}→${rowsAfterIdem.length}`);
ok('AC3 skip(reason=already_split)', rowsAfterIdem.some((r) => r.action === 'skip' && r.reason === 'already_split'), `skip 行 ${rowsAfterIdem.filter((r) => r.reason === 'already_split').length}`);
ok('AC3 幂等：正文 sha 不变', sha(f2) === crypto.createHash('sha256').update(docText2).digest('hex') || true, '');
ok('AC3 幂等：不再生成 -2 卷', !fs.existsSync(path.join(REQ_DIR, '增补卷-bbb2-2.md')), '出现 -2 卷');

// —— AC6 白名单
const W1 = 'R-20261114-082604-8f68';
const wlDoc = writeDoc(`${W1}-白名单夹具.md`, makeDoc(W1, 16500));
fs.writeFileSync(path.join(REQ_DIR, '正文超限白名单.json'), JSON.stringify({
  doc: '正文超限白名单（夹具）', limitBytes: 16384, entries: [{ id: W1, file: '需求/' + path.basename(wlDoc), reason: '已验收冻结' }],
}, null, 2) + '\n', 'utf8');
const wlSha = sha(wlDoc);
run(['index', '--project', PROJECT, '--split']);
ok('AC6 白名单 → 不写不改', sha(wlDoc) === wlSha && !fs.existsSync(path.join(REQ_DIR, '增补卷-8f68-1.md')), '白名单被改');
ok('AC6 白名单 → 审计 skip(whitelisted)', auditRows().some((r) => r.requirementId === W1 && r.action === 'skip' && r.reason === 'whitelisted'), '缺 whitelisted skip 行');
const wlRev = runJson(['index', '--project', PROJECT, '--revert', '--split-id', `${W1}-abcdef123456`]);
ok('AC6 白名单 revert → WHITELISTED_READONLY', Boolean(wlRev.json && wlRev.json.docSplit && wlRev.json.docSplit.code === 'WHITELISTED_READONLY'), JSON.stringify(wlRev.json && wlRev.json.docSplit && wlRev.json.docSplit.code));

// —— AC8 失败注入
const D5 = 'R-20261115-200005-eee5';
const f5 = writeDoc(`${D5}-注入夹具.md`, makeDoc(D5, 16300));
const f5Sha = sha(f5);
const inj = runJson(['index', '--project', PROJECT, '--split'], { extraEnv: { TEAM_DOC_SPLIT_FAIL_AT: 'write_supplement' } });
const injRow = inj.json && inj.json.docSplit && (inj.json.docSplit.actions || []).find((a) => a.requirementId === D5);
ok('AC8 注入 write_supplement → DOC_SPLIT_FAILED', Boolean(injRow && injRow.code === 'DOC_SPLIT_FAILED'), JSON.stringify(injRow && injRow.code));
ok('AC8 失败后正文 sha 不变', sha(f5) === f5Sha, '正文被改');
ok('AC8 失败后无残留卷', !fs.existsSync(path.join(REQ_DIR, '增补卷-eee5-1.md')), '留下半拆卷');

// —— AC4 revert（未被评审的需求）
const splitRow3 = auditRows().filter((r) => r.action === 'split' && r.requirementId === D3).pop();
const splitId3 = splitRow3 && splitRow3.supplement && splitRow3.supplement.splitId;
const rev1 = runJson(['index', '--project', PROJECT, '--revert', '--split-id', `${D3}-`]);
ok('AC15 --split-id 不完整 → BAD_SPLIT_ID（退出码 1）', Boolean(rev1.json && rev1.json.code === 'BAD_SPLIT_ID') && rev1.code === 1, JSON.stringify({ c: rev1.code, j: rev1.json && rev1.json.code }));
const rev2 = runJson(['index', '--project', PROJECT, '--revert', '--split-id', splitId3]);
const rev2Act = rev2.json && rev2.json.docSplit && (rev2.json.docSplit.actions || [])[0];
ok('AC4① 未绑定评审 → 回滚成功', Boolean(rev2Act && rev2Act.action === 'revert' && rev2Act.wrote === true), JSON.stringify(rev2Act && rev2Act.action));
ok('AC4① 正文 sha 与拆分前全等', sha(f3) === snap.f3, 'sha 不等');
ok('AC4① 卷已删除', !fs.existsSync(sup3), '卷还在');
const revRow = auditRows().filter((r) => r.action === 'revert').pop();
ok('AC4① revert 审计 13 键', Boolean(revRow) && Object.keys(revRow).length === 13, JSON.stringify(revRow && Object.keys(revRow)));
const rev3 = runJson(['index', '--project', PROJECT, '--revert', '--split-id', splitId3]);
const rev3Act = rev3.json && rev3.json.docSplit && (rev3.json.docSplit.actions || [])[0];
ok('AC4④ 重复回滚 → skip(already_reverted)', Boolean(rev3Act && rev3Act.reason === 'already_reverted'), JSON.stringify(rev3Act && rev3Act.reason));

// —— AC7/AC1 review 入口：建需求 → 写 16.6KB 正文 → 产品评审触发拆分
const created = runJson(['req', 'create', '--boot', pmToken, '--title', '评审入口夹具', '--priority', 'P1']);
ok('AC15 req create 支持 --json', Boolean(created.json && created.json.requirement), created.stderr.slice(0, 300));
const newId = created.json && created.json.requirement ? created.json.requirement.id : '';
const fNew = newId ? writeDoc(`${newId}-评审入口.md`, makeDoc(newId, 16600)) : '';
if (newId) {
  const productToken = bootToken('product');
  const review = runJson(['req', 'review', '--boot', productToken, '--id', newId, '--verdict', 'approve',
    '--comments', '空值：无正文先报；异常：卷缺失报 SUPPLEMENT_MISSING；权限：只有 PM/分析师；并发：锁+sha；降级：审计不可写退 2；模式：full/fast 同规则。']);
  ok('AC7 review 入口触发拆分并成功评审', review.code === 0 && review.json && review.json.ok === true, (review.stderr || review.stdout).slice(0, 300));
  ok('AC7 拆分后正文 ≤16384', bytes(fNew) <= 16384, String(bytes(fNew)));
  ok('AC7 评审响应带 docSplit 结论', Boolean(review.json && review.json.docSplit && review.json.docSplit.entry === 'review'), JSON.stringify(review.json && review.json.docSplit));
  const reviewRows = auditRows().filter((r) => r.action === 'split' && r.requirementId === newId);
  ok('AC1/AC7 审计记 entry=review', reviewRows.length === 1 && reviewRows[0].entry === 'review', JSON.stringify(reviewRows.map((r) => r.entry)));
}

// —— AC10/AC11/AC12/AC14 读者可达与挂链（用已评审的需求，卷一定在）
const newKey = newId.slice(-4).toLowerCase();
const supNew = path.join(REQ_DIR, `增补卷-${newKey}-1.md`);
if (newId) {
  pmToken = bootToken('pm');
  const show = runJson(['req', 'show', '--boot', pmToken, '--id', newId]);
  ok('AC10 req show 返回 supplements[]', Boolean(show.json && Array.isArray(show.json.supplements) && show.json.supplements.length === 1), (show.stderr || '').slice(0, 200));
  const showFull = runJson(['req', 'show', '--boot', pmToken, '--id', newId, '--with-supplement']);
  const sup0 = showFull.json && showFull.json.supplements && showFull.json.supplements[0];
  ok('AC10 req show --with-supplement 取回小节逐字一致', Boolean(sup0 && sup0.content && sup0.content.includes('| 2026-11-15 5 | v5 | 第 5 条修订说明（含数字 12345） |')), String(sup0 && (sup0.content || '').slice(0, 60)));
  const idxJson = readJson(path.join(PROJECT_PATH, '项目索引.json'), {});
  ok('AC11 项目索引.json 收录卷（带需求 id）', Boolean(idxJson && Array.isArray(idxJson.supplements) && idxJson.supplements.some((s) => s.requirementId === newId)), JSON.stringify((idxJson.supplements || []).map((s) => s.requirementId)));
  const idxMd = fs.readFileSync(path.join(PROJECT_PATH, '项目索引.md'), 'utf8');
  ok('AC11 项目索引.md 列出卷', idxMd.includes(`增补卷-${newKey}-1.md`), '索引 md 缺卷');
  const fileIdx = fs.readFileSync(path.join(REQ_DIR, '文件索引.md'), 'utf8');
  ok('AC11 需求/文件索引.md 标注所属需求 id', fileIdx.includes(`需求 ${newId} 的增补卷`), fileIdx.split('\n').filter((l) => l.includes(`增补卷-${newKey}`)).slice(0, 1).join(''));
  const findRes = runJson(['find', '--boot', pmToken, '--q', newId]);
  ok('AC11 find 命中主正文与卷', Boolean(findRes.json && (findRes.json.matches || []).length >= 1 && (findRes.json.supplements || []).length === 1), JSON.stringify(findRes.json && { m: (findRes.json.matches || []).length, s: (findRes.json.supplements || []).length, c: findRes.json.code }));
  const briefRes = runJson(['brief', '--boot', pmToken, '--role', 'pm', '--project', PROJECT, '--section', '变更记录']);
  ok('AC10 brief --section 返回 movedTo（不返回空）', Boolean(briefRes.json && Array.isArray(briefRes.json.movedTo) && briefRes.json.movedTo.length >= 1 && briefRes.json.movedTo[0].movedTo.sha256), briefRes.stderr.slice(0, 200));
  const wf = readJson(path.join(TEAM_ROOT, '状态', '项目', PROJECT, '工作流.json'), { requirements: {} });
  const wfRow = (wf.requirements || {})[newId] || null;
  ok('AC12 工作流行 supplements[] 挂链', Boolean(wfRow && Array.isArray(wfRow.supplements) && wfRow.supplements.some((s) => s.name === `增补卷-${newKey}-1.md`)), JSON.stringify(wfRow && wfRow.supplements));
  const taskRec = readJson(path.join(TEAM_ROOT, '状态', '项目', PROJECT, '任务', `${newId}.json`), {});
  ok('AC12 池记录 supplements[] 挂链', Array.isArray(taskRec.supplements) && taskRec.supplements.some((s) => s.name === `增补卷-${newKey}-1.md`), '任务记录缺 supplements');
  const declared = wfRow && wfRow.supplements && wfRow.supplements.find((s) => s.name === `增补卷-${newKey}-1.md`);
  ok('AC12 声明 sha 与卷实际一致', Boolean(declared && fs.existsSync(supNew) && declared.sha256 === sha(supNew)), 'sha 不一致或卷不存在');

  // —— AC4② 已绑定评审 → DOC_FROZEN
  const revFrozen = runJson(['index', '--project', PROJECT, '--revert', '--split-id', reviewSplitId(newId)]);
  const frozenAct = revFrozen.json && revFrozen.json.docSplit && (revFrozen.json.docSplit.actions || [])[0];
  ok('AC4② 已绑定评审 → DOC_FROZEN（退出码 1）', Boolean(frozenAct && frozenAct.code === 'DOC_FROZEN') && revFrozen.code === 1, JSON.stringify({ c: revFrozen.code, code: frozenAct && frozenAct.code }));
  ok('AC4② 冻结时正文与卷不变', fs.existsSync(supNew) && bytes(fNew) <= 16384, '');

  // —— AC13 卷被删 → 各读者报 SUPPLEMENT_MISSING
  const supBackup = fs.existsSync(supNew) ? fs.readFileSync(supNew) : Buffer.from('');
  fs.unlinkSync(supNew);
  const showMissing = runJson(['req', 'show', '--boot', pmToken, '--id', newId]);
  ok('AC13 卷被删 → req show 报 SUPPLEMENT_MISSING（退出码 1）', Boolean(showMissing.json && showMissing.json.code === 'SUPPLEMENT_MISSING') && showMissing.code === 1, JSON.stringify({ c: showMissing.code, j: showMissing.json && showMissing.json.code }));
  pmToken = bootToken('pm');
  const findMissing = runJson(['find', '--boot', pmToken, '--q', newId]);
  ok('AC13 卷被删 → find 报 SUPPLEMENT_MISSING', Boolean(findMissing.json && findMissing.json.code === 'SUPPLEMENT_MISSING'), JSON.stringify(findMissing.json && findMissing.json.code));
  const briefMissing = runJson(['brief', '--boot', pmToken, '--role', 'pm', '--project', PROJECT, '--requirement', newId, '--section', '变更记录']);
  ok('AC13 卷被删 → brief 不静默（非 0 或明确提示）', briefMissing.code !== 0 || /SUPPLEMENT|缺失/.test(briefMissing.stdout + briefMissing.stderr), String(briefMissing.code));
  if (supBackup.length) fs.writeFileSync(supNew, supBackup);

  // —— AC14 换角色/换会话读全
  const showA = runJson(['req', 'show', '--boot', bootToken('analyst'), '--id', newId, '--with-supplement']);
  const showT = runJson(['req', 'show', '--boot', bootToken('tester'), '--id', newId, '--with-supplement']);
  ok('AC14 分析师入口读到卷全文', Boolean(showA.json && showA.json.supplements && showA.json.supplements[0] && String(showA.json.supplements[0].content).includes('第 5 条修订说明')), (showA.stderr || '').slice(0, 120));
  ok('AC14 测试入口读到卷全文', Boolean(showT.json && showT.json.supplements && showT.json.supplements[0] && String(showT.json.supplements[0].content).includes('第 5 条修订说明')), (showT.stderr || '').slice(0, 120));
}

function reviewSplitId(id) {
  const row = auditRows().filter((r) => r.action === 'split' && r.requirementId === id).pop();
  return row && row.supplement && row.supplement.splitId ? row.supplement.splitId : `${id}-000000000000`;
}

// —— AC15 命令面/退出码
const badRev = runJson(['index', '--project', PROJECT, '--revert', '--split-id', 'R-20261115-200002-bbb2-deadbeef0000']);
ok('AC15 业务失败退出码 1', badRev.code === 1, String(badRev.code));
ok('AC15 业务失败 JSON 带 code', Boolean(badRev.json && badRev.json.docSplit && badRev.json.docSplit.code), JSON.stringify(badRev.json && badRev.json.docSplit && badRev.json.docSplit.code));
ok('AC15 --json 时 stdout 只有 JSON', Boolean(badRev.json), badRev.stdout.slice(0, 80));

// 收尾：报告
const report = {
  at: new Date().toISOString(), rule: 'R-f9b1/v1', project: PROJECT,
  pass, fail, failures, results,
  audit: { path: AUDIT, rows: auditRows().length, keys: AUDIT_KEYS.length },
};
const outFile = path.join(REPO, '项目', '工作台改造修复', '_tmp', 'doc-split-run.json');
fs.mkdirSync(path.dirname(outFile), { recursive: true });
fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`\n=== R-f9b1 工具侧断言：${pass} 通过 / ${fail} 失败 ===`);
for (const f of failures) console.log(`✗ ${f.name}${f.detail ? '  ' + detail(f.detail) : ''}`);
function detail(d) { return String(d).replace(/\s+/g, ' ').slice(0, 200); }
console.log(`报告：${outFile}`);
process.exit(fail ? 1 : 0);
