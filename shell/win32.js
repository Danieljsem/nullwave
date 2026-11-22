// Minimal Win32 bindings (koffi) used by the Nullwave shell.
// Window handles are plain JS numbers everywhere (HWND declared as intptr_t), so they can be compared,
// used as map keys and sent between threads; no koffi pointer objects leave this file.
// Nothing here may block on another process: cross-process window changes use the *Async / posted
// variants and messages go through SendMessageTimeout(SMTO_ABORTIFHUNG).
'use strict';
const koffi = require('koffi');
const u = koffi.load('user32.dll');
const dwm = koffi.load('dwmapi.dll');
const k32 = koffi.load('kernel32.dll');
const sh32 = koffi.load('shell32.dll');
let shcore = null; try { shcore = koffi.load('shcore.dll'); } catch {}

const RECT = koffi.struct('RECT', { left: 'int32', top: 'int32', right: 'int32', bottom: 'int32' });
const POINT = koffi.struct('POINT', { x: 'int32', y: 'int32' });
const EnumProc = koffi.proto('bool __stdcall EnumProc(intptr_t hwnd, intptr_t lp)');
const MonProc = koffi.proto('bool __stdcall MonProc(intptr_t hmon, intptr_t hdc, RECT* rc, intptr_t lp)');
const APPBARDATA = koffi.struct('APPBARDATA', { cbSize: 'uint32', hWnd: 'intptr_t', uCallbackMessage: 'uint32', uEdge: 'uint32', rc: RECT, lParam: 'intptr_t' });
const MONITORINFO = koffi.struct('MONITORINFO', { cbSize: 'uint32', rcMonitor: RECT, rcWork: RECT, dwFlags: 'uint32' });

