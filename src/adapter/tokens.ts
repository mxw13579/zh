import { encoding_for_model, get_encoding } from 'tiktoken';

import { extractTextContent } from './utils/content.js';
import { isRecord } from './utils/json.js';

export type TokenEncoder = { encode(text: string): number[]; free(): void };

const TOKENS_PER_MESSAGE_OVERHEAD = 3;
const TOKENS_FOR_ASSISTANT_PRIMING = 3;

export function parsePromptTokensMax(
  raw: string,
): { ok: true; value: number } | { ok: false; error: string } {
  const match = raw.trim().match(/^(\d+)\s*([kK])?$/);
  if (!match) {
    return {
      ok: false,
      error: 'Invalid Prompt-Tokens-Max header (expected e.g. "80000" or "80k")',
    };
  }

  const base = Number(match[1]);
  if (!Number.isFinite(base)) {
    return { ok: false, error: 'Invalid Prompt-Tokens-Max header (not a number)' };
  }

  const value = match[2] ? base * 1000 : base;
  if (!Number.isSafeInteger(value) || value <= 0) {
    return { ok: false, error: 'Invalid Prompt-Tokens-Max header (must be a positive integer)' };
  }

  return { ok: true, value };
}

export function getTokenEncoder(model: string | null | undefined): TokenEncoder {
  const normalizedModel = typeof model === 'string' ? model.trim() : '';
  if (normalizedModel) {
    try {
      return encoding_for_model(normalizedModel);
    } catch {
      // ignore and fallback
    }
  }

  return get_encoding('cl100k_base');
}

export function countPromptTokens(
  messages: unknown,
  model: string | null | undefined,
): { ok: true; value: number } | { ok: false; error: string } {
  if (!Array.isArray(messages)) {
    return { ok: false, error: 'prompt token count requires request body field: messages (array)' };
  }

  const pieces: string[] = [];
  for (const item of messages) {
    if (!isRecord(item)) {
      continue;
    }

    const role = typeof item.role === 'string' ? item.role : '';
    const text = extractTextContent(item.content).trim();
    if (!role || !text) {
      continue;
    }

    pieces.push(`${role}\n${text}`);
  }

  const promptText = pieces.join('\n\n');
  const encoder = getTokenEncoder(model);
  try {
    const textTokens = promptText ? encoder.encode(promptText).length : 0;
    const overhead = pieces.length > 0 ? pieces.length * TOKENS_PER_MESSAGE_OVERHEAD : 0;
    const priming = pieces.length > 0 ? TOKENS_FOR_ASSISTANT_PRIMING : 0;
    return { ok: true, value: textTokens + overhead + priming };
  } catch (error) {
    const message = error instanceof Error ? error.message : 'unknown error';
    return { ok: false, error: `Failed to count prompt tokens: ${message}` };
  } finally {
    encoder.free();
  }
}
