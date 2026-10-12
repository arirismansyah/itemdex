// Electron shell for ITEMDEX.
//
// Local mode (default): runs the ITEMDEX service inside this process (no extra Node
// process) against your PostgreSQL, and opens the bundled web app from it.
// Remote mode: set ITEMDEX_SERVER_URL to use a hosted service instead (thin client).
//
// Config: environment variables, then <userData>/itemdex.env (created on first run),
// then the repo .env when running from source.

import fs from 'node:fs';
import path from 'node:path';
import dotenv from 'dotenv';
import { app, BrowserWindow, dialog, ipcMain, session, shell, systemPreferences } from 'electron';
import { loadConfig, startServer, type ServerHandle } from '@itemdex/server';

const isDev = process.argv.includes('--dev') || !app.isPackaged;
let win: BrowserWindow | null = null;
let server: ServerHandle | null = null;
let appUrl = '';

const CONFIG_TEMPLATE = `# ITEMDEX desktop configuration. Restart the app after editing.

# PostgreSQL connection, e.g. postgres://postgres:PASSWORD@localhost:5432/itemdex-ai-builder
DATABASE_URL=

# AI model: any OpenAI-compatible vision server (can also be set in the app, gear icon)
LLM_API_BASE=
LLM_API_KEY=
LLM_MODEL=

# Optional
# CARD_LANGUAGE=Indonesian
# CURRENCY=IDR
# MARKET=Indonesian
# REVERSE_GEOCODE=true

# Use a hosted ITEMDEX service instead of the local one (then the settings above are ignored)
# ITEMDEX_SERVER_URL=https://itemdex.example.com
`;

function configFile() {
  return path.join(app.getPath('userData'), 'itemdex.env');
}

const shellEnv = new Set(Object.keys(process.env));

// Re-readable on "Retry", so edits to the config file apply without restarting.
function loadEnv() {
  const file = configFile();
  if (!fs.existsSync(file)) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, CONFIG_TEMPLATE);
  }
  const files = [file];
  if (isDev) {
    let dir = __dirname;
    for (let i = 0; i < 4; i++, dir = path.dirname(dir)) {
      const p = path.join(dir, '.env');
      if (fs.existsSync(p)) { files.push(p); break; }
    }
  }
  // Shell env wins, then the userData config, then the repo .env (dev only).
  const merged: Record<string, string> = {};
  for (const f of files.reverse()) {
    for (const [k, v] of Object.entries(dotenv.parse(fs.readFileSync(f)))) if (v !== '') merged[k] = v;
  }
  for (const [k, v] of Object.entries(merged)) if (!shellEnv.has(k)) process.env[k] = v;
}

async function failAndOfferConfig(title: string, detail: string): Promise<'retry' | 'quit'> {
  const { response } = await dialog.showMessageBox({
    type: 'error',
    title,
    message: title,
    detail: `${detail}\n\nConfig file:\n${configFile()}`,
    buttons: ['Open config file', 'Retry', 'Quit'],
    defaultId: 1,
    cancelId: 2,
  });
  if (response === 0) {
    await shell.openPath(configFile());
    return failAndOfferConfig(title, detail);
  }
  return response === 1 ? 'retry' : 'quit';
}

async function startLocal(): Promise<string | null> {
  for (;;) {
    loadEnv();
    const config = loadConfig({
      host: '127.0.0.1',
      shopee: { state: path.join(app.getPath('userData'), 'shopee-state.json'), discount: Number(process.env.COMPS_DISCOUNT) || 0.9, canLogin: true },
      port: 0, // random free port
      apiKey: '', // local only: no API key / CORS regardless of env (those are for hosted mode)
      corsOrigins: [],
      webDist: path.join(__dirname, 'web'),
      openapiFile: null,
      logLevel: isDev ? 'info' : 'warn',
      dbPoolMax: 4,
    });
    if (!config.databaseUrl && !process.env.PGHOST) {
      if ((await failAndOfferConfig('Database not configured', 'Set DATABASE_URL in the config file.')) === 'quit') return null;
      continue;
    }
    try {
      server = await startServer(config);
      console.log(`ITEMDEX service at ${server.url}`);
      return server.url;
    } catch (err) {
      const e = err as Error & { code?: string };
      const detail = `${e.code ? `${e.code}: ` : ''}${e.message}`;
      if ((await failAndOfferConfig('Cannot connect to the database', detail)) === 'quit') return null;
    }
  }
}

function createWindow() {
  win = new BrowserWindow({
    width: 1360,
    height: 880,
    minWidth: 380,
    minHeight: 600,
    backgroundColor: '#0f0b1e',
    title: 'ITEMDEX',
    show: false,
    titleBarStyle: process.platform === 'darwin' ? 'hiddenInset' : 'default',
    autoHideMenuBar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      spellcheck: false,
    },
  });

  const origin = new URL(appUrl).origin;
  // Only our own pages may use the camera and location.
  session.defaultSession.setPermissionRequestHandler((wc, permission, cb) => {
    cb(['media', 'geolocation'].includes(permission) && wc.getURL().startsWith(origin));
  });
  session.defaultSession.setPermissionCheckHandler((_wc, permission, requestingOrigin) =>
    ['media', 'geolocation'].includes(permission) && requestingOrigin.startsWith(origin));

  // External links (e.g. OPEN MAP) go to the system browser; no in-app navigation away.
  win.webContents.setWindowOpenHandler(({ url }) => {
    if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    return { action: 'deny' };
  });
  win.webContents.on('will-navigate', (e, url) => {
    if (!url.startsWith(origin)) {
      e.preventDefault();
      if (/^https?:\/\//.test(url)) void shell.openExternal(url);
    }
  });

  win.once('ready-to-show', () => win?.show());
  win.on('closed', () => { win = null; });
  void win.loadURL(appUrl);
  if (isDev && process.argv.includes('--dev')) win.webContents.openDevTools({ mode: 'detach' });
}

// Save an exported card PNG (rendered by the web app) with a native dialog.
ipcMain.handle('save-png', async (_e, { dataUrl, name }: { dataUrl: string; name: string }) => {
  const m = /^data:image\/png;base64,(.+)$/s.exec(String(dataUrl));
  if (!m || !win) return { saved: false };
  const safe = String(name || 'itemdex_card.png').replace(/[^\w.-]+/g, '_').slice(0, 60);
  const { canceled, filePath } = await dialog.showSaveDialog(win, {
    title: 'Export card',
    defaultPath: path.join(app.getPath('pictures'), safe.endsWith('.png') ? safe : `${safe}.png`),
    filters: [{ name: 'PNG', extensions: ['png'] }],
  });
  if (canceled || !filePath) return { saved: false };
  await fs.promises.writeFile(filePath, Buffer.from(m[1], 'base64'));
  return { saved: true, filePath };
});

if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => {
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(async () => {
    loadEnv();
    const remote = (process.env.ITEMDEX_SERVER_URL || '').replace(/\/+$/, '');
    const url = remote || (await startLocal());
    if (!url) {
      app.quit();
      return;
    }
    appUrl = url;
    // macOS: trigger the system camera prompt before the viewfinder asks for it.
    if (process.platform === 'darwin') await systemPreferences.askForMediaAccess('camera').catch(() => false);
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => app.quit());

  // Close the HTTP server and DB pool cleanly.
  let closing = false;
  app.on('before-quit', (e) => {
    if (!server || closing) return;
    closing = true;
    e.preventDefault();
    server.close().catch(() => {}).finally(() => app.quit());
    server = null;
  });
}
