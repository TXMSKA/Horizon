import { randomUUID } from 'node:crypto';
import type { BrowserWindow, ContextMenuParams, MenuItem } from 'electron';
import type { ContextMenuItem, ContextMenuItemId, PageContextMenu } from '../src/shared/api';
import { isWebURL } from './browsing';

export type PageMenuParams = Pick<ContextMenuParams, 'x' | 'y' | 'linkURL' | 'srcURL' | 'mediaType' | 'selectionText' | 'isEditable' | 'dictionarySuggestions' | 'editFlags' | 'menuSourceType'>;
interface Navigation { back: boolean; forward: boolean; reload: boolean }
const itemIds = new Set(['add-to-desktop', 'open-link', 'copy-link', 'open-image', 'save-image', 'copy-image', 'copy-image-address', 'copy', 'search-selection', 'undo', 'redo', 'cut', 'paste', 'select-all', 'back', 'forward', 'reload']);

export function isContextMenuItemId(value: unknown): value is ContextMenuItemId {
  return typeof value === 'string' && (itemIds.has(value) || /^extension:[a-f0-9-]{36}$/.test(value) || value.startsWith('spell:') && value.length > 6 && value.length <= 262 && !/[\u0000-\u001f\u007f]/.test(value));
}

export function contextMenuGroups(params: PageMenuParams, navigation: Navigation, privateWindow = false): ContextMenuItem[][] {
  const groups: ContextMenuItem[][] = [];
  const row = (id: ContextMenuItemId, enabled = true): ContextMenuItem => ({ id, enabled });
  if (isWebURL(params.linkURL)) groups.push([row('open-link'), row('copy-link')]);
  if (params.mediaType === 'image' && isWebURL(params.srcURL)) groups.push([row('open-image'), row('save-image'), row('copy-image'), row('copy-image-address')]);
  if (params.isEditable) {
    const suggestions = [...new Set(params.dictionarySuggestions)].map(word => `spell:${word}` as const).filter(isContextMenuItemId);
    if (suggestions.length) groups.push(suggestions.map(id => row(id)));
    const flags = params.editFlags;
    groups.push([row('undo', flags.canUndo), row('redo', flags.canRedo), row('cut', flags.canCut), row('copy', flags.canCopy), row('paste', flags.canPaste), row('select-all', flags.canSelectAll)]);
  } else if (params.selectionText.trim()) groups.push([row('copy', params.editFlags.canCopy), row('search-selection')]);
  if (!params.linkURL && params.mediaType !== 'image' && !params.isEditable && !params.selectionText.trim()) {
    groups.push([row('back', navigation.back), row('forward', navigation.forward), row('reload', navigation.reload)]);
  }
  if (!privateWindow && params.selectionText.trim()) groups.push([row('add-to-desktop')]);
  return groups;
}

// Only this record can authorize an action; display data never becomes a URL or an edit argument.
export class PageMenuSession {
  private pending?: { id: string; tabId: string; params: PageMenuParams; groups: ContextMenuItem[][]; extensions: Map<ContextMenuItemId, () => void> };
  get tabId(): string | undefined { return this.pending?.tabId; }

  open(tabId: string, params: PageMenuParams, navigation: Navigation, offset: { x: number; y: number }, chromeZoom: number, privateWindow = false, items: { item: MenuItem; window: BrowserWindow }[] = []): PageContextMenu | null {
    this.invalidate();
    const groups = contextMenuGroups(params, navigation, privateWindow);
    const extensions = new Map<ContextMenuItemId, () => void>(), rows: ContextMenuItem[] = [];
    const add = (item: MenuItem, window: BrowserWindow, prefix = '', enabled = true, depth = 0) => {
      if (!item.visible || item.type === 'separator' || rows.length >= 100 || depth > 8) return;
      const label = `${prefix}${item.label}`.slice(0, 1024), allowed = enabled && item.enabled;
      // Keep submenu ancestry in the label while using Horizon's existing keyboard menu surface.
      if (item.submenu) { for (const child of item.submenu.items) add(child, window, `${label} > `, allowed, depth + 1); return; }
      const id: ContextMenuItemId = `extension:${randomUUID()}`;
      rows.push({ id, label, enabled: allowed, ...(['checkbox', 'radio'].includes(item.type) ? { checked: item.checked } : {}) });
      extensions.set(id, () => { if (item.type === 'checkbox') item.checked = !item.checked; item.click(item, window, {}); });
    };
    if (!privateWindow) for (const { item, window } of items) add(item, window);
    if (rows.length) groups.push(rows);
    if (!groups.length) return null;
    const id = randomUUID();
    const stored = { ...params, editFlags: { ...params.editFlags }, dictionarySuggestions: [...params.dictionarySuggestions] };
    this.pending = { id, tabId, params: stored, groups, extensions };
    return {
      id, x: (offset.x + params.x) / chromeZoom, y: (offset.y + params.y) / chromeZoom,
      keyboard: params.menuSourceType === 'keyboard', groups: groups.map(group => group.map(item => ({ ...item }))),
      ...(!params.isEditable && params.selectionText.trim() ? { selection: Array.from(params.selectionText).slice(0, 40).join('') } : {}),
    };
  }

  invokeExtension(id: string, item: ContextMenuItemId, tabId: string): void {
    const action = this.pending?.extensions.get(item);
    if (!action) throw new Error('Invalid extension menu action');
    this.take(id, item, tabId); action();
  }

  take(id: string, item: ContextMenuItemId, tabId: string): PageMenuParams {
    const pending = this.pending;
    if (!pending || pending.id !== id || pending.tabId !== tabId || !pending.groups.flat().some(row => row.id === item && row.enabled)) throw new Error('Invalid context menu action');
    this.pending = undefined;
    return pending.params;
  }

  dismiss(id: string): void {
    if (!this.pending || this.pending.id !== id) throw new Error('Unknown context menu');
    this.invalidate();
  }

  invalidate(tabId?: string): boolean {
    if (!this.pending || tabId !== undefined && this.pending.tabId !== tabId) return false;
    this.pending = undefined;
    return true;
  }
}
