# dsh-pm-workbench —— PM工作台套装 bundle

> **一句话安装**：在 DSH 里对 AI 说 **「帮我装一下 dsh-pm-workbench」**。
>
> 装完即得到：工作台启动器（`pm_workbench_open`）+ 记忆插件 + 浏览器插件 + 搜索插件 + 视觉插件 + 安全搜索 MCP。
> node 运行时不用单装，`@deepseek-ai/dsh-base` 已内置 `ptc-runtime-node`。

- 包名：`dsh-pm-workbench`
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

> 帮我装一下 dsh-pm-workbench

AI 会走 `plugin_manager` 的 `install_bundle`：装包 + 把包名注册进 profile 的 `dsh.profile.bundles`。

### 方式 B：命令行

```powershell
# 1) 装包（只是 pnpm add，不会注册 bundle）
dsh plugin --profile <profile> add dsh-pm-workbench

# 2) 注册 bundle（关键一步，漏了插件不会上树）
#    在 <DSH_HOME>/profiles/<profile>/package.json 的 dsh.profile.bundles 里加一行：
#      "dsh-pm-workbench"
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
| `DSH_WEB_SEARCH_SAFE_SCRIPT` | `<profile>/node_modules/dsh-pm-workbench/mcp/web-search-safe.js` | 安全搜索脚本；想换成你自己那份完整版就指过去 |

`mcp/web-search-safe.js` 是**零第三方依赖**的精简版：`web_search` 走 Bing RSS；`web_fetch` 仅允许 http/https、禁内网/本机地址、每一跳重定向重校验、响应按字节限量。它不读 DSH 凭据、不写任何文件。

## 四、从"单装 5 个插件"迁移过来（重要）

如果 profile 里已经把 `dsh-ego-browser` / `@liustack/modsearch` / `@liustack/modlens` / `dsh-memory-evolve` / `pm-workbench-dsh` **各自**注册成了 bundle，
再接上 `dsh-pm-workbench` 会出现**同一插件两份实例**（id 重复/服务重复）。

迁移步骤：

1. 在 profile 的 `dsh.profile.bundles` 里**删掉**这 5 个单项，只留 `dsh-pm-workbench`；
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
