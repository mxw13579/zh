import { normalizeBaseUrl } from '../config.js';

export interface HttpBaseUrlErrorMessages {
  invalidUrl: string;
  invalidProtocol: string;
  credentialsNotAllowed: string;
  queryOrHashNotAllowed: string;
}

export const UPSTREAM_BASE_URL_ERROR_MESSAGES: HttpBaseUrlErrorMessages = {
  invalidUrl: 'Invalid UPSTREAM-BASE-URL',
  invalidProtocol: 'UPSTREAM-BASE-URL must be an http(s) URL',
  credentialsNotAllowed: 'UPSTREAM-BASE-URL must not include credentials',
  queryOrHashNotAllowed: 'UPSTREAM-BASE-URL must not include query or hash',
};

export const AUDIT_BASE_URL_ERROR_MESSAGES: HttpBaseUrlErrorMessages = {
  invalidUrl: 'audit_base_url must be a valid http(s) URL',
  invalidProtocol: 'audit_base_url must be an http(s) URL',
  credentialsNotAllowed: 'audit_base_url must not include credentials',
  queryOrHashNotAllowed: 'audit_base_url must not include query or hash',
};

export function parseHttpBaseUrlOrThrow(raw: string, messages: HttpBaseUrlErrorMessages): string {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw new Error(messages.invalidUrl);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(messages.invalidProtocol);
  }

  if (parsed.username || parsed.password) {
    throw new Error(messages.credentialsNotAllowed);
  }

  if (parsed.search || parsed.hash) {
    throw new Error(messages.queryOrHashNotAllowed);
  }

  return normalizeBaseUrl(parsed.toString());
}

export function parseHttpBaseUrl(
  raw: string,
  messages: HttpBaseUrlErrorMessages,
): { ok: true; value: string } | { ok: false; error: string } {
  try {
    return { ok: true, value: parseHttpBaseUrlOrThrow(raw, messages) };
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : messages.invalidUrl,
    };
  }
}

export function joinBaseUrlWithV1Endpoint(baseUrl: string, endpoint: string): URL {
  const base = new URL(baseUrl);
  const normalizedEndpoint = endpoint.replace(/^\/+/, '');
  const path = base.pathname.endsWith('/v1/') ? normalizedEndpoint : `v1/${normalizedEndpoint}`;
  return new URL(path, base);
}

