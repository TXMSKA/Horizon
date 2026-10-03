import { useEffect, useId, useRef } from 'react';
import type { RefObject } from 'react';
import { HorizonMark } from './HorizonMark';
import { text } from './copy';
import type { Language } from './shared/api';

export function AboutHorizon({ version, language, opener, onClose }: {
  version: string; language: Language; opener: RefObject<HTMLButtonElement | null>; onClose: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null), close = useRef<HTMLButtonElement>(null), id = useId();
  useEffect(() => {
    const modal = dialog.current; modal?.showModal(); close.current?.focus();
    return () => { modal?.close(); opener.current?.focus(); };
  }, [opener]);
  return <dialog className="settings-dialog about-horizon" ref={dialog} aria-labelledby={`${id}-title`} onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
  }}><h2 id={`${id}-title`}>{text('aboutHorizon', language)}</h2><div className="about-product"><HorizonMark /><div><strong>{text('product', language)}</strong><p>{text('appVersion', language).replace('{version}', version)}</p></div></div><div className="settings-dialog-actions"><button className="settings-button" ref={close} type="button" onClick={onClose}>{text('close', language)}</button></div></dialog>;
}
