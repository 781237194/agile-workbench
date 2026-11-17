// dsh-url.mjs —— DSH 地址统一解析（B-20261117-212500-a837 集成点）
// 背景：自动换人跑在 route-daemon 子进程里，DSH_WEB_URL 往往只在壳（Electron 主进程）里有；
// 若建会话只读 env，生产会落到 ROTATE_MANUAL_REQUIRED。此模块与壳 src/main.js:203-214 的解析链同序：
//   ① override（调用方已解析好的地址，最高优先）
//   ② 环境变量 DSH_WEB_URL
//   ③ 环境变量 DSH_WEB_PORT / DSH_PORT
//   ④ dsh.json（<data 根>/dsh.json；显式 pinned/user 优先，auto 发现值也接受）
//   ⑤ 团队状态 当前工作区.json 的 engineUrl（route-daemon 既有回退口径）
// 返回 { baseUrl, source }；解析不到返回 { baseUrl:'', source:'none' }。
// 本模块只读文件，不发请求；沙盘（TEAM_ROOT 等）天然隔离，因为路径都经 core PATHS / AWB_DATA_DIR。
import fs from 'node:fs';
import path from 'node:path';
import { PATHS } from './core.mjs';

const ENV_URL = () => String(process.env.DSH_WEB_URL || '').trim();
const ENV_PORT = () => String(process.env.DSH_WEB_PORT || process.env.DSH_PORT || '').trim();

/** data 根：AWB_DATA_DIR（壳/自检隔离）> <workspace>/data（与 src/main.js 的 LOCAL_DATA 同口径）。 */
export function dshDataRoot() {
  return process.env.AWB_DATA_DIR ? path.resolve(process.env.AWB_DATA_DIR) : path.join(PATHS.workspace, 'data');
}

/** 归一化成 origin；空/非法返回 ''（不抛，交给调用方给可操作错误）。 */
export function normalizeDshBaseUrl(raw) {
  let text = String(raw == null ? '' : raw).trim();
  if (!text) return '';
  if (!/^https?:\/\//i.test(text)) text = 'http://' + text;
  try {
    const u = new URL(text);
    if (!['http:', 'https:'].includes(u.protocol) || !u.hostname) return '';
    return u.origin;
  } catch {
    return '';
  }
}

function readJsonSafe(file) {
  try { return JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

/**
 * 解析 DSH baseUrl。
 * @param {{ override?: string, includeWorkspaceFile?: boolean }} [opts]
 *   override：调用方已解析好的地址（如 route-daemon 的 engineUrl），非空即返回；
 *   includeWorkspaceFile：是否允许回退到 团队/状态/当前工作区.json（默认 true）。
 */
export function resolveDshBaseUrl({ override = '', includeWorkspaceFile = true } = {}) {
  const o = normalizeDshBaseUrl(override);
  if (o) return { baseUrl: o, source: 'override' };

  const env = normalizeDshBaseUrl(ENV_URL());
  if (env) return { baseUrl: env, source: 'env:DSH_WEB_URL' };

  const port = ENV_PORT();
  if (/^\d{2,5}$/.test(port)) return { baseUrl: `http://127.0.0.1:${port}`, source: 'env:DSH_WEB_PORT' };

  const cfg = readJsonSafe(path.join(dshDataRoot(), 'dsh.json'));
  const cfgUrl = normalizeDshBaseUrl(cfg && cfg.baseUrl);
  if (cfgUrl) {
    const explicit = cfg && (cfg.pinned === true || String(cfg.source || '') === 'user');
    return { baseUrl: cfgUrl, source: explicit ? 'dsh.json(显式)' : 'dsh.json(auto)' };
  }

  if (includeWorkspaceFile) {
    const ws = readJsonSafe(path.join(PATHS.state, '当前工作区.json'));
    const wsUrl = normalizeDshBaseUrl(ws && (ws.engineUrl || ws.baseUrl));
    if (wsUrl) return { baseUrl: wsUrl, source: '当前工作区.json' };
  }
  return { baseUrl: '', source: 'none' };
}

/** 解析不到时给一句可操作的人话（用于 ROTATE_MANUAL_REQUIRED 等错误）。 */
export function dshUrlMissingHint() {
  return '没有可用的 DSH 地址（环境变量 DSH_WEB_URL / DSH_WEB_PORT、data/dsh.json、团队/状态/当前工作区.json 均无）';
}
