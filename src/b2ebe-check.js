'use strict';
/**
 * B-20261114-052109-2ebe 界面自检（--b2ebe-check）
 *
 * ① 打开「六角色」tab，断言六张角色卡的「角色卡 / 文件索引」都是存在，
 *    「本轮 boot」只允许 已就绪/未 boot/boot 已过期 三态，不得出现「文件缺失」；
 * ② 临时把一名角色的 角色卡.md 改名 → 刷新 presence → 断言该角色「角色卡=缺失」「本轮 boot=文件缺失」（红）；
 * ③ 还原文件名 → 断言回到「存在」（三步各截图）。
 */
const fs = require('node:fs');
const path = require('node:path');

const READ_CARDS = `(() => Array.from(document.querySelectorAll('#roles-grid .role-card')).map((card) => {
  const facts = {};
  card.querySelectorAll('.role-facts > span').forEach((span) => {
    const k = span.querySelector('i') ? span.querySelector('i').textContent.trim() : '';
    const v = span.querySelector('b') ? span.querySelector('b').textContent.trim() : '';
    if (k) facts[k] = v;
  });
  const h3 = card.querySelector('h3');
  const raw = String(card.textContent || '').replace(/\\s+/g, ' ');
  return { role: h3 ? h3.textContent.trim() : '', facts, text: raw.slice(0, 200) };
}))()`;

