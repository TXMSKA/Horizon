/**
 * horizon-lyra: Horizon's own integration with the local Lyra service.
 * Written for Horizon under GPL-3.0-or-later. It talks to the service only through its
 * HTTP routes on 127.0.0.1 and contains no code from Lyra.
 */
import { spawn } from 'node:child_process';
import { open } from 'node:fs/promises';
import type { FileHandle } from 'node:fs/promises';
import { homedir } from 'node:os';
import { isAbsolute, join, resolve } from 'node:path';

export interface AppIdentity { id: string; name: string; kind: string }
export interface TokenStore { get(): Promise<string | undefined>; set(token: string): Promise<void> }
export interface ConnectOptions {
  app: AppIdentity;
  tokens: TokenStore;
  /** Overrides the service folder. Otherwise LYRA_HOME, then the platform default. */
  home?: string;
  /** Default answer language for the Accept-Language header. */
  language?: 'en' | 'es';
  /** How long to wait for a freshly started service. Default 15000. */
  startTimeoutMs?: number;
}

export interface ChatMessage { role: 'user' | 'assistant'; content: string }
export interface ChatRequest {
  messages: ChatMessage[];
  mode: string;
  priority?: string;
  context?: string;
  language?: 'en' | 'es';
}
export type ChatEvent =
  | { type: 'start'; mode: string; model: string; fellBack: boolean }
  | { type: 'thinking' }
  | { type: 'text'; text: string }
  | { type: 'done' }
  | { type: 'error'; code: string };
export type InstallEvent =
  | { type: 'step'; name: string; status: string; completed: number; total: number }
  | { type: 'done' }
  | { type: 'error'; code: string };
export interface ModeStatus { ready: boolean }
export interface ModelsStatus {
  ready: boolean;
  ollama: { installed: boolean; running: boolean };
  modes: { fast: ModeStatus } & Record<string, ModeStatus>;
}
export interface Client {
  chat(request: ChatRequest, options?: { signal?: AbortSignal }): AsyncIterable<ChatEvent>;
  models: {
    status(): Promise<ModelsStatus>;
    install(plan: string): AsyncIterable<InstallEvent>;
  };
  ollama: { start(): Promise<{ running: true; version: string }> };
}

export class LyraError extends Error {
  readonly code: string;
  readonly status: number | undefined;
  constructor(code: string, message = code, status?: number) {
    super(message);
    this.name = 'LyraError';
    this.code = code;
    this.status = status;
  }
}

const JSON_LIMIT = 1024 * 1024;
const LINE_LIMIT = 64 * 1024;
const STREAM_LIMIT = 16 * 1024 * 1024;
const FILE_LIMIT = 64 * 1024;
const codeShape = /^[A-Za-z0-9_.-]{1,64}$/;
const tokenShape = /^[A-Za-z0-9_-]{43}$/;
const inheritedVariables = ['PATH', 'PATHEXT', 'SYSTEMROOT', 'WINDIR', 'COMSPEC', 'TEMP', 'TMP', 'TMPDIR', 'LOCALAPPDATA', 'APPDATA', 'USERPROFILE', 'HOME', 'XDG_DATA_HOME'];

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const isCount = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const invalid = (what: string) => new LyraError('invalid_response', `Unexpected ${what} from the Lyra service`);

function transport(error: unknown, signal?: AbortSignal): LyraError {
  if (error instanceof LyraError) return error;
  return signal?.aborted ? new LyraError('cancelled') : new LyraError('unavailable');
}

// ---------------------------------------------------------------- service folder

function resolveHome(explicit: string | undefined): { home: string; overridden: boolean } {
  const chosen = explicit || process.env.LYRA_HOME;
  if (chosen) return { home: resolve(chosen), overridden: true };
  const data = process.platform === 'win32'
    ? process.env.LOCALAPPDATA || join(homedir(), 'AppData', 'Local')
    : process.env.XDG_DATA_HOME && isAbsolute(process.env.XDG_DATA_HOME) ? process.env.XDG_DATA_HOME : join(homedir(), '.local', 'share');
  return { home: join(data, 'Cosmic', 'apps', 'Lyra'), overridden: false };
}

