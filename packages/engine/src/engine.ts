import electron from 'electron';
import type { FindInPageOptions, HandlerDetails, Input, Result, Session, WebContents, WebContentsView } from 'electron';
import type { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { blockedCount, protectSession } from './protect.js';
import type { ProtectOptions } from './protect.js';
import { classifyInput, isAllowedURL, isWebURL } from './urls.js';
import { createPageControl } from './control.js';
import type { PageControl } from './control.js';
export type { ControlTarget, ControlScroll, PickedElement, PageControl } from './control.js';

export interface TabError { code: number; description: string; url: string }
export interface TabState {
  url: string; title: string; favicon: string | null; loading: boolean;
  canGoBack: boolean; canGoForward: boolean; blocked: number; secure: boolean; error: TabError | null;
}
export interface TabHistory { entries: { url: string; title: string }[]; index: number }
export interface OpenTabOptions { url?: string; active?: boolean; restore?: TabHistory }
export interface Tab {
  readonly id: string; readonly view: WebContentsView; readonly state: Readonly<TabState>;
  readonly control?: PageControl;
  navigate(input: string, searchPrefix?: string): Promise<void>;
  back(): void; forward(): void; reload(): void; stop(): void;
  find(text: string, options?: FindInPageOptions): Promise<Result>;
  stopFind(): void; zoom(factor: number): void; close(): void; history(): TabHistory;
  onChange(listener: (state: Readonly<TabState>) => void): () => void;
}
export interface Navigation { tabId: string; url: string; title: string }
export interface EngineOptions {
  session: Session; protect: ProtectOptions; searchEngine?: string;
  openWindow?: (details: HandlerDetails) => void;
  shortcut?: (input: Input) => boolean;
  fullscreen?: (tab: Tab, on: boolean) => void;
  pageControl?: boolean;
  consent?: (url: string, purpose: 'read' | 'control') => boolean | Promise<boolean>;
}
export interface CaptureOptions { fullPage?: boolean }
export interface Engine {
  openTab(options?: OpenTabOptions): Tab;
  onNavigate(listener: (navigation: Navigation) => void): () => void;
  capture(tab: Tab, options?: CaptureOptions): Promise<Buffer>;
  readPage(tab: Tab): Promise<string>;
  dispose(): void;
}
interface AXNode { nodeId?: string; parentId?: string; frameId?: string; ignored?: boolean; role?: { value?: string }; name?: { value?: string } }
type DebuggerCommand = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;

async function withDebugger<T>(contents: WebContents, work: (command: DebuggerCommand) => Promise<T>): Promise<T> {
  let attached = false, active = true, timer: ReturnType<typeof setTimeout> | undefined;
  const detached = () => { attached = false; active = false; };
  const check = () => { if (!active || contents.isDestroyed() || !contents.debugger.isAttached()) throw new Error('PAGE_CHANGED'); };
  const command: DebuggerCommand = async (method, params) => { check(); const result = await contents.debugger.sendCommand(method, params); check(); return result; };
  contents.debugger.on('detach', detached);
  try {
    if (!contents.debugger.isAttached()) { contents.debugger.attach('1.3'); attached = true; }
    return await Promise.race([work(command), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('PAGE_TIMEOUT')), 8000); })]);
  } finally {
    active = false; clearTimeout(timer); contents.debugger.off('detach', detached);
    if (attached && !contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach();
  }
}

