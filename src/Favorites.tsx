import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, MouseEvent, RefObject } from 'react';
import { ChevronDown, ChevronRight, ChevronsRight, ExternalLink, Folder, FolderOpen, FolderPlus, FolderInput, Pencil, Search, Trash2 } from 'lucide-react';
import { PROFILE_COLORS } from './shared/api';
import type { BrowserCommand, BrowserState, FavoriteItem, FavoritesTree, Language } from './shared/api';
import { allFavoriteLinks, canMoveFavorite, favoriteChildren, favoriteLinks, favoriteLocation, favoritesOverflow, filterFavorites } from './shared/favorites';
import { copy, text } from './copy';
import type { CopyKey } from './copy';
import { Menu } from './Menu';
import { PopupAnchor } from './PopupAnchor';
import { ToolbarPopover } from './ToolbarPopover';

const FAVORITE_DRAG = 'application/x-horizon-favorite';
let dragging: { profile: string; id: string } | null = null;
const drafts = new Map<string, string>();
type Root = 'bar' | 'other';
type FolderTarget = { id: string; name: string; children: FavoriteItem[] };
type ActionProps = {
  state: BrowserState; language: Language; run: (command: BrowserCommand) => Promise<boolean>;
  onDelete: (command: BrowserCommand, kind: 'bookmarks', message: CopyKey) => Promise<void>;
};

export function favoritesError(reason: unknown, language: Language): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  const key = Object.keys(copy).find(key => key.startsWith('FAVORITE') && message.includes(key)) as CopyKey | undefined;
  return text(key ?? 'browserError', language);
}

function useFavoriteFavicons(state: BrowserState, items: FavoriteItem[]) {
  const origins = JSON.stringify([...new Set(items.filter(item => item.kind === 'link').map(item => new URL(item.url).origin))].sort());
  const binding = JSON.stringify([state.activeProfileId, state.favoriteFaviconVersion, state.privateWindow, origins]);
  const [cached, setCached] = useState<{ binding: string; icons: Record<string, string> } | null>(null);
  useEffect(() => {
    if (state.privateWindow) return;
    let cancelled = false;
    const urls: string[] = [];
    const revoke = () => { for (const url of urls.splice(0)) URL.revokeObjectURL(url); };
    const load = async () => {
      const requested = JSON.parse(origins) as string[], icons: Record<string, string> = {};
      for (let index = 0; index < requested.length; index += 200) {
        if (cancelled) return;
        const batch = requested.slice(index, index + 200);
        const result = await window.horizon.getFavoriteFavicons(batch);
        if (cancelled) return;
        for (const origin of batch) {
          const data = result[origin];
          if (typeof data !== 'string' || data.length > Math.ceil(16 * 1024 / 3) * 4 + 22) continue;
          const encoded = /^data:image\/png;base64,([A-Za-z0-9+/]+={0,2})$/.exec(data);
          if (!encoded) continue;
          try {
            const decoded = atob(encoded[1]!);
            if (decoded.length > 16 * 1024) continue;
            const bytes = Uint8Array.from(decoded, character => character.charCodeAt(0));
            const url = URL.createObjectURL(new Blob([bytes], { type: 'image/png' }));
            urls.push(url); icons[origin] = url;
          } catch { /* A malformed local icon keeps its initial badge. */ }
        }
      }
      if (!cancelled) setCached({ binding, icons });
    };
    void load().catch(revoke);
    return () => { cancelled = true; revoke(); };
  }, [binding, origins, state.privateWindow]);
  return !state.privateWindow && cached?.binding === binding ? cached.icons : {};
}

function FavoriteBadge({ item, icons = {} }: { item: FavoriteItem; icons?: Record<string, string> }) {
  const [failed, setFailed] = useState<string | null>(null);
  if (item.kind === 'folder') return <Folder aria-hidden="true" />;
  const { hostname: host, origin } = new URL(item.url), icon = icons[origin];
  if (icon && failed !== icon) return <img className="favorite-badge favorite-favicon" src={icon} alt="" aria-hidden="true" onError={() => setFailed(icon)} />;
  const color = PROFILE_COLORS[[...host].reduce((sum, character) => sum + character.charCodeAt(0), 0) % PROFILE_COLORS.length];
  return <span className="favorite-badge" data-profile-color={color} aria-hidden="true">{host.slice(0, 1).toUpperCase()}</span>;
}

const itemName = (item: FavoriteItem) => item.kind === 'folder' ? item.name : item.title || item.url;
const rootName = (root: Root, language: Language) => text(root === 'bar' ? 'favoritesBar' : 'otherFavorites', language);

function nameError(value: string, link: boolean): CopyKey | null {
  const name = link ? value : value.trim();
  if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return link ? 'FAVORITE_TITLE_INVALID' : 'FAVORITE_NAME_INVALID';
  if (!link && !name) return 'FAVORITE_NAME_EMPTY';
  if (name.length > (link ? 200 : 80)) return link ? 'FAVORITE_TITLE_INVALID' : 'FAVORITE_NAME_LONG';
  return null;
}

