'use strict';
/**
 * R-b34a R6补（T-20261118-184943-6b24）：看板 HTML「磁盘复用」新鲜性判定（单源纯函数，便于夹具直测）。
 *
 * 规则：冷开时若 `团队/看板.html` 存在且**不旧于**它的数据依赖
 *   - `团队/状态/项目/<项目>/工作流.json`
 *   - `团队/状态/项目/<项目>/任务`（目录 mtime）
 * 则认为磁盘看板仍是当下的，直接 loadFile、跳过 generateBoard（省 ~1s）；任何一项比看板新 → 必须重建。
 *
 * 保守边界：
 *   - 看板.html 不存在 / 为空 → 返回 null（调用方照旧生成）；
 *   - 依赖缺失（首次/被删）→ 视为「不可复用」（fresh=false），不猜；
 *   - 只比 mtime+size，不读内容（冷开路径不做额外 IO）；mtime 相等视为 fresh（同一次生成）。
 */
const fs = require('node:fs');
const path = require('node:path');

/** @returns {{path:string,bytes:number,mtimeMs:number,depsMaxMtime:number,fresh:boolean,reasons:string[]}|null} */
function boardHtmlFreshInfo({ teamRoot, projectDir, project } = {}) {
  const reasons = [];
  try {
    const root = String(teamRoot || '').trim();
    if (!root) return null;
    const dir = String(projectDir || '').trim()
      || (project ? path.join(root, '状态', '项目', String(project.teamName || project.name || '')) : '');
    const htmlPath = path.join(root, '看板.html');
    let hs = null;
    try { hs = fs.statSync(htmlPath); } catch { return null; }
    if (!hs || !hs.isFile() || !hs.size) return null;
    const deps = [
      { name: '工作流.json', file: path.join(dir, '工作流.json') },
      { name: '任务目录', file: path.join(dir, '任务') },
    ];
    let depsMax = 0;
    let missing = 0;
    for (const dep of deps) {
      try { depsMax = Math.max(depsMax, fs.statSync(dep.file).mtimeMs); }
      catch { missing += 1; reasons.push(`${dep.name} 缺失`); }
    }
    const fresh = missing === 0 && hs.mtimeMs >= depsMax;
    if (missing === 0 && !fresh) reasons.push('依赖比看板新');
    return { path: htmlPath, bytes: hs.size, mtimeMs: hs.mtimeMs, depsMaxMtime: depsMax, fresh, reasons };
  } catch {
    return null;
  }
}

module.exports = { boardHtmlFreshInfo };
