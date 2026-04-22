import type { RuntimeConfig } from '../config.js';
import { normalizePayload } from '../normalize.js';
import { createSseTransformer } from '../sse.js';
import type { UsagePatchContext } from '../usage.js';
import type { ResponseTransform } from './types.js';

export const voidAdapter1Transform: ResponseTransform<UsagePatchContext> = {
  name: 'void-adapter-1',
  transformJsonResponse(payload: unknown, runtime: RuntimeConfig, _context: UsagePatchContext | null): unknown {
    return normalizePayload(payload, runtime.reasoningStrategy);
  },
  createStreamTransformer(
    runtime: RuntimeConfig,
    context: UsagePatchContext | null,
  ): TransformStream<Uint8Array, Uint8Array> {
    return createSseTransformer(runtime.reasoningStrategy, context);
  },
};
