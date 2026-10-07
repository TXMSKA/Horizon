import { app, clipboard, ClipboardItem, dialog, ipcMain, Menu, nativeImage, nativeTheme, safeStorage, screen, session, shell, WebContentsView } from 'electron';
import type { BrowserWindow, DownloadItem, Session, WebContents } from 'electron';
import { createHash, randomUUID } from 'node:crypto';
import { basename, dirname, resolve } from 'node:path';
import { mkdirSync, writeFileSync } from 'node:fs';
import type { EventEmitter } from 'node:events';
import { pagePreferences } from './page-preferences';
import { assertPrivateCommand } from './private-commands';
import { GROUP_COLORS, IPC, SEARCH_ENGINES } from '../src/shared/api';
import type { BrowserCommand, BrowserShortcut, BrowserState, BrowserStore, ClearedBrowsingData, ContentArea, DesktopItem, DesktopPanelState, ExtensionWarning, ImportProgress, ImportResult, Profile, SettingsSection, TabState } from '../src/shared/api';
import { browserReservedShortcut, browserShortcut, browserShortcutAccelerators } from '../src/shared/shortcuts';
import { groupBoundaryIndex, moveGroupedTab, nearestVisibleTab, retainedTabGroups } from '../src/shared/tab-groups';
import { classifyInput, isAllowedSubframeURL, isAllowedURL, isWebURL, parseErrorName, settingsAddress, settingsSection } from './browsing';
import { clearStoredHistoryOnClose, readStore, recordsBrowsing, reserveDownloadPath, writeStore } from './store';
import { validateSender } from './security';
import { validateCommand, validateContentArea } from './commands';
import { fetchFavicon } from './favicon';
import type { ThemeSettings } from './settings';
import { resolvedDownloadsFolder, resolveLanguage } from './settings';
import { text } from '../src/copy';
import { createDefaultBrowser } from './default-browser';
import type { Updates } from './updates';
import { isLocalHTMLURL } from './launch';
import { PageMenuSession } from './context-menu';
import { cleanupPartitions, isProfileId, makeProfile, migrateStore, PROFILE_LIMIT, profileName, profileStorePath, readRegistry, removeProfileDirectory, writeRegistry } from './profiles';
import type { ProfileRegistry } from './profiles';
import { blockingPolicy, createBlockingEngine } from './blocking';
import { listSites, PermissionQueue, requestedPermissions, resetSite, secureOrigin, setBlocking, setPermission, setSiteDark, siteHost, siteSettings, stripCookieHeaders } from './site-settings';
import { darkPagesActive, darkPagesCSS, setDarkPagesSwitch } from './dark-pages';
import { desktopInputText } from '../src/shared/desktop-input';
import { createDesktop, desktopAddress } from './desktop';
import { captureWholePage, deadline, pngSize } from './captures';
import { validCaptureRect } from '../src/shared/capture';
import { addFavorite, createFavoriteFolder, deletedFavorite, favoriteDestination, favoriteLinks, favoriteLocation, favoriteName, favoriteTitle, moveFavorite, restoreFavorite } from './favorites';
import type { DeletedFavorite } from './favorites';
import { discoverImportSources, readImport } from './import';
import { HISTORY_LIMIT, mergeFavorites, mergeHistory } from './import-merge';
import { emptySession, lazySession, LEGACY_WINDOW_ID, migrateSession, readWindowSessions, rememberClosed, restoreSession, restorableTab, sessionAddress, takeClosed, writeWindowSessions } from './session-store';
import type { SessionTab, WindowSessions } from './session-store';
import { existingExtensions, profileExtensions } from './extensions';
import { isExtensionURL } from './extension-policy';

interface TabHost { alive(tab: Tab): boolean; update(): void; publish(): void; fail(tab: Tab, description: string): void; close(tab: Tab): void; count(): number }
interface Tab { host: TabHost; unbind?: () => void; viewNavigation?: { pending?: number; entries: { generation: number; urls: Set<string> }[] }; restore?: SessionTab; restoring?: SessionTab; state: TabState; view?: WebContentsView; retryDownload?: string; findRequest?: number; navigation?: number; committed?: boolean; committedURL?: string; faviconBytes?: Buffer; faviconSite?: string; faviconRequest?: AbortController; topURL?: string; pageLoad: number; refusedCookies: Set<string>; cosmeticPending?: boolean; navigating?: boolean; darkCSS?: { contents: WebContents; key: string }; darkCSSWork?: Promise<void> }
interface TabRequest { tab: Tab; pageLoad: number; topURL: string }
interface DownloadOwner { disposed(): boolean; store: BrowserStore; items: Map<string, DownloadItem>; reserved: Set<string>; bindings: Map<string, DownloadBinding>; trusted: Map<string, string>; persist(): void; publish(): void }
interface DownloadBinding { tab: Tab; path: string; owner: DownloadOwner }
interface TabDestination {
  tabs: Tab[]; requests: Map<number, TabRequest>; permissions: PermissionQueue; downloadBindings: Map<string, DownloadBinding>; downloadOwner: DownloadOwner;
  active(): Tab | undefined; assertAccept(tab: Tab): void; attachView(tab: Tab): void; detachView(tab: Tab): void; bindTab(tab: Tab): void; activate(tab: Tab): void; select(id: string): void; layout(): void; update(): void; flushSession(): void;
}


const profileSessions = new Set<Session>();
const downloadPaths = new Set<string>();
export const isProfileSession = (target: Session): boolean => profileSessions.has(target);
const launchURLs = new WeakMap<WebContents, string>();
export const isLaunchNavigation = (contents: WebContents, url: string): boolean => launchURLs.get(contents) === url && isLocalHTMLURL(url);

interface SessionOwner {
  owns(contents: WebContents | number | null | undefined): boolean;
  ownsRequest?(id: number): boolean;
  request?: NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>;
  check?: NonNullable<Parameters<Session['setPermissionCheckHandler']>[0]>;
  before?: NonNullable<Parameters<Session['webRequest']['onBeforeRequest']>[0]>;
  send?: NonNullable<Parameters<Session['webRequest']['onBeforeSendHeaders']>[0]>;
  receive?: NonNullable<Parameters<Session['webRequest']['onHeadersReceived']>[0]>;
  completed?: NonNullable<Parameters<Session['webRequest']['onCompleted']>[0]>;
  failed?: NonNullable<Parameters<Session['webRequest']['onErrorOccurred']>[0]>;
}
const sessionOwners = new WeakMap<Session, Set<SessionOwner>>();
function attachSession(target: Session, owner: SessionOwner) {
  let owners = sessionOwners.get(target);
  if (!owners) {
    owners = new Set(); sessionOwners.set(target, owners); profileSessions.add(target);
    const select = (contents: WebContents | number | null | undefined) => [...owners!].find(owner => owner.owns(contents)) ?? (!contents ? owners!.values().next().value : undefined);
    const requests = new Map<number, SessionOwner>();
    const requestOwner = (details: { id: number; webContentsId?: number; url?: string; initiatorOrigin?: string }) => {
      const saved = requests.get(details.id);
      const owner = (details.webContentsId === undefined ? undefined : select(details.webContentsId)) ?? [...owners!].find(owner => owner.ownsRequest?.(details.id)) ?? (saved && owners!.has(saved) ? saved : undefined) ?? (!details.webContentsId || isExtensionURL(target, details.url ?? '') || isExtensionURL(target, details.initiatorOrigin ?? '') ? select(undefined) : undefined);
      if (owner) requests.set(details.id, owner);
      return owner;
    };
    target.setPermissionRequestHandler((contents, permission, callback, details) => {
      const owner = select(contents);
      if (owner?.request) owner.request(contents, permission, callback, details); else callback(false);
    });
    target.setPermissionCheckHandler((...args) => select(args[0])?.check?.(...args) ?? false);
    target.setDevicePermissionHandler(() => false);
    target.webRequest.onBeforeRequest((details, callback) => { const owner = requestOwner(details); if (owner?.before) owner.before(details, callback); else callback({ cancel: true }); });
    target.webRequest.onBeforeSendHeaders((details, callback) => { const owner = requestOwner(details); if (owner?.send) owner.send(details, callback); else callback({ requestHeaders: details.requestHeaders }); });
    target.webRequest.onHeadersReceived((details, callback) => { const owner = requestOwner(details); if (owner?.receive) owner.receive(details, callback); else callback({ responseHeaders: details.responseHeaders }); });
    target.webRequest.onCompleted(details => { requestOwner(details)?.completed?.(details); requests.delete(details.id); });
    target.webRequest.onErrorOccurred(details => { requestOwner(details)?.failed?.(details); requests.delete(details.id); });
  }
  owners.add(owner);
  return () => { owners!.delete(owner); if (!owners!.size) { sessionOwners.delete(target); profileSessions.delete(target); } };
}