function useFavoriteActions({ state, language, run, onDelete }: ActionProps, close: () => void) {
  const [context, setContext] = useState<{ item: FavoriteItem; opener: RefObject<HTMLElement | null>; point: { x: number; y: number }; keyboard: boolean } | null>(null);
  const [form, setForm] = useState<{ kind: 'rename' | 'new' | 'move'; item?: FavoriteItem; parent: string; opener: RefObject<HTMLElement | null> } | null>(null);
  const [value, setValue] = useState(''), [error, setError] = useState(''), [pending, setPending] = useState(false);
  const busy = useRef(false), field = useRef<HTMLInputElement>(null), id = useId();
  const draftKey = (kind: 'rename' | 'new' | 'move', parent: string, item?: FavoriteItem) => JSON.stringify([state.activeProfileId, kind, kind === 'rename' ? item?.id : parent]);
  const t = (key: CopyKey) => text(key, language);
  const showMenu = (event: MouseEvent<HTMLElement> | KeyboardEvent<HTMLElement>, item: FavoriteItem) => {
    event.preventDefault(); event.stopPropagation();
    if (busy.current) return;
    if (state.privateWindow && item.kind === 'folder' && !favoriteLinks(item.children).length) return;
    const opener = { current: event.currentTarget }, rect = event.currentTarget.getBoundingClientRect();
    const keyboard = 'key' in event;
    setContext({ item, opener, keyboard, point: keyboard ? { x: rect.left, y: rect.bottom } : { x: event.clientX, y: event.clientY } });
  };
  const menuKey = (event: KeyboardEvent<HTMLElement>, item: FavoriteItem) => {
    if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) showMenu(event, item);
  };
  const openForm = (kind: 'rename' | 'new' | 'move', opener: RefObject<HTMLElement | null>, parent: string, item?: FavoriteItem) => {
    if (busy.current) return;
    setContext(null); setForm({ kind, opener, parent, item }); setValue(drafts.get(draftKey(kind, parent, item)) ?? (kind === 'rename' && item ? itemName(item) : '')); setError('');
  };
  const cancel = () => { const opener = form?.opener; if (form) drafts.delete(draftKey(form.kind, form.parent, form.item)); setForm(null); opener?.current?.focus(); };
  const perform = async (command: BrowserCommand) => {
    if (busy.current) return false;
    busy.current = true; setPending(true); setError('');
    try { await window.horizon.command(command); return true; }
    catch (reason) { setError(favoritesError(reason, language)); return false; }
    finally { busy.current = false; setPending(false); }
  };
  const destinations = (tree: FavoritesTree) => {
    const rows: { id: string; label: string; children: FavoriteItem[] }[] = [];
    const visit = (items: FavoriteItem[], path: string) => {
      for (const item of items) if (item.kind === 'folder') {
        const label = `${path} / ${item.name}`;
        rows.push({ id: item.id, label, children: item.children }); visit(item.children, label);
      }
    };
    for (const root of ['bar', 'other'] as const) { rows.push({ id: root, label: rootName(root, language), children: tree[root] }); visit(tree[root], rootName(root, language)); }
    return rows;
  };
  const rootContext = context?.item.id === 'bar' || context?.item.id === 'other';
  const overlays = <>{context && <div className="favorites-surface"><Menu id={`${id}-menu`} className="favorite-item-menu" label={t('favoriteActions').replace('{name}', itemName(context.item))} keyboard={context.keyboard} point={context.point} opener={context.opener} onDismiss={reason => { if (reason === 'escape') context.opener.current?.focus(); setContext(null); }}>
    <button type="button" role="menuitem" tabIndex={-1} disabled={context.item.kind === 'folder' && !favoriteLinks(context.item.children).length} onClick={() => { void run({ type: context.item.kind === 'link' ? 'open-favorite-new-tab' : 'open-all-favorites', id: context.item.id }); setContext(null); close(); }}><ExternalLink aria-hidden="true" /><span>{t(context.item.kind === 'link' ? 'openFavoriteNewTab' : 'openAllFavorites').replace('{count}', String(context.item.kind === 'folder' ? favoriteLinks(context.item.children).length : 1))}</span></button>
    {!state.privateWindow && <><hr role="separator" />
    {!rootContext && <><button type="button" role="menuitem" tabIndex={-1} onClick={() => openForm('rename', context.opener, favoriteLocation(state.store.favorites, context.item.id)!.parent, context.item)}><Pencil aria-hidden="true" /><span>{t('rename')}</span></button>
    <button type="button" role="menuitem" tabIndex={-1} onClick={() => openForm('move', context.opener, favoriteLocation(state.store.favorites, context.item.id)!.parent, context.item)}><FolderInput aria-hidden="true" /><span>{t('moveFavorite')}</span></button></>}
    <button type="button" role="menuitem" tabIndex={-1} onClick={() => openForm('new', context.opener, context.item.kind === 'folder' ? context.item.id : favoriteLocation(state.store.favorites, context.item.id)!.parent)}><FolderPlus aria-hidden="true" /><span>{t('newFolder')}</span></button>
    {!rootContext && <><hr role="separator" />
    <button type="button" role="menuitem" tabIndex={-1} onClick={() => { const opener = context.opener; setContext(null); void onDelete({ type: 'delete-favorite', id: context.item.id }, 'bookmarks', 'favoriteDeleted').then(() => { if (opener.current?.isConnected) opener.current.focus(); else document.querySelector<HTMLElement>('[data-favorite-undo], .favorites-bar button, .favorites-tree button')?.focus(); }); }}><Trash2 aria-hidden="true" /><span>{t('delete')}</span></button></>}
    </>}
  </Menu></div>}
  {form && <PopupAnchor opener={form.opener} align="start"><div className="favorites-surface"><section className="favorite-form new-profile-popover" role="dialog" aria-labelledby={`${id}-form-title`} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); cancel(); }
    if (event.key === 'Tab') { const targets = [...event.currentTarget.querySelectorAll<HTMLElement>('input, button:not(:disabled)')]; if (document.activeElement === (event.shiftKey ? targets[0] : targets.at(-1))) { event.preventDefault(); (event.shiftKey ? targets.at(-1) : targets[0])?.focus(); } }
  }}><h2 id={`${id}-form-title`}>{t(form.kind === 'rename' ? 'rename' : form.kind === 'move' ? 'moveFavorite' : 'newFolder')}</h2>
    {form.kind === 'move' ? <div className="favorite-destinations" role="group" aria-label={t('chooseFavoriteFolder')}>{destinations(state.store.favorites).map(destination => <button autoFocus={destination.id === 'bar'} type="button" key={destination.id} disabled={pending || !canMoveFavorite(state.store.favorites, form.item!.id, destination.id)} onClick={() => { const position = destination.children.length; void perform({ type: 'move-favorite', id: form.item!.id, parent: destination.id, position }).then(success => { if (success) cancel(); }); }}><Folder aria-hidden="true" /><span>{destination.label}</span></button>)}</div> : <form className="profile-form" onSubmit={event => {
      event.preventDefault();
      const link = form.item?.kind === 'link', name = link ? value : value.trim(), invalid = nameError(value, link);
      if (invalid) { setError(t(invalid)); field.current?.focus(); return; }
      const command: BrowserCommand = form.kind === 'rename' ? { type: 'rename-favorite', id: form.item!.id, name } : { type: 'create-favorite-folder', parent: form.parent, name, position: favoriteChildren(state.store.favorites, form.parent)?.length ?? 0 };
      void perform(command).then(success => { if (success) cancel(); });
    }}><label htmlFor={`${id}-name`}>{t(form.item?.kind === 'link' ? 'bookmarkName' : 'folderName')}</label><input ref={field} id={`${id}-name`} autoFocus value={value} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} onChange={event => { const next = event.target.value; setValue(next); drafts.set(draftKey(form.kind, form.parent, form.item), next); if (!nameError(next, form.item?.kind === 'link')) setError(''); }} /><div className="profile-form-actions"><button className="profile-action quiet" type="button" disabled={pending} onClick={cancel}>{t('cancel')}</button><button className="profile-action primary" type="submit" disabled={pending}>{t('save')}</button></div></form>}
    {error && <p className="profile-field-error" role="alert" id={`${id}-error`}>{error}</p>}
    {form.kind === 'move' && <button className="profile-action quiet" type="button" disabled={pending} onClick={cancel}>{t('cancel')}</button>}
  </section></div></PopupAnchor>}</>;
  const clear = () => { setContext(null); setForm(null); };
  return { showMenu, menuKey, openForm, overlays, clear, hasOverlay: Boolean(context || form) };
}

