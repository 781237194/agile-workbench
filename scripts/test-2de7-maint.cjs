#!/usr/bin/env node
'use strict';
/**
 * test-2de7-maint.cjs —— R-2de7 一键重置 / 彻底卸载（T-20261119-212641-33a8）夹具
 *
 * 覆盖（全部 -Sandbox：系统级六类只出计划，真实用户态零写入）：
 *   A1 干跑：-Reset 无 -Yes → 仅清单 dryRun:true、文件与 sha 不变，exit 0
 *   A2 确认短语错 → CONFIRM_MISMATCH、零删除、exit 2
 *   A3 重置执行：删项消失、留项（项目/团队产出/node_modules 哨兵）sha 不变、备份 zip 在 Root 外的 <Root>-maint-backup、重跑全 already
 *   A4 并发：另一进程持锁 → LOCK_HELD、零删除、exit 2
 *   A5 越界路径：注入外部路径 → PATH_NOT_ALLOWED 零删除
 *   B1 卸载默认档：zip 含 项目 文件 → Root 消失、userDataDeleted、exit 0
 *   B2 KeepData：项目+团队产出 留、程序与 data 消失
 *   B3 Purge：无备份整删（短语 彻底卸载-无备份）
 *   C1 VerifyClean -Mode reset（带残留根）→ RESIDUE/退出码 2；干净根 → CLEAN/0；-Json 与人类判定同源
 *   C2 真实用户态零写入（不碰 HKCU/env/hosts/计划任务/DSH 真实 profile）
 *
 * 跑法：node scripts/test-2de7-maint.cjs [--out <证据目录>]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawn, spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const INSTALL = path.join(ROOT, 'install.ps1');
const DIAG = path.join(ROOT, '发布', 'tools', 'awb-diag.ps1');
const OUT = (() => {
  const i = process.argv.indexOf('--out');
  return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-2de7');
})();
const rows = [];
function check(name, ok, detail) {
  let text = ''; try { text = JSON.stringify(detail === undefined ? null : detail); } catch { text = String(detail); }
  rows.push({ name, ok: Boolean(ok), detail: ok ? undefined : text });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : ' :: ' + text.slice(0, 700)));
}
const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');
const shaFile = (f) => { try { return sha(fs.readFileSync(f)); } catch { return '-'; } };
const readJson = (f) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return null; } };
function skip(name, reason) {
  rows.push({ name, ok: true, skipped: true, detail: 'SKIPPED: ' + String(reason || '') });
  console.log('SKIP  ' + name + ' :: ' + String(reason || ''));
}

// 真实用户态只从环境变量取（不写死盘符；取不到就 SKIP，不回落任何绝对路径）
const winRoot = String(process.env.SystemRoot || process.env.windir || '').trim();
function realHostsSha() {
  if (!winRoot) return '';
  const hostsFile = path.join(winRoot, 'System32', 'drivers', 'etc', 'hosts');
  const sha = shaFile(hostsFile);
  return sha === '-' ? '' : sha;
}

function writeFile(file, text) { fs.mkdirSync(path.dirname(file), { recursive: true }); fs.writeFileSync(file, text, 'utf8'); }

function runPwsh(file, args, opts = {}) {
  return new Promise((resolve) => {
    const child = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', file, ...args], {
      cwd: opts.cwd || ROOT,
      env: { ...process.env, ...(opts.env || {}) },
      windowsHide: true,
    });
    let stdout = ''; let stderr = ''; let settled = false;
    const timer = setTimeout(() => { try { child.kill(); } catch { /* ignore */ } }, 240000);
    const finish = (payload) => { if (settled) return; settled = true; clearTimeout(timer); resolve(payload); };
    child.stdout.on('data', (d) => { stdout += String(d); });
    child.stderr.on('data', (d) => { stderr += String(d); });
    child.on('close', (code) => finish({ status: code, stdout, stderr }));
    child.on('error', (error) => finish({ status: -1, stdout, stderr: stderr + String((error && error.message) || error) }));
  });
}

function parseJsonOut(text) {
  const marker = 'AWB_MAINT_JSON:';
  const at = text.indexOf(marker);
  const start = at >= 0 ? text.indexOf('{', at) : text.indexOf('{');
  if (start < 0) return null;
  const end = text.lastIndexOf('}');
  if (end <= start) return null;
  try { return JSON.parse(text.slice(start, end + 1)); } catch { return null; }
}

