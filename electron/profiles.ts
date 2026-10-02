import { chmodSync, existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, unlinkSync, writeFileSync } from 'node:fs';
import { dirname, isAbsolute, relative, resolve, sep } from 'node:path';
import { randomUUID } from 'node:crypto';
import { PROFILE_COLORS } from '../src/shared/api';
import type { Language, Profile, ProfileColor } from '../src/shared/api';
import { text } from '../src/copy';
import { readStore, writeStore } from './store';
import type { StoreCipher } from './store';

export interface ProfileRegistry { version: 1; activeId: string; profiles: Profile[]; tombstones: string[] }
const REGISTRY_LIMIT = 64 * 1024;
export const PROFILE_LIMIT = 20;
export function isProfileId(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
}
export function isProfileColor(value: unknown): value is ProfileColor { return PROFILE_COLORS.some(color => color === value); }
export function isProfilePartition(value: unknown): value is string {
  return value === 'persist:web' || typeof value === 'string' && value.startsWith('persist:profile-') && isProfileId(value.slice('persist:profile-'.length));
}
export function profileName(value: unknown): string {
  if (typeof value !== 'string' || /[\u0000-\u001f\u007f-\u009f]/.test(value)) throw new Error('PROFILE_NAME_INVALID');
  const name = value.trim();
  if (!name) throw new Error('PROFILE_NAME_EMPTY');
  if (name.length > 40) throw new Error('PROFILE_NAME_LONG');
  return name;
}
function object(value: unknown, keys: string[]): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
}
export function validateRegistry(value: unknown): value is ProfileRegistry {
  if (!object(value, ['version', 'activeId', 'profiles', 'tombstones']) || value.version !== 1 || !isProfileId(value.activeId)
    || !Array.isArray(value.profiles) || !value.profiles.length || value.profiles.length > PROFILE_LIMIT
    || !Array.isArray(value.tombstones) || value.tombstones.length > 512) return false;
  const ids = new Set<string>(), names = new Set<string>(), partitions = new Set<string>();
  for (const profile of value.profiles) {
    if (!object(profile, ['id', 'name', 'color', 'partition', 'createdAt']) || !isProfileId(profile.id)
      || !isProfilePartition(profile.partition) || !isProfileColor(profile.color)
      || typeof profile.createdAt !== 'number' || !Number.isSafeInteger(profile.createdAt) || profile.createdAt < 0 || profile.createdAt > 8640000000000000) return false;
    let name: string;
    try { name = profileName(profile.name); } catch { return false; }
    if (name !== profile.name || ids.has(profile.id) || names.has(name.toLowerCase()) || partitions.has(profile.partition)) return false;
    ids.add(profile.id); names.add(name.toLowerCase()); partitions.add(profile.partition);
  }
  const dead = new Set<string>();
  for (const partition of value.tombstones) {
    if (!isProfilePartition(partition) || partitions.has(partition) || dead.has(partition)) return false;
    dead.add(partition);
  }
  return ids.has(value.activeId);
}
export function makeProfile(name: string, color: ProfileColor, legacy = false): Profile {
  const id = randomUUID();
  return { id, name: profileName(name), color, partition: legacy ? 'persist:web' : `persist:profile-${id}`, createdAt: Date.now() };
}
export function writeRegistry(path: string, registry: ProfileRegistry): void {
  if (!validateRegistry(registry)) throw new Error('Invalid profile registry');
  const json = JSON.stringify(registry);
  if (Buffer.byteLength(json) > REGISTRY_LIMIT) throw new Error('Profile registry exceeds size limit');
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${randomUUID()}.tmp`;
  try { writeFileSync(temporary, json, { flag: 'wx', mode: 0o600 }); renameSync(temporary, path); }
  finally { if (existsSync(temporary)) unlinkSync(temporary); }
}
export function readRegistry(path: string, language: Language): ProfileRegistry {
  const personal = makeProfile(text('personal', language), 'amber', true);
  const defaults: ProfileRegistry = { version: 1, activeId: personal.id, profiles: [personal, makeProfile(text('work', language), 'blue')], tombstones: [] };
  try {
    if (!existsSync(path)) { writeRegistry(path, defaults); return defaults; }
    try {
      if (statSync(path).size > REGISTRY_LIMIT) throw new Error('Profile registry exceeds size limit');
      const value: unknown = JSON.parse(readFileSync(path, 'utf8'));
      if (!validateRegistry(value)) throw new Error('Invalid profile registry');
      return value;
    } catch { renameSync(path, `${path}.corrupt-${randomUUID()}`); writeRegistry(path, defaults); }
  } catch { /* Read-only disks still allow browsing with the defaults in memory. */ }
  return defaults;
}
export function profileStorePath(userData: string, id: string): string {
  if (!isProfileId(id)) throw new Error('Invalid profile id');
  return resolve(userData, 'profiles', id, 'browser-store.json');
}
export function migrateStore(userData: string, registry: ProfileRegistry, cipher?: StoreCipher): void {
  const personal = registry.profiles.find(profile => profile.partition === 'persist:web');
  const legacy = resolve(userData, 'browser-store.json');
  if (!personal || !existsSync(legacy)) return;
  const destination = profileStorePath(userData, personal.id);
  // A crash before archiving must not replace newer profile data on retry.
  const status = { readError: false, memoryOnly: false };
  const store = readStore(legacy, undefined, status);
  if (status.readError) throw new Error('Profile migration store could not be read');
  if (!existsSync(destination)) writeStore(destination, store, cipher);
  chmodSync(legacy, 0o600);
  renameSync(legacy, `${legacy}.migrated`);
}
export function removeProfileDirectory(rootPath: string, leaf: string): void {
  const root = resolve(rootPath), target = resolve(root, leaf);
  if (dirname(target) !== root || target === root) throw new Error('Unsafe profile directory');
  const entry = (path: string) => {
    try { return lstatSync(path); } catch (error: unknown) {
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === 'ENOENT') return undefined;
      throw error;
    }
  };
  const rootEntry = entry(root);
  if (!rootEntry) return;
  // Reject junctions at the root as well as the leaf before any recursive removal.
  if (rootEntry.isSymbolicLink() || !rootEntry.isDirectory()) throw new Error('Unsafe profile directory');
  const targetEntry = entry(target);
  if (!targetEntry) return;
  if (targetEntry.isSymbolicLink()) throw new Error('Unsafe profile directory');
  const local = relative(realpathSync(root), realpathSync(target));
  if (local === '..' || local.startsWith(`..${sep}`) || isAbsolute(local)) throw new Error('Unsafe profile directory');
  rmSync(target, { recursive: true, force: true });
}
export function cleanupPartitions(sessionData: string, registryPath: string, registry: ProfileRegistry, userData = sessionData): ProfileRegistry {
  if (!validateRegistry(registry)) throw new Error('Invalid profile registry');
  // Electron 44's MakePartitionName lowercases and path-escapes the suffix; our UUID names need no escaping.
  for (const partition of registry.tombstones) removeProfileDirectory(resolve(sessionData, 'Partitions'), partition.slice('persist:'.length));
  if (!registry.tombstones.length) return registry;
  const stores = resolve(userData, 'profiles');
  // Personal's legacy partition does not encode its UUID, so the registry identifies remaining stores.
  if (existsSync(stores)) for (const id of readdirSync(stores)) {
    if (isProfileId(id) && !registry.profiles.some(profile => profile.id === id)) removeProfileDirectory(stores, id);
  }
  const next = { ...registry, tombstones: [] };
  writeRegistry(registryPath, next);
  return next;
}