function useFavoriteDrag(state: BrowserState, run: ActionProps['run']) {
  const [mark, setMark] = useState<{ target: string; edge: 'before' | 'after' | 'inside'; parent: string; position: number } | null>(null);
  useEffect(() => {
    const clear = () => { setMark(null); dragging = null; };
    document.addEventListener('dragend', clear); document.addEventListener('drop', clear);
    return () => { document.removeEventListener('dragend', clear); document.removeEventListener('drop', clear); };
  }, []);
  const start = (event: DragEvent<HTMLElement>, id: string) => {
    dragging = { profile: state.activeProfileId, id }; event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData(FAVORITE_DRAG, JSON.stringify(dragging));
  };
  const over = (event: DragEvent<HTMLElement>, target: string, parent: string, position: number, folder = false, horizontal = false, inside = false) => {
    if (!dragging || dragging.profile !== state.activeProfileId) return;
    const rect = event.currentTarget.getBoundingClientRect(), fraction = horizontal ? (event.clientX - rect.left) / rect.width : (event.clientY - rect.top) / rect.height;
    const edge = inside || target === 'bar' || target === 'other' || folder && fraction > .25 && fraction < .75 ? 'inside' : fraction > .5 ? 'after' : 'before';
    const to = edge === 'inside' ? target : parent, children = favoriteChildren(state.store.favorites, to);
    if (!children || !canMoveFavorite(state.store.favorites, dragging.id, to)) { event.stopPropagation(); event.dataTransfer.dropEffect = 'none'; setMark(null); return; }
    const index = edge === 'inside' ? children.length : (favoriteLocation(state.store.favorites, target)?.position ?? position) + (edge === 'after' ? 1 : 0);
    event.preventDefault(); event.stopPropagation(); event.dataTransfer.dropEffect = 'move'; setMark({ target, edge, parent: to, position: index });
  };
  const drop = (event: DragEvent<HTMLElement>, target: string) => {
    event.preventDefault(); event.stopPropagation();
    const raw = event.dataTransfer.getData(FAVORITE_DRAG);
    let binding: typeof dragging = null;
    try { if (raw.length <= 256) binding = JSON.parse(raw) as typeof dragging; } catch { /* An external drag cannot name an internal item. */ }
    if (mark?.target === target && binding?.profile === state.activeProfileId && binding.id === dragging?.id && canMoveFavorite(state.store.favorites, binding.id, mark.parent)) void run({ type: 'move-favorite', id: binding.id, parent: mark.parent, position: mark.position });
    setMark(null); dragging = null;
  };
  const end = () => { setMark(null); dragging = null; };
  const props = (id: string, parent: string, position: number, folder = false, horizontal = false, inside = false) => (state.privateWindow ? {} : {
    draggable: true, onDragStart: (event: DragEvent<HTMLElement>) => start(event, id), onDragEnd: end,
    onDragOver: (event: DragEvent<HTMLElement>) => over(event, id, parent, position, folder, horizontal, inside), onDrop: (event: DragEvent<HTMLElement>) => drop(event, id),
    onDragLeave: (event: DragEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMark(null); },
    'data-drop': mark?.target === id ? mark.edge : undefined,
  });
  const containerProps = (id: string) => (state.privateWindow ? {} : {
    onDragOver: (event: DragEvent<HTMLElement>) => over(event, id, id, 0, true, false, true),
    onDrop: (event: DragEvent<HTMLElement>) => drop(event, id),
    onDragLeave: (event: DragEvent<HTMLElement>) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setMark(null); },
    'data-drop': mark?.target === id ? mark.edge : undefined,
  });
  return { props, containerProps, end };
}

