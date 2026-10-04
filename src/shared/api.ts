export type Language = 'en' | 'es';
export type LanguageSetting = 'system' | Language;
export type OnStart = 'restore' | 'new-page';
export const SEARCH_ENGINES = {
  duckduckgo: { displayName: 'DuckDuckGo', searchPrefix: 'https://duckduckgo.com/?q=' },
  startpage: { displayName: 'Startpage', searchPrefix: 'https://www.startpage.com/sp/search?query=' },
  brave: { displayName: 'Brave', searchPrefix: 'https://search.brave.com/search?q=' },
  ecosia: { displayName: 'Ecosia', searchPrefix: 'https://www.ecosia.org/search?q=' },
  bing: { displayName: 'Bing', searchPrefix: 'https://www.bing.com/search?q=' },
  google: { displayName: 'Google', searchPrefix: 'https://www.google.com/search?q=' },
} as const;
export type SearchEngine = keyof typeof SEARCH_ENGINES;
export type SettingsSection = 'general' | 'appearance' | 'privacy' | 'privacy/sites' | 'profiles';
export type DefaultBrowserStatus = 'default' | 'notDefault' | 'developmentBuild' | 'unsupported';
export interface ClearedBrowsingData { history: boolean; cookies: boolean; cache: boolean }
export type SettingsError = 'SETTINGS_COMMAND_INVALID' | 'SETTINGS_TAB_LIMIT' | 'SITE_SETTINGS_SAVE_FAILED' | 'SETTINGS_SAVE_FAILED' | 'SEARCH_ENGINE_INVALID' | 'LANGUAGE_INVALID' | 'DOWNLOADS_FOLDER_INVALID' | 'DOWNLOADS_FOLDER_PICK_FAILED' | 'ASK_WHERE_TO_SAVE_INVALID' | 'BLOCK_ADS_INVALID' | 'BLOCK_THIRD_PARTY_COOKIES_INVALID' | 'PROFILE_SETTINGS_SAVE_FAILED' | 'CLEAR_IN_PROGRESS' | 'CLEAR_HISTORY_FAILED' | 'CLEAR_SITE_DATA_FAILED' | 'CLEAR_CACHE_FAILED' | 'DEFAULT_BROWSER_UNSUPPORTED' | 'DEFAULT_BROWSER_DEVELOPMENT_BUILD' | 'DEFAULT_BROWSER_REGISTRATION_FAILED' | 'DEFAULT_BROWSER_SETTINGS_FAILED';
export type Theme = 'system' | 'amber' | 'daylight';
export type Contrast = 'standard' | 'high';
export const HUB_APPS = ['desktop', 'themes'] as const;
export type HubApp = typeof HUB_APPS[number];
export const QUICK_ACCESS_LIMIT = 6;
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
export interface FavoriteLink { kind: 'link'; id: string; url: string; title: string; createdAt: number }
export interface FavoriteFolder { kind: 'folder'; id: string; name: string; createdAt: number; children: FavoriteItem[] }
export type FavoriteItem = FavoriteLink | FavoriteFolder;
export interface FavoritesTree { bar: FavoriteItem[]; other: FavoriteItem[] }
export type FavoriteParent = 'bar' | 'other' | string;
export type DownloadStatus = 'progressing' | 'completed' | 'failed' | 'cancelled';
export interface DownloadEntry { id: string; url: string; filename: string; path: string; received: number; total: number; status: DownloadStatus; startedAt: number }
export const SITE_PERMISSIONS = ['camera', 'microphone', 'location', 'notifications'] as const;
export type SitePermission = typeof SITE_PERMISSIONS[number];
export type PermissionDecision = 'ask' | 'allow' | 'block';
export type PermissionDecisions = Record<SitePermission, PermissionDecision>;
export interface SiteSettingsStore { blocking: { host: string; enabled: boolean }[]; dark: { host: string; enabled: boolean }[]; permissions: ({ origin: string } & PermissionDecisions)[] }
export interface SiteSettings { host: string; origin: string; blocking: boolean; dark: boolean; permissions: PermissionDecisions }
export interface SiteSettingsEntry { host: string; origin: string; blocking: boolean | null; dark: boolean | null; permissions: PermissionDecisions }
export interface PermissionPrompt { id: string; origin: string; permissions: SitePermission[] }
export interface BlockedCounts { ads: number; trackers: number; cookies: number }
export interface BrowserStore { version: 5; history: HistoryEntry[]; favorites: FavoritesTree; downloads: DownloadEntry[]; siteSettings: SiteSettingsStore; clearHistoryOnClose: boolean; clearCacheOnClose: boolean }
export interface TabState { id: string; settings: SettingsSection | null; desktop: string | null; desktopItem: string | null; url: string; title: string; favicon: string | null; loading: boolean; fullscreen: boolean; canGoBack: boolean; canGoForward: boolean; zoom: number; error: string | null; find: { active: number; total: number }; blocked: BlockedCounts }
export interface BrowserState { privateWindow: boolean; canReopenTab: boolean; onStart: OnStart; showCapture: boolean; version: string; quickAccess: HubApp[]; searchEngine: SearchEngine; languageSetting: LanguageSetting; language: Language; downloadsFolder: string; downloadsFolderDefault: boolean; downloadsFolderUnavailable: boolean; askWhereToSave: boolean; blockAds: boolean; blockThirdPartyCookies: boolean; clearHistoryOnClose: boolean; clearCacheOnClose: boolean; sites: SiteSettingsEntry[]; clearingBrowsingData: boolean; defaultBrowser: DefaultBrowserStatus; projects: ProjectSummary[]; captures: CaptureSummary[]; desktopPanel: DesktopPanelState; projectInUse: string | null; desktopVersion: number; desktopReadError: boolean; desktopLocked: boolean; desktopStorageError: boolean; profiles: ProfileState[]; activeProfileId: string; tabs: TabState[]; activeId: string; store: BrowserStore; storageError: boolean; storageReadError: boolean; theme: Theme; contrast: Contrast; darkPages: DarkPagesState; blockingReady: boolean; siteSettings: SiteSettings | null; permissionPrompt: PermissionPrompt | null }
export type ContextMenuItemId = 'add-to-desktop' | 'open-link' | 'copy-link' | 'open-image' | 'save-image' | 'copy-image' | 'copy-image-address' | 'copy' | 'search-selection' | 'undo' | 'redo' | 'cut' | 'paste' | 'select-all' | 'back' | 'forward' | 'reload' | `spell:${string}`;
export interface ContextMenuItem { id: ContextMenuItemId; enabled: boolean }
export interface PageContextMenu { id: string; x: number; y: number; keyboard: boolean; groups: ContextMenuItem[][]; selection?: string }
export type BrowserShortcut = 'new-window' | 'new-private-window' | 'reopen-tab' | 'focus-search' | 'home' | 'clear-browsing-data' | 'reload-no-cache' | 'find-next' | 'find-previous' | 'print' | 'menu' | 'capture' | 'focus-address' | 'new-tab' | 'close-tab' | 'next-tab' | 'previous-tab' | 'back' | 'forward' | 'reload' | 'stop' | 'history' | 'downloads' | 'favorites' | 'fullscreen' | 'bookmark' | 'find' | 'zoom-in' | 'zoom-out' | 'zoom-reset' | `tab-${number}`;
export type DesktopItemKind = 'note' | 'text' | 'area' | 'page' | 'link';
export interface CaptureRect { x: number; y: number; width: number; height: number }
export interface CaptureShot { id: string; bytes: Uint8Array; width: number; height: number; cut: boolean }
export interface CaptureImage { filename: string; width: number; height: number; bytes: number; cut: boolean }
export interface DesktopItem { id: string; folder: string | null; kind: DesktopItemKind; title: string; text: string; note: string; source: { url: string; title: string } | null; image: CaptureImage | null; createdAt: number; updatedAt: number }
export interface ProjectFolder { id: string; name: string; createdAt: number }
export interface Project { id: string; name: string; createdAt: number; updatedAt: number; usedAt: number; folders: ProjectFolder[]; items: DesktopItem[] }
export interface ProjectSummary { id: string; name: string; pages: number; notes: number; captures: number; folders: (ProjectFolder & { count: number })[]; updatedAt: number; usedAt: number; latest: Pick<DesktopItem, 'id' | 'folder' | 'kind' | 'title' | 'source' | 'createdAt' | 'updatedAt'>[] }
export type DesktopItemContent = Omit<DesktopItem, 'image'> & { image: Omit<CaptureImage, 'filename'> | null };
export type ProjectContent = Omit<Project, 'items'> & { items: DesktopItemContent[] };
export type CaptureSummary = Pick<DesktopItem, 'id' | 'title' | 'source' | 'createdAt'>;
export type DesktopPanelPage = { kind: 'home' | 'captures' | 'new-project' } | { kind: 'project'; project: string; folder?: string | null } | { kind: 'item'; project: string | null; id: string };
export interface DesktopPanelState { open: boolean; page: DesktopPanelPage }
export type DesktopError = 'DESKTOP_COMMAND_INVALID' | 'DESKTOP_LOCKED' | 'FOLDER_NAME_INVALID' | 'FOLDER_NAME_EMPTY' | 'FOLDER_NAME_LONG' | 'FOLDER_NAME_DUPLICATE' | 'FOLDER_LIMIT' | 'FOLDER_NOT_FOUND' | 'CAPTURE_LIMIT' | 'LINK_INVALID' | 'TEXT_INVALID' | 'DESKTOP_NOT_FOUND' | 'PROJECT_NAME_INVALID' | 'PROJECT_NAME_EMPTY' | 'PROJECT_NAME_LONG' | 'PROJECT_NAME_DUPLICATE' | 'PROJECT_ADDRESS_CONFLICT' | 'PROJECT_LIMIT' | 'PROJECT_ITEM_LIMIT' | 'PROJECT_NOT_FOUND' | 'DESKTOP_ITEM_NOT_FOUND' | 'DESKTOP_ITEM_INVALID' | 'DESKTOP_STORAGE_FAILED' | 'DESKTOP_STORAGE_FULL' | 'CAPTURE_TOO_LARGE' | 'CAPTURE_UNAVAILABLE' | 'CAPTURE_CHANGED' | 'CAPTURE_AREA_SMALL' | 'CAPTURE_PAGE_HIDDEN' | 'CAPTURE_TIMEOUT' | 'CAPTURE_FAILED' | 'CAPTURE_LOADING' | 'CAPTURE_CRASHED' | 'CAPTURE_DESKTOP' | 'CAPTURE_SETTINGS';
export type BrowserCommand =
  | { type: 'set-on-start'; value: OnStart }
  | { type: 'new-window' | 'new-private-window' | 'reopen-tab' | 'home' | 'reload-no-cache' | 'print' }
  | { type: 'pin-app' | 'unpin-app'; id: HubApp }
  | { type: 'open-settings'; section: SettingsSection }
  | { type: 'set-search-engine'; value: SearchEngine }
  | { type: 'set-language'; value: LanguageSetting }
  | { type: 'set-ask-where-to-save' | 'set-block-ads' | 'set-block-third-party-cookies' | 'set-clear-history-on-close' | 'set-clear-cache-on-close'; value: boolean }
  | { type: 'choose-downloads-folder' | 'reset-downloads-folder' | 'register-default-browser' }
  | { type: 'clear-browsing-data'; history: boolean; cookies: boolean; cache: boolean }
  | { type: 'reset-site'; host: string }
  | { type: 'retry-desktop-storage' }
  | { type: 'create-project'; name: string }
  | { type: 'rename-project'; id: string; name: string }
  | { type: 'delete-project' | 'set-project'; id: string }
  | { type: 'open-desktop'; id: string; item?: string }
  | { type: 'open-desktop-panel'; page: DesktopPanelPage }
  | { type: 'close-desktop-panel' }
  | { type: 'create-folder'; project: string; name: string }
  | { type: 'rename-folder'; project: string; id: string; name: string }
  | { type: 'delete-folder'; project: string; id: string }
  | { type: 'move-item-folder'; project: string; id: string; folder: string | null }
  | { type: 'move-item-project'; project: string; id: string; toProject: string; folder: string | null }
  | { type: 'add-capture-to-project'; id: string; project: string; folder: string | null }
  | { type: 'add-link'; address: string; title: string; project: string; folder: string | null }
  | { type: 'add-text'; text: string; source: { url: string; title: string } | null; project: string; folder: string | null }
  | { type: 'delete-capture'; id: string }
  | { type: 'add-note'; project: string; title: string; text: string; folder?: string | null }
  | { type: 'update-item'; project: string | null; id: string; title?: string; text?: string; note?: string }
  | { type: 'delete-item'; project: string; id: string }
  | { type: 'take-capture' }
  | { type: 'capture-full-page' | 'capture-screen'; id: string }
  | { type: 'edit-capture' | 'copy-capture'; id: string; rect?: CaptureRect }
  | { type: 'set-show-capture'; value: boolean }
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
  | { type: 'add-favorite'; url: string; title: string; parent: FavoriteParent; position: number }
  | { type: 'create-favorite-folder'; name: string; parent: FavoriteParent; position: number }
  | { type: 'rename-favorite'; id: string; name: string }
  | { type: 'move-favorite'; id: string; parent: FavoriteParent; position: number }
  | { type: 'delete-favorite' | 'open-favorite-new-tab'; id: string }
  | { type: 'open-favorite'; id: string; background?: boolean }
  | { type: 'open-all-favorites'; id: FavoriteParent }
  | { type: 'back' | 'forward' | 'reload' | 'stop' | 'bookmark' | 'focus-page' | 'fullscreen' }
  | { type: 'zoom'; delta: -1 | 0 | 1 }
  | { type: 'find'; text: string; forward: boolean; next: boolean }
  | { type: 'stop-find' }
  | { type: 'delete-history'; url: string }
  | { type: 'clear-history' }
  | { type: 'restore'; kind: 'history' | 'bookmarks' | 'downloads' | 'desktop' }
  | { type: 'rename-bookmark'; url: string; title: string }
  | { type: 'delete-bookmark'; url: string }
  | { type: 'cancel-download' | 'show-download' | 'remove-download' | 'retry-download'; id: string };
