// Nullwave app: live wallpaper behind the desktop icons on every monitor, Windows look switch,
// tray menu, control panel, an app launcher (Alt+Space) and the rail (our taskbar).
//
// Threading rule: this (main) thread owns windows that live inside Explorer's desktop, so it must never
// wait on Explorer or on another application. All periodic Win32 polling and every call that talks to
// Explorer synchronously runs on a helper thread (win32-worker.js); this thread only reacts to changes.
'use strict';
const { app, BrowserWindow, screen, Tray, Menu, globalShortcut, shell, ipcMain, nativeImage, powerMonitor, safeStorage } = require('electron');
const path = require('path');
const fs = require('fs');
const fsp = fs.promises;
const { execFile, spawn } = require('child_process');
const { Worker } = require('worker_threads');

const LIVE = path.join(__dirname, '..');
const ICON = path.join(LIVE, 'brand', 'nullwave.ico');
const WALLPAPER = path.join(LIVE, 'wallpaper', 'index.html');

// ---------------- log: %APPDATA%\Nullwave\nullwave.log, written in the background ----------------
const LOG_FILE = path.join(process.env.APPDATA || __dirname, 'Nullwave', 'nullwave.log');
try { fs.mkdirSync(path.dirname(LOG_FILE), { recursive: true }); if (fs.existsSync(LOG_FILE) && fs.statSync(LOG_FILE).size > 2e6) fs.renameSync(LOG_FILE, LOG_FILE + '.old'); } catch {}
const _log = console.log.bind(console);
let logBuf = [], logBusy = false;
function flushLog() {
  if (logBusy || !logBuf.length) return;
  logBusy = true; const s = logBuf.join(''); logBuf = [];
  fs.appendFile(LOG_FILE, s, () => { logBusy = false; if (logBuf.length) flushLog(); });
}
function flushLogSync() { try { if (logBuf.length) { const s = logBuf.join(''); logBuf = []; fs.appendFileSync(LOG_FILE, s); } } catch {} }
console.log = (...a) => { try { _log(...a); } catch {} logBuf.push(a.map(String).join(' ') + '\n'); if (logBuf.length > 2000) logBuf.splice(0, 1000); flushLog(); };
console.error = console.log;
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), '[app]', ...a);
// the same error is written once, then at most once per 30 s with a counter (a failing timer must not flood the disk)
const errSeen = new Map();
function logErr(where, e) {
  const msg = String(e && e.stack || e), key = where + '|' + msg.split('\n')[0], now = Date.now();
  const s = errSeen.get(key) || { n: 0, at: 0 };
  s.n++;
  if (now - s.at > 30000) { log('ERROR', where, s.n > 1 ? `(x${s.n})` : '', msg); s.at = now; s.n = 0; }
  errSeen.set(key, s); if (errSeen.size > 200) errSeen.clear();
}
process.on('uncaughtException', (e) => logErr('uncaught', e));       // also keeps Electron's "JavaScript error" dialog away
process.on('unhandledRejection', (e) => logErr('promise', e));

if (!app.requestSingleInstanceLock()) { app.quit(); return; }
app.setAppUserModelId('Nullwave');
// keep rendering although Windows thinks the window is covered (it sits under the icons)
app.commandLine.appendSwitch('disable-features', 'CalculateNativeWinOcclusion');
app.commandLine.appendSwitch('disable-background-timer-throttling');

let W, hub, CFG, tray, panelWin, launcherWin, quitting = false, locked = false;
const desk = [];      // { win, mon, phys, scale, primary, paused, hwnd }
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const withTimeout = (p, ms) => Promise.race([p, new Promise((_r, rej) => setTimeout(() => rej(new Error('timeout')), ms))]);
const shellCfg = () => (CFG && CFG.shell) || {};
const railOn = () => shellCfg().rail !== false;
function setShell(patch) { CFG.shell = { ...(CFG.shell || {}), ...patch }; hub.saveCfg(); }

// ---------------- helper thread: polling + calls into Explorer ----------------
let worker = null, workerOk = false, inlinePoller = null, rpcId = 0, lastAlive = 0, readyResolve;
const workerReady = new Promise((r) => { readyResolve = r; });
const rpc = new Map();
const pollCfg = { ownPid: process.pid, allowOwn: [], desk: null, hideTrays: false, peekUntil: 0, refit: false };
function startWorker() {
  try {
    worker = new Worker(path.join(__dirname, 'win32-worker.js'));
    worker.on('message', onPollMsg);
    worker.on('error', (e) => { logErr('helper thread', e); workerDown(); });
    worker.on('exit', () => workerDown());
  } catch (e) { logErr('helper thread start', e); workerDown(); }
  setTimeout(() => { if (!workerOk) workerDown(); }, 4000);
}
// the helper thread is gone (or never came up): poll on this thread, slower
function workerDown() {
  const w = worker; worker = null; workerOk = false;
  if (w) { try { w.removeAllListeners(); w.terminate(); } catch {} }
  for (const p of rpc.values()) { clearTimeout(p.t); p.reject(new Error('helper thread gone')); }
  rpc.clear();
  if (!inlinePoller && !quitting) {
    log('helper thread unavailable: polling on the main thread');
    try { inlinePoller = require('./poller').createPoller(onPollMsg, { snap: 1000, mouse: 50 }); inlinePoller.config(pollCfg); inlinePoller.start(); } catch (e) { logErr('inline poller', e); }
  }
  readyResolve();
}
function pushCfg(patch) {
  Object.assign(pollCfg, patch || {});
  if (worker && workerOk) worker.postMessage({ t: 'cfg', cfg: pollCfg }); else if (inlinePoller) inlinePoller.config(pollCfg);
}
function poke(ms) { if (worker && workerOk) worker.postMessage({ t: 'poke', ms }); else if (inlinePoller) inlinePoller.poke(ms); }
// run one of win32.ops off the main thread; rejects after the timeout instead of hanging
function shellOp(op, args, timeout) {
  if (worker && workerOk) {
    return new Promise((resolve, reject) => {
      const id = ++rpcId;
      const t = setTimeout(() => { rpc.delete(id); reject(new Error(op + ' timed out')); }, timeout || 4000);
      rpc.set(id, { resolve, reject, t });
      worker.postMessage({ t: 'op', id, op, args: args || [] });
    });
  }
  return new Promise((resolve, reject) => {
    try { resolve(op === 'refitAll' ? (inlinePoller ? inlinePoller.refitAll() : 0) : W.ops[op](...(args || []))); } catch (e) { reject(e); }
  });
}
const tryOp = (op, args, timeout) => shellOp(op, args, timeout).catch((e) => { log(op, 'failed:', e.message); return undefined; });
let lastSnap = null;
function onPollMsg(m) {
  try {
    if (m.t === 'mouse') onMouse(m);
    else if (m.t === 'snap') { lastSnap = m.snap; onSnap(); }
    else if (m.t === 'res') { const p = rpc.get(m.id); if (p) { rpc.delete(m.id); clearTimeout(p.t); if (m.err) p.reject(new Error(m.err)); else p.resolve(m.res); } }
    else if (m.t === 'alive') lastAlive = Date.now();
    else if (m.t === 'ready') { workerOk = true; lastAlive = Date.now(); pushCfg(); readyResolve(); }
    else if (m.t === 'err') logErr('poll ' + m.where, m.msg);
  } catch (e) { logErr('poll message', e); }
}

// ---------------- hub (runs inside this process) ----------------
async function hubFetch(p, opt) { return fetch(`http://127.0.0.1:${CFG.port}${p}${p.includes('?') ? '&' : '?'}k=${CFG.key}`, opt); }
async function startHub() {
  const cfg = require(path.join(LIVE, 'hub', 'config-init.js'))();
  // a stand-alone hub (start-hub.vbs) may hold the port: ask it to stop
  try { await fetch(`http://127.0.0.1:${cfg.port}/api/hub/stop?k=${cfg.key}`, { method: 'POST', signal: AbortSignal.timeout(1500) }); await sleep(800); } catch {}
  // safeStorage: the hub keeps the TP-Link password of the ports widget encrypted with this app's own key (DPAPI)
  global.NULLWAVE_HOST = { quit: () => quitApp(), restart: () => quitApp({ relaunch: true }), safeStorage, askTlPassword: () => openTlPassword() };
  hub = require(path.join(LIVE, 'hub', 'server.js'));
  CFG = hub.CFG;
}