const f = {
  FindWindowW: u.func('intptr_t __stdcall FindWindowW(str16 cls, str16 title)'),
  FindWindowExW: u.func('intptr_t __stdcall FindWindowExW(intptr_t parent, intptr_t after, str16 cls, str16 title)'),
  SendMessageTimeoutW: u.func('intptr_t __stdcall SendMessageTimeoutW(intptr_t h, uint32_t m, uintptr_t w, intptr_t l, uint32_t f, uint32_t t, _Out_ uintptr_t* r)'),
  SetParent: u.func('intptr_t __stdcall SetParent(intptr_t child, intptr_t parent)'),
  GetParent: u.func('intptr_t __stdcall GetParent(intptr_t h)'),
  SetWindowPos: u.func('bool __stdcall SetWindowPos(intptr_t h, intptr_t after, int x, int y, int cx, int cy, uint32_t flags)'),
  GetWindowLongPtrW: u.func('intptr_t __stdcall GetWindowLongPtrW(intptr_t h, int idx)'),
  SetWindowLongPtrW: u.func('intptr_t __stdcall SetWindowLongPtrW(intptr_t h, int idx, intptr_t v)'),
  GetWindowRect: u.func('bool __stdcall GetWindowRect(intptr_t h, _Out_ RECT* r)'),
  GetCursorPos: u.func('bool __stdcall GetCursorPos(_Out_ POINT* p)'),
  WindowFromPoint: u.func('intptr_t __stdcall WindowFromPoint(POINT p)'),
  GetClassNameW: u.func('int __stdcall GetClassNameW(intptr_t h, _Out_ uint16_t* buf, int n)'),
  GetAsyncKeyState: u.func('int16_t __stdcall GetAsyncKeyState(int vk)'),
  EnumWindows: u.func('bool __stdcall EnumWindows(EnumProc* cb, intptr_t lp)'),
  IsWindow: u.func('bool __stdcall IsWindow(intptr_t h)'),
  IsWindowVisible: u.func('bool __stdcall IsWindowVisible(intptr_t h)'),
  IsIconic: u.func('bool __stdcall IsIconic(intptr_t h)'),
  IsZoomed: u.func('bool __stdcall IsZoomed(intptr_t h)'),
  GetWindowThreadProcessId: u.func('uint32_t __stdcall GetWindowThreadProcessId(intptr_t h, _Out_ uint32_t* pid)'),
  GetAncestor: u.func('intptr_t __stdcall GetAncestor(intptr_t h, uint32_t flags)'),
  SystemParametersInfoW: u.func('bool __stdcall SystemParametersInfoW(uint32_t a, uint32_t b, str16 c, uint32_t d)'),
  EnumDisplayMonitors: u.func('bool __stdcall EnumDisplayMonitors(intptr_t hdc, intptr_t clip, MonProc* cb, intptr_t lp)'),
  GetMonitorInfoW: u.func('bool __stdcall GetMonitorInfoW(intptr_t hmon, _Inout_ MONITORINFO* mi)'),
  MonitorFromWindow: u.func('intptr_t __stdcall MonitorFromWindow(intptr_t h, uint32_t flags)'),
  ShowWindowAsync: u.func('bool __stdcall ShowWindowAsync(intptr_t h, int cmd)'),
  GetWindowTextW: u.func('int __stdcall GetWindowTextW(intptr_t h, _Out_ uint16_t* buf, int n)'),
  GetForegroundWindow: u.func('intptr_t __stdcall GetForegroundWindow()'),
  SetForegroundWindow: u.func('bool __stdcall SetForegroundWindow(intptr_t h)'),
  AllowSetForegroundWindow: u.func('bool __stdcall AllowSetForegroundWindow(uint32_t pid)'),
  AttachThreadInput: u.func('bool __stdcall AttachThreadInput(uint32_t from, uint32_t to, bool attach)'),
  SwitchToThisWindow: u.func('void __stdcall SwitchToThisWindow(intptr_t h, bool altTab)'),
  GetCurrentThreadId: k32.func('uint32_t __stdcall GetCurrentThreadId()'),
  GetWindow: u.func('intptr_t __stdcall GetWindow(intptr_t h, uint32_t cmd)'),
  PostMessageW: u.func('bool __stdcall PostMessageW(intptr_t h, uint32_t m, uintptr_t w, intptr_t l)'),
  keybd_event: u.func('void __stdcall keybd_event(uint8_t vk, uint8_t scan, uint32_t flags, uintptr_t extra)'),
  SHAppBarMessage: sh32.func('uintptr_t __stdcall SHAppBarMessage(uint32_t msg, _Inout_ APPBARDATA* d)'),
  OpenProcess: k32.func('intptr_t __stdcall OpenProcess(uint32_t access, bool inherit, uint32_t pid)'),
  CloseHandle: k32.func('bool __stdcall CloseHandle(intptr_t h)'),
  GetCurrentProcess: k32.func('intptr_t __stdcall GetCurrentProcess()'),
  TerminateProcess: k32.func('bool __stdcall TerminateProcess(intptr_t h, uint32_t code)'),
  QueryFullProcessImageNameW: k32.func('bool __stdcall QueryFullProcessImageNameW(intptr_t h, uint32_t flags, _Out_ uint16_t* buf, _Inout_ uint32_t* size)'),
  DwmGetWindowAttribute: dwm.func('int32_t __stdcall DwmGetWindowAttribute(intptr_t h, uint32_t attr, _Out_ int32_t* v, uint32_t size)'),
  GetDpiForMonitor: shcore ? shcore.func('int32_t __stdcall GetDpiForMonitor(intptr_t hmon, int type, _Out_ uint32_t* x, _Out_ uint32_t* y)') : null,
};

const N = (v) => (typeof v === 'bigint' ? Number(v) : (v || 0));   // handle -> plain number
const fromHandleBuffer = (buf) => Number(buf.readBigUInt64LE(0));   // Electron getNativeWindowHandle() -> HWND

