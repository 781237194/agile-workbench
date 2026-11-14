# PM工作台（PM Workbench）

本地优先的多角色项目工作台：Electron 桌面端 + 团队协作协议 + DSH 外部会话引擎适配层。

- 当前版本：**v0.1.0**（本地基座可用，仍在迭代）
- 运行平台：Windows / macOS / Linux（Electron 33，Node.js ≥ 20）
- 自有代码许可证：**MIT**
- 默认不联网、不收集遥测；唯一出站请求发往你自己配置的 DSH 地址

> 本仓库是独立实现的新项目（clean-room），不复制其他工作台项目的源码、模板、文档或图片，约定见 [`docs/CLEAN-ROOM.md`](docs/CLEAN-ROOM.md)。

### 核心零插件可跑 · 可选插件按需装

- **核心不依赖任何可选插件**：boot / 派单 / 回执 / 提案 / 评审 / 签字 / apply / 验收 / 看板 / 会话轮换，没装插件也能完整跑。
- **可选插件**（装了更好，不装不坏）：`memory-evolve` 记忆、`modlens` 视觉、`web-search-safe` 搜索。
- **缺插件自动降级**：只标 `memory:off` / `vision:off` / `search:off`，不报错、不阻断核心；`node 团队\工具\team.mjs status`（或 `doctor`）随时看 on/off、版本、数据目录与读取源。
- **安装 / 卸载 / 回滚**：见 [`docs/可选插件.md`](docs/可选插件.md)（含双轨验证与故障处理）。

---

## 新用户最短说明

如果你只是想把 PM工作台跑起来：

1. 装好 **DSH** 并登录（Windows）。
2. 打开 PowerShell，粘贴下面这一行。
3. 等它自动下载、安装依赖、建桌面图标，然后双击 `PM工作台`。

```powershell
$f="$env:TEMP\pm-workbench-install.ps1"; iwr "https://cdn.jsdelivr.net/gh/781237194/agile-workbench@6031ac5/install.ps1" -OutFile $f; & $f
```

这一行会处理 **Node.js 没有安装**的情况：自动下载便携 Node 到安装目录，不写系统 PATH、不需要管理员权限。

### 只装 DSH 插件（自动补齐工作台）

只装 DSH 插件也可以，插件首次加载会自动安装 PM工作台本体、便携 Node、Electron 依赖和桌面入口：

```powershell
dsh plugin --profile desktop add dsh-pm-workbench
```

安装后重启 DSH，插件会在后台启动安装器；安装完成后对 DSH 说“打开 PM工作台”，或调用 `pm_workbench_open`。

> 这条命令安装的是 **DSH 启动器插件**，但它会自动补齐 PM工作台本体，仍然需要联网下载。  
> 如果你不想装 DSH 插件，用上面的 PowerShell 一行命令直接装桌面版也可以。

---

## 一键安装（Windows）

- **已有仓库/压缩包**：双击根目录的 `安装PM工作台.cmd`。
- **不想先下载**：用上面的 PowerShell 一行命令。
- **只想要 zip**：<https://github.com/781237194/agile-workbench/archive/refs/heads/main.zip>，解压后双击 `安装PM工作台.cmd`。
- **卸载**：删除安装目录即可；不会写系统 PATH，不会注册系统服务。

安装器会：

1. 检测 Git 和 Node.js；系统有 Node 20+ 就直接用。
2. 没有 Node 就自动下载 Windows x64 便携 Node.js LTS 到 `<安装目录>\.runtime\node`。
3. 下载/复用仓库，执行 `npm install`。
4. 创建桌面 `PM工作台` 快捷方式，可选立即启动。
5. 重复执行只补依赖，**不覆盖** `data/`、`项目/`、`团队/状态/`。

---

## 一、功能概述

### 项目、任务与看板

- 本地项目库：新建项目、切换项目、从已有目录恢复/登记项目。
- 每个项目自带角色目录、`项目信息.md`、文件索引与需求目录。
- 任务：新建、认领、推进（待办 → 进行中 → 待评审 → 已完成）、删除；完成必须带证据。
- 看板：待办 / 进行中 / 待评审 / 已完成四列，可开半透明悬浮窗。
- 文件索引：扫描项目内文件，只读预览文本、Markdown、图片。

### 协作闭环（提案 → 评审 → 签字 → 应用）

