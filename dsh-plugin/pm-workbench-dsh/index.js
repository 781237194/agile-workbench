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
 * 找不到时**自动在后台启动官方安装器**（install.ps1，装好 Node/Electron/应用本体），
 * 并返回「正在安装，约 2–5 分钟后重试」；也可传 skipInstall=true 只看安装命令。
 * 不抛异常、不阻塞会话。
 * ============================================================================
 */
import { spawn } from 'node:child_process'
import fs, { existsSync, statSync } from 'node:fs'
import { homedir } from 'node:os'
import { basename, dirname, extname, isAbsolute, join, normalize, resolve } from 'node:path'
// c9ac 快照 v2：复用 session-queue.js 的唯一组装实现（三条通道共用一套 schema，不另立第二套）。
import {
  SNAPSHOT_SCHEMA,
  SNAPSHOT_FILE,
  buildLiveSnapshot,
  applyStateFrame,
  snapshotEqualsExceptAt,
} from './session-queue.js'

// R-6bc8（T-37f5）：host half 只读消费 sessionController.state（写侧一律不碰）。
export const inject = ['tools', 'sessionController']

const TOOL_NAME = 'pm_workbench_open'
const START_FILE = 'start.cmd'
const DEFAULT_DIRS = [
  'D:\\deepseek\\agile-workbench',
  'D:\\PM工作台',
  join(homedir(), 'PM工作台'),
]
const INSTALLER_SCRIPT_URL =
  'https://cdn.jsdelivr.net/gh/781237194/agile-workbench@96395f1/install.ps1'
const INSTALL_COMMAND =
  '$f="$env:TEMP\\pm-workbench-install.ps1"; iwr "' + INSTALLER_SCRIPT_URL + '" -OutFile $f; & $f'
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

const INSTALL_INFLIGHT = { startedAt: 0, logFile: '' }

/**
 * 找不到工作台本体时自动引导安装：后台启动官方 install.ps1，
 * 立即返回。安装器自己负责便携 Node / Electron / 应用与桌面入口。
 * 5 分钟内重复调用不重复起安装进程。
 */
