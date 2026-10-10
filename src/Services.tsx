import { useEffect, useId, useRef } from 'react';
import { ExternalLink } from 'lucide-react';
import { text } from './copy';
import type { CopyKey } from './copy';
import type { Language } from './shared/api';
import { SERVICE_INFO } from './shared/services';
import type { ServiceDialog as Dialog, ServiceId, ServicesCommand, ServiceStatus } from './shared/services';

const MB = 1024 * 1024;
export const serviceName = (service: ServiceId, language: Language) => text(service === 'vault' ? 'serviceVault' : 'lyra', language);
export function serviceStatusText(service: ServiceId, status: ServiceStatus, language: Language): string {
  const hint = text(service === 'vault' ? 'serviceVaultHint' : 'serviceLyraHint', language);
  const key: CopyKey = status === 'installed' ? 'serviceInstalled' : status === 'not_installed' ? 'serviceNotInstalled' : status === 'did_not_start' ? 'serviceDidNotStart' : 'serviceChecking';
  return `${hint} ${text(key, language)}`;
}

// Everything the dialog says, from the contract's texts: the offer names what is downloaded, from where and how large, before anything is.
export function serviceDialogText(dialog: Dialog, language: Language): { title: string; body: string } {
  const t = (key: CopyKey) => text(key, language), name = serviceName(dialog.service, language), repo = SERVICE_INFO[dialog.service].repo;
  const fill = (value: string) => value.replaceAll('{service}', name).replaceAll('{repo}', repo);
  const vault = dialog.service === 'vault';
  switch (dialog.phase) {
    case 'offer': {
      const tail: CopyKey = dialog.manual ? 'serviceDownloadManual' : dialog.release === 'missing' ? 'serviceDownloadMissing' : dialog.sizeMb !== null ? 'serviceDownloadSize' : 'serviceDownloadNoSize';
      return { title: t(vault ? 'serviceVaultTitle' : 'serviceLyraTitle'), body: `${t(vault ? 'serviceVaultIntro' : 'serviceLyraIntro')} ${fill(t(tail)).replace('{size}', String(dialog.sizeMb ?? ''))}` };
    }
    case 'downloading': {
      const total = dialog.total !== null ? Math.max(1, Math.round(dialog.total / MB)) : dialog.sizeMb;
      return { title: fill(t('serviceInstallingTitle')), body: fill(t(total === null ? 'serviceDownloadingStart' : 'serviceDownloading')).replace('{received}', String(Math.min(Math.floor(dialog.received / MB), total ?? 0))).replace('{total}', String(total ?? '')) };
    }
    case 'installing': return { title: fill(t('serviceInstallingTitle')), body: fill(t('serviceInstalling')) };
    case 'finish': return { title: fill(t('serviceFinishTitle')), body: fill(t(vault ? 'serviceVaultFinish' : 'serviceFinish')) };
    case 'failed': {
      const reason: CopyKey = dialog.failure === 'checksum' ? 'serviceFailedChecksum' : dialog.failure === 'install' ? 'serviceFailedInstall' : dialog.failure === 'busy' ? 'serviceFailedBusy' : 'serviceFailedDownload';
      return { title: fill(t('serviceFailedTitle')), body: fill(`${t(reason)} ${t('serviceManualPath')}`) };
    }
    case 'not-started': return { title: fill(t('serviceNotStartedTitle')), body: fill(t('serviceNotStarted')) };
  }
}

