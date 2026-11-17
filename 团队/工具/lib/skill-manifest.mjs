/**
 * T-20261117-211626-c2b5 / B-20261117-212853-3027：基础流程 skill 清单内核（单源，供 CLI 与脚本复用）。
 *
 * 双落点：
 *   - `团队/skill/基础流程/skill-manifest.json`：随 skill 目录分发的清单（历史落点，兼容保留）；
 *   - `团队/状态/技能清单.json`：需求 AC5 指定的**正式落点**（状态目录，程序可派生、可审计）。
 * 两者内容同源（同一份 files/sha/version/approvedBy），任一处不一致都判红。
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const SKILL_DIR_REL = '团队/skill/基础流程';
export const SKILL_STATE_FILE_REL = '团队/状态/技能清单.json';
export const SKILL_TEMPLATE_DIR_REL = '团队/工具/模板/skill';
export const SKILL_ROLE_FILES = ['pm.md', 'product.md', 'analyst.md', 'programmer1.md', 'programmer2.md', 'tester.md'];
export const REQUIRED_SECTIONS = ['标题', '适用场景', '前置条件', '步骤', '判据', '反例', '版本'];

export function sha256OfFile(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

/**
 * 校验 skill 集合：manifest + 文件 sha + 固定格式 + 未登记文件。
 * @param {{root:string, strictState?:boolean}} opts root=仓库根/沙盘根；strictState=true 时状态清单缺失也判红
 */
