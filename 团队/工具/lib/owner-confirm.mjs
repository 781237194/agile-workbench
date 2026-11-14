// 团队工作台 v2 · 本地 Owner 确认（一次性 nonce）
//
// 背景：Owner 是外部角色、没有 boot。旧壳只把 by='Owner' 写进状态，命令本身没有任何确认，
// 任何本机调用都能“以 Owner 名义”静默通过。这里加一道本地确认闸门：
// 1) 在真实终端运行 `team.mjs owner confirm`，为「项目 + 需求 + 决定 + 动作」签发一次性 nonce；
// 2) `team.mjs owner` 必须带 --owner-confirm <nonce>，或吃到同一组参数的待用 nonce，否则返回
//    OWNER_CONFIRM_REQUIRED，什么都不写；
// 3) nonce 一次性、10 分钟过期、绑定参数；消费后写 usedAt/usedBy，重放返回 OWNER_CONFIRM_INVALID。
//
// 这里只解决“本机确认”，不冒充平台身份：记录里仍写明 channel=tty/test/nonce。
// 工作台壳层会用 `owner confirm --test-owner`（仅 TEAM_SELFTEST=1）静默换一张绑定本次动作的确认码，
// 再把确认码传给 `owner`；生产路径仍然要求真实 TTY 才能签发。
import fs from 'node:fs';
import path from 'node:path';
import {
  PATHS, fail, nowIso, randomHex, sha256, ensureDir, readJson, writeJson, withLock,
} from './core.mjs';

export const OWNER_CONFIRM_TTL_MS = 10 * 60 * 1000;
const MIN_TTL_MS = 30 * 1000;
const MAX_TTL_MS = 60 * 60 * 1000;
const NONCE_RE = /^[a-f0-9]{8,64}$/i;

export function ownerConfirmDir() {
  return path.join(PATHS.state, 'owner-confirm');
}

function confirmationFile(nonce) {
  return path.join(ownerConfirmDir(), `${nonce}.json`);
}

function safeNonce(value) {
  return NONCE_RE.test(String(value == null ? '' : value).trim());
}

