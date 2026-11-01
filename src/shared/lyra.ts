export type LyraTask = 'summary' | 'comparison' | 'project' | 'item' | 'question';
export const LYRA_ADDRESS = 'horizon://lyra';
export interface LyraSource { title: string; url: string | null; tab?: string; project?: string; item?: string }
export type LyraPhase = 'home' | 'checking' | 'permission' | 'running' | 'answer' | 'failed' | 'starting';
// Where an answer may come from: 'local' when the service only answers on this computer (protocol 1), 'any' when Lyra routes through the sources the person set up.
export type LyraRoute = 'local' | 'any';
// The source that actually answered, from the start event of a protocol 2 turn.
export interface LyraAnsweredBy { id: string; kind: 'local' | 'key' | 'cli'; model: string }
export interface LyraState {
  open: boolean; phase: LyraPhase; task: LyraTask; question: string; answer: string;
  // The notice waiting for an answer: a site whose page Lyra needs to read, or null for saved items and notes that may leave this computer.
  // shared marks an item another member shared through a Space, which is asked per action and never covered by the profile's lasting answer.
  sources: LyraSource[]; permission: { id: string; origin: string | null; shared?: true } | null;
  attachment: { project: string | null; item: DesktopItemContent } | null;
  error: string | null; route: LyraRoute; answeredBy: LyraAnsweredBy | null;
}
export type LyraCommand =
  | { type: 'lyra-open' | 'lyra-close' | 'lyra-retry' | 'lyra-cancel' | 'lyra-manage' | 'lyra-start-ollama' | 'lyra-home' | 'lyra-tab' }
  | { type: 'lyra-ask'; task: LyraTask; question: string; tabs: string[]; project: string | null; item: string | null }
  | { type: 'lyra-permission'; id: string; answer: 'site' | 'once' | 'deny' }
  | { type: 'lyra-save'; project: string };

// The copy of each code Lyra or its client can answer, for the assistant and translation alike.
const LYRA_ERRORS: Record<string, string> = {
  not_installed: 'lyraNotInstalled', invalid_install: 'lyraUnavailable', unavailable: 'lyraUnavailable', service_lost: 'lyraServiceLost',
  model_missing: 'lyraModelMissing', ollama_unavailable: 'lyraOllamaUnavailable', ollama_missing: 'lyraOllamaMissing', no_source: 'lyraNoSource',
  pending: 'lyraAccessDenied', revoked: 'lyraAccessDenied', forbidden: 'lyraAccessDenied', cancelled: 'lyraCancelled',
  unsupported: 'lyraUnsupported', local_only: 'lyraLocalOnly', source_login: 'lyraSourceLogin', source_quota: 'lyraSourceQuota',
  source_unavailable: 'lyraSourceUnavailable', source_version: 'lyraSourceVersion', source_protocol: 'lyraSourceProtocol',
};
export const lyraErrorKey = (code: string): string | undefined => Object.hasOwn(LYRA_ERRORS, code) ? LYRA_ERRORS[code] : undefined;
// The failures only Lyra's own app can fix: models, keys, connected CLIs and the person's answer order.
export const lyraManaged = (code: string | null): boolean => ['model_missing', 'ollama_missing', 'no_source', 'unsupported', 'local_only', 'source_login', 'source_version', 'source_quota', 'TRANSLATE_LOCAL_REQUIRED'].includes(code ?? '');
// The product name of each CLI Lyra can answer through; key slots are named as an API key.
export const LYRA_CLI_NAMES: Record<string, string> = { claude: 'Claude Code', codex: 'Codex', cursor: 'Cursor', opencode: 'OpenCode', copilot: 'GitHub Copilot', antigravity: 'Antigravity' };

// Whether the panel draws the route line, which says where Lyra may answer from. It is left out only while Lyra is missing or broken.
// The main process reads the same answer for the state a question was asked from, so only a question asked under this line may use external sources.
export const lyraRouteShown = (lyra: Pick<LyraState, 'phase' | 'error'>): boolean => !(lyra.phase === 'failed' && ['not_installed', 'invalid_install'].includes(lyra.error ?? ''));

// Whether the translation bar shows the line that says page text may leave this computer: on an offer, before a request that may use external sources.
// The main process reads the same answer when the click arrives, so only a click taken under this line may use external sources.
// The bar is drawn only while the translation is open.
export function translationNotice(value: Pick<TranslateState, 'open' | 'phase' | 'error' | 'external'>): boolean {
  const failed = value.phase === 'failed', busy = value.phase === 'running' || value.phase === 'detecting';
  // A failed automatic run is retried locally; translating through an external source takes a new request by the person.
  const manual = failed && value.error === 'TRANSLATE_LOCAL_REQUIRED';
  return value.open && !busy && (!failed || manual) && value.phase !== 'translated' && value.external !== false;
}
// Whether the options menu shows the same line next to the target language, whose change is a new manual translation.
export const translationTargetNotice = (value: Pick<TranslateState, 'open' | 'external'>): boolean => value.open && value.external !== false;

export function validateLyraCommand(value: unknown): LyraCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('LYRA_INVALID');
  const command = value as Record<string, unknown>;
  const exact = (keys: string[]) => Object.hasOwn(command, 'type') && Object.keys(command).length === keys.length + 1 && keys.every(key => Object.hasOwn(command, key));
  const id = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\x00-\x1f]/.test(value);
  if (['lyra-open', 'lyra-close', 'lyra-retry', 'lyra-cancel', 'lyra-manage', 'lyra-start-ollama', 'lyra-home', 'lyra-tab'].includes(String(command.type)) && exact([])) return value as LyraCommand;
  if (command.type === 'lyra-save' && exact(['project']) && id(command.project)) return value as LyraCommand;
  if (command.type === 'lyra-permission' && exact(['id', 'answer']) && id(command.id) && ['site', 'once', 'deny'].includes(String(command.answer))) return value as LyraCommand;
  if (command.type === 'lyra-ask' && exact(['task', 'question', 'tabs', 'project', 'item'])
    && ['summary', 'comparison', 'project', 'item', 'question'].includes(String(command.task))
    && typeof command.question === 'string' && command.question.length <= 2000 && command.question.trim().length > 0 && !/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(command.question)
    && Array.isArray(command.tabs) && command.tabs.length <= 4 && Array.from(command.tabs).every(id) && new Set(command.tabs).size === command.tabs.length
    && (command.project === null || id(command.project)) && (command.item === null || id(command.item))) return value as LyraCommand;
  throw new Error('LYRA_INVALID');
}
import type { DesktopItemContent } from './api';
import type { TranslateState } from './translate';
