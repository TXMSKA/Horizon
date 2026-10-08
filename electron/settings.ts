import { existsSync, lstatSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute } from 'node:path';
import { randomUUID } from 'node:crypto';
import { HUB_APPS, MARKETPLACE_THEMES, QUICK_ACCESS_LIMIT, SEARCH_ENGINES } from '../src/shared/api';
import type { BuiltInTheme, MarketplaceTheme, Contrast, DarkPagesMode, DarkStrength, DarkTone, HubApp, Language, LanguageSetting, OnStart, SearchEngine, Theme, VaultTimeout } from '../src/shared/api';
import { syncSettings, validateSyncSettings } from './sync-model';
import type { SyncSettings } from './sync-model';

interface LegacySettings { version: 1; theme: Theme; contrast?: Contrast }
interface SettingsV2 { version: 2; theme: Theme; contrast: Contrast; darkPages: DarkPagesMode; darkStrength: DarkStrength; darkTone: DarkTone }
interface SettingsV3 extends Omit<SettingsV2, 'version'> { version: 3; searchEngine: SearchEngine; language: LanguageSetting; downloadsFolder: string | null; askWhereToSave: boolean; blockAds: boolean; blockThirdPartyCookies: boolean }
interface SettingsV4 extends Omit<SettingsV3, 'version'> { version: 4; quickAccess: HubApp[] }
interface SettingsV5 extends Omit<SettingsV4, 'version'> { version: 5; showCapture: boolean }
interface SettingsV6 extends Omit<SettingsV5, 'version'> { version: 6; onStart: OnStart }
interface MarketplaceSettings { installed: MarketplaceTheme[]; builtIn: BuiltInTheme; contrast: Contrast }
// Older version 7 files have no catalog state or Vault timeout; each is added when first set.
export interface Settings extends Omit<SettingsV6, 'version'> { version: 7; onboarded: boolean; marketplace?: MarketplaceSettings; vaultTimeout?: VaultTimeout }
export interface ThemeSettings extends Readonly<Omit<Settings, 'version'>> {
  readonly installedThemes: MarketplaceTheme[];
  installTheme(id: MarketplaceTheme): void; removeTheme(id: MarketplaceTheme): void;
  readonly migrationAllowed: boolean;
  readonly downloadsFolderUnavailable: boolean;
  setTheme(value: Theme, migrate: boolean): void; setContrast(value: Contrast): void; setDarkPages(value: DarkPagesMode): void; setDarkStrength(value: DarkStrength): void; setDarkTone(value: DarkTone): void;
  setSearchEngine(value: SearchEngine): void; setLanguage(value: LanguageSetting): void; setDownloadsFolder(value: string | null): void;
  setAskWhereToSave(value: boolean): void; setBlockAds(value: boolean): void; setBlockThirdPartyCookies(value: boolean): void;
  setAppPinned(id: HubApp, pinned: boolean): void;
  setShowCapture(value: boolean): void;
  setOnStart(value: OnStart): void;
  setVaultTimeout(value: VaultTimeout): void;
  finishFirstRun(): void;
  syncSnapshot(): SyncSettings;
  applySync(value: SyncSettings): void;
}
export function isVaultTimeout(value: unknown): value is VaultTimeout { return ['close', '5', '15', '60'].includes(value as string); }
export function isOnStart(value: unknown): value is OnStart { return value === 'restore' || value === 'new-page'; }
export function isHubApp(value: unknown): value is HubApp { return typeof value === 'string' && HUB_APPS.includes(value as HubApp); }
export function isQuickAccess(value: unknown): value is HubApp[] {
  return Array.isArray(value) && value.length <= QUICK_ACCESS_LIMIT && [...value].every(isHubApp) && new Set(value).size === value.length;
}
export function isBuiltInTheme(value: unknown): value is BuiltInTheme { return value === 'system' || value === 'amber' || value === 'daylight'; }
export function isMarketplaceTheme(value: unknown): value is MarketplaceTheme { return typeof value === 'string' && MARKETPLACE_THEMES.includes(value as MarketplaceTheme); }
export function isTheme(value: unknown): value is Theme { return isBuiltInTheme(value) || isMarketplaceTheme(value); }
export function isContrast(value: unknown): value is Contrast { return value === 'standard' || value === 'high'; }
export function isDarkPagesMode(value: unknown): value is DarkPagesMode { return value === 'off' || value === 'on' || value === 'system'; }
export function isDarkStrength(value: unknown): value is DarkStrength { return value === 'soft' || value === 'standard' || value === 'deep'; }
export function isDarkTone(value: unknown): value is DarkTone { return value === 'neutral' || value === 'warm'; }
export function isSearchEngine(value: unknown): value is SearchEngine { return typeof value === 'string' && Object.hasOwn(SEARCH_ENGINES, value); }
export function isLanguageSetting(value: unknown): value is LanguageSetting { return value === 'system' || value === 'en' || value === 'es'; }
export function resolveLanguage(setting: LanguageSetting, locale: string): Language { return setting === 'en' || setting === 'es' ? setting : locale.toLowerCase().split('-')[0] === 'es' ? 'es' : 'en'; }
function folderSyntax(value: unknown): value is string {
  return typeof value === 'string' && !!value && value.length <= 1024 && !/[\x00-\x1f\x7f-\x9f]/.test(value) && isAbsolute(value)
    && (process.platform !== 'win32' || /^[a-z]:[\\/]|^\\\\[^\\/]+[\\/][^\\/]+/i.test(value));
}
export function isDownloadsFolder(value: unknown): value is string {
  if (!folderSyntax(value)) return false;
  try { const entry = lstatSync(value); return entry.isDirectory() && !entry.isSymbolicLink(); } catch { return false; }
}
export function resolvedDownloadsFolder(settings: Pick<Settings, 'downloadsFolder'> & { downloadsFolderUnavailable?: boolean }, fallback: string) {
  const unavailable = settings.downloadsFolderUnavailable === true || settings.downloadsFolder !== null && !isDownloadsFolder(settings.downloadsFolder);
  return { downloadsFolder: unavailable || settings.downloadsFolder === null ? fallback : settings.downloadsFolder, downloadsFolderDefault: unavailable || settings.downloadsFolder === null, downloadsFolderUnavailable: unavailable };
}
function shape(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
function legacySettings(value: unknown): value is LegacySettings {
  return (shape(value, ['version', 'theme']) || shape(value, ['version', 'theme', 'contrast']) && isContrast(value.contrast)) && value.version === 1 && isBuiltInTheme(value.theme);
}
const V2_KEYS = ['version', 'theme', 'contrast', 'darkPages', 'darkStrength', 'darkTone'];
function themeFields(value: Record<string, unknown>): boolean { return isBuiltInTheme(value.theme) && isContrast(value.contrast) && isDarkPagesMode(value.darkPages) && isDarkStrength(value.darkStrength) && isDarkTone(value.darkTone); }
function v2Settings(value: unknown): value is SettingsV2 { return shape(value, V2_KEYS) && value.version === 2 && themeFields(value); }
function v3Settings(value: unknown): value is SettingsV3 {
  return shape(value, [...V2_KEYS, 'searchEngine', 'language', 'downloadsFolder', 'askWhereToSave', 'blockAds', 'blockThirdPartyCookies']) && value.version === 3 && themeFields(value)
    && isSearchEngine(value.searchEngine) && isLanguageSetting(value.language) && (value.downloadsFolder === null || folderSyntax(value.downloadsFolder))
    && ['askWhereToSave', 'blockAds', 'blockThirdPartyCookies'].every(key => typeof value[key] === 'boolean');
}
function v4Settings(value: unknown): value is SettingsV4 {
  if (!shape(value, [...V2_KEYS, 'searchEngine', 'language', 'downloadsFolder', 'askWhereToSave', 'blockAds', 'blockThirdPartyCookies', 'quickAccess']) || value.version !== 4 || !isQuickAccess(value.quickAccess)) return false;
  const previous = { ...value }; delete previous.quickAccess;
  return v3Settings({ ...previous, version: 3 });
}
function v5Settings(value: unknown): value is SettingsV5 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>, previous = { ...fields }; delete previous.showCapture;
  return Object.hasOwn(fields, 'version') && fields.version === 5 && Object.hasOwn(fields, 'showCapture') && typeof fields.showCapture === 'boolean' && v4Settings({ ...previous, version: 4 });
}
function v6Settings(value: unknown): value is SettingsV6 {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>, previous = { ...fields }; delete previous.onStart;
  return fields.version === 6 && Object.hasOwn(fields, 'onStart') && isOnStart(fields.onStart) && v5Settings({ ...previous, version: 5 });
}
function settingsShape(value: unknown): value is Settings {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const fields = value as Record<string, unknown>, previous = { ...fields }; delete previous.onboarded; delete previous.marketplace; delete previous.vaultTimeout;
  if (Object.hasOwn(fields, 'vaultTimeout') && !isVaultTimeout(fields.vaultTimeout)) return false;
  if (Object.hasOwn(fields, 'marketplace')) {
    const catalog = fields.marketplace;
    if (!shape(catalog, ['installed', 'builtIn', 'contrast']) || !isBuiltInTheme(catalog.builtIn) || !isContrast(catalog.contrast)
      || !Array.isArray(catalog.installed) || catalog.installed.length > MARKETPLACE_THEMES.length
      || !catalog.installed.every(isMarketplaceTheme) || new Set(catalog.installed).size !== catalog.installed.length) return false;
    if (isMarketplaceTheme(fields.theme) && catalog.installed.includes(fields.theme)) previous.theme = catalog.builtIn;
  }
  return fields.version === 7 && Object.hasOwn(fields, 'onboarded') && typeof fields.onboarded === 'boolean' && v6Settings({ ...previous, version: 6 });
}
export function validateSettings(value: unknown): value is Settings { return settingsShape(value) && (value.downloadsFolder === null || isDownloadsFolder(value.downloadsFolder)); }
export function writeSettings(path: string, settings: Settings): void {
  if (!validateSettings(settings)) throw new Error('Invalid settings');
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { mkdirSync(dirname(path), { recursive: true }); writeFileSync(temporary, JSON.stringify(settings), { flag: 'wx', mode: 0o600 }); renameSync(temporary, path); }
  catch { throw new Error('SETTINGS_SAVE_FAILED'); }
  finally { if (existsSync(temporary)) try { unlinkSync(temporary); } catch { /* Preserve the save failure. */ } }
}
export function readSettings(path: string, highContrast = false, status = { downloadsFolderUnavailable: false }): Settings {
  const empty: Settings = { version: 7, onboarded: false, onStart: 'restore', theme: 'system', contrast: 'standard', darkPages: 'off', darkStrength: 'standard', darkTone: 'neutral', searchEngine: 'duckduckgo', language: 'system', downloadsFolder: null, askWhereToSave: false, blockAds: true, blockThirdPartyCookies: true, quickAccess: [], showCapture: true };
  try {
    if (!existsSync(path)) { empty.contrast = highContrast ? 'high' : 'standard'; writeSettings(path, empty); return empty; }
    let settings: Settings, migrated = false;
    try {
      if (statSync(path).size > 4096) throw new Error('Settings exceed size limit');
      let value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      // A removed or unknown palette must not discard otherwise valid user settings.
      if (value && typeof value === 'object' && !Array.isArray(value)) {
        const fields = value as Record<string, unknown>, catalog = fields.marketplace as Partial<MarketplaceSettings> | undefined;
        if (!isTheme(fields.theme) || isMarketplaceTheme(fields.theme) && (!Array.isArray(catalog?.installed) || !catalog.installed.includes(fields.theme))) {
          value = { ...fields, theme: isBuiltInTheme(catalog?.builtIn) ? catalog.builtIn : 'system' }; migrated = true;
        }
      }
      // A settings file that predates the first-run step belongs to an install that has already started.
      if (legacySettings(value) || v2Settings(value) || v3Settings(value) || v4Settings(value) || v5Settings(value) || v6Settings(value)) { settings = { ...empty, ...value, version: 7, onboarded: true }; migrated = true; }
      else if (settingsShape(value)) settings = value;
      else throw new Error('Invalid settings');
    } catch { renameSync(path, `${path}.corrupt-${randomUUID()}`); writeSettings(path, empty); return empty; }
    if (settings.downloadsFolder !== null && !isDownloadsFolder(settings.downloadsFolder)) { status.downloadsFolderUnavailable = true; settings = { ...settings, downloadsFolder: null }; }
    if (migrated) try { writeSettings(path, settings); } catch { /* Keep valid migrated values in memory on a read-only disk. */ }
    return settings;
  } catch { /* Defaults keep startup possible on an unavailable disk. */ }
  return empty;
}
export function createSettings(path: string, changed: (theme: Theme) => void, highContrast = false): ThemeSettings {
  let migrationAllowed = !existsSync(path);
  const readStatus = { downloadsFolderUnavailable: false };
  let settings = readSettings(path, highContrast, readStatus);
  const save = (next: Settings) => {
    const unavailable = next.downloadsFolder !== null && !isDownloadsFolder(next.downloadsFolder);
    const normalized = unavailable ? { ...next, downloadsFolder: null } : next;
    writeSettings(path, normalized); settings = normalized; if (unavailable) readStatus.downloadsFolderUnavailable = true;
    migrationAllowed = false; changed(settings.theme);
  };
  const boolean = (key: 'askWhereToSave' | 'blockAds' | 'blockThirdPartyCookies', value: boolean, error: string) => {
    if (typeof value !== 'boolean') throw new Error(error); save({ ...settings, [key]: value });
  };
  return {
    syncSnapshot: () => syncSettings(settings),
    applySync(value) { validateSyncSettings(value); const next = { ...settings, ...value }; if (!value.marketplace) delete next.marketplace; save(next); },
    get installedThemes() { return [...(settings.marketplace?.installed ?? [])]; },
    installTheme(id) {
      if (!isMarketplaceTheme(id)) throw new Error('SETTINGS_COMMAND_INVALID');
      const marketplace = settings.marketplace ?? { installed: [], builtIn: isBuiltInTheme(settings.theme) ? settings.theme : 'system', contrast: settings.contrast };
      const installed = marketplace.installed.includes(id) ? marketplace.installed : [...marketplace.installed, id];
      // Installation and application share one write so disk failures cannot leave a partial choice.
      save({ ...settings, marketplace: { ...marketplace, installed }, theme: id, contrast: 'standard' });
    },
    removeTheme(id) {
      if (!isMarketplaceTheme(id)) throw new Error('SETTINGS_COMMAND_INVALID');
      const marketplace = settings.marketplace;
      if (!marketplace?.installed.includes(id)) return;
      const fallback = settings.theme === id ? { theme: marketplace.builtIn, contrast: marketplace.contrast } : {};
      save({ ...settings, ...fallback, marketplace: { ...marketplace, installed: marketplace.installed.filter(theme => theme !== id) } });
    },
    get theme() { return settings.theme; }, get contrast() { return settings.contrast; }, get darkPages() { return settings.darkPages; }, get darkStrength() { return settings.darkStrength; }, get darkTone() { return settings.darkTone; },
    get searchEngine() { return settings.searchEngine; }, get language() { return settings.language; }, get downloadsFolder() { return settings.downloadsFolder; }, get askWhereToSave() { return settings.askWhereToSave; }, get blockAds() { return settings.blockAds; }, get blockThirdPartyCookies() { return settings.blockThirdPartyCookies; }, get migrationAllowed() { return migrationAllowed; },
    get downloadsFolderUnavailable() { return readStatus.downloadsFolderUnavailable || settings.downloadsFolder !== null && !isDownloadsFolder(settings.downloadsFolder); },
    get quickAccess() { return [...settings.quickAccess]; },
    get showCapture() { return settings.showCapture; },
    get onStart() { return settings.onStart; },
    get onboarded() { return settings.onboarded; },
    get vaultTimeout() { return settings.vaultTimeout ?? 'close'; },
    setVaultTimeout(value) { if (!isVaultTimeout(value)) throw new Error('VAULT_COMMAND_INVALID'); save({ ...settings, vaultTimeout: value }); },
    setOnStart(value) { if (!isOnStart(value)) throw new Error('SETTINGS_COMMAND_INVALID'); save({ ...settings, onStart: value }); },
    finishFirstRun() { if (!settings.onboarded) save({ ...settings, onboarded: true }); },
    setShowCapture(value) { if (typeof value !== 'boolean') throw new Error('SETTINGS_COMMAND_INVALID'); save({ ...settings, showCapture: value }); },
    setAppPinned(id, pinned) {
      if (!isHubApp(id) || typeof pinned !== 'boolean') throw new Error('QUICK_ACCESS_INVALID');
      if (settings.quickAccess.includes(id) === pinned) return;
      const quickAccess = pinned ? [...settings.quickAccess, id] : settings.quickAccess.filter(app => app !== id);
      if (!isQuickAccess(quickAccess)) throw new Error('QUICK_ACCESS_LIMIT');
      save({ ...settings, quickAccess });
    },
    setTheme(value, migrate) {
      if (!isTheme(value) || isMarketplaceTheme(value) && !settings.marketplace?.installed.includes(value)) throw new Error('Invalid theme');
      if (!migrate || migrationAllowed) save({ ...settings, theme: value, ...(settings.marketplace && isBuiltInTheme(value) ? { marketplace: { ...settings.marketplace, builtIn: value, contrast: settings.contrast } } : {}) });
    },
    setContrast(value) {
      if (!isContrast(value)) throw new Error('Invalid contrast');
      save({ ...settings, contrast: value, ...(settings.marketplace && isBuiltInTheme(settings.theme) ? { marketplace: { ...settings.marketplace, contrast: value } } : {}) });
    },
    setDarkPages(value) { if (!isDarkPagesMode(value)) throw new Error('Invalid dark pages mode'); save({ ...settings, darkPages: value }); },
    setDarkStrength(value) { if (!isDarkStrength(value)) throw new Error('Invalid dark strength'); save({ ...settings, darkStrength: value }); },
    setDarkTone(value) { if (!isDarkTone(value)) throw new Error('Invalid dark tone'); save({ ...settings, darkTone: value }); },
    setSearchEngine(value) { if (!isSearchEngine(value)) throw new Error('SEARCH_ENGINE_INVALID'); save({ ...settings, searchEngine: value }); },
    setLanguage(value) { if (!isLanguageSetting(value)) throw new Error('LANGUAGE_INVALID'); save({ ...settings, language: value }); },
    setDownloadsFolder(value) { if (value !== null && !isDownloadsFolder(value)) throw new Error('DOWNLOADS_FOLDER_INVALID'); save({ ...settings, downloadsFolder: value }); readStatus.downloadsFolderUnavailable = false; },
    setAskWhereToSave(value) { boolean('askWhereToSave', value, 'ASK_WHERE_TO_SAVE_INVALID'); },
    setBlockAds(value) { boolean('blockAds', value, 'BLOCK_ADS_INVALID'); },
    setBlockThirdPartyCookies(value) { boolean('blockThirdPartyCookies', value, 'BLOCK_THIRD_PARTY_COOKIES_INVALID'); },
  };
}
