# R-eca0 F1/AC1/AC7：唯一原生入口——Win32 GDI 抓屏 + GDI+ PNG 编码。
# 只读：仅 GetDC/BitBlt 取像素、GDI+ 落盘 PNG；不产生任何输入事件、不改变窗口状态。
# 参数（stdin JSON 或 -Args)：{mode:'fullscreen'|'window', out:'D:\\...png', window:'标题片段', op:'capture'|'probe'}
# 输出：stdout 恰好一行 JSON。
param([string]$Args)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

$src = @'
using System;
using System.Runtime.InteropServices;
using System.Text;

public static class AwbCaptureNative {
  // ── user32 ────────────────────────────────────────────────
  [DllImport("user32.dll")] public static extern IntPtr GetDC(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern int ReleaseDC(IntPtr hWnd, IntPtr hDC);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern int GetWindowTextW(IntPtr hWnd, StringBuilder text, int count);
  [DllImport("user32.dll")] public static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);
  [DllImport("user32.dll")] public static extern bool IsWindowVisible(IntPtr hWnd);
  [DllImport("user32.dll")] public static extern bool GetGUIThreadInfo(uint idThread, ref GUITHREADINFO info);
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hWnd, IntPtr pid);
  [DllImport("user32.dll")] public static extern int GetSystemMetrics(int index);

  // ── gdi32 ─────────────────────────────────────────────────
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleDC(IntPtr hdc);
  [DllImport("gdi32.dll")] public static extern IntPtr CreateCompatibleBitmap(IntPtr hdc, int w, int h);
  [DllImport("gdi32.dll")] public static extern IntPtr SelectObject(IntPtr hdc, IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool BitBlt(IntPtr dst, int x, int y, int w, int h, IntPtr src, int sx, int sy, int rop);
  [DllImport("gdi32.dll")] public static extern bool DeleteObject(IntPtr obj);
  [DllImport("gdi32.dll")] public static extern bool DeleteDC(IntPtr hdc);

  // ── gdiplus（PNG 编码） ───────────────────────────────────
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

  const int SRCCOPY = 0x00CC0020;
  const int CAPTUREBLT = 0x40000000;
  const int SM_XVIRTUALSCREEN = 76, SM_YVIRTUALSCREEN = 77, SM_CXVIRTUALSCREEN = 78, SM_CYVIRTUALSCREEN = 79;
  static readonly Guid PNG_ENCODER = new Guid("557CF406-1A04-11D3-9A73-0000F81EF32E");

  public static string Title(IntPtr h) {
    var sb = new StringBuilder(1024);
    GetWindowTextW(h, sb, sb.Capacity);
    return sb.ToString();
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

  static string Esc(string s) {
    return (s ?? "").Replace("\\", "\\\\").Replace("\"", "\\\"").Replace("\r", " ").Replace("\n", " ");
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

  public static IntPtr FindByTitle(string frag) {
    if (String.IsNullOrEmpty(frag)) return IntPtr.Zero;
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

  /** Grab screen and encode PNG. Returns geometry JSON or null with err. */
  public static string Capture(string mode, string titleFragment, string outPath, out string err) {
    err = null;
    RECT rect = new RECT();
    if (mode == "window") {
      IntPtr h = FindByTitle(titleFragment);
      if (h == IntPtr.Zero) { err = "CAPTURE_WINDOW_NOT_FOUND"; return null; }
      GetWindowRect(h, out rect);
    } else {
      rect.Left = GetSystemMetrics(SM_XVIRTUALSCREEN);
      rect.Top = GetSystemMetrics(SM_YVIRTUALSCREEN);
      rect.Right = rect.Left + GetSystemMetrics(SM_CXVIRTUALSCREEN);
      rect.Bottom = rect.Top + GetSystemMetrics(SM_CYVIRTUALSCREEN);
    }
    int w = rect.Right - rect.Left, hgt = rect.Bottom - rect.Top;
    if (w <= 0 || hgt <= 0) { err = "CAPTURE_WINDOW_NOT_FOUND"; return null; }

    IntPtr screen = GetDC(IntPtr.Zero);
    if (screen == IntPtr.Zero) { err = "CAPTURE_DC_FAILED"; return null; }
    IntPtr mem = IntPtr.Zero, bmp = IntPtr.Zero, old = IntPtr.Zero;
    IntPtr gdip = IntPtr.Zero, gdipImage = IntPtr.Zero;
    try {
      mem = CreateCompatibleDC(screen);
      bmp = CreateCompatibleBitmap(screen, w, hgt);
      if (mem == IntPtr.Zero || bmp == IntPtr.Zero) { err = "CAPTURE_DC_FAILED"; return null; }
      old = SelectObject(mem, bmp);
      if (!BitBlt(mem, 0, 0, w, hgt, screen, rect.Left, rect.Top, SRCCOPY | CAPTUREBLT)) { err = "CAPTURE_DC_FAILED"; return null; }

      var gsi = new GdiplusStartupInput(); gsi.GdiplusVersion = 1;
      IntPtr gOut;
      if (GdiplusStartup(out gdip, ref gsi, out gOut) != 0) { err = "CAPTURE_ENCODE_FAILED"; return null; }
      if (GdipCreateBitmapFromHBITMAP(bmp, IntPtr.Zero, out gdipImage) != 0) { err = "CAPTURE_ENCODE_FAILED"; return null; }
      Guid enc = PNG_ENCODER;
      int st = GdipSaveImageToFile(gdipImage, outPath, ref enc, IntPtr.Zero);
      if (st != 0) { err = st == 3 ? "CAPTURE_DISK_FULL" : "CAPTURE_ENCODE_FAILED"; return null; }
      return "{\"w\":" + w + ",\"h\":" + hgt + "}";
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

if (-not ('AwbCaptureNative' -as [type])) {
  Add-Type -TypeDefinition $src -Language CSharp -ReferencedAssemblies System.Drawing | Out-Null
}

$req = $null
if ($Args) { $req = $Args | ConvertFrom-Json }
else {
  $stdin = [Console]::In.ReadToEnd()
  if ($stdin) { $req = $stdin | ConvertFrom-Json }
}
if (-not $req) { $req = [pscustomobject]@{ op = 'probe' } }

$op = if ($req.op) { [string]$req.op } else { 'capture' }

if ($op -eq 'probe') {
  $info = [AwbCaptureNative]::ScreenInfo()
  $fg = [AwbCaptureNative]::FocusSnapshot()
  Write-Output ("{""ok"":true,""screen"":" + $info + ",""focus"":" + $fg + "}")
  exit 0
}

if ($op -eq 'focus') {
  Write-Output ([AwbCaptureNative]::FocusSnapshot())
  exit 0
}

if ($op -eq 'windowstate') {
  $ws = [AwbCaptureNative]::WindowState([string]$req.window)
  if ($ws -eq 'null') { Write-Output '{"ok":false,"code":"CAPTURE_WINDOW_NOT_FOUND"}'; exit 1 }
  Write-Output ("{""ok"":true,""state"":" + $ws + "}")
  exit 0
}

# capture
$sw = [System.Diagnostics.Stopwatch]::StartNew()
$err = $null
$res = [AwbCaptureNative]::Capture([string]$req.mode, [string]$req.window, [string]$req.out, [ref]$err)
$sw.Stop()
if (-not $res) {
  Write-Output ("{""ok"":false,""code"":" + '"' + $err + '"' + "}")
  exit 1
}
Write-Output ("{""ok"":true,""geom"":" + $res + ",""ms"":" + [int]$sw.Elapsed.TotalMilliseconds + "}")
exit 0
