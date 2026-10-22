import electron from 'electron';
import type { DownloadItem, Session, WebContents } from 'electron';
import { getDomain } from 'tldts-experimental';
import { blockingPolicy, createBlockingEngine } from './blocking.js';
import { isAllowedSubframeURL, isAllowedURL, isWebURL } from './urls.js';

type PermissionHandler = NonNullable<Parameters<Session['setPermissionRequestHandler']>[0]>;
export interface PermissionRequest {
  contents: WebContents;
  origin: string;
  permission: Parameters<PermissionHandler>[1];
  details: Parameters<PermissionHandler>[3];
}
export interface ProtectOptions {
  dataDir: string;
  blockAds?: boolean;
  blockThirdPartyCookies?: boolean;
  privateMode?: boolean;
  permissions?: (request: PermissionRequest) => Promise<'allow' | 'block'>;
  download?: (item: DownloadItem) => string | null;
  openExternal?: (url: string) => boolean;
  /** Test hook: replaces filter-list downloads, including the resources.json response. */
  filterDownload?: (url: string, signal: AbortSignal) => Promise<string>;
}
export interface ProtectedSession {
  update(options: Partial<ProtectOptions>): void;
  blockedCount(contents: WebContents): number;
  resumeDownload(saved: Parameters<Session['createInterruptedDownload']>[0]): void;
  dispose(): void;
}
const protectedSessions = new WeakSet<Session>();
const counts = new WeakMap<WebContents, number>();
export const blockedCount = (contents: WebContents): number => counts.get(contents) ?? 0;
function cookieSite(value: string): string | null {
  try {
    const url = new URL(value), protocol = url.protocol === 'ws:' ? 'http:' : url.protocol === 'wss:' ? 'https:' : url.protocol;
    if (!['http:', 'https:'].includes(protocol)) return null;
    const host = url.hostname.replace(/\.$/, '');
    return `${protocol}//${getDomain(host, { allowPrivateDomains: true }) ?? host}`;
  } catch { return null; }
}
function stripCookies<T>(headers: Record<string, T>, response: boolean, url: string, topURL: string, enabled: boolean): Record<string, T> {
  const requestSite = cookieSite(url), topSite = cookieSite(topURL);
  return enabled && requestSite && (!topSite || requestSite !== topSite)
    ? Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== (response ? 'set-cookie' : 'cookie'))) : headers;
}
const originOf = (value: string): string | undefined => { try { return isWebURL(value) ? new URL(value).origin : undefined; } catch { return undefined; } };

