'use strict';
/** R-e717 AC3 回归：scaffold 模板 4 项（拒绝码清单 / 提示语带去处 / 文案人话规则 / 自带回归入口）。 */
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const ROOT = path.resolve(__dirname, '..');
const results = [];
function check(name, ok, detail) {
  results.push({ name, ok, detail: ok ? '' : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 240)}`);
  if (!ok) process.exitCode = 1;
}
const CODES = ['DECISION_SCOPE_FORBIDDEN', 'DECISION_REVIEW_ACTION_FORBIDDEN', 'DECISION_COPY_CODE_NAME'];
const ROUTES = ['#accept-list'];
const ENTRY = 'test-decision-scope.cjs';

(async () => {
  const mod = await import('file:///' + path.join(ROOT, '团队', '工具', 'lib', 'scaffold.mjs').replace(/\\/g, '/'));
  const card = mod.roleCard('模板沙盘', 'pm', 'full');
  const info = mod.projectInfo('模板沙盘', '', 'full');

  check('① 角色卡含三个拒绝码', CODES.every((c) => card.includes(c)), CODES.filter((c) => !card.includes(c)));
  check('① 项目信息含三个拒绝码', CODES.every((c) => info.includes(c)), CODES.filter((c) => !info.includes(c)));
  check('② 提示语带去处（评审列表/验收列表 #accept-list）', card.includes('评审列表') && card.includes('#accept-list') && info.includes('#accept-list'), { card: card.includes('#accept-list'), info: info.includes('#accept-list') });
  check('② 评审弹窗去处写清（点通过/打回）', /评审弹窗/.test(card) && /通过\/打回/.test(card), '');
  check('③ 文案人话规则（字数 + 不用代号 + 代号只放 source-ref）', card.includes('文案人话规则') && card.includes('≤40 字') && card.includes('--source-ref'), '');
  check('④ 模板自带回归入口', card.includes(ENTRY) && info.includes(ENTRY), '');

  // 生成文件校验：ensureProjectStructure 落盘后，角色卡与项目信息都带这 4 项
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'e717-tpl-'));
  try {
    mod.ensureProjectStructure({ name: '模板校验', root: tmp, desc: '', overwrite: true, teamMode: 'full' });
    const cardFile = path.join(tmp, '项目经理', '角色卡.md');
    const infoFile = path.join(tmp, '项目信息.md');
    const cardText = fs.existsSync(cardFile) ? fs.readFileSync(cardFile, 'utf8') : '';
    const infoText = fs.existsSync(infoFile) ? fs.readFileSync(infoFile, 'utf8') : '';
    check('⑤ 落盘角色卡含拒绝码与回归入口', CODES.every((c) => cardText.includes(c)) && cardText.includes(ENTRY), { len: cardText.length });
    check('⑤ 落盘项目信息含拒绝码与回归入口', CODES.every((c) => infoText.includes(c)) && infoText.includes(ENTRY), { len: infoText.length });
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }

  const passed = results.filter((r) => r.ok).length;
  const failed = results.filter((r) => !r.ok).length;
  console.log(`\nR-e717 AC3 断言：${passed}/${results.length} PASS${failed ? `，${failed} FAIL` : ''}`);
})();
