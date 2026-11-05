import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Check, ExternalLink, EyeOff, LoaderCircle, LogIn, LogOut, Plus, Trash2, TriangleAlert, Users } from 'lucide-react';
import { text } from './copy';
import type { CopyKey } from './copy';
import { PROFILE_COLORS } from './shared/api';
import type { AccountState, BrowserCommand, BrowserState, Language, ProfileColor, ProfileState } from './shared/api';
import { Menu } from './Menu';
import { ToolbarPopover } from './ToolbarPopover';

const colourLabels: Record<ProfileColor, CopyKey> = { amber: 'colourAmber', blue: 'colourBlue', green: 'colourGreen', red: 'colourRed', yellow: 'colourYellow', grey: 'colourGrey', purple: 'colourPurple', cyan: 'colourCyan' };
const errorLabels: Record<string, CopyKey> = { PROFILE_NAME_EMPTY: 'profileNameEmpty', PROFILE_NAME_LONG: 'profileNameLong', PROFILE_NAME_INVALID: 'profileNameInvalid', PROFILE_NAME_DUPLICATE: 'profileNameDuplicate', PROFILE_LIMIT: 'profileLimit' };
export const profileTabCount = (count: number, language: Language): string => text(count === 0 ? 'profileNoTabs' : count === 1 ? 'profileTab' : 'profileTabs', language).replace('{count}', String(count));

type ProfileDraft = { name: string; color: ProfileColor };
// Drafts outlive section and editor mounts, but never leave this running renderer.
const profileDrafts = new Map<string, ProfileDraft>();

