'use strict';
/**
 * R-2a69 新手引导 v2 断言（Owner 2026-11-14 打回：4 步不够，要覆盖完整流程 7 步）
 * 只读源码，不启动窗口；配合人工截图。
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const app = fs.readFileSync(path.join(ROOT, 'src/renderer/app.js'), 'utf8');
const html = fs.readFileSync(path.join(ROOT, 'src/renderer/index.html'), 'utf8');

const start = app.indexOf('const GUIDE_STEPS = [');
const end = app.indexOf('\n];', start);
const block = start >= 0 && end > start ? app.slice(start, end) : '';
const checks = [];
const push = (name, ok, detail) => { checks.push({ name, ok: Boolean(ok), detail }); console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail ? ' :: ' + detail : ''}`); };

push('找到 GUIDE_STEPS', Boolean(block));
const steps = (block.match(/\n  \{\n/g) || []).length;
push('引导共 7 步（不是旧的四步）', steps === 7, `steps=${steps}`);
push('步号写死 /7', (block.match(/第 [1-7] 步 \/ 7/g) || []).length === 7);
push('第 1 步：新建项目→建团队', /新建项目/.test(block) && /建团队/.test(block));
push('第 2 步：提需求 + 需求流程链', /提需求/.test(block) && /评审/.test(block) && /验收/.test(block) && /收口/.test(block));
push('第 3 步：流程看板', /流程/.test(block) && /项目面板/.test(block));
push('第 4 步：在哪审核需求', /我的评审/.test(block) && /打回必须写一句意见/.test(block));
push('第 5 步：在哪验收需求', /我的验收/.test(block) && /评审是「要不要做」/.test(block));
push('第 6 步：回收内存解决了什么', /立即回收/.test(block) && /不动任何数据/.test(block));
push('第 7 步：字号与主题', /A-<\/b> \/ <b>A\+/.test(block) && /外观/.test(block) && /暗金/.test(block) && /暖白/.test(block));
push('第 2 步带示例话术', /我想做一个个人博客，先帮我理一下需求。/.test(block));
push('示例话术有复制按钮（data-guide-copy）', /data-guide-copy=/.test(block));
push('复制按钮只复制、不发送（渲染侧无发送调用）', /copyBtn\.addEventListener\('click'/.test(app) && !/copyBtn[\s\S]{0,300}(teamSend|teamPrompt|dshPrompt)/.test(app));
push('复制后提示不自动发送', /已复制（不会自动发送）/.test(app));
push('引导仍可重开（菜单 act=guide 或 F1）', /act === 'guide'/.test(app) || /showGuide\(true\)/.test(app));
const targets = Array.from(block.matchAll(/target: '([^']*)'/g)).map((m) => m[1]).filter(Boolean);
const missing = targets.filter((sel) => !(new RegExp(sel.replace('#', 'id="') + '"').test(html) || html.includes(sel.replace('#', 'id="'))));
push('引导锚点都能在 index.html 找到（无指空）', targets.length >= 3 && missing.length === 0, `targets=${targets.join(',')} missing=${missing.join(',') || '无'}`);

const failed = checks.filter((row) => !row.ok);
console.log(`GUIDE_CHECK ${JSON.stringify({ ok: failed.length === 0, total: checks.length, failed: failed.length })}`);
process.exit(failed.length === 0 ? 0 : 1);
