/**
 * pm-workbench-dsh —— DSH 启动器插件（Host 侧）
 * ============================================================================
 * 这是「DSH 启动器插件」，不是把 PM工作台的 Electron UI 嵌入 DSH。
 *
 * 它只做一件事：注册工具 `pm_workbench_open`。模型调用时，插件在本机
 * spawn 启动 PM工作台的 start.cmd，然后立刻返回，不等待工作台退出。
 *
 * 查找顺序（显式路径优先，显式路径不存在就直接报错，不偷偷换目录）：
 *   1. 工具参数 path
 *   2. 插件配置 startScript
 *   3. 插件配置 workbenchDir
 *   4. 环境变量 PM_WORKBENCH_START
 *   5. 环境变量 PM_WORKBENCH_DIR
 *   6. 默认：D:\deepseek\agile-workbench\start.cmd
 *   7. 安装器默认：D:\PM工作台\start.cmd
 *   8. 安装器回退：%USERPROFILE%\PM工作台\start.cmd
 *
 * 找不到时返回可读错误、已查找路径和安装命令；不抛异常、不阻塞会话。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, normalize, resolve } from 'node:path'

export const inject = ['tools']

const TOOL_NAME = 'pm_workbench_open'
const START_FILE = 'start.cmd'
const DEFAULT_DIRS = [
  'D:\\PM工作台',
  join(homedir(), 'PM工作台'),
]
const DEFAULT_INSTALLER_URL =
  'https://cdn.jsdelivr.net/gh/781237194/agile-workbench@6031ac5/install.ps1'
const INSTALL_COMMAND =
  '$f="$env:TEMP\\pm-workbench-install.ps1"; iwr "https://cdn.jsdelivr.net/gh/781237194/agile-workbench@6031ac5/install.ps1" -OutFile $f; & $f'
const MANUAL_INSTALL_COMMAND =
  'git clone https://github.com/781237194/agile-workbench.git; cd agile-workbench; npm install'

let bootstrapState = 'idle'
let bootstrapProcess = null

function installerUrl(config) {
  return (typeof config.installerUrl === 'string' && config.installerUrl.trim())
    ? config.installerUrl.trim()
    : DEFAULT_INSTALLER_URL
}

function installerScript(config) {
  const url = installerUrl(config).replace(/'/g, "''")
  return [
    "$ErrorActionPreference='Stop'",
    "$f=Join-Path $env:TEMP 'pm-workbench-install.ps1'",
    `Invoke-WebRequest '${url}' -OutFile $f -UseBasicParsing`,
    '& $f',
  ].join('; ')
}

/**
 * 首次安装：插件本身只负责把安装器拉起来。
 * 不在 apply 中等待（npm install 可能几分钟），安装完成后下一次调用即可启动。
 */
function startBootstrap(config) {
  if (bootstrapProcess) return bootstrapState
  bootstrapState = 'installing'
  try {
    bootstrapProcess = spawn('powershell.exe', [
      '-NoProfile',
      '-ExecutionPolicy', 'Bypass',
      '-Command', installerScript(config),
    ], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      env: { ...process.env, PM_WORKBENCH_AUTO_INSTALL: '1' },
    })
    bootstrapProcess.once('error', () => { bootstrapState = 'failed'; bootstrapProcess = null })
    bootstrapProcess.once('exit', (code) => {
      bootstrapState = code === 0 ? 'done' : 'failed'
      bootstrapProcess = null
    })
    bootstrapProcess.unref()
  } catch {
    bootstrapState = 'failed'
    bootstrapProcess = null
  }
  return bootstrapState
}

function expandHome(value) {
  const text = value.trim()
  if (text === '~') return homedir()
  if (text.startsWith('~/') || text.startsWith('~\\')) return join(homedir(), text.slice(2))
  return text
}

function toAbsolute(value) {
  const expanded = normalize(expandHome(value))
  return isAbsolute(expanded) ? expanded : resolve(process.cwd(), expanded)
}

function isFile(path) {
  try {
    return statSync(path).isFile()
  } catch {
    return false
  }
}

function isDirectory(path) {
  try {
    return statSync(path).isDirectory()
  } catch {
    return false
  }
}

/** 把「目录或 start.cmd」解析成真实存在的启动脚本；不存在返回 null。 */
function targetFrom(value) {
  const path = toAbsolute(value)
  if (isFile(path)) return path
  if (isDirectory(path)) {
    const candidate = join(path, START_FILE)
    if (isFile(candidate)) return candidate
  }
  return null
}

