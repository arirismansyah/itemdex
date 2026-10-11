// Electron shell: boots the ITEMDEX service in-process and opens the UI.

const path = require('path');
const fs = require('fs');
const { app, BrowserWindow, ipcMain, dialog, session, shell, systemPreferences } = require('electron');
const { startServer } = require('../service/server');

let win;
let serviceUrl;

async function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 960,
    minHeight: 640,
    backgroundColor: '#0f0b1e',
    title: 'ITEMDEX',
    show: false,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  // Only the local service may use the camera and location.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(['media', 'geolocation'].includes(permission) && wc.getURL().startsWith(serviceUrl));
  });
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) shell.openExternal(url);
    return { action: 'deny' };
  });

  win.once('ready-to-show', () => win.show());
  await win.loadURL(serviceUrl);
  if (process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

// Capture a region of the page (the card) and save it as PNG.
ipcMain.handle('export-card', async (_e, { rect, name }) => {
  const image = await win.webContents.capturePage({
    x: Math.round(rect.x),
    y: Math.round(rect.y),
    width: Math.round(rect.width),
    height: Math.round(rect.height),
  });
  const safe = String(name || 'card').replace(/[^\w-]+/g, '_').slice(0, 40);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export card',
    defaultPath: path.join(app.getPath('pictures'), `itemdex_${safe}.png`),
    filters: [{ name: 'PNG', extensions: ['png'] }],
  });
  if (canceled || !filePath) return { saved: false };
  fs.writeFileSync(filePath, image.toPNG());
  return { saved: true, filePath };
});

app.whenReady().then(async () => {
  const dataDir = process.env.DATA_DIR || path.join(app.getPath('userData'), 'itemdex-data');
  try {
    // Desktop: local-only, no API key / CORS regardless of .env (those are for hosted mode).
    ({ url: serviceUrl } = await startServer({
      port: 0, host: '127.0.0.1', dataDir, apiKey: '', corsOrigins: '',
    }));
  } catch (err) {
    dialog.showErrorBox('ITEMDEX failed to start', err.message);
    app.quit();
    return;
  }
  console.log(`ITEMDEX service at ${serviceUrl} (data: ${dataDir})`);
  // macOS: trigger the system camera prompt before the viewfinder asks for it.
  if (process.platform === 'darwin') await systemPreferences.askForMediaAccess('camera').catch(() => {});
  await createWindow();

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => app.quit());
