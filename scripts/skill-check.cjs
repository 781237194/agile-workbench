#!/usr/bin/env node
/**
 * T-20261117-184114-4358（R-bcae）第一步：基础流程 skill 清单校验（防篡改）。
 *
 * 用法：
 *   node scripts/skill-check.cjs [--root <仓库根/沙盘根>] [--json]
 *
 * 判据：
 *   SKILL_MANIFEST_MISSING  manifest 不存在
 *   SKILL_MANIFEST_INVALID  manifest 缺 version/approvedBy/approvedAt/files 或 schema 不对
 *   SKILL_TEMPLATE_MISSING  manifest 登记的文件在磁盘上不存在
 *   SKILL_MANIFEST_EXTRA   skill 目录里有 manifest 没登记的文件（新增必须走 Owner 批准的新版本）
 *   SKILL_TEMPLATE_TAMPERED 文件 sha256 与清单不一致（篡改/绕过改版流程）
 *   SKILL_FORMAT_INVALID   文件缺固定小节（标题/适用场景/前置条件/步骤/判据/反例/版本）
 *
 * 退出码：0 = 全部通过；1 = 有 finding。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const ROOT = path.resolve(argOf('root', path.resolve(__dirname, '..')));
const JSON_OUT = argv.includes('--json');
const DIR_REL = '团队/skill/基础流程';
const DIR = path.join(ROOT, DIR_REL);
const MANIFEST = path.join(DIR, 'skill-manifest.json');
const REQUIRED_SECTIONS = ['标题', '适用场景', '前置条件', '步骤', '判据', '反例', '版本'];

const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const findings = [];
const add = (code, file, note) => findings.push({ code, file, note });

if (!fs.existsSync(DIR)) {
  add('SKILL_TEMPLATE_MISSING', DIR_REL, '基础流程 skill 目录不存在');
} else if (!fs.existsSync(MANIFEST)) {
  add('SKILL_MANIFEST_MISSING', `${DIR_REL}/skill-manifest.json`, '缺 manifest（不可更改的模板必须有 sha256 清单）');
} else {
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(MANIFEST, 'utf8')); } catch { manifest = null; }
  if (!manifest || typeof manifest !== 'object') {
    add('SKILL_MANIFEST_INVALID', `${DIR_REL}/skill-manifest.json`, 'JSON 解析失败');
  } else {
    const invalid = [];
    if (Number(manifest.schema || 0) !== 1) invalid.push('schema≠1');
    if (!String(manifest.version || '').trim()) invalid.push('缺 version');
    if (!String(manifest.approvedBy || '').trim()) invalid.push('缺 approvedBy');
    if (!String(manifest.approvedAt || '').trim()) invalid.push('缺 approvedAt');
    if (!manifest.files || typeof manifest.files !== 'object' || !Object.keys(manifest.files).length) invalid.push('缺 files');
    if (invalid.length) add('SKILL_MANIFEST_INVALID', `${DIR_REL}/skill-manifest.json`, invalid.join('；'));
    const listed = Object.keys(manifest.files || {});
    for (const rel of listed) {
      const abs = path.join(DIR, rel);
      if (!fs.existsSync(abs)) { add('SKILL_TEMPLATE_MISSING', `${DIR_REL}/${rel}`, 'manifest 登记但磁盘缺失'); continue; }
      const actual = sha256(abs);
      const expect = String(manifest.files[rel] || '');
      if (actual !== expect) add('SKILL_TEMPLATE_TAMPERED', `${DIR_REL}/${rel}`, `sha ${actual.slice(0, 12)} ≠ 清单 ${expect.slice(0, 12)}`);
      // 固定格式（索引类文件不按七段模板校验）
      if (/^(00-索引|index)\.md$/.test(rel)) continue;
      const text = fs.readFileSync(abs, 'utf8');
      const missing = REQUIRED_SECTIONS.filter((sec) => (sec === '标题' ? !/^#\s+\S+/m.test(text) : !new RegExp(`^##\\s*${sec}`, 'm').test(text)));
      if (missing.length) add('SKILL_FORMAT_INVALID', `${DIR_REL}/${rel}`, `缺小节：${missing.join('、')}`);
    }
    // 目录里多出的 .md（未登记）也算改版绕过
    for (const name of fs.readdirSync(DIR).filter((n) => n.endsWith('.md'))) {
      if (!manifest.files || !Object.prototype.hasOwnProperty.call(manifest.files, name)) {
        add('SKILL_MANIFEST_EXTRA', `${DIR_REL}/${name}`, '文件未登记在 manifest（改版须走 Owner 批准的新版本）');
      }
    }
  }
}

const ok = findings.length === 0;
const payload = { at: new Date().toISOString(), root: ROOT, dir: DIR_REL, ok, findings, checkedSections: REQUIRED_SECTIONS };
if (JSON_OUT) process.stdout.write(JSON.stringify(payload) + '\n');
else {
  console.log(`基础流程 skill 清单校验：${ok ? 'SKILL_CHECK_OK' : 'SKILL_CHECK_FAIL'}（${findings.length} 个 finding）`);
  for (const f of findings) console.log(`- ${f.code} ${f.file}：${f.note}`);
}
process.exit(ok ? 0 : 1);
