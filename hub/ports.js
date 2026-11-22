// Nullwave "Porty" widget back end: the TL-SG1024DE switch, read and switched by PortTik's own code.
//
// Nothing about the switch is implemented here. The HTTP client, the parsers, the safe port-move plan
// (add to target VLAN -> PVID -> remove from the old one, uplink / LAG refused), the verify-after-write,
// the static-IP refusal and the DHCP renew of the PC's own port all live in PortTik (src/main/*.js) and are
// loaded from its folder, so both apps always run the same logic. This file only:
//   - builds PortTik's Collector on top of PortTik's settings file (host, ISP VLANs, home VLANs, labels are shared),
//   - keeps the TP-Link password in Nullwave's own encrypted store (PortTik's copy cannot be decrypted here),
//   - polls while somebody is looking (the wallpaper asks every few seconds; no asks -> no polling), with backoff,
//   - turns PortTik's snapshot into what the widget draws, plus a short event log,
//   - runs the "my port" switch after an explicit two-step confirmation, never retrying a write on its own.
// "?demo" uses PortTik's simulated switch (mock.js) with in-memory settings: no network, no disk.
'use strict';
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { spawn } = require('child_process');

// colours of the widget (the user's design), by network
const COLORS = { UPLINK: '#2fd6c4', HOME: '#2fd6c4', ISP_A: '#ff3b4a', ISP_B: '#ff8a3d', OTHER: '#4a5560' };
// colours of your own VLANs: hub/config.json -> "ports": { "vlanColors": { "10": "#3fbf7f", "20": "#3d8ee6" } }
const MODES = { home: 'LAN', vodafone: 'ISP A', starlink: 'ISP B' };   // keys are PortTik's mode ids

