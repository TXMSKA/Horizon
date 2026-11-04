import { contextBridge, ipcRenderer } from 'electron';
import type { Contrast, Theme, VaultOverlayAPI, VaultOverlayCommand, VaultOverlayState } from '../src/shared/api';

const themeArgument = process.argv.find(argument => argument.startsWith('--horizon-theme='))?.slice('--horizon-theme='.length);
// Sandboxed preloads cannot require application modules, so the accepted themes stay literals here.
const themes = ['system', 'amber', 'daylight', 'fjord', 'dune', 'graphite', 'moss'] as const satisfies readonly Theme[];
const initialTheme: Theme = themes.find(theme => theme === themeArgument) ?? 'system';
const contrastArgument = process.argv.find(argument => argument.startsWith('--horizon-contrast='))?.slice('--horizon-contrast='.length);
const initialContrast: Contrast = contrastArgument === 'high' ? 'high' : 'standard';

// The view of the sign-in suggestion can read the suggestion it was given and answer with three commands; nothing else of the browser.
const api: VaultOverlayAPI = Object.freeze({
  initialTheme,
  initialContrast,
  getState: () => ipcRenderer.invoke('horizon:vault-overlay:state') as Promise<VaultOverlayState>,
  onState: (callback: (state: VaultOverlayState) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, state: VaultOverlayState) => callback(state);
    ipcRenderer.on('horizon:vault-overlay:changed', listener);
    return () => { ipcRenderer.removeListener('horizon:vault-overlay:changed', listener); };
  },
  command: ((command: VaultOverlayCommand) => ipcRenderer.invoke('horizon:vault-overlay:command', command)) as VaultOverlayAPI['command'],
  resize: (id: string, width: number, height: number) => ipcRenderer.invoke('horizon:vault-overlay:size', id, width, height) as Promise<void>,
  onFocus: (callback: () => void) => {
    const listener = () => callback();
    ipcRenderer.on('horizon:vault-overlay:focus', listener);
    return () => { ipcRenderer.removeListener('horizon:vault-overlay:focus', listener); };
  },
});

contextBridge.exposeInMainWorld('horizonVault', api);
