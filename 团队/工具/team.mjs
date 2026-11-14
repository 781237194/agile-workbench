#!/usr/bin/env node
// 团队工作台 v2 · CLI 入口
// 用法：node 团队\工具\team.mjs <命令> [--参数]
import path from 'node:path';
import { parseArgs, TeamError, jsonOut, textOut } from './lib/core.mjs';
import {
  cmdInit, cmdProject, cmdBoot, cmdSend, cmdInbox, cmdRead, cmdAck, cmdTask, cmdMemory, cmdPropose,
  cmdShow, cmdReview, cmdSign, cmdApply, cmdGrant, cmdIndex, cmdStatus, cmdReconcile,
  cmdVerify, cmdLog, cmdLock, cmdOwnerApprove, cmdOwner, cmdRoster, cmdPilot, cmdDoctor,
  cmdReq, cmdFind, cmdBoard, cmdVote, cmdWorkflow, cmdOwnerProxyDecide, cmdQueue,
  cmdAsk, cmdAnswer, cmdPresence, cmdMarkRead, cmdWake,
} from './lib/ops.mjs';
import { cmdBrief } from './lib/brief.mjs';
import { cmdOwnerProxy } from './lib/owner-proxy.mjs';
import { cmdSubagent } from './lib/subagent.mjs';
import { cmdSession } from './lib/session.mjs';
import { cmdBroadcast } from './lib/broadcast.mjs';
import { cmdPathAudit } from './lib/path-audit.mjs';
import { cmdPlugin } from './lib/plugin-manager.mjs';
import { cmdFinalize } from './lib/finalize.mjs';
// R-9db6：Owner 决策箱（工具侧：存储/回执/静默兜底），界面由壳层另做。
import { cmdDecision } from './lib/decision-cli.mjs';
// R-8f68：角色直连流转（批 1：只写任务行/队列/事件，不唤醒）+ 铁律 5 例外批准状态。
import { cmdHandoff, cmdRuleException } from './lib/handoff-cli.mjs';
// R-b5fc F-2/F-4b：看板驱动路由守护与角色队列（逻辑在 lib/route-daemon.mjs，CLI 入口在 lib/route-cli.mjs）。
import { cmdRoute, cmdQueues } from './lib/route-cli.mjs';

