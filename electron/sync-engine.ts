import { createHash, randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, statSync, unlinkSync } from 'node:fs';
import { basename, resolve } from 'node:path';
import { hostname } from 'node:os';
import { SYNC_ITEMS } from '../src/shared/api';
import type { DesktopItem, SyncComputer, SyncFailure, SyncItem, SyncState } from '../src/shared/api';
import { canonical, integer, randomSyncKeys, recordId, requireSync, sealSync, shape, syncFailure, SYNC_LIMITS, uuid, validateDataset, validateOperation } from './sync-format';
import type { DatasetParameters, KeptConflict, SyncIdentity, SyncKeySource, SyncOperation, SyncPayload, SyncRecord } from './sync-format';
import { blobReference, computerName, mergeOperation, projectSnapshot, recordTitle, snapshotRecords, syncEnabled, validateRecord } from './sync-model';
import type { BlobReference, SyncSnapshot } from './sync-model';
import { atomicSyncFile, readSyncState, syncStorageAvailable, writeSyncState } from './sync-storage';
import type { SyncCipher } from './sync-storage';
import { datasetFolder, decodeSync, FolderTransport, objectName, validBatch, validCheckpoint, writerParts } from './sync-transport';

export interface SyncHost {
  read(): SyncSnapshot;
  image(profile: string, item: DesktopItem): Buffer | null;
  apply(snapshot: SyncSnapshot, images: Map<string, Buffer>): () => void;
  committed?(): void;
  changed(): void;
}
interface OutgoingFile { file: string; parts: string[]; cap: number }
interface Outbox { files: OutgoingFile[]; operations: SyncOperation[]; snapshot: SyncRecord[]; sequence: number; checkpoint: number }
interface RecordEdit { record: SyncRecord; time: number; title: string }
interface EngineState {
  version: 1; folder: string; dataset: DatasetParameters; key: string; binding: string; device: string; generation: string; sequence: number;
  mapping: Record<string, string>; switches: Record<SyncItem, boolean>; records: SyncOperation[]; snapshot: SyncRecord[]; conflicts: KeptConflict[];
  cursors: Record<string, number>; blobs: Record<string, BlobReference>; outbox: Outbox | null; operationsSinceCheckpoint: number; checkpointSequence: number;
  lastSynced: number | null; joining: boolean; fresh: SyncItem[];
  application: string | null;
  dirty: Partial<Record<SyncItem, number>>; ownBatches: Record<string, number>; ownCheckpoints: Record<string, number>;
  edits: RecordEdit[];
}
const switches = (): Record<SyncItem, boolean> => ({ profiles: true, favorites: true, history: false, tabs: true, desktop: true, siteSettings: true, settings: true });
export const emptySyncState = (): SyncState => ({ configured: false, folderName: null, lastSynced: null, switches: switches(), failure: null, conflicts: [], computers: [], syncing: false });
const blobKey = (profile: string, item: DesktopItem) => canonical([profile, item.id, item.image?.filename, item.image?.bytes]);
const blobFileKey = (reference: BlobReference) => canonical(reference);
const ownRecord = (record: SyncRecord, device: string) => !['tabs', 'computer'].includes(record.item) || record.key === device;
function validateState(value: unknown): asserts value is EngineState {
  const fields = ['version', 'folder', 'dataset', 'key', 'binding', 'device', 'generation', 'sequence', 'mapping', 'switches', 'records', 'snapshot', 'conflicts', 'cursors', 'blobs', 'outbox', 'operationsSinceCheckpoint', 'checkpointSequence', 'lastSynced', 'joining', 'fresh', 'application'];
  if (shape(value, fields)) Object.assign(value, { dirty: {}, ownBatches: {}, ownCheckpoints: {} });
  const previous = [...fields, 'dirty', 'ownBatches', 'ownCheckpoints'];
  if (shape(value, previous)) Object.assign(value, { edits: [] });
  requireSync(shape(value, [...previous, 'edits']) && value.version === 1);
  requireSync(Array.isArray(value.edits) && value.edits.length <= SYNC_LIMITS.records);
  const edits = new Set<string>();
  for (const edit of value.edits) {
    requireSync(shape(edit, ['record', 'time', 'title']) && shape(edit.record, ['item', 'profile', 'key', 'value']) && integer(edit.time) && typeof edit.title === 'string' && edit.title.length > 0 && edit.title.length <= 200 && !/[\x00-\x1f\x7f-\x9f]/.test(edit.title));
    const record = edit.record as unknown as SyncRecord; requireSync(validateOperation({ ...record, id: value.device, base: null, time: edit.time, device: value.device, generation: value.generation })); validateRecord(record);
    requireSync(!edits.has(recordId(record))); edits.add(recordId(record));
  }
  for (const field of ['dirty', 'ownBatches', 'ownCheckpoints'] as const) requireSync(value[field] !== null && typeof value[field] === 'object' && !Array.isArray(value[field]) && Object.keys(value[field]).length <= SYNC_LIMITS.files && Object.values(value[field]).every(integer));
  requireSync(Object.keys(value.dirty as object).every(item => SYNC_ITEMS.includes(item as SyncItem)) && Object.keys(value.ownBatches as object).every(validBatch) && Object.keys(value.ownCheckpoints as object).every(validCheckpoint));
  requireSync(value.application === null || uuid(value.application));
  validateDataset(value.dataset);
  requireSync(typeof value.folder === 'string' && value.folder.length <= 4096 && typeof value.key === 'string' && /^[A-Za-z0-9+/]{43}=$/.test(value.key) && typeof value.binding === 'string' && uuid(value.device) && uuid(value.generation) && integer(value.sequence));
  requireSync(shape(value.switches, [...SYNC_ITEMS]) && Object.values(value.switches).every(entry => typeof entry === 'boolean'));
  for (const field of ['mapping', 'cursors', 'blobs'] as const) requireSync(value[field] !== null && typeof value[field] === 'object' && !Array.isArray(value[field]) && Object.keys(value[field]).length <= SYNC_LIMITS.records);
  requireSync(Object.entries(value.mapping as object).every(([key, id]) => uuid(key) && uuid(id)) && Object.values(value.cursors as object).every(integer));
  requireSync(Array.isArray(value.records) && value.records.length <= SYNC_LIMITS.records && value.records.every(validateOperation) && Array.isArray(value.snapshot) && value.snapshot.length <= SYNC_LIMITS.records && Array.isArray(value.conflicts) && value.conflicts.length <= SYNC_LIMITS.records);
  for (const record of value.records) validateRecord(record);
  for (const record of value.snapshot) { requireSync(shape(record, ['item', 'profile', 'key', 'value'])); validateRecord(record as unknown as SyncRecord); }
  for (const conflict of value.conflicts) requireSync(shape(conflict, ['id', 'operation']) && uuid(conflict.id) && validateOperation(conflict.operation) && conflict.operation.item !== 'computer');
  for (const reference of Object.values(value.blobs as object)) requireSync(shape(reference, ['device', 'generation', 'id']) && Object.values(reference).every(uuid));
  requireSync(integer(value.operationsSinceCheckpoint) && integer(value.checkpointSequence) && (value.lastSynced === null || integer(value.lastSynced)) && typeof value.joining === 'boolean' && Array.isArray(value.fresh) && value.fresh.every(item => SYNC_ITEMS.includes(item as SyncItem)));
  if (value.outbox !== null) {
    requireSync(shape(value.outbox, ['files', 'operations', 'snapshot', 'sequence', 'checkpoint']) && Array.isArray(value.outbox.files) && value.outbox.files.length <= SYNC_LIMITS.files && Array.isArray(value.outbox.operations) && value.outbox.operations.every(validateOperation) && Array.isArray(value.outbox.snapshot) && integer(value.outbox.sequence) && integer(value.outbox.checkpoint));
    for (const file of value.outbox.files) requireSync(shape(file, ['file', 'parts', 'cap']) && uuid(file.file) && Array.isArray(file.parts) && file.parts.length === 5 && file.parts.every(part => typeof part === 'string' && !/[\\/\x00]/.test(part) && part !== '..') && (file.cap === SYNC_LIMITS.package || file.cap === SYNC_LIMITS.blob));
  }
}
export class SyncEngine {
  private local: EngineState | undefined;
  private failure: SyncFailure | null = null;
  private readonly path: string;
  private readonly outboxPath: string;
  private readonly journalPath: string;
  private readonly incomingPath: string;
  private readonly binding: string;
  private running: Promise<void> | undefined;
  private queue = Promise.resolve();
  private timer: ReturnType<typeof setInterval> | undefined;
  private dirty = new Map<SyncItem, number>();
  private edits = new Map<string, RecordEdit>();
  private dirtyWrite: ReturnType<typeof setTimeout> | undefined;
  private lastRead = 0;
  private stopped = false;
  private verifyGeneration = true;
  constructor(readonly userData: string, readonly cipher: SyncCipher, readonly host: SyncHost, readonly options: { keys?: SyncKeySource; now?: () => number; pulseMs?: number; afterSeal?: () => void; name?: string } = {}) {
    this.path = resolve(userData, 'sync', 'state.sealed'); this.outboxPath = resolve(userData, 'sync', 'outbox');
    this.journalPath = resolve(userData, 'sync', 'apply.sealed'); this.incomingPath = resolve(userData, 'sync', 'incoming');
    this.binding = createHash('sha256').update(`${hostname()}\0${resolve(userData)}`).digest('hex');
    try {
      // An unconfigured install must still browse when its keyring is unavailable.
      if (!existsSync(this.path)) return;
      const status = { restored: false }, state = readSyncState(this.path, cipher, status); validateState(state); this.local = state;
      this.dirty = new Map(Object.entries(state.dirty) as [SyncItem, number][]);
      this.edits = new Map(state.edits.map(edit => [recordId(edit.record), edit]));
      if (state.binding !== this.binding || status.restored) {
        if (state.binding !== this.binding) state.device = randomUUID();
        state.binding = this.binding; state.generation = randomUUID(); state.sequence = 0; state.checkpointSequence = 0; state.operationsSinceCheckpoint = 0; state.ownBatches = {}; state.ownCheckpoints = {}; state.fresh = [...SYNC_ITEMS]; this.save(state);
      }
    } catch (error) { this.failure = syncFailure(error); }
  }
  private now() { return this.options.now?.() ?? Date.now(); }
  private keys() { return this.options.keys ?? randomSyncKeys; }
  private name() { return computerName(this.options.name ?? hostname()) || 'Computer'; }
  private remainingEdits(state: EngineState, published?: Map<string, RecordEdit>) {
    return new Map([...this.edits].filter(([id, edit]) => !syncEnabled(state.switches, edit.record.item) || canonical(published?.get(id) ?? null) !== canonical(edit)));
  }
  private save(state: EngineState, published?: Map<SyncItem, number>, edits?: Map<string, RecordEdit>) {
    const dirty = new Map(this.dirty);
    if (published) for (const [item, time] of published) if (state.switches[item] && dirty.get(item) === time) dirty.delete(item);
    const remaining = this.remainingEdits(state, edits); state.edits = [...remaining.values()];
    state.dirty = Object.fromEntries(dirty); writeSyncState(this.path, state, this.cipher); this.dirty = dirty; this.edits = remaining;
  }
  private flushDirty() {
    if (!this.local || this.dirtyWrite === undefined) return;
    clearTimeout(this.dirtyWrite); this.dirtyWrite = undefined;
    try {
      const current = this.host.read(); for (const profile of current.profiles) this.local.mapping[profile.id] ??= randomUUID();
      this.captureEdits(this.local, this.capture(this.local, current).records, true); this.save(this.local);
    } catch (error) { this.failure = syncFailure(error); this.host.changed(); }
    finally { clearTimeout(this.dirtyWrite); this.dirtyWrite = undefined; }
  }
  private enqueue<T>(work: () => Promise<T>): Promise<T> {
    const result = this.queue.then(work).catch(error => { this.failure = syncFailure(error); this.host.changed(); throw new Error(this.failure); });
    // A rejected command must not poison later retries; its caller still receives the rejection.
    this.queue = result.then(() => undefined, () => undefined); return result;
  }
  state(): SyncState {
    const local = this.local; if (!local) return { ...emptySyncState(), failure: this.failure };
    const computers = new Map<string, SyncComputer>();
    const computer = (id: string) => ({ id, name: (local.records.find(record => record.item === 'computer' && record.key === id)?.value as { name: string } | undefined)?.name ?? 'Computer' });
    if (local.switches.tabs) for (const record of local.records) if (record.item === 'tabs' && record.key !== local.device && record.value !== null) {
      const windows = structuredClone(record.value as SyncComputer['windows']).filter(window => window.tabs.length > 0); if (!windows.length) continue;
      const entry = computers.get(record.key) ?? { ...computer(record.key), windows: [] }; entry.windows.push(...windows); computers.set(record.key, entry);
    }
    return { configured: true, folderName: basename(local.folder), switches: { ...local.switches }, lastSynced: local.lastSynced, failure: this.failure, syncing: !!this.running,
      conflicts: local.conflicts.filter(({ operation }) => operation.item !== 'computer').map(({ id, operation }) => {
        const known = operation.value === null && operation.title === undefined ? local.records.find(record => recordId(record) === recordId(operation) && record.value !== null) : undefined;
        return { id, item: operation.item as SyncItem, title: operation.title ?? recordTitle(operation.value === null && known ? known : operation), computer: computer(operation.device), time: operation.time, deleted: operation.value === null };
      }), computers: [...computers.values()] };
  }
  markDirty(item: SyncItem) {
    if (this.stopped) return; this.dirty.set(item, this.now());
    if (!this.local) return; this.local.dirty = Object.fromEntries(this.dirty);
    // A burst shares one sealed write, and stop flushes it before an ordinary restart.
    if (this.dirtyWrite === undefined) { this.dirtyWrite = setTimeout(() => this.flushDirty(), 500); this.dirtyWrite.unref(); }
  }
  start() {
    if (this.timer) return; this.stopped = false;
    const interval = this.options.pulseMs ?? 1000;
    this.timer = setInterval(() => {
      const publishAfter = this.options.pulseMs ?? 30000, readAfter = this.options.pulseMs ?? 60000;
      const lastChange = Math.max(0, ...[...this.dirty].filter(([item]) => this.local?.switches[item]).map(([, time]) => time));
      if (this.local && (this.now() - this.lastRead >= readAfter || lastChange > 0 && this.now() - lastChange >= publishAfter)) void this.pulse(false).catch(() => undefined);
    }, interval); this.timer.unref();
  }
  stop() { this.stopped = true; clearInterval(this.timer); this.timer = undefined; this.flushDirty(); }
  focus() { if (this.local && !this.stopped) void this.pulse(false, true).catch(() => undefined); }
  async create(folder: string, accepted: boolean): Promise<void> {
    return this.enqueue(async () => {
      requireSync(accepted === true && !this.local); syncStorageAvailable(this.cipher);
      const { key, check } = await this.keys().create(), transport = new FolderTransport(folder);
      await transport.publish(['Horizon Sync', check.datasetId, 'dataset.hzs'], Buffer.from(canonical(check)), 4096);
      const state = this.initial(folder, check, key); this.save(state); this.local = state; this.failure = null; this.host.changed();
    });
  }
  async join(folder: string, input: string, accepted: boolean): Promise<void> {
    return this.enqueue(async () => {
      requireSync(accepted === true && !this.local); syncStorageAvailable(this.cipher);
      const transport = new FolderTransport(folder), datasets = (await transport.list(['Horizon Sync'])).filter(uuid); requireSync(datasets.length === 1, 'SYNC_FOLDER');
      let parameters: unknown;
      try { parameters = JSON.parse((await transport.read(['Horizon Sync', datasets[0]!, 'dataset.hzs'], 4096)).toString('utf8')); } catch { throw new Error('SYNC_INVALID'); }
      validateDataset(parameters); requireSync(parameters.datasetId === datasets[0]);
      const key = await this.keys().open(input, parameters), state = this.initial(folder, parameters, key); state.joining = true;
      this.save(state); this.local = state; this.failure = null; this.host.changed();
    });
  }
  private initial(folder: string, dataset: DatasetParameters, key: Buffer): EngineState {
    return { version: 1, folder: resolve(folder), dataset, key: key.toString('base64'), binding: this.binding, device: randomUUID(), generation: randomUUID(), sequence: 0, mapping: {}, switches: switches(), records: [], snapshot: [], conflicts: [], cursors: {}, blobs: {}, outbox: null, operationsSinceCheckpoint: 0, checkpointSequence: 0, lastSynced: null, joining: false, fresh: [...SYNC_ITEMS], application: null, dirty: {}, ownBatches: {}, ownCheckpoints: {}, edits: [] };
  }
  revealKey(): string { requireSync(this.local, 'SYNC_LOCKED'); syncStorageAvailable(this.cipher); return this.keys().encode(Buffer.from(this.local.key, 'base64')); }
  async setItem(item: SyncItem, enabled: boolean) {
    return this.enqueue(async () => {
      requireSync(this.local && SYNC_ITEMS.includes(item) && typeof enabled === 'boolean');
      const next = structuredClone(this.local); if (next.switches[item] === enabled) return;
      next.switches[item] = enabled;
      if (!enabled && next.outbox) {
        // A sealed batch cannot be edited when a switch changes. Retire its namespace before capturing enabled items again.
        const acknowledged = new Set(next.snapshot.map(blobReference).filter(reference => reference !== null).map(blobFileKey));
        next.blobs = Object.fromEntries(Object.entries(next.blobs).filter(([, reference]) => reference.device !== next.device || acknowledged.has(blobFileKey(reference))));
        next.outbox = null; next.generation = randomUUID(); next.sequence = 0; next.checkpointSequence = 0; next.operationsSinceCheckpoint = 0; next.ownBatches = {}; next.ownCheckpoints = {};
        next.fresh = SYNC_ITEMS.filter(key => next.switches[key]);
      }
      if (enabled) { next.fresh.push(item); this.markDirty(item); }
      this.save(next); this.local = next; this.host.changed();
    });
  }
  async dismissConflict(id: string) {
    return this.enqueue(async () => { requireSync(this.local); const next = structuredClone(this.local); requireSync(next.conflicts.some(conflict => conflict.id === id)); next.conflicts = next.conflicts.filter(conflict => conflict.id !== id); this.save(next); this.local = next; this.host.changed(); });
  }
  async restoreConflict(id: string) {
    await this.enqueue(async () => {
      requireSync(this.local); const next = structuredClone(this.local), conflict = next.conflicts.find(conflict => conflict.id === id); requireSync(conflict && conflict.operation.item !== 'computer' && next.switches[conflict.operation.item]);
      const records = new Map(next.records.map(record => [recordId(record), record])), old = records.get(recordId(conflict.operation));
      const op = { ...conflict.operation, id: randomUUID(), base: old?.id ?? null, time: this.now(), device: next.device, generation: next.generation }; records.set(recordId(op), op);
      const snapshot = this.host.read(), captured = this.capture(next, snapshot), desired = this.project(next, snapshot, [...records.values()]), images = await this.images(next, [...records.values()], captured.sources);
      const undo = this.host.apply(desired, images);
      try { this.rememberImages(next, this.host.read(), [...records.values()]); next.conflicts = next.conflicts.filter(entry => entry.id !== id); this.save(next); this.local = next; } catch (error) { undo(); throw error; }
      this.markDirty(op.item as SyncItem); this.host.changed();
    });
    await this.pulse(true);
  }
  pulse(force = true, receiveOnly = false): Promise<void> {
    if (this.running) return this.running;
    const work = this.enqueue(async () => {
      if (!this.local) return;
      try { this.failure = await this.runPulse(force, receiveOnly) ?? null; }
      finally { this.host.changed(); }
    });
    this.running = work.finally(() => { this.running = undefined; this.host.changed(); }); this.host.changed(); return this.running;
  }
  private async incoming(state: EngineState): Promise<{ operations: SyncOperation[]; conflicts: KeptConflict[]; cursors: Record<string, number>; waiting: SyncFailure | null }> {
    const transport = new FolderTransport(datasetFolder(state.folder, state.dataset.datasetId)), operations: SyncOperation[] = [], conflicts: KeptConflict[] = [], cursors = { ...state.cursors }, key = Buffer.from(state.key, 'base64');
    let dataset: unknown;
    try { dataset = JSON.parse((await transport.read(['dataset.hzs'], 4096)).toString('utf8')); } catch (error) { throw new Error(syncFailure(error)); }
    validateDataset(dataset); requireSync(canonical(dataset) === canonical(state.dataset));
    const devices = (await transport.list(['writers'])).filter(uuid); requireSync(devices.length <= SYNC_LIMITS.writers, 'SYNC_LIMIT'); let writers = 0, waiting: SyncFailure | null = null;
    for (const device of devices) for (const generation of (await transport.list(['writers', device])).filter(uuid)) {
      requireSync(++writers <= SYNC_LIMITS.writers, 'SYNC_LIMIT'); if (device === state.device && generation === state.generation) continue;
      const parts = writerParts(device, generation), writer = `${device}/${generation}`; let cursor = cursors[writer] ?? 0;
      if (!cursor) {
        const latest = (await transport.list([...parts, 'checkpoints'])).flatMap(name => { const checkpoint = validCheckpoint(name); return checkpoint ? [{ ...checkpoint, name }] : []; }).sort((a, b) => b.sequence - a.sequence || b.id.localeCompare(a.id))[0];
        if (latest) {
          const identity: SyncIdentity = { dataset: state.dataset.datasetId, device, generation, id: latest.id, sequence: latest.sequence, kind: 'checkpoint' };
          const payload = await decodeSync(key, identity, await transport.read([...parts, 'checkpoints', latest.name], SYNC_LIMITS.package)) as SyncPayload;
          operations.push(...payload.operations); conflicts.push(...payload.conflicts); requireSync(operations.length <= SYNC_LIMITS.records && conflicts.length <= SYNC_LIMITS.records, 'SYNC_LIMIT'); cursor = latest.sequence;
        }
      }
      const batches = (await transport.list([...parts, 'batches'])).flatMap(name => { const batch = validBatch(name); return batch && batch.sequence > cursor ? [{ ...batch, name }] : []; }).sort((a, b) => a.sequence - b.sequence);
      const sequences = new Set<number>(); for (const batch of batches) { requireSync(!sequences.has(batch.sequence)); sequences.add(batch.sequence); }
      for (const batch of batches) {
        if (batch.sequence !== cursor + 1) { waiting = 'SYNC_GAP'; break; }
        const identity: SyncIdentity = { dataset: state.dataset.datasetId, device, generation, sequence: batch.sequence, id: batch.id, kind: 'batch' };
        const payload = await decodeSync(key, identity, await transport.read([...parts, 'batches', batch.name], SYNC_LIMITS.package)) as SyncPayload;
        operations.push(...payload.operations); cursor = batch.sequence; requireSync(operations.length <= SYNC_LIMITS.records, 'SYNC_LIMIT');
      }
      cursors[writer] = cursor;
    }
    return { operations, conflicts, cursors, waiting };
  }
  private capture(state: EngineState, snapshot: SyncSnapshot): { records: SyncRecord[]; sources: Map<string, { profile: string; item: DesktopItem }> } {
    const sources = new Map<string, { profile: string; item: DesktopItem }>();
    const records = snapshotRecords(snapshot, state.mapping, state.device, (profile, item) => {
      // Desktop gives replacements a new filename, so snapshots need only metadata to identify an image revision.
      const id = blobKey(state.mapping[profile]!, item), reference = state.blobs[id] ?? { device: state.device, generation: state.generation, id: randomUUID() }; state.blobs[id] = reference;
      sources.set(blobFileKey(reference), { profile, item }); return reference;
    }, this.name());
    return { records, sources };
  }
  private baseline(state: EngineState, records: SyncRecord[]): SyncRecord[] {
    // Disabled items retain only values this device actually published or applied.
    return [...state.snapshot.filter(record => !syncEnabled(state.switches, record.item)), ...records.filter(record => syncEnabled(state.switches, record.item))];
  }
  private captureEdits(state: EngineState, records: SyncRecord[], markedOnly = false) {
    const baseline = new Map(state.snapshot.map(record => [recordId(record), record])), current = new Map(records.map(record => [recordId(record), record]));
    const selected = (record: SyncRecord) => ownRecord(record, state.device) && (!markedOnly || record.item !== 'computer' && this.dirty.has(record.item));
    for (const [id, edit] of this.edits) if (selected(edit.record) && !baseline.has(id) && !current.has(id)) this.edits.delete(id);
    for (const [id, record] of new Map([...baseline, ...current])) {
      if (!selected(record)) continue; const value = current.get(id)?.value ?? null, previous = this.edits.get(id);
      if (canonical(baseline.get(id)?.value ?? null) === canonical(value)) { this.edits.delete(id); continue; }
      // A no-op write, or an edit of another record, cannot renew this value's time.
      if (previous && canonical(previous.record.value) === canonical(value)) continue;
      this.edits.set(id, { record: { ...record, value }, time: record.item === 'computer' ? this.now() : this.dirty.get(record.item) ?? this.now(), title: value === null ? previous?.title ?? recordTitle(record) : recordTitle({ ...record, value }) });
    }
    requireSync(this.edits.size <= SYNC_LIMITS.records, 'SYNC_LIMIT');
    const dirty = new Map([...this.dirty].filter(([item]) => state.switches[item] && state.fresh.includes(item)));
    for (const edit of this.edits.values()) if (edit.record.item !== 'computer') dirty.set(edit.record.item, Math.max(dirty.get(edit.record.item) ?? 0, edit.time));
    this.dirty = dirty;
  }
  private project(state: EngineState, snapshot: SyncSnapshot, records: SyncOperation[]): SyncSnapshot {
    const existing = new Map(snapshot.profiles.flatMap(profile => [...profile.desktop.projects.flatMap(project => project.items), ...profile.desktop.captures].map(item => [canonical([profile.id, item.id]), item] as const)));
    return projectSnapshot(snapshot, state.mapping, records, state.switches, (profile, item, reference) => {
      const old = existing.get(canonical([profile, item.id]));
      return old?.image && old.image.bytes === item.image?.bytes && canonical(state.blobs[blobKey(state.mapping[profile]!, old)] ?? null) === blobFileKey(reference) ? old.image.filename : `${reference.id}.bin`;
    });
  }
  private rememberImages(state: EngineState, snapshot: SyncSnapshot, records: SyncOperation[]) {
    if (!state.switches.desktop) return; const references = new Map(records.filter(record => record.item === 'desktop').map(record => [recordId(record), blobReference(record)]));
    for (const profile of snapshot.profiles) for (const item of [...profile.desktop.projects.flatMap(project => project.items), ...profile.desktop.captures]) if (item.image) {
      const reference = references.get(recordId({ item: 'desktop', profile: state.mapping[profile.id]!, key: item.id, value: null })); requireSync(reference);
      state.blobs[blobKey(state.mapping[profile.id]!, item)] = reference;
    }
  }
  private async images(state: EngineState, records: SyncOperation[], available: Map<string, unknown>): Promise<Map<string, Buffer>> {
    const images = new Map<string, Buffer>(), transport = new FolderTransport(datasetFolder(state.folder, state.dataset.datasetId)), key = Buffer.from(state.key, 'base64');
    let total = 0;
    for (const record of records) {
      if (!syncEnabled(state.switches, record.item)) continue; const reference = blobReference(record); if (!reference || images.has(blobFileKey(reference)) || available.has(blobFileKey(reference))) continue;
      let bytes: Buffer;
      try { bytes = await transport.read([...writerParts(reference.device, reference.generation), 'blobs', `${reference.id}.hzs`], SYNC_LIMITS.blob); }
      catch (error) { if (error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT') throw new Error('SYNC_BLOB_PENDING'); throw error; }
      const image = Buffer.from(await decodeSync(key, { dataset: state.dataset.datasetId, ...reference, sequence: 0, kind: 'blob' }, bytes) as Uint8Array);
      const value = record.value as { entry: { id: string; image: { bytes: number } } }; requireSync(image.length === value.entry.image.bytes);
      total += image.length; requireSync(total <= 256 * 1024 * 1024, 'SYNC_LIMIT'); images.set(blobFileKey(reference), image);
      atomicSyncFile(resolve(this.incomingPath, createHash('sha256').update(blobFileKey(reference)).digest('hex')), bytes);
    }
    return images;
  }
  private sealOutbox(state: EngineState, operations: SyncOperation[], snapshot: SyncRecord[], sources: Map<string, { profile: string; item: DesktopItem }>, checkpoint: boolean): Outbox {
    const key = Buffer.from(state.key, 'base64'), files: OutgoingFile[] = [], parts = writerParts(state.device, state.generation), uploaded = new Set<string>();
    mkdirSync(this.outboxPath, { recursive: true, mode: 0o700 });
    const add = (identity: SyncIdentity, path: string[], value: unknown, cap: number) => {
      const file = identity.kind === 'blob' ? identity.id : randomUUID(), local = resolve(this.outboxPath, file);
      atomicSyncFile(local, sealSync(key, identity, value));
      files.push({ file, parts: path, cap });
    };
    const records = new Map(state.records.map(record => [recordId(record), record])), conflicts = new Map(state.conflicts.map(conflict => [conflict.id, conflict.operation]));
    for (const operation of operations) mergeOperation(records, operation, conflicts);
    const blobRecords = checkpoint ? [...records.values()].filter(record => syncEnabled(state.switches, record.item)) : operations;
    let total = 0;
    for (const record of blobRecords) {
      const reference = blobReference(record); if (!reference || reference.device !== state.device || reference.generation !== state.generation || uploaded.has(reference.id)) continue;
      uploaded.add(reference.id); const path = resolve(this.outboxPath, reference.id);
      if (existsSync(path)) { const stat = lstatSync(path); requireSync(stat.isFile() && !stat.isSymbolicLink() && stat.size <= SYNC_LIMITS.blob, 'SYNC_LIMIT'); continue; }
      const source = sources.get(blobFileKey(reference)); requireSync(source, 'SYNC_STORAGE'); const bytes = this.host.image(source.profile, source.item); requireSync(bytes && bytes.length === source.item.image?.bytes, 'SYNC_STORAGE');
      total += bytes.length; requireSync(total <= 256 * 1024 * 1024, 'SYNC_LIMIT');
      add({ dataset: state.dataset.datasetId, ...reference, sequence: 0, kind: 'blob' }, [...parts, 'blobs', `${reference.id}.hzs`], bytes, SYNC_LIMITS.blob);
    }
    const sequence = state.sequence + (operations.length ? 1 : 0);
    if (operations.length) {
      const id = randomUUID(), identity: SyncIdentity = { dataset: state.dataset.datasetId, device: state.device, generation: state.generation, sequence, id, kind: 'batch' };
      const name = `${sequence}-${id}.hzs`, createdAt = this.now(); state.ownBatches[name] = createdAt;
      add(identity, [...parts, 'batches', name], { version: 1, kind: 'batch', sequence, createdAt, operations, conflicts: [] } satisfies SyncPayload, SYNC_LIMITS.package);
    }
    if (checkpoint) {
      const id = randomUUID(), identity: SyncIdentity = { dataset: state.dataset.datasetId, device: state.device, generation: state.generation, sequence, id, kind: 'checkpoint' };
      const name = `${sequence}-${id}.hzs`, createdAt = this.now(); state.ownCheckpoints[name] = createdAt;
      add(identity, [...parts, 'checkpoints', name], { version: 1, kind: 'checkpoint', sequence, createdAt, operations: [...records.values()].filter(record => syncEnabled(state.switches, record.item)), conflicts: [...conflicts].map(([id, operation]) => ({ id, operation })).filter(conflict => syncEnabled(state.switches, conflict.operation.item)) } satisfies SyncPayload, SYNC_LIMITS.package);
    }
    return { files, operations, snapshot: this.baseline(state, snapshot), sequence, checkpoint: checkpoint ? sequence : state.checkpointSequence };
  }
  private async publishOutbox(state: EngineState): Promise<void> {
    const outbox = state.outbox; if (!outbox) return;
    const transport = new FolderTransport(datasetFolder(state.folder, state.dataset.datasetId));
    for (const file of outbox.files) { const path = resolve(this.outboxPath, file.file); requireSync(statSync(path).size <= file.cap, 'SYNC_LIMIT'); await transport.publish(file.parts, readFileSync(path), file.cap); }
  }
  private async runPulse(force: boolean, receiveOnly: boolean) {
    this.flushDirty();
    await this.recoverApplication();
    const state = structuredClone(this.local!);
    this.pruneOutbox(state);
    // A sealed retry is published before a fresh generation captures more changes.
    if (state.outbox) {
      await this.publishOutbox(state);
      const records = new Map(state.records.map(record => [recordId(record), record])), conflicts = new Map(state.conflicts.map(conflict => [conflict.id, conflict.operation]));
      for (const operation of state.outbox.operations) mergeOperation(records, operation, conflicts);
      state.records = [...records.values()]; state.conflicts = [...conflicts].map(([id, operation]) => ({ id, operation })); state.snapshot = state.outbox.snapshot;
      if (state.outbox.operations[0]?.generation === state.generation) { state.sequence = state.outbox.sequence; state.checkpointSequence = state.outbox.checkpoint; }
      state.outbox = null; this.save(state); this.local = structuredClone(state);
    }
    if (this.verifyGeneration) await this.checkGeneration(state);
    const incoming = await this.incoming(state); this.verifyGeneration = false; this.lastRead = this.now();
    const current = this.host.read();
    if (state.joining) for (const profile of current.profiles) {
      const remote = incoming.operations.find(record => record.item === 'profiles' && record.value !== null && (record.value as { name: string }).name.toLowerCase() === profile.name.toLowerCase());
      if (remote) state.mapping[profile.id] = remote.key;
    }
    for (const profile of current.profiles) state.mapping[profile.id] ??= randomUUID();
    const captured = this.capture(state, current), baseline = new Map(state.snapshot.map(record => [recordId(record), record])), records = new Map(state.records.map(record => [recordId(record), record])), conflicts = new Map(state.conflicts.map(conflict => [conflict.id, conflict.operation]));
    this.captureEdits(state, captured.records); const edits = new Map(this.edits), dirty = new Map(this.dirty);
    const changes: SyncOperation[] = [], local = new Map(captured.records.map(record => [recordId(record), record]));
    const allowed = force || !receiveOnly && this.now() - Math.max(0, ...[...dirty].filter(([item]) => state.switches[item]).map(([, time]) => time)) >= (this.options.pulseMs ?? 30000);
    const time = (id: string) => edits.get(id)?.time ?? records.get(id)?.time ?? this.now();
    const fresh = (item: SyncRecord['item']) => item !== 'computer' && state.fresh.includes(item);
    if (!allowed && [...local, ...baseline].some(([id, record]) => syncEnabled(state.switches, record.item) && ownRecord(record, state.device) && canonical(baseline.get(id)?.value ?? null) !== canonical(local.get(id)?.value ?? null))) return incoming.waiting;
    for (const [id, record] of local) if (syncEnabled(state.switches, record.item) && allowed && (fresh(record.item) || record.item === 'computer' && !records.has(id) || canonical(baseline.get(id)?.value ?? null) !== canonical(record.value))) {
      if (state.joining && incoming.operations.some(remote => recordId(remote) === id)) continue;
      const operation: SyncOperation = { ...record, id: randomUUID(), base: records.get(id)?.id ?? null, time: time(id), device: state.device, generation: state.generation };
      validateRecord(operation); changes.push(operation); mergeOperation(records, operation, conflicts);
    }
    for (const [id, record] of baseline) if (!local.has(id) && syncEnabled(state.switches, record.item) && allowed && ownRecord(record, state.device)) {
      const operation: SyncOperation = { ...record, value: null, title: edits.get(id)?.title ?? recordTitle(record), id: randomUUID(), base: records.get(id)?.id ?? null, time: time(id), device: state.device, generation: state.generation }; changes.push(operation); mergeOperation(records, operation, conflicts);
    }
    const outgoingRecords = [...records.values()], outgoingConflicts = [...conflicts].map(([id, operation]) => ({ id, operation }));
    for (const operation of incoming.operations) mergeOperation(records, operation, conflicts);
    for (const conflict of incoming.conflicts) conflicts.set(conflict.id, conflict.operation);
    requireSync(records.size <= SYNC_LIMITS.records && conflicts.size <= SYNC_LIMITS.records, 'SYNC_LIMIT');
    const live = [...records.values()]; let desired = this.project(state, current, live);
    const images = await this.images(state, live.filter(record => desired.profiles.some(profile => state.mapping[profile.id] === record.profile)), captured.sources);
    const checkpoint = allowed && (state.fresh.some(item => state.switches[item]) || state.operationsSinceCheckpoint + changes.length >= 500);
    if (changes.length || checkpoint) {
      // The durable outbox includes immutable bytes before the first transport write.
      state.outbox = this.sealOutbox({ ...state, records: outgoingRecords, conflicts: outgoingConflicts }, changes, captured.records, captured.sources, checkpoint);
      this.save(state); this.local = structuredClone(state); this.options.afterSeal?.();
      await this.publishOutbox(state);
    }
    if (state.outbox) { state.sequence = state.outbox.sequence; state.checkpointSequence = state.outbox.checkpoint; }
    await this.cleanup(state);
    const latestSnapshot = this.host.read(), latest = this.capture(state, latestSnapshot);
    const comparable = (records: SyncRecord[]) => canonical(records.filter(record => syncEnabled(state.switches, record.item)).sort((a, b) => recordId(a).localeCompare(recordId(b))));
    requireSync(comparable(captured.records) === comparable(latest.records), 'SYNC_CHANGED');
    desired = this.project(state, latestSnapshot, live);
    const commit = structuredClone(state);
    commit.records = live.filter(record => record.value !== null || this.now() - record.time < 90 * 86400000); commit.conflicts = [...conflicts].map(([id, operation]) => ({ id, operation })); commit.cursors = incoming.cursors;
    commit.operationsSinceCheckpoint = checkpoint ? 0 : state.operationsSinceCheckpoint + changes.length;
    this.rememberImages(commit, desired, live); commit.snapshot = this.baseline(commit, this.capture(commit, desired).records); commit.edits = [...this.remainingEdits(commit, allowed ? edits : undefined).values()];
    if (allowed) for (const [item, time] of dirty) if (commit.switches[item] && commit.dirty[item] === time) delete commit.dirty[item];
    commit.joining = false; if (allowed) commit.fresh = commit.fresh.filter(item => !commit.switches[item]); commit.lastSynced = this.now(); commit.outbox = null; commit.application = randomUUID();
    const cached = [...images.keys()].map(id => {
      const reference = JSON.parse(id) as BlobReference, file = createHash('sha256').update(id).digest('hex'), path = resolve(this.incomingPath, file);
      if (!existsSync(path)) { const source = resolve(this.outboxPath, reference.id); requireSync(statSync(source).size <= SYNC_LIMITS.blob); atomicSyncFile(path, readFileSync(source)); }
      return { reference, file };
    });
    writeSyncState(this.journalPath, { version: 1, state: commit, snapshot: desired, images: cached }, this.cipher);
    let undo: () => void;
    try { undo = this.host.apply(desired, images); }
    catch (error) { unlinkSync(this.journalPath); throw error; }
    try {
      state.records = live.filter(record => record.value !== null || this.now() - record.time < 90 * 86400000); state.conflicts = [...conflicts].map(([id, operation]) => ({ id, operation })); state.cursors = incoming.cursors;
      if (state.outbox) { state.sequence = state.outbox.sequence; state.checkpointSequence = state.outbox.checkpoint; }
      state.operationsSinceCheckpoint = checkpoint ? 0 : state.operationsSinceCheckpoint + changes.length;
      const applied = this.host.read(); this.rememberImages(state, applied, live); state.snapshot = this.baseline(state, this.capture(state, applied).records);
      state.joining = false; if (allowed) state.fresh = state.fresh.filter(item => !state.switches[item]); state.lastSynced = this.now(); state.outbox = null;
      state.application = commit.application; this.save(state, allowed ? dirty : undefined, allowed ? edits : undefined); this.local = state;
    } catch (error) { undo(); if (existsSync(this.journalPath)) unlinkSync(this.journalPath); throw error; }
    this.host.committed?.();
    return incoming.waiting;
  }
  private async checkGeneration(state: EngineState) {
    const transport = new FolderTransport(datasetFolder(state.folder, state.dataset.datasetId)), parts = writerParts(state.device, state.generation), key = Buffer.from(state.key, 'base64');
    let highest = state.sequence;
    const batches = (await transport.list([...parts, 'batches'])).flatMap(name => { const batch = validBatch(name); return batch && batch.sequence > state.sequence ? [{ ...batch, name }] : []; });
    for (const batch of batches) {
      const identity: SyncIdentity = { dataset: state.dataset.datasetId, device: state.device, generation: state.generation, sequence: batch.sequence, id: batch.id, kind: 'batch' };
      await decodeSync(key, identity, await transport.read([...parts, 'batches', batch.name], SYNC_LIMITS.package)); highest = Math.max(highest, batch.sequence);
    }
    const latest = (await transport.list([...parts, 'checkpoints'])).flatMap(name => { const checkpoint = validCheckpoint(name); return checkpoint && checkpoint.sequence > state.sequence ? [{ ...checkpoint, name }] : []; }).sort((a, b) => b.sequence - a.sequence || b.id.localeCompare(a.id))[0];
    if (latest) {
      await decodeSync(key, { dataset: state.dataset.datasetId, device: state.device, generation: state.generation, sequence: latest.sequence, id: latest.id, kind: 'checkpoint' }, await transport.read([...parts, 'checkpoints', latest.name], SYNC_LIMITS.package)); highest = Math.max(highest, latest.sequence);
    }
    if (highest > state.sequence) {
      // A restored local counter must not fork packages already present in its writer namespace.
      state.generation = randomUUID(); state.sequence = 0; state.checkpointSequence = 0; state.operationsSinceCheckpoint = 0; state.ownBatches = {}; state.ownCheckpoints = {}; state.fresh = [...SYNC_ITEMS]; this.save(state); this.local = structuredClone(state);
    }
  }
  private async recoverApplication() {
    if (!existsSync(this.journalPath)) return;
    const journal = readSyncState(this.journalPath, this.cipher);
    requireSync(shape(journal, ['version', 'state', 'snapshot', 'images']) && journal.version === 1 && Array.isArray(journal.images) && journal.images.length <= SYNC_LIMITS.files);
    validateState(journal.state); const state = journal.state; requireSync(this.local && state.dataset.datasetId === this.local.dataset.datasetId && state.key === this.local.key);
    if (this.local.application === state.application) { unlinkSync(this.journalPath); return; }
    const images = new Map<string, Buffer>();
    for (const image of journal.images) {
      requireSync(shape(image, ['reference', 'file']) && shape(image.reference, ['device', 'generation', 'id']) && Object.values(image.reference).every(uuid) && typeof image.file === 'string' && /^[0-9a-f]{64}$/.test(image.file));
      const path = resolve(this.incomingPath, image.file); requireSync(statSync(path).size <= SYNC_LIMITS.blob);
      const reference = image.reference as unknown as BlobReference;
      images.set(blobFileKey(reference), Buffer.from(await decodeSync(Buffer.from(state.key, 'base64'), { dataset: state.dataset.datasetId, ...reference, sequence: 0, kind: 'blob' }, readFileSync(path)) as Uint8Array));
    }
    const snapshot = journal.snapshot as SyncSnapshot, undo = this.host.apply(snapshot, images);
    // Recovery may run in a copied install or a new process incarnation.
    if (state.generation !== this.local.generation || state.binding !== this.binding) {
      state.device = this.local.device; state.generation = this.local.generation; state.binding = this.binding; state.sequence = 0; state.checkpointSequence = 0; state.ownBatches = {}; state.ownCheckpoints = {}; state.fresh = [...SYNC_ITEMS];
    }
    try { const applied = this.host.read(); this.rememberImages(state, applied, state.records); state.snapshot = this.baseline(state, this.capture(state, applied).records); this.edits = new Map(state.edits.map(edit => [recordId(edit.record), edit])); this.save(state); this.local = state; }
    catch (error) { undo(); throw error; }
    this.host.committed?.();
  }
  private pruneOutbox(state: EngineState) {
    if (!existsSync(this.outboxPath)) return;
    const keep = new Set([...(state.outbox?.files.map(file => file.file) ?? []), ...Object.values(state.blobs).filter(reference => reference.device === state.device).map(reference => reference.id)]);
    const names = readdirSync(this.outboxPath); requireSync(names.length <= SYNC_LIMITS.files, 'SYNC_LIMIT');
    for (const name of names) if (uuid(name) && !keep.has(name)) { const path = resolve(this.outboxPath, name), stat = lstatSync(path); requireSync(stat.isFile() && !stat.isSymbolicLink()); unlinkSync(path); }
  }
  private async cleanup(state: EngineState) {
    if (!state.checkpointSequence) return;
    const transport = new FolderTransport(datasetFolder(state.folder, state.dataset.datasetId));
    for (const [kind, created, parse] of [['batches', state.ownBatches, validBatch], ['checkpoints', state.ownCheckpoints, validCheckpoint]] as const) {
      const parts = [...writerParts(state.device, state.generation), kind], names = new Set(await transport.list(parts));
      for (const [name, time] of Object.entries(created)) {
        const entry = parse(name); requireSync(entry);
        if (!names.has(name)) { delete created[name]; continue; }
        if (entry.sequence < state.checkpointSequence && this.now() - time > 30 * 86400000) { await transport.remove([...parts, name]); delete created[name]; }
      }
    }
  }
  async leave(removeOwnFiles: boolean): Promise<void> {
    return this.enqueue(async () => {
      requireSync(this.local); const state = this.local;
      if (removeOwnFiles) {
        const transport = new FolderTransport(datasetFolder(state.folder, state.dataset.datasetId));
        for (const generation of (await transport.list(['writers', state.device])).filter(uuid)) for (const kind of ['batches', 'blobs', 'checkpoints']) {
          const parts = [...writerParts(state.device, generation), kind];
          for (const name of await transport.list(parts)) if (kind === 'batches' ? validBatch(name) : kind === 'checkpoints' ? validCheckpoint(name) || objectName(name) : objectName(name)) await transport.remove([...parts, name]);
        }
      }
      this.pruneOutbox({ ...state, blobs: {}, outbox: null }); if (existsSync(this.journalPath)) unlinkSync(this.journalPath); unlinkSync(this.path); this.local = undefined; this.failure = null; this.dirty.clear(); this.edits.clear(); clearTimeout(this.dirtyWrite); this.dirtyWrite = undefined; this.host.changed();
    });
  }
}
