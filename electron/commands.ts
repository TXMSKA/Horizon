import type { BrowserCommand, ContentArea, Notebook } from '../src/shared/api';
import { isWebURL } from './browsing';
import { isContrast, isDarkPagesMode, isDarkStrength, isDarkTone, isTheme } from './settings';
import { isContextMenuItemId } from './context-menu';
import { isProfileColor, isProfileId, profileName } from './profiles';
import { isPermissionDecision, isSitePermission } from './site-settings';
import { notebookName, notebookText } from './notebooks';

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('Invalid browser argument');
  return value as Record<string, unknown>;
}
function string(value: unknown, maximum: number, empty = false): value is string {
  return typeof value === 'string' && value.length <= maximum && (empty || value.length > 0) && !value.includes('\0');
}
function keys(value: Record<string, unknown>, allowed: string[]): void {
  if (Object.keys(value).some(key => !allowed.includes(key))) throw new Error('Unexpected browser argument');
}
export function validateCommand(value: unknown, profileIds?: ReadonlySet<string>, notebooks: readonly Notebook[] = []): BrowserCommand {
  const command = object(value);
  const type = command.type;
  let valid = false;
  const notebook = (id: unknown) => isProfileId(id) && notebooks.some(notebook => notebook.id === id);
  const item = (id: unknown, item: unknown) => notebook(id) && isProfileId(item) && notebooks.some(notebook => notebook.id === id && notebook.items.some(entry => entry.id === item));
  switch (type) {
    case 'retry-notebook-storage': keys(command, ['type']); valid = Object.keys(command).length === 1 && Object.hasOwn(command, 'type'); break;
    case 'create-notebook': case 'rename-notebook':
      keys(command, type === 'create-notebook' ? ['type', 'name'] : ['type', 'id', 'name']); notebookName(command.name);
      valid = Object.keys(command).length === (type === 'create-notebook' ? 2 : 3) && (type === 'create-notebook' || notebook(command.id)); break;
    case 'delete-notebook': case 'set-notebook':
      keys(command, ['type', 'id']); valid = Object.keys(command).length === 2 && notebook(command.id); break;
    case 'open-notebook':
      keys(command, ['type', 'id', 'item']); valid = Object.hasOwn(command, 'id') && Object.keys(command).length === (Object.hasOwn(command, 'item') ? 3 : 2)
        && notebook(command.id) && (!Object.hasOwn(command, 'item') || item(command.id, command.item)); break;
    case 'add-note':
      keys(command, ['type', 'notebook', 'title', 'text']); valid = Object.keys(command).length === 4 && notebook(command.notebook)
        && notebookText(command.title, 200) && notebookText(command.text, 100000); break;
    case 'update-notebook-item':
      keys(command, ['type', 'notebook', 'id', 'title', 'text', 'note']);
      valid = Object.hasOwn(command, 'notebook') && Object.hasOwn(command, 'id') && item(command.notebook, command.id) && ['title', 'text', 'note'].some(key => Object.hasOwn(command, key))
        && (!Object.hasOwn(command, 'title') || notebookText(command.title, 200))
        && (!Object.hasOwn(command, 'text') || notebookText(command.text, 100000))
        && (!Object.hasOwn(command, 'note') || notebookText(command.note, 20000)); break;
    case 'delete-notebook-item':
      keys(command, ['type', 'notebook', 'id']); valid = Object.keys(command).length === 3 && item(command.notebook, command.id); break;
    case 'save-capture': {
      keys(command, command.kind === 'area' ? ['type', 'notebook', 'kind', 'rect'] : ['type', 'notebook', 'kind']);
      valid = Object.keys(command).length === (command.kind === 'area' ? 4 : 3) && notebook(command.notebook) && (command.kind === 'text' || command.kind === 'page' || command.kind === 'area');
      if (command.kind === 'area') {
        const rect = object(command.rect); keys(rect, ['x', 'y', 'width', 'height']);
        valid &&= Object.keys(rect).length === 4 && ['x', 'y', 'width', 'height'].every(key => typeof rect[key] === 'number' && Number.isFinite(rect[key]) && Math.abs(rect[key] as number) <= 100000)
          && (rect.width as number) > 0 && (rect.height as number) > 0;
      }
      break;
    }
    case 'set-blocking': case 'set-site-dark': keys(command, ['type', 'enabled']); valid = Object.keys(command).length === 2 && typeof command.enabled === 'boolean'; break;
    case 'set-site-permission':
      keys(command, ['type', 'permission', 'decision']); valid = Object.keys(command).length === 3 && isSitePermission(command.permission) && isPermissionDecision(command.decision); break;
    case 'answer-permission':
      keys(command, ['type', 'id', 'answer']); valid = Object.keys(command).length === 3 && string(command.id, 128) && ['allow', 'block', 'dismiss'].includes(command.answer as string); break;
    case 'switch-profile': case 'delete-profile':
      keys(command, ['type', 'id']); valid = Object.keys(command).length === 2 && Object.hasOwn(command, 'id') && isProfileId(command.id) && (!profileIds || profileIds.has(command.id)); break;
    case 'create-profile': case 'update-profile':
      keys(command, type === 'create-profile' ? ['type', 'name', 'color'] : ['type', 'id', 'name', 'color']);
      profileName(command.name);
      valid = Object.keys(command).length === (type === 'create-profile' ? 3 : 4) && Object.hasOwn(command, 'name') && Object.hasOwn(command, 'color')
        && typeof command.name === 'string' && command.name.length <= 256 && isProfileColor(command.color)
        && (type === 'create-profile' || isProfileId(command.id) && (!profileIds || profileIds.has(command.id))); break;
    case 'theme': case 'migrate-theme': keys(command, ['type', 'value']); valid = isTheme(command.value); break;
    case 'contrast': keys(command, ['type', 'value']); valid = isContrast(command.value); break;
    case 'dark-pages': keys(command, ['type', 'value']); valid = Object.keys(command).length === 2 && isDarkPagesMode(command.value); break;
    case 'dark-strength': keys(command, ['type', 'value']); valid = Object.keys(command).length === 2 && isDarkStrength(command.value); break;
    case 'dark-tone': keys(command, ['type', 'value']); valid = Object.keys(command).length === 2 && isDarkTone(command.value); break;
    case 'new-tab':
      keys(command, ['type', 'input', 'background']);
      valid = (command.input === undefined || string(command.input, 8192)) && (command.background === undefined || typeof command.background === 'boolean');
      break;
    case 'context-menu': keys(command, ['type', 'id', 'item']); valid = string(command.id, 128) && isContextMenuItemId(command.item); break;
    case 'dismiss-context-menu': keys(command, ['type', 'id']); valid = string(command.id, 128); break;
    case 'activate-tab': case 'close-tab': case 'cancel-download': case 'show-download': case 'remove-download':
      keys(command, ['type', 'id']); valid = string(command.id, 128); break;
    case 'navigate': keys(command, ['type', 'input']); valid = string(command.input, 8192); break;
    case 'zoom': keys(command, ['type', 'delta']); valid = command.delta === -1 || command.delta === 0 || command.delta === 1; break;
    case 'find':
      keys(command, ['type', 'text', 'forward', 'next']);
      valid = string(command.text, 1024, true) && typeof command.forward === 'boolean' && typeof command.next === 'boolean'; break;
    case 'rename-bookmark':
      keys(command, ['type', 'url', 'title']); valid = isWebURL(command.url) && string(command.title, 1024); break;
    case 'delete-history': case 'delete-bookmark': keys(command, ['type', 'url']); valid = isWebURL(command.url); break;
    case 'restore':
      keys(command, ['type', 'kind']); valid = command.kind === 'history' || command.kind === 'bookmarks' || command.kind === 'downloads' || command.kind === 'notebooks'; break;
    case 'back': case 'forward': case 'reload': case 'stop': case 'bookmark': case 'focus-page': case 'stop-find': case 'clear-history': case 'open-downloads-folder':
      keys(command, ['type']); valid = true; break;
  }
  if (!valid) throw new Error('Invalid browser command');
  return value as BrowserCommand;
}
export function validateContentArea(value: unknown): ContentArea {
  const area = object(value);
  keys(area, ['top', 'hidden']);
  if (typeof area.top !== 'number' || !Number.isFinite(area.top) || area.top < 0 || area.top > 2048 || typeof area.hidden !== 'boolean') throw new Error('Invalid content area');
  return { top: area.top, hidden: area.hidden };
}
