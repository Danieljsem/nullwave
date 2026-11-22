// Nullwave tray helper: lists the notification-area icons of the Windows taskbar (also the hidden ones in the
// overflow) and clicks them, through UI Automation. Works while the taskbar window is hidden: the XAML tree is
// reached through the taskbar's content bridge window.
//
// Protocol: one JSON object per line on stdin -> one JSON object per line on stdout.
//   {"id":1,"cmd":"list"}                 -> {"id":1,"ok":true,"gen":7,"icons":[{"key":"o3","name":"...","exe":"...","png":"<base64>","where":"overflow"}]}
//   {"id":2,"cmd":"invoke","key":"o3","gen":7}   left click (the icon's default action)
//   {"id":3,"cmd":"menu","key":"o3","gen":7}     the icon's own context menu
// Started lazily by main.js and killed when idle. Built from this file with the .NET Framework compiler
// that ships with Windows (csc.exe, C# 5): no SDK, no PowerShell.
using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using System.Web.Script.Serialization;
using Microsoft.Win32;

static class TrayHelper {
  // ---- Win32 ----
  [StructLayout(LayoutKind.Sequential)] struct RECT { public int left, top, right, bottom; }
  [StructLayout(LayoutKind.Sequential)] struct NOTIFYICONIDENTIFIER { public uint cbSize; public IntPtr hWnd; public uint uID; public Guid guidItem; }
  delegate bool EnumProc(IntPtr h, IntPtr l);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindow(string c, string t);
  [DllImport("user32.dll", CharSet = CharSet.Unicode)] static extern IntPtr FindWindowEx(IntPtr p, IntPtr a, string c, string t);
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc cb, IntPtr l);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr h, out uint pid);
  [DllImport("shell32.dll")] static extern int Shell_NotifyIconGetRect(ref NOTIFYICONIDENTIFIER id, out RECT r);
  [DllImport("shell32.dll")] static extern int SHGetKnownFolderPath([MarshalAs(UnmanagedType.LPStruct)] Guid id, uint flags, IntPtr token, out IntPtr path);
  [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, uint pid);
  [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode)] static extern bool QueryFullProcessImageName(IntPtr h, uint flags, StringBuilder buf, ref uint size);
  [DllImport("oleaut32.dll")] static extern void SysFreeString(IntPtr b);

  // ---- UI Automation through raw COM (slots read from UIAutomationCore's type library; the ABI is frozen) ----
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int DOutPtr(IntPtr self, out IntPtr p);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int DFromHandle(IntPtr self, IntPtr hwnd, out IntPtr el);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int DFindAll(IntPtr self, int scope, IntPtr cond, out IntPtr arr);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int DOutInt(IntPtr self, out int n);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int DGetElement(IntPtr self, int i, out IntPtr el);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int DOutRect(IntPtr self, out RECT r);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int DGetPattern(IntPtr self, int id, out IntPtr unk);
  [UnmanagedFunctionPointer(CallingConvention.StdCall)] delegate int DVoid(IntPtr self);
  static readonly Guid CLSID_CUIAutomation = new Guid("ff48dba4-60ef-4201-aa87-54103eef594e");
  static Guid IID_IUIAutomation = new Guid("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee");
  static Guid IID_Element3 = new Guid("8471df34-aee0-4a01-a7de-7db9af12c296");
  static Guid IID_InvokePattern = new Guid("fb377fbe-8ea6-46d5-9c73-6499642d3059");
  const int UIA_ElementFromHandle = 6, UIA_CreateTrueCondition = 21;                       // IUIAutomation
  const int EL_FindAll = 6, EL_GetCurrentPattern = 16, EL_Name = 23, EL_AutomationId = 29, EL_Rect = 43;   // IUIAutomationElement
  const int EL3_ShowContextMenu = 91, ARR_Length = 3, ARR_GetElement = 4, INVOKE_Invoke = 3;
  const int TreeScope_Descendants = 4, UIA_InvokePatternId = 10000;

  static T Fn<T>(IntPtr obj, int slot) where T : class {
    IntPtr fp = Marshal.ReadIntPtr(Marshal.ReadIntPtr(obj), slot * IntPtr.Size);
    return (T)(object)Marshal.GetDelegateForFunctionPointer(fp, typeof(T));
  }
  static void Check(int hr, string what) { if (hr < 0) throw new Exception(what + " failed (0x" + hr.ToString("X8") + ")"); }
  static void Release(IntPtr p) { if (p != IntPtr.Zero) Marshal.Release(p); }
  static string Bstr(IntPtr el, int slot) {
    IntPtr b; if (Fn<DOutPtr>(el, slot)(el, out b) < 0 || b == IntPtr.Zero) return "";
    try { return Marshal.PtrToStringBSTR(b) ?? ""; } finally { SysFreeString(b); }
  }

  static IntPtr uia = IntPtr.Zero, trueCond = IntPtr.Zero;
  static void EnsureUia() {
    if (uia != IntPtr.Zero) return;
    object o = Activator.CreateInstance(Type.GetTypeFromCLSID(CLSID_CUIAutomation));
    IntPtr unk = Marshal.GetIUnknownForObject(o);
    try { Check(Marshal.QueryInterface(unk, ref IID_IUIAutomation, out uia), "IUIAutomation"); } finally { Marshal.Release(unk); }
    Check(Fn<DOutPtr>(uia, UIA_CreateTrueCondition)(uia, out trueCond), "CreateTrueCondition");
  }

  class Icon { public IntPtr el; public string name; public RECT rect; public bool overflow; public Entry entry; }
  // every NotifyItemIcon button below one XAML island (the taskbar's or the overflow window's)
  static void Collect(IntPtr host, bool overflow, List<Icon> into) {
    if (host == IntPtr.Zero) return;
    IntPtr bridge = FindWindowEx(host, IntPtr.Zero, "Windows.UI.Composition.DesktopWindowContentBridge", null);
    if (bridge == IntPtr.Zero) bridge = host;
    IntPtr root, arr;
    if (Fn<DFromHandle>(uia, UIA_ElementFromHandle)(uia, bridge, out root) < 0 || root == IntPtr.Zero) return;
    try {
      if (Fn<DFindAll>(root, EL_FindAll)(root, TreeScope_Descendants, trueCond, out arr) < 0 || arr == IntPtr.Zero) return;
      try {
        int n; Fn<DOutInt>(arr, ARR_Length)(arr, out n);
        for (int i = 0; i < n; i++) {
          IntPtr el; if (Fn<DGetElement>(arr, ARR_GetElement)(arr, i, out el) < 0 || el == IntPtr.Zero) continue;
          if (Bstr(el, EL_AutomationId) != "NotifyItemIcon") { Release(el); continue; }
          Icon ic = new Icon(); ic.el = el; ic.name = Bstr(el, EL_Name).Trim(); ic.overflow = overflow;
          Fn<DOutRect>(el, EL_Rect)(el, out ic.rect);
          into.Add(ic);
        }
      } finally { Release(arr); }
    } finally { Release(root); }
  }

  // ---- which application owns an icon: HKCU\Control Panel\NotifyIconSettings + Shell_NotifyIconGetRect ----
  class Entry { public ulong id; public string exe; public bool hasUid; public uint uid; public Guid guid; public bool hasGuid; public string tip; public byte[] png; public bool promoted; public RECT rect; public int order; }
  static string KnownFolders(string p) {
    if (p == null || p.Length < 38 || p[0] != '{') return p;
    try {
      Guid g = new Guid(p.Substring(0, 38)); IntPtr s;
      if (SHGetKnownFolderPath(g, 0, IntPtr.Zero, out s) == 0) { string root = Marshal.PtrToStringUni(s); Marshal.FreeCoTaskMem(s); return root + p.Substring(38); }
    } catch { }
    return p;
  }
  static List<Entry> ReadEntries() {
    List<Entry> list = new List<Entry>();
    using (RegistryKey root = Registry.CurrentUser.OpenSubKey(@"Control Panel\NotifyIconSettings")) {
      if (root == null) return list;
      Dictionary<ulong, int> order = new Dictionary<ulong, int>();
      byte[] ui = root.GetValue("UIOrderList") as byte[];
      if (ui != null) for (int i = 0; i + 8 <= ui.Length; i += 8) order[BitConverter.ToUInt64(ui, i)] = i / 8;
      foreach (string name in root.GetSubKeyNames()) {
        try {
          using (RegistryKey k = root.OpenSubKey(name)) {
            Entry e = new Entry(); ulong.TryParse(name, out e.id);
            e.exe = KnownFolders(k.GetValue("ExecutablePath") as string) ?? "";
            object u = k.GetValue("UID"); if (u is int) { e.hasUid = true; e.uid = unchecked((uint)(int)u); }
            string g = k.GetValue("IconGuid") as string; if (!string.IsNullOrEmpty(g)) { try { e.guid = new Guid(g); e.hasGuid = true; } catch { } }
            e.tip = (k.GetValue("InitialTooltip") as string) ?? "";
            e.png = k.GetValue("IconSnapshot") as byte[];
            object pr = k.GetValue("IsPromoted"); e.promoted = pr is int && (int)pr != 0;
            int o; e.order = order.TryGetValue(e.id, out o) ? o : 100000 + list.Count;
            list.Add(e);
          }
        } catch { }
      }
    }
    return list;
  }
  static string ExeOf(uint pid, Dictionary<uint, string> cache) {
    string s; if (cache.TryGetValue(pid, out s)) return s;
    s = ""; IntPtr h = OpenProcess(0x1000, false, pid);
    if (h != IntPtr.Zero) { StringBuilder b = new StringBuilder(1024); uint n = 1024; if (QueryFullProcessImageName(h, 0, b, ref n)) s = b.ToString(); CloseHandle(h); }
    cache[pid] = s; return s;
  }
  // icons that exist right now, each with its screen rectangle as the shell reports it
  static List<Entry> Present(List<Entry> all) {
    Dictionary<uint, string> exes = new Dictionary<uint, string>();
    Dictionary<string, List<IntPtr>> byExe = new Dictionary<string, List<IntPtr>>(StringComparer.OrdinalIgnoreCase);
    Dictionary<IntPtr, string> exeOfWin = new Dictionary<IntPtr, string>();
    Action<IntPtr> add = delegate(IntPtr h) {
      uint pid; GetWindowThreadProcessId(h, out pid); string exe = ExeOf(pid, exes); if (exe == "") return;
      exeOfWin[h] = exe;
      string b = Path.GetFileName(exe); List<IntPtr> l; if (!byExe.TryGetValue(b, out l)) byExe[b] = l = new List<IntPtr>(); l.Add(h);
    };
    EnumWindows(delegate(IntPtr h, IntPtr l) { add(h); return true; }, IntPtr.Zero);
    IntPtr m = IntPtr.Zero; int guard = 0;   // message-only windows are not in EnumWindows
    while ((m = FindWindowEx(new IntPtr(-3), m, null, null)) != IntPtr.Zero && guard++ < 5000) add(m);
    List<Entry> present = new List<Entry>();
    int calls = 0;
    foreach (Entry e in all) {
      NOTIFYICONIDENTIFIER id = new NOTIFYICONIDENTIFIER(); id.cbSize = (uint)Marshal.SizeOf(typeof(NOTIFYICONIDENTIFIER));
      if (e.hasGuid) { id.guidItem = e.guid; if (Shell_NotifyIconGetRect(ref id, out e.rect) == 0) present.Add(e); continue; }
      if (!e.hasUid) continue;
      List<IntPtr> wins; if (!byExe.TryGetValue(Path.GetFileName(e.exe), out wins)) continue;
      bool full = Path.IsPathRooted(e.exe);   // two programs can share an exe name (every Electron app is electron.exe)
      foreach (IntPtr h in wins) {
        if (full && !string.Equals(exeOfWin[h], e.exe, StringComparison.OrdinalIgnoreCase)) continue;
        if (calls++ > 3000) break;
        id.hWnd = h; id.uID = e.uid;
        if (Shell_NotifyIconGetRect(ref id, out e.rect) == 0) { present.Add(e); break; }
      }
    }
    present.Sort(delegate(Entry a, Entry b) { return a.order.CompareTo(b.order); });
    return present;
  }
  static bool Same(RECT a, RECT b) { return Math.Abs(a.left - b.left) <= 2 && Math.Abs(a.top - b.top) <= 2 && Math.Abs(a.right - b.right) <= 2 && Math.Abs(a.bottom - b.bottom) <= 2; }
  static string Desc(string exe, Dictionary<string, string> cache) {
    string d; if (cache.TryGetValue(exe, out d)) return d;
    d = ""; try { if (File.Exists(exe)) d = FileVersionInfo.GetVersionInfo(exe).FileDescription ?? ""; } catch { }
    cache[exe] = d; return d;
  }
  static readonly Dictionary<string, string> descCache = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase);
  static List<Entry> lastPresent = new List<Entry>();
  static void Match(List<Icon> icons) {
    List<Entry> present;
    try { present = Present(ReadEntries()); } catch { return; }
    lastPresent = present;
    List<Entry> free = new List<Entry>(present);
    // 1 icons on the taskbar itself: same rectangle
    foreach (Icon ic in icons) {
      if (ic.overflow || ic.rect.right <= ic.rect.left) continue;
      Entry hit = free.Find(delegate(Entry e) { return Same(e.rect, ic.rect); });
      if (hit != null) { ic.entry = hit; free.Remove(hit); }
    }
    // 2 hidden icons: Windows lists them in its saved order (UIOrderList) - when both sides agree on how many there are
    List<Icon> rest = icons.FindAll(delegate(Icon i) { return i.entry == null; });
    if (rest.Count == free.Count) { for (int i = 0; i < rest.Count; i++) rest[i].entry = free[i]; return; }
    // 3 otherwise by text: the tooltip the icon was registered with, the program's name or its description
    foreach (Icon ic in rest) {
      if (ic.name == "") continue;
      string n = ic.name.ToLowerInvariant();
      Entry hit = free.Find(delegate(Entry e) { return e.tip.Trim() != "" && n.StartsWith(e.tip.Trim().ToLowerInvariant()); });
      if (hit == null) hit = free.Find(delegate(Entry e) { string b = Path.GetFileNameWithoutExtension(e.exe).ToLowerInvariant(); return b.Length > 2 && n.Contains(b); });
      if (hit == null) hit = free.Find(delegate(Entry e) { string d = Desc(e.exe, descCache).ToLowerInvariant(); return d.Length > 2 && (n.Contains(d) || d.Contains(n)); });
      if (hit != null) { ic.entry = hit; free.Remove(hit); }
    }
  }

  // ---- commands ----
  static List<Icon> current = new List<Icon>();
  static int gen = 0;
  static Dictionary<string, object> List(bool debug) {
    EnsureUia();
    List<Icon> icons = new List<Icon>();
    Collect(FindWindow("Shell_TrayWnd", null), false, icons);
    Collect(FindWindow("TopLevelWindowForOverflowXamlIsland", null), true, icons);
    Match(icons);
    foreach (Icon old in current) Release(old.el);
    current = icons; gen++;
    List<object> outp = new List<object>();
    int t = 0, o = 0;
    foreach (Icon ic in icons) {
      Dictionary<string, object> d = new Dictionary<string, object>();
      d["key"] = ic.overflow ? "o" + (o++) : "t" + (t++);
      d["name"] = ic.name; d["where"] = ic.overflow ? "overflow" : "tray";
      d["exe"] = ic.entry != null ? ic.entry.exe : "";
      d["app"] = ic.entry != null ? Desc(ic.entry.exe, descCache) : "";
      if (debug) d["png"] = ic.entry != null && ic.entry.png != null ? "(" + ic.entry.png.Length + " bytes)" : "";
      else d["png"] = ic.entry != null && ic.entry.png != null && ic.entry.png.Length < 200000 ? Convert.ToBase64String(ic.entry.png) : "";
      outp.Add(d);
    }
    Dictionary<string, object> res = new Dictionary<string, object>();
    res["ok"] = true; res["gen"] = gen; res["icons"] = outp;
    if (debug) { List<object> pr = new List<object>(); foreach (Entry e in lastPresent) pr.Add(e.order + " " + (e.hasGuid ? "guid" : "uid " + e.uid) + " " + e.exe + " rect " + e.rect.left + "," + e.rect.top + "," + e.rect.right + "," + e.rect.bottom + " tip=" + e.tip); res["present"] = pr; }
    return res;
  }
  static Icon Find(string key) {
    int t = 0, o = 0;
    foreach (Icon ic in current) { string k = ic.overflow ? "o" + (o++) : "t" + (t++); if (k == key) return ic; }
    return null;
  }
  static Dictionary<string, object> Act(string cmd, string key, int g) {
    Dictionary<string, object> res = new Dictionary<string, object>();
    Icon ic = g == gen ? Find(key) : null;
    if (ic == null) { res["ok"] = false; res["error"] = "stale"; return res; }
    if (cmd == "invoke") {
      IntPtr unk, pat;
      Check(Fn<DGetPattern>(ic.el, EL_GetCurrentPattern)(ic.el, UIA_InvokePatternId, out unk), "GetCurrentPattern");
      if (unk == IntPtr.Zero) throw new Exception("icon has no Invoke pattern");
      try { Check(Marshal.QueryInterface(unk, ref IID_InvokePattern, out pat), "IUIAutomationInvokePattern"); } finally { Release(unk); }
      try { Check(Fn<DVoid>(pat, INVOKE_Invoke)(pat), "Invoke"); } finally { Release(pat); }
    } else {
      IntPtr e3;
      Check(Marshal.QueryInterface(ic.el, ref IID_Element3, out e3), "IUIAutomationElement3");
      try { Check(Fn<DVoid>(e3, EL3_ShowContextMenu)(e3), "ShowContextMenu"); } finally { Release(e3); }
    }
    res["ok"] = true; return res;
  }

  [MTAThread]
  static int Main(string[] args) {
    Console.OutputEncoding = new UTF8Encoding(false);
    Console.InputEncoding = new UTF8Encoding(false);
    JavaScriptSerializer js = new JavaScriptSerializer(); js.MaxJsonLength = 64 * 1024 * 1024;
    if (args.Length > 0 && args[0] == "--dump") {   // read-only self test: what would be listed
      Console.WriteLine(js.Serialize(List(true)));
      return 0;
    }
    string line;
    while ((line = Console.In.ReadLine()) != null) {
      if (line.Trim() == "") continue;
      Dictionary<string, object> res; object id = null;
      try {
        Dictionary<string, object> req = js.Deserialize<Dictionary<string, object>>(line);
        req.TryGetValue("id", out id);
        string cmd = Convert.ToString(req["cmd"]);
        if (cmd == "list") res = List(false);
        else if (cmd == "invoke" || cmd == "menu") res = Act(cmd, Convert.ToString(req["key"]), Convert.ToInt32(req["gen"]));
        else if (cmd == "quit") return 0;
        else { res = new Dictionary<string, object>(); res["ok"] = false; res["error"] = "unknown command"; }
      } catch (Exception ex) { res = new Dictionary<string, object>(); res["ok"] = false; res["error"] = ex.Message; }
      res["id"] = id;
      Console.Out.WriteLine(js.Serialize(res)); Console.Out.Flush();
    }
    return 0;   // stdin closed: the app is gone
  }
}
