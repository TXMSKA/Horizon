import { ipcMain, nativeImage, session } from 'electron';
import type { BrowserWindow, BaseWindow } from 'electron';
import type { IpcMainInvokeEvent, Session, WebContents } from 'electron';
import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, rmSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { store } from './extension-download';
import type { ExtensionState, ExtensionWarning, Profile } from '../src/shared/api';
import { extensionAsset, extensionDirectory, extensionId, extensionStatePath, isWebStoreURL, manifestAccess, unsupportedPermissions } from './extension-policy';
import { readStoreFile, writeStoreFile } from './store';
import { removeProfileDirectory } from './profiles';
import { createExtensionRuntime, registerAlarms, runtimeDetails } from './extension-runtime';
import type { ActionDetails } from './extension-runtime';
import { browserShortcut } from '../src/shared/shortcuts';

interface ExtensionWindow {
  window: BrowserWindow;
  current(): boolean;
  materializeTabs(): void;
  createTab(details: chrome.tabs.CreateProperties): WebContents;
  updateTab(contents: WebContents, url: string): void;
  selectTab(contents: WebContents): void;
  removeTab(contents: WebContents): void;
  assignTabDetails(details: chrome.tabs.Tab, contents: WebContents): void;
  createWindow(details: chrome.windows.CreateData): Promise<BrowserWindow>;
}

interface InstalledExtension { id: string; versionDirectory: string; enabled: boolean; pinned: boolean }
const { downloadExtension, installChromeWebStore, installExtension } = store;
type ExtensionInstallDetails = Parameters<NonNullable<NonNullable<Parameters<typeof installChromeWebStore>[0]>['beforeInstall']>>[0];
interface ExtensionOwner { contents: WebContents; warning(warning: Omit<ExtensionWarning, 'requestId'>): Promise<boolean> }
const managers = new WeakMap<Session, ReturnType<typeof createExtensions>>();
const profileDirectories = new WeakMap<Session, string>();
function registerStore(options: NonNullable<Parameters<typeof installChromeWebStore>[0]>): Promise<void> {
  const handle = ipcMain.handle;
  // The pinned package registers synchronously before its first await. Wrap those registrations so its prefix origin check cannot widen ours.
  ipcMain.handle = (channel, listener) => handle.call(ipcMain, channel, (event, ...args: unknown[]) => {
    const manager = managers.get(event.sender.session);
    if (!manager?.ownsStore(event) || args.length > 4 || JSON.stringify(args).length > 1024 * 1024) throw new Error('Untrusted store sender');
    if (channel === 'chromeWebstore.setStoreLogin') return false;
    if (channel === 'chromeWebstore.getExtensionStatus') {
      if (!extensionId(args[0])) throw new Error('Invalid store extension');
      const entry = manager.list().find(entry => entry.id === args[0]);
      if (entry) return entry.enabled ? 'enabled' : 'disabled';
    }
    if (channel === 'chrome.management.getAll') return manager.storeList();
    if (channel === 'chromeWebstore.beginInstall') {
      const details = args[0] as { id?: unknown; iconUrl?: unknown } | null;
      if (!details || !extensionId(details.id) || typeof details.iconUrl !== 'string') throw new Error('Invalid store install');
      const icon = new URL(details.iconUrl);
      if (icon.protocol !== 'https:' || icon.username || icon.password || !['googleusercontent.com', 'gstatic.com'].some(host => icon.hostname === host || icon.hostname.endsWith(`.${host}`))) throw new Error('Invalid store icon');
    }
    if (channel === 'chrome.management.setEnabled') {
      if (!extensionId(args[0]) || typeof args[1] !== 'boolean') throw new Error('Invalid store extension');
      return manager.setEnabled(args[0], args[1]).then(() => true);
    }
    if (channel === 'chrome.management.uninstall') {
      if (!extensionId(args[0])) throw new Error('Invalid store extension');
      return manager.remove(args[0]).then(() => 'success');
    }
    const result = listener(event, ...args);
    return channel === 'chromeWebstore.beginInstall' ? Promise.resolve(result).finally(() => manager.finishInstall((args[0] as { id: string }).id)) : result;
  });
  try { return installChromeWebStore(options); }
  finally { ipcMain.handle = handle; }
}
export function profileExtensions(userData: string, profile: Profile, target: Session, changed: () => void) {
  const directory = extensionDirectory(userData, profile);
  if (target !== session.fromPartition(profile.partition) || !target.isPersistent() || profileDirectories.has(target) && profileDirectories.get(target) !== directory) throw new Error('EXTENSIONS_UNAVAILABLE');
  for (const path of [resolve(userData, 'profiles'), resolve(directory, '..'), directory]) if (existsSync(path) && lstatSync(path).isSymbolicLink()) throw new Error('EXTENSION_PATH_INVALID');
  let manager = managers.get(target);
  if (!manager) { manager = createExtensions(directory, target, changed); managers.set(target, manager); profileDirectories.set(target, directory); }
  return manager;
}
export function existingExtensions(target: Session) { return managers.get(target); }

