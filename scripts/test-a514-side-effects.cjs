#!/usr/bin/env node
'use strict';
/**
 * test-a514-side-effects.cjs —— B-20261121-034617-a514（P1）后台副作用队列 + 接线
 *
 * A. 队列语义（纯模块，src/workflow-side-effects.js）
 *   A1 debounce 合并：250ms 内三次 schedule 只跑一次
 *   A2 运行中再来的请求 → 本轮跑完补跑一次（合并、不丢）
 *   A3 失败重试：run 抛错时按 retries=2 共尝试 3 次，用尽后 emit({ok:false})
 *   A4 成功 emit({ok:true}) + audit 记录
 *   A5 status() 暴露队列快照
 * B. 接线静态断言
 *   B1 main.js：workflowResponse 不再同步调用 mirrorWorkflowToStore（改为 scheduleWorkflowMirror）
 *   B2 main.js：存在 workflow:side-effects-status / -retry IPC
 *   B3 preload 暴露 onWorkflowSideEffects / workflowSideEffectsRetry
 *   B4 app.js 有失败提示条（#awb-side-effect-banner）+ 重试按钮 + 启动接线
 *   B5 任务扫描缓存 TTL=5000、首屏后预热 [workflow-prewarm]
 *
 * 用法：node scripts/test-a514-side-effects.cjs [--json]
 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');
const { createWorkflowSideEffects } = require(path.join(ROOT, 'src', 'workflow-side-effects.js'));
const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 600)}`);
}
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

(async () => {
  // A1 debounce 合并
  {
    let runs = 0;
    const q = createWorkflowSideEffects({ run: async () => { runs += 1; return 'ok'; }, debounceMs: 60, retries: 0 });
    q.schedule({ projectId: 'P1', reason: 'a' });
    q.schedule({ projectId: 'P1', reason: 'b' });
    q.schedule({ projectId: 'P1', reason: 'c' });
    await sleep(220);
    check('A1 debounce 内三次 schedule 只跑一次', runs === 1, { runs });
    q.dispose();
  }

  // A2 运行中调度 → 补跑一次
  {
    let runs = 0;
    const q = createWorkflowSideEffects({ run: async () => { runs += 1; await sleep(80); return 'ok'; }, debounceMs: 40, retries: 0 });
    q.schedule({ projectId: 'P2', reason: 'first' });
    await sleep(70); // 已进入运行
    q.schedule({ projectId: 'P2', reason: 'during-run' });
    await sleep(240);
    check('A2 运行中再调度 → 合并补跑一次（共 2 次）', runs === 2, { runs });
    q.dispose();
  }

  // A3 失败重试 + 最终 emit
  {
    let attempts = 0;
    const events = [];
    const audits = [];
    const q = createWorkflowSideEffects({
      run: async () => { attempts += 1; throw new Error('boom'); },
      audit: (row) => audits.push(row),
      emit: (payload) => events.push(payload),
      debounceMs: 30,
      retries: 2,
      retryDelayMs: 20,
    });
    q.schedule({ projectId: 'P3', reason: 'retry' });
    await sleep(300);
    const failedEvent = events.find((e) => e && e.ok === false);
    check('A3 失败重试 2 次（共 3 次尝试）后 emit 失败事件', attempts === 3 && Boolean(failedEvent), { attempts, events: events.length });
    check('A3b 每次失败都写审计（3 行）', audits.filter((r) => r.kind === 'side_effect_failed').length === 3, { audits: audits.length });
    q.dispose();
  }

  // A4 成功 emit + audit + A5 status
  {
    const events = [];
    const audits = [];
    const q = createWorkflowSideEffects({ run: async () => ({ mirrored: true }), audit: (r) => audits.push(r), emit: (e) => events.push(e), debounceMs: 30, retries: 0 });
    q.schedule({ projectId: 'P4', reason: 'ok' });
    await sleep(200);
    check('A4 成功 emit({ok:true}) 且审计 kind=side_effect', events.some((e) => e.ok === true) && audits.some((r) => r.kind === 'side_effect'), { events, audits });
    const st = q.status();
    check('A5 status() 返回队列快照', st.ok === true && Array.isArray(st.queue) && st.queue.length === 1 && st.queue[0].projectId === 'P4', { st });
    q.dispose();
  }

  // B. 静态接线
  const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
  const preloadSrc = fs.readFileSync(path.join(ROOT, 'src', 'preload.js'), 'utf8');
  const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
  const teamSrc = fs.readFileSync(path.join(ROOT, 'src', 'team-tools.js'), 'utf8');
  const wfResponse = (() => {
    const i = mainSrc.indexOf('function workflowResponse(');
    if (i < 0) return '';
    const j = mainSrc.indexOf('\nfunction ', i + 10);
    return mainSrc.slice(i, j > 0 ? j : i + 4000);
  })();
  check('B1 workflowResponse 不再同步 mirrorWorkflowToStore（已排队后台）',
    !wfResponse.includes('const mirrored = mirrorWorkflowToStore(') && wfResponse.includes('scheduleWorkflowMirror('), { snippet: wfResponse.slice(0, 300) });
  check('B2 存在 side-effects status/retry IPC',
    mainSrc.includes("'workflow:side-effects-status'") && mainSrc.includes("'workflow:side-effects-retry'"), {});
  check('B3 preload 暴露 onWorkflowSideEffects / workflowSideEffectsRetry',
    preloadSrc.includes('onWorkflowSideEffects') && preloadSrc.includes('workflowSideEffectsRetry'), {});
  check('B4 app.js 失败条 #awb-side-effect-banner + 重试 + 启动接线',
    appSrc.includes("awb-side-effect-banner") && appSrc.includes('workflowSideEffectsRetry') && appSrc.includes('bindWorkflowSideEffects();'), {});
  check('B5 任务扫描缓存 TTL=5000 且首屏后预热 [workflow-prewarm]',
    teamSrc.includes('raw : 5000') && mainSrc.includes('[workflow-prewarm]'), {});

  const failed = ROWS.filter((r) => !r.ok).length;
  if (JSON_OUT) console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed, failed: ROWS.filter((r) => !r.ok).map((r) => r.name), rows: ROWS }, null, 2));
  else console.log(`\n${ROWS.length - failed}/${ROWS.length} PASS${failed ? ' · ' + failed + ' FAIL' : ''}`);
  process.exit(failed ? 1 : 0);
})().catch((e) => { console.error('FIXTURE_FAILED', String((e && e.stack) || e)); process.exit(2); });
