'use strict';
/**
 * 夹具：R-e438 批② 邮箱 JSONL（六类：首次迁移/正常追加/空值边界/越权/并发重复/降级恢复）
 *
 * 覆盖：
 *  M1 首次迁移：旧 new/cur 文件 → messages.jsonl（按 at 排序、seq 1..N），旧目录移入 _legacy；二次迁移幂等。
 *  A1 正常追加 + 尾读：append 后 seq 递增；readTail(limit/afterSeq) 只回末 N 条。
 *  E1 空值边界：limit 0 收敛为 1、缺失角色 hitLegacyFallback、afterSeq 超水位、空目录 archive/migrate 不炸。
 *  X1 越权：TEAM_MAIL_ENFORCE=1 时非 pm/owner 令牌 → PERMISSION_DENIED；pm 令牌通过。
 *  C1 并发：两进程各追加 30 条 → 60 个唯一 id、无坏行；并发迁移 → 唯一 id 数正确。
 *  D1 降级：坏行计入 badLines 但好行仍可读；删 jsonl → hitLegacyFallback=true（旧目录兼容期）。
 *  Z1 冷归档：>7 天按 at 月归档到 归档/<YYYY-MM>/，热文件保留近期，index.archivedMonths 更新、审计落盘。
 *
 * 隔离：mkdtemp 沙盘 + TEAM_ROOT/TEAM_PROJECTS_ROOT/TEAM_WORKBENCH_JSON/AWB_DATA_DIR + TEAM_SELFTEST=1。
 * 跑法：node scripts/test-e438-mail-jsonl.cjs
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync, spawn } = require('node:child_process');
const { pathToFileURL } = require('node:url');

const ROOT = path.resolve(__dirname, '..');
const TOOL = path.join(ROOT, '团队', '工具', 'team.mjs');
const MAIL_STORE = path.join(ROOT, '团队', '工具', 'lib', 'mail-store.mjs');
const PROJECT = 'mail-沙盘';
const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'awb-mail-'));
const TEAM = path.join(SB, '团队');
const MAIL = path.join(TEAM, '状态', '邮箱');
const RESULT = [];
function check(id, title, ok, detail) {
  RESULT.push({ id, ok: Boolean(ok) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${id} ${title}${ok ? '' : '  ← ' + String(JSON.stringify(detail === undefined ? '' : detail)).slice(0, 420)}`);
  if (!ok) process.exitCode = 1;
}
const env = () => ({ ...process.env, TEAM_ROOT: TEAM, TEAM_PROJECTS_ROOT: path.join(SB, '项目'), TEAM_WORKBENCH_JSON: path.join(SB, 'workbench.json'), AWB_DATA_DIR: path.join(SB, 'data'), TEAM_SELFTEST: '1' });
function cli(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [TOOL, ...args], { encoding: 'utf8', env: { ...env(), ...extraEnv }, cwd: SB, timeout: 120000, maxBuffer: 32 * 1024 * 1024 });
  let json = null; try { json = JSON.parse(String(r.stdout || '')); } catch { json = null; }
  return { status: r.status, json, out: String(r.stdout || ''), err: String(r.stderr || '') };
}
function legacyFiles(role, box, n, startAt) {
  const dir = path.join(MAIL, role, box);
  fs.mkdirSync(dir, { recursive: true });
  const t0 = Date.parse(startAt);
  for (let i = 0; i < n; i += 1) {
    const at = new Date(t0 + i * 60000).toISOString();
    const msg = { id: `M-legacy-${role}-${box}-${i}`, from: 'pm', to: role, subject: `旧消息 ${box} ${i}`, body: 'legacy', project: PROJECT, task: '', ackRequired: false, type: 'note', ts: at, deliveredAt: at };
    fs.writeFileSync(path.join(dir, `${i}-M-legacy-${role}-${box}-${i}.json`), JSON.stringify(msg, null, 1), 'utf8');
  }
}

let ms = null;

async function main() {
  ms = await import(pathToFileURL(MAIL_STORE).href);

  /* ── M1 首次迁移 ─────────────────────────────────────── */
  legacyFiles('programmer1', 'new', 2, '2026-11-01T00:00:00Z');
  legacyFiles('programmer1', 'cur', 1, '2026-11-02T00:00:00Z');
  const m1 = cli(['mail', 'migrate', '--role', 'programmer1', '--yes']);
  const jsonl = path.join(MAIL, 'programmer1', 'messages.jsonl');
  const idx = ms.readIndex(ms.pathsFor(MAIL, 'programmer1'));
  const m1rows = ms.readAll(MAIL, 'programmer1').rows;
  const m1flags = {
    status: m1.status,
    jsonl: fs.existsSync(jsonl),
    seq: [idx.seqMin, idx.seqMax],
    rows: m1rows.length,
    atJoin: m1rows.map((r) => r.at).join(','),
    legacyDir: fs.existsSync(path.join(MAIL, '_legacy', 'programmer1')),
    legacyNewGone: !fs.existsSync(path.join(MAIL, 'programmer1', 'new')),
    legacyCurGone: !fs.existsSync(path.join(MAIL, 'programmer1', 'cur')),
  };
  check('M1', '首次迁移：3 个旧文件 → jsonl，seq 1..3 且按 at 排序，旧目录移入 _legacy',
    m1flags.status === 0 && m1flags.jsonl && m1flags.seq[0] === 1 && m1flags.seq[1] === 3
    && m1flags.rows === 3 && m1flags.atJoin.includes('2026-11-01') && m1flags.atJoin.includes('2026-11-02')
    && m1flags.legacyDir && m1flags.legacyNewGone && m1flags.legacyCurGone, m1flags);
  const m2 = cli(['mail', 'migrate', '--role', 'programmer1', '--yes']);
  check('M2', '二次迁移幂等：扫描 0 条、不重复导入', m2.status === 0 && /扫描 0/.test(m2.out), { out: m2.out.slice(0, 200) });

  /* ── A1 追加 + 尾读 ──────────────────────────────────── */
  ms.appendMessage(MAIL, 'programmer1', { id: 'M-new-1', from: 'pm', to: 'programmer1', subject: 'a', body: 'b', at: '2026-11-20T05:00:00Z', project: PROJECT });
  ms.appendMessage(MAIL, 'programmer1', { id: 'M-new-2', from: 'pm', to: 'programmer1', subject: 'a2', body: 'b2', at: '2026-11-20T05:01:00Z', project: PROJECT });
  const tail = ms.readTail(MAIL, 'programmer1', { limit: 2 });
  check('A1', '追加 seq 递增 + readTail(limit=2) 只回末 2 条（new-2、new-1）',
    tail.rows.length === 2 && tail.rows.map((r) => r.id).join(',') === 'M-new-1,M-new-2' && tail.badLines === 0
    && ms.readIndex(ms.pathsFor(MAIL, 'programmer1')).seqMax === 5, { ids: tail.rows.map((r) => r.id) });

  /* ── E1 空值边界 ─────────────────────────────────────── */
  const empty = ms.readTail(MAIL, 'nobody', { limit: 5 });
  const zero = ms.readTail(MAIL, 'programmer1', { limit: 0 });
  const high = ms.readTail(MAIL, 'programmer1', { afterSeq: 9999 });
  const noOld = ms.archiveCold(MAIL, 'nobody', { dryRun: false });
  const migEmpty = ms.migrateRole(MAIL, 'nobody', { dryRun: true });
  check('E1', '空值边界：缺失角色回退旧目录、limit 0 收敛为 1、afterSeq 超水位为 0、空角色归档/迁移不炸',
    empty.hitLegacyFallback === true && empty.rows.length === 0
    && zero.rows.length === 1 && high.rows.length === 0
    && noOld.archived === 0 && noOld.kept === 0 && migEmpty.scanned === 0, { empty, zeroLen: zero.rows.length, high: high.rows.length });

  /* ── X1 越权（TEAM_MAIL_ENFORCE=1 + 沙盘 boot 令牌） ──── */
  {
    cli(['init', '--json']);
    cli(['project', 'add', '--name', PROJECT, '--team-mode', 'full', '--json']);
    const p1 = cli(['boot', '--role', 'programmer1', '--project', PROJECT, '--json']);
    const pm = cli(['boot', '--role', 'pm', '--project', PROJECT, '--json']);
    const p1Tok = (p1.json && p1.json.token) || '';
    const pmTok = (pm.json && pm.json.token) || '';
    const denied = cli(['mail', 'migrate', '--role', 'programmer1', '--yes', '--boot', p1Tok], { TEAM_MAIL_ENFORCE: '1' });
    const allowed = cli(['mail', 'archive', '--role', 'programmer1', '--boot', pmTok], { TEAM_MAIL_ENFORCE: '1' });
    check('X1', '越权：programmer1 令牌 migrate → PERMISSION_DENIED；pm 令牌 archive → 通过',
      p1Tok && pmTok && denied.status !== 0 && /PERMISSION_DENIED/.test(denied.out + denied.err)
      && allowed.status === 0, { p1Tok: Boolean(p1Tok), pmTok: Boolean(pmTok), denied: (denied.out + denied.err).slice(0, 200) });
  }

  /* ── C1 并发追加 ─────────────────────────────────────── */
  {
    const child = [
      "const { pathToFileURL } = require('node:url');",
      '(async () => {',
      `  const ms = await import(${JSON.stringify(pathToFileURL(MAIL_STORE).href)});`,
      '  const role = process.argv[1];',
      '  for (let i = 0; i < 30; i += 1) {',
      '    ms.appendMessage(process.env.MAIL_ROOT, role, { id: `M-con-${role}-${process.pid}-${i}`, from: "pm", to: role, subject: "c", body: "x", at: new Date().toISOString(), project: "mail-沙盘" });',
      '  }',
      '})().catch((e) => { console.error(e); process.exit(1); });',
    ].join('\n');
    const runChild = () => new Promise((resolve) => {
      const p = spawn(process.execPath, ['-e', child, 'programmer2'], { env: { ...env(), MAIL_ROOT: MAIL }, cwd: SB });
      let err = ''; p.stderr.on('data', (d) => { err += d; });
      p.on('close', (code) => resolve({ code, err }));
    });
    Promise.all([runChild(), runChild()]).then(([r1, r2]) => {
      const all = ms.readAll(MAIL, 'programmer2');
      const ids = new Set(all.rows.map((r) => r.id));
      check('C1', '并发追加：两进程 60 条全部落盘且 id 唯一、无坏行（seq 允许重复但不拆行）',
        r1.code === 0 && r2.code === 0 && ids.size === 60 && all.badLines === 0, { code: [r1.code, r2.code], unique: ids.size, bad: all.badLines });
      const cp1 = spawnSync(process.execPath, [TOOL, 'mail', 'migrate', '--role', 'programmer2', '--yes'], { encoding: 'utf8', env: env(), cwd: SB });
      const cp2 = spawnSync(process.execPath, [TOOL, 'mail', 'migrate', '--role', 'programmer2', '--yes'], { encoding: 'utf8', env: env(), cwd: SB });
      check('C2', '并发/重复迁移：唯一 id 数不变（60），两次命令均成功',
        cp1.status === 0 && cp2.status === 0 && new Set(ms.readAll(MAIL, 'programmer2').rows.map((r) => r.id)).size === 60, {});
      finalPart();
    });
  }
}

