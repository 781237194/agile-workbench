// 可选插件装/卸/回滚实装（R-20261112-175623-a48b AC21.9）
//
// 优先调真实 `dsh plugin`；本机没有 dsh CLI 时，只有显式给 --home（隔离插件根）才执行
// 文件级装卸（改隔离 profile 的 package.json + node_modules，真实验证 on/off/回滚链路），
// 绝不碰真实 ~/.dsh。任何失败都不阻断团队核心，只如实返回错误码。
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { detectOptionalPlugins, pluginsRoot, profileName, OPTIONAL_PLUGINS } from './plugins.mjs';
import { ensureDir, jsonOut, textOut, PATHS } from './core.mjs';

function baselineFile(root = '') {
  const base = root ? path.join(path.resolve(root), 'plugin-baseline.json') : path.join(path.dirname(PATHS.team), '插件基线.json');
  return base;
}

function pluginDef(id) {
  return OPTIONAL_PLUGINS.find((def) => def.id === id || def.pkgs.includes(id)) || null;
}

function packageNameOf(def) {
  return def && def.pkgs.length ? def.pkgs[0] : '';
}

/** 记录/读取安装前基线（3 个可选插件的 on-off 与版本）。root 可指向隔离插件根。 */
export function pluginBaseline({ save = false, root = '', profile = '' } = {}) {
  const detected = detectOptionalPlugins({ root: root || pluginsRoot(), profile: profile || profileName() });
  const data = {
    at: new Date().toISOString(),
    root: detected.root,
    profile: detected.profile,
    plugins: detected.plugins.map((row) => ({ id: row.id, status: row.status, version: row.version, packageName: row.packageName })),
  };
  if (save) {
    const file = baselineFile(root);
    ensureDir(path.dirname(file));
    fs.writeFileSync(file, JSON.stringify(data, null, 2) + '\n', 'utf8');
    data.file = file;
  }
  return { ok: true, file: baselineFile(root), ...data };
}

