'use strict';
/**
 * 夹具：流程.md §D2「子代理使用边界」进角色卡模板 + rolecard sync 标准节 + 升级包覆盖
 * （派单 M-20261120-120239-94881f；Owner 2026-11-20 12:0x「升级版本或其他用户也要能同步更新」）。
 *
 * 断言分四组：
 *   A 模板（新建项目卡）：六角色 GENERATED 源文本与渲染卡都含该节，且结论/允许三项/禁止三项/补三件事/
 *     根因/传播要求四条齐全；标题与 rolecard-sync 的 STANDARD_TITLES 逐字一致；关键词不会误命中「## 子代理」。
 *   B 措辞一致：`团队/流程.md §D2` 原文的关键句全部出现在模板（改流程忘了改模板 → 红）。
 *   C 升级包覆盖（§D2 传播要求③）：`团队/工具`（含 scaffold.mjs / rolecard-sync.mjs）在 UPGRADE_TREE、
 *     `团队/流程.md` 在 UPGRADE_FILES 与 PACKAGE_ASSERT_ENTRIES，且不被 NEVER_PACKAGE 排除。
 *   D 老卡同步（沙盘真 CLI）：删掉该节模拟升级前旧卡 → `rolecard sync --role <r> --dry-run` 报 add →
 *     `--apply` 写入（带 begin/end 标记 + 备份 + 审计）→ 二次 apply 0 差异（幂等）；PM 可代做；
 *     非本人非 PM 改他人卡 → PERMISSION_DENIED；`--apply --all` → BAD_ARGS（R-bf05 口径不变）。
 *
 * 隔离：mkdtemp 沙盘 + 四根 env（TEAM_ROOT / TEAM_PROJECTS_ROOT / TEAM_WORKBENCH_JSON / AWB_DATA_DIR）
 *       + TEAM_SELFTEST=1；不读写真实账本；末尾断言真实 团队.json / workbench.json / 六张真实角色卡 sha256 不变。
 * 跑法：node scripts/test-d2-subagent-boundary.cjs   （AWB_KEEP_SANDBOX=1 保留沙盘）
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-d2-boundary-'));
const TEAM = path.join(SB, '团队');
const PROJECTS = path.join(SB, '项目');
const TOOL = path.join(TEAM, '工具', 'team.mjs');
const PROJECT = 'd2-boundary-沙盘';
const ROLE_DIRS = { pm: '项目经理', product: '产品', analyst: '需求分析师', programmer1: '程序员A', programmer2: '程序员B', tester: '测试人员' };
const HEADING = '## 子代理使用边界（流程.md §D2）';
const env = {
  ...process.env,
  TEAM_ROOT: TEAM,
  TEAM_PROJECTS_ROOT: PROJECTS,
  TEAM_WORKBENCH_JSON: path.join(SB, 'workbench.json'),
  AWB_DATA_DIR: path.join(SB, 'data'),
  TEAM_SELFTEST: '1',
};
delete env.DSH_SESSION_ID;

const results = [];
function check(id, name, ok, detail) {
  results.push({ id, ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${name}${ok ? '' : '  ← ' + String(JSON.stringify(detail === undefined ? '' : detail)).slice(0, 320)}`);
  if (!ok) process.exitCode = 1;
}
function sha(file) { try { return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16); } catch { return '(missing)'; } }
function run(args) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { cwd: SB, env, encoding: 'utf8' });
  let json = null; try { json = JSON.parse(String(r.stdout || '')); } catch { json = null; }
  return { status: r.status, stdout: String(r.stdout || ''), stderr: String(r.stderr || ''), text: String(r.stdout || '') + String(r.stderr || ''), json };
}
function stripSection(text, heading) {
  // 优先按标准块整块删（模板自 §D2 起把该节包在 begin/end 里）
  const key = 'subagent-boundary';
  const begin = `<!-- rolecard-standard:${key}:begin -->`;
  const endTag = `<!-- rolecard-standard:${key}:end -->`;
  const b = text.indexOf(begin);
  if (b >= 0) {
    const e = text.indexOf(endTag, b + begin.length);
    if (e >= 0) return (text.slice(0, b) + text.slice(e + endTag.length)).replace(/\n{3,}/g, '\n\n');
  }
  // 旧式（无标记）节：按标题删到下一个 ## 标题
  const i = text.indexOf(heading);
  if (i < 0) return text;
  const rest = text.slice(i + heading.length);
  const m = /\n##\s+/.exec(rest);
  const end = m ? i + heading.length + m.index : text.length;
  return (text.slice(0, i) + text.slice(end)).replace(/\n{3,}/g, '\n\n');
}
function stripMarker(text) { return text.replace(/^<!--\s*rolecard:.*-->\s*$/m, '').replace(/\n{3,}/g, '\n\n'); }
function cleanup() {
  if (process.env.AWB_KEEP_SANDBOX) { console.log(`\n[AWB_KEEP_SANDBOX=1] 沙盘保留：${SB}`); return; }
  try { fs.rmSync(SB, { recursive: true, force: true, maxRetries: 8, retryDelay: 200 }); } catch { /* 清理失败不影响结论 */ }
}

