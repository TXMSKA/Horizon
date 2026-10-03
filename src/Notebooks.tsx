import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Camera, Check, FileText, LoaderCircle, NotebookPen, Plus, TriangleAlert, X } from 'lucide-react';
import { createPortal } from 'react-dom';
import { copy, text } from './copy';
import type { CopyKey } from './copy';
import type { BrowserState, Language, NotebookSummary } from './shared/api';
import { Menu } from './Menu';

export function notebookError(reason: unknown, language: Language): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  const code = (Object.keys(copy) as CopyKey[]).find(key => /^(NOTEBOOK_|CAPTURE_|NOTHING_SELECTED)/.test(key) && message.includes(key));
  return text(code ?? 'browserError', language);
}
export function relativeNotebookDate(date: number, language: Language, now = Date.now()): string {
  const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  const today = new Date(now), then = new Date(date);
  const days = Math.round((Date.UTC(then.getFullYear(), then.getMonth(), then.getDate()) - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
  if (Math.abs(days) < 7) return format.format(days, 'day');
  if (Math.abs(days) < 30) return format.format(Math.round(days / 7), 'week');
  if (Math.abs(days) < 365) return format.format(Math.round(days / 30), 'month');
  return format.format(Math.round(days / 365), 'year');
}
export function notebookCounts(notebook: Pick<NotebookSummary, 'notes' | 'captures'>, language: Language): string {
  const notes = text(notebook.notes === 1 ? 'noteOne' : 'noteMany', language).replace('{count}', String(notebook.notes));
  const captures = text(notebook.captures === 1 ? 'captureOne' : 'captureMany', language).replace('{count}', String(notebook.captures));
  return text('notebookCounts', language).replace('{notes}', notes).replace('{captures}', captures);
}
export function notebookResumeMeta(notebook: NotebookSummary, language: Language, now = Date.now()): string {
  const count = notebook.captures === 0 ? text(notebook.notes === 1 ? 'noteOne' : 'noteMany', language).replace('{count}', String(notebook.notes))
    : notebook.notes === 0 ? text(notebook.captures === 1 ? 'captureOne' : 'captureMany', language).replace('{count}', String(notebook.captures)) : notebookCounts(notebook, language);
  return `${count}, ${relativeNotebookDate(notebook.updatedAt, language, now)}`;
}
export function notebookItemLabel(item: Pick<NotebookSummary['latest'][number], 'kind' | 'source'>, language: Language): string {
  return item.kind === 'note' ? text('sourceNote', language) : item.kind === 'text' ? itemSite(item.source?.url ?? '') : text(item.kind === 'page' ? 'sourceFullPage' : 'sourceCapture', language);
}
const nameDrafts = new Map<string, string>();

export function itemSite(url: string): string { try { return new URL(url).hostname; } catch { return url; } }

// Same rows and form as Profiles, mounted in a portal outside clipping ancestors.
export function NotebookAnchor({ opener, children, portalHost }: { opener: RefObject<HTMLElement | null>; children: ReactNode; portalHost?: RefObject<HTMLElement | null> }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const popup = ref.current;
    if (!popup) return;
    const position = () => {
      const trigger = opener.current?.getBoundingClientRect();
      if (!trigger) return;
      const gap = Number.parseFloat(getComputedStyle(popup).getPropertyValue('--notebook-anchor-gap')) || 4;
      const { width, height } = popup.getBoundingClientRect();
      popup.style.setProperty('left', `${Math.max(gap, Math.min(trigger.right - width, innerWidth - width - gap))}px`);
      const below = trigger.bottom + gap;
      popup.style.setProperty('top', `${Math.max(gap, Math.min(below + height > innerHeight ? trigger.top - height - gap : below, innerHeight - height - gap))}px`);
    };
    const observer = new ResizeObserver(position);
    observer.observe(popup); if (opener.current) observer.observe(opener.current);
    window.addEventListener('resize', position); window.addEventListener('scroll', position, true); position();
    return () => { observer.disconnect(); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [opener]);
  return createPortal(<div className="notebook-anchor" ref={ref}>{children}</div>, portalHost?.current ?? document.body);
}

export function NotebookNameForm({ language, initial = '', rename, profileId = '', locked = false, onCancel, onSuccess, onStateChange }: {
  language: Language; initial?: string; rename?: string; profileId?: string; locked?: boolean; onCancel: () => void; onSuccess: (notebook: NotebookSummary) => Promise<void> | void; onStateChange?: (name: string, busy: boolean) => void;
}) {
  const id = useId(), input = useRef<HTMLInputElement>(null), form = useRef<HTMLFormElement>(null), pending = useRef(false);
  const draftKey = rename ? `rename:${rename}` : `create:${profileId}`;
  const [name, setName] = useState(() => nameDrafts.get(draftKey) ?? initial), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const t = (key: CopyKey) => text(key, language);
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  return <form ref={form} className="profile-form notebook-name-form" aria-label={t(rename ? 'renameNotebook' : 'newNotebook')} aria-busy={busy} onSubmit={event => {
    event.preventDefault(); if (pending.current) return;
    if (locked) { setError(t('NOTEBOOK_LOCKED')); return; }
    pending.current = true; setBusy(true); setError(''); onStateChange?.(name, true);
    void window.horizon.command(rename ? { type: 'rename-notebook', id: rename, name } : { type: 'create-notebook', name }).then(() => window.horizon.getState()).then(state => {
      const notebook = state.notebooks.find(notebook => rename ? notebook.id === rename : notebook.name.toLowerCase() === name.trim().toLowerCase());
      if (!notebook) throw new Error('NOTEBOOK_NOT_FOUND');
      nameDrafts.delete(draftKey);
      return onSuccess(notebook);
    }).catch((reason: unknown) => { setError(notebookError(reason, language)); input.current?.focus(); }).finally(() => { pending.current = false; setBusy(false); onStateChange?.(input.current?.value ?? name, false); });
  }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!pending.current) onCancel(); }
    if (event.key !== 'Tab') return;
    const stops = [...(form.current?.querySelectorAll<HTMLElement>('input, button:not(:disabled)') ?? [])];
    if (document.activeElement !== (event.shiftKey ? stops[0] : stops.at(-1))) return;
    event.preventDefault(); (event.shiftKey ? stops.at(-1) : stops[0])?.focus();
  }}>
    <label htmlFor={`${id}-name`}>{t('notebookName')}</label>
    <input ref={input} id={`${id}-name`} value={name} maxLength={256} autoComplete="off" aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} onChange={event => { setName(event.target.value); nameDrafts.set(draftKey, event.target.value); setError(''); onStateChange?.(event.target.value, pending.current); }} />
    {error && <p className="profile-field-error" id={`${id}-error`} role="alert"><TriangleAlert aria-hidden="true" />{error}</p>}
    <div className="profile-form-actions"><button className="profile-action quiet" type="button" disabled={busy || !name} onClick={() => { nameDrafts.delete(draftKey); setName(''); setError(''); onStateChange?.('', false); input.current?.focus(); }}>{t('clear')}</button><button className="profile-action quiet" type="button" disabled={busy} onClick={onCancel}>{t('cancel')}</button><button className="profile-action primary" type="submit" disabled={busy}>{busy && <LoaderCircle className="spinner" aria-hidden="true" />}{t(rename ? 'save' : 'create')}</button></div>
  </form>;
}

