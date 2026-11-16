# R-eca0 F1/AC1/AC7：唯一原生入口——Win32 GDI 抓屏。
# 只读：仅 GetDC/BitBlt 取像素；不产生任何输入事件、不改变窗口状态。
# 参数（stdin JSON）：{op:'probe'|'focus'|'windowstate'|'ready'|'capture', mode:'fullscreen'|'window',
#   out:'D:\\...png', window:'标题片段', format:'raw'|'png', rect:[x,y,w,h]}
# 输出：stdout 恰好一行 JSON（format=raw 时为头部 JSON 一行 + 原始 BGR 行字节流，PNG 由 Node 侧编码）。
param([string]$ArgsJson)

$ErrorActionPreference = 'Stop'
$bootSw = [System.Diagnostics.Stopwatch]::StartNew()
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$src = @'
using System;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;

public static class AwbCaptureNative {
  // ---- user32 ----------------------------------------------------------
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO info);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);

  // ---- gdi32 -----------------------------------------------------------
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int w, int h);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateDIBSection(IntPtr hdc, ref BITMAPINFO pbmi, uint usage, out IntPtr ppvBits, IntPtr hSection, uint offset);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, int rop);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);

  // ---- gdiplus (PNG encoder, legacy format=png path) --------------------
  [DllImport("gdiplus.dll")] public static extern int GdiplusStartup(out IntPtr token, ref GdiplusStartupInput input, out IntPtr output);
  [DllImport("gdiplus.dll")] public static extern void GdiplusShutdown(IntPtr token);
  [DllImport("gdiplus.dll")] public static extern int GdipCreateBitmapFromHBITMAP(IntPtr hbm, IntPtr hpal, out IntPtr bitmap);
  [DllImport("gdiplus.dll")] public static extern int GdipSaveImageToFile(IntPtr image, [MarshalAs(UnmanagedType.LPWStr)] string filename, ref Guid clsidEncoder, IntPtr encoderParams);
  [DllImport("gdiplus.dll")] public static extern int GdipDisposeImage(IntPtr image);

  [StructLayout(LayoutKind.Sequential)] public struct RECT { public int Left, Top, Right, Bottom; }
  [StructLayout(LayoutKind.Sequential)] public struct GUITHREADINFO {
    public int cbSize; public int flags;
    public IntPtr hwndActive, hwndFocus, hwndCapture, hwndMenuOwner, hwndMoveSize, hwndCaret;
    public RECT rcCaret;
  }
  [StructLayout(LayoutKind.Sequential)] public struct GdiplusStartupInput {
    public int GdiplusVersion; public IntPtr DebugEventCallback; public int SuppressBackgroundThread; public int SuppressExternalCodecs;
  }
  [StructLayout(LayoutKind.Sequential)] public struct BITMAPINFOHEADER {
    public int biSize; public int biWidth; public int biHeight;
    public short biPlanes; public short biBitCount; public int biCompression; public int biSizeImage;
    public int biXPelsPerMeter; public int biYPelsPerMeter; public int biClrUsed; public int biClrImportant;
  }
  [StructLayout(LayoutKind.Sequential)] public struct BITMAPINFO {
    public BITMAPINFOHEADER bmiHeader;
    public uint c0; public uint c1; public uint c2;
  }

  const int SRCCOPY = 0x00CC0020;
  const int CAPTUREBLT = 0x40000000;
  const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;
  const int DIB_RGB_COLORS = 0;
  static readonly Guid PNG_ENCODER = new Guid("557CF406-1A04-11D3-9A73-0000F81EF32E");

  public static string Title(IntPtr h) {
    var sb = new StringBuilder(1024);
    GetWindowTextW(h, sb, sb.Capacity);
    return sb.ToString();
  }

  static string Esc(string s) {
    return (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ");
  }

  // AC1: focus snapshot via GetGUIThreadInfo (cross-process GetFocus is always NULL)
  public static string FocusSnapshot() {
    IntPtr fg = GetForegroundWindow();
    uint tid = fg == IntPtr.Zero ? 0 : GetWindowThreadProcessId(fg, IntPtr.Zero);
    IntPtr hwndFocus = IntPtr.Zero, hwndActive = IntPtr.Zero;
    if (tid != 0) {
      var gi = new GUITHREADINFO();
      gi.cbSize = Marshal.SizeOf(typeof(GUITHREADINFO));
      if (GetGUIThreadInfo(tid, ref gi)) { hwndFocus = gi.hwndFocus; hwndActive = gi.hwndActive; }
    }
    return "{\"fg\":" + fg.ToInt64() + ",\"title\":\"" + Esc(Title(fg)) + "\",\"focus\":" + hwndFocus.ToInt64() + ",\"active\":" + hwndActive.ToInt64() + "}";
  }

  public static string ScreenInfo() {
    int x = GetSystemMetrics(SM_XVIRTUALSCREEN), y = GetSystemMetrics(SM_YVIRTUALSCREEN);
    int w = GetSystemMetrics(SM_CXVIRTUALSCREEN), h = GetSystemMetrics(SM_CYVIRTUALSCREEN);
    return "{\"x\":" + x + ",\"y\":" + y + ",\"w\":" + w + ",\"h\":" + h + "}";
  }

  // AC1(3): window rect + visibility, sampled before and after capture to prove unchanged
  public static string WindowState(string titleFragment) {
    IntPtr h = FindByTitle(titleFragment);
    if (h == IntPtr.Zero) return "null";
    RECT r; GetWindowRect(h, out r);
    return "{\"hwnd\":" + h.ToInt64() + ",\"title\":\"" + Esc(Title(h)) + "\",\"rect\":[" + r.Left + "," + r.Top + "," + r.Right + "," + r.Bottom + "],\"visible\":" + (IsWindowVisible(h) ? "true" : "false") + "}";
  }

  public static IntPtr FindByTitle(string frag) {    if (String.IsNullOrEmpty(frag)) return IntPtr.Zero;
    IntPtr cur = GetForegroundWindow();
    if (cur != IntPtr.Zero && Title(cur).IndexOf(frag, StringComparison.OrdinalIgnoreCase) >= 0) return cur;
    foreach (var p in System.Diagnostics.Process.GetProcesses()) {
      try {
        if (p.MainWindowHandle != IntPtr.Zero && !String.IsNullOrEmpty(p.MainWindowTitle)
            && p.MainWindowTitle.IndexOf(frag, StringComparison.OrdinalIgnoreCase) >= 0) return p.MainWindowHandle;
      } catch { }
    }
    return IntPtr.Zero;
  }

  // 已定位窗口的标题（找不到返回空串），用于审计 window 字段
  public static string TitleOf(string frag) {
    IntPtr h = FindByTitle(frag);
    return h == IntPtr.Zero ? "" : Esc(Title(h));
  }

  static BITMAPINFO MakeInfo(int w, int h, short bits) {
    BITMAPINFO bi = new BITMAPINFO();
    bi.bmiHeader.biSize = Marshal.SizeOf(typeof(BITMAPINFOHEADER));
    bi.bmiHeader.biWidth = w;
    bi.bmiHeader.biHeight = -h; // negative: top-down rows
    bi.bmiHeader.biPlanes = 1;
    bi.bmiHeader.biBitCount = bits;
    bi.bmiHeader.biCompression = 0;
    return bi;
  }

  public static int StrideOf(int w) {
    return (w * 3 + 3) & ~3; // 24bpp rows are DWORD aligned
  }

  // Resolve capture rectangle. mode=window uses title fragment; otherwise virtual screen.
  public static bool TryRect(string mode, string frag, out int x, out int y, out int w, out int h, out string err) {
    err = null; x = 0; y = 0; w = 0; h = 0;
    RECT r = new RECT();
    if (mode == "window") {
      IntPtr win = FindByTitle(frag);
      if (win == IntPtr.Zero) { err = "CAPTURE_WINDOW_NOT_FOUND"; return false; }
      if (!GetWindowRect(win, out r)) { err = "CAPTURE_WINDOW_NOT_FOUND"; return false; }
    } else {
      r.Left = GetSystemMetrics(SM_XVIRTUALSCREEN);
      r.Top = GetSystemMetrics(SM_YVIRTUALSCREEN);
      r.Right = r.Left + GetSystemMetrics(SM_CXVIRTUALSCREEN);
      r.Bottom = r.Top + GetSystemMetrics(SM_CYVIRTUALSCREEN);
    }
    x = r.Left; y = r.Top; w = r.Right - r.Left; h = r.Bottom - r.Top;
    if (w <= 0 || h <= 0) { err = "CAPTURE_WINDOW_NOT_FOUND"; return false; }
    return true;
  }

  // Warmup: prove the GDI 24bpp path is usable with a 1x1 grab (nothing is kept).
  public static bool ProbeReady(out string err) {
    err = null;
    IntPtr screen = GetDC(IntPtr.Zero);
    if (screen == IntPtr.Zero) { err = "CAPTURE_DC_FAILED"; return false; }
    IntPtr mem = IntPtr.Zero, bmp = IntPtr.Zero, old = IntPtr.Zero;
    try {
      mem = CreateCompatibleDC(screen);
      BITMAPINFO bi = MakeInfo(1, 1, 24);
      IntPtr bits;
      bmp = CreateDIBSection(screen, ref bi, DIB_RGB_COLORS, out bits, IntPtr.Zero, 0);
      if (mem == IntPtr.Zero || bmp == IntPtr.Zero || bits == IntPtr.Zero) { err = "CAPTURE_DC_FAILED"; return false; }
      old = SelectObject(mem, bmp);
      if (!BitBlt(mem, 0, 0, 1, 1, screen, 0, 0, SRCCOPY)) { err = "CAPTURE_DC_FAILED"; return false; }
      return true;
    } finally {
      if (old != IntPtr.Zero && mem != IntPtr.Zero) SelectObject(mem, old);
      if (bmp != IntPtr.Zero) DeleteObject(bmp);
      if (mem != IntPtr.Zero) DeleteDC(mem);
      ReleaseDC(IntPtr.Zero, screen);
    }
  }

  // Grab pixels with BitBlt into a 24bpp DIB and stream raw BGR rows to output.
  // Stride = StrideOf(w); row order is top-down; rows may carry up to 3 pad bytes.
  public static bool CaptureRaw(int x, int y, int w, int h, Stream output, out string err) {
    err = null;
    IntPtr screen = GetDC(IntPtr.Zero);
    if (screen == IntPtr.Zero) { err = "CAPTURE_DC_FAILED"; return false; }
    IntPtr mem = IntPtr.Zero, bmp = IntPtr.Zero, old = IntPtr.Zero;
    try {
      mem = CreateCompatibleDC(screen);
      BITMAPINFO bi = MakeInfo(w, h, 24);
      IntPtr bits;
      bmp = CreateDIBSection(screen, ref bi, DIB_RGB_COLORS, out bits, IntPtr.Zero, 0);
      if (mem == IntPtr.Zero || bmp == IntPtr.Zero || bits == IntPtr.Zero) { err = "CAPTURE_DC_FAILED"; return false; }
      old = SelectObject(mem, bmp);
      if (!BitBlt(mem, 0, 0, w, h, screen, x, y, SRCCOPY | CAPTUREBLT)) { err = "CAPTURE_DC_FAILED"; return false; }
      int stride = StrideOf(w);
      int size = stride * h;
      byte[] buf = new byte[size];
      Marshal.Copy(bits, buf, 0, size);
      output.Write(buf, 0, size);
      output.Flush();
      return true;
    } finally {
      if (old != IntPtr.Zero && mem != IntPtr.Zero) SelectObject(mem, old);
      if (bmp != IntPtr.Zero) DeleteObject(bmp);
      if (mem != IntPtr.Zero) DeleteDC(mem);
      ReleaseDC(IntPtr.Zero, screen);
    }
  }

  /** Legacy PNG encoder (GDI+) kept for format=png. */
  public static string Capture(string mode, string titleFragment, string outPath, out string err) {
    err = null;
    int x, y, w, h;
    if (!TryRect(mode, titleFragment, out x, out y, out w, out h, out err)) return null;

    IntPtr screen = GetDC(IntPtr.Zero);
    if (screen == IntPtr.Zero) { err = "CAPTURE_DC_FAILED"; return null; }
    IntPtr mem = IntPtr.Zero, bmp = IntPtr.Zero, old = IntPtr.Zero;
    IntPtr gdip = IntPtr.Zero, gdipImage = IntPtr.Zero;
    try {
      mem = CreateCompatibleDC(screen);
      bmp = CreateCompatibleBitmap(screen, w, h);
      if (mem == IntPtr.Zero || bmp == IntPtr.Zero) { err = "CAPTURE_DC_FAILED"; return null; }
      old = SelectObject(mem, bmp);
      if (!BitBlt(mem, 0, 0, w, h, screen, x, y, SRCCOPY | CAPTUREBLT)) { err = "CAPTURE_DC_FAILED"; return null; }

      var gsi = new GdiplusStartupInput(); gsi.GdiplusVersion = 1;
      IntPtr gOut;
      if (GdiplusStartup(out gdip, ref gsi, out gOut) != 0) { err = "CAPTURE_ENCODE_FAILED"; return null; }
      if (GdipCreateBitmapFromHBITMAP(bmp, IntPtr.Zero, out gdipImage) != 0) { err = "CAPTURE_ENCODE_FAILED"; return null; }
      Guid enc = PNG_ENCODER;
      int st = GdipSaveImageToFile(gdipImage, outPath, ref enc, IntPtr.Zero);
      if (st != 0) { err = st == 3 ? "CAPTURE_DISK_FULL" : "CAPTURE_ENCODE_FAILED"; return null; }
      return "{\"w\":" + w + ",\"h\":" + h + "}";
    } finally {
      if (gdipImage != IntPtr.Zero) GdipDisposeImage(gdipImage);
      if (gdip != IntPtr.Zero) GdiplusShutdown(gdip);
      if (old != IntPtr.Zero && mem != IntPtr.Zero) SelectObject(mem, old);
      if (bmp != IntPtr.Zero) DeleteObject(bmp);
      if (mem != IntPtr.Zero) DeleteDC(mem);
      ReleaseDC(IntPtr.Zero, screen);
    }
  }
}
'@

