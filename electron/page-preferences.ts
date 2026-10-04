import type { WebPreferences } from 'electron';

export function pagePreferences(partition: string, privateWindow: boolean): WebPreferences {
  return {
    partition, sandbox: true, contextIsolation: true, nodeIntegration: false,
    nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, webSecurity: true,
    allowRunningInsecureContent: false, experimentalFeatures: false, webviewTag: false,
    devTools: false, navigateOnDragDrop: false,
    ...(privateWindow ? { javascript: false, plugins: false, webgl: false } : {}),
  };
}