async function readSmallFile(path: string, limit: number): Promise<Buffer | undefined> {
  let handle: FileHandle;
  try { handle = await open(path, 'r'); } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT' || code === 'ENOTDIR') return undefined;
    throw new LyraError('unavailable');
  }
  try {
    const stat = await handle.stat();
    if (!stat.isFile() || stat.size > limit) throw new LyraError('unavailable');
    return await handle.readFile();
  } finally { await handle.close(); }
}

async function readJsonFile(path: string): Promise<unknown> {
  const bytes = await readSmallFile(path, FILE_LIMIT);
  if (!bytes) return undefined;
  try { return JSON.parse(bytes.toString('utf8')); } catch { return undefined; }
}

// ---------------------------------------------------------------- bounded HTTP reads

async function readBounded(response: Response, limit: number): Promise<Buffer> {
  const declared = Number(response.headers.get('content-length'));
  if (declared > limit) { await response.body?.cancel().catch(() => {}); throw new LyraError('response_too_large'); }
  if (!response.body) return Buffer.alloc(0);
  const reader = response.body.getReader(), chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.length;
    if (total > limit) { await reader.cancel().catch(() => {}); throw new LyraError('response_too_large'); }
    chunks.push(value);
  }
  return Buffer.concat(chunks);
}

async function readJson(response: Response): Promise<unknown> {
  const bytes = await readBounded(response, JSON_LIMIT);
  try { return JSON.parse(bytes.toString('utf8')); } catch { throw invalid('body'); }
}

async function failure(response: Response): Promise<LyraError> {
  try {
    const body = await readJson(response);
    if (isRecord(body) && isRecord(body.error) && typeof body.error.code === 'string' && codeShape.test(body.error.code)) {
      return new LyraError(body.error.code, typeof body.error.message === 'string' ? body.error.message.slice(0, 500) : body.error.code, response.status);
    }
  } catch { /* fall through to the generic failure */ }
  return new LyraError('unavailable', `The Lyra service answered ${response.status}`, response.status);
}

/** Yields one parsed value per NDJSON line, enforcing the per-line and per-stream caps. */
async function* ndjson(response: Response, signal?: AbortSignal): AsyncGenerator<unknown> {
  if (!response.body) return;
  const reader = response.body.getReader();
  let pending: Buffer[] = [], pendingBytes = 0, total = 0;
  const parse = (): unknown | undefined => {
    const line = Buffer.concat(pending).toString('utf8').trim();
    pending = []; pendingBytes = 0;
    if (!line) return undefined;
    try { return JSON.parse(line); } catch { throw invalid('event line'); }
  };
  try {
    for (;;) {
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try { chunk = await reader.read(); } catch (error) { throw transport(error, signal); }
      if (chunk.done) break;
      total += chunk.value.length;
      if (total > STREAM_LIMIT) throw new LyraError('stream_too_large');
      let start = 0;
      while (start < chunk.value.length) {
        const newline = chunk.value.indexOf(0x0a, start), end = newline === -1 ? chunk.value.length : newline;
        pendingBytes += end - start;
        if (pendingBytes > LINE_LIMIT) throw new LyraError('line_too_large');
        pending.push(Buffer.from(chunk.value.subarray(start, end)));
        if (newline === -1) break;
        const value = parse();
        if (value !== undefined) yield value;
        start = newline + 1;
      }
    }
    const last = parse();
    if (last !== undefined) yield last;
  } finally { await reader.cancel().catch(() => {}); }
}

async function* events<T extends { type: string }>(response: Response, parse: (value: unknown) => T | undefined, signal?: AbortSignal): AsyncGenerator<T> {
  for await (const raw of ndjson(response, signal)) {
    const event = parse(raw);
    if (!event) throw invalid('event');
    yield event;
    if (event.type === 'done' || event.type === 'error') return;
  }
}

function chatEvent(value: unknown): ChatEvent | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.type) {
    case 'start': return typeof value.mode === 'string' && typeof value.model === 'string' && typeof value.fellBack === 'boolean'
      ? { type: 'start', mode: value.mode, model: value.model, fellBack: value.fellBack } : undefined;
    case 'thinking': return { type: 'thinking' };
    case 'text': return typeof value.text === 'string' ? { type: 'text', text: value.text } : undefined;
    case 'done': return { type: 'done' };
    case 'error': return typeof value.code === 'string' && codeShape.test(value.code) ? { type: 'error', code: value.code } : undefined;
    default: return undefined;
  }
}