type BrowserOwner = { window: BrowserWindow; privateWindow: boolean; activeProfile(): string; publish(): void; flush(): void; stop(): void; releasePrivate(): void; persistSessions(): void; settingsChanged(): void; disposeProfile(id: string): void; registryChanged(): void; runtime(id: string): unknown };
interface ProfileData { store: BrowserStore; status: { readError: boolean; memoryOnly: boolean }; desktop: ReturnType<typeof createDesktop>; sessions: WindowSessions; sessionStatus: { readError: boolean; memoryOnly: boolean }; favoritesVersion: number; importProgress: ImportProgress | null }
export interface BrowserGroup {
  registry: ProfileRegistry; owners: Map<string, BrowserOwner>; profiles: Map<string, ProfileData>;
  privatePartition?: string; privateCount: number; privateCleanup: Set<Promise<unknown>>; quitting?: Promise<void>; quitCleared: boolean; quitRequested?: boolean;
}
const groups = new Map<string, BrowserGroup>();
const chromeHandlers = new Map<WebContents, Map<string, (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown>>();
function handleChrome(window: BrowserWindow, channel: string, handler: (event: Electron.IpcMainInvokeEvent, ...args: unknown[]) => unknown) {
  let handlers = chromeHandlers.get(window.webContents);
  if (!handlers) { handlers = new Map(); chromeHandlers.set(window.webContents, handlers); }
  if (![...chromeHandlers.values()].some(map => map.has(channel))) ipcMain.handle(channel, (event, ...args: unknown[]) => {
    const handler = chromeHandlers.get(event.sender)?.get(channel);
    if (!handler) throw new Error('Unknown browser window');
    return handler(event, ...args);
  });
  handlers.set(channel, handler);
}
export function restoredWindows(userData: string, registry: ProfileRegistry) {
  const windows = new Map<string, string>();
  for (const profile of registry.profiles) {
    const saved = readWindowSessions(resolve(dirname(profileStorePath(userData, profile.id)), 'session.json'), safeStorage, url => url.startsWith('horizon://desktop/'), { readError: false, memoryOnly: false });
    for (const window of saved.windows) if (!windows.has(window.id) || window.selected) windows.set(window.id, window.selected ? profile.id : windows.get(window.id) ?? registry.activeId);
  }
  return [...windows].map(([id, profileId]) => ({ id, profileId }));
}
export interface BrowserOptions { id?: string; profileId?: string; privateWindow?: boolean; fresh?: boolean; empty?: boolean; updates?: Pick<Updates, 'state' | 'subscribe' | 'restart'>; extensionURLs?: string[]; moveWindow?: (profileId: string, privateWindow: boolean, origin: BrowserWindow, adopt: (destinationId: string) => void, point?: { x: number; y: number }) => Promise<void>; openWindow?: (profileId: string, privateWindow: boolean, origin: BrowserWindow) => void; extensionWindow?: (profileId: string, details: chrome.windows.CreateData, origin: BrowserWindow) => Promise<BrowserWindow> }

// Development builds can point the importers at synthetic browser folders; shipped builds always read the user's own.
const importEnvironment = () => ({ local: app.isPackaged ? process.env.LOCALAPPDATA : process.env.HORIZON_IMPORT_LOCALAPPDATA ?? process.env.LOCALAPPDATA, roaming: app.isPackaged ? process.env.APPDATA : process.env.HORIZON_IMPORT_APPDATA ?? process.env.APPDATA });

export function createBrowser(window: BrowserWindow, userData: string, downloads: string, settings: ThemeSettings, initialRegistry?: ProfileRegistry, defaultBrowserOverride?: ReturnType<typeof createDefaultBrowser>, options: BrowserOptions = {}) {
  const registryPath = resolve(userData, 'profiles.json');
  const language = resolveLanguage(settings.language, app.getLocale());
  let group = groups.get(userData);
  if (!group) {
    group = { registry: initialRegistry ?? cleanupPartitions(app.getPath('sessionData'), registryPath, readRegistry(registryPath, language), userData), owners: new Map(), profiles: new Map(), privateCount: 0, privateCleanup: new Set(), quitCleared: false };
    groups.set(userData, group);
  }
  const shared = group;
  let registry = shared.registry;
  const privateWindow = options.privateWindow === true;
  const windowId = options.id ?? (shared.owners.size ? randomUUID() : LEGACY_WINDOW_ID);
  let selectedProfile = options.profileId ?? registry.activeId;
  if (!registry.profiles.some(profile => profile.id === selectedProfile)) selectedProfile = registry.activeId;
  if (privateWindow) { shared.privatePartition ??= `private-${randomUUID()}`; shared.privateCount++; }
  let registryError = false;
  const storageFailure = (error: unknown) => { registryError = true; console.error('Profile storage error', error); };
  try { migrateStore(userData, registry, safeStorage); } catch { registryError = true; }
  const runtimes = new Map<string, ReturnType<typeof createRuntime>>();
  let darkActive = darkPagesActive(settings.darkPages, nativeTheme.shouldUseDarkColors);
  let blockingEnabled = settings.blockAds;
  let cookiesBlocked = settings.blockThirdPartyCookies;
  let closing = false;
  let deleting = false;
  let extensionDecision: { warning: ExtensionWarning; answer(allow: boolean): void } | null = null;
  const cancelExtensionDecision = () => { extensionDecision?.answer(false); };
  const askExtension = (profileId: string, warning: Omit<ExtensionWarning, 'requestId'>) => {
    if (privateWindow || closing || extensionDecision || selectedProfile !== profileId || window.isDestroyed()) return Promise.resolve(false);
    return new Promise<boolean>(done => {
      const requestId = randomUUID(), timer = setTimeout(() => extensionDecision?.warning.requestId === requestId && extensionDecision.answer(false), 300000);
      extensionDecision = { warning: { ...warning, requestId }, answer: allow => { clearTimeout(timer); extensionDecision = null; done(allow); publish(); } };
      publish();
    });
  };
  let clearingBrowsingData = false;
  let area: ContentArea = { top: 96, hidden: true };
  const pageMenu = new PageMenuSession();
  const invalidateMenu = (tabId?: string) => {
    if (pageMenu.invalidate(tabId) && !window.isDestroyed() && !window.webContents.isDestroyed()) window.webContents.send(IPC.contextMenu, null);
  };
  const current = () => runtimes.get(selectedProfile)!;
  const state = (): BrowserState => ({
    ...current().state(), firstRun: !settings.onboarded && !privateWindow, version: app.getVersion(), update: options.updates?.state ?? { status: 'unavailable' }, activeProfileId: selectedProfile, privateWindow,
    extensionWarning: extensionDecision?.warning ?? null,
    profiles: registry.profiles.map(({ id, name, color }) => ({ id, name, color, tabCount: runtimes.get(id)?.tabs.length ?? 0 })),
    storageError: registryError || current().state().storageError, theme: settings.theme, contrast: settings.contrast,
    quickAccess: settings.quickAccess, showCapture: settings.showCapture,
    darkPages: { mode: settings.darkPages, strength: settings.darkStrength, tone: settings.darkTone, active: darkActive },
    onStart: settings.onStart, searchEngine: settings.searchEngine, languageSetting: settings.language, language: resolveLanguage(settings.language, app.getLocale()),
    ...resolvedDownloadsFolder(settings, downloads), askWhereToSave: settings.askWhereToSave,
    blockAds: privateWindow || settings.blockAds, blockThirdPartyCookies: privateWindow || settings.blockThirdPartyCookies, clearingBrowsingData, defaultBrowser: defaultBrowser.status,
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
  const unsubscribeUpdates = options.updates?.subscribe(publish);
  const layout = () => { for (const runtime of runtimes.values()) runtime.layout(); };
  const saveRegistry = (next: ProfileRegistry) => { writeRegistry(registryPath, next); shared.registry = next; registry = next; for (const owner of shared.owners.values()) owner.registryChanged(); };
  const runtimeFor = (profile: Profile) => {
    let runtime = runtimes.get(profile.id);
    if (!runtime) { runtime = createRuntime(profile); runtimes.set(profile.id, runtime); }
    return runtime;
  };
  const switchProfile = (id: string) => {
    cancelExtensionDecision();
    const profile = registry.profiles.find(profile => profile.id === id);
    if (!profile) throw new Error('Unknown profile');
    const next = runtimeFor(profile);
    if (id !== selectedProfile) {
      selectedProfile = id;
      saveRegistry({ ...registry, activeId: id });
      invalidateMenu();
      for (const runtime of runtimes.values()) runtime.suspend();
    }
    if (!next.active()) next.newTab();
    for (const runtime of runtimes.values()) runtime.persistSession();
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
    if (closing || shared.quitting) throw new Error('Browser is closing');
    if (privateWindow) assertPrivateCommand(command);
    if (privateWindow && ['switch-profile', 'create-profile', 'update-profile', 'delete-profile', 'set-blocking', 'set-site-permission', 'answer-permission', 'reset-site', 'set-block-ads', 'set-block-third-party-cookies', 'set-clear-history-on-close', 'set-clear-cache-on-close'].includes(command.type)) throw new Error('Private window settings are fixed');
    switch (command.type) {
      case 'answer-extension-install':
        if (!extensionDecision || extensionDecision.warning.requestId !== command.id) throw new Error('EXTENSION_NOT_FOUND');
        extensionDecision.answer(command.allow); return;
      case 'set-extension-enabled': return existingExtensions(current().webSession)!.setEnabled(command.id, command.enabled);
      case 'set-extension-pinned': return existingExtensions(current().webSession)!.setPinned(command.id, command.pinned);
      case 'remove-extension': return existingExtensions(current().webSession)!.remove(command.id);
      case 'check-extension-updates': return existingExtensions(current().webSession)!.checkUpdates();
      case 'open-extension': {
        const runtime = current(), tab = runtime.active();
        if (!tab) throw new Error('EXTENSIONS_UNAVAILABLE');
        runtime.ensureView(tab);
        const contents = runtime.page(tab.view)!;
        const zoom = window.webContents.getZoomFactor(), bounds = window.getContentBounds();
        const anchor = command.anchor ?? { x: Math.max(0, Math.floor(bounds.width / zoom) - 64), y: 64, width: 32, height: 32 };
        if (anchor.x + anchor.width > bounds.width / zoom || anchor.y + anchor.height > bounds.height / zoom) throw new Error('Invalid extension anchor');
        const scaled = { x: Math.round(anchor.x * zoom), y: Math.round(anchor.y * zoom), width: Math.round(anchor.width * zoom), height: Math.round(anchor.height * zoom) };
        return existingExtensions(runtime.webSession)!.openPopup(command.id, window, contents, scaled);
      }
      case 'move-tab-to-window': {
        const source = current(), tab = source.tabs.find(tab => tab.state.id === command.id);
        if (!tab) throw new Error('Unknown tab');
        source.assertMove(tab);
        if (!options.moveWindow) throw new Error('Window creation is unavailable');
        return options.moveWindow(selectedProfile, privateWindow, window, destinationId => moveTab(command.id, destinationId), command.point);
      }
      case 'new-window': case 'new-private-window':
        if (!options.openWindow) throw new Error('Window creation is unavailable');
        options.openWindow(selectedProfile, command.type === 'new-private-window', window); return;
      case 'pin-app': case 'unpin-app': settings.setAppPinned(command.id, command.type === 'pin-app'); publish(); return;
      case 'register-default-browser': return defaultBrowser.register().then(publish);
      case 'restart-to-update': if (!options.updates) throw new Error('Updates are unavailable'); options.updates.restart(); return;
      case 'set-search-engine': settings.setSearchEngine(command.value); publish(); return;
      case 'set-on-start': settings.setOnStart(command.value); publish(); return;
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
      case 'list-import-sources': return discoverImportSources(importEnvironment());
      case 'import-browser-data': return current().importBrowserData(command);
      case 'finish-first-run': settings.finishFirstRun(); publish(); return;
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
        shared.profiles.get(profile.id)?.desktop.dispose(true); shared.profiles.delete(profile.id);
        deleting = true;
        return (async () => {
          try {
            const next = runtimeFor(registry.profiles.find(other => other.id === selectedProfile)!);
            if (!next.active()) next.newTab();
            const attempt = async (cleanup: () => unknown) => { try { await cleanup(); } catch (error: unknown) { storageFailure(error); } };
            const runtime = runtimes.get(profile.id);
            await attempt(() => runtime?.dispose(true));
            cancelExtensionDecision();
            await attempt(() => existingExtensions(session.fromPartition(profile.partition))?.stop());
            // Stop service workers and sockets before clearing caches so background traffic cannot refill them.
            await attempt(async () => {
              const target = runtime?.webSession ?? session.fromPartition(profile.partition);
              for (const cleanup of [() => target.clearStorageData(), () => target.closeAllConnections(), () => target.clearCache(), () => target.clearAuthCache(), () => target.clearCodeCaches({})]) await attempt(cleanup);
            });
            await attempt(() => removeProfileDirectory(resolve(userData, 'profiles'), profile.id));
          } finally {
            runtimes.delete(profile.id);
            invalidateMenu();
            const next = runtimeFor(registry.profiles.find(other => other.id === selectedProfile)!);
            if (!next.active()) next.newTab();
            deleting = false; layout(); publish();
          }
        })();
      }
      default: return current().run(command);
    }
  };
  function createRuntime(profile: Profile) {
    const storePath = profileStorePath(userData, profile.id);
    let data = shared.profiles.get(profile.id);
    if (!data) {
      const status = { readError: false, memoryOnly: false }, sessionStatus = { readError: false, memoryOnly: false };
      const store = readStore(storePath, safeStorage, status);
      const desktop = createDesktop(resolve(dirname(storePath), 'notebooks.json'), safeStorage, () => { for (const owner of shared.owners.values()) { owner.persistSessions(); owner.publish(); } });
      const own = (url: string) => url.startsWith('horizon://desktop/') && !desktop.state().desktopLocked && (url === 'horizon://desktop/captures' || desktop.list().some(project => desktopAddress(project.name) === url));
      data = { store, status, desktop, sessions: readWindowSessions(resolve(dirname(storePath), 'session.json'), safeStorage, own, sessionStatus), sessionStatus, favoritesVersion: 0, importProgress: null };
      shared.profiles.set(profile.id, data);
    }
    const profileData = data;
    const readStatus = profileData.status;
    const store: BrowserStore = privateWindow ? { version: 5, history: [], favorites: structuredClone(profileData.store.favorites), downloads: [], siteSettings: { blocking: [], dark: [], permissions: [] }, clearHistoryOnClose: false, clearCacheOnClose: false } : profileData.store;
    // A fresh snapshot shows normal-window edits without lending private code the writable tree.
    if (privateWindow) Object.defineProperty(store, 'favorites', { enumerable: true, get: () => structuredClone(profileData.store.favorites) });
    const desktop = privateWindow ? createDesktop(resolve(dirname(storePath), 'notebooks.json'), safeStorage, publish, true) : profileData.desktop;
    const ownAddress = (url: string) => url.startsWith('horizon://desktop/') && !desktop.state().desktopLocked && (url === 'horizon://desktop/captures' || desktop.list().some(project => desktopAddress(project.name) === url));
    const sessionPath = resolve(dirname(storePath), 'session.json');
    const sessionStatus = profileData.sessionStatus;
    const savedSession = migrateSession(privateWindow || options.fresh ? emptySession() : profileData.sessions.windows.find(saved => saved.id === windowId)?.session ?? emptySession());
    let sessionWrite: ReturnType<typeof setTimeout> | undefined;
    let sessionError = false;
    const desktopPanel: DesktopPanelState = { open: false, page: { kind: 'home' } };
    const tabs: Tab[] = [];
    let tabGroups = privateWindow || options.fresh || settings.onStart !== 'restore' ? [] : structuredClone(savedSession.groups ?? []);
    let groupEditorId: string | null = null;
    let nextGroupColor = tabGroups.length % GROUP_COLORS.length;
    let activeId = '';
    let storageError = false;
    let pendingWrite: ReturnType<typeof setTimeout> | undefined;
    let disposed = false;
    let clearingData = false;
    let captureGeneration = 0;
    const captureRequests = new Set<AbortController>();
    let screenCapture: { id: string; bytes: Buffer; width: number; height: number; generation: number } | undefined;
    const invalidateCaptures = () => { captureGeneration++; for (const request of captureRequests) request.abort(); captureRequests.clear(); };
    const isCurrent = () => selectedProfile === profile.id;
    let kept: { kind: 'history'; entries: BrowserStore['history'] } | { kind: 'bookmarks'; deleted: DeletedFavorite } | { kind: 'downloads'; entries: BrowserStore['downloads'] } | undefined;
    let restoreTimeout: ReturnType<typeof setTimeout> | undefined;
    const forget = () => { clearTimeout(restoreTimeout); restoreTimeout = undefined; kept = undefined; };
    const keep = (kind: 'history' | 'downloads') => {
      forget();
      desktop.forget();
      if (kind === 'history') kept = { kind, entries: structuredClone(store.history) };
      else kept = { kind, entries: structuredClone(store.downloads) };
      restoreTimeout = setTimeout(forget, 8000);
    };
    const keepFavorite = (deleted: DeletedFavorite) => {
      forget(); desktop.forget(); kept = { kind: 'bookmarks', deleted };
      restoreTimeout = setTimeout(forget, 8000);
    };
    const items = new Map<string, DownloadItem>();
    const trustedDownloads = new Map(store.downloads.filter(entry => basename(entry.path) === entry.filename && !/[\x00-\x1f\x7f-\x9f]/.test(entry.path)).map(entry => [entry.id, entry.path]));
    const reserved = new Set<string>();
    const webPreferences = pagePreferences(privateWindow ? shared.privatePartition! : profile.partition, privateWindow);
    const webSession = session.fromPartition(webPreferences.partition!);
    const extensions = privateWindow ? undefined : profileExtensions(userData, profile, webSession, () => { for (const owner of shared.owners.values()) owner.publish(); });
    const detachExtensions = extensions?.attach({ contents: window.webContents, warning: warning => askExtension(profile.id, warning) });
    const permissions = new PermissionQueue(store.siteSettings, publish, () => persist());
    const tabFor = (contents: WebContents | null | undefined) => contents && tabs.find(tab => tab.view?.webContents === contents);
    const sessionOwner: SessionOwner = { owns: contents => tabs.some(tab => typeof contents === 'number' ? tab.view?.webContents.id === contents : tab.view?.webContents === contents) };
    const detachSession = attachSession(webSession, sessionOwner);
    // Frame requests inherit the top-level origin; a frame cannot choose the origin shown by chrome.
    sessionOwner.request = (contents, permission, callback, details) => {
      if (privateWindow) { callback(false); return; }
      if (permission === 'fullscreen') { callback(true); return; }
      const tab = tabFor(contents), origin = tab && siteSettings(store.siteSettings, contents.mainFrame.origin ?? contents.mainFrame.url)?.origin;
      if (!tab || !origin || tab.navigating || disposed || closing) { callback(false); return; }
      permissions.request(tab.state.id, origin, requestedPermissions(permission, details), callback);
    };
    sessionOwner.check = (contents, permission, requestingOrigin, details) => {
      if (privateWindow) return false;
      if (permission === 'fullscreen') return true;
      const tab = tabFor(contents);
      const url = tab ? contents!.mainFrame.origin ?? contents!.mainFrame.url : !contents ? details?.embeddingOrigin ?? requestingOrigin : '';
      const site = siteSettings(store.siteSettings, url ?? '');
      const requested = requestedPermissions(permission, details);
      return !!site && secureOrigin(site.origin) && requested.length > 0 && requested.every(permission => site.permissions[permission] === 'allow');
    };
    const requests = new Map<number, TabRequest>();
    sessionOwner.ownsRequest = id => requests.has(id);
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
    sessionOwner.before = (details, callback) => {
      if (privateWindow && details.resourceType === 'script') { callback({ cancel: true }); return; }
      if (extensions && isExtensionURL(webSession, details.url)) { callback({ cancel: disposed || closing }); return; }
      const scheme = new URL(details.url).protocol;
      const tab = details.webContentsId === undefined ? undefined : tabs.find(tab => tab.view?.webContents.id === details.webContentsId);
      const cancel = details.resourceType === 'mainFrame' ? !(isAllowedURL(details.url) || !!tab?.view && isLaunchNavigation(tab.view.webContents, details.url))
        : details.resourceType === 'subFrame' ? !isAllowedSubframeURL(details.url)
        : !['http:', 'https:', 'data:', 'blob:', 'ws:', 'wss:'].includes(scheme) && !(extensions && isExtensionURL(webSession, details.url));
      if (cancel || disposed || closing || clearingData) { callback({ cancel: true }); return; }
      const context = requestContext(details);
      if (privateWindow && !blocker.ready && /^(?:https?|wss?):/.test(scheme)) { callback({ cancel: true }); return; }
      const origin = [details.frame?.top?.url, details.initiatorOrigin, details.referrer].find(url => typeof url === 'string' && isWebURL(url));
      if (privateWindow && !context && !origin && /^(?:https?|wss?):/.test(scheme)) { callback({ cancel: true }); return; }
      const topURL = context?.topURL ?? origin ?? details.url;
      const enabled = blockingPolicy(privateWindow, settings.blockAds, settings.blockThirdPartyCookies, siteSettings(store.siteSettings, topURL)?.blocking ?? true).filters;
      const match = enabled && (context || privateWindow) ? blocker.match(details.url, details.resourceType, topURL) : undefined;
      if (!match) { callback({ cancel: false }); return; }
      if (context && context.pageLoad === context.tab.pageLoad) { context.tab.state.blocked[match.kind]++; publish(); }
      if (match.redirectURL) callback({ redirectURL: match.redirectURL });
      else callback({ cancel: true });
    };
    sessionOwner.send = (details, callback) => {
      const context = requestContext(details);
      const headers = context ? stripCookieHeaders(details.requestHeaders, false, details.url, context.topURL,
        blockingPolicy(privateWindow, settings.blockAds, settings.blockThirdPartyCookies, siteSettings(store.siteSettings, context.topURL)?.blocking ?? true).thirdPartyCookies, context.pageLoad === context.tab.pageLoad ? context.tab.refusedCookies : new Set()) : privateWindow ? Object.fromEntries(Object.entries(details.requestHeaders).filter(([key]) => key.toLowerCase() !== 'cookie')) : details.requestHeaders;
      if (context && context.pageLoad === context.tab.pageLoad && context.tab.state.blocked.cookies !== context.tab.refusedCookies.size) { context.tab.state.blocked.cookies = context.tab.refusedCookies.size; publish(); }
      callback({ requestHeaders: headers });
    };
    sessionOwner.receive = (details, callback) => {
      const context = requestContext(details);
      const headers = context ? stripCookieHeaders(details.responseHeaders ?? {}, true, details.url, context.topURL,
        blockingPolicy(privateWindow, settings.blockAds, settings.blockThirdPartyCookies, siteSettings(store.siteSettings, context.topURL)?.blocking ?? true).thirdPartyCookies, context.pageLoad === context.tab.pageLoad ? context.tab.refusedCookies : new Set()) : privateWindow ? Object.fromEntries(Object.entries(details.responseHeaders ?? {}).filter(([key]) => key.toLowerCase() !== 'set-cookie')) : details.responseHeaders;
      if (context && context.pageLoad === context.tab.pageLoad && context.tab.state.blocked.cookies !== context.tab.refusedCookies.size) { context.tab.state.blocked.cookies = context.tab.refusedCookies.size; publish(); }
      if (privateWindow && details.resourceType === 'mainFrame' && Object.entries(headers ?? {}).some(([key, values]) => key.toLowerCase() === 'content-type' && values.some(value => /^application\/pdf(?:;|$)/i.test(value)))) {
        const downloadHeaders = Object.fromEntries(Object.entries(headers ?? {}).filter(([key]) => key.toLowerCase() !== 'content-disposition'));
        callback({ responseHeaders: { ...downloadHeaders, 'Content-Disposition': ['attachment'] } }); return;
      }
      callback({ responseHeaders: headers });
    };
    sessionOwner.completed = details => { requests.delete(details.id); };
    sessionOwner.failed = details => { requests.delete(details.id); };

    const state = () => ({ ...desktop.state(), desktopPanel: structuredClone(desktopPanel), groups: structuredClone(tabGroups), groupEditorId, tabs: tabs.map(tab => ({ ...tab.state, movable: movable(tab), blocked: { ...tab.state.blocked } })), activeId, store, favoritesVersion: profileData.favoritesVersion, importProgress: profileData.importProgress, storageError: storageError || sessionError, storageReadError: readStatus.readError || sessionStatus.readError,
      clearHistoryOnClose: store.clearHistoryOnClose, clearCacheOnClose: store.clearCacheOnClose, sites: listSites(store.siteSettings),
      extensions: extensions?.list(page(active()?.view)) ?? [], extensionsUpdating: extensions?.status().updating ?? false, extensionsError: extensions?.status().storageError ?? false,
      canReopenTab: tabs.length < 200 && savedSession.closed.some(tab => sessionAddress(tab.url, ownAddress)),
      blockingReady: blocker.ready, siteSettings: active()?.state.settings || active()?.state.desktop ? null : privateSite(active()?.topURL ?? active()?.state.url ?? ''), permissionPrompt: privateWindow ? null : permissions.prompt(activeId) });
    function privateSite(url: string) {
      const site = siteSettings(store.siteSettings, url);
      return privateWindow && site ? { ...site, blocking: true, permissions: { camera: 'block' as const, microphone: 'block' as const, location: 'block' as const, notifications: 'block' as const } } : site;
    }
    const snapshotTab = (tab: Tab): SessionTab => {
      if (tab.restore || tab.restoring) return { ...structuredClone((tab.restore ?? tab.restoring)!), groupId: tab.state.groupId };
      const history = !tab.state.settings && !tab.state.desktop ? page(tab.view)?.navigationHistory : undefined;
      const entries = history?.getAllEntries() ?? [], selected = history?.getActiveIndex() ?? -1;
      const start = Math.max(0, selected - 1000), kept = entries.slice(start, start + 2000);
      // Chromium pageState can embed form values and file addresses; only addresses and titles cross the restore boundary.
      return { url: tab.state.url, title: tab.state.title.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 4096), zoom: tab.state.zoom, groupId: tab.state.groupId,
        entries: kept.map(entry => ({ url: entry.url, title: entry.title.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 4096) })), index: kept.length ? Math.max(0, selected - start) : -1 };
    };
    const flushSession = () => {
      clearTimeout(sessionWrite); sessionWrite = undefined;
      if (!recordsBrowsing(privateWindow) || sessionStatus.memoryOnly || disposed) return;
      try {
        const open = tabs.filter(tab => !tab.retryDownload);
        const next = restoreSession({ ...savedSession, groups: retainedTabGroups(open.map(tab => tab.state), tabGroups), tabs: open.map(snapshotTab), active: open.findIndex(tab => tab.state.id === activeId) }, ownAddress);
        const saved = { id: windowId, selected: isCurrent(), session: next };
        const index = profileData.sessions.windows.findIndex(saved => saved.id === windowId);
        if (index < 0) profileData.sessions.windows.push(saved); else profileData.sessions.windows[index] = saved;
        writeWindowSessions(sessionPath, profileData.sessions, safeStorage); sessionError = false;
      } catch { sessionError = true; }
    };
    const persistSession = () => {
      if (!recordsBrowsing(privateWindow) || disposed || closing || sessionStatus.memoryOnly) return;
      clearTimeout(sessionWrite); sessionWrite = setTimeout(() => { flushSession(); publish(); }, 500);
    };
    const flush = () => {
      flushSession();
      if (pendingWrite === undefined || !recordsBrowsing(privateWindow)) return;
      clearTimeout(pendingWrite); pendingWrite = undefined;
      try { writeStore(storePath, store, safeStorage); storageError = false; }
      catch { storageError = true; }
      publish();
    };
    const persist = () => {
      if (recordsBrowsing(privateWindow) && !disposed && !readStatus.memoryOnly && pendingWrite === undefined) pendingWrite = setTimeout(flush, 500);
    };
    const saveNow = () => {
      if (privateWindow) return;
      clearTimeout(pendingWrite); pendingWrite = undefined;
      if (readStatus.memoryOnly) { storageError = true; throw new Error('PROFILE_SETTINGS_SAVE_FAILED'); }
      try { writeStore(storePath, store, safeStorage); storageError = false; }
      catch { storageError = true; throw new Error('PROFILE_SETTINGS_SAVE_FAILED'); }
    };
    const editStore = (edit: () => void, failure: string) => {
      if (privateWindow) throw new Error('Private window favorites are read-only');
      const previous = { favorites: structuredClone(store.favorites), history: store.history };
      try {
        edit();
        try {
          if (readStatus.memoryOnly) throw new Error('Store encryption is unavailable');
          writeStore(storePath, profileData.store, safeStorage);
        } catch {
          storageError = true;
          throw new Error(failure);
        }
      } catch (error) { store.favorites = previous.favorites; store.history = previous.history; publish(); throw error; }
      clearTimeout(pendingWrite); pendingWrite = undefined;
      storageError = false; profileData.favoritesVersion++;
      for (const owner of shared.owners.values()) owner.publish();
    };
    const editFavorites = (edit: () => void) => editStore(edit, 'FAVORITE_STORAGE_FAILED');
    const importBrowserData = async (command: Extract<BrowserCommand, { type: 'import-browser-data' }>): Promise<ImportResult> => {
      if (profileData.importProgress) throw new Error('IMPORT_IN_PROGRESS');
      const announce = (progress: ImportProgress | null) => { profileData.importProgress = progress; for (const owner of shared.owners.values()) owner.publish(); };
      announce({ current: 0, total: 0 });
      try {
        const language = resolveLanguage(settings.language, app.getLocale());
        const data = await readImport(importEnvironment(), command, { mobile: text('importMobileFavorites', language), menu: text('importMenuFavorites', language) }, resolve(userData, 'import'), (current, total) => announce({ current, total }));
        if (disposed || closing) throw new Error('IMPORT_STORAGE_FAILED');
        const result: ImportResult = { favorites: 0, history: 0, skipped: (data.favorites?.skipped ?? 0) + (data.history?.skipped ?? 0), searchEngine: data.searchEngine !== settings.searchEngine ? data.searchEngine : null };
        const previousEngine = settings.searchEngine;
        try {
          if (result.searchEngine) settings.setSearchEngine(result.searchEngine);
          editStore(() => {
            if (data.favorites) { const merged = mergeFavorites(store.favorites, data.favorites); result.favorites = merged.links; result.skipped += merged.skipped; }
            if (data.history) { const merged = mergeHistory(store.history, data.history.entries); store.history = merged.history; result.history = merged.imported; }
          }, 'IMPORT_STORAGE_FAILED');
        } catch (error) {
          if (result.searchEngine) try { settings.setSearchEngine(previousEngine); } catch { /* The saved engine stays as it was written. */ }
          throw error;
        }
        return result;
      } finally { announce(null); }
    };
    const deleteFavorite = (id: string) => {
      const deleted = deletedFavorite(store.favorites, id);
      editFavorites(() => { const location = favoriteLocation(store.favorites, id)!; location.siblings.splice(location.index, 1); });
      keepFavorite(deleted);
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
      if (store.clearHistoryOnClose) { try { clearStoredHistoryOnClose(storePath, store, safeStorage); } catch { storageError = true; } }
      closeClear = store.clearCacheOnClose ? Promise.resolve().then(() => webSession.clearCache()).catch(() => { storageError = true; }) : Promise.resolve();
      return closeClear;
    };
    const resetCookies = () => { for (const tab of tabs) { tab.refusedCookies.clear(); tab.state.blocked.cookies = 0; } };
    const resetCounts = () => { resetCookies(); for (const tab of tabs) tab.state.blocked = { ads: 0, trackers: 0, cookies: 0 }; };
    const active = () => tabs.find(tab => tab.state.id === activeId);
    const pruneGroups = () => {
      tabGroups = retainedTabGroups(tabs.map(tab => tab.state), tabGroups);
      if (!tabGroups.some(group => group.id === groupEditorId)) groupEditorId = null;
    };
    const assignGroup = (tab: Tab, group: string | null) => {
      const ordered = tabs.map(tab => tab.state), byState = new Map(tabs.map(tab => [tab.state, tab]));
      moveGroupedTab(ordered, tab.state, group); tabs.splice(0, tabs.length, ...ordered.map(state => byState.get(state)!)); pruneGroups();
    };
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
      const selected = active();
      if (isCurrent() && selected) resumeTab(selected);
      if (extensions && selected?.view) extensions.selectTab?.(selected.view.webContents);
      const { width, height } = window.getContentBounds();
      const top = Math.min(height, Math.ceil(area.top * window.webContents.getZoomFactor()));
      for (const tab of tabs) {
        if (!tab.view || !page(tab.view)) continue;
        const fullscreen = isCurrent() && tab.state.id === activeId && tab.state.fullscreen;
        const y = fullscreen ? 0 : top;
        const panelWidth = !fullscreen && desktopPanel.open ? Math.ceil(400 * window.webContents.getZoomFactor()) : 0;
        tab.view.setBounds({ x: 0, y, width: Math.max(0, width - panelWidth), height: Math.max(0, height - y) });
        tab.view.setVisible(isCurrent() && tab.state.id === activeId && Boolean(tab.state.url) && !tab.state.desktop && !tab.state.settings && !area.hidden && !tab.state.error && !tab.cosmeticPending && y < height);
      }
    };
    const update = () => { for (const tab of tabs) page(tab.view)?.emit('tab-updated'); persistSession(); layout(); publish(); };
    const host: TabHost = { alive: tab => !disposed && !closing && tabs.includes(tab), update, publish, fail: (tab, description) => fail(tab, description), close: tab => closeTab(tab), count: () => tabs.length };
    const downloadBindings = new Map<string, DownloadBinding>();
    const downloadOwner: DownloadOwner = { disposed: () => disposed, store, items, reserved, bindings: downloadBindings, trusted: trustedDownloads, persist, publish };
    // Native page dialogs disable their parent window, including commands already queued by chrome.
    const movable = (tab: Tab) => !tab.retryDownload && window.isEnabled() && !permissions.prompt(tab.state.id);
    const applyDarkCSS = (tab: Tab) => {
      const contents = page(tab.view), generation = tab.pageLoad;
      if (!contents) return;
      // Serialize replacement so a late insertion cannot leave a second stylesheet behind.
      tab.darkCSSWork = (tab.darkCSSWork ?? Promise.resolve()).then(async () => {
        const current = () => tab.host.alive(tab) && page(tab.view) === contents && tab.pageLoad === generation;
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
      if (previous && previous !== tab) { page(previous.view)?.setIgnoreMenuShortcuts(true); leaveFullscreen(previous); }
      activeId = tab.state.id;
      const group = tabGroups.find(group => group.id === tab.state.groupId);
      if (group) group.folded = false;
    };
    const zoom = (tab: Tab, delta: -1 | 0 | 1) => {
      const contents = page(tab.view);
      if (!contents) return;
      tab.state.zoom = delta === 0 ? 1 : Math.max(0.25, Math.min(3, Math.round((tab.state.zoom + delta * 0.1) * 100) / 100));
      contents.setZoomFactor(tab.state.zoom);
      persistSession(); publish();
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
      tab.state.url = url === 'about:blank' ? '' : url;
      tab.committedURL = url;
      tab.state.title = url === 'about:blank' ? '' : page(tab.view)?.getTitle().slice(0, 1024) || url;
      tab.state.find = { active: 0, total: 0 };
      tab.findRequest = undefined;
      if (recordsBrowsing(privateWindow) && isWebURL(url) && !clearingData && !closing && !disposed) {
        const existing = store.history.find(entry => entry.url === url);
        if (existing) { existing.lastVisit = Date.now(); existing.visitCount++; existing.title = tab.state.title; }
        else store.history.push({ url, title: tab.state.title, lastVisit: Date.now(), visitCount: 1 });
        store.history.sort((a, b) => b.lastVisit - a.lastVisit);
        store.history.splice(HISTORY_LIMIT);
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
      if (!isAllowedURL(url) && !(extensions && isExtensionURL(webSession, url)) && !(launch && isLocalHTMLURL(url))) throw new Error('Invalid navigation URL');
      tab.restore = undefined; tab.restoring = undefined;
      tab.state.desktop = null; tab.state.desktopItem = null; tab.state.settings = null;
      if (active() === tab) invalidateCaptures();
      invalidateMenu(tab.state.id);
      permissions.drop(tab.state.id);
      tab.navigating = true;
      clearFavicon(tab, url);
      ensureView(tab);
      if (launch && isLocalHTMLURL(url)) launchURLs.set(tab.view!.webContents, url);
      tab.state.url = url === 'about:blank' ? '' : url;
      tab.state.title = tab.state.url;
      tab.state.error = null;
      tab.state.loading = url !== 'about:blank';
      const navigation = (tab.navigation ?? 0) + 1;
      tab.navigation = navigation;
      update();
      void tab.view!.webContents.loadURL(url).catch((error: unknown) => {
        // Aborted requests are expected when Stop or a newer navigation wins.
        if (error instanceof Error && error.message.includes('ERR_ABORTED')) return;
        if (tab.host.alive(tab) && tab.navigation === navigation) tab.host.fail(tab, error instanceof Error ? error.message : 'ERR_FAILED');
      });
    };
    const makeTab = (url = ''): Tab => ({ host, pageLoad: 0, refusedCookies: new Set(), state: { id: randomUUID(), groupId: null, movable: true, settings: null, desktop: null, desktopItem: null, url, title: url, favicon: null, loading: false, fullscreen: false, canGoBack: false, canGoForward: false, zoom: 1, error: null, find: { active: 0, total: 0 }, blocked: { ads: 0, trackers: 0, cookies: 0 } } });
    const restoredTab = (saved: SessionTab) => {
      const tab = makeTab(saved.url);
      tab.state.groupId = saved.groupId ?? null;
      tab.state.title = saved.title; tab.state.zoom = saved.zoom;
      tab.state.settings = settingsSection(saved.url);
      tab.state.desktop = ownAddress(saved.url) ? saved.url === 'horizon://desktop/captures' ? 'captures' : desktop.list().find(project => desktopAddress(project.name) === saved.url)!.id : null;
      if (!tab.state.settings && !tab.state.desktop && (saved.url || saved.entries.length)) {
        tab.restore = { url: saved.url, title: saved.title, zoom: saved.zoom, entries: structuredClone(saved.entries), index: saved.index };
        tab.state.canGoBack = saved.index > 0; tab.state.canGoForward = saved.index >= 0 && saved.index < saved.entries.length - 1;
      }
      return tab;
    };
    function resumeTab(tab: Tab) {
      const saved = tab.restore;
      if (!saved || disposed || closing) return;
      tab.restore = undefined;
      const allowed = restorableTab(saved, ownAddress);
      if (!allowed) { closeTab(tab); return; }
      if (!allowed.entries.length) { load(tab, allowed.url); return; }
      ensureView(tab);
      const contents = page(tab.view)!;
      tab.restoring = allowed; tab.state.loading = Boolean(allowed.url); tab.navigating = true;
      const navigation = tab.navigation = (tab.navigation ?? 0) + 1;
      void contents.navigationHistory.restore({ entries: allowed.entries, index: allowed.index }).catch((error: unknown) => {
        if (error instanceof Error && error.message.includes('ERR_ABORTED')) return;
        if (tab.host.alive(tab) && page(tab.view) === contents && tab.navigation === navigation) tab.host.fail(tab, error instanceof Error ? error.message : 'ERR_FAILED');
      }).finally(() => {
        if (tab.restoring === allowed) { tab.restoring = undefined; if (tab.host.alive(tab)) tab.host.update(); }
      });
    }
    const newTab = (url?: string, foreground = true, contents?: WebContents, launch = false) => {
      if (disposed || closing) throw new Error('Profile is closed');
      if (tabs.length >= 200) throw new Error('Tab limit reached');
      const tab = makeTab(url);
      clearFavicon(tab, url);
      tabs.push(tab);
      if (foreground || !activeId) activate(tab);
      if (contents) { ensureView(tab, contents); tab.state.loading = contents.isLoading(); }
      else if (url) load(tab, url, launch);
      else if (extensions?.hasEnabled?.()) ensureView(tab);
      update();
      return tab;
    };
    const openSettings = (section: SettingsSection) => {
      if (privateWindow && section === 'profiles') section = 'general';
      let target = tabs.find(tab => tab.state.settings !== null);
      if (!target) {
        if (tabs.length >= 200) throw new Error('SETTINGS_TAB_LIMIT');
        const index = tabs.findIndex(tab => tab.state.id === activeId);
        target = newTab(); tabs.splice(tabs.indexOf(target), 1); tabs.splice(groupBoundaryIndex(tabs.map(tab => tab.state), index + 1), 0, target);
      }
      target.state.settings = section; target.state.url = settingsAddress(section); target.state.title = 'Settings';
      target.restore = undefined; target.restoring = undefined;
      activate(target); update(); return target;
    };
    const closeTab = (tab: Tab, remember = true) => {
      const index = tabs.indexOf(tab);
      if (index < 0 || closing || disposed) return;
      if (remember && recordsBrowsing(privateWindow) && !tab.retryDownload) { const saved = restorableTab(snapshotTab(tab), ownAddress); if (saved) rememberClosed(savedSession, saved, index); }
      invalidateMenu(tab.state.id);
      permissions.drop(tab.state.id);
      leaveFullscreen(tab); clearFavicon(tab);
      tabs.splice(index, 1);
      pruneGroups();
      if (activeId === tab.state.id) invalidateCaptures();
      if (activeId === tab.state.id) {
        const nearest = nearestVisibleTab(tabs.map(tab => tab.state), tabGroups, Math.min(index, tabs.length - 1));
        activeId = tabs[nearest]?.state.id ?? '';
      }
      if (tab.view) {
        extensions?.untrackTab?.(tab.view.webContents);
        // A page that closed itself may already have torn its view down.
        try { if (!window.isDestroyed()) window.contentView.removeChildView(tab.view); } catch { /* Nothing left to detach. */ }
        page(tab.view)?.close();
      }
      if (!activeId && isCurrent()) newTab();
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
          tab.state.url = entries[index]!.url === 'about:blank' ? '' : entries[index]!.url; tab.state.loading = Boolean(tab.state.url); tab.navigating = true;
          const navigation = tab.navigation;
          void next.navigationHistory.restore({ entries, index }).catch((error: unknown) => {
            if (error instanceof Error && error.message.includes('ERR_ABORTED')) return;
            if (tab.host.alive(tab) && page(tab.view) === next && tab.navigation === navigation) tab.host.fail(tab, error instanceof Error ? error.message : 'ERR_FAILED');
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
      tab.viewNavigation = { entries: [] };
      contentsSetup(tab, view);
    }
    function contentsSetup(tab: Tab, view: WebContentsView) {
      tab.unbind?.(); tab.host = host;
      const contents = view.webContents;
      if (extensions) {
        extensions.trackTab?.(contents, window);
        const detach = extensions.attach({ contents, warning: warning => askExtension(profile.id, warning) });
        contents.once('destroyed', detach);
      }
      const emitter: EventEmitter = contents;
      const removers: (() => void)[] = [];
      const on: WebContents['on'] = (event, listener) => {
        emitter.on(event, listener); removers.push(() => emitter.removeListener(event, listener)); return contents;
      };
      tab.unbind = () => { for (const remove of removers) remove(); tab.unbind = undefined; };
      const navigationState = tab.viewNavigation!;
      const navigations = navigationState.entries;
      const finishUncommitted = (generation: number | undefined) => {
        if (tab.view !== view || generation === undefined || navigationState.pending !== generation || tab.pageLoad !== generation) return;
        navigationState.pending = undefined;
        tab.cosmeticPending = false; tab.navigating = false;
        tab.topURL = tab.committedURL ?? contents.mainFrame.url;
        update();
      };
      contents.setZoomMode('manual');
      contents.setZoomFactor(tab.state.zoom);
      on('context-menu', (_event, params) => {
        if (tab.view !== view || !isCurrent() || tab.state.id !== activeId || tab.state.error) return;
        invalidateMenu();
        const menu = pageMenu.open(tab.state.id, params, {
          back: contents.navigationHistory.canGoBack(), forward: contents.navigationHistory.canGoForward(), reload: Boolean(tab.state.url),
        }, view.getBounds(), window.webContents.getZoomFactor(), privateWindow, extensions?.contextMenuItems?.(contents, params).map(item => ({ item, window })));
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
      on('destroyed', () => { if (tab.view === view) closeTab(tab); });
      on('did-start-loading', () => { if (tab.view === view) { tab.state.loading = true; publish(); } });
      // Loading can hand the keyboard to a hidden page; chrome must keep it while Home or an overlay is showing.
      on('focus', () => setImmediate(() => {
        if (tab.view === view && !disposed && !closing && !window.isDestroyed() && (area.hidden || !tab.state.url) && isCurrent() && tab.state.id === activeId && window.isFocused()) window.webContents.focus();
      }));
      on('did-stop-loading', () => {
        if (tab.view !== view || contents.isLoading()) return;
        finishUncommitted(navigationState.pending); navigations.length = 0;
        tab.state.loading = false; tab.navigating = false; refresh(tab); update();
      });
      on('did-start-navigation', (_event, url, isInPlace, isMainFrame) => {
        if (tab.view !== view) return;
        invalidateMenu(tab.state.id);
        if (isMainFrame) permissions.drop(tab.state.id);
        if (isMainFrame && active() === tab) invalidateCaptures();
        if (isMainFrame && !isInPlace) {
          tab.navigating = true;
          tab.pageLoad++; tab.topURL = url; tab.refusedCookies = new Set(); tab.state.blocked = { ads: 0, trackers: 0, cookies: 0 };
          navigationState.pending = tab.pageLoad;
          navigations.push({ generation: tab.pageLoad, urls: new Set([url]) });
          tab.cosmeticPending = blockingPolicy(privateWindow, settings.blockAds, settings.blockThirdPartyCookies, siteSettings(store.siteSettings, url)?.blocking ?? true).filters && blocker.ready;
          clearFavicon(tab, url); tab.state.error = null; tab.state.find = { active: 0, total: 0 }; tab.findRequest = undefined; update();
        }
      });
      on('did-redirect-navigation', (_event, url, _isInPlace, isMainFrame) => {
        if (tab.view === view && isMainFrame) navigations.find(navigation => navigation.generation === navigationState.pending)?.urls.add(url);
      });
      on('will-redirect', (event) => {
        if (tab.view !== view) return;
        if (event.isMainFrame && !isAllowedURL(event.url) && !isLaunchNavigation(contents, event.url)) fail(tab, 'ERR_UNSAFE_REDIRECT');
      });
      on('did-navigate', (_event, url) => {
        if (tab.view !== view) return;
        if (url === 'about:blank' && (tab.restore || tab.state.desktop || tab.state.settings)) return;
        navigationState.pending = undefined;
        permissions.drop(tab.state.id); tab.navigating = false;
        tab.topURL = url;
        const generation = tab.pageLoad;
        const css = blockingPolicy(privateWindow, settings.blockAds, settings.blockThirdPartyCookies, siteSettings(store.siteSettings, url)?.blocking ?? true).filters ? blocker.cosmeticCSS(url) : '';
        // Keep the view hidden until styles are installed, so the new document cannot flash unhidden ads.
        if (css) {
          tab.cosmeticPending = true;
          void contents.insertCSS(css, { cssOrigin: 'user' }).catch(() => undefined).finally(() => {
            if (!tab.host.alive(tab) || tab.view !== view || tab.pageLoad !== generation) return;
            tab.cosmeticPending = false; tab.host.update();
          });
        } else tab.cosmeticPending = false;
        tab.committed = true;
        record(tab, url);
        applyDarkCSS(tab);
      });
      on('did-navigate-in-page', (_event, url, mainFrame) => { if (tab.view === view && mainFrame) record(tab, url); });
      on('page-favicon-updated', (_event, candidates) => {
        if (tab.view !== view) return;
        tab.faviconRequest?.abort();
        const request = new AbortController(); tab.faviconRequest = request;
        void fetchFavicon(contents.session, candidates, request.signal, tab.state.url).then(bytes => {
          if (!tab.host.alive(tab) || request.signal.aborted || tab.view !== view || !page(tab.view)) return;
          tab.faviconBytes = bytes ?? undefined;
          tab.state.favicon = bytes ? createHash('sha256').update(bytes).digest('hex').slice(0, 32) : null;
          tab.host.publish();
        });
      });
      on('page-title-updated', (_event, title) => {
        if (tab.view !== view || tab.restore || tab.state.desktop || tab.state.settings) return;
        tab.state.title = title.slice(0, 1024);
        const entry = store.history.find(entry => entry.url === tab.state.url);
        if (recordsBrowsing(privateWindow) && entry && !clearingData && !closing && !disposed) { entry.title = tab.state.title; persist(); }
        persistSession(); publish();
      });
      on('did-fail-load', (_event, code, description, url, mainFrame) => {
        if (tab.view !== view || !mainFrame) return;
        // Failure events have no navigation ID; retain start order even when two loads use the same URL.
        const index = navigations.findIndex(navigation => navigation.urls.has(url));
        const navigation = index < 0 ? undefined : navigations.splice(index, 1)[0];
        if (code === -3) { finishUncommitted(navigation?.generation); return; }
        if (isAllowedURL(url)) tab.state.url = url;
        fail(tab, description);
      });
      on('render-process-gone', () => { if (tab.view === view) fail(tab, 'RENDERER_GONE'); });
      on('enter-html-full-screen', () => {
        if (tab.view !== view || !isCurrent() || tab.state.id !== activeId) return;
        tab.state.fullscreen = true; window.setFullScreen(true); update();
      });
      on('leave-html-full-screen', () => { if (tab.view === view) { leaveFullscreen(tab); update(); } });
      on('found-in-page', (_event, result) => {
        if (tab.view !== view || tab.findRequest !== result.requestId) return;
        tab.state.find = { active: result.activeMatchOrdinal, total: result.matches }; publish();
      });
      on('before-input-event', (event, input) => {
        contents.setIgnoreMenuShortcuts(Boolean(input.isComposing) || tab.view !== view || !isCurrent() || tab.state.id !== activeId);
        if (tab.view !== view || !isCurrent() || tab.state.id !== activeId) return;
        if (input.type !== 'keyDown' || input.isComposing) return;
        if (extensions?.commandInput?.(input, contents)) { event.preventDefault(); return; }
        const shortcut = browserShortcut(input);
        if (!shortcut || !browserReservedShortcut(shortcut, tab.state.fullscreen)) return;
        event.preventDefault();
        dispatchShortcut(shortcut);
      });
      on('zoom-changed', (_event, direction) => { if (tab.view === view && isCurrent() && tab.state.id === activeId) zoom(tab, direction === 'in' ? 1 : -1); });
    }

    const dispatchShortcut = (shortcut: BrowserShortcut) => {
      const tab = active(), contents = page(tab?.view);
      if (!tab || !contents || !isCurrent() || disposed || closing) return;
      if (privateWindow && shortcut === 'bookmark') return;
      if (shortcut === 'reopen-tab' && !state().canReopenTab) return;
      if (shortcut === 'fullscreen' || shortcut === 'stop' && tab.state.fullscreen) {
        run({ type: shortcut === 'fullscreen' ? 'fullscreen' : 'stop' }); return;
      }
      if (shortcut === 'stop' && !contents.isLoading()) return;
      if (['capture', 'focus-address', 'focus-search', 'find', 'find-next', 'find-previous', 'menu', 'clear-browsing-data', 'reopen-tab', 'home', 'favorites', 'history', 'downloads', 'new-tab', 'new-window', 'new-private-window', 'close-tab', 'next-tab', 'previous-tab'].includes(shortcut) || shortcut.startsWith('tab-')) window.webContents.focus();
      window.webContents.send(IPC.shortcut, shortcut);
    };

    const downloadHandler = (event: Electron.Event, item: DownloadItem, contents: WebContents) => {
      const tab = tabs.find(tab => tab.view?.webContents === contents);
      const retry = Boolean(tab?.retryDownload);
      let accepted = false;
      try {
        if (!tab) {
          if (![...(sessionOwners.get(webSession) ?? [])].some(owner => owner.owns(contents))) event.preventDefault();
          return;
        }
        if (disposed || closing) { event.preventDefault(); return; }
        const url = isWebURL(item.getURL()) ? item.getURL() : tab.state.url;
        if (!isWebURL(url)) { event.preventDefault(); return; }
        const folder = resolvedDownloadsFolder(settings, downloads).downloadsFolder;
        mkdirSync(folder, { recursive: true });
        const proposed = reserveDownloadPath(folder, item.getFilename(), downloadPaths);
        const selected = settings.askWhereToSave ? dialog.showSaveDialogSync(window, { defaultPath: proposed }) : proposed;
        if (!selected) { event.preventDefault(); item.cancel(); return; }
        const path = selected;
        reserved.add(path); downloadPaths.add(path);
        item.setSavePath(path);
        const retryIndex = tab.retryDownload ? store.downloads.findIndex(entry => entry.id === tab.retryDownload) : -1;
        const entry = { id: retryIndex >= 0 ? tab.retryDownload! : randomUUID(), url, filename: basename(path), path, received: 0, total: item.getTotalBytes(), status: 'progressing' as const, startedAt: Date.now() };
        if (recordsBrowsing(privateWindow)) { if (retryIndex >= 0) store.downloads.splice(retryIndex, 1, entry); else store.downloads.unshift(entry); }
        tab.retryDownload = undefined;
        if (recordsBrowsing(privateWindow)) trustedDownloads.set(entry.id, entry.path);
        store.downloads.splice(10000);
        items.set(entry.id, item); persist(); publish();
        const binding: DownloadBinding = { tab, path, owner: downloadOwner };
        downloadBindings.set(entry.id, binding);
        let lastUpdate = 0;
        let interrupted = false;
        item.on('updated', (_event, status) => {
          const owner = binding.owner;
          if (owner.disposed()) return;
          if (privateWindow) return;
          entry.received = item.getReceivedBytes(); entry.total = item.getTotalBytes();
          const stored = owner.store.downloads.find(download => download.id === entry.id);
          if (stored && status === 'interrupted') { interrupted = true; stored.status = 'failed'; item.cancel(); }
          if (Date.now() - lastUpdate > 250) { lastUpdate = Date.now(); owner.persist(); owner.publish(); }
        });
        item.once('done', (_event, status) => {
          const owner = binding.owner;
          if (owner.disposed()) return;
          const stored = owner.store.downloads.find(download => download.id === entry.id);
          if (stored) { stored.status = interrupted ? 'failed' : status === 'completed' ? 'completed' : status === 'cancelled' ? 'cancelled' : 'failed'; stored.received = item.getReceivedBytes(); }
          owner.items.delete(entry.id); owner.bindings.delete(entry.id); owner.reserved.delete(path); downloadPaths.delete(path); owner.persist(); owner.publish();
        });
        accepted = true;
        if (!tab.committed && tabs.length > 1) setImmediate(() => { if (tab.host.alive(tab) && !tab.committed && tab.host.count() > 1) tab.host.close(tab); });
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
      if (privateWindow) throw new Error('Private window Desktop is unavailable');
      if (address === 'horizon://desktop/captures') return 'captures';
      const project = desktop.list().find(project => desktopAddress(project.name) === address);
      if (!project) throw new Error('DESKTOP_NOT_FOUND');
      return project.id;
    };
    const openDesktop = (id: string, item?: string) => {
      const name = id === 'captures' ? 'Captures' : desktop.get(id).name;
      if (item) desktop.item(id === 'captures' ? null : id, item);
      const tab = active();
      const target = tabs.find(tab => tab.state.desktop === id) ?? (tab && (!tab.view || !tab.committed && !tab.restore) && !tab.state.url && !tab.state.desktop && !tab.state.settings ? tab : newTab());
      target.state.desktop = id; target.state.desktopItem = item ?? null;
      target.restore = undefined; target.restoring = undefined;
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
        case 'reopen-tab': {
          const saved = takeClosed(savedSession, tabs.length, ownAddress);
          if (!saved) return;
          const target = restoredTab(saved); tabs.splice(groupBoundaryIndex(tabs.map(tab => tab.state), saved.position), 0, target); activate(target); break;
        }
        case 'create-tab-group': {
          const target = tabs.find(tab => tab.state.id === command.id);
          if (!target || target.retryDownload) throw new Error('Unknown tab');
          assignGroup(target, null);
          const group = { id: randomUUID(), name: '', color: GROUP_COLORS[nextGroupColor]!, icon: null, folded: false };
          nextGroupColor = (nextGroupColor + 1) % GROUP_COLORS.length;
          tabGroups.push(group); target.state.groupId = group.id; groupEditorId = group.id; window.webContents.focus(); break;
        }
        case 'add-tab-to-group': case 'remove-tab-from-group': {
          const target = tabs.find(tab => tab.state.id === command.id);
          if (!target || target.retryDownload) throw new Error('Unknown tab');
          const group = command.type === 'add-tab-to-group' ? tabGroups.find(group => group.id === command.group) : undefined;
          if (command.type === 'add-tab-to-group' && !group) throw new Error('Unknown tab group');
          assignGroup(target, group?.id ?? null);
          if (group && activeId === target.state.id) group.folded = false;
          break;
        }
        // Closing an editor whose group is already gone has nothing left to close.
        case 'close-tab-group-editor': if (groupEditorId === command.id) groupEditorId = null; break;
        case 'update-tab-group': case 'set-tab-group-folded': case 'open-tab-group-editor': {
          const group = tabGroups.find(group => group.id === command.id);
          if (!group) throw new Error('Unknown tab group');
          if (command.type === 'update-tab-group') {
            if (command.name !== undefined) group.name = command.name;
            if (command.color !== undefined) group.color = command.color;
            if (command.icon !== undefined) group.icon = command.icon;
          } else if (command.type === 'open-tab-group-editor') { groupEditorId = group.id; window.webContents.focus(); }
          else if (command.type === 'set-tab-group-folded') {
            if (command.folded && tab.state.groupId === group.id) {
              const nearest = nearestVisibleTab(tabs.map(tab => tab.state), tabGroups, tabs.indexOf(tab), group.id);
              if (nearest < 0 && tabs.length >= 200) throw new Error('Tab limit reached');
              if (nearest < 0) newTab(); else activate(tabs[nearest]!);
            }
            group.folded = command.folded;
          }
          break;
        }
        case 'home': {
          if (!tab.state.url) break;
          leaveFullscreen(tab);
          // A native blank entry keeps Chromium's page history and Back/Forward state intact.
          load(tab, 'about:blank'); window.webContents.focus(); break;
        }
        case 'reload-no-cache': if (contents && !tab.state.settings && !tab.state.desktop) { tab.state.error = null; contents.reloadIgnoringCache(); } break;
        case 'print': if (contents && isWebURL(tab.state.url) && !tab.state.error && !tab.state.settings && !tab.state.desktop) return new Promise<void>((resolve, reject) => {
          contents.print({}, (success, reason) => { if (success || reason === 'Print job canceled') resolve(); else reject(new Error('PRINT_FAILED')); });
        }); break;
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
        case 'save-capture-file': return (async () => {
          const bytes = desktop.image(null, command.id);
          if (!bytes) throw new Error('CAPTURE_FAILED');
          try {
            const choice = await dialog.showSaveDialog(window, { defaultPath: resolve(resolvedDownloadsFolder(settings, downloads).downloadsFolder, 'capture.png'), filters: [{ name: 'PNG', extensions: ['png'] }] });
            if (choice.canceled || !choice.filePath) return false;
            writeFileSync(choice.filePath, bytes); return true;
          } catch { throw new Error('CAPTURE_SAVE_FAILED'); }
        })();
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
          if (command.item.startsWith('extension:')) {
            pageMenu.invokeExtension(command.id, command.item, tab.state.id);
            window.webContents.send(IPC.contextMenu, null); break;
          }
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
        case 'focus-page': if (tab.state.url && !area.hidden && !tab.state.error) contents?.focus(); break;
        case 'fullscreen':
          if (tab.state.fullscreen) leaveFullscreen(tab);
          else { tab.state.fullscreen = true; window.setFullScreen(true); }
          break;
        case 'zoom': zoom(tab, command.delta); break;
        case 'bookmark': {
          if (!isWebURL(tab.state.url)) break;
          const link = favoriteLinks([...store.favorites.bar, ...store.favorites.other]).find(entry => entry.url === tab.state.url);
          if (link) deleteFavorite(link.id);
          else editFavorites(() => { addFavorite(store.favorites, 'bar', store.favorites.bar.length, tab.state.url, (tab.state.title || tab.state.url).replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 200)); });
          break;
        }
        case 'add-favorite':
          editFavorites(() => { addFavorite(store.favorites, command.parent, command.position, command.url, command.title); }); break;
        case 'create-favorite-folder':
          editFavorites(() => { createFavoriteFolder(store.favorites, command.parent, command.position, command.name); }); break;
        case 'rename-favorite': {
          const location = favoriteLocation(store.favorites, command.id);
          if (!location) throw new Error('FAVORITE_NOT_FOUND');
          editFavorites(() => {
            if (location.item.kind === 'folder') location.item.name = favoriteName(command.name);
            else location.item.title = favoriteTitle(command.name);
          }); break;
        }
        case 'move-favorite':
          editFavorites(() => { moveFavorite(store.favorites, command.id, command.parent, command.position); }); break;
        case 'delete-favorite': {
          deleteFavorite(command.id); break;
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
          else if (kept.kind === 'bookmarks') {
            const deleted = kept.deleted;
            editFavorites(() => { restoreFavorite(store.favorites, deleted); }); forget(); break;
          }
          else store.downloads = kept.entries;
          forget(); persist(); break;
        case 'rename-bookmark': {
          const entry = favoriteLinks([...store.favorites.bar, ...store.favorites.other]).find(entry => entry.url === command.url);
          if (!entry) throw new Error('FAVORITE_NOT_FOUND');
          editFavorites(() => { entry.title = favoriteTitle(command.title); }); break;
        }
        case 'delete-bookmark': {
          const entry = favoriteLinks([...store.favorites.bar, ...store.favorites.other]).find(entry => entry.url === command.url);
          if (!entry) throw new Error('FAVORITE_NOT_FOUND');
          deleteFavorite(entry.id); break;
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
      groupEditorId = null;
      screenCapture = undefined;
      invalidateCaptures(); desktop.forget();
      forget();
      const tab = active();
      if (tab) { leaveFullscreen(tab); page(tab.view)?.setIgnoreMenuShortcuts(true); page(tab.view)?.stopFindInPage('clearSelection'); tab.findRequest = undefined; tab.state.find = { active: 0, total: 0 }; }
    };
    const dispose = (discard = false) => {
      if (disposed) return;
      if (!discard) flushSession();
      clearTimeout(sessionWrite); sessionWrite = undefined;
      screenCapture = undefined;
      const attempt = (cleanup: () => void) => {
        if (!discard) { cleanup(); return; }
        try { cleanup(); } catch (error: unknown) { storageFailure(error); }
      };
      if (discard) disposed = true;
      invalidateCaptures();
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
      tabs.length = 0; items.clear(); for (const path of reserved) downloadPaths.delete(path); reserved.clear();
      if (discard) { clearTimeout(pendingWrite); pendingWrite = undefined; } else flush();
      attempt(() => webSession.removeListener('will-download', downloadHandler));
      detachSession();
      detachExtensions?.();
      detachExtensionWindow?.();
      if (privateWindow) desktop.dispose(true);
      requests.clear();
    };
    const detachExtensionWindow = extensions?.attachWindow?.({ window, current: () => isCurrent() && !disposed && !closing,
      // Give dormant and chrome tabs stable ids only when extension code can query them. Their pages stay unloaded.
      materializeTabs: () => { for (const tab of tabs) ensureView(tab); layout(); },
      updateTab: (contents, url) => { const tab = tabs.find(tab => page(tab.view) === contents); if (!tab) throw new Error('Unknown extension tab'); load(tab, url); },
      createTab: details => {
        if (details.url && !isAllowedURL(details.url) && !isExtensionURL(webSession, details.url)) throw new Error('Invalid extension tab URL');
        const foreground = details.active !== false;
        if (foreground && !isCurrent()) switchProfile(profile.id);
        const tab = newTab(details.url, foreground); ensureView(tab);
        if (details.index !== undefined) {
          tabs.splice(tabs.indexOf(tab), 1); tabs.splice(Math.max(0, Math.min(tabs.length, details.index)), 0, tab); update();
        }
        return tab.view!.webContents;
      },
      selectTab: contents => { const tab = tabs.find(tab => page(tab.view) === contents); if (!tab) return; if (!isCurrent()) switchProfile(profile.id); activate(tab); update(); },
      removeTab: contents => { const tab = tabs.find(tab => page(tab.view) === contents); if (tab) closeTab(tab); },
      assignTabDetails: (details, contents) => {
        const tab = tabs.find(tab => page(tab.view) === contents); if (!tab) return;
        details.index = tabs.indexOf(tab); details.active = tab.state.id === activeId; details.discarded = Boolean(tab.restore);
        details.title = tab.state.title; details.url = tab.state.url || 'about:blank';
      },
      createWindow: async details => { if (!options.extensionWindow) throw new Error('Window creation is unavailable'); return options.extensionWindow(profile.id, details, window); },
    });
    for (const { tab: saved, active: selected } of lazySession(savedSession, privateWindow || options.fresh ? 'new-page' : settings.onStart)) {
      const tab = restoredTab(saved); tabs.push(tab); if (selected) activeId = tab.state.id;
      if (extensions?.hasEnabled?.()) ensureView(tab);
    }
    const assertMove = (tab: Tab) => {
      if (disposed || closing || window.isDestroyed() || shared.quitting) throw new Error('Profile is closed');
      if (!tabs.includes(tab)) throw new Error('Unknown tab');
      if (tabs.length <= 1 || !movable(tab)) throw new Error('Tab cannot be moved');
    };
    const assertAccept = (tab: Tab) => {
      if (disposed || closing || window.isDestroyed()) throw new Error('Profile is closed');
      if (tabs.length >= 200) throw new Error('Tab limit reached');
      if (tabs.some(entry => entry.state.id === tab.state.id)) throw new Error('Invalid tab destination');
    };
    const attachView = (tab: Tab) => { if (tab.view) window.contentView.addChildView(tab.view); };
    const detachView = (tab: Tab) => { if (tab.view && !window.isDestroyed()) window.contentView.removeChildView(tab.view); };
    const bindTab = (tab: Tab) => { tab.host = host; if (tab.view && page(tab.view)) contentsSetup(tab, tab.view); };
    const transferTab = (tab: Tab, target: TabDestination): void => {
      assertMove(tab); target.assertAccept(tab);
      const index = tabs.indexOf(tab), previous = activeId, previousGroup = tab.state.groupId, destinationActive = target.active()?.state.id ?? '';
      leaveFullscreen(tab);
      try {
        detachView(tab); target.attachView(tab);
        tabs.splice(index, 1); target.tabs.push(tab);
        tab.state.groupId = null;
        if (activeId === tab.state.id) activeId = tabs[nearestVisibleTab(tabs.map(tab => tab.state), tabGroups, Math.min(index, tabs.length - 1))]?.state.id ?? '';
        target.bindTab(tab); target.activate(tab);
      } catch (error) {
        const destinationIndex = target.tabs.indexOf(tab);
        if (destinationIndex >= 0) target.tabs.splice(destinationIndex, 1);
        if (!tabs.includes(tab)) tabs.splice(index, 0, tab);
        tab.state.groupId = previousGroup; activeId = previous; target.select(destinationActive);
        target.detachView(tab); attachView(tab); bindTab(tab);
        layout(); target.layout(); throw error;
      }
      pruneGroups(); if (!activeId) newTab();
      for (const [id, request] of requests) if (request.tab === tab) { target.requests.set(id, request); requests.delete(id); }
      for (const [id, binding] of downloadBindings) if (binding.tab === tab) {
        const item = items.get(id);
        if (item) { target.downloadOwner.items.set(id, item); items.delete(id); }
        target.downloadOwner.reserved.add(binding.path); reserved.delete(binding.path);
        if (trustedDownloads.has(id)) { target.downloadOwner.trusted.set(id, binding.path); trustedDownloads.delete(id); }
        binding.owner = target.downloadOwner; target.downloadBindings.set(id, binding); downloadBindings.delete(id);
      }
      permissions.transfer(tab.state.id, target.permissions);
      invalidateMenu(tab.state.id); invalidateCaptures();
      update(); target.update(); flushSession(); target.flushSession();
    };
    return { state, tabs, active, page, run, dispatchShortcut, layout, newTab, suspend, dispose, flush, persist, persistSession, reserved, webSession, replaceViews, applyDarkCSS, desktop, resetCounts, resetCookies, clearData, importBrowserData, clearOnClose, stopForClear, assertMove, assertAccept, attachView, detachView, bindTab, activate, select: (id: string) => { activeId = id; }, transferTab, requests, permissions, downloadBindings, downloadOwner, update, flushSession, ensureView };


  }
  handleChrome(window, IPC.state, (event, ...args: unknown[]) => {
    validateSender(event, window.webContents);
    if (args.length) throw new Error('Unexpected state argument');
    return state();
  });
  handleChrome(window, IPC.favicon, (event, ...args: unknown[]) => {
    validateSender(event, window.webContents);
    const [id, hash] = args;
    if (args.length !== 2 || typeof id !== 'string' || !id || id.length > 128 || id.includes('\0') || typeof hash !== 'string' || !/^[a-f0-9]{32}$/.test(hash)) throw new Error('Invalid favicon arguments');
    const tab = current().tabs.find(tab => tab.state.id === id);
    if (!tab) throw new Error('Unknown tab');
    return tab.state.favicon === hash ? tab.faviconBytes ?? null : null;
  });
  handleChrome(window, IPC.project, (event, ...args: unknown[]) => {
    validateSender(event, window.webContents);
    if (args.length !== 1 || !isProfileId(args[0])) throw new Error('Invalid project arguments');
    return current().desktop.content(args[0]);
  });
  handleChrome(window, IPC.captureImage, (event, ...args: unknown[]) => {
    validateSender(event, window.webContents);
    if (args.length !== 2 || args[0] !== null && !isProfileId(args[0]) || !isProfileId(args[1])) throw new Error('Invalid capture image arguments');
    return current().desktop.image(args[0], args[1]);
  });
  handleChrome(window, IPC.captures, (event, ...args: unknown[]) => {
    validateSender(event, window.webContents);
    if (args.length) throw new Error('Invalid captures arguments');
    return current().desktop.captures();
  });
  handleChrome(window, IPC.capture, async (event, ...args: unknown[]) => {
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
  handleChrome(window, IPC.command, (event, ...args: unknown[]) => {
    validateSender(event, window.webContents);
    if (args.length !== 1) throw new Error('Invalid command arguments');
    if (deleting) throw new Error('Profile deletion is in progress');
    return run(validateCommand(args[0], new Set(registry.profiles.map(profile => profile.id)), current().desktop.list(), current().desktop.captureList(), current().state().store.favorites));
  });
  handleChrome(window, IPC.contentArea, (event, ...args: unknown[]) => {
    validateSender(event, window.webContents);
    if (args.length !== 1) throw new Error('Invalid content area arguments');
    const next = validateContentArea(args[0]);
    // A hidden page view keeps the keyboard, so an overlay that opened on its own, such as a permission prompt, would get no keys.
    const covering = next.hidden && !area.hidden;
    area = next; layout();
    if (covering && window.isFocused()) window.webContents.focus();
  });
  const flush = () => { for (const runtime of runtimes.values()) { runtime.flush(); runtime.desktop.flush(); } };
  const needsClearOnClose = () => registry.profiles.some(profile => {
    const store = shared.profiles.get(profile.id)?.store ?? readStore(profileStorePath(userData, profile.id), safeStorage);
    return store.clearHistoryOnClose || store.clearCacheOnClose;
  });
  const finishClearing = () => {
    if (!shared.quitting) {
      for (const owner of shared.owners.values()) { owner.flush(); owner.stop(); }
      for (const owner of shared.owners.values()) if (owner.privateWindow) owner.releasePrivate();
      shared.quitting = Promise.allSettled(registry.profiles.map(async profile => {
        const storePath = profileStorePath(userData, profile.id);
        const store = shared.profiles.get(profile.id)?.store ?? readStore(storePath, safeStorage);
        try { clearStoredHistoryOnClose(storePath, store, safeStorage, writeStore); } catch { storageFailure(new Error('History clearing failed')); }
        if (store.clearCacheOnClose) try { await session.fromPartition(profile.partition).clearCache(); } catch { storageFailure(new Error('Cache clearing failed')); }
      })).then(async () => {
        await Promise.allSettled([...shared.privateCleanup]);
        shared.quitCleared = true;
      });
    }
    return shared.quitting;
  };
  const beforeQuit = (event?: Electron.Event) => {
    for (const owner of shared.owners.values()) owner.flush();
    if (!shared.quitCleared) {
      event?.preventDefault();
      const clearing = finishClearing();
      if (!shared.quitRequested) { shared.quitRequested = true; void clearing.then(() => app.quit()); }
    }
  };
  window.on('close', (event: Electron.Event) => {
    flush();
    if (shared.owners.size === 1 && !shared.quitCleared && (needsClearOnClose() || privateWindow || shared.privateCleanup.size)) {
      event.preventDefault();
      if (privateWindow) cleanupPrivate();
      void finishClearing().then(() => window.close());
    }
  });
  // A destroyed window can no longer hand out its webContents, so the handlers' key is kept from now.
  const chromeContents = window.webContents;
  window.on('closed', () => {
    cancelExtensionDecision();
    closing = true; invalidateMenu();
    blocker.stop();
    nativeTheme.removeListener('updated', systemDarkPages);
    for (const runtime of runtimes.values()) runtime.dispose();
    shared.owners.delete(windowId);
    if (!privateWindow && shared.owners.size && !shared.quitting) for (const profile of registry.profiles) {
      const data = shared.profiles.get(profile.id), path = resolve(dirname(profileStorePath(userData, profile.id)), 'session.json');
      const status = data?.sessionStatus ?? { readError: false, memoryOnly: false };
      const saved = data?.sessions ?? readWindowSessions(path, safeStorage, url => url.startsWith('horizon://desktop/'), status);
      if (!saved.windows.some(window => window.id === windowId)) continue;
      saved.windows = saved.windows.filter(window => window.id !== windowId);
      if (!status.memoryOnly) try { writeWindowSessions(path, saved, safeStorage); } catch { registryError = true; }
    }
    if (privateWindow) cleanupPrivate();
    if (!shared.owners.size) { for (const data of shared.profiles.values()) data.desktop.dispose(); groups.delete(userData); }
    app.removeListener('before-quit', beforeQuit);
    window.removeListener('focus', refreshDefaultBrowser);
    unsubscribeUpdates?.();
    const handlers = chromeHandlers.get(chromeContents); chromeHandlers.delete(chromeContents);
    for (const channel of handlers?.keys() ?? []) if (![...chromeHandlers.values()].some(map => map.has(channel))) ipcMain.removeHandler(channel);
  });
  let privateReleased = false;
  const cleanupPrivate = () => {
    if (privateReleased) return;
    privateReleased = true;
    for (const runtime of runtimes.values()) runtime.dispose();
    if (--shared.privateCount) return;
    const partition = shared.privatePartition!; shared.privatePartition = undefined;
    const target = session.fromPartition(partition);
    const cleanup = (async () => {
      for (const clear of [() => target.clearStorageData(), () => target.closeAllConnections(), () => target.clearCache(), () => target.clearAuthCache(), () => target.clearCodeCaches({})]) {
        try { await clear(); } catch { storageFailure(new Error('Private session clearing failed')); }
      }
    })();
    shared.privateCleanup.add(cleanup); void cleanup.finally(() => shared.privateCleanup.delete(cleanup));
  };
  const owner: BrowserOwner = { window, privateWindow, activeProfile: () => selectedProfile, publish, flush, stop: () => { closing = true; blocker.stop(); for (const runtime of runtimes.values()) runtime.stopForClear(); },
    releasePrivate: cleanupPrivate,
    persistSessions: () => { for (const runtime of runtimes.values()) runtime.persistSession(); },
    settingsChanged: () => {
      updateDarkPages();
      for (const runtime of runtimes.values()) {
        if (blockingEnabled !== settings.blockAds) runtime.resetCounts();
        else if (cookiesBlocked !== settings.blockThirdPartyCookies) runtime.resetCookies();
      }
      blockingEnabled = settings.blockAds; cookiesBlocked = settings.blockThirdPartyCookies;
    },
    disposeProfile: id => { runtimes.get(id)?.dispose(true); runtimes.delete(id); },
    registryChanged: () => {
      registry = shared.registry;
      for (const id of runtimes.keys()) if (!registry.profiles.some(profile => profile.id === id)) owner.disposeProfile(id);
      if (!registry.profiles.some(profile => profile.id === selectedProfile)) {
        if (privateWindow) { window.close(); return; }
        selectedProfile = registry.activeId;
        const next = runtimeFor(registry.profiles.find(profile => profile.id === selectedProfile)!); if (!next.active()) next.newTab();
      }
      layout(); publish();
    }, runtime: id => runtimeFor(registry.profiles.find(profile => profile.id === id)!) };
  shared.owners.set(windowId, owner);
  app.on('before-quit', beforeQuit);
  const initial = runtimeFor(registry.profiles.find(profile => profile.id === selectedProfile)!);
  // Electron runs menu accelerators only after Chromium returns an unhandled page key.
  window.setMenu(Menu.buildFromTemplate(browserShortcutAccelerators().map(({ accelerator, shortcut }) => ({
    label: accelerator, accelerator, visible: false,
    click: (_item, target) => {
      if (target !== window || closing || window.isDestroyed()) return;
      const runtime = current();
      if (runtime.page(runtime.active()?.view)?.isFocused()) runtime.dispatchShortcut(shortcut);
    },
  }))));
  initial.persist();
  if (options.extensionURLs?.length) for (const url of options.extensionURLs) initial.newTab(url, false);
  if (!initial.tabs.length && !options.empty) initial.newTab(); else layout();
  if (!privateWindow) {
    const extensions = existingExtensions(initial.webSession)!;
    void extensions.ready.then(() => extensions.startUpdates()).catch(() => { publish(); });
  }
  void blocker.start();
  refreshDefaultBrowser();
  const moveTab = (id: string, destinationId: string) => {
    if (closing || shared.quitting || window.isDestroyed()) throw new Error('Profile is closed');
    const destination = shared.owners.get(destinationId);
    if (!destination || destination === owner || destination.privateWindow !== privateWindow) throw new Error('Invalid tab destination');
    const source = [...runtimes.values()].find(runtime => runtime.tabs.some(tab => tab.state.id === id));
    if (!source) throw new Error('Unknown tab');
    const profile = registry.profiles.find(profile => runtimes.get(profile.id) === source)!;
    if (destination.activeProfile() !== profile.id) throw new Error('Tab profile mismatch');
    const target = destination.runtime(profile.id) as ReturnType<typeof createRuntime>;
    if (target.webSession !== source.webSession) throw new Error('Tab session mismatch');
    source.transferTab(source.tabs.find(tab => tab.state.id === id)!, target);
  };
  return { layout, flush, windowId, privateWindow, activeProfile: () => selectedProfile, registry: () => shared.registry, settingsChanged: () => { for (const owner of shared.owners.values()) owner.settingsChanged(); }, openLaunch: (url: string) => { if (!privateWindow && (isWebURL(url) || isLocalHTMLURL(url))) current().newTab(url, true, undefined, true); },
    extensionsChanged: publish, moveTab };
}