(async () => {
  const realTeam = path.join(ROOT, '团队', '状态', '团队.json');
  const realWb = path.join(ROOT, 'data', 'userdata', 'workbench.json');
  const realCards = Object.fromEntries(Object.values(ROLE_DIRS).map((d) => [d, path.join(ROOT, '项目', '工作台改造修复', d, '角色卡.md')]));
  const shaBefore = { team: sha(realTeam), wb: sha(realWb), cards: Object.fromEntries(Object.entries(realCards).map(([k, v]) => [k, sha(v)])) };

  const scaffold = await import(pathToFileURL(path.join(ROOT, '团队', '工具', 'lib', 'scaffold.mjs')).href);
  const sync = await import(pathToFileURL(path.join(ROOT, '团队', '工具', 'lib', 'rolecard-sync.mjs')).href);
  const roles = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];

  /* ── A 模板：GENERATED 源文本 + 渲染卡 ─────────────────────────────── */
  {
    const missSrc = roles.filter((r) => {
      const src = scaffold.templateSourceOf(r);
      return !src || !String(src.source || '').includes(HEADING) || !String(src.source || '').includes('不得承担会产生代码');
    });
    check('A1', '六角色 GENERATED 源文本都含「子代理使用边界」节（不是只有渲染层）', missSrc.length === 0, { missing: missSrc });
    const need = {
      conclusion: '子代理不得承担会产生代码/夹具提交的活',
      allow: ['只读测量与取证', '发布机制操作', '长等待型任务'],
      deny: ['src/**', '团队/工具/lib/**', 'scripts/**', '自行判定「修好了」', '代替开发角色认领/提交缺陷单'],
      makeup: ['立缺陷单', '交账消息', 'tester 复验单', 'test_done'],
      cause: '唯一可追溯链',
      spread: ['GENERATED_ROLE_CARDS', 'subagent-boundary', 'upgrade-package-manifest.cjs', '视为未落地'],
    };
    const bad = [];
    for (const r of roles) {
      const text = scaffold.roleCard('夹具新项目', r, 'full');
      const get = (s) => text.indexOf(s) >= 0;
      if (text.indexOf(HEADING) < 0) bad.push(`${r}:缺标题`);
      if (!get(need.conclusion)) bad.push(`${r}:缺结论`);
      for (const k of need.allow) if (!get(k)) bad.push(`${r}:缺允许/${k}`);
      for (const k of need.deny) if (!get(k)) bad.push(`${r}:缺禁止/${k}`);
      for (const k of need.makeup) if (!get(k)) bad.push(`${r}:缺补三件事/${k}`);
      if (!get(need.cause)) bad.push(`${r}:缺根因`);
      for (const k of need.spread) if (!get(k)) bad.push(`${r}:缺传播要求/${k}`);
    }
    check('A2', '六角色渲染卡：结论/允许三项/禁止三项/补三件事/根因/传播要求四条齐全', bad.length === 0, bad);
    // T-76c5 AC③ 指定关键词（PM 立单时写死）：subagent/子代理、不得产生代码提交、test_done 且证据齐
    {
      const acKw = ['subagent', '子代理', '不得产生代码提交', 'test_done 且证据齐'];
      const miss = [];
      for (const r of roles) {
        const t = scaffold.roleCard('夹具新项目', r, 'full');
        for (const k of acKw) if (!t.includes(k)) miss.push(`${r}:${k}`);
      }
      check('A2b', 'T-76c5 AC③ 指定关键词在六张模板里逐字出现（subagent/子代理、不得产生代码提交、test_done 且证据齐）', miss.length === 0, miss);
    }
    check('A3', 'rolecard-sync STANDARD_TITLES 的标题与模板标题逐字一致',
      sync.STANDARD_TITLES['subagent-boundary'] === HEADING, { got: sync.STANDARD_TITLES['subagent-boundary'], want: HEADING });
    const kwRow = (sync.SECTION_KEYWORDS || []).find((r) => r.key === 'subagent-boundary');
    check('A4', 'SECTION_KEYWORDS 有 subagent-boundary 且关键词含「子代理使用边界」、不含裸「子代理」（否则误命中既有「## 子代理」节）',
      Boolean(kwRow) && kwRow.keywords.includes('子代理使用边界') && !kwRow.keywords.includes('子代理'), { row: kwRow });
    const genSrc = fs.readFileSync(path.join(ROOT, 'scripts', 'gen-role-card-template.cjs'), 'utf8');
    check('A5', '生成器接线：SUBAGENT_BOUNDARY_SECTION + ensureSubagentBoundarySection 在 buildBody 内被调用（重生成不会丢节）',
      genSrc.includes('SUBAGENT_BOUNDARY_SECTION') && genSrc.includes('text = ensureSubagentBoundarySection(text)'), {});
    check('A5b', '生成器强制重写标准节（strip 旧节后追加当前措辞）：项目卡被 sync 过旧文案时模板仍能更新到 AC 关键词',
      genSrc.includes('stripSubagentBoundarySection') && genSrc.includes('base + \'\\n\\n\' + SUBAGENT_BOUNDARY_SECTION'), {});
    // 节归属：新加节必须能被 parseCard 切成独立 key，不能被算进前一节（B-13d7 回归）
    const parsed = sync.parseCard(scaffold.roleCard('夹具新项目', 'tester', 'full'));
    const sec = parsed.sections.find((s) => s.key === 'subagent-boundary');
    check('A6', '模板节可被 parseCard 识别为独立 key=subagent-boundary（不落到前一节）',
      Boolean(sec) && String(sec.title).trim() === HEADING && String(sec.text).includes('不得承担会产生代码'), { keys: parsed.sections.map((s) => s.key) });
    // B-20261120-123253-9bc4（PM 12:33 实跑 18/20）：模板里 standard 节必须 begin/end 成对。
    // 之前的实现把该节写成纯文本、却残留了项目卡 sync 留下的 begin 行（6 begin / 0 end），
    // parseCard 会把后面的 §H 整段吞进 subagent-boundary（dry-run 报 keep / apply 出 ~2）。
    {
      const pairBad = [];
      let totalBegin = 0;
      let totalEnd = 0;
      const keyOf = (s) => (String(s).match(/:([A-Za-z0-9_~-]+):(?:begin|end)/) || [])[1];
      for (const r of roles) {
        const t = scaffold.roleCard('夹具新项目', r, 'full');
        const begins = t.match(/<!--\s*rolecard-standard:([A-Za-z0-9_~-]+):begin\s*-->/g) || [];
        const ends = t.match(/<!--\s*rolecard-standard:([A-Za-z0-9_~-]+):end\s*-->/g) || [];
        const bc = new Map();
        const ec = new Map();
        begins.forEach((x) => bc.set(keyOf(x), (bc.get(keyOf(x)) || 0) + 1));
        ends.forEach((x) => ec.set(keyOf(x), (ec.get(keyOf(x)) || 0) + 1));
        for (const k of new Set([...bc.keys(), ...ec.keys()])) {
          if ((bc.get(k) || 0) !== (ec.get(k) || 0)) pairBad.push(`${r}:${k} begin=${bc.get(k) || 0} end=${ec.get(k) || 0}`);
        }
        totalBegin += begins.length;
        totalEnd += ends.length;
        const d2b = begins.filter((x) => String(x).includes(':subagent-boundary:')).length;
        const d2e = ends.filter((x) => String(x).includes(':subagent-boundary:')).length;
        if (d2b !== 1 || d2e !== 1) pairBad.push(`${r}:subagent-boundary begin=${d2b} end=${d2e}`);
      }
      check('A7', '模板里每个 standard 节 begin 与 end 成对（六角色合计 begin=end=6；subagent-boundary 每角色 1/1）',
        pairBad.length === 0 && totalBegin === totalEnd && totalBegin === 6, { pairBad, totalBegin, totalEnd });
    }
  }

  /* ── B 措辞与 团队/流程.md §D2 一致（改流程忘改模板 → 红） ───────── */
  {
    const flow = fs.readFileSync(path.join(ROOT, '团队', '流程.md'), 'utf8');
    const i = flow.indexOf('## D2.');
    const j = flow.indexOf('\n## E.');
    const d2 = (i >= 0 && j > i) ? flow.slice(i, j) : '';
    const phrases = [
      '子代理不得承担会产生代码/夹具提交的活',
      '只读测量与取证',
      '发布机制操作',
      '长等待型任务',
      '修改 `src/**`、`团队/工具/lib/**`、`scripts/**`',
      '代替开发角色认领/提交缺陷单',
      '立缺陷单',
      'tester 复验单',
      '唯一可追溯链',
      '传播要求',
    ];
    const missingInFlow = phrases.filter((p) => d2.indexOf(p) < 0);
    const tpl = scaffold.roleCard('夹具新项目', 'programmer1', 'full');
    const missingInTpl = phrases.filter((p) => tpl.indexOf(p) < 0);
    check('B1', '从 团队/流程.md 抽出的 §D2 关键句在流程文档里齐全（基线可读）', Boolean(d2) && missingInFlow.length === 0, { missing: missingInFlow, d2Len: d2.length });
    check('B2', '§D2 关键句在角色卡模板里逐句出现（流程↔模板措辞一致）', missingInTpl.length === 0, { missing: missingInTpl });
  }

  /* ── C 升级包覆盖（§D2 传播要求③） ───────────────────────────────── */
  {
    const manifest = require(path.join(ROOT, 'scripts', 'upgrade-package-manifest.cjs'));
    const covered = (rel) => manifest.UPGRADE_FILES.includes(rel)
      || manifest.UPGRADE_TREE.some((t) => rel === t || rel.startsWith(t + '/'));
    const files = ['团队/工具/lib/scaffold.mjs', '团队/工具/lib/rolecard-sync.mjs', '团队/流程.md'];
    check('C1', '升级包清单覆盖本次三处产物（scaffold.mjs / rolecard-sync.mjs / 流程.md）',
      files.every((f) => covered(f)) && !files.some((f) => manifest.isNeverPackaged(f)),
      { upTree: manifest.UPGRADE_TREE.includes('团队/工具'), upFile: manifest.UPGRADE_FILES.includes('团队/流程.md') });
    check('C2', 'PACKAGE_ASSERT_ENTRIES 含 rolecard-sync.mjs 与 流程.md（发布自检会真的查包内条目）',
      manifest.PACKAGE_ASSERT_ENTRIES.includes('团队/工具/lib/rolecard-sync.mjs')
      && manifest.PACKAGE_ASSERT_ENTRIES.includes('团队/流程.md'), { entries: manifest.PACKAGE_ASSERT_ENTRIES });
  }

  /* ── D 老卡同步（沙盘真 CLI） ─────────────────────────────────────── */
  try {
    fs.mkdirSync(PROJECTS, { recursive: true });
    fs.cpSync(path.join(ROOT, '团队', '工具'), path.join(TEAM, '工具'), { recursive: true });
    const init = run(['init']);
    if (init.status !== 0) throw new Error('init 失败：' + init.text);
    const add = run(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--dir', path.join(PROJECTS, PROJECT), '--json']);
    if (add.status !== 0) throw new Error('project add 失败：' + add.text);
    const projDir = path.join(PROJECTS, PROJECT);
    const cardOf = (role) => path.join(projDir, ROLE_DIRS[role], '角色卡.md');

    const newCards = roles.filter((r) => {
      const c = fs.readFileSync(cardOf(r), 'utf8');
      return !c.includes(HEADING)
        || !c.includes('<!-- rolecard-standard:subagent-boundary:begin -->')
        || !c.includes('<!-- rolecard-standard:subagent-boundary:end -->');
    });
    check('D1', '新项目生成：六张角色卡自带该节且 begin/end 成对（新建项目路径生效）', newCards.length === 0, { missing: newCards });

    // B-9bc4 AC②：新建项目的 sync dry-run 对该节必须是 keep（不是把 §H 吞进去、也不是 ~2）
    {
      const dryNew = run(['rolecard', 'sync', '--project', PROJECT, '--role', 'programmer1', '--dry-run', '--json']);
      const row = (dryNew.json && dryNew.json.roles && dryNew.json.roles[0]) || {};
      const chg = (row.changes || []).filter((c) => String(c.section || '').startsWith('subagent-boundary'));
      const conflict = (row.conflicts || []).filter((c) => String(c.section || '').startsWith('subagent-boundary'));
      check('D1b', '新建项目 dry-run：subagent-boundary 只有一条 keep（无 add/conflict/~2）',
        dryNew.status === 0 && chg.length === 1 && chg[0].action === 'keep' && conflict.length === 0
        && !(row.changes || []).some((c) => String(c.section) === 'subagent-boundary~2'),
        { changes: row.changes, conflicts: row.conflicts, text: dryNew.text.slice(0, 240) });
    }

    // 模拟「升级前的旧卡」：删节 + 删标记（真实六卡当前就无标记、无该节）。
    // 注意：角色卡进 rulesHash → 必须先改卡再 boot，否则本角色令牌立刻 RULES_CHANGED（这本身也验证了「改卡只失效本人令牌」）。
    const oldP1 = stripMarker(stripSection(fs.readFileSync(cardOf('programmer1'), 'utf8'), HEADING));
    fs.writeFileSync(cardOf('programmer1'), oldP1, 'utf8');
    fs.writeFileSync(cardOf('product'), stripMarker(stripSection(fs.readFileSync(cardOf('product'), 'utf8'), HEADING)), 'utf8');
    const shaOldP1 = sha(cardOf('programmer1'));
    const bootOf = (role) => {
      const r = run(['boot', '--role', role, '--project', PROJECT, '--session', `session-d2-${role}`, '--json']);
      const t = (r.json && (r.json.token || (r.json.boot && r.json.boot.token))) || '';
      if (!t) throw new Error(`boot ${role} 未拿到令牌：` + r.text);
      return t;
    };
    let tokProg = bootOf('programmer1');
    const tokPm = bootOf('pm');

    const dry = run(['rolecard', 'sync', '--project', PROJECT, '--role', 'programmer1', '--dry-run', '--json']);
    const dryRow = (dry.json && dry.json.roles && dry.json.roles[0]) || {};
    const addChange = (dryRow.changes || []).find((c) => c.section === 'subagent-boundary');
    check('D2', '老卡 dry-run：报 subagent-boundary=add、wrote=false、卡未被改',
      dry.status === 0 && dryRow.wrote === false && Boolean(addChange) && addChange.action === 'add' && sha(cardOf('programmer1')) === shaOldP1,
      { status: dry.status, row: { wrote: dryRow.wrote, changes: (dryRow.changes || []).filter((c) => c.section === 'subagent-boundary') }, text: dry.text.slice(0, 300) });

    const ap1 = run(['rolecard', 'sync', '--project', PROJECT, '--role', 'programmer1', '--apply', '--boot', tokProg, '--json']);
    const ap1Row = (ap1.json && ap1.json.roles && ap1.json.roles[0]) || {};
    const cardNow = fs.readFileSync(cardOf('programmer1'), 'utf8');
    const backupRoot = path.join(projDir, ROLE_DIRS.programmer1, '产出', '证据-rolecard-sync');
    check('D3', 'apply 写入：wrote=true、added 含 subagent-boundary、卡内有标准标记、备份目录存在',
      ap1.status === 0 && ap1Row.wrote === true && (ap1Row.added || []).includes('subagent-boundary')
      && cardNow.includes('<!-- rolecard-standard:subagent-boundary:begin -->')
      && cardNow.includes('<!-- rolecard-standard:subagent-boundary:end -->')
      && fs.existsSync(backupRoot), { row: { wrote: ap1Row.wrote, added: ap1Row.added, message: ap1Row.message }, text: ap1.text.slice(0, 300) });

    // 写卡改了本人角色卡 → 本人令牌立即作废（rulesHash 含角色卡），必须重 boot 才能继续做写操作。
    const staleAfterWrite = run(['rolecard', 'sync', '--project', PROJECT, '--role', 'programmer1', '--apply', '--boot', tokProg, '--json']);
    check('D3b', '写卡后旧令牌失效（RULES_CHANGED）＝「改卡只失效本人令牌」口径成立，需重 boot',
      staleAfterWrite.status !== 0 && /RULES_CHANGED/.test(staleAfterWrite.text), { status: staleAfterWrite.status, text: staleAfterWrite.text.slice(0, 200) });
    tokProg = bootOf('programmer1');

    const shaAfter1 = sha(cardOf('programmer1'));
    const ap2 = run(['rolecard', 'sync', '--project', PROJECT, '--role', 'programmer1', '--apply', '--boot', tokProg, '--json']);
    const ap2Row = (ap2.json && ap2.json.roles && ap2.json.roles[0]) || {};
    check('D4', '二次 apply 幂等：wrote=false（0 差异）、卡 sha 不变', ap2.status === 0 && ap2Row.wrote === false && sha(cardOf('programmer1')) === shaAfter1,
      { row: { wrote: ap2Row.wrote, message: ap2Row.message }, text: ap2.text.slice(0, 300) });

    // PM 代做另一角色（Owner/PM 升级后要能一次给全队同步，逐角色执行）
    const apPm = run(['rolecard', 'sync', '--project', PROJECT, '--role', 'product', '--apply', '--boot', tokPm, '--json']);
    const apPmRow = (apPm.json && apPm.json.roles && apPm.json.roles[0]) || {};
    check('D5', 'PM 令牌可代做其他角色的卡同步（升级后由 PM/Owner 统一推）',
      apPm.status === 0 && apPmRow.wrote === true && (apPmRow.added || []).includes('subagent-boundary')
      && fs.readFileSync(cardOf('product'), 'utf8').includes(HEADING), { row: { wrote: apPmRow.wrote, added: apPmRow.added }, text: apPm.text.slice(0, 300) });

    // 越权异常：programmer1 改 product 卡 → PERMISSION_DENIED（且零写入）
    const shaProdBefore = sha(cardOf('product'));
    const deny = run(['rolecard', 'sync', '--project', PROJECT, '--role', 'product', '--apply', '--boot', tokProg, '--json']);
    check('D6', '越权异常：非本人非 PM 改他人卡 → PERMISSION_DENIED 且零写入',
      deny.status !== 0 && /PERMISSION_DENIED/.test(deny.text) && sha(cardOf('product')) === shaProdBefore, { status: deny.status, text: deny.text.slice(0, 300) });

    // 并发/边界：--apply --all 仍被拒（R-bf05 口径不变；流程文档改按角色逐个）
    const allApply = run(['rolecard', 'sync', '--project', PROJECT, '--all', '--apply', '--boot', tokPm, '--json']);
    check('D7', '边界：--apply --all → BAD_ARGS（R-bf05 口径不变，模板/流程写「按角色逐个执行」）',
      allApply.status !== 0 && /BAD_ARGS/.test(allApply.text), { status: allApply.status, text: allApply.text.slice(0, 240) });

    // 审计：rolecard同步.jsonl 有本次 apply 行，added 含 key
    const auditFile = path.join(TEAM, '状态', '项目', PROJECT, 'rolecard同步.jsonl');
    const auditRows = fs.existsSync(auditFile) ? fs.readFileSync(auditFile, 'utf8').split(/\r?\n/).filter(Boolean).map((l) => { try { return JSON.parse(l); } catch { return null; } }).filter(Boolean) : [];
    check('D8', '审计可追溯：rolecard同步.jsonl 的 apply 行含 added=subagent-boundary 与 byRole',
      auditRows.some((r) => r.action === 'rolecard_sync_apply' && Array.isArray(r.added) && r.added.includes('subagent-boundary') && String(r.byRole || '').length > 0),
      { rows: auditRows.slice(-3) });
  } catch (e) {
    check('D0', '沙盘准备/同步流程未抛错', false, String((e && e.message) || e));
  }

  /* ── E 隔离：真实状态零写入 ──────────────────────────────────────── */
  {
    const shaAfter = { team: sha(realTeam), wb: sha(realWb), cards: Object.fromEntries(Object.entries(realCards).map(([k, v]) => [k, sha(v)])) };
    check('E1', '隔离：真实 团队.json / workbench.json / 六张真实角色卡 sha256 前后不变',
      shaBefore.team === shaAfter.team && shaBefore.wb === shaAfter.wb
      && Object.keys(shaBefore.cards).every((k) => shaBefore.cards[k] === shaAfter.cards[k]),
      { before: shaBefore, after: shaAfter });
  }

  const pass = results.filter((r) => r.ok).length;
  console.log(`\n${pass}/${results.length} PASS`);
  cleanup();
})();
