import { createHash } from 'node:crypto';
import { spawn as nodeSpawn } from 'node:child_process';
import type { ChildProcess, SpawnOptions } from 'node:child_process';
import { mkdtemp, open, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { SERVICE_IDS, SERVICE_INFO, emptyServicesState } from '../src/shared/services';
import type { ServiceDialog, ServiceFailure, ServiceId, ServiceReason, ServiceRelease, ServicesCommand, ServicesState, ServiceStatus } from '../src/shared/services';

// Installing a shared Cosmic service (shared-services contract, section 5). Everything here runs in the main process, only after the person's OK:
// the installer comes from the service's latest GitHub release over HTTPS, is checked against that release's SHA256SUMS.txt, runs per user and silently,
// and is deleted afterwards in every case. Then the service's own client is asked again.
export const RELEASE_HOSTS: readonly string[] = ['github.com', 'objects.githubusercontent.com', 'release-assets.githubusercontent.com'];
export const DOWNLOAD_CAP = 500 * 1024 * 1024;
export const INSTALL_ARGUMENTS: readonly string[] = ['/S'];
const API_CAP = 1024 * 1024, SUMS_CAP = 64 * 1024, MAX_REDIRECTS = 5;
export const downloadUrl = (service: ServiceId, name: string = SERVICE_INFO[service].asset) => `https://github.com/${SERVICE_INFO[service].repo}/releases/latest/download/${name}`;
export const releaseUrl = (service: ServiceId) => `https://api.github.com/repos/${SERVICE_INFO[service].repo}/releases/latest`;
export const sizeInMb = (bytes: number) => Math.max(1, Math.round(bytes / (1024 * 1024)));

type InstallCode = 'not_found' | 'http' | 'redirect' | 'too_large' | 'network' | 'checksum' | 'installer' | 'cancelled';
export class InstallError extends Error {
  readonly code: InstallCode;
  constructor(code: InstallCode) { super(`SERVICE_${code.toUpperCase()}`); this.code = code; }
}
type Fetch = (url: string, init: { method: 'GET'; redirect: 'manual'; signal: AbortSignal; headers: Record<string, string> }) => Promise<Response>;
type Spawn = (command: string, args: readonly string[], options: SpawnOptions) => ChildProcess;
const headers = { 'User-Agent': 'Horizon', Accept: 'application/octet-stream', 'Accept-Encoding': 'identity' };

function assertRelease(url: URL): void {
  if (url.protocol !== 'https:' || url.username || url.password || url.port || !RELEASE_HOSTS.includes(url.hostname)) throw new InstallError('redirect');
}
// Redirects are followed one by one; every address, the first included, has to be an HTTPS address on one of GitHub's release hosts.
async function follow(fetchFile: Fetch, address: string, signal: AbortSignal): Promise<Response> {
  let current = new URL(address);
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    assertRelease(current);
    const response = await fetchFile(current.href, { method: 'GET', redirect: 'manual', signal, headers }).catch((error: unknown) => {
      throw signal.aborted ? new InstallError('cancelled') : error instanceof InstallError ? error : new InstallError('network');
    });
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get('location');
      await response.body?.cancel().catch(() => undefined);
      if (!location) throw new InstallError('redirect');
      try { current = new URL(location, current); } catch { throw new InstallError('redirect'); }
      continue;
    }
    if (response.status === 404) { await response.body?.cancel().catch(() => undefined); throw new InstallError('not_found'); }
    if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); throw new InstallError('http'); }
    return response;
  }
  throw new InstallError('redirect');
}
async function readCapped(response: Response, cap: number, signal: AbortSignal): Promise<Buffer> {
  const reader = response.body?.getReader();
  if (!reader) throw new InstallError('network');
  const parts: Buffer[] = [];
  let size = 0;
  try {
    for (;;) {
      const next = await reader.read().catch(() => { throw signal.aborted ? new InstallError('cancelled') : new InstallError('network'); });
      if (next.done) break;
      size += next.value.length;
      if (size > cap) { await reader.cancel().catch(() => undefined); throw new InstallError('too_large'); }
      parts.push(Buffer.from(next.value));
    }
  } finally { reader.releaseLock(); }
  return Buffer.concat(parts);
}

