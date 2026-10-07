export type LyraTask = 'summary' | 'comparison' | 'project' | 'item' | 'question';
export const LYRA_ADDRESS = 'horizon://lyra';
export interface LyraSource { title: string; url: string | null; tab?: string; project?: string; item?: string }
export type LyraPhase = 'home' | 'checking' | 'permission' | 'running' | 'answer' | 'failed' | 'installing';
export interface LyraState {
  open: boolean; phase: LyraPhase; task: LyraTask; question: string; answer: string;
  sources: LyraSource[]; permission: { id: string; origin: string } | null;
  attachment: { project: string | null; item: DesktopItemContent } | null;
  error: string | null; progress: { completed: number; total: number } | null;
}
export type LyraCommand =
  | { type: 'lyra-open' | 'lyra-close' | 'lyra-retry' | 'lyra-cancel' | 'lyra-install' | 'lyra-start-ollama' | 'lyra-home' | 'lyra-tab' }
  | { type: 'lyra-ask'; task: LyraTask; question: string; tabs: string[]; project: string | null; item: string | null }
  | { type: 'lyra-permission'; id: string; answer: 'site' | 'once' | 'deny' }
  | { type: 'lyra-save'; project: string };

export function validateLyraCommand(value: unknown): LyraCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('LYRA_INVALID');
  const command = value as Record<string, unknown>;
  const exact = (keys: string[]) => Object.hasOwn(command, 'type') && Object.keys(command).length === keys.length + 1 && keys.every(key => Object.hasOwn(command, key));
  const id = (value: unknown) => typeof value === 'string' && value.length > 0 && value.length <= 128 && !/[\x00-\x1f]/.test(value);
  if (['lyra-open', 'lyra-close', 'lyra-retry', 'lyra-cancel', 'lyra-install', 'lyra-start-ollama', 'lyra-home', 'lyra-tab'].includes(String(command.type)) && exact([])) return value as LyraCommand;
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
