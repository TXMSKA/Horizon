import { app, clipboard, ClipboardItem, dialog, ipcMain, nativeImage, nativeTheme, safeStorage, screen, session, shell, WebContentsView } from 'electron';
import type { BrowserWindow, DownloadItem, Session, WebContents, WebPreferences } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { IPC, SEARCH_ENGINES } from '../src/shared/api';
import type { BrowserCommand, BrowserState, BrowserStore, ClearedBrowsingData, ContentArea, DesktopItem, DesktopPanelState, Profile, SettingsSection, TabState } from '../src/shared/api';
import { browserShortcut } from '../src/shared/shortcuts';
import { classifyInput, isAllowedSubframeURL, isAllowedURL, isWebURL, parseErrorName, settingsAddress, settingsSection } from './browsing';
import { readStore, reserveDownloadPath, writeStore } from './store';
import { validateSender } from './security';
import { validateCommand, validateContentArea } from './commands';
import { fetchFavicon } from './favicon';
import type { ThemeSettings } from './settings';
import { resolvedDownloadsFolder, resolveLanguage } from './settings';
import { createDefaultBrowser } from './default-browser';
import { isLocalHTMLURL } from './launch';
import { clearBeforeDeadline } from './browsing-data';
import { PageMenuSession } from './context-menu';
import { cleanupPartitions, isProfileId, makeProfile, migrateStore, PROFILE_LIMIT, profileName, profileStorePath, readRegistry, removeProfileDirectory, writeRegistry } from './profiles';
import type { ProfileRegistry } from './profiles';
import { createBlockingEngine } from './blocking';
import { listSites, PermissionQueue, requestedPermissions, resetSite, secureOrigin, setBlocking, setPermission, setSiteDark, siteHost, siteSettings, stripCookieHeaders } from './site-settings';
import { darkPagesActive, darkPagesCSS, setDarkPagesSwitch } from './dark-pages';
import { desktopInputText } from '../src/shared/desktop-input';
import { createDesktop, desktopAddress } from './desktop';
import { captureWholePage, deadline, pngSize } from './captures';
import { validCaptureRect } from '../src/shared/capture';
import { addFavorite, createFavoriteFolder, favoriteDestination, favoriteLinks, favoriteLocation, favoriteName, favoriteTitle, moveFavorite } from './favorites';

interface Tab { state: TabState; view?: WebContentsView; retryDownload?: string; findRequest?: number; navigation?: number; committed?: boolean; committedURL?: string; faviconBytes?: Buffer; faviconSite?: string; faviconRequest?: AbortController; topURL?: string; pageLoad: number; refusedCookies: Set<string>; cosmeticPending?: boolean; navigating?: boolean; darkCSS?: { contents: WebContents; key: string }; darkCSSWork?: Promise<void> }


const profileSessions = new Set<Session>();
export const isProfileSession = (target: Session): boolean => profileSessions.has(target);
const launchURLs = new WeakMap<WebContents, string>();
export const isLaunchNavigation = (contents: WebContents, url: string): boolean => launchURLs.get(contents) === url && isLocalHTMLURL(url);

