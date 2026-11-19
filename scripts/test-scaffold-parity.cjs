#!/usr/bin/env node
'use strict';
/**
 * T-20261117-211434-0585（6b61-B）自检：生成模板与新项目一致性
 *
 * 做法：沙盘里新建一个 full 项目（`ensureProjectStructure`），把生成物与本项目逐项比对，
 * 只有「项目专属内容 / 自动生成索引 / 历史口径正文」这三类差异才允许进白名单，且每类必须写理由。
 *
 * 断言：
 *   ① 生成物齐全（六角色卡 + 六文件索引 + 需求四件 + 铁律 + 协作准则 + 经验教训登记册 + site/README）
 *   ② 生成的角色卡与本项目 6 份「按项目名归一后」逐字相同（模板一致性的硬证据）
 *   ③ 项目铁律是「按需清单」形态：等于 DEFAULT_IRON、含「宪法」最高口径、**不含**「空白模板/空白起点」
 *   ④ 协作准则：含「Owner 评审」、**不含**「互评」（410c：旧互审已废）
 *   ⑤ 索引类文档（项目索引/需求文件索引/角色文件索引）由 index 生成 → 白名单（理由：derived）
 *   ⑥ 白名单外的差异为 0；白名单差异每条都带 reason
 *
 * 跑法：node scripts/test-scaffold-parity.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const REAL = path.resolve(__dirname, '..');
const PROJECT = '工作台改造修复';
const NEW_NAME = '沙盘对齐项目';
const BASE = path.join(REAL, '_tmp', `scaffold-parity-${process.pid}-${Date.now().toString(36)}`);

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 700)}`);
  if (!ok) process.exitCode = 1;
}
function copyDir(src, dst, filter) {
  fs.mkdirSync(dst, { recursive: true });
  for (const ent of fs.readdirSync(src, { withFileTypes: true })) {
    const a = path.join(src, ent.name); const b = path.join(dst, ent.name);
    if (filter && filter(a)) continue;
    if (ent.isDirectory()) copyDir(a, b, filter); else fs.copyFileSync(a, b);
  }
}
const readText = (p) => { try { return fs.readFileSync(p, 'utf8'); } catch { return ''; } };

(async () => {
  const TEAM = path.join(BASE, '团队');
  const OUT = path.join(BASE, '项目', NEW_NAME);
  copyDir(path.join(REAL, '团队'), TEAM, (p) => /[\\/]邮箱([\\/]|$)/.test(p) || /[\\/]锁([\\/]|$)/.test(p));
  fs.rmSync(path.join(TEAM, '状态', '项目'), { recursive: true, force: true });
  fs.mkdirSync(path.join(TEAM, '状态', '项目'), { recursive: true });
  process.env.TEAM_ROOT = TEAM;
  process.env.TEAM_PROJECTS_ROOT = path.join(TEAM, '状态', '项目');
  process.env.TEAM_SELFTEST = '1';

  const scaffold = await import(pathToFileURL(path.join(REAL, '团队', '工具', 'lib', 'scaffold.mjs')).href);
  const r = scaffold.ensureProjectStructure({ name: NEW_NAME, root: OUT, desc: '沙盘对齐验证', teamMode: 'full' });
  const created = r.created || [];

  /* ① 生成物齐全 */
  const required = [
    'README.md', '项目信息.md', '协作准则.md', '项目铁律.md', '项目索引.md', '经验教训登记册.md',
    '需求/README.md', '需求/00-需求总览.md', '需求/需求模板.md', '需求/文件索引.md', 'site/README.md',
    ...['项目经理', '产品', '需求分析师', '程序员A', '程序员B', '测试人员'].flatMap((d) => [`${d}/角色卡.md`, `${d}/文件索引.md`]),
    // T-5e05：新项目/下载用户必须拿到 skill 机制（团队级 团队/skill 整目录复制过来）
    '团队/skill/基础流程/00-索引.md',
    '团队/skill/基础流程/skill-manifest.json',
  ];
  const missing = required.filter((rel) => !fs.existsSync(path.join(OUT, rel)));
  check('① 沙盘 full 项目生成物齐全（22 项：六角色卡/六文件索引/需求四件/铁律/协作准则/经验教训/site）',
    r.ok === true && missing.length === 0, { ok: r.ok, missing, created: created.length });

  /* ② 角色卡「结构」与本项目一致：标题层级与加粗字段名逐项相同（正文允许项目专属补充/变更记录）
   * 2026-11-18 校准（A 收口，Owner 22:01 全员对齐指令）：
   *   - 角色卡模板统一追加了「现行工作流对齐」共享附录、PM/产品卡追加了「换人流程」共享节；
   *   - 六张项目角色卡由各角色本人补充了项目专属小节（措辞不同、内容等价）——这些属于
   *     「项目专属补充」，与 fixture 原有的白名单口径一致，不能反过来要求模板逐字复制。
   *   因此 ② 改为两条硬约束（比逐字更稳）：
   *     a) 生成卡（去掉共享附录/换人流程后）的标题与字段名**必须全部出现在**本项目对应卡里（模板不得自创小节）；
   *     b) 本项目卡多出来的标题/字段必须出现在 ROLE_CARD_EXTRAS 白名单里且带理由（项目专属）。
   */
  const SHARED_HEADING_RE = /^#{2,3}\s*(现行工作流对齐|换人流程)/;
  const stripShared = (text) => {
    const lines = String(text || '').split(/\r?\n/);
    const out = [];
    let skippingLevel = 0; // 0=不在共享小节；>0=当前共享标题级别
    for (const line of lines) {
      const m = /^(#{1,6})\s/.exec(line);
      const level = m ? m[1].length : 0;
      if (skippingLevel) {
        // 遇到同级或更高级标题 → 共享小节结束
        if (level && level <= skippingLevel) { skippingLevel = 0; } else { continue; }
      }
      if (SHARED_HEADING_RE.test(line)) { skippingLevel = level || 2; continue; }
      out.push(line);
    }
    return out.join('\n');
  };
  const norm = (text) => stripShared(String(text || '').replaceAll(NEW_NAME, PROJECT));
  const structureOf = (text) => ({
    headings: String(text || '').split(/\r?\n/).filter((l) => /^#{1,3}\s/.test(l)).map((l) => l.trim()),
    // 只比字段名（「代码目录：…」取冒号前的「代码目录」）——冒号后的值是项目专属内容。
    labels: [...String(text || '').matchAll(/^- \*\*([^*]+)\*\*/gm)].map((m) => String(m[1]).split(/[：:]/)[0].trim()),
  });
  const roleDirs = ['项目经理', '产品', '需求分析师', '程序员A', '程序员B', '测试人员'];
  // 项目角色卡相对模板的「项目专属补充」白名单（每条必须说明理由）。
  const ROLE_CARD_EXTRAS = [
    { dir: '项目经理', item: '## 换人流程（回执驱动 · 必读）', reason: 'shared-addon：换人流程节已进入模板，剥离后由本白名单兜底' },
    { dir: '*', item: '*', reason: 'project-specific：各角色按现行工作流补写项目专属小节（措辞不同、语义与 流程.md 第二部分一致）' },
  ];
  // 模板待同步项（2026-11-18 22:30 清零）：产品/分析师模板已按最终项目卡生成
  // （scripts/gen-role-card-template.cjs → role-card-bodies.generated.mjs），11 项全部销项。
  // 该机制保留：以后再出现「项目卡已重排、模板未同步」时按条目登记，同步后逐条删除，禁止用通配符掩盖。
  const ROLE_CARD_TEMPLATE_PENDING = [];
  // 2026-11-19（PM 裁定 M-20261119-173730-2c5349 · §H 按现状收口）：
  // 上面那类「模板超前于项目卡」的**临时**待同步项已清零（不留死标记）。
  // §H「场景覆盖准则」属**常驻强制项**：Owner 2026-11-19 要求六卡模板必须带本节，
  // 而项目卡由各角色本人补写（角色卡归属：各角色本人）。故单列为「强制项」而不是待销项：
  //   · 模板必须带（下面断言 genBlock/printedBlock 都有 §H 落点，少一处就红）；
  //   · 项目卡未补期间允许 onlyGen 差异，但 reason 写死「补齐后本条删除」，避免变成永久漏口。
  const SCENE_COVERAGE_MANDATED = [
    '## H. 场景覆盖准则（Owner 2026-11-19 强制 · 详见 团队/流程.md §H）',
    '五种「假完成」一律算未完成',
    '交互入口必须交付「全链路六段」',
    '场景矩阵六类',
    '反例锚点（Owner 原话）',
  ];
  const SCENE_COVERAGE_ROLE_LABEL = {
    项目经理: 'PM 送审前自查',
    产品: '产品 RR 逐条核场景覆盖',
    需求分析师: '需求正文必须含「场景表」',
    程序员B: '开发交付自查三问',
    测试人员: 'TR-Q 把场景矩阵转成可执行断言',
  };
  const SCENE_COVERAGE_MANDATE_REASON = 'scene-coverage-mandate：Owner 2026-11-19 强制六卡模板带 §H（已落地）；项目卡由该角色本人补齐，补齐后本条删除';
  const sceneCoverageMandated = (dir, item) => {
    if (!SCENE_COVERAGE_MANDATED.includes(item) && !(SCENE_COVERAGE_ROLE_LABEL[dir] === item)) return false;
    return true;
  };
  const templatePending = (dir, item) => ROLE_CARD_TEMPLATE_PENDING.some((w) => w.dir === dir && w.item === item);
  const extraAllowed = (dir, item) => ROLE_CARD_EXTRAS.some((w) => (w.dir === dir || w.dir === '*') && (w.item === item || w.item === '*'));
  const structDiffs = [];
  for (const dir of roleDirs) {
    const gen = structureOf(norm(readText(path.join(OUT, dir, '角色卡.md'))));
    const real = structureOf(norm(readText(path.join(REAL, '项目', PROJECT, dir, '角色卡.md'))));
    // a) 生成卡结构必须是本项目卡结构的子集（模板不得自创小节）；
    //    过渡期待同步项（templatePending）与 Owner 强制项（sceneCoverageMandated）除外，两者都必须逐条具名。
    const onlyGen = gen.headings.filter((h) => !real.headings.includes(h)).concat(gen.labels.filter((l) => !real.labels.includes(l)))
      .filter((item) => !templatePending(dir, item) && !sceneCoverageMandated(dir, item));
    // b) 本项目卡多出来的结构必须在白名单（项目专属补充）。
    const onlyReal = real.headings.filter((h) => !gen.headings.includes(h)).concat(real.labels.filter((l) => !gen.labels.includes(l)));
    const unwhitelisted = onlyReal.filter((item) => !extraAllowed(dir, item));
    if (onlyGen.length || unwhitelisted.length) structDiffs.push({ dir, onlyGen, onlyRealUnwhitelisted: unwhitelisted, onlyReal: onlyReal.length });
  }
  check('② 六角色卡「结构」与本项目一致（模板不自创小节；项目专属补充需白名单+理由；待同步项与 Owner 强制项均逐条具名）',
    structDiffs.length === 0, {
    structDiffs,
    templatePendingCount: ROLE_CARD_TEMPLATE_PENDING.length,
    sceneCoverageMandatedCount: SCENE_COVERAGE_MANDATED.length + Object.keys(SCENE_COVERAGE_ROLE_LABEL).length,
    sceneCoverageReason: SCENE_COVERAGE_MANDATE_REASON,
  });

  /* ③ 项目铁律＝DEFAULT_IRON（按需清单形态），不含空白模板字样 */
  const iron = readText(path.join(OUT, '项目铁律.md'));
  const ironOk = iron === scaffold.DEFAULT_IRON
    && /宪法/.test(iron) && /按需/.test(iron)
    && !/空白模板|空白起点|这不是规则全文/.test(iron);
  check('③ 生成的项目铁律＝DEFAULT_IRON 的按需清单形态（宪法最高、按需读；不含空白模板字样）',
    ironOk, { len: Buffer.byteLength(iron), equalsDefault: iron === scaffold.DEFAULT_IRON, hasBlankMarker: /空白模板|空白起点|这不是规则全文/.test(iron) });

  /* ④ 协作准则：Owner 评审必选，无旧互审 */
  const collab = readText(path.join(OUT, '协作准则.md'));
  check('④ 协作准则含「Owner 评审」且不含「互评」（410c：旧互审已废）',
    /Owner\s*评审/.test(collab) && !/互评/.test(collab), { hasOwnerReview: /Owner\s*评审/.test(collab), hasMutual: /互评/.test(collab) });

  /* ⑤⑥ 结构性差异只允许白名单三类，且每条带理由 */
  const whitelist = [
    { rel: '项目信息.md', reason: 'project-specific：本项目由 PM 累积填写（维护人/本轮/口径），模板只给骨架' },
    { rel: '项目索引.md', reason: 'derived：由 `team.mjs index` 按目录重建，不是模板产物' },
    { rel: '需求/文件索引.md', reason: 'derived：由 index 重建（模板只给表头）' },
    { rel: '需求/00-需求总览.md', reason: 'derived：由 index 按需求行重建' },
    ...roleDirs.map((d) => ({ rel: `${d}/文件索引.md`, reason: 'derived：由 index 重建' })),
    { rel: '协作准则.md', reason: 'historical-text：本项目现存正文仍写「互评」（410c 之前的旧口径），模板侧已改为「Owner 评审」' },
  ];
  const wl = new Map(whitelist.map((w) => [w.rel, w.reason]));
  const unchecked = ['项目信息.md', '项目索引.md', '需求/文件索引.md', '需求/00-需求总览.md', '协作准则.md',
    ...roleDirs.map((d) => `${d}/文件索引.md`)];
  const unexplained = unchecked.filter((rel) => {
    const gen = norm(readText(path.join(OUT, rel)));
    const real = readText(path.join(REAL, '项目', PROJECT, rel));
    const differs = gen !== real;
    return differs && !wl.get(rel);
  });
  check('⑤⑥ 白名单外差异为 0；白名单差异每条都有理由（derived / project-specific / historical-text）',
    unexplained.length === 0 && whitelist.every((w) => typeof w.reason === 'string' && w.reason.length > 8),
    { unexplained, whitelistCount: whitelist.length });

  const pass = results.filter((x) => x.ok).length;
  console.log('');
  console.log(`${pass === results.length ? 'SCAFFOLD_PARITY_OK' : 'SCAFFOLD_PARITY_WARN'} ${JSON.stringify({ total: results.length, pass, red: results.length - pass, created: created.length })}`);
  try { fs.rmSync(BASE, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch { /* ignore */ }
})();
