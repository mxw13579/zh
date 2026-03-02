import type { ReasoningStrategy } from '../config.js';

export interface AdapterMethod {
  name: string;
  createSseTransformer(strategy: ReasoningStrategy): TransformStream<Uint8Array, Uint8Array>;
  normalizePayload(payload: unknown, strategy: ReasoningStrategy): unknown;
}

