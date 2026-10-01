import type { IpcMainInvokeEvent, Session, WebContents } from 'electron';

export const START_URL = 'horizon://app/';
export const CONTENT_SECURITY_POLICY = [
  "default-src 'none'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self'",
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
