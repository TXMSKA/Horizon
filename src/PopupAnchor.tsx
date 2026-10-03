import { useLayoutEffect, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';

export function PopupAnchor({ opener, children, portalHost }: { opener: RefObject<HTMLElement | null>; children: ReactNode; portalHost?: RefObject<HTMLElement | null> }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const popup = ref.current;
    if (!popup) return;
    const position = () => {
      const trigger = opener.current?.getBoundingClientRect();
      if (!trigger) return;
      const gap = Number.parseFloat(getComputedStyle(popup).getPropertyValue('--toolbar-popup-gap'));
      const { width } = popup.getBoundingClientRect();
      const panel = opener.current?.closest<HTMLElement>('.desktop-panel');
      const area = panel?.getBoundingClientRect(), padding = panel ? Number.parseFloat(getComputedStyle(panel).paddingInlineEnd) : gap;
      const start = area ? area.left + padding : gap, end = area ? area.right - padding : innerWidth - gap;
      // Capture choosers stay inside the panel, clear of the native page view.
      popup.style.setProperty('left', `${Math.max(start, Math.min(trigger.right - width, end - width))}px`);
      popup.style.setProperty('top', `${trigger.bottom + gap}px`);
      popup.style.setProperty('--popup-available-height', `${Math.max(0, innerHeight - trigger.bottom - gap)}px`);
      // Long lists scroll below their opener rather than moving above it.
      popup.style.setProperty('max-height', `${Math.max(0, innerHeight - trigger.bottom - gap)}px`);
    };
    const observer = new ResizeObserver(position);
    observer.observe(popup); if (opener.current) observer.observe(opener.current);
    window.addEventListener('resize', position); window.addEventListener('scroll', position, true); position();
    return () => { observer.disconnect(); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [opener]);
  return createPortal(<div className="popup-anchor" ref={ref}>{children}</div>, portalHost?.current ?? document.body);
}