const strBuf = new Uint16Array(512);
const str = (n) => (n > 0 ? String.fromCharCode.apply(null, strBuf.subarray(0, n)) : '');
function className(h) { return h ? str(f.GetClassNameW(h, strBuf, 256)) : ''; }
function title(h) { return str(f.GetWindowTextW(h, strBuf, 512)); }
function rect(h) { const r = {}; return f.GetWindowRect(h, r) ? r : { left: 0, top: 0, right: 0, bottom: 0 }; }
function pidOf(h) { const p = [0]; f.GetWindowThreadProcessId(h, p); return p[0]; }
const parentOf = (h) => N(f.GetParent(h));
const isWindow = (h) => !!h && f.IsWindow(h);

// ---- desktop host: on Windows 11 24H2+ Progman holds SHELLDLL_DefView (icons) and a WorkerW.
// We put the wallpaper windows as children of Progman, z-ordered right below the icon view.
// poke=true also asks Explorer to create the wallpaper layer (only needed before embedding).
function desktopHost(poke) {
  const progman = N(f.FindWindowW('Progman', null));
  if (!progman) return null;
  if (poke) f.SendMessageTimeoutW(progman, 0x052c, 0xd, 1, 0x2, 800, [0]);   // SMTO_ABORTIFHUNG
  const defView = N(f.FindWindowExW(progman, 0, 'SHELLDLL_DefView', null));
  if (defView) return { mode: 'progman', parent: progman, defView, origin: rect(progman) };
  // older layout: a top-level WorkerW holds DefView, the next WorkerW is the wallpaper layer
  let w = 0, worker = 0, guard = 0;
  while ((w = N(f.FindWindowExW(0, w, 'WorkerW', null))) && guard++ < 200) {
    if (N(f.FindWindowExW(w, 0, 'SHELLDLL_DefView', null))) { worker = N(f.FindWindowExW(0, w, 'WorkerW', null)); break; }
  }
  return worker ? { mode: 'workerw', parent: worker, defView: 0, origin: rect(worker) } : null;
}

const GWL_STYLE = -16, GWL_EXSTYLE = -20, WS_CHILD = 0x40000000n, WS_POPUP = 0x80000000n, WS_EX_NOPARENTNOTIFY = 0x4n;
const WS_FRAME_BITS = 0x00C00000n | 0x00040000n | 0x00080000n | 0x00020000n | 0x00010000n;   // caption, thick frame, system menu, min / max box
const SWP_NOSIZE = 0x1, SWP_NOMOVE = 0x2, SWP_NOZORDER = 0x4, SWP_NOACTIVATE = 0x10, SWP_FRAMECHANGED = 0x20, SWP_SHOWWINDOW = 0x40, SWP_ASYNCWINDOWPOS = 0x4000;
// Only ever called for our own windows, from the thread that owns them.
function embed(hwnd, host, physRect) {
  let st = BigInt(f.GetWindowLongPtrW(hwnd, GWL_STYLE));
  st = (st & ~WS_POPUP & ~WS_FRAME_BITS) | WS_CHILD;   // no frame bits: the page must fill the whole window (a hidden frame cost 8 px per side)
  f.SetWindowLongPtrW(hwnd, GWL_STYLE, st);
  // no synchronous WM_PARENTNOTIFY into Explorer when the child is created / destroyed
  f.SetWindowLongPtrW(hwnd, GWL_EXSTYLE, BigInt(f.GetWindowLongPtrW(hwnd, GWL_EXSTYLE)) | WS_EX_NOPARENTNOTIFY);
  f.SetParent(hwnd, host.parent);
  placeChild(hwnd, host, physRect);
}
function placeChild(hwnd, host, physRect) {
  const x = physRect.x - host.origin.left, y = physRect.y - host.origin.top;
  // insert after DefView = directly below the icons
  f.SetWindowPos(hwnd, host.defView || 0, x, y, physRect.width, physRect.height, SWP_NOACTIVATE | SWP_SHOWWINDOW | SWP_FRAMECHANGED);
}
// move/size one of our own top-level windows in physical pixels
function setPos(hwnd, r) { f.SetWindowPos(hwnd, 0, r.x, r.y, r.width, r.height, SWP_NOACTIVATE | SWP_NOZORDER); }
const sameRect = (wr, r) => wr.left === r.x && wr.top === r.y && wr.right - wr.left === r.width && wr.bottom - wr.top === r.height;

