#!/usr/bin/env node
'use strict';
/**
 * 生成器（T-20261118-222610-ea30）：把**最终项目角色卡**转成角色卡模板正文，产出
 * `团队/工具/lib/scaffold.mjs` 里 `GENERATED_ROLE_CARDS` 标记块（`scaffold.roleCard()` 优先用它，
 * 缺该角色时才回退到同文件的 `ROLE_CARD_BODIES` 手写模板）。
 * （2026-11-19 口径更正：不再产出独立 `role-card-bodies.generated.mjs`——该文件并不存在，生成内容一律内联。）
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

// 「场景覆盖准则」小节（Owner 2026-11-19 强制；与 scaffold.mjs → sceneCoverageSection 同一口径）。
// 六卡必须都带本节：生成的卡（product/analyst）在这里补，手写卡（pm/programmer1/programmer2/tester）在 scaffold 里插。
const SCENE_COVERAGE_SHARED = [
  '## H. 场景覆盖准则（Owner 2026-11-19 强制 · 详见 团队/流程.md §H）',
  '',
  '- **五种「假完成」一律算未完成**：①空壳入口（按钮/菜单/命令存在但没有真执行链）②只做正向（失败/超时/回滚/重试没实现）③只测函数（夹具只调内部函数，没走真实入口）④只写日志（用户看不到状态变化，错误只进 stderr）⑤只改当前态（重启/重开/换机就丢）。',
  '- **交互入口必须交付「全链路六段」**：触发 → 执行 → 进度/等待可见 → 成功态 → 失败态（人话 + 错误码 + 下一步）→ 重试/回滚/手动兜底。缺任一段必须在实现说明里写「未覆盖 + 原因 + 计划」，**不得自评完成**，也不得留给 tester 去找。',
  '- **场景矩阵六类**（开发前写、开发后自测、交付时附证据）：①首次使用（干净环境/无配置）②正常路径 ③空值/边界（0 条、超长、空串、错误类型）④越权/异常（无权限、令牌失效、文件只读、网络失败）⑤并发/重复（连点、并发写、重复提交）⑥降级/恢复（依赖缺失、服务不可用、回滚后可用）。交付物必须含一张「场景 × 结果 × 证据路径」表；缺失项写「未覆盖」，**禁止留空**。',
  '- **反例锚点（Owner 原话）**：「检查更新能用」≠「点立即升级能真下载→校验→安装→回滚」；只做按钮 = 空壳，属缺陷。代码类交付的「可用」＝**真实入口点得动 + 失败看得见 + 重开还在**，三者缺一即未完成。',
];
const SCENE_COVERAGE_PER_ROLE = {
  pm: '- **PM 送审前自查**：派单正文带「场景 × 结果 × 证据路径」要求；送 Owner 的验收材料缺场景表或缺链段说明的，不得送。',
  product: '- **产品 RR 逐条核场景覆盖**：缺场景表、或只有正向描述的**直接打回**；评审意见必须点名缺哪一类场景（六类之一）。',
  analyst: '- **需求正文必须含「场景表」**：入口 / 正常 / 空值 / 失败 / 并发 / 降级六行，写清用户从哪儿点进来、看到什么；只写功能名词的 AC 不合格。',
  programmer1: '- **开发交付自查三问**：入口点得动（真实按钮/IPC/CLI，不是只调函数）？失败看得见（人话 + 错误码 + 下一步）？重开还在（已落盘）？三缺一不得自评完成。',
  programmer2: '- **开发交付自查三问**：入口点得动（真实按钮/IPC/CLI，不是只调函数）？失败看得见（人话 + 错误码 + 下一步）？重开还在（已落盘）？三缺一不得自评完成。',
  tester: '- **TR-Q 把场景矩阵转成可执行断言**，并标注哪些场景本期不测（写明理由）；只测正向的测试报告不算通过。',
};
function sceneCoverageText(role) {
  return [...SCENE_COVERAGE_SHARED, SCENE_COVERAGE_PER_ROLE[role] || ''].filter(Boolean).join('\n');
}
function ensureSceneCoverage(text, role) {
  // 判据用**实质要点**而不是「场景覆盖准则」五个字：项目卡可能只提到该词（如 analyst 卡里的一句引用），
  // 若只按标题词判断会跳过补全 → 生成的卡缺「全链路六段/场景矩阵六类/五种假完成」。
  if (text.includes('全链路六段') && text.includes('场景矩阵六类') && text.includes('五种「假完成」')) return text;
  return text.trimEnd() + '\n\n' + sceneCoverageText(role);
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
  // Owner 2026-11-19 强制：六卡都必须含「场景覆盖准则」；项目卡没写就在这里补（按角色差异化）。
  text = ensureSceneCoverage(text, role);
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
