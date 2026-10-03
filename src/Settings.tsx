import { useEffect, useId, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Check, ChevronDown, ChevronLeft, Folder, LoaderCircle, Palette, Settings2, ShieldCheck, Users } from 'lucide-react';
import { copy, text } from './copy';
import type { CopyKey } from './copy';
import { PROFILE_COLORS, SEARCH_ENGINES, SITE_PERMISSIONS } from './shared/api';
import type { BrowserCommand, BrowserState, ClearedBrowsingData, Language, SettingsSection, SitePermission, SiteSettingsEntry } from './shared/api';
import { HorizonMark } from './HorizonMark';
import { Menu } from './Menu';
import { NotebookAnchor } from './Notebooks';
import { ProfilesSettings } from './Profiles';
import { Switch } from './Switch';

export const SETTINGS_SECTIONS = [
  { section: 'general', label: 'general', icon: Settings2 },
  { section: 'appearance', label: 'appearance', icon: Palette },
  { section: 'privacy', label: 'privacy', icon: ShieldCheck },
  { section: 'profiles', label: 'profiles', icon: Users },
] as const;

export function settingsError(reason: unknown, language: Language): string {
  const message = reason instanceof Error ? reason.message : String(reason);
  const codes = new Set(message.match(/\b[A-Z][A-Z_]+\b/g) ?? []);
  const code = (Object.keys(copy) as CopyKey[]).find(key => codes.has(key));
  return text(code ?? 'browserError', language);
}

type Apply = (command: BrowserCommand, message?: string) => Promise<boolean>;

export function groupSiteSettings(sites: SiteSettingsEntry[]): SiteSettingsEntry[][] {
  const hosts = new Map<string, SiteSettingsEntry[]>();
  for (const site of sites) hosts.set(site.host, [...(hosts.get(site.host) ?? []), site]);
  return [...hosts.values()];
}

function SettingRow({ title, hint, language, children }: {
  title: CopyKey; hint?: ReactNode; language: Language; children: (id: string, apply: Apply, pending: boolean) => ReactNode;
}) {
  const id = useId(), running = useRef(false), row = useRef<HTMLDivElement>(null);
  const restore = useRef<HTMLElement | null>(null);
  const [pending, setPending] = useState(false), [result, setResult] = useState(''), [error, setError] = useState('');
  useEffect(() => {
    if (!pending && restore.current) {
      const target = restore.current; restore.current = null;
      // A pending control loses native focus when disabled; a user who moved away keeps their new focus.
      if (target.isConnected && (document.activeElement === document.body || document.activeElement === target)) target.focus();
    }
  }, [pending]);
  const [retry, setRetry] = useState<{ command: BrowserCommand; message?: string } | null>(null);
  const apply: Apply = async (command, message) => {
    if (running.current) return false;
    const focused = document.activeElement;
    restore.current = focused instanceof HTMLElement && row.current?.contains(focused) ? focused : null;
    running.current = true; setPending(true); setError(''); setResult(''); setRetry(null);
    try {
      await window.horizon.command(command);
      const resultLanguage = command.type === 'set-language' ? command.value === 'system' ? navigator.language.toLowerCase().split('-')[0] === 'es' ? 'es' : 'en' : command.value : language;
      setResult(command.type === 'set-language' ? text('settingsSaved', resultLanguage) : message ?? text('settingsSaved', language)); return true;
    }
    catch (reason) { setError(settingsError(reason, language)); setRetry({ command, message }); return false; }
    finally { running.current = false; setPending(false); }
  };
  return <div className="setting-row" ref={row} aria-busy={pending}><div className="setting-copy"><strong id={`${id}-title`}>{text(title, language)}</strong>{hint && <p className="setting-hint" id={`${id}-hint`} aria-live={title === 'downloads' ? 'polite' : undefined}>{hint}</p>}
    <div className="settings-feedback" role="status" aria-live="polite">{result}</div>
    {error && <div className="settings-feedback error" role="alert"><span>{error}</span>{retry && <button className="settings-button quiet" type="button" disabled={pending} onClick={() => { void apply(retry.command, retry.message); }}>{text('retry', language)}</button>}</div>}
  </div><div className="setting-controls">{children(id, apply, pending)}</div></div>;
}

