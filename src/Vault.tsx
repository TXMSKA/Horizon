import { useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Copy, Fingerprint, KeyRound, Lock, Plus, Search, X } from 'lucide-react';
import { text } from './copy';
import type { CopyKey } from './copy';
import type { BrowserCommand, BrowserState, Language, VaultCommand, VaultLogin, VaultSuggestion as Suggestion } from './shared/api';
import { ToolbarPopover } from './ToolbarPopover';

type Action = (command: VaultCommand) => Promise<boolean>;

// A sign-in imported from a file without names is titled with its address; the site's host is what the person recognises.
export function loginTitle(login: VaultLogin): string {
  const title = login.title.trim();
  return title && !/^https?:\/\//i.test(title) ? login.title : new URL(login.origin).host;
}

export function VaultUnlock({ language, describe, onClose, onUnlocked }: { language: Language; describe(reason: unknown): string; onClose(): void; onUnlocked(): Promise<void> }) {
  const t = (key: CopyKey) => text(key, language), id = useId();
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null), busy = useRef(false);
  const [password, setPassword] = useState(''), [pending, setPending] = useState(false), [failure, setFailure] = useState('');
  useEffect(() => { dialog.current?.showModal(); input.current?.focus(); }, []);
  // The field is disabled while the request is pending, so focus can come back only once it is enabled again.
  useEffect(() => { if (failure && !pending) input.current?.focus(); }, [failure, pending]);
  return <dialog ref={dialog} className="settings-dialog vault-dialog" aria-labelledby={`${id}-title`} aria-busy={pending} onCancel={event => { event.preventDefault(); if (!busy.current) onClose(); }}>
    <form onSubmit={event => {
      event.preventDefault(); if (busy.current) return;
      busy.current = true; setPending(true); setFailure('');
      const value = password; setPassword('');
      window.horizon.command({ type: 'vault-unlock', password: value }).then(async () => { await onUnlocked(); onClose(); }, (reason: unknown) => setFailure(describe(reason))).finally(() => { busy.current = false; setPending(false); });
    }}><div className="settings-dialog-heading"><h2 id={`${id}-title`}>{t('vaultUnlock')}</h2><p className="setting-hint">{t('vaultMasterHint')}</p></div>
      <label className="vault-form-field"><span>{t('vaultMasterPassword')}</span><input type="password" ref={input} value={password} maxLength={128} autoComplete="off" required disabled={pending} onChange={event => setPassword(event.target.value)} /></label>
      {failure && <p className="browser-panel-error" role="alert">{failure}</p>}
      <div className="settings-dialog-actions"><button className="settings-button" type="button" disabled={pending} onClick={onClose}>{t('cancel')}</button><button className="settings-button primary" type="submit" disabled={pending || !password}>{t(pending ? 'loading' : 'vaultUnlock')}</button></div>
    </form>
  </dialog>;
}

// Vault's onboarding step for the import: one approval, with the master password or Windows Hello, which also unlocks Vault.
export function VaultImportPermission({ language, windows, describe, onGranted, onClose }: { language: Language; windows: boolean; describe(reason: unknown): string; onGranted(): Promise<void>; onClose(): void }) {
  const t = (key: CopyKey) => text(key, language), id = useId();
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null), busy = useRef(false);
  const [password, setPassword] = useState(''), [pending, setPending] = useState(false), [failure, setFailure] = useState('');
  useEffect(() => { dialog.current?.showModal(); input.current?.focus(); }, []);
  useEffect(() => { if (failure && !pending) input.current?.focus(); }, [failure, pending]);
  const send = (command: VaultCommand) => {
    if (busy.current) return;
    busy.current = true; setPending(true); setFailure('');
    window.horizon.command(command).then(async () => { await onGranted(); onClose(); }, (reason: unknown) => setFailure(describe(reason))).finally(() => { busy.current = false; setPending(false); });
  };
  return <dialog ref={dialog} className="settings-dialog vault-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-hint`} aria-busy={pending} onCancel={event => { event.preventDefault(); if (!busy.current) onClose(); }}>
    <form onSubmit={event => {
      event.preventDefault();
      const value = password; setPassword('');
      send({ type: 'vault-import-permission', password: value });
    }}><div className="settings-dialog-heading"><h2 id={`${id}-title`}>{t('vaultImportPermissionTitle')}</h2><p className="setting-hint" id={`${id}-hint`}>{t('vaultImportPermissionHint')}</p></div>
      <label className="vault-form-field"><span>{t('vaultMasterPassword')}</span><input type="password" ref={input} value={password} maxLength={128} autoComplete="off" required disabled={pending} onChange={event => setPassword(event.target.value)} /></label>
      {failure && <p className="browser-panel-error" role="alert">{failure}</p>}
      <div className="settings-dialog-actions"><button className="settings-button" type="button" disabled={pending} onClick={onClose}>{t('cancel')}</button>
        {windows && <button className="settings-button" type="button" disabled={pending} onClick={() => send({ type: 'vault-import-permission-hello' })}><Fingerprint aria-hidden="true" />{t('vaultImportPermissionHello')}</button>}
        <button className="settings-button primary" type="submit" disabled={pending || !password}>{t(pending ? 'loading' : 'vaultImportPermissionAllow')}</button></div>
    </form>
  </dialog>;
}

