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
import fs, { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, normalize, resolve } from 'node:path'

// R-6bc8（T-37f5）：host half 只读消费 sessionController.state（写侧一律不碰）。
export const inject = ['tools', 'sessionController']

const TOOL_NAME = 'pm_workbench_open'
const START_FILE = 'start.cmd'
const DEFAULT_DIRS = [
  'D:\\deepseek\\agile-workbench',
  'D:\\PM工作台',
  join(homedir(), 'PM工作台'),
]
const INSTALL_COMMAND =
  '$f="$env:TEMP\\pm-workbench-install.ps1"; iwr "https://cdn.jsdelivr.net/gh/781237194/agile-workbench@6031ac5/install.ps1" -OutFile $f; & $f'
const MANUAL_INSTALL_COMMAND =
  'git clone https://github.com/781237194/agile-workbench.git; cd agile-workbench; npm install'

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

/**
 * R-6bc8：会话排队快照采集（host half，只读）。
 * - 排队数只算 placement==='queued'；steering/context 进 byPlacement 明细；
 * - 四态 fail > skip > ok > none（skipped 优先）；
 * - 宿主侧直接 tmp+rename 原子写 团队/状态/会话排队.json（不 require 仓库 lib，cwd 无关）。
 */
/**
 * B-20261117-180718-9229：teamRoot 多级兜底（顺序写死，绝不返回相对路径）。
 * 现场根因：bundle 的 cordis.patch.yml insert config:{} → 配置为空、DSH 进程也没有 TEAM_ROOT
 * → 旧实现返回空串 → join('', '状态', …) 拼出相对路径 → mkdir 抛错 → 被 .catch 静默吞掉，
 * 于是「重启 DSH 后面板永远未接入」且零日志。
 */
const TEAM_STATE_SUBDIR = '状态'

function isTeamRootDir(candidate) {
  const dir = String(candidate || '').trim()
  if (!dir || !isAbsolute(dir)) return false
  try {
    return statSync(join(dir, TEAM_STATE_SUBDIR)).isDirectory()
  } catch {
    return false
  }
}

function workbenchStoreCandidates(pluginConfig) {
  const out = []
  const push = (value) => {
    const text = String(value || '').trim()
    if (text && !out.includes(text)) out.push(text)
  }
  push(process.env.AWB_STORE)
  if (process.env.AWB_DATA_DIR) push(join(process.env.AWB_DATA_DIR, 'userdata', 'workbench.json'))
  if (process.env.DSH_PROFILE_DIR) push(join(process.env.DSH_PROFILE_DIR, 'data', 'userdata', 'workbench.json'))
  for (const dir of defaultWorkbenchDirs(pluginConfig)) push(join(dir, 'data', 'userdata', 'workbench.json'))
  return out
}

function defaultWorkbenchDirs(pluginConfig) {
  const out = []
  const push = (value) => {
    const text = String(value || '').trim()
    if (text && !out.includes(text)) out.push(text)
  }
  if (pluginConfig && typeof pluginConfig.workbenchDir === 'string') push(pluginConfig.workbenchDir)
  push(process.env.AWB_WORKBENCH_DIR)
  push(process.env.PM_WORKBENCH_DIR)
  push(DEFAULT_DIRS[0])
  push(DEFAULT_DIRS[1])
  push(DEFAULT_DIRS[2])
  return out
}

/** 从 workbench.json 的 projects[].path 上溯找到仓库根，再取 <repo>/团队。 */
function teamRootFromWorkbenchStore(pluginConfig) {
  for (const storeFile of workbenchStoreCandidates(pluginConfig)) {
    let store = null
    try { store = JSON.parse(fs.readFileSync(storeFile, 'utf8')) } catch { continue }
    const projects = Array.isArray(store && store.projects) ? store.projects : []
    for (const project of projects) {
      let dir = String((project && project.path) || '').trim()
      while (dir) {
        const candidate = join(dir, '团队')
        if (isTeamRootDir(candidate)) return { teamRoot: candidate, source: 'workbench-store', storeFile, projectPath: dir }
        const parent = dirname(dir)
        if (!parent || parent === dir) break
        dir = parent
      }
    }
  }
  return null
}

