import { dirname, resolve, sep } from 'node:path';
import type { Profile } from '../src/shared/api';
import type { Session } from 'electron';
import { isProfileId, isProfilePartition } from './profiles';

export const WEB_STORE_ORIGIN = 'https://chromewebstore.google.com';
export function isWebStoreURL(value: string): boolean {
  try { const url = new URL(value); return url.origin === WEB_STORE_ORIGIN && !url.username && !url.password; }
  catch { return false; }
}
export function extensionId(value: unknown): value is string { return typeof value === 'string' && /^[a-p]{32}$/.test(value); }
export function isExtensionURL(target: Session, value: string): boolean {
  try { const url = new URL(value); return url.protocol === 'chrome-extension:' && extensionId(url.hostname) && !!target.extensions.getExtension(url.hostname) && !url.username && !url.password && !url.port; }
  catch { return false; }
}
export function extensionDirectory(userData: string, profile: Profile, privateWindow = false): string {
  if (privateWindow || !isProfileId(profile.id) || !isProfilePartition(profile.partition)) throw new Error('EXTENSIONS_UNAVAILABLE');
  return resolve(userData, 'profiles', profile.id, 'extensions');
}
export function extensionAsset(root: string, path: string): string {
  const target = resolve(root, path);
  if (target === root || !target.startsWith(`${resolve(root)}${sep}`)) throw new Error('EXTENSION_PATH_INVALID');
  return target;
}
// The library adds partial APIs. Horizon supplies alarms and commands, but native webRequest is masked by our session policy.
const supportedPermissions = new Set(['activeTab', 'tabs', 'storage', 'scripting', 'management', 'alarms', 'contextMenus', 'cookies', 'notifications', 'webNavigation', 'unlimitedStorage']);
export function unsupportedPermissions(manifest: Record<string, unknown>): string[] {
  const permissions = [manifest.permissions, manifest.optional_permissions].flatMap(value => Array.isArray(value) ? value : []);
  const unsupported = permissions.filter((value): value is string => typeof value === 'string' && value !== '<all_urls>' && !value.includes('://') && !supportedPermissions.has(value));
  if (manifest.page_action) unsupported.push('pageAction');
  if (manifest.omnibox) unsupported.push('omnibox');
  if (manifest.side_panel) unsupported.push('sidePanel');
  if (manifest.storage && typeof manifest.storage === 'object' && 'managed_schema' in manifest.storage) unsupported.push('storage.managed');
  return [...new Set(unsupported)].sort();
}
export function manifestAccess(manifest: Record<string, unknown>): string[] {
  const scripts = Array.isArray(manifest.content_scripts) ? manifest.content_scripts.flatMap(script => script && typeof script === 'object' && 'matches' in script ? script.matches : []) : [];
  return [...new Set([manifest.permissions, manifest.optional_permissions, manifest.host_permissions, manifest.optional_host_permissions, scripts]
    .flatMap(value => Array.isArray(value) ? value.filter((value): value is string => typeof value === 'string') : []))].sort();
}
export function extensionStatePath(directory: string): string { return resolve(dirname(directory), 'extensions.json'); }
