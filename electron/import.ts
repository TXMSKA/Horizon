import { copyFileSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { Worker } from 'node:worker_threads';
import { IMPORT_SETTINGS, SEARCH_ENGINES } from '../src/shared/api';
import type { BuiltInTheme, ImportBrowser, ImportProfile, ImportSettingsSummary, ImportSource, Language, OnStart, SearchEngine, SitePermission } from '../src/shared/api';
import { pageLanguage } from '../src/shared/translate';
import { isWebURL } from './browsing';
import { isDownloadsFolder } from './settings';
import { SITE_SETTINGS_LIMIT, siteHost, validHost, validOrigin } from './site-settings';
import type { HistoryRow, MarkRow, PermissionRow, WorkerReply, WorkerRequest } from './import-worker';

export interface ImportedLink { kind: 'link'; url: string; title: string; createdAt: number }
export interface ImportedFolder { kind: 'folder'; name: string; createdAt: number; children: ImportedItem[] }
export type ImportedItem = ImportedLink | ImportedFolder;
export interface ImportedFavorites { bar: ImportedItem[]; other: ImportedItem[]; skipped: number }
export interface ImportedHistoryEntry { url: string; title: string; lastVisit: number; visitCount: number }
export interface ImportedHistory { entries: ImportedHistoryEntry[]; skipped: number }
export interface ImportedPermission { origin: string; permission: Exclude<SitePermission, 'lyra'>; decision: 'allow' | 'block' }
// A target of null is the language Horizon runs in when the choices are merged, which is how Firefox keeps them.
export interface ImportedTranslation { language: string; target: Language | null }
export interface ImportedSettings {
  onStart?: OnStart; downloadsFolder?: string; askWhereToSave?: boolean; blockThirdPartyCookies?: boolean; language?: Language; theme?: BuiltInTheme;
  darkPages?: true; clearHistoryOnClose?: true; clearCacheOnClose?: true;
  sitePermissions: ImportedPermission[]; translationAlways: ImportedTranslation[]; translationNever: string[];
}
export interface ImportedData { favorites: ImportedFavorites | null; history: ImportedHistory | null; searchEngine: SearchEngine | null; settings: ImportedSettings | null }
export interface ImportEnvironment { local: string | undefined; roaming: string | undefined }
export interface ImportSelection { browser: ImportBrowser; profile: string; favorites: boolean; history: boolean; searchEngine: boolean; settings: boolean }
export interface ImportLabels { mobile: string; menu: string }

export const BOOKMARKS_FILE_LIMIT = 20 * 1024 * 1024;
export const HISTORY_FILE_LIMIT = 1024 * 1024 * 1024;
export const BOOKMARK_NODE_LIMIT = 50000;
export const BOOKMARK_DEPTH_LIMIT = 32;
const SMALL_FILE_LIMIT = 8 * 1024 * 1024;
const HISTORY_SCAN_LIMIT = 50000;
const HISTORY_TIMEOUT = 60000;
const controls = /[\x00-\x1f\x7f-\x9f]/g;

interface BrowserDefinition { id: ImportBrowser; name: string; base: 'local' | 'roaming'; path: string[]; layout: 'profiles' | 'root' | 'firefox' }
const BROWSERS: readonly BrowserDefinition[] = [
  { id: 'edge', name: 'Edge', base: 'local', path: ['Microsoft', 'Edge', 'User Data'], layout: 'profiles' },
  { id: 'chrome', name: 'Chrome', base: 'local', path: ['Google', 'Chrome', 'User Data'], layout: 'profiles' },
  { id: 'brave', name: 'Brave', base: 'local', path: ['BraveSoftware', 'Brave-Browser', 'User Data'], layout: 'profiles' },
  { id: 'vivaldi', name: 'Vivaldi', base: 'local', path: ['Vivaldi', 'User Data'], layout: 'profiles' },
  { id: 'chromium', name: 'Chromium', base: 'local', path: ['Chromium', 'User Data'], layout: 'profiles' },
  { id: 'opera', name: 'Opera', base: 'roaming', path: ['Opera Software', 'Opera Stable'], layout: 'root' },
  { id: 'opera-gx', name: 'Opera GX', base: 'roaming', path: ['Opera Software', 'Opera GX Stable'], layout: 'root' },
  { id: 'firefox', name: 'Firefox', base: 'roaming', path: ['Mozilla', 'Firefox'], layout: 'firefox' },
];
const ROOT_PROFILE = 'default';
const SEARCH_HOSTS: readonly [RegExp, SearchEngine][] = [
  [/(^|\.)google\.[a-z.]+$/, 'google'], [/(^|\.)bing\.com$/, 'bing'], [/(^|\.)duckduckgo\.com$/, 'duckduckgo'],
  [/(^|\.)brave\.com$/, 'brave'], [/(^|\.)ecosia\.org$/, 'ecosia'], [/(^|\.)startpage\.com$/, 'startpage'],
];

function plain(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function entry(path: string) {
  try { return lstatSync(path); } catch { return undefined; }
}

function realDirectory(path: string): boolean {
  const found = entry(path);
  return found !== undefined && found.isDirectory() && !found.isSymbolicLink();
}

function realFile(path: string): boolean {
  const found = entry(path);
  return found !== undefined && found.isFile() && !found.isSymbolicLink();
}

// A profile folder is trusted only as a plain direct child of its root, never a path, a drive or a link.
function childDirectory(root: string, name: unknown): string | undefined {
  if (typeof name !== 'string' || !name || name === '.' || name === '..' || /[\\/:\0]/.test(name)) return undefined;
  const path = resolve(root, name);
  return resolve(path, '..') === resolve(root) && realDirectory(root) && realDirectory(path) ? path : undefined;
}

function readLimited(path: string, limit: number): Buffer {
  const found = entry(path);
  if (!found || !found.isFile() || found.isSymbolicLink()) throw new Error('IMPORT_FILE_INVALID');
  if (found.size > limit) throw new Error('IMPORT_FILE_TOO_LARGE');
  try { return readFileSync(path); }
  catch (error: unknown) { throw new Error(lockedFile(error) ? 'IMPORT_FILE_LOCKED' : 'IMPORT_FILE_INVALID'); }
}

function lockedFile(error: unknown): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && (error.code === 'EBUSY' || error.code === 'EPERM' || error.code === 'EACCES');
}

function readJSON(path: string, limit: number): unknown {
  try { return JSON.parse(readLimited(path, limit).toString('utf8')); }
  catch (error: unknown) {
    if (error instanceof Error && /^IMPORT_/.test(error.message)) throw error;
    throw new Error('IMPORT_FILE_INVALID');
  }
}

function lz4Block(source: Uint8Array, size: number): Uint8Array {
  const output = new Uint8Array(size);
  let read = 0, write = 0;
  const length = (start: number): number => {
    let total = start, next = 255;
    while (next === 255) {
      const byte = source[read++];
      if (byte === undefined) throw new Error('IMPORT_FILE_INVALID');
      next = byte; total += byte;
    }
    return total;
  };
  while (read < source.length) {
    const token = source[read++]!;
    const literals = token >> 4 === 15 ? length(15) : token >> 4;
    if (read + literals > source.length || write + literals > size) throw new Error('IMPORT_FILE_INVALID');
    output.set(source.subarray(read, read + literals), write);
    read += literals; write += literals;
    if (read >= source.length) break;
    const offset = source[read]! | source[read + 1]! << 8;
    read += 2;
    const match = (token & 15) === 15 ? length(15) + 4 : (token & 15) + 4;
    if (!offset || offset > write || write + match > size) throw new Error('IMPORT_FILE_INVALID');
    for (let index = 0; index < match; index++, write++) output[write] = output[write - offset]!;
  }
  if (write !== size) throw new Error('IMPORT_FILE_INVALID');
  return output;
}

// Firefox keeps its search settings as a Mozilla LZ4 block behind a magic header and the unpacked size.
export function mozlz4(bytes: Uint8Array): unknown {
  const magic = Buffer.from('mozLz40\0');
  if (bytes.length < 12 || !Buffer.from(bytes.subarray(0, 8)).equals(magic)) throw new Error('IMPORT_FILE_INVALID');
  const size = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).getUint32(8, true);
  if (size > 4 * 1024 * 1024) throw new Error('IMPORT_FILE_TOO_LARGE');
  return JSON.parse(Buffer.from(lz4Block(bytes.subarray(12), size)).toString('utf8'));
}

