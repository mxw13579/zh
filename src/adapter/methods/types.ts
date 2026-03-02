import type { ReasoningStrategy } from '../config.js';
import type { UsagePatchContext } from '../usage.js';

export interface AdapterMethod {
  name: string;
  createSseTransformer(
    strategy: ReasoningStrategy,
    usagePatch?: UsagePatchContext | null,
  ): TransformStream<Uint8Array, Uint8Array>;
  normalizePayload(payload: unknown, strategy: ReasoningStrategy): unknown;
}
