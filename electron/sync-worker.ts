import { parentPort, workerData } from 'node:worker_threads';
import { openSync, syncFailure, validatePayload } from './sync-format';
import type { SyncIdentity } from './sync-format';
import { validateRecord } from './sync-model';

const request = workerData as { key: Uint8Array; identity: SyncIdentity; bytes: Uint8Array };
try {
  const bytes = Buffer.from(request.bytes), identity = { ...request.identity };
  const value = openSync(Buffer.from(request.key), identity, bytes);
  if (identity.kind === 'batch' || identity.kind === 'checkpoint') {
    validatePayload(value, identity);
    for (const operation of value.operations) validateRecord(operation);
    for (const conflict of value.conflicts) validateRecord(conflict.operation);
  }
  parentPort?.postMessage({ ok: true, value });
} catch (error) { parentPort?.postMessage({ ok: false, code: syncFailure(error) }); }