function SettingsGroup({ title, language, children }: { title: CopyKey; language: Language; children: ReactNode }) {
  const id = useId();
  return <section className="settings-group" aria-labelledby={id}><h2 id={id}>{text(title, language)}</h2><div className="settings-card">{children}</div></section>;
}

function SettingsDropdown<T extends string>({ id, label, value, choices, disabled, onChange, language }: {
  id: string; label: CopyKey; value: T; choices: { value: T; label: string }[]; disabled: boolean; onChange: (value: T) => void; language: Language;
}) {
  const [open, setOpen] = useState(false), opener = useRef<HTMLButtonElement>(null);
  const selected = choices.find(choice => choice.value === value);
  const close = (focus = true) => { setOpen(false); if (focus) opener.current?.focus(); };
  return <div className="settings-dropdown"><button className="settings-dropdown-button" type="button" ref={opener} disabled={disabled} aria-labelledby={`${id}-title ${id}-value`} aria-describedby={`${id}-hint`} aria-haspopup="menu" aria-expanded={open} aria-controls={open ? `${id}-menu` : undefined} onClick={() => setOpen(previous => !previous)} onKeyDown={event => {
    if (['ArrowDown', 'ArrowUp'].includes(event.key)) { event.preventDefault(); setOpen(true); }
  }}><span id={`${id}-value`}>{selected?.label}</span><span className="settings-dropdown-chevron"><ChevronDown aria-hidden="true" /></span></button>
    {open && <NotebookAnchor opener={opener}><Menu id={`${id}-menu`} className="settings-dropdown-menu" label={text(label, language)} keyboard initialFocus="[aria-checked=true]" opener={opener} onDismiss={reason => close(reason !== 'outside')}>
      {choices.map(choice => <button type="button" role="menuitemradio" tabIndex={-1} aria-checked={choice.value === value} key={choice.value} onClick={() => { close(); if (choice.value !== value) onChange(choice.value); }}><span>{choice.label}</span>{choice.value === value && <Check aria-hidden="true" />}</button>)}
    </Menu></NotebookAnchor>}
  </div>;
}

function SettingsSegmented<T extends string>({ id, value, choices, disabled, onChange, language }: {
  id: string; value: T; choices: { value: T; label: CopyKey }[]; disabled: boolean; onChange: (value: T) => void; language: Language;
}) {
  return <div className="settings-segmented" role="radiogroup" aria-labelledby={`${id}-title`}>
    {choices.map((choice, index) => <button type="button" key={choice.value} role="radio" aria-checked={choice.value === value} tabIndex={choice.value === value ? 0 : -1} disabled={disabled} onClick={() => { if (choice.value !== value) onChange(choice.value); }} onKeyDown={event => {
      const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index + 1) % choices.length : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index + choices.length - 1) % choices.length : event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : -1;
      if (next < 0) return;
      event.preventDefault(); (event.currentTarget.parentElement?.children[next] as HTMLButtonElement | undefined)?.focus();
      const selected = choices[next]!; if (selected.value !== value) onChange(selected.value);
    }}>{text(choice.label, language)}</button>)}
  </div>;
}

function SettingsToggle({ title, hint, value, command, language }: {
  title: CopyKey; hint?: string; value: boolean; command: 'set-ask-where-to-save' | 'set-block-ads' | 'set-block-third-party-cookies' | 'set-clear-history-on-close' | 'set-clear-cache-on-close' | 'contrast'; language: Language;
}) {
  return <SettingRow title={title} hint={hint} language={language}>{(id, apply, pending) => <Switch checked={value} labelledBy={`${id}-title`} describedBy={hint ? `${id}-hint` : undefined} disabled={pending} onChange={value => {
    void apply(command === 'contrast' ? { type: command, value: value ? 'high' : 'standard' } : { type: command, value }, text('settingSaved', language).replace('{setting}', text(title, language)).replace('{value}', text(value ? 'on' : 'off', language)));
  }} />}</SettingRow>;
}

