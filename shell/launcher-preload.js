const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('nw', {
  apps: () => ipcRenderer.invoke('nw-apps'),
  launch: (p) => ipcRenderer.invoke('nw-launch', p),
  hide: () => ipcRenderer.invoke('nw-hide'),
  panel: () => ipcRenderer.invoke('nw-panel'),
  onOpen: (cb) => { ipcRenderer.removeAllListeners('nw-open'); ipcRenderer.on('nw-open', () => cb()); },
});