function FolderPopover({ state, folder, opener, beside, language, onOpen, onClose, actions, drag, openAll = true }: {
  state: BrowserState;
  folder: FolderTarget; opener: RefObject<HTMLElement | null>; beside: boolean; language: Language;
  onOpen: (item: FavoriteItem, button: HTMLElement, background?: boolean) => void; onClose: () => void; openAll?: boolean;
  actions: ReturnType<typeof useFavoriteActions>; drag: ReturnType<typeof useFavoriteDrag>;
}) {
  const ref = useRef<HTMLElement>(null), count = favoriteLinks(folder.children).length;
  const icons = useFavoriteFavicons(state, folder.children);
  useEffect(() => { if (!dragging) (ref.current?.querySelector<HTMLElement>('[role=menuitem]') ?? ref.current)?.focus(); }, []);
  return <PopupAnchor opener={opener} align="start" beside={beside}><section ref={ref} className="favorites-surface favorite-popover" role="menu" aria-label={folder.name} tabIndex={-1} {...drag.containerProps(folder.id)} onKeyDown={event => {
    if (event.defaultPrevented) return;
    if (event.key === 'Escape' || beside && event.key === 'ArrowLeft') { event.preventDefault(); event.stopPropagation(); onClose(); return; }
    const buttons = [...event.currentTarget.querySelectorAll<HTMLElement>('[role=menuitem]')], index = buttons.indexOf(document.activeElement as HTMLElement);
    const next = event.key === 'ArrowDown' ? (index + 1) % buttons.length : event.key === 'ArrowUp' ? index < 0 ? buttons.length - 1 : (index + buttons.length - 1) % buttons.length : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1;
    if (next >= 0) { event.preventDefault(); event.stopPropagation(); buttons[next]?.focus(); }
  }}>{!folder.children.length && <p className="favorite-empty">{text('emptyFolder', language)}</p>}
    {folder.children.map((item, position) => <button className="favorite-popup-row" type="button" role="menuitem" aria-haspopup={item.kind === 'folder' ? 'menu' : undefined} key={item.id} title={itemName(item)} {...drag.props(item.id, folder.id, position, item.kind === 'folder')} onClick={event => onOpen(item, event.currentTarget, event.ctrlKey)} onAuxClick={event => { if (event.button === 1 && item.kind === 'link') { event.preventDefault(); onOpen(item, event.currentTarget, true); } }} onDragEnter={event => { if (item.kind === 'folder' && dragging) onOpen(item, event.currentTarget); }} onContextMenu={event => actions.showMenu(event, item)} onKeyDown={event => { actions.menuKey(event, item); if (!event.defaultPrevented && item.kind === 'folder' && (event.key === 'ArrowRight' || event.key === 'ArrowDown')) { event.preventDefault(); event.stopPropagation(); onOpen(item, event.currentTarget); } }}><span className="favorite-mark"><FavoriteBadge item={item} icons={icons} /></span><span className="favorite-label">{itemName(item)}</span>{item.kind === 'folder' && <ChevronRight aria-hidden="true" />}</button>)}
    {openAll && count > 0 && <><hr role="separator" /><button type="button" role="menuitem" className="favorite-popup-row" onClick={event => onOpen({ kind: 'folder', id: folder.id, name: folder.name, createdAt: 0, children: [] }, event.currentTarget)} data-open-all><span className="favorite-mark"><ExternalLink aria-hidden="true" /></span><span>{text('openAllFavorites', language).replace('{count}', String(count))}</span></button></>}
  </section></PopupAnchor>;
}

