#!/usr/bin/env node
'use strict';
/**
 * test-190a-sidebar-roster.cjs —— P0 R-97db（B-20261120-020530-190a）夹具（名册口径的侧栏就绪数）
 *
 * 回归：删工作区 + 归档成员后，侧栏仍「6 人已就绪 · 6/6 已核验」（Owner 2026-11-20 实测）。
 * 根因（本单定位）：`app.js:1533 sessionEntries` 只读 `project.sessions`（store 残留），
 * 归档只清名册/团队会话.json/已归档角色的 workbench.sessions[role]（且仅 archivedIsCurrent 时），
 * **删项目路径 clearRosterSessionsOf 只改名册** → project.sessions 残留 → 侧栏仍数到 6。
 *
 * 本夹具覆盖「单测层」能确定的部分（A 组 + B 组的纯逻辑复算）；
 * **真窗口**（AC1 的「0 个就绪行 / 计数 0」）需 tester 用隔离 Electron 复验，见实现说明「未覆盖」。
 *
 * 断言：
 *  A1 main.js 的 publicMapping 定义并 return `rosterSessionIds`
 *  A2 rosterSessionIds 口径 = 「sessionId 非空 且 未 archived」
 *  A3 app.js 的 sessionEntries 优先用 rosterSessionIds 过滤，且**保留旧行为回落**（无该字段时不炸）
 *  B1 逻辑复算：给「store 有 6 条残留 + 名册只 2 人」时，sessionEntries 口径应只算 2（用等价实现复算）
 *  B2 逻辑复算：名册全空 + store 残留 6 → 0
 *  C 真实状态隔离：本夹具全程只读 src/**，不改真实 团队/ 与 workbench.json
 */
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.resolve(__dirname, '..');
const MAIN = path.join(ROOT, 'src', 'main.js');
const APP = path.join(ROOT, 'src', 'renderer', 'app.js');
const JSON_OUT = process.argv.includes('--json');

