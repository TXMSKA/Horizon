import type { LyraCommand, LyraState } from './lyra';
import type { TranslateCommand, TranslateState, TranslationChoices } from './translate';
export type Language = 'en' | 'es';
export type VaultTimeout = 'close' | '5' | '15' | '60';
export interface VaultLogin { id: string; origin: string; title: string; username: string }
export interface VaultSuggestion { id: string; origin: string; x: number; y: number; width: number; locked: boolean; logins: VaultLogin[] }
export interface VaultState { available: boolean; created: boolean; unlocked: boolean; importAllowed: boolean; unlockMethod: 'hello' | 'master' | null; timeout: VaultTimeout; logins: VaultLogin[]; suggestion: VaultSuggestion | null; error: 'VAULT_UNAVAILABLE' | 'VAULT_STORAGE_UNAVAILABLE' | null; windows: boolean }
export type VaultCommand =
  | { type: 'vault-refresh' | 'vault-lock' | 'vault-hello' | 'vault-dismiss' }
  | { type: 'vault-unlock'; password: string }
  | { type: 'vault-import-permission'; password: string }
  | { type: 'vault-import-permission-hello' }
  | { type: 'vault-fill'; suggestion: string; id: string }
  | { type: 'vault-copy'; id: string; origin: string }
  | { type: 'vault-add'; title: string; website: string; username: string; password: string }
  | { type: 'set-vault-timeout'; value: VaultTimeout };
export type LanguageSetting = 'system' | Language;
export type OnStart = 'restore' | 'new-page';
export const SYNC_ITEMS = ['profiles', 'favorites', 'history', 'tabs', 'desktop', 'siteSettings', 'settings'] as const;
export type SyncItem = typeof SYNC_ITEMS[number];
export type SyncFailure = 'SYNC_INVALID' | 'SYNC_NEWER_FORMAT' | 'SYNC_WRONG_KEY' | 'SYNC_STORAGE' | 'SYNC_FOLDER' | 'SYNC_FULL' | 'SYNC_LIMIT' | 'SYNC_TIMEOUT' | 'SYNC_LOCKED' | 'SYNC_GAP' | 'SYNC_BLOB_PENDING' | 'SYNC_CHANGED';
export interface SyncComputerIdentity { id: string; name: string }
export interface SyncConflict { id: string; item: SyncItem; title: string; computer: SyncComputerIdentity; time: number; deleted: boolean }
export interface SyncRemoteWindow { profile: string; id: string; tabs: { title: string; url: string; group: string | null }[]; groups: { id: string; title: string }[] }
export interface SyncComputer extends SyncComputerIdentity { windows: SyncRemoteWindow[] }
export interface SyncState { configured: boolean; folderName: string | null; lastSynced: number | null; switches: Record<SyncItem, boolean>; failure: SyncFailure | null; conflicts: SyncConflict[]; computers: SyncComputer[]; syncing: boolean }
export type SyncCommand = { type: 'sync-create'; accepted: true } | { type: 'sync-join'; accepted: true; key: string }
  | { type: 'sync-set-item'; item: SyncItem; enabled: boolean } | { type: 'sync-now' } | { type: 'sync-reveal-key' } | { type: 'sync-save-key' }
  | { type: 'sync-leave'; removeOwnFiles: boolean } | { type: 'sync-restore-conflict' | 'sync-dismiss-conflict'; id: string };