function GeneralSettings({ state, language }: { state: BrowserState; language: Language }) {
  const t = (key: CopyKey) => text(key, language);
  const systemLanguage = state.languageSetting === 'system' ? state.language : navigator.language.toLowerCase().split('-')[0] === 'es' ? 'es' : 'en';
  const languageChoices = [{ value: 'system' as const, label: t('languageSystem').replace('{language}', t(systemLanguage === 'es' ? 'spanish' : 'english')) }, { value: 'en' as const, label: t('english') }, { value: 'es' as const, label: t('spanish') }];
  return <div className="settings-card">
    {state.defaultBrowser !== 'unsupported' && <SettingRow title="defaultBrowser" hint={t(state.defaultBrowser === 'default' ? 'isDefaultBrowser' : state.defaultBrowser === 'developmentBuild' ? 'defaultBrowserDevelopment' : 'notDefaultBrowser')} language={language}>{(id, apply, pending) => state.defaultBrowser !== 'default' &&
      <button className="settings-button" type="button" disabled={pending || state.defaultBrowser === 'developmentBuild'} aria-describedby={`${id}-hint`} onClick={() => { void apply({ type: 'register-default-browser' }, t('defaultAppsOpened')); }}>{t('makeDefault')}</button>
    }</SettingRow>}
    <SettingRow title="searchEngine" hint={t('searchEngineHint')} language={language}>{(id, apply, pending) => <SettingsDropdown id={id} label="searchEngine" value={state.searchEngine} choices={Object.entries(SEARCH_ENGINES).map(([value, engine]) => ({ value: value as BrowserState['searchEngine'], label: engine.displayName }))} disabled={pending} language={language} onChange={value => { void apply({ type: 'set-search-engine', value }, t('settingSaved').replace('{setting}', t('searchEngine')).replace('{value}', SEARCH_ENGINES[value].displayName)); }} />}</SettingRow>
    <SettingRow title="downloads" hint={<>{state.downloadsFolder}{state.downloadsFolderUnavailable && <span className="settings-folder-unavailable">{t('downloadsFolderUnavailable')}</span>}</>} language={language}>{(_id, apply, pending) => <>
      {!state.downloadsFolderDefault && <button className="settings-button quiet" type="button" disabled={pending} onClick={() => { void apply({ type: 'reset-downloads-folder' }); }}>{t('useDownloads')}</button>}
      <button className="settings-button" type="button" disabled={pending} onClick={() => { void apply({ type: 'choose-downloads-folder' }, ''); }}><Folder aria-hidden="true" />{t('changeFolder')}</button>
    </>}</SettingRow>
    <SettingsToggle title="askWhereToSave" value={state.askWhereToSave} command="set-ask-where-to-save" language={language} />
    <SettingRow title="language" hint={t('languageHint')} language={language}>{(id, apply, pending) => <SettingsDropdown id={id} label="language" value={state.languageSetting} choices={languageChoices} disabled={pending} language={language} onChange={value => { void apply({ type: 'set-language', value }, t('settingSaved').replace('{setting}', t('language')).replace('{value}', languageChoices.find(choice => choice.value === value)!.label)); }} />}</SettingRow>
  </div>;
}

