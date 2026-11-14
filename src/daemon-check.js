'use strict';
/**
 * T-20261114-063256-b417 自检（--daemon-check）：路由守护状态可见
 *
 * 覆盖：三态（运行中 / 已停止 / 心跳超时）+ 超 3 周期标红 + 只读隔离。
 * 所有造数只在沙盘团队根（.daemon-check-data/团队）里写守护状态.json；
 * 真实项目的守护心跳只做「sha256 + mtime 未被碰」断言，不读也不写。
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const READ_PILL = `(() => {
  const el = document.getElementById('daemon-pill');
  if (!el) return { ok: false, why: '没有 #daemon-pill' };
  const box = el.getBoundingClientRect();
  return {
    ok: true,
    state: String(el.dataset.daemonState || ''),
    beat: String(el.dataset.daemonBeat || ''),
    pid: String(el.dataset.daemonPid || ''),
    text: String(el.textContent || '').trim(),
    className: String(el.className || ''),
    title: String(el.title || ''),
    color: getComputedStyle(el).color,
    visible: box.width > 0 && box.height > 0,
    inViewport: box.top >= 0 && box.bottom <= window.innerHeight,
  };
})()`;

function sha256Of(file) {
  try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex'); } catch { return ''; }
}
function statOf(file) {
  try { const st = fs.statSync(file); return { exists: true, mtimeMs: st.mtimeMs, sha256: sha256Of(file) }; } catch { return { exists: false, mtimeMs: 0, sha256: '' }; }
}

/** 沙盘准备：团队状态根建好；状态库缺失时从真实 store 只读复制（不写真实文件）。 */
function prepareDaemonCheckSandbox(options = {}) {
  const teamRoot = String(options.teamRoot || '');
  if (teamRoot) fs.mkdirSync(path.join(teamRoot, '状态', '项目'), { recursive: true });
  const storeFile = String(options.storeFile || '');
  const fallback = String(options.fallbackStoreFile || '');
  let needSeed = Boolean(storeFile && fallback && fs.existsSync(fallback) && !fs.existsSync(storeFile));
  if (!needSeed && storeFile && fallback && fs.existsSync(fallback) && fs.existsSync(storeFile)) {
    // 空库（Electron 首次启动会先落一个没有项目的 store）也要换成真实 store 的只读副本。
    try {
      const parsed = JSON.parse(fs.readFileSync(storeFile, 'utf8').replace(/^\uFEFF/, ''));
      needSeed = !parsed || !Array.isArray(parsed.projects) || !parsed.projects.length;
    } catch { needSeed = true; }
  }
  if (needSeed) {
    fs.mkdirSync(path.dirname(storeFile), { recursive: true });
    fs.copyFileSync(fallback, storeFile);
    console.log('DAEMON_CHECK_STORE_SEEDED ' + JSON.stringify({ from: fallback, to: storeFile }));
  }
  return { teamRoot, storeFile };
}

