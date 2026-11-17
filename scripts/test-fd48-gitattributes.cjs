#!/usr/bin/env node
'use strict';
/**
 * test-fd48-gitattributes.cjs —— B-20261118-033814-fd48 回归夹具
 *
 * 缺陷：仓库缺 .gitattributes，Windows 默认 core.autocrlf=true 克隆后 `团队/skill/**` 被转 CRLF，
 * 字节变 → skill-check 报 SKILL_TEMPLATE_TAMPERED（下载即踩）。
 *
 * 断言：
 *   G1 HEAD 里有 .gitattributes，且含 `团队/skill/** -text`（按字节校验，禁换行转换）
 *   G2 git check-attr 证明规则生效：skill 文件 text=unset；*.cmd/*.ps1 eol=crlf
 *   G3 当前工作树里 团队/skill 下 md/json 均无 CRLF（字节原样）
 *   G4 规则不过宽：工作树 `git status --porcelain -- 团队/skill` 为空（无回检出的换行抖动）
 *   G5 skill-check 本体在当前树通过（SKILL_CHECK_OK）
 *
 * 说明：本机实测无法复现「pre-fix 克隆转 CRLF」（两路克隆与去掉规则后重检都是 w/lf，见实现说明），
 *       所以这里用 check-attr + 工作树字节 两路证明规则到位，而不是依赖一次慢克隆。
 *
 * 跑法：node scripts/test-fd48-gitattributes.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log(`PASS  ${name}`); return; }
  fail += 1; console.log(`FAIL  ${name}  ` + JSON.stringify(detail || {}).slice(0, 300)); process.exitCode = 1;
}
const git = (args) => {
  try { return String(execFileSync('git', args, { cwd: ROOT, encoding: 'utf8', timeout: 120000 })); }
  catch (e) { return String(e.stdout || '') + String(e.stderr || ''); }
};

// G1
const headAttr = git(['show', 'HEAD:.gitattributes']);
ok('G1 HEAD 含 .gitattributes 且写明 `团队/skill/** -text`',
  headAttr.includes('团队/skill/** -text'), { head: headAttr.split(/\r?\n/).slice(0, 4) });

// G2
const skillRel = '团队/skill/基础流程/00-索引.md';
const attrText = git(['check-attr', 'text', '--', skillRel]).trim();
const attrCmd = git(['check-attr', 'eol', '--', 'x.cmd']).trim();
const attrPs1 = git(['check-attr', 'eol', '--', 'x.ps1']).trim();
ok('G2 check-attr：skill 文件 text=unset；*.cmd / *.ps1 eol=crlf',
  /text:\s*unset/.test(attrText) && /eol:\s*crlf/.test(attrCmd) && /eol:\s*crlf/.test(attrPs1),
  { attrText, attrCmd, attrPs1 });

// G3：工作树 skill 文件无 CRLF
const dir = path.join(ROOT, '团队', 'skill');
const bad = [];
(function walk(d) {
  for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
    const abs = path.join(d, ent.name);
    if (ent.isDirectory()) { walk(abs); continue; }
    if (!/\.(md|json)$/i.test(ent.name)) continue;
    const buf = fs.readFileSync(abs);
    for (let i = 0; i < buf.length - 1; i += 1) {
      if (buf[i] === 13 && buf[i + 1] === 10) { bad.push(path.relative(ROOT, abs)); break; }
    }
  }
})(dir);
ok('G3 工作树 团队/skill/** 全部 LF（无 CRLF）', bad.length === 0, { bad: bad.slice(0, 5) });

// G4：规则不过宽（skill 目录无换行抖动）
const status = git(['status', '--porcelain', '--', '团队/skill']).trim();
ok('G4 `git status --porcelain -- 团队/skill` 为空（规则未过宽）', status === '', { status });

// G5：skill-check 通过
let out = '';
try { out = String(execFileSync(process.execPath, [path.join(ROOT, 'scripts', 'skill-check.cjs')], { cwd: ROOT, encoding: 'utf8', timeout: 120000 })); }
catch (e) { out = String(e.stdout || '') + String(e.stderr || ''); }
ok('G5 skill-check 当前树通过（SKILL_CHECK_OK）', /SKILL_CHECK_OK/.test(out), { tail: out.split(/\r?\n/).slice(-3) });

console.log(`\nFD48_GITATTRIBUTES ${JSON.stringify({ total: pass + fail, pass, fail })}`);
process.exit(fail ? 1 : 0);
