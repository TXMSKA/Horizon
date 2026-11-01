import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import { Ellipsis, Languages, LoaderCircle, X } from 'lucide-react';
import { copy, text } from './copy';
import type { CopyKey } from './copy';
import type { BrowserState, Language } from './shared/api';
import type { TranslateCommand, TranslateState } from './shared/translate';
import { DesktopDropdown } from './Desktop';
import { LYRA_CLI_NAMES, lyraErrorKey, lyraManaged, translationNotice, translationTargetNotice } from './shared/lyra';
import { ToolbarPopover } from './ToolbarPopover';
import { Switch } from './Switch';

export function translationError(code: string, language: Language) {
  const known: Record<string, CopyKey> = {
    cancelled: 'translationCancelled', TRANSLATE_LIMIT: 'translationLimit', TRANSLATE_PAGE_CHANGED: 'translationChanged',
    TRANSLATE_LANGUAGE_UNKNOWN: 'translationUnknown', TRANSLATE_EXCLUDED: 'translationExcluded', TRANSLATE_BUSY: 'translationBusy',
    TRANSLATE_NO_SOURCE: 'lyraNoSource',
  };
  return text(known[code] ?? lyraErrorKey(code) as CopyKey | undefined ?? (Object.hasOwn(copy, code) ? code as CopyKey : 'translationFailed'), language);
}
// Where a running translation goes: the source from its start event, on this computer when no external source can take it, otherwise not yet known.
export function translationRunning(value: Pick<TranslateState, 'external' | 'answeredBy'>, language: Language) {
  const source = value.answeredBy;
  if (!source) return text(value.external === false ? 'translating' : 'translatingPending', language);
  const key: CopyKey = source.kind === 'local' ? 'translating' : source.kind === 'key' ? 'translatingKey' : 'translatingCli';
  return text(key, language).replace('{model}', source.model).replace('{source}', LYRA_CLI_NAMES[source.id] ?? source.id);
}
export function translationLanguage(code: string | null, language: Language) {
  if (!code) return '';
  return new Intl.DisplayNames([language], { type: 'language' }).of(code) ?? code;
}

