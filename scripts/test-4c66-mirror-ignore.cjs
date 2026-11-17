#!/usr/bin/env node
'use strict';
/**
 * B-4c66 回归：镜像任务（type=requirement / id===requirementId）不算「角色还有活」
 *
 * 现场：分析师被镜像任务误判「还有活」，路由守护每拍判一次 → 每 10 分钟唤醒一次，
 * 每次唤醒重发约 40 万 token 上下文，持续烧钱。
 *
 * 断言：
 *   ① isRequirementMirrorTask：type=requirement 为真；id===requirementId 为真；真实任务为假
 *   ② gateRoleBusy：角色名下只有镜像（open）+ 需求 ready → 不拦（可派单）
 *   ③ gateRoleBusy：镜像 + 真实 open 任务 → 仍 TASK_OPEN，且 missing 只列真实任务
 *   ④ queueStillHas：镜像不算「还有活」→ false（不唤醒）；真实 open → true；真实 done → false
 *   ⑤ 真实数据快照（只作 INFO 打印，不进断言）：各角色名下未闭环任务里镜像占比
 *
 * 跑法：node scripts/test-4c66-mirror-ignore.cjs
 */
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const STATE_DIR = path.join(ROOT, '团队', '状态', '项目', '工作台改造修复');

const results = [];
function check(name, ok, detail) {
  results.push({ name, ok: Boolean(ok), detail: ok ? '' : String(JSON.stringify(detail)).slice(0, 400) });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : '  ' + String(JSON.stringify(detail)).slice(0, 400)}`);
  if (!ok) process.exitCode = 1;
}

(async () => {
  const gates = await import('file:///' + path.join(ROOT, '团队', '工具', 'lib', 'gates.mjs').replace(/\\/g, '/'));
  const daemon = await import('file:///' + path.join(ROOT, '团队', '工具', 'lib', 'route-daemon.mjs').replace(/\\/g, '/'));

  const reqId = 'R-20991111-111111-4c66';
  const mirror = { id: reqId, type: 'requirement', requirementId: reqId, owner: 'analyst', status: 'open', title: '需求镜像' };
  const mirrorById = { id: reqId, type: 'task', requirementId: reqId, owner: 'analyst', status: 'open', title: 'id 与需求同名的镜像' };
  const realOpen = { id: 'T-20991111-111111-4c66', type: 'task', requirementId: reqId, owner: 'analyst', status: 'open', title: '真任务' };
  const realDone = { ...realOpen, id: 'T-20991111-111111-4c6d', status: 'done' };

  // ① 助手判定
  check('① type=requirement → 镜像', gates.isRequirementMirrorTask(mirror) === true, mirror);
  check('① id===requirementId → 镜像', gates.isRequirementMirrorTask(mirrorById) === true, mirrorById);
  check('① 真实任务 → 非镜像', gates.isRequirementMirrorTask(realOpen) === false && gates.isRequirementMirrorTask(realDone) === false, { realOpen, realDone });

  // ② 只有镜像 → 不忙（可派单）
  const busyMirrorOnly = gates.gateRoleBusy({ role: 'analyst', tasks: [mirror, mirrorById], locks: [] });
  check('② 角色名下只有镜像 → 判不忙（可派单）', busyMirrorOnly === null, busyMirrorOnly);

  // ③ 镜像 + 真实 open → 仍拦，且只列真实任务
  const busyWithReal = gates.gateRoleBusy({ role: 'analyst', tasks: [mirror, realOpen], locks: [] });
  check('③ 镜像 + 真实 open → 仍 TASK_OPEN 且只列真实任务',
    Boolean(busyWithReal) && busyWithReal.code === 'TASK_OPEN'
    && busyWithReal.taskIds.includes(realOpen.id) && !busyWithReal.taskIds.includes(reqId),
    busyWithReal);

  // ④ queueStillHas：镜像不算「还有活」
  const stillMirror = daemon.queueStillHas('不存在的项目-4c66', 'analyst', reqId, [mirror, mirrorById]);
  check('④ 只有镜像 → queueStillHas=false（不唤醒）', stillMirror === false, { stillMirror });
  const stillReal = daemon.queueStillHas('不存在的项目-4c66', 'analyst', reqId, [mirror, realOpen]);
  check('④ 有真实 open 任务 → queueStillHas=true（仍唤醒）', stillReal === true, { stillReal });
  const stillDone = daemon.queueStillHas('不存在的项目-4c66', 'analyst', reqId, [mirror, realDone]);
  check('④ 真实任务都 done → queueStillHas=false', stillDone === false, { stillDone });

  // ⑤ 真实数据快照（INFO）
  try {
    const tasksDir = path.join(STATE_DIR, '任务');
    const rows = fs.readdirSync(tasksDir).filter((f) => f.endsWith('.json')).map((f) => {
      try { return JSON.parse(fs.readFileSync(path.join(tasksDir, f), 'utf8')); } catch { return null; }
    }).filter(Boolean);
    const byRole = {};
    for (const t of rows) {
      const owner = String(t.owner || '');
      if (!owner) continue;
      byRole[owner] = byRole[owner] || { total: 0, mirror: 0, open: 0, openNonMirror: 0 };
      byRole[owner].total += 1;
      const isMirror = gates.isRequirementMirrorTask(t);
      if (isMirror) byRole[owner].mirror += 1;
      if (!gates.taskIsClosed(t)) {
        byRole[owner].open += 1;
        if (!isMirror) byRole[owner].openNonMirror += 1;
      }
    }
    console.log('INFO  真实数据（各角色）：' + JSON.stringify(byRole));
    for (const role of ['analyst', 'pm', 'product', 'programmer1', 'programmer2', 'tester']) {
      const row = byRole[role] || { open: 0, openNonMirror: 0 };
      console.log(`INFO  ${role}: 未闭环 ${row.open} 条，其中非镜像 ${row.openNonMirror} 条 → G5 ${row.openNonMirror ? '会拦' : '放行'}`);
    }
  } catch (error) {
    console.log('INFO  真实数据快照跳过：' + String((error && error.message) || error));
  }

  const passed = results.filter((r) => r.ok).length;
  console.log(`\nB-4c66 镜像忽略断言：${passed}/${results.length} PASS`);
  const evDir = path.join(ROOT, '项目', '工作台改造修复', '程序员B', '产出', '证据-4c66');
  fs.mkdirSync(evDir, { recursive: true });
  fs.writeFileSync(path.join(evDir, 'run-4c66.json'), JSON.stringify({ at: new Date().toISOString(), total: results.length, passed, results }, null, 2) + '\n', 'utf8');
})();
