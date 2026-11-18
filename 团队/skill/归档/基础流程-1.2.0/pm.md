# 基础流程 skill · 项目经理

## 适用场景
收到 Owner 指令、需要分派/催办/收口时。

## 前置条件
- 已 boot 并持有本项目令牌（`team.mjs boot --role pm --project <项目>`）；
- 已读项目铁律与本人角色卡；本次动作的边界写清楚（只改自己目录 / 只动授权文件）。

## 步骤
1. 先确认「真相在哪」：需求正文/工作流/任务单/队列文件属于哪一层，不要凭记忆；
2. 只从既有入口读写（正文走 `req write`，任务走 `task`，消息走 `send/ack`），不手改派生文件；
3. 产出落到本角色目录（代码按项目信息的规定目录），同哈希交付、版本递增不覆盖；
4. 用程序自己可复跑的方式验证（脚本/断言/日志），把结论写成「命令 + 通过数 + 退出码」；
5. 完成回执 + `task done --evidence` 才叫完成；失败立即回报卡点，不静默挂着。

## 判据
- 有可复跑证据（命令能重跑、结果一致），不是「我看过了」；
- 写盘只发生在授权范围内；同名文件用新版本号，旧版保留；
- 门禁（G1/G2/G3/G7、证据门）不因本次动作被绕过；
- 回执 ≤ 600 字，含任务 id、产出路径、证据路径。

## 反例
- 直接改状态 JSON / 派生文件「图快」，导致账本与真相分叉；
- 只回「收到」不产出、或把回执当成完成；
- 用旧报告/旧截图当本次证据；测例或脚本被改过却不核对 mtime；
- 报「已通过」但给不出重跑命令与通过数。

## 换人 / 交接（每角色必读）

- **何时交接**：轮次 ≥ 8 或用量档 warn/force（团队默认阈值）；Owner/PM 明确要求；会话异常（崩溃、OOM、换模型）导致无法继续但任务未收口。
- **交接文件**：`<角色目录>/产出/交接-最新.md`，固定八节（现在状态 / 已收口 / 在途 / 待 Owner 定 / 血的教训 / 关键文件路径 / 接手头三件事 / 全部未完成盘点）；盘点数字必须现查，不抄上一版。
- **回执**：写完后先给 PM 发一条回执（路径 + bytes + sha8 + mtime + 八节齐全 + 手头活是否已收口），由 PM 统一 archive + rotate；**回执不是交接完成本身**。
- **boot**：换人后新会话第一件事 `team.mjs boot` 拿新令牌；名册（团队.json）一改**全员**旧令牌失效，受影响角色各自重 boot。
- **广播**：名册变更后只由 PM **广播一次**「全员重 boot」，其余角色不各自广播、不刷消息；交接内容走文件、不走长消息。
- **失败回滚**：交接文件没写完不 rotate；rotate 失败保留旧绑定并报 PM（不手工改 JSON）；有在途任务时归档是**建议不阻断**（ARCHIVE_DEFERRED），不得为归档丢活；回滚以「旧会话继续干」为默认，不重 claim、不重写报告。
- 角色专属提示（pm）：交接时把「当前在办任务 id + 卡点 + 下一步命令」写进「在途」，让接手人不用翻聊天记录即可继续。

## 派单前置检查（程序门）

- **先检查再派**：任何 `send --ack ...`（派单）之前，先跑
  `node 团队\工具\team.mjs dispatch-check --boot <PM令牌> --project <项目> --to <角色> [--json]`；
  判定 `go` / `go_degraded` 才发，`queue` / `wait` / `wake_first` / `blocked` 一律先处置再派。
- **程序门（不靠自觉）**：`send --ack` 写盘前会读「最近 10 分钟内 to=该角色 的检查记录」——
  没有记录 → `DISPATCH_PRECHECK_REQUIRED`（零写入）；最新判定不是 go → `DISPATCH_BLOCKED_BY_STATE`（带 reasons 与数字）；
  只有 `--force --reason "为什么在 X 状态仍要派"` 能放行，并在 `派单前置检查.jsonl` 记 `forced:true`（无 reason → `DISPATCH_FORCE_REASON_REQUIRED`）。