export function NotebookPicker({ state, language, opener, choosing = false, newFirst = false, onClose, onChoose, portalHost }: {
  state: BrowserState; language: Language; opener: RefObject<HTMLElement | null>; choosing?: boolean; newFirst?: boolean;
  onClose: () => void; onChoose: (notebook: NotebookSummary) => Promise<void> | void; portalHost?: RefObject<HTMLElement | null>;
}) {
  const filterId = useId();
  const [filter, setFilter] = useState('');
  const [creating, setCreating] = useState(newFirst || !state.notebooks.length);
  const ref = useRef<HTMLDivElement>(null), close = useRef(onClose);
  const formState = useRef({ name: '', busy: false });
  useLayoutEffect(() => { close.current = onClose; });
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!formState.current.name && !formState.current.busy && !ref.current?.contains(event.target as Node) && !opener.current?.contains(event.target as Node)) close.current(); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [opener]);
  const sorted = [...state.notebooks].sort((a, b) => Number(b.id === state.notebookInUse) - Number(a.id === state.notebookInUse) || b.usedAt - a.usedAt);
  const filtered = sorted.filter(notebook => notebook.name.toLocaleLowerCase(language).includes(filter.trim().toLocaleLowerCase(language)));
  const t = (key: CopyKey) => text(key, language);
  return <NotebookAnchor opener={opener} portalHost={portalHost}><div ref={ref} data-notebook-picker onKeyDown={event => { if (choosing && !creating && (event.target as HTMLElement)?.tagName !== 'INPUT' && event.key === 'Tab') { event.preventDefault(); event.stopPropagation(); } }}>
    {creating ? <div className="notebook-name-popover" role="dialog" aria-label={t('newNotebook')}><NotebookNameForm language={language} profileId={state.activeProfileId} locked={state.notebookLocked} initial={filter} onCancel={onClose} onSuccess={onChoose} onStateChange={(name, busy) => { formState.current = { name, busy }; }} /></div> :
      <div className="notebooks-picker-list"><Menu id="notebooks-menu" className="notebooks-menu" label={t(choosing ? 'chooseNotebook' : 'notebooks')} keyboard initialFocus={state.notebooks.length > 8 ? 'input' : '[aria-checked=true]'} opener={opener} onDismiss={reason => { onClose(); if (reason !== 'outside') opener.current?.focus(); }}>
        {state.notebooks.length > 8 && <div className="profile-form notebook-filter"><label htmlFor={filterId}>{t('filterNotebooks')}</label><input id={filterId} value={filter} onChange={event => setFilter(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); opener.current?.focus(); } }} /></div>}
        {filtered.map((notebook, index) => <button className="profile-menu-row" key={notebook.id} type="button" role="menuitemradio" aria-checked={notebook.id === state.notebookInUse || (!state.notebookInUse && index === 0)} tabIndex={-1} onClick={() => { void onChoose(notebook); }}><NotebookPen aria-hidden="true" /><span className="profile-row-body"><strong>{notebook.name}</strong><small>{notebookCounts(notebook, language)}</small></span>{(notebook.id === state.notebookInUse || (!state.notebookInUse && index === 0)) && <Check className="profile-check" aria-hidden="true" />}</button>)}
        {!filtered.length && <p className="notebook-no-results" role="status">{t('noNotebookResults')}</p>}<hr role="separator" /><button type="button" role="menuitem" tabIndex={-1} onClick={() => { if (!filtered.length && filter.trim()) nameDrafts.set(`create:${state.activeProfileId}`, filter.trim()); setCreating(true); }}><Plus aria-hidden="true" /><span>{!filtered.length && filter.trim() ? t('newNotebookNamed').replace('{name}', filter.trim()) : t('newNotebook')}</span></button>
      </Menu></div>}
  </div></NotebookAnchor>;
}

