import type { WebContentsView } from 'electron';
import { isWebURL } from './urls.js';

export type ControlTarget = { selector: string } | { x: number; y: number };
export interface ControlScroll { x?: number; y?: number; deltaX?: number; deltaY?: number }
export interface PickedElement {
  selector: string;
  box: { x: number; y: number; width: number; height: number };
  image: Buffer;
}
export interface PageControl {
  click(target: ControlTarget): Promise<void>;
  type(target: ControlTarget, text: string): Promise<void>;
  select(target: ControlTarget, value: string): Promise<void>;
  scroll(options: ControlScroll): Promise<void>;
  pickElement(): Promise<PickedElement | null>;
  cancelPick(): Promise<void>;
  release(): Promise<void>;
}
interface DOMNode {
  nodeId: number; backendNodeId: number; nodeType: number; localName: string;
  attributes?: string[]; children?: DOMNode[];
}
// Chromium requires a highlight configuration on every inspect mode change, turning it off included.
const HIGHLIGHT = { showInfo: true, contentColor: { r: 80, g: 140, b: 220, a: 0.25 }, borderColor: { r: 80, g: 140, b: 220, a: 1 } };
type Command = <T>(method: string, params?: Record<string, unknown>) => Promise<T>;
type Consent = (url: string, purpose: 'read' | 'control') => boolean | Promise<boolean>;
const escapeCSS = (value: string) => Array.from(value, character => /^[a-z_-]$/i.test(character) && value !== '-' ? character : `\\${(character.codePointAt(0) || 0xfffd).toString(16)} `).join('');

async function resolveTarget(command: Command, target: ControlTarget): Promise<number> {
  if ('selector' in target) {
    const { root } = await command<{ root: DOMNode }>('DOM.getDocument');
    const { nodeId } = await command<{ nodeId: number }>('DOM.querySelector', { nodeId: root.nodeId, selector: target.selector });
    if (!nodeId) throw new Error('CONTROL_TARGET_NOT_FOUND');
    return nodeId;
  }
  const { backendNodeId } = await command<{ backendNodeId: number }>('DOM.getNodeForLocation', { x: Math.round(target.x), y: Math.round(target.y) });
  const { root } = await command<{ root: DOMNode }>('DOM.getDocument');
  const { nodeIds } = await command<{ nodeIds: number[] }>('DOM.pushNodesByBackendIdsToFrontend', { backendNodeIds: [backendNodeId] });
  if (!root.nodeId || !nodeIds[0]) throw new Error('CONTROL_TARGET_NOT_FOUND');
  return nodeIds[0];
}

async function click(command: Command, target: ControlTarget): Promise<void> {
  let point: { x: number; y: number };
  if ('selector' in target) {
    const nodeId = await resolveTarget(command, target);
    await command('DOM.scrollIntoViewIfNeeded', { nodeId });
    const { quads } = await command<{ quads: number[][] }>('DOM.getContentQuads', { nodeId });
    const quad = quads.find(quad => quad.length === 8 && quad.every(Number.isFinite));
    if (!quad) throw new Error('CONTROL_TARGET_NOT_FOUND');
    point = { x: (quad[0] + quad[2] + quad[4] + quad[6]) / 4, y: (quad[1] + quad[3] + quad[5] + quad[7]) / 4 };
  } else point = target;
  await command('Input.dispatchMouseEvent', { type: 'mousePressed', ...point, button: 'left', clickCount: 1 });
  await command('Input.dispatchMouseEvent', { type: 'mouseReleased', ...point, button: 'left', clickCount: 1 });
}

