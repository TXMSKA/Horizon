import { app, ipcMain, screen, session, shell, WebContentsView } from 'electron';
import type { BrowserWindow, DownloadItem, WebContents, WebPreferences } from 'electron';
import { randomUUID } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { mkdirSync } from 'node:fs';
import { IPC } from '../src/shared/api';
import type { BrowserCommand, BrowserState, BrowserStore, ContentArea, TabState } from '../src/shared/api';
import { browserShortcut } from '../src/shared/shortcuts';
import { classifyInput, isAllowedSubframeURL, isAllowedURL, isWebURL, parseErrorName } from './browsing';
import { readStore, reserveDownloadPath, writeStore } from './store';
import { validateSender } from './security';
import { validateCommand, validateContentArea } from './commands';

interface Tab { state: TabState; view?: WebContentsView; findRequest?: number; navigation?: number; committed?: boolean }

export function createBrowser(window: BrowserWindow, userData: string, downloads: string) {
  const storePath = resolve(userData, 'browser-store.json');
  const store = readStore(storePath);
  const tabs: Tab[] = [];
  let activeId = '';
  let storageError = false;
  let pendingWrite: ReturnType<typeof setTimeout> | undefined;
  let closing = false;
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
  let area: ContentArea = { top: 96, hidden: true };
  const items = new Map<string, DownloadItem>();
  const reserved = new Set<string>();
  const webPreferences: WebPreferences = {
    partition: 'persist:web', sandbox: true, contextIsolation: true, nodeIntegration: false,
    nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true,
    allowRunningInsecureContent: false, experimentalFeatures: false, webviewTag: false,
    devTools: false, navigateOnDragDrop: false,
  };
  const webSession = session.fromPartition('persist:web');
  // Electron routes HTML fullscreen through the permission handler; browsers grant it without a prompt and Escape leaves it.
  webSession.setPermissionRequestHandler((_contents, permission, callback) => callback(permission === 'fullscreen'));
  webSession.setPermissionCheckHandler(() => false);
  webSession.setDevicePermissionHandler(() => false);
  webSession.webRequest.onBeforeRequest((details, callback) => {
    const scheme = new URL(details.url).protocol;
    const cancel = details.resourceType === 'mainFrame' ? !isAllowedURL(details.url)
      : details.resourceType === 'subFrame' ? !isAllowedSubframeURL(details.url)
      : !['http:', 'https:', 'data:', 'blob:', 'ws:', 'wss:'].includes(scheme);
    callback({ cancel });
  });

  const state = (): BrowserState => ({ tabs: tabs.map(tab => ({ ...tab.state })), activeId, store, storageError });
  const publish = () => {
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(IPC.stateChanged, state());
  };
  const flush = () => {
    if (pendingWrite === undefined) return;
    clearTimeout(pendingWrite); pendingWrite = undefined;
    try { writeStore(storePath, store); storageError = false; }
    catch { storageError = true; }
    publish();
  };
  const persist = () => {
    if (pendingWrite === undefined) pendingWrite = setTimeout(flush, 500);
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
      const fullscreen = tab.state.id === activeId && tab.state.fullscreen;
      const y = fullscreen ? 0 : top;
      tab.view.setBounds({ x: 0, y, width, height: Math.max(0, height - y) });
      tab.view.setVisible(tab.state.id === activeId && (fullscreen || !area.hidden) && !tab.state.error && y < height);
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
  const record = (tab: Tab, url: string) => {
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
    tab.state.loading = false;
    tab.state.error = description === 'RENDERER_GONE' ? description : parseErrorName(description);
    leaveFullscreen(tab);
    refresh(tab); update();
  };
  const load = (tab: Tab, url: string) => {
    if (!isAllowedURL(url)) throw new Error('Invalid navigation URL');
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
      if (tabs.includes(tab) && tab.navigation === navigation) fail(tab, error instanceof Error ? error.message : 'ERR_FAILED');
    });
  };
  const newTab = (url?: string, foreground = true, contents?: WebContents) => {
    if (tabs.length >= 200) throw new Error('Tab limit reached');
    const tab: Tab = { state: { id: randomUUID(), url: url ?? '', title: url ?? '', loading: false, fullscreen: false, canGoBack: false, canGoForward: false, zoom: 1, error: null, find: { active: 0, total: 0 } } };
    tabs.push(tab);
    if (foreground) activate(tab);
    if (contents) { ensureView(tab, contents); tab.state.loading = contents.isLoading(); }
    else if (url) load(tab, url);
    update();
    return tab;
  };
  const closeTab = (tab: Tab) => {
    const index = tabs.indexOf(tab);
    if (index < 0 || closing) return;
    leaveFullscreen(tab);
    tabs.splice(index, 1);
    if (activeId === tab.state.id) activeId = tabs[Math.min(index, tabs.length - 1)]?.state.id ?? '';
    if (tab.view) {
      // A page that closed itself may already have torn its view down.
      try { if (!window.isDestroyed()) window.contentView.removeChildView(tab.view); } catch { /* Nothing left to detach. */ }
      page(tab.view)?.close();
    }
    if (!tabs.length) newTab();
    update();
  };
  function ensureView(tab: Tab, guest?: WebContents) {
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
    contents.setWindowOpenHandler(details => {
      if (!isAllowedURL(details.url) || tabs.length >= 200) return { action: 'deny' };
      return {
        action: 'allow', outlivesOpener: true, overrideBrowserWindowOptions: { webPreferences },
        createWindow: options => {
          // Electron defers guest creation for background tabs and omits it from the public options type.
          const guest = (options as typeof options & { webContents?: WebContents }).webContents;
          const popup = newTab(details.url, details.disposition !== 'background-tab', guest);
          return popup.view!.webContents;
        },
      };
    });
    contents.on('destroyed', () => closeTab(tab));
    contents.on('did-start-loading', () => { tab.state.loading = true; publish(); });
    contents.on('did-stop-loading', () => { tab.state.loading = false; refresh(tab); update(); });
    contents.on('did-start-navigation', (_event, _url, isInPlace, isMainFrame) => {
      if (isMainFrame && !isInPlace) { tab.state.error = null; tab.state.find = { active: 0, total: 0 }; tab.findRequest = undefined; update(); }
    });
    contents.on('will-redirect', (event) => {
      if (event.isMainFrame && !isAllowedURL(event.url)) fail(tab, 'ERR_UNSAFE_REDIRECT');
    });
    contents.on('did-navigate', (_event, url) => {
      tab.committed = true;
      record(tab, url);
    });
    contents.on('did-navigate-in-page', (_event, url, mainFrame) => { if (mainFrame) record(tab, url); });
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
      if (tab.state.id !== activeId) return;
      tab.state.fullscreen = true; window.setFullScreen(true); update();
    });
    contents.on('leave-html-full-screen', () => { leaveFullscreen(tab); update(); });
    contents.on('found-in-page', (_event, result) => {
      if (tab.findRequest !== result.requestId) return;
      tab.state.find = { active: result.activeMatchOrdinal, total: result.matches }; publish();
    });
    contents.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown' || input.isComposing) return;
      const shortcut = browserShortcut(input);
      if (!shortcut) return;
      if (shortcut === 'stop' && !contents.isLoading()) return;
      event.preventDefault();
      if (tab.state.id !== activeId) return;
      if (['focus-address', 'find', 'history', 'downloads', 'new-tab', 'close-tab', 'next-tab', 'previous-tab'].includes(shortcut) || shortcut.startsWith('tab-')) window.webContents.focus();
      window.webContents.send(IPC.shortcut, shortcut);
    });
    contents.on('zoom-changed', (_event, direction) => zoom(tab, direction === 'in' ? 1 : -1));
  }

  webSession.on('will-download', (event, item, contents) => {
    const tab = tabs.find(tab => tab.view?.webContents === contents);
    if (!tab) { event.preventDefault(); return; }
    const url = isWebURL(item.getURL()) ? item.getURL() : tab.state.url;
    if (!isWebURL(url)) { event.preventDefault(); return; }
    try {
      mkdirSync(downloads, { recursive: true });
      const path = reserveDownloadPath(downloads, item.getFilename(), reserved);
      reserved.add(path);
      item.setSavePath(path);
      const entry = { id: randomUUID(), url, filename: basename(path), path, received: 0, total: item.getTotalBytes(), status: 'progressing' as const, startedAt: Date.now() };
      store.downloads.unshift(entry);
      store.downloads.splice(10000);
      items.set(entry.id, item); persist(); publish();
      let lastUpdate = 0;
      let interrupted = false;
      item.on('updated', (_event, status) => {
        entry.received = item.getReceivedBytes(); entry.total = item.getTotalBytes();
        const stored = store.downloads.find(download => download.id === entry.id);
        if (stored && status === 'interrupted') { interrupted = true; stored.status = 'failed'; item.cancel(); }
        if (Date.now() - lastUpdate > 250) { lastUpdate = Date.now(); persist(); publish(); }
      });
      item.once('done', (_event, status) => {
        const stored = store.downloads.find(download => download.id === entry.id);
        if (stored) { stored.status = interrupted ? 'failed' : status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed'; stored.received = item.getReceivedBytes(); }
        items.delete(entry.id); reserved.delete(path); persist(); publish();
      });
      if (!tab.committed && tabs.length > 1) setImmediate(() => { if (!tab.committed && tabs.length > 1) closeTab(tab); });
    } catch { event.preventDefault(); storageError = true; publish(); }
  });

  const run = (command: BrowserCommand) => {
    const tab = active();
    if (!tab) return;
    const contents = page(tab.view);
    switch (command.type) {
      case 'new-tab': newTab(command.input ? classifyInput(command.input) : undefined); break;
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
      case 'stop': contents?.stop(); break;
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
  ipcMain.handle(IPC.state, (event, ...args: unknown[]) => {
    validateSender(event, window.webContents);
    if (args.length) throw new Error('Unexpected state argument');
    return state();
  });
  ipcMain.handle(IPC.capture, async (event, ...args: unknown[]) => {
    validateSender(event, window.webContents);
    if (args.length) throw new Error('Unexpected capture argument');
    const tab = active();
    const view = tab?.view;
    const contents = page(view);
    if (!view || !contents || tab?.state.error) return null;
    try {
      let image = await contents.capturePage();
      if (active() !== tab || !page(view) || tab.state.error || image.isEmpty()) return null;
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
    run(validateCommand(args[0]));
  });
  ipcMain.handle(IPC.contentArea, (event, ...args: unknown[]) => {
    validateSender(event, window.webContents);
    if (args.length !== 1) throw new Error('Invalid content area arguments');
    area = validateContentArea(args[0]); layout();
  });
  window.on('closed', () => {
    closing = true;
    forget();
    for (const item of items.values()) item.cancel();
    for (const tab of tabs) page(tab.view)?.close();
    flush(); app.removeListener('before-quit', flush);
    for (const channel of [IPC.state, IPC.capture, IPC.command, IPC.contentArea]) ipcMain.removeHandler(channel);
  });
  app.on('before-quit', flush);
  persist();
  newTab();
  return { layout };
}