export const SEARCH_ENGINES = {
  duckduckgo: { displayName: 'DuckDuckGo', searchPrefix: 'https://duckduckgo.com/?q=' },
  startpage: { displayName: 'Startpage', searchPrefix: 'https://www.startpage.com/sp/search?query=' },
  brave: { displayName: 'Brave', searchPrefix: 'https://search.brave.com/search?q=' },
  ecosia: { displayName: 'Ecosia', searchPrefix: 'https://www.ecosia.org/search?q=' },
  bing: { displayName: 'Bing', searchPrefix: 'https://www.bing.com/search?q=' },
  google: { displayName: 'Google', searchPrefix: 'https://www.google.com/search?q=' },
} as const;
export type SearchEngine = keyof typeof SEARCH_ENGINES;
export type SettingsSection = 'general' | 'appearance' | 'privacy' | 'privacy/sites' | 'profiles' | 'extensions' | 'sync';
export type DefaultBrowserStatus = 'default' | 'notDefault' | 'developmentBuild' | 'unsupported';
export type UpdateState = { status: 'unavailable' | 'idle' | 'checking' | 'upToDate' | 'ready' | 'error' } | { status: 'downloading'; percent: number };
export interface ClearedBrowsingData { history: boolean; cookies: boolean; cache: boolean }
export const IMPORT_BROWSERS = ['edge', 'chrome', 'brave', 'vivaldi', 'chromium', 'opera', 'opera-gx', 'firefox'] as const;
export type ImportBrowser = typeof IMPORT_BROWSERS[number];
export const IMPORT_SETTINGS = ['onStart', 'downloadsFolder', 'askWhereToSave', 'blockThirdPartyCookies', 'language', 'theme', 'darkPages', 'clearHistoryOnClose', 'clearCacheOnClose'] as const;
export type ImportSettingName = typeof IMPORT_SETTINGS[number];
export interface ImportSettingsSummary { names: ImportSettingName[]; sitePermissions: number; translations: number }
export interface ImportProfile { id: string; name: string; favorites: boolean; history: boolean; searchEngine: SearchEngine | null; settings: ImportSettingsSummary | null }
export interface ImportSource { browser: ImportBrowser; name: string; profiles: ImportProfile[] }
export interface ImportResult { favorites: number; history: number; skipped: number; searchEngine: SearchEngine | null; settings: ImportSettingsSummary }
export interface ImportPasswordsFile { id: string; name: string }
export interface ImportPasswordsResult { imported: number; duplicates: number; skipped: number }
export interface ImportProgress { current: number; total: number }
export type SettingsError = 'SETTINGS_COMMAND_INVALID' | 'SETTINGS_TAB_LIMIT' | 'SITE_SETTINGS_SAVE_FAILED' | 'SETTINGS_SAVE_FAILED' | 'SEARCH_ENGINE_INVALID' | 'LANGUAGE_INVALID' | 'DOWNLOADS_FOLDER_INVALID' | 'DOWNLOADS_FOLDER_PICK_FAILED' | 'ASK_WHERE_TO_SAVE_INVALID' | 'BLOCK_ADS_INVALID' | 'BLOCK_THIRD_PARTY_COOKIES_INVALID' | 'PROFILE_SETTINGS_SAVE_FAILED' | 'CLEAR_IN_PROGRESS' | 'CLEAR_HISTORY_FAILED' | 'CLEAR_SITE_DATA_FAILED' | 'CLEAR_CACHE_FAILED' | 'DEFAULT_BROWSER_UNSUPPORTED' | 'DEFAULT_BROWSER_DEVELOPMENT_BUILD' | 'DEFAULT_BROWSER_REGISTRATION_FAILED' | 'DEFAULT_BROWSER_SETTINGS_FAILED' | 'IMPORT_COMMAND_INVALID' | 'IMPORT_IN_PROGRESS' | 'IMPORT_SOURCE_NOT_FOUND' | 'IMPORT_NO_CHOICE' | 'IMPORT_FILE_LOCKED' | 'IMPORT_FILE_TOO_LARGE' | 'IMPORT_FILE_INVALID' | 'IMPORT_HISTORY_FAILED' | 'IMPORT_SETTINGS_FAILED' | 'IMPORT_STORAGE_FAILED' | 'IMPORT_PASSWORDS_NO_FILE' | 'IMPORT_PASSWORDS_FILE_INVALID' | 'IMPORT_PASSWORDS_FILE_TOO_LARGE' | 'IMPORT_PASSWORDS_FAILED' | 'IMPORT_PASSWORDS_DELETE_FAILED';
export type BuiltInTheme = 'system' | 'amber' | 'daylight';
export const MARKETPLACE_THEMES = ['fjord', 'dune', 'graphite', 'moss'] as const;
export type MarketplaceTheme = typeof MARKETPLACE_THEMES[number];
export type Theme = BuiltInTheme | MarketplaceTheme;
// Themes whose surfaces are light; every other theme is dark.
export const LIGHT_THEMES: readonly string[] = ['daylight', 'dune', 'moss'];
export type Contrast = 'standard' | 'high';
export const HUB_APPS = ['desktop', 'translate', 'themes'] as const;
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
export const GROUP_COLORS = ['success', 'info', 'primary', 'error', 'warning', 'soft', 'title', 'dim'] as const;
export type GroupColor = typeof GROUP_COLORS[number] | `#${string}`;
export interface TabGroup { id: string; name: string; color: GroupColor; icon: string | null; folded: boolean }

