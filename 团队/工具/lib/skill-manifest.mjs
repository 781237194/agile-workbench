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

/**
 * B-20261117-214842-d138（bcae AC10）：`team.mjs skill check --selftest` 的自检实现。
 * 沙盘跑 AC1–AC8 的关键机制（清单/篡改/状态漂移/格式/未登记文件/模板目录/模板写出/零写入），
 * **不写真实状态**：真实 团队.json 与 团队/工具/模板/skill/ 的 sha 前后必须一致。
 */
export function runSkillSelfCheck(opts) {
  const root = path.resolve((opts && opts.root) || process.cwd());
  const sbRoot = path.join(root, '_tmp', `skill-selftest-${process.pid}-${Date.now()}`);
  const checks = [];
  const add = (ac, ok, detail) => checks.push({ ac, ok: Boolean(ok), detail });
  const shaOf = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');
  const realStateFiles = [
    path.join(root, '团队', '状态', '团队.json'),
    path.join(root, SKILL_STATE_FILE_REL),
    ...SKILL_ROLE_FILES.map((n) => path.join(root, SKILL_TEMPLATE_DIR_REL, n)),
  ];
  const realBefore = Object.fromEntries(realStateFiles.map((f) => [path.basename(f), fs.existsSync(f) ? shaOf(f) : 'missing']));

  // 沙盘根 = sbRoot（verifySkillSet 以仓库根为基准，内部再拼 团队/...）
  const sbSkillDir = path.join(sbRoot, SKILL_DIR_REL);
  const sbStateFile = path.join(sbRoot, SKILL_STATE_FILE_REL);
  try {
    fs.mkdirSync(path.dirname(sbSkillDir), { recursive: true });
    fs.cpSync(path.join(root, SKILL_DIR_REL), sbSkillDir, { recursive: true });
    fs.mkdirSync(path.dirname(sbStateFile), { recursive: true });
    fs.copyFileSync(path.join(root, SKILL_DIR_REL, 'skill-manifest.json'), path.join(sbSkillDir, 'skill-manifest.json'));
    if (fs.existsSync(path.join(root, SKILL_STATE_FILE_REL))) fs.copyFileSync(path.join(root, SKILL_STATE_FILE_REL), sbStateFile);

    // AC1 清单+sha 干净
    const clean = verifySkillSet({ root: sbRoot, strictState: false });
    add('AC1 manifest+sha', clean.ok, clean.ok ? `${clean.manifest && clean.manifest.version} / ${Object.keys((clean.manifest && clean.manifest.files) || {}).length} 文件` : JSON.stringify(clean.findings.slice(0, 3)));

    // AC2 篡改 → TAMPERED；恢复 → ok
    const target = path.join(sbSkillDir, 'programmer1.md');
    const original = fs.readFileSync(target);
    fs.appendFileSync(target, '\n<!-- tamper -->\n', 'utf8');
    const tampered = verifySkillSet({ root: sbRoot, strictState: false });
    add('AC2 篡改检测', !tampered.ok && tampered.findings.some((f) => f.code === 'SKILL_TEMPLATE_TAMPERED'), tampered.findings.map((f) => f.code).join(','));
    fs.writeFileSync(target, original);
    add('AC2 恢复可逆', verifySkillSet({ root: sbRoot, strictState: false }).ok, 'restored');

    // AC3 状态清单漂移检测
    const sbState = JSON.parse(fs.readFileSync(sbStateFile, 'utf8'));
    sbState.version = '9.9.9';
    fs.writeFileSync(sbStateFile, JSON.stringify(sbState, null, 2), 'utf8');
    const drift = verifySkillSet({ root: sbRoot, strictState: true });
    add('AC3 状态清单漂移', !drift.ok && drift.findings.some((f) => f.code === 'SKILL_STATE_DRIFT'), drift.findings.map((f) => f.code).join(','));
    sbState.version = JSON.parse(fs.readFileSync(path.join(sbSkillDir, 'skill-manifest.json'), 'utf8')).version;
    fs.writeFileSync(sbStateFile, JSON.stringify(sbState, null, 2), 'utf8');

    // AC4 格式（删「## 判据」）
    const essay = path.join(sbSkillDir, 'pm.md');
    const essayOrig = fs.readFileSync(essay, 'utf8');
    const broken = essayOrig.replace(/## 判据[\s\S]*?(?=\n## )/, '');
    fs.writeFileSync(essay, broken, 'utf8');
    const mfFile = path.join(sbSkillDir, 'skill-manifest.json');
    const mf = JSON.parse(fs.readFileSync(mfFile, 'utf8'));
    mf.files['pm.md'] = crypto.createHash('sha256').update(broken).digest('hex');
    fs.writeFileSync(mfFile, JSON.stringify(mf, null, 2), 'utf8');
    const fmt = verifySkillSet({ root: sbRoot, strictState: false });
    add('AC4 固定格式', !fmt.ok && fmt.findings.some((f) => f.code === 'SKILL_FORMAT_INVALID'), fmt.findings.map((f) => f.code).join(','));
    fs.writeFileSync(essay, essayOrig, 'utf8');
    mf.files['pm.md'] = crypto.createHash('sha256').update(essayOrig).digest('hex');
    fs.writeFileSync(mfFile, JSON.stringify(mf, null, 2), 'utf8');

    // AC5 未登记文件 → EXTRA
    const extra = path.join(sbSkillDir, 'rogue.md');
    fs.writeFileSync(extra, '# rogue\n', 'utf8');
    const ext = verifySkillSet({ root: sbRoot, strictState: false });
    add('AC5 未登记文件', !ext.ok && ext.findings.some((f) => f.code === 'SKILL_MANIFEST_EXTRA'), ext.findings.map((f) => f.code).join(','));
    fs.rmSync(extra);

    // AC6 公共模板目录六主题齐全
    const tplDir = path.join(root, SKILL_TEMPLATE_DIR_REL);
    const tplMissing = SKILL_ROLE_FILES.filter((n) => !fs.existsSync(path.join(tplDir, n)));
    add('AC6 模板目录', tplMissing.length === 0, tplMissing.length ? `缺 ${tplMissing.join(',')}` : '6/6');

    // AC7 模板写出（沙盘）
    const outDir = path.join(sbRoot, 'tpl-out');
    const wrote = writeSkillTemplates({ root, out: outDir, force: true });
    const outOk = wrote.ok && wrote.written.length === SKILL_ROLE_FILES.length
      && SKILL_ROLE_FILES.every((n) => shaOf(path.join(outDir, n)) === shaOf(path.join(tplDir, n)));
    add('AC7 模板写出', outOk, `written=${(wrote.written || []).length}`);

    // AC8 零写入真实状态
    const realAfter = Object.fromEntries(realStateFiles.map((f) => [path.basename(f), fs.existsSync(f) ? shaOf(f) : 'missing']));
    const unchanged = JSON.stringify(realBefore) === JSON.stringify(realAfter);
    add('AC8 零写入真实状态', unchanged, unchanged ? 'sha 前后一致' : 'sha 变了');
  } catch (e) {
    add('SELFTEST_INTERNAL', false, String((e && e.message) || e).slice(0, 200));
  } finally {
    try { fs.rmSync(sbRoot, { recursive: true, force: true }); } catch { /* 沙盘清理失败不阻断 */ }
  }
  return { ok: checks.every((c) => c.ok), checks, realBefore };
}