function createExtensions(directory: string, target: Session, changed: () => void) {
  // Inactive profiles load background code before browser permission queues exist. Keep native device access denied from the first load.
  target.setPermissionRequestHandler((_contents, _permission, answer) => answer(false));
  target.setPermissionCheckHandler(() => false); target.setDevicePermissionHandler(() => false);
  const statePath = extensionStatePath(directory), owners = new Set<ExtensionOwner>();
  let entries: InstalledExtension[] = [], storageError = false, updating = false, stopped = false, checkedAtStart = false;
  const errors = new Set<string>();
  const pendingInstalls = new Set<string>(), windows = new Set<ExtensionWindow>();
  const windowFor = (window?: BaseWindow) => [...windows].find(owner => !owner.window.isDestroyed() && (window ? owner.window === window : owner.current()));
  let notifying = false;
  const activeTabs = new Map<BaseWindow, WebContents>();
  const chrome = createExtensionRuntime({ license: 'GPL-3.0', session: target,
    createTab: async details => {
      const owner = details.windowId === undefined ? windowFor() : [...windows].find(owner => owner.window.id === details.windowId && !owner.window.isDestroyed());
      if (!owner) throw new Error('EXTENSIONS_UNAVAILABLE');
      return [owner.createTab(details), owner.window];
    },
    selectTab: (contents, window) => { activeTabs.set(window, contents); if (!notifying) windowFor(window)?.selectTab(contents); },
    updateTab: (contents, url) => {
      const owner = windowFor(runtimeDetails(chrome).ctx.store.tabToWindow.get(contents));
      if (!owner) throw new Error('EXTENSIONS_UNAVAILABLE'); owner.updateTab(contents, url);
    },
    removeTab: (contents, window) => { if (!notifying) windowFor(window)?.removeTab(contents); },
    assignTabDetails: (details, contents) => windowFor(runtimeDetails(chrome).ctx.store.tabToWindow.get(contents))?.assignTabDetails(details, contents),
    createWindow: async details => { if (details.incognito) throw new Error('EXTENSIONS_UNAVAILABLE'); const owner = windowFor(); if (!owner) throw new Error('EXTENSIONS_UNAVAILABLE'); return owner.createWindow(details); },
    removeWindow: window => { if (window.isDestroyed()) return; const owner = windowFor(window); if (!owner) throw new Error('EXTENSIONS_UNAVAILABLE'); owner.window.close(); },
    // Electron cannot enforce newly requested host grants. Keep the install decision authoritative.
    requestPermissions: async () => false,
  });
  const clearAlarms = registerAlarms(chrome, target);
  chrome.on('browser-action-updated', changed);
  const actions = runtimeDetails(chrome).api.browserAction;
  const closePopup = (id?: string) => { if (!id || actions.popup?.extensionId === id) { actions.popup?.destroy(); actions.popup = undefined; } };
  const trackTab = (contents: WebContents, window: BrowserWindow) => {
    const tracked = runtimeDetails(chrome).ctx.store;
    notifying = true;
    try {
      // A drag transfers the same WebContents. Reparent it without asking Horizon to close it.
      if (tracked.tabs.has(contents)) { tracked.tabToWindow.set(contents, window); tracked.addWindow(window); contents.emit('tab-updated'); }
      else chrome.addTab(contents, window);
    } finally { notifying = false; }
  };
  const selectTab = (contents: WebContents) => {
    const window = runtimeDetails(chrome).ctx.store.tabToWindow.get(contents);
    if (!window || activeTabs.get(window) === contents) return;
    activeTabs.set(window, contents); notifying = true; try { chrome.selectTab(contents); } finally { notifying = false; }
  };
  const untrackTab = (contents: WebContents) => { notifying = true; try { chrome.removeTab(contents); } finally { notifying = false; } };
  const attachWindow = (owner: ExtensionWindow) => { windows.add(owner); return () => { windows.delete(owner); activeTabs.delete(owner.window); closePopup(); }; };
  const actionFor = (id: string, contents?: WebContents) => {
    const action = actions.actionMap.get(id); if (!action) return undefined;
    const info: ActionDetails = { ...action, ...(contents ? action.tabs[contents.id] : {}) };
    let icon: number[] | null = null;
    try {
      const extension = target.extensions.getExtension(id)!;
      const path = typeof info.icon?.path === 'string' ? info.icon.path : Object.values(info.icon?.path ?? {})[0];
      let image;
      if (path) {
        const asset = extensionAsset(extension.path, path.replace(/^\//, '')), file = lstatSync(asset);
        if (file.isFile() && !file.isSymbolicLink() && file.size <= 1024 * 1024) image = nativeImage.createFromPath(asset);
      } else {
        const data = typeof info.icon?.imageData === 'string' ? info.icon.imageData : Object.values(info.icon?.imageData ?? {})[0];
        if (data?.startsWith('data:image/png;base64,') && data.length <= 1024 * 1024) image = nativeImage.createFromDataURL(data);
      }
      if (image && !image.isEmpty()) icon = [...image.resize({ width: 28, height: 28 }).toPNG()];
    } catch { /* Invalid dynamic icons retain the installed icon. */ }
    return { title: String(info.title ?? '').slice(0, 1024), badge: String(info.text ?? '').slice(0, 32), icon };
  };
  const commandInput = (input: Electron.Input, contents: WebContents) => {
    if (input.type !== 'keyDown' || input.isAutoRepeat || browserShortcut(input)) return false;
    for (const extension of target.extensions.getAllExtensions()) {
      const commands = extension.manifest.commands as Record<string, { suggested_key?: Record<string, string> }> | undefined;
      for (const [name, details] of Object.entries(commands ?? {})) {
        const shortcut = details.suggested_key?.[process.platform === 'darwin' ? 'mac' : process.platform === 'win32' ? 'windows' : 'linux'] ?? details.suggested_key?.default;
        if (!shortcut) continue;
        const parts = shortcut.toLowerCase().split('+'), key = parts.pop();
        if (key !== input.key.toLowerCase() || parts.includes('ctrl') !== input.control || parts.includes('alt') !== input.alt || parts.includes('shift') !== input.shift || parts.includes('command') !== input.meta) continue;
        if (name === '_execute_action' || name === '_execute_browser_action') actions.activateClick({ extensionId: extension.id, tabId: contents.id, alignment: 'bottom left', anchorRect: { x: 0, y: 0, width: 32, height: 32 } });
        else runtimeDetails(chrome).ctx.router.sendEvent(extension.id, 'commands.onCommand', name);
        return true;
      }
    }
    return false;
  };
  let work: Promise<unknown> = Promise.resolve();
  const queue = <T>(action: () => Promise<T>): Promise<T> => {
    const next = work.then(() => { if (stopped) throw new Error('EXTENSIONS_UNAVAILABLE'); return action(); });
    work = next.catch(() => {}); return next;
  };
  try {
    if (existsSync(statePath)) {
      const value = readStoreFile(statePath);
      if (!value || typeof value !== 'object' || !('version' in value) || value.version !== 1 || !('entries' in value) || !Array.isArray(value.entries) || value.entries.length > 100) throw new Error('Invalid extension state');
      const ids = new Set<string>();
      for (const entry of value.entries as InstalledExtension[]) {
        if (!extensionId(entry.id) || ids.has(entry.id) || !/^\d+(?:\.\d+){0,3}_0$/.test(entry.versionDirectory) || typeof entry.enabled !== 'boolean' || typeof entry.pinned !== 'boolean') throw new Error('Invalid extension state');
        ids.add(entry.id);
      }
      entries = value.entries;
    }
  } catch { storageError = true; }
  const save = () => {
    if (stopped || storageError) throw new Error('EXTENSION_STORAGE_FAILED');
    try { writeStoreFile(statePath, { version: 1, entries }); }
    catch { storageError = true; changed(); throw new Error('EXTENSION_STORAGE_FAILED'); }
  };
  const pathFor = (entry: InstalledExtension) => {
    const path = extensionAsset(directory, `${entry.id}/${entry.versionDirectory}`);
    for (const part of [resolve(directory, '..'), directory, resolve(directory, entry.id), path]) if (existsSync(part) && lstatSync(part).isSymbolicLink()) throw new Error('EXTENSION_PATH_INVALID');
    return path;
  };
  const manifestFor = (entry: InstalledExtension): Record<string, unknown> => JSON.parse(readFileSync(resolve(pathFor(entry), 'manifest.json'), 'utf8')) as Record<string, unknown>;
  const localized = (manifest: Record<string, unknown>, path: string, key: string) => {
    const value = typeof manifest[key] === 'string' ? manifest[key] : '';
    const message = value.match(/^__MSG_(.+)__$/)?.[1];
    if (!message || typeof manifest.default_locale !== 'string' || !/^[\w-]+$/.test(manifest.default_locale)) return value.slice(0, 4096);
    try {
      const messages = JSON.parse(readFileSync(resolve(path, '_locales', manifest.default_locale, 'messages.json'), 'utf8')) as Record<string, { message?: string }>;
      return (messages[message]?.message ?? value).slice(0, 4096);
    } catch { return value; }
  };
  const list = (contents?: WebContents): ExtensionState[] => entries.map(entry => {
    try {
      const path = pathFor(entry), manifest = manifestFor(entry);
      const icons = manifest.icons as Record<string, string> | undefined;
      const iconPath = icons?.['32'] ?? icons?.['48'] ?? icons?.['128'] ?? Object.values(icons ?? {})[0];
      let icon: number[] | null = null;
      if (iconPath) {
        try {
          const asset = extensionAsset(path, iconPath), file = lstatSync(asset);
          if (file.isFile() && !file.isSymbolicLink() && file.size <= 1024 * 1024) {
            const image = nativeImage.createFromPath(asset); if (!image.isEmpty()) icon = [...image.resize({ width: 32, height: 32 }).toPNG()];
          }
        } catch { /* A missing optional icon retains the neutral badge. */ }
      }
      return { ...entry, name: target.extensions.getExtension(entry.id)?.name ?? localized(manifest, path, 'name'), description: localized(manifest, path, 'description'), version: String(manifest.version), icon,
        action: entry.enabled ? actionFor(entry.id, contents) : undefined, unsupported: unsupportedPermissions(manifest), permissions: manifestAccess(manifest), failed: errors.has(entry.id) };
    } catch { return { ...entry, name: entry.id, description: '', version: '', icon: null, unsupported: [], permissions: [], failed: true }; }
  });
  const storeList = () => list().map(entry => ({ id: entry.id, name: entry.name, description: entry.description, version: entry.version, enabled: entry.enabled, mayDisable: true, type: 'extension', installType: 'normal', permissions: entry.permissions.filter(permission => !permission.includes('://') && permission !== '<all_urls>'), hostPermissions: entry.permissions.filter(permission => permission.includes('://') || permission === '<all_urls>') }));
  const startWorker = async (extension: Electron.Extension) => {
    if (extension.manifest.manifest_version === 3 && extension.manifest.background?.service_worker) {
      // The first start of a newly loaded worker can abort while Chromium is still registering it; a short retry succeeds.
      for (let attempt = 0; ; attempt++) {
        try { await target.serviceWorkers.startWorkerForScope(`chrome-extension://${extension.id}/`); return; }
        catch { if (attempt >= 5) { errors.add(extension.id); return; } await new Promise(done => setTimeout(done, 500 * (attempt + 1))); }
      }
    }
  };
  const load = async (entry: InstalledExtension) => {
    const extension = await target.extensions.loadExtension(pathFor(entry), { allowFileAccess: false });
    if (extension.id !== entry.id) { target.extensions.removeExtension(extension.id); throw new Error('EXTENSION_ID_MISMATCH'); }
    errors.delete(entry.id); await startWorker(extension); return extension;
  };
  const attach = (owner: ExtensionOwner) => { owners.add(owner); return () => owners.delete(owner); };
  const ownerFor = (contents?: WebContents) => [...owners].find(owner => !owner.contents.isDestroyed() && (!contents || owner.contents === contents));
  const ownsStore = (event: IpcMainInvokeEvent) => !stopped && !!ownerFor(event.sender) && !event.sender.isDestroyed() && event.senderFrame === event.sender.mainFrame && !!event.senderFrame && isWebStoreURL(event.senderFrame.url);
  const prepare = async (id: string, owner: ExtensionOwner) => {
    if (!extensionId(id) || entries.length >= 100 || storageError) throw new Error('EXTENSION_INSTALL_FAILED');
    const staging = resolve(directory, '.pending', randomUUID());
    mkdirSync(staging, { recursive: true, mode: 0o700 });
    try {
      const path = await downloadExtension(id, staging);
      const manifest = JSON.parse(readFileSync(resolve(path, 'manifest.json'), 'utf8')) as Record<string, unknown>;
      if (!/^\d+(?:\.\d+){0,3}$/.test(String(manifest.version))) throw new Error('EXTENSION_INSTALL_FAILED');
      const warning = { id, name: localized(manifest, path, 'name'), unsupported: unsupportedPermissions(manifest), permissions: manifestAccess(manifest) };
      if (!await owner.warning(warning) || stopped || !owners.has(owner) || owner.contents.isDestroyed()) return false;
      if (!entries.some(entry => entry.id === id)) removeProfileDirectory(directory, id);
      const parent = resolve(directory, id), destination = resolve(parent, basename(path));
      mkdirSync(parent, { recursive: true, mode: 0o700 });
      if (lstatSync(parent).isSymbolicLink()) throw new Error('EXTENSION_PATH_INVALID');
      if (!existsSync(destination)) renameSync(path, destination);
      return true;
    } finally { rmSync(staging, { recursive: true, force: true }); }
  };
  const beforeInstall = async (details: ExtensionInstallDetails) => {
    const owner = [...owners].find(owner => !owner.contents.isDestroyed() && owner.contents.mainFrame === details.frame);
    if (!owner || details.frame.isDestroyed() || !isWebStoreURL(details.frame.url) || !extensionId(details.id) || entries.some(entry => entry.id === details.id) || pendingInstalls.has(details.id) || stopped) return { action: 'deny' as const };
    pendingInstalls.add(details.id);
    try { const allow = await queue(() => prepare(details.id, owner)) && !details.frame.isDestroyed() && isWebStoreURL(details.frame.url); if (!allow) pendingInstalls.delete(details.id); return { action: allow ? 'allow' as const : 'deny' as const }; }
    catch { pendingInstalls.delete(details.id); return { action: 'deny' as const }; }
  };
  const installed = (_event: Electron.Event, extension: Electron.Extension) => {
    if (stopped || !extensionId(extension.id) || !extension.path.startsWith(`${directory}/`) && !extension.path.startsWith(`${directory}\\`)) return;
    pendingInstalls.delete(extension.id);
    let entry = entries.find(entry => entry.id === extension.id);
    if (!entry) { entry = { id: extension.id, versionDirectory: basename(extension.path), enabled: true, pinned: false }; entries.push(entry); }
    try { save(); } catch { errors.add(extension.id); target.extensions.removeExtension(extension.id); }
    for (const owner of windows) owner.materializeTabs();
    changed(); void startWorker(extension).then(changed);
  };
  target.extensions.on('extension-loaded', installed);
  // The vendor preload uses a hostname prefix and runs in every frame. The build wraps it with an exact main-frame guard.
  const registration = registerStore({ session: target, extensionsPath: directory, loadExtensions: false, autoUpdate: false, beforeInstall });
  target.unregisterPreloadScript('electron-chrome-web-store');
  target.registerPreloadScript({ id: 'horizon-web-store', type: 'frame', filePath: resolve(__dirname, 'store-preload.js') });
  const ready = registration.then(async () => {
    for (const entry of entries) if (entry.enabled && !stopped) try { await load(entry); } catch { errors.add(entry.id); }
    changed();
  });
  const setEnabled = (id: string, enabled: boolean) => queue(async () => {
    await ready;
    const entry = entries.find(entry => entry.id === id); if (!entry) throw new Error('EXTENSION_NOT_FOUND');
    const previous = entry.enabled;
    entry.enabled = enabled;
    try { save(); if (enabled) await load(entry); else { closePopup(id); target.extensions.removeExtension(id); } }
    catch (error) { entry.enabled = previous; try { save(); } catch { /* A failed disk remains visibly unavailable. */ } throw error; }
    changed();
  });
  const setPinned = (id: string, pinned: boolean) => queue(async () => {
    const entry = entries.find(entry => entry.id === id); if (!entry) throw new Error('EXTENSION_NOT_FOUND');
    const previous = entry.pinned; entry.pinned = pinned;
    try { save(); } catch (error) { entry.pinned = previous; throw error; } changed();
  });
  const remove = (id: string) => queue(async () => {
    if (!entries.some(entry => entry.id === id)) throw new Error('EXTENSION_NOT_FOUND');
    const previous = entries; entries = entries.filter(entry => entry.id !== id);
    try { save(); } catch (error) { entries = previous; throw error; }
    closePopup(id); target.extensions.removeExtension(id); removeProfileDirectory(directory, id); changed();
  });
  const checkUpdates = (background?: () => boolean) => queue(async () => {
    await ready;
    if (!ownerFor() && !background?.()) return;
    updating = true; changed();
    try {
      for (const entry of entries) {
        if (stopped || !ownerFor() && !background?.()) return;
        const staging = resolve(directory, '.pending', randomUUID()); mkdirSync(staging, { recursive: true, mode: 0o700 });
        try {
          const path = await downloadExtension(entry.id, staging), version = basename(path);
          if (!/^\d+(?:\.\d+){0,3}_0$/.test(version)) throw new Error('EXTENSION_UPDATE_FAILED');
          const newer = version.slice(0, -2).split('.').map(Number), older = entry.versionDirectory.slice(0, -2).split('.').map(Number);
          const different = Array.from({ length: 4 }, (_, index) => (newer[index] ?? 0) - (older[index] ?? 0)).find(value => value !== 0);
          if (!different || different < 0) continue;
          const manifest = JSON.parse(readFileSync(resolve(path, 'manifest.json'), 'utf8')) as Record<string, unknown>, previous = manifestFor(entry);
          const needsDecision = JSON.stringify(manifestAccess(manifest)) !== JSON.stringify(manifestAccess(previous)) || JSON.stringify(unsupportedPermissions(manifest)) !== JSON.stringify(unsupportedPermissions(previous));
          const owner = ownerFor();
          if (needsDecision && (!owner || !await owner.warning({ id: entry.id, name: localized(manifest, path, 'name'), permissions: manifestAccess(manifest), unsupported: unsupportedPermissions(manifest) }))) continue;
          if (stopped || (owner ? !owners.has(owner) || owner.contents.isDestroyed() : !background?.())) continue;
          const destination = resolve(directory, entry.id, version);
          if (!existsSync(destination)) renameSync(path, destination);
          const old = entry.versionDirectory; entry.versionDirectory = version;
          try { save(); if (entry.enabled) { closePopup(entry.id); target.extensions.removeExtension(entry.id); await load(entry); } }
          catch { entry.versionDirectory = old; save(); if (entry.enabled) await load(entry); throw new Error('EXTENSION_UPDATE_FAILED'); }
        } catch { throw new Error('EXTENSION_UPDATE_FAILED'); }
        finally { rmSync(staging, { recursive: true, force: true }); }
      }
    } finally { updating = false; changed(); }
  });
  const startUpdates = (background?: () => boolean) => { if (checkedAtStart) return Promise.resolve(); checkedAtStart = true; return checkUpdates(background); };
  const stop = async () => {
    stopped = true; owners.clear(); target.unregisterPreloadScript('horizon-web-store'); target.extensions.removeListener('extension-loaded', installed);
    closePopup(); clearAlarms(); windows.clear();
    target.unregisterPreloadScript('crx-mv2-preload'); target.unregisterPreloadScript('crx-mv3-preload');
    await work; await ready;
    for (const entry of entries) target.extensions.removeExtension(entry.id);
  };
  // Verification uses the same downloaded-manifest decision as the Web Store callback.
  const install = (id: string, contents: WebContents) => queue(async () => {
    await ready; const owner = ownerFor(contents); if (!owner) throw new Error('EXTENSIONS_UNAVAILABLE');
    if (!await prepare(id, owner)) return null;
    return installExtension(id, { session: target, extensionsPath: directory });
  });
  const openPopup = async (id: string, parent: BrowserWindow, contents: WebContents, anchorRect: Electron.Rectangle) => {
    await ready;
    const entry = entries.find(entry => entry.id === id);
    if (!entry?.enabled || stopped) throw new Error('EXTENSION_NOT_FOUND');
    if (!windows.size || !runtimeDetails(chrome).ctx.store.tabs.has(contents) || runtimeDetails(chrome).ctx.store.tabToWindow.get(contents) !== parent || contents.session !== target) throw new Error('EXTENSIONS_UNAVAILABLE');
    actions.activateClick({ extensionId: id, tabId: contents.id, anchorRect, alignment: 'bottom left' });
  };
  return { ready, list, storeList, hasEnabled: () => target.extensions.getAllExtensions().length > 0, attach, attachWindow, trackTab, untrackTab, selectTab, commandInput, contextMenuItems: chrome.getContextMenuItems.bind(chrome), closePopup, ownsStore, beforeInstall, finishInstall: (id: string) => pendingInstalls.delete(id), install, setEnabled, setPinned, remove, checkUpdates, startUpdates, stop, openPopup, status: () => ({ updating, storageError }) };
}
