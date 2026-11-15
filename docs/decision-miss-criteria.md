# 漏箱判据表（R-5016 决策收口 · 工具侧）

> 适用命令：`team.mjs decision miss --project <项目> [--minutes N] [--now ISO] [--dry-run] [--json]`
> 实现单源：`团队/工具/lib/decision-route.mjs`（`collectPmAsks` / `detectMissedAsks`）
> 口径版本：`R-5016/v1`（PM 2026-11-15 有条件确认①：**只认登记类型，不靠标题猜**）

## 一、当前判据（唯一口径）

| # | 判据 | 取值 | 说明 |
|---|---|---|---|
| 1 | 发件人 | `message.from === 'pm'` | 只扫 PM 发出的 |
| 2 | 消息类型 | `message.type === 'owner_ask'` | 该类型登记在 `团队/工具/lib/dispatch.mjs → WAKE_KIND_LABEL`（标签「问Owner拍板」）；`team.mjs send --type owner_ask` 未登记类型会被 `MSG_TYPE_UNKNOWN` 拒 |
| 3 | 项目范围 | `message.project === 当前项目` | 跨项目不串 |
| 4 | 年龄 | `now - message.ts ≥ minutes`（默认 30，`AWB_DECISION_MISS_MINUTES` 可配） | `--now` / `AWB_FAKE_NOW` 可注入时钟，三入口读同一个 now |
| 5 | 未入箱 | 决策箱（`决策箱.json`）里没有任何条目的 `source.ref === message.id` | 已在箱 → `skip(already_in_box)` |
| 6 | 未补录过 | 不存在 `missBox:true` 且 `source.ref === message.id` 的条目 | 已补 → `skip(already_missed)` |

命中 1–6 全部条件 → 补录一条 `D-<YYYYMMDD-HHmmss>-<4位>-MISS`（`missBox:true`、`ruleId:'R-MISS'`、`status:'open'`、`source={kind:'message',ref}`），写 `决策收口.jsonl` 一行 `action='miss'`，并刷新当日 `漏箱-YYYYMMDD.md`。

**词表（`OWNER_ASK_WORDS`）只用于把"文案里出现哪些拍板字眼"写进摘要给人看，不参与判定。**

## 二、为什么删掉「标题含拍板/请示」与「收件人∈{pm,owner}」

- 标题判据**假阳率极高**：真实项目 2,613 条 PM 消息里，旧口径（收件人∈{pm,owner} 或标题含「拍板/请示」）命中 40 条，其中有拍板字样的 12 条**全部不是**"问 Owner 拍板"——例：`b811 拍板正文被截断，请补全重发`（发给产品）、`请评审 R-…b5fc（… Owner 已拍板）`（发给产品）。若按旧口径补录，会凭空造 12 条 MISS 占位。
- 收件人判据在本系统**结构性不可用**：Owner 不是团队名册成员，`sendMessage` 要求收件人是 active 成员 → 不可能有 `to ∈ {pm, owner}` 的正式"发给 Owner"消息。
- 因此：**只有显式声明 `type=owner_ask` 的消息才算"问 Owner 要拍板"**；不猜、不从标题推断。

## 三、假阳 / 假阴风险与处置

| 风险 | 说明 | 处置 |
|---|---|---|
| 假阳①：PM 用 `type=owner_ask` 发**普通通知** | 类型被误用 → 30 分钟后凭空多一条 MISS 占位 | 补录的是 **占位条目（missBox:true）**，PM 在决策箱里可直接回答「不需要，已自行处理」；同日漏箱报告记 1 条，可追溯 `source.ref`；`decision-route` 不删任何消息 |
| 假阳②：多条 owner_ask 指同一问题 | 每条消息各补 1 条（按消息 id 去重） | 幂等键是**消息 id**：同一条消息只补 1 次；不同消息视为不同问句（宁多问不漏问） |
| 假阴①：PM 忘了标 `owner_ask` | 真正的 Owner 问句用 `notice/question` 发出 → 不被计入 | 这是**有意的取舍**（不靠标题猜就必然有这类漏网）。缓解：`team.mjs send` 帮助与派单模板里提醒"要 Owner 拍板请用 `--type owner_ask`"；后续可加"PM 消息里出现强拍板词时提示改类型"（需另立需求，避免又回到猜） |
| 假阴②：`--no-wake` / 静默消息 | 不落盘 → 扫不到 | 静默消息本就不该触发 Owner；不处理 |
| 假阴③：跨项目扫描 | 按 `message.project` 过滤 | 多项目各扫各的；跨项目不串 |
| 时钟漂移 | 用 `message.ts`（落盘时间）与 `--now` | 测试可注入 `--now`；生产用系统时间 |

## 四、真实项目只读扫描（2026-11-15 15:30，`--dry-run`，零写入）

| 口径 | 命中 | 说明 |
|---|---|---|
| 新口径（`type=owner_ask` + 6 条判据） | **候选 0 条 → 漏箱 0 条** | 该类型刚登记，历史上无人使用；决策箱无 MISS 占位（`totalMiss=0`） |
| 旧口径（标题/收件人） | 40 条命中，其中 12 条含拍板字样 | 12 条**全部是假阳**（都是 PM 给角色布置/转述，不是问 Owner），若按旧口径会造 12 条假 MISS |

结论：新口径在真实数据上**没有假阳**；代价是「PM 忘记标类型」的真问句会漏（见 §三 假阴①）。

## 五、怎么复跑

```powershell
# 真实项目只读（会写 漏箱-YYYYMMDD.md 吗？--dry-run 不写任何文件）
node 团队\工具\team.mjs decision miss --project "工作台改造修复" --dry-run --json

# 沙盘断言（自建 _tmp/decision-route-sandbox，不碰真实数据）
node scripts/test-decision-route.cjs
```
