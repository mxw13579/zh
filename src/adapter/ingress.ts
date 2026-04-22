import type { IncomingHttpHeaders } from 'node:http';

import type { RouteTarget } from './protocols/types.js';

export function readRequiredUpstreamBaseUrl(headers: IncomingHttpHeaders): { ok: true; value: string } | { ok: false } {
  const upstreamBaseUrlHeader = headers['upstream-base-url'];
  if (typeof upstreamBaseUrlHeader !== 'string' || !upstreamBaseUrlHeader.trim()) {
    return { ok: false };
  }
  return { ok: true, value: upstreamBaseUrlHeader.trim() };
}

export function readAdapterMethodName(
  headers: IncomingHttpHeaders,
): { ok: true; value: string | null } | { ok: false; error: string } {
  const adapterMethodHeader = headers['adapter-method'];
  if (adapterMethodHeader === undefined) {
    return { ok: true, value: null };
  }

  if (typeof adapterMethodHeader !== 'string') {
    return { ok: false, error: 'Invalid Adapter-Method header' };
  }

  const methodName = adapterMethodHeader.trim();
  if (!methodName) {
    return { ok: true, value: null };
  }

  return { ok: true, value: methodName };
}

export function resolveRouteTarget(requestUrl: string | undefined): RouteTarget {
  const parsed = new URL(requestUrl ?? '/', 'http://localhost');
  const pathname = parsed.pathname;

  if (pathname === '/v1/messages') {
    return { kind: 'claude', requestPath: pathname };
  }

  return { kind: 'openai', requestPath: pathname };
}