- **五种判定怎么处置**：`queue`=排队/等审批 → 等消化或用 ask 问清；`wait`=正在思考（<600s）→ 等这一轮结束；
  `wake_first`=running 太久 / 15 分钟无活动 / 唤醒失败 → 先 `wake` 或 `auto-boot` 确认它还活着；
  `blocked`=派单锁在该角色 或 目标未 boot → 先等回执/清锁或先 boot。
- **降级口径**：会话排队快照过期（≥120s）或缺 c9ac v2 字段（running/pendingInput/runningSince）时判 `go_degraded` 或 `wake_first`，
  **绝不给 go**；这时先看 presence（未读/未回执/停滞/唤醒失败）再决定。
- **通知不受限**：非派单的 notice / receipt / 请求不受此门限制，照旧发。


## 验收权限边界（2026-11-18 强化）

- **需求级验收只能 Owner 本人**（界面「我的验收」点通过 / Owner 终端 accept）；**代管也不可代需求验收**（程序 `PROXY_ACCEPT_FORBIDDEN` 硬拦）。
- PM **只能** `task accept --task <缺陷单> --as pm --evidence 报告:report --evidence 截图:screenshot --opinion …`；不得对需求做验收、不得把「有代管」当作可代需求验收的理由。
- 需求到 `test_done` 才进 Owner 验收列表；PM 的职责是把材料（报告+截图+TR-Q/评审记录）备齐并提示 Owner 点，不替点。
- 代管只可代记**评审决定**（approved/rejected/skipped）；迭代/终止/验收必须 Owner 本人。

## 文档维护与角色卡/skill 对齐

- 基础工作流唯一口径＝`团队/流程.md`（第二部分·现行工作流）；宪法/项目铁律/角色卡/skill/模板改动一律以它为准逐条对齐。
- 维护分工：宪法＝PM 主笔+Owner 同意；流程.md＝PM；项目铁律＝PM 追加（≤6KB、慎写、带维护规则）；角色卡与 skill＝各角色本人；角色卡/宪法/铁律模板＝程序员 A（产品评审）。
- 改宪法/项目铁律/团队.json（名册）后：**广播一次全员重 boot**（只 PS 广播，不重复刷）；改本人角色卡只需本人重 boot。
- skill 升版：改 `团队/skill/基础流程/<role>.md` → 更新 `skill-manifest.json`（version/approvedBy/approvedAt/previousVersion + 新 sha）→ 旧版归档 → `node scripts/skill-check.cjs`（必要时 `--write-state`）→ 再跑必须 OK。

## 工装安全与测量窗口（P0）

- 禁止任何角色/脚本/临时命令按进程名/路径/时间窗批量杀 electron；只允许 `taskkill /PID <自起 child.pid> /T /F` 或 `child.kill()`，无 PID 不杀；提交工装前跑 `node scripts/check-no-batch-electron-kill.cjs`。
- 测量前协调干净窗口（目标角色/他人停止 Electron 起停），测量报告记录被测 HEAD、隔离方式、启动 PID、同时段 electron 进程数与 CPU；负载异常结果只作观测。
- 界面/性能测量必须隔离实例（`AWB_DATA_DIR` + 沙盘团队 + `TEAM_SELFTEST=1`），并核对真实 `团队.json` 与 `workbench.json` sha 前后不变。

## 版本
- version：1.3.0（2026-11-18 新增「验收权限边界」「文档维护与角色卡/skill 对齐」「工装安全与测量窗口」三节；依据 Owner 2026-11-18 22:01 指令：以现行工作流为准，全员修正角色卡与 skill、对齐模板）。
- 1.2.0（2026-11-18 新增「派单前置检查（程序门）」小节；依据 Owner 2026-11-18 09:15）。
- 历史：1.1.0（2026-11-17 新增「换人/交接」小节）；1.0.0（初版）。

