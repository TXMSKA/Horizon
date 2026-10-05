import { useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import { text } from './copy';
import type { CopyKey } from './copy';
import { SEARCH_ENGINES } from './shared/api';
import type { ImportBrowser, ImportProfile, ImportProgress, ImportResult, ImportSource, Language } from './shared/api';

export interface ImportChoice { browser: ImportBrowser; profile: string; favorites: boolean; history: boolean; searchEngine: boolean }
export type ImportStatus = { kind: 'idle' | 'running' } | { kind: 'done' | 'error'; message: string };

export function importLabel(source: ImportSource, profile: ImportProfile): string {
  return profile.name === source.name ? source.name : `${source.name} · ${profile.name}`;
}

export function importProgressLabel(progress: ImportProgress | null, language: Language): string {
  return progress?.total ? text('importingProgress', language).replace('{current}', String(progress.current)).replace('{total}', String(progress.total)) : text('importingNow', language);
}

export function importResultText(result: ImportResult, language: Language): string {
  const t = (key: CopyKey) => text(key, language), number = new Intl.NumberFormat(language);
  const items = [
    result.favorites > 0 && t(result.favorites === 1 ? 'importedFavoritesOne' : 'importedFavoritesMany').replace('{count}', number.format(result.favorites)),
    result.history > 0 && t(result.history === 1 ? 'importedHistoryOne' : 'importedHistoryMany').replace('{count}', number.format(result.history)),
  ].filter((value): value is string => Boolean(value));
  const sentences = [
    items.length > 0 && t('importedList').replace('{items}', new Intl.ListFormat(language, { style: 'long', type: 'conjunction' }).format(items)),
    result.searchEngine !== null && t('importedSearch').replace('{name}', SEARCH_ENGINES[result.searchEngine].displayName),
    !items.length && result.searchEngine === null && t('importedNothing'),
    result.skipped > 0 && t(result.skipped === 1 ? 'importedSkippedOne' : 'importedSkippedMany').replace('{count}', number.format(result.skipped)),
  ].filter((value): value is string => Boolean(value));
  return sentences.join(' ');
}

export function ImportDialog({ sources, language, profileName, firstRun, status, progress, opener, onClose, onImport }: {
  sources: ImportSource[]; language: Language; profileName: string; firstRun: boolean; status: ImportStatus; progress: ImportProgress | null;
  opener: RefObject<HTMLElement | null> | null; onClose: () => void; onImport: (choice: ImportChoice) => void;
}) {
  const t = (key: CopyKey) => text(key, language), id = useId();
  const dialog = useRef<HTMLDialogElement>(null), first = useRef<HTMLInputElement>(null);
  const options = sources.flatMap(source => source.profiles.map(profile => ({ source, profile })));
  const [selected, setSelected] = useState(0), [wanted, setWanted] = useState({ favorites: true, history: true, searchEngine: true }), [empty, setEmpty] = useState(false);
  const { source, profile } = options[selected]!;
  const choice: ImportChoice = { browser: source.browser, profile: profile.id, favorites: wanted.favorites && profile.favorites, history: wanted.history && profile.history, searchEngine: wanted.searchEngine && profile.searchEngine !== null };
  const running = status.kind === 'running', done = status.kind === 'done';
  useEffect(() => {
    const modal = dialog.current; modal?.showModal(); first.current?.focus();
    return () => { if (modal?.open) modal.close(); opener?.current?.focus(); };
  }, [opener]);
  const dismiss = () => { if (!running) onClose(); };
  const submit = () => {
    if (running) return;
    if (choice.favorites || choice.history || choice.searchEngine) onImport(choice); else setEmpty(true);
  };
  const check = (field: 'favorites' | 'history' | 'searchEngine', label: string, available: boolean) => <label className="settings-checkbox" key={field}>
    <input type="checkbox" checked={choice[field]} disabled={running || !available} onChange={event => { setWanted(previous => ({ ...previous, [field]: event.target.checked })); setEmpty(false); }} /><span aria-hidden="true"><Check /></span><span>{available ? label : `${label} (${t('importUnavailable')})`}</span></label>;
  return <dialog className="settings-dialog import-dialog" ref={dialog} aria-labelledby={`${id}-title`} aria-describedby={`${id}-note`} aria-busy={running} onCancel={event => { event.preventDefault(); dismiss(); }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss(); }
  }}><div className="settings-dialog-heading"><h2 id={`${id}-title`}>{t(firstRun ? 'importFirstTitle' : 'importFrom')}</h2><p id={`${id}-note`} className="setting-hint">{firstRun ? t('importFirstHint') : t('importNote').replace('{name}', profileName)}</p></div>
    {!done && <>
      <div className="settings-clear-options" role="radiogroup" aria-labelledby={`${id}-source`}><span className="import-label" id={`${id}-source`}>{t('importSource')}</span>
        {options.map((option, index) => <label className="settings-checkbox settings-radio" key={`${option.source.browser}:${option.profile.id}`}>
          <input type="radio" name={`${id}-source`} ref={index === 0 ? first : undefined} checked={index === selected} disabled={running} onChange={() => { setSelected(index); setEmpty(false); }} /><span aria-hidden="true"><Check /></span><span>{importLabel(option.source, option.profile)}</span></label>)}
      </div>
      <div className="settings-clear-options" role="group" aria-labelledby={`${id}-what`}><span className="import-label" id={`${id}-what`}>{t('importWhat')}</span>
        {check('favorites', t('importFavoritesOption'), profile.favorites)}{check('history', t('importHistoryOption'), profile.history)}
        {check('searchEngine', profile.searchEngine ? t('importSearchOption').replace('{name}', SEARCH_ENGINES[profile.searchEngine].displayName) : t('importSearchNone'), profile.searchEngine !== null)}
      </div>
      {firstRun && <p className="setting-hint">{t('importNote').replace('{name}', profileName)}</p>}
    </>}
    <div className="settings-feedback" role="status" aria-live="polite">{done ? status.message : ''}</div>
    {empty && <div className="settings-feedback error" role="alert">{t('IMPORT_NO_CHOICE')}</div>}
    {status.kind === 'error' && <div className="settings-feedback error" role="alert"><span>{status.message}</span><button className="settings-button quiet" type="button" onClick={submit}>{t('retry')}</button></div>}
    <div className="settings-dialog-actions">{done ? <button className="settings-button primary" type="button" onClick={onClose}>{t('importDone')}</button> : <>
      <button className="settings-button" type="button" disabled={running} onClick={onClose}>{t(firstRun ? 'importSkip' : 'cancel')}</button>
      <button className="settings-button primary" type="button" disabled={running} onClick={submit}>{running && <LoaderCircle className="spinner" aria-hidden="true" />}{running ? importProgressLabel(progress, language) : t('importButton')}</button>
    </>}</div>
  </dialog>;
}
