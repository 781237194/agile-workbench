#!/usr/bin/env node
// 团队工作台 v2 · CLI 入口
// 用法：node 团队\工具\team.mjs <命令> [--参数]
import path from 'node:path';
import { parseArgs, TeamError, jsonOut, textOut } from './lib/core.mjs';
import {
  cmdInit, cmdProject, cmdBoot, cmdSend, cmdInbox, cmdRead, cmdAck, cmdTask, cmdPropose,
  cmdShow, cmdReview, cmdSign, cmdApply, cmdGrant, cmdIndex, cmdStatus, cmdReconcile,
  cmdVerify, cmdLog, cmdLock, cmdOwnerApprove, cmdOwner, cmdRoster, cmdPilot, cmdDoctor,
  cmdReq, cmdFind, cmdBoard, cmdVote, cmdWorkflow,
} from './lib/ops.mjs';
import { cmdBrief } from './lib/brief.mjs';

const HELP = `团队工作台 v2 · 多会话敏捷团队

必读与启动
  boot --role <pm|analyst|programmer1|tester|...> [--project 名称] [--session id]
      读 团队宪法 → 项目铁律 → 项目信息 → 角色卡 → 项目索引 → 需求总览 → 相关需求/他人文档索引，
      返回 read 证据（文件/大小/哈希/摘录）并写 阅读回执；所有写操作都要带 --boot
      角色集按项目团队模式动态：full=六角色；fast=PM/需求分析师/程序员A/测试人员
      简报固定含：中文思考、中文回复、中文写文档；派单闭环（ack=已回执 ≠ 已完成，完成要 task done 证据）

消息
  send --boot T --to <角色> --subject S --body B [--ack] [--wake] [--no-wake] [--task T-...]
       带 --ack 会自动唤醒目标角色：执行消息正文任务 → 产出写本角色目录 → 完成回执；
       ack 只代表已回执（收到/认领），task done --evidence 才代表已完成
  inbox --boot T [--all]
  read --boot T --id M-...
  ack --boot T --id M-... [--note "一句话日志"]
       只表示已收到/已认领，不算完成；完成用 task done --evidence

任务 / 需求
  task create --boot T --title X --priority P1 [--detail D] [--owner 角色] [--type task|bug|chore] [--requirement R-...]
  task list --boot T [--all]     task show --boot T --id T-...
  task claim --boot T --id T-...  task done --boot T --id T-... --evidence 证据
  task priority --boot T --id T-... --priority P0 --reason "..."
  req create --boot T --title X --priority P1 --acceptance "..." [--story "..."]
  req list --boot T
  req review --boot T --id R-... --verdict approve|reject [--kind requirement|tech] [--proposal P-...] [--comments "..."]
       需求评审：full 由产品设计师、fast 由需求分析师执行；技术评审记录：full 产品/程序员A、fast 程序员A；PM 不评审
        技术评审写 状态/项目/<项目>/技术评审/TR-*.json（JSON 是真相，.md 人读镜像）；驳回同时写 工作流.json
         驳回后需求行 status=rejected、phase=requirement_review
  req iterate --boot T --id R-... [--reason "..."] [--force]
        被驳回需求进入下一轮：任务重新 open，iterationRound+1，需求行写 iteration
  req terminate --boot T --id R-... [--reason "..."]
        终止被驳回需求：任务 done，关联子任务一并收口，需求行写 terminated
  owner confirm --project P --requirement R-... --decision approved|skipped|rejected [--action accept] [--ttl 600] [--test-owner]
        Owner 是外部角色，没有 boot；在真实终端签发一次性确认码（--test-owner 仅 TEAM_SELFTEST=1）
  owner --project P --requirement R-... --decision approved|skipped|rejected --opinion "..." [--owner-confirm 确认码]
        Owner 需求级决定：approved/skipped → ready（fast 先 tech_review）；rejected → rejected
  owner --project P --requirement R-... --decision accepted|rejected --action accept --opinion "..." [--owner-confirm 确认码]
        Owner 验收：该需求名下测试任务必须全部 done；accepted 收口需求，rejected 打回
  find --boot T --q 关键词            # 只从项目索引里找；索引变了先重新 boot
  board [--project 项目名] [--json]      # 生成 看板.md / 看板.html / 看板.json

工作流（工作台旧协议入口 · 与 状态/项目/<项目>/工作流.json 共用）
  workflow iterate --boot T --project P [--opinion "..."] [--requirement R-...] [--force]
        PM 推进到下一轮；不带 --requirement 时把本轮已驳回需求转入 iteration
  workflow terminate --boot T --project P [--opinion "..."]
        PM 终止工作流：所有未收口需求置 terminated，关联子任务 done

投票（壳层可调用 · 文件落 团队\状态\项目\<项目>\投票\）
  vote start --boot T --subject "..." [--kind requirement|change|other] [--requirement R-...] [--proposal P-...]
       PM 或需求分析师发起（createdBy 记实际发起角色）；参与人 = 除 PM 外全体角色；PM 不投票
  vote cast --boot T --id V-... --vote approve|reject|abstain [--comment "..."]
  vote status [--id V-...] [--open] [--project P] [--json]   # 只读，不需要令牌
       规则：除 PM 外全员一致驳回才驳回；赞成过半即通过；全部投完无多数 = no_consensus

结构化产出（豆包协议 · 网关读取，只读不写）
  brief --boot T --role <analyst|product|programmer1|tester> [--project P] [--doc 01|02|03|04] [--section 区块] [--limit N] [--latest] [--check] [--json]
      从角色结构化产出（01-需求分析/02-产品设计/03-架构设计/04-测试报告，vN）提取 YAML 元数据/指定区块，供壳层精准投喂，不读全文
      模板：团队\工具\模板\角色产出\ ｜ 纪律：只读自己需要区块 ｜ 只写自己负责字段 ｜ 输出即结果 ｜ 超过上限即停止

变更（核心）
  propose --boot T --task T-... --title X --file 目标=暂存 [--file ...] --expect 目标=当前哈希 --rationale "..." [--risk normal|sensitive|critical]
  show --boot T --proposal P-... [--diff]      # 记录“已读”，review 前必须
  review --boot T --proposal P-... --verdict approve|reject --comments "..."
  sign --boot T --proposal P-... --decision approve [--note "..."] [--self]
  apply --boot T --proposal P-... [--log "一句话日志"] # PM 执行；CAS + 备份 + 回滚 + 索引

授权 / 项目 / 索引
  grant --boot T --to programmer --actions propose --scope "src/**" --project X --expires 7d --reason "..."
  grant list --boot T [--role r]   grant revoke --boot T --to r --id G-...
  project add|create --name X [--desc "..."] [--dir D] [--team-mode full|fast] [--boot T]
      建项目：把 teamMode/roleIds 写进 状态/项目/<项目>/项目.json（模式真相），同步 workspace.json；
      full=六角色目录；fast=PM/需求分析师/程序员A/测试人员 四角色目录；
      均含角色卡 + 文件索引 + 产出/ + 项目信息/铁律/索引/README/协作准则 + 需求池 + site + _tmp
  project ensure --name X [--dir D] [--team-mode full|fast] [--boot T]   # 只补缺失，不改已有内容；切模式不删旧目录/旧会话
  project list   project show --name X [--json]   project use --boot T --name X
  index --project X
  roster list   roster add --boot T --role analyst --name 需求分析师 [--force]   # 只能加当前模式内的角色
  pilot   # 试点门槛检查

运维
  status [--json]   reconcile   verify [--project X]   log [--tail 30]   doctor
  lock acquire --boot T --key K [--ttl 60]   lock release --boot T --key K   lock status
  owner-approve --proposal P-... [--project X]   # 必须真实终端，无 TTY 拒绝
  selftest [--keep] [--tmp 目录]   # 沙盘跑通：回执/签字/陈旧拒绝/锁争用/回滚/项目脚手架/评审/投票/迭代终止；默认落 工作台\_tmp

铁律：没有启动令牌不执行（Owner 无 boot，但必须有本机一次性确认）；先读后审；apply 必须 CAS；锁只防同时写。
`;

