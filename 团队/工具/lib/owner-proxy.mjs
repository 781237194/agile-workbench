import fs from 'node:fs';
import path from 'node:path';
import { projectStatePaths } from './store.mjs';
import { nowIso, ensureDir, jsonOut, textOut } from './core.mjs';

const FILE = '评审代管.json';

function proxyFile(projectName) {
  return path.join(projectStatePaths(projectName).dir, FILE);
}

function readState(projectName) {
  const file = proxyFile(projectName);
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8').replace(/^\uFEFF/, ''));
    return { file, records: Array.isArray(raw.records) ? raw.records : [] };
  } catch {
    return { file, records: [] };
  }
}

function writeState(projectName, records) {
  const file = proxyFile(projectName);
  ensureDir(path.dirname(file));
  fs.writeFileSync(file, JSON.stringify({ records, updatedAt: nowIso() }, null, 2) + '\n', 'utf8');
  return file;
}

export function proxyStatus(projectName) {
  const state = readState(projectName);
  const active = state.records.filter((row) => !row.endedAt).slice(-1)[0] || null;
  return {
    project: projectName,
    file: state.file,
    scope: active ? active.scope : null,
    requirementId: active ? active.requirementId : '',
    startedAt: active ? active.startedAt : '',
    endedAt: active ? active.endedAt : '',
    active,
    history: state.records,
  };
}

export function startProxy({ projectName, requirementId, scope = 'once', authorization = '', by = 'owner', recordedBy = 'pm' }) {
  if (!requirementId) throw new Error('需要需求 id');
  if (!['once', 'always'].includes(scope)) throw new Error('scope 只能是 once 或 always');
  const state = readState(projectName);
  const active = state.records.find((row) => row.requirementId === requirementId && !row.endedAt);
  if (active) {
    active.scope = scope;
    active.authorization = authorization || active.authorization || '';
    active.updatedAt = nowIso();
    writeState(projectName, state.records);
    return { ok: true, idempotent: true, record: active };
  }
  const record = {
    scope,
    requirementId,
    startedAt: nowIso(),
    startedBy: by,
    authorization: authorization || 'Owner 在评审弹窗点击代管',
    recordedBy,
    endedAt: null,
    endedBy: null,
  };
  state.records.push(record);
  writeState(projectName, state.records);
  return { ok: true, idempotent: false, record };
}

export function endProxy({ projectName, requirementId = '', by = 'owner' }) {
  const state = readState(projectName);
  let changed = 0;
  for (const row of state.records) {
    if (row.endedAt) continue;
    if (requirementId && row.requirementId !== requirementId) continue;
    row.endedAt = nowIso();
    row.endedBy = by;
    changed += 1;
  }
  writeState(projectName, state.records);
  return { ok: true, ended: changed, status: proxyStatus(projectName) };
}

export function activeProxyFor(projectName, requirementId) {
  const state = readState(projectName);
  return state.records.find((row) => row.requirementId === requirementId && !row.endedAt) || null;
}

export function cmdOwnerProxy(args) {
  const action = String((args._ && args._[2]) || 'status').toLowerCase();
  const projectName = String(args.project || '');
  if (!projectName) throw new Error('需要 --project');
  if (action === 'status') {
    const r = proxyStatus(projectName);
    const human = [
      `评审代管 · ${projectName}`,
      `当前：${r.scope ? `${r.scope} · ${r.requirementId}` : '未开启'}`,
      `记录：${r.history.length} 条`,
    ].join('\n');
    if (args.json) jsonOut(r);
    else textOut(human);
    return;
  }
  if (action === 'start') {
    const r = startProxy({
      projectName,
      requirementId: String(args.requirement || ''),
      scope: String(args.scope || 'once'),
      authorization: String(args.authorization || ''),
      by: String(args.by || 'owner'),
    });
    if (args.json) jsonOut(r);
    else textOut(`已开启代管：${r.record.requirementId}（${r.record.scope}）`);
    return;
  }
  if (action === 'end') {
    const r = endProxy({ projectName, requirementId: String(args.requirement || ''), by: String(args.by || 'owner') });
    if (args.json) jsonOut(r);
    else textOut(`已结束代管：${r.ended} 条`);
    return;
  }
  throw new Error('owner proxy 只支持 status | start | end');
}
