#!/usr/bin/env node
'use strict';
/**
 * 用例 ⑨：故意失败的运行（AC8「失败运行无条件保留」用）
 * 不改任何状态，只让运行记录 ok=false，供 clean 保留策略断言使用。
 */
const lib = require('./_lib.cjs');

const checks = new lib.Checks();
checks.add('AC8 失败保留：故意失败一次（不改任何状态）', false, { reason: 'simulated-failure', marker: lib.MARKER });
lib.emit({ ok: false, case: '99-fail', category: 'AC8 失败保留', simulated: true }, checks);
