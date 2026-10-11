import { contextBridge, ipcRenderer } from 'electron';

// Exposed to the web app as window.desktop (see apps/web/src/lib/platform.ts).
contextBridge.exposeInMainWorld('desktop', {
  isDesktop: true,
  platform: process.platform,
  savePng: (dataUrl: string, name: string) => ipcRenderer.invoke('save-png', { dataUrl, name }),
});
