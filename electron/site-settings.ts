import { randomUUID } from 'node:crypto';
import { isIP } from 'node:net';
import { getDomain } from 'tldts-experimental';
import { SITE_PERMISSIONS } from '../src/shared/api';
import type { PermissionDecision, PermissionDecisions, PermissionPrompt, SitePermission, SiteSettings, SiteSettingsStore } from '../src/shared/api';
import { isWebURL } from './browsing';

export const SITE_SETTINGS_LIMIT = 10000;
export const defaultPermissions = (): PermissionDecisions => ({ camera: 'ask', microphone: 'ask', location: 'ask', notifications: 'ask' });
export const isSitePermission = (value: unknown): value is SitePermission => SITE_PERMISSIONS.some(permission => permission === value);
export const isPermissionDecision = (value: unknown): value is PermissionDecision => value === 'ask' || value === 'allow' || value === 'block';
export function siteOrigin(url: string): string | null { return isWebURL(url) ? new URL(url).origin : null; }
export function siteHost(url: string): string | null { return isWebURL(url) ? new URL(url).hostname.replace(/\.$/, '') : null; }
export function validOrigin(value: unknown): value is string {
  return typeof value === 'string' && value.length <= 2048 && siteOrigin(value) === value;
}
export function validHost(value: unknown): value is string {
  if (typeof value !== 'string' || !value || value.length > 253) return false;
  return siteHost(`https://${value}/`) === value && new URL(`https://${value}/`).host === value;
}
export function secureOrigin(origin: string): boolean {
  if (!validOrigin(origin)) return false;
  const url = new URL(origin);
  return url.protocol === 'https:' || url.hostname === 'localhost' || url.hostname.endsWith('.localhost') || url.hostname === '[::1]' || isIP(url.hostname) === 4 && url.hostname.startsWith('127.');
}
export function siteSettings(settings: SiteSettingsStore, url: string): SiteSettings | null {
  const origin = siteOrigin(url), host = siteHost(url);
  if (!origin || !host) return null;
  const stored = settings.permissions.find(entry => entry.origin === origin);
  const permissions = stored ? Object.fromEntries(SITE_PERMISSIONS.map(key => [key, stored[key]])) as PermissionDecisions : defaultPermissions();
  return { host, origin, blocking: settings.blocking.find(entry => entry.host === host)?.enabled ?? true, dark: settings.dark.find(entry => entry.host === host)?.enabled ?? true, permissions };
}
export function setBlocking(settings: SiteSettingsStore, host: string, enabled: boolean): void {
  if (!validHost(host)) throw new Error('SITE_UNAVAILABLE');
  const entry = settings.blocking.find(entry => entry.host === host);
  if (entry) entry.enabled = enabled;
  else {
    if (settings.blocking.length >= SITE_SETTINGS_LIMIT) throw new Error('SITE_SETTINGS_LIMIT');
    settings.blocking.push({ host, enabled });
  }
}
export function setSiteDark(settings: SiteSettingsStore, host: string, enabled: boolean): void {
  if (!validHost(host)) throw new Error('SITE_UNAVAILABLE');
  const entry = settings.dark.find(entry => entry.host === host);
  if (entry) entry.enabled = enabled;
  else {
    if (settings.dark.length >= SITE_SETTINGS_LIMIT) throw new Error('SITE_SETTINGS_LIMIT');
    settings.dark.push({ host, enabled });
  }
}
export function setPermission(settings: SiteSettingsStore, origin: string, permission: SitePermission, decision: PermissionDecision): void {
  if (!validOrigin(origin)) throw new Error('SITE_UNAVAILABLE');
  let entry = settings.permissions.find(entry => entry.origin === origin);
  if (!entry) {
    if (settings.permissions.length >= SITE_SETTINGS_LIMIT) throw new Error('SITE_SETTINGS_LIMIT');
    entry = { origin, ...defaultPermissions() }; settings.permissions.push(entry);
  }
  entry[permission] = decision;
}
export function requestedPermissions(permission: string, details: { mediaTypes?: string[]; mediaType?: string; isMainFrame?: boolean } = {}): SitePermission[] {
  if (permission === 'geolocation') return ['location'];
  if (permission === 'notifications') return ['notifications'];
  if (permission !== 'media') return [];
  const types = details.mediaTypes ?? (details.mediaType ? [details.mediaType] : []);
  if (!types.length || types.some(type => type !== 'audio' && type !== 'video')) return [];
  return [...(types.includes('video') ? ['camera' as const] : []), ...(types.includes('audio') ? ['microphone' as const] : [])];
}

