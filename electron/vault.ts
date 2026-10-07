import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import type { BrowserWindow, WebContents } from 'electron';
import type { Client, EntryRow, ImportCount } from 'vault-client' with { 'resolution-mode': 'import' };
import type { ImportPasswordsResult, VaultCommand, VaultLogin, VaultState, VaultTimeout } from '../src/shared/api';
import { assertVaultPage, fillLogin, inspectLogin, vaultOrigin } from './vault-page';
import type { LoginFields } from './vault-page';
import { readVaultFile, vaultClipboard, vaultTokenStore, writeVaultFile } from './vault-storage';
import type { StoreCipher } from './store';
import { vaultAudit } from './vault-log';
import type { PasswordsFormat } from './import-passwords';

// pixels is the display scale: DOM snapshot bounds arrive in device pixels.
export interface VaultPage { contents: WebContents; generation: number; id: string; zoom: number; pixels?: number; bounds: { x: number; y: number; width: number; height: number } }
interface Options {
  window: BrowserWindow; directory: string; privateWindow: boolean; cipher: StoreCipher; clipboard: Parameters<typeof vaultClipboard>[0];
  page(): VaultPage | null; covered(): boolean; changed(): void; timeout(): VaultTimeout; saveTimeout(value: VaultTimeout): void;
  revealPage(): void;
  connect?: () => Promise<Client>;
}
const connections = new Map<string, { promise: Promise<Client>; users: number }>();
const auditEvents: Partial<Record<VaultCommand['type'], Parameters<typeof vaultAudit>[0]>> = { 'vault-unlock': 'unlock', 'vault-hello': 'hello', 'vault-lock': 'lock', 'vault-fill': 'fill', 'vault-copy': 'copy', 'vault-add': 'add', 'vault-import-permission': 'permission', 'vault-import-permission-hello': 'permission' };
// The one place where the import asks Vault whether Horizon may save passwords. The permission is given in the apps system of Vault.
const askImportPermission = async (service: Client): Promise<boolean> => (await service.apps.self()).permissions.includes('import');
// What the permission request answers, as codes the dialog has words for; anything else is an ordinary Vault failure.
function permissionCode(error: unknown, hello: boolean): string | null {
  const code = typeof error === 'object' && error !== null && 'code' in error ? error.code : '';
  if (code === 'locked') return hello ? 'VAULT_HELLO_FAILED' : 'VAULT_PERMISSION_PASSWORD';
  if (code === 'limited') return 'VAULT_PERMISSION_LIMITED';
  if (code === 'not_found') return 'VAULT_HELLO_NOT_SET_UP';
  if (code === 'forbidden') return 'VAULT_PERMISSION_FORBIDDEN';
  return code === 'unavailable' && hello ? 'VAULT_HELLO_UNAVAILABLE' : null;
}
const PERMISSION_CODES = ['VAULT_PERMISSION_PASSWORD', 'VAULT_PERMISSION_LIMITED', 'VAULT_HELLO_NOT_SET_UP', 'VAULT_PERMISSION_FORBIDDEN', 'VAULT_HELLO_UNAVAILABLE', 'VAULT_HELLO_FAILED'];
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
const isMetadata = (item: unknown): item is VaultLogin => {
  if (!item || typeof item !== 'object') return false;
  const fields = item as Record<string, unknown>;
  return Object.keys(fields).sort().join() === 'id,origin,title,username' && typeof fields.id === 'string' && fields.id.length <= 128
    && typeof fields.origin === 'string' && vaultOrigin(fields.origin) === fields.origin && typeof fields.title === 'string' && fields.title.length <= 500
    && typeof fields.username === 'string' && fields.username.length <= 512;
};
function errorCode(error: unknown): 'VAULT_UNAVAILABLE' | 'VAULT_STORAGE_UNAVAILABLE' {
  return error instanceof Error && error.message === 'VAULT_STORAGE_UNAVAILABLE' ? 'VAULT_STORAGE_UNAVAILABLE' : 'VAULT_UNAVAILABLE';
}
export function createVault(options: Options) {
  const state: VaultState = { available: false, created: false, unlocked: false, importAllowed: false, unlockMethod: null, timeout: options.timeout(), logins: [], suggestion: null, error: null, windows: process.platform === 'win32' };
  const metadataPath = resolve(options.directory, 'vault-sites.sealed');
  let metadata: VaultLogin[] = [], loaded = false, client: Client | undefined, connection: Promise<Client> | undefined;
  let closed = false, working = false, scanning = false, epoch = 0, unlockedAt = 0, suppressed = '';
  let closeTask: Promise<void> | undefined;
  let target: { page: VaultPage; fields: LoginFields; id: string } | null = null, lastLookup = '';
  const copied = vaultClipboard(options.clipboard);
  const publish = () => { if (!closed) { state.timeout = options.timeout(); options.changed(); } };
  const dismiss = () => { target = null; state.suggestion = null; };
  const loadMetadata = () => {
    if (loaded) return;
    const saved = readVaultFile(metadataPath, options.cipher);
    if (saved !== undefined && (!Array.isArray(saved) || saved.length > 4096 || !saved.every(isMetadata))) throw new Error('VAULT_STORAGE_UNAVAILABLE');
    metadata = saved as VaultLogin[] ?? []; loaded = true;
  };
  const keep = (items: VaultLogin[]) => {
    const next = items.slice(-4096);
    // Display indexes stay bounded even when a service entry contains a long field.
    while (next.length && Buffer.byteLength(JSON.stringify(next)) > 1024 * 1024) next.shift();
    writeVaultFile(metadataPath, next, options.cipher); metadata = next;
  };
  const remember = (rows: EntryRow[], origin: string) => keep([...metadata.filter(item => item.origin !== origin), ...loginMetadata(rows, origin)]);
  const getClient = async () => {
    if (closed || options.privateWindow) throw new Error('VAULT_UNAVAILABLE');
    if (client) return client;
    if (!connection) {
      connection = (async () => {
        loadMetadata();
        if (options.connect) return options.connect();
        let shared = connections.get(options.directory);
        if (!shared) {
          const promise = import('vault-client').then(({ connect }) => connect({ app: { id: 'horizon', name: 'Horizon', kind: 'cosmic' }, tokens: vaultTokenStore(resolve(options.directory, 'vault-token.sealed'), options.cipher) }));
          shared = { promise, users: 0 }; connections.set(options.directory, shared);
        }
        shared.users++;
        try { return await shared.promise; }
        catch { if (--shared.users === 0) connections.delete(options.directory); throw new Error('VAULT_UNAVAILABLE'); }
      })();
    }
    try { client = await connection; return client; }
    catch (error) { connection = undefined; throw error; }
  };
  const updateStatus = async (service: Client) => {
    const status = await service.status();
    if (closed) throw new Error('VAULT_UNAVAILABLE');
    state.available = true; state.created = status.created; state.error = null;
    if (state.unlocked !== status.unlocked) {
      epoch++;
      if (status.unlocked) unlockedAt = Date.now();
      else { unlockedAt = 0; state.unlockMethod = null; state.logins = []; }
    }
    state.unlocked = status.unlocked;
    const limit = options.timeout();
    if (state.unlocked && limit !== 'close' && Date.now() - unlockedAt >= Number(limit) * 60000) {
      await service.lock(); epoch++; state.unlocked = false; state.unlockMethod = null; state.logins = []; dismiss();
    }
  };
  const refresh = async () => {
    const service = await getClient(); await updateStatus(service);
    state.importAllowed = await askImportPermission(service);
    if (state.unlocked) {
      // Every saved sign-in comes as display metadata only; a value is asked for one exact origin when it is copied or filled.
      const ticket = epoch, summaries = loginSummaries(await service.listLogins());
      if (closed || ticket !== epoch) throw new Error('VAULT_PAGE_CHANGED');
      keep(summaries);
      state.logins = structuredClone(metadata);
    }
    publish();
  };
  const scan = async () => {
    if (closed || working || scanning || options.privateWindow) return;
    const page = options.page();
    if (!page || options.covered()) {
      // The suggestion itself covers a frozen page while chrome receives input.
      if (target && (!page || target.page.contents !== page.contents || target.page.generation !== page.generation || target.page.id !== page.id || vaultOrigin(page.contents.getURL()) !== target.fields.origin)) { epoch++; dismiss(); publish(); }
      return;
    }
    const origin = vaultOrigin(page.contents.getURL());
    if (!origin) return;
    scanning = true;
    try {
      loadMetadata();
      const fields = await inspectLogin(page.contents, origin, false);
      const now = options.page();
      if (!now || page.contents !== now.contents || page.generation !== now.generation || page.id !== now.id || options.covered()) return;
      const signature = fields ? `${page.id}:${page.generation}:${fields.username}` : '';
      if (!fields || signature === suppressed) { if (target) { dismiss(); publish(); } return; }
      if (suppressed && signature !== suppressed) suppressed = '';
      if (client && signature !== lastLookup) {
        lastLookup = signature;
        await updateStatus(client);
        if (state.unlocked) {
          const ticket = epoch, rows = await client.logins(origin);
          const current = options.page();
          if (closed || ticket !== epoch || !current || current.id !== page.id || current.generation !== page.generation || current.contents !== page.contents || options.covered()) return;
          remember(rows, origin); state.logins = structuredClone(metadata);
        }
      }
      const logins = metadata.filter(item => item.origin === origin);
      if (!logins.length) return;
      // DOM snapshot bounds are device pixels; the view's bounds and the chrome's layout are not.
      const pixels = page.pixels ?? 1, chromeZoom = options.window.webContents.getZoomFactor();
      const left = fields.x / pixels, bottom = (fields.y + fields.height) / pixels;
      const x = (page.bounds.x + left) / chromeZoom, y = (page.bounds.y + bottom) / chromeZoom;
      if (left < 0 || fields.y < 0 || left >= page.bounds.width || bottom >= page.bounds.height) return;
      const id = randomUUID(); target = { page, fields, id };
      state.suggestion = { id, origin, x, y, width: fields.width / pixels / chromeZoom, logins: structuredClone(logins) };
      publish();
    } catch { if (target) { dismiss(); publish(); } } // Unreadable pages never get a suggestion.
    finally { scanning = false; }
  };
  const run = async (command: VaultCommand): Promise<void> => {
    if (closed || options.privateWindow) throw new Error('VAULT_UNAVAILABLE');
    if (command.type === 'vault-dismiss') {
      suppressed = target ? `${target.page.id}:${target.page.generation}:${target.fields.username}` : '';
      epoch++; dismiss(); publish(); return;
    }
    if (command.type === 'vault-lock') {
      // Lock can interrupt a value request. It must not queue behind a pending fill.
      epoch++; dismiss(); state.logins = []; state.unlocked = false; state.unlockMethod = null; publish();
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
        if (command.type === 'vault-unlock') await service.unlock(command.password);
        else if (command.type === 'vault-hello') await service.hello.unlock(windowHandle());
        else {
          // The onboarding step of Vault: it is checked like an unlock, which also unlocks Vault, and then Horizon holds the import permission.
          try { await (command.type === 'vault-import-permission' ? service.permissions.importWithPassword(command.password) : service.permissions.importWithHello(windowHandle())); }
          catch (error) { const mapped = permissionCode(error, hello); throw mapped ? new Error(mapped) : error; }
        }
        if (closed || ticket !== epoch) throw new Error('VAULT_PAGE_CHANGED');
        epoch++; state.unlocked = true; unlockedAt = Date.now(); state.unlockMethod = hello ? 'hello' : 'master';
        await refresh();
      } else if (command.type === 'vault-refresh') await refresh();
      else {
        await updateStatus(service);
        if (!state.unlocked) throw new Error('VAULT_LOCKED');
        const ticket = epoch;
        const check = () => { if (closed || ticket !== epoch || !state.unlocked) throw new Error('VAULT_PAGE_CHANGED'); };
        if (command.type === 'vault-fill') {
          const selected = target;
          if (!selected || selected.id !== command.suggestion || !state.suggestion?.logins.some(item => item.id === command.id)) throw new Error('VAULT_PAGE_CHANGED');
          const checkPage = () => {
            check(); const page = options.page();
            if (!page || page.contents !== selected.page.contents || page.id !== selected.page.id || page.generation !== selected.page.generation) throw new Error('VAULT_PAGE_CHANGED');
            assertVaultPage(page.contents, selected.fields.origin, options.privateWindow);
          };
          checkPage();
          const rows = await service.logins(selected.fields.origin); checkPage();
          const row = rows.find(row => row.entry.id === command.id && row.entry.kind === 'login' && vaultOrigin(value(row, 'website')) === selected.fields.origin);
          if (!row) throw new Error('VAULT_PAGE_CHANGED');
          options.revealPage(); selected.page.contents.focus();
          await fillLogin(selected.page.contents, selected.fields, { username: value(row, 'username'), password: value(row, 'password') }, options.privateWindow, checkPage);
          suppressed = `${selected.page.id}:${selected.page.generation}:${selected.fields.username}`; dismiss(); publish();
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
          check(); remember(await service.logins(origin), origin); await refresh();
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
      epoch++; state.unlocked = false; state.unlockMethod = null; state.logins = [];
      if (event) vaultAudit(event, 'denied');
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
      catch (error) { state.error = errorCode(error); epoch++; state.unlocked = false; state.unlockMethod = null; state.logins = []; publish(); throw new Error(state.error); }
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
  const scanner = options.privateWindow ? undefined : setInterval(() => { void scan(); }, 750);
  scanner?.unref();
  const statusTimer = options.privateWindow ? undefined : setInterval(() => {
    if (client && !working && !closed) void updateStatus(client).then(publish).catch(() => { state.unlocked = false; state.logins = []; state.error = 'VAULT_UNAVAILABLE'; epoch++; publish(); });
  }, 20000);
  statusTimer?.unref();
  return {
    state: () => structuredClone(state), run, scan, importPasswords, hasSession: () => Boolean(connection),
    invalidate() { epoch++; dismiss(); publish(); },
    close(): Promise<void> {
      if (closeTask) return closeTask;
      closeTask = (async () => {
        closed = true; epoch++; clearInterval(scanner); clearInterval(statusTimer); dismiss(); state.logins = []; metadata = [];
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
