import { createSseEventTransformer, rewriteSseEventDataJsonLines } from './codecs/sse/codec.js';
import type { ReasoningStrategy } from './config.js';
import { normalizePayload } from './normalize.js';
import { createUsagePatcher, type UsagePatchContext } from './usage.js';

export function createSseTransformer(
  strategy: ReasoningStrategy,
  usagePatch: UsagePatchContext | null = null,
): TransformStream<Uint8Array, Uint8Array> {
  const patcher = usagePatch ? createUsagePatcher(usagePatch) : null;
  return createSseEventTransformer(
    (eventBlock) => normalizeSseEvent(eventBlock, strategy, patcher),
    () => patcher?.free(),
  );
}

function normalizeSseEvent(
  eventBlock: string,
  strategy: ReasoningStrategy,
  patcher: ReturnType<typeof createUsagePatcher> | null,
): string {
  return rewriteSseEventDataJsonLines(eventBlock, (parsed) => {
    const normalized = normalizePayload(parsed, strategy);
    return patcher ? patcher.patch(normalized) : normalized;
  });
}
