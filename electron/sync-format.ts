import { createCipheriv, createDecipheriv, randomBytes, randomUUID } from 'node:crypto';
import { gzipSync, gunzipSync } from 'node:zlib';
import { SYNC_ITEMS } from '../src/shared/api';
import type { SyncFailure, SyncItem } from '../src/shared/api';

export const SYNC_LIMITS = { package: 8 * 1024 * 1024, blob: 64 * 1024 * 1024, plain: 32 * 1024 * 1024, records: 100000, writers: 64, files: 10000, timeout: 10000 } as const;
export const uuid = (value: unknown): value is string => typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value);
export const shape = (value: unknown, keys: string[]): value is Record<string, unknown> => value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).length === keys.length && keys.every(key => Object.hasOwn(value, key));
export const integer = (value: unknown): value is number => typeof value === 'number' && Number.isSafeInteger(value) && value >= 0 && value <= 8640000000000000;
export function requireSync(condition: unknown, code: SyncFailure = 'SYNC_INVALID'): asserts condition { if (!condition) throw new Error(code); }
export function syncFailure(error: unknown): SyncFailure {
  const code = error instanceof Error ? error.message : '';
  if (['SYNC_INVALID', 'SYNC_NEWER_FORMAT', 'SYNC_WRONG_KEY', 'SYNC_STORAGE', 'SYNC_FOLDER', 'SYNC_FULL', 'SYNC_LIMIT', 'SYNC_TIMEOUT', 'SYNC_LOCKED', 'SYNC_GAP', 'SYNC_BLOB_PENDING', 'SYNC_CHANGED'].includes(code)) return code as SyncFailure;
  if (error && typeof error === 'object' && 'code' in error && ['ENOSPC', 'EDQUOT'].includes(String(error.code))) return 'SYNC_FULL';
  if (error && typeof error === 'object' && 'code' in error && ['ENOENT', 'ENOTDIR', 'EACCES', 'EIO', 'ENETUNREACH'].includes(String(error.code))) return 'SYNC_FOLDER';
  return 'SYNC_STORAGE';
}
export function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') return `{${Object.keys(value).sort().map(key => `${JSON.stringify(key)}:${canonical((value as Record<string, unknown>)[key])}`).join(',')}}`;
  return JSON.stringify(value);
}
export interface SyncRecord { item: SyncItem | 'computer'; profile: string | null; key: string; value: unknown }
export interface SyncOperation extends SyncRecord { id: string; base: string | null; time: number; device: string; generation: string; title?: string }
export interface KeptConflict { id: string; operation: SyncOperation }
export interface SyncPayload { version: 1; kind: 'batch' | 'checkpoint'; sequence: number; createdAt: number; operations: SyncOperation[]; conflicts: KeptConflict[] }
export interface SyncIdentity { dataset: string; device: string; generation: string; sequence: number; id: string; kind: 'batch' | 'checkpoint' | 'blob' | 'check' }
export const recordId = (record: SyncRecord) => canonical([record.item, record.profile, record.key]);
const magic = Buffer.from('HZSYNC\r\n'), HEADER = 46;
const kinds = ['batch', 'checkpoint', 'blob', 'check'] as const;
export function sealSync(key: Buffer, identity: SyncIdentity, value: unknown): Buffer {
  requireSync(key.length === 32);
  const plain = identity.kind === 'blob' ? value as Buffer : Buffer.from(canonical(value));
  requireSync(Buffer.isBuffer(plain) && plain.length <= (identity.kind === 'blob' ? SYNC_LIMITS.blob - HEADER : SYNC_LIMITS.plain), 'SYNC_LIMIT');
  const header = Buffer.alloc(HEADER); magic.copy(header); header[8] = 1; header[9] = kinds.indexOf(identity.kind); header.writeBigUInt64BE(BigInt(identity.sequence), 10);
  randomBytes(12).copy(header, 18);
  const cipher = createCipheriv('aes-256-gcm', key, header.subarray(18, 30)); cipher.setAAD(Buffer.from(canonical(identity)));
  const encrypted = Buffer.concat([cipher.update(identity.kind === 'blob' ? plain : gzipSync(plain)), cipher.final()]); cipher.getAuthTag().copy(header, 30);
  const bytes = Buffer.concat([header, encrypted]); requireSync(bytes.length <= (identity.kind === 'blob' ? SYNC_LIMITS.blob : SYNC_LIMITS.package), 'SYNC_LIMIT'); return bytes;
}
export function packageSequence(bytes: Buffer): number {
  requireSync(bytes.length >= HEADER && bytes.subarray(0, 8).equals(magic));
  requireSync(bytes[8] === 1, bytes[8]! > 1 ? 'SYNC_NEWER_FORMAT' : 'SYNC_INVALID');
  const sequence = Number(bytes.readBigUInt64BE(10)); requireSync(integer(sequence)); return sequence;
}
export function openSync(key: Buffer, identity: SyncIdentity, bytes: Buffer): unknown {
  requireSync(bytes.length <= (identity.kind === 'blob' ? SYNC_LIMITS.blob : SYNC_LIMITS.package), 'SYNC_LIMIT');
  requireSync(packageSequence(bytes) === identity.sequence && bytes[9] === kinds.indexOf(identity.kind));
  let compressed: Buffer;
  try {
    const cipher = createDecipheriv('aes-256-gcm', key, bytes.subarray(18, 30)); cipher.setAAD(Buffer.from(canonical(identity))); cipher.setAuthTag(bytes.subarray(30, 46));
    compressed = Buffer.concat([cipher.update(bytes.subarray(46)), cipher.final()]);
  } catch { throw new Error(identity.kind === 'check' ? 'SYNC_WRONG_KEY' : 'SYNC_INVALID'); }
  if (identity.kind === 'blob') return compressed;
  try { return JSON.parse(gunzipSync(compressed, { maxOutputLength: SYNC_LIMITS.plain }).toString('utf8')); } catch { throw new Error('SYNC_INVALID'); }
}
export function validateOperation(value: unknown): value is SyncOperation {
  const fields = ['item', 'profile', 'key', 'value', 'id', 'base', 'time', 'device', 'generation'];
  return (shape(value, fields) || shape(value, [...fields, 'title']) && value.value === null && typeof value.title === 'string' && value.title.length > 0 && value.title.length <= 200 && !/[\x00-\x1f\x7f-\x9f]/.test(value.title)) && (value.item === 'computer' || SYNC_ITEMS.includes(value.item as SyncItem))
    && (value.profile === null || uuid(value.profile)) && typeof value.key === 'string' && value.key.length > 0 && value.key.length <= 8192 && !/[\x00-\x1f]/.test(value.key)
    && uuid(value.id) && (value.base === null || uuid(value.base)) && integer(value.time) && uuid(value.device) && uuid(value.generation);
}
export function validatePayload(value: unknown, identity: SyncIdentity): asserts value is SyncPayload {
  requireSync(shape(value, ['version', 'kind', 'sequence', 'createdAt', 'operations', 'conflicts']));
  requireSync(value.version === 1, integer(value.version) && value.version > 1 ? 'SYNC_NEWER_FORMAT' : 'SYNC_INVALID');
  requireSync(value.kind === identity.kind && value.sequence === identity.sequence && integer(value.createdAt)
    && Array.isArray(value.operations) && value.operations.length <= SYNC_LIMITS.records && Array.isArray(value.conflicts) && value.conflicts.length <= SYNC_LIMITS.records);
  const records = new Set<string>(), ids = new Set<string>();
  for (const op of value.operations) {
    requireSync(validateOperation(op) && !records.has(recordId(op)) && !ids.has(op.id));
    if (identity.kind === 'batch') requireSync(op.device === identity.device && op.generation === identity.generation);
    if (op.item === 'computer') requireSync(op.key === op.device);
    records.add(recordId(op)); ids.add(op.id);
  }
  for (const conflict of value.conflicts) requireSync(shape(conflict, ['id', 'operation']) && uuid(conflict.id) && validateOperation(conflict.operation) && conflict.operation.item !== 'computer');
  requireSync(identity.kind === 'checkpoint' || value.conflicts.length === 0);
}
export interface DatasetParameters { magic: 'Horizon Sync'; version: 1; datasetId: string; keyType: 'random'; check: string }
export interface SyncKeySource { create(): Promise<{ key: Buffer; check: DatasetParameters }>; open(input: string, parameters: DatasetParameters): Promise<Buffer>; encode(key: Buffer): string }
export const checkIdentity = (dataset: string): SyncIdentity => ({ dataset, device: dataset, generation: dataset, sequence: 0, id: dataset, kind: 'check' });
export function validateDataset(value: unknown): asserts value is DatasetParameters {
  requireSync(shape(value, ['magic', 'version', 'datasetId', 'keyType', 'check']));
  requireSync(value.version === 1, integer(value.version) && value.version > 1 ? 'SYNC_NEWER_FORMAT' : 'SYNC_INVALID');
  requireSync(value.magic === 'Horizon Sync' && uuid(value.datasetId) && value.keyType === 'random' && typeof value.check === 'string' && value.check.length <= 1024);
  requireSync(Buffer.from(value.check, 'base64').toString('base64') === value.check);
}
export const randomSyncKeys: SyncKeySource = {
  async create() {
    const key = randomBytes(32), datasetId = randomUUID();
    return { key, check: { magic: 'Horizon Sync', version: 1, datasetId, keyType: 'random', check: sealSync(key, checkIdentity(datasetId), { check: 'Horizon Sync' }).toString('base64') } };
  },
  async open(input, parameters) {
    validateDataset(parameters); requireSync(typeof input === 'string' && /^hz1_[A-Za-z0-9_-]{43}$/.test(input), 'SYNC_WRONG_KEY');
    const key = Buffer.from(input.slice(4), 'base64url'); requireSync(key.length === 32 && this.encode(key) === input, 'SYNC_WRONG_KEY');
    const check = openSync(key, checkIdentity(parameters.datasetId), Buffer.from(parameters.check, 'base64'));
    requireSync(shape(check, ['check']) && check.check === 'Horizon Sync', 'SYNC_WRONG_KEY'); return key;
  },
  encode: key => `hz1_${key.toString('base64url')}`,
};
