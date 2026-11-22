const { contextBridge, ipcRenderer } = require('electron');
contextBridge.exposeInMainWorld('tlpass', {
  info: () => ipcRenderer.invoke('tlpass-info'),
  set: (value) => ipcRenderer.invoke('tlpass-set', value),
  close: () => ipcRenderer.invoke('tlpass-close'),
});