const keyDown = (vk) => (f.GetAsyncKeyState(vk) & 0x8000) !== 0;
const DESK_ROOT = new Set(['Progman', 'WorkerW']);
// cursor position, left button and whether the cursor is over the bare desktop (icon layer / wallpaper).
// The root window is checked, so a list view inside some application never counts as "desktop".
function pointer(area) {
  const p = {}; if (!f.GetCursorPos(p)) return null;
  const btn = keyDown(0x01);
  let desk = false;
  if (!area || (p.x >= area.x && p.y >= area.y && p.x < area.x + area.width && p.y < area.y + area.height)) {
    const h = N(f.WindowFromPoint(p));
    if (h) { const root = N(f.GetAncestor(h, 2)) || h; desk = DESK_ROOT.has(className(root)); }   // GA_ROOT
  }
  return { x: p.x, y: p.y, btn, desk };
}

// monitors in physical pixels straight from Windows (Electron's numbers are off with mixed DPI)
let monSink = null;
const monCb = koffi.register((hmon) => { try { monSink && monSink(N(hmon)); } catch {} return true; }, koffi.pointer(MonProc));
function monitorInfo(hmon) {
  const mi = { cbSize: koffi.sizeof(MONITORINFO), rcMonitor: {}, rcWork: {}, dwFlags: 0 };
  if (!hmon || !f.GetMonitorInfoW(hmon, mi)) return null;
  const r = mi.rcMonitor, w = mi.rcWork;
  return { hmon, x: r.left, y: r.top, width: r.right - r.left, height: r.bottom - r.top, primary: (mi.dwFlags & 1) === 1,
    work: { x: w.left, y: w.top, width: w.right - w.left, height: w.bottom - w.top } };
}
function monitors() {
  const out = [];
  monSink = (hmon) => {
    const m = monitorInfo(hmon); if (!m) return;
    let dpi = 96;
    if (f.GetDpiForMonitor) { const x = [0], y = [0]; if (f.GetDpiForMonitor(hmon, 0, x, y) === 0 && x[0]) dpi = x[0]; }   // MDT_EFFECTIVE_DPI
    m.dpi = dpi; m.scale = dpi / 96;
    out.push(m);
  };
  try { f.EnumDisplayMonitors(0, 0, monCb, 0); } finally { monSink = null; }
  return out;
}

// ---- window list ----
const WS_EX_TOPMOST = 0x8n, WS_EX_TRANSPARENT = 0x20n, WS_EX_TOOLWINDOW = 0x80n, WS_EX_APPWINDOW = 0x40000n, WS_EX_LAYERED = 0x80000n, WS_EX_NOACTIVATE = 0x08000000n, GW_OWNER = 4;
const SHELL_CLASSES = new Set(['Progman', 'WorkerW', 'Shell_TrayWnd', 'Shell_SecondaryTrayWnd', 'Windows.UI.Core.CoreWindow', 'NotifyIconOverflowWindow',
  'TopLevelWindowForOverflowXamlIsland', 'XamlExplorerHostIslandWindow', 'Shell_InputSwitchTopLevelWindow']);
const exeCache = new Map();
function exeOf(pid) {
  if (exeCache.has(pid)) return exeCache.get(pid);
  let exe = null;
  const hp = N(f.OpenProcess(0x1000, false, pid));   // PROCESS_QUERY_LIMITED_INFORMATION
  if (hp) { const b = new Uint16Array(1024), n = [1024]; if (f.QueryFullProcessImageNameW(hp, 0, b, n)) exe = String.fromCharCode.apply(null, b.subarray(0, n[0])); f.CloseHandle(hp); }
  exeCache.set(pid, exe); return exe;
}
const uwpPid = new Map();   // ApplicationFrameWindow hwnd -> pid of the real app (its CoreWindow moves away while minimized)
let enumSink = null;
const enumCb = koffi.register((h) => { try { enumSink && enumSink(N(h)); } catch {} return true; }, koffi.pointer(EnumProc));

