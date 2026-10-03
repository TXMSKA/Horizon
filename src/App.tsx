import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Download, Ellipsis,
  ClipboardPaste, Copy, ExternalLink, FolderOpen, History, Image, LoaderCircle, Minus, NotebookPen, Plus, Redo2, Scissors, SpellCheck, TextSelect, Undo2,
  RotateCw, Search, SearchX, ServerOff, Settings2, Shield, ShieldAlert, ShieldCheck, ShieldOff, Sparkles, Square, Star, Trash2, TriangleAlert, WifiOff, X,
} from 'lucide-react';
import type { LucideIcon } from 'lucide-react';
import { text } from './copy';
import type { CopyKey } from './copy';
import { SEARCH_ENGINES } from './shared/api';
import type { BrowserCommand, BrowserShortcut, BrowserState, CaptureRect, ContextMenuItemId, Language, NotebookSummary, PageContextMenu, SettingsSection, WindowAction } from './shared/api';
import { browserShortcut } from './shared/shortcuts';
import { applyTheme } from './theme';
import { Menu } from './Menu';
import { NewProfilePopover, ProfileControl, ProfilesMenu } from './Profiles';
import { EmptyBookmarks, EmptyDownloads, EmptyHistory, NoResults } from './EmptyState';
import { HorizonMark } from './HorizonMark';
import { Switch } from './Switch';
import { blockedCount, blockedTotal, PermissionDialog, ShieldPopover } from './SiteControls';
import { CaptureOverlay } from './Capture';
import type { CaptureKind } from './Capture';
import { NotebookHome, NotebookPicker, NotebookStatus, notebookError } from './Notebooks';
import type { NotebookNotice } from './Notebooks';
import { NotebookView } from './NotebookView';
import { NotebookEdits } from './shared/notebook-edits';
import { Settings, settingsError } from './Settings';

