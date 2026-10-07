import type { WebContents } from 'electron';
import { isWebURL } from './browsing';

// Horizon owns this world. DOM text is shared, but its closure and originals are not page globals.
export const TRANSLATE_WORLD = 1020;
export const TRANSLATE_KEY = '__horizonTranslation';
export const TRANSLATE_PAGE_LIMIT = 48000;
export const TRANSLATE_NODE_LIMIT = 512;
type Action = 'language' | 'sample' | 'collect' | 'apply' | 'restore';
export interface TranslationPage {
  url: string; generation: number; header: string | null;
  contents: Pick<WebContents, 'getURL' | 'isDestroyed' | 'executeJavaScriptInIsolatedWorld'>;
}

function isolatedTranslation(key: string, action: Action, payload: string[] | undefined, pageLimit: number, nodeLimit: number) {
  type Entry = { node: Text; original: string; translated: string | null };
  type World = typeof globalThis & { [key: string]: (action: Action, payload?: string[]) => unknown };
  const world = globalThis as World;
  if (!Object.hasOwn(world, key)) {
    let entries: Entry[] = [];
    const eligible = (node: Text) => {
      const parent = node.parentElement;
      // Form values, editable content, executable content and embedded sites are never model input.
      if (!parent || parent.closest('script,style,noscript,template,textarea,input,select,option,pre,code,svg,math,iframe,[contenteditable]:not([contenteditable="false"]),[translate="no"],[hidden],[aria-hidden="true"]') || parent.isContentEditable) return false;
      const style = getComputedStyle(parent);
      return style.display !== 'none' && style.visibility !== 'hidden' && parent.getClientRects().length > 0;
    };
    const read = (sample: boolean) => {
      const next: Entry[] = [], walker = document.createTreeWalker(document.body ?? document.documentElement, NodeFilter.SHOW_TEXT);
      let total = 0, visited = 0, node: Node | null;
      while ((node = walker.nextNode())) {
        if (++visited > 20000) { if (sample) break; throw new Error('TRANSLATE_LIMIT'); }
        const text = node.nodeValue ?? '';
        if (!text.trim() || !eligible(node as Text)) continue;
        if (sample) {
          next.push({ node: node as Text, original: text.slice(0, 800 - total), translated: null });
          total += next.at(-1)!.original.length;
          if (total >= 800) break;
        } else {
          total += text.length;
          if (total > pageLimit || next.length >= nodeLimit || text.length > 8000) throw new Error('TRANSLATE_LIMIT');
          next.push({ node: node as Text, original: text, translated: null });
        }
      }
      return next;
    };
    Object.defineProperty(world, key, { value: (action: Action, payload?: string[]) => {
      if (action === 'language') return document.documentElement.lang.slice(0, 80);
      if (action === 'sample') return read(true).map(entry => entry.original).join('\n').slice(0, 800);
      if (action === 'collect') {
        if (entries.some(entry => entry.translated !== null)) throw new Error('TRANSLATE_INVALID');
        entries = read(false);
        if (!entries.length) throw new Error('TRANSLATE_EMPTY');
        return entries.map(entry => entry.original);
      }
      if (action === 'apply') {
        if (!Array.isArray(payload) || payload.length !== entries.length || payload.some(value => typeof value !== 'string' || value.length > 32000)) throw new Error('TRANSLATE_OUTPUT');
        // Check the complete snapshot before replacing anything, so a late response cannot overwrite a changed page.
        if (entries.some(entry => !entry.node.isConnected || entry.node.nodeValue !== entry.original || !eligible(entry.node))) throw new Error('TRANSLATE_PAGE_CHANGED');
        entries.forEach((entry, index) => { entry.translated = payload[index]!; entry.node.nodeValue = entry.translated; });
        return true;
      }
      if (action === 'restore') {
        for (const entry of entries) if (entry.node.isConnected && entry.translated !== null && entry.node.nodeValue === entry.translated) entry.node.nodeValue = entry.original;
        entries = [];
        return true;
      }
      throw new Error('TRANSLATE_INVALID');
    } });
  }
  return world[key]!(action, payload);
}

export async function translationPage(page: TranslationPage, action: Action, payload: string[] | undefined, privateWindow: boolean, authorized: () => boolean): Promise<unknown> {
  const check = () => {
    if (privateWindow) throw new Error('TRANSLATE_PRIVATE');
    if (!authorized() || page.contents.isDestroyed() || !isWebURL(page.url) || page.contents.getURL() !== page.url) throw new Error('TRANSLATE_PAGE_CHANGED');
  };
  check();
  const code = `(${isolatedTranslation.toString()})(${JSON.stringify(TRANSLATE_KEY)},${JSON.stringify(action)},${JSON.stringify(payload)},${TRANSLATE_PAGE_LIMIT},${TRANSLATE_NODE_LIMIT})`;
  const result = await page.contents.executeJavaScriptInIsolatedWorld(TRANSLATE_WORLD, [{ code }]);
  check(); return result;
}