// One pass over all top-level windows (z-order, top first). Returns:
//  wins     windows that would get a taskbar button { id, title, exe, pid, min, max, mon, uwp, own }
//  fg       foreground window { h, own, desk }
//  covered  per monitor: one window hides (almost) the whole desktop -> the wallpaper can sleep
//  full     per monitor: the top window is a real fullscreen window -> the rail gets out of the way
//  misfit   maximized windows that do not match their monitor's work area { h, mon, r, work }
// opt: { ownPid, allowOwn: [hwnd], mons: monitors() }
function snapshot(opt) {
  const mons = opt.mons || [], ownPid = opt.ownPid, allowOwn = opt.allowOwn || [];
  const wins = [], misfit = [], seenPid = new Set(), seenFrame = new Set(), frames = [], coreByTitle = new Map();
  const covered = mons.map(() => false), full = mons.map(() => false), decided = mons.map(() => false);
  const monIdx = new Map(mons.map((m, i) => [m.hmon, i]));
  const fgH = N(f.GetForegroundWindow());
  enumSink = (h) => {
    if (!f.IsWindowVisible(h)) return;
    const pid = pidOf(h), own = pid === ownPid;
    const cls = className(h);
    const cl = [0]; f.DwmGetWindowAttribute(h, 14, cl, 4);   // DWMWA_CLOAKED (other virtual desktop, suspended UWP...)
    if (cls === 'Windows.UI.Core.CoreWindow') { const t = title(h); if (t && !coreByTitle.has(t)) coreByTitle.set(t, pid); return; }
    if (cl[0] || SHELL_CLASSES.has(cls)) return;
    const ex = BigInt(f.GetWindowLongPtrW(h, GWL_EXSTYLE));
    const min = f.IsIconic(h), r = rect(h);
    const mi = monIdx.get(N(f.MonitorFromWindow(h, 2)));   // MONITOR_DEFAULTTONEAREST; right for minimized windows too
    const m = mi === undefined ? null : mons[mi];
    const ghost = (ex & WS_EX_LAYERED) && (ex & WS_EX_TRANSPARENT);   // click-through overlays
    const zoomed = !min && f.IsZoomed(h);
    if (m && !min && !own && !ghost) {
      const w = r.right - r.left, hh = r.bottom - r.top;
      const ix = Math.max(0, Math.min(r.right, m.x + m.width) - Math.max(r.left, m.x));
      const iy = Math.max(0, Math.min(r.bottom, m.y + m.height) - Math.max(r.top, m.y));
      if (ix * iy >= m.width * m.height * 0.9) covered[mi] = true;
      if (!decided[mi] && w >= 120 && hh >= 80) {
        const covers = r.left <= m.x && r.top <= m.y && r.right >= m.x + m.width && r.bottom >= m.y + m.height;
        const plainMax = zoomed && (r.left < m.x || r.top < m.y);   // maximized with its frame hanging over the edge
        if (covers && !plainMax) { full[mi] = true; decided[mi] = true; }
        else if (!(ex & WS_EX_TOPMOST)) decided[mi] = true;         // small always-on-top windows do not decide
      }
    }
    // taskbar rules
    if (own && !allowOwn.includes(h)) return;
    if ((ex & WS_EX_TOOLWINDOW) && !(ex & WS_EX_APPWINDOW)) return;
    if ((ex & WS_EX_NOACTIVATE) && !(ex & WS_EX_APPWINDOW)) return;
    if (N(f.GetWindow(h, GW_OWNER)) && !(ex & WS_EX_APPWINDOW)) return;
    const t = title(h); if (!t) return;
    const win = { id: h, title: t, pid, exe: null, min, max: zoomed, mon: mi === undefined ? -1 : mi, uwp: false, own };
    if (cls === 'ApplicationFrameWindow') {   // UWP: the frame belongs to ApplicationFrameHost, the app is its CoreWindow child
      win.uwp = true; seenFrame.add(h);
      const core = N(f.FindWindowExW(h, 0, 'Windows.UI.Core.CoreWindow', null));
      if (core) { const p = pidOf(core); if (p) uwpPid.set(h, p); }
      frames.push(win);
    }
    if (zoomed && m && !ghost) {
      const k = m.work, same = r.left === m.x && r.top === m.y && r.right === m.x + m.width && r.bottom === m.y + m.height;
      const b = k.y - r.top;   // how far the frame hangs over the work area
      if (!same && (b < 0 || b > 48 || Math.abs(r.left - (k.x - b)) > 2 || Math.abs(r.right - (k.x + k.width + b)) > 2 || Math.abs(r.bottom - (k.y + k.height + b)) > 2))
        misfit.push({ h, mon: mi, top: r.top, work: k });
    }
    wins.push(win);
  };
  try { f.EnumWindows(enumCb, 0); } finally { enumSink = null; }
  for (const w of frames) { const p = uwpPid.get(w.id) || coreByTitle.get(w.title); if (p) { w.pid = p; uwpPid.set(w.id, p); } }
  for (const w of wins) { seenPid.add(w.pid); w.exe = exeOf(w.pid); }
  for (const p of exeCache.keys()) if (!seenPid.has(p)) exeCache.delete(p);   // pids get reused
  for (const h of uwpPid.keys()) if (!seenFrame.has(h)) uwpPid.delete(h);
  let fg = { h: 0, own: false, desk: false };
  if (fgH) { const c = className(fgH); fg = { h: fgH, own: pidOf(fgH) === ownPid, desk: DESK_ROOT.has(c) || c === 'Shell_TrayWnd' || c === 'Shell_SecondaryTrayWnd' }; }
  return { wins, fg, covered, full, misfit };
}

