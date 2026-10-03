import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject, TextareaHTMLAttributes } from 'react';
import { createPortal } from 'react-dom';
import { Check, ChevronDown, FileText, Folder, LayoutDashboard, LoaderCircle, Plus, Scan, X } from 'lucide-react';
import { copy, text } from './copy';
import type { CopyKey } from './copy';
import type { BrowserState, CaptureSummary, DesktopItemContent, Language, ProjectSummary } from './shared/api';
import { Menu } from './Menu';
import { PopupAnchor } from './PopupAnchor';

export function desktopError(reason: unknown, language: Language): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  const codes = new Set(message.match(/\b[A-Z][A-Z_]+\b/g) ?? []);
  const code = (Object.keys(copy) as CopyKey[]).find(key => codes.has(key));
  return text(code ?? 'browserError', language);
}
export function relativeDesktopDate(date: number, language: Language, now = Date.now()): string {
  const format = new Intl.RelativeTimeFormat(language, { numeric: 'auto' });
  const today = new Date(now), then = new Date(date);
  const days = Math.round((Date.UTC(then.getFullYear(), then.getMonth(), then.getDate()) - Date.UTC(today.getFullYear(), today.getMonth(), today.getDate())) / 86400000);
  if (Math.abs(days) < 7) return format.format(days, 'day');
  if (Math.abs(days) < 30) return format.format(Math.round(days / 7), 'week');
  if (Math.abs(days) < 365) return format.format(Math.round(days / 30), 'month');
  return format.format(Math.round(days / 365), 'year');
}
export function itemSite(url: string): string { try { return new URL(url).hostname; } catch { return ''; } }
export const projectSize = (project: ProjectSummary) => project.pages + project.captures + project.notes;
export const itemCount = (count: number, language: Language) => text(count === 1 ? 'itemOne' : 'itemMany', language).replace('{count}', String(count));
export function projectCounts(project: ProjectSummary, language: Language): string {
  return [text(project.pages === 1 ? 'pageOne' : 'pageMany', language).replace('{count}', String(project.pages)),
    text(project.captures === 1 ? 'captureOne' : 'captureMany', language).replace('{count}', String(project.captures)),
    text(project.notes === 1 ? 'noteOne' : 'noteMany', language).replace('{count}', String(project.notes))].join(', ');
}
export function desktopItemLabel(item: Pick<DesktopItemContent, 'kind' | 'source'>, language: Language): string {
  if (item.kind === 'note') return text('sourceNote', language);
  if (item.kind === 'link' || item.kind === 'text') return itemSite(item.source?.url ?? '') || text('noteText', language);
  return text(item.kind === 'page' ? 'sourceFullPage' : 'sourceCapture', language);
}
export function ItemMark({ item }: { item: Pick<DesktopItemContent, 'kind' | 'source' | 'title'> }) {
  return <span className="desktop-mark" aria-hidden="true">{item.kind === 'link' ? <span className="desktop-site-badge">{(itemSite(item.source?.url ?? '') || item.title).slice(0, 1).toUpperCase()}</span> : item.kind === 'area' || item.kind === 'page' ? <Scan className="accent" /> : <FileText />}</span>;
}
export function GrowingTextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    const grow = () => { element.style.height = 'auto'; element.style.height = `${element.scrollHeight + element.offsetHeight - element.clientHeight}px`; };
    grow(); let width = element.clientWidth;
    const observer = new ResizeObserver(() => { if (element.clientWidth !== width) { width = element.clientWidth; grow(); } });
    observer.observe(element); return () => observer.disconnect();
  }, [props.value]);
  return <textarea {...props} ref={field} rows={1} />;
}
export function CaptureImage({ project, item, language, preview = false }: { project: string | null; item: CaptureSummary & { image?: Pick<NonNullable<DesktopItemContent['image']>, 'width' | 'height'> | null }; language: Language; preview?: boolean }) {
  const [image, setImage] = useState<string | null>(null), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!box.current) return;
    if (!preview && item.image) box.current.style.setProperty('aspect-ratio', `${item.image.width} / ${item.image.height}`);
    else box.current.style.removeProperty('aspect-ratio');
  }, [preview, item.image?.width, item.image?.height]);
  useEffect(() => {
    let mounted = true, url: string | null = null;
    setImage(null); setFailed(false);
    void window.horizon.getCaptureImage(project, item.id).then(bytes => {
      if (!mounted) return;
      if (!bytes) { setFailed(true); return; }
      url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/png' })); setImage(url);
    }).catch(() => { if (mounted) setFailed(true); });
    return () => { mounted = false; if (url) URL.revokeObjectURL(url); };
  }, [project, item.id, attempt]);
  return <div ref={box} className={`desktop-image${preview ? ' preview' : ''}`} aria-busy={!image && !failed}>{failed ? <div className="desktop-image-error" role="alert"><p className={preview ? 'visually-hidden' : undefined}>{text('captureImageFailed', language)}</p><button className="desktop-small-link" type="button" onClick={() => setAttempt(previous => previous + 1)}>{text('retry', language)}</button></div> : image ? <img src={image} alt={text('captureImage', language).replace('{title}', item.title)} onError={() => { URL.revokeObjectURL(image); setImage(null); setFailed(true); }} /> : <div className="desktop-skeleton" role="status"><span className="visually-hidden">{text('loading', language)}</span></div>}</div>;
}

