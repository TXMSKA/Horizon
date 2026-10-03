import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { TextareaHTMLAttributes } from 'react';
import { Camera, Ellipsis, FileText, Pencil, Plus, Trash2 } from 'lucide-react';
import { text } from './copy';
import type { CopyKey } from './copy';
import type { BrowserCommand, Language, NotebookContent } from './shared/api';
import type { NotebookEdits } from './shared/notebook-edits';
import { Menu } from './Menu';
import { itemSite, notebookItemLabel, NotebookAnchor, notebookCounts, notebookError, NotebookNameForm, relativeNotebookDate } from './Notebooks';

type Item = NotebookContent['items'][number];

function GrowingTextArea(props: TextareaHTMLAttributes<HTMLTextAreaElement>) {
  const field = useRef<HTMLTextAreaElement>(null);
  useLayoutEffect(() => {
    const element = field.current;
    if (!element) return;
    const grow = () => {
      element.style.height = 'auto';
      element.style.height = `${element.scrollHeight + element.offsetHeight - element.clientHeight}px`;
    };
    grow();
    let width = element.clientWidth;
    const observer = new ResizeObserver(() => {
      if (element.clientWidth === width) return;
      width = element.clientWidth; grow();
    });
    observer.observe(element);
    return () => observer.disconnect();
  }, [props.value]);
  return <textarea {...props} ref={field} rows={1} />;
}

export function CaptureImage({ notebook, item, language }: { notebook: string; item: Item; language: Language }) {
  const box = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    if (!box.current || !item.image) return;
    box.current.style.setProperty('width', `${item.image.width / window.devicePixelRatio}px`);
    box.current.style.setProperty('aspect-ratio', `${item.image.width} / ${item.image.height}`);
  }, [item.image?.width, item.image?.height]);
  const [image, setImage] = useState<string | null>(null), [failed, setFailed] = useState(false), [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let mounted = true, url: string | null = null;
    setImage(null); setFailed(false);
    void window.horizon.getCaptureImage(notebook, item.id).then(bytes => {
      if (!mounted) return;
      if (!bytes) { setFailed(true); return; }
      url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/png' }));
      setImage(url);
    }).catch(() => { if (mounted) setFailed(true); });
    return () => { mounted = false; if (url) URL.revokeObjectURL(url); };
  }, [notebook, item.id, attempt]);
  return <figure className="notebook-capture"><div ref={box} className="notebook-image-box" aria-busy={!image && !failed}>{failed ? <div className="notebook-image-error" role="alert"><p>{text('notebookImageFailed', language)}</p><button className="profile-action neutral" type="button" onClick={() => setAttempt(previous => previous + 1)}>{text('retry', language)}</button></div> : image ? <img src={image} alt={text('notebookImage', language).replace('{title}', item.title)} onLoad={event => { event.currentTarget.style.width = `${event.currentTarget.naturalWidth / window.devicePixelRatio}px`; }} onError={() => { URL.revokeObjectURL(image); setImage(null); setFailed(true); }} /> : <div className="notebook-image-loading notebook-skeleton" role="status"><span className="visually-hidden">{text('loading', language)}</span></div>}</div>{item.image?.cut && <figcaption>{text('captureCut', language)}</figcaption>}</figure>;
}

