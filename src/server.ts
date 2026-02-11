import { createServer, type IncomingHttpHeaders, type IncomingMessage, type ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

type ReasoningStrategy = 'as_reasoning_content' | 'drop' | 'as_content' | 'tagged';
type JsonRecord = Record<string, unknown>;
type NodeRequestInit = RequestInit & { duplex?: 'half' };

interface RuntimeConfig {
  allowOrigin: string;
  port: number;
  reasoningStrategy: ReasoningStrategy;
  upstreamBaseUrl: string;
}

const config = loadConfig();

const server = createServer((request, response) => {
  void handleRequest(request, response, config);
});

server.listen(config.port, () => {
  process.stdout.write(
    `[adapter] listening on :${config.port}, upstream=${config.upstreamBaseUrl}\n`,
  );
});

async function handleRequest(
  request: IncomingMessage,
  response: ServerResponse,
  runtime: RuntimeConfig,
): Promise<void> {
  setCorsHeaders(response, runtime.allowOrigin);

  if (request.method === 'OPTIONS') {
    response.writeHead(204);
    response.end();
    return;
  }

  const targetUrl = new URL(request.url ?? '/', normalizeBaseUrl(runtime.upstreamBaseUrl));
  const method = (request.method ?? 'GET').toUpperCase();

  const init: NodeRequestInit = {
    method,
    headers: buildUpstreamHeaders(request.headers),
    redirect: 'manual',
  };

  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
    init.duplex = 'half';
  }

  try {
    const upstreamResponse = await fetch(targetUrl, init);
    await relayUpstreamResponse(upstreamResponse, response, runtime);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Unknown upstream error';
    sendJson(response, 502, {
      error: {
        message: `Upstream request failed: ${message}`,
        type: 'upstream_error',
      },
    });
  }
}

async function relayUpstreamResponse(
  upstreamResponse: Response,
  response: ServerResponse,
  runtime: RuntimeConfig,
): Promise<void> {
  response.statusCode = upstreamResponse.status;
  writeResponseHeaders(response, upstreamResponse.headers, runtime.allowOrigin);

  const contentType = upstreamResponse.headers.get('content-type') ?? '';

  if (contentType.includes('text/event-stream')) {
    if (!upstreamResponse.body) {
      response.end();
      return;
    }

    const transformedStream = upstreamResponse.body.pipeThrough(
      createSseTransformer(runtime.reasoningStrategy),
    );

    await pipeBodyToResponse(transformedStream, response);
    return;
  }

  if (contentType.includes('application/json')) {
    const payloadText = await upstreamResponse.text();
    try {
      const normalizedPayload = normalizePayload(
        JSON.parse(payloadText),
        runtime.reasoningStrategy,
      );

      response.setHeader('content-type', 'application/json; charset=utf-8');
      response.end(JSON.stringify(normalizedPayload));
      return;
    } catch {
      response.end(payloadText);
      return;
    }
  }

  if (!upstreamResponse.body) {
    response.end();
    return;
  }

  await pipeBodyToResponse(upstreamResponse.body, response);
}

function loadConfig(): RuntimeConfig {
  const upstreamBaseUrl = (process.env.UPSTREAM_BASE_URL ?? '').trim();
  if (!upstreamBaseUrl) {
    throw new Error('UPSTREAM_BASE_URL is required. Example: https://xx.xx.top');
  }

  return {
    allowOrigin: (process.env.ALLOW_ORIGIN ?? '*').trim() || '*',
    port: Number(process.env.PORT ?? '8787'),
    reasoningStrategy: parseStrategy(process.env.REASONING_STRATEGY),
    upstreamBaseUrl,
  };
}

function parseStrategy(raw: string | undefined): ReasoningStrategy {
  if (raw === 'drop' || raw === 'as_content' || raw === 'tagged' || raw === 'as_reasoning_content') {
    return raw;
  }
  return 'as_reasoning_content';
}

