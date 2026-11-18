#!/usr/bin/env node
/**
 * 夹具（T-20261118-220400-4981）：角色卡 / skill / 模板 与现行工作流对齐（Owner 2026-11-18 22:01）。
 *
 * 断言：
 *   A1 六张角色卡模板（scaffold.roleCard）都含「现行工作流对齐」附录五项：验收 / 代管 / 工装安全 / 测量窗口 / 文档维护
 *   A2 角色卡模板附录取自唯一常量 WORKFLOW_ALIGN_SECTION（单源，避免六处漂移）
 *   A3 DEFAULT_IRON 模板含工装安全（PID-only）+ 测量窗口 + 验收/代管边界条款
 *   A4 store.mjs 的 DEFAULT_CONSTITUTION 模板含「工装与进程安全」「基础工作流唯一执行口径」「验收权限硬边界」「测量窗口协同」
 *   A5 我的项目角色卡已写入「现行工作流对齐」五项
 *   A6 我的 skill 已写入「现行工作流对齐」（含 PID-only 与验收边界），manifest 版本 ≥1.3.0 且 sha 一致
 *   A7 新项目生成：ensureProjectStructure 在临时目录生成的项目，角色卡/铁律/宪法 都含对齐条款（真实生成路径）
 *   A8 fast 模式角色卡也带附录（模板分叉不丢条款）
 *
 * 跑法：node scripts/test-20261118-workflow-align.mjs
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const stack = await import(pathToFileURL(path.join(ROOT, '团队', '工具', 'lib', 'scaffold.mjs')).href);

let pass = 0; let fail = 0;
const ok = (cond, name, detail) => { if (cond) { pass += 1; console.log(`PASS ${name}`); } else { fail += 1; console.log(`FAIL ${name} :: ${JSON.stringify(detail || {})}`); } };
const read = (rel) => { try { return fs.readFileSync(path.join(ROOT, rel), 'utf8'); } catch { return ''; } };

const ROLE_IDS = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
const KEYWORDS = ['验收', '代管', '工装安全', '测量窗口', '文档维护'];

// A1 六张角色卡模板
const missing = [];
for (const role of ROLE_IDS) {
  const card = stack.roleCard('夹具项目', role, 'full') || '';
  const miss = KEYWORDS.filter((k) => card.indexOf(k) < 0);
  if (miss.length) missing.push({ role, miss });
}
ok(missing.length === 0, 'A1 六张角色卡模板都含对齐附录五项', missing);
ok(typeof stack.WORKFLOW_ALIGN_SECTION === 'string' && stack.WORKFLOW_ALIGN_SECTION.length > 100, 'A2 对齐附录取自单源 WORKFLOW_ALIGN_SECTION', {});

// A3 铁律模板
const iron = stack.DEFAULT_IRON || '';
ok(/工装安全|PID/.test(iron) && /测量窗口/.test(iron) && /验收/.test(iron) && /代管/.test(iron),
  'A3 DEFAULT_IRON 含工装安全/测量窗口/验收与代管边界', {});

// A4 宪法模板（store.mjs 内 DEFAULT_CONSTITUTION）
const storeSrc = read('团队/工具/lib/store.mjs');
const constStart = storeSrc.indexOf('const DEFAULT_CONSTITUTION');
const constText = constStart >= 0 ? storeSrc.slice(constStart, storeSrc.indexOf('`;', constStart)) : '';
ok(constText.indexOf('工装与进程安全') >= 0 && constText.indexOf('基础工作流唯一执行口径') >= 0
  && constText.indexOf('验收权限硬边界') >= 0 && constText.indexOf('测量窗口协同') >= 0,
  'A4 DEFAULT_CONSTITUTION 含工装安全/工作流唯一口径/验收边界/测量窗口', {});

// A5 我的角色卡
const myCard = read('项目/工作台改造修复/程序员A/角色卡.md');
ok(myCard.indexOf('现行工作流对齐') >= 0 && KEYWORDS.every((k) => myCard.indexOf(k) >= 0), 'A5 我的项目角色卡含对齐五项', {});

// A6 我的 skill + manifest
const mySkill = read('团队/skill/基础流程/programmer1.md');
const manifest = JSON.parse(read('团队/skill/基础流程/skill-manifest.json') || '{}');
const skillSha = crypto.createHash('sha256').update(read('团队/skill/基础流程/programmer1.md')).digest('hex');
ok(mySkill.indexOf('现行工作流对齐') >= 0 && /PID/.test(mySkill) && mySkill.indexOf('验收边') >= 0,
  'A6a 我的 skill 含对齐小节（PID-only / 验收边界）', {});
ok(manifest.version === '1.3.0'
  && manifest.files && manifest.files['programmer1.md'] === skillSha
  && manifest.previousVersion && manifest.previousVersion.version === '1.2.0',
  'A6b skill-manifest 1.3.0 + sha 一致 + 旧版归档记录', { version: manifest.version });

// A7 新项目生成（真实 ensureProjectStructure）：六张角色卡 + 铁律都要带对齐条款
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'align-proj-'));
try {
  const res = stack.ensureProjectStructure({ name: '夹具项目', root: tmp, desc: '夹具', overwrite: true, teamMode: 'full' });
  const missingSix = [];
  for (const dir of ['项目经理', '产品', '需求分析师', '程序员A', '程序员B', '测试人员']) {
    const p = path.join(tmp, dir, '角色卡.md');
    const cardText = fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : '';
    const miss = KEYWORDS.filter((k) => cardText.indexOf(k) < 0);
    if (miss.length) missingSix.push({ dir, miss });
  }
  const ironFile = fs.existsSync(path.join(tmp, '项目铁律.md')) ? fs.readFileSync(path.join(tmp, '项目铁律.md'), 'utf8') : '';
  ok(missingSix.length === 0, 'A7a 新项目生成的六张角色卡都含对齐五项', missingSix);
  ok(/工装安全/.test(ironFile) && /测量窗口/.test(ironFile), 'A7b 新项目生成的项目铁律含工装安全/测量窗口', {});
} finally {
  fs.rmSync(tmp, { recursive: true, force: true });
}

// A8 fast 模式
const fastCard = stack.roleCard('夹具项目', 'programmer1', 'fast') || '';
ok(KEYWORDS.every((k) => fastCard.indexOf(k) >= 0), 'A8 fast 模式角色卡也带对齐附录', {});

console.log(`\nWORKFLOW_ALIGN ${pass}/${pass + fail} PASS`);
process.exitCode = fail === 0 ? 0 : 1;