interface Pending { id: string; origin: string; permissions: SitePermission[]; callbacks: ((allowed: boolean) => void)[] }
export class PermissionQueue {
  private queues = new Map<string, Pending[]>();
  // A prompt hides its page, and Chromium repeats a hidden page's location request once the page shows again,
  // so a dismissal refuses that origin and permission until the tab navigates instead of prompting in a loop.
  private dismissed = new Map<string, Set<string>>();
  constructor(private settings: SiteSettingsStore, private changed: () => void, private remember: () => void) {}
  private decision(tabId: string, request: Pending): boolean | undefined {
    const decisions = siteSettings(this.settings, request.origin)!.permissions, dismissed = this.dismissed.get(tabId);
    const current = (permission: SitePermission) => decisions[permission] !== 'ask' ? decisions[permission] : dismissed?.has(`${request.origin}
${permission}`) ? 'block' : 'ask';
    if (request.permissions.some(permission => current(permission) === 'block')) return false;
    if (request.permissions.every(permission => current(permission) === 'allow')) return true;
    return undefined;
  }
  request(tabId: string, origin: string, permissions: SitePermission[], callback: (allowed: boolean) => void): void {
    if (!secureOrigin(origin) || !permissions.length) { callback(false); return; }
    const request = { id: randomUUID(), origin, permissions, callbacks: [callback] };
    const decision = this.decision(tabId, request);
    if (decision !== undefined) { callback(decision); return; }
    const queue = this.queues.get(tabId) ?? [];
    if (queue.reduce((count, request) => count + request.callbacks.length, 0) >= 32) { callback(false); return; }
    // Chromium can split one media operation into callbacks for both devices.
    const duplicate = queue.find(request => request.origin === origin && request.permissions.join(',') === permissions.join(','));
    if (duplicate) { duplicate.callbacks.push(callback); return; }
    queue.push(request); this.queues.set(tabId, queue); this.changed();
  }
  prompt(tabId: string): PermissionPrompt | null {
    const request = this.queues.get(tabId)?.[0];
    if (!request) return null;
    const decisions = siteSettings(this.settings, request.origin)!.permissions;
    return { id: request.id, origin: request.origin, permissions: request.permissions.filter(permission => decisions[permission] === 'ask') };
  }
  answer(tabId: string, id: string, answer: 'allow' | 'block' | 'dismiss'): void {
    const queue = this.queues.get(tabId), request = queue?.[0];
    if (!request || request.id !== id) throw new Error('PERMISSION_PROMPT_STALE');
    const asked = this.prompt(tabId)!.permissions;
    if (answer !== 'dismiss') {
      for (const permission of asked) setPermission(this.settings, request.origin, permission, answer);
      this.remember();
    } else {
      const dismissed = this.dismissed.get(tabId) ?? new Set<string>();
      for (const permission of asked) dismissed.add(`${request.origin}
${permission}`);
      this.dismissed.set(tabId, dismissed);
    }
    queue!.shift(); if (!queue!.length) this.queues.delete(tabId);
    for (const callback of request.callbacks) callback(answer === 'allow');
    this.reconcile();
  }
  reconcile(): void {
    for (const [tabId, queue] of this.queues) {
      const settled = queue.filter(request => this.decision(tabId, request) !== undefined);
      const remaining = queue.filter(request => this.decision(tabId, request) === undefined);
      if (remaining.length) this.queues.set(tabId, remaining); else this.queues.delete(tabId);
      for (const request of settled) for (const callback of request.callbacks) callback(this.decision(tabId, request)!);
    }
    this.changed();
  }
  drop(tabId: string): void {
    const queue = this.queues.get(tabId); this.queues.delete(tabId); this.dismissed.delete(tabId);
    for (const request of queue ?? []) for (const callback of request.callbacks) callback(false);
    if (queue?.length) this.changed();
  }
}

export function cookieSite(value: string): string | null {
  try {
    const url = new URL(value);
    const protocol = url.protocol === 'ws:' ? 'http:' : url.protocol === 'wss:' ? 'https:' : url.protocol;
    if (!['http:', 'https:'].includes(protocol)) return null;
    const host = url.hostname.replace(/\.$/, '');
    return `${protocol}//${getDomain(host, { allowPrivateDomains: true }) ?? host}`;
  } catch { return null; }
}
export function stripCookieHeaders<T extends string | string[]>(headers: Record<string, T>, response: boolean, requestURL: string, topURL: string, enabled: boolean, refused: Set<string>): Record<string, T> {
  const requestSite = cookieSite(requestURL), topSite = cookieSite(topURL);
  if (!enabled || !requestSite || !topSite || requestSite === topSite) return headers;
  const next = { ...headers };
  for (const [key, value] of Object.entries(headers)) {
    if (key.toLowerCase() !== (response ? 'set-cookie' : 'cookie')) continue;
    delete next[key];
    const lines: string[] = typeof value === 'string' ? [value] : value;
    for (const line of lines) for (const cookie of response ? [line.split(';', 1)[0]!] : line.split(';')) {
      const equal = cookie.indexOf('='), name = cookie.slice(0, equal).trim();
      if (equal > 0 && /^[!#$%&'*+\-.^_`|~\da-z]+$/i.test(name)) refused.add(`${requestSite}\n${name}`);
    }
  }
  return next;
}
