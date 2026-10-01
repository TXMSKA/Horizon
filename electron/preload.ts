import { contextBridge, ipcRenderer } from 'electron';
import type { HorizonAPI, WindowAction } from '../src/shared/api';

// Sandboxed preloads cannot require application modules, so channels remain literals here.
const api: HorizonAPI = Object.freeze({
  getLanguage: () => ipcRenderer.invoke('horizon:language') as Promise<'en' | 'es'>,
  windowAction: (action: WindowAction) => ipcRenderer.invoke('horizon:window-action', action) as Promise<void>,
});

contextBridge.exposeInMainWorld('horizon', api);