export function protectSession(session: Session, initial: ProtectOptions): ProtectedSession {
  if (protectedSessions.has(session)) throw new Error('SESSION_ALREADY_PROTECTED');
  protectedSessions.add(session);
  let options = { blockAds: true, blockThirdPartyCookies: true, privateMode: false, ...initial }, disposed = false;
  let permissionGeneration = 0;
  const grants = new Set<string>(), pending = new Set<() => void>();
  const bindings = new Map<WebContents, { topURL: string; generation: number; css?: string; cssWork: Promise<void>; remove(): void }>();
  const requests = new Map<number, { contents?: WebContents; generation?: number; topURL: string }>();
  const policy = () => blockingPolicy(options.privateMode, options.blockAds, options.blockThirdPartyCookies);
  const cosmetics = (contents: WebContents) => {
    const binding = bindings.get(contents);
    if (!binding) return;
    const generation = binding.generation;
    binding.cssWork = binding.cssWork.then(async () => {
      const current = () => !disposed && !contents.isDestroyed() && bindings.get(contents) === binding && binding.generation === generation;
      if (!current()) return;
      if (binding.css) { const key = binding.css; binding.css = undefined; await contents.removeInsertedCSS(key).catch(() => undefined); }
      if (!current() || !policy().filters || !isWebURL(contents.getURL())) return;
      const css = blocker.cosmeticCSS(contents.getURL());
      if (!css) return;
      // Author origin lets Electron remove styles when protection changes.
      const key = await contents.insertCSS(css, { cssOrigin: 'author' });
      if (current()) binding.css = key;
      else if (!contents.isDestroyed()) await contents.removeInsertedCSS(key).catch(() => undefined);
    }).catch(() => undefined);
  };
  const blocker = createBlockingEngine(options.dataDir, () => { for (const contents of bindings.keys()) cosmetics(contents); }, { enabled: policy().filters, download: options.filterDownload });
  const harden = (_event: unknown, contents: WebContents) => {
    if (disposed || contents.session !== session || bindings.has(contents)) return;
    const external = (url: string) => { try { options.openExternal?.(url); } catch { /* The host refused the route. */ } };
    const navigate = (event: { url: string; preventDefault(): void }) => { if (!isAllowedURL(event.url)) { event.preventDefault(); external(event.url); } };
    const frameNavigate = (event: { url: string; isMainFrame: boolean; preventDefault(): void }) => {
      if (!(event.isMainFrame ? isAllowedURL(event.url) : isAllowedSubframeURL(event.url))) { event.preventDefault(); if (event.isMainFrame) external(event.url); }
    };
    const webview = (event: { preventDefault(): void }) => event.preventDefault();
    const start = (event: { isMainFrame: boolean; isSameDocument: boolean; url: string }) => {
      if (!event.isMainFrame || event.isSameDocument) return;
      binding.generation++; binding.topURL = event.url;
      counts.set(contents, 0); contents.emit('horizon-blocked');
    };
    const committed = () => { binding.topURL = contents.getURL(); cosmetics(contents); };
    const destroyed = () => { binding.remove(); bindings.delete(contents); counts.delete(contents); };
    const binding = { topURL: contents.getURL(), generation: 0, css: undefined as string | undefined, cssWork: Promise.resolve(), remove: () => {
      contents.off('will-navigate', navigate); contents.off('will-frame-navigate', frameNavigate); contents.off('will-redirect', frameNavigate);
      contents.off('will-attach-webview', webview); contents.off('did-start-navigation', start); contents.off('did-navigate', committed); contents.off('destroyed', destroyed);
      if (!contents.isDestroyed()) {
        contents.setWindowOpenHandler(() => ({ action: 'allow' }));
        if (binding.css) void contents.removeInsertedCSS(binding.css).catch(() => undefined);
      }
    } };
    bindings.set(contents, binding); counts.set(contents, 0);
    contents.on('will-navigate', navigate); contents.on('will-frame-navigate', frameNavigate); contents.on('will-redirect', frameNavigate);
    contents.on('will-attach-webview', webview); contents.on('did-start-navigation', start); contents.on('did-navigate', committed); contents.on('destroyed', destroyed);
    contents.setWindowOpenHandler(details => { if (!isAllowedURL(details.url)) external(details.url); return { action: 'deny' }; });
    cosmetics(contents);
  };
  electron.app.on('web-contents-created', harden);
  for (const contents of electron.webContents.getAllWebContents()) harden(undefined, contents);
  const context = (details: { id: number; webContentsId?: number; url: string; resourceType: string; frame?: { top: { url: string } | null } | null; initiatorOrigin?: string; referrer?: string }) => {
    let saved = requests.get(details.id);
    if (!saved) {
      const contents = [...bindings.keys()].find(contents => contents.id === details.webContentsId), binding = contents && bindings.get(contents);
      const origin = [details.frame?.top?.url, details.initiatorOrigin, details.referrer].find(isWebURL);
      saved = { contents, generation: binding?.generation, topURL: details.resourceType === 'mainFrame' ? details.url : binding?.topURL || origin || '' };
      requests.set(details.id, saved);
    } else if (details.resourceType === 'mainFrame') saved.topURL = details.url;
    if (details.resourceType === 'mainFrame' && saved.contents) {
      const binding = bindings.get(saved.contents);
      if (binding && binding.generation === saved.generation) binding.topURL = details.url;
    }
    return saved;
  };
  session.webRequest.onBeforeRequest((details, callback) => {
    const saved = context(details), scheme = new URL(details.url).protocol;
    const refused = details.resourceType === 'mainFrame' ? !isAllowedURL(details.url) : details.resourceType === 'subFrame'
      ? !isAllowedSubframeURL(details.url) : !['http:', 'https:', 'data:', 'blob:', 'ws:', 'wss:'].includes(scheme);
    if (disposed || refused || options.privateMode && (details.resourceType === 'script' || (!blocker.ready || !saved.contents && !isWebURL(saved.topURL)) && /^(https?|wss?):$/.test(scheme))) { callback({ cancel: true }); return; }
    const match = policy().filters ? blocker.match(details.url, details.resourceType, saved.topURL) : undefined;
    if (!match) { callback({ cancel: false }); return; }
    if (saved.contents && saved.generation === bindings.get(saved.contents)?.generation) {
      counts.set(saved.contents, blockedCount(saved.contents) + 1); saved.contents.emit('horizon-blocked');
    }
    callback(match.redirectURL ? { redirectURL: match.redirectURL } : { cancel: true });
  });
  session.webRequest.onBeforeSendHeaders((details, callback) => {
    callback({ requestHeaders: stripCookies(details.requestHeaders, false, details.url, context(details).topURL, policy().thirdPartyCookies) });
  });
  session.webRequest.onHeadersReceived((details, callback) => {
    let headers = stripCookies(details.responseHeaders ?? {}, true, details.url, context(details).topURL, policy().thirdPartyCookies);
    if (options.privateMode && details.resourceType === 'mainFrame' && Object.entries(headers).some(([key, values]) => key.toLowerCase() === 'content-type' && values.some(value => /^application\/pdf(?:;|$)/i.test(value)))) {
      headers = { ...Object.fromEntries(Object.entries(headers).filter(([key]) => key.toLowerCase() !== 'content-disposition')), 'Content-Disposition': ['attachment'] };
    }
    callback({ responseHeaders: headers });
  });
  session.webRequest.onCompleted(details => { requests.delete(details.id); });
  session.webRequest.onErrorOccurred(details => { requests.delete(details.id); });
  session.setPermissionRequestHandler((contents, permission, callback, details) => {
    if (permission === 'openExternal') {
      const url = 'externalURL' in details ? details.externalURL : undefined;
      let allow = false;
      try { allow = !disposed && !options.privateMode && typeof url === 'string' && options.openExternal?.(url) === true; } catch { /* A failed host route is denied. */ }
      callback(allow); return;
    }
    const origin = originOf(details.requestingUrl), topURL = contents.isDestroyed() ? '' : contents.getURL(), generation = permissionGeneration;
    if (disposed || options.privateMode || !origin || !options.permissions) { callback(false); return; }
    let answered = false;
    const answer = (allow = false) => {
      if (answered) return;
      answered = true; pending.delete(answer);
      const granted = allow && !disposed && !options.privateMode && generation === permissionGeneration && !contents.isDestroyed() && contents.getURL() === topURL;
      if (granted) grants.add(`${origin}\n${permission}`); else grants.delete(`${origin}\n${permission}`);
      callback(granted);
    };
    pending.add(answer);
    const permissions = options.permissions;
    void Promise.resolve().then(() => permissions({ contents, origin, permission, details })).then(result => answer(result === 'allow'), () => answer());
  });
  session.setPermissionCheckHandler((_contents, permission, requestingOrigin, details) => {
    const origin = originOf(details.securityOrigin ?? requestingOrigin);
    return !disposed && !options.privateMode && !!origin && grants.has(`${origin}\n${permission}`);
  });
  session.setDevicePermissionHandler(() => false);
  const download = (_event: unknown, item: DownloadItem) => {
    let path: string | null = null;
    try { path = options.download?.(item) ?? null; } catch { /* A failed host route cancels the download. */ }
    if (!disposed && typeof path === 'string' && path) item.setSavePath(path); else item.cancel();
  };
  session.on('will-download', download);
  void blocker.start();
  return {
    update(next) {
      if (disposed) throw new Error('SESSION_PROTECTION_DISPOSED');
      options = { ...options, ...next };
      permissionGeneration++; grants.clear(); for (const answer of pending) answer();
      blocker.setEnabled(policy().filters); for (const contents of bindings.keys()) cosmetics(contents);
    },
    blockedCount,
    resumeDownload(saved) { if (disposed) throw new Error('SESSION_PROTECTION_DISPOSED'); session.createInterruptedDownload(saved); },
    dispose() {
      if (disposed) return;
      disposed = true; blocker.stop(); for (const answer of pending) answer();
      electron.app.off('web-contents-created', harden); session.off('will-download', download);
      session.setPermissionRequestHandler(null); session.setPermissionCheckHandler(null); session.setDevicePermissionHandler(null);
      session.webRequest.onBeforeRequest(null); session.webRequest.onBeforeSendHeaders(null); session.webRequest.onHeadersReceived(null);
      session.webRequest.onCompleted(null); session.webRequest.onErrorOccurred(null);
      for (const [contents, binding] of bindings) { binding.remove(); counts.delete(contents); }
      bindings.clear(); requests.clear(); grants.clear(); protectedSessions.delete(session);
    },
  };
}