function createPorts(opt) {
  const { CFG, ROOT, log, cacheRead, cacheWrite } = opt;
  const hostApp = opt.host || null;                    // set when running inside the Nullwave app
  const cfg = () => CFG.ports || {};
  const ptDir = () => cfg().porttikDir || path.resolve(ROOT, '..', 'PortTik');
  const sharedFile = () => path.join(cfg().settingsDir || path.join(process.env.APPDATA || '', 'PortTik'), 'settings.json');
  const ownDir = path.join(process.env.APPDATA || ROOT, 'Nullwave', 'ports');   // our secrets live here, never in PortTik's folder
  const everyMs = () => Math.max(3000, Number(cfg().everyMs) || 5000);
  let PT = null, ptError = '', closed = false;
  const inst = { real: null, demo: null };

  function loadPortTik() {
    if (PT) return PT;
    const m = (f) => require(path.join(ptDir(), 'src', 'main', f));
    try { PT = { Collector: m('collector.js').Collector, Settings: m('settings.js'), Net: m('net-plan.js') }; ptError = ''; }
    catch (e) { ptError = 'PortTik nenalezen (' + ptDir() + ')'; log('ports: cannot load PortTik:', e.message); }
    return PT;
  }

  // ---- settings: PortTik's file for everything that is not secret ----
  function readShared() {
    try { return PT.Settings.deepMerge(PT.Settings.DEFAULTS, JSON.parse(fs.readFileSync(sharedFile(), 'utf8'))); } catch { return null; }
  }
  function realSettings() {
    // built on our own folder (PortTik's loader would rename a file it cannot parse - not ours to touch),
    // then pointed at the shared settings file; secrets.json stays in ownDir
    const st = new PT.Settings.Settings(ownDir, hostApp && hostApp.safeStorage);
    const shared = readShared();
    if (shared) { st.file = sharedFile(); st.data = shared; st.shared = true; try { st.sharedMtime = fs.statSync(st.file).mtimeMs; } catch {} }
    // PortTik's demo switch and its public-IP lookup (a request to ipinfo.io) are not for the wallpaper
    st.get = () => ({ ...st.data, demo: false, publicIpCheck: !!cfg().publicIpCheck });
    return st;
  }
  function demoSettings() {
    const real = readShared() || {};
    const data = PT.Settings.deepMerge(PT.Settings.DEFAULTS, { labels: real.labels || {}, homeVlans: {} });
    return { data, get() { return { ...this.data, demo: true, publicIpCheck: false }; }, save() {}, getSecret: () => 'demo', hasSecret: () => true, canEncrypt: () => false };
  }
  // PortTik changed its settings (a label, a home VLAN)? Pick it up before the next poll. Async, never renames anything.
  async function reloadShared(I) {
    const st = I.settings;
    if (I.demo || !st.shared || I.busy) return;
    try {
      const m = (await fs.promises.stat(st.file)).mtimeMs;
      if (m === st.sharedMtime) return;
      const d = PT.Settings.deepMerge(PT.Settings.DEFAULTS, JSON.parse(await fs.promises.readFile(st.file, 'utf8')));
      const hostChanged = JSON.stringify(d.tl) !== JSON.stringify(st.data.tl);
      st.data = d; st.sharedMtime = m;
      if (hostChanged) I.collector.resetClients();
    } catch {}
  }

  function instance(demo) {
    const k = demo ? 'demo' : 'real';
    if (inst[k]) return inst[k];
    if (!loadPortTik()) return null;
    const I = { demo: !!demo, settings: null, collector: null, view: null, events: [], evId: 0, hist: new Map(), links: null, mode: null, state: 'init',
      fails: 0, timer: null, polling: false, asked: 0, busy: null, since: 0, chatterAt: 0, token: null, savedAt: 0 };
    try {
      I.settings = demo ? demoSettings() : realSettings();
      I.collector = new PT.Collector(I.settings, (e) => onCollectorLog(I, e));
      // PortTik asks PowerShell once a minute which adapter carries the internet (for a warning in its window): not needed here
      I.collector.refreshRouteSrc = () => {};
    } catch (e) { ptError = 'PortTik: ' + e.message; log('ports:', e.message); return null; }
    // the simulated switch starts without the Vodafone / Starlink VLANs, like a fresh TL: run PortTik's own "Připravit TP-Link"
    // on it (simulation only - on the real switch that step belongs to PortTik's setup page and is never done from here)
    I.ready = demo ? I.collector.prepareTl().catch((e) => log('ports(demo) prepare:', e.message)) : Promise.resolve();
    if (!demo) { try { const c = JSON.parse(cacheRead('ports.json')); if (c && Array.isArray(c.ports)) I.view = { ...c, state: 'init', frozen: true }; } catch {} }
    inst[k] = I;
    return I;
  }

  // ---- event log (what the widget types out) ----
  function event(I, msg, level) {
    I.events.push({ id: ++I.evId, at: Date.now(), level: level || 'info', msg: String(msg).replace(/\s+/g, ' ').slice(0, 160) });
    if (I.events.length > 40) I.events.splice(0, I.events.length - 40);
  }
  function onCollectorLog(I, e) {
    const tag = I.demo ? 'ports(demo)' : 'ports';
    if (e.level === 'cmd') {   // a write on the switch: name + VLAN only (the 24 membership values stay in the app log)
      const short = String(e.msg || '').replace(/\[[^\]]*\]/g, '[…]');
      event(I, `tl :: ${short} :: ${e.ms} ms`);
      log(tag, 'write', e.msg, e.ms + ' ms');
    } else if (e.level === 'error') { event(I, `chyba :: ${e.msg || ''} ${e.error || ''}`, 'error'); log(tag, 'ERROR', e.msg || '', e.error || ''); }
    else { event(I, String(e.msg || ''), e.level); log(tag, e.msg || ''); }
  }

  // ---- PortTik snapshot -> what the widget draws ----
  function portView(I, p, s, vlanNames) {
    const me = p.port === s.adminPort, mt = p.vlan, plan = PT.Net.VLANS[mt];
    let name, color;
    if (p.mode !== 'home') { name = (s.isp[p.mode].label || p.mode).toUpperCase(); color = COLORS[p.mode === 'vodafone' ? 'ISP_A' : 'ISP_B']; }
    else {
      name = (plan && plan.name) || vlanNames[p.vid] || (p.vid === null ? '?' : 'VLAN ' + mt);
      color = (cfg().vlanColors || {})[mt] || (plan && plan.color) || COLORS.OTHER;
    }
    if (p.role === 'uplink') color = COLORS.UPLINK;
    if (me && p.mode === 'home') color = COLORS.HOME;
    const total = (p.rxPps || 0) + (p.txPps || 0);
    const h = I.hist.get(p.port) || [];
    if (p.link) { h.push(Math.min(1, Math.log10(1 + total) / 4)); if (h.length > 4) h.shift(); } else h.length = 0;
    I.hist.set(p.port, h);
    return { n: p.port, role: p.role, me, mode: p.mode, vid: p.vid, vlan: mt, vlanName: name, color, label: p.label || '',
      name: me ? MODES[p.mode] : (p.label || (p.role === 'uplink' ? 'UPLINK' : name)),
      link: p.link, speed: p.speed || '', rx: p.rxPps === undefined ? null : p.rxPps, tx: p.txPps === undefined ? null : p.txPps, spark: h.slice(), res: p.role === 'spare', enabled: p.enabled !== false };
  }
  function digest(I, snap) {
    const s = I.settings.get(), was = I.state;
    const state = snap.tl.unconfigured ? 'nopass' : snap.tl.ok ? 'live' : 'lost';
    const title = (snap.tl.info && snap.tl.info.description) || 'TL-SG1024DE';
    I.state = state;
    if (state === 'live') {
      const names = {}; for (const v of snap.vlansOnTl || []) names[v.vid] = v.name;
      const ports = snap.ports.map((p) => portView(I, p, s, names));
      const upNow = ports.filter((p) => p.link === true).map((p) => p.n);
      if (was !== 'live') {
        I.since = Date.now(); I.fails = 0;
        event(I, `handshake ${title} :: 802.1Q ${snap.tl.dot1q === false ? 'OFF' : 'tagging enabled'}`);
        event(I, `scanning ${ports.length} ports :: link up :: ${upNow.join(', ') || 'none'}`);
      } else if (I.links) {
        for (const p of ports) {
          const before = I.links.get(p.n);
          if (before !== undefined && before !== null && p.link !== null && before !== p.link) event(I, `port ${p.n} :: ${p.name} :: ${p.link ? 'LINK UP' + (p.speed ? ' :: ' + p.speed : '') : 'NO CARRIER'}`);
        }
      }
      I.links = new Map(ports.map((p) => [p.n, p.link]));
      const mine = ports.find((p) => p.me);
      if (mine && I.mode && I.mode !== mine.mode && !I.busy) event(I, `port ${mine.n} :: vlan -> ${MODES[mine.mode]} :: VLAN ${mine.vid}`);
      if (mine) I.mode = mine.mode;
      // ambient line with real numbers: the busiest port right now
      if (Date.now() - I.chatterAt > 9000 && I.events.length && Date.now() - I.events[I.events.length - 1].at > 6000) {
        const busy = ports.filter((p) => p.link && p.rx !== null).sort((a, b) => (b.rx + b.tx) - (a.rx + a.tx))[0];
        if (busy) { I.chatterAt = Date.now(); event(I, `rx/tx port ${busy.n} :: ${busy.rx}/${busy.tx} pkt/s :: ${busy.speed || 'link'}`); }
      }
      I.view = { state, title, host: s.tl.host, ports, up: upNow.length, total: ports.length, adminPort: s.adminPort, mode: mine ? mine.mode : null,
        isp: { vodafone: s.isp.vodafone.label, starlink: s.isp.starlink.label }, since: I.since, at: snap.at, error: '', warnings: (snap.local && snap.local.warnings) || [] };
      if (!I.demo && Date.now() - I.savedAt > 30000) { I.savedAt = Date.now(); cacheWrite('ports.json', JSON.stringify({ ...I.view, state: 'lost' })); }
    } else {
      I.fails++;
      const error = state === 'nopass' ? 'Chybí heslo TP-Linku' : (snap.tl.error || 'přepínač neodpovídá');
      if (was !== state) event(I, state === 'nopass' ? 'no password :: nabídka Nullwave v oznamovací oblasti -> Porty: heslo TP-Linku' : `switch link lost :: ${error}`, 'error');
      // keep the last picture we had (frozen under the overlay); with nothing at all, PortTik's fallback plan
      const names = {};
      const ports = I.view && I.view.ports && I.view.ports.length ? I.view.ports : snap.ports.map((p) => portView(I, p, s, names));
      I.view = { ...(I.view || {}), state, title: (I.view && I.view.title) || title, host: s.tl.host, ports, up: ports.filter((p) => p.link === true).length, total: ports.length,
        adminPort: s.adminPort, mode: (I.view && I.view.mode) || null, isp: { vodafone: s.isp.vodafone.label, starlink: s.isp.starlink.label }, since: 0, error, frozen: true };
    }
  }

  // ---- polling: only while asked for, one read at a time, slower when the switch is away ----
  function schedule(I, ms) { clearTimeout(I.timer); if (!closed) I.timer = setTimeout(() => { I.timer = null; poll(I); }, ms); }
  async function poll(I, force) {
    if (closed) return;
    if (I.polling) { if (force) schedule(I, 400); return; }
    if (!force && Date.now() - I.asked > 20000) return;       // nobody is looking (wallpaper covered / paused): stop
    if (I.busy) return schedule(I, 1000);                      // a switch is running: PortTik does its own reads
    I.polling = true;
    try { await I.ready; await reloadShared(I); digest(I, await I.collector.collect(force ? { force: true, fresh: true } : {})); }
    catch (e) { I.fails++; if (I.state !== 'lost') event(I, `switch link lost :: ${e.message}`, 'error'); I.state = 'lost'; I.view = { ...(I.view || { ports: [] }), state: 'lost', error: e.message, since: 0, frozen: true }; }
    finally { I.polling = false; }
    const wait = I.state === 'live' ? everyMs() : I.state === 'nopass' ? 15000 : Math.min(60000, everyMs() * Math.pow(2, Math.min(I.fails, 4)));
    schedule(I, wait);
  }

  function view(demo) {
    if (!demo && cfg().enabled !== true) return { state: 'off', ports: [], events: [], ev: 0 };   // optional: needs PortTik + a TP-Link Easy Smart switch
    const I = instance(demo || cfg().demo);
    if (!I) return { state: 'nomodule', error: ptError || 'PortTik není k dispozici', ports: [], events: [], ev: 0 };
    I.asked = Date.now();
    if (!I.timer && !I.polling) schedule(I, 0);
    const v = I.view || { state: 'init', ports: [] };
    // PC's LAN cable unplugged: say so instead of "no password" / "switch lost"
    if (!I.demo && !lanUp()) return { ...v, state: 'nolan', error: 'LAN kabel není připojený', frozen: true, demo: false, busy: I.busy, events: I.events.slice(-6), ev: I.evId, now: Date.now() };
    return { ...v, state: I.view ? v.state : 'init', demo: I.demo, busy: I.busy, events: I.events.slice(-6), ev: I.evId, now: Date.now(),
      hasPassword: I.demo ? true : !!I.settings.hasSecret('tl') };
  }

  // ---- the PC's own port: preview, then switch with the one-time token from the preview ----
  function guard(I, mode) {
    if (!I) throw new Error(ptError || 'PortTik není k dispozici');
    if (!Object.prototype.hasOwnProperty.call(MODES, mode)) throw new Error('Neznámý režim');
    if (I.busy) throw new Error('Právě probíhá: ' + I.busy);
  }
  async function preview(demo, mode) {
    const I = instance(demo || cfg().demo); guard(I, mode);
    const port = I.settings.get().adminPort;
    await I.ready;
    const r = await I.collector.previewSwitch(port, mode);     // live read of the VLAN table + PortTik's plan; writes nothing
    if (!r.steps.length) { I.token = null; event(I, `port ${port} :: už je ${MODES[mode]} :: beze změny`); return { ok: true, noop: true, port, to: r.to }; }
    I.token = { token: crypto.randomBytes(12).toString('hex'), mode, until: Date.now() + 25000 };
    event(I, `port ${port} -> ${MODES[mode]} :: VLAN ${r.to} :: ${r.steps.length} ${r.steps.length === 1 ? 'krok' : 'kroky'} :: potvrď druhým klikem`);
    return { ok: true, port, to: r.to, steps: r.steps, token: I.token.token, ttl: 25000 };
  }
  function doSwitch(demo, mode, token) {
    const I = instance(demo || cfg().demo); guard(I, mode);
    const t = I.token; I.token = null;                          // one use, whatever happens
    if (!t || t.token !== token || t.mode !== mode || Date.now() > t.until) throw new Error('Potvrzení vypršelo – klikni na režim znovu');
    const port = I.settings.get().adminPort;
    I.busy = `Přepínám port ${port}…`;
    event(I, `port ${port} :: reassign vlan -> ${MODES[mode]} ...`);
    (async () => {
      try {
        const r = await I.collector.switchPort(port, mode, { onProgress: (m) => { I.busy = m; event(I, m); } });
        if (r.changed) {
          event(I, `port ${port} :: reassign vlan -> ${MODES[mode]} :: VLAN ${r.to} :: OK`);
          I.mode = mode;
          I.busy = 'Ověřuji internet…';
          try { const p = await I.collector.testFromPc(); event(I, `ping 1.1.1.1 :: ${p.replies === null ? 'n/a' : p.replies + '/' + p.of}${p.avgMs ? ' :: ' + p.avgMs + ' ms' : ''}`, p.replies ? 'info' : 'error'); } catch {}
        } else event(I, `port ${port} :: beze změny`);
      } catch (e) {
        // PortTik decided and reported; nothing is repeated from here
        event(I, `port ${port} :: CHYBA :: ${e.message}`, 'error');
        log(I.demo ? 'ports(demo)' : 'ports', 'switch failed:', e.message);
      } finally {
        I.busy = null;
        I.asked = Date.now();
        poll(I, true);
      }
    })();
    return { ok: true, started: true, port };
  }

  // ---- password (real switch only): Nullwave's own safeStorage, never logged, never sent anywhere but the switch ----
  function setPassword(value) {
    const I = instance(false);
    if (!I) throw new Error(ptError || 'PortTik není k dispozici');
    if (I.busy) throw new Error('Právě probíhá akce na TP-Linku');
    I.settings.setSecret('tl', String(value || ''));
    I.collector.resetClients();
    I.fails = 0; I.state = 'init'; I.asked = Date.now();
    event(I, value ? 'password stored :: connecting ...' : 'password removed');
    poll(I, true);
    return passwordInfo();
  }
  function passwordInfo() {
    const I = instance(false);
    if (!I) return { ok: false, error: ptError };
    const s = I.settings.get();
    return { ok: true, has: !!I.settings.hasSecret('tl'), canEncrypt: !!I.settings.canEncrypt(), host: s.tl.host, username: s.tl.username || 'admin', shared: !!I.settings.shared };
  }

  // "Otevřít port": PortTik has no link to the switch's web page - a port is opened in PortTik's own port dialog.
  // So this starts PortTik; only when its exe is not built does it fall back to the switch's web admin.
  function open() {
    const exe = path.join(ptDir(), 'out', 'PortTik-win32-x64', 'PortTik.exe');
    const I = instance(false);
    const run = (cmd, args) => { const p = spawn(cmd, args, { detached: true, stdio: 'ignore', windowsHide: false }); p.on('error', (e) => log('ports open', e.message)); p.unref(); };
    if (fs.existsSync(exe)) { run(exe, []); return { ok: true, opened: 'porttik' }; }
    const h = I ? I.settings.get().tl.host : '';
    if (!/^[\w.-]+$/.test(h)) return { ok: false, error: 'PortTik.exe nenalezen' };
    run('cmd.exe', ['/c', 'start', '', 'http://' + h + '/']);
    return { ok: true, opened: 'web' };
  }

  function shutdown() {
    closed = true;
    for (const I of [inst.real, inst.demo]) { if (!I) continue; clearTimeout(I.timer); try { I.collector.close(); } catch {} }
  }

  return { view, preview, switch: doSwitch, setPassword, passwordInfo, open, shutdown };
}

module.exports = { createPorts };

// wired adapter ("Ethernet", "Ethernet 2", …) with a real IPv4 = cable plugged in
function lanUp() {
  const ifs = require('os').networkInterfaces();
  return Object.entries(ifs).some(([name, addrs]) => /^ethernet( \d+)?$/i.test(name) &&
    addrs.some((a) => a.family === 'IPv4' && !a.internal && !a.address.startsWith('169.254.')));
}