// The size of the installer is read from the latest release before anything is downloaded. A missing release or installer is told apart from a question that could not be answered.
export async function readRelease(fetchFile: Fetch, service: ServiceId, timeout = 8000): Promise<{ release: ServiceRelease; sizeMb: number | null }> {
  const signal = AbortSignal.timeout(timeout);
  try {
    const response = await fetchFile(releaseUrl(service), { method: 'GET', redirect: 'manual', signal, headers: { 'User-Agent': 'Horizon', Accept: 'application/vnd.github+json' } });
    if (response.status === 404) { await response.body?.cancel().catch(() => undefined); return { release: 'missing', sizeMb: null }; }
    if (response.status !== 200) { await response.body?.cancel().catch(() => undefined); return { release: 'unknown', sizeMb: null }; }
    const body: unknown = JSON.parse((await readCapped(response, API_CAP, signal)).toString('utf8'));
    const assets = body && typeof body === 'object' && 'assets' in body && Array.isArray(body.assets) ? body.assets as unknown[] : null;
    if (!assets) return { release: 'unknown', sizeMb: null };
    const asset = assets.find(item => item && typeof item === 'object' && 'name' in item && item.name === SERVICE_INFO[service].asset);
    if (!asset) return { release: 'missing', sizeMb: null };
    const size = typeof asset === 'object' && 'size' in asset ? asset.size : undefined;
    return typeof size === 'number' && Number.isSafeInteger(size) && size > 0 && size <= DOWNLOAD_CAP ? { release: 'available', sizeMb: sizeInMb(size) } : { release: 'available', sizeMb: null };
  } catch { return { release: 'unknown', sizeMb: null }; }
}

// The SHA-256 the release publishes for the installer, from the same release's SHA256SUMS.txt.
export async function readChecksum(fetchFile: Fetch, service: ServiceId, signal: AbortSignal): Promise<string> {
  const response = await follow(fetchFile, downloadUrl(service, 'SHA256SUMS.txt'), signal);
  const text = (await readCapped(response, SUMS_CAP, signal)).toString('utf8');
  for (const line of text.split(/\r?\n/)) {
    const match = /^([0-9a-fA-F]{64}) [ *]?(.+?)\s*$/.exec(line);
    if (match && match[2] === SERVICE_INFO[service].asset) return match[1]!.toLowerCase();
  }
  throw new InstallError('checksum');
}

// Streams the installer into the folder with a hard size cap and returns its SHA-256.
export async function downloadInstaller(fetchFile: Fetch, service: ServiceId, file: string, options: { signal: AbortSignal; cap?: number; stall?: number; progress?(received: number, total: number | null): void }): Promise<string> {
  const cap = options.cap ?? DOWNLOAD_CAP, stall = options.stall ?? 60000;
  const watchdog = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const watch = () => { clearTimeout(timer); timer = setTimeout(() => watchdog.abort(), stall); };
  const signal = AbortSignal.any([options.signal, watchdog.signal]);
  watch();
  const hash = createHash('sha256');
  try {
    const response = await follow(fetchFile, downloadUrl(service), signal);
    const length = Number(response.headers.get('content-length'));
    const total = Number.isSafeInteger(length) && length > 0 ? length : null;
    if (total !== null && total > cap) { await response.body?.cancel().catch(() => undefined); throw new InstallError('too_large'); }
    const reader = response.body?.getReader();
    if (!reader) throw new InstallError('network');
    const handle = await open(file, 'wx', 0o600);
    let received = 0, complete = false;
    try {
      for (;;) {
        const next = await reader.read().catch(() => { throw options.signal.aborted ? new InstallError('cancelled') : new InstallError('network'); });
        if (next.done) break;
        watch();
        received += next.value.length;
        if (received > cap) { await reader.cancel().catch(() => undefined); throw new InstallError('too_large'); }
        hash.update(next.value);
        await handle.write(next.value);
        options.progress?.(received, total);
      }
      complete = true;
    } finally { reader.releaseLock(); await handle.close(); if (!complete) await rm(file, { force: true }).catch(() => undefined); }
    return hash.digest('hex');
  } finally { clearTimeout(timer); }
}

// The installer runs per user and silently: no shell, no window, no elevation. A hung installer is given up on after the timeout.
export function runInstaller(spawn: Spawn, file: string, timeout: number): Promise<void> {
  return new Promise((done, fail) => {
    let child: ChildProcess;
    try { child = spawn(file, INSTALL_ARGUMENTS, { shell: false, windowsHide: true, stdio: 'ignore' }); }
    catch { fail(new InstallError('installer')); return; }
    let settled = false;
    const finish = (error?: InstallError) => { if (settled) return; settled = true; clearTimeout(timer); if (error) fail(error); else done(); };
    const timer = setTimeout(() => { try { child.kill(); } catch { /* The installer may already be gone. */ } finish(new InstallError('installer')); }, timeout);
    child.once('error', () => finish(new InstallError('installer')));
    child.once('exit', code => finish(code === 0 ? undefined : new InstallError('installer')));
  });
}

