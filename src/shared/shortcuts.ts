import type { BrowserShortcut } from './api';

export function browserShortcut(input: { key: string; control: boolean; alt: boolean; shift: boolean; meta: boolean }): BrowserShortcut | null {
  const key = input.key.toLowerCase();
  if (input.meta) return null;
  if (input.control && !input.alt) {
    if (key === 'tab') return input.shift ? 'previous-tab' : 'next-tab';
    if (/^[1-9]$/.test(key)) return `tab-${Number(key)}`;
    if (key === '+' || key === '=') return 'zoom-in';
    if (key === '-' || key === '_') return 'zoom-out';
    if (key === '0') return 'zoom-reset';
    if (input.shift) return key === 'o' ? 'favorites' : null;
    const keys: Record<string, BrowserShortcut> = { l: 'focus-address', t: 'new-tab', w: 'close-tab', r: 'reload', h: 'history', j: 'downloads', d: 'bookmark', f: 'find' };
    return keys[key] ?? null;
  }
  if (input.alt && !input.control && !input.shift) {
    if (key === 'arrowleft') return 'back';
    if (key === 'arrowright') return 'forward';
  }
  if (!input.control && !input.alt && !input.shift) {
    if (key === 'f11') return 'fullscreen';
    if (key === 'f6') return 'focus-address';
    if (key === 'f5') return 'reload';
    if (key === 'escape') return 'stop';
  }
  return null;
}