function autoBootstrapInstall() {
  if (INSTALL_INFLIGHT.startedAt && Date.now() - INSTALL_INFLIGHT.startedAt < 5 * 60 * 1000) {
    return { started: false, reused: true, logFile: INSTALL_INFLIGHT.logFile }
  }
  const logDir = process.env.TEMP || process.env.TMP || homedir()
  const logFile = join(logDir, 'pm-workbench-install.log')
  const safeLog = logFile.replace(/'/g, "''")
  const script =
    "$ProgressPreference='SilentlyContinue'; " +
    "$f=Join-Path $env:TEMP 'pm-workbench-install.ps1'; " +
    "try { iwr '" + INSTALLER_SCRIPT_URL + "' -OutFile $f -UseBasicParsing } " +
    "catch { iwr '" + INSTALLER_SCRIPT_URL + "' -OutFile $f }; " +
    "& $f *> '" + safeLog + "'"
  const env = { ...process.env }
  delete env.ELECTRON_RUN_AS_NODE
  let child
  try {
    child = spawn(
      process.env.ComSpec || 'powershell.exe',
      ['/d', '/s', '/c', 'powershell -NoProfile -ExecutionPolicy Bypass -Command "' + script + '"'],
      { detached: true, stdio: 'ignore', windowsHide: true, env },
    )
  } catch (error) {
    return { started: false, error: error?.message ?? String(error), logFile }
  }
  child.unref()
  INSTALL_INFLIGHT.startedAt = Date.now()
  INSTALL_INFLIGHT.logFile = logFile
  return { started: true, pid: child.pid ?? null, logFile }
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

function readTeamOf(teamRoot) {
  return JSON.parse(fs.readFileSync(join(teamRoot, TEAM_STATE_SUBDIR, '团队.json'), 'utf8'))
}

function membersOf(team) {
  return (Array.isArray(team && team.members) ? team.members : []).filter((m) => m && m.role)
}

/** 唤醒行按角色分组（schema 2 一次组装，避免每行重复读同一份 唤醒.jsonl）。 */
function wakesOf(teamRoot, team) {
  const wakes = {}
  for (const member of membersOf(team)) {
    const role = String(member.role || '')
    wakes[role] = readWakeRows(teamRoot, role, team.activeProject)
  }
  return wakes
}

/** 兜底采样：每角色读一次 state()，把结果合进 live（保留 runningSince/lastEventAt 连续性）。 */
async function sampleInto(ctx, team, live, now = Date.now()) {
  for (const member of membersOf(team)) {
    const role = String(member.role || '')
    const sessionId = String(member.sessionId || '')
    const entry = live.get(role) || { sessionId }
    entry.sessionId = sessionId
    let state = null
    if (sessionId) {
      try { state = await ctx.sessionController.state({ sessionId }, AbortSignal.timeout(3000)) } catch { state = null }
    }
    live.set(role, applyStateFrame(entry, state, now))
  }
  return live
}

/**
 * 组装 + 落盘（订阅去抖与 60s 兜底共用这一条写路径）。
 * skipIfUnchanged（兜底专用）：除 at 外与上一份全等 → 不写盘（3 分钟静置 ≤2 次写/读）。
 */
function publishSnapshot({ teamRoot, resolveSource, team, live, now = Date.now(), staleMs = 120000, degraded = null, skipIfUnchanged = false } = {}) {
  const file = join(teamRoot, TEAM_STATE_SUBDIR, SNAPSHOT_FILE)
  const previous = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } })()
  const snapshot = buildLiveSnapshot({
    project: team && team.activeProject, teamRoot, live, wakes: wakesOf(teamRoot, team), now, staleMs, degraded,
  })
  snapshot.resolveSource = resolveSource
  if (skipIfUnchanged && previous && previous.schema === SNAPSHOT_SCHEMA && snapshotEqualsExceptAt(previous, snapshot)) {
    return { ok: true, file, skipped: true, reason: 'UNCHANGED', roles: snapshot.roles.length, teamRoot, resolveSource, schema: SNAPSHOT_SCHEMA }
  }
  try {
    atomicWriteJson(file, snapshot)
  } catch (error) {
    return {
      ok: false, code: 'SQ_WRITE_FAILED', file, wroteDegraded: false,
      message: `写快照失败：${String((error && error.message) || error).slice(0, 200)}`, teamRoot, resolveSource,
    }
  }
  return { ok: true, file, roles: snapshot.roles.length, teamRoot, resolveSource, schema: SNAPSHOT_SCHEMA, skipped: false }
}

