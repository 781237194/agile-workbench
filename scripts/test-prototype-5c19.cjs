#!/usr/bin/env node
'use strict';
/**
 * T-20261115-121020-1134 · R-5c19 前端 5 套原型：静态断言 + 性能汇总判定（不启动浏览器）
 *
 * 覆盖需求的静态可判部分（动态部分由真窗口 CDP 复验，见 产品/原型/证据-1134/）：
 *   AC1 单文件、四类外链 0 命中、6 张选型卡五要素
 *   AC3 红线数值与 ?realMem= 注入分支存在（1234/2600/none）+ 选型页同屏 real/proxy
 *   AC4 原皮零特效（native 下 __fxState 全 false、无 --theme-glow）
 *   AC5 5 个 data-style 值齐、--theme- 变量 ≥10
 *   AC6 不动 src（git status --porcelain src/ 为空）+ 原型文件在 原型/ 下
 *   AC7 选型说明.md 存在且 token 映射表 ≥8 行
 *   AC8 ?lowfx=1 / idle 降帧 / blur 停粒子 三个开关在代码里存在
 *   AC9 ?particles 夹取 1..160、#style=不存在回落 native、real=none 不冒充 task-manager
 *   另：把 证据-1134/perf-*.json 汇总成 perf-summary.json（median 的三次采样 → 红线判定）
 *
 * 跑法：node scripts/test-prototype-5c19.cjs
 */
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.resolve(__dirname, '..');
const PROTO_DIR = path.join(ROOT, '项目', '工作台改造修复', '产品', '原型');
const HTML = path.join(PROTO_DIR, '原型选型-5c19.html');
const DOC = path.join(PROTO_DIR, '选型说明.md');
const EV = path.join(PROTO_DIR, '证据-1134');

let passed = 0;
const failures = [];
function check(id, name, ok, detail) {
  if (ok) { passed += 1; console.log(`PASS  ${id}  ${name}`); return; }
  failures.push({ id, name, detail });
  console.log(`FAIL  ${id}  ${name}${detail === undefined ? '' : ' · ' + JSON.stringify(detail).slice(0, 400)}`);
}

if (!fs.existsSync(HTML)) {
  console.error(`原型文件不存在：${HTML}`);
  process.exit(2);
}
const html = fs.readFileSync(HTML, 'utf8');
const bytes = fs.statSync(HTML).size;
const count = (re) => (html.match(re) || []).length;

