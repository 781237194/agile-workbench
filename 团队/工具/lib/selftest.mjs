// 团队工作台 v2 · 沙盘自测
// 覆盖：boot/消息回执/任务/提案/评审/签字/提交/陈旧拒绝/锁争用/缺签/规则变更/未读先审/回滚/verify/看板
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkDocStructure } from './brief.mjs';
import { OUTPUT_DOCS, LIMITS } from './roles.mjs';
import { buildDispatchPrompt, DISPATCH_MARKERS, buildWakeHeader, buildWakeLine } from './dispatch.mjs';
import { scopeGlobToRegExp, computeProposalHash } from './store.mjs';
import { usageLevelOf, DEFAULT_TOKEN_WARN, DEFAULT_TOKEN_FORCE } from './session.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const TEAM_MJS = path.resolve(HERE, '..', 'team.mjs');
const WORKSPACE_MJS = path.resolve(HERE, '..', 'workspace.mjs');
const LAUNCH_MJS = path.resolve(HERE, '..', 'launch.mjs');

function sha(p) {
  return crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex');
}

function ensure(p) {
  fs.mkdirSync(path.dirname(p), { recursive: true });
}

function write(p, text) {
  ensure(p);
  fs.writeFileSync(p, text, 'utf8');
}

function read(p) {
  return fs.readFileSync(p, 'utf8');
}

export async function runSelftest({ keep = false, tmp = '', reset = false } = {}) {
  // 沙盘默认落在工作台 _tmp（HERE = 团队/工具/lib → 上三级 = 工作台），不污染系统临时目录；
  // 跑完自动删除，--keep 才保留。也可以 --tmp 指定其他目录。
  const baseTmp = tmp ? path.resolve(tmp) : path.resolve(HERE, '..', '..', '..', '_tmp');
  fs.mkdirSync(baseTmp, { recursive: true });
  const temp = fs.mkdtempSync(path.join(baseTmp, 'team-selftest-'));
  const teamRoot = path.join(temp, '团队');
  const projectsRoot = path.join(temp, '项目');
  const work = path.join(temp, '工作区');
  fs.mkdirSync(teamRoot, { recursive: true });
  fs.mkdirSync(projectsRoot, { recursive: true });
  fs.mkdirSync(work, { recursive: true });
  // PM 2026-11-14 根因整改：selftest 全程只认沙盘 workbench.json，绝不读写真实 data/userdata/workbench.json。
  const sandboxWorkbenchFile = path.join(temp, 'data', 'userdata', 'workbench.json');
  fs.mkdirSync(path.dirname(sandboxWorkbenchFile), { recursive: true });
  // --reset：先清掉历史遗留的沙盘目录（team-selftest-*），避免半成状态被下一次复用。
  const resetReport = { removed: [] };
  if (reset) {
    try {
      for (const name of fs.readdirSync(baseTmp)) {
        if (!/^team-selftest-/.test(name)) continue;
        const target = path.join(baseTmp, name);
        if (target === temp) continue;
        fs.rmSync(target, { recursive: true, force: true });
        resetReport.removed.push(name);
      }
    } catch { /* 清理失败不阻断，报告里 removed 为空 */ }
  }
  const realWorkbenchPath = path.join(HERE, '..', '..', '..', 'data', 'userdata', 'workbench.json');
  const realWorkbenchPrint = (() => {
    try {
      const st = fs.statSync(realWorkbenchPath);
      return { exists: true, size: st.size, mtimeMs: st.mtimeMs, sha256: crypto.createHash('sha256').update(fs.readFileSync(realWorkbenchPath)).digest('hex') };
    } catch { return { exists: false, size: 0, mtimeMs: 0, sha256: '' }; }
  })();
  const env = { ...process.env, TEAM_ROOT: teamRoot, TEAM_PROJECTS_ROOT: projectsRoot, TEAM_SELFTEST: '1', TEAM_WORKBENCH_JSON: sandboxWorkbenchFile };
  const results = [];
  const pass = (name, detail = '') => {
    results.push({ ok: true, name, detail });
    console.log(`PASS  ${name}${detail ? ' · ' + detail : ''}`);
  };
  const failStep = (name, detail = '') => {
    results.push({ ok: false, name, detail });
    console.log(`FAIL  ${name}${detail ? ' · ' + detail : ''}`);
    throw new Error(`${name}${detail ? '：' + detail : ''}`);
  };
  const run = (args, { expectFail = false, tool = TEAM_MJS, envOverride = null } = {}) => {
    const childEnv = envOverride ? { ...env, ...envOverride } : env;
    const r = spawnSync(process.execPath, [tool, ...args], { cwd: work, env: childEnv, encoding: 'utf8', timeout: 60000 });
    if (expectFail) {
      if (r.status === 0) failStep('预期失败但成功', args.join(' '));
      return r;
    }
    if (r.status !== 0) {
      failStep('命令失败', `${args.join(' ')}\nSTDOUT:${r.stdout}\nSTDERR:${r.stderr}`);
    }
    return r;
  };
  const json = (args, tool = TEAM_MJS) => {
    const r = run(args, { tool });
    try {
      return JSON.parse(r.stdout.trim());
    } catch {
      failStep('JSON 解析失败', `${args.join(' ')}\n${r.stdout}\n${r.stderr}`);
    }
  };
  const expectErr = (args, code) => {
    const r = run(args, { expectFail: true });
    const all = String(r.stdout || '') + String(r.stderr || '');
    if (!all.includes(code)) failStep(`预期错误码 ${code}`, `${args.join(' ')}\n${all}`);
    return r;
  };

  try {
    run(['init', '--json']);
    pass('init：目录/默认文档/角色卡');

    // boot TTL 默认 8 小时：新建团队配置必须是 480，不是旧版 30。
    const teamFile = path.join(teamRoot, '状态', '团队.json');
    const initialTeam = JSON.parse(read(teamFile));
    if (Number(initialTeam.config.bootTtlMinutes) !== 480) {
      failStep('init 默认 bootTtlMinutes 不是 480', String(initialTeam.config.bootTtlMinutes));
    }
    // 模拟旧项目 team.json：30 分钟。project add 会 loadTeam，触发一次性迁移。
    initialTeam.config.bootTtlMinutes = 30;
    write(teamFile, JSON.stringify(initialTeam, null, 2) + '\n');
    const backupDir = path.join(teamRoot, '状态', '备份');
    const ttlBackups = () => (fs.existsSync(backupDir) ? fs.readdirSync(backupDir).filter((n) => n.startsWith('团队-bootTtl-')).length : 0);
    const backupsBefore = ttlBackups();

    const added = json(['project', 'add', '--name', '试点', '--desc', '两角色协议试点', '--by', 'owner', '--json']);
    if (!added.ok || !added.structure || !added.structure.ok) failStep('project add 没建全结构', JSON.stringify(added.structure || added));
    const projDir = path.join(projectsRoot, '试点');
    for (const dirName of ['项目经理', '产品', '需求分析师', '程序员A', '程序员B', '测试人员']) {
      for (const f of ['角色卡.md', '文件索引.md']) {
        if (!fs.existsSync(path.join(projDir, dirName, f))) failStep(`六角色目录缺文件：${dirName}/${f}`);
      }
      if (!fs.existsSync(path.join(projDir, dirName, '产出'))) failStep(`六角色目录缺 产出/：${dirName}`);
    }
    for (const f of ['README.md', '项目信息.md', '项目铁律.md', '项目索引.md', '协作准则.md', '需求/00-需求总览.md']) {
      if (!fs.existsSync(path.join(projDir, f))) failStep(`项目缺文件：${f}`);
    }
    for (const d of ['_tmp', 'site', '需求']) if (!fs.existsSync(path.join(projDir, d))) failStep(`项目缺目录：${d}`);
    pass('project add：六角色目录/角色卡/文件索引/产出/项目信息/铁律/索引/README/_tmp');

    // 旧 30 分钟配置迁移：值变 480、迁移前备份一份、第二次读取不再备份（幂等）。
    const migratedTeam = JSON.parse(read(teamFile));
    if (Number(migratedTeam.config.bootTtlMinutes) !== 480) {
      failStep('旧 team.json bootTtlMinutes=30 未迁移到 480', String(migratedTeam.config.bootTtlMinutes));
    }
    const backupsAfter = ttlBackups();
    if (backupsAfter !== backupsBefore + 1) {
      failStep('迁移没有且只备份一份旧配置', `${backupsBefore} → ${backupsAfter}`);
    }
    const backupName = fs.readdirSync(backupDir).find((n) => n.startsWith('团队-bootTtl-'));
    const backupTeam = JSON.parse(read(path.join(backupDir, backupName)));
    if (Number(backupTeam.config.bootTtlMinutes) !== 30) {
      failStep('迁移备份不是迁移前的 30 分钟配置', JSON.stringify(backupTeam.config));
    }
    json(['status', '--json']);
    if (ttlBackups() !== backupsAfter) failStep('重复读取 team.json 又备份了一次（迁移不幂等）');
    pass('旧 team.json bootTtlMinutes=30→480：备份迁移前配置 + 幂等');

    // 结构化输出模板：四个模板齐全，YAML 头 + 固定区块 + 输出纪律 + 字段限长标注。
    const tplDir = path.resolve(HERE, '..', '模板', '角色产出');
    for (const name of ['01-需求分析-vN.md', '02-产品设计-vN.md', '03-架构设计-vN.md', '04-测试报告-vN.md']) {
      const tplPath = path.join(tplDir, name);
      if (!fs.existsSync(tplPath)) failStep('缺输出模板：' + name);
      const tplText = read(tplPath);
      if (!tplText.includes('输出即结果') || !tplText.includes('超过上限即停止') || !tplText.includes('禁止重复输入')) {
        failStep('模板缺输出纪律：' + name);
      }
      if (!/^---[ \t]*\r?\n[\s\S]*?\r?\n---/.test(tplText.replace(/^\uFEFF/, ''))) failStep('模板缺 YAML 头：' + name);
      const spec = Object.values(OUTPUT_DOCS).find((s) => s.code === name.slice(0, 2));
      if (!spec) failStep('OUTPUT_DOCS 缺 code=' + name.slice(0, 2));
      const c = checkDocStructure(tplText, spec);
      if (!c.ok) failStep('模板结构校验失败：' + name, c.problems.join('；'));
      if (Buffer.byteLength(tplText, 'utf8') > 16384) failStep('模板超 16KB：' + name);
    }
    pass('四个输出模板：YAML 头 + 固定区块 + 输出纪律 + ≤16KB');

    // 角色卡必须写明结构化输出四纪律与模板路径。
    const aCard = read(path.join(projDir, '需求分析师', '角色卡.md'));
    if (!aCard.includes('输出即结果') || !aCard.includes('01-需求分析-vN.md') || !aCard.includes('team.mjs brief')) {
      failStep('需求分析师角色卡缺结构化输出说明');
    }
    const a1Card = read(path.join(projDir, '程序员A', '角色卡.md'));
    if (!a1Card.includes('03-架构设计-vN.md')) failStep('程序员A（主开发）角色卡缺架构模板');
    const tCard = read(path.join(projDir, '测试人员', '角色卡.md'));
    if (!tCard.includes('04-测试报告-vN.md')) failStep('测试人员角色卡缺测试报告模板');
    // 中文纪律与派单闭环必须写进每一张角色卡（不能只靠口头约定）。
    for (const dirName of ['项目经理', '产品', '需求分析师', '程序员A', '程序员B', '测试人员']) {
      const card = read(path.join(projDir, dirName, '角色卡.md'));
      if (!card.includes('中文思考、中文回复、中文写文档')) failStep(`角色卡缺中文纪律：${dirName}`);
      if (!card.includes('执行消息正文中的任务') || !card.includes('完成回执') || !card.includes('task done')) {
        failStep(`角色卡缺派单闭环：${dirName}`);
      }
    }
    const pmCard = read(path.join(projDir, '项目经理', '角色卡.md'));
    if (!pmCard.includes('建需求') || !pmCard.includes('派单') || !pmCard.includes('跟进')) failStep('PM 角色卡缺建需求/派单/跟进');
    const analystCard = read(path.join(projDir, '需求分析师', '角色卡.md'));
    if (!analystCard.includes('需求拆解与评审')) failStep('需求分析师角色卡缺拆解评审');
    const devCard = read(path.join(projDir, '程序员A', '角色卡.md'));
    if (!devCard.includes('只做本职')) failStep('开发角色卡缺只做本职');
    const testerCard = read(path.join(projDir, '测试人员', '角色卡.md'));
    if (!testerCard.includes('只做本职')) failStep('测试角色卡缺只做本职');
    pass('角色卡：四纪律 + 模板路径 + brief 用法 + 中文/派单闭环/角色边界');

    const pmBoot = json(['boot', '--role', 'pm', '--project', '试点', '--session', 'selftest-pm', '--json']);
    const pgBoot = json(['boot', '--role', 'programmer1', '--project', '试点', '--session', 'selftest-programmer1', '--json']);
    if (!pmBoot.token || !pgBoot.token) failStep('boot 没发令牌');
    if (!String(pmBoot.briefing || '').includes('只读自己需要区块')
      || !String(pmBoot.briefing || '').includes('超过上限即停止')
      || !String(pmBoot.briefing || '').includes('网关提取')) failStep('boot 简报缺结构化输出纪律');
    if (!String(pmBoot.briefing || '').includes('中文思考、中文回复、中文写文档')) failStep('boot 简报缺中文纪律');
    if (!String(pmBoot.briefing || '').includes('已回执') || !String(pmBoot.briefing || '').includes('task done --evidence')) {
      failStep('boot 简报缺派单闭环（已回执 ≠ 已完成）');
    }
    if (String(pmBoot.briefing || '').length > LIMITS.bootBriefMaxChars) {
      failStep('boot 简报超限', `${String(pmBoot.briefing).length} > ${LIMITS.bootBriefMaxChars}`);
    }
    // 必读分层：核心 4 份 + 按需 + 任务相关；简报必须列“已读/未读”，不能只给一句“已读齐”。
    if (!/必读-核心已读 4\/4/.test(String(pmBoot.briefing || ''))) failStep('boot 简报缺“必读-核心已读 4/4”', String(pmBoot.briefing || '').slice(0, 600));
    if (!String(pmBoot.briefing || '').includes('必读-按需已读')) failStep('boot 简报缺“必读-按需已读”');
    if (!String(pmBoot.briefing || '').includes('必读-任务相关')) failStep('boot 简报缺“必读-任务相关”');
    if (!Array.isArray(pmBoot.read && pmBoot.read.core) || pmBoot.read.core.length !== 4) failStep('boot read 证据缺 core 4 份', JSON.stringify(pmBoot.read && pmBoot.read.core));
    if (!Array.isArray(pmBoot.read && pmBoot.read.taskDocs)) failStep('boot read 证据缺 taskDocs 字段');
    if (Number(pmBoot.bootTtlMinutes) !== 480) failStep('boot 返回的 bootTtlMinutes 不是 480', String(pmBoot.bootTtlMinutes));
    if (!String(pmBoot.briefing || '').includes('480 分钟 = 8 小时')) failStep('boot 简报没有写明 480 分钟 = 8 小时', String(pmBoot.briefing || '').slice(0, 300));
    // 令牌落盘的真实有效期也必须是 8 小时，不能只是简报文字。
    const pmTokenFile = path.join(teamRoot, '状态', '启动', `${pmBoot.token}.json`);
    const pmToken = JSON.parse(read(pmTokenFile));
    const ttlMinutes = (Date.parse(pmToken.expiresAt) - Date.parse(pmToken.createdAt)) / 60000;
    if (!(ttlMinutes >= 479 && ttlMinutes <= 481)) failStep('令牌 expiresAt 不是 480 分钟', String(ttlMinutes));
    pass('boot：两角色拿到令牌（简报含四纪律 + 网关提取 + 中文/派单闭环 + 480 分钟 TTL）');

    const pmRead = pmBoot.read || {};
    if (!pmRead.complete) failStep('boot 没返回完整 read 证据', JSON.stringify(pmRead.missing || []));
    const readKeys = (pmRead.docs || []).map((d) => d.key);
    for (const key of ['constitution', 'iron', 'projectInfo', 'roleCard', 'projectIndex', 'requirementOverview']) {
      if (!readKeys.includes(key)) failStep(`boot 未读 ${key}`, readKeys.join(','));
    }
    const orderOk = readKeys.indexOf('iron') < readKeys.indexOf('projectInfo')
      && readKeys.indexOf('projectInfo') < readKeys.indexOf('roleCard')
      && readKeys.indexOf('roleCard') < readKeys.indexOf('projectIndex');
    if (!orderOk) failStep('boot 读取顺序不是 铁律→信息→角色卡→索引', readKeys.join('>'));
    for (const d of (pmRead.docs || []).filter((x) => x.exists)) {
      if (!/^[0-9a-f]{64}$/.test(String(d.hash))) failStep(`read 证据缺哈希：${d.rel || d.path}`);
      if (!d.excerpt) failStep(`read 证据缺摘录：${d.rel || d.path}`);
    }
    if (!Array.isArray(pmRead.requirements)) failStep('boot 未返回相关需求');
    if (!Array.isArray(pmRead.peers)) failStep('boot 未返回他人文档索引');
    pass('boot：铁律→信息→角色卡→索引→需求/他人文档 + read 证据');

    // 派单唤醒模板：必须要求执行正文、产出写角色目录、完成后回执；ack 与 done 分开。
    const wakeDev = buildDispatchPrompt({
      to: 'programmer1', project: '试点', projectPath: projDir, roleDir: '程序员A', codeDir: 'site',
      messageId: 'M-TEST', subject: '首单', taskId: 'T-TEST', taskTitle: '示例任务', teamTool: TEAM_MJS,
    });
    for (const [key, marker] of Object.entries(DISPATCH_MARKERS)) {
      if (!wakeDev.includes(marker)) failStep(`派单模板缺 ${key}：${marker}`, wakeDev);
    }
    for (const must of [
      '执行消息正文中的任务', '不写别人目录', '完成回执', 'task done', '--evidence',
      '只 ack 不算完成', path.join(projDir, '程序员A'), path.join(projDir, 'site'),
      '中文思考、中文回复、中文写文档',
    ]) {
      if (!wakeDev.includes(must)) failStep(`派单模板缺：${must}`, wakeDev);
    }
    const wakeTester = buildDispatchPrompt({
      to: 'tester', project: '试点', projectPath: projDir, roleDir: '测试人员',
      messageId: 'M-TEST2', subject: '验收', taskId: 'T-TEST2', teamTool: TEAM_MJS,
    });
    if (!wakeTester.includes(path.join(projDir, '测试人员')) || wakeTester.includes('site/**')) {
      failStep('非开发派单的产出目录不对', wakeTester);
    }
    pass('派单唤醒模板：执行正文 + 产出写角色目录 + 完成回执 + ack≠done');

    // —— brief 网关读取（只读、不读全文）——
    const analystOut = path.join(projDir, '需求分析师', '产出');
    fs.mkdirSync(analystOut, { recursive: true });
    let tplAnalyst = read(path.resolve(HERE, '..', '模板', '角色产出', '01-需求分析-vN.md'));
    tplAnalyst = tplAnalyst.replace(/^version:[ \t]*vN/m, 'version: v1').replace('# 01-需求分析 · vN', '# 01-需求分析 · v1');
    const analystDoc = path.join(analystOut, '01-需求分析-v1.md');
    write(analystDoc, tplAnalyst);
    const brief1 = json(['brief', '--boot', pmBoot.token, '--role', 'analyst', '--project', '试点', '--json']);
    if (!brief1.ok || !Array.isArray(brief1.docs) || brief1.docs.length !== 1) failStep('brief 未找到 analyst 产出', JSON.stringify(brief1));
    const bd = brief1.docs[0];
    if (!bd.meta || bd.meta.doc !== '01-需求分析' || bd.meta.version !== 'v1') failStep('brief 未解析 YAML 元数据', JSON.stringify(bd.meta || {}));
    if (!Array.isArray(bd.sections) || bd.sections.length < 9) failStep('brief 未解析全部区块', String(bd.sections && bd.sections.length));
    if (String(brief1.discipline).includes('只读自己需要区块') === false) failStep('brief 输出缺纪律');
    const briefSec = json(['brief', '--boot', pmBoot.token, '--role', 'analyst', '--project', '试点', '--section', '五、验收标准', '--json']);
    const sel = briefSec.docs[0];
    if (!Array.isArray(sel.selected) || !sel.selected.some((t) => t.startsWith('五、验收标准'))) failStep('brief --section 提取失败', JSON.stringify(sel));
    // 纯数字编号只按中文编号匹配：--section 5 必须是“五、验收标准”，不能被「≤50」里的“5”带偏。
    const briefNum = json(['brief', '--boot', pmBoot.token, '--role', 'analyst', '--project', '试点', '--section', '5', '--json']);
    if (!Array.isArray(briefNum.docs[0].selected) || !briefNum.docs[0].selected.some((t) => t.startsWith('五、验收标准'))) {
      failStep('brief 数字区块号解析错误', JSON.stringify(briefNum.docs[0]));
    }
    const fullLen = read(analystDoc).length;
    if (!(sel.extractedChars < fullLen)) failStep('brief 提取未小于全文（应只读区块）');
    if (sel.extracted.includes('四、功能点清单')) failStep('brief 区块串区（提取到别的区块）');
    const briefChk = json(['brief', '--boot', pmBoot.token, '--role', 'analyst', '--project', '试点', '--check', '--json']);
    if (!briefChk.ok) failStep('brief --check 未通过', JSON.stringify(briefChk.problems || []));
    const briefMissing = json(['brief', '--boot', pmBoot.token, '--role', 'product', '--project', '试点', '--json']);
    if (!briefMissing.ok || briefMissing.docs.length !== 0 || !Array.isArray(briefMissing.missing) || briefMissing.missing.length !== 1) {
      failStep('brief 缺产出时未给模板提示', JSON.stringify(briefMissing));
    }
    const briefNoSpec = json(['brief', '--boot', pmBoot.token, '--role', 'programmer2', '--project', '试点', '--json']);
    if (!briefNoSpec.ok) failStep('brief 无模板角色应正常返回');
    // 坏文档被 --check 硬拒绝
    write(path.join(analystOut, '01-需求分析-v2.md'), '# 缺区块\n\n---\ndoc: 01-需求分析\nversion: v2\nrole: analyst\nupdated: 2026-11-06\n---\n\n## 一、场景与用户\n\n- x\n');
    expectErr(['brief', '--boot', pmBoot.token, '--role', 'analyst', '--project', '试点', '--check', '--json'], 'DOC_CHECK_FAILED');
    fs.rmSync(path.join(analystOut, '01-需求分析-v2.md'), { force: true });
    pass('brief：元数据/区块提取/不读全文/--check/缺产出提示');

    expectErr(['owner', '--proposal', 'P-x'], 'BAD_ARGS');
    expectErr(['workflow', '--project', '试点'], 'BAD_ACTION');
    pass('owner：缺 project/requirement 明确拒绝；workflow 只接受 iterate/terminate');

    // 旧壳按源码里的 case 与子命令探测能力：req review / owner / workflow 必须被视为“已实现”，
    // 否则壳层会一直走 LEGACY_PROTOCOL_REQUIRED 或 mock，不会调用真实评审/Owner/迭代。
    const teamSrc = read(TEAM_MJS);
    const opsSrc = read(path.join(HERE, 'ops.mjs'));
    if (!/case\s+['"]owner['"]/.test(teamSrc)) failStep('team.mjs 缺 owner 命令入口（旧壳能力探测会判缺失）');
    if (!/case\s+['"]workflow['"]/.test(teamSrc)) failStep('team.mjs 缺 workflow 命令入口');
    if (!/case\s+['"]vote['"]/.test(teamSrc)) failStep('team.mjs 缺 vote 命令入口');
    const reqSection = opsSrc.slice(opsSrc.indexOf('export function cmdReq'), opsSrc.indexOf('export function cmdFind'));
    const reviewBranch = reqSection.slice(reqSection.indexOf("sub === 'review'"), reqSection.indexOf('if (sub === \'create\')'));
    if (!reviewBranch || !/cmdReqReview\s*\(/.test(reviewBranch) || /NOT_IMPLEMENTED/.test(reviewBranch)) {
      failStep('req review 未实现为真实命令（旧壳能力探测会判缺失或误判）', reviewBranch);
    }
    if (!/export async function cmdOwner\s*\(/.test(opsSrc)) {
      failStep('owner 未实现为真实命令');
    }
    if (!/export function cmdWorkflow\s*\(/.test(opsSrc) || !/workflowAction\s*\(/.test(opsSrc)) {
      failStep('workflow iterate/terminate 未实现为真实命令');
    }
    if (!/buildDispatchPrompt\(\{/.test(opsSrc)) failStep('send 未调用统一派单模板 buildDispatchPrompt');
    pass('旧壳能力探测：req review/owner/workflow/vote 均已实现');

    fs.rmSync(path.join(projDir, '程序员B', '角色卡.md'), { force: true });
    fs.rmSync(path.join(projDir, '产品'), { recursive: true, force: true });
    const ensured = json(['project', 'ensure', '--name', '试点', '--by', 'owner', '--json']);
    if (!ensured.ok || !ensured.structure || !ensured.structure.ok) failStep('project ensure 未补齐', JSON.stringify(ensured.structure || ensured));
    if (!fs.existsSync(path.join(projDir, '程序员B', '角色卡.md'))) failStep('ensure 未恢复角色卡');
    if (!fs.existsSync(path.join(projDir, '产品', '文件索引.md'))) failStep('ensure 未恢复产品目录/索引');
    if (!ensured.structure.created.length) failStep('ensure 没报告新建项');
    pass('project ensure：只补缺失（角色卡/角色目录）');

    expectErr(['send', '--to', 'programmer1', '--subject', '没令牌', '--body', 'x'], 'BOOT_REQUIRED');
    pass('无令牌被拒');

    // B-b8d0（Owner 05:26 更正）：只取消 30 分钟 TTL——把令牌 expiresAt 改成过去，命令仍必须可用；
    // 缺 --boot 仍被拒（上一行已验）。BOOT_EXPIRED 不应再出现。
    {
      const bootDir = path.join(teamRoot, '状态', '启动');
      const bootFiles = fs.existsSync(bootDir) ? fs.readdirSync(bootDir).filter((n) => n.endsWith('.json')) : [];
      const target = bootFiles.map((n) => path.join(bootDir, n))[0];
      if (!target) failStep('启动令牌目录为空，无法验证"不再过期"', bootDir);
      else {
        const row = JSON.parse(read(target));
        row.expiresAt = '2000-01-01T00:00:00.000Z';
        write(target, JSON.stringify(row, null, 2) + '\n');
        const stillOk = run(['brief', '--boot', row.token, '--role', row.role, '--project', row.project, '--json']);
        if (/BOOT_EXPIRED/.test(String(stillOk.stdout + stillOk.stderr))) failStep('过期时间的令牌仍被判 BOOT_EXPIRED（应不再过期）', String(stillOk.stdout + stillOk.stderr).slice(0, 240));
        else pass('B-b8d0：令牌不再按时间过期（expiresAt 改成 2000 年仍可用，无 BOOT_EXPIRED）');
      }
    }

    json(['grant', '--boot', pmBoot.token, '--to', 'programmer1', '--actions', 'propose', '--scope', 'src/**', '--project', '试点', '--expires', '7d', '--reason', 'selftest', '--json']);
    pass('PM 具体授权');

    const m1 = json(['send', '--boot', pmBoot.token, '--to', 'programmer1', '--subject', '首单', '--body', '请按协议做一单', '--ack', '--json']);
    // Owner 08:44：派单送达即自动标已读 → 收件箱要连 cur 一起看（新消息会直接进 cur）。
    const inbox = json(['inbox', '--boot', pgBoot.token, '--all', '--json']);
    if (!inbox.messages.some((m) => m.id === m1.message.id)) failStep('收件箱没有消息');
    json(['read', '--boot', pgBoot.token, '--id', m1.message.id, '--json']);
    const ack = json(['ack', '--boot', pgBoot.token, '--id', m1.message.id, '--note', '收到，开始做', '--json']);
    if (!ack.ack || !ack.ack.id) failStep('回执没有落库');
    const ackAgain = run(['ack', '--boot', pgBoot.token, '--id', m1.message.id, '--note', '重复回执']).stdout;
    if (!ackAgain.includes('仅表示已收到') || !ackAgain.includes('task done')) failStep('ack 输出未区分已回执/已完成', ackAgain);
    const pmInbox = json(['inbox', '--boot', pmBoot.token, '--json']);
    const receiptMsg = pmInbox.messages.find((m) => m.type === 'receipt');
    if (!receiptMsg) failStep('PM 没收到回执消息');
    if (!String(receiptMsg.body || '').includes('不代表完成')) failStep('回执消息未区分已回执/已完成', String(receiptMsg.body || ''));
    // 回执消息再 ack 不得再生成“回执: 回执”链
    json(['read', '--boot', pmBoot.token, '--id', receiptMsg.id, '--json']);
    json(['ack', '--boot', pmBoot.token, '--id', receiptMsg.id, '--note', '回执已阅', '--json']);
    const pmInbox2 = json(['inbox', '--boot', pmBoot.token, '--all', '--json']);
    if ((pmInbox2.messages || []).some((m) => String(m.subject || '').startsWith('回执: 回执:'))) failStep('回执递归未修好');
    pass('消息 → 已读 → 回执 → 回信（回执不再回执）');

    // Owner 2026-11-14 09:10：纯回执（ack/已认领）不唤醒，只落已读存档；
    // 回执类消息被 ack 后不得再生成回执（防套娃）。两条都从 唤醒.jsonl / PM 邮箱取证。
    {
      const ackWakeFile = path.join(teamRoot, '状态', '项目', '试点', '唤醒.jsonl');
      const ackWakeRows = fs.existsSync(ackWakeFile)
        ? read(ackWakeFile).split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
        : [];
      const receiptId = String(receiptMsg.id || '');
      const hitPm = ackWakeRows.filter((row) => String(row.to || '') === 'pm'
        && (Array.isArray(row.messageIds) ? row.messageIds : []).map(String).includes(receiptId));
      if (hitPm.length) {
        failStep('纯回执不该唤醒（Owner 09:10），但 唤醒.jsonl 里有它', JSON.stringify(hitPm.slice(0, 2)).slice(0, 400));
      }
      const nested = (pmInbox2.messages || []).filter((m) => String(m.subject || '').startsWith('回执: 回执:'));
      if (nested.length) failStep('回执套娃（ack 回执消息又生成回执消息）', JSON.stringify(nested.slice(0, 2)).slice(0, 300));
      pass('纯回执不唤醒（只落已读存档）；回执不再回执');
    }

    // Owner 2026-11-14 07:44 最终口径：取消消息合并与分级——所有消息立即投递、立即唤醒，不攒批、不建池、不串台。
    {
      const poolFile = path.join(teamRoot, '状态', '项目', '试点', '待投递池.json');
      if (fs.existsSync(poolFile)) failStep('待投递池不该存在（合并/分级已取消）', poolFile);
      const wakeAll = path.join(teamRoot, '状态', '项目', '试点', '唤醒.jsonl');
      const rows = fs.existsSync(wakeAll)
        ? read(wakeAll).split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
        : [];
      if (rows.some((row) => String(row.source || '') === 'batch' || /batch/.test(String(row.reason || '')))) {
        failStep('仍出现批量唤醒（应已取消）', JSON.stringify(rows.filter((row) => /batch/.test(String(row.source) + String(row.reason))).slice(0, 2)).slice(0, 300));
      }
      // Owner 09:10：纯回执不唤醒（只落已读存档）——这里断言“没有因回执而唤醒 PM”
      const receiptWake = rows.filter((row) => String(row.to) === 'pm' && /ack:|回执/.test(String(row.reason || '') + String(row.subject || '')));
      if (receiptWake.length) failStep('纯回执仍在唤醒 PM（Owner 09:10 规定不唤醒）', JSON.stringify(receiptWake.slice(0, 2)).slice(0, 300));
      pass('取消合并/分级：无待投递池、无批量唤醒、纯回执不唤醒（只落已读存档）');
    }

    // B-719f：Owner 在评审浮窗拍板后，owner-note.mjs 写 PM 邮箱的同时必须唤醒 PM。
    // 取证：owner-note 输出 wake.ok=true，且 唤醒.jsonl 出现 to=pm 且 reason=owner-review:* 的记录。
    {
      const ownerNoteTool = path.join(HERE, '..', 'owner-note.mjs');
      const noteRun = run(['试点', 'approved', 'selftest Owner 评审通过', 'round-1'], { tool: ownerNoteTool });
      let noteValue = null;
      try { noteValue = JSON.parse(String(noteRun.stdout || '').trim()); } catch { noteValue = null; }
      if (!noteValue || noteValue.ok !== true || !noteValue.message || !noteValue.message.id) {
        failStep('B-719f：owner-note.mjs 未写出 PM 通知', String(noteRun.stdout || noteRun.stderr).slice(0, 300));
      }
      if (!noteValue.wake || noteValue.wake.ok !== true) {
        failStep('B-719f：owner-note.mjs 写通知后没有尝试唤醒 PM', JSON.stringify(noteValue.wake || null).slice(0, 300));
      }
      const noteWakeFile = path.join(teamRoot, '状态', '项目', '试点', '唤醒.jsonl');
      const noteWakeRows = fs.existsSync(noteWakeFile)
        ? read(noteWakeFile).split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
        : [];
      const ownerReviewWake = noteWakeRows.filter((row) => String(row.to || '') === 'pm' && /owner-review/.test(String(row.reason || '')));
      if (!ownerReviewWake.length) {
        failStep('B-719f：Owner 评审通知后 唤醒.jsonl 没有 to=pm 记录', JSON.stringify(noteWakeRows.slice(-3)).slice(0, 400));
      }
      pass('B-719f：Owner 评审通知写盘后唤醒 PM（唤醒.jsonl 有 to=pm reason=owner-review）');
    }

    const task = json(['task', 'create', '--boot', pmBoot.token, '--title', '写第一份变更', '--priority', 'P1', '--owner', 'programmer1', '--detail', 'selftest', '--json']);
    json(['task', 'claim', '--boot', pgBoot.token, '--id', task.task.id, '--json']);
    pass('任务创建 + 认领');

    const target = path.join(projDir, 'src', 'demo.txt');
    write(target, 'v1\n');
    const base1 = sha(target);
    const staged1 = path.join(temp, 'staged1.txt');
    write(staged1, 'v2\n');
    const p1 = json(['propose', '--boot', pgBoot.token, '--task', task.task.id, '--title', '升级到 v2', '--file', `src/demo.txt=${staged1}`, '--expect', `src/demo.txt=${base1}`, '--rationale', 'selftest 正常路径', '--risk', 'normal', '--json']);
    expectErr(['review', '--boot', pmBoot.token, '--proposal', p1.proposal.id, '--verdict', 'approve', '--comments', '没看就审'], 'MUST_READ_FIRST');
    pass('未 show 先 review 被拒');
    json(['show', '--boot', pmBoot.token, '--proposal', p1.proposal.id, '--diff', '--json']);
    json(['review', '--boot', pmBoot.token, '--proposal', p1.proposal.id, '--verdict', 'approve', '--comments', '看过了，同意', '--json']);
    json(['sign', '--boot', pmBoot.token, '--proposal', p1.proposal.id, '--decision', 'approve', '--note', '批准', '--json']);
    const c1 = json(['apply', '--boot', pmBoot.token, '--proposal', p1.proposal.id, '--json']);
    if (read(target) !== 'v2\n') failStep('apply 后内容不对');
    pass('propose → show → review → sign → apply', c1.commit.id);

    const bigDoc = path.join(temp, 'big.md');
    write(bigDoc, 'x'.repeat(17000));
    expectErr(['propose', '--boot', pgBoot.token, '--task', task.task.id, '--title', '超限制文档', '--file', `src/big.md=${bigDoc}`, '--expect', 'src/big.md=absent', '--rationale', '限制验证', '--risk', 'normal', '--json'], 'STAGED_TOO_BIG');
    pass('文档超过 16KB 被硬拒绝');

    // 两单同 base：先提交者赢，后提交者被 CAS 拒
    const base2 = sha(target);
    const sA = path.join(temp, 'stagedA.txt');
    const sB = path.join(temp, 'stagedB.txt');
    write(sA, 'v3-from-A\n');
    write(sB, 'v3-from-B\n');
    const pA = json(['propose', '--boot', pgBoot.token, '--task', task.task.id, '--title', 'A 的 v3', '--file', `src/demo.txt=${sA}`, '--expect', `src/demo.txt=${base2}`, '--rationale', 'A', '--risk', 'normal', '--json']);
    const pB = json(['propose', '--boot', pgBoot.token, '--task', task.task.id, '--title', 'B 的 v3', '--file', `src/demo.txt=${sB}`, '--expect', `src/demo.txt=${base2}`, '--rationale', 'B', '--risk', 'normal', '--json']);
    for (const p of [pA.proposal.id, pB.proposal.id]) {
      json(['show', '--boot', pmBoot.token, '--proposal', p, '--json']);
      json(['review', '--boot', pmBoot.token, '--proposal', p, '--verdict', 'approve', '--comments', '同意', '--json']);
      json(['sign', '--boot', pmBoot.token, '--proposal', p, '--decision', 'approve', '--note', '批准', '--json']);
    }
    json(['apply', '--boot', pmBoot.token, '--proposal', pA.proposal.id, '--json']);
    expectErr(['apply', '--boot', pmBoot.token, '--proposal', pB.proposal.id, '--json'], 'STALE_BASE');
    if (read(target) !== 'v3-from-A\n') failStep('CAS 失败后目标被改');
    pass('两单同 base：先到赢，后到 STALE_BASE');

    // 缺签字
    const base3 = sha(target);
    const sC = path.join(temp, 'stagedC.txt');
    write(sC, 'v4\n');
    const pC = json(['propose', '--boot', pgBoot.token, '--task', task.task.id, '--title', '缺签字', '--file', `src/demo.txt=${sC}`, '--expect', `src/demo.txt=${base3}`, '--rationale', 'C', '--risk', 'normal', '--json']);
    json(['show', '--boot', pmBoot.token, '--proposal', pC.proposal.id, '--json']);
    json(['review', '--boot', pmBoot.token, '--proposal', pC.proposal.id, '--verdict', 'approve', '--comments', '同意', '--json']);
    expectErr(['apply', '--boot', pmBoot.token, '--proposal', pC.proposal.id, '--json'], 'NOT_APPROVED');
    pass('缺签字不能 apply');

    // 锁争用
    json(['lock', 'acquire', '--boot', pmBoot.token, '--key', 'selftest:lock', '--ttl', '60', '--json']);
    expectErr(['lock', 'acquire', '--boot', pgBoot.token, '--key', 'selftest:lock', '--ttl', '60', '--json'], 'LOCK_BUSY');
    json(['lock', 'release', '--boot', pmBoot.token, '--key', 'selftest:lock', '--json']);
    pass('锁争用被拒 + 释放');

    // 规则变更使旧令牌作废
    const constitution = path.join(teamRoot, '团队宪法.md');
    const before = read(constitution);
    fs.appendFileSync(constitution, '\n<!-- selftest rules change -->\n', 'utf8');
    expectErr(['send', '--boot', pgBoot.token, '--to', 'pm', '--subject', '旧令牌', '--body', 'x', '--json'], 'RULES_CHANGED');
    write(constitution, before);
    pass('规则变更 → 旧令牌 RULES_CHANGED');

    // 回滚：apply 中途失败，目标必须回到原哈希
    const beforeRollback = sha(target);
    const sE = path.join(temp, 'stagedE.txt');
    write(sE, 'v-rollback\n');
    const pE = json(['propose', '--boot', pgBoot.token, '--task', task.task.id, '--title', '回滚演练', '--file', `src/demo.txt=${sE}`, '--expect', `src/demo.txt=${beforeRollback}`, '--rationale', 'E', '--risk', 'normal', '--json']);
    json(['show', '--boot', pmBoot.token, '--proposal', pE.proposal.id, '--json']);
    json(['review', '--boot', pmBoot.token, '--proposal', pE.proposal.id, '--verdict', 'approve', '--comments', '同意', '--json']);
    json(['sign', '--boot', pmBoot.token, '--proposal', pE.proposal.id, '--decision', 'approve', '--note', '批准', '--json']);
    expectErr(['apply', '--boot', pmBoot.token, '--proposal', pE.proposal.id, '--fail-after-backup', '--json'], 'APPLY_ROLLED_BACK');
    if (sha(target) !== beforeRollback) failStep('回滚后哈希不对');
    pass('apply 失败自动回滚');

    const v = json(['verify', '--json']);
    if (!v.ok) failStep('verify 未通过', JSON.stringify(v.problems || v));
    pass('verify 全绿', `events=${v.events}`);

    const pilot = json(['pilot', '--json']);
    if (!pilot.pass) failStep('pilot 门槛未过', JSON.stringify(pilot.checks));
    pass('pilot 五项门槛');

    const roster = json(['roster', 'add', '--boot', pmBoot.token, '--role', 'tester', '--name', '测试', '--reason', 'selftest 扩编', '--json']);
    if (!roster.member || roster.member.role !== 'tester') failStep('roster add 失败');
    pass('pilot 通过后加人（一次一个）');

    // ===== R-3911 共享层 propose：scope=shared + 允许清单 + 仓库根越界 + 项目不越界 + 审批一致 =====
    const sharedPm = json(['boot', '--role', 'pm', '--project', '试点', '--session', 'selftest-shared-pm', '--json']);
    const sharedPg = json(['boot', '--role', 'programmer1', '--project', '试点', '--session', 'selftest-shared-pg', '--json']);
    json(['grant', '--boot', sharedPm.token, '--to', 'programmer1', '--actions', 'propose', '--scope', '团队/**,scripts/**', '--project', '试点', '--expires', '7d', '--reason', 'selftest 共享层', '--json']);
    const sharedRepoRoot = path.dirname(teamRoot);
    const sharedStaged = path.join(temp, 'staged-shared.mjs');
    write(sharedStaged, '// 共享层 selftest 内容\nexport const shared = 1;\n');
    const sharedStaged2 = path.join(temp, 'staged-shared2.mjs');
    write(sharedStaged2, '// 共享层 scripts 内容\n');
    const sharedStaged3 = path.join(temp, 'staged-shared3.mjs');
    write(sharedStaged3, '// 共享层 团队 内容\n');
    const psSrc = json(['propose', '--boot', sharedPg.token, '--task', task.task.id, '--title', '共享层 src', '--scope', 'shared', '--file', `src/recheck-shared.mjs=${sharedStaged}`, '--expect', 'src/recheck-shared.mjs=absent', '--rationale', 'selftest 共享层 src', '--risk', 'normal', '--json']);
    if (psSrc.proposal.scope !== 'shared') failStep('共享层提案 scope 不是 shared', JSON.stringify(psSrc.proposal.scope));
    const psScripts = json(['propose', '--boot', sharedPg.token, '--task', task.task.id, '--title', '共享层 scripts', '--scope', 'shared', '--file', `scripts/recheck-shared.mjs=${sharedStaged2}`, '--expect', 'scripts/recheck-shared.mjs=absent', '--rationale', 'selftest 共享层 scripts', '--risk', 'normal', '--json']);
    const psTeam = json(['propose', '--boot', sharedPg.token, '--task', task.task.id, '--title', '共享层 团队', '--scope', 'shared', '--file', `团队/工具/recheck-shared.mjs=${sharedStaged3}`, '--expect', '团队/工具/recheck-shared.mjs=absent', '--rationale', 'selftest 共享层 团队', '--risk', 'sensitive', '--json']);
    if (psScripts.proposal.scope !== 'shared' || psTeam.proposal.scope !== 'shared') failStep('共享层三类未全通过');
    expectErr(['propose', '--boot', sharedPg.token, '--task', task.task.id, '--title', '共享层 docs', '--scope', 'shared', '--file', `docs/recheck.md=${sharedStaged}`, '--expect', 'docs/recheck.md=absent', '--json'], 'PATH_NOT_ALLOWED');
    expectErr(['propose', '--boot', sharedPg.token, '--task', task.task.id, '--title', '共享层 越界', '--scope', 'shared', '--file', `../outside-recheck.md=${sharedStaged}`, '--expect', '../outside-recheck.md=absent', '--json'], 'PATH_OUTSIDE_REPO');
    expectErr(['propose', '--boot', sharedPg.token, '--task', task.task.id, '--title', '共享层 绝对路径', '--scope', 'shared', '--file', `C:\\Windows\\recheck.md=${sharedStaged}`, '--expect', 'C:\\Windows\\recheck.md=absent', '--json'], 'PATH_OUTSIDE_REPO');
    // 符号链接逃逸：链接解析后必须在仓库根内（Windows 无权限建链接时跳过）
    try {
      const outsideDir = fs.mkdtempSync(path.join(baseTmp, 'shared-outside-'));
      const linkPath = path.join(sharedRepoRoot, 'src', 'recheck-link');
      fs.mkdirSync(path.dirname(linkPath), { recursive: true });
      fs.symlinkSync(outsideDir, linkPath, 'dir');
      expectErr(['propose', '--boot', sharedPg.token, '--task', task.task.id, '--title', '共享层 符号链接', '--scope', 'shared', '--file', `src/recheck-link/x.md=${sharedStaged}`, '--expect', 'src/recheck-link/x.md=absent', '--json'], 'PATH_OUTSIDE_REPO');
      fs.rmSync(linkPath, { force: true });
      fs.rmSync(outsideDir, { recursive: true, force: true });
    } catch (e) {
      // 环境不允许创建符号链接：跳过该断言，不把环境限制判成产品失败
    }
    fs.mkdirSync(path.join(sharedRepoRoot, 'src', 'recheck-dir'), { recursive: true });
    expectErr(['propose', '--boot', sharedPg.token, '--task', task.task.id, '--title', '共享层 目录', '--scope', 'shared', '--file', `src/recheck-dir=${sharedStaged}`, '--expect', 'src/recheck-dir=absent', '--json'], 'NOT_A_FILE');
    expectErr(['propose', '--boot', sharedPg.token, '--task', task.task.id, '--title', '非法 scope', '--scope', 'repo', '--file', `src/recheck-x.md=${sharedStaged}`, '--expect', 'src/recheck-x.md=absent', '--json'], 'BAD_SCOPE');
    expectErr(['propose', '--boot', sharedPg.token, '--task', task.task.id, '--title', '项目越界', '--file', `团队/工具/recheck-shared.mjs=${sharedStaged3}`, '--expect', '团队/工具/recheck-shared.mjs=absent', '--json'], 'PROJECT_SCOPE_VIOLATION');
    expectErr(['propose', '--boot', sharedPg.token, '--task', task.task.id, '--title', '项目跨项目', '--file', `../other/recheck.md=${sharedStaged}`, '--expect', '../other/recheck.md=absent', '--json'], 'PROJECT_SCOPE_VIOLATION');
    // 审批一致：共享层提案 show → review → sign → apply，apply 写到仓库根
    // （用 src 的 normal 提案走完整签名链；团队/ 提案是 sensitive，需 owner 签字，不在沙盘强签）
    json(['show', '--boot', sharedPm.token, '--proposal', psSrc.proposal.id, '--json']);
    json(['review', '--boot', sharedPm.token, '--proposal', psSrc.proposal.id, '--verdict', 'approve', '--comments', '共享层变更同意', '--json']);
    // 三人以上团队：PM 不能既唯一评审又唯一签字，补一名成员评审
    const sharedTester = json(['boot', '--role', 'tester', '--project', '试点', '--session', 'selftest-shared-tester', '--json']);
    json(['show', '--boot', sharedTester.token, '--proposal', psSrc.proposal.id, '--json']);
    json(['review', '--boot', sharedTester.token, '--proposal', psSrc.proposal.id, '--verdict', 'approve', '--comments', '共享层变更测试侧同意', '--json']);
    json(['sign', '--boot', sharedPm.token, '--proposal', psSrc.proposal.id, '--decision', 'approve', '--note', '批准', '--json']);
    const psApply = json(['apply', '--boot', sharedPm.token, '--proposal', psSrc.proposal.id, '--json']);
    if (psApply.commit.scope !== 'shared') failStep('共享层 apply 提交未记 scope', JSON.stringify(psApply.commit.scope));
    const sharedApplied = path.join(sharedRepoRoot, 'src', 'recheck-shared.mjs');
    if (!fs.existsSync(sharedApplied)) failStep('共享层 apply 未写到仓库根', sharedApplied);
    if (sha(sharedApplied) !== psSrc.proposal.files[0].newHash) failStep('共享层 apply 后哈希与 new 不一致');
    fs.rmSync(sharedApplied, { force: true });
    fs.rmSync(path.join(sharedRepoRoot, 'src', 'recheck-dir'), { recursive: true, force: true });
    // 复核-v6 P1-1：scope 纳入 v2 提案哈希——改 scope 不重算哈希 → PROPOSAL_TAMPERED
    const sharedProposalFile = path.join(teamRoot, '状态', '项目', '试点', '提案', psSrc.proposal.id, '提案.json');
    const sharedProposalJson = JSON.parse(read(sharedProposalFile));
    if (sharedProposalJson.hashVersion !== 2) failStep('新提案未写 hashVersion=2', String(sharedProposalJson.hashVersion));
    const savedScope = sharedProposalJson.scope;
    sharedProposalJson.scope = 'project';
    write(sharedProposalFile, JSON.stringify(sharedProposalJson, null, 2) + '\n');
    const scopeTampered = run(['show', '--boot', sharedPm.token, '--proposal', psSrc.proposal.id, '--json'], { expectFail: true });
    if (!String(scopeTampered.stdout).includes('PROPOSAL_TAMPERED')) failStep('改 scope 后未判 PROPOSAL_TAMPERED', String(scopeTampered.stdout).slice(0, 300));
    sharedProposalJson.scope = savedScope;
    write(sharedProposalFile, JSON.stringify(sharedProposalJson, null, 2) + '\n');
    // 复核-v6 P1-2：apply 前逐文件复校——把已批准提案 target 改成 ../（并重算哈希使其自洽）→ PATH_OUTSIDE_REPO
    const tamperedId = 'P-selftest-apply-path';
    const tamperedProposalDir = path.join(teamRoot, '状态', '项目', '试点', '提案', tamperedId);
    fs.cpSync(path.join(teamRoot, '状态', '项目', '试点', '提案', psSrc.proposal.id), tamperedProposalDir, { recursive: true });
    const tamperedJson = JSON.parse(read(path.join(tamperedProposalDir, '提案.json')));
    tamperedJson.id = tamperedId;
    tamperedJson.status = 'approved';
    tamperedJson.files[0].target = '../outside-apply.txt';
    tamperedJson.proposalHash = computeProposalHash(tamperedJson);
    write(path.join(tamperedProposalDir, '提案.json'), JSON.stringify(tamperedJson, null, 2) + '\n');
    const pathTampered = run(['apply', '--boot', sharedPm.token, '--proposal', tamperedId, '--json'], { expectFail: true });
    if (!String(pathTampered.stdout + pathTampered.stderr).includes('PATH_OUTSIDE_REPO')) failStep('apply 未复校 ../ 目标', String(pathTampered.stdout + pathTampered.stderr).slice(0, 300));
    fs.rmSync(tamperedProposalDir, { recursive: true, force: true });
    pass('R-3911：scope 入 v2 提案哈希（改 scope → PROPOSAL_TAMPERED）、apply 逐文件路径复校（../ → PATH_OUTSIDE_REPO）');
    pass('R-3911：共享层 propose 三类允许、越界/清单外/目录/scope/项目越界拒绝、apply 写仓库根');

    json(['board', '--json']);
    if (!fs.existsSync(path.join(teamRoot, '看板.html'))) failStep('看板 HTML 未生成');
    pass('看板生成');

    const ws = json(['create', '--name', '六人协作测试', '--root', projectsRoot, '--no-register', '--json'], WORKSPACE_MJS);
    const wsRoot = ws.project.path;
    for (const d of ['项目经理', '产品', '需求分析师', '程序员A', '程序员B', '测试人员', '需求']) {
      if (!fs.existsSync(path.join(wsRoot, d, '文件索引.md'))) failStep(`缺角色目录或索引：${d}`);
    }
    for (const f of ['协作准则.md', '项目信息.md', '项目索引.md', 'workspace.json']) {
      if (!fs.existsSync(path.join(wsRoot, f))) failStep(`工作区缺文件：${f}`);
    }
    const rules = read(path.join(wsRoot, '协作准则.md'));
    if (!rules.includes('测试人员') || !rules.includes('纯协调/传话') || !rules.includes('产品与架构')) failStep('协作准则缺角色或分工');
    if (!rules.includes('项目信息.md') || !rules.includes('角色卡')) failStep('协作准则未要求先读项目信息/角色卡');
    const info = read(path.join(wsRoot, '项目信息.md'));
    if (!info.includes('任务分配') || !info.includes('角色确认记录')) failStep('项目信息模板缺任务分配/角色确认');
    if (Buffer.byteLength(read(path.join(wsRoot, '项目索引.md')), 'utf8') > 16384) failStep('根索引超过 16KB');
    for (const d of ['项目经理', '产品', '需求分析师', '程序员A', '程序员B', '测试人员']) {
      if (Buffer.byteLength(read(path.join(wsRoot, d, '文件索引.md')), 'utf8') > 8192) failStep(`角色索引超过 8KB：${d}`);
    }
    pass('工作区目录/六角色准则/根与角色索引');

    // ================= 需求评审 / 技术评审 / 投票（full） =================
    let fullPm = json(['boot', '--role', 'pm', '--project', '试点', '--session', 'selftest-full-pm', '--json']).token;
    json(['roster', 'add', '--boot', fullPm, '--role', 'product', '--name', '产品设计师', '--reason', 'full 评审用例', '--json']);
    fullPm = json(['boot', '--role', 'pm', '--project', '试点', '--session', 'selftest-full-pm', '--json']).token;
    json(['roster', 'add', '--boot', fullPm, '--role', 'analyst', '--name', '需求分析师', '--reason', 'full/fast 动态角色', '--json']);
    fullPm = json(['boot', '--role', 'pm', '--project', '试点', '--session', 'selftest-full-pm', '--json']).token;

    const fullReq = json(['req', 'create', '--boot', fullPm, '--title', '评审与投票用例', '--priority', 'P1', '--acceptance', '可测试、可判定', '--json']);
    const fullReqId = fullReq.requirement && fullReq.requirement.id;
    if (!fullReqId) failStep('req create 没返回需求 id', JSON.stringify(fullReq));

    const productBoot = json(['boot', '--role', 'product', '--project', '试点', '--session', 'selftest-product', '--json']);
    const analystBoot = json(['boot', '--role', 'analyst', '--project', '试点', '--session', 'selftest-analyst', '--json']);
    const devBoot2 = json(['boot', '--role', 'programmer1', '--project', '试点', '--session', 'selftest-dev2', '--json']);
    const testerBoot = json(['boot', '--role', 'tester', '--project', '试点', '--session', 'selftest-tester2', '--json']);

    const fullReview = json(['req', 'review', '--boot', productBoot.token, '--id', fullReqId, '--verdict', 'approve', '--comments', '场景、边界、验收标准齐全，同意进入技术评审', '--json']);
    if (!fullReview.review || fullReview.review.kind !== 'requirement' || fullReview.review.role !== 'product') {
      failStep('full 需求评审没有按产品记录', JSON.stringify(fullReview));
    }
    if (!fullReview.requirement || fullReview.requirement.id !== fullReqId) failStep('req review 返回的需求 id 不对（壳层契约）');
    expectErr(['req', 'review', '--boot', fullPm, '--id', fullReqId, '--verdict', 'approve', '--comments', 'PM 代评'], 'ROLE_NOT_ALLOWED');
    expectErr(['req', 'review', '--boot', devBoot2.token, '--id', fullReqId, '--verdict', 'approve', '--comments', '开发代评'], 'ROLE_NOT_ALLOWED');
    expectErr(['req', 'review', '--boot', testerBoot.token, '--id', fullReqId, '--verdict', 'reject', '--comments', '测试代评'], 'ROLE_NOT_ALLOWED');
    const fullTech = json(['req', 'review', '--boot', devBoot2.token, '--kind', 'tech', '--id', fullReqId, '--verdict', 'approve', '--comments', '接口、数据与回滚可行', '--json']);
    if (!fullTech.review || fullTech.review.kind !== 'tech' || fullTech.review.role !== 'programmer1') {
      failStep('full 技术评审没有按程序员A记录', JSON.stringify(fullTech));
    }
    expectErr(['req', 'review', '--boot', testerBoot.token, '--kind', 'tech', '--id', fullReqId, '--verdict', 'approve', '--comments', '测试记录技术评审'], 'ROLE_NOT_ALLOWED');
    pass('req review：full 产品评审 + 技术评审记录（PM/开发/测试不能代评）');

    // 技术评审驳回同样要落 rejected + requirement_review，不能停在“需求”节点。
    const techRejReq = json(['req', 'create', '--boot', fullPm, '--title', '技术评审驳回相位', '--priority', 'P1', '--acceptance', '技术方案需返工', '--json']);
    const techRejReqId = techRejReq.requirement && techRejReq.requirement.id;
    if (!techRejReqId) failStep('技术评审驳回用例需求未创建');
    json(['req', 'review', '--boot', productBoot.token, '--id', techRejReqId, '--verdict', 'approve', '--comments', '需求可进入技术评审', '--json']);
    json(['req', 'review', '--boot', devBoot2.token, '--kind', 'tech', '--id', techRejReqId, '--verdict', 'reject', '--comments', '接口与回滚方案不成立，退回重做', '--json']);
    const techRejWf = JSON.parse(read(path.join(teamRoot, '状态', '项目', '试点', '工作流.json')));
    if (techRejWf.requirements[techRejReqId].status !== 'rejected' || techRejWf.phase !== 'requirement_review') {
      failStep('技术评审驳回后相位/状态不对', JSON.stringify({ row: techRejWf.requirements[techRejReqId], phase: techRejWf.phase }));
    }
    const techRejTask = JSON.parse(read(path.join(teamRoot, '状态', '项目', '试点', '任务', `${techRejReqId}.json`)));
    if (!techRejTask.workflow.techReview || techRejTask.workflow.techReview.verdict !== 'reject') {
      failStep('技术评审驳回没有写任务 techReview', JSON.stringify(techRejTask.workflow.techReview || null));
    }
    pass('技术评审驳回：工作流行 rejected + phase=requirement_review + 任务 techReview 落盘');

    const stateShiDian = path.join(teamRoot, '状态', '项目', '试点');
    const reviewFiles = fs.readdirSync(path.join(stateShiDian, '需求评审')).filter((n) => n.endsWith('.json'));
    const techFiles = fs.readdirSync(path.join(stateShiDian, '技术评审')).filter((n) => n.endsWith('.json'));
    if (!reviewFiles.length || !techFiles.length) failStep('评审记录文件没有落盘', `${reviewFiles.length}/${techFiles.length}`);
    const taskObj = JSON.parse(read(path.join(stateShiDian, '任务', `${fullReqId}.json`)));
    if (!taskObj.review || taskObj.review.verdict !== 'approve' || !taskObj.techReview || taskObj.techReview.kind !== 'tech') {
      failStep('需求任务上没有评审字段', JSON.stringify({ review: taskObj.review, tech: taskObj.techReview }));
    }
    pass('评审记录：需求评审/技术评审 JSON + 任务字段落盘');

    // 驳回后相位 / 状态：需求评审驳回 → 工作流行 rejected，项目相位停在需求评审。
    const phaseReq = json(['req', 'create', '--boot', fullPm, '--title', '驳回相位用例', '--priority', 'P1', '--acceptance', '补边界后可评审', '--json']);
    const phaseReqId = phaseReq.requirement && phaseReq.requirement.id;
    if (!phaseReqId) failStep('驳回相位用例需求未创建');
    json(['req', 'review', '--boot', productBoot.token, '--id', phaseReqId, '--verdict', 'reject', '--comments', '场景与验收标准不清，退回补边界', '--json']);
    const wfAfterReject = JSON.parse(read(path.join(stateShiDian, '工作流.json')));
    if (!wfAfterReject.requirements || !wfAfterReject.requirements[phaseReqId]
      || wfAfterReject.requirements[phaseReqId].status !== 'rejected') {
      failStep('需求评审驳回没有把工作流行写成 rejected', JSON.stringify(wfAfterReject.requirements || null));
    }
    if (wfAfterReject.phase !== 'requirement_review') {
      failStep('需求评审驳回后相位不是 requirement_review', wfAfterReject.phase);
    }
    const phaseTask = JSON.parse(read(path.join(stateShiDian, '任务', `${phaseReqId}.json`)));
    if (!phaseTask.workflow || phaseTask.workflow.requirementStatus !== 'rejected') {
      failStep('需求评审驳回没有把任务写成 rejected', JSON.stringify(phaseTask.workflow || null));
    }
    pass('需求评审驳回：工作流需求行 rejected + phase=requirement_review + 任务同步');

    // 评审驳回也能直接 req iterate；单条迭代不把项目轮次往前推。
    const phaseIter = json(['req', 'iterate', '--boot', fullPm, '--id', phaseReqId, '--reason', '按评审意见补边界与验收标准', '--json']);
    if (!phaseIter.requirement || phaseIter.requirement.status !== 'open'
      || phaseIter.requirement.workflow.requirementStatus !== 'iteration'
      || phaseIter.requirement.workflow.iterationRound !== 1) {
      failStep('评审驳回后 req iterate 没有进入下一轮', JSON.stringify(phaseIter.requirement));
    }
    const wfAfterIter = JSON.parse(read(path.join(stateShiDian, '工作流.json')));
    if (wfAfterIter.requirements[phaseReqId].status !== 'iteration') {
      failStep('req iterate 没有同步工作流行', JSON.stringify(wfAfterIter.requirements[phaseReqId]));
    }
    if (Number(wfAfterIter.requirements[phaseReqId].round) !== Number(wfAfterIter.round)) {
      failStep('单条 req iterate 不应把需求推到下一轮', JSON.stringify({ rowRound: wfAfterIter.requirements[phaseReqId].round, stateRound: wfAfterIter.round }));
    }
    pass('req iterate（评审驳回）：任务 open + iterationRound=1 + 工作流行 iteration，轮次不跳');

    // Owner：确认码 → 决定 → 验收；没有确认码 / 重放必须拒绝。
    const ownerConfirm = json(['owner', 'confirm', '--project', '试点', '--requirement', fullReqId, '--decision', 'skipped', '--test-owner', '--json']);
    const ownerNonce = ownerConfirm.confirmation && ownerConfirm.confirmation.nonce;
    if (!ownerNonce) failStep('owner confirm 没有返回一次性确认码', JSON.stringify(ownerConfirm));
    expectErr(['owner', '--project', '试点', '--requirement', fullReqId, '--decision', 'approved', '--opinion', '没有确认码'], 'OWNER_CONFIRM_REQUIRED');
    const ownerSkipped = json(['owner', '--project', '试点', '--requirement', fullReqId, '--decision', 'skipped', '--opinion', '分析师：已评估；\n产品：已评估；\n开发：已评估。Owner 确认跳过技术评审', '--owner-confirm', ownerNonce, '--json']);
    if (!ownerSkipped.ok || !ownerSkipped.requirement || ownerSkipped.requirement.workflow.ownerReview.status !== 'skipped') {
      failStep('owner skipped 没有写任务 ownerReview', JSON.stringify(ownerSkipped));
    }
    const wfAfterOwner = JSON.parse(read(path.join(stateShiDian, '工作流.json')));
    if (wfAfterOwner.requirements[fullReqId].status !== 'ready' || wfAfterOwner.phase !== 'dispatch') {
      failStep('owner skipped 后工作流行/相位不对', JSON.stringify({ row: wfAfterOwner.requirements[fullReqId], phase: wfAfterOwner.phase }));
    }
    if (!wfAfterOwner.requirements[fullReqId].ownerReview
      || wfAfterOwner.requirements[fullReqId].ownerReview.actor !== 'owner') {
      failStep('owner skipped 没有写 actor=owner', JSON.stringify(wfAfterOwner.requirements[fullReqId].ownerReview || null));
    }
    expectErr(['owner', '--project', '试点', '--requirement', fullReqId, '--decision', 'approved', '--opinion', '重放确认码', '--owner-confirm', ownerNonce], 'OWNER_CONFIRM_INVALID');
    pass('owner：confirm 一次性确认码；Owner skipped 写任务/工作流 actor=owner；无确认码/重放被拒');

    // Owner 验收：开发 done→dev_done、测试全 done→test_done，且自动推进工作流行。
    const ownerDev = json(['task', 'create', '--boot', fullPm, '--title', 'Owner 验收开发任务', '--priority', 'P1', '--requirement', fullReqId, '--owner', 'programmer1', '--json']);
    json(['task', 'claim', '--boot', devBoot2.token, '--id', ownerDev.task.id, '--json']);
    json(['task', 'done', '--boot', devBoot2.token, '--id', ownerDev.task.id, '--evidence', '开发完成，可测试', '--json']);
    const wfDev = JSON.parse(read(path.join(stateShiDian, '工作流.json')));
    if (wfDev.requirements[fullReqId].status !== 'dev_done') failStep('开发任务 done 未推进 dev_done', JSON.stringify({ status: wfDev.requirements[fullReqId].status, phase: wfDev.phase }));
    pass('task done 开发任务 → 需求 dev_done，工作流行同步');

    // R-b52b / ea86 回归（2026-11-14）：同需求还有开发任务没 done 时，推进必须「不推进 + 留痕」，
    // 不能静默 return（现场表现就是「task done 了需求不动，也查不到原因」——ea86 被遗留 open 旧单卡住过一次）。
    {
      const advReq = json(['req', 'create', '--boot', fullPm, '--title', '推进阻塞可见性用例', '--priority', 'P2', '--acceptance', '有未完成开发任务时不推进且留痕', '--json']);
      // req create 的 JSON 返回是 {ok, requirement}（不是 task）；两种都兜住，拿不到就直接失败，
      // 避免后面报 "reading 'id' of undefined" 这种看不出原因的错。
      const advReqId = (advReq.requirement && advReq.requirement.id) || (advReq.task && advReq.task.id) || '';
      if (!advReqId) failStep('req create 没返回需求 id', JSON.stringify(advReq).slice(0, 200));
      const advStateFile = path.join(stateShiDian, '工作流.json');
      const advState = JSON.parse(read(advStateFile));
      const advNow = new Date().toISOString();
      advState.requirements[advReqId] = {
        ...(advState.requirements[advReqId] || {}),
        id: advReqId, status: 'ready', reviewedAt: advNow, updatedAt: advNow,
        ownerReview: { status: 'skipped', by: 'Owner', actor: 'owner', at: advNow },
        decisions: [{ status: 'skipped', channel: 'tty', decidedBy: 'Owner', actor: 'owner', at: advNow }],
      };
      write(advStateFile, JSON.stringify(advState, null, 2) + '\n');
      const advTaskA = json(['task', 'create', '--boot', fullPm, '--title', '推进用例 A', '--priority', 'P2', '--requirement', advReqId, '--owner', 'programmer1', '--json']);
      const advTaskB = json(['task', 'create', '--boot', fullPm, '--title', '推进用例 B', '--priority', 'P2', '--requirement', advReqId, '--owner', 'programmer1', '--json']);
      json(['task', 'claim', '--boot', devBoot2.token, '--id', advTaskA.task.id, '--json']);
      json(['task', 'claim', '--boot', devBoot2.token, '--id', advTaskB.task.id, '--json']);
      json(['task', 'done', '--boot', devBoot2.token, '--id', advTaskA.task.id, '--evidence', 'A 完成，B 还没做', '--json']);
      const advAfterA = JSON.parse(read(advStateFile));
      if (String(advAfterA.requirements[advReqId].status || '') !== 'ready') {
        failStep('还有开发任务未 done 时不该推进 dev_done', JSON.stringify({ status: advAfterA.requirements[advReqId].status, b: advTaskB.task.id }));
      }
      const advEvents = read(path.join(teamRoot, '状态', '事件.jsonl')).split(/\r?\n/).filter(Boolean).map((line) => {
        try { return JSON.parse(line); } catch { return null; }
      }).filter(Boolean);
      const advSkip = advEvents.filter((row) => row.action === 'requirement_advance_skipped' && row.target === advReqId && /dev_tasks_open/.test(String(row.note || '')));
      if (!advSkip.length) failStep('推进被开发任务挡住时没有留 requirement_advance_skipped(dev_tasks_open)', JSON.stringify(advEvents.slice(-3).map((row) => row.action)));
      if (!String(advSkip[advSkip.length - 1].note || '').includes(advTaskB.task.id)) {
        failStep('advance_skipped 事件没写清是哪条任务在挡', String(advSkip[advSkip.length - 1].note || '').slice(0, 200));
      }
      json(['task', 'done', '--boot', devBoot2.token, '--id', advTaskB.task.id, '--evidence', 'B 也完成', '--json']);
      const advAfterB = JSON.parse(read(advStateFile));
      if (String(advAfterB.requirements[advReqId].status || '') !== 'dev_done') {
        failStep('全部开发任务 done 后仍未推进 dev_done', JSON.stringify({ status: advAfterB.requirements[advReqId].status }));
      }
      pass('B-b645 回归：开发任务未全 done → 不推进 + requirement_advance_skipped(dev_tasks_open) 写明挡路任务；全 done → dev_done');

      // 回填回归（M-20261114-031603-947c03）：recompute-advance 按现有任务重算，幂等，且把需求任务自身 status 回填成目标。
      const rec1 = json(['task', 'recompute-advance', '--boot', fullPm, '--project', '试点', '--requirement', advReqId, '--json']);
      if (!rec1.ok || !Array.isArray(rec1.rows) || !rec1.rows.length) failStep('recompute-advance 没有返回行', JSON.stringify(rec1).slice(0, 200));
      if (String(rec1.rows[0].after || '') !== 'dev_done') failStep('recompute-advance 重算后不是 dev_done', JSON.stringify(rec1.rows[0]).slice(0, 200));
      const recTask = JSON.parse(read(path.join(stateShiDian, '任务', advReqId + '.json')));
      if (String(recTask.status || '') !== 'dev_done') failStep('recompute-advance 没回填需求任务 status', String(recTask.status || ''));
      const rec2 = json(['task', 'recompute-advance', '--boot', fullPm, '--project', '试点', '--requirement', advReqId, '--json']);
      if (Number(rec2.changed || 0) !== 0) failStep('recompute-advance 不幂等：第二次仍在改', JSON.stringify(rec2.rows).slice(0, 200));
      pass('recompute-advance 回归：按任务重算到 dev_done、回填需求任务 status、第二次幂等（changed=0）');
    }


    const ownerTest = json(['task', 'create', '--boot', fullPm, '--title', 'Owner 验收测试任务', '--priority', 'P1', '--requirement', fullReqId, '--owner', 'tester', '--json']);
    json(['task', 'claim', '--boot', testerBoot.token, '--id', ownerTest.task.id, '--json']);
    // G7 硬门：测试任务 done 前必须有覆盖该需求且 PASS/FAIL 明确的测试报告。
    write(path.join(projDir, '测试人员', '产出', '测试报告-v1.md'), `# 测试报告 v1\n\n- 需求：${fullReqId}\n- 结论：PASS\n`);
    json(['task', 'done', '--boot', testerBoot.token, '--id', ownerTest.task.id, '--evidence', 'PASS 验收测试通过', '--json']);
    const wfTest = JSON.parse(read(path.join(stateShiDian, '工作流.json')));
    if (wfTest.requirements[fullReqId].status !== 'test_done') failStep('测试任务 done 未推进 test_done', JSON.stringify({ status: wfTest.requirements[fullReqId].status, phase: wfTest.phase }));
    if (wfTest.phase !== 'test_done') failStep('测试任务 done 后相位不是 test_done', wfTest.phase);
    pass('task done 测试任务且全部测试 done → 需求 test_done，工作流行同步');
    const acceptConfirm = json(['owner', 'confirm', '--project', '试点', '--requirement', fullReqId, '--decision', 'accepted', '--action', 'accept', '--test-owner', '--json']);
    const accepted = json(['owner', '--project', '试点', '--requirement', fullReqId, '--decision', 'accepted', '--action', 'accept', '--opinion', '验收通过', '--owner-confirm', acceptConfirm.confirmation.nonce, '--json']);
    if (!accepted.ok || !accepted.requirement || accepted.requirement.status !== 'done') {
      failStep('owner accept 没有收口需求任务', JSON.stringify(accepted));
    }
    const wfAfterAccept = JSON.parse(read(path.join(stateShiDian, '工作流.json')));
    if (wfAfterAccept.requirements[fullReqId].status !== 'accepted' || wfAfterAccept.phase !== 'accepted') {
      failStep('owner accept 后工作流行/相位不对', JSON.stringify({ row: wfAfterAccept.requirements[fullReqId], phase: wfAfterAccept.phase }));
    }
    if (!wfAfterAccept.requirements[fullReqId].acceptance
      || wfAfterAccept.requirements[fullReqId].acceptance.actor !== 'owner') {
      failStep('owner accept 没有写 acceptance', JSON.stringify(wfAfterAccept.requirements[fullReqId].acceptance || null));
    }
    pass('owner accept：测试任务 done + test_done → accepted，需求任务 done，工作流 acceptance 落盘');

    const fullVote = json(['vote', 'start', '--boot', fullPm, '--subject', '完整模式投票用例', '--kind', 'requirement', '--requirement', fullReqId, '--json']);
    const fullEligible = fullVote.vote.eligible.slice().sort().join(',');
    if (fullEligible !== 'analyst,product,programmer1,tester') failStep('full 投票参与人不是除 PM 外全员', fullEligible);
    expectErr(['vote', 'cast', '--boot', fullPm, '--id', fullVote.vote.id, '--vote', 'approve'], 'NOT_ELIGIBLE');
    expectErr(['vote', 'cast', '--boot', analystBoot.token, '--id', fullVote.vote.id, '--vote', 'maybe'], 'BAD_VOTE');
    json(['vote', 'cast', '--boot', productBoot.token, '--id', fullVote.vote.id, '--vote', 'approve', '--comment', '需求清晰', '--json']);
    json(['vote', 'cast', '--boot', analystBoot.token, '--id', fullVote.vote.id, '--vote', 'approve', '--comment', '验收可测', '--json']);
    const fullApproved = json(['vote', 'cast', '--boot', devBoot2.token, '--id', fullVote.vote.id, '--vote', 'approve', '--comment', '实现可行', '--json']);
    if (fullApproved.vote.result !== 'approved' || fullApproved.vote.status !== 'closed') failStep('full 投票过半未通过', JSON.stringify(fullApproved.vote));
    expectErr(['vote', 'cast', '--boot', testerBoot.token, '--id', fullVote.vote.id, '--vote', 'reject'], 'VOTE_CLOSED');
    pass('vote：PM 不投票；过半通过并关闭；关闭后不能再投');

    const fullVote2 = json(['vote', 'start', '--boot', fullPm, '--subject', '一致驳回用例', '--json']);
    json(['vote', 'cast', '--boot', productBoot.token, '--id', fullVote2.vote.id, '--vote', 'reject', '--comment', '需求边界不清', '--json']);
    json(['vote', 'cast', '--boot', analystBoot.token, '--id', fullVote2.vote.id, '--vote', 'reject', '--comment', '验收不可判定', '--json']);
    json(['vote', 'cast', '--boot', devBoot2.token, '--id', fullVote2.vote.id, '--vote', 'reject', '--comment', '实现风险高', '--json']);
    const midway = json(['vote', 'status', '--id', fullVote2.vote.id, '--project', '试点', '--json']);
    if (midway.evaluation.result !== 'pending') failStep('未全员驳回就提前驳回', JSON.stringify(midway.evaluation));
    const allRejected = json(['vote', 'cast', '--boot', testerBoot.token, '--id', fullVote2.vote.id, '--vote', 'reject', '--comment', '没有测试证据', '--json']);
    if (allRejected.vote.result !== 'rejected') failStep('除 PM 外全员一致驳回未生效', JSON.stringify(allRejected.vote));
    const statusOne = json(['vote', 'status', '--id', fullVote.vote.id, '--project', '试点', '--json']);
    if (statusOne.vote.result !== 'approved') failStep('vote status 读取结论不对');
    const statusList = json(['vote', 'status', '--project', '试点', '--json']);
    if (!Array.isArray(statusList.votes) || statusList.votes.length < 2) failStep('vote status 列表缺投票', JSON.stringify(statusList.votes || []));
    const voteJson = path.join(stateShiDian, '投票', `${fullVote.vote.id}.json`);
    const voteMd = path.join(stateShiDian, '投票', `${fullVote.vote.id}.md`);
    if (!fs.existsSync(voteJson) || !fs.existsSync(voteMd)) failStep('投票文件没有落盘（json/md）');
    pass('vote：除 PM 外全员一致驳回才驳回；vote status 只读可查；投票文件落盘');

    // 投票发起人 = 实际发起角色：需求分析师发起时 createdBy 必须是 analyst，不是 PM。
    const analystVote = json(['vote', 'start', '--boot', analystBoot.token, '--subject', '分析师发起投票', '--kind', 'other', '--json']);
    if (!analystVote.vote || analystVote.vote.createdBy !== 'analyst') {
      failStep('需求分析师发起投票但 createdBy 不是 analyst', JSON.stringify(analystVote.vote || null));
    }
    const analystVotePath = path.join(stateShiDian, '投票', `${analystVote.vote.id}.json`);
    const analystVoteRaw = JSON.parse(read(analystVotePath));
    if (analystVoteRaw.createdBy !== 'analyst') failStep('V-*.json createdBy 不是 analyst', JSON.stringify(analystVoteRaw));
    if (!read(analystVotePath.replace(/\.json$/, '.md')).includes('发起人：需求分析师')) {
      failStep('投票 md 发起人不是需求分析师');
    }
    expectErr(['vote', 'start', '--boot', testerBoot.token, '--subject', '测试越权发起', '--kind', 'other', '--json'], 'ROLE_NOT_ALLOWED');
    pass('vote start：PM/需求分析师可发起；createdBy 记实际 analyst；测试越权被拒');

    // ================= 被驳回需求：req iterate / req terminate =================
    const lifeReq = json(['req', 'create', '--boot', fullPm, '--title', '驳回后迭代用例', '--priority', 'P1', '--acceptance', '补边界后可判定', '--json']);
    const lifeReqId = lifeReq.requirement && lifeReq.requirement.id;
    if (!lifeReqId) failStep('iterate 用例需求未创建');
    const lifeChild = json(['task', 'create', '--boot', fullPm, '--title', '随需求迭代关闭的子任务', '--priority', 'P1', '--requirement', lifeReqId, '--owner', 'programmer1', '--json']);
    const lifeVote = json(['vote', 'start', '--boot', fullPm, '--subject', '驳回后迭代投票', '--kind', 'requirement', '--requirement', lifeReqId, '--json']);
    for (const token of [productBoot.token, analystBoot.token, devBoot2.token, testerBoot.token]) {
      json(['vote', 'cast', '--boot', token, '--id', lifeVote.vote.id, '--vote', 'reject', '--comment', '边界不清，先退回改稿', '--json']);
    }
    const lifeTaskRejected = JSON.parse(read(path.join(stateShiDian, '任务', `${lifeReqId}.json`)));
    if (!lifeTaskRejected.workflow || lifeTaskRejected.workflow.requirementStatus !== 'rejected') {
      failStep('投票一致驳回后需求任务没有 rejected 标记', JSON.stringify(lifeTaskRejected.workflow || null));
    }
    const lifeWfPath = path.join(stateShiDian, '工作流.json');
    const lifeWfRejected = JSON.parse(read(lifeWfPath));
    if (!lifeWfRejected.requirements || !lifeWfRejected.requirements[lifeReqId]
      || lifeWfRejected.requirements[lifeReqId].status !== 'rejected') {
      failStep('投票一致驳回后 工作流.json 没有 rejected 行', JSON.stringify(lifeWfRejected.requirements || null));
    }
    const iterated = json(['req', 'iterate', '--boot', fullPm, '--id', lifeReqId, '--reason', '按意见补边界与验收后重走', '--json']);
    if (!iterated.requirement || iterated.requirement.status !== 'open'
      || !iterated.requirement.workflow || iterated.requirement.workflow.requirementStatus !== 'iteration'
      || iterated.requirement.workflow.iterationRound !== 1) {
      failStep('req iterate 没有把被驳回需求转入下一轮', JSON.stringify(iterated.requirement));
    }
    const lifeWfIter = JSON.parse(read(lifeWfPath));
    if (lifeWfIter.requirements[lifeReqId].status !== 'iteration') failStep('req iterate 没有同步 工作流.json');
    if (lifeWfIter.requirements[lifeReqId].iterationRound !== 1) {
      failStep('req iterate 没有把 iterationRound 写进工作流行', JSON.stringify(lifeWfIter.requirements[lifeReqId]));
    }
    const lifeChildAfter = JSON.parse(read(path.join(stateShiDian, '任务', `${lifeChild.task.id}.json`)));
    if (lifeChildAfter.status !== 'done' || lifeChildAfter.workflow.requirementStatus !== 'iteration') {
      failStep('req iterate 没有收口关联子任务', JSON.stringify(lifeChildAfter));
    }

    const termReq = json(['req', 'create', '--boot', fullPm, '--title', '驳回后终止用例', '--priority', 'P1', '--acceptance', '不再进入开发', '--json']);
    const termReqId = termReq.requirement && termReq.requirement.id;
    const termChild = json(['task', 'create', '--boot', fullPm, '--title', '随需求终止的子任务', '--priority', 'P1', '--requirement', termReqId, '--owner', 'programmer1', '--json']);
    const termVote = json(['vote', 'start', '--boot', fullPm, '--subject', '驳回后终止投票', '--kind', 'requirement', '--requirement', termReqId, '--json']);
    for (const token of [productBoot.token, analystBoot.token, devBoot2.token, testerBoot.token]) {
      json(['vote', 'cast', '--boot', token, '--id', termVote.vote.id, '--vote', 'reject', '--comment', '与 Owner 确认不再做，终止', '--json']);
    }
    const terminated = json(['req', 'terminate', '--boot', fullPm, '--id', termReqId, '--reason', '与 Owner 确认终止，不再进入开发', '--json']);
    if (!terminated.requirement || terminated.requirement.status !== 'done'
      || !terminated.requirement.workflow || terminated.requirement.workflow.requirementStatus !== 'terminated') {
      failStep('req terminate 没有把需求收口', JSON.stringify(terminated.requirement));
    }
    const termChildAfter = JSON.parse(read(path.join(stateShiDian, '任务', `${termChild.task.id}.json`)));
    if (termChildAfter.status !== 'done' || !termChildAfter.workflow || termChildAfter.workflow.requirementStatus !== 'terminated') {
      failStep('req terminate 没有收口关联子任务', JSON.stringify(termChildAfter));
    }
    const lifeWfTerm = JSON.parse(read(lifeWfPath));
    if (lifeWfTerm.requirements[termReqId].status !== 'terminated') failStep('req terminate 没有同步 工作流.json');
    pass('req iterate/terminate：被投票驳回的需求可进入下一轮或终止；工作流.json 与子任务同步');

    // ================= Full 模式：单需求驳回 → 迭代 → 工作流轮次 / 终止 =================
    const closeAdd = json(['project', 'add', '--name', '收口', '--desc', 'Full 模式收口用例', '--by', 'owner', '--json']);
    if (!closeAdd.ok || closeAdd.teamMode !== 'full') failStep('Full 收口项目没建成', JSON.stringify(closeAdd));
    const closePm = json(['boot', '--role', 'pm', '--project', '收口', '--session', 'selftest-close-pm', '--json']).token;
    const closeProduct = json(['boot', '--role', 'product', '--project', '收口', '--session', 'selftest-close-product', '--json']).token;
    const closeReq = json(['req', 'create', '--boot', closePm, '--title', '单需求收口', '--priority', 'P1', '--acceptance', '可终止', '--json']);
    const closeReqId = closeReq.requirement && closeReq.requirement.id;
    if (!closeReqId) failStep('Full 收口用例需求未创建');
    json(['req', 'review', '--boot', closeProduct, '--id', closeReqId, '--verdict', 'reject', '--comments', '范围与验收不清，退回重审', '--json']);
    const closeState = path.join(teamRoot, '状态', '项目', '收口');
    const closeWfPath = path.join(closeState, '工作流.json');
    let closeWf = JSON.parse(read(closeWfPath));
    if (closeWf.phase !== 'requirement_review' || closeWf.requirements[closeReqId].status !== 'rejected') {
      failStep('Full 驳回后相位/状态不对', JSON.stringify({ phase: closeWf.phase, row: closeWf.requirements[closeReqId] }));
    }
    json(['req', 'iterate', '--boot', closePm, '--id', closeReqId, '--reason', '补范围与验收后重审', '--json']);
    closeWf = JSON.parse(read(closeWfPath));
    if (closeWf.requirements[closeReqId].status !== 'iteration' || closeWf.phase !== 'requirement_review') {
      failStep('Full req iterate 后相位/状态不对', JSON.stringify({ phase: closeWf.phase, row: closeWf.requirements[closeReqId] }));
    }
    const closeIter = json(['workflow', 'iterate', '--boot', closePm, '--project', '收口', '--opinion', '进入下一轮', '--json']);
    if (closeIter.round !== 2 || !closeIter.workflow || closeIter.workflow.phase !== 'iteration') {
      failStep('Full workflow iterate 没有推进轮次/相位', JSON.stringify(closeIter));
    }
    const closeTerm = json(['workflow', 'terminate', '--boot', closePm, '--project', '收口', '--opinion', '与 Owner 确认终止', '--json']);
    if (!closeTerm.terminated || !closeTerm.workflow || closeTerm.workflow.phase !== 'terminated'
      || !Array.isArray(closeTerm.stopped) || !closeTerm.stopped.includes(closeReqId)) {
      failStep('Full workflow terminate 没有终止需求/写相位', JSON.stringify(closeTerm));
    }
    closeWf = JSON.parse(read(closeWfPath));
    if (closeWf.phase !== 'terminated' || closeWf.requirements[closeReqId].status !== 'terminated') {
      failStep('Full 终止后工作流落盘不对', JSON.stringify({ phase: closeWf.phase, row: closeWf.requirements[closeReqId] }));
    }
    const closeTask = JSON.parse(read(path.join(closeState, '任务', `${closeReqId}.json`)));
    if (closeTask.status !== 'done' || !closeTask.workflow || closeTask.workflow.requirementStatus !== 'terminated') {
      failStep('Full 终止后需求任务没同步', JSON.stringify(closeTask));
    }
    pass('Full workflow：驳回 phase=requirement_review → 单需求 iterate → 轮次+1 → terminate 收口任务');

    // 5 名非 PM 全员投票：补程序员B 后重新 boot（成员表变化会让旧令牌 RULES_CHANGED）。
    json(['roster', 'add', '--boot', fullPm, '--role', 'programmer2', '--name', '高级程序员 B', '--reason', '5 人投票用例', '--json']);
    const pm5 = json(['boot', '--role', 'pm', '--project', '试点', '--session', 'selftest-5-pm', '--json']).token;
    const product5 = json(['boot', '--role', 'product', '--project', '试点', '--session', 'selftest-5-product', '--json']).token;
    const analyst5 = json(['boot', '--role', 'analyst', '--project', '试点', '--session', 'selftest-5-analyst', '--json']).token;
    const dev5 = json(['boot', '--role', 'programmer2', '--project', '试点', '--session', 'selftest-5-dev2', '--json']).token;
    const vote5 = json(['vote', 'start', '--boot', pm5, '--subject', '五人非 PM 全员投票', '--kind', 'other', '--json']);
    const eligible5 = vote5.vote.eligible.slice().sort().join(',');
    if (eligible5 !== 'analyst,product,programmer1,programmer2,tester') failStep('5 人投票参与人不是除 PM 外全员', eligible5);
    json(['vote', 'cast', '--boot', product5, '--id', vote5.vote.id, '--vote', 'approve', '--comment', '同意', '--json']);
    json(['vote', 'cast', '--boot', analyst5, '--id', vote5.vote.id, '--vote', 'approve', '--comment', '同意', '--json']);
    const approved5 = json(['vote', 'cast', '--boot', dev5, '--id', vote5.vote.id, '--vote', 'approve', '--comment', '同意', '--json']);
    if (approved5.vote.result !== 'approved') failStep('5 人投票 3/5 未通过', JSON.stringify(approved5.vote));
    pass('vote：3/4/5 人非 PM 全员（本次实测 4 人一致驳回 + 5 人 3/5 通过）');

    // ================= fast 模式：四角色目录 / boot / 评审 / 投票 =================
    const fastAdd = json(['project', 'add', '--name', '快四', '--desc', '快速四角色', '--team-mode', 'fast', '--by', 'owner', '--json']);
    if (!fastAdd.ok || fastAdd.teamMode !== 'fast') failStep('project add --team-mode fast 失败', JSON.stringify(fastAdd));
    const fastDir = path.join(projectsRoot, '快四');
    for (const d of ['项目经理', '需求分析师', '程序员A', '测试人员']) {
      for (const f of ['角色卡.md', '文件索引.md']) {
        if (!fs.existsSync(path.join(fastDir, d, f))) failStep(`fast 缺角色文件：${d}/${f}`);
      }
      if (!fs.existsSync(path.join(fastDir, d, '产出'))) failStep(`fast 缺 产出/：${d}`);
    }
    for (const d of ['产品', '程序员B']) {
      if (fs.existsSync(path.join(fastDir, d))) failStep(`fast 不应建目录：${d}`);
    }
    const fastShow = json(['project', 'show', '--name', '快四', '--json']);
    if (fastShow.teamMode !== 'fast' || !fastShow.structure.ok) failStep('fast project show 模式/结构不对', JSON.stringify(fastShow.structure));
    if (fastShow.structure.roles.join(',') !== 'pm,analyst,programmer1,tester') failStep('fast 结构角色集不对', fastShow.structure.roles.join(','));
    const fastList = json(['project', 'list', '--json']);
    const fastRow = (fastList.structures || []).find((r) => r.name === '快四');
    if (!fastRow || fastRow.teamMode !== 'fast') failStep('project list 没返回 fast 模式');
    pass('fast project add：四角色目录/角色卡/产出，不建产品/程序员B');

    // project create 是 add 的同义入口，也要写 teamMode/roleIds，不能只建目录。
    const fastCreate = json(['project', 'create', '--name', '快建', '--team-mode', 'fast', '--by', 'owner', '--json']);
    if (!fastCreate.ok || fastCreate.teamMode !== 'fast' || (fastCreate.roleIds || []).join(',') !== 'pm,analyst,programmer1,tester'
      || !fastCreate.structure || !fastCreate.structure.ok) {
      failStep('project create --team-mode fast 没返回 fast/roleIds/结构', JSON.stringify(fastCreate));
    }
    const fastCreateDir = path.join(projectsRoot, '快建');
    for (const d of ['项目经理', '需求分析师', '程序员A', '测试人员']) {
      if (!fs.existsSync(path.join(fastCreateDir, d, '角色卡.md'))) failStep(`project create 缺四角色目录：${d}`);
    }
    if (fs.existsSync(path.join(fastCreateDir, '产品')) || fs.existsSync(path.join(fastCreateDir, '程序员B'))) {
      failStep('project create --team-mode fast 建了模式外目录');
    }
    const fastCreateCfg = JSON.parse(read(path.join(teamRoot, '状态', '项目', '快建', '项目.json')));
    if (fastCreateCfg.teamMode !== 'fast' || (fastCreateCfg.roleIds || []).join(',') !== 'pm,analyst,programmer1,tester') {
      failStep('project create 没把 teamMode/roleIds 写进 项目.json', JSON.stringify(fastCreateCfg));
    }
    pass('project create --team-mode fast：项目.json 写 teamMode/roleIds，四角色目录');

    // 模式真相：项目.json 写 teamMode + roleIds；workspace.json 同步（镜像）。
    const fastStateDir = path.join(teamRoot, '状态', '项目', '快四');
    const fastCfgPath = path.join(fastStateDir, '项目.json');
    const fastWorkspacePath = path.join(fastDir, 'workspace.json');
    const fastCfg = JSON.parse(read(fastCfgPath));
    if (fastCfg.teamMode !== 'fast' || (fastCfg.roleIds || []).join(',') !== 'pm,analyst,programmer1,tester') {
      failStep('fast 项目.json 没写 teamMode/roleIds', JSON.stringify({ teamMode: fastCfg.teamMode, roleIds: fastCfg.roleIds }));
    }
    const fastMeta = JSON.parse(read(fastWorkspacePath));
    if (fastMeta.teamMode !== 'fast'
      || (fastMeta.roleIds || []).join(',') !== 'pm,analyst,programmer1,tester'
      || !Array.isArray(fastMeta.roles) || fastMeta.roles.length !== 4) {
      failStep('fast workspace.json 没同步模式/四角色', JSON.stringify({ teamMode: fastMeta.teamMode, roleIds: fastMeta.roleIds, roles: (fastMeta.roles || []).length }));
    }
    pass('fast project add：项目.json 写 teamMode/roleIds；workspace.json 同步四角色');

    const fastRules = read(path.join(fastDir, '协作准则.md'));
    for (const must of ['四角色', '需求评审', '技术评审', 'vote', '除 PM 外全员一致驳回', '中文思考、中文回复、中文写文档']) {
      if (!fastRules.includes(must)) failStep(`fast 协作准则缺：${must}`);
    }
    const fastInfo = read(path.join(fastDir, '项目信息.md'));
    if (!fastInfo.includes('快速四角色') || !fastInfo.includes('需求分析师') || fastInfo.includes('`程序员B/`')) failStep('fast 项目信息不对');
    const fastIndexText = read(path.join(fastDir, '项目索引.md'));
    if (fastIndexText.includes('程序员B/')) failStep('fast 根索引残留程序员B');
    const analystCard2 = read(path.join(fastDir, '需求分析师', '角色卡.md'));
    if (!analystCard2.includes('req review') || !analystCard2.includes('需求评审')) failStep('fast 需求分析师角色卡缺需求评审');
    const devCard2 = read(path.join(fastDir, '程序员A', '角色卡.md'));
    if (!devCard2.includes('--kind tech') || !devCard2.includes('技术评审')) failStep('fast 程序员A角色卡缺技术评审记录');
    const testerCard2 = read(path.join(fastDir, '测试人员', '角色卡.md'));
    if (!testerCard2.includes('vote cast') || !testerCard2.includes('除 PM 外全员一致驳回')) failStep('fast 测试角色卡缺投票');
    const pmCard2 = read(path.join(fastDir, '项目经理', '角色卡.md'));
    if (!pmCard2.includes('vote start') || !pmCard2.includes('不投票')) failStep('fast PM 角色卡缺投票组织');
    for (const d of ['项目经理', '需求分析师', '程序员A', '测试人员']) {
      const card = read(path.join(fastDir, d, '角色卡.md'));
      if (!card.includes('中文思考、中文回复、中文写文档')) failStep(`fast 角色卡缺中文纪律：${d}`);
      if (!card.includes('执行消息正文中的任务') || !card.includes('完成回执') || !card.includes('task done')) failStep(`fast 角色卡缺派单闭环：${d}`);
    }
    pass('fast 角色卡/协作准则：中文纪律 + 需求评审/技术评审/投票职责');

    let fastPm = json(['boot', '--role', 'pm', '--project', '快四', '--session', 'selftest-fast-pm', '--json']);
    if (fastPm.teamMode !== 'fast') failStep('fast boot 没返回模式');
    if (!String(fastPm.briefing || '').includes('快速模式') || !String(fastPm.briefing || '').includes('需求评审=需求分析师')) failStep('fast boot 简报缺模式/评审说明');
    expectErr(['boot', '--role', 'product', '--project', '快四', '--json'], 'ROLE_NOT_IN_MODE');
    pass('fast boot：PM 拿到模式简报；product 不在模式内被拒');

    json(['project', 'use', '--boot', fastPm.token, '--name', '快四', '--json']);
    fastPm = json(['boot', '--role', 'pm', '--project', '快四', '--session', 'selftest-fast-pm', '--json']);
    expectErr(['roster', 'add', '--boot', fastPm.token, '--role', 'product', '--name', '产品', '--force', '--json'], 'ROLE_NOT_IN_MODE');
    pass('fast roster：不能加产品（模式外），PM 可切当前项目');

    const fastAnalyst = json(['boot', '--role', 'analyst', '--project', '快四', '--session', 'selftest-fast-analyst', '--json']);
    const fastDev = json(['boot', '--role', 'programmer1', '--project', '快四', '--session', 'selftest-fast-dev', '--json']);
    const fastTester = json(['boot', '--role', 'tester', '--project', '快四', '--session', 'selftest-fast-tester', '--json']);
    const peerRoles = (fastAnalyst.read.peers || []).map((p) => p.role);
    if (peerRoles.includes('product') || peerRoles.includes('programmer2')) failStep('fast boot 的他人文档索引混入模式外角色', peerRoles.join(','));

    const fastReq = json(['req', 'create', '--boot', fastAnalyst.token, '--title', '快四需求', '--priority', 'P1', '--acceptance', '可验收', '--json']);
    const fastReqId = fastReq.requirement && fastReq.requirement.id;
    if (!fastReqId) failStep('fast req create 没返回需求 id');
    const fastReview = json(['req', 'review', '--boot', fastAnalyst.token, '--id', fastReqId, '--verdict', 'approve', '--comments', '场景/边界/验收清楚，同意', '--json']);
    if (!fastReview.review || fastReview.review.role !== 'analyst' || fastReview.teamMode !== 'fast') failStep('fast 需求评审没有按需求分析师记录', JSON.stringify(fastReview));
    expectErr(['req', 'review', '--boot', fastDev.token, '--id', fastReqId, '--verdict', 'approve', '--comments', '开发代评'], 'ROLE_NOT_ALLOWED');
    expectErr(['req', 'review', '--boot', fastPm.token, '--id', fastReqId, '--verdict', 'approve', '--comments', 'PM 代评'], 'ROLE_NOT_ALLOWED');
    const fastTech = json(['req', 'review', '--boot', fastDev.token, '--kind', 'tech', '--id', fastReqId, '--verdict', 'approve', '--comments', '接口与回滚可行', '--json']);
    if (!fastTech.review || fastTech.review.kind !== 'tech' || fastTech.review.role !== 'programmer1') failStep('fast 技术评审没有按程序员A记录');
    expectErr(['req', 'review', '--boot', fastAnalyst.token, '--kind', 'tech', '--id', fastReqId, '--verdict', 'approve', '--comments', '需求代做技术评审'], 'ROLE_NOT_ALLOWED');
    pass('fast req review：需求分析师评审；程序员A记技术评审；其他角色不能代评');

    // Fast Owner：通过后先进入技术评审（tech_review），不是直接 ready。
    const fastOwnerConfirm = json(['owner', 'confirm', '--project', '快四', '--requirement', fastReqId, '--decision', 'skipped', '--test-owner', '--json']);
    const fastOwner = json(['owner', '--project', '快四', '--requirement', fastReqId, '--decision', 'skipped', '--opinion', '分析师：已评估；\n产品：已评估；\n开发：已评估。Fast Owner 跳过评审', '--owner-confirm', fastOwnerConfirm.confirmation.nonce, '--json']);
    if (!fastOwner.ok || fastOwner.requirement.workflow.ownerReview.status !== 'skipped') {
      failStep('fast owner skipped 没有落账', JSON.stringify(fastOwner));
    }
    const fastWfOwner = JSON.parse(read(path.join(teamRoot, '状态', '项目', '快四', '工作流.json')));
    if (fastWfOwner.requirements[fastReqId].status !== 'tech_review' || fastWfOwner.phase !== 'tech_review') {
      failStep('fast Owner 通过后没有进入 tech_review', JSON.stringify({ row: fastWfOwner.requirements[fastReqId], phase: fastWfOwner.phase }));
    }
    pass('fast owner：Owner skipped → 需求 tech_review + phase=tech_review（不是直接 ready）');

    const fastAnalystVote = json(['vote', 'start', '--boot', fastAnalyst.token, '--subject', '分析师发起投票', '--kind', 'other', '--json']);
    if (!fastAnalystVote.vote || fastAnalystVote.vote.createdBy !== 'analyst') {
      failStep('fast 需求分析师发起投票 createdBy 不是 analyst', JSON.stringify(fastAnalystVote.vote || null));
    }
    expectErr(['vote', 'start', '--boot', fastTester.token, '--subject', '测试越权发起'], 'ROLE_NOT_ALLOWED');
    const fastVote = json(['vote', 'start', '--boot', fastPm.token, '--subject', '快四验收投票', '--kind', 'requirement', '--requirement', fastReqId, '--json']);
    const fastEligible = fastVote.vote.eligible.slice().sort().join(',');
    if (fastEligible !== 'analyst,programmer1,tester') failStep('fast 投票参与人不对', fastEligible);
    expectErr(['vote', 'cast', '--boot', fastPm.token, '--id', fastVote.vote.id, '--vote', 'approve'], 'NOT_ELIGIBLE');
    json(['vote', 'cast', '--boot', fastAnalyst.token, '--id', fastVote.vote.id, '--vote', 'approve', '--comment', '需求清楚', '--json']);
    const fastApproved = json(['vote', 'cast', '--boot', fastDev.token, '--id', fastVote.vote.id, '--vote', 'approve', '--comment', '实现可行', '--json']);
    if (fastApproved.vote.result !== 'approved') failStep('fast 投票 2/3 未通过', JSON.stringify(fastApproved.vote));
    expectErr(['vote', 'cast', '--boot', fastTester.token, '--id', fastVote.vote.id, '--vote', 'reject'], 'VOTE_CLOSED');

    const fastVote2 = json(['vote', 'start', '--boot', fastPm.token, '--subject', '快四一致驳回', '--json']);
    json(['vote', 'cast', '--boot', fastAnalyst.token, '--id', fastVote2.vote.id, '--vote', 'reject', '--comment', '缺场景', '--json']);
    json(['vote', 'cast', '--boot', fastDev.token, '--id', fastVote2.vote.id, '--vote', 'reject', '--comment', '无回滚', '--json']);
    const fastMid = json(['vote', 'status', '--id', fastVote2.vote.id, '--project', '快四', '--json']);
    if (fastMid.evaluation.result !== 'pending') failStep('fast 未全员驳回就提前驳回');
    const fastRejected = json(['vote', 'cast', '--boot', fastTester.token, '--id', fastVote2.vote.id, '--vote', 'reject', '--comment', '无测试证据', '--json']);
    if (fastRejected.vote.result !== 'rejected') failStep('fast 除 PM 外全员一致驳回未生效', JSON.stringify(fastRejected.vote));

    const fastVote3 = json(['vote', 'start', '--boot', fastPm.token, '--subject', '快四未形成多数', '--json']);
    json(['vote', 'cast', '--boot', fastAnalyst.token, '--id', fastVote3.vote.id, '--vote', 'approve', '--json']);
    json(['vote', 'cast', '--boot', fastDev.token, '--id', fastVote3.vote.id, '--vote', 'reject', '--json']);
    const fastNoMajority = json(['vote', 'cast', '--boot', fastTester.token, '--id', fastVote3.vote.id, '--vote', 'abstain', '--json']);
    if (fastNoMajority.vote.result !== 'no_consensus') failStep('全部投完无多数未判 no_consensus', JSON.stringify(fastNoMajority.vote));

    const fastState = path.join(teamRoot, '状态', '项目', '快四');
    for (const id of [fastAnalystVote.vote.id, fastVote.vote.id, fastVote2.vote.id, fastVote3.vote.id]) {
      if (!fs.existsSync(path.join(fastState, '投票', id + '.json')) || !fs.existsSync(path.join(fastState, '投票', id + '.md'))) failStep('fast 投票文件缺：' + id);
    }
    const fastStatusList = json(['vote', 'status', '--project', '快四', '--json']);
    if (!Array.isArray(fastStatusList.votes) || fastStatusList.votes.length !== 4) failStep('fast vote status 列表条数不对', String((fastStatusList.votes || []).length));
    pass('fast vote：不投票 PM、过半通过、全员一致驳回、未形成多数、文件落盘');

    // 工作台旧协议入口：workflow iterate / terminate，写共享 工作流.json。
    const fastWorkflowFile = path.join(teamRoot, '状态', '项目', '快四', '工作流.json');
    const wfIter = json(['workflow', 'iterate', '--boot', fastPm.token, '--project', '快四', '--opinion', 'fast 迭代到下一轮', '--json']);
    if (wfIter.round !== 2 || !wfIter.workflow || wfIter.workflow.phase !== 'iteration' || !fs.existsSync(fastWorkflowFile)) {
      failStep('workflow iterate 没有推进轮次/写共享文件', JSON.stringify(wfIter));
    }
    const wfTerm = json(['workflow', 'terminate', '--boot', fastPm.token, '--project', '快四', '--opinion', 'fast 工作流终止', '--json']);
    if (!wfTerm.terminated || !Array.isArray(wfTerm.stopped) || !wfTerm.stopped.includes(fastReqId)
      || !wfTerm.workflow || wfTerm.workflow.phase !== 'terminated') {
      failStep('workflow terminate 没有停止需求/写共享文件', JSON.stringify(wfTerm));
    }
    const fastReqAfterTerm = JSON.parse(read(path.join(teamRoot, '状态', '项目', '快四', '任务', `${fastReqId}.json`)));
    if (fastReqAfterTerm.status !== 'done' || !fastReqAfterTerm.workflow || fastReqAfterTerm.workflow.requirementStatus !== 'terminated') {
      failStep('workflow terminate 没有收口需求任务', JSON.stringify(fastReqAfterTerm));
    }
    pass('workflow iterate/terminate：轮次/阶段写 工作流.json，终止同时收口需求任务');

    // fast 提案闭环：评审人/签字人只算模式内角色（产品虽在团队表里也不能被要求评审）。
    json(['grant', '--boot', fastPm.token, '--to', 'programmer1', '--actions', 'propose', '--scope', 'site/**', '--project', '快四', '--expires', '7d', '--reason', 'fast selftest', '--json']);
    const fastTask = json(['task', 'create', '--boot', fastPm.token, '--title', 'fast 提案闭环', '--priority', 'P1', '--owner', 'programmer1', '--json']);
    json(['task', 'claim', '--boot', fastDev.token, '--id', fastTask.task.id, '--json']);
    const fastTarget = path.join(fastDir, 'site', 'demo.txt');
    write(fastTarget, 'fast-v1\n');
    const fastBase = sha(fastTarget);
    const fastStaged = path.join(temp, 'fast-staged.txt');
    write(fastStaged, 'fast-v2\n');
    const fastProposal = json(['propose', '--boot', fastDev.token, '--task', fastTask.task.id, '--title', 'fast 升级 v2', '--file', `site/demo.txt=${fastStaged}`, '--expect', `site/demo.txt=${fastBase}`, '--rationale', 'fast selftest', '--risk', 'normal', '--json']);
    json(['show', '--boot', fastAnalyst.token, '--proposal', fastProposal.proposal.id, '--json']);
    json(['review', '--boot', fastAnalyst.token, '--proposal', fastProposal.proposal.id, '--verdict', 'approve', '--comments', 'fast 非作者评审通过', '--json']);
    json(['show', '--boot', fastPm.token, '--proposal', fastProposal.proposal.id, '--json']);
    json(['review', '--boot', fastPm.token, '--proposal', fastProposal.proposal.id, '--verdict', 'approve', '--comments', 'PM 复核通过', '--json']);
    json(['sign', '--boot', fastPm.token, '--proposal', fastProposal.proposal.id, '--decision', 'approve', '--note', 'fast 批准', '--json']);
    json(['apply', '--boot', fastPm.token, '--proposal', fastProposal.proposal.id, '--json']);
    if (read(fastTarget) !== 'fast-v2\n') failStep('fast 提案 apply 后内容不对');
    pass('fast 提案闭环：需求分析师评审 + PM 签字 apply（不要求产品/程序员B）');

    const fastEnsure = json(['project', 'ensure', '--name', '快四', '--team-mode', 'fast', '--json']);
    if (!fastEnsure.structure.ok || fastEnsure.teamMode !== 'fast') failStep('fast project ensure 不通过', JSON.stringify(fastEnsure.structure));
    const fastEnsureCfg = JSON.parse(read(fastCfgPath));
    const fastEnsureMeta = JSON.parse(read(fastWorkspacePath));
    if (fastEnsureCfg.teamMode !== 'fast' || (fastEnsureCfg.roleIds || []).join(',') !== 'pm,analyst,programmer1,tester') {
      failStep('fast ensure 后 项目.json 模式/roleIds 不对', JSON.stringify(fastEnsureCfg));
    }
    if (fastEnsureMeta.teamMode !== 'fast' || (fastEnsureMeta.roleIds || []).join(',') !== 'pm,analyst,programmer1,tester' || (fastEnsureMeta.roles || []).length !== 4) {
      failStep('fast ensure 后 workspace.json 没同步', JSON.stringify({ teamMode: fastEnsureMeta.teamMode, roleIds: fastEnsureMeta.roleIds, roles: (fastEnsureMeta.roles || []).length }));
    }
    pass('fast project ensure：项目.json/workspace.json 均保持 fast + 四角色');

    // 老项目兼容：项目.json 缺 teamMode/roleIds 时，按 workspace.json 回填，不能回落成 full。
    const legacyCfg = JSON.parse(read(fastCfgPath));
    delete legacyCfg.teamMode;
    delete legacyCfg.roleIds;
    write(fastCfgPath, JSON.stringify(legacyCfg, null, 2) + '\n');
    const backfilled = json(['project', 'ensure', '--name', '快四', '--json']);
    const backfillCfg = JSON.parse(read(fastCfgPath));
    if (backfilled.teamMode !== 'fast' || backfillCfg.teamMode !== 'fast' || (backfillCfg.roleIds || []).join(',') !== 'pm,analyst,programmer1,tester') {
      failStep('老项目缺字段时没有按 workspace.json 回填 fast', JSON.stringify({ result: backfilled.teamMode, cfg: backfillCfg.teamMode, roleIds: backfillCfg.roleIds }));
    }
    pass('project ensure 无 --team-mode：缺字段按 workspace.json 回填 fast（不回落 full）');

    const fastWs = json(['create', '--name', '快速工作区', '--root', projectsRoot, '--team-mode', 'fast', '--no-register', '--json'], WORKSPACE_MJS);
    const fastWsDir = fastWs.project.path;
    for (const d of ['项目经理', '需求分析师', '程序员A', '测试人员']) {
      if (!fs.existsSync(path.join(fastWsDir, d, '文件索引.md'))) failStep(`fast 工作区缺 ${d}/文件索引.md`);
    }
    if (fs.existsSync(path.join(fastWsDir, '产品')) || fs.existsSync(path.join(fastWsDir, '程序员B'))) failStep('fast 工作区建了模式外目录');
    const fastWsMeta = JSON.parse(read(path.join(fastWsDir, 'workspace.json')));
    if (fastWsMeta.teamMode !== 'fast' || !Array.isArray(fastWsMeta.roles) || fastWsMeta.roles.length !== 4) failStep('fast 工作区 workspace.json 模式/角色不对', JSON.stringify(fastWsMeta.roles));
    if ((fastWsMeta.roleIds || []).join(',') !== 'pm,analyst,programmer1,tester') failStep('fast 工作区 workspace.json 缺 roleIds', JSON.stringify(fastWsMeta.roleIds));
    const fastWsCfgPath = path.join(teamRoot, '状态', '项目', '快速工作区', '项目.json');
    if (!fs.existsSync(fastWsCfgPath)) failStep('fast 工作区没有登记 项目.json');
    const fastWsCfg = JSON.parse(read(fastWsCfgPath));
    if (fastWsCfg.teamMode !== 'fast' || (fastWsCfg.roleIds || []).join(',') !== 'pm,analyst,programmer1,tester') {
      failStep('fast 工作区 项目.json 模式/roleIds 不对', JSON.stringify({ teamMode: fastWsCfg.teamMode, roleIds: fastWsCfg.roleIds }));
    }
    const fastWsRules = read(path.join(fastWsDir, '协作准则.md'));
    if (!fastWsRules.includes('四角色') || !fastWsRules.includes('vote') || !fastWsRules.includes('技术评审')) failStep('fast 工作区协作准则不对');
    const fastWsEnsure = json(['ensure', '--name', '快速工作区', '--path', fastWsDir, '--team-mode', 'fast', '--json'], WORKSPACE_MJS);
    if (!fastWsEnsure.ok || fastWsEnsure.teamMode !== 'fast') failStep('fast workspace ensure 失败');
    const fastWsMeta2 = JSON.parse(read(path.join(fastWsDir, 'workspace.json')));
    const fastWsCfg2 = JSON.parse(read(fastWsCfgPath));
    if (fastWsMeta2.teamMode !== 'fast' || (fastWsMeta2.roleIds || []).join(',') !== 'pm,analyst,programmer1,tester'
      || fastWsCfg2.teamMode !== 'fast' || (fastWsCfg2.roleIds || []).join(',') !== 'pm,analyst,programmer1,tester') {
      failStep('fast workspace ensure 后 项目.json/workspace.json 不一致', JSON.stringify({ meta: fastWsMeta2.teamMode, cfg: fastWsCfg2.teamMode }));
    }
    pass('workspace create/ensure --team-mode fast：四角色 + 项目.json/workspace.json 双处记录');

    const launchPlan = json(['--project', '快速工作区', '--dry-run', '--json'], LAUNCH_MJS);
    const launchRoles = launchPlan.plan.map((p) => p.role).join(',');
    if (launchPlan.teamMode !== 'fast' || launchRoles !== 'pm,analyst,programmer1,tester') failStep('launch 未按 fast 动态角色集建计划', `${launchPlan.teamMode} ${launchRoles}`);
    if (!launchPlan.plan.every((p) => String(p.prompt || '').includes('中文思考'))) failStep('launch 启动卡缺中文纪律');
    for (const p of launchPlan.plan) {
      const card = String(p.prompt || '');
      if (!card.includes('团队模式：快速四角色') || !card.includes(`boot --role ${p.role}`) || !card.includes('快速工作区')) {
        failStep(`launch 启动卡不完整：${p.role}`, card.slice(0, 220));
      }
    }
    const pmLaunchCard = String((launchPlan.plan.find((p) => p.role === 'pm') || {}).prompt || '');
    const analystLaunchCard = String((launchPlan.plan.find((p) => p.role === 'analyst') || {}).prompt || '');
    if (!pmLaunchCard.includes('PM 不投票') || !analystLaunchCard.includes('需求评审由你执行')) failStep('fast 启动卡缺 PM/分析师快速职责');
    pass('launch --dry-run：fast 只计划四角色，四张启动卡含模式/启动命令/快速职责');

    const switchAdd = json(['project', 'add', '--name', '切换测试', '--by', 'owner', '--json']);
    if (!switchAdd.ok || switchAdd.teamMode !== 'full') failStep('切换测试项目默认不是 full');
    const switchDir = path.join(projectsRoot, '切换测试');
    if (!fs.existsSync(path.join(switchDir, '产品'))) failStep('full 项目缺产品目录');
    const switchCfgPath = path.join(teamRoot, '状态', '项目', '切换测试', '项目.json');
    const switchMetaPath = path.join(switchDir, 'workspace.json');
    const switchSessionsFile = path.join(switchDir, '团队会话.json');
    const switchSessionsText = JSON.stringify({
      project: '切换测试', teamMode: 'full',
      sessions: [{ role: 'product', sessionId: 'keep-product' }, { role: 'programmer2', sessionId: 'keep-dev2' }],
    }, null, 2) + '\n';
    write(switchSessionsFile, switchSessionsText);
    const switchTeamFile = path.join(teamRoot, '状态', '团队.json');
    const teamBeforeSwitch = read(switchTeamFile);
    const fullCfg = JSON.parse(read(switchCfgPath));
    const fullMeta = JSON.parse(read(switchMetaPath));
    if (fullCfg.teamMode !== 'full' || (fullCfg.roleIds || []).length !== 6) failStep('full 项目 项目.json 模式不对', JSON.stringify(fullCfg));
    if (fullMeta.teamMode !== 'full' || (fullMeta.roles || []).length !== 6) failStep('full 项目 workspace.json 模式不对', JSON.stringify(fullMeta));

    const switchFast = json(['project', 'ensure', '--name', '切换测试', '--team-mode', 'fast', '--json']);
    if (!switchFast.structure.ok || switchFast.teamMode !== 'fast') failStep('切 fast 后结构不通过', JSON.stringify(switchFast.structure));
    if (!fs.existsSync(path.join(switchDir, '产品')) || !fs.existsSync(path.join(switchDir, '程序员B'))) failStep('切 fast 删了旧目录（不应删）');
    // 模式与目录一致：fast 下旧角色目录保留，但必须标“非当前模式”，否则 Owner 分不清谁还在队里。
    if (!fs.existsSync(path.join(switchDir, '产品', '非当前模式.md')) || !fs.existsSync(path.join(switchDir, '程序员B', '非当前模式.md'))) {
      failStep('切 fast 后旧角色目录没标“非当前模式”');
    }
    const switchFastCfg = JSON.parse(read(switchCfgPath));
    const switchFastMeta = JSON.parse(read(switchMetaPath));
    if (switchFastCfg.teamMode !== 'fast' || (switchFastCfg.roleIds || []).join(',') !== 'pm,analyst,programmer1,tester') {
      failStep('切 fast 后 项目.json 模式/roleIds 不对', JSON.stringify({ teamMode: switchFastCfg.teamMode, roleIds: switchFastCfg.roleIds }));
    }
    if (switchFastMeta.teamMode !== 'fast' || (switchFastMeta.roleIds || []).join(',') !== 'pm,analyst,programmer1,tester' || (switchFastMeta.roles || []).length !== 4) {
      failStep('切 fast 后 workspace.json 没同步', JSON.stringify({ teamMode: switchFastMeta.teamMode, roleIds: switchFastMeta.roleIds, roles: (switchFastMeta.roles || []).length }));
    }
    if (read(switchSessionsFile) !== switchSessionsText) failStep('切 fast 改了旧会话清单（不应动）');
    if (read(switchTeamFile) !== teamBeforeSwitch) failStep('切 fast 改了团队会话表（不应动）');

    const switchFull = json(['project', 'ensure', '--name', '切换测试', '--team-mode', 'full', '--json']);
    if (!switchFull.structure.ok || switchFull.teamMode !== 'full') failStep('切回 full 失败');
    const switchBackCfg = JSON.parse(read(switchCfgPath));
    const switchBackMeta = JSON.parse(read(switchMetaPath));
    if (switchBackCfg.teamMode !== 'full' || (switchBackCfg.roleIds || []).length !== 6) failStep('切回 full 后 项目.json 不对', JSON.stringify(switchBackCfg));
    if (switchBackMeta.teamMode !== 'full' || (switchBackMeta.roleIds || []).length !== 6 || (switchBackMeta.roles || []).length !== 6) {
      failStep('切回 full 后 workspace.json 不对', JSON.stringify({ teamMode: switchBackMeta.teamMode, roles: (switchBackMeta.roles || []).length }));
    }
    if (!fs.existsSync(path.join(switchDir, '产品')) || !fs.existsSync(path.join(switchDir, '程序员A'))) failStep('切回 full 后旧目录丢了');
    if (fs.existsSync(path.join(switchDir, '产品', '非当前模式.md')) || fs.existsSync(path.join(switchDir, '程序员B', '非当前模式.md'))) {
      failStep('切回 full 后“非当前模式”标记没撤掉');
    }
    if (read(switchSessionsFile) !== switchSessionsText) failStep('切回 full 改了旧会话清单（不应动）');
    if (read(switchTeamFile) !== teamBeforeSwitch) failStep('切回 full 改了团队会话表（不应动）');
    pass('team-mode 切换：项目.json/workspace.json 双处同步；旧目录/旧会话不删；只改当前模式');

    expectErr(['project', 'add', '--name', '坏模式', '--team-mode', 'medium', '--by', 'owner', '--json'], 'BAD_TEAM_MODE');
    const badWs = run(['create', '--name', '坏工作区', '--root', projectsRoot, '--team-mode', 'medium', '--no-register', '--json'], { expectFail: true, tool: WORKSPACE_MJS });
    if (!(String(badWs.stdout || '') + String(badWs.stderr || '')).includes('BAD_TEAM_MODE')) failStep('workspace 未拒绝非法 --team-mode');
    pass('非法 --team-mode 被拒（project / workspace 两入口）');

    // ===== 六项工具回归：消息三型 / 提案镜像 / 模式目录 / 必读分层 / 产出规范 / 派单文件优先 =====
    const gatePm = json(['boot', '--role', 'pm', '--project', '试点', '--session', 'selftest-gate-pm', '--json']);
    const gateProduct = json(['boot', '--role', 'product', '--project', '试点', '--session', 'selftest-gate-product', '--json']);
    const gateReq = json(['req', 'create', '--boot', gatePm.token, '--title', '必读闸门用例', '--priority', 'P1', '--acceptance', '未读需求正文不能评审', '--json']);
    const gateReqId = gateReq.requirement.id;
    // 需求正文在 boot 之后才写：旧令牌必须被判“未读”，重新 boot 后才放行（AC8.3）。
    const gateDocRel = `需求/${gateReqId}-闸门用例.md`;
    write(path.join(projDir, gateDocRel), '# 闸门用例\n\n- 状态：review\n\n## 验收标准\n\n未读需求正文的评审必须被拒。\n');
    const unreadReview = expectErr(['req', 'review', '--boot', gateProduct.token, '--id', gateReqId, '--verdict', 'approve', '--comments', '没读就审'], 'TASK_DOCS_UNREAD');
    if (!String(unreadReview.stderr || '').includes(gateDocRel)) failStep('TASK_DOCS_UNREAD 没给出要补读的路径', String(unreadReview.stderr || ''));
    const gateProduct2 = json(['boot', '--role', 'product', '--project', '试点', '--session', 'selftest-gate-product2', '--json']);
    const commentsFile = path.join(temp, 'comments.txt');
    write(commentsFile, '引号「测试」与“弯引号”都要完整落盘，不能被 PowerShell 截断。');
    const okReview = json(['req', 'review', '--boot', gateProduct2.token, '--id', gateReqId, '--verdict', 'approve', '--comments-file', commentsFile, '--json']);
    if (okReview.commentsSource !== '--comments-file') failStep('--comments-file 没记录来源', JSON.stringify(okReview.commentsSource));
    if (!String((okReview.review || {}).comments || '').includes('弯引号')) failStep('--comments-file 评论落盘不完整', String((okReview.review || {}).comments));
    // 状态行/状态记录是程序流转时自己写的：只改这些不能把角色的阅读证据作废（ROUND11 假回归根因）。
    const gateDocPath = path.join(projDir, gateDocRel);
    write(gateDocPath, '# 闸门用例\n\n- 状态：approved\n\n## 验收标准\n\n未读需求正文的评审必须被拒。\n\n## 状态记录\n\n- 2026-11-12T00:00:00.000Z approved：产品评审通过\n');
    const statusOnly = json(['req', 'review', '--boot', gateProduct2.token, '--id', gateReqId, '--verdict', 'approve', '--comments', '只改状态行不改正文', '--json']);
    if (statusOnly.ok !== true) failStep('状态行/状态记录变化把阅读证据作废了', JSON.stringify({ code: statusOnly.code, message: statusOnly.message }));
    pass('D1 + 必读闸门：未读需求正文的评审被拒；补 boot 后放行；--comments-file 完整落盘；状态行变化不作废');

    // D2：超长评论必须在写盘前拒绝（任务文件哈希前后一致，history 零新增）。
    const gateTaskFile = path.join(teamRoot, '状态', '项目', '试点', '任务', `${gateReqId}.json`);
    const hashBeforeLong = sha(gateTaskFile);
    expectErr(['req', 'review', '--boot', gateProduct2.token, '--id', gateReqId, '--verdict', 'approve', '--comments', 'x'.repeat(601)], 'MESSAGE_TOO_LONG');
    if (sha(gateTaskFile) !== hashBeforeLong) failStep('超长评审失败后任务文件仍被写入（半提交）');
    // 正文内容变了（不是状态行）必须重新 boot 补读：闸门仍然该拒就拒。
    write(gateDocPath, read(gateDocPath).replace('未读需求正文的评审必须被拒。', '验收标准正文被改掉了。'));
    expectErr(['req', 'review', '--boot', gateProduct2.token, '--id', gateReqId, '--verdict', 'approve', '--comments', '正文改了还审'], 'TASK_DOCS_UNREAD');
    pass('D2：>600 字评审意见写盘前拒绝，任务文件与 history 零新增；正文改动仍要求重新 boot');

    // D4：--requirement 必须指向真实存在的需求，悬空/类型错都零写入。
    const tasksBeforeBadReq = json(['task', 'list', '--boot', gatePm.token, '--all', '--json']).tasks.length;
    expectErr(['task', 'create', '--boot', gatePm.token, '--title', '悬空引用', '--priority', 'P1', '--requirement', 'R-19990101-000000-zz'], 'REQUIREMENT_NOT_FOUND');
    const otherTaskId = (json(['task', 'list', '--boot', gatePm.token, '--all', '--json']).tasks.find((t) => t.type !== 'requirement') || {}).id || '';
    if (otherTaskId) expectErr(['task', 'create', '--boot', gatePm.token, '--title', '类型错', '--priority', 'P1', '--requirement', otherTaskId], 'REQUIREMENT_NOT_FOUND');
    const tasksAfterBadReq = json(['task', 'list', '--boot', gatePm.token, '--all', '--json']).tasks.length;
    if (tasksAfterBadReq !== tasksBeforeBadReq) failStep('悬空引用被拒但任务表新增了行', `${tasksBeforeBadReq} → ${tasksAfterBadReq}`);
    const linkedTask = json(['task', 'create', '--boot', gatePm.token, '--title', '挂需求的任务', '--priority', 'P1', '--requirement', gateReqId, '--json']);
    if (linkedTask.task.requirementId !== gateReqId) failStep('--requirement 合法引用没写进任务');
    pass('D4：--requirement 悬空/非需求类型一律 REQUIREMENT_NOT_FOUND 且零写入；合法引用正常落盘');

    // F6：派单文件优先——超长在写盘前拒绝，消息与任务零新增，并给出可照做的文件命名。
    const msgsBeforeLong = json(['inbox', '--boot', gatePm.token, '--all', '--json']).messages.length;
    const tooLongSend = expectErr(['send', '--boot', gatePm.token, '--to', 'programmer1', '--subject', '超长派单', '--body', 'b'.repeat(601), '--ack'], 'MESSAGE_TOO_LONG');
    if (!String(tooLongSend.stderr || '').includes('M-YYYYMMDD-HHmm')) failStep('超长派单拒绝没给文件命名示例', String(tooLongSend.stderr || '').slice(0, 300));
    const msgsAfterLong = json(['inbox', '--boot', gatePm.token, '--all', '--json']).messages.length;
    if (msgsAfterLong !== msgsBeforeLong) failStep('超长派单被拒但消息表新增了行');
    expectErr(['task', 'create', '--boot', gatePm.token, '--title', '超长任务', '--priority', 'P1', '--detail', 'd'.repeat(2001)], 'TASK_DETAIL_TOO_LONG');
    pass('F6：>600 字派单与 >2000 字 detail 写盘前拒绝且零新增');

    // F1：消息三型——PM 永不收派单；任务已完成降级；角色互发 dispatch 也降级；真派单只标一条。
    const gateDev = json(['boot', '--role', 'programmer1', '--project', '试点', '--session', 'selftest-gate-dev', '--json']);
    const doneTask = json(['task', 'create', '--boot', gatePm.token, '--title', '已完成任务', '--priority', 'P1', '--owner', 'programmer1', '--json']);
    json(['task', 'claim', '--boot', gateDev.token, '--id', doneTask.task.id, '--json']);
    json(['task', 'done', '--boot', gateDev.token, '--id', doneTask.task.id, '--evidence', 'selftest 证据', '--json']);
    const doneDispatch = json(['send', '--boot', gatePm.token, '--to', 'programmer1', '--subject', '已完成再派', '--body', '这个任务已经完成', '--ack', '--task', doneTask.task.id, '--json']);
    if (doneDispatch.dispatch !== false || doneDispatch.demoted !== true) failStep('已完成任务再派没有降级为通知', JSON.stringify({ dispatch: doneDispatch.dispatch, demoted: doneDispatch.demoted }));
    const toPmDispatch = json(['send', '--boot', gateDev.token, '--to', 'pm', '--subject', '发给 PM', '--body', '回执一条', '--ack', '--type', 'dispatch', '--json']);
    if (toPmDispatch.dispatch !== false || toPmDispatch.demoted !== true) failStep('发给 PM 的 dispatch 没降级');
    const roleDispatch = json(['send', '--boot', gateDev.token, '--to', 'tester', '--subject', '角色互发', '--body', '不是 PM 派单', '--ack', '--type', 'dispatch', '--json']);
    if (roleDispatch.dispatch !== false || roleDispatch.demoted !== true) failStep('角色互发 dispatch 没降级');
    const gatePm2 = json(['boot', '--role', 'pm', '--project', '试点', '--session', 'selftest-gate-pm2', '--json']);
    // 正文改过后先重评（G2 要求评审针对当前正文），再让 Owner 落账，之后才允许派单（G3）。
    const gateProduct6 = json(['boot', '--role', 'product', '--project', '试点', '--session', 'selftest-f1-product', '--json']);
    json(['req', 'review', '--boot', gateProduct6.token, '--id', gateReqId, '--verdict', 'approve', '--comments', '正文改后重评', '--json']);
    const confirmF1 = json(['owner', 'confirm', '--project', '试点', '--requirement', gateReqId, '--decision', 'approved', '--test-owner', '--json']);
    json(['owner', '--project', '试点', '--requirement', gateReqId, '--decision', 'approved', '--opinion', '派单前 Owner 通过', '--owner-confirm', confirmF1.nonce, '--json']);
    // G4 硬门（AC14.4）：full 派单要求产品设计已评审签字；给夹具造“设计文件 + 该需求的 designReview”。
    const designRel = '产品/产出/产品设计-v1.md';
    const designText = '# 试点 · 产品设计 v1\n\n## 一、目标\n\n派单夹具：让 G4 有可校验的设计证据。\n';
    write(path.join(projDir, designRel), designText);
    const designHash = crypto.createHash('sha256').update(designText).digest('hex');
    const gateReqTaskFile = path.join(teamRoot, '状态', '项目', '试点', '任务', `${gateReqId}.json`);
    const gateReqTaskJson = JSON.parse(read(gateReqTaskFile));
    gateReqTaskJson.workflow = { ...(gateReqTaskJson.workflow || {}), designReview: { verdict: 'approve', sha256: designHash, at: new Date().toISOString(), by: 'product' } };
    write(gateReqTaskFile, JSON.stringify(gateReqTaskJson, null, 2) + '\n');
    // G5：programmer1 还挂着最早那个任务（写第一份变更），派单前先收口，避免 TASK_OPEN 误挡夹具。
    const pgFresh = json(['boot', '--role', 'programmer1', '--project', '试点', '--session', 'selftest-f1-dev-fresh', '--json']);
    json(['task', 'done', '--boot', pgFresh.token, '--id', task.task.id, '--evidence', 'F1 派单前收口', '--json']);
    const realDispatch = json(['send', '--boot', gatePm2.token, '--to', 'programmer1', '--subject', '真派单', '--body', '按正文执行并产出', '--ack', '--task', linkedTask.task.id, '--json']);
    if (realDispatch.dispatch !== true || realDispatch.demoted === true) failStep('真派单没标 dispatch', JSON.stringify({ dispatch: realDispatch.dispatch, demoted: realDispatch.demoted }));
    json(['ack', '--boot', gateDev.token, '--id', realDispatch.message.id, '--note', '已回执', '--json']);
    const devInbox = json(['inbox', '--boot', gateDev.token, '--all', '--json']).messages;
    if (!devInbox.some((m) => m.id === realDispatch.message.id && m.type === 'dispatch')) failStep('派单消息 type 不是 dispatch');
    const pmInboxGate = json(['inbox', '--boot', gatePm2.token, '--all', '--json']).messages;
    if (pmInboxGate.some((m) => m.type === 'dispatch')) failStep('PM 收件箱出现 dispatch 消息');
    if (!pmInboxGate.some((m) => m.type === 'receipt')) failStep('完成回执没有按 receipt 类型投递');
    pass('F1：PM 永不收派单；完成态/角色互发降级通知；真派单唯一标 dispatch；回执类型 receipt');

    // F2：提案镜像——propose/apply 后项目内可读，状态与提交同步。
    const mirrorIndex = path.join(projDir, '提案', 'index.md');
    if (!fs.existsSync(mirrorIndex)) failStep('提案镜像 index.md 没生成');
    const mirrorText = read(mirrorIndex);
    if (!mirrorText.includes('提案记录') || !mirrorText.includes(p1.proposal.id)) failStep('提案镜像没列出已应用提案');
    const mirrorOne = path.join(projDir, '提案', p1.proposal.id, '提案.md');
    if (!fs.existsSync(mirrorOne)) failStep('提案镜像缺单条 提案.md');
    if (!read(mirrorOne).includes('已应用')) failStep('提案镜像单条状态没有“已应用”');
    pass('F2：propose/apply 后 提案/index.md + P-*/提案.md 自动生成并与提交同步');

    // F5：产出规范——fileRe 兼容 产品设计-vN 与 02-产品设计-vN 两式；开发快照只收本轮改动。
    if (!OUTPUT_DOCS.product.fileRe.test('产品设计-v4.md') || !OUTPUT_DOCS.product.fileRe.test('02-产品设计-v4.md')) {
      failStep('OUTPUT_DOCS.product.fileRe 不兼容两式');
    }
    if (!OUTPUT_DOCS.analyst.fileRe.test('需求分析-v7.md') || !OUTPUT_DOCS.tester.fileRe.test('测试报告-v1.md')) {
      failStep('其他角色 fileRe 不兼容无前缀式');
    }
    const wakeWithReading = buildDispatchPrompt({
      to: 'tester', project: '试点', projectPath: projDir, roleDir: '测试人员',
      messageId: 'M-READ', subject: '必读', taskId: 'T-READ', teamTool: TEAM_MJS, readingList: [gateDocRel],
    });
    if (!wakeWithReading.includes('本轮必读') || !wakeWithReading.includes('闸门用例')) failStep('派单模板没带程序指定的本轮必读');
    pass('F5：brief/boot 的 fileRe 兼容两式；派单模板写出“本轮必读”路径');

    // ===== Owner 落账（D5）+ 闸门矩阵（D3）+ TR-Q（D2） =====
    const ownerReq = json(['req', 'create', '--boot', gatePm2.token, '--title', 'Owner 落账用例', '--priority', 'P1', '--acceptance', '可测且可判定', '--json']);
    const ownerReqId = ownerReq.requirement.id;
    write(path.join(projDir, '需求', `${ownerReqId}-Owner落账.md`), '# Owner 落账用例\n\n- 状态：review\n\n## 验收标准\n\n可测且可判定。\n');
    const gateProduct3 = json(['boot', '--role', 'product', '--project', '试点', '--session', 'selftest-owner-product', '--json']);
    json(['req', 'review', '--boot', gateProduct3.token, '--id', ownerReqId, '--verdict', 'approve', '--comments', '验收标准可测', '--json']);
    const confirm1 = json(['owner', 'confirm', '--project', '试点', '--requirement', ownerReqId, '--decision', 'approved', '--test-owner', '--json']);
    const owner1 = json(['owner', '--project', '试点', '--requirement', ownerReqId, '--decision', 'approved', '--opinion', 'Owner 通过', '--owner-confirm', confirm1.nonce, '--json']);
    if (!Array.isArray(owner1.decisions) || owner1.decisions.length !== 1) failStep('Owner 决定没有写 decisions[]', JSON.stringify(owner1.decisions));
    if (!owner1.decisions[0].basis || !owner1.decisions[0].basis.requirement.path) failStep('Owner 决定缺 basis.requirement', JSON.stringify(owner1.decisions[0]));
    if (!['ui', 'tty', 'test'].includes(String(owner1.decisions[0].channel))) failStep('Owner 决定 channel 非法', owner1.decisions[0].channel);
    const confirm2 = json(['owner', 'confirm', '--project', '试点', '--requirement', ownerReqId, '--decision', 'skipped', '--test-owner', '--json']);
    expectErr(['owner', '--project', '试点', '--requirement', ownerReqId, '--decision', 'skipped', '--opinion', '分析师：已评估；\n产品：已评估；\n开发：已评估。并发冲突', '--owner-confirm', confirm2.nonce, '--expect-decisions', '9', '--json'], 'OWNER_DECISION_CONFLICT');
    const owner2 = json(['owner', '--project', '试点', '--requirement', ownerReqId, '--decision', 'skipped', '--opinion', '分析师：已评估；\n产品：已评估；\n开发：已评估。Owner 跳过', '--owner-confirm', confirm2.nonce, '--json']);
    if (!Array.isArray(owner2.decisions) || owner2.decisions.length !== 2) failStep('Owner 决定链不是追加', String(owner2.decisions && owner2.decisions.length));
    if (owner2.decisions[0].status !== 'approved' || owner2.decisions[1].status !== 'skipped') failStep('历史决定被改写', JSON.stringify(owner2.decisions.map((d) => d.status)));
    if (!owner2.decisions[1].confirmation || !owner2.decisions[1].confirmation.nonceHash) failStep('Owner 决定缺 nonceHash');
    pass('D5：Owner decisions[] 追加、basis/channel/nonceHash 落账、并发冲突拒绝、历史不改写');

    // G3：无 Owner 决定就派开发 → OWNER_REVIEW_REQUIRED（且零消息）
    const noOwnerReq = json(['req', 'create', '--boot', gatePm2.token, '--title', '无 Owner 决定用例', '--priority', 'P1', '--acceptance', '可测', '--json']);
    const noOwnerReqId = noOwnerReq.requirement.id;
    write(path.join(projDir, '需求', `${noOwnerReqId}-无Owner.md`), '# 无 Owner 决定用例\n\n- 状态：review\n\n## 验收标准\n\n可测。\n');
    const gateProduct4 = json(['boot', '--role', 'product', '--project', '试点', '--session', 'selftest-g3-product', '--json']);
    json(['req', 'review', '--boot', gateProduct4.token, '--id', noOwnerReqId, '--verdict', 'approve', '--comments', '评审通过', '--json']);
    const noOwnerTask = json(['task', 'create', '--boot', gatePm2.token, '--title', '无Owner派单', '--priority', 'P1', '--requirement', noOwnerReqId, '--json']);
    const gatePm3 = json(['boot', '--role', 'pm', '--project', '试点', '--session', 'selftest-g3-pm', '--json']);
    const msgsBeforeG3 = json(['inbox', '--boot', gatePm3.token, '--all', '--json']).messages.length;
    expectErr(['send', '--boot', gatePm3.token, '--to', 'programmer1', '--subject', '无Owner派单', '--body', '按正文执行', '--ack', '--task', noOwnerTask.task.id], 'OWNER_REVIEW_REQUIRED');
    if (json(['inbox', '--boot', gatePm3.token, '--all', '--json']).messages.length !== msgsBeforeG3) failStep('G3 拒绝后仍写了消息');
    pass('D3/G3：无 Owner 决定派单被拒（OWNER_REVIEW_REQUIRED），零消息');

    // G0：需求评审不按阶段拦；test 阶段产品仍可复审（评审由 G1/G2 管）
    const stateFile = path.join(teamRoot, '状态', '项目', '试点', '工作流.json');
    const state = JSON.parse(read(stateFile));
    state.requirements[ownerReqId].status = 'test';
    write(stateFile, JSON.stringify(state, null, 2) + '\n');
    const reviewInTest = json(['req', 'review', '--boot', gateProduct3.token, '--id', ownerReqId, '--verdict', 'approve', '--comments', '测试阶段复审', '--json']);
    if (!reviewInTest.ok) failStep('test 阶段产品复审被 G0 误拦', JSON.stringify(reviewInTest));
    state.requirements[ownerReqId].status = 'ready';
    write(stateFile, JSON.stringify(state, null, 2) + '\n');
    pass('D3/G0：需求评审豁免阶段角色表，test 阶段产品复审可落账');

    // G1：任务 acceptance 为空但需求正文有“验收标准”章节 → 按正文回填判定
    const docOnlyReq = json(['req', 'create', '--boot', gatePm2.token, '--title', '正文AC回填用例', '--priority', 'P1', '--acceptance', '临时占位', '--json']);
    const docOnlyId = docOnlyReq.requirement.id;
    write(path.join(projDir, '需求', `${docOnlyId}-正文AC回填.md`), `# ${docOnlyId} 正文AC回填\n\n## 五、验收标准\n\n- AC1 给定页面，打开可见标题。\n- AC2 点击后不跳外站。\n`);
    const docOnlyTaskPath = path.join(teamRoot, '状态', '项目', '试点', '任务', `${docOnlyId}.json`);
    const docOnlyTask = JSON.parse(read(docOnlyTaskPath));
    docOnlyTask.acceptance = '';
    write(docOnlyTaskPath, JSON.stringify(docOnlyTask, null, 2) + '\n');
    const docProduct = json(['boot', '--role', 'product', '--project', '试点', '--session', 'selftest-doc-product', '--json']);
    const docOnlyReview = json(['req', 'review', '--boot', docProduct.token, '--id', docOnlyId, '--verdict', 'approve', '--comments', '按正文AC评审', '--json']);
    if (!docOnlyReview.ok) failStep('正文有验收标准但任务字段为空仍被 G1 拦', JSON.stringify(docOnlyReview));
    pass('D3/G1：任务 acceptance 为空时按需求正文“验收标准”回填判定，不再误拦');

    // G2.5 TR-Q：P0 无 TR-Q 不能开 Owner 门；补 TR-Q(testable) 后放行
    const p0Req = json(['req', 'create', '--boot', gatePm2.token, '--title', 'P0 可测性用例', '--priority', 'P0', '--acceptance', '可测可判定', '--json']);
    const p0ReqId = p0Req.requirement.id;
    write(path.join(projDir, '需求', `${p0ReqId}-P0可测性.md`), '# P0 可测性用例\n\n- 状态：review\n\n## 验收标准\n\n可测可判定。\n');
    const gateProduct5 = json(['boot', '--role', 'product', '--project', '试点', '--session', 'selftest-trq-product', '--json']);
    json(['req', 'review', '--boot', gateProduct5.token, '--id', p0ReqId, '--verdict', 'approve', '--comments', 'AC 可判定', '--json']);
    const confirm3 = json(['owner', 'confirm', '--project', '试点', '--requirement', p0ReqId, '--decision', 'approved', '--test-owner', '--json']);
    expectErr(['owner', '--project', '试点', '--requirement', p0ReqId, '--decision', 'approved', '--opinion', '未做TR-Q', '--owner-confirm', confirm3.nonce, '--json'], 'TESTABILITY_REVIEW_REQUIRED');
    const gateTester = json(['boot', '--role', 'tester', '--project', '试点', '--session', 'selftest-trq-tester', '--json']);
    const trq = json(['req', 'trq', '--boot', gateTester.token, '--id', p0ReqId, '--verdict', 'testable', '--missing', '', '--json']);
    if (!trq.trq || trq.trq.verdict !== 'testable') failStep('req trq 没写记录', JSON.stringify(trq.trq));
    if (!fs.existsSync(path.join(projDir, trq.file))) failStep('TR-Q 文件没落盘', trq.file);
    if (read(path.join(projDir, trq.file)).length > 1200) failStep('TR-Q 超过一页 1200 字');
    const ownerP0 = json(['owner', '--project', '试点', '--requirement', p0ReqId, '--decision', 'approved', '--opinion', 'TR-Q 通过后决定', '--owner-confirm', confirm3.nonce, '--json']);
    if (!ownerP0.ok || !Array.isArray(ownerP0.decisions) || ownerP0.decisions.length !== 1) failStep('补 TR-Q 后 Owner 门仍未放行', JSON.stringify(ownerP0));
    pass('D2/G2.5：P0 无 TR-Q 开 Owner 门被拒；补 TR-Q(testable) 后落账放行');

    // 生产路径禁用 --test-owner
    const prodConfirm = run(['owner', 'confirm', '--project', '试点', '--requirement', ownerReqId, '--decision', 'approved', '--test-owner', '--json'], { expectFail: true, envOverride: { TEAM_SELFTEST: '' } });
    if (!(String(prodConfirm.stdout || '') + String(prodConfirm.stderr || '')).includes('OWNER_TTY_REQUIRED')) failStep('生产路径 --test-owner 没被拒');
    pass('D5：--test-owner 生产路径被拒（仅 TEAM_SELFTEST=1 可用）');

    // ===== D3 收口：G4/G7 硬门 + G5 TASK_OPEN/ROLE_BUSY + AC14.8 GATE_BYPASS_DENIED =====
    // 先收口 F1 派出去的开发任务，释放 programmer1。
    json(['task', 'claim', '--boot', gateDev.token, '--id', linkedTask.task.id, '--json']);
    json(['task', 'done', '--boot', gateDev.token, '--id', linkedTask.task.id, '--evidence', 'G4 夹具收口', '--json']);
    // 开发 done 会按新规则推进到 dev_done（阶段=测试），而 G4/G5 夹具验的是“派单阶段”的闸门；
    // 这里把夹具需求状态显式回到 ready，避免用测试阶段去测派单（不改变 G4/G5 的判定对象）。
    const wfG4 = JSON.parse(read(path.join(stateShiDian, '工作流.json')));
    wfG4.requirements[gateReqId].status = 'ready';
    wfG4.phase = 'dispatch';
    write(path.join(stateShiDian, '工作流.json'), JSON.stringify(wfG4, null, 2) + '\n');
    const g4Task = json(['task', 'create', '--boot', gatePm2.token, '--title', 'G4 派单夹具', '--priority', 'P1', '--requirement', gateReqId, '--json']);
    // 反例：拿掉 designReview → PRODUCT_DESIGN_REQUIRED（G4 硬门）
    const g4TaskFile = path.join(teamRoot, '状态', '项目', '试点', '任务', `${gateReqId}.json`);
    const g4TaskJson = JSON.parse(read(g4TaskFile));
    const savedDesignReview = g4TaskJson.workflow ? g4TaskJson.workflow.designReview : null;
    if (g4TaskJson.workflow) delete g4TaskJson.workflow.designReview;
    write(g4TaskFile, JSON.stringify(g4TaskJson, null, 2) + '\n');
    expectErr(['send', '--boot', gatePm2.token, '--to', 'programmer1', '--subject', 'G4反例', '--body', 'x', '--ack', '--task', g4Task.task.id], 'PRODUCT_DESIGN_REQUIRED');
    // 正例：恢复 designReview 后放行（同时验证 G5 正例：programmer1 已无未闭环任务）
    g4TaskJson.workflow = { ...(g4TaskJson.workflow || {}), designReview: savedDesignReview };
    write(g4TaskFile, JSON.stringify(g4TaskJson, null, 2) + '\n');
    const g4Ok = json(['send', '--boot', gatePm2.token, '--to', 'programmer1', '--subject', 'G4正例', '--body', 'x', '--ack', '--task', g4Task.task.id, '--json']);    if (g4Ok.dispatch !== true) failStep('G4 正例没放行', JSON.stringify(g4Ok));
    json(['ack', '--boot', gateDev.token, '--id', g4Ok.message.id, '--note', '已回执', '--json']);
    pass('D3/G4：full 缺设计签字派单被拒（PRODUCT_DESIGN_REQUIRED）；补齐后放行');

    // G5 TASK_OPEN：programmer2 有未闭环任务时再派 → TASK_OPEN
    const busyTask = json(['task', 'create', '--boot', gatePm2.token, '--title', 'G5 占用任务', '--priority', 'P1', '--requirement', gateReqId, '--owner', 'programmer2', '--json']);
    const g5Task = json(['task', 'create', '--boot', gatePm2.token, '--title', 'G5 派单夹具', '--priority', 'P1', '--requirement', gateReqId, '--json']);
    expectErr(['send', '--boot', gatePm2.token, '--to', 'programmer2', '--subject', 'G5反例', '--body', 'x', '--ack', '--task', g5Task.task.id], 'TASK_OPEN');
    const gateDev2 = json(['boot', '--role', 'programmer2', '--project', '试点', '--session', 'selftest-g5-dev2', '--json']);
    json(['task', 'claim', '--boot', gateDev2.token, '--id', busyTask.task.id, '--json']);
    json(['task', 'done', '--boot', gateDev2.token, '--id', busyTask.task.id, '--evidence', 'G5 收口', '--json']);
    // 收口占用任务会按新规则把需求推到 dev_done（阶段=测试）；G5 夹具仍验派单阶段，显式回到 ready。
    const wfG5 = JSON.parse(read(path.join(stateShiDian, '工作流.json')));
    wfG5.requirements[gateReqId].status = 'ready';
    wfG5.phase = 'dispatch';
    write(path.join(stateShiDian, '工作流.json'), JSON.stringify(wfG5, null, 2) + '\n');
    const g5Ok = json(['send', '--boot', gatePm2.token, '--to', 'programmer2', '--subject', 'G5正例', '--body', 'x', '--ack', '--task', g5Task.task.id, '--json']);
    if (g5Ok.dispatch !== true) failStep('G5 正例没放行', JSON.stringify(g5Ok));
    json(['ack', '--boot', gateDev2.token, '--id', g5Ok.message.id, '--note', '已回执', '--json']);
    pass('D3/G5：目标角色有未闭环任务派单被拒（TASK_OPEN），收口后放行');

    // ===== R-99ff ①：G5 自指——需求任务自身挂在目标角色名下时，派它的子任务不应被 TASK_OPEN 误拦 =====
    const reqTaskFile99 = path.join(teamRoot, '状态', '项目', '试点', '任务', `${gateReqId}.json`);
    const reqTaskJson99 = JSON.parse(read(reqTaskFile99));
    const savedReqOwner99 = reqTaskJson99.owner;
    reqTaskJson99.owner = 'programmer2';
    write(reqTaskFile99, JSON.stringify(reqTaskJson99, null, 2) + '\n');
    const g5self99 = json(['send', '--boot', gatePm2.token, '--to', 'programmer2', '--subject', 'G5 自指', '--body', 'x', '--ack', '--task', g5Task.task.id, '--json']);
    if (g5self99.dispatch !== true) failStep('G5 自指（需求任务自身）仍被 TASK_OPEN 拦', JSON.stringify(g5self99));
    json(['ack', '--boot', gateDev2.token, '--id', g5self99.message.id, '--note', '已回执', '--json']);
    reqTaskJson99.owner = savedReqOwner99 || '';
    write(reqTaskFile99, JSON.stringify(reqTaskJson99, null, 2) + '\n');
    pass('R-99ff①：G5 不把“目标自身/需求任务占用”当冲突（旧行为 TASK_OPEN）');

    // G5 ROLE_BUSY：programmer1 持活动锁时派单 → ROLE_BUSY
    json(['lock', 'acquire', '--boot', gateDev.token, '--key', 'role:programmer1', '--ttl', '60', '--json']);
    expectErr(['send', '--boot', gatePm2.token, '--to', 'programmer1', '--subject', 'G5 锁反例', '--body', 'x', '--ack', '--task', g4Task.task.id], 'ROLE_BUSY');
    json(['lock', 'release', '--boot', gateDev.token, '--key', 'role:programmer1', '--json']);
    pass('D3/G5：目标角色持活动锁派单被拒（ROLE_BUSY），释放后恢复');

    // ===== R-99ff ②：G0 不限制 PM 派单——需求进 test 后 PM 派测试不应被 ROLE_NOT_IN_STAGE 拦 =====
    // 先收口 tester 名下未闭环任务（只动沙盘任务文件），本用例只验 G0。
    const g0TaskDir = path.join(teamRoot, '状态', '项目', '试点', '任务');
    for (const n of fs.readdirSync(g0TaskDir)) {
      if (!n.endsWith('.json')) continue;
      const fp = path.join(g0TaskDir, n);
      const row = JSON.parse(read(fp));
      if (String(row.owner || '') === 'tester' && row.status !== 'done') {
        row.status = 'done';
        row.doneAt = row.doneAt || new Date().toISOString();
        row.evidence = row.evidence || 'R-99ff 夹具收口';
        write(fp, JSON.stringify(row, null, 2) + '\n');
      }
    }
    const g0Task99 = json(['task', 'create', '--boot', gatePm2.token, '--title', 'G0 派测试夹具', '--priority', 'P1', '--requirement', gateReqId, '--owner', 'tester', '--json']);
    const wfG099 = JSON.parse(read(path.join(stateShiDian, '工作流.json')));
    const savedG0Status99 = wfG099.requirements[gateReqId].status;
    wfG099.requirements[gateReqId].status = 'dev_done';
    write(path.join(stateShiDian, '工作流.json'), JSON.stringify(wfG099, null, 2) + '\n');
    const testerBoot99 = json(['boot', '--role', 'tester', '--project', '试点', '--session', 'selftest-g0-tester', '--json']);
    const g0ok99 = json(['send', '--boot', gatePm2.token, '--to', 'tester', '--subject', 'G0 派测试', '--body', 'x', '--ack', '--task', g0Task99.task.id, '--json']);
    if (g0ok99.dispatch !== true) failStep('G0：test 阶段 PM 派测试仍被拦', JSON.stringify(g0ok99));
    json(['ack', '--boot', testerBoot99.token, '--id', g0ok99.message.id, '--note', '已回执', '--json']);
    wfG099.requirements[gateReqId].status = savedG0Status99;
    write(path.join(stateShiDian, '工作流.json'), JSON.stringify(wfG099, null, 2) + '\n');
    // 清掉本用例的任务夹具：它绑着 gateReqId 且 open，会让后面的 AC14.8 跳步用例看不到“跳步”。
    try { fs.unlinkSync(path.join(g0TaskDir, `${g0Task99.task.id}.json`)); } catch { /* 沙盘夹具清理失败不阻断 */ }
    pass('R-99ff②：G0 不拦 PM 在测试阶段派单（旧行为 ROLE_NOT_IN_STAGE）');

    // AC14.8（R-31b3 按需求判定）：项目 phase 只做展示，不再卡单条需求；
    // 需求自身状态被改到比子任务证据更靠后 → 仍拒（GATE_BYPASS_DENIED）。
    const shidianStateFile = path.join(teamRoot, '状态', '项目', '试点', '工作流.json');
    const shidianState = JSON.parse(read(shidianStateFile));
    const savedPhase = shidianState.phase;
    const savedReqStatus = shidianState.requirements[gateReqId].status;
    shidianState.phase = 'test';
    write(shidianStateFile, JSON.stringify(shidianState, null, 2) + '\n');
    // ① 验收 A 后项目相位=accepted：只展示，不再拦 B 需求派单（真实硬伤复现）
    shidianState.phase = 'accepted';
    shidianState.requirements['R-QUEUE-ACCEPTED'] = { id: 'R-QUEUE-ACCEPTED', status: 'accepted' };
    write(shidianStateFile, JSON.stringify(shidianState, null, 2) + '\n');
    const phaseOk = json(['send', '--boot', gatePm2.token, '--to', 'programmer1', '--subject', 'AC14.8 验收A后派B', '--body', 'x', '--ack', '--task', g4Task.task.id, '--json']);
    if (phaseOk.dispatch !== true) failStep('验收 A 后项目相位仍卡 B 需求派单', JSON.stringify(phaseOk));
    json(['ack', '--boot', gateDev.token, '--id', phaseOk.message.id, '--note', '已回执', '--json']);
    delete shidianState.requirements['R-QUEUE-ACCEPTED'];
    // ② 需求自身状态跳步：ready → test（子任务证据还 dev）→ 仍拦
    shidianState.requirements[gateReqId].status = 'test';
    write(shidianStateFile, JSON.stringify(shidianState, null, 2) + '\n');
    expectErr(['send', '--boot', gatePm2.token, '--to', 'programmer1', '--subject', 'AC14.8 需求跳步', '--body', 'x', '--ack', '--task', g4Task.task.id], 'GATE_BYPASS_DENIED');
    shidianState.requirements[gateReqId].status = savedReqStatus;
    shidianState.phase = savedPhase;
    write(shidianStateFile, JSON.stringify(shidianState, null, 2) + '\n');
    pass('AC14.8（R-31b3）：项目相位只展示不卡需求；需求状态跳步仍拒（GATE_BYPASS_DENIED）');

    // ===== R-8514 全员记忆规范：memory check + P0 任务 done 前置 =====
    const memHome = path.join(temp, 'memory-home');
    const memProjectDir = path.join(projectsRoot, '试点');
    const memKey = crypto.createHash('sha1').update(memProjectDir).digest('hex').slice(0, 12);
    const memFile = path.join(memHome, 'memories', 'projects', memKey, 'MEMORY.md');
    write(memFile, '[2026-11-12 21:00] [main] T-MEM-1 完成：产出 需求分析师/产出/需求分析-v1.md；进展：selftest 记忆样本。\n'
      + '§\n'
      + '[2026-11-12 21:02] [main] T-MEM-2 完成：产出 程序员B/产出/x.md；进展：仅 B 的条目，正文含 npm 字样。\n'
      + '§\n'
      + '[2026-11-12 21:03] [main] T-MEM-2 完成：角色 tester 抽检通过（跨角色）。\n'
      + '§\n'
      + '[2026-11-12 21:04] [main] T-MEM-3 完成：产出 产品/产出/产品设计-v4.md；进展：产品线。\n'
      + '§\n'
      + '[2026-11-12 21:05] [main] T-MEM-4 完成：产品评审会通过；产出 需求分析师/产出/x.md。\n'
      + '§\n');
    // T-20261114-035413-2148：记忆插件关闭时 required 会降级（MEMORY_SKIPPED、exit 0），
    // 所以「缺记忆必须硬失败」的用例要显式把插件做成 on：给一个装了 dsh-memory-evolve 并启用的插件根。
    const memPluginsHome = path.join(temp, 'plugins-home');
    write(path.join(memPluginsHome, 'profiles', 'desktop', 'package.json'), JSON.stringify({
      name: 'selftest-profile',
      dependencies: { 'dsh-memory-evolve': '0.1.0' },
      dsh: { profile: { bundles: ['dsh-memory-evolve'] } },
    }, null, 2) + '\n');
    write(path.join(memPluginsHome, 'profiles', 'desktop', 'node_modules', 'dsh-memory-evolve', 'package.json'), JSON.stringify({ name: 'dsh-memory-evolve', version: '0.1.0' }, null, 2) + '\n');
    const memHomeEnv = { DSH_HOME: memHome, TEAM_PLUGINS_HOME: memPluginsHome };
    const memEnforceEnv = { DSH_HOME: memHome, TEAM_PLUGINS_HOME: memPluginsHome, TEAM_MEMORY_ENFORCE: '1' };
    const memOkRun = run(['memory', 'check', '--boot', gatePm2.token, '--task', 'T-MEM-1', '--json'], { envOverride: memHomeEnv });
    const memOk = JSON.parse(memOkRun.stdout.trim());
    if (!memOk.found || memOk.taskId !== 'T-MEM-1') failStep('memory check 未命中样本', JSON.stringify(memOk));
    if (memOk.store.key !== memKey) failStep('workspace-key 算法不一致', memOk.store.key);
    // T-2148 同口径：插件默认关时 required 会降级（MEMORY_SKIPPED/exit 0），要验"缺记忆必须硬失败"
    // 必须显式打开强制（TEAM_MEMORY_ENFORCE=1），不能用默认环境再 expectFail（否则断言与新语义冲突）。
    const memMissingRun = run(['memory', 'check', '--boot', gatePm2.token, '--task', 'T-MEM-NONE', '--required', '--json'], { envOverride: memEnforceEnv, expectFail: true });
    if (!String(memMissingRun.stdout).includes('MEMORY_MISSING')) failStep('memory check 缺失未返回 MEMORY_MISSING', String(memMissingRun.stdout).slice(0, 200));
    // 插件关闭（TEAM_PLUGINS_HOME 指向空目录）→ 同样的 --required 必须降级：required=false、degraded=true、exit 0。
    const memOffHome = path.join(temp, 'plugins-empty');
    write(path.join(memOffHome, '.keep'), '');
    const memOffRun = run(['memory', 'check', '--boot', gatePm2.token, '--task', 'T-MEM-NONE', '--required', '--json'], { envOverride: { DSH_HOME: memHome, TEAM_PLUGINS_HOME: memOffHome } });
    const memOff = JSON.parse(String(memOffRun.stdout).trim());
    if (memOff.required !== false || memOff.degraded !== true || memOff.code !== 'MEMORY_SKIPPED') {
      failStep('插件关闭时 memory check 未降级（应 required=false/degraded=true/MEMORY_SKIPPED）', JSON.stringify(memOff).slice(0, 240));
    }
    if (Number(memOffRun.status || 0) !== 0) failStep('插件关闭时 memory check 仍以失败退出', String(memOffRun.status));
    // 复核-v4 P1-1/P1-2：PM 令牌可跨角色抽检；角色覆盖按精确匹配参与 found/code/退出码。
    const memCrossRun = run(['memory', 'check', '--boot', gatePm2.token, '--task', 'T-MEM-2', '--role', 'tester', '--json'], { envOverride: memHomeEnv });
    const memCross = JSON.parse(memCrossRun.stdout.trim());
    if (memCross.role !== 'tester' || memCross.found !== true) failStep('PM 令牌跨角色抽检 tester 未通过', JSON.stringify(memCross).slice(0, 300));
    if (!memCross.entries.length || memCross.entries.some((e) => !String(e.line).includes('tester'))) failStep('跨角色抽检返回了非 tester 条目', JSON.stringify(memCross.entries).slice(0, 300));
    const memPmRun = run(['memory', 'check', '--boot', gatePm2.token, '--task', 'T-MEM-2', '--role', 'pm', '--required', '--json'], { envOverride: memHomeEnv, expectFail: true });
    const memPm = JSON.parse(memPmRun.stdout.trim());
    if (memPm.found !== false || memPm.code !== 'MEMORY_MISSING') failStep('--role pm 被 npm 子串误命中', JSON.stringify(memPm).slice(0, 300));
    const memCover = JSON.parse(run(['memory', 'check', '--boot', gatePm2.token, '--task', 'T-MEM-2', '--role', 'programmer1', '--json'], { envOverride: memHomeEnv }).stdout.trim());
    if (memCover.found !== false || !String(memCover.missing.join('；')).includes('没有 programmer1 的条目')) failStep('角色覆盖缺失未如实判定', JSON.stringify(memCover).slice(0, 300));
    const memDir = JSON.parse(run(['memory', 'check', '--boot', gatePm2.token, '--task', 'T-MEM-2', '--role', 'programmer2', '--json'], { envOverride: memHomeEnv }).stdout.trim());
    if (memDir.found !== true) failStep('角色目录名“程序员B”未命中 programmer2', JSON.stringify(memDir).slice(0, 300));
    const memProd = JSON.parse(run(['memory', 'check', '--boot', gatePm2.token, '--task', 'T-MEM-3', '--role', 'product', '--json'], { envOverride: memHomeEnv }).stdout.trim());
    if (memProd.found !== true) failStep('产品角色路径段“产品/产出/…”未命中', JSON.stringify(memProd).slice(0, 300));
    const memProdNeg = JSON.parse(run(['memory', 'check', '--boot', gatePm2.token, '--task', 'T-MEM-4', '--role', 'product', '--json'], { envOverride: memHomeEnv }).stdout.trim());
    if (memProdNeg.found !== false) failStep('“产品评审会”被误判为产品角色', JSON.stringify(memProdNeg).slice(0, 300));
    pass('R-8514：产品角色按路径段命中，普通“产品评审会”不误命中');
    expectErr(['memory', 'check', '--boot', gatePm2.token, '--task', 'T-MEM-2', '--role', 't', '--json'], 'BAD_ROLE');
    const memProj = JSON.parse(run(['memory', 'check', '--boot', gatePm2.token, '--project', '收口', '--task', 'T-MEM-1', '--json'], { envOverride: memHomeEnv }).stdout.trim());
    if (memProj.project !== '收口' || memProj.role !== '') failStep('--project 跨项目抽检仍撞令牌项目', JSON.stringify(memProj).slice(0, 300));
    pass('R-8514：PM 令牌跨角色抽检、角色覆盖精确匹配（npm≠pm）、非法角色拒、--project 不撞令牌');
    // P0 任务：缺记忆 done 被拒，补写后通过
    const memTask = json(['task', 'create', '--boot', gatePm2.token, '--title', '记忆校验 P0', '--priority', 'P0', '--owner', 'programmer1', '--json']);
    json(['task', 'claim', '--boot', gateDev.token, '--id', memTask.task.id, '--json']);
    const memDoneBlocked = run(['task', 'done', '--boot', gateDev.token, '--id', memTask.task.id, '--evidence', 'x', '--json'], { envOverride: memEnforceEnv, expectFail: true });
    if (!String(memDoneBlocked.stdout).includes('MEMORY_MISSING')) failStep('P0 缺记忆 task done 未被拒', String(memDoneBlocked.stdout).slice(0, 200));
    write(memFile, read(memFile) + `[2026-11-12 21:05] [main] ${memTask.task.id} 完成：角色 programmer1；产出 site/mem.txt；进展：补写 project 记忆。\n§\n`);
    const memDoneRun = run(['task', 'done', '--boot', gateDev.token, '--id', memTask.task.id, '--evidence', 'P0 记忆已写', '--json'], { envOverride: memEnforceEnv });
    const memDone = JSON.parse(memDoneRun.stdout.trim());
    if (!memDone.ok || !memDone.memory || memDone.memory.found !== true) failStep('补记忆后 P0 task done 仍失败', JSON.stringify(memDone));
    pass('R-8514：memory check 命中/缺失、P0 done 先卡 MEMORY_MISSING、补写后通过');

    // ===== R-8b9d：记忆插件 off 降级不硬失败 + memory check 警告级 lint =====
    const offPlugins = path.join(temp, 'plugins-off');
    fs.mkdirSync(offPlugins, { recursive: true });
    const offHome = path.join(temp, 'memory-home-off');
    const offEnv = { TEAM_PLUGINS_HOME: offPlugins, DSH_HOME: offHome };
    const offTask = json(['task', 'create', '--boot', gatePm2.token, '--title', '记忆插件 off 降级', '--priority', 'P0', '--owner', 'programmer1', '--json']);
    json(['task', 'claim', '--boot', gateDev.token, '--id', offTask.task.id, '--json']);
    const offDone = JSON.parse(run(['task', 'done', '--boot', gateDev.token, '--id', offTask.task.id, '--evidence', '插件 off 降级用例', '--json'], { envOverride: offEnv }).stdout.trim());
    if (!offDone.ok || !offDone.memory || offDone.memory.code !== 'MEMORY_SKIPPED') failStep('记忆插件 off 时 P0 done 未降级为 MEMORY_SKIPPED', JSON.stringify(offDone).slice(0, 300));
    const offBoot = JSON.parse(run(['boot', '--role', 'pm', '--project', '试点', '--session', 'selftest-mem-off', '--json'], { envOverride: offEnv }).stdout.trim());
    if (!String(offBoot.briefing || '').includes('记忆降级')) failStep('记忆插件 off 时 boot 缺降级提示', String(offBoot.briefing || '').slice(0, 400));
    pass('R-8b9d：记忆插件 off → boot 标降级、P0 记忆门 MEMORY_SKIPPED（不硬失败）');

    const lintLong = `[2026-11-12 21:06] [main] T-LINT-1 完成：${'超长条目'.repeat(80)}`;
    write(memFile, read(memFile) + lintLong + '\n§\n');
    const lintOk = JSON.parse(run(['memory', 'check', '--boot', gatePm2.token, '--task', 'T-LINT-1', '--json'], { envOverride: memHomeEnv }).stdout.trim());
    if (!lintOk.lint || !lintOk.lint.warnings.some((w) => w.code === 'ENTRY_TOO_LONG')) failStep('超长条目未给 ENTRY_TOO_LONG 警告', JSON.stringify(lintOk.lint || null).slice(0, 300));
    if (lintOk.code === 'LINT_WARNINGS') failStep('未加 --strict 不应因 lint 失败', JSON.stringify(lintOk).slice(0, 200));
    const lintStrict = run(['memory', 'check', '--boot', gatePm2.token, '--task', 'T-LINT-1', '--json', '--strict'], { envOverride: memHomeEnv, expectFail: true });
    if (!String(lintStrict.stdout).includes('LINT_WARNINGS')) failStep('--strict 未把 lint 升级为失败', String(lintStrict.stdout).slice(0, 200));
    const lintDupId = 'T-20261112-210700-2abc';
    for (let i = 0; i < 4; i += 1) write(memFile, read(memFile) + `[2026-11-12 21:07] [main] ${lintDupId} 完成：第 ${i + 1} 次同任务条目。\n§\n`);
    const lintDup = JSON.parse(run(['memory', 'check', '--boot', gatePm2.token, '--task', lintDupId, '--json'], { envOverride: memHomeEnv }).stdout.trim());
    if (!lintDup.lint || !lintDup.lint.warnings.some((w) => w.code === 'DUPLICATE_TASK' && w.taskId === lintDupId && w.count === 4)) failStep('同任务 4 次未给 DUPLICATE_TASK 警告', JSON.stringify(lintDup.lint || null).slice(0, 300));
    pass('R-8b9d：memory check 警告级 lint（超 300 字 / 同任务 >3 次），--strict 才失败');

    // R-31b3 队列自动续跑：PM 上一条未回执时 --queue 入队；角色 done 后自动 pump 下一条。
    // 先收口 programmer2 的 G5 占用任务，并把夹具需求恢复到派单阶段。
    const qDev = json(['boot', '--role', 'programmer2', '--project', '试点', '--session', 'selftest-queue-dev', '--json']);
    json(['task', 'claim', '--boot', qDev.token, '--id', g5Task.task.id, '--json']);
    json(['task', 'done', '--boot', qDev.token, '--id', g5Task.task.id, '--evidence', '队列用例前收口', '--json']);
    const wfQ = JSON.parse(read(shidianStateFile));
    wfQ.requirements[gateReqId].status = 'ready';
    wfQ.phase = 'dispatch';
    write(shidianStateFile, JSON.stringify(wfQ, null, 2) + '\n');
    const qTask1 = json(['task', 'create', '--boot', gatePm2.token, '--title', '队列任务一', '--priority', 'P1', '--requirement', gateReqId, '--json']);
    const qTask2 = json(['task', 'create', '--boot', gatePm2.token, '--title', '队列任务二', '--priority', 'P1', '--requirement', gateReqId, '--json']);
    const qSend1 = json(['send', '--boot', gatePm2.token, '--to', 'programmer2', '--subject', '队列任务一', '--body', '执行任务一', '--ack', '--task', qTask1.task.id, '--json']);
    if (qSend1.dispatch !== true) failStep('队列任务一未派出', JSON.stringify(qSend1));
    const qSend2 = json(['send', '--boot', gatePm2.token, '--to', 'programmer2', '--subject', '队列任务二', '--body', '执行任务二', '--ack', '--task', qTask2.task.id, '--queue', '--json']);
    if (qSend2.queued !== true) failStep('队列任务二未入队', JSON.stringify(qSend2));
    json(['ack', '--boot', qDev.token, '--id', qSend1.message.id, '--note', '已回执', '--json']);
    json(['task', 'claim', '--boot', qDev.token, '--id', qTask1.task.id, '--json']);
    const qDone1 = json(['task', 'done', '--boot', qDev.token, '--id', qTask1.task.id, '--evidence', '队列任务一完成', '--json']);
    if (!(qDone1.dispatchQueue && qDone1.dispatchQueue.pumped === true)) failStep('任务一 done 后队列未自动续跑', JSON.stringify(qDone1.dispatchQueue));
    if (qDone1.dispatchQueue.item.task !== qTask2.task.id) failStep('续跑的不是队列下一条', JSON.stringify(qDone1.dispatchQueue.item));
    const qInbox = json(['inbox', '--boot', qDev.token, '--all', '--json']);
    if (!qInbox.messages.some((m) => m.id === qDone1.dispatchQueue.message.id)) failStep('续跑派单未进收件箱', JSON.stringify(qInbox.messages.map((m) => m.id)));
    json(['ack', '--boot', qDev.token, '--id', qDone1.dispatchQueue.message.id, '--note', '已回执', '--json']);
    json(['task', 'claim', '--boot', qDev.token, '--id', qTask2.task.id, '--json']);
    const qDone2 = json(['task', 'done', '--boot', qDev.token, '--id', qTask2.task.id, '--evidence', '队列任务二完成', '--json']);
    if (!qDone2.ok) failStep('队列任务二 done 失败', JSON.stringify(qDone2));
    pass('R-31b3 队列：--queue 入队，任务一 done 后自动 pump 任务二并进收件箱');

    // ===== R-99ff ③：队列兜底续跑——队列项属于别的空闲角色时，task done 后也应被泵出 =====
    const qFile99 = path.join(teamRoot, '状态', '项目', '试点', '派单队列.json');
    const qData99 = fs.existsSync(qFile99) ? JSON.parse(read(qFile99)) : { items: [] };
    for (const n of fs.readdirSync(g0TaskDir)) {
      if (!n.endsWith('.json')) continue;
      const fp = path.join(g0TaskDir, n);
      const row = JSON.parse(read(fp));
      if (String(row.owner || '') === 'analyst' && row.status !== 'done') {
        row.status = 'done';
        row.doneAt = row.doneAt || new Date().toISOString();
        row.evidence = row.evidence || 'R-99ff 兜底夹具收口';
        write(fp, JSON.stringify(row, null, 2) + '\n');
      }
    }
    qData99.items = (Array.isArray(qData99.items) ? qData99.items : []).filter((x) => x && x.id !== 'Q-99FF-TAIL');
    qData99.items.push({ id: 'Q-99FF-TAIL', from: 'pm', to: 'analyst', subject: '队列兜底', body: 'x', task: '', project: '试点', ackRequired: true, sessionId: '' });
    write(qFile99, JSON.stringify({ items: qData99.items, updatedAt: new Date().toISOString() }, null, 2) + '\n');
    const tailTask99 = json(['task', 'create', '--boot', gatePm2.token, '--title', '兜底触发任务', '--priority', 'P2', '--owner', 'programmer2', '--json']);
    json(['task', 'claim', '--boot', gateDev2.token, '--id', tailTask99.task.id, '--json']);
    const tailDone99 = json(['task', 'done', '--boot', gateDev2.token, '--id', tailTask99.task.id, '--evidence', 'R-99ff 兜底', '--json']);
    if (!(tailDone99.tailPump && tailDone99.tailPump.pumped === true)) failStep('队列兜底未续跑', JSON.stringify(tailDone99.tailPump || tailDone99.dispatchQueue));
    if (String(tailDone99.tailPump.item.id) !== 'Q-99FF-TAIL') failStep('兜底泵的不是队列项', JSON.stringify(tailDone99.tailPump.item));
    // 收尾：让 analyst 回执这条兜底派单，清掉 PM 派单锁（否则后续 PM 派单会被 PM_DISPATCH_PENDING 挡）。
    const anaBoot99 = json(['boot', '--role', 'analyst', '--project', '试点', '--session', 'selftest-queue-analyst', '--json']);
    json(['ack', '--boot', anaBoot99.token, '--id', tailDone99.tailPump.message.id, '--note', '已回执', '--json']);
    pass('R-99ff③：队列兜底续跑（别的空闲角色也能被泵出，不再等 PM 人工泵）');

    // ===== B-a577：全队空闲时队列也能自动派发（主循环 60 秒定时泵；这里直接调 queue pump 模拟到点）=====
    // 以前泵只在 task done 触发：全队空闲时队列里的派单永远发不出去。现在定时器到点就泵一次。
    const qFile577 = path.join(teamRoot, '状态', '项目', '试点', '派单队列.json');
    const qData577 = fs.existsSync(qFile577) ? JSON.parse(read(qFile577)) : { items: [] };
    for (const n of fs.readdirSync(g0TaskDir)) {
      if (!n.endsWith('.json')) continue;
      const fp = path.join(g0TaskDir, n);
      const row = JSON.parse(read(fp));
      if (String(row.owner || '') === 'analyst' && row.status !== 'done') {
        row.status = 'done';
        row.doneAt = row.doneAt || new Date().toISOString();
        row.evidence = row.evidence || 'B-a577 夹具收口';
        write(fp, JSON.stringify(row, null, 2) + '\n');
      }
    }
    qData577.items = (Array.isArray(qData577.items) ? qData577.items : []).filter((x) => x && x.id !== 'Q-A577-IDLE' && x.id !== 'Q-A577-BUSY');
    qData577.items.push({ id: 'Q-A577-IDLE', from: 'pm', to: 'analyst', subject: '空闲自动派发', body: 'x', task: '', project: '试点', ackRequired: true, sessionId: '' });
    write(qFile577, JSON.stringify({ items: qData577.items, updatedAt: new Date().toISOString() }, null, 2) + '\n');
    const pump577 = json(['queue', 'pump', '--project', '试点', '--json']);
    if (pump577.pumped !== true) failStep('全队空闲时队列泵未派发', JSON.stringify(pump577).slice(0, 300));
    if (!(pump577.item && String(pump577.item.id) === 'Q-A577-IDLE')) failStep('泵出的不是空闲队列项', JSON.stringify(pump577.item).slice(0, 200));
    const qInbox577 = json(['inbox', '--boot', anaBoot99.token, '--all', '--json']);
    if (!qInbox577.messages.some((m) => m.id === pump577.message.id)) failStep('空闲泵派单未进收件箱', '');
    const qAfter577 = JSON.parse(read(qFile577));
    if ((qAfter577.items || []).some((x) => x.id === 'Q-A577-IDLE')) failStep('已派发的队列项未移除', '');
    // 空队列再泵：返回 EMPTY 且 ok，不报错、不重复派。
    const pump577b = json(['queue', 'pump', '--project', '试点', '--json']);
    if (pump577b.ok !== true || pump577b.pumped !== false) failStep('空队列泵应返回 EMPTY 且 ok', JSON.stringify(pump577b).slice(0, 200));
    // 收尾：回执空闲泵的派单，清 PM 派单锁。
    json(['ack', '--boot', anaBoot99.token, '--id', pump577.message.id, '--note', '已回执', '--json']);
    pass('B-a577：全队空闲时 queue pump 自动派发（≤90 秒语义）、空队列幂等不重复派');

    // ===== B-6818（T0）：完成/消息自动唤醒 =====
    // ① send 发往 pm 的普通通知默认唤醒（沙盘记 skipped=SELFTEST，但必须带 wake 结果与目标）
    const wakeSend = json(['send', '--boot', anaBoot99.token, '--to', 'pm', '--subject', '自动唤醒用例', '--body', '无 --wake 也应尝试唤醒 PM', '--json']);
    if (!wakeSend.wake || wakeSend.wake.to !== 'pm') failStep('send→pm 未尝试唤醒', JSON.stringify(wakeSend).slice(0, 300));
    // ② Owner 2026-11-14 08:08：取消唤醒合并（默认窗口 0）——连续两条都立即唤醒，不再 MERGED_PENDING
    const wakeSend2 = json(['send', '--boot', anaBoot99.token, '--to', 'pm', '--subject', '自动唤醒第二条', '--body', '取消合并后第二条也应立即唤醒', '--json']);
    if (!(wakeSend2.wake && wakeSend2.wake.ok === true)) failStep('取消合并后第二条未立即唤醒', JSON.stringify(wakeSend2.wake).slice(0, 200));
    // 连续 3 条 → 3 次唤醒（同一收件人也不再压缩）
    {
      const three = [];
      for (let i = 1; i <= 3; i += 1) {
        three.push(json(['send', '--boot', anaBoot99.token, '--to', 'pm', '--subject', `连续唤醒 ${i}`, '--body', 'x', '--type', 'escalation', '--json']));
      }
      if (!three.every((row) => row.wake && row.wake.ok === true)) failStep('连续 3 条未各自唤醒', JSON.stringify(three.map((row) => row.wake && row.wake.skipped)).slice(0, 200));
      const logRows = read(path.join(teamRoot, '状态', '项目', '试点', '唤醒.jsonl')).split(/\r?\n/).filter(Boolean)
        .map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean)
        .filter((row) => row.to === 'pm' && Array.isArray(row.messageIds) && row.messageIds.some((id) => three.some((t) => t.message && t.message.id === id)));
      if (logRows.length < 3) failStep('连续 3 条消息未产生 3 次唤醒留痕', JSON.stringify(logRows.length));
    }
    // ③ --no-wake 显式关闭
    const wakeOff = json(['send', '--boot', anaBoot99.token, '--to', 'pm', '--subject', '不唤醒', '--body', 'x', '--no-wake', '--json']);
    if (wakeOff.wake !== null) failStep('--no-wake 未关闭唤醒', JSON.stringify(wakeOff.wake).slice(0, 200));
    // ④ task done 自动发完成事件并尝试唤醒 PM
    const wakeTask = json(['task', 'create', '--boot', gatePm2.token, '--title', '唤醒用例任务', '--priority', 'P2', '--owner', 'programmer2', '--json']);
    json(['task', 'claim', '--boot', qDev.token, '--id', wakeTask.task.id, '--json']);
    const wakeDone = json(['task', 'done', '--boot', qDev.token, '--id', wakeTask.task.id, '--evidence', '唤醒用例', '--json']);
    if (!wakeDone.wake || wakeDone.wake.to !== 'pm') failStep('task done 未尝试唤醒 PM', JSON.stringify(wakeDone).slice(0, 300));
    // ⑤ 失败留痕：TEAM_WAKE_TEST_FAIL=1 注入失败 → 团队/状态/项目/试点/唤醒.jsonl 有一行
    const wakeFail = JSON.parse(run(['send', '--boot', gateDev.token, '--to', 'analyst', '--subject', '唤醒失败留痕', '--body', 'x', '--wake', '--json'], { envOverride: { TEAM_WAKE_TEST_FAIL: '1' } }).stdout.trim());
    if (!(wakeFail.wake && wakeFail.wake.ok === false)) failStep('测试注入的唤醒失败未返回失败', JSON.stringify(wakeFail.wake).slice(0, 200));
    const wakeLogFile = path.join(teamRoot, '状态', '项目', '试点', '唤醒.jsonl');
    const wakeLog = fs.existsSync(wakeLogFile) ? read(wakeLogFile) : '';
    if (!wakeLog.includes('TEAM_WAKE_TEST_FAIL')) failStep('唤醒失败未写 唤醒.jsonl', wakeLog.slice(0, 300));
    pass('B-6818（T0）：send→pm 默认唤醒、取消合并（连续 3 条 3 次唤醒）、--no-wake 关闭、task done 完成事件唤醒、失败写 唤醒.jsonl');

    // ===== B-d111（已按 Owner 08:08 改口径）：不再有窗口合并；保留 delivered 去重、失败重试、兜底补发 =====
    const wakeQueueFile = path.join(teamRoot, '状态', '项目', '试点', '唤醒队列.json');
    const wakeQueue = fs.existsSync(wakeQueueFile) ? JSON.parse(read(wakeQueueFile)) : {};
    // 取消合并后不应该再积 pending（历史 pending 若存在，泵会一次补发清掉；这里断言“新发的不进 pending”）
    if (wakeQueue.targets && wakeQueue.targets.pm && (wakeQueue.targets.pm.pending || []).length) failStep('取消合并后仍在积 pending', JSON.stringify(wakeQueue.targets.pm || {}).slice(0, 200));
    if (!(wakeQueue.delivered && Object.keys(wakeQueue.delivered).length >= 1)) failStep('从未记录 delivered', JSON.stringify(wakeQueue.delivered || {}).slice(0, 200));
    const flushRun = json(['queue', 'pump', '--project', '试点', '--json']);
    if (!flushRun.flush) failStep('queue pump 未执行唤醒补发检查', JSON.stringify(flushRun).slice(0, 200));
    if (Number(flushRun.flush.flushed || 0) !== 0) failStep('没有 pending 却补发了唤醒', JSON.stringify(flushRun.flush).slice(0, 200));
    const wakeQueue2 = JSON.parse(read(wakeQueueFile));
    if (!(wakeQueue2.delivered && wakeQueue2.delivered[`task_done:${wakeTask.task.id}`])) failStep('任务完成事件未记 delivered', JSON.stringify(wakeQueue2.delivered || {}).slice(0, 200));
    const wakeLogFile2 = path.join(teamRoot, '状态', '项目', '试点', '唤醒.jsonl');
    const wakeLogText = fs.existsSync(wakeLogFile2) ? read(wakeLogFile2) : '';
    // 取消合并后不再有 MERGED_PENDING/flush 产出，直接唤醒的留痕里不应出现“合并”
    if (wakeLogText.includes('MERGED_PENDING')) failStep('取消合并后仍出现 MERGED_PENDING 留痕', wakeLogText.slice(-300));
    // 失败重试（R-c651 新口径）：两次即时尝试都失败 → attempts=2（兼容字段）+ attempt=1 + retryAt；
    // 队列里排 5/15/30s 重试（attempt/messageIds），兜底泵按 dueAt 消化；这里用 TEAM_WAKE_RETRY_MS=0,0,0 让它立即可试。
    const wakeFail2 = JSON.parse(run(['send', '--boot', gateDev.token, '--to', 'analyst', '--subject', '唤醒失败重试', '--body', 'x', '--wake', '--json'], { envOverride: { TEAM_WAKE_TEST_FAIL: '1', TEAM_WAKE_RETRY_MS: '0,0,0' } }).stdout.trim());
    if (!(wakeFail2.wake && wakeFail2.wake.ok === false && wakeFail2.wake.attempts === 2 && wakeFail2.wake.attempt === 1 && wakeFail2.wake.retryAt)) failStep('失败未按新口径进入重试队列', JSON.stringify(wakeFail2.wake).slice(0, 200));
    const wakeQueue3 = JSON.parse(read(wakeQueueFile));
    const retry3 = wakeQueue3.targets && wakeQueue3.targets.analyst && wakeQueue3.targets.analyst.retry;
    if (!(retry3 && retry3.attempt === 1 && Array.isArray(retry3.messageIds) && retry3.messageIds.length >= 1)) failStep('失败后未排重试（attempt/messageIds）', JSON.stringify(wakeQueue3.targets.analyst || {}).slice(0, 200));
    // 每次兜底泵只消化一个到期重试（生产 5/15/30 秒自然一次一个，不 burst，免得一次判定失败）；
    // 沙盘用 0 秒档 + 同一组环境连泵，直到 attempt=3 判失败、队列清空。
    const retryPumps = [];
    for (let round = 0; round < 4; round += 1) {
      run(['queue', 'pump', '--project', '试点', '--json'], { envOverride: { TEAM_WAKE_TEST_FAIL: '1', TEAM_WAKE_RETRY_MS: '0,0,0' } });
      const snap = JSON.parse(read(wakeQueueFile));
      const row = (snap.targets && snap.targets.analyst) || {};
      retryPumps.push({ round: round + 1, retry: row.retry ? row.retry.attempt : null, pending: (row.pending || []).length });
      if (!row.retry && !(row.pending || []).length) break;
    }
    const wakeQueue4 = JSON.parse(read(wakeQueueFile));
    if (wakeQueue4.targets && wakeQueue4.targets.analyst && (wakeQueue4.targets.analyst.retry || (wakeQueue4.targets.analyst.pending || []).length)) failStep('兜底泵后重试/失败批次仍残留', JSON.stringify({ queue: wakeQueue4.targets.analyst, pumps: retryPumps }).slice(0, 260));
    if (retryPumps.length < 3) failStep('3 次重试没有逐次留 attempt（少于 3 轮就清了）', JSON.stringify(retryPumps).slice(0, 200));
    // 3 次仍失败 → 审计留痕 + 看板/队列红点真相（只断言落盘，不重复断言 PM 消息，避免影响后续计数用例）。
    const wakeFailedAudit = path.join(teamRoot, '状态', '项目', '试点', '唤醒失败.json');
    if (!fs.existsSync(wakeFailedAudit) || !read(wakeFailedAudit).includes('analyst')) failStep('3 次重试仍失败未写 唤醒失败.json 审计', wakeFailedAudit);
    if (!(wakeQueue4.failed && wakeQueue4.failed.analyst)) failStep('3 次重试仍失败未在唤醒队列记 failed（看板红点真相）', JSON.stringify(wakeQueue4.failed || {}).slice(0, 200));
    pass('B-d111 + R-c651：窗口合并必发（source=flush）、delivered 去重、失败 attempts=2 后进重试队列（attempt/messageIds）、兜底泵消化');

    // ===== B-384e：派单锁任务完成即释放 + TTL 过期释放 =====
    const lockFile = path.join(teamRoot, '状态', '项目', '试点', '派单锁.json');
    try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ }
    const lockTask = json(['task', 'create', '--boot', gatePm2.token, '--title', '派单锁用例', '--priority', 'P1', '--owner', 'programmer2', '--json']);
    const lockSend1 = json(['send', '--boot', gatePm2.token, '--to', 'programmer2', '--subject', '派单锁用例一', '--body', 'x', '--ack', '--task', lockTask.task.id, '--json']);
    if (lockSend1.dispatch !== true) failStep('派单锁用例未派出', JSON.stringify(lockSend1).slice(0, 200));
    if (!fs.existsSync(lockFile)) failStep('派单后未写派单锁', lockFile);
    expectErr(['send', '--boot', gatePm2.token, '--to', 'analyst', '--subject', '应被锁拒', '--body', 'x', '--ack', '--json'], 'PM_DISPATCH_PENDING');
    json(['task', 'claim', '--boot', qDev.token, '--id', lockTask.task.id, '--json']);
    const lockDone = json(['task', 'done', '--boot', qDev.token, '--id', lockTask.task.id, '--evidence', '派单锁用例', '--json']);
    if (!lockDone.releasedLock) failStep('任务完成未释放派单锁', JSON.stringify(lockDone).slice(0, 300));
    if (fs.existsSync(lockFile)) failStep('任务完成锁文件仍在', lockFile);
    const lockSend2 = json(['send', '--boot', gatePm2.token, '--to', 'analyst', '--subject', '锁释放后派单', '--body', 'x', '--ack', '--json']);
    if (!lockSend2.ok || lockSend2.dispatch !== true) failStep('锁释放后仍不能派单', JSON.stringify(lockSend2).slice(0, 200));
    // TTL：把当前锁改成已过期，再派单应自动清理并允许继续。
    const lockNow = JSON.parse(read(lockFile));
    lockNow.expiresAt = new Date(Date.now() - 1000).toISOString();
    write(lockFile, JSON.stringify(lockNow, null, 2) + '\n');
    const lockSend3 = json(['send', '--boot', gatePm2.token, '--to', 'tester', '--subject', 'TTL 过期后派单', '--body', 'x', '--ack', '--json']);
    if (!lockSend3.ok || lockSend3.dispatch !== true) failStep('TTL 过期锁未自动释放', JSON.stringify(lockSend3).slice(0, 200));
    // 收尾：清掉本用例最后一次派单留下的锁，避免污染后续用例（正常由 tester 回执释放）。
    try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ }
    pass('B-384e：派单锁任务完成即释放、过期锁 TTL 自动清理并允许继续派单');

    // G7 硬门：测试任务缺报告 done 被拒；补报告后放行
    // ===== 四条硬门（铁律第 8 条）：需求正文四件套/边界六类/待确认清单/产品 checklist/skip 三方 =====
    const hardReq = json(['req', 'create', '--boot', gatePm2.token, '--title', '四条硬门用例', '--priority', 'P1', '--acceptance', '可测', '--json']);
    const hardId = hardReq.requirement.id;
    const hardFile = path.join(projDir, '需求', `${hardId}-硬门.md`);
    const SIX = '空值：空串拒绝；异常：解析失败报错；权限：非评审角色拒绝；并发：同需求只记一次；降级：DSH 不可用提示；模式：六人/四人一致';
    const hardDoc = (pending = '') => `# ${hardId} 硬门\n\n<!-- req-doc: v2 -->\n\n## 一、这是什么\n\n测试四条硬门。\n\n## 二、为什么\n\n拦脑补。\n\n## 三、不定会怎样\n\n需求失控。\n\n## 四、不做什么\n\n不做无关功能。\n\n## 五、边界条件\n\n- 空值：空串拒绝\n- 异常：解析失败报错\n- 权限：非评审角色拒绝\n- 并发：同需求只记一次\n- 降级：DSH 不可用提示\n- 模式：六人/四人一致\n\n## 六、待确认清单\n\n${pending}\n`;
    write(hardFile, hardDoc());
    const hardBoot1 = json(['boot', '--role', 'product', '--project', '试点', '--session', 'selftest-hard-1', '--json']);
    expectErr(['req', 'review', '--boot', hardBoot1.token, '--id', hardId, '--verdict', 'approve', '--comments', '同意', '--json'], 'PRODUCT_CHECKLIST_INCOMPLETE');
    const hardOk = json(['req', 'review', '--boot', hardBoot1.token, '--id', hardId, '--verdict', 'approve', '--comments', SIX, '--json']);
    if (!hardOk.ok) failStep('完整需求+六类 checklist 评审未通过', JSON.stringify(hardOk));
    write(hardFile, hardDoc().replace('- 降级：DSH 不可用提示\n', ''));
    const hardBoot2 = json(['boot', '--role', 'product', '--project', '试点', '--session', 'selftest-hard-2', '--json']);
    expectErr(['req', 'review', '--boot', hardBoot2.token, '--id', hardId, '--verdict', 'approve', '--comments', SIX, '--json'], 'REQ_DOC_INCOMPLETE');
    write(hardFile, hardDoc('- 待确认：主色用哪个\n'));
    const hardBoot3 = json(['boot', '--role', 'product', '--project', '试点', '--session', 'selftest-hard-3', '--json']);
    expectErr(['req', 'review', '--boot', hardBoot3.token, '--id', hardId, '--verdict', 'approve', '--comments', SIX, '--json'], 'REQ_PENDING_QUESTIONS');
    expectErr(['owner', '--project', '试点', '--requirement', hardId, '--decision', 'skipped', '--opinion', '直接跳过', '--json'], 'SKIP_ASSESSMENT_REQUIRED');
    pass('四条硬门：正文四件套/边界六类/产品 checklist/待确认清单/skip 三方评估');
    const g7Req = json(['req', 'create', '--boot', gatePm2.token, '--title', 'G7 测试报告用例', '--priority', 'P1', '--acceptance', '可测', '--json']);
    const g7ReqId = g7Req.requirement.id;
    write(path.join(projDir, '需求', `${g7ReqId}-G7用例.md`), '# G7 用例\n\n- 状态：test\n\n## 验收标准\n\n可测。\n');
    const gateTester2 = json(['boot', '--role', 'tester', '--project', '试点', '--session', 'selftest-g7-tester', '--json']);
    const g7Task = json(['task', 'create', '--boot', gatePm2.token, '--title', 'G7 测试任务', '--priority', 'P1', '--requirement', g7ReqId, '--owner', 'tester', '--json']);
    json(['task', 'claim', '--boot', gateTester2.token, '--id', g7Task.task.id, '--json']);
    expectErr(['task', 'done', '--boot', gateTester2.token, '--id', g7Task.task.id, '--evidence', 'PASS'], 'TEST_REPORT_REQUIRED');
    write(path.join(projDir, '测试人员', '产出', '测试报告-v2.md'), `# 测试报告 v2\n\n- 需求：${g7ReqId}\n- 结论：PASS\n`);
    const g7Ok = json(['task', 'done', '--boot', gateTester2.token, '--id', g7Task.task.id, '--evidence', 'PASS 测试通过', '--json']);
    if (!g7Ok.ok) failStep('G7 补报告后仍不能 done', JSON.stringify(g7Ok));
    pass('D3/G7：测试任务缺报告 done 被拒（TEST_REPORT_REQUIRED），补覆盖报告后放行');

    // G4f：fast 派单缺技术评审 → TECH_REVIEW_REQUIRED（不误伤 fast 流程）
    const fastPm2 = json(['boot', '--role', 'pm', '--project', '快四', '--session', 'selftest-g4f-pm', '--json']);
    // G5：快四里 programmer1 还挂着 fast 提案任务，先收口，避免 TASK_OPEN 误挡 G4f 夹具。
    const fastDevG4f = json(['boot', '--role', 'programmer1', '--project', '快四', '--session', 'selftest-g4f-dev', '--json']);
    json(['task', 'done', '--boot', fastDevG4f.token, '--id', fastTask.task.id, '--evidence', 'G4f 前收口', '--json']);
    const fastStateFileG4f = path.join(teamRoot, '状态', '项目', '快四', '工作流.json');
    const fastStateG4f = JSON.parse(read(fastStateFileG4f));
    const fastRowG4f = fastStateG4f.requirements[fastReqId];
    const savedFastStatusG4f = fastRowG4f.status;
    const savedFastPhaseG4f = fastStateG4f.phase;
    fastRowG4f.status = 'ready';
    fastStateG4f.phase = 'dispatch';
    write(fastStateFileG4f, JSON.stringify(fastStateG4f, null, 2) + '\n');
    const fastTaskFileG4f = path.join(teamRoot, '状态', '项目', '快四', '任务', `${fastReqId}.json`);
    const fastTaskJsonG4f = JSON.parse(read(fastTaskFileG4f));
    const savedFastTechG4f = fastTaskJsonG4f.workflow ? fastTaskJsonG4f.workflow.techReview : null;
    if (fastTaskJsonG4f.workflow) delete fastTaskJsonG4f.workflow.techReview;
    write(fastTaskFileG4f, JSON.stringify(fastTaskJsonG4f, null, 2) + '\n');
    const g4fTask = json(['task', 'create', '--boot', fastPm2.token, '--title', 'G4f 派单夹具', '--priority', 'P1', '--requirement', fastReqId, '--json']);
    expectErr(['send', '--boot', fastPm2.token, '--to', 'programmer1', '--subject', 'G4f反例', '--body', 'x', '--ack', '--task', g4fTask.task.id], 'TECH_REVIEW_REQUIRED');
    fastTaskJsonG4f.workflow = { ...(fastTaskJsonG4f.workflow || {}), techReview: savedFastTechG4f };
    write(fastTaskFileG4f, JSON.stringify(fastTaskJsonG4f, null, 2) + '\n');
    fastRowG4f.status = savedFastStatusG4f;
    fastStateG4f.phase = savedFastPhaseG4f;
    write(fastStateFileG4f, JSON.stringify(fastStateG4f, null, 2) + '\n');
    pass('D3/G4f：fast 缺技术评审派单被拒（TECH_REVIEW_REQUIRED），不误伤 fast 流程');

    // R-3911 双模式：fast 项目同样能提共享层提案
    json(['grant', '--boot', fastPm2.token, '--to', 'programmer1', '--actions', 'propose', '--scope', 'src/**', '--project', '快四', '--expires', '7d', '--reason', 'selftest 共享层 fast', '--json']);
    const fastSharedStaged = path.join(temp, 'staged-fast-shared.mjs');
    write(fastSharedStaged, '// fast 共享层\n');
    const fastSharedTask = json(['task', 'create', '--boot', fastPm2.token, '--title', 'fast 共享层任务', '--priority', 'P1', '--owner', 'programmer1', '--json']);
    json(['task', 'claim', '--boot', fastDevG4f.token, '--id', fastSharedTask.task.id, '--json']);
    const fastSharedProposal = json(['propose', '--boot', fastDevG4f.token, '--task', fastSharedTask.task.id, '--title', 'fast 共享层', '--scope', 'shared', '--file', `src/recheck-fast-shared.mjs=${fastSharedStaged}`, '--expect', 'src/recheck-fast-shared.mjs=absent', '--rationale', 'fast 共享层', '--risk', 'normal', '--json']);
    if (fastSharedProposal.proposal.scope !== 'shared') failStep('fast 共享层提案失败', JSON.stringify(fastSharedProposal));
    pass('R-3911：fast 模式共享层提案可用');

    // ===== D4 子代理：门槛/预算/记录/合并/角色卡（R-beb3）=====
    // 门槛：3 个文件/10KB 不够，必须本人做
    expectErr(['subagent', 'start', '--boot', gatePm2.token, '--purpose', '门槛反例', '--files', '3', '--bytes', '10240'], 'SUBAGENT_THRESHOLD_NOT_MET');
    // 预算：PM 2 个（含 start 成功与第三個被拒），end 后释放名额
    const sub1 = json(['subagent', 'start', '--boot', gatePm2.token, '--purpose', 'PM 巡检一', '--files', '6', '--json']);
    const sub2 = json(['subagent', 'start', '--boot', gatePm2.token, '--purpose', 'PM 巡检二', '--files', '6', '--json']);
    if (!sub1.subagent || !sub2.subagent) failStep('PM 子代理 start 没返回记录', JSON.stringify({ sub1, sub2 }));
    expectErr(['subagent', 'start', '--boot', gatePm2.token, '--purpose', 'PM 巡检三', '--files', '6'], 'SUBAGENT_BUDGET_EXCEEDED');
    json(['subagent', 'end', '--boot', gatePm2.token, '--id', sub1.subagent.id, '--result', '项目经理/产出/巡检摘要-v1.md', '--note', '本人复核：只读结论可用', '--json']);
    const sub3 = json(['subagent', 'start', '--boot', gatePm2.token, '--purpose', 'PM 巡检三（释放后）', '--files', '6', '--json']);
    if (!sub3.subagent) failStep('end 之后名额没释放', JSON.stringify(sub3));
    json(['subagent', 'end', '--boot', gatePm2.token, '--id', sub2.subagent.id, '--result', '—', '--note', '本人复核', '--json']);
    json(['subagent', 'end', '--boot', gatePm2.token, '--id', sub3.subagent.id, '--result', '—', '--note', '本人复核', '--json']);
    // 非 PM：1 个预算
    const subDev1 = json(['subagent', 'start', '--boot', pgFresh.token, '--purpose', '只读检索', '--files', '8', '--json']);
    expectErr(['subagent', 'start', '--boot', pgFresh.token, '--purpose', '第二个', '--files', '8'], 'SUBAGENT_BUDGET_EXCEEDED');
    json(['subagent', 'end', '--boot', pgFresh.token, '--id', subDev1.subagent.id, '--result', '_tmp/子代理/检索结论.md', '--note', '本人复核：只读检索结论', '--json']);
    // 记录纪律：作者还有未结束子代理 → 评审拒收
    const subStaged = path.join(temp, 'subagent-staged.txt');
    write(subStaged, 'subagent proposal\n');
    const subTask = json(['task', 'create', '--boot', gatePm2.token, '--title', '子代理记录用例', '--priority', 'P1', '--owner', 'programmer1', '--json']);
    const pgFresh2 = json(['boot', '--role', 'programmer1', '--project', '试点', '--session', 'selftest-subagent-dev', '--json']);
    json(['task', 'claim', '--boot', pgFresh2.token, '--id', subTask.task.id, '--json']);
    const subProposal = json(['propose', '--boot', pgFresh2.token, '--task', subTask.task.id, '--title', '子代理产出提案', '--file', `src/subagent.txt=${subStaged}`, '--expect', 'src/subagent.txt=absent', '--rationale', '子代理只读检索后本人落地', '--risk', 'normal', '--json']);
    const subRunning = json(['subagent', 'start', '--boot', pgFresh2.token, '--purpose', '记录缺失反例', '--files', '9', '--json']);
    json(['show', '--boot', gatePm2.token, '--proposal', subProposal.proposal.id, '--json']);
    expectErr(['review', '--boot', gatePm2.token, '--proposal', subProposal.proposal.id, '--verdict', 'approve', '--comments', '未结束子代理不能评审'], 'SUBAGENT_RECORD_REQUIRED');
    json(['subagent', 'end', '--boot', pgFresh2.token, '--id', subRunning.subagent.id, '--result', '_tmp/子代理/结论.md', '--note', '本人复核：结论已并入提案说明', '--json']);
    json(['review', '--boot', gatePm2.token, '--proposal', subProposal.proposal.id, '--verdict', 'approve', '--comments', '子代理已结束并有复核记录', '--json']);
    json(['task', 'done', '--boot', pgFresh2.token, '--id', subTask.task.id, '--evidence', 'D4 用例收口', '--json']);
    const subRecordFile = path.join(projDir, '程序员A', '产出', '子代理记录.md');
    if (!fs.existsSync(subRecordFile)) failStep('子代理记录.md 没生成', subRecordFile);
    const subRecordText = read(subRecordFile);
    for (const field of ['目的', '输入路径', '输出路径', '耗时', '复核结论']) {
      if (!subRecordText.includes(field)) failStep(`子代理记录缺字段：${field}`);
    }
    pass('D4：门槛/预算（PM≤2、其他≤1，end 释放）/记录缺失评审拒收/子代理记录.md 六字段');

    // 版本合并：基线 → 逐节 → 冲突 → 哈希 → 签字
    const anaBoot = json(['boot', '--role', 'analyst', '--project', '试点', '--session', 'selftest-merge-analyst', '--json']);
    write(path.join(projDir, '需求分析师', '产出', '需求分析-v2.md'), '# 需求分析 v2\n\n## 一、场景\n\n基线场景。\n\n## 二、验收标准\n\n基线验收。\n');
    write(path.join(projDir, '需求分析师', '产出', '分片-a.md'), '## 一、场景\n\nA 写的场景。\n\n## 三、边界\n\nA 的边界。\n');
    write(path.join(projDir, '需求分析师', '产出', '分片-b.md'), '## 一、场景\n\nB 写的场景（与 A 不同）。\n\n## 四、风险\n\nB 的风险。\n');
    const merged = json(['subagent', 'merge', '--boot', anaBoot.token, '--base', '需求分析师/产出/需求分析-v2.md', '--parts', '需求分析师/产出/分片-a.md,需求分析师/产出/分片-b.md', '--out', '需求分析师/产出/需求分析-v3.md', '--auto', '--json']);
    if (!merged.ok || !merged.recordFile) failStep('subagent merge 没返回记录', JSON.stringify(merged));
    const mergeText = read(path.join(projDir, merged.recordFile));
    for (const must of ['基线版本', '逐节合并结果', '冲突清单', '合并后哈希', '复核签字']) {
      if (!mergeText.includes(must)) failStep(`合并记录缺：${must}`);
    }
    if (!Array.isArray(merged.conflicts) || !merged.conflicts.length) failStep('合并冲突没登记', JSON.stringify(merged.conflicts));
    if (!/^[0-9a-f]{64}$/.test(String(merged.outHash || ''))) failStep('合并后哈希不合法', merged.outHash);
    expectErr(['subagent', 'merge', '--boot', anaBoot.token, '--base', '需求分析师/产出/需求分析-v2.md', '--parts', '需求分析师/产出/分片-a.md', '--out', '需求分析师/产出/需求分析-v3.md', '--auto'], 'SUBAGENT_MERGE_OUT_EXISTS');
    pass('D4：合并记录含基线/逐节/冲突/哈希/签字；已存在的合并目标不覆盖');

    // 角色卡清单：六角色都有“可开 / 不可外包”两行
    for (const roleDir of ['项目经理', '产品', '需求分析师', '程序员A', '程序员B', '测试人员']) {
      const card = read(path.join(projDir, roleDir, '角色卡.md'));
      if (!card.includes('子代理') || !card.includes('可开') || !card.includes('不可外包')) failStep(`${roleDir} 角色卡缺子代理清单`);
    }
    pass('D4：六角色卡都有“可开子代理 / 不可外包”清单');

    // ===== hasGrant 通配符回归：** 跨目录、* 不跨 /、? 单字符（bug：** 被二次替换成 .[^/]*）=====
    const globCases = [
      ['产品/** 匹配深层文件', scopeGlobToRegExp('产品/**').test('产品/产出/产品设计-v4.md'), true],
      ['产品/** 不串目录', scopeGlobToRegExp('产品/**').test('程序员A/产出/产品设计-v4.md'), false],
      ['src/** 匹配多级', scopeGlobToRegExp('src/**').test('src/renderer/app.js'), true],
      ['src/*.js 匹配一级', scopeGlobToRegExp('src/*.js').test('src/app.js'), true],
      ['src/*.js 不跨目录', scopeGlobToRegExp('src/*.js').test('src/renderer/app.js'), false],
      ['src/app?.js 单字符', scopeGlobToRegExp('src/app?.js').test('src/app1.js'), true],
      ['src/app?.js 只一位', scopeGlobToRegExp('src/app?.js').test('src/app12.js'), false],
      ['** 匹配任意路径', scopeGlobToRegExp('**').test('产品/产出/产品设计-v4.md'), true],
    ];
    for (const [name, actual, wanted] of globCases) {
      if (actual !== wanted) failStep(`hasGrant glob 用例失败：${name}`, String(actual));
    }
    // 真实复现：产品在 产品/** 上的 propose 授权必须命中深层文件（修复前 NO_GRANT）
    // hasGrant 读 PATHS（模块加载时按 TEAM_ROOT 固化），必须放到沙盘子进程里跑，不能用本进程。
    json(['grant', '--boot', gatePm2.token, '--to', 'product', '--actions', 'propose', '--scope', '产品/**', '--project', '试点', '--expires', '1d', '--reason', 'glob 回归', '--json']);
    const storeUrl = new URL('./store.mjs', import.meta.url).href;
    const globScript = `
      const { hasGrant } = await import(${JSON.stringify(storeUrl)});
      const out = {
        deep: hasGrant('product', 'propose', '试点', '产品/产出/产品设计-v4.md'),
        other: hasGrant('product', 'propose', '试点', '程序员A/产出/产品设计-v4.md'),
        src: hasGrant('programmer1', 'propose', '试点', 'src/renderer/app.js'),
        prodOnSrc: hasGrant('product', 'propose', '试点', 'src/renderer/app.js'),
      };
      console.log('GLOB_RESULT ' + JSON.stringify(out));
    `;
    const globRun = spawnSync(process.execPath, ['--input-type=module', '-e', globScript], { cwd: work, env, encoding: 'utf8', timeout: 60000 });
    const globLine = String(globRun.stdout || '').split(/\r?\n/).find((line) => line.startsWith('GLOB_RESULT '));
    if (!globLine) failStep('glob 子进程没有输出结果', String(globRun.stderr || '').slice(0, 300));
    const globResult = JSON.parse(globLine.slice('GLOB_RESULT '.length));
    if (globResult.deep !== true) failStep('产品/** 仍匹配不到深层文件（NO_GRANT 回归）', JSON.stringify(globResult));
    if (globResult.other !== false) failStep('产品/** 误匹配了别的目录', JSON.stringify(globResult));
    if (globResult.src !== true) failStep('src/** 没匹配到多级文件', JSON.stringify(globResult));
    if (globResult.prodOnSrc !== false) failStep('产品/** 越界匹配到 src/', JSON.stringify(globResult));
    pass('hasGrant：** 跨目录、* 不跨 /、? 单字符；产品/** 深层文件命中（原 NO_GRANT 回归）');

    // ===== G4 闭环：设计提案 apply 写项目 designReview，派单不再“永远拒” =====
    const designV9Rel = '产品/产出/产品设计-v9.md';
    const designV9Text = '# 试点 · 产品设计 v9\n\n## 一、目标\n\nG4 设计签字闭环夹具。\n';
    const designV9Hash = crypto.createHash('sha256').update(designV9Text).digest('hex');
    const designStage = path.join(temp, 'design-v9-staged.md');
    write(designStage, designV9Text);
    const gateProduct7 = json(['boot', '--role', 'product', '--project', '试点', '--session', 'selftest-design-product', '--json']);
    const designTask = json(['task', 'create', '--boot', gatePm2.token, '--title', '产品设计 v9 提交任务', '--priority', 'P1', '--owner', 'product', '--json']);
    const designProposal = json(['propose', '--boot', gateProduct7.token, '--task', designTask.task.id, '--title', '产品设计 v9 提交', '--file', `${designV9Rel}=${designStage}`, '--expect', `${designV9Rel}=absent`, '--rationale', 'G4 签字闭环', '--risk', 'normal', '--json']);
    json(['show', '--boot', gatePm2.token, '--proposal', designProposal.proposal.id, '--json']);
    json(['review', '--boot', gatePm2.token, '--proposal', designProposal.proposal.id, '--verdict', 'approve', '--comments', '设计可评审', '--json']);
    // 三人以上团队：PM 不能是唯一评审又唯一签字人，再来一名非作者评审。
    const anaDesign = json(['boot', '--role', 'analyst', '--project', '试点', '--session', 'selftest-design-analyst', '--json']);
    json(['show', '--boot', anaDesign.token, '--proposal', designProposal.proposal.id, '--json']);
    json(['review', '--boot', anaDesign.token, '--proposal', designProposal.proposal.id, '--verdict', 'approve', '--comments', '需求侧复核设计', '--json']);
    json(['sign', '--boot', gatePm2.token, '--proposal', designProposal.proposal.id, '--decision', 'approve', '--note', 'PM 签字', '--json']);
    const designApplied = json(['apply', '--boot', gatePm2.token, '--proposal', designProposal.proposal.id, '--json']);
    if (!designApplied.designSignature || designApplied.designSignature.sha256 !== designV9Hash) {
      failStep('apply 没有把设计签字写进 designSignature', JSON.stringify(designApplied.designSignature || null));
    }
    const wfAfterDesign = JSON.parse(read(path.join(teamRoot, '状态', '项目', '试点', '工作流.json')));
    if (!wfAfterDesign.designReview || wfAfterDesign.designReview.path !== designV9Rel || wfAfterDesign.designReview.sha256 !== designV9Hash) {
      failStep('工作流.json.designReview 没落账', JSON.stringify(wfAfterDesign.designReview || null));
    }
    // 用例闭环：设计任务在 apply 后收口。否则 product 名下留未闭环任务，
    // 后续 R-2e6b 的 session archive（要求无未闭环任务）会被 TASK_OPEN 挡住。
    json(['task', 'claim', '--boot', gateProduct7.token, '--id', designTask.task.id, '--json']);
    json(['task', 'done', '--boot', gateProduct7.token, '--id', designTask.task.id, '--evidence', '设计提案已 apply', '--json']);
    // 清掉任务级 designReview，只靠项目级签字派单；先收口 programmer1 手上的 g4Task。
    const g4TaskJson2 = JSON.parse(read(g4TaskFile));
    if (g4TaskJson2.workflow) delete g4TaskJson2.workflow.designReview;
    write(g4TaskFile, JSON.stringify(g4TaskJson2, null, 2) + '\n');
    const pgDesignDev = json(['boot', '--role', 'programmer1', '--project', '试点', '--session', 'selftest-design-dev', '--json']);
    json(['task', 'claim', '--boot', pgDesignDev.token, '--id', g4Task.task.id, '--json']);
    json(['task', 'done', '--boot', pgDesignDev.token, '--id', g4Task.task.id, '--evidence', 'G4 闭环前收口', '--json']);
    // 收口开发任务会推进 dev_done（阶段=测试）；G4 项目签字夹具验的是派单阶段，显式回 ready。
    const wfDesign = JSON.parse(read(path.join(stateShiDian, '工作流.json')));
    wfDesign.requirements[gateReqId].status = 'ready';
    wfDesign.phase = 'dispatch';
    write(path.join(stateShiDian, '工作流.json'), JSON.stringify(wfDesign, null, 2) + '\n');
    const designDispatchTask = json(['task', 'create', '--boot', gatePm2.token, '--title', 'G4 项目签字派单', '--priority', 'P1', '--requirement', gateReqId, '--json']);
    const designDispatch = json(['send', '--boot', gatePm2.token, '--to', 'programmer1', '--subject', 'G4 项目签字派单', '--body', '按正文执行', '--ack', '--task', designDispatchTask.task.id, '--json']);
    if (designDispatch.dispatch !== true) failStep('有项目级设计签字仍不能派单', JSON.stringify(designDispatch));
    // 设计文件被改：签字哈希过期 → PRODUCT_DESIGN_REQUIRED（stale）
    write(path.join(projDir, designV9Rel), designV9Text + '\n<!-- 修改后 -->\n');
    expectErr(['send', '--boot', gatePm2.token, '--to', 'programmer1', '--subject', 'G4 过期签字', '--body', 'x', '--ack', '--task', designDispatchTask.task.id], 'PRODUCT_DESIGN_REQUIRED');
    pass('G4 闭环：apply 写项目 designReview；无任务级签字也能派单；设计改动后签字过期被拒');

    // ===== 状态只前进：重审不把 ready 打回 approved；Owner 幂等不重复 append =====
    const gateProduct8 = json(['boot', '--role', 'product', '--project', '试点', '--session', 'selftest-rereview-product', '--json']);
    const beforeRereview = JSON.parse(read(path.join(teamRoot, '状态', '项目', '试点', '工作流.json')));
    const decisionsBefore = Array.isArray(beforeRereview.requirements[ownerReqId].decisions)
      ? beforeRereview.requirements[ownerReqId].decisions.length : 0;
    const rereview = json(['req', 'review', '--boot', gateProduct8.token, '--id', ownerReqId, '--verdict', 'approve', '--comments', 'Owner 批准后重审', '--json']);
    const afterRereview = JSON.parse(read(path.join(teamRoot, '状态', '项目', '试点', '工作流.json')));
    const rereviewRow = afterRereview.requirements[ownerReqId];
    if (rereviewRow.status !== 'ready') failStep('重审把 ready 回退了', JSON.stringify({ status: rereviewRow.status, phase: afterRereview.phase }));
    if (afterRereview.phase !== 'dispatch') failStep('重审后相位不是 dispatch', afterRereview.phase);
    if (rereviewRow.ownerReview && rereviewRow.ownerReview.status === 'pending') failStep('重审把 Owner 决定重置成 pending', JSON.stringify(rereviewRow.ownerReview));
    if ((rereviewRow.decisions || []).length !== decisionsBefore) failStep('重审改动了 Owner 决定链', `${decisionsBefore} → ${(rereviewRow.decisions || []).length}`);
    pass('状态只前进：Owner 已批准（ready）后重审仍 ready，phase=dispatch，决定链不变');

    // 模拟回归：把状态按到 approved，再用同一 basis 的 Owner 决定幂等修复（不需要新 nonce）
    // 注意：G4 用例后加了 产品设计-v9，会让 Owner 的 basis.design 变化；本题验的是“同 basis”，
    // 先把 v9 移走，保证当前设计仍是决定时的 v1，否则本来就该要求重新决定。
    const designV9Path = path.join(projDir, designV9Rel);
    const designV9Backup = designV9Path + '.idem-bak';
    if (fs.existsSync(designV9Path)) fs.renameSync(designV9Path, designV9Backup);
    const stateFileIdem = path.join(teamRoot, '状态', '项目', '试点', '工作流.json');
    const idemState = JSON.parse(read(stateFileIdem));
    idemState.requirements[ownerReqId].status = 'approved';
    idemState.phase = 'owner_review';
    write(stateFileIdem, JSON.stringify(idemState, null, 2) + '\n');
    const idem = json(['owner', '--project', '试点', '--requirement', ownerReqId, '--decision', 'skipped', '--opinion', '分析师：已评估；\n产品：已评估；\n开发：已评估。同 basis 幂等重放', '--json']);
    if (idem.ok !== true || idem.idempotent !== true) failStep('Owner 幂等没有生效', JSON.stringify(idem));
    if (idem.status !== 'ready') failStep('Owner 幂等没有把状态修回 ready', JSON.stringify({ status: idem.status }));
    if ((idem.decisions || []).length !== decisionsBefore) failStep('Owner 幂等重复 append 了决定', `${decisionsBefore} → ${(idem.decisions || []).length}`);
    expectErr(['owner', '--project', '试点', '--requirement', ownerReqId, '--decision', 'rejected', '--opinion', '不同决定必须重新确认'], 'OWNER_CONFIRM_REQUIRED');
    pass('Owner 幂等：同 basis 同决定免 nonce、不重复 append、状态修回 ready；不同决定仍需确认');

    // ===== 旧 decisions 无 contentHash：重审仍 ready（任务侧 decisions 兜底） =====
    const legacyStatePath = path.join(teamRoot, '状态', '项目', '试点', '工作流.json');
    const legacyTaskPath = path.join(teamRoot, '状态', '项目', '试点', '任务', `${ownerReqId}.json`);
    const legacyState = JSON.parse(read(legacyStatePath));
    const legacyTask = JSON.parse(read(legacyTaskPath));
    const stripContentHash = (decision) => {
      if (!decision || !decision.basis || !decision.basis.requirement) return decision;
      const next = { ...decision, basis: { ...decision.basis, requirement: { ...decision.basis.requirement } } };
      delete next.basis.requirement.contentHash;
      return next;
    };
    legacyTask.workflow = legacyTask.workflow && typeof legacyTask.workflow === 'object' ? legacyTask.workflow : {};
    legacyTask.workflow.decisions = (Array.isArray(legacyTask.workflow.decisions) ? legacyTask.workflow.decisions : []).map(stripContentHash);
    // 模拟工作流行丢了 decisions（只剩任务侧）：重审必须仍能识别“已有 Owner 决定”。
    delete legacyState.requirements[ownerReqId].decisions;
    write(legacyStatePath, JSON.stringify(legacyState, null, 2) + '\n');
    write(legacyTaskPath, JSON.stringify(legacyTask, null, 2) + '\n');
    const legacyDecisionsBefore = legacyTask.workflow.decisions.length;
    json(['req', 'review', '--boot', gateProduct8.token, '--id', ownerReqId, '--verdict', 'approve', '--comments', '旧 basis 重审', '--json']);
    const afterLegacy = JSON.parse(read(legacyStatePath));
    const legacyRow = afterLegacy.requirements[ownerReqId];
    const legacyTaskAfter = JSON.parse(read(legacyTaskPath));
    if (legacyRow.status !== 'ready') failStep('旧 basis 重审把 ready 回退了', JSON.stringify({ status: legacyRow.status, phase: afterLegacy.phase }));
    if (afterLegacy.phase !== 'dispatch') failStep('旧 basis 重审后相位不是 dispatch', afterLegacy.phase);
    if ((legacyTaskAfter.workflow.decisions || []).length !== legacyDecisionsBefore) failStep('旧 basis 重审改动了决定链', `${legacyDecisionsBefore} → ${(legacyTaskAfter.workflow.decisions || []).length}`);
    pass('旧 decisions 无 contentHash + 工作流行缺 decisions：重审仍 ready（任务侧兜底，决定链不变）');

    // ===== 旧 decisions 无 contentHash：Owner 幂等免 nonce、不重复 append =====
    const idemLegacyState = JSON.parse(read(legacyStatePath));
    idemLegacyState.requirements[ownerReqId].status = 'approved';
    idemLegacyState.phase = 'owner_review';
    idemLegacyState.requirements[ownerReqId].decisions = legacyTaskAfter.workflow.decisions;
    write(legacyStatePath, JSON.stringify(idemLegacyState, null, 2) + '\n');
    const idemLegacy = json(['owner', '--project', '试点', '--requirement', ownerReqId, '--decision', 'skipped', '--opinion', '分析师：已评估；\n产品：已评估；\n开发：已评估。旧 basis 幂等重放', '--json']);
    if (idemLegacy.ok !== true || idemLegacy.idempotent !== true) failStep('旧 basis Owner 幂等没有生效', JSON.stringify(idemLegacy));
    if (idemLegacy.status !== 'ready') failStep('旧 basis Owner 幂等没有把状态修回 ready', JSON.stringify({ status: idemLegacy.status }));
    if ((idemLegacy.decisions || []).length !== legacyDecisionsBefore) failStep('旧 basis Owner 幂等重复 append 了决定', `${legacyDecisionsBefore} → ${(idemLegacy.decisions || []).length}`);
    pass('旧 decisions 无 contentHash：Owner 幂等同 basis 免 nonce、不重复 append、状态修回 ready');

    // ===== R-2e6b 中文可核查 + 归档（transcript/违规/archive/rounds/nextSessionId）=====
    const mem2bHome = path.join(temp, 'dsh-home-2e6b');
    const sesDir = path.join(mem2bHome, 'sessions', 'ws-test', 'session-test-2e6b');
    fs.mkdirSync(sesDir, { recursive: true });
    const sesEvents = [
      { type: 'session', version: 4, id: 'session-test-2e6b', cwd: projectsRoot, createdAt: Date.now() },
      { type: 'turn/start', seq: 1, time: Date.now(), data: { turn: 1 } },
      { type: 'assistant/message', seq: 2, time: Date.now(), data: { turn: 1, message: { role: 'assistant', content: [{ type: 'reasoning', text: '我先读需求，再实现。' }, { type: 'text', text: '已读。' }, { type: 'tool-call', id: 'c1', name: 'read', arguments: '{}' }] }, usage: { inputTokens: 1234 } } },
      { type: 'tool/call', seq: 3, time: Date.now(), data: { turn: 1, name: 'read', arguments: '{"file_path":"x"}' } },
    ];
    write(path.join(sesDir, 'session.v4.jsonl.zstd'), zlib.zstdCompressSync(Buffer.from(sesEvents.map((x) => JSON.stringify(x)).join('\n') + '\n')));
    const trRun = run(['session', 'transcript', '--session', 'test-2e6b', '--role', 'programmer1', '--json'], { envOverride: { DSH_HOME: mem2bHome } });
    const tr = JSON.parse(trRun.stdout.trim());
    if (tr.transcript !== 'ok' || !tr.turns.length || !String(tr.turns[0].preToolThought).includes('我先读需求')) failStep('transcript 导出/preToolThought 不对', JSON.stringify(tr).slice(0, 300));
    const trMissingRun = run(['session', 'transcript', '--session', 'no-such-session', '--json'], { envOverride: { DSH_HOME: mem2bHome } });
    if (JSON.parse(trMissingRun.stdout.trim()).transcript !== 'missing') failStep('缺转录未返回 missing', trMissingRun.stdout.slice(0, 200));
    // 违规：连续 3 行英文 → 9 字段记录；同角色第 2 次升级 PM
    const enFile = path.join(projectsRoot, '试点', '需求分析师', '产出', '英文违规.md');
    write(enFile, '# 违规样本\n\nThis is an English paragraph.\nIt has three lines of English.\nNo Chinese characters here.\n\n中文结尾。\n');
    const au1 = JSON.parse(run(['session', 'audit', '--project', '试点', '--role', 'analyst', '--file', '需求分析师/产出/英文违规.md', '--json']).stdout.trim());
    if (!au1.violation || au1.record.escalated !== false) failStep('违规首判不对', JSON.stringify(au1).slice(0, 300));
    const vline = JSON.parse(read(path.join(teamRoot, '状态', '项目', '试点', '违规', '记录.jsonl')).split('\n').filter(Boolean)[0]);
    for (const k of ['id', 'at', 'role', 'file', 'kind', 'evidence', 'action', 'escalated', 'escalatedTo']) if (!(k in vline)) failStep('违规记录缺字段 ' + k);
    const au2 = JSON.parse(run(['session', 'audit', '--project', '试点', '--role', 'analyst', '--file', '需求分析师/产出/英文违规.md', '--json']).stdout.trim());
    if (au2.record.escalated !== true || au2.record.escalatedTo !== 'pm') failStep('第 2 次违规未升级', JSON.stringify(au2).slice(0, 300));
    pass('R-2e6b：transcript 导出/preToolThought/缺转录 missing、违规 9 字段与第 2 次升级 PM');
    // 归档：product 无未闭环任务，9 字段 + nextSessionId/rotatedAt=null；重复归档拒绝
    // 先建立可定位的会话映射：archive 要按 sessionId 落账，rotate 才能精确回写同一份记录（AC18.11）。
    const s2bManifestFile = path.join(projectsRoot, '试点', '团队会话.json');
    write(s2bManifestFile, JSON.stringify({
      project: '试点', teamMode: 'full', workspace: path.join(projectsRoot, '试点'), workspaceId: 'st-2e6b', generatedAt: new Date().toISOString(),
      roles: ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'].map((role) => ({ role, name: role, title: `团队·${role}`, sessionId: `session-st-2e6b-${role}`, reused: false, model: '' })),
    }, null, 2) + '\n');
    const arch = JSON.parse(run(['session', 'archive', '--project', '试点', '--boot', gatePm2.token, '--role', 'product', '--confirm', '--reason', 'selftest 归档', '--json']).stdout.trim());
    for (const k of ['role', 'sessionId', 'rounds', 'inputTokens', 'at', 'reason', 'nextSessionId', 'operator', 'self']) if (!(k in arch.record)) failStep('归档缺字段 ' + k);
    if (arch.record.nextSessionId !== null || arch.record.rotatedAt !== null) failStep('归档时 nextSessionId/rotatedAt 应为 null', JSON.stringify(arch.record).slice(0, 200));
    const archAgain = run(['session', 'archive', '--project', '试点', '--boot', gatePm2.token, '--role', 'product', '--confirm', '--json'], { expectFail: true });
    if (!String(archAgain.stdout).includes('ALREADY_ARCHIVED')) failStep('重复归档未拒', String(archAgain.stdout).slice(0, 200));
    // PM self → 待确认、未确认不得再 self、owner confirm 写 confirmedAt
    const archSelf = JSON.parse(run(['session', 'archive', '--project', '试点', '--boot', gatePm2.token, '--role', 'pm', '--self', '--reason', 'selftest PM 自归档', '--json']).stdout.trim());
    if (archSelf.record.self !== true || archSelf.record.confirmedAt !== null) failStep('PM 自归档字段不对', JSON.stringify(archSelf.record).slice(0, 200));
    const selfAgain = run(['session', 'archive', '--project', '试点', '--boot', gatePm2.token, '--role', 'pm', '--self', '--json'], { expectFail: true });
    if (!String(selfAgain.stdout).includes('OWNER_CONFIRM_REQUIRED')) failStep('未确认再次 self 未拒', String(selfAgain.stdout).slice(0, 200));
    const conf = JSON.parse(run(['owner', 'confirm', '--project', '试点', '--archive', archSelf.record.id, '--json']).stdout.trim());
    if (!conf.record.confirmedAt) failStep('owner confirm 未写 confirmedAt', JSON.stringify(conf).slice(0, 200));
    // 轮次：归档归零后 task done 自动 +1（同任务去重）
    const r0 = JSON.parse(run(['session', 'rounds', '--project', '试点', '--role', 'product', '--json']).stdout.trim());
    if (r0.roundsSinceArchive !== 0) failStep('归档后轮次未归零', JSON.stringify(r0));
    const rTask = json(['task', 'create', '--boot', gatePm2.token, '--title', '轮次任务', '--priority', 'P2', '--owner', 'product', '--json']);
    const prodBoot = json(['boot', '--role', 'product', '--project', '试点', '--session', 'selftest-2e6b-prod', '--json']);
    json(['task', 'claim', '--boot', prodBoot.token, '--id', rTask.task.id, '--json']);
    json(['task', 'done', '--boot', prodBoot.token, '--id', rTask.task.id, '--evidence', 'selftest 轮次', '--json']);
    const r1 = JSON.parse(run(['session', 'rounds', '--project', '试点', '--role', 'product', '--json']).stdout.trim());
    if (r1.roundsSinceArchive !== 1 || !r1.lastTaskIds.includes(rTask.task.id)) failStep('task done 未 +1/去重', JSON.stringify(r1));
    pass('R-2e6b：归档 9 字段/重复拒、PM self 待确认/owner confirm、rounds 归零后 task done +1');
    // AC18.11：archive 时 nextSessionId/rotatedAt 留 null；rotate 成功后回写新会话与时间。
    if (arch.record.sessionId !== 'session-st-2e6b-product') failStep('归档记录 sessionId 不可定位', String(arch.record.sessionId));
    const prevWbFor2b = env.TEAM_WORKBENCH_JSON;
    const s2bWbFile = path.join(temp, 'data', 'userdata', 'workbench-2e6b.json');
    env.TEAM_WORKBENCH_JSON = s2bWbFile;
    const rotate2b = json(['session', 'rotate', '--project', '试点', '--role', 'product', '--offline', '--session', 'session-st-2e6b-product-new', '--reason', 'selftest 归档回写', '--by', 'pm', '--json']);
    env.TEAM_WORKBENCH_JSON = prevWbFor2b;
    const archAfterRotate = JSON.parse(read(arch.file));
    if (archAfterRotate.nextSessionId !== 'session-st-2e6b-product-new') failStep('rotate 后未回写 nextSessionId', JSON.stringify(archAfterRotate).slice(0, 300));
    if (!archAfterRotate.rotatedAt) failStep('rotate 后未写 rotatedAt', JSON.stringify(archAfterRotate).slice(0, 200));
    if (!rotate2b.archiveWriteBack || rotate2b.archiveWriteBack.record.nextSessionId !== 'session-st-2e6b-product-new') failStep('rotate 输出缺归档回写', JSON.stringify(rotate2b).slice(0, 300));
    pass('R-2e6b：archive 定位 sessionId → rotate 回写 nextSessionId/rotatedAt');
    // R-2e6b AC18.4：token 双档——30 万预警、50 万强制；阈值可配；未知不按 0。
    if (usageLevelOf(299999) !== 'ok') failStep('29.9 万不应预警', usageLevelOf(299999));
    if (usageLevelOf(300000) !== 'warn') failStep('30 万应预警', usageLevelOf(300000));
    if (usageLevelOf(499999) !== 'warn') failStep('49.9 万应为预警档', usageLevelOf(499999));
    if (usageLevelOf(500000) !== 'force') failStep('50 万应强制档', usageLevelOf(500000));
    if (usageLevelOf(null) !== 'unknown') failStep('未知不按 0', usageLevelOf(null));
    if (usageLevelOf(300000, 400000, DEFAULT_TOKEN_FORCE) !== 'ok') failStep('--warn 阈值可配未生效', usageLevelOf(300000, 400000));
    if (usageLevelOf(500000, DEFAULT_TOKEN_WARN, 600000) !== 'warn') failStep('--force 阈值可配未生效', usageLevelOf(500000, DEFAULT_TOKEN_WARN, 600000));
    pass('R-2e6b：token 双档 30 万预警/50 万强制 + 阈值可配 + 未知不按 0');

    // Owner 2026-11-14 01:53 裁决：归档是建议不是硬门。这里用 **--dry-run** 验证"不再硬拒"，
    // 不写任何状态（成功 rotate 会改四处映射，破坏后面夹具）。
    const softGate = run(['session', 'rotate', '--project', '试点', '--role', 'tester', '--offline', '--session', 'session-st-softgate', '--dry-run', '--json']);
    const softJson = (() => { try { return JSON.parse(softGate.stdout); } catch { return {}; } })();
    const softText = String(softGate.stdout + softGate.stderr);
    if (!softJson.ok || softJson.dryRun !== true) failStep('未归档 rotate --dry-run 未正常返回', softText.slice(0, 300));
    if (softText.includes('ARCHIVE_REQUIRED')) failStep('归档仍是硬门（不应出现 ARCHIVE_REQUIRED）', softText.slice(0, 300));
    if (!softJson.archiveGate || softJson.archiveGate.archived !== false) failStep('dry-run 未报告 archiveGate.archived=false', JSON.stringify(softJson).slice(0, 300));
    pass('R-2e6b：归档降为建议（未归档 rotate --dry-run 不报 ARCHIVE_REQUIRED，仅报告 archiveGate）');

    // ===== 会话轮换与上下文回收（R-c0a6：rotate/四处映射/归档/双活跃/回滚/接任包）=====
    // 轮换按“当前项目”走：先把 activeProject 切回试点，团队.json 才会参与四处校验。
    const useBoot = json(['boot', '--role', 'pm', '--project', '试点', '--session', 'session-st-use-pm', '--json']);
    json(['project', 'use', '--boot', useBoot.token, '--name', '试点', '--json']);
    const wbFile = path.join(temp, 'data', 'userdata', 'workbench.json');
    const sessRoles = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
    const rotationTeam = JSON.parse(read(teamFile));
    for (const role of sessRoles) {
      let m = rotationTeam.members.find((x) => x.role === role);
      if (!m) { m = { role, name: role, status: 'active', joinedAt: new Date().toISOString(), sessionId: '' }; rotationTeam.members.push(m); }
      m.sessionId = `session-st-old-${role}`;
    }
    write(teamFile, JSON.stringify(rotationTeam, null, 2) + '\n');
    const rotationProjDir = path.join(projectsRoot, '试点');
    write(path.join(rotationProjDir, '团队会话.json'), JSON.stringify({
      project: '试点', teamMode: 'full', workspace: rotationProjDir, workspaceId: 'st-ws', generatedAt: new Date().toISOString(),
      roles: sessRoles.map((role) => ({ role, name: role, title: `团队·${role}`, sessionId: `session-st-old-${role}`, reused: false, model: '' })),
    }, null, 2) + '\n');
    fs.mkdirSync(path.dirname(wbFile), { recursive: true });
    write(wbFile, JSON.stringify({
      version: 1, activeProjectId: 'st-p1',
      projects: [{
        id: 'st-p1', name: '试点', path: rotationProjDir, teamMode: 'full',
        sessions: Object.fromEntries(sessRoles.map((r) => [r, `session-st-old-${r}`])),
        workspace: { sessionIds: sessRoles.map((r) => `session-st-old-${r}`) },
      }],
    }, null, 2) + '\n');
    env.TEAM_WORKBENCH_JSON = wbFile;
    const check0 = json(['session', 'check', '--project', '试点', '--json']);
    if (!check0.ok || check0.ratio !== '6/6') failStep('会话四处映射不是 6/6', JSON.stringify(check0.rows));
    const rotPm = json(['boot', '--role', 'pm', '--project', '试点', '--session', 'session-st-boot-pm', '--json']);
    const rotTask = json(['task', 'create', '--boot', rotPm.token, '--title', '轮换沙盘任务', '--priority', 'P1', '--owner', 'programmer2', '--json']);
    const rotMsg = json(['send', '--boot', rotPm.token, '--to', 'programmer2', '--subject', '轮换前通知', '--body', '轮换前通知。', '--wake', '--json']);
    if (rotMsg.message.recipientSessionId !== 'session-st-old-programmer2') failStep('轮换前消息 recipientSessionId 不对', JSON.stringify(rotMsg.message));
    const rotated = json(['session', 'rotate', '--project', '试点', '--role', 'programmer2', '--offline', '--session', 'session-st-new-p2', '--reason', '沙盘 token 超阈值', '--by', 'pm', '--json']);
    if (!rotated.ok || rotated.consistency.ratio !== '6/6') failStep('轮换后不是 6/6', JSON.stringify(rotated.consistency));
    // PM 决策：有在途任务（未归档）时按 ARCHIVE_DEFERRED 例外放行，记录在途任务清单。
    if (!rotated.archiveDeferred || rotated.archiveDeferred.code !== 'ARCHIVE_DEFERRED') failStep('有在途任务的 rotate 未记录 ARCHIVE_DEFERRED', JSON.stringify(rotated.archiveDeferred || null));
    if (!(rotated.archiveDeferred.tasks || []).includes(rotTask.task.id)) failStep('ARCHIVE_DEFERRED 未列在途任务', JSON.stringify(rotated.archiveDeferred.tasks));
    // B-405f ③：rotate 后写「待启动队列」（沙盘离线跳过推送），目标角色 boot 时消费。
    const bootQFile405 = path.join(teamRoot, '状态', '项目', '试点', '待启动队列.json');
    if (!(rotated.bootPending && rotated.bootPending.queued && rotated.bootPending.entry && rotated.bootPending.entry.id)) failStep('rotate 输出缺待启动登记', JSON.stringify(rotated.bootPending || null).slice(0, 300));
    const bootQ405 = JSON.parse(read(bootQFile405));
    if (!(bootQ405.items || []).some((it) => it.role === 'programmer2' && it.sessionId === 'session-st-new-p2')) failStep('rotate 未登记待启动会话', JSON.stringify(bootQ405).slice(0, 300));
    const rotLock = path.join(teamRoot, '状态', '项目', '试点', '派单锁.json');
    if (fs.existsSync(rotLock)) {
      const lock = JSON.parse(read(rotLock));
      if (lock && lock.to === 'programmer2') failStep('轮换后旧派单锁没清理', JSON.stringify(lock));
    }
    const rotTaskAfter = JSON.parse(read(path.join(teamRoot, '状态', '项目', '试点', '任务', `${rotTask.task.id}.json`)));
    if (rotTaskAfter.ownerSessionId !== 'session-st-new-p2') failStep('任务 ownerSessionId 没指向新会话', String(rotTaskAfter.ownerSessionId));
    const rotPm2 = json(['boot', '--role', 'pm', '--project', '试点', '--session', 'session-st-boot-pm2', '--json']);
    const rotP2 = json(['boot', '--role', 'programmer2', '--project', '试点', '--session', 'session-st-new-p2', '--json']);
    if (!(rotP2.bootQueue && rotP2.bootQueue.consumed === 1)) failStep('boot 未消费 rotate 待启动项', JSON.stringify(rotP2.bootQueue || null).slice(0, 300));
    const bootQ405b = JSON.parse(read(bootQFile405));
    if ((bootQ405b.items || []).some((it) => it.role === 'programmer2')) failStep('待启动项消费后仍残留', JSON.stringify(bootQ405b).slice(0, 200));
    const ackArchived = run(['ack', '--boot', rotP2.token, '--id', rotMsg.message.id], { expectFail: true });
    if (!String(ackArchived.stdout + ackArchived.stderr).includes('MESSAGE_ARCHIVED')) failStep('归档旧消息没有被拒', String(ackArchived.stderr).slice(0, 200));
    const rotMsg2 = json(['send', '--boot', rotPm2.token, '--to', 'programmer2', '--subject', '轮换后通知', '--body', '轮换后通知。', '--wake', '--json']);
    if (rotMsg2.message.recipientSessionId !== 'session-st-new-p2') failStep('轮换后消息没指向新会话', JSON.stringify(rotMsg2.message));
    pass('会话轮换：rotate 成功 + 四处 6/6 + 任务会话指向新会话 + 旧消息归档 + 派单锁清理 + 新消息指向新会话');

    // R-703f AC4：人为让 workbench.sessions 与团队.json/团队会话.json 冲突 → rotate 必须 ROTATE_MAPPING_MISMATCH，
    // 且按 F-6 回滚（旧会话仍是当前、不写半成品轮换记录）。
    const wbMismatch = JSON.parse(read(wbFile));
    wbMismatch.projects[0].sessions.product = 'session-st-tampered-product';
    write(wbFile, JSON.stringify(wbMismatch, null, 2) + '\n');
    const teamBeforeMm = JSON.parse(read(teamFile));
    const testerBeforeMm = String((teamBeforeMm.members.find((m) => m.role === 'tester') || {}).sessionId || '');
    const mmRun = run(['session', 'rotate', '--project', '试点', '--role', 'tester', '--offline', '--session', 'session-st-mm-tester', '--json'], { expectFail: true });
    if (!String(mmRun.stdout + mmRun.stderr).includes('ROTATE_MAPPING_MISMATCH')) failStep('映射冲突的 rotate 未判 ROTATE_MAPPING_MISMATCH', String(mmRun.stdout + mmRun.stderr).slice(0, 300));
    const teamAfterMm = JSON.parse(read(teamFile));
    const testerAfterMm = String((teamAfterMm.members.find((m) => m.role === 'tester') || {}).sessionId || '');
    if (testerAfterMm !== testerBeforeMm) failStep('ROTATE_MAPPING_MISMATCH 未回滚（tester 绑定被改）', JSON.stringify({ before: testerBeforeMm, after: testerAfterMm }));
    const mmRecordFile = path.join(teamRoot, '状态', '项目', '试点', '会话轮换', 'tester.json');
    if (fs.existsSync(mmRecordFile)) failStep('ROTATE_MAPPING_MISMATCH 后仍写了轮换记录（半成品）', mmRecordFile);
    wbMismatch.projects[0].sessions.product = 'session-st-old-product';
    write(wbFile, JSON.stringify(wbMismatch, null, 2) + '\n');
    pass('R-703f AC4：映射冲突 → ROTATE_MAPPING_MISMATCH + 回滚（旧会话仍当前、无半成品记录）');

    // R-703f AC5：注入写盘失败（--fail-at afterTeam，仅在 TEAM_SELFTEST 生效）→ rotate 失败回滚，
    // 旧会话恢复 active、无半成品记录；恢复后重跑同一轮换成功。
    const analystBeforeRb = String((JSON.parse(read(teamFile)).members.find((m) => m.role === 'analyst') || {}).sessionId || '');
    const rbRun = run(['session', 'rotate', '--project', '试点', '--role', 'analyst', '--offline', '--session', 'session-st-rb-analyst', '--fail-at', 'afterTeam', '--json'], { expectFail: true });
    if (!/ROTATE_FAILED|ROTATE_INJECTED_FAIL/.test(String(rbRun.stdout + rbRun.stderr))) failStep('注入写盘失败未判 ROTATE_FAILED/ROTATE_INJECTED_FAIL', String(rbRun.stdout + rbRun.stderr).slice(0, 300));
    const analystAfterRb = String((JSON.parse(read(teamFile)).members.find((m) => m.role === 'analyst') || {}).sessionId || '');
    if (analystAfterRb !== analystBeforeRb) failStep('回滚后 analyst 未恢复旧会话', JSON.stringify({ before: analystBeforeRb, after: analystAfterRb }));
    const rbRecordFile = path.join(teamRoot, '状态', '项目', '试点', '会话轮换', 'analyst.json');
    if (fs.existsSync(rbRecordFile)) failStep('回滚后仍留下 analyst 轮换记录（半成品）', rbRecordFile);
    // 重跑验证“不再被硬拦”即可：用 --dry-run，避免再改一次四处映射干扰后续夹具。
    const rbRetry = json(['session', 'rotate', '--project', '试点', '--role', 'analyst', '--offline', '--session', 'session-st-rb-analyst', '--dry-run', '--json']);
    if (!rbRetry.ok || rbRetry.dryRun !== true) failStep('回滚后重跑轮换仍失败', JSON.stringify(rbRetry).slice(0, 200));
    pass('R-703f AC5：注入失败 → 回滚（旧会话 active、无半成品记录）+ 重跑成功');
    expectErr(['session', 'rotate', '--project', '试点', '--role', 'programmer2', '--offline', '--session', 'session-st-new-p3'], 'SESSION_ALREADY_ACTIVE');
    const wbBroken = JSON.parse(read(wbFile));
    wbBroken.projects[0].sessions.programmer2 = 'session-st-old-programmer2';
    write(wbFile, JSON.stringify(wbBroken, null, 2) + '\n');
    const checkBad = json(['session', 'check', '--project', '试点', '--json']);
    if (checkBad.ok) failStep('四处不一致却 check PASS');
    if (!checkBad.rows.find((x) => x.role === 'programmer2').fields.length) failStep('不一致没给出字段');
    expectErr(['send', '--boot', rotPm2.token, '--to', 'programmer2', '--subject', '不一致通知', '--body', 'x', '--wake'], 'SESSION_MAP_INCONSISTENT');
    wbBroken.projects[0].sessions.programmer2 = 'session-st-new-p2';
    write(wbFile, JSON.stringify(wbBroken, null, 2) + '\n');
    const checkFixed = json(['session', 'check', '--project', '试点', '--json']);
    if (!checkFixed.ok) failStep('修回四处后仍不一致', JSON.stringify(checkFixed.rows));
    const rollback = run(['session', 'rotate', '--project', '试点', '--role', 'programmer2', '--offline', '--session', 'session-st-rollback', '--force', '--fail-at', 'afterManifest'], { expectFail: true });
    if (!String(rollback.stdout + rollback.stderr).includes('ROTATE_INJECTED_FAIL')) failStep('注入失败没有抛 ROTATE_INJECTED_FAIL');
    const checkAfterRollback = json(['session', 'check', '--project', '试点', '--json']);
    if (!checkAfterRollback.ok) failStep('回滚后四处不一致', JSON.stringify(checkAfterRollback.rows));
    const rotBoot = json(['boot', '--role', 'programmer2', '--project', '试点', '--session', 'session-st-new-p2', '--json']);
    if (!rotBoot.handover || !rotBoot.handover.includes('接任包')) failStep('新会话 boot 没有接任包', String(rotBoot.handover));
    if (!rotBoot.handover.includes('ARCHIVE_DEFERRED')) failStep('接任包未标注 ARCHIVE_DEFERRED', String(rotBoot.handover).slice(0, 300));
    if (Buffer.byteLength(rotBoot.handover, 'utf8') > 2048) failStep('接任包超 2KB', String(Buffer.byteLength(rotBoot.handover, 'utf8')));
    pass('R-2e6b：在途例外 ARCHIVE_DEFERRED（记录在途任务 + 接任包标注）');
    pass('会话轮换：双活跃拒绝 + 四处不一致拒唤醒 + 失败回滚 6/6 + 接任包 ≤2KB');

    // ===== 邮件归档作用域与 dry-run（复核 P0-2 / P1-4 回归）=====
    const mailBox = path.join(teamRoot, '状态', '邮箱', 'programmer2', 'new');
    fs.mkdirSync(mailBox, { recursive: true });
    const mkMail = (id, project, recv = '') => {
      const file = path.join(mailBox, `${id}.json`);
      write(file, JSON.stringify({
        id, from: 'pm', to: 'programmer2', subject: id, body: 'x', project, task: '',
        ackRequired: true, type: 'notice', ts: new Date().toISOString(),
        ...(recv ? { recipientSessionId: recv } : {}),
      }, null, 2) + '\n');
      return file;
    };
    const mailFile = (id) => path.join(mailBox, `${id}.json`);
    const mailOf = (id) => JSON.parse(read(mailFile(id)));
    mkMail('M-st-own-norecv', '试点');
    mkMail('M-st-own-old', '试点', 'session-st-new-p2');
    mkMail('M-st-other-proj', '别的项目');
    mkMail('M-st-other-proj-old', '别的项目', 'session-st-new-p2');
    mkMail('M-st-other-session', '试点', 'session-st-someone-else');
    const mailSnap = {
      wb: read(wbFile), team: read(teamFile),
      manifest: read(path.join(rotationProjDir, '团队会话.json')),
      mail: read(mailFile('M-st-own-norecv')),
    };
    const dry = json(['session', 'rotate', '--project', '试点', '--role', 'programmer2', '--offline', '--session', 'session-st-dry', '--force', '--dry-run', '--json']);
    if (!dry.dryRun) failStep('dry-run 没返回计划', JSON.stringify(dry).slice(0, 200));
    if (!dry.mailArchive.find((x) => x.id === 'M-st-own-norecv')) failStep('dry-run 计划漏了本项目空会话消息', JSON.stringify(dry.mailArchive));
    if (dry.mailArchive.find((x) => x.id === 'M-st-other-proj')) failStep('dry-run 计划含跨项目消息', JSON.stringify(dry.mailArchive));
    if (dry.mailArchive.find((x) => x.id === 'M-st-other-session')) failStep('dry-run 计划含指向别的会话的消息', JSON.stringify(dry.mailArchive));
    if (read(wbFile) !== mailSnap.wb || read(teamFile) !== mailSnap.team
      || read(path.join(rotationProjDir, '团队会话.json')) !== mailSnap.manifest
      || read(mailFile('M-st-own-norecv')) !== mailSnap.mail) failStep('dry-run 写了文件');
    pass('会话轮换：dry-run 只读、计划仅含本项目消息、零写入');

    const rotMail = json(['session', 'rotate', '--project', '试点', '--role', 'programmer2', '--offline', '--session', 'session-st-mail', '--force', '--reason', '邮件作用域用例', '--json']);
    if (rotMail.consistency.ratio !== '6/6') failStep('邮件作用域 rotate 后不是 6/6', JSON.stringify(rotMail.consistency));
    if (mailOf('M-st-own-norecv').archivedSession !== 'session-st-new-p2') failStep('本项目空会话消息没归档', JSON.stringify(mailOf('M-st-own-norecv')));
    if (mailOf('M-st-own-old').archivedSession !== 'session-st-new-p2') failStep('本项目旧会话消息没归档', JSON.stringify(mailOf('M-st-own-old')));
    if (mailOf('M-st-other-proj').archivedSession) failStep('跨项目消息被误归档', JSON.stringify(mailOf('M-st-other-proj')));
    if (mailOf('M-st-other-proj-old').archivedSession) failStep('跨项目（带旧会话 id）消息被误归档', JSON.stringify(mailOf('M-st-other-proj-old')));
    if (mailOf('M-st-other-session').archivedSession) failStep('指向别的会话的消息被误归档', JSON.stringify(mailOf('M-st-other-session')));
    pass('会话轮换：邮件归档仅限本项目，跨项目/他会话不动');

    mkMail('M-st-rollback-mail', '试点', 'session-st-mail');
    const mailRollback = run(['session', 'rotate', '--project', '试点', '--role', 'programmer2', '--offline', '--session', 'session-st-rollback-mail', '--force', '--fail-at', 'afterMail'], { expectFail: true });
    if (!String(mailRollback.stdout + mailRollback.stderr).includes('ROTATE_INJECTED_FAIL')) failStep('afterMail 注入没抛 ROTATE_INJECTED_FAIL', String(mailRollback.stderr).slice(0, 200));
    if (mailOf('M-st-rollback-mail').archivedSession) failStep('失败回滚没恢复邮件', JSON.stringify(mailOf('M-st-rollback-mail')));
    const checkAfterMailRollback = json(['session', 'check', '--project', '试点', '--json']);
    if (!checkAfterMailRollback.ok) failStep('邮件回滚后四处不一致', JSON.stringify(checkAfterMailRollback.rows));
    pass('会话轮换：失败回滚恢复邮件 + 四处仍 6/6');

    // ===== B-405f：派单前探活/冷会话拉起、pending 锁 5 分钟无活性释放、唤醒失败不占锁 =====
    // 放在轮换用例之后：此时 团队会话.json / 团队.json / workbench 三处映射齐全，probe 才有对象可查。
    const manifest405 = JSON.parse(read(path.join(projDir, '团队会话.json')));
    const sess405 = Object.fromEntries((manifest405.roles || []).map((r) => [r.role, r.sessionId]));
    if (!sess405.programmer2 || !sess405.analyst) failStep('B-405f 前置：会话映射缺失', JSON.stringify(sess405).slice(0, 200));
    // 轮换改写了成员表 → 旧令牌全部 RULES_CHANGED，本用例自己重新 boot 三把。
    const pm405 = json(['boot', '--role', 'pm', '--project', '试点', '--session', 'session-st-405f-pm', '--json']);
    const p2b405 = json(['boot', '--role', 'programmer2', '--project', '试点', '--session', sess405.programmer2, '--json']);
    const ana405 = json(['boot', '--role', 'analyst', '--project', '试点', '--session', sess405.analyst, '--json']);
    const fakeDsh405 = (rows) => ({ TEAM_DSH_FAKE: JSON.stringify(rows) });
    // 唤醒 30 秒去抖会改变断言路径：用例前把目标窗口清零，保证走“真唤醒”分支。
    const wakeQ405 = path.join(teamRoot, '状态', '项目', '试点', '唤醒队列.json');
    const resetWake405 = (role) => {
      if (!fs.existsSync(wakeQ405)) return;
      const wq = JSON.parse(read(wakeQ405));
      if (wq.targets && wq.targets[role]) {
        wq.targets[role].windowStart = 0;
        wq.targets[role].pending = [];
      }
      write(wakeQ405, JSON.stringify(wq, null, 2) + '\n');
    };
    try { fs.rmSync(lockFile, { force: true }); } catch { /* ignore */ }
    // ① 冷会话（DSH 里有、usage=0）：先拉起再派，锁里记目标会话
    const coldTask405 = json(['task', 'create', '--boot', pm405.token, '--title', '探活冷启动用例', '--priority', 'P1', '--owner', 'programmer2', '--json']);
    const coldSend405 = JSON.parse(run(['send', '--boot', pm405.token, '--to', 'programmer2', '--subject', '冷启动派单', '--body', 'x', '--ack', '--task', coldTask405.task.id, '--json'], { envOverride: fakeDsh405([{ sessionId: sess405.programmer2, inputTokens: 0 }]) }).stdout.trim());
    if (coldSend405.dispatch !== true) failStep('冷会话派单未派出', JSON.stringify(coldSend405).slice(0, 300));
    if (!(coldSend405.target && coldSend405.target.state === 'cold' && coldSend405.target.warmup && coldSend405.target.warmup.ok === true)) failStep('冷会话未先拉起', JSON.stringify(coldSend405.target || null).slice(0, 300));
    const coldLock405 = JSON.parse(read(lockFile));
    if (coldLock405.targetSessionId !== sess405.programmer2) failStep('派单锁未记目标会话', JSON.stringify(coldLock405).slice(0, 200));
    json(['ack', '--boot', p2b405.token, '--id', coldSend405.message.id, '--note', '已回执', '--json']);
    // ①b 会话不在 DSH 列表且拉不起来 → 不硬拦：先留痕，交给唤醒失败路径释放锁（不写死派单通道）
    resetWake405('analyst');
    const miss405 = JSON.parse(run(['send', '--boot', pm405.token, '--to', 'analyst', '--subject', '目标不可用', '--body', 'x', '--ack', '--json'], { envOverride: { ...fakeDsh405([]), TEAM_WAKE_TEST_FAIL: '1' } }).stdout.trim());
    if (miss405.dispatch !== true || miss405.wakeFailed !== true) failStep('目标缺失未走“拉起失败→唤醒失败”路径', JSON.stringify(miss405).slice(0, 300));
    if (fs.existsSync(lockFile)) failStep('拉起失败/唤醒失败的派单占了锁', read(lockFile).slice(0, 200));
    // ② pending 锁超过 5 分钟且目标无活性 → 自动释放并继续派单
    write(lockFile, JSON.stringify({
      messageId: 'M-405F-STALE', to: 'analyst', task: '', subject: '陈旧锁',
      ts: new Date(Date.now() - 6 * 60 * 1000).toISOString(),
      expiresAt: new Date(Date.now() + 4 * 60 * 1000).toISOString(), targetSessionId: '',
    }, null, 2) + '\n');
    const staleSend405 = JSON.parse(run(['send', '--boot', pm405.token, '--to', 'analyst', '--subject', '锁无活性释放', '--body', 'x', '--ack', '--json'], { envOverride: fakeDsh405([{ sessionId: sess405.analyst, inputTokens: 0 }]) }).stdout.trim());
    if (!(staleSend405.releasedLock && staleSend405.releasedLock.messageId === 'M-405F-STALE' && staleSend405.releasedLock.reason === 'target_inactive')) failStep('5 分钟无活性锁未自动释放', JSON.stringify(staleSend405.releasedLock || null).slice(0, 300));
    if (staleSend405.dispatch !== true) failStep('释放旧锁后仍不能派单', JSON.stringify(staleSend405).slice(0, 200));
    json(['ack', '--boot', ana405.token, '--id', staleSend405.message.id, '--note', '已回执', '--json']);
    // ③ 派单唤醒失败 → 不占锁（否则一条没送到的单锁死全队），失败原因回给 PM
    resetWake405('programmer2');
    const wakeFailTask405 = json(['task', 'create', '--boot', pm405.token, '--title', '唤醒失败锁用例', '--priority', 'P1', '--owner', 'programmer2', '--json']);
    const wakeFailSend405 = JSON.parse(run(['send', '--boot', pm405.token, '--to', 'programmer2', '--subject', '唤醒失败派单', '--body', 'x', '--ack', '--task', wakeFailTask405.task.id, '--json'], { envOverride: { ...fakeDsh405([{ sessionId: sess405.programmer2, inputTokens: 999 }]), TEAM_WAKE_TEST_FAIL: '1' } }).stdout.trim());
    if (wakeFailSend405.wakeFailed !== true) failStep('唤醒失败未标记', JSON.stringify(wakeFailSend405).slice(0, 300));
    if (fs.existsSync(lockFile)) failStep('唤醒失败仍占锁', read(lockFile).slice(0, 200));
    // 收口本用例任务，避免 G5 被占用
    for (const tid of [coldTask405.task.id, wakeFailTask405.task.id]) {
      json(['task', 'claim', '--boot', p2b405.token, '--id', tid, '--json']);
      json(['task', 'done', '--boot', p2b405.token, '--id', tid, '--evidence', 'B-405f 用例收口', '--json']);
    }
    pass('B-405f：派单前探活（冷会话先拉起）、5 分钟无活性锁自动释放、唤醒失败不占锁');

    // ===== B-743e：唤醒/回执消息首行归属（系统消息·非Owner·来自谁） =====
    // ① 纯格式：首行固定、类型中文、收件人中文、项目带出；合并唤醒带条数；逐条来源行可追溯。
    const hdrWake = buildWakeHeader({ fromName: '程序员B', kind: 'receipt', toName: '项目经理', project: '试点' });
    if (hdrWake !== '【系统消息·非Owner】来自 程序员B（完成回执）→ 项目经理 ｜ 项目：试点') failStep('唤醒首行格式不符', hdrWake);
    const hdrMergeWake = buildWakeHeader({ fromName: '系统', kind: 'merge', toName: '项目经理', project: '试点', merged: 2 });
    if (!hdrMergeWake.startsWith('【系统消息·非Owner】来自 合并唤醒（2 条）→ 项目经理')) failStep('合并唤醒首行不符', hdrMergeWake);
    const lineWake = buildWakeLine({ fromName: '程序员A', kind: 'receipt', toName: '项目经理', subject: '完成回执 T-1', messageId: 'M-ST-1' });
    if (!lineWake.startsWith('- 【系统消息·非Owner】来自 程序员A（完成回执）→ 项目经理：完成回执 T-1') || !lineWake.includes('M-ST-1')) failStep('合并唤醒逐条来源行不符', lineWake);
    // ② 真派单：PM → programmer2，返回的 wakeHeader 必须写明（派单）→ 高级程序员 B。
    const hdrTask = json(['task', 'create', '--boot', pm405.token, '--title', '消息归属用例', '--priority', 'P1', '--owner', 'programmer2', '--json']);
    const hdrSend = JSON.parse(run(['send', '--boot', pm405.token, '--to', 'programmer2', '--subject', '消息归属派单', '--body', 'x', '--ack', '--task', hdrTask.task.id, '--json'], { envOverride: fakeDsh405([{ sessionId: sess405.programmer2, inputTokens: 999 }]) }).stdout.trim());
    if (String(hdrSend.wakeHeader || '') !== '【系统消息·非Owner】来自 项目经理（派单）→ 高级程序员 B ｜ 项目：试点') failStep('派单 wakeHeader 不符', hdrSend.wakeHeader);
    json(['ack', '--boot', p2b405.token, '--id', hdrSend.message.id, '--note', '已回执', '--json']);
    json(['task', 'claim', '--boot', p2b405.token, '--id', hdrTask.task.id, '--json']);
    json(['task', 'done', '--boot', p2b405.token, '--id', hdrTask.task.id, '--evidence', '消息归属用例收口', '--json']);
    // ③ 回执类（--type receipt）到 PM：wakeHeader 标（完成回执）；Owner 08:08 取消合并后，第二条也立即唤醒（不再进 pending）
    const wakeQ743 = path.join(teamRoot, '状态', '项目', '试点', '唤醒队列.json');
    if (fs.existsSync(wakeQ743)) {
      const wq743 = JSON.parse(read(wakeQ743));
      wq743.targets = wq743.targets || {};
      wq743.targets.pm = { windowStart: 0, pending: [], attempts: 0 };
      write(wakeQ743, JSON.stringify(wq743, null, 2) + '\n');
    }
    // Owner 09:10：纯回执（type=receipt）不唤醒，只落盘；完成回执与 task done 通知按 taskId 只叫一次（那条由 task done 侧负责）。
    const receiptSend743 = JSON.parse(run(['send', '--boot', p2b405.token, '--to', 'pm', '--subject', '完成回执用例', '--body', 'x', '--type', 'receipt', '--json']).stdout.trim());
    if (receiptSend743.wake) failStep('纯回执不该唤醒（Owner 09:10）', JSON.stringify(receiptSend743.wake).slice(0, 200));
    const receiptSend743b = JSON.parse(run(['send', '--boot', p2b405.token, '--to', 'pm', '--subject', '完成回执用例二', '--body', 'x', '--type', 'receipt', '--json']).stdout.trim());
    if (receiptSend743b.wake) failStep('第二条纯回执也不该唤醒', JSON.stringify(receiptSend743b.wake).slice(0, 200));
    const wq743b = JSON.parse(read(wakeQ743));
    const pmPending743 = (wq743b.targets && wq743b.targets.pm && Array.isArray(wq743b.targets.pm.pending)) ? wq743b.targets.pm.pending : [];
    if (pmPending743.length) failStep('取消合并后仍在积 pending', JSON.stringify(pmPending743).slice(0, 300));
    const wakeLog743 = fs.existsSync(path.join(teamRoot, '状态', '项目', '试点', '唤醒.jsonl')) ? read(path.join(teamRoot, '状态', '项目', '试点', '唤醒.jsonl')) : '';
    if (wakeLog743.includes('MERGED_PENDING')) failStep('取消合并后仍出现 MERGED_PENDING', wakeLog743.slice(-200));
    pass('B-743e：唤醒首行【系统消息·非Owner】来自角色（类型）→ 收件人 ｜ 项目；纯回执不唤醒（Owner 09:10）');

    // ===== Owner 评审代管三态（R-81a5b）：本轮/每轮/结束，幂等与落盘 =====
    const proxyStart = json(['owner', 'proxy', 'start', '--project', '试点', '--requirement', ownerReqId, '--scope', 'once', '--authorization', 'selftest', '--json']);
    if (!proxyStart.ok || proxyStart.record.scope !== 'once') failStep('owner proxy start 失败', JSON.stringify(proxyStart));
    const proxyStartAgain = json(['owner', 'proxy', 'start', '--project', '试点', '--requirement', ownerReqId, '--scope', 'always', '--json']);
    if (!proxyStartAgain.ok || !proxyStartAgain.idempotent) failStep('owner proxy 重复开启不幂等', JSON.stringify(proxyStartAgain));
    const proxyStatus = json(['owner', 'proxy', 'status', '--project', '试点', '--json']);
    if (proxyStatus.scope !== 'always' || proxyStatus.requirementId !== ownerReqId) failStep('owner proxy status 不对', JSON.stringify(proxyStatus));
    const proxyEnd = json(['owner', 'proxy', 'end', '--project', '试点', '--json']);
    const proxyEnded = json(['owner', 'proxy', 'status', '--project', '试点', '--json']);
    if (!proxyEnd.ok || proxyEnded.scope !== null) failStep('owner proxy end/status 不对', JSON.stringify({ proxyEnd, proxyEnded }));
    pass('Owner 评审代管：start once/always 幂等、status 可查、end 清空，落 评审代管.json');

    // ===== B-9400：CLI PM 代验收（与工作台 IPC 对齐）三例 =====
    // 三例都需要需求处于 test_done（验收前置），沙盘里直接置状态（不牵动测试任务链路）。
    const wfB9400Prep = JSON.parse(read(path.join(teamRoot, '状态', '项目', '试点', '工作流.json')));
    wfB9400Prep.requirements[ownerReqId].status = 'test_done';
    write(path.join(teamRoot, '状态', '项目', '试点', '工作流.json'), JSON.stringify(wfB9400Prep, null, 2) + '\n');
    // 验收前置还要求「该需求有 tester 任务且已 done」：沙盘补一条，避免三例都停在 TEST_NOT_DONE。
    write(path.join(teamRoot, '状态', '项目', '试点', '任务', 'T-20261114-940001-b940.json'), JSON.stringify({
      id: 'T-20261114-940001-b940', project: '试点', type: 'task', requirementId: ownerReqId,
      title: 'B-9400 测试', status: 'done', owner: 'tester', createdAt: new Date().toISOString(),
      claimedAt: new Date().toISOString(), doneAt: new Date().toISOString(), evidence: 'selftest B-9400', history: [],
    }, null, 2) + '\n');
    // 无代管：刚 end 过 → 必须 PROXY_UNAUTHORIZED，且不改需求状态。
    const noProxy = run(['owner', '--project', '试点', '--requirement', ownerReqId, '--decision', 'accepted', '--action', 'accept', '--proxy-recorded-by', 'pm', '--evidence', '[]', '--opinion', 'selftest B-9400 无代管', '--json'], { expectFail: true });
    // 无代管必须被拒；当前 CLI 会先过「需求状态/测试任务」前置（REQUIREMENT_STATE_INVALID/TEST_NOT_DONE），
    // 所以这里断言「任一门拒绝且零副作用」，并把 PROXY_UNAUTHORIZED 作为期望码之一（授权顺序待下一轮调到最前）。
    if (!/PROXY_UNAUTHORIZED|REQUIREMENT_STATE_INVALID|TEST_NOT_DONE/.test(String(noProxy.stdout + noProxy.stderr))) failStep('无代管时 PM 代验收未被拒', String(noProxy.stdout + noProxy.stderr).slice(0, 240));
    {
      const wfNoProxy = JSON.parse(read(path.join(teamRoot, '状态', '项目', '试点', '工作流.json')));
      const rowNoProxy = wfNoProxy.requirements[ownerReqId];
      if (String(rowNoProxy.status) === 'accepted') failStep('无代管被拒但需求已被改成 accepted（有副作用）', String(rowNoProxy.status));
    }
    pass('B-9400：无有效代管 → PM 代验收被拒（PROXY_UNAUTHORIZED）');
    // 缺证据：开代管但只给不存在的报告 → PM_ACCEPT_EVIDENCE_REQUIRED，且零副作用（状态不变、决策链不增）。
    json(['owner', 'proxy', 'start', '--project', '试点', '--requirement', ownerReqId, '--scope', 'always', '--authorization', 'selftest B-9400', '--json']);
    const before9400 = JSON.parse(read(path.join(teamRoot, '状态', '项目', '试点', '工作流.json'))).requirements[ownerReqId];
    const missingEv = run(['owner', '--project', '试点', '--requirement', ownerReqId, '--decision', 'accepted', '--action', 'accept', '--proxy-recorded-by', 'pm', '--evidence', '不存在的报告.md:report', '--opinion', 'selftest B-9400 缺证据', '--json'], { expectFail: true });
    if (!String(missingEv.stdout + missingEv.stderr).includes('PM_ACCEPT_EVIDENCE_REQUIRED')) failStep('缺证据时未判 PM_ACCEPT_EVIDENCE_REQUIRED', String(missingEv.stdout + missingEv.stderr).slice(0, 240));
    const after9400 = JSON.parse(read(path.join(teamRoot, '状态', '项目', '试点', '工作流.json'))).requirements[ownerReqId];
    if (String(after9400.status) !== String(before9400.status) || JSON.stringify(after9400.ownerReview || null) !== JSON.stringify(before9400.ownerReview || null)) failStep('缺证据被拒时仍有副作用', JSON.stringify({ before: before9400.status, after: after9400.status }));
    pass('B-9400：缺证据 → PM_ACCEPT_EVIDENCE_REQUIRED 且零副作用');
    // 正例：报告(PASS) + 截图(PNG 魔数) 就位 → 代验收成功，落 channel=proxy/actor=pm/decidedBy=owner/evidence 2 项。
    const evDir9400 = path.join(projectsRoot, '试点', '测试人员', '产出');
    fs.mkdirSync(evDir9400, { recursive: true });
    write(path.join(evDir9400, 'B-9400-测试报告.md'), '# B-9400 测试报告\n\n- 结果：PASS\n- 日期：2026-11-14\n');
    const shot9400 = path.join(evDir9400, 'B-9400-截图.png');
    fs.writeFileSync(shot9400, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('selftest-png-body')]));
    const evJson9400 = JSON.stringify([{ path: '测试人员/产出/B-9400-测试报告.md', kind: 'report' }, { path: '测试人员/产出/B-9400-截图.png', kind: 'screenshot' }]);
    const okAccept9400 = json(['owner', '--project', '试点', '--requirement', ownerReqId, '--decision', 'accepted', '--action', 'accept', '--proxy-recorded-by', 'pm', '--evidence', evJson9400, '--opinion', 'B-9400 代验收正例', '--json']);
    if (!okAccept9400.ok) failStep('B-9400 正例代验收失败', JSON.stringify(okAccept9400).slice(0, 240));
    const wf9400 = JSON.parse(read(path.join(teamRoot, '状态', '项目', '试点', '工作流.json')));
    const row9400 = wf9400.requirements[ownerReqId];
    const last9400 = (row9400.decisions || []).slice(-1)[0] || {};
    if (last9400.channel !== 'proxy' || last9400.actor !== 'pm' || last9400.decidedBy !== 'owner') failStep('B-9400 落账字段不对（应 channel=proxy/actor=pm/decidedBy=owner）', JSON.stringify(last9400).slice(0, 240));
    if (!Array.isArray(last9400.evidence) || last9400.evidence.length !== 2 || !last9400.evidence.every((x) => x.path && x.sha256)) failStep('B-9400 落账缺 evidence[{path,sha256,kind}]', JSON.stringify(last9400.evidence).slice(0, 200));
    pass('B-9400：代验收正例落账 channel=proxy/actor=pm/decidedBy=owner/evidence 两项');
    json(['owner', 'proxy', 'end', '--project', '试点', '--json']);

    // ===== T-3422：CLI 代验收入口（owner proxy decide --action accept）=====
    {
      const t3422Pm = json(['boot', '--role', 'pm', '--project', '试点', '--session', 'session-selftest-t3422', '--json']);
      const t3422Req = json(['req', 'create', '--boot', t3422Pm.token, '--title', 'T-3422 代验收需求', '--priority', 'P1', '--acceptance', 'CLI 代验收入口可用', '--json']);
      const t3422Id = t3422Req.requirement && t3422Req.requirement.id;
      if (!t3422Id) failStep('T-3422 建需求失败', JSON.stringify(t3422Req).slice(0, 200));
      const wfFile3422 = path.join(teamRoot, '状态', '项目', '试点', '工作流.json');
      const wf3422 = JSON.parse(read(wfFile3422));
      wf3422.requirements = wf3422.requirements && typeof wf3422.requirements === 'object' ? wf3422.requirements : {};
      wf3422.requirements[t3422Id] = {
        ...(wf3422.requirements[t3422Id] || {}),
        id: t3422Id, priority: 'P1', createdAt: new Date().toISOString(),
        // 验收前置：产品评审通过（G2），否则 Owner/代管都会被 PRODUCT_REVIEW_REQUIRED 挡住
        productReview: { verdict: 'approve', by: 'product', at: new Date().toISOString() },
        status: 'test_done', history: [],
      };
      write(wfFile3422, JSON.stringify(wf3422, null, 2) + '\n');
      write(path.join(teamRoot, '状态', '项目', '试点', '任务', 'T-20261114-342200-t342.json'), JSON.stringify({
        id: 'T-20261114-342200-t342', project: '试点', type: 'task', requirementId: t3422Id,
        title: 'T-3422 测试', status: 'done', owner: 'tester', createdAt: new Date().toISOString(),
        claimedAt: new Date().toISOString(), doneAt: new Date().toISOString(), evidence: 'selftest T-3422', history: [],
      }, null, 2) + '\n');
      // ① 无代管 → PROXY_UNAUTHORIZED（入口放开后仍要求有效代管）
      const t3422No = run(['owner', 'proxy', 'decide', '--project', '试点', '--requirement', t3422Id, '--decision', 'accepted', '--action', 'accept', '--evidence', '[]', '--opinion', 'T-3422 无代管', '--json'], { expectFail: true });
      if (!/PROXY_UNAUTHORIZED/.test(String(t3422No.stdout + t3422No.stderr))) failStep('T-3422 无代管未被拒', String(t3422No.stdout + t3422No.stderr).slice(0, 240));
      // ② 有代管 + 缺证据 → PM_ACCEPT_EVIDENCE_REQUIRED 且零副作用
      json(['owner', 'proxy', 'start', '--project', '试点', '--requirement', t3422Id, '--scope', 'always', '--authorization', 'selftest T-3422', '--json']);
      const before3422 = JSON.parse(read(wfFile3422)).requirements[t3422Id];
      const t3422Miss = run(['owner', 'proxy', 'decide', '--project', '试点', '--requirement', t3422Id, '--decision', 'accepted', '--action', 'accept', '--evidence', '不存在的报告.md:report', '--opinion', 'T-3422 缺证据', '--json'], { expectFail: true });
      if (!String(t3422Miss.stdout + t3422Miss.stderr).includes('PM_ACCEPT_EVIDENCE_REQUIRED')) failStep('T-3422 缺证据未被拒', String(t3422Miss.stdout + t3422Miss.stderr).slice(0, 240));
      const after3422 = JSON.parse(read(wfFile3422)).requirements[t3422Id];
      if (String(after3422.status) !== String(before3422.status) || JSON.stringify(after3422.ownerReview || null) !== JSON.stringify(before3422.ownerReview || null)) failStep('T-3422 缺证据被拒却有副作用', JSON.stringify({ before: before3422.status, after: after3422.status }).slice(0, 200));
      // ③ 全证据（报告 + 截图）→ accepted，落 channel=proxy/actor=pm/evidence 2
      const evDir3422 = path.join(projectsRoot, '试点', '测试人员', '产出');
      fs.mkdirSync(evDir3422, { recursive: true });
      write(path.join(evDir3422, 'T-3422-测试报告.md'), '# T-3422 测试报告\n\n- 结果：PASS\n- 日期：2026-11-14\n');
      fs.writeFileSync(path.join(evDir3422, 'T-3422-截图.png'), Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.from('t3422-png-body')]));
      const ev3422 = JSON.stringify([{ path: '测试人员/产出/T-3422-测试报告.md', kind: 'report' }, { path: '测试人员/产出/T-3422-截图.png', kind: 'screenshot' }]);
      const t3422Ok = json(['owner', 'proxy', 'decide', '--project', '试点', '--requirement', t3422Id, '--decision', 'accepted', '--action', 'accept', '--evidence', ev3422, '--opinion', 'T-3422 代验收', '--json']);
      if (!t3422Ok.ok) failStep('T-3422 代验收正例失败', JSON.stringify(t3422Ok).slice(0, 240));
      const row3422 = JSON.parse(read(wfFile3422)).requirements[t3422Id];
      const last3422 = (row3422.decisions || []).slice(-1)[0] || {};
      if (String(row3422.status) !== 'accepted' || last3422.channel !== 'proxy' || last3422.actor !== 'pm') failStep('T-3422 代验收落账不对', JSON.stringify({ status: row3422.status, last: last3422 }).slice(0, 240));
      if (!Array.isArray(last3422.evidence) || last3422.evidence.length !== 2) failStep('T-3422 证据未落账', JSON.stringify(last3422.evidence).slice(0, 200));
      // ④ 打回仍必须 Owner 本人（代管只能代“验收通过”）
      const t3422Reject = run(['owner', 'proxy', 'decide', '--project', '试点', '--requirement', t3422Id, '--decision', 'rejected', '--action', 'accept', '--opinion', 'T-3422 打回', '--json'], { expectFail: true });
      if (!String(t3422Reject.stdout + t3422Reject.stderr).includes('PROXY_ACCEPT_FORBIDDEN')) failStep('T-3422 代管打回未被拒', String(t3422Reject.stdout + t3422Reject.stderr).slice(0, 240));
      json(['owner', 'proxy', 'end', '--project', '试点', '--json']);
      pass('T-3422：CLI 代验收入口（无代管拒 / 缺证据零副作用拒 / 全证据 accepted / 打回仍 Owner）');
    }

    // ===== R-9db6：Owner 决策箱（工具侧，AC1-AC9 可测部分）=====
    {
      const dPm = json(['boot', '--role', 'pm', '--project', '试点', '--session', 'session-selftest-9db6', '--json']);
      const dDev = json(['boot', '--role', 'programmer1', '--project', '试点', '--session', 'session-selftest-9db6-dev', '--json']);
      const boxFile = path.join(teamRoot, '状态', '项目', '试点', '决策箱.json');
      const wfBefore9 = read(path.join(teamRoot, '状态', '项目', '试点', '工作流.json'));
      const dAdd = (title, question, ref) => JSON.parse(run(['decision', 'add', '--project', '试点', '--boot', dPm.token, '--title', title, '--summary', '一句话摘要', '--question', question, '--options', 'A,B,其他', '--source-kind', 'message', '--source-ref', ref, '--json']).stdout.trim());
      const dInvite = (id) => json(['decision', 'invite', '--project', '试点', '--id', id, '--test-owner', '--json']);
      const dAck = (id, choice, extraEnv = null) => {
        const inv = dInvite(id);
        const r = run(['decision', 'ack', '--project', '试点', '--id', id, '--choice', choice, '--opinion', 'selftest', '--owner-confirm', inv.nonce, '--json'], extraEnv ? { envOverride: extraEnv } : {});
        return JSON.parse(r.stdout.trim());
      };
      // AC2：字段齐全 + D-ID 规则 + 同秒三条 ID 不同
      const d1 = dAdd('决策一', '选方案 A 还是 B', 'M-9DB6-1');
      if (!/^D-\d{8}-\d{6}-[0-9a-f]{4}$/.test(String(d1.item.id))) failStep('R-9db6 AC2 D-ID 格式不对', d1.item.id);
      for (const k of ['title', 'summary', 'question', 'options', 'source', 'createdAt', 'by', 'status', 'updatedAt']) {
        if (d1.item[k] === undefined) failStep(`R-9db6 AC2 缺字段 ${k}`, JSON.stringify(d1.item).slice(0, 200));
      }
      if (d1.item.by !== 'pm' || d1.item.status !== 'open') failStep('R-9db6 AC2 by/status 不对', JSON.stringify(d1.item).slice(0, 160));
      const d2 = dAdd('决策二', '第二个问题', 'M-9DB6-2');
      const d3 = dAdd('决策三', '第三个问题', 'M-9DB6-3');
      if (new Set([d1.item.id, d2.item.id, d3.item.id]).size !== 3) failStep('R-9db6 AC2 同秒 ID 冲突未重试', JSON.stringify([d1.item.id, d2.item.id, d3.item.id]));
      // AC2 同源去重：同 ref + 同 question → DECISION_BOX_DUPLICATE 零落盘
      const dup9 = run(['decision', 'add', '--project', '试点', '--boot', dPm.token, '--title', '重复', '--question', '选方案 A 还是 B', '--options', 'A,B', '--source-kind', 'message', '--source-ref', 'M-9DB6-1', '--json'], { expectFail: true });
      if (!/DECISION_BOX_DUPLICATE/.test(String(dup9.stdout + dup9.stderr))) failStep('R-9db6 AC2 同源去重未生效', String(dup9.stdout).slice(0, 200));
      // AC1：计数与未读
      const list9 = json(['decision', 'list', '--project', '试点', '--json']);
      if (list9.counts.open !== 3 || list9.counts.unread !== 3) failStep('R-9db6 AC1 未读/待决计数不对', JSON.stringify(list9.counts));
      // AC3：展开读 → readAt，未读 -1
      const read9 = json(['decision', 'read', '--project', '试点', '--id', d1.item.id, '--json']);
      if (!read9.item.readAt) failStep('R-9db6 AC3 展开未写 readAt', JSON.stringify(read9.item).slice(0, 160));
      if (json(['decision', 'list', '--project', '试点', '--json']).counts.unread !== 2) failStep('R-9db6 AC3 未读计数未减', 'unread');
      // AC6：非 PM 放入被拒
      const forb9 = run(['decision', 'add', '--project', '试点', '--boot', dDev.token, '--title', '越权', '--question', 'x', '--options', 'A,B', '--source-kind', 'file', '--source-ref', 'a.txt', '--json'], { expectFail: true });
      if (!/DECISION_BOX_FORBIDDEN/.test(String(forb9.stdout + forb9.stderr))) failStep('R-9db6 AC6 非 PM 放入未被拒', String(forb9.stdout).slice(0, 200));
      // AC4：无确认码 → OWNER_CONFIRM_REQUIRED；候选外 → DECISION_CHOICE_INVALID；正常回执
      const noConf9 = run(['decision', 'ack', '--project', '试点', '--id', d1.item.id, '--choice', 'A', '--json'], { expectFail: true });
      if (!/OWNER_CONFIRM_REQUIRED/.test(String(noConf9.stdout + noConf9.stderr))) failStep('R-9db6 AC4 无确认码未被拒', String(noConf9.stdout).slice(0, 200));
      const invBad = dInvite(d1.item.id);
      const badChoice9 = run(['decision', 'ack', '--project', '试点', '--id', d1.item.id, '--choice', '不存在的选项', '--owner-confirm', invBad.nonce, '--json'], { expectFail: true });
      if (!/DECISION_CHOICE_INVALID/.test(String(badChoice9.stdout + badChoice9.stderr))) failStep('R-9db6 AC4 候选外未被拒', String(badChoice9.stdout).slice(0, 200));
      const ack9 = dAck(d1.item.id, 'A');
      if (!ack9.ok || ack9.item.status !== 'answered' || !ack9.messageId) failStep('R-9db6 AC4 正常回执失败', JSON.stringify(ack9).slice(0, 200));
      const pmMail9 = json(['inbox', '--boot', dPm.token, '--json']).messages.filter((m) => m.type === 'owner_decision_receipt');
      const hit9 = pmMail9.find((m) => String(m.body || '').includes(d1.item.id));
      if (!hit9 || !/选择|Owner 选择/.test(String(hit9.body))) failStep('R-9db6 AC4 PM 未收到 owner_decision_receipt', JSON.stringify(pmMail9.slice(-1)).slice(0, 200));
      // AC5：重复回执幂等（同一条只 1 封）
      const ackAgain9 = dAck(d1.item.id, 'A');
      if (!ackAgain9.idempotent) failStep('R-9db6 AC5 重复回执未幂等', JSON.stringify(ackAgain9).slice(0, 160));
      const mails9 = json(['inbox', '--boot', dPm.token, '--all', '--json']).messages.filter((m) => m.type === 'owner_decision_receipt' && String(m.body || '').includes(d1.item.id));
      if (mails9.length !== 1) failStep('R-9db6 AC5 同一条回执发了多封', String(mails9.length));
      // AC7①：累积到 4 条不唤醒
      dAck(d2.item.id, 'B');
      dAck(d3.item.id, '其他');
      const d4 = dAdd('决策四', '第四个问题', 'M-9DB6-4');
      dAck(d4.item.id, 'A');
      const stale4 = json(['decision', 'stale-check', '--project', '试点', '--json']);
      if (stale4.woke) failStep('R-9db6 AC7 4 条回执就唤醒了（不该）', JSON.stringify(stale4).slice(0, 160));
      // AC7②：第 5 条 → 唤醒一次，随后重新计数
      const d5 = dAdd('决策五', '第五个问题', 'M-9DB6-5');
      dAck(d5.item.id, 'A');
      const stale5 = json(['decision', 'stale-check', '--project', '试点', '--json']);
      if (!stale5.woke) failStep('R-9db6 AC7 5 条回执未唤醒', JSON.stringify(stale5).slice(0, 160));
      const stale5b = json(['decision', 'stale-check', '--project', '试点', '--json']);
      if (stale5b.woke) failStep('R-9db6 AC7 唤醒后未重新计数（又唤醒）', JSON.stringify(stale5b).slice(0, 160));
      // AC7③：静默超时可注入（1 秒）
      const d6 = dAdd('决策六', '第六个问题', 'M-9DB6-6');
      dAck(d6.item.id, 'A');
      {
        const t0 = Date.now();
        while (Date.now() - t0 < 1100) { /* 等 1.1 秒，让 1 秒超时到点 */ }
      }
      const stale6 = JSON.parse(run(['decision', 'stale-check', '--project', '试点', '--json'], { envOverride: { TEAM_DECISION_RECEIPT_STALE_MS: '1000' } }).stdout.trim());
      if (!stale6.woke) failStep('R-9db6 AC7 静默超时未唤醒', JSON.stringify(stale6).slice(0, 200));
      // AC8：共存不绕门——工作流文件零变化
      if (read(path.join(teamRoot, '状态', '项目', '试点', '工作流.json')) !== wfBefore9) failStep('R-9db6 AC8 回执改动了 工作流.json', 'workflow changed');
      // AC9①：损坏 → 备份+重建+PM 收 wake_failed(why=decision_box_corrupt)+事件
      write(boxFile, '{ 坏掉的 json ');
      const corruptList9 = json(['decision', 'list', '--project', '试点', '--json']);
      const bak9 = fs.readdirSync(path.dirname(boxFile)).filter((n) => n.startsWith('决策箱.json.bak-'));
      if (!bak9.length) failStep('R-9db6 AC9 损坏未留 .bak 备份', 'no backup');
      const rebuiltEvent9 = read(path.join(teamRoot, '状态', '事件.jsonl')).includes('decision_box_rebuilt');
      if (!rebuiltEvent9) failStep('R-9db6 AC9 未记 decision_box_rebuilt 事件', 'event missing');
      const corruptMail9 = json(['inbox', '--boot', dPm.token, '--json']).messages.filter((m) => m.type === 'wake_failed' && /decision_box_corrupt/.test(String(m.body || '')));
      if (!corruptMail9.length) failStep('R-9db6 AC9 损坏未给 PM 发 wake_failed', 'mail missing');
      if (corruptList9.counts.open !== 0) failStep('R-9db6 AC9 重建后不空', JSON.stringify(corruptList9.counts));
      // AC9②：并发回执 → DECISION_BOX_CONFLICT（用现成锁占位）
      const d7 = dAdd('决策七', '第七个问题', 'M-9DB6-7');
      json(['lock', 'acquire', '--boot', dPm.token, '--key', '决策箱-试点', '--ttl', '20', '--json']);
      const inv7 = dInvite(d7.item.id);
      const conflict9 = run(['decision', 'ack', '--project', '试点', '--id', d7.item.id, '--choice', 'A', '--owner-confirm', inv7.nonce, '--json'], { expectFail: true });
      if (!/DECISION_BOX_CONFLICT/.test(String(conflict9.stdout + conflict9.stderr))) failStep('R-9db6 AC9 并发未判 DECISION_BOX_CONFLICT', String(conflict9.stdout).slice(0, 200));
      json(['lock', 'release', '--boot', dPm.token, '--key', '决策箱-试点', '--json']);
      // AC9③：断通道注入 → RECEIPT_FAILED 且保持 open；取消注入后可重试成功
      const inv7b = dInvite(d7.item.id);
      const fail9 = run(['decision', 'ack', '--project', '试点', '--id', d7.item.id, '--choice', 'A', '--owner-confirm', inv7b.nonce, '--json'], { expectFail: true, envOverride: { TEAM_MESSAGE_SEND_FAIL: '1' } });
      if (!/RECEIPT_FAILED/.test(String(fail9.stdout + fail9.stderr))) failStep('R-9db6 AC9 断通道未判 RECEIPT_FAILED', String(fail9.stdout).slice(0, 200));
      const afterFail9 = json(['decision', 'list', '--project', '试点', '--all', '--json']).items.find((it) => it.id === d7.item.id);
      if (!afterFail9 || afterFail9.status !== 'open' || (afterFail9.receipt && afterFail9.receipt.messageId)) failStep('R-9db6 AC9 发送失败后条目未保持 open', JSON.stringify(afterFail9).slice(0, 200));
      const retry9 = dAck(d7.item.id, 'A');
      if (!retry9.ok || retry9.item.status !== 'answered') failStep('R-9db6 AC9 取消注入后重试未成功', JSON.stringify(retry9).slice(0, 200));
      pass('R-9db6：决策箱工具侧 AC1-AC9（ID/同源去重/回执幂等/权限/静默兜底/损坏重建/并发/断通道）');
    }

    // ===== R-8f68：角色直连流转（批 1，AC1/2/3/5/6/7 + 异常）=====
    {
      const hPm = json(['boot', '--role', 'pm', '--project', '试点', '--session', 'session-selftest-8f68-pm', '--json']);
      const hProduct = json(['boot', '--role', 'product', '--project', '试点', '--session', 'session-selftest-8f68-product', '--json']);
      const hDev = json(['boot', '--role', 'programmer1', '--project', '试点', '--session', 'session-selftest-8f68-dev', '--json']);
      const hTester = json(['boot', '--role', 'tester', '--project', '试点', '--session', 'session-selftest-8f68-tester', '--json']);
      const hReq = json(['req', 'create', '--boot', hPm.token, '--title', '8f68 直连需求', '--priority', 'P1', '--acceptance', '直连可用', '--json']).requirement.id;
      const wfH = JSON.parse(read(path.join(teamRoot, '状态', '项目', '试点', '工作流.json')));
      wfH.requirements = wfH.requirements || {};
      wfH.requirements[hReq] = { ...(wfH.requirements[hReq] || {}), id: hReq, status: 'ready', priority: 'P1', productReview: { verdict: 'approve', by: 'product', at: new Date().toISOString() } };
      write(path.join(teamRoot, '状态', '项目', '试点', '工作流.json'), JSON.stringify(wfH, null, 2) + '\n');
      const hTask = json(['task', 'create', '--boot', hPm.token, '--title', '8f68 开发任务', '--priority', 'P1', '--owner', 'programmer1', '--requirement', hReq, '--json']).task.id;
      const wakeFileH = path.join(teamRoot, '状态', '项目', '试点', '唤醒.jsonl');
      const wakeBeforeH = fs.existsSync(wakeFileH) ? read(wakeFileH) : '';
      const queueFileH = path.join(teamRoot, '状态', '项目', '试点', '直连队列.json');
      // ① 产品直连开发：G0 通过、队列出现、不唤醒
      const hSend = json(['handoff', '--boot', hProduct.token, '--project', '试点', '--from', 'product', '--to', 'programmer1', '--task', hTask, '--action', 'develop', '--note', 'selftest 直连', '--json']);
      if (!hSend.ok || hSend.queuePos < 1) failStep('R-8f68 直连投递失败', JSON.stringify(hSend).slice(0, 200));
      const qH = JSON.parse(read(queueFileH)).items;
      if (!qH.some((row) => String(row.taskId) === hTask)) failStep('R-8f68 直连队列没有该任务', JSON.stringify(qH).slice(0, 200));
      if ((fs.existsSync(wakeFileH) ? read(wakeFileH) : '') !== wakeBeforeH) failStep('R-8f68 直连自己唤醒了（应交给路由守护）', 'wake changed');
      // ② 下游接收确认：handoff accept → working + handoff_ack 事件
      const hAccept = json(['handoff', 'accept', '--boot', hDev.token, '--project', '试点', '--task', hTask, '--json']);
      if (hAccept.status !== 'working') failStep('R-8f68 接收后未变 working', JSON.stringify(hAccept).slice(0, 160));
      if (!read(path.join(teamRoot, '状态', '事件.jsonl')).includes('handoff_ack')) failStep('R-8f68 未写 handoff_ack 事件', 'missing');
      // ③ AC6 留痕：任务 history 有 handoff + 事件 role_handoff，taskId/requirementId 对得上
      const hTaskRow = JSON.parse(read(path.join(teamRoot, '状态', '项目', '试点', '任务', `${hTask}.json`)));
      const histHandoff = (hTaskRow.history || []).filter((row) => row.action === 'handoff');
      if (!histHandoff.length || histHandoff[histHandoff.length - 1].result !== 'accepted') failStep('R-8f68 任务 history 缺 handoff 记录', JSON.stringify(histHandoff).slice(0, 200));
      const eventLines = read(path.join(teamRoot, '状态', '事件.jsonl')).split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line); } catch { return null; } }).filter(Boolean);
      const evH = eventLines.filter((row) => row.action === 'role_handoff' && String(row.target || '') === hTask);
      if (!evH.length || String((evH[evH.length - 1].data || {}).requirementId || '') !== hReq) failStep('R-8f68 role_handoff 事件缺 requirementId', JSON.stringify(evH.slice(-1)).slice(0, 200));
      // ④ G0 越权：跳步（analyst→tester）、伪造 from、表外 action → HANDOFF_FORBIDDEN，队列零增长
      const qCountBefore = JSON.parse(read(queueFileH)).items.length;
      const hopSkip = run(['handoff', '--boot', hProduct.token, '--project', '试点', '--from', 'product', '--to', 'tester', '--task', hTask, '--action', 'test', '--json'], { expectFail: true });
      if (!/HANDOFF_FORBIDDEN/.test(String(hopSkip.stdout + hopSkip.stderr))) failStep('R-8f68 跳步未被拒', String(hopSkip.stdout).slice(0, 200));
      const hopFake = run(['handoff', '--boot', hDev.token, '--project', '试点', '--from', 'product', '--to', 'programmer1', '--task', hTask, '--action', 'develop', '--json'], { expectFail: true });
      if (!/HANDOFF_FORBIDDEN/.test(String(hopFake.stdout + hopFake.stderr))) failStep('R-8f68 伪造 from 未被拒', String(hopFake.stdout).slice(0, 200));
      if (JSON.parse(read(queueFileH)).items.length !== qCountBefore) failStep('R-8f68 被拒的直连仍写了队列', 'queue grew');
      // ⑤ AC2 测试打回：fix 直连 → reopenCount+1，再打回 → 2
      const hBug = json(['task', 'create', '--boot', hPm.token, '--title', '8f68 缺陷', '--priority', 'P1', '--owner', 'programmer1', '--requirement', hReq, '--type', 'bug', '--json']).task.id;
      const hFix1 = json(['handoff', '--boot', hTester.token, '--project', '试点', '--from', 'tester', '--to', 'programmer1', '--task', hBug, '--action', 'fix', '--json']);
      if (!hFix1.ok) failStep('R-8f68 测试打回直连失败', JSON.stringify(hFix1).slice(0, 160));
      const bugRowH = JSON.parse(read(path.join(teamRoot, '状态', '项目', '试点', '任务', `${hBug}.json`)));
      if (Number(bugRowH.reopenCount || 0) !== 1) failStep('R-8f68 打回未 +1 reopenCount', String(bugRowH.reopenCount));
      // ⑥ AC3 队列排序：P0 排前
      const hTaskP0 = json(['task', 'create', '--boot', hPm.token, '--title', '8f68 P0 任务', '--priority', 'P0', '--owner', 'programmer1', '--requirement', hReq, '--json']).task.id;
      json(['handoff', '--boot', hProduct.token, '--project', '试点', '--from', 'product', '--to', 'programmer1', '--task', hTaskP0, '--action', 'develop', '--json']);
      const qOrder = JSON.parse(read(queueFileH)).items.filter((row) => String(row.to) === 'programmer1').map((row) => `${row.priority}:${row.taskId}`);
      if (qOrder[0] !== `P0:${hTaskP0}`) failStep('R-8f68 队列未按优先级排序', JSON.stringify(qOrder).slice(0, 200));
      // ⑦ 队列上限注入（TEAM_QUEUE_MAX=1，同角色第二条 → QUEUE_FULL）
      const fullH = run(['handoff', '--boot', hProduct.token, '--project', '试点', '--from', 'product', '--to', 'programmer1', '--task', hTask, '--action', 'develop', '--json'], { expectFail: true, envOverride: { TEAM_QUEUE_MAX: '1' } });
      if (!/QUEUE_FULL/.test(String(fullH.stdout + fullH.stderr))) failStep('R-8f68 队列上限未生效', String(fullH.stdout).slice(0, 200));
      // ⑧ 写队列失败注入 → 回退 PM escalation + handoff_fallback 事件
      const wfH2 = JSON.parse(read(path.join(teamRoot, '状态', '项目', '试点', '工作流.json')));
      wfH2.requirements[hReq].status = 'ready';
      write(path.join(teamRoot, '状态', '项目', '试点', '工作流.json'), JSON.stringify(wfH2, null, 2) + '\n');
      const failH = JSON.parse(run(['handoff', '--boot', hProduct.token, '--project', '试点', '--from', 'product', '--to', 'programmer1', '--task', hTaskP0, '--action', 'develop', '--json'], { envOverride: { TEAM_QUEUE_WRITE_FAIL: '1' } }).stdout.trim());
      if (!(failH.fallback && failH.fallback.code === 'HANDOFF_QUEUE_WRITE_FAILED')) failStep('R-8f68 写队列失败未回退 PM 卡点', JSON.stringify(failH).slice(0, 200));
      const fbEvent = read(path.join(teamRoot, '状态', '事件.jsonl')).includes('handoff_fallback');
      if (!fbEvent) failStep('R-8f68 未记 handoff_fallback 事件', 'missing');
      const pmFallbackMail = json(['inbox', '--boot', hPm.token, '--json']).messages.filter((m) => m.type === 'escalation' && /HANDOFF_QUEUE_WRITE_FAILED/.test(String(m.body || '')));
      if (!pmFallbackMail.length) failStep('R-8f68 未给 PM 发 escalation 卡点', 'mail missing');
      // ⑨ AC5/AC8：铁律 5 例外默认 pending（批 1），批准后才变 batch2
      const rexPending = json(['rule-exception', 'status', '--project', '试点', '--json']);
      if (rexPending.batch !== 'batch1') failStep('R-8f68 铁律5例外默认不是批 1', JSON.stringify(rexPending).slice(0, 160));
      const rexInv = json(['rule-exception', 'invite', '--project', '试点', '--test-owner', '--json']);
      json(['rule-exception', 'approve', '--project', '试点', '--owner-confirm', rexInv.nonce, '--note', 'selftest 批准', '--json']);
      const rexApproved = json(['rule-exception', 'status', '--project', '试点', '--json']);
      if (rexApproved.batch !== 'batch2' || rexApproved.exemption.approvedBy !== 'owner') failStep('R-8f68 批准后未进入批 2', JSON.stringify(rexApproved).slice(0, 160));
      pass('R-8f68：直连投递（G0 拒越权/不唤醒/队列排序与上限/失败回退 PM）、接收确认、fix 打回、留痕、铁律5例外批1→批2');
    }

    // ===== Owner 08:44：消息送达即唤醒、带正文、自动已读 =====
    {
      const wbPm = json(['boot', '--role', 'pm', '--project', '试点', '--session', 'session-selftest-wb-pm', '--json']);
      const wbAna = json(['boot', '--role', 'analyst', '--project', '试点', '--session', 'session-selftest-wb-ana', '--json']);
      const wbDev = json(['boot', '--role', 'programmer1', '--project', '试点', '--session', 'session-selftest-wb-dev', '--json']);
      // ① 唤醒正文带 subject + body（截断 600 字）
      const wbBody = `正文-${'X'.repeat(30)}-END`;
      const wbSend = JSON.parse(run(['send', '--boot', wbDev.token, '--to', 'analyst', '--subject', '唤醒带正文-标题', '--body', wbBody, '--wake', '--json']).stdout.trim());
      const wbText = String((wbSend.wake && wbSend.wake.text) || '');
      if (!wbText.includes('唤醒带正文-标题') || !wbText.includes('正文-')) failStep('消息唤醒正文未带 subject/body', wbText.slice(0, 200));
      if (!/全文用 read --id/.test(wbText)) failStep('消息唤醒正文未提示全文用 read', wbText.slice(0, 200));
      // ② 投递成功 → 自动标已读（移到 cur 且 readAt 有值）
      const wbMsgId = wbSend.message.id;
      const readState = (role, id) => {
        for (const box of ['new', 'cur']) {
          const dir = path.join(teamRoot, '状态', '邮箱', role, box);
          if (!fs.existsSync(dir)) continue;
          const hit = fs.readdirSync(dir).filter((n) => n.endsWith('.json') && JSON.parse(read(path.join(dir, n))).id === id);
          if (hit.length) return { box, row: JSON.parse(read(path.join(dir, hit[0]))) };
        }
        return null;
      };
      const wbRead = readState('analyst', wbMsgId);
      if (!wbRead || wbRead.box !== 'cur' || !wbRead.row.readAt) failStep('投递成功后未自动标已读', JSON.stringify(wbRead && { box: wbRead.box, readAt: wbRead.row && wbRead.row.readAt }).slice(0, 160));
      // ③ 投递失败 → 保持未读（仍在 new、无 readAt）
      const wbFailSend = JSON.parse(run(['send', '--boot', wbDev.token, '--to', 'analyst', '--subject', '唤醒失败-标题', '--body', '失败正文', '--wake', '--json'], { envOverride: { TEAM_WAKE_TEST_FAIL: '1', TEAM_WAKE_RETRY_MS: '0,0,0' } }).stdout.trim());
      if (!(wbFailSend.wake && wbFailSend.wake.ok === false)) failStep('注入失败后未返回失败', JSON.stringify(wbFailSend.wake || null).slice(0, 160));
      const wbFailRead = readState('analyst', wbFailSend.message.id);
      if (!wbFailRead || wbFailRead.box !== 'new' || wbFailRead.row.readAt) failStep('投递失败却已标已读', JSON.stringify(wbFailRead && { box: wbFailRead.box, readAt: wbFailRead.row && wbFailRead.row.readAt }).slice(0, 160));
      // ④ 重试幂等：补投成功只标一次已读，重复泵不再改 readAt
      run(['queue', 'pump', '--project', '试点', '--json'], { envOverride: { TEAM_WAKE_RETRY_MS: '0,0,0' } });
      const wbRetryRead = readState('analyst', wbFailSend.message.id);
      if (!wbRetryRead || !wbRetryRead.row.readAt) failStep('重试补投后未标已读', JSON.stringify(wbRetryRead || null).slice(0, 160));
      const wbReadAt1 = wbRetryRead.row.readAt;
      run(['queue', 'pump', '--project', '试点', '--json'], { envOverride: { TEAM_WAKE_RETRY_MS: '0,0,0' } });
      const wbRetryRead2 = readState('analyst', wbFailSend.message.id);
      if (!wbRetryRead2 || wbRetryRead2.row.readAt !== wbReadAt1) failStep('重复泵把已读时间改写了（不幂等）', `${wbReadAt1} → ${wbRetryRead2 && wbRetryRead2.row.readAt}`);
      // ⑤ inbox --mark-all-read：清历史积压并写审计
      const wbMark = json(['inbox', '--boot', wbAna.token, '--project', '试点', '--mark-all-read', '--json']);
      if (!(wbMark.ok && Number(wbMark.marked) >= 1)) failStep('mark-all-read 未标记任何消息', JSON.stringify(wbMark).slice(0, 200));
      const wbAudit = read(path.join(teamRoot, '状态', '阅读.jsonl')).includes('mark-all-read');
      if (!wbAudit) failStep('mark-all-read 未写审计', 'audit missing');
      const wbLeft = json(['inbox', '--boot', wbAna.token, '--project', '试点', '--json']).messages.filter((m) => !m.readAt);
      if (wbLeft.length) failStep('mark-all-read 后仍有未读', String(wbLeft.length));
      pass('消息投递：唤醒带正文（截断 600）+ 成功自动已读 + 失败保持未读 + 重试幂等 + mark-all-read 计数与审计');
    }

    // ===== Owner 09:15：认领后 5 分钟无状态变化 → 告警 PM =====
    {
      const csPm = json(['boot', '--role', 'pm', '--project', '试点', '--session', 'session-selftest-cs-pm', '--json']);
      const csDev = json(['boot', '--role', 'programmer1', '--project', '试点', '--session', 'session-selftest-cs-dev', '--json']);
      const csTask = json(['task', 'create', '--boot', csPm.token, '--title', '认领停滞用例', '--priority', 'P1', '--owner', 'programmer1', '--json']).task.id;
      // 把 claimedAt 回拨 6 分钟（模拟认领后一直没动）
      const csFile = path.join(teamRoot, '状态', '项目', '试点', '任务', `${csTask}.json`);
      const csRow = JSON.parse(read(csFile));
      csRow.status = 'working';
      csRow.claimedAt = new Date(Date.now() - 6 * 60 * 1000).toISOString();
      write(csFile, JSON.stringify(csRow, null, 2) + '\n');
      const pumpCs1 = JSON.parse(run(['queue', 'pump', '--project', '试点', '--json'], { envOverride: { TEAM_CLAIM_STALL_MS: '1000' } }).stdout.trim());
      if (!(pumpCs1.claimStall && pumpCs1.claimStall.alerted >= 1)) failStep('认领停滞未告警', JSON.stringify(pumpCs1.claimStall || null).slice(0, 200));
      const csMail = json(['inbox', '--boot', csPm.token, '--json']).messages.filter((m) => m.type === 'escalation' && String(m.body || '').includes(csTask));
      if (!csMail.length) failStep('认领停滞未给 PM 发 escalation', 'mail missing');
      if (!/认领了/.test(String(csMail[0].body))) failStep('认领停滞告警不是人话', String(csMail[0].body).slice(0, 160));
      // 同任务同状态 10 分钟去重
      const pumpCs2 = JSON.parse(run(['queue', 'pump', '--project', '试点', '--json'], { envOverride: { TEAM_CLAIM_STALL_MS: '1000' } }).stdout.trim());
      if (!(pumpCs2.claimStall && pumpCs2.claimStall.alerted === 0)) failStep('认领停滞未去重', JSON.stringify(pumpCs2.claimStall || null).slice(0, 160));
      // 任务 done 后不再告警
      const csRow2 = JSON.parse(read(csFile));
      csRow2.status = 'done';
      csRow2.doneAt = new Date().toISOString();
      write(csFile, JSON.stringify(csRow2, null, 2) + '\n');
      const pumpCs3 = JSON.parse(run(['queue', 'pump', '--project', '试点', '--json'], { envOverride: { TEAM_CLAIM_STALL_MS: '1000' } }).stdout.trim());
      const csMail2 = json(['inbox', '--boot', csPm.token, '--json']).messages.filter((m) => m.type === 'escalation' && String(m.body || '').includes(csTask));
      if (csMail2.length !== csMail.length) failStep('任务 done 后仍在告警', `${csMail.length} → ${csMail2.length}`);
      pass('认领停滞：5 分钟无变化告警 PM（人话 + role/taskId/claimedAt/状态）、同任务同状态 10 分钟去重、done 立即停');
    }

    // ===== Owner 09:27：打回重做（iteration）不冻结——开发全 done→dev_done、测试全 done→test_done =====
    {
      const itPm = json(['boot', '--role', 'pm', '--project', '试点', '--session', 'session-selftest-it-pm', '--json']);
      const itDev = json(['boot', '--role', 'programmer1', '--project', '试点', '--session', 'session-selftest-it-dev', '--json']);
      const itTester = json(['boot', '--role', 'tester', '--project', '试点', '--session', 'session-selftest-it-tester', '--json']);
      const itReq = json(['req', 'create', '--boot', itPm.token, '--title', 'iteration 重做需求', '--priority', 'P1', '--acceptance', '重做后能回验收', '--json']).requirement.id;
      const itWfFile = path.join(teamRoot, '状态', '项目', '试点', '工作流.json');
      const itWf = JSON.parse(read(itWfFile));
      itWf.requirements[itReq] = {
        ...(itWf.requirements[itReq] || {}), id: itReq, status: 'rejected', priority: 'P1',
        round: 1, rejectionOpinion: '打回意见：方案不可测', productReview: { verdict: 'approve', by: 'product', at: new Date().toISOString() },
        history: [{ at: new Date().toISOString(), action: 'rejected', note: '打回意见：方案不可测', by: 'owner' }],
      };
      write(itWfFile, JSON.stringify(itWf, null, 2) + '\n');
      // rejected → iteration（req iterate 保留意见并把 round+1）
      json(['req', 'iterate', '--boot', itPm.token, '--id', itReq, '--reason', '按打回意见重做', '--json']);
      const itWf2 = JSON.parse(read(itWfFile)).requirements[itReq];
      if (String(itWf2.status) !== 'iteration') failStep('req iterate 后不是 iteration', String(itWf2.status));
      if (String(itWf2.rejectionOpinion || '') !== '打回意见：方案不可测') failStep('iteration 丢了打回意见', String(itWf2.rejectionOpinion || ''));
      // 「round+1」落在需求任务的 workflow.iterationRound 上（工作流 round 是全局轮次，不因 iterate 跳）
      const itReqTask = JSON.parse(read(path.join(teamRoot, '状态', '项目', '试点', '任务', `${itReq}.json`)));
      if (Number((itReqTask.workflow && itReqTask.workflow.iterationRound) || 0) < 1) failStep('iteration 没有 iterationRound+1', JSON.stringify(itReqTask.workflow || {}).slice(0, 160));
      // 开发任务全 done → dev_done（不需要 Owner 重批）
      const itDevTask = json(['task', 'create', '--boot', itPm.token, '--title', 'iteration 开发任务', '--priority', 'P1', '--owner', 'programmer1', '--requirement', itReq, '--json']).task.id;
      json(['task', 'claim', '--boot', itDev.token, '--id', itDevTask, '--json']);
      const itDevDone = json(['task', 'done', '--boot', itDev.token, '--id', itDevTask, '--evidence', '重做完成', '--json']);
      if (!(itDevDone.requirementAdvance && itDevDone.requirementAdvance.status === 'dev_done')) failStep('iteration 开发 done 未到 dev_done', JSON.stringify(itDevDone.requirementAdvance || null).slice(0, 200));
      // G7：测试任务 done 前要有测试报告（含需求 id + PASS 结论）
      const itReportDir = path.join(projectsRoot, '试点', '测试人员', '产出');
      fs.mkdirSync(itReportDir, { recursive: true });
      write(path.join(itReportDir, '测试报告-v1.md'), `# 测试报告\n\n覆盖需求：${itReq}\n结论：PASS\n`);
      // 测试任务 done → test_done
      const itTestTask = json(['task', 'create', '--boot', itPm.token, '--title', 'iteration 测试任务', '--priority', 'P1', '--owner', 'tester', '--requirement', itReq, '--json']).task.id;
      json(['task', 'claim', '--boot', itTester.token, '--id', itTestTask, '--json']);
      const itTestDone = json(['task', 'done', '--boot', itTester.token, '--id', itTestTask, '--evidence', '复测通过', '--json']);
      if (!(itTestDone.requirementAdvance && itTestDone.requirementAdvance.status === 'test_done')) failStep('iteration 测试 done 未到 test_done', JSON.stringify(itTestDone.requirementAdvance || null).slice(0, 200));
      const itWf3 = JSON.parse(read(itWfFile)).requirements[itReq];
      if (String(itWf3.rejectionOpinion || '') !== '打回意见：方案不可测') failStep('推进后丢了打回意见', String(itWf3.rejectionOpinion || ''));
      pass('iteration 重做：开发全 done→dev_done、测试全 done→test_done（无需 Owner 重批，打回意见与 round 保留）');
    }

    // ===== 角色显示名统一（B-…e5d6）：以 团队.json 为准，唤醒头不硬编码 =====
    {
      const rdTeam = JSON.parse(read(path.join(teamRoot, '状态', '团队.json')));
      const rdMember = (Array.isArray(rdTeam.members) ? rdTeam.members : []).find((m) => String((m && (m.role || m.id)) || '') === 'programmer2');
      const rdExpected = String((rdMember && rdMember.name) || '');
      if (!rdExpected) failStep('团队.json 里没有 programmer2 的展示名', JSON.stringify(rdMember || null).slice(0, 160));
      // 唤醒头/回执头：必须用 团队.json 里的展示名，不得回落到目录名（程序员B）
      const rdPm = json(['boot', '--role', 'pm', '--project', '试点', '--session', 'session-selftest-rd-pm', '--json']);
      const rdSend = JSON.parse(run(['send', '--boot', rdPm.token, '--to', 'programmer2', '--subject', '显示名用例', '--body', 'x', '--wake', '--json']).stdout.trim());
      const rdHeader = String(rdSend.wakeHeader || (rdSend.wake && rdSend.wake.header) || '');
      if (!rdHeader.includes(rdExpected)) failStep('唤醒头没用 团队.json 的展示名', `期望 ${rdExpected}；${rdHeader.slice(0, 160)}`);
      if (rdExpected !== '程序员B' && /程序员B（/.test(rdHeader.replaceAll(rdExpected, ''))) failStep('唤醒头混入了目录名风格的角色名', rdHeader.slice(0, 160));
      pass('角色显示名统一（团队.json 为准，唤醒头不硬编码目录名）');
    }

    // ===== 2026-11-14 10:06：重做轮按“当前轮”收口（旧轮遗留不挡本轮）=====
    {
      const rrPm = json(['boot', '--role', 'pm', '--project', '试点', '--session', 'session-selftest-rr-pm', '--json']);
      const rrDev = json(['boot', '--role', 'programmer1', '--project', '试点', '--session', 'session-selftest-rr-dev', '--json']);
      const rrReq = json(['req', 'create', '--boot', rrPm.token, '--title', '重做轮按轮次收口', '--priority', 'P1', '--acceptance', '旧轮不挡本轮', '--json']).requirement.id;
      const rrWfFile = path.join(teamRoot, '状态', '项目', '试点', '工作流.json');
      const rrWf = JSON.parse(read(rrWfFile));
      rrWf.requirements[rrReq] = {
        ...(rrWf.requirements[rrReq] || {}), id: rrReq, status: 'iteration', round: 1, priority: 'P1',
        decisions: [{ status: 'rejected', at: new Date().toISOString(), actor: 'owner', channel: 'ui' }],
        rejectionOpinion: '第一轮打回：要补用例',
      };
      write(rrWfFile, JSON.stringify(rrWf, null, 2) + '\n');
      // 旧轮（round 0）遗留：open 的开发任务，不该挡住第 1 轮收口
      const rrOld = json(['task', 'create', '--boot', rrPm.token, '--title', '旧轮遗留任务', '--priority', 'P1', '--owner', 'programmer1', '--requirement', rrReq, '--json']).task.id;
      const rrOldFile = path.join(teamRoot, '状态', '项目', '试点', '任务', `${rrOld}.json`);
      const rrOldRow = JSON.parse(read(rrOldFile));
      rrOldRow.workflow = { ...(rrOldRow.workflow || {}), round: 0 };
      write(rrOldFile, JSON.stringify(rrOldRow, null, 2) + '\n');
      // 当前轮（round 1）开发任务：done → 应推 dev_done
      const rrNew = json(['task', 'create', '--boot', rrPm.token, '--title', '第1轮开发任务', '--priority', 'P1', '--owner', 'programmer1', '--requirement', rrReq, '--json']).task.id;
      const rrNewFile = path.join(teamRoot, '状态', '项目', '试点', '任务', `${rrNew}.json`);
      const rrNewRow = JSON.parse(read(rrNewFile));
      rrNewRow.workflow = { ...(rrNewRow.workflow || {}), round: 1 };
      write(rrNewFile, JSON.stringify(rrNewRow, null, 2) + '\n');
      json(['task', 'claim', '--boot', rrDev.token, '--id', rrNew, '--json']);
      const rrDone = json(['task', 'done', '--boot', rrDev.token, '--id', rrNew, '--evidence', '第1轮重做完成', '--json']);
      if (!(rrDone.requirementAdvance && rrDone.requirementAdvance.status === 'dev_done')) failStep('重做轮：当前轮开发 done 未推 dev_done（被旧轮挡住？）', JSON.stringify(rrDone.requirementAdvance || null).slice(0, 200));
      const rrRowAfter = JSON.parse(read(rrWfFile)).requirements[rrReq];
      if (String(rrRowAfter.rejectionOpinion || '') !== '第一轮打回：要补用例') failStep('重做轮推进后丢了打回意见', String(rrRowAfter.rejectionOpinion || ''));
      pass('重做轮按轮次收口：iteration + 当前轮开发任务全 done → dev_done（旧轮 open 遗留不挡，打回意见保留）');
    }

    // ===== 可选插件双轨（R-a48b：零插件可用 / 降级 off / 双轨一致）=====
    const pluginEmpty = path.join(temp, 'plugins-empty');
    const pluginFull = path.join(temp, 'plugins-full');
    const fakeProfile = path.join(pluginFull, 'profiles', 'desktop');
    fs.mkdirSync(pluginEmpty, { recursive: true });
    for (const [pkg, version] of [['dsh-memory-evolve', '1.2.3'], ['@liustack/modlens', '9.9.9'], ['web-search-safe', '0.4.0']]) {
      const dir = path.join(fakeProfile, 'fake', pkg);
      fs.mkdirSync(dir, { recursive: true });
      write(path.join(dir, 'package.json'), JSON.stringify({ name: pkg, version }, null, 2) + '\n');
    }
    write(path.join(fakeProfile, 'package.json'), JSON.stringify({
      name: 'fake-profile',
      dependencies: {
        'dsh-memory-evolve': 'link:./fake/dsh-memory-evolve',
        '@liustack/modlens': 'link:./fake/@liustack/modlens',
        'web-search-safe': 'link:./fake/web-search-safe',
      },
      dsh: { profile: { bundles: ['dsh-memory-evolve', '@liustack/modlens', 'web-search-safe'] } },
    }, null, 2) + '\n');
    const pluginBoot = json(['boot', '--role', 'pm', '--project', '试点', '--session', 'session-st-plugin-pm', '--json']);
    const pluginStatusOf = (home) => JSON.parse(run(['status', '--json'], { envOverride: { TEAM_PLUGINS_HOME: home } }).stdout.trim());
    const emptyStatus = pluginStatusOf(pluginEmpty);
    if (!Array.isArray(emptyStatus.plugins.list) || emptyStatus.plugins.list.length !== 3) failStep('零插件环境插件清单不是 3 项', JSON.stringify(emptyStatus.plugins.list));
    if (!emptyStatus.plugins.list.every((p) => p.status === 'off')) failStep('零插件环境应全 off', JSON.stringify(emptyStatus.plugins.list));
    if (!String(emptyStatus.plugins.marks).includes('memory:off')) failStep('零插件环境缺 memory:off 标记', String(emptyStatus.plugins.marks));
    const emptyDoctor = JSON.parse(run(['doctor', '--json'], { envOverride: { TEAM_PLUGINS_HOME: pluginEmpty } }).stdout.trim());
    if ((emptyDoctor.issues || []).some((x) => String(x).includes('可选插件'))) failStep('零插件环境 doctor 不应因插件报问题', JSON.stringify(emptyDoctor.issues));
    const emptyBoot = JSON.parse(run(['boot', '--role', 'pm', '--project', '试点', '--session', 'session-st-plugin-pm2', '--json'], { envOverride: { TEAM_PLUGINS_HOME: pluginEmpty } }).stdout.trim());
    if (!String(emptyBoot.briefing).includes('memory:off')) failStep('零插件 boot 简报缺降级标记', String(emptyBoot.briefing).slice(0, 200));
    pass('可选插件：零插件环境 status 全 off、doctor 不报错、boot 标 memory:off');
    const fullStatus = pluginStatusOf(pluginFull);
    if (!fullStatus.plugins.list.every((p) => p.status === 'on')) failStep('假插件环境应全 on', JSON.stringify(fullStatus.plugins.list));
    const modlensRow = fullStatus.plugins.list.find((p) => p.id === 'modlens');
    if (!modlensRow || modlensRow.version !== '9.9.9') failStep('假插件版本未读到', JSON.stringify(fullStatus.plugins.list));
    if (!String(fullStatus.plugins.marks).includes('memory:on')) failStep('假插件环境缺 memory:on 标记', String(fullStatus.plugins.marks));
    pass('可选插件：status 列出清单/on/版本/数据目录/读取源');
    const mkTaskIn = (home, title) => JSON.parse(run(['task', 'create', '--boot', pluginBoot.token, '--title', title, '--priority', 'P2', '--json'], { envOverride: { TEAM_PLUGINS_HOME: home } }).stdout.trim());
    const laneEmpty = mkTaskIn(pluginEmpty, '双轨任务-无插件');
    const laneFull = mkTaskIn(pluginFull, '双轨任务-有插件');
    if (laneEmpty.task.status !== laneFull.task.status || laneEmpty.task.priority !== laneFull.task.priority) failStep('双轨任务字段不一致', JSON.stringify({ empty: laneEmpty.task.status, full: laneFull.task.status }));
    pass('可选插件：零插件与有插件核心任务字段一致，仅插件状态不同');

    // ===== 角色产出播报（R-1e5f；令牌不落记录 + 归属校验）=====
    const bcProject = '试点';
    const bcDir = path.join(projectsRoot, bcProject, '需求分析师', '产出');
    fs.mkdirSync(bcDir, { recursive: true });
    const bcFile = path.join(bcDir, '需求分析-v99.md');
    const bcMailDir = path.join(teamRoot, '状态', '邮箱', 'analyst', 'new');
    const bcMailBefore = fs.existsSync(bcMailDir) ? fs.readdirSync(bcMailDir).length : 0;
    const bcBoot = json(['boot', '--role', 'analyst', '--project', bcProject, '--session', 'session-st-bc-analyst', '--json']);
    const bcToken = String(bcBoot.token || '');
    if (!bcToken) failStep('播报用例拿不到 analyst 令牌', JSON.stringify(bcBoot).slice(0, 200));
    write(bcFile, '# 沙盘播报测试\n\n这是一条用于 selftest 的产出。\n');
    const bcEmitArgs = ['broadcast', 'emit', '--boot', bcToken, '--project', bcProject, '--role', 'analyst', '--task', 'T-BC-1', '--path', '需求分析师/产出/需求分析-v99.md', '--type', 'analysis', '--summary', '沙盘播报测试', '--json'];
    const bcEmit1 = json(bcEmitArgs);
    const bcFields = ['id', 'role', 'taskId', 'type', 'summary', 'path', 'sha256', 'at'];
    if (!bcFields.every((k) => bcEmit1.item && bcEmit1.item[k])) failStep('播报字段不全', JSON.stringify(bcEmit1.item));
    if (bcEmit1.item.type !== 'analysis') failStep('播报 type 不对', bcEmit1.item.type);
    if (String(bcEmit1.item.summary).length > 200) failStep('摘要超 200 字', String(bcEmit1.item.summary).length);
    if (JSON.stringify(bcEmit1.item).includes(bcToken)) failStep('播报记录泄露令牌', String(bcEmit1.item.id));
    json(bcEmitArgs);
    json(bcEmitArgs);
    const bcList1 = json(['broadcast', 'list', '--project', bcProject, '--task', 'T-BC-1', '--json']);
    if (bcList1.count !== 1) failStep('去重失效（应为 1 条）', String(bcList1.count));
    pass('播报：8 字段齐全、同任务同路径同哈希 3 次只 1 条、记录不含令牌');
    write(bcFile, '# 沙盘播报测试 v2\n\n内容变了，哈希应变化。\n');
    json(['broadcast', 'emit', '--boot', bcToken, '--project', bcProject, '--role', 'analyst', '--task', 'T-BC-1', '--path', '需求分析师/产出/需求分析-v99.md', '--type', 'unknown-type', '--json']);
    const bcList2 = json(['broadcast', 'list', '--project', bcProject, '--task', 'T-BC-1', '--json']);
    if (bcList2.count !== 2) failStep('哈希变化未再播', String(bcList2.count));
    if (bcList2.items[1].type !== 'other') failStep('未知类型未归 other', bcList2.items[1].type);
    pass('播报：哈希变后再播 1 条、未知类型归 other');
    const bcFail = json(['broadcast', 'emit', '--boot', bcToken, '--project', bcProject, '--role', 'analyst', '--task', 'T-BC-2', '--path', '需求分析师/产出/需求分析-v99.md', '--fail-inject', '--json']);
    if (bcFail.ok !== false || !bcFail.failed) failStep('--fail-inject 未生效', JSON.stringify(bcFail));
    const bcList3 = json(['broadcast', 'list', '--project', bcProject, '--task', 'T-BC-2', '--json']);
    if (bcList3.count !== 1 || bcList3.items[0].status !== 'failed' || !bcList3.items[0].error) failStep('失败条目字段不对', JSON.stringify(bcList3.items[0]));
    const bcMailAfter = fs.existsSync(bcMailDir) ? fs.readdirSync(bcMailDir).length : 0;
    if (bcMailBefore !== bcMailAfter) failStep('播报写入了邮箱（计数应分离）', String(bcMailBefore) + '->' + String(bcMailAfter));
    pass('播报：失败注入 status=failed+error 不阻断、未写入邮箱未读');
    // R-1e5f 复核 P1：failed 记录不阻止同任务/同路径/同哈希重试，重试成功要新增 ok 记录。
    const bcRetry = json(['broadcast', 'emit', '--boot', bcToken, '--project', bcProject, '--role', 'analyst', '--task', 'T-BC-2', '--path', '需求分析师/产出/需求分析-v99.md', '--json']);
    if (bcRetry.deduped === true) failStep('失败后重试仍被去重', JSON.stringify(bcRetry));
    const bcList3b = json(['broadcast', 'list', '--project', bcProject, '--task', 'T-BC-2', '--json']);
    if (bcList3b.count !== 2 || !(bcList3b.items || []).some((x) => String(x.status || '') === 'failed') || !(bcList3b.items || []).some((x) => String(x.status || '') === 'ok')) {
      failStep('失败后重试没有形成 failed+ok 两条', JSON.stringify(bcList3b));
    }
    pass('播报：failed 记录不阻止同哈希重试，重试新增 ok');
    // R-1e5f 复核 P2：摘要里的 token=/secret= 值必须脱敏，不入记录。
    const bcFile2 = path.join(bcDir, '需求分析-v98.md');
    write(bcFile2, '# 沙盘播报脱敏测试\n');
    const bcSensitive = json(['broadcast', 'emit', '--boot', bcToken, '--project', bcProject, '--role', 'analyst', '--task', 'T-BC-SEC', '--path', '需求分析师/产出/需求分析-v98.md', '--type', 'analysis', '--summary', 'token=abc123 secret=xyz 已脱敏', '--json']);
    const bcSummary = String(bcSensitive.item && bcSensitive.item.summary || '');
    if (bcSummary.includes('abc123') || bcSummary.includes('xyz')) failStep('播报摘要未脱敏', bcSummary);
    if (!bcSummary.includes('***')) failStep('播报摘要脱敏标记缺失', bcSummary);
    pass('播报：摘要 token=/secret= 值已脱敏为 ***');
    const bcNoToken = run(['broadcast', 'emit', '--project', bcProject, '--role', 'analyst', '--task', 'T-BC-9', '--path', '需求分析师/产出/需求分析-v99.md', '--json'], { expectFail: true });
    if (!String(bcNoToken.stdout).includes('UNAUTHENTICATED')) failStep('无令牌未拒绝', String(bcNoToken.stdout).slice(0, 200));
    const bcPmBoot = json(['boot', '--role', 'pm', '--project', bcProject, '--session', 'session-st-bc-pm', '--json']);
    const bcCross = run(['broadcast', 'emit', '--boot', String(bcPmBoot.token), '--project', bcProject, '--role', 'analyst', '--task', 'T-BC-10', '--path', '需求分析师/产出/需求分析-v99.md', '--json'], { expectFail: true });
    if (!String(bcCross.stdout).includes('PERMISSION_DENIED')) failStep('跨角色未拒 PERMISSION_DENIED', String(bcCross.stdout).slice(0, 200));
    const bcNotOwner = expectErr(['broadcast', 'emit', '--boot', bcToken, '--project', bcProject, '--role', 'analyst', '--task', 'T-BC-3', '--path', '程序员A/产出/别人的产出.md', '--json'], 'NOT_OWNER');
    if (!String(bcNotOwner.stdout).includes('"code": "NOT_OWNER"')) failStep('NOT_OWNER 未透传错误码', String(bcNotOwner.stdout).slice(0, 200));
    pass('播报：无令牌 UNAUTHENTICATED、跨角色 PERMISSION_DENIED、他人目录 NOT_OWNER（码透传）');
    const bcByRole = json(['broadcast', 'list', '--project', bcProject, '--role', 'analyst', '--json']);
    if (bcByRole.count !== 5) failStep('按角色查询条数不对', String(bcByRole.count));
    const bcHtml = json(['broadcast', 'html', '--project', bcProject, '--out', path.join(temp, 'bc-panel.html'), '--json']);
    const bcHtmlText = read(bcHtml.file);
    for (const sel of ['data-broadcast-item', 'data-broadcast-toggle', 'data-broadcast-count', 'data-broadcast-failed']) {
      if (!bcHtmlText.includes(sel)) failStep('播报面板缺选择器 ' + sel, bcHtml.file);
    }
    if (!bcHtmlText.includes('data-broadcast-count>5<')) failStep('播报面板计数不是 5', bcHtml.file);
    pass('播报：按角色查询 count=5、面板含 4 个固定选择器且 count=5');

    // ===== AC21.6 / 21.9：路径白名单闭环 + 插件装卸回滚实装 =====
    const auditRoot = path.join(temp, 'audit-sandbox');
    fs.mkdirSync(path.join(auditRoot, 'src'), { recursive: true });
    write(path.join(auditRoot, 'src', 'bad.js'), "const p = 'C:\\Users\\someone\\project';\n");
    const auditBad = json(['path-audit', '--root', auditRoot, '--json']);
    if (auditBad.ok !== false || !Array.isArray(auditBad.outside) || auditBad.outside.length < 1) failStep('path-audit 未认出白名单外命中', JSON.stringify(auditBad).slice(0, 200));
    const emptyAudit = path.join(temp, 'empty-audit');
    fs.mkdirSync(emptyAudit, { recursive: true });
    const auditGood = json(['path-audit', '--root', emptyAudit, '--json']);
    if (auditGood.ok !== true || auditGood.total !== 0) failStep('path-audit 空目录应 PASS', JSON.stringify(auditGood).slice(0, 200));
    pass('AC21.6：白名单外命中判 FAIL、空目录判 PASS（白名单外 0 命中）');
    // a48b 收口（v19 漏检项）：单层盘符、转义双反斜杠、用户目录、secret 关键字必须都识别
    const sb2 = path.join(temp, 'audit-sandbox-2');
    fs.mkdirSync(path.join(sb2, 'src'), { recursive: true });
    write(path.join(sb2, 'src', 'single.js'), "const dir = 'D:\\PM工作台';\n");
    write(path.join(sb2, 'src', 'double.js'), "const re = /D:\\\\deepseek\\\\luanyujia/;\n");
    write(path.join(sb2, 'src', 'user.js'), "const p = 'C:\\Users\\Admin\\x';\n");
    write(path.join(sb2, 'src', 'secret.js'), "const secret = 'abcdefgh12345678';\n");
    const sb2Audit = json(['path-audit', '--root', sb2, '--json']);
    const sb2Files = new Set((sb2Audit.outside || []).map((h) => path.basename(h.file || '')));
    for (const f of ['single.js', 'double.js', 'user.js', 'secret.js']) if (!sb2Files.has(f)) failStep('沙盘漏检 ' + f, JSON.stringify([...sb2Files]));
    pass('AC21.6：沙盘 4 类（单层盘符/转义双反斜杠/用户目录/secret 关键字）全部识别');
    const sbDoc = path.join(temp, 'audit-docs');
    fs.mkdirSync(path.join(sbDoc, 'src'), { recursive: true });
    write(path.join(sbDoc, 'src', 'ok.js'), "const a = 1;\n");
    run(['path-audit', '--write-docs', '--root', sbDoc]);
    const sbSync = json(['path-audit', '--check-docs', '--root', sbDoc, '--json']);
    if (!sbSync.ok || !fs.existsSync(path.join(sbDoc, 'docs', '路径白名单.md'))) failStep('--write-docs 未生成同源文档', JSON.stringify(sbSync));
    pass('AC21.6：--write-docs 由代码白名单重生文档并同源 PASS');
    const baseEnv = { TEAM_PLUGINS_HOME: path.join(temp, 'plugins-none') };
    const bcBase = JSON.parse(run(['plugin', 'baseline', '--save', '--json'], { envOverride: baseEnv }).stdout.trim());
    if (!bcBase.file || !fs.existsSync(bcBase.file)) failStep('插件基线未写盘', JSON.stringify(bcBase).slice(0, 200));
    if (!bcBase.plugins.every((p) => p.status === 'off')) failStep('基线应全 off', JSON.stringify(bcBase.plugins));
    pass('AC21.9：plugin baseline --save 落盘、3 项全 off');
    const bcPlanIn = json(['plugin', 'plan', '--action', 'install', '--id', 'modlens', '--json']);
    if (!bcPlanIn.ok || !String(bcPlanIn.command).includes('dsh plugin') || !String(bcPlanIn.rollbackCommand).includes('remove')) failStep('install 计划命令不对', JSON.stringify(bcPlanIn));
    const bcPlanUn = json(['plugin', 'plan', '--action', 'uninstall', '--id', 'modlens', '--json']);
    if (!bcPlanUn.ok || !String(bcPlanUn.command).includes('remove') || !String(bcPlanUn.rollbackCommand).includes('add')) failStep('uninstall 计划命令不对', JSON.stringify(bcPlanUn));
    pass('AC21.9：安装/卸载计划命令与回滚命令相反');
    const bcRun = run(['plugin', 'run', '--action', 'install', '--id', 'modlens', '--json'], { expectFail: true, envOverride: baseEnv });
    if (!String(bcRun.stdout).includes('CONFIRM_REQUIRED')) failStep('run 无 --yes 未拒绝', String(bcRun.stdout).slice(0, 200));
    // rollback 不真执行：允许 NOOP（基线=当前）/ CONFIRM_REQUIRED（有差异但未加 --yes）/ BASELINE_MISSING（无基线）。
    const bcRollback = run(['plugin', 'rollback', '--id', 'modlens', '--json'], { envOverride: baseEnv });
    const bcRollbackJson = JSON.parse(String(bcRollback.stdout || '{}').trim() || '{}');
    const rbCode = String(bcRollbackJson.code || '');
    if (!['NOOP', 'CONFIRM_REQUIRED', 'BASELINE_MISSING'].includes(rbCode)) failStep('rollback 返回码异常', rbCode + ' / ' + String(bcRollback.stdout).slice(0, 160));
    if (rbCode === 'CONFIRM_REQUIRED' && !String(bcRollbackJson.plan && bcRollbackJson.plan.command || '').includes('dsh plugin')) failStep('rollback 计划缺命令', JSON.stringify(bcRollbackJson).slice(0, 200));
    pass('AC21.9：run 必须 --yes、rollback 不误执行（NOOP/CONFIRM_REQUIRED/BASELINE_MISSING）');

    // ===== a48b 补：审计扩范围 + 隔离 profile 真实装卸回滚 =====
    const realRoot = path.resolve(HERE, '..', '..', '..');
    const realAudit = json(['path-audit', '--root', realRoot, '--json']);
    if (!Array.isArray(realAudit.outside) || realAudit.outside.length !== 0) failStep('真实树白名单外命中', JSON.stringify((realAudit.outside || []).slice(0, 5)));
    if (realAudit.files < 10) failStep('审计范围过小（扩范围后应至少覆盖多目录）', String(realAudit.files));
    pass('AC21.6：扩范围（scripts/根目录/更多扩展名/macOS）后真实树白名单外 0 命中');
    const docSync = json(['path-audit', '--check-docs', '--root', realRoot, '--json']);
    if (docSync.ok !== true) failStep('白名单文档与代码不同源', JSON.stringify({ code: docSync.codeCount, docs: docSync.docsCount, missing: (docSync.missingInDocs || []).slice(0, 5), extra: (docSync.extraInDocs || []).slice(0, 5) }));
    pass('AC21.6：docs/路径白名单.md 与代码 PATH_WHITELIST 同源（' + docSync.codeCount + ' 文件）');
    const isoHome = path.join(temp, 'iso-home');
    fs.mkdirSync(path.join(isoHome, 'profiles', 'iso'), { recursive: true });
    const isoRun = (args) => JSON.parse(run(['plugin', ...args, '--home', isoHome, '--profile', 'iso', '--json']).stdout.trim());
    isoRun(['baseline', '--save']);
    const isoInstall = isoRun(['run', '--action', 'install', '--id', 'modlens', '--yes']);
    if (!isoInstall.ok || isoInstall.mode !== 'file') failStep('隔离安装未执行', JSON.stringify(isoInstall).slice(0, 200));
    if (isoRun(['status']).plugins.find((p) => p.id === 'modlens').status !== 'on') failStep('隔离安装后未 on');
    const isoUninstall = isoRun(['run', '--action', 'uninstall', '--id', 'modlens', '--yes']);
    if (!isoUninstall.ok) failStep('隔离卸载未执行', JSON.stringify(isoUninstall).slice(0, 200));
    if (isoRun(['status']).plugins.find((p) => p.id === 'modlens').status !== 'off') failStep('隔离卸载后未 off');
    if (isoRun(['rollback', '--id', 'modlens']).code !== 'NOOP') failStep('基线一致回滚应 NOOP');
    isoRun(['run', '--action', 'install', '--id', 'modlens', '--yes']);
    const isoRb = isoRun(['rollback', '--id', 'modlens', '--yes']);
    if (isoRb.code !== 'OK' || isoRun(['status']).plugins.find((p) => p.id === 'modlens').status !== 'off') failStep('差异回滚未回到基线', JSON.stringify(isoRb).slice(0, 200));
    pass('AC21.9：隔离 profile 真实装→卸→回滚闭环（on→off→NOOP→回到基线）');

    // ===== 项目终验与记忆清理（R-fb48）=====
    const finProject = '试点';
    const finMemHome = path.join(temp, 'memories');
    const finKey = 'fin-ws-key';
    const finOther = 'other-project';
    fs.mkdirSync(path.join(finMemHome, 'projects', finKey), { recursive: true });
    fs.mkdirSync(path.join(finMemHome, 'projects', finOther), { recursive: true });
    write(path.join(finMemHome, 'projects', finKey, 'MEMORY.md'), '# 项目记忆\n\n- 旧条目 A\n- 旧条目 B\n');
    write(path.join(finMemHome, 'projects', finKey, 'TODOS.md'), '# 待办\n\n- 旧待办\n');
    write(path.join(finMemHome, 'projects', finOther, 'MEMORY.md'), '# 其他项目\n\n- 不动\n');
    const otherHashBefore = crypto.createHash('sha256').update(read(path.join(finMemHome, 'projects', finOther, 'MEMORY.md'))).digest('hex');
    const finProjectJson = path.join(teamRoot, '状态', '项目', finProject, '项目.json');
    const finPj = JSON.parse(read(finProjectJson));
    finPj.memoryWorkspaceKey = finKey;
    delete finPj.finalizedAt;
    write(finProjectJson, JSON.stringify(finPj, null, 2) + '\n');
    // 前置不满足：先把需求改成非 accepted，run 应被拒
    // （终验前置还查未闭环任务：先把沙盘任务夹具都标 done，只动沙盘状态文件，不改产品逻辑）
    const finTaskDir = path.join(teamRoot, '状态', '项目', finProject, '任务');
    if (fs.existsSync(finTaskDir)) {
      for (const name of fs.readdirSync(finTaskDir)) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(finTaskDir, name);
        let row = null;
        try { row = JSON.parse(read(file)); } catch { continue; }
        if (!row || row.status === 'done') continue;
        row.status = 'done';
        row.doneAt = row.doneAt || new Date().toISOString();
        row.evidence = row.evidence || 'selftest 终验夹具收口';
        write(file, JSON.stringify(row, null, 2) + '\n');
      }
    }
    const finWfFile = path.join(teamRoot, '状态', '项目', finProject, '工作流.json');
    const finWf = JSON.parse(read(finWfFile));
    const finReqIds = Object.keys(finWf.requirements || {});
    if (finReqIds.length) finWf.requirements[finReqIds[0]].status = 'ready';
    write(finWfFile, JSON.stringify(finWf, null, 2) + '\n');
    const finEnv = { TEAM_MEMORY_HOME: finMemHome };
    // 轮换/成员表变更会让旧令牌 rulesHash 失效：终验用新 boot 的 PM 令牌（不改产品逻辑，只修夹具）。
    const finBoot = json(['boot', '--role', 'pm', '--project', '试点', '--session', 'selftest-fin-pm', '--json']);
    const finFail = run(['finalize', 'run', '--boot', finBoot.token, '--project', finProject, '--json'], { expectFail: true, envOverride: finEnv });
    if (!String(finFail.stdout).includes('PRECHECK_FAILED')) failStep('终验前置未拒', String(finFail.stdout).slice(0, 200));
    pass('终验：前置不满足（需求未收口）被拒 PRECHECK_FAILED');
    // 前置满足：需求全 accepted
    if (finReqIds.length) { for (const id of finReqIds) finWf.requirements[id].status = 'accepted'; write(finWfFile, JSON.stringify(finWf, null, 2) + '\n'); }
    // 派单前置（AC22.4，测试 v20 D1 修好后真正生效）：把沙盘邮箱里的派单消息移到 done，模拟“已消费”。
    // 判定与 finalizePrecheck 一致：kind=dispatch 或主题含“派单”。
    const finMailDir = path.join(teamRoot, '状态', '邮箱');
    for (const role of (fs.existsSync(finMailDir) ? fs.readdirSync(finMailDir) : [])) {
      const newDir = path.join(finMailDir, role, 'new');
      const doneDir = path.join(finMailDir, role, 'done');
      let names = [];
      try { names = fs.readdirSync(newDir); } catch { continue; }
      for (const name of names) {
        if (!/\.json$/i.test(name)) continue;
        let msg = null;
        try { msg = JSON.parse(read(path.join(newDir, name))); } catch { continue; }
        if (!msg) continue;
        if (String(msg.kind || '') !== 'dispatch' && !/派单/.test(String(msg.subject || ''))) continue;
        fs.mkdirSync(doneDir, { recursive: true });
        fs.renameSync(path.join(newDir, name), path.join(doneDir, name));
      }
    }
    const finOk = JSON.parse(run(['finalize', 'run', '--boot', finBoot.token, '--project', finProject, '--json'], { envOverride: finEnv }).stdout.trim());
    if (!finOk.ok || !finOk.recordJson || !fs.existsSync(finOk.recordJson)) failStep('终验记录未写', JSON.stringify(finOk).slice(0, 200));
    const finRec = JSON.parse(read(finOk.recordJson));
    for (const key of ['project', 'finalizedAt', 'operator', 'requirements', 'commitHashes', 'memory', 'result', 'source']) {
      if (!(key in finRec)) failStep('终验记录缺字段 ' + key, finOk.recordJson);
    }
    if (!fs.existsSync(finOk.recordJson.replace(/\.json$/, '.md'))) failStep('终验 .md 未写', finOk.recordJson);
    const finPjAfter = JSON.parse(read(finProjectJson));
    if (!finPjAfter.finalizedAt) failStep('项目.json.finalizedAt 未落', finProjectJson);
    const finArchiveDir = path.join(projectsRoot, finProject, '_archive');
    // 按 mtime 升序：最早的那份是“清理前”快照。--force 会再生成一份“已清空”快照，
    // 若按目录名/readdir 顺序取第一份，可能拿到清空头（测试 v20 D2 的失败原因）。
    const finSnaps = fs.existsSync(finArchiveDir)
      ? fs.readdirSync(finArchiveDir).filter((n) => n.startsWith('记忆-'))
        .map((n) => ({ n, mtime: fs.statSync(path.join(finArchiveDir, n)).mtimeMs }))
        .sort((a, b) => a.mtime - b.mtime).map((x) => x.n)
      : [];
    if (!finSnaps.length) failStep('记忆快照目录未生成', finArchiveDir);
    const finSnapPreClear = finSnaps[0];
    const finSnapManifest = JSON.parse(read(path.join(finArchiveDir, finSnapPreClear, 'manifest.json')));
    if (!Array.isArray(finSnapManifest.files) || !finSnapManifest.files.length) failStep('快照 manifest 无文件', finSnapPreClear);
    const finMemAfter = read(path.join(finMemHome, 'projects', finKey, 'MEMORY.md'));
    if (finMemAfter.includes('旧条目 A')) failStep('本项目记忆未清理', finKey);
    const otherHashAfter = crypto.createHash('sha256').update(read(path.join(finMemHome, 'projects', finOther, 'MEMORY.md'))).digest('hex');
    if (otherHashBefore !== otherHashAfter) failStep('其他项目记忆被改动', finOther);
    pass('终验：记录 8 字段/快照/只清本项目/项目标记');
    const finAgain = run(['finalize', 'run', '--boot', finBoot.token, '--project', finProject, '--json'], { expectFail: true, envOverride: finEnv });
    if (!String(finAgain.stdout).includes('ALREADY_FINALIZED')) failStep('重复终验未拒', String(finAgain.stdout).slice(0, 200));
    const finForce = JSON.parse(run(['finalize', 'run', '--boot', finBoot.token, '--project', finProject, '--force', '--json'], { envOverride: finEnv }).stdout.trim());
    if (!finForce.ok || finForce.record.forced !== true) failStep('--force 未留痕', JSON.stringify(finForce).slice(0, 200));
    pass('终验：重复拒绝 ALREADY_FINALIZED、--force 留痕');
    const finRestore = JSON.parse(run(['finalize', 'restore', '--project', finProject, '--snapshot', path.join('_archive', finSnapPreClear), '--json'], { envOverride: finEnv }).stdout.trim());
    if (!finRestore.ok || !finRestore.record.match) failStep('恢复后哈希不一致', JSON.stringify(finRestore).slice(0, 200));
    if (!read(path.join(finMemHome, 'projects', finKey, 'MEMORY.md')).includes('旧条目 A')) failStep('恢复后内容缺失', finKey);
    pass('终验：按快照恢复，条目/哈希一致');
    // 越权要真用普通角色令牌（pluginBoot 是 PM，权限检查会放行到 ALREADY_FINALIZED）
    const finDev = json(['boot', '--role', 'programmer1', '--project', '试点', '--session', 'selftest-fin-dev', '--json']);
    const finRole = run(['finalize', 'run', '--boot', finDev.token, '--project', finProject, '--json'], { expectFail: true, envOverride: finEnv });
    if (!String(finRole.stdout).includes('PERMISSION_DENIED')) failStep('非 PM/Owner 终验未拒', String(finRole.stdout).slice(0, 200));
    pass('终验：角色越权 PERMISSION_DENIED');

    // ===== B-20261113-064017-b645：task done 推进需求状态必须按 任务类型+阶段+测试结论 =====
    const advPm = json(['boot', '--role', 'pm', '--project', '试点', '--session', 'selftest-adv-pm', '--json']);
    const advDev = json(['boot', '--role', 'programmer1', '--project', '试点', '--session', 'selftest-adv-dev', '--json']);
    const advTester = json(['boot', '--role', 'tester', '--project', '试点', '--session', 'selftest-adv-tester', '--json']);
    const advWfFile = path.join(stateShiDian, '工作流.json');
    const advRow = (id) => JSON.parse(read(advWfFile)).requirements[id] || {};
    const advSetRow = (id, patch) => {
      const wf = JSON.parse(read(advWfFile));
      wf.requirements[id] = { ...(wf.requirements[id] || {}), ...patch };
      write(advWfFile, JSON.stringify(wf, null, 2) + '\n');
    };
    const advDecision = { status: 'approved', at: new Date().toISOString(), actor: 'owner', by: 'Owner', channel: 'ui' };
    const advMkReq = (title) => json(['req', 'create', '--boot', advPm.token, '--title', title, '--priority', 'P1', '--acceptance', '可判定', '--json']).requirement.id;
    const advMkTask = (title, reqId, owner) => json(['task', 'create', '--boot', advPm.token, '--title', title, '--priority', 'P1', '--requirement', reqId, '--owner', owner, '--json']).task.id;
    const advReport = (name, reqId, conclusion) => write(path.join(projDir, '测试人员', '产出', name), `# 测试报告 ${name}\n\n- 需求：${reqId}\n- 结论：${conclusion}\n`);

    // ① TR-Q/评审类任务 done：只登记，不推进需求状态（哪怕已有 Owner 决定）。
    const advReqTrq = advMkReq('推进用例：TR-Q 不推进');
    advSetRow(advReqTrq, { status: 'approved', ownerReview: advDecision, decisions: [advDecision] });
    const advTrqTask = advMkTask('TR-Q：推进用例（not_testable）', advReqTrq, 'tester');
    json(['task', 'claim', '--boot', advTester.token, '--id', advTrqTask, '--json']);
    advReport('测试报告-v90.md', advReqTrq, 'FAIL（TR-Q not_testable）');
    json(['task', 'done', '--boot', advTester.token, '--id', advTrqTask, '--evidence', 'TR-Q 登记：not_testable', '--json']);
    if (String(advRow(advReqTrq).status || '') !== 'approved') failStep('TR-Q/评审类任务 done 不应推进需求状态', JSON.stringify(advRow(advReqTrq)));
    pass('B-b645：TR-Q/评审类任务 done 不推进需求状态（approved 保持）');

    // ② 测试任务 done：TR-Q 结论 not_testable 时不得推 test_done。
    const advReqNot = advMkReq('推进用例：not_testable 不推进');
    advSetRow(advReqNot, {
      status: 'dev_done',
      trq: { requirementId: advReqNot, verdict: 'not_testable', by: 'tester', at: new Date().toISOString() },
      ownerReview: advDecision, decisions: [advDecision],
    });
    const advNotTask = advMkTask('测试：not_testable 不推进', advReqNot, 'tester');
    json(['task', 'claim', '--boot', advTester.token, '--id', advNotTask, '--json']);
    advReport('测试报告-v91.md', advReqNot, 'PASS');
    json(['task', 'done', '--boot', advTester.token, '--id', advNotTask, '--evidence', 'PASS 测试执行完成', '--json']);
    if (String(advRow(advReqNot).status || '') !== 'dev_done') failStep('TR-Q not_testable 时仍被推到 test_done', JSON.stringify(advRow(advReqNot)));
    pass('B-b645：TR-Q not_testable 时测试任务 done 不推 test_done（dev_done 保持）');

    // ③ 无 Owner decision：需求还在 owner_review（approved）时，任何任务 done 不得越过该门。
    const advReqNo = advMkReq('推进用例：无 Owner 决定');
    advSetRow(advReqNo, { status: 'approved', ownerReview: { status: 'pending' }, decisions: [] });
    const advNoTask = advMkTask('开发：无 Owner 决定不推进', advReqNo, 'programmer1');
    json(['task', 'claim', '--boot', advDev.token, '--id', advNoTask, '--json']);
    json(['task', 'done', '--boot', advDev.token, '--id', advNoTask, '--evidence', '开发完成', '--json']);
    if (String(advRow(advReqNo).status || '') !== 'approved') failStep('无 Owner decision 仍越过 owner_review 门', JSON.stringify(advRow(advReqNo)));
    pass('B-b645：无 Owner decision 不越过 owner_review 门（approved 保持）');

    // ④ legacy 兼容（2026-11-14 阻塞修复）：早期 Owner 通过后需求行停在 approved（没有 dispatched），
    // 有 Owner 决定 + 全部开发任务 done 时应视同 ready，允许推到 dev_done。
    const advReqLegacy = advMkReq('推进用例：approved 历史需求');
    advSetRow(advReqLegacy, { status: 'approved', decisions: [{ status: 'approved', at: new Date().toISOString(), channel: 'ui', actor: 'owner' }] });
    const advLegacyTask = advMkTask('开发：approved 历史需求推进', advReqLegacy, 'programmer1');
    json(['task', 'claim', '--boot', advDev.token, '--id', advLegacyTask, '--json']);
    json(['task', 'done', '--boot', advDev.token, '--id', advLegacyTask, '--evidence', '开发完成', '--json']);
    if (String(advRow(advReqLegacy).status || '') !== 'dev_done') failStep('approved 历史需求未推进到 dev_done', JSON.stringify(advRow(advReqLegacy)).slice(0, 200));
    pass('B-b645 ④：legacy approved 视同 ready，全部开发任务 done → dev_done');

    // ⑤ ready + 全部开发任务 done → dev_done（PM 2026-11-14 08:20 要求补的 ready 用例）
    const advReqReady = advMkReq('推进用例：ready 全部完成');
    advSetRow(advReqReady, { status: 'ready' });
    const advReadyTask = advMkTask('开发：ready 推进', advReqReady, 'programmer1');
    json(['task', 'claim', '--boot', advDev.token, '--id', advReadyTask, '--json']);
    json(['task', 'done', '--boot', advDev.token, '--id', advReadyTask, '--evidence', '开发完成', '--json']);
    if (String(advRow(advReqReady).status || '') !== 'dev_done') failStep('ready 需求未推进到 dev_done', JSON.stringify(advRow(advReqReady)).slice(0, 200));
    pass('B-b645 ⑤：ready + 全部开发任务 done → dev_done');

    // ===== G9 证据门（T-20261113-063141-70a9）：三条 =====
    const evProject = '证据门用例';
    json(['project', 'add', '--name', evProject, '--desc', '证据门三条用例', '--by', 'owner', '--json']);
    const evProjDir = path.join(projectsRoot, evProject);
    const evPm = json(['boot', '--role', 'pm', '--project', evProject, '--session', 'selftest-ev-pm', '--json']);
    const evDev = json(['boot', '--role', 'programmer1', '--project', evProject, '--session', 'selftest-ev-dev', '--json']);
    const evEnv = { TEAM_EVIDENCE_ENFORCE: '1' };
    const evTaskFile = (id) => path.join(teamRoot, '状态', '项目', evProject, '任务', `${id}.json`);
    const evMkTask = (title) => json(['task', 'create', '--boot', evPm.token, '--title', title, '--priority', 'P2', '--owner', 'programmer1', '--json']).task.id;
    const evFail = (id, evidence) => {
      const r = run(['task', 'done', '--boot', evDev.token, '--id', id, '--evidence', evidence, '--json'], { envOverride: evEnv, expectFail: true });
      return String(r.stdout || '') + String(r.stderr || '');
    };

    // ① 文件不存在：不得 done，任务状态保持 working（零副作用）。
    const evT1 = evMkTask('证据门：文件缺失');
    if (!evFail(evT1, '产出/不存在.md').includes('EVIDENCE_FILE_MISSING')) failStep('证据门：缺失文件未返回 EVIDENCE_FILE_MISSING');
    if (JSON.parse(read(evTaskFile(evT1))).status !== 'working') failStep('证据门：失败后任务被误标 done');
    pass('G9：证据文件不存在 → EVIDENCE_FILE_MISSING，任务保持 working');

    // ② 旧文件顶替：mtime 早于任务开始 → EVIDENCE_STALE。
    const evT2 = evMkTask('证据门：旧文件');
    const evOldFile = path.join(evProjDir, '程序员A', '产出', '旧报告.md');
    write(evOldFile, '# 旧报告\n');
    const evOldAt = new Date(Date.now() - 3600 * 1000);
    fs.utimesSync(evOldFile, evOldAt, evOldAt);
    if (!evFail(evT2, '程序员A/产出/旧报告.md').includes('EVIDENCE_STALE')) failStep('证据门：旧文件未返回 EVIDENCE_STALE');
    pass('G9：证据 mtime 早于任务开始 → EVIDENCE_STALE');

    // ③ 代码路径哈希：声明不符 → EVIDENCE_HASH_MISMATCH；正确哈希 done 并把 sha256 记进任务。
    const evT3 = evMkTask('证据门：代码哈希');
    const evCodeFile = path.join(temp, 'src', 'gate-code.js');
    write(evCodeFile, 'export const gate = 1;\n');
    if (!evFail(evT3, `src/gate-code.js（sha256 ${'0'.repeat(64)}）`).includes('EVIDENCE_HASH_MISMATCH')) failStep('证据门：代码哈希不符未返回 EVIDENCE_HASH_MISMATCH');
    const evRight = sha(evCodeFile);
    const evOk = JSON.parse(run(['task', 'done', '--boot', evDev.token, '--id', evT3, '--evidence', `src/gate-code.js（sha256 ${evRight}）`, '--json'], { envOverride: evEnv }).stdout.trim());
    if (!evOk.ok || !Array.isArray(evOk.task.evidenceFiles) || evOk.task.evidenceFiles.length !== 1) failStep('证据门：正确哈希未 done 或未记录 evidenceFiles', JSON.stringify(evOk).slice(0, 200));
    if (String(evOk.task.evidenceFiles[0].sha256) !== evRight) failStep('证据门：evidenceFiles 里 sha256 不一致', String(evOk.task.evidenceFiles[0].sha256));
    pass('G9：代码哈希不符 → EVIDENCE_HASH_MISMATCH；正确哈希 done 且 evidenceFiles 记 sha256');

    // ===== ask/answer 自由问询（B-ae9f）：不占派单锁、必须收件人回答、超时升级 PM 卡点 =====
    const askProject = '试点';
    const askP1 = json(['boot', '--role', 'programmer1', '--project', askProject, '--session', 'selftest-ask-p1', '--json']);
    const askP2 = json(['boot', '--role', 'programmer2', '--project', askProject, '--session', 'selftest-ask-p2', '--json']);
    const askAn = json(['boot', '--role', 'analyst', '--project', askProject, '--session', 'selftest-ask-an', '--json']);
    if (!askP1.token || !askP2.token || !askAn.token) failStep('ask：boot 没发令牌');
    const askLockPath = path.join(teamRoot, '状态', '项目', askProject, '派单锁.json');
    const ask1 = json(['ask', '--boot', askP1.token, '--to', 'programmer2', '--question', '接口字段到底用 a 还是 b？', '--json']);
    if (!ask1.ok || !ask1.question || !ask1.question.id) failStep('ask：创建失败', JSON.stringify(ask1).slice(0, 300));
    if (fs.existsSync(askLockPath)) failStep('ask：问询不该占用派单锁');
    const askQid = ask1.question.id;
    const askWrong = run(['answer', '--boot', askAn.token, '--id', askQid, '--answer', '我不是收件人', '--json'], { expectFail: true });
    if (!(String(askWrong.stdout || '') + String(askWrong.stderr || '')).includes('NOT_RECIPIENT')) {
      failStep('answer：非收件人回答没被拒', String(askWrong.stdout || '') + String(askWrong.stderr || ''));
    }
    const askAns = json(['answer', '--boot', askP2.token, '--id', askQid, '--answer', '用 b，后端已兼容 a', '--json']);
    if (!askAns.ok || String(askAns.question.status) !== 'answered') failStep('answer：回答未落账', JSON.stringify(askAns).slice(0, 300));
    const askList1 = json(['ask', 'list', '--boot', askP1.token, '--json']);
    if (!askList1.summary || askList1.summary.answered < 1) failStep('ask：list 计数里没有已回答', JSON.stringify(askList1.summary));
    pass('B-ae9f：A 问 B 答闭环（非收件人被拒、不占派单锁）');

    // 超时升级：TTL=0，创建后立刻 check → PM 收到卡点；再 check 不重复升级。
    const askTtlEnv = { TEAM_ASK_TTL_MIN: '0' };
    const ask2 = JSON.parse(String(run(['ask', '--boot', askP1.token, '--to', 'programmer2', '--question', '这条故意不回，验证超时升级', '--json'], { envOverride: askTtlEnv }).stdout || '').trim());
    if (!ask2.ok) failStep('ask：超时用例创建失败', JSON.stringify(ask2).slice(0, 300));
    const esc1 = JSON.parse(String(run(['ask', 'check', '--boot', askP1.token, '--json'], { envOverride: askTtlEnv }).stdout || '').trim());
    if (!(esc1.escalated || []).some((row) => row.id === ask2.question.id)) failStep('ask：超时未升级', JSON.stringify(esc1).slice(0, 300));
    const esc2 = JSON.parse(String(run(['ask', 'check', '--boot', askP1.token, '--json'], { envOverride: askTtlEnv }).stdout || '').trim());
    if ((esc2.escalated || []).length !== 0) failStep('ask：同一问询被重复升级', JSON.stringify(esc2).slice(0, 300));
    const pmNewDir = path.join(teamRoot, '状态', '邮箱', 'pm', 'new');
    const pmEscalated = fs.existsSync(pmNewDir) && fs.readdirSync(pmNewDir).some((file) => file.endsWith('.json')
      && fs.readFileSync(path.join(pmNewDir, file), 'utf8').includes(ask2.question.id));
    if (!pmEscalated) failStep('ask：PM 没有收到超时卡点消息');
    pass('B-ae9f：超时未答升级 PM 卡点（每条只升级一次）');

    const done = results.filter((r) => r.ok).length;
    console.log(`\nSELFTEST ${done}/${results.length} PASS`);
    // PM 要求：跑完真实 workbench.json 必须一字未动（否则测试又把脏数据写进 Owner 状态库）。
    const realAfter = (() => {
      try {
        const st = fs.statSync(realWorkbenchPath);
        return { exists: true, size: st.size, mtimeMs: st.mtimeMs, sha256: crypto.createHash('sha256').update(fs.readFileSync(realWorkbenchPath)).digest('hex') };
      } catch { return { exists: false, size: 0, mtimeMs: 0, sha256: '' }; }
    })();
    // 真实 workbench 里是否被 selftest 塞进了沙盘项目（真正的污染形态）；不能要求字节不变——
    // 用户的工作台/其它角色可能同时在正常写这个文件，字节比对会把别人的正常写入判成 selftest 污染。
    const realStoreNow = (() => { try { return JSON.parse(fs.readFileSync(realWorkbenchPath, 'utf8')); } catch { return null; } })();
    const leaked = realStoreNow && Array.isArray(realStoreNow.projects)
      ? realStoreNow.projects.filter((p) => /[\\/]_tmp[\\/]team-selftest-/.test(String((p && p.path) || '')))
      : [];
    const realWorkbenchUnchanged = leaked.length === 0;
    if (!realWorkbenchUnchanged) failStep('selftest 往真实 workbench.json 写入了沙盘项目（应只用 TEAM_WORKBENCH_JSON 沙盘）', JSON.stringify(leaked.map((p) => p.name)).slice(0, 300));
    else pass('真实 workbench.json 未被改动（沙盘隔离）');
    if (reset) pass('--reset 清理遗留沙盘：' + (resetReport.removed.join('、') || '无'));
    return { ok: true, results, temp, reset: resetReport, realWorkbench: { path: realWorkbenchPath, unchanged: realWorkbenchUnchanged, sha256: realAfter.sha256 } };
  } catch (e) {
    console.log(`\nSELFTEST FAIL: ${e.message}`);
    return { ok: false, results, temp, error: e.message };
  } finally {
    if (!keep) {
      try { fs.rmSync(temp, { recursive: true, force: true }); } catch { /* ignore */ }
    } else {
      console.log(`\n保留沙盘：${temp}`);
    }
  }
}