export function NotebookHome({ state, language, onOpen, onNew }: {
  state: BrowserState; language: Language; onOpen: (id: string, item?: string) => void; onNew: (button: HTMLButtonElement) => void;
}) {
  const notebook = state.notebooks.find(notebook => notebook.id === state.notebookInUse) ?? [...state.notebooks].sort((a, b) => b.usedAt - a.usedAt)[0];
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60000); return () => window.clearInterval(timer); }, []);
  const t = (key: CopyKey) => text(key, language);
  if (!notebook) return <section className="notebook-first-use" aria-labelledby="notebooks-first-title"><h2 id="notebooks-first-title"><NotebookPen className="accent" aria-hidden="true" />{t('emptyNotebooksTitle')}</h2><p>{t('emptyNotebooks')}</p><button className="profile-action primary" type="button" onClick={event => onNew(event.currentTarget)}>{t('newNotebook')}</button></section>;
  return <section className="notebook" aria-label={t('resumeNotebook').replace('{name}', notebook.name)}><button className="notebook-heading notebook-resume" type="button" onClick={() => onOpen(notebook.id)}><NotebookPen className="accent" aria-hidden="true" /><strong>{notebook.name}</strong><small>{notebookResumeMeta(notebook, language, now)}</small></button><ul className="notes">{notebook.latest.map(item => {
    const Icon = item.kind === 'area' || item.kind === 'page' ? Camera : FileText;
    return <li key={item.id}><button className="notebook-home-row" type="button" onClick={() => onOpen(notebook.id, item.id)}><Icon aria-hidden="true" /><span>{item.title || t('newNote')}</span><small>{notebookItemLabel(item, language)}</small></button></li>;
  })}</ul></section>;
}

export type NotebookNotice = { message: string; action?: string; onAction?: () => void; failure?: boolean; undo?: boolean; pending?: boolean };
export function NotebookStatus({ notice, language, onClose }: { notice: NotebookNotice | null; language: Language; onClose: () => void }) {
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false);
  const paused = hovered || focused;
  const remaining = useRef(8000);
  useEffect(() => { remaining.current = 8000; if (!notice) { setHovered(false); setFocused(false); } }, [notice]);
  useEffect(() => {
    if (!notice || paused && !notice.undo || notice.failure || notice.pending) return;
    const start = Date.now(), timer = window.setTimeout(onClose, remaining.current);
    return () => { window.clearTimeout(timer); remaining.current = Math.max(0, remaining.current - (Date.now() - start)); };
  }, [notice, paused, onClose]);
  return <div className="notebook-status-region" role="status" aria-live="polite" aria-atomic="true">
    {notice && <div className={`notebook-toast${notice.failure ? ' has-error' : ''}`} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocus={() => setFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}><span>{notice.message}</span>{notice.onAction && <button className="text-button" type="button" onClick={notice.onAction}>{notice.action}</button>}{!notice.pending && <button className="icon-button" type="button" aria-label={text('close', language)} onClick={onClose}><X aria-hidden="true" /></button>}</div>}
  </div>;
}
