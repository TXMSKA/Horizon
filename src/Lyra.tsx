import { useEffect, useId, useRef, useState } from 'react';
import { Columns2, Download, ExternalLink, FileText, Folder, LayoutDashboard, Link, LoaderCircle, Send, X } from 'lucide-react';
import { copy, text } from './copy';
import type { CopyKey } from './copy';
import type { BrowserCommand, BrowserState, Language } from './shared/api';
import type { LyraCommand, LyraTask } from './shared/lyra';
import { CaptureImage, CaptureProjectPicker, DesktopDropdown, desktopError, itemCount } from './Desktop';
import { SidePanelFaces } from './SidePanelFaces';

export function lyraError(code: string, language: Language): string {
  const known: Record<string, CopyKey> = {
    not_installed: 'lyraNotInstalled', invalid_install: 'lyraUnavailable', unavailable: 'lyraUnavailable',
    model_missing: 'lyraModelMissing', ollama_unavailable: 'lyraOllamaUnavailable', ollama_missing: 'lyraOllamaMissing',
    pending: 'lyraAccessDenied', revoked: 'lyraAccessDenied', forbidden: 'lyraAccessDenied', cancelled: 'lyraCancelled',
  };
  return text(known[code] ?? (Object.hasOwn(copy, code) ? code as CopyKey : 'lyraFailure'), language);
}
export function LyraPanel({ state, language, onClose, onDesktop, tab = false }: { state: BrowserState; language: Language; onClose: () => void; onDesktop: () => void; tab?: boolean }) {
  const lyra = state.lyra, t = (key: CopyKey) => text(key, language), id = useId();
  const [view, setView] = useState<'home' | 'compare' | 'project'>('home');
  const [question, setQuestion] = useState(''), [tabs, setTabs] = useState<string[]>([]);
  const [project, setProject] = useState(state.projectInUse ?? state.projects[0]?.id ?? '');
  const [error, setError] = useState(''), [saving, setSaving] = useState(false), [picker, setPicker] = useState(false), [install, setInstall] = useState(false);
  const lastCommand = useRef<LyraCommand | null>(null), region = useRef<HTMLElement>(null), field = useRef<HTMLInputElement>(null), saveButton = useRef<HTMLButtonElement>(null);
  const inputId = `${id}-question`, busy = ['checking', 'running', 'installing'].includes(lyra.phase);
  const webTabs = state.tabs.filter(tab => /^https?:/.test(tab.url) && !tab.settings && !tab.desktop);
  const active = state.tabs.find(tab => tab.id === state.activeId);
  useEffect(() => { region.current?.focus(); }, []);
  useEffect(() => {
    if (tab && lyra.phase === 'home' && !lyra.open) void window.horizon.command({ type: 'lyra-open' }).catch(reason => setError(desktopError(reason, language)));
  }, [tab, lyra.phase, lyra.open, language]);
  useEffect(() => { if (lyra.phase === 'permission') region.current?.querySelector<HTMLButtonElement>('[data-lyra-allow]')?.focus(); }, [lyra.phase, lyra.permission?.id]);
  const command = async (command: LyraCommand | BrowserCommand) => {
    try { if (command.type.startsWith('lyra-')) lastCommand.current = command as LyraCommand; await window.horizon.command(command); setError(''); return true; }
    catch (reason) { setError(desktopError(reason, language)); return false; }
  };
  const chooseCompare = () => { setView('compare'); setTabs(webTabs.slice(0, 2).map(tab => tab.id)); void command({ type: 'lyra-home' }); };
  const chooseProject = () => { setView('project'); void command({ type: 'lyra-home' }); field.current?.focus(); };
  const ask = (task: LyraTask, value: string) => {
    const followup = lyra.phase === 'answer' && lyra.task === task;
    const sourceTabs = lyra.sources.flatMap(source => { const tab = webTabs.find(tab => tab.id === source.tab && tab.url === source.url); return tab ? [tab.id] : []; });
    const chosen = followup && ['summary', 'comparison', 'question'].includes(task) ? [...new Set(sourceTabs)] : task === 'comparison' ? tabs : (task === 'summary' || task === 'question') && active && /^https?:/.test(active.url) ? [active.id] : [];
    return command({ type: 'lyra-ask', task, question: value, tabs: chosen, project: task === 'project' ? (followup ? lyra.sources[0]?.project : project) || null : task === 'item' ? lyra.sources[0]?.project ?? null : null, item: task === 'item' ? lyra.sources[0]?.item ?? null : null });
  };
  const title = lyra.phase !== 'home' && lyra.phase !== 'checking' ? lyra.task === 'summary' ? t('lyraSummary') : lyra.task === 'comparison' ? t('lyraComparison') : lyra.task === 'project' ? state.projects.find(entry => entry.id === project)?.name ?? t('lyraProject') : t('lyra') : view === 'compare' ? t('lyraChooseTabs') : view === 'project' ? t('lyraProject') : t('lyra');
  const readyView = lyra.phase === 'home' || lyra.phase === 'checking';
  const retry = () => { if (error && lastCommand.current) void command(lastCommand.current); else void command({ type: 'lyra-retry' }); };
  const save = async (destination: string) => {
    if (saving) return; setSaving(true);
    try { if (await command({ type: 'lyra-save', project: destination })) setPicker(false); }
    finally { setSaving(false); }
  };
  return <aside className={`desktop-panel lyra-panel${tab ? ' lyra-tab-view' : ''}`} id="lyra-panel" ref={region} tabIndex={-1} aria-label={t('lyra')} data-phase={lyra.phase} onKeyDown={event => { if (event.key === 'Escape' && !picker) { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    <header className="desktop-panel-header"><SidePanelFaces face="lyra" language={language} onDesktop={onDesktop} onLyra={() => { setView('home'); void command({ type: 'lyra-home' }); }} />{!tab && <button className="icon-button" type="button" aria-label={t('openInTab')} title={t('openInTab')} onClick={() => { void command({ type: 'lyra-tab' }); }}><ExternalLink aria-hidden="true" /></button>}<button className="icon-button" type="button" aria-label={t('closePanel')} title={t('closePanel')} onClick={onClose}><X aria-hidden="true" /></button></header><hr />
    <div className="desktop-panel-body lyra-body"><div className="desktop-title-block"><h1>{title}</h1>{!(lyra.phase === 'failed' && ['model_missing', 'not_installed', 'unavailable', 'invalid_install'].includes(lyra.error ?? '')) && <small>{t('lyraLocal')}</small>}{readyView && view === 'home' && <small>{t('lyraShort')}</small>}</div>
      {readyView && view === 'home' && <div className="lyra-suggestions">
        <button type="button" disabled={busy} onClick={() => { void ask('summary', t('lyraSummarise')); }}><FileText aria-hidden="true" /><span>{t('lyraSummarise')}</span></button>
        <button type="button" disabled={busy} onClick={chooseCompare}><Columns2 aria-hidden="true" /><span>{t('lyraCompareTabs')}</span></button>
        <button type="button" disabled={busy} onClick={chooseProject}><Folder aria-hidden="true" /><span>{t('lyraProject')}</span></button>
      </div>}
      {readyView && view === 'compare' && <><div className="lyra-tabs">{webTabs.map(tab => <label className="lyra-tab" key={tab.id}><input type="checkbox" checked={tabs.includes(tab.id)} onChange={event => setTabs(previous => event.target.checked ? [...previous, tab.id] : previous.filter(id => id !== tab.id))} /><span className="desktop-site-badge" aria-hidden="true">{(tab.title || tab.url).slice(0, 1)}</span><span>{tab.title || tab.url}</span></label>)}</div><small id={`${id}-tabs`}>{t('lyraChooseTwo')}</small><button className="desktop-action primary" type="button" aria-describedby={`${id}-tabs`} onClick={() => { if (tabs.length < 2 || tabs.length > 4) setError(t('lyraChooseTwo')); else void ask('comparison', t('lyraCompareQuestion')); }}>{t('lyraCompare')}</button></>}
      {readyView && view === 'project' && <div className="desktop-field"><label>{t('projectHint')}</label><DesktopDropdown label={t('chooseProject')} value={project} lead={<Folder className="accent" aria-hidden="true" />} choices={state.projects.map(project => ({ id: project.id, name: project.name }))} onChoose={setProject} />{state.projects.find(entry => entry.id === project) ? <small>{itemCount((state.projects.find(entry => entry.id === project)!.pages + state.projects.find(entry => entry.id === project)!.notes + state.projects.find(entry => entry.id === project)!.captures), language)}</small> : <><small>{t('emptyDesktop')}</small><button className="desktop-action" type="button" onClick={onDesktop}>{t('newProject')}</button></>}</div>}
      {!readyView && lyra.attachment && <div className="lyra-attachment"><CaptureImage project={lyra.attachment.project} item={lyra.attachment.item} language={language} preview /></div>}
      {!readyView && lyra.question && <div className="lyra-question"><p>{lyra.question}</p></div>}
      {lyra.phase === 'permission' && lyra.permission && <section className="lyra-permission" aria-label={t('lyraReadQuestion')}><h2>{t('lyraReadQuestion')}</h2><p>{t('lyraReadNotice').replace('{host}', new URL(lyra.permission.origin).host)}</p><div className="lyra-permission-actions"><button data-lyra-allow className="desktop-action primary" type="button" onClick={() => { void command({ type: 'lyra-permission', id: lyra.permission!.id, answer: 'site' }); }}>{t('lyraAllowSite')}</button><div><button className="desktop-action" type="button" onClick={() => { void command({ type: 'lyra-permission', id: lyra.permission!.id, answer: 'once' }); }}>{t('lyraAllowOnce')}</button><button className="desktop-action" type="button" onClick={() => { void command({ type: 'lyra-permission', id: lyra.permission!.id, answer: 'deny' }); }}>{t('lyraDeny')}</button></div></div></section>}
      {lyra.answer && <p className="lyra-answer">{lyra.answer}</p>}
      {['checking', 'running', 'installing'].includes(lyra.phase) && <div className="lyra-loading" role="status"><LoaderCircle className="spinner" aria-hidden="true" /><span>{t(lyra.phase === 'installing' ? 'lyraInstalling' : lyra.phase === 'checking' ? 'loading' : 'lyraWorking')}</span>{lyra.progress && lyra.progress.total > 0 && <progress max={lyra.progress.total} value={lyra.progress.completed} aria-label={t('lyraInstalling')} />}</div>}
      {lyra.phase === 'running' && <button className="desktop-action" type="button" onClick={() => { void command({ type: 'lyra-cancel' }); }}>{t('cancel')}</button>}
      {(error || lyra.phase === 'failed') && <div className="desktop-feedback" role="alert"><p>{error || lyraError(lyra.error ?? 'unavailable', language)}</p>{lyra.error === 'model_missing' && !error ? <button className="desktop-action primary" type="button" onClick={() => setInstall(true)}><Download aria-hidden="true" />{t('lyraInstall')}</button> : lyra.error === 'ollama_unavailable' && !error ? <button className="desktop-action primary" type="button" onClick={() => { void command({ type: 'lyra-start-ollama' }); }}>{t('lyraStartOllama')}</button> : <button className="desktop-action" type="button" onClick={retry}>{t('retry')}</button>}</div>}
      {install && <section className="lyra-permission"><p>{t('lyraInstallNotice')}</p><div className="desktop-actions"><button className="desktop-action" type="button" onClick={() => setInstall(false)}>{t('cancel')}</button><button className="desktop-action primary" type="button" onClick={() => { setInstall(false); void command({ type: 'lyra-install' }); }}>{t('lyraInstallConfirm')}</button></div></section>}
      {lyra.phase === 'answer' && <>{lyra.sources.length > 0 && lyra.task !== 'summary' && <div className="lyra-sources"><small>{t(['project', 'item'].includes(lyra.task) ? 'lyraProjectItems' : 'lyraSources')}</small>{lyra.sources.map((source, index) => <button className="desktop-small-link" type="button" key={index} onClick={() => { if (source.project && source.item) void command({ type: 'open-desktop', id: source.project, item: source.item }); else if (source.url) void command({ type: 'new-tab', input: source.url }); else if (source.item) void window.horizon.command({ type: 'open-desktop-panel', page: { kind: 'item', project: null, id: source.item } }).catch(reason => setError(desktopError(reason, language))); }}><Link aria-hidden="true" /><span>{source.title}</span></button>)}</div>}<div className="desktop-actions"><button className="desktop-action primary" ref={saveButton} type="button" onClick={() => setPicker(true)}><LayoutDashboard aria-hidden="true" />{t('lyraSave')}</button>{lyra.task === 'summary' && <button className="desktop-action" type="button" onClick={chooseCompare}><Columns2 aria-hidden="true" />{t('lyraCompare')}</button>}</div><button className="desktop-small-link lyra-longer" type="button" onClick={() => { void ask(lyra.task, t('lyraLongerQuestion')); }}>{t('lyraLonger')}</button></>}
      {picker && <CaptureProjectPicker state={state} language={language} opener={saveButton} busy={saving} onClose={() => setPicker(false)} onChoose={project => save(project.id)} />}
      <div className="lyra-spacer" /><form className="lyra-ask-field search-field" onSubmit={event => { event.preventDefault(); if (busy || lyra.phase === 'permission') return; void ask(lyra.phase === 'answer' ? lyra.task : view === 'project' ? 'project' : view === 'compare' ? 'comparison' : 'question', question); }}><label className="visually-hidden" htmlFor={inputId}>{t('lyraAsk')}</label><input ref={field} id={inputId} placeholder={t('lyraAsk')} maxLength={2000} value={question} readOnly={busy} onChange={event => setQuestion(event.target.value)} /><button className="icon-button accent" type="submit" aria-label={t('lyraSend')} aria-describedby={busy ? `${id}-busy` : undefined} disabled={busy || lyra.phase === 'permission'}><Send aria-hidden="true" /></button></form>{busy && <small className="visually-hidden" id={`${id}-busy`}>{t('lyraWorking')}</small>}
    </div>
  </aside>;
}