// ---------------- desktop windows ----------------
const monKey = (m) => `${m.x},${m.y},${m.width}x${m.height}@${m.dpi}`;
function makeDesktop(mon, primary) {
  const b = screen.screenToDipRect(null, { x: mon.x, y: mon.y, width: mon.width, height: mon.height });
  const win = new BrowserWindow({
    x: b.x, y: b.y, width: b.width, height: b.height, show: false, frame: false, thickFrame: false, roundedCorners: false, skipTaskbar: true, resizable: false,
    movable: false, focusable: false, hasShadow: false, backgroundColor: '#0f0a1e', icon: ICON,
    webPreferences: { backgroundThrottling: false, contextIsolation: true, sandbox: true },
  });
  win.setMenu(null);
  const d = { win, mon, primary, paused: false, scale: mon.scale || 1, phys: { x: mon.x, y: mon.y, width: mon.width, height: mon.height }, hwnd: 0, reloads: 0 };
  win.loadURL('file:///' + WALLPAPER.replace(/\\/g, '/') + (primary ? '' : '?bgonly')).catch((e) => logErr('wallpaper load', e));
  win.once('ready-to-show', () => embed(d).catch((e) => logErr('embed', e)));
  win.webContents.on('did-finish-load', () => { sendPause(d); measureScale(d); });
  // a crashed renderer would leave a black desktop: load it again (a few times at most)
  win.webContents.on('render-process-gone', (_e, det) => {
    log('wallpaper renderer gone:', det && det.reason);
    if (!quitting && d.reloads++ < 5) setTimeout(() => { if (!quitting && !win.isDestroyed()) win.webContents.reload(); }, 3000);
  });
  win.on('closed', () => { const i = desk.indexOf(d); if (i >= 0) desk.splice(i, 1); updateMouseArea(); });
  win.on('session-end', () => quitApp({ fast: true }));   // log-off / shutdown: taskbar back, no slow theme switch
  desk.push(d);
}
let host = null;
async function embed(d) {
  if (d.win.isDestroyed() || quitting) return;
  const h = await shellOp('desktopHost', [true], 3000).catch(() => null) || W.desktopHost(false);
  if (d.win.isDestroyed() || quitting) return;
  if (!h) { log('desktop host not found'); return; }
  host = h;
  d.hwnd = W.fromHandleBuffer(d.win.getNativeWindowHandle());
  W.embed(d.hwnd, host, d.phys);
  d.win.showInactive();
  log('embedded', d.primary ? 'primary' : 'secondary', JSON.stringify(d.phys), 'scale', d.scale, host.mode);
  updateMouseArea();
  setTimeout(() => measureScale(d), 1500); setTimeout(() => measureScale(d), 6000);
}
// CSS pixels of the page vs. physical pixels of the monitor: measured, not assumed (mixed DPI)
function measureScale(d) {
  if (d.win.isDestroyed() || d.win.webContents.isDestroyed()) return;
  d.win.webContents.executeJavaScript('innerWidth').then((w) => {
    if (w > 0) { const s = d.phys.width / w; if (Math.abs(s - d.scale) > 0.01) { log('wallpaper scale', d.scale, '->', s); d.scale = s; } }
  }).catch(() => {});
}
// which monitor gets the widgets: config shell.widgets = 'left' | 'right' | 'primary' | 'bottom' (saved from the tray)
function widgetMonitor(mons) {
  const want = shellCfg().widgets || 'primary';
  const by = { left: (a, b) => a.x - b.x, right: (a, b) => b.x - a.x, bottom: (a, b) => b.y - a.y };
  return by[want] ? [...mons].sort(by[want])[0] : mons.find((m) => m.primary) || mons[0];
}
function buildDesktops(mons) {
  for (const d of [...desk]) { try { if (!d.win.isDestroyed()) d.win.destroy(); } catch {} }
  desk.length = 0;
  const wm = widgetMonitor(mons);
  for (const m of mons) makeDesktop(m, m === wm);
  updateMouseArea();
}
// rebuild only when the monitors really change (fullscreen video etc. fire metric changes all the time)
let layoutKey = '';
function rebuild(force) {
  if (quitting) return;
  let mons; try { mons = W.monitors(); } catch (e) { return logErr('monitors', e); }
  if (!mons.length) return;
  const key = mons.map(monKey).sort().join('|');
  if (!force && key === layoutKey && desk.length === mons.length) return;
  log('layout', key);
  layoutKey = key;
  buildRails(railOn() ? mons : []);
  buildDesktops(mons);
}
let rebuildT = null;
const rebuildLater = (ms) => { clearTimeout(rebuildT); rebuildT = setTimeout(() => { rebuildT = null; rebuild(false); }, ms || 1500); };
function setWidgets(where) { setShell({ widgets: where }); try { buildDesktops(W.monitors()); } catch (e) { logErr('widgets', e); } buildTray(); }
// Explorer restart / lost parent / moved window: put things back. Cheap, local calls only.
function watchdog() {
  if (quitting) return;
  try {
    if (worker && workerOk && Date.now() - lastAlive > 20000) logErr('helper thread', 'no heartbeat for 20 s (Explorer not responding?)');
    const h = W.desktopHost(false);
    if (h && host && h.parent !== host.parent) {   // new Progman = Explorer was restarted: our child windows and app bars died with it
      log('Explorer restarted: rebuilding'); host = null;
      if (railOn()) takeOverTaskbar().catch(() => {});
      setTimeout(() => rebuild(true), 2500);
      return;
    }
    if (h) for (const d of desk) {
      if (!d.hwnd || d.win.isDestroyed()) continue;
      if (W.parentOf(d.hwnd) !== h.parent) { log('re-embed'); host = h; W.embed(d.hwnd, h, d.phys); }
      else if (!W.sameRect(W.rect(d.hwnd), d.phys)) { logErr('wallpaper moved', JSON.stringify(W.rect(d.hwnd))); host = h; W.placeChild(d.hwnd, h, d.phys); measureScale(d); }
    }
    for (const r of rails) railGuard(r);
    if (layoutKey && !rebuildT && desk.length !== layoutKey.split('|').length) rebuildLater(1000);
  } catch (e) { logErr('watchdog', e); }
}

// ---------------- clicks on the wallpaper (it sits under the icon layer) ----------------
// The helper thread watches the cursor and tells us only when it moves / clicks over the bare desktop.
function updateMouseArea() {
  const d = desk.find((x) => x.primary && x.hwnd && !x.paused && !x.win.isDestroyed());
  pushCfg({ desk: d && !quitting ? d.phys : null });
}
function onMouse(m) {
  const d = desk.find((x) => x.primary);
  if (!d || d.paused || quitting || d.win.isDestroyed()) return;
  const wc = d.win.webContents;
  if (wc.isDestroyed() || wc.isCrashed()) return;
  const x = m.x < 0 ? -10 : Math.round(m.x / d.scale), y = m.y < 0 ? -10 : Math.round(m.y / d.scale);
  if (m.type === 'mouseMove') wc.sendInputEvent({ type: 'mouseMove', x, y });
  else wc.sendInputEvent({ type: m.type, x, y, button: 'left', clickCount: 1 });
}

// ---------------- pause a screen while its desktop is covered / the session is locked ----------------
function sendPause(d) {
  if (d.win.isDestroyed() || d.win.webContents.isDestroyed()) return;
  d.win.webContents.executeJavaScript(`window.nwPause && window.nwPause(${!!d.paused})`).catch(() => {});
}
function applyCover() {
  const s = lastSnap; let changed = false;
  for (const d of desk) {
    const i = s ? s.mons.indexOf(monKey(d.mon)) : -1;
    const paused = locked || (i >= 0 && !!s.covered[i]);
    if (paused !== d.paused) { d.paused = paused; sendPause(d); changed = true; }
  }
  if (changed) updateMouseArea();
}

// ---------------- windows: panel + launcher ----------------
function openPanel() {
  if (quitting) return;
  if (panelWin && !panelWin.isDestroyed()) { if (panelWin.isMinimized()) panelWin.restore(); panelWin.show(); panelWin.focus(); return; }
  panelWin = new BrowserWindow({ width: 470, height: 790, resizable: false, maximizable: false, title: 'Nullwave', icon: ICON,
    backgroundColor: '#0f0a1e', autoHideMenuBar: true, titleBarStyle: 'hidden', titleBarOverlay: { color: '#0f0a1e', symbolColor: '#a9a8c2', height: 32 } });
  const win = panelWin;
  win.loadURL(`http://127.0.0.1:${CFG.port}/panel?k=${CFG.key}&app=1`).catch((e) => log('panel load', e.message));
  // the panel is the one window of ours that gets a button on the rail
  const allow = () => { try { pushCfg({ allowOwn: win.isDestroyed() ? [] : [W.fromHandleBuffer(win.getNativeWindowHandle())] }); } catch {} };
  win.once('ready-to-show', allow); allow();
  win.on('closed', () => { if (panelWin === win) panelWin = null; pushCfg({ allowOwn: [] }); });
}

