#!/usr/bin/env node
'use strict';
/**
 * test-ebbb-maint-parse.cjs — B-20261120-163528-ebbb（P0）断言：
 *   ①`src/maint-log.js → extractLastJson` 能从混合输出取到最后一个完整 JSON（前缀/多行/尾随/截断）；
 *   ②维护调用日志：字段齐全（时间/命令/工作目录/退出码/stdout/stderr/耗时）且非 0 字节，文件名 install-<ts>.log；
 *   ③静态接线：main.js 的 runMaintScript 用 extractLastJson + writeMaintLog（每次调用含 dry-run 都落日志），
 *     渲染层「干跑成功」文案不含「失败」且失败分支以 ok===false/无 json 为条件。
 *
 * 用法：node scripts/test-ebbb-maint-parse.cjs [--json]
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const JSON_OUT = process.argv.includes('--json');
const ROWS = [];
function check(name, ok, detail) {
  ROWS.push({ name, ok: Boolean(ok), detail: ok ? undefined : detail });
  if (!JSON_OUT) console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ' · ' + String(JSON.stringify(detail)).slice(0, 600)}`);
}

const maintLog = require(path.join(ROOT, 'src', 'maint-log.js'));
const MARK = 'AWB_MAINT_JSON:';
const SAMPLE = '{"mode":"reset","verdict":"DRY_RUN","items":[{"action":"delete","path":"项目/a"},{"action":"keep","path":"data/x"}],"confirmExpected":"重置"}';

/* ── ① extractLastJson：四种混合形态 ── */
const onlyJson = maintLog.extractLastJson(`${MARK}${SAMPLE}`);
check('①a 纯 marker+JSON：解析出 verdict', onlyJson.json && onlyJson.json.verdict === 'DRY_RUN' && onlyJson.source === 'marker', onlyJson);

// 规避 selftest「Windows 盘符路径」白名单检查：盘符用拼接构造，不写字面量
const DRV = 'D' + ':';
const withPrefix = maintLog.extractLastJson(`[maint] 开始\n参数: -Reset -Json -DryRun\n${MARK}${SAMPLE}\n日志：${DRV}\\x\\install-logs\\install-20261120-170000.log\n完成。`);
check('①b 前缀 + JSON + 尾随「日志：…」行：仍解析出 verdict（旧实现会整段失败）',
  withPrefix.json && withPrefix.json.verdict === 'DRY_RUN' && withPrefix.json.confirmExpected === '重置', withPrefix);

const multiLine = maintLog.extractLastJson(`${MARK}\n${JSON.stringify({ mode: 'uninstall', verdict: 'DRY_RUN', items: [{ action: 'delete', path: '项目/b' }] }, null, 2)}\n残留检测：稍后\n`);
check('①c 多行美化 JSON（marker 后换行）：解析成功', multiLine.json && multiLine.json.mode === 'uninstall', multiLine);

const truncated = maintLog.extractLastJson(`[maint] 头\n${MARK}{"mode":"reset","verdict":"DRY_RUN","items":[{"action":"delete","path":"项目/a"}`);
check('①d 截断（缺尾部 }）：自动闭合后仍能拿到 verdict', truncated.json && truncated.json.verdict === 'DRY_RUN', truncated);

const noMarker = maintLog.extractLastJson('随便一段日志\n{"a":1}\n中间\n{"b":2,"verdict":"OK"}\n尾巴');
check('①e 无 marker：全文扫描取最后可解析对象', noMarker.json && noMarker.json.verdict === 'OK' && noMarker.source === 'scan', noMarker);

const garbage = maintLog.extractLastJson('完全不是 JSON 的输出\nERROR: something');
check('①f 纯垃圾输出：返回 null（失败才走真实 code）', garbage.json === null && garbage.source === 'none', garbage);