export function DesktopDropdown({ label, value, lead, choices, onChoose, disabled = false, display }: { label: string; value: string; lead?: ReactNode; choices: { id: string; name: string; lead?: ReactNode }[]; onChoose: (id: string) => void; disabled?: boolean; display?: string }) {
  const [open, setOpen] = useState(false), opener = useRef<HTMLButtonElement>(null), id = useId();
  const close = (focus = true) => { setOpen(false); if (focus) opener.current?.focus(); };
  return <div className="desktop-dropdown"><button className="desktop-dropdown-control" ref={opener} type="button" disabled={disabled} aria-label={label} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(previous => !previous)} onKeyDown={event => { if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setOpen(true); } }}>
    {lead}<span>{display ?? choices.find(choice => choice.id === value)?.name ?? label}</span><span className="desktop-dropdown-chevron"><ChevronDown aria-hidden="true" /></span>
  </button>{open && <PopupAnchor opener={opener}><Menu id={id} className="desktop-choice-menu" label={label} keyboard initialFocus="[aria-checked=true]" opener={opener} onDismiss={reason => close(reason !== 'outside')}>
    {choices.map(choice => <button key={choice.id} type="button" role="menuitemradio" aria-checked={choice.id === value} tabIndex={-1} onClick={() => { close(); onChoose(choice.id); }}>{choice.lead}<span>{choice.name}</span>{choice.id === value && <Check aria-hidden="true" />}</button>)}
  </Menu></PopupAnchor>}</div>;
}

const nameDrafts = new Map<string, string>();
export function ProjectNameForm({ state, language, folder, onSuccess }: { state: BrowserState; language: Language; folder?: string; onSuccess: (project: ProjectSummary) => void | Promise<void> }) {
  const id = useId(), input = useRef<HTMLInputElement>(null), pending = useRef(false), key = `${state.activeProfileId}:${folder ?? 'project'}`;
  const [name, setName] = useState(() => nameDrafts.get(key) ?? ''), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const t = (key: CopyKey) => text(key, language);
  useEffect(() => { input.current?.focus(); }, []);
  return <form className="desktop-name-form" aria-busy={busy} onSubmit={event => {
    event.preventDefault(); if (pending.current) return;
    if (state.desktopLocked) { setError(t('DESKTOP_LOCKED')); return; }
    pending.current = true; setBusy(true); setError('');
    void window.horizon.command(folder ? { type: 'create-folder', project: folder, name } : { type: 'create-project', name }).then(() => window.horizon.getState()).then(next => {
      const project = next.projects.find(project => folder ? project.id === folder : project.name.toLowerCase() === name.trim().toLowerCase());
      if (!project) throw new Error('PROJECT_NOT_FOUND');
      nameDrafts.delete(key); return onSuccess(project);
    }).catch(reason => { setError(desktopError(reason, language)); input.current?.focus(); }).finally(() => { pending.current = false; setBusy(false); });
  }}><div className="desktop-field"><label htmlFor={id}>{t(folder ? 'folderName' : 'projectName')}</label><input id={id} ref={input} value={name} readOnly={busy} maxLength={80} autoComplete="off" aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} onChange={event => { if (pending.current) return; setName(event.target.value); nameDrafts.set(key, event.target.value); setError(''); }} /></div>
    {error && <p id={`${id}-error`} className="desktop-error" role="alert">{error}</p>}<button className="desktop-action primary" type="submit" disabled={busy}>{busy && <LoaderCircle className="spinner" aria-hidden="true" />}{t('create')}</button>
  </form>;
}
export function DesktopNameDialog({ state, language, folder, opener, onClose, onSuccess, onModalChange }: { state: BrowserState; language: Language; folder?: string; opener: RefObject<HTMLElement | null>; onClose: () => void; onSuccess: (project: ProjectSummary) => void | Promise<void>; onModalChange?: (open: boolean) => void }) {
  const dialog = useRef<HTMLDialogElement>(null), id = useId();
  useEffect(() => {
    onModalChange?.(true); const modal = dialog.current; modal?.showModal();
    return () => { modal?.close(); onModalChange?.(false); opener.current?.focus(); };
  }, [onModalChange, opener]);
  return createPortal(<dialog ref={dialog} className="desktop-dialog" aria-labelledby={id} onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } }}><h2 id={id}>{text(folder ? 'newFolder' : 'newProject', language)}</h2><ProjectNameForm state={state} language={language} folder={folder} onSuccess={onSuccess} /><button className="desktop-action" type="button" onClick={onClose}>{text('cancel', language)}</button></dialog>, document.body);
}
export function CaptureProjectPicker({ state, language, opener, screenshots, onClose, onChoose, portalHost }: { state: BrowserState; language: Language; opener: RefObject<HTMLElement | null>; screenshots: boolean; onClose: () => void; onChoose: (project: ProjectSummary | null) => Promise<void>; portalHost?: RefObject<HTMLElement | null> }) {
  const [creating, setCreating] = useState(false), id = useId();
  const sorted = [...state.projects].sort((a, b) => Number(b.id === state.projectInUse) - Number(a.id === state.projectInUse) || b.usedAt - a.usedAt);
  return creating ? <DesktopNameDialog state={state} language={language} opener={opener} onClose={onClose} onSuccess={onChoose} /> : <PopupAnchor opener={opener} portalHost={portalHost}><Menu id={id} className="desktop-choice-menu capture-project-menu" label={text('saveTo', language)} keyboard opener={opener} onDismiss={reason => { onClose(); if (reason !== 'outside') opener.current?.focus(); }}>
    <button type="button" role="menuitem" tabIndex={-1} disabled={!screenshots} onClick={() => { void onChoose(null); }}><Scan aria-hidden="true" /><span>{text('captures', language)}</span>{!screenshots && <small>{text('screenshotsOnly', language)}</small>}</button>
    {sorted.map(project => <button type="button" role="menuitem" tabIndex={-1} key={project.id} onClick={() => { void onChoose(project); }}><Folder aria-hidden="true" /><span>{project.name}</span></button>)}
    <hr role="separator" /><button type="button" role="menuitem" tabIndex={-1} onClick={() => setCreating(true)}><Plus aria-hidden="true" /><span>{text('newProject', language)}</span></button>
  </Menu></PopupAnchor>;
}

