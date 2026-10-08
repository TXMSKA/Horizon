import { copy, text } from '../copy';
import type { CopyKey } from '../copy';
import type { Language, SyncConflict, SyncItem } from './api';

export const syncItemLabels: Record<SyncItem, CopyKey> = { favorites: 'favorites', history: 'history', tabs: 'syncTabs', desktop: 'desktop', siteSettings: 'syncSiteSettings', settings: 'settings', profiles: 'profiles' };
export const syncItemHints: Record<SyncItem, CopyKey> = { favorites: 'syncFavoritesHint', history: 'syncHistoryHint', tabs: 'syncTabsHint', desktop: 'syncDesktopHint', siteSettings: 'syncSiteSettingsHint', settings: 'syncSettingsHint', profiles: 'syncProfilesHint' };

export function syncFocusTarget<T extends { isConnected: boolean; disabled?: boolean; inert?: boolean }>(opener: T | null, controls: readonly T[]): T | null {
  return [opener, ...controls].find(target => target?.isConnected && !target.disabled && !target.inert) ?? null;
}

export function syncRelativeTime(time: number | null, language: Language, now = Date.now()): string {
  if (time === null || !Number.isFinite(time)) return text('syncNever', language);
  const minutes = Math.floor(Math.max(0, now - time) / 60000);
  if (!minutes) return text('syncJustNow', language);
  const count = minutes < 60 ? minutes : minutes < 1440 ? Math.floor(minutes / 60) : Math.floor(minutes / 1440);
  const key = minutes < 60 ? count === 1 ? 'syncMinuteOne' : 'syncMinuteMany' : minutes < 1440 ? count === 1 ? 'syncHourOne' : 'syncHourMany' : count === 1 ? 'syncDayOne' : 'syncDayMany';
  return text(key, language).replace('{count}', new Intl.NumberFormat(language).format(count));
}

const settingTitles: Record<string, CopyKey> = { theme: 'theme', contrast: 'highContrast', darkPages: 'darkPages', darkStrength: 'darkStrength', darkTone: 'darkTone', searchEngine: 'searchEngine', language: 'language', onStart: 'onStart', askWhereToSave: 'askWhereToSave', blockAds: 'blockAdsTrackers', blockThirdPartyCookies: 'blockThirdPartyCookies', quickAccess: 'quickAccess', showCapture: 'showCapture', marketplace: 'themes', clearHistoryOnClose: 'clearHistoryOnClose', clearCacheOnClose: 'clearCacheOnClose' };
export function syncConflictTitle(conflict: Pick<SyncConflict, 'item' | 'title'>, language: Language): string {
  const title = conflict.title.trim();
  const setting = (conflict.item === 'settings' || conflict.item === 'siteSettings') && settingTitles[title];
  if (setting) return text(setting, language);
  if (conflict.item === 'siteSettings' && /^(?:blocking|dark|permissions|never|always):/.test(title)) return title.slice(title.indexOf(':') + 1);
  if (!title || title === conflict.item || /^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(title)) return text(syncItemLabels[conflict.item], language);
  return title;
}

export function syncErrorKey(reason: unknown): CopyKey {
  const message = reason instanceof Error ? reason.message : String(reason);
  if (Object.hasOwn(copy, message)) return message as CopyKey;
  const codes: string[] = message.match(/\bSYNC_[A-Z_]+\b/g) ?? [];
  return codes.find((key): key is CopyKey => Object.hasOwn(copy, key)) ?? 'browserError';
}
