export function popupPosition(trigger: { top: number; bottom: number }, viewportHeight: number, height: number, gap: number) {
  const above = Math.max(0, trigger.top - gap), below = Math.max(0, viewportHeight - trigger.bottom - gap);
  const side = below < height && above > below ? 'above' : 'below';
  const availableHeight = side === 'above' ? above : below;
  const top = side === 'above' ? trigger.top - gap - Math.min(height, availableHeight) : trigger.bottom + gap;
  return { side, top, availableHeight };
}
