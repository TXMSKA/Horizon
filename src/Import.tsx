import { useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Check, LoaderCircle } from 'lucide-react';
import { text } from './copy';
import type { CopyKey } from './copy';
import { SEARCH_ENGINES } from './shared/api';
import type { ImportBrowser, ImportPasswordsFile, ImportPasswordsResult, ImportProfile, ImportProgress, ImportResult, ImportSettingName, ImportSettingsSummary, ImportSource, Language, VaultCommand, VaultState } from './shared/api';
import { VaultImportPermission, VaultUnlock } from './Vault';

export interface ImportChoice { browser: ImportBrowser; profile: string; favorites: boolean; history: boolean; searchEngine: boolean; settings: boolean }
interface ImportOutcome { browser: ImportResult | null; passwords: ImportPasswordsResult | null }
type ImportWanted = { favorites: boolean; history: boolean; searchEngine: boolean; settings: boolean; passwords: boolean };

const SETTING_LABELS: Record<ImportSettingName, CopyKey> = {
  onStart: 'importSettingOnStart', downloadsFolder: 'importSettingDownloads', askWhereToSave: 'importSettingAsk', blockThirdPartyCookies: 'importSettingCookies', language: 'importSettingLanguage',
  theme: 'importSettingTheme', darkPages: 'importSettingDark', clearHistoryOnClose: 'importSettingClearHistory', clearCacheOnClose: 'importSettingClearCache',
};

export function importLabel(source: ImportSource, profile: ImportProfile): string {
  return profile.name === source.name ? source.name : `${source.name} · ${profile.name}`;
}

export function importProgressLabel(progress: ImportProgress | null, language: Language): string {
  return progress?.total ? text('importingProgress', language).replace('{current}', String(progress.current)).replace('{total}', String(progress.total)) : text('importingNow', language);
}

const counted = (language: Language, count: number, one: CopyKey, many: CopyKey): string => text(count === 1 ? one : many, language).replace('{count}', new Intl.NumberFormat(language).format(count));
const listed = (language: Language, items: string[]): string => new Intl.ListFormat(language, { style: 'long', type: 'conjunction' }).format(items);

// What a profile holds, or what an import changed, as the phrases of one list: the named settings, then the counted ones.
export function importSettingsItems(summary: ImportSettingsSummary, language: Language): string[] {
  return [
    ...summary.names.map(name => text(SETTING_LABELS[name], language)),
    ...(summary.sitePermissions > 0 ? [counted(language, summary.sitePermissions, 'importSitePermissionsOne', 'importSitePermissionsMany')] : []),
    ...(summary.translations > 0 ? [counted(language, summary.translations, 'importTranslationsOne', 'importTranslationsMany')] : []),
  ];
}

export function importResultText(result: ImportResult | null, passwords: ImportPasswordsResult | null, language: Language): string {
  const t = (key: CopyKey) => text(key, language);
  const items = result ? [
    result.favorites > 0 && counted(language, result.favorites, 'importedFavoritesOne', 'importedFavoritesMany'),
    result.history > 0 && counted(language, result.history, 'importedHistoryOne', 'importedHistoryMany'),
  ].filter((value): value is string => Boolean(value)) : [];
  const settings = result ? importSettingsItems(result.settings, language) : [];
  const sentences = [
    items.length > 0 && t('importedList').replace('{items}', listed(language, items)),
    settings.length > 0 && t('importedSettings').replace('{items}', listed(language, settings)),
    result !== null && result.searchEngine !== null && t('importedSearch').replace('{name}', SEARCH_ENGINES[result.searchEngine].displayName),
    result !== null && !items.length && !settings.length && result.searchEngine === null && passwords === null && t('importedNothing'),
    result !== null && result.skipped > 0 && counted(language, result.skipped, 'importedSkippedOne', 'importedSkippedMany'),
    passwords !== null && (passwords.imported > 0 ? counted(language, passwords.imported, 'importedPasswordsOne', 'importedPasswordsMany') : t('importedPasswordsNone')),
    passwords !== null && passwords.duplicates > 0 && counted(language, passwords.duplicates, 'importedPasswordsDuplicateOne', 'importedPasswordsDuplicateMany'),
    passwords !== null && passwords.skipped > 0 && counted(language, passwords.skipped, 'importedPasswordsSkippedOne', 'importedPasswordsSkippedMany'),
  ].filter((value): value is string => Boolean(value));
  return sentences.join(' ');
}

