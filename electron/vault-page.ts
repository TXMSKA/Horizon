import type { WebContents } from 'electron';
import { isWebURL } from './browsing';

export function vaultOrigin(value: string): string | null {
  return isWebURL(value) ? new URL(value).origin : null;
}

interface SnapshotDocument {
  documentURL: number;
  nodes: { nodeName: number[]; backendNodeId: number[]; parentIndex: number[]; attributes: number[][] };
  layout: { nodeIndex: number[]; bounds: number[][] };
  scrollOffsetX: number; scrollOffsetY: number;
}
export interface LoginFields { origin: string; username: number; password: number; x: number; y: number; width: number; height: number }

// Only the top snapshot is inspected. Embedded documents, including opaque frames,
// never supply a target even when their markup resembles the top site's login.
export function loginFields(snapshot: { strings: string[]; documents: SnapshotDocument[] }, origin: string, focused: number): LoginFields | null {
  const document = snapshot.documents[0];
  if (!document || vaultOrigin(snapshot.strings[document.documentURL] ?? '') !== origin || document.nodes.nodeName.length > 20000) return null;
  const { nodes, layout } = document;
  const attributes = (index: number) => {
    const pairs = nodes.attributes[index] ?? [], attrs: Record<string, string> = {};
    for (let i = 0; i < pairs.length; i += 2) attrs[snapshot.strings[pairs[i]!] ?? ''] = snapshot.strings[pairs[i + 1]!] ?? '';
    return attrs;
  };
  const form = (index: number) => {
    for (let steps = 0; index >= 0 && steps < 64; steps++) {
      if (snapshot.strings[nodes.nodeName[index]!] === 'FORM') return index;
      index = nodes.parentIndex[index] ?? -1;
    }
    return -1;
  };
  const box = (index: number) => layout.bounds[layout.nodeIndex.indexOf(index)];
  const eligible = (index: number) => {
    const attrs = attributes(index), bounds = box(index);
    return snapshot.strings[nodes.nodeName[index]!] === 'INPUT' && !Object.hasOwn(attrs, 'disabled') && !Object.hasOwn(attrs, 'readonly')
      && !Object.hasOwn(attrs, 'hidden') && bounds && bounds[2]! > 0 && bounds[3]! > 0;
  };
  const index = nodes.backendNodeId.indexOf(focused);
  if (index < 0 || !eligible(index)) return null;
  const attrs = attributes(index), type = (attrs.type ?? 'text').toLowerCase();
  if (!['text', 'email'].includes(type) || /new-password|one-time-code/.test(attrs.autocomplete ?? '')) return null;
  if (type !== 'email' && !/username|email|login|user/i.test(`${attrs.autocomplete ?? ''} ${attrs.name ?? ''} ${attrs.id ?? ''}`)) return null;
  const parent = form(index);
  if (parent < 0) return null;
  const passwords = nodes.nodeName.map((_, candidate) => candidate).filter(candidate => eligible(candidate)
    && attributes(candidate).type?.toLowerCase() === 'password' && !/new-password/.test(attributes(candidate).autocomplete ?? '') && form(candidate) === parent);
  if (passwords.length !== 1) return null;
  const bounds = box(index)!;
  return { origin, username: focused, password: nodes.backendNodeId[passwords[0]!]!, x: bounds[0]! - document.scrollOffsetX,
    y: bounds[1]! - document.scrollOffsetY, width: bounds[2]!, height: bounds[3]! };
}

export function assertVaultPage(contents: WebContents, origin: string, privateWindow: boolean): void {
  if (privateWindow || contents.isDestroyed() || contents.isLoadingMainFrame() || vaultOrigin(contents.getURL()) !== origin
    || contents.focusedFrame !== contents.mainFrame || vaultOrigin(contents.mainFrame.url) !== origin || contents.mainFrame.origin !== origin) throw new Error('VAULT_PAGE_CHANGED');
}