/**
 * 解析 teamRoot：cfg → env(AWB_TEAM_ROOT/TEAM_ROOT) → workbench.json 上溯 → 默认工作台目录。
 * 返回 { teamRoot, source, tried, error }；解析不到时 teamRoot='' 且 error.code=SQ_TEAMROOT_UNRESOLVED（绝不拼相对路径）。
 */
export function resolveTeamRoot(pluginConfig) {
  const tried = []
  const consider = (value, source) => {
    const text = String(value || '').trim()
    if (!text) return null
    if (!isAbsolute(text)) {
      tried.push({ source, value: text, ok: false, why: 'NOT_ABSOLUTE' })
      return null
    }
    if (!isTeamRootDir(text)) {
      tried.push({ source, value: text, ok: false, why: 'TEAM_STATE_MISSING' })
      return null
    }
    tried.push({ source, value: text, ok: true, why: '' })
    return { teamRoot: resolve(text), source }
  }

  const fromCfg = consider(pluginConfig && pluginConfig.teamRoot, 'config')
  if (fromCfg) return { ...fromCfg, tried, error: null }
  const fromAwbEnv = consider(process.env.AWB_TEAM_ROOT, 'env:AWB_TEAM_ROOT')
  if (fromAwbEnv) return { ...fromAwbEnv, tried, error: null }
  const fromEnv = consider(process.env.TEAM_ROOT, 'env:TEAM_ROOT')
  if (fromEnv) return { ...fromEnv, tried, error: null }

  const fromStore = teamRootFromWorkbenchStore(pluginConfig)
  if (fromStore) {
    tried.push({ source: 'workbench-store', value: fromStore.teamRoot, ok: true, why: '' })
    return { teamRoot: resolve(fromStore.teamRoot), source: fromStore.source, tried, error: null, storeFile: fromStore.storeFile }
  }
  tried.push({ source: 'workbench-store', value: '', ok: false, why: 'NO_STORE_OR_PROJECT_PATH' })

  for (const dir of defaultWorkbenchDirs(pluginConfig)) {
    const hit = consider(join(dir, '团队'), `default:${dir}`)
    if (hit) return { ...hit, tried, error: null }
  }

  return {
    teamRoot: '',
    source: '',
    tried,
    error: {
      code: 'SQ_TEAMROOT_UNRESOLVED',
      message: '找不到团队目录：DSH 插件未配置 teamRoot，进程也没有 TEAM_ROOT，且从工作台 workbench.json / 默认工作台目录都推不出来。请在 DSH 插件配置里设置 teamRoot（例如 D:/deepseek/agile-workbench/团队）。',
      tried,
    },
  }
}


function atomicWriteJson(file, value, eol = "\n") {
  fs.mkdirSync(dirname(file), { recursive: true })
  const tmp = `${file}.tmp-${process.pid}`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2) + eol, 'utf8')
  fs.renameSync(tmp, file)
}

function queuedOf(state) {
  const queue = state && Array.isArray(state.queue) ? state.queue : null
  if (queue === null) return { known: false, count: null, byPlacement: null }
  const byPlacement = { queued: 0, steering: 0, context: 0 }
  for (const row of queue) {
    const placement = String((row && row.placement) || 'queued')
    byPlacement[placement] = (byPlacement[placement] || 0) + 1
  }
  return { known: true, count: byPlacement.queued || 0, byPlacement }
}

