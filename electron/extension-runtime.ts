import type { BaseWindow, Extension, IpcMainInvokeEvent, IpcMainServiceWorkerInvokeEvent, Session, WebContents } from 'electron';
import { createRequire } from 'node:module';
import type { ElectronChromeExtensions } from 'electron-chrome-extensions';
import { extensionId, isExtensionURL } from './extension-policy';

export type ExtensionEvent = IpcMainInvokeEvent | IpcMainServiceWorkerInvokeEvent;
export function authorizeExtension(event: ExtensionEvent, id: unknown): boolean {
  const target = event.type === 'service-worker' ? event.session : event.sender.session;
  const address = event.type === 'service-worker' ? event.serviceWorker.scope : event.senderFrame?.url;
  return extensionId(id) && !!address && isExtensionURL(target, address) && new URL(address).hostname === id;
}

export interface ActionDetails { title?: string; text?: string; popup?: string; icon?: { path?: string | Record<string, string>; imageData?: string | Record<string, string> } }
interface RuntimeInternals {
  api: { browserAction: { actionMap: Map<string, ActionDetails & { tabs: Record<number, ActionDetails> }>; activateClick(details: { extensionId: string; tabId: number; anchorRect: Electron.Rectangle; alignment: string }): void; popup?: { extensionId: string; destroy(): void } } };
  ctx: { store: { tabs: Set<WebContents>; tabToWindow: WeakMap<WebContents, BaseWindow>; addWindow(window: BaseWindow): void }; router: {
    handle(name: string, callback: (event: { extension: Extension }, ...args: unknown[]) => unknown, options?: { permission: string }): void;
    sendEvent(id: string, name: string, ...args: unknown[]): void;
  } };
}

// These two internal surfaces are reviewed against the pinned distribution hash in the build.
export const runtimeDetails = (chrome: ElectronChromeExtensions) => chrome as unknown as RuntimeInternals;
export function createExtensionRuntime(options: ConstructorParameters<typeof ElectronChromeExtensions>[0] & { updateTab(contents: WebContents, url: string): void }) {
  const vendor = createRequire(__filename)('./chrome-extensions.cjs') as typeof import('electron-chrome-extensions');
  return new vendor.ElectronChromeExtensions(options);
}

export function registerAlarms(chrome: ElectronChromeExtensions, target: Session) {
  const { router } = runtimeDetails(chrome).ctx;
  const alarms = new Map<string, Map<string, { name: string; scheduledTime: number; periodInMinutes?: number; timer?: ReturnType<typeof setTimeout> }>>();
  const clear = (id: string, name: string) => { const alarm = alarms.get(id)?.get(name); if (!alarm) return false; clearTimeout(alarm.timer); alarms.get(id)!.delete(name); return true; };
  const clearExtension = (id: string) => { for (const name of alarms.get(id)?.keys() ?? []) clear(id, name); alarms.delete(id); };
  const describe = ({ name, scheduledTime, periodInMinutes }: { name: string; scheduledTime: number; periodInMinutes?: number }) => ({ name, scheduledTime, ...(periodInMinutes === undefined ? {} : { periodInMinutes }) });
  router.handle('alarms.create', ({ extension }, name, info) => {
    if (typeof name !== 'string' || name.length > 256 || !info || typeof info !== 'object') throw new Error('Invalid alarm');
    const { when, delayInMinutes, periodInMinutes } = info as Record<string, unknown>;
    for (const value of [when, delayInMinutes, periodInMinutes]) if (value !== undefined && (typeof value !== 'number' || !Number.isFinite(value) || value < 0)) throw new Error('Invalid alarm time');
    let entries = alarms.get(extension.id); if (!entries) { entries = new Map(); alarms.set(extension.id, entries); }
    if (!entries.has(name) && entries.size >= 500) throw new Error('Alarm limit reached');
    clear(extension.id, name);
    const period = typeof periodInMinutes === 'number' ? Math.max(0.5, periodInMinutes) : undefined;
    const alarm = { name, scheduledTime: typeof when === 'number' ? Math.max(Date.now(), when) : Date.now() + Math.max(0.5, Number(delayInMinutes ?? period ?? 0.5)) * 60000, periodInMinutes: period, timer: undefined as ReturnType<typeof setTimeout> | undefined };
    const schedule = () => {
      alarm.timer = setTimeout(() => {
        if (Date.now() < alarm.scheduledTime) { schedule(); return; }
        const fired = describe(alarm);
        if (period) { alarm.scheduledTime = Date.now() + period * 60000; schedule(); } else clear(extension.id, name);
        router.sendEvent(extension.id, 'alarms.onAlarm', fired);
      }, Math.min(2147483647, Math.max(0, alarm.scheduledTime - Date.now())));
      alarm.timer.unref();
    };
    entries.set(name, alarm); schedule();
  }, { permission: 'alarms' });
  router.handle('alarms.get', ({ extension }, name) => { const alarm = alarms.get(extension.id)?.get(String(name ?? '')); return alarm && describe(alarm); }, { permission: 'alarms' });
  router.handle('alarms.getAll', ({ extension }) => [...(alarms.get(extension.id)?.values() ?? [])].map(describe), { permission: 'alarms' });
  router.handle('alarms.clear', ({ extension }, name) => clear(extension.id, String(name ?? '')), { permission: 'alarms' });
  router.handle('alarms.clearAll', ({ extension }) => { clearExtension(extension.id); return true; }, { permission: 'alarms' });
  target.extensions.on('extension-unloaded', (_event, extension) => clearExtension(extension.id));
  return () => { for (const id of alarms.keys()) clearExtension(id); };
}
