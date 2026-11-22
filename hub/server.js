// Nullwave hub: small local server for the live wallpaper and its control panel.
// Listens only on 127.0.0.1, every request needs ?k=<key> from config.json.
// Feeds: trader state (remote host, read-only ssh), camera (RTSP -> MJPEG via ffmpeg),
// Windows media session (Spotify), CPU/RAM, device pings. Everything starts lazily
// when the wallpaper asks for it and stops again when nobody is looking.
'use strict';
const http = require('http');
const https = require('https');
const os = require('os');
const net = require('net');
const fs = require('fs');
const path = require('path');
const readline = require('readline');
const { spawn, execFile } = require('child_process');

const CFG_PATH = path.join(__dirname, 'config.json');
const CFG = require('./config-init.js')();
const ROOT = path.join(__dirname, '..');
const STARTED = Date.now();
const MODES = ['full', 'lite', 'static'];
if (!MODES.includes(CFG.mode)) CFG.mode = 'full';
let cfgBusy = false, cfgAgain = false;
function saveCfg() {   // async + atomic (temp file, then rename): the file holds the access key
  if (cfgBusy) { cfgAgain = true; return; }
  cfgBusy = true;
  const tmp = CFG_PATH + '.tmp';
  fs.writeFile(tmp, JSON.stringify(CFG, null, 2), (e) => {
    const done = (e2) => { if (e2) log('config save', e2.message); cfgBusy = false; if (cfgAgain) { cfgAgain = false; saveCfg(); } };
    if (e) return done(e);
    fs.rename(tmp, CFG_PATH, done);
  });
}
const quiet = (p) => { p.on('error', (e) => log('spawn', e.message)); return p; };   // a missing exe must not throw
const LOCAL = process.env.LOCALAPPDATA || '', APPDATA = process.env.APPDATA || '';
const STARTUP_DIR = path.join(APPDATA, 'Microsoft', 'Windows', 'Start Menu', 'Programs', 'Startup');
const autostartOn = () => { try { return fs.readdirSync(STARTUP_DIR).some((f) => /nullwave|start-hub/i.test(f)); } catch { return false; } };
// directory scans for the panel's setup section: at most once in 30 s (the panel asks every 3 s)
let setupCache = null, setupAt = 0;
function setupInfo() {
  if (!setupCache || Date.now() - setupAt > 30000) { setupCache = { lively: livelyInstalled(), autostart: autostartOn(), traderKey: fs.existsSync(CFG.trader.key) }; setupAt = Date.now(); }
  return setupCache;
}
function livelyInstalled() {
  try {
    if (fs.existsSync(path.join(LOCAL, 'Programs', 'Lively Wallpaper', 'Lively.exe'))) return true;
    return fs.readdirSync(path.join(LOCAL, 'Packages')).some((d) => /livelywallpaper/i.test(d));
  } catch { return false; }
}
const EDGE = 'C:\\Program Files (x86)\\Microsoft\\Edge\\Application\\msedge.exe';
function openApp(url, w, h, extra = []) {
  quiet(spawn(EDGE, ['--app=' + url, `--window-size=${w},${h}`, ...extra], { detached: true, stdio: 'ignore', windowsHide: false })).unref();
}
const THEME_PS = path.join(ROOT, 'theme', 'theme.ps1');
const themeActive = () => fs.existsSync(path.join(ROOT, 'theme', 'theme-backup.json'));
// apply / restore never run at the same time (they share the backup file): calls are queued
let themeQueue = Promise.resolve(), themePending = 0;
function theme(action) {
  themePending++;
  const run = () => new Promise((res) => execFile(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', THEME_PS, action],
    { windowsHide: true, timeout: 30000 }, (e, so) => { themePending--; log('theme', action, e ? 'ERR ' + String(e.message).trim() : String(so).trim()); res(!e); }));
  const p = themeQueue.then(run, run);
  themeQueue = p.catch(() => {});
  return p;
}
const themeBusy = () => themePending > 0;
const MIME = { '.html': 'text/html; charset=utf-8', '.png': 'image/png', '.svg': 'image/svg+xml', '.ico': 'image/x-icon', '.woff2': 'font/woff2', '.js': 'text/javascript', '.md': 'text/plain; charset=utf-8' };
function sendFile(res, file) {
  fs.readFile(file, (e, b) => {
    if (e) { res.writeHead(404); return res.end(); }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream', 'Cache-Control': 'no-cache' }); res.end(b);
  });
}
const PS = 'C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe';
const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------- CPU / RAM ----------
let cpuPrev = os.cpus(), cpuPct = 0;
setInterval(() => {
  const now = os.cpus();
  let idle = 0, total = 0;
  now.forEach((c, i) => {
    const p = cpuPrev[i].times, t = c.times;
    const d = (k) => t[k] - p[k];
    const tt = d('user') + d('nice') + d('sys') + d('idle') + d('irq');
    total += tt; idle += d('idle');
  });
  cpuPct = total ? Math.round((1 - idle / total) * 100) : 0;
  cpuPrev = now;
}, 2000);