function AppearanceSettings({ state, language }: { state: BrowserState; language: Language }) {
  const t = (key: CopyKey) => text(key, language);
  const saved = (title: CopyKey, choice: CopyKey) => t('settingSaved').replace('{setting}', t(title)).replace('{value}', t(choice));
  return <>
    <SettingsGroup title="product" language={language}>
      <SettingRow title="theme" hint={t('themeHint')} language={language}>{(id, apply, pending) => <SettingsSegmented id={id} value={state.theme} choices={[{ value: 'system', label: 'system' }, { value: 'amber', label: 'amber' }, { value: 'daylight', label: 'daylight' }]} disabled={pending} language={language} onChange={value => { void apply({ type: 'theme', value }, saved('theme', value)); }} />}</SettingRow>
      <SettingsToggle title="highContrast" hint={t('contrastHint')} value={state.contrast === 'high'} command="contrast" language={language} />
    </SettingsGroup>
    <SettingsGroup title="webPages" language={language}>
      <SettingRow title="darkPages" hint={t('darkPagesHint')} language={language}>{(id, apply, pending) => <SettingsSegmented id={id} value={state.darkPages.mode} choices={[{ value: 'off', label: 'off' }, { value: 'on', label: 'on' }, { value: 'system', label: 'system' }]} disabled={pending} language={language} onChange={value => { void apply({ type: 'dark-pages', value }, saved('darkPages', value)); }} />}</SettingRow>
      {state.darkPages.mode !== 'off' && <>
        <SettingRow title="darkStrength" language={language}>{(id, apply, pending) => <SettingsSegmented id={id} value={state.darkPages.strength} choices={[{ value: 'soft', label: 'soft' }, { value: 'standard', label: 'standard' }, { value: 'deep', label: 'deep' }]} disabled={pending} language={language} onChange={value => { void apply({ type: 'dark-strength', value }, saved('darkStrength', value)); }} />}</SettingRow>
        <SettingRow title="darkTone" language={language}>{(id, apply, pending) => <SettingsSegmented id={id} value={state.darkPages.tone} choices={[{ value: 'neutral', label: 'neutral' }, { value: 'warm', label: 'warm' }]} disabled={pending} language={language} onChange={value => { void apply({ type: 'dark-tone', value }, saved('darkTone', value)); }} />}</SettingRow>
      </>}
    </SettingsGroup>
  </>;
}

function ClearBrowsingDataDialog({ language, clearing, opener, onDismiss, onCleared }: {
  language: Language; clearing: boolean; opener: RefObject<HTMLButtonElement | null>; onDismiss: () => void; onCleared: (result: ClearedBrowsingData) => void;
}) {
  const t = (key: CopyKey) => text(key, language), id = useId();
  const dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null), running = useRef(false);
  const [checked, setChecked] = useState<ClearedBrowsingData>({ history: true, cookies: true, cache: true });
  const [pending, setPending] = useState(false), [error, setError] = useState(''), [failed, setFailed] = useState(false);
  useEffect(() => {
    const modal = dialog.current; modal?.showModal(); cancel.current?.focus();
    return () => { if (modal?.open) modal.close(); opener.current?.focus(); };
  }, [opener]);
  const clear = async () => {
    if (running.current || clearing) return;
    if (!checked.history && !checked.cookies && !checked.cache) { setError(t('clearNothingSelected')); setFailed(false); return; }
    running.current = true; setPending(true); setError(''); setFailed(false);
    try { const result = await window.horizon.command({ type: 'clear-browsing-data', ...checked }); onCleared(result); onDismiss(); }
    catch (reason) { setError(settingsError(reason, language)); setFailed(true); }
    finally { running.current = false; setPending(false); }
  };
  const busy = pending || clearing;
  return <dialog className="settings-dialog" ref={dialog} aria-labelledby={`${id}-title`} aria-describedby={`${id}-subtitle`} aria-busy={busy} onCancel={event => { event.preventDefault(); if (!running.current) onDismiss(); }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!running.current) onDismiss(); }
  }}><div className="settings-dialog-heading"><h2 id={`${id}-title`}>{t('clearBrowsingData')}</h2><p id={`${id}-subtitle`} className="setting-hint">{t('clearAllTime')}</p></div>
    <div className="settings-clear-options">{([{ field: 'history', label: 'browsingHistory' }, { field: 'cookies', label: 'cookiesSiteData' }, { field: 'cache', label: 'cachedImagesFiles' }] as const).map(({ field, label }) => <label className="settings-checkbox" key={field}><input type="checkbox" checked={checked[field]} disabled={busy} onChange={event => { setChecked(previous => ({ ...previous, [field]: event.target.checked })); setError(''); setFailed(false); }} /><span aria-hidden="true"><Check /></span><span>{t(label)}</span></label>)}</div>
    <p>{t('clearCookiesWarning')}</p>
    {error && <div className="settings-feedback error" role="alert"><span>{error}</span>{failed && <button className="settings-button quiet" type="button" disabled={busy} onClick={() => { void clear(); }}>{t('retry')}</button>}</div>}
    <div className="settings-dialog-actions"><button className="settings-button" ref={cancel} type="button" disabled={busy} onClick={onDismiss}>{t('cancel')}</button><button className="settings-button primary" type="button" disabled={busy} onClick={() => { void clear(); }}>{busy && <LoaderCircle className="spinner" aria-hidden="true" />}{t(busy ? 'clearingBrowsingData' : 'clear')}</button></div>
  </dialog>;
}

