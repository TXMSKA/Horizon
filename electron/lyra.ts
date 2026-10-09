import { randomUUID } from 'node:crypto';
import type { Client } from 'horizon-lyra' with { 'resolution-mode': 'import' };
import type { DesktopItem, Language, PermissionDecision, ProjectContent } from '../src/shared/api';
import type { LyraCommand, LyraSource, LyraState } from '../src/shared/lyra';
import { text } from '../src/copy';
import { lyraContext, lyraPlainText, readLyraPage } from './lyra-context';
import { siteOrigin } from './site-settings';

type Ask = Extract<LyraCommand, { type: 'lyra-ask' }>;
export interface LyraPage {
  id: string; url: string; title: string; generation: number;
  contents: Parameters<typeof readLyraPage>[0];
}
export interface LyraHost {
  privateWindow: boolean; alive(): boolean; language(): Language; changed(): void;
  page(id: string): LyraPage; decision(origin: string): PermissionDecision; allow(origin: string): void;
  project(id: string): ProjectContent; item(project: string | null, id: string): DesktopItem;
  save(project: string, title: string, answer: string, sources: LyraSource[]): void;
  connect(): Promise<Client>;
}
const initial = (): LyraState => ({ open: false, phase: 'home', task: 'question', question: '', answer: '', sources: [], permission: null, attachment: null, error: null, progress: null });
const failureCode = (error: unknown): string => {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') return error.code;
  return error instanceof Error && /^(LYRA_|DESKTOP_|PROJECT_|SITE_SETTINGS_)/.test(error.message) ? error.message : 'unavailable';
};
export function createLyra(host: LyraHost) {
  const state = initial();
  let generation = 0, controller: AbortController | undefined, request: Ask | undefined;
  let pages: LyraPage[] = [];
  let previousAnswer = '';
  const grants = new Set<string>();
  let pendingWork: Promise<void> | undefined;
  const publish = () => { if (host.alive()) host.changed(); };
  const stop = () => { generation++; controller?.abort(); controller = undefined; state.permission = null; grants.clear(); pendingWork = undefined; };
  const close = () => { state.open = false; stop(); if (['running', 'permission', 'checking', 'installing'].includes(state.phase)) { state.phase = 'failed'; state.error = 'cancelled'; } publish(); };
  const assertPublic = () => { if (host.privateWindow || !host.alive()) throw new Error('LYRA_PRIVATE'); };
  const failed = (error: unknown) => { state.phase = 'failed'; state.error = failureCode(error); state.permission = null; publish(); };
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
  const checkAccess = () => {
    checkPages();
    for (const page of pages) {
      const origin = siteOrigin(page.url)!, decision = host.decision(origin);
      if (decision !== 'allow' && !(decision === 'ask' && grants.has(origin))) throw new Error('LYRA_PERMISSION_REQUIRED');
    }
  };
  const source = (item: Pick<DesktopItem, 'id' | 'title' | 'source'>, project?: string): LyraSource => ({ title: lyraPlainText(item.title).slice(0, 200), url: item.source?.url ?? null, ...(project ? { project } : {}), item: item.id });
  const answer = async (id: number, signal: AbortSignal) => {
    const asked = request!;
    current(id, signal); checkPages();
    for (const page of pages) {
      const origin = siteOrigin(page.url)!;
      const decision = host.decision(origin);
      if (decision === 'block') throw new Error('LYRA_PERMISSION_BLOCKED');
      if (decision !== 'allow' && !grants.has(origin)) {
        state.phase = 'permission'; state.permission = { id: randomUUID(), origin }; publish(); return;
      }
    }
    state.phase = 'running'; state.permission = null; state.error = null; publish();
    // Connect first so an unavailable service never causes an unnecessary page read.
    const client = await host.connect(); current(id, signal); checkPages();
    const documents = [];
    for (const page of pages) {
      const origin = siteOrigin(page.url)!;
      const authorized = () => {
        checkPages(); current(id, signal);
        return host.decision(origin) === 'allow' || host.decision(origin) === 'ask' && grants.has(origin);
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
    current(id, signal); checkAccess();
    const context = lyraContext(documents, previousAnswer), included = JSON.parse(context) as { documents: { source: LyraSource }[] };
    if (pages.length && included.documents.length !== pages.length) throw new Error('LYRA_CONTEXT_LIMIT');
    state.sources = included.documents.map(document => document.source); publish();
    const language = host.language();
    const instruction = text('lyraInstruction', language);
    // Fast has an explicit 2,048 output-token ceiling in Lyra's runtime. The client exposes no per-call override.
    const stream = client.chat({ mode: 'fast', priority: 'interactive', language, context, messages: [{ role: 'user', content: `${instruction}\n${JSON.stringify({ task: asked.task, question: asked.question })}` }] }, { signal });
    let done = false;
    for await (const event of stream) {
      current(id, signal);
      if (event.type === 'error') throw { code: event.code };
      if (event.type === 'text') {
        if (state.answer.length + event.text.length > 16000) { controller?.abort(); throw new Error('LYRA_OUTPUT_LIMIT'); }
        state.answer += lyraPlainText(event.text); publish();
      } else if (event.type === 'done') done = true;
    }
    current(id, signal);
    if (!done || !state.answer.trim()) throw { code: 'empty' };
    state.phase = 'answer'; grants.clear(); publish();
  };
  const ask = (asked: Ask) => {
    assertPublic();
    if (pendingWork || state.phase === 'permission' || state.phase === 'installing') throw new Error('LYRA_BUSY');
    if (asked.task === 'summary' && asked.tabs.length !== 1 || asked.task === 'comparison' && asked.tabs.length < 2
      || ['project', 'item'].includes(asked.task) && asked.tabs.length || asked.task === 'project' && !asked.project || asked.task === 'item' && !asked.item) throw new Error('LYRA_INVALID');
    if (asked.task === 'project') host.project(asked.project!);
    const item = asked.task === 'item' ? host.item(asked.project, asked.item!) : undefined;
    pages = asked.tabs.map(id => ({ ...host.page(id) }));
    previousAnswer = state.phase === 'answer' && request?.task === asked.task && request.project === asked.project && request.item === asked.item && request.tabs.join(',') === asked.tabs.join(',') ? state.answer : '';
    request = structuredClone(asked); state.open = true; state.task = asked.task; state.question = asked.question;
    state.answer = ''; state.sources = []; state.error = null; state.progress = null;
    // Only preview metadata crosses to chrome. Image bytes never enter a model request.
    state.attachment = item?.image ? { project: asked.project, item: { ...item, text: '', note: '', image: { width: item.image.width, height: item.image.height, bytes: item.image.bytes, cut: item.image.cut } } } : null;
    launch(answer);
  };
  const readiness = async (id: number, signal: AbortSignal) => {
    state.phase = 'checking'; state.error = null; publish();
    const client = await host.connect(); current(id, signal);
    const models = await client.models.status(); current(id, signal);
    if (!models.ollama.installed) throw { code: 'ollama_missing' };
    if (!models.ollama.running) throw { code: 'ollama_unavailable' };
    if (!models.modes.fast.ready) throw { code: 'model_missing' };
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
        case 'lyra-cancel': stop(); state.phase = 'failed'; state.error = 'cancelled'; publish(); break;
        case 'lyra-ask': ask(command); break;
        case 'lyra-permission': {
          if (state.phase !== 'permission' || !state.permission || state.permission.id !== command.id) throw new Error('LYRA_PERMISSION_STALE');
          try { checkPages(); } catch (error) { stop(); failed(error); break; }
          const origin = state.permission.origin;
          if (command.answer === 'deny') { stop(); failed(new Error('LYRA_PERMISSION_BLOCKED')); break; }
          if (command.answer === 'site') host.allow(origin);
          else grants.add(origin);
          state.permission = null;
          // Keep the turn's one-time grants while each additional origin is authorized.
          controller = new AbortController(); const id = generation, signal = controller.signal;
          pendingWork = answer(id, signal).catch(error => { if (id === generation) failed(error); }).finally(() => { if (id === generation) pendingWork = undefined; });
          break;
        }
        case 'lyra-retry':
          if (pendingWork) break;
          if (request) { const previous = request; stop(); state.phase = 'failed'; ask(previous); }
          else launch(readiness);
          break;
        case 'lyra-install': case 'lyra-start-ollama':
          if (pendingWork || state.phase === 'permission') throw new Error('LYRA_BUSY');
          launch(async (id, signal) => {
            state.phase = 'installing'; state.error = null; publish();
            const client = await host.connect(); current(id, signal);
            if (command.type === 'lyra-start-ollama') await client.ollama.start();
            else for await (const event of client.models.install('light')) {
              current(id, signal);
              if (event.type === 'error') throw { code: event.code };
              if (event.type === 'step') { state.progress = { completed: event.completed, total: event.total }; publish(); }
            }
            current(id, signal); await readiness(id, signal);
          }); break;
        case 'lyra-save':
          if (state.phase !== 'answer') throw new Error('LYRA_INVALID');
          host.save(command.project, lyraPlainText(`Lyra: ${state.question}`).replace(/\s+/g, ' ').slice(0, 200), state.answer, state.sources);
          state.open = false; publish(); break;
      }
    },
  };
}
