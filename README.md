# pm-workbench-dsh —— PM工作台 DSH 启动器插件

> **它是什么**：一个可安装的 DSH bundle（Host 侧插件）。装进 DSH 后注册工具 `pm_workbench_open`，
> 让模型可以拉起本机的 PM工作台。
>
> **它不是什么**：**不是把 PM工作台的 Electron UI 嵌入 DSH**，也不是 DSH 会话桥、不是安装器，
> 不读取工作台的项目数据，也不修改 Electron 主分支的任何源码。

- 包名：`pm-workbench-dsh`
- 插件类型：DSH Host 插件（无 Client/UI 半边）
- 许可证：MIT
- 适用 DSH：`>=0.2.2-rc.1 <0.3.0`（`engines.dsh`）
- 适用平台：Windows（通过 `start.cmd` 启动）

---

## 一、安装

在已经装好 DSH 的机器上执行：

```powershell
dsh plugin --profile desktop add github:781237194/agile-workbench#dsh-plugin
```

安装后重启 DSH（或新开一个会话），在工具列表里应能看到 `pm_workbench_open`。

### 依赖

| 依赖 | 说明 |
|---|---|
| DSH | `>=0.2.2-rc.1 <0.3.0`，不满足时 DSH 会拒绝安装/激活 |
| PM工作台 | 本机已安装，并且执行过 `npm install`（需要 `node_modules\electron\dist\electron.exe`） |
| 操作系统 | Windows 10+，因为启动入口是 `start.cmd` |
| Node.js | 插件只使用 DSH 自带的 Node 内置模块，不需要额外 `npm install` |

PM工作台还没装时，插件会返回可读错误和下面这条安装命令：

```powershell
$f="$env:TEMP\pm-workbench-install.ps1"; iwr "https://cdn.jsdelivr.net/gh/781237194/agile-workbench@6031ac5/install.ps1" -OutFile $f; & $f
```

也可以手动安装：

```powershell
git clone https://github.com/781237194/agile-workbench.git
cd agile-workbench
npm install
```

---

## 二、使用

安装后直接对 DSH 说“打开 PM工作台”，或让模型调用：

```text
pm_workbench_open
```

可选参数：

| 参数 | 类型 | 说明 |
|---|---|---|
| `path` | string，可选 | PM工作台安装目录，或 `start.cmd` 的绝对路径；省略时按下面的顺序自动查找 |

### 查找顺序

1. 工具参数 `path`
2. 插件配置 `startScript`
3. 插件配置 `workbenchDir`
4. 环境变量 `PM_WORKBENCH_START`
5. 环境变量 `PM_WORKBENCH_DIR`
6. 安装器默认 `D:\PM工作台\start.cmd`
7. 安装器回退 `%USERPROFILE%\PM工作台\start.cmd`

显式路径（参数/配置/环境变量）不存在时直接报错并列出该路径，**不会**偷偷换成别的目录。
全部默认路径都找不到时，返回已查找路径、安装命令和手动安装命令。

### 可选配置（高级）

在 DSH profile 的 `cordis.patch.yml` 里按行 id 覆盖配置：

```yaml
- id: pm-workbench-dsh
  config:
    workbenchDir: 'D:\PM工作台'
```

也可以不写配置，直接用环境变量：

```powershell
$env:PM_WORKBENCH_DIR = 'D:\PM工作台'
```

改了配置后需要让插件重新加载（DSH 重启或重新挂载该行）。

---

## 三、行为与边界

调用一次工具时，插件会：

1. 解析并确认 `start.cmd` 存在；
2. 如果目标是标准的 `start.cmd`，先确认 `node_modules\electron\dist\electron.exe` 存在；
3. 删除继承的 `ELECTRON_RUN_AS_NODE`，用 `child_process.spawn` 以 **detached + stdio ignore** 方式启动；
4. 最多等 1.5 秒确认进程已创建，然后 `unref()` 并立即返回，**不等待工作台退出**。

限制：

- **不嵌入 UI**：DSH 里不会出现 PM工作台的界面；它只是拉起本机窗口。
- **不安装依赖**：Electron/Node 依赖仍需在 PM工作台目录执行 `npm install`。
- **不确认窗口最终打开**：进程创建成功只代表启动命令已提交；窗口是否出现、是否被单实例锁拦下，以桌面为准。
- **不管理进程生命周期**：不提供关闭、重启、状态查询；重复调用由 PM工作台自身的单实例行为处理。
- **只支持 Windows**：入口固定为 `start.cmd`，没有 macOS/Linux 启动分支。
- **无 locale/icon 元数据**：本包按最小文件集发布（`index.js`、`cordis.patch.yml`、`README.md`、`LICENSE`），
  插件管理器会回退显示包名与 `description`，不提供自定义图标。
- **不读工作台数据**：不访问 `data\`、`项目\`、`团队\状态\`、凭据或 DSH 会话正文。
- **插件本身不联网**：唯一网络动作发生在用户执行上面的安装命令时。

---

## 四、这是什么类型的 DSH 包

```text
pm-workbench-dsh/
├── package.json        # dsh.bundle.patch 指向 cordis.patch.yml
├── cordis.patch.yml    # insert 一个 Host 插件 row（id: pm-workbench-dsh）
├── index.js            # ESM Cordis 插件：inject=['tools']，注册 pm_workbench_open
├── README.md
└── LICENSE
```

`cordis.patch.yml` 只插入一行：

```yaml
- insert:
    - id: pm-workbench-dsh
      name: pm-workbench-dsh
      config: {}
```

这个分支**只有启动器插件包**，不包含 Electron 源码、`node_modules`、项目数据、团队状态或任何本机私有数据。
PM工作台本体仍在仓库的 `main` 分支。

---

## 五、开发与验证

在本包目录：

```powershell
node --check index.js
npm pack --dry-run
```

`npm pack` 的产物应只包含 `index.js`、`cordis.patch.yml`、`README.md`、`LICENSE`（以及 npm 自动附带的 `package.json`）。

## 六、许可证

MIT，见 [LICENSE](./LICENSE)。

PM工作台本体、Electron、Node.js 与 DSH 各自保留其原有许可证。
