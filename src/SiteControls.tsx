import { useEffect, useId, useLayoutEffect, useRef, useState } from 'react';
import type { ReactNode, RefObject } from 'react';
import { Bell, Camera, Check, Map, Mic } from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { text } from './copy';
import type { CopyKey } from './copy';
import { SITE_PERMISSIONS } from './shared/api';
import type { BlockedCounts, BrowserCommand, DarkPagesState, Language, PermissionDecision, PermissionPrompt, SitePermission, SiteSettings } from './shared/api';
import { Menu } from './Menu';
import { Switch } from './Switch';

const permissionRows: Record<SitePermission, { name: CopyKey; request: CopyKey; icon: LucideIcon }> = {
  camera: { name: 'permissionCamera', request: 'useCamera', icon: Camera },
  microphone: { name: 'permissionMicrophone', request: 'useMicrophone', icon: Mic },
  location: { name: 'permissionLocation', request: 'knowLocation', icon: Map },
  notifications: { name: 'permissionNotifications', request: 'showNotifications', icon: Bell },
};
const decisions: PermissionDecision[] = ['ask', 'allow', 'block'];
const decisionLabels: Record<PermissionDecision, CopyKey> = { ask: 'permissionAsk', allow: 'permissionAllowed', block: 'permissionBlocked' };
const actionLabels: Record<PermissionDecision, CopyKey> = { ask: 'permissionAsk', allow: 'permissionAllow', block: 'permissionBlock' };
export const blockedTotal = (counts: BlockedCounts): number => counts.ads + counts.trackers + counts.cookies;
export const blockedCount = (count: number, language: Language): string => text(count === 1 ? 'blockedOne' : 'blockedMany', language).replace('{count}', String(count));

export function blockingBreakdown(counts: BlockedCounts, language: Language): string {
  const categories: { count: number; one: CopyKey; many: CopyKey }[] = [
    { count: counts.ads, one: 'blockedAd', many: 'blockedAds' },
    { count: counts.trackers, one: 'blockedTracker', many: 'blockedTrackers' },
    { count: counts.cookies, one: 'blockedCookie', many: 'blockedCookies' },
  ];
  const parts = categories.filter(item => item.count > 0).map(item => text(item.count === 1 ? item.one : item.many, language).replace('{count}', String(item.count)));
  if (!parts.length) return text('nothingBlocked', language);
  return text('blockedBreakdown', language).replace('{total}', blockedCount(blockedTotal(counts), language)).replace('{categories}', new Intl.ListFormat(language === 'en' ? 'en-GB' : 'es-AR', { type: 'conjunction' }).format(parts));
}

function SiteHeading({ host, favicon, initial, children, id }: { host: string; favicon?: string; initial: string; children?: ReactNode; id?: string }) {
  const [failed, setFailed] = useState(false);
  useEffect(() => { setFailed(false); }, [favicon]);
  return <div className="site-heading">{favicon && !failed ? <img className="site-icon" src={favicon} alt="" aria-hidden="true" onError={() => setFailed(true)} /> : <span className="tab-initial site-icon" aria-hidden="true">{initial}</span>}<strong id={id} title={host}>{children ?? host}</strong></div>;
}

function SitePopover({ id, label, labelledBy, describedBy, opener, onDismiss, onTabOut, children }: {
  id: string; label?: string; labelledBy?: string; describedBy?: string; opener?: RefObject<HTMLButtonElement | null>; onDismiss: (reason: 'escape' | 'outside') => void;
  onTabOut?: (backward: boolean) => void; children: ReactNode;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dismiss = useRef(onDismiss);
  useLayoutEffect(() => { dismiss.current = onDismiss; });
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !opener?.current?.contains(target)) dismiss.current('outside');
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [opener]);
  return <div className="site-popover" ref={ref} id={id} role="dialog" aria-label={label} aria-labelledby={labelledBy} aria-describedby={describedBy} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss.current('escape'); return; }
    // The popover is mounted after the chrome, so leaving it by Tab would land at the start of the document.
    if (event.key !== 'Tab' || (event.target as HTMLElement).closest('[role=menu]')) { if (event.key === 'Tab') event.preventDefault(); return; }
    const stops = [...(ref.current?.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"])') ?? [])];
    if (document.activeElement !== (event.shiftKey ? stops[0] : stops.at(-1))) return;
    event.preventDefault();
    if (onTabOut) onTabOut(event.shiftKey); else (event.shiftKey ? stops.at(-1) : stops[0])?.focus();
  }}>{children}</div>;
}

