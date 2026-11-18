#!/usr/bin/env node
'use strict';
/**
 * 夹具（T-20261118-184943-6b24）：看板 HTML「磁盘复用」新鲜性判据（src/board-freshness.js）。
 *
 * 背景：冷开时若 团队/看板.html 比它的数据依赖（工作流.json / 任务目录）不相旧，就直接 loadFile 跳过
 * generateBoard（tester 净机实测冷开 T3 从 6636 → 1370ms）。**必须保证依赖变了就不能复用旧看板**，
 * 否则会展示过期内容。本夹具用临时目录覆盖四种情形：
 *   F1 看板比依赖新 → fresh=true（可复用，跳过生成）
 *   F2 工作流.json 比看板新 → fresh=false（必须重建）
 *   F3 任务目录比看板新 → fresh=false（必须重建）
 *   F4 依赖缺失（任务目录被删）→ fresh=false（不猜，保守重建）
 *   F5 看板不存在 → null（调用方照旧生成）
 *   F6 看板为空文件 → null
 *   F7 mtime 相等 → fresh=true（同一次生成）
 *   F8 传 project 名也能定位项目目录（projectDir 省略路径）
 * 跑法：node scripts/test-d5ec-board-freshness.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { boardHtmlFreshInfo } = require(path.join(ROOT, 'src', 'board-freshness.js'));

let pass = 0;
let fail = 0;
const ok = (cond, name, detail) => {
  if (cond) { pass += 1; console.log(`PASS ${name}`); } else { fail += 1; console.log(`FAIL ${name} :: ${JSON.stringify(detail || {})}`); }
};
const setMtime = (file, ms) => { const t = new Date(ms); fs.utimesSync(file, t, t); };

function makeSandbox() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'd5ec-fresh-'));
  const teamRoot = path.join(dir, '团队');
  const projectDir = path.join(teamRoot, '状态', '项目', '工作台改造修复');
  fs.mkdirSync(path.join(projectDir, '任务'), { recursive: true });
  const html = path.join(teamRoot, '看板.html');
  const wf = path.join(projectDir, '工作流.json');
  const tasks = path.join(projectDir, '任务');
  fs.writeFileSync(html, '<html>board</html>');
  fs.writeFileSync(wf, '{"requirements":[]}');
  fs.writeFileSync(path.join(tasks, 'T-1.json'), '{}');
  return { dir, teamRoot, projectDir, html, wf, tasks };
}

function run() {
  const base = makeSandbox();
  try {
    const T0 = Date.parse('2026-11-18T10:00:00Z');
    // F1 看板新于依赖
    setMtime(base.wf, T0 - 60000);
    setMtime(base.tasks, T0 - 60000);
    setMtime(base.html, T0);
    const f1 = boardHtmlFreshInfo({ teamRoot: base.teamRoot, projectDir: base.projectDir });
    ok(f1 && f1.fresh === true, 'F1 看板比依赖新 → fresh=true（可复用）', f1);

    // F2 工作流比看板新
    setMtime(base.wf, T0 + 60000);
    const f2 = boardHtmlFreshInfo({ teamRoot: base.teamRoot, projectDir: base.projectDir });
    ok(f2 && f2.fresh === false, 'F2 工作流.json 更新 → fresh=false（必须重建）', f2);

    // F3 任务目录比看板新
    setMtime(base.wf, T0 - 60000);
    setMtime(base.tasks, T0 + 120000);
    const f3 = boardHtmlFreshInfo({ teamRoot: base.teamRoot, projectDir: base.projectDir });
    ok(f3 && f3.fresh === false, 'F3 任务目录更新 → fresh=false（必须重建）', f3);

    // F4 依赖缺失
    fs.rmSync(base.tasks, { recursive: true, force: true });
    const f4 = boardHtmlFreshInfo({ teamRoot: base.teamRoot, projectDir: base.projectDir });
    ok(f4 && f4.fresh === false, 'F4 任务目录缺失 → fresh=false（不猜、重建）', f4);

    // F5 看板不存在
    const f5 = boardHtmlFreshInfo({ teamRoot: path.join(base.dir, '不存在的团队'), projectDir: base.projectDir });
    ok(f5 === null, 'F5 看板不存在 → null（照旧生成）', f5);

    // F6 看板为空文件
    const empty = makeSandbox();
    try {
      fs.writeFileSync(empty.html, '');
      const f6 = boardHtmlFreshInfo({ teamRoot: empty.teamRoot, projectDir: empty.projectDir });
      ok(f6 === null, 'F6 看板为空 → null（照旧生成）', f6);
    } finally { fs.rmSync(empty.dir, { recursive: true, force: true }); }

    // F7 mtime 相等 → 可复用
    const eq = makeSandbox();
    try {
      const T1 = Date.parse('2026-11-18T11:00:00Z');
      setMtime(eq.wf, T1); setMtime(eq.tasks, T1); setMtime(eq.html, T1);
      const f7 = boardHtmlFreshInfo({ teamRoot: eq.teamRoot, projectDir: eq.projectDir });
      ok(f7 && f7.fresh === true, 'F7 mtime 相等（同一次生成）→ fresh=true', f7);
    } finally { fs.rmSync(eq.dir, { recursive: true, force: true }); }

    // F8 用 project 名推导项目目录
    const byName = makeSandbox();
    try {
      setMtime(byName.wf, T0 - 60000); setMtime(byName.tasks, T0 - 60000); setMtime(byName.html, T0);
      const f8 = boardHtmlFreshInfo({ teamRoot: byName.teamRoot, project: { name: '工作台改造修复' } });
      ok(f8 && f8.fresh === true && f8.bytes > 0, 'F8 只传 project 名也能判定 → fresh=true', f8);
    } finally { fs.rmSync(byName.dir, { recursive: true, force: true }); }
  } finally {
    fs.rmSync(base.dir, { recursive: true, force: true });
  }

  console.log(`\nD5EC_BOARD_FRESHNESS ${pass}/${pass + fail} PASS`);
  process.exitCode = fail === 0 ? 0 : 1;
}

run();