export function ProfileForm({ language, profiles, profile, onCancel, onSuccess, onStateChange, submitLabel, draftKey }: {
  language: Language; profiles: ProfileState[]; profile?: ProfileState; onCancel: () => void; onSuccess: (name: string) => void; onStateChange?: (name: string, pending: boolean) => void; submitLabel?: 'save' | 'create'; draftKey?: string;
}) {
  const t = (key: CopyKey) => text(key, language);
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const submitting = useRef(false);
  const key = profile?.id ?? draftKey;
  const [name, setName] = useState(() => (key ? profileDrafts.get(key)?.name : undefined) ?? profile?.name ?? '');
  const [color, setColor] = useState<ProfileColor>(() => (key ? profileDrafts.get(key)?.color : undefined) ?? profile?.color ?? PROFILE_COLORS.find(color => !profiles.some(profile => profile.color === color)) ?? 'amber');
  const [error, setError] = useState<CopyKey | null>(null);
  const [busy, setBusy] = useState(false);
  const cancel = () => { if (key) profileDrafts.delete(key); onCancel(); };
  const chooseColor = (value: ProfileColor) => {
    if (submitting.current) return;
    setColor(value); if (key) profileDrafts.set(key, { name, color: value });
  };
  useEffect(() => { input.current?.focus(); input.current?.select(); }, []);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && submitting.current) { event.preventDefault(); event.stopPropagation(); } };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, []);
  const validate = (value = name): CopyKey | null => {
    if (/[\u0000-\u001f\u007f-\u009f]/.test(value)) return 'profileNameInvalid';
    if (!value.trim()) return 'profileNameEmpty';
    if (value.trim().length > 40) return 'profileNameLong';
    if (profiles.some(other => other.id !== profile?.id && other.name.toLowerCase() === value.trim().toLowerCase())) return 'profileNameDuplicate';
    if (!profile && profiles.length >= 20) return 'profileLimit';
    return null;
  };
  return <form className="profile-form" aria-label={t(profile ? 'editProfile' : 'newProfile')} aria-busy={busy} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!submitting.current) cancel(); }
  }} onSubmit={event => {
    event.preventDefault();
    if (submitting.current) return;
    const invalid = validate();
    if (invalid) { setError(invalid); input.current?.focus(); return; }
    submitting.current = true; setBusy(true); setError(null); onStateChange?.(name, true);
    const command: BrowserCommand = profile ? { type: 'update-profile', id: profile.id, name, color } : { type: 'create-profile', name, color };
    void window.horizon.command(command).then(() => { if (key) profileDrafts.delete(key); onSuccess(name.trim()); }).catch((reason: unknown) => {
      const message = reason instanceof Error ? reason.message : '';
      const code = Object.keys(errorLabels).find(code => message.includes(code));
      setError(message.includes('PROFILE_SETTINGS_SAVE_FAILED') ? 'PROFILE_SETTINGS_SAVE_FAILED' : code ? errorLabels[code]! : 'browserError'); input.current?.focus();
    }).finally(() => { submitting.current = false; setBusy(false); onStateChange?.(input.current?.value ?? name, false); });
  }}>
    <label htmlFor={`${id}-name`}>{t('profileName')}</label>
    <input id={`${id}-name`} ref={input} value={name} readOnly={busy} placeholder={t('profileNamePlaceholder')} autoComplete="off" spellCheck={false} maxLength={256} aria-invalid={Boolean(error)} aria-describedby={error ? `${id}-error` : undefined} onChange={event => { if (submitting.current) return; const value = event.target.value; setName(value); if (key) profileDrafts.set(key, { name: value, color }); onStateChange?.(value, submitting.current); if (error) setError(validate(value)); }} onBlur={() => { const invalid = validate(); if (name && invalid) setError(invalid); }} />
    {error && <p id={`${id}-error`} className="profile-field-error" role="alert"><TriangleAlert aria-hidden="true" />{t(error)}</p>}
    <span className="profile-field-label" id={`${id}-colour`}>{t('profileColour')}</span>
    <div className="profile-swatches" role="radiogroup" aria-labelledby={`${id}-colour`}>
      {PROFILE_COLORS.map((choice, index) => <button className="profile-swatch" type="button" role="radio" key={choice} data-profile-color={choice} aria-label={t(colourLabels[choice])} aria-checked={color === choice} disabled={busy} tabIndex={color === choice ? 0 : -1} onClick={() => chooseColor(choice)} onKeyDown={event => {
        const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index + 1) % PROFILE_COLORS.length : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index + PROFILE_COLORS.length - 1) % PROFILE_COLORS.length : event.key === 'Home' ? 0 : event.key === 'End' ? PROFILE_COLORS.length - 1 : -1;
        if (submitting.current || next < 0) return;
        event.preventDefault(); const selected = PROFILE_COLORS[next]!; chooseColor(selected);
        event.currentTarget.parentElement?.querySelector<HTMLButtonElement>(`[data-profile-color=${selected}]`)?.focus();
      }}><span className="swatch-ring" aria-hidden="true"><span /></span></button>)}
    </div>
    <div className="profile-form-actions"><button type="button" className="profile-action quiet" disabled={busy} onClick={() => { if (!submitting.current) cancel(); }}>{t('cancel')}</button><button type="submit" className="profile-action primary" disabled={busy}>{busy && <LoaderCircle className="spinner" aria-hidden="true" />}{t(submitLabel ?? (profile ? 'save' : 'create'))}</button></div>
  </form>;
}

export function ProfileControl({ profile, privateWindow, language, open, opener, onClick }: {
  profile?: ProfileState; privateWindow: boolean; language: Language; open: 'menu' | 'new' | null; opener: RefObject<HTMLButtonElement | null>; onClick: (keyboard: boolean) => void;
}) {
  const name = profile?.name ?? text('personal', language);
  if (privateWindow) return <span className="private-window-mark" role="img" aria-label={text('privateWindow', language)} title={text('privateWindow', language)}><EyeOff aria-hidden="true" /><span>{text('private', language)}</span></span>;
  return <button className="icon-button profile-avatar" type="button" ref={opener} aria-haspopup="menu" aria-expanded={Boolean(open)} aria-controls={open === 'new' ? 'new-profile-popover' : 'profiles-menu'} aria-label={text('profile', language).replace('{name}', name)} title={name} onClick={event => onClick(event.detail === 0)}><span className="avatar-circle" aria-hidden="true">{Array.from(name)[0]?.toLocaleUpperCase(language)}</span></button>;
}

