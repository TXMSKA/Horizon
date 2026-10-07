import type { IpcMainInvokeEvent, Session, WebContents } from 'electron';
import { isAllowedSubframeURL, isAllowedURL } from './browsing';
import { isExtensionURL } from './extension-policy';

export const START_URL = 'horizon://app/';
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' blob:",
  "font-src 'none'",
  "connect-src 'none'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-src 'none'",
  "frame-ancestors 'none'",
].join('; ');

export function validateSender(event: IpcMainInvokeEvent, contents: WebContents): void {
  const frame = event.senderFrame;
  if (contents.isDestroyed() || event.sender !== contents || !frame || frame !== contents.mainFrame) {
    throw new Error('Untrusted IPC sender');
  }
  const url = new URL(frame.url);
  if (url.protocol !== 'horizon:' || url.hostname !== 'app' || url.port || url.username || url.password || url.pathname !== '/' || url.search || url.hash) {
    throw new Error('Untrusted IPC origin');
  }
}

export function secureSession(target: Session): void {
  target.setPermissionRequestHandler((_contents, _permission, callback) => callback(false));
  target.setPermissionCheckHandler(() => false);
  target.setDevicePermissionHandler(() => false);
  target.on('will-download', (event) => event.preventDefault());
  target.webRequest.onBeforeRequest((details, callback) => {
    callback({ cancel: new URL(details.url).protocol !== 'horizon:' });
  });
}

export function hardenContents(contents: WebContents, web: boolean, authorizeLaunch: (url: string) => boolean = () => false): void {
  const extension = (url: string) => web && isExtensionURL(contents.session, url);
  contents.on('will-navigate', (event) => { if (!web || !(isAllowedURL(event.url) || authorizeLaunch(event.url) || extension(event.url))) event.preventDefault(); });
  contents.on('will-frame-navigate', (event) => { if (!web || !(event.isMainFrame ? isAllowedURL(event.url) || authorizeLaunch(event.url) || extension(event.url) : isAllowedSubframeURL(event.url) || extension(event.url))) event.preventDefault(); });
  contents.on('will-redirect', (event) => { if (!web || !(event.isMainFrame ? isAllowedURL(event.url) || authorizeLaunch(event.url) || extension(event.url) : isAllowedSubframeURL(event.url) || extension(event.url))) event.preventDefault(); });
  contents.on('will-attach-webview', (event) => event.preventDefault());
  contents.setWindowOpenHandler(() => ({ action: 'deny' }));
}
