import { isWebURL } from '../../electron/browsing';
import { desktopInputText, desktopTitle } from './desktop-input';

export const DESKTOP_TAB_DRAG = 'application/x-horizon-tab';
type Source = { url: string; title: string };
export type DesktopDrop = { kind: 'link'; address: string; title: string } | { kind: 'text'; text: string; source: Source | null };
export type DesktopDragData = { text?: string; uriList?: string; mozURL?: string; tab?: Source; source?: Source | null; selection?: boolean };

function source(value: Source): Source | null {
  return isWebURL(value.url) && desktopInputText(value.url, 8192) && desktopTitle(value.title) ? { url: value.url, title: value.title || addressTitle(value.url) } : null;
}
function addressTitle(address: string): string {
  // Store addresses up to run A's limit while keeping the title within its own limit.
  return address.length <= 200 ? address : new URL(address).hostname.slice(0, 200);
}
function link(address: string, title: string): DesktopDrop | null {
  if (!isWebURL(address) || !desktopInputText(address, 8192) || !desktopTitle(title)) return null;
  return { kind: 'link', address, title: title || addressTitle(address) };
}

// HTML is deliberately absent: never decode markup to find a title, link or image.
export function parseDesktopDrag(data: DesktopDragData): DesktopDrop | null {
  if (data.tab) return link(data.tab.url, data.tab.title);
  const plain = data.text ?? '';
  if (!desktopInputText(plain, 100000)) return null;
  if (data.uriList) {
    if (!desktopInputText(data.uriList, 100000)) return null;
    const addresses = data.uriList.split(/\r?\n/).filter(line => line && !line.startsWith('#'));
    if (addresses.length !== 1) return null;
    const address = addresses[0]!;
    return link(address, plain === address ? '' : plain);
  }
  if (data.mozURL) {
    if (!desktopInputText(data.mozURL, 100000)) return null;
    const [address, title = '', ...extra] = data.mozURL.split(/\r?\n/);
    return extra.length ? null : link(address!, title);
  }
  if (!plain.trim()) return null;
  // Refuse explicit non-web schemes instead of downgrading them to text.
  const trimmed = plain.trim();
  if (!data.selection && (/^[a-z][a-z\d+.-]*:(?=\S|$)/i.test(trimmed) || /^(?:https?|javascript|data|file|blob|about|horizon|ftp|mailto|vbscript):/i.test(trimmed))) return link(plain, '');
  const origin = data.source ? source(data.source) : null;
  if (data.source && !origin) return null;
  return { kind: 'text', text: plain, source: origin };
}