function wakeStateOf(rows, now, staleMs) {
  const list = Array.isArray(rows) ? rows.filter(Boolean) : []
  if (!list.length) return { state: 'none', lastOkAt: '', lastAt: '', lastFailAt: '', stale: false }
  const atOf = (row) => Date.parse(String((row && (row.at || row.deliveredAt || row.deliverAt)) || '')) || 0
  const parsed = list.map((row) => {
    const ok = row.ok === true
    const skipped = row.skipped === true || row.state === 'skipped' || /^skipped$/i.test(String(row.reason || row.why || ''))
    return { ok, skipped, failed: !ok && !skipped, at: atOf(row) }
  }).sort((a, b) => b.at - a.at)
  const lastAt = parsed[0] ? parsed[0].at : 0
  const lastOk = parsed.find((row) => row.ok && row.at)
  const lastOkAt = lastOk ? new Date(lastOk.at).toISOString() : ''
  const lastFail = parsed.find((row) => row.failed && row.at)
  const lastFailAt = lastFail ? new Date(lastFail.at).toISOString() : ''
  const stale = lastAt ? (Number(now) - lastAt) > Number(staleMs) : false
  // B-20261117-181420-9688（P1）：四态取最近一次投递的结果，不能「窗口内曾失败一次就永久 fail」。
  // 同时间戳 tie-break：skip > fail > ok。
  const TIE_RANK = { skip: 3, fail: 2, ok: 1, none: 0 }
  let state = 'none'
  let latestAt = -1
  for (const row of parsed) {
    const kind = row.skipped ? 'skip' : (row.failed ? 'fail' : (row.ok ? 'ok' : 'none'))
    if (row.at > latestAt || (row.at === latestAt && TIE_RANK[kind] > TIE_RANK[state])) {
      state = kind
      latestAt = row.at
    }
  }
  return { state, lastOkAt, lastAt: lastAt ? new Date(lastAt).toISOString() : '', lastFailAt, stale }
}

function readWakeRows(teamRoot, role, activeProject) {
  // 真实落点是「按项目分文件」：团队/状态/项目/<项目>/唤醒.jsonl（实测 1.6MB 级、6000+ 行）。
  // 顶层 团队/状态/唤醒.jsonl 只在旧沙盘/夹具里出现，作兼容回退（只读它会让人以为生产上「无记录」）。
  const candidates = []
  const project = String(activeProject || '').trim()
  if (project) candidates.push(join(teamRoot, '状态', '项目', project, '唤醒.jsonl'))
  candidates.push(join(teamRoot, '状态', '唤醒.jsonl'))
  for (const file of candidates) {
    let text = ''
    try { text = fs.readFileSync(file, 'utf8') } catch { continue }
    const rows = text.split(/\r?\n/).filter(Boolean).map((line) => { try { return JSON.parse(line) } catch { return null } }).filter(Boolean)
    return rows.filter((row) => String((row && row.to) || '') === String(role || ''))
  }
  return []
}

