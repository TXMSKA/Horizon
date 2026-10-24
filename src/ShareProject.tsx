import { useEffect, useId, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { createPortal } from 'react-dom';
import { Folder, Users } from 'lucide-react';
import { text } from './copy';
import type { CopyKey } from './copy';
import type { BrowserState, Language } from './shared/api';
import { DesktopDropdown } from './Desktop';
import { settingsError } from './Settings';

// Sharing a Desktop project with a Space: choose the project and the Space, then the warning names what leaves and to whom, with Cancel focused.
export function ShareProjectDialog({ state, language, project: initial, opener, onClose, onModalChange }: {
  state: BrowserState; language: Language; project?: string; opener: RefObject<HTMLElement | null>; onClose: () => void; onModalChange?: (open: boolean) => void;
}) {
  const t = (key: CopyKey) => text(key, language), dialog = useRef<HTMLDialogElement>(null), cancel = useRef<HTMLButtonElement>(null), id = useId();
  const account = state.account.status === 'signedIn' && state.account.phrase === 'ready' ? state.account : null;
  const projects = state.projects.filter(project => !project.sharedTo), spaces = account?.spaces.filter(space => !space.pending) ?? [];
  const [project, setProject] = useState(initial && projects.some(entry => entry.id === initial) ? initial : projects[0]?.id ?? '');
  const [space, setSpace] = useState(spaces[0]?.id ?? ''), [step, setStep] = useState<'choose' | 'confirm'>('choose');
  const [busy, setBusy] = useState(false), [error, setError] = useState('');
  useEffect(() => {
    onModalChange?.(true); const modal = dialog.current; modal?.showModal();
    return () => { modal?.close(); onModalChange?.(false); opener.current?.focus(); };
  }, [onModalChange, opener]);
  useEffect(() => { if (step === 'confirm') cancel.current?.focus(); }, [step]);
  const projectName = projects.find(entry => entry.id === project)?.name ?? '', spaceName = spaces.find(entry => entry.id === space)?.name || t('sharedSpace');
  const share = async () => {
    if (busy) return;
    setBusy(true); setError('');
    try { await window.horizon.command({ type: 'space-share-project', project, space }); onClose(); }
    catch (reason) { setError(settingsError(reason, language)); }
    finally { setBusy(false); }
  };
  return createPortal(<dialog ref={dialog} className="desktop-dialog share-dialog" aria-labelledby={id} aria-busy={busy} onCancel={event => { event.preventDefault(); onClose(); }} onKeyDown={event => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); } }}>
    {step === 'choose' ? <>
      <h2 id={id}>{t('shareProject')}</h2>
      <div className="desktop-field"><span className="share-label">{t('shareChooserProject')}</span><DesktopDropdown label={t('shareChooserProject')} value={project} lead={<Folder aria-hidden="true" />} choices={projects.map(entry => ({ id: entry.id, name: entry.name }))} disabled={busy || !projects.length} onChoose={setProject} /></div>
      <div className="desktop-field"><span className="share-label">{t('shareChooserSpace')}</span><DesktopDropdown label={t('shareChooserSpace')} value={space} lead={<Users aria-hidden="true" />} choices={spaces.map(entry => ({ id: entry.id, name: entry.name || t('sharedSpace') }))} disabled={busy || !spaces.length} onChoose={setSpace} /></div>
      <p className="settings-note">{t('shareChooserNote')}</p>
      <div className="share-actions"><button className="desktop-action outline" type="button" onClick={onClose}>{t('cancel')}</button><button className="desktop-action primary" type="button" aria-disabled={!project || !space} onClick={() => { if (project && space) setStep('confirm'); }}>{t('next')}</button></div>
    </> : <>
      <h2 id={id}>{t('shareWarningTitle').replace('{project}', projectName).replace('{space}', spaceName)}</h2>
      <p className="share-warning">{t('shareWarningText').replace('{space}', spaceName)}</p>
      {error && <p className="settings-feedback error" role="alert">{error}</p>}
      <div className="share-actions"><button className="desktop-action outline" type="button" ref={cancel} onClick={onClose}>{t('cancel')}</button><button className="desktop-action primary" type="button" aria-disabled={busy} onClick={() => { void share(); }}>{t('share')}</button></div>
    </>}
  </dialog>, document.body);
}