// ---- TP-Link password for the ports widget: a small dialog; the value goes straight to the hub's encrypted store ----
let passWin = null;
function openTlPassword() {
  if (quitting) return;
  if (passWin && !passWin.isDestroyed()) { passWin.show(); passWin.focus(); return; }
  passWin = new BrowserWindow({ width: 420, height: 300, resizable: false, maximizable: false, minimizable: false, title: 'Nullwave · heslo TP-Linku', icon: ICON,
    backgroundColor: '#0f0a1e', autoHideMenuBar: true, webPreferences: { preload: path.join(__dirname, 'tl-password-preload.js'), contextIsolation: true } });
  const win = passWin;
  win.setMenu(null);
  win.loadFile(path.join(__dirname, 'tl-password.html')).catch((e) => logErr('password dialog', e));
  win.on('closed', () => { if (passWin === win) passWin = null; });
}
const fromPass = (e) => !!passWin && !passWin.isDestroyed() && passWin.webContents === e.sender;
ipcMain.handle('tlpass-info', (e) => { if (!fromPass(e)) return null; try { return hub.ports.passwordInfo(); } catch (err) { return { ok: false, error: err.message }; } });
ipcMain.handle('tlpass-set', (e, value) => {
  if (!fromPass(e)) return null;
  try { const r = hub.ports.setPassword(typeof value === 'string' ? value : ''); log('TP-Link password', value ? 'stored' : 'removed'); return r; }   // the value itself is never logged
  catch (err) { return { ok: false, error: err.message }; }
});
ipcMain.handle('tlpass-close', (e) => { if (fromPass(e) && passWin) passWin.close(); });

// ---- installed applications (Start menu shortcuts): scanned in the background, never blocking ----
let apps = [], appsP = null, iconsP = null;
const tick = () => new Promise((r) => setImmediate(r));
async function scanApps() {
  const roots = [path.join(process.env.ProgramData || 'C:\\ProgramData', 'Microsoft', 'Windows', 'Start Menu', 'Programs'),
    path.join(process.env.APPDATA || '', 'Microsoft', 'Windows', 'Start Menu', 'Programs')];
  const out = new Map();
  const walk = async (dir, depth) => {
    let items = []; try { items = await fsp.readdir(dir, { withFileTypes: true }); } catch { return; }
    for (const it of items) {
      const p = path.join(dir, it.name);
      if (it.isDirectory()) { if (depth < 3) await walk(p, depth + 1); }
      else if (/\.(lnk|url)$/i.test(it.name)) {
        const name = it.name.replace(/\.(lnk|url)$/i, '');
        if (/uninstall|odinstal|readme|help|nápověda|website|documentation/i.test(name)) continue;
        if (!out.has(name.toLowerCase())) out.set(name.toLowerCase(), { name, path: p });
      }
    }
  };
  for (const r of roots) await walk(r, 0);
  const list = [...out.values()];
  list.push({ name: 'Průzkumník souborů', path: 'explorer.exe', special: true }, { name: 'Nastavení Windows', path: 'ms-settings:', special: true });
  return list.sort((a, b) => a.name.localeCompare(b.name, 'cs'));
}
const loadApps = () => appsP || (appsP = scanApps().then((l) => { apps = l; return l; }, (e) => { logErr('app scan', e); return apps; }));
function readLink(p) { try { return shell.readShortcutLink(p); } catch { return null; } }
async function iconFor(item) {
  if (item.icon !== undefined) return item.icon;
  let icon = null;
  try {
    let target = item.path;
    if (item.special) target = item.path === 'explorer.exe' ? 'C:\\Windows\\explorer.exe' : 'C:\\Windows\\ImmersiveControlPanel\\SystemSettings.exe';
    else if (/\.lnk$/i.test(target)) { const l = readLink(target); if (l) { if (l.icon && fs.existsSync(l.icon)) target = l.icon; else if (l.target && fs.existsSync(l.target)) target = l.target; } }
    icon = (await app.getFileIcon(target, { size: 'large' })).toDataURL();
  } catch {}
  item.icon = icon;
  return icon;
}
// icons for the launcher: one at a time with a breath in between (hundreds of shortcuts)
const loadAllIcons = () => iconsP || (iconsP = (async () => { await loadApps(); for (const a of apps) { if (quitting) break; await iconFor(a); await tick(); } })().catch((e) => logErr('icons', e)));
async function appList() {
  await loadAllIcons();
  const known = new Set(apps.map((a) => a.path));
  return { all: apps.map(({ name, path: p, icon }) => ({ name, path: p, icon })), pinned: (pins || []).map((p) => p.path).filter((p) => known.has(p)).slice(0, 10) };
}
function openLauncher() {
  if (quitting) return;
  const disp = screen.getDisplayNearestPoint(screen.getCursorScreenPoint());
  if (!launcherWin || launcherWin.isDestroyed()) {
    launcherWin = new BrowserWindow({ show: false, frame: false, transparent: true, skipTaskbar: true, alwaysOnTop: true, resizable: false,
      icon: ICON, webPreferences: { preload: path.join(__dirname, 'launcher-preload.js'), contextIsolation: true, sandbox: false } });
    const win = launcherWin;
    win.setMenu(null);
    win.loadFile(path.join(__dirname, 'launcher.html')).catch((e) => logErr('launcher load', e));
    win.on('blur', () => { if (!win.isDestroyed()) win.hide(); });
    win.on('closed', () => { if (launcherWin === win) launcherWin = null; });
  }
  const win = launcherWin, wc = win.webContents;
  win.setBounds(disp.bounds);
  win.show(); win.focus();
  const tell = () => { if (!win.isDestroyed() && !wc.isDestroyed()) wc.send('nw-open'); };
  if (wc.isLoading()) wc.once('did-finish-load', tell); else tell();
}
const hideLauncher = () => { if (launcherWin && !launcherWin.isDestroyed()) launcherWin.hide(); };
function spawnDetached(exe, args) { try { const p = spawn(exe, args, { detached: true, stdio: 'ignore' }); p.on('error', (e) => log('launch', exe, e.message)); p.unref(); } catch (e) { log('launch', exe, e.message); } }
// start a shortcut, an exe, a packaged (Store) app or one of the specials
function openTarget(p, aumid) {
  if (aumid) return spawnDetached('explorer.exe', ['shell:AppsFolder\\' + aumid]);
  if (!p) return;
  if (p === 'ms-settings:') return void shell.openExternal(p).catch(() => {});
  if (p === 'explorer.exe') p = app.getPath('home');
  shell.openPath(p).then((err) => { if (err) log('launch', p, err); }).catch(() => {});
}
ipcMain.handle('nw-apps', () => appList());
ipcMain.handle('nw-launch', (_e, p) => {
  hideLauncher();
  if (typeof p !== 'string' || !apps.some((a) => a.path === p)) return;   // only what the launcher was given
  openTarget(p);
});
ipcMain.handle('nw-hide', () => hideLauncher());
ipcMain.handle('nw-panel', () => { hideLauncher(); openPanel(); });