function PrivacySettings({ state, language, onOpen, openClearDialog, onClearDialogOpened }: { state: BrowserState; language: Language; onOpen: (section: SettingsSection) => void; openClearDialog?: boolean; onClearDialogOpened?: () => void }) {
  const t = (key: CopyKey) => text(key, language);
  const count = groupSiteSettings(state.sites).length;
  const [dialog, setDialog] = useState(false), [result, setResult] = useState('');
  const opener = useRef<HTMLButtonElement>(null);
  useEffect(() => { if (openClearDialog) { setDialog(true); onClearDialogOpened?.(); } }, [openClearDialog, onClearDialogOpened]);
  return <>
    <SettingsGroup title="blocking" language={language}>
      <SettingsToggle title="blockAdsTrackers" hint={t('blockAdsHint')} value={state.blockAds} command="set-block-ads" language={language} />
      <SettingsToggle title="blockThirdPartyCookies" hint={t('blockThirdPartyCookiesHint')} value={state.blockThirdPartyCookies} command="set-block-third-party-cookies" language={language} />
      <SettingRow title="sitesOwnSettings" hint={t(count === 0 ? 'sitesOwnSettingsNone' : count === 1 ? 'siteOwnSettingsCount' : 'sitesOwnSettingsCount').replace('{count}', String(count))} language={language}>{() => <button className="settings-button" type="button" onClick={() => onOpen('privacy/sites')}>{t('manage')}</button>}</SettingRow>
    </SettingsGroup>
    <SettingsGroup title="browsingData" language={language}>
      <SettingRow title="clearBrowsingData" hint={t('clearBrowsingDataHint')} language={language}>{() => <button className="settings-button" ref={opener} type="button" onClick={() => setDialog(true)}>{t('clear')}</button>}</SettingRow>
      <SettingsToggle title="clearHistoryOnClose" value={state.clearHistoryOnClose} command="set-clear-history-on-close" language={language} />
      <SettingsToggle title="clearCacheOnClose" value={state.clearCacheOnClose} command="set-clear-cache-on-close" language={language} />
    </SettingsGroup>
    <div className="settings-feedback" role="status" aria-live="polite">{result}</div>
    {dialog && <ClearBrowsingDataDialog language={language} clearing={state.clearingBrowsingData} opener={opener} onDismiss={() => { setDialog(false); requestAnimationFrame(() => opener.current?.focus()); }} onCleared={result => {
      const data = [result.history && t('browsingHistory'), result.cookies && t('cookiesSiteData'), result.cache && t('cachedImagesFiles')].filter((value): value is string => Boolean(value));
      setResult(t('browsingDataCleared').replace('{data}', new Intl.ListFormat(language, { style: 'long', type: 'conjunction' }).format(data)));
    }} />}
  </>;
}

const permissionLabels: Record<SitePermission, CopyKey> = { camera: 'permissionCamera', microphone: 'permissionMicrophone', location: 'permissionLocation', notifications: 'permissionNotifications' };
function siteSummary(sites: SiteSettingsEntry[], language: Language): string {
  const t = (key: CopyKey) => text(key, language);
  const site = sites[0]!;
  return [site.blocking !== null && t(site.blocking ? 'siteBlockingOn' : 'siteBlockingOff'), site.dark !== null && t(site.dark ? 'siteDarkOn' : 'siteDarkOff'), ...sites.flatMap(entry => SITE_PERMISSIONS.filter(permission => entry.permissions[permission] !== 'ask').map(permission => t('sitePermissionSummary').replace('{permission}', t(permissionLabels[permission])).replace('{decision}', t(entry.permissions[permission] === 'allow' ? 'permissionAllowed' : 'permissionBlocked').toLocaleLowerCase(language)) + (sites.length > 1 ? ` (${entry.origin})` : '')))].filter(Boolean).join(' · ');
}

