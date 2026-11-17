#!/usr/bin/env node
/**
 * T-20261117-184114-4358（R-bcae）+ B-20261117-212853-3027：基础流程 skill 清单校验（防篡改）。
 *
 * 用法：
 *   node scripts/skill-check.cjs [--root <仓库根/沙盘根>] [--json] [--strict-state] [--write-state]
 *   --write-state：校验后由 manifest 派生正式落点 `团队/状态/技能清单.json`（需求 AC5）。
 *
 * 判据（实现单源在 团队/工具/lib/skill-manifest.mjs，与 team.mjs skill verify 同一份逻辑）：
 *   SKILL_MANIFEST_MISSING / SKILL_MANIFEST_INVALID / SKILL_TEMPLATE_MISSING / SKILL_MANIFEST_EXTRA /
 *   SKILL_TEMPLATE_TAMPERED / SKILL_FORMAT_INVALID / SKILL_STATE_MISSING / SKILL_STATE_INVALID / SKILL_STATE_DRIFT
 * 退出码：0 = 全部通过；1 = 有 finding。
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf('--' + name);
  return i >= 0 && argv[i + 1] ? argv[i + 1] : dflt;
};
const ROOT = path.resolve(argOf('root', path.resolve(__dirname, '..')));
const JSON_OUT = argv.includes('--json');
const STRICT_STATE = argv.includes('--strict-state');
const WRITE_STATE = argv.includes('--write-state');

(async () => {
  // 内核固定从脚本所在仓库导入（--root 只作被检查仓库根；沙盘可能没有 团队/工具 副本）
  const libUrl = pathToFileURL(path.join(__dirname, '..', '团队', '工具', 'lib', 'skill-manifest.mjs')).href;
  const mod = await import(libUrl);
  const result = mod.verifySkillSet({ root: ROOT, strictState: STRICT_STATE });
  let written = null;
  if (WRITE_STATE && result.manifest) written = mod.writeSkillStateFile({ root: ROOT });
  const payload = {
    at: new Date().toISOString(), root: ROOT, dir: mod.SKILL_DIR_REL,
    ok: result.ok, findings: result.findings, version: result.manifest && result.manifest.version,
    stateFile: result.stateFile, stateWritten: written,
    checkedSections: mod.REQUIRED_SECTIONS,
  };
  if (JSON_OUT) process.stdout.write(JSON.stringify(payload) + '\n');
  else {
    console.log(`基础流程 skill 清单校验：${result.ok ? 'SKILL_CHECK_OK' : 'SKILL_CHECK_FAIL'}（${result.findings.length} 个 finding）`);
    for (const f of result.findings) console.log(`- ${f.code} ${f.file}：${f.note}`);
    if (written && written.ok) console.log(`- 已派生 ${mod.SKILL_STATE_FILE_REL}（version ${written.version}）`);
  }
  process.exit(result.ok ? 0 : 1);
})().catch((e) => { console.error('SKILL_CHECK_INTERNAL ' + String((e && e.stack) || e)); process.exit(1); });
