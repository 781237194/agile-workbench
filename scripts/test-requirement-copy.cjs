#!/usr/bin/env node
/**
 * R-dba4（工具侧，T-20261115-142650-acfe）断言：需求行大白话 copy 写入口
 *   白名单 / 非法字段拒 / 幂等 / append-only / 并发零副作用 / 重启仍在 / 纯函数兜底标记 / 两条通道同判据
 *
 * 跑法：node scripts/test-requirement-copy.cjs
 * 环境：自建沙盘 项目/工作台改造修复/_tmp/req-copy-sandbox（TEAM_ROOT + TEAM_PROJECTS_ROOT + TEAM_SELFTEST=1），
 *       不碰真实 团队/ 与真实项目。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const REPO = path.resolve(__dirname, '..');
const TEAM_MJS = path.join(REPO, '团队', '工具', 'team.mjs');
const SANDBOX = path.join(REPO, '项目', '工作台改造修复', '_tmp', 'req-copy-sandbox');
const TEAM_ROOT = path.join(SANDBOX, '团队');
const PROJECTS_ROOT = path.join(SANDBOX, '项目');
const PROJECT = '复制沙盘';
const REQ = 'R-20261115-150000-abcd';
const WF = path.join(TEAM_ROOT, '状态', '项目', PROJECT, '工作流.json');

let pass = 0; let fail = 0;
const failures = []; const results = [];
function ok(name, cond, detail = '') {
  if (cond) { pass += 1; results.push({ name, ok: true }); } else { fail += 1; failures.push({ name, detail: String(detail).replace(/\s+/g, ' ').slice(0, 220) }); results.push({ name, ok: false, detail }); }
}
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const readWf = () => JSON.parse(fs.readFileSync(WF, 'utf8'));
const rowOf = () => (readWf().requirements || {})[REQ] || null;
function env() { return { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS_ROOT, TEAM_SELFTEST: '1' }; }
function run(args, extraEnv = {}) {
  try {
    return { code: 0, stdout: execFileSync(process.execPath, [TEAM_MJS, ...args], { env: { ...env(), ...extraEnv }, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }) };
  } catch (e) {
    return { code: e.status == null ? -1 : e.status, stdout: String(e.stdout || ''), stderr: String(e.stderr || '') };
  }
}
function runJson(args) {
  const res = run([...args, '--json']);
  let json = null;
  try { json = JSON.parse(res.stdout); } catch { json = null; }
  return { ...res, json };
}

// ---------- 沙盘 ----------
fs.rmSync(SANDBOX, { recursive: true, force: true });
fs.mkdirSync(path.join(SANDBOX, '团队'), { recursive: true });
fs.mkdirSync(path.join(SANDBOX, '项目'), { recursive: true });
const init = run(['init']);
ok('沙盘 init', /团队已初始化/.test(init.stdout), init.stderr);
const add = run(['project', 'add', '--name', PROJECT, '--team-mode', 'full']);
ok('沙盘项目建立', /项目已建/.test(add.stdout), add.stderr);
const bootOut = run(['boot', '--role', 'pm', '--project', PROJECT]);
const tokenMatch = /令牌:\s*([0-9a-f]{24})/.exec(bootOut.stdout);
const token = tokenMatch ? tokenMatch[1] : '';
ok('pm boot 拿到令牌', Boolean(token), bootOut.stdout.slice(0, 120));

// 工作流夹具：一条需求行（其它字段用来验证白名单：保存 copy 不许动它们）
const now = new Date().toISOString();
fs.mkdirSync(path.dirname(WF), { recursive: true });
fs.writeFileSync(WF, JSON.stringify({
  schema: 2, project: PROJECT, round: 1, phase: 'owner_review', events: [],
  requirements: {
    [REQ]: {
      id: REQ, title: '大白话 copy 夹具', priority: 'P1', origin: 'role', queued: false, round: 1,
      status: 'approved', createdBy: 'product', createdAt: now, updatedAt: now,
      acceptanceCriteria: '夹具验收标准原样保留', story: '夹具 story', detail: '夹具 detail',
      productReview: { verdict: 'approve', by: 'product', at: now }, ownerReview: { status: 'pending' },
      decisions: [], dispatch: null, dev: null, test: null, acceptance: null,
      doc: '需求/' + REQ + '-夹具.md', history: [{ at: now, action: 'create', by: 'product', note: '夹具' }],
    },
  },
}, null, 2) + '\n', 'utf8');

const beforeRow = JSON.parse(JSON.stringify(rowOf()));
const beforeFileSha = sha(WF);

// ---------- CLI 正例：四块写入 ----------
const copy1 = { what: '这是什么：一句话说清', how: '怎么做：按文件改', impact: '影响谁：Owner 与测试', advice: '建议：先过评审' };
const r1 = runJson(['req', 'copy', '--boot', token, '--project', PROJECT, '--requirement', REQ,
  '--what', copy1.what, '--how', copy1.how, '--impact', copy1.impact, '--advice', copy1.advice]);
ok('CLI req copy 成功', r1.code === 0 && r1.json && r1.json.ok === true && r1.json.changed === true, r1.stderr || r1.stdout.slice(0, 160));
ok('CLI --json 只输出 JSON', Boolean(r1.json));
const row1 = rowOf();
ok('需求行 copy 四块落盘 + at/by/source', Boolean(row1 && row1.copy
  && row1.copy.what === copy1.what && row1.copy.how === copy1.how
  && row1.copy.impact === copy1.impact && row1.copy.advice === copy1.advice
  && row1.copy.source === 'author' && row1.copy.at && row1.copy.by === 'pm'), JSON.stringify(row1 && row1.copy));
ok('首次写入 copyHistory 为空', Array.isArray(row1.copyHistory) && row1.copyHistory.length === 0, JSON.stringify(row1.copyHistory));

// 白名单：除 copy/copyHistory/updatedAt 外，其它字段一个不变
const afterRow = JSON.parse(JSON.stringify(rowOf()));
const WL = ['copy', 'copyHistory', 'updatedAt'];
const strip = (row) => { const out = { ...row }; for (const k of WL) delete out[k]; return out; };
ok('白名单生效：只动 copy/copyHistory/updatedAt', JSON.stringify(strip(beforeRow)) === JSON.stringify(strip(afterRow)), '其它字段被改');
ok('id/status/acceptanceCriteria 原样', afterRow.id === beforeRow.id && afterRow.status === beforeRow.status && afterRow.acceptanceCriteria === beforeRow.acceptanceCriteria);

// ---------- 幂等：同内容再存 ----------
const histAfter1 = row1.copyHistory.length;
const r2 = runJson(['req', 'copy', '--boot', token, '--project', PROJECT, '--requirement', REQ,
  '--what', copy1.what, '--how', copy1.how, '--impact', copy1.impact, '--advice', copy1.advice]);
ok('重复保存幂等（changed=false / SAME_CONTENT）', r2.code === 0 && r2.json && r2.json.changed === false && r2.json.reason === 'SAME_CONTENT', JSON.stringify(r2.json && { c: r2.json.changed, r: r2.json.reason }));
ok('幂等不新增 copyHistory', rowOf().copyHistory.length === histAfter1, `${rowOf().copyHistory.length}`);

// ---------- append-only：改一块 ----------
const r3 = runJson(['req', 'copy', '--boot', token, '--project', PROJECT, '--requirement', REQ,
  '--what', copy1.what, '--how', '怎么做：换一种改法', '--impact', copy1.impact, '--advice', copy1.advice]);
ok('改一块 → changed=true 且 copyHistory +1', r3.code === 0 && r3.json.changed === true && rowOf().copyHistory.length === histAfter1 + 1, JSON.stringify(r3.json && r3.json.reason));
const h0 = rowOf().copyHistory[0];
ok('copyHistory 保留被替换版本（含 replacedAt/replacedBy）', Boolean(h0 && h0.how === copy1.how && h0.replacedAt && h0.replacedBy), JSON.stringify(h0 && { how: h0.how, replacedAt: h0.replacedAt, replacedBy: h0.replacedBy }));

// ---------- 并发：expected-updated-at 不符 → 零副作用 ----------
const curUpdatedAt = rowOf().updatedAt;
const fileShaBeforeConflict = sha(WF);
const conflict = runJson(['req', 'copy', '--boot', token, '--project', PROJECT, '--requirement', REQ,
  '--what', '并发覆盖尝试', '--how', 'x', '--impact', 'x', '--advice', 'x', '--expected-updated-at', '2000-01-01T00:00:00.000Z']);
ok('并发冲突 → COPY_CONFLICT（退出码 1）', conflict.code === 1 && conflict.json && conflict.json.code === 'COPY_CONFLICT', JSON.stringify({ c: conflict.code, j: conflict.json && conflict.json.code }));
ok('冲突零副作用（工作流文件 sha 不变）', sha(WF) === fileShaBeforeConflict, '文件被改');
ok('冲突后 updatedAt/copy 未变', rowOf().updatedAt === curUpdatedAt && rowOf().copy.what === copy1.what, '行被改');

// ---------- 校验：空 / 非法 source / 超长 ----------
const empty = runJson(['req', 'copy', '--boot', token, '--project', PROJECT, '--requirement', REQ]);
ok('四块全空 → COPY_EMPTY（退出码 1）', empty.code === 1 && empty.json && empty.json.code === 'COPY_EMPTY', JSON.stringify(empty.json && empty.json.code));
const badSource = runJson(['req', 'copy', '--boot', token, '--project', PROJECT, '--requirement', REQ, '--what', 'x', '--source', 'robot']);
ok('source 非法 → COPY_SOURCE_INVALID', badSource.code === 1 && badSource.json && badSource.json.code === 'COPY_SOURCE_INVALID', JSON.stringify(badSource.json && badSource.json.code));
const tooLong = runJson(['req', 'copy', '--boot', token, '--project', PROJECT, '--requirement', REQ, '--what', 'x'.repeat(601)]);
ok('单块 >600 字 → COPY_FIELD_INVALID', tooLong.code === 1 && tooLong.json && tooLong.json.code === 'COPY_FIELD_INVALID', JSON.stringify(tooLong.json && tooLong.json.code));
const noReq = runJson(['req', 'copy', '--boot', token, '--project', PROJECT, '--what', 'x']);
ok('缺 --requirement → REQUIREMENT_REQUIRED', noReq.code === 1 && noReq.json && noReq.json.code === 'REQUIREMENT_REQUIRED', JSON.stringify(noReq.json && noReq.json.code));

// ---------- 纯函数 + 两条通道同判据 ----------
const tt = require(path.join(REPO, 'src', 'team-tools.js'));
ok('白名单常量 = copy/copyHistory', Array.isArray(tt.REQUIREMENT_COPY_WRITABLE_FIELDS)
  && tt.REQUIREMENT_COPY_WRITABLE_FIELDS.length === 2
  && tt.REQUIREMENT_COPY_WRITABLE_FIELDS.includes('copy')
  && tt.REQUIREMENT_COPY_WRITABLE_FIELDS.includes('copyHistory'), JSON.stringify(tt.REQUIREMENT_COPY_WRITABLE_FIELDS));
ok('未登记字段被拒（COPY_FIELD_UNKNOWN）', tt.normalizeRequirementCopy({ what: 'x', hack: 1 }).code === 'COPY_FIELD_UNKNOWN', JSON.stringify(tt.normalizeRequirementCopy({ what: 'x', hack: 1 })));
ok('derive source 合法', tt.normalizeRequirementCopy({ what: 'x', source: 'derived' }).ok === true);
const tools = tt.create({ teamRoot: TEAM_ROOT });
ok('team-tools.saveRequirementCopy 可用', typeof tools.saveRequirementCopy === 'function');
const sameViaTools = tools.saveRequirementCopy({ projectName: PROJECT, requirementId: REQ, copy: { ...copy1, how: '怎么做：换一种改法' }, by: 'product' });
ok('同一份内容两条通道同判据（team-tools 也判 SAME_CONTENT）', sameViaTools.ok === true && sameViaTools.changed === false && sameViaTools.reason === 'SAME_CONTENT', JSON.stringify({ ok: sameViaTools.ok, code: sameViaTools.code, reason: sameViaTools.reason }));

// ---------- 兜底标记（requirementCopyView） ----------
const viewFull = tt.requirementCopyView(rowOf());
ok('requirementCopyView 返回四块与 copyMissing=[]', viewFull.copy && viewFull.copy.how && Array.isArray(viewFull.copyMissing) && viewFull.copyMissing.length === 0, JSON.stringify(viewFull.copyMissing));
const partialRow = { ...rowOf(), copy: { ...rowOf().copy, how: '' } };
const viewPartial = tt.requirementCopyView(partialRow);
ok('缺一块 → copyMissing 只标 how（AC3 逐块）', JSON.stringify(viewPartial.copyMissing) === JSON.stringify(['how']), JSON.stringify(viewPartial.copyMissing));
const viewNone = tt.requirementCopyView({ id: REQ });
ok('无 copy → copyMissing 四块全标 + copy=null', viewNone.copy === null && viewNone.copyMissing.length === 4, JSON.stringify(viewNone.copyMissing));

// ---------- 上限 20 条 + 顺序 ----------
for (let i = 0; i < 24; i += 1) {
  run(['req', 'copy', '--boot', token, '--project', PROJECT, '--requirement', REQ, '--what', `第 ${i} 版`, '--how', 'x', '--impact', 'x', '--advice', 'x']);
}
const rowCap = rowOf();
ok('copyHistory ≤20（连写 24 次后截到 20）', rowCap.copyHistory.length === 20, String(rowCap.copyHistory.length));
ok('copyHistory 顺序按时间（末条是上一版）', rowCap.copyHistory[rowCap.copyHistory.length - 1].what === '第 22 版', JSON.stringify(rowCap.copyHistory[rowCap.copyHistory.length - 1].what));
ok('当前 copy 是最后写入的一版', rowCap.copy.what === '第 23 版', rowCap.copy.what);

// ---------- 重启后仍在（新进程只读磁盘） ----------
const fresh = execFileSync(process.execPath, ['-e', `
const fs=require('fs');
const wf=JSON.parse(fs.readFileSync(${JSON.stringify(WF)},'utf8'));
const row=(wf.requirements||{})[${JSON.stringify(REQ)}]||null;
console.log(JSON.stringify({ what: row && row.copy && row.copy.what, source: row && row.copy && row.copy.source, hist: row && row.copyHistory ? row.copyHistory.length : -1 }));
`], { encoding: 'utf8' });
const freshJson = JSON.parse(fresh);
ok('重启后 copy 仍在（新进程读盘一致）', freshJson.what === '第 23 版' && freshJson.hist === 20, fresh);

// ---------- copy JSON 损坏：视为缺字段但不丢原值（PM 补口径 ③）----------
const brokenWf = readWf();
brokenWf.requirements[REQ].copy = '这不是对象，是被手写坏的 copy';
fs.writeFileSync(WF, JSON.stringify(brokenWf, null, 2) + '\n', 'utf8');
const viewBroken = tt.requirementCopyView(readWf().requirements[REQ]);
ok('copy 损坏 → copyBroken=true 且四块全标缺失', viewBroken.copyBroken === true && viewBroken.copy === null && viewBroken.copyMissing.length === 4, JSON.stringify({ b: viewBroken.copyBroken, n: viewBroken.copyMissing.length }));
const bakBefore = fs.readdirSync(path.dirname(WF)).filter((n) => n.startsWith('工作流.json.bak-')).length;
const rBroken = runJson(['req', 'copy', '--boot', token, '--project', PROJECT, '--requirement', REQ, '--what', '修好的大白话', '--how', 'h', '--impact', 'i', '--advice', 'a']);
const rowBroken = rowOf();
const lastHist = rowBroken.copyHistory[rowBroken.copyHistory.length - 1];
ok('损坏 copy 被修复且原值留档进 copyHistory', rBroken.code === 0 && rowBroken.copy.what === '修好的大白话' && Boolean(lastHist && lastHist.broken === true && String(lastHist.raw).includes('被手写坏的 copy')), JSON.stringify({ code: rBroken.json && rBroken.json.code, last: lastHist && lastHist.raw }));
const bakAfter = fs.readdirSync(path.dirname(WF)).filter((n) => n.startsWith('工作流.json.bak-')).length;
ok('写盘留 .bak（tmp+rename+.bak 口径）', bakAfter > bakBefore, `${bakBefore}→${bakAfter}`);

// ---------- 报告 ----------
const report = { at: new Date().toISOString(), requirement: REQ, pass, fail, failures, results };
const outFile = path.join(REPO, '项目', '工作台改造修复', '_tmp', 'requirement-copy-run.json');
fs.writeFileSync(outFile, JSON.stringify(report, null, 2) + '\n', 'utf8');
console.log(`\n=== R-dba4 工具侧断言：${pass} 通过 / ${fail} 失败 ===`);
for (const f of failures) console.log(`✗ ${f.name}  ${f.detail}`);
console.log(`报告：${outFile}`);
process.exit(fail ? 1 : 0);
