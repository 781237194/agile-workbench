# CHANGELOG

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