function createSseTransformer(
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

    try {
      const normalized = normalizePayload(JSON.parse(payload), strategy);
      lines.push(`data: ${JSON.stringify(normalized)}`);
    } catch {
      lines.push(line);
    }
  }

  return `${lines.join('\n')}\n\n`;
}

function normalizePayload(payload: unknown, strategy: ReasoningStrategy): unknown {
  if (!isRecord(payload) || !Array.isArray(payload.choices)) {
    return payload;
  }

  const choices = payload.choices
    .map((choice, index) => normalizeChoice(choice, index, strategy))
    .filter((choice): choice is JsonRecord => choice !== null);

  return {
    id: typeof payload.id === 'string' ? payload.id : `chatcmpl-${crypto.randomUUID()}`,
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
  const reasoning = extractReasoning(delta);

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
  pushUnique(parts, textOf(delta.reasoning_content));

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

function splitEvents(source: string, flush: boolean): { events: string[]; rest: string } {
  const normalized = source.replace(/\r\n/g, '\n');
  const parts = normalized.split('\n\n');

  if (!flush) {
    const rest = parts.pop() ?? '';
    return { events: parts.filter(Boolean), rest };
  }

  return { events: parts.filter(Boolean), rest: '' };
}

function buildUpstreamHeaders(inputHeaders: IncomingHttpHeaders): Headers {
  const headers = new Headers();

  for (const [key, value] of Object.entries(inputHeaders)) {
    if (value === undefined) {
      continue;
    }

    if (Array.isArray(value)) {
      for (const item of value) {
        headers.append(key, item);
      }
      continue;
    }

    headers.set(key, value);
  }

  headers.delete('host');
  headers.delete('content-length');
  headers.delete('connection');
  headers.delete('transfer-encoding');
  headers.set('accept-encoding', 'identity');

  return headers;
}

function writeResponseHeaders(
  response: ServerResponse,
  upstreamHeaders: Headers,
  allowOrigin: string,
): void {
  response.removeHeader('content-length');

  for (const [key, value] of upstreamHeaders.entries()) {
    const lowerKey = key.toLowerCase();
    if (lowerKey === 'content-length' || lowerKey === 'set-cookie') {
      continue;
    }
    response.setHeader(key, value);
  }

  const setCookie = (upstreamHeaders as Headers & { getSetCookie?: () => string[] }).getSetCookie?.();
  if (Array.isArray(setCookie) && setCookie.length > 0) {
    response.setHeader('set-cookie', setCookie);
  }

  setCorsHeaders(response, allowOrigin);
}

function setCorsHeaders(response: ServerResponse, allowOrigin: string): void {
  response.setHeader('access-control-allow-origin', allowOrigin);
  response.setHeader('access-control-allow-methods', 'GET,POST,PUT,PATCH,DELETE,OPTIONS');
  response.setHeader('access-control-allow-headers', 'Authorization,Content-Type');
}

function pipeBodyToResponse(
  body: ReadableStream<Uint8Array>,
  response: ServerResponse,
): Promise<void> {
  return new Promise((resolve, reject) => {
    const stream = Readable.fromWeb(body as unknown as ReadableStream);

    const done = (): void => {
      response.off('close', done);
      response.off('finish', done);
      resolve();
    };

    stream.on('error', reject);
    response.on('close', done);
    response.on('finish', done);
    stream.pipe(response);
  });
}

function sendJson(response: ServerResponse, statusCode: number, payload: unknown): void {
  response.statusCode = statusCode;
  response.setHeader('content-type', 'application/json; charset=utf-8');
  response.end(JSON.stringify(payload));
}

function normalizeBaseUrl(baseUrl: string): string {
  return baseUrl.endsWith('/') ? baseUrl : `${baseUrl}/`;
}

function pushUnique(target: string[], value: string): void {
  if (value && !target.includes(value)) {
    target.push(value);
  }
}

function textOf(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

function isRecord(value: unknown): value is JsonRecord {
  return typeof value === 'object' && value !== null;
}
