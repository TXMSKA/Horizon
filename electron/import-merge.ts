import { randomUUID } from 'node:crypto';
import type { BrowserStore, FavoriteItem, FavoritesTree, HistoryEntry, ImportSettingName, Language } from '../src/shared/api';
import { FAVORITE_DEPTH_LIMIT, FAVORITE_FOLDER_LIMIT, FAVORITE_LINK_LIMIT, favoriteCounts, favoriteLinks } from './favorites';
import type { ImportedFavorites, ImportedHistoryEntry, ImportedItem, ImportedSettings } from './import';
import { resolveLanguage } from './settings';
import type { ThemeSettings } from './settings';
import { defaultPermissions, SITE_SETTINGS_LIMIT } from './site-settings';

export const HISTORY_LIMIT = 10000;

export interface FavoritesMerge { links: number; skipped: number }

// Folders are matched by name at the same place and reused, new ones follow the source's order after what is already there,
// and a link whose address the profile already has anywhere is not repeated.
export function mergeFavorites(tree: FavoritesTree, imported: Pick<ImportedFavorites, 'bar' | 'other'>): FavoritesMerge {
  const known = new Set(favoriteLinks([...tree.bar, ...tree.other]).map(link => link.url));
  const counts = favoriteCounts(tree);
  const result = { links: 0, skipped: 0 };
  let folders = counts.folders;
  const merge = (items: FavoriteItem[], source: ImportedItem[], depth: number): void => {
    for (const item of source) {
      if (item.kind === 'link') {
        if (known.has(item.url)) continue;
        if (counts.links + result.links >= FAVORITE_LINK_LIMIT) { result.skipped++; continue; }
        items.push({ kind: 'link', id: randomUUID(), url: item.url, title: item.title, createdAt: item.createdAt });
        result.links++;
        continue;
      }
      const existing = items.find(entry => entry.kind === 'folder' && entry.name === item.name);
      if (existing?.kind === 'folder') { merge(existing.children, item.children, depth + 1); continue; }
      // Past the nesting or folder limits a folder gives its contents to the folder above.
      if (depth >= FAVORITE_DEPTH_LIMIT || folders >= FAVORITE_FOLDER_LIMIT) { merge(items, item.children, depth); continue; }
      const folder: FavoriteItem = { kind: 'folder', id: randomUUID(), name: item.name, createdAt: item.createdAt, children: [] };
      folders++;
      merge(folder.children, item.children, depth + 1);
      if (folder.children.length) items.push(folder); else folders--;
    }
  };
  merge(tree.bar, imported.bar, 0);
  merge(tree.other, imported.other, 0);
  return result;
}

// The later visit and the larger count win, so importing the same file twice changes nothing.
export function mergeHistory(existing: readonly HistoryEntry[], imported: readonly ImportedHistoryEntry[]): { history: HistoryEntry[]; imported: number } {
  const entries = new Map(existing.map(entry => [entry.url, entry]));
  const changed = new Set<string>();
  for (const item of imported) {
    const current = entries.get(item.url);
    if (!current) { entries.set(item.url, { ...item }); changed.add(item.url); continue; }
    const next = { url: current.url, title: current.title || item.title, lastVisit: Math.max(current.lastVisit, item.lastVisit), visitCount: Math.max(current.visitCount, item.visitCount) };
    if (next.title === current.title && next.lastVisit === current.lastVisit && next.visitCount === current.visitCount) continue;
    entries.set(item.url, next); changed.add(item.url);
  }
  const history = [...entries.values()].sort((a, b) => b.lastVisit - a.lastVisit).slice(0, HISTORY_LIMIT);
  return { history, imported: history.filter(entry => changed.has(entry.url)).length };
}

export type AppSettingsSnapshot = Pick<ThemeSettings, 'onStart' | 'downloadsFolder' | 'askWhereToSave' | 'blockThirdPartyCookies' | 'language' | 'theme' | 'darkPages'>;
export const appSettingsSnapshot = (settings: ThemeSettings): AppSettingsSnapshot => ({ onStart: settings.onStart, downloadsFolder: settings.downloadsFolder, askWhereToSave: settings.askWhereToSave, blockThirdPartyCookies: settings.blockThirdPartyCookies, language: settings.language, theme: settings.theme, darkPages: settings.darkPages });

