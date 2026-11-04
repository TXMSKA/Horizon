import { randomUUID } from 'node:crypto';
import { readdirSync, rmSync } from 'node:fs';
import { resolve } from 'node:path';
import type { BrowserWindow, WebContents } from 'electron';
import type { Client, EntryRow, ImportCount } from 'vault-client' with { 'resolution-mode': 'import' };
import type { ImportPasswordsResult, VaultCommand, VaultLogin, VaultState, VaultSuggestion, VaultTimeout } from '../src/shared/api';
import { serviceReason } from '../src/shared/services';
import type { ServiceReason } from '../src/shared/services';
import type { ReachAnswer } from './services-install';
import { assertVaultPage, fillLogin, inspectLogin, vaultOrigin } from './vault-page';
import type { LoginFields } from './vault-page';
import { vaultClipboard, vaultTokenStore } from './vault-storage';
import type { StoreCipher } from './store';
import { vaultAudit } from './vault-log';
import type { PasswordsFormat } from './import-passwords';

// pixels is the display scale: DOM snapshot bounds arrive in device pixels.
export interface VaultPage { contents: WebContents; generation: number; id: string; zoom: number; pixels?: number; bounds: { x: number; y: number; width: number; height: number } }
export interface SuggestionRect { x: number; y: number; width: number; height: number }
// Where the field in view is, in window coordinates, with the boxes of the other inputs a suggestion should stay clear of.
export interface SuggestionAnchor { field: SuggestionRect; avoid: SuggestionRect[]; page: SuggestionRect }
interface Options {
  window: BrowserWindow; directory: string; privateWindow: boolean; cipher: StoreCipher; clipboard: Parameters<typeof vaultClipboard>[0];
  page(): VaultPage | null; covered(): boolean; changed(): void; timeout(): VaultTimeout; saveTimeout(value: VaultTimeout): void;
  revealPage(): void;
  // Shows, moves or removes the suggestion over the live page; the page itself is never hidden for it.
  present?(suggestion: VaultSuggestion | null, anchor: SuggestionAnchor | null): void;
  connect?: () => Promise<Client>;
  // Called when the person reached a Vault feature and the client says Vault is missing or did not start (never from a sign-in field).
  unavailable?(reason: ServiceReason): void;
}
const connections = new Map<string, { promise: Promise<Client>; users: number }>();
const auditEvents: Partial<Record<VaultCommand['type'], Parameters<typeof vaultAudit>[0]>> = { 'vault-unlock': 'unlock', 'vault-hello': 'hello', 'vault-lock': 'lock', 'vault-fill': 'fill', 'vault-copy': 'copy', 'vault-add': 'add', 'vault-import-permission': 'permission', 'vault-import-permission-hello': 'permission' };
// The one place where the import asks Vault whether Horizon may save passwords. The permission is given in the apps system of Vault.
const askImportPermission = async (service: Client): Promise<boolean> => (await service.apps.self()).permissions.includes('import');
// What a proof of the master password or of Windows Hello answers, as codes the dialog has words for; anything else is an ordinary Vault failure.
// Vault answers "locked" to a wrong master password (core/src/unlock.ts:33), and "not_found" means a Hello that is not set up only when the proof is Hello.
function permissionCode(error: unknown, hello: boolean): string | null {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : '';
  if (code === 'locked') return hello ? 'VAULT_HELLO_FAILED' : 'VAULT_PERMISSION_PASSWORD';
  if (code === 'limited') return 'VAULT_PERMISSION_LIMITED';
  if (code === 'not_found') return hello ? 'VAULT_HELLO_NOT_SET_UP' : null;
  if (code === 'forbidden') return 'VAULT_PERMISSION_FORBIDDEN';
  return code === 'unavailable' && hello ? 'VAULT_HELLO_UNAVAILABLE' : null;
}
const PERMISSION_CODES = ['VAULT_PERMISSION_PASSWORD', 'VAULT_PERMISSION_LIMITED', 'VAULT_HELLO_NOT_SET_UP', 'VAULT_PERMISSION_FORBIDDEN', 'VAULT_HELLO_UNAVAILABLE', 'VAULT_HELLO_FAILED'];
// The address a page view is at now; a view that cannot say has none.
const originOf = (page: VaultPage) => { try { return vaultOrigin(page.contents.getURL()); } catch { return null; } };
const value = (row: EntryRow, id: string) => row.entry.fields.find(field => field.id === id)?.value ?? '';
export function loginMetadata(rows: EntryRow[], origin: string): VaultLogin[] {
  return rows.filter(row => row.entry.kind === 'login' && vaultOrigin(value(row, 'website')) === origin)
    .map(row => ({ id: row.entry.id, origin, title: row.entry.title, username: value(row, 'username').slice(0, 512) }));
}
// The service lists every saved sign-in as id, title, username and website, never a value; a sign-in without a usable website cannot be shown or filled.
export function loginSummaries(rows: unknown): VaultLogin[] {
  if (!Array.isArray(rows)) throw new Error('VAULT_UNAVAILABLE');
  const seen = new Set<string>();
  return rows.flatMap((row: unknown): VaultLogin[] => {
    const fields = row && typeof row === 'object' ? row as Record<string, unknown> : {};
    const { id, title, username, website } = fields;
    const origin = typeof website === 'string' ? vaultOrigin(website) : null;
    if (typeof id !== 'string' || !id || id.length > 128 || seen.has(id) || typeof title !== 'string' || typeof username !== 'string' || !origin) return [];
    seen.add(id);
    return [{ id, origin, title: title.slice(0, 500), username: username.slice(0, 512) }];
  });
}
// The display list stays bounded even when a service entry contains a long field.
function bounded(items: VaultLogin[]): VaultLogin[] {
  const next = items.slice(-4096);
  while (next.length && Buffer.byteLength(JSON.stringify(next)) > 1024 * 1024) next.shift();
  return next;
}
// Older versions kept an encrypted index of sign-in titles, usernames and sites in the profile directory. No Vault display data lives outside Vault, so it is deleted.
const legacyIndex = 'vault-sites.sealed';
function removeLegacyIndex(directory: string): void {
  let failed = false;
  try {
    for (const name of readdirSync(directory)) {
      if (name !== legacyIndex && !(name.startsWith(`${legacyIndex}.`) && name.endsWith('.tmp'))) continue;
      try { rmSync(resolve(directory, name), { force: true }); } catch { failed = true; }
    }
  } catch (error) { failed = !(error instanceof Error && 'code' in error && error.code === 'ENOENT'); }
  // Only the fixed event reaches the log, never a path or a name.
  if (failed) vaultAudit('cleanup', 'denied');
}
// The service's own answer to a connect, kept with the failure so the reason (missing or did not start) can reach the person; the message stays the fixed code.
class Unreachable extends Error {
  readonly reason: ServiceReason | null;
  constructor(reason: ServiceReason | null) { super('VAULT_UNAVAILABLE'); this.reason = reason; }
}
// The commands of a feature the person reached; a sign-in field's background connect is not one of them.
const offerCommands = new Set<VaultCommand['type']>(['vault-refresh', 'vault-add', 'vault-unlock', 'vault-hello', 'vault-import-permission', 'vault-import-permission-hello']);
function errorCode(error: unknown): 'VAULT_UNAVAILABLE' | 'VAULT_STORAGE_UNAVAILABLE' {
  return error instanceof Error && error.message === 'VAULT_STORAGE_UNAVAILABLE' ? 'VAULT_STORAGE_UNAVAILABLE' : 'VAULT_UNAVAILABLE';
}
export function createVault(options: Options) {
  const state: VaultState = { available: false, created: false, unlocked: false, importAllowed: false, unlockMethod: null, timeout: options.timeout(), logins: [], suggestion: null, unlockPrompt: null, error: null, reason: null, windows: process.platform === 'win32' };
  removeLegacyIndex(options.directory);
  // The sign-ins found for the field in view exist only here, only while Vault is unlocked.
  let client: Client | undefined, connection: Promise<Client> | undefined;
  let closed = false, working = false, scanning = false, again: 'scan' | 'reoffer' | null = null, epoch = 0, unlockedAt = 0;
  // What Vault last said is kept for a short while, so a field never waits for the service; a failure to reach it is retried with a growing pause, never final.
  let statusAt = 0, loginsAt = 0, failures = 0, retryAt = 0, contacting: Promise<void> | undefined, wake: NodeJS.Timeout | undefined, reofferNext = false, burstUntil = 0;
  let closeTask: Promise<void> | undefined;
  let target: { page: VaultPage; fields: LoginFields; id: string } | null = null;
  // The fields whose suggestion was dismissed or used; focusing or clicking one again offers it again.
  const suppressed = new Set<string>();
  const focusKey = (page: VaultPage, node: number) => `${page.id}:${page.generation}:${node}`;
  const copied = vaultClipboard(options.clipboard);
  // The field's place follows the page: its view offset is read now, so a banner or a resize moves the suggestion without another page inspection.
  const anchor = (): SuggestionAnchor | null => {
    if (!target) return null;
    const live = options.page(), page = live && live.contents === target.page.contents ? live : target.page, pixels = page.pixels ?? 1;
    const rect = (x: number, y: number, width: number, height: number) => ({ x: page.bounds.x + x / pixels, y: page.bounds.y + y / pixels, width: width / pixels, height: height / pixels });
    const { fields } = target;
    return { field: rect(fields.x, fields.y, fields.width, fields.height), avoid: fields.others.map(other => rect(other[0]!, other[1]!, other[2]!, other[3]!)), page: { ...page.bounds } };
  };
  const place = () => { if (!closed) options.present?.(state.suggestion ? structuredClone(state.suggestion) : null, state.suggestion ? anchor() : null); };
  const publish = () => { if (!closed) { state.timeout = options.timeout(); options.changed(); place(); } };
  const dismiss = () => { target = null; state.suggestion = null; state.unlockPrompt = null; };
  const refocus = () => { const page = options.page(); if (page && !page.contents.isDestroyed()) page.contents.focus(); };
  // While Vault is locked nothing of it stays in memory: the panel list and the field's sign-ins go, and an open suggestion becomes only the offer to unlock.
  const forget = () => {
    state.logins = []; loginsAt = 0;
    if (state.suggestion) state.suggestion = { ...state.suggestion, locked: true, logins: [] };
  };
  const getClient = async () => {
    if (closed || options.privateWindow) throw new Error('VAULT_UNAVAILABLE');
    if (client) return client;
    if (!connection) {
      connection = (async () => {
        if (options.connect) return options.connect();
        let shared = connections.get(options.directory);
        if (!shared) {
          const promise = import('vault-client').then(({ connect }) => connect({ app: { id: 'horizon', name: 'Horizon', kind: 'cosmic' }, tokens: vaultTokenStore(resolve(options.directory, 'vault-token.sealed'), options.cipher) }));
          shared = { promise, users: 0 }; connections.set(options.directory, shared);
        }
        shared.users++;
        try { return await shared.promise; }
        catch (error) { if (--shared.users === 0) connections.delete(options.directory); throw new Unreachable(serviceReason(error)); }
      })();
    }
    try { client = await connection; state.reason = null; failures = 0; retryAt = 0; return client; }
    catch (error) { connection = undefined; state.reason = error instanceof Unreachable ? error.reason : serviceReason(error); throw error; }
  };
  // background is a refresh nobody asked for: when a command of the person is under way its answer may already be stale, so it is let go.
  const updateStatus = async (service: Client, background = false) => {
    const status = await service.status();
    if (closed) throw new Error('VAULT_UNAVAILABLE');
    if (background && working) return;
    state.available = true; state.created = status.created; state.error = null; statusAt = Date.now();
    if (state.unlocked !== status.unlocked) {
      epoch++;
      if (status.unlocked) unlockedAt = Date.now();
      else { unlockedAt = 0; state.unlockMethod = null; forget(); }
    }
    state.unlocked = status.unlocked;
    const limit = options.timeout();
    if (state.unlocked && limit !== 'close' && Date.now() - unlockedAt >= Number(limit) * 60000) {
      await service.lock(); epoch++; state.unlocked = false; state.unlockMethod = null; forget(); dismiss();
    }
  };
  // The sign-ins as display metadata only; a value is asked for one exact origin when it is copied or filled.
  const statusTtl = 15000, loginsTtl = 30000;
  const loadLogins = async (service: Client) => {
    const ticket = epoch, summaries = loginSummaries(await service.listLogins());
    if (closed || ticket !== epoch) throw new Error('VAULT_PAGE_CHANGED');
    state.logins = bounded(summaries); loginsAt = Date.now();
  };
  // Once Vault is unlocked, a suggestion that only offered the unlock shows the sign-ins of its own origin, without waiting for the field to be focused again.
  const reveal = async () => {
    const current = target, shown = state.suggestion;
    if (!current || !shown?.locked || !client || !state.unlocked) return;
    const ticket = epoch;
    try {
      if (!loginsAt) await loadLogins(client);
      const page = options.page();
      if (closed || ticket !== epoch || target !== current || state.suggestion !== shown || !page || page.contents !== current.page.contents || page.generation !== current.page.generation || page.id !== current.page.id || originOf(page) !== current.fields.origin) return;
      const found = state.logins.filter(item => item.origin === current.fields.origin);
      if (found.length) state.suggestion = { ...shown, locked: false, logins: structuredClone(found) };
      else dismiss();
    } catch { dismiss(); }
    publish();
  };
  const refresh = async () => {
    const service = await getClient(); await updateStatus(service);
    state.importAllowed = await askImportPermission(service);
    if (state.unlocked) await loadLogins(service);
    await reveal();
    publish();
  };
  // Reaches Vault when there is no connection yet (as soon as a web page is in view, not at the first field) and keeps the cache fresh; one attempt at a time, off the scan.
  const contact = () => {
    if (closed || options.privateWindow || contacting || Date.now() < retryAt) return;
    const stale = Boolean(client) && (Date.now() - statusAt > statusTtl || state.unlocked && Date.now() - loginsAt > loginsTtl);
    if (client && !stale) return;
    contacting = (async () => {
      try {
        const service = await getClient(); await updateStatus(service, true);
        if (!working && state.unlocked && Date.now() - loginsAt > loginsTtl) await loadLogins(service);
        failures = 0; retryAt = 0;
      } catch { failures++; retryAt = Date.now() + Math.min(30000, 1000 * 2 ** Math.min(failures, 5)); }
      finally { contacting = undefined; }
      if (client) await reveal();
      schedule(0);
    })();
  };
  const schedule = (delay: number, reoffer = false) => {
    if (closed || options.privateWindow) return;
    reofferNext ||= reoffer; clearTimeout(wake);
    wake = setTimeout(() => { const next = reofferNext; reofferNext = false; void scan(next).finally(() => schedule(target ? 200 : Date.now() < burstUntil ? 100 : 400)); }, delay);
    wake.unref();
  };
  const scan = async (reoffer = false): Promise<void> => {
    if (closed || working || options.privateWindow || state.unlockPrompt) return;
    if (scanning) { again = reoffer || again === 'reoffer' ? 'reoffer' : 'scan'; return; }
    const page = options.page();
    if (!page || options.covered()) {
      // A dialog of the chrome covers the page meanwhile.
      if (target && (!page || target.page.contents !== page.contents || target.page.generation !== page.generation || target.page.id !== page.id || originOf(page) !== target.fields.origin)) { epoch++; dismiss(); publish(); }
      return;
    }
    const origin = originOf(page);
    if (!origin) return;
    contact();
    scanning = true;
    try {
      const fields = await inspectLogin(page.contents, origin, false);
      const now = options.page();
      if (!now || page.contents !== now.contents || page.generation !== now.generation || page.id !== now.id || options.covered()) return;
      if (!fields) { suppressed.clear(); if (target) { dismiss(); publish(); } return; }
      const key = focusKey(page, fields.focused);
      if (reoffer) suppressed.delete(key);
      if (suppressed.has(key)) { if (target) { dismiss(); publish(); } return; }
      // Only the very first sight of the sign-ins waits for the service; after that the cache answers and refreshes itself.
      if (client && state.unlocked && !loginsAt) await loadLogins(client);
      const logins = state.unlocked ? state.logins.filter(item => item.origin === origin) : [];
      // A locked Vault shows nothing of itself, only the way to unlock it, and only once Horizon has reached a created Vault.
      const locked = !state.unlocked && Boolean(client) && state.available && state.created && !state.error;
      if (!locked && !logins.length) { if (target) { dismiss(); publish(); } return; }
      // DOM snapshot bounds are device pixels; the view's bounds and the chrome's layout are not.
      const pixels = page.pixels ?? 1, chromeZoom = options.window.webContents.getZoomFactor();
      const left = fields.x / pixels, bottom = (fields.y + fields.height) / pixels;
      if (left < 0 || fields.y < 0 || left >= page.bounds.width || bottom >= page.bounds.height) { if (target) { dismiss(); publish(); } return; }
      const x = (page.bounds.x + left) / chromeZoom, y = (page.bounds.y + bottom) / chromeZoom, width = fields.width / pixels / chromeZoom;
      const shown = state.suggestion;
      const same = target !== null && shown !== null && target.page.contents === page.contents && target.page.generation === page.generation && target.page.id === page.id && target.fields.focused === fields.focused
        && shown.origin === origin && shown.locked === locked && shown.logins.length === logins.length && shown.logins.every((item, index) => item.id === logins[index]!.id);
      target = { page, fields, id: same ? target!.id : randomUUID() };
      if (same) { state.suggestion = { ...shown, x, y, width }; place(); return; }
      state.suggestion = { id: target.id, origin, x, y, width, locked, logins: locked ? [] : structuredClone(logins) };
      publish();
    } catch (error) {
      // A page another tool is reading for a moment keeps what is shown; the next look settles it. Unreadable pages never get a suggestion.
      if (target && !(error instanceof Error && error.message === 'VAULT_PAGE_UNAVAILABLE')) { dismiss(); publish(); }
    }
    finally {
      scanning = false;
      if (again) { const next = again; again = null; schedule(0, next === 'reoffer'); }
    }
  };
  // Fills one sign-in of the suggestion in view. The values are read now, for this one origin, and go straight into the page.
  const fillInto = async (service: Client, selected: NonNullable<typeof target>, id: string) => {
    const ticket = epoch;
    const check = () => { if (closed || ticket !== epoch || !state.unlocked) throw new Error('VAULT_PAGE_CHANGED'); };
    const checkPage = () => {
      check(); const page = options.page();
      if (!page || page.contents !== selected.page.contents || page.id !== selected.page.id || page.generation !== selected.page.generation) throw new Error('VAULT_PAGE_CHANGED');
      assertVaultPage(page.contents, selected.fields.origin, options.privateWindow);
    };
    checkPage();
    const rows = await service.logins(selected.fields.origin); checkPage();
    const row = rows.find(row => row.entry.id === id && row.entry.kind === 'login' && vaultOrigin(value(row, 'website')) === selected.fields.origin);
    if (!row) throw new Error('VAULT_PAGE_CHANGED');
    options.revealPage(); selected.page.contents.focus();
    await fillLogin(selected.page.contents, selected.fields, { username: value(row, 'username'), password: value(row, 'password') }, options.privateWindow, checkPage);
    for (const node of [selected.fields.focused, selected.fields.username, selected.fields.password]) if (node) suppressed.add(focusKey(selected.page, node));
    dismiss(); publish();
  };
  const run = async (command: VaultCommand): Promise<void> => {
    if (closed || options.privateWindow) throw new Error('VAULT_UNAVAILABLE');
    if (command.type === 'vault-dismiss' || command.type === 'vault-cancel') {
      // A dialog that closed after its unlock has nothing left to cancel.
      if (command.type === 'vault-cancel' && !state.unlockPrompt) return;
      // The field stays quiet until the person focuses or clicks it again.
      if (target) suppressed.add(focusKey(target.page, target.fields.focused));
      epoch++; dismiss(); publish(); refocus(); return;
    }
    if (command.type === 'vault-ask') {
      // The chrome shows one dialog for the locked suggestion; the suggestion itself gives way to it.
      if (!target || !state.suggestion?.locked) throw new Error('VAULT_PAGE_CHANGED');
      state.unlockPrompt = { origin: target.fields.origin }; publish(); return;
    }
    if (command.type === 'vault-lock') {
      // Lock can interrupt a value request. It must not queue behind a pending fill.
      epoch++; dismiss(); forget(); state.unlocked = false; state.unlockMethod = null; publish();
      try {
        const service = await getClient();
        try { await copied.clear(); } finally { await service.lock(); }
        vaultAudit('lock', 'allowed');
      } catch (error) { state.error = errorCode(error); vaultAudit('lock', 'denied'); publish(); throw new Error(state.error); }
      return;
    }
    if (working) throw new Error('VAULT_BUSY');
    working = true;
    const event = auditEvents[command.type];
    try {
      if (command.type === 'set-vault-timeout') { options.saveTimeout(command.value); if (client) await updateStatus(client); publish(); return; }
      const service = await getClient();
      if (command.type === 'vault-unlock' || command.type === 'vault-hello' || command.type === 'vault-import-permission' || command.type === 'vault-import-permission-hello') {
        const ticket = epoch, hello = command.type === 'vault-hello' || command.type === 'vault-import-permission-hello';
        const windowHandle = () => {
          if (process.platform !== 'win32') throw new Error('VAULT_UNAVAILABLE');
          const handle = options.window.getNativeWindowHandle();
          return handle.length === 8 ? handle.readBigUInt64LE().toString() : handle.readUInt32LE().toString();
        };
        // The onboarding step of Vault is checked like an unlock, which also unlocks Vault, and then Horizon holds the import permission.
        try {
          if (command.type === 'vault-unlock') await service.unlock(command.password);
          else if (command.type === 'vault-hello') await service.hello.unlock(windowHandle());
          else await (command.type === 'vault-import-permission' ? service.permissions.importWithPassword(command.password) : service.permissions.importWithHello(windowHandle()));
        } catch (error) { const mapped = permissionCode(error, hello); throw mapped ? new Error(mapped) : error; }
        if (closed || ticket !== epoch) throw new Error('VAULT_PAGE_CHANGED');
        epoch++; state.unlocked = true; unlockedAt = Date.now(); state.unlockMethod = hello ? 'hello' : 'master';
        const asked = state.unlockPrompt;
        await refresh();
        // The unlock was asked from a sign-in field: the one sign-in of this site goes in at once; several are offered to choose from.
        if (asked) {
          state.unlockPrompt = null;
          const selected = target, shown = state.suggestion;
          if (selected && shown && !shown.locked && shown.logins.length === 1 && selected.fields.origin === asked.origin) {
            try { await fillInto(service, selected, shown.logins[0]!.id); } catch { dismiss(); publish(); }
          } else publish();
        }
      } else if (command.type === 'vault-refresh') await refresh();
      else {
        await updateStatus(service);
        if (!state.unlocked) throw new Error('VAULT_LOCKED');
        const ticket = epoch;
        const check = () => { if (closed || ticket !== epoch || !state.unlocked) throw new Error('VAULT_PAGE_CHANGED'); };
        if (command.type === 'vault-fill') {
          const selected = target;
          if (!selected || selected.id !== command.suggestion || !state.suggestion?.logins.some(item => item.id === command.id)) throw new Error('VAULT_PAGE_CHANGED');
          check(); await fillInto(service, selected, command.id);
        } else if (command.type === 'vault-copy') {
          if (!state.logins.some(item => item.id === command.id && item.origin === command.origin)) throw new Error('VAULT_PAGE_CHANGED');
          const rows = await service.logins(command.origin); check();
          const row = rows.find(row => row.entry.id === command.id && row.entry.kind === 'login' && vaultOrigin(value(row, 'website')) === command.origin);
          if (!row) throw new Error('VAULT_PAGE_CHANGED');
          await copied.copy(value(row, 'password'));
        } else if (command.type === 'vault-add') {
          const origin = vaultOrigin(command.website);
          if (!origin) throw new Error('VAULT_COMMAND_INVALID');
          await service.entries.save({ id: randomUUID(), kind: 'login', title: command.title, favorite: false, fields: [
            { id: 'website', name: 'Website', value: command.website, secret: false }, { id: 'username', name: 'Username', value: command.username, secret: false },
            { id: 'password', name: 'Password', value: command.password, secret: true },
          ], note: '', totp: '', recovery: [], files: [], updatedAt: new Date().toISOString() }, 0);
          check(); await refresh();
        }
      }
      if (event) vaultAudit(event, 'allowed');
    } catch (error) {
      // Service messages and request bodies never cross IPC or enter a log.
      if (error instanceof Error && PERMISSION_CODES.includes(error.message)) {
        // A refused request changes nothing in Vault, so the unlock state shown stays as it is.
        if (event) vaultAudit(event, 'denied');
        publish();
        throw error;
      }
      state.error = errorCode(error);
      epoch++; state.unlocked = false; state.unlockMethod = null; forget();
      if (event) vaultAudit(event, 'denied');
      if (state.reason && offerCommands.has(command.type)) options.unavailable?.(state.reason);
      if (command.type === 'vault-fill') dismiss();
      if (command.type === 'vault-unlock') command.password = '';
      publish();
      throw new Error(error instanceof Error && ['VAULT_LOCKED', 'VAULT_PAGE_CHANGED', 'VAULT_COMMAND_INVALID'].includes(error.message) ? error.message : state.error);
    } finally {
      if (command.type === 'vault-unlock' || command.type === 'vault-add' || command.type === 'vault-import-permission') command.password = '';
      working = false;
    }
  };
  // The file's text exists only inside this call: it is read after Vault is known to be unlocked and let go as soon as the service answers.
  // Vault refuses or accepts the whole file; only the counts come back, and neither the text nor a service message is kept or logged.
  const importPasswords = async (format: PasswordsFormat, read: () => string): Promise<ImportPasswordsResult> => {
    if (closed || options.privateWindow) throw new Error('VAULT_UNAVAILABLE');
    if (working) throw new Error('VAULT_BUSY');
    working = true;
    let count: ImportCount;
    try {
      let service: Client;
      try { service = await getClient(); await updateStatus(service); }
      catch (error) {
        state.error = errorCode(error); epoch++; state.unlocked = false; state.unlockMethod = null; forget(); publish();
        if (state.reason) options.unavailable?.(state.reason);
        throw new Error(state.error);
      }
      if (!state.unlocked) throw new Error('VAULT_LOCKED');
      if (!await askImportPermission(service)) { state.importAllowed = false; throw new Error('VAULT_IMPORT_PERMISSION'); }
      let source: string | undefined = read();
      try { count = await service.import(format, source); } finally { source = undefined; }
      if (![count?.imported, count?.duplicates, count?.skipped].every(number => Number.isSafeInteger(number) && number >= 0)) throw new Error('IMPORT_PASSWORDS_FAILED');
    } catch (error) {
      const message = error instanceof Error ? error.message : '';
      const required = typeof error === 'object' && error !== null && 'code' in error && error.code === 'permission_required';
      if (required) state.importAllowed = false;
      const known = ['VAULT_UNAVAILABLE', 'VAULT_STORAGE_UNAVAILABLE', 'VAULT_LOCKED', 'VAULT_IMPORT_PERMISSION'].includes(message) || message.startsWith('IMPORT_PASSWORDS_');
      const locked = typeof error === 'object' && error !== null && 'code' in error && error.code === 'locked';
      // A file that cannot be read is not a decision of Vault, so it is not audited.
      if (!message.startsWith('IMPORT_PASSWORDS_FILE_')) vaultAudit('import', 'denied');
      throw known ? error : new Error(required ? 'VAULT_IMPORT_PERMISSION' : locked ? 'VAULT_LOCKED' : 'IMPORT_PASSWORDS_FAILED');
    } finally { working = false; }
    vaultAudit('import', 'allowed');
    // The sign-ins are in Vault whether or not the list could be refreshed now; the panel refreshes itself when it opens.
    await refresh().catch(() => undefined);
    return { imported: count.imported, duplicates: count.duplicates, skipped: count.skipped };
  };
  schedule(400);
  const statusTimer = options.privateWindow ? undefined : setInterval(() => {
    if (client && !working && !closed) void updateStatus(client).then(reveal).then(publish).catch(() => { state.unlocked = false; forget(); state.error = 'VAULT_UNAVAILABLE'; epoch++; publish(); });
  }, 20000);
  statusTimer?.unref();
  // Asks the client once more without touching the unlock state: used by the install offer after an install and by Settings.
  const reach = async (): Promise<ReachAnswer> => {
    if (closed || options.privateWindow) return 'did_not_start';
    try { const service = await getClient(); await updateStatus(service); publish(); return state.created ? 'ready' : 'setup'; }
    catch { publish(); return state.reason ?? 'did_not_start'; }
  };
  return {
    state: () => structuredClone(state), status: () => ({ available: state.available, reason: state.reason }), run, scan: (reoffer = false) => scan(reoffer), importPasswords, reach, hasSession: () => Boolean(connection),
    // A page is in view or something in it moved or was pressed: look at the field soon, instead of at the next poll. The cache is refreshed in the background.
    nudge(delay = 40, reoffer = false) { burstUntil = Date.now() + 2000; schedule(delay, reoffer); },
    navigated() { statusAt = 0; if (loginsAt) loginsAt = 1; burstUntil = Date.now() + 3000; contact(); schedule(120); },
    // The view moved (a banner, a resize): the suggestion follows without another inspection.
    reposition() { if (target) place(); },
    // True while a suggestion is up, so the chrome can route Escape to it.
    offering: () => Boolean(state.suggestion),
    invalidate() { epoch++; dismiss(); publish(); },
    close(): Promise<void> {
      if (closeTask) return closeTask;
      closeTask = (async () => {
        closed = true; epoch++; clearTimeout(wake); clearInterval(statusTimer); dismiss(); forget(); options.present?.(null, null);
        try { await copied.clear(); } catch { /* Presence must still leave if the clipboard is unavailable. */ }
        if (!connection) return;
        try {
          const service = await connection;
          if (options.connect) await service.close();
          else {
            const shared = connections.get(options.directory);
            if (shared && --shared.users === 0) { connections.delete(options.directory); await service.close(); }
          }
        } catch { /* No presence was acquired if connection failed. */ }
      })();
      return closeTask;
    },
  };
}