// ---------- device pings (TCP connect time) ----------
const pings = {};
function pingAll() {
  for (const d of CFG.devices) {
    const t = Date.now();
    const s = net.connect(d.port, d.host);
    const done = (ok) => { pings[d.id] = { label: d.label, host: d.host, ok, ms: ok ? Date.now() - t : null }; s.destroy(); };
    s.setTimeout(2500);
    s.once('connect', () => done(true));
    s.once('timeout', () => done(false));
    s.once('error', () => done(false));
  }
}
pingAll(); setInterval(pingAll, 10000);

// last known state on disk, shown frozen under the "signal lost" glitch after an outage / restart
const CACHE = path.join(__dirname, 'cache');
try { fs.mkdirSync(CACHE, { recursive: true }); } catch {}
const cacheRead = (f) => { try { return fs.readFileSync(path.join(CACHE, f)); } catch { return null; } };
const cacheWrite = (f, b) => fs.writeFile(path.join(CACHE, f), b, () => {});

// ---------- trader (remote host over ssh) ----------
let trader = { ok: false, error: 'načítám', data: (() => { try { return JSON.parse(cacheRead('trader.json')); } catch { return null; } })(), at: 0 }, traderAsked = 0, traderBusy = false, traderProc = null;
function fetchTrader() {
  if (traderBusy || Date.now() - traderAsked > 60000) return;
  if (CFG.trader.file) { // local copy instead of ssh (testing / manual sync)
    try { const raw = fs.readFileSync(CFG.trader.file, 'utf8'); trader = { ok: true, data: JSON.parse(raw), at: Date.now() }; cacheWrite('trader.json', raw); }
    catch (e) { trader = { ok: false, error: 'soubor: ' + e.message, data: null, at: Date.now() }; }
    return;
  }
  if (!fs.existsSync(CFG.trader.key)) { trader = { ok: false, error: 'chybí ssh klíč (viz README.md)', data: trader.data, at: Date.now() }; return; }
  traderBusy = true;
  const p = spawn(CFG.trader.ssh, ['-i', CFG.trader.key, '-o', 'BatchMode=yes', '-o', 'ConnectTimeout=6',
    '-o', 'StrictHostKeyChecking=accept-new', '-o', 'UserKnownHostsFile=' + path.join(__dirname, 'known_hosts'),
    CFG.trader.host, 'state'], { windowsHide: true });
  let out = '', err = '', closed = false;
  traderProc = p;
  const kill = setTimeout(() => { try { p.kill(); } catch {} }, 15000);
  p.stdout.on('data', (d) => { if (out.length < 2e6) out += d; });
  p.stderr.on('data', (d) => { if (err.length < 1e5) err += d; });
  const end = (spawnErr) => {
    if (closed) return; closed = true;
    if (spawnErr) err = 'ssh: ' + spawnErr.message;
    if (traderProc === p) traderProc = null;
    clearTimeout(kill); traderBusy = false;
    try { trader = { ok: true, data: JSON.parse(out), at: Date.now() }; cacheWrite('trader.json', out); }
    catch { trader = { ok: false, error: (err.trim().split('\n').pop() || 'nečitelná data').slice(0, 120), data: trader.data, at: Date.now() }; }
  };
  p.on('close', () => end());
  p.on('error', end);   // ssh.exe missing: report it instead of throwing
}
setInterval(fetchTrader, CFG.trader.everyMs);

