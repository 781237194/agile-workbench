# dsh-agile-workbench —— PM工作台套装 bundle

> **一句话安装**：在 DSH 里对 AI 说 **「帮我装一下 dsh-agile-workbench」**。
>
> 装完即得到：工作台启动器（`pm_workbench_open`）+ 记忆插件 + 浏览器插件 + 搜索插件 + 视觉插件 + 安全搜索 MCP。
> **不需要预装 Node.js**（MCP 用运行 DSH 的同一运行时）；**第一次打开工作台会自动安装本体**（便携 Node / Electron / 应用，约 2–5 分钟），不会再让你粘命令。
> node 运行时不用单装，`@deepseek-ai/dsh-base` 已内置 `ptc-runtime-node`。

- 包名：`dsh-agile-workbench`
- 类型：DSH bundle（**只做 `cordis.patch.yml` + `dependencies`**，自身不注册插件、不 insert 自己）
- 适用 DSH：`>=0.2.2-rc.1 <0.3.0`（`engines.dsh`）
- 许可证：MIT

---

## 一、它装了什么

| # | 行 id | 包 | 作用 |
|---|---|---|---|
| 1 | `pm-workbench-dsh` | `pm-workbench-dsh`（随包，见 `pm-workbench-dsh/`） | 注册工具 `pm_workbench_open`，拉起本机 PM工作台 |
| 2 | `dsh-memory-evolve` | `dsh-memory-evolve` | 跨会话长期记忆 / 待办 / 技能 |
| 3 | `ego-browser` | `dsh-ego-browser` | 受控浏览器（ego lite） |
| 4 | `modsearch` | `@liustack/modsearch` | 联网搜索 / 读网页 / X 检索 |
| 5 | `modlens` | `@liustack/modlens` | 图片视觉读取 |
| 6 | `mcp-web-search-safe` | `@deepseek-ai/dsh-mcp-client` + 随包脚本 `mcp/web-search-safe.js` | 只读安全搜索/抓取 MCP（`web_search` / `web_fetch`） |

`cordis.patch.yml` 一次 `insert` 全部 6 行；套装包本身不上树，避免循环。

## 二、安装

### 方式 A（推荐）：让 AI 装

对 DSH 说：

> 帮我装一下 dsh-agile-workbench

AI 会走 `plugin_manager` 的 `install_bundle`：装包 + 把包名注册进 profile 的 `dsh.profile.bundles`。

**一句话之后会自动发生（套装 `dsh-agile-workbench` 2.2.1 · 应用本体 v2.1.1）**：

1. 首次打开工作台时，启动器发现本机没有本体 → 自动后台运行官方安装器（便携 Node + Electron + 应用 + 桌面快捷方式），**无需 Node、无需管理员权限**；
2. 工作台启动/首启后执行一次 **DSH 互通探针**（只读，不写 DSH、不改 asar），结果进 `data/install-result.json` 与「关于」页，失败不阻断；
3. **可读日志**：每阶段结果写 `data/install-result.json`（`ok/stage/next/warnings[]`），MCP 失败写 `~/.dsh/logs/mcp-*.log`（command/args/errno/stderr），不再只有 "server is disconnected"；
4. **在线升级**：工作台「更多 → 检查更新」；源缺 `sha256` 时显示「暂不可升级」且不下载；强制升级需填原因并写审计；成功提示明确「请重启后生效 / 无需重启」；
5. **开局引导**：新项目第一次 `boot` 的简报带「可直接复制的下一步命令」+ 红线「禁止用 DSH 子代理代跑团队角色任务」。

> 详细 FAQ（`AWB_NO_MIRROR=1`、Electron 缓存兜底、`~/.dsh/logs`、执行策略）见仓库根 `README.md` 的「安装 FAQ（干净 Windows / 无 Node）」。

### 方式 B：命令行

```powershell
# 1) 装包（只是 pnpm add，不会注册 bundle）
dsh plugin --profile <profile> add dsh-agile-workbench

# 2) 注册 bundle（关键一步，漏了插件不会上树）
#    在 <DSH_HOME>/profiles/<profile>/package.json 的 dsh.profile.bundles 里加一行：
#      "dsh-agile-workbench"
```

重启 DSH / 新开会话后生效。

### 验证

```powershell
dsh --profile <profile> --dump-config
```

组合树里应能看到上面 6 个行 id（`pm-workbench-dsh` … `mcp-web-search-safe`）。

## 三、可配置项（都不含密钥）

`mcp-web-search-safe` 的脚本位置不写死任何本机路径，两个环境变量可覆盖：

| 环境变量 | 默认值 | 说明 |
|---|---|---|
| `DSH_WEB_SEARCH_SAFE_NODE` | PATH 里的 `node` | 启动 MCP 脚本的 node 可执行文件 |
| `DSH_WEB_SEARCH_SAFE_SCRIPT` | `<profile>/node_modules/dsh-agile-workbench/mcp/web-search-safe.js` | 安全搜索脚本；想换成你自己那份完整版就指过去 |