// ---------------- rail: our taskbar on every monitor ----------------
const RAIL_W = 64;    // DIP on every monitor
const rails = [];     // { win, mon, key, rect (physical px), hwnd, ready, bar, hidden, sig, groups }
const TB_STATE_FILE = path.join(path.dirname(LOG_FILE), 'taskbar-state.json');
let peekT = null, peeking = false, lastFg = 0, tbTaken = false, tbVertical = false;
async function takeOverTaskbar() {
  if (!fs.existsSync(TB_STATE_FILE)) {   // keep the user's original (survives a crash: the file stays until we give it back)
    const st = await shellOp('taskbarState');
    fs.writeFileSync(TB_STATE_FILE, JSON.stringify({ state: st }));
  }
  tbTaken = true;
  // a vertical Windows taskbar lives on the same screen edge as the rail (it would be hidden behind it while peeking)
  try { tbVertical = W.trayRects().some((r) => r.bottom - r.top > r.right - r.left); } catch {}
  pushCfg({ hideTrays: true, refit: true, peekUntil: 0 });
  await tryOp('setTaskbarState', [1]);     // auto-hide: frees the screen edge for our rail
  W.showTrays(false);
}
// Windows taskbar back exactly as it was; our app bars are removed while their windows still exist
async function giveBackTaskbar() {
  clearTimeout(peekT); clearInterval(peekWatch); peekWatch = null; peeking = false;
  pushCfg({ hideTrays: false, refit: false, peekUntil: 0 });
  let st = 0, known = false; try { st = JSON.parse(fs.readFileSync(TB_STATE_FILE, 'utf8')).state | 0; known = true; } catch {}
  const hwnds = rails.filter((r) => r.hwnd).map((r) => r.hwnd);
  if (hwnds.length) await tryOp('appbarRemove', [hwnds], 3000);
  for (const r of rails) r.bar = false;
  W.showTrays(true);                        // posted, cannot block
  if (!tbTaken && !known) return;
  const ok = await tryOp('setTaskbarState', [st], 3000);
  W.showTrays(true);
  if (ok) { tbTaken = false; try { fs.unlinkSync(TB_STATE_FILE); } catch {} }   // on failure the file stays for the next start / restore-windows.ps1
}
function railRect(m) {
  const s = Math.min(m.scale || 1, Number(shellCfg().railMaxScale) || 99);   // optional cap for very dense screens
  return { x: m.x, y: m.y, width: Math.round(RAIL_W * s), height: m.height };
}
// old rails: app bar off first, then the windows
async function retireRails(old) {
  for (const r of old) r.retired = true;
  const hwnds = old.filter((r) => r.hwnd).map((r) => r.hwnd);
  if (hwnds.length) await tryOp('appbarRemove', [hwnds], 3000);
  for (const r of old) { try { if (!r.win.isDestroyed()) r.win.destroy(); } catch {} }
}
function buildRails(mons) {
  if (rails.length) retireRails(rails.splice(0));
  if (quitting) return;
  for (const m of mons) {
    const rect = railRect(m);
    const dip = screen.screenToDipRect(null, rect);
    const win = new BrowserWindow({ x: dip.x, y: dip.y, width: Math.max(1, dip.width), height: Math.max(1, dip.height), frame: false, thickFrame: false, roundedCorners: false,
      skipTaskbar: true, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false,
      show: false, alwaysOnTop: true, hasShadow: false, backgroundColor: '#0f0a1e', icon: ICON, title: 'Nullwave rail',
      webPreferences: { preload: path.join(__dirname, 'rail-preload.js'), contextIsolation: true } });
    win.setMenu(null); win.setAlwaysOnTop(true, 'floating');
    const r = { win, mon: m, key: monKey(m), rect, primary: m.primary, hwnd: 0, ready: false, bar: false, barTries: 0, barAt: 0, moved: 0, hidden: false, retired: false, sig: '', groups: new Map() };
    win.loadFile(path.join(__dirname, 'rail.html')).catch((e) => logErr('rail load', e));
    win.once('ready-to-show', () => railReady(r).catch((e) => logErr('rail ready', e)));
    win.webContents.on('did-finish-load', () => { r.sig = ''; railDirty(); railReady(r).catch((e) => logErr('rail ready', e)); });
    win.webContents.on('render-process-gone', (_e, det) => {
      log('rail renderer gone:', det && det.reason);
      setTimeout(() => { if (!quitting && !r.retired && !win.isDestroyed()) win.webContents.reload(); }, 2000);
    });
    rails.push(r);
  }
}
async function railReady(r) {
  if (r.ready || r.retired || quitting || r.win.isDestroyed()) return;
  r.ready = true;
  r.hwnd = W.fromHandleBuffer(r.win.getNativeWindowHandle());
  r.barAt = Date.now();
  r.bar = (await tryOp('appbarNew', [r.hwnd, r.rect, 0])) === true;   // ABE_LEFT
  if (r.retired || quitting || r.win.isDestroyed()) return;
  W.setPos(r.hwnd, r.rect);
  if (!r.hidden) r.win.showInactive();
  W.setPos(r.hwnd, r.rect);
  log('rail', r.key, 'at', JSON.stringify(r.rect), r.bar ? 'app bar ok' : 'NO app bar');
  railDirty(); poke(200);
  setTimeout(() => railGuard(r), 500); setTimeout(() => railGuard(r), 2500);
}
// the rail must sit exactly on its strip in physical pixels (a DPI change message may have resized it)
function railGuard(r) {
  if (quitting || r.retired || !r.hwnd || r.win.isDestroyed()) return;
  const cur = W.rect(r.hwnd);
  // Windows pushes top-level windows out of a strip that has just been reserved - including the rail that reserved it
  if (!W.sameRect(cur, r.rect)) { W.setPos(r.hwnd, r.rect); if (r.moved++ > 2) logErr('rail moved ' + r.key, JSON.stringify(cur)); }
}
ipcMain.on('rail-metrics', (e, m) => {
  const r = rails.find((x) => !x.win.isDestroyed() && x.win.webContents === e.sender);
  if (r && m) log('rail', r.key, `css ${m.iw}x${m.ih} dpr ${m.dpr} -> zoom ${m.z}`);
});

// ---- icons ----
const iconCache = new Map();   // exe -> data URL | null (asked once per exe, never in a loop)
function exeIcon(exe) {
  if (!exe) return null;
  const k = exe.toLowerCase();
  if (!iconCache.has(k)) {
    iconCache.set(k, null);
    app.getFileIcon(exe, { size: 'large' }).then((i) => { iconCache.set(k, i.toDataURL()); railDirty(); }).catch(() => {});
  }
  return iconCache.get(k);
}
// packaged (Store / UWP) apps: logo and launch id come from the package manifest
const isPackaged = (exe) => /\\windowsapps\\/i.test(exe || '');
const uwpCache = new Map();    // exe -> { icon, aumid } | null
function uwpInfo(exe) {
  if (!exe) return null;
  const k = exe.toLowerCase();
  if (uwpCache.has(k)) return uwpCache.get(k);
  uwpCache.set(k, null);
  readUwp(exe).then((u) => { if (u) { uwpCache.set(k, u); railDirty(); } }).catch(() => {});
  return null;
}
async function readUwp(exe) {
  let dir = path.dirname(exe), xml = null;
  for (let i = 0; i < 3 && xml === null; i++) {
    try { xml = await fsp.readFile(path.join(dir, 'AppxManifest.xml'), 'utf8'); }
    catch { const up = path.dirname(dir); if (up === dir) break; dir = up; }
  }
  if (xml === null) return null;
  const base = path.basename(exe).toLowerCase();
  const list = [...xml.matchAll(/<Application\b([^>]*)>([\s\S]*?)<\/Application>/g)];
  const one = list.find((a) => ((/\bExecutable="([^"]+)"/.exec(a[1]) || [])[1] || '').toLowerCase().endsWith(base)) || list[0];
  if (!one) return null;
  const id = (/\bId="([^"]+)"/.exec(one[1]) || [])[1];
  const pkg = path.basename(dir).split('_');   // Name_Version_Arch_Resource_PublisherId
  const aumid = id && pkg.length >= 5 ? `${pkg[0]}_${pkg[pkg.length - 1]}!${id}` : null;
  const logo = (/Square44x44Logo="([^"]+)"/.exec(one[2]) || /Square44x44Logo="([^"]+)"/.exec(xml) || [])[1];
  return { aumid, icon: logo ? await logoFile(path.join(dir, logo)) : null };
}
async function logoFile(p) {
  const d = path.dirname(p), ext = path.extname(p).toLowerCase(), stem = path.basename(p, path.extname(p)).toLowerCase();
  let files = []; try { files = await fsp.readdir(d); } catch { return null; }
  const c = files.filter((f) => { const l = f.toLowerCase(); return l.startsWith(stem + '.') && l.endsWith(ext); });
  let pick = null;
  for (const q of ['targetsize-48_altform-unplated', 'targetsize-32_altform-unplated', 'targetsize-64_altform-unplated', 'targetsize-48', 'targetsize-32', 'scale-200', 'scale-150', 'scale-100']) {
    pick = c.find((f) => f.toLowerCase() === `${stem}.${q}${ext}`); if (pick) break;
  }
  pick = pick || c.find((f) => f.toLowerCase() === stem + ext) || c[0];
  if (!pick) return null;
  const b = await fsp.readFile(path.join(d, pick));
  return b.length < 400000 ? `data:image/${ext === '.png' ? 'png' : 'jpeg'};base64,` + b.toString('base64') : null;
}
let ownIcon = null;
function iconOf(w) {
  if (w.own) return ownIcon || (ownIcon = nativeImage.createFromPath(ICON).resize({ width: 48, height: 48 }).toDataURL());
  if (w.exe && (w.uwp || isPackaged(w.exe))) { const u = uwpInfo(w.exe); if (u && u.icon) return u.icon; }
  return exeIcon(w.exe);
}
const appName = (w) => (w.own ? 'Nullwave' : w.uwp || !w.exe ? w.title : path.basename(w.exe).replace(/\.exe$/i, ''));

