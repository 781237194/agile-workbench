#!/usr/bin/env node
'use strict';
/**
 * 生成器（T-20261118-222610-ea30）：把**最终项目角色卡**转成角色卡模板正文，产出
 * `团队/工具/lib/role-card-bodies.generated.mjs`（scaffold.roleCard 优先使用生成版）。
 *
 * 口径（Owner 2026-11-18 22:01 / 产品 22:22 确认）：
 *   - 项目卡为准；只把「项目名 / 角色显示名 / 团队模式行」抽成占位符；
 *   - 「现行工作流对齐」共享附录由 WORKFLOW_ALIGN_SECTION 统一追加，生成时剥离，避免重复；
 *   - 模板不写项目专有阈值/单号/人名（项目名与角色名之外不做替换，其余文本原样迁移）。
 *
 * 用法：node scripts/gen-role-card-template.cjs product analyst
 *      （参数＝角色 id 列表；输出文件整体重建，只包含传入角色）
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const PROJECT = '工作台改造修复';
const ROLE_DIR = { pm: '项目经理', product: '产品', analyst: '需求分析师', programmer1: '程序员A', programmer2: '程序员B', tester: '测试人员' };
const ROLE_NAME_RE = /^#\s*(.+?)\s*·\s*角色卡\s*$/m;

function stripAlignSection(text) {
  const lines = String(text || '').split(/\r?\n/);
  const out = [];
  let skipLevel = 0;
  for (const line of lines) {
    const m = /^(#{1,6})\s/.exec(line);
    const level = m ? m[1].length : 0;
    if (skipLevel) {
      if (level && level <= skipLevel) skipLevel = 0; else continue;
    }
    if (/^#{1,6}\s*现行工作流对齐/.test(line)) { skipLevel = level || 2; continue; }
    out.push(line);
  }
  return out.join('\n').trimEnd();
}

function escapeTemplate(text) {
  return text
    .replace(/\\/g, '\\\\')
    .replace(/`/g, '\\`')
    .replace(/\$\{/g, '\\${');
}

// 「结构化输出」契约小节（selftest.mjs:233-236 要求分析师卡同时含三样字样；
// 若项目卡缺失则模板补齐，避免新项目复制缺口）。生成后会进入 parity 的临时 pending 清单。
const STRUCTURED_OUTPUT_SECTION = `
## 结构化输出（豆包协议）

- 输出即结果：本角色交付物就是一份结构化 MD，不写开场白、不总结感想；上游内容只写路径 + 版本号，不重复贴入。
- 需求分析交付模板：\`团队/工具/模板/角色产出/01-需求分析-vN.md\`（YAML 头 + 固定区块 + 输出纪律）。
- 他人产出一律用 \`team.mjs brief --role <角色> --project <项目> --section <区块>\` 提取指定区块，禁止全文通读。
`.trimEnd();

// 「子代理」清单小节（selftest.mjs:2251-2256 要求六卡同时含「子代理」「可开」「不可外包」）。
const SUBAGENT_SECTION = `
## 子代理

- **可开**：只读检索、长文摘录、单测草案、构建/静态检查（读 >5 文件或 >32KB 才准开；非 PM 最多 1 个；写入只能 \`_tmp/\`；结束必须 \`subagent end --result <路径> --note "复核结论"\`）。
- **不可外包**：写需求正文、评审结论、提交与回执等本人职责。
- 子代理只回结论 ≤300 字 + 产出路径；本人复核后才算产出。
`.trimEnd();

function ensureSubagentSection(text) {
  if (text.includes('不可外包') && text.includes('可开')) return text;
  return text.trimEnd() + '\n\n' + SUBAGENT_SECTION;
}

function ensureStructuredOutput(text, role) {
  if (role !== 'analyst') return text;
  if (text.includes('01-需求分析-vN.md') && text.includes('team.mjs brief')) return text;
  return text.trimEnd() + '\n\n' + STRUCTURED_OUTPUT_SECTION;
}

function buildBody(role) {
  const dir = ROLE_DIR[role];
  if (!dir) throw new Error('未知角色：' + role);
  const cardPath = path.join(ROOT, '项目', PROJECT, dir, '角色卡.md');
  const raw = fs.readFileSync(cardPath, 'utf8');
  const roleNameMatch = raw.match(ROLE_NAME_RE);
  const roleDisplay = roleNameMatch ? roleNameMatch[1] : '';
  let text = ensureSubagentSection(ensureStructuredOutput(stripAlignSection(raw), role));
  // 先换占位 token，再整体转义，最后把 token 换成真正的模板插值——否则插值会被当成字面量。
  text = text.split(PROJECT).join('__PROJECT_TOKEN__');
  if (roleDisplay) text = text.split(roleDisplay).join('__ROLE_TOKEN__');
  text = text.replace(/^- 团队模式：.*$/m, '- 团队模式：__MODE_TOKEN__');
  let body = escapeTemplate(text);
  body = body.split('__PROJECT_TOKEN__').join('${projectName}')
    .split('__ROLE_TOKEN__').join('${roleName}')
    .split('__MODE_TOKEN__').join('${modeDetail}');
  return `  ${role}: (projectName, roleName, modeDetail, fast) => \`${body}\`,\n`;
}

function main() {
  const roles = process.argv.slice(2).filter(Boolean);
  if (!roles.length) { console.error('用法：node scripts/gen-role-card-template.cjs <role> [role...]'); process.exit(2); }
  // 上线前风险收敛（Owner 2026-11-18 22:51）：生成内容**内联进 scaffold.mjs** 的标记块，
  // 不再产出独立 .mjs（避免发版漏文件导致 import 失败、整个团队工具起不来）。
  const targetPath = path.join(ROOT, '团队', '工具', 'lib', 'scaffold.mjs');
  const BEGIN = '// === GENERATED_ROLE_CARDS_BEGIN（由 scripts/gen-role-card-template.cjs 生成，勿手改）===';
  const END = '// === GENERATED_ROLE_CARDS_END ===';
  const src = fs.readFileSync(targetPath, 'utf8');
  const i = src.indexOf(BEGIN);
  const j = src.indexOf(END);
  if (i < 0 || j < 0 || j < i) { console.error('SCAFFOLD_MARKERS_MISSING：scaffold.mjs 缺少生成标记块'); process.exit(3); }
  let block = `${BEGIN}\n`
    + `// 自动生成，勿手改：node scripts/gen-role-card-template.cjs ${roles.join(' ')}\n`
    + '// 来源＝项目最终角色卡（项目名/角色名/团队模式行已占位符化；「现行工作流对齐」附录由 WORKFLOW_ALIGN_SECTION 统一追加）。\n'
    + 'const GENERATED_ROLE_CARDS = {\n';
  for (const role of roles) block += buildBody(role);
  block += '};\n';
  const out = src.slice(0, i) + block + src.slice(j);
  fs.writeFileSync(targetPath, out, 'utf8');
  console.log('GENERATED ' + roles.join(',') + ' → ' + path.relative(ROOT, targetPath) + ' blockBytes=' + Buffer.byteLength(block));
}

main();