async function runDaemonCheck({ app, createWindow, getWindow, readStore, outRoot, statusFile, realStatusFile, teamName, sandboxTeamRoot, sandboxRoot }) {
  const outDir = process.env.AWB_DAEMON_OUT ? path.resolve(process.env.AWB_DAEMON_OUT) : path.join(outRoot, '_tmp', 'daemon-check-' + Date.now());
  fs.mkdirSync(outDir, { recursive: true });
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok: Boolean(ok), detail });
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)}`);
    return ok;
  };
  const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
  const sandboxStatus = String(statusFile || '');
  const sandboxRootPath = path.resolve(String(sandboxTeamRoot || ''));
  const realStatus = String(realStatusFile || '');
  const realBefore = realStatus ? statOf(realStatus) : { exists: false, mtimeMs: 0, sha256: '' };

  createWindow();
  const win = getWindow();
  await new Promise((resolve) => { if (win.webContents.isLoading()) win.webContents.once('did-finish-load', resolve); else resolve(); });
  await wait(1800);
  const shot = async (name) => {
    try { const file = path.join(outDir, name); fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); return file; } catch { return ''; }
  };
  const evalJs = (expr) => win.webContents.executeJavaScript(expr, true);
  const readPill = async () => {
    await evalJs("(() => { const b = document.getElementById('daemon-pill'); if (b) b.click(); return true; })()");
    await wait(900);
    return evalJs(READ_PILL);
  };
  const writeStatus = (patch) => {
    fs.mkdirSync(path.dirname(sandboxStatus), { recursive: true });
    fs.writeFileSync(sandboxStatus, JSON.stringify({ version: 'b5fc-route-1', startedAt: new Date().toISOString(), ...patch }, null, 2) + '\n', 'utf8');
  };

  check('沙盘路径已拿到（守护状态写在沙盘团队根下）', Boolean(sandboxStatus) && path.resolve(sandboxStatus).startsWith(sandboxRootPath + path.sep), { sandboxStatus, sandboxTeamRoot: sandboxRootPath });
  check('沙盘确实隔离：数据根在本次 daemon-check 目录', Boolean(sandboxRoot) && sandboxRootPath.startsWith(path.resolve(String(sandboxRoot))), { sandboxRoot, teamRoot: sandboxRootPath });
  if (!sandboxStatus) {
    const failed = checks.filter((row) => !row.ok);
    fs.writeFileSync(path.join(outDir, 'daemon-check.json'), JSON.stringify({ ok: false, total: checks.length, failed: failed.length, outDir, checks, fatal: '没有沙盘守护状态路径' }, null, 2), 'utf8');
    app.exit(1);
    return;
  }

  // ① 没有状态文件 = 已停止（不编造运行中）
  fs.rmSync(sandboxStatus, { force: true });
  const nonePill = await readPill();
  check('没有守护心跳 → 已停止（灰，不报红）', nonePill.ok && nonePill.state === 'stopped' && /已停止/.test(nonePill.text) && !/daemon-stale/.test(nonePill.className), { state: nonePill.state, text: nonePill.text, className: nonePill.className });

  // ② 运行中：心跳新鲜 + pid 活着
  writeStatus({ alive: true, pid: process.pid, lastBeatAt: new Date().toISOString(), ticks: 12 });
  const runningPill = await readPill();
  const runningShot = await shot('daemon-running.png');
  check('心跳新鲜 + 进程在 → 运行中', runningPill.ok && runningPill.state === 'running' && /运行中/.test(runningPill.text), { state: runningPill.state, text: runningPill.text, beat: runningPill.beat });
  check('运行中不标红（无 daemon-stale、颜色不是红）', !/daemon-stale/.test(runningPill.className) && !isRed(runningPill.color), { className: runningPill.className, color: runningPill.color });
  check('运行中徽标在侧栏可见且不溢出视口', runningPill.visible === true && runningPill.inViewport === true, { visible: runningPill.visible, inViewport: runningPill.inViewport });

  // ③ 心跳超时（> 3 个 30 秒周期）→ 标红
  writeStatus({ alive: true, pid: process.pid, lastBeatAt: new Date(Date.now() - 120 * 1000).toISOString(), ticks: 3 });
  const stalePill = await readPill();
  const staleShot = await shot('daemon-stale.png');
  check('心跳超 3 周期 → 心跳超时', stalePill.ok && stalePill.state === 'stale' && /心跳超时/.test(stalePill.text), { state: stalePill.state, text: stalePill.text, beat: stalePill.beat });
  check('心跳超时标红（daemon-stale + 计算色为红）', /daemon-stale/.test(stalePill.className) && isRed(stalePill.color), { className: stalePill.className, color: stalePill.color });
  check('超时提示写清「超过 3 个周期」', /3\s*个周期/.test(stalePill.title || ''), String(stalePill.title || '').slice(0, 120));

  // ④ 进程不在（alive 字段还是 true 也不冒充运行中）→ 已停止
  const dayPid = findDeadPid();
  writeStatus({ alive: true, pid: dayPid || 0, lastBeatAt: new Date().toISOString(), ticks: 20 });
  const deadPill = await readPill();
  check('心跳新鲜但进程已不在 → 已停止（不冒充运行中）', deadPill.ok && deadPill.state === 'stopped' && /已停止/.test(deadPill.text), { state: deadPill.state, text: deadPill.text, pid: deadPill.pid });
  const stoppedShot = await shot('daemon-stopped.png');

  // ⑤ alive=false → 已停止
  writeStatus({ alive: false, pid: process.pid, lastBeatAt: new Date().toISOString(), stoppedAt: new Date().toISOString(), ticks: 21 });
  const offPill = await readPill();
  check('alive=false → 已停止', offPill.ok && offPill.state === 'stopped' && /已停止/.test(offPill.text), { state: offPill.state, text: offPill.text });

  // ⑥ 只读隔离：真实守护心跳没被碰
  if (realStatus) {
    const realAfter = statOf(realStatus);
    check('隔离：真实项目 守护状态.json 的 sha256 与 mtime 未被碰', realAfter.exists === realBefore.exists && realAfter.sha256 === realBefore.sha256 && realAfter.mtimeMs === realBefore.mtimeMs, { realStatus, before: realBefore.sha256.slice(0, 16), after: realAfter.sha256.slice(0, 16) });
  } else {
    check('隔离：真实项目 守护状态.json 不存在（不创建）', true, '没有真实心跳文件');
  }

  const failed = checks.filter((row) => !row.ok);
  const report = {
    ok: failed.length === 0, total: checks.length, failed: failed.length, outDir,
    sandbox: { teamRoot: sandboxRootPath, statusFile: sandboxStatus, realStatusFile: realStatus || '' },
    checks,
    screenshots: { running: runningShot, stale: staleShot, stopped: stoppedShot },
  };
  fs.writeFileSync(path.join(outDir, 'daemon-check.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('DAEMON_CHECK ' + JSON.stringify({ ok: report.ok, total: report.total, failed: report.failed, outDir }));
  app.exit(report.ok ? 0 : 1);
}

/** 红的判定：CSS var(--red) 是暖红（R 明显大于 G/B）；灰/绿都不满足。 */
function isRed(color) {
  const m = /rgba?\((\d+),\s*(\d+),\s*(\d+)/.exec(String(color || ''));
  if (!m) return false;
  const [r, g, b] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return r >= 150 && r - g >= 40 && r - b >= 40;
}

/** 找一个几乎肯定不存在的 pid（用于「心跳新鲜但进程不在」）。 */
function findDeadPid() {
  for (const pid of [999999, 999998, 999997, 888888]) {
    try { process.kill(pid, 0); } catch (error) { if (error && error.code === 'ESRCH') return pid; }
  }
  return 0;
}

module.exports = { runDaemonCheck, prepareDaemonCheckSandbox };