export function searchEngineByName(name: unknown): SearchEngine | null {
  if (typeof name !== 'string') return null;
  const normalize = (value: string) => value.toLowerCase().replace(/[^a-z0-9]/g, '');
  return (Object.keys(SEARCH_ENGINES) as SearchEngine[]).find(engine => normalize(SEARCH_ENGINES[engine].displayName) === normalize(name)) ?? null;
}

export function searchEngineByAddress(template: unknown): SearchEngine | null {
  if (typeof template !== 'string') return null;
  if (template.includes('{google:baseURL}')) return 'google';
  try {
    const host = new URL(template.replace(/\{[^}]*\}/g, 'x')).hostname;
    return SEARCH_HOSTS.find(([pattern]) => pattern.test(host))?.[1] ?? null;
  } catch { return null; }
}

function chromiumSearchEngine(profile: string): SearchEngine | null {
  try {
    const preferences = readJSON(join(profile, 'Preferences'), SMALL_FILE_LIMIT);
    if (!plain(preferences)) return null;
    const stored = plain(preferences.default_search_provider_data) && plain(preferences.default_search_provider_data.template_url_data) ? preferences.default_search_provider_data.template_url_data : undefined;
    const managed = plain(preferences.default_search_provider) ? preferences.default_search_provider : undefined;
    return searchEngineByAddress(stored?.url) ?? searchEngineByName(stored?.short_name) ?? searchEngineByAddress(managed?.search_url);
  } catch { return null; }
}