export function ImportDialog({ sources, language, profileName, firstRun, vault, progress, opener, describe, onClose }: {
  sources: ImportSource[]; language: Language; profileName: string; firstRun: boolean; vault: VaultState; progress: ImportProgress | null;
  opener: RefObject<HTMLElement | null> | null; describe: (reason: unknown) => string; onClose: () => void;
}) {
  const t = (key: CopyKey) => text(key, language), id = useId();
  const dialog = useRef<HTMLDialogElement>(null), first = useRef<HTMLInputElement>(null), importButton = useRef<HTMLButtonElement>(null);
  const deleteButton = useRef<HTMLButtonElement>(null), keepButton = useRef<HTMLButtonElement>(null), doneButton = useRef<HTMLButtonElement>(null);
  const busy = useRef(false), afterUnlock = useRef(false), confirming = useRef(false);
  // What the first step brought stays here, so a retry after a failed second step does not start the first one again.
  const partial = useRef<ImportOutcome>({ browser: null, passwords: null });
  const options = sources.flatMap(source => source.profiles.map(profile => ({ source, profile })));
  const [selected, setSelected] = useState(0), [wanted, setWanted] = useState<ImportWanted>({ favorites: true, history: true, searchEngine: true, settings: true, passwords: false });
  const [problem, setProblem] = useState(''), [file, setFile] = useState<ImportPasswordsFile | null>(null), [choosing, setChoosing] = useState(false);
  const [probe, setProbe] = useState<'idle' | 'checking' | 'done'>('idle'), [unlock, setUnlock] = useState(false), [permission, setPermission] = useState(false);
  const [phase, setPhase] = useState<'idle' | 'running' | 'error' | 'done'>('idle'), [failure, setFailure] = useState(''), [outcome, setOutcome] = useState<ImportOutcome | null>(null);
  const [removal, setRemoval] = useState<'idle' | 'confirm' | 'running' | 'done'>('idle'), [removalError, setRemovalError] = useState('');
  const { source, profile } = options[selected]!;
  const vaultKnown = vault.available || probe === 'done';
  const vaultReason: CopyKey | null = !vaultKnown ? null : vault.error !== null || !vault.available ? 'importPasswordsNoVault' : !vault.created ? 'importPasswordsNoVaultCreated' : null;
  const passwords = wanted.passwords && vaultReason === null;
  const choice: ImportChoice = { browser: source.browser, profile: profile.id, favorites: wanted.favorites && profile.favorites, history: wanted.history && profile.history, searchEngine: wanted.searchEngine && profile.searchEngine !== null, settings: wanted.settings && profile.settings !== null };
  const browserData = choice.favorites || choice.history || choice.searchEngine || choice.settings;
  const running = phase === 'running', done = phase === 'done';
  useEffect(() => {
    const modal = dialog.current; modal?.showModal(); first.current?.focus();
    return () => { if (modal?.open) modal.close(); opener?.current?.focus(); };
  }, [opener]);
  // Focus follows the confirmation: into it when it opens, back to the control that opened it when it closes without deleting.
  useEffect(() => {
    if (removal === 'confirm') { confirming.current = true; keepButton.current?.focus(); }
    else if (removal === 'idle' && confirming.current) { confirming.current = false; deleteButton.current?.focus(); }
    else if (removal === 'done') { confirming.current = false; doneButton.current?.focus(); }
  }, [removal]);
  const dismiss = () => { if (!running) onClose(); };
  const changed = () => { setProblem(''); partial.current = { browser: null, passwords: null }; };
  const run = async () => {
    if (busy.current) return;
    busy.current = true; setProblem(''); setPhase('running');
    try {
      if (browserData && !partial.current.browser) partial.current.browser = await window.horizon.command({ type: 'import-browser-data', ...choice });
      if (passwords && file && !partial.current.passwords) partial.current.passwords = await window.horizon.command({ type: 'import-passwords', browser: choice.browser, file: file.id });
      setOutcome({ ...partial.current }); setPhase('done');
    } catch (reason) { setFailure(describe(reason)); setPhase('error'); }
    finally { busy.current = false; }
  };
  const vaultAction = (command: VaultCommand) => window.horizon.command(command).then(() => true, () => false);
  // Windows Hello is tried first where it exists; the master password step opens in place when it is not available or does not answer.
  const requestUnlock = async () => {
    if (busy.current) return;
    busy.current = true; setPhase('running');
    const unlocked = vault.windows && await vaultAction({ type: 'vault-hello' });
    busy.current = false; setPhase('idle');
    if (unlocked) void run(); else setUnlock(true);
  };
  const submit = () => {
    if (running) return;
    if (!browserData && !passwords) { setProblem(t('IMPORT_NO_CHOICE')); return; }
    if (passwords && !file) { setProblem(t('IMPORT_PASSWORDS_NO_FILE')); return; }
    // Until Vault has given Horizon the permission the approval comes first, and it also unlocks Vault.
    if (passwords && !vault.importAllowed) { setPermission(true); return; }
    if (passwords && !vault.unlocked) { void requestUnlock(); return; }
    void run();
  };
  const choose = () => {
    if (running || choosing) return;
    setChoosing(true); setProblem('');
    window.horizon.command({ type: 'choose-import-passwords-file' }).then(picked => { if (picked) { setFile(picked); changed(); } }, (reason: unknown) => setProblem(describe(reason))).finally(() => setChoosing(false));
  };
  const togglePasswords = (checked: boolean) => {
    setWanted(previous => ({ ...previous, passwords: checked })); changed();
    // Vault is asked about only once the person shows interest in passwords.
    if (checked && !vault.available && probe === 'idle') { setProbe('checking'); window.horizon.command({ type: 'vault-refresh' }).catch(() => undefined).finally(() => setProbe('done')); }
  };
  const removeFile = () => {
    if (!file || removal === 'running') return;
    setRemoval('running'); setRemovalError('');
    window.horizon.command({ type: 'delete-import-passwords-file', file: file.id }).then(() => { setRemoval('done'); setFile(null); }, (reason: unknown) => { setRemovalError(describe(reason)); setRemoval('idle'); });
  };
  const check = (field: 'favorites' | 'history' | 'searchEngine' | 'settings', label: string, available: boolean) => <label className="settings-checkbox" key={field}>
    <input type="checkbox" checked={choice[field]} disabled={running || !available} onChange={event => { setWanted(previous => ({ ...previous, [field]: event.target.checked })); changed(); }} /><span aria-hidden="true"><Check /></span><span>{available ? label : `${label} (${t('importUnavailable')})`}</span></label>;
  const found = profile.settings ? importSettingsItems(profile.settings, language) : [];
  const hint: CopyKey = source.browser === 'edge' ? 'importPasswordsHintEdge' : source.browser === 'firefox' ? 'importPasswordsHintFirefox' : 'importPasswordsHintChrome';
  const passwordsLabel = <><label className="settings-checkbox">
    <input type="checkbox" checked={passwords} disabled={running || probe === 'checking' || vaultReason !== null} aria-describedby={probe === 'checking' || vaultReason !== null ? `${id}-passwords-note` : undefined} onChange={event => togglePasswords(event.target.checked)} /><span aria-hidden="true"><Check /></span><span>{t('importPasswordsOption')}</span></label>
    {(probe === 'checking' || vaultReason !== null) && <p className="setting-hint import-detail" id={`${id}-passwords-note`}>{probe === 'checking' ? t('importPasswordsChecking') : t(vaultReason!)}</p>}</>;
  return <dialog className="settings-dialog import-dialog" ref={dialog} aria-labelledby={`${id}-title`} aria-describedby={`${id}-note`} aria-busy={running} onCancel={event => { event.preventDefault(); if (removal === 'confirm') setRemoval('idle'); else dismiss(); }} onKeyDown={event => {
    if (event.key !== 'Escape' || unlock || permission) return;
    event.preventDefault(); event.stopPropagation();
    if (removal === 'confirm') setRemoval('idle'); else dismiss();
  }}><div className="settings-dialog-heading"><h2 id={`${id}-title`}>{t(firstRun ? 'importFirstTitle' : 'importFrom')}</h2><p id={`${id}-note`} className="setting-hint">{firstRun ? t('importFirstHint') : t('importNote').replace('{name}', profileName)}</p></div>
    {!done && <>
      <div className="settings-clear-options" role="radiogroup" aria-labelledby={`${id}-source`}><span className="import-label" id={`${id}-source`}>{t('importSource')}</span>
        {options.map((option, index) => <label className="settings-checkbox settings-radio" key={`${option.source.browser}:${option.profile.id}`}>
          <input type="radio" name={`${id}-source`} ref={index === 0 ? first : undefined} checked={index === selected} disabled={running} onChange={() => { setSelected(index); setFile(null); changed(); }} /><span aria-hidden="true"><Check /></span><span>{importLabel(option.source, option.profile)}</span></label>)}
      </div>
      <div className="settings-clear-options" role="group" aria-labelledby={`${id}-what`}><span className="import-label" id={`${id}-what`}>{t('importWhat')}</span>
        {check('favorites', t('importFavoritesOption'), profile.favorites)}{check('history', t('importHistoryOption'), profile.history)}
        {check('searchEngine', profile.searchEngine ? t('importSearchOption').replace('{name}', SEARCH_ENGINES[profile.searchEngine].displayName) : t('importSearchNone'), profile.searchEngine !== null)}
        {check('settings', t('importSettingsOption'), profile.settings !== null)}
        {found.length > 0 && <p className="setting-hint import-detail">{t('importSettingsFound').replace('{items}', listed(language, found))}</p>}
        {passwordsLabel}
        {passwords && <div className="import-passwords"><p className="setting-hint">{t(hint).replace('{name}', source.name)}</p>
          <div className="import-passwords-file"><button className="settings-button" type="button" disabled={running || choosing} onClick={choose}>{choosing && <LoaderCircle className="spinner" aria-hidden="true" />}{t(file ? 'importPasswordsChange' : 'importPasswordsChoose')}</button><span className="setting-hint">{file ? t('importPasswordsFile').replace('{name}', file.name) : t('importPasswordsNone')}</span></div></div>}
      </div>
      {firstRun && <p className="setting-hint">{t('importNote').replace('{name}', profileName)}</p>}
    </>}
    <div className="settings-feedback" role="status" aria-live="polite">{done && outcome ? importResultText(outcome.browser, outcome.passwords, language) : ''}</div>
    {done && outcome?.passwords && file && removal !== 'done' && <div className="import-confirm">
      <p className="setting-hint">{t('importPasswordsDeleteHint')}</p>
      {removal === 'idle' ? <button className="settings-button" ref={deleteButton} type="button" onClick={() => setRemoval('confirm')}>{t('importPasswordsDelete')}</button> : <div role="group" aria-label={t('importPasswordsDelete')}>
        <p>{t('importPasswordsDeleteConfirm').replace('{name}', file.name)}</p>
        <div className="settings-dialog-actions"><button className="settings-button" ref={keepButton} type="button" disabled={removal === 'running'} onClick={() => setRemoval('idle')}>{t('cancel')}</button>
          <button className="settings-button primary" type="button" disabled={removal === 'running'} onClick={removeFile}>{removal === 'running' && <LoaderCircle className="spinner" aria-hidden="true" />}{t(removal === 'running' ? 'importPasswordsDeleting' : 'importPasswordsDeleteNow')}</button></div></div>}
    </div>}
    {removal === 'done' && <div className="settings-feedback" role="status" aria-live="polite">{t('importPasswordsDeleted')}</div>}
    {removalError && <div className="settings-feedback error" role="alert">{removalError}</div>}
    {problem && <div className="settings-feedback error" role="alert">{problem}</div>}
    {phase === 'error' && <div className="settings-feedback error" role="alert"><span>{failure}</span><button className="settings-button quiet" type="button" onClick={submit}>{t('retry')}</button></div>}
    <div className="settings-dialog-actions">{done ? <button className="settings-button primary" ref={doneButton} type="button" onClick={onClose}>{t('importDone')}</button> : <>
      <button className="settings-button" type="button" disabled={running} onClick={onClose}>{t(firstRun ? 'importSkip' : 'cancel')}</button>
      <button className="settings-button primary" ref={importButton} type="button" disabled={running} onClick={submit}>{running && <LoaderCircle className="spinner" aria-hidden="true" />}{running ? importProgressLabel(progress, language) : t('importButton')}</button>
    </>}</div>
    {permission && <VaultImportPermission language={language} windows={vault.windows} describe={describe} onGranted={async () => { afterUnlock.current = true; }} onClose={() => {
      setPermission(false);
      if (afterUnlock.current) { afterUnlock.current = false; void run(); } else importButton.current?.focus();
    }} />}
    {unlock && <VaultUnlock language={language} action={vaultAction} onUnlocked={async () => { afterUnlock.current = true; }} onClose={() => {
      setUnlock(false);
      if (afterUnlock.current) { afterUnlock.current = false; void run(); } else importButton.current?.focus();
    }} />}
  </dialog>;
}
