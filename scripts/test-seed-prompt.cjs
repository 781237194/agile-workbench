#!/usr/bin/env node
// R-20261119 夹具：开局「就位」提示词必须让角色先读规则+本人目录，再回已就位。
// 背景（Owner 实测）：建团队时自动发送的消息原先只有「只回复：已就位。不要分析、不要写文件、不要建任务。」，
// 角色因此不 boot、不读规则/角色卡/交接/产出，只会被程序戳一下动一下。
'use strict';
const path = require('node:path');
const { pathToFileURL } = require('node:url');
const assert = require('node:assert');

const ROOT = path.resolve(__dirname, '..');
const ROLES = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
const DIRS = { pm: '项目经理', product: '产品', analyst: '需求分析师', programmer1: '程序员A', programmer2: '程序员B', tester: '测试人员' };
const rows = [];
function check(name, ok, detail) {
  rows.push({ name, ok: Boolean(ok), detail });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + JSON.stringify(detail || '')}`);
}

(async () => {
  const mod = await import(pathToFileURL(path.join(ROOT, '团队/工具/lib/seed-prompt.mjs')).href);
  const { seedTextFor, startupText } = mod;
  check('M0 lib 导出 seedTextFor/startupText', typeof seedTextFor === 'function' && typeof startupText === 'function');

  const project = '种子提示词项目';
  for (const role of ROLES) {
    const name = DIRS[role];
    const text = seedTextFor(role, name, project);
    const musts = [
      ['读规则', '读规则'],
      ['团队宪法', '团队宪法'],
      ['流程.md 第二部分', '流程.md'],
      ['项目铁律', '项目铁律'],
      ['boot 命令含角色', `team.mjs boot --role ${role}`],
      ['boot 命令含项目', `--project "${project}"`],
      ['本人目录', `项目\\${project}\\${DIRS[role]}\\`],
      ['角色卡', '角色卡.md'],
      ['交接-最新', '交接-最新.md'],
      ['产出索引', '产出\\'],
      ['只回一行', '只回一行'],
      ['已就位', '已就位'],
    ];
    const missing = musts.filter(([, m]) => !text.includes(m)).map(([label]) => label);
    check(`S-${role} 提示词含全部必读指令`, missing.length === 0, { missing });
    check(`S-${role} 不再只有「只回复已就位」`, !/^你是「[^」]+」。只回复：已就位。不要分析/.test(text) && text.includes('boot'), text.slice(0, 60));
  }
  const pmText = seedTextFor('pm', DIRS.pm, project);
  check('S-pm 就位回复带请老板说需求', pmText.includes('请老板说项目需求和场景'), pmText.slice(-120));
  const devText = seedTextFor('programmer1', DIRS.programmer1, project);
  check('S-dev 就位回复是等待 PM 派单', /(高级程序员 A|程序员A) 已就位，等待 PM 派单/.test(devText), devText.slice(-120));

  const startup = startupText('analyst', project, 'D:\\workspace', 'fast');
  check('U0 startupText 含 boot 命令', startup.includes('team.mjs boot --role analyst --project'), startup.slice(0, 80));
  check('U1 startupText 含本人目录与角色卡', startup.includes(`项目\\${project}\\${DIRS.analyst}\\`) && startup.includes('角色卡.md'), null);
  check('U2 startupText 保留快速模式职责', startup.includes('快速模式') && startup.includes('req review'), null);
  check('U3 startupText 以「已就位」一行收尾', startup.includes('已就位'), null);

  const failed = rows.filter((r) => !r.ok);
  console.log('');
  console.log(`SEED-PROMPT ${failed.length ? 'FAIL' : 'OK'} ${JSON.stringify({ total: rows.length, pass: rows.length - failed.length, red: failed.length })}`);
  process.exit(failed.length ? 1 : 0);
})().catch((e) => {
  console.error('SEED-PROMPT FAIL', e);
  process.exit(1);
});
