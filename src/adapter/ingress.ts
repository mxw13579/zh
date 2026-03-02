import type { IncomingHttpHeaders } from 'node:http';

import { getAdapterMethod } from './methods/index.js';
import type { AdapterMethod } from './methods/types.js';

export function readRequiredUpstreamBaseUrl(headers: IncomingHttpHeaders): { ok: true; value: string } | { ok: false } {
  const upstreamBaseUrlHeader = headers['upstream-base-url'];
  if (typeof upstreamBaseUrlHeader !== 'string' || !upstreamBaseUrlHeader.trim()) {
    return { ok: false };
  }
  return { ok: true, value: upstreamBaseUrlHeader.trim() };
}

export function resolveAdapterMethod(
  headers: IncomingHttpHeaders,
): { ok: true; value: AdapterMethod | null } | { ok: false; error: string } {
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

  const adapterMethod = getAdapterMethod(methodName);
  if (!adapterMethod) {
    return { ok: false, error: 'Unknown adapter-method' };
  }

  return { ok: true, value: adapterMethod };
}
