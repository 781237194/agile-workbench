# CHANGELOG

## 2.1.4（2026-11-19）

### 按 Owner 干净机实测汇总修安装与连接（10 点中的我方项）

- **安装器 Electron 自愈（P0-1）**：`npm install` 前 `npm install-scripts approve electron -a`（旧 npm 忽略）；`electron.exe` 缺失时按 `install-scripts ls` 判定原因，从 `%LOCALAPPDATA%\electron\Cache` 的 `electron-v*-win32-x64.zip`（按 mtime 最新）解压到 dist（3 次退避）+ 写 `path.txt`；`install-result.json → electron{missingReason,healed,healReason,distFileCount,dirState}`。
- **安装重试与诊断（P2-7）**：统一 `Move-DirectoryWithRetry`（3 次退避 + 复制兜底），失败分类 in-use/permission-or-locked/other 并写目录状态。
- **启动器目录对齐（P1-3）**：`DEFAULT_DIRS` 改调用期 `defaultDirs()`，补安装器默认 `<盘符>\PM工作台`（D: 优先遍历存在盘）；安装器写用户变量 `PM_WORKBENCH_HOME`；导出 `getDefaultWorkbenchDirs`。
- **teamRoot 调用期解析（P2-6）**：不再加载期缓存 env，改每次调用读 env/`workbench.json`；安装器收尾提示「重启 DSH」。
- **DSH 自动发现修复（P0-2）**：PowerShell 路径修为 `%SystemRoot%\System32\WindowsPowerShell\v1.0\powershell.exe`，旧路径仅兜底，`AWB_POWERSHELL_PATH` 可注入；wmic 缺失不再致命（记录 WMIC_MISSING 后走 `Get-CimInstance`）；扫描默认区间改 49152–65535；新增 `netstat-port` 候选（监听到 PID 反查失败时兜底）；命令尝试记录含路径+存在性，`DSH_NOT_FOUND` 诊断含 wmic/powershell/netstat；夹具 `test-dsh-discovery` 15/15（含真实本机 resolved+capability.ok=true+零写入）。
- **建团队开局提示词（Owner 实测）**：不再只发「只回复：已就位」；改为先读《团队宪法》/《流程.md》第二部分/《项目铁律》→ `boot` 读完全部必读文件 → 读本人角色目录（角色卡/交接-最新/产出索引）→ 才回「已就位（附令牌前 8 位+已读文件数）」；抽 `lib/seed-prompt.mjs` 单一实现，夹具 `test-seed-prompt` 19/19。
- **文档（P3-9/P3-10）**：README 增 profile `config` 整段替换警告（必须重述 teamRoot）与 Desktop 版 `plugin_manager` 操作路径。

## 2.1.3（2026-11-19）

### 自动升级真正可用：内嵌 GitHub 连接修复 + CDN 升级包

- `install.ps1` 自包含 GitHub 连接修复（无需外部工具）：内置 github/api/raw/codeload 候选 IP + TLS 探测（TLS 不可用退化 TCP 443）；下载前预检，不可达时自动写 hosts 标记段（`# ==== GitHub Fix START/END ====`）、flush DNS、重试 3 次；失败自动恢复运行前 hosts；不改 DNS 服务器/网关；新增 `-NoGitHubFix` / `-GitHubFixRestore` / `-GitHubFixHostsPath`（夹具副本，不碰真实 hosts）；`install-result.json` 与 `升级记录.jsonl` 记录 `githubFix`。
- 版本源改为 **CDN 升级包**：`发布/版本信息.json` 指向 jsDelivr 上的 `发布/pm-workbench-<ver>.zip`（带 sha256），升级不再依赖 GitHub 直连；「立即升级」按钮恢复可用，走安装器真实下载→校验→备份→应用→回滚→重启提示。
- 检查更新版本源：jsDelivr 优先 + GitHub raw（正确仓库）兜底，单源 8s，全部失败返回尝试源与可读原因。

## 2.1.2（2026-11-19）

### 热修：检查更新超时 / 404（默认版本源写错）

