import type { ServerResponse } from 'node:http';

import type { RuntimeConfig } from './config.js';
import { writeResponseHeaders } from './headers.js';
import { normalizePayload } from './normalize.js';
import { createSseTransformer } from './sse.js';
import { pipeBodyToResponse } from './stream.js';

export async function relayUpstreamResponse(
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
      const normalizedPayload = normalizePayload(JSON.parse(payloadText), runtime.reasoningStrategy);

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