export function verifySkillSet(opts) {
  const root = path.resolve((opts && opts.root) || process.cwd());
  const strictState = Boolean(opts && opts.strictState);
  const dir = path.join(root, SKILL_DIR_REL);
  const manifestFile = path.join(dir, 'skill-manifest.json');
  const stateFile = path.join(root, SKILL_STATE_FILE_REL);
  const findings = [];
  const add = (code, file, note) => findings.push({ code, file, note });

  if (!fs.existsSync(dir)) {
    add('SKILL_TEMPLATE_MISSING', SKILL_DIR_REL, '基础流程 skill 目录不存在');
    return { ok: false, findings, manifest: null, state: null, dir, manifestFile, stateFile };
  }
  if (!fs.existsSync(manifestFile)) {
    add('SKILL_MANIFEST_MISSING', `${SKILL_DIR_REL}/skill-manifest.json`, '缺 manifest');
    return { ok: false, findings, manifest: null, state: null, dir, manifestFile, stateFile };
  }
  let manifest = null;
  try { manifest = JSON.parse(fs.readFileSync(manifestFile, 'utf8')); } catch { manifest = null; }
  if (!manifest || typeof manifest !== 'object') {
    add('SKILL_MANIFEST_INVALID', `${SKILL_DIR_REL}/skill-manifest.json`, 'JSON 解析失败');
    return { ok: false, findings, manifest: null, state: null, dir, manifestFile, stateFile };
  }
  const invalid = [];
  if (Number(manifest.schema || 0) !== 1) invalid.push('schema≠1');
  if (!String(manifest.version || '').trim()) invalid.push('缺 version');
  if (!String(manifest.approvedBy || '').trim()) invalid.push('缺 approvedBy');
  if (!String(manifest.approvedAt || '').trim()) invalid.push('缺 approvedAt');
  if (!manifest.files || typeof manifest.files !== 'object' || !Object.keys(manifest.files).length) invalid.push('缺 files');
  if (invalid.length) add('SKILL_MANIFEST_INVALID', `${SKILL_DIR_REL}/skill-manifest.json`, invalid.join('；'));

  const listed = Object.keys(manifest.files || {});
  for (const rel of listed) {
    const abs = path.join(dir, rel);
    if (!fs.existsSync(abs)) { add('SKILL_TEMPLATE_MISSING', `${SKILL_DIR_REL}/${rel}`, 'manifest 登记但磁盘缺失'); continue; }
    const actual = sha256OfFile(abs);
    const expect = String(manifest.files[rel] || '');
    if (actual !== expect) add('SKILL_TEMPLATE_TAMPERED', `${SKILL_DIR_REL}/${rel}`, `sha ${actual.slice(0, 12)} ≠ 清单 ${expect.slice(0, 12)}`);
    if (/^(00-索引|index)\.md$/.test(rel)) continue;
    const text = fs.readFileSync(abs, 'utf8');
    const missing = REQUIRED_SECTIONS.filter((sec) => (sec === '标题' ? !/^#\s+\S+/m.test(text) : !new RegExp(`^##\\s*${sec}`, 'm').test(text)));
    if (missing.length) add('SKILL_FORMAT_INVALID', `${SKILL_DIR_REL}/${rel}`, `缺小节：${missing.join('、')}`);
  }
  for (const name of fs.readdirSync(dir).filter((n) => n.endsWith('.md'))) {
    if (!Object.prototype.hasOwnProperty.call(manifest.files || {}, name)) {
      add('SKILL_MANIFEST_EXTRA', `${SKILL_DIR_REL}/${name}`, '文件未登记在 manifest');
    }
  }

  // 正式落点：团队/状态/技能清单.json（与 manifest 同源；缺失/不一致都判红）
  let state = null;
  if (!fs.existsSync(stateFile)) {
    if (strictState) add('SKILL_STATE_MISSING', SKILL_STATE_FILE_REL, '需求 AC5 落点缺失（团队/状态/技能清单.json）');
  } else {
    try { state = JSON.parse(fs.readFileSync(stateFile, 'utf8')); } catch { state = null; }
    if (!state || typeof state !== 'object') add('SKILL_STATE_INVALID', SKILL_STATE_FILE_REL, 'JSON 解析失败');
    else {
      if (String(state.version || '') !== String(manifest.version || '')) add('SKILL_STATE_DRIFT', SKILL_STATE_FILE_REL, `version ${state.version} ≠ manifest ${manifest.version}`);
      if (String(state.approvedBy || '') !== String(manifest.approvedBy || '')) add('SKILL_STATE_DRIFT', SKILL_STATE_FILE_REL, 'approvedBy 不一致');
      const stateFiles = state.files && typeof state.files === 'object' ? state.files : {};
      for (const [name, sha] of Object.entries(manifest.files || {})) {
        if (stateFiles[name] !== sha) add('SKILL_STATE_DRIFT', SKILL_STATE_FILE_REL, `${name} 与 manifest sha 不一致`);
      }
    }
  }

  return { ok: findings.length === 0, findings, manifest, state, dir, manifestFile, stateFile };
}

/** 由 manifest 派生正式落点 团队/状态/技能清单.json（append-only 语义：整文件重写但只由本函数写）。 */
export function writeSkillStateFile(opts) {
  const root = path.resolve((opts && opts.root) || process.cwd());
  const verify = verifySkillSet({ root, strictState: false });
  if (!verify.manifest) return { ok: false, code: 'SKILL_MANIFEST_MISSING' };
  const stateFile = verify.stateFile;
  const row = {
    schema: 1,
    version: verify.manifest.version,
    approvedBy: verify.manifest.approvedBy,
    approvedAt: verify.manifest.approvedAt,
    dir: SKILL_DIR_REL,
    manifest: `${SKILL_DIR_REL}/skill-manifest.json`,
    files: verify.manifest.files,
    note: '程序派生文件：由 team.mjs skill verify --write-state / scripts/skill-check.cjs --write-state 生成；与 manifest 同源。',
  };
  fs.mkdirSync(path.dirname(stateFile), { recursive: true });
  fs.writeFileSync(stateFile, JSON.stringify(row, null, 2) + '\n', 'utf8');
  return { ok: true, file: stateFile, version: row.version };
}

/** 把六主题模板写到目标目录（默认项目内 skill/；已存在不覆盖除非 force）。 */
export function writeSkillTemplates(opts) {
  const root = path.resolve((opts && opts.root) || process.cwd());
  const outDir = path.resolve((opts && opts.out) || path.join(root, 'skill'));
  const force = Boolean(opts && opts.force);
  const tplDir = path.join(root, SKILL_TEMPLATE_DIR_REL);
  if (!fs.existsSync(tplDir)) return { ok: false, code: 'SKILL_TEMPLATE_DIR_MISSING', dir: tplDir };
  fs.mkdirSync(outDir, { recursive: true });
  const written = [];
  const skipped = [];
  for (const name of SKILL_ROLE_FILES) {
    const src = path.join(tplDir, name);
    if (!fs.existsSync(src)) { skipped.push({ name, why: 'template-missing' }); continue; }
    const dst = path.join(outDir, name);
    if (fs.existsSync(dst) && !force) { skipped.push({ name, why: 'exists' }); continue; }
    fs.copyFileSync(src, dst);
    written.push(name);
  }
  return { ok: written.length > 0 || skipped.length === 0, dir: outDir, written, skipped, code: written.length ? '' : 'SKILL_TEMPLATE_NOOP' };
}
