import type { BrowserCommand, ContentArea } from '../src/shared/api';
import { isWebURL } from './browsing';
import { isContrast, isTheme } from './settings';
import { isContextMenuItemId } from './context-menu';
import { isProfileColor, isProfileId, profileName } from './profiles';

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
export function validateCommand(value: unknown, profileIds?: ReadonlySet<string>): BrowserCommand {
  const command = object(value);
  const type = command.type;
  let valid = false;
  switch (type) {
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
      keys(command, ['type', 'kind']); valid = command.kind === 'history' || command.kind === 'bookmarks' || command.kind === 'downloads'; break;
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