export function ShieldPopover({ site, counts, ready, blockAds, darkPages, language, favicon, initial, opener, onDismiss, onTabOut, run }: {
  site: SiteSettings; counts: BlockedCounts; ready: boolean; blockAds: boolean; darkPages: DarkPagesState; language: Language; favicon?: string; initial: string;
  opener: RefObject<HTMLButtonElement | null>; onDismiss: (reason: 'escape' | 'outside') => void; onTabOut: (backward: boolean) => void; run: (command: BrowserCommand) => Promise<boolean>;
}) {
  const t = (key: CopyKey) => text(key, language);
  const id = useId();
  const switchRef = useRef<HTMLButtonElement>(null);
  const rowRef = useRef<HTMLButtonElement | null>(null);
  // Disabling a control while its command runs would drop the keyboard focus, so a ref refuses repeats instead.
  const pending = useRef(false);
  const [permission, setPermission] = useState<SitePermission | null>(null);
  useEffect(() => { switchRef.current?.focus(); }, []);
  const closeMenu = () => { setPermission(null); rowRef.current?.focus(); };
  const hint = !blockAds ? t('blockingOffSettings') : !site.blocking ? t('blockingOffSite') : !ready && !blockedTotal(counts) ? t('blockingNotReady') : blockingBreakdown(counts, language);
  const darkHint = darkPages.active ? null : t(darkPages.mode === 'off' ? 'darkPagesOff' : 'darkPagesSystemLight');
  return <SitePopover id="shield-popover" label={t('blockingOnSite')} opener={opener} onDismiss={onDismiss} onTabOut={onTabOut}>
    <SiteHeading host={site.host} favicon={favicon} initial={initial} />
    <hr />
    <div className="site-blocking-row"><div className="site-blocking-copy"><span id={`${id}-blocking`}>{t('blockAdsTrackers')}</span><small id={`${id}-breakdown`}>{hint}</small></div><Switch checked={blockAds && site.blocking} disabled={!blockAds} labelledBy={`${id}-blocking`} describedBy={`${id}-breakdown`} buttonRef={switchRef} onChange={enabled => {
      if (pending.current) return;
      pending.current = true;
      void run({ type: 'set-blocking', enabled }).finally(() => { pending.current = false; });
    }} /></div>
    <div className={`site-dark-row${darkHint ? ' with-hint' : ''}`}><div className="site-blocking-copy"><span id={`${id}-dark`}>{t('darkModeOnSite')}</span>{darkHint && <small id={`${id}-dark-hint`}>{darkHint}</small>}</div><Switch checked={darkPages.active && site.dark} disabled={!darkPages.active} labelledBy={`${id}-dark`} describedBy={darkHint ? `${id}-dark-hint` : undefined} onChange={enabled => {
      if (pending.current) return;
      pending.current = true;
      void run({ type: 'set-site-dark', enabled }).finally(() => { pending.current = false; });
    }} /></div>
    <hr />
    <span className="site-permissions-label">{t('sitePermissions')}</span>
    {SITE_PERMISSIONS.map(choice => {
      const row = permissionRows[choice], Icon = row.icon;
      return <button className="site-permission-row" key={choice} type="button" aria-haspopup="menu" aria-expanded={permission === choice} aria-controls={permission === choice ? 'site-permission-menu' : undefined} onClick={event => {
        if (pending.current) return;
        rowRef.current = event.currentTarget; setPermission(previous => previous === choice ? null : choice);
      }}><Icon aria-hidden="true" /><span>{t(row.name)}</span><small>{t(decisionLabels[site.permissions[choice]])}</small></button>;
    })}
    {permission && <Menu key={permission} id="site-permission-menu" className="site-permission-menu" label={t(permissionRows[permission].name)} keyboard initialFocus="[aria-checked=true]" opener={rowRef} onDismiss={reason => { setPermission(null); if (reason !== 'outside') rowRef.current?.focus(); }}>
      {decisions.map(decision => <button type="button" role="menuitemradio" tabIndex={-1} key={decision} aria-checked={site.permissions[permission] === decision} onClick={() => {
        if (pending.current) return;
        pending.current = true;
        void run({ type: 'set-site-permission', permission, decision }).then(success => { if (success) closeMenu(); }).finally(() => { pending.current = false; });
      }}><span>{t(actionLabels[decision])}</span>{site.permissions[permission] === decision && <Check aria-hidden="true" />}</button>)}
    </Menu>}
  </SitePopover>;
}

export function PermissionDialog({ prompt, language, favicon, initial, onAnswer }: {
  prompt: PermissionPrompt; language: Language; favicon?: string; initial: string; onAnswer: (answer: 'allow' | 'block' | 'dismiss', focusPage: boolean) => Promise<void>;
}) {
  const t = (key: CopyKey) => text(key, language);
  const id = useId();
  const block = useRef<HTMLButtonElement>(null);
  const pending = useRef(false);
  const [busy, setBusy] = useState(false);
  useEffect(() => { block.current?.focus(); }, []);
  // A click elsewhere keeps the focus where it landed; every other answer hands the keyboard back to the page.
  const answer = (value: 'allow' | 'block' | 'dismiss', focusPage = true) => {
    if (pending.current) return;
    pending.current = true; setBusy(true);
    void onAnswer(value, focusPage).finally(() => { pending.current = false; setBusy(false); requestAnimationFrame(() => block.current?.focus()); });
  };
  const host = new URL(prompt.origin).host;
  return <SitePopover id="permission-prompt" labelledBy={`${id}-title`} describedBy={`${id}-requests`} onDismiss={reason => answer('dismiss', reason === 'escape')}>
    <SiteHeading host={host} favicon={favicon} initial={initial} id={`${id}-title`}>{t('siteWantsTo').replace('{host}', host)}</SiteHeading>
    <hr />
    <div className="site-permission-requests" id={`${id}-requests`}>{prompt.permissions.map(permission => {
      const row = permissionRows[permission], Icon = row.icon;
      return <div className="site-permission-row" key={permission}><Icon aria-hidden="true" /><span>{t(row.request)}</span></div>;
    })}</div>
    <div className="profile-form-actions site-permission-actions" aria-busy={busy}><button className="profile-action neutral" ref={block} type="button" disabled={busy} onClick={() => answer('block')}>{t('permissionBlock')}</button><button className="profile-action neutral" type="button" disabled={busy} onClick={() => answer('allow')}>{t('permissionAllow')}</button></div>
  </SitePopover>;
}
