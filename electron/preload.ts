import { contextBridge, ipcRenderer } from 'electron';
import type { BrowserCommand, BrowserShortcut, BrowserState, ContentArea, Contrast, HorizonAPI, NotebookContent, PageContextMenu, Theme, WindowAction } from '../src/shared/api';

const themeArgument = process.argv.find(argument => argument.startsWith('--horizon-theme='))?.slice('--horizon-theme='.length);
const initialTheme: Theme = themeArgument === 'amber' || themeArgument === 'daylight' || themeArgument === 'system' ? themeArgument : 'system';
const contrastArgument = process.argv.find(argument => argument.startsWith('--horizon-contrast='))?.slice('--horizon-contrast='.length);
const initialContrast: Contrast = contrastArgument === 'high' ? 'high' : 'standard';

// Sandboxed preloads cannot require application modules, so channels remain literals here.
const api: HorizonAPI = Object.freeze({
  initialTheme,
  initialContrast,
  themeMigration: process.argv.includes('--horizon-theme-migrate=1'),
  getLanguage: () => ipcRenderer.invoke('horizon:language') as Promise<'en' | 'es'>,
  windowAction: (action: WindowAction) => ipcRenderer.invoke('horizon:window-action', action) as Promise<void>,
  getState: () => ipcRenderer.invoke('horizon:state') as Promise<BrowserState>,
  capture: () => ipcRenderer.invoke('horizon:capture') as Promise<Uint8Array | null>,
  getFavicon: (id: string, hash: string) => ipcRenderer.invoke('horizon:favicon', id, hash) as Promise<Uint8Array | null>,
  getNotebook: (id: string) => ipcRenderer.invoke('horizon:notebook', id) as Promise<NotebookContent>,
  getCaptureImage: (notebook: string, item: string) => ipcRenderer.invoke('horizon:capture-image', notebook, item) as Promise<Uint8Array | null>,
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
  onContextMenu: (callback: (menu: PageContextMenu | null) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, menu: PageContextMenu | null) => callback(menu);
    ipcRenderer.on('horizon:context-menu', listener);
    return () => { ipcRenderer.removeListener('horizon:context-menu', listener); };
  },
});

contextBridge.exposeInMainWorld('horizon', api);
