// B-20261116-134316-c31c 夹具：仅 CLI boot 应放行（AC2）；真改文档仍拦（AC3）；CLI boot 写 state.boots（AC1）
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const SB = path.join(ROOT, '_tmp', 'c31c-' + Date.now().toString(36));
const TEAM = path.join(SB, '团队');
const PROJECT = '工作台改造修复';
const PROJ_SRC = path.join(ROOT, '项目', PROJECT);
const TEAM_SRC = path.join(ROOT, '团队');
const TEAM_MJS = path.join(TEAM_SRC, '工具', 'team.mjs');

let pass = 0;
const fails = [];
const check = (name, ok, detail) => {
  if (ok) { pass += 1; console.log('PASS  ' + name); }
  else { fails.push({ name, detail }); console.log('FAIL  ' + name + ' · ' + JSON.stringify(detail)); }
};
const run = (args) => {
  try {
    return { code: 0, out: execFileSync(process.execPath, [TEAM_MJS, ...args], { env, encoding: 'utf8', timeout: 120000 }) };
  } catch (e) {
    return { code: e.status === undefined ? -1 : e.status, out: String((e.stdout || '') + (e.stderr || '')) };
  }
};

// 沙箱：团队.json（清 sessionId）+ 宪法/铁律 + tester 角色卡 + 项目状态整份复制
fs.mkdirSync(path.join(TEAM, '状态', '项目'), { recursive: true });
const teamJson = JSON.parse(fs.readFileSync(path.join(TEAM_SRC, '状态', '团队.json'), 'utf8'));
for (const m of (teamJson.members || [])) delete m.sessionId;
fs.writeFileSync(path.join(TEAM, '状态', '团队.json'), JSON.stringify(teamJson, null, 2), 'utf8');
for (const rel of ['团队宪法.md', '项目铁律.md', '测试人员/角色卡.md', '测试人员/文件索引.md']) {
  const from = path.join(TEAM_SRC, rel);
  if (!fs.existsSync(from)) continue;
  const to = path.join(TEAM, rel);
  fs.mkdirSync(path.dirname(to), { recursive: true });
  fs.copyFileSync(from, to);
}
fs.cpSync(path.join(TEAM_SRC, '状态', '项目', PROJECT), path.join(TEAM, '状态', '项目', PROJECT), { recursive: true });
const env = {
  ...process.env, ELECTRON_RUN_AS_NODE: '1', TEAM_ROOT: TEAM,
  // 项目文档根用真实目录：CLI 与壳层必须读到同一批需求正文，否则「本轮相关需求」哈希天然不等
  TEAM_PROJECTS_ROOT: path.join(ROOT, '项目'), TEAM_WORKBENCH_JSON: path.join(SB, 'workbench.json'), TEAM_SELFTEST: '1',
};
const WF = path.join(TEAM, '状态', '项目', PROJECT, '工作流.json');
const READS = path.join(TEAM, '状态', '阅读.jsonl');

// 1) CLI boot：应写 state.boots + 阅读.jsonl docHashes
const boot = run(['boot', '--role', 'tester', '--project', PROJECT, '--session', 'session-c31c-e2e']);
check('1 CLI boot 成功', boot.code === 0 && /令牌/.test(boot.out), { code: boot.code, tail: String(boot.out).slice(-200) });
const wf = JSON.parse(fs.readFileSync(WF, 'utf8'));
const bt = wf.boots && wf.boots.tester;
check('AC1 CLI boot 写 state.boots：docs 四件齐 + complete + round + at + rulesHash',
  Boolean(bt) && bt.complete === true && ['constitution', 'iron', 'projectInfo', 'roleCard'].every((k) => bt.docs && bt.docs[k] && bt.docs[k].hash)
  && Number(bt.round) >= 1 && Boolean(bt.at) && typeof bt.rulesHash === 'string',
  { keys: bt && Object.keys(bt.docs || {}), complete: bt && bt.complete, round: bt && bt.round });
const receipt = fs.readFileSync(READS, 'utf8').trim().split(/\r?\n/).map((l) => { try { return JSON.parse(l); } catch { return null; } })
  .filter((r) => r && r.kind === 'boot' && r.role === 'tester').pop();
check('AC1 阅读.jsonl boot 行带 docHashes（供 AC2 回退）',
  Boolean(receipt && receipt.docHashes && receipt.docHashes.constitution && receipt.docHashes.constitution.hash),
  { keys: receipt && Object.keys(receipt.docHashes || {}) });

