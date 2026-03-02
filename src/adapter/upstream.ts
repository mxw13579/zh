import {
  UPSTREAM_BASE_URL_ERROR_MESSAGES,
  joinBaseUrlWithV1Endpoint,
  parseHttpBaseUrlOrThrow,
} from './utils/url.js';

export function buildChatCompletionsTargetUrl(requestUrl: string | undefined, upstreamBaseUrlHeader: string): URL {
  const parsedRequestUrl = new URL(requestUrl ?? '/', 'http://localhost');
  const upstreamBaseUrl = parseHttpBaseUrlOrThrow(upstreamBaseUrlHeader, UPSTREAM_BASE_URL_ERROR_MESSAGES);
  const targetUrl = joinBaseUrlWithV1Endpoint(upstreamBaseUrl, 'chat/completions');
  targetUrl.search = parsedRequestUrl.search;
  return targetUrl;
}