function installEvent(value: unknown): InstallEvent | undefined {
  if (!isRecord(value)) return undefined;
  switch (value.type) {
    case 'step': return typeof value.name === 'string' && typeof value.status === 'string' && isCount(value.completed) && isCount(value.total)
      ? { type: 'step', name: value.name, status: value.status, completed: value.completed, total: value.total } : undefined;
    case 'done': return { type: 'done' };
    case 'error': return typeof value.code === 'string' && codeShape.test(value.code) ? { type: 'error', code: value.code } : undefined;
    default: return undefined;
  }
}

function modelsStatus(value: unknown): ModelsStatus {
  if (!isRecord(value) || typeof value.ready !== 'boolean' || !isRecord(value.ollama) || !isRecord(value.modes)) throw invalid('models status');
  const { installed, running } = value.ollama;
  if (typeof installed !== 'boolean' || typeof running !== 'boolean') throw invalid('models status');
  const entries = Object.entries(value.modes);
  if (entries.length > 16) throw invalid('models status');
  const modes: Record<string, ModeStatus> = {};
  for (const [name, mode] of entries) {
    if (!isRecord(mode) || typeof mode.ready !== 'boolean') throw invalid('models status');
    modes[name] = { ready: mode.ready };
  }
  if (!modes.fast) throw invalid('models status');
  return { ready: value.ready, ollama: { installed, running }, modes: modes as ModelsStatus['modes'] };
}

// ---------------------------------------------------------------- finding and starting the service

interface Service { port: number; serviceVersion: string }

async function readService(home: string): Promise<Service | undefined> {
  let file: unknown;
  try { file = await readJsonFile(join(home, 'run', 'service.json')); } catch { return undefined; }
  if (!isRecord(file) || file.version !== 1) return undefined;
  const { pid, port, serviceVersion, startedAt } = file;
  if (!Number.isInteger(pid) || (pid as number) < 1) return undefined;
  if (!Number.isInteger(port) || (port as number) < 1024 || (port as number) > 65535) return undefined;
  if (typeof serviceVersion !== 'string' || !serviceVersion || serviceVersion.length > 64) return undefined;
  if (typeof startedAt !== 'string' && typeof startedAt !== 'number') return undefined;
  return { port: port as number, serviceVersion };
}

async function healthy(service: Service): Promise<boolean> {
  try {
    const response = await fetch(`http://127.0.0.1:${service.port}/v1/health`, { redirect: 'error', headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(2000) });
    if (!response.ok) { await response.body?.cancel().catch(() => {}); return false; }
    const body = await readJson(response);
    return isRecord(body) && body.ok === true && body.serviceVersion === service.serviceVersion;
  } catch { return false; }
}

async function running(home: string): Promise<Service | undefined> {
  const service = await readService(home);
  return service && await healthy(service) ? service : undefined;
}

async function readInstall(home: string): Promise<{ command: string; args: string[] }> {
  const bytes = await readSmallFile(join(home, 'install.json'), FILE_LIMIT).catch(() => { throw new LyraError('invalid_install'); });
  if (!bytes) throw new LyraError('not_installed');
  let file: unknown;
  try { file = JSON.parse(bytes.toString('utf8')); } catch { throw new LyraError('invalid_install'); }
  if (!isRecord(file) || file.version !== 1 || typeof file.command !== 'string' || !isAbsolute(file.command) || file.command.length > 4096 || file.command.includes('\0')
    || !Array.isArray(file.args) || file.args.length > 64 || file.args.some(arg => typeof arg !== 'string' || arg.length > 4096 || arg.includes('\0'))) throw new LyraError('invalid_install');
  return { command: file.command, args: file.args as string[] };
}

const starting = new Map<string, Promise<Service>>();

async function launch(home: string, overridden: boolean, timeout: number): Promise<Service> {
  const { command, args } = await readInstall(home);
  const env: Record<string, string> = {};
  for (const name of inheritedVariables) { const value = process.env[name]; if (value !== undefined) env[name] = value; }
  if (overridden) env.LYRA_HOME = home;
  const child = spawn(command, args, { detached: true, stdio: 'ignore', windowsHide: true, env });
  await new Promise<void>((started, failed) => {
    child.once('error', () => failed(new LyraError('invalid_install')));
    child.once('spawn', () => started());
  });
  child.on('error', () => {});
  child.unref();
  const deadline = Date.now() + timeout;
  for (;;) {
    const service = await running(home);
    if (service) return service;
    if (Date.now() >= deadline) throw new LyraError('unavailable', 'The Lyra service did not start in time');
    await new Promise(done => setTimeout(done, 200));
  }
}

