import type { RefObject } from 'react';
import { Download, History, Info, Maximize, Minus, Plus, Search, Settings2, Star, ZoomIn } from 'lucide-react';
import { text } from './copy';
import type { CopyKey } from './copy';
import type { BrowserCommand, BrowserShortcut, Language, TabState } from './shared/api';
import type { LibraryPanel } from './BrowserPanel';
import { Menu } from './Menu';
import { ToolbarPopover } from './ToolbarPopover';

export function BrowserMenu({ language, active, keyboard, opener, onDismiss, onShortcut, onPanel, onSettings, onAbout, run }: {
  language: Language; active: TabState | undefined; keyboard: boolean; opener: RefObject<HTMLButtonElement | null>;
  onDismiss: (focus: boolean) => void; onShortcut: (shortcut: BrowserShortcut) => void; onPanel: (panel: LibraryPanel) => void;
  onSettings: () => void; onAbout: () => void; run: (command: BrowserCommand) => Promise<boolean>;
}) {
  const t = (key: CopyKey) => text(key, language);
  const page = Boolean(active?.url && !active.notebook && !active.settings && !active.error);
  return <ToolbarPopover opener={opener}><Menu id="browser-menu" className="browser-tools-menu" label={t('menu')} keyboard={keyboard} opener={opener} onDismiss={reason => onDismiss(reason === 'escape')}>
    <button type="button" role="menuitem" tabIndex={-1} onClick={() => onShortcut('new-tab')}><Plus aria-hidden="true" /><span>{t('newTab')}</span><kbd>Ctrl+T</kbd></button>
    <hr />
    <div className="browser-menu-zoom" role="group" aria-label={t('zoom')}><ZoomIn aria-hidden="true" /><span>{t('zoom')}</span><div>
      <button type="button" role="menuitem" tabIndex={-1} aria-label={t('zoomOut')} title={t('zoomOut')} disabled={!page || (active?.zoom ?? 1) <= 0.25} onClick={() => { void run({ type: 'zoom', delta: -1 }); }}><Minus aria-hidden="true" /></button>
      <span aria-live="polite">{Math.round((active?.zoom ?? 1) * 100)} %</span>
      <button type="button" role="menuitem" tabIndex={-1} aria-label={t('zoomIn')} title={t('zoomIn')} disabled={!page || (active?.zoom ?? 1) >= 3} onClick={() => { void run({ type: 'zoom', delta: 1 }); }}><Plus aria-hidden="true" /></button>
      <button type="button" role="menuitem" tabIndex={-1} aria-label={t('fullscreen')} title={`${t('fullscreen')} (F11)`} onClick={() => onShortcut('fullscreen')}><Maximize aria-hidden="true" /></button>
    </div></div>
    <button type="button" role="menuitem" tabIndex={-1} disabled={!page} onClick={() => onShortcut('find')}><Search aria-hidden="true" /><span>{t('find')}</span><kbd>Ctrl+F</kbd></button>
    <hr />
    <button type="button" role="menuitem" tabIndex={-1} onClick={() => onPanel('bookmarks')}><Star aria-hidden="true" /><span>{t('favorites')}</span><kbd>Ctrl+Shift+O</kbd></button>
    <button type="button" role="menuitem" tabIndex={-1} onClick={() => onPanel('history')}><History aria-hidden="true" /><span>{t('history')}</span><kbd>Ctrl+H</kbd></button>
    <button type="button" role="menuitem" tabIndex={-1} onClick={() => onPanel('downloads')}><Download aria-hidden="true" /><span>{t('downloads')}</span><kbd>Ctrl+J</kbd></button>
    <hr />
    <button type="button" role="menuitem" tabIndex={-1} onClick={onSettings}><Settings2 aria-hidden="true" /><span>{t('settings')}</span></button>
    <button type="button" role="menuitem" tabIndex={-1} onClick={onAbout}><Info aria-hidden="true" /><span>{t('aboutHorizon')}</span></button>
  </Menu></ToolbarPopover>;
}