export interface ContentArea { top: number; hidden: boolean }

export interface HorizonAPI {
  readonly initialTheme: Theme;
  readonly initialContrast: Contrast;
  readonly themeMigration: boolean;
  getLanguage(): Promise<Language>;
  windowAction(action: WindowAction): Promise<void>;
  getState(): Promise<BrowserState>;
  capture(): Promise<Uint8Array | null>;
  getProject(id: string): Promise<ProjectContent>;
  getCaptures(): Promise<DesktopItemContent[]>;
  getCaptureImage(project: string | null, item: string): Promise<Uint8Array | null>;
  getFavicon(id: string, hash: string): Promise<Uint8Array | null>;
  command(command: Extract<BrowserCommand, { type: 'clear-browsing-data' }>): Promise<ClearedBrowsingData>;
  command(command: Extract<BrowserCommand, { type: 'take-capture' | 'capture-full-page' | 'capture-screen' | 'edit-capture' | 'copy-capture' }>): Promise<CaptureShot>;
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
  project: 'horizon:project',
  captures: 'horizon:captures',
  captureImage: 'horizon:capture-image',
  command: 'horizon:command',
  contentArea: 'horizon:content-area',
  stateChanged: 'horizon:state-changed',
  shortcut: 'horizon:shortcut',
  contextMenu: 'horizon:context-menu',
} as const;
