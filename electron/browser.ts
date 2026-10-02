import { app, clipboard, ipcMain, safeStorage, screen, session, shell, WebContentsView } from 'electron';
import type { BrowserWindow, DownloadItem, Session, WebContents, WebPreferences } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { IPC } from '../src/shared/api';
import type { BrowserCommand, BrowserState, BrowserStore, ContentArea, Profile, TabState } from '../src/shared/api';
import { browserShortcut } from '../src/shared/shortcuts';
import { classifyInput, isAllowedSubframeURL, isAllowedURL, isWebURL, parseErrorName } from './browsing';
import { readStore, reserveDownloadPath, writeStore } from './store';
import { validateSender } from './security';
import { validateCommand, validateContentArea } from './commands';
import { fetchFavicon } from './favicon';
import type { ThemeSettings } from './settings';
import { PageMenuSession } from './context-menu';
import { cleanupPartitions, makeProfile, migrateStore, PROFILE_LIMIT, profileName, profileStorePath, readRegistry, removeProfileDirectory, writeRegistry } from './profiles';
import type { ProfileRegistry } from './profiles';
import { createBlockingEngine } from './blocking';
import { PermissionQueue, requestedPermissions, secureOrigin, setBlocking, setPermission, siteSettings, stripCookieHeaders } from './site-settings';

interface Tab { state: TabState; view?: WebContentsView; findRequest?: number; navigation?: number; committed?: boolean; faviconBytes?: Buffer; faviconSite?: string; faviconRequest?: AbortController; topURL?: string; pageLoad: number; refusedCookies: Set<string>; cosmeticPending?: boolean; navigating?: boolean }


const profileSessions = new Set<Session>();
export const isProfileSession = (target: Session): boolean => profileSessions.has(target);

