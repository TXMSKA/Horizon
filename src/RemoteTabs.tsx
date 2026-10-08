import { useId, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { AppWindow, Folder, LoaderCircle } from 'lucide-react';
import { text } from './copy';
import type { BrowserState, Language, SyncRemoteWindow } from './shared/api';
import type { CopyKey } from './copy';
import { openRemoteGroup } from './shared/remote-tabs';
import { syncErrorKey } from './shared/sync-display';
import './sync.css';

export function RemoteTabs({ state, language, onAnnounce, renderSiteBadge }: { state: BrowserState; language: Language; onAnnounce: (message: string) => void; renderSiteBadge: (url: string, title: string) => ReactNode }) {
  const t = (key: CopyKey) => text(key, language), id = useId();
  const [pending, setPending] = useState(false), [error, setError] = useState<CopyKey | null>(null);
  const running = useRef(false), retry = useRef<{ work: () => Promise<unknown>; message: CopyKey } | null>(null);
  const open = async (work: () => Promise<unknown>, message: CopyKey) => {
    if (running.current) return;
    running.current = true; setPending(true); setError(null); retry.current = { work, message };
    const focused = document.activeElement;
    try { await work(); retry.current = null; onAnnounce(t(message)); }
    catch (reason) { setError(syncErrorKey(reason)); }
    finally {
      running.current = false; setPending(false);
      requestAnimationFrame(() => { if (focused instanceof HTMLElement && focused.isConnected && document.activeElement === document.body) focused.focus(); });
    }
  };
  if (state.privateWindow || !state.sync.switches.tabs) return null;
  const computers = state.sync.computers.filter(computer => computer.windows.some(window => window.tabs.length > 0));
  if (!computers.length) return null;
  const remoteWindow = (remote: SyncRemoteWindow, number: number) => <section className="sync-remote-window" key={`${remote.profile}:${remote.id}`} aria-label={t('syncRemoteWindow').replace('{number}', String(number))}><h4 className="browser-history-label"><AppWindow aria-hidden="true" />{t('syncRemoteWindow').replace('{number}', String(number))}</h4><ul className="browser-library-list">{remote.tabs.map((tab, index) => <li className="browser-library-row history-row" key={index}>
    {tab.group && remote.tabs.findIndex(entry => entry.group === tab.group) === index && <button className="sync-remote-group" type="button" disabled={pending} aria-label={t('syncOpenGroup').replace('{group}', remote.groups.find(group => group.id === tab.group)?.title || t('syncUnnamedGroup'))} onClick={() => { void open(() => openRemoteGroup(window.horizon, remote, tab.group!), 'syncGroupOpened'); }}><Folder aria-hidden="true" />{remote.groups.find(group => group.id === tab.group)?.title || t('syncUnnamedGroup')}</button>}
    <a className="browser-library-link sync-remote-tab" href={tab.url} aria-disabled={pending} onClick={event => { event.preventDefault(); if (!pending) void open(() => window.horizon.command({ type: 'new-tab', input: tab.url }), 'syncRemoteOpened'); }} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); if (!pending) void open(() => window.horizon.command({ type: 'new-tab', input: tab.url, background: true }), 'syncRemoteOpened'); } }}>{renderSiteBadge(tab.url, tab.title)}<span className="browser-entry-copy"><span>{tab.title || tab.url}</span><small>{new URL(tab.url).host}</small></span></a>
  </li>)}</ul></section>;
  return <section className="sync-remote" aria-labelledby={id} aria-busy={pending}><h3 id={id}>{t('syncOtherComputers')}</h3>{pending && <p className="settings-feedback" role="status"><LoaderCircle className="spinner" aria-hidden="true" />{t('loading')}</p>}{error && <div className="settings-feedback error" role="alert"><span>{t(error)}</span><button className="settings-button quiet" type="button" disabled={pending} onClick={() => { if (retry.current) void open(retry.current.work, retry.current.message); }}>{t('retry')}</button></div>}{computers.map(computer => <section className="browser-history-day" key={computer.id}><h3>{computer.name}</h3>{computer.windows.filter(window => window.tabs.length).map((window, index) => remoteWindow(window, index + 1))}</section>)}</section>;
}