async function describePick(command: Command, backendNodeId: number): Promise<PickedElement> {
  const { root } = await command<{ root: DOMNode }>('DOM.getDocument', { depth: -1 });
  const parents = new Map<number, DOMNode>(), nodes: DOMNode[] = [root];
  let selected: DOMNode | undefined;
  for (let index = 0; index < nodes.length; index++) {
    if (index >= 50000) throw new Error('CONTROL_TARGET_NOT_FOUND');
    const node = nodes[index];
    if (node.backendNodeId === backendNodeId) selected = node;
    for (const child of node.children ?? []) { parents.set(child.nodeId, node); nodes.push(child); }
  }
  if (!selected || selected.nodeType !== 1) throw new Error('CONTROL_TARGET_NOT_FOUND');
  const pieces: string[] = [];
  let selector = '';
  for (let current: DOMNode | undefined = selected; current?.nodeType === 1; current = parents.get(current.nodeId)) {
    const { node } = await command<{ node: DOMNode }>('DOM.describeNode', { nodeId: current.nodeId, depth: 1 });
    const attributes = node.attributes ?? [], idIndex = attributes.findIndex((attribute, index) => index % 2 === 0 && attribute === 'id');
    const id = idIndex >= 0 ? attributes[idIndex + 1] : '';
    if (id) {
      const candidate = `#${escapeCSS(id)}`;
      const { nodeIds } = await command<{ nodeIds: number[] }>('DOM.querySelectorAll', { nodeId: root.nodeId, selector: candidate });
      if (nodeIds.length === 1 && nodeIds[0] === current.nodeId) { pieces.unshift(candidate); selector = pieces.join(' > '); break; }
    }
    const siblings = parents.get(current.nodeId)?.children?.filter(sibling => sibling.nodeType === 1 && sibling.localName === node.localName) ?? [current];
    pieces.unshift(`${escapeCSS(node.localName)}:nth-of-type(${siblings.findIndex(sibling => sibling.nodeId === current!.nodeId) + 1})`);
    const candidate = pieces.join(' > ');
    const { nodeIds } = await command<{ nodeIds: number[] }>('DOM.querySelectorAll', { nodeId: root.nodeId, selector: candidate });
    if (nodeIds.length === 1 && nodeIds[0] === selected.nodeId) { selector = candidate; break; }
  }
  if (!selector) throw new Error('CONTROL_TARGET_NOT_FOUND');
  const { model } = await command<{ model: { border: number[] } }>('DOM.getBoxModel', { nodeId: selected.nodeId });
  const xs = model.border.filter((_value, index) => index % 2 === 0), ys = model.border.filter((_value, index) => index % 2 === 1);
  const box = { x: Math.min(...xs), y: Math.min(...ys), width: Math.max(...xs) - Math.min(...xs), height: Math.max(...ys) - Math.min(...ys) };
  if (!Object.values(box).every(Number.isFinite) || box.width <= 0 || box.height <= 0) throw new Error('CONTROL_TARGET_NOT_FOUND');
  const { cssVisualViewport } = await command<{ cssVisualViewport: { pageX: number; pageY: number } }>('Page.getLayoutMetrics');
  const { data } = await command<{ data: string }>('Page.captureScreenshot', {
    format: 'png', fromSurface: true, captureBeyondViewport: true,
    clip: { ...box, x: box.x + cssVisualViewport.pageX, y: box.y + cssVisualViewport.pageY, scale: 1 },
  });
  return { selector, box, image: Buffer.from(data, 'base64') };
}

