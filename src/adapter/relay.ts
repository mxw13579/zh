import type { ServerResponse } from 'node:http';

import type { RuntimeConfig } from './config.js';
import { writeResponseHeaders } from './headers.js';
import type { ResponseTransform } from './protocols/types.js';
import { pipeBodyToResponse } from './stream.js';

export async function relayUpstreamResponse(
  upstreamResponse: Response,
  response: ServerResponse,
  runtime: RuntimeConfig,
  responseTransform: ResponseTransform<unknown> | null,
  transformContext: unknown = null,
): Promise<void> {
  response.statusCode = upstreamResponse.status;
  writeResponseHeaders(response, upstreamResponse.headers, runtime.allowOrigin);

  const contentType = upstreamResponse.headers.get('content-type') ?? '';

  if (!responseTransform) {
    if (!upstreamResponse.body) {
      response.end();
      return;
    }

    await pipeBodyToResponse(upstreamResponse.body, response);
    return;
  }

  if (contentType.includes('text/event-stream')) {
    if (!upstreamResponse.body) {
      response.end();
      return;
    }

    const finalStream = upstreamResponse.body.pipeThrough(responseTransform.createStreamTransformer(runtime, transformContext));

    await pipeBodyToResponse(finalStream, response);
    return;
  }

  if (contentType.includes('application/json')) {
    const payloadText = await upstreamResponse.text();
    try {
      const normalizedPayload = responseTransform.transformJsonResponse(JSON.parse(payloadText), runtime, transformContext);

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