export interface HistoryEntry { url: string; title: string; lastVisit: number; visitCount: number }
export interface Bookmark { url: string; title: string; createdAt: number }
export interface FavoriteLink { kind: 'link'; id: string; url: string; title: string; createdAt: number }
export interface FavoriteFolder { kind: 'folder'; id: string; name: string; createdAt: number; children: FavoriteItem[] }
export type FavoriteItem = FavoriteLink | FavoriteFolder;
export interface FavoritesTree { bar: FavoriteItem[]; other: FavoriteItem[] }
export type FavoriteParent = 'bar' | 'other' | string;
export type DownloadStatus = 'progressing' | 'completed' | 'failed' | 'cancelled';
export interface DownloadEntry { id: string; url: string; filename: string; path: string; received: number; total: number; status: DownloadStatus; startedAt: number }
export const SITE_PERMISSIONS = ['camera', 'microphone', 'location', 'notifications', 'lyra'] as const;
export type SitePermission = typeof SITE_PERMISSIONS[number];
export type PermissionDecision = 'ask' | 'allow' | 'block';
export type PermissionDecisions = Record<SitePermission, PermissionDecision>;
export interface SiteSettingsStore { blocking: { host: string; enabled: boolean }[]; dark: { host: string; enabled: boolean }[]; permissions: ({ origin: string } & PermissionDecisions)[]; translation?: TranslationChoices }
export interface SiteSettings { host: string; origin: string; blocking: boolean; dark: boolean; permissions: PermissionDecisions }
export interface SiteSettingsEntry { host: string; origin: string; blocking: boolean | null; dark: boolean | null; permissions: PermissionDecisions }
export interface PermissionPrompt { id: string; origin: string; permissions: SitePermission[] }
export interface BlockedCounts { ads: number; trackers: number; cookies: number }
export interface BrowserStore { version: 5; history: HistoryEntry[]; favorites: FavoritesTree; downloads: DownloadEntry[]; siteSettings: SiteSettingsStore; clearHistoryOnClose: boolean; clearCacheOnClose: boolean }
export interface TabState { translation: TranslateState; id: string; groupId: string | null; movable: boolean; settings: SettingsSection | null; desktop: string | null; desktopItem: string | null; url: string; title: string; favicon: string | null; loading: boolean; fullscreen: boolean; canGoBack: boolean; canGoForward: boolean; zoom: number; error: string | null; find: { active: number; total: number }; blocked: BlockedCounts }
export interface BrowserState { sync: SyncState; vault: VaultState; lyra: LyraState; extensions: ExtensionState[]; extensionWarning: ExtensionWarning | null; extensionsUpdating: boolean; extensionsError: boolean; firstRun: boolean; importProgress: ImportProgress | null; groups: TabGroup[]; groupEditorId: string | null; privateWindow: boolean; canReopenTab: boolean; onStart: OnStart; showCapture: boolean; version: string; update: UpdateState; quickAccess: HubApp[]; searchEngine: SearchEngine; languageSetting: LanguageSetting; language: Language; downloadsFolder: string; downloadsFolderDefault: boolean; downloadsFolderUnavailable: boolean; askWhereToSave: boolean; blockAds: boolean; blockThirdPartyCookies: boolean; clearHistoryOnClose: boolean; clearCacheOnClose: boolean; sites: SiteSettingsEntry[]; clearingBrowsingData: boolean; defaultBrowser: DefaultBrowserStatus; projects: ProjectSummary[]; captures: CaptureSummary[]; desktopPanel: DesktopPanelState; projectInUse: string | null; desktopVersion: number; desktopReadError: boolean; desktopLocked: boolean; desktopStorageError: boolean; profiles: ProfileState[]; activeProfileId: string; tabs: TabState[]; activeId: string; store: BrowserStore; storageError: boolean; storageReadError: boolean; installedThemes: MarketplaceTheme[]; theme: Theme; contrast: Contrast; darkPages: DarkPagesState; blockingReady: boolean; siteSettings: SiteSettings | null; permissionPrompt: PermissionPrompt | null }
export type ContextMenuItemId = 'add-to-desktop' | 'open-link' | 'copy-link' | 'open-image' | 'save-image' | 'copy-image' | 'copy-image-address' | 'copy' | 'search-selection' | 'undo' | 'redo' | 'cut' | 'paste' | 'select-all' | 'back' | 'forward' | 'reload' | `spell:${string}` | `extension:${string}`;
export interface ContextMenuItem { id: ContextMenuItemId; enabled: boolean; label?: string; checked?: boolean }
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
export type BrowserCommand = VaultCommand | SyncCommand
  | { type: 'set-extension-enabled'; id: string; enabled: boolean }
  | { type: 'set-extension-pinned'; id: string; pinned: boolean }
  | { type: 'remove-extension'; id: string }
  | { type: 'open-extension'; id: string; anchor?: CaptureRect }
  | { type: 'check-extension-updates' }
  | { type: 'answer-extension-install'; id: string; allow: boolean }
  | TranslateCommand
  | LyraCommand
  | { type: 'set-on-start'; value: OnStart }
  | { type: 'new-window' | 'new-private-window' | 'reopen-tab' | 'home' | 'reload-no-cache' | 'print' }
  | { type: 'pin-app' | 'unpin-app'; id: HubApp }
  | { type: 'open-settings'; section: SettingsSection }
  | { type: 'set-search-engine'; value: SearchEngine }
  | { type: 'set-language'; value: LanguageSetting }
  | { type: 'set-ask-where-to-save' | 'set-block-ads' | 'set-block-third-party-cookies' | 'set-clear-history-on-close' | 'set-clear-cache-on-close'; value: boolean }
  | { type: 'choose-downloads-folder' | 'reset-downloads-folder' | 'register-default-browser' | 'restart-to-update' }
  | { type: 'clear-browsing-data'; history: boolean; cookies: boolean; cache: boolean }
  | { type: 'list-import-sources' }
  | { type: 'import-browser-data'; browser: ImportBrowser; profile: string; favorites: boolean; history: boolean; searchEngine: boolean; settings: boolean }
  | { type: 'choose-import-passwords-file' }
  | { type: 'import-passwords'; browser: ImportBrowser; file: string }
  | { type: 'delete-import-passwords-file'; file: string }
  | { type: 'finish-first-run' }
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
  | { type: 'save-capture-file'; id: string }
  | { type: 'set-show-capture'; value: boolean }
  | { type: 'set-blocking'; enabled: boolean }
  | { type: 'set-site-dark'; enabled: boolean }
  | { type: 'set-site-permission'; permission: SitePermission; decision: PermissionDecision }
  | { type: 'answer-permission'; id: string; answer: 'allow' | 'block' | 'dismiss' }
  | { type: 'switch-profile' | 'delete-profile'; id: string }
  | { type: 'create-profile'; name: string; color: ProfileColor }
  | { type: 'update-profile'; id: string; name: string; color: ProfileColor }
  | { type: 'install-theme' | 'remove-theme'; id: MarketplaceTheme }
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
  | { type: 'create-tab-group' | 'remove-tab-from-group' | 'open-tab-group-editor' | 'close-tab-group-editor'; id: string }
  | { type: 'add-tab-to-group'; id: string; group: string }
  | { type: 'update-tab-group'; id: string; name?: string; color?: GroupColor; icon?: string | null }
  | { type: 'set-tab-group-folded'; id: string; folded: boolean }
  | { type: 'move-tab-to-window'; id: string; point?: { x: number; y: number } }
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
export interface ExtensionState { id: string; name: string; description: string; version: string; enabled: boolean; pinned: boolean; icon: number[] | null; action?: { title: string; badge: string; icon: number[] | null }; unsupported: string[]; permissions: string[]; failed: boolean }
export interface ExtensionWarning { requestId: string; id: string; name: string; unsupported: string[]; permissions: string[] }

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
  command(command: Extract<BrowserCommand, { type: 'list-import-sources' }>): Promise<ImportSource[]>;
  command(command: Extract<BrowserCommand, { type: 'sync-reveal-key' }>): Promise<string>;
  command(command: Extract<BrowserCommand, { type: 'sync-save-key' }>): Promise<boolean>;
  command(command: Extract<BrowserCommand, { type: 'import-browser-data' }>): Promise<ImportResult>;
  command(command: Extract<BrowserCommand, { type: 'choose-import-passwords-file' }>): Promise<ImportPasswordsFile | null>;
  command(command: Extract<BrowserCommand, { type: 'import-passwords' }>): Promise<ImportPasswordsResult>;
  command(command: Extract<BrowserCommand, { type: 'save-capture-file' }>): Promise<boolean>;
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