- 根因：`app:upgrade-check` 默认源写死成 `raw.githubusercontent.com/xuyefeng/dsh-agile-workbench/...`——**仓库作者名不对**（应为 `781237194`），且 raw.githubusercontent 在多数国内网络不可达 → 用户只会看到「超时（5s）」或 404。
- 修复：默认版本源改为**源链**：优先 `cdn.jsdelivr.net/gh/781237194/agile-workbench@main/发布/版本信息.json`（CDN 可达），失败再回退 GitHub raw（正确仓库）；单源超时 8s；全部失败时返回「尝试过的源 + 可读原因」。仓库新增 `发布/版本信息.json`（version/url/sha256/kind）。
- 安全限制：`kind=installer` 的版本源暂不显示「立即升级」按钮（避免把 .ps1 当升级包），改为提示「请重新运行安装脚本完成升级」；安装器重跑式升级后续版本接入。
- 回归：`test-e610-upgrade` 13/13。

## 2.1.1（2026-11-19）

### 热修：更多菜单「检查更新」点了没有任何反应

- 根因：`data-more="upgrade"` 行被 `runMoreAction` 通用分支先收起整个更多菜单，且 `stopPropagation` 让升级菜单自己的 document 监听收不到事件 → 子菜单永远不展开、看起像按钮坏了。
- 修复：`data-more="upgrade"` 走独立分支——保持更多菜单打开并展开升级子菜单；检查结果除子菜单内一行外，**增加全局 toast**（发现新版本/已是最新/无法检查），不再静默。
- 回归夹具：`test-e610-upgrade` 新增 E10（真实点「检查更新」行→子菜单展开）、E11（子菜单内点检查→结果可见）；总计 **13/13**。

## 2.1.0（2026-11-19）

### Owner 实测六问题修复（P0/P1 全部收口）

- **一句话安装真一键**：安装器零端口发现/不写 `dsh.json`/不执行探针；运行期首启只读探针（`session/list`）→ `data/dsh-capability.json` + 摘要「DSH 互通能力：有/无」；`AWB_NO_MIRROR=1` 关镜像；Electron 下载进度（≤30s 一行）；Node/Electron 缓存兜底；`dshVersion` 真实取值；MCP 失败可读（`~/.dsh/logs/mcp-*.log` + warnings + 关于页 `[data-mcp-warning]`）。
- **首开粒子可见**：系统 `prefers-reduced-motion` 整层降级不再静默——菜单显示真实态 +「仍然开启」；强制开启 `ui.fxForce` 重启保持；性能自采样降级可恢复。
- **boot 引导**：简报新增按角色可复制命令模板（`团队\工具\team.mjs` 前缀、≥3 条）+ 派单锁/未回执状态块 + 红线（禁止子代理代跑角色）。
- **开局必须走团队通道**：新增 `pm dispatch` 原子命令（五步、失败列全 `missing[]`、零派单写入）；doc 阶段豁免 G2/G3/G4 并写 `dispatch_gate_skipped` 审计；`[data-channel-warn]` 未走通道告警。
- **幽灵团队/恢复项目**：团队台按名册过滤（空名册 0 行+提示）；删除同事务清四处映射+墓碑+延迟清扫+写者守卫（防旧副本回写）；delete 六步事务化（先落盘后归档，rename 退避+复制兜底）；恢复对「记录已删、目录仍在」重建记录+6 会话映射；墓碑过期/同名重建豁免。
- **在线升级**：更多菜单「检查更新」五态；自动检查开关只提示不下载（非侵入小圆点）；版本源必须带 sha256、缺则不下载；强制升级需 reason+审计；壳层调用 `install.ps1 -Upgrade` 真实升级+备份+回滚+重启提示。

### DSH 套装

- `dsh-agile-workbench@2.2.0`：launcher `pm-workbench-dsh@0.5.0`（安装路径按运行环境推算，无作者绝对路径）；一句话安装脚本钉 `v2.1.0`。

## 2.0.0（2026-11-18）

### DSH 套装与插件市场（2026-11-18 发版当天）

- 套装包更名上架：**`dsh-agile-workbench@2.0.0`**（npm 公开包）。装好原生 DSH 后一句话「帮我安装 dsh-agile-workbench」即可装齐：工作台启动器 `pm-workbench-dsh`、记忆插件 `dsh-memory-evolve`、浏览器插件 `dsh-ego-browser`、搜索 `@liustack/modsearch`、视觉 `@liustack/modlens`、安全搜索 MCP `mcp-web-search-safe`。
- 旧包 `dsh-pm-workbench` 已标记 deprecated 并指向新包；新包自带 `cordis.patch.yml`（6 行 insert + web provider 路由），安装后重启 DSH 生效。
- 仓库 README 更新：一句话安装、组件清单、需求流程、缺陷流程（与《团队宪法》/流程.md 第二部分一致）。