// ---- pins: config shell.pins = [{ name, path, exe?, aumid? }]; first run picks a sensible default ----
const PIN_PREF = ['terminal', 'průzkumník', 'visual studio code', 'opera', 'spotify', 'qbittorrent', 'steam', 'discord', 'nastavení windows', 'chrome', 'edge', 'obs'];
let pins = null;
function defaultPins() {
  const out = [];
  for (const pref of PIN_PREF) {
    const a = apps.find((x) => x.name.toLowerCase().includes(pref) && !out.includes(x));
    if (a) out.push(a);
    if (out.length === 10) break;
  }
  return out.map((a) => ({ name: a.name, path: a.path }));
}
async function resolvePin(e) {
  if (!e || typeof e.path !== 'string') return null;
  const p = { key: 'pin:' + e.path, name: e.name || path.basename(e.path), path: e.path, exe: e.exe ? String(e.exe).toLowerCase() : null, base: null, dir: null, aumid: e.aumid || null, icon: null };
  try {
    if (e.path === 'explorer.exe') { p.exe = 'c:\\windows\\explorer.exe'; p.icon = await iconFor({ path: e.path, special: true }); }
    else if (e.path === 'ms-settings:') p.icon = await iconFor({ path: e.path, special: true });
    else if (p.aumid) {   // packaged app: the folder name carries the version, match on package name + exe name
      const m = p.exe && /^(.*\\windowsapps\\[^_\\]+_)/.exec(p.exe);
      if (m) { p.dir = m[1]; p.base = path.basename(p.exe); }
      const u = p.exe ? await readUwp(p.exe).catch(() => null) : null;
      p.icon = (u && u.icon) || null;
    } else if (/\.lnk$/i.test(e.path)) {
      const l = readLink(e.path);
      if (l && l.target) {
        p.exe = l.target.toLowerCase();
        // the window often belongs to a copy in a versioned sub-folder (Discord: app-1.0.x\Discord.exe, started through
        // "--processStart Name.exe"): the same exe name anywhere below the shortcut's folder is the same app
        const m = /--processStart[= ]"?([^"\s]+\.exe)/i.exec(l.args || '');
        p.base = (m ? m[1] : path.basename(l.target)).toLowerCase();
        p.dir = path.dirname(l.target).toLowerCase() + '\\';
      }
      p.icon = await iconFor({ path: e.path });
    } else { if (/\.exe$/i.test(e.path)) p.exe = e.path.toLowerCase(); p.icon = await iconFor({ path: e.path }); }
  } catch (err) { logErr('pin', err); }
  return p;
}
async function loadPins() {
  let list = Array.isArray(shellCfg().pins) ? shellCfg().pins : null;
  if (!list) { await loadApps(); list = defaultPins(); }
  pins = (await Promise.all(list.map(resolvePin))).filter(Boolean);
  railDirty();
}
function savePins(list) {
  setShell({ pins: list.map((p) => { const o = { name: p.name, path: p.path }; if (p.aumid) { o.aumid = p.aumid; o.exe = p.exe; } return o; }) });
  loadPins().catch((e) => logErr('pins', e));
}
function pinMatch(p, exe) {
  if (!exe) return false;
  if (p.exe && exe === p.exe) return true;
  return !!(p.base && exe.endsWith('\\' + p.base) && (!p.dir || exe.startsWith(p.dir)));
}

// ---- rail content: pinned apps (fixed order), then every other running app in the order it appeared ----
const seq = new Map(); let seqN = 0;
const mru = new Map(); let mruN = 0, mruTop = 0;   // window -> activation counter
let dirtyT = null;
function railDirty() { if (!dirtyT) dirtyT = setTimeout(() => { dirtyT = null; renderRails(); }, 80); }
function renderRails() {
  const s = lastSnap;
  if (quitting || !s || !rails.length) return;
  // active window: clicking the rail makes the rail itself foreground, so remember the last real one
  if (s.fg.h && s.wins.some((w) => w.id === s.fg.h)) lastFg = s.fg.h;
  else if (s.fg.desk || (lastFg && !s.wins.some((w) => w.id === lastFg))) lastFg = 0;
  // activation order per window (a click on an app goes to its most recently used window);
  // windows we have not seen active yet are ranked by their z-order
  const ids = new Set();
  s.wins.forEach((w, i) => { ids.add(w.id); if (!mru.has(w.id)) mru.set(w.id, -1 - i); });
  for (const h of mru.keys()) if (!ids.has(h)) mru.delete(h);
  if (lastFg && lastFg !== mruTop) { mruTop = lastFg; mru.set(lastFg, ++mruN); }
  const everywhere = shellCfg().railApps !== 'monitor';   // "all" (default): every rail lists every window, like Windows' "all taskbars"
  const status = { ...hub.health(), net: netType() }, alive = new Set();
  for (const r of rails) {
    if (!r.ready || r.retired || r.win.isDestroyed()) continue;
    const mi = s.mons.indexOf(r.key);
    // fullscreen app on this monitor (video, game): get out of the way like the real taskbar
    const full = (peeking && tbVertical && r.primary) || (mi >= 0 && !!s.full[mi]);   // peeking at a taskbar on our edge: that rail steps aside
    if (full !== r.hidden) { r.hidden = full; if (full) r.win.hide(); else { r.win.showInactive(); W.setPos(r.hwnd, r.rect); } }
    // our strip must be reserved in the work area; if Explorer lost the app bar, register it again (a few times)
    if (mi >= 0 && !full && s.work[mi].x < r.rect.x + r.rect.width - 1 && r.barTries < 3 && Date.now() - r.barAt > 3000) {
      r.barTries++; r.barAt = Date.now();
      log('rail', r.key, 'strip not reserved (work area x', s.work[mi].x + '): registering the app bar again');
      tryOp('appbarNew', [r.hwnd, r.rect, 0]).then((ok) => { r.bar = ok === true; poke(300); });
    }
    const own = everywhere ? s.wins : s.wins.filter((w) => w.mon === mi);
    const groups = new Map(), items = [], used = new Set();
    const item = (key, ws, pin, name, icon) => ({ key, pin, run: ws.length > 0, act: ws.some((w) => w.id === lastFg), min: ws.length > 0 && ws.every((w) => w.min), n: ws.length,
      title: ws.length === 0 ? name : ws.length === 1 ? ws[0].title : `${name} · ${ws.length} okna`, icon: icon || null });
    for (const p of pins || []) {
      const ws = own.filter((w) => !used.has(w.id) && pinMatch(p, (w.exe || '').toLowerCase()));
      ws.forEach((w) => used.add(w.id));
      groups.set(p.key, { pin: p, ws });
      items.push(item(p.key, ws, true, p.name, p.icon || (ws[0] && iconOf(ws[0]))));
    }
    const rest = new Map();
    for (const w of own) {
      if (used.has(w.id)) continue;
      const k = 'app:' + (w.own ? 'nullwave' : w.exe ? w.exe.toLowerCase() : 'hwnd' + w.id);
      if (!rest.has(k)) rest.set(k, []);
      rest.get(k).push(w);
      if (!seq.has(k)) seq.set(k, ++seqN);
      alive.add(k);
    }
    const keys = [...rest.keys()].sort((a, b) => seq.get(a) - seq.get(b));
    if (keys.length && items.length) items.push({ key: 'sep', sep: true });
    for (const k of keys) { const ws = rest.get(k); groups.set(k, { pin: null, ws }); items.push(item(k, ws, false, appName(ws[0]), iconOf(ws[0]))); }
    r.groups = groups;
    // send only real changes (icons compared by length: they are long)
    const sig = JSON.stringify([items.map((i) => [i.key, i.run, i.act, i.min, i.n, i.title, i.icon ? i.icon.length : 0]), status, r.primary]);
    if (sig !== r.sig && !r.win.webContents.isDestroyed()) { r.sig = sig; r.win.webContents.send('rail-update', { items, status, primary: r.primary }); }
  }
  for (const k of seq.keys()) if (!alive.has(k)) seq.delete(k);
}
let workKey = '';
function onSnap() {
  const s = lastSnap;
  // work area changed (an app bar came or went): put the rails back on their strips right away
  const wk = JSON.stringify(s.work);
  if (wk !== workKey) { workKey = wk; for (const r of rails) railGuard(r); setTimeout(() => { for (const r of rails) railGuard(r); }, 300); }
  // monitors changed (resolution, DPI, plugged in / out)? Electron's own events are only a hint.
  if (layoutKey && !rebuildT && s.mons.slice().sort().join('|') !== layoutKey) rebuildLater(1500);
  applyCover();
  renderRails();
}