// Put a maximized window back into its monitor's work area. Step 0 resizes it in place (no animation),
// later steps restore + maximize it again. Never waits for the other application.
function refit(m, step) {
  if (!isWindow(m.h) || f.IsIconic(m.h) || !f.IsZoomed(m.h)) return;
  const b = m.work.y - m.top;
  if (!step && b >= 0 && b <= 48) {
    f.SetWindowPos(m.h, 0, m.work.x - b, m.work.y - b, m.work.width + 2 * b, m.work.height + 2 * b, SWP_NOZORDER | SWP_NOACTIVATE | SWP_ASYNCWINDOWPOS);
  } else { f.ShowWindowAsync(m.h, 9); f.ShowWindowAsync(m.h, 3); }   // SW_RESTORE, SW_MAXIMIZE
}

// Bring a window to the front. No synthetic Alt (it opens the target's menu bar) and no other key presses:
// at click time our rail is the foreground window, so the plain call is allowed. If Windows still refuses,
// borrow the foreground thread's input state for a moment, then fall back to the Alt-Tab style switch.
function activate(h) {
  if (!isWindow(h)) return false;
  if (f.IsIconic(h)) f.ShowWindowAsync(h, 9);           // SW_RESTORE (keeps a maximized window maximized)
  f.SetForegroundWindow(h);
  if (N(f.GetForegroundWindow()) === h) return true;
  const fg = N(f.GetForegroundWindow()), me = f.GetCurrentThreadId(), other = fg ? f.GetWindowThreadProcessId(fg, [0]) : 0;
  if (other && other !== me && f.AttachThreadInput(me, other, true)) {
    try { f.SetForegroundWindow(h); } finally { f.AttachThreadInput(me, other, false); }
  }
  if (N(f.GetForegroundWindow()) === h) return true;
  f.SwitchToThisWindow(h, true);
  return N(f.GetForegroundWindow()) === h;
}
// Press keys in the given order and release them in reverse (Win combinations for the shell buttons, volume keys).
// Never used for activation and never with Alt. Every key that went down is released, whatever happens.
function keys(vks) {
  const down = [], ext = (vk) => (vk === 0x5B || vk === 0x5C || (vk >= 0xAD && vk <= 0xAF) ? 1 : 0);   // KEYEVENTF_EXTENDEDKEY
  try { for (const vk of vks) { f.keybd_event(vk, 0, ext(vk), 0); down.push(vk); } }
  finally { for (const vk of down.reverse()) { try { f.keybd_event(vk, 0, ext(vk) | 2, 0); } catch {} } }   // KEYEVENTF_KEYUP
}
const minimize = (h) => isWindow(h) && f.ShowWindowAsync(h, 6);
const closeWin = (h) => isWindow(h) && f.PostMessageW(h, 0x0112, 0xF060, 0);   // WM_SYSCOMMAND / SC_CLOSE, like the taskbar does

