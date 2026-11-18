// 团队工作台 · c65a 原子派单（R-20261119-011310 / T-20261119-021319-59e0）
//
// 目的：把 PM 派单的「补 lessons → boot 自己 → boot 目标 → dispatch-check → send」五步
// 收敛成一次调用；**失败一次列全 missing[]，且不产生任何派单消息写入**。
//
// 设计：本模块不依赖 ops.mjs（A 正在改），只通过子进程调用 team.mjs 公开 CLI；
// 调用与判定都可通过 deps 注入替身，便于沙盘夹具与纯逻辑单测。
// 二期由 ops.mjs 的 `pm dispatch` 子命令接线调用。
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const TEAM_MJS = path.resolve(__dirname, '..', 'team.mjs');
export const PM_DISPATCH_STEPS = ['bootSelf', 'lessons', 'bootTarget', 'dispatchCheck', 'send'];
export const DISPATCH_OK_VERDICTS = ['go', 'go_degraded'];

/** team.mjs --json 的 stdout 里可能夹日志行：只取第一个 JSON 对象。 */
export function parseJsonOut(text) {
  const raw = String(text || '');
  const start = raw.indexOf('{');
  if (start < 0) return null;
  let depth = 0;
  let inStr = false;
  let esc = false;
  for (let i = start; i < raw.length; i += 1) {
    const ch = raw[i];
    if (inStr) {
      if (esc) esc = false;
      else if (ch === '\\') esc = true;
      else if (ch === '"') inStr = false;
      continue;
    }
    if (ch === '"') { inStr = true; continue; }
    if (ch === '{') depth += 1;
    else if (ch === '}') {
      depth -= 1;
      if (depth === 0) {
        try { return JSON.parse(raw.slice(start, i + 1)); } catch { return null; }
      }
    }
  }
  return null;
}

