// 团队工具 · 可选插件探测（R-20261112-175623-a48b 开源双轨）
//
// 原则：
//   1) 只读：不写 DSH_HOME、不加载/执行插件代码、不读密钥文件；
//   2) 不硬编码本机路径：根目录取 TEAM_PLUGINS_HOME → DSH_HOME → os.homedir()/.dsh；
//   3) 缺插件只标 off + 给安装提示，不报错、不阻断核心流程。
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

// AC21.4 固定清单：记忆 / 视觉 / 搜索。安装命令与文档用占位符，不写本机路径。
export const OPTIONAL_PLUGINS = [
  {
    id: 'memory-evolve',
    label: '记忆',
    kind: '记忆/待办',
    mode: 'memory',
    pkgs: ['dsh-memory-evolve', 'memory-evolve'],
    dataDir: 'memories',
    install: 'dsh plugin --profile <profile> add dsh-memory-evolve',
    enable: '在 profile 的 dsh.profile.bundles 中加入 dsh-memory-evolve（或用 dsh plugin 启用）',
    doc: 'docs/可选插件.md',
  },
  {
    id: 'modlens',
    label: '视觉',
    kind: '图片理解',
    mode: 'vision',
    pkgs: ['@liustack/modlens', 'modlens'],
    dataDir: '',
    install: 'dsh plugin --profile <profile> add @liustack/modlens',
    enable: '在 profile 的 dsh.profile.bundles 中加入 @liustack/modlens（或用 dsh plugin 启用）',
    doc: 'docs/可选插件.md',
  },
  {
    id: 'web-search-safe',
    label: '搜索',
    kind: '联网搜索',
    mode: 'search',
    pkgs: ['web-search-safe', 'dsh-web-search-safe', '@liustack/modsearch'],
    dataDir: '',
    install: 'dsh plugin --profile <profile> add web-search-safe',
    enable: '在 profile 的 dsh.profile.bundles 中加入 web-search-safe（或用 dsh plugin 启用）',
    doc: 'docs/可选插件.md',
  },
];

/** 插件根目录：测试可用 TEAM_PLUGINS_HOME 指向空目录模拟“零插件环境”。 */
export function pluginsRoot() {
  const override = String(process.env.TEAM_PLUGINS_HOME || '').trim();
  if (override) return path.resolve(override);
  const dshHome = String(process.env.DSH_HOME || '').trim();
  if (dshHome) return path.resolve(dshHome);
  return path.join(os.homedir(), '.dsh');
}

export function profileName() {
  return String(process.env.DSH_PROFILE || 'desktop').trim() || 'desktop';
}

function readJsonSafe(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
  } catch {
    return null;
  }
}

function packageVersion(dir) {
  const pkg = readJsonSafe(path.join(dir, 'package.json'));
  return pkg && pkg.version ? String(pkg.version) : '';
}

function listLocalPlugins(home) {
  const out = new Map();
  const dir = path.join(home, 'plugins');
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return out; }
  for (const name of names) {
    const pkgDir = path.join(dir, name);
    const pkg = readJsonSafe(path.join(pkgDir, 'package.json'));
    if (!pkg || !pkg.name) continue;
    out.set(String(pkg.name), { dir: pkgDir, version: pkg.version ? String(pkg.version) : '' });
  }
  return out;
}

/**
 * 探测可选插件状态。
 * 读取源：① profile 的 package.json（dependencies + dsh.profile.bundles）；② 插件根目录下 plugins/<目录>/package.json（本地 link 插件）；
 * ③ profile 的 node_modules/<包>/package.json（实际安装版本）。全部只读。
 */
