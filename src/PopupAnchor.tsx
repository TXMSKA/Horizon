import { useLayoutEffect, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';
import { popupPosition } from './shared/popup-position';

export function PopupAnchor({ opener, children, portalHost, anchor, widthAnchor, gap: requestedGap, align = 'end', beside = false, besideAnchor, besideInset = 0 }: { opener: RefObject<HTMLElement | null>; children: ReactNode; portalHost?: RefObject<HTMLElement | null>; anchor?: RefObject<HTMLElement | null>; gap?: number; widthAnchor?: RefObject<HTMLElement | null>; align?: 'start' | 'end'; beside?: boolean; besideAnchor?: RefObject<HTMLElement | null>; besideInset?: number }) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const popup = ref.current;
    if (!popup) return;
    const position = () => {
      const trigger = (anchor?.current ?? opener.current)?.getBoundingClientRect();
      if (!trigger) return;
      const gap = requestedGap ?? Number.parseFloat(getComputedStyle(popup).getPropertyValue('--toolbar-popup-gap'));
      if (anchor?.current) popup.style.setProperty('width', `${(widthAnchor?.current?.getBoundingClientRect() ?? trigger).width}px`);
      // Measure without the previous limit so a clipped menu can choose the roomier side.
      popup.style.setProperty('--popup-available-height', 'none');
      popup.style.setProperty('max-height', 'none');
      const { width, height } = popup.getBoundingClientRect();
      const { top, availableHeight } = beside ? { top: Math.max(gap, Math.min(trigger.top - besideInset, innerHeight - height - gap)), availableHeight: innerHeight - gap * 2 } : popupPosition(trigger, innerHeight, height, gap);
      const panel = opener.current?.closest<HTMLElement>('.desktop-panel-body');
      const area = panel?.getBoundingClientRect(), padding = panel ? Number.parseFloat(getComputedStyle(panel).paddingInlineEnd) : gap;
      const start = area ? area.left + padding : gap, end = area ? area.right - padding : innerWidth - gap;
      // Capture choosers stay inside the panel, clear of the native page view.
      const horizontal = besideAnchor?.current?.getBoundingClientRect() ?? trigger;
      const left = beside ? horizontal.right + gap + width <= end ? horizontal.right + gap : horizontal.left - gap - width : align === 'start' ? trigger.left : trigger.right - width;
      popup.style.setProperty('left', `${Math.max(start, Math.min(left, end - width))}px`);
      popup.style.setProperty('top', `${top}px`);
      popup.style.setProperty('--popup-available-height', `${availableHeight}px`);
      popup.style.setProperty('max-height', `${availableHeight}px`);
    };
    const observer = new ResizeObserver(position);
    observer.observe(popup); if (opener.current) observer.observe(opener.current); if (anchor?.current) observer.observe(anchor.current); if (widthAnchor?.current) observer.observe(widthAnchor.current); if (besideAnchor?.current) observer.observe(besideAnchor.current);
    window.addEventListener('resize', position); window.addEventListener('scroll', position, true); position();
    return () => { observer.disconnect(); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [opener, anchor, widthAnchor, requestedGap, align, beside, besideAnchor, besideInset]);
  return createPortal(<div className="popup-anchor" ref={ref}>{children}</div>, portalHost?.current ?? document.body);
}
