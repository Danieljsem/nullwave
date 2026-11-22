// Periodic Win32 polling for the Nullwave shell: window list for the rail, covered / fullscreen monitors,
// maximized windows that need a new layout, the hidden Windows taskbar and the mouse over the desktop.
// Runs on the helper thread (win32-worker.js); if that thread cannot start, main.js runs the same code
// inline at a lower rate. It only posts when something changed, so the main thread stays idle.
'use strict';
const W = require('./win32');

function createPoller(post, rate) {
  rate = rate || { snap: 450, mouse: 33 };
  const cfg = { ownPid: process.pid, allowOwn: [], mons: [], desk: null, hideTrays: false, peekUntil: 0, refit: false };
  let lastSnap = '', lastFg = 0, snapT = null, mouseT = null, stopped = false, monsAt = 0;
  const tries = new Map();   // maximized window -> { n, at } (do not fight an application that refuses)
  // mouse state
  let over = false, down = false, lastBtn = false, lx = -1, ly = -1;

  function snap() {
    if (stopped) return;
    try {
      // work areas change when app bars come and go: refresh the monitor list every couple of seconds
      if (Date.now() - monsAt > 2000 || !cfg.mons.length) { cfg.mons = W.monitors(); monsAt = Date.now(); }
      const s = W.snapshot(cfg);
      lastFg = s.fg.h;
      if (cfg.refit) {
        const now = Date.now();
        for (const m of s.misfit) {
          const t = tries.get(m.h) || { n: 0, at: 0 };
          if (t.n >= 3 || now - t.at < 1500) continue;
          W.refit(m, t.n); tries.set(m.h, { n: t.n + 1, at: now });
        }
        if (tries.size) { const bad = new Set(s.misfit.map((m) => m.h)); for (const [h, t] of tries) if (!bad.has(h) && now - t.at > 4000) tries.delete(h); }
      }
      if (cfg.hideTrays && Date.now() > cfg.peekUntil && W.traysVisible()) W.showTrays(false);
      const out = { wins: s.wins, fg: s.fg, covered: s.covered, full: s.full, work: cfg.mons.map((m) => m.work), mons: cfg.mons.map((m) => `${m.x},${m.y},${m.width}x${m.height}@${m.dpi}`) };
      const key = JSON.stringify(out);
      if (key !== lastSnap) { lastSnap = key; post({ t: 'snap', snap: out }); }
    } catch (e) { post({ t: 'err', where: 'snap', msg: String(e && e.stack || e) }); }
  }
  function snapLoop() { snap(); if (!stopped) snapT = setTimeout(snapLoop, rate.snap); }
  function soon(ms) { if (stopped) return; clearTimeout(snapT); snapT = setTimeout(snapLoop, ms || 60); }

  let tick = 0;
  function mouse() {
    if (stopped) return;
    try {
      // a foreground change shows on the rail right away
      if (++tick % 4 === 0 && Number(W.f.GetForegroundWindow()) !== lastFg) { lastFg = Number(W.f.GetForegroundWindow()); soon(30); }
      const d = cfg.desk;
      if (!d) { if (over || down) release(lx, ly); return; }
      const p = W.pointer(d);
      if (!p) return;
      const x = p.x - d.x, y = p.y - d.y;
      if (p.desk) {
        if (!over || x !== lx || y !== ly) post({ t: 'mouse', type: 'mouseMove', x, y });
        if (p.btn && !lastBtn) { down = true; post({ t: 'mouse', type: 'mouseDown', x, y }); }
        if (!p.btn && down) { down = false; post({ t: 'mouse', type: 'mouseUp', x, y }); }
        over = true; lx = x; ly = y;
      } else if (over || down) release(x, y);
      lastBtn = p.btn;
    } catch (e) { post({ t: 'err', where: 'mouse', msg: String(e && e.stack || e) }); }
  }
  // the cursor left the desktop: finish a started click and move the page's pointer away
  function release(x, y) {
    if (down) post({ t: 'mouse', type: 'mouseUp', x, y });
    post({ t: 'mouse', type: 'mouseMove', x: -10, y: -10 });
    over = false; down = false;
  }

  return {
    start() { snapLoop(); mouseT = setInterval(mouse, rate.mouse); },
    stop() { stopped = true; clearTimeout(snapT); clearInterval(mouseT); },
    config(c) { const was = cfg.refit; Object.assign(cfg, c); if (cfg.refit && !was) tries.clear(); soon(); },
    poke(ms) { soon(ms); },
    // one more layout pass for maximized windows (used after our app bars are gone)
    refitAll() { try { cfg.mons = W.monitors(); monsAt = Date.now(); const s = W.snapshot(cfg); for (const m of s.misfit) W.refit(m, 0); return s.misfit.length; } catch { return -1; } },
  };
}
module.exports = { createPoller };
