import { randomUUID } from 'node:crypto';

import type { ReasoningStrategy } from './config.js';
import { isRecord, type JsonRecord } from './utils/json.js';

export type { JsonRecord } from './utils/json.js';

export function normalizePayload(payload: unknown, strategy: ReasoningStrategy): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    return payload;
  }

  const choices = payload.choices
    .map((choice, index) => normalizeChoice(choice, index, strategy))
    .filter((choice): choice is JsonRecord => choice !== null);

  return {
    id: typeof payload.id === 'string' ? payload.id : `chatcmpl-${randomUUID()}`,
    object:
      typeof payload.object === 'string' && payload.object.includes('chunk')
        ? 'chat.completion.chunk'
        : 'chat.completion',
    created: typeof payload.created === 'number' ? payload.created : Math.floor(Date.now() / 1000),
    model: typeof payload.model === 'string' ? payload.model : 'unknown',
    choices,
    ...(isRecord(payload.usage) ? { usage: payload.usage } : {}),
    ...(typeof payload.system_fingerprint === 'string'
      ? { system_fingerprint: payload.system_fingerprint }
      : {}),
  };
}

function normalizeChoice(
  input: unknown,
  fallbackIndex: number,
  strategy: ReasoningStrategy,
): JsonRecord | null {
  if (!isRecord(input)) {
    return null;
  }

  const delta = isRecord(input.delta) ? input.delta : {};
  const reasoning = strategy === 'drop' ? '' : extractReasoning(delta);

  const normalizedDelta: JsonRecord = {
    ...(typeof delta.role === 'string' ? { role: delta.role } : {}),
    ...(typeof delta.content === 'string' ? { content: delta.content } : {}),
  };

  if (reasoning) {
    if (strategy === 'as_reasoning_content') {
      normalizedDelta.reasoning_content = reasoning;
      if (typeof normalizedDelta.content !== 'string') {
        normalizedDelta.content = '';
      }
    } else if (strategy === 'as_content') {
      const directContent = typeof normalizedDelta.content === 'string' ? normalizedDelta.content : '';
      if (!directContent) {
        normalizedDelta.content = reasoning;
      }
    } else if (strategy === 'tagged') {
      const directContent = typeof normalizedDelta.content === 'string' ? normalizedDelta.content : '';
      if (!directContent) {
        normalizedDelta.content = `<thinking>${reasoning}</thinking>`;
      }
    }
  }

  if (typeof normalizedDelta.content !== 'string') {
    normalizedDelta.content = '';
  }

  return {
    index: typeof input.index === 'number' ? input.index : fallbackIndex,
    delta: normalizedDelta,
    finish_reason: input.finish_reason ?? null,
    ...(input.logprobs !== undefined ? { logprobs: input.logprobs } : {}),
  };
}

function extractReasoning(delta: JsonRecord): string {
  const parts: string[] = [];
  pushUnique(parts, reasoningFromReasoningContent(delta.reasoning_content));

  if (Array.isArray(delta.thinking_blocks)) {
    for (const block of delta.thinking_blocks) {
      if (isRecord(block)) {
        pushUnique(parts, textOf(block.thinking));
      }
    }
  }

  if (isRecord(delta.provider_specific_fields)) {
    const providerFields = delta.provider_specific_fields;
    if (isRecord(providerFields.reasoningContent)) {
      pushUnique(parts, textOf(providerFields.reasoningContent.text));
    }
  }

  if (isRecord(delta.reasoning)) {
    pushUnique(parts, textOf(delta.reasoning.text));
  }

  return parts.join('');
}

function reasoningFromReasoningContent(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (Array.isArray(value)) {
    const parts: string[] = [];

    for (const item of value) {
      if (typeof item === 'string') {
        parts.push(item);
        continue;
      }

      if (!isRecord(item)) {
        continue;
      }

      const extracted =
        textOf(item.thinking) || textOf(item.text) || textOf(item.reasoning) || textOf(item.content);

      if (extracted) {
        parts.push(extracted);
      }
    }

    return parts.join('');
  }

  if (isRecord(value)) {
    return (
      textOf(value.thinking) || textOf(value.text) || textOf(value.reasoning) || textOf(value.content)
    );
  }

  return '';
}

function pushUnique(target: string[], value: string): void {
  if (value && !target.includes(value)) {
    target.push(value);
  }
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}
