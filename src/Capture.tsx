import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { KeyboardEvent, RefObject } from 'react';
import { AppWindow, ChevronDown, Copy, Crop } from 'lucide-react';
import { createPortal } from 'react-dom';
import { text } from './copy';
import type { CopyKey } from './copy';
import type { BrowserState, CaptureRect, CaptureShot, Language, ProjectSummary } from './shared/api';
import { CaptureProjectPicker, desktopError } from './Desktop';
import { popupPosition } from './shared/popup-position';

type Point = { x: number; y: number };
export function CapturePreview({ state, language, shot, header, opener, onClose, onSave, onVisible, onShot }: {
  state: BrowserState; language: Language; shot: CaptureShot | null; header: RefObject<HTMLElement | null>; opener: RefObject<HTMLElement | null>;
  onClose: () => void; onSave: (project: ProjectSummary) => Promise<void>; onVisible: (work: () => Promise<CaptureShot>) => Promise<CaptureShot>; onShot: (shot: CaptureShot) => void;
}) {
  const t = (key: CopyKey) => text(key, language);
  const [editor, setEditor] = useState(false), [full, setFull] = useState(false), [chooser, setChooser] = useState(false);
  const [rect, setRect] = useState<CaptureRect | null>(null), [url, setUrl] = useState(''), [busy, setBusy] = useState(false), [error, setError] = useState(''), [copied, setCopied] = useState('');
  const pending = useRef(false), card = useRef<HTMLDivElement>(null), canvas = useRef<HTMLDivElement>(null), image = useRef<HTMLImageElement>(null), selection = useRef<HTMLDivElement>(null);
  const split = useRef<HTMLDivElement>(null), chevron = useRef<HTMLButtonElement>(null), bar = useRef<HTMLDivElement>(null), retry = useRef<(() => Promise<void>) | null>(null);
  const editorRequest = useRef(0), cropRect = useRef<CaptureRect | null>(null); cropRect.current = rect;
  const gesture = useRef<{ point: Point; rect: CaptureRect; handle: number | null } | null>(null);
  const project = state.projects.find(project => project.id === state.projectInUse);
  useEffect(() => {
    if (!shot) return;
    const blob = URL.createObjectURL(new Blob([new Uint8Array(shot.bytes)], { type: 'image/png' })); setUrl(blob);
    return () => URL.revokeObjectURL(blob);
  }, [shot]);
  useEffect(() => { if (!copied) return; const timer = window.setTimeout(() => setCopied(''), 2000); return () => window.clearTimeout(timer); }, [copied]);
  useLayoutEffect(() => {
    const page = document.getElementById('content');
    const position = () => {
      const top = header.current?.getBoundingClientRect().bottom ?? 0;
      if (canvas.current) {
        const bounds = page?.getBoundingClientRect();
        canvas.current.style.setProperty('top', `${bounds?.top ?? top}px`);
        canvas.current.style.setProperty('left', `${bounds?.left ?? 0}px`);
        canvas.current.style.setProperty('width', `${bounds?.width ?? innerWidth}px`);
        canvas.current.style.setProperty('height', `${bounds?.height ?? innerHeight - top}px`);
      }
      if (card.current) {
        const bounds = card.current.getBoundingClientRect(), trigger = opener.current?.getBoundingClientRect();
        const { top: y, availableHeight } = popupPosition({ top, bottom: top }, innerHeight, bounds.height, 6);
        card.current.style.setProperty('left', `${Math.max(6, Math.min((trigger?.right ?? innerWidth - 12) - bounds.width, innerWidth - bounds.width - 6))}px`);
        card.current.style.setProperty('top', `${y}px`); card.current.style.setProperty('max-height', `${availableHeight}px`);
      }
    };
    position(); const observer = new ResizeObserver(position); if (header.current) observer.observe(header.current); if (card.current) observer.observe(card.current); if (page) observer.observe(page);
    window.addEventListener('resize', position); return () => { observer.disconnect(); window.removeEventListener('resize', position); };
  }, [header, opener, editor, shot]);
  useLayoutEffect(() => {
    const position = () => {
      const target = selection.current, img = image.current, area = canvas.current;
      if (!img || !area || !shot) return;
      const parent = area.getBoundingClientRect();
      const availableWidth = parent.width, availableHeight = full ? Math.max(1, parent.height - 120) : parent.height;
      // The screenshot is in device pixels; drawn at the page's width it lands exactly where the page was.
      const scale = full ? Math.min(availableWidth / shot.width, availableHeight / shot.height) : availableWidth / shot.width;
      const width = shot.width * scale, height = shot.height * scale;
      const left = full ? (parent.width - width) / 2 : 0, top = full ? 100 : 0;
      for (const [key, value] of Object.entries({ left, top, width, height })) img.style.setProperty(key, `${value}px`);
      for (const [key, value] of Object.entries({ left, top, width, height })) area.style.setProperty(`--crop-${key}`, `${value}px`);
      if (target && rect) for (const [key, value] of Object.entries({ left: left + rect.x * scale, top: top + rect.y * scale, width: rect.width * scale, height: rect.height * scale })) target.style.setProperty(key, `${value}px`);
    };
    position(); const observer = new ResizeObserver(position); if (canvas.current) observer.observe(canvas.current);
    window.addEventListener('resize', position); return () => { observer.disconnect(); window.removeEventListener('resize', position); };
  }, [shot, rect, editor, full]);
  useEffect(() => { (editor ? bar.current?.querySelector<HTMLButtonElement>('button') : card.current)?.focus(); }, [editor]);
  useEffect(() => {
    const outside = (event: PointerEvent) => {
      const target = event.target as HTMLElement;
      if (editor || target.closest('[data-capture-popover]') || opener.current?.contains(target)) return;
      onClose();
    };
    document.addEventListener('pointerdown', outside); return () => document.removeEventListener('pointerdown', outside);
  }, [editor, onClose, opener]);
  const work = async (action: () => Promise<void>) => {
    if (pending.current) return;
    pending.current = true; setBusy(true); setError(''); retry.current = action;
    try { await action(); } catch (reason) { setError(desktopError(reason, language)); }
    finally { pending.current = false; setBusy(false); }
  };
  const changeKind = (page: boolean) => work(async () => {
    if (!shot) return;
    const request = ++editorRequest.current;
    const next = page ? await onVisible(() => window.horizon.command({ type: 'capture-full-page', id: shot.id })) : await window.horizon.command({ type: 'capture-screen', id: shot.id });
    onShot(next); setRect(null); setFull(page); if (editorRequest.current === request) setEditor(true);
  });
  const apply = async (copy = false) => {
    if (!shot) return;
    const current = cropRect.current;
    if (current || copy) { const next = await window.horizon.command({ type: copy ? 'copy-capture' : 'edit-capture', id: shot.id, ...(current ? { rect: current } : {}) }); onShot(next); cropRect.current = null; setRect(null); }
  };
  const save = (destination: ProjectSummary) => work(async () => { await apply(); await onSave(destination); });
  const splitButton = <div className="capture-split" ref={split}>
    <button className="capture-save-main" type="button" disabled={busy || !shot} onClick={() => { if (project) void save(project); else setChooser(true); }}>{project ? t('saveToProject').replace('{name}', project.name) : t('saveToAProject')}</button>
    <span aria-hidden="true" /><button ref={chevron} type="button" disabled={busy || !shot} aria-label={t('chooseProject')} aria-haspopup="dialog" aria-expanded={chooser} onClick={() => setChooser(previous => !previous)}><ChevronDown aria-hidden="true" /></button>
  </div>;
  const adjust = (start: CaptureRect, handle: number | null, dx: number, dy: number): CaptureRect => {
    if (!shot) return start;
    if (handle === null) return { ...start, x: Math.max(0, Math.min(shot.width - start.width, start.x + dx)), y: Math.max(0, Math.min(shot.height - start.height, start.y + dy)) };
    let left = start.x, right = start.x + start.width, top = start.y, bottom = start.y + start.height;
    if (handle % 2 === 0) left = Math.max(0, Math.min(right - 8, left + dx)); else right = Math.min(shot.width, Math.max(left + 8, right + dx));
    if (handle < 2) top = Math.max(0, Math.min(bottom - 8, top + dy)); else bottom = Math.min(shot.height, Math.max(top + 8, bottom + dy));
    return { x: left, y: top, width: right - left, height: bottom - top };
  };
  const crop = () => { if (!shot) return; setEditor(true); setRect({ x: Math.floor(shot.width * 310 / 1440), y: Math.floor(shot.height * 239 / 770), width: Math.min(shot.width, Math.max(8, Math.floor(shot.width * 820 / 1440))), height: Math.min(shot.height, Math.max(8, Math.floor(shot.height * 329 / 770))) }); };
  const cancel = () => { editorRequest.current++; setChooser(false); setEditor(false); };
  const key = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); if (chooser) { setChooser(false); chevron.current?.focus(); } else if (editor) cancel(); else onClose(); } };
  const feedback = <>{error && <div className="capture-feedback" role="alert"><span>{error}</span><button className="desktop-small-link" type="button" disabled={busy} onClick={() => { if (retry.current) void work(retry.current); }}>{t('retry')}</button></div>}<span className="capture-copy-status" role="status" aria-live="polite">{copied}</span></>;
  return createPortal(<>
    {editor ? <div key="editor" ref={canvas} className={`capture-canvas${full ? ' full-page' : ''}`} role="dialog" aria-label={t('captureEditor')} aria-busy={busy} onKeyDown={key}>
      <img ref={image} className="capture-frozen" src={url} alt={t('capturePurpose')} />
      {rect && shot && <><svg className="capture-mask" viewBox={`0 0 ${shot.width} ${shot.height}`} preserveAspectRatio="none" aria-hidden="true"><path fillRule="evenodd" d={`M0 0H${shot.width}V${shot.height}H0Z M${rect.x} ${rect.y}h${rect.width}v${rect.height}h-${rect.width}Z`} /></svg>
        <div className="capture-rectangle" ref={selection} role="group" tabIndex={0} aria-label={t('captureCrop')} aria-describedby="crop-instructions" onPointerDown={event => {
          if (busy || event.button !== 0) return; event.preventDefault(); event.stopPropagation();
          const handle = (event.target as HTMLElement).dataset.corner;
          gesture.current = { point: { x: event.clientX, y: event.clientY }, rect, handle: handle === undefined ? null : Number(handle) }; event.currentTarget.setPointerCapture(event.pointerId);
          (event.target as HTMLElement).focus();
        }} onPointerMove={event => {
          const drag = gesture.current, bounds = image.current?.getBoundingClientRect(); if (!drag || !bounds) return;
          setRect(adjust(drag.rect, drag.handle, Math.round((event.clientX - drag.point.x) * shot.width / bounds.width), Math.round((event.clientY - drag.point.y) * shot.height / bounds.height)));
        }} onPointerUp={event => { gesture.current = null; event.currentTarget.releasePointerCapture(event.pointerId); }} onPointerCancel={() => { gesture.current = null; }} onKeyDown={event => {
          if (!event.key.startsWith('Arrow') || busy) return; event.preventDefault(); event.stopPropagation(); const step = event.shiftKey ? 10 : 1, handle = (event.target as HTMLElement).dataset.corner;
          setRect(adjust(rect, handle === undefined ? null : Number(handle), event.key === 'ArrowLeft' ? -step : event.key === 'ArrowRight' ? step : 0, event.key === 'ArrowUp' ? -step : event.key === 'ArrowDown' ? step : 0));
        }}>{[0, 1, 2, 3].map(corner => <button key={corner} type="button" className={`capture-corner corner-${corner}`} data-corner={corner} aria-label={t('captureCorner').replace('{number}', String(corner + 1))} disabled={busy} />)}</div><p id="crop-instructions" className="visually-hidden">{t('captureInstructions')}</p></>}
      <div className="capture-editor-bar" ref={bar} data-capture-popover><div className="segmented" role="radiogroup" aria-label={t('captureKind')}>{[false, true].map(page => <button key={String(page)} type="button" role="radio" aria-checked={full === page} tabIndex={full === page ? 0 : -1} disabled={busy} onClick={() => { if (full !== page) void changeKind(page); }} onKeyDown={event => { if (['ArrowLeft', 'ArrowRight', 'Home', 'End'].includes(event.key)) { event.preventDefault(); const next = event.key === 'Home' ? false : event.key === 'End' ? true : !full; if (next !== full) void changeKind(next).then(() => requestAnimationFrame(() => bar.current?.querySelector<HTMLButtonElement>('[aria-checked=true]')?.focus())); } }}>{t(page ? 'capturePage' : 'captureScreen')}</button>)}</div><button className="desktop-action capture-cancel" type="button" disabled={busy} onClick={cancel}>{t('cancel')}</button>{splitButton}</div><div className="capture-editor-feedback">{feedback}</div>
    </div> : <div key="preview" className="capture-preview" ref={card} data-capture-popover role="dialog" aria-modal="false" aria-label={t('capturePreview')} tabIndex={-1} aria-busy={busy || !shot} onKeyDown={key}>
      {shot && url ? <svg className="capture-thumbnail" viewBox={rect ? `${rect.x} ${rect.y} ${rect.width} ${rect.height}` : `0 0 ${shot.width} ${shot.height}`} role="img" aria-label={t('capturePurpose')}><image href={url} width={shot.width} height={shot.height} /></svg> : <div className="capture-thumbnail desktop-skeleton" role="status"><span className="visually-hidden">{t('loading')}</span></div>}
      <div className="capture-actions">{[{ key: 'captureCrop', icon: Crop, action: crop }, { key: 'capturePage', icon: AppWindow, action: () => { void changeKind(true); } }, { key: 'copy', icon: Copy, action: () => { void work(async () => { await apply(true); setCopied(t('copied')); }); } }].map(({ key, icon: Icon, action }) => <div key={key}><button type="button" disabled={busy || !shot} aria-label={t(key as CopyKey)} onClick={action}><Icon aria-hidden="true" /></button><span>{t(key as CopyKey)}</span></div>)}</div>
      <small>{t('keptInCaptures')}</small><hr />{splitButton}{feedback}
    </div>}
    {chooser && <CaptureProjectPicker state={state} language={language} opener={chevron} anchor={editor ? bar : card} widthAnchor={editor ? split : undefined} busy={busy} onClose={() => setChooser(false)} onChoose={save} />}
  </>, document.body);
}