// ---- rail actions ----
const liveWins = (g) => g.ws.filter((w) => W.isWindow(w.id));
function launchGroup(g) {
  if (g.pin) return openTarget(g.pin.path.startsWith('uwp:') ? null : g.pin.path, g.pin.aumid);
  const w = g.ws[0]; if (!w) return;
  if (w.own) return openPanel();
  if (w.exe && (w.uwp || isPackaged(w.exe))) { const u = uwpInfo(w.exe); if (u && u.aumid) return openTarget(null, u.aumid); if (w.uwp) return; }
  openTarget(w.exe);
}
function canLaunch(g) {
  if (g.pin) return true;
  const w = g.ws[0]; if (!w || !w.exe) return false;
  if (w.uwp) { const u = uwpInfo(w.exe); return !!(u && u.aumid); }
  return true;
}
function focusWin(w) {
  if (!W.activate(w.id)) logErr('activate', 'Windows refused to bring "' + String(w.title).slice(0, 40) + '" to the front');
  lastFg = w.id; renderRails(); poke(150);
}
// Left click on an app, like the Windows taskbar: its active window is minimized; otherwise its most
// recently used window comes to the front (restored if it was minimized). Never a chooser.
function clickGroup(ws) {
  const active = ws.find((w) => w.id === lastFg && !W.f.IsIconic(w.id));
  if (active) { W.minimize(active.id); lastFg = 0; mruTop = 0; renderRails(); poke(150); return; }
  const rank = (w) => (mru.has(w.id) ? mru.get(w.id) : -1e9);
  focusWin(ws.slice().sort((a, b) => rank(b) - rank(a))[0]);
}
const menuLabel = (t) => { t = String(t || '').replace(/&/g, '&&'); return t.length > 60 ? t.slice(0, 58) + '…' : t; };
function railMenu(r, g, ws, onlyWindows) {
  const t = [];
  for (const w of ws.slice(0, 15)) t.push({ label: menuLabel(w.title), type: 'checkbox', checked: w.id === lastFg, click: () => focusWin(w) });
  if (!onlyWindows) {
    if (ws.length) t.push({ type: 'separator' });
    t.push({ label: ws.length ? 'Nové okno' : 'Spustit', enabled: canLaunch(g), click: () => launchGroup(g) });
    if (g.pin) t.push({ label: 'Odepnout z lišty', click: () => savePins((pins || []).filter((p) => p !== g.pin)) });
    else if (!(ws[0] && ws[0].own)) t.push({ label: 'Připnout na lištu', enabled: canLaunch(g), click: () => pinGroup(g) });
    if (ws.length) {
      t.push({ type: 'separator' });
      if (ws.length === 1 && !W.f.IsIconic(ws[0].id)) t.push({ label: 'Minimalizovat', click: () => { W.minimize(ws[0].id); poke(150); } });
      t.push({ label: ws.length > 1 ? `Zavřít všechna okna (${ws.length})` : 'Zavřít okno', click: () => { for (const w of ws) W.closeWin(w.id); poke(400); } });
    }
  }
  if (t.length && !r.win.isDestroyed()) Menu.buildFromTemplate(t).popup({ window: r.win });
}
function pinGroup(g) {
  const w = g.ws[0]; if (!w || !w.exe) return;
  let e;
  if (w.uwp || isPackaged(w.exe)) { const u = uwpInfo(w.exe); if (u && u.aumid) e = { name: w.uwp ? w.title : appName(w), path: 'uwp:' + u.aumid, exe: w.exe.toLowerCase(), aumid: u.aumid }; }
  if (!e) { if (w.uwp) return; e = { name: appName(w), path: w.exe }; }
  if ((pins || []).some((p) => p.path.toLowerCase() === e.path.toLowerCase())) return;
  savePins([...(pins || []), e]);
}
ipcMain.handle('rail-click', (e, key, how) => {
  try {
    const r = rails.find((x) => !x.win.isDestroyed() && x.win.webContents === e.sender);
    const g = r && r.groups.get(String(key)); if (!g) return;
    const ws = liveWins(g);
    if (how === 'context') return void railMenu(r, g, ws, false);
    if (how === 'middle' || !ws.length) return void launchGroup(g);
    clickGroup(ws);
  } catch (err) { logErr('rail click', err); }
});
ipcMain.handle('rail-launcher', () => openLauncher());
// shell buttons on the rail: the real Windows features, opened with their own keyboard shortcuts
// (Win key combinations and the volume keys only; nothing here ever presses Alt)
const VK = { win: 0x5B, tab: 0x09, a: 0x41, d: 0x44, n: 0x4E, s: 0x53, mute: 0xAD, voldown: 0xAE, volup: 0xAF };
const SYS = { start: [VK.win], search: [VK.win, VK.s], taskview: [VK.win, VK.tab], quick: [VK.win, VK.a], notif: [VK.win, VK.n], desktop: [VK.win, VK.d],
  volup: [VK.volup], voldown: [VK.voldown], mute: [VK.mute] };
ipcMain.handle('rail-sys', (e, what) => {
  try {
    if (quitting || !rails.some((x) => !x.win.isDestroyed() && x.win.webContents === e.sender)) return;
    const k = Object.prototype.hasOwnProperty.call(SYS, what) ? SYS[what] : null;
    if (k) { W.keys(k); poke(300); }
  } catch (err) { logErr('rail sys', err); }
});
// ---- peek: the real Windows taskbar on the primary monitor, until the mouse leaves it (fallback of the tray flyout) ----
let peekWatch = null;
function endPeek() {
  clearTimeout(peekT); clearInterval(peekWatch); peekWatch = null;
  if (!peeking) return;
  peeking = false;
  if (quitting || !railOn()) return;
  pushCfg({ peekUntil: 0, refit: true });
  tryOp('setTaskbarState', [1]); W.showTrays(false); renderRails();
}
function startPeek() {
  if (quitting || !railOn()) return;
  hideTrayFlyout();
  clearTimeout(peekT); clearInterval(peekWatch); peeking = true;
  pushCfg({ peekUntil: Date.now() + 46000, refit: false });   // no window shuffling meanwhile
  tryOp('setTaskbarState', [0]); W.showTrays(true, true); renderRails();
  // done when the cursor has been away from the taskbar (and the flyouts it opens next to it) for a moment; 45 s at most
  const t0 = Date.now(); let away = 0;
  peekWatch = setInterval(() => {
    try {
      const p = W.pointer({ x: 0, y: 0, width: 0, height: 0 }), r = W.trayRects()[0];
      if (!p || !r) return endPeek();
      const dx = Math.max(r.left - p.x, 0, p.x - r.right), dy = Math.max(r.top - p.y, 0, p.y - r.bottom);
      away = dx > 420 || dy > 420 ? away + 1 : 0;
      if (Date.now() - t0 > 2500 && away >= 4) endPeek();
    } catch (e) { logErr('peek', e); endPeek(); }
  }, 300);
  peekT = setTimeout(endPeek, 45000);
}
ipcMain.handle('rail-peek', () => startPeek());

// ---------------- tray flyout: the notification-area icons, listed and clicked through tray-helper.exe ----------------
// The helper (UI Automation, see tray-helper.cs) is started on first use, talks JSON lines over stdin/stdout and is
// killed when idle. This thread never waits for it: every call is a promise with a timeout.
const TRAY_EXE = path.join(__dirname, 'tray-helper.exe'), TRAY_SRC = path.join(__dirname, 'tray-helper.cs');
let trayProc = null, trayBuf = '', trayId = 0, trayIdleT = null, trayBuildP = null;
const trayReqs = new Map();
// build the helper with the C# compiler that ships with Windows when the exe is missing or older than its source
function buildTrayHelper() {
  return trayBuildP || (trayBuildP = (async () => {
    const [exe, src] = await Promise.all([fsp.stat(TRAY_EXE).catch(() => null), fsp.stat(TRAY_SRC).catch(() => null)]);
    if (exe && (!src || exe.mtimeMs >= src.mtimeMs)) return true;
    if (!src) throw new Error('tray-helper.cs is missing');
    const csc = path.join(process.env.WINDIR || 'C:\\Windows', 'Microsoft.NET', 'Framework64', 'v4.0.30319', 'csc.exe');
    const tmp = TRAY_EXE + '.new';
    await new Promise((res, rej) => execFile(csc, ['/nologo', '/optimize+', '/platform:x64', '/out:' + tmp, '/r:System.Web.Extensions.dll', TRAY_SRC],
      { windowsHide: true, timeout: 40000 }, (e, so) => (e ? rej(new Error('csc: ' + String(so || e.message).trim().slice(0, 300))) : res())));
    await fsp.rename(tmp, TRAY_EXE);
    log('tray helper built');
    return true;
  })().finally(() => { trayBuildP = null; }));
}
function stopTrayHelper() {
  clearTimeout(trayIdleT);
  const p = trayProc; trayProc = null; trayBuf = '';
  for (const q of trayReqs.values()) { clearTimeout(q.t); q.reject(new Error('tray helper stopped')); }
  trayReqs.clear();
  if (p) { try { p.stdin.end(); } catch {} try { p.kill(); } catch {} }
}
async function startTrayHelper() {
  if (trayProc) return trayProc;
  await buildTrayHelper();
  if (trayProc || quitting) return trayProc;
  const p = trayProc = spawn(TRAY_EXE, [], { windowsHide: true, stdio: ['pipe', 'pipe', 'ignore'] });
  p.stdout.setEncoding('utf8');
  p.stdout.on('data', (d) => {
    if (trayProc !== p) return;
    trayBuf += d;
    let i;
    while ((i = trayBuf.indexOf('\n')) >= 0) {
      const line = trayBuf.slice(0, i).trim(); trayBuf = trayBuf.slice(i + 1);
      if (!line) continue;
      try { const m = JSON.parse(line), q = trayReqs.get(m.id); if (q) { trayReqs.delete(m.id); clearTimeout(q.t); q.resolve(m); } } catch (e) { logErr('tray helper output', e); }
    }
    if (trayBuf.length > 8e6) trayBuf = '';
  });
  const gone = (e) => { if (e && e.message) log('tray helper', e.message); if (trayProc === p) stopTrayHelper(); };
  p.on('error', gone); p.on('exit', () => gone()); p.stdin.on('error', () => {});
  return p;
}
async function trayCall(cmd, extra, timeout) {
  const p = await startTrayHelper();
  if (!p) throw new Error('tray helper not running');
  clearTimeout(trayIdleT); trayIdleT = setTimeout(stopTrayHelper, 45000);   // idle: no process left behind
  return new Promise((resolve, reject) => {
    const id = ++trayId;
    // no answer = it waits on a hung Explorer: drop the process, the next call starts a fresh one
    const t = setTimeout(() => { trayReqs.delete(id); reject(new Error(cmd + ' timed out')); if (trayProc === p) stopTrayHelper(); }, timeout || 6000);
    trayReqs.set(id, { resolve, reject, t });
    try { p.stdin.write(JSON.stringify({ id, cmd, ...(extra || {}) }) + '\n'); } catch (e) { trayReqs.delete(id); clearTimeout(t); reject(e); }
  });
}