export function runTeam(args, { cwd = process.cwd(), env = process.env, timeoutMs = 120000 } = {}) {
  try {
    const out = execFileSync(process.execPath, [TEAM_MJS, ...args], {
      cwd,
      env: { ...env, ELECTRON_RUN_AS_NODE: '1' },
      encoding: 'utf8',
      windowsHide: true,
      timeout: timeoutMs,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    return { ok: true, code: 0, out: String(out || ''), stderr: '', json: parseJsonOut(out) };
  } catch (error) {
    const out = String((error && error.stdout) || '');
    const stderr = String((error && error.stderr) || '');
    return { ok: false, code: Number(error && error.status) || 1, out, stderr, json: parseJsonOut(out) };
  }
}

/**
 * 纯判定：把各步骤结果聚合成 missing[]（不写盘、不调用 CLI）。
 * checks = { bootSelf, lessons, bootTarget, dispatchCheck }，每项可为 {ok, code, json} 或 null。
 */
export function aggregateMissing(checks = {}) {
  const missing = [];
  const bootSelf = checks.bootSelf;
  if (!bootSelf || !bootSelf.ok) {
    missing.push('自 boot 失败：' + ((bootSelf && bootSelf.json && bootSelf.json.code) || (bootSelf && bootSelf.code) || 'BOOT_FAILED'));
  }
  const lessons = checks.lessons;
  if (lessons && !lessons.ok) {
    missing.push('经验教训未读/记录失败：' + ((lessons.json && lessons.json.code) || 'LESSONS_NOT_READ'));
  }
  const bootTarget = checks.bootTarget;
  if (bootTarget && !bootTarget.ok) {
    missing.push('目标 boot 失败：' + ((bootTarget.json && bootTarget.json.code) || 'TARGET_BOOT_FAILED'));
  }
  const dc = checks.dispatchCheck;
  if (dc) {
    if (!dc.ok) {
      missing.push('dispatch-check 调用失败：' + ((dc.json && dc.json.code) || 'DISPATCH_CHECK_FAILED'));
    } else {
      const verdict = String((dc.json && dc.json.verdict) || '');
      const numbers = (dc.json && dc.json.numbers) || {};
      // 只有 verdict 未放行时，reasons 才算缺项（go_degraded 的 reasons 是降级说明，不是缺项）。
      if (!DISPATCH_OK_VERDICTS.includes(verdict)) {
        missing.push('dispatch-check 未放行：' + (verdict || 'unknown'));
        const reasons = dc.json && Array.isArray(dc.json.reasons) ? dc.json.reasons : [];
        for (const reason of reasons) missing.push('派单前置未满足：' + String(reason));
        if (numbers.booted === false && !(bootTarget && !bootTarget.ok)) missing.push('目标角色未 boot（没有有效启动令牌）');
      }
      if (numbers.lockBy) missing.push('派单锁被占用：' + String(numbers.lockBy));
      if (Array.isArray(dc.json.locks) && dc.json.locks.length) {
        for (const lock of dc.json.locks) missing.push('派单锁被占用：' + String(lock && (lock.messageId || lock.by || lock)));
      }
    }
  }
  return [...new Set(missing)];
}

/**
 * 原子派单：按序执行五步；失败一次列全 missing[]，不发送消息（零派单写入）。
 * 选项：
 *  - project/to/taskId/subject/body/type：send 参数
 *  - autoBootTarget：默认 true；指定目标 session 可传 targetSession
 *  - autoLessons：默认 true（读经验教训登记册，满足 LESSONS 门）
 *  - deps：{ run: 替身 }，夹具可注入
 */
export function runPmDispatchAtomic({
  project,
  to,
  taskId = '',
  subject = '',
  body = '',
  type = 'dispatch',
  autoBootTarget = true,
  targetSession = '',
  autoLessons = true,
  cwd = process.cwd(),
  env = process.env,
  deps = {},
} = {}) {
  if (!project) return { ok: false, missing: ['缺少项目名'], locks: [], checks: {}, wrote: false };
  if (!to) return { ok: false, missing: ['缺少目标角色'], locks: [], checks: {}, wrote: false };
  const run = typeof deps.run === 'function' ? deps.run : (args) => runTeam(args, { cwd, env });
  const checks = {};

  // ① boot 自己（PM）
  checks.bootSelf = run(['boot', '--role', 'pm', '--project', project, '--json']);
  const token = (checks.bootSelf.json && checks.bootSelf.json.token) || '';

  // ② 补 lessons（需用自己令牌；失败只记缺项，不中止后续独立检查）
  if (token && autoLessons) {
    checks.lessons = run(['lessons', 'read', '--boot', token, '--project', project]);
  }

  // ③ boot 目标（缺令牌时也先试一次；失败不中止，交给 dispatch-check 复核）
  if (autoBootTarget) {
    const bootArgs = ['boot', '--role', to, '--project', project, '--json'];
    if (targetSession) bootArgs.push('--session', targetSession);
    checks.bootTarget = run(bootArgs);
  }

  // ④ dispatch-check（一次给出 verdict/reasons/锁/数字）
  if (token) {
    checks.dispatchCheck = run(['dispatch-check', '--boot', token, '--project', project, '--to', to, '--json']);
  }

  const missing = aggregateMissing(checks);
  const locks = [];
  const numbers = (checks.dispatchCheck && checks.dispatchCheck.json && checks.dispatchCheck.json.numbers) || {};
  if (numbers.lockBy) locks.push({ by: String(numbers.lockBy), source: 'dispatch-check' });

  if (missing.length) {
    return { ok: false, missing, locks, checks, wrote: false, token: '' };
  }

  // ⑤ send --ack --task（唯一写入点；失败也算 missing）
  const sendArgs = ['send', '--boot', token, '--project', project, '--to', to, '--type', type, '--ack', '--json'];
  if (taskId) sendArgs.push('--task', String(taskId));
  if (subject) sendArgs.push('--subject', String(subject));
  if (body) sendArgs.push('--body', String(body));
  checks.send = run(sendArgs);
  const sendJson = checks.send.json || {};
  const messageId = String((sendJson.message && sendJson.message.id) || sendJson.messageId || sendJson.id || '');
  if (!checks.send.ok || !messageId || !/^M-/.test(messageId)) {
    if (!missing.length) missing.push('send 失败：' + ((sendJson && sendJson.code) || 'SEND_FAILED'));
    return { ok: false, missing, locks, checks, wrote: false, token: '' };
  }
  return { ok: true, missing: [], locks, checks, messageId, wrote: true, token: '' };
}