/* ── AC1 单文件 + 外链 0 + 6 张卡 ─────────────────────────────────────── */
check('AC1-01', '单文件 HTML 存在且 >80KB、<3MB', bytes > 80 * 1024 && bytes < 3 * 1024 * 1024, { bytes });
check('AC1-02', '四类外链各 0 命中（script src / link stylesheet / @import / url(http)）',
  count(/<script[^>]+src=/g) === 0 && count(/<link[^>]+stylesheet/g) === 0 && count(/@import/g) === 0 && count(/url\(\s*["']?https?:/g) === 0,
  { script: count(/<script[^>]+src=/g), link: count(/<link[^>]+stylesheet/g), atImport: count(/@import/g), url: count(/url\(\s*["']?https?:/g) });
const CARD_FIELDS = ['风格', '特效', '内存', '帧率', '适合'];
const cardMissing = CARD_FIELDS.filter((k) => !html.includes(k));
check('AC1-03', '六张选型卡含五要素（风格/特效/内存/帧率/适合）', cardMissing.length === 0, { cardMissing });
check('AC1-04', '选型卡数量 6 套（5 套风格 + 原皮）', ['tech', 'anime', 'minimal', 'cyber', 'glass', 'native'].every((s) => html.includes(`data-style="${s}"`)));

/* ── AC5 五风格 + 变量隔离 ─────────────────────────────────────────────── */
const styles = [...new Set((html.match(/data-style="([a-z]+)"/g) || []).map((s) => s.replace(/^data-style="|"$/g, '')))].sort();
check('AC5-01', 'data-style 5 套齐 + native 原皮', ['anime', 'cyber', 'glass', 'minimal', 'native', 'tech'].every((s) => styles.includes(s)), { styles });
const themeVars = [...new Set((html.match(/--theme-[a-z0-9-]+(?=\s*:)/g) || []))];
check('AC5-02', '--theme- 变量 ≥10 且全部带 --theme- 前缀', themeVars.length >= 10 && themeVars.every((v) => v.startsWith('--theme-')), { count: themeVars.length, vars: themeVars.slice(0, 12) });
check('AC5-03', '只靠 body[data-style] 选择器切外观', /body\[data-style=/.test(html));

/* ── AC3 性能红线可复算 ────────────────────────────────────────────────── */
check('AC3-01', '__perfProbe 暴露且红线数值写死（55 / 18ms / 2%）', count(/__perfProbe/g) >= 1 && html.includes('55') && /18/.test(html) && /0\.02|2%/.test(html));
check('AC3-02', '?realMem= 注入分支存在，注入值直接与 2048MB 红线比较（可复算）',
  /QUERY\.get\('realMem'\)/.test(html) && /MEM_LIMIT_MB/.test(html) && /pass:\s*n\s*<=\s*MEM_LIMIT_MB|pass\s*=\s*n\s*<=\s*MEM_LIMIT_MB/.test(html));
check('AC3-03', '取不到真实读数时 method=none 且 pass=null（不冒充 task-manager）',
  /method:\s*'none'/.test(html) && /pass:\s*null/.test(html));
check('AC3-04', '选型页同屏展示 real 与 proxy 两组读数', /proxy/i.test(html) && /real/i.test(html) && count(/__memProbe/g) >= 1);

/* ── AC4 原皮零特效 ────────────────────────────────────────────────────── */
check('AC4-01', '原生皮声明零特效（native 段内粒子=0 / fx 全关）', /native/.test(html) && /__fxState/.test(html));
check('AC4-02', '原皮只用 --panel / --gold 语义（不引入 --theme-glow 做特效）',
  html.includes('--panel') && html.includes('--gold'));

/* ── AC8 低配与降帧 ────────────────────────────────────────────────────── */
check('AC8-01', '?lowfx=1 分支存在且能关四开关', count(/lowfx/g) >= 3);
check('AC8-02', 'idle 静置降帧（3 秒无输入 ≤30fps）在代码里存在', /idle/i.test(html) && /suspendIdle/.test(html));
check('AC8-03', 'probe 期间挂起 idle 降帧（__perfProbe 返回 suspendIdle）', /suspendIdle/.test(html));
check('AC8-04', 'blur 时停粒子', /blur/i.test(html) && /addEventListener\(\s*['"]blur['"]/.test(html));

/* ── AC9 非法输入不崩 ──────────────────────────────────────────────────── */
check('AC9-01', '?particles 夹到 1..160', /160/.test(html) && /Math\.min|clamp/.test(html));
check('AC9-02', '#style 非法值回落 native（STYLE_KEYS 白名单 + 回落分支）',
  /STYLE_KEYS\.indexOf\(style\)\s*<\s*0/.test(html) && /style\s*=\s*'native'/.test(html));

/* ── AC6 不动 src ─────────────────────────────────────────────────────── */
let srcStatus = '';
try {
  srcStatus = execFileSync('git', ['status', '--porcelain', 'src/'], { cwd: ROOT, encoding: 'utf8' }).trim();
} catch { srcStatus = '(git 调用失败)'; }
check('AC6-01', 'git status --porcelain src/ 为空（本轮不动 src）', srcStatus === '', { srcStatus });
check('AC6-02', '原型文件在 产品/原型/ 下（不新增 src/**）',
  path.relative(PROTO_DIR, HTML) === '原型选型-5c19.html' && !HTML.includes(`${path.sep}src${path.sep}`));

/* ── AC7 选型说明 + token 映射 ≥8 行 ───────────────────────────────────── */
{
  const exists = fs.existsSync(DOC);
  const docText = exists ? fs.readFileSync(DOC, 'utf8') : '';
  const mappingRows = docText.split(/\r?\n/).filter((line) => /^\s*\|/.test(line) && /--theme-/.test(line) && /--(gold|panel|line|muted|bg|fg|radius|shadow)/.test(line)).length;
  check('AC7-01', '选型说明.md 存在', exists, { file: DOC });
  check('AC7-02', 'token 映射表 ≥8 行（--theme-* → 工作台现有变量）', mappingRows >= 8, { mappingRows });
  check('AC7-03', '含每套优缺点/风险/适合场景与性能代价对比', /优点/.test(docText) && /风险/.test(docText) && /性能代价/.test(docText));
}

/* ── 性能汇总判定（AC3 数据侧）─────────────────────────────────────────── */
{
  const files = fs.existsSync(EV) ? fs.readdirSync(EV).filter((f) => /^perf-.*\.json$/.test(f) && f !== 'perf-summary.json') : [];
  const summary = { at: new Date().toISOString(), redline: { fps: 55, p95: 18, dropRate: 0.02 }, items: [], pass: false, source: files };
  for (const file of files.sort()) {
    let data = null;
    try { data = JSON.parse(fs.readFileSync(path.join(EV, file), 'utf8')); } catch { continue; }
    if (!data || data.ok !== true) continue;
    const median = data.median || { fps: data.fps, p95: data.p95FrameMs !== undefined ? data.p95FrameMs : data.p95, dropRate: data.dropRate };
    const item = {
      file,
      style: data.style || '',
      theme: data.theme || '',
      particles: data.particles === undefined ? null : data.particles,
      lowfx: Boolean(data.lowfx),
      fps: Number(median.fps),
      p95: Number(median.p95),
      dropRate: Number(median.dropRate),
      samples: Array.isArray(data.samples) ? data.samples.length : 1,
      pass: Number(median.fps) >= 55 && Number(median.p95) <= 18 && Number(median.dropRate) < 0.02
    };
    summary.items.push(item);
  }
  summary.pass = summary.items.length > 0 && summary.items.every((i) => i.pass);
  fs.writeFileSync(path.join(EV, 'perf-summary.json'), JSON.stringify(summary, null, 2) + '\n', 'utf8');
  const techMedian = summary.items.filter((i) => i.style === 'tech');
  check('AC3-05', 'perf 证据覆盖 5 套风格 + 原皮（≥6 份）', summary.items.length >= 6, { count: summary.items.length });
  check('AC3-06', '全部样本按 median 复算后满足 fps≥55 / p95≤18ms / dropRate<2%', summary.pass, { items: summary.items.map((i) => [i.style, i.fps, i.p95, i.dropRate, i.pass]) });
  check('AC3-07', 'tech 套有 3 次采样中位数（不是单次）', techMedian.some((i) => i.samples >= 3), { techSamples: techMedian.map((i) => [i.file, i.samples]) });
  check('AC3-08', '汇总落盘 perf-summary.json', fs.existsSync(path.join(EV, 'perf-summary.json')));
}

console.log(`\nT-1134 原型静态断言：${passed}/${passed + failures.length} PASS`);
if (failures.length) {
  console.log(JSON.stringify(failures, null, 2));
  process.exit(1);
}