export function TranslateBar({ value, state, language, options, onOptions, dismiss }: {
  value: TranslateState; state: BrowserState; language: Language; options: boolean; onOptions: (open: boolean) => void; dismiss: boolean;
}) {
  const t = (key: CopyKey) => text(key, language), id = useId();
  const anchor = useRef<HTMLSpanElement>(null), opener = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const pending = useRef(false), [error, setError] = useState(''), [saving, setSaving] = useState(false);
  const dismissMenu = useRef(onOptions);
  useLayoutEffect(() => { dismissMenu.current = onOptions; });
  useEffect(() => { if (dismiss) dismissMenu.current(false); }, [dismiss]);
  useEffect(() => {
    if (!options) return;
    menu.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: PointerEvent) => {
      if (!menu.current?.contains(event.target as Node) && !opener.current?.contains(event.target as Node) && !(event.target as Element).closest('.desktop-choice-menu')) dismissMenu.current(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [options]);
  const command = async (command: TranslateCommand) => {
    if (pending.current) return;
    pending.current = true; setSaving(true); setError('');
    try { await window.horizon.command(command); }
    catch (reason) {
      const code = reason instanceof Error ? reason.message.match(/\b(?:TRANSLATE_|SITE_SETTINGS_)[A-Z_]+\b/)?.[0] : undefined;
      setError(translationError(code ?? 'failure', language));
    } finally { pending.current = false; setSaving(false); }
  };
  const closeMenu = (focus = true) => { onOptions(false); if (focus) opener.current?.focus(); };
  const action = (value: TranslateCommand) => { closeMenu(); void command(value); };
  const source = translationLanguage(value.source, language), target = translationLanguage(value.target, language);
  const busy = value.phase === 'running' || value.phase === 'detecting';
  const failed = value.phase === 'failed';
  // A missing or stopped Lyra opens the assistant, which offers the install; anything about models, keys or CLIs opens Lyra's own app.
  const needsLyra = ['ollama_unavailable', 'not_installed', 'unavailable', 'invalid_install'].includes(value.error ?? '');
  const manage = lyraManaged(value.error === 'TRANSLATE_NO_SOURCE' ? 'no_source' : value.error);
  const always = state.store.siteSettings.translation?.always.some(entry => entry.language === value.source && entry.target === value.target) ?? false;
  // A failed automatic run is retried locally; translating through an external source takes a new request by the person.
  const manual = failed && value.error === 'TRANSLATE_LOCAL_REQUIRED';
  // Before a request that may leave this computer, the offer says so.
  const external = translationNotice(value);
  const status = busy ? value.phase === 'detecting' ? t('detectingLanguage') : translationRunning(value, language) : failed ? translationError(value.error ?? 'failure', language)
    : !value.source ? t(value.phase === 'translated' ? 'translatedAuto' : 'originalLanguageUnknown') : t(value.phase === 'translated' ? 'translatedFrom' : 'originalLanguage').replace('{language}', source);
  // An error from the last click replaces the status but never the external line, which the next click is taken under.
  const shown = error || status;
  const label = external ? `${shown}${/[.!?]$/.test(shown) ? '' : '.'} ${t('translateExternal')}` : shown;
  const start = <button className="settings-button" type="button" data-translate-action onClick={() => { void command({ type: value.phase === 'translated' ? 'translate-original' : 'translate-start' }); }}>{value.phase === 'translated' ? t('showOriginal') : t('translateToLanguage').replace('{language}', target)}</button>;
  return <div className="translation-bar" aria-label={t('translation')} data-phase={value.phase} aria-busy={busy || saving}>
    {busy ? <LoaderCircle className="spinner accent" aria-hidden="true" /> : <Languages className="accent" aria-hidden="true" />}
    <span className="translation-status" role={failed || error ? 'alert' : 'status'}>{label}</span>
    {busy ? <button className="settings-button" type="button" onClick={() => { void command({ type: 'translate-cancel' }); }}>{t('cancel')}</button> : failed ? <>
      {needsLyra && <button className="settings-button" type="button" onClick={() => { closeMenu(false); void window.horizon.command({ type: 'lyra-home' }).catch(() => setError(t('lyraUnavailable'))); }}>{t('openLyra')}</button>}
      {manage && <button className="settings-button" type="button" onClick={() => { closeMenu(false); void window.horizon.command({ type: 'lyra-manage' }).catch(reason => setError(t(reason instanceof Error && reason.message.includes('LYRA_APP_MISSING') ? 'LYRA_APP_MISSING' : 'LYRA_APP_UNAVAILABLE'))); }}>{t('openLyra')}</button>}
      {manual ? start : <button className="settings-button" type="button" onClick={() => { void command({ type: 'translate-retry' }); }}>{t('retry')}</button>}
    </> : start}
    {!busy && value.source && value.phase !== 'original' && <span className="translation-menu-anchor" ref={anchor}><button className="icon-button" type="button" ref={opener} aria-label={t('translateOptions')} title={t('translateOptions')} aria-haspopup="dialog" aria-expanded={options} aria-controls={options ? id : undefined} data-translate-options onClick={() => onOptions(!options)}><Ellipsis aria-hidden="true" /></button></span>}
    {value.phase !== 'original' && <button className="icon-button" type="button" aria-label={t('closeTranslation')} title={t('closeTranslation')} onClick={() => { closeMenu(false); void command({ type: 'translate-close' }); }}><X aria-hidden="true" /></button>}
    {options && <ToolbarPopover opener={anchor}><div className="translation-options" ref={menu} role="dialog" aria-label={t('translateOptions')} id={id} onKeyDown={event => {
      if (event.defaultPrevented) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); closeMenu(); }
      if (event.key === 'Tab') {
        const stops = [...(menu.current?.querySelectorAll<HTMLElement>('button:not(:disabled)') ?? [])];
        if (document.activeElement === (event.shiftKey ? stops[0] : stops.at(-1))) { event.preventDefault(); closeMenu(); }
      }
    }}>
      <div className="translation-language"><span className="profiles-label">{t('translateTo')}</span><DesktopDropdown label={t('translateTo')} value={value.target} choices={(['en', 'es'] as const).map(id => ({ id, name: translationLanguage(id, language) }))} disabled={saving} onChoose={target => action({ type: 'translate-target', value: target as Language })} />{translationTargetNotice(value) && <small data-translate-external>{t('translateExternal')}</small>}</div>
      <div className="translation-choice"><span id={`${id}-always`}>{t('alwaysTranslate').replace('{language}', source)}</span><Switch checked={always} labelledBy={`${id}-always`} disabled={saving} onChange={enabled => { void command({ type: 'translate-always', enabled }); }} /></div>
      <button className="translation-option" type="button" disabled={saving} data-translate-never onClick={() => action({ type: 'translate-never', enabled: true })}>{t('neverTranslate')}</button>
      <button className="translation-option" type="button" disabled={saving} onClick={() => action({ type: 'translate-original' })}>{t('showOriginal')}</button>
    </div></ToolbarPopover>}
  </div>;
}
