import { createHash } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';

export function packageChromeExtensions() {
  const require = createRequire(import.meta.url);
  let browser = readFileSync(require.resolve('electron-chrome-extensions'), 'utf8');
  let preload = readFileSync(require.resolve('electron-chrome-extensions/preload'), 'utf8');
  const hash = value => createHash('sha256').update(value).digest('hex');
  if (hash(browser) !== '23dff3b5d4aeaac4ba8dc0be00c6aea648bf49dc0da7ece0b9f63dcf1a39cf2a' || hash(preload) !== '03a5eecb3532bb6bd494c50d4e0360c3e6ef7895552bec3a8d96b0c986573849') throw new Error('Review electron-chrome-extensions before changing its distribution');
  const replace = (source, before, after) => { if (!source.includes(before)) throw new Error('Missing reviewed extension source'); return source.replace(before, after); };
  const quiet = 'const console = Object.freeze({ log() {}, debug() {}, warn() {}, error() {} });\n';
  browser = browser.replace(/var (d\d*) = \(0, import_debug\d*\.default\)\("electron-chrome-extensions:[^"]+"\);/g, 'var $1 = () => {};');
  browser = replace(browser, 'return (0, import_node_module.createRequire)(__dirname).resolve("electron-chrome-extensions/preload");', 'return import_node_path.default.join(__dirname, "extension-preload.js");');
  // The vendor trusts a claimed extension id and lets any renderer choose a remote partition.
  browser = replace(browser, 'const ses = sessionPartition === DEFAULT_SESSION', 'throw new Error("Remote extension routing is unavailable");\n      const ses = sessionPartition === DEFAULT_SESSION');
  browser = replace(browser, 'const { session: session2 } = this;\n    const eventSession = getSessionFromEvent(event);', 'if (!require("./extension-runtime.js").authorizeExtension(event, extensionId)) throw new Error("Untrusted extension sender");\n    if (/^runtime\\.(connectNative|sendNativeMessage|disconnectNative)$/.test(handlerName)) throw new Error("Native messaging is unavailable");\n    const { session: session2 } = this;\n    const eventSession = getSessionFromEvent(event);');
  for (const method of ['addListener', 'removeListener']) browser = replace(browser, `${method}(listener, extensionId, eventName) {`, `${method}(listener, extensionId, eventName) {\n    if (listener.type === "frame" && (!listener.host || !require("./extension-policy.js").isExtensionURL(this.session, listener.host.getURL()) || new URL(listener.host.getURL()).hostname !== extensionId)) return;`);
  for (const method of ['onAddListener', 'onRemoveListener']) browser = replace(browser, `this.${method} = (event, extensionId, eventName) => {`, `this.${method} = (event, extensionId, eventName) => {\n      if (!require("./extension-runtime.js").authorizeExtension(event, extensionId)) return;`);
  browser = replace(browser, 'tabInfo.active = tabId === cacheTabId;', 'if (tabInfo.windowId === win?.id) tabInfo.active = tabId === cacheTabId;');
  browser = replace(browser, 'if (isSet(info.windowId)) {', 'if (info.currentWindow && tab.windowId !== this.ctx.store.lastFocusedWindowId) return false;\n      if (isSet(info.windowId)) {');
  browser = replace(browser, 'tab.index = index;', 'tab.index = tab.index < 0 ? index : tab.index;');
  browser = replace(browser, 'if (!resPath.startsWith(extension.path)) return;', 'if (!resPath.startsWith(extension.path + path.sep)) return;');
  browser = replace(browser, 'if (url) await tab.loadURL(url);', 'if (url) await this.ctx.store.impl.updateTab(tab, url);');
  // Cached window snapshots otherwise keep the initial empty tab list after Horizon creates or transfers tabs.
  browser = replace(browser, 'getWindowDetails(win) {\n    if (this.ctx.store.windowDetailsCache.has(win.id)) {\n      return this.ctx.store.windowDetailsCache.get(win.id);\n    }', 'getWindowDetails(win) {');
  browser = replace(browser, 'getTabDetails(tab) {\n    if (this.ctx.store.tabDetailsCache.has(tab.id)) {\n      return this.ctx.store.tabDetailsCache.get(tab.id);\n    }', 'getTabDetails(tab) {');
  browser = replace(browser, 'this.queuedUpdate = false;\n      if (this.observers.size', 'this.queuedUpdate = false;\n      this.ctx.emit("browser-action-updated");\n      if (this.observers.size');
  browser = replace(browser, 'const popupUrl = this.getPopupUrl(extensionId, tab.id);', 'const popupUrl = this.getPopupUrl(extensionId, tab.id);\n    if (popupUrl && (!require("./extension-policy.js").isExtensionURL(this.ctx.session, popupUrl) || new URL(popupUrl).hostname !== extensionId)) throw new Error("Invalid extension popup");');
  // Prepending the guards must not remove the vendor's strict execution mode.
  writeFileSync('dist/electron/chrome-extensions.cjs', '"use strict";\n' + quiet + browser);

  preload = replace(preload, 'const apiDefinitions = {', `const apiDefinitions = {
        alarms: {
          shouldInject: () => !chrome.alarms,
          factory: () => ({
            create: (name, info) => typeof name === "object" ? invokeExtension2("alarms.create")("", name) : invokeExtension2("alarms.create")(name || "", info),
            get: invokeExtension2("alarms.get"), getAll: invokeExtension2("alarms.getAll"),
            clear: invokeExtension2("alarms.clear"), clearAll: invokeExtension2("alarms.clearAll"),
            onAlarm: new ExtensionEvent("alarms.onAlarm")
          })
        },`);
  // Extension listeners must be removable by their original callback, including alarm listeners.
  preload = replace(preload, 'var listenerMap =', 'var callbacks = new Map();\n  var listenerMap =');
  preload = replace(preload, 'import_electron.ipcRenderer.addListener(formatIpcName(name), function(event, ...args) {', 'const wrapped = function(event, ...args) {');
  preload = replace(preload, 'callback(...args);\n    });', 'callback(...args);\n    };\n    let entries = callbacks.get(name); if (!entries) { entries = new Map(); callbacks.set(name, entries); }\n    entries.set(callback, wrapped);\n    import_electron.ipcRenderer.addListener(formatIpcName(name), wrapped);');
  preload = replace(preload, 'import_electron.ipcRenderer.removeListener(formatIpcName(name), callback);', 'const wrapped = callbacks.get(name)?.get(callback);\n    if (wrapped) { import_electron.ipcRenderer.removeListener(formatIpcName(name), wrapped); callbacks.get(name).delete(callback); }');
  const guard = `const address = process.type === 'service-worker' ? require('electron').contextBridge.executeInMainWorld({ func: () => globalThis.location.href }) : location.href;
const url = new URL(address);
if (url.protocol === 'chrome-extension:' && /^[a-p]{32}$/.test(url.hostname) && !url.username && !url.password && !url.port) {`;
  writeFileSync('dist/electron/extension-preload.js', `(() => {\n"use strict";\n${quiet}${guard}\n${preload}\n}\n})();\n`);
}