const HELP = `团队工作台 v2 · 多会话敏捷团队

必读与启动
  boot --role <pm|analyst|programmer1|tester|...> [--project 名称] [--session id]
      读 团队宪法 → 项目铁律 → 项目信息 → 角色卡 → 项目索引 → 需求总览 → 相关需求/他人文档索引，
      返回 read 证据（文件/大小/哈希/摘录）并写 阅读回执；所有写操作都要带 --boot
      角色集按项目团队模式动态：full=六角色；fast=PM/需求分析师/程序员A/测试人员
      简报固定含：中文思考、中文回复、中文写文档；派单闭环（ack=已回执 ≠ 已完成，完成要 task done 证据）

消息
  send --boot T --to <角色> --subject S --body B [--ack] [--queue] [--wake] [--no-wake] [--task T-...]
       --ack=派单；PM 上一条派单未回执时加 --queue 入队，角色 task done 后自动续跑
       带 --ack 会自动唤醒目标角色：执行消息正文任务 → 产出写本角色目录 → 完成回执；
       ack 只代表已回执（收到/认领），task done --evidence 才代表已完成
  inbox --boot T [--all]
  read --boot T --id M-...
  ack --boot T --id M-... [--note "一句话日志"]
       只表示已收到/已认领，不算完成；完成用 task done --evidence
  presence --project P [--role a,b] [--json]
       只读：每角色未读（deliveredAt 有值且无 readAt）/未回执（--ack 已读未回执）/停滞分钟/wakeFailed
  mark-read --project P --role R [--actor owner] [--boot T] [--json]
       全部已读：只补新字段口径下的未读（readAt + 阅读.jsonl kind=read）；旧箱 box=new 不动
  wake --project P --role R [--boot T] [--engine-url URL] [--json]
       一键唤醒：失败自动排 5/15/30 秒重试，3 次仍失败给 PM 发 wake_failed 并在看板标红点

任务 / 需求
  task create --boot T --title X --priority P1 [--detail D] [--owner 角色] [--type task|bug|chore] [--requirement R-...]
  task list --boot T [--all]     task show --boot T --id T-...
  task claim --boot T --id T-...  task done --boot T --id T-... --evidence 证据
        P0 任务 done 前必须有 project 记忆（<DSH_HOME>/memories/projects/<key>/MEMORY.md 含任务 id）；缺了 MEMORY_MISSING
  memory check --boot T --task T-... [--role R] [--json] [--required]
        只读核查 project 记忆：{project,taskId,role,required,found,missing,entries,store}；P0 缺失 exit 1
  task priority --boot T --id T-... --priority P0 --reason "..."
  task recompute-advance --boot T [--requirement R-...] [--allow-unowned-open]
        按现有任务重算需求应到 dev_done/test_done（幂等；不动任务内容）。
        legacy approved 视同 ready 的开发阶段；--allow-unowned-open 把“无 owner 的历史 open 任务”
        排除出阻塞清单（受控校准，事件里记被忽略的任务 id）
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
  owner proxy status|start|end --project P [--requirement R-...] [--scope once|always]
        代管开关：Owner 在评审弹窗点「全部交 PM 代管」或这里开/查/结束
  owner proxy decide --project P --requirement R-... --decision approved|rejected|skipped --opinion "PM 代记依据"
        PM 代管落账（T-a01d）：必须存在未结束代管 + Owner 授权来源；写 channel=proxy、recordedBy=pm、basis.proxy；
        只代记评审决定，验收必须 Owner 本人；看板/弹窗显示【PM通过】/【PM打回】/【待 PM 评审】
  owner proxy decide --project P --requirement R-... --decision accepted --action accept --evidence '路径:report' [--evidence '图.png:screenshot'] --opinion "..."
        PM 代验收（T-3422）：有效代管 + 测试报告≥1 + 截图≥1（文件存在、sha256 核对）才落账；缺项 PM_ACCEPT_EVIDENCE_REQUIRED 且零副作用；
        打回/迭代/终止仍必须 Owner 本人；evidence 可写成 JSON 数组或多次 --evidence 路径:kind
  find --boot T --q 关键词            # 只从项目索引里找；索引变了先重新 boot
  board [--project 项目名] [--json]      # 生成 看板.md / 看板.html / 看板.json
  broadcast emit --boot T --project P --role R --task T2 --path <相对路径> [--type analysis] [--summary "..."] [--fail-inject]
       产出播报：8 字段（id/role/taskId/type/summary/path/sha256/at）+ status；同任务同路径同哈希只播一次；
       令牌只校验归属、绝不写入记录；跨角色 PERMISSION_DENIED，无令牌 UNAUTHENTICATED；只播本角色目录；
       失败写 status=failed 不阻断；记录 团队/状态/项目/<P>/播报/记录.jsonl
  broadcast list --project P [--task T] [--role R] [--json]
       查询播报（items+count）；broadcast html --project P [--out 文件] 生成带
       [data-broadcast-item]/[data-broadcast-toggle]/[data-broadcast-count]/[data-broadcast-failed] 的面板
  path-audit [--root 目录] [--json] [--check-docs] [--write-docs]
       硬编码路径审计：范围 src/**、团队/工具/**、README.md、docs/**；白名单外 0 命中才算 PASS；
       模式与 AC21.6 示例同口径（盘符含单层/转义双反斜杠、用户目录、密钥关键字）；
       白名单与 团队/工具/lib/path-audit.mjs 同源；--check-docs 校验镜像，--write-docs 由代码重生镜像
  plugin status | baseline [--save] | plan --action install|uninstall --id <插件> | run --action ... --id ... [--yes]
  plugin rollback --id <插件> [--yes] | verify
       可选插件装/卸/回滚实装：baseline 记安装前状态；plan 给命令与回滚命令；run 需 --yes；
       rollback 按基线恢复；verify 对比；找不到 dsh 命令时返回 DSH_CLI_MISSING，不阻断核心
  finalize precheck --project P [--json]        # 前置检查（需求/任务/派单，只读）
  finalize run --boot T --project P [--force]   # 终验：前置→快照→清记忆（memory:off 跳过）→记录→标记
  finalize status --project P [--json]          # 是否已终验、记录列表、记忆目录
  finalize restore --project P --snapshot <快照目录>   # 按快照恢复记忆（哈希一致）
       终验记录：团队/状态/项目/<P>/终验/FV-<ts>.json|.md；快照：<项目>/_archive/记忆-<ts>/（含 manifest）

看板驱动自动流转（R-b5fc · 状态即路由）
  queues --project P --boot T --role R [--json]     # 本人读自己的角色队列（role_queues.json）
  queues --project P --boot T --all [--json]        # 只有 PM 能读全量；越权 QUEUE_FORBIDDEN
  queues export --project P --boot T [--json]       # 刷新派生 role_queues.json（写失败保留上一版）
  route daemon --project P --boot T [--interval ms] [--max-ticks N] [--engine-url URL]
       路由守护：每 30 秒读一次 工作流.json/任务，只读门禁判定后只唤醒「该做的人」（taskId+action），
       单实例锁 30 秒续期；只写 role_queues.json / 路由守护.jsonl / 守护状态.json / 路由快照.json
  route once --project P --boot T [--json]          # 只走一拍（沙盘/验收用）
  route plan --project P [--json]                   # 只读预演：本拍会唤醒谁、被哪个门禁拦住
  route status --project P [--json]                 # 心跳/是否停滞/锁/日志计数
  route log --project P [--tail 20] [--json]
  route stale-check --project P [--json]            # 心跳超 3 周期 → PM 收 wake_failed(why=daemon_stale)，10 分钟去重
       queue pump（壳层 60 秒定时器）会自动调用停滞告警；幂等窗口 TEAM_ROUTE_IDEMPOTENT_HOURS（默认 24）

Owner 决策箱（R-9db6 · 工具侧）
  decision add --project P --boot <PM令牌> --title "≤40字" [--summary "≤120字"] --question "≤200字" \
       --options "通过,打回,其他" --source-kind message|file|requirement --source-ref M-...|路径|R-...
       只有 PM 能放入（非 pm → DECISION_BOX_FORBIDDEN）；同来源同问题在 open 态 → DECISION_BOX_DUPLICATE（零落盘）
  decision list --project P [--all] [--json]        # 只读：待决/未读/已回执计数与条目
  decision read --project P --id D-... [--json]     # Owner 展开（写 readAt，不唤醒）
  decision invite --project P --id D-... [--test-owner]   # 签发 Owner 一次性确认码（真实终端；沙盘用 --test-owner）
  decision ack --project P --id D-... --choice A [--opinion "..."] --owner-confirm <码>
       发 type=owner_decision_receipt 给 PM（默认静默，不唤醒）；同一条只发一次；只认 options 里的候选
  decision archive --project P --id D-...
  decision stale-check --project P                  # 防长期静默：未读回执≥5 条或最早超 TEAM_DECISION_RECEIPT_STALE_MS（默认 2 小时）→ 唤醒 PM 一次

角色会话轮换（到顶就换人 · R-20261112-155311-c0a6）
  session usage [--project P] [--role R] [--warn 300000] [--force 500000] [--json]
       读 DSH projections.tokenUsage：每角色 input/output/total；input=uncachedInputTokens（cacheRead 单列）；
       30 万预警（提示准备 archive/rotate）、50 万强制归档/换人；阈值可配（--threshold 兼容旧语义=预警）；
       无 DSH 元数据标“未知”不按 0；只告警不自动换
  session rotate --role <角色> [--session S] [--reason "..."] [--force] [--offline] [--dry-run] [--json]
       新建/指定会话 → 四处映射同改（团队.json、项目/团队会话.json、workbench.json 的
       projects[].sessions 与 projects[].workspace.sessionIds）→ 归档旧会话 → 写轮换记录与事件；
       邮件归档只动本项目消息（按 project 限定，跨项目不归档）；失败回滚覆盖映射/邮件/任务/派单锁；
       --dry-run 只读预演（打印将写四处、将归档邮件、将改任务/锁，零写入）；
       同角色已有活跃会话时拒绝（SESSION_ALREADY_ACTIVE），--force 留痕
  session check [--project P] [--json]
       四处映射一致性：逐角色 PASS/FAIL，全一致才算 6/6；不一致时派单/唤醒被拒 SESSION_MAP_INCONSISTENT
  session rounds --role R [--json]
       会话轮次：{role,roundsSinceArchive,lastArchiveAt,lastTaskIds[],max}；task done 自动 +1（同任务去重），达 10 归零
  session transcript --session S [--role R] [--json]
       导出可核查转录：{session,role,transcript,turns:[{at,preToolThought,toolCalls[],reply}]}；缺转录返回 missing 不报错
  session audit --role R --file <项目内相对路径> [--json]
       中文核查：连续 ≥3 行英文叙述判违规，写 违规/记录.jsonl（9 字段）；同角色第 2 次升级 PM
  session archive --boot T --role R --reason "..." [--confirm|--self] [--force] [--json]
       归档：写 会话归档/A-<ts>-<角色>.json（9 字段，nextSessionId/rotatedAt 留 null）；轮次归零；
       PM 自归档用 --self（owner confirm --archive <id> 确认）；rotate 成功后回写 nextSessionId/rotatedAt
  owner confirm --archive <归档id> --project P
       Owner 确认 PM 自归档：写 confirmedAt=确认时间
  session handover --role <角色> [--json]
       输出接任包（项目/未完成任务/锁/最近决定/必读文件，≤2KB）；新会话 boot 自动带上

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

子代理（只读辅助 · 领锁预算 · 记录纪律）
  subagent start --boot T --role <角色> --purpose "..." --input <路径,路径> [--files N] [--bytes N] [--writes _tmp/...] [--ttl 30]
      门槛：>5 个文件 或 >32KB；预算：PM 最多 2 个、其他角色 1 个（锁 subagent:<角色>:<n>，超限 SUBAGENT_BUDGET_EXCEEDED）；
      只允许 --mode read-only；写入必须隔离在 _tmp/ 下，写 src/** 或 团队/** 直接 SUBAGENT_WRITE_DENIED
  subagent end --boot T --id S-... --result <路径> --note "复核结论"   # 还锁并写记录；没有记录 = 没发生
  subagent merge --boot T --base 产出/x-v2.md --parts 产出/a.md,产出/b.md --out 产出/x-v3.md [--auto] [--conflict "人工冲突"]
      需求/产品多子代理写作合并：基线 → 逐节 → 冲突 → 合并后哈希 → 本人签字，记录落 产出/子代理合并记录-vN.md
  subagent list --project P [--role 角色] [--json]

变更（核心）
  propose --boot T --task T-... --title X --file 目标=暂存 [--file ...] --expect 目标=当前哈希 --rationale "..." [--risk normal|sensitive|critical] [--scope project|shared]
       --scope shared：允许 团队/**、src/**、scripts/**（相对仓库根）；缺省 project 只允许项目目录
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
        status/doctor 末尾列出「可选插件」：记忆/视觉/搜索的 on/off、版本、数据目录、读取源；
        off 只提示不阻断（缺插件不报错），error 才计入 doctor 问题；见 docs/可选插件.md
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
    case 'boot': await cmdBoot(args); break;
    case 'send': await cmdSend(args); break;
    case 'inbox': cmdInbox(args); break;
    case 'read': cmdRead(args); break;
    case 'ack': await cmdAck(args); break;
    case 'presence': cmdPresence(args); break;
    case 'mark-read': cmdMarkRead(args); break;
    case 'wake': await cmdWake(args); break;
    case 'ask': await cmdAsk(args); break;
    case 'answer': await cmdAnswer(args); break;
    case 'queue': await cmdQueue(args); break;
    case 'task': await cmdTask(args); break;
    case 'memory': cmdMemory(args); break;
    case 'req': cmdReq(args); break;
    case 'owner': {
      // owner proxy status|start|end（代管开关）与 owner proxy decide（PM 代管落账，T-a01d）分开分发。
      const proxySub = String((args._ && args._[1]) || '').toLowerCase();
      const proxyAction = String((args._ && args._[2]) || '').toLowerCase();
      if (proxySub === 'proxy') {
        if (proxyAction === 'decide') await cmdOwnerProxyDecide(args);
        else cmdOwnerProxy(args);
      } else {
        await cmdOwner(args);
      }
      break;
    }
    case 'vote': cmdVote(args); break;
    case 'workflow': cmdWorkflow(args); break;
    case 'find': cmdFind(args); break;
    case 'session': await cmdSession(args); break;
    case 'brief': cmdBrief(args); break;
    case 'subagent': cmdSubagent(args); break;
    case 'board': cmdBoard(args); break;
    case 'broadcast': cmdBroadcast(args); break;
    case 'path-audit': cmdPathAudit(args); break;
    case 'plugin': cmdPlugin(args); break;
    case 'finalize': cmdFinalize(args); break;
    case 'route': await cmdRoute(args); break;
    case 'queues': cmdQueues(args); break;
    case 'decision': await cmdDecision(args); break;
    case 'handoff': await cmdHandoff(args); break;
    case 'rule-exception': await cmdRuleException(args); break;
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
      const r = await runSelftest({ keep: Boolean(args.keep), tmp: args.tmp ? String(args.tmp) : '', reset: Boolean(args.reset) });
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