let trayWin = null, trayAnchor = null, trayState = { state: 'loading', icons: [] }, trayGen = 0, trayPoll = null, traySig = '', trayBusy = false, trayShownAt = 0, trayHiddenAt = 0;
const TRAY_W = 300;
function trayRect() {
  const r = trayAnchor && trayAnchor.rail; if (!r) return null;
  const m = r.mon, s = r.rect.width / RAIL_W;   // same scale as the rail next to it
  const rows = trayState.state === 'ok' ? Math.max(1, Math.min(trayState.icons.length, 11)) : 2;
  const w = Math.round(TRAY_W * s), h = Math.min(Math.round((44 + rows * 38 + 86) * s), m.height - Math.round(16 * s));
  const y = Math.max(m.y + Math.round(8 * s), Math.min(Math.round(r.rect.y + trayAnchor.frac * r.rect.height) - h, m.y + m.height - h - Math.round(8 * s)));
  return { x: r.rect.x + r.rect.width + Math.round(8 * s), y, width: w, height: h };
}
function placeTray() {
  const rect = trayRect();
  if (!rect || !trayWin || trayWin.isDestroyed()) return;
  try { W.setPos(W.fromHandleBuffer(trayWin.getNativeWindowHandle()), rect); } catch (e) { logErr('tray place', e); }
}
function sendTray() {
  if (!trayWin || trayWin.isDestroyed() || trayWin.webContents.isDestroyed()) return;
  const sig = JSON.stringify([trayState.state, trayState.error, trayState.note, trayState.busy, (trayState.icons || []).map((i) => [i.key, i.label, i.sub, i.tip, i.icon ? i.icon.length : 0])]);
  if (sig === traySig) return;
  traySig = sig;
  placeTray();
  trayWin.webContents.send('tray-data', trayState);
}
const trayVisible = () => !!trayWin && !trayWin.isDestroyed() && trayWin.isVisible();
async function refreshTray() {
  if (trayBusy || quitting) return;
  trayBusy = true;
  try {
    const res = await trayCall('list');
    if (!res.ok) throw new Error(res.error || 'list failed');
    trayGen = res.gen;
    const icons = res.icons.map((i) => {
      const tip = String(i.name || '').trim(), first = tip.split('\n')[0].trim();
      // program name: the exe's description without its slogan ("qBittorrent - A Bittorrent Client" -> "qBittorrent")
      const appName = String(i.app || '').split(/ - |: /)[0].trim() || (i.exe ? path.basename(i.exe).replace(/\.exe$/i, '') : '');
      const label = first || appName || 'Neznámá ikona';
      return { key: i.key, label, sub: appName && appName.toLowerCase() !== label.toLowerCase() ? appName : '', tip: tip || appName, exe: i.exe || '',
        icon: i.png ? 'data:image/png;base64,' + i.png : (i.exe ? exeIcon(i.exe) : null) };
    });
    trayState = { state: 'ok', icons, note: trayState.note, noteErr: trayState.noteErr, busy: trayState.busy };
  } catch (e) {
    log('tray list', e.message);
    trayState = { state: 'error', icons: [], error: 'Ikony se nepodařilo načíst (' + e.message + ').' };
  } finally { trayBusy = false; }
  sendTray();
}
function hideTrayFlyout() {
  clearInterval(trayPoll); trayPoll = null;
  if (trayWin && !trayWin.isDestroyed() && trayWin.isVisible()) { trayHiddenAt = Date.now(); trayWin.hide(); }
}
function openTrayFlyout(rail, frac) {
  if (quitting) return;
  trayAnchor = { rail, frac: Math.min(1, Math.max(0, Number(frac) || 1)) };
  if (peeking) endPeek();
  if (!trayWin || trayWin.isDestroyed()) {
    const dip = screen.screenToDipRect(null, trayRect());
    trayWin = new BrowserWindow({ x: dip.x, y: dip.y, width: Math.max(1, dip.width), height: Math.max(1, dip.height), show: false, frame: false, thickFrame: false, roundedCorners: false, transparent: true,
      skipTaskbar: true, alwaysOnTop: true, resizable: false, movable: false, minimizable: false, maximizable: false, fullscreenable: false, hasShadow: false, icon: ICON, title: 'Nullwave tray',
      webPreferences: { preload: path.join(__dirname, 'tray-preload.js'), contextIsolation: true } });
    const win = trayWin;
    win.setMenu(null); win.setAlwaysOnTop(true, 'pop-up-menu');
    win.loadFile(path.join(__dirname, 'tray.html')).catch((e) => logErr('tray load', e));
    win.webContents.on('did-finish-load', () => { traySig = ''; sendTray(); });
    win.on('blur', () => { if (Date.now() - trayShownAt > 250) hideTrayFlyout(); });   // click anywhere else closes it
    win.on('closed', () => { if (trayWin === win) trayWin = null; clearInterval(trayPoll); trayPoll = null; });
  }
  trayState = { state: trayState.state === 'ok' ? 'ok' : 'loading', icons: trayState.icons || [] };   // last list right away, fresh one follows
  traySig = '';
  trayShownAt = Date.now();
  placeTray(); trayWin.show(); trayWin.focus(); placeTray();
  sendTray();
  refreshTray();
  clearInterval(trayPoll);
  trayPoll = setInterval(() => { if (trayVisible()) refreshTray(); else hideTrayFlyout(); }, 3000);   // tooltips change (speeds, status)
}
ipcMain.handle('rail-tray', (e, frac) => {
  try {
    const r = rails.find((x) => !x.win.isDestroyed() && x.win.webContents === e.sender); if (!r) return;
    // the button toggles; a click on it while the flyout is open has already closed it (focus moved to the rail)
    if (trayVisible() || Date.now() - trayHiddenAt < 400 || Date.now() - trayShownAt < 300) return void hideTrayFlyout();
    openTrayFlyout(r, frac);
  } catch (err) { logErr('tray open', err); }
});
const fromTray = (e) => !!trayWin && !trayWin.isDestroyed() && trayWin.webContents === e.sender;
ipcMain.handle('tray-close', (e) => { if (fromTray(e)) hideTrayFlyout(); });
ipcMain.handle('tray-peek', (e) => { if (fromTray(e)) startPeek(); });
// left = the icon's default action, right = its own context menu (both done inside Explorer through UI Automation)
ipcMain.handle('tray-act', async (e, key, how) => {
  if (!fromTray(e) || quitting) return;
  const cmd = how === 'right' ? 'menu' : 'invoke';
  const note = (text, err) => { trayState = { ...trayState, note: text, noteErr: !!err, busy: null }; sendTray(); };
  try {
    trayState = { ...trayState, busy: String(key), note: undefined, noteErr: false }; sendTray();
    try { W.allowForeground(); } catch {}
    let res = await trayCall(cmd, { key: String(key), gen: trayGen });
    if (!res.ok && res.error === 'stale') {   // the icons changed since the list was drawn: read them again, same position
      await refreshTray();
      res = await trayCall(cmd, { key: String(key), gen: trayGen });
    }
    if (!res.ok) throw new Error(res.error || 'failed');
    note(undefined, false);
    if (cmd === 'invoke') setTimeout(hideTrayFlyout, 150);   // a context menu takes the focus itself, which closes the flyout
    poke(400);
  } catch (err) {
    log('tray', cmd, String(key), 'failed:', err.message);
    note(cmd === 'menu' ? 'Nabídku ikony se nepodařilo otevřít. Zkus „Zobrazit hlavní panel Windows“.' : 'Ikonu se nepodařilo otevřít. Zkus „Zobrazit hlavní panel Windows“.', true);
  }
});