发版前一轮完整闭环：**界面流畅度（缓存/异步/IPC 合并/定时器收敛/骨架屏/差量渲染）、稳定性（崩溃复活兜底）、验收体验（反馈 2.9ms、成功提示可见、慢 IPC 面板可用），以及团队工作流与模板全量对齐（宪法/流程/角色卡/skill/角色卡·宪法·铁律模板）**。

### 新增 · 性能与流畅度

- **主进程缓存层**：读盘缓存（mtime/size 双短路、写后失效、容量上限+两级清理）、热点 IPC 短 TTL（workflow/board/metrics/presence 等）、目录扫描缓存、工作流/项目索引/任务目录热读缓存（R-b34a）。
- **高频 IPC 合并**：同通道+同参数在途合并（只读 allowlist）、写通道直通；慢 IPC 日志落 `性能-YYYYMMDD.jsonl`。
- **渲染层定时器收敛**：统一 `AWBGate`（可见性门/交互期门/15s 合并调度），18 处 interval 按三态收敛，后台/隐藏不轮询；`perf:recent` 只读 IPC + `[data-perf-log]` 慢操作面板。
- **面板骨架屏 + 大列表差量渲染**：团队台/需求池/评审/流程/会话排队六面板先骨架后异步填充；评审列表按签名短路、池缺陷列表行级差量，保留锚点/搜索/选中/滚动。
- **看板窗**：生成页先骨架后加载；磁盘 `看板.html` 复用 + 启动后台预生成（新鲜性经 `board-freshness` 守卫，数据变必重建），首次打开约 1.1s、热开 0/0/16ms。
- **输入路径零阻塞**：打字期间不触发全量刷新/高频 IPC；连续点击抖动门（只拦重渲染入口，不拦抽屉）。

### 新增 · 稳定性与可观测

- **崩溃复活兜底**（`src/crash-guard.js`）：主窗/webview 崩溃限次自动恢复、崩溃后 `window-all-closed` 复活主窗（≤3 次/小时）、显式退出与用户关窗识别、崩溃审计补 `processType/serviceName`。
- **内存门禁与采样**：全进程工作集 ≤2048MB、5 分钟增长 ≤256MB（实测峰值 1400MB、增长 −457MB，A8 通过）。

### 改进 · 验收与评审体验

- 需求验收点击反馈 **2.9ms**（原 8 秒卡顿）：渲染层即时按钮态/进度行/阶段提示，重活后台化，防重复落账；落账总耗时约 1–5s（后端证据扫描与工作流写入，进一步优化列 2.0.1）。
- 验收成功/失败提示在「我的验收」列表内可见（`[data-accept-list-notice]`），失败路径错误可见且零副作用。
- 需求验收权限彻底明确：**只能 Owner 本人**（代管/PM/测试一律不可），缺陷单由 PM 或测试验收（程序硬拦 `PROXY_ACCEPT_FORBIDDEN`）。

### 流程与模板（面向新用户/新项目）

- 《团队宪法》升级：新增 **11a 验收权限**、**26 工装与进程安全（P0）**、**27 基础工作流唯一口径**；TR-Q 归属修正为测试人员。
- `团队/流程.md` 新增**第二部分「现行工作流（发版基线）」**：六角色职责与禁止事项、验收权限硬边界、需求/缺陷/工具三条主流程、派单与环境纪律（`dispatch-check`、不打断、测量窗口、P0 工装、隔离与负载）、证据标准、文档维护分工。
- 六张角色卡 + 六份 skill（pm/product 1.3.x、prog1/prog2/tester/analyst 1.2–1.3）全部对齐；旧版归档、`skill-manifest 1.3.0`。
- 角色卡模板改为**运行时按项目卡生成**（`gen-role-card-template`，11 项待同步清零）；`DEFAULT_CONSTITUTION`/`DEFAULT_IRON` 同步新条款；新建项目 boot 烟测 8/8、scaffold parity 5/5、workflow-align 10/10。
- 项目铁律 + 团队铁律模板：新增维护规则（PM 维护、触发式追加、≤6KB、慎写）与 2026-11-18 发版期教训 7 条。