function firefoxSearchEngine(profile: string): SearchEngine | null {
  try {
    const search = mozlz4(readLimited(join(profile, 'search.json.mozlz4'), 1024 * 1024));
    if (!plain(search) || !plain(search.metaData)) return null;
    const engines = Array.isArray(search.engines) ? search.engines.filter(plain) : [];
    const id = search.metaData.defaultEngineId;
    return searchEngineByName(engines.find(engine => typeof id === 'string' && engine.id === id)?._name ?? search.metaData.current);
  } catch { return null; }
}

function chromiumProfiles(definition: BrowserDefinition, root: string): { id: string; name: string; path: string }[] {
  if (definition.layout === 'root') return realDirectory(root) ? [{ id: ROOT_PROFILE, name: definition.name, path: root }] : [];
  try {
    const state = readJSON(join(root, 'Local State'), SMALL_FILE_LIMIT);
    const cache = plain(state) && plain(state.profile) && plain(state.profile.info_cache) ? state.profile.info_cache : {};
    return Object.keys(cache).flatMap(id => {
      const path = childDirectory(root, id), info = cache[id];
      const name = plain(info) && typeof info.name === 'string' ? info.name.replace(controls, ' ').trim().slice(0, 80) : '';
      return path ? [{ id, name: name || id, path }] : [];
    });
  } catch { return []; }
}

