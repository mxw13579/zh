import type { ServerResponse } from 'node:http';

import type { RuntimeConfig } from './config.js';
import { writeResponseHeaders } from './headers.js';
import type { AdapterMethod } from './methods/types.js';
import { pipeBodyToResponse } from './stream.js';
import type { UsagePatchContext } from './usage.js';

export async function relayUpstreamResponse(
  upstreamResponse: Response,
  response: ServerResponse,
  runtime: RuntimeConfig,
  adapterMethod: AdapterMethod | null,
  usagePatch: UsagePatchContext | null = null,
): Promise<void> {
  response.statusCode = upstreamResponse.status;
  writeResponseHeaders(response, upstreamResponse.headers, runtime.allowOrigin);

  const contentType = upstreamResponse.headers.get('content-type') ?? '';

  if (!adapterMethod) {
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

    const finalStream = upstreamResponse.body.pipeThrough(
      adapterMethod.createSseTransformer(runtime.reasoningStrategy, usagePatch),
    );

    await pipeBodyToResponse(finalStream, response);
    return;
  }

  if (contentType.includes('application/json')) {
    const payloadText = await upstreamResponse.text();
    try {
      const normalizedPayload = adapterMethod.normalizePayload(
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
