// 团队工作台 v2 · brief：结构化 MD 网关读取（只读）
// team.mjs brief --boot T --role X --project P [--doc 01|02|03|04|文件名] [--section 区块] [--limit N] [--latest] [--check] [--json]
// 从角色结构化产出（01-需求分析/02-产品设计/03-架构设计/04-测试报告，vN）提取 YAML 元数据 / 指定区块，
// 供壳层精准投喂；不读全文（输出只有元数据 + 区块提纲，或 --section 指定的区块内容），不写项目文件。
import fs from 'node:fs';
import path from 'node:path';
import {
  PATHS, fail, exists, hashFile, shortHash, truncate, relPath, jsonOut, textOut, appendEvent,
} from './core.mjs';
import { loadProject, requireBoot, addReadReceipt } from './store.mjs';
import { OUTPUT_DOCS, OUTPUT_DISCIPLINE } from './roles.mjs';

export const BRIEF_TEMPLATE_DIR = path.join(PATHS.teamRoot, '工具', '模板', '角色产出');
export const BRIEF_SECTION_MAX = 2000;      // 单区块提取默认上限（字符）
export const BRIEF_DOC_MAX_BYTES = 16384;   // 产出文件上限（与 docMaxBytes 一致）

const CN_NUM = ['零', '一', '二', '三', '四', '五', '六', '七', '八', '九', '十'];

/** 读文本（剥 BOM）。文件必须存在，否则 ENOENT 直接抛。 */
function readDocText(file) {
  return fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '');
}

/**
 * 解析结构化 MD：YAML 元数据头（首行 --- 到 ---）+ 固定二级区块。
 * YAML 只支持平铺 `key: value`（本协议模板即如此）；区块按 `## ` 行切分。
 */
