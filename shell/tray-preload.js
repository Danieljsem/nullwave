const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('tray', {
  onData: (cb) => { ipcRenderer.removeAllListeners('tray-data'); ipcRenderer.on('tray-data', (_e, d) => cb(d)); },
  act: (key, how) => ipcRenderer.invoke('tray-act', key, how),   // how: 'left' | 'right'
  peek: () => ipcRenderer.invoke('tray-peek'),
  close: () => ipcRenderer.invoke('tray-close'),
});
