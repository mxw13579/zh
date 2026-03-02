import { splitEvents } from '../../utils/sse.js';

export function createSseEventTransformer(
  transformEventBlock: (eventBlock: string) => string,
  onFinalize?: () => void,
): TransformStream<Uint8Array, Uint8Array> {
  const decoder = new TextDecoder();
  const encoder = new TextEncoder();
  let buffer = '';

  const finalize = (): void => {
    onFinalize?.();
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
        finalize();
      }
    },
    cancel() {
      finalize();
    },
  });
}

export function rewriteSseEventDataJsonLines(
  eventBlock: string,
  rewriteJsonPayload: (payload: unknown) => unknown,
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
      const parsed = JSON.parse(payload);
      const rewritten = rewriteJsonPayload(parsed);
      lines.push(`data: ${JSON.stringify(rewritten)}`);
    } catch {
      lines.push(line);
    }
  }

  return `${lines.join('\n')}\n\n`;
}