// The safe action of each screen has the focus: Not now, Cancel, Close or Retry.
export function ServiceDialog({ dialog, language }: { dialog: Dialog; language: Language }) {
  const t = (key: CopyKey) => text(key, language), id = useId(), { title, body } = serviceDialogText(dialog, language);
  const modal = useRef<HTMLDialogElement>(null), safe = useRef<HTMLButtonElement>(null);
  const send = (command: ServicesCommand) => { void window.horizon.command(command).catch(() => undefined); };
  const missing = dialog.phase === 'offer' && dialog.release === 'missing';
  useEffect(() => {
    const element = modal.current;
    if (element && !element.open) element.showModal();
    return () => { if (element?.open) element.close(); };
  }, []);
  useEffect(() => { if (!dialog.busy) safe.current?.focus(); }, [dialog.phase, dialog.busy]);
  // Escape does what the safe action does; while an installer runs there is nothing to stop.
  const escape = () => {
    if (dialog.busy) return;
    if (dialog.phase === 'offer' || dialog.phase === 'not-started') send({ type: 'service-not-now' });
    else if (dialog.phase === 'downloading') send({ type: 'service-cancel' });
    else if (dialog.phase === 'finish' || dialog.phase === 'failed') send({ type: 'service-close' });
  };
  return <dialog ref={modal} className="settings-dialog vault-dialog service-dialog" aria-labelledby={`${id}-title`} aria-describedby={`${id}-body`} aria-busy={dialog.busy || dialog.phase === 'downloading' || dialog.phase === 'installing'} onCancel={event => { event.preventDefault(); escape(); }}>
    <div className="settings-dialog-heading"><h2 id={`${id}-title`}>{title}</h2><p id={`${id}-body`}>{body}</p></div>
    {dialog.phase === 'offer' && <button className="settings-button quiet service-link" type="button" onClick={() => send({ type: 'service-page', service: dialog.service, page: 'about' })}><ExternalLink aria-hidden="true" />{t('serviceAbout').replace('{service}', serviceName(dialog.service, language))}</button>}
    {dialog.phase === 'downloading' && <progress className="service-progress" aria-label={title} max={dialog.total ?? undefined} value={dialog.total !== null ? dialog.received : undefined} />}
    {dialog.phase === 'installing' && <><progress className="service-progress" aria-label={title} /><p className="setting-hint" id={`${id}-note`}>{t('serviceInstallingNote')}</p></>}
    <div className="settings-dialog-actions">
      {dialog.phase === 'offer' && <>
        <button className="settings-button" ref={safe} type="button" disabled={dialog.busy} onClick={() => send({ type: 'service-not-now' })}>{t('serviceNotNow')}</button>
        {missing ? <button className="settings-button primary" type="button" disabled={dialog.busy} onClick={() => send({ type: 'service-page', service: dialog.service, page: 'download' })}><ExternalLink aria-hidden="true" />{t('serviceOpenPage')}</button>
          : <button className="settings-button primary" type="button" disabled={dialog.busy} onClick={() => send({ type: 'service-install', service: dialog.service })}>{t('serviceInstall')}</button>}
      </>}
      {dialog.phase === 'downloading' && <button className="settings-button" ref={safe} type="button" onClick={() => send({ type: 'service-cancel' })}>{t('cancel')}</button>}
      {dialog.phase === 'installing' && <button className="settings-button" type="button" disabled aria-describedby={`${id}-note`}>{t('cancel')}</button>}
      {dialog.phase === 'finish' && <button className="settings-button" ref={safe} type="button" onClick={() => send({ type: 'service-close' })}>{t('close')}</button>}
      {dialog.phase === 'failed' && <>
        <button className="settings-button" type="button" onClick={() => send({ type: 'service-page', service: dialog.service, page: 'download' })}><ExternalLink aria-hidden="true" />{t('serviceOpenPage')}</button>
        <button className="settings-button" ref={safe} type="button" onClick={() => send({ type: 'service-retry' })}>{t('serviceRetry')}</button>
      </>}
      {dialog.phase === 'not-started' && <>
        <button className="settings-button" type="button" disabled={dialog.busy} onClick={() => send({ type: 'service-reinstall' })}>{t('serviceReinstall')}</button>
        <button className="settings-button" ref={safe} type="button" disabled={dialog.busy} onClick={() => send({ type: 'service-retry' })}>{t('serviceRetry')}</button>
      </>}
    </div>
  </dialog>;
}
