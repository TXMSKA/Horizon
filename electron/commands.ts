import type { BrowserCommand, ContentArea, DesktopItem, DesktopPanelPage, Project } from '../src/shared/api';
import { isWebURL } from './browsing';
import { isContrast, isDarkPagesMode, isDarkStrength, isDarkTone, isTheme, isLanguageSetting, isSearchEngine, isHubApp } from './settings';
import { isContextMenuItemId } from './context-menu';
import { isProfileColor, isProfileId, profileName } from './profiles';
import { isPermissionDecision, isSitePermission, validHost } from './site-settings';
import { folderName, projectName, desktopInputText, desktopTitle } from './desktop';

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
const desktopCommands = new Set(['retry-desktop-storage', 'create-project', 'rename-project', 'delete-project', 'set-project', 'open-desktop', 'open-desktop-panel', 'close-desktop-panel', 'create-folder', 'rename-folder', 'delete-folder', 'move-item-folder', 'move-item-project', 'add-capture-to-project', 'delete-capture', 'add-link', 'add-text', 'add-note', 'update-item', 'delete-item', 'save-capture']);
export function validateCommand(value: unknown, profileIds?: ReadonlySet<string>, projects: readonly Project[] = [], captures: readonly DesktopItem[] = []): BrowserCommand {
  try { return validatedCommand(value, profileIds, projects, captures); }
  catch (error) {
    if (value && typeof value === 'object' && 'type' in value && desktopCommands.has(value.type as string)
      && !(error instanceof Error && /^(PROJECT_|FOLDER_|DESKTOP_|LINK_INVALID$|TEXT_INVALID$)/.test(error.message))) throw new Error('DESKTOP_COMMAND_INVALID');
    throw error;
  }
}
function validatedCommand(value: unknown, profileIds?: ReadonlySet<string>, projects: readonly Project[] = [], captures: readonly DesktopItem[] = []): BrowserCommand {
  const command = object(value);
  const type = command.type;
  const settingsCommands = ['open-settings', 'set-search-engine', 'set-language', 'set-ask-where-to-save', 'set-block-ads', 'set-block-third-party-cookies', 'choose-downloads-folder', 'reset-downloads-folder', 'set-clear-history-on-close', 'set-clear-cache-on-close', 'clear-browsing-data', 'reset-site', 'register-default-browser'];
  if (settingsCommands.includes(type as string)) {
    let allowed: string[] = ['type'];
    let valid = false;
    switch (type) {
      case 'open-settings': allowed.push('section'); valid = ['general', 'appearance', 'privacy', 'privacy/sites', 'profiles'].includes(command.section as string); break;
      case 'set-search-engine': allowed.push('value'); valid = isSearchEngine(command.value); break;
      case 'set-language': allowed.push('value'); valid = isLanguageSetting(command.value); break;
      case 'set-ask-where-to-save': case 'set-block-ads': case 'set-block-third-party-cookies': case 'set-clear-history-on-close': case 'set-clear-cache-on-close': allowed.push('value'); valid = typeof command.value === 'boolean'; break;
      case 'reset-site': allowed.push('host'); valid = validHost(command.host); break;
      case 'clear-browsing-data': allowed = ['type', 'history', 'cookies', 'cache']; valid = ['history', 'cookies', 'cache'].every(key => typeof command[key] === 'boolean') && (command.history === true || command.cookies === true || command.cache === true); break;
      default: valid = true;
    }
    if (!valid || Object.keys(command).length !== allowed.length || !allowed.every(key => Object.hasOwn(command, key))) throw new Error('SETTINGS_COMMAND_INVALID');
    return value as BrowserCommand;
  }
  let valid = false;
  const project = (id: unknown) => isProfileId(id) && projects.some(entry => entry.id === id);
  const item = (id: unknown, item: unknown) => isProfileId(item) && (id === null ? captures.some(entry => entry.id === item)
    : project(id) && projects.some(entry => entry.id === id && entry.items.some(entry => entry.id === item)));
  const folder = (id: unknown, folder: unknown) => folder === null || project(id) && isProfileId(folder) && projects.some(entry => entry.id === id && entry.folders.some(entry => entry.id === folder));
  const optionalFolder = () => !Object.hasOwn(command, 'folder') || folder(command.project, command.folder);
  const exact = (required: string[], optional: string[] = []) => {
    keys(command, ['type', ...required, ...optional]);
    return Object.hasOwn(command, 'type') && required.every(key => Object.hasOwn(command, key));
  };
  switch (type) {
    case 'pin-app': case 'unpin-app': keys(command, ['type', 'id']); valid = Object.keys(command).length === 2 && isHubApp(command.id); break;
    case 'retry-desktop-storage': keys(command, ['type']); valid = Object.keys(command).length === 1 && Object.hasOwn(command, 'type'); break;
    case 'create-project': case 'rename-project':
      keys(command, type === 'create-project' ? ['type', 'name'] : ['type', 'id', 'name']); projectName(command.name);
      valid = Object.keys(command).length === (type === 'create-project' ? 2 : 3) && (type === 'create-project' || project(command.id)); break;
    case 'delete-project': case 'set-project':
      keys(command, ['type', 'id']); valid = Object.keys(command).length === 2 && project(command.id); break;
    case 'open-desktop':
      keys(command, ['type', 'id', 'item']); valid = Object.hasOwn(command, 'id') && Object.keys(command).length === (Object.hasOwn(command, 'item') ? 3 : 2)
        && (project(command.id) || command.id === 'captures') && (!Object.hasOwn(command, 'item') || item(command.id === 'captures' ? null : command.id, command.item)); break;
    case 'open-desktop-panel':
      valid = exact(['page']) && !!validateDesktopPanelPage(command.page, projects, captures); break;
    case 'close-desktop-panel': valid = exact([]); break;
    case 'create-folder': case 'rename-folder':
      folderName(command.name);
      valid = exact(type === 'create-folder' ? ['project', 'name'] : ['project', 'id', 'name']) && project(command.project)
        && (type === 'create-folder' || command.id !== null && folder(command.project, command.id)); break;
    case 'delete-folder': valid = exact(['project', 'id']) && project(command.project) && command.id !== null && folder(command.project, command.id); break;
    case 'move-item-folder': valid = exact(['project', 'id', 'folder']) && project(command.project) && item(command.project, command.id) && folder(command.project, command.folder); break;
    case 'move-item-project': valid = exact(['project', 'id', 'toProject', 'folder']) && project(command.project) && item(command.project, command.id) && project(command.toProject) && folder(command.toProject, command.folder); break;
    case 'add-capture-to-project': valid = exact(['id', 'project', 'folder']) && item(null, command.id) && project(command.project) && folder(command.project, command.folder); break;
    case 'delete-capture': valid = exact(['id']) && item(null, command.id); break;
    case 'add-link':
      valid = exact(['address', 'title', 'project', 'folder']) && project(command.project) && folder(command.project, command.folder);
      if (!isWebURL(command.address) || !desktopTitle(command.title)) throw new Error('LINK_INVALID'); break;
    case 'add-text': {
      valid = exact(['text', 'source', 'project', 'folder']) && project(command.project) && folder(command.project, command.folder);
      if (!desktopInputText(command.text, 100000)) throw new Error('TEXT_INVALID');
      if (command.source !== null) {
        const source = object(command.source); keys(source, ['url', 'title']);
        if (Object.keys(source).length !== 2 || !isWebURL(source.url) || !desktopTitle(source.title)) throw new Error('TEXT_INVALID');
      }
      break;
    }
    case 'add-note':
      valid = exact(['project', 'title', 'text'], ['folder']) && project(command.project) && optionalFolder()
        && desktopTitle(command.title) && desktopInputText(command.text, 100000); break;
    case 'update-item':
      keys(command, ['type', 'project', 'id', 'title', 'text', 'note']);
      valid = Object.hasOwn(command, 'project') && Object.hasOwn(command, 'id') && item(command.project, command.id) && ['title', 'text', 'note'].some(key => Object.hasOwn(command, key))
        && (!Object.hasOwn(command, 'title') || desktopTitle(command.title))
        && (!Object.hasOwn(command, 'text') || desktopInputText(command.text, 100000))
        && (!Object.hasOwn(command, 'note') || desktopInputText(command.note, 20000)); break;
    case 'delete-item':
      keys(command, ['type', 'project', 'id']); valid = Object.keys(command).length === 3 && project(command.project) && item(command.project, command.id); break;
    case 'save-capture': {
      valid = exact(command.kind === 'area' ? ['project', 'kind', 'rect'] : ['project', 'kind'], ['folder'])
        && (project(command.project) || command.project === null && command.kind !== 'text') && optionalFolder()
        && (command.kind === 'text' || command.kind === 'page' || command.kind === 'area');
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
    case 'activate-tab': case 'close-tab': case 'cancel-download': case 'show-download': case 'remove-download': case 'retry-download':
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
      keys(command, ['type', 'kind']); valid = command.kind === 'history' || command.kind === 'bookmarks' || command.kind === 'downloads' || command.kind === 'desktop'; break;
    case 'back': case 'forward': case 'reload': case 'stop': case 'bookmark': case 'focus-page': case 'stop-find': case 'clear-history': case 'open-downloads-folder': case 'fullscreen':
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

export function validateDesktopPanelPage(value: unknown, projects: readonly Project[], captures: readonly DesktopItem[]): DesktopPanelPage {
  const page = object(value);
  if (!Object.hasOwn(page, 'kind')) throw new Error('DESKTOP_COMMAND_INVALID');
  let valid = false;
  if (page.kind === 'home' || page.kind === 'captures' || page.kind === 'new-project') valid = Object.keys(page).length === 1;
  else if (page.kind === 'project') {
    keys(page, ['kind', 'project', 'folder']);
    const project = projects.find(project => project.id === page.project);
    valid = !!project && Object.hasOwn(page, 'project') && (!Object.hasOwn(page, 'folder') || page.folder === null || isProfileId(page.folder) && project.folders.some(folder => folder.id === page.folder));
  } else if (page.kind === 'item') {
    keys(page, ['kind', 'project', 'id']);
    valid = Object.keys(page).length === 3 && isProfileId(page.id) && (page.project === null ? captures : projects.find(project => project.id === page.project)?.items)?.some(item => item.id === page.id) === true;
  }
  if (!valid) throw new Error('DESKTOP_COMMAND_INVALID');
  return value as DesktopPanelPage;
}