export function createBrowser(window: BrowserWindow, userData: string, downloads: string, settings: ThemeSettings, initialRegistry?: ProfileRegistry, defaultBrowserOverride?: ReturnType<typeof createDefaultBrowser>) {
  const registryPath = resolve(userData, 'profiles.json');
  const language = resolveLanguage(settings.language, app.getLocale());
  let registry = initialRegistry ?? cleanupPartitions(app.getPath('sessionData'), registryPath, readRegistry(registryPath, language), userData);
  let registryError = false;
  const storageFailure = (error: unknown) => { registryError = true; console.error('Profile storage error', error); };
  try { migrateStore(userData, registry, safeStorage); } catch { registryError = true; }
  const runtimes = new Map<string, ReturnType<typeof createRuntime>>();
  let darkActive = darkPagesActive(settings.darkPages, nativeTheme.shouldUseDarkColors);
  let closing = false;
  let deleting = false;
  let clearingBrowsingData = false;
  let area: ContentArea = { top: 96, hidden: true };
  const pageMenu = new PageMenuSession();
  const invalidateMenu = (tabId?: string) => {
    if (pageMenu.invalidate(tabId) && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(IPC.contextMenu, null);
  };
  const current = () => runtimes.get(registry.activeId)!;
  const state = (): BrowserState => ({
    ...current().state(), version: app.getVersion(), activeProfileId: registry.activeId,
    profiles: registry.profiles.map(({ id, name, color }) => ({ id, name, color, tabCount: runtimes.get(id)?.tabs.length ?? 0 })),
    storageError: registryError || current().state().storageError, theme: settings.theme, contrast: settings.contrast,
    quickAccess: settings.quickAccess, showCapture: settings.showCapture,
    darkPages: { mode: settings.darkPages, strength: settings.darkStrength, tone: settings.darkTone, active: darkActive },
    searchEngine: settings.searchEngine, languageSetting: settings.language, language: resolveLanguage(settings.language, app.getLocale()),
    ...resolvedDownloadsFolder(settings, downloads), askWhereToSave: settings.askWhereToSave,
    blockAds: settings.blockAds, blockThirdPartyCookies: settings.blockThirdPartyCookies, clearingBrowsingData, defaultBrowser: defaultBrowser.status,
  });
  const publish = () => {
    if (!current() || closing || window.isDestroyed() || window.webContents.isDestroyed()) return;
    const tab = current().active()?.state;
    window.setTitle(tab?.url && tab.url !== 'about:blank' ? `${tab.title || tab.url} - Horizon` : 'Horizon');
    window.webContents.send(IPC.stateChanged, state());
  };
  const blocker = createBlockingEngine(userData, publish);
  const defaultBrowser = defaultBrowserOverride ?? createDefaultBrowser({ platform: process.platform, isPackaged: app.isPackaged, execPath: process.execPath, openExternal: url => shell.openExternal(url), changed: publish });
  const refreshDefaultBrowser = () => { void defaultBrowser.refresh().then(publish); };
  window.on('focus', refreshDefaultBrowser);
  const layout = () => { for (const runtime of runtimes.values()) runtime.layout(); };
  const saveRegistry = (next: ProfileRegistry) => { writeRegistry(registryPath, next); registry = next; };
  const runtimeFor = (profile: Profile) => {
    let runtime = runtimes.get(profile.id);
    if (!runtime) { runtime = createRuntime(profile); runtimes.set(profile.id, runtime); }
    return runtime;
  };
  const switchProfile = (id: string) => {
    const profile = registry.profiles.find(profile => profile.id === id);
    if (!profile) throw new Error('Unknown profile');
    const next = runtimeFor(profile);
    if (id !== registry.activeId) {
      saveRegistry({ ...registry, activeId: id });
      invalidateMenu();
      for (const runtime of runtimes.values()) runtime.suspend();
    }
    if (!next.tabs.length) next.newTab();
    layout(); publish();
  };
  const updateDarkPages = () => {
    const active = darkPagesActive(settings.darkPages, nativeTheme.shouldUseDarkColors);
    if (active !== darkActive) {
      setDarkPagesSwitch(app.commandLine, active); darkActive = active;
      for (const runtime of runtimes.values()) runtime.replaceViews();
    } else for (const runtime of runtimes.values()) for (const tab of runtime.tabs) runtime.applyDarkCSS(tab);
    layout(); publish();
  };
  const systemDarkPages = () => { if (settings.darkPages === 'system') updateDarkPages(); };
  nativeTheme.on('updated', systemDarkPages);
  const run = (command: BrowserCommand) => {
    switch (command.type) {
      case 'pin-app': case 'unpin-app': settings.setAppPinned(command.id, command.type === 'pin-app'); publish(); return;
      case 'register-default-browser': return defaultBrowser.register().then(publish);
      case 'set-search-engine': settings.setSearchEngine(command.value); publish(); return;
      case 'set-language': settings.setLanguage(command.value); publish(); return;
      case 'set-ask-where-to-save': settings.setAskWhereToSave(command.value); publish(); return;
      case 'set-show-capture': settings.setShowCapture(command.value); publish(); return;
      case 'reset-downloads-folder': settings.setDownloadsFolder(null); publish(); return;
      case 'choose-downloads-folder': return (async () => {
        let choice: Electron.OpenDialogReturnValue;
        try { choice = await dialog.showOpenDialog(window, { properties: ['openDirectory'], defaultPath: resolvedDownloadsFolder(settings, downloads).downloadsFolder }); }
        catch { throw new Error('DOWNLOADS_FOLDER_PICK_FAILED'); }
        if (!choice.canceled) { settings.setDownloadsFolder(choice.filePaths[0] ?? ''); publish(); }
      })();
      case 'set-block-ads':
        settings.setBlockAds(command.value);
        for (const runtime of runtimes.values()) { runtime.resetCounts(); if (!command.value) runtime.replaceViews(); else for (const tab of runtime.tabs) runtime.page(tab.view)?.reloadIgnoringCache(); }
        layout(); publish(); return;
      case 'set-block-third-party-cookies': settings.setBlockThirdPartyCookies(command.value); for (const runtime of runtimes.values()) runtime.resetCookies(); publish(); return;
      case 'clear-browsing-data': {
        if (clearingBrowsingData) throw new Error('CLEAR_IN_PROGRESS');
        const target = current(); clearingBrowsingData = true; publish();
        return target.clearData(command).finally(() => { clearingBrowsingData = false; publish(); });
      }
      case 'dark-pages': settings.setDarkPages(command.value); updateDarkPages(); return;
      case 'dark-strength': settings.setDarkStrength(command.value); updateDarkPages(); return;
      case 'dark-tone': settings.setDarkTone(command.value); updateDarkPages(); return;
      case 'switch-profile': switchProfile(command.id); return;
      case 'create-profile': case 'update-profile': {
        const name = profileName(command.name);
        if (registry.profiles.some(profile => profile.name.toLowerCase() === name.toLowerCase() && (command.type === 'create-profile' || profile.id !== command.id))) throw new Error('PROFILE_NAME_DUPLICATE');
        if (command.type === 'create-profile') {
          if (registry.profiles.length >= PROFILE_LIMIT) throw new Error('PROFILE_LIMIT');
          const profile = makeProfile(name, command.color);
          saveRegistry({ ...registry, profiles: [...registry.profiles, profile] });
          switchProfile(profile.id);
        } else {
          saveRegistry({ ...registry, profiles: registry.profiles.map(profile => profile.id === command.id ? { ...profile, name, color: command.color } : profile) });
          publish();
        }
        return;
      }
      case 'delete-profile': {
        if (registry.profiles.length === 1) throw new Error('PROFILE_LAST');
        const profile = registry.profiles.find(profile => profile.id === command.id)!;
        const profiles = registry.profiles.filter(other => other.id !== profile.id);
        saveRegistry({ ...registry, activeId: registry.activeId === profile.id ? profiles[0]!.id : registry.activeId, profiles, tombstones: [...registry.tombstones, profile.partition] });
        deleting = true;
        return (async () => {
          try {
            const next = runtimeFor(registry.profiles.find(other => other.id === registry.activeId)!);
            if (!next.tabs.length) next.newTab();
            const attempt = async (cleanup: () => unknown) => { try { await cleanup(); } catch (error: unknown) { storageFailure(error); } };
            const runtime = runtimes.get(profile.id);
            await attempt(() => runtime?.dispose(true));
            // Stop service workers and sockets before clearing caches so background traffic cannot refill them.
            await attempt(async () => {
              const target = runtime?.webSession ?? session.fromPartition(profile.partition);
              for (const cleanup of [() => target.clearStorageData(), () => target.closeAllConnections(), () => target.clearCache(), () => target.clearAuthCache(), () => target.clearCodeCaches({})]) await attempt(cleanup);
            });
            await attempt(() => removeProfileDirectory(resolve(userData, 'profiles'), profile.id));
          } finally {
            runtimes.delete(profile.id);
            invalidateMenu();
            const next = runtimeFor(registry.profiles.find(other => other.id === registry.activeId)!);
            if (!next.tabs.length) next.newTab();
            deleting = false; layout(); publish();
          }
        })();
      }
      default: return current().run(command);
    }
  };
  function createRuntime(profile: Profile) {
    const storePath = profileStorePath(userData, profile.id);
    const readStatus = { readError: false, memoryOnly: false };
    const store = readStore(storePath, safeStorage, readStatus);
    const desktop = createDesktop(resolve(dirname(storePath), 'notebooks.json'), safeStorage, publish);
    const desktopPanel: DesktopPanelState = { open: false, page: { kind: 'home' } };
    const tabs: Tab[] = [];
    let activeId = '';
    let storageError = false;
    let favoritesVersion = 0;
    let pendingWrite: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let clearingData = false;
    let captureGeneration = 0;
    const captureRequests = new Set<AbortController>();
    let screenCapture: { id: string; bytes: Buffer; width: number; height: number; generation: number } | undefined;
    const invalidateCaptures = () => { captureGeneration++; for (const request of captureRequests) request.abort(); captureRequests.clear(); };
    const isCurrent = () => registry.activeId === profile.id;
    let kept: { kind: 'history'; entries: BrowserStore['history'] } | { kind: 'bookmarks'; entries: BrowserStore['favorites'] } | { kind: 'downloads'; entries: BrowserStore['downloads'] } | undefined;
    let restoreTimeout: ReturnType<typeof setTimeout> | undefined;
    const forget = () => { clearTimeout(restoreTimeout); restoreTimeout = undefined; kept = undefined; };
    const keep = (kind: 'history' | 'bookmarks' | 'downloads') => {
      forget();
      desktop.forget();
      if (kind === 'history') kept = { kind, entries: structuredClone(store.history) };
      else if (kind === 'bookmarks') kept = { kind, entries: structuredClone(store.favorites) };
      else kept = { kind, entries: structuredClone(store.downloads) };
      restoreTimeout = setTimeout(forget, 8000);
    };
    const items = new Map<string, DownloadItem>();
    const trustedDownloads = new Map(store.downloads.filter(entry => basename(entry.path) === entry.filename && !/[\x00-\x1f\x7f-\x9f]/.test(entry.path)).map(entry => [entry.id, entry.path]));
    const reserved = new Set<string>();
    const webPreferences: WebPreferences = {
      partition: profile.partition, sandbox: true, contextIsolation: true, nodeIntegration: false,
      nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true,
      allowRunningInsecureContent: false, experimentalFeatures: false, webviewTag: false,
      devTools: false, navigateOnDragDrop: false,
    };
    const webSession = session.fromPartition(profile.partition);
    profileSessions.add(webSession);
    const permissions = new PermissionQueue(store.siteSettings, publish, () => persist());
    const tabFor = (contents: WebContents | null | undefined) => contents && tabs.find(tab => tab.view?.webContents === contents);
    // Frame requests inherit the top-level origin; a frame cannot choose the origin shown by chrome.
    webSession.setPermissionRequestHandler((contents, permission, callback, details) => {
      if (permission === 'fullscreen') { callback(true); return; }
      const tab = tabFor(contents), origin = tab && siteSettings(store.siteSettings, contents.mainFrame.origin ?? contents.mainFrame.url)?.origin;
      if (!tab || !origin || tab.navigating || disposed || closing) { callback(false); return; }
      permissions.request(tab.state.id, origin, requestedPermissions(permission, details), callback);
    });
    webSession.setPermissionCheckHandler((contents, permission, requestingOrigin, details) => {
      if (permission === 'fullscreen') return true;
      const tab = tabFor(contents);
      const url = tab ? contents!.mainFrame.origin ?? contents!.mainFrame.url : !contents ? details?.embeddingOrigin ?? requestingOrigin : '';
      const site = siteSettings(store.siteSettings, url ?? '');
      const requested = requestedPermissions(permission, details);
      return !!site && secureOrigin(site.origin) && requested.length > 0 && requested.every(permission => site.permissions[permission] === 'allow');
    });
    webSession.setDevicePermissionHandler(() => false);
    const requests = new Map<number, { tab: Tab; pageLoad: number; topURL: string }>();
    const requestContext = (details: { id: number; webContentsId?: number; url: string; resourceType: string }) => {
      const existing = requests.get(details.id);
      if (existing) {
        // A redirected document is first party at every hop, including its cookie headers.
        if (details.resourceType === 'mainFrame') {
          existing.topURL = details.url;
          if (existing.pageLoad === existing.tab.pageLoad) existing.tab.topURL = details.url;
        }
        return existing;
      }
      const tab = details.webContentsId === undefined ? undefined : tabs.find(tab => tab.view?.webContents.id === details.webContentsId);
      if (!tab) return undefined;
      const context = { tab, pageLoad: tab.pageLoad, topURL: details.resourceType === 'mainFrame' ? details.url : tab.topURL ?? tab.state.url };
      requests.set(details.id, context); return context;
    };
    webSession.webRequest.onBeforeRequest((details, callback) => {
      const scheme = new URL(details.url).protocol;
      const tab = details.webContentsId === undefined ? undefined : tabs.find(tab => tab.view?.webContents.id === details.webContentsId);
      const cancel = details.resourceType === 'mainFrame' ? !(isAllowedURL(details.url) || !!tab?.view && isLaunchNavigation(tab.view.webContents, details.url))
        : details.resourceType === 'subFrame' ? !isAllowedSubframeURL(details.url)
        : !['http:', 'https:', 'data:', 'blob:', 'ws:', 'wss:'].includes(scheme);
      if (cancel || disposed || closing || clearingData) { callback({ cancel: true }); return; }
      const context = requestContext(details);
      const enabled = settings.blockAds && context && siteSettings(store.siteSettings, context.topURL)?.blocking;
      const match = enabled ? blocker.match(details.url, details.resourceType, context.topURL) : undefined;
      if (!match) { callback({ cancel: false }); return; }
      if (context!.pageLoad === context!.tab.pageLoad) { context!.tab.state.blocked[match.kind]++; publish(); }
      if (match.redirectURL) callback({ redirectURL: match.redirectURL });
      else callback({ cancel: true });
    });
    webSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const context = requestContext(details);
      const headers = context ? stripCookieHeaders(details.requestHeaders, false, details.url, context.topURL,
        settings.blockThirdPartyCookies && (siteSettings(store.siteSettings, context.topURL)?.blocking ?? true), context.pageLoad === context.tab.pageLoad ? context.tab.refusedCookies : new Set()) : details.requestHeaders;
      if (context && context.pageLoad === context.tab.pageLoad && context.tab.state.blocked.cookies !== context.tab.refusedCookies.size) { context.tab.state.blocked.cookies = context.tab.refusedCookies.size; publish(); }
      callback({ requestHeaders: headers });
    });
    webSession.webRequest.onHeadersReceived((details, callback) => {
      const context = requestContext(details);
      const headers = context ? stripCookieHeaders(details.responseHeaders ?? {}, true, details.url, context.topURL,
        settings.blockThirdPartyCookies && (siteSettings(store.siteSettings, context.topURL)?.blocking ?? true), context.pageLoad === context.tab.pageLoad ? context.tab.refusedCookies : new Set()) : details.responseHeaders;
      if (context && context.pageLoad === context.tab.pageLoad && context.tab.state.blocked.cookies !== context.tab.refusedCookies.size) { context.tab.state.blocked.cookies = context.tab.refusedCookies.size; publish(); }
      callback({ responseHeaders: headers });
    });
    webSession.webRequest.onCompleted(details => { requests.delete(details.id); });
    webSession.webRequest.onErrorOccurred(details => { requests.delete(details.id); });

    const state = () => ({ ...desktop.state(), desktopPanel: structuredClone(desktopPanel), tabs: tabs.map(tab => ({ ...tab.state, blocked: { ...tab.state.blocked } })), activeId, store, favoritesVersion, storageError, storageReadError: readStatus.readError,
      clearHistoryOnClose: store.clearHistoryOnClose, clearCacheOnClose: store.clearCacheOnClose, sites: listSites(store.siteSettings),
      blockingReady: blocker.ready, siteSettings: active()?.state.settings || active()?.state.desktop ? null : siteSettings(store.siteSettings, active()?.topURL ?? active()?.state.url ?? ''), permissionPrompt: permissions.prompt(activeId) });
    const flush = () => {
      if (pendingWrite === undefined) return;
      clearTimeout(pendingWrite); pendingWrite = undefined;
      try { writeStore(storePath, store, safeStorage); storageError = false; }
      catch { storageError = true; }
      publish();
    };
    const persist = () => {
      if (!disposed && !readStatus.memoryOnly && pendingWrite === undefined) pendingWrite = setTimeout(flush, 500);
    };
    const saveNow = () => {
      clearTimeout(pendingWrite); pendingWrite = undefined;
      if (readStatus.memoryOnly) { storageError = true; throw new Error('PROFILE_SETTINGS_SAVE_FAILED'); }
      try { writeStore(storePath, store, safeStorage); storageError = false; }
      catch { storageError = true; throw new Error('PROFILE_SETTINGS_SAVE_FAILED'); }
    };
    const stopForClear = () => { for (const tab of tabs) page(tab.view)?.stop(); for (const item of items.values()) item.cancel(); requests.clear(); };
    const clearData = async (choice: ClearedBrowsingData): Promise<ClearedBrowsingData> => {
      clearingData = true;
      try {
      for (const tab of tabs) page(tab.view)?.stop(); requests.clear();
      if (choice.history) {
        forget(); const previous = store.history; store.history = [];
        try { saveNow(); } catch { store.history = previous; throw new Error('CLEAR_HISTORY_FAILED'); }
      }
      if (choice.cookies) try { await webSession.clearStorageData({ storages: ['cookies', 'localstorage', 'indexdb', 'serviceworkers', 'cachestorage'] }); } catch { throw new Error('CLEAR_SITE_DATA_FAILED'); }
      if (choice.cache) try { await webSession.clearCache(); } catch { throw new Error('CLEAR_CACHE_FAILED'); }
      publish(); return { history: choice.history, cookies: choice.cookies, cache: choice.cache };
      } finally { clearingData = false; }
    };
    let closeClear: Promise<void> | undefined;
    const clearOnClose = () => {
      if (closeClear) return closeClear;
      stopForClear(); forget();
      if (store.clearHistoryOnClose) { const previous = store.history; store.history = []; try { saveNow(); } catch { store.history = previous; storageError = true; } }
      closeClear = store.clearCacheOnClose ? Promise.resolve().then(() => webSession.clearCache()).catch(() => { storageError = true; }) : Promise.resolve();
      return closeClear;
    };
    const resetCookies = () => { for (const tab of tabs) { tab.refusedCookies.clear(); tab.state.blocked.cookies = 0; } };
    const resetCounts = () => { resetCookies(); for (const tab of tabs) tab.state.blocked = { ads: 0, trackers: 0, cookies: 0 }; };
    const active = () => tabs.find(tab => tab.state.id === activeId);
    // A WebContentsView drops its webContents once the page is destroyed, so every access goes through here.
    const page = (view?: WebContentsView) => {
      const contents = view?.webContents as WebContents | undefined;
      return contents && !contents.isDestroyed() ? contents : undefined;
    };
    const refresh = (tab: Tab) => {
      const contents = page(tab.view);
      if (contents) {
        tab.state.canGoBack = contents.navigationHistory.canGoBack();
        tab.state.canGoForward = contents.navigationHistory.canGoForward();
      }
    };
    const layout = () => {
      if (window.isDestroyed()) return;
      const { width, height } = window.getContentBounds();
      const top = Math.min(height, Math.ceil(area.top * window.webContents.getZoomFactor()));
      for (const tab of tabs) {
        if (!tab.view || !page(tab.view)) continue;
        const fullscreen = isCurrent() && tab.state.id === activeId && tab.state.fullscreen;
        const y = fullscreen ? 0 : top;
        const panelWidth = !fullscreen && desktopPanel.open ? Math.ceil(400 * window.webContents.getZoomFactor()) : 0;
        tab.view.setBounds({ x: 0, y, width: Math.max(0, width - panelWidth), height: Math.max(0, height - y) });
        tab.view.setVisible(isCurrent() && tab.state.id === activeId && !area.hidden && !tab.state.error && !tab.cosmeticPending && y < height);
      }
    };
    const update = () => { layout(); publish(); };
    const applyDarkCSS = (tab: Tab) => {
      const contents = page(tab.view), generation = tab.pageLoad;
      if (!contents) return;
      // Serialize replacement so a late insertion cannot leave a second stylesheet behind.
      tab.darkCSSWork = (tab.darkCSSWork ?? Promise.resolve()).then(async () => {
        const current = () => !disposed && !closing && tabs.includes(tab) && page(tab.view) === contents && tab.pageLoad === generation;
        if (!current()) return;
        if (tab.darkCSS?.contents === contents) {
          const key = tab.darkCSS.key; tab.darkCSS = undefined;
          await contents.removeInsertedCSS(key).catch(() => undefined);
        }
        if (!current()) return;
        const site = siteSettings(store.siteSettings, tab.committedURL ?? tab.state.url);
        const css = site ? darkPagesCSS(darkActive, site.dark, settings.darkStrength, settings.darkTone) : '';
        if (!css) return;
        // Electron cannot remove user-origin stylesheets.
        const key = await contents.insertCSS(css);
        if (current()) tab.darkCSS = { contents, key };
        else if (!contents.isDestroyed()) await contents.removeInsertedCSS(key).catch(() => undefined);
      }).catch(() => undefined);
    };
    const leaveFullscreen = (tab: Tab) => {
      if (!tab.state.fullscreen) return;
      tab.state.fullscreen = false;
      if (!window.isDestroyed()) window.setFullScreen(false);
    };
    const activate = (tab: Tab) => {
      const previous = active();
      if (previous !== tab) invalidateCaptures();
      if (isCurrent() && previous !== tab) invalidateMenu();
      if (previous && previous !== tab) leaveFullscreen(previous);
      activeId = tab.state.id;
    };
    const zoom = (tab: Tab, delta: -1 | 0 | 1) => {
      const contents = page(tab.view);
      if (!contents) return;
      tab.state.zoom = delta === 0 ? 1 : Math.max(0.25, Math.min(3, Math.round((tab.state.zoom + delta * 0.1) * 100) / 100));
      contents.setZoomFactor(tab.state.zoom);
      publish();
    };
    const clearFavicon = (tab: Tab, url?: string) => {
      let site = '';
      try { if (url && isWebURL(url)) site = new URL(url).origin; } catch { /* A blank tab has no site icon. */ }
      tab.faviconRequest?.abort(); tab.faviconRequest = undefined;
      if (tab.faviconSite !== site || !url) { tab.state.favicon = null; tab.faviconBytes = undefined; tab.faviconSite = site; }
    };
    const record = (tab: Tab, url: string) => {
      if (active() === tab) invalidateCaptures();
      invalidateMenu(tab.state.id);
      if (tab.faviconSite !== (isWebURL(url) ? new URL(url).origin : '')) clearFavicon(tab, url);
      tab.state.url = url;
      tab.committedURL = url;
      tab.state.title = page(tab.view)?.getTitle().slice(0, 1024) || url;
      tab.state.find = { active: 0, total: 0 };
      tab.findRequest = undefined;
      if (isWebURL(url) && !clearingData && !closing && !disposed) {
        const existing = store.history.find(entry => entry.url === url);
        if (existing) { existing.lastVisit = Date.now(); existing.visitCount++; existing.title = tab.state.title; }
        else store.history.push({ url, title: tab.state.title, lastVisit: Date.now(), visitCount: 1 });
        store.history.sort((a, b) => b.lastVisit - a.lastVisit);
        store.history.splice(10000);
        persist();
      }
      refresh(tab); update();
    };
    const fail = (tab: Tab, description: string) => {
      if (active() === tab) invalidateCaptures();
      permissions.drop(tab.state.id); tab.cosmeticPending = false; tab.navigating = false;
      invalidateMenu(tab.state.id);
      tab.state.loading = false;
      tab.state.error = description === 'RENDERER_GONE' ? description : parseErrorName(description);
      leaveFullscreen(tab);
      refresh(tab); update();
    };
    const load = (tab: Tab, url: string, launch = false) => {
      if (!isAllowedURL(url) && !(launch && isLocalHTMLURL(url))) throw new Error('Invalid navigation URL');
      tab.state.desktop = null; tab.state.desktopItem = null; tab.state.settings = null;
      if (active() === tab) invalidateCaptures();
      invalidateMenu(tab.state.id);
      permissions.drop(tab.state.id);
      tab.navigating = true;
      clearFavicon(tab, url);
      ensureView(tab);
      if (launch && isLocalHTMLURL(url)) launchURLs.set(tab.view!.webContents, url);
      tab.state.url = url;
      tab.state.title = url;
      tab.state.error = null;
      tab.state.loading = true;
      const navigation = (tab.navigation ?? 0) + 1;
      tab.navigation = navigation;
      update();
      void tab.view!.webContents.loadURL(url).catch((error: unknown) => {
        // Aborted requests are expected when Stop or a newer navigation wins.
        if (error instanceof Error && error.message.includes('ERR_ABORTED')) return;
        if (!disposed && tabs.includes(tab) && tab.navigation === navigation) fail(tab, error instanceof Error ? error.message : 'ERR_FAILED');
      });
    };
    const newTab = (url?: string, foreground = true, contents?: WebContents, launch = false) => {
      if (disposed || closing) throw new Error('Profile is closed');
      if (tabs.length >= 200) throw new Error('Tab limit reached');
      const tab: Tab = { pageLoad: 0, refusedCookies: new Set(), state: { id: randomUUID(), settings: null, desktop: null, desktopItem: null, url: url ?? '', title: url ?? '', favicon: null, loading: false, fullscreen: false, canGoBack: false, canGoForward: false, zoom: 1, error: null, find: { active: 0, total: 0 }, blocked: { ads: 0, trackers: 0, cookies: 0 } } };
      clearFavicon(tab, url);
      tabs.push(tab);
      if (foreground || !activeId) activate(tab);
      if (contents) { ensureView(tab, contents); tab.state.loading = contents.isLoading(); }
      else if (url) load(tab, url, launch);
      update();
      return tab;
    };
    const openSettings = (section: SettingsSection) => {
      let target = tabs.find(tab => tab.state.settings !== null);
      if (!target) {
        if (tabs.length >= 200) throw new Error('SETTINGS_TAB_LIMIT');
        const index = tabs.findIndex(tab => tab.state.id === activeId);
        target = newTab(); tabs.splice(tabs.indexOf(target), 1); tabs.splice(index + 1, 0, target);
      }
      target.state.settings = section; target.state.url = settingsAddress(section); target.state.title = 'Settings';
      activate(target); update(); return target;
    };
    const closeTab = (tab: Tab) => {
      const index = tabs.indexOf(tab);
      if (index < 0 || closing || disposed) return;
      invalidateMenu(tab.state.id);
      permissions.drop(tab.state.id);
      leaveFullscreen(tab); clearFavicon(tab);
      tabs.splice(index, 1);
      if (activeId === tab.state.id) invalidateCaptures();
      if (activeId === tab.state.id) activeId = tabs[Math.min(index, tabs.length - 1)]?.state.id ?? '';
      if (tab.view) {
        // A page that closed itself may already have torn its view down.
        try { if (!window.isDestroyed()) window.contentView.removeChildView(tab.view); } catch { /* Nothing left to detach. */ }
        page(tab.view)?.close();
      }
      if (!tabs.length && isCurrent()) newTab();
      update();
    };
    const replaceViews = () => {
      invalidateCaptures();
      for (const tab of tabs) {
        const view = tab.view;
        if (!view) continue;
        leaveFullscreen(tab); invalidateMenu(tab.state.id); permissions.drop(tab.state.id);
        const contents = page(view);
        const entries = contents?.navigationHistory.getAllEntries() ?? [], index = contents?.navigationHistory.getActiveIndex() ?? -1;
        const url = tab.committedURL ?? entries[index]?.url ?? tab.state.url;
        const originalLaunch = contents && launchURLs.get(contents);
        const trustedLaunch = originalLaunch === url && isLocalHTMLURL(url);
        contents?.stopFindInPage('clearSelection');
        tab.findRequest = undefined; tab.state.find = { active: 0, total: 0 }; clearFavicon(tab);
        view.setVisible(false);
        try { window.contentView.removeChildView(view); } catch { /* A crashed view may already be detached. */ }
        tab.view = undefined; tab.darkCSS = undefined; tab.darkCSSWork = undefined;
        tab.pageLoad++; tab.navigation = (tab.navigation ?? 0) + 1; tab.cosmeticPending = false; tab.navigating = false;
        contents?.close();
        ensureView(tab);
        tab.state.error = null;
        const next = page(tab.view)!;
        if (originalLaunch && isLocalHTMLURL(originalLaunch)) launchURLs.set(next, originalLaunch);
        if (entries.length && index >= 0 && index < entries.length) {
          tab.state.url = entries[index]!.url; tab.state.loading = true; tab.navigating = true;
          const navigation = tab.navigation;
          void next.navigationHistory.restore({ entries, index }).catch((error: unknown) => {
            if (error instanceof Error && error.message.includes('ERR_ABORTED')) return;
            if (!disposed && tabs.includes(tab) && page(tab.view) === next && tab.navigation === navigation) fail(tab, error instanceof Error ? error.message : 'ERR_FAILED');
          });
        } else if (isAllowedURL(url) || trustedLaunch) load(tab, url, trustedLaunch);
        refresh(tab);
      }
    };
    function ensureView(tab: Tab, guest?: WebContents) {
      if (guest && guest.session !== webSession) throw new Error('Popup session mismatch');
      if (page(tab.view)) return;
      if (tab.view) try { window.contentView.removeChildView(tab.view); } catch { /* Nothing left to detach. */ }
      // Electron rejects an explicit undefined webContents, so the key is present only for adopted popups.
      const view = new WebContentsView(guest ? { webContents: guest, webPreferences } : { webPreferences });
      tab.view = view;
      view.setVisible(false);
      window.contentView.addChildView(view);
      const contents = view.webContents;
      const navigations: { generation: number; urls: Set<string> }[] = [];
      let pendingNavigation: number | undefined;
      const finishUncommitted = (generation: number | undefined) => {
        if (tab.view !== view || generation === undefined || pendingNavigation !== generation || tab.pageLoad !== generation) return;
        pendingNavigation = undefined;
        tab.cosmeticPending = false; tab.navigating = false;
        tab.topURL = tab.committedURL ?? contents.mainFrame.url;
        update();
      };
      contents.setZoomMode('manual');
      contents.setZoomFactor(tab.state.zoom);
      contents.on('context-menu', (_event, params) => {
        if (tab.view !== view || !isCurrent() || tab.state.id !== activeId || tab.state.error) return;
        invalidateMenu();
        const menu = pageMenu.open(tab.state.id, params, {
          back: contents.navigationHistory.canGoBack(), forward: contents.navigationHistory.canGoForward(), reload: Boolean(tab.state.url),
        }, view.getBounds(), window.webContents.getZoomFactor());
        if (!menu) return;
        window.webContents.focus();
        window.webContents.send(IPC.contextMenu, menu);
      });
      contents.setWindowOpenHandler(details => {
        if (tab.view !== view || disposed || closing || !isAllowedURL(details.url) || tabs.length >= 200) return { action: 'deny' };
        return {
          action: 'allow', outlivesOpener: true, overrideBrowserWindowOptions: { webPreferences },
          createWindow: options => {
            // Electron defers guest creation for background tabs and omits it from the public options type.
            const guest = (options as typeof options & { webContents?: WebContents }).webContents;
            const popup = newTab(details.url, isCurrent() && details.disposition !== 'background-tab', guest);
            return popup.view!.webContents;
          },
        };
      });
      contents.on('destroyed', () => { if (tab.view === view) closeTab(tab); });
      contents.on('did-start-loading', () => { if (tab.view === view) { tab.state.loading = true; publish(); } });
      // A reload behind an open overlay hands the keyboard to the hidden page; once Chromium has finished moving it, it goes back to chrome.
      contents.on('focus', () => setImmediate(() => {
        if (tab.view === view && !disposed && !closing && !window.isDestroyed() && area.hidden && isCurrent() && tab.state.id === activeId && window.isFocused()) window.webContents.focus();
      }));
      contents.on('did-stop-loading', () => {
        if (tab.view !== view || contents.isLoading()) return;
        finishUncommitted(pendingNavigation); navigations.length = 0;
        tab.state.loading = false; tab.navigating = false; refresh(tab); update();
      });
      contents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
        if (tab.view !== view) return;
        invalidateMenu(tab.state.id);
        if (isMainFrame) permissions.drop(tab.state.id);
        if (isMainFrame && active() === tab) invalidateCaptures();
        if (isMainFrame && !isInPlace) {
          tab.navigating = true;
          tab.pageLoad++; tab.topURL = url; tab.refusedCookies = new Set(); tab.state.blocked = { ads: 0, trackers: 0, cookies: 0 };
          pendingNavigation = tab.pageLoad;
          navigations.push({ generation: tab.pageLoad, urls: new Set([url]) });
          tab.cosmeticPending = settings.blockAds && blocker.ready && !!siteSettings(store.siteSettings, url)?.blocking;
          clearFavicon(tab, url); tab.state.error = null; tab.state.find = { active: 0, total: 0 }; tab.findRequest = undefined; update();
        }
      });
      contents.on('did-redirect-navigation', (_event, url, _isInPlace, isMainFrame) => {
        if (tab.view === view && isMainFrame) navigations.find(navigation => navigation.generation === pendingNavigation)?.urls.add(url);
      });
      contents.on('will-redirect', (event) => {
        if (tab.view !== view) return;
        if (event.isMainFrame && !isAllowedURL(event.url) && !isLaunchNavigation(contents, event.url)) fail(tab, 'ERR_UNSAFE_REDIRECT');
      });
      contents.on('did-navigate', (_event, url) => {
        if (tab.view !== view) return;
        pendingNavigation = undefined;
        permissions.drop(tab.state.id); tab.navigating = false;
        tab.topURL = url;
        const generation = tab.pageLoad;
        const css = settings.blockAds && siteSettings(store.siteSettings, url)?.blocking ? blocker.cosmeticCSS(url) : '';
        // Keep the view hidden until styles are installed, so the new document cannot flash unhidden ads.
        if (css) {
          tab.cosmeticPending = true;
          void contents.insertCSS(css, { cssOrigin: 'user' }).catch(() => undefined).finally(() => {
            if (disposed || closing || !tabs.includes(tab) || tab.view !== view || tab.pageLoad !== generation) return;
            tab.cosmeticPending = false; update();
          });
        } else tab.cosmeticPending = false;
        tab.committed = true;
        record(tab, url);
        applyDarkCSS(tab);
      });
      contents.on('did-navigate-in-page', (_event, url, mainFrame) => { if (tab.view === view && mainFrame) record(tab, url); });
      contents.on('page-favicon-updated', (_event, candidates) => {
        if (tab.view !== view) return;
        tab.faviconRequest?.abort();
        const request = new AbortController(); tab.faviconRequest = request;
        void fetchFavicon(contents.session, candidates, request.signal, tab.state.url).then(bytes => {
          if (closing || disposed || request.signal.aborted || !tabs.includes(tab) || tab.view !== view || !page(tab.view)) return;
          tab.faviconBytes = bytes ?? undefined;
          tab.state.favicon = bytes ? createHash('sha256').update(bytes).digest('hex').slice(0, 32) : null;
          publish();
        });
      });
      contents.on('page-title-updated', (_event, title) => {
        if (tab.view !== view) return;
        tab.state.title = title.slice(0, 1024);
        const entry = store.history.find(entry => entry.url === tab.state.url);
        if (entry && !clearingData && !closing && !disposed) { entry.title = tab.state.title; persist(); }
        publish();
      });
      contents.on('did-fail-load', (_event, code, description, url, mainFrame) => {
        if (tab.view !== view || !mainFrame) return;
        // Failure events have no navigation ID; retain start order even when two loads use the same URL.
        const index = navigations.findIndex(navigation => navigation.urls.has(url));
        const navigation = index < 0 ? undefined : navigations.splice(index, 1)[0];
        if (code === -3) { finishUncommitted(navigation?.generation); return; }
        if (isAllowedURL(url)) tab.state.url = url;
        fail(tab, description);
      });
      contents.on('render-process-gone', () => { if (tab.view === view) fail(tab, 'RENDERER_GONE'); });
      contents.on('enter-html-full-screen', () => {
        if (tab.view !== view || !isCurrent() || tab.state.id !== activeId) return;
        tab.state.fullscreen = true; window.setFullScreen(true); update();
      });
      contents.on('leave-html-full-screen', () => { if (tab.view === view) { leaveFullscreen(tab); update(); } });
      contents.on('found-in-page', (_event, result) => {
        if (tab.view !== view || tab.findRequest !== result.requestId) return;
        tab.state.find = { active: result.activeMatchOrdinal, total: result.matches }; publish();
      });
      contents.on('before-input-event', (event, input) => {
        if (tab.view !== view || !isCurrent() || tab.state.id !== activeId) return;
        if (input.type !== 'keyDown' || input.isComposing) return;
        const shortcut = browserShortcut(input);
        if (!shortcut) return;
        if (shortcut === 'fullscreen' || shortcut === 'stop' && tab.state.fullscreen) {
          event.preventDefault(); run({ type: shortcut === 'fullscreen' ? 'fullscreen' : 'stop' }); return;
        }
        if (shortcut === 'stop' && !contents.isLoading()) return;
        event.preventDefault();
        if (!isCurrent() || tab.state.id !== activeId) return;
        if (['capture', 'focus-address', 'find', 'favorites', 'history', 'downloads', 'new-tab', 'close-tab', 'next-tab', 'previous-tab'].includes(shortcut) || shortcut.startsWith('tab-')) window.webContents.focus();
        window.webContents.send(IPC.shortcut, shortcut);
      });
      contents.on('zoom-changed', (_event, direction) => { if (tab.view === view && isCurrent() && tab.state.id === activeId) zoom(tab, direction === 'in' ? 1 : -1); });
    }

    const downloadHandler = (event: Electron.Event, item: DownloadItem, contents: WebContents) => {
      const tab = tabs.find(tab => tab.view?.webContents === contents);
      const retry = Boolean(tab?.retryDownload);
      let accepted = false;
      try {
        if (!tab || disposed || closing) { event.preventDefault(); return; }
        const url = isWebURL(item.getURL()) ? item.getURL() : tab.state.url;
        if (!isWebURL(url)) { event.preventDefault(); return; }
        const folder = resolvedDownloadsFolder(settings, downloads).downloadsFolder;
        mkdirSync(folder, { recursive: true });
        const proposed = reserveDownloadPath(folder, item.getFilename(), new Set([...reserved, ...[...runtimes.values()].flatMap(runtime => [...runtime.reserved])]));
        const selected = settings.askWhereToSave ? dialog.showSaveDialogSync(window, { defaultPath: proposed }) : proposed;
        if (!selected) { event.preventDefault(); item.cancel(); return; }
        const path = selected;
        reserved.add(path);
        item.setSavePath(path);
        const retryIndex = tab.retryDownload ? store.downloads.findIndex(entry => entry.id === tab.retryDownload) : -1;
        const entry = { id: retryIndex >= 0 ? tab.retryDownload! : randomUUID(), url, filename: basename(path), path, received: 0, total: item.getTotalBytes(), status: 'progressing' as const, startedAt: Date.now() };
        if (retryIndex >= 0) store.downloads.splice(retryIndex, 1, entry); else store.downloads.unshift(entry);
        tab.retryDownload = undefined;
        trustedDownloads.set(entry.id, entry.path);
        store.downloads.splice(10000);
        items.set(entry.id, item); persist(); publish();
        let lastUpdate = 0;
        let interrupted = false;
        item.on('updated', (_event, status) => {
          if (disposed) return;
          entry.received = item.getReceivedBytes(); entry.total = item.getTotalBytes();
          const stored = store.downloads.find(download => download.id === entry.id);
          if (stored && status === 'interrupted') { interrupted = true; stored.status = 'failed'; item.cancel(); }
          if (Date.now() - lastUpdate > 250) { lastUpdate = Date.now(); persist(); publish(); }
        });
        item.once('done', (_event, status) => {
          if (disposed) return;
          const stored = store.downloads.find(download => download.id === entry.id);
          if (stored) { stored.status = interrupted ? 'failed' : status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed'; stored.received = item.getReceivedBytes(); }
          items.delete(entry.id); reserved.delete(path); persist(); publish();
        });
        accepted = true;
        if (!tab.committed && tabs.length > 1) setImmediate(() => { if (!tab.committed && tabs.length > 1) closeTab(tab); });
      } catch { event.preventDefault(); storageError = true; publish(); }
      finally {
        // A retry that never starts must release its lock before another attempt.
        if (tab && retry && !accepted) { tab.retryDownload = undefined; closeTab(tab); }
      }
    };
    webSession.on('will-download', downloadHandler);

    const desktopDestination = (input: string) => {
      const address = input.trim();
      if (!address.toLowerCase().startsWith('horizon://desktop/')) return null;
      if (address === 'horizon://desktop/captures') return 'captures';
      const project = desktop.list().find(project => desktopAddress(project.name) === address);
      if (!project) throw new Error('DESKTOP_NOT_FOUND');
      return project.id;
    };
    const openDesktop = (id: string, item?: string) => {
      const name = id === 'captures' ? 'Captures' : desktop.get(id).name;
      if (item) desktop.item(id === 'captures' ? null : id, item);
      const tab = active();
      const target = tabs.find(tab => tab.state.desktop === id) ?? (tab && !tab.view && !tab.state.url && !tab.state.desktop && !tab.state.settings ? tab : newTab());
      target.state.desktop = id; target.state.desktopItem = item ?? null;
      target.state.url = id === 'captures' ? 'horizon://desktop/captures' : desktopAddress(name); target.state.title = name;
      activate(target); if (id !== 'captures') desktop.use(id); update();
    };
    const reconcileDesktop = () => {
      for (const target of tabs) if (target.state.desktopItem && target.state.desktop) {
        try { desktop.item(target.state.desktop === 'captures' ? null : target.state.desktop, target.state.desktopItem); }
        catch { target.state.desktopItem = null; }
      }
      const page = desktopPanel.page;
      if (page.kind === 'project') {
        try { desktop.get(page.project); if (page.folder) desktop.folder(page.project, page.folder); }
        catch { desktopPanel.page = desktop.list().some(project => project.id === page.project) ? { kind: 'project', project: page.project } : { kind: 'home' }; }
      } else if (page.kind === 'item') {
        try { desktop.item(page.project, page.id); }
        catch { desktopPanel.page = page.project === null ? { kind: 'captures' } : desktop.list().some(project => project.id === page.project) ? { kind: 'project', project: page.project } : { kind: 'home' }; }
      }
    };
    const takeCapture = async (id?: string) => {
      desktop.assertUnlocked();
      const tab = active(), view = tab?.view, contents = page(view);
      if (tab?.state.loading || tab?.navigating) throw new Error('CAPTURE_LOADING');
      if (tab?.state.error) throw new Error('CAPTURE_CRASHED');
      if (!tab || !view || !contents || tab.state.desktop || tab.state.settings || !isWebURL(tab.state.url)) throw new Error('CAPTURE_UNAVAILABLE');
      const request = new AbortController(); captureRequests.add(request);
      const generation = captureGeneration, navigation = tab.navigation, pageLoad = tab.pageLoad, url = tab.state.url;
      const check = () => {
        if (disposed || closing || !isCurrent() || active() !== tab || captureGeneration !== generation || tab.view !== view
          || page(view) !== contents || tab.navigation !== navigation || tab.pageLoad !== pageLoad || tab.state.url !== url || tab.state.error) throw new Error('CAPTURE_CHANGED');
      };
      const now = Date.now(), title = tab.state.title;
      const entry: DesktopItem = { id: id ?? randomUUID(), folder: null, kind: id ? 'page' : 'area', title: title.slice(0, 200), text: '', note: '',
        source: { url, title: title.slice(0, 4096) }, image: null, createdAt: now, updatedAt: now };
      try {
        let bytes: Buffer, image: { width: number; height: number; cut: boolean };
        if (!id) {
          const shot = await deadline(contents.capturePage(), request.signal); check();
          bytes = shot.toPNG({ scaleFactor: screen.getDisplayMatching(window.getContentBounds()).scaleFactor });
          image = { ...pngSize(bytes), cut: false };
          desktop.addCapture(null, entry, bytes, image);
          screenCapture = { id: entry.id, bytes, width: image.width, height: image.height, generation };
        } else {
          if (!screenCapture || screenCapture.id !== id || screenCapture.generation !== generation) throw new Error('CAPTURE_CHANGED');
          const visible = () => {
            const bounds = view.getBounds(), windowBounds = window.getContentBounds();
            return view.getVisible() && !area.hidden && !tab.cosmeticPending && bounds.width > 0 && bounds.height > 0
              && bounds.x >= 0 && bounds.y >= 0 && bounds.x + bounds.width <= windowBounds.width && bounds.y + bounds.height <= windowBounds.height;
          };
          const scale = screen.getDisplayMatching(window.getContentBounds()).scaleFactor * contents.getZoomFactor();
          const result = await captureWholePage(contents, visible(), scale, () => { check(); if (!visible()) throw new Error('CAPTURE_PAGE_HIDDEN'); }, request.signal);
          check(); bytes = result.bytes; image = result.image;
          desktop.replaceCapture(id, bytes, image, 'page');
        }
        update();
        return { id: entry.id, bytes, ...image };
      } catch (error: unknown) {
        if (error instanceof Error && /^(PROJECT_|FOLDER_|DESKTOP_|CAPTURE_)/.test(error.message)) throw error;
        try { check(); } catch { throw new Error('CAPTURE_CHANGED'); }
        throw new Error('CAPTURE_FAILED');
      } finally { captureRequests.delete(request); }
    };
    const run = (command: BrowserCommand) => {
      const tab = active();
      if (!tab) return;
      const contents = page(tab.view);
      switch (command.type) {
        case 'open-settings': openSettings(command.section); break;
        case 'set-clear-history-on-close': case 'set-clear-cache-on-close': {
          if (readStatus.memoryOnly) throw new Error('PROFILE_SETTINGS_SAVE_FAILED');
          const field = command.type === 'set-clear-history-on-close' ? 'clearHistoryOnClose' : 'clearCacheOnClose';
          const previous = store[field]; store[field] = command.value;
          try { saveNow(); } catch { store[field] = previous; throw new Error('PROFILE_SETTINGS_SAVE_FAILED'); }
          break;
        }
        case 'reset-site': {
          if (readStatus.memoryOnly) throw new Error('SITE_SETTINGS_SAVE_FAILED');
          const previous = structuredClone(store.siteSettings);
          resetSite(store.siteSettings, command.host);
          try { saveNow(); } catch { store.siteSettings.blocking = previous.blocking; store.siteSettings.dark = previous.dark; store.siteSettings.permissions = previous.permissions; throw new Error('SITE_SETTINGS_SAVE_FAILED'); }
          for (const target of tabs) if (siteHost(target.topURL ?? target.state.url) === command.host) {
            permissions.drop(target.state.id); applyDarkCSS(target);
            target.refusedCookies.clear(); target.state.blocked = { ads: 0, trackers: 0, cookies: 0 };
            if (settings.blockAds) page(target.view)?.reloadIgnoringCache();
          }
          break;
        }
        case 'retry-desktop-storage': desktop.retry(); break;
        case 'open-desktop-panel':
          desktopPanel.open = true; desktopPanel.page = structuredClone(command.page);
          if (command.page.kind === 'project' || command.page.kind === 'item' && command.page.project !== null) desktop.use(command.page.project!);
          window.webContents.focus(); break;
        case 'close-desktop-panel': desktopPanel.open = false; break;
        case 'create-project': desktop.create(command.name); break;
        case 'rename-project':
          desktop.rename(command.id, command.name);
          for (const target of tabs) if (target.state.desktop === command.id) {
            target.state.title = desktop.get(command.id).name; target.state.url = desktopAddress(target.state.title);
          }
          break;
        case 'delete-project':
          forget(); desktop.delete(command.id);
          for (const target of [...tabs]) if (target.state.desktop === command.id) closeTab(target);
          break;
        case 'set-project': desktop.use(command.id); break;
        case 'open-desktop': openDesktop(command.id, command.item); break;
        case 'create-folder': desktop.createFolder(command.project, command.name); break;
        case 'rename-folder': desktop.renameFolder(command.project, command.id, command.name); break;
        case 'delete-folder': forget(); desktop.deleteFolder(command.project, command.id); break;
        case 'move-item-folder': desktop.moveItemFolder(command.project, command.id, command.folder); break;
        case 'move-item-project': desktop.moveItemProject(command.project, command.id, command.toProject, command.folder); break;
        case 'add-capture-to-project': desktop.addCaptureToProject(command.id, command.project, command.folder); break;
        case 'add-link': desktop.addLink(command.project, command.folder, command.address, command.title); break;
        case 'add-text': desktop.addText(command.project, command.folder, command.text, command.source); break;
        case 'delete-capture': forget(); desktop.deleteItem(null, command.id); break;
        case 'add-note': desktop.addNote(command.project, command.title, command.text, command.folder); break;
        case 'update-item': {
          const fields: { title?: string; text?: string; note?: string } = {};
          if (command.title !== undefined) fields.title = command.title;
          if (command.text !== undefined) fields.text = command.text;
          if (command.note !== undefined) fields.note = command.note;
          desktop.update(command.project, command.id, fields); break;
        }
        case 'delete-item':
          forget(); desktop.deleteItem(command.project, command.id);
          for (const target of tabs) if (target.state.desktop === command.project && target.state.desktopItem === command.id) target.state.desktopItem = null;
          break;
        case 'take-capture': return takeCapture();
        case 'capture-full-page': return takeCapture(command.id);
        case 'capture-screen': {
          if (!screenCapture || screenCapture.id !== command.id) throw new Error('CAPTURE_CHANGED');
          const { bytes, width, height } = screenCapture;
          desktop.replaceCapture(command.id, bytes, { width, height, cut: false }, 'area'); update();
          return { id: command.id, bytes, width, height, cut: false };
        }
        case 'edit-capture': case 'copy-capture': return (async () => {
          desktop.assertUnlocked(); const entry = desktop.item(null, command.id), generation = captureGeneration;
          let bytes = desktop.image(null, command.id);
          if (!bytes || !entry.image) throw new Error('CAPTURE_FAILED');
          if (command.rect) {
            if (!validCaptureRect(command.rect, entry.image)) throw new Error('CAPTURE_AREA_SMALL');
            bytes = nativeImage.createFromBuffer(bytes).crop(command.rect).toPNG();
          }
          if (command.type === 'copy-capture') {
            try { await clipboard.write([new ClipboardItem({ 'image/png': new Blob([new Uint8Array(bytes)], { type: 'image/png' }) })]); }
            catch { throw new Error('CAPTURE_COPY_FAILED'); }
          }
          if (!isCurrent() || disposed || closing || generation !== captureGeneration) throw new Error('CAPTURE_CHANGED');
          if (command.rect) desktop.replaceCapture(command.id, bytes, { ...pngSize(bytes), cut: entry.image.cut }, entry.kind === 'page' ? 'page' : 'area');
          update(); return { id: command.id, bytes, ...pngSize(bytes), cut: entry.image.cut };
        })();
        case 'set-site-dark': {
          const site = siteSettings(store.siteSettings, tab.topURL ?? tab.state.url);
          if (!site) throw new Error('SITE_UNAVAILABLE');
          setSiteDark(store.siteSettings, site.host, command.enabled); persist();
          for (const target of tabs) if (siteSettings(store.siteSettings, target.committedURL ?? target.state.url)?.host === site.host) applyDarkCSS(target);
          break;
        }
        case 'set-blocking': {
          const site = siteSettings(store.siteSettings, tab.topURL ?? tab.state.url);
          if (!site) throw new Error('SITE_UNAVAILABLE');
          setBlocking(store.siteSettings, site.host, command.enabled); persist();
          permissions.drop(tab.state.id);
          // Turning blocking back on must not let the page reuse the ad and tracker responses it cached while it was off.
          if (contents) { if (command.enabled) contents.reloadIgnoringCache(); else contents.reload(); }
          break;
        }
        case 'set-site-permission': {
          const site = siteSettings(store.siteSettings, tab.topURL ?? tab.state.url);
          if (!site) throw new Error('SITE_UNAVAILABLE');
          setPermission(store.siteSettings, site.origin, command.permission, command.decision); persist(); permissions.reconcile(); break;
        }
        case 'answer-permission': permissions.answer(tab.state.id, command.id, command.answer); break;
        case 'theme': case 'migrate-theme': settings.setTheme(command.value, command.type === 'migrate-theme'); break;
        case 'contrast': settings.setContrast(command.value); break;
        case 'new-tab': {
          const destination = command.input ? desktopDestination(command.input) : null;
          if (destination) { openDesktop(destination); break; }
          const section = command.input ? settingsSection(command.input) : null;
          if (section) openSettings(section); else newTab(command.input ? classifyInput(command.input, settings.searchEngine) : undefined, !command.background); break;
        }
        case 'dismiss-context-menu': pageMenu.dismiss(command.id); window.webContents.send(IPC.contextMenu, null); break;
        case 'context-menu': {
          if (!contents) throw new Error('Page is unavailable');
          const params = pageMenu.take(command.id, command.item, tab.state.id);
          window.webContents.send(IPC.contextMenu, null);
          if (command.item.startsWith('spell:')) {
            const word = params.dictionarySuggestions.find(word => `spell:${word}` === command.item);
            if (!word) throw new Error('Unknown spelling suggestion');
            contents.replaceMisspelling(word);
            break;
          }
          switch (command.item) {
            case 'add-to-desktop': {
              if (!desktopInputText(params.selectionText, 100000)) throw new Error('TEXT_INVALID');
              const project = desktop.state().projectInUse ?? [...desktop.list()].sort((a, b) => b.usedAt - a.usedAt)[0]?.id;
              if (!project) { desktopPanel.open = true; desktopPanel.page = { kind: 'new-project' }; window.webContents.focus(); break; }
              desktop.addText(project, null, params.selectionText.trim(), { url: tab.state.url, title: tab.state.title.slice(0, 200) });
              const items = desktop.get(project).items, entry = items.at(-1)!;
              try { desktop.retry(); }
              catch (reason) { const index = items.indexOf(entry); if (index >= 0) items.splice(index, 1); update(); throw reason; }
              break;
            }
            case 'open-link': if (isWebURL(params.linkURL)) newTab(params.linkURL, false); break;
            case 'copy-link': if (isWebURL(params.linkURL)) clipboard.writeText(params.linkURL); break;
            case 'open-image': if (isWebURL(params.srcURL)) newTab(params.srcURL); break;
            case 'save-image': if (isWebURL(params.srcURL)) contents.downloadURL(params.srcURL); break;
            case 'copy-image': if (isWebURL(params.srcURL)) contents.copyImageAt(params.x, params.y); break;
            case 'copy-image-address': if (isWebURL(params.srcURL)) clipboard.writeText(params.srcURL); break;
            case 'search-selection': {
              const prefix = SEARCH_ENGINES[settings.searchEngine].searchPrefix;
              let query = '';
              // The same URL boundary applies even when a page selects an entire document.
              for (const character of params.selectionText.trim()) {
                const encoded = encodeURIComponent(character.length === 1 && /[\ud800-\udfff]/.test(character) ? '\ufffd' : character);
                if (prefix.length + query.length + encoded.length > 8192) break;
                query += encoded;
              }
              const url = prefix + query;
              if (isWebURL(url)) newTab(url);
              break;
            }
            case 'undo': contents.undo(); break;
            case 'redo': contents.redo(); break;
            case 'cut': contents.cut(); break;
            case 'copy': if (params.isEditable) contents.copy(); else clipboard.writeText(params.selectionText); break;
            case 'paste': contents.paste(); break;
            case 'select-all': contents.selectAll(); break;
            case 'back': if (contents.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); break;
            case 'forward': if (contents.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); break;
            case 'reload': tab.state.error = null; contents.reload(); break;
          }
          break;
        }
        case 'open-downloads-folder':
          mkdirSync(resolvedDownloadsFolder(settings, downloads).downloadsFolder, { recursive: true });
          return shell.openPath(resolvedDownloadsFolder(settings, downloads).downloadsFolder).then(error => { if (error) throw new Error('Downloads folder is unavailable'); });
        case 'activate-tab': {
          const target = tabs.find(tab => tab.state.id === command.id);
          if (!target) throw new Error('Unknown tab');
          contents?.stopFindInPage('clearSelection');
          tab.state.find = { active: 0, total: 0 }; tab.findRequest = undefined;
          activate(target); break;
        }
        case 'close-tab': {
          const target = tabs.find(tab => tab.state.id === command.id);
          if (!target) throw new Error('Unknown tab');
          closeTab(target); break;
        }
        case 'navigate': {
          const destination = desktopDestination(command.input);
          if (destination) { openDesktop(destination); break; }
          const section = settingsSection(command.input);
          if (section) openSettings(section); else load(tab, classifyInput(command.input, settings.searchEngine)); break;
        }
        case 'back': if (contents?.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); break;
        case 'forward': if (contents?.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); break;
        case 'reload': if (contents) { tab.state.error = null; contents.reload(); } else if (isAllowedURL(tab.state.url)) load(tab, tab.state.url); break;
        case 'stop': if (tab.state.fullscreen) leaveFullscreen(tab); else { contents?.stop(); tab.cosmeticPending = false; } break;
        case 'focus-page': if (!area.hidden && !tab.state.error) contents?.focus(); break;
        case 'fullscreen':
          if (tab.state.fullscreen) leaveFullscreen(tab);
          else { tab.state.fullscreen = true; window.setFullScreen(true); }
          break;
        case 'zoom': zoom(tab, command.delta); break;
        case 'bookmark': {
          if (!isWebURL(tab.state.url)) break;
          const link = favoriteLinks([...store.favorites.bar, ...store.favorites.other]).find(entry => entry.url === tab.state.url);
          if (link) { const location = favoriteLocation(store.favorites, link.id)!; keep('bookmarks'); location.siblings.splice(location.index, 1); }
          else addFavorite(store.favorites, 'bar', store.favorites.bar.length, tab.state.url, (tab.state.title || tab.state.url).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 200));
          favoritesVersion++; persist(); break;
        }
        case 'add-favorite':
          addFavorite(store.favorites, command.parent, command.position, command.url, command.title);
          favoritesVersion++; persist(); break;
        case 'create-favorite-folder':
          createFavoriteFolder(store.favorites, command.parent, command.position, command.name);
          favoritesVersion++; persist(); break;
        case 'rename-favorite': {
          const location = favoriteLocation(store.favorites, command.id);
          if (!location) throw new Error('FAVORITE_NOT_FOUND');
          if (location.item.kind === 'folder') location.item.name = favoriteName(command.name);
          else location.item.title = favoriteTitle(command.name);
          favoritesVersion++; persist(); break;
        }
        case 'move-favorite':
          moveFavorite(store.favorites, command.id, command.parent, command.position);
          favoritesVersion++; persist(); break;
        case 'delete-favorite': {
          const location = favoriteLocation(store.favorites, command.id);
          if (!location) throw new Error('FAVORITE_NOT_FOUND');
          keep('bookmarks'); location.siblings.splice(location.index, 1);
          favoritesVersion++; persist(); break;
        }
        case 'open-favorite': case 'open-favorite-new-tab': {
          const location = favoriteLocation(store.favorites, command.id);
          if (!location || location.item.kind !== 'link') throw new Error('FAVORITE_NOT_FOUND');
          if (command.type === 'open-favorite-new-tab') newTab(location.item.url, true);
          else if (command.type === 'open-favorite' && command.background) newTab(location.item.url, false);
          else load(tab, location.item.url);
          break;
        }
        case 'open-all-favorites': {
          const items = favoriteDestination(store.favorites, command.id).items;
          const links = favoriteLinks(items);
          if (tabs.length + links.length > 200) throw new Error('FAVORITE_OPEN_LIMIT');
          for (const link of links) newTab(link.url, false);
          break;
        }
        case 'find':
          if (contents && !tab.state.error) {
            if (!command.text) { contents.stopFindInPage('clearSelection'); tab.findRequest = undefined; tab.state.find = { active: 0, total: 0 }; }
            else tab.findRequest = contents.findInPage(command.text, { forward: command.forward, findNext: !command.next });
          }
          break;
        case 'stop-find': contents?.stopFindInPage('clearSelection'); tab.findRequest = undefined; tab.state.find = { active: 0, total: 0 }; break;
        case 'delete-history': keep('history'); store.history = store.history.filter(entry => entry.url !== command.url); persist(); break;
        case 'clear-history': keep('history'); store.history = []; persist(); break;
        case 'restore':
          if (command.kind === 'desktop') { desktop.restore(); break; }
          if (kept?.kind !== command.kind) break;
          if (kept.kind === 'history') store.history = kept.entries;
          else if (kept.kind === 'bookmarks') { store.favorites = kept.entries; favoritesVersion++; }
          else store.downloads = kept.entries;
          forget(); persist(); break;
        case 'rename-bookmark': {
          const entry = favoriteLinks([...store.favorites.bar, ...store.favorites.other]).find(entry => entry.url === command.url);
          if (!entry) throw new Error('FAVORITE_NOT_FOUND');
          entry.title = favoriteTitle(command.title); favoritesVersion++; persist(); break;
        }
        case 'delete-bookmark': {
          const entry = favoriteLinks([...store.favorites.bar, ...store.favorites.other]).find(entry => entry.url === command.url);
          if (!entry) throw new Error('FAVORITE_NOT_FOUND');
          const location = favoriteLocation(store.favorites, entry.id)!;
          keep('bookmarks'); location.siblings.splice(location.index, 1); favoritesVersion++; persist(); break;
        }
        case 'retry-download': {
          const entry = store.downloads.find(entry => entry.id === command.id);
          if (!entry || entry.status !== 'failed' || !isWebURL(entry.url) || tabs.some(tab => tab.retryDownload === entry.id)) throw new Error('Invalid download retry');
          // A dedicated background tab keeps retry from navigating the user's current page.
          const target = newTab(undefined, false);
          target.retryDownload = entry.id;
          try { ensureView(target); page(target.view)!.downloadURL(entry.url); }
          catch (error) { target.retryDownload = undefined; closeTab(target); throw error; }
          break;
        }
        case 'cancel-download': items.get(command.id)?.cancel(); break;
        case 'show-download': {
          const entry = store.downloads.find(entry => entry.id === command.id);
          // A stored path is never accepted as an IPC argument or executed.
          if (!entry || trustedDownloads.get(entry.id) !== entry.path || basename(entry.path) !== entry.filename || /[\x00-\x1f\x7f-\x9f]/.test(entry.path)) throw new Error('Invalid download path');
          shell.showItemInFolder(entry.path); break;
        }
        case 'remove-download':
          if (items.has(command.id)) throw new Error('Download is still active');
          keep('downloads'); store.downloads = store.downloads.filter(entry => entry.id !== command.id); persist(); break;
      }
      reconcileDesktop(); refresh(tab); update();
    };
    const suspend = () => {
      screenCapture = undefined;
      invalidateCaptures(); desktop.forget();
      forget();
      const tab = active();
      if (tab) { leaveFullscreen(tab); page(tab.view)?.stopFindInPage('clearSelection'); tab.findRequest = undefined; tab.state.find = { active: 0, total: 0 }; }
    };
    const dispose = (discard = false) => {
      screenCapture = undefined;
      const attempt = (cleanup: () => void) => {
        if (!discard) { cleanup(); return; }
        try { cleanup(); } catch (error: unknown) { storageFailure(error); }
      };
      if (discard) disposed = true;
      invalidateCaptures(); desktop.dispose(discard);
      forget();
      if (!discard) for (const item of items.values()) item.cancel();
      disposed = true;
      for (const tab of tabs) {
        permissions.drop(tab.state.id);
        clearFavicon(tab);
        attempt(() => leaveFullscreen(tab));
        if (tab.view) {
          attempt(() => tab.view!.setVisible(false));
          if (discard) attempt(() => window.contentView.removeChildView(tab.view!));
          else try { window.contentView.removeChildView(tab.view); } catch { /* The window may already have detached its views. */ }
        }
        attempt(() => page(tab.view)?.close());
      }
      if (discard) for (const item of items.values()) attempt(() => item.cancel());
      tabs.length = 0; items.clear(); reserved.clear();
      if (discard) { clearTimeout(pendingWrite); pendingWrite = undefined; } else flush();
      attempt(() => webSession.removeListener('will-download', downloadHandler));
      profileSessions.delete(webSession);
      requests.clear();
      if (!discard && (store.clearHistoryOnClose || store.clearCacheOnClose)) return clearBeforeDeadline([clearOnClose]);
    };
    return { state, tabs, active, page, run, layout, newTab, suspend, dispose, flush, persist, reserved, webSession, replaceViews, applyDarkCSS, desktop, resetCounts, resetCookies, clearData, clearOnClose, stopForClear };

  }
  ipcMain.handle(IPC.state, (event, ...args: unknown[]) => {
    validateSender(event, window.webContents);
    if (args.length) throw new Error('Unexpected state argument');
    return state();
  });
  ipcMain.handle(IPC.favicon, (event, ...args: unknown[]) => {
    validateSender(event, window.webContents);
    const [id, hash] = args;
    if (args.length !== 2 || typeof id !== 'string' || !id || id.length > 128 || id.includes('\0') || typeof hash !== 'string' || !/^[a-f0-9]{32}$/.test(hash)) throw new Error('Invalid favicon arguments');
    const tab = current().tabs.find(tab => tab.state.id === id);
    if (!tab) throw new Error('Unknown tab');
    return tab.state.favicon === hash ? tab.faviconBytes ?? null : null;
  });
  ipcMain.handle(IPC.project, (event, ...args: unknown[]) => {
    validateSender(event, window.webContents);
    if (args.length !== 1 || !isProfileId(args[0])) throw new Error('Invalid project arguments');
    return current().desktop.content(args[0]);
  });
  ipcMain.handle(IPC.captureImage, (event, ...args: unknown[]) => {
    validateSender(event, window.webContents);
    if (args.length !== 2 || args[0] !== null && !isProfileId(args[0]) || !isProfileId(args[1])) throw new Error('Invalid capture image arguments');
    return current().desktop.image(args[0], args[1]);
  });
  ipcMain.handle(IPC.captures, (event, ...args: unknown[]) => {
    validateSender(event, window.webContents);
    if (args.length) throw new Error('Invalid captures arguments');
    return current().desktop.captures();
  });
  ipcMain.handle(IPC.capture, async (event, ...args: unknown[]) => {
    validateSender(event, window.webContents);
    if (args.length) throw new Error('Unexpected capture argument');
    const runtime = current();
    const tab = runtime.active();
    const view = tab?.view;
    const contents = runtime.page(view);
    if (!view || !contents || tab?.state.error) return null;
    try {
      let image = await contents.capturePage();
      if (current() !== runtime || runtime.active() !== tab || !runtime.page(view) || tab.state.error || image.isEmpty()) return null;
      const bounds = view.getBounds();
      const scale = screen.getDisplayMatching(window.getContentBounds()).scaleFactor;
      const maximumWidth = Math.floor(bounds.width * scale), maximumHeight = Math.floor(bounds.height * scale);
      if (!maximumWidth || !maximumHeight) return null;
      const size = image.getSize();
      const ratio = Math.min(1, maximumWidth / size.width, maximumHeight / size.height);
      if (ratio < 1) image = image.resize({ width: Math.max(1, Math.floor(size.width * ratio)), height: Math.max(1, Math.floor(size.height * ratio)) });
      return image.toJPEG(80);
    } catch { return null; }
  });
  ipcMain.handle(IPC.command, (event, ...args: unknown[]) => {
    validateSender(event, window.webContents);
    if (args.length !== 1) throw new Error('Invalid command arguments');
    if (deleting) throw new Error('Profile deletion is in progress');
    return run(validateCommand(args[0], new Set(registry.profiles.map(profile => profile.id)), current().desktop.list(), current().desktop.captureList(), current().state().store.favorites));
  });
  ipcMain.handle(IPC.contentArea, (event, ...args: unknown[]) => {
    validateSender(event, window.webContents);
    if (args.length !== 1) throw new Error('Invalid content area arguments');
    const next = validateContentArea(args[0]);
    // A hidden page view keeps the keyboard, so an overlay that opened on its own, such as a permission prompt, would get no keys.
    const covering = next.hidden && !area.hidden;
    area = next; layout();
    if (covering && window.isFocused()) window.webContents.focus();
  });
  const flush = () => { for (const runtime of runtimes.values()) { runtime.flush(); runtime.desktop.flush(); } };
  let quitting: Promise<void> | undefined;
  let quitCleared = false;
  const needsClearOnClose = () => registry.profiles.some(profile => {
    const runtime = runtimes.get(profile.id);
    const store = runtime?.state().store ?? readStore(profileStorePath(userData, profile.id), safeStorage);
    return store.clearHistoryOnClose || store.clearCacheOnClose;
  });
  const finishClearing = () => {
    if (!quitting) {
      closing = true; blocker.stop();
      const all = registry.profiles.map(runtimeFor);
      for (const runtime of all) runtime.stopForClear();
      quitting = clearBeforeDeadline(all.map(runtime => runtime.clearOnClose)).then(() => { quitCleared = true; });
    }
    return quitting;
  };
  const beforeQuit = (event?: Electron.Event) => {
    flush();
    if (!quitCleared && needsClearOnClose()) { event?.preventDefault(); void finishClearing().then(() => app.quit()); }
  };
  window.on('close', (event: Electron.Event) => {
    if (!quitCleared && needsClearOnClose()) { event.preventDefault(); void finishClearing().then(() => window.close()); }
  });
  window.on('closed', () => {
    closing = true; invalidateMenu();
    blocker.stop();
    nativeTheme.removeListener('updated', systemDarkPages);
    for (const runtime of runtimes.values()) runtime.dispose();
    app.removeListener('before-quit', beforeQuit);
    window.removeListener('focus', refreshDefaultBrowser);
    for (const channel of [IPC.state, IPC.capture, IPC.favicon, IPC.project, IPC.captures, IPC.captureImage, IPC.command, IPC.contentArea]) ipcMain.removeHandler(channel);
  });
  app.on('before-quit', beforeQuit);
  const initial = runtimeFor(registry.profiles.find(profile => profile.id === registry.activeId)!);
  initial.persist(); initial.newTab();
  void blocker.start();
  refreshDefaultBrowser();
  return { layout, openLaunch: (url: string) => { if (isWebURL(url) || isLocalHTMLURL(url)) current().newTab(url, true, undefined, true); } };
}
