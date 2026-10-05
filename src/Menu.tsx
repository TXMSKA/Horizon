import { useEffect, useLayoutEffect, useRef } from 'react';
import type { ReactNode, RefObject } from 'react';

export function Menu({ id, label, keyboard, point, opener, onDismiss, children, className = '', initialFocus, describedBy }: {
  className?: string; initialFocus?: string; id: string; label: string; keyboard: boolean; point?: { x: number; y: number };
  opener?: RefObject<HTMLElement | null>; onDismiss: (reason: 'escape' | 'tab' | 'outside') => void; children: ReactNode; describedBy?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const dismiss = useRef(onDismiss);
  useLayoutEffect(() => { dismiss.current = onDismiss; });
  useLayoutEffect(() => {
    const menu = ref.current;
    if (!menu || !point) return;
    const position = () => {
      const { width, height } = menu.getBoundingClientRect();
      const x = point.x + width > innerWidth ? point.x - width : point.x;
      const y = point.y + height > innerHeight ? point.y - height : point.y;
      // CSSOM assignments keep the strict chrome CSP intact.
      menu.style.setProperty('left', `${Math.max(0, Math.min(x, innerWidth - width))}px`);
      menu.style.setProperty('top', `${Math.max(0, Math.min(y, innerHeight - height))}px`);
    };
    position();
    const observer = new ResizeObserver(position);
    observer.observe(menu); window.addEventListener('resize', position);
    return () => { observer.disconnect(); window.removeEventListener('resize', position); };
  }, [point?.x, point?.y, point]);
  useEffect(() => {
    const menu = ref.current;
    const first = menu?.querySelector<HTMLButtonElement>('[role^=menuitem]:not(:disabled), [role=switch]:not(:disabled)');
    (keyboard ? (initialFocus ? menu?.querySelector<HTMLElement>(initialFocus) : null) ?? first ?? menu : menu)?.focus();
  }, [id, keyboard, initialFocus]);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      const target = event.target as Node;
      if (!ref.current?.contains(target) && !opener?.current?.contains(target)) dismiss.current('outside');
    };
    document.addEventListener('pointerdown', close);
    return () => document.removeEventListener('pointerdown', close);
  }, [opener]);
  return <div id={id} className={`browser-menu${point ? ' page-context-menu' : ''} ${className}`} ref={ref} role="menu" tabIndex={-1} aria-label={label} aria-describedby={describedBy} onKeyDown={event => {
    if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); dismiss.current('escape'); return; }
    if ((event.target as HTMLElement)?.tagName === 'INPUT' && !['ArrowDown', 'ArrowUp', 'Tab'].includes(event.key)) return;
    if (event.key === 'Tab') { dismiss.current('tab'); return; }
    const items = [...(ref.current?.querySelectorAll<HTMLButtonElement>('[role^=menuitem]:not(:disabled), [role=switch]:not(:disabled)') ?? [])];
    const index = items.indexOf(document.activeElement as HTMLButtonElement);
    if (['ArrowLeft', 'ArrowRight'].includes(event.key) && (event.target as HTMLElement).closest('.browser-menu-zoom')) {
      const buttons = items.filter(item => item.closest('.browser-menu-zoom'));
      event.preventDefault(); buttons[(buttons.indexOf(document.activeElement as HTMLButtonElement) + (event.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length]?.focus(); return;
    }
    const filter = ref.current?.querySelector<HTMLInputElement>('input:not(:disabled)');
    if (filter && (event.key === 'ArrowUp' && index === 0 || event.key === 'ArrowDown' && index === items.length - 1)) { event.preventDefault(); filter.focus(); return; }
    const next = event.key === 'ArrowDown' ? (index + 1) % items.length : event.key === 'ArrowUp' ? index < 0 ? items.length - 1 : (index + items.length - 1) % items.length : event.key === 'Home' ? 0 : event.key === 'End' ? items.length - 1 : -1;
    if (next < 0 || !items.length) return;
    event.preventDefault(); items[next]?.focus();
  }}>{children}</div>;
}