function VaultBadge({ login }: { login: VaultLogin }) {
  return <span className="browser-site-badge vault-badge" data-profile-color="blue" aria-hidden="true">{loginTitle(login).slice(0, 1).toUpperCase()}</span>;
}

export function PasswordsPanel({ state, language, opener, run, describe, onDismiss, onAnnounce }: {
  state: BrowserState; language: Language; opener: RefObject<HTMLButtonElement | null>; run(command: BrowserCommand): Promise<boolean>; describe(reason: unknown): string;
  onDismiss(focus: boolean): void; onAnnounce(message: string): void;
}) {
  const t = (key: CopyKey) => text(key, language), id = useId();
  const panel = useRef<HTMLElement>(null), search = useRef<HTMLInputElement>(null), busy = useRef(false);
  const [filter, setFilter] = useState(''), [unlock, setUnlock] = useState(false), [adding, setAdding] = useState(false), [pending, setPending] = useState(false);
  const [form, setForm] = useState({ title: '', website: '', username: '', password: '' });
  useEffect(() => { void run({ type: 'vault-refresh' }); }, [run]);
  useEffect(() => { (search.current ?? panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus(); }, [state.vault.unlocked]);
  useEffect(() => {
    // The install offer is a dialog of its own, outside the panel; answering it must not close the Passwords panel it came from.
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !opener.current?.contains(event.target as Node) && !(event.target as Element).closest?.('.service-dialog')) onDismiss(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [run, onDismiss, opener]);
  const action: Action = async command => {
    if (busy.current) return false;
    busy.current = true; setPending(true);
    try { return await run(command); } finally { busy.current = false; setPending(false); }
  };
  const requestUnlock = async () => {
    if (state.vault.windows && await action({ type: 'vault-hello' })) search.current?.focus();
    else setUnlock(true);
  };
  const logins = state.vault.logins.filter(item => `${item.title} ${item.username} ${item.origin}`.toLocaleLowerCase(language).includes(filter.toLocaleLowerCase(language)));
  return <ToolbarPopover opener={opener}><section id="browser-library-panel" className="browser-library-panel vault-panel" ref={panel} role="dialog" aria-labelledby={`${id}-title`} aria-busy={pending} onKeyDown={event => {
    if (event.key === 'Escape' && !unlock) { event.preventDefault(); event.stopPropagation(); onDismiss(true); }
    if (event.key === 'Tab' && !unlock) {
      const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])];
      if (document.activeElement === (event.shiftKey ? controls[0] : controls.at(-1))) { event.preventDefault(); onDismiss(true); }
    }
  }}><div className="browser-panel-title"><h2 id={`${id}-title`}>{t('passwords')}</h2>{state.vault.unlocked && <button className="icon-button" aria-label={t('vaultLock')} title={t('vaultLock')} disabled={pending} onClick={() => { void action({ type: 'vault-lock' }); }}><Lock aria-hidden="true" /></button>}</div>
    <p className="vault-status"><Fingerprint aria-hidden="true" /><span>{t(state.vault.unlocked ? state.vault.unlockMethod === 'hello' ? 'vaultUnlockedHello' : 'vaultUnlocked' : 'vaultLocked')}</span></p>
    {state.vault.error && <p className="browser-panel-error" role="alert">{t(state.vault.error)}</p>}
    {state.vault.unlocked ? <>
      <div className="search-field browser-panel-search"><Search aria-hidden="true" /><input ref={search} aria-label={t('vaultSearch')} placeholder={t('vaultSearch')} value={filter} onChange={event => setFilter(event.target.value)} /></div>
      <ul className="browser-library-list">{logins.map(login => <li className="browser-library-row vault-row" key={`${login.origin}:${login.id}`}><VaultBadge login={login} /><span className="browser-entry-copy"><span title={login.origin}>{loginTitle(login)}</span><small>{login.username}</small></span><button className="icon-button" type="button" disabled={pending} aria-label={t('vaultCopy').replace('{site}', loginTitle(login))} title={t('copy')} onClick={() => {
        void action({ type: 'vault-copy', id: login.id, origin: login.origin }).then(success => { if (success) onAnnounce(t('vaultCopied')); });
      }}><Copy aria-hidden="true" /></button></li>)}</ul>
      {!logins.length && <p className="vault-note">{t(filter ? 'noResultsTitle' : 'vaultEmpty')}</p>}
      <p className="vault-note">{t('vaultKnownSites')}</p><hr />
      {adding ? <form className="vault-add" onSubmit={event => {
        event.preventDefault(); const entry = form;
        setForm({ ...form, password: '' });
        void action({ type: 'vault-add', ...entry }).then(success => { if (success) { setAdding(false); setForm({ title: '', website: '', username: '', password: '' }); onAnnounce(t('vaultAdded')); } });
      }}>{(['title', 'website', 'username', 'password'] as const).map(field => <label className="vault-form-field" key={field}><span>{t(field === 'title' ? 'vaultTitle' : field === 'website' ? 'vaultWebsite' : field === 'username' ? 'vaultUsername' : 'vaultPassword')}</span><input type={field === 'password' ? 'password' : field === 'website' ? 'url' : 'text'} autoComplete="off" value={form[field]} required={field !== 'username'} maxLength={field === 'title' ? 500 : field === 'website' ? 8192 : 32000} disabled={pending} onChange={event => setForm({ ...form, [field]: event.target.value })} /></label>)}<div className="settings-dialog-actions"><button className="settings-button" type="button" disabled={pending} onClick={() => { setAdding(false); setForm({ title: '', website: '', username: '', password: '' }); }}>{t('cancel')}</button><button className="settings-button primary" type="submit" disabled={pending}>{t('save')}</button></div></form>
        : <button className="browser-panel-foot" type="button" onClick={() => setAdding(true)}><span><Plus aria-hidden="true" /></span>{t('vaultAdd')}</button>}
    </> : <><p className="vault-note">{t('vaultUnlockHint')}</p><button className="settings-button" type="button" disabled={pending} onClick={() => { void requestUnlock(); }}><KeyRound aria-hidden="true" />{t('vaultUnlock')}</button></>}
    {unlock && <VaultUnlock language={language} describe={describe} onClose={() => { setUnlock(false); search.current?.focus(); }} onUnlocked={async () => {}} />}
  </section></ToolbarPopover>;
}

