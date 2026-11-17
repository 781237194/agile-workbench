/**
 * T-20261117-213802-d69d（R-6b61 AC3/AC5/AC6）夹具：共享常量 + 索引只刷新 + 靶词白名单。
 *
 * 断言：
 *   S1 AC3 共享常量：scaffold 导出 IRON_POLICY_LINE/READ_ORDER_LINE；rootReadme/rootIndex 产物都含这两句；
 *   S2 AC3 index 生成器单源：ops 生成 项目索引.md 含两句，且不再出现「每次先读《项目铁律」旧口径；
 *   S3 AC5 刷新：`index --refresh` 刷新后人工段 sha 前后相等、二次执行幂等（去掉时间戳行后全文一致）；
 *   S4 AC6 靶词白名单：scanRuleScope(仓库) findings=0（范围 src/** + 团队/工具/**）；
 *   S5 AC6 白名单能放行：宪法标题/项目信息 §八/「按需」句/历史注释 四类样例判为豁免。
 *
 * 跑法：node scripts/test-6b61-rule-scope.cjs
 */
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const assert = require('node:assert');

const ROOT = (() => {
  let dir = __dirname;
  for (let i = 0; i < 6; i += 1) {
    if (fs.existsSync(path.join(dir, '团队', '工具', 'team.mjs'))) return dir;
    dir = path.dirname(dir);
  }
  throw new Error('找不到仓库根');
})();
const SB = path.join(ROOT, '_tmp', `r6b61c-${process.pid}`);
const SB_TEAM = path.join(SB, '团队');
const SB_PROJECTS = path.join(SB, '项目');
const PROJECT = '沙盘6b61c';
const sha = (s) => crypto.createHash('sha256').update(String(s)).digest('hex');
const results = [];
function check(name, fn) {
  try {
    const detail = fn();
    results.push({ name, ok: true, detail });
    console.log(`PASS  ${name}${detail ? `  ${detail}` : ''}`);
  } catch (e) {
    results.push({ name, ok: false, error: String((e && e.message) || e) });
    console.log(`FAIL  ${name}\n      ${String((e && e.message) || e).split('\n')[0]}`);
  }
}
const env = () => ({ ...process.env, TEAM_ROOT: SB_TEAM, TEAM_PROJECTS_ROOT: SB_PROJECTS, TEAM_SELFTEST: '1' });
function cli(args) {
  try {
    return { ok: true, out: execFileSync(process.execPath, [path.join(SB_TEAM, '工具', 'team.mjs'), ...args], { cwd: ROOT, encoding: 'utf8', timeout: 180000, env: env() }) };
  } catch (e) {
    return { ok: false, out: String(e.stdout || ''), err: String(e.stderr || '') };
  }
}
const read = (p) => fs.readFileSync(p, 'utf8');
const manualOf = (t) => (String(t).match(/<!-- 人工说明:BEGIN -->([\s\S]*?)<!-- 人工说明:END -->/) || [])[1] || '';
// 幂等比较口径：去掉「自动生成时间戳」行与索引自我行（其 size/mtime 会随本次写入变化），其余逐字比较。
const norm = (t) => String(t)
  .split(/\r?\n/)
  .filter((line) => !/自动生成[:：]/.test(line) && !/\[项目索引\.md\]/.test(line))
  .join('\n')
  .replace(/\d{4}-\d{2}-\d{2}T[\d:.]+Z/g, '<ts>');

