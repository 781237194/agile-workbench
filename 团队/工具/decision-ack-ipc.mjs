#!/usr/bin/env node
/**
 * R-9db6 AC4（T-20261114-130838-5dfc）：决策箱「回执 PM」——壳层 IPC 后端入口。
 *
 * 只给工作台壳层调用（Owner 在界面点【回执 PM】；与 owner-note.mjs 同级定位）。
 * CLI 单条回执仍走 `team.mjs decision ack --owner-confirm <码>`（要终端 nonce）；这里是界面通道，
 * 审计里固定 channel=ui、decidedBy=owner、source=decision_box_ack。
 *
 * 用法：node decision-ack-ipc.mjs <项目名> '<payload-json>'
 *   payload: {items:[{id,choice,opinion}]} 或 {id,choice,opinion}
 * 输出：单个 JSON（成功见 决策箱-回执-PM-接口契约-v2.md；失败 {ok:false,code,message}，零副作用）
 */
import { acknowledgeDecisions } from './lib/decision-box.mjs';
import { loadProject } from './lib/store.mjs';

function emit(value) {
  process.stdout.write(JSON.stringify(value) + '\n');
}

async function main() {
  const projectName = String(process.argv[2] || '').trim();
  if (!projectName) return { ok: false, code: 'PROJECT_REQUIRED', message: '缺少项目名' };
  let payload = {};
  try {
    payload = JSON.parse(String(process.argv[3] || '{}'));
  } catch {
    return { ok: false, code: 'BAD_PAYLOAD', message: 'payload 不是合法 JSON' };
  }
  try {
    loadProject(projectName);
  } catch (e) {
    return { ok: false, code: 'NO_PROJECT', message: String((e && e.message) || e).slice(0, 200) };
  }
  const r = await acknowledgeDecisions(projectName, {
    items: payload.items,
    id: payload.id,
    choice: payload.choice,
    opinion: payload.opinion,
    channel: 'ui',
    source: 'decision_box_ack',
  });
  return { ...r, code: 'OK' };
}

main()
  .then((value) => { emit({ ok: value.ok !== false, ...value }); process.exit(value.ok === false ? 1 : 0); })
  .catch((error) => {
    const code = String((error && error.code) || 'DECISION_ACK_FAILED');
    const message = String((error && (error.message || error.why)) || error).slice(0, 300);
    emit({ ok: false, code, message, details: error && error.details || null });
    process.exit(1);
  });
