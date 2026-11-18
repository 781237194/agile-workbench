'use strict';
/**
 * e379：DSH 互通能力探针（只读）
 *
 * 目的：安装/首启后确认「本机 DSH 是否支持只读 session/list」——这是团队角色会话可被
 * 工作台驱动的前提。探测结果落 `data/dsh-capability.json`，并在主进程日志打印一句
 * 「DSH 互通能力：有/无」，缺能力时提示升级 DSH，而不是静默失败。
 *
 * 字段（与需求 ③ 对齐）：{ok, method, httpStatus, sessionsCount, dshVersion, at, error?}
 */
const fs = require('node:fs');
const path = require('node:path');

const CAPABILITY_FILE = 'dsh-capability.json';
const METHOD = 'session/list';

function capabilityPath(dataDir) {
  return path.join(String(dataDir || ''), CAPABILITY_FILE);
}

function writeCapability(dataDir, record) {
  const target = capabilityPath(dataDir);
  try {
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = target + '.' + process.pid + '.tmp';
    fs.writeFileSync(tmp, JSON.stringify(record, null, 2) + '\n', 'utf8');
    fs.renameSync(tmp, target);
    return true;
  } catch {
    return false;
  }
}

function readCapability(dataDir) {
  try {
    const raw = fs.readFileSync(capabilityPath(dataDir), 'utf8');
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

/**
 * 探测一次并落盘。永不抛错：失败也写 {ok:false,error}，供面板/诊断读取。
 * @param {{adapter:{listSessions:Function}, dataDir:string, timeoutMs?:number, dshVersion?:string}} opts
 */
async function probeDshCapability(opts = {}) {
  const adapter = opts.adapter;
  const dataDir = String(opts.dataDir || '');
  const timeoutMs = Number(opts.timeoutMs) > 0 ? Number(opts.timeoutMs) : 8000;
  const at = new Date().toISOString();
  const base = {
    ok: false,
    method: METHOD,
    httpStatus: null,
    sessionsCount: 0,
    dshVersion: String(opts.dshVersion || ''),
    at,
    error: null,
  };
  let record;
  try {
    if (!adapter || typeof adapter.listSessions !== 'function') {
      record = { ...base, error: 'DSH 适配器未就绪（无法调用 session/list）' };
    } else {
      const items = await adapter.listSessions({ timeoutMs });
      record = { ...base, ok: true, httpStatus: 200, sessionsCount: Array.isArray(items) ? items.length : 0 };
    }
  } catch (e) {
    record = {
      ...base,
      httpStatus: Number(e && e.httpStatus) > 0 ? Number(e.httpStatus) : null,
      error: String((e && e.message) || e || 'DSH_NOT_AVAILABLE').slice(0, 300),
    };
  }
  if (dataDir) writeCapability(dataDir, record);
  return record;
}

/** 供日志/简报使用的一句话摘要。 */
function capabilityLine(record) {
  if (!record) return 'DSH 互通能力：未知（尚未探测）';
  if (record.ok) {
    return `DSH 互通能力：有（${METHOD} 返回 ${record.sessionsCount} 个会话）`;
  }
  const why = String(record.error || '未知原因').slice(0, 120);
  return `DSH 互通能力：无（${why}）；请升级 DSH 到支持只读 ${METHOD} 的版本`;
}

module.exports = {
  CAPABILITY_FILE,
  METHOD,
  capabilityPath,
  writeCapability,
  readCapability,
  probeDshCapability,
  capabilityLine,
};