# ---- compile native helper (warmup #1: type definition) -------------------
$compileOk = $true
$compileErr = ''
try {
  if (-not ('AwbCaptureNative' -as [type])) {
    Add-Type -TypeDefinition $src -Language CSharp -ReferencedAssemblies System.Drawing | Out-Null
  }
} catch {
  $compileOk = $false
  $compileErr = $_.Exception.Message
  [Console]::Error.WriteLine('compile failed: ' + $compileErr)
}

# ---- read request ---------------------------------------------------------
$req = $null
if ($ArgsJson) { $req = $ArgsJson | ConvertFrom-Json }
else {
  $stdin = [Console]::In.ReadToEnd()
  if ($stdin) { $req = $stdin | ConvertFrom-Json }
}
if (-not $req) { $req = [pscustomobject]@{ op = 'probe' } }

$op = if ($req.op) { [string]$req.op } else { 'capture' }
$stdout = [Console]::OpenStandardOutput()

function Write-Line([string]$text) {
  $bytes = [System.Text.Encoding]::ASCII.GetBytes($text + "`n")
  $stdout.Write($bytes, 0, $bytes.Length)
  $stdout.Flush()
}

if ($op -eq 'probe') {
  if (-not $compileOk) { Write-Output '{"ok":false,"code":"CAPTURE_NOT_READY"}'; exit 1 }
  $info = [AwbCaptureNative]::ScreenInfo()
  $fg = [AwbCaptureNative]::FocusSnapshot()
  Write-Output ("{""ok"":true,""screen"":" + $info + ",""focus"":" + $fg + "}")
  exit 0
}