export function FavoritesBar({ state, language, run, onDelete, onOverlay, onActivate, dismiss, undo, onRestore }: ActionProps & {
  onOverlay: (open: boolean) => void; onActivate: () => void; dismiss: boolean;
  undo: { kind: string; message: CopyKey } | null; onRestore: () => void;
}) {
  const ref = useRef<HTMLDivElement>(null), measure = useRef<HTMLDivElement>(null), other = useRef<HTMLButtonElement>(null);
  const [visible, setVisible] = useState(state.store.favorites.bar.length), [focused, setFocused] = useState('');
  const [folders, setFolders] = useState<{ id: string; opener: RefObject<HTMLElement | null>; overflow?: boolean }[]>([]);
  const close = () => setFolders([]), actions = useFavoriteActions({ state, language, run, onDelete }, close), drag = useFavoriteDrag(state, run);
  const items = state.store.favorites.bar, hidden = items.slice(visible), hasOverlay = Boolean(folders.length || actions.hasOverlay);
  const icons = useFavoriteFavicons(state, items.slice(0, visible));
  useEffect(() => { onOverlay(hasOverlay); return () => onOverlay(false); }, [hasOverlay, onOverlay]);
  useEffect(() => { if (dismiss) { setFolders([]); actions.clear(); } }, [dismiss]);
  useEffect(() => {
    if (!hasOverlay) return;
    const outside = (event: PointerEvent) => { if (!(event.target as HTMLElement).closest('.favorites-surface, .favorites-bar button')) { close(); actions.clear(); } };
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside);
  }, [hasOverlay]);
  useLayoutEffect(() => {
    const update = () => {
      if (!ref.current || !measure.current || !other.current) return;
      const widths = [...measure.current.children].map(child => child.getBoundingClientRect().width);
      const style = getComputedStyle(ref.current), gap = Number.parseFloat(style.columnGap);
      const available = ref.current.clientWidth - Number.parseFloat(style.paddingLeft) - Number.parseFloat(style.paddingRight) - other.current.getBoundingClientRect().width - gap;
      setVisible(favoritesOverflow(widths, available, 28, gap));
    };
    const observer = new ResizeObserver(update); if (ref.current) observer.observe(ref.current); if (measure.current) observer.observe(measure.current); if (other.current) observer.observe(other.current);
    update(); window.addEventListener('resize', update); void document.fonts.ready.then(update);
    return () => { observer.disconnect(); window.removeEventListener('resize', update); };
  }, [items, language]);
  const openFolder = (id: string, button: HTMLElement, level = 0, overflow = false) => {
    if (dragging && folders[level]?.id === id) return;
    actions.clear();
    // Keeping the source panel mounted lets Chromium finish a drag into the bar.
    if (!dragging) onActivate();
    setFolders(previous => previous[level]?.id === id ? previous.slice(0, level) : [...previous.slice(0, level), { id, opener: { current: button }, overflow }]);
  };
  const open = (item: FavoriteItem, button: HTMLElement, level = 0, background = false) => {
    if (button.hasAttribute('data-open-all')) { void run({ type: 'open-all-favorites', id: item.id }); close(); return; }
    if (item.kind === 'folder') openFolder(item.id, button, level);
    else { onActivate(); void run({ type: background ? 'open-favorite-new-tab' : 'open-favorite', id: item.id }); close(); actions.clear(); }
  };
  const controls = [...items.slice(0, visible).map(item => item.id), ...(hidden.length ? ['overflow'] : []), 'other'];
  const tabStop = controls.includes(focused) ? focused : hidden.some(item => item.id === focused) ? 'overflow' : controls[0];
  const label = (item: FavoriteItem) => <><FavoriteBadge item={item} icons={icons} /><span className="favorite-label">{itemName(item)}</span></>;
  return <><div className="favorites-bar" role="toolbar" aria-label={text('favorites', language)} ref={ref} onKeyDown={event => {
    if (event.defaultPrevented) return;
    const buttons = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('button')], index = buttons.indexOf(document.activeElement as HTMLButtonElement);
    const next = event.key === 'ArrowRight' ? (index + 1) % buttons.length : event.key === 'ArrowLeft' ? (index + buttons.length - 1) % buttons.length : event.key === 'Home' ? 0 : event.key === 'End' ? buttons.length - 1 : -1;
    if (next >= 0) { event.preventDefault(); buttons[next]?.focus(); }
    if (event.key === 'Escape' && hasOverlay) { event.preventDefault(); event.stopPropagation(); const last = folders.at(-1); setFolders(previous => previous.slice(0, -1)); last?.opener.current?.focus(); }
  }}>
    {items.slice(0, visible).map((item, position) => <button className="favorite-bar-item" type="button" key={item.id} tabIndex={tabStop === item.id ? 0 : -1} title={itemName(item)} aria-haspopup={item.kind === 'folder' ? 'menu' : undefined} aria-expanded={item.kind === 'folder' ? folders[0]?.id === item.id : undefined} onFocus={() => setFocused(item.id)} onClick={event => { if (event.ctrlKey && item.kind === 'link') { onActivate(); void run({ type: 'open-favorite-new-tab', id: item.id }); close(); } else open(item, event.currentTarget); }} onAuxClick={event => { if (event.button === 1 && item.kind === 'link') { event.preventDefault(); void run({ type: 'open-favorite-new-tab', id: item.id }); } }} onDragEnter={event => { if (dragging && item.kind === 'folder') openFolder(item.id, event.currentTarget); }} onContextMenu={event => { onActivate(); actions.showMenu(event, item); }} onKeyDown={event => { if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) onActivate(); actions.menuKey(event, item); if (item.kind === 'folder' && event.key === 'ArrowDown') { event.preventDefault(); openFolder(item.id, event.currentTarget); } }} {...drag.props(item.id, 'bar', position, item.kind === 'folder', true)}>{label(item)}</button>)}
    <span className="favorites-spacer" aria-hidden="true" {...drag.containerProps('bar')} />
    {hidden.length > 0 && <button className="favorite-overflow favorite-bar-item" type="button" tabIndex={tabStop === 'overflow' ? 0 : -1} aria-label={text('moreFavorites', language)} aria-haspopup="menu" aria-expanded={folders[0]?.overflow ?? false} onFocus={() => setFocused('overflow')} onClick={event => openFolder('overflow', event.currentTarget, 0, true)} onKeyDown={event => { if (event.key === 'ArrowDown') { event.preventDefault(); openFolder('overflow', event.currentTarget, 0, true); } }}><ChevronsRight aria-hidden="true" /></button>}
    <button className="favorite-bar-item favorite-other" ref={other} type="button" tabIndex={tabStop === 'other' ? 0 : -1} aria-haspopup="menu" aria-expanded={folders[0]?.id === 'other'} onFocus={() => setFocused('other')} onDragEnter={event => { if (dragging) openFolder('other', event.currentTarget); }} onContextMenu={event => { onActivate(); actions.showMenu(event, { kind: 'folder', id: 'other', name: rootName('other', language), children: state.store.favorites.other, createdAt: 0 }); }} onClick={event => openFolder('other', event.currentTarget)} onKeyDown={event => { actions.menuKey(event, { kind: 'folder', id: 'other', name: rootName('other', language), children: state.store.favorites.other, createdAt: 0 }); if (event.key === 'ArrowDown') { event.preventDefault(); openFolder('other', event.currentTarget); } }} {...drag.props('other', 'other', 0, true, true)} draggable={false}><Folder aria-hidden="true" /><span className="favorite-label">{text('otherFavorites', language)}</span></button>
  </div>
  <div className="favorites-measure" ref={measure} aria-hidden="true">{items.map(item => <span className="favorite-bar-item" key={item.id}>{label(item)}</span>)}</div>
  {folders.map((entry, level) => {
    const folder = favoriteLocation(state.store.favorites, entry.id)?.item;
    const target = entry.overflow ? { id: 'bar', name: text('moreFavorites', language), children: hidden } : entry.id === 'other' ? { id: 'other', name: rootName('other', language), children: state.store.favorites.other } : folder?.kind === 'folder' ? folder : null;
    return target && <FolderPopover key={entry.id} state={state} folder={target} opener={entry.opener} beside={level > 0} language={language} actions={actions} drag={drag} openAll={!entry.overflow} onOpen={(item, button, background) => open(item, button, level + 1, background)} onClose={() => { setFolders(previous => previous.slice(0, level)); entry.opener.current?.focus(); }} />;
  })}
  {actions.overlays}
  {undo?.kind === 'bookmarks' && <div className="favorites-undo undo-bar" role="status"><span>{text(undo.message, language)}</span><button className="settings-button quiet" type="button" data-favorite-undo onClick={onRestore}>{text('undo', language)}</button></div>}
  </>;
}