- 提案：文件级变更，绑定 SHA-256 哈希。
- 评审：指定角色逐条通过/拒绝并写理由；作者不能审自己的提案。
- PM 签字：签字绑定 `提案哈希 + 基线哈希`，换版本即作废。
- 应用：先备份再写入，带 CAS 版本栅栏；基线被改过会返回 `STALE_BASE` 并停手。
- 回滚：按备份恢复文件或删除新建文件。
- 团队派单：一次只派一个角色，单待回执锁；**没有回执 = 没发生**。
- 对账：固定表格（项目/指标/期望/实测/结果/证据），只允许 PASS / FAIL。
- Owner 阶段：跳过 / 通过 / 打回；打回回到需求阶段。
- 流程图：8 阶段高亮当前阶段。
- 外观：暗金/暖白双主题。

### DSH 工作区与会话

- 探测 DSH 在线状态；不可用时显示真实错误码，不伪造会话。
- 创建/绑定 DSH 工作区（`workspace/create` 按目录幂等）。
- 建团队：按当前模式创建角色会话、重命名、写名册；支持一键唤醒（`session/prompt`）。
- 嵌入 DSH 工作区页面；归档会话（先停活动再归档）。

---

## 二、六人团队与快速四人模式

团队模式保存在 `project.teamMode`，默认 `full`。切换模式**不会删除**已有会话和目录，只是不再显示/新建成隐藏角色。

| 模式 | 角色 | 评审链路 | 适用场景 |
|---|---|---|---|
| **完整 6 人**（`full`，默认） | 项目经理、产品设计师、需求分析师、程序员 A、程序员 B、测试 | 产品评审 → 开发互审 → PM 签字 | 需要产品/架构设计、双人并行开发 |
| **快速 4 人**（`fast`） | 项目经理、需求分析师、程序员 A、测试 | 需求分析师评审 → Owner 后程序员 A 技术评审 → 复核 | 小改动、单人开发、快速验收 |

角色职责：

| 角色 | id | 职责 |
|---|---|---|
| 项目经理 | `pm` | 纯协调：建需求/任务、派单、催回执、收口；不替别人写文件 |
| 产品设计师 | `product` | 产品与架构：用户故事、流程图/类图、架构方案、优先级建议 |
| 需求分析师 | `analyst` | 需求拆解、验收标准、缺陷闭环、可行性 |
| 高级程序员 A | `programmer1` | 开发 A、提提案、互审；只写授权目录 |
| 高级程序员 B | `programmer2` | 开发 B、提提案、互审；不与 A 抢同一文件 |
| 测试人员 | `tester` | 独立验证、回归、验收报告；不改业务代码 |

快速模式的两处关键差异：

1. 后端只创建 4 个角色会话与目录，`product` / `programmer2` 隐藏且不计入“就绪角色”；
2. 需求评审人从产品设计师换成需求分析师；Owner 决策之后、派单之前增加程序员 A 的技术评审。

界面文案会随模式切换（六角色 → 4 人、产品评审 → 分析师评审、开发互审 → 复核）。

---

## 三、安装与启动

### 环境要求

**最短说明：只需要 Windows + 网络 + DSH，Node.js 会自动装。**

- Windows 10+（一键安装器）；macOS / Linux 桌面环境可手动 `npm install`
- 首次安装需要联网：无系统 Node 时下载便携 Node.js（约 39 MB，解压约 110 MB），以及 Electron 依赖
- Node.js **不需要预装**：
  - 系统已有 Node.js 20+ → 直接使用，不下载；
  - 没有 → 自动下载 Windows x64 便携 Node.js LTS 到 `<安装目录>\.runtime\node`；
  - 优先 `nodejs.org` 官方源，失败自动换 `npmmirror` 镜像；
  - 下载后校验文件非空、zip 文件头；能拿到官方 SHA-256 时校验哈希；最后实际运行 `node.exe` / `npm` 确认可运行；
  - 只把实际使用的 Node 目录临时加入**安装进程**的 PATH，不写系统 PATH、不改系统环境、不需要管理员权限。
- 便携 Node 只用于安装阶段；`start.cmd` 直接启动 Electron，日常运行不需要 Node。

### 安装器细节

安装器会：