// Initials as the Hub's Nebula page computes them.
export const accountInitials = (account: AccountState): string => account.status === 'signedIn' ? (account.displayName ?? account.email).split(/[\s@._-]+/).filter(Boolean).slice(0, 2).map(part => part[0]!.toUpperCase()).join('') : '';

// The Cosmic account commands, with the same rules as the Hub's Nebula page.
export function useAccountCommands(describe: (reason: unknown) => string) {
  const pending = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState<BrowserCommand | null>(null), [phrase, setPhrase] = useState('');
  const run = async (command: BrowserCommand) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setRetry(null);
    try { await window.horizon.command(command); }
    // The phrase is never kept for a retry.
    catch (reason) { setError(describe(reason)); setRetry(command.type === 'account-phrase' ? null : command); }
    finally { pending.current = false; setBusy(false); }
  };
  return { pending, busy, error, retry, phrase, setPhrase, run };
}

type AccountCommands = ReturnType<typeof useAccountCommands>;
const cardStops = (card: HTMLElement | null) => [...(card?.querySelectorAll<HTMLElement>('button:not(:disabled), textarea:not(:disabled)') ?? [])];

export function AccountCard({ account, language, commands, card, describe }: {
  account: AccountState; language: Language; commands: AccountCommands; card: RefObject<HTMLDivElement | null>; describe: (reason: unknown) => string;
}) {
  const t = (key: CopyKey) => text(key, language);
  const { busy, error, retry, phrase, setPhrase, run } = commands;
  const identity = account.status === 'signedIn' && <div className="account-card-identity">
    <span className="account-card-avatar" aria-hidden="true">{accountInitials(account)}</span>
    <span className="account-card-who"><span className="account-card-name"><strong>{account.displayName ?? account.email}</strong>{account.plan && <span className="account-card-plan">{account.plan}</span>}</span>{account.displayName && <small>{account.email}</small>}</span>
  </div>;
  return <div className="account-card" ref={card} role="group" aria-label={t('cosmicAccount')} aria-busy={busy}>
    {account.status === 'signedOut' && <>
      <p className="account-card-title">{t('cosmicAccount')}</p><p className="account-card-text">{t('nebulaSignedOutText')}</p>
      <button className="desktop-action primary account-card-action" type="button" aria-disabled={busy} onClick={() => { void run({ type: 'account-sign-in' }); }}><LogIn aria-hidden="true" />{t('signIn')}</button>
      <p className="account-card-note">{t('nebulaBrowserNote')}</p>
    </>}
    {account.status === 'signingIn' && <>
      <p className="account-card-waiting" role="status"><LoaderCircle className="spinner accent" aria-hidden="true" /><span>{t('nebulaWaiting')}</span></p><p className="account-card-text">{t('nebulaWaitingNote')}</p>
      <div className="account-card-stack"><button className="desktop-action primary" type="button" aria-disabled={busy} onClick={() => { void run({ type: 'account-reopen' }); }}><ExternalLink aria-hidden="true" />{t('nebulaReopen')}</button>
        <button className="desktop-action outline" type="button" aria-disabled={busy} onClick={() => { void run({ type: 'account-cancel' }); }}>{t('cancel')}</button></div>
    </>}
    {account.status === 'signedIn' && account.consent === 'required' && <>
      {identity}
      <p className="account-card-heading">{t('nebulaConsentTitle')}</p><p className="account-card-text">{t('nebulaConsentText')}</p>
      <div className="account-card-stack"><button className="desktop-action primary" type="button" aria-disabled={busy} onClick={() => { void run({ type: 'account-manage' }); }}><ExternalLink aria-hidden="true" />{t('nebulaConsentOpen')}</button></div>
      <div className="account-card-buttons equal"><button className="desktop-action outline" type="button" aria-disabled={busy} onClick={() => { void run({ type: 'account-retry' }); }}>{t('retry')}</button>
        <button className="desktop-action" type="button" aria-disabled={busy} onClick={() => { void run({ type: 'account-sign-out' }); }}><LogOut aria-hidden="true" />{t('signOut')}</button></div>
    </>}
    {account.status === 'signedIn' && account.consent === 'accepted' && account.phrase !== 'ready' && <form className="account-card-phrase" onSubmit={event => { event.preventDefault(); if (busy || !phrase.trim()) return; const value = phrase; setPhrase(''); void run({ type: 'account-phrase', phrase: value }); }}>
      {identity}
      <p className="account-card-heading">{t('nebulaPhraseTitle')}</p><p className="account-card-text">{t('nebulaPhraseHint')}</p>
      <textarea className="account-card-words" aria-label={t('nebulaPhraseTitle')} value={phrase} maxLength={1000} spellCheck={false} autoComplete="off" autoCapitalize="off" onChange={event => setPhrase(event.target.value)} />
      {account.phrase === 'wrong' && <p className="settings-feedback error account-card-wrong" role="alert">{t('ACCOUNT_PHRASE_WRONG')}</p>}
      <p className="account-card-local">{t('nebulaPhraseLocal')}</p>
      <div className="account-card-buttons equal"><button className="desktop-action primary" type="submit" aria-disabled={busy || !phrase.trim()}>{t('phraseContinue')}</button>
        <button className="desktop-action outline" type="button" aria-disabled={busy} onClick={() => { setPhrase(''); void run({ type: 'account-sign-out' }); }}>{t('cancel')}</button></div>
    </form>}
    {account.status === 'signedIn' && account.consent === 'accepted' && account.phrase === 'ready' && <>
      {identity}
      <div className="account-card-buttons"><button className="desktop-action outline account-card-manage" type="button" aria-disabled={busy} onClick={() => { void run({ type: 'account-manage' }); }}><ExternalLink aria-hidden="true" />{t('nebulaManage')}</button>
        <button className="desktop-action" type="button" aria-disabled={busy} onClick={() => { void run({ type: 'account-sign-out' }); }}><LogOut aria-hidden="true" />{t('signOut')}</button></div>
    </>}
    {account.status === 'error' && <div className="settings-feedback error" role="alert"><span>{describe(new Error(account.code))}</span><button className="text-button" type="button" aria-disabled={busy} onClick={() => { void run({ type: 'account-retry' }); }}>{t('retry')}</button></div>}
    {error && <div className="settings-feedback error account-card-error" role="alert"><span>{error}</span>{retry && <button className="text-button" type="button" aria-disabled={busy} onClick={() => { void run(retry); }}>{t('retry')}</button>}</div>}
  </div>;
}

