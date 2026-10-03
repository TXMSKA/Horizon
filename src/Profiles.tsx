import { useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Check, LoaderCircle, Plus, Trash2, TriangleAlert, Users } from 'lucide-react';
import { text } from './copy';
import type { CopyKey } from './copy';
import { PROFILE_COLORS } from './shared/api';
import type { BrowserCommand, BrowserState, Language, ProfileColor, ProfileState } from './shared/api';
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

export function ProfileControl({ profile, language, open, opener, onClick }: {
  profile?: ProfileState; language: Language; open: 'menu' | 'new' | null; opener: RefObject<HTMLButtonElement | null>; onClick: (keyboard: boolean) => void;
}) {
  const name = profile?.name ?? text('personal', language);
  return <button className="icon-button profile-avatar" type="button" ref={opener} aria-haspopup="menu" aria-expanded={Boolean(open)} aria-controls={open === 'new' ? 'new-profile-popover' : 'profiles-menu'} aria-label={text('profile', language).replace('{name}', name)} title={name} onClick={event => onClick(event.detail === 0)}><span className="avatar-circle" aria-hidden="true">{Array.from(name)[0]?.toLocaleUpperCase(language)}</span></button>;
}

export function ProfilesMenu({ state, language, keyboard, opener, onDismiss, onSwitch, onNew, onManage }: {
  state: BrowserState; language: Language; keyboard: boolean; opener: RefObject<HTMLButtonElement | null>;
  onDismiss: (reason: 'escape' | 'tab' | 'outside') => void; onSwitch: (profile: ProfileState) => void; onNew: () => void; onManage: () => void;
}) {
  const t = (key: CopyKey) => text(key, language);
  return <ToolbarPopover opener={opener}><Menu id="profiles-menu" className="profiles-menu" label={t('profiles')} keyboard={keyboard} initialFocus="[aria-checked=true]" opener={opener} onDismiss={onDismiss}>
    <div className="profiles-label">{t('profiles')}</div>
    {state.profiles.map(profile => <button className="profile-menu-row" type="button" role="menuitemradio" tabIndex={-1} key={profile.id} aria-checked={profile.id === state.activeProfileId} onClick={() => onSwitch(profile)}><span className="profile-icon-slot" aria-hidden="true"><span className="profile-dot" data-profile-color={profile.color} /></span><span className="profile-row-body"><strong>{profile.name}</strong></span>{profile.id === state.activeProfileId && <Check className="profile-check" aria-hidden="true" />}</button>)}
    <button type="button" role="menuitem" tabIndex={-1} onClick={onNew}><Plus aria-hidden="true" /><span>{t('newProfile')}</span></button>
    <button type="button" role="menuitem" tabIndex={-1} onClick={onManage}><Users aria-hidden="true" /><span>{t('manageProfiles')}</span></button>
  </Menu></ToolbarPopover>;
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
