# 证据 · R-c72a 批2（大列表虚拟化 + 沙盘采帧）

> 任务 `T-20261116-140908-a0d7` ｜ 需求 `R-20261116-133048-c72a` ｜ 采证时间 2026-11-16 20:20–20:40（Asia/Shanghai）
> 全部数字为**本机实跑**，不含转述；隔离方式＝`AWB_DATA_DIR` + `TEAM_ROOT` 双隔离（铁律二·1）。

## 一、交付物

| # | 文件 | 作用 |
|---|---|---|
| ① | `scripts/fixture-pool-1200.cjs` | 沙盘播种 1200 行需求池（`requirements` 是**对象 map**，键＝完整需求 id `R-20261116-120000-0001…1200`，字段 id/status/title/ownerReview/createdAt） |
| ② | `scripts/fixture-two-projects.cjs` | 沙盘建两个项目（A/B 各 50 行），供 AC2「切项目」采样 |
| ③ | `scripts/lib/c72a-sandbox.cjs` | 上述两夹具共用的播种器（只写 `--base` 指定目录；绝不动真实 `workbench.json` 与 `团队/状态`） |
| ④ | `src/renderer/app.js` | 池需求列表虚拟化：`poolApplyReqVisible / poolVirtualPaint / poolReqRows / poolRowHeightPx / renderPoolReqList`；`renderPool` 与 `applyPoolFilters` 接入口；容器写 `data-row-height="36"`、`data-virtual` |
| ⑤ | `src/renderer/style.css` | `.pool-list[data-row-height] .pool-row { height: var(--pool-row-h,36px) }` + `.pool-virtual-gap` |
| ⑥ | `scripts/ui-budget-scroll.cjs` | 真窗口采帧（隔离数据根 + CDP）：10 步 × 120px、步间等一个 rAF，rAF 链逐帧记间隔，输出 JSON |
| ⑦ | `scroll-frame-batch2.json` | ⑥ 的采帧原始输出（本次收口那次） |

## 二、AC4 采帧结果（10 步 × 120px；帧间隔口径＝rAF 链逐帧 `performance.now()` 差值）

| # | p95(ms) | max(ms) | 掉帧率(>25ms) | DOM 行数 | 判定 |
|---|---|---|---|---|---|
| 1 | 11.2 | 11.2 | 0% | 42 | OK |
| 2 | **161.1** | 161.1 | **53.85%** | 42 | **BUDGET_EXCEEDED**（离群，见下） |
| 3 | 11.2 | 11.2 | 0% | 42 | OK |
| 4 | 16.7 | 16.7 | 0% | 42 | OK |
| 5 | 11.1 | 11.1 | 0% | 42 | OK |
| 6 | 11.2 | 11.2 | 0% | 42 | OK |
| 7 | 17.0 | 17.0 | 0% | 42 | OK |
| 8（收口） | 16.7 | 16.7 | 0% | 42 | OK |

- 8 次跑：**7 次 OK、1 次离群**（第 2 次）。离群那次紧跟在上一轮沙盘实例之后立刻起跑，13 帧里 7 帧 >25ms、最大 161.1ms——是**整段窗口被拖**（机器忙），不是某一次滚动变慢；随后连跑 4 次全绿（含同样无间隔的背靠背起跑），故判为环境噪声，但**如实记录不作删除**。
- 帧列表示例（第 5 次，单位 ms）：`4.4,5.6,5.6,5.5,5.5,5.6,5.6,5.6,5.5,11.1,5.5,5.6,5.5`。
- 空闲基线（不滚动，15 帧）：p95 **5.6ms**、掉帧 0% → 页面本底帧间隔远低于 20ms 预算，滚动开销是真增量。

## 三、功能正确性抽查（不是只看帧）

`scroll-frame-batch2.json → verify`：

- 滚前（scrollTop=1200）：首渲染行 `R-20261116-120000-0024`、末渲染行 `…-0065`、窗口 `{first:23,last:65,total:1200,rowH:36}`
- 滚到底（scrollTop=42460）：末渲染行 `R-20261116-120000-1200`（＝全集最后一行）
- 期望首行按 `max(0, floor(scrollTop/rowH) − 10) + 1` 复算 = `…-0024` → **一致**
- `rows=42` ≤ 60（AC4 上限）；`scrollHeight=43212 ≈ 1200×36 + padding`

## 四、AC7 回归（一条既有断言未改）

| 脚本 | 结果 |
|---|---|
| `node scripts/test-renderer-load.cjs` | 7/7 PASS（16 个脚本合并编译，无「已声明」类 SyntaxError） |
| `node scripts/run-electron.cjs . --layout-check` | `LAYOUT_OK`，1280/1680/2560 × 90/100/150% 九组全绿（含 themeNotInTitlebar / themeInMoreMenu / float* 七项） |
| `node scripts/test-theme-manifest.cjs` | 19/19 PASS |
| `node scripts/test-theme-resolve.cjs` | 21/21 PASS |
| `node scripts/test-owner-copy.cjs` | `OWNER_COPY_OK` |
| `node scripts/test-ui-perf-core.cjs` | 11/11 PASS（批1 探针未动） |

## 五、过程中真踩到的两个坑（已修）

1. **`poolVirtualPaint` 每帧无谓写 CSS 变量**：`el.style.setProperty('--pool-row-h', …)` 每帧都写，即使值没变——浏览器每次都要重算样式，滚动帧里是纯开销。修法：先读 `getPropertyValue` 比对，只在真变化时写。修前 p95 27.9ms / 掉帧 23%，修后 11–17ms / 0%。
2. **`fixture` 采帧脚本会挂住**：`new WebSocket(...)` 的 open 等待没有超时，遇到上一个实例的残留 target 会永不 resolve（本轮真挂了一次 10 分钟）。修法：open 加 15s 超时 + `--hard-timeout-ms` 兜底 + `spawnedChild` 全局引用确保异常时也能杀沙盘实例。

## 六、重跑方法

```powershell
node scripts/fixture-pool-1200.cjs --json          # 只播种，看落点
node scripts/ui-budget-scroll.cjs                   # 采帧 + 判定 + 写 scroll-frame-batch2.json
node scripts/ui-budget-scroll.cjs --steps 0 --out _tmp/idle.json   # 空闲基线
node scripts/fixture-two-projects.cjs               # AC2 夹具（两项目各 50 行）
```

- 退出码：0＝OK；1＝BUDGET_EXCEEDED / VIRTUAL_RANGE_WRONG；2＝异常；3＝硬超时。
- 沙盘目录 `_tmp/c72a-batch2/{pool-1200,two-projects}`，可随时删；不碰真实 `data/userdata/workbench.json` 与 `团队/状态`。

## 七、注记（不阻断）

- PM 裁定④「`data-decision-ready` 按测试 A 案：0=渲染中 / 1=渲染完成（含空态）/ 未渲染=null，**不改代码**」——本批**未触碰**该锚点，`git diff` 可证。
- 批2 未做 AC1/AC2/AC3 的 30 次采样（PM 本轮只派 ①–④）；`fixture-two-projects` 已备好，等派单。