const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  exportCard: (rect, name) => ipcRenderer.invoke('export-card', { rect, name }),
});
