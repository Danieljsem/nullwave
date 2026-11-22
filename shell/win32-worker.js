// Helper thread of the Nullwave shell. Keeps every call that could wait on Explorer or on another
// application away from the Electron main thread (which owns windows that live inside Explorer's desktop).
'use strict';
const { parentPort } = require('worker_threads');
const W = require('./win32');
const { createPoller } = require('./poller');

const poller = createPoller((m) => parentPort.postMessage(m));
let deadman = null;
parentPort.on('message', (m) => {
  try {
    if (m.t === 'cfg') poller.config(m.cfg);
    else if (m.t === 'poke') poller.poke(m.ms);
    else if (m.t === 'op') {
      let res, err = null;
      try { res = m.op === 'refitAll' ? poller.refitAll() : W.ops[m.op](...(m.args || [])); } catch (e) { err = String(e && e.message || e); }
      parentPort.postMessage({ t: 'res', id: m.id, res, err });
    } else if (m.t === 'arm') {
      // the app is quitting: if the main thread gets stuck, bring the Windows taskbar back and end the process
      poller.stop();
      clearTimeout(deadman);
      deadman = setTimeout(() => { try { W.showTrays(true); } catch {} W.selfTerminate(0); }, m.ms || 45000);
    }
  } catch (e) { parentPort.postMessage({ t: 'err', where: 'worker', msg: String(e && e.stack || e) }); }
});
poller.start();
setInterval(() => parentPort.postMessage({ t: 'alive' }), 2000);
parentPort.postMessage({ t: 'ready' });
