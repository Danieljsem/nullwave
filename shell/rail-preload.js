const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('rail', {
  onUpdate: (cb) => { ipcRenderer.removeAllListeners('rail-update'); ipcRenderer.on('rail-update', (_e, u) => cb(u)); },
  click: (key, how) => ipcRenderer.invoke('rail-click', key, how),   // how: 'left' | 'middle' | 'context'
  launcher: () => ipcRenderer.invoke('rail-launcher'),
  peek: () => ipcRenderer.invoke('rail-peek'),
  tray: (frac) => ipcRenderer.invoke('rail-tray', frac),   // notification-area flyout; frac = button bottom / window height
  sys: (what) => ipcRenderer.invoke('rail-sys', what),   // start | search | taskview | quick | notif | desktop | volup | voldown | mute
  metrics: (m) => ipcRenderer.send('rail-metrics', m),
});