// 旧协议里有、v2 没实现的命令：必须显式 NOT_IMPLEMENTED。
// 已实现的命令必须写成 switch 的 case（旧壳按 case 探测能力）；未实现的不要写 case，
// 否则会被误判为“已实现”。当前 req review / owner / workflow / vote 都已实现，本表为空。
const NOT_IMPLEMENTED_COMMANDS = new Map();

async function main() {
  const args = parseArgs(process.argv.slice(2));
  const cmd = args._[0] || 'help';
  if (cmd === 'help' || cmd === '--help' || cmd === '-h') { textOut(HELP); return 0; }

  if (NOT_IMPLEMENTED_COMMANDS.has(cmd)) {
    throw new TeamError('NOT_IMPLEMENTED', `「${cmd}」尚未实现：${NOT_IMPLEMENTED_COMMANDS.get(cmd)}。本版本不提供该旧命令，也不返回假成功。`, {
      command: cmd,
      implemented: false,
      hint: cmd === 'owner' ? '需要 Owner 终端批准时用 owner-approve' : '工作流状态请以 项目索引.md / 看板 为准',
    });
  }

  switch (cmd) {
    case 'init': cmdInit(args); break;
    case 'project': cmdProject(args); break;
    case 'boot': cmdBoot(args); break;
    case 'send': await cmdSend(args); break;
    case 'inbox': cmdInbox(args); break;
    case 'read': cmdRead(args); break;
    case 'ack': cmdAck(args); break;
    case 'task': cmdTask(args); break;
    case 'req': cmdReq(args); break;
    case 'owner': await cmdOwner(args); break;
    case 'vote': cmdVote(args); break;
    case 'workflow': cmdWorkflow(args); break;
    case 'find': cmdFind(args); break;
    case 'brief': cmdBrief(args); break;
    case 'board': cmdBoard(args); break;
    case 'propose': cmdPropose(args); break;
    case 'show': cmdShow(args); break;
    case 'review': cmdReview(args); break;
    case 'sign': cmdSign(args); break;
    case 'apply': cmdApply(args); break;
    case 'grant': cmdGrant(args); break;
    case 'index': cmdIndex(args); break;
    case 'status': cmdStatus(args); break;
    case 'reconcile': cmdReconcile(args); break;
    case 'verify': cmdVerify(args); break;
    case 'log': cmdLog(args); break;
    case 'lock': cmdLock(args); break;
    case 'owner-approve': await cmdOwnerApprove(args); break;
    case 'roster': cmdRoster(args); break;
    case 'pilot': cmdPilot(args); break;
    case 'doctor': cmdDoctor(args); break;
    case 'selftest': {
      const { runSelftest } = await import('./lib/selftest.mjs');
      const r = await runSelftest({ keep: Boolean(args.keep), tmp: args.tmp ? String(args.tmp) : '' });
      process.exitCode = r.ok ? 0 : 1;
      break;
    }
    default:
      textOut(`未知命令：${cmd}\n\n${HELP}`);
      return 2;
  }
  return 0;
}

main().then((code) => {
  if (code) process.exit(code);
  if (process.exitCode) process.exit(process.exitCode);
}).catch((e) => {
  const args = parseArgs(process.argv.slice(2));
  const code = e instanceof TeamError ? e.code : 'INTERNAL';
  if (args.json) {
    jsonOut({ ok: false, code, message: e.message, details: e.details || {} });
  } else {
    process.stderr.write(`[${code}] ${e.message}\n`);
    if (e.details && Object.keys(e.details).length) {
      process.stderr.write(JSON.stringify(e.details, null, 2) + '\n');
    }
    if (code === 'INTERNAL') process.stderr.write(String(e.stack || '') + '\n');
  }
  process.exit(code === 'INTERNAL' ? 4 : 3);
});