// ---------- media session (Spotify) ----------
let media = { status: 'None' }, mediaArt = null, mediaProc = null, mediaAsked = 0, artKey = '';
// Cover art: Windows' thumbnail can't be read from PowerShell, so look it up by artist + title
// (iTunes Search API, public, no key) and serve it from here (same origin rules -> colour tint works).
const artCache = new Map();
function fetchBuf(url) {
  return new Promise((res, rej) => https.get(url, { headers: { 'User-Agent': 'nullwave' } }, (r) => {
    if (r.statusCode !== 200) { r.resume(); return rej(new Error('HTTP ' + r.statusCode)); }
    const b = []; r.on('data', (d) => b.push(d)); r.on('end', () => res(Buffer.concat(b)));
  }).on('error', rej));
}
async function lookupArt(artist, title, album, key) {
  try {
    let img = artCache.get(key);
    if (!img) {
      const q = encodeURIComponent(((artist || '').split(/,|&| feat/i)[0] + ' ' + title.replace(/\s*[(\[].*?[)\]]/g, '')).trim());
      const j = JSON.parse(await fetchBuf('https://itunes.apple.com/search?entity=song&limit=15&term=' + q));
      const res = j.results || [], al = (album || '').toLowerCase().slice(0, 18);
      const hit = (al && res.find((x) => (x.collectionName || '').toLowerCase().includes(al))) || res[0];
      const u = hit && hit.artworkUrl100;
      if (!u) return;
      img = await fetchBuf(u.replace('100x100bb', '300x300bb'));
      artCache.set(key, img); if (artCache.size > 100) artCache.delete(artCache.keys().next().value);
    }
    if (key === artKey) { mediaArt = img; media.artId = Date.now(); }
  } catch {}
}
function startMedia() {
  if (mediaProc) return;
  const proc = mediaProc = spawn(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'media-loop.ps1')], { windowsHide: true });
  proc.stderr.on('data', () => {});
  readline.createInterface({ input: proc.stdout }).on('line', (line) => {
    try {
      const m = JSON.parse(line);
      const key = (m.artist || '') + '|' + (m.title || '');
      if (key !== artKey) { artKey = key; mediaArt = null; m.artId = null; if (m.title && m.artist && /spotify/i.test(m.app || '')) lookupArt(m.artist, m.title, m.album, key); }
      else m.artId = media.artId;
      media = m;
    } catch {}
  });
  // only the process that is still current may clear the slot (an old one exiting late would orphan the new loop)
  const gone = () => { if (mediaProc === proc) mediaProc = null; };
  proc.on('exit', gone); proc.on('error', (e) => { log('media loop', e.message); gone(); });
}
function stopMedia() { const p = mediaProc; mediaProc = null; if (p) { try { p.kill(); } catch {} } }
setInterval(() => { if (mediaProc && Date.now() - mediaAsked > 60000) stopMedia(); }, 15000);
function mediaControl(action) {
  return new Promise((res) => execFile(PS, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', path.join(__dirname, 'media-control.ps1'),
    '-Action', action, '-App', media.app || ''], { windowsHide: true, timeout: 8000 }, (e, so) => res(!e && /true/.test(so))));
}

// ---------- spotify playlist info (official oEmbed, no login) ----------
let playlist = null;
function loadPlaylist() {
  const u = 'https://open.spotify.com/oembed?url=' + encodeURIComponent('https://open.spotify.com/playlist/' + CFG.spotifyPlaylist);
  https.get(u, { headers: { 'User-Agent': 'nullwave' } }, (r) => {
    let b = ''; r.on('data', (d) => (b += d));
    r.on('end', () => { try { const j = JSON.parse(b); playlist = { title: j.title, cover: j.thumbnail_url, id: CFG.spotifyPlaylist }; } catch {} });
  }).on('error', () => {});
}
loadPlaylist(); setInterval(loadPlaylist, 6 * 3600 * 1000);
function playPlaylist() {
  quiet(spawn('cmd.exe', ['/c', 'start', '', 'spotify:playlist:' + CFG.spotifyPlaylist], { windowsHide: true, detached: true, stdio: 'ignore' })).unref();
  // Spotify opens the playlist paused; press play once it shows up in the media session.
  setTimeout(() => { if (/spotify/i.test(media.app || '') && media.status !== 'Playing') mediaControl('toggle'); }, 4000);
}

