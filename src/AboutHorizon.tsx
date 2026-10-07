import { useEffect, useId, useRef } from 'react';
import type { RefObject } from 'react';
import { HorizonMark } from './HorizonMark';
import { text } from './copy';
import type { Language, UpdateState } from './shared/api';

export function AboutHorizon({ version, update, language, opener, onClose, onRestart }: {
  version: string; update: UpdateState; language: Language; opener: RefObject<HTMLButtonElement | null>; onClose: () => void; onRestart: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), close = useRef<HTMLButtonElement>(null), id = useId();
  useEffect(() => {
    const modal = dialog.current; modal?.showModal(); close.current?.focus();
    return () => { modal?.close(); opener.current?.focus(); };
  }, [opener]);
  return <dialog className="settings-dialog about-horizon" ref={dialog} aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
  }}><h2 id={`${id}-title`}>{text('aboutHorizon', language)}</h2><div className="about-product"><HorizonMark /><div><strong>{text('product', language)}</strong><p>{text('appVersion', language).replace('{version}', version)}</p><div className="settings-feedback" role="status" aria-live="polite">{update.status === 'upToDate' ? text('updateUpToDate', language) : update.status === 'checking' ? text('updateChecking', language) : update.status === 'downloading' ? text('updateDownloading', language).replace('{percent}', String(update.percent)) : update.status === 'ready' ? <><span>{text('updateReady', language)}</span><button className="settings-button" type="button" onClick={onRestart}>{text('updateRestart', language)}</button></> : update.status === 'unavailable' ? text('updateUnavailable', language) : update.status === 'error' ? text('updateError', language) : null}</div></div></div><div className="settings-dialog-actions"><button className="settings-button" ref={close} type="button" onClick={onClose}>{text('close', language)}</button></div></dialog>;
}
