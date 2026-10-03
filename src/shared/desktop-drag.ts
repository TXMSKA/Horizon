import { isWebURL } from '../../electron/browsing';
import { desktopInputText, desktopTitle } from './desktop-input';
import type { BrowserState } from './api';

export const DESKTOP_TAB_DRAG = 'application/x-horizon-tab';
type Source = { url: string; title: string };
export type DesktopDrop = { kind: 'link'; address: string; title: string } | { kind: 'text'; text: string; source: Source | null };
export type DesktopDragData = { text?: string; uriList?: string; mozURL?: string; tab?: Source; source?: Source | null; selection?: boolean };
export type DesktopDropFailure = 'DESKTOP_DROP_LINK_INVALID' | 'DESKTOP_DROP_TEXT_INVALID' | 'DESKTOP_DROP_MULTIPLE_LINKS' | 'DESKTOP_DROP_UNSUPPORTED' | 'DESKTOP_DROP_TAB_INVALID';

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
export function parseDesktopDrag(data: DesktopDragData, refused?: (reason: DesktopDropFailure) => void): DesktopDrop | null {
  const fail = (reason: DesktopDropFailure) => { refused?.(reason); return null; };
  const webLink = (address: string, title: string) => link(address, title) ?? fail('DESKTOP_DROP_LINK_INVALID');
  if (data.tab) return webLink(data.tab.url, data.tab.title);
  const plain = data.text ?? '';
  if (!desktopInputText(plain, 100000)) return fail('DESKTOP_DROP_TEXT_INVALID');
  if (data.uriList) {
    if (!desktopInputText(data.uriList, 100000)) return fail('DESKTOP_DROP_LINK_INVALID');
    const addresses = data.uriList.split(/\r?\n/).filter(line => line && !line.startsWith('#'));
    if (addresses.length !== 1) return fail(addresses.length > 1 ? 'DESKTOP_DROP_MULTIPLE_LINKS' : 'DESKTOP_DROP_LINK_INVALID');
    const address = addresses[0]!;
    return webLink(address, plain === address ? '' : plain);
  }
  if (data.mozURL) {
    if (!desktopInputText(data.mozURL, 100000)) return fail('DESKTOP_DROP_LINK_INVALID');
    const [address, title = '', ...extra] = data.mozURL.split(/\r?\n/);
    return extra.length ? fail('DESKTOP_DROP_MULTIPLE_LINKS') : webLink(address!, title);
  }
  if (!plain.trim()) return fail('DESKTOP_DROP_UNSUPPORTED');
  // Refuse explicit non-web schemes instead of downgrading them to text.
  const trimmed = plain.trim();
  if (!data.selection && (/^[a-z][a-z\d+.-]*:(?=\S|$)/i.test(trimmed) || /^(?:https?|javascript|data|file|blob|about|horizon|ftp|mailto|vbscript):/i.test(trimmed))) return webLink(plain, '');
  const origin = data.source ? source(data.source) : null;
  if (data.source && !origin) return fail('DESKTOP_DROP_LINK_INVALID');
  return { kind: 'text', text: plain, source: origin };
}

export function readDesktopTransfer(transfer: Pick<DataTransfer, 'getData'> & { types?: readonly string[] }, state: Pick<BrowserState, 'activeProfileId' | 'tabs'>, source: DesktopDragData['source'], refused?: (reason: DesktopDropFailure) => void, paste = false): DesktopDrop | null {
  const fail = (reason: DesktopDropFailure) => { refused?.(reason); return null; };
  const internal = transfer.getData(DESKTOP_TAB_DRAG);
  if (internal) {
    if (paste || internal.length > 512) return fail('DESKTOP_DROP_TAB_INVALID');
    try {
      const value: unknown = JSON.parse(internal);
      if (!value || typeof value !== 'object' || !('profile' in value) || !('tab' in value)
        || Object.keys(value).length !== 2 || value.profile !== state.activeProfileId) return fail('DESKTOP_DROP_TAB_INVALID');
      const tab = state.tabs.find(tab => tab.id === value.tab && !tab.desktop && !tab.settings);
      return tab ? parseDesktopDrag({ tab: { url: tab.url, title: tab.title } }, refused) : fail('DESKTOP_DROP_TAB_INVALID');
    } catch { return fail('DESKTOP_DROP_TAB_INVALID'); }
  }
  if (transfer.types?.includes('Files') && !transfer.types.some(type => type === 'text/uri-list' || type === 'text/x-moz-url')) return fail('DESKTOP_DROP_UNSUPPORTED');
  return parseDesktopDrag({ text: transfer.getData('text/plain'), uriList: transfer.getData('text/uri-list'), mozURL: transfer.getData('text/x-moz-url'), source: paste ? null : source, selection: !paste && transfer.types?.includes('text/html') }, refused);
}