function seedInstallTree(root, sb) {
  writeFile(path.join(root, 'package.json'), JSON.stringify({ name: 'pm-workbench', version: '2.1.5' }, null, 2));
  writeFile(path.join(root, 'start.cmd'), '@echo off\r\n exit /b 0\r\n');
  writeFile(path.join(root, 'src', 'main.js'), '// sandbox app\n');
  writeFile(path.join(root, 'node_modules', 'sentinel.txt'), 'keep-node-modules\n');
  writeFile(path.join(root, '团队', '状态', '团队.json'), JSON.stringify({ sentinel: 'state' }, null, 2));
  writeFile(path.join(root, '团队', '产出', 'out.md'), 'keep team output\n');
  writeFile(path.join(root, '团队', '看板.json'), '{"derive":true}\n');
  writeFile(path.join(root, '项目', 'p1', '需求', 'R-x.md'), 'keep requirement doc\n');
  writeFile(path.join(root, 'data', 'userdata', 'workbench.json'), '{"ui":{"effectLevel":"full"}}\n');
  writeFile(path.join(root, 'data', 'dsh-capability.json'), '{"ok":false}\n');
  writeFile(path.join(root, '_tmp', 'x.txt'), 'tmp\n');
  writeFile(path.join(root, '.selftest-data', 'a.txt'), 'selftest\n');
  // 假系统级位置
  writeFile(path.join(sb, 'lad', 'PMWorkbench', 'install-logs', 'a.log'), 'log\n');
  writeFile(path.join(sb, 'tmp', 'pm-workbench-x', 'f.txt'), 'tmp\n');
  writeFile(path.join(sb, 'dsh', 'profiles', 'desktop', 'package.json'), JSON.stringify({
    name: 'desktop-profile',
    bundles: ['@deepseek-ai/core', 'pm-workbench-dsh'],
    dependencies: { 'pm-workbench-dsh': 'file:' + path.join(root, 'dsh-plugin'), '@deepseek-ai/core': '1.0.0' },
    extra: { keep: true },
  }, null, 2));
  writeFile(path.join(sb, 'hosts'), ['127.0.0.1 localhost', '# >>> PMWorkbench GitHubFix >>>', '1.2.3.4 raw.githubusercontent.com', '# <<< PMWorkbench GitHubFix <<<', '8.8.8.8 keep.example'].join('\r\n') + '\r\n');
  fs.mkdirSync(path.join(sb, 'desk'), { recursive: true });
}

function maintArgs(root, sb, extra = []) {
  return ['-Root', root, '-Sandbox', '-DshHome', path.join(sb, 'dsh'), '-LocalAppDataDir', path.join(sb, 'lad'),
    '-TempDir', path.join(sb, 'tmp'), '-ShortcutDir', path.join(sb, 'desk'), '-GitHubFixHostsPath', path.join(sb, 'hosts'), ...extra];
}

function listBackups(sb, root) {
  const dir = path.join(path.dirname(root), path.basename(root) + '-maint-backup');
  const zips = [];
  const walk = (d) => {
    if (!fs.existsSync(d)) return;
    for (const entry of fs.readdirSync(d, { withFileTypes: true })) {
      const f = path.join(d, entry.name);
      if (entry.isDirectory()) walk(f);
      else if (entry.name.toLowerCase().endsWith('.zip')) zips.push(f);
    }
  };
  walk(dir);
  return { dir, zips };
}

