import { Fragment, useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  AppWindow, ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Download, Ellipsis, LayoutGrid,
  ClipboardPaste, Copy, ExternalLink, Folder, History, Image, LoaderCircle, Minus, Scan, Plus, Redo2, Scissors, SpellCheck, TextSelect, Undo2,
  RotateCw, Search, SearchX, ServerOff, Shield, ShieldAlert, ShieldCheck, ShieldOff, Sparkles, Square, Star, TriangleAlert, WifiOff, X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { text } from './copy';
import type { CopyKey } from './copy';
import { SEARCH_ENGINES } from './shared/api';
import type { BrowserCommand, BrowserShortcut, BrowserState, CaptureShot, ContextMenuItemId, DesktopPanelPage, Language, ProjectSummary, PageContextMenu, SettingsSection, TabGroup, WindowAction } from './shared/api';
import { browserShortcut, completeAddress, shortcutTabIndex } from './shared/shortcuts';
import { webTabTitle } from './shared/tab-title';
import { applyTheme } from './theme';
import { Menu } from './Menu';
import { Hub, hubApps } from './Hub';
import { ToolbarPopover } from './ToolbarPopover';
import { NewProfilePopover, ProfileControl, ProfilesMenu } from './Profiles';
import { BrowserPanel } from './BrowserPanel';
import { FavoritesBar, FavoritesPanel, favoritesError } from './Favorites';
import { allFavoriteLinks } from './shared/favorites';
import type { LibraryPanel } from './BrowserPanel';
import { AboutHorizon } from './AboutHorizon';
import { BrowserMenu } from './BrowserMenu';
import { HorizonMark } from './HorizonMark';
import { GroupEditor, GroupRun, TabGroupMenuItems, useGroupPalette } from './TabGroups';
import { tabRuns, visibleTabs } from './shared/tab-groups';

import { blockedCount, blockedTotal, PermissionDialog, ShieldPopover } from './SiteControls';
import { CapturePreview } from './Capture';
import { desktopTabTitle, DesktopResume, DesktopStatus, desktopError } from './Desktop';
import type { DesktopNotice } from './Desktop';
import { DesktopPanel, DesktopTab } from './DesktopView';
import { desktopSuggestions } from './shared/desktop-address';
import { DesktopEdits } from './shared/desktop-edits';
import { DESKTOP_TAB_DRAG, parseDesktopDrag } from './shared/desktop-drag';
import { Settings, settingsError } from './Settings';
import { FirstRunImport } from './FirstRunImport';

type Panel = LibraryPanel | null;
const sites = {
  wikipedia: 'https://www.wikipedia.org/', youtube: 'https://www.youtube.com/',
  maps: 'https://www.google.com/maps', news: 'https://www.bbc.com/news', mail: 'https://mail.google.com/',
} as const;
const pageMenuRows: Record<Exclude<ContextMenuItemId, `spell:${string}`>, { label: CopyKey; icon: LucideIcon }> = {
  'open-link': { label: 'openLink', icon: ExternalLink }, 'copy-link': { label: 'copyLink', icon: Copy },
  'open-image': { label: 'openImage', icon: Image }, 'save-image': { label: 'saveImage', icon: Download },
  'copy-image': { label: 'copyImage', icon: Copy }, 'copy-image-address': { label: 'copyImageAddress', icon: Copy },
  'add-to-desktop': { label: 'addToDesktop', icon: Folder }, copy: { label: 'copy', icon: Copy }, 'search-selection': { label: 'searchWeb', icon: Search },
  undo: { label: 'undo', icon: Undo2 }, redo: { label: 'redo', icon: Redo2 }, cut: { label: 'cut', icon: Scissors },
  paste: { label: 'paste', icon: ClipboardPaste }, 'select-all': { label: 'selectAll', icon: TextSelect },
  back: { label: 'back', icon: ArrowLeft }, forward: { label: 'forward', icon: ArrowRight }, reload: { label: 'reload', icon: RotateCw },
};

function pageError(name: string): { heading: CopyKey; sentence: CopyKey; icon: LucideIcon } {
  if (['ERR_NAME_NOT_RESOLVED', 'ERR_NAME_RESOLUTION_FAILED'].includes(name)) return { heading: 'siteNotFound', sentence: 'checkAddress', icon: SearchX };
  if (['ERR_INTERNET_DISCONNECTED', 'ERR_NETWORK_CHANGED'].includes(name)) return { heading: 'offline', sentence: 'checkConnection', icon: WifiOff };
  if (['ERR_CONNECTION_REFUSED', 'ERR_CONNECTION_TIMED_OUT', 'ERR_TIMED_OUT', 'ERR_CONNECTION_RESET', 'ERR_CONNECTION_CLOSED', 'ERR_ADDRESS_UNREACHABLE'].includes(name)) return { heading: 'notResponding', sentence: 'tryLater', icon: ServerOff };
  if (name.startsWith('ERR_CERT_') || name.startsWith('ERR_SSL_')) return { heading: 'insecureConnection', sentence: 'connectionUnsafe', icon: ShieldAlert };
  if (['ERR_UNSAFE_REDIRECT', 'ERR_BLOCKED_BY_CLIENT'].includes(name)) return { heading: 'blockedAddress', sentence: 'addressBlocked', icon: ShieldAlert };
  if (name === 'RENDERER_GONE') return { heading: 'pageCrashed', sentence: 'reloadPage', icon: TriangleAlert };
  return { heading: 'loadError', sentence: 'tryLoadingAgain', icon: TriangleAlert };
}

export function App({ language: initialLanguage }: { language: Language }) {
  const [state, setState] = useState<BrowserState | null>(null);
  const language = state?.language ?? initialLanguage;
  const t = (key: CopyKey) => text(key, language);
  const [error, setError] = useState('');
  const [address, setAddress] = useState('');
  const [dirty, setDirty] = useState(false);
  const [snapshot, setSnapshot] = useState<{ url: string; generation: number } | null>(null);
  const [suggestionsOpen, setSuggestionsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [suggestionIndex, setSuggestionIndex] = useState(-1);
  const [startSearch, setStartSearch] = useState('');
  const [panel, setPanel] = useState<Panel>(null);
  const [favoritesOpen, setFavoritesOpen] = useState(false);
  const [announcement, setAnnouncement] = useState('');
  const [undo, setUndo] = useState<{ kind: LibraryPanel; message: CopyKey } | null>(null);

  const undoGeneration = useRef(0);
  const undoTimeout = useRef<number | undefined>(undefined);

  const [menuOpen, setMenuOpen] = useState(false);
  const [aboutOpen, setAboutOpen] = useState(false), [clearDialogRequested, setClearDialogRequested] = useState(false), [firstRunOpen, setFirstRunOpen] = useState(false);
  const [hubPage, setHubPage] = useState<'home' | keyof typeof hubApps | null>(null);
  const [lyraOpen, setLyraOpen] = useState(false);
  const hubButtonRef = useRef<HTMLButtonElement>(null), lyraButtonRef = useRef<HTMLButtonElement>(null), lyraRef = useRef<HTMLDivElement>(null);
  const [profileOpen, setProfileOpen] = useState<'menu' | 'new' | null>(null);
  const [desktopOverlay, setDesktopOverlay] = useState<{ scope: string; mode: 'capture' } | null>(null);
  const liveDesktopOverlay = useRef(desktopOverlay);
  useLayoutEffect(() => { liveDesktopOverlay.current = desktopOverlay; }, [desktopOverlay]);
  const [desktopModalOpen, setDesktopModalOpen] = useState(false);
  const [pageCapturePending, setPageCapturePending] = useState(false);
  const [desktopLeaving, setDesktopLeaving] = useState(false);
  const desktopLeaves = useRef(0);
  const [captureShot, setCaptureShot] = useState<CaptureShot | null>(null);
  const [captureHint, setCaptureHint] = useState(false);
  const restoringCaptureFocus = useRef(false);
  const capturePending = useRef(false);
  const desktopButtonRef = useRef<HTMLButtonElement>(null);
  const desktopOpener = useRef<HTMLElement | null>(null);
  const [dismissedDesktopRead, setDismissedDesktopRead] = useState<string | null>(null);
  const [desktopNotice, setDesktopNotice] = useState<DesktopNotice | null>(null);
  const editsRef = useRef<DesktopEdits | null>(null);
  const edits = useMemo(() => new DesktopEdits(command => window.horizon.command(command), reason => {
    setDesktopNotice({ message: desktopError(reason, language), failure: true, action: text('retry', language), onAction: () => { void editsRef.current?.flush().then(() => setDesktopNotice(null)).catch(reason => setError(desktopError(reason, language))); } });
  }), [language]);
  useLayoutEffect(() => { editsRef.current = edits; }, [edits]);
  const [shieldScope, setShieldScope] = useState<string | null>(null);
  const shieldButtonRef = useRef<HTMLButtonElement>(null);
  const [pageFocusRequest, setPageFocusRequest] = useState<string | null>(null);
  const profileByKeyboard = useRef(false);
  const profileButtonRef = useRef<HTMLButtonElement>(null);
  const [contextMenu, setContextMenu] = useState<PageContextMenu | null>(null);
  const contextMenuRef = useRef<PageContextMenu | null>(null);
  const [tabMenu, setTabMenu] = useState<string | null>(null);
  const tabMenuOpener = useRef<HTMLButtonElement>(null);
  const groupOpener = useRef<HTMLButtonElement>(null);
  const groupPalette = useGroupPalette();
  const groupEditor = state?.groups.find(group => group.id === state.groupEditorId);
  const visible = state ? visibleTabs(state.tabs, state.groups) : [];
  const tabStripRef = useRef<HTMLDivElement>(null);
  const tabDragClick = useRef<string | null>(null);
  const tabDragPreview = useRef<HTMLElement | null>(null);
  const tabDrag = useRef<{ id: string; profile: string; move: boolean; cancelled: boolean; accepted: boolean; dropped: boolean; pointer: number; opener: HTMLButtonElement; start: { x: number; y: number }; point: { clientX: number; clientY: number; screenX: number; screenY: number }; transfer: DataTransfer; target: Element | null; started: boolean } | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');

  const [addressFocused, setAddressFocused] = useState(false);
  const [favicons, setFavicons] = useState<Record<string, { hash: string; url: string }>>({});
  const headerRef = useRef<HTMLElement>(null);
  const addressRef = useRef<HTMLInputElement>(null);
  const focusingClick = useRef(false);
  const snapshotRef = useRef<HTMLImageElement>(null);
  const snapshotUrl = useRef<string | null>(null);
  const captureGeneration = useRef(0);
  const areaHidden = useRef(false);
  const findRef = useRef<HTMLInputElement>(null);

  const menuByKeyboard = useRef(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const active = state?.tabs.find(tab => tab.id === state.activeId);
  const activeUrl = active?.url ?? '';
  const desktopScope = `${state?.activeProfileId}:${state?.activeId}:${activeUrl}`;
  const liveDesktopScope = useRef(desktopScope);
  useLayoutEffect(() => { liveDesktopScope.current = desktopScope; }, [desktopScope]);
  const desktopMode = desktopOverlay?.scope === desktopScope ? desktopOverlay.mode : null;
  const bookmarked = state ? allFavoriteLinks(state.store.favorites).some(item => item.url === activeUrl) : false;
  const site = state?.siteSettings;
  const siteScope = site ? `${state?.activeProfileId}:${state?.activeId}:${site.origin}` : null;
  const currentSiteScope = useRef(siteScope);
  useLayoutEffect(() => { currentSiteScope.current = siteScope; }, [siteScope]);
  const shieldOpen = shieldScope !== null && shieldScope === siteScope;
  const permissionPrompt = state?.privateWindow ? null : state?.permissionPrompt;
  const permissionOpen = Boolean(!groupEditor && !favoritesOpen && !desktopModalOpen && !aboutOpen && !firstRunOpen && !hubPage && !lyraOpen && permissionPrompt?.permissions.length && !pageCapturePending && !menuOpen && !profileOpen && !desktopMode && !suggestionsOpen && !contextMenu && !tabMenu && !shieldOpen && !panel && !findOpen);
  const showCaptureHint = captureHint && state?.showCapture !== false && !desktopMode && !pageCapturePending;
  const popover = Boolean(groupEditor) || favoritesOpen || showCaptureHint || Boolean(desktopNotice) || desktopModalOpen || Boolean(panel) || aboutOpen || firstRunOpen || Boolean(hubPage) || lyraOpen || menuOpen || Boolean(profileOpen) || Boolean(desktopMode) || suggestionsOpen || Boolean(contextMenu) || Boolean(tabMenu) || shieldOpen || permissionOpen;
  const hidden = Boolean(panel || popover);
  const pageShowing = Boolean(activeUrl && !active?.desktop && !active?.settings && !active?.error && (!active?.fullscreen || popover));
  const totalBlocked = active ? blockedTotal(active.blocked) : 0;
  // Third-party cookies are refused before the filter lists load, so a count can exist while the lists are not ready.
  const showBlocked = Boolean(site?.blocking && totalBlocked > 0);
  const ShieldIcon = !site?.blocking ? ShieldOff : !state?.blockingReady ? Shield : ShieldCheck;
  const shieldLabel = site ? !site.blocking ? t('blockingOffSite') : !state?.blockingReady && !totalBlocked ? t('blockingNotReady') : `${t('blockingOnSite')}, ${blockedCount(totalBlocked, language)}` : t('protection');
  const siteFavicon = active?.favicon && favicons[active.id]?.hash === active.favicon ? favicons[active.id]?.url : undefined;
  const siteInitial = (active?.title || activeUrl).slice(0, 1).toUpperCase();
  const failure = active?.error ? pageError(active.error) : null;
  const ErrorIcon = failure?.icon ?? TriangleAlert;
  const reportArea = useCallback((hidden: boolean) => {
    areaHidden.current = hidden;
    return window.horizon.setContentArea({ top: headerRef.current?.getBoundingClientRect().bottom ?? 0, hidden }).catch(() => setError(text('browserError', language)));
  }, [language]);
  const run = useCallback(async (command: BrowserCommand) => {
    const leaving = command.type === 'switch-profile' || command.type === 'delete-profile';
    if (leaving) { desktopLeaves.current++; setDesktopLeaving(true); }
    try { await edits.flush(); await window.horizon.command(command); setError(''); return true; }
    catch (reason) { setError(command.type === 'set-tab-group-folded' && reason instanceof Error && reason.message.includes('Tab limit reached') ? text('groupFoldLimit', language) : command.type.includes('group') ? text('browserError', language) : command.type === 'move-tab-to-window' ? text('actionError', language) : command.type.includes('favorite') || command.type === 'bookmark' ? favoritesError(reason, language) : command.type === 'open-settings' ? settingsError(reason, language) : desktopError(reason, language)); return false; }
    finally { if (leaving && --desktopLeaves.current === 0) setDesktopLeaving(false); }
  }, [language, edits]);
  const closeCapture = useCallback(() => {
    setDesktopOverlay(null); setCaptureHint(false); restoringCaptureFocus.current = true;
    try { (desktopButtonRef.current ?? hubButtonRef.current)?.focus(); }
    finally { restoringCaptureFocus.current = false; }
  }, []);
  const retryDesktopStorage = useCallback(async function retry(): Promise<void> {
    try { await edits.flush(); await window.horizon.command({ type: 'retry-desktop-storage' }); setDesktopNotice(null); }
    catch (reason) { setDesktopNotice({ message: desktopError(reason, language), failure: true, action: text('retry', language), onAction: () => { void retry(); } }); }
  }, [edits, language]);
  useEffect(() => {
    if (state?.desktopStorageError && desktopMode !== 'capture') setDesktopNotice({ message: text('DESKTOP_STORAGE_FAILED', language), failure: true, action: text('retry', language), onAction: () => { void retryDesktopStorage(); } });
  }, [state?.desktopStorageError, desktopMode, language, retryDesktopStorage]);
  const openDesktop = (id: string, item?: string) => {
    setDesktopOverlay(null); setShieldScope(null); setProfileOpen(null); setHubPage(null); setLyraOpen(false); setMenuOpen(false); setSuggestionsOpen(false); setPanel(null); setDirty(false);
    void run({ type: 'open-desktop', id, ...(item ? { item } : {}) });
  };
  const saveDesktopCapture = async (project: ProjectSummary) => {
    if (!captureShot) return;
    const overlay = desktopOverlay, scope = desktopScope;
    await edits.flush();
    await window.horizon.command({ type: 'add-capture-to-project', id: captureShot.id, project: project.id, folder: null });
    if (liveDesktopOverlay.current === overlay && liveDesktopScope.current === scope) closeCapture();
    setDesktopNotice({ capture: true, message: text('desktopSaved', language).replace('{name}', project.name), action: text('openApp', language), onAction: () => { setDesktopNotice(null); void openDesktopPanel({ kind: 'project', project: project.id }); } });
  };
  const captureVisible = async (work: () => Promise<CaptureShot>) => {
    const scope = desktopScope;
    setPageCapturePending(true);
    try {
      await reportArea(false);
      await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      if (liveDesktopScope.current !== scope) throw new Error('CAPTURE_CHANGED');
      return await work();
    } finally { setPageCapturePending(false); if (liveDesktopScope.current === scope) await reportArea(true); }
  };
  const deleteDesktopEntry = async (command: BrowserCommand, message: CopyKey) => {
    dismissUndo();
    if (await run(command)) {
      if (command.type === 'delete-item') await openDesktopPanel({ kind: 'project', project: command.project });
      else if (command.type === 'delete-capture') await openDesktopPanel({ kind: 'captures' });
      setDesktopNotice({ message: text(message, language), undo: true, action: text('undo', language), onAction: () => { setDesktopNotice(null); void run({ type: 'restore', kind: 'desktop' }); } });
    }
  };
  const closeShield = useCallback((focusShield = true) => {
    setShieldScope(null); if (focusShield) shieldButtonRef.current?.focus();
  }, []);
  const answerPermission = useCallback(async (answer: 'allow' | 'block' | 'dismiss', focusPage = true) => {
    if (!permissionPrompt) return;
    const scope = siteScope;
    if (await run({ type: 'answer-permission', id: permissionPrompt.id, answer }) && focusPage && currentSiteScope.current === scope) setPageFocusRequest(state?.activeId ?? null);
  }, [permissionPrompt, run, siteScope, state?.activeId]);
  const closeContextMenu = useCallback((focusPage = false) => {
    const menu = contextMenuRef.current;
    contextMenuRef.current = null; setContextMenu(null);
    if (menu) void window.horizon.command({ type: 'dismiss-context-menu', id: menu.id }).catch(() => {});
    if (focusPage) requestAnimationFrame(() => { void run({ type: 'focus-page' }); });
  }, [run]);
  const closeTabMenu = useCallback((focus = false) => { setTabMenu(null); if (focus) tabMenuOpener.current?.focus(); }, []);
  const showTabMenu = (id: string, opener: HTMLButtonElement) => {
    closeContextMenu(); setDesktopOverlay(null); setShieldScope(null); setProfileOpen(null); setHubPage(null); setLyraOpen(false); setMenuOpen(false); setSuggestionsOpen(false); setPanel(null);
    tabMenuOpener.current = opener; setTabMenu(id);
  };
  // A tab sent into a collapsed group is hidden, so focus goes to the group's label instead.
  const focusTab = useCallback((id: string) => { requestAnimationFrame(() => { const tab = document.getElementById(`tab-${id}`); (tab?.closest('[inert]') ? tab.closest('.tab-group-run')?.querySelector<HTMLElement>('.tab-group-label') : tab)?.focus(); }); }, []);
  const closeGroupEditor = useCallback((focus = false) => {
    const id = state?.groupEditorId;
    if (id) void run({ type: 'close-tab-group-editor', id }).then(success => { if (success && focus) groupOpener.current?.focus(); });
  }, [state?.groupEditorId, run]);
  const showGroupEditor = (group: TabGroup, opener: HTMLButtonElement) => {
    closeContextMenu(); closeTabMenu(); setDesktopOverlay(null); setShieldScope(null); setProfileOpen(null); setHubPage(null); setLyraOpen(false); setMenuOpen(false); setSuggestionsOpen(false); setPanel(null);
    groupOpener.current = opener; void run({ type: 'open-tab-group-editor', id: group.id });
  };
  useEffect(() => {
    if (state?.groupEditorId && (favoritesOpen || desktopModalOpen || aboutOpen || hubPage || lyraOpen || menuOpen || profileOpen || desktopMode || suggestionsOpen || contextMenu || tabMenu || shieldOpen || panel)) closeGroupEditor();
  }, [state?.groupEditorId, favoritesOpen, desktopModalOpen, aboutOpen, hubPage, lyraOpen, menuOpen, profileOpen, desktopMode, suggestionsOpen, contextMenu, tabMenu, shieldOpen, panel, closeGroupEditor]);
  const overTabDrag = useCallback((point: { clientX: number; clientY: number; screenX: number; screenY: number }) => {
    const drag = tabDrag.current;
    if (!drag?.started) return;
    drag.point = point;
    tabDragPreview.current?.style.setProperty('transform', `translate(${point.clientX - drag.start.x}px, ${point.clientY - drag.start.y}px)`);
    const target = document.elementFromPoint(point.clientX, point.clientY);
    const options = { bubbles: true, cancelable: true, dataTransfer: drag.transfer, ...point };
    if (drag.target !== target) {
      drag.target?.dispatchEvent(new DragEvent('dragleave', { ...options, relatedTarget: target }));
      target?.dispatchEvent(new DragEvent('dragenter', options)); drag.target = target;
    }
    drag.accepted = target?.dispatchEvent(new DragEvent('dragover', options)) === false;
  }, []);
  const finishTabDrag = useCallback((cancelled: boolean) => {
    const drag = tabDrag.current;
    if (!drag) return;
    drag.cancelled = cancelled;
    if (drag.started) {
      tabDragClick.current = drag.id;
      const options = { bubbles: true, cancelable: true, dataTransfer: drag.transfer, ...drag.point };
      if (!cancelled && drag.accepted && drag.target) { drag.dropped = true; drag.target.dispatchEvent(new DragEvent('drop', options)); }
      drag.target?.dispatchEvent(new DragEvent('dragleave', options));
      drag.opener.dispatchEvent(new DragEvent('dragend', options));
    }
    tabDrag.current = null;
    tabDragPreview.current?.remove(); tabDragPreview.current = null;
    drag.opener.style.removeProperty('cursor');
    if (drag.opener.hasPointerCapture(drag.pointer)) drag.opener.releasePointerCapture(drag.pointer);
  }, []);
  useEffect(() => {
    const cancel = (event: KeyboardEvent) => { if (event.key === 'Escape' && tabDrag.current) { event.preventDefault(); event.stopPropagation(); finishTabDrag(true); } };
    const drop = () => { if (tabDrag.current) tabDrag.current.dropped = true; };
    const blur = () => finishTabDrag(true);
    document.addEventListener('keydown', cancel, true); document.addEventListener('drop', drop, true);
    window.addEventListener('blur', blur);
    return () => { document.removeEventListener('keydown', cancel, true); document.removeEventListener('drop', drop, true); window.removeEventListener('blur', blur); finishTabDrag(true); };
  }, [finishTabDrag]);
  useEffect(() => { if (tabMenu && !state?.tabs.some(tab => tab.id === tabMenu)) closeTabMenu(); }, [tabMenu, state?.tabs, closeTabMenu]);
  useEffect(() => window.horizon.onContextMenu(menu => {
    contextMenuRef.current = menu; setContextMenu(menu);
    if (menu) { setTabMenu(null); setShieldScope(null); setProfileOpen(null); setHubPage(null); setLyraOpen(false); setMenuOpen(false); setSuggestionsOpen(false); setPanel(null); }
  }), []);
  const dismissUndo = useCallback(() => {
    undoGeneration.current++; window.clearTimeout(undoTimeout.current); undoTimeout.current = undefined;
    setUndo(null);
  }, []);
  const destructive = async (command: BrowserCommand, kind: LibraryPanel, message: CopyKey) => {
    setDesktopNotice(notice => notice?.undo ? null : notice);
    dismissUndo();
    const generation = undoGeneration.current;
    undoTimeout.current = window.setTimeout(() => { if (undoGeneration.current === generation) dismissUndo(); }, 8000);
    if (await run(command) && undoGeneration.current === generation) setUndo({ kind, message });
    else if (undoGeneration.current === generation) dismissUndo();
  };
  const focusAddress = useCallback(() => {
    dismissUndo();
    closeContextMenu();
    setDesktopOverlay(null); setShieldScope(null); setPanel(null); setMenuOpen(false); setProfileOpen(null); setHubPage(null); setLyraOpen(false);
    addressRef.current?.focus(); addressRef.current?.select();
  }, [dismissUndo, closeContextMenu]);
  const closeFind = useCallback(() => {
    setFindOpen(false); setFindText(''); void run({ type: 'stop-find' });
  }, [run]);
  const openPanel = useCallback((next: Panel) => {
    // A panel covers the page, so a search in it has nothing left to show.
    if (next) closeFind();
    dismissUndo();
    closeContextMenu();
    setDesktopOverlay(null); setShieldScope(null); setProfileOpen(null); setHubPage(null); setLyraOpen(false); setPanel(next); setMenuOpen(false); setSuggestionsOpen(false);
  }, [closeFind, dismissUndo, closeContextMenu]);
  const openSettings = (section: SettingsSection, clear = false) => {
    if (state?.privateWindow && section === 'profiles') section = 'general';
    closeFind(); dismissUndo(); closeContextMenu();
    setDesktopOverlay(null); setShieldScope(null); setProfileOpen(null); setHubPage(null); setLyraOpen(false); setMenuOpen(false); setSuggestionsOpen(false); setPanel(null); setDirty(false);
    setClearDialogRequested(false); void run({ type: 'open-settings', section }).then(success => { if (success && clear) setClearDialogRequested(true); });
  };
  const openDesktopPanel = useCallback(async (page: DesktopPanelPage, opener?: HTMLElement) => {
    if (!state?.desktopPanel.open) desktopOpener.current = opener ?? (document.activeElement instanceof HTMLElement ? document.activeElement : hubButtonRef.current);
    closeFind(); closeContextMenu();
    setDesktopOverlay(null); setShieldScope(null); setProfileOpen(null); setHubPage(null); setLyraOpen(false); setMenuOpen(false); setSuggestionsOpen(false); setPanel(null);
    if (active?.fullscreen && !await run({ type: 'fullscreen' })) return false;
    return run({ type: 'open-desktop-panel', page });
  }, [state?.desktopPanel.open, active?.fullscreen, closeFind, closeContextMenu, run]);
  const closeDesktopPanel = useCallback(() => {
    void run({ type: 'close-desktop-panel' }).then(success => {
      if (success) requestAnimationFrame(() => { (desktopOpener.current?.isConnected ? desktopOpener.current : hubButtonRef.current)?.focus(); });
    });
  }, [run]);
  const openCapture = useCallback(async () => {
    if (capturePending.current) return;
    setCaptureHint(false);
    const reason = active?.settings ? 'CAPTURE_SETTINGS' : active?.desktop ? 'CAPTURE_DESKTOP' : active?.error ? 'CAPTURE_CRASHED' : active?.loading ? 'CAPTURE_LOADING' : !/^https?:/.test(activeUrl) ? 'CAPTURE_UNAVAILABLE' : null;
    if (reason) { setDesktopNotice({ message: text(reason, language) }); return; }
    capturePending.current = true;
    closeFind(); closeContextMenu(); setShieldScope(null); setProfileOpen(null); setHubPage(null); setLyraOpen(false); setMenuOpen(false); setSuggestionsOpen(false); setPanel(null);
    const overlay = { scope: desktopScope, mode: 'capture' as const };
    setCaptureShot(null); setDesktopOverlay(overlay); setDesktopNotice(null);
    try {
      await reportArea(false);
      const shot = await window.horizon.command({ type: 'take-capture' });
      if (liveDesktopScope.current !== desktopScope || liveDesktopOverlay.current !== overlay) return;
      setCaptureShot(shot);
    } catch (reason) {
      if (liveDesktopScope.current === desktopScope && liveDesktopOverlay.current === overlay) {
        setDesktopOverlay(null); setDesktopNotice({ message: desktopError(reason, language), failure: true, action: text('retry', language), onAction: () => { void openCapture(); } });
      }
    }
    finally { capturePending.current = false; }
  }, [activeUrl, active?.desktop, active?.settings, active?.error, active?.loading, desktopScope, language, closeFind, closeContextMenu, reportArea]);
  const panelToTab = () => {
    if (!state) return;
    const page = state.desktopPanel.page;
    const id = page.kind === 'captures' || page.kind === 'item' && page.project === null ? 'captures' : page.kind === 'project' || page.kind === 'item' ? page.project! : state.projectInUse ?? state.projects[0]?.id ?? 'captures';
    void run({ type: 'open-desktop', id, ...(page.kind === 'item' ? { item: page.id } : {}) }).then(async success => { if (success && await run({ type: 'close-desktop-panel' })) document.getElementById('content')?.focus(); });
  };
  const openHub = (page: NonNullable<typeof hubPage>) => {
    closeFind(); dismissUndo(); closeContextMenu();
    setDesktopOverlay(null); setShieldScope(null); setProfileOpen(null); setMenuOpen(false); setSuggestionsOpen(false); setPanel(null); setLyraOpen(false); setHubPage(page);
  };
  const navigate = (input: string) => {
    setDirty(false);
    if (!input.trim()) return;
    if (/^\?\s/.test(input)) { const query = input.slice(2).trim(); if (!query) return; input = SEARCH_ENGINES[state?.searchEngine ?? 'duckduckgo'].searchPrefix + encodeURIComponent(query); }
    dismissUndo();
    closeContextMenu();
    setDesktopOverlay(null); setShieldScope(null); setProfileOpen(null); setHubPage(null); setLyraOpen(false); setSuggestionsOpen(false); setMenuOpen(false); setPanel(null); setStartSearch('');
    void run({ type: 'navigate', input }).then(success => { if (success) requestAnimationFrame(() => { void run({ type: 'focus-page' }); }); });
  };

  useEffect(() => {
    let mounted = true;
    let previous: BrowserState | null = null;
    let blockingReload: string | null = null;
    const receive = (next: BrowserState) => {
      if (!mounted) return;
      const current = next.tabs.find(tab => tab.id === next.activeId);
      const before = previous?.tabs.find(tab => tab.id === previous?.activeId);
      const announce = (message: string) => setAnnouncement(last => last === message ? last : message);
      const blockingChanged = previous?.activeProfileId === next.activeProfileId && before?.id === current?.id && previous?.siteSettings?.origin === next.siteSettings?.origin && previous?.siteSettings?.blocking !== next.siteSettings?.blocking && Boolean(next.siteSettings);
      const darkChanged = previous?.activeProfileId === next.activeProfileId && before?.id === current?.id && previous?.siteSettings?.origin === next.siteSettings?.origin && previous?.siteSettings?.dark !== next.siteSettings?.dark && Boolean(next.siteSettings);
      if (before?.id !== current?.id) blockingReload = null;
      if (blockingChanged) blockingReload = current?.id ?? null;
      if (current && before?.id === current.id) {
        if (current.error && current.error !== before.error) announce(text(pageError(current.error).heading, language));
        else if (current.loading && !before.loading) {
          let host = current.url;
          try { host = new URL(current.url).host || current.url; } catch { /* A blank tab has no host. */ }
          // The reload must not immediately replace the result of the user's blocking choice.
          if (blockingReload !== current.id) announce(text('pageLoading', language).replace('{page}', current.title && current.title !== current.url ? current.title : host));
          blockingReload = null;
        } else if (!current.loading && before.loading && !current.error) { blockingReload = null; announce(text('pageLoaded', language).replace('{page}', current.title || current.url)); }
        if (current.url === before.url) {
          const saved = allFavoriteLinks(next.store.favorites).some(item => item.url === current.url);
          const wasSaved = allFavoriteLinks(previous!.store.favorites).some(item => item.url === current.url);
          if (saved !== wasSaved) announce(text(saved ? 'bookmarkAdded' : 'bookmarkRemoved', language));
        }
      }
      if (blockingChanged && next.siteSettings) announce(text(next.siteSettings.blocking ? 'blockingEnabled' : 'blockingDisabled', language).replace('{host}', next.siteSettings.host));
      if (darkChanged && next.siteSettings) announce(text(next.siteSettings.dark ? 'darkModeEnabled' : 'darkModeDisabled', language).replace('{host}', next.siteSettings.host));
      if (previous && previous.activeProfileId !== next.activeProfileId) {
        const removed = previous.profiles.find(profile => !next.profiles.some(nextProfile => nextProfile.id === profile.id));
        const profile = removed ?? next.profiles.find(profile => profile.id === next.activeProfileId);
        const message = removed ? 'deletedProfile' : previous.profiles.some(profile => profile.id === next.activeProfileId) ? 'switchedProfile' : 'createdProfile';
        if (profile) announce(text(message, next.language).replace('{name}', profile.name));
      }
      previous = next;
      applyTheme(next.theme, next.contrast);
      document.documentElement.lang = next.language;
      document.title = current?.url && current.url !== 'about:blank' ? `${current.settings ? text('settings', next.language) : current.title || current.url} - ${text('product', next.language)}` : text('product', next.language);
      setState(next);
    };
    const unsubscribe = window.horizon.onState(receive);
    void window.horizon.getState().then(next => { if (!previous) receive(next); }).catch(() => {
      if (mounted) setError(text('browserError', language));
    });
    return () => { mounted = false; unsubscribe(); };
  }, [language]);
  const faviconKey = JSON.stringify(state?.tabs.map(tab => [tab.id, tab.favicon]) ?? []);
  useEffect(() => {
    let mounted = true;
    const urls: string[] = [];
    const tabs = JSON.parse(faviconKey) as [string, string | null][];
    const entries: Record<string, { hash: string; url: string }> = {};
    void Promise.all(tabs.map(async ([id, hash]) => {
      if (!hash) return;
      try {
        const bytes = await window.horizon.getFavicon(id, hash);
        if (!bytes || !mounted) return;
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)]));
        urls.push(url); entries[id] = { hash, url };
      } catch { /* A closed or navigating tab keeps its initial badge. */ }
    })).then(() => { if (mounted) setFavicons(entries); });
    return () => { mounted = false; urls.forEach(url => URL.revokeObjectURL(url)); };
  }, [faviconKey]);
  useEffect(() => {
    const timeout = window.setTimeout(() => { setQuery((dirty ? address : activeUrl).trim()); setSuggestionIndex(-1); }, 250);
    return () => window.clearTimeout(timeout);
  }, [address, dirty, activeUrl]);
  useLayoutEffect(() => {
    const header = headerRef.current;
    if (!header) return;
    const report = () => { void reportArea(areaHidden.current); };
    const observer = new ResizeObserver(report);
    observer.observe(header); window.addEventListener('resize', report); report();
    return () => { observer.disconnect(); window.removeEventListener('resize', report); };
  }, [reportArea]);
  useLayoutEffect(() => {
    if (pageCapturePending) return;
    const generation = ++captureGeneration.current;
    const removeSnapshot = () => {
      if (captureGeneration.current !== generation) return;
      setSnapshot(null);
      if (snapshotUrl.current) URL.revokeObjectURL(snapshotUrl.current);
      snapshotUrl.current = null;
    };
    if (!popover || !pageShowing) {
      void reportArea(false).then(() => requestAnimationFrame(removeSnapshot));
    } else {
      void reportArea(false).then(() => window.horizon.capture()).then(bytes => {
        if (!bytes || captureGeneration.current !== generation) return;
        const url = URL.createObjectURL(new Blob([new Uint8Array(bytes)], { type: 'image/jpeg' }));
        if (snapshotUrl.current) URL.revokeObjectURL(snapshotUrl.current);
        snapshotUrl.current = url;
        setSnapshot({ url, generation });
      }).catch(() => { if (captureGeneration.current === generation) setError(text('browserError', language)); });
    }
    return () => { captureGeneration.current++; };
  }, [panel, popover, pageShowing, pageCapturePending, state?.activeId, state?.desktopPanel.open, reportArea, language]);
  useLayoutEffect(() => {
    const image = snapshotRef.current;
    if (!snapshot || !image || pageCapturePending) return;
    void image.decode().then(() => requestAnimationFrame(() => {
      if (captureGeneration.current === snapshot.generation) void reportArea(true);
    })).catch(() => { if (captureGeneration.current === snapshot.generation) setError(text('browserError', language)); });
  }, [snapshot, pageCapturePending, reportArea, language]);
  useEffect(() => {
    if (!lyraOpen) return;
    lyraRef.current?.focus();
    const outside = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!lyraRef.current?.contains(target) && !lyraButtonRef.current?.contains(target)) setLyraOpen(false);
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [lyraOpen]);
  useEffect(() => { setHubPage(null); setLyraOpen(false); }, [state?.activeId, state?.activeProfileId]);
  useEffect(() => { setShieldScope(null); }, [siteScope]);
  useEffect(() => { setDesktopOverlay(null); }, [desktopScope]);
  useEffect(() => { setDesktopNotice(null); }, [state?.activeProfileId]);
  useEffect(() => {
    if (!pageFocusRequest) return;
    if (pageFocusRequest !== state?.activeId) { setPageFocusRequest(null); return; }
    if (hidden) return;
    let current = true;
    // The native page cannot receive focus until the snapshot has released it.
    void reportArea(false).then(() => { if (current) return run({ type: 'focus-page' }); }).finally(() => { if (current) setPageFocusRequest(null); });
    return () => { current = false; };
  }, [pageFocusRequest, hidden, state?.activeId, reportArea, run]);
  useEffect(() => () => {
    undoGeneration.current++; window.clearTimeout(undoTimeout.current);
    captureGeneration.current++;
    if (snapshotUrl.current) URL.revokeObjectURL(snapshotUrl.current);
    snapshotUrl.current = null;
  }, []);

  useEffect(() => {
    if (active?.settings && !panel) document.getElementById('settings-title')?.focus();
  }, [active?.settings, state?.activeId, panel]);
  useEffect(() => { dismissUndo(); setStartSearch(''); setDirty(false); setSuggestionsOpen(false); }, [state?.activeProfileId, dismissUndo]);
  useEffect(() => { if (findOpen) { findRef.current?.focus(); findRef.current?.select(); } }, [findOpen]);
  useEffect(() => {
    setDirty(false); setSuggestionsOpen(false); setFindOpen(false); setFindText('');
    document.getElementById(`tab-${state?.activeId}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [state?.activeId]);

  const shortcut = useCallback((action: BrowserShortcut) => {
    if (action === 'stop' && tabDrag.current) { finishTabDrag(true); return; }
    if (tabDrag.current) finishTabDrag(true);
    if (action !== 'stop') closeTabMenu();
    if (state?.privateWindow && action === 'bookmark') return;
    const tabs = state ? visibleTabs(state.tabs, state.groups) : [];
    const index = tabs.findIndex(tab => tab.id === state?.activeId);
    if (action === 'capture') void openCapture();
    else if (action === 'focus-address') focusAddress();
    else if (action === 'focus-search') { focusAddress(); setAddress('? '); setDirty(true); setSuggestionsOpen(false); requestAnimationFrame(() => addressRef.current?.setSelectionRange(2, 2)); }
    else if (action === 'reopen-tab') { if (state?.canReopenTab) void run({ type: 'reopen-tab' }); }
    else if (action === 'home') { closeFind(); openPanel(null); setDirty(false); setSuggestionsOpen(false); void run({ type: 'home' }).then(success => { if (success) requestAnimationFrame(focusAddress); }); }
    else if (action === 'clear-browsing-data') openSettings('privacy', true);
    else if (action === 'menu') { openPanel(null); setSuggestionsOpen(false); menuByKeyboard.current = true; setMenuOpen(true); }
    else if (action === 'print') { openPanel(null); void run({ type: 'print' }); }
    else if (action === 'new-window' || action === 'new-private-window') { openPanel(null); void run({ type: action }); }
    else if (action === 'new-tab') { openPanel(null); setDirty(false); setSuggestionsOpen(false); closeFind(); void run({ type: 'new-tab' }).then(success => { if (success) requestAnimationFrame(focusAddress); }); }
    else if (action === 'close-tab' && active) { closeFind(); setDirty(false); setSuggestionsOpen(false); void run({ type: 'close-tab', id: active.id }).then(success => { if (success) requestAnimationFrame(() => { void run({ type: 'focus-page' }); }); }); }
    else if (action === 'next-tab' || action === 'previous-tab') {
      const tab = tabs[shortcutTabIndex(action, tabs.length, index)];
      if (tab) { closeFind(); openPanel(null); setDirty(false); setSuggestionsOpen(false); void run({ type: 'activate-tab', id: tab.id }).then(success => { if (success) requestAnimationFrame(() => { void run({ type: 'focus-page' }); }); }); }
    } else if (action.startsWith('tab-')) {
      const tab = tabs[shortcutTabIndex(action, tabs.length, index)];
      if (tab) { closeFind(); openPanel(null); setDirty(false); setSuggestionsOpen(false); void run({ type: 'activate-tab', id: tab.id }).then(success => { if (success) requestAnimationFrame(() => { void run({ type: 'focus-page' }); }); }); }
    } else if (action === 'history' || action === 'downloads' || action === 'favorites') openPanel(action === 'favorites' ? 'bookmarks' : action);
    else if (action === 'fullscreen') { openPanel(null); closeFind(); void run({ type: 'fullscreen' }); }
    else if ((action === 'find' || action === 'find-next' || action === 'find-previous') && activeUrl && !active?.desktop && !active?.settings && !active?.error) {
      if (action !== 'find' && findOpen && findText) void run({ type: 'find', text: findText, forward: action === 'find-next', next: true });
      else { openPanel(null); setSuggestionsOpen(false); setFindOpen(true); requestAnimationFrame(() => { findRef.current?.focus(); findRef.current?.select(); }); }
    }
    else if (action === 'zoom-in' || action === 'zoom-out' || action === 'zoom-reset') void run({ type: 'zoom', delta: action === 'zoom-in' ? 1 : action === 'zoom-out' ? -1 : 0 });
    else if (action === 'stop') {
      if (aboutOpen) setAboutOpen(false);
      else if (desktopMode) closeCapture();
      else if (captureHint) setCaptureHint(false);
      else if (groupEditor) closeGroupEditor(true);
      else if (tabMenu) closeTabMenu(true);
      else if (contextMenu) closeContextMenu(true);
      else if (shieldOpen) closeShield();
      else if (permissionOpen) void answerPermission('dismiss');
      else if (findOpen) { closeFind(); void run({ type: 'focus-page' }); }
      else if (profileOpen) { setProfileOpen(null); setHubPage(null); setLyraOpen(false); profileButtonRef.current?.focus(); }
      else if (hubPage) { setHubPage(null); hubButtonRef.current?.focus(); }
      else if (lyraOpen) { setLyraOpen(false); lyraButtonRef.current?.focus(); }
      else if (panel || menuOpen) { openPanel(null); setMenuOpen(false); menuButtonRef.current?.focus(); }
      else if (suggestionsOpen) { setSuggestionsOpen(false); addressRef.current?.focus(); }
      else void run({ type: 'stop' });
    } else if (action === 'back' || action === 'forward' || action === 'reload' || action === 'reload-no-cache' || action === 'bookmark') {
      openPanel(null); setSuggestionsOpen(false); void run({ type: action });
    }
  }, [aboutOpen, hubPage, lyraOpen, state, active, activeUrl, closeFind, closeContextMenu, contextMenu, tabMenu, closeTabMenu, groupEditor, closeGroupEditor, finishTabDrag, findOpen, findText, focusAddress, menuOpen, profileOpen, openPanel, panel, run, suggestionsOpen, shieldOpen, closeShield, permissionOpen, answerPermission, desktopMode, closeCapture, openCapture]);
  useEffect(() => {
    const unsubscribe = window.horizon.onShortcut(shortcut);
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      const action = browserShortcut({ key: event.key, control: event.ctrlKey, alt: event.altKey, shift: event.shiftKey, meta: event.metaKey });
      if (action) { event.preventDefault(); shortcut(action); }
    };
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault(); if (event.deltaY) void run({ type: 'zoom', delta: event.deltaY < 0 ? 1 : -1 });
    };
    document.addEventListener('keydown', keydown); document.addEventListener('wheel', wheel, { passive: false });
    return () => { unsubscribe(); document.removeEventListener('keydown', keydown); document.removeEventListener('wheel', wheel); };
  }, [shortcut, run]);

  const suggestions = useMemo(() => {
    const searchQuery = (dirty ? address : activeUrl).trim().replace(/^\?\s+/, '');
    const search = { kind: 'search' as const, url: `${SEARCH_ENGINES[state?.searchEngine ?? 'duckduckgo'].searchPrefix}${encodeURIComponent(searchQuery)}`, title: text('searchWeb', language).replace('{query}', searchQuery), hint: '' };
    if (!query) return [search];
    const seen = new Set<string>();
    const local = [...(state ? allFavoriteLinks(state.store.favorites) : []), ...(state?.store.history ?? [])].filter(item => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return `${item.title} ${item.url}`.toLowerCase().includes(query.toLowerCase());
    }).slice(0, 8).map(item => ({ kind: 'createdAt' in item ? 'bookmark' as const : 'history' as const, url: item.url, title: item.title || item.url, hint: 'createdAt' in item ? text('bookmarks', language) : new URL(item.url).host }));
    const desktops = desktopSuggestions(state?.projects ?? [], query).map(project => ({ ...project, hint: text('projectHint', language) }));
    return [search, ...local, ...desktops];
  }, [query, address, dirty, activeUrl, language, state?.searchEngine, state?.store.favorites, state?.store.history, state?.projects]);
  const chooseSuggestion = (item: typeof suggestions[number]) => navigate(item.url);
  const iconButton = (Icon: LucideIcon, key: CopyKey, onClick: () => void, disabled = false, accent = false) => <button
    className={`icon-button${accent ? ' accent' : ''}`} type="button" onClick={onClick} disabled={disabled} aria-label={t(key)} title={t(key)}><Icon aria-hidden="true" /></button>;
  const windowAction = async (action: WindowAction) => {
    try { if (action === 'close') await edits.flush(); await window.horizon.windowAction(action); }
    catch { setError(t('actionError')); }
  };
  const closeDesktopNotice = useCallback(() => setDesktopNotice(null), []);
  const [addedItem, setAddedItem] = useState<{ profile: string; project: string; id: string } | null>(null);
  useEffect(() => { if (addedItem) { const timer = window.setTimeout(() => setAddedItem(null), 8000); return () => window.clearTimeout(timer); } }, [addedItem]);
  const desktopProps = state ? { state, language, edits, readOnly: desktopLeaving, run, onPage: openDesktopPanel, onDelete: deleteDesktopEntry, onModalChange: setDesktopModalOpen, addedItem, onDropped: (project: string, id: string) => setAddedItem({ profile: state.activeProfileId, project, id }), onRejected: (message: string) => setDesktopNotice({ message, failure: true }) } : null;
  const menuTab = state?.tabs.find(tab => tab.id === tabMenu);
  const tabMoveReason = state?.tabs.length === 1 ? 'tabMoveOnlyTab' : menuTab && !menuTab.movable ? 'tabMovePending' : null;

  return <>
    <div className="visually-hidden" role="status" aria-live="polite">{announcement}</div>
    <DesktopStatus notice={desktopNotice} language={language} onClose={closeDesktopNotice} />
    <a className="skip-link" href="#content" onClick={event => { event.preventDefault(); if (activeUrl && !active?.desktop && !active?.settings && !hidden && !active?.error) void run({ type: 'focus-page' }); else document.getElementById('content')?.focus(); }}>{t('skip')}</a>
    <header className="chrome" ref={headerRef} hidden={active?.fullscreen}>
      <div className="tab-strip" ref={tabStripRef}>
        <div className="tabs">
          <div className="tab-list-owner" role="tablist" aria-label={t('tabs')} aria-owns={visible.map(tab => `tab-${tab.id}`).join(' ')} />
          {state && tabRuns(state.tabs, state.groups).map(({ group, tabs }) => { const items = tabs.map(tab => { const index = visible.indexOf(tab); return <div className={`tab${tab.id === state.activeId ? ' active' : ''}`} key={tab.id} onContextMenu={event => { event.preventDefault(); const opener = event.currentTarget.querySelector<HTMLButtonElement>('.tab-select'); if (opener) showTabMenu(tab.id, opener); }} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); void run({ type: 'close-tab', id: tab.id }); } }}>
            <button id={`tab-${tab.id}`} className="tab-select" role="tab" type="button" aria-selected={tab.id === state.activeId} aria-controls="content" aria-haspopup="menu" aria-expanded={tabMenu === tab.id} tabIndex={tab.id === state.activeId ? 0 : -1}
              onDragStart={event => {
                // Favicon images can start a native drag that competes with pointer capture.
                event.preventDefault();
              }}
              onPointerDown={event => {
                if (event.button !== 0 || tabDrag.current) return;
                tabDragClick.current = null;
                const copy = !tab.desktop && !tab.settings && Boolean(parseDesktopDrag({ tab: { url: tab.url, title: tab.title } })), move = state.tabs.length > 1 && tab.movable;
                if (!copy && !move) return;
                const transfer = new DataTransfer(); transfer.effectAllowed = copy ? 'copy' : 'move';
                if (copy) {
                  transfer.setData(DESKTOP_TAB_DRAG, JSON.stringify({ profile: state.activeProfileId, tab: tab.id }));
                  transfer.setData('text/uri-list', tab.url); transfer.setData('text/plain', tab.title || tab.url);
                } else transfer.setData('application/x-horizon-window-tab', tab.id);
                tabDrag.current = { id: tab.id, profile: state.activeProfileId, move, cancelled: false, accepted: false, dropped: false, pointer: event.pointerId, opener: event.currentTarget, start: { x: event.clientX, y: event.clientY }, point: { clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY }, transfer, target: null, started: false };
                event.currentTarget.setPointerCapture(event.pointerId);
              }}
              onPointerMove={event => {
                const drag = tabDrag.current;
                if (!drag || drag.id !== tab.id || drag.pointer !== event.pointerId) return;
                if (!drag.started && Math.hypot(event.clientX - drag.start.x, event.clientY - drag.start.y) < 6) return;
                if (!drag.started) {
                  drag.started = true; closeTabMenu(); drag.opener.style.setProperty('cursor', 'grabbing');
                  const preview = drag.opener.parentElement?.cloneNode(true) as HTMLElement | undefined;
                  if (preview) {
                    preview.removeAttribute('id'); preview.querySelectorAll('[id]').forEach(element => element.removeAttribute('id')); preview.setAttribute('aria-hidden', 'true'); preview.inert = true; preview.classList.add('active');
                    const bounds = drag.opener.parentElement!.getBoundingClientRect();
                    preview.style.setProperty('position', 'fixed'); preview.style.setProperty('left', `${bounds.left}px`); preview.style.setProperty('top', `${bounds.top}px`); preview.style.setProperty('width', `${bounds.width}px`); preview.style.setProperty('height', `${bounds.height}px`); preview.style.setProperty('pointer-events', 'none'); preview.style.setProperty('z-index', 'calc(var(--layer-overlay) + 2)');
                    document.body.append(preview); tabDragPreview.current = preview;
                  }
                }
                overTabDrag({ clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY });
              }}
              onPointerUp={event => {
                const drag = tabDrag.current;
                if (!drag || drag.pointer !== event.pointerId) return;
                if (drag.started) { event.preventDefault(); overTabDrag({ clientX: event.clientX, clientY: event.clientY, screenX: event.screenX, screenY: event.screenY }); }
                finishTabDrag(false);
              }}
              onPointerCancel={() => finishTabDrag(true)} onLostPointerCapture={() => finishTabDrag(true)}
              onDragEnd={event => {
                const drag = tabDrag.current; tabDrag.current = null;
                const strip = tabStripRef.current?.getBoundingClientRect();
                if (!drag?.move || drag.cancelled || drag.accepted || drag.dropped || drag.id !== tab.id || drag.profile !== state.activeProfileId || !tab.movable || state.tabs.length < 2 || !strip || event.clientX >= strip.left && event.clientX <= strip.right && event.clientY >= strip.top && event.clientY <= strip.bottom) return;
                void run({ type: 'move-tab-to-window', id: tab.id, point: { x: event.screenX, y: event.screenY } });
              }}
              title={tab.settings ? t('settings') : tab.desktop ? desktopTabTitle(tab, language) : webTabTitle(tab, t('home'))} onClick={event => { if (event.detail > 0 && tabDragClick.current === tab.id) { tabDragClick.current = null; event.preventDefault(); return; } closeTabMenu(); closeFind(); setDirty(false); setSuggestionsOpen(false); void run({ type: 'activate-tab', id: tab.id }); }}
              onKeyDown={event => {
                if (event.key === 'ContextMenu' || event.key === 'F10' && event.shiftKey) { event.preventDefault(); showTabMenu(tab.id, event.currentTarget); return; }
                let next = index;
                if (event.key === 'ArrowRight') next = (index + 1) % visible.length;
                else if (event.key === 'ArrowLeft') next = (index + visible.length - 1) % visible.length;
                else if (event.key === 'Home') next = 0;
                else if (event.key === 'End') next = visible.length - 1;
                else return;
                event.preventDefault(); const selected = visible[next]; if (!selected) return; closeFind(); setDirty(false); setSuggestionsOpen(false);
                void run({ type: 'activate-tab', id: selected.id }); document.getElementById(`tab-${selected.id}`)?.focus();
              }}>
              {tab.loading ? <LoaderCircle className="spinner accent" aria-label={t('loading')} /> : !tab.url || tab.desktop || tab.settings ? <HorizonMark /> : tab.favicon && favicons[tab.id]?.hash === tab.favicon ? <img className="tab-favicon" src={favicons[tab.id]?.url} alt="" aria-hidden="true" onError={() => setFavicons(previous => { if (previous[tab.id]?.hash !== tab.favicon) return previous; const next = { ...previous }; delete next[tab.id]; return next; })} /> : <span className="tab-initial" aria-hidden="true">{(tab.title || tab.url).slice(0, 1).toUpperCase()}</span>}
              <span>{tab.settings ? t('settings') : tab.desktop ? desktopTabTitle(tab, language) : webTabTitle(tab, t('home'))}</span>
            </button>
            {iconButton(X, 'closeTab', () => { if (tab.id === state.activeId) closeFind(); void run({ type: 'close-tab', id: tab.id }); })}
          </div>; }); return group ? <GroupRun key={group.id} group={group} palette={groupPalette} language={language} editorId={state.groupEditorId} editorOpener={groupOpener} run={run} onEdit={showGroupEditor}>{items}</GroupRun> : <Fragment key={tabs[0]!.id}>{items}</Fragment>; })}
        </div>
        <button className="icon-button new-tab" type="button" onClick={() => shortcut('new-tab')} aria-label={t('newTab')} title={t('newTab')}><Plus aria-hidden="true" /></button><div className="drag-space" />
        <div className="window-controls">
          <button type="button" onClick={() => { void windowAction('minimize'); }} aria-label={t('minimize')} title={t('minimize')}><Minus aria-hidden="true" /></button>
          <button type="button" onClick={() => { void windowAction('maximize'); }} aria-label={t('maximize')} title={t('maximize')}><Square aria-hidden="true" /></button>
          <button type="button" onClick={() => { void windowAction('close'); }} aria-label={t('closeWindow')} title={t('closeWindow')}><X aria-hidden="true" /></button>
        </div>
      </div>
      <div className="toolbar" role="toolbar" aria-label={t('toolbar')}>
        <div className="navigation-buttons">{iconButton(ArrowLeft, 'back', () => shortcut('back'), !active?.canGoBack)}{iconButton(ArrowRight, 'forward', () => shortcut('forward'), !active?.canGoForward)}{iconButton(active?.loading ? X : RotateCw, active?.loading ? 'stop' : 'reload', () => shortcut(active?.loading ? 'stop' : 'reload'), !activeUrl || Boolean(active?.desktop) || Boolean(active?.settings))}</div>
        <form className="address-bar" onSubmit={event => { event.preventDefault(); const suggestion = suggestionsOpen && suggestionIndex >= 0 ? suggestions[suggestionIndex] : undefined; if (suggestion) chooseSuggestion(suggestion); else if (!dirty && active?.desktop) addressRef.current?.blur(); else navigate(dirty ? address : activeUrl); }}>
          {site ? <button className={`icon-button shield-button${site.blocking && state?.blockingReady ? ' accent' : ''}`} ref={shieldButtonRef} type="button" aria-label={shieldLabel} title={shieldLabel} aria-haspopup="dialog" aria-expanded={shieldOpen} aria-controls="shield-popover" onClick={() => {
            setDesktopOverlay(null); dismissUndo(); closeContextMenu(); setProfileOpen(null); setHubPage(null); setLyraOpen(false); setMenuOpen(false); setSuggestionsOpen(false); setPanel(null); closeFind(); setShieldScope(previous => previous === siteScope ? null : siteScope);
          }}><ShieldIcon aria-hidden="true" /></button> : <ShieldCheck className="accent" aria-label={t('protection')} />}
          <input ref={addressRef} spellCheck={false} autoComplete="off" role="combobox" aria-label={t('address')} aria-autocomplete="list" aria-expanded={suggestionsOpen} aria-controls="address-suggestions" aria-activedescendant={suggestionsOpen && suggestionIndex >= 0 ? `suggestion-${suggestionIndex}` : undefined}
            placeholder={t('address')} value={dirty ? address : addressFocused ? activeUrl : activeUrl.startsWith('https://') ? activeUrl.slice(8).replace(/^([^/?#]+)\/(?=$|[?#])/, '$1') : activeUrl} maxLength={8192}
            onFocus={event => { setAddressFocused(true); event.currentTarget.value = dirty ? address : activeUrl; event.currentTarget.select(); }}
            onMouseDown={event => { focusingClick.current = document.activeElement !== event.currentTarget; }}
            onMouseUp={event => { if (focusingClick.current) event.preventDefault(); focusingClick.current = false; }}
            onChange={event => { setDesktopOverlay(null); setShieldScope(null); setAddress(event.target.value); setDirty(true); setSuggestionIndex(-1); setSuggestionsOpen(Boolean(event.target.value.trim())); setProfileOpen(null); setHubPage(null); setLyraOpen(false); setMenuOpen(false); setPanel(null); }}
            onBlur={event => { focusingClick.current = false; setAddressFocused(false); if (!dirty) setDirty(false); if (!event.relatedTarget || !(event.relatedTarget as HTMLElement).closest('.suggestions')) setSuggestionsOpen(false); }}
            onKeyDown={event => {
              if (event.key === 'Enter' && event.ctrlKey && !event.altKey && !event.shiftKey && !event.metaKey) { event.preventDefault(); navigate(completeAddress(dirty ? address : activeUrl)); return; }
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSuggestionsOpen(true); setSuggestionIndex(previous => !suggestions.length ? -1 : previous < 0 ? event.key === 'ArrowDown' ? 0 : suggestions.length - 1 : (previous + (event.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length); }
              else if (event.key === 'Escape') { event.preventDefault(); setSuggestionsOpen(false); setDirty(false); addressRef.current?.focus(); }
            }} />
          {active && active.zoom !== 1 && <button className="zoom-level" type="button" title={t('zoomReset')} aria-label={`${Math.round(active.zoom * 100)}%, ${t('zoomReset')}`} onClick={() => { void run({ type: 'zoom', delta: 0 }); }}>{Math.round(active.zoom * 100)}%</button>}
          {showBlocked && <span className="address-blocked">{blockedCount(totalBlocked, language)}</span>}
          {!state?.privateWindow && <button className={`icon-button${bookmarked ? ' accent bookmarked' : ''}`} type="button" disabled={!/^https?:/.test(activeUrl)} aria-label={t(bookmarked ? 'removeBookmark' : 'bookmark')} aria-pressed={bookmarked} title={t(bookmarked ? 'removeBookmark' : 'bookmark')} onClick={() => shortcut('bookmark')}><Star aria-hidden="true" /></button>}
        </form>
        <div className="tools">{state?.showCapture !== false && <button className="icon-button" ref={desktopButtonRef} type="button" aria-label={t('captureShortcut')} aria-describedby={showCaptureHint ? 'capture-shortcut' : undefined} aria-haspopup="dialog" aria-expanded={Boolean(desktopMode)} onMouseEnter={() => setCaptureHint(true)} onMouseLeave={() => setCaptureHint(false)} onFocus={event => { if (!restoringCaptureFocus.current && event.currentTarget.matches(':focus-visible')) setCaptureHint(true); }} onBlur={() => setCaptureHint(false)} onClick={() => { setCaptureHint(false); void openCapture(); }}><Scan aria-hidden="true" /></button>}
          {state?.quickAccess.filter(app => !state.privateWindow || app !== 'desktop').map(app => { const { label, icon: Icon } = hubApps[app]; return <button className="icon-button" type="button" key={app} aria-label={t(label)} title={t(label)} onClick={event => { if (app === 'desktop') void openDesktopPanel({ kind: 'home' }, event.currentTarget); else openHub(app); }}><Icon aria-hidden="true" /></button>; })}
          <button className="icon-button" ref={hubButtonRef} type="button" aria-label={t('hub')} title={t('hub')} aria-haspopup="dialog" aria-expanded={Boolean(hubPage)} aria-controls="hub-popup" onClick={() => { if (hubPage) { setHubPage(null); hubButtonRef.current?.focus(); } else openHub('home'); }}><LayoutGrid aria-hidden="true" /></button>
          <ProfileControl profile={state?.profiles.find(profile => profile.id === state.activeProfileId)} privateWindow={state?.privateWindow ?? false} language={language} open={profileOpen} opener={profileButtonRef} onClick={keyboard => { setDesktopOverlay(null); setShieldScope(null); dismissUndo(); closeContextMenu(); setMenuOpen(false); setSuggestionsOpen(false); setHubPage(null); setLyraOpen(false); setPanel(null); profileByKeyboard.current = keyboard; setProfileOpen(previous => previous ? null : 'menu'); }} />
          <button className="icon-button" ref={menuButtonRef} type="button" aria-label={t('menu')} title={t('menu')} aria-haspopup="menu" aria-expanded={menuOpen || Boolean(panel)} aria-controls={panel ? "browser-library-panel" : "browser-menu"} onClick={event => { setDesktopOverlay(null); setShieldScope(null); setProfileOpen(null); setHubPage(null); setLyraOpen(false); closeContextMenu(); menuByKeyboard.current = event.detail === 0; setSuggestionsOpen(false); setPanel(null); setMenuOpen(previous => !previous); }}><Ellipsis aria-hidden="true" /></button>
          <button className="icon-button lyra-button" ref={lyraButtonRef} type="button" aria-label={t('lyra')} title={t('lyra')} aria-haspopup="dialog" aria-expanded={lyraOpen} aria-controls="lyra-preview" onClick={() => { closeFind(); dismissUndo(); closeContextMenu(); setDesktopOverlay(null); setShieldScope(null); setProfileOpen(null); setHubPage(null); setMenuOpen(false); setSuggestionsOpen(false); setPanel(null); setLyraOpen(previous => !previous); }}><span><Sparkles aria-hidden="true" /></span></button>
        </div>
      </div>
      {state && <FavoritesBar key={`${state.activeProfileId}:${state.activeId}`} state={state} language={language} run={run} onDelete={destructive} onOverlay={setFavoritesOpen} dismiss={Boolean(groupEditor || panel || menuOpen || profileOpen || hubPage || lyraOpen || desktopMode || suggestionsOpen || contextMenu || tabMenu || shieldOpen || aboutOpen || desktopModalOpen)} onActivate={() => { closeFind(); closeContextMenu(); setDesktopOverlay(null); setShieldScope(null); setProfileOpen(null); setHubPage(null); setLyraOpen(false); setMenuOpen(false); setSuggestionsOpen(false); setPanel(null); }} undo={panel === 'bookmarks' ? null : undo} onRestore={() => { dismissUndo(); void run({ type: 'restore', kind: 'bookmarks' }); }} />}
      {findOpen && <div className="find-bar" role="search" aria-label={t('find')}>
        <Search aria-hidden="true" /><input ref={findRef} spellCheck={false} autoComplete="off" aria-label={t('find')} placeholder={t('find')} value={findText} maxLength={1024} onChange={event => { const value = event.target.value; setFindText(value); if (value) void run({ type: 'find', text: value, forward: true, next: false }); else void run({ type: 'stop-find' }); }}
          onKeyDown={event => { if (event.key === 'Enter' && findText) { event.preventDefault(); void run({ type: 'find', text: findText, forward: !event.shiftKey, next: true }); } }} />
        <span className="match-count" role="status">{findText ? active?.find.total ? `${active.find.active} ${t('matchOf')} ${active.find.total}` : t('notFound') : ''}</span>
        {iconButton(ArrowUp, 'previousMatch', () => { void run({ type: 'find', text: findText, forward: false, next: true }); }, !findText)}{iconButton(ArrowDown, 'nextMatch', () => { void run({ type: 'find', text: findText, forward: true, next: true }); }, !findText)}{iconButton(X, 'close', () => { closeFind(); void run({ type: 'focus-page' }); })}
      </div>}
      {(error || state?.storageReadError || state?.storageError || (state?.desktopReadError && dismissedDesktopRead !== state.activeProfileId) || state?.desktopLocked || state?.desktopStorageError) && <div className="shell-status" role="alert"><span>{error || t(state?.desktopLocked ? 'DESKTOP_LOCKED' : state?.desktopReadError && dismissedDesktopRead !== state.activeProfileId ? 'desktopReadFailed' : state?.desktopStorageError ? 'DESKTOP_STORAGE_FAILED' : state?.storageReadError ? 'storageReadError' : 'storageError')}</span>{state?.desktopLocked && <button className="text-button" type="button" onClick={() => { void retryDesktopStorage(); }}>{t('retry')}</button>}{(error || state?.desktopReadError && !state.desktopLocked && dismissedDesktopRead !== state.activeProfileId) && iconButton(X, 'close', () => { if (error) setError(''); else if (state) setDismissedDesktopRead(state.activeProfileId); })}</div>}
      <div className={`loading-line${active?.loading ? ' loading' : ''}`} aria-hidden="true" />
    </header>
    {menuTab && <ToolbarPopover opener={tabMenuOpener}><Menu id="tab-menu" className="browser-tools-menu" label={t('tabActions').replace('{name}', menuTab.settings ? t('settings') : menuTab.desktop ? desktopTabTitle(menuTab, language) : webTabTitle(menuTab, t('home')))} describedBy={tabMoveReason ? 'tab-move-reason' : undefined} keyboard opener={tabMenuOpener} onDismiss={reason => closeTabMenu(reason !== 'outside')}>
      <button type="button" role="menuitem" tabIndex={-1} disabled={Boolean(tabMoveReason)} aria-describedby={tabMoveReason ? 'tab-move-reason' : undefined} onClick={() => { closeTabMenu(true); void run({ type: 'move-tab-to-window', id: menuTab.id }); }}><AppWindow aria-hidden="true" /><span>{t('moveTabToWindow')}</span></button>
      {tabMoveReason && <p className="settings-note" id="tab-move-reason">{t(tabMoveReason)}</p>}
      <TabGroupMenuItems tab={menuTab} groups={state?.groups ?? []} palette={groupPalette} language={language} close={closeTabMenu} focusTab={focusTab} run={run} />
    </Menu></ToolbarPopover>}
    {groupEditor && <GroupEditor key={`${state?.activeProfileId}:${groupEditor.id}`} group={groupEditor} language={language} palette={groupPalette} opener={groupOpener} run={run} onDismiss={closeGroupEditor} />}
    {showCaptureHint && <ToolbarPopover opener={desktopButtonRef}><span className="capture-shortcut-tooltip" id="capture-shortcut" role="tooltip">{t('captureShortcut')}</span></ToolbarPopover>}
    {desktopMode === 'capture' && state && <CapturePreview state={state} language={language} shot={captureShot} header={headerRef} opener={desktopButtonRef} onClose={closeCapture} onSave={saveDesktopCapture} onVisible={captureVisible} onShot={setCaptureShot} />}
    {shieldOpen && site && active && state && <ShieldPopover key={siteScope} site={site} privateWindow={state.privateWindow} counts={active.blocked} ready={state.blockingReady} blockAds={state.blockAds} darkPages={state.darkPages} language={language} favicon={siteFavicon} initial={siteInitial} opener={shieldButtonRef} onDismiss={reason => closeShield(reason === 'escape')} onTabOut={backward => { closeShield(backward); if (!backward) addressRef.current?.focus(); }} run={run} />}
    {permissionOpen && permissionPrompt && <PermissionDialog key={`${siteScope}:${permissionPrompt.id}`} prompt={permissionPrompt} language={language} favicon={siteFavicon} initial={siteInitial} onAnswer={answerPermission} />}
    {hubPage && state && <Hub onAnnounce={setAnnouncement} state={state} language={language} page={hubPage} opener={hubButtonRef} onPage={page => { if (page === 'desktop') void openDesktopPanel({ kind: 'home' }, hubButtonRef.current ?? undefined); else setHubPage(page); }} onDismiss={focus => { setHubPage(null); if (focus) hubButtonRef.current?.focus(); }} />}
    {lyraOpen && <ToolbarPopover opener={lyraButtonRef}><div className="lyra-toolbar-preview" id="lyra-preview" ref={lyraRef} role="dialog" aria-label={t('lyra')} tabIndex={-1} onKeyDown={event => {
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); setLyraOpen(false); lyraButtonRef.current?.focus(); }
      if (event.key === 'Tab') { setLyraOpen(false); lyraButtonRef.current?.focus(); }
    }}><h2><Sparkles className="accent" aria-hidden="true" />{t('lyra')}</h2><p>{t('askLyra')}</p><p className="preview-notice">{t('unavailable')}</p></div></ToolbarPopover>}
    {profileOpen === 'menu' && state && !state.privateWindow && <ProfilesMenu state={state} language={language} keyboard={profileByKeyboard.current} opener={profileButtonRef} onDismiss={reason => { setProfileOpen(null); setHubPage(null); setLyraOpen(false); if (reason === 'escape') profileButtonRef.current?.focus(); }} onSwitch={profile => {
      setProfileOpen(null); setHubPage(null); setLyraOpen(false); profileButtonRef.current?.focus();
      void run({ type: 'switch-profile', id: profile.id }).then(success => { if (success) { setAnnouncement(t('switchedProfile').replace('{name}', profile.name)); profileButtonRef.current?.focus(); } });
    }} onNew={() => setProfileOpen('new')} onManage={() => openSettings('profiles')} onPrivate={() => { setProfileOpen(null); profileButtonRef.current?.focus(); void run({ type: 'new-private-window' }); }} />}
    {profileOpen === 'new' && state && !state.privateWindow && <NewProfilePopover state={state} language={language} opener={profileButtonRef} onCancel={() => { setProfileOpen(null); setHubPage(null); setLyraOpen(false); profileButtonRef.current?.focus(); }} onSuccess={name => { setProfileOpen(null); setHubPage(null); setLyraOpen(false); setAnnouncement(t('createdProfile').replace('{name}', name)); profileButtonRef.current?.focus(); }} />}
    {menuOpen && <BrowserMenu privateWindow={state?.privateWindow ?? false} language={language} active={active} canReopen={state?.canReopenTab ?? false} keyboard={menuByKeyboard.current} opener={menuButtonRef} onDismiss={focus => { setMenuOpen(false); if (focus) menuButtonRef.current?.focus(); }} onShortcut={action => { setMenuOpen(false); if (action === 'new-window' || action === 'new-private-window') menuButtonRef.current?.focus(); shortcut(action); }} onPanel={openPanel} onSettings={() => openSettings('general')} onAbout={() => { setMenuOpen(false); setAboutOpen(true); }} run={run} />}
    {panel === 'bookmarks' && state && <FavoritesPanel key={state.activeProfileId} state={state} language={language} opener={menuButtonRef} undo={undo} onRestore={() => { dismissUndo(); void run({ type: 'restore', kind: 'bookmarks' }); }} onDelete={destructive} run={run} onDismiss={focus => { setPanel(null); if (focus) menuButtonRef.current?.focus(); }} onAnnounce={setAnnouncement} />}
    {panel && panel !== 'bookmarks' && state && <BrowserPanel key={state.activeProfileId + ':' + panel} panel={panel} state={state} language={language} opener={menuButtonRef} favicons={favicons} undo={undo} onRestore={() => { if (undo) { const kind = undo.kind; dismissUndo(); void run({ type: 'restore', kind }); } }} onDelete={destructive} run={run} onNavigate={navigate} onBrowse={focusAddress} onClear={() => openSettings('privacy', true)} onDismiss={focus => { setPanel(null); if (focus) menuButtonRef.current?.focus(); }} onAnnounce={setAnnouncement} />}
    {state?.firstRun && <FirstRunImport state={state} language={language} returnFocus={addressRef} onOpen={setFirstRunOpen} />}
    {aboutOpen && state && <AboutHorizon version={state.version} update={state.update} language={language} opener={menuButtonRef} onClose={() => setAboutOpen(false)} onRestart={() => { void run({ type: 'restart-to-update' }); }} />}
    {contextMenu && <Menu key={contextMenu.id} id="page-context-menu" label={t('pageMenu')} keyboard={contextMenu.keyboard} point={contextMenu} onDismiss={reason => closeContextMenu(reason === 'escape')}>
      {contextMenu.groups.flatMap((group, index) => [
        ...(index ? [<hr role="separator" key={`divider-${index}`} />] : []),
        ...group.map(item => {
          const row = item.id.startsWith('spell:') ? null : pageMenuRows[item.id as keyof typeof pageMenuRows];
          const Icon = row?.icon ?? SpellCheck;
          const label = row ? t(row.label).replace('{query}', contextMenu.selection ?? '') : item.id.slice(6);
          return <button type="button" role="menuitem" tabIndex={-1} key={item.id} disabled={!item.enabled} onClick={() => {
            const menuId = contextMenu.id;
            contextMenuRef.current = null; setContextMenu(null);
            if (item.id === 'add-to-desktop') {
              void edits.flush().then(() => window.horizon.command({ type: 'context-menu', id: menuId, item: item.id })).then(() => window.horizon.getState()).then(next => {
                const project = next.projects.find(project => project.id === next.projectInUse);
                if (project) setDesktopNotice({ message: t('desktopSaved').replace('{name}', project.name) });
              }).catch(reason => setDesktopNotice({ message: desktopError(reason, language), failure: true }));
            } else void run({ type: 'context-menu', id: menuId, item: item.id }).then(success => { if (success) requestAnimationFrame(() => { void run({ type: 'focus-page' }); }); });
          }}><Icon aria-hidden="true" /><span>{label}</span></button>;
        }),
      ])}
    </Menu>}
    <div className="content-shell"><main id="content" className={active?.settings ? 'settings-content-area' : active?.desktop ? 'desktop-content' : activeUrl ? 'web-content' : 'start-content'} tabIndex={-1}>
      {active?.settings && state ? <Settings key={state.activeProfileId} state={state} section={active.settings} language={language} onOpen={openSettings} openClearDialog={clearDialogRequested} onClearDialogOpened={() => setClearDialogRequested(false)} /> : active?.desktop && desktopProps ? <DesktopTab key={`${state!.activeProfileId}:${active.desktop}`} id={active.desktop} selected={active.desktopItem} props={desktopProps} onOpen={openDesktop} /> : active?.error && failure ? <section className="error-page" role="alert"><ErrorIcon aria-hidden="true" /><h1>{t(failure.heading)}</h1><p>{t(failure.sentence)}</p><div className="error-details"><p>{active.url}</p><p>{active.error}</p></div><button className="text-button" type="button" onClick={() => { void run({ type: 'reload' }); }}>{t('retry')}</button></section> : activeUrl ? (snapshot && <img className={`web-snapshot${active?.fullscreen ? ' fullscreen-snapshot' : ''}`} ref={snapshotRef} src={snapshot.url} alt="" aria-hidden="true" />) : !state ? <p role="status">{t('loading')}</p> : <div className={`start-page${state.privateWindow ? ' private-start-page' : ''}`}>
        <div className="start-sky"><div className="start-browsing">
          <h1>{t('product')}</h1>
          <form className="search-field start-search" onSubmit={event => { event.preventDefault(); navigate(startSearch); }}><Search aria-hidden="true" /><input spellCheck={false} autoComplete="off" aria-label={t('search')} placeholder={t('search')} value={startSearch} maxLength={8192} onChange={event => setStartSearch(event.target.value)} /><Sparkles className="accent" aria-hidden="true" /></form>
          {state.privateWindow && <p className="private-window-notice">{t('privateWindowNotice')}</p>}
          <nav className="shortcuts" aria-label={t('shortcuts')}>{(Object.keys(sites) as (keyof typeof sites)[]).map(key => <a href={sites[key]} key={key} onClick={event => { event.preventDefault(); if (event.ctrlKey) void run({ type: 'new-tab', input: sites[key], background: true }); else navigate(sites[key]); }} onAuxClick={event => { event.preventDefault(); if (event.button === 1) void run({ type: 'new-tab', input: sites[key], background: true }); }}>{t(key)}</a>)}</nav>
        </div></div>
        <div className="start-ground">
          <div className="horizon-rule" aria-hidden="true" />
          <svg className="horizon-sun" viewBox="0 0 64 32" aria-hidden="true"><path d="M0 32 A32 32 0 0 1 64 32" /></svg>
          {!state.privateWindow && <div className="start-research">
            <DesktopResume state={state} language={language} onOpen={(project, item) => { void openDesktopPanel(item ? { kind: 'item', project, id: item } : { kind: 'project', project }); }} onNew={button => { void openDesktopPanel({ kind: 'new-project' }, button); }} />
            <div className="lyra-preview"><div className="lyra-prompt"><Sparkles className="accent" aria-hidden="true" />{t('askLyra')}</div><p className="preview-notice">{t('unavailable')}</p></div>
          </div>}
        </div>
      </div>}
    </main>{state?.desktopPanel.open && !active?.fullscreen && desktopProps && <DesktopPanel key={state.activeProfileId} props={desktopProps} onClose={closeDesktopPanel} onTab={panelToTab} />}</div>
    {suggestionsOpen && createPortal(<div className="suggestions" aria-label={t('suggestions')}>
      <ul id="address-suggestions" role="listbox" aria-label={t('suggestions')}>
        {suggestions.map((item, index) => <li role="option" id={`suggestion-${index}`} aria-selected={index === suggestionIndex} key={`${item.kind}:${item.url}`} onMouseDown={event => event.preventDefault()} onClick={() => chooseSuggestion(item)}>{item.kind === 'search' ? <Search aria-hidden="true" /> : item.kind === 'bookmark' ? <Star aria-hidden="true" /> : item.kind === 'project' ? <Folder aria-hidden="true" /> : <History aria-hidden="true" />}<strong>{item.title}</strong>{item.hint && <small>{item.hint}</small>}</li>)}
      </ul>
    </div>, document.body)}
  </>;
}
