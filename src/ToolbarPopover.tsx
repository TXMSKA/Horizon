import { useLayoutEffect, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';
import { createPortal } from 'react-dom';

export function ToolbarPopover({ opener, children, className = '', within }: {
  opener: RefObject<HTMLElement | null>; children: ReactNode; className?: string; within?: RefObject<HTMLElement | null>;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const popup = ref.current;
    if (!popup) return;
    const position = () => {
      const trigger = opener.current?.getBoundingClientRect();
      if (!trigger) return;
      const style = getComputedStyle(popup), gap = Number.parseFloat(style.getPropertyValue('--toolbar-popup-gap'));
      const edge = Number.parseFloat(style.getPropertyValue('--toolbar-popup-edge'));
      const { width } = popup.getBoundingClientRect();
      // A popover opened inside a panel stays within the panel's padding instead of hanging past its edge.
      const area = within?.current?.getBoundingClientRect(), inset = Number.parseFloat(style.getPropertyValue('--toolbar-popup-inset'));
      const start = area ? area.left + inset : edge, end = area ? area.right - inset : innerWidth - edge;
      // CSSOM positioning also works under chrome's strict style CSP.
      popup.style.setProperty('left', `${Math.max(start, Math.min(trigger.right - width, end - width))}px`);
      popup.style.setProperty('top', `${trigger.bottom + gap}px`);
      popup.style.setProperty('--popup-available-height', `${Math.max(0, innerHeight - trigger.bottom - gap - edge)}px`);
    };
    const observer = new ResizeObserver(position);
    observer.observe(popup); if (opener.current) observer.observe(opener.current);
    window.addEventListener('resize', position); window.addEventListener('scroll', position, true); position();
    return () => { observer.disconnect(); window.removeEventListener('resize', position); window.removeEventListener('scroll', position, true); };
  }, [opener, within]);
  return createPortal(<div className={`toolbar-popover ${className}`} ref={ref}>{children}</div>, document.body);
}
