import { app, BrowserWindow, ipcMain, nativeTheme, protocol, screen, session } from 'electron';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { IPC } from '../src/shared/api';
import { secureSession, START_URL, validateSender } from './security';
import { serveHorizon } from './protocol';

// The approved design frame: the window and the interface scale are both sized against it.
const DESIGN_WIDTH = 1440;
const DESIGN_HEIGHT = 900;

// Development and verification must keep Chromium's writable state inside this repository.
if (!app.isPackaged) {
  const runtime = resolve(__dirname, '../../.runtime');
  app.setPath('userData', runtime);
  app.setPath('sessionData', runtime);
  app.setPath('crashDumps', resolve(runtime, 'crashes'));
  app.setAppLogsPath(resolve(runtime, 'logs'));
}

app.enableSandbox();
protocol.registerSchemesAsPrivileged([
  { scheme: 'horizon', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
]);

app.on('web-contents-created', (_event, contents) => {
  contents.on('will-navigate', (event) => event.preventDefault());
  contents.on('will-frame-navigate', (event) => event.preventDefault());
  contents.on('will-redirect', (event) => event.preventDefault());
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
});

app.whenReady().then(async () => {
  secureSession(session.defaultSession);
  const tokens = readFileSync(resolve(__dirname, '../tokens.css'), 'utf8');
  const page = tokens.match(new RegExp(`--palette-${nativeTheme.shouldUseDarkColors ? 'amber' : 'daylight'}-page:\\s*(#[a-fA-F0-9]{6})`))?.[1];
  // A work area smaller than the design frame gets a window that still leaves room around it.
  const area = screen.getPrimaryDisplay().workAreaSize;
  const window = new BrowserWindow({
    width: Math.min(DESIGN_WIDTH, Math.round(area.width * 0.9)),
    height: Math.min(DESIGN_HEIGHT, Math.round(area.height * 0.9)),
    center: true,
    minWidth: 640,
    minHeight: 480,
    frame: false,
    show: false,
    backgroundColor: page,
    webPreferences: {
      preload: resolve(__dirname, 'preload.js'),
      nodeIntegration: false,
      nodeIntegrationInWorker: false,
      nodeIntegrationInSubFrames: false,
      contextIsolation: true,
      sandbox: true,
      webSecurity: true,
      allowRunningInsecureContent: false,
      experimentalFeatures: false,
      webviewTag: false,
      devTools: !app.isPackaged,
    },
  });
  window.removeMenu();
  // The interface draws at 92% of the design frame and shrinks with a smaller window, never below 75%, so text and targets stay usable.
  const fitScale = () => {
    const { width, height } = window.getContentBounds();
    window.webContents.setZoomFactor(Math.max(0.75, 0.92 * Math.min(1, width / DESIGN_WIDTH, height / DESIGN_HEIGHT)));
  };
  window.on('resize', fitScale);
  window.webContents.on('did-finish-load', fitScale);
  ipcMain.handle(IPC.language, (event) => {
    validateSender(event, window.webContents);
    return app.getLocale().toLowerCase().split('-')[0] === 'es' ? 'es' : 'en';
  });
  ipcMain.handle(IPC.windowAction, (event, action: unknown) => {
    validateSender(event, window.webContents);
    if (action === 'minimize') window.minimize();
    else if (action === 'maximize') {
      if (window.isMaximized()) window.unmaximize();
      else window.maximize();
    } else if (action === 'close') window.close();
    else throw new Error('Invalid window action');
  });
  await serveHorizon(session.defaultSession.protocol, resolve(__dirname, '../renderer'));
  window.once('ready-to-show', () => window.show());
  await window.loadURL(START_URL);
}).catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});

app.on('window-all-closed', () => app.quit());