function NotebookEditor({ notebook, item, language, edits, readOnly, onDelete }: { notebook: string; item: Item; language: Language; edits: NotebookEdits; readOnly: boolean; onDelete: () => void }) {
  const id = useId(), t = (key: CopyKey) => text(key, language);
  const [draft, setDraft] = useState(() => ({ title: item.title, text: item.text, note: item.note, ...edits.fields(notebook, item.id) }));
  useEffect(() => { setDraft({ title: item.title, text: item.text, note: item.note, ...edits.fields(notebook, item.id) }); }, [notebook, item.id, item.title, item.text, item.note, edits]);
  const change = (field: 'title' | 'text' | 'note', value: string) => {
    setDraft(previous => ({ ...previous, [field]: value })); edits.change(notebook, item.id, { [field]: value });
  };
  return <article className="notebook-item" aria-label={draft.title || t('newNote')}>
    <div className="notebook-item-heading"><div className="notebook-title-field"><label htmlFor={`${id}-title`}>{t('noteTitle')}</label><input className="notebook-item-title" id={`${id}-title`} value={draft.title} maxLength={200} readOnly={readOnly} onChange={event => change('title', event.target.value)} /></div><button className="icon-button" type="button" aria-label={t('deleteItem').replace('{title}', draft.title || t('newNote'))} title={t('deleteItem').replace('{title}', draft.title || t('newNote'))} onClick={onDelete}><Trash2 aria-hidden="true" /></button></div>
    <p className="notebook-source">{item.source ? t('captureSource').replace('{site}', itemSite(item.source.url)).replace('{date}', relativeNotebookDate(item.createdAt, language)) : relativeNotebookDate(item.createdAt, language)} <time dateTime={new Date(item.createdAt).toISOString()} className="visually-hidden">{new Date(item.createdAt).toLocaleString(language)}</time></p>
    {item.image ? <CaptureImage key={item.id} notebook={notebook} item={item} language={language} /> : <div className="notebook-editor-field"><label htmlFor={`${id}-text`}>{t('noteText')}</label><GrowingTextArea id={`${id}-text`} className="notebook-text" value={draft.text} maxLength={100000} readOnly={readOnly} onChange={event => change('text', event.target.value)} /></div>}
    {item.kind !== 'note' && <div className="notebook-editor-field"><label htmlFor={`${id}-note`}>{t('captureNote')}</label><GrowingTextArea id={`${id}-note`} className="notebook-annotation" value={draft.note} placeholder={t('captureNotePlaceholder')} maxLength={20000} readOnly={readOnly} onChange={event => change('note', event.target.value)} /></div>}
  </article>;
}

