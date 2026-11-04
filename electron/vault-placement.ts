import type { SuggestionAnchor } from './vault';

export interface Placement { x: number; y: number; width: number; height: number; side: 'below' | 'above' }

// The suggestion sits under the field it belongs to, or above it when the box below would cover another input (the password under a username)
// or does not fit; it never covers the field itself and always stays inside the page.
export function placeSuggestion(anchor: SuggestionAnchor, size: { width: number; height: number }, window: { width: number; height: number }, gap = 4, edge = 8): Placement {
  const width = Math.min(size.width, Math.max(0, window.width - edge * 2)), height = size.height;
  const x = Math.round(Math.min(Math.max(anchor.field.x, edge), Math.max(edge, window.width - width - edge)));
  const top = Math.max(anchor.page.y, 0), bottom = Math.min(anchor.page.y + anchor.page.height, window.height);
  const field = anchor.field;
  const covers = (y: number) => anchor.avoid.filter(other => other.x < x + width && other.x + other.width > x && other.y < y + height && other.y + other.height > y).length;
  const candidates = ([['below', field.y + field.height + gap], ['above', field.y - gap - height]] as const)
    .map(([side, y]) => ({ side, y: Math.round(y), fits: y >= top && y + height <= bottom, hits: covers(y) }));
  const chosen = candidates.filter(item => item.fits).sort((a, b) => a.hits - b.hits || (a.side === 'below' ? -1 : 1))[0];
  if (chosen) return { x, y: chosen.y, width, height, side: chosen.side };
  // No side has room: take the roomier one and keep it inside the page.
  const side = bottom - (field.y + field.height) >= field.y - top ? 'below' : 'above';
  return { x, y: Math.round(Math.max(top, Math.min(side === 'below' ? field.y + field.height + gap : field.y - gap - height, bottom - height))), width, height, side };
}