async function ensureService(home: string, overridden: boolean, timeout: number): Promise<Service> {
  const service = await running(home);
  if (service) return service;
  let pending = starting.get(home);
  if (!pending) {
    pending = launch(home, overridden, timeout).finally(() => starting.delete(home));
    starting.set(home, pending);
  }
  return pending;
}

// ---------------------------------------------------------------- the client

interface Call {
  method?: 'GET' | 'POST';
  headers?: Record<string, string>;
  body?: unknown;
  signal?: AbortSignal;
  timeout?: number;
  language?: string;
  stream?: boolean;
}

export async function connect(options: ConnectOptions): Promise<Client> {
  const { home, overridden } = resolveHome(options.home);
  const service = await ensureService(home, overridden, options.startTimeoutMs ?? 15000);
  const base = `http://127.0.0.1:${service.port}`, { app, tokens } = options;

  const send = async (path: string, call: Call): Promise<Response> => {
    const signals = [call.signal, call.timeout ? AbortSignal.timeout(call.timeout) : undefined].filter(signal => signal !== undefined);
    try {
      return await fetch(base + path, {
        method: call.method ?? 'GET', redirect: 'error', signal: signals.length ? AbortSignal.any(signals) : null,
        headers: { Accept: call.stream ? 'application/x-ndjson' : 'application/json', 'Accept-Language': call.language ?? options.language ?? 'en', ...(call.body === undefined ? {} : { 'Content-Type': 'application/json' }), ...call.headers },
        body: call.body === undefined ? null : JSON.stringify(call.body),
      });
    } catch (error) { throw transport(error, call.signal); }
  };

  const register = async (): Promise<string> => {
    const bytes = await readSmallFile(join(home, 'secrets', 'bootstrap.key'), 256).catch(() => undefined);
    const key = bytes?.toString('utf8').trim();
    if (!key || !tokenShape.test(key)) throw new LyraError('unavailable', 'No bootstrap key is available');
    const response = await send('/v1/apps/register', { method: 'POST', headers: { Authorization: `Bootstrap ${key}` }, body: { id: app.id, name: app.name, kind: app.kind }, timeout: 10000 });
    if (!response.ok) throw await failure(response);
    const body = await readJson(response);
    if (!isRecord(body) || !isRecord(body.app) || typeof body.token !== 'string' || !tokenShape.test(body.token)) throw invalid('registration');
    await tokens.set(body.token);
    return body.token;
  };

  /** Sends with the app token, registering first when there is none and once more after a 401. */
  const authed = async (path: string, call: Call): Promise<Response> => {
    const attempt = (token: string) => send(path, { ...call, headers: { ...call.headers, Authorization: `Bearer ${token}` } });
    let response = await attempt(await tokens.get() ?? await register());
    if (response.status === 401) {
      await response.body?.cancel().catch(() => {});
      response = await attempt(await register());
    }
    if (!response.ok) throw await failure(response);
    return response;
  };

  return {
    async *chat(request, { signal } = {}) {
      if (!Array.isArray(request.messages) || !request.messages.length || typeof request.mode !== 'string') throw new LyraError('invalid_request');
      const { messages, mode, priority, context, language } = request;
      const response = await authed('/v1/chat', { method: 'POST', body: { messages, mode, priority, context, language }, signal, language, stream: true });
      yield* events(response, chatEvent, signal);
    },
    models: {
      async status() {
        return modelsStatus(await readJson(await authed('/v1/models', { timeout: 10000 })));
      },
      async *install(plan) {
        if (typeof plan !== 'string' || !plan || plan.length > 64) throw new LyraError('invalid_request');
        const response = await authed('/v1/models/install', { method: 'POST', body: { plan, confirm: true }, stream: true });
        yield* events(response, installEvent);
      },
    },
    ollama: {
      async start() {
        const body = await readJson(await authed('/v1/ollama/start', { method: 'POST', body: {}, timeout: 65000 }));
        if (!isRecord(body) || typeof body.running !== 'boolean' || typeof body.version !== 'string') throw invalid('Ollama status');
        if (!body.running) throw new LyraError('ollama_unavailable');
        return { running: true as const, version: body.version };
      },
    },
  };
}
