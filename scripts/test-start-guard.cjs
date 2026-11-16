// B-20261116-134117-bd2e 夹具：用 -ProcJson 注入命令行，断言「沙箱实例不拦、默认实例才拦」
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const GUARD = path.join(ROOT, 'scripts', 'start-guard.ps1');
const TMP = path.join(ROOT, '_tmp', 'start-guard-' + Date.now().toString(36));
fs.mkdirSync(TMP, { recursive: true });
const EXE = path.join(ROOT, 'node_modules', 'electron', 'dist', 'electron.exe');

let pass = 0;
const fails = [];
function check(name, ok, detail) {
  if (ok) { pass += 1; console.log('PASS  ' + name); }
  else { fails.push({ name, detail }); console.log('FAIL  ' + name + ' · ' + JSON.stringify(detail)); }
}

function run(rows, extra = []) {
  const file = path.join(TMP, 'procs-' + Math.random().toString(36).slice(2) + '.json');
  fs.writeFileSync(file, JSON.stringify(rows), 'utf8');
  const r = spawnSync('powershell', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', GUARD, '-AppDir', ROOT, '-ProcJson', file, ...extra], { encoding: 'utf8' });
  return { code: r.status, out: String((r.stdout || '') + (r.stderr || '')) };
}
const row = (pid, cmd) => ({ ProcessId: pid, ExecutablePath: EXE, CommandLine: cmd });

// AC4 ①沙箱/长跑实例（B 的那种）→ 不计入，exit 0，启动照常
const sandbox = run([row(173404, `"${EXE}" . --no-wake --remote-debugging-port=9570`)], ['-Kill']);
check('AC4-1 沙箱长跑实例不拦启动（exit 0，-Kill 也不动它）',
  sandbox.code === 0 && /沙箱实例：运行中/.test(sandbox.out) && /没有默认实例需要清理/.test(sandbox.out),
  { code: sandbox.code, out: sandbox.out.slice(-300) });

// AC4 ②默认实例 → 计入，exit 3
const def = run([row(338096, `"${EXE}" .`)]);
check('AC4-2 默认实例才拦（exit 3，输出 PID）',
  def.code === 3 && /默认实例：运行中（PID 338096）/.test(def.out) && /\[实例\] 默认实例 PID 338096/.test(def.out),
  { code: def.code, out: def.out.slice(-300) });

// AC2 ③显式 --user-data-dir 指向 _tmp → 不计入
const explicit = run([row(410001, `"${EXE}" . --user-data-dir=_tmp\\x`)]);
check('AC2 --user-data-dir=_tmp 的实例不计入（exit 0）',
  explicit.code === 0 && /沙箱实例：运行中/.test(explicit.out), { code: explicit.code, out: explicit.out.slice(-240) });

// AC1 ④守护进程（route-daemon-host.cjs）不计入
const helper = run([row(393268, `"${EXE}" D:\\deepseek\\agile-workbench\\src\\route-daemon-host.cjs 工作台改造修复`)]);
check('AC1 route-daemon-host 守护进程不计入（exit 0）',
  helper.code === 0 && /守护进程：PID 393268/.test(helper.out), { code: helper.code, out: helper.out.slice(-240) });

// AC5 ⑤混乱场景：沙箱 + 默认同时存在 → 以默认实例判定（exit 3），两行都在；-Kill 夹具模式只模拟、绝不真杀
const mixed = run([row(173404, `"${EXE}" . --no-wake --remote-debugging-port=9570`), row(338096, `"${EXE}" .`)]);
const mixedKill = run([row(173404, `"${EXE}" . --no-wake --remote-debugging-port=9570`), row(338096, `"${EXE}" .`)], ['-Kill']);
check('AC5 沙箱+默认同存：exit 3、两行区分；-Kill 只模拟默认实例、不碰沙箱',
  mixed.code === 3 && /默认实例：运行中（PID 338096）/.test(mixed.out) && /沙箱实例：运行中（PID 173404/.test(mixed.out)
  && mixedKill.code === 0 && /只模拟：不会结束真实进程 PID 338096/.test(mixedKill.out) && !/PID 173404/.test(mixedKill.out.split('清理')[1] || ''),
  { mixedCode: mixed.code, killCode: mixedKill.code, out: mixedKill.out.slice(-300) });

// AC4 ⑥空列表 → 无实例
const none = run([]);
check('AC4-6 没有实例时 exit 0', none.code === 0 && /默认实例：无/.test(none.out), { code: none.code });

fs.rmSync(TMP, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
console.log('\nstart-guard 断言：' + pass + '/' + (pass + fails.length) + ' PASS');
if (fails.length) { console.log(JSON.stringify(fails, null, 2)); process.exit(1); }