// What the service's client answers when Horizon connects: working, working but waiting for its first run, missing, or installed and not answering.
export type ReachAnswer = 'ready' | 'setup' | ServiceReason;
export interface ServicesHost {
  privateWindow: boolean; alive(): boolean; changed(): void;
  reach(service: ServiceId): Promise<ReachAnswer>;
  open(url: string): Promise<void>;
}
export interface ServicesOptions {
  platform?: NodeJS.Platform; fetch?: Fetch; spawn?: Spawn; temporary?: string;
  // "Not now" holds per service until Horizon restarts, across every window.
  declined?: Set<ServiceId>; lock?: { held: boolean };
  pollMs?: number; pollLimitMs?: number; installTimeoutMs?: number; releaseTimeoutMs?: number; cap?: number; stallMs?: number;
}
const sharedDeclined = new Set<ServiceId>(), sharedLock = { held: false };
const failureOf = (error: unknown): ServiceFailure => error instanceof InstallError ? error.code === 'checksum' ? 'checksum' : error.code === 'installer' ? 'install' : 'download' : 'download';

export function createServices(host: ServicesHost, options: ServicesOptions = {}) {
  const platform = options.platform ?? process.platform, windows = platform === 'win32';
  const fetchFile: Fetch = options.fetch ?? ((url, init) => fetch(url, init));
  const spawn: Spawn = options.spawn ?? nodeSpawn;
  const declined = options.declined ?? sharedDeclined, lock = options.lock ?? sharedLock;
  const state: ServicesState = emptyServicesState();
  let dialog: ServiceDialog | null = null;
  let resume: (() => void) | undefined, opening = false, closed = false, cancelled = false, controller: AbortController | undefined, wait = 0;
  const publish = () => { if (!closed && host.alive()) host.changed(); };
  const show = (next: ServiceDialog | null) => { dialog = next; publish(); };
  const note = (service: ServiceId, status: ServiceStatus) => { if (state.entries[service] !== status) { state.entries[service] = status; publish(); } };
  const continued = () => { const next = resume; resume = undefined; try { next?.(); } catch { /* The feature that asked can ask again. */ } };
  const fresh = (service: ServiceId, phase: ServiceDialog['phase'], extra: Partial<ServiceDialog> = {}): ServiceDialog => ({ service, phase, release: 'unknown', sizeMb: null, manual: !windows, received: 0, total: null, failure: null, busy: false, ...extra });

  // The offer names what will be downloaded and how large it is before anything is fetched. Off Windows there is nothing to download, so there is nothing to look up.
  const offer = async (service: ServiceId) => {
    if (opening) return;
    opening = true;
    if (dialog) { dialog.busy = true; publish(); }
    try {
      const info = windows ? await readRelease(fetchFile, service, options.releaseTimeoutMs) : { release: 'unknown' as const, sizeMb: null };
      if (closed || !host.alive()) return;
      show(fresh(service, 'offer', { release: info.release, sizeMb: info.sizeMb }));
    } finally { opening = false; }
  };
  const unavailable = (service: ServiceId, reason: ServiceReason, onReady?: () => void) => {
    if (host.privateWindow || closed) return;
    note(service, reason);
    // Never over another dialog and never again for a service the person put off.
    if (declined.has(service) || dialog || opening) return;
    resume = onReady;
    if (reason === 'not_installed') void offer(service);
    else show(fresh(service, 'not-started'));
  };

  const finished = (service: ServiceId) => { note(service, 'installed'); show(null); continued(); };
  // The service reports that its first run is still open: the dialog waits for its own status to change, every few seconds and for a limited time.
  const waitForSetup = async (service: ServiceId) => {
    const ticket = ++wait, interval = options.pollMs ?? 3000, limit = options.pollLimitMs ?? 10 * 60 * 1000, started = Date.now();
    show(fresh(service, 'finish'));
    while (ticket === wait && !closed && Date.now() - started < limit) {
      await new Promise<void>(done => { setTimeout(done, interval); });
      if (ticket !== wait || closed) return;
      const answer = await host.reach(service).catch(() => 'did_not_start' as const);
      if (ticket !== wait || closed) return;
      if (answer === 'ready') { finished(service); return; }
    }
    if (ticket === wait && !closed) show(null);
  };
  const afterInstall = async (service: ServiceId) => {
    const answer = await host.reach(service).catch(() => 'did_not_start' as const);
    if (closed || !host.alive()) return;
    if (answer === 'ready') finished(service);
    else if (answer === 'setup') { note(service, 'installed'); void waitForSetup(service); }
    else if (answer === 'did_not_start') { note(service, 'did_not_start'); show(fresh(service, 'not-started')); }
    else show(fresh(service, 'failed', { failure: 'install' }));
  };

  const install = async (service: ServiceId) => {
    if (lock.held) { show(fresh(service, 'failed', { failure: 'busy' })); return; }
    lock.held = true; cancelled = false;
    const active = new AbortController();
    controller = active;
    let folder: string | undefined, failure: ServiceFailure | 'cancelled' | null = null;
    const current = dialog;
    show(fresh(service, 'downloading', { release: current?.release ?? 'unknown', sizeMb: current?.sizeMb ?? null }));
    try {
      folder = await mkdtemp(join(options.temporary ?? tmpdir(), 'horizon-service-'));
      const expected = await readChecksum(fetchFile, service, active.signal);
      let last = 0;
      const actual = await downloadInstaller(fetchFile, service, join(folder, SERVICE_INFO[service].asset), { signal: active.signal, cap: options.cap, stall: options.stallMs, progress: (received, total) => {
        const now = Date.now();
        if (!dialog || dialog.phase !== 'downloading') return;
        dialog.received = received; dialog.total = total;
        if (now - last >= 200) { last = now; publish(); }
      } });
      active.signal.throwIfAborted();
      if (actual !== expected) throw new InstallError('checksum');
      show(fresh(service, 'installing', { release: dialog?.release ?? 'unknown', sizeMb: dialog?.sizeMb ?? null }));
      await runInstaller(spawn, join(folder, SERVICE_INFO[service].asset), options.installTimeoutMs ?? 5 * 60 * 1000);
    } catch (error) {
      failure = cancelled ? 'cancelled' : failureOf(error);
    } finally {
      // The download is deleted in every case, before anything else is shown or done.
      if (folder) await rm(folder, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 }).catch(() => undefined);
      lock.held = false; controller = undefined;
    }
    if (closed) return;
    if (failure === 'cancelled') show(null);
    else if (failure) show(fresh(service, 'failed', { failure }));
    else await afterInstall(service);
  };

  const stale = () => new Error('SERVICES_STALE');
  const run = async (command: ServicesCommand): Promise<void> => {
    if (host.privateWindow || closed) throw new Error('SERVICES_PRIVATE');
    switch (command.type) {
      case 'service-check':
        if (dialog && ['downloading', 'installing'].includes(dialog.phase)) return;
        for (const service of SERVICE_IDS) {
          const answer = await host.reach(service).catch(() => 'did_not_start' as const);
          note(service, answer === 'ready' || answer === 'setup' ? 'installed' : answer);
        }
        return;
      case 'service-offer':
        if (dialog || opening) throw stale();
        resume = undefined; declined.delete(command.service);
        await offer(command.service); return;
      case 'service-install': {
        // The OK is for the offer that is on screen.
        if (!dialog || dialog.phase !== 'offer' || dialog.service !== command.service || dialog.busy || dialog.release === 'missing') throw stale();
        if (dialog.manual) { await host.open(SERVICE_INFO[command.service].download); show(null); return; }
        void install(command.service); return;
      }
      case 'service-retry': {
        if (!dialog) throw stale();
        const service = dialog.service;
        // A failed install tries again from the start; a service that did not start is asked again.
        if (dialog.phase === 'failed') { void install(service); return; }
        if (dialog.phase !== 'not-started') throw stale();
        dialog.busy = true; publish();
        const answer = await host.reach(service).catch(() => 'did_not_start' as const);
        if (closed || !dialog || dialog.service !== service) return;
        if (answer === 'ready') finished(service);
        else if (answer === 'setup') { note(service, 'installed'); void waitForSetup(service); }
        else { note(service, answer); if (answer === 'not_installed') await offer(service); else { dialog.busy = false; publish(); } }
        return;
      }
      case 'service-reinstall':
        // Reinstalling downloads again, so the person sees the size and says yes to it first.
        if (!dialog || dialog.phase !== 'not-started' || dialog.busy) throw stale();
        await offer(dialog.service); return;
      case 'service-not-now':
        if (!dialog || dialog.phase !== 'offer' && dialog.phase !== 'not-started') throw stale();
        declined.add(dialog.service); resume = undefined; show(null); return;
      case 'service-cancel':
        if (!dialog || dialog.phase !== 'downloading') throw stale();
        cancelled = true; controller?.abort(); return;
      case 'service-close':
        if (!dialog || dialog.phase !== 'finish' && dialog.phase !== 'failed') throw stale();
        wait++; resume = undefined; show(null); return;
      case 'service-page':
        await host.open(SERVICE_INFO[command.service][command.page]); return;
    }
  };
  return {
    state: (): ServicesState => ({ dialog: dialog ? { ...dialog } : null, entries: { ...state.entries } }),
    unavailable, run, note,
    close() { closed = true; wait++; cancelled = true; controller?.abort(); },
  };
}