export async function collectSessionQueueSnapshot(ctx, pluginConfig, now = Date.now()) {
  // B-20261117-180718-9229：先解析 teamRoot；解析不到就**明确失败**（绝不落相对路径）。
  const resolved = resolveTeamRoot(pluginConfig)
  const staleMs = Number((pluginConfig && pluginConfig.staleMs) || 120000)
  if (!resolved.teamRoot) {
    try {
      console.error('[sq] teamRoot unresolved ' + JSON.stringify({ code: resolved.error.code, tried: resolved.tried.slice(0, 6) }))
    } catch { /* 控制台不可写时忽略 */ }
    return { ok: false, code: resolved.error.code, message: resolved.error.message, tried: resolved.tried }
  }
  const teamRoot = resolved.teamRoot
  const file = join(teamRoot, TEAM_STATE_SUBDIR, '会话排队.json')
  // 上一份快照：失败时保留它的 roles（不清空面板），并沿用它的 at 作为「上次成功时间」。
  const previous = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } })()

  const writeDegraded = (code, message) => {
    const lastAttemptAt = new Date(Number(now) || Date.now()).toISOString()
    const degraded = { code: String(code || 'SQ_COLLECT_FAILED'), message: String(message || '').slice(0, 300), lastAttemptAt }
    const snapshot = {
      schema: 1,
      at: (previous && previous.at) || lastAttemptAt,
      project: String((previous && previous.project) || ''),
      teamRoot,
      resolveSource: resolved.source,
      staleMs,
      degraded,
      lastAttemptAt,
      roles: Array.isArray(previous && previous.roles) ? previous.roles : [],
    }
    try {
      atomicWriteJson(file, snapshot)
      return { ok: false, code: degraded.code, message: degraded.message, file, wroteDegraded: true, keptRoles: snapshot.roles.length, teamRoot, resolveSource: resolved.source }
    } catch (error) {
      // 连 degraded 都写不进去：只能返回结构化错误（附 errno/path），由宿主日志兜底，不静默。
      return {
        ok: false, code: degraded.code, message: degraded.message, file, wroteDegraded: false,
        writeError: { message: String((error && error.message) || error).slice(0, 300), path: file },
        keptRoles: snapshot.roles.length, teamRoot, resolveSource: resolved.source,
      }
    }
  }

  let team = null
  try {
    team = JSON.parse(fs.readFileSync(join(teamRoot, TEAM_STATE_SUBDIR, '团队.json'), 'utf8'))
  } catch (error) {
    return writeDegraded('SQ_TEAM_JSON_MISSING', `读不到 ${join(teamRoot, TEAM_STATE_SUBDIR, '团队.json')}：${String((error && error.message) || error).slice(0, 160)}`)
  }
  // AC4：没有 sessionId 的角色也要出行（known=false / queued=null），面板显示「—」而不是 0
  const members = Array.isArray(team.members) ? team.members.filter((m) => m && m.role) : []
  const roles = []
  for (const member of members) {
    const role = String(member.role || '')
    const sessionId = String(member.sessionId || '')
    let state = null
    try {
      state = await ctx.sessionController.state({ sessionId }, AbortSignal.timeout(3000))
    } catch { state = null }
    const queued = queuedOf(state)
    const wake = wakeStateOf(readWakeRows(teamRoot, role, team.activeProject), now, staleMs)
    roles.push({
      role, sessionId,
      known: queued.known && Boolean(sessionId),
      queued: queued.known ? queued.count : null,
      byPlacement: queued.byPlacement,
      state: wake.state, lastOkAt: wake.lastOkAt, lastAt: wake.lastAt,
      stale: wake.stale || !queued.known,
    })
  }
  const snapshot = {
    schema: 1,
    at: new Date(Number(now) || Date.now()).toISOString(),
    project: String(team.activeProject || ''),
    teamRoot,
    resolveSource: resolved.source,
    staleMs,
    degraded: null,
    roles,
  }
  try {
    atomicWriteJson(file, snapshot)
  } catch (error) {
    return writeDegraded('SQ_WRITE_FAILED', `写快照失败：${String((error && error.message) || error).slice(0, 200)}；path=${file}`)
  }
  return { ok: true, file, roles: roles.length, teamRoot, resolveSource: resolved.source }
}

export function apply(ctx, config) {
  const pluginConfig = config && typeof config === 'object' ? config : {}

  // R-6bc8：会话排队只读快照（周期采集；卸载自动清）
  ctx.effect(() => {
    const intervalMs = Math.max(2000, Number(pluginConfig.snapshotIntervalMs) || 5000)
    let stopped = false
    const tick = () => {
      if (stopped) return
      Promise.resolve()
        .then(() => collectSessionQueueSnapshot(ctx, pluginConfig))
        // B-20261117-180718-9229：不许静默吞错——采集内部已写 degraded 快照，这里只兜「意外抛出」并留日志。
        .catch((error) => {
          try {
            console.error('[sq] collect threw ' + JSON.stringify({
              code: String((error && error.code) || ''),
              message: String((error && error.message) || error).slice(0, 200),
            }))
          } catch { /* 控制台不可写时忽略 */ }
        })
    }
    tick()
    const timer = setInterval(tick, intervalMs)
    return () => { stopped = true; clearInterval(timer) }
  })

  ctx.effect(() =>
    ctx.tools.register({
      name: TOOL_NAME,
      description:
        '启动本机的 PM工作台（PM Workbench，Electron 桌面应用）。这是 DSH 启动器插件，不把 Electron UI 嵌入 DSH；' +
        '调用后只负责拉起 start.cmd 并立即返回，不等待工作台退出。默认查找 D:\\deepseek\\agile-workbench\\start.cmd，' +
        '也可用 path 参数或 workbenchDir 配置指定安装目录；找不到时会返回安装命令。',
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
        if (!resolved.ok) return resolved

        const blocked = preflight(resolved.target)
        if (blocked) return blocked

        const launched = await launch(resolved.target)
        if (launched.ok) launched.source = resolved.source
        return launched
      },
    }),
  )
}
