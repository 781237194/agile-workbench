'use strict';
// R-eca0 A：桌面取证 Node 封装——spawn PowerShell 调唯一原生入口 win32-capture.ps1。
// 只读：仅调用 GetDC/BitBlt 类抓屏原语；不产生输入事件、不改变窗口状态。
// 像素编码：原生侧 BitBlt 取像素（24bpp BGR 行）+ 本模块 zlib 写 PNG（AC2 性能要求）。

const { spawn } = require('node:child_process');
const path = require('node:path');
const fs = require('node:fs');
const zlib = require('node:zlib');
const crypto = require('node:crypto');

const PS1 = path.join(__dirname, 'win32-capture.ps1');
const POWERSHELL = process.env.AWB_CAPTURE_POWERSHELL || 'powershell.exe';
const PS_ARGS = ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', PS1];
const DEFAULT_TIMEOUT_MS = 60000;
const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
// PNG 行过滤 + zlib 参数：实测本机 2560x1440 下 level=1 + Z_FILTERED 最快且 <=2MB
const PNG_ZLIB_OPTIONS = { level: 1, strategy: zlib.constants.Z_FILTERED };
const ROWS_PER_FLUSH = 32;

function nowMs() {
  const perf = typeof performance !== 'undefined' ? performance : null;
  if (perf && typeof perf.timeOrigin === 'number') return perf.timeOrigin + perf.now();
  return Number(process.hrtime.bigint()) / 1e6;
}

// AWB_CAPTURE_DEBUG=1 时输出分段耗时（排查性能用，不影响正常输出）
const DEBUG = process.env.AWB_CAPTURE_DEBUG === '1';
function dbg(msg) {
  if (DEBUG) process.stderr.write(`[capture] ${msg}\n`);
}

/** 跑一次 ps1（纯 JSON 进出；请求走 stdin，结果读 stdout 最后一行 JSON）。 */
function runJson(req, { timeoutMs = DEFAULT_TIMEOUT_MS, env } = {}) {
  return new Promise((resolve) => {
    const child = spawn(POWERSHELL, PS_ARGS, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: env ? { ...process.env, ...env } : process.env,
    });
    const out = [];
    let errText = '';
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve({ ok: false, code: 'CAPTURE_TIMEOUT', stdout: Buffer.concat(out).toString('utf8'), stderr: errText, exitCode: null });
    }, timeoutMs);
    child.stdout.on('data', (c) => out.push(c));
    child.stderr.on('data', (c) => { errText += c.toString('utf8'); });
    child.on('error', (e) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, code: 'CAPTURE_UNAVAILABLE', stdout: '', stderr: String(e && e.message), exitCode: null });
    });
    child.on('close', (code) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const raw = Buffer.concat(out).toString('utf8').trim();
      let parsed = null;
      try { parsed = raw ? JSON.parse(raw.split('\n').filter(Boolean).pop()) : null; } catch { parsed = null; }
      if (!parsed) {
        resolve({ ok: false, code: 'CAPTURE_UNAVAILABLE', stdout: raw, stderr: errText, exitCode: code });
        return;
      }
      resolve({ ...parsed, exitCode: code, stderr: errText });
    });
    try {
      child.stdin.write(JSON.stringify(req));
      child.stdin.end();
    } catch { /* stdin closed early */ }
  });
}

/** 探测：虚拟屏尺寸 + 当前前台焦点快照（AC1 取数用）。 */
async function probe() {
  return runJson({ op: 'probe' });
}

/** 焦点快照：GetForegroundWindow + GetGUIThreadInfo 的 hwndFocus/hwndActive。 */
async function focusSnapshot() {
  return runJson({ op: 'focus' });
}

/** 指定窗口（标题片段）的矩形与可见性。 */
async function windowState(title) {
  return runJson({ op: 'windowstate', window: title || '' });
}

/** 引擎就绪探测（不落图）。 */
async function ready() {
  return runJson({ op: 'ready' });
}

function pngChunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length, 0);
  const typeBuf = Buffer.from(type, 'latin1');
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(zlib.crc32(data, zlib.crc32(typeBuf)) >>> 0, 0);
  return Buffer.concat([len, typeBuf, data, crc]);
}

/** 用 PNG 过滤行（RGB，filter=Sub）拼出完整 PNG 文件。 */
function buildPng(w, h, compressed) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr.writeUInt8(8, 8);   // bit depth
  ihdr.writeUInt8(2, 9);   // color type: truecolor RGB
  ihdr.writeUInt8(0, 10);  // compression
  ihdr.writeUInt8(0, 11);  // filter method
  ihdr.writeUInt8(0, 12);  // interlace
  return Buffer.concat([
    PNG_SIGNATURE,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', compressed),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * 抓屏并落 PNG（默认全屏；mode=window 用标题片段；rect=[x,y,w,h] 仅供测量/测试）。
 * 返回 {ok,path,bytes,sha256,ms,warmupMs,w,h,code}；ms = 预热完成→PNG 落盘并算出 sha256。
 */
async function capture({ mode = 'fullscreen', out, window: title = '', rect = null, timeoutMs = DEFAULT_TIMEOUT_MS, env } = {}) {
  if (!out) throw new Error('capture() 需要 out 绝对路径');
  const tStart = nowMs();
  const req = { op: 'capture', format: 'raw', mode, window: title };
  if (Array.isArray(rect) && rect.length === 4) req.rect = rect.map((n) => Number(n));

  return new Promise((resolve) => {
    const child = spawn(POWERSHELL, PS_ARGS, {
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
      env: env ? { ...process.env, ...env } : process.env,
    });

    let header = null;
    let pending = Buffer.alloc(0);
    let stderr = '';
    let deflate = null;
    let finished = false;
    let t0 = 0;
    const compressed = [];
    let received = 0;      // 已消费的原始字节数（不含 pending）
    let rowsDone = 0;
    let outBuf = null;
    let outLen = 0;
    let rowsInBuf = 0;
    let chunkCount = 0;

    const timer = setTimeout(() => {
      if (finished) return;
      finished = true;
      try { child.kill(); } catch { /* ignore */ }
      resolve({ ok: false, code: 'CAPTURE_TIMEOUT', path: '', bytes: 0, sha256: '', ms: 0, warmupMs: 0, w: 0, h: 0 });
    }, timeoutMs);

    const fail = (code) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      try { child.kill(); } catch { /* ignore */ }
      resolve({
        ok: false, code, path: '', bytes: 0, sha256: '',
        ms: header ? Math.max(0, Math.round(nowMs() - t0)) : 0,
        warmupMs: header ? Math.round(t0 - tStart) : 0,
        w: header ? header.w : 0, h: header ? header.h : 0,
      });
    };

    const flushRows = () => {
      if (!outLen || !deflate) return;
      deflate.write(outBuf.subarray(0, outLen));
      outLen = 0;
      rowsInBuf = 0;
    };

    // 一条 24bpp BGR 行 -> PNG 过滤行（filter=1 Sub，RGB 8bit）
    const addRow = (srcOff) => {
      const w = header.w;
      const stride = header.stride;
      outBuf[outLen] = 1;
      let d = outLen + 1;
      let s = srcOff;
      let pr = 0, pg = 0, pb = 0;
      for (let x = 0; x < w; x += 1) {
        const b = pending[s];
        const g = pending[s + 1];
        const r = pending[s + 2];
        s += 3;
        outBuf[d] = r - pr;
        outBuf[d + 1] = g - pg;
        outBuf[d + 2] = b - pb;
        d += 3;
        pr = r; pg = g; pb = b;
      }
      outLen += w * 3 + 1;
      rowsInBuf += 1;
      rowsDone += 1;
      if (rowsInBuf >= ROWS_PER_FLUSH) flushRows();
      void stride;
    };

    const consume = () => {
      if (!header) return;
      const stride = header.stride;
      let off = 0;
      while (pending.length - off >= stride) {
        addRow(off);
        off += stride;
      }
      received += off;
      if (off > 0) {
        pending = off === pending.length ? Buffer.alloc(0) : Buffer.from(pending.subarray(off));
      }
    };

    child.stdout.on('data', (chunk) => {
      if (finished) return;
      chunkCount += 1;
      if (DEBUG && chunkCount <= 3) dbg(`chunk#${chunkCount} ${chunk.length}B at ${(nowMs() - tStart).toFixed(0)}ms`);
      if (!header) {
        pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
        const nl = pending.indexOf(0x0a);
        if (nl < 0) return;
        const rest = pending.subarray(nl + 1);
        let parsed = null;
        try { parsed = JSON.parse(pending.subarray(0, nl).toString('utf8').trim()); } catch { parsed = null; }
        pending = Buffer.alloc(0);
        if (!parsed || !parsed.ok) {
          fail((parsed && parsed.code) || 'CAPTURE_UNAVAILABLE');
          return;
        }
        if (!parsed.w || !parsed.h || !parsed.stride) { fail('CAPTURE_UNAVAILABLE'); return; }
        header = parsed;
        t0 = nowMs();
        outBuf = Buffer.alloc((header.w * 3 + 1) * ROWS_PER_FLUSH);
        deflate = zlib.createDeflate(PNG_ZLIB_OPTIONS);
        deflate.on('data', (c) => compressed.push(c));
        deflate.on('error', () => fail('CAPTURE_ENCODE_FAILED'));
        dbg(`header ${header.w}x${header.h} stride=${header.stride} at ${(t0 - tStart).toFixed(0)}ms`);
        if (rest.length) { pending = rest; consume(); }
        return;
      }
      pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
      consume();
    });
    child.stderr.on('data', (c) => { stderr += c.toString('utf8'); });
    child.on('error', () => fail('CAPTURE_UNAVAILABLE'));
    child.on('close', (code) => {
      if (finished) return;
      if (!header || !deflate) { fail('CAPTURE_UNAVAILABLE'); return; }
      dbg(`close code=${code} chunks=${chunkCount} received=${received} rows=${rowsDone} at ${(nowMs() - tStart).toFixed(0)}ms (t0+${(nowMs() - t0).toFixed(0)}ms)`);
      const expectBytes = header.stride * header.h;
      if (received !== expectBytes || rowsDone !== header.h) {
        const m = /CAPTURE_[A-Z_]+/.exec(stderr || '');
        fail(m ? m[0] : 'CAPTURE_ENCODE_FAILED');
        return;
      }
      flushRows();
      dbg(`flush done, ending deflate at t0+${(nowMs() - t0).toFixed(0)}ms`);
      deflate.end();
      deflate.on('end', () => {
        if (finished) return;
        dbg(`deflate end at t0+${(nowMs() - t0).toFixed(0)}ms, compressed=${compressed.reduce((a, c) => a + c.length, 0)}B`);
        try {
          const png = buildPng(header.w, header.h, Buffer.concat(compressed));
          fs.writeFileSync(out, png);
          const sha256 = crypto.createHash('sha256').update(png).digest('hex');
          const end = nowMs();
          finished = true;
          clearTimeout(timer);
          resolve({
            ok: true,
            code: 'OK',
            path: out,
            bytes: png.length,
            sha256,
            ms: Math.max(0, Math.round(end - t0)),
            warmupMs: Math.round(t0 - tStart),
            w: header.w,
            h: header.h,
            title: header.title || '',
          });
        } catch (e) {
          fail(/ENOSPC/.test(String(e && e.message)) ? 'CAPTURE_DISK_FULL' : 'CAPTURE_ENCODE_FAILED');
        }
      });
      void code;
    });

    try {
      child.stdin.write(JSON.stringify(req));
      child.stdin.end();
    } catch { /* stdin closed early */ }
  });
}

module.exports = { capture, probe, focusSnapshot, windowState, ready, buildPng, PS1, PNG_ZLIB_OPTIONS };
