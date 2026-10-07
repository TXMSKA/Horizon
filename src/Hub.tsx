import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { Check, ExternalLink, House, Languages, LayoutDashboard, Palette, Pin, PinOff, Trash2 } from 'lucide-react';
import { text } from './copy';
import type { CopyKey } from './copy';
import { HUB_APPS, MARKETPLACE_THEMES } from './shared/api';
import type { BrowserCommand, BrowserState, HubApp, Language, MarketplaceTheme } from './shared/api';
import { Menu } from './Menu';
import { settingsError } from './Settings';
import { ToolbarPopover } from './ToolbarPopover';

export const hubApps = { translate: { label: 'translate', icon: Languages }, themes: { label: 'themes', icon: Palette }, desktop: { label: 'desktop', icon: LayoutDashboard } } as const;
type HubPage = 'home' | HubApp;
const themes = ['amber', 'daylight', 'highContrast'] as const;
type InstalledTheme = typeof themes[number] | MarketplaceTheme;

function ThemePreview({ theme }: { theme: InstalledTheme }) {
  return <span className="hub-theme-preview" data-preview-theme={theme} aria-hidden="true">
    <span className="theme-preview-tabs"><i /><span /></span><span className="theme-preview-toolbar" />
    <span className="theme-preview-ground" /><span className="theme-preview-horizon" />
    <svg className="theme-preview-sun" viewBox="0 0 64 32"><path d="M0 32 A32 32 0 0 1 64 32" /></svg><span className="theme-preview-field" />
  </span>;
}

function InstalledThemes({ state, language, onInstalled }: { state: BrowserState; language: Language; onInstalled: () => void }) {
  const t = (key: CopyKey) => text(key, language), pending = useRef(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [retry, setRetry] = useState<InstalledTheme | BrowserCommand | null>(null);
  const cards = useRef<HTMLDivElement>(null), removing = useRef<MarketplaceTheme | null>(null);
  const installed = [...themes, ...(state.installedThemes ?? [])];
  useLayoutEffect(() => {
    if (removing.current && !state.installedThemes.includes(removing.current)) {
      cards.current?.querySelector<HTMLButtonElement>('[aria-checked=true]')?.focus(); removing.current = null;
    }
  }, [state.installedThemes]);
  const [systemHighContrast, setSystemHighContrast] = useState(() => matchMedia('(forced-colors: active)').matches);
  useEffect(() => {
    const system = matchMedia('(forced-colors: active)'), changed = () => setSystemHighContrast(system.matches);
    system.addEventListener('change', changed);
    return () => system.removeEventListener('change', changed);
  }, []);
  const [systemDark, setSystemDark] = useState(() => matchMedia('(prefers-color-scheme: dark)').matches);
  useEffect(() => {
    const system = matchMedia('(prefers-color-scheme: dark)'), changed = () => setSystemDark(system.matches);
    system.addEventListener('change', changed);
    return () => system.removeEventListener('change', changed);
  }, []);
  const resolved = state.theme === 'system' ? systemDark ? 'amber' : 'daylight' : state.theme;
  const chosen = state.contrast === 'high' || systemHighContrast ? 'highContrast' : resolved;
  const choose = async (value: InstalledTheme) => {
    const theme = value === 'highContrast' ? 'amber' : value, contrast = value === 'highContrast' ? 'high' : 'standard';
    if (pending.current || state.theme === theme && state.contrast === contrast && !error) return;
    pending.current = true; setBusy(true); setError(''); setRetry(null);
    try {
      if (state.theme !== theme) await window.horizon.command({ type: 'theme', value: theme });
      if (state.contrast !== contrast) await window.horizon.command({ type: 'contrast', value: contrast });
    } catch (reason) { setError(settingsError(reason, language)); setRetry(value); }
    finally { pending.current = false; setBusy(false); }
  };
  const catalogAction = async (command: BrowserCommand) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setRetry(null);
    if (command.type === 'remove-theme') removing.current = command.id;
    try {
      await window.horizon.command(command);
      if (command.type === 'install-theme' && cards.current) onInstalled();
    } catch (reason) { removing.current = null; setError(settingsError(reason, language)); setRetry(command); }
    finally { pending.current = false; setBusy(false); }
  };
  return <div className="hub-themes" aria-busy={busy}>
    <section className="hub-installed" aria-labelledby="hub-installed-label">
      <h3 id="hub-installed-label">{t('installed')}</h3>
      <div className="hub-theme-cards" role="radiogroup" aria-label={t('themes')} ref={cards}>
        {installed.map((theme, index) => <div className="hub-theme-item" key={theme}>
          <button className="hub-theme-card" data-theme-id={theme} type="button" role="radio" aria-checked={chosen === theme} aria-disabled={busy} tabIndex={chosen === theme ? 0 : -1} onClick={() => { void choose(theme); }} onKeyDown={event => {
            const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index + 1) % installed.length : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index + installed.length - 1) % installed.length : event.key === 'Home' ? 0 : event.key === 'End' ? installed.length - 1 : -1;
            if (next < 0) return;
            event.preventDefault(); if (pending.current) return;
            event.currentTarget.closest('[role=radiogroup]')?.querySelectorAll<HTMLButtonElement>('[role=radio]')[next]?.focus(); void choose(installed[next]!);
          }}><ThemePreview theme={theme} /><span className="hub-theme-name"><span>{t(theme)}</span>{chosen === theme && <Check aria-hidden="true" />}</span></button>
          {MARKETPLACE_THEMES.includes(theme as MarketplaceTheme) && <button className="hub-theme-remove icon-button" type="button" aria-label={t('removeTheme').replace('{name}', t(theme))} aria-disabled={busy} onClick={() => { void catalogAction({ type: 'remove-theme', id: theme as MarketplaceTheme }); }}><Trash2 aria-hidden="true" /></button>}
        </div>)}
      </div>
    </section>
    <section className="hub-installed" aria-labelledby="hub-marketplace-label">
      <h3 id="hub-marketplace-label">{t('marketplace')}</h3>
      <div className="hub-theme-cards">{MARKETPLACE_THEMES.filter(theme => !state.installedThemes?.includes(theme)).map(theme => <div className="hub-theme-card" key={theme}>
        <ThemePreview theme={theme} /><span className="hub-theme-name"><span>{t(theme)}</span><button className="hub-theme-get" type="button" aria-label={t('getTheme').replace('{name}', t(theme))} aria-disabled={busy} onClick={() => { void catalogAction({ type: 'install-theme', id: theme }); }}>{t('get')}</button></span>
      </div>)}</div>
      {MARKETPLACE_THEMES.every(theme => state.installedThemes?.includes(theme)) && <p className="settings-note">{t('allThemesInstalled')}</p>}
    </section>
    {error && <div className="settings-feedback error" role="alert"><span>{error}</span>{retry && <button className="text-button" type="button" aria-disabled={busy} onClick={() => { if (typeof retry === 'string') void choose(retry); else void catalogAction(retry); }}>{t('retry')}</button>}</div>}
  </div>;
}