export function createEngine(options: EngineOptions): Engine {
  const { WebContentsView } = electron;
  if (!WebContentsView) throw new Error('Electron main process required');
  const protection = protectSession(options.session, options.protect);
  const tabs = new Map<string, Tab>(), navigations = new Set<(navigation: Navigation) => void>();
  let disposed = false;
  const contentsFor = (tab: Tab) => {
    if (disposed || tabs.get(tab.id) !== tab || tab.view.webContents.isDestroyed()) throw new Error('Tab is closed');
    return tab.view.webContents;
  };
  return {
    openTab(settings = {}) {
      if (disposed) throw new Error('Engine is closed');
      const restore = settings.restore;
      if (restore && (!restore.entries.length || !Number.isInteger(restore.index) || restore.index < 0 || restore.index >= restore.entries.length
        || restore.entries.some(entry => !isAllowedURL(entry.url) || typeof entry.title !== 'string'))) throw new Error('Invalid tab history');
      const initialURL = restore ? restore.entries[restore.index]!.url : classifyInput(settings.url ?? 'about:blank', options.searchEngine ?? 'https://duckduckgo.com/?q=');
      const view = new WebContentsView({ webPreferences: { session: options.session, sandbox: true, contextIsolation: true, nodeIntegration: false, webviewTag: false } });
      view.setVisible(settings.active ?? true);
      const contents = view.webContents, emitter: EventEmitter = contents;
      const listeners = new Set<(state: Readonly<TabState>) => void>(), removers: (() => void)[] = [];
      const finds = new Map<number, { resolve: (result: Result) => void; reject: (error: Error) => void; timer: ReturnType<typeof setTimeout> }>();
      let closed = false;
      const state: TabState = { url: initialURL, title: '', favicon: null, loading: true, canGoBack: false, canGoForward: false, blocked: 0, secure: false, error: null };
      const on: WebContents['on'] = (event, listener) => { emitter.on(event, listener); removers.push(() => emitter.removeListener(event, listener)); return contents; };
      const publish = () => {
        if (closed || contents.isDestroyed()) return;
        state.canGoBack = contents.navigationHistory.canGoBack(); state.canGoForward = contents.navigationHistory.canGoForward();
        state.blocked = blockedCount(contents); state.secure = state.url.startsWith('https:') && !state.error;
        const snapshot = { ...state, error: state.error && { ...state.error } };
        for (const listener of listeners) listener(snapshot);
      };
      const cancelFinds = (reason: string) => {
        for (const pending of finds.values()) { clearTimeout(pending.timer); pending.reject(new Error(reason)); }
        finds.clear();
      };
      const controller = options.pageControl ? createPageControl(view, options.consent) : undefined;
      const tab: Tab = {
        id: randomUUID(), view,
        control: controller?.control,
        get state() { return { ...state, blocked: contents.isDestroyed() ? state.blocked : blockedCount(contents), error: state.error && { ...state.error } }; },
        navigate(input, searchPrefix = options.searchEngine ?? 'https://duckduckgo.com/?q=') { return contentsFor(tab).loadURL(classifyInput(input, searchPrefix)); },
        back() { const page = contentsFor(tab); if (page.navigationHistory.canGoBack()) page.navigationHistory.goBack(); },
        forward() { const page = contentsFor(tab); if (page.navigationHistory.canGoForward()) page.navigationHistory.goForward(); },
        reload() { contentsFor(tab).reload(); }, stop() { contentsFor(tab).stop(); },
        find(text, findOptions) {
          const page = contentsFor(tab);
          if (!text) { tab.stopFind(); return Promise.reject(new Error('Find text is empty')); }
          return new Promise<Result>((resolve, reject) => {
            const request = page.findInPage(text, { findNext: true, ...findOptions });
            const timer = setTimeout(() => { finds.delete(request); reject(new Error('FIND_TIMEOUT')); }, 8000);
            finds.set(request, { resolve, reject, timer });
          });
        },
        stopFind() { contentsFor(tab).stopFindInPage('clearSelection'); cancelFinds('FIND_STOPPED'); },
        zoom(factor) { if (!Number.isFinite(factor) || factor < 0.25 || factor > 5) throw new Error('Invalid zoom factor'); contentsFor(tab).setZoomFactor(factor); },
        close() {
          if (closed) return;
          closed = true; tabs.delete(tab.id); cancelFinds('Tab is closed');
          controller?.dispose();
          for (const remove of removers) remove();
          listeners.clear();
          if (!contents.isDestroyed()) { contents.setWindowOpenHandler(() => ({ action: 'deny' })); contents.close({ waitForBeforeUnload: false }); }
        },
        history() {
          const history = contentsFor(tab).navigationHistory;
          return { entries: history.getAllEntries().map(entry => ({ url: entry.url, title: entry.title.replace(/[\x00-\x1f\x7f-\x9f]/g, ' ').slice(0, 4096) })), index: history.getActiveIndex() };
        },
        onChange(listener) { if (closed) throw new Error('Tab is closed'); listeners.add(listener); return () => listeners.delete(listener); },
      };
      tabs.set(tab.id, tab);
      const committed = (url: string) => {
        state.url = url; state.title = contents.getTitle(); publish();
        for (const listener of navigations) listener({ tabId: tab.id, url, title: state.title });
      };
      contents.setWindowOpenHandler(details => {
        if (!closed) {
          if (isAllowedURL(details.url)) options.openWindow?.(details);
          else try { options.protect.openExternal?.(details.url); } catch { /* A failed host route is denied. */ }
        }
        return { action: 'deny' };
      });
      on('destroyed', () => tab.close());
      on('did-start-loading', () => { state.loading = true; publish(); });
      on('did-stop-loading', () => { state.loading = contents.isLoading(); publish(); });
      on('did-start-navigation', (_event, _url, inPlace, mainFrame) => {
        if (!mainFrame) return;
        state.error = null;
        if (!inPlace) { state.favicon = null; cancelFinds('PAGE_CHANGED'); }
        publish();
      });
      on('did-navigate', (_event, url) => committed(url));
      on('did-navigate-in-page', (_event, url, mainFrame) => { if (mainFrame) committed(url); });
      on('page-title-updated', (_event, title) => { state.title = title.slice(0, 4096); publish(); });
      on('page-favicon-updated', (_event, candidates) => { state.favicon = candidates.find(isWebURL) ?? null; publish(); });
      on('did-fail-load', (_event, code, description, url, mainFrame) => {
        if (!mainFrame || code === -3) return;
        state.url = url; state.error = { code, description, url }; state.loading = false; publish();
      });
      on('found-in-page', (_event, result) => {
        if (!result.finalUpdate) return;
        const pending = finds.get(result.requestId);
        if (pending) { finds.delete(result.requestId); clearTimeout(pending.timer); pending.resolve(result); }
      });
      on('before-input-event', (event, input) => { if (options.shortcut?.(input)) event.preventDefault(); });
      on('enter-html-full-screen', () => options.fullscreen?.(tab, true));
      on('leave-html-full-screen', () => options.fullscreen?.(tab, false));
      emitter.on('horizon-blocked', publish); removers.push(() => emitter.removeListener('horizon-blocked', publish));
      const loading = restore ? contents.navigationHistory.restore({ entries: restore.entries.map(entry => ({ url: entry.url, title: entry.title })), index: restore.index }) : contents.loadURL(initialURL);
      void loading.catch(() => undefined);
      return tab;
    },
    onNavigate(listener) { if (disposed) throw new Error('Engine is closed'); navigations.add(listener); return () => navigations.delete(listener); },
    async capture(tab, settings = {}) {
      const contents = contentsFor(tab);
      if (!settings.fullPage) return (await contents.capturePage(undefined, { stayHidden: true })).toPNG();
      return withDebugger(contents, async command => {
        const metrics = await command<{ cssContentSize: { x: number; y: number; width: number; height: number } }>('Page.getLayoutMetrics');
        contentsFor(tab);
        const { x, y, width, height } = metrics.cssContentSize;
        if (![x, y, width, height].every(Number.isFinite) || width <= 0 || height <= 0) throw new Error('CAPTURE_SIZE');
        const result = await command<{ data: string }>('Page.captureScreenshot', { format: 'png', captureBeyondViewport: true, fromSurface: true, clip: { x, y, width, height, scale: 1 } });
        contentsFor(tab);
        return Buffer.from(result.data, 'base64');
      });
    },
    async readPage(tab) {
      const contents = contentsFor(tab), url = contents.getURL();
      const check = async () => {
        if (await options.consent?.(url, 'read') !== true) throw new Error('READ_PAGE_CONSENT');
        if (contentsFor(tab).getURL() !== url || !isWebURL(url)) throw new Error('READ_PAGE_CHANGED');
      };
      await check();
      return withDebugger(contents, async command => {
        const tree = await command<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree');
        await check();
        const frameId = tree.frameTree.frame.id;
        if (typeof frameId !== 'string' || !frameId) throw new Error('READ_PAGE_CHANGED');
        const result = await command<{ nodes: AXNode[] }>('Accessibility.getFullAXTree', { depth: 24, frameId });
        await check();
        const selected = result.nodes.slice(0, 20000), nodes = new Map(selected.filter(node => node.nodeId).map(node => [node.nodeId, node]));
        const readable = (node: AXNode) => {
          for (let ancestor: AXNode | undefined = node, depth = 0; ancestor && depth < 24; depth++, ancestor = nodes.get(ancestor.parentId)) {
            if (ancestor.frameId && ancestor.frameId !== frameId || /^(Iframe|IframePresentational|textbox|searchbox|combobox)$/i.test(ancestor.role?.value ?? '')) return false;
          }
          return true;
        };
        let text = '';
        for (const node of selected) {
          if (node.ignored || node.role?.value !== 'StaticText' || typeof node.name?.value !== 'string' || !readable(node)) continue;
          text += `${node.name.value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '').replace(/[\u2013\u2014]/g, '-').slice(0, 6000 - text.length)}\n`;
          if (text.length >= 6000) break;
        }
        if (!text.trim()) throw new Error('READ_PAGE_EMPTY');
        return text.slice(0, 6000);
      });
    },
    dispose() { if (disposed) return; for (const tab of [...tabs.values()]) tab.close(); disposed = true; navigations.clear(); protection.dispose(); },
  };
}