async function runB2ebeCheck({ app, createWindow, getWindow, readStore, outRoot }) {
  const outDir = process.env.AWB_B2EBE_OUT ? path.resolve(process.env.AWB_B2EBE_OUT) : path.join(outRoot, '_tmp', 'b2ebe-check-' + Date.now());
  fs.mkdirSync(outDir, { recursive: true });
  const checks = [];
  const check = (name, ok, detail) => {
    checks.push({ name, ok: Boolean(ok), detail });
    console.log(`[${ok ? 'PASS' : 'FAIL'}] ${name}${detail === undefined ? '' : ' :: ' + (typeof detail === 'string' ? detail : JSON.stringify(detail)).slice(0, 400)}`);
    return ok;
  };
  createWindow();
  const win = getWindow();
  await new Promise((resolve) => { if (win.webContents.isLoading()) win.webContents.once('did-finish-load', resolve); else resolve(); });
  await new Promise((resolve) => setTimeout(resolve, 1800));
  const shot = async (name) => {
    try { const file = path.join(outDir, name); fs.writeFileSync(file, (await win.webContents.capturePage()).toPNG()); return file; } catch { return ''; }
  };
  const evalJs = (expr) => win.webContents.executeJavaScript(expr, true);
  const readCards = () => evalJs(READ_CARDS);
  const openRolesTab = async () => {
    // 先把项目面板抽屉打开（角色卡网格在抽屉里），否则截图拍到的是 DSH 主画面。
    await evalJs("(() => { const opener = document.querySelector('#team-to-project') || document.querySelector('#btn-team-project') || document.querySelector('#btn-board'); if (opener) opener.click(); return Boolean(opener); })()");
    await new Promise((resolve) => setTimeout(resolve, 500));
    await evalJs("(() => { const b = document.querySelector('[data-tab=\"roles\"]'); if (b) b.click(); return true; })()");
    await new Promise((resolve) => setTimeout(resolve, 2600));
    return evalJs("(() => { const d = document.getElementById('project-drawer'); return Boolean(d && !d.hidden); })()");
  };
  // 强制重新读盘：点旧流程面板的「刷新」（loadLegacyDocs(true) 会清缓存并重拉 docs:presence），
  // 光切 tab 会命中 30 秒缓存，看到的是改名前的存在性。
  const reopenPresence = async () => {
    await evalJs("(() => { const b = document.querySelector('#legacy-refresh') || document.querySelector('#legacy-refresh-2'); if (b) { b.click(); return true; } return false; })()");
    await new Promise((resolve) => setTimeout(resolve, 2200));
    await openRolesTab();
  };

  const drawerOpen = await openRolesTab();
  check('项目面板抽屉已打开（截图能拍到角色卡网格）', drawerOpen === true, drawerOpen);
  const cards = await readCards();
  const greenShot = await shot('roles-all-present.png');
  check('六张角色卡都渲染出来', cards.length === 6, { count: cards.length, roles: cards.map((row) => row.role) });
  const badCards = cards.filter((row) => row.facts['角色卡'] !== '存在' || row.facts['文件索引'] !== '存在');
  check('六角色的「角色卡 / 文件索引」全部=存在（不再误报缺失）', badCards.length === 0, badCards.map((row) => ({ role: row.role, card: row.facts['角色卡'], index: row.facts['文件索引'] })));
  const wrongHint = cards.filter((row) => /文件缺失/.test(String(row.facts['本轮 boot'] || '')));
  check('本轮 boot 提示符合新口径（只允许 已 boot/未 boot；不得出现「文件缺失」或「boot 已过期」）', wrongHint.length === 0, wrongHint.map((row) => ({ role: row.role, boot: row.facts['本轮 boot'] })));
  const expiredHint = cards.filter((row) => /过期|需重做|需要 ?boot/.test(String(row.facts['本轮 boot'] || '')));
  check('取消「过期」提示：不再出现 boot 已过期/需重做', expiredHint.length === 0, expiredHint.map((row) => ({ role: row.role, boot: row.facts['本轮 boot'] })));

  const store = readStore();
  const project = store.projects.find((item) => item.id === store.activeProjectId) || null;
  const projectPath = project ? String(project.path || '') : '';
  const victims = [{ role: '产品设计师', dir: '产品' }, { role: '测试人员', dir: '测试人员' }];
  const pick = victims.find((row) => projectPath && fs.existsSync(path.join(projectPath, row.dir, '角色卡.md'))) || null;
  let renameResult = null;
  let missingShot = '';
  if (!pick) {
    check('找到可临时改名的角色卡（真实项目）', false, '没有可改名的角色卡文件');
  } else {
    const target = path.join(projectPath, pick.dir, '角色卡.md');
    const tmp = target + '.b2ebe-tmp';
    try {
      fs.renameSync(target, tmp);
      await reopenPresence();
      const after = await readCards();
      const row = after.find((item) => item.role === pick.role) || null;
      renameResult = { role: pick.role, card: row && row.facts['角色卡'], boot: row && row.facts['本轮 boot'] };
      check('临时改名后该角色「角色卡」变缺失（真缺失仍报红）', Boolean(row) && row.facts['角色卡'] === '缺失', renameResult);
      check('临时改名后「本轮 boot」提示=文件缺失', Boolean(row) && /文件缺失/.test(String(row.facts['本轮 boot'] || '')), renameResult);
      missingShot = await shot('roles-missing-red.png');
    } finally {
      if (fs.existsSync(tmp)) fs.renameSync(tmp, target);
    }
    await reopenPresence();
    const restored = await readCards();
    const row = restored.find((item) => item.role === pick.role) || null;
    check('还原文件名后该角色回到「角色卡=存在」', Boolean(row) && row.facts['角色卡'] === '存在', { role: pick.role, card: row && row.facts['角色卡'] });
    await shot('roles-restored.png');
  }

  const failed = checks.filter((row) => !row.ok);
  const report = { ok: failed.length === 0, total: checks.length, failed: failed.length, outDir, checks, cards, renameResult, screenshots: { green: greenShot, missing: missingShot } };
  fs.writeFileSync(path.join(outDir, 'b2ebe-check.json'), JSON.stringify(report, null, 2), 'utf8');
  console.log('B2EBE_CHECK ' + JSON.stringify({ ok: report.ok, total: report.total, failed: report.failed, outDir }));
  app.exit(report.ok ? 0 : 1);
}

module.exports = { runB2ebeCheck };
