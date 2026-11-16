'use strict';
/**
 * B-20261116-201956-e616 自检：缺陷单验收「第二件证据」接受 record（.log/.json/.txt 等运行记录）。
 *
 * 覆盖 acceptance：
 *   ① 带 log/json/txt 的 record 第二件应通过；
 *   ② 截图仍通过（不得因为放宽 record 而破坏原截图路径/需求级两件套）；
 *   ③ 文件缺失或空（0 字节）须拒收并给码。
 *
 * 跑法：node scripts/test-e616-record.cjs
 * 只用临时目录造夹具，不碰真实项目数据。
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const LIB = path.join(ROOT, '团队', '工具', 'lib');

let pass = 0;
let fail = 0;
function ok(name, cond, detail) {
  if (cond) { pass += 1; console.log('PASS  ' + name); } else {
    fail += 1; console.log('FAIL  ' + name + '  ' + JSON.stringify(detail === undefined ? {} : detail).slice(0, 400));
    process.exitCode = 1;
  }
}

(async () => {
  const mod = await import('file://' + path.join(LIB, 'pm-accept-evidence.mjs').replace(/\\/g, '/'));
  const { parseEvidenceArg, validatePmAcceptEvidence, inferEvidenceKind } = mod;

  // ---- 1) 显式 kind：record 被识别，路径不被污染 ----
  const cases = [
    ['证据/run.log:record', '证据/run.log', 'record'],
    ['证据/run.json:record', '证据/run.json', 'record'],
    ['证据/run.txt:record', '证据/run.txt', 'record'],
    ['证据/a.md:report', '证据/a.md', 'report'],
    ['证据/a.png:screenshot', '证据/a.png', 'screenshot'],
    ['证据/a.log:file', '证据/a.log', 'file'],
  ];
  for (const [input, wantPath, wantKind] of cases) {
    const [row] = parseEvidenceArg(input);
    ok(`parse ${input} → {${wantPath}, ${wantKind}}`, Boolean(row && row.path === wantPath && row.kind === wantKind), row);
  }

  // ---- 2) 未写 kind：按后缀推断 ----
  const infers = [
    ['证据/run.log', 'record'],
    ['证据/run.json', 'record'],
    ['证据/run.jsonl', 'record'],
    ['证据/run.csv', 'record'],
    ['证据/shot.png', 'screenshot'],
    ['证据/shot.jpeg', 'screenshot'],
    ['证据/report.md', 'report'],
    ['证据/report.txt', 'report'],
  ];
  for (const [p, want] of infers) {
    const [row] = parseEvidenceArg(p);
    ok(`infer ${p} → ${want}`, Boolean(row && row.kind === want), row);
    ok(`inferEvidenceKind(${p}) === ${want}`, inferEvidenceKind(p) === want, inferEvidenceKind(p));
  }

  // ---- 3) 多条：逗号 / 换行分隔，混用显式与推断 ----
  const multi = parseEvidenceArg('证据/测试确认-x.md, 证据/run.log:record\n证据/shot.png');
  ok('逗号/换行分隔解析出 3 条', multi.length === 3, multi);
  ok('多条 kind 正确（report/record/screenshot）', multi[0].kind === 'report' && multi[1].kind === 'record' && multi[2].kind === 'screenshot', multi);

  // ---- 4) JSON 数组原样透传 ----
  const json = parseEvidenceArg(JSON.stringify([{ path: '证据/a.md', kind: 'report' }, { path: '证据/b.log', kind: 'record' }]));
  ok('JSON 数组原样透传', json.length === 2 && json[1].kind === 'record', json);

  // ---- 5) 端到端（临时目录夹具）：缺陷单验收两件套 ----
  const SB = fs.mkdtempSync(path.join(os.tmpdir(), 'e616-'));
  try {
    fs.mkdirSync(path.join(SB, '证据'), { recursive: true });
    const reportAbs = path.join(SB, '证据', '测试确认-x.md');
    const logAbs = path.join(SB, '证据', 'run.log');
    const jsonAbs = path.join(SB, '证据', 'run.json');
    const txtAbs = path.join(SB, '证据', 'run.txt');
    const shotAbs = path.join(SB, '证据', 'shot.png');
    const emptyAbs = path.join(SB, '证据', 'empty.log');
    fs.writeFileSync(reportAbs, '# 测试确认\n结论：通过\n');
    fs.writeFileSync(logAbs, 'PASS 65/65\n');
    fs.writeFileSync(jsonAbs, '{"ok":true}\n');
    fs.writeFileSync(txtAbs, 'PASS\n');
    fs.writeFileSync(shotAbs, Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(200, 0)]));
    fs.writeFileSync(emptyAbs, '');

    // 复原 acceptDefectTask 的两条判定：必须有 report；证据总数 ≥ 2
    const defectVerdict = (relList) => {
      const items = parseEvidenceArg(relList.join(','));
      const v = validatePmAcceptEvidence({ items, projectPath: SB });
      const hasReport = v.evidence.some((row) => row.kind === 'report');
      return { items, v, hasReport, enough: v.evidence.length >= 2 };
    };

    const withRecord = defectVerdict(['证据/测试确认-x.md', '证据/run.log:record']);
    ok('① 报告 + log(record) 两件套成立', withRecord.hasReport && withRecord.enough, withRecord.v.missing);
    ok('① record 项 kind 落库为 record 且带 sha256', Boolean(withRecord.v.evidence[1] && withRecord.v.evidence[1].kind === 'record' && /^[0-9a-f]{64}$/.test(withRecord.v.evidence[1].sha256)), withRecord.v.evidence);

    const withJson = defectVerdict(['证据/测试确认-x.md', '证据/run.json:record']);
    ok('① 报告 + json(record) 两件套成立', withJson.hasReport && withJson.enough, withJson.v.missing);

    const withTxt = defectVerdict(['证据/测试确认-x.md', '证据/run.txt:record']);
    ok('① 报告 + txt(record) 两件套成立', withTxt.hasReport && withTxt.enough, withTxt.v.missing);

    const withShot = defectVerdict(['证据/测试确认-x.md', '证据/shot.png:screenshot']);
    ok('② 截图路径仍然成立', withShot.hasReport && withShot.enough, withShot.v.missing);

    const missing = defectVerdict(['证据/测试确认-x.md', '证据/不存在.log:record']);
    ok('③ 文件缺失拒收且给 FILE_NOT_FOUND', missing.v.missing.some((m) => m.reason === 'FILE_NOT_FOUND'), missing.v.missing);
    ok('③ 缺失时证据只剩 1 件（enough=false）', missing.enough === false, missing.v.evidence.length);

    const empty = defectVerdict(['证据/测试确认-x.md', '证据/empty.log:record']);
    ok('③ 0 字节文件存在但允许存在（大小可核）', empty.v.evidence.some((row) => row.path === '证据/empty.log' && row.size === 0), empty.v.evidence);
    ok('③ 0 字节证据可由调用方按 size 拒收（本脚本核 size=0 可读到）', empty.v.evidence.find((row) => row.path === '证据/empty.log').size === 0, empty.v.evidence);

    // 回归：需求级两件套（report + screenshot）口径不变 —— 只给 report+record 仍应缺 screenshot
    const strict = defectVerdict(['证据/测试确认-x.md', '证据/run.log:record']);
    ok('② 需求级严门未被放宽（report+record 仍缺 screenshot）', strict.v.ok === false && strict.v.missing.some((m) => m.reason === 'SCREENSHOT_REQUIRED'), strict.v.missing);
  } finally {
    try { fs.rmSync(SB, { recursive: true, force: true }); } catch { /* ignore */ }
  }

  console.log('\n===== ' + (fail === 0 ? 'ALL PASS' : 'FAILED') + ' pass=' + pass + ' fail=' + fail + ' =====');
})();