export function parseDoc(text) {
  const src = String(text || '').replace(/^\uFEFF/, '');
  const meta = {};
  let body = src;
  const fm = src.match(/^---[ \t]*\r?\n([\s\S]*?)\r?\n---[ \t]*\r?\n/);
  if (fm) {
    body = src.slice(fm[0].length);
    for (const raw of fm[1].split(/\r?\n/)) {
      const line = raw.trim();
      if (!line || line.startsWith('#')) continue;
      const i = line.indexOf(':');
      if (i <= 0) continue;
      const key = line.slice(0, i).trim();
      if (meta[key]) continue; // 重复键保留第一个
      let val = line.slice(i + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) val = val.slice(1, -1);
      meta[key] = val;
    }
  }
  const sections = [];
  let cur = null;
  for (const line of body.split(/\r?\n/)) {
    const h = line.match(/^##[ \t]+(.+?)[ \t]*$/);
    if (h) { cur = { title: h[1], lines: [] }; sections.push(cur); continue; }
    if (cur) cur.lines.push(line);
  }
  return { meta, body, sections };
}

/** 结构断言：YAML 头必填键 + 全部固定区块 + ≤16KB。缺了就报，不靠眼看。 */
export function checkDocStructure(text, spec) {
  const parsed = parseDoc(text);
  const problems = [];
  if (!String(text || '').trim()) problems.push('空文件');
  for (const k of ['doc', 'version', 'role', 'updated']) {
    if (!parsed.meta[k]) problems.push(`缺元数据: ${k}`);
  }
  const titles = parsed.sections.map((s) => s.title);
  for (const req of spec.sections) {
    if (!titles.some((t) => t.startsWith(req))) problems.push(`缺区块: ${req}`);
  }
  const size = Buffer.byteLength(String(text || ''), 'utf8');
  if (size > BRIEF_DOC_MAX_BYTES) problems.push(`超过 ${BRIEF_DOC_MAX_BYTES} 字节: ${size}`);
  return { ok: problems.length === 0, problems, parsed };
}

function versionOf(name) {
  const m = /v(\d+)(?:\.md)?$/i.exec(String(name));
  return m ? Number(m[1]) : 0;
}

/** 在角色目录 + 产出/ 下找该角色的编号产出；版本新在前。--latest 只取最新。 */
export function findDocFiles(root, spec, { latest = false, doc = '' } = {}) {
  const out = [];
  for (const d of [path.join(root, spec.dir), path.join(root, spec.dir, '产出')]) {
    if (!exists(d)) continue;
    let names = [];
    try { names = fs.readdirSync(d); } catch { continue; }
    for (const name of names) {
      if (!spec.fileRe.test(name)) continue;
      if (doc) {
        const q = String(doc).trim();
        if (q !== spec.code && q !== String(Number(spec.code)) && !name.includes(q)) continue;
      }
      const file = path.join(d, name);
      let st;
      try { st = fs.statSync(file); if (!st.isFile()) continue; } catch { continue; }
      out.push({ name, file, rel: relPath(root, file), hash: hashFile(file), size: st.size });
    }
  }
  out.sort((a, b) => versionOf(b.name) - versionOf(a.name));
  if (latest && out.length) return [out[0]];
  return out;
}

/** 按区块查询匹配：支持 编号（五 / 5）、区块名（验收标准）、完整标题（五、验收标准）。
 *  纯数字查询只按中文编号匹配，不走模糊包含——否则「≤50」里的“5”会误中别的区块。 */
export function matchSections(sections, queries) {
  const hits = [];
  for (const q of queries) {
    const query = String(q).trim();
    if (!query) continue;
    const numericOnly = /^\d+$/.test(query);
    for (const s of sections) {
      const title = s.title;
      if (title === query || title.startsWith(query)) { hits.push(s); continue; }
      const m = title.match(/^([一二三四五六七八九十]+)、(.+)$/);
      if (m) {
        const num = CN_NUM.indexOf(m[1]); // 零=0 一=1 … 五=5，无需 +1
        if (String(num) === query || m[1] === query || m[2] === query) { hits.push(s); continue; }
        if (!numericOnly && m[2].includes(query)) { hits.push(s); continue; }
      }
      if (!numericOnly && title.includes(query)) hits.push(s);
    }
  }
  return hits;
}

export function cmdBrief(args) {
  if (args.boot === undefined || args.boot === true) fail('BOOT_REQUIRED', 'brief 需要 --boot <启动令牌>；先运行 boot');
  const token = requireBoot(String(args.boot), {});
  const projectName = String(args.project || token.project || '');
  if (projectName !== token.project) {
    fail('BOOT_PROJECT_MISMATCH', `令牌项目 ${token.project} ≠ --project ${projectName}`, { tokenProject: token.project, project: projectName });
  }
  const project = loadProject(projectName);
  const role = String(args.role || token.role || '').trim();
  if (!role) fail('BAD_ROLE', '需要 --role（或令牌自带角色）');
  const spec = OUTPUT_DOCS[role] || null;
  const sessionId = String(args.session || token.sessionId || 'session-unknown');
  const docQ = args.doc ? String(args.doc) : '';
  const allFiles = spec ? findDocFiles(project.path, spec, { doc: docQ }) : [];
  const selRaw = Array.isArray(args.section) ? args.section.map(String) : (args.section ? [String(args.section)] : []);

  // ---- --check：只校验结构，不提取 ----
  if (args.check) {
    const problems = [];
    const lines = [];
    for (const f of allFiles) {
      const c = checkDocStructure(readDocText(f.file), spec);
      if (!c.ok) problems.push({ file: f.rel, problems: c.problems });
      lines.push(`${c.ok ? 'PASS' : 'FAIL'}  ${f.rel}${c.problems.length ? ' · ' + c.problems.join('；') : ''}`);
    }
    if (!spec) {
      lines.push(`SKIP  ${role}：没有 01~04 结构化产出模板`);
    } else if (!allFiles.length) {
      lines.push(`FAIL  没有 ${spec.title} 产出（模板：${path.join(BRIEF_TEMPLATE_DIR, spec.file)}）`);
      problems.push({ file: spec.dir, problems: ['找不到产出文件'] });
    }
    appendEvent({
      role: token.role, sessionId, action: 'brief_check', project: projectName, target: role,
      result: problems.length ? 'FAIL' : 'ok', note: `role=${role} files=${allFiles.length} problems=${problems.length}`,
      data: { role, files: allFiles.map((f) => f.rel), problems },
    });
    if (args.json) jsonOut({ ok: problems.length === 0, role, project: projectName, problems });
    else textOut(lines.join('\n'));
    if (problems.length) fail('DOC_CHECK_FAILED', `brief --check 未通过（${problems.length} 项）`, { problems });
    return;
  }

  // ---- 默认/提取模式 ----
  const docs = [];
  for (const f of allFiles) {
    const parsed = parseDoc(readDocText(f.file));
    docs.push({
      code: spec.code, name: f.name, rel: f.rel, file: f.file, size: f.size, hash: f.hash,
      meta: parsed.meta,
      sections: parsed.sections.map((s) => ({ title: s.title, lines: s.lines.length, chars: s.lines.join('\n').length })),
      selected: [], extracted: '', extractedChars: 0, truncated: false,
    });
  }
  const missing = [];
  if (spec && !docs.length) {
    missing.push({
      code: spec.code, role, dir: spec.dir,
      template: path.join(BRIEF_TEMPLATE_DIR, spec.file),
      hint: `把 ${spec.file} 复制到 ${spec.dir}/产出/，vN 换成版本号，按模板填写`,
    });
  }

  const limit = Math.max(80, Math.min(Number(args.limit) || BRIEF_SECTION_MAX, 60000));
  if (selRaw.length) {
    for (const d of docs) {
      const parsed = parseDoc(readDocText(d.file));
      const seen = new Set();
      const picked = [];
      for (const h of matchSections(parsed.sections, selRaw)) {
        if (seen.has(h.title)) continue;
        seen.add(h.title);
        picked.push(h);
      }
      if (!picked.length) {
        fail('SECTION_NOT_FOUND', `区块没找到：${selRaw.join('、')}`, {
          file: d.rel, available: parsed.sections.map((s) => s.title),
        });
      }
      let out = '';
      for (const h of picked) out += (out ? '\n\n' : '') + `## ${h.title}\n` + h.lines.join('\n').replace(/\s+$/, '');
      d.selected = picked.map((h) => h.title);
      d.extractedChars = out.length;
      if (out.length > limit) {
        out = out.slice(0, Math.max(0, limit - 40)) + `\n\n…（区块超限截断：${out.length} 字 > ${limit} 字上限）`;
        d.truncated = true;
      }
      d.extracted = out;
    }
  }

  appendEvent({
    role: token.role, sessionId, action: 'brief', project: projectName, target: role,
    note: `docs=${docs.length} sections=${selRaw.join(',') || '-'} missing=${missing.length}`,
    data: { role, files: docs.map((d) => d.rel), sections: selRaw },
  });
  addReadReceipt({
    role: token.role, sessionId, kind: 'brief', project: projectName,
    proposalId: '', proposalHash: '', baseHash: docs.map((d) => d.hash).join(','),
    docs: docs.map((d) => d.rel),
  });

  if (args.json) {
    jsonOut({ ok: true, role, project: projectName, discipline: OUTPUT_DISCIPLINE, docs, missing });
    return;
  }
  const lines = [];
  lines.push(`=== brief · ${spec ? spec.label : role} · ${projectName} ===`);
  lines.push(`纪律: ${OUTPUT_DISCIPLINE}`);
  for (const d of docs) {
    if (selRaw.length) {
      lines.push(`== ${d.name}（${d.rel}）==`);
      lines.push(d.extracted);
    } else {
      lines.push(`${d.name}  ${d.rel}  ${d.size}B  sha=${shortHash(d.hash, 10)}`);
      const metaBits = Object.entries(d.meta).map(([k, v]) => `${k}=${truncate(String(v), 40)}`).join(' ');
      lines.push(`  元数据: ${metaBits || '（无 YAML 头）'}`);
      lines.push(`  区块(${d.sections.length}): ${d.sections.map((s) => `${s.title}(${s.lines}行)`).join(' ') || '（无）'}`);
      lines.push(`  提取: team.mjs brief --boot <令牌> --role ${role} --project "${projectName}" --section <区块标题>`);
    }
  }
  for (const m of missing) lines.push(`缺产出: ${m.hint} ｜ 模板: ${m.template}`);
  textOut(lines.join('\n'));
}
