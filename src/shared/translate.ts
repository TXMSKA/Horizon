import type { Language } from './api';

export interface TranslationChoices { always: { language: string; target: Language }[]; never: string[] }
export interface TranslateState {
  open: boolean; phase: 'idle' | 'detecting' | 'offered' | 'running' | 'translated' | 'original' | 'failed';
  source: string | null; target: Language; error: string | null;
}
export type TranslateCommand =
  | { type: 'translate-open' | 'translate-start' | 'translate-original' | 'translate-close' | 'translate-cancel' | 'translate-retry' }
  | { type: 'translate-target'; value: Language }
  | { type: 'translate-always' | 'translate-never'; enabled: boolean };

export function pageLanguage(value: unknown): string | null {
  if (typeof value !== 'string' || value.length > 80 || !/^[a-z]{2,3}(?:-[a-z0-9]{2,8})*$/i.test(value.trim())) return null;
  return value.trim().split('-')[0]!.toLowerCase();
}
export function validateTranslateCommand(value: unknown): TranslateCommand {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('TRANSLATE_INVALID');
  const command = value as Record<string, unknown>;
  const exact = (key?: string) => Object.hasOwn(command, 'type') && Object.keys(command).length === (key ? 2 : 1) && (!key || Object.hasOwn(command, key));
  if (['translate-open', 'translate-start', 'translate-original', 'translate-close', 'translate-cancel', 'translate-retry'].includes(String(command.type)) && exact()) return value as TranslateCommand;
  if (command.type === 'translate-target' && exact('value') && (command.value === 'en' || command.value === 'es')) return value as TranslateCommand;
  if (['translate-always', 'translate-never'].includes(String(command.type)) && exact('enabled') && typeof command.enabled === 'boolean') return value as TranslateCommand;
  throw new Error('TRANSLATE_INVALID');
}
