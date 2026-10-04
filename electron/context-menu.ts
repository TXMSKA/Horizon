import { randomUUID } from 'node:crypto';
import type { ContextMenuParams } from 'electron';
import type { ContextMenuItem, ContextMenuItemId, PageContextMenu } from '../src/shared/api';
import { isWebURL } from './browsing';

export type PageMenuParams = Pick<ContextMenuParams, 'x' | 'y' | 'linkURL' | 'srcURL' | 'mediaType' | 'selectionText' | 'isEditable' | 'dictionarySuggestions' | 'editFlags' | 'menuSourceType'>;
interface Navigation { back: boolean; forward: boolean; reload: boolean }
const itemIds = new Set(['add-to-desktop', 'open-link', 'copy-link', 'open-image', 'save-image', 'copy-image', 'copy-image-address', 'copy', 'search-selection', 'undo', 'redo', 'cut', 'paste', 'select-all', 'back', 'forward', 'reload']);

export function isContextMenuItemId(value: unknown): value is ContextMenuItemId {
  return typeof value === 'string' && (itemIds.has(value) || value.startsWith('spell:') && value.length > 6 && value.length <= 262 && !/[\u0000-\u001f\u007f]/.test(value));
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
  private pending?: { id: string; tabId: string; params: PageMenuParams; groups: ContextMenuItem[][] };
  get tabId(): string | undefined { return this.pending?.tabId; }

  open(tabId: string, params: PageMenuParams, navigation: Navigation, offset: { x: number; y: number }, chromeZoom: number, privateWindow = false): PageContextMenu | null {
    this.invalidate();
    const groups = contextMenuGroups(params, navigation, privateWindow);
    if (!groups.length) return null;
    const id = randomUUID();
    const stored = { ...params, editFlags: { ...params.editFlags }, dictionarySuggestions: [...params.dictionarySuggestions] };
    this.pending = { id, tabId, params: stored, groups };
    return {
      id, x: (offset.x + params.x) / chromeZoom, y: (offset.y + params.y) / chromeZoom,
      keyboard: params.menuSourceType === 'keyboard', groups: groups.map(group => group.map(item => ({ ...item }))),
      ...(!params.isEditable && params.selectionText.trim() ? { selection: Array.from(params.selectionText).slice(0, 40).join('') } : {}),
    };
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