export function FavoritesPanel({ state, language, run, onDelete, opener, undo, onRestore, onDismiss, onAnnounce }: ActionProps & {
  opener: RefObject<HTMLButtonElement | null>; undo: { kind: string; message: CopyKey } | null; onRestore: () => void;
  onDismiss: (focus: boolean) => void; onAnnounce: (message: string) => void;
}) {
  const ref = useRef<HTMLElement>(null), search = useRef<HTMLInputElement>(null), newButton = useRef<HTMLButtonElement>(null), id = useId();
  const [expanded, setExpanded] = useState(new Set(['bar'])), [focused, setFocused] = useState('bar'), [filter, setFilter] = useState(''), [searching, setSearching] = useState(false);
  const beforeSearch = useRef<Set<string> | null>(null);
  const close = () => onDismiss(false), actions = useFavoriteActions({ state, language, run, onDelete }, close), drag = useFavoriteDrag(state, run);
  const tree = { bar: filterFavorites(state.store.favorites.bar, filter, language), other: filterFavorites(state.store.favorites.other, filter, language) };
  const visibleIds = new Set(['bar', 'other']);
  const visibleLinks: FavoriteItem[] = [];
  const visibleChildren = (items: FavoriteItem[], parent: string) => {
    if (!expanded.has(parent)) return;
    for (const item of items) { visibleIds.add(item.id); if (item.kind === 'folder') visibleChildren(item.children, item.id); else visibleLinks.push(item); }
  };
  visibleChildren(tree.bar, 'bar'); visibleChildren(tree.other, 'other');
  const icons = useFavoriteFavicons(state, visibleLinks);
  const treeFocus = visibleIds.has(focused) ? focused : 'bar';
  const noResults = Boolean(filter.trim()) && !tree.bar.length && !tree.other.length;
  const t = (key: CopyKey) => text(key, language);
  useEffect(() => { ref.current?.querySelector<HTMLElement>('[role=treeitem][tabindex="0"], button:not(:disabled)')?.focus(); }, []);
  useEffect(() => { if (searching) search.current?.focus(); }, [searching]);
  useEffect(() => { if (noResults) onAnnounce(text('noResultsTitle', language)); else onAnnounce(''); }, [noResults, language, onAnnounce]);
  useEffect(() => {
    if (!filter.trim()) {
      if (beforeSearch.current) { setExpanded(beforeSearch.current); beforeSearch.current = null; }
      return;
    }
    if (!beforeSearch.current) beforeSearch.current = expanded;
    const next = new Set(['bar', 'other']);
    const visit = (items: FavoriteItem[]) => { for (const item of items) if (item.kind === 'folder') { next.add(item.id); visit(item.children); } };
    visit(filterFavorites(state.store.favorites.bar, filter, language)); visit(filterFavorites(state.store.favorites.other, filter, language));
    setExpanded(next);
  }, [filter, language]);
  useEffect(() => {
    const outside = (event: PointerEvent) => { const target = event.target as HTMLElement; if (!ref.current?.contains(target) && !opener.current?.contains(target) && !target.closest('.favorites-surface')) onDismiss(false); };
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside);
  }, [opener, onDismiss]);
  const toggle = (folder: string, open?: boolean) => setExpanded(previous => { const next = new Set(previous); if (open ?? !previous.has(folder)) next.add(folder); else next.delete(folder); return next; });
  const renderFolder = (folder: FolderTarget, root = false, parent = '', position = 0) => {
    const open = expanded.has(folder.id);
    return <li role="none" key={folder.id}>
      <button className="favorite-tree-row" type="button" role="treeitem" aria-expanded={open} aria-owns={open ? `${id}-${folder.id}-children` : undefined} data-tree-id={folder.id} tabIndex={treeFocus === folder.id ? 0 : -1} title={folder.name} onFocus={() => setFocused(folder.id)} onClick={() => toggle(folder.id)} {...drag.props(folder.id, root ? folder.id : parent, position, true)} draggable={!state.privateWindow && !root} onDragEnter={() => { if (dragging) toggle(folder.id, true); }} onContextMenu={event => actions.showMenu(event, { ...folder, kind: 'folder', createdAt: 0 })} onKeyDown={event => actions.menuKey(event, { ...folder, kind: 'folder', createdAt: 0 })}><span className="favorite-tree-chevron">{open ? <ChevronDown aria-hidden="true" /> : <ChevronRight aria-hidden="true" />}</span><span className="favorite-mark">{open ? <FolderOpen aria-hidden="true" /> : <Folder aria-hidden="true" />}</span><span className="favorite-label">{folder.name}</span></button>
      {open && <ul role="group" id={`${id}-${folder.id}-children`} className="favorite-tree-children">{folder.children.map((item, index) => item.kind === 'folder' ? renderFolder(item, false, folder.id, index) : <li role="none" key={item.id}><button className="favorite-tree-row favorite-tree-link" type="button" role="treeitem" data-tree-id={item.id} tabIndex={treeFocus === item.id ? 0 : -1} onFocus={() => setFocused(item.id)} title={itemName(item)} {...drag.props(item.id, folder.id, index)} onClick={event => { void run({ type: event.ctrlKey ? 'open-favorite-new-tab' : 'open-favorite', id: item.id }); close(); }} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); void run({ type: 'open-favorite-new-tab', id: item.id }); } }} onContextMenu={event => actions.showMenu(event, item)} onKeyDown={event => actions.menuKey(event, item)}><span className="favorite-tree-chevron" /><span className="favorite-mark"><FavoriteBadge item={item} icons={icons} /></span><span className="favorite-label">{itemName(item)}</span></button></li>)}
      </ul>}
    </li>;
  };
  return <ToolbarPopover opener={opener}><section ref={ref} className="browser-library-panel favorites-panel" id="browser-library-panel" role="dialog" aria-labelledby={`${id}-title`} onKeyDown={event => {
    if (event.defaultPrevented || actions.hasOverlay) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDismiss(true); }
    if (!(event.target as HTMLElement).closest('.favorites-tree')) return;
    const rows = [...event.currentTarget.querySelectorAll<HTMLButtonElement>('.favorite-tree-row')], index = rows.indexOf(document.activeElement as HTMLButtonElement), item = (event.target as HTMLElement).closest<HTMLElement>('[role=treeitem]'), folder = item?.getAttribute('aria-expanded');
    if (event.key === 'ArrowRight' && folder != null) { event.preventDefault(); if (folder === 'false') toggle(item!.dataset.treeId!, true); else item!.parentElement?.querySelector<HTMLButtonElement>('[role=group] .favorite-tree-row')?.focus(); }
    else if (event.key === 'ArrowLeft') { event.preventDefault(); if (folder === 'true') toggle(item!.dataset.treeId!, false); else item?.closest<HTMLElement>('[role=group]')?.parentElement?.querySelector<HTMLButtonElement>(':scope > button')?.focus(); }
    else { const next = event.key === 'ArrowDown' ? Math.min(rows.length - 1, index + 1) : event.key === 'ArrowUp' ? Math.max(0, index - 1) : event.key === 'Home' ? 0 : event.key === 'End' ? rows.length - 1 : -1; if (next >= 0) { event.preventDefault(); rows[next]?.focus(); } }
  }}><div className="browser-panel-title"><h2 id={`${id}-title`}>{t('favorites')}</h2><button className="icon-button" type="button" aria-label={t('filterBookmarks')} aria-expanded={searching} onClick={() => { if (searching) setFilter(''); setSearching(previous => !previous); }}><Search aria-hidden="true" /></button>{!state.privateWindow && <button className="icon-button" ref={newButton} type="button" aria-label={t('newFolder')} onClick={() => actions.openForm('new', newButton, favoriteChildren(state.store.favorites, focused) ? focused : favoriteLocation(state.store.favorites, focused)?.parent ?? 'bar')}><FolderPlus aria-hidden="true" /></button>}</div>
    {searching && <div className="search-field browser-panel-search"><Search aria-hidden="true" /><input ref={search} aria-label={t('filterBookmarks')} placeholder={t('filterBookmarks')} value={filter} onChange={event => setFilter(event.target.value)} /></div>}
    {(state.storageReadError || state.storageError) && <p className="browser-panel-error" role="alert">{t(state.storageReadError ? 'storageReadError' : 'storageError')}</p>}
    {undo?.kind === 'bookmarks' && <div className="undo-bar" role="status"><span>{t(undo.message)}</span><button className="settings-button quiet" type="button" data-favorite-undo onClick={onRestore}>{t('undo')}</button></div>}
    {noResults ? <p className="favorite-empty" role="status">{t('noResults')}</p> : <ul className="favorites-tree" role="tree" aria-label={t('favorites')}>{(['bar', 'other'] as const).map(root => renderFolder({ id: root, name: rootName(root, language), children: tree[root] }, true))}</ul>}
    {!filter && !allFavoriteLinks(state.store.favorites).length && !state.store.favorites.bar.length && !state.store.favorites.other.length && <p className="favorite-empty">{t('emptyBookmarks')}</p>}
    {actions.overlays}
  </section></ToolbarPopover>;
}
