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
export type AppView = AppIdentity & { status: "granted" | "pending" | "revoked"; kinds: Kind[] };
export type Status = { created: boolean; unlocked: boolean; present: number; idleMs: number };
export type ServiceRecord = { version: 1; pid: number; port: number; serviceVersion: string; startedAt: string };
export type InstallRecord = { version: 1; command: string; args: string[] };
export interface TokenStore { get(): Promise<string | undefined>; set(token: string): Promise<void> }
export type ConnectOptions = { app: AppIdentity; tokens?: TokenStore; home?: string; startTimeoutMs?: number; heartbeatMs?: number };
export type ImportFormat = "chrome" | "edge" | "firefox" | "bitwarden" | "1password" | "keepass";
export type ImportCount = { imported: number; duplicates: number; skipped: number };
export type Backup = { format: "vault-backup"; version: 1; envelope: unknown; sealed: { iv: string; data: string } };
export interface Client {
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
  export(password: string): Promise<Backup>;
  restore(backup: Backup, password: string): Promise<ImportCount>;
  apps: { list(): Promise<AppView[]>; allow(id: string): Promise<AppView>; revoke(id: string): Promise<AppView> };
}