type LibraryPanel = 'history' | 'bookmarks' | 'downloads';
type Panel = LibraryPanel | null;
const sites = {
  wikipedia: 'https://www.wikipedia.org/', youtube: 'https://www.youtube.com/',
  maps: 'https://www.google.com/maps', news: 'https://www.bbc.com/news', mail: 'https://mail.google.com/',
} as const;
const pageMenuRows: Record<Exclude<ContextMenuItemId, `spell:${string}`>, { label: CopyKey; icon: LucideIcon }> = {
  'open-link': { label: 'openLink', icon: ExternalLink }, 'copy-link': { label: 'copyLink', icon: Copy },
  'open-image': { label: 'openImage', icon: Image }, 'save-image': { label: 'saveImage', icon: Download },
  'copy-image': { label: 'copyImage', icon: Copy }, 'copy-image-address': { label: 'copyImageAddress', icon: Copy },
  copy: { label: 'copy', icon: Copy }, 'search-selection': { label: 'searchWeb', icon: Search },
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
  const [announcement, setAnnouncement] = useState('');
  const [undo, setUndo] = useState<{ kind: LibraryPanel; message: CopyKey } | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const undoGeneration = useRef(0);
  const undoTimeout = useRef<number | undefined>(undefined);
  const [filter, setFilter] = useState('');
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState<'menu' | 'new' | null>(null);
  const [notebookOverlay, setNotebookOverlay] = useState<{ scope: string; mode: 'capture' | 'list' | 'new' } | null>(null);
  const [pageCapturePending, setPageCapturePending] = useState(false);
  const [notebookLeaving, setNotebookLeaving] = useState(false);
  const notebookLeaves = useRef(0);
  const liveNotebookOverlay = useRef(notebookOverlay);
  const notebookButtonRef = useRef<HTMLButtonElement>(null);
  const notebookOpener = useRef<HTMLElement | null>(null);
  const [dismissedNotebookRead, setDismissedNotebookRead] = useState<string | null>(null);
  const [notebookNotice, setNotebookNotice] = useState<NotebookNotice | null>(null);
  const editsRef = useRef<NotebookEdits | null>(null);
  const edits = useMemo(() => new NotebookEdits(command => window.horizon.command(command), reason => {
    setNotebookNotice({ message: notebookError(reason, language), failure: true, action: text('retry', language), onAction: () => { void editsRef.current?.flush().then(() => setNotebookNotice(null)).catch(reason => setError(notebookError(reason, language))); } });
  }), [language]);
  useLayoutEffect(() => { editsRef.current = edits; }, [edits]);
  const [shieldScope, setShieldScope] = useState<string | null>(null);
  const shieldButtonRef = useRef<HTMLButtonElement>(null);
  const [pageFocusRequest, setPageFocusRequest] = useState<string | null>(null);
  const profileByKeyboard = useRef(false);
  const profileButtonRef = useRef<HTMLButtonElement>(null);
  const [contextMenu, setContextMenu] = useState<PageContextMenu | null>(null);
  const contextMenuRef = useRef<PageContextMenu | null>(null);
  const [findOpen, setFindOpen] = useState(false);
  const [findText, setFindText] = useState('');
  const [renameUrl, setRenameUrl] = useState('');
  const [renameTitle, setRenameTitle] = useState('');
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
  const panelRef = useRef<HTMLElement>(null);
  const menuByKeyboard = useRef(false);
  const menuButtonRef = useRef<HTMLButtonElement>(null);
  const active = state?.tabs.find(tab => tab.id === state.activeId);
  const activeUrl = active?.url ?? '';
  const notebookScope = `${state?.activeProfileId}:${state?.activeId}:${activeUrl}`;
  const liveNotebookScope = useRef(notebookScope);
  useLayoutEffect(() => { liveNotebookScope.current = notebookScope; }, [notebookScope]);
  const notebookMode = notebookOverlay?.scope === notebookScope ? notebookOverlay.mode : null;
  useLayoutEffect(() => { liveNotebookOverlay.current = notebookOverlay; }, [notebookOverlay]);
  const bookmarked = state?.store.bookmarks.some(item => item.url === activeUrl) ?? false;
  const site = state?.siteSettings;
  const siteScope = site ? `${state?.activeProfileId}:${state?.activeId}:${site.origin}` : null;
  const currentSiteScope = useRef(siteScope);
  useLayoutEffect(() => { currentSiteScope.current = siteScope; }, [siteScope]);
  const shieldOpen = shieldScope !== null && shieldScope === siteScope;
  const permissionPrompt = state?.permissionPrompt;
  const permissionOpen = Boolean(permissionPrompt?.permissions.length && !pageCapturePending && !menuOpen && !profileOpen && !notebookMode && !suggestionsOpen && !contextMenu && !shieldOpen && !panel && !findOpen);
  const popover = menuOpen || Boolean(profileOpen) || Boolean(notebookMode) || suggestionsOpen || Boolean(contextMenu) || shieldOpen || permissionOpen;
  const hidden = Boolean(panel || popover);
  const pageShowing = Boolean(activeUrl && !active?.notebook && !active?.settings && !active?.error && (!active?.fullscreen || popover));
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
    if (leaving) { notebookLeaves.current++; setNotebookLeaving(true); }
    try { await edits.flush(); await window.horizon.command(command); setError(''); return true; }
    catch (reason) { setError(command.type === 'open-settings' ? settingsError(reason, language) : notebookError(reason, language)); return false; }
    finally { if (leaving && --notebookLeaves.current === 0) setNotebookLeaving(false); }
  }, [language, edits]);
  const closeNotebooks = useCallback(() => {
    setNotebookOverlay(null); (notebookMode === 'capture' ? notebookButtonRef : notebookOpener).current?.focus();
  }, [notebookMode]);
  const retryNotebookStorage = useCallback(async function retry(): Promise<void> {
    try { await edits.flush(); await window.horizon.command({ type: 'retry-notebook-storage' }); setNotebookNotice(null); }
    catch (reason) { setNotebookNotice({ message: notebookError(reason, language), failure: true, action: text('retry', language), onAction: () => { void retry(); } }); }
  }, [edits, language]);
  useEffect(() => {
    if (state?.notebookStorageError && notebookMode !== 'capture') setNotebookNotice({ message: text('NOTEBOOK_STORAGE_FAILED', language), failure: true, action: text('retry', language), onAction: () => { void retryNotebookStorage(); } });
  }, [state?.notebookStorageError, notebookMode, language, retryNotebookStorage]);
  const openNotebook = (id: string, item?: string) => {
    setNotebookOverlay(null); setShieldScope(null); setProfileOpen(null); setMenuOpen(false); setSuggestionsOpen(false); setPanel(null); setDirty(false);
    void run({ type: 'open-notebook', id, ...(item ? { item } : {}) });
  };
  const saveNotebookCapture = async (notebook: NotebookSummary, kind: CaptureKind, rect: CaptureRect) => {
    const scope = notebookScope;
    const overlay = notebookOverlay;
    const command: BrowserCommand = kind === 'area' ? { type: 'save-capture', notebook: notebook.id, kind, rect } : { type: 'save-capture', notebook: notebook.id, kind };
    const save = async () => {
      if (liveNotebookScope.current !== scope) throw new Error('CAPTURE_CHANGED');
      if (state?.notebookLocked) throw new Error('NOTEBOOK_LOCKED');
      await edits.flush();
      if (kind === 'page') {
        setNotebookNotice({ message: text('capturingPage', language), pending: true });
        setPageCapturePending(true); setNotebookOverlay(null); setMenuOpen(false); setProfileOpen(null); setShieldScope(null); setSuggestionsOpen(false); setPanel(null);
        await new Promise<void>(resolve => requestAnimationFrame(() => requestAnimationFrame(() => resolve())));
        await reportArea(false);
        await new Promise<void>(resolve => requestAnimationFrame(() => resolve()));
      }
      if (liveNotebookScope.current !== scope) throw new Error('CAPTURE_CHANGED');
      await window.horizon.command(command);
      const content = await window.horizon.getNotebook(notebook.id), item = content.items.at(-1)?.id;
      if (liveNotebookOverlay.current === overlay) setNotebookOverlay(null);
      if (liveNotebookScope.current === scope && (!liveNotebookOverlay.current || liveNotebookOverlay.current === overlay)) notebookButtonRef.current?.focus();
      setNotebookNotice({ message: text('notebookSaved', language).replace('{name}', notebook.name), action: text('openNotebook', language), onAction: () => { setNotebookNotice(null); openNotebook(notebook.id, item); } });
    };
    const retry = () => { setNotebookNotice(null); void save().catch(reason => setNotebookNotice({ message: notebookError(reason, language), failure: true, action: text('retry', language), onAction: retry })).finally(() => setPageCapturePending(false)); };
    try { await save(); }
    catch (reason) {
      if (kind === 'page' || liveNotebookOverlay.current !== overlay || liveNotebookScope.current !== scope) setNotebookNotice({ message: notebookError(reason, language), failure: true, action: text('retry', language), onAction: retry });
      else throw reason;
    }
    finally { setPageCapturePending(false); }
  };
  const deleteNotebookEntry = async (command: BrowserCommand, message: CopyKey) => {
    dismissUndo();
    if (await run(command)) setNotebookNotice({ message: text(message, language), undo: true, action: text('undo', language), onAction: () => { setNotebookNotice(null); void run({ type: 'restore', kind: 'notebooks' }); } });
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
  useEffect(() => window.horizon.onContextMenu(menu => {
    contextMenuRef.current = menu; setContextMenu(menu);
    if (menu) { setShieldScope(null); setProfileOpen(null); setMenuOpen(false); setSuggestionsOpen(false); setPanel(null); }
  }), []);
  const dismissUndo = useCallback(() => {
    undoGeneration.current++; window.clearTimeout(undoTimeout.current); undoTimeout.current = undefined;
    setUndo(null); setConfirmClear(false);
  }, []);
  const destructive = async (command: BrowserCommand, kind: LibraryPanel, message: CopyKey) => {
    setNotebookNotice(notice => notice?.undo ? null : notice);
    dismissUndo();
    const generation = undoGeneration.current;
    undoTimeout.current = window.setTimeout(() => { if (undoGeneration.current === generation) dismissUndo(); }, 8000);
    if (await run(command) && undoGeneration.current === generation) setUndo({ kind, message });
    else if (undoGeneration.current === generation) dismissUndo();
  };
  const focusAddress = useCallback(() => {
    dismissUndo();
    closeContextMenu();
    setNotebookOverlay(null); setShieldScope(null); setPanel(null); setMenuOpen(false); setProfileOpen(null);
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
    setNotebookOverlay(null); setShieldScope(null); setProfileOpen(null); setFilter(''); setRenameUrl(''); setPanel(next); setMenuOpen(false); setSuggestionsOpen(false);
  }, [closeFind, dismissUndo, closeContextMenu]);
  const openSettings = (section: SettingsSection) => {
    closeFind(); dismissUndo(); closeContextMenu();
    setNotebookOverlay(null); setShieldScope(null); setProfileOpen(null); setMenuOpen(false); setSuggestionsOpen(false); setPanel(null); setDirty(false);
    void run({ type: 'open-settings', section });
  };
  const navigate = (input: string) => {
    setDirty(false);
    if (!input.trim()) return;
    dismissUndo();
    closeContextMenu();
    setNotebookOverlay(null); setShieldScope(null); setProfileOpen(null); setSuggestionsOpen(false); setMenuOpen(false); setPanel(null); setStartSearch('');
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
          const saved = next.store.bookmarks.some(item => item.url === current.url);
          const wasSaved = previous!.store.bookmarks.some(item => item.url === current.url);
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
    const generation = ++captureGeneration.current;
    const removeSnapshot = () => {
      if (captureGeneration.current !== generation) return;
      setSnapshot(null);
      if (snapshotUrl.current) URL.revokeObjectURL(snapshotUrl.current);
      snapshotUrl.current = null;
    };
    if (panel || !popover || !pageShowing) {
      void reportArea(Boolean(panel)).then(() => requestAnimationFrame(removeSnapshot));
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
  }, [panel, popover, pageShowing, state?.activeId, reportArea, language]);
  useLayoutEffect(() => {
    const image = snapshotRef.current;
    if (!snapshot || !image) return;
    void image.decode().then(() => requestAnimationFrame(() => {
      if (captureGeneration.current === snapshot.generation) void reportArea(true);
    })).catch(() => { if (captureGeneration.current === snapshot.generation) setError(text('browserError', language)); });
  }, [snapshot, reportArea, language]);
  useEffect(() => { setShieldScope(null); }, [siteScope]);
  useEffect(() => { setNotebookOverlay(null); }, [notebookScope]);
  useEffect(() => { setNotebookNotice(null); }, [state?.activeProfileId]);
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
  useEffect(() => { if (panel) (panelRef.current?.querySelector<HTMLInputElement>('input') ?? panelRef.current?.querySelector<HTMLButtonElement>('button:not(:disabled)'))?.focus(); }, [panel]);
  useEffect(() => {
    if (active?.settings && !panel) document.getElementById('settings-title')?.focus();
  }, [active?.settings, state?.activeId, panel]);
  useEffect(() => { dismissUndo(); setRenameUrl(''); setFilter(''); setStartSearch(''); setDirty(false); setSuggestionsOpen(false); }, [state?.activeProfileId, dismissUndo]);
  useEffect(() => { if (findOpen) { findRef.current?.focus(); findRef.current?.select(); } }, [findOpen]);
  useEffect(() => {
    setDirty(false); setSuggestionsOpen(false); setFindOpen(false); setFindText('');
    document.getElementById(`tab-${state?.activeId}`)?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, [state?.activeId]);

  const shortcut = useCallback((action: BrowserShortcut) => {
    const tabs = state?.tabs ?? [];
    const index = tabs.findIndex(tab => tab.id === state?.activeId);
    if (action === 'focus-address') focusAddress();
    else if (action === 'new-tab') { openPanel(null); setDirty(false); setSuggestionsOpen(false); closeFind(); void run({ type: 'new-tab' }).then(success => { if (success) requestAnimationFrame(focusAddress); }); }
    else if (action === 'close-tab' && active) { closeFind(); setDirty(false); setSuggestionsOpen(false); void run({ type: 'close-tab', id: active.id }).then(success => { if (success) requestAnimationFrame(() => { void run({ type: 'focus-page' }); }); }); }
    else if (action === 'next-tab' || action === 'previous-tab') {
      const tab = tabs[(index + (action === 'next-tab' ? 1 : tabs.length - 1)) % tabs.length];
      if (tab) { closeFind(); openPanel(null); setDirty(false); setSuggestionsOpen(false); void run({ type: 'activate-tab', id: tab.id }).then(success => { if (success) requestAnimationFrame(() => { void run({ type: 'focus-page' }); }); }); }
    } else if (action.startsWith('tab-')) {
      const number = Number(action.slice(4)); const tab = tabs[number === 9 ? tabs.length - 1 : number - 1];
      if (tab) { closeFind(); openPanel(null); setDirty(false); setSuggestionsOpen(false); void run({ type: 'activate-tab', id: tab.id }).then(success => { if (success) requestAnimationFrame(() => { void run({ type: 'focus-page' }); }); }); }
    } else if (action === 'history' || action === 'downloads') openPanel(action);
    else if (action === 'find' && activeUrl && !active?.notebook && !active?.settings && !active?.error) { openPanel(null); setSuggestionsOpen(false); setFindOpen(true); requestAnimationFrame(() => { findRef.current?.focus(); findRef.current?.select(); }); }
    else if (action === 'zoom-in' || action === 'zoom-out' || action === 'zoom-reset') void run({ type: 'zoom', delta: action === 'zoom-in' ? 1 : action === 'zoom-out' ? -1 : 0 });
    else if (action === 'stop') {
      if (notebookMode) closeNotebooks();
      else if (contextMenu) closeContextMenu(true);
      else if (shieldOpen) closeShield();
      else if (permissionOpen) void answerPermission('dismiss');
      else if (findOpen) { closeFind(); void run({ type: 'focus-page' }); }
      else if (profileOpen) { setProfileOpen(null); profileButtonRef.current?.focus(); }
      else if (panel || menuOpen) { openPanel(null); setMenuOpen(false); menuButtonRef.current?.focus(); }
      else if (suggestionsOpen) { setSuggestionsOpen(false); addressRef.current?.focus(); }
      else void run({ type: 'stop' });
    } else if (action === 'back' || action === 'forward' || action === 'reload' || action === 'bookmark') {
      openPanel(null); setSuggestionsOpen(false); void run({ type: action });
    }
  }, [state, active, activeUrl, closeFind, closeContextMenu, contextMenu, findOpen, focusAddress, menuOpen, profileOpen, openPanel, panel, run, suggestionsOpen, shieldOpen, closeShield, permissionOpen, answerPermission, notebookMode, closeNotebooks]);
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
    const search = { kind: 'search' as const, url: `${SEARCH_ENGINES[state?.searchEngine ?? 'duckduckgo'].searchPrefix}${encodeURIComponent((dirty ? address : activeUrl).trim())}`, title: text('searchWeb', language).replace('{query}', (dirty ? address : activeUrl).trim()), hint: '' };
    if (!query) return [search];
    const seen = new Set<string>();
    const local = [...(state?.store.bookmarks ?? []), ...(state?.store.history ?? [])].filter(item => {
      if (seen.has(item.url)) return false;
      seen.add(item.url);
      return `${item.title} ${item.url}`.toLowerCase().includes(query.toLowerCase());
    }).slice(0, 8).map(item => ({ kind: 'createdAt' in item ? 'bookmark' as const : 'history' as const, url: item.url, title: item.title || item.url, hint: 'createdAt' in item ? text('bookmarks', language) : new URL(item.url).host }));
    const notebooks = (state?.notebooks ?? []).filter(notebook => notebook.name.toLowerCase().includes(query.toLowerCase())).slice(0, 3).map(notebook => ({ kind: 'notebook' as const, url: notebook.id, title: notebook.name, hint: text('notebookHint', language) }));
    return [search, ...local, ...notebooks];
  }, [query, address, dirty, activeUrl, language, state?.searchEngine, state?.store.bookmarks, state?.store.history, state?.notebooks]);
  const chooseSuggestion = (item: typeof suggestions[number]) => { if (item.kind === 'notebook') openNotebook(item.url); else navigate(item.url); };
  const iconButton = (Icon: LucideIcon, key: CopyKey, onClick: () => void, disabled = false, accent = false) => <button
    className={`icon-button${accent ? ' accent' : ''}`} type="button" onClick={onClick} disabled={disabled} aria-label={t(key)} title={t(key)}><Icon aria-hidden="true" /></button>;
  const previewButton = (Icon: LucideIcon, key: CopyKey, accent = false) => <button
    className={`icon-button${accent ? ' accent' : ''}`} type="button" disabled aria-label={t(key)} title={t('unavailable')}><Icon aria-hidden="true" /></button>;
  const windowAction = async (action: WindowAction) => {
    try { if (action === 'close') await edits.flush(); await window.horizon.windowAction(action); }
    catch { setError(t('actionError')); }
  };
  const entries = panel === 'history' ? state?.store.history ?? [] : state?.store.bookmarks ?? [];
  const filteredEntries = entries.filter(item => `${item.title} ${item.url}`.toLowerCase().includes(filter.toLowerCase()));
  const closeNotebookNotice = useCallback(() => setNotebookNotice(null), []);

  return <>
    <div className="visually-hidden" role="status" aria-live="polite">{announcement}</div>
    <NotebookStatus notice={notebookNotice} language={language} onClose={closeNotebookNotice} />
    <a className="skip-link" href="#content" onClick={event => { event.preventDefault(); if (activeUrl && !active?.notebook && !active?.settings && !hidden && !active?.error) void run({ type: 'focus-page' }); else document.getElementById('content')?.focus(); }}>{t('skip')}</a>
    <header className="chrome" ref={headerRef}>
      <div className="tab-strip">
        <ProfileControl profile={state?.profiles.find(profile => profile.id === state.activeProfileId)} language={language} open={profileOpen} opener={profileButtonRef} onClick={keyboard => { setNotebookOverlay(null); setShieldScope(null); dismissUndo(); closeContextMenu(); setMenuOpen(false); setSuggestionsOpen(false); profileByKeyboard.current = keyboard; setProfileOpen(previous => previous ? null : 'menu'); }} />
        <span className="separator" aria-hidden="true" />
        <nav className="tabs" role="tablist" aria-label={t('tabs')}>
          {state?.tabs.map((tab, index) => <div className={`tab${tab.id === state.activeId ? ' active' : ''}`} key={tab.id} onAuxClick={event => { if (event.button === 1) { event.preventDefault(); void run({ type: 'close-tab', id: tab.id }); } }}>
            <button id={`tab-${tab.id}`} className="tab-select" role="tab" type="button" aria-selected={tab.id === state.activeId} aria-controls="content" tabIndex={tab.id === state.activeId ? 0 : -1}
              title={tab.settings ? t('settings') : tab.title || t('home')} onClick={() => { closeFind(); setDirty(false); setSuggestionsOpen(false); void run({ type: 'activate-tab', id: tab.id }); }}
              onKeyDown={event => {
                let next = index;
                if (event.key === 'ArrowRight') next = (index + 1) % state.tabs.length;
                else if (event.key === 'ArrowLeft') next = (index + state.tabs.length - 1) % state.tabs.length;
                else if (event.key === 'Home') next = 0;
                else if (event.key === 'End') next = state.tabs.length - 1;
                else return;
                event.preventDefault(); const selected = state.tabs[next]; if (!selected) return; closeFind(); setDirty(false); setSuggestionsOpen(false);
                void run({ type: 'activate-tab', id: selected.id }); document.getElementById(`tab-${selected.id}`)?.focus();
              }}>
              {tab.loading ? <LoaderCircle className="spinner accent" aria-label={t('loading')} /> : !tab.url || tab.notebook || tab.settings ? <HorizonMark /> : tab.favicon && favicons[tab.id]?.hash === tab.favicon ? <img className="tab-favicon" src={favicons[tab.id]?.url} alt="" aria-hidden="true" onError={() => setFavicons(previous => { if (previous[tab.id]?.hash !== tab.favicon) return previous; const next = { ...previous }; delete next[tab.id]; return next; })} /> : <span className="tab-initial" aria-hidden="true">{(tab.title || tab.url).slice(0, 1).toUpperCase()}</span>}
              <span>{tab.settings ? t('settings') : tab.title || t('home')}</span>
            </button>
            {iconButton(X, 'closeTab', () => { if (tab.id === state.activeId) closeFind(); void run({ type: 'close-tab', id: tab.id }); })}
          </div>)}
        </nav>
        <button className="icon-button new-tab" type="button" onClick={() => shortcut('new-tab')} aria-label={t('newTab')} title={t('newTab')}><Plus aria-hidden="true" /></button><div className="drag-space" />
        <div className="window-controls">
          <button type="button" onClick={() => { void windowAction('minimize'); }} aria-label={t('minimize')} title={t('minimize')}><Minus aria-hidden="true" /></button>
          <button type="button" onClick={() => { void windowAction('maximize'); }} aria-label={t('maximize')} title={t('maximize')}><Square aria-hidden="true" /></button>
          <button type="button" onClick={() => { void windowAction('close'); }} aria-label={t('closeWindow')} title={t('closeWindow')}><X aria-hidden="true" /></button>
        </div>
      </div>
      <div className="toolbar" role="toolbar" aria-label={t('toolbar')}>
        <div className="navigation-buttons">{iconButton(ArrowLeft, 'back', () => shortcut('back'), !active?.canGoBack)}{iconButton(ArrowRight, 'forward', () => shortcut('forward'), !active?.canGoForward)}{iconButton(active?.loading ? X : RotateCw, active?.loading ? 'stop' : 'reload', () => shortcut(active?.loading ? 'stop' : 'reload'), !activeUrl || Boolean(active?.notebook) || Boolean(active?.settings))}</div>
        <form className="address-bar" onSubmit={event => { event.preventDefault(); const suggestion = suggestionsOpen && suggestionIndex >= 0 ? suggestions[suggestionIndex] : undefined; if (suggestion) chooseSuggestion(suggestion); else if (!dirty && active?.notebook) addressRef.current?.blur(); else navigate(dirty ? address : activeUrl); }}>
          {site ? <button className={`icon-button shield-button${site.blocking && state?.blockingReady ? ' accent' : ''}`} ref={shieldButtonRef} type="button" aria-label={shieldLabel} title={shieldLabel} aria-haspopup="dialog" aria-expanded={shieldOpen} aria-controls="shield-popover" onClick={() => {
            setNotebookOverlay(null); dismissUndo(); closeContextMenu(); setProfileOpen(null); setMenuOpen(false); setSuggestionsOpen(false); setPanel(null); closeFind(); setShieldScope(previous => previous === siteScope ? null : siteScope);
          }}><ShieldIcon aria-hidden="true" /></button> : <ShieldCheck className="accent" aria-label={t('protection')} />}
          <input ref={addressRef} spellCheck={false} autoComplete="off" role="combobox" aria-label={t('address')} aria-autocomplete="list" aria-expanded={suggestionsOpen} aria-controls="address-suggestions" aria-activedescendant={suggestionsOpen && suggestionIndex >= 0 ? `suggestion-${suggestionIndex}` : undefined}
            placeholder={t('address')} value={dirty ? address : addressFocused ? activeUrl : activeUrl.startsWith('https://') ? activeUrl.slice(8).replace(/^([^/?#]+)\/(?=$|[?#])/, '$1') : activeUrl} maxLength={8192}
            onFocus={event => { setAddressFocused(true); event.currentTarget.value = dirty ? address : activeUrl; event.currentTarget.select(); }}
            onMouseDown={event => { focusingClick.current = document.activeElement !== event.currentTarget; }}
            onMouseUp={event => { if (focusingClick.current) event.preventDefault(); focusingClick.current = false; }}
            onChange={event => { setNotebookOverlay(null); setShieldScope(null); setAddress(event.target.value); setDirty(true); setSuggestionIndex(-1); setSuggestionsOpen(Boolean(event.target.value.trim())); setProfileOpen(null); setMenuOpen(false); setPanel(null); }}
            onBlur={event => { focusingClick.current = false; setAddressFocused(false); if (!dirty) setDirty(false); if (!event.relatedTarget || !(event.relatedTarget as HTMLElement).closest('.suggestions')) setSuggestionsOpen(false); }}
            onKeyDown={event => {
              if (event.key === 'ArrowDown' || event.key === 'ArrowUp') { event.preventDefault(); setSuggestionsOpen(true); setSuggestionIndex(previous => !suggestions.length ? -1 : previous < 0 ? event.key === 'ArrowDown' ? 0 : suggestions.length - 1 : (previous + (event.key === 'ArrowDown' ? 1 : suggestions.length - 1)) % suggestions.length); }
              else if (event.key === 'Escape') { event.preventDefault(); setSuggestionsOpen(false); setDirty(false); addressRef.current?.focus(); }
            }} />
          {active && active.zoom !== 1 && <button className="zoom-level" type="button" title={t('zoomReset')} aria-label={`${Math.round(active.zoom * 100)}%, ${t('zoomReset')}`} onClick={() => { void run({ type: 'zoom', delta: 0 }); }}>{Math.round(active.zoom * 100)}%</button>}
          {showBlocked && <span className="address-blocked">{blockedCount(totalBlocked, language)}</span>}
          <button className={`icon-button${bookmarked ? ' accent bookmarked' : ''}`} type="button" disabled={!/^https?:/.test(activeUrl)} aria-label={t(bookmarked ? 'removeBookmark' : 'bookmark')} aria-pressed={bookmarked} title={t(bookmarked ? 'removeBookmark' : 'bookmark')} onClick={() => shortcut('bookmark')}><Star aria-hidden="true" /></button>
        </form>
        <div className="tools"><button className="icon-button" ref={notebookButtonRef} type="button" aria-label={t('notebooks')} title={t('notebooks')} aria-haspopup="dialog" aria-expanded={Boolean(notebookMode)} onClick={() => {
          notebookOpener.current = notebookButtonRef.current; setShieldScope(null); setProfileOpen(null); setMenuOpen(false); setSuggestionsOpen(false); setPanel(null); closeFind(); closeContextMenu();
          setNotebookOverlay(previous => previous?.scope === notebookScope ? null : { scope: notebookScope, mode: /^https?:/.test(activeUrl) && !active?.notebook ? 'capture' : 'list' });
        }}><NotebookPen aria-hidden="true" /></button>{previewButton(Sparkles, 'lyra', true)}<button className="icon-button" ref={menuButtonRef} type="button" aria-label={t('menu')} title={t('menu')} aria-expanded={menuOpen} aria-controls="browser-menu" onClick={event => { setNotebookOverlay(null); setShieldScope(null); setProfileOpen(null); closeContextMenu(); menuByKeyboard.current = event.detail === 0; setSuggestionsOpen(false); setMenuOpen(previous => !previous); }}><Ellipsis aria-hidden="true" /></button></div>
      </div>
      {findOpen && <div className="find-bar" role="search" aria-label={t('find')}>
        <Search aria-hidden="true" /><input ref={findRef} spellCheck={false} autoComplete="off" aria-label={t('find')} placeholder={t('find')} value={findText} maxLength={1024} onChange={event => { const value = event.target.value; setFindText(value); if (value) void run({ type: 'find', text: value, forward: true, next: false }); else void run({ type: 'stop-find' }); }}
          onKeyDown={event => { if (event.key === 'Enter' && findText) { event.preventDefault(); void run({ type: 'find', text: findText, forward: !event.shiftKey, next: true }); } }} />
        <span className="match-count" role="status">{findText ? active?.find.total ? `${active.find.active} ${t('matchOf')} ${active.find.total}` : t('notFound') : ''}</span>
        {iconButton(ArrowUp, 'previousMatch', () => { void run({ type: 'find', text: findText, forward: false, next: true }); }, !findText)}{iconButton(ArrowDown, 'nextMatch', () => { void run({ type: 'find', text: findText, forward: true, next: true }); }, !findText)}{iconButton(X, 'close', () => { closeFind(); void run({ type: 'focus-page' }); })}
      </div>}
      {(error || state?.storageReadError || state?.storageError || (state?.notebookReadError && dismissedNotebookRead !== state.activeProfileId) || state?.notebookLocked || state?.notebookStorageError) && <div className="shell-status" role="alert"><span>{error || t(state?.notebookLocked ? 'NOTEBOOK_LOCKED' : state?.notebookReadError && dismissedNotebookRead !== state.activeProfileId ? 'notebookReadFailed' : state?.notebookStorageError ? 'NOTEBOOK_STORAGE_FAILED' : state?.storageReadError ? 'storageReadError' : 'storageError')}</span>{state?.notebookLocked && <button className="text-button" type="button" onClick={() => { void retryNotebookStorage(); }}>{t('retry')}</button>}{(error || state?.notebookReadError && !state.notebookLocked && dismissedNotebookRead !== state.activeProfileId) && iconButton(X, 'close', () => { if (error) setError(''); else if (state) setDismissedNotebookRead(state.activeProfileId); })}</div>}
      <div className={`loading-line${active?.loading ? ' loading' : ''}`} aria-hidden="true" />
    </header>
    {notebookMode === 'capture' && state && <CaptureOverlay state={state} language={language} header={headerRef} onClose={closeNotebooks} onSave={saveNotebookCapture} onRetryStorage={retryNotebookStorage} />}
    {(notebookMode === 'list' || notebookMode === 'new') && state && <NotebookPicker state={state} language={language} opener={notebookOpener} newFirst={notebookMode === 'new'} onClose={closeNotebooks} onChoose={notebook => openNotebook(notebook.id)} />}
    {shieldOpen && site && active && state && <ShieldPopover key={siteScope} site={site} counts={active.blocked} ready={state.blockingReady} blockAds={state.blockAds} darkPages={state.darkPages} language={language} favicon={siteFavicon} initial={siteInitial} opener={shieldButtonRef} onDismiss={reason => closeShield(reason === 'escape')} onTabOut={backward => { closeShield(backward); if (!backward) addressRef.current?.focus(); }} run={run} />}
    {permissionOpen && permissionPrompt && <PermissionDialog key={`${siteScope}:${permissionPrompt.id}`} prompt={permissionPrompt} language={language} favicon={siteFavicon} initial={siteInitial} onAnswer={answerPermission} />}
    {profileOpen === 'menu' && state && <ProfilesMenu state={state} language={language} keyboard={profileByKeyboard.current} opener={profileButtonRef} onDismiss={reason => { setProfileOpen(null); if (reason === 'escape') profileButtonRef.current?.focus(); }} onSwitch={profile => {
      setProfileOpen(null); profileButtonRef.current?.focus();
      void run({ type: 'switch-profile', id: profile.id }).then(success => { if (success) { setAnnouncement(t('switchedProfile').replace('{name}', profile.name)); profileButtonRef.current?.focus(); } });
    }} onNew={() => setProfileOpen('new')} onManage={() => openSettings('profiles')} />}
    {profileOpen === 'new' && state && <NewProfilePopover state={state} language={language} opener={profileButtonRef} onCancel={() => { setProfileOpen(null); profileButtonRef.current?.focus(); }} onSuccess={name => { setProfileOpen(null); setAnnouncement(t('createdProfile').replace('{name}', name)); profileButtonRef.current?.focus(); }} />}
    {menuOpen && <Menu id="browser-menu" label={t('menu')} keyboard={menuByKeyboard.current} opener={menuButtonRef} onDismiss={reason => { setMenuOpen(false); if (reason === 'escape') menuButtonRef.current?.focus(); }}>
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => { setMenuOpen(false); shortcut('new-tab'); }}><Plus aria-hidden="true" /><span>{t('newTab')}</span><kbd>Ctrl+T</kbd></button>
      <hr />
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => openPanel('history')}><History aria-hidden="true" /><span>{t('history')}</span><kbd>Ctrl+H</kbd></button>
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => openPanel('bookmarks')}><Star aria-hidden="true" /><span>{t('bookmarks')}</span></button>
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => openPanel('downloads')}><Download aria-hidden="true" /><span>{t('downloads')}</span><kbd>Ctrl+J</kbd></button>
      <hr />
      <button type="button" role="menuitem" tabIndex={-1} disabled={!activeUrl || Boolean(active?.notebook) || Boolean(active?.settings) || Boolean(active?.error)} onClick={() => { setMenuOpen(false); shortcut('find'); }}><Search aria-hidden="true" /><span>{t('find')}</span><kbd>Ctrl+F</kbd></button>
      <hr />
      <div className="menu-theme" role="group" aria-label={t('theme')}><span>{t('theme')}</span><div className="segmented">{(['system', 'amber', 'daylight'] as const).map(value => <button type="button" role="menuitemradio" tabIndex={-1} key={value} aria-checked={(state?.theme ?? window.horizon.initialTheme) === value} onClick={() => { void run({ type: 'theme', value }); }}>{t(value)}</button>)}</div></div>
      <div className="menu-theme" role="group" aria-label={t('darkPages')}><span>{t('darkPages')}</span><div className="segmented">{(['off', 'on', 'system'] as const).map(value => <button type="button" role="menuitemradio" tabIndex={-1} key={value} aria-checked={(state?.darkPages.mode ?? 'off') === value} onClick={() => { void run({ type: 'dark-pages', value }); }}>{t(value)}</button>)}</div></div>
      {(state?.darkPages.mode ?? 'off') !== 'off' && <>
        <div className="menu-theme" role="group" aria-label={t('darkStrength')}><span>{t('darkStrength')}</span><div className="segmented">{(['soft', 'standard', 'deep'] as const).map(value => <button type="button" role="menuitemradio" tabIndex={-1} key={value} aria-checked={state?.darkPages.strength === value} onClick={() => { void run({ type: 'dark-strength', value }); }}>{t(value)}</button>)}</div></div>
        <div className="menu-theme" role="group" aria-label={t('darkTone')}><span>{t('darkTone')}</span><div className="segmented">{(['neutral', 'warm'] as const).map(value => <button type="button" role="menuitemradio" tabIndex={-1} key={value} aria-checked={state?.darkPages.tone === value} onClick={() => { void run({ type: 'dark-tone', value }); }}>{t(value)}</button>)}</div></div>
      </>}
      <div className="menu-contrast"><span id="contrast-label">{t('highContrast')}</span><Switch labelledBy="contrast-label" tabIndex={-1} checked={(state?.contrast ?? window.horizon.initialContrast) === 'high'} onChange={checked => { void run({ type: 'contrast', value: checked ? 'high' : 'standard' }); }} /></div>
      <hr role="separator" />
      <button type="button" role="menuitem" tabIndex={-1} onClick={() => openSettings('general')}><Settings2 aria-hidden="true" /><span>{t('settings')}</span></button>
    </Menu>}
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
            void run({ type: 'context-menu', id: menuId, item: item.id }).then(success => { if (success) requestAnimationFrame(() => { void run({ type: 'focus-page' }); }); });
          }}><Icon aria-hidden="true" /><span>{label}</span></button>;
        }),
      ])}
    </Menu>}
    <main id="content" className={panel ? 'panel-content' : active?.settings ? 'settings-content-area' : active?.notebook ? 'notebook-content' : activeUrl ? 'web-content' : 'start-content'} tabIndex={-1}>
      {panel ? <section className="library-panel" ref={panelRef} aria-labelledby="panel-title">
        <div className="panel-heading"><h1 id="panel-title">{t(panel)}</h1>{panel === 'history' && (confirmClear ? <div className="clear-confirmation"><span>{t('confirmClearHistory')}</span><button className="text-button" type="button" onClick={() => { void destructive({ type: 'clear-history' }, 'history', 'historyCleared'); }}>{t('clear')}</button><button className="text-button" type="button" onClick={() => setConfirmClear(false)}>{t('cancel')}</button></div> : <button className="text-button" type="button" disabled={!entries.length} onClick={() => setConfirmClear(true)}>{t('clearHistory')}</button>)}{iconButton(X, 'close', () => { openPanel(null); menuButtonRef.current?.focus(); })}</div>
        {undo?.kind === panel && <div className="undo-bar"><span>{t(undo.message)}</span><button className="text-button" type="button" onClick={() => { const kind = undo.kind; dismissUndo(); void run({ type: 'restore', kind }); }}>{t('undo')}</button></div>}
        {panel !== 'downloads' && <div className="search-field panel-search"><Search aria-hidden="true" /><input aria-label={t(panel === 'history' ? 'filterHistory' : 'filterBookmarks')} placeholder={t(panel === 'history' ? 'filterHistory' : 'filterBookmarks')} value={filter} onChange={event => setFilter(event.target.value)} /></div>}
        {panel === 'downloads' ? <ul className="library-list">
          {!state?.store.downloads.length && <EmptyDownloads language={language} onAction={() => { void run({ type: 'open-downloads-folder' }); }} />}
          {state?.store.downloads.map(download => <li key={download.id}>
            <Download aria-hidden="true" /><div className="entry-body"><strong>{download.filename}</strong><p role="status">{t(download.status)}{download.status === 'progressing' && download.total > 0 ? ` ${Math.round(download.received / download.total * 100)}%` : ''}</p><p className="entry-url download-source">{download.url}</p>{download.status === 'progressing' && <progress max={download.total || undefined} value={download.total ? download.received : undefined} aria-label={t('progressing')} />}</div>
            <div className="entry-actions">{download.status === 'progressing' && iconButton(X, 'cancel', () => { void run({ type: 'cancel-download', id: download.id }); })}{iconButton(FolderOpen, 'showFolder', () => { void run({ type: 'show-download', id: download.id }); }, download.status !== 'completed')}{iconButton(Trash2, 'removeDownload', () => { void destructive({ type: 'remove-download', id: download.id }, 'downloads', 'downloadRemoved'); }, download.status === 'progressing')}</div>
          </li>)}
        </ul> : <ul className="library-list">
          {!filteredEntries.length && (filter ? <NoResults language={language} onAction={() => { setFilter(''); panelRef.current?.querySelector<HTMLInputElement>('input')?.focus(); }} /> : panel === 'history' ? <EmptyHistory language={language} onAction={focusAddress} /> : <EmptyBookmarks language={language} onAction={focusAddress} />)}
          {filteredEntries.map(item => <li key={item.url}><div className="entry-body">
            <a className="entry-link" href={item.url} onClick={event => { event.preventDefault(); if (event.ctrlKey) void run({ type: 'new-tab', input: item.url, background: true }); else navigate(item.url); }} onAuxClick={event => { event.preventDefault(); if (event.button === 1) void run({ type: 'new-tab', input: item.url, background: true }); }}>{item.title || item.url}</a><p className="entry-url">{item.url}</p>
            {'lastVisit' in item && <time dateTime={new Date(item.lastVisit).toISOString()}>{new Date(item.lastVisit).toLocaleString(language)}</time>}
            {renameUrl === item.url && <form className="rename-form" onSubmit={event => { event.preventDefault(); if (renameTitle.trim()) { void run({ type: 'rename-bookmark', url: item.url, title: renameTitle }).then(success => { if (success) { setRenameUrl(''); setAnnouncement(t('bookmarkRenamed')); } }); } }}><input autoFocus aria-label={t('bookmarkName')} value={renameTitle} maxLength={1024} onChange={event => setRenameTitle(event.target.value)} /><button className="text-button" type="submit" disabled={!renameTitle.trim()}>{t('save')}</button><button className="text-button" type="button" onClick={() => setRenameUrl('')}>{t('cancel')}</button></form>}
          </div><div className="entry-actions">{panel === 'bookmarks' && <button className="text-button" type="button" onClick={() => { setAnnouncement(''); setRenameUrl(item.url); setRenameTitle(item.title); }}>{t('rename')}</button>}{iconButton(Trash2, 'delete', () => { void destructive({ type: panel === 'history' ? 'delete-history' : 'delete-bookmark', url: item.url }, panel, panel === 'history' ? 'entryDeleted' : 'bookmarkDeleted'); })}</div></li>)}
        </ul>}
      </section> : active?.settings && state ? <Settings key={state.activeProfileId} state={state} section={active.settings} language={language} onOpen={openSettings} /> : active?.notebook && state ? <NotebookView key={`${state.activeProfileId}:${active.notebook}`} id={active.notebook} selected={active.notebookItem} version={state.notebooksVersion} language={language} edits={edits} readOnly={notebookLeaving} locked={state.notebookLocked} run={run} onOpen={openNotebook} onDelete={deleteNotebookEntry} /> : active?.error && failure ? <section className="error-page" role="alert"><ErrorIcon aria-hidden="true" /><h1>{t(failure.heading)}</h1><p>{t(failure.sentence)}</p><div className="error-details"><p>{active.url}</p><p>{active.error}</p></div><button className="text-button" type="button" onClick={() => { void run({ type: 'reload' }); }}>{t('retry')}</button></section> : activeUrl ? (snapshot && <img className={`web-snapshot${active?.fullscreen ? ' fullscreen-snapshot' : ''}`} ref={snapshotRef} src={snapshot.url} alt="" aria-hidden="true" />) : !state ? <p role="status">{t('loading')}</p> : <div className="start-page">
        <div className="start-sky"><div className="start-browsing">
          <h1>{t('product')}</h1>
          <form className="search-field start-search" onSubmit={event => { event.preventDefault(); navigate(startSearch); }}><Search aria-hidden="true" /><input spellCheck={false} autoComplete="off" aria-label={t('search')} placeholder={t('search')} value={startSearch} maxLength={8192} onChange={event => setStartSearch(event.target.value)} /><Sparkles className="accent" aria-hidden="true" /></form>
          <nav className="shortcuts" aria-label={t('shortcuts')}>{(Object.keys(sites) as (keyof typeof sites)[]).map(key => <a href={sites[key]} key={key} onClick={event => { event.preventDefault(); if (event.ctrlKey) void run({ type: 'new-tab', input: sites[key], background: true }); else navigate(sites[key]); }} onAuxClick={event => { event.preventDefault(); if (event.button === 1) void run({ type: 'new-tab', input: sites[key], background: true }); }}>{t(key)}</a>)}</nav>
        </div></div>
        <div className="start-ground">
          <div className="horizon-rule" aria-hidden="true" />
          <svg className="horizon-sun" viewBox="0 0 64 32" aria-hidden="true"><path d="M0 32 A32 32 0 0 1 64 32" /></svg>
          <div className="start-research">
            <NotebookHome state={state} language={language} onOpen={openNotebook} onNew={button => { notebookOpener.current = button; setNotebookOverlay({ scope: notebookScope, mode: 'new' }); }} />
            <div className="lyra-preview"><div className="lyra-prompt"><Sparkles className="accent" aria-hidden="true" />{t('askLyra')}</div><p className="preview-notice">{t('unavailable')}</p></div>
          </div>
        </div>
      </div>}
    </main>
    {suggestionsOpen && createPortal(<div className="suggestions" aria-label={t('suggestions')}>
      <ul id="address-suggestions" role="listbox" aria-label={t('suggestions')}>
        {suggestions.map((item, index) => <li role="option" id={`suggestion-${index}`} aria-selected={index === suggestionIndex} key={`${item.kind}:${item.url}`} onMouseDown={event => event.preventDefault()} onClick={() => chooseSuggestion(item)}>{item.kind === 'search' ? <Search aria-hidden="true" /> : item.kind === 'bookmark' ? <Star aria-hidden="true" /> : item.kind === 'notebook' ? <NotebookPen aria-hidden="true" /> : <History aria-hidden="true" />}<strong>{item.title}</strong>{item.hint && <small>{item.hint}</small>}</li>)}
      </ul>
    </div>, document.body)}
  </>;
}
