export type Language = 'en' | 'es';
export type WindowAction = 'minimize' | 'maximize' | 'close';

export interface HistoryEntry { url: string; title: string; lastVisit: number; visitCount: number }
export interface Bookmark { url: string; title: string; createdAt: number }
export type DownloadStatus = 'progressing' | 'completed' | 'failed' | 'cancelled';
export interface DownloadEntry { id: string; url: string; filename: string; path: string; received: number; total: number; status: DownloadStatus; startedAt: number }
export interface BrowserStore { version: 1; history: HistoryEntry[]; bookmarks: Bookmark[]; downloads: DownloadEntry[] }
export interface TabState { id: string; url: string; title: string; loading: boolean; fullscreen: boolean; canGoBack: boolean; canGoForward: boolean; zoom: number; error: string | null; find: { active: number; total: number } }
export interface BrowserState { tabs: TabState[]; activeId: string; store: BrowserStore; storageError: boolean }
export type BrowserShortcut = 'focus-address' | 'new-tab' | 'close-tab' | 'next-tab' | 'previous-tab' | 'back' | 'forward' | 'reload' | 'stop' | 'history' | 'downloads' | 'bookmark' | 'find' | 'zoom-in' | 'zoom-out' | 'zoom-reset' | `tab-${number}`;
export type BrowserCommand =
  | { type: 'new-tab'; input?: string }
  | { type: 'activate-tab' | 'close-tab'; id: string }
  | { type: 'navigate'; input: string }
  | { type: 'back' | 'forward' | 'reload' | 'stop' | 'bookmark' | 'focus-page' }
  | { type: 'zoom'; delta: -1 | 0 | 1 }
  | { type: 'find'; text: string; forward: boolean; next: boolean }
  | { type: 'stop-find' }
  | { type: 'delete-history'; url: string }
  | { type: 'clear-history' }
  | { type: 'restore'; kind: 'history' | 'bookmarks' | 'downloads' }
  | { type: 'rename-bookmark'; url: string; title: string }
  | { type: 'delete-bookmark'; url: string }
  | { type: 'cancel-download' | 'show-download' | 'remove-download'; id: string };
export interface ContentArea { top: number; hidden: boolean }

export interface HorizonAPI {
  getLanguage(): Promise<Language>;
  windowAction(action: WindowAction): Promise<void>;
  getState(): Promise<BrowserState>;
  capture(): Promise<Uint8Array | null>;
  command(command: BrowserCommand): Promise<void>;
  setContentArea(area: ContentArea): Promise<void>;
  onState(callback: (state: BrowserState) => void): () => void;
  onShortcut(callback: (shortcut: BrowserShortcut) => void): () => void;
}

export const IPC = {
  language: 'horizon:language',
  windowAction: 'horizon:window-action',
  state: 'horizon:state',
  capture: 'horizon:capture',
  command: 'horizon:command',
  contentArea: 'horizon:content-area',
  stateChanged: 'horizon:state-changed',
  shortcut: 'horizon:shortcut',
} as const;
