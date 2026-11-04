import { useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Copy, Fingerprint, KeyRound, LoaderCircle, Lock, Plus, Search, TriangleAlert, X } from 'lucide-react';
import { text } from './copy';
import type { CopyKey } from './copy';
import type { BrowserCommand, BrowserState, Language, VaultCommand, VaultLogin, VaultOverlayCommand, VaultSuggestion as Suggestion } from './shared/api';
import { ToolbarPopover } from './ToolbarPopover';

type Action = (command: VaultCommand) => Promise<boolean>;

// A sign-in imported from a file without names is titled with its address; the site's host is what the person recognises.
export function loginTitle(login: VaultLogin): string {
  const title = login.title.trim();
  return title && !/^https?:\/\//i.test(title) ? login.title : new URL(login.origin).host;
}

// One dialog for every unlock: Windows Hello first where it exists, the master password in the same place, and the errors inside it.
// site names the page the sign-in will fill; without it the dialog is the general unlock.
export function VaultUnlock({ language, windows, site, describe, onClose, onUnlocked }: { language: Language; windows: boolean; site?: string; describe(reason: unknown): string; onClose(): void; onUnlocked(): Promise<void> }) {
  const t = (key: CopyKey) => text(key, language), id = useId();
  const dialog = useRef<HTMLDialogElement>(null), input = useRef<HTMLInputElement>(null), hello = useRef<HTMLButtonElement>(null), busy = useRef(false);
  const [password, setPassword] = useState(''), [pending, setPending] = useState<'hello' | 'master' | null>(null), [failure, setFailure] = useState(''), [helloOff, setHelloOff] = useState(false), [helloFailed, setHelloFailed] = useState(false);
  const withHello = windows && !helloOff;
  useEffect(() => { dialog.current?.showModal(); (hello.current ?? input.current)?.focus(); }, []);
  // The controls are disabled while the request is pending, so focus can come back only once they are enabled again.
  useEffect(() => { if (failure && !pending) (helloFailed && hello.current ? hello.current : input.current)?.focus(); }, [failure, pending, helloFailed]);
  const send = (command: VaultCommand, method: 'hello' | 'master') => {
    if (busy.current) return;
    busy.current = true; setPending(method); setFailure('');
    window.horizon.command(command).then(async () => { await onUnlocked(); onClose(); }, (reason: unknown) => {
      const message = reason instanceof Error ? reason.message : String(reason);
      // A Hello that is not set up or not available is not offered again in this dialog.
      if (method === 'hello' && /VAULT_HELLO_NOT_SET_UP|VAULT_HELLO_UNAVAILABLE/.test(message)) setHelloOff(true);
      setHelloFailed(method === 'hello'); setFailure(describe(reason));
    }).finally(() => { busy.current = false; setPending(null); });
  };
  return <dialog ref={dialog} className="settings-dialog vault-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-hint`} aria-busy={pending !== null} onCancel={event => { event.preventDefault(); if (!busy.current) onClose(); }} onKeyDown={event => {
      if (event.key !== 'Tab') return;
      // The dialog is modal, so Tab cycles inside it; the Hub and the Passwords panel around it close on a Tab off their last control.
      event.stopPropagation();
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])];
      if (!controls.length) { event.preventDefault(); return; }
      if (document.activeElement === (event.shiftKey ? controls[0] : controls.at(-1))) { event.preventDefault(); (event.shiftKey ? controls.at(-1) : controls[0])?.focus(); }
    }}>
    <form onSubmit={event => {
      event.preventDefault(); if (busy.current || !password) return;
      const value = password; setPassword('');
      send({ type: 'vault-unlock', password: value }, 'master');
    }}><div className="settings-dialog-heading"><h2 id={`${id}-title`}><Lock aria-hidden="true" />{t('vaultLocked')}</h2><p className="setting-hint" id={`${id}-hint`}>{site ? t('vaultUnlockSite').replace('{site}', site) : t('vaultUnlockGeneral')}</p></div>
      {withHello && <><button className="settings-button primary vault-hello" type="button" ref={hello} disabled={pending !== null} onClick={() => send({ type: 'vault-hello' }, 'hello')}>{pending === 'hello' ? <LoaderCircle className="spinner" aria-hidden="true" /> : <Fingerprint aria-hidden="true" />}{t(pending === 'hello' ? 'vaultUnlocking' : 'vaultUseHello')}</button>
        <p className="vault-divider" aria-hidden="true"><span>{t('vaultOrMaster')}</span></p></>}
      <label className="vault-form-field"><span>{t('vaultMasterPassword')}</span><input type="password" ref={input} value={password} maxLength={128} autoComplete="off" required disabled={pending !== null} aria-invalid={Boolean(failure) && !helloFailed} aria-describedby={failure ? `${id}-error` : undefined} onChange={event => setPassword(event.target.value)} /></label>
      {failure && <p className="vault-error" id={`${id}-error`} role="alert"><TriangleAlert aria-hidden="true" /><span>{failure}</span></p>}
      <div className="settings-dialog-actions"><button className="settings-button" type="button" disabled={pending !== null} onClick={onClose}>{t('cancel')}</button><button className={`settings-button${withHello ? '' : ' primary'}`} type="submit" disabled={pending !== null || !password}>{pending === 'master' && <LoaderCircle className="spinner" aria-hidden="true" />}{t(pending === 'master' ? 'vaultUnlocking' : 'vaultUnlockButton')}</button></div>
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
  return <dialog ref={dialog} className="settings-dialog vault-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-hint`} aria-busy={pending} onCancel={event => { event.preventDefault(); if (!busy.current) onClose(); }} onKeyDown={event => {
      if (event.key !== 'Tab') return;
      // The dialog is modal, so Tab cycles inside it and never reaches the Hub, which closes on a Tab off its last control.
      event.stopPropagation();
      const controls = [...(dialog.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])];
      if (!controls.length) { event.preventDefault(); return; }
      if (document.activeElement === (event.shiftKey ? controls[0] : controls.at(-1))) { event.preventDefault(); (event.shiftKey ? controls.at(-1) : controls[0])?.focus(); }
    }}>
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