export function detectOptionalPlugins({ root = pluginsRoot(), profile = profileName() } = {}) {
  const home = path.resolve(root);
  const profileDir = path.join(home, 'profiles', profile);
  const profilePkgFile = path.join(profileDir, 'package.json');
  const profilePkg = readJsonSafe(profilePkgFile) || {};
  const deps = profilePkg.dependencies && typeof profilePkg.dependencies === 'object' ? profilePkg.dependencies : {};
  const bundles = profilePkg.dsh && profilePkg.dsh.profile && Array.isArray(profilePkg.dsh.profile.bundles)
    ? profilePkg.dsh.profile.bundles.map(String)
    : [];
  const localPlugins = listLocalPlugins(home);

  const plugins = OPTIONAL_PLUGINS.map((def) => {
    const packageName = def.pkgs.find((name) => Object.prototype.hasOwnProperty.call(deps, name)) || '';
    let version = packageName ? String(deps[packageName] || '') : '';
    let status = 'off';
    let hint = '';
    if (!packageName) {
      hint = `未安装（可选）：${def.install}`;
    } else {
      const link = /^link:(.+)$/.exec(version);
      if (link) {
        version = packageVersion(path.resolve(profileDir, link[1])) || version;
      } else {
        const installed = packageVersion(path.join(profileDir, 'node_modules', packageName));
        if (installed) version = installed;
        else { status = 'error'; hint = '依赖已声明但未安装到 profile：在 profile 内执行 npm install（或 pnpm install）'; }
      }
      if (status !== 'error') {
        const enabled = bundles.includes(packageName) || def.pkgs.some((name) => bundles.includes(name)) || localPlugins.has(packageName);
        status = enabled ? 'on' : 'off';
        if (status === 'off') hint = `已安装但未启用：${def.enable}`;
      }
    }
    const dataDir = def.dataDir ? path.join(home, def.dataDir) : '';
    return {
      id: def.id,
      label: def.label,
      kind: def.kind,
      mode: def.mode,
      required: false,
      status,
      version: version || '',
      packageName,
      dataDir,
      dataExists: dataDir ? fs.existsSync(dataDir) : false,
      hint,
      doc: def.doc,
    };
  });

  const summary = {};
  for (const row of plugins) summary[row.mode] = row.status;
  return {
    ok: true,
    root: home,
    profile,
    sources: { profilePackage: profilePkgFile, pluginsDir: path.join(home, 'plugins') },
    plugins,
    summary,
    marks: plugins.map((row) => `${row.mode}:${row.status}`).join(' · '),
  };
}

/** 一行降级标记，供 status/doctor/boot 共用；探测失败时返回 memory:off 等保守值而非冒充 on。 */
export function optionalPluginMarks() {
  try {
    const result = detectOptionalPlugins();
    return { ok: true, marks: result.marks, summary: result.summary, result };
  } catch (error) {
    return {
      ok: false,
      marks: 'memory:off · vision:off · search:off',
      summary: { memory: 'off', vision: 'off', search: 'off' },
      why: String((error && error.message) || error),
    };
  }
}

/** status 段：固定清单逐项列出（清单/on-off/版本/数据目录/读取源/安装提示），不泄露密钥。 */
export function pluginStatusLines(result) {
  const rows = result.plugins || [];
  const lines = [];
  lines.push('## 可选插件（非核心 · 缺了不阻断）');
  lines.push(`- 读取源：${result.sources.profilePackage}${fs.existsSync(result.sources.profilePackage) ? '' : '（未找到，按未安装处理）'}`);
  lines.push(`- 本地插件目录：${result.sources.pluginsDir}${fs.existsSync(result.sources.pluginsDir) ? '' : '（不存在）'}`);
  for (const row of rows) {
    const data = row.dataDir ? `${row.dataDir}${row.dataExists ? '' : '（未创建）'}` : '—';
    const ver = row.version || '—';
    lines.push(`- ${row.id}（${row.label}）：${row.status} ｜ 版本 ${ver} ｜ 数据 ${data}${row.hint ? ' ｜ ' + row.hint : ''}`);
  }
  lines.push(`- 降级标记：${result.marks}`);
  lines.push('- 安装/卸载/回滚与双轨说明：docs/可选插件.md');
  return lines;
}
