import { createRequire } from 'node:module';
const loadEngine = createRequire(__filename);
const engine: typeof import('horizon-engine', { with: { 'resolution-mode': 'import' } }) = loadEngine('horizon-engine');
export const { blockingPolicy, LIST_HOSTS, LIST_TIMEOUT_MS, LIST_BYTES_LIMIT, assertListURL, isPublicListAddress, downloadFilterList, safeCosmeticCSS, createBlockingEngine } = engine;
export type { BlockKind, BlockMatch, CosmeticMetrics, BlockingEngineOptions } from 'horizon-engine' with { 'resolution-mode': 'import' };