// ---------- MJPEG relay ----------
const SOI = Buffer.from([0xff, 0xd8]), EOI = Buffer.from([0xff, 0xd9]);
class Mjpeg {
  constructor(name, args) { this.name = name; this.args = args; this.clients = new Set(); this.proc = null; this.buf = Buffer.alloc(0); this.last = cacheRead(name + '.jpg'); this.lastAt = 0; this.savedAt = 0; }
  add(req, res) {
    res.writeHead(200, { 'Content-Type': 'multipart/x-mixed-replace; boundary=frame', 'Cache-Control': 'no-cache, no-store', Connection: 'close', 'Access-Control-Allow-Origin': '*' });
    this.clients.add(res);
    const drop = () => { if (this.clients.delete(res) && !this.clients.size) this.stopSoon(); };
    req.on('close', drop); res.on('close', drop); res.on('error', drop);
    if (this.last) this.send(res, this.last);
    this.start();
  }
  start() {
    clearTimeout(this.stopT);
    if (this.proc) return;
    log(this.name, 'start');
    this.buf = Buffer.alloc(0);
    const proc = this.proc = spawn(CFG.ffmpeg, this.args, { windowsHide: true });
    const startedAt = Date.now();
    proc.stdout.on('data', (d) => { if (this.proc === proc) this.data(d); });
    proc.stderr.on('data', () => {});
    let ended = false;
    const end = (e) => {
      if (ended) return; ended = true;
      if (e) log(this.name, 'ffmpeg', e.message);
      if (this.proc !== proc) return;   // already replaced or stopped on purpose
      this.proc = null;
      // camera offline: retry, slower after quick failures
      this.fails = Date.now() - startedAt < 5000 ? Math.min((this.fails || 0) + 1, 5) : 0;
      clearTimeout(this.retryT);
      if (this.clients.size && !this.closed) this.retryT = setTimeout(() => this.clients.size && !this.closed && this.start(), 3000 + this.fails * 2000);
    };
    proc.on('exit', () => end()); proc.on('error', end);
  }
  kill() { const p = this.proc; this.proc = null; clearTimeout(this.retryT); if (p) { try { p.kill(); } catch {} } }
  shutdown() { this.closed = true; clearTimeout(this.stopT); this.kill(); for (const c of this.clients) { try { c.destroy(); } catch {} } this.clients.clear(); }
  data(d) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, d]) : d;
    let s, e;
    while ((s = this.buf.indexOf(SOI)) >= 0 && (e = this.buf.indexOf(EOI, s + 2)) >= 0) {
      this.last = Buffer.from(this.buf.subarray(s, e + 2)); this.lastAt = Date.now();
      if (Date.now() - this.savedAt > 20000) { this.savedAt = Date.now(); cacheWrite(this.name + '.jpg', this.last); }
      for (const c of this.clients) this.send(c, this.last);
      this.buf = this.buf.subarray(e + 2);
    }
    if (this.buf.length > 4e6) this.buf = Buffer.alloc(0);
  }
  send(res, f) {
    if (res.destroyed || res.writableEnded) { this.clients.delete(res); return; }
    if (res.writableLength > 1500000) return;   // slow / sleeping viewer: skip frames instead of queueing them in memory
    try { res.write(`--frame\r\nContent-Type: image/jpeg\r\nContent-Length: ${f.length}\r\n\r\n`); res.write(f); res.write('\r\n'); } catch { this.clients.delete(res); }
  }
  stopSoon() { clearTimeout(this.stopT); this.stopT = setTimeout(() => { if (!this.clients.size && this.proc) { log(this.name, 'stop'); this.kill(); } }, 5000); }
}
const cam85 = new Mjpeg('cam85', ['-hide_banner', '-loglevel', 'error', '-rtsp_transport', 'tcp', '-i', CFG.cam85.rtsp,
  '-an', '-vf', 'fps=8,scale=640:-2', '-q:v', '6', '-f', 'image2pipe', '-c:v', 'mjpeg', 'pipe:1']);