export function createPageControl(view: WebContentsView, consent?: Consent): { control: PageControl; dispose(): void } {
  const contents = view.webContents, debuggerAPI = contents.debugger;
  let owned = false, disposed = false, generation = 0, connection = 0, busy = false;
  let pick: { cancel(): void; done: Promise<void> } | undefined;
  const detach = () => { owned = false; generation++; connection++; pick?.cancel(); };
  const invalidate = () => {
    generation++; pick?.cancel();
    if (owned && !contents.isDestroyed() && debuggerAPI.isAttached()) debuggerAPI.detach();
    owned = false;
  };
  const navigation = (_event: unknown, _url: string, inPlace: boolean, mainFrame: boolean) => { if (mainFrame && !inPlace) invalidate(); };
  debuggerAPI.on('detach', detach);
  contents.on('did-start-navigation', navigation);
  const send: Command = async (method, params) => {
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([debuggerAPI.sendCommand(method, params), new Promise<never>((_resolve, reject) => { timer = setTimeout(() => reject(new Error('CONTROL_TIMEOUT')), 8000); })]);
    } finally { clearTimeout(timer); }
  };
  const authorize = async () => {
    if (disposed || contents.isDestroyed()) throw new Error('Tab is closed');
    const version = generation, url = contents.getURL();
    let allowed = false;
    try { allowed = isWebURL(url) && await consent?.(url, 'control') === true; } catch { /* A failed consent callback denies control. */ }
    if (!allowed) { invalidate(); throw new Error('CONTROL_CONSENT'); }
    if (disposed || contents.isDestroyed() || version !== generation || contents.getURL() !== url) throw new Error('CONTROL_PAGE_CHANGED');
    return { version, url };
  };
  const run = async <T>(work: (command: Command) => Promise<T>): Promise<T> => {
    const { version, url } = await authorize();
    if (busy) throw new Error('CONTROL_BUSY');
    busy = true;
    const check = () => {
      if (disposed || contents.isDestroyed() || version !== generation || contents.getURL() !== url || !debuggerAPI.isAttached()) throw new Error('CONTROL_PAGE_CHANGED');
    };
    const command: Command = async <R>(method: string, params?: Record<string, unknown>) => {
      check();
      const result = await send<R>(method, params);
      check(); return result;
    };
    try {
      if (!debuggerAPI.isAttached()) { debuggerAPI.attach('1.3'); owned = true; }
      return await work(command);
    } catch (error) { if (version === generation) invalidate(); throw error; }
    finally { busy = false; }
  };
  const stopPick = async () => { const pending = pick; pending?.cancel(); await pending?.done; };
  return {
    control: {
      click(target) { return run(command => click(command, target)); },
      type(target, text) {
        return run(async command => {
          if ('selector' in target) await command('DOM.focus', { nodeId: await resolveTarget(command, target) });
          else await click(command, target);
          await command('Input.insertText', { text });
        });
      },
      select(target, value) {
        return run(async command => {
          const nodeId = await resolveTarget(command, target);
          const { node } = await command<{ node: DOMNode }>('DOM.describeNode', { nodeId });
          if (node.localName !== 'select') throw new Error('CONTROL_NOT_SELECT');
          const { frameTree } = await command<{ frameTree: { frame: { id: string } } }>('Page.getFrameTree');
          const { executionContextId } = await command<{ executionContextId: number }>('Page.createIsolatedWorld', { frameId: frameTree.frame.id, worldName: 'horizon-engine-control' });
          const { object } = await command<{ object: { objectId: string } }>('DOM.resolveNode', { nodeId, executionContextId });
          try {
            const result = await command<{ exceptionDetails?: unknown }>('Runtime.callFunctionOn', {
              objectId: object.objectId,
              functionDeclaration: 'function(value) { this.value = value; this.dispatchEvent(new Event("input", { bubbles: true })); this.dispatchEvent(new Event("change", { bubbles: true })); }',
              arguments: [{ value }], returnByValue: true,
            });
            if (result.exceptionDetails) throw new Error('CONTROL_NOT_SELECT');
          } finally { await command('Runtime.releaseObject', { objectId: object.objectId }); }
        });
      },
      scroll(settings) {
        return run(async command => {
          const { cssLayoutViewport } = await command<{ cssLayoutViewport: { clientWidth: number; clientHeight: number } }>('Page.getLayoutMetrics');
          await command('Input.dispatchMouseEvent', { type: 'mouseWheel', x: settings.x ?? cssLayoutViewport.clientWidth / 2, y: settings.y ?? cssLayoutViewport.clientHeight / 2, deltaX: settings.deltaX ?? 0, deltaY: settings.deltaY ?? 0 });
        });
      },
      pickElement() {
        return run(async command => {
          let finish!: (node: number | null) => void, done!: () => void;
          let canceled = false;
          const selection = new Promise<number | null>(resolve => { finish = resolve; });
          const pending = { cancel: () => { canceled = true; finish(null); }, done: new Promise<void>(resolve => { done = resolve; }) };
          pick = pending;
          const message = (_event: unknown, method: string, params: { backendNodeId?: number }) => {
            if (method === 'Overlay.inspectNodeRequested' && params.backendNodeId) finish(params.backendNodeId);
            if (method === 'Overlay.inspectModeCanceled') pending.cancel();
          };
          const escape = (event: { preventDefault(): void }, input: { key: string }) => { if (input.key === 'Escape') { event.preventDefault(); pending.cancel(); } };
          const pickCommand: Command = async <R>(method: string, params?: Record<string, unknown>) => {
            if (canceled) throw new Error('CONTROL_PICK_CANCELED');
            const result = await command<R>(method, params);
            if (canceled) throw new Error('CONTROL_PICK_CANCELED');
            return result;
          };
          debuggerAPI.on('message', message); contents.on('before-input-event', escape);
          const attachment = connection;
          try {
            await command('DOM.enable'); await command('Overlay.enable');
            await command('Overlay.setInspectMode', { mode: 'searchForNode', highlightConfig: HIGHLIGHT });
            const selected = await selection;
            if (selected === null) return null;
            await command('Overlay.setInspectMode', { mode: 'none', highlightConfig: HIGHLIGHT });
            await command('Overlay.hideHighlight');
            return await describePick(pickCommand, selected);
          } catch (error) {
            if (canceled || disposed || attachment !== connection) return null;
            throw error;
          } finally {
            debuggerAPI.off('message', message); contents.off('before-input-event', escape);
            if (!contents.isDestroyed() && debuggerAPI.isAttached() && attachment === connection) {
              await send('Overlay.setInspectMode', { mode: 'none', highlightConfig: HIGHLIGHT }).catch(() => undefined);
            }
            if (pick === pending) pick = undefined;
            done();
          }
        });
      },
      async cancelPick() { await authorize(); await stopPick(); },
      async release() { await authorize(); generation++; await stopPick(); invalidate(); },
    },
    dispose() {
      if (disposed) return;
      disposed = true; invalidate();
      debuggerAPI.off('detach', detach); contents.off('did-start-navigation', navigation);
    },
  };
}
