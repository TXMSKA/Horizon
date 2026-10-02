import { existsSync, mkdirSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname } from 'node:path';
import { randomUUID } from 'node:crypto';
import type { Contrast, DarkPagesMode, DarkStrength, DarkTone, Theme } from '../src/shared/api';

interface LegacySettings { version: 1; theme: Theme; contrast?: Contrast }
interface Settings { version: 2; theme: Theme; contrast: Contrast; darkPages: DarkPagesMode; darkStrength: DarkStrength; darkTone: DarkTone }
export interface ThemeSettings { readonly theme: Theme; readonly contrast: Contrast; readonly darkPages: DarkPagesMode; readonly darkStrength: DarkStrength; readonly darkTone: DarkTone; readonly migrationAllowed: boolean; setTheme(value: Theme, migrate: boolean): void; setContrast(value: Contrast): void; setDarkPages(value: DarkPagesMode): void; setDarkStrength(value: DarkStrength): void; setDarkTone(value: DarkTone): void }

export function isTheme(value: unknown): value is Theme { return value === 'system' || value === 'amber' || value === 'daylight'; }
export function isContrast(value: unknown): value is Contrast { return value === 'standard' || value === 'high'; }
export function isDarkPagesMode(value: unknown): value is DarkPagesMode { return value === 'off' || value === 'on' || value === 'system'; }
export function isDarkStrength(value: unknown): value is DarkStrength { return value === 'soft' || value === 'standard' || value === 'deep'; }
export function isDarkTone(value: unknown): value is DarkTone { return value === 'neutral' || value === 'warm'; }
function legacySettings(value: unknown): value is LegacySettings {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && (Object.keys(value).length === 2 || Object.keys(value).length === 3 && Object.hasOwn(value, 'contrast') && 'contrast' in value && isContrast(value.contrast))
    && Object.hasOwn(value, 'version') && Object.hasOwn(value, 'theme') && 'version' in value && value.version === 1 && 'theme' in value && isTheme(value.theme);
}
export function validateSettings(value: unknown): value is Settings {
  return typeof value === 'object' && value !== null && !Array.isArray(value) && Object.keys(value).length === 6
    && ['version', 'theme', 'contrast', 'darkPages', 'darkStrength', 'darkTone'].every(key => Object.hasOwn(value, key))
    && 'version' in value && value.version === 2 && 'theme' in value && isTheme(value.theme) && 'contrast' in value && isContrast(value.contrast)
    && 'darkPages' in value && isDarkPagesMode(value.darkPages) && 'darkStrength' in value && isDarkStrength(value.darkStrength) && 'darkTone' in value && isDarkTone(value.darkTone);
}
export function writeSettings(path: string, settings: Settings): void {
  if (!validateSettings(settings)) throw new Error('Invalid settings');
  mkdirSync(dirname(path), { recursive: true });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, JSON.stringify(settings), { flag: 'wx', mode: 0o600 }); renameSync(temporary, path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
export function readSettings(path: string, highContrast = false): Settings {
  const empty: Settings = { version: 2, theme: 'system', contrast: 'standard', darkPages: 'off', darkStrength: 'standard', darkTone: 'neutral' };
  try {
    if (!existsSync(path)) {
      empty.contrast = highContrast ? 'high' : 'standard';
      writeSettings(path, empty); return empty;
    }
    let settings: Settings;
    let migrated = false;
    try {
      if (statSync(path).size > 4096) throw new Error('Settings exceed size limit');
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (legacySettings(value)) { settings = { ...empty, ...value, version: 2 }; migrated = true; }
      else if (validateSettings(value)) settings = value;
      else throw new Error('Invalid settings');
    } catch {
      renameSync(path, `${path}.corrupt-${randomUUID()}`); writeSettings(path, empty); return empty;
    }
    // A valid legacy file must remain usable even when its migration cannot be saved.
    if (migrated) try { writeSettings(path, settings); } catch { /* The next writable launch can persist the migration. */ }
    return settings;
  } catch { /* An unavailable profile must still allow startup with the resolved defaults. */ }
  return empty;
}
export function createSettings(path: string, changed: (theme: Theme) => void, highContrast = false): ThemeSettings {
  let migrationAllowed = !existsSync(path);
  let settings = readSettings(path, highContrast);
  const save = (next: Settings) => {
    writeSettings(path, next); settings = next; migrationAllowed = false; changed(settings.theme);
  };
  return {
    get theme() { return settings.theme; },
    get contrast() { return settings.contrast; },
    get darkPages() { return settings.darkPages; },
    get darkStrength() { return settings.darkStrength; },
    get darkTone() { return settings.darkTone; },
    get migrationAllowed() { return migrationAllowed; },
    setTheme(value, migrate) {
      if (!isTheme(value)) throw new Error('Invalid theme');
      if (migrate && !migrationAllowed) return;
      save({ ...settings, theme: value });
    },
    setContrast(value) {
      if (!isContrast(value)) throw new Error('Invalid contrast');
      save({ ...settings, contrast: value });
    },
    setDarkPages(value) {
      if (!isDarkPagesMode(value)) throw new Error('Invalid dark pages mode');
      save({ ...settings, darkPages: value });
    },
    setDarkStrength(value) {
      if (!isDarkStrength(value)) throw new Error('Invalid dark strength');
      save({ ...settings, darkStrength: value });
    },
    setDarkTone(value) {
      if (!isDarkTone(value)) throw new Error('Invalid dark tone');
      save({ ...settings, darkTone: value });
    },
  };
}
