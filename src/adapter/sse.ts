import type { ReasoningStrategy } from './config.js';
import { normalizePayload } from './normalize.js';

export function createSseTransformer(
  strategy: ReasoningStrategy,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  return new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, controller) {
      buffer += decoder.decode(chunk, { stream: true });
      const split = splitEvents(buffer, false);
      buffer = split.rest;

      for (const eventBlock of split.events) {
        const normalizedEvent = normalizeSseEvent(eventBlock, strategy);
        controller.enqueue(encoder.encode(normalizedEvent));
      }
    },
    flush(controller) {
      buffer += decoder.decode();
      const split = splitEvents(buffer, true);

      for (const eventBlock of split.events) {
        const normalizedEvent = normalizeSseEvent(eventBlock, strategy);
        controller.enqueue(encoder.encode(normalizedEvent));
      }
    },
  });
}

function normalizeSseEvent(eventBlock: string, strategy: ReasoningStrategy): string {
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
      lines.push(`data: ${JSON.stringify(normalized)}`);
    } catch {
      lines.push(line);
    }
  }

  return `${lines.join('\n')}\n\n`;
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

