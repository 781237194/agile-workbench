#!/usr/bin/env node
'use strict';
/**
 * 沙盘用例公共库（R-7841 · scripts/sandbox/cases/*.cjs 共用）
 * 只做三件事：调 team.mjs、读沙盘 JSON、把结论打成一行 JSON 给 run.cjs 采集。
 * 严禁读写真实根：所有路径都从 process.env（run.cjs 注入）派生。
 */
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..', '..', '..');
const TEAM_CLI = path.join(ROOT, '团队', '工具', 'team.mjs');
const PROJECT = String(process.env.SANDBOX_PROJECT || '工作台改造修复');
const SANDBOX_ROOT = String(process.env.SANDBOX_ROOT || '');
const MARKER = String(process.env.SANDBOX_MARKER || '');
const MESSAGE_MARKER = String(process.env.SANDBOX_MESSAGE_MARKER || '');

if (!SANDBOX_ROOT) {
  console.error('[SANDBOX_CASE_NO_ROOT] 本用例只能由 scripts/sandbox/run.cjs 启动（缺 SANDBOX_ROOT）');
  process.exit(2);
}

function team(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [TEAM_CLI, ...args], {
    cwd: ROOT,
    env: { ...process.env, ...extraEnv },
    encoding: 'utf8',
    windowsHide: true,
    maxBuffer: 16 * 1024 * 1024,
  });
  const stdout = String(r.stdout || '');
  const stderr = String(r.stderr || '');
  let json = null;
  const text = stdout.trim();
  const lines = text.split(/\r?\n/);
  for (const candidate of [lines[lines.length - 1], text]) {
    try { json = JSON.parse(candidate); break; } catch { /* next */ }
  }
  return { status: r.status === null ? 1 : r.status, stdout, stderr, json };
}

function teamJson(args, extraEnv = {}) {
  const r = team([...args, '--json'], extraEnv);
  return r.json || { ok: false, code: 'NO_JSON', status: r.status, stderr: r.stderr.trim().split(/\r?\n/).slice(-3).join(' | ') };
}

function boot(role) {
  const doc = teamJson(['boot', '--role', role, '--project', PROJECT]);
  return { ok: Boolean(doc && doc.ok && doc.token), token: String((doc && doc.token) || ''), rulesHash: String((doc && doc.rulesHash) || ''), doc };
}

function sandboxPath(...parts) {
  return path.join(SANDBOX_ROOT, ...parts);
}

function readJsonSandbox(...parts) {
  try { return JSON.parse(fs.readFileSync(sandboxPath(...parts), 'utf8').replace(/^\uFEFF/, '')); } catch { return null; }
}

function listFiles(dir) {
  try { return fs.readdirSync(dir); } catch { return []; }
}

class Checks {
  constructor() { this.rows = []; }
  add(name, ok, detail) { this.rows.push({ name, ok: Boolean(ok), detail: detail === undefined ? null : detail }); return ok; }
  get ok() { return this.rows.every((row) => row.ok); }
  get failed() { return this.rows.filter((row) => !row.ok); }
}

function emit(payload, checks) {
  const out = { ...payload, project: PROJECT, marker: MARKER, at: new Date().toISOString() };
  if (checks && Array.isArray(checks.rows)) {
    for (const row of checks.rows) console.log((row.ok ? 'PASS ' : 'FAIL ') + row.name + (row.detail === null ? '' : ' · ' + JSON.stringify(row.detail).slice(0, 240)));
    out.checks = checks.rows;
  }
  console.log(JSON.stringify(out));
  process.exit(out.ok ? 0 : 1);
}

module.exports = { ROOT, TEAM_CLI, PROJECT, SANDBOX_ROOT, MARKER, MESSAGE_MARKER, team, teamJson, boot, sandboxPath, readJsonSandbox, listFiles, Checks, emit };