export function createBrowser(window: BrowserWindow, userData: string, downloads: string, settings: ThemeSettings, initialRegistry?: ProfileRegistry) {
  const registryPath = resolve(userData, 'profiles.json');
  const language = app.getLocale().toLowerCase().split('-')[0] === 'es' ? 'es' : 'en';
  let registry = initialRegistry ?? cleanupPartitions(app.getPath('sessionData'), registryPath, readRegistry(registryPath, language), userData);
  let registryError = false;
  const storageFailure = (error: unknown) => { registryError = true; console.error('Profile storage error', error); };
  try { migrateStore(userData, registry, safeStorage); } catch { registryError = true; }
  const runtimes = new Map<string, ReturnType<typeof createRuntime>>();
  let closing = false;
  let deleting = false;
  let area: ContentArea = { top: 96, hidden: true };
  const pageMenu = new PageMenuSession();
  const invalidateMenu = (tabId?: string) => {
    if (pageMenu.invalidate(tabId) && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(IPC.contextMenu, null);
  };
  const current = () => runtimes.get(registry.activeId)!;
  const state = (): BrowserState => ({
    ...current().state(), activeProfileId: registry.activeId,
    profiles: registry.profiles.map(({ id, name, color }) => ({ id, name, color, tabCount: runtimes.get(id)?.tabs.length ?? 0 })),
    storageError: registryError || current().state().storageError, theme: settings.theme, contrast: settings.contrast,
  });
  const publish = () => {
    if (!current() || closing || window.isDestroyed() || window.webContents.isDestroyed()) return;
    const tab = current().active()?.state;
    window.setTitle(tab?.url && tab.url !== 'about:blank' ? `${tab.title || tab.url} - Horizon` : 'Horizon');
    window.webContents.send(IPC.stateChanged, state());
  };
  const blocker = createBlockingEngine(userData, publish);
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
  const run = (command: BrowserCommand) => {
    switch (command.type) {
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
    const tabs: Tab[] = [];
    let activeId = '';
    let storageError = false;
    let pendingWrite: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    const isCurrent = () => registry.activeId === profile.id;
    let kept: { [Kind in 'history' | 'bookmarks' | 'downloads']: { kind: Kind; entries: BrowserStore[Kind] } }['history' | 'bookmarks' | 'downloads'] | undefined;
    let restoreTimeout: ReturnType<typeof setTimeout> | undefined;
    const forget = () => { clearTimeout(restoreTimeout); restoreTimeout = undefined; kept = undefined; };
    const keep = (kind: 'history' | 'bookmarks' | 'downloads') => {
      forget();
      if (kind === 'history') kept = { kind, entries: structuredClone(store.history) };
      else if (kind === 'bookmarks') kept = { kind, entries: structuredClone(store.bookmarks) };
      else kept = { kind, entries: structuredClone(store.downloads) };
      restoreTimeout = setTimeout(forget, 8000);
    };
    const items = new Map<string, DownloadItem>();
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
      const cancel = details.resourceType === 'mainFrame' ? !isAllowedURL(details.url)
        : details.resourceType === 'subFrame' ? !isAllowedSubframeURL(details.url)
        : !['http:', 'https:', 'data:', 'blob:', 'ws:', 'wss:'].includes(scheme);
      if (cancel || disposed || closing) { callback({ cancel: true }); return; }
      const context = requestContext(details);
      const enabled = context && siteSettings(store.siteSettings, context.topURL)?.blocking;
      const match = enabled ? blocker.match(details.url, details.resourceType, context.topURL) : undefined;
      if (!match) { callback({ cancel: false }); return; }
      if (context!.pageLoad === context!.tab.pageLoad) { context!.tab.state.blocked[match.kind]++; publish(); }
      if (match.redirectURL) callback({ redirectURL: match.redirectURL });
      else callback({ cancel: true });
    });
    webSession.webRequest.onBeforeSendHeaders((details, callback) => {
      const context = requestContext(details);
      const headers = context ? stripCookieHeaders(details.requestHeaders, false, details.url, context.topURL,
        siteSettings(store.siteSettings, context.topURL)?.blocking ?? true, context.pageLoad === context.tab.pageLoad ? context.tab.refusedCookies : new Set()) : details.requestHeaders;
      if (context && context.pageLoad === context.tab.pageLoad && context.tab.state.blocked.cookies !== context.tab.refusedCookies.size) { context.tab.state.blocked.cookies = context.tab.refusedCookies.size; publish(); }
      callback({ requestHeaders: headers });
    });
    webSession.webRequest.onHeadersReceived((details, callback) => {
      const context = requestContext(details);
      const headers = context ? stripCookieHeaders(details.responseHeaders ?? {}, true, details.url, context.topURL,
        siteSettings(store.siteSettings, context.topURL)?.blocking ?? true, context.pageLoad === context.tab.pageLoad ? context.tab.refusedCookies : new Set()) : details.responseHeaders;
      if (context && context.pageLoad === context.tab.pageLoad && context.tab.state.blocked.cookies !== context.tab.refusedCookies.size) { context.tab.state.blocked.cookies = context.tab.refusedCookies.size; publish(); }
      callback({ responseHeaders: headers });
    });
    webSession.webRequest.onCompleted(details => { requests.delete(details.id); });
    webSession.webRequest.onErrorOccurred(details => { requests.delete(details.id); });

    const state = () => ({ tabs: tabs.map(tab => ({ ...tab.state, blocked: { ...tab.state.blocked } })), activeId, store, storageError, storageReadError: readStatus.readError,
      blockingReady: blocker.ready, siteSettings: siteSettings(store.siteSettings, active()?.topURL ?? active()?.state.url ?? ''), permissionPrompt: permissions.prompt(activeId) });
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
        tab.view.setBounds({ x: 0, y, width, height: Math.max(0, height - y) });
        tab.view.setVisible(isCurrent() && tab.state.id === activeId && !area.hidden && !tab.state.error && !tab.cosmeticPending && y < height);
      }
    };
    const update = () => { layout(); publish(); };
    const leaveFullscreen = (tab: Tab) => {
      if (!tab.state.fullscreen) return;
      tab.state.fullscreen = false;
      if (!window.isDestroyed()) window.setFullScreen(false);
    };
    const activate = (tab: Tab) => {
      const previous = active();
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
      invalidateMenu(tab.state.id);
      if (tab.faviconSite !== (isWebURL(url) ? new URL(url).origin : '')) clearFavicon(tab, url);
      tab.state.url = url;
      tab.state.title = page(tab.view)?.getTitle().slice(0, 1024) || url;
      tab.state.find = { active: 0, total: 0 };
      tab.findRequest = undefined;
      if (isWebURL(url)) {
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
      permissions.drop(tab.state.id); tab.cosmeticPending = false; tab.navigating = false;
      invalidateMenu(tab.state.id);
      tab.state.loading = false;
      tab.state.error = description === 'RENDERER_GONE' ? description : parseErrorName(description);
      leaveFullscreen(tab);
      refresh(tab); update();
    };
    const load = (tab: Tab, url: string) => {
      if (!isAllowedURL(url)) throw new Error('Invalid navigation URL');
      invalidateMenu(tab.state.id);
      permissions.drop(tab.state.id);
      tab.navigating = true;
      clearFavicon(tab, url);
      ensureView(tab);
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
    const newTab = (url?: string, foreground = true, contents?: WebContents) => {
      if (disposed || closing) throw new Error('Profile is closed');
      if (tabs.length >= 200) throw new Error('Tab limit reached');
      const tab: Tab = { pageLoad: 0, refusedCookies: new Set(), state: { id: randomUUID(), url: url ?? '', title: url ?? '', favicon: null, loading: false, fullscreen: false, canGoBack: false, canGoForward: false, zoom: 1, error: null, find: { active: 0, total: 0 }, blocked: { ads: 0, trackers: 0, cookies: 0 } } };
      clearFavicon(tab, url);
      tabs.push(tab);
      if (foreground || !activeId) activate(tab);
      if (contents) { ensureView(tab, contents); tab.state.loading = contents.isLoading(); }
      else if (url) load(tab, url);
      update();
      return tab;
    };
    const closeTab = (tab: Tab) => {
      const index = tabs.indexOf(tab);
      if (index < 0 || closing || disposed) return;
      invalidateMenu(tab.state.id);
      permissions.drop(tab.state.id);
      leaveFullscreen(tab); clearFavicon(tab);
      tabs.splice(index, 1);
      if (activeId === tab.state.id) activeId = tabs[Math.min(index, tabs.length - 1)]?.state.id ?? '';
      if (tab.view) {
        // A page that closed itself may already have torn its view down.
        try { if (!window.isDestroyed()) window.contentView.removeChildView(tab.view); } catch { /* Nothing left to detach. */ }
        page(tab.view)?.close();
      }
      if (!tabs.length && isCurrent()) newTab();
      update();
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
      contents.setZoomMode('manual');
      contents.setZoomFactor(tab.state.zoom);
      contents.on('context-menu', (_event, params) => {
        if (!isCurrent() || tab.state.id !== activeId || tab.state.error) return;
        invalidateMenu();
        const menu = pageMenu.open(tab.state.id, params, {
          back: contents.navigationHistory.canGoBack(), forward: contents.navigationHistory.canGoForward(), reload: Boolean(tab.state.url),
        }, view.getBounds(), window.webContents.getZoomFactor());
        if (!menu) return;
        window.webContents.focus();
        window.webContents.send(IPC.contextMenu, menu);
      });
      contents.setWindowOpenHandler(details => {
        if (disposed || closing || !isAllowedURL(details.url) || tabs.length >= 200) return { action: 'deny' };
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
      contents.on('destroyed', () => closeTab(tab));
      contents.on('did-start-loading', () => { tab.state.loading = true; publish(); });
      // A reload behind an open overlay hands the keyboard to the hidden page; once Chromium has finished moving it, it goes back to chrome.
      contents.on('focus', () => setImmediate(() => {
        if (!disposed && !closing && !window.isDestroyed() && area.hidden && isCurrent() && tab.state.id === activeId && window.isFocused()) window.webContents.focus();
      }));
      contents.on('did-stop-loading', () => { tab.state.loading = false; tab.navigating = false; refresh(tab); update(); });
      contents.on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
        invalidateMenu(tab.state.id);
        if (isMainFrame) permissions.drop(tab.state.id);
        if (isMainFrame && !isInPlace) {
          tab.navigating = true;
          tab.pageLoad++; tab.topURL = url; tab.refusedCookies = new Set(); tab.state.blocked = { ads: 0, trackers: 0, cookies: 0 };
          tab.cosmeticPending = blocker.ready && !!siteSettings(store.siteSettings, url)?.blocking;
          clearFavicon(tab, url); tab.state.error = null; tab.state.find = { active: 0, total: 0 }; tab.findRequest = undefined; update();
        }
      });
      contents.on('will-redirect', (event) => {
        if (event.isMainFrame && !isAllowedURL(event.url)) fail(tab, 'ERR_UNSAFE_REDIRECT');
      });
      contents.on('did-navigate', (_event, url) => {
        permissions.drop(tab.state.id); tab.navigating = false;
        tab.topURL = url;
        const generation = tab.pageLoad;
        const css = siteSettings(store.siteSettings, url)?.blocking ? blocker.cosmeticCSS(url) : '';
        // Keep the view hidden until styles are installed, so the new document cannot flash unhidden ads.
        if (css) {
          tab.cosmeticPending = true;
          void contents.insertCSS(css, { cssOrigin: 'user' }).catch(() => undefined).finally(() => {
            if (disposed || closing || !tabs.includes(tab) || tab.pageLoad !== generation) return;
            tab.cosmeticPending = false; update();
          });
        } else tab.cosmeticPending = false;
        tab.committed = true;
        record(tab, url);
      });
      contents.on('did-navigate-in-page', (_event, url, mainFrame) => { if (mainFrame) record(tab, url); });
      contents.on('page-favicon-updated', (_event, candidates) => {
        tab.faviconRequest?.abort();
        const request = new AbortController(); tab.faviconRequest = request;
        void fetchFavicon(contents.session, candidates, request.signal, tab.state.url).then(bytes => {
          if (closing || disposed || request.signal.aborted || !tabs.includes(tab) || !page(tab.view)) return;
          tab.faviconBytes = bytes ?? undefined;
          tab.state.favicon = bytes ? createHash('sha256').update(bytes).digest('hex').slice(0, 32) : null;
          publish();
        });
      });
      contents.on('page-title-updated', (_event, title) => {
        tab.state.title = title.slice(0, 1024);
        const entry = store.history.find(entry => entry.url === tab.state.url);
        if (entry) { entry.title = tab.state.title; persist(); }
        publish();
      });
      contents.on('did-fail-load', (_event, code, description, url, mainFrame) => {
        if (!mainFrame || code === -3) return;
        if (isAllowedURL(url)) tab.state.url = url;
        fail(tab, description);
      });
      contents.on('render-process-gone', () => fail(tab, 'RENDERER_GONE'));
      contents.on('enter-html-full-screen', () => {
        if (!isCurrent() || tab.state.id !== activeId) return;
        tab.state.fullscreen = true; window.setFullScreen(true); update();
      });
      contents.on('leave-html-full-screen', () => { leaveFullscreen(tab); update(); });
      contents.on('found-in-page', (_event, result) => {
        if (tab.findRequest !== result.requestId) return;
        tab.state.find = { active: result.activeMatchOrdinal, total: result.matches }; publish();
      });
      contents.on('before-input-event', (event, input) => {
        if (!isCurrent() || tab.state.id !== activeId) return;
        if (input.type !== 'keyDown' || input.isComposing) return;
        const shortcut = browserShortcut(input);
        if (!shortcut) return;
        if (shortcut === 'stop' && !contents.isLoading()) return;
        event.preventDefault();
        if (!isCurrent() || tab.state.id !== activeId) return;
        if (['focus-address', 'find', 'history', 'downloads', 'new-tab', 'close-tab', 'next-tab', 'previous-tab'].includes(shortcut) || shortcut.startsWith('tab-')) window.webContents.focus();
        window.webContents.send(IPC.shortcut, shortcut);
      });
      contents.on('zoom-changed', (_event, direction) => { if (isCurrent() && tab.state.id === activeId) zoom(tab, direction === 'in' ? 1 : -1); });
    }

    const downloadHandler = (event: Electron.Event, item: DownloadItem, contents: WebContents) => {
      const tab = tabs.find(tab => tab.view?.webContents === contents);
      if (!tab || disposed || closing) { event.preventDefault(); return; }
      const url = isWebURL(item.getURL()) ? item.getURL() : tab.state.url;
      if (!isWebURL(url)) { event.preventDefault(); return; }
      try {
        mkdirSync(downloads, { recursive: true });
        const path = reserveDownloadPath(downloads, item.getFilename(), new Set([...reserved, ...[...runtimes.values()].flatMap(runtime => [...runtime.reserved])]));
        reserved.add(path);
        item.setSavePath(path);
        const entry = { id: randomUUID(), url, filename: basename(path), path, received: 0, total: item.getTotalBytes(), status: 'progressing' as const, startedAt: Date.now() };
        store.downloads.unshift(entry);
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
        if (!tab.committed && tabs.length > 1) setImmediate(() => { if (!tab.committed && tabs.length > 1) closeTab(tab); });
      } catch { event.preventDefault(); storageError = true; publish(); }
    };
    webSession.on('will-download', downloadHandler);

    const run = (command: BrowserCommand) => {
      const tab = active();
      if (!tab) return;
      const contents = page(tab.view);
      switch (command.type) {
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
        case 'new-tab': newTab(command.input ? classifyInput(command.input) : undefined, !command.background); break;
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
            case 'open-link': if (isWebURL(params.linkURL)) newTab(params.linkURL, false); break;
            case 'copy-link': if (isWebURL(params.linkURL)) clipboard.writeText(params.linkURL); break;
            case 'open-image': if (isWebURL(params.srcURL)) newTab(params.srcURL); break;
            case 'save-image': if (isWebURL(params.srcURL)) contents.downloadURL(params.srcURL); break;
            case 'copy-image': if (isWebURL(params.srcURL)) contents.copyImageAt(params.x, params.y); break;
            case 'copy-image-address': if (isWebURL(params.srcURL)) clipboard.writeText(params.srcURL); break;
            case 'search-selection': {
              const prefix = 'https://duckduckgo.com/?q=';
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
          mkdirSync(downloads, { recursive: true });
          return shell.openPath(downloads).then(error => { if (error) throw new Error('Downloads folder is unavailable'); });
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
        case 'navigate': load(tab, classifyInput(command.input)); break;
        case 'back': if (contents?.navigationHistory.canGoBack()) contents.navigationHistory.goBack(); break;
        case 'forward': if (contents?.navigationHistory.canGoForward()) contents.navigationHistory.goForward(); break;
        case 'reload': if (contents) { tab.state.error = null; contents.reload(); } else if (isAllowedURL(tab.state.url)) load(tab, tab.state.url); break;
        case 'stop': contents?.stop(); tab.cosmeticPending = false; break;
        case 'focus-page': if (!area.hidden && !tab.state.error) contents?.focus(); break;
        case 'zoom': zoom(tab, command.delta); break;
        case 'bookmark': {
          if (!isWebURL(tab.state.url)) break;
          const index = store.bookmarks.findIndex(entry => entry.url === tab.state.url);
          if (index >= 0) store.bookmarks.splice(index, 1);
          else store.bookmarks.push({ url: tab.state.url, title: tab.state.title || tab.state.url, createdAt: Date.now() });
          persist(); break;
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
          if (kept?.kind !== command.kind) break;
          if (kept.kind === 'history') store.history = kept.entries;
          else if (kept.kind === 'bookmarks') store.bookmarks = kept.entries;
          else store.downloads = kept.entries;
          forget(); persist(); break;
        case 'rename-bookmark': {
          const entry = store.bookmarks.find(entry => entry.url === command.url);
          if (!entry) throw new Error('Unknown bookmark');
          entry.title = command.title; persist(); break;
        }
        case 'delete-bookmark': keep('bookmarks'); store.bookmarks = store.bookmarks.filter(entry => entry.url !== command.url); persist(); break;
        case 'cancel-download': items.get(command.id)?.cancel(); break;
        case 'show-download': {
          const entry = store.downloads.find(entry => entry.id === command.id);
          // A stored path is never accepted as an IPC argument or executed.
          if (!entry || resolve(entry.path) !== resolve(downloads, entry.filename) || dirname(resolve(entry.path)) !== resolve(downloads)) throw new Error('Invalid download path');
          shell.showItemInFolder(entry.path); break;
        }
        case 'remove-download':
          if (items.has(command.id)) throw new Error('Download is still active');
          keep('downloads'); store.downloads = store.downloads.filter(entry => entry.id !== command.id); persist(); break;
      }
      refresh(tab); update();
    };
    const suspend = () => {
      forget();
      const tab = active();
      if (tab) { leaveFullscreen(tab); page(tab.view)?.stopFindInPage('clearSelection'); tab.findRequest = undefined; tab.state.find = { active: 0, total: 0 }; }
    };
    const dispose = (discard = false) => {
      const attempt = (cleanup: () => void) => {
        if (!discard) { cleanup(); return; }
        try { cleanup(); } catch (error: unknown) { storageFailure(error); }
      };
      if (discard) disposed = true;
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
    };
    return { state, tabs, active, page, run, layout, newTab, suspend, dispose, flush, persist, reserved, webSession };

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
    return run(validateCommand(args[0], new Set(registry.profiles.map(profile => profile.id))));
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
  const flush = () => { for (const runtime of runtimes.values()) runtime.flush(); };
  window.on('closed', () => {
    closing = true; invalidateMenu();
    blocker.stop();
    for (const runtime of runtimes.values()) runtime.dispose();
    app.removeListener('before-quit', flush);
    for (const channel of [IPC.state, IPC.capture, IPC.favicon, IPC.command, IPC.contentArea]) ipcMain.removeHandler(channel);
  });
  app.on('before-quit', flush);
  const initial = runtimeFor(registry.profiles.find(profile => profile.id === registry.activeId)!);
  initial.persist(); initial.newTab();
  void blocker.start();
  return { layout };
}
