import { createSseEventTransformer, rewriteSseEventDataJsonLines } from './codecs/sse/codec.js';
import { getTokenEncoder } from './tokens.js';
import { isRecord } from './utils/json.js';

export interface UsagePatchContext {
  promptTokens: number;
  model: string | null;
}

const MAX_COMPLETION_CHARS = 2_000_000;

export function createUsagePatcher(context: UsagePatchContext): {
  patch(chunk: unknown): unknown;
  free(): void;
} {
  const completionByChoice = new Map<number, string>();
  let patchEnabled = true;
  const tokenEncoder = getTokenEncoder(context.model);
  let freed = false;

  const free = (): void => {
    if (freed) {
      return;
    }
    freed = true;
    tokenEncoder.free();
  };

  const disablePatch = (): void => {
    patchEnabled = false;
    completionByChoice.clear();
  };

  const patch = (chunk: unknown): unknown => {
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

      const current = completionByChoice.get(index) ?? '';
      const next = current + content + reasoning;
      if (next.length > MAX_COMPLETION_CHARS) {
        disablePatch();
        break;
      }
      completionByChoice.set(index, next);
    }

    const usage = isRecord(chunk.usage) ? chunk.usage : null;
    if (!usage) {
      return chunk;
    }

    const promptTokens = typeof usage.prompt_tokens === 'number' ? usage.prompt_tokens : null;
    const completionTokens = typeof usage.completion_tokens === 'number' ? usage.completion_tokens : null;

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
      ? Array.from(completionByChoice.values()).reduce((sum, text) => {
          if (!text) {
            return sum;
          }
          return sum + tokenEncoder.encode(text).length;
        }, 0)
      : completionTokens ?? 0;

    const computedPromptTokens = shouldPatchPromptTokens ? context.promptTokens : promptTokens ?? 0;

    const patchedUsage = {
      ...usage,
      prompt_tokens: computedPromptTokens,
      completion_tokens: computedCompletionTokens,
      total_tokens: computedPromptTokens + computedCompletionTokens,
    };

    return { ...chunk, usage: patchedUsage };
  };

  return { patch, free };
}

export function createUsagePatchTransformer(
  context: UsagePatchContext,
): TransformStream<Uint8Array, Uint8Array> {
  const patcher = createUsagePatcher(context);
  return createSseEventTransformer(
    (eventBlock) => rewriteSseEventDataJsonLines(eventBlock, (parsed) => patcher.patch(parsed)),
    () => patcher.free(),
  );
}
