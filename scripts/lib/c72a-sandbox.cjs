/* R-c72a 批2 · 共享沙盘播种器（AWB_DATA_DIR + TEAM_ROOT 双隔离）。
 * 被 fixture-pool-1200.cjs / fixture-two-projects.cjs / ui-budget-scroll.cjs 共用，避免三份播种逻辑漂移。
 * 安全：只写 <base> 下的文件；绝不动真实 data/userdata/workbench.json 与 团队/状态。
 */
'use strict';
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..');
const REAL_STORE = path.join(ROOT, 'data', 'userdata', 'workbench.json');
const REAL_TEAM = path.join(ROOT, '团队');

function rmrf(p) { fs.rmSync(p, { recursive: true, force: true }); }
function mkdirp(p) { fs.mkdirSync(p, { recursive: true }); }
function writeJson(p, v) { mkdirp(path.dirname(p)); fs.writeFileSync(p, JSON.stringify(v, null, 2) + '\n', 'utf8'); }
function readJson(p, fallback) {
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

/** teamSlug 与 src/team-tools.js 同口径（工作流状态目录名）。 */
function teamSlug(value, max = 60) {
  const cleaned = String(value == null ? '' : value).replace(/[^\w\u4e00-\u9fa5.-]+/g, '_').replace(/^_+|_+$/g, '');
  const base = cleaned || 'x';
  if (base.length <= max) return base;
  return base.slice(0, max - 9) + '-' + require('node:crypto').createHash('sha256').update(base).digest('hex').slice(0, 8);
}

/** 生成 rows 条需求行（requirements 是对象 map，键=完整需求 id）。 */
function makeRequirements(rows, opts = {}) {
  const prefix = String((opts && opts.prefix) || 'R-20261116-120000');
  const status = String((opts && opts.status) || 'approved');
  const nowIso = new Date().toISOString();
  const map = {};
  for (let i = 1; i <= rows; i += 1) {
    const seq = String(i).padStart(4, '0');
    const id = `${prefix}-${seq}`;
    map[id] = {
      id,
      title: `夹具需求 ${seq}（c72a 批2 · 池虚拟化）`,
      status,
      ownerReview: { status },
      createdAt: nowIso,
      fixture: true,
    };
  }
  return map;
}

/**
 * 播种沙盘。
 * @param {{base:string, projects:[{id:string,name:string,rows:number,status?:string}]}} spec
 */
function seedSandbox(spec) {
  const base = path.resolve(spec.base);
  const data = path.join(base, 'data');
  const team = path.join(base, '团队');
  rmrf(base);
  mkdirp(path.join(data, 'userdata'));

  const store = readJson(REAL_STORE, null);
  if (!store || !Array.isArray(store.projects)) throw new Error('真实 workbench.json 不可读');
  const real = store.projects.find((p) => p && (p.teamName === '工作台改造修复' || p.name === '工作台改造修复'));
  if (!real) throw new Error('真实 workbench.json 里没有团队项目 工作台改造修复');

  const projects = (spec.projects || []).map((p) => {
    const slug = teamSlug(p.name);
    const stateDir = path.join(team, '状态', '项目', slug);
    mkdirp(stateDir);
    writeJson(path.join(stateDir, '工作流.json'), {
      schema: 2,
      project: p.name,
      round: 1,
      phase: 'dev',
      updatedAt: new Date().toISOString(),
      requirements: makeRequirements(p.rows || 0, { status: p.status }),
    });
    writeJson(path.join(stateDir, '项目.json'), {
      name: p.name, teamMode: 'full', fixture: true, createdAt: new Date().toISOString(),
    });
    const projDir = path.join(base, 'projects', p.id);
    mkdirp(projDir);
    return {
      ...real,
      id: p.id,
      name: p.name,
      teamName: p.name,
      path: projDir,
      fixture: true,
      _rows: p.rows,
    };
  });

  store.projects = projects;
  store.activeProjectId = projects[0] ? projects[0].id : store.activeProjectId;
  writeJson(path.join(data, 'userdata', 'workbench.json'), store);

  mkdirp(path.join(team, '状态'));
  const teamFile = path.join(team, '状态', '团队.json');
  const teamCfg = readJson(teamFile, null) || readJson(path.join(REAL_TEAM, '状态', '团队.json'), null);
  if (!teamCfg) throw new Error('团队.json 不可读');
  for (const m of teamCfg.members || []) m.sessionId = '';
  teamCfg.activeProject = projects[0] ? projects[0].name : '';
  writeJson(teamFile, teamCfg);

  return {
    base,
    data,
    team,
    store,
    projects: projects.map((p) => ({ id: p.id, name: p.name, rows: p._rows, slug: teamSlug(p.name) })),
  };
}

/** 沙盘启动环境（双隔离 + 禁唤醒 + DSH_HOME 隔离）。 */
function sandboxEnv(seed) {
  return {
    ...process.env,
    AWB_DATA_DIR: seed.data,
    TEAM_ROOT: seed.team,
    TEAM_PROJECTS_ROOT: path.join(seed.team, '状态', '项目'),
    TEAM_WORKBENCH_JSON: path.join(seed.data, 'userdata', 'workbench.json'),
    TEAM_SELFTEST: '1',
    // 30d8：c72a 系 UI 测试会拉起内嵌 DSH 并切项目；不隔离 DSH_HOME 会把沙盘目录
    // 注册进真实 ~/.dsh/storages/workspace.json（本次 4 个死工作区的根因）。
    // 显式指到沙盘内，与 run-electron.cjs 的集中兜底形成双保险。
    DSH_HOME: path.join(seed.base, 'dsh-home'),
  };
}

module.exports = { ROOT, REAL_STORE, REAL_TEAM, seedSandbox, sandboxEnv, makeRequirements, teamSlug, readJson, writeJson, rmrf, mkdirp };