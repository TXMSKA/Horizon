import { randomUUID } from 'node:crypto';
import { readFileSync, rmSync, writeFileSync } from 'node:fs';
import type { Client } from 'horizon-lyra' with { 'resolution-mode': 'import' };
import type { DesktopItem, Language, PermissionDecision, ProjectContent } from '../src/shared/api';
import type { LyraCommand, LyraSource, LyraState } from '../src/shared/lyra';
import { text } from '../src/copy';
import { serviceReason } from '../src/shared/services';
import type { ServiceReason } from '../src/shared/services';
import { lyraRouteShown } from '../src/shared/lyra';
import { lyraContext, lyraPlainText, readLyraPage } from './lyra-context';
import { siteOrigin } from './site-settings';
import { sharedItemId } from './space-reader';

type Ask = Extract<LyraCommand, { type: 'lyra-ask' }>;
export interface LyraPage {
  id: string; url: string; title: string; generation: number;
  contents: Parameters<typeof readLyraPage>[0];
}
export interface LyraHost {
  privateWindow: boolean; alive(): boolean; language(): Language; changed(): void;
  page(id: string): LyraPage; decision(origin: string): PermissionDecision;
  // Whether the site's saved allow was given under the notice that says external sources may answer. Older and synced allows are local only.
  external(origin: string): boolean; allow(origin: string, external: boolean): void;
  // Whether this profile accepted, for good, the notice that saved items and notes may leave this computer. Kept on this computer only, never synced.
  desktopExternal(): boolean; allowDesktop(): void;
  project(id: string): ProjectContent; item(project: string | null, id: string): DesktopItem;
  save(project: string, title: string, answer: string, sources: LyraSource[]): void;
  connect(): Promise<Client>;
  // Called when the client says Lyra is missing or did not start, for a feature the person reached.
  unreachable?(reason: ServiceReason): void;
}
const initial = (): LyraState => ({ open: false, phase: 'home', task: 'question', question: '', answer: '', sources: [], permission: null, attachment: null, error: null, route: 'any', answeredBy: null });
const failureCode = (error: unknown): string => {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return error instanceof Error && /^(LYRA_|DESKTOP_|PROJECT_|SITE_SETTINGS_)/.test(error.message) ? error.message : 'unavailable';
};
export interface LyraRoutes { protocol: number; local: boolean; external: boolean }
// The answer routes Lyra offers Horizon right now. Lyra owns every model, key and CLI; Horizon only reads which sources are ready.
// A protocol 1 service keeps its 0.2.0 behaviour: it answers on this computer, and its models status says whether it can.
export async function lyraRoutes(client: Client): Promise<LyraRoutes> {
  const { protocol, features } = await client.capabilities();
  if (protocol < 2) return { protocol, local: true, external: false };
  if (!features.includes('sources')) throw { code: 'unsupported' };
  const ready = (await client.sources.list()).sources.filter(source => source.state === 'ready' && source.text);
  return { protocol, local: ready.some(source => !source.external), external: ready.some(source => source.external) };
}
// The profile's lasting answer to the notice for saved items and notes, in its own file beside the profile's store: on this computer only, never synced.
export function desktopNotice(path: string) {
  return {
    external(): boolean {
      try { const value = JSON.parse(readFileSync(path, 'utf8')) as unknown; return !!value && typeof value === 'object' && 'version' in value && value.version === 1 && 'external' in value && value.external === true; }
      catch { return false; }
    },
    allow() {
      try { writeFileSync(path, JSON.stringify({ version: 1, external: true }), { mode: 0o600 }); }
      catch { throw new Error('SITE_SETTINGS_SAVE_FAILED'); }
    },
    // Withdraws the answer, so the notice is asked again.
    clear() {
      try { rmSync(path, { force: true }); }
      catch { throw new Error('SITE_SETTINGS_SAVE_FAILED'); }
    },
  };
}
// The one gate every Lyra request with cloud: true passes, the assistant's and translation's alike. External sources are admitted only for an action
// the person took under a visible notice that said content may leave this computer, recorded by the main process before this call.
export function lyraChat(client: Client, request: Parameters<Client['chat']>[0], noticed: boolean, options: { signal: AbortSignal }) {
  if (request.cloud === true && !noticed) throw new Error('LYRA_NOTICE_REQUIRED');
  return client.chat(request, options);
}
export function createLyra(host: LyraHost) {
  const state = initial();
  const connect = async (): Promise<Client> => {
    try { return await host.connect(); }
    catch (error) { const reason = serviceReason(error); if (reason && host.alive()) host.unreachable?.(reason); throw error; }
  };
  let generation = 0, controller: AbortController | undefined, request: Ask | undefined;
  let pages: LyraPage[] = [];
  let previousAnswer = '';
  // One-time grants of this turn, each with whether it was given under the notice that says external sources may answer.
  const grants = new Map<string, boolean>();
  // This turn's answer to the notice for saved items and notes: true allowed once under it, false kept on this computer.
  let desktopGrant: boolean | undefined;
  // A retry asks Lyra again which routes are ready instead of keeping the route the failed turn was shown.
  let refresh = false;
  // Whether the panel drew the route line in the state this turn was asked or last answered from.
  let lineShown = true;
  let pendingWork: Promise<void> | undefined;
  const publish = () => { if (host.alive()) host.changed(); };
  const stop = () => { generation++; controller?.abort(); controller = undefined; state.permission = null; grants.clear(); desktopGrant = undefined; pendingWork = undefined; };
  // A turn that did not finish never claims a source answered it.
  const fail = (code: string) => { state.phase = 'failed'; state.error = code; state.answeredBy = null; };
  const close = () => { state.open = false; stop(); if (['running', 'permission', 'checking', 'starting'].includes(state.phase)) fail('cancelled'); publish(); };
  const assertPublic = () => { if (host.privateWindow || !host.alive()) throw new Error('LYRA_PRIVATE'); };
  const failed = (error: unknown) => { fail(failureCode(error)); state.permission = null; publish(); };
  const launch = (work: (id: number, signal: AbortSignal) => Promise<void>) => {
    stop(); controller = new AbortController(); const id = generation, signal = controller.signal;
    const current = work(id, signal).catch(error => { if (id === generation && host.alive()) failed(error); }).finally(() => { if (id === generation) pendingWork = undefined; });
    pendingWork = current;
  };
  const current = (id: number, signal: AbortSignal) => { signal.throwIfAborted(); if (id !== generation || !host.alive()) throw new Error('cancelled'); };
  const checkPages = () => {
    assertPublic();
    for (const page of pages) {
      const live = host.page(page.id);
      if (live.url !== page.url || live.generation !== page.generation || live.contents !== page.contents) throw new Error('LYRA_PAGE_CHANGED');
    }
  };
  // A site allowed under the local notice ("nothing leaves it") never authorizes a turn that external sources may answer.
  const permitted = (origin: string, external: boolean) => {
    const decision = host.decision(origin);
    if (decision === 'block') return false;
    if (decision === 'allow' && (!external || host.external(origin))) return true;
    const grant = grants.get(origin);
    return grant !== undefined && (!external || grant);
  };
  const checkAccess = (external: boolean) => {
    checkPages();
    for (const page of pages) if (!permitted(siteOrigin(page.url)!, external)) throw new Error('LYRA_PERMISSION_REQUIRED');
  };
  // Asks for the first page not authorized under the notice of this route; false when the person has to answer first.
  const authorize = (external: boolean) => {
    for (const page of pages) {
      const origin = siteOrigin(page.url)!;
      if (host.decision(origin) === 'block') throw new Error('LYRA_PERMISSION_BLOCKED');
      if (!permitted(origin, external)) {
        state.route = external ? 'any' : 'local'; state.phase = 'permission'; state.permission = { id: randomUUID(), origin }; publish(); return false;
      }
    }
    return true;
  };
  const source = (item: Pick<DesktopItem, 'id' | 'title' | 'source'>, project?: string): LyraSource => ({ title: lyraPlainText(item.title).slice(0, 200), url: item.source?.url ?? null, ...(project ? { project } : {}), item: item.id });
  const answer = async (id: number, signal: AbortSignal) => {
    const asked = request!, shown = state.route;
    current(id, signal); checkPages();
    if (!authorize(shown === 'any')) return;
    state.phase = 'running'; state.permission = null; state.error = null; publish();
    // Connect first so an unavailable service never causes an unnecessary page read.
    const client = await connect(); current(id, signal); checkPages();
    // The routes and features are checked before any page is read, so a service that cannot answer never receives content.
    const routes = await lyraRoutes(client); current(id, signal); checkPages();
    if (!routes.local && !routes.external) throw { code: 'no_source' };
    // A question the person asks may use every source they approved in Lyra, unless what they were shown said the answer stays on this computer.
    // A retry follows the routes Lyra offers now, so a service upgraded mid-session is no longer held to the local route.
    const route = routes.protocol >= 2 && (shown === 'any' || refresh) ? 'any' : 'local';
    if (route !== shown) { state.route = route; publish(); }
    // Pages allowed under the local notice are asked again with the notice that says external sources may answer.
    if (!authorize(route === 'any')) return;
    // Saved items and notes reach an external source only after their own notice, accepted for this profile or for this turn.
    // An item another member shared through a Space is never covered by the profile's answer: its member had no say in it.
    const desktop = asked.task === 'project' || asked.task === 'item', shared = asked.task === 'item' && sharedItemId(asked.item);
    const desktopNoticed = !desktop || !shared && host.desktopExternal() || desktopGrant === true;
    if (route === 'any' && routes.external && !desktopNoticed && desktopGrant === undefined) {
      state.phase = 'permission'; state.permission = { id: randomUUID(), origin: null, ...(shared ? { shared: true as const } : {}) }; publish(); return;
    }
    // A turn shown as answered on this computer never becomes one external sources may answer: it stops on the line that now says so.
    if (route === 'any' && shown === 'local' && routes.external) throw new Error('LYRA_ROUTE_CHANGED');
    // A turn asked while the route line was not drawn stops the same way, with the line on screen, before anything is sent.
    if (route === 'any' && !lineShown && routes.external) throw new Error('LYRA_ROUTE_UNSEEN');
    // Only a turn an external source can take is sent with cloud: true.
    const cloud = route === 'any' && routes.external && desktopNoticed ? true as const : undefined;
    // What the person acted under, recorded before anything is sent: the route line on screen, every page's allow and the notice for saved items.
    const noticed = shown === 'any' && lineShown && desktopNoticed && pages.every(page => permitted(siteOrigin(page.url)!, true));
    const documents = [];
    for (const page of pages) {
      const origin = siteOrigin(page.url)!;
      const authorized = () => {
        checkPages(); current(id, signal);
        return permitted(origin, cloud === true);
      };
      const content = await readLyraPage(page.contents, page.url, authorized, host.privateWindow);
      documents.push({ source: { title: lyraPlainText(page.title).slice(0, 200), url: page.url, tab: page.id }, text: content });
    }
    if (asked.task === 'project') {
      const project = host.project(asked.project!);
      for (const item of project.items.slice(-50)) documents.push({ source: source(item, project.id), text: `${item.text}\n${item.note}`.slice(0, 6000) });
    } else if (asked.task === 'item') {
      const item = host.item(asked.project, asked.item!);
      documents.push({ source: source(item, asked.project ?? undefined), text: `${item.text}\n${item.note}`.slice(0, 6000) });
      if (item.image && !item.text.trim() && !item.note.trim()) throw new Error('LYRA_CAPTURE_TEXT_REQUIRED');
    }
    current(id, signal); checkAccess(cloud === true);
    const context = lyraContext(documents, previousAnswer), included = JSON.parse(context) as { documents: { source: LyraSource }[] };
    if (pages.length && included.documents.length !== pages.length) throw new Error('LYRA_CONTEXT_LIMIT');
    state.sources = included.documents.map(document => document.source); publish();
    const language = host.language();
    const instruction = text('lyraInstruction', language);
    // Fast has an explicit 2,048 output-token ceiling in Lyra's runtime. The client exposes no per-call override.
    const stream = lyraChat(client, { mode: 'fast', priority: 'interactive', language, context, cloud, messages: [{ role: 'user', content: `${instruction}\n${JSON.stringify({ task: asked.task, question: asked.question })}` }] }, noticed, { signal });
    let done = false;
    for await (const event of stream) {
      current(id, signal);
      if (event.type === 'error') throw { code: event.code };
      if (event.type === 'start' && event.source) { state.answeredBy = { id: event.source.id, kind: event.source.kind, model: lyraPlainText(event.source.model).slice(0, 120) }; publish(); }
      if (event.type === 'text') {
        if (state.answer.length + event.text.length > 16000) { controller?.abort(); throw new Error('LYRA_OUTPUT_LIMIT'); }
        state.answer += lyraPlainText(event.text); publish();
      } else if (event.type === 'done') done = true;
    }
    current(id, signal);
    if (!done || !state.answer.trim()) throw { code: 'empty' };
    state.phase = 'answer'; grants.clear(); publish();
  };
  const ask = (asked: Ask, retry = false) => {
    assertPublic();
    if (pendingWork || state.phase === 'permission' || state.phase === 'starting') throw new Error('LYRA_BUSY');
    if (asked.task === 'summary' && asked.tabs.length !== 1 || asked.task === 'comparison' && asked.tabs.length < 2
      || ['project', 'item'].includes(asked.task) && asked.tabs.length || asked.task === 'project' && !asked.project || asked.task === 'item' && !asked.item) throw new Error('LYRA_INVALID');
    if (asked.task === 'project') host.project(asked.project!);
    const item = asked.task === 'item' ? host.item(asked.project, asked.item!) : undefined;
    pages = asked.tabs.map(id => ({ ...host.page(id) }));
    lineShown = lyraRouteShown(state);
    previousAnswer = state.phase === 'answer' && request?.task === asked.task && request.project === asked.project && request.item === asked.item && request.tabs.join(',') === asked.tabs.join(',') ? state.answer : '';
    request = structuredClone(asked); refresh = retry; state.open = true; state.task = asked.task; state.question = asked.question;
    state.answer = ''; state.sources = []; state.error = null; state.answeredBy = null;
    // Only preview metadata crosses to chrome. Image bytes never enter a model request.
    state.attachment = item?.image ? { project: asked.project, item: { ...item, text: '', note: '', image: { width: item.image.width, height: item.image.height, bytes: item.image.bytes, cut: item.image.cut } } } : null;
    launch(answer);
  };
  const readiness = async (id: number, signal: AbortSignal) => {
    state.phase = 'checking'; state.error = null; publish();
    const client = await connect(); current(id, signal);
    const routes = await lyraRoutes(client); current(id, signal);
    state.route = routes.protocol >= 2 ? 'any' : 'local';
    if (routes.protocol < 2) {
      const models = await client.models.status(); current(id, signal);
      if (!models.ollama.installed) throw { code: 'ollama_missing' };
      if (!models.ollama.running) throw { code: 'ollama_unavailable' };
      if (!models.modes.fast.ready) throw { code: 'model_missing' };
    } else if (!routes.local && !routes.external) throw { code: 'no_source' };
    state.phase = 'home'; publish();
  };
  return {
    state: () => structuredClone(state), stop, close,
    async run(command: LyraCommand) {
      assertPublic();
      switch (command.type) {
        case 'lyra-open':
          state.open = true;
          if (!pendingWork && state.phase === 'home') launch(readiness);
          publish(); break;
        case 'lyra-close': close(); break;
        case 'lyra-home': stop(); Object.assign(state, initial(), { open: true }); request = undefined; launch(readiness); break;
        case 'lyra-cancel': stop(); fail('cancelled'); publish(); break;
        case 'lyra-ask': ask(command); break;
        case 'lyra-permission': {
          if (state.phase !== 'permission' || !state.permission || state.permission.id !== command.id) throw new Error('LYRA_PERMISSION_STALE');
          // A shared item's notice has no lasting answer.
          if (state.permission.shared && command.answer === 'site') throw new Error('LYRA_INVALID');
          try { checkPages(); } catch (error) { stop(); failed(error); break; }
          // The notice is answered with the route line on screen.
          lineShown = lyraRouteShown(state);
          const origin = state.permission.origin;
          // The answer is recorded with the notice it was given under.
          const external = state.route === 'any';
          // For saved items and notes, No keeps the turn on this computer instead of blocking anything.
          if (origin === null) {
            if (command.answer === 'site') host.allowDesktop();
            else desktopGrant = command.answer === 'once' && external;
          } else if (command.answer === 'deny') { stop(); failed(new Error('LYRA_PERMISSION_BLOCKED')); break; }
          else if (command.answer === 'site') host.allow(origin, external);
          else grants.set(origin, external);
          state.permission = null;
          // Keep the turn's one-time grants while each additional origin is authorized.
          controller = new AbortController(); const id = generation, signal = controller.signal;
          pendingWork = answer(id, signal).catch(error => { if (id === generation) failed(error); }).finally(() => { if (id === generation) pendingWork = undefined; });
          break;
        }
        case 'lyra-retry':
          if (pendingWork) break;
          if (request) { const previous = request; stop(); state.phase = 'failed'; ask(previous, true); }
          else launch(readiness);
          break;
        case 'lyra-start-ollama':
          if (pendingWork || state.phase === 'permission') throw new Error('LYRA_BUSY');
          launch(async (id, signal) => {
            state.phase = 'starting'; state.error = null; publish();
            const client = await connect(); current(id, signal);
            await client.ollama.start();
            current(id, signal); await readiness(id, signal);
          }); break;
        // Models, keys and connected CLIs are managed in Lyra's own app; Horizon only opens it.
        case 'lyra-manage': {
          let client: Client;
          try { client = await connect(); } catch { throw new Error('LYRA_APP_UNAVAILABLE'); }
          try { await client.app.open('models'); }
          catch (error) { throw new Error(failureCode(error) === 'app_missing' ? 'LYRA_APP_MISSING' : 'LYRA_APP_UNAVAILABLE'); }
          break;
        }
        case 'lyra-save':
          if (state.phase !== 'answer') throw new Error('LYRA_INVALID');
          host.save(command.project, lyraPlainText(`Lyra: ${state.question}`).replace(/\s+/g, ' ').slice(0, 200), state.answer, state.sources);
          state.open = false; publish(); break;
      }
    },
  };
}