function explicitRequests(args, config) {
  const requests = []
  if (typeof args.path === 'string' && args.path.trim()) {
    requests.push({ source: '工具参数 path', value: args.path })
  }
  if (typeof config.startScript === 'string' && config.startScript.trim()) {
    requests.push({ source: '配置 startScript', value: config.startScript })
  }
  if (typeof config.workbenchDir === 'string' && config.workbenchDir.trim()) {
    requests.push({ source: '配置 workbenchDir', value: config.workbenchDir })
  }
  const envKeys = [
    ['PM_WORKBENCH_START', '环境变量 PM_WORKBENCH_START'],
    ['PM_WORKBENCH_DIR', '环境变量 PM_WORKBENCH_DIR'],
  ]
  for (const [key, source] of envKeys) {
    const value = process.env[key]
    if (typeof value === 'string' && value.trim()) requests.push({ source, value })
  }
  return requests
}

function resolveLaunchTarget(args, config) {
  for (const request of explicitRequests(args, config)) {
    const target = targetFrom(request.value)
    if (target) return { ok: true, target, source: request.source }
    return {
      ok: false,
      code: 'PM_WORKBENCH_PATH_INVALID',
      error: `${request.source} 指向的路径不存在，或目录里没有 ${START_FILE}：${toAbsolute(request.value)}`,
      searched: [toAbsolute(request.value)],
      hint: `请把 path / workbenchDir / startScript 指向 PM工作台安装目录（例如 D:\\deepseek\\agile-workbench）或 ${START_FILE} 文件。`,
    }
  }

  const searched = DEFAULT_DIRS.map((dir) => join(dir, START_FILE))
  for (const dir of DEFAULT_DIRS) {
    const target = targetFrom(dir)
    if (target) return { ok: true, target, source: `默认路径 ${dir}` }
  }

  return {
    ok: false,
    code: 'PM_WORKBENCH_NOT_FOUND',
    error: '没有找到 PM工作台的 start.cmd。',
    searched,
    installCommand: INSTALL_COMMAND,
    manualInstallCommand: MANUAL_INSTALL_COMMAND,
    hint: '安装后如果装在别的目录，请用 path 参数或 workbenchDir 配置指定；装好 PM工作台后不需要重启 DSH。',
  }
}

/**
 * start.cmd 会自己检查 Electron。这里提前查一次，避免窗口没开、
 * 而工具却只报「已启动」的假成功。
 */
function preflight(target) {
  if (basename(target).toLowerCase() !== START_FILE) return null
  const workbenchDir = dirname(target)
  const electronExe = join(workbenchDir, 'node_modules', 'electron', 'dist', 'electron.exe')
  if (existsSync(electronExe)) return null
  return {
    ok: false,
    code: 'PM_WORKBENCH_DEPENDENCIES_MISSING',
    error: `找到了 ${target}，但 PM工作台依赖未安装（缺少 node_modules\\electron\\dist\\electron.exe）。`,
    target,
    installCommand: `cd /d "${workbenchDir}" && npm install`,
    hint: '先在 PM工作台目录执行 npm install，完成后再调用本工具。',
  }
}