type MenuDismiss = (reason: 'escape' | 'tab' | 'outside') => void;

// The account card above the profiles menu. It keeps the popover open for pointers inside it, typed words or a pending command.
export function ProfilesPopover({ account, language, describe, gate, profileCount, onDismiss, children }: {
  account: AccountState; language: Language; describe: (reason: unknown) => string; gate: { dismiss: MenuDismiss }; profileCount: number; onDismiss: MenuDismiss; children: ReactNode;
}) {
  const commands = useAccountCommands(describe);
  const popover = useRef<HTMLDivElement>(null), card = useRef<HTMLDivElement>(null), pointerInside = useRef(false);
  const live = useRef({ phrase: commands.phrase, onDismiss });
  useLayoutEffect(() => {
    live.current = { phrase: commands.phrase, onDismiss };
    gate.dismiss = reason => {
      if (reason === 'outside' && (pointerInside.current || live.current.phrase || commands.pending.current)) return;
      live.current.onDismiss(reason);
    };
  });
  // Records, before the menu's own outside check runs, whether a pointer landed in this popover.
  useEffect(() => {
    const record = (event: PointerEvent) => { pointerInside.current = Boolean(popover.current?.contains(event.target as Node)); };
    document.addEventListener('pointerdown', record, true);
    return () => document.removeEventListener('pointerdown', record, true);
  }, []);
  // The current profile is scrolled into view when the menu opens.
  useLayoutEffect(() => {
    const rows = popover.current?.querySelector<HTMLElement>('.profiles-list'), current = rows?.querySelector<HTMLElement>('[aria-checked=true]');
    if (rows && current && current.offsetTop + current.offsetHeight > rows.scrollTop + rows.clientHeight) rows.scrollTop = current.offsetTop + current.offsetHeight - rows.clientHeight;
  }, []);
  // The fade shows only while more rows remain below.
  useLayoutEffect(() => {
    const rows = popover.current?.querySelector<HTMLElement>('.profiles-list');
    if (!rows) return;
    const measure = () => { rows.parentElement?.toggleAttribute('data-more', rows.scrollTop + rows.clientHeight < rows.scrollHeight - 1); };
    measure(); rows.addEventListener('scroll', measure, { passive: true });
    return () => rows.removeEventListener('scroll', measure);
  }, [profileCount]);
  // A command that replaces the focused control keeps focus inside the card instead of losing it to the page.
  const status = account.status, phraseState = account.status === 'signedIn' ? account.phrase : null, consent = account.status === 'signedIn' ? account.consent : null;
  useEffect(() => { if (!document.activeElement || document.activeElement === document.body) cardStops(card.current)[0]?.focus(); }, [status, phraseState, consent]);
  const menuEntry = () => popover.current?.querySelector<HTMLElement>('#profiles-menu [aria-checked=true]') ?? popover.current?.querySelector<HTMLElement>('#profiles-menu [role^=menuitem]');
  return <div className="profiles-popover" ref={popover} onKeyDown={event => {
    if (!card.current?.contains(event.target as Node)) return;
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDismiss('escape'); return; }
    if (event.key !== 'Tab') return;
    const stops = cardStops(card.current);
    if (document.activeElement !== (event.shiftKey ? stops[0] : stops.at(-1))) return;
    // Native Shift+Tab before the first control leaves the popover, as Tab from the menu does.
    if (event.shiftKey) { onDismiss('tab'); return; }
    const entry = menuEntry();
    if (entry) { event.preventDefault(); entry.focus(); }
  }} onKeyDownCapture={event => {
    // Shift+Tab from the menu returns to the card instead of closing the popover.
    if (event.key !== 'Tab' || !event.shiftKey || card.current?.contains(event.target as Node)) return;
    const last = cardStops(card.current).at(-1);
    if (!last) return;
    event.preventDefault(); event.stopPropagation(); last.focus();
  }}>
    <AccountCard account={account} language={language} commands={commands} card={card} describe={describe} />
    {children}
  </div>;
}

