import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { AppWindow, LoaderCircle, ChevronDown, SquareDashed, Type } from 'lucide-react';
import { createPortal } from 'react-dom';
import { text } from './copy';
import type { CopyKey } from './copy';
import type { BrowserState, CaptureRect, Language, ProjectSummary } from './shared/api';
import { CaptureProjectPicker, desktopError } from './Desktop';

export type CaptureKind = 'text' | 'area' | 'page';
const choices = [{ kind: 'text', label: 'captureText', icon: Type }, { kind: 'area', label: 'captureArea', icon: SquareDashed }, { kind: 'page', label: 'capturePage', icon: AppWindow }] as const;
type Point = { x: number; y: number };
const rectangle = (a: Point, b: Point): CaptureRect => ({ x: Math.min(a.x, b.x), y: Math.min(a.y, b.y), width: Math.max(1, Math.abs(b.x - a.x)), height: Math.max(1, Math.abs(b.y - a.y)) });

export function CaptureOverlay({ state, language, header, onClose, onSave, onRetryStorage }: {
  state: BrowserState; language: Language; header: RefObject<HTMLElement | null>; onClose: () => void;
  onSave: (project: ProjectSummary | null, kind: CaptureKind, rect: CaptureRect) => Promise<void>;
  onRetryStorage: () => Promise<void>;
}) {
  const t = (key: CopyKey) => text(key, language);
  const [kind, setKind] = useState<CaptureKind>('area'), [chooser, setChooser] = useState(false), [error, setError] = useState(''), [busy, setBusy] = useState(false);
  const [rect, setRect] = useState<CaptureRect>({ x: 310, y: 262, width: 820, height: 300 });
  const layer = useRef<HTMLDivElement>(null), selection = useRef<HTMLDivElement>(null), save = useRef<HTMLButtonElement>(null), group = useRef<HTMLDivElement>(null);
  const corner = useRef<Point | null>(null), gesture = useRef<{ anchor: Point; start: Point; moved: boolean; hadCorner: boolean } | null>(null), pending = useRef(false);
  const last = useRef<{ project: ProjectSummary | null } | null>(null);
  const [size, setSize] = useState('');
  useLayoutEffect(() => {
    const area = layer.current;
    if (!area) return;
    const position = () => {
      const top = header.current?.getBoundingClientRect().bottom ?? 0;
      area.style.setProperty('top', `${top}px`);
      const bounds = area.getBoundingClientRect();
      setRect(old => ({ x: Math.min(old.x, Math.max(0, bounds.width - old.width)), y: Math.min(old.y, Math.max(0, bounds.height - old.height)), width: Math.min(old.width, bounds.width), height: Math.min(old.height, bounds.height) }));
    };
    position(); const observer = new ResizeObserver(position); if (header.current) observer.observe(header.current);
    window.addEventListener('resize', position);
    return () => { observer.disconnect(); window.removeEventListener('resize', position); };
  }, [header]);
  useLayoutEffect(() => {
    const area = selection.current;
    if (!area) return;
    for (const [name, value] of Object.entries({ left: rect.x, top: rect.y, width: rect.width, height: rect.height })) area.style.setProperty(name, `${value}px`);
  }, [rect, kind]);
  useEffect(() => { group.current?.querySelector<HTMLButtonElement>('[aria-checked=true]')?.focus(); }, []);
  useEffect(() => {
    const timer = window.setTimeout(() => setSize(t('captureSize').replace('{width}', String(Math.round(rect.width))).replace('{height}', String(Math.round(rect.height)))), 150);
    return () => window.clearTimeout(timer);
  }, [rect.width, rect.height, language]); // The size announcement waits for a pause in dragging.
  useEffect(() => {
    const keydown = (event: KeyboardEvent) => {
      if (event.defaultPrevented || chooser) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); onClose(); }
      if (event.key !== 'Tab') return;
      const stops = [...(layer.current?.querySelectorAll<HTMLElement>('button:not(:disabled):not([tabindex="-1"]), [tabindex="0"]') ?? [])];
      if (document.activeElement !== (event.shiftKey ? stops[0] : stops.at(-1))) return;
      event.preventDefault(); (event.shiftKey ? stops.at(-1) : stops[0])?.focus();
    };
    document.addEventListener('keydown', keydown);
    return () => document.removeEventListener('keydown', keydown);
  }, [chooser, onClose]);
  const point = (event: { clientX: number; clientY: number }): Point => {
    const bounds = layer.current!.getBoundingClientRect();
    return { x: Math.max(0, Math.min(event.clientX - bounds.left, bounds.width)), y: Math.max(0, Math.min(event.clientY - bounds.top, bounds.height)) };
  };
  const submit = async (project: ProjectSummary | null) => {
    if (pending.current) return;
    if (state.desktopLocked) { setError(t('DESKTOP_LOCKED')); setChooser(false); return; }
    pending.current = true; setBusy(true); setError(''); setChooser(false); last.current = { project }; save.current?.focus();
    try { await onSave(project, kind, rect); }
    catch (reason) { setError(desktopError(reason, language)); }
    finally { pending.current = false; setBusy(false); }
  };
  return createPortal(<div className="capture-overlay" ref={layer} role="dialog" aria-modal="true" aria-label={t('capturePurpose')} aria-busy={busy} onPointerDown={event => {
    if (kind !== 'area' || chooser || busy || event.button !== 0 || (event.target as HTMLElement).closest('.capture-controls')) return;
    event.preventDefault(); const at = point(event);
    gesture.current = { anchor: corner.current ?? at, start: at, moved: false, hadCorner: Boolean(corner.current) };
    event.currentTarget.setPointerCapture(event.pointerId);
  }} onPointerMove={event => {
    const current = gesture.current; if (!current) return;
    const at = point(event); current.moved ||= Math.hypot(at.x - current.start.x, at.y - current.start.y) > 3;
    if (current.moved || current.hadCorner) setRect(rectangle(current.anchor, at));
  }} onPointerUp={event => {
    const current = gesture.current; if (!current) return;
    const at = point(event); setRect(rectangle(current.anchor, at));
    corner.current = current.moved || current.hadCorner ? null : at;
    gesture.current = null; event.currentTarget.releasePointerCapture(event.pointerId); selection.current?.focus();
  }} onPointerCancel={() => { gesture.current = null; corner.current = null; }}>
    {kind === 'area' && <div className="capture-selection" ref={selection} role="group" tabIndex={0} aria-label={t('captureArea')} aria-describedby="capture-instructions capture-size" onKeyDown={event => {
      if (!['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) return;
      event.preventDefault(); event.stopPropagation(); corner.current = null;
      const bounds = layer.current!.getBoundingClientRect(), step = event.altKey ? 1 : 10, dx = event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, dy = event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0;
      setRect(old => event.shiftKey ? { ...old, width: Math.max(1, Math.min(bounds.width - old.x, old.width + dx)), height: Math.max(1, Math.min(bounds.height - old.y, old.height + dy)) } : { ...old, x: Math.max(0, Math.min(bounds.width - old.width, old.x + dx)), y: Math.max(0, Math.min(bounds.height - old.height, old.y + dy)) });
    }}><svg aria-hidden="true"><rect x="1" y="1" width={Math.max(0, rect.width - 2)} height={Math.max(0, rect.height - 2)} rx="6" strokeDasharray="6 4" /></svg></div>}
    <div className="capture-controls"><div className="capture-bar">
      <div ref={group} className="segmented capture-segmented" role="radiogroup" aria-label={t('captureKind')}>{choices.map((choice, index) => <button key={choice.kind} type="button" role="radio" aria-checked={kind === choice.kind} tabIndex={kind === choice.kind ? 0 : -1} disabled={busy} onClick={() => { setKind(choice.kind); setError(''); }} onKeyDown={event => {
        const next = event.key === 'ArrowRight' || event.key === 'ArrowDown' ? (index + 1) % choices.length : event.key === 'ArrowLeft' || event.key === 'ArrowUp' ? (index + choices.length - 1) % choices.length : event.key === 'Home' ? 0 : event.key === 'End' ? choices.length - 1 : -1;
        if (next < 0) return;
        event.preventDefault(); setKind(choices[next]!.kind); setError(''); group.current?.querySelectorAll<HTMLButtonElement>('button')[next]?.focus();
      }}><choice.icon aria-hidden="true" />{t(choice.label)}</button>)}</div>
      <button ref={save} className="profile-action primary capture-save" type="button" disabled={busy} aria-haspopup="menu" aria-expanded={chooser} onClick={() => { if (state.desktopLocked) setError(t('DESKTOP_LOCKED')); else setChooser(previous => !previous); }}>{busy && <LoaderCircle className="spinner" aria-hidden="true" />}<span>{t('saveTo')}</span><span className="capture-save-chevron"><ChevronDown aria-hidden="true" /></span></button>
      <button className="profile-action quiet" type="button" onClick={onClose}>{t('cancel')}</button>
    </div><div className="capture-guidance">{kind === 'area' && <p id="capture-instructions" className="visually-hidden">{t('captureInstructions')}</p>}<p id="capture-size" className="visually-hidden" role="status" aria-live="polite">{kind === 'area' ? size : kind === 'text' ? t('captureTextHint') : ''}</p>
      {(error || state.desktopLocked || state.desktopStorageError) && <div className="capture-error" role="alert"><span>{error || t(state.desktopLocked ? 'DESKTOP_LOCKED' : 'DESKTOP_STORAGE_FAILED')}</span><button className="text-button" type="button" onClick={() => { if (error && last.current) void submit(last.current.project); else void onRetryStorage(); }}>{t('retry')}</button></div>}
    </div></div>
    {chooser && <CaptureProjectPicker state={state} language={language} opener={save} portalHost={layer} screenshots={kind !== 'text'} onClose={() => { setChooser(false); save.current?.focus(); }} onChoose={submit} />}
  </div>, document.body);
}