`mcp/web-search-safe.js` 是**零第三方依赖**的精简版：`web_search` 走 Bing RSS；`web_fetch` 仅允许 http/https、禁内网/本机地址、每一跳重定向重校验、响应按字节限量。它不读 DSH 凭据、不写任何文件。

## 四、从"单装 5 个插件"迁移过来（重要）

如果 profile 里已经把 `dsh-ego-browser` / `@liustack/modsearch` / `@liustack/modlens` / `dsh-memory-evolve` / `pm-workbench-dsh` **各自**注册成了 bundle，
再接上 `dsh-agile-workbench` 会出现**同一插件两份实例**（id 重复/服务重复）。

迁移步骤：

1. 在 profile 的 `dsh.profile.bundles` 里**删掉**这 5 个单项，只留 `dsh-agile-workbench`；
2. `dependencies` 里这 5 个包可以保留（版本由套装声明），也可以删掉让套装带；
3. `dsh --profile <profile> --dump-config` 确认每个行 id 只出现一次。

## 五、目录

```
dsh-plugin/
  package.json          套装包（dsh.bundle.patch -> ./cordis.patch.yml）
  cordis.patch.yml      6 行 insert
  mcp/web-search-safe.js 随包安全搜索 MCP（零依赖）
  pm-workbench-dsh/     工作台启动器子包（index.js，可单独安装）
  README.md
  LICENSE
```

## 六、边界

- 不改 DSH 本体，不写 `<DSH_HOME>/profiles/desktop`（Electron 专属 profile 由桌面应用管理）。
- 不涉及 npm 发布凭据；`pm-workbench-dsh` 以 `file:./pm-workbench-dsh` 随套装携带，也可单独发布。
- `dsh-memory-evolve` 目前是本机私有包（`0.1.0`），对外分发前需先发布到 registry 或改成本地路径。


---

## 七、需求流程与缺陷流程（这套工作台怎么干活）

### 需求流程（功能/改造）

1. **Owner 提目标** → PM 建需求条目，需求分析师写需求正文（用户故事、边界六类、验收标准、异常）。
2. **产品设计师评审**：通过（RR）才往下走；复杂需求由测试人员先做一遍可测性评审（TR-Q）。
3. **Owner 评审**：Owner 本人在界面「评审弹窗」点「通过」后才允许开发；需求正文一改，旧决定自动失效，必须重评。
4. **PM 派开发**：一次只派一个角色、一个任务；派单前跑「派单前置检查」，目标角色空闲才发。
5. **开发提交**：程序员 A/B 直接实现并提交（提交信息带任务号+需求号），不需要提案/互审/签字。
6. **测试确认**：测试人员独立复验（隔离环境、真实证据、版本递增不覆盖），写测试报告。
7. **Owner 验收**：需求到「待验收」后由 **Owner 本人**在「我的验收」点通过——**代管/PM/测试都不能代验需求**。
8. **迭代**：Owner 打回走「迭代」入口，分析师改稿后重新走 2–7。

### 缺陷流程（Bug/场景缺陷）

1. 任何角色发现缺陷 → 立缺陷单（必带复现步骤 + 验收标准），PM 定优先级（P0/P1/P2/P3）。
2. PM 派开发 → 开发修复并提交（提交信息带缺陷号）→ 测试人员复验并出具报告+证据。
3. **PM 或测试人员**用 `task accept` 验收缺陷单（需求级验收不在此列，只能 Owner 本人）。
4. P0 缺陷当天修；P1 三天内；P2 一周内；P3 两周内。

> 完整口径见仓库内《团队宪法》与 `团队/流程.md` 第二部分「现行工作流」。


## 七、零额外步骤（一句话之后会自动做什么）

1. AI 调用 `plugin_manager install_bundle` 安装 `dsh-agile-workbench`，6 行插件全部上树；
2. 第一次对 AI 说「打开工作台」（或 AI 自动调用 `pm_workbench_open`）时：
   - 插件找不到工作台本体 → **自动在后台启动官方安装器**（`install.ps1`：便携 Node、Electron、应用本体、桌面快捷方式）；
   - 工具立即返回「正在安装，约 2–5 分钟」；安装完成后再次调用即可打开；
   - 安装日志：`%TEMP%\pm-workbench-install.log`。
3. 安全搜索 MCP 默认用运行 DSH 的运行时（Electron 下 `ELECTRON_RUN_AS_NODE=1`），**PATH 里没有 node 也能连通**；仍可用环境变量 `DSH_WEB_SEARCH_SAFE_NODE` / `DSH_WEB_SEARCH_SAFE_SCRIPT` 覆盖。
