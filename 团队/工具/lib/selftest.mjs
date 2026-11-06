// 团队工作台 v2 · 沙盘自测
// 覆盖：boot/消息回执/任务/提案/评审/签字/提交/陈旧拒绝/锁争用/缺签/规则变更/未读先审/回滚/verify/看板
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { checkDocStructure } from './brief.mjs';
import { OUTPUT_DOCS, LIMITS } from './roles.mjs';
import { buildDispatchPrompt, DISPATCH_MARKERS } from './dispatch.mjs';

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

export async function runSelftest({ keep = false, tmp = '' } = {}) {
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
  const env = { ...process.env, TEAM_ROOT: teamRoot, TEAM_PROJECTS_ROOT: projectsRoot, TEAM_SELFTEST: '1' };
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
  const run = (args, { expectFail = false, tool = TEAM_MJS } = {}) => {
    const r = spawnSync(process.execPath, [tool, ...args], { cwd: work, env, encoding: 'utf8', timeout: 60000 });
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

    json(['grant', '--boot', pmBoot.token, '--to', 'programmer1', '--actions', 'propose', '--scope', 'src/**', '--project', '试点', '--expires', '7d', '--reason', 'selftest', '--json']);
    pass('PM 具体授权');

    const m1 = json(['send', '--boot', pmBoot.token, '--to', 'programmer1', '--subject', '首单', '--body', '请按协议做一单', '--ack', '--json']);
    const inbox = json(['inbox', '--boot', pgBoot.token, '--json']);
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
    const ownerSkipped = json(['owner', '--project', '试点', '--requirement', fullReqId, '--decision', 'skipped', '--opinion', 'Owner 确认跳过技术评审', '--owner-confirm', ownerNonce, '--json']);
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

    // Owner 验收：测试任务 done + 需求处于 test_done 才允许；accepted 收口需求任务。
    const ownerTest = json(['task', 'create', '--boot', fullPm, '--title', 'Owner 验收测试任务', '--priority', 'P1', '--requirement', fullReqId, '--owner', 'tester', '--json']);
    json(['task', 'claim', '--boot', testerBoot.token, '--id', ownerTest.task.id, '--json']);
    json(['task', 'done', '--boot', testerBoot.token, '--id', ownerTest.task.id, '--evidence', 'PASS 验收测试通过', '--json']);
    const wfTest = JSON.parse(read(path.join(stateShiDian, '工作流.json')));
    wfTest.requirements[fullReqId].status = 'test_done';
    wfTest.phase = 'test';
    write(path.join(stateShiDian, '工作流.json'), JSON.stringify(wfTest, null, 2) + '\n');
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
    const fastOwner = json(['owner', '--project', '快四', '--requirement', fastReqId, '--decision', 'skipped', '--opinion', 'Fast Owner 跳过评审', '--owner-confirm', fastOwnerConfirm.confirmation.nonce, '--json']);
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
    if (read(switchSessionsFile) !== switchSessionsText) failStep('切回 full 改了旧会话清单（不应动）');
    if (read(switchTeamFile) !== teamBeforeSwitch) failStep('切回 full 改了团队会话表（不应动）');
    pass('team-mode 切换：项目.json/workspace.json 双处同步；旧目录/旧会话不删；只改当前模式');

    expectErr(['project', 'add', '--name', '坏模式', '--team-mode', 'medium', '--by', 'owner', '--json'], 'BAD_TEAM_MODE');
    const badWs = run(['create', '--name', '坏工作区', '--root', projectsRoot, '--team-mode', 'medium', '--no-register', '--json'], { expectFail: true, tool: WORKSPACE_MJS });
    if (!(String(badWs.stdout || '') + String(badWs.stderr || '')).includes('BAD_TEAM_MODE')) failStep('workspace 未拒绝非法 --team-mode');
    pass('非法 --team-mode 被拒（project / workspace 两入口）');

    const done = results.filter((r) => r.ok).length;
    console.log(`\nSELFTEST ${done}/${results.length} PASS`);
    return { ok: true, results, temp };
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
