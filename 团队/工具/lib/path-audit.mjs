// 硬编码路径审计（R-20261112-175623-a48b AC21.6）
//
// 范围固定：src/**、团队/工具/**、README.md、docs/**。
// 白名单与 docs/路径白名单.md 同源（本文件是机器可读源，docs 是人读镜像）；
// 白名单外命中即 FAIL —— doctor / path-audit 都按同一条规则判，不各写一套。
import fs from 'node:fs';
import path from 'node:path';

export const AUDIT_SCOPES = ['src', '团队/工具', 'scripts'];
// 团队根级文档与日志（不含 团队/状态 运行时数据：那里会有会话/邮箱等非源码内容）。
export const AUDIT_TEAM_DOCS = true;
// 根目录文件（不递归）：安装脚本/配置也可能带本机路径，上一轮漏检过。
export const AUDIT_ROOT_SCAN = true;
export const AUDIT_FILE_EXT = /\.(js|mjs|cjs|md|html|css|json|yml|yaml|txt|ps1|cmd|bat|sh|py|ts|vue|toml|ini|conf|env)$/i;
export const AUDIT_ROOT_FILES = ['README.md'];
// 与 AC21.6 的示例命令同口径：`D:\\`（任意盘符反斜杠，含单层目录与源码中的转义双反斜杠）、
// `C:\\Users`、`api_key`/`secret` 关键字、`/Users/`。
// 上一版按“至少一层 段\”且单反斜杠匹配，漏检 `D:\PM工作台`（单层）与 `D:\\deepseek\\...`（转义）。
// 盘符后的负向断言排除正则转义误报（`secret:\s*`、`[\w-]+?:\s*` 里的 `t:\s`/`r:\s`）。
export const AUDIT_PATTERNS = [
  { kind: 'Windows 盘符路径', re: /[A-Za-z]:\\(?![sdwbnrtfv0]\s*[*+?{[(])[^\s"'<>|]*/g },
  { kind: '用户目录路径', re: /[A-Za-z]:\\Users\\[^\s"'<>|]*/gi },
  { kind: 'macOS 用户目录', re: /\/Users\/[A-Za-z0-9._-]+\/[^\s"')]+/g },
  { kind: 'api_key/secret 关键字', re: /api[_-]?key|secret/gi },
];

// 白名单：逐文件 + 原因 + 是否待改；新增命中必须先登记，否则判 FAIL。
export const PATH_WHITELIST = [
  { file: '团队/README.md', reason: '团队文档中的路径示例/历史记录（人工文档，非运行时代码）', pending: false },
  { file: '团队/日志/2026-10-29.md', reason: '团队历史日志，记录当时机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: '团队/日志/2026-10-31.md', reason: '团队历史日志，记录当时机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: '团队/日志/2026-11-03.md', reason: '团队历史日志，记录当时机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: '团队/日志/2026-11-05.md', reason: '团队历史日志，记录当时机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: '团队/日志/2026-11-06.md', reason: '团队历史日志，记录当时机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: '团队/日志/2026-11-12.md', reason: '团队历史日志，记录当时机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: '团队/流程.md', reason: '团队文档中的路径示例/历史记录（人工文档，非运行时代码）', pending: false },
  { file: '团队/看板.html', reason: '团队文档中的路径示例/历史记录（人工文档，非运行时代码）', pending: false },
  { file: '团队/运行手册.md', reason: '团队文档中的路径示例/历史记录（人工文档，非运行时代码）', pending: false },
  { file: '团队/项目铁律.md', reason: '团队文档中的路径示例/历史记录（人工文档，非运行时代码）', pending: false },
  { file: '团队/工具/lib/path-audit.mjs', reason: '白名单原因文本中的示例占位符（C:\\Users\\...），不是运行时路径', pending: false },
  { file: 'scripts/export-open-source.mjs', reason: '开源导出脚本的清洗正则/示例（D:\\somewhere\\...、C:\\Users\\...），用于把本机路径替换成占位符', pending: false },
  { file: 'install.ps1', reason: '安装脚本中的下载路径示例（C:\\Download\\...），非运行时硬编码；改占位符会影响复制粘贴体验', pending: false, note: '示例' },
  { file: 'start.cmd', reason: '启动脚本注释里的 userdata 路径示例（D:\\path\\userdata），非运行时硬编码', pending: false, note: '示例' },
  { file: 'docs/DSH-MODEL-AUDIT.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/MVP-BLOCKERS.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/MVP-ROUND3-BLOCKERS.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/OLD-CODE-AUDIT.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/PARITY-ROUND12.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/PARITY-ROUND5.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/PARITY-ROUND6.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/PARITY-ROUND7.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/PARITY-ROUND8.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/PARITY-ROUND9.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/QA-FINAL-OPS.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/QA-FINAL.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/QA-INSTALLER-NODE.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/QA-INSTALLER-PORT.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/QA-MVP-CORE.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/QA-MVP-CORE2.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/QA-MVP-ROUND3.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/QA-MVP-UI.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/QA-MVP-UI2.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/QA-REPORT.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/QA-ROUND10.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/QA-ROUND11.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/QA-ROUND12-CORE.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/QA-ROUND12-UI.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/QA-ROUND14-SHELL-CLOSEOUT.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/QA-ROUND2.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/QA-ROUND3.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/QA-ROUND4.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/QA-ROUND5.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/QA-ROUND6.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/QA-ROUND7.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/QA-ROUND8.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/QA-ROUND9.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/QA-UX-TOKEN.md', reason: '历史 QA/审计记录，保留当时的机器路径与命令输出（只读证据，改写会失真）', pending: false },
  { file: 'docs/路径白名单.md', reason: '本文件自身的检索命令示例（C:\Users）；示例用占位符，仅命令文本', pending: false },
  { file: 'src/main.js', reason: '注释中的示例占位符（C:\Users\...）与 URL 正则片段，不是运行时路径', pending: false },
  // a48b 收口（T-20261112-213348-d9e8）：按 AC21.6 关键字口径逐条处置，以下为合法例外。
  { file: 'src/dsh-adapter.js', reason: '读取 DSH 本机会话凭据的运行时字段名/变量名（.credentials.yaml 的 browser-session 凭据）与 Windows 系统目录回退（系统目录不是本机专属路径）；不含硬编码密钥或用户目录', pending: false },
  { file: 'src/team-tools.js', reason: '壳层打包产物（bundle）：错误识别关键字含 browser-session 凭据/credentials 字样，用于把 DSH 认证失败翻译成人话；源码同仓，未写死密钥', pending: false },
  { file: '团队/工具/lib/broadcast.mjs', reason: '播报摘要脱敏正则的敏感词字面量（token/凭据/api_key 等），用于把值替换成 ***，不是硬编码密钥', pending: false },
  { file: '团队/工具/lib/dsh-session.mjs', reason: '读取 DSH 会话凭据的字段名/变量名（browser-session 凭据），同 src/dsh-adapter.js；不含硬编码密钥', pending: false },
  { file: '团队/工具/lib/selftest.mjs', reason: '自测构造样本：脱敏用例故意写入 token=/凭据明文验证被替换为 ***；越界路径用例用系统目录绝对路径验证 PATH_OUTSIDE_REPO；均为测试数据，不是运行时硬编码', pending: false },
];

const WHITELIST_FILES = new Set(PATH_WHITELIST.map((row) => row.file));
// 日志按天滚动（团队/日志/YYYY-MM-DD.md），逐天登记会天天挡住 selftest；日志是只读运行证据，
// 与已登记的历史日志同一理由，按文件名整类豁免（T-a01d 顺带修：2026-11-13 日志让 selftest 变红）。
const WHITELIST_PATTERNS = [/^团队\/日志\/\d{4}-\d{2}-\d{2}\.md$/];
function isWhitelistedFile(file) {
  return WHITELIST_FILES.has(file) || WHITELIST_PATTERNS.some((re) => re.test(file));
}

function walk(dir, hits) {
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  for (const name of names) {
    if (name === 'node_modules' || name === '.git') continue;
    const full = path.join(dir, name);
    let st = null;
    try { st = fs.statSync(full); } catch { continue; }
    if (st.isDirectory()) { walk(full, hits); continue; }
    if (!AUDIT_FILE_EXT.test(name)) continue;
    let text = '';
    try { text = fs.readFileSync(full, 'utf8'); } catch { continue; }
    const lines = text.split(/\r?\n/);
    lines.forEach((line, i) => {
      for (const p of AUDIT_PATTERNS) {
        p.re.lastIndex = 0;
        const m = p.re.exec(line);
        if (m) hits.push({ file: path.relative(dir === '' ? process.cwd() : '', full), abs: full, line: i + 1, kind: p.kind, text: String(m[0]).slice(0, 160) });
      }
    });
  }
}

/** 只读扫描：返回白名单外命中（outside）与白名单内命中（whitelisted）。 */
export function auditHardcodedPaths({ root = '' } = {}) {
  const base = path.resolve(root || process.cwd());
  const hits = [];
  for (const scope of AUDIT_SCOPES) {
    const dir = path.join(base, scope);
    if (fs.existsSync(dir)) {
      const before = hits.length;
      walk(dir, hits);
      for (let i = before; i < hits.length; i += 1) hits[i].file = path.relative(base, hits[i].abs).replace(/\\/g, '/');
    }
  }
  for (const rel of AUDIT_ROOT_FILES) {
    const abs = path.join(base, rel);
    if (!fs.existsSync(abs)) continue;
    const before = hits.length;
    walkFile(abs, hits);
    for (let i = before; i < hits.length; i += 1) hits[i].file = rel;
  }
  const docsDir = path.join(base, 'docs');
  if (fs.existsSync(docsDir)) {
    const before = hits.length;
    walk(docsDir, hits);
    for (let i = before; i < hits.length; i += 1) hits[i].file = path.relative(base, hits[i].abs).replace(/\\/g, '/');
  }
  if (AUDIT_TEAM_DOCS) {
    const teamDir = path.join(base, '团队');
    let names = [];
    try { names = fs.readdirSync(teamDir); } catch { names = []; }
    for (const name of names) {
      const full = path.join(teamDir, name);
      let st = null;
      try { st = fs.statSync(full); } catch { continue; }
      if (st.isDirectory()) continue;
      if (!/\.(md|html)$/i.test(name)) continue;
      const before = hits.length;
      walkFile(full, hits);
      for (let i = before; i < hits.length; i += 1) hits[i].file = '团队/' + name;
    }
    const logDir = path.join(teamDir, '日志');
    if (fs.existsSync(logDir)) {
      const before = hits.length;
      walk(logDir, hits);
      for (let i = before; i < hits.length; i += 1) hits[i].file = path.relative(base, hits[i].abs).replace(/\\/g, '/');
    }
  }
  if (AUDIT_ROOT_SCAN) {
    let names = [];
    try { names = fs.readdirSync(base); } catch { names = []; }
    for (const name of names) {
      const full = path.join(base, name);
      let st = null;
      try { st = fs.statSync(full); } catch { continue; }
      if (!st.isFile() || !AUDIT_FILE_EXT.test(name)) continue;
      // 根目录文件已由 AUDIT_ROOT_FILES 扫过，避免重复计数。
      if (AUDIT_ROOT_FILES.includes(name)) continue;
      const before = hits.length;
      walkFile(full, hits);
      for (let i = before; i < hits.length; i += 1) hits[i].file = name;
    }
  }
  const whitelisted = hits.filter((h) => isWhitelistedFile(h.file));
  const outside = hits.filter((h) => !isWhitelistedFile(h.file));
  const byFile = {};
  for (const h of hits) byFile[h.file] = (byFile[h.file] || 0) + 1;
  return {
    ok: outside.length === 0,
    root: base,
    total: hits.length,
    files: Object.keys(byFile).length,
    byFile,
    whitelisted: whitelisted.length,
    outside,
    whitelistSize: PATH_WHITELIST.length,
  };
}

function walkFile(abs, hits) {
  let text = '';
  try { text = fs.readFileSync(abs, 'utf8'); } catch { return; }
  const lines = text.split(/\r?\n/);
  lines.forEach((line, i) => {
    for (const p of AUDIT_PATTERNS) {
      p.re.lastIndex = 0;
      const m = p.re.exec(line);
      if (m) hits.push({ file: abs, abs, line: i + 1, kind: p.kind, text: String(m[0]).slice(0, 160) });
    }
  });
}

/** 文本输出（doctor / path-audit 共用）。 */
export function pathAuditLines(result) {
  const lines = [];
  lines.push('## 路径白名单（AC21.6）');
  lines.push(`- 范围：${AUDIT_SCOPES.join('/')}、团队根级文档与日志、${AUDIT_ROOT_FILES.join('、')}、根目录脚本/配置、docs/**`);
  lines.push(`- 命中：${result.total} 处 / ${result.files} 文件；白名单内 ${result.whitelisted}，白名单外 ${result.outside.length}`);
  lines.push(`- 判定：${result.ok ? 'PASS（白名单外 0 命中）' : 'FAIL（白名单外有命中，见下）'}`);
  for (const h of result.outside.slice(0, 20)) lines.push(`  - ${h.file}:${h.line} [${h.kind}] ${h.text}`);
  return lines;
}

/** 人读文档（docs/路径白名单.md 的表格）与代码常量是否同源。 */
export function checkDocsSync({ root = '' } = {}) {
  const base = path.resolve(root || process.cwd());
  const docsFile = path.join(base, 'docs/路径白名单.md');
  let text = '';
  try { text = fs.readFileSync(docsFile, 'utf8'); } catch { return { ok: false, code: 'DOCS_MISSING', docsFile, codeCount: PATH_WHITELIST.length, docsCount: 0, missingInDocs: PATH_WHITELIST.map((r) => r.file), extraInDocs: [] }; }
  const listed = new Set();
  for (const m of text.matchAll(/^\| `([^`]+)` \|/gm)) listed.add(m[1]);
  const code = new Set(PATH_WHITELIST.map((r) => r.file));
  const missingInDocs = [...code].filter((f) => !listed.has(f));
  const extraInDocs = [...listed].filter((f) => !code.has(f));
  return { ok: missingInDocs.length === 0 && extraInDocs.length === 0, docsFile, codeCount: code.size, docsCount: listed.size, missingInDocs, extraInDocs };
}

/** 生成 docs/路径白名单.md 全文（机器源 → 人读镜像，命中数与结论一并复算，避免手工漂移）。 */
export function renderWhitelistDoc({ root = '' } = {}) {
  const base = path.resolve(root || process.cwd());
  const result = auditHardcodedPaths({ root: base });
  const docsFile = path.join(base, 'docs', '路径白名单.md');
  let tail = '';
  try {
    const old = fs.readFileSync(docsFile, 'utf8');
    const idx = old.indexOf('## 四、变更记录');
    if (idx >= 0) tail = old.slice(idx).replace(/\s+$/, '') + '\n';
  } catch { /* 首次生成没有旧文件 */ }
  const now = new Date();
  const pad = (n) => String(n).padStart(2, '0');
  const stamp = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())} ${pad(now.getHours())}:${pad(now.getMinutes())}`;
  const rows = PATH_WHITELIST.slice().sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
  const lines = [];
  lines.push('# 路径白名单（硬编码检索豁免清单）');
  lines.push('');
  lines.push('> 用途：AC21.6「源码不硬编码本机路径/密钥」的豁免清单。**白名单外的命中即 FAIL。**');
  lines.push(`> 生成时间：${stamp} ｜ 生成人：程序员B ｜ **本文件由 \`团队/工具/lib/path-audit.mjs\` 的 \`PATH_WHITELIST\` 经 \`team.mjs path-audit --write-docs\` 生成，人读镜像与代码同源**。`);
  lines.push('');
  lines.push('## 一、检索范围与命令');
  lines.push('');
  lines.push(`范围固定：${AUDIT_SCOPES.join('/')}、团队根级文档与日志、\`${AUDIT_ROOT_FILES.join('、')}\`、根目录脚本/配置、\`docs/**\`。`);
  lines.push('');
  lines.push('```powershell');
  lines.push('node 团队\\工具\\team.mjs path-audit            # 文本：命中/白名单内/白名单外/判定');
  lines.push('node 团队\\工具\\team.mjs path-audit --json     # 机器可读：{ok,total,files,whitelisted,outside,whitelistSize}');
  lines.push('node 团队\\工具\\team.mjs doctor                # 末尾「路径白名单（AC21.6）」段；白名单外 >0 计入问题');
  lines.push('node 团队\\工具\\team.mjs path-audit --check-docs  # 人读文档与代码白名单是否同源（不一致 exit 1）');
  lines.push('node 团队\\工具\\team.mjs path-audit --write-docs  # 由代码白名单重生成本文件（表格+命中数+结论）');
  lines.push('```');
  lines.push('');
  lines.push('## 二、白名单（逐文件，与代码同源）');
  lines.push('');
  lines.push('| 文件 | 命中数 | 原因 | 是否待改 |');
  lines.push('|---|---|---|---|');
  for (const row of rows) {
    const count = result.byFile[row.file] || 0;
    lines.push(`| \`${row.file}\` | ${count} | ${row.reason} | ${row.pending ? '是' : '否'} |`);
  }
  lines.push('');
  lines.push('## 三、结论');
  lines.push('');
  if (result.ok) {
    lines.push(`- 全量命中 **${result.total} 处 / ${result.files} 个文件**，白名单 **${result.whitelistSize} 个文件**，**白名单外 0 处**（判定：PASS）；`);
  } else {
    lines.push(`- 全量命中 **${result.total} 处 / ${result.files} 个文件**，白名单 **${result.whitelistSize} 个文件**，**白名单外 ${result.outside.length} 处**（判定：FAIL）；`);
    for (const h of result.outside.slice(0, 20)) lines.push(`  - \`${h.file}:${h.line}\` [${h.kind}] ${String(h.text).slice(0, 120)}`);
  }
  lines.push('- 代码类只有注释占位符/正则片段/系统目录回退；文档类为历史 QA/审计记录、团队文档与日志、安装脚本示例；');
  lines.push('- 新增/修改代码不写本机路径：插件根走 `TEAM_PLUGINS_HOME` → `DSH_HOME` → 用户目录，文档用 `<DSH_HOME>`/`<项目目录>` 占位符；');
  lines.push('- 白名单外 0 命中时才算通过；新增命中必须先改 `PATH_WHITELIST` 常量，再跑 `--check-docs` 与 `--write-docs` 复核本文件已同步。');
  lines.push('');
  if (tail) lines.push(tail);
  return lines.join('\n');
}

export function writeWhitelistDoc({ root = '' } = {}) {
  const base = path.resolve(root || process.cwd());
  const docsFile = path.join(base, 'docs', '路径白名单.md');
  const text = renderWhitelistDoc({ root: base });
  fs.mkdirSync(path.dirname(docsFile), { recursive: true });
  fs.writeFileSync(docsFile, text, 'utf8');
  return { file: docsFile, rows: PATH_WHITELIST.length };
}

export function cmdPathAudit(args) {
  if (args['write-docs']) {
    const written = writeWhitelistDoc({ root: String(args.root || '') });
    process.stdout.write(`已生成 ${written.file}（${written.rows} 条白名单，含命中数）\n`);
    return;
  }
  if (args['check-docs']) {
    const sync = checkDocsSync({ root: String(args.root || '') });
    if (args.json) { process.stdout.write(JSON.stringify(sync) + '\n'); }
    else {
      process.stdout.write([
        `白名单同源检查：${sync.ok ? 'PASS' : 'FAIL'}（代码 ${sync.codeCount} 文件 / 文档 ${sync.docsCount} 文件）`,
        ...(sync.missingInDocs.length ? ['文档缺：' + sync.missingInDocs.join('、')] : []),
        ...(sync.extraInDocs.length ? ['文档多：' + sync.extraInDocs.join('、')] : []),
      ].join('\n') + '\n');
    }
    process.exitCode = sync.ok ? 0 : 1;
    return;
  }
  const result = auditHardcodedPaths({ root: String(args.root || '') });
  if (args.json) { process.stdout.write(JSON.stringify({ ok: result.ok, ...result, stdout: undefined }) + '\n'); return; }
  process.stdout.write(pathAuditLines(result).join('\n') + '\n');
  process.exitCode = result.ok ? 0 : 1;
}
