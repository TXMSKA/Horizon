import { SEARCH_ENGINES } from '../src/shared/api';
import type { SearchEngine, SettingsSection } from '../src/shared/api';
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore TS1479: Node supports require(esm), and the renderer needs this pure package entry.
import { classifyInput as engineClassifyInput, isAllowedURL, isWebURL, isAllowedSubframeURL, parseErrorName } from '../packages/engine/src/urls.js';
export { isAllowedURL, isWebURL, isAllowedSubframeURL, parseErrorName };
export function settingsAddress(section: SettingsSection): string { return section === 'general' ? 'horizon://settings' : `horizon://settings/${section}`; }
export function settingsSection(value: string): SettingsSection | null {
  return (['general', 'appearance', 'privacy', 'privacy/sites', 'profiles', 'extensions', 'sync'] as const).find(section => settingsAddress(section) === value) ?? null;
}
export function classifyInput(input: string, searchEngine: SearchEngine = 'duckduckgo'): string {
  const prefix = Object.hasOwn(SEARCH_ENGINES, searchEngine) ? SEARCH_ENGINES[searchEngine].searchPrefix : '';
  return engineClassifyInput(input, prefix);
}
