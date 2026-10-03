import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { ExternalLink, Folder, FolderInput, FolderPlus, LayoutDashboard, LoaderCircle, Plus, Trash2, X } from 'lucide-react';
import { text } from './copy';
import type { CopyKey } from './copy';
import type { BrowserCommand, BrowserState, DesktopItemContent, DesktopPanelPage, Language, ProjectContent } from './shared/api';
import type { DesktopEdits } from './shared/desktop-edits';
import { CaptureImage, DesktopDropdown, DesktopNameDialog, desktopError, desktopCardLabel, desktopItemLabel, GrowingTextArea, itemCount, ItemMark, itemSite, ProjectNameForm, projectCounts, projectSize, relativeDesktopDate } from './Desktop';
import { DesktopDrop } from './DesktopDrop';

type DesktopProps = {
  state: BrowserState; language: Language; edits: DesktopEdits; readOnly: boolean;
  run: (command: BrowserCommand) => Promise<boolean>;
  onPage: (page: DesktopPanelPage, opener?: HTMLElement) => Promise<boolean>;
  onDelete: (command: BrowserCommand, message: CopyKey) => Promise<void>;
  onModalChange: (open: boolean) => void;
  onDropped: (project: string, item: string) => void;
  addedItem?: { profile: string; project: string; id: string } | null;
};
function Feedback({ error, language, onRetry }: { error: string; language: Language; onRetry: () => void }) {
  return <div className="desktop-feedback" role="alert"><p>{error}</p><button className="desktop-action" type="button" onClick={onRetry}>{text('retry', language)}</button></div>;
}
function Loading({ language }: { language: Language }) {
  return <div className="desktop-loading" role="status" aria-busy="true"><LoaderCircle className="spinner" aria-hidden="true" /><span>{text('loading', language)}</span><div className="desktop-skeleton" /><div className="desktop-skeleton" /><div className="desktop-skeleton" /></div>;
}
function useDesktopContent(project: string | null | undefined, props: DesktopProps) {
  const [data, setData] = useState<{ project: string | null; content: ProjectContent | null; captures: DesktopItemContent[] } | null>(null);
  const [error, setError] = useState(''), [loading, setLoading] = useState(false), [attempt, setAttempt] = useState(0);
  const { state, language } = props;
  useEffect(() => {
    if (project === undefined || state.desktopLocked) return;
    let current = true; setLoading(true); setError('');
    void (project === null ? window.horizon.getCaptures().then(captures => ({ project, content: null, captures })) : window.horizon.getProject(project).then(content => ({ project, content, captures: [] }))).then(next => { if (current) setData(next); })
      .catch(reason => { if (current) setError(desktopError(reason, language)); }).finally(() => { if (current) setLoading(false); });
    return () => { current = false; };
  }, [project, state.desktopVersion, state.desktopLocked, attempt, language]);
  return { content: data && data.project === project ? data.content : null, captures: data && data.project === project ? data.captures : null, error, loading, retry: () => setAttempt(previous => previous + 1) };
}
function StorageState({ props }: { props: DesktopProps }) {
  const { state, language, run } = props;
  return state.desktopLocked || state.desktopStorageError || state.desktopReadError ? <Feedback language={language} error={text(state.desktopLocked ? 'DESKTOP_LOCKED' : state.desktopStorageError ? 'DESKTOP_STORAGE_FAILED' : 'desktopReadFailed', language)} onRetry={() => { void run({ type: 'retry-desktop-storage' }); }} /> : null;
}
function PagePreview({ item }: { item: DesktopItemContent }) {
  return <div className="desktop-page-preview" aria-label={itemSite(item.source?.url ?? '')}><strong>{item.source?.title || item.title}</strong><div aria-hidden="true" /><span aria-hidden="true" /></div>;
}
function Filters({ project, folder, onFilter, language, tab = false }: { project: ProjectContent; folder: string | null; onFilter: (folder: string | null) => void; language: Language; tab?: boolean }) {
  return <div className="desktop-filters">{tab && <button className={`desktop-action${folder === null ? ' primary' : ''}`} type="button" aria-pressed={folder === null} onClick={() => onFilter(null)}>{text('all', language)}</button>}{project.folders.map(entry => <button className={`desktop-action${folder === entry.id ? ' primary' : ''}`} type="button" key={entry.id} aria-pressed={folder === entry.id} onClick={() => onFilter(folder === entry.id ? null : entry.id)}><Folder aria-hidden="true" />{entry.name}</button>)}</div>;
}
function ProjectBody({ project, folder, props, tab = false, selected }: { project: ProjectContent; folder: string | null; props: DesktopProps; tab?: boolean; selected?: string | null }) {
  const { state, language, edits, run, onPage, onModalChange } = props, t = (key: CopyKey) => text(key, language);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [newFolder, setNewFolder] = useState(false), [tabFolder, setTabFolder] = useState<string | null>(null);
  const pending = useRef(false), folderButton = useRef<HTMLButtonElement>(null);
  const chosenFolder = tab ? project.folders.some(entry => entry.id === tabFolder) ? tabFolder : null : folder;
  const items = [...project.items].reverse().filter(item => !chosenFolder || item.folder === chosenFolder);
  const summary = state.projects.find(entry => entry.id === project.id);
  const added = props.addedItem?.profile === state.activeProfileId && props.addedItem.project === project.id ? props.addedItem.id : null;
  const disabled = state.desktopLocked || props.readOnly || busy;
  const add = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try {
      await edits.flush(); const before = await window.horizon.getProject(project.id);
      await window.horizon.command({ type: 'add-note', project: project.id, title: t('newNote'), text: '', folder: chosenFolder });
      const next = await window.horizon.getProject(project.id), added = next.items.find(item => !before.items.some(old => old.id === item.id));
      if (added) await onPage({ kind: 'item', project: project.id, id: added.id });
    } catch (reason) { setError(desktopError(reason, language)); }
    finally { pending.current = false; setBusy(false); }
  };
  const noteButton = <button className="desktop-action" type="button" disabled={disabled} onClick={() => { void add(); }}><Plus aria-hidden="true" />{t('newNote')}</button>;
  const filter = (folder: string | null) => { if (tab) setTabFolder(folder); else void onPage({ kind: 'project', project: project.id, folder }); };
  if (!project.items.length) return <><div className="desktop-title-block"><h1>{project.name}</h1><small>{itemCount(0, language)}</small></div><DesktopDrop props={props} project={project.id} folder={chosenFolder} className="desktop-empty"><p className="desktop-empty-hint">{t('emptyProject')}</p></DesktopDrop>{noteButton}{error && <Feedback language={language} error={error} onRetry={() => { void add(); }} />}</>;
  return <>{tab ? <><div className="desktop-tab-heading"><h1>{project.name}</h1><small>{summary && projectCounts(summary, language)}</small></div><div className="desktop-actions">{noteButton}</div></> : <div className="desktop-project-heading"><DesktopDropdown label={t('chooseProject')} value={project.id} lead={<LayoutDashboard className="accent" aria-hidden="true" />} choices={state.projects.map(entry => ({ id: entry.id, name: entry.name, lead: <Folder aria-hidden="true" /> }))} disabled={disabled} onChoose={id => { void onPage({ kind: 'project', project: id }); }} /><small>{summary && projectCounts(summary, language)}</small></div>}
    <Filters project={project} folder={chosenFolder} onFilter={filter} language={language} tab={tab} />
    {error && <Feedback language={language} error={error} onRetry={() => { void add(); }} />}
    <DesktopDrop props={props} project={project.id} folder={chosenFolder} className={tab ? 'desktop-cards' : 'desktop-items'}>{items.length ? items.map(item => tab ? <article className={`desktop-card${selected === item.id || added === item.id ? ' selected' : ''}`} key={item.id}>
      {item.image ? <CaptureImage project={project.id} item={item} language={language} preview /> : item.kind === 'link' ? <PagePreview item={item} /> : <div className="desktop-card-kind"><ItemMark item={item} /><small>{t(item.kind === 'note' ? 'captureNote' : 'noteText')}</small></div>}
      <button className="desktop-card-target" type="button" onClick={event => { void onPage({ kind: 'item', project: project.id, id: item.id }, event.currentTarget); }}><div className="desktop-card-title">{item.kind === 'link' && <ItemMark item={item} />}<strong>{item.title || t('newNote')}</strong></div><small>{added === item.id ? t('desktopAddedNow') : desktopCardLabel(item, language)}</small>{!item.image && item.kind !== 'link' && <p>{item.text}</p>}
    </button></article> : <button className={`desktop-item-row${selected === item.id || added === item.id ? ' selected' : ''}`} type="button" key={item.id} onClick={() => { void onPage({ kind: 'item', project: project.id, id: item.id }); }}><ItemMark item={item} /><span><strong>{item.title || t('newNote')}</strong><small>{added === item.id ? t('desktopAddedNow') : item.kind === 'note' ? item.text || desktopItemLabel(item, language) : item.kind === 'link' ? itemSite(item.source?.url ?? '') : t('savedDate').replace('{date}', relativeDesktopDate(item.createdAt, language))}</small></span></button>) : <p className="desktop-empty-hint">{t('emptyFolder')}</p>}</DesktopDrop>
    {!tab && <div className="desktop-project-foot"><DesktopDrop props={props} project={project.id} folder={chosenFolder} /><div className="desktop-actions">{noteButton}<button className="desktop-action" ref={folderButton} type="button" disabled={disabled} onClick={() => setNewFolder(true)}><FolderPlus aria-hidden="true" />{t('newFolder')}</button></div></div>}
    {newFolder && <DesktopNameDialog state={state} language={language} folder={project.id} opener={folderButton} onModalChange={onModalChange} onClose={() => setNewFolder(false)} onSuccess={async () => { setNewFolder(false); await run({ type: 'set-project', id: project.id }); }} />}
  </>;
}
function ItemDetail({ project, item, props }: { project: ProjectContent | null; item: DesktopItemContent; props: DesktopProps }) {
  const { language, edits, state, onPage, onDelete, run } = props, t = (key: CopyKey) => text(key, language), id = useId();
  const [draft, setDraft] = useState(() => ({ title: item.title, text: item.text, note: item.note, ...edits.fields(project?.id ?? null, item.id) }));
  const title = useRef<HTMLDivElement>(null);
  useEffect(() => { setDraft({ title: item.title, text: item.text, note: item.note, ...edits.fields(project?.id ?? null, item.id) }); }, [project?.id, item.id, item.title, item.text, item.note, edits]);
  useEffect(() => { title.current?.querySelector<HTMLInputElement>('input')?.focus(); }, [item.id]);
  const change = (field: 'title' | 'text' | 'note', value: string) => { setDraft(previous => ({ ...previous, [field]: value })); edits.change(project?.id ?? null, item.id, { [field]: value }); };
  const folder = project?.folders.find(folder => folder.id === item.folder);
  const breadcrumb = <button className="desktop-breadcrumb" type="button" onClick={() => { void onPage(project ? { kind: 'project', project: project.id, folder: item.folder } : { kind: 'captures' }); }}>{project?.name ?? t('captures')}{folder ? ` / ${folder.name}` : ''}</button>;
  const readOnly = props.readOnly || state.desktopLocked;
  const remove = () => { void onDelete(project ? { type: 'delete-item', project: project.id, id: item.id } : { type: 'delete-capture', id: item.id }, 'desktopItemDeleted'); };
  return <article className="desktop-detail" aria-label={draft.title || t('newNote')}>{item.kind === 'note' ? <>{breadcrumb}<div className="desktop-field" ref={title}><label htmlFor={`${id}-title`}>{t('noteTitle')}</label><input className="desktop-note-title" id={`${id}-title`} value={draft.title} maxLength={200} readOnly={readOnly} onChange={event => change('title', event.target.value)} /></div><div className="desktop-field"><label htmlFor={`${id}-text`}>{t('noteText')}</label><GrowingTextArea className="desktop-note-text" id={`${id}-text`} value={draft.text} maxLength={100000} readOnly={readOnly} onChange={event => change('text', event.target.value)} /></div><small>{t('savedAsYouType')}</small></> : <><div className="desktop-title-block">{breadcrumb}<h1>{draft.title || t('newNote')}</h1></div>{item.source && <div className="desktop-site"><ItemMark item={item} /><small>{itemSite(item.source.url)}</small></div>}{item.image ? <CaptureImage project={project?.id ?? null} item={item} language={language} /> : item.kind === 'link' ? <PagePreview item={item} /> : <p className="desktop-kept-text">{item.text}</p>}{item.image?.cut && <small>{t('captureCut')}</small>}<div className="desktop-field"><label htmlFor={`${id}-note`}>{t('captureNote')}</label><GrowingTextArea className="desktop-note-text annotation" id={`${id}-note`} value={draft.note} maxLength={20000} readOnly={readOnly} onChange={event => change('note', event.target.value)} /></div><div className="desktop-item-actions">{item.source && <button className="desktop-action" type="button" onClick={() => { void run({ type: 'new-tab', input: item.source!.url }); }}><ExternalLink aria-hidden="true" />{t('openPage')}</button>}{project && <DesktopDropdown label={t('moveToFolder')} variant="action" display={t('moveToFolder')} value={item.folder ?? ''} lead={<FolderInput aria-hidden="true" />} choices={[{ id: '', name: t('noFolder') }, ...project.folders.map(folder => ({ id: folder.id, name: folder.name, lead: <Folder aria-hidden="true" /> }))]} disabled={readOnly} onChoose={folder => { void run({ type: 'move-item-folder', project: project.id, id: item.id, folder: folder || null }); }} />}<button className="desktop-action" type="button" disabled={readOnly} onClick={remove}><Trash2 aria-hidden="true" />{t('delete')}</button></div></>}</article>;
}
function CapturesGrid({ items, props }: { items: DesktopItemContent[]; props: DesktopProps }) {
  const { state, language, run, onPage, onModalChange } = props, t = (key: CopyKey) => text(key, language);
  const [creating, setCreating] = useState<string | null>(null), opener = useRef<HTMLElement | null>(null);
  return items.length ? <div className="desktop-captures-grid">{[...items].reverse().map(item => <div className="desktop-capture-card" key={item.id}><CaptureImage project={null} item={item} language={language} preview /><div className="desktop-capture-caption"><strong>{item.title}</strong><DesktopDropdown label={t('addToProject')} variant="link" value="" choices={[...state.projects.map(project => ({ id: project.id, name: project.name, lead: <Folder aria-hidden="true" /> })), { id: 'new', name: t('newProject'), lead: <Plus aria-hidden="true" /> }]} disabled={state.desktopLocked || props.readOnly} onChoose={project => {
    if (project === 'new') { opener.current = document.activeElement as HTMLElement; setCreating(item.id); }
    else void run({ type: 'add-capture-to-project', id: item.id, project, folder: null });
  }} /></div><button className="desktop-preview-target" type="button" aria-label={t('openItem').replace('{title}', item.title)} onClick={event => { void onPage({ kind: 'item', project: null, id: item.id }, event.currentTarget); }}></button></div>)}{creating && <DesktopNameDialog state={state} language={language} opener={opener} onModalChange={onModalChange} onClose={() => setCreating(null)} onSuccess={async project => { if (await run({ type: 'add-capture-to-project', id: creating, project: project.id, folder: null })) setCreating(null); }} />}</div> : <div className="desktop-empty"><p>{t('noCaptures')}</p><small>{t('noCapturesHint')}</small></div>;
}
function Home({ props }: { props: DesktopProps }) {
  const { state, language, onPage } = props, t = (key: CopyKey) => text(key, language);
  return <><h1>{t('desktop')}</h1>{!state.projects.length && !state.captures.length ? <div className="desktop-empty"><p>{t('emptyDesktop')}</p><button className="desktop-action primary" type="button" onClick={() => { void onPage({ kind: 'new-project' }); }}>{t('newProject')}</button></div> : <><section className="desktop-latest"><div className="desktop-section-heading"><h2>{t('captures')}</h2><button className="desktop-small-link" type="button" onClick={() => { void onPage({ kind: 'captures' }); }}>{t('seeAll')}</button></div>{state.captures.length ? <div className="desktop-latest-images">{[...state.captures].sort((a, b) => b.createdAt - a.createdAt).slice(0, 3).map(item => <div key={item.id}><CaptureImage project={null} item={item} language={language} preview /><button className="desktop-preview-target" type="button" aria-label={t('openItem').replace('{title}', item.title)} onClick={() => { void onPage({ kind: 'item', project: null, id: item.id }); }} /></div>)}</div> : <small>{t('noCaptures')}</small>}</section><section className="desktop-project-list"><h2>{t('projects')}</h2>{state.projects.map(project => <button className="desktop-project-row" type="button" key={project.id} onClick={() => { void onPage({ kind: 'project', project: project.id }); }}><span className="desktop-mark"><Folder aria-hidden="true" /></span><span>{project.name}</span><small>{itemCount(projectSize(project), language)}</small></button>)}</section><button className="desktop-action desktop-home-new" type="button" onClick={() => { void onPage({ kind: 'new-project' }); }}><Plus aria-hidden="true" />{t('newProject')}</button></>}</>;
}

