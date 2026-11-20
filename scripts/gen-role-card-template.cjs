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

function escapeRe(s) { return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&'); }

/**
 * 处理项目卡里的 `<!-- rolecard-standard:<key>:begin/end -->` 块（rolecard sync 的产物）：
 * - **重复块整块丢弃**：PM 对已手写「场景覆盖准则」的卡跑 sync 时，会多出一份 `scene-coverage~2` 标准块，
 *   内容与手写节重复；原样搬进模板会让新项目卡里出现两份场景覆盖。
 * - 其余块**解包保留正文**（标记本身不进模板）。
 */
function stripSyncBlocks(text) {
  const src = String(text || '');
  // 逐个 begin 找同 key 的 end（不用回溯引用：反斜杠数字会和前面的字母连起来，
  // 被净树 selftest 的「Windows 盘符路径」检查误判成一个盘符路径）。
  const BEGIN = /<!--\s*rolecard-standard:([A-Za-z0-9_~-]+):begin\s*-->/g;
  const blocks = [];
  let m;
  while ((m = BEGIN.exec(src)) !== null) {
    const key = m[1];
    const endRe = new RegExp('<!--\\s*rolecard-standard:' + key + ':end\\s*-->', 'g');
    endRe.lastIndex = m.index + m[0].length;
    const e = endRe.exec(src);
    if (!e) continue; // 未闭合：保持原样
    blocks.push({
      key,
      full: src.slice(m.index, e.index + e[0].length),
      body: src.slice(m.index + m[0].length, e.index),
      index: m.index,
    });
    BEGIN.lastIndex = e.index + e[0].length;
  }
  if (!blocks.length) return src;
  const restText = blocks.reduce((acc, b) => acc.replace(b.full, ''), src);
  let out = '';
  let cursor = 0;
  for (const b of blocks) {
    out += src.slice(cursor, b.index);
    const heading = (String(b.body).match(/^##\s+(.+?)\s*$/m) || [])[1] || '';
    const dup = Boolean(heading) && new RegExp('^##\\s+' + escapeRe(heading) + '\\s*$', 'm').test(restText);
    out += dup ? '' : b.body;
    cursor = b.index + b.full.length;
  }
  out += src.slice(cursor);
  return out;
}

/**
 * 摘掉残留的「同步账本标记」行：`<!-- rolecard-standard:<key>:begin/end -->`、`<!-- rolecard-section:<key> -->`、
 * `<!-- rolecard: template=... -->`。模板要的是**纯正文**。
 */
function stripSyncMarkers(text) {
  const lines = String(text || '').split(/\r?\n/).filter((line) => {
    const l = String(line || '').trim();
    if (/^<!--\s*rolecard-standard:[A-Za-z0-9_~-]+:(?:begin|end)\s*-->$/.test(l)) return false;
    if (/^<!--\s*rolecard-section:[A-Za-z0-9_~-]+\s*-->$/.test(l)) return false;
    if (/^<!--\s*rolecard:\s*template=.*-->$/.test(l)) return false;
    return true;
  });
  return lines.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd();
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


// 「PM 换人双闲门」小节（B-20261119-204845-8d91，Owner 2026-11-19 20:48 直接指令）。
// 六卡模板里只有 pm / product 两张需要（其余角色不参与 PM 换人）。
const PM_ROTATE_IDLE_SECTION = `
## PM 换人的「双方闲时」门（Owner 2026-11-19 20:48 直接指令）

- \`session rotate --role pm\` 有程序门 **WAIT_BOTH_IDLE**：**PM 与产品双方**近 N 分钟（\`团队.json → config.pmRotateIdleMin\`，默认 15）必须同时满足：①无新消息 ②无 running 会话 ③无名下 working 任务 ④无在途派单锁；任一不满足 → 拒绝且**零写入**，并输出缺哪一方、还差多少分钟。
- 产品换 PM 前：先确认自己也不在跑活（规则同上），并让 PM 落交接回执（\`session handover receipt --role pm\`，八节齐全才放行）。
- Owner 通道不受此门限制（Owner 可直接指令换人）。
- 判定唯一实现：\`团队/工具/lib/session.mjs → pmRotateIdleState()\`；流程侧见 \`团队/流程.md §C2 第 6 条\`。
`.trimEnd();

function ensureSubagentSection(text) {
  if (text.includes('不可外包') && text.includes('可开')) return text;
  return text.trimEnd() + '\n\n' + SUBAGENT_SECTION;
}

// 「子代理使用边界」小节（团队/流程.md §D2，Owner 2026-11-20 11:5x 强制；六卡统一）。
// 口径来源＝流程.md §D2 原文（结论/允许/禁止/补三件事/根因/传播要求四条）；不在这里另造措辞——
// 改流程先改 §D2，再同步本常量并重生成（`node scripts/gen-role-card-template.cjs <六个角色>`）。
// 传播路径：新建项目卡由本模板生成；已存在项目卡由 `rolecard sync` 的标准节 `subagent-boundary` 增补
// （`团队/工具/lib/rolecard-sync.mjs` 的 SECTION_KEYWORDS/STANDARD_TITLES）。
const SUBAGENT_BOUNDARY_SECTION = `
<!-- rolecard-standard:subagent-boundary:begin -->
## 子代理使用边界（流程.md §D2）

> Owner 2026-11-20 11:5x 强制（「子代理容易跳过监管」）；本节与 \`团队/流程.md §D2\` 同源，六角色一致。

- **结论**：子代理不得承担会产生代码/夹具提交的活（不得产生代码提交或夹具提交）；代码与夹具改动一律走角色（六角色消息流）。
- **允许**（不产生提交、不需要角色身份）：①只读测量与取证（跑夹具取数、量体积、抓断面、读账本）②发布机制操作（推 tag / 建 Release / purge / npm publish / \`release-verify\`）及其重试等待 ③长等待型任务（等网络窗口、等长跑结束）。
- **禁止**（必须由角色本人做，且留下 \`M-*\` 回执）：①修改 \`src/**\`、\`团队/工具/lib/**\`、\`scripts/**\` 等任何被 git 跟踪的实现或夹具文件 ②不得自证已修好（自行判定「修好了」）——必须经 tester 复验 + PM 按证据验收 ③代替开发角色认领/提交缺陷单。
- **若已用子代理产生提交（本次教训）**：同一天补三件事——①立缺陷单（写明「实现归属＝PM 代做」）②向对应开发角色发交账消息请其复核 ③开 tester 复验单，PM 只在 test_done 且证据齐后验收。禁止只留提交不留单。
- **根因**：子代理没有令牌、不写回执、不挂 working 任务，绕过了「派单回执 → 实现 → 测试复验 → 验收」这条唯一可追溯链；当时看不出问题，事后无法对账。
- **传播要求（Owner 2026-11-20 12:0x：「升级版本或者其他用户，也能同步更新」）**：①本节必须同时进 \`团队/工具/lib/scaffold.mjs → GENERATED_ROLE_CARDS\`（新建项目卡）并跑 \`node scripts/gen-role-card-template.cjs\` 重生成；②已存在项目卡用 \`rolecard sync\` 标准节 \`subagent-boundary\` 同步（逐角色 \`team.mjs rolecard sync --role <r> --apply --boot <T>\`，默认 dry-run 先看 changes/conflicts，幂等；\`--apply --all\` 当前不允许，按角色逐个执行）；③\`团队/流程.md\` 与 \`团队/工具/**\` 必须在升级包清单内（\`scripts/upgrade-package-manifest.cjs\`），发布前用 \`node scripts/release-verify.cjs <版本>\` 核对包 sha；④只改本机文档、没进模板与升级包 = 视为未落地。
<!-- rolecard-standard:subagent-boundary:end -->
`.trimEnd();

/**
 * 六卡统一「子代理使用边界」节。
 *
 * 该节是**模板拥有**的标准节：无论项目卡是缺失、还是 PM 已 `rolecard sync` 过的旧措辞，都先摘掉再按当前
 * 常量重写——否则「项目卡已被同步过」会让本函数变成 no-op，模板永远停在旧措辞（本单实测：PM 12:30 同步
 * 五张卡后，重生成模板拿到的还是旧文案，AC 关键词 `不得产生代码提交` / `自证已修好` 落不进去）。
 * 卡侧落后属预期：升级/同步时再跑一次 `rolecard sync` 即可（sha12 判定，幂等）。
 */
function stripSubagentBoundarySection(text) {
  let src = String(text || '');
  // ① PM 已 `rolecard sync` 过的卡：整块（begin..end 标记 + 标题 + 正文）一起摘掉。
  //    只按标题摘会留下**孤儿 begin 标记**，parseCard 会从该标记起把后面的正常节吞进这个 block
  //    （本单实测：场景覆盖准则被算成 subagent-boundary，二次 sync 报假 add/keep）。
  src = src.replace(/\n?<!--\s*rolecard-standard:subagent-boundary:begin\s*-->\n?[\s\S]*?<!--\s*rolecard-standard:subagent-boundary:end\s*-->\n?/g, '\n');
  // ② 无标记的旧节：按标题摘到下一个 `## ` 标题。
  const HEADING = '## 子代理使用边界';
  const i = src.indexOf(HEADING);
  if (i >= 0) {
    const rest = src.slice(i + HEADING.length);
    const m = /\n##\s+/.exec(rest);
    const end = m ? i + HEADING.length + m.index : src.length;
    src = src.slice(0, i) + src.slice(end);
  }
  return src.replace(/\n{3,}/g, '\n\n').trimEnd();
}

function ensureSubagentBoundarySection(text) {
  const base = stripSubagentBoundarySection(text);
  return base + '\n\n' + SUBAGENT_BOUNDARY_SECTION.replace(/^\n+/, '');
}

// 「场景覆盖准则」小节（Owner 2026-11-19 强制；与 scaffold.mjs → sceneCoverageSection 同一口径）。
// 六卡必须都带本节：生成的卡（product/analyst）在这里补，手写卡（pm/programmer1/programmer2/tester）在 scaffold 里插。
const SCENE_COVERAGE_SHARED = [
  '## H. 场景覆盖准则（Owner 2026-11-19 强制 · 详见 团队/流程.md §H）',
  '',
  '- **五种「假完成」一律算未完成**：①空壳入口（按钮/菜单/命令存在但没有真执行链）②只做正向（失败/超时/回滚/重试没实现）③只测函数（夹具只调内部函数，没走真实入口）④只写日志（用户看不到状态变化，错误只进 stderr）⑤只改当前态（重启/重开/换机就丢）。',
  '- **交互入口必须交付「全链路六段」**：触发 → 执行 → 进度/等待可见 → 成功态 → 失败态（人话 + 错误码 + 下一步）→ 重试/回滚/手动兜底。缺任一段必须在实现说明里写「未覆盖 + 原因 + 计划」，**不得自评完成**，也不得留给 tester 去找。',
  '- **场景矩阵六类**（开发前写、开发后自测、交付时附证据）：①首次使用（干净环境/无配置）②正常路径 ③空值/边界（0 条、超长、空串、错误类型）④越权/异常（无权限、令牌失效、文件只读、网络失败）⑤并发/重复（连点、并发写、重复提交）⑥降级/恢复（依赖缺失、服务不可用、回滚后可用）。交付物必须含一张「场景 × 结果 × 证据路径」表；缺失项写「未覆盖」，**禁止留空**。',
  '- **反例锚点（Owner 原话）**：「检查更新能用」≠「点立即升级能真下载→校验→安装→回滚」；只做按钮 = 空壳，属缺陷。代码类交付的「可用」＝**真实入口点得动 + 失败看得见 + 重开还在**，三者缺一即未完成。｜**每次交付必附场景矩阵**（T-1914 软门起）：每份实现说明/测试报告都带「场景 × 结果 × 证据路径」表，`task done` 会扫六类关键词并写 `场景矩阵审计.jsonl`（软门只提示不拦；`TEAM_SCENE_ENFORCE=1` 才硬）。',
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
  let text = ensureSubagentSection(ensureStructuredOutput(stripSyncMarkers(stripAlignSection(stripSyncBlocks(raw))), role));
  // Owner 2026-11-19 强制：六卡都必须含「场景覆盖准则」；项目卡没写就在这里补（按角色差异化）。
  text = ensureSceneCoverage(text, role);
  // 流程.md §D2（Owner 2026-11-20 12:0x）：六卡统一补「子代理使用边界」节——新建项目靠本模板，
  // 已存在项目靠 `rolecard sync` 的标准节 `subagent-boundary`。
  text = ensureSubagentBoundarySection(text);
  // B-8d91：PM/产品卡追加「PM 换人双闲门」节（其余角色不涉及 PM 换人）。
  if ((role === 'pm' || role === 'product') && !text.includes('WAIT_BOTH_IDLE')) text = text.trimEnd() + '\n\n' + PM_ROTATE_IDLE_SECTION;
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
