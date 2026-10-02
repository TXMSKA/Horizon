export type Language = 'en' | 'es';
export type Theme = 'system' | 'amber' | 'daylight';
export type Contrast = 'standard' | 'high';
export type DarkPagesMode = 'off' | 'on' | 'system';
export type DarkStrength = 'soft' | 'standard' | 'deep';
export type DarkTone = 'neutral' | 'warm';
export interface DarkPagesState { mode: DarkPagesMode; strength: DarkStrength; tone: DarkTone; active: boolean }
export type WindowAction = 'minimize' | 'maximize' | 'close';
export const PROFILE_COLORS = ['amber', 'blue', 'green', 'red', 'yellow', 'grey', 'purple', 'cyan'] as const;
export type ProfileColor = typeof PROFILE_COLORS[number];
export interface Profile { id: string; name: string; color: ProfileColor; partition: string; createdAt: number }
export interface ProfileState { id: string; name: string; color: ProfileColor; tabCount: number }

export interface HistoryEntry { url: string; title: string; lastVisit: number; visitCount: number }
export interface Bookmark { url: string; title: string; createdAt: number }
export type DownloadStatus = 'progressing' | 'completed' | 'failed' | 'cancelled';
export interface DownloadEntry { id: string; url: string; filename: string; path: string; received: number; total: number; status: DownloadStatus; startedAt: number }
export const SITE_PERMISSIONS = ['camera', 'microphone', 'location', 'notifications'] as const;
export type SitePermission = typeof SITE_PERMISSIONS[number];
export type PermissionDecision = 'ask' | 'allow' | 'block';
export type PermissionDecisions = Record<SitePermission, PermissionDecision>;
export interface SiteSettingsStore { blocking: { host: string; enabled: boolean }[]; dark: { host: string; enabled: boolean }[]; permissions: ({ origin: string } & PermissionDecisions)[] }
export interface SiteSettings { host: string; origin: string; blocking: boolean; dark: boolean; permissions: PermissionDecisions }
export interface PermissionPrompt { id: string; origin: string; permissions: SitePermission[] }
export interface BlockedCounts { ads: number; trackers: number; cookies: number }
export interface BrowserStore { version: 3; history: HistoryEntry[]; bookmarks: Bookmark[]; downloads: DownloadEntry[]; siteSettings: SiteSettingsStore }
export interface TabState { id: string; url: string; title: string; favicon: string | null; loading: boolean; fullscreen: boolean; canGoBack: boolean; canGoForward: boolean; zoom: number; error: string | null; find: { active: number; total: number }; blocked: BlockedCounts }
export interface BrowserState { profiles: ProfileState[]; activeProfileId: string; tabs: TabState[]; activeId: string; store: BrowserStore; storageError: boolean; storageReadError: boolean; theme: Theme; contrast: Contrast; darkPages: DarkPagesState; blockingReady: boolean; siteSettings: SiteSettings | null; permissionPrompt: PermissionPrompt | null }
export type ContextMenuItemId = 'open-link' | 'copy-link' | 'open-image' | 'save-image' | 'copy-image' | 'copy-image-address' | 'copy' | 'search-selection' | 'undo' | 'redo' | 'cut' | 'paste' | 'select-all' | 'back' | 'forward' | 'reload' | `spell:${string}`;
export interface ContextMenuItem { id: ContextMenuItemId; enabled: boolean }
export interface PageContextMenu { id: string; x: number; y: number; keyboard: boolean; groups: ContextMenuItem[][]; selection?: string }
export type BrowserShortcut = 'focus-address' | 'new-tab' | 'close-tab' | 'next-tab' | 'previous-tab' | 'back' | 'forward' | 'reload' | 'stop' | 'history' | 'downloads' | 'bookmark' | 'find' | 'zoom-in' | 'zoom-out' | 'zoom-reset' | `tab-${number}`;
export type BrowserCommand =
  | { type: 'set-blocking'; enabled: boolean }
  | { type: 'set-site-dark'; enabled: boolean }
  | { type: 'set-site-permission'; permission: SitePermission; decision: PermissionDecision }
  | { type: 'answer-permission'; id: string; answer: 'allow' | 'block' | 'dismiss' }
  | { type: 'switch-profile' | 'delete-profile'; id: string }
  | { type: 'create-profile'; name: string; color: ProfileColor }
  | { type: 'update-profile'; id: string; name: string; color: ProfileColor }
  | { type: 'theme' | 'migrate-theme'; value: Theme }
  | { type: 'contrast'; value: Contrast }
  | { type: 'dark-pages'; value: DarkPagesMode }
  | { type: 'dark-strength'; value: DarkStrength }
  | { type: 'dark-tone'; value: DarkTone }
  | { type: 'new-tab'; input?: string; background?: boolean }
  | { type: 'context-menu'; id: string; item: ContextMenuItemId }
  | { type: 'dismiss-context-menu'; id: string }
  | { type: 'open-downloads-folder' }
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
  readonly initialTheme: Theme;
  readonly initialContrast: Contrast;
  readonly themeMigration: boolean;
  getLanguage(): Promise<Language>;
  windowAction(action: WindowAction): Promise<void>;
  getState(): Promise<BrowserState>;
  capture(): Promise<Uint8Array | null>;
  getFavicon(id: string, hash: string): Promise<Uint8Array | null>;
  command(command: BrowserCommand): Promise<void>;
  setContentArea(area: ContentArea): Promise<void>;
  onState(callback: (state: BrowserState) => void): () => void;
  onShortcut(callback: (shortcut: BrowserShortcut) => void): () => void;
  onContextMenu(callback: (menu: PageContextMenu | null) => void): () => void;
}

export const IPC = {
  language: 'horizon:language',
  windowAction: 'horizon:window-action',
  state: 'horizon:state',
  capture: 'horizon:capture',
  favicon: 'horizon:favicon',
  command: 'horizon:command',
  contentArea: 'horizon:content-area',
  stateChanged: 'horizon:state-changed',
  shortcut: 'horizon:shortcut',
  contextMenu: 'horizon:context-menu',
} as const;