1. 检查 Git（可选）和系统 Node.js 20+。系统已有 20+ 就直接用；没有就自动下载 Windows x64 便携 Node.js LTS 到 `<安装目录>\.runtime\node`，只给本安装器与 npm 使用，**不写系统 PATH、不改系统环境、不需要管理员权限**；官方源失败会自动换 npmmirror 镜像。
2. 当前目录是仓库 → 直接使用；否则下载 main 分支 zip 到安装目录（默认本机 `PM工作台` 文件夹，D 盘不存在或不可写时回退 `%USERPROFILE%\PM工作台`），解压后使用。
3. 在仓库目录执行 `npm install`（首次会下载 Electron，可能需要几分钟）。
4. 创建桌面快捷方式 `PM工作台.lnk`，指向 `start.cmd`，图标 `assets\pm-workbench.ico`。
5. 可选立即启动：给命令加 `-Launch`（例如 `安装PM工作台.cmd -Launch`）。

**重复执行是安全的**：系统 Node 或 `.runtime\node` 已有可用版本时直接复用，不重复下载、不覆盖；已有仓库只补依赖，不重新下载；`data\`、`项目\`、`团队\状态\` 等已有内容不会被覆盖。目标目录已有别的文件时安装器会停下并提示换目录，**绝不删除**。

可选参数（加在 `安装PM工作台.cmd` 或 `install.ps1` 后面）：

| 参数 | 作用 |
|---|---|
| `-InstallDir <目录>` | 指定安装目录（默认本机 `PM工作台` 文件夹，回退 `%USERPROFILE%\PM工作台`） |
| `-Launch` | 装完立即启动 |
| `-NoShortcut` | 不创建桌面快捷方式 |
| `-ZipPath <zip>` | 用本地 zip，不联网下载 |
| `-ZipUrl <url>` | 自定义下载地址 |
| `-ShortcutDir <目录>` | 快捷方式输出目录（默认当前用户桌面） |
| `-LogDir <目录>` | 日志目录 |
| `-NonInteractive` | 不暂停，适合自动化（也可设 `AWB_NO_PAUSE=1`） |

如果自动准备 Node 失败（下载、解压或校验不通过），窗口不会立刻关闭，会打印具体原因和日志路径；也可以手动安装 Node.js 20+ LTS 后重跑，安装器会优先使用系统 Node。日志默认在 `<仓库>\_tmp\install-logs\`；全新下载时在 `%LOCALAPPDATA%\PMWorkbench\install-logs\`。

### 直接命令（任意平台）

```powershell
git clone https://github.com/781237194/agile-workbench.git
cd agile-workbench
npm install
npm start          # 或 Windows 双击 start.cmd
```

只想要 zip：<https://github.com/781237194/agile-workbench/archive/refs/heads/main.zip>。

### 启动

Windows 一键启动：

```bat
start.cmd
```

`start.cmd` 会先清掉继承来的 `ELECTRON_RUN_AS_NODE`，检查 Electron 是否存在，再把参数透传：

```bat
start.cmd --selftest
start.cmd --check
start.cmd --help
```

任意平台用 npm：

```powershell
npm start
```

只做启动前检查（不打开窗口）：

```powershell
start.cmd --check          # Windows
npm run check              # 语法检查
npm run test:scripts       # 入口脚本测试（不打开窗口）
```

首次启动后：在左下角配置 DSH 地址 → 新建或恢复项目 → 需要多人协作时用 **🚀 建团队**。

### 常见问题：`app.setPath` 报 undefined

在 DSH / Electron 宿主派生的终端里，`ELECTRON_RUN_AS_NODE` 经常是 `1`，此时 `electron .` 会退化成 Node 解释器，在 `src/main.js` 的 `app.setPath` 处报 `TypeError`。`npm start`、`npm run selftest`、`start.cmd` 都会先删除该变量；手工启动时请自己清理：

```powershell
Remove-Item Env:ELECTRON_RUN_AS_NODE -ErrorAction SilentlyContinue
npx electron .
```

### 自测（沙盘，不碰真实状态）

```powershell
npm run selftest
```

自测使用独立沙盘 `.selftest-data\`（可用 `AWB_SELFTEST_ROOT` 改），截图写到 `.selftest-data\artifacts\selftest.png`。

---

## 四、DSH 依赖

DSH（DeepSeek Harness）是外部会话引擎，用于登记工作区、创建/唤醒角色会话与嵌入工作区。**新建项目本身就要向 DSH 登记工作区**，所以 DSH 未配置或离线时：

- 新建项目会被拒绝并回滚，不留下“本地有项目、DSH 没登记”的半成品；
- 建团队、启动/唤醒会话、嵌入工作区同样返回真实错误码，界面不伪造会话；
- 已登记项目的本地记录、任务与提案仍可查看。

配置与连接：

- 地址配置：界面左下角，持久化到 `<数据根>\dsh.json`；
- 环境变量：`DSH_WEB_URL`（优先级更高）；
- 默认值：`http://127.0.0.1:52711`；
- 通信方式：公开 HTTP JSON-RPC，`POST <origin>/api/<method>`，使用
  `session/list`、`session/create`、`session/rename`、`session/prompt`、
  `workspace/create`、`workspace/archiveSession`；