// ---------- switch ports widget (TL-SG1024DE through PortTik's own modules, see ports.js) ----------
const ports = require('./ports').createPorts({ CFG, ROOT, log, cacheRead, cacheWrite, host: global.NULLWAVE_HOST || null });

// ---------- http ----------
function json(res, obj, code = 200) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(obj));
}
const server = http.createServer(async (req, res) => {
  res.on('error', () => {});   // a viewer that went away is not an error
  let u; try { u = new URL(req.url, 'http://x'); } catch { res.writeHead(400); return res.end(); }
  const isAsset = /^\/(brand|fonts)\/[\w.-]+$/.test(u.pathname); // icon + font only, no data
  if (!isAsset && u.searchParams.get('k') !== CFG.key) { res.writeHead(403); return res.end(); }
  const p = u.pathname;
  try {
    if (p === '/api/stats') return json(res, { mode: CFG.mode, cpu: cpuPct, memUsed: os.totalmem() - os.freemem(), memTotal: os.totalmem(), uptime: os.uptime(), host: os.hostname(), pings,
      cam: { live: Date.now() - cam85.lastAt < 6000, viewers: cam85.clients.size } });
    if (p === '/api/trader') { const first = !traderAsked || Date.now() - traderAsked > 60000; traderAsked = Date.now(); if (first) fetchTrader(); return json(res, trader); }
    if (p === '/api/media') { mediaAsked = Date.now(); startMedia(); return json(res, { ...media, now: Date.now(), playlist }); }
    if (p === '/api/media/art') {
      if (!mediaArt) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'max-age=3600' }); return res.end(mediaArt);
    }
    if (p.startsWith('/api/media/') && req.method === 'POST') {
      const a = p.split('/').pop();
      if (a === 'playlist') { playPlaylist(); return json(res, { ok: true }); }
      if (['toggle', 'next', 'prev'].includes(a)) return json(res, { ok: await mediaControl(a) });
    }
    if (p === '/cam85.mjpg') return cam85.add(req, res);
    if (p === '/cam85.jpg') {   // last frame we got (frozen picture for the outage glitch)
      if (!cam85.last) { res.writeHead(404, { 'Access-Control-Allow-Origin': '*' }); return res.end(); }
      res.writeHead(200, { 'Content-Type': 'image/jpeg', 'Access-Control-Allow-Origin': '*', 'Cache-Control': 'no-store' }); return res.end(cam85.last);
    }
    if (p === '/api/rdp') return json(res, { configured: !!CFG.rdp });
    // ---- switch ports: state is a cached snapshot (never waits for the switch); actions need POST ----
    if (p === '/api/ports') return json(res, ports.view(u.searchParams.has('demo')));
    if (req.method === 'POST' && p.startsWith('/api/ports/')) {
      const a = p.split('/').pop(), demo = u.searchParams.has('demo'), mode = u.searchParams.get('mode') || '';
      try {
        if (a === 'preview') return json(res, await ports.preview(demo, mode));
        if (a === 'switch') return json(res, ports.switch(demo, mode, u.searchParams.get('token') || ''));
        if (a === 'open') return json(res, ports.open());
        if (a === 'ask-password') { const h = global.NULLWAVE_HOST; if (h && h.askTlPassword) h.askTlPassword(); return json(res, { ok: !!(h && h.askTlPassword) }); }
      } catch (e) { return json(res, { ok: false, error: String(e && e.message || e) }); }
      return json(res, { ok: false }, 400);
    }
    // ---- control panel ----
    if (p === '/panel') return sendFile(res, path.join(ROOT, 'panel', 'panel.html'));
    if (p.startsWith('/brand/') || p.startsWith('/fonts/')) {
      const f = path.normalize(path.join(ROOT, p.startsWith('/brand/') ? 'brand' : 'wallpaper/fonts', path.basename(p)));
      return sendFile(res, f);
    }
    if (p === '/api/health') {
      return json(res, {
        mode: CFG.mode, hubUptime: Math.round((Date.now() - STARTED) / 1000), pid: process.pid,
        trader: { ok: trader.ok, error: trader.error || null, keyExists: setupInfo().traderKey, equity: trader.data && trader.data.equity, status: trader.data && trader.data.status },
        media: { status: media.status, title: media.title || null, artist: media.artist || null }, playlist,
        cam: { streaming: !!cam85.proc, viewers: cam85.clients.size }, pings,
        theme: { active: themeActive() }, app: !!global.NULLWAVE_HOST,
        setup: setupInfo(),
      });
    }
    if (req.method === 'POST' && (p === '/api/theme/apply' || p === '/api/theme/restore')) {
      const ok = await theme(p.split('/').pop()); return json(res, { ok, active: themeActive() });
    }
    if (req.method === 'POST' && p.startsWith('/api/mode/')) {
      const m = p.split('/').pop(); if (!MODES.includes(m)) return json(res, { ok: false }, 400);
      CFG.mode = m; saveCfg(); return json(res, { ok: true, mode: m });
    }
    if (req.method === 'POST' && p.startsWith('/api/open/')) {
      const w = p.split('/').pop();
      if (w === 'preview') openApp('file:///' + path.join(ROOT, 'wallpaper', 'index.html').replace(/\\/g, '/'), 1600, 900);
      else if (w === 'folder') quiet(spawn('explorer.exe', [ROOT], { detached: true, stdio: 'ignore' })).unref();
      else if (w === 'guide') quiet(spawn('notepad.exe', [path.join(ROOT, 'README.md')], { detached: true, stdio: 'ignore' })).unref();
      else if (w === 'lively') quiet(spawn('cmd.exe', ['/c', 'start', '', 'ms-windows-store://pdp/?ProductId=9NTM2QC6QWS7'], { detached: true, stdio: 'ignore', windowsHide: true })).unref();
      else return json(res, { ok: false }, 400);
      return json(res, { ok: true });
    }
    if (req.method === 'POST' && (p === '/api/hub/restart' || p === '/api/hub/stop')) {
      json(res, { ok: true });
      const host = global.NULLWAVE_HOST;   // set when running inside the Nullwave app
      if (host) { setTimeout(() => (p.endsWith('restart') ? host.restart() : host.quit()), 300); return; }
      if (p.endsWith('restart')) quiet(spawn(process.execPath, [__filename], { detached: true, stdio: 'ignore', windowsHide: true })).unref();
      setTimeout(() => process.exit(0), 300);
      return;
    }
    res.writeHead(404); res.end();
  } catch (e) { try { if (!res.headersSent) json(res, { error: String(e) }, 500); else res.end(); } catch {} }
});
server.on('clientError', (_e, sock) => { try { sock.destroy(); } catch {} });
// On restart the old process may still hold the port for a moment: retry for ~10 s.
let tries = 0;
server.on('error', (e) => {
  if (e.code === 'EADDRINUSE' && tries++ < 20) return setTimeout(() => server.listen(CFG.port, '127.0.0.1'), 500);
  log('listen error', e.code); if (!global.NULLWAVE_HOST) process.exit(1);
});
server.listen(CFG.port, '127.0.0.1', () => log('Nullwave hub on 127.0.0.1:' + CFG.port));

// state for the shell (no HTTP round trip, no disk access)
function health() {
  return { trader: trader.ok ? true : (setupInfo().traderKey ? false : undefined), cam: pings.cam85 ? pings.cam85.ok : undefined, traderhost: pings.traderhost ? pings.traderhost.ok : undefined };
}
// stop every child process and the server (the app is quitting)
function shutdown() {
  try { stopMedia(); } catch {}
  try { cam85.shutdown(); } catch {}
  try { ports.shutdown(); } catch {}
  try { if (traderProc) traderProc.kill(); } catch {}
  try { server.close(); if (server.closeAllConnections) server.closeAllConnections(); } catch {}
}

module.exports = { server, theme, themeActive, themeBusy, saveCfg, health, shutdown, ports, CFG };
