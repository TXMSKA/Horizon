import { contextBridge, ipcRenderer } from 'electron';
import type { BrowserCommand, BrowserShortcut, BrowserState, ContentArea, HorizonAPI, WindowAction } from '../src/shared/api';

// Sandboxed preloads cannot require application modules, so channels remain literals here.
const api: HorizonAPI = Object.freeze({
  getLanguage: () => ipcRenderer.invoke('horizon:language') as Promise<'en' | 'es'>,
  windowAction: (action: WindowAction) => ipcRenderer.invoke('horizon:window-action', action) as Promise<void>,
  getState: () => ipcRenderer.invoke('horizon:state') as Promise<BrowserState>,
  capture: () => ipcRenderer.invoke('horizon:capture') as Promise<Uint8Array | null>,
  command: (command: BrowserCommand) => ipcRenderer.invoke('horizon:command', command) as Promise<void>,
  setContentArea: (area: ContentArea) => ipcRenderer.invoke('horizon:content-area', area) as Promise<void>,
  onState: (callback: (state: BrowserState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: BrowserState) => callback(state);
    ipcRenderer.on('horizon:state-changed', listener);
    return () => { ipcRenderer.removeListener('horizon:state-changed', listener); };
  },
  onShortcut: (callback: (shortcut: BrowserShortcut) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, shortcut: BrowserShortcut) => callback(shortcut);
    ipcRenderer.on('horizon:shortcut', listener);
    return () => { ipcRenderer.removeListener('horizon:shortcut', listener); };
  },
});

contextBridge.exposeInMainWorld('horizon', api);