function finalPart() {
  /* ── D1 降级恢复 ─────────────────────────────────────── */
  {
    fs.appendFileSync(path.join(MAIL, 'programmer1', 'messages.jsonl'), '{bad json line\n', 'utf8');
    const bad = ms.readTail(MAIL, 'programmer1', { limit: 2 });
    const all = ms.readAll(MAIL, 'programmer1');
    fs.renameSync(path.join(MAIL, 'programmer1', 'messages.jsonl'), path.join(MAIL, 'programmer1', 'messages.jsonl.bak'));
    const fallback = ms.readTail(MAIL, 'programmer1', { limit: 2 });
    fs.renameSync(path.join(MAIL, 'programmer1', 'messages.jsonl.bak'), path.join(MAIL, 'programmer1', 'messages.jsonl'));
    check('D1', '降级：坏行计入 badLines 但好行仍可读；删 jsonl → hitLegacyFallback=true（兼容期回退旧目录）',
      bad.rows.length >= 1 && bad.badLines >= 1 && all.badLines >= 1 && fallback.hitLegacyFallback === true, { bad: bad.badLines, allBad: all.badLines, fallback: fallback.hitLegacyFallback });
  }

  /* ── Z1 冷归档 ───────────────────────────────────────── */
  {
    ms.appendMessage(MAIL, 'programmer1', { id: 'M-old-202609', from: 'pm', to: 'programmer1', subject: '老消息', body: 'x', at: '2026-09-01T00:00:00Z', project: PROJECT });
    const dry = ms.archiveCold(MAIL, 'programmer1', { dryRun: true });
    const real = ms.archiveCold(MAIL, 'programmer1', { dryRun: false });
    const p = ms.pathsFor(MAIL, 'programmer1');
    const hot = ms.readTail(MAIL, 'programmer1', { limit: 1000 }).rows;
    check('Z1', '冷归档：dry-run 只报数；--yes 后 >7 天消息落 归档/<月>/<role>/，热文件不含老消息，index.archivedMonths 更新并留审计',
      dry.archived >= 1 && fs.existsSync(path.join(MAIL, '归档', '2026-09', 'programmer1', 'messages.jsonl'))
      && !hot.some((r) => r.id === 'M-old-202609')
      && ms.readIndex(p).archivedMonths.includes('2026-09')
      && fs.existsSync(path.join(MAIL, '邮箱归档.jsonl')), { dry: dry.archived, real: real.archived, hot: hot.length, months: ms.readIndex(p).archivedMonths });
  }

  const pass = RESULT.filter((r) => r.ok).length;
  console.log(`\n${pass}/${RESULT.length} PASS`);
  if (pass !== RESULT.length) process.exitCode = 1;
  try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
}

main().catch((e) => { check('E0', '夹具未抛异常', false, { error: String((e && e.stack) || e) }); try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ } });
