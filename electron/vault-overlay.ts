import { app, ipcMain, WebContentsView } from 'electron';
import type { BrowserWindow, WebContents } from 'electron';
import type { Contrast, Language, Theme, VaultOverlayCommand, VaultOverlayState, VaultSuggestion } from '../src/shared/api';
import { validateSender } from './security';
import type { SuggestionAnchor } from './vault';
import { placeSuggestion } from './vault-placement';

const CHANNELS = { state: 'horizon:vault-overlay:state', command: 'horizon:vault-overlay:command', size: 'horizon:vault-overlay:size', changed: 'horizon:vault-overlay:changed', focus: 'horizon:vault-overlay:focus' } as const;
interface Handlers { state(): VaultOverlayState; command(command: VaultOverlayCommand): Promise<void>; size(id: string, width: number, height: number): void }
const handlers = new Map<WebContents, Handlers>();
let registered = false;
function register(): void {
  if (registered) return;
  registered = true;
  const find = (event: Electron.IpcMainInvokeEvent) => {
    const found = handlers.get(event.sender);
    if (!found) throw new Error('Unknown suggestion view');
    validateSender(event, event.sender);
    return found;
  };
  ipcMain.handle(CHANNELS.state, event => find(event).state());
  ipcMain.handle(CHANNELS.command, async (event, ...args: unknown[]) => {
    const found = find(event), command = args[0] as Record<string, unknown> | null;
    if (args.length !== 1 || !command || typeof command !== 'object') throw new Error('VAULT_COMMAND_INVALID');
    const text = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 128;
    const keys = Object.keys(command).sort().join();
    if ((command.type === 'vault-dismiss' || command.type === 'vault-ask') && keys === 'type') return found.command({ type: command.type });
    if (command.type === 'vault-fill' && keys === 'id,suggestion,type' && text(command.id) && text(command.suggestion)) return found.command({ type: 'vault-fill', suggestion: command.suggestion as string, id: command.id as string });
    throw new Error('VAULT_COMMAND_INVALID');
  });
  ipcMain.handle(CHANNELS.size, (event, ...args: unknown[]) => {
    const found = find(event), [id, width, height] = args;
    if (args.length !== 3 || typeof id !== 'string' || id.length > 128 || typeof width !== 'number' || typeof height !== 'number'
      || !Number.isFinite(width) || !Number.isFinite(height) || width <= 0 || height <= 0 || width > 2000 || height > 2000) throw new Error('VAULT_COMMAND_INVALID');
    found.size(id, width, height);
  });
}

interface OverlayOptions {
  window: BrowserWindow; preload: string; theme: Theme; contrast: Contrast;
  info(): { windows: boolean; language: Language; theme: Theme; contrast: Contrast };
  run(command: VaultOverlayCommand): Promise<void>;
  covered(): boolean;
}
// The view that draws the sign-in suggestion above the live page. It is one view per window, hidden until it has drawn the suggestion
// it was given, and it receives nothing but that suggestion (never a value) and sends back only the three commands of the card.
export function createVaultOverlay(options: OverlayOptions) {
  register();
  const { window } = options;
  const view = new WebContentsView({ webPreferences: {
    preload: options.preload, additionalArguments: [`--horizon-theme=${options.theme}`, `--horizon-contrast=${options.contrast}`],
    nodeIntegration: false, nodeIntegrationInWorker: false, nodeIntegrationInSubFrames: false, contextIsolation: true, sandbox: true, webSecurity: true,
    allowRunningInsecureContent: false, experimentalFeatures: false, webviewTag: false, devTools: !app.isPackaged, spellcheck: false,
  } });
  const contents = view.webContents;
  let current: { suggestion: VaultSuggestion; anchor: SuggestionAnchor } | null = null, drawn = { id: '', width: 0, height: 0 }, sent = '', disposed = false, visible = false, zoom = 0;
  view.setBackgroundColor('#00000000');
  view.setVisible(false);
  window.contentView.addChildView(view);
  const payload = (): VaultOverlayState => ({ suggestion: current?.suggestion ?? null, ...options.info() });
  const push = () => {
    if (disposed || contents.isDestroyed()) return;
    const next = payload(), key = JSON.stringify(next);
    if (key === sent) return;
    sent = key; if (!contents.isLoading()) contents.send(CHANNELS.changed, next);
  };
  const hide = () => { if (visible && !disposed) { view.setVisible(false); visible = false; } };
  const layout = () => {
    if (disposed || window.isDestroyed()) return;
    const factor = window.webContents.getZoomFactor();
    if (factor !== zoom && !contents.isDestroyed()) { zoom = factor; contents.setZoomFactor(factor); }
    if (!current || options.covered() || drawn.id !== current.suggestion.id) { hide(); return; }
    const { width, height } = window.getContentBounds();
    const placed = placeSuggestion(current.anchor, { width: Math.ceil(drawn.width * factor), height: Math.ceil(drawn.height * factor) }, { width, height });
    view.setBounds({ x: placed.x, y: placed.y, width: placed.width, height: placed.height });
    // Every page view is added above the ones before it; the suggestion goes back on top each time it shows.
    if (!visible) { window.contentView.addChildView(view); view.setVisible(true); visible = true; }
  };
  handlers.set(contents, {
    state: payload,
    command: command => options.run(command),
    size(id, width, height) { drawn = { id, width, height }; layout(); },
  });
  contents.on('did-finish-load', () => { sent = ''; zoom = 0; push(); layout(); });
  // The card must always come back: a load that failed or a view that crashed is loaded again, a few times with a growing pause.
  let reloads = 0, watchdog: NodeJS.Timeout | undefined;
  const load = () => {
    if (disposed || contents.isDestroyed()) return;
    void contents.loadURL('horizon://app/').catch(() => undefined);
    // A load that neither finishes nor fails is stopped and started again.
    clearTimeout(watchdog); watchdog = setTimeout(() => { if (!disposed && !contents.isDestroyed() && contents.isLoading()) { contents.stop(); reload(); } }, 4000); watchdog.unref();
  };
  const reload = () => { if (disposed || reloads >= 8) return; const timer = setTimeout(load, 200 * ++reloads); timer.unref(); };
  contents.on('did-fail-load', (_event, _code, _description, _url, isMainFrame) => { if (isMainFrame) reload(); });
  contents.on('render-process-gone', reload);
  contents.on('did-finish-load', () => { reloads = 0; clearTimeout(watchdog); });
  load();
  return {
    present(suggestion: VaultSuggestion | null, anchor: SuggestionAnchor | null) {
      current = suggestion && anchor ? { suggestion, anchor } : null;
      push(); layout();
    },
    // The chrome opened or closed something over the page, the window changed size or the theme changed.
    refresh() { push(); layout(); },
    // Moves the keyboard from the page into the card.
    focus() { if (visible && !contents.isDestroyed()) { contents.focus(); contents.send(CHANNELS.focus); } },
    visible: () => visible,
    contents,
    dispose() {
      if (disposed) return;
      disposed = true; handlers.delete(contents);
      try { window.contentView.removeChildView(view); } catch { /* The window may already have detached its views. */ }
      if (!contents.isDestroyed()) contents.close();
    },
  };
}
export { CHANNELS as VAULT_OVERLAY_CHANNELS };