export function readBaseline(root = '') {
  try {
    return JSON.parse(fs.readFileSync(baselineFile(root), 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

/** 计算计划：action=install|uninstall；返回要执行的命令、回滚命令、当前状态。 */
export function pluginPlan({ action, id, root = '', profile = '' }) {
  const def = pluginDef(id);
  if (!def) return { ok: false, code: 'BAD_PLUGIN', message: `未知插件：${id}（可选：${OPTIONAL_PLUGINS.map((x) => x.id).join(', ')}）` };
  const pkg = packageNameOf(def);
  const prof = profile || profileName();
  const detected = detectOptionalPlugins({ root: root || pluginsRoot(), profile: prof });
  const row = detected.plugins.find((x) => x.id === def.id) || null;
  const verb = action === 'uninstall' ? 'remove' : 'add';
  const rollbackVerb = verb === 'add' ? 'remove' : 'add';
  const nextAction = action === 'uninstall' ? 'uninstall' : 'install';
  return {
    ok: true,
    id: def.id,
    action: nextAction,
    packageName: pkg,
    profile: prof,
    root: detected.root,
    statusBefore: row ? row.status : 'off',
    versionBefore: row ? row.version : '',
    command: `dsh plugin --profile ${prof} ${verb} ${pkg}`,
    rollbackCommand: `dsh plugin --profile ${prof} ${rollbackVerb} ${pkg}`,
    isolatedFileCommand: root
      ? `plugin run --action ${nextAction} --id ${def.id} --home "${detected.root}" --yes`
      : '',
    notes: action === 'uninstall' ? '卸载不删数据目录（记忆数据在 <DSH_HOME>/memories，需手动备份后清理）' : '装完重启 DSH，再用 plugin verify 复核',
  };
}

function dshCliAvailable() {
  try {
    execFileSync('dsh', ['--version'], { encoding: 'utf8', stdio: 'pipe', timeout: 15000 });
    return true;
  } catch {
    return false;
  }
}

/** 隔离文件级装卸：只改 <root>/profiles/<profile>/package.json + node_modules/<pkg>，不碰真实 DSH_HOME。 */
export function filePluginApply({ root, profile, action, id }) {
  const def = pluginDef(id);
  if (!def) return { ok: false, code: 'BAD_PLUGIN', message: `未知插件：${id}` };
  if (!root) return { ok: false, code: 'ISOLATED_HOME_REQUIRED', message: '文件级装卸必须显式 --home <隔离目录>' };
  const pkg = packageNameOf(def);
  const profileDir = path.join(path.resolve(root), 'profiles', profile || profileName());
  const pkgFile = path.join(profileDir, 'package.json');
  let data = {};
  try { data = JSON.parse(fs.readFileSync(pkgFile, 'utf8').replace(/^\uFEFF/, '')) || {}; } catch { data = {}; }
  if (!data.dependencies || typeof data.dependencies !== 'object') data.dependencies = {};
  if (!data.dsh || typeof data.dsh !== 'object') data.dsh = {};
  if (!data.dsh.profile || typeof data.dsh.profile !== 'object') data.dsh.profile = {};
  const bundles = Array.isArray(data.dsh.profile.bundles) ? data.dsh.profile.bundles.slice() : [];
  if (action === 'uninstall') {
    delete data.dependencies[pkg];
    data.dsh.profile.bundles = bundles.filter((b) => b !== pkg);
    fs.rmSync(path.join(profileDir, 'node_modules', pkg), { recursive: true, force: true });
  } else {
    if (!data.dependencies[pkg]) data.dependencies[pkg] = '0.0.0-isolated';
    if (!bundles.includes(pkg)) bundles.push(pkg);
    data.dsh.profile.bundles = bundles;
    const nm = path.join(profileDir, 'node_modules', pkg);
    fs.mkdirSync(nm, { recursive: true });
    fs.writeFileSync(path.join(nm, 'package.json'), JSON.stringify({ name: pkg, version: data.dependencies[pkg] }, null, 2) + '\n', 'utf8');
  }
  fs.mkdirSync(profileDir, { recursive: true });
  fs.writeFileSync(pkgFile, JSON.stringify(data, null, 2) + '\n', 'utf8');
  return { ok: true, code: 'OK', mode: 'file', file: pkgFile, packageName: pkg, action: action === 'uninstall' ? 'uninstall' : 'install', root: path.resolve(root) };
}

/** 执行安装/卸载：必须显式 yes；有 dsh CLI 用真命令；没有则仅在给了 --home 时做隔离文件级装卸。 */
export function pluginRun({ action, id, yes = false, root = '', profile = '' }) {
  const plan = pluginPlan({ action, id, root, profile });
  if (!plan.ok) return plan;
  if (!yes) return { ok: false, code: 'CONFIRM_REQUIRED', message: '实际装卸需要显式 --yes（或先看 plugin plan 的干跑输出）', plan };
  if (!dshCliAvailable()) {
    if (!root) {
      return { ok: false, code: 'DSH_CLI_MISSING', message: '找不到 dsh 命令；可改用 --home <隔离目录> 做文件级装卸验证，或按 docs/可选插件.md 手动安装', plan };
    }
    const applied = filePluginApply({ root, profile: plan.profile, action: plan.action, id: defId(plan.id) });
    return { ...applied, plan };
  }
  const args = ['plugin', '--profile', plan.profile, plan.action === 'uninstall' ? 'remove' : 'add', plan.packageName];
  try {
    const stdout = execFileSync('dsh', args, { encoding: 'utf8', stdio: 'pipe', timeout: 180000 });
    return { ok: true, code: 'OK', mode: 'dsh', plan, stdout: String(stdout || '').slice(-2000) };
  } catch (error) {
    return { ok: false, code: 'DSH_PLUGIN_FAILED', message: String((error && (error.stderr || error.message)) || error).slice(0, 500), plan };
  }
}

function defId(id) {
  const def = pluginDef(id);
  return def ? def.id : id;
}

/** 回滚：按基线恢复（基线 off 现在 on → 卸载；基线 on 现在 off → 安装；一致 → NOOP）。 */
export function pluginRollback({ id, yes = false, root = '', profile = '' }) {
  const def = pluginDef(id);
  if (!def) return { ok: false, code: 'BAD_PLUGIN', message: `未知插件：${id}` };
  const baseline = readBaseline(root);
  if (!baseline) return { ok: false, code: 'BASELINE_MISSING', message: '没有插件基线；先执行 plugin baseline --save' };
  const base = (baseline.plugins || []).find((row) => row.id === def.id);
  if (!base) return { ok: false, code: 'BASELINE_MISSING', message: `基线里没有插件 ${def.id}` };
  const current = detectOptionalPlugins({ root: root || pluginsRoot(), profile: profile || profileName() }).plugins.find((row) => row.id === def.id);
  const currentStatus = current ? current.status : 'off';
  if (String(base.status) === String(currentStatus)) {
    return { ok: true, code: 'NOOP', message: `已在基线状态（${currentStatus}），无需回滚`, baselineStatus: base.status, currentStatus };
  }
  const action = base.status === 'on' ? 'install' : 'uninstall';
  const plan = pluginPlan({ action, id: def.id, root, profile });
  if (!yes) return { ok: false, code: 'CONFIRM_REQUIRED', message: `回滚将执行 ${plan.command}；确认后加 --yes`, baselineStatus: base.status, currentStatus, plan };
  const run = pluginRun({ action, id: def.id, yes: true, root, profile });
  return { ...run, rollbackOf: { baselineStatus: base.status, currentStatus } };
}

/** 复核：重探测并与基线对比（只读）。 */
export function pluginVerify({ root = '', profile = '' } = {}) {
  const baseline = readBaseline(root);
  const detected = detectOptionalPlugins({ root: root || pluginsRoot(), profile: profile || profileName() });
  const rows = detected.plugins.map((row) => {
    const base = baseline && Array.isArray(baseline.plugins) ? baseline.plugins.find((b) => b.id === row.id) : null;
    return {
      id: row.id,
      baseline: base ? base.status : '(无基线)',
      current: row.status,
      version: row.version,
      same: base ? base.status === row.status : null,
    };
  });
  return { ok: rows.every((r) => r.same !== false), baseline: baseline ? baseline.at : null, rows, root: detected.root };
}

export function cmdPlugin(args) {
  const action = String((args._ && args._[1]) || 'status').toLowerCase();
  const id = String(args.id || '');
  const root = args.home ? path.resolve(String(args.home)) : '';
  const profile = String(args.profile || '');
  if (action === 'baseline') {
    const r = pluginBaseline({ save: Boolean(args.save), root, profile });
    if (args.json) { jsonOut(r); return; }
    textOut([`插件基线 ｜ ${r.at} ｜ ${r.root}`, ...r.plugins.map((p) => `- ${p.id}: ${p.status} ${p.version || ''}`), args.save ? `已写入 ${r.file}` : '（干跑，未写盘；加 --save 保存）'].join('\n'));
    return;
  }
  if (action === 'plan') {
    const r = pluginPlan({ action: String(args.action || 'install'), id, root, profile });
    if (args.json) { jsonOut(r); return; }
    if (!r.ok) { textOut(`计划失败：${r.message}`); process.exitCode = 1; return; }
    textOut([`计划 ${r.action} ${r.id}（当前 ${r.statusBefore}）`, `执行：${r.command}`, `回滚：${r.rollbackCommand}`, r.isolatedFileCommand ? `隔离文件级：${r.isolatedFileCommand}` : '', `说明：${r.notes}`].filter(Boolean).join('\n'));
    return;
  }
  if (action === 'run') {
    const r = pluginRun({ action: String(args.action || 'install'), id, yes: Boolean(args.yes), root, profile });
    if (!r.ok) process.exitCode = 1;
    if (args.json) { jsonOut(r); return; }
    textOut(r.ok ? `执行成功（${r.mode}）：${r.file || r.plan.command}` : `未执行：${r.code} ${r.message}`);
    return;
  }
  if (action === 'rollback') {
    const r = pluginRollback({ id, yes: Boolean(args.yes), root, profile });
    if (!r.ok) process.exitCode = 1;
    if (args.json) { jsonOut(r); return; }
    textOut(r.ok ? `回滚完成（${r.code}）${r.message ? '：' + r.message : ''}` : `未回滚：${r.code} ${r.message}`);
    return;
  }
  if (action === 'verify') {
    const r = pluginVerify({ root, profile });
    if (args.json) { jsonOut(r); return; }
    textOut(['插件复核（基线 vs 当前）', ...r.rows.map((x) => `- ${x.id}: 基线 ${x.baseline} → 当前 ${x.current}${x.same === false ? '（不一致）' : ''}`)].join('\n'));
    return;
  }
  if (action === 'status' || !action) {
    const r = detectOptionalPlugins({ root: root || pluginsRoot(), profile: profile || profileName() });
    if (args.json) { jsonOut(r); return; }
    textOut([`可选插件（${r.root} / ${r.profile}）`, ...r.plugins.map((p) => `- ${p.id}: ${p.status} ${p.version || ''}`), `标记：${r.marks}`].join('\n'));
    return;
  }
  throw new Error('plugin 只支持 status | baseline | plan | run | rollback | verify');
}
