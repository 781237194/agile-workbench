'use strict';
/**
 * 路由守护宿主（壳层拉起用）：以子进程方式跑团队工具里的**官方**守护实现，不改守护代码。
 *
 * 为什么不用 `team.mjs route daemon --boot`：CLI 的 daemon/once 要角色启动令牌，而工作台壳本身
 * 不是角色会话（拿不到、也不该冒用某个角色的令牌）。这里只调用守护模块自己导出的 runDaemon：
 * 单实例锁（TTL 30 秒续期）、心跳、日志全部走官方代码，后启动者仍进不去。
 *
 * 用法（由 src/main.js 以 Electron-as-node 拉起）：
 *   AWB_ROUTE_HOST_TEAM_ROOT=<团队目录> node route-daemon-host.cjs <项目名>
 *
 * 退出协议：父进程发 `stop` → 立刻退出；父进程随后按 pid 存活 + 心跳判定「已停止」。
 * Windows 没有真正的 SIGTERM 投递，守护的 finally 收尾不保证执行；单实例锁 30 秒 TTL 会自动过期。
 */
const path = require('node:path');
const { pathToFileURL } = require('node:url');

const project = String(process.argv[2] || '').trim();
const teamRoot = String(process.env.AWB_ROUTE_HOST_TEAM_ROOT || '').trim();

function failText(code, message) {
  console.error('ROUTE_DAEMON_HOST_FAILED ' + JSON.stringify({ code, message: String(message || '').slice(0, 600), project, teamRoot }));
  process.exit(1);
}

if (!project) failText('BAD_PROJECT', '缺少项目名');
if (!teamRoot) failText('BAD_TEAM_ROOT', '缺少团队根目录（AWB_ROUTE_HOST_TEAM_ROOT）');

const daemonFile = path.join(teamRoot, '工具', 'lib', 'route-daemon.mjs');

(async () => {
  // 父进程要求停止：立刻退出（守护循环没有外部停止钩子，硬退是当前唯一不改进守护代码的做法）。
  process.on('message', (msg) => { if (msg === 'stop') process.exit(0); });
  let mod = null;
  try {
    mod = await import(pathToFileURL(daemonFile).href);
  } catch (error) {
    failText('DAEMON_MODULE_MISSING', `守护模块加载失败：${daemonFile}（${String((error && error.message) || error)}）`);
  }
  if (!mod || typeof mod.runDaemon !== 'function') failText('DAEMON_ENTRY_MISSING', `守护模块没有 runDaemon：${daemonFile}`);
  const result = await mod.runDaemon(project, {});
  console.log('ROUTE_DAEMON_EXIT ' + JSON.stringify({ project, ok: Boolean(result && result.ok), code: String((result && result.code) || ''), ticks: Number((result && result.ticks) || 0) }));
  process.exit(result && result.ok ? 0 : 1);
})().catch((error) => {
  failText('DAEMON_CRASH', String((error && error.stack) || error).slice(0, 1200));
});
