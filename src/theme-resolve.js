'use strict';
/**
 * theme-resolve.js —— R-fe90 主题解析（Node 侧入口 / 第 1 块遗留入口）
 *
 * 自第 2 块（入口与持久化）起，主题清单与解析逻辑的**唯一来源**是
 * `src/renderer/theme-manifest.js`（F-2 要求：渲染层可直接用 script 加载、node 也能 import）。
 * 本文件保留为**薄别名**，供既有脚本 `scripts/test-theme-resolve.cjs` 与任何 Node 侧调用继续使用：
 *
 *   require('./src/theme-resolve.js') === require('./src/renderer/theme-manifest.js')
 *
 * 逻辑只有一份，不复制算法；两入口导出逐字段相等（见 scripts/test-theme-manifest.cjs）。
 */
module.exports = require('./renderer/theme-manifest.js');
