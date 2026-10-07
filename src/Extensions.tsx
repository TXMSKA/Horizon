import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { ExternalLink, Pin, Puzzle, TriangleAlert } from 'lucide-react';
import { text } from './copy';
import type { CopyKey } from './copy';
import type { BrowserCommand, BrowserState, ExtensionState, ExtensionWarning, Language } from './shared/api';
import { ToolbarPopover } from './ToolbarPopover';
import { Switch } from './Switch';
import { settingsError } from './Settings';

export const STORE_URL = 'https://chromewebstore.google.com/';
export function ExtensionIcon({ extension }: { extension: ExtensionState }) {
  const [url, setURL] = useState<string>();
  useEffect(() => {
    if (!extension.icon) { setURL(undefined); return; }
    const url = URL.createObjectURL(new Blob([new Uint8Array(extension.icon)], { type: 'image/png' }));
    setURL(url); return () => URL.revokeObjectURL(url);
  }, [extension.icon]);
  return <span className="extension-icon" aria-hidden="true">{url ? <img src={url} alt="" /> : <Puzzle />}</span>;
}
function ExtensionRow({ extension, language, run }: { extension: ExtensionState; language: Language; run: (command: BrowserCommand) => Promise<boolean> }) {
  const id = useId(), pending = useRef(false);
  const t = (key: CopyKey) => text(key, language);
  const apply = (command: BrowserCommand) => { if (pending.current) return; pending.current = true; void run(command).finally(() => { pending.current = false; }); };
  return <div className="extension-row"><ExtensionIcon extension={extension} /><span id={id} title={extension.name}>{extension.name}</span>
    <Switch checked={extension.enabled} labelledBy={id} onChange={enabled => apply({ type: 'set-extension-enabled', id: extension.id, enabled })} />
    <button className="extension-pin" type="button" aria-pressed={extension.pinned} aria-label={t(extension.pinned ? 'unpinExtension' : 'pinExtension').replace('{name}', extension.name)} title={t(extension.pinned ? 'unpinExtension' : 'pinExtension').replace('{name}', extension.name)} onClick={() => apply({ type: 'set-extension-pinned', id: extension.id, pinned: !extension.pinned })}><Pin aria-hidden="true" /></button>
  </div>;
}
export function ExtensionsPopover({ state, language, opener, onDismiss, onManage, run }: {
  state: BrowserState; language: Language; opener: RefObject<HTMLButtonElement | null>; onDismiss: (focus: boolean) => void; onManage: () => void; run: (command: BrowserCommand) => Promise<boolean>;
}) {
  const ref = useRef<HTMLDivElement>(null), dismiss = useRef(onDismiss);
  useLayoutEffect(() => { dismiss.current = onDismiss; });
  useEffect(() => {
    ref.current?.querySelector<HTMLButtonElement>('button')?.focus();
    const outside = (event: PointerEvent) => { if (!ref.current?.contains(event.target as Node) && !opener.current?.contains(event.target as Node)) dismiss.current(false); };
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside);
  }, [opener]);
  const t = (key: CopyKey) => text(key, language);
  return <ToolbarPopover opener={opener}><div className="extensions-popover" id="extensions-popover" ref={ref} role="dialog" aria-labelledby="extensions-heading" onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onDismiss(true); }
    if (event.key === 'Tab') {
      const stops = [...(ref.current?.querySelectorAll<HTMLButtonElement>('button:not(:disabled)') ?? [])];
      if (document.activeElement === (event.shiftKey ? stops[0] : stops.at(-1))) { event.preventDefault(); onDismiss(true); if (!event.shiftKey) (opener.current?.nextElementSibling as HTMLElement)?.focus(); }
    }
  }}><h2 id="extensions-heading">{t('extensions')}</h2><div>{state.extensions.length ? state.extensions.map(extension => <ExtensionRow key={extension.id} extension={extension} language={language} run={run} />) : <p className="settings-note">{t('noExtensions')}</p>}</div><hr />
    <div><button className="extension-menu-row" type="button" onClick={() => { onDismiss(true); void run({ type: 'new-tab', input: STORE_URL }); }}><ExternalLink aria-hidden="true" /><span>{t('getExtensions')}</span></button>
    <button className="extension-menu-row" type="button" onClick={onManage}><Puzzle aria-hidden="true" /><span>{t('manageExtensions')}</span></button></div>
  </div></ToolbarPopover>;
}
export function ExtensionInstallDialog({ warning, language, onAnswer }: { warning: ExtensionWarning; language: Language; onAnswer: (allow: boolean) => Promise<boolean> }) {
  const ref = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null), pending = useRef(false);
  const [busy, setBusy] = useState(false);
  const t = (key: CopyKey) => text(key, language), id = useId();
  useLayoutEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null, dialog = ref.current;
    dialog?.showModal(); cancel.current?.focus();
    return () => { dialog?.close(); if (opener?.isConnected) opener.focus(); };
  }, []);
  const answer = (allow: boolean) => { if (pending.current) return; pending.current = true; setBusy(true); void onAnswer(allow).finally(() => { pending.current = false; setBusy(false); }); };
  return <dialog className="settings-dialog extension-warning" ref={ref} aria-labelledby={`${id}-title`} aria-describedby={`${id}-description`} onCancel={event => { event.preventDefault(); answer(false); }}>
    <h2 id={`${id}-title`}><TriangleAlert aria-hidden="true" />{warning.unsupported.length ? t('extensionWarning') : t('extensionInstallTitle').replace('{name}', warning.name)}</h2>
    <div id={`${id}-description`}><p><strong>{warning.name}</strong></p>{warning.unsupported.length > 0 && <p>{t('extensionUnsupported').replace('{features}', warning.unsupported.join(', '))}</p>}<p>{t('extensionPrivacy')}</p>
    {warning.permissions.length > 0 && <p className="setting-hint">{t('extensionPermissions')}: {warning.permissions.join(', ')}</p>}</div>
    <div className="settings-dialog-actions" aria-busy={busy}><button className="settings-button quiet" type="button" disabled={busy} onClick={() => answer(true)}>{t(warning.unsupported.length ? 'installAnyway' : 'installExtension')}</button><button className="settings-button primary" ref={cancel} type="button" disabled={busy} onClick={() => answer(false)}>{t('cancel')}</button></div>
  </dialog>;
}
export function ExtensionsSettings({ state, language }: { state: BrowserState; language: Language }) {
  const t = (key: CopyKey) => text(key, language);
  const [result, setResult] = useState(''), [failure, setFailure] = useState(''), [remove, setRemove] = useState<ExtensionState | null>(null);
  const pending = useRef(false), ref = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null), opener = useRef<HTMLElement | null>(null);
  const run = async (command: BrowserCommand) => {
    if (pending.current) return false;
    pending.current = true; setFailure(''); setResult('');
    try { await window.horizon.command(command); setResult(t(command.type === 'check-extension-updates' ? 'extensionUpdatesChecked' : 'settingsSaved')); return true; }
    catch (reason) { setFailure(settingsError(reason, language)); return false; }
    finally { pending.current = false; }
  };
  useLayoutEffect(() => { if (remove) { ref.current?.showModal(); cancel.current?.focus(); } }, [remove]);
  const close = () => { ref.current?.close(); setRemove(null); opener.current?.focus(); };
  return <><p className="settings-note">{t('extensionsProfile').replace('{name}', state.profiles.find(profile => profile.id === state.activeProfileId)?.name ?? '')}</p>
    <div className="extension-settings-actions"><button className="settings-button" type="button" onClick={() => { void run({ type: 'new-tab', input: STORE_URL }); }}><ExternalLink aria-hidden="true" />{t('getExtensions')}</button><button className="settings-button" type="button" disabled={state.extensionsUpdating} onClick={() => { void run({ type: 'check-extension-updates' }); }}>{t(state.extensionsUpdating ? 'checkingExtensionUpdates' : 'checkExtensionUpdates')}</button></div>
    <div role="status" className="settings-feedback">{result}</div>{(failure || state.extensionsError) && <p className="settings-feedback error" role="alert">{failure || t('EXTENSION_STORAGE_FAILED')}</p>}
    <div className="settings-card">{state.extensions.length ? state.extensions.map(extension => <section className="extension-details" key={extension.id}>
      <ExtensionRow extension={extension} language={language} run={run} /><p className="settings-note">{extension.description}</p><p className="settings-note">{extension.version} · {extension.id}</p>
      {extension.unsupported.length > 0 && <p className="settings-note">{t('extensionUnsupported').replace('{features}', extension.unsupported.join(', '))}</p>}
      {extension.failed && <p className="settings-feedback error" role="alert">{t('extensionLoadFailed')}</p>}
      <p className="settings-note">{t('extensionPermissions')}: {extension.permissions.join(', ')}</p>
      <button className="settings-button quiet" type="button" onClick={event => { opener.current = event.currentTarget; setRemove(extension); }}>{t('removeExtension').replace('{name}', extension.name)}</button>
    </section>) : <div className="settings-empty">{t('noExtensions')}</div>}</div>
    {remove && <dialog className="settings-dialog" ref={ref} aria-labelledby="remove-extension-title" onCancel={event => { event.preventDefault(); close(); }}><h2 id="remove-extension-title">{t('removeExtension').replace('{name}', remove.name)}</h2><p>{t('confirmRemoveExtension').replace('{name}', remove.name)}</p><div className="settings-dialog-actions"><button className="settings-button quiet" type="button" onClick={() => { void run({ type: 'remove-extension', id: remove.id }).then(success => { if (success) close(); }); }}>{t('removeExtension').replace('{name}', remove.name)}</button><button className="settings-button primary" ref={cancel} type="button" onClick={close}>{t('cancel')}</button></div></dialog>}
  </>;
}
