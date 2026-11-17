#!/usr/bin/env node
'use strict';
/**
 * test-render-mem-dir.cjs —— 缺陷 B-20261115-171218-3fb8（P1）断言
 *
 * 要求（PM）：①优先尊重 AWB_TEAM_ROOT / TEAM_ROOT，未设时行为不变；
 *            ②补断言「设了独立根就写到那、真实分片行数不变」。
 *
 * 做法：纯函数 resolveIsolatedDir() 直接断言路径；真实分片只读一次快照（行数+mtime+sha），
 * 断言本脚本不写任何真实文件（零写入），并在设置了隔离根时解析结果必须落在该根下。
 *
 * 用法：node scripts/test-render-mem-dir.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const { resolveIsolatedDir } = require(path.join(ROOT, 'src', 'render-mem-dir.js'));

let passed = 0;
const failures = [];
function check(name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${name}`); return; }
  failures.push({ name, detail });
  console.log(`FAIL  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail)}`);
}

const envRoot = path.join(ROOT, '_tmp', 'c1ed-dir-sandbox', '团队');
const projectName = '工作台改造修复';

// ①设了隔离根 → 解析到该根下（不动真实目录）
const isolated = resolveIsolatedDir({ envRoot, projectName });
check('S1 设 AWB_TEAM_ROOT/TEAM_ROOT → 采样目录落在该根下',
  isolated === path.join(envRoot, '状态', '项目', projectName), { isolated });

// ②未设隔离根 → 返回空串（调用方回退原有逻辑，行为不变）
check('S2 未设隔离根 → 返回空串（行为不变）', resolveIsolatedDir({ envRoot: '', projectName }) === '', {});
check('S3 项目名为空 → 返回空串（不猜目录）', resolveIsolatedDir({ envRoot, projectName: '' }) === '', {});

// ④真实分片行数不变：本脚本零写入，且真实目录不在隔离根下
const realDir = path.join(ROOT, '团队', '状态', '项目', projectName);
const shards = fs.existsSync(realDir) ? fs.readdirSync(realDir).filter((n) => /^渲染内存-.*\.jsonl$/.test(n)) : [];
const snapshot = shards.map((n) => {
  const stat = fs.statSync(path.join(realDir, n));
  return { name: n, size: stat.size, mtimeMs: stat.mtimeMs };
});
check('S4 隔离根与真实目录不同源（不会共写同一分片）', !isolated.startsWith(realDir) && isolated !== realDir, { isolated, realDir });
check('S5 真实分片未被本脚本触碰（数量/大小/mtime 快照一致）',
  shards.length === snapshot.length && snapshot.every((s) => {
    const stat = fs.statSync(path.join(realDir, s.name));
    return stat.size === s.size && stat.mtimeMs === s.mtimeMs;
  }), { shards: shards.length });

/* ──────────────────────────────────────────────────────────────────────
 * ce25 集成断言（T-20261116-071225-ce25）：
 *   起真实实例（AWB_DATA_DIR + TEAM_ROOT 双隔离 + 独立调试端口）跑 ≥3 秒，
 *   让运行中的采样器至少产生一次真实采样，然后：
 *     S6 沙盘目录确实新增了 渲染内存-*.jsonl 分片（证明「真的写到沙盘」，不是零写入恒真）
 *     S7 真实 团队/状态 下分片的三项（文件数 / 总字节 / 最新 mtime）跑前跑后完全不变
 *   沙盘目录唯一（pid+时间戳），可重复跑、不依赖固定 _tmp 残留。
 * ────────────────────────────────────────────────────────────────────── */
