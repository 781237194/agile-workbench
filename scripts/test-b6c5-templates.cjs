'use strict';
/**
 * B-20261117-142519-b6c5 静态自检（b867 剩余部分：a163 AC8 模板补齐）
 *
 * 覆盖：
 *   T1 01/02/03/04 四份角色产出模板都含「AC 引用行」+ 正文头 version/change 两字段；
 *   T2 四份模板结构未被破坏（brief.checkDocStructure：YAML 必填键 + 全部固定区块 + ≤16KB）；
 *   T3 四份模板仍带输出纪律三句（与团队 selftest 的模板断言同口径，防「加字段顺手删纪律」）；
 *   T4 a163 AC8 的派单模板（dispatch.buildDispatchPrompt）含 AC 引用行 + version/change；
 *   T5 a163 AC8 的回执模板（dispatch.buildNoticePrompt → wake-text.cjs）含 AC 引用行 + version/change；
 *   T6 评审模板 团队/模板/评审.md 含 AC 引用行 + version/change（b867 四类模板之一）；
 *   T7 新项目生成物：六角色卡都指向更新后的模板文件（scaffold.roleCard，避免「模板改了卡还指旧文案」）。
 *
 * 跑法：node scripts/test-b6c5-templates.cjs
 * 注：不改历史产出，只校验模板与生成器文本。
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, '团队', '工具', 'lib');
const TPL_DIR = path.join(ROOT, '团队', '工具', '模板', '角色产出');
const TPL_NAMES = ['01-需求分析-vN.md', '02-产品设计-vN.md', '03-架构设计-vN.md', '04-测试报告-vN.md'];
const AC_LINE = 'AC 引用：见需求正文 §验收标准（写清路径 + sha256）';
const VC_LINE = 'version/change 指回需求正文当前版本';

const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail: detail || '' });
    console.log(`PASS  ${name}${detail ? '  ' + detail : ''}`);
  } catch (e) {
    results.push({ name, ok: false, error: String((e && e.message) || e) });
    console.log(`FAIL  ${name}\n      ${String((e && e.message) || e).split('\n')[0]}`);
  }
}
const assert = require('node:assert');

(async () => {
  const brief = await import(pathToFileURL(path.join(LIB, 'brief.mjs')).href);
  const roles = await import(pathToFileURL(path.join(LIB, 'roles.mjs')).href);
  const dispatch = await import(pathToFileURL(path.join(LIB, 'dispatch.mjs')).href);
  const scaffold = await import(pathToFileURL(path.join(LIB, 'scaffold.mjs')).href);

  const textOf = (name) => fs.readFileSync(path.join(TPL_DIR, name), 'utf8').replace(/^\uFEFF/, '');
  const frontMatter = (text) => {
    const m = /^---[ \t]*\r?\n([\s\S]*?)\r?\n---/.exec(text);
    assert.ok(m, '缺 YAML 头');
    const meta = {};
    for (const line of m[1].split(/\r?\n/)) {
      const kv = /^([A-Za-z_][\w-]*):[ \t]*(.*)$/.exec(line);
      if (kv) meta[kv[1]] = kv[2].trim();
    }
    return meta;
  };

  check('T1 01/02/03/04 模板均含 AC 引用行', () => {
    for (const name of TPL_NAMES) {
      const t = textOf(name);
      assert.ok(t.includes(AC_LINE), `${name} 缺 AC 引用行`);
    }
    return `${TPL_NAMES.length}/${TPL_NAMES.length}`;
  });

  check('T1b 01/02/03/04 模板正文头均有 version + change 两字段', () => {
    for (const name of TPL_NAMES) {
      const meta = frontMatter(textOf(name));
      assert.ok(/^v(N|\d+)$/i.test(String(meta.version || '')), `${name} version 不是 vN/v<数字>`);
      assert.ok(String(meta.change || '').length >= 4, `${name} 缺 change 字段`);
    }
    return TPL_NAMES.map((n) => frontMatter(textOf(n)).change.slice(0, 6)).join(' / ');
  });

  check('T1c 模板写明「不升版判 VERSION_NOT_BUMPED」口径（与角色卡/证据门同码）', () => {
    for (const name of TPL_NAMES) {
      assert.ok(/VERSION_NOT_BUMPED/.test(frontMatter(textOf(name)).change || ''), `${name} change 字段缺 VERSION_NOT_BUMPED 口径`);
    }
    return '4/4';
  });

  check('T2 四份模板结构未破坏（checkDocStructure：YAML 必填键 + 固定区块 + ≤16KB）', () => {
    for (const name of TPL_NAMES) {
      const code = name.slice(0, 2);
      const spec = Object.values(roles.OUTPUT_DOCS).find((s) => s.code === code);
      assert.ok(spec, `OUTPUT_DOCS 缺 code=${code}`);
      const c = brief.checkDocStructure(textOf(name), spec);
      assert.ok(c.ok, `${name} 结构问题：${c.problems.join('；')}`);
    }
    return '4/4';
  });

  check('T3 四份模板仍带输出纪律三句（输出即结果/超过上限即停止/禁止重复输入）', () => {
    for (const name of TPL_NAMES) {
      const t = textOf(name);
      for (const k of ['输出即结果', '超过上限即停止', '禁止重复输入']) {
        assert.ok(t.includes(k), `${name} 缺「${k}」`);
      }
    }
    return '4/4';
  });

  check('T3b 模板不复制需求正文 AC 四段式（只留引用行，防「模板里再抄一遍 AC」）', () => {
    for (const name of TPL_NAMES) {
      const t = textOf(name);
      assert.ok(t.includes(VC_LINE), `${name} 缺 version/change 指回口径`);
      assert.ok(!/这是什么\s*[／/]\s*怎么做\s*[／/]\s*卡在哪\s*[／/]\s*怎么判通过/.test(t), `${name} 把 AC 四段式抄进模板`);
    }
    return '4/4';
  });

  check('T4 a163 AC8 派单模板（buildDispatchPrompt）含 AC 引用 + version/change', () => {
    const out = dispatch.buildDispatchPrompt({
      to: 'programmer1', project: '沙盘', projectPath: path.join(ROOT, '项目', '沙盘'),
      roleDir: '程序员A', messageId: 'M-x', subject: '测试派单', taskId: 'T-x', taskTitle: '示例', teamTool: 'team.mjs',
    });
    assert.ok(out.includes(AC_LINE), '派单模板缺 AC 引用行（写清路径 + sha256）');
    assert.ok(out.includes(VC_LINE), '派单模板缺 version/change 指回口径');
    assert.ok(out.includes('已回执 ≠ 已完成') || out.includes('只 ack 不算完成'), '派单模板缺「已回执≠已完成」判据（AC8 字段齐全）');
    return `${out.length}B`;
  });

  check('T5 a163 AC8 回执模板（buildNoticePrompt / wake-text.cjs）含 AC 引用 + version/change', () => {
    const out = dispatch.buildNoticePrompt({
      to: 'pm', project: '沙盘', projectPath: path.join(ROOT, '项目', '沙盘'),
      messageId: 'M-x', subject: '完成回执', from: 'programmer1', teamTool: 'team.mjs', body: '已完成 T-x',
    });
    assert.ok(out.includes(AC_LINE), '回执模板缺 AC 引用行');
    assert.ok(out.includes(VC_LINE), '回执模板缺 version/change 指回口径');
    return `${out.length}B`;
  });

  check('T6 评审模板 团队/模板/评审.md 含 AC 引用 + version/change', () => {
    const t = fs.readFileSync(path.join(ROOT, '团队', '模板', '评审.md'), 'utf8');
    assert.ok(t.includes(AC_LINE), '评审模板缺 AC 引用行');
    assert.ok(t.includes(VC_LINE), '评审模板缺 version/change 指回口径');
    return `${Buffer.byteLength(t, 'utf8')}B`;
  });

  check('T7 新项目生成物：六角色卡都指向「模板/角色产出/0X-…-vN.md」', () => {
    const map = { analyst: '01-需求分析-vN.md', product: '02-产品设计-vN.md', programmer1: '03-架构设计-vN.md', tester: '04-测试报告-vN.md' };
    for (const [role, file] of Object.entries(map)) {
      const card = scaffold.roleCard('沙盘', role, 'full');
      assert.ok(String(card).includes(file), `${role} 角色卡没指向 ${file}`);
    }
    return '4/4';
  });

  fs.rmSync(path.join(ROOT, '_tmp', 'b6c5-tpl'), { recursive: true, force: true });
  const pass = results.filter((r) => r.ok).length;
  const red = results.length - pass;
  const outEnv = process.env.AWB_B6C5_OUT || path.join('_tmp', 'run-b6c5.json');
  // 绝对路径直接用；相对路径按仓库根解析（env 传绝对路径时 path.join 会拼成「仓库根 + 盘符绝对路径」这种坏路径）。
  const outFile = path.isAbsolute(outEnv) ? outEnv : path.join(ROOT, outEnv);
  fs.mkdirSync(path.dirname(outFile), { recursive: true });
  fs.writeFileSync(outFile, JSON.stringify({ task: 'B-20261117-142519-b6c5', at: new Date().toISOString(), total: results.length, pass, red, results }, null, 2) + '\n', 'utf8');
  console.log(`\nB6C5_TEMPLATES ${JSON.stringify({ total: results.length, pass, red })}`);
  console.log('证据：' + outFile);
  if (red) process.exit(1);
})().catch((e) => {
  console.error('B6C5_TEMPLATES_FAILED ' + String((e && e.stack) || e));
  process.exit(1);
});
