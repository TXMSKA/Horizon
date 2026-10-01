import { useState } from 'react';
import {
  ArrowLeft, ArrowRight, Camera, ChevronDown, Ellipsis, FileText, House, Minus,
  NotebookPen, Plus, RotateCw, Search, ShieldCheck, Sparkles, Square, Star, X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { text } from './copy';
import type { CopyKey } from './copy';
import type { Language, WindowAction } from './shared/api';

export function App({ language }: { language: Language }) {
  const t = (key: CopyKey) => text(key, language);
  const [error, setError] = useState('');
  const preview = t('unavailable');
  const staticIcon = (Icon: LucideIcon, key: CopyKey, accent = false) => (
    <button className={accent ? 'icon-button accent' : 'icon-button'} type="button"
      disabled aria-label={t(key)} title={preview}><Icon aria-hidden="true" /></button>
  );
  const windowAction = async (action: WindowAction) => {
    try { await window.horizon.windowAction(action); }
    catch { setError(t('actionError')); }
  };
  const notes: { title: CopyKey; source: CopyKey; icon: LucideIcon }[] = [
    { title: 'noteRoute', source: 'sourceRoute', icon: FileText },
    { title: 'noteTrails', source: 'sourceCapture', icon: Camera },
    { title: 'noteBudget', source: 'sourceNote', icon: FileText },
  ];

  return <>
    <a className="skip-link" href="#start" onClick={(event) => { event.preventDefault(); document.getElementById('start')?.focus(); }}>{t('skip')}</a>
    <header className="chrome">
      <div className="tab-strip">
        <button className="profile" type="button" disabled aria-label={t('profile')} title={preview}>
          <span className="profile-dot" /><span>{t('personal')}</span><ChevronDown aria-hidden="true" />
        </button>
        <span className="separator" aria-hidden="true" />
        <nav className="tabs" aria-label={t('tabs')}>
          <div className="tab active" aria-current="page">
            <House className="accent" aria-hidden="true" /><span>{t('home')}</span>
            {staticIcon(X, 'closeTab')}
          </div>
          <div className="tab"><span className="tab-initial" aria-hidden="true">{t('breadInitial')}</span><span>{t('bread')}</span>{staticIcon(X, 'closeTab')}</div>
          <div className="tab"><span className="tab-initial" aria-hidden="true">{t('routesInitial')}</span><span>{t('routes')}</span>{staticIcon(X, 'closeTab')}</div>
        </nav>
        {staticIcon(Plus, 'newTab')}
        <div className="drag-space" />
        <div className="window-controls">
          <button type="button" onClick={() => { void windowAction('minimize'); }} aria-label={t('minimize')} title={t('minimize')}><Minus aria-hidden="true" /></button>
          <button type="button" onClick={() => { void windowAction('maximize'); }} aria-label={t('maximize')} title={t('maximize')}><Square aria-hidden="true" /></button>
          <button type="button" onClick={() => { void windowAction('close'); }} aria-label={t('closeWindow')} title={t('closeWindow')}><X aria-hidden="true" /></button>
        </div>
      </div>
      <div className="toolbar" role="toolbar" aria-label={t('toolbar')}>
        <div className="navigation-buttons">{staticIcon(ArrowLeft, 'back')}{staticIcon(ArrowRight, 'forward')}{staticIcon(RotateCw, 'reload')}</div>
        <div className="address-bar">
          <ShieldCheck className="accent" aria-label={t('protection')} />
          <input aria-label={t('address')} placeholder={t('address')} readOnly title={preview} />
          {staticIcon(Star, 'bookmark')}
        </div>
        <div className="tools">{staticIcon(NotebookPen, 'notebooks')}{staticIcon(Sparkles, 'lyra', true)}{staticIcon(Ellipsis, 'menu')}</div>
      </div>
    </header>
    <main id="start" tabIndex={-1}>
      <div className="start-page">
        <div className="brand">
          <svg className="horizon-mark" viewBox="0 0 52 33" aria-hidden="true">
            <path d="M10.4 31 A15.6 15.6 0 0 1 41.6 31 Z" />
            <path d="M1 32 H51" className="horizon-line" />
          </svg>
          <h1>{t('product')}</h1>
        </div>
        <div className="search-field">
          <Search aria-hidden="true" />
          <input aria-label={t('search')} placeholder={t('search')} readOnly title={preview} />
          <Sparkles className="accent" aria-hidden="true" />
        </div>
        <nav className="shortcuts" aria-label={t('shortcuts')}>
          {(['wikipedia', 'youtube', 'maps', 'news', 'mail'] as const).map(key =>
            <button type="button" key={key} disabled title={preview}>{t(key)}</button>)}
        </nav>
        <section className="notebook" aria-labelledby="resume-title">
          <div className="notebook-heading">
            <div className="resume">
              <h2 id="resume-title"><NotebookPen className="accent" aria-hidden="true" />{t('resume')}</h2>
              <p>{t('resumeMeta')}</p>
            </div>
            <button className="open-notebook accent" type="button" disabled title={preview}>{t('openNotebook')}</button>
          </div>
          <ul className="notes">
            {notes.map(({ title, source, icon: Icon }) => <li key={title}>
              <Icon aria-hidden="true" /><span>{t(title)}</span><small>{t(source)}</small>
            </li>)}
          </ul>
        </section>
        <button className="lyra-prompt" type="button" disabled title={preview}>
          <Sparkles className="accent" aria-hidden="true" />{t('askLyra')}
        </button>
        <p className="preview-notice">{preview}</p>
        <p className="action-status" role="alert">{error}</p>
      </div>
    </main>
  </>;
}