// Embedded, the panel is a page of a popover that already has its title, outside click and Tab handling, and the Escape that closes it.
export function PasswordsPanel({ state, language, opener, run, describe, onDismiss, onAnnounce, embedded = false }: {
  state: BrowserState; language: Language; opener: RefObject<HTMLButtonElement | null>; run(command: BrowserCommand): Promise<boolean>; describe(reason: unknown): string;
  onDismiss(focus: boolean): void; onAnnounce(message: string): void; embedded?: boolean;
}) {
  const t = (key: CopyKey) => text(key, language), id = useId();
  const panel = useRef<HTMLElement>(null), search = useRef<HTMLInputElement>(null), busy = useRef(false);
  const [filter, setFilter] = useState(''), [unlock, setUnlock] = useState(false), [adding, setAdding] = useState(false), [pending, setPending] = useState(false);
  const [form, setForm] = useState({ title: '', website: '', username: '', password: '' });
  useEffect(() => { void run({ type: 'vault-refresh' }); }, [run]);
  useEffect(() => { (search.current ?? panel.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus(); }, [state.vault.unlocked]);
  useEffect(() => {
    if (embedded) return;
    // The install offer is a dialog of its own, outside the panel; answering it must not close the Passwords panel it came from.
    const outside = (event: PointerEvent) => { if (!panel.current?.contains(event.target as Node) && !opener.current?.contains(event.target as Node) && !(event.target as Element).closest?.('.service-dialog')) onDismiss(false); };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [run, onDismiss, opener, embedded]);
  const action: Action = async command => {
    if (busy.current) return false;
    busy.current = true; setPending(true);
    try { return await run(command); } finally { busy.current = false; setPending(false); }
  };
  const logins = state.vault.logins.filter(item => `${item.title} ${item.username} ${item.origin}`.toLocaleLowerCase(language).includes(filter.toLocaleLowerCase(language)));
  const lock = state.vault.unlocked && <button className="icon-button" aria-label={t('vaultLock')} title={t('vaultLock')} disabled={pending} onClick={() => { void action({ type: 'vault-lock' }); }}><Lock aria-hidden="true" /></button>;
  const body = <section id={embedded ? undefined : 'browser-library-panel'} className={`browser-library-panel vault-panel${embedded ? ' embedded' : ''}`} ref={panel} role={embedded ? undefined : 'dialog'} aria-labelledby={embedded ? undefined : `${id}-title`} aria-busy={pending} onKeyDown={event => {
    // The unlock dialog's own Escape closes only the dialog, never the popover around it.
    if (event.key === 'Escape' && unlock && embedded) event.stopPropagation();
    if (embedded) return;
    if (event.key === 'Escape' && !unlock) { event.preventDefault(); event.stopPropagation(); onDismiss(true); }
    if (event.key === 'Tab' && !unlock) {
      const controls = [...(panel.current?.querySelectorAll<HTMLElement>('button:not(:disabled), input:not(:disabled)') ?? [])];
      if (document.activeElement === (event.shiftKey ? controls[0] : controls.at(-1))) { event.preventDefault(); onDismiss(true); }
    }
  }}>{embedded ? lock && <div className="browser-panel-title vault-lock-row">{lock}</div> : <div className="browser-panel-title"><h2 id={`${id}-title`}>{t('passwords')}</h2>{lock}</div>}
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
    </> : <><p className="vault-note">{t('vaultUnlockHint')}</p><button className="settings-button" type="button" disabled={pending} onClick={() => setUnlock(true)}><KeyRound aria-hidden="true" />{t('vaultUnlock')}</button></>}
    {unlock && <VaultUnlock language={language} windows={state.vault.windows} describe={describe} onClose={() => { setUnlock(false); search.current?.focus(); }} onUnlocked={async () => {}} />}
  </section>;
  return embedded ? body : <ToolbarPopover opener={opener}>{body}</ToolbarPopover>;
}

// The card over a sign-in field. It is drawn by the suggestion's own view, so the page below stays live; it asks only to fill, to dismiss, or to unlock.
export function VaultSuggestionCard({ suggestion, windows, language, command, onSize }: { suggestion: Suggestion; windows: boolean; language: Language; command(command: VaultOverlayCommand): Promise<void>; onSize(width: number, height: number): void }) {
  const t = (key: CopyKey) => text(key, language), ref = useRef<HTMLElement>(null), busy = useRef(false);
  const [pending, setPending] = useState(false), [failure, setFailure] = useState('');
  useEffect(() => {
    const card = ref.current;
    if (!card) return;
    const report = () => onSize(card.offsetWidth, card.offsetHeight);
    report();
    const observer = new ResizeObserver(report); observer.observe(card);
    return () => observer.disconnect();
  }, [onSize]);
  const act = async (next: VaultOverlayCommand) => {
    if (busy.current) return;
    busy.current = true; setPending(true); setFailure('');
    try { await command(next); } catch { setFailure(t('VAULT_PAGE_CHANGED')); } finally { busy.current = false; setPending(false); }
  };
  return <section className="vault-suggestion vault-overlay-card" ref={ref} role="dialog" aria-label="Vault" aria-busy={pending} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); void act({ type: 'vault-dismiss' }); } }}>
    <div className="vault-heading"><KeyRound aria-hidden="true" /><strong>Vault</strong><button className="icon-button" type="button" aria-label={t('close')} title={t('close')} onClick={() => { void act({ type: 'vault-dismiss' }); }}><X aria-hidden="true" /></button></div>
    {suggestion.locked && <button className="vault-account" type="button" disabled={pending} onClick={() => { void act({ type: 'vault-ask' }); }}><span className="browser-site-badge vault-badge" data-profile-color="blue" aria-hidden="true">{windows ? <Fingerprint /> : <KeyRound />}</span><span className="browser-entry-copy"><span>{t('vaultUnlockToFill')}</span></span></button>}
    {suggestion.logins.map(login => <button className="vault-account" type="button" key={login.id} disabled={pending} onClick={() => { void act({ type: 'vault-fill', suggestion: suggestion.id, id: login.id }); }}><VaultBadge login={login} /><span className="browser-entry-copy"><span>{login.username || loginTitle(login)}</span><small>{new URL(login.origin).host}</small></span></button>)}
    {failure && <p className="vault-error" role="alert"><TriangleAlert aria-hidden="true" /><span>{failure}</span></p>}
  </section>;
}