export function DesktopResume({ state, language, onOpen, onNew }: { state: BrowserState; language: Language; onOpen: (id: string, item?: string) => void; onNew: (button: HTMLButtonElement) => void }) {
  const project = state.projects.find(project => project.id === state.projectInUse) ?? [...state.projects].sort((a, b) => b.usedAt - a.usedAt)[0];
  const [now, setNow] = useState(Date.now());
  useEffect(() => { const timer = window.setInterval(() => setNow(Date.now()), 60000); return () => window.clearInterval(timer); }, []);
  const t = (key: CopyKey) => text(key, language);
  if (!project) return <section className="desktop-first-use"><h2><LayoutDashboard className="accent" aria-hidden="true" />{t('emptyDesktopTitle')}</h2><p>{t('emptyDesktop')}</p><button className="desktop-action primary" type="button" onClick={event => onNew(event.currentTarget)}>{t('newProject')}</button></section>;
  return <section aria-label={t('resumeProject').replace('{name}', project.name)}><button className="desktop-resume" type="button" onClick={() => onOpen(project.id)}><LayoutDashboard className="accent" aria-hidden="true" /><strong>{project.name}</strong><small>{itemCount(projectSize(project), language)}, {relativeDesktopDate(project.updatedAt, language, now)}</small></button><ul className="notes">{project.latest.map(item => <li key={item.id}><button className="desktop-home-row" type="button" onClick={() => onOpen(project.id, item.id)}><ItemMark item={item} /><span>{item.title || t('newNote')}</span><small>{desktopItemLabel(item, language)}</small></button></li>)}</ul></section>;
}

export type DesktopNotice = { message: string; action?: string; onAction?: () => void; failure?: boolean; undo?: boolean; pending?: boolean };
export function DesktopStatus({ notice, language, onClose }: { notice: DesktopNotice | null; language: Language; onClose: () => void }) {
  const [hovered, setHovered] = useState(false), [focused, setFocused] = useState(false), remaining = useRef(8000), action = useRef<HTMLButtonElement>(null);
  const paused = hovered || focused;
  useEffect(() => { if (notice?.undo) action.current?.focus(); }, [notice]);
  useEffect(() => { remaining.current = 8000; if (!notice) { setHovered(false); setFocused(false); } }, [notice]);
  useEffect(() => {
    if (!notice || paused && !notice.undo || notice.failure || notice.pending) return;
    const start = Date.now(), timer = window.setTimeout(onClose, remaining.current);
    return () => { window.clearTimeout(timer); remaining.current = Math.max(0, remaining.current - (Date.now() - start)); };
  }, [notice, paused, onClose]);
  return <div className="desktop-status-region" role="status" aria-live="polite" aria-atomic="true">{notice && <div className={`desktop-toast${notice.failure ? ' has-error' : ''}`} onMouseEnter={() => setHovered(true)} onMouseLeave={() => setHovered(false)} onFocus={() => setFocused(true)} onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget)) setFocused(false); }}><span>{notice.message}</span>{notice.onAction && <button className="desktop-small-link" type="button" ref={action} onClick={notice.onAction}>{notice.action}</button>}{!notice.pending && <button className="icon-button" type="button" aria-label={text('close', language)} onClick={onClose}><X aria-hidden="true" /></button>}</div>}</div>;
}