// ---- Windows taskbars ----
function trays() {
  const list = []; const main = N(f.FindWindowW('Shell_TrayWnd', null)); if (main) list.push(main);
  let w = 0, guard = 0; while ((w = N(f.FindWindowExW(0, w, 'Shell_SecondaryTrayWnd', null))) && guard++ < 32) list.push(w);
  return list;
}
// primaryOnly: just the main taskbar (the one with the notification area)
function showTrays(show, primaryOnly) { for (const t of primaryOnly ? trays().slice(0, 1) : trays()) f.ShowWindowAsync(t, show ? 5 : 0); }
// we are the foreground process right now: let the program we are about to poke (a tray icon's owner) take the foreground for its menu / window
const allowForeground = () => f.AllowSetForegroundWindow(0xFFFFFFFF);   // ASFW_ANY
function traysVisible() { return trays().some((t) => f.IsWindowVisible(t)); }
const trayRects = () => trays().map(rect);
const abd = (hWnd, edge, rc, lParam) => ({ cbSize: koffi.sizeof(APPBARDATA), hWnd, uCallbackMessage: 0, uEdge: edge || 0, rc: rc || { left: 0, top: 0, right: 0, bottom: 0 }, lParam: lParam || 0 });

// Calls that talk to Explorer synchronously. The app runs them on the helper thread (win32-worker.js)
// so a busy or hung Explorer can never freeze the thread that owns our windows.
const ops = {
  desktopHost: (poke) => desktopHost(poke),
  taskbarState: () => Number(f.SHAppBarMessage(4, abd(N(f.FindWindowW('Shell_TrayWnd', null))))),                       // ABM_GETSTATE
  setTaskbarState: (state) => { f.SHAppBarMessage(10, abd(N(f.FindWindowW('Shell_TrayWnd', null)), 0, null, state)); return true; },   // ABM_SETSTATE
  // our rail as an app bar: Windows keeps maximized windows out of its strip
  appbarNew: (hwnd, r, edge) => {
    const rc = () => ({ left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height });
    f.SHAppBarMessage(0, abd(hwnd, edge, rc()));   // ABM_NEW (no callback message: we never wait on Explorer's notifications)
    // always hug the monitor's edge (QUERYPOS would push us next to stale/auto-hidden bars)
    f.SHAppBarMessage(3, abd(hwnd, edge, rc()));   // ABM_SETPOS
    return true;
  },
  appbarSetPos: (hwnd, r, edge) => { f.SHAppBarMessage(3, abd(hwnd, edge, { left: r.x, top: r.y, right: r.x + r.width, bottom: r.y + r.height })); return true; },
  appbarRemove: (hwnds) => { for (const h of hwnds) f.SHAppBarMessage(1, abd(h)); return true; },   // ABM_REMOVE
  // re-set the current wallpaper so Explorer redraws the desktop after our windows are gone (no broadcast)
  repaintWallpaper: (file) => (file ? f.SystemParametersInfoW(0x0014, 0, file, 0) : false),
};
// last resort when the main thread is stuck on the way out
function selfTerminate(code) { f.TerminateProcess(f.GetCurrentProcess(), code || 0); }

module.exports = { ops, snapshot, refit, monitors, monitorInfo, pointer, activate, keys, minimize, closeWin, showTrays, traysVisible, trayRects, allowForeground,
  fromHandleBuffer, className, rect, parentOf, isWindow, desktopHost, embed, placeChild, setPos, sameRect, selfTerminate, f };
