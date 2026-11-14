'use strict';
/**
 * R-9db6 AC4（T-20261114-130838-5dfc）决策箱「回执 PM」后端断言。
 *
 * 跑法：node scripts/test-decision-ack.cjs
 * 隔离：复制 团队/ 到 _tmp/decision-ack-sandbox，TEAM_ROOT/TEAM_PROJECTS_ROOT 指向沙盘，
 *       TEAM_SELFTEST=1（唤醒只留痕、不发网络请求），不碰真实 团队/ 与 项目/。
 *
 * 断言：① 单条回执落账 + PM 消息 + 唤醒；② 重复提交幂等且不新增消息；
 *       ③ 批量 3 条各自落账、只发 1 条汇总；④ 重复/非法选择整批拒绝且零副作用；⑤ 同批 id 重复拒绝。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const TEAM_SRC = path.join(ROOT, '团队');
const SB = path.join(ROOT, '_tmp', 'decision-ack-sandbox');
const TEAM_ROOT = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TEAM_TOOL = path.join(TEAM_ROOT, '工具', 'team.mjs');
const IPC_TOOL = path.join(TEAM_ROOT, '工具', 'decision-ack-ipc.mjs');
const PROJECT = '决策回执沙盘';

const env = { ...process.env, TEAM_ROOT, TEAM_PROJECTS_ROOT: PROJECTS, TEAM_SELFTEST: '1' };
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + JSON.stringify(detail).slice(0, 300)}`);
  if (!ok) process.exitCode = 1;
}
function run(args) {
  const out = execFileSync(process.execPath, [TEAM_TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
  const text = String(out).trim();
  return JSON.parse(text.slice(text.indexOf('{')));
}
function ipcRaw(payload) {
  try {
    const out = execFileSync(process.execPath, [IPC_TOOL, PROJECT, JSON.stringify(payload)], { cwd: SB, env, encoding: 'utf8' });
    return JSON.parse(String(out).trim().slice(0, String(out).trim().lastIndexOf('}') + 1));
  } catch (e) {
    const stdout = String((e && e.stdout) || '').trim();
    if (stdout) {
      try { return JSON.parse(stdout.slice(stdout.indexOf('{'))); } catch { /* fallthrough */ }
    }
    throw e;
  }
}
const sha = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const wakeRows = () => {
  const file = path.join(TEAM_ROOT, '状态', '项目', PROJECT, '唤醒.jsonl');
  return fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean) : [];
};
const pmMessages = () => {
  const dir = path.join(TEAM_ROOT, '状态', '邮箱', 'pm', 'new');
  const curDir = path.join(TEAM_ROOT, '状态', '邮箱', 'pm', 'cur');
  const rows = [];
  for (const d of [dir, curDir]) {
    if (!fs.existsSync(d)) continue;
    for (const name of fs.readdirSync(d)) {
      if (!name.endsWith('.json')) continue;
      try { rows.push(JSON.parse(fs.readFileSync(path.join(d, name), 'utf8'))); } catch { /* skip */ }
    }
  }
  return rows.filter((row) => row.type === 'owner_decision_receipt');
};

// ---------- 沙盘 ----------
fs.rmSync(SB, { recursive: true, force: true });
fs.mkdirSync(PROJECTS, { recursive: true });
fs.cpSync(TEAM_SRC, TEAM_ROOT, { recursive: true });

run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
const pm = run(['boot', '--role', 'pm', '--project', PROJECT, '--session', 'sbx-pm', '--json']);
const addItem = (n, source) => run([
  'decision', 'add', '--boot', pm.token, '--project', PROJECT,
  '--title', `待决 ${n}`, '--summary', `摘要 ${n}`, '--question', `问题 ${n}？`,
  '--options', '通过,打回,其他', '--source-kind', source, '--source-ref', `M-沙盘-${n}`, '--json',
]).item;
const items = [1, 2, 3, 4, 5, 6].map((n) => addItem(n, 'message'));
const boxFile = path.join(TEAM_ROOT, '状态', '项目', PROJECT, '决策箱.json');
const readBox = () => JSON.parse(fs.readFileSync(boxFile, 'utf8'));
console.log(`沙盘就绪：${SB}（6 条待决）`);

// ---------- ① 单条 ----------
const wakeBefore1 = wakeRows().length;
const msgBefore1 = pmMessages().length;
const single = ipcRaw({ items: [{ id: items[0].id, choice: '通过', opinion: '按方案做' }] });
check('① 单条回执 ok 且 batch=false', single.ok === true && single.batch === false, single);
const box1 = readBox().items.find((row) => row.id === items[0].id);
check('① 条目落账：status=answered、receipt 五字段、receiptSeq=1',
  box1.status === 'answered' && box1.receipt && box1.receipt.messageId && box1.receipt.at
  && box1.receipt.choice === '通过' && box1.receipt.opinion === '按方案做' && box1.receiptSeq === 1, box1);