async function launch(target) {
  const workbenchDir = dirname(target)
  const extension = extname(target).toLowerCase()
  const isCmdScript = extension === '.cmd' || extension === '.bat'

  if (isCmdScript && /["\r\n]/.test(target)) {
    return {
      ok: false,
      code: 'PM_WORKBENCH_PATH_INVALID',
      error: '启动脚本路径包含双引号或换行，无法安全启动。',
      target,
    }
  }

  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE

  const command = isCmdScript ? env.ComSpec || 'cmd.exe' : target
  // cmd /c 对含空格的路径很挑剔：用 `call "完整路径"` + verbatim 参数，
  // 已实测能启动 C:\...\pm wb test-xxxx\fixture.cmd 这类路径。
  const commandArgs = isCmdScript ? ['/d', '/s', '/c', `call "${target}"`] : []

  let child
  try {
    child = spawn(command, commandArgs, {
      cwd: workbenchDir,
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
      windowsVerbatimArguments: isCmdScript,
      env,
    })
  } catch (error) {
    return {
      ok: false,
      code: 'PM_WORKBENCH_SPAWN_FAILED',
      error: `启动进程失败：${error?.message ?? String(error)}`,
      target,
    }
  }

  // 只等「进程已创建」这一下（最多 1.5 秒），绝不等待工作台退出。
  const outcome = await new Promise((resolveOutcome) => {
    const timer = setTimeout(() => resolveOutcome({ spawned: true, timeout: true }), 1500)
    timer.unref?.()
    child.once('spawn', () => {
      clearTimeout(timer)
      resolveOutcome({ spawned: true })
    })
    child.once('error', (error) => {
      clearTimeout(timer)
      resolveOutcome({ spawned: false, error })
    })
  })

  if (!outcome.spawned) {
    return {
      ok: false,
      code: 'PM_WORKBENCH_SPAWN_FAILED',
      error: `启动进程失败：${outcome.error?.message ?? String(outcome.error)}`,
      target,
    }
  }

  child.unref()

  return {
    ok: true,
    launched: true,
    target,
    workbenchDir,
    pid: child.pid ?? null,
    message: '已提交启动 PM工作台，插件已立即返回。',
  }
}

function renderText(value) {
  if (!value || typeof value !== 'object') return String(value ?? '')
  if (value.ok) {
    return [
      '已提交启动 PM工作台（启动器插件只负责拉起进程，不嵌入 UI）。',
      `启动脚本：${value.target}`,
      `进程 PID：${value.pid ?? '未知'}`,
      '提示：插件已立即返回，不会等待工作台退出；窗口是否成功打开请以桌面为准。',
    ].join('\n')
  }

  if (value.code === 'PM_WORKBENCH_INSTALLING') {
    return [
      'PM工作台尚未安装，插件已在后台启动一键安装。',
      '安装器会自动准备 Node、下载 PM工作台、安装 Electron 依赖并创建桌面入口。',
      '安装完成后再次调用 pm_workbench_open 即可启动；安装日志在安装目录的 _tmp/install-logs。',
    ].join('\n')
  }
  if (value.code === 'PM_WORKBENCH_INSTALL_FAILED') {
    return [
      '自动安装没有启动成功。',
      `原因：${value.error ?? '无法创建安装进程'}`,
      `请手动执行：\n${value.installCommand ?? INSTALL_COMMAND}`,
    ].join('\n')
  }

  const lines = [`启动失败：${value.error ?? '未知错误'}`]
  if (value.code) lines.push(`错误码：${value.code}`)
  if (value.target) lines.push(`目标：${value.target}`)
  if (Array.isArray(value.searched) && value.searched.length > 0) {
    lines.push(`已查找：\n${value.searched.map((path) => `- ${path}`).join('\n')}`)
  }
  if (value.installCommand) lines.push(`安装/修复命令：\n${value.installCommand}`)
  if (value.manualInstallCommand) lines.push(`手动安装（PowerShell）：\n${value.manualInstallCommand}`)
  if (value.hint) lines.push(`提示：${value.hint}`)
  return lines.join('\n')
}

export function apply(ctx, config) {
  const pluginConfig = config && typeof config === 'object' ? config : {}

  // 插件安装后首次加载就自动补工作台；不等安装完成，避免阻塞 DSH 启动。
  if (pluginConfig.autoInstall !== false) {
    const resolved = resolveLaunchTarget({}, pluginConfig)
    if (!resolved.ok && resolved.code === 'PM_WORKBENCH_NOT_FOUND') {
      startBootstrap(pluginConfig)
    }
  }

  ctx.effect(() =>
    ctx.tools.register({
      name: TOOL_NAME,
      description:
        '启动本机的 PM工作台（PM Workbench，Electron 桌面应用）。这是 DSH 启动器插件，不把 Electron UI 嵌入 DSH；' +
        '调用后只负责拉起 start.cmd 并立即返回，不等待工作台退出。默认查找 D:\\PM工作台\\start.cmd，' +
        '也可用 path 参数或 workbenchDir 配置指定安装目录；首次找不到时会自动下载并安装 PM工作台，' +
        '安装完成后再次调用即可启动。',
      parameters: {
        type: 'object',
        properties: {
          path: {
            type: 'string',
            description:
              '可选：PM工作台安装目录或 start.cmd 的绝对路径。省略时依次尝试插件配置、环境变量和默认路径。',
          },
        },
        additionalProperties: false,
      },
      output: {
        schema: {
          type: 'object',
          properties: {},
          additionalProperties: true,
        },
        render: (_args, value) => [{ type: 'text', text: renderText(value) }],
      },
      async execute(args) {
        const input = args && typeof args === 'object' ? args : {}
        const resolved = resolveLaunchTarget(input, pluginConfig)
        if (!resolved.ok) {
          if (resolved.code === 'PM_WORKBENCH_NOT_FOUND' && pluginConfig.autoInstall !== false) {
            const installState = startBootstrap(pluginConfig)
            return {
              ...resolved,
              code: installState === 'failed' ? 'PM_WORKBENCH_INSTALL_FAILED' : 'PM_WORKBENCH_INSTALLING',
              autoInstall: true,
              installState,
              message: installState === 'failed'
                ? '自动安装没有启动成功，请按 installCommand 手动安装。'
                : 'PM工作台尚未安装，插件已在后台启动安装。安装完成后再次调用本工具即可。',
            }
          }
          return resolved
        }

        const blocked = preflight(resolved.target)
        if (blocked) return blocked

        const launched = await launch(resolved.target)
        if (launched.ok) launched.source = resolved.source
        return launched
      },
    }),
  )
}