function readConfirmation(nonce) {
  if (!safeNonce(nonce)) return null;
  try {
    const data = readJson(confirmationFile(String(nonce).trim()));
    return data && typeof data === 'object' && !Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

function usable(record, ctx) {
  if (!record || record.usedAt) return false;
  const expires = Date.parse(String(record.expiresAt || ''));
  if (!Number.isFinite(expires) || expires <= Date.now()) return false;
  if (String(record.project || '') !== String(ctx.project || '')) return false;
  if (String(record.requirementId || '') !== String(ctx.requirementId || '')) return false;
  if (String(record.decision || '') !== String(ctx.decision || '')) return false;
  if (String(record.action || '') !== String(ctx.action || '')) return false;
  return true;
}

function markUsed(record, channel) {
  const at = nowIso();
  const next = {
    ...record,
    usedAt: at,
    usedBy: channel || record.channel || 'local-token',
    usedChannel: channel || record.channel || 'local-token',
  };
  writeJson(confirmationFile(record.nonce), next);
  return {
    channel: next.usedChannel,
    nonce: String(record.nonce || ''),
    nonceHash: sha256(String(record.nonce || '')).slice(0, 16),
    at,
    issuedAt: String(record.createdAt || ''),
    expiresAt: String(record.expiresAt || ''),
  };
}

function cleanupExpired() {
  const dir = ownerConfirmDir();
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return; }
  const cutoff = Date.now() - 24 * 60 * 60 * 1000;
  for (const name of names) {
    if (!name.endsWith('.json')) continue;
    const file = path.join(dir, name);
    try {
      const rec = readJson(file);
      const expires = Date.parse(String(rec && rec.expiresAt || ''));
      const used = rec && rec.usedAt ? Date.parse(String(rec.usedAt)) : NaN;
      const dead = (Number.isFinite(expires) && expires < cutoff)
        || (Number.isFinite(used) && used < cutoff);
      if (dead) fs.unlinkSync(file);
    } catch { /* 坏文件留给人工排查，不自动删 */ }
  }
}

/** 签发一次性 Owner 确认；返回 { nonce, project, requirementId, decision, action, expiresAt }。 */
export function issueOwnerConfirmation({
  project, requirementId, decision, action = '', channel = 'tty', ttlMs = OWNER_CONFIRM_TTL_MS,
}) {
  const p = String(project == null ? '' : project).trim();
  const req = String(requirementId == null ? '' : requirementId).trim();
  const dec = String(decision == null ? '' : decision).trim();
  const act = String(action == null ? '' : action).trim();
  if (!p) fail('BAD_ARGS', '签发 Owner 确认需要 project');
  if (!req) fail('BAD_ARGS', '签发 Owner 确认需要 requirementId');
  if (!dec) fail('BAD_ARGS', '签发 Owner 确认需要 decision');
  if (act && act !== 'accept') fail('BAD_ACTION', '--action 只支持 accept', { action: act, allowed: ['accept'] });
  const ttl = Math.min(MAX_TTL_MS, Math.max(MIN_TTL_MS, Number(ttlMs) || OWNER_CONFIRM_TTL_MS));
  const nonce = randomHex(16);
  const at = Date.now();
  const record = {
    nonce,
    project: p,
    requirementId: req,
    decision: dec,
    action: act,
    channel: String(channel || 'tty'),
    createdAt: new Date(at).toISOString(),
    expiresAt: new Date(at + ttl).toISOString(),
    usedAt: null,
    usedBy: '',
  };
  ensureDir(ownerConfirmDir());
  writeJson(confirmationFile(nonce), record);
  cleanupExpired();
  return record;
}

/**
 * 消费 Owner 确认。
 * - 带 nonce：校验绑定参数后一次性消费；无效/过期/已用/参数不符抛 OWNER_CONFIRM_INVALID。
 * - 不带 nonce：在同一组参数下找最新的待用 nonce；找不到返回 null，
 *   由调用方报 OWNER_CONFIRM_REQUIRED。
 */
export function consumeOwnerConfirmation({
  nonce = '', project, requirementId, decision, action = '', channel = '',
}) {
  const ctx = { project, requirementId, decision, action };
  const wanted = String(nonce == null ? '' : nonce).trim();
  if (wanted) {
    return withLock(`owner-confirm:${wanted}`, {
      role: 'owner', sessionId: channel || 'confirm', ttlMs: 15000, waitMs: 5000, reason: 'consume owner confirm',
    }, () => {
      const record = readConfirmation(wanted);
      if (!usable(record, ctx)) {
        fail('OWNER_CONFIRM_INVALID', 'Owner 确认码无效、已使用、已过期，或与本次项目/需求/决定不匹配', {
          nonceHash: sha256(wanted).slice(0, 16),
          project: String(project || ''),
          requirementId: String(requirementId || ''),
          decision: String(decision || ''),
          action: String(action || ''),
          hint: '重新运行 owner confirm 生成新的确认码',
        });
      }
      // 通道以签发时记录的为准（ui/tty/test）；调用方没有显式通道时不要覆盖成 'nonce'。
      return markUsed(record, channel);
    });
  }
  return withLock(`owner-confirm:match:${String(project || '')}`, {
    role: 'owner', sessionId: channel || 'confirm', ttlMs: 15000, waitMs: 5000, reason: 'match owner confirm',
  }, () => {
    const dir = ownerConfirmDir();
    let names = [];
    try { names = fs.readdirSync(dir); } catch { return null; }
    let best = null;
    for (const name of names) {
      if (!name.endsWith('.json')) continue;
      let record = null;
      try { record = readJson(path.join(dir, name)); } catch { continue; }
      if (!usable(record, ctx)) continue;
      if (!best || Date.parse(String(record.createdAt || '')) > Date.parse(String(best.createdAt || ''))) best = record;
    }
    if (!best) return null;
    return markUsed(best, channel || 'local-token');
  });
}

/** 给人看的下一步命令（提示用，不执行）。 */
export function ownerConfirmHint({ project, requirementId, decision, action = '' }) {
  const quote = (value) => `"${String(value == null ? '' : value)}"`;
  return [
    'node 团队\\工具\\team.mjs owner confirm',
    `--project ${quote(project)}`,
    `--requirement ${quote(requirementId)}`,
    `--decision ${quote(decision)}`,
    ...(action ? [`--action ${quote(action)}`] : []),
  ].join(' ');
}