### 修复

- `session rotate` 补令牌/权限门（`B-cdd0`）；名册唯一写入口 `roster-writer`（`B-4b2f`）。
- 派单前置检查程序门（`dispatch-check`，`T-6e53`）、任务占位归一（`B-d376`）、wake 正文上限与 `task update`（`T-9525`）、boot 简报超限拼装（`B-6c6b`）。
- 验收 8 秒卡顿、`perf:recent` 注册顺序、成功提示不可见（`B-211237-9ded`/`B-213947-0779`/`B-213959-63a8`）。
- 全量缺陷与证据门回归：`selftest 176/176`、`--sq-check 67`、`--layout-check` 三宽、12 条需求回归 28/30（2 红为夹具过期，非回归）。

### 已知限制与 2.0.1 计划

- 看板窗冷开内容约 1.1–6.6s（16MB 看板 HTML 解析为主因，已由磁盘复用+预生成大幅改善；Owner 书面豁免覆盖首装首开 ≤8000ms）。
- 验收落账总耗时 1–5s（`readLegacyTasks`/需求正文哈希/1.5MB 工作流写入），计划把镜像回写与响应解耦。
- A1 输入延迟、A2 事件循环、A7 IPC Top10、A9 连续操作四项为极限指标，未在发版前完成最终复验（Owner 叫停测量），列 2.0.1。
- 团队流程增强（统一轮次统计、boot 后读经验教训/项目铁律、铁律更新广播、任务空转巡检）列 2.0.1。

### 仓库

- 发版前已恢复默认会话阈值（pm 60万/100万，其余 30万/50万），临时提档不进入发布版本；
- 本地仓库 tag `v2.0.0`；发布备份见 `_backup/<ts>-v2.0.0-release.bundle`。

## 1.0.0（2026-11-14）

首个正式版本。PM 工作台从原型收敛为可交付的团队协作壳。

### 新增

- **团队工作台外壳**：Electron 主窗 + DSH WebView，侧栏团队台/项目面板/流程面板/指标徽标。
- **双团队模式**：六角色（PM / 产品 / 需求 / 程序员A / 程序员B / 测试）与四人 fast（PM / 需求 / 程序员A / 测试）。
- **看板驱动自动流转**：角色队列 `role_queues.json` + 路由守护，状态变化唤醒"该做的人"。
- **Owner 评审与验收**：评审弹窗（通过/打回、意见必填）、验收列表行内两键、代管（PR 代记评审决定）、决策箱（逐条决策 + 回执 PM）。
- **新手引导 7 步**：含键盘 →/←/Esc、F1 唤起、示例话术可复制不发送。
- **消息默认唤醒**：角色发消息默认叫醒接收方，30 秒到达判据，正文不截断（上限 ≥2000）。
- **会话轮换与归档**：token 双档（30 万预警 / 50 万强制），`session archive` + `rotate`，接任包自动带未完成任务。
- **证据门**：`task done --evidence` 校验文件存在、mtime、sha256，代码路径比对工作树。
- **需求评审门禁**：需求评审 / 可测性评审（TR-Q）/ Owner 决定三道门，未过门不得派单。
- **DSH 启动器插件**：`pm-workbench-dsh`（`dsh-plugin/`），注册 `pm_workbench_open` 工具。

### 修复

- 角色显示名单一口径：`roleDisplayName()` 唯一读 `团队/工具/../团队.json` 的 `members[].name`，`ROLE_DIRS` 只做落盘路径。
- `recompute-advance` 按"当前重做轮"选任务：开发阶段补 `iteration`、按轮次过滤、`markedRound` 区分显式 0 与无标记。
- 主题开关入口固定在「更多 → 外观」（暗金 / 暖白），标题栏不再加图标（B-0538）。
- 内存徽标改取 `app.getAppMetrics().workingSetSize`，采样含 webview guest。
- 字号全局缩放：`applyZoomToAllWindows` + `applyZoomToAllWebviews`。

### 仓库

- 本地工作树（11-14 全部开发成果）首次入库；远端 11-08 的 6 个修复已确认包含在本地代码内，以本地内容为准合并。
- 清理检查数据目录（`.*-check-data/`）、自测沙盘（`_tmp-*/`）、损坏与备份残留。