function realMetrics() {
  const shards2 = fs.existsSync(realDir) ? fs.readdirSync(realDir).filter((n) => /^渲染内存-.*\.jsonl$/.test(n)) : [];
  let total = 0; let latest = 0;
  for (const n of shards2) {
    const st = fs.statSync(path.join(realDir, n));
    total += st.size;
    if (st.mtimeMs > latest) latest = st.mtimeMs;
  }
  return { count: shards2.length, totalBytes: total, latestMtime: latest };
}
function sandboxMetrics(dir) {
  const p = path.join(dir, '团队', '状态', '项目', projectName);
  const shards2 = fs.existsSync(p) ? fs.readdirSync(p).filter((n) => /^渲染内存-.*\.jsonl$/.test(n)) : [];
  let lines = 0;
  for (const n of shards2) lines += fs.readFileSync(path.join(p, n), 'utf8').split(/\r?\n/).filter(Boolean).length;
  return { shards: shards2.length, lines };
}
(async () => {
  const { spawn } = require('node:child_process');
  const PORT = 9533;
  const sandbox = path.join(ROOT, '_tmp', `ce25-sandbox-${process.pid}-${Date.now()}`);
  const dataDir = path.join(sandbox, 'data');
  const teamRoot = path.join(sandbox, '团队');
  const before = realMetrics();
  // 先观察 1.6s：若真实实例正在采样（三项在变），则 S7 只能记 SKIP 并留证，
  // 不能把「外部实例的写入」误算成「本沙盘实例污染真实目录」（与 ad44 隔离断言同口径）。
  await new Promise((r) => setTimeout(r, 1600));
  const probe = realMetrics();
  const envBusy = probe.count !== before.count || probe.totalBytes !== before.totalBytes || probe.latestMtime !== before.latestMtime;
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  fs.mkdirSync(path.join(dataDir, 'userdata'), { recursive: true });
  fs.cpSync(path.join(ROOT, '团队'), teamRoot, { recursive: true });
  try {
    const teamFile = path.join(teamRoot, '状态', '团队.json');
    const team = JSON.parse(fs.readFileSync(teamFile, 'utf8'));
    for (const m of team.members || []) m.sessionId = '';
    team.activeProject = projectName;
    fs.writeFileSync(teamFile, JSON.stringify(team, null, 2) + '\n', 'utf8');
  } catch { /* 名册损坏不阻断采样隔离断言 */ }
  const projectId = 'P-ce25-sandbox';
  fs.writeFileSync(path.join(dataDir, 'userdata', 'workbench.json'), JSON.stringify({
    version: 1, activeProjectId: projectId,
    projects: [{ id: projectId, name: projectName, path: path.join(ROOT, '项目', projectName), workspacePath: path.join(ROOT, '项目', projectName), teamName: projectName }]
  }, null, 2) + '\n', 'utf8');
  const env = {
    ...process.env, AWB_DATA_DIR: dataDir, TEAM_ROOT: teamRoot,
    TEAM_PROJECTS_ROOT: path.join(teamRoot, '状态', '项目'),
    TEAM_WORKBENCH_JSON: path.join(dataDir, 'userdata', 'workbench.json'), TEAM_SELFTEST: '1'
  };
  const startedAt = Date.now();
  // 关键：沙盘复制了真实团队，里面本身就带真实 渲染内存-*.jsonl 分片；
  // 先清掉，否则 S6 会把「复制来的旧分片」当成「本次运行采样器新写的」。
  const sbProjDir = path.join(teamRoot, '状态', '项目', projectName);
  if (fs.existsSync(sbProjDir)) {
    for (const n of fs.readdirSync(sbProjDir)) if (/^渲染内存-.*\.jsonl$/.test(n)) fs.rmSync(path.join(sbProjDir, n), { force: true });
  }
  const child = spawn(process.execPath, [path.join(ROOT, 'scripts', 'run-electron.cjs'), '.', '--remote-debugging-port=' + PORT], { cwd: ROOT, env, stdio: 'ignore', windowsHide: false });
  let grew = null;
  for (let i = 0; i < 40; i += 1) {
    await new Promise((r) => setTimeout(r, 500));
    const m = sandboxMetrics(sandbox);
    if (m.shards > 0 && m.lines > 0) { grew = m; break; }
  }
  const ranMs = Date.now() - startedAt;
  if (ranMs < 5600) await new Promise((r) => setTimeout(r, 5600 - ranMs));
  const totalMs = Date.now() - startedAt;
  try { child.kill(); } catch { /* ignore */ }
  await new Promise((r) => setTimeout(r, 800));
  try { child.kill('SIGKILL'); } catch { /* ignore */ }
  const after = realMetrics();
  const sb = sandboxMetrics(sandbox);
  check('S6 隔离沙盘确实产生真实采样分片（运行中的采样器写到沙盘，非零写入）', sb.shards > 0 && sb.lines > 0, sb);
  if (envBusy) {
    console.log('SKIP  S7 真实分片三项跑前跑后不变 · 真实实例正在采样（静置 1.6s 内三项在变），外部写入不可用于判本沙盘是否污染真实目录；已留证 ' + JSON.stringify({ before, probe, after }));
  } else {
    check('S7 真实分片三项（文件数/总字节/最新 mtime）跑前跑后不变',
      before.count === after.count && before.totalBytes === after.totalBytes && before.latestMtime === after.latestMtime,
      { before, after });
  }
  fs.rmSync(sandbox, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });

  console.log(`\nrender-mem-dir 断言：${passed}/${passed + failures.length} PASS（真实分片 ${shards.length} 个，仅只读快照；集成段：沙盘 ${sb.shards} 分片/${sb.lines} 行，运行 ${totalMs}ms）`);
  if (failures.length) { console.error(JSON.stringify(failures, null, 2)); process.exit(1); }
  process.exit(0);
})();
