import { app, BrowserWindow, ipcMain, nativeTheme, protocol, screen, session } from 'electron';
import { resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { IPC } from '../src/shared/api';
import { hardenContents, secureSession, START_URL, validateSender } from './security';
import { serveHorizon } from './protocol';
import { createBrowser, isProfileSession } from './browser';
import { cleanupPartitions, readRegistry } from './profiles';
import { createSettings } from './settings';

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
  hardenContents(contents, isProfileSession(contents.session));
});

app.whenReady().then(async () => {
  const registryPath = resolve(app.getPath('userData'), 'profiles.json');
  const language = app.getLocale().toLowerCase().split('-')[0] === 'es' ? 'es' : 'en';
  const registry = cleanupPartitions(app.getPath('sessionData'), registryPath, readRegistry(registryPath, language), app.getPath('userData'));
  secureSession(session.defaultSession);
  const tokens = readFileSync(resolve(__dirname, '../tokens.css'), 'utf8');
  const settings = createSettings(resolve(app.getPath('userData'), 'settings.json'), () => { window.setBackgroundColor(background()); }, nativeTheme.shouldUseHighContrastColors);
  const background = () => {
    const resolved = settings.theme === 'system' ? nativeTheme.shouldUseDarkColors ? 'amber' : 'daylight' : settings.theme;
    const palette = settings.contrast === 'high' ? resolved === 'amber' ? 'contrast-dark' : 'contrast-light' : resolved;
    const page = tokens.match(new RegExp(`--palette-${palette}-page:\\s*(#[a-fA-F0-9]{6})`))?.[1];
    if (!page) throw new Error('Missing theme background');
    return page;
  };
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
    icon: resolve(__dirname, '../icon.png'),
    backgroundColor: background(),
    webPreferences: {
      preload: resolve(__dirname, 'preload.js'),
      additionalArguments: [`--horizon-theme=${settings.theme}`, `--horizon-contrast=${settings.contrast}`, `--horizon-theme-migrate=${settings.migrationAllowed ? 1 : 0}`],
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
  const systemTheme = () => { if (settings.theme === 'system') window.setBackgroundColor(background()); };
  nativeTheme.on('updated', systemTheme);
  window.once('closed', () => nativeTheme.removeListener('updated', systemTheme));
  window.removeMenu();
  const browser = createBrowser(window, app.getPath('userData'), app.getPath('downloads'), settings, registry);
  // The interface draws at 92% of the design frame and shrinks with a smaller window, never below 75%, so text and targets stay usable.
  const fitScale = () => {
    const { width, height } = window.getContentBounds();
    window.webContents.setZoomFactor(Math.max(0.75, 0.92 * Math.min(1, width / DESIGN_WIDTH, height / DESIGN_HEIGHT)));
    browser.layout();
  };
  window.on('resize', fitScale);
  window.webContents.on('did-finish-load', fitScale);
  ipcMain.handle(IPC.language, (event, ...args: unknown[]) => {
    validateSender(event, window.webContents);
    if (args.length) throw new Error('Unexpected language argument');
    return app.getLocale().toLowerCase().split('-')[0] === 'es' ? 'es' : 'en';
  });
  ipcMain.handle(IPC.windowAction, (event, ...args: unknown[]) => {
    validateSender(event, window.webContents);
    if (args.length !== 1) throw new Error('Invalid window action arguments');
    const action = args[0];
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
