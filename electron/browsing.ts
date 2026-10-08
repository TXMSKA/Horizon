import { SEARCH_ENGINES } from '../src/shared/api';
import type { SearchEngine, SettingsSection } from '../src/shared/api';
const URL_LIMIT = 8192;
export function settingsAddress(section: SettingsSection): string { return section === 'general' ? 'horizon://settings' : `horizon://settings/${section}`; }
export function settingsSection(value: string): SettingsSection | null {
  return (['general', 'appearance', 'privacy', 'privacy/sites', 'profiles', 'extensions', 'sync'] as const).find(section => settingsAddress(section) === value) ?? null;
}

export function isAllowedURL(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > URL_LIMIT || value.trim() !== value) return false;
  if (Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) return false;
  if (value === 'about:blank') return true;
  try {
    const url = new URL(value);
    return (url.protocol === 'https:' || url.protocol === 'http:') && !!url.hostname && !url.username && !url.password;
  } catch { return false; }
}

export function isWebURL(value: unknown): value is string {
  return isAllowedURL(value) && value !== 'about:blank';
}

export function isAllowedSubframeURL(value: unknown): value is string {
  if (isAllowedURL(value) || value === 'about:srcdoc') return true;
  if (typeof value !== 'string' || !value || value.trim() !== value) return false;
  try { return ['data:', 'blob:'].includes(new URL(value).protocol); }
  catch { return false; }
}

export function parseErrorName(description: string): string {
  return description.match(/\bERR_[A-Z_]+\b/)?.[0] ?? 'ERR_FAILED';
}

export function classifyInput(input: string, engine: SearchEngine = 'duckduckgo'): string {
  if (typeof input !== 'string' || input.length > URL_LIMIT) throw new Error('Invalid address');
  const value = input.trim();
  if (!value || Array.from(value).some(character => character.charCodeAt(0) < 32 || character.charCodeAt(0) === 127)) {
    throw new Error('Invalid address');
  }
  if (isAllowedURL(value)) return new URL(value).href;

  // A host with a port resembles a URI scheme, so recognize it before rejecting schemes.
  if (!/\s/.test(value)) {
    try {
      const url = new URL(`https://${value}`);
      const host = url.hostname;
      const looksLikeHost = host === 'localhost' || host.includes('.') || (host.startsWith('[') && host.endsWith(']'));
      if (looksLikeHost && !url.username && !url.password && isWebURL(url.href)) return url.href;
    } catch { /* Non-address text is searched below. */ }
  }
  if (/^[a-z][a-z\d+.-]*:/i.test(value)) throw new Error('Unsupported address scheme');
  if (!Object.hasOwn(SEARCH_ENGINES, engine)) throw new Error('Invalid search engine');
  const search = SEARCH_ENGINES[engine].searchPrefix + encodeURIComponent(value);
  if (!isWebURL(search)) throw new Error('Invalid address');
  return search;
}