- 认证：从 `DSH_HOME`（默认 `~/.dsh`）的 `.credentials.yaml` 读取
  `client-connection/browser-session` 会话凭据，在本地派生 HMAC cookie；
  凭据只读，不写入项目、日志或界面；
- 离线行为：返回真实错误码（如 `DSH_OFFLINE`、`DSH_TIMEOUT`、`DSH_AUTH_MISSING`、
  `DSH_AUTH_REJECTED`、`DSH_RPC`），界面不伪造会话。

适配层代码在 [`src/dsh-adapter.js`](src/dsh-adapter.js)，只实现公开协议，不含 DSH 源码。

### 命令行（可选，不经过界面）

```powershell
# 初始化团队协议（生成 团队宪法 / 项目铁律 / 角色卡 / 状态目录）
node 团队\工具\team.mjs init

# 新建工作区（同时向 DSH 登记 workspace）
node 团队\工具\workspace.mjs create --name "示例项目" --root "<项目根目录>" --engine-url "http://127.0.0.1:<DSH端口>"

# 导入角色空会话（默认不烧 token）
node 团队\工具\launch.mjs --project "示例项目" --workspace "<项目目录>" --roles pm,analyst,programmer1,tester --no-prompt --add-members --engine-url "http://127.0.0.1:<DSH端口>"
```

---

## 五、数据目录

默认数据根是仓库内的 `data\`，数据跟着仓库走，不写死盘符。

| 路径 | 内容 | 入库 |
|---|---|---|
| `<仓库>\data\userdata\` | Electron / Chromium profile、状态库 `workbench.json` | 否 |
| `<仓库>\data\tmp\` | 应用临时目录 | 否 |
| `<仓库>\data\dsh.json` | DSH 地址 | 否 |
| `<仓库>\.selftest-data\` | 自测沙盘：状态库、团队状态、`artifacts\selftest.png` | 否 |
| `<仓库>\_tmp\` | 导出 / 测试 / 安装日志临时目录 | 否 |
| `<仓库>\团队\状态\` | 团队运行态：名册、令牌、消息、提案、提交、锁、事件、授权 | 否 |
| `<仓库>\团队\日志\` | 每日人读日志 | 否 |
| `<仓库>\项目\<项目名>\` | 各项目自己的需求、角色目录、代码与索引 | 否 |

可选环境变量：

| 变量 | 作用 | 默认 |
|---|---|---|
| `AWB_DATA_DIR` | 应用数据根 | `<仓库>\data` |
| `AWB_SELFTEST_ROOT` | 自测沙盘根 | `<仓库>\.selftest-data` |
| `TEAM_ROOT` | 团队账本根 | `<仓库>\团队` |
| `TEAM_PROJECTS_ROOT` | 团队项目区根 | `<仓库>\项目` |
| `DSH_HOME` | DSH 配置目录（读凭据） | `~\.dsh` |
| `DSH_WEB_URL` | DSH 地址覆盖 | 界面配置或 `http://127.0.0.1:52711` |

注意：

- 应用临时目录被重定向到 `<数据根>\tmp`，不写 `%TEMP%`；团队 CLI 仍可能用系统 `%TEMP%`，需要整条链路隔离时先设 `TEMP` / `TMP`。
- `--user-data-dir` 会被 `src/main.js` 的 `app.setPath('userData', ...)` 覆盖；自测隔离请用 `AWB_SELFTEST_ROOT`。

---

## 六、安全边界

