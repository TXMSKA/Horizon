import { app, BrowserWindow, ipcMain, nativeTheme, protocol, safeStorage, screen, session } from 'electron';
import { dirname, resolve } from 'node:path';
import { readFileSync } from 'node:fs';
import { IPC } from '../src/shared/api';
import { hardenContents, secureSession, START_URL, validateSender } from './security';
import { serveHorizon } from './protocol';
import { createBrowser, isLaunchNavigation, isProfileSession, restoredWindows } from './browser';
import { cleanupPartitions, profileStorePath, readRegistry } from './profiles';
import { readWindowSessions, writeWindowSessions } from './session-store';
import { createSettings, resolveLanguage } from './settings';
import { launchAddress } from './launch';
import { darkPagesActive, setDarkPagesSwitch } from './dark-pages';
import { existingExtensions, profileExtensions } from './extensions';

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

const instance = app.requestSingleInstanceLock();
if (!instance) app.quit();
if (instance) {
  let launchWindow: BrowserWindow | undefined;
  let launchBrowser: ReturnType<typeof createBrowser> | undefined;
  let launchReady = false;
  let openNormalWindow: (() => Promise<unknown>) | undefined;
  const pendingLaunches: string[] = [];
  const deliverLaunches = () => {
    if ((!launchWindow || launchWindow.isDestroyed()) && pendingLaunches.length && openNormalWindow) { void openNormalWindow().then(deliverLaunches); return; }
    if (!launchReady || !launchWindow || !launchBrowser || launchWindow.isDestroyed()) return;
    while (pendingLaunches.length) {
      const address = pendingLaunches.shift()!;
      try { launchBrowser.openLaunch(address); } catch { /* A full tab list must still let an existing instance focus. */ }
    }
    if (launchWindow.isMinimized()) launchWindow.restore();
    launchWindow.show(); launchWindow.focus();
  };
  const initialLaunch = launchAddress(process.argv);
  if (initialLaunch) pendingLaunches.push(initialLaunch);
  app.on('second-instance', (_event, args, directory) => {
    const address = launchAddress(args, directory);
    if (address) pendingLaunches.push(address);
    deliverLaunches();
  });

  app.enableSandbox();
  protocol.registerSchemesAsPrivileged([
    { scheme: 'horizon', privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true } },
  ]);

  app.on('web-contents-created', (_event, contents) => {
    hardenContents(contents, isProfileSession(contents.session) || !!existingExtensions(contents.session), url => isLaunchNavigation(contents, url));
  });

  app.whenReady().then(async () => {
    const windows = new Map<Electron.WebContents, { window: BrowserWindow; browser: ReturnType<typeof createBrowser>; ready: boolean }>();
    const registryPath = resolve(app.getPath('userData'), 'profiles.json');
    const settings = createSettings(resolve(app.getPath('userData'), 'settings.json'), () => {
      for (const { window } of windows.values()) window.setBackgroundColor(background());
      windows.values().next().value?.browser.settingsChanged?.();
    }, nativeTheme.shouldUseHighContrastColors);
    const language = resolveLanguage(settings.language, app.getLocale());
    const registry = cleanupPartitions(app.getPath('sessionData'), registryPath, readRegistry(registryPath, language), app.getPath('userData'));
    const extensions = registry.profiles.map(profile => profileExtensions(app.getPath('userData'), profile, session.fromPartition(profile.partition), () => { for (const { browser } of windows.values()) browser.extensionsChanged(); }));
    await Promise.all(extensions.map(manager => manager.ready));
    secureSession(session.defaultSession);
    const tokens = readFileSync(resolve(__dirname, '../tokens.css'), 'utf8');
    if (darkPagesActive(settings.darkPages, nativeTheme.shouldUseDarkColors)) setDarkPagesSwitch(app.commandLine, true);
    const background = () => {
      const resolved = settings.theme === 'system' ? nativeTheme.shouldUseDarkColors ? 'amber' : 'daylight' : settings.theme;
      const palette = settings.contrast === 'high' ? resolved === 'amber' ? 'contrast-dark' : 'contrast-light' : resolved;
      const page = tokens.match(new RegExp(`--palette-${palette}-page:\\s*(#[a-fA-F0-9]{6})`))?.[1];
      if (!page) throw new Error('Missing theme background');
      return page;
    };
    // A work area smaller than the design frame gets a window that still leaves room around it.
    const createWindow = async (profileId?: string, privateWindow = false, origin?: BrowserWindow, id?: string, fresh = true, adoption?: { adopt(destinationId: string): void; point?: { x: number; y: number } }) => {
      const offset = origin && !origin.isDestroyed() ? origin.getBounds() : undefined;
      const bounds = adoption && origin && offset && (origin.isMaximized() || origin.isFullScreen()) ? origin.getNormalBounds() : offset;
      const display = adoption?.point ? screen.getDisplayNearestPoint(adoption.point) : offset ? screen.getDisplayMatching(offset) : screen.getPrimaryDisplay();
      const area = display.workAreaSize;
      const width = adoption && bounds ? bounds.width : Math.min(DESIGN_WIDTH, Math.round(area.width * 0.9));
      const height = adoption && bounds ? bounds.height : Math.min(DESIGN_HEIGHT, Math.round(area.height * 0.9));
      const workArea = display.workArea;
      profileId ??= windows.values().next().value?.browser.registry().activeId ?? registry.activeId;
      const window = new BrowserWindow({
        width,
        height,
        ...(offset ? { x: Math.round(Math.max(workArea.x, Math.min(adoption?.point ? adoption.point.x - 80 : offset.x + 32, workArea.x + workArea.width - width))), y: Math.round(Math.max(workArea.y, Math.min(adoption?.point ? adoption.point.y - 20 : offset.y + 32, workArea.y + workArea.height - height))) } : { center: true }),
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
          // Chromium shares one zoom level across the windows of an origin, so each window's fit to its own size would rescale the others.
          zoomMode: 'isolated',
        },
      });
      const systemTheme = () => { if (settings.theme === 'system') window.setBackgroundColor(background()); };
      nativeTheme.on('updated', systemTheme);
      window.once('closed', () => nativeTheme.removeListener('updated', systemTheme));
      window.removeMenu();
      const browser = createBrowser(window, app.getPath('userData'), app.getPath('downloads'), settings, registry, undefined, { id, profileId, privateWindow, fresh, empty: Boolean(adoption),
        openWindow: (profileId, privateWindow, origin) => { void createWindow(profileId, privateWindow, origin).catch(() => console.error('Window creation failed')); },
        moveWindow: async (profileId, privateWindow, origin, adopt, point) => { await createWindow(profileId, privateWindow, origin, undefined, true, { adopt, point }); } });
      // A destroyed window can no longer hand out its webContents, so the entry's key is kept from now.
      const chromeContents = window.webContents;
      const entry = { window, browser, ready: false }; windows.set(chromeContents, entry);
      if (!privateWindow && (!launchWindow || launchWindow.isDestroyed())) { launchWindow = window; launchBrowser = browser; launchReady = false; }
      window.once('closed', () => {
        windows.delete(chromeContents);
        if (launchWindow === window) {
          const next = [...windows.values()].find(entry => !entry.browser.privateWindow);
          launchWindow = next?.window; launchBrowser = next?.browser; launchReady = next?.ready ?? false;
        }
      });
      // The interface draws at 92% of the design frame and shrinks with a smaller window, never below 75%, so text and targets stay usable.
      const fitScale = () => {
        const { width, height } = window.getContentBounds();
        window.webContents.setZoomFactor(Math.max(0.75, 0.92 * Math.min(1, width / DESIGN_WIDTH, height / DESIGN_HEIGHT)));
        browser.layout();
      };
      window.on('resize', fitScale);
      window.webContents.on('did-finish-load', fitScale);
      if (!adoption) window.once('ready-to-show', () => window.show());
      try {
        await window.loadURL(START_URL);
        if (adoption) {
          adoption.adopt(browser.windowId);
          window.show(); window.focus();
        }
      } catch (error) {
        if (!window.isDestroyed()) window.destroy();
        throw error;
      }
      entry.ready = true;
      if (launchWindow === window) launchReady = true;
      if (pendingLaunches.length) deliverLaunches();
      return window;
    };
    ipcMain.handle(IPC.language, (event, ...args: unknown[]) => {
      const entry = windows.get(event.sender); if (!entry) throw new Error('Unknown browser window');
      validateSender(event, entry.window.webContents);
      if (args.length) throw new Error('Unexpected language argument');
      return resolveLanguage(settings.language, app.getLocale());
    });
    ipcMain.handle(IPC.windowAction, (event, ...args: unknown[]) => {
      const entry = windows.get(event.sender); if (!entry) throw new Error('Unknown browser window');
      const window = entry.window;
      validateSender(event, window.webContents);
      if (args.length !== 1) throw new Error('Invalid window action arguments');
      const action = args[0];
      if (action === 'minimize') window.minimize();
      else if (action === 'maximize') { if (window.isMaximized()) window.unmaximize(); else window.maximize(); }
      else if (action === 'close') window.close();
      else throw new Error('Invalid window action');
    });
    await serveHorizon(session.defaultSession.protocol, resolve(__dirname, '../renderer'));
    openNormalWindow = () => createWindow();
    const previous = restoredWindows(app.getPath('userData'), registry);
    const saved = settings.onStart === 'restore' ? previous : previous.slice(0, 1).map(window => ({ ...window, profileId: registry.activeId }));
    if (settings.onStart === 'new-page' && previous.length > 1) {
      for (const profile of registry.profiles) {
        const path = resolve(dirname(profileStorePath(app.getPath('userData'), profile.id)), 'session.json');
        const status = { readError: false, memoryOnly: false };
        const sessions = readWindowSessions(path, safeStorage, url => url.startsWith('horizon://desktop/'), status);
        if (status.memoryOnly) continue;
        sessions.windows = sessions.windows.filter(window => window.id === saved[0]!.id);
        writeWindowSessions(path, sessions, safeStorage);
      }
    }
    if (saved.length) for (const { id, profileId } of saved) await createWindow(profileId, false, undefined, id, false);
    else await createWindow(registry.activeId, false, undefined, undefined, false);
    const normalWindowOpen = () => [...windows.values()].some(({ window, browser }) => !browser.privateWindow && !window.isDestroyed());
    for (const manager of extensions) void manager.startUpdates(normalWindowOpen).catch(() => {});
  }).catch((error: unknown) => {
    console.error(error);
    app.exit(1);
  });

  app.on('window-all-closed', () => app.quit());
}
