import type { IncomingHttpHeaders, ServerResponse } from 'node:http';

import { setCorsHeaders } from './cors.js';

export function buildUpstreamHeaders(inputHeaders: IncomingHttpHeaders): Headers {
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
  headers.delete('adapter-authorization');
  headers.delete('upstream-base-url');
  headers.delete('adapter-method');
  headers.delete('safety-parameters');
  headers.delete('prompt-tokens-max');
  headers.set('accept-encoding', 'identity');

  return headers;
}

export function writeResponseHeaders(
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