1. **本地优先**：不收集遥测，不上传项目内容；唯一出站请求发往你配置的 DSH 地址。
2. **渲染层隔离**：`contextIsolation: true`、`nodeIntegration: false`，页面只能调用
   [`src/preload.js`](src/preload.js) 暴露的白名单 IPC；主进程对参数做路径与类型校验。
3. **文件访问受限**：预览/打开文件先解析真实路径并校验是否在允许根内，文本上限 512 KB、图片上限 8 MB；
   索引扫描限制深度与文件数。
4. **凭据只读**：DSH 会话凭据只从 `DSH_HOME` 读取，用于本地派生 cookie；不写入项目文件、日志、界面或状态库。
5. **写入有闸门**：文件变更只走 `propose → show → review → sign → apply`；apply 前备份并做 CAS 校验；
   Owner 决策与签字必须由界面显式操作。
6. **私有数据不入库**：`.gitignore` 覆盖 `项目/`、`data/`、`团队/状态/`、`团队/日志/`、`团队/看板.*`、
   `_tmp/`、`_backup/`、`_archive/`、`.selftest-data*/`、`userdata*/`、`probe-receipts/` 与常见凭据文件名。
7. **已知取舍**：preload 需要 Node 能力，因此窗口 `sandbox` 关闭、`webviewTag` 开启用于嵌入 DSH；
   信任边界由 preload 白名单 + 主进程校验承担，不要把不受信任的网页当成本应用页面加载。

发布前建议自查包内容：

```powershell
npm pack --dry-run
```

---

## 七、目录结构

```text
src/main.js                     Electron 主进程、本地 API、窗口与 IPC
src/preload.js                  安全桥（contextBridge 白名单）
src/dsh-adapter.js              DSH 外部引擎适配层
src/team-tools.js               团队工具入口与工作流封装
src/renderer/                   独立界面（index.html / app.js / style.css）
scripts/run-electron.cjs        Electron 启动器（先清 ELECTRON_RUN_AS_NODE）
scripts/test-entrypoints.cjs    入口脚本测试（不打开窗口）
团队/工具/                       团队命令行：team / workspace / launch 及 lib
团队/角色/                       六个角色卡 + 启动卡 + 索引
团队/模板/                       提案、评审、签字、授权、对账、需求模板
团队/协议/                       六份协作细则
团队/流程.md                     从需求到收口的阶段表与闸门
docs/ARCHITECTURE.md            分层、数据与流程状态
docs/FEATURE-MATRIX.md          功能矩阵
docs/CLEAN-ROOM.md              clean-room 约定
assets/                         应用图标（pm-workbench.ico / pm-workbench.png）
install.ps1                     Windows 一键安装器（环境检查 / 便携 Node / 下载 / 依赖 / 快捷方式）
安装PM工作台.cmd                Windows 双击入口，调用 install.ps1
start.cmd                       Windows 一键启动
```

---

## 八、开源分发

发包内容由 `package.json` 的 `files` 白名单决定，只包含：

- `src/`
- `assets/pm-workbench.ico`、`assets/pm-workbench.png`
- `scripts/run-electron.cjs`、`scripts/test-entrypoints.cjs`
- `团队/工具/`、`团队/角色/`、`团队/模板/`、`团队/协议/`
- `install.ps1`、`安装PM工作台.cmd`
- `LICENSE`、`NOTICE.md`、`README.md`、`start.cmd`

私有项目、运行数据、团队状态与日志、备份、归档、临时文件、凭据都不会被打包。预览：

```powershell
npm pack --dry-run
```

---

## 九、当前边界

- v0.1 完成本地基座、六角色/快速四人的 DSH 会话启动与协作闭环；
- DSH 事件流（轮询/推送）与场景页签仍在推进，独立安装包（exe/msi）与自动更新尚未提供；Windows 一键安装脚本已提供（`install.ps1` + `安装PM工作台.cmd`），需要时自动下载便携 Node.js，不要求预装 Node；
- DSH 适配层只通过公开 HTTP 协议连接，不复制 DSH 内部实现；
- 主要验证平台为 Windows，macOS / Linux 未做完整回归。

---

## 十、许可证

自有代码采用 **MIT**，见 [`LICENSE`](LICENSE)。

第三方组件与运行时（Electron、Node.js 内置模块、DSH 等）保留各自许可证，
说明见 [`NOTICE.md`](NOTICE.md)。