function SettingsSite({ sites, language, onReset }: { sites: SiteSettingsEntry[]; language: Language; onReset: (host: string) => void }) {
  const t = (key: CopyKey) => text(key, language), pending = useRef(false);
  const site = sites[0]!;
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  const reset = async () => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError('');
    try { await window.horizon.command({ type: 'reset-site', host: site.host }); onReset(site.host); }
    catch (reason) { setError(settingsError(reason, language)); }
    finally { pending.current = false; setBusy(false); }
  };
  const color = PROFILE_COLORS[[...site.host].reduce((hash, character) => hash + character.charCodeAt(0), 0) % PROFILE_COLORS.length];
  return <li className="settings-site" aria-busy={busy}><span className="site-badge" data-profile-color={color} aria-hidden="true">{site.host.slice(0, 1).toLocaleUpperCase(language)}</span><div className="setting-copy"><strong>{site.host}</strong><p className="setting-hint">{siteSummary(sites, language)}</p>{error && <div className="settings-feedback error" role="alert"><span>{error}</span><button className="settings-button quiet" type="button" disabled={busy} onClick={() => { void reset(); }}>{t('retry')}</button></div>}</div><button className="settings-button" type="button" disabled={busy} onClick={() => { void reset(); }}>{t('resetSite')}</button></li>;
}

function SitesSettings({ state, language }: { state: BrowserState; language: Language }) {
  const t = (key: CopyKey) => text(key, language), [result, setResult] = useState('');
  return <><div className="settings-card">{state.sites.length ? <ul className="settings-sites">{groupSiteSettings(state.sites).map(sites => <SettingsSite key={sites[0]!.host} sites={sites} language={language} onReset={host => setResult(t('siteReset').replace('{host}', host))} />)}</ul> : <div className="settings-empty"><strong>{t('noSiteSettings')}</strong><p>{t('noSiteSettingsHint')}</p></div>}</div>{state.sites.length > 0 && <p className="settings-note">{t('resetSiteNote')}</p>}<div className="settings-feedback" role="status" aria-live="polite">{result}</div></>;
}

export function Settings({ state, section, language, onOpen, openClearDialog, onClearDialogOpened }: {
  state: BrowserState; section: SettingsSection; language: Language; onOpen: (section: SettingsSection) => void; openClearDialog?: boolean; onClearDialogOpened?: () => void;
}) {
  const t = (key: CopyKey) => text(key, language);
  const current = section === 'privacy/sites' ? 'privacy' : section;
  return <section className="settings-page" aria-label={t('settings')}><nav className="settings-rail" aria-label={t('settingsSections')}><div className="settings-rail-heading"><HorizonMark /><span>{t('settings')}</span></div>
    {SETTINGS_SECTIONS.map(({ section: target, label, icon: Icon }) => <button className={`settings-rail-row${target === current ? ' selected' : ''}`} type="button" key={target} aria-label={t(label)} title={t(label)} aria-current={target === current ? 'page' : undefined} onClick={() => onOpen(target)}><Icon aria-hidden="true" /><span>{t(label)}</span></button>)}
  </nav><div className="settings-content"><div className="settings-column"><div className="settings-page-heading">{section === 'privacy/sites' && <button className="settings-back" type="button" onClick={() => onOpen('privacy')}><ChevronLeft aria-hidden="true" />{t('privacy')}</button>}<h1 id="settings-title" tabIndex={-1}>{t(section === 'privacy/sites' ? 'sitesOwnSettings' : current)}</h1></div>
    {section === 'general' && <GeneralSettings state={state} language={language} />}
    {section === 'appearance' && <AppearanceSettings state={state} language={language} />}
    {section === 'privacy' && <PrivacySettings state={state} language={language} onOpen={onOpen} openClearDialog={openClearDialog} onClearDialogOpened={onClearDialogOpened} />}
    {section === 'privacy/sites' && <SitesSettings state={state} language={language} />}
    {section === 'profiles' && <ProfilesSettings state={state} language={language} />}
  </div></div></section>;
}