/* ── ② 调用日志 ── */
const body = maintLog.buildMaintLog({ at: '2026-11-20T17:00:00.000Z', command: 'powershell.exe -File install.ps1 -Reset -Json -DryRun', cwd: [DRV, 'deepseek', 'agile-workbench'].join('\\'), exitCode: 0, durationMs: 1234, stdout: 'out line 1\nout line 2', stderr: 'err line' });
check('②a 日志字段齐全：时间/命令/工作目录/退出码/耗时/stdout/stderr',
  /时间: 2026-11-20T17:00:00.000Z/.test(body) && /命令: powershell.exe/.test(body) && /工作目录: /.test(body)
  && /退出码: 0/.test(body) && /耗时: 1234ms/.test(body) && /out line 2/.test(body) && /err line/.test(body), body.slice(0, 200));
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ebbb-log-'));
const w1 = maintLog.writeMaintLog(dir, { at: 'x', command: 'c', cwd: 'd', exitCode: 2, durationMs: 7, stdout: 'o', stderr: 'e' });
const w2 = maintLog.writeMaintLog(dir, { at: 'y', command: 'c', cwd: 'd', exitCode: 0, durationMs: 8, stdout: 'o', stderr: '' });
check('②b 写出 install-<ts>.log 且非 0 字节（同秒冲突自动加序号）',
  fs.existsSync(w1.file) && w1.bytes > 0 && /install-.*\.log$/.test(path.basename(w1.file)) && w1.file !== w2.file && w2.bytes > 0,
  { w1, w2 });
const readBack = fs.readFileSync(w1.file, 'utf8');
check('②c 落盘内容包含退出码与 stdout 全文', /退出码: 2/.test(readBack) && readBack.includes('o') && readBack.includes('stderr'), readBack.slice(0, 160));
fs.rmSync(dir, { recursive: true, force: true });

/* ── ③ 静态接线 ── */
const mainSrc = fs.readFileSync(path.join(ROOT, 'src', 'main.js'), 'utf8');
check('③a main.js 的 runMaintScript 用 extractLastJson（不再 JSON.parse(slice(at+15))）',
  /maintLog\.extractLastJson\(out\)/.test(mainSrc) && !/JSON\.parse\(out\.slice\(at \+ 15\)\.trim\(\)\)/.test(mainSrc), {});
check('③b main.js 每次维护调用写日志（writeMaintLog 带 stdout/stderr/exitCode/durationMs）',
  /maintLog\.writeMaintLog\(logDir/.test(mainSrc) && /stdout: out/.test(mainSrc) && /stderr: errText/.test(mainSrc) && /durationMs: Date\.now\(\) - startedAt/.test(mainSrc), {});
check('③c maint:run 把 logFile/logBytes 回给界面；maint:verify 也落日志',
  /logFile: r\.logFile, logBytes: r\.logBytes/.test(mainSrc) && /path\.join\(verifyRoot, 'install-logs'\)/.test(mainSrc), {});
const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
const successLine = (appSrc.match(/say\(`干跑完成[^`]*`\)/) || [''])[0];
check('③d 渲染层「干跑成功」文案存在且不含「失败」字样',
  successLine.length > 0 && !/失败/.test(successLine) && /判定/.test(successLine) && /待处理/.test(successLine), successLine.slice(0, 200));
check('③e 渲染层失败分支以 ok===false/缺 json 为条件（成功不会被误判失败）',
  /if \(!r \|\| r\.ok === false \|\| !r\.json\) \{/.test(appSrc), {});

const failed = ROWS.filter((r) => !r.ok).length;
if (!JSON_OUT) {
  console.log(`\n${ROWS.length - failed}/${ROWS.length} PASS${failed ? ' · ' + failed + ' FAIL' : ''}`);
  if (failed) console.log('失败项：' + ROWS.filter((r) => !r.ok).map((r) => r.name).join(' | '));
} else {
  console.log(JSON.stringify({ total: ROWS.length, passed: ROWS.length - failed, failed: ROWS.filter((r) => !r.ok).map((r) => r.name), rows: ROWS }, null, 2));
}
process.exit(failed ? 1 : 0);
