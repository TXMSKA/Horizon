import type { AppUpdater } from 'electron-updater';
import type { UpdateState } from '../src/shared/api';

const FIRST_CHECK_DELAY = 5000;
const CHECK_INTERVAL = 4 * 60 * 60 * 1000;

export interface UpdatesOptions {
  platform: string;
  packaged: boolean;
  // Linux updates replace either the AppImage file or the deb package; other install types cannot update themselves.
  appImage: boolean;
  packageType: string | null;
  feed?: string;
  load: () => Promise<AppUpdater>;
  firstCheckDelay?: number;
  checkInterval?: number;
}
export type Updates = ReturnType<typeof createUpdates>;

// Test-only: HORIZON_UPDATE_URL points a packaged build at a local feed so the update path can be proven without a release; only loopback http addresses are accepted.
export function localFeedURL(value: string | undefined): string | undefined {
  if (!value) return undefined;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' && (url.hostname === '127.0.0.1' || url.hostname === 'localhost') && !url.username && !url.password ? url.href : undefined;
  } catch { return undefined; }
}

const supported = (options: UpdatesOptions) => options.packaged && (options.platform === 'win32' || options.platform === 'linux' && (options.appImage || options.packageType === 'deb'));

export function createUpdates(options: UpdatesOptions) {
  let state: UpdateState = { status: supported(options) ? 'idle' : 'unavailable' };
  let updater: AppUpdater | undefined, checking = false, started = false;
  const listeners = new Set<() => void>();
  const set = (next: UpdateState) => { state = next; for (const listener of listeners) listener(); };
  const prepare = async () => {
    const autoUpdater = await options.load();
    autoUpdater.autoDownload = true;
    autoUpdater.autoInstallOnAppQuit = true;
    autoUpdater.allowPrerelease = false;
    autoUpdater.allowDowngrade = false;
    if (options.feed) autoUpdater.setFeedURL({ provider: 'generic', url: options.feed });
    autoUpdater.on('update-available', () => set({ status: 'downloading', percent: 0 }));
    autoUpdater.on('download-progress', progress => set({ status: 'downloading', percent: Math.max(0, Math.min(100, Math.round(progress.percent))) }));
    autoUpdater.on('update-downloaded', () => set({ status: 'ready' }));
    autoUpdater.on('update-not-available', () => set({ status: 'upToDate' }));
    autoUpdater.on('error', () => set({ status: 'error' }));
    return autoUpdater;
  };
  const check = async () => {
    if (checking || state.status === 'unavailable' || state.status === 'downloading' || state.status === 'ready') return;
    checking = true;
    try {
      updater ??= await prepare();
      set({ status: 'checking' });
      // Builds are unsigned: electron-updater's NsisUpdater.verifySignature returns null when app-update.yml carries no publisherName, so the update installs without a signature check.
      if (await updater.checkForUpdates() === null) set({ status: 'unavailable' });
    } catch (error) {
      console.error('Update check failed', error);
      set({ status: 'error' });
    } finally { checking = false; }
  };
  return {
    get state() { return state; },
    subscribe(listener: () => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
    start() {
      if (started || state.status === 'unavailable') return;
      started = true;
      setTimeout(() => { void check(); }, options.firstCheckDelay ?? FIRST_CHECK_DELAY).unref();
      setInterval(() => { void check(); }, options.checkInterval ?? CHECK_INTERVAL).unref();
    },
    check,
    restart() {
      if (state.status !== 'ready' || !updater) throw new Error('No update is ready');
      // Silent and forced relaunch: the installer runs without its wizard and Horizon opens again when it finishes.
      updater.quitAndInstall(true, true);
    },
  };
}