export function Hub({ state, language, page, opener, onPage, onDismiss, onAnnounce }: {
  state: BrowserState; language: Language; page: HubPage; opener: RefObject<HTMLButtonElement | null>;
  onPage: (page: HubPage) => void; onDismiss: (focus: boolean) => void; onAnnounce: (message: string) => void;
}) {
  const t = (key: CopyKey) => text(key, language), ref = useRef<HTMLDivElement>(null), tile = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  const dismiss = useRef(onDismiss), pending = useRef(false);
  const [tileMenu, setTileMenu] = useState<HubApp | null>(null), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const [retry, setRetry] = useState<BrowserCommand | null>(null), retryButton = useRef<HTMLButtonElement>(null);
  useLayoutEffect(() => { if (retry) retryButton.current?.focus(); }, [retry]);
  const liveMenu = useRef(tileMenu);
  useLayoutEffect(() => { dismiss.current = onDismiss; });
  useLayoutEffect(() => { liveMenu.current = tileMenu; }, [tileMenu]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !menu.current?.contains(target) && !opener.current?.contains(target)) dismiss.current(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [opener]);
  useEffect(() => { (ref.current?.querySelector<HTMLButtonElement>(page === 'home' ? '.hub-tile' : '[role=radio][aria-checked=true]') ?? ref.current)?.focus(); }, [page]);
  const closeMenu = (focus = true) => { setTileMenu(null); if (focus) tile.current?.focus(); };
  const pin = async (command: BrowserCommand) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); setRetry(null);
    onAnnounce(t('savingQuickAccess'));
    const source = tileMenu;
    try {
      await window.horizon.command(command);
      if (command.type === 'pin-app' || command.type === 'unpin-app') onAnnounce(t(command.type === 'pin-app' ? 'addedQuickAccess' : 'removedQuickAccess').replace('{name}', t(hubApps[command.id].label)));
      // A completed save must not take focus from a page or popup opened while it was pending.
      if (ref.current && liveMenu.current === source) { closeMenu(false); dismiss.current(true); }
    }
    catch (reason) {
      const message = settingsError(reason, language); onAnnounce(message);
      if (ref.current) { closeMenu(false); setError(message); setRetry(command); }
    }
    finally { pending.current = false; if (ref.current) setBusy(false); }
  };
  const apps = HUB_APPS.filter(app => !state.privateWindow || app !== 'desktop' && app !== 'translate');
  const open = (app: HubApp) => { closeMenu(false); setError(''); setRetry(null); onPage(app); };
  return <ToolbarPopover opener={opener}><div className={`hub-popup${page !== 'home' ? ' hub-app-page' : ''}`} id="hub-popup" ref={ref} role="dialog" tabIndex={-1} aria-label={t('hub')} aria-busy={busy} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (tileMenu) closeMenu(); else onDismiss(true); }
    if (event.key !== 'Tab') return;
    const stops = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"])') ?? [])];
    if (document.activeElement !== (event.shiftKey ? stops[0] : stops.at(-1))) return;
    // Native Tab continues from the opener to the adjacent toolbar control.
    onDismiss(true);
  }}>
    {page === 'home' && <div className="hub-ground" aria-hidden="true"><div className="horizon-rule" /><svg className="horizon-sun" viewBox="0 0 64 32"><path d="M0 32 A32 32 0 0 1 64 32" /></svg></div>}
    <div className="hub-content"><nav className="hub-dock" aria-label={t('quickAccess')}>
      <button className="icon-button" type="button" aria-label={t('hubHome')} title={t('hubHome')} aria-current={page === 'home' ? 'page' : undefined} onClick={() => { closeMenu(false); onPage('home'); }}><House aria-hidden="true" /></button>
      {state.quickAccess.filter(app => !state.privateWindow || app !== 'desktop' && app !== 'translate').map(app => { const { label, icon: Icon } = hubApps[app]; return <button className="icon-button" type="button" key={app} aria-label={t(label)} title={t(label)} onClick={() => open(app)}><Icon aria-hidden="true" /></button>; })}
    </nav><div className="hub-page"><h2>{t(page === 'home' ? 'hub' : hubApps[page].label)}</h2>
      {page === 'home' ? <div className="hub-tiles">{apps.map((app, index) => { const { label, icon: Icon } = hubApps[app]; return <button className="hub-tile" type="button" ref={app === 'themes' ? tile : undefined} key={app} disabled={app === 'translate' && !state.tabs.some(tab => tab.id === state.activeId && /^https?:/.test(tab.url) && !tab.loading && !tab.error)} aria-haspopup="menu" aria-expanded={tileMenu === app} onClick={() => open(app)} onContextMenu={event => { event.preventDefault(); tile.current = event.currentTarget; setTileMenu(app); }} onKeyDown={event => {
        if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) { event.preventDefault(); tile.current = event.currentTarget; setTileMenu(app); return; }
        const step = event.key === 'ArrowRight' ? 1 : event.key === 'ArrowLeft' ? -1 : event.key === 'ArrowDown' ? 3 : event.key === 'ArrowUp' ? -3 : 0;
        if (!step) return;
        event.preventDefault(); const next = (index + step + apps.length * 3) % apps.length;
        (event.currentTarget.parentElement?.children[next] as HTMLButtonElement | undefined)?.focus();
      }}><span className="hub-tile-icon"><Icon aria-hidden="true" /></span><span>{t(label)}</span></button>; })}</div> : <InstalledThemes state={state} language={language} onInstalled={() => onDismiss(true)} />}
      {error && <div className="settings-feedback error" role="alert"><span>{error}</span>{retry && <button className="text-button" type="button" ref={retryButton} aria-disabled={busy} onClick={() => { void pin(retry); }}>{t('retry')}</button>}</div>}
    </div></div>
    {tileMenu && <ToolbarPopover opener={tile} within={ref} className="hub-menu-anchor"><div ref={menu}><Menu id="hub-tile-menu" className="hub-tile-menu" label={t('appActions').replace('{name}', t(hubApps[tileMenu].label))} keyboard opener={tile} onDismiss={reason => closeMenu(reason !== 'outside')}>
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => open(tileMenu)}><ExternalLink aria-hidden="true" /><span>{t('openApp')}</span></button>
      <button type="button" role="menuitem" tabIndex={-1} aria-disabled={busy} onClick={() => { void pin({ type: state.quickAccess.includes(tileMenu) ? 'unpin-app' : 'pin-app', id: tileMenu }); }}>{state.quickAccess.includes(tileMenu) ? <PinOff aria-hidden="true" /> : <Pin aria-hidden="true" />}<span>{t(state.quickAccess.includes(tileMenu) ? 'removeQuickAccess' : 'addQuickAccess')}</span></button>
    </Menu></div></ToolbarPopover>}
  </div></ToolbarPopover>;
}