export function VaultSuggestion({ suggestion, state, language, run, describe }: { suggestion: Suggestion; state: BrowserState; language: Language; run(command: BrowserCommand): Promise<boolean>; describe(reason: unknown): string }) {
  const t = (key: CopyKey) => text(key, language), ref = useRef<HTMLElement>(null), busy = useRef(false);
  const [selected, setSelected] = useState<VaultLogin | null>(null), [asking, setAsking] = useState(false), [pending, setPending] = useState(false);
  const dismiss = () => { void run({ type: 'vault-dismiss' }); };
  useEffect(() => {
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node)) void run({ type: 'vault-dismiss' }); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape' && !ref.current?.querySelector('dialog[open]')) { event.preventDefault(); void run({ type: 'vault-dismiss' }); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [run]);
  const action: Action = async command => {
    if (busy.current) return false;
    busy.current = true; setPending(true);
    try { return await run(command); } finally { busy.current = false; setPending(false); }
  };
  const fill = (login: VaultLogin) => action({ type: 'vault-fill', suggestion: suggestion.id, id: login.id });
  const choose = async (login: VaultLogin) => {
    if (state.vault.unlocked || state.vault.windows && await action({ type: 'vault-hello' })) await fill(login);
    else setSelected(login);
  };
  // Locked, the suggestion offers only the unlock. Once it succeeds the backend replaces the suggestion with the sign-ins of this site.
  const unlock = async () => {
    if (!(state.vault.windows && await action({ type: 'vault-hello' }))) setAsking(true);
  };
  return <section className="vault-suggestion" ref={ref} role="dialog" aria-label="Vault" aria-busy={pending} style={{ left: `clamp(var(--toolbar-popup-edge), ${suggestion.x}px, calc(100vw - var(--width-vault-suggestion) - var(--toolbar-popup-edge)))`, top: `min(${suggestion.y}px, calc(100vh - var(--height-vault-suggestion)))` }}>
    <div className="vault-heading"><KeyRound aria-hidden="true" /><strong>Vault</strong><button className="icon-button" aria-label={t('close')} onClick={dismiss}><X aria-hidden="true" /></button></div>
    {suggestion.locked && <button className="vault-account" type="button" disabled={pending} onClick={() => { void unlock(); }}><span className="browser-site-badge vault-badge" data-profile-color="blue" aria-hidden="true">{state.vault.windows ? <Fingerprint /> : <KeyRound />}</span><span className="browser-entry-copy"><span>{t('vaultUnlock')}</span></span></button>}
    {suggestion.logins.map(login => <button className="vault-account" type="button" key={login.id} disabled={pending} onClick={() => { void choose(login); }}><VaultBadge login={login} /><span className="browser-entry-copy"><span>{login.username || loginTitle(login)}</span><small>{new URL(login.origin).host}</small></span></button>)}
    <p className="vault-note vault-status"><Fingerprint aria-hidden="true" /><span>{t(state.vault.unlocked ? 'vaultFillHint' : state.vault.windows ? 'vaultHelloHint' : 'vaultMasterFillHint')}</span></p>
    {asking && <VaultUnlock language={language} describe={describe} onClose={() => setAsking(false)} onUnlocked={async () => {}} />}
    {selected && <VaultUnlock language={language} describe={describe} onClose={() => setSelected(null)} onUnlocked={async () => { await fill(selected); }} />}
  </section>;
}
