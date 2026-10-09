import { writeFile, rename, rm, lstat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { randomUUID } from "node:crypto";
import { spawn } from "node:child_process";
import { resolveHome, appIdPattern, serviceEnv } from "./paths.ts";
import { privateDirectoryAsync, privateFileAsync } from "./private.ts";
import { readCapped, FILE_CAP } from "./files.ts";
import { VaultClientError } from "./errors.ts";
import type { AppView, Backup, Client, ConnectOptions, EntryRow, EnvImportCount, ImportCount, InstallRecord, LoginSummary, RunProgress, RunSummary, ServiceRecord, Status, SyncStatus, SyncConflict, TokenStore } from "./types.ts";
export type * from "./types.ts";
export { VaultClientError, resolveHome, readCapped, FILE_CAP };
const pause = (ms: number) => new Promise<void>(done => setTimeout(done, ms));
async function request<T>(record: ServiceRecord, method: string, route: string, auth?: string, body?: unknown, timeout = 15000): Promise<T> {
  try {
    const response = await fetch(`http://127.0.0.1:${record.port}${route}`, { method, redirect: "error", signal: AbortSignal.timeout(timeout), headers: { ...(auth ? { Authorization: auth } : {}), ...(body === undefined ? {} : { "Content-Type": "application/json" }) }, ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    const reader = response.body?.getReader(); if (!reader) throw new VaultClientError("unavailable");
    const parts: Uint8Array[] = []; let size = 0;
    try {
      for (;;) { const next = await reader.read(); if (next.done) break; size += next.value.length; if (size > 16 * 1024 * 1024) { await reader.cancel(); throw new VaultClientError("too_large"); } parts.push(next.value); }
      const value = JSON.parse(Buffer.concat(parts).toString("utf8"));
      if (!response.ok) throw new VaultClientError(typeof value?.error?.code === "string" ? value.error.code : "unavailable");
      return value as T;
    } finally { reader.releaseLock(); }
  } catch (error) { throw error instanceof VaultClientError ? error : new VaultClientError("unavailable"); }
}
export async function findService(home = resolveHome(), timeout = 1000): Promise<ServiceRecord | undefined> {
  try {
    const record = JSON.parse(await readCapped(join(home, "run", "service.json"), 4096)) as ServiceRecord;
    if (record.version !== 1 || !Number.isSafeInteger(record.pid) || record.pid < 1 || !Number.isSafeInteger(record.port) || record.port < 1 || record.port > 65535 || record.serviceVersion !== "0.1.0" || typeof record.startedAt !== "string") return undefined;
    const health = await request<{ ok: boolean; pid: number }>(record, "GET", "/v1/health", undefined, undefined, timeout);
    return health.ok && health.pid === record.pid ? record : undefined;
  } catch { return undefined; }
}
const starting = new Map<string, Promise<ServiceRecord>>();
export async function ensureRunning(home = resolveHome(), timeout = 15000): Promise<ServiceRecord> {
  home = resolve(home);
  const found = await findService(home); if (found) return found;
  const pending = starting.get(home); if (pending) return pending;
  const operation = (async () => {
    let install: InstallRecord;
    try { install = JSON.parse(await readCapped(join(home, "install.json"), 16384)); }
    catch { throw new VaultClientError("not_installed"); }
    if (install.version !== 1 || typeof install.command !== "string" || !/^(?:[A-Za-z]:[\\/]|\/)/.test(install.command) || !Array.isArray(install.args) || install.args.length > 32 || !install.args.every(arg => typeof arg === "string" && arg.length < 4096) || install.helper !== undefined && (typeof install.helper !== "string" || !/^(?:[A-Za-z]:[\\/]|\/)/.test(install.helper))) throw new VaultClientError("invalid_install");
    const child = spawn(install.command, install.args, { shell: false, detached: true, windowsHide: true, stdio: "ignore", env: serviceEnv(home) });
    let failed = false; child.once("error", () => { failed = true; }); child.unref();
    const deadline = Date.now() + timeout;
    while (Date.now() < deadline) { if (failed) break; const record = await findService(home); if (record) return record; await pause(100); }
    throw new VaultClientError("unavailable");
  })();
  starting.set(home, operation);
  try { return await operation; } finally { starting.delete(home); }
}
export function fileTokenStore(home: string, appId: string): TokenStore {
  if (!appIdPattern.test(appId)) throw new VaultClientError("invalid");
  const directory = join(resolve(home), "secrets", "clients"), filename = join(directory, `${appId}.token`);
  let prepared = false;
  const prepare = async () => { if (!prepared) { await privateDirectoryAsync(directory, home); prepared = true; } };
  return {
    async get() {
      await prepare();
      try { await lstat(filename); } catch (error) { if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined; throw new VaultClientError("unavailable"); }
      await privateFileAsync(filename, home); const token = await readCapped(filename, 43); if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new VaultClientError("invalid"); return token;
    },
    async set(token) {
      if (!/^[A-Za-z0-9_-]{43}$/.test(token)) throw new VaultClientError("invalid"); await prepare();
      const temporary = `${filename}.${randomUUID()}.tmp`;
      try { await writeFile(temporary, token, { flag: "wx", mode: 0o600 }); await privateFileAsync(temporary, home); await rename(temporary, filename); } finally { await rm(temporary, { force: true }); }
    },
  };
}
export async function connect(options: ConnectOptions): Promise<Client> {
  if (!appIdPattern.test(options.app.id) || options.startTimeoutMs !== undefined && (!Number.isSafeInteger(options.startTimeoutMs) || options.startTimeoutMs < 1)) throw new VaultClientError("invalid");
  const home = resolve(options.home ?? resolveHome()), tokens = options.tokens ?? fileTokenStore(home, options.app.id);
  let record: ServiceRecord | undefined = await ensureRunning(home, options.startTimeoutMs);
  let token = await tokens.get(), granted = true, closed = false;
  if (!token) {
    const keyFile = join(home, "secrets", "bootstrap.key"); await privateFileAsync(keyFile, home);
    const key = await readCapped(keyFile, 43);
    if (!/^[A-Za-z0-9_-]{43}$/.test(key)) throw new VaultClientError("unavailable");
    const result = await request<{ token: string; app: AppView }>(record, "POST", "/v1/apps/register", `Bootstrap ${key}`, options.app);
    token = result.token; await tokens.set(token); granted = result.app.status === "granted";
  }
  async function call<T>(method: string, route: string, body?: unknown, timeout?: number): Promise<T> {
    if (closed) throw new VaultClientError("closed");
    record ??= await ensureRunning(home, options.startTimeoutMs);
    try { return await request<T>(record, method, route, `Bearer ${token}`, body, timeout); }
    catch (error) { if (error instanceof VaultClientError && error.code === "unavailable") record = undefined; throw error; }
  }
  const session = randomUUID();
  const present = () => call<{ ok: true }>("POST", "/v1/apps/present", { session });
  // An agent never keeps Vault open; it only proposes runs and reads their masked output.
  const holds = options.app.kind !== "agent";
  if (granted && holds) await present();
  const heartbeatMs = options.heartbeatMs ?? 20000;
  if (!Number.isSafeInteger(heartbeatMs) || heartbeatMs < 1 || heartbeatMs > 20000) throw new VaultClientError("invalid");
  const timer = holds ? setInterval(() => { if (!closed) void present().catch(() => undefined); }, heartbeatMs) : undefined; timer?.unref();
  const appPath = (id: string) => { if (!appIdPattern.test(id)) throw new VaultClientError("invalid"); return `/v1/apps/${id}`; };
  return {
    status: () => call<Status>("GET", "/v1/status"), create: password => call("POST", "/v1/create", { password }),
    sync: { status: () => call<SyncStatus>("GET", "/v1/sync"), setup: folder => call<SyncStatus>("POST", "/v1/sync/setup", { folder }, 130000), join: (folder, credentials) => call<SyncStatus>("POST", "/v1/sync/join", { folder, ...credentials }, 130000), now: () => call<SyncStatus>("POST", "/v1/sync/now", {}, 130000), conflicts: () => call<SyncConflict[]>("GET", "/v1/sync/conflicts"), restore: id => call("POST", "/v1/sync/conflicts/restore", { id }), dismiss: id => call("POST", "/v1/sync/conflicts/dismiss", { id }), leave: remove => call("POST", "/v1/sync/leave", { remove }) },
    unlock: password => call("POST", "/v1/unlock", { password }), recover: (recovery, password) => call("POST", "/v1/recover", { recovery, password }),
    hello: { enable: password => call("POST", "/v1/unlock/hello/enable", { password }), unlock: hwnd => call("POST", "/v1/unlock/hello", { hwnd }), disable: () => call("POST", "/v1/unlock/hello/disable", {}) },
    lock: () => call("POST", "/v1/lock", {}), present,
    async close() { if (closed) return; clearInterval(timer); try { if (holds) await call("POST", "/v1/apps/leave", { session }); } finally { closed = true; } },
    logins: origin => call<EntryRow[]>("GET", `/v1/logins?origin=${encodeURIComponent(origin)}`),
    listLogins: () => call<LoginSummary[]>("GET", "/v1/logins/all"), getLogin: id => call<EntryRow>("GET", `/v1/logins/get?id=${encodeURIComponent(id)}`),
    entries: { list: () => call<EntryRow[]>("GET", "/v1/entries"), get: id => call<EntryRow>("GET", `/v1/entries/get?id=${encodeURIComponent(id)}`), save: (entry, expected) => call("POST", "/v1/entries", { entry, expected }), remove: (id, expected) => call("POST", "/v1/entries/remove", { id, expected }) },
    environment: project => call("GET", `/v1/env?project=${encodeURIComponent(project)}`),
    import: (format, text) => call<ImportCount>("POST", "/v1/import", { format, text }), importEnv: (project, text) => call<EnvImportCount>("POST", "/v1/import/env", { project, text }), export: password => call<Backup>("POST", "/v1/export", { password }), restore: (backup, password) => call<ImportCount>("POST", "/v1/restore", { backup, password }),
    runs: {
      submit: value => call("POST", "/v1/runs", value), list: () => call<RunSummary[]>("GET", "/v1/runs"),
      get(id, after = 0) { if (!Number.isSafeInteger(after) || after < 0) throw new VaultClientError("invalid"); return call<RunProgress>("GET", `/v1/runs/get?after=${after}&id=${encodeURIComponent(id)}`); },
      approve: (id, password) => call("POST", "/v1/runs/approve", { id, password }),
      // Windows Hello waits for the person, up to two minutes.
      approveWithHello: (id, hwnd) => call("POST", "/v1/runs/approve/hello", { hwnd, id }, 130000), reject: id => call("POST", "/v1/runs/reject", { id }),
    },
    apps: { list: () => call<AppView[]>("GET", "/v1/apps"), self: () => call<AppView>("GET", "/v1/apps/self"), allow: id => call("POST", `${appPath(id)}/allow`, {}), revoke: id => call("POST", `${appPath(id)}/revoke`, {}) },
    // Windows Hello waits for the person, up to two minutes.
    permissions: { importWithPassword: password => call<AppView>("POST", "/v1/apps/permissions/import", { password }), importWithHello: hwnd => call<AppView>("POST", "/v1/apps/permissions/import/hello", { hwnd }, 130000) },
  };
}