// An imported value goes through the same setter as the Settings page, and only when it differs from what Horizon has now.
export function applyAppSettings(settings: ThemeSettings, imported: ImportedSettings, locale: string): ImportSettingName[] {
  const changed: ImportSettingName[] = [];
  const set = <T>(name: ImportSettingName, value: T | undefined, current: T, apply: (value: T) => void) => {
    if (value === undefined || value === current) return;
    apply(value); changed.push(name);
  };
  set('onStart', imported.onStart, settings.onStart, value => settings.setOnStart(value));
  set('downloadsFolder', imported.downloadsFolder, settings.downloadsFolder, value => settings.setDownloadsFolder(value));
  set('askWhereToSave', imported.askWhereToSave, settings.askWhereToSave, value => settings.setAskWhereToSave(value));
  set('blockThirdPartyCookies', imported.blockThirdPartyCookies, settings.blockThirdPartyCookies, value => settings.setBlockThirdPartyCookies(value));
  set('language', imported.language, resolveLanguage(settings.language, locale), value => settings.setLanguage(value));
  set('theme', imported.theme, settings.theme, value => settings.setTheme(value, false));
  set('darkPages', imported.darkPages ? 'on' as const : undefined, settings.darkPages, value => settings.setDarkPages(value));
  return changed;
}

// Puts back what a failed import changed. Every value is tried, so one that cannot be written does not hold back the rest.
export function restoreAppSettings(settings: ThemeSettings, previous: AppSettingsSnapshot): void {
  const put = (current: unknown, value: unknown, apply: () => void) => { if (current !== value) try { apply(); } catch { /* The saved value stays as it was written. */ } };
  put(settings.onStart, previous.onStart, () => settings.setOnStart(previous.onStart));
  put(settings.downloadsFolder, previous.downloadsFolder, () => settings.setDownloadsFolder(previous.downloadsFolder));
  put(settings.askWhereToSave, previous.askWhereToSave, () => settings.setAskWhereToSave(previous.askWhereToSave));
  put(settings.blockThirdPartyCookies, previous.blockThirdPartyCookies, () => settings.setBlockThirdPartyCookies(previous.blockThirdPartyCookies));
  put(settings.language, previous.language, () => settings.setLanguage(previous.language));
  put(settings.theme, previous.theme, () => settings.setTheme(previous.theme, false));
  put(settings.darkPages, previous.darkPages, () => settings.setDarkPages(previous.darkPages));
}

export interface ProfileSettingsMerge { names: ImportSettingName[]; sitePermissions: number; translations: number; skipped: number }

// Horizon's own decisions always stand: a permission is filled in only where the site is still at Ask, translation choices are a union
// where Horizon's language choice wins, and clearing on close is only ever turned on.
export function mergeProfileSettings(store: BrowserStore, imported: ImportedSettings, language: Language): ProfileSettingsMerge {
  const result: ProfileSettingsMerge = { names: [], sitePermissions: 0, translations: 0, skipped: 0 };
  const entries = new Map(store.siteSettings.permissions.map(entry => [entry.origin, entry]));
  for (const item of imported.sitePermissions) {
    const entry = entries.get(item.origin);
    if ((entry?.[item.permission] ?? 'ask') !== 'ask') continue;
    if (!entry && entries.size >= SITE_SETTINGS_LIMIT) { result.skipped++; continue; }
    const target = entry ?? { origin: item.origin, ...defaultPermissions() };
    if (!entry) { store.siteSettings.permissions.push(target); entries.set(item.origin, target); }
    target[item.permission] = item.decision; result.sitePermissions++;
  }
  const choices = structuredClone(store.siteSettings.translation ?? { always: [], never: [] });
  const languages = new Set(choices.always.map(choice => choice.language)), hosts = new Set(choices.never);
  for (const item of imported.translationAlways) {
    const target = item.target ?? language;
    if (target === item.language || languages.has(item.language)) continue;
    if (choices.always.length >= 200) { result.skipped++; continue; }
    choices.always.push({ language: item.language, target }); languages.add(item.language); result.translations++;
  }
  for (const host of imported.translationNever) {
    if (hosts.has(host)) continue;
    if (choices.never.length >= SITE_SETTINGS_LIMIT) { result.skipped++; continue; }
    choices.never.push(host); hosts.add(host); result.translations++;
  }
  if (result.translations) store.siteSettings.translation = choices;
  if (imported.clearHistoryOnClose && !store.clearHistoryOnClose) { store.clearHistoryOnClose = true; result.names.push('clearHistoryOnClose'); }
  if (imported.clearCacheOnClose && !store.clearCacheOnClose) { store.clearCacheOnClose = true; result.names.push('clearCacheOnClose'); }
  return result;
}