function firefoxProfiles(root: string): { id: string; name: string; path: string }[] {
  const profiles = join(root, 'Profiles');
  try {
    const sections = readLimited(join(root, 'profiles.ini'), SMALL_FILE_LIMIT).toString('utf8').split(/\r?\n(?=\[)/);
    return sections.flatMap(section => {
      const fields = new Map(section.split(/\r?\n/).flatMap(line => { const at = line.indexOf('='); return at > 0 ? [[line.slice(0, at).trim(), line.slice(at + 1).trim()] as const] : []; }));
      const relative = /^Profiles\/([^/\\]+)$/.exec(fields.get('Path') ?? '')?.[1];
      const path = fields.get('IsRelative') === '1' && /^\[Profile\d+\]/.test(section) ? childDirectory(profiles, relative) : undefined;
      return path && relative ? [{ id: relative, name: (fields.get('Name') ?? relative).replace(controls, ' ').trim().slice(0, 80) || relative, path }] : [];
    });
  } catch { return []; }
}

function sourceRoot(definition: BrowserDefinition, environment: ImportEnvironment): string | undefined {
  const base = environment[definition.base];
  return base && realDirectory(base) ? join(base, ...definition.path) : undefined;
}

function sourceProfiles(definition: BrowserDefinition, root: string) {
  return definition.layout === 'firefox' ? firefoxProfiles(root) : chromiumProfiles(definition, root);
}

// What can be read is what the browser's own files hold: the settings of Chromium sit in Preferences and Local State, the ones of Firefox in prefs.js and permissions.sqlite.
const emptySettings = (): ImportedSettings => ({ sitePermissions: [], translationAlways: [], translationNever: [] });
const pick = (value: unknown, ...path: string[]): unknown => path.reduce<unknown>((node, key) => plain(node) && Object.hasOwn(node, key) ? node[key] : undefined, value);
const optionalJSON = (path: string): unknown => realFile(path) ? readJSON(path, SMALL_FILE_LIMIT) : undefined;
const spokenLanguage = (value: unknown): Language | undefined => { const language = pageLanguage(value); return language === 'en' || language === 'es' ? language : undefined; };
const CHROMIUM_SITE_PERMISSIONS = { media_stream_camera: 'camera', media_stream_mic: 'microphone', geolocation: 'location', notifications: 'notifications' } as const;
const FIREFOX_SITE_PERMISSIONS: Record<string, ImportedPermission['permission']> = { camera: 'camera', microphone: 'microphone', geo: 'location', 'desktop-notification': 'notifications' };
const FIREFOX_PREFS = new Set(['browser.startup.page', 'browser.download.folderList', 'browser.download.dir', 'browser.download.useDownloadDir', 'network.cookie.cookieBehavior', 'intl.locale.requested',
  'extensions.activeThemeID', 'browser.translations.alwaysTranslateLanguages', 'privacy.sanitize.sanitizeOnShutdown', 'privacy.clearOnShutdown_v2.browsingHistoryAndDownloads',
  'privacy.clearOnShutdown_v2.historyFormDataAndDownloads', 'privacy.clearOnShutdown.history', 'privacy.clearOnShutdown_v2.cache', 'privacy.clearOnShutdown.cache']);
const PREF_LINE = /^user_pref\("([A-Za-z0-9_.-]{1,128})", ?(.{1,4096})\);$/;

// Only user_pref lines of known names are read, each value through JSON.parse; a line that does not fit is ignored and the last one of a name wins.
export function parseFirefoxPrefs(source: string): Map<string, unknown> {
  const prefs = new Map<string, unknown>();
  for (const line of source.split(/\r?\n/)) {
    const match = PREF_LINE.exec(line.trim());
    if (!match || !FIREFOX_PREFS.has(match[1]!)) continue;
    try { prefs.set(match[1]!, JSON.parse(match[2]!)); } catch { /* A value that is not plain JSON is not a setting Horizon reads. */ }
  }
  return prefs;
}

// A pattern names one https origin only; wildcards, paths and a second pattern are other kinds of rule.
function chromiumPatternOrigin(key: string): string | null {
  const [primary, secondary, ...rest] = key.split(',');
  if (!primary || secondary !== '*' || rest.length || primary.includes('*')) return null;
  try {
    const url = new URL(primary);
    return url.protocol === 'https:' && !url.username && !url.password && url.pathname === '/' && !url.search && !url.hash && validOrigin(url.origin) ? url.origin : null;
  } catch { return null; }
}

export function chromiumSettings(profile: string, state: string): ImportedSettings {
  const preferences = optionalJSON(join(profile, 'Preferences')), local = optionalJSON(join(state, 'Local State'));
  const found = emptySettings();
  const startup = pick(preferences, 'session', 'restore_on_startup');
  if (startup === 1) found.onStart = 'restore'; else if (startup === 5) found.onStart = 'new-page';
  const folder = pick(preferences, 'download', 'default_directory');
  if (isDownloadsFolder(folder)) found.downloadsFolder = folder;
  const prompt = pick(preferences, 'download', 'prompt_for_download');
  if (typeof prompt === 'boolean') found.askWhereToSave = prompt;
  const cookies = pick(preferences, 'profile', 'cookie_controls_mode');
  if (cookies === 1) found.blockThirdPartyCookies = true; else if (cookies === 0 || cookies === 2) found.blockThirdPartyCookies = false;
  const language = spokenLanguage(pick(local, 'intl', 'app_locale'));
  if (language) found.language = language;
  const scheme = pick(preferences, 'browser', 'theme', 'color_scheme2');
  if (scheme === 0) found.theme = 'system'; else if (scheme === 1) found.theme = 'daylight'; else if (scheme === 2) found.theme = 'amber';
  const labs = pick(local, 'browser', 'enabled_labs_experiments');
  if (Array.isArray(labs) && labs.includes('enable-force-dark@1')) found.darkPages = true;
  const exceptions = pick(preferences, 'profile', 'content_settings', 'exceptions');
  const decisions = new Map<string, ImportedPermission>();
  for (const [name, permission] of Object.entries(CHROMIUM_SITE_PERMISSIONS)) {
    const rules = pick(exceptions, name);
    if (!plain(rules)) continue;
    for (const [key, rule] of Object.entries(rules)) {
      const origin = chromiumPatternOrigin(key), setting = pick(rule, 'setting'), expiration = pick(rule, 'expiration');
      if (!origin || setting !== 1 && setting !== 2 || expiration !== undefined && expiration !== '0' && expiration !== 0 || decisions.size >= SITE_SETTINGS_LIMIT) continue;
      decisions.set(`${origin}\n${permission}`, { origin, permission, decision: setting === 1 ? 'allow' : 'block' });
    }
  }
  found.sitePermissions = [...decisions.values()];
  const always = pick(preferences, 'translate_allowlists'), languages = new Map<string, ImportedTranslation>();
  if (plain(always)) for (const [source, target] of Object.entries(always)) {
    const language = pageLanguage(source), to = spokenLanguage(target);
    if (language && to && language !== to && !languages.has(language)) languages.set(language, { language, target: to });
  }
  found.translationAlways = [...languages.values()].slice(0, 200);
  const never = pick(preferences, 'translate_site_blocklist_with_time');
  if (plain(never)) found.translationNever = Object.keys(never).filter(validHost).slice(0, SITE_SETTINGS_LIMIT);
  return found;
}

export function firefoxSettings(prefs: Map<string, unknown>, rows: readonly PermissionRow[]): ImportedSettings {
  const found = emptySettings();
  const startup = prefs.get('browser.startup.page');
  if (startup === 3) found.onStart = 'restore'; else if (startup === 0 || startup === 1) found.onStart = 'new-page';
  const folder = prefs.get('browser.download.dir');
  if (prefs.get('browser.download.folderList') === 2 && isDownloadsFolder(folder)) found.downloadsFolder = folder;
  const useFolder = prefs.get('browser.download.useDownloadDir');
  if (typeof useFolder === 'boolean') found.askWhereToSave = !useFolder;
  const cookies = prefs.get('network.cookie.cookieBehavior');
  if (cookies === 1) found.blockThirdPartyCookies = true; else if (cookies === 0) found.blockThirdPartyCookies = false;
  const requested = prefs.get('intl.locale.requested');
  const language = typeof requested === 'string' ? spokenLanguage(requested.split(',')[0]) : undefined;
  if (language) found.language = language;
  const theme = prefs.get('extensions.activeThemeID');
  const kind = typeof theme === 'string' ? /^(default-theme|firefox-compact-light|firefox-compact-dark)(?:@mozilla\.org)?$/.exec(theme)?.[1] : undefined;
  if (kind === 'default-theme') found.theme = 'system'; else if (kind === 'firefox-compact-light') found.theme = 'daylight'; else if (kind === 'firefox-compact-dark') found.theme = 'amber';
  if (prefs.get('privacy.sanitize.sanitizeOnShutdown') === true) {
    const flag = (...names: string[]) => names.map(name => prefs.get(name)).find((value): value is boolean => typeof value === 'boolean') ?? true;
    if (flag('privacy.clearOnShutdown_v2.browsingHistoryAndDownloads', 'privacy.clearOnShutdown_v2.historyFormDataAndDownloads', 'privacy.clearOnShutdown.history')) found.clearHistoryOnClose = true;
    if (flag('privacy.clearOnShutdown_v2.cache', 'privacy.clearOnShutdown.cache')) found.clearCacheOnClose = true;
  }
  const always = prefs.get('browser.translations.alwaysTranslateLanguages');
  if (typeof always === 'string') found.translationAlways = [...new Set(always.split(',').map(value => pageLanguage(value)).filter((value): value is string => value !== null))].slice(0, 200).map(language => ({ language, target: null }));
  const decisions = new Map<string, ImportedPermission>(), never = new Set<string>();
  for (const row of rows) {
    if (typeof row.origin !== 'string' || row.origin.includes('^') || !row.origin.startsWith('https://') || !validOrigin(row.origin)) continue;
    if (row.type === 'translations') { const host = row.permission === 2 ? siteHost(row.origin) : null; if (host && validHost(host) && never.size < SITE_SETTINGS_LIMIT) never.add(host); continue; }
    const permission = FIREFOX_SITE_PERMISSIONS[row.type];
    if (permission && (row.permission === 1 || row.permission === 2) && decisions.size < SITE_SETTINGS_LIMIT) decisions.set(`${row.origin}\n${permission}`, { origin: row.origin, permission, decision: row.permission === 1 ? 'allow' : 'block' });
  }
  found.sitePermissions = [...decisions.values()]; found.translationNever = [...never];
  return found;
}

export function summarizeSettings(found: ImportedSettings): ImportSettingsSummary | null {
  const summary = { names: IMPORT_SETTINGS.filter(name => found[name] !== undefined), sitePermissions: found.sitePermissions.length, translations: found.translationAlways.length + found.translationNever.length };
  return summary.names.length || summary.sitePermissions || summary.translations ? summary : null;
}

// Listing the profiles only counts what is there, so a permissions database that cannot be read then does not hide the rest; importing reads it strictly.
async function readSourceSettings(definition: BrowserDefinition, path: string, root: string, scratch: string, listing = false): Promise<ImportedSettings> {
  if (definition.layout !== 'firefox') return chromiumSettings(path, definition.layout === 'root' ? path : root);
  const prefs = realFile(join(path, 'prefs.js')) ? parseFirefoxPrefs(readLimited(join(path, 'prefs.js'), SMALL_FILE_LIMIT).toString('utf8')) : new Map<string, unknown>();
  const database = realFile(join(path, 'permissions.sqlite'))
    ? await readDatabase(join(path, 'permissions.sqlite'), scratch, { kind: 'firefox', bookmarks: false, history: false, permissions: true, scan: HISTORY_SCAN_LIMIT, nodes: 0 }, ['-wal'], 'IMPORT_SETTINGS_FAILED').then(reply => reply.permissions, (error: unknown) => { if (listing) return []; throw error; })
    : [];
  return firefoxSettings(prefs, database);
}

async function describeProfile(definition: BrowserDefinition, root: string, profile: { id: string; name: string; path: string }, scratch: string): Promise<ImportProfile | undefined> {
  const firefox = definition.layout === 'firefox';
  const favorites = realFile(join(profile.path, firefox ? 'places.sqlite' : 'Bookmarks'));
  const history = realFile(join(profile.path, firefox ? 'places.sqlite' : 'History'));
  // Settings that cannot be read now are simply not offered.
  const settings = await readSourceSettings(definition, profile.path, root, scratch, true).then(summarizeSettings, () => null);
  return favorites || history || settings ? { id: profile.id, name: profile.name, favorites, history, searchEngine: firefox ? firefoxSearchEngine(profile.path) : chromiumSearchEngine(profile.path), settings } : undefined;
}

export async function discoverImportSources(environment: ImportEnvironment, scratch: string): Promise<ImportSource[]> {
  const sources: ImportSource[] = [];
  for (const definition of BROWSERS) {
    const root = sourceRoot(definition, environment);
    if (!root) continue;
    const profiles: ImportProfile[] = [];
    for (const profile of sourceProfiles(definition, root)) { const found = await describeProfile(definition, root, profile, scratch); if (found) profiles.push(found); }
    if (profiles.length) sources.push({ browser: definition.id, name: definition.name, profiles });
  }
  return sources;
}

async function profileFolder(environment: ImportEnvironment, selection: ImportSelection, scratch: string): Promise<{ definition: BrowserDefinition; root: string; path: string; profile: ImportProfile }> {
  const definition = BROWSERS.find(entry => entry.id === selection.browser);
  const root = definition && sourceRoot(definition, environment);
  const profile = definition && root && sourceProfiles(definition, root).find(entry => entry.id === selection.profile);
  const found = definition && root && profile ? await describeProfile(definition, root, profile, scratch) : undefined;
  if (!definition || !root || !profile || !found) throw new Error('IMPORT_SOURCE_NOT_FOUND');
  return { definition, root, path: profile.path, profile: found };
}

function cleanText(value: unknown, limit: number): string {
  return typeof value === 'string' ? value.replace(controls, ' ').slice(0, limit) : '';
}

function importedTime(milliseconds: number, now: number): number {
  return Number.isSafeInteger(milliseconds) && milliseconds > 0 && milliseconds <= 8640000000000000 ? milliseconds : now;
}

function importedLink(url: unknown, title: unknown, createdAt: number, state: { skipped: number }): ImportedLink | undefined {
  if (typeof url !== 'string' || !isWebURL(url)) { state.skipped++; return undefined; }
  return { kind: 'link', url, title: cleanText(title, 200) || cleanText(url, 200), createdAt };
}

function importedName(value: unknown): string {
  return cleanText(value, 80).trim();
}

// A folder without a usable name gives its contents to the folder above rather than losing them.
function withFolder(name: string, createdAt: number, children: ImportedItem[]): ImportedItem[] {
  return name ? [{ kind: 'folder', name, createdAt, children }] : children;
}

const CHROMIUM_EPOCH = 11644473600000;
const chromiumTime = (value: unknown, now: number): number => importedTime(Math.round(Number(value) / 1000 - CHROMIUM_EPOCH), now);

export function parseChromiumBookmarks(text: string, labels: ImportLabels, now = Date.now()): ImportedFavorites {
  let value: unknown;
  try { value = JSON.parse(text); } catch { throw new Error('IMPORT_FILE_INVALID'); }
  if (!plain(value) || !plain(value.roots)) throw new Error('IMPORT_FILE_INVALID');
  const state = { skipped: 0 };
  let nodes = 0;
  const walk = (children: unknown, depth: number): ImportedItem[] => {
    if (!Array.isArray(children)) return [];
    if (depth > BOOKMARK_DEPTH_LIMIT) throw new Error('IMPORT_FILE_TOO_LARGE');
    return children.flatMap((node): ImportedItem[] => {
      if (++nodes > BOOKMARK_NODE_LIMIT) throw new Error('IMPORT_FILE_TOO_LARGE');
      if (!plain(node)) return [];
      const createdAt = chromiumTime(node.date_added, now);
      if (node.type === 'url') { const link = importedLink(node.url, node.name, createdAt, state); return link ? [link] : []; }
      if (node.type === 'folder') return withFolder(importedName(node.name), createdAt, walk(node.children, depth + 1));
      return [];
    });
  };
  const root = (key: string) => plain(value.roots) && plain(value.roots[key]) ? walk(value.roots[key].children, 1) : [];
  const mobile = root('synced');
  return { bar: root('bookmark_bar'), other: [...root('other'), ...(mobile.length ? withFolder(labels.mobile, now, mobile) : [])], skipped: state.skipped };
}

export function parseFirefoxBookmarks(rows: readonly MarkRow[], labels: ImportLabels, now = Date.now()): ImportedFavorites {
  if (rows.length > BOOKMARK_NODE_LIMIT) throw new Error('IMPORT_FILE_TOO_LARGE');
  const state = { skipped: 0 };
  const children = new Map<number, MarkRow[]>();
  for (const row of rows) children.set(row.parent, [...children.get(row.parent) ?? [], row]);
  const walk = (parent: number, depth: number): ImportedItem[] => {
    if (depth > BOOKMARK_DEPTH_LIMIT) throw new Error('IMPORT_FILE_TOO_LARGE');
    return [...children.get(parent) ?? []].sort((a, b) => a.position - b.position).flatMap((row): ImportedItem[] => {
      const createdAt = importedTime(row.added, now);
      if (row.type === 1) { const link = importedLink(row.url, row.title, createdAt, state); return link ? [link] : []; }
      return row.type === 2 ? withFolder(importedName(row.title), createdAt, walk(row.id, depth + 1)) : [];
    });
  };
  const root = (guid: string) => { const row = rows.find(entry => entry.guid === guid); return row ? walk(row.id, 1) : []; };
  const menu = root('menu________'), mobile = root('mobile______');
  return { bar: root('toolbar_____'), other: [...root('unfiled_____'), ...(menu.length ? withFolder(labels.menu, now, menu) : []), ...(mobile.length ? withFolder(labels.mobile, now, mobile) : [])], skipped: state.skipped };
}

function importedHistory(rows: readonly HistoryRow[], now: number): ImportedHistory {
  const entries: ImportedHistoryEntry[] = [];
  let skipped = 0;
  for (const row of rows) {
    if (typeof row.url !== 'string' || !isWebURL(row.url) || !Number.isSafeInteger(row.visits) || !Number.isSafeInteger(row.last) || row.last <= 0 || row.last > now + 86400000) { skipped++; continue; }
    entries.push({ url: row.url, title: cleanText(row.title, 4096), lastVisit: row.last, visitCount: Math.max(1, row.visits) });
  }
  return { entries, skipped };
}

type ReadFailure = 'IMPORT_HISTORY_FAILED' | 'IMPORT_SETTINGS_FAILED';

function sqliteRows(database: string, request: Omit<WorkerRequest, 'database'>, failure: ReadFailure): Promise<WorkerReply & { ok: true }> {
  return new Promise((resolveRows, reject) => {
    const worker = new Worker(join(__dirname, 'import-worker.js'), { workerData: { ...request, database } satisfies WorkerRequest, resourceLimits: { maxOldGenerationSizeMb: 256, maxYoungGenerationSizeMb: 32 } });
    const timeout = setTimeout(() => { void worker.terminate(); reject(new Error(failure)); }, HISTORY_TIMEOUT);
    let settled = false;
    const finish = (settle: () => void) => { if (settled) return; settled = true; clearTimeout(timeout); settle(); };
    worker.once('message', (reply: WorkerReply) => finish(() => { if (reply.ok) resolveRows(reply); else reject(new Error(failure)); }));
    worker.once('error', () => finish(() => reject(new Error(failure))));
    worker.once('exit', () => finish(() => reject(new Error(failure))));
  });
}

// The browser may hold its database open, so the work happens on a private copy that is removed on every path.
async function readDatabase(source: string, scratch: string, request: Omit<WorkerRequest, 'database'>, companions: readonly string[], failure: ReadFailure = 'IMPORT_HISTORY_FAILED'): Promise<WorkerReply & { ok: true }> {
  const found = entry(source);
  if (!found || !found.isFile() || found.isSymbolicLink()) throw new Error('IMPORT_FILE_INVALID');
  if (found.size > HISTORY_FILE_LIMIT) throw new Error('IMPORT_FILE_TOO_LARGE');
  mkdirSync(scratch, { recursive: true, mode: 0o700 });
  const directory = mkdtempSync(join(scratch, 'import-'));
  try {
    const copy = join(directory, 'database.sqlite');
    try {
      copyFileSync(source, copy);
      for (const suffix of companions) if (realFile(source + suffix)) copyFileSync(source + suffix, copy + suffix);
    } catch (error: unknown) { throw new Error(lockedFile(error) ? 'IMPORT_FILE_LOCKED' : 'IMPORT_FILE_INVALID'); }
    return await sqliteRows(copy, request, failure);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

export async function readImport(environment: ImportEnvironment, selection: ImportSelection, labels: ImportLabels, scratch: string, progress: (current: number, total: number) => void, now = Date.now()): Promise<ImportedData> {
  const { definition, root, path, profile } = await profileFolder(environment, selection, scratch);
  const firefox = definition.layout === 'firefox';
  const wantsFavorites = selection.favorites && profile.favorites, wantsHistory = selection.history && profile.history;
  const wantsSettings = selection.settings && profile.settings !== null, engine = selection.searchEngine ? profile.searchEngine : null;
  const total = Number(wantsFavorites) + Number(wantsHistory) + Number(wantsSettings) + Number(engine !== null);
  if (!total) throw new Error('IMPORT_NO_CHOICE');
  let step = 0;
  const data: ImportedData = { favorites: null, history: null, searchEngine: null, settings: null };
  if (firefox) {
    if (wantsFavorites || wantsHistory) {
      progress(++step, total);
      const reply = await readDatabase(join(path, 'places.sqlite'), scratch, { kind: 'firefox', bookmarks: wantsFavorites, history: wantsHistory, permissions: false, scan: HISTORY_SCAN_LIMIT, nodes: BOOKMARK_NODE_LIMIT + 1 }, ['-wal']);
      if (wantsFavorites) data.favorites = parseFirefoxBookmarks(reply.bookmarks, labels, now);
      if (wantsHistory) { if (wantsFavorites) progress(++step, total); data.history = importedHistory(reply.history, now); }
    }
  } else {
    if (wantsFavorites) { progress(++step, total); data.favorites = parseChromiumBookmarks(readLimited(join(path, 'Bookmarks'), BOOKMARKS_FILE_LIMIT).toString('utf8'), labels, now); }
    if (wantsHistory) {
      progress(++step, total);
      data.history = importedHistory((await readDatabase(join(path, 'History'), scratch, { kind: 'chromium', bookmarks: false, history: true, permissions: false, scan: HISTORY_SCAN_LIMIT, nodes: 0 }, [])).history, now);
    }
  }
  if (wantsSettings) { progress(++step, total); data.settings = await readSourceSettings(definition, path, root, scratch); }
  if (engine) { progress(++step, total); data.searchEngine = engine; }
  return data;
}