// 2) AC2：删掉 state.boots（模拟纯 CLI boot 的旧账），门应通过（回退 阅读.jsonl）
const wf2 = JSON.parse(fs.readFileSync(WF, 'utf8'));
delete wf2.boots;
fs.writeFileSync(WF, JSON.stringify(wf2, null, 2), 'utf8');
const probe = (role) => {
  const js = `const tools = require(${JSON.stringify(path.join(ROOT, 'src', 'team-tools.js'))});const r = tools.requireWorkflowBoot(${JSON.stringify(PROJECT)}, ${JSON.stringify(PROJ_SRC)}, ${JSON.stringify(role)}, {});process.stdout.write(JSON.stringify({ ok: !!r.ok, code: r.code || '', stale: r.stale || null, message: String(r.message || '').slice(0, 160) }));`;
  try {
    const out = execFileSync(process.execPath, ['-e', js], { env, encoding: 'utf8', timeout: 120000 });
    return JSON.parse(out.trim());
  } catch (e) {
    return { ok: false, code: 'SPAWN_FAILED', why: String((e.stdout || '') + (e.stderr || '')).slice(-300) };
  }
};
const fallback = probe('tester');
check('AC2 state.boots 缺失时回退 阅读.jsonl 放行（不再永久 RULES_CHANGED）',
  fallback.ok === true, fallback);

// 3) 5887：换轮（round 1→2）且仅 CLI boot（记录 round=1）→ 必须拦 BOOT_REQUIRED
const wf3 = JSON.parse(fs.readFileSync(WF, 'utf8'));
wf3.round = 2;
delete wf3.boots;
fs.writeFileSync(WF, JSON.stringify(wf3, null, 2), 'utf8');
const roundBlocked = probe('tester');
check('5887 换轮未重 boot → BOOT_REQUIRED（回退不伪造轮次）',
  roundBlocked.ok === false && String(roundBlocked.code).includes('BOOT_REQUIRED'), roundBlocked);

// 3b) 5887：CLI 记录缺 round → 也必须拦（缺失即拒）
const readsRaw = fs.readFileSync(READS, 'utf8');
const lines = readsRaw.trim().split(/\r?\n/);
lines[lines.length - 1] = JSON.stringify(Object.fromEntries(Object.entries(JSON.parse(lines[lines.length - 1])).filter(([k]) => k !== 'round')));
fs.writeFileSync(READS, lines.join('\n') + '\n', 'utf8');
const missingRound = probe('tester');
check('5887 CLI 记录缺 round → BOOT_REQUIRED（缺失即拒，不假定当前轮）',
  missingRound.ok === false && String(missingRound.code).includes('BOOT_REQUIRED'), missingRound);

// 4) 同轮恢复（重新 boot 拿到带 round 的新记录）+ 真改文档 → 仍拦（RULES_CHANGED）
const wf4 = JSON.parse(fs.readFileSync(WF, 'utf8'));
wf4.round = 1;
delete wf4.boots;
fs.writeFileSync(WF, JSON.stringify(wf4, null, 2), 'utf8');
const bootAgain = run(['boot', '--role', 'tester', '--project', PROJECT, '--session', 'session-c31c-e2e2']);
check('4 重新 boot（带 round 的新记录）成功', bootAgain.code === 0, { code: bootAgain.code, tail: String(bootAgain.out).slice(-160) });
const wf5 = JSON.parse(fs.readFileSync(WF, 'utf8'));
delete wf5.boots; // 只走回退路径
fs.writeFileSync(WF, JSON.stringify(wf5, null, 2), 'utf8');
const okAfterReboot = probe('tester');
check('4b 同轮 + 仅 CLI boot → 放行', okAfterReboot.ok === true, okAfterReboot);
const constitution = path.join(TEAM, '团队宪法.md');
fs.appendFileSync(constitution, '\n<!-- 5887 fixture: 文档真变了 -->\n', 'utf8');
const blocked = probe('tester');
check('AC3 真改文档仍拦（RULES_CHANGED）',
  blocked.ok === false && String(blocked.code).includes('RULES_CHANGED'), blocked);

fs.rmSync(SB, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log('\nc31c 断言：' + pass + '/' + (pass + fails.length) + ' PASS');
if (fails.length) { console.log(JSON.stringify(fails, null, 2)); process.exit(1); }
