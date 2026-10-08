import type { BrowserCommand } from '../src/shared/api';

const favoriteWrites = new Set(['bookmark', 'add-favorite', 'create-favorite-folder', 'rename-favorite', 'move-favorite', 'delete-favorite', 'rename-bookmark', 'delete-bookmark']);
const desktopWrites = new Set(['retry-desktop-storage', 'create-project', 'rename-project', 'delete-project', 'set-project', 'create-folder', 'rename-folder', 'delete-folder', 'move-item-folder', 'move-item-project', 'add-capture-to-project', 'add-link', 'add-text', 'add-note', 'update-item', 'delete-item']);

export function assertPrivateCommand(command: BrowserCommand): void {
  if (command.type.includes('extension') || command.type === 'open-settings' && command.section === 'extensions') throw new Error('EXTENSIONS_UNAVAILABLE');
  if (command.type.startsWith('translate-')) throw new Error('TRANSLATE_PRIVATE');
  if (command.type.startsWith('lyra-')) throw new Error('LYRA_PRIVATE');
  if (favoriteWrites.has(command.type) || command.type === 'restore' && command.kind === 'bookmarks') throw new Error('Private window favorites are read-only');
  if (command.type === 'import-browser-data' || command.type === 'choose-import-passwords-file' || command.type === 'import-passwords' || command.type === 'delete-import-passwords-file') throw new Error('Private window import is unavailable');
  if (desktopWrites.has(command.type) || command.type === 'restore' && command.kind === 'desktop'
    || command.type === 'context-menu' && command.item === 'add-to-desktop'
    || command.type === 'open-desktop' || command.type === 'open-desktop-panel') throw new Error('Private window Desktop is unavailable');
}