if ($op -eq 'focus') {
  if (-not $compileOk) { Write-Output '{"ok":false,"code":"CAPTURE_NOT_READY"}'; exit 1 }
  Write-Output ([AwbCaptureNative]::FocusSnapshot())
  exit 0
}

if ($op -eq 'windowstate') {
  if (-not $compileOk) { Write-Output '{"ok":false,"code":"CAPTURE_NOT_READY"}'; exit 1 }
  $ws = [AwbCaptureNative]::WindowState([string]$req.window)
  if ($ws -eq 'null') { Write-Output '{"ok":false,"code":"CAPTURE_WINDOW_NOT_FOUND"}'; exit 1 }
  Write-Output ("{""ok"":true,""state"":" + $ws + "}")
  exit 0
}

if ($op -eq 'ready') {
  # engine readiness probe (nothing is captured / kept)
  if (-not $compileOk) { Write-Output '{"ok":false,"ready":false,"code":"CAPTURE_NOT_READY"}'; exit 1 }
  $err = $null
  if (-not [AwbCaptureNative]::ProbeReady([ref]$err)) {
    Write-Output ("{""ok"":false,""ready"":false,""code"":""" + $err + """}")
    exit 1
  }
  Write-Output '{"ok":true,"ready":true}'
  exit 0
}

# ---- capture --------------------------------------------------------------
$format = if ($req.format) { [string]$req.format } else { 'png' }

if ($format -eq 'raw') {
  # AC2: warmup first (compile + 1x1 GDI probe), then emit the header that starts the caller's clock.
  $warmupOk = $compileOk
  $warmupErr = 'CAPTURE_NOT_READY'
  if ($env:AWB_CAPTURE_FORCE_NOT_READY -eq '1') { $warmupOk = $false }
  if ($warmupOk) {
    $probeErr = $null
    if (-not [AwbCaptureNative]::ProbeReady([ref]$probeErr)) { $warmupOk = $false; $warmupErr = $probeErr }
  }
  $warmupMs = [int]$bootSw.Elapsed.TotalMilliseconds
  if (-not $warmupOk) {
    Write-Line ("{""ok"":false,""code"":""" + $warmupErr + """,""warmupMs"":" + $warmupMs + "}")
    exit 1
  }

  # geometry first (no pixels touched yet), so the header can be emitted before BitBlt
  if ($req.rect) {
    $capX = [int]$req.rect[0]; $capY = [int]$req.rect[1]; $capW = [int]$req.rect[2]; $capH = [int]$req.rect[3]
    if ($capW -le 0 -or $capH -le 0) {
      Write-Line ("{""ok"":false,""code"":""CAPTURE_WINDOW_NOT_FOUND"",""warmupMs"":" + $warmupMs + "}")
      exit 1
    }
  } else {
    $capX = 0; $capY = 0; $capW = 0; $capH = 0
    $rectErr = $null
    if (-not [AwbCaptureNative]::TryRect([string]$req.mode, [string]$req.window, [ref]$capX, [ref]$capY, [ref]$capW, [ref]$capH, [ref]$rectErr)) {
      Write-Line ("{""ok"":false,""code"":""" + $rectErr + """,""warmupMs"":" + $warmupMs + "}")
      exit 1
    }
  }

  # 审计里的 window 字段：全屏=fullscreen、窗口=实际窗口标题、rect=rect（仅测量用）
  $capTitle = 'fullscreen'
  if ($req.rect) { $capTitle = 'rect' }
  elseif ([string]$req.mode -eq 'window') {
    $capTitle = [AwbCaptureNative]::TitleOf([string]$req.window)
    if (-not $capTitle) { $capTitle = 'window' }
  }

  Write-Line ("{""ok"":true,""w"":" + $capW + ",""h"":" + $capH + ",""stride"":" + ([AwbCaptureNative]::StrideOf($capW)) + ",""bpp"":24,""title"":""" + $capTitle + """,""warmupMs"":" + $warmupMs + "}")

  $capErr = $null
  if (-not [AwbCaptureNative]::CaptureRaw($capX, $capY, $capW, $capH, $stdout, [ref]$capErr)) {
    [Console]::Error.WriteLine($capErr)
    exit 1
  }
  exit 0
}

# legacy path: GDI+ PNG encoder
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$err = $null
$res = [AwbCaptureNative]::Capture([string]$req.mode, [string]$req.window, [string]$req.out, [ref]$err)
$sw.Stop()
if (-not $res) {
  Write-Output ("{""ok"":false,""code"":""" + $err + """}")
  exit 1
}
Write-Output ("{""ok"":true,""geom"":" + $res + ",""ms"":" + [int]$sw.Elapsed.TotalMilliseconds + "}")
exit 0