export function ProfilesMenu({ state, language, keyboard, opener, describe, onDismiss, onSwitch, onNew, onManage, onPrivate }: {
  state: BrowserState; language: Language; keyboard: boolean; opener: RefObject<HTMLButtonElement | null>; describe: (reason: unknown) => string;
  onDismiss: MenuDismiss; onSwitch: (profile: ProfileState) => void; onNew: () => void; onManage: () => void; onPrivate: () => void;
}) {
  const t = (key: CopyKey) => text(key, language);
  // The popover replaces this with its guarded dismissal once mounted.
  const gate = { dismiss: onDismiss };
  return <ToolbarPopover opener={opener}><ProfilesPopover account={state.account} language={language} describe={describe} gate={gate} profileCount={state.profiles.length} onDismiss={onDismiss}>
    <Menu id="profiles-menu" className="profiles-menu" label={t('profiles')} keyboard={keyboard} initialFocus="[aria-checked=true]" opener={opener} onDismiss={reason => gate.dismiss(reason)}>
      <div className="profiles-label">{t('profiles')}</div>
      <div className="profiles-scroll"><div className="profiles-list">
        {state.profiles.map(profile => { const current = profile.id === state.activeProfileId, tabs = profileTabCount(profile.tabCount, language); return <button className="profile-menu-row" type="button" role="menuitemradio" tabIndex={-1} key={profile.id} aria-checked={current} onClick={() => onSwitch(profile)}><span className="profile-icon-slot" aria-hidden="true"><span className="profile-dot" data-profile-color={profile.color} /></span><span className="profile-row-body"><strong>{profile.name}</strong><small>{current ? t('thisWindowTabs').replace('{tabs}', tabs) : tabs}</small></span>{current && <Check className="profile-check" aria-hidden="true" />}</button>; })}
      </div></div>
      <button type="button" role="menuitem" tabIndex={-1} onClick={onNew}><Plus aria-hidden="true" /><span>{t('newProfile')}</span></button>
      <button type="button" role="menuitem" tabIndex={-1} onClick={onManage}><Users aria-hidden="true" /><span>{t('manageProfiles')}</span></button>
      <hr />
      <button type="button" role="menuitem" tabIndex={-1} onClick={onPrivate}><EyeOff aria-hidden="true" /><span>{t('privateWindow')}</span></button>
    </Menu>
  </ProfilesPopover></ToolbarPopover>;
}

