'use strict';
/**
 * f749 覆盖层夹具（PM 13:37）：body=0 不得隐藏覆盖层；body>0 且无失败必须隐藏。
 * 纯函数 dsh-overlay.js，Node 直测，无需 Electron/真窗口。
 */
const fs = require('node:fs');
const path = require('node:path');
const ROOT = path.resolve(__dirname, '..');
const { overlayState } = require(path.join(ROOT, 'src', 'renderer', 'dsh-overlay.js'));
const R = [];
function check(id, name, ok, detail) {
  R.push({ id, name, ok: Boolean(ok) });
  console.log((ok ? 'PASS  ' : 'FAIL  ') + id + ' ' + name + (detail === undefined ? '' : '  ← ' + JSON.stringify(detail)));
}

// 1) body=0：页面无内容 → 覆盖层必须显示（即使 ready/online 都是 true）
check('O1', 'body=0（ready=true, online=true）→ 覆盖层显示', overlayState({ online: true, ready: true, bodyLen: 0 }).showOff === true);
// 2) body>0 且无失败/错误 → 必须隐藏（即使 online 探测仍为 false）
const okBody = overlayState({ online: false, ready: true, bodyLen: 285, failed: false, hasError: false });
check('O2', 'body=285 且无失败（online=false）→ 覆盖层隐藏', okBody.showOff === false && okBody.loadedOk === true, okBody);
// 3) did-fail：即使 body 旧值>0 也必须显示
check('O3', 'failed=true + body=285 → 覆盖层显示', overlayState({ online: true, ready: true, bodyLen: 285, failed: true }).showOff === true);
// 4) dshViewError（401/错误码）→ 显示
check('O4', 'hasError=true + body=285 → 覆盖层显示', overlayState({ online: true, ready: true, bodyLen: 285, hasError: true }).showOff === true);
// 5) 未 ready（加载中）→ 显示
check('O5', 'ready=false + body=0 → 覆盖层显示', overlayState({ online: true, ready: false, bodyLen: 0 }).showOff === true);
// 6) body 非数字/负数 → 视为无内容
check('O6', 'bodyLen=NaN/-1 → 覆盖层显示', overlayState({ online: true, ready: true, bodyLen: NaN }).showOff === true && overlayState({ online: true, ready: true, bodyLen: -1 }).showOff === true);

const appSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'app.js'), 'utf8');
const indexSrc = fs.readFileSync(path.join(ROOT, 'src', 'renderer', 'index.html'), 'utf8');
check('O7', 'app.js 使用 AWBDshOverlay.overlayState，index.html 先加载 dsh-overlay.js', /AWBDshOverlay\.overlayState/.test(appSrc)
  && /<script src="dsh-overlay\.js"><\/script>[\s\S]*<script src="app\.js"><\/script>/.test(indexSrc));
// O8：隐藏实例里 webview guest 默认会被 Chromium 节流 → DSH 的 boot 脚本停在「正在进入…」；
// 只给 BrowserWindow 设 backgroundThrottling 不够，必须冻结 guest 的节流（PM 13:32 的 285 字进场页）。
check('O8', 'webview 冻结后台节流（webpreferences=backgroundThrottling=no）', /<webview[^>]*backgroundThrottling=no/.test(indexSrc));
// O9：PM 13:58 要求持续采样 500ms×10s，任一次 >0 即撤；10s 全 0 才报 DSH_BLANK。
check('O9', '持续采样 500ms×20 且 10s 空页落 DSH_BLANK', /for \(let i = 0; i < 20; i \+= 1\)/.test(appSrc)
  && /setTimeout\(resolve, 500\)/.test(appSrc) && /DSH_BLANK/.test(appSrc) && /dshBodyProbeSeq/.test(appSrc));

console.log('\n' + R.filter((x) => x.ok).length + '/' + R.length + ' PASS');
process.exitCode = R.some((x) => !x.ok) ? 1 : 0;