export function NotebookView({ id, selected, version, language, edits, readOnly, locked = false, run, onOpen, onDelete }: {
  id: string; selected: string | null; version: number; language: Language; edits: NotebookEdits; readOnly: boolean; locked?: boolean;
  run: (command: BrowserCommand) => Promise<boolean>; onOpen: (id: string, item?: string) => void;
  onDelete: (command: BrowserCommand, message: CopyKey) => Promise<void>;
}) {
  const [content, setContent] = useState<NotebookContent | null>(null), [error, setError] = useState(''), [loading, setLoading] = useState(true), [attempt, setAttempt] = useState(0);
  const [menu, setMenu] = useState(false), [rename, setRename] = useState(false), [busy, setBusy] = useState(false);
  const [focusItem, setFocusItem] = useState<string | null>(null);
  const action = useRef<HTMLButtonElement>(null), newNote = useRef<HTMLButtonElement>(null), pending = useRef(false);
  const t = (key: CopyKey) => text(key, language);
  useEffect(() => {
    let mounted = true; setLoading(true); setError('');
    void window.horizon.getNotebook(id).then(notebook => { if (mounted) setContent(notebook); }).catch((reason: unknown) => { if (mounted) setError(notebookError(reason, language)); }).finally(() => { if (mounted) setLoading(false); });
    return () => { mounted = false; };
  }, [id, version, attempt, language]);
  const item = content?.items.find(item => item.id === selected) ?? content?.items[0];
  useEffect(() => {
    if (focusItem !== item?.id) return;
    const input = document.querySelector<HTMLInputElement>('.notebook-item-title'); input?.focus(); input?.select(); setFocusItem(null);
  }, [focusItem, item?.id]);
  const add = async () => {
    if (pending.current) return;
    if (locked) { setError(t('NOTEBOOK_LOCKED')); return; }
    pending.current = true; setBusy(true);
    try {
      await edits.flush();
      const before = await window.horizon.getNotebook(id);
      if (!await run({ type: 'add-note', notebook: id, title: t('newNote'), text: '' })) return;
      const next = await window.horizon.getNotebook(id), added = next.items.find(item => !before.items.some(old => old.id === item.id));
      if (added) { setFocusItem(added.id); onOpen(id, added.id); }
    } catch (reason) { setError(notebookError(reason, language)); }
    finally { pending.current = false; setBusy(false); }
  };
  if (!content) return <section className="notebook-loading" aria-label={t('notebooks')}>{error ? <div role="alert"><p>{error}</p><button className="profile-action neutral" type="button" onClick={() => setAttempt(previous => previous + 1)}>{t('retry')}</button></div> : <div className="notebook-page notebook-placeholder" role="status" aria-busy="true"><span className="visually-hidden">{t('loading')}</span><aside className="notebook-list" aria-hidden="true"><div className="notebook-skeleton skeleton-title" /><ul>{[0, 1, 2, 3, 4].map(row => <li className="notebook-list-row notebook-skeleton" key={row} />)}</ul></aside><div className="notebook-detail" aria-hidden="true"><div className="notebook-skeleton skeleton-title" />{[0, 1, 2, 3].map(line => <div className="notebook-skeleton skeleton-line" key={line} />)}</div></div>}</section>;
  const notes = content.items.filter(item => item.kind === 'note').length;
  return <section className="notebook-page" aria-label={content.name} aria-busy={busy || readOnly}>
    <aside className="notebook-list" aria-label={t('notebooks')}><div className="notebook-list-heading"><h1>{content.name}</h1><button ref={action} className="icon-button" type="button" aria-label={t('notebookActions')} aria-haspopup="menu" aria-expanded={menu} onClick={() => setMenu(previous => !previous)}><Ellipsis aria-hidden="true" /></button></div><p className="notebook-counts">{notebookCounts({ notes, captures: content.items.length - notes }, language)}</p>
      <ul>{content.items.map(entry => { const Icon = entry.kind === 'area' || entry.kind === 'page' ? Camera : FileText; return <li key={entry.id}><button className={`notebook-list-row${entry.id === item?.id ? ' selected' : ''}`} type="button" aria-current={entry.id === item?.id ? 'true' : undefined} onClick={() => onOpen(id, entry.id)}><Icon aria-hidden="true" /><span>{entry.title || t('newNote')}</span><small>{notebookItemLabel(entry, language)}</small></button></li>; })}</ul>
      {content.items.length > 0 && <button ref={newNote} className="profile-action neutral notebook-new-note" type="button" disabled={busy} onClick={() => { void add(); }}><Plus aria-hidden="true" />{t('newNote')}</button>}
    </aside>
    <div className="notebook-detail">{error && <div className="notebook-view-error" role="alert"><span>{error}</span><button className="text-button" type="button" onClick={() => setAttempt(previous => previous + 1)}>{t('retry')}</button></div>}{loading && <span className="visually-hidden" role="status">{t('loading')}</span>}
      {item ? <NotebookEditor key={item.id} notebook={id} item={item} language={language} edits={edits} readOnly={readOnly} onDelete={() => { void onDelete({ type: 'delete-notebook-item', notebook: id, id: item.id }, 'notebookItemDeleted'); }} /> : <div className="notebook-empty"><h2>{content.name}</h2><p>{t('emptyNotebook')}</p><button className="profile-action primary" type="button" disabled={busy} onClick={() => { void add(); }}>{t('newNote')}</button></div>}
    </div>
    {menu && <NotebookAnchor opener={action}><Menu id="notebook-actions" className="notebook-actions-menu" label={t('notebookActions')} keyboard opener={action} onDismiss={reason => { setMenu(false); if (reason !== 'outside') action.current?.focus(); }}><button type="button" role="menuitem" tabIndex={-1} onClick={() => { setMenu(false); setRename(true); }}><Pencil aria-hidden="true" /><span>{t('renameNotebook')}</span></button><button type="button" role="menuitem" tabIndex={-1} onClick={() => { setMenu(false); void onDelete({ type: 'delete-notebook', id }, 'notebookDeleted'); }}><Trash2 aria-hidden="true" /><span>{t('deleteNotebook')}</span></button></Menu></NotebookAnchor>}
    {rename && <NotebookAnchor opener={action}><div className="notebook-name-popover" role="dialog" aria-label={t('renameNotebook')}><NotebookNameForm language={language} rename={id} initial={content.name} onCancel={() => { setRename(false); action.current?.focus(); }} onSuccess={() => { setRename(false); action.current?.focus(); }} /></div></NotebookAnchor>}
  </section>;
}
