import { useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { FileText, FolderOpen, RotateCw, Search, Trash2, X } from 'lucide-react';
import { text } from './copy';
import type { CopyKey } from './copy';
import { PROFILE_COLORS } from './shared/api';
import type { BrowserCommand, BrowserState, HistoryEntry, Language } from './shared/api';
import { EmptyDownloads, EmptyHistory, NoResults } from './EmptyState';
import { ToolbarPopover } from './ToolbarPopover';
import { RemoteTabs } from './RemoteTabs';

export type LibraryPanel = 'history' | 'bookmarks' | 'downloads';

export function historyDays(entries: HistoryEntry[], language: Language, now = new Date()) {
  const today = new Date(now); today.setHours(0, 0, 0, 0);
  const yesterday = new Date(today); yesterday.setDate(yesterday.getDate() - 1);
  const groups = new Map<string, { label: string; entries: HistoryEntry[] }>();
  for (const entry of [...entries].sort((a, b) => b.lastVisit - a.lastVisit)) {
    const date = new Date(entry.lastVisit), key = `${date.getFullYear()}-${date.getMonth()}-${date.getDate()}`;
    const label = date >= today ? text('today', language) : date >= yesterday ? text('yesterday', language) : date.toLocaleDateString(language);
    const group = groups.get(key) ?? { label, entries: [] }; group.entries.push(entry); groups.set(key, group);
  }
  return [...groups.values()];
}

export function downloadSize(bytes: number, language: Language): string {
  const index = bytes >= 1024 ** 3 ? 3 : bytes >= 1024 ** 2 ? 2 : bytes >= 1024 ? 1 : 0;
  return text('downloadSize', language).replace('{size}', new Intl.NumberFormat(language, { maximumFractionDigits: index ? 1 : 0 }).format(bytes / 1024 ** index)).replace('{unit}', ['B', 'KB', 'MB', 'GB'][index]!);
}

function SiteBadge({ url, title, state, favicons }: {
  url: string; title: string; state: BrowserState; favicons: Record<string, { hash: string; url: string }>;
}) {
  const host = new URL(url).host;
  const tab = state.tabs.find(tab => tab.url === url && tab.favicon && favicons[tab.id]?.hash === tab.favicon);
  const color = PROFILE_COLORS[[...host].reduce((sum, character) => sum + character.charCodeAt(0), 0) % PROFILE_COLORS.length];
  const image = tab ? favicons[tab.id]?.url : undefined, [failedImage, setFailedImage] = useState('');
  return <span className="browser-site-badge" data-profile-color={color} aria-hidden="true">{image && failedImage !== image ? <img src={image} alt="" onError={() => setFailedImage(image)} /> : (title || host).slice(0, 1).toUpperCase()}</span>;
}

type BrowserPanelProps = {
  panel: LibraryPanel; state: BrowserState; language: Language; opener: RefObject<HTMLButtonElement | null>;
  favicons: Record<string, { hash: string; url: string }>; undo: { kind: LibraryPanel; message: CopyKey } | null;
  onRestore: () => void; onDelete: (command: BrowserCommand, kind: LibraryPanel, message: CopyKey) => Promise<void>;
  run: (command: BrowserCommand) => Promise<boolean>; onNavigate: (url: string) => void; onBrowse: () => void;
  onClear: () => void; onDismiss: (focus: boolean) => void; onAnnounce: (message: string) => void;
};

export function BrowserPanel({ panel, state, language, opener, favicons, undo, onRestore, onDelete, run, onNavigate, onBrowse, onClear, onDismiss, onAnnounce }: BrowserPanelProps) {
  const t = (key: CopyKey) => text(key, language), id = useId();
  const ref = useRef<HTMLElement>(null), search = useRef<HTMLInputElement>(null), busy = useRef(false);
  const restoreFocus = useRef<HTMLElement | null>(null);
  const removedFocus = useRef<{ row: HTMLElement; focused: HTMLElement; neighbours: HTMLElement[]; control: string } | null>(null);
  const undoButton = useRef<HTMLButtonElement>(null), wasEmpty = useRef(false);
  const [filter, setFilter] = useState('');
  const [pending, setPending] = useState(false), [failed, setFailed] = useState<BrowserCommand | null>(null);
  const entries = state.store.history;
  const filtered = entries.filter(item => `${item.title} ${item.url}`.toLocaleLowerCase(language).includes(filter.toLocaleLowerCase(language)));
  const noResults = panel !== 'downloads' && Boolean(filter) && !filtered.length;
  useEffect(() => {
    if (noResults && !wasEmpty.current) onAnnounce(text('noResultsTitle', language));
    else if (!noResults && wasEmpty.current) onAnnounce('');
    wasEmpty.current = noResults;
  }, [noResults, language, onAnnounce]);
  useEffect(() => () => {
    // Reopening the panel must be able to announce the same empty result again.
    if (wasEmpty.current) onAnnounce('');
  }, [onAnnounce]);
  useEffect(() => {
    const removed = removedFocus.current;
    if (!removed || removed.row.isConnected) return;
    // An asynchronous deletion must not take focus back after the user has moved it.
    if (document.activeElement !== document.body && document.activeElement !== removed.focused) { removedFocus.current = null; return; }
    const target = removed.neighbours.filter(row => row.isConnected).map(row => row.querySelector<HTMLElement>(`[data-row-control="${removed.control}"]`)).find(control => control) ?? undoButton.current;
    if (target) { removedFocus.current = null; target.focus(); }
  });
  const remove = (button: HTMLButtonElement, command: BrowserCommand, message: CopyKey) => {
    const row = button.closest<HTMLElement>('[data-library-row]'), focused = document.activeElement as HTMLElement | null;
    if (row && focused && row.contains(focused)) {
      const rows = [...(ref.current?.querySelectorAll<HTMLElement>('[data-library-row]') ?? [])], index = rows.indexOf(row);
      removedFocus.current = { row, focused, neighbours: [...rows.slice(index + 1), ...rows.slice(0, index).reverse()], control: focused.dataset.rowControl ?? 'delete' };
    }
    void onDelete(command, panel, message);
  };
  const action = async (command: BrowserCommand) => {
    if (busy.current) return false;
    const focused = document.activeElement as HTMLElement | null;
    restoreFocus.current = focused && ref.current?.contains(focused) ? focused : null;
    busy.current = true; setPending(true); setFailed(null);
    try { const success = await run(command); if (!success) setFailed(command); return success; }
    finally { busy.current = false; setPending(false); }
  };
  useEffect(() => {
    (search.current ?? ref.current?.querySelector<HTMLButtonElement>('button'))?.focus();
  }, [panel]);
  useEffect(() => {
    if (!pending && restoreFocus.current) {
      const target = restoreFocus.current; restoreFocus.current = null;
      if (target.isConnected && (document.activeElement === document.body || document.activeElement === target)) target.focus();
    }
  }, [pending]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !opener.current?.contains(target)) onDismiss(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [opener, onDismiss]);
  const open = (url: string, background: boolean) => { if (background) void action({ type: 'new-tab', input: url, background: true }); else onNavigate(url); };
  const row = (item: HistoryEntry) => <li className="browser-library-row history-row" key={item.url} data-library-row>
    <a data-row-control="link" className="browser-library-link" href={item.url} title={item.title || item.url} onClick={event => { event.preventDefault(); open(item.url, event.ctrlKey); }} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); open(item.url, true); } }}>
      <SiteBadge url={item.url} title={item.title} state={state} favicons={favicons} /><span className="browser-entry-copy"><span>{item.title || item.url}</span>{'lastVisit' in item && <small>{new URL(item.url).host}</small>}</span>
      {'lastVisit' in item && <time dateTime={new Date(item.lastVisit).toISOString()}>{new Date(item.lastVisit).toLocaleTimeString(language, { hour: '2-digit', minute: '2-digit' })}</time>}
    </a>
    <div className="browser-row-actions"><button className="icon-button" type="button" aria-label={t('deleteItem').replace('{title}', item.title || item.url)} title={t('delete')} data-row-control="delete" onClick={event => remove(event.currentTarget, { type: 'delete-history', url: item.url }, 'entryDeleted')}><Trash2 aria-hidden="true" /></button></div>
  </li>;
  const empty = <ul className="browser-library-list">{filter ? <NoResults language={language} onAction={() => { setFilter(''); search.current?.focus(); }} /> : <EmptyHistory language={language} privateWindow={state.privateWindow} onAction={onBrowse} />}</ul>;
  return <ToolbarPopover opener={opener}><section className="browser-library-panel" id="browser-library-panel" ref={ref} role="dialog" aria-labelledby={`${id}-title`} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDismiss(true); return; }
    if ((event.target as HTMLElement).closest('.rename-form')) return;
    const links = [...(ref.current?.querySelectorAll<HTMLAnchorElement>('.browser-library-link') ?? [])];
    const index = links.indexOf(document.activeElement as HTMLAnchorElement);
    if (event.key === 'ArrowDown' || event.key === 'ArrowUp') {
      if (!links.length) return;
      event.preventDefault(); links[index < 0 ? event.key === 'ArrowDown' ? 0 : links.length - 1 : (index + (event.key === 'ArrowDown' ? 1 : links.length - 1)) % links.length]?.focus();
    }
    if (event.key === 'Tab') {
      const targets = [...(ref.current?.querySelectorAll<HTMLElement>('a, button:not(:disabled), input') ?? [])];
      if (document.activeElement === (event.shiftKey ? targets[0] : targets.at(-1))) onDismiss(true);
    }
  }}><div className="browser-panel-title"><h2 id={`${id}-title`}>{t(panel === 'bookmarks' ? 'favorites' : panel)}</h2>{panel === 'downloads' && <button className="icon-button" type="button" aria-label={t('openDownloadsFolder')} title={t('openDownloadsFolder')} disabled={pending} onClick={() => { void action({ type: 'open-downloads-folder' }); }}><FolderOpen aria-hidden="true" /></button>}</div>
    {panel !== 'downloads' && !state.privateWindow && <div className="search-field browser-panel-search"><Search aria-hidden="true" /><input ref={search} aria-label={t(panel === 'history' ? 'filterHistory' : 'filterBookmarks')} placeholder={t(panel === 'history' ? 'filterHistory' : 'filterBookmarks')} value={filter} onChange={event => setFilter(event.target.value)} /></div>}
    {failed && <div className="browser-panel-error" role="alert"><span>{t('browserError')}</span><button className="settings-button quiet" type="button" disabled={pending} onClick={() => { void action(failed); }}>{t('retry')}</button></div>}
    {(state.storageReadError || state.storageError) && <p className="browser-panel-error" role="alert">{t(state.storageReadError ? 'storageReadError' : 'storageError')}</p>}
    {undo?.kind === panel && <div className="undo-bar" role="status"><span>{t(undo.message)}</span><button className="settings-button quiet" type="button" ref={undoButton} onClick={onRestore}>{t('undo')}</button></div>}
    {panel === 'downloads' ? <ul className="browser-download-list">{!state.store.downloads.length && <EmptyDownloads language={language} privateWindow={state.privateWindow} onAction={() => { void action({ type: 'open-downloads-folder' }); }} />}{state.store.downloads.map(download => <li className="browser-download" key={download.id} data-library-row>
      <FileText aria-hidden="true" /><div className="browser-download-copy"><strong title={download.filename}>{download.filename}</strong><p role="status">{t('downloadStateSize').replace('{state}', `${t(download.status === 'completed' ? 'downloadDone' : download.status)}${download.status === 'progressing' && download.total > 0 ? ` · ${Math.round(download.received / download.total * 100)} %` : ''}`).replace('{size}', downloadSize(download.status === 'progressing' ? download.received : download.total || download.received, language))}</p>
        {download.status === 'progressing' && <progress max={download.total || undefined} value={download.total ? download.received : undefined} aria-label={`${t('progressing')}: ${download.filename}`} />}
        <div className="browser-download-actions">{download.status === 'progressing' && <button type="button" disabled={pending} onClick={() => { void action({ type: 'cancel-download', id: download.id }); }}><X aria-hidden="true" />{t('cancel')}</button>}
          {download.status === 'completed' && <button type="button" disabled={pending} onClick={() => { void action({ type: 'show-download', id: download.id }); }}><FolderOpen aria-hidden="true" />{t('showFolder')}</button>}
          {download.status === 'failed' && <button type="button" disabled={pending} onClick={() => { void action({ type: 'retry-download', id: download.id }); }}><RotateCw aria-hidden="true" />{t('downloadRetry')}</button>}
          {download.status !== 'progressing' && <button type="button" disabled={pending} data-row-control="delete" onClick={event => remove(event.currentTarget, { type: 'remove-download', id: download.id }, 'downloadRemoved')}><Trash2 aria-hidden="true" />{t('downloadRemove')}</button>}
        </div></div>
    </li>)}</ul> : !filtered.length ? empty : panel === 'history' ? <div className="browser-history-days">{historyDays(filtered as HistoryEntry[], language).map(group => <section className="browser-history-day" key={group.label}><h3>{group.label}</h3><ul className="browser-library-list">{group.entries.map(row)}</ul></section>)}</div> : <ul className="browser-library-list">{filtered.map(row)}</ul>}
    {panel === 'history' && <><RemoteTabs state={state} language={language} onAnnounce={onAnnounce} renderSiteBadge={(url, title) => <SiteBadge url={url} title={title} state={state} favicons={favicons} />} /><hr /><button className="browser-panel-foot" type="button" onClick={onClear}><span><Trash2 aria-hidden="true" /></span>{t('clearBrowsingData')}</button></>}
  </section></ToolbarPopover>;
}