export function DesktopPanel({ props, onClose, onTab }: { props: DesktopProps; onClose: () => void; onTab: () => void }) {
  const { state, language, onPage } = props, page = state.desktopPanel.page, t = (key: CopyKey) => text(key, language);
  const titleId = useId(), region = useRef<HTMLElement>(null), lastSelected = useRef<string | null>(null);
  const project = page.kind === 'project' || page.kind === 'item' ? page.project : page.kind === 'captures' ? null : undefined;
  const data = useDesktopContent(project, props), focusPage = page.kind === 'item' ? page.id : page.kind === 'project' ? page.folder ?? '' : '';
  useEffect(() => {
    const panel = region.current;
    if (panel && !panel.contains(document.activeElement)) panel.focus();
  }, [page.kind, project, focusPage]);
  useLayoutEffect(() => { if (page.kind === 'item') lastSelected.current = page.id; }, [page]);
  const item = page.kind === 'item' ? (data.content?.items ?? data.captures)?.find(item => item.id === page.id) : null;
  const destination = project ?? state.projectInUse;
  let content: ReactNode;
  if (page.kind === 'home') content = <Home props={props} />;
  else if (page.kind === 'new-project') content = <><h1>{t('newProject')}</h1><ProjectNameForm state={state} language={language} onSuccess={project => { void onPage({ kind: 'project', project: project.id }); }} /></>;
  else if (state.desktopLocked) content = null;
  else if (data.error && !data.content && !data.captures) content = <Feedback language={language} error={data.error} onRetry={data.retry} />;
  else if (page.kind === 'captures' && data.captures) content = <><div className="desktop-title-block"><h1>{t('captures')}</h1><small>{t('keptOnComputer')}</small></div><CapturesGrid items={data.captures} props={props} /></>;
  else if (page.kind === 'project' && data.content) content = <ProjectBody key={page.project} project={data.content} folder={page.folder ?? null} props={props} selected={lastSelected.current} />;
  else if (page.kind === 'item' && item) content = <ItemDetail key={item.id} project={data.content} item={item} props={props} />;
  else if (!data.loading && page.kind === 'item' && (data.content || data.captures)) content = <Feedback language={language} error={t('DESKTOP_ITEM_NOT_FOUND')} onRetry={data.retry} />;
  else content = <Loading language={language} />;
  return <aside ref={region} className="desktop-panel" tabIndex={-1} aria-labelledby={titleId} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } }}><header className="desktop-panel-header"><h2 id={titleId}>{t('desktop')}</h2><button className="icon-button" type="button" aria-label={t('openInTab')} title={t('openInTab')} onClick={onTab}><ExternalLink aria-hidden="true" /></button><button className="icon-button" type="button" aria-label={t('closePanel')} title={t('closePanel')} onClick={onClose}><X aria-hidden="true" /></button></header><hr />{page.kind !== 'project' && destination && state.projects.some(project => project.id === destination) ? <DesktopDrop props={props} project={destination} className="desktop-panel-body" transientName={state.projects.find(project => project.id === destination)!.name} onKept={() => { void onPage({ kind: 'project', project: destination }); }}><StorageState props={props} />{data.error && (data.content || data.captures) && <Feedback language={language} error={data.error} onRetry={data.retry} />}{content}</DesktopDrop> : <div className="desktop-panel-body"><StorageState props={props} />{data.error && (data.content || data.captures) && <Feedback language={language} error={data.error} onRetry={data.retry} />}{content}</div>}</aside>;
}
export function DesktopTab({ id, selected, props, onOpen }: { id: string; selected: string | null; props: DesktopProps; onOpen: (id: string) => void }) {
  const { state, language, onPage } = props, t = (key: CopyKey) => text(key, language), data = useDesktopContent(id === 'captures' ? null : id, props);
  return <section className="desktop-tab" aria-label={t('desktop')}><nav className="desktop-rail" aria-label={t('projects')}><div className="desktop-rail-heading"><LayoutDashboard className="accent" aria-hidden="true" /><strong>{t('desktop')}</strong></div><h2>{t('projects')}</h2>{state.projects.map(project => <button className={`desktop-project-row${id === project.id ? ' selected' : ''}`} type="button" key={project.id} aria-current={id === project.id ? 'page' : undefined} onClick={() => onOpen(project.id)}><span className="desktop-mark"><Folder aria-hidden="true" /></span><span>{project.name}</span></button>)}<button className="desktop-action desktop-home-new" type="button" onClick={event => { void onPage({ kind: 'new-project' }, event.currentTarget); }}><Plus aria-hidden="true" />{t('newProject')}</button></nav><div className="desktop-tab-body"><StorageState props={props} />{data.error && <Feedback language={language} error={data.error} onRetry={data.retry} />}{state.desktopLocked ? null : id === 'captures' ? <><div className="desktop-title-block"><h1>{t('captures')}</h1><small>{t('keptOnComputer')}</small></div>{data.captures ? <CapturesGrid items={data.captures} props={props} /> : !data.error && <Loading language={language} />}</> : data.content ? <ProjectBody project={data.content} folder={null} props={props} tab selected={selected} /> : !data.error && <Loading language={language} />}</div></section>;
}
