#!/usr/bin/env node
'use strict';
/**
 * test-bf05-rolecard-sync.cjs —— R-bf05（T-20261119-181230-feee）角色卡/模板版本化同步夹具
 *
 * 覆盖：AC1（新项目带标记 + 0 差异 + dry-run 不写卡）、AC2（老卡检测落后且不写）、
 * AC3（apply 非破坏：新增 §H 标准节 + manual 段与私章逐字保留 + 备份 + 审计 + 标记更新）、
 * AC4（boot/ensure 不自动写卡，只有 --apply 会写）、AC5（同 key 不同内容 → conflict，ok=false/partial，其余照写）、
 * AC6（本人/PM 权限、越权 PERMISSION_DENIED、幂等第二次 wrote=false）、AC7（manifest drift / 删除 manifest 仍按源文本 sha）。
 *
 * 全部在隔离沙盘（TEAM_ROOT/TEAM_PROJECTS_ROOT/TEAM_WORKBENCH_JSON/AWB_DATA_DIR 全指临时目录 + TEAM_SELFTEST=1）。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const TEAM_TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const LIB = path.join(ROOT, '团队', '工具', 'lib');
const OUT = (() => {
  const i = process.argv.indexOf('--out');
  return i > 0 && process.argv[i + 1] ? path.resolve(process.argv[i + 1]) : path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-bf05');
})();
const rows = [];
function check(name, ok, detail) {
  let text = ''; try { text = JSON.stringify(detail === undefined ? null : detail); } catch { text = String(detail); }
  rows.push({ name, ok: Boolean(ok), detail: ok ? undefined : text });
  console.log((ok ? 'PASS' : 'FAIL') + '  ' + name + (ok ? '' : ' :: ' + text.slice(0, 700)));
}
function sha(buf) { return crypto.createHash('sha256').update(buf).digest('hex'); }
function shaFile(f) { try { return sha(fs.readFileSync(f)); } catch { return '-'; } }

const sb = fs.mkdtempSync(path.join(os.tmpdir(), 'bf05-'));
const teamDir = path.join(sb, '团队');
const projectsDir = path.join(sb, '项目');
const dataDir = path.join(sb, 'data');
const project = '沙盘bf05';
const projDir = path.join(projectsDir, project);
Object.assign(process.env, {
  TEAM_ROOT: teamDir, TEAM_PROJECTS_ROOT: projectsDir,
  TEAM_WORKBENCH_JSON: path.join(dataDir, 'workbench.json'), AWB_DATA_DIR: dataDir,
  TEAM_SELFTEST: '1', AWB_ROUTE_DAEMON: 'off',
});
const env = { ...process.env };
function run(args) {
  const r = spawnSync(process.execPath, [TEAM_TOOL, ...args], { cwd: ROOT, env, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 });
  const stdout = String(r.stdout || '');
  const stderr = String(r.stderr || '');
  let json = null;
  const start = stdout.indexOf('{');
  if (start >= 0) { try { json = JSON.parse(stdout.slice(start)); } catch { json = null; } }
  return { code: r.status, stdout, stderr, json, out: stdout + stderr };
}
const cardOf = (role) => path.join(projDir, { pm: '项目经理', product: '产品', analyst: '需求分析师', programmer1: '程序员A', programmer2: '程序员B', tester: '测试人员' }[role], '角色卡.md');
const readCard = (role) => fs.readFileSync(cardOf(role), 'utf8');
const writeCard = (role, text) => fs.writeFileSync(cardOf(role), text, 'utf8');

(async () => {
  try {
    const sync = await import(pathToFileURL(path.join(LIB, 'rolecard-sync.mjs')).href);
    const realTeam = path.join(ROOT, '团队', '状态', '团队.json');
    const realBefore = shaFile(realTeam);

    // ── B-13d7（节归属错位）：显式 begin/end 配对解析，不按「上一个标题」推断 ──────────
    {
      // ① 连续两节相邻：标准节之后紧跟普通节，第二节的正文不能被算进第一段 block
      const t1 = [
        '## A 节', '',
        '<!-- rolecard-standard:a:begin -->', '## A 节', '正文A', '<!-- rolecard-standard:a:end -->',
        '## B 节', '正文B',
      ].join('\n');
      const p1 = sync.parseCard(t1);
      const a1 = p1.sections.find((s) => s.key === 'a');
      const b1 = p1.sections.find((s) => s.key === 'title:B-节' || /B 节/.test(s.title));
      check('B13d7① 连续两节相邻：节 a 只覆盖 block（不含 B 节正文）且 B 节独立',
        Boolean(a1) && a1.standard && !/正文B/.test(a1.text) && Boolean(b1) && !b1.standard && /正文B/.test(b1.text),
        { a: a1 && { key: a1.key, standard: a1.standard, hasB: /正文B/.test(a1.text) }, b: b1 && { key: b1.key, has: /正文B/.test(b1.text) } });

      // ② 目标节在中间：A 普通节 / B 标准 block / C 普通节，B 的 begin 行不能算到 A
      const t2 = ['## A', '正文A', '<!-- rolecard-standard:b:begin -->', '## B', '正文B', '<!-- rolecard-standard:b:end -->', '## C', '正文C'].join('\n');
      const p2 = sync.parseCard(t2);
      const byTitle = (p, t) => p.sections.find((s) => String(s.title).includes(t));
      const a2 = byTitle(p2, 'A'); const b2 = byTitle(p2, 'B'); const c2 = byTitle(p2, 'C');
      check('B13d7② 目标节在中间：A/C 不被并入，B 的 block 行首归属正确',
        Boolean(a2 && b2 && c2) && !a2.standard && b2.standard && !c2.standard
        && !/rolecard-standard/.test(a2.text) && /rolecard-standard:b:begin/.test(b2.text) && !/rolecard-standard/.test(c2.text),
        { a: a2 && a2.text.slice(0, 60), b: b2 && b2.standard, c: c2 && c2.text.slice(0, 40) });

      // ③ begin 在行尾：标题行末尾带 begin（单行内起止 + 跨行各一例）
      const t3 = [
        '## X 节 <!-- rolecard-standard:x:begin -->', '正文X', '<!-- rolecard-standard:x:end -->',
        '## Y 节', '正文Y',
      ].join('\n');
      const p3 = sync.parseCard(t3);
      const x3 = p3.sections.find((s) => s.key === 'x');
      const y3 = p3.sections.find((s) => String(s.title).includes('Y 节'));
      check('B13d7③ begin 在行尾（标题行内）：仍归属 x 且不吞掉 Y 节',
        Boolean(x3) && x3.standard && !/正文Y/.test(x3.text) && Boolean(y3) && !y3.standard && /正文Y/.test(y3.text),
        { x: x3 && x3.standard, hasY: x3 && /正文Y/.test(x3.text), y: Boolean(y3) });

      // ④ 嵌套同类标记：外层 block 包内层 block，内层标题归属内层 key
      const t4 = [
        '<!-- rolecard-standard:outer:begin -->', '## 外节', '正文外',
        '<!-- rolecard-standard:inner:begin -->', '## 内节', '正文内', '<!-- rolecard-standard:inner:end -->',
        '尾部外', '<!-- rolecard-standard:outer:end -->',
      ].join('\n');
      const p4 = sync.parseCard(t4);
      const inner = p4.sections.find((s) => s.key === 'inner');
      const outer = p4.sections.find((s) => s.key === 'outer');
      check('B13d7④ 嵌套同类标记：内层 key=inner、外层 key=outer 且都没有被错位',
        Boolean(inner && outer) && inner.standard && outer.standard && /正文内/.test(inner.text) && !/正文外/.test(inner.text),
        { sections: p4.sections.map((s) => ({ key: s.key, standard: s.standard })) });

      // ⑤ 回归本单真实形态：apply 写出的 block（begin 行在标题前）解析后，marker 不落到前一节
      const t5 = ['## 前一节', '正文前', '<!-- rolecard-standard:scene-coverage:begin -->', '## H. 场景覆盖准则', '正文H', '<!-- rolecard-standard:scene-coverage:end -->'].join('\n');
      const p5 = sync.parseCard(t5);
      const prev = p5.sections.find((s) => String(s.title).includes('前一节'));
      const sc = p5.sections.find((s) => String(s.key).startsWith('scene-coverage'));
      check('B13d7⑤ apply 写出的 block 不把 begin 算到前一节',
        Boolean(prev) && !/rolecard-standard/.test(prev.text) && Boolean(sc) && sc.standard && /正文H/.test(sc.text),
        { prevHasMarker: prev && /rolecard-standard/.test(prev.text), scKey: sc && sc.key });
    }

    // 0) 沙盘建项目
    check('S0 team.mjs init', Boolean(run(['init', '--json']).json && run(['init', '--json']).json.ok));
    const proj = run(['project', 'create', '--name', project, '--dir', projDir, '--json']);
    check('S0b project create（新项目六卡）', Boolean(proj.json && proj.json.ok), proj.out.slice(0, 300));

    // ── AC1：新项目带标记 + sha12 == 模板源文本 sha12 + 0 差异 + dry-run 不写卡 ──
    const tplProduct = sync.templateOf('product');
    const newCard = readCard('product');
    const marker = sync.cardMarkerOf(newCard);
    check('AC1① 新卡 H1 下一行有 rolecard 标记（template/version/sha12/generated）',
      marker.exists && marker.template === 'product' && Boolean(marker.version) && Boolean(marker.sha12) && Boolean(marker.generated), marker);
    check('AC1② 卡内 sha12 == GENERATED 源文本 sha12（不含占位符/追加节）', marker.sha12 === tplProduct.sha12, { card: marker.sha12, template: tplProduct.sha12 });
    const beforeSha = shaFile(cardOf('product'));
    const dryAll = run(['rolecard', 'sync', '--project', project, '--all', '--dry-run', '--json']);
    check('AC1③ sync --all --dry-run：0 冲突、wrote=false', Boolean(dryAll.json) && dryAll.json.ok === true && dryAll.json.wrote === false && dryAll.json.conflicts === 0, dryAll.json || dryAll.out.slice(0, 300));
    check('AC1③b dry-run 不写卡（sha 不变）', shaFile(cardOf('product')) === beforeSha);

    // ── 造「老卡」：去标记 + 删 §H 标准节 + 加 manual 段与私有节 ──
    let old = readCard('product');
    old = old.split(/\r?\n/).filter((l) => !/<!--\s*rolecard:\s*template=/.test(l)).join('\n');
    const hIdx = old.indexOf('## H. 场景覆盖准则');
    if (hIdx >= 0) {
      const after = old.slice(hIdx);
      const nextH = after.slice(1).indexOf('\n## ');
      old = old.slice(0, hIdx) + (nextH >= 0 ? after.slice(nextH + 1) : '');
    }
    old = old.replace(/\s+$/, '') + '\n\n## 我的私章\n\n自留：不要动我。\n\n<!-- manual:begin -->\n手写：我的私有补充\n<!-- manual:end -->\n';
    writeCard('product', old);
    const oldSha = shaFile(cardOf('product'));
    const oldText = readCard('product');

    // ── AC2：检测落后且不写 ──
    const status = sync.rolecardStaleOf(project, 'product');
    check('AC2① 老卡被判定落后（无标记 → version=0）+ 差异处数 ≥1', status.ok && status.stale && status.cardVersion === '0' && status.diffCount >= 1, status);
    const dryOld = run(['rolecard', 'sync', '--project', project, '--role', 'product', '--dry-run', '--json']);
    const dryRole = dryOld.json && dryOld.json.roles && dryOld.json.roles[0];
    check('AC2② dry-run 含 add 场景节，wrote=false', Boolean(dryRole) && (dryRole.changes || []).some((c) => c.action === 'add' && String(c.section).startsWith('scene-coverage')) && dryRole.wrote === false, dryRole && { changes: dryRole.changes, wrote: dryRole.wrote });
    check('AC2③ dry-run 不写卡（老卡 sha 不变）', shaFile(cardOf('product')) === oldSha);

    // ── AC2①：boot 简报出现「角色卡模板落后:」行（三检测入口之一；只提示不写卡）──
    const pmCardPath = cardOf('pm');
    const pmCardBefore = fs.readFileSync(pmCardPath, 'utf8');
    fs.writeFileSync(pmCardPath, pmCardBefore.split(/\r?\n/).filter((l) => !/<!--\s*rolecard:\s*template=/.test(l)).join('\n'), 'utf8');
    const pmBootForBrief = run(['boot', '--role', 'pm', '--project', project, '--session', 'session-bf05-pm', '--json']);
    const briefingText = String((pmBootForBrief.json && pmBootForBrief.json.briefing) || '');
    check('AC2① boot 简报含「角色卡模板落后:」行（只提示、不写卡）',
      /角色卡模板落后:/.test(briefingText) && /pm/.test(briefingText), briefingText.split(/\r?\n/).filter((l) => /角色卡模板落后/.test(l)).join(' | '));

    // ── AC6①：越权 PERMISSION_DENIED（programmer1 令牌改 product 卡）──────────
    const p1Boot = run(['boot', '--role', 'programmer1', '--project', project, '--session', 'session-bf05-p1', '--json']);
    const p1Tok = p1Boot.json && p1Boot.json.token;
    const deny = run(['rolecard', 'sync', '--project', project, '--role', 'product', '--apply', '--boot', p1Tok, '--json']);
    check('AC6① 越权 apply（programmer1 改 product）→ PERMISSION_DENIED 且卡不变',
      Boolean(deny.json && deny.json.code === 'PERMISSION_DENIED') && shaFile(cardOf('product')) === oldSha, deny.json || deny.out.slice(0, 200));

    // ── AC3：PM apply（本人也可；这里用 pm 令牌示范 PM 对任意角色 apply）────────
    const pmBoot = run(['boot', '--role', 'pm', '--project', project, '--session', 'session-bf05-pm', '--json']);
    const pmTok = pmBoot.json && pmBoot.json.token;
    const apply1 = run(['rolecard', 'sync', '--project', project, '--role', 'product', '--apply', '--boot', pmTok, '--json']);
    const applyRole = apply1.json && apply1.json.roles && apply1.json.roles[0];
    const afterText = readCard('product');
    check('AC3① apply 新增 §H 场景节并含六类关键词', /## H\. 场景覆盖准则|## 场景覆盖准则/.test(afterText)
      && ['入口', '正常', '空值', '失败', '并发', '降级'].every((k) => afterText.includes(k)), Boolean(applyRole) && applyRole.added);
    check('AC3② manual 段逐字保留', afterText.includes('<!-- manual:begin -->\n手写：我的私有补充\n<!-- manual:end -->'), null);
    check('AC3③ 私有节逐字保留', afterText.includes('## 我的私章\n\n自留：不要动我。'), null);
    const backupDir = applyRole && applyRole.backup;
    check('AC3④ 备份 sha == 改前卡 sha', Boolean(backupDir) && shaFile(path.join(backupDir, '角色卡.md')) === oldSha, { backupDir, backupSha: backupDir ? shaFile(path.join(backupDir, '角色卡.md')) : '', oldSha });
    const newMarker = sync.cardMarkerOf(afterText);
    check('AC3⑤ 标记已更新为当前模板 sha12', newMarker.exists && newMarker.sha12 === tplProduct.sha12, newMarker);
    const auditFile = path.join(teamDir, '状态', '项目', project, 'rolecard同步.jsonl');
    const auditRows = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
    const lastAudit = auditRows[auditRows.length - 1];
    check('AC3⑥ 审计 1 行含 before/after sha', Boolean(lastAudit) && lastAudit.beforeSha256 === oldSha && Boolean(lastAudit.afterSha256), lastAudit || auditRows.length);

    // ── AC6④：幂等（第二次 apply 已是最新，wrote=false）────────────────────
    const apply2 = run(['rolecard', 'sync', '--project', project, '--role', 'product', '--apply', '--boot', pmTok, '--json']);
    const apply2Role = apply2.json && apply2.json.roles && apply2.json.roles[0];
    check('AC6④ 第二次 apply 幂等：wrote=false 且卡不变', Boolean(apply2Role) && apply2Role.wrote === false && shaFile(cardOf('product')) === shaFile(cardOf('product')), apply2Role && { wrote: apply2Role.wrote, message: apply2Role.message });

    // ── AC4：boot ×2 / project ensure 不自动写卡 ────────────────────────────
    const before4 = shaFile(cardOf('product'));
    run(['boot', '--role', 'pm', '--project', project, '--session', 'session-bf05-pm', '--json']);
    run(['boot', '--role', 'pm', '--project', project, '--session', 'session-bf05-pm', '--json']);
    run(['project', 'ensure', '--name', project, '--dir', projDir, '--json']);
    check('AC4 boot×2 + project ensure 不改卡（只有 --apply 会写）', shaFile(cardOf('product')) === before4, { before: before4 });

    // ── AC5：同 key 不同内容 → conflict，ok=false/partial，该节不写、其余照写 ──
    // B-7714 后模板把注入的 §H 标准段改为显式 key `scene-coverage-h`，卡里「## H. 场景覆盖准则」属于该
    // 标准段、不再走关键词匹配；本断言改用卡自带的「场景覆盖门」节（key=scene-coverage，与模板同 key）来造冲突。
    let conflictCard = readCard('product');
    const hStart5 = conflictCard.indexOf('## 场景覆盖门');
    if (hStart5 < 0) throw new Error('AC5 前置失败：卡内没有「场景覆盖门」节');
    const hNext5 = conflictCard.slice(hStart5 + 3).search(/\n## /);
    const hEnd5 = hNext5 >= 0 ? hStart5 + 3 + hNext5 : conflictCard.length;
    conflictCard = conflictCard.slice(0, hStart5)
      + '## 场景覆盖门（§H 强制 · Owner 2026-11-19 · 是 RR 的第五件事）\n\n- 本人改写：与模板不同。\n'
      + (hEnd5 < conflictCard.length ? conflictCard.slice(hEnd5 + 1) : '');
    // 同时删掉一个标准节（workflow-align）以验证「其余节照写」
    const wStart5 = conflictCard.indexOf('## 现行工作流对齐');
    if (wStart5 >= 0) {
      const wNext5 = conflictCard.slice(wStart5 + 3).search(/\n## /);
      conflictCard = conflictCard.slice(0, wStart5) + (wNext5 >= 0 ? conflictCard.slice(wStart5 + 3 + wNext5 + 1) : '');
    }
    writeCard('product', conflictCard);
    const before5 = shaFile(cardOf('product'));
    const conflictApply = run(['rolecard', 'sync', '--project', project, '--role', 'product', '--apply', '--boot', pmTok, '--json']);
    const confRole = conflictApply.json && conflictApply.json.roles && conflictApply.json.roles[0];
    const after5 = readCard('product');
    check('AC5① 冲突时 ok=false + partial=true + 退出码非 0', Boolean(conflictApply.json) && conflictApply.json.ok === false && conflictApply.json.partial === true && conflictApply.code !== 0, { ok: conflictApply.json && conflictApply.json.ok, partial: conflictApply.json && conflictApply.json.partial, code: conflictApply.code });
    check('AC5② 该节原样保留（未被覆盖）', after5.includes('本人改写：与模板不同。'), null);
    check('AC5③ 其余节照写（workflow-align 已补回）', /## 现行工作流对齐/.test(after5)
      && Boolean(confRole) && [].concat(confRole.added || [], confRole.applied || []).includes('workflow-align'),
      confRole && { added: confRole.added, applied: confRole.applied });
    check('AC5④ 卡确实发生了写入（before≠after）', shaFile(cardOf('product')) !== before5, { before5 });

    // ── AC7：manifest drift / 删除 manifest ─────────────────────────────────
    const manifestFile = path.join(teamDir, '工具', '模板', '角色卡模板版本.json');
    const writeManifestRaw = (obj) => { fs.mkdirSync(path.dirname(manifestFile), { recursive: true }); fs.writeFileSync(manifestFile, JSON.stringify(obj, null, 2) + '\n', 'utf8'); };
    writeManifestRaw({ schema: 1, roles: { product: { version: '9.9.9', sha256: 'deadbeef'.repeat(8), sha12: 'deadbeef' } } });
    const drift = sync.rolecardStaleOf(project, 'product');
    check('AC7① manifest 与源文本不符 → TEMPLATE_MANIFEST_DRIFT 且按源文本 sha 判定',
      drift.ok && drift.reasons.includes('TEMPLATE_MANIFEST_DRIFT') && drift.templateSha12 === tplProduct.sha12, drift && { reasons: drift.reasons, templateSha12: drift.templateSha12 });
    fs.rmSync(manifestFile, { force: true });
    const noManifest = sync.rolecardStaleOf(project, 'product');
    check('AC7② 删除 manifest → 仍按源文本 sha 检测（不崩）', noManifest.ok && noManifest.templateSha12 === tplProduct.sha12, noManifest && { ok: noManifest.ok, templateSha12: noManifest.templateSha12 });

    // ── AC9c：异名节只出 rename 建议，不自动改 ──────────────────────────────
    // 同 AC5：改用卡自带的「场景覆盖门」节（关键词匹配 → 改标题后应只给 rename 建议）。
    let renameCard = readCard('product');
    const rStart = renameCard.indexOf('## 场景覆盖门');
    if (rStart < 0) throw new Error('AC9c 前置失败：卡内没有「场景覆盖门」节');
    const rNext = renameCard.slice(rStart + 3).search(/\n## /);
    const rEnd = rNext >= 0 ? rStart + 3 + rNext : renameCard.length;
    const rSeg = renameCard.slice(rStart, rEnd)
      .split(/\r?\n/).filter((l) => !/rolecard-standard:/.test(l)).join('\n')
      .replace(/^## 场景覆盖门[^\n]*/, '## 场景覆盖门（§H 强制 · 本人写法）');
    renameCard = renameCard.slice(0, rStart) + rSeg + renameCard.slice(rEnd);
    writeCard('product', renameCard);
    const beforeRename = shaFile(cardOf('product'));
    const dryRename = run(['rolecard', 'sync', '--project', project, '--role', 'product', '--dry-run', '--json']);
    const renameRole = dryRename.json && dryRename.json.roles && dryRename.json.roles[0];
    check('AC9c 异名节 → 只输出 rename 建议且不自动改（dry-run 不写卡）',
      Boolean(renameRole) && (renameRole.renames || []).length >= 1 && shaFile(cardOf('product')) === beforeRename,
      renameRole && { renames: renameRole.renames, shaSame: shaFile(cardOf('product')) === beforeRename });

    // ── 隔离：真实团队.json 零写入 ─────────────────────────────────────────
    check('S1 隔离：真实 团队/状态/团队.json 零写入', shaFile(realTeam) === realBefore, { before: realBefore.slice(0, 12), after: shaFile(realTeam).slice(0, 12) });
  } finally {
    try { fs.rmSync(sb, { recursive: true, force: true }); } catch { /* ignore */ }
  }
  const pass = rows.filter((r) => r.ok).length;
  const fail = rows.length - pass;
  try {
    fs.mkdirSync(OUT, { recursive: true });
    fs.writeFileSync(path.join(OUT, 'test-bf05-rolecard-sync.json'), JSON.stringify({
      generatedAt: new Date().toISOString(),
      head: (() => { try { return spawnSync('git', ['rev-parse', '--short', 'HEAD'], { cwd: ROOT, encoding: 'utf8' }).stdout.trim(); } catch { return ''; } })(),
      task: 'T-20261119-181230-feee', pass, fail, total: rows.length, rows,
    }, null, 2), 'utf8');
  } catch { /* ignore */ }
  console.log(`\n${pass}/${rows.length} PASS${fail ? ` · ${fail} FAIL` : ''}`);
  process.exit(fail ? 1 : 0);
})();
