import { getTokenEncoder } from './tokens.js';

export interface UsagePatchContext {
  promptTokens: number;
  model: string | null;
}

const MAX_COMPLETION_CHARS = 2_000_000;

export function createUsagePatchTransformer(
  context: UsagePatchContext,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  const completionByChoice = new Map<number, string>();
  let patchEnabled = true;

  const tokenEncoder = getTokenEncoder(context.model);

  const transformEventBlock = (eventBlock: string): string => {
    const outLines: string[] = [];

    for (const line of eventBlock.split('\n')) {
      if (!line.startsWith('data:')) {
        if (line.length > 0) {
          outLines.push(line);
        }
        continue;
      }

      const payload = line.slice(5).trim();
      if (payload === '[DONE]') {
        outLines.push('data: [DONE]');
        continue;
      }

      const first = payload[0];
      if (first !== '{' && first !== '[') {
        outLines.push(line);
        continue;
      }

      try {
        const parsed = JSON.parse(payload);
        const patched = patchEnabled ? patchChunk(parsed, completionByChoice, context, tokenEncoder) : parsed;
        outLines.push(`data: ${JSON.stringify(patched)}`);
      } catch {
        outLines.push(line);
      }
    }

    return `${outLines.join('\n')}\n\n`;
  };

  const disablePatch = (): void => {
    patchEnabled = false;
    completionByChoice.clear();
  };

  const patchChunk = (
    chunk: unknown,
    store: Map<number, string>,
    ctx: UsagePatchContext,
    enc: { encode(text: string): number[] },
  ): unknown => {
    if (!isRecord(chunk) || !Array.isArray(chunk.choices)) {
      return chunk;
    }

    let thisChunkHasDeltaText = false;

    for (const choice of chunk.choices) {
      if (!isRecord(choice)) {
        continue;
      }

      const index = typeof choice.index === 'number' ? choice.index : 0;
      const delta = isRecord(choice.delta) ? choice.delta : null;
      if (!delta) {
        continue;
      }

      const content = typeof delta.content === 'string' ? delta.content : '';
      const reasoning = typeof delta.reasoning_content === 'string' ? delta.reasoning_content : '';

      if (content || reasoning) {
        thisChunkHasDeltaText = true;
      }

      if (!patchEnabled) {
        continue;
      }

      const current = store.get(index) ?? '';
      const next = current + content + reasoning;
      if (next.length > MAX_COMPLETION_CHARS) {
        disablePatch();
        break;
      }
      store.set(index, next);
    }

    const usage = isRecord(chunk.usage) ? chunk.usage : null;
    if (!usage) {
      return chunk;
    }

    const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null;
    const completionTokens =
      typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null;

    const shouldPatchPromptTokens = promptTokens === null || promptTokens === 0;
    const shouldPatchCompletionTokens = completionTokens === null || completionTokens === 0;
    if (!shouldPatchPromptTokens && !shouldPatchCompletionTokens) {
      return chunk;
    }

    // Only patch the summary usage chunk (it should not contain new delta text).
    if (thisChunkHasDeltaText) {
      return chunk;
    }

    if (!patchEnabled) {
      return chunk;
    }

    const computedCompletionTokens = shouldPatchCompletionTokens
      ? Array.from(store.values()).reduce((sum, text) => {
          if (!text) {
            return sum;
          }
          return sum + enc.encode(text).length;
        }, 0)
      : completionTokens ?? 0;

    const computedPromptTokens = shouldPatchPromptTokens ? ctx.promptTokens : promptTokens ?? 0;

    const patchedUsage = {
      ...usage,
      prompt_tokens: computedPromptTokens,
      completion_tokens: computedCompletionTokens,
      total_tokens: computedPromptTokens + computedCompletionTokens,
    };

    return { ...chunk, usage: patchedUsage };
  };

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const split = splitEvents(buffer, false);
      buffer = split.rest;

      for (const eventBlock of split.events) {
        controller.enqueue(encoder.encode(transformEventBlock(eventBlock)));
      }
    },
    flush(controller) {
      try {
        buffer += decoder.decode();
        const split = splitEvents(buffer, true);

        for (const eventBlock of split.events) {
          controller.enqueue(encoder.encode(transformEventBlock(eventBlock)));
        }
      } finally {
        tokenEncoder.free();
      }
    },
  });
}

function splitEvents(source: string, flush: boolean): { events: string[]; rest: string } {
  const normalized = source.includes('\r') ? source.replace(/\r\n/g, '\n') : source;
  const events: string[] = [];

  let start = 0;
  while (true) {
    const boundary = normalized.indexOf('\n\n', start);
    if (boundary === -1) {
      break;
    }

    const block = normalized.slice(start, boundary);
    if (block) {
      events.push(block);
    }
    start = boundary + 2;
  }

  const rest = normalized.slice(start);
  if (flush) {
    if (rest) {
      events.push(rest);
    }
    return { events, rest: '' };
  }

  return { events, rest };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