(async () => {
  const scaf = await import('file:///' + path.join(ROOT, '团队', '工具', 'lib', 'scaffold.mjs').replace(/\\/g, '/'));
  const scope = await import('file:///' + path.join(ROOT, '团队', '工具', 'lib', 'rule-scope.mjs').replace(/\\/g, '/'));
  const IRON = scaf.IRON_POLICY_LINE;
  const READ = scaf.READ_ORDER_LINE;

  check('S1 常量已导出，rootReadme/rootIndex 都含两句', () => {
    assert.ok(IRON && READ, '常量未导出');
    assert.ok(String(IRON).includes('按需'), 'IRON_POLICY_LINE 不含按需');
    assert.ok(String(READ).includes('团队宪法'), 'READ_ORDER_LINE 不含宪法');
    for (const fn of [scaf.rootReadme, scaf.rootIndex]) {
      const out = fn(PROJECT, 'full');
      assert.ok(out.includes(IRON), `${fn.name} 缺 IRON_POLICY_LINE`);
      assert.ok(out.includes(READ), `${fn.name} 缺 READ_ORDER_LINE`);
    }
    return `${IRON} / ${READ}`;
  });

  // 沙盘项目
  fs.rmSync(SB, { recursive: true, force: true });
  fs.mkdirSync(path.join(SB_TEAM, '状态'), { recursive: true });
  fs.mkdirSync(SB_PROJECTS, { recursive: true });
  fs.cpSync(path.join(ROOT, '团队', '工具'), path.join(SB_TEAM, '工具'), { recursive: true });
  for (const f of ['团队宪法.md', '项目铁律.md']) {
    const src = path.join(ROOT, '团队', f);
    if (fs.existsSync(src)) fs.copyFileSync(src, path.join(SB_TEAM, f));
  }
  const team = JSON.parse(read(path.join(ROOT, '团队', '状态', '团队.json')));
  for (const m of team.members || []) { m.sessionId = ''; m.archivedSession = ''; m.replacedBySessionId = ''; m.sessionPrevSessionId = ''; }
  delete team.activeProject;
  fs.writeFileSync(path.join(SB_TEAM, '状态', '团队.json'), JSON.stringify(team, null, 2));
  assert.ok(cli(['project', 'add', '--name', PROJECT, '--team-mode', 'full']).ok, '沙盘 project add 失败');
  const boot = cli(['boot', '--role', 'programmer1', '--project', PROJECT, '--session', 's-6b61c']);
  const token = (String(boot.out).match(/令牌:\s*([0-9a-f]+)/) || [])[1];
  assert.ok(token, `沙盘 boot 失败：${boot.out.slice(0, 200)}${boot.err || ''}`);
  const projDir = path.join(SB_PROJECTS, PROJECT);
  const README = path.join(projDir, 'README.md');
  const IDX = path.join(projDir, '项目索引.md');

  check('S2 index 产物含共享常量、无「每次先读《项目铁律」旧口径', () => {
    assert.ok(fs.existsSync(IDX), '项目索引.md 不存在');
    const before = read(IDX);
    assert.ok(before.includes(IRON), '索引缺 IRON_POLICY_LINE');
    assert.ok(before.includes(READ), '索引缺 READ_ORDER_LINE');
    assert.ok(!/每次先读《项目铁律/.test(before), '索引仍有旧口径');
    const readme = read(README);
    assert.ok(readme.includes(IRON) && readme.includes(READ), 'README 缺共享常量');
    return '索引+README 同源';
  });

  check('S3 AC5 幂等：连跑两次 index --refresh 产物**逐字节相等**，人工段 sha 不变', () => {
    const before = read(IDX);
    const m1 = sha(manualOf(before));
    const r1 = cli(['index', '--role', 'programmer1', '--project', PROJECT, '--boot', token, '--refresh']);
    assert.ok(r1.ok, `refresh 失败：${r1.out}${r1.err || ''}`);
    const t1 = read(IDX);
    assert.strictEqual(sha(manualOf(t1)), m1, '人工段被改动');
    const r2 = cli(['index', '--role', 'programmer1', '--project', PROJECT, '--boot', token, '--refresh']);
    assert.ok(r2.ok, `二次 refresh 失败：${r2.out}${r2.err || ''}`);
    const t2 = read(IDX);
    // AC5 要求「产物内容自稳定」：不再剔除时间戳/自我行，直接逐字节比较。
    assert.strictEqual(t2, t1, '二次刷新产物不逐字节相等（索引仍写入易变内容）');
    return '人工段 sha 稳定 + 逐字节幂等';
  });

  check('S4 AC6 靶词扫描：src/** + 团队/工具/** findings=0', () => {
    const r = scope.scanRuleScope(ROOT);
    assert.deepStrictEqual(r.findings, [], JSON.stringify(r.findings.slice(0, 5)));
    assert.ok(r.scanned > 50, `扫描文件数异常：${r.scanned}`);
    return `${r.scanned} 文件 0 命中`;
  });

  check('S5 白名单四类样例均放行', () => {
    const samples = [
      ['# 团队宪法（每轮必读 · v2）', 'constitution-title'],
      ['## 八、交互方式总表（每次必读）', 'project-info-section8'],
      ['- 项目铁律按需（不必每轮读）', 'positive-optional'],
      ['// 旧流程：六角色目录、每轮必读、阶段闸门', 'historical-comment'],
    ];
    for (const [line, id] of samples) {
      const hit = scope.RULE_WHITELIST.find((w) => w.test(line));
      assert.ok(hit, `样例未命中白名单：${line}`);
      assert.strictEqual(hit.id, id, `样例命中错误白名单：${line} → ${hit.id}`);
    }
    return '4/4 放行';
  });

  fs.rmSync(SB, { recursive: true, force: true });
  const pass = results.filter((r) => r.ok).length;
  console.log(`\nR6B61C_RULE_SCOPE ${JSON.stringify({ total: results.length, pass, red: results.length - pass })}`);
  if (pass !== results.length) process.exit(1);
})().catch((e) => { console.error(e); process.exit(1); });