export function NewProfilePopover({ state, language, opener, onCancel, onSuccess }: {
  state: BrowserState; language: Language; opener: RefObject<HTMLButtonElement | null>; onCancel: () => void; onSuccess: (name: string) => void;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const cancel = useRef(onCancel);
  const formState = useRef({ name: '', pending: false });
  useEffect(() => { cancel.current = onCancel; });
  useEffect(() => {
    const outside = (event: PointerEvent) => { const target = event.target as Node; if (!formState.current.name && !formState.current.pending && !ref.current?.contains(target) && !opener.current?.contains(target)) cancel.current(); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (!formState.current.pending) cancel.current(); } };
    document.addEventListener('pointerdown', outside);
    document.addEventListener('keydown', escape, true);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape, true); };
  }, [opener]);
  return <ToolbarPopover opener={opener}><div className="new-profile-popover" id="new-profile-popover" ref={ref} role="dialog" aria-label={text('newProfile', language)}><ProfileForm language={language} profiles={state.profiles} onCancel={onCancel} onSuccess={onSuccess} onStateChange={(name, pending) => { formState.current = { name, pending }; }} /></div></ToolbarPopover>;
}

function ProfileRow({ profile, state, language, announce }: {
  profile: ProfileState; state: BrowserState; language: Language; announce: (message: string) => void;
}) {
  const t = (key: CopyKey) => text(key, language);
  const [mode, setMode] = useState<'view' | 'edit' | 'delete'>('view');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState<BrowserCommand | null>(null);
  const pending = useRef(false);
  const cancel = useRef<HTMLButtonElement>(null);
  const edit = useRef<HTMLButtonElement>(null);
  const remove = useRef<HTMLButtonElement>(null);
  const last = state.profiles.length === 1;
  const current = profile.id === state.activeProfileId;
  const run = async (command: BrowserCommand): Promise<boolean> => {
    if (pending.current) return false;
    pending.current = true; setBusy(true); setError(''); setRetry(null);
    try { await window.horizon.command(command); return true; }
    catch (reason) { const message = reason instanceof Error ? reason.message : ''; const code = Object.keys(errorLabels).find(code => message.includes(code)); setError(t(message.includes('PROFILE_LAST') ? 'lastProfile' : message.includes('PROFILE_SETTINGS_SAVE_FAILED') ? 'PROFILE_SETTINGS_SAVE_FAILED' : code ? errorLabels[code]! : 'browserError')); setRetry(command); return false; }
    finally { pending.current = false; setBusy(false); }
  };
  useEffect(() => { if (mode === 'delete') cancel.current?.focus(); }, [mode]);
  useEffect(() => {
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && pending.current) { event.preventDefault(); event.stopPropagation(); } };
    document.addEventListener('keydown', escape, true);
    return () => document.removeEventListener('keydown', escape, true);
  }, []);
  const cancelMode = (kind: 'edit' | 'delete') => { setMode('view'); requestAnimationFrame(() => (kind === 'edit' ? edit : remove).current?.focus()); };
  return <li className="managed-profile" onKeyDown={event => {
    if (event.key === 'Escape' && mode === 'delete') { event.preventDefault(); event.stopPropagation(); if (!pending.current) cancelMode('delete'); }
  }}>
    <div className="settings-profile-row"><span className="settings-profile-colour-slot" aria-hidden="true"><span className="profile-dot" data-profile-color={profile.color} /></span><div className="setting-copy"><strong>{profile.name}</strong><p className="setting-hint">{current ? t('thisWindowTabs').replace('{tabs}', profileTabCount(profile.tabCount, language)) : profileTabCount(profile.tabCount, language)}</p></div><div className="settings-profile-actions">
      {!current && <button className="settings-button quiet" type="button" disabled={busy} onClick={() => { void run({ type: 'switch-profile', id: profile.id }).then(success => { if (success) announce(t('switchedProfile').replace('{name}', profile.name)); }); }}>{t('switchProfile')}</button>}
      <button className="settings-button" type="button" ref={edit} disabled={busy} aria-expanded={mode === 'edit'} onClick={() => setMode(mode === 'edit' ? 'view' : 'edit')}>{t('editProfile')}</button>
      <button className="icon-button" type="button" ref={remove} disabled={last || busy} aria-label={t('deleteProfileLabel').replace('{name}', profile.name)} title={t('deleteProfileLabel').replace('{name}', profile.name)} aria-describedby={last ? `last-profile-${profile.id}` : undefined} aria-expanded={mode === 'delete'} onClick={() => setMode('delete')}><Trash2 aria-hidden="true" /></button>
    </div></div>
    {error && <div className="settings-feedback error" role="alert"><span>{error}</span>{retry && <button className="settings-button quiet" type="button" disabled={busy} onClick={() => { void run(retry).then(success => { if (success) announce(t(retry.type === 'delete-profile' ? 'deletedProfile' : 'switchedProfile').replace('{name}', profile.name)); }); }}>{t('retry')}</button>}</div>}
    {last && <p className="profile-disabled-reason" id={`last-profile-${profile.id}`}>{t('lastProfile')}</p>}
    {mode === 'edit' && <ProfileForm language={language} profiles={state.profiles} profile={profile} onCancel={() => cancelMode('edit')} onSuccess={name => { cancelMode('edit'); announce(t('updatedProfile').replace('{name}', name)); }} onStateChange={(_name, pending) => setBusy(pending)} />}
    {mode === 'delete' && <div className="profile-delete-confirmation" aria-busy={busy}><p>{t('confirmDeleteProfile').replace('{name}', profile.name)}</p><div className="profile-form-actions"><button className="profile-action quiet" ref={cancel} type="button" disabled={busy} onClick={() => { if (!pending.current) cancelMode('delete'); }}>{t('cancel')}</button><button className="profile-action danger" type="button" disabled={last || busy} onClick={() => {
      void run({ type: 'delete-profile', id: profile.id }).then(success => {
        if (success) { announce(t('deletedProfile').replace('{name}', profile.name)); requestAnimationFrame(() => document.getElementById('profiles-new-button')?.focus()); }
      });
    }}>{t('deleteProfile')}</button></div></div>}
  </li>;
}

export function ProfilesSettings({ state, language }: {
  state: BrowserState; language: Language;
}) {
  const t = (key: CopyKey) => text(key, language);
  const [creating, setCreating] = useState(false);
  const newButton = useRef<HTMLButtonElement>(null);
  const [announcement, announce] = useState('');
  const cancel = () => { setCreating(false); requestAnimationFrame(() => newButton.current?.focus()); };
  return <div className="settings-profiles"><div className="settings-card"><ul className="settings-profile-list">{state.profiles.map(profile => <ProfileRow key={profile.id} profile={profile} state={state} language={language} announce={announce} />)}</ul></div>
    <div className="settings-profile-new"><button className="settings-button" type="button" id="profiles-new-button" ref={newButton} aria-expanded={creating} onClick={() => setCreating(true)}><Plus aria-hidden="true" />{t('newProfile')}</button>
      {creating && <ProfileForm language={language} profiles={state.profiles} submitLabel="save" draftKey="settings-new-profile" onCancel={cancel} onSuccess={name => { cancel(); announce(t('createdProfile').replace('{name}', name)); }} />}
    </div><div className="settings-feedback" role="status" aria-live="polite">{announcement}</div>
  </div>;
}
