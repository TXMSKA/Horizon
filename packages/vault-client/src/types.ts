export type Kind = "login" | "card" | "doc" | "note" | "key" | "custom" | "env";
export type Field = { id: string; name: string; value: string; secret: boolean };
export type Attachment = { id: string; name: string; type: string; size: number; chunks: string[] };
export type Entry = {
  id: string; kind: Kind; title: string; favorite: boolean; fields: Field[]; note: string;
  totp: string; recovery: { value: string; used: boolean }[]; files: Attachment[]; updatedAt: string;
};
export type EntryRow = { entry: Entry; version: number };
export type LoginSummary = { id: string; version: number; title: string; username: string; website: string };
export type AppIdentity = { id: string; name: string; kind: "cosmic" | "app" | "agent" };
export type AppView = AppIdentity & { status: "granted" | "pending" | "revoked"; kinds: Kind[]; permissions: "import"[] };
export type Status = { created: boolean; unlocked: boolean; present: number; idleMs: number };
export type ServiceRecord = { version: 1; pid: number; port: number; serviceVersion: string; startedAt: string };
export type InstallRecord = { version: 1; command: string; args: string[]; helper?: string };
export interface TokenStore { get(): Promise<string | undefined>; set(token: string): Promise<void> }
export type ConnectOptions = { app: AppIdentity; tokens?: TokenStore; home?: string; startTimeoutMs?: number; heartbeatMs?: number };
export type ImportFormat = "chrome" | "edge" | "firefox" | "bitwarden" | "1password" | "keepass";
export type ImportCount = { imported: number; duplicates: number; skipped: number };
export type Backup = { format: "vault-backup"; version: 1; envelope: unknown; sealed: { iv: string; data: string } };
export type EnvImportCount = { added: number; replaced: number; unchanged: number; kept: number; skipped: number };
export type SyncStatus = { configured: boolean; folder: string | null; lastSynced: string | null; computers: string[]; pending: number; conflicts: number; failure: { writer: string | null; cause: string } | null };
export type SyncConflict = { id: string; kind: Kind | null; title: string; deviceId: string; time: string; deleted: boolean };
export type RunStatus = "pending" | "running" | "done" | "failed" | "stopped" | "rejected" | "expired";
export type RunRequest = { project: string; commands: string[][]; cwd: string; env: Record<string, string> };
export type RunSummary = {
  id: string; project: string; app: { id: string; name: string }; cwd: string; commands: string[][]; status: RunStatus; createdAt: string; expiresAt: string;
  /** Names of the project's values too short to hide in the output; null while Vault is locked. */
  short: string[] | null; problem?: "missing" | "ambiguous";
};
export type RunChunk = { seq: number; command: number; stream: "stdout" | "stderr"; text: string };
export type RunCommandState = { status: "waiting" | "running" | "done" | "failed" | "skipped" | "stopped"; exit: number | null; reason?: string; truncated: boolean };
export type RunProgress = { id: string; project: string; status: RunStatus; reason?: string; expiresAt: string; commands: RunCommandState[]; chunks: RunChunk[]; next: number; more: boolean };
export interface Client {
  sync: { status(): Promise<SyncStatus>; setup(folder: string): Promise<SyncStatus>; join(folder: string, credentials: { password: string } | { recovery: string }): Promise<SyncStatus>; now(): Promise<SyncStatus>; conflicts(): Promise<SyncConflict[]>; restore(id: string): Promise<{ ok: true }>; dismiss(id: string): Promise<{ ok: true }>; leave(remove: boolean): Promise<{ ok: true }> };
  status(): Promise<Status>;
  create(password: string): Promise<{ recovery: string }>;
  unlock(password: string): Promise<{ ok: true }>;
  recover(recovery: string, password: string): Promise<{ recovery: string }>;
  hello: { enable(password: string): Promise<{ ok: true }>; unlock(hwnd: string): Promise<{ ok: true }>; disable(): Promise<{ ok: true }> };
  lock(): Promise<{ ok: true }>;
  present(): Promise<{ ok: true }>;
  close(): Promise<void>;
  logins(origin: string): Promise<EntryRow[]>;
  listLogins(): Promise<LoginSummary[]>;
  getLogin(id: string): Promise<EntryRow>;
  entries: { list(): Promise<EntryRow[]>; get(id: string): Promise<EntryRow>; save(entry: Entry, expected: number): Promise<{ version: number }>; remove(id: string, expected: number): Promise<{ ok: true }> };
  environment(project: string): Promise<Record<string, string>>;
  import(format: ImportFormat, text: string): Promise<ImportCount>;
  importEnv(project: string, text: string): Promise<EnvImportCount>;
  runs: {
    submit(request: RunRequest): Promise<{ id: string; expiresAt: string }>; get(id: string, after?: number): Promise<RunProgress>; list(): Promise<RunSummary[]>;
    approve(id: string, password: string): Promise<{ ok: true }>; approveWithHello(id: string, hwnd: string): Promise<{ ok: true }>; reject(id: string): Promise<{ ok: true }>;
  };
  export(password: string): Promise<Backup>;
  restore(backup: Backup, password: string): Promise<ImportCount>;
  apps: { list(): Promise<AppView[]>; self(): Promise<AppView>; allow(id: string): Promise<AppView>; revoke(id: string): Promise<AppView> };
  permissions: { importWithPassword(password: string): Promise<AppView>; importWithHello(hwnd: string): Promise<AppView> };
}
