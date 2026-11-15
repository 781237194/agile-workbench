#!/usr/bin/env node
'use strict';
/**
 * T-20261115-131639-3999 · R-dba4 数据层断言（大白话 copy 持久化）
 *
 * 覆盖任务 detail 五条：
 *   D1 copy 字段白名单 + 元信息（what/how/impact/advice/at/by/source）
 *   D2 derived = 写入时快照：首次写 → 正文改后再次派生写**不覆盖**（SNAPSHOT_FROZEN）
 *   D3 刷新草案（refresh=true）才更新，并把旧值推进 copyHistory
 *   D4 copyHistory 保留历史、上限 20 条（先进先出），重评/重启不清空（纯逻辑不依赖进程）
 *   D5 缺字段如实标注（filledBy=fallback / none），数据层不伪造
 *   D6 作者写（source=author）优先，派生写不得覆盖作者写（AUTHOR_WINS）；幂等写不重复进历史
 *
 * 跑法：node scripts/test-review-copy.cjs
 */
const RC = require('../src/review-copy.js');

let passed = 0;
const failures = [];
function check(id, name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${id}  ${name}`); return; }
  failures.push({ id, name, detail });
  console.log(`FAIL  ${id}  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 400)}`);
}
const copyOf = (what, extra) => ({
  what, how: `怎么做：${what}`, impact: '影响：测试与开发', advice: '建议：通过',
  ...(extra || {})
});

/* D1 白名单 + 元信息 */
{
  const norm = RC.normalizeCopy({ what: '  一句话说明  ', how: 'h', impact: 'i', advice: 'a', 乱写: 'x', source: 'derived' }, { at: '2026-11-15T06:00:00.000Z', by: 'programmer1' });
  check('D1-01', '四段字段 + at/by/source 都在', ['what', 'how', 'impact', 'advice', 'at', 'by', 'source'].every((k) => k in norm), norm);
  check('D1-02', '非白名单字段被丢掉（数据层不塞私货）', !('乱写' in norm), Object.keys(norm));
  check('D1-03', '文本归一：去首尾空白、压缩连续空白', norm.what === '一句话说明', norm.what);
  check('D1-04', 'source 只认 author / derived，其它值回落 derived', RC.normalizeCopy({ what: 'x', source: 'xxx' }).source === 'derived');
  check('D1-05', '超长字段截到 400 字（防刷爆 store）', RC.normalizeCopy({ what: 'x'.repeat(600) }).what.length === RC.MAX_FIELD_LEN);
}

/* D2/D3 快照语义 */
{
  const first = RC.decideSave(null, copyOf('初稿'), { at: '2026-11-15T06:00:00.000Z', by: 'programmer1' });
  check('D2-01', '首次派生写落盘（FIRST_SNAPSHOT + changed）', first.changed === true && first.reason === 'FIRST_SNAPSHOT', first.reason);
  check('D2-02', 'copy 带 at/by/source=derived', first.record.copy.at === '2026-11-15T06:00:00.000Z' && first.record.copy.by === 'programmer1' && first.record.copy.source === 'derived', first.record.copy);

  // 正文改了：渲染层又算出一份新文案，但没点「刷新草案」→ 必须保持旧快照
  const afterEdit = RC.decideSave(first.record, copyOf('正文改过后的新说明'), { at: '2026-11-15T07:00:00.000Z' });
  check('D2-03', '正文改动后再次派生写不覆盖（SNAPSHOT_FROZEN、changed=false）', afterEdit.changed === false && afterEdit.reason === 'SNAPSHOT_FROZEN', afterEdit.reason);
  check('D2-04', 'copy 仍是初稿（重启/重评也读它）', afterEdit.record.copy.what === '初稿', afterEdit.record.copy.what);

  // 刷新草案
  const refreshed = RC.decideSave(first.record, copyOf('刷新后的说明'), { at: '2026-11-15T07:10:00.000Z', refresh: true });
  check('D3-01', 'refresh=true 才更新（REFRESH_DERIVED + changed）', refreshed.changed === true && refreshed.reason === 'REFRESH_DERIVED', refreshed.reason);
  check('D3-02', '旧值进 copyHistory（带 replacedAt）', refreshed.record.copyHistory.length === 1 && refreshed.record.copyHistory[0].what === '初稿' && Boolean(refreshed.record.copyHistory[0].replacedAt), refreshed.record.copyHistory);

  // 幂等
  const again = RC.decideSave(refreshed.record, copyOf('刷新后的说明'), { at: '2026-11-15T07:20:00.000Z', refresh: true });
  check('D3-03', '同内容再刷新是幂等（IDEMPOTENT，不重复进历史）', again.changed === false && again.reason === 'IDEMPOTENT' && again.record.copyHistory.length === 1, again.reason);
}

/* D4 历史上限 */
{
  let record = RC.decideSave(null, copyOf('v1'), { at: '2026-11-15T06:00:00.000Z' }).record;
  for (let i = 2; i <= 26; i += 1) {
    record = RC.decideSave(record, copyOf(`v${i}`), { at: `2026-11-15T06:${String(i).padStart(2, '0')}:00.000Z`, refresh: true }).record;
  }
  check('D4-01', `copyHistory 上限 ${RC.HISTORY_LIMIT} 条（先进先出）`, record.copyHistory.length === RC.HISTORY_LIMIT, { len: record.copyHistory.length });
  check('D4-02', '最新 copy 是末次刷新值', record.copy.what === 'v26', record.copy.what);
  check('D4-03', '历史里保留的是最近的值（最老的被挤出）', record.copyHistory[record.copyHistory.length - 1].what === 'v25', record.copyHistory[record.copyHistory.length - 1].what);
}

/* D5 缺字段如实标注 */
{
  const miss = RC.missingFields({ what: '有', how: '', impact: '', advice: '' }, { what: '兜底', how: '正文怎么做的', impact: '', advice: '' });
  check('D5-01', '缺且有兜底 → filledBy=fallback', miss.some((m) => m.field === 'how' && m.filledBy === 'fallback'), miss);
  check('D5-02', '缺且无兜底 → filledBy=none（不伪造）', miss.some((m) => m.field === 'impact' && m.filledBy === 'none' && m.value === ''), miss);
  check('D5-03', '有的字段不报缺', !miss.some((m) => m.field === 'what'), miss);
}

/* D6 作者优先 / 应用落盘 */
{
  const author = RC.decideSave(null, copyOf('作者手写', { source: 'author' }), { at: '2026-11-15T06:00:00.000Z', by: 'pm' });
  const derivedTry = RC.decideSave(author.record, copyOf('派生想覆盖'), { at: '2026-11-15T06:30:00.000Z' });
  check('D6-01', '派生写不得覆盖作者写（AUTHOR_WINS）', derivedTry.changed === false && derivedTry.reason === 'AUTHOR_WINS', derivedTry.reason);
  check('D6-02', '作者写 source=author 保留', author.record.copy.source === 'author', { source: author.record.copy.source });

  const project = { id: 'p1' };
  const ok = RC.applySave(project, 'R-20261115-125659-dba4', derivedTry, '2026-11-15T06:30:00.000Z');
  check('D6-03', 'applySave 写进 projects[].reviewCopy.rows[需求id]', ok === true
    && project.reviewCopy.rows['R-20261115-125659-dba4'].copy.what === '作者手写', project.reviewCopy && Object.keys(project.reviewCopy.rows || {}));
  check('D6-04', 'recordOf 能读回来（重启后仍是大白话）', RC.recordOf(project, 'R-20261115-125659-dba4').copy.what === '作者手写');
  check('D6-05', 'recordOf 对不存在的需求给空壳，不写盘', RC.recordOf(project, 'R-不存在').copy === null);
  check('D6-06', '空内容写不落盘（EMPTY_COPY）', RC.decideSave(null, { what: '', how: '', impact: '', advice: '' }, {}).changed === false);
}

console.log(`\nR-dba4 数据层断言：${passed}/${passed + failures.length} PASS`);
if (failures.length) {
  console.error(JSON.stringify(failures, null, 2));
  process.exit(1);
}