export async function collectSessionQueueSnapshot(ctx, pluginConfig, now = Date.now(), runtime = {}) {
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
  const file = join(teamRoot, TEAM_STATE_SUBDIR, SNAPSHOT_FILE)
  // 上一份快照：失败时保留它的 roles（不清空面板），并沿用它的 at 作为「上次成功时间」。
  const previous = (() => { try { return JSON.parse(fs.readFileSync(file, 'utf8')) } catch { return null } })()

  const writeDegraded = (code, message) => {
    const lastAttemptAt = new Date(Number(now) || Date.now()).toISOString()
    const degraded = { code: String(code || 'SQ_COLLECT_FAILED'), message: String(message || '').slice(0, 300), lastAttemptAt }
    const snapshot = {
      // schema 2：旧字段（schema/at/project/staleMs/roles）一个不删，degraded 里如实写原因。
      schema: SNAPSHOT_SCHEMA,
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
    team = readTeamOf(teamRoot)
  } catch (error) {
    return writeDegraded('SQ_TEAM_JSON_MISSING', `读不到 ${join(teamRoot, TEAM_STATE_SUBDIR, '团队.json')}：${String((error && error.message) || error).slice(0, 160)}`)
  }
  // AC4：没有 sessionId 的角色也要出行（known=false / queued=null），面板显示「—」而不是 0。
  // c9ac：live 可复用（订阅/兜底共用同一份，runningSince/lastEventAt 才有连续性）。
  const live = runtime && runtime.live instanceof Map ? runtime.live : new Map()
  await sampleInto(ctx, team, live, Number(now) || Date.now())
  return publishSnapshot({ teamRoot, resolveSource: resolved.source, team, live, now: Number(now) || Date.now(), staleMs, skipIfUnchanged: true })
}

export function apply(ctx, config) {
  const pluginConfig = config && typeof config === 'object' ? config : {}

  // R-6bc8 → R-c9ac：会话排队只读快照。采样通道升级为
  //   ① 优先 observeState 订阅（每个有 sessionId 的角色一条流；变更去抖 ≤500ms 合并写一次）；
  //   ② 每 60s 一次 state() 兜底采样（除 at 外与上一份全等 → 不写盘）；
  //   ③ observeState 不可用/抛错 → 退回 60s 兜底，并在快照 degraded 里如实记原因（不静默）。
  // 卸载时 abort 订阅 + 清定时器（ctx.effect 清理），绝不调用写侧方法。
  ctx.effect(() => {
    const controller = new AbortController()
    const signal = controller.signal
    const fallbackMs = Math.max(1000, Number(pluginConfig.fallbackIntervalMs) || 60000)
    const debounceMs = Math.min(500, Math.max(50, Number(pluginConfig.debounceMs) || 500))
    const staleMs = Number(pluginConfig.staleMs || 120000)
    const live = new Map()
    let stopped = false
    let degraded = null
    let debounceTimer = null
    const log = (code, extra) => {
      try { console.error('[sq] ' + code + ' ' + JSON.stringify(extra || {})) } catch { /* 控制台不可写时忽略 */ }
    }
    const flush = (source) => {
      if (stopped) return
      const resolved = resolveTeamRoot(pluginConfig)
      if (!resolved.teamRoot) { log('SQ_TEAMROOT_UNRESOLVED', {}); return }
      let team = null
      try { team = readTeamOf(resolved.teamRoot) } catch (error) {
        log('SQ_TEAM_JSON_MISSING', { message: String((error && error.message) || error).slice(0, 160) })
        return
      }
      const result = publishSnapshot({
        teamRoot: resolved.teamRoot, resolveSource: resolved.source, team, live,
        now: Date.now(), staleMs, degraded, skipIfUnchanged: source === 'fallback',
      })
      if (!result.ok) log('SQ_WRITE_FAILED', { file: result.file, message: result.message })
    }
    // 变更去抖：窗口内的多帧合并成一次写（≤500ms），保证落盘 ≤1s。
    const arm = () => {
      if (stopped || debounceTimer) return
      debounceTimer = setTimeout(() => { debounceTimer = null; flush('subscribe') }, debounceMs)
    }

    // ① 订阅（只读）：兼容 async iterable / 回调 / { dispose } 三种返回形态。
    const disposers = []
    const subscribeOne = async (role, sessionId) => {
      const entry = live.get(role) || { sessionId }
      entry.sessionId = sessionId
      live.set(role, entry)
      const sc = ctx.sessionController
      if (!sc || typeof sc.observeState !== 'function') throw new Error('observeState unavailable')
      const stream = await sc.observeState({ sessionId }, signal)
      const onFrame = (frame) => { applyStateFrame(entry, frame, Date.now()); arm() }
      if (stream && typeof stream[Symbol.asyncIterator] === 'function') {
        (async () => {
          try {
            for await (const frame of stream) {
              if (signal.aborted) break
              onFrame(frame)
            }
          } catch (error) {
            if (!signal.aborted) {
              degraded = { code: 'SQ_OBSERVE_STREAM_FAILED', message: String((error && error.message) || error).slice(0, 200) }
              log('SQ_OBSERVE_STREAM_FAILED', { role, message: degraded.message })
            }
          }
        })()
        return
      }
      if (typeof stream === 'function') {
        const dispose = stream(onFrame)
        if (typeof dispose === 'function') disposers.push(dispose)
        return
      }
      if (stream && typeof stream.dispose === 'function') {
        disposers.push(() => stream.dispose())
        return
      }
      throw new Error('observeState returned unsupported shape')
    }
    ;(async () => {
      const resolved = resolveTeamRoot(pluginConfig)
      let team = null
      try { if (resolved.teamRoot) team = readTeamOf(resolved.teamRoot) } catch { team = null }
      if (!team) return
      for (const member of membersOf(team)) {
        const role = String(member.role || '')
        const sessionId = String(member.sessionId || '')
        if (!sessionId) continue
        try {
          await subscribeOne(role, sessionId)
        } catch (error) {
          degraded = { code: 'SQ_OBSERVE_UNAVAILABLE', message: String((error && error.message) || error).slice(0, 200) }
          log('SQ_OBSERVE_UNAVAILABLE', { role, message: degraded.message })
        }
      }
      // 首屏落一次（不依赖第一帧到达时机）：订阅可用时走一次数据通道写；订阅不可用时先 state() 采一次，
      // 保证退回兜底后面板不是空白，且 degraded 里带着失败原因（不静默）。
      if (degraded) {
        try { await sampleInto(ctx, team, live, Date.now()) } catch (error) {
          log('SQ_FALLBACK_FAILED', { message: String((error && error.message) || error).slice(0, 200) })
        }
      }
      flush(degraded ? 'fallback' : 'subscribe')
    })().catch((error) => log('SQ_SUBSCRIBE_INIT_FAILED', { message: String((error && error.message) || error).slice(0, 200) }))

    // ② 兜底：每 60s 一次 state() 采样；除 at 外全等 → 不写盘（3 分钟静置 ≤2 次写/读）。
    const timer = setInterval(() => {
      if (stopped) return
      const resolved = resolveTeamRoot(pluginConfig)
      if (!resolved.teamRoot) return
      let team = null
      try { team = readTeamOf(resolved.teamRoot) } catch { return }
      sampleInto(ctx, team, live, Date.now())
        .then(() => flush('fallback'))
        .catch((error) => log('SQ_FALLBACK_FAILED', { message: String((error && error.message) || error).slice(0, 200) }))
    }, fallbackMs)

    return () => {
      stopped = true
      controller.abort()
      clearInterval(timer)
      if (debounceTimer) { clearTimeout(debounceTimer); debounceTimer = null }
      for (const dispose of disposers) { try { dispose() } catch { /* 清理失败不影响卸载 */ } }
    }
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
          },          skipInstall: {
            type: 'boolean',
            description:
              '可选：找不到 PM工作台本体时不自动启动安装器，只返回安装命令。默认 false（自动安装）。',
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
          // 找不到本体：自动引导官方安装器（一句话安装的第 2 步）
          if (resolved.code === 'PM_WORKBENCH_NOT_FOUND' && input.skipInstall !== true) {
            const boot = autoBootstrapInstall()
            return {
              ok: false,
              code: 'PM_WORKBENCH_INSTALLING',
              installing: boot.started || boot.reused === true,
              autoInstallStarted: boot.started,
              pid: boot.pid ?? null,
              logFile: boot.logFile || '',
              retryAfterSeconds: 180,
              installCommand: INSTALL_COMMAND,
              manualInstallCommand: MANUAL_INSTALL_COMMAND,
              message:
                '没有找到 PM工作台本体，已自动开始安装（含便携 Node / Electron / 应用本体）。约 2–5 分钟；完成后再次调用本工具即可打开。',
              hint: '安装日志见 logFile；若 5 分钟后仍失败，把日志末尾贴给 PM 排查。',
              searched: resolved.searched,
              error: resolved.error,
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
