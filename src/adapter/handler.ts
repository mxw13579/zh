import type { IncomingMessage, ServerResponse } from 'node:http';
import { Readable } from 'node:stream';

import { type RuntimeConfig, normalizeBaseUrl } from './config.js';
import { setCorsHeaders } from './cors.js';
import { buildUpstreamHeaders } from './headers.js';
import { relayUpstreamResponse } from './relay.js';
import { sendJson } from './respond.js';

type NodeRequestInit = RequestInit & { duplex?: 'half' };

export async function handleRequest(
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

  const abortController = new AbortController();
  const abortUpstream = (): void => abortController.abort();

  response.on('close', abortUpstream);
  response.on('finish', () => response.off('close', abortUpstream));

  const targetUrl = new URL(request.url ?? '/', normalizeBaseUrl(runtime.upstreamBaseUrl));
  const method = (request.method ?? 'GET').toUpperCase();

  const init: NodeRequestInit = {
    method,
    headers: buildUpstreamHeaders(request.headers),
    redirect: 'manual',
    signal: abortController.signal,
  };

  if (method !== 'GET' && method !== 'HEAD') {
    init.body = Readable.toWeb(request) as ReadableStream<Uint8Array>;
    init.duplex = 'half';
  }

  try {
    const upstreamResponse = await fetch(targetUrl, init);
    await relayUpstreamResponse(upstreamResponse, response, runtime);
  } catch (error) {
    if (abortController.signal.aborted) {
      return;
    }

    const message = error instanceof Error ? error.message : 'Unknown upstream error';
    sendJson(response, 502, {
      error: {
        message: `Upstream request failed: ${message}`,
        type: 'upstream_error',
      },
    });
  }
}

