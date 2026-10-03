import { useEffect, useRef, useState } from 'react';
import type { DragEvent, ReactNode } from 'react';
import { Link, LoaderCircle } from 'lucide-react';
import { text } from './copy';
import { desktopError } from './Desktop';
import type { BrowserState, Language } from './shared/api';
import type { DesktopEdits } from './shared/desktop-edits';
import { DESKTOP_TAB_DRAG, parseDesktopDrag } from './shared/desktop-drag';
import type { DesktopDragData } from './shared/desktop-drag';

const formats = [DESKTOP_TAB_DRAG, 'text/uri-list', 'text/x-moz-url', 'text/plain'];

export function readDesktopDrag(transfer: Pick<DataTransfer, 'getData'> & { types?: readonly string[] }, state: BrowserState, source: DesktopDragData['source']) {
  const internal = transfer.getData(DESKTOP_TAB_DRAG);
  if (internal) {
    if (internal.length > 512) return null;
    try {
      const value: unknown = JSON.parse(internal);
      if (!value || typeof value !== 'object' || !('profile' in value) || !('tab' in value)
        || Object.keys(value).length !== 2 || value.profile !== state.activeProfileId) return null;
      const tab = state.tabs.find(tab => tab.id === value.tab && !tab.desktop && !tab.settings);
      return tab ? parseDesktopDrag({ tab: { url: tab.url, title: tab.title } }) : null;
    } catch { return null; }
  }
  if (transfer.types?.includes('Files') && !transfer.types.some(type => type === 'text/uri-list' || type === 'text/x-moz-url')) return null;
  return parseDesktopDrag({ text: transfer.getData('text/plain'), uriList: transfer.getData('text/uri-list'), mozURL: transfer.getData('text/x-moz-url'), source, selection: transfer.types?.includes('text/html') });
}

type DropProps = {
  state: BrowserState; language: Language; edits: DesktopEdits; readOnly: boolean;
  onDropped: (project: string, item: string) => void;
};
export function DesktopDrop({ props, project, folder = null, children, className = 'desktop-drop', onKept, transientName }: {
  props: DropProps; project: string; folder?: string | null; children?: ReactNode; className?: string;
  onKept?: () => void; transientName?: string;
}) {
  const { state, language, edits, onDropped } = props;
  const [over, setOver] = useState(false), [busy, setBusy] = useState(false), [error, setError] = useState('');
  const pending = useRef(false), generation = useRef(0), origin = useRef<DesktopDragData['source']>(null);
  const disabled = state.desktopLocked || props.readOnly || busy;
  useEffect(() => { if (disabled) { setOver(false); origin.current = null; } }, [disabled]);
  useEffect(() => {
    generation.current++; setOver(false); setBusy(false); setError(''); origin.current = null;
    return () => { generation.current++; };
  }, [state.activeProfileId, project, folder]);
  const enter = (event: DragEvent<HTMLDivElement>) => {
    event.stopPropagation();
    const types = event.dataTransfer.types;
    const fileOnly = types.includes('Files') && !types.some(type => type === DESKTOP_TAB_DRAG || type === 'text/uri-list' || type === 'text/x-moz-url');
    if (disabled || fileOnly || !formats.some(format => types.includes(format))) { event.dataTransfer.dropEffect = 'none'; setOver(false); return; }
    // During dragover Chromium protects the values. Types advertise a candidate;
    // only drop makes the payload readable and can authorize a save.
    event.preventDefault(); event.dataTransfer.dropEffect = 'copy'; setOver(true);
    const active = state.tabs.find(tab => tab.id === state.activeId);
    if (!origin.current && active && !active.desktop && !active.settings) origin.current = { url: active.url, title: active.title };
  };
  const drop = (event: DragEvent<HTMLDivElement>) => {
    event.preventDefault(); event.stopPropagation(); setOver(false);
    const item = readDesktopDrag(event.dataTransfer, state, origin.current);
    origin.current = null;
    if (disabled || pending.current || !item) return;
    const turn = generation.current, profile = state.activeProfileId;
    pending.current = true; setBusy(true); setError('');
    void (async () => {
      try {
        await edits.flush();
        const current = await window.horizon.getState();
        if (generation.current !== turn || current.activeProfileId !== profile) return;
        const before = await window.horizon.getProject(project);
        if (generation.current !== turn) return;
        await window.horizon.command(item.kind === 'link'
          ? { type: 'add-link', project, folder, address: item.address, title: item.title }
          : { type: 'add-text', project, folder, text: item.text, source: item.source });
        const next = await window.horizon.getProject(project);
        const added = next.items.find(item => !before.items.some(previous => previous.id === item.id));
        // The first item replaces an empty target with the project list. Keep
        // its feedback even if that target has unmounted after the save.
        if (added) { onDropped(project, added.id); if (generation.current === turn) onKept?.(); }
      } catch (reason) { if (generation.current === turn) setError(desktopError(reason, language)); }
      finally { pending.current = false; if (generation.current === turn) setBusy(false); }
    })();
  };
  return <><div className={`${className}${over ? ' drag-over' : ''}`} aria-label={text('desktopDropHint', language)} aria-busy={busy}
    onDragEnter={enter} onDragOver={enter} onDrop={drop} onDragLeave={event => {
      if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setOver(false); origin.current = null; }
    }}>
    {children}{transientName ? over && <div className="desktop-project-foot"><small>{text('desktopDropInto', language).replace('{name}', transientName)}</small><div className="desktop-drop drag-over"><Link aria-hidden="true" /><p>{text('desktopDropRelease', language)}</p></div></div> : !children && <><Link aria-hidden="true" /><p>{text(over ? 'desktopDropRelease' : 'desktopDropHint', language)}</p></>}
  </div><div className="desktop-drop-status" role="status" aria-live="polite">{busy && <><LoaderCircle className="spinner" aria-hidden="true" />{text('desktopDropSaving', language)}</>}</div>
    {error && <p className="desktop-error" role="alert">{error}</p>}
  </>;
}
