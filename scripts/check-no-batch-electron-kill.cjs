#!/usr/bin/env node
'use strict';
/**
 * 静态检查（P0 B-20261118-200539-e923）：禁止任何脚本/工具按「进程名/路径」批量杀 electron。
 *
 * 背景：A 的 scripts/test-b34a-r1-typing.cjs 曾用
 *   Get-Process electron | Where-Object { $_.Path -like "*deepseek*" } | Stop-Process -Force
 * 清理现场，而 Owner 的生产工作台就是 D:\deepseek\agile-workbench\node_modules\electron\dist\electron.exe
 * → 把 Owner 的工作台一并杀掉（2026-11-18 19:05 / 20:00 两次）。此后所有采集/夹具只允许：
 *   ①记录自己 spawn 的 child.pid → taskkill /PID <pid> /T /F（或 child.kill()）；
 *   ②只按 PID 精确杀，绝不 taskkill /IM electron.exe、绝不 Stop-Process -Name electron。
 *
 * 扫描范围：scripts/**.{cjs,mjs,js,ps1} + 团队/工具/** + 各项目 `<角色>/产出/**`（排除本文件与归档 _tmp）。
 * 判定：命中任何 FORBIDDEN 模式 → exit 1 并列出 文件:行。
 * 跑法：node scripts/check-no-batch-electron-kill.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const SELF = path.basename(__filename);
const FORBIDDEN = [
  { re: /Stop-Process/i, why: 'Stop-Process 按名称/对象批量杀进程（可能命中 Owner 工作台）' },
  { re: /taskkill[^\n]*\/IM\s+electron/i, why: 'taskkill /IM electron.exe 按进程名批量杀' },
  { re: /Get-Process\s+electron/i, why: 'Get-Process electron 后接杀进程时无 PID 限定' },
  { re: /pkill[^\n]*electron/i, why: 'pkill 按进程名批量杀' },
  { re: /killall[^\n]*electron/i, why: 'killall 按进程名批量杀' },
];
// 允许：按 PID 精确杀（taskkill /PID <pid>、Stop-Process -Id <pid>）、child.kill()、
// 只读列举（tasklist/Get-Process 用于统计但不得接 Stop-Process）
const ALLOW_IF_SAME_LINE = [/taskkill[^\n]*\/PID/i, /Stop-Process[^\n]*-Id\b/i];

function walk(dir, out) {
  for (const ent of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ent.name === 'node_modules' || ent.name === '_tmp' || ent.name === '归档') continue;
    const full = path.join(dir, ent.name);
    if (ent.isDirectory()) { walk(full, out); continue; }
    if (!/\.(cjs|mjs|js|ps1)$/.test(ent.name)) continue;
    if (ent.name === SELF) continue;
    out.push(full);
  }
}

const files = [];
walk(path.join(ROOT, 'scripts'), files);
walk(path.join(ROOT, '团队', '工具'), files);
// P0 B-20261118-201515-ac99：扫描范围扩到各项目 `产出/**` 下的工装脚本——
// 代理（agent）临时写在证据目录里的脚本同样可能按名称批量杀进程，不能只拦 scripts/。
try {
  const projectsRoot = path.join(ROOT, '项目');
  for (const proj of fs.readdirSync(projectsRoot, { withFileTypes: true })) {
    if (!proj.isDirectory()) continue;
    const projDir = path.join(projectsRoot, proj.name);
    let roles = [];
    try { roles = fs.readdirSync(projDir, { withFileTypes: true }); } catch { continue; }
    for (const role of roles) {
      if (!role.isDirectory()) continue;
      const outDir = path.join(projDir, role.name, '产出');
      try { if (fs.existsSync(outDir)) walk(outDir, files); } catch { /* 单目录不可读不影响其它 */ }
    }
  }
} catch { /* 项目目录不可读时保持原扫描范围 */ }

const hits = [];
for (const file of files) {
  let text = '';
  try { text = fs.readFileSync(file, 'utf8'); } catch { continue; }
  const lines = text.split(/\r?\n/);
  lines.forEach((line, idx) => {
    const code = line.replace(/^\s*\/\/.*$/, '').trim();
    if (!code) return;
    for (const rule of FORBIDDEN) {
      if (!rule.re.test(code)) continue;
      // 只读统计：Get-Process 出现在仅计数/取内存的行（没有 Stop-Process/taskkill 同行）视为允许
      if (/Get-Process\s+electron/i.test(code) && !/Stop-Process|taskkill/i.test(code)) continue;
      if (ALLOW_IF_SAME_LINE.some((ok) => ok.test(code))) continue;
      hits.push({ file: path.relative(ROOT, file).replace(/\\/g, '/'), line: idx + 1, why: rule.why, code: code.slice(0, 160) });
    }
  });
}

if (hits.length) {
  console.log(`NO_BATCH_ELECTRON_KILL_FAILED ${hits.length} 处`);
  for (const h of hits) console.log(`  ${h.file}:${h.line}  ${h.why}\n    ${h.code}`);
  process.exitCode = 1;
} else {
  console.log(`NO_BATCH_ELECTRON_KILL_OK（扫描 ${files.length} 个脚本，未发现按名称/路径批量杀 electron；只允许 taskkill /PID <自己 spawn 的 pid> 与 child.kill()）`);
}