check('① 审计字段：decidedBy=owner / channel=ui / source / at',
  box1.decision && box1.decision.decidedBy === 'owner' && box1.decision.channel === 'ui'
  && box1.decision.source === 'decision_box_ack' && box1.decision.at, box1.decision);
check('① readAt / answeredAt 都写了', Boolean(box1.readAt) && Boolean(box1.answeredAt), { readAt: box1.readAt, answeredAt: box1.answeredAt });
const pm1 = pmMessages();
check('① PM 收到 1 条 owner_decision_receipt', pm1.length === msgBefore1 + 1, { before: msgBefore1, after: pm1.length });
const wake1 = wakeRows();
check('① 回执消息唤醒了 PM（唤醒.jsonl 新增且 messageIds 命中）',
  wake1.length === wakeBefore1 + 1 && wake1.some((row) => String(row.to) === 'pm' && (row.messageIds || []).includes(box1.receipt.messageId)),
  { before: wakeBefore1, after: wake1.length });

// ---------- ② 重复提交幂等 ----------
const msgBefore2 = pmMessages().length;
const dup = ipcRaw({ items: [{ id: items[0].id, choice: '通过', opinion: '再来一次' }] });
check('② 重复提交返回 idempotent=true', dup.ok === true && dup.results[0].idempotent === true, dup.results);
check('② 重复提交不再发消息', pmMessages().length === msgBefore2, { before: msgBefore2, after: pmMessages().length });

// ---------- ③ 批量 3 条 ----------
const msgBefore3 = pmMessages().length;
const batch = ipcRaw({ items: [
  { id: items[1].id, choice: '通过', opinion: '批1' },
  { id: items[2].id, choice: '打回', opinion: '批2' },
  { id: items[3].id, choice: '其他', opinion: '' },
] });
check('③ 批量 ok 且 batch=true', batch.ok === true && batch.batch === true, batch);
check('③ 3 条都 answered、receiptSeq 递增 2/3/4',
  batch.results.length === 3 && batch.results.every((row) => row.status === 'answered')
  && batch.results.map((row) => row.receiptSeq).join(',') === '2,3,4', batch.results);
const box3 = readBox();
check('③ 箱里 4 条 answered、meta.receiptSeq=4',
  box3.items.filter((row) => row.status === 'answered').length === 4 && Number(box3.meta.receiptSeq) === 4,
  { answered: box3.items.filter((row) => row.status === 'answered').length, seq: box3.meta.receiptSeq });
check('③ 批量只发 1 条汇总消息', pmMessages().length === msgBefore3 + 1, { before: msgBefore3, after: pmMessages().length });

// ---------- ④ 重复批量 / 非法选择：整批拒绝、零副作用 ----------
const snapshotA = sha(boxFile);
const msgBefore4 = pmMessages().length;
const dupBatch = ipcRaw({ items: [{ id: items[1].id, choice: '通过' }, { id: items[4].id, choice: '通过' }] });
check('④ 批量里含已回执条目 → DECISION_ALREADY_ANSWERED', dupBatch.ok === false && dupBatch.code === 'DECISION_ALREADY_ANSWERED', dupBatch);
const badChoice = ipcRaw({ items: [{ id: items[4].id, choice: '不存在的选项' }, { id: items[5].id, choice: '通过' }] });
check('④ 非法选择 → DECISION_CHOICE_INVALID', badChoice.ok === false && badChoice.code === 'DECISION_CHOICE_INVALID', badChoice);
const dupId = ipcRaw({ items: [{ id: items[4].id, choice: '通过' }, { id: items[4].id, choice: '打回' }] });
check('④ 同批 id 重复 → DECISION_ID_DUPLICATE', dupId.ok === false && dupId.code === 'DECISION_ID_DUPLICATE', dupId);
const missing = ipcRaw({ items: [{ id: 'D-20200101-000000-dead', choice: '通过' }] });
check('④ 不存在的 id → DECISION_NOT_FOUND', missing.ok === false && missing.code === 'DECISION_NOT_FOUND', missing);
check('④ 失败零副作用：箱文件哈希不变、PM 无新消息',
  sha(boxFile) === snapshotA && pmMessages().length === msgBefore4, { sameHash: sha(boxFile) === snapshotA, msgBefore4, after: pmMessages().length });

// ---------- ⑤ 汇总 ----------
const passed = results.filter((row) => row.ok).length;
const failed = results.filter((row) => !row.ok).length;
console.log(`\n决策箱回执断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
fs.writeFileSync(path.join(SB, 'run-decision-ack.json'), JSON.stringify({ at: new Date().toISOString(), project: PROJECT, passed, failed, results }, null, 2) + '\n', 'utf8');
if (failed) process.exitCode = 1;