// ---------------- tray ----------------
function buildTray() {
  if (quitting) return;
  if (!tray) { tray = new Tray(nativeImage.createFromPath(ICON)); tray.setToolTip('Nullwave'); tray.on('click', openPanel); }
  const mode = CFG.mode, setMode = (m) => hubFetch('/api/mode/' + m, { method: 'POST' }).then(() => setTimeout(buildTray, 200)).catch((e) => log('mode', e.message));
  let login = false; try { login = app.getLoginItemSettings({ path: process.execPath, args: [__dirname] }).openAtLogin; } catch {}
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: 'Nullwave', enabled: false, icon: nativeImage.createFromPath(ICON).resize({ width: 16, height: 16 }) },
    { type: 'separator' },
    { label: 'Ovládací panel', click: openPanel },
    { label: 'Spouštěč aplikací\tAlt+Mezerník', click: openLauncher },
    { type: 'separator' },
    { label: 'Vzhled Windows Nullwave', type: 'checkbox', checked: hub.themeActive(), click: (i) => { hub.theme(i.checked ? 'apply' : 'restore').then(buildTray, buildTray); } },
    { label: 'Widgety na monitoru', submenu: [['left', 'Levý'], ['primary', 'Hlavní'], ['right', 'Pravý'], ['bottom', 'Dolní']].map(([w, l]) => ({ label: l, type: 'radio', checked: (shellCfg().widgets || 'primary') === w, click: () => setWidgets(w) })) },
    { label: 'Lišta Nullwave místo hlavního panelu', type: 'checkbox', checked: railOn(), click: (i) => setRail(i.checked).catch((e) => logErr('rail switch', e)) },
    { label: 'Porty: heslo TP-Linku…', click: openTlPassword },
    { label: 'Režim tapety', submenu: [['full', 'Plný'], ['lite', 'Lite'], ['static', 'Statický']].map(([m, l]) => ({ label: l, type: 'radio', checked: mode === m, click: () => setMode(m) })) },
    { label: 'Spouštět s Windows', type: 'checkbox', checked: login, click: (i) => { try { app.setLoginItemSettings({ openAtLogin: i.checked, path: process.execPath, args: [__dirname] }); } catch (e) { logErr('autostart', e); } buildTray(); } },
    { type: 'separator' },
    { label: 'Ukončit a vrátit původní vzhled', click: () => quitApp() },
  ]));
}
async function setRail(on) {
  setShell({ rail: !!on });
  if (on) { await takeOverTaskbar(); buildRails(W.monitors()); }
  else {
    await giveBackTaskbar();
    for (const r of rails.splice(0)) { r.retired = true; try { if (!r.win.isDestroyed()) r.win.destroy(); } catch {} }
    await sleep(500); await tryOp('refitAll', [], 2000);
  }
  buildTray();
}

// ---------------- start / stop ----------------
function currentWallpaper() {
  return new Promise((res) => execFile('reg', ['query', 'HKCU\\Control Panel\\Desktop', '/v', 'Wallpaper'], { encoding: 'utf8', windowsHide: true, timeout: 2000 },
    (e, so) => { const m = !e && /REG_SZ\s+(.+)/.exec(so || ''); res(m ? m[1].trim() : null); }));
}
const timers = [];
const every = (fn, ms) => timers.push(setInterval(() => { try { fn(); } catch (e) { logErr('timer', e); } }, ms));
// Leaving, in this order and with a time limit on every step:
//  1 app bars removed + Windows taskbar back   2 our windows destroyed   3 maximized windows laid out again
//  4 Windows look restored (not on restart)    5 exit. Two independent timers end the process if anything hangs.
async function quitApp(opt) {
  if (quitting) return; quitting = true;
  const relaunch = !!(opt && opt.relaunch), keepLook = relaunch || !!(opt && opt.fast);   // restart / log-off: the Windows look stays
  log(relaunch ? 'restarting' : keepLook ? 'session ends' : 'quitting: restoring Windows look');
  const bye = (why) => { log(why); try { W.showTrays(true); } catch {} flushLogSync(); app.exit(0); };
  setTimeout(() => bye('quit fallback'), 40000);                                    // never hang on the way out
  try { if (worker && workerOk) worker.postMessage({ t: 'arm', ms: 50000 }); } catch {}   // ...even if this thread gets stuck
  if (relaunch) { try { app.relaunch(); } catch (e) { logErr('relaunch', e); } }
  try {
    timers.forEach(clearInterval); clearTimeout(rebuildT); clearTimeout(peekT); clearInterval(peekWatch); clearTimeout(dirtyT);
    clearInterval(trayPoll); stopTrayHelper();
    try { globalShortcut.unregisterAll(); } catch {}
    pushCfg({ desk: null });
    try { await withTimeout(giveBackTaskbar(), 8000); log('taskbar back'); } catch (e) { log('taskbar restore', e.message); try { W.showTrays(true); } catch {} }
    for (const r of rails.splice(0)) { r.retired = true; try { if (!r.win.isDestroyed()) r.win.destroy(); } catch {} }
    for (const w of [trayWin, launcherWin, panelWin, passWin]) { try { if (w && !w.isDestroyed()) w.destroy(); } catch {} }
    for (const d of [...desk]) { try { if (!d.win.isDestroyed()) d.win.destroy(); } catch {} }   // before the theme restore: nothing of ours is left inside Explorer
    desk.length = 0;
    try { if (tray) { tray.destroy(); tray = null; } } catch {}
    log('windows closed');
    await sleep(400); await tryOp('refitAll', [], 2000);
    if (!keepLook && (hub.themeActive() || hub.themeBusy())) {
      try { await withTimeout(hub.theme('restore'), 26000); } catch (e) { log('theme restore', e.message); }
    }
    if (!keepLook) { const wp = await currentWallpaper(); if (wp) await tryOp('repaintWallpaper', [wp], 2500); }
    try { hub.shutdown(); } catch {}
  } catch (e) { logErr('quit', e); }
  bye('bye');
}

app.whenReady().then(async () => {
  W = require('./win32');
  startWorker();
  await startHub();
  await workerReady;
  // show the desktop + rail right away; the slow parts (theme via PowerShell, app icons) finish in the background
  if (railOn()) await takeOverTaskbar().catch((e) => logErr('taskbar', e));
  rebuild(true);
  buildTray();
  log('desktop + rail up');
  loadPins().then(() => log('pins loaded')).catch((e) => logErr('pins', e));
  setTimeout(() => loadAllIcons(), 6000);
  if (shellCfg().applyTheme !== false && !hub.themeActive()) hub.theme('apply').then(buildTray, buildTray);
  every(railDirty, 5000);        // status LEDs
  every(watchdog, 5000);
  try { if (!globalShortcut.register('Alt+Space', openLauncher)) log('Alt+Space is taken'); } catch (e) { logErr('shortcut', e); }
  screen.on('display-added', () => rebuildLater()); screen.on('display-removed', () => rebuildLater());
  screen.on('display-metrics-changed', (_e, _d, changed) => { if (changed.some((c) => c === 'bounds' || c === 'scaleFactor')) rebuildLater(); });
  const lock = (v) => { locked = v; applyCover(); };
  powerMonitor.on('lock-screen', () => lock(true)); powerMonitor.on('unlock-screen', () => lock(false));
  powerMonitor.on('suspend', () => lock(true)); powerMonitor.on('resume', () => { lock(false); rebuildLater(4000); });
  if (!process.argv.includes('--hidden')) openPanel();
}).catch((e) => { logErr('startup', e); });
app.on('second-instance', () => openPanel());
app.on('window-all-closed', () => {});                 // stay in the tray
app.on('before-quit', (e) => { if (!quitting) { e.preventDefault(); quitApp(); } });   // any other way out goes through the restore too
app.on('child-process-gone', (_e, d) => { if (d && d.reason !== 'clean-exit') log('child process gone:', d.type, d.reason); });

// which connection the PC uses: wired LAN wins over Wi-Fi (like the Windows tray icon)
function netType() {
  const ok = (addrs) => addrs.some((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.'));
  const ifs = require('os').networkInterfaces();
  let wifi = false;
  for (const [name, addrs] of Object.entries(ifs)) {
    if (/^ethernet( \d+)?$/i.test(name) && ok(addrs)) return 'lan';
    if (/^wi-?fi( \d+)?$/i.test(name) && ok(addrs)) wifi = true;
  }
  return wifi ? 'wifi' : 'off';
}
