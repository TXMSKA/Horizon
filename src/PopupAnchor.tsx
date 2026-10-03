import { useLayoutEffect, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { popupPosition } from './shared/popup-position';

export function PopupAnchor({ opener, children, portalHost, anchor }: { opener: RefObject<HTMLElement | null>; children: ReactNode; portalHost?: RefObject<HTMLElement | null>; anchor?: RefObject<HTMLElement | null> }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const popup = ref.current;
    if (!popup) return;
    const position = () => {
      const trigger = (anchor?.current ?? opener.current)?.getBoundingClientRect();
      if (!trigger) return;
      const gap = Number.parseFloat(getComputedStyle(popup).getPropertyValue('--toolbar-popup-gap'));
      if (anchor?.current) popup.style.setProperty('width', `${trigger.width}px`);
      // Measure without the previous limit so a clipped menu can choose the roomier side.
      popup.style.setProperty('--popup-available-height', 'none');
      popup.style.setProperty('max-height', 'none');
      const { width, height } = popup.getBoundingClientRect();
      const { top, availableHeight } = popupPosition(trigger, innerHeight, height, gap);
      const panel = opener.current?.closest<HTMLElement>('.desktop-panel-body');
      const area = panel?.getBoundingClientRect(), padding = panel ? Number.parseFloat(getComputedStyle(panel).paddingInlineEnd) : gap;
      const start = area ? area.left + padding : gap, end = area ? area.right - padding : innerWidth - gap;
      // Capture choosers stay inside the panel, clear of the native page view.
      popup.style.setProperty('left', `${Math.max(start, Math.min(trigger.right - width, end - width))}px`);
      popup.style.setProperty('top', `${top}px`);
      popup.style.setProperty('--popup-available-height', `${availableHeight}px`);
      popup.style.setProperty('max-height', `${availableHeight}px`);
    };
    const observer = new ResizeObserver(position);
    observer.observe(popup); if (opener.current) observer.observe(opener.current); if (anchor?.current) observer.observe(anchor.current);
    window.addEventListener('resize', position); window.addEventListener('scroll', position, true); position();
    return () => { observer.disconnect(); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [opener, anchor]);
  return createPortal(<div className="popup-anchor" ref={ref}>{children}</div>, portalHost?.current ?? document.body);
}
