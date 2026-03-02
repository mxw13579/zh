import type { ReasoningStrategy } from './config.js';
import { normalizePayload } from './normalize.js';
import { splitEvents } from './utils/sse.js';
import { createUsagePatcher, type UsagePatchContext } from './usage.js';

export function createSseTransformer(
  strategy: ReasoningStrategy,
  usagePatch: UsagePatchContext | null = null,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  const patcher = usagePatch ? createUsagePatcher(usagePatch) : null;
  const freePatcher = (): void => patcher?.free();

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const split = splitEvents(buffer, false);
      buffer = split.rest;

      for (const eventBlock of split.events) {
        const normalizedEvent = normalizeSseEvent(eventBlock, strategy, patcher);
        controller.enqueue(encoder.encode(normalizedEvent));
      }
    },
    flush(controller) {
      try {
        buffer += decoder.decode();
        const split = splitEvents(buffer, true);

        for (const eventBlock of split.events) {
          const normalizedEvent = normalizeSseEvent(eventBlock, strategy, patcher);
          controller.enqueue(encoder.encode(normalizedEvent));
        }
      } finally {
        freePatcher();
      }
    },
    cancel() {
      freePatcher();
    },
  });
}

function normalizeSseEvent(
  eventBlock: string,
  strategy: ReasoningStrategy,
  patcher: ReturnType<typeof createUsagePatcher> | null,
): string {
  const lines: string[] = [];

  for (const line of eventBlock.split('\n')) {
    if (!line.startsWith('data:')) {
      if (line.length > 0) {
        lines.push(line);
      }
      continue;
    }

    const payload = line.slice(5).trim();
    if (payload === '[DONE]') {
      lines.push('data: [DONE]');
      continue;
    }

    const first = payload[0];
    if (first !== '{' && first !== '[') {
      lines.push(line);
      continue;
    }

    try {
      const normalized = normalizePayload(JSON.parse(payload), strategy);
      const patched = patcher ? patcher.patch(normalized) : normalized;
      lines.push(`data: ${JSON.stringify(patched)}`);
    } catch {
      lines.push(line);
    }
  }

  return `${lines.join('\n')}\n\n`;
}