(async () => {
  const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-2de7-'));
  const userStateSentinels = {
    hosts: realHostsSha(),
  };
  try {
    // ── A 重置 ────────────────────────────────────────────────────────
    const root = path.join(sb, 'root');
    seedInstallTree(root, sb);
    const keepShas = {
      req: shaFile(path.join(root, '项目', 'p1', '需求', 'R-x.md')),
      out: shaFile(path.join(root, '团队', '产出', 'out.md')),
      nodeModules: shaFile(path.join(root, 'node_modules', 'sentinel.txt')),
    };

    const dry = await runPwsh(INSTALL, ['-Reset', ...maintArgs(root, sb), '-Json']);
    const dryJson = parseJsonOut(dry.stdout);
    check('A1 干跑：无 -Yes → dryRun:true、exit 0、文件仍在',
      dry.status === 0 && Boolean(dryJson && dryJson.dryRun === true) && fs.existsSync(path.join(root, 'data', 'userdata', 'workbench.json')),
      { status: dry.status, tail: dry.stdout.slice(-300) });

    const mismatch = await runPwsh(INSTALL, ['-Reset', '-Yes', '-Confirm', '错误短语', ...maintArgs(root, sb), '-Json']);
    const mismatchJson = parseJsonOut(mismatch.stdout);
    check('A2 确认短语错 → CONFIRM_MISMATCH、零删除、exit 2',
      mismatch.status === 2 && Boolean(mismatchJson && mismatchJson.code === 'CONFIRM_MISMATCH')
      && fs.existsSync(path.join(root, 'data', 'userdata', 'workbench.json')), { status: mismatch.status, json: mismatchJson && { code: mismatchJson.code } });

    const reset = await runPwsh(INSTALL, ['-Reset', '-Yes', '-Confirm', '重置', ...maintArgs(root, sb), '-Json']);
    const resetJson = parseJsonOut(reset.stdout);
    check('A3a 重置执行成功（exit 0 + verdict CLEAN）',
      reset.status === 0 && Boolean(resetJson && String(resetJson.verdict || '') === 'CLEAN'), { status: reset.status, json: resetJson && { verdict: resetJson.verdict, code: resetJson.code } });
    check('A3b 删项全无（data\\userdata、团队\\状态、_tmp、.selftest-data、看板）',
      !fs.existsSync(path.join(root, 'data', 'userdata')) && !fs.existsSync(path.join(root, '团队', '状态'))
      && !fs.existsSync(path.join(root, '_tmp')) && !fs.existsSync(path.join(root, '.selftest-data'))
      && !fs.existsSync(path.join(root, '团队', '看板.json')), null);
    check('A3c 留项 sha 不变（项目需求/团队产出/node_modules 哨兵）',
      shaFile(path.join(root, '项目', 'p1', '需求', 'R-x.md')) === keepShas.req
      && shaFile(path.join(root, '团队', '产出', 'out.md')) === keepShas.out
      && shaFile(path.join(root, 'node_modules', 'sentinel.txt')) === keepShas.nodeModules, null);
    const backups = listBackups(sb, root);
    check('A3d 备份 zip 落在 Root 外同级 <Root>-maint-backup 且存在',
      backups.zips.length === 1 && !backups.dir.toLowerCase().startsWith(root.toLowerCase() + path.sep), backups);
    check('A3e 清单 maint.json 记录 backupZip 与 summary 字段',
      Boolean(resetJson && resetJson.manifestFile && fs.existsSync(resetJson.manifestFile)), resetJson && { manifest: resetJson.manifestFile });

    const reset2 = await runPwsh(INSTALL, ['-Reset', '-Yes', '-Confirm', '重置', ...maintArgs(root, sb), '-Json']);
    const reset2Json = parseJsonOut(reset2.stdout);
    check('A3f 重跑幂等：不产第二份备份、删项全 already',
      reset2.status === 0 && listBackups(sb, root).zips.length === 1
      && (reset2Json.items || []).filter((i) => i.action === 'delete').every((i) => i.result === 'already' || i.result === 'skipped_sandbox'),
      { status: reset2.status, zips: listBackups(sb, root).zips.length });

    // A4 并发锁：另一进程持 FileShare.None 锁
    const lockFile = path.join(root, '.awb-maint.lock');
    writeFile(lockFile, '');
    const holder = path.join(sb, 'hold-lock.ps1');
    writeFile(holder, [
      'param()',
      '$s = [System.IO.File]::Open("' + lockFile.replace(/\\/g, '\\\\') + '", [System.IO.FileMode]::OpenOrCreate, [System.IO.FileAccess]::ReadWrite, [System.IO.FileShare]::None)',
      'Start-Sleep -Seconds 8',
      '$s.Dispose()',
    ].join('\r\n'));
    const holderProc = spawn('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', holder], { windowsHide: true, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 1200));
    const locked = await runPwsh(INSTALL, ['-Reset', '-Yes', '-Confirm', '重置', ...maintArgs(root, sb), '-Json']);
    const lockedJson = parseJsonOut(locked.stdout);
    try { holderProc.kill(); } catch { /* ignore */ }
    check('A4 并发：另一进程持锁 → LOCK_HELD、退出码 2、未删除（留项仍在）',
      locked.status === 2 && Boolean(lockedJson && lockedJson.code === 'LOCK_HELD') && fs.existsSync(path.join(root, '项目', 'p1', '需求', 'R-x.md')),
      { status: locked.status, json: lockedJson && { code: lockedJson.code } });

    // A5 越界路径
    const bad = await runPwsh(INSTALL, ['-Reset', '-Yes', '-Confirm', '重置', ...maintArgs(root, sb), '-Json'], { env: { AWB_MAINT_TEST_BAD_PATH: path.join(sb, 'outside', 'x.txt') } });
    const badJson = parseJsonOut(bad.stdout);
    check('A5 越界路径 → PATH_NOT_ALLOWED、exit 2、零删除',
      bad.status === 2 && Boolean(badJson && badJson.code === 'PATH_NOT_ALLOWED'), { status: bad.status, json: badJson && { code: badJson.code } });

    // ── B 卸载三档 ────────────────────────────────────────────────────
    const rootB = path.join(sb, 'rootB');
    seedInstallTree(rootB, sb);
    const un1 = await runPwsh(INSTALL, ['-Uninstall', '-Yes', '-Confirm', '彻底卸载', ...maintArgs(rootB, sb), '-Json']);
    const un1Json = parseJsonOut(un1.stdout);
    const backupsB = listBackups(sb, rootB);
    check('B1 卸载默认档：Root 消失 + userDataDeleted + 备份 zip 在 Root 外',
      un1.status === 0 && !fs.existsSync(rootB) && Boolean(un1Json && un1Json.userDataDeleted === true) && backupsB.zips.length === 1,
      { status: un1.status, exists: fs.existsSync(rootB), zips: backupsB.zips });

    const rootC = path.join(sb, 'rootC');
    seedInstallTree(rootC, sb);
    const keep = await runPwsh(INSTALL, ['-Uninstall', '-KeepData', '-Yes', '-Confirm', '彻底卸载', ...maintArgs(rootC, sb), '-Json']);
    check('B2 KeepData：项目/团队产出 留、程序与 data 消失',
      keep.status === 0 && fs.existsSync(path.join(rootC, '项目', 'p1', '需求', 'R-x.md'))
      && fs.existsSync(path.join(rootC, '团队', '产出', 'out.md'))
      && !fs.existsSync(path.join(rootC, 'src')) && !fs.existsSync(path.join(rootC, 'data')),
      { status: keep.status, exists: fs.existsSync(rootC) });

    const rootD = path.join(sb, 'rootD');
    seedInstallTree(rootD, sb);
    const purge = await runPwsh(INSTALL, ['-Uninstall', '-Purge', '-Yes', '-Confirm', '彻底卸载-无备份', ...maintArgs(rootD, sb), '-Json']);
    const purgeJson = parseJsonOut(purge.stdout);
    check('B3 Purge：无备份整删 + userDataDeleted + backupZip:null',
      purge.status === 0 && !fs.existsSync(rootD) && Boolean(purgeJson && purgeJson.userDataDeleted === true && purgeJson.backupZip === null),
      { status: purge.status, json: purgeJson && { userDataDeleted: purgeJson.userDataDeleted, backupZip: purgeJson.backupZip } });

    // ── K1 -KeepBackups 语义（正文：「_backup 默认留、-KeepBackups 关掉才删」）──
    const rootG = path.join(sb, 'rootG');
    seedInstallTree(rootG, sb);
    writeFile(path.join(rootG, '_backup', 'upgrade-20260101', 'sentinel.txt'), 'keep-by-default\n');
    const keepDefault = await runPwsh(INSTALL, ['-Reset', '-Yes', '-Confirm', '重置', ...maintArgs(rootG, sb), '-Json']);
    check('K1a 默认（不带 -KeepBackups）：_backup 保留',
      keepDefault.status === 0 && fs.existsSync(path.join(rootG, '_backup', 'upgrade-20260101', 'sentinel.txt')) && !(fs.readdirSync(sb).includes('backup-deleted')),
      { status: keepDefault.status, exists: fs.existsSync(path.join(rootG, '_backup', 'upgrade-20260101', 'sentinel.txt')) });
    const rootH = path.join(sb, 'rootH');
    seedInstallTree(rootH, sb);
    writeFile(path.join(rootH, '_backup', 'upgrade-20260101', 'sentinel.txt'), 'drop-me\n');
    const keepOn = await runPwsh(INSTALL, ['-Reset', '-Yes', '-Confirm', '重置', '-KeepBackups', ...maintArgs(rootH, sb), '-Json']);
    const keepOnJson = parseJsonOut(keepOn.stdout);
    check('K1b 传 -KeepBackups：_backup 被删（且只在此情况下删）',
      keepOn.status === 0 && !fs.existsSync(path.join(rootH, '_backup'))
      && Boolean(keepOnJson && (keepOnJson.items || []).some((i) => i.category === 'backup' && i.result === 'deleted')),
      { status: keepOn.status, exists: fs.existsSync(path.join(rootH, '_backup')) });

    // ── K2 APP_DATA_LOCKED：目录被占用（命令行含目录）→ 不删 + 给 PID ──────
    const rootI = path.join(sb, 'rootI');
    seedInstallTree(rootI, sb);
    const lockedDir = path.join(sb, 'lad', 'PMWorkbench');
    const holderProc2 = spawn(process.execPath, ['-e', 'setTimeout(function(){},20000)', lockedDir], { windowsHide: true, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 800));
    const lockedRun = await runPwsh(INSTALL, ['-Reset', '-Yes', '-Confirm', '重置', ...maintArgs(rootI, sb), '-Json']);
    const lockedJson2 = parseJsonOut(lockedRun.stdout);
    const lockedItem = ((lockedJson2 && lockedJson2.items) || []).find((i) => i.code === 'APP_DATA_LOCKED');
    try { holderProc2.kill(); } catch { /* ignore */ }
    check('K2 APP_DATA_LOCKED：占用目录不删、code+PID 可见、exit 2',
      lockedRun.status === 2 && Boolean(lockedItem) && /PID/.test(String(lockedItem.reason || '')) && fs.existsSync(lockedDir),
      { status: lockedRun.status, item: lockedItem });

    // ── C VerifyClean ─────────────────────────────────────────────────
    const rootE = path.join(sb, 'rootE');
    seedInstallTree(rootE, sb);
    const vcDirty = await runPwsh(DIAG, ['-VerifyClean', '-Mode', 'reset', '-Root', rootE, '-Json', '-DshHome', path.join(sb, 'dsh'), '-LocalAppDataDir', path.join(sb, 'lad'), '-TempDir', path.join(sb, 'tmp'), '-ShortcutDir', path.join(sb, 'desk')]);
    const vcDirtyJson = parseJsonOut(vcDirty.stdout);
    check('C1a 有残留的根 → RESIDUE / 退出码 2 / residueCount>0',
      vcDirty.status === 2 && Boolean(vcDirtyJson && vcDirtyJson.verdict === 'RESIDUE' && Number(vcDirtyJson.residueCount) > 0),
      { status: vcDirty.status, json: vcDirtyJson && { verdict: vcDirtyJson.verdict, n: vcDirtyJson.residueCount } });

    // 造一个「干净」的根：只有程序文件 + 留项
    const rootF = path.join(sb, 'rootF');
    writeFile(path.join(rootF, 'package.json'), '{"name":"pm-workbench","version":"2.1.5"}');
    writeFile(path.join(rootF, 'start.cmd'), '@echo off\r\n');
    writeFile(path.join(rootF, '项目', 'p1', '需求', 'R-x.md'), 'keep\n');
    writeFile(path.join(rootF, '团队', '产出', 'out.md'), 'keep\n');
    const vcClean = await runPwsh(DIAG, ['-VerifyClean', '-Mode', 'reset', '-Root', rootF, '-Json', '-DshHome', path.join(sb, 'dsh'), '-LocalAppDataDir', path.join(sb, 'lad'), '-TempDir', path.join(sb, 'tmp'), '-ShortcutDir', path.join(sb, 'desk')]);
    const vcCleanJson = parseJsonOut(vcClean.stdout);
    check('C1b 干净根 → CLEAN / 退出码 0',
      vcClean.status === 0 && Boolean(vcCleanJson && vcCleanJson.verdict === 'CLEAN' && Number(vcCleanJson.residueCount) === 0),
      { status: vcClean.status, json: vcCleanJson && { verdict: vcCleanJson.verdict } });

    const vcHuman = await runPwsh(DIAG, ['-VerifyClean', '-Mode', 'reset', '-Root', rootF, '-DshHome', path.join(sb, 'dsh'), '-LocalAppDataDir', path.join(sb, 'lad'), '-TempDir', path.join(sb, 'tmp'), '-ShortcutDir', path.join(sb, 'desk')]);
    check('C1c 人类输出含「重置判定：干净」与 VERDICT 行（与 JSON 同源）',
      /重置判定：干净/.test(vcHuman.stdout) && /VERDICT:\s*CLEAN/.test(vcHuman.stdout), vcHuman.stdout.slice(-200));

    // ── D GUI 接线（静态：入口锚点 + IPC + preload + bind）─────────────
    const html = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
    const appJs = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
    const preloadJs = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
    const mainJs = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
    const need = ['data-maint-panel', 'data-maint="reset"', 'data-maint="uninstall"', 'data-maint-list', 'data-maint-confirm', 'data-maint-apply', 'data-maint-result'];
    check('D1 GUI 锚点齐（[data-maint-panel] 与 reset/uninstall/list/confirm/apply/result）',
      need.every((s) => html.includes(s)), need.filter((s) => !html.includes(s)));
    check('D1b 渲染层 bindMaintPanel + 主进程 maint:run/maint:verify + preload maintRun',
      appJs.includes('bindMaintPanel') && mainJs.includes("rawIpcHandle('maint:run'") && mainJs.includes("rawIpcHandle('maint:verify'") && preloadJs.includes('maintRun'));
        // ── C2 真实用户态零写入 ───────────────────────────────────────────
    if (!winRoot) {
      skip('C2 真实 hosts sha 不变（-GitHubFixHostsPath 副本，沙盘不写真实用户态）', '未取到 SystemRoot/windir，无法读真实 hosts（不写死盘符、不冒充通过）');
    } else if (!userStateSentinels.hosts) {
      skip('C2 真实 hosts sha 不变（-GitHubFixHostsPath 副本，沙盘不写真实用户态）', '真实 hosts 不可读（权限/不存在），本项跳过');
    } else {
      check('C2 真实 hosts sha 不变（-GitHubFixHostsPath 副本，沙盘不写真实用户态）',
        realHostsSha() === userStateSentinels.hosts, null);
    }
    // ── K3/K4（B-5cce）：维护结束后不留 <Root>.awb-maint.lock ──
    const lockA = path.join(root, '.awb-maint.lock');
    // A4 并发用例预置了锁文件（且 holder 进程可能刚释放）→ 先清掉，否则「本次是否新建」恒为 false，K3/K4 测不到清理逻辑。
    try { fs.rmSync(lockA, { force: true }); } catch { /* ignore */ }
    // K3 失败路径：错短语 → 第 3 道闸拒绝（exit 2），跑完不得留下锁文件
    const badPhrase = await runPwsh(INSTALL, ['-Reset', '-Yes', '-Confirm', '不对的短语', ...maintArgs(root, sb), '-Json']);
    await new Promise((r) => setTimeout(r, 400));
    check('K3 失败路径（错短语）不留 .awb-maint.lock',
      badPhrase.status === 2 && !fs.existsSync(lockA),
      { status: badPhrase.status, lockExists: fs.existsSync(lockA) });
    // K4 成功路径：正常重置（-NoBackup 免备份耗时）后也不留锁
    const okRun = await runPwsh(INSTALL, ['-Reset', '-Yes', '-Confirm', '重置', '-NoBackup', ...maintArgs(root, sb), '-Json']);
    await new Promise((r) => setTimeout(r, 400));
    check('K4 成功路径不留 .awb-maint.lock（重跑不新建空维护目录/空锁）',
      !fs.existsSync(lockA),
      { status: okRun.status, lockExists: fs.existsSync(lockA) });

  } finally {
    try { fs.rmSync(sb, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const pass = rows.filter((r) => r.ok).length;
  const fail = rows.length - pass;
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'test-2de7-maint.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      head: (() => { try { return spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(); } catch { return ''; } })(),
      task: 'T-20261119-212641-33a8', pass, fail, total: rows.length, rows,
    }, null, 2), 'utf8');
  } catch { /* ignore */ }
  console.log(`\n${pass}/${rows.length} PASS${fail ? ` · ${fail} FAIL` : ''}`);
  process.exit(fail ? 1 : 0);
})();
