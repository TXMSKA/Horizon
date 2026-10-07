import type { WebContents } from 'electron';
import type { LyraSource } from '../src/shared/lyra';
import { isWebURL } from './browsing';

export const LYRA_CONTEXT_LIMIT = 12000;
export const LYRA_PAGE_LIMIT = 6000;
export const lyraPlainText = (value: string) => value.replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/g, '').replace(/[\u2013\u2014]/g, '-');
export interface LyraDocument { source: LyraSource; text: string }
interface AXNode { nodeId?: string; parentId?: string; frameId?: string; ignored?: boolean; role?: { value?: string }; name?: { value?: string } }
export function lyraContext(documents: LyraDocument[], previousAnswer = ''): string {
  const context = { kind: 'untrusted-data', previousAnswer: lyraPlainText(previousAnswer).slice(0, 4000), documents: documents.slice(0, 50).map(document => ({ source: document.source, text: lyraPlainText(document.text).slice(0, LYRA_PAGE_LIMIT) })) };
  // JSON escaping prevents content from closing a delimiter; Lyra adds the context boundary itself.
  while (Buffer.byteLength(JSON.stringify(context), 'utf8') > LYRA_CONTEXT_LIMIT) {
    if (!context.documents.length) { context.previousAnswer = context.previousAnswer.slice(0, -256); continue; }
    const longest = context.documents.reduce((a, b) => a.text.length > b.text.length ? a : b);
    if (longest.text.length) longest.text = longest.text.slice(0, Math.max(0, longest.text.length - 256));
    else if (context.documents.length) context.documents.pop();
    else context.previousAnswer = context.previousAnswer.slice(0, -256);
  }
  return JSON.stringify(context);
}
export async function readLyraPage(contents: Pick<WebContents, 'debugger' | 'getURL' | 'isDestroyed'>, expectedURL: string, authorized: () => boolean, privateWindow: boolean): Promise<string> {
  const check = () => {
    if (privateWindow) throw new Error('LYRA_PRIVATE');
    if (!authorized()) throw new Error('LYRA_PERMISSION_REQUIRED');
    if (contents.isDestroyed() || !isWebURL(expectedURL) || contents.getURL() !== expectedURL) throw new Error('LYRA_PAGE_CHANGED');
  };
  check();
  if (contents.debugger.isAttached()) throw new Error('LYRA_PAGE_BUSY');
  let attached = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    contents.debugger.attach('1.3'); attached = true; check();
    // Select only the main document. Embedded sites have not received a page-read grant.
    const result = await Promise.race([
      (async () => {
        const tree = await contents.debugger.sendCommand('Page.getFrameTree') as { frameTree: { frame: { id: string } } };
        check(); const frameId = tree.frameTree.frame.id;
        if (typeof frameId !== 'string' || !frameId) throw new Error('LYRA_PAGE_CHANGED');
        const result = await contents.debugger.sendCommand('Accessibility.getFullAXTree', { depth: 24, frameId }) as { nodes: AXNode[] };
        return { nodes: result.nodes.slice(0, 20000), frameId };
      })(),
      new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('LYRA_PAGE_TIMEOUT')), 8000); }),
    ]);
    check();
    const nodes = new Map(result.nodes.filter(node => node.nodeId).map(node => [node.nodeId, node]));
    const readable = (node: AXNode) => {
      for (let ancestor: AXNode | undefined = node, depth = 0; ancestor && depth < 24; depth++, ancestor = nodes.get(ancestor.parentId)) {
        if (ancestor.frameId && ancestor.frameId !== result.frameId || /^(Iframe|IframePresentational|textbox|searchbox|combobox)$/i.test(ancestor.role?.value ?? '')) return false;
      }
      return true;
    };
    let text = '';
    for (const node of result.nodes) {
      if (node.ignored || node.role?.value !== 'StaticText' || typeof node.name?.value !== 'string' || !readable(node)) continue;
      text += `${lyraPlainText(node.name.value).slice(0, LYRA_PAGE_LIMIT - text.length)}\n`;
      if (text.length >= LYRA_PAGE_LIMIT) break;
    }
    if (!text.trim()) throw new Error('LYRA_PAGE_EMPTY');
    return text.slice(0, LYRA_PAGE_LIMIT);
  } finally { clearTimeout(timer); if (attached && !contents.isDestroyed() && contents.debugger.isAttached()) contents.debugger.detach(); }
}