export async function withVaultDOM<T>(contents: WebContents, work: (send: (method: string, params?: Record<string, unknown>) => Promise<unknown>) => Promise<T>): Promise<T> {
  // A capture or developer-tools session owns its debugger connection. Never detach it.
  if (contents.debugger.isAttached()) throw new Error('VAULT_PAGE_UNAVAILABLE');
  let attached = false;
  try {
    contents.debugger.attach('1.3'); attached = true;
    return await work((method, params) => contents.debugger.sendCommand(method, params));
  } finally {
    if (attached && !contents.isDestroyed()) try { contents.debugger.detach(); } catch { /* Navigation can detach the debugger first. */ }
  }
}

async function focusedNode(send: (method: string, params?: Record<string, unknown>) => Promise<unknown>): Promise<number> {
  const tree = await send('DOM.getDocument', { depth: 0 }) as { root: { nodeId: number } };
  const selected = await send('DOM.querySelector', { nodeId: tree.root.nodeId, selector: 'input:focus' }) as { nodeId: number };
  if (!selected.nodeId) return 0;
  const described = await send('DOM.describeNode', { nodeId: selected.nodeId }) as { node: { backendNodeId: number } };
  return described.node.backendNodeId;
}

export async function inspectLogin(contents: WebContents, origin: string, privateWindow: boolean): Promise<LoginFields | null> {
  assertVaultPage(contents, origin, privateWindow);
  return withVaultDOM(contents, async send => {
    const focused = await focusedNode(send);
    if (!focused) return null;
    const snapshot = await send('DOMSnapshot.captureSnapshot', { computedStyles: [] }) as Parameters<typeof loginFields>[0];
    assertVaultPage(contents, origin, privateWindow);
    if (await focusedNode(send) !== focused) return null;
    return loginFields(snapshot, origin, focused);
  });
}

export async function fillLogin(contents: WebContents, fields: LoginFields, values: { username: string; password: string }, privateWindow: boolean, check: () => void): Promise<void> {
  assertVaultPage(contents, fields.origin, privateWindow); check();
  await withVaultDOM(contents, async send => {
    for (const [backendNodeId, value, type] of [[fields.username, values.username, 'username'], [fields.password, values.password, 'password']] as const) {
      check(); assertVaultPage(contents, fields.origin, privateWindow);
      await send('DOM.focus', { backendNodeId });
      check(); assertVaultPage(contents, fields.origin, privateWindow);
      if (await focusedNode(send) !== backendNodeId) throw new Error('VAULT_PAGE_CHANGED');
      const snapshot = await send('DOMSnapshot.captureSnapshot', { computedStyles: [] }) as Parameters<typeof loginFields>[0];
      // The original form and both field identities must survive username input handlers.
      const current = loginFields(snapshot, fields.origin, fields.username);
      if (!current || current.password !== fields.password) throw new Error('VAULT_PAGE_CHANGED');
      const document = snapshot.documents[0]!, index = document.nodes.backendNodeId.indexOf(backendNodeId);
      const attrs = document.nodes.attributes[index] ?? [];
      const inputType = attrs.findIndex(key => snapshot.strings[key] === 'type');
      if (type === 'password' && snapshot.strings[attrs[inputType + 1]!] !== 'password') throw new Error('VAULT_PAGE_CHANGED');
      // Select the existing value through native keyboard input, then insertText types
      // into the focused input. No Runtime.evaluate or page-side code is used.
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: process.platform === 'darwin' ? 4 : 2 });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65, modifiers: process.platform === 'darwin' ? 4 : 2 });
      if (await focusedNode(send) !== backendNodeId) throw new Error('VAULT_PAGE_CHANGED');
      check(); assertVaultPage(contents, fields.origin, privateWindow);
      await contents.insertText(value);
      check(); assertVaultPage(contents, fields.origin, privateWindow);
    }
  });
}