const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 600)}`);
  return Boolean(ok);
}
const sha = (f) => { try { return crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex'); } catch { return '-'; } };

/** 与 app.js → sessionEntries 等价的纯函数（用于 B 组逻辑复算；不复用源码，避免自证）。 */
function expectedReadyCount({ sessions, rosterIds, roleIds }) {
  const s = sessions || {};
  const set = Array.isArray(rosterIds) ? new Set(rosterIds) : null;
  return roleIds.filter((id) => {
    if (!s[id]) return false;
    if (set) return set.has(id);
    return true;
  }).length;
}

function main() {
  let exitCode = 0;
  const mainBefore = sha(MAIN);
  const appBefore = sha(APP);
  try {
    const m = fs.readFileSync(MAIN, 'utf8');
    const a = fs.readFileSync(APP, 'utf8');

    /* ── A 静态接线 ─────────────────────────────────────── */
    const pmStart = m.indexOf('function publicMapping');
    const pmSeg = pmStart >= 0 ? m.slice(pmStart, pmStart + 4000) : '';
    check('A1 main.js publicMapping 定义 rosterSessionIds 且进 return',
      pmSeg.includes('const rosterSessionIds') && /\n\s*rosterSessionIds,/.test(pmSeg),
      { hasDef: pmSeg.includes('const rosterSessionIds'), hasReturn: /\n\s*rosterSessionIds,/.test(pmSeg) });
    check('A2 口径 = sessionId 非空 且 未 archived（归档成员不计入就绪）',
      /const sid = String\(\(m && m\.sessionId\) \|\| ''\)\.trim\(\);/.test(pmSeg)
      && /if \(role && sid && !\(m && m\.archived\)\) ids\.push\(role\);/.test(pmSeg),
      {});

    const seStart = a.indexOf('function sessionEntries');
    const seSeg = seStart >= 0 ? a.slice(seStart, seStart + 1200) : '';
    check('A3 app.js sessionEntries 优先用 rosterSessionIds 过滤（且无该字段时回落旧行为）',
      seSeg.includes('Array.isArray(project && project.rosterSessionIds)')
      && /rosterIds \? \(rosterIds\.has\(role\.id\) \? \(sessions\[role\.id\] \|\| null\) : null\) : \(sessions\[role\.id\] \|\| null\)/.test(seSeg),
      { seg: seSeg.slice(0, 320) });

    // A4（PM 2026-11-20 02:09 线索）：dsh:team-status 的 item.archived 取的是 **DSH 会话列表**标记，
    // 团队「归档成员」不会让 DSH 归档 → 必须在 inspectProjectSessions 里先按名册拦掉（否则 verifiedCount 永远 6/6）。
    const ipStart = m.indexOf('async function inspectProjectSessions');
    const ipSeg = ipStart >= 0 ? m.slice(ipStart, ipStart + 4000) : '';
    check('A4 inspectProjectSessions 有 rosterArchivedOf：名册已归档/未绑定的角色计入 missing、不进 items',
      ipSeg.includes('const rosterArchivedOf')
      // PM 2026-11-20 03:2x 修残差：名册缺省视为已归档（不在名册的残留角色必须被拦）
      && /rosterArchivedOf\.get\(roleId\) === true\) \{ missing\.push\(roleId\); continue; \}/.test(ipSeg)
      && /for \(const roleId of roleIds\) map\.set\(roleId, true\)/.test(ipSeg),
      { seg: ipSeg.slice(0, 260) });

    // A5（PM 02:22 的第 d 处 · 数据层）：归档必须真清 store 残留，不能只靠渲染层过滤。
    //   d 的实现在 团队/工具/lib/session-archive.mjs → clearArchivedRoleState 的 workbench 步：
    //   ① 只有「归档的是当前会话」才 delete row.sessions[role]（旧会话要保留在岗绑定）
    //   ② workspace.sessionIds 一律按 sid 摘除（新旧会话都摘）
    const arch = fs.readFileSync(path.join(ROOT, "团队", "工具", "lib", "session-archive.mjs"), "utf8");
    const caStart = arch.indexOf("function clearArchivedRoleState");
    const caSeg = caStart >= 0 ? arch.slice(caStart, caStart + 6000) : "";
    check("A5 归档数据层清残留（session-archive.mjs）：当前会话 delete sessions[role] + sessionIds 摘该角色 sid",
      caSeg.includes("delete row.sessions[role]")
      && caSeg.includes("row.workspace.sessionIds.filter((x) => !doomedSids.has(String(x)))"),
      { seg: caSeg.slice(0, 200) });

    // A6（PM 2026-11-20 03:35 打回第①处）：归档时 sessionIds 要摘**该角色已知的全部 sid**，
    // 不能只摘本次那一个——同一角色反复换人时历史 sid 会一直在（实测堆到 96 条）。
    const caSeg2 = (() => {
      const a = fs.readFileSync(path.join(ROOT, "团队", "工具", "lib", "session-archive.mjs"), "utf8");
      const i = a.indexOf("function clearArchivedRoleState");
      return i >= 0 ? a.slice(i, i + 6500) : "";
    })();
    check("A6 归档多 sid 摘除：doomedSids = 本次 sid ∪ 当前会话 sid（archivedIsCurrent 时）",
      caSeg2.includes("const doomedSids = new Set([sid, archivedIsCurrent ? currentOfRole : ''].filter(Boolean).map(String));")
      && caSeg2.includes("row.workspace.sessionIds.filter((x) => !doomedSids.has(String(x)))"),
      { seg: caSeg2.slice(0, 200) });
    check("A6b 归档旧会话仍不删 sessions[role]（B-196e 红线：不动在岗绑定）",
      /if \(archivedIsCurrent && row\.sessions && Object\.prototype\.hasOwnProperty\.call\(row\.sessions, role\)\) \{ delete row\.sessions\[role\]; changed = true; \}/.test(caSeg2),
      {});

    // A7（打回第②处 · Owner 可见症状「6/6 已核验」的直接根因）：verifiedCount 不得再直接返回 live.ready。
    const vcSeg = (() => {
      const i = a.indexOf("function verifiedCount");
      return i >= 0 ? a.slice(i, i + 1500) : "";
    })();
    check("A7 verifiedCount 的 live.ready 兜底按名册过滤（不再直接 return live.ready）",
      vcSeg.includes("rosterSessionIds")
      && !/if \(typeof live\.ready === \"number\" && !isQuickTeam\(project\)\) return live\.ready;/.test(vcSeg)
      && vcSeg.includes("Math.min(scoped, live.ready)"),
      { seg: vcSeg.slice(0, 260) });

    // B4/B5（PM 2026-11-20 03:37 判据）：**真跑**生产源码里的 verifiedCount，不只看静态。
    //   从 app.js 抠出函数体 + 注入假依赖（liveFor / teamRoleIds / isQuickTeam），按判据断言。
    const vcSrc = (() => {
      const i = a.indexOf("function verifiedCount(project) {");
      if (i < 0) return "";
      let depth = 0;
      let j = i + "function verifiedCount(project) {".length - 1;
      for (; j < a.length; j += 1) {
        if (a[j] === "{") depth += 1;
        else if (a[j] === "}") { depth -= 1; if (depth === 0) { j += 1; break; } }
      }
      return a.slice(i, j);
    })();
    const makeVerified = (live) => {
      const deps = {
        live,
        teamRoleIds: () => ["pm", "product", "analyst", "programmer1", "programmer2", "tester"],
        isQuickTeam: () => false,
      };
      const factory = new Function("liveFor", "teamRoleIds", "isQuickTeam", vcSrc + "\nreturn verifiedCount;");
      return factory(() => deps.live, deps.teamRoleIds, deps.isQuickTeam);
    };
    const mkItems = (n) => Array.from({ length: n }, (_, k) => ({
      role: ["pm", "product", "analyst", "programmer1", "programmer2", "tester"][k],
      sessionId: "s" + k, exists: true, inWorkspace: true, blank: false, archived: false,
    }));
    const projectOf = (rosterIds) => ({ id: "p1", rosterSessionIds: rosterIds });
    const vcR2 = makeVerified({ items: mkItems(6), ready: 6 });
    check("B4 verifiedCount 真跑：名册 2 人 + 残留 6 条 items → 返回 2（PM 判据①）",
      vcSrc.length > 0 && vcR2(projectOf(["pm", "tester"])) === 2,
      { got: vcR2(projectOf(["pm", "tester"])), hasSrc: vcSrc.length > 0 });
    check("B5 verifiedCount 真跑：名册全空 → 返回 0（PM 判据②）",
      vcR2(projectOf([])) === 0, { got: vcR2(projectOf([])) });
    check("B6 verifiedCount 真跑：无 rosterSessionIds（旧数据）→ 回落旧行为 = 6（不误清）",
      vcR2(projectOf(null)) === 6, { got: vcR2(projectOf(null)) });
    check("B7 verifiedCount 真跑：兜底分支（无 items、ready=6）名册 2 人 → 2",
      makeVerified({ items: [], ready: 6 })(projectOf(["pm", "tester"])) === 2,
      { got: makeVerified({ items: [], ready: 6 })(projectOf(["pm", "tester"])) });

    /* ── B 逻辑复算（等价实现，覆盖「残留映射 vs 名册」两种情形） ── */
    const roleIds6 = ['pm', 'product', 'analyst', 'programmer1', 'programmer2', 'tester'];
    const residual = { pm: 's1', product: 's2', analyst: 's3', programmer1: 's4', programmer2: 's5', tester: 's6' };
    check('B1 store 残留 6 条 + 名册只剩 2 人 → 就绪数 = 2（修复后口径）',
      expectedReadyCount({ sessions: residual, rosterIds: ['pm', 'tester'], roleIds: roleIds6 }) === 2,
      {});
    check('B2 名册全空 + store 残留 6 → 就绪数 = 0（Owner 回归场景）',
      expectedReadyCount({ sessions: residual, rosterIds: [], roleIds: roleIds6 }) === 0,
      {});
    check('B3 无 rosterSessionIds 字段（旧数据）→ 回落旧行为 = 6（不炸、不误清）',
      expectedReadyCount({ sessions: residual, rosterIds: null, roleIds: roleIds6 }) === 6,
      {});
  } catch (e) {
    check('夹具未抛异常', false, { error: String((e && e.stack) || e).slice(0, 600) });
  } finally {
    const mainAfter = sha(MAIN);
    const appAfter = sha(APP);
    check('C 隔离：本夹具只读（src/main.js 与 src/renderer/app.js 前后 sha256 不变）',
      mainAfter === mainBefore && appAfter === appBefore,
      { main: [mainBefore.slice(0, 12), mainAfter.slice(0, 12)], app: [appBefore.slice(0, 12), appAfter.slice(0, 12)] });
    const failed = ROWS.filter((r) => r.ok !== true);
    if (!JSON_OUT) {
      console.log(`\n${ROWS.length - failed.length}/${ROWS.length} PASS${failed.length ? ` · ${failed.length} FAIL` : ''}`);
      if (failed.length) console.log('失败项：' + failed.map((r) => r.name).join(' | '));
    } else {
      console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed.length, failed: failed.map((r) => r.name), rows: ROWS }, null, 2));
    }
    if (failed.length) exitCode = 1;
  }
  process.exit(exitCode);
}
main();
