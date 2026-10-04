import type { BrowserShortcut } from './api';

type ShortcutInput = { key: string; control: boolean; alt: boolean; shift: boolean; meta: boolean };

export function browserShortcut(input: ShortcutInput): BrowserShortcut | null {
  const key = input.key.toLowerCase();
  if (input.meta) return null;
  if (input.control && !input.alt) {
    if (key === 'n') return input.shift ? 'new-private-window' : 'new-window';
    if (key === 'tab') return input.shift ? 'previous-tab' : 'next-tab';
    if (!input.shift && key === 'pagedown') return 'next-tab';
    if (!input.shift && key === 'pageup') return 'previous-tab';
    if (key === 'f5' || key === 'r' && input.shift) return 'reload-no-cache';
    if (key === 'g') return input.shift ? 'find-previous' : 'find-next';
    if (/^[1-9]$/.test(key)) return `tab-${Number(key)}`;
    if (key === '+' || key === '=') return 'zoom-in';
    if (key === '-' || key === '_') return 'zoom-out';
    if (key === '0') return 'zoom-reset';
    if (input.shift) return key === 's' ? 'capture' : key === 'o' ? 'favorites' : key === 't' ? 'reopen-tab' : key === 'delete' ? 'clear-browsing-data' : null;
    const keys: Record<string, BrowserShortcut> = { l: 'focus-address', e: 'focus-search', k: 'focus-search', f4: 'close-tab', p: 'print', t: 'new-tab', w: 'close-tab', r: 'reload', h: 'history', j: 'downloads', d: 'bookmark', f: 'find' };
    return keys[key] ?? null;
  }
  if (input.alt && !input.control && !input.shift) {
    if (key === 'arrowleft') return 'back';
    if (key === 'arrowright') return 'forward';
    if (key === 'd') return 'focus-address';
    if (key === 'home') return 'home';
    if (key === 'f' || key === 'e') return 'menu';
  }
  if (!input.control && !input.alt && key === 'f3') return input.shift ? 'find-previous' : 'find-next';
  if (!input.control && !input.alt && input.shift && key === 'f5') return 'reload-no-cache';
  if (!input.control && !input.alt && !input.shift) {
    if (key === 'f11') return 'fullscreen';
    if (key === 'f6') return 'focus-address';
    if (key === 'f5') return 'reload';
    if (key === 'escape') return 'stop';
  }
  return null;
}

export function browserReservedShortcut(shortcut: BrowserShortcut | null, fullscreen = false): boolean {
  if (shortcut === 'new-window' || shortcut === 'new-private-window' || shortcut === 'fullscreen' || fullscreen && shortcut === 'stop') return true;
  if (!shortcut || fullscreen) return false;
  // Chromium keeps tab management outside the document's keyboard handlers.
  return ['new-tab', 'close-tab', 'reopen-tab', 'next-tab', 'previous-tab'].includes(shortcut) || /^tab-[1-9]$/.test(shortcut);
}

export function browserShortcutAccelerators() {
  const keys = ['Tab', 'PageDown', 'PageUp', 'F5', 'R', 'G', '1', '2', '3', '4', '5', '6', '7', '8', '9', '+', '=', '-', '0', 'S', 'O', 'T', 'N', 'Delete', 'L', 'E', 'K', 'F4', 'P', 'W', 'H', 'J', 'D', 'F', 'ArrowLeft', 'ArrowRight', 'Home', 'F3', 'F11', 'F6', 'Escape'];
  const names: Record<string, string> = { '+': 'Plus', ArrowLeft: 'Left', ArrowRight: 'Right' };
  const accelerators: { accelerator: string; shortcut: BrowserShortcut; input: ShortcutInput }[] = [];
  for (const key of keys) for (const control of [false, true]) for (const alt of [false, true]) for (const shift of [false, true]) {
    const input = { key, control, alt, shift, meta: false }, shortcut = browserShortcut(input);
    if (shortcut) accelerators.push({ accelerator: [control && 'Ctrl', alt && 'Alt', shift && 'Shift', names[key] ?? key].filter(Boolean).join('+'), shortcut, input });
  }
  return accelerators;
}

export function completeAddress(input: string): string {
  const word = input.trim();
  return /^[a-z\d](?:[a-z\d-]*[a-z\d])?$/i.test(word) && word.length <= 63 ? `https://www.${word}.com/` : input;
}

export function shortcutTabIndex(action: BrowserShortcut, count: number, current: number): number {
  if (!count) return -1;
  if (action === 'next-tab') return (current + 1) % count;
  if (action === 'previous-tab') return (current + count - 1) % count;
  if (/^tab-[1-9]$/.test(action)) { const number = Number(action.slice(4)); return number === 9 ? count - 1 : number <= count ? number - 1 : -1; }
  return -1;
}
